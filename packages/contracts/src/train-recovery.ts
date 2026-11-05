import { z } from "zod";

const Text = z.string().trim().min(1).max(2000);
const TaskId = z.string().regex(/^BR#\d+$/);
export const RecoveryCauseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("test_failure"), check: Text, suite: Text, test: Text }),
  z.object({ kind: z.literal("capability_unavailable"), check: Text, scenario: Text, capability: Text, scope: Text }),
  z.object({ kind: z.literal("check_failure"), check: Text }),
]);
export type RecoveryCause = z.infer<typeof RecoveryCauseSchema>;
export const RecoveryReceiptSchema = z.object({
  head_sha: z.string().regex(/^[0-9a-f]{40}$/), run_id: z.number().int().positive(),
  run_attempt: z.number().int().positive(), url: z.string().url(),
});
export type RecoveryReceipt = z.infer<typeof RecoveryReceiptSchema>;
const Pending = { task_id: TaskId, next: Text };
export const RecoveryStageSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("diagnosing"), ...Pending }),
  z.object({ phase: z.literal("repairing"), ...Pending, diagnosis: Text }),
  z.object({ phase: z.literal("verifying"), ...Pending }),
  z.object({ phase: z.literal("exhausted"), ...Pending, reason: Text }),
  z.object({ phase: z.literal("superseded"), ...Pending, reason: Text }),
  z.object({ phase: z.literal("recovered"), ...Pending, receipt: RecoveryReceiptSchema }),
]);
const AttemptFields = { id: Text, kind: z.enum(["retry", "repair", "verification"]), action: Text, started_at: z.number() };
export const RecoveryAttemptSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("running"), ...AttemptFields }),
  z.object({ status: z.literal("finished"), ...AttemptFields, finished_at: z.number(),
    outcome: z.enum(["failed", "delivered", "inconclusive"]), summary: Text, receipts: z.array(z.string().url()) }),
]);
export const RecoveryEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("observed"), task_id: TaskId, source: RecoveryReceiptSchema, next: Text,
    successful_deployments_required: z.number().int().min(1).max(10).optional() }),
  z.object({ kind: z.literal("diagnosed"), task_id: TaskId, diagnosis: Text, next: Text }),
  z.object({ kind: z.literal("attempt_started"), task_id: TaskId, attempt_id: Text,
    attempt_kind: z.enum(["retry", "repair", "verification"]), action: Text, next: Text }),
  z.object({ kind: z.literal("attempt_finished"), task_id: TaskId, attempt_id: Text,
    outcome: z.enum(["failed", "delivered", "inconclusive"]), summary: Text, receipts: z.array(z.string().url()), next: Text }),
  z.object({ kind: z.literal("progress"), task_id: TaskId, did: Text, next: Text }),
  z.object({ kind: z.literal("delivery_submitted"), task_id: TaskId }),
  z.object({ kind: z.literal("repair_delivery_observed"), task_id: TaskId, pr: z.number().int().positive(),
    head_sha: z.string().regex(/^[0-9a-f]{40}$/), merge_sha: z.string().regex(/^[0-9a-f]{40}$/), url: z.string().url() }),
]);
export type RecoveryEvent = z.infer<typeof RecoveryEventSchema>;
export type RecoveryReducerEvent = RecoveryEvent | { kind: "executor_assigned"; task_id: string }
  | { kind: "repair_merged"; task_id: string; pr: number; merge_sha: string; url: string };
