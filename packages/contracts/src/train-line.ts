import { z } from "zod";
import { BaseRedResolutionSchema, DeployCoverageStateSchema, TrainFixCardSchema } from "./train.ts";

const EvidenceSchema = z.object({ name: z.string(), url: z.string().optional() });
const ActionSchema = z.object({ id: z.string(), url: z.string(), question: z.string(), options: z.array(z.string()) });
export const LineRemediationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("machine"), text: z.string(), url: z.string().nullable() }),
  z.object({ kind: z.literal("agent"), text: z.string(), task: TrainFixCardSchema }),
  z.object({ kind: z.literal("queued"), text: z.string(), task: TrainFixCardSchema }),
  z.object({ kind: z.literal("human"), text: z.string(), action: ActionSchema }),
  z.object({ kind: z.literal("attention"), text: z.string() }),
]);
export type LineRemediation = z.infer<typeof LineRemediationSchema>;
const LineBlockerSchema = z.enum(["main_failed", "deploy_missing", "checks_running", "merge_failed", "no_progress", "human_action", "no_executor", "stale_observation"]);
const LineFields = z.object({
  label: z.string(),
  reason: z.string(),
  evidence: z.array(EvidenceSchema),
  held: z.number().int().nonnegative(),
  observed_at: z.number(),
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
      gate_blocked: z.boolean().optional(), gate_red: z.array(EvidenceSchema).optional(),
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
  // A starvation prompt is not a concrete human requirement for a failed
  // deployment. Prefer the cause-bound repair's actual human action only.
  const mainFailed = bs?.verdict === "red" || bs?.gate_blocked || cov?.phase === "failed" || !!f.stop;
  const ask = f.base_red_resolution?.ask ?? (mainFailed ? null : f.diagnostic_ask);
  const make = (phase: TrainLineProjection["phase"], label: string, reason: string,
    blocker: TrainLineProjection["blocker"] = null, evidence: TrainLineProjection["evidence"] = [],
    remediation: LineRemediation | null = null): TrainLineProjection => ({
    ...TrainLineProjectionSchema.parse({ phase, label, reason, blocker, evidence, held: f.queue.length, observed_at: q?.at ?? 0, remediation }),
  });
  const repair = (): LineRemediation => {
    if (ask) return { kind: "human", text: task?.pr && !task.merged
      ? `Merge repair PR #${task.pr}, then choose DONE in the request. Main's failing checks prevent the automatic merge.`
      : `Automatic repair is stuck${task?.blocked_reason ? `: ${task.blocked_reason}` : "."} Provide the missing access or repair instructions in the request.`, action: ask };
    if (task?.active_agent) return { kind: "agent", text: task.last_progress?.note ?? "An agent is investigating the failure.", task };
    if (task && (task.status === "todo" || task.status === "in_review")) return {
      kind: "queued", text: task.status === "todo" ? "Repair is queued at top priority; waiting for an available agent." : "The repair is awaiting independent verification.", task,
    };
    return { kind: "attention", text: task
      ? `Repair ${task.id} is not actively progressing. ${task.blocked_reason ?? "No recent agent heartbeat."}`
      : "Automatic recovery has no active repair task. The recovery monitor must assign one; work remains held." };
  };
  if (f.retired) return make("retired", "retired", "This line is retired.");
  if ((fresh && (bs?.verdict === "red" || bs?.gate_blocked || cov?.phase === "failed")) || f.stop) {
    const failure = cov?.phase === "failed" ? [{ name: `Deploy Dev${cov.failing_run_id ? ` run #${cov.failing_run_id}` : ""}`, ...(cov.failing_run_url ? { url: cov.failing_run_url } : {}) }] : [];
    return make("stopped", "STOP THE LINE — main is failing", "New changes are held until main passes its required checks.", "main_failed",
      fresh ? [...(bs?.gate_blocked ? bs.gate_red ?? [] : bs?.red ?? f.stop?.failing ?? []), ...failure] : f.stop?.failing ?? [], repair());
  }
  if (q && !fresh && (f.queue.length || f.currently || bs?.verdict !== "green")) return make(
    "unknown", "Status is out of date", "The last check is over 15 minutes old. Main has not been confirmed healthy.", "stale_observation", [], repair());
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
  if (fresh && q?.stalled) return make("stopped", "Merges are failing",
    q.stalled.last_error ?? "Merge attempts are not landing.", "merge_failed", [], repair());
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
