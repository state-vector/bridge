/** Local execution is a human-authorised mode, never an autonomous queue tier.
 * The SQLite transaction owns state + claim + wait + grant consumption. */
import { CheckpointSchema, ExecutionStateSchema, ExecutionRequirementsSchema, ExecutorCapabilitiesSchema, HandoffAcceptSchema, HandoffControlSchema, HandoffReadSchema, LocalGrantSchema,
  initialExecution, projectExecutionBlockers, continuationPrompt, type ExecutionState, type ExecutionBlocker, type LocalGrant, type CapabilityObservation } from "@bridge/contracts";

interface TaskRow { id: string; title: string; project: string; status: string; owner: string; meta: string; updated_ts: number }
interface Credential { id: string; label: string; principal: string | null; tags: string; revoked_ts: number | null }
interface TaskMeta { execution_requirements?: unknown; execution_wait?: { kind: "capability" }; blocked?: unknown; session?: string; [key: string]: unknown }
export function isExecutionWait(meta: TaskMeta): boolean {
  const b = meta.blocked as { await_event?: { event?: string } } | undefined;
  return b?.await_event?.event === "local_handoff" || b?.await_event?.event === "executor_capability";
}
export function interactiveCredential(token: Credential | null): boolean {
  if (!token || token.revoked_ts) return false;
  const tags: string[] = JSON.parse(token.tags || "[]");
  return !tags.map(t => t.toLowerCase()).some(t => t === "gateway" || t === "provisioned" || t.startsWith("by:") || t.startsWith("cadence:"));
}

