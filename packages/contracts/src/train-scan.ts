import { z } from "zod";

/** A saved position only, never permission to merge. Every visited PR still
 * needs a fresh review/check/base decision after a restart or handoff. */
export const TrainQueueScanSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("complete") }),
  z.object({ phase: z.literal("checking"), after_id: z.string().min(1) }),
]);
export type TrainQueueScan = z.infer<typeof TrainQueueScanSchema>;