export const RecoveryEpisodeSchema = z.object({
  id: z.string(), head_sha: z.string(), cause: RecoveryCauseSchema,
  stage: RecoveryStageSchema, retry_limit: z.number().int().nonnegative(),
  successful_deployments_required: z.number().int().min(1).max(10), verified_receipts: z.array(RecoveryReceiptSchema),
  delivery: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("pending") }), z.object({ kind: z.literal("submitted") }),
    z.object({ kind: z.literal("train_merge"), pr: z.number(), merge_sha: z.string(), url: z.string().url() }),
    z.object({ kind: z.literal("observed_merge"), pr: z.number(), head_sha: z.string(), merge_sha: z.string(), url: z.string().url() }),
  ]).default({ kind: "pending" }),
  sources: z.array(RecoveryReceiptSchema).min(1), attempts: z.array(RecoveryAttemptSchema),
  history: z.array(z.object({ event_id: z.string(), at: z.number(), actor: z.string(), kind: z.string(), summary: z.string() })),
  created_at: z.number(), updated_at: z.number(),
});
export type RecoveryEpisode = z.infer<typeof RecoveryEpisodeSchema>;
export const RecoveryLedgerSchema = z.record(z.string(), RecoveryEpisodeSchema);
export const RecoveryCommandSchema = z.object({
  repo: z.string(), base: z.string().default("main"), head_sha: z.string().regex(/^[0-9a-f]{40}$/),
  cause: RecoveryCauseSchema, event_id: Text, event: RecoveryEventSchema,
});
export type RecoveryCommand = z.infer<typeof RecoveryCommandSchema>;
export const RecoveryLinksSchema = z.array(z.object({ repo: z.string(), base: z.string(), head_sha: z.string(), cause: RecoveryCauseSchema }));

/** Scope/line samples are evidence, not new incidents on every timed-out
 * entity. Workflow attempt numbers never participate in cause identity. */
export function recoveryEpisodeKey(head: string, cause: RecoveryCause): string {
  switch (cause.kind) {
    case "test_failure": return JSON.stringify([head, cause.kind, cause.check, cause.suite, cause.test]);
    case "capability_unavailable": return JSON.stringify([head, cause.kind, cause.check, cause.scenario, cause.capability]);
    case "check_failure": return JSON.stringify([head, cause.kind, cause.check]);
  }
}
export function recoveryCauseLabel(cause: RecoveryCause): string {
  switch (cause.kind) {
    case "test_failure": return `${cause.suite}: ${cause.test}`;
    case "capability_unavailable": return `${cause.scenario}: ${cause.capability} unavailable`;
    case "check_failure": return cause.check;
  }
}
export function recoveryIsOpen(episode: RecoveryEpisode): boolean {
  return episode.stage.phase !== "recovered" && episode.stage.phase !== "superseded";
}

/** Closed recovery reducer. Progress and code delivery cannot emit recovery.
 * Only the hub's matched-deployment verifier below can do that. */
