import { Miniflare } from "miniflare";
import { realpathSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let mf: Miniflare;
let stub: { fetch(url: string, init: RequestInit): Promise<Response> };
interface Reply {
  id: string; status: string; verify_task: string; error?: string; result_class?: string;
  meta: { completion: { kind: string }; execution_result?: object; merge_train?: object; review_result?: object };
}
async function call(op: string, body: object = {}) {
  const response = await stub.fetch(`https://kb/${op}`, { method: "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Reply };
}
const get = async (id: string) => (await call("get", { id })).body;
const repo = "state-vector/completion-authority";
const commit = "a".repeat(40);
const receipt = `https://github.com/${repo}/commit/${commit}`;
const outcome = { outcome: "Diagnostic identified the cause; runtime recovery remains unproven.", receipts: [receipt] };
beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  mf = new Miniflare({ workers: [{ name: "main", scriptPath: bundle,
    modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")), modules: true, compatibilityDate: "2025-09-06",
    durableObjects: { KB: { className: "KnowledgeHub", useSQLite: true } } }] });
});
beforeEach(async () => {
  const ns = await mf.getDurableObjectNamespace("KB");
  stub = await ns.get(ns.idFromName(crypto.randomUUID())) as unknown as typeof stub;
  await call("orient", { actor: "fixture" });
});
afterAll(async () => { await mf?.dispose(); });

async function task(roles: string[] = ["impl"], meta: object = {}) {
  const created = await call("create", { type: "task", title: "Verify actual work, not process success",
    qualified: true, roles, meta, actor: "author", session: "" });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const id = created.body.id;
  expect((await call("transition", { id, to: "in_progress", actor: "impl", session: "impl-session" })).status).toBe(200);
  return id;
}
async function submission(roles = ["impl"], meta: object = {}) {
  const id = await task(roles, meta);
  const submitted = await call("transition", { id, to: "in_review", actor: "impl", session: "impl-session",
    note: receipt, execution_result: outcome });
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  const review = submitted.body.verify_task;
  expect((await call("transition", { id: review, to: "in_progress", actor: "reviewer", session: "fresh-review" })).status).toBe(200);
  return { id, review };
}

describe("positive completion authority on the real SQLite hub", () => {
  it("does not treat absent qualification bars as completion acceptance", async () => {
    const id = await task();
    const refused = await call("transition", { id, to: "done", actor: "impl", session: "impl-session", note: "Process exited zero" });
    expect(refused.status).toBe(400);
    expect((await get(id)).status).toBe("in_progress");
  });
  it.each(["", "DONE; process exited 0", "MCP UNAVAILABLE: bridge tools missing",
    "fatal: unrecognized diagnostic output", "Verified checks passed; final verdict is still pending"])(
    "does not convert diagnostic output into an analysis outcome: %s", async note => {
      const id = await task(["analysis"]);
      const refused = await call("transition", { id, to: "done", actor: "impl", session: "impl-session", note });
      expect(refused.status).toBe(400);
      expect(refused.body.result_class).toBe("gate_rejected");
      expect((await get(id)).status).toBe("in_progress");
      expect((await get(id)).meta.execution_result).toBeUndefined();
    });

  it("records an explicit diagnostic finding without declaring an incident recovered", async () => {
    const id = await task(["analysis"]);
    expect((await get(id)).meta.completion.kind).toBe("execution");
    const closed = await call("transition", { id, to: "done", actor: "impl", session: "impl-session", execution_result: outcome });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect((await get(id)).meta.execution_result).toEqual(outcome);
  });

  it.each(["in_review", "done"])("refuses gateway-authored %s even with positive-looking evidence", async to => {
    const id = await task();
    const refused = await call("transition", { id, to, gateway: true, agent: "pretend-reviewer",
      actor: "gateway", session: "impl-session", note: `Verified ${receipt}; process exited 0`, execution_result: outcome });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("gateway infrastructure cannot");
    expect((await get(id)).status).toBe("in_progress");
  });

  it("requires an explicit execution outcome on submission, even with a commit link or old result", async () => {
    const id = await task(["analysis"], { execution_result: outcome });
    const refused = await call("transition", { id, to: "in_review", actor: "impl", session: "impl-session", note: receipt });
    expect(refused.status).toBe(400);
    expect((await get(id)).status).toBe("in_progress");
  });

  it("does not infer review acceptance from a commit, CI URL, or pending-verdict transcript", async () => {
    const { id, review } = await submission();
    const refused = await call("transition", { id: review, to: "done", actor: "reviewer", session: "fresh-review",
      note: `VERIFY ACCEPT ${receipt} https://github.com/${repo}/actions/runs/1; final verdict pending` });
    expect(refused.status).toBe(400);
    expect((await get(review)).status).toBe("in_progress");
    expect((await get(id)).status).toBe("in_review");
  });

  it("closes typed findings without delivering the parent, regardless of affirmative prose", async () => {
    const { id, review } = await submission();
    const closed = await call("transition", { id: review, to: "done", actor: "reviewer", session: "fresh-review",
      note: `Verified ${receipt}; all checks passed`, review_result: { kind: "findings", summary: "The runtime outcome is not demonstrated." } });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect((await get(review)).status).toBe("done");
    expect((await get(id)).status).toBe("in_review");
    expect((await get(id)).meta.merge_train).toBeUndefined();
    const premature = await call("transition", { id, to: "done", actor: "impl", session: "impl-session", note: "The review child closed done" });
    expect(premature.status).toBe(400);
    expect((await get(id)).status).toBe("in_review");
  });

  it("rejects an acceptance naming a different task before closing the duty", async () => {
    const { id, review } = await submission();
    const other = await task();
    const refused = await call("transition", { id: review, to: "done", actor: "reviewer", session: "fresh-review",
      review_result: { kind: "accepted_pr", task_id: other, legs: [{ repo, number: 1, head_sha_at_acceptance: commit }] } });
    expect(refused.status).toBe(400);
    expect((await get(review)).status).toBe("in_progress");
    expect((await get(id)).status).toBe("in_review");
    expect((await get(other)).meta.merge_train).toBeUndefined();
  });

  it("accepts the actual analysis execution outcome through an independent review", async () => {
    const { id, review } = await submission(["analysis"]);
    const accepted = await call("transition", { id: review, to: "done", actor: "reviewer", session: "fresh-review",
      review_result: { kind: "accepted_execution", task_id: id, receipts: [receipt] } });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((await get(id)).status).toBe("done");
  });

  it.each(["accepted_direct_main", "accepted_pr"])("does not substitute %s for an execution outcome", async kind => {
    const { id, review } = await submission(["impl"], { completion: { kind: "execution", outcome: "Prove actual deployed recovery" } });
    const review_result = kind === "accepted_direct_main"
      ? { kind, repo, commit, ci_run_url: `https://github.com/${repo}/actions/runs/1` }
      : { kind, task_id: id, legs: [{ repo, number: 1, head_sha_at_acceptance: commit }] };
    const refused = await call("transition", { id: review, to: "done", actor: "reviewer", session: "fresh-review", review_result });
    expect(refused.status).toBe(400);
    expect((await get(review)).status).toBe("in_progress");
    expect((await get(id)).status).toBe("in_review");
  });

  it("cannot erase or weaken an execution completion contract through metadata", async () => {
    const id = await task(["analysis"]);
    expect((await call("update", { id, meta_delete: ["completion"] })).status).toBe(400);
    expect((await call("update", { id, meta: { completion: { kind: "delivery" } } })).status).toBe(400);
    expect((await get(id)).meta.completion.kind).toBe("execution");
  });
});
