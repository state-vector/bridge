import { ExecutionStateSchema, RecoveryPreemptionSchema, reduceExecution, type RecoveryPreemption } from "@bridge/contracts";
import { isRootFixCard, parseTags } from "./core";

interface Task { id: string; meta: string; tags: string; roles: string }
export const priorityTask = (row: Record<string, unknown>): Task => ({ id: String(row.id), meta: String(row.meta ?? "{}"), tags: String(row.tags ?? "[]"), roles: String(row.roles ?? "[]") });
type Meta = Record<string, unknown>;
const object = (v: unknown): Meta => typeof v === "object" && v !== null && !Array.isArray(v) ? v as Meta : {};

/** One priority law for discovery, reservations and preemption. A concrete
 * repair outranks generic diagnostics, not merely ordinary implementation. */
export function schedulingRank(meta: Meta, tags: string[], roles: string[]): number {
  const duty = object(meta.machine_duty);
  if (duty.kind === "task-recovery" || isRootFixCard({ meta, tags })) return 0;
  if (duty.kind === "line_recovery") return 1;
  if (duty.kind === "diagnostic" || tags.includes("merge-train") && tags.includes("diagnostic")) return 2;
  if (meta.boosted) return 3;
  return roles.includes("review") || roles.includes("unblock") ? 4 : 5;
}
export const taskSchedulingRank = (task: Task) => schedulingRank(JSON.parse(task.meta || "{}"), parseTags(task.tags), parseTags(task.roles));

/** Human urgency breaks ties WITHIN a class, never displacing concrete repair
 * with routine verification. Otherwise a freshly diagnosed line fix sits
 * behind the entire historical repair backlog despite an explicit boost. */
export function schedulingBoost(meta: Meta): number {
  return typeof meta.boosted === "number" && Number.isFinite(meta.boosted) ? meta.boosted : meta.boosted ? 1 : 0;
}

/** Review is part of the repair's critical path, not routine verification.
 * Preserve the existing typed duty class/urgency on its independent duty. */
export function recoveryReviewMeta(taskId: string, meta: Meta, tags: string[]): Meta {
  const base: Meta = { execution_review_of: taskId };
  if (schedulingRank(meta, tags, []) > 1) return base;
  const duty = object(meta.machine_duty);
  return { ...base, machine_duty: { kind: duty.kind === "line_recovery" ? "line_recovery" : "task-recovery",
    by: "recovery-review", subject: taskId, reason: typeof duty.reason === "string" ? duty.reason : "head_checks" },
    ...(meta.boosted ? { boosted: meta.boosted } : {}) };
}

/** Capacity is never transferred on an interrupt alone. One durable handoff
 * per host survives replays, restarts and concurrent scheduler requests. */
