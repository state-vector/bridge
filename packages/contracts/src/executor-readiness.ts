import { z } from "zod";
const reason = z.string().min(1);
const held = [
  z.object({ kind: z.literal("unprovisioned"), reason }),
  z.object({ kind: z.literal("repair_required"), reason }),
  z.object({ kind: z.literal("task_prerequisite"), reason }),
  z.object({ kind: z.literal("draining"), reason }),
  z.object({ kind: z.literal("updating"), reason }),
  /** BR#6992 — the gateway cannot claim work because a local resource
   * (disk headroom) is exhausted. Unlike a starved scheduler this is a
   * named, self-clearing fence: the board shows the reason instead of
   * "eligible_work_not_reserved". */
  z.object({ kind: z.literal("resource_held"), reason }),
  z.object({ kind: z.literal("cooldown"), reason, until_ts: z.number() }),
  z.object({ kind: z.literal("paused"), reason, until_ts: z.number() }),
] as const;
export const ExecutorNotReadySchema = z.discriminatedUnion("kind", held);
export const ExecutorReadinessSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), worker_id: z.string().min(1), fingerprint: z.string().min(1) }), ...held,
]);
export type ExecutorReadiness = z.infer<typeof ExecutorReadinessSchema>;
