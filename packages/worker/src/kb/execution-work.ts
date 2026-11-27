/** Local execution is a human-authorised mode, never an autonomous queue tier.
 * The SQLite transaction owns state + claim + wait + grant consumption. */
import { CheckpointSchema, ExecutionStateSchema, ExecutionRequirementsSchema, ExecutorCapabilitiesSchema, HandoffAcceptSchema, HandoffControlSchema, HandoffReadSchema, LocalGrantSchema, InteractiveClaimSchema,
  initialExecution, openLargerModelStrategy, capabilityBlockers, usableFor, projectExecutionBlockers, continuationPrompt, selectModelTier, maxTier, DEFAULT_MODEL_POLICY,
  availableModelTiers, nextAvailableTier, isExecutorAvailabilityBlocker,
  type ModelPolicy, type ExecutionRequirements, type ExecutionState, type ExecutionBlocker, type LocalGrant, type CapabilityObservation, type ExecutorCapabilities, type ExecutorReadiness } from "@bridge/contracts";
import { StartupWaitSchema, startupWaitReason, startupPrerequisiteFingerprint } from "@bridge/contracts";
import { gatewayOccupancy } from "./scheduling.ts";
import { ExecutionModelIdentitySchema, type ExecutionHistoryEvent } from "@bridge/contracts";

interface TaskRow { id: string; title: string; project: string; status: string; owner: string; meta: string; updated_ts: number }
interface Credential { id: string; label: string; principal: string | null; tags: string; revoked_ts: number | null }
interface TaskMeta { execution_requirements?: unknown; execution_wait?: { kind: "capability" } | { kind: "external_checks" }; blocked?: unknown; session?: string; [key: string]: unknown }
interface HostInventory { tokenId: string; host: string; capabilities: ExecutorCapabilities; observed_at: number;
  active: number; occupancy?: ReturnType<typeof gatewayOccupancy>["occupancy"] }
/** BR#14761: already-fetched artefact columns a page holds in hand. Passing
 *  them down keeps tier selection on hostsBare and avoids reloading the
 *  artefact when testing task-specific startup fences — the same BR#14767 dispatch-sweep pattern,
 *  now shared by the alarm page and the scheduler's bounded reopen pass. */
interface TaskColumns { roles: string; body_md: string; project: string; meta: string }
/** BR#14761 — the reserve path no longer pays a 25-card maintenance page.
 *  Its scheduling-relevant sweep duty is bounded here: reopen blocked
 *  capability waits the live fleet can serve, paged by a durable fair
 *  cursor. `idx_artefact_capability_waits` (guarded in ensureSchema) serves
 *  exactly this predicate, so the seek stays bounded by matching rows —
 *  never by the retained board span. */
export const CAPABILITY_WAIT_REOPEN_PAGE = 25;
export const CAPABILITY_WAIT_REOPEN_CURSOR_KEY = "execution_reopen_cursor";
export const CAPABILITY_WAIT_REOPEN_SQL = `SELECT rowid AS sweep_cursor,id,title,body_md,project,roles,status,owner,meta,updated_ts FROM artefacts WHERE rowid>? AND type='task' AND status='blocked' AND owner='' AND json_extract(meta,'$.blocked.await_event.event')='executor_capability' AND (json_extract(meta,'$.execution_wait.kind')='capability' OR json_extract(meta,'$.execution_wait') IS NULL) AND (json_extract(meta,'$.execution_requirements') IS NOT NULL OR EXISTS (SELECT 1 FROM execution_hosts)) ORDER BY rowid LIMIT ${CAPABILITY_WAIT_REOPEN_PAGE}`;
/** BR#23279 — the key moved from execution_wait.kind (present in only ONE
 *  of the two historical park shapes) to the typed executor_capability
 *  await_event — the invariant EVERY drainable capability park carries. The
 *  partial WHERE pins exactly the reopen predicate's mandatory terms; the
 *  two-shape disjunction and the requirements clause stay residual filters
 *  over the narrow index set. The old kind-keyed index could not serve the
 *  widened query: its partial WHERE was no longer implied by the query's,
 *  so the planner fell back to the full retained-board scan (measured
 *  12,225 rows on the query rig). ensureSchema replaces the old index once
 *  where the stored SQL predates this key (the lane_cards BR#16935
 *  recovery pattern). */
