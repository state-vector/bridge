import { z } from "zod";
import { BaseRedResolutionSchema, DeployCoverageStateSchema, TrainFixCardSchema } from "./train.ts";
import type { TrainFixCard } from "./train.ts";
import { RecoveryEpisodeSchema, recoveryIsOpen } from "./train-recovery.ts";

/** Runner stream messages prove liveness, not a structured progress report.
 * Keep their raw output available in details, without advertising fragments
 * of internal reasoning as the operator's next action. */
export function repairProgressText(task: TrainFixCard): string {
  const note = task.last_progress?.note?.trim();
  if (note && !note.startsWith("runner:")) return note;
  if (task.last_progress?.will) return `Next: ${task.last_progress.will}`;
  return "Agent session is active; next action has not yet been reported.";
}

const EvidenceSchema = z.object({ name: z.string(), url: z.string().optional() });
const ActionSchema = z.object({ id: z.string(), url: z.string(), question: z.string(), options: z.array(z.string()) });
export const LineRemediationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("machine"), text: z.string(), url: z.string().nullable() }),
  z.object({ kind: z.literal("agent"), text: z.string(), task: TrainFixCardSchema }),
  z.object({ kind: z.literal("queued"), text: z.string(), task: TrainFixCardSchema }),
  z.object({ kind: z.literal("blocked"), text: z.string(), task: TrainFixCardSchema }),
  z.object({ kind: z.literal("human"), text: z.string(), action: ActionSchema }),
  z.object({ kind: z.literal("merge"), text: z.string(), pr: z.number().int().positive(), url: z.string().url(), request: ActionSchema.nullable() }),
  z.object({ kind: z.literal("attention"), text: z.string() }),
]);
export type LineRemediation = z.infer<typeof LineRemediationSchema>;

/** One recovery projection for root repairs, diagnostics and cause journals.
 * Status=todo does not imply dispatchable; blockers are independently owned. */
export function taskRemediation(task: TrainFixCard): LineRemediation {
  const blockers = task.execution_blockers ?? [];
  if (task.status === "todo" && task.preemption && blockers.every(b => b.kind === "capacity_wait")) return {
    kind: "queued", task, text: task.preemption.phase === "stopping_verification"
      ? `Priority recovery: verification ${task.preemption.victim_id} is checkpointing and yielding its slot.`
      : "Priority recovery: its reclaimed slot is available for dispatch.",
  };
  if (blockers.length) return { kind: "blocked", task, text: blockers.map(b => b.text).join(" ") };
  if (task.active_agent) return { kind: "agent", task, text: repairProgressText(task) };
  if (task.status === "blocked") return { kind: "blocked", task, text: task.blocked_reason ?? "The repair is parked; its recorded wait must resolve before execution." };
  return { kind: "queued", task, text: task.status === "in_review" ? "The repair is awaiting independent verification."
    : task.status === "in_progress" ? "The repair has no recent heartbeat; executor recovery is pending."
    : "Recovery is queued; waiting for an eligible executor." };
}
const LineBlockerSchema = z.enum(["main_failed", "deploy_missing", "checks_running", "merge_failed", "no_progress", "human_action", "no_executor", "stale_observation"]);
const LineFields = z.object({
  label: z.string(),
  reason: z.string(),
  evidence: z.array(EvidenceSchema),
  held: z.number().int().nonnegative(),
  observed_at: z.number(),
  recoveries: z.array(z.object({ episode: RecoveryEpisodeSchema, task: TrainFixCardSchema.nullable() })).optional(),
});
/** Closed state machine: healthy/retired cannot carry a blocker, while an
 * interrupted line cannot exist without its cause and recovery disposition. */
export const TrainLineProjectionSchema = z.discriminatedUnion("phase", [
  LineFields.extend({ phase: z.literal("ready"), blocker: z.null(), remediation: z.null() }),
  LineFields.extend({ phase: z.literal("retired"), blocker: z.null(), remediation: z.null() }),
  LineFields.extend({ phase: z.literal("working"), blocker: z.null(), remediation: LineRemediationSchema.nullable() }),
  LineFields.extend({ phase: z.literal("waiting"), blocker: LineBlockerSchema, remediation: LineRemediationSchema }),
  LineFields.extend({ phase: z.literal("stopped"), blocker: LineBlockerSchema, remediation: LineRemediationSchema }),
  LineFields.extend({ phase: z.literal("unknown"), blocker: z.literal("stale_observation"), remediation: LineRemediationSchema }),
]);
export type TrainLineProjection = z.infer<typeof TrainLineProjectionSchema>;