export class ExecutionWork {
  constructor(private storage: DurableObjectStorage, private audit: (actor: string, op: string, id: string, data: object) => void, private workspace = "state-vector") {}
  private get sql() { return this.storage.sql; }
  private one<T>(query: string, ...args: (string | number | null)[]): T | null { return (this.sql.exec(query, ...args).toArray()[0] as unknown as T) ?? null; }
  private task(id: string): TaskRow {
    const task = this.one<TaskRow>(`SELECT id,title,project,status,owner,meta,updated_ts FROM artefacts WHERE id=? AND type='task'`, id);
    if (!task) throw new Error("gate: no such task");
    return task;
  }
  state(task: TaskRow): ExecutionState {
    const row = this.one<{ state: string }>(`SELECT state FROM execution_state WHERE task_id=?`, task.id);
    const meta: TaskMeta = JSON.parse(task.meta || "{}");
    const state = row ? ExecutionStateSchema.parse(JSON.parse(row.state)) : initialExecution();
    state.requirements = ExecutionRequirementsSchema.parse(meta.execution_requirements ?? state.requirements);
    return state;
  }
  private save(id: string, state: ExecutionState) { this.sql.exec(`UPDATE execution_state SET state=? WHERE task_id=?`, JSON.stringify(ExecutionStateSchema.parse(state)), id); }
  private credential(tokenId: string): Credential | null { return this.one<Credential>(`SELECT id,label,principal,tags,revoked_ts FROM auth_tokens WHERE id=?`, tokenId); }
  private hosts(): CapabilityObservation[] {
    return this.sql.exec(`SELECT t.label,h.capabilities,h.observed_ts FROM execution_hosts h JOIN auth_tokens t ON t.id=h.token_id WHERE t.revoked_ts IS NULL`).toArray().map(row => ({
      host: String(row.label), capabilities: ExecutorCapabilitiesSchema.parse(JSON.parse(String(row.capabilities))), observed_at: Number(row.observed_ts),
      active: Number(this.one<{ n: number }>(`SELECT count(*) AS n FROM execution_state WHERE json_extract(state,'$.attempt.host')=? AND json_extract(state,'$.attempt.phase') IN ('running','restoring') AND json_extract(state,'$.attempt.lease_until')>?`, String(row.label), Date.now())?.n ?? 0),
    }));
  }
  availability(id: string) {
    const task = this.task(id); const blockers = this.blockers(task, Date.now());
    const capability = blockers.find(b => b.kind === "capability_unavailable");
    return { requirements: this.state(task).requirements, blockers, phase: capability?.kind === "capability_unavailable" ? capability.reason
      : blockers.some(b => b.kind === "capacity_wait") ? "capacity_wait" : "ready", hosts: this.hosts() };
  }
  private asks(id: string) {
    return this.sql.exec(`SELECT q.id,q.title FROM relations r JOIN artefacts q ON q.id=r.src_id WHERE r.dst_id=? AND r.relation='child_of' AND q.type='question' AND q.status NOT IN ('done','superseded') AND json_extract(q.meta,'$.ask.route.kind')='human_decision'`, id).toArray().map(q => ({ id: String(q.id), question: String(q.title) }));
  }
  private grant(task: TaskRow, tokenId: string, session: string, now: number): LocalGrant | null {
    const row = this.one<{ grant: string }>(`SELECT grant FROM local_execution_grants WHERE task_id=? AND token_id=? AND session=? ORDER BY rowid DESC LIMIT 1`, task.id, tokenId, session);
    if (!row) return null;
    const grant = LocalGrantSchema.parse(JSON.parse(row.grant));
    const h = this.state(task).handoff;
    return h.phase !== "none" && grant.handoff_id === h.id && grant.version === h.version && grant.expires_at > now ? grant : null;
  }
  blockers(task: TaskRow, now: number, grant: LocalGrant | null = null): ExecutionBlocker[] {
    const state = this.state(task);
    const local = grant ? { host: grant.host, capabilities: grant.capabilities }
      : state.handoff.phase === "accepted" ? { host: state.handoff.host, capabilities: state.handoff.capabilities } : undefined;
    return projectExecutionBlockers({ id: task.id, project: task.project, requirements: state.requirements, handoff: state.handoff, hosts: this.hosts(), asks: this.asks(task.id), now, local });
  }
  /** Reads compute fresh availability without persisting, claiming or granting. */
  read(raw: unknown, tokenId = "", session = "", human = false, attention = false) {
    const request = HandoffReadSchema.parse(raw);
    const token = this.credential(tokenId);
    const rows = this.sql.exec(`SELECT id,title,project,status,owner,meta,updated_ts FROM artefacts WHERE type='task' AND status NOT IN ('done','superseded') AND id>? ORDER BY id LIMIT 2000`, request.cursor ?? "").toArray() as unknown as TaskRow[];
    const items = [];
    const limit = request.limit ?? 50;
    let next: string | null = null;
    for (const task of rows) {
      if (request.project && task.project !== request.project) continue;
      const state = this.state(task); const h = state.handoff;
      if (!attention && (h.phase === "none" || h.phase === "returned")) continue;
      if (h.phase !== "none" && request.recipient && h.recipient !== request.recipient) continue;
      if (!human && h.phase !== "none" && h.recipient && h.recipient !== token?.label && h.recipient !== token?.principal) continue;
      const grant = token && session ? this.grant(task, tokenId, session, Date.now()) : null;
      const blockers = this.blockers(task, Date.now(), grant);
      const required = blockers.filter(b => b.kind !== "local_pickup_required" && b.kind !== "capacity_wait");
      const prerequisites = [...(!interactiveCredential(token) ? ["interactive_credential" as const] : []), ...(!grant ? ["human_authorization" as const] : []),
        ...(h.phase !== "waiting" ? ["handoff_not_ready" as const] : []), ...required.map(b => b.kind)];
      const meta: TaskMeta = JSON.parse(task.meta || "{}");
      if (attention && h.phase === "none" && (!meta.execution_requirements || !blockers.length)) continue;
      if (items.length >= limit) { next = items.at(-1)?.id ?? null; break; }
      const url = `https://hub.fleetbridge.run/card/${task.id.replace("#", "-")}`;
      items.push({ id: task.id, title: task.title, project: task.project, status: task.status, url, handoff: h, requirements: state.requirements, blockers,
        continuation_prompt: h.phase !== "none" && h.phase !== "returned" ? continuationPrompt({ ...task, url }, h, state.requirements) : null,
        can_accept: prerequisites.length === 0, prerequisites, accept_operation: "handoff_accept" });
    }
    const agents = human ? this.sql.exec(`SELECT id,label,principal,tags,revoked_ts FROM auth_tokens WHERE revoked_ts IS NULL`).toArray()
      .map(row => row as unknown as Credential).filter(interactiveCredential).map(t => ({ label: t.label })) : [];
    return { workspace: this.workspace, items, next_cursor: next, interactive_agents: agents };
  }
  control(raw: unknown, actor: string) {
    if (!actor.startsWith("web:")) throw new Error("gate: local authorisation/return is human-web-only");
    const cmd = HandoffControlSchema.parse(raw); const task = this.task(cmd.id); const state = this.state(task); const h = state.handoff;
    if (["done", "superseded"].includes(task.status)) return { kind: "unmet_prerequisites" as const, prerequisites: ["task_closed"] };
    if (cmd.kind === "request_local") {
      if (h.phase !== "none" && h.phase !== "returned") return { kind: "already_requested" as const };
      this.fromHumanDecision(task.id, cmd.action, cmd.reason, actor);
      return { kind: "requested" as const };
    }
    if (h.phase === "none" || h.id !== cmd.handoff_id || h.version !== cmd.version) return { kind: "stale_episode" as const };
    if (cmd.kind === "confirm_preparation") {
      if (h.phase !== "preparing" || (state.attempt && state.attempt.phase !== "quiesced")) return { kind: "unmet_prerequisites" as const, prerequisites: ["originating_runner_quiescence_required"] };
      if (cmd.checkpoint.tests.some(t => t.tree !== cmd.checkpoint.tree)) return { kind: "unmet_prerequisites" as const, prerequisites: ["checkpoint_evidence_content_mismatch"] };
      state.handoff = { ...h, phase: "waiting", checkpoint: cmd.checkpoint, version: h.version + 1, quiescence: { kind: "human_attested", by: actor, evidence: cmd.evidence } };
      const meta: TaskMeta = JSON.parse(task.meta || "{}");
      meta.execution_requirements = state.requirements;
      meta.blocked = { reason: `Pick up locally: ${h.action}`, ts: Date.now(), unblock_condition: "Explicit authorised local acceptance", await_event: { event: "local_handoff", handoff_id: h.id, version: h.version + 1 } };
      this.storage.transactionSync(() => { this.save(task.id, state); this.sql.exec(`UPDATE artefacts SET status='blocked',owner='',meta=?,updated_ts=? WHERE id=?`, JSON.stringify(meta), Date.now(), task.id); });
      this.audit(actor, "local_preparation_attested", task.id, { handoff: h.id, evidence: cmd.evidence, checkpoint: cmd.checkpoint.commit });
      return { kind: "preparation_confirmed" as const };
    }
    if (cmd.kind === "authorize") {
      if (h.phase !== "waiting") return { kind: "unmet_prerequisites" as const, prerequisites: ["handoff_not_waiting"] };
      const token = this.one<Credential>(`SELECT id,label,principal,tags,revoked_ts FROM auth_tokens WHERE label=?`, cmd.label);
      if (!interactiveCredential(token)) return { kind: "unauthorized" as const };
      if (h.recipient && h.recipient !== token!.label && h.recipient !== token!.principal) return { kind: "unauthorized" as const };
      if (/^(dispatch-|bridge-task-)/.test(cmd.session)) throw new Error("gate: local acceptance requires a separately named interactive session");
      const grant: LocalGrant = { id: crypto.randomUUID(), task_id: task.id, handoff_id: h.id, version: h.version,
        token_id: token!.id, session: cmd.session, host: cmd.host, by: actor, source: "human_attested", evidence: cmd.evidence, capabilities: cmd.capabilities, expires_at: Date.now() + 15 * 60_000 };
      const blockers = this.blockers(task, Date.now(), grant).filter(b => b.kind !== "local_pickup_required" && b.kind !== "capacity_wait");
      if (blockers.length) return { kind: "unmet_prerequisites" as const, prerequisites: blockers };
      this.sql.exec(`INSERT INTO local_execution_grants (id,task_id,token_id,session,grant) VALUES (?,?,?,?,?)`, grant.id, task.id, token!.id, cmd.session, JSON.stringify(grant));
      this.audit(actor, "local_execution_authorized", task.id, { handoff: h.id, version: h.version, label: cmd.label, session: cmd.session, source: grant.source });
      return { kind: "authorized" as const, grant_id: grant.id, expires_at: grant.expires_at };
    }
    if (h.phase !== "accepted") return { kind: "unmet_prerequisites" as const, prerequisites: ["local_execution_not_accepted"] };
    if (state.operations.some(o => o.state === "prepared" || o.state === "outcome_unknown")) return { kind: "unmet_prerequisites" as const, prerequisites: ["unknown_external_operations"] };
    const meta: TaskMeta = JSON.parse(task.meta || "{}");
    state.handoff = { ...h, phase: "returned", returned_at: Date.now(), by: actor, quiescence: { kind: "human_attested", by: actor, evidence: `Explicit stopped-writer return for ${h.id} version ${h.version}` } };
    if (state.attempt?.phase === "quiesced") state.attempt.checkpoint = h.checkpoint;
    state.revision += 1;
    this.storage.transactionSync(() => {
      this.save(task.id, state); delete meta.session; delete meta.blocked; delete meta.execution_wait; delete meta.local_execution;
      const asks = this.asks(task.id);
      if (asks.length) meta.blocked = { reason: asks[0].question, unblock_condition: `Answer ${asks[0].id}`, ts: Date.now(), await_event: { event: "ask", ask_id: asks[0].id } };
      this.sql.exec(`UPDATE artefacts SET status=?,owner='',meta=?,status_ts=?,updated_ts=? WHERE id=?`, asks.length ? "blocked" : "todo", JSON.stringify(meta), Date.now(), Date.now(), task.id);
    });
    this.audit(actor, "local_execution_returned", task.id, { handoff: h.id, writers: cmd.writers, checkpoint: h.checkpoint.commit });
    this.sweep(); // capability/human blockers remain independent of this return
    return { kind: "returned_autonomous" as const };
  }
  accept(raw: unknown, tokenId: string) {
    const cmd = HandoffAcceptSchema.parse(raw); const token = this.credential(tokenId);
    if (!interactiveCredential(token)) return { kind: "unauthorized" as const };
    const task = this.task(cmd.id); const state = this.state(task); const h = state.handoff;
    if (h.phase === "none" || h.id !== cmd.handoff_id) return { kind: "stale_episode" as const };
    if (h.phase === "accepted" && h.token_id === tokenId && h.session === cmd.session && cmd.version <= h.version) return { kind: "already_accepted" as const, task_id: task.id, session: h.session };
    if (h.version !== cmd.version || h.phase !== "waiting") return { kind: "stale_episode" as const };
    if (h.recipient && h.recipient !== token!.label && h.recipient !== token!.principal) return { kind: "unauthorized" as const };
    const grant = this.grant(task, tokenId, cmd.session, Date.now());
    if (!grant) return { kind: "unauthorized" as const, reason: "A matching human-authorised credential/session capability grant is required" };
    const blockers = this.blockers(task, Date.now(), grant).filter(b => b.kind !== "local_pickup_required" && b.kind !== "capacity_wait");
    const writerReady = state.attempt?.phase === "quiesced" || (!state.attempt && h.quiescence.kind === "human_attested");
    if (blockers.length || !writerReady) return { kind: "unmet_prerequisites" as const, prerequisites: blockers.length ? blockers : ["writer_quiescence_required"] };
    state.handoff = { ...h, phase: "accepted", token_id: tokenId, session: cmd.session, host: grant.host, accepted_at: Date.now(), grant_id: grant.id, capabilities: grant.capabilities };
    state.revision += 1;
    const meta: TaskMeta = JSON.parse(task.meta || "{}"); delete meta.blocked; delete meta.execution_wait; delete meta.awaiting_ask;
    meta.session = cmd.session;
    meta.local_execution = { handoff_id: h.id, session: cmd.session };
    this.storage.transactionSync(() => {
      this.save(task.id, state);
      this.sql.exec(`UPDATE artefacts SET status='in_progress',owner=?,meta=?,status_ts=?,updated_ts=? WHERE id=?`, token!.principal ?? token!.label, JSON.stringify(meta), Date.now(), Date.now(), task.id);
    });
    this.audit(token!.label, "local_execution_accepted", task.id, { handoff: h.id, version: h.version, session: cmd.session, grant: grant.id });
    return { kind: "accepted" as const, task_id: task.id, session: cmd.session, checkpoint: h.checkpoint };
  }
  checkpoint(raw: { id: string; handoff_id: string; version: number; session: string; checkpoint: unknown }, tokenId: string) {
    const task = this.task(raw.id); const state = this.state(task); const h = state.handoff;
    if (h.phase !== "accepted" || h.id !== raw.handoff_id || h.version !== raw.version || h.token_id !== tokenId || h.session !== raw.session) throw new Error("gate: local checkpoint requires the winning handoff/session");
    const checkpoint = CheckpointSchema.parse(raw.checkpoint);
    if (checkpoint.tests.some(t => t.tree !== checkpoint.tree)) throw new Error("gate: checkpoint evidence does not cover content");
    state.handoff = { ...h, version: h.version + 1, checkpoint }; state.revision += 1; this.save(task.id, state);
    this.audit(this.credential(tokenId)!.label, "local_checkpoint", task.id, { handoff: h.id, commit: checkpoint.commit });
    return { kind: "checkpoint_recorded", version: state.handoff.version };
  }
  fromHumanDecision(id: string, question: string, reason: string, actor: string) {
    const task = this.task(id); const state = this.state(task);
    if (state.handoff.phase !== "none" && state.handoff.phase !== "returned") return;
    const details = { id: `local:decision:${crypto.randomUUID()}`, version: 1, requested_at: Date.now(), reason, action: question,
      findings: "See the task and answered decision for the executor's findings.", tried: "Consult the executor's recorded history; no additional attempts are claimed.", next: "Read the continuation and explicitly accept this handoff after human authorisation.",
      evidence: [`https://hub.fleetbridge.run/card/${id.replace("#", "-")}`], approvals: [`Human selected local handoff (${actor})`], recipient: null, quiescence: { kind: "pending" as const } };
    state.handoff = state.attempt?.phase === "quiesced" && state.attempt.checkpoint
      ? { ...details, phase: "waiting", checkpoint: state.attempt.checkpoint, quiescence: { kind: "runner", host: state.attempt.host, generation: state.attempt.generation } } : { ...details, phase: "preparing" };
    if (state.attempt && state.attempt.phase !== "quiesced") state.attempt.phase = "stopping";
    const meta: TaskMeta = JSON.parse(task.meta || "{}"); delete meta.awaiting_ask;
    meta.execution_requirements = state.requirements;
    meta.blocked = { reason: `Pick up locally: ${question}`, ts: Date.now(), unblock_condition: "Only explicit authorised local acceptance resolves this handoff; old-writer checkpoint/quiescence must complete first",
      await_event: { event: "local_handoff", handoff_id: details.id, version: 1 } };
    this.storage.transactionSync(() => {
      this.sql.exec(`INSERT INTO execution_state (task_id,state,worker_token_id) VALUES (?,?,'') ON CONFLICT(task_id) DO UPDATE SET state=excluded.state`, id, JSON.stringify(state));
      this.sql.exec(`UPDATE artefacts SET status='blocked',owner=CASE WHEN ?='waiting' THEN '' ELSE owner END,meta=?,updated_ts=? WHERE id=?`, state.handoff.phase, JSON.stringify(meta), Date.now(), id);
    });
    this.audit(actor, "local_handoff_decision", id, { handoff: details.id, phase: state.handoff.phase });
  }
  resumeAfterAnswer(id: string) {
    const task = this.task(id); const state = this.state(task);
    if (task.status !== "blocked" || !["accepted", "returned"].includes(state.handoff.phase) || this.asks(id).length) return;
    if (state.handoff.phase === "returned") {
      const meta: TaskMeta = JSON.parse(task.meta || "{}"); delete meta.blocked;
      this.sql.exec(`UPDATE artefacts SET status='todo',owner='',meta=?,status_ts=?,updated_ts=? WHERE id=?`, JSON.stringify(meta), Date.now(), Date.now(), id);
      this.sweep(); return;
    }
    if (this.blockers(task, Date.now()).some(b => b.kind === "capability_unavailable")) return;
    const meta: TaskMeta = JSON.parse(task.meta || "{}"); delete meta.blocked;
    this.sql.exec(`UPDATE artefacts SET status='in_progress',meta=?,status_ts=?,updated_ts=? WHERE id=?`, JSON.stringify(meta), Date.now(), Date.now(), id);
    this.audit("system:local-answer", "local_execution_resumed", id, { session: state.handoff.phase === "accepted" ? state.handoff.session : "" });
  }
  /** Expiry is level-triggered. Only queued capability waits resume; never
   * interfere with a healthy active writer or clear a human/local dependency. */
  sweep(now = Date.now()) {
    const rows = this.sql.exec(`SELECT id,title,project,status,owner,meta,updated_ts FROM artefacts WHERE type='task' AND status IN ('todo','blocked') AND json_extract(meta,'$.execution_requirements') IS NOT NULL LIMIT 2000`).toArray() as unknown as TaskRow[];
    for (const task of rows) {
      const state = this.state(task); const meta: TaskMeta = JSON.parse(task.meta || "{}"); const blockers = this.blockers(task, now);
      const unavailable = blockers.find(b => b.kind === "capability_unavailable");
      const prior = JSON.stringify(meta.execution_blockers ?? []); meta.execution_blockers = blockers;
      let status = task.status;
      if (status === "todo" && unavailable) {
        status = "blocked"; meta.execution_wait = { kind: "capability" };
        meta.blocked = { reason: unavailable.text, unblock_condition: "A live eligible executor capability becomes usable; all other blockers must also clear", ts: Date.now(), await_event: { event: "executor_capability", id: task.id } };
      } else if (status === "blocked" && (meta.blocked as { await_event?: { event?: string } })?.await_event?.event === "executor_capability" && !unavailable && !blockers.some(b => b.kind === "human_answer_required" || b.kind === "local_pickup_required" || b.kind === "writer_quiescence_required")) {
        status = "todo"; delete meta.blocked; delete meta.execution_wait;
      }
      if (prior === JSON.stringify(blockers) && status === task.status) continue;
      this.sql.exec(`UPDATE artefacts SET status=?,meta=?,updated_ts=?,status_ts=CASE WHEN status!=? THEN ? ELSE status_ts END WHERE id=?`, status, JSON.stringify(meta), Date.now(), status, Date.now(), task.id);
      // Stable per task/requirements episode; flapping updates the same card,
      // never manufactures an approval ask or an unblock-child storm.
      this.audit("system:capabilities", "execution_blockers_changed", task.id, { blockers: blockers.map(b => ({ kind: b.kind, episode: b.episode_id })), status });
    }
  }
}
