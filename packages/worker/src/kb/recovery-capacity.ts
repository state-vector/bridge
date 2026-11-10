import { ExecutionStateSchema, RecoveryPreemptionSchema, reduceExecution, type RecoveryPreemption } from "@bridge/contracts";
import { isRootFixCard, parseTags } from "./core";

interface Task { id: string; meta: string; tags: string; roles: string; trainReview: boolean }
export const priorityTask = (row: Record<string, unknown>): Task => ({
  id: String(row.id), meta: String(row.meta ?? "{}"), tags: String(row.tags ?? "[]"),
  roles: String(row.roles ?? "[]"), trainReview: row.train_review === 1,
});

// An exact server-bound review of a recovered train delivery continues its
// parent's work. Use the same authority join for selection and preemption.
export const trainReviewParentJoin = `LEFT JOIN artefacts delivery ON delivery.id=json_extract(a.meta,'$.execution_review_of')
  AND delivery.type='task' AND delivery.status='in_review' AND a.roles='["review"]'
  AND json_extract(delivery.meta,'$.merge_train.state') IN ('bounced','unbound')
  AND json_extract(delivery.meta,'$.merge_train.bounced_at')>0
  AND CAST(json_extract(delivery.meta,'$.merge_train.pr') AS INTEGER)>0
  AND (json_type(a.meta,'$.review_subject') IS NULL OR (
    json_extract(a.meta,'$.review_subject.task_id')=delivery.id
    AND json_extract(a.meta,'$.review_subject.revision')=COALESCE(json_extract(delivery.meta,'$.work_revision'),'legacy')))
  AND EXISTS (SELECT 1 FROM train_events tr WHERE tr.task_id=delivery.id
    AND tr.repo=json_extract(delivery.meta,'$.merge_train.repo') AND tr.pr=json_extract(delivery.meta,'$.merge_train.pr')
    AND ((tr.kind='bounced' AND json_extract(tr.detail,'$.bounced_at')=json_extract(delivery.meta,'$.merge_train.bounced_at'))
      OR (tr.kind='landed' AND json_extract(tr.detail,'$.close_bounced')=1
        AND tr.merge_sha=json_extract(delivery.meta,'$.merge_train.landed_merge_sha')))
    AND (EXISTS (SELECT 1 FROM ledger WHERE artefact_id=a.id AND kind='mutation' AND action='review_registered'
      AND json_extract(data,'$.task_id')=delivery.id
      AND json_extract(data,'$.subject_revision')=COALESCE(json_extract(delivery.meta,'$.work_revision'),'legacy'))
      OR (tr.kind='landed' AND EXISTS (SELECT 1 FROM ledger WHERE artefact_id=delivery.id AND kind='signal'
        AND action='observed_merge_review_submitted' AND ts>=delivery.status_ts
        AND json_extract(data,'$.review')=a.id AND json_extract(data,'$.repo')=tr.repo
        AND json_extract(data,'$.pr')=tr.pr AND json_extract(data,'$.merge_sha')=tr.merge_sha)))
    AND (EXISTS (SELECT 1 FROM json_each(delivery.meta,'$.prs') AS leg
      WHERE CASE WHEN leg.type='object' THEN json_extract(leg.value,'$.repo')=tr.repo
        AND json_extract(leg.value,'$.number')=tr.pr AND COALESCE(json_extract(leg.value,'$.base'),'main')=tr.base ELSE 0 END)
      OR (json_extract(delivery.meta,'$.pr.repo')=tr.repo AND json_extract(delivery.meta,'$.pr.number')=tr.pr
        AND COALESCE(json_extract(delivery.meta,'$.pr.base'),'main')=tr.base)))`;
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
export const taskSchedulingRank = (task: Task) => task.trainReview ? 0 : schedulingRank(JSON.parse(task.meta || "{}"), parseTags(task.tags), parseTags(task.roles));

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
    const victims = this.sql.exec(`SELECT a.id,a.meta,a.tags,a.roles,e.state,delivery.id IS NOT NULL AS train_review
      FROM artefacts a JOIN execution_state e ON e.task_id=a.id
      ${trainReviewParentJoin}
      WHERE a.type='task' AND a.status='in_progress' AND json_extract(e.state,'$.attempt.host')=?
      AND json_extract(e.state,'$.attempt.phase')='running' ORDER BY a.updated_ts DESC`, host).toArray();
    for (const row of victims) {
      const id = String(row.id), meta: Meta = JSON.parse(String(row.meta));
      if (!parseTags(row.roles).includes("review") || taskSchedulingRank(priorityTask(row)) <= 1
        || meta.interactive_execution || meta.operator_gated || this.protectedTask(id, meta)) continue;
      const parents = this.sql.exec(`SELECT p.meta,p.tags,p.roles FROM relations r JOIN artefacts p ON p.id=r.dst_id WHERE r.src_id=? AND r.relation='child_of'`, id).toArray();
      if (typeof meta.execution_review_of === "string") parents.push(...this.sql.exec(`SELECT meta,tags,roles FROM artefacts WHERE id=?`, meta.execution_review_of).toArray());
      if (parents.some(p => schedulingRank(JSON.parse(String(p.meta)), parseTags(p.tags), parseTags(p.roles)) <= 1)) continue;
      const state = ExecutionStateSchema.parse(JSON.parse(String(row.state))), a = state.attempt;
      if (!a || a.phase !== "running" || a.session !== meta.session || a.lease_until <= now || a.action_deadline <= now
        || !["none", "returned"].includes(state.handoff.phase) || state.operations.some(op => op.state === "prepared" || op.state === "outcome_unknown")
        || state.messages.some(m => m.priority === "interrupt" && m.state !== "acted")) continue;
      const pending: RecoveryPreemption = { phase: "stopping_verification", recovery_id: recovery.id, victim_id: id,
        generation: a.generation, attempt_id: a.attempt_id, session: a.session, requested_at: now, checkpoint_commit: a.checkpoint?.commit ?? null };
      const stopped = reduceExecution(state, { kind: "message", message_id: `recovery-preempt:${recovery.id}:${a.generation}:${a.attempt_id}`,
        priority: "interrupt", text: `Priority line recovery ${recovery.id} needs this slot. Stop safely, confirm process-group quiescence and yield. Record findings on the task. Verification starts fresh after recovery. Keep review separation.` }, host, a.session, now);
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