export function withRecoveryEpisodes(line: TrainLineProjection, recoveries: NonNullable<TrainLineProjection["recoveries"]>): TrainLineProjection {
  const open = recoveries.filter((r) => recoveryIsOpen(r.episode));
  // The cause-bound repair is authoritative over historical starvation or
  // generic diagnostic duties. Keep actual human requirements intact.
  if (line.phase === "stopped" && line.blocker === "main_failed" && line.remediation.kind !== "human" && line.remediation.kind !== "merge") {
    const ranked = open.filter((r) => r.task && r.task.status !== "done" && r.task.status !== "superseded")
      .sort((a, b) => Number(!!b.task?.active_agent) - Number(!!a.task?.active_agent)
        || Number(a.episode.cause.kind === "check_failure") - Number(b.episode.cause.kind === "check_failure")
        || b.episode.updated_at - a.episode.updated_at);
    const repair = ranked[0];
    if (repair?.task) return TrainLineProjectionSchema.parse({ ...line, recoveries, remediation: taskRemediation(repair.task) });
  }
  if (open.length && line.phase === "ready") return TrainLineProjectionSchema.parse({ ...line, recoveries,
    phase: "waiting", label: "Verifying recovery", blocker: "checks_running",
    reason: "Repair work is not yet proven recovered by a matching successful deployment.",
    remediation: { kind: "machine", text: "Waiting for the current tip's successful decisive deployment receipt, not just task completion.", url: null },
  });
  return TrainLineProjectionSchema.parse({ ...line, recoveries });
}

/** One boundary adapter for legacy executor facts. The UI consumes only the
 * projection; it never arbitrates between these independent observations. */
export const TrainLineFactsSchema = z.object({
  retired: z.boolean().optional(),
  queue: z.array(z.object({ id: z.string() })).default([]),
  currently: z.object({ phase: z.string().optional(), pr: z.number().nullable().optional() }).nullable().optional(),
  stop: z.object({ reason: z.string().optional(), failing: z.array(EvidenceSchema).optional() }).nullable().optional(),
  lease: z.object({ holder: z.string(), heartbeat_ts: z.number() }).nullable().optional(),
  capable: z.object({ holder: z.string(), at: z.number(), ready: z.boolean() }).nullable().optional(),
  queue_facts: z.object({
    at: z.number(),
    base_state: z.object({
      verdict: z.enum(["green", "red", "unsettled", "empty"]),
      red: z.array(EvidenceSchema).optional(), unsettled: z.array(z.string()).optional(),
      gate_blocked: z.boolean().optional(), gate_red: z.array(EvidenceSchema).optional(), gate_unsettled: z.array(z.string()).optional(),
      deploy_coverage: DeployCoverageStateSchema.nullable().optional(),
    }).optional(),
    stalled: z.object({ last_error: z.string().nullable().optional() }).optional(),
  }).nullable().optional(),
  base_red_resolution: BaseRedResolutionSchema.nullable().optional(),
  diagnostic: TrainFixCardSchema.nullable().optional(),
  diagnostic_ask: ActionSchema.nullable().optional(),
  starved: z.object({ since: z.number() }).nullable().optional(),
  bypass_wait: z.object({ pr: z.number() }).nullable().optional(),
  attempt: z.object({ note: z.string(), hold: z.string() }).nullable().optional(),
});
export type TrainLineFacts = z.infer<typeof TrainLineFactsSchema>;

/** Total, pure presentation reducer. This is the only precedence law for the
 * status, reason, message and banner. Unknown/stale never turns into ready. */