export const CAPABILITY_WAIT_INDEX_SCHEMA = `CREATE INDEX IF NOT EXISTS idx_artefact_capability_waits ON artefacts(json_extract(meta,'$.blocked.await_event.event')) WHERE type='task' AND status='blocked' AND owner='' AND json_extract(meta,'$.blocked.await_event.event')='executor_capability'`;
export const CAPABILITY_SWEEP_SCHEMA = `
  CREATE INDEX IF NOT EXISTS idx_capability_sweep_open ON artefacts(type)
    WHERE type='task' AND status IN ('todo','blocked');
  CREATE INDEX IF NOT EXISTS idx_executor_start_claim_token ON executor_start_claims(token_id);
`;
export const CAPABILITY_SWEEP_SQL = `SELECT rowid AS sweep_cursor,id,title,body_md,project,roles,status,owner,meta,updated_ts
  FROM artefacts INDEXED BY idx_capability_sweep_open WHERE type='task' AND status IN ('todo','blocked') AND rowid>?
    AND (json_extract(meta,'$.execution_requirements') IS NOT NULL OR EXISTS (SELECT 1 FROM execution_hosts))
  ORDER BY rowid LIMIT 25`;
export function isExecutionWait(meta: TaskMeta): boolean {
  const b = meta.blocked as { await_event?: { event?: string } } | undefined;
  if (b?.await_event?.event === "local_handoff" || b?.await_event?.event === "executor_capability") return true;
  // BR#18328 — a todo card parked on the durable external-CI wait holds the
  // scheduler the same way (independent_wait): the wake evaluator, not the
  // reserve loop, releases it, so no slot is burned polling CI.
  return meta.execution_wait?.kind === "external_checks";
}
export function interactiveCredential(token: Credential | null): boolean {
  if (!token || token.revoked_ts) return false;
  const tags: string[] = JSON.parse(token.tags || "[]");
  return !tags.map(t => t.toLowerCase()).some(t => t === "gateway" || t === "provisioned" || t.startsWith("by:") || t.startsWith("cadence:"));
}
export function ownsInteractiveClaim(meta: TaskMeta, tokenId: string, session: string): boolean {
  const claim = InteractiveClaimSchema.safeParse(meta.interactive_execution);
  return claim.success && claim.data.token_id === tokenId && claim.data.session === session && meta.session === session;
}

