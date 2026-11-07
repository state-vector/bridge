import { z } from "zod";
import { ExecutorReadinessSchema } from "./executor-readiness.ts";

const attempt = { task_id: z.string(), generation: z.number(), attempt_id: z.string(), session: z.string(),
  phase: z.enum(["running", "restoring", "stopping"]), lease_until: z.number(), action_deadline: z.number(), task_status: z.string() };
/** A capacity charge is not proof of an OS process. Only the host can prove stop. */
export const WorkerSlotSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("leased"), ...attempt }),
  z.object({ kind: z.literal("unconfirmed"), ...attempt,
    reason: z.enum(["lease_expired", "action_expired", "claim_changed"]) }),
  z.object({ kind: z.literal("starting"), task_id: z.string(), session: z.string(), expires_at: z.number().nullable() }),
]);
export type WorkerSlot = z.infer<typeof WorkerSlotSchema>;
export const WorkerOccupancySchema = z.object({ leased: z.number(), starting: z.number(), unconfirmed: z.number(), held: z.number(), slots: z.array(WorkerSlotSchema) });
export type WorkerOccupancy = z.infer<typeof WorkerOccupancySchema>;
export function currentWorkerOccupancy(slots: WorkerSlot[], now: number): WorkerOccupancy {
  const current: WorkerSlot[] = slots.map(slot => slot.kind !== "leased" ? slot
    : slot.lease_until <= now ? { ...slot, kind: "unconfirmed", reason: "lease_expired" }
    : slot.action_deadline <= now ? { ...slot, kind: "unconfirmed", reason: "action_expired" } : slot);
  return { leased: current.filter(s => s.kind === "leased").length, starting: current.filter(s => s.kind === "starting").length,
    unconfirmed: current.filter(s => s.kind === "unconfirmed").length, held: current.length, slots: current };
}

/** Read-only fleet projection; readiness and occupancy come from the scheduler. */
export const WorkerStatusSchema = z.object({
  host: z.string(), observed_at: z.number(),
  state: z.enum(["ready", "busy", "offline", "draining", "unavailable"]),
  reason: z.string(), active: z.number(), reserved: z.number(), capacity: z.number(),
  // Optional only for a rolling deployment from the older aggregate-only publisher.
  occupancy: WorkerOccupancySchema.optional(),
  readiness: ExecutorReadinessSchema.optional(),
});
export type WorkerStatus = z.infer<typeof WorkerStatusSchema>;

export function currentWorkerStatus(worker: WorkerStatus, now: number): WorkerStatus {
  if (worker.occupancy) worker = { ...worker, occupancy: currentWorkerOccupancy(worker.occupancy.slots, now) };
  return now - worker.observed_at >= 120_000
    ? { ...worker, state: "offline", reason: "Worker heartbeat is stale." } : worker;
}
