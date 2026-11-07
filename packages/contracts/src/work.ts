import { z } from "zod";
import { ReviewResultSchema, type ReviewResult, type ReviewAcceptance } from "./review.ts";

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
export function mergeCompletesTask(meta: { completion?: unknown; depends_on?: unknown; lane?: unknown }): boolean {
  // A standing lane is a subsystem, never a PR delivery. Incidental/stale PR
  // metadata must not let any provenance-based close path retire the train.
  if (typeof meta.lane === "object" && meta.lane !== null && "key" in meta.lane && typeof meta.lane.key === "string") return false;
  return completionContract(meta).kind === "delivery";
}

export const ExecutionResultSchema = z.object({
  outcome: z.string().min(1),
  receipts: z.array(z.string().min(1)).min(1),
});

/** Server-captured subject, echoed by the independent reviewer. Definition
 * edits and every new submission change the revision; mailbox/progress do not. */
export const ReviewSubjectSchema = z.object({
  task_id: z.string().regex(/^BR#\d+$/), revision: z.string().min(1),
});
export type ReviewSubject = z.infer<typeof ReviewSubjectSchema>;
export type CurrentTaskReview =
  | { phase: "none" }
  | { phase: "pending"; id: string; at: number }
  | { phase: "rejected"; id: string; at: number; result: Exclude<ReviewResult, ReviewAcceptance> }
  | { phase: "accepted"; id: string; at: number; subject: ReviewSubject; result: ReviewAcceptance }
  | { phase: "historical"; id: string; at: number };

/** Existing human force-review authority, captured at the exact task revision
 * and heads. Approval does not merge or waive decisive delivery checks. */
export const HumanDeliveryApprovalSchema = z.object({
  kind: z.literal("human_delivery_approval"), task_id: z.string().regex(/^BR#\d+$/),
  revision: z.string().min(1), actor: z.string().regex(/^(web(?::|$)|human(?::|$))/), at: z.number(),
  legs: z.array(z.object({ repo: z.string(), number: z.number().int().positive(), head: z.string().regex(/^[0-9a-f]{40}$/i) })).min(1),
});

export const UnblockResultSchema = z.object({
  kind: z.literal("reblocked"), parent_id: z.string().regex(/^BR#\d+$/),
  reason: z.string().min(1), next: z.string().min(1),
  await_event: z.record(z.string(), z.unknown()),
});

/** Positive outcome evidence is distinct from a process exit or transcript.
 * The hub supplies the role from the stored task, never from the result. */
export type DutyOutcome =
  | { kind: "review"; result: ReviewResult }
  | { kind: "analysis" | "unblock"; result: z.infer<typeof ExecutionResultSchema> }
  | { kind: "reblocked"; result: z.infer<typeof UnblockResultSchema> };
export function dutyOutcome(role: string, body: { review_result?: unknown; execution_result?: unknown; unblock_result?: unknown }): DutyOutcome | null {
  if (role === "review") {
    const result = ReviewResultSchema.safeParse(body.review_result);
    return result.success ? { kind: "review", result: result.data } : null;
  }
  if (role === "unblock" && body.unblock_result !== undefined) {
    const result = UnblockResultSchema.safeParse(body.unblock_result);
    return result.success ? { kind: "reblocked", result: result.data } : null;
  }
  if (role === "analysis" || role === "unblock") {
    const result = ExecutionResultSchema.safeParse(body.execution_result);
    return result.success ? { kind: role, result: result.data } : null;
  }
  return null;
}

/** Persistable command receipt for clients that cannot yet carry the newer
 * transition argument. Consumption still uses the SAME human-authority gate. */
export const DispositionRequestSchema = z.object({
  kind: z.literal("apply_authorized_supersede"),
  ask: z.string().regex(/^BR#\d+$/),
});

export const RecoveryReasonSchema = z.enum(["queue_binding", "conflict", "execution_environment", "head_checks"]);
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
