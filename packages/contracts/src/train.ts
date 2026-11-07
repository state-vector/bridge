/**
 * @bridge/contracts/train — canonical strong types and closed state machines
 * for the serialized merge train (BR#6012).
 *
 * Eliminates split-brain and `any` casts across the hub (`core.ts`/`do.ts`),
 * the UI (`kb.ts`/`TrainPanel.tsx`), and the Rust executor (`train.rs`/`train_gate.rs`).
 */
import { z } from "zod";
import { RecoveryCauseSchema } from "./train-recovery.ts";
import { ExecutionBlockerSchema } from "./execution.ts";
import { RecoveryPreemptionSchema } from "./scheduling.ts";

export const TrainEntryClassSchema = z.enum([
  "ready",
  "waiting",
  "conflict",
  "needs-review",
  "blocked",
]);
export type TrainEntryClass = z.infer<typeof TrainEntryClassSchema>;

export const BaseRedPhaseSchema = z.enum([
  "diagnosing",
  "fix_in_progress",
  "cure_pr_conflicting",
  "cure_pr_merged_awaiting_ci",
  "cure_pr_awaiting_force_merge",
  "fix_exhausted",
]);
export type BaseRedPhase = z.infer<typeof BaseRedPhaseSchema>;

export const TrainFixCardProgressSchema = z.object({
  note: z.string(),
  will: z.string().optional(),
  completion_pct: z.number().int().min(0).max(100).optional(),
  ts: z.number(),
});
export type TrainFixCardProgress = z.infer<typeof TrainFixCardProgressSchema>;

export const TrainFixCardSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  status: z.string(),
  owner: z.string().optional(),
  executor_session: z.string().optional(),
  active_agent: z.boolean().optional(),
  blocked_reason: z.string().optional(),
  execution_blockers: z.array(ExecutionBlockerSchema).optional(),
  preemption: RecoveryPreemptionSchema.optional(),
  last_progress: TrainFixCardProgressSchema.nullable().optional(),
  pr: z.number().int().positive().optional(),
  pr_url: z.string().optional(),
  conflict: z.boolean().optional(),
  merged: z.boolean().optional(),
  merge_sha: z.string().optional(),
});
export type TrainFixCard = z.infer<typeof TrainFixCardSchema>;

export const BaseRedResolutionAskSchema = z.object({
  id: z.string(),
  url: z.string(),
  question: z.string(),
  options: z.array(z.string()),
});
export type BaseRedResolutionAsk = z.infer<typeof BaseRedResolutionAskSchema>;

/** BR#6179 level-based deploy coverage closed state machine:
 *  Explicit 6-state discriminated union on `phase` representing whether the
 *  base tip commit (`tip_sha`) is covered by a decisive deploy workflow run,
 *  settling in flight, inside the initial push-trigger grace window,
 *  auto-dispatched by the executor, stranded dark past grace, or failed. */
export const DeployCoverageStateSchema = z.discriminatedUnion("phase", [
  z.object({
    phase: z.literal("covered"),
    tip_sha: z.string(),
    tip_age_secs: z.number().int().nonnegative(),
    covered_by_sha: z.string(),
    covered_by_run_id: z.number().int().positive().nullable().optional(),
    covered_by_url: z.string().nullable().optional(),
  }),
  z.object({
    phase: z.literal("settling"),
    tip_sha: z.string(),
    tip_age_secs: z.number().int().nonnegative(),
    active_run_id: z.number().int().positive().nullable().optional(),
    active_run_url: z.string().nullable().optional(),
    last_green_sha: z.string().nullable().optional(),
    last_green_run_id: z.number().int().positive().nullable().optional(),
  }),
  z.object({
    phase: z.literal("uncovered_grace"),
    tip_sha: z.string(),
    tip_age_secs: z.number().int().nonnegative(),
    grace_secs: z.number().int().positive(),
    workflow: z.string().nullable().optional(),
    last_green_sha: z.string().nullable().optional(),
    last_green_run_id: z.number().int().positive().nullable().optional(),
  }),
  z.object({
    phase: z.literal("uncovered_dispatched"),
    tip_sha: z.string(),
    tip_age_secs: z.number().int().nonnegative(),
    workflow: z.string(),
    dispatched_at: z.number().int().nonnegative(),
    last_green_sha: z.string().nullable().optional(),
    last_green_run_id: z.number().int().positive().nullable().optional(),
  }),
  z.object({
    phase: z.literal("uncovered_dark"),
    tip_sha: z.string(),
    tip_age_secs: z.number().int().nonnegative(),
    grace_secs: z.number().int().positive(),
    workflow: z.string().nullable().optional(),
    last_green_sha: z.string().nullable().optional(),
    last_green_run_id: z.number().int().positive().nullable().optional(),
    reason: z.string(),
  }),
  z.object({
    phase: z.literal("failed"),
    tip_sha: z.string(),
    tip_age_secs: z.number().int().nonnegative(),
    failing_run_id: z.number().int().positive().nullable().optional(),
    failing_run_url: z.string().nullable().optional(),
    last_green_sha: z.string().nullable().optional(),
    last_green_run_id: z.number().int().positive().nullable().optional(),
  }),
]);
export type DeployCoverageState = z.infer<typeof DeployCoverageStateSchema>;
export type DeployCoveragePhase = DeployCoverageState["phase"];

