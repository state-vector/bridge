import { z } from "zod";

export const HubRequestStageSchema = z.enum(["schema", "alarm", "body", "dispatch", "readiness", "inventory", "board", "capability.maintenance", "startup.maintenance", "task.maintenance", "review.maintenance", "train.maintenance"]);
const Timing = z.object({ id: z.string(), operation: z.string(), started_at: z.number(), elapsed_ms: z.number().nonnegative(), ingress_ms: z.number().nonnegative(),
  stage: HubRequestStageSchema, stages: z.array(z.object({ stage: HubRequestStageSchema, elapsed_ms: z.number().nonnegative() })) });
export const HubRequestTimingSchema = z.discriminatedUnion("phase", [
  Timing.extend({ phase: z.literal("active") }),
  Timing.extend({ phase: z.literal("completed"), status: z.number().int() }),
]);
export const HubDiagnosticsSchema = z.object({
  observed_at: z.number(), instance_id: z.string(), started_at: z.number(),
  active: z.array(HubRequestTimingSchema), recent: z.array(HubRequestTimingSchema),
  operations: z.array(z.object({ operation: z.string(), count: z.number(), errors: z.number(), max_ms: z.number(), total_ms: z.number(), max_ingress_ms: z.number().default(0) })),
});
export type HubRequestStage = z.infer<typeof HubRequestStageSchema>;
export type HubRequestTiming = z.infer<typeof HubRequestTimingSchema>;
export type HubDiagnostics = z.infer<typeof HubDiagnosticsSchema>;