export function reduceRecoveryEpisode(previous: RecoveryEpisode | undefined, input: {
  head_sha: string; cause: RecoveryCause; event_id: string; event: RecoveryReducerEvent; actor: string; now: number;
}): RecoveryEpisode {
  const { event, now } = input;
  if (previous?.history.some((h) => h.event_id === input.event_id)) return previous;
  if (previous && event.kind === "observed" && previous.verified_receipts.some((r) =>
      event.source.run_id < r.run_id || (event.source.run_id === r.run_id && event.source.run_attempt <= r.run_attempt))) return previous;
  if (!previous && event.kind !== "observed") throw new Error("recovery must start with observed failure evidence");
  const initialSource = event.kind === "observed" ? [event.source] : [];
  const episode: RecoveryEpisode = previous ? RecoveryEpisodeSchema.parse(previous) : {
    id: recoveryEpisodeKey(input.head_sha, input.cause), head_sha: input.head_sha, cause: input.cause,
    stage: { phase: "diagnosing", task_id: event.task_id, next: event.kind === "observed" ? event.next : "Inspect failure evidence" },
    retry_limit: 1, successful_deployments_required: event.kind === "observed" ? event.successful_deployments_required ?? 1 : 1,
    delivery: { kind: "pending" }, verified_receipts: [], sources: initialSource, attempts: [], history: [], created_at: now, updated_at: now,
  };
  if (episode.stage.phase === "recovered" && event.kind === "observed") {
    const receipt = episode.stage.receipt;
    if (event.source.run_id < receipt.run_id || (event.source.run_id === receipt.run_id && event.source.run_attempt <= receipt.run_attempt)) return episode;
    episode.stage = { phase: "diagnosing", task_id: event.task_id, next: event.next };
    episode.delivery = { kind: "pending" };
  } else if (episode.stage.phase === "recovered" || episode.stage.phase === "superseded") throw new Error("closed recovery episode cannot accept work events");
  if (episode.stage.task_id !== event.task_id) throw new Error("recovery event must name the bound repair task");
  if (episode.history.length >= 500) throw new Error("recovery event history budget exhausted; explicit disposition required");
  let summary = "";
  switch (event.kind) {
    case "executor_assigned":
      episode.stage = episode.stage.phase === "repairing"
        ? { ...episode.stage, next: "Resume the preserved repair and report the next execution step" }
        : { phase: "diagnosing", task_id: event.task_id, next: "Inspect this cause and preserved work, then report the concrete diagnosis and repair action" };
      summary = "Repair executor assigned; assignment is not an execution outcome";
      break;
    case "repair_merged":
      if (!("merge_sha" in episode.delivery) || episode.delivery.merge_sha !== event.merge_sha) episode.verified_receipts = [];
      episode.delivery = { kind: "train_merge", pr: event.pr, merge_sha: event.merge_sha, url: event.url };
      episode.stage = { phase: "verifying", task_id: event.task_id, next: "Observe the merged repair's decisive deployment and complete the verification bar" };
      summary = `Repair PR #${event.pr} merged as ${event.merge_sha.slice(0, 9)}; deployment verification remains pending — ${event.url}`;
      break;
    case "repair_delivery_observed":
      if (!("merge_sha" in episode.delivery) || episode.delivery.merge_sha !== event.merge_sha) episode.verified_receipts = [];
      episode.delivery = { kind: "observed_merge", pr: event.pr, head_sha: event.head_sha, merge_sha: event.merge_sha, url: event.url };
      episode.stage = { phase: "verifying", task_id: event.task_id, next: "Observe the merged repair's decisive deployment and complete the verification bar" };
      summary = `Observed verified repair PR #${event.pr} merged as ${event.merge_sha.slice(0, 9)}; live verification remains pending — ${event.url}`;
      break;
    case "observed": {
      if (event.successful_deployments_required != null) {
        if (event.successful_deployments_required < episode.successful_deployments_required) throw new Error("recovery verification requirement cannot be weakened by an observation");
        episode.successful_deployments_required = event.successful_deployments_required;
      }
      const newFailure = !episode.sources.some((s) => s.run_id === event.source.run_id && s.run_attempt === event.source.run_attempt);
      if (newFailure) {
        episode.sources.push(event.source);
        episode.verified_receipts = [];
        const verifying = episode.attempts.findIndex((a) => a.kind === "verification" && a.status === "running");
        if (verifying >= 0) {
          episode.attempts[verifying] = { ...episode.attempts[verifying], status: "finished", finished_at: now,
            outcome: "failed", summary: "The verification run still reports this failure cause", receipts: [event.source.url] };
          episode.stage = { phase: "diagnosing", task_id: event.task_id, next: "Inspect the failed verification and repair this cause; recovery has not been proven" };
        }
      }
      summary = `Failure observed in run ${event.source.run_id}, attempt ${event.source.run_attempt}`;
      break;
    }
    case "diagnosed":
      episode.stage = { phase: "repairing", task_id: event.task_id, diagnosis: event.diagnosis, next: event.next };
      summary = event.diagnosis;
      break;
    case "attempt_started": {
      if (episode.attempts.some((a) => a.id === event.attempt_id)) throw new Error("recovery attempt already exists");
      if (episode.attempts.some((a) => a.status === "running")) throw new Error("finish the running recovery attempt before starting another");
      if (event.attempt_kind === "retry" && episode.attempts.filter((a) => a.kind === "retry").length >= episode.retry_limit) {
        episode.stage = { phase: "exhausted", task_id: event.task_id, reason: "Retry budget exhausted for this cause and commit", next: "Diagnose and repair the cause; another blind retry is not authorized" };
        summary = "Retry denied: durable per-cause budget exhausted";
        break;
      }
      episode.attempts.push({ id: event.attempt_id, kind: event.attempt_kind, action: event.action, started_at: now, status: "running" });
      episode.stage = event.attempt_kind === "verification"
        ? { phase: "verifying", task_id: event.task_id, next: event.next }
        : { phase: "repairing", task_id: event.task_id, diagnosis: episode.stage.phase === "repairing" ? episode.stage.diagnosis : "Repair action in progress", next: event.next };
      summary = event.action;
      break;
    }
    case "attempt_finished": {
      const index = episode.attempts.findIndex((a) => a.id === event.attempt_id && a.status === "running");
      if (index < 0) throw new Error("recovery outcome requires a running attempt");
      episode.attempts[index] = { ...episode.attempts[index], status: "finished", finished_at: now, outcome: event.outcome, summary: event.summary, receipts: event.receipts };
      episode.stage = event.outcome === "delivered"
        ? { phase: "verifying", task_id: event.task_id, next: "Verify a decisive deployment; code delivery alone is not recovery" }
        : { phase: "diagnosing", task_id: event.task_id, next: event.next };
      summary = `${event.outcome}: ${event.summary}`;
      break;
    }
    case "progress":
      episode.stage = { ...episode.stage, next: event.next };
      summary = event.did;
      break;
    case "delivery_submitted":
      if (episode.delivery.kind === "pending") episode.delivery = { kind: "submitted" };
      episode.stage = { phase: "verifying", task_id: event.task_id, next: "Review the delivered repair, then prove recovery on a decisive deployment" };
      summary = "Repair submitted for verification; live recovery is not yet proven";
      break;
  }
  episode.history.push({ event_id: input.event_id, at: now, actor: input.actor, kind: event.kind, summary });
  episode.updated_at = now;
  return RecoveryEpisodeSchema.parse(episode);
}