export class ExecutionWork {
  private hostSnapshot: (() => HostInventory[]) | null = null;
  private readinessSnapshot: Map<string, ExecutorReadiness> | null = null;
  private policySnapshot: ModelPolicy | null = null;
  constructor(private storage: DurableObjectStorage, private audit: (actor: string, op: string, id: string, data: object) => void, private workspace: string,
    private readiness: (token: string, host: string, capabilities: ExecutorCapabilities, now: number) => ExecutorReadiness,
    private modelPolicy: () => ModelPolicy = () => DEFAULT_MODEL_POLICY,
    private record: (id: string, actor: string, event: ExecutionHistoryEvent) => void = () => {}) {}
  private get sql() { return this.storage.sql; }
  private one<T>(query: string, ...args: (string | number | null)[]): T | null { return (this.sql.exec(query, ...args).toArray()[0] as unknown as T) ?? null; }
  private task(id: string): TaskRow {
    const task = this.one<TaskRow>(`SELECT id,title,project,status,owner,meta,updated_ts FROM artefacts WHERE id=? AND type='task'`, id);
    if (!task) throw new Error("gate: no such task");
    return task;
  }
  state(task: TaskRow, columns?: TaskColumns): ExecutionState {
    const row = this.one<{ state: string }>(`SELECT state FROM execution_state WHERE task_id=?`, task.id);
    const meta: TaskMeta = JSON.parse(task.meta || "{}");
    const state = row ? ExecutionStateSchema.parse(JSON.parse(row.state)) : initialExecution();
    state.requirements = ExecutionRequirementsSchema.parse(meta.execution_requirements ?? state.requirements);
    state.requirements = this.schedulingRequirements(task.id, state.requirements, state, columns);
    return state;
  }
  /** Preferences resolve globally; actual execution and explicit minima never downgrade. */
  /** BR#14767: `row` accepts the caller's already-fetched artefact columns
   *  (roles/project/meta) — the dispatch sweep has them in hand; the
   *  per-row re-SELECT was one of the ~2000-statement sweep costs. Tier
   *  selection uses hostsBare (host-level readiness): availableModelTiers
   *  filters on readiness.kind === "ready", which host readiness answers —
   *  task-specific startup rejection is layered by the sweep loop itself. */
  schedulingRequirements(id: string, required: ExecutionRequirements, state?: ExecutionState,
    row?: { roles: string; project: string; meta: string }): ExecutionRequirements {
    const r = row ?? this.one<{ roles: string; project: string; meta: string }>(`SELECT roles,project,meta FROM artefacts WHERE id=?`, id);
    if (!r) return required;
    const roles: string[] = JSON.parse(r.roles || "[]");
    const meta: TaskMeta = JSON.parse(r.meta || "{}");
    const lane = roles.includes("analysis") ? "analysis" : roles.includes("review") ? "verify" : "impl";
    let floor = required.tier;
    if (lane === "verify") {
      const parents = this.sql.exec(`SELECT e.state FROM execution_state e JOIN relations r ON r.dst_id=e.task_id WHERE r.src_id=? AND r.relation='child_of'`, id).toArray();
      const subject = typeof meta.execution_review_of === "string" ? this.one<{ state: string }>(`SELECT state FROM execution_state WHERE task_id=?`, meta.execution_review_of) : null;
      for (const parent of [...parents, ...(subject ? [subject] : [])]) {
        const execution = ExecutionStateSchema.parse(JSON.parse(String(parent.state)));
        floor = maxTier(floor, execution.delivery?.tier ?? (execution.handoff.phase === "accepted" ? execution.handoff.capabilities.tier : execution.attempt?.executor?.tier) ?? execution.requirements.tier);
      }
    }
    floor = maxTier(floor, state?.attempt?.executor?.tier ?? "small");
    floor = maxTier(floor, state?.retry_strategy?.minimum_tier ?? "small");
    if (state?.attempt) return { ...required, tier: floor };
    const selection = selectModelTier({ lane, policy: this.policySnapshot ?? this.modelPolicy(), required: { ...required, tier: floor }, hosts: row ? this.hostsBare() : this.hosts(id, false), project: r.project, now: Date.now() });
    return { ...required, tier: selection.kind === "selected" ? selection.tier : selection.minimum };
  }
  private save(id: string, state: ExecutionState) { this.sql.exec(`UPDATE execution_state SET state=? WHERE task_id=?`, JSON.stringify(ExecutionStateSchema.parse(state)), id); }
  strongerImplementation(id: string, summary: string, actor: string, apply = true, reviewId: string | null = null) {
    const task = this.task(id); const state = this.state(task);
    if (!["in_review", "in_progress"].includes(task.status) || (state.attempt && state.attempt.phase !== "quiesced") || !["none", "returned"].includes(state.handoff.phase)) throw new Error("gate: stronger implementation verdict requires an idle delivered parent, not a live writer or local handoff");
    const current = state.delivery?.tier ?? state.attempt?.executor?.tier ?? state.requirements.tier;
    const tier = nextAvailableTier(current, availableModelTiers(this.hosts(id, false), state.requirements, task.project, Date.now()));
    if (!tier) throw new Error("gate: no larger model tier is available; report findings or an explicit unmet tier requirement instead");
    if (!apply) return tier;
    const meta: TaskMeta = JSON.parse(task.meta || "{}");
    openLargerModelStrategy(state,tier,summary,"independent_review",String(meta.work_revision??"legacy"));
    state.requirements.tier = tier; state.revision += 1;
    meta.execution_requirements = state.requirements;
    meta.execution_escalation = { kind: "review", tier, reason: summary, by: actor, at: Date.now() };
    delete meta.session; delete meta.blocked; delete meta.interactive_execution;
    // Called inside the review completion transaction: verdict + requeue commit together.
    this.sql.exec(`INSERT INTO execution_state(task_id,state,worker_token_id) VALUES (?,?,'') ON CONFLICT(task_id) DO UPDATE SET state=excluded.state`, id, JSON.stringify(state));
    this.sql.exec(`UPDATE artefacts SET status='todo',owner='',meta=?,updated_ts=?,status_ts=? WHERE id=?`, JSON.stringify(meta), Date.now(), Date.now(), id);
    this.record(id, actor, { kind: "model_escalated", from_tier: current, to_tier: tier, reason: summary, source: "review", review_id: reviewId, generation: state.generation });
    this.audit(actor, "review_model_escalation", id, { tier, summary });
    return tier;
  }
  private credential(tokenId: string): Credential | null { return this.one<Credential>(`SELECT id,label,principal,tags,revoked_ts FROM auth_tokens WHERE id=?`, tokenId); }
  isInteractive(tokenId: string): boolean { return interactiveCredential(this.credential(tokenId)); }
  /** Validation is repeated inside the claim transaction after asynchronous lifecycle checks. */
  assertInteractiveClaim(id: string, tokenId: string, session: string) {
    if (!this.isInteractive(tokenId)) throw new Error("gate: direct claim requires a live full interactive credential");
    if (!session) throw new Error("gate: direct interactive claim requires a named interactive session");
    const task = this.task(id); const state = this.state(task);
    if (state.attempt && state.attempt.phase !== "quiesced") throw new Error("gate: previous executor writer not quiescent — stop and preserve its work before claiming");
    if (state.operations.some(op => op.state === "prepared" || op.state === "outcome_unknown")) throw new Error("gate: reconcile unknown external operations before interactive claim");
    if (state.handoff.phase === "preparing") throw new Error("gate: local handoff preparation must complete before claiming");
    if (state.handoff.phase === "accepted") throw new Error("gate: local handoff already has an executor; preserve its claim");
    const h = state.handoff; const token = this.credential(tokenId)!;
    if (h.phase === "waiting" && h.recipient && h.recipient !== token.label && h.recipient !== token.principal) throw new Error("gate: local handoff is addressed to another recipient");
    if (this.asks(id).length || this.one(`SELECT q.id FROM relations r JOIN artefacts q ON q.id=r.src_id WHERE r.dst_id=? AND r.relation='child_of' AND q.type='question' AND q.status NOT IN ('done','superseded') AND json_extract(q.meta,'$.ask.to')='human' LIMIT 1`, id)) {
      // BR#22008 F5 — the fence names WHICH ask owns the exit (typed
      // owns_exit on the rejection body): the UI routes the human to the
      // answer row instead of surfacing bare gate text. The bound ask wins
      // (asks(id) — meta.awaiting_ask), else the human-routed child
      // question found above.
      const childAsk = this.one(
        `SELECT q.id AS id FROM relations r JOIN artefacts q ON q.id=r.src_id WHERE r.dst_id=? AND r.relation='child_of' AND q.type='question' AND q.status NOT IN ('done','superseded') AND json_extract(q.meta,'$.ask.to')='human' LIMIT 1`,
        id,
      ) as { id?: string } | undefined;
      const boundAsk = this.asks(id)[0] ?? childAsk?.id;
      throw Object.assign(
        new Error("gate: an open human decision owns this exit; answer it before claiming"),
        { result_class: "gate_rejected", rule: "human-decision-owns-exit", ...(boundAsk ? { owns_exit: { ask_id: String(boundAsk) } } : {}) },
      );
    }
  }
  /** Caller owns the SQLite transaction containing the card's single claim write. */
  claimInteractive(id: string, tokenId: string, session: string, meta: TaskMeta) {
    this.assertInteractiveClaim(id, tokenId, session);
    const task = this.task(id); const state = this.state(task); const token = this.credential(tokenId)!;
    if (state.handoff.phase === "waiting") {
      // Explicit claim consumes the pickup, retaining its published continuation and proof.
      state.handoff = { ...state.handoff, phase: "returned", returned_at: Date.now(), by: token.label };
    }
    state.revision += 1;
    this.sql.exec(`INSERT INTO execution_state(task_id,state,worker_token_id) VALUES (?,?,'') ON CONFLICT(task_id) DO UPDATE SET state=excluded.state`, id, JSON.stringify(ExecutionStateSchema.parse(state)));
    meta.interactive_execution = InteractiveClaimSchema.parse({ kind: "interactive", token_id: tokenId, session, claimed_at: Date.now() });
    meta.session = session;
    delete meta.taken_over; // a new claim replaces the old takeover's session fence
    delete meta.execution_wait; delete meta.blocked; delete meta.local_execution; delete meta.startup_wait;
    meta.execution_blockers = [];
    this.sql.exec(`DELETE FROM executor_start_waits WHERE task_id=?`, id);
    this.audit(token.label, "interactive_claim", id, { session, checkpoint: state.attempt?.checkpoint?.commit ?? null });
  }
  private hostInventory(includeOccupancy = true): HostInventory[] {
    return this.sql.exec(`SELECT t.label,h.token_id,h.capabilities,h.observed_ts FROM execution_hosts h JOIN auth_tokens t ON t.id=h.token_id WHERE t.revoked_ts IS NULL`).toArray().map(row => {
      const n = includeOccupancy ? gatewayOccupancy(this.sql, String(row.token_id), String(row.label)) : null;
      return {
      tokenId: String(row.token_id), host: String(row.label), capabilities: ExecutorCapabilitiesSchema.parse(JSON.parse(String(row.capabilities))), observed_at: Number(row.observed_ts),
        active: n ? n.active + n.reserved : 0, occupancy: n?.occupancy,
     }; });
  }
  private hosts(taskId: string, includeOccupancy = true, columns?: TaskColumns): CapabilityObservation[] {
    const inventory = this.hostSnapshot?.() ?? this.hostInventory(includeOccupancy);
    if (!inventory.length) return [];
    const rejections = new Map<string, Set<string>>();
    if (taskId) for (const row of this.sql.exec(
      `SELECT host,fingerprint FROM executor_start_rejections WHERE task_id=?`, taskId,
    ).toArray()) {
      const host = String(row.host);
      const fingerprints = rejections.get(host) ?? new Set<string>();
      fingerprints.add(String(row.fingerprint));
      rejections.set(host, fingerprints);
    }
    const task = rejections.size ? columns ?? this.one<{ body_md: string; project: string; meta: string }>(
      `SELECT body_md,project,meta FROM artefacts WHERE id=?`, taskId!,
    ) : null;
    const meta = task ? JSON.parse(task.meta || "{}") : null;
    const prerequisite = task && { ...task, meta: { ...meta, execution_requirements: ExecutionRequirementsSchema.parse(meta.execution_requirements ?? {}) } };
    return inventory.map(({ tokenId, ...host }) => {
      const proof = this.hostReadiness(tokenId, host.host, host.capabilities);
      const rejected = rejections.get(host.host);
      const fenced = proof.kind === "ready" && rejected && (rejected.has(proof.fingerprint)
        || (prerequisite && rejected.has(startupPrerequisiteFingerprint(proof.fingerprint, prerequisite))));
      const readiness: ExecutorReadiness = fenced
        ? { kind: "task_prerequisite", reason: "This task's startup prerequisite requires changed executor/configuration proof" }
        : proof;
      return { ...host, readiness };
    });
  }
  /** BR#14767 sweep path: host-LEVEL readiness (the injected readiness
   *  callback), memoized per snapshot. Task-specific startup fences belong
   *  to blocker projection rather than the tier selection pass. The sweep loop
   *  layers task-specific startup rejection itself (bulk-fetched); the tier
   *  selection only needs "is this host usable for the lane", which is
   *  exactly host-level readiness. Memo dies with the snapshot
   *  (withHostSnapshot clears it) — never cached across sweeps. */
  private hostsBareCache: CapabilityObservation[] | null = null;
  private hostReadiness(token: string, host: string, capabilities: ExecutorCapabilities): ExecutorReadiness {
    const cached = this.readinessSnapshot?.get(token);
    if (cached) return cached;
    const proof = this.readiness(token, host, capabilities, Date.now());
    this.readinessSnapshot?.set(token, proof);
    return proof;
  }
  private hostsBare(): CapabilityObservation[] {
    if (this.hostSnapshot && this.hostsBareCache) return this.hostsBareCache;
    const value: CapabilityObservation[] = (this.hostSnapshot?.() ?? this.hostInventory(false)).map(({ tokenId, ...host }) => ({ ...host,
      readiness: this.hostReadiness(tokenId, host.host, host.capabilities) }));
    if (this.hostSnapshot) this.hostsBareCache = value;
    return value;
  }
  private startupWait(id: string) {
    const row = this.one<{ state: string }>(`SELECT state FROM executor_start_waits WHERE task_id=?`, id);
    return row ? StartupWaitSchema.parse(JSON.parse(row.state)) : null;
  }
  availability(id: string) {
    const task = this.task(id); const blockers = this.blockers(task, Date.now());
    const capability = blockers.find(isExecutorAvailabilityBlocker);
    const state = this.state(task);
    const requirements = state.requirements;
    const hosts = this.hosts(id).map(host => {
      const inventory = [host.capabilities, ...host.capabilities.alternatives];
      const compatible = inventory.some(c => capabilityBlockers(requirements, c, host.host).length === 0);
      const missing = compatible ? []
        : inventory.map(c => capabilityBlockers(requirements, c, host.host)).sort((a, b) => a.length - b.length)[0];
      if (!missing.length && !inventory.some(c => usableFor(requirements, c, host.host, task.project))) missing.push("model_or_project_scope");
      return { ...host, observed_ts: host.observed_at, expires_ts: host.observed_at + 120_000, blockers: missing, busy: host.active >= host.capabilities.capacity };
    });
    const startup_wait = this.startupWait(id);
    return { requirements, blockers, startup_wait, model_policy: this.modelPolicy(),
      next_available_tier: nextAvailableTier(state.attempt?.executor?.tier ?? state.requirements.tier, availableModelTiers(this.hosts(id, false), requirements, task.project, Date.now())),
      phase: startup_wait ? "unavailable" : capability?.kind === "capability_unavailable" ? capability.reason : capability?.kind === "executor_not_ready" ? "executor_not_ready"
      : blockers.some(b => b.kind === "capacity_wait") ? "capacity_wait" : "ready", hosts };
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
  blockers(task: TaskRow, now: number, grant: LocalGrant | null = null, state = this.state(task), columns?: TaskColumns): ExecutionBlocker[] {
    const local = grant ? { host: grant.host, capabilities: grant.capabilities }
      : state.handoff.phase === "accepted" ? { host: state.handoff.host, capabilities: state.handoff.capabilities } : undefined;
    const requirements = state.requirements;
    const blockers = projectExecutionBlockers({ id: task.id, project: task.project, requirements, handoff: state.handoff, hosts: this.hosts(task.id, true, columns), asks: this.asks(task.id), now, local });
    const wait = this.startupWait(task.id);
    if (wait) blockers.push({ kind: "startup_wait", episode_id: `startup:${task.id}:${wait.since}`, text: startupWaitReason(wait), wait });
    const meta: TaskMeta = JSON.parse(task.meta || "{}");
    if (state.attempt && state.attempt.phase !== "quiesced" && !["in_progress", "in_review"].includes(task.status)
        && !blockers.some(b => b.kind === "writer_quiescence_required")) blockers.push({
      kind: "writer_quiescence_required", episode_id: `writer:${task.id}:${state.attempt.generation}:${state.attempt.attempt_id}`,
      text: `The previous execution on ${state.attempt.host} has no stopped-writer proof. The gateway must reconcile generation ${state.attempt.generation} before this repair can start; priority cannot safely replace an unconfirmed writer.`,
    });
    const direct = InteractiveClaimSchema.safeParse(meta.interactive_execution);
    // Missing unattended capacity is not a blocker on an authenticated interactive owner.
    // Its actual model remains unreported rather than borrowing the old runner's identity.
    return direct.success && ["in_progress", "in_review"].includes(task.status)
      && ownsInteractiveClaim(meta, direct.data.token_id, direct.data.session) && this.isInteractive(direct.data.token_id)
      ? blockers.filter(b => !isExecutorAvailabilityBlocker(b) && b.kind !== "capacity_wait") : blockers;
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
      if (attention && h.phase === "none" && !blockers.length) continue;
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
      if (cmd.checkpoint?.tests.some(t => t.tree !== cmd.checkpoint?.tree)) return { kind: "unmet_prerequisites" as const, prerequisites: ["checkpoint_evidence_content_mismatch"] };
      state.handoff = { ...h, phase: "waiting", checkpoint: null, version: h.version + 1, quiescence: { kind: "human_attested", by: actor, evidence: cmd.evidence } };
      const meta: TaskMeta = JSON.parse(task.meta || "{}");
      meta.execution_requirements = state.requirements;
      meta.blocked = { reason: `Pick up locally: ${h.action}`, ts: Date.now(), unblock_condition: "Explicit authorised local acceptance", await_event: { event: "local_handoff", handoff_id: h.id, version: h.version + 1 } };
      this.storage.transactionSync(() => { this.save(task.id, state); this.sql.exec(`UPDATE artefacts SET status='blocked',owner='',meta=?,updated_ts=? WHERE id=?`, JSON.stringify(meta), Date.now(), task.id); });
      this.audit(actor, "local_preparation_attested", task.id, { handoff: h.id, evidence: cmd.evidence, checkpoint: cmd.checkpoint?.commit ?? null });
      return { kind: "preparation_confirmed" as const };
    }
    if (cmd.kind === "authorize") {
      if (h.phase !== "waiting") return { kind: "unmet_prerequisites" as const, prerequisites: ["handoff_not_waiting"] };
      const token = this.one<Credential>(`SELECT id,label,principal,tags,revoked_ts FROM auth_tokens WHERE label=?`, cmd.label);
      if (!interactiveCredential(token)) return { kind: "unauthorized" as const };
      if (h.recipient && h.recipient !== token!.label && h.recipient !== token!.principal) return { kind: "unauthorized" as const };
      if (/^(dispatch-|bridge-task-)/.test(cmd.session)) throw new Error("gate: local acceptance requires a separately named interactive session");
      const grant: LocalGrant = { id: crypto.randomUUID(), task_id: task.id, handoff_id: h.id, version: h.version,
        token_id: token!.id, session: cmd.session, host: cmd.host, by: actor, source: "human_attested", evidence: cmd.evidence, capabilities: cmd.capabilities, expires_at: Date.now() + (cmd.ttl_ms ?? 900_000) };
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
    state.revision += 1;
    this.storage.transactionSync(() => {
      this.save(task.id, state); delete meta.session; delete meta.blocked; delete meta.execution_wait; delete meta.local_execution;
      const asks = this.asks(task.id);
      if (asks.length) meta.blocked = { reason: asks[0].question, unblock_condition: `Answer ${asks[0].id}`, ts: Date.now(), await_event: { event: "ask", ask_id: asks[0].id } };
      this.sql.exec(`UPDATE artefacts SET status=?,owner='',meta=?,status_ts=?,updated_ts=? WHERE id=?`, asks.length ? "blocked" : "todo", JSON.stringify(meta), Date.now(), Date.now(), task.id);
      this.record(task.id, actor, { kind: "local_handoff_returned", handoff_id: h.id, checkpoint_commit: h.checkpoint?.commit ?? null });
    });
    this.audit(actor, "local_execution_returned", task.id, { handoff: h.id, writers: cmd.writers, checkpoint: h.checkpoint?.commit ?? null });
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
      this.record(task.id, token!.label, { kind: "local_handoff_accepted", handoff_id: h.id, ...ExecutionModelIdentitySchema.parse(grant.capabilities), host: grant.host, session: cmd.session });
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
    const startup = this.startupWait(id);
    const details = { id: `local:decision:${crypto.randomUUID()}`, version: 1, requested_at: Date.now(), reason, action: question,
      findings: "See the task and answered decision for the executor's findings.", tried: "Consult the executor's recorded history; no additional attempts are claimed.", next: "Read the continuation and explicitly accept this handoff after human authorisation.",
      evidence: [`https://hub.fleetbridge.run/card/${id.replace("#", "-")}`], approvals: [`Human selected local handoff (${actor})`], recipient: null, quiescence: { kind: "pending" as const } };
    state.handoff = state.attempt?.phase === "quiesced" && !state.operations.some(op => op.state === "prepared" || op.state === "outcome_unknown")
      ? { ...details, phase: "waiting", checkpoint: null, quiescence: { kind: "runner", host: state.attempt.host, generation: state.attempt.generation } } : { ...details, phase: "preparing" };
    if (state.attempt && state.attempt.phase !== "quiesced") state.attempt.phase = "stopping";
    const meta: TaskMeta = JSON.parse(task.meta || "{}"); delete meta.awaiting_ask; delete meta.startup_wait;
    meta.execution_requirements = state.requirements;
    meta.blocked = { reason: `Pick up locally: ${question}`, ts: Date.now(), unblock_condition: "Only explicit authorised local acceptance resolves this handoff; old-writer quiescence must complete first",
      await_event: { event: "local_handoff", handoff_id: details.id, version: 1 } };
    this.storage.transactionSync(() => {
      // Explicit human conversion transfers the wait, not execution authority.
      // Startup fingerprints remain fenced if automation is later resumed.
      this.sql.exec(`DELETE FROM executor_start_waits WHERE task_id=?`, id);
      this.sql.exec(`INSERT INTO execution_state (task_id,state,worker_token_id) VALUES (?,?,'') ON CONFLICT(task_id) DO UPDATE SET state=excluded.state`, id, JSON.stringify(state));
      this.sql.exec(`UPDATE artefacts SET status='blocked',owner=CASE WHEN ?='waiting' THEN '' ELSE owner END,meta=?,updated_ts=? WHERE id=?`, state.handoff.phase, JSON.stringify(meta), Date.now(), id);
      this.record(id, actor, { kind: "local_handoff_requested", handoff_id: details.id, reason, action: question, next: details.next });
    });
    this.audit(actor, "local_handoff_decision", id, { handoff: details.id, phase: state.handoff.phase, startup_wait: startup });
  }
  resumeAfterAnswer(id: string) {
    const task = this.task(id); const state = this.state(task);
    if (task.status !== "blocked" || !["accepted", "returned"].includes(state.handoff.phase) || this.asks(id).length) return;
    if (state.handoff.phase === "returned") {
      const meta: TaskMeta = JSON.parse(task.meta || "{}"); delete meta.blocked;
      this.sql.exec(`UPDATE artefacts SET status='todo',owner='',meta=?,status_ts=?,updated_ts=? WHERE id=?`, JSON.stringify(meta), Date.now(), Date.now(), id);
      this.sweep(); return;
    }
    if (this.blockers(task, Date.now()).some(isExecutorAvailabilityBlocker)) return;
    const meta: TaskMeta = JSON.parse(task.meta || "{}"); delete meta.blocked;
    this.sql.exec(`UPDATE artefacts SET status='in_progress',meta=?,status_ts=?,updated_ts=? WHERE id=?`, JSON.stringify(meta), Date.now(), Date.now(), id);
    this.audit("system:local-answer", "local_execution_resumed", id, { session: state.handoff.phase === "accepted" ? state.handoff.session : "" });
  }
  /** Expiry is level-triggered. Only queued capability waits resume; never
   * interfere with a healthy active writer or clear a human/local dependency. */
  sweep(now = Date.now()) {
    this.withHostSnapshot(() => this.sweepBatch(now));
  }
  /** BR#14761 — the scheduler's bounded duty before selecting work: reopen
   *  blocked capability waits the live fleet can now serve, over its own
   *  durable fair cursor. A reserve no longer pays a 25-card maintenance
   *  page; full-board maintenance (todo parks, blocker refresh, the original
   *  sweep cursor) stays on the alarm tick and the admin drill. Selection
   *  and the claim transaction still recheck every fence first-hand. */
  reopenCapabilityWaits(now = Date.now()) {
    this.withHostSnapshot(() => {
      const cursor = Number(this.one<{ value: string }>(`SELECT value FROM settings WHERE key=?`, CAPABILITY_WAIT_REOPEN_CURSOR_KEY)?.value ?? 0);
      const batch = (after: number) => this.sql.exec(CAPABILITY_WAIT_REOPEN_SQL, after).toArray() as unknown as (TaskRow & { body_md: string; roles: string; sweep_cursor: number })[];
      const first = batch(cursor);
      const rows = first.length || !cursor ? first : batch(0);
      for (const task of rows) this.reconcileTaskCapability(task, now, task);
      if (rows.length) this.sql.exec(`INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`, CAPABILITY_WAIT_REOPEN_CURSOR_KEY, String(rows.at(-1)!.sweep_cursor));
    });
  }
  /** Share the fleet inventory across a synchronous pass. Per-task readiness
   * and the final reservation transaction still check their own fences. */
  withHostSnapshot<T>(run: () => T): T {
    const previous = this.hostSnapshot;
    const previousReadiness = this.readinessSnapshot, previousPolicy = this.policySnapshot, previousBare = this.hostsBareCache;
    let inventory: HostInventory[] | undefined;
    this.hostSnapshot ??= () => inventory ??= this.hostInventory();
    try {
      if (!previous) {
        // Host proof and model policy are shared within one synchronous pass.
        // Task-specific rejection reads remain per task. No proof survives a
        // yield or a later reservation transaction.
        this.readinessSnapshot = new Map();
        this.policySnapshot = this.modelPolicy();
        this.hostsBareCache = null;
      }
      return run();
    } finally {
      this.hostSnapshot = previous;
      this.readinessSnapshot = previousReadiness;
      this.policySnapshot = previousPolicy;
      this.hostsBareCache = previousBare;
    }
  }
  private sweepBatch(now: number) {
    // Legacy workspaces without any managed executor inventory retain their
    // manual workflow. Once a gateway advertises, global defaults apply too.
    const cursor = Number(this.one<{ value: string }>(`SELECT value FROM settings WHERE key='execution_sweep_cursor'`)?.value ?? 0);
    const batch = (after: number) => this.sql.exec(CAPABILITY_SWEEP_SQL, after).toArray() as unknown as (TaskRow & { body_md: string; roles: string; sweep_cursor: number })[];
    const first = batch(cursor);
    const rows = first.length || !cursor ? first : batch(0);
    for (const task of rows) this.reconcileTaskCapability(task, now, task);
    this.sql.exec(`INSERT OR REPLACE INTO settings(key,value) VALUES('execution_sweep_cursor',?)`, String(rows.at(-1)?.sweep_cursor ?? 0));
  }
  /** ONE task's capability reconciliation — the alarm page and the
   *  scheduler's reopen pass share this exact predicate and write, so the
   *  two paths can never drift. `columns` are the page's own artefact
   *  columns (the same synchronous snapshot the page was read in); tier
   *  selection reads host-level readiness through them exactly as the
   *  dispatch sweep does, and taskReadiness skips its per-row re-SELECT. */
  private reconcileTaskCapability(task: TaskRow, now: number, columns?: TaskColumns) {
    const state = this.state(task, columns); const meta: TaskMeta = JSON.parse(task.meta || "{}"); const blockers = this.blockers(task, now, null, state, columns);
    const prior = JSON.stringify(meta.execution_blockers ?? []); meta.execution_blockers = blockers;
    let status = task.status;
    const capabilityWait = status === "blocked"
      && (meta.blocked as { await_event?: { event?: string } })?.await_event?.event === "executor_capability"
      // BR#23279 — the capability park is retired in BOTH historical shapes:
      // the reconcile's own marker pair (execution_wait + await_event) and the
      // legacy agent-authored shape (a typed executor_capability await_event
      // the old grammar accepted; the machine now refuses new ones). The
      // machine grammar rejection retires the pen; this branch drains the
      // historical class through the same privileged pen that always owned
      // capability waits — the release-hold backstop guards LIVE typed waits,
      // and a retired wait is deleted in the same write that releases the
      // card, so the backstop never re-refuses it.
      && (meta.execution_wait?.kind === "capability" || !meta.execution_wait);
    const independent = blockers.some(b => b.kind === "human_answer_required" || b.kind === "local_pickup_required");
    if (this.startupWait(task.id)) {
      // Startup reconciliation owns this episode.
    } else if (capabilityWait && !task.owner && !independent) {
      // BR#23279 — executor readiness is never a block condition. The legacy
      // capability park (never-started work blocked awaiting an executor —
      // blockedParkVerdict classed it external, so no sweep could ever drain
      // it) is released to todo UNCONDITIONALLY, not only when availability
      // returns or an attempt fence holds. The card is claimable; dispatch
      // admission — this same blockers read — holds it while no executor is
      // ready, and meta.execution_blockers keeps the readiness evidence
      // visible to the board and the attention page. The scheduler owns the
      // wait; the board never did.
      status = "todo"; delete meta.blocked; delete meta.execution_wait;
    }
    // BR#23279 — a todo card with unavailable blockers STAYS todo: no park,
    // no execution_wait marker. The blockers ride meta (the write below) and
    // the held dispatch view is what the board shows. In-flight interruptions
    // (a live executor lost mid-work) are the watchdog's interrupted park —
    // a different, bounded state with preserved resume; never this sweep.
    if (prior === JSON.stringify(blockers) && status === task.status) return;
    this.sql.exec(`UPDATE artefacts SET status=?,meta=?,updated_ts=?,status_ts=CASE WHEN status!=? THEN ? ELSE status_ts END WHERE id=?`, status, JSON.stringify(meta), Date.now(), status, Date.now(), task.id);
    // Stable per task/requirements episode; flapping updates the same card,
    // never manufactures an approval ask or an unblock-child storm.
    this.audit("system:capabilities", "execution_blockers_changed", task.id, { blockers: blockers.map(b => ({ kind: b.kind, episode: b.episode_id })), status });
  }
}