export class RecoveryCapacity {
  constructor(private storage: DurableObjectStorage, private protectedTask: (id: string, meta: Meta) => boolean,
    private audit: (actor: string, op: string, id: string, data: object) => void) {}
  private get sql() { return this.storage.sql; }
  private state(id: string) {
    const row = this.sql.exec(`SELECT state FROM execution_state WHERE task_id=?`, id).toArray()[0];
    return row ? ExecutionStateSchema.parse(JSON.parse(String(row.state))) : null;
  }
  read(token: string): RecoveryPreemption | null {
    const row = this.sql.exec(`SELECT state FROM recovery_preemptions WHERE token_id=?`, token).toArray()[0];
    if (!row) return null;
    const pending = RecoveryPreemptionSchema.parse(JSON.parse(String(row.state)));
    const attempt = this.state(pending.victim_id)?.attempt;
    return { ...pending, phase: attempt && (attempt.generation > pending.generation || attempt.generation === pending.generation && attempt.attempt_id === pending.attempt_id && ["quiesced", "finalizing"].includes(attempt.phase))
      ? "slot_available" : "stopping_verification" };
  }
  forRecovery(id: string): RecoveryPreemption | null {
    const row = this.sql.exec(`SELECT token_id FROM recovery_preemptions WHERE json_extract(state,'$.recovery_id')=? LIMIT 1`, id).toArray()[0];
    return row ? this.read(String(row.token_id)) : null;
  }
  forVictim(id: string): RecoveryPreemption | null {
    const row = this.sql.exec(`SELECT token_id FROM recovery_preemptions WHERE json_extract(state,'$.victim_id')=? LIMIT 1`, id).toArray()[0];
    return row ? this.read(String(row.token_id)) : null;
  }
  prepare(token: string, eligible: Task[], mutate: boolean): RecoveryPreemption | null {
    const pending = this.read(token);
    if (!pending || pending.phase === "stopping_verification" || eligible.some(t => t.id === pending.recovery_id)) return pending;
    if (mutate) this.sql.exec(`DELETE FROM recovery_preemptions WHERE token_id=?`, token);
    return null;
  }
  consume(token: string, selected: string) {
    const pending = this.read(token);
    if (pending?.phase === "slot_available" && pending.recovery_id === selected) this.sql.exec(`DELETE FROM recovery_preemptions WHERE token_id=?`, token);
  }
  request(token: string, host: string, recovery: Task): RecoveryPreemption | null {
    const prior = this.read(token);
    if (prior) return prior;
    if (taskSchedulingRank(recovery) > 1) return null;
    const now = Date.now();
    const victims = this.sql.exec(`SELECT a.id,a.meta,a.tags,a.roles,e.state FROM artefacts a JOIN execution_state e ON e.task_id=a.id
      WHERE a.type='task' AND a.status='in_progress' AND json_extract(e.state,'$.attempt.host')=?
      AND json_extract(e.state,'$.attempt.phase')='running' ORDER BY a.updated_ts DESC`, host).toArray();
    for (const row of victims) {
      const id = String(row.id), meta: Meta = JSON.parse(String(row.meta));
      if (!parseTags(row.roles).includes("review") || schedulingRank(meta, parseTags(row.tags), parseTags(row.roles)) <= 1
        || meta.interactive_execution || meta.operator_gated || this.protectedTask(id, meta)) continue;
      const parents = this.sql.exec(`SELECT p.meta,p.tags,p.roles FROM relations r JOIN artefacts p ON p.id=r.dst_id WHERE r.src_id=? AND r.relation='child_of'`, id).toArray();
      if (typeof meta.execution_review_of === "string") parents.push(...this.sql.exec(`SELECT meta,tags,roles FROM artefacts WHERE id=?`, meta.execution_review_of).toArray());
      if (parents.some(p => schedulingRank(JSON.parse(String(p.meta)), parseTags(p.tags), parseTags(p.roles)) <= 1)) continue;
      const state = ExecutionStateSchema.parse(JSON.parse(String(row.state))), a = state.attempt;
      if (!a || a.phase !== "running" || a.session !== meta.session || a.lease_until <= now || a.action_deadline <= now || !a.checkpoint
        || !["none", "returned"].includes(state.handoff.phase) || state.operations.some(op => op.state === "prepared" || op.state === "outcome_unknown")
        || state.messages.some(m => m.priority === "interrupt" && m.state !== "acted")) continue;
      const pending: RecoveryPreemption = { phase: "stopping_verification", recovery_id: recovery.id, victim_id: id,
        generation: a.generation, attempt_id: a.attempt_id, session: a.session, requested_at: now, checkpoint_commit: a.checkpoint.commit };
      const stopped = reduceExecution(state, { kind: "message", message_id: `recovery-preempt:${recovery.id}:${a.generation}:${a.attempt_id}`,
        priority: "interrupt", text: `Priority line recovery ${recovery.id} needs this slot. Stop safely, preserve and publish your current checkpoint, confirm process-group quiescence and yield. Your verification returns to todo and resumes from its checkpoint after recovery. Do not discard work or relax review separation.` }, host, a.session, now);
      this.storage.transactionSync(() => {
        this.sql.exec(`INSERT INTO recovery_preemptions(token_id,state) VALUES (?,?)`, token, JSON.stringify(pending));
        this.sql.exec(`UPDATE execution_state SET state=? WHERE task_id=?`, JSON.stringify(stopped), id);
        this.audit("system:scheduler", "recovery_preemption_requested", recovery.id, pending);
      });
      return pending;
    }
    return null;
  }
}
