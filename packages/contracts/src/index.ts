/**
 * @bridge/contracts — the single source for every cross-runtime shape.
 *
 * One package, zod-only, imported by the hub worker, tested against
 * checked-in production fixtures, and mirrored by the Rust runner through
 * those fixtures (BR#2844). Change a shape here, update the fixture AND
 * every consumer in the same PR — CI enforces it.
 */
export * from "./orient.ts";
export * from "./mcp.ts";
export * from "./table.ts";
export * from "./pairing.ts";
export * from "./provision.ts";
export * from "./ask.ts";
export * from "./review.ts";
export * from "./delivery.ts";
export * from "./work.ts";
export * from "./config.ts";
export * from "./train.ts";
export * from "./executor-readiness.ts";
export * from "./train-checks.ts";
export * from "./train-line.ts";
export * from "./train-scan.ts";
export * from "./train-recovery.ts";
export * from "./execution.ts";
export * from "./scheduling.ts";
export * from "./startup.ts";
export * from "./execution-availability.ts";
export * from "./runner-update.ts";
export * from "./model-policy.ts";
export * from "./execution-observability.ts";
export * from "./hub-diagnostics.ts";
export { WorkerStatusSchema, currentWorkerStatus, WorkerSlotSchema, WorkerOccupancySchema, currentWorkerOccupancy, type WorkerStatus, type WorkerSlot, type WorkerOccupancy } from "./worker-status.ts";

export type { AwaitEvent, WorkWait } from "./work-wait.ts";