/** Read-only GitHub observation, independent of the merge executor's lease.
 * The hub alone reduces observations into line health and recovery work. */
export const DeployObservationSchema = z.object({
  tip_sha: z.string().regex(/^[0-9a-f]{40}$/),
  observed_at: z.number().int().positive(),
  failures: z.array(z.object({ run_id: z.number().int().positive(), name: z.string().min(1), url: z.string().url(),
    cause: RecoveryCauseSchema.optional(), repair_task_id: z.string().regex(/^BR#\d+$/).optional(),
  })).max(100).optional(),
  runs: z.array(z.object({
    id: z.number().int().positive(), name: z.string(), path: z.string().optional(),
    run_attempt: z.number().int().positive().optional(),
    head_sha: z.string().regex(/^[0-9a-f]{40}$/),
    status: z.enum(["queued", "waiting", "pending", "requested", "in_progress", "completed"]),
    // GitHub reports conclusion: null while a run is queued/in_progress, and the
    // Rust runner's `skip_serializing_if` OMITS the key for None — so the key may
    // legitimately be absent (in-flight run). `.default(null)` accepts the missing
    // key and normalizes to null, keeping the parsed type `string | null` exactly
    // as before (2026-11-05 incident: whole observations rejected with a misleading
    // invalid_value whenever a deploy run was in flight).
    conclusion: z.enum(["success", "failure", "cancelled", "skipped", "timed_out", "action_required", "neutral", "startup_failure", "stale"]).nullish().default(null),
    html_url: z.string().url(),
  })).min(1).max(100),
});
export type DeployObservation = z.infer<typeof DeployObservationSchema>;

export const BaseRedResolutionSchema = z.object({
  verdict: z.enum(["red", "unsettled", "empty"]),
  phase: BaseRedPhaseSchema,
  whats_broken: z.array(
    z.object({
      name: z.string(),
      url: z.string().optional(),
    }),
  ),
  held: z.number().int().nonnegative(),
  ask: BaseRedResolutionAskSchema.nullable(),
  fix_card: TrainFixCardSchema.nullable(),
  deploy_coverage: DeployCoverageStateSchema.nullable().optional(),
});
export type BaseRedResolution = z.infer<typeof BaseRedResolutionSchema>;

/** Canonical 4-state operational state machine for a merge lane (BR#6012):
 *  stored atomically in the `lane_state` SQLite table so the hub and UI never
 *  reconstruct lane state from contradictory fragments. */
export const LaneOperationalStateSchema = z.discriminatedUnion("phase", [
  z.object({
    phase: z.literal("idle"),
    updated_ts: z.number(),
  }),
  z.object({
    phase: z.literal("draining_batch"),
    pr: z.number().int().positive(),
    merge_sha: z.string(),
    task_id: z.string().nullable(),
    burst_merged: z.number().int().nonnegative(),
    burst_cap: z.number().int().nonnegative(),
    updated_ts: z.number(),
  }),
  z.object({
    phase: z.literal("settling_ci"),
    pr: z.number().int().positive(),
    merge_sha: z.string(),
    task_id: z.string().nullable(),
    merged_at: z.number(),
    updated_ts: z.number(),
  }),
  z.object({
    phase: z.literal("stopped_red"),
    failing_sha: z.string(),
    failing_checks: z.array(
      z.object({
        name: z.string(),
        url: z.string().optional(),
      }),
    ),
    culprit_task: z.string().nullable(),
    episode_phase: BaseRedPhaseSchema,
    fix_card: TrainFixCardSchema.nullable(),
    updated_ts: z.number(),
  }),
]);
export type LaneOperationalState = z.infer<typeof LaneOperationalStateSchema>;

/** Versioned canonical persistence envelope. Producer facts retain the rolling
 * wire format; the operational lifecycle remains the closed union above. */
export const LaneSnapshotSchema = z.object({
  schema_version: z.literal(1), lane_id: z.string().min(1), revision: z.number().int().positive(),
  operational: LaneOperationalStateSchema,
  facts: z.object({
    lane: z.looseObject({ key: z.string().min(1), repo: z.string().min(1), base: z.string().min(1) }),
    lease: z.object({ holder: z.string().min(1), heartbeat_ts: z.number(), expires_ts: z.number() }).nullable().optional(),
    currently: z.unknown().optional(), stop: z.unknown().optional(), bypass_wait: z.unknown().optional(),
    zombie: z.unknown().optional(), blocked: z.unknown().optional(),
  }),
});
export type LaneSnapshot = z.infer<typeof LaneSnapshotSchema>;

// ---- BR#6330: one merge classification — the typed card phase is the single source ----

/** The closed lifecycle of a card's merge-train slot, `meta.merge_train.state`.
 *  This field is THE single source of "is this card awaiting merge" — every
 *  reader (hub queue derivation, watchdog holds, UI Backlog grouping) asks
 *  this one field via mergePhaseOf/isAwaitingMerge; nothing classifies a
 *  card into the merge class from prose reasons, note prefixes, or the
 *  pr_merged await_event (that typed wait remains the machine LEG the train
 *  flips — it is not a display classification).
 *
 *  Only train machinery writes it: accept → queued, train:merged →
 *  awaiting-ci, landed/burst-settle/merged-park-heal → landed (card closes),
 *  bounce → bounced, CONFLICTING gate verdict → conflicting (BR#6348 typed
 *  park), Awaiting force-review park → awaiting, lane unbind → unbound.
 *  `base-red-park` is reserved for the merge-ladder base-red park (no writer
 *  yet — the executor stamps it when the ladder parks a card on a base-fix
 *  task). Legacy spellings normalise through MergeTrainPhaseSchema. */
export const MergeTrainPhaseSchema = z.enum([
  "queued",
  "awaiting-ci",
  "bounced",
  "conflicting",
  "awaiting",
  "unbound",
  "base-red-park",
  "landed",
]);
export type MergeTrainPhase = z.infer<typeof MergeTrainPhaseSchema>;

/** The phases that make a blocked card "Awaiting PR merge — train": it holds
 *  a live slot the serialized train owns (queued) or its PR already merged
 *  and main is settling (awaiting-ci — the heal sweep closes these on the
 *  provenance receipt). Everything else is NOT awaiting merge. */
export const AWAITING_MERGE_PHASES: readonly [MergeTrainPhase, MergeTrainPhase] = ["queued", "awaiting-ci"];

/** meta.merge_train.state → the closed phase, null when absent/legacy-unknown.
 *  Accepts the pending "awaiting-ci" spelling and normalises nothing else —
 *  an unrecognised value is a data bug to surface, not paper over. */
export function mergePhaseOf(meta: unknown): MergeTrainPhase | null {
  const mt = (meta as any)?.merge_train;
  const st = typeof mt?.state === "string" ? mt.state : "";
  if (!st) return null;
  const parsed = MergeTrainPhaseSchema.safeParse(st);
  return parsed.success ? parsed.data : null;
}

/** THE one predicate (BR#6330): is this card awaiting merge on the train?
 *  Pure function of the typed phase — no prose, no await_event inference. */
export function isAwaitingMerge(meta: unknown): boolean {
  const p = mergePhaseOf(meta);
  return p === AWAITING_MERGE_PHASES[0] || p === AWAITING_MERGE_PHASES[1];
}
