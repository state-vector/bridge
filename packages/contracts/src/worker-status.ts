import { z } from "zod";

/** Read-only fleet projection; readiness and occupancy come from the scheduler. */
export const WorkerStatusSchema = z.object({
  host: z.string(), observed_at: z.number(),
  state: z.enum(["ready", "busy", "offline", "draining", "unavailable"]),
  reason: z.string(), active: z.number(), reserved: z.number(), capacity: z.number(),
});
export type WorkerStatus = z.infer<typeof WorkerStatusSchema>;

export function currentWorkerStatus(worker: WorkerStatus, now: number): WorkerStatus {
  return now - worker.observed_at >= 120_000
    ? { ...worker, state: "offline", reason: "Worker heartbeat is stale." } : worker;
}
