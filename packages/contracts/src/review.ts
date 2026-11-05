import { z } from "zod";

/** A review completion is not necessarily an acceptance. Typed receipts keep
 * a findings/cannot-proceed close from being mistaken for delivered work. */
export const ReviewResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted_execution"), task_id: z.string().regex(/^BR#\d+$/), receipts: z.array(z.string().min(1)).min(1) }),
  z.object({
    kind: z.literal("accepted_direct_main"),
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    ci_run_url: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/),
  }),
  z.object({ kind: z.literal("findings"), summary: z.string().min(1) }),
]);
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export type IndependentReviewReceipt =
  | { kind: "independent_review"; task_id: string; id: string; status: "complete"; message: string }
  | { kind: "independent_review"; task_id: string; status: "pending" | "awaiting_dependencies"; id: string; message: string };
