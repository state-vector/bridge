import { expect } from "vitest";
import type { ReviewResult } from "@bridge/contracts";

interface JsonReply { id?: string; verify_task?: string; status?: string; error?: unknown;
  meta?: { review_subject?: { task_id: string; revision: string } } }
type Call = (path: string, body: Record<string, unknown>) => Promise<Response | { status: number; body: JsonReply }>;
async function request(call: Call, path: string, body: Record<string, unknown>) {
  const reply = await call(path, body);
  const json = "json" in reply ? await reply.json() as JsonReply : reply.body;
  expect(reply.status, `${path}: ${JSON.stringify(json)}`).toBe(200);
  return json;
}

export async function reviewOutcome(call: Call, id: string, result: ReviewResult): Promise<ReviewResult> {
  if (result.kind === "findings" || result.kind === "stronger_implementation_required") return result;
  const duty = await request(call, "/get", { id });
  const subject = duty.meta?.review_subject;
  if (!subject) throw new Error("the hub must capture the review subject before acceptance");
  return { ...result, subject_revision: subject.revision };
}

/** Exercise the actual independent review transition; never synthesise an
 * acceptance from a fixture note or directly stamp a production review row. */
export async function completePrReview(call: Call, task_id: string,
  legs: { repo: string; number: number; head_sha_at_acceptance: string }[]) {
  const session = `fixture-review-${crypto.randomUUID()}`;
  const duty = await request(call, "/create", { type: "task", title: "Independent fixture PR review", roles: ["review"], session });
  const id = String(duty.id);
  await request(call, "/link", { src: id, relation: "child_of", dst: task_id });
  await request(call, "/transition", { id, to: "in_progress", actor: "fixture-reviewer", session });
  await request(call, "/transition", { id, to: "done", actor: "fixture-reviewer", session,
    note: legs.map(l => `https://github.com/${l.repo}/pull/${l.number} head ${l.head_sha_at_acceptance}`).join("; "),
    review_result: await reviewOutcome(call, id, { kind: "accepted_pr", task_id, legs }) });
  return id;
}

async function closeSubmission(call: Call, task_id: string, submission: JsonReply, review_result: ReviewResult) {
  expect(submission.verify_task).toBeTruthy();
  const id = String(submission.verify_task), session = `fixture-review-${crypto.randomUUID()}`;
  await request(call, "/transition", { id, to: "in_progress", actor: "fixture-reviewer", session });
  await request(call, "/transition", { id, to: "done", actor: "fixture-reviewer", session,
    review_result: await reviewOutcome(call, id, review_result) });
  expect((await request(call, "/get", { id: task_id })).status).toBe("done");
}

export async function completeExecutionReview(call: Call, task_id: string, execution_result: { outcome: string; receipts: string[] }) {
  const submission = await request(call, "/transition", { id: task_id, to: "in_review", execution_result });
  await closeSubmission(call, task_id, submission, { kind: "accepted_execution", task_id, receipts: execution_result.receipts });
}

export async function completeMainReview(call: Call, task_id: string, repo: string, commit: string) {
  const submission = await request(call, "/transition", { id: task_id, to: "in_review", note: `https://github.com/${repo}/commit/${commit}` });
  await closeSubmission(call, task_id, submission, { kind: "accepted_direct_main", repo, commit,
    ci_run_url: `https://github.com/${repo}/actions/runs/1` });
}
