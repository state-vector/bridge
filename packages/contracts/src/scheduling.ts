import { z } from "zod";

/** A reservation owns a slot, not permission to launch. Fenced begin is still required. */
export const DISPATCH_RESERVATION_MS = 300_000;
export const SchedulingReasonSchema = z.enum([
  "qualification", "operator_gate", "question", "independent_wait", "writer_not_quiescent",
  "unknown_operations", "retry_budget", "host_affinity", "capability", "startup_prerequisite", "lifecycle_gate",
]);
export type SchedulingReason = z.infer<typeof SchedulingReasonSchema>;
export const RecoveryPreemptionSchema = z.object({
  phase: z.enum(["stopping_verification", "slot_available"]), recovery_id: z.string(), victim_id: z.string(),
  generation: z.number().int().positive(), attempt_id: z.string(), session: z.string(), requested_at: z.number(), checkpoint_commit: z.string(),
});
export type RecoveryPreemption = z.infer<typeof RecoveryPreemptionSchema>;
const counts = { host: z.string(), active: z.number(), reserved: z.number(), capacity: z.number(), eligible: z.number(),
  preemption: RecoveryPreemptionSchema.optional(),
  reasons: z.record(z.string(), z.number()), observed_at: z.number() };
export const SchedulingOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reservation_pending"), ...counts, task_id: z.string(), session: z.string() }),
  z.object({ kind: z.literal("reservation_lapsed"), ...counts, task_id: z.string() }),
  z.object({ kind: z.literal("reserved"), ...counts, task_id: z.string(), session: z.string(), expires_at: z.number() }),
  z.object({ kind: z.literal("ready"), ...counts, candidates: z.array(z.string()) }),
  z.object({ kind: z.literal("no_eligible_work"), ...counts }),
  z.object({ kind: z.literal("at_capacity"), ...counts }),
  z.object({ kind: z.literal("gateway_not_ready"), ...counts, reason: z.string() }),
]);
export type SchedulingOutcome = z.infer<typeof SchedulingOutcomeSchema>;
export const SchedulingHealthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("clear") }),
  z.object({ kind: z.literal("waiting"), since: z.number() }),
  z.object({ kind: z.literal("starved"), since: z.number(), reason: z.literal("eligible_work_not_reserved") }),
]);
export type SchedulingHealth = z.infer<typeof SchedulingHealthSchema>;
