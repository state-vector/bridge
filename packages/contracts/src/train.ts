/**
 * @bridge/contracts/train — canonical strong types and closed state machines
 * for the serialized merge train (BR#6012).
 *
 * Eliminates split-brain and `any` casts across the hub (`core.ts`/`do.ts`),
 * the UI (`kb.ts`/`TrainPanel.tsx`), and the Rust executor (`train.rs`/`train_gate.rs`).
 */
import { z } from "zod";

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

export const TrainFixCardSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  status: z.string(),
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