export function projectTrainLine(f: TrainLineFacts, now: number): TrainLineProjection {
  const q = f.queue_facts;
  const bs = q?.base_state;
  const cov = bs?.deploy_coverage;
  const fresh = !!q && now - q.at < 15 * 60_000;
  const task = f.base_red_resolution?.fix_card ?? f.diagnostic;
  const gatePending = bs?.gate_blocked && bs.gate_red?.length === 0 && !!bs.gate_unsettled?.length;
  // A starvation prompt is not a concrete human requirement for a failed
  // deployment. Prefer the cause-bound repair's actual human action only.
  const mainFailed = bs?.verdict === "red" || (bs?.gate_blocked && !gatePending) || cov?.phase === "failed" || !!f.stop;
  const ask = f.base_red_resolution?.ask ?? (mainFailed ? null : f.diagnostic_ask);
  const make = (phase: TrainLineProjection["phase"], label: string, reason: string,
    blocker: TrainLineProjection["blocker"] = null, evidence: TrainLineProjection["evidence"] = [],
    remediation: LineRemediation | null = null): TrainLineProjection => ({
    ...TrainLineProjectionSchema.parse({ phase, label, reason, blocker, evidence, held: f.queue.length, observed_at: q?.at ?? 0, remediation }),
  });
  const repair = (): LineRemediation => {
    if (f.base_red_resolution?.phase === "cure_pr_awaiting_force_merge" && task?.pr && task.pr_url && !task.merged && !task.conflict) return {
      kind: "merge", text: `Bypass-merge fix PR #${task.pr} to unblock this line. Main's failing deployment check prevents the automatic merge.`,
      pr: task.pr, url: task.pr_url, request: ask ?? null,
    };
    if (ask) return { kind: "human", text: task?.pr && !task.merged
      ? `Merge repair PR #${task.pr}, then choose DONE in the request. Main's failing checks prevent the automatic merge.`
      : ask.question, action: ask };
    if (task?.execution_blockers?.length) return taskRemediation(task);
    if (task?.active_agent) return taskRemediation(task);
    if (task && (task.status === "todo" || task.status === "in_review")) return {
      kind: "queued", text: task.status === "todo" ? "Repair is queued at top priority; waiting for an available agent." : "The repair is awaiting independent verification.", task,
    };
    return { kind: "attention", text: task
      ? `Repair ${task.id} is not actively progressing. ${task.blocked_reason ?? "No recent agent heartbeat."}`
      : "Automatic recovery has no active repair task. The recovery monitor must assign one; work remains held." };
  };
  if (f.retired) return make("retired", "retired", "This line is retired.");
  if ((fresh && (bs?.verdict === "red" || (bs?.gate_blocked && !gatePending) || cov?.phase === "failed")) || f.stop) {
    const failure = cov?.phase === "failed" ? [{ name: `Deploy Dev${cov.failing_run_id ? ` run #${cov.failing_run_id}` : ""}`, ...(cov.failing_run_url ? { url: cov.failing_run_url } : {}) }] : [];
    const evidence = fresh ? [...(bs?.gate_blocked ? bs.gate_red ?? [] : bs?.red ?? f.stop?.failing ?? []), ...failure] : f.stop?.failing ?? [];
    const names = evidence.map((e) => e.name).join(", ");
    const action = repair();
    return make("stopped", action.kind === "merge" ? "Fix ready — your merge is needed" : "STOP THE LINE — main is failing", `${names ? `Main failed: ${names}. ` : ""}New changes are held until main passes its required checks.`, "main_failed", evidence, action);
  }
  if (q && !fresh && (f.queue.length || f.currently || bs?.verdict !== "green" || bs?.gate_blocked)) return make(
    "unknown", "Status is out of date", "The last check is over 15 minutes old. Main has not been confirmed healthy.", "stale_observation", [], repair());
  if (fresh && gatePending) return make("waiting", "Waiting for required checks",
    `The merge gate is waiting for: ${bs.gate_unsettled!.join(", ")}. No gate check has failed.`, "checks_running", [],
    { kind: "machine", text: "The executor rechecks automatically when these checks settle.", url: null });
  if (fresh && cov?.phase === "settling") return make("waiting", "Build and deployment running",
    "The deployment is running. Changes resume automatically when required checks pass.", "checks_running", [],
    { kind: "machine", text: `Watching deployment${cov.active_run_id ? ` #${cov.active_run_id}` : ""}.`, url: cov.active_run_url ?? null });
  if (fresh && (cov?.phase === "uncovered_grace" || cov?.phase === "uncovered_dispatched")) return make(
    "waiting", cov.phase === "uncovered_dispatched" ? "Deployment requested" : "Waiting for deployment to start",
    "Changes are held while deployment starts.", "checks_running", [], { kind: "machine", text: cov.phase === "uncovered_dispatched"
      ? "Deployment requested automatically; watching for it to start."
      : "Watching for the push-triggered deployment; the executor requests it automatically after the five-minute start window.", url: null });
  if (fresh && bs?.verdict === "empty") return make("stopped", "Deployment has not started",
    "Main has no covering deployment. Changes are held while the executor attempts recovery.", "deploy_missing", [], repair());
  if (f.bypass_wait) return make("stopped", "Your action is needed",
    `PR #${f.bypass_wait.pr} cannot be merged automatically.`, "human_action", [], repair());
  if (fresh && q?.stalled) return make("stopped", "Queued PRs cannot merge",
    "GitHub rejected the selected PR merges. The executor must reconcile branch policy and required checks before retrying.", "merge_failed", [],
    ask ? { kind: "human", text: ask.question, action: ask }
      : { kind: "attention", text: "Bridge must repair the rejected merge. No bypass-merge request has been issued for this failure." });
  if (f.starved) return make("stopped", "Work is not moving",
    "Changes have waited over an hour without a merge.", "no_progress", [], repair());
  if (f.currently) return make(f.currently.phase === "bursting" ? "working" : "waiting",
    f.currently.phase === "bursting" ? "Merging changes" : "Waiting for checks and deployment",
    `Watching main after PR #${f.currently.pr ?? "?"}.`, f.currently.phase === "bursting" ? null : "checks_running", [],
    { kind: "machine", text: "Checking the merged changes; the next batch starts automatically after required checks pass.", url: null });
  if (fresh && bs?.verdict === "unsettled") return make("waiting", "Required checks are running",
    (bs.unsettled ?? []).join(", ") || "Waiting for main's required checks.", "checks_running", [],
    { kind: "machine", text: "Watching required checks; changes resume automatically when they pass.", url: null });
  const executorLive = !!(f.lease && now - f.lease.heartbeat_ts < 5 * 60_000) || !!(f.capable?.ready && now - f.capable.at < 15 * 60_000);
  if (!executorLive && f.queue.length) return make("stopped", "No executor is active",
    "Changes are waiting, but no machine is processing this line.", "no_executor", [], repair());
  if (f.attempt && f.queue.length) return make("working", "Checking queued changes", f.attempt.note);
  return make("ready", executorLive ? "ready" : "idle", executorLive ? "An executor is available for the next change." : "No queued changes.");
}
