import { expect } from "vitest";

interface JsonReply { id?: string; error?: unknown }
type Call = (path: string, body: Record<string, unknown>) => Promise<Response | { status: number; body: JsonReply }>;

/** Exercise the actual independent review transition; never synthesise an
 * acceptance from a fixture note or directly stamp a production review row. */
export async function completePrReview(call: Call, task_id: string,
  legs: { repo: string; number: number; head_sha_at_acceptance: string }[]) {
  const request = async (path: string, body: Record<string, unknown>) => {
    const reply = await call(path, body);
    const json = reply instanceof Response ? await reply.json() as JsonReply : reply.body;
    expect(reply.status, JSON.stringify(json)).toBe(200);
    return json;
  };
  const session = `fixture-review-${crypto.randomUUID()}`;
  const duty = await request("/create", { type: "task", title: "Independent fixture PR review", roles: ["review"], session });
  const id = String(duty.id);
  await request("/link", { src: id, relation: "child_of", dst: task_id });
  await request("/transition", { id, to: "in_progress", actor: "fixture-reviewer", session });
  await request("/transition", { id, to: "done", actor: "fixture-reviewer", session,
    note: legs.map(l => `https://github.com/${l.repo}/pull/${l.number} head ${l.head_sha_at_acceptance}`).join("; "),
    review_result: { kind: "accepted_pr", task_id, legs } });
  return id;
}
