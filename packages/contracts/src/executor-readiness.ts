import { z } from "zod";
const reason = z.string().min(1);
const held = [
  z.object({ kind: z.literal("unprovisioned"), reason }),
  z.object({ kind: z.literal("repair_required"), reason }),
  z.object({ kind: z.literal("task_prerequisite"), reason }),
  z.object({ kind: z.literal("draining"), reason }),
  z.object({ kind: z.literal("updating"), reason }),
  z.object({ kind: z.literal("cooldown"), reason, until_ts: z.number() }),
  z.object({ kind: z.literal("paused"), reason, until_ts: z.number() }),
] as const;
export const ExecutorNotReadySchema = z.discriminatedUnion("kind", held);
export const ExecutorReadinessSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), worker_id: z.string().min(1), fingerprint: z.string().min(1) }), ...held,
]);
export type ExecutorReadiness = z.infer<typeof ExecutorReadinessSchema>;