/** Called only after the hub matches a successful decisive deployment to
 * the current tip and requires its effective required-check verdict green. */
export function verifyRecoveryEpisode(episode: RecoveryEpisode, receipt: RecoveryReceipt, now: number, repairAccepted = true): RecoveryEpisode {
  if (!recoveryIsOpen(episode)) return episode;
  const repeated = episode.verified_receipts.some((r) => r.run_id === receipt.run_id && r.run_attempt === receipt.run_attempt);
  const verified_receipts = repeated ? episode.verified_receipts : [...episode.verified_receipts, receipt];
  const verified = verified_receipts.length >= episode.successful_deployments_required && repairAccepted;
  if (repeated && !verified) return episode;
  return RecoveryEpisodeSchema.parse({ ...episode,
    verified_receipts,
    stage: verified ? { phase: "recovered", task_id: episode.stage.task_id, next: "No action required", receipt }
      : { phase: "verifying", task_id: episode.stage.task_id, next: verified_receipts.length >= episode.successful_deployments_required
          ? "Deployment evidence meets the bar; independent repair acceptance is still required"
          : `Verify ${episode.successful_deployments_required - verified_receipts.length} more successful decisive deployment(s)` }, updated_at: now,
    history: [...episode.history, { event_id: `${verified ? "verified" : "deployment"}:${receipt.run_id}:${receipt.run_attempt}`, at: now, actor: "system:deployment", kind: verified ? "verified" : "verification_passed", summary: `Successful deployment evidence: ${verified_receipts.length}/${episode.successful_deployments_required} required${repairAccepted ? "" : "; repair acceptance pending"}` }],
  });
}
