import { z } from "zod";

/** A review completion is not necessarily an acceptance. Typed receipts keep
 * a findings/cannot-proceed close from being mistaken for delivered work. */
export const ReviewResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted_pr"), task_id: z.string().regex(/^BR#\d+$/),
    subject_revision: z.string().min(1).optional().describe("Echo this duty's meta.review_subject.revision; acceptance is fenced to that exact task submission."),
    legs: z.array(z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), number: z.number().int().positive(),
      head_sha_at_acceptance: z.string().regex(/^[0-9a-f]{40}$/) })).min(1) }),
  z.object({ kind: z.literal("accepted_execution"), task_id: z.string().regex(/^BR#\d+$/), subject_revision: z.string().min(1).optional(), receipts: z.array(z.string().min(1)).min(1) }),
  z.object({
    kind: z.literal("accepted_direct_main"),
    subject_revision: z.string().min(1).optional(),
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    ci_run_url: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/),
  }),
  z.object({ kind: z.literal("findings"), summary: z.string().min(1) }),
  z.object({ kind: z.literal("stronger_implementation_required"), summary: z.string().min(1),
    task_id: z.string().regex(/^BR#\d+$/) }),
]);
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
/** Cached connectors may carry the explicit revision at the top level.
 * Normalize transport only; the hub still fences this against the captured
 * review subject and the current submission. Never infer a revision. */
export function parseReviewResult(value: unknown, subjectRevision?: unknown): ReviewResult {
  const result = ReviewResultSchema.parse(value);
  if (subjectRevision === undefined) return result;
  const revision = z.string().min(1).parse(subjectRevision);
  if (result.kind === "findings" || result.kind === "stronger_implementation_required") {
    throw new Error("subject_revision requires an acceptance result");
  }
  if (result.subject_revision !== undefined && result.subject_revision !== revision) {
    throw new Error("conflicting review subject_revision values");
  }
  return { ...result, subject_revision: revision };
}

export type ReviewAcceptance = Extract<ReviewResult, { kind: "accepted_pr" | "accepted_execution" | "accepted_direct_main" }>;

export type IndependentReviewReceipt =
  | { kind: "independent_review"; task_id: string; id: string; status: "complete"; message: string }
  | { kind: "independent_review"; task_id: string; status: "pending" | "awaiting_dependencies"; id: string; message: string };
