import { z } from "zod";

/** A PR may DELIVER work or merely enable its execution. Only delivery can
 * complete a task on a merge receipt. Execution always needs outcome receipts. */
export const CompletionContractSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("delivery") }),
  z.object({ kind: z.literal("execution"), outcome: z.string().min(1) }),
]);
export type CompletionContract = z.infer<typeof CompletionContractSchema>;
export function completionContract(meta: { completion?: unknown; depends_on?: unknown }): CompletionContract {
  if (meta.completion !== undefined) return CompletionContractSchema.parse(meta.completion);
  // Legacy prerequisite markers are not delivery evidence. Do not parse their
  // prose or infer completion from an incidental PR reference in a review note.
  return meta.depends_on ? { kind: "execution", outcome: "Execute the work after its prerequisites are satisfied." } : { kind: "delivery" };
}
export function mergeCompletesTask(meta: { completion?: unknown; depends_on?: unknown }): boolean {
  return completionContract(meta).kind === "delivery";
}

export const ExecutionResultSchema = z.object({
  outcome: z.string().min(1),
  receipts: z.array(z.string().min(1)).min(1),
});

/** Persistable command receipt for clients that cannot yet carry the newer
 * transition argument. Consumption still uses the SAME human-authority gate. */
export const DispositionRequestSchema = z.object({
  kind: z.literal("apply_authorized_supersede"),
  ask: z.string().regex(/^BR#\d+$/),
});

export const RecoveryReasonSchema = z.enum(["queue_binding", "conflict", "execution_environment"]);
export type RecoveryReason = z.infer<typeof RecoveryReasonSchema>;
export type RecoveryPlan =
  | { kind: "none" }
  | { kind: "owned"; text: string }
  | { kind: "restore_queue" }
  | { kind: "dispatch"; reason: RecoveryReason };

/** Current lifecycle owns recovery; historical merge metadata cannot overrule
 * active execution, review, or an upstream dependency. No human outcome exists. */
export function planTaskRecovery(input: {
  status: string; phase: string | null; live_executor: boolean;
  queue_admitted: boolean; is_delivery: boolean; has_other_wait: boolean;
}): RecoveryPlan {
  if (["done", "superseded", "in_review"].includes(input.status)) return { kind: "none" };
  if (input.status === "in_progress" && input.live_executor) return { kind: "owned", text: "An agent is working on this change. No action is needed from you." };
  if (!input.is_delivery || input.has_other_wait) return { kind: "none" };
  if (input.phase === "conflicting") return { kind: "dispatch", reason: "conflict" };
  if (input.phase === "unbound" || input.phase === "bounced") return { kind: "dispatch", reason: "queue_binding" };
  if (input.phase === "queued" && !input.queue_admitted) {
    return input.status === "blocked" ? { kind: "restore_queue" } : { kind: "dispatch", reason: "queue_binding" };
  }
  return { kind: "none" };
}
