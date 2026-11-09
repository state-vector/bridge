import { Miniflare } from "miniflare";
import { readFileSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reviewOutcome } from "./completion-fixture";
import { initialExecution, type ReviewResult } from "@bridge/contracts";

let mf: Miniflare;
let stub: { fetch(url: string, init: RequestInit): Promise<Response> };
interface Reply {
  id: string; status: string; verify_task: string; error?: string; result_class?: string;
  meta: { completion: { kind: string }; execution_result?: object; merge_train?: object; review_result?: object;
    work_revision: string; review_subject?: { task_id: string; revision: string } };
}
async function call(op: string, body: object = {}) {
  const response = await stub.fetch(`https://kb/${op}`, { method: "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Reply };
}
const get = async (id: string) => (await call("get", { id })).body;
const resultFor = (id: string, result: ReviewResult) => reviewOutcome((path, body) => call(path.slice(1), body), id, result);
const repo = "state-vector/completion-authority";
const commit = "a".repeat(40);
const receipt = `https://github.com/${repo}/commit/${commit}`;
const outcome = { outcome: "Diagnostic identified the cause; runtime recovery remains unproven.", receipts: [receipt] };
beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  const root = bundle.slice(0, bundle.lastIndexOf("/"));
  const rig = `import { KnowledgeHub } from "./index.js";
    export class CompletionRig extends KnowledgeHub {
      async fetch(request) {
        if (new URL(request.url).pathname !== "/fixture/execution") return super.fetch(request);
        const {id, execution} = await request.json();
        this.state.storage.sql.exec("INSERT INTO execution_state(task_id,state,worker_token_id) VALUES(?,?,'')", id, JSON.stringify(execution));
        return Response.json({ok:true});
      }
    }
    export default {fetch(){return new Response("fixture");}};`;
  mf = new Miniflare({ modulesRoot: root, modules: [
    { type: "ESModule", path: root + "/completion-rig.js", contents: rig },
    { type: "ESModule", path: bundle, contents: readFileSync(bundle, "utf8") },
  ], compatibilityDate: "2025-09-06", durableObjects: { KB: { className: "CompletionRig", useSQLite: true } } });
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
      review_result: await resultFor(review, { kind: "accepted_pr", task_id: other, legs: [{ repo, number: 1, head_sha_at_acceptance: commit }] }) });
    expect(refused.status).toBe(400);
    expect((await get(review)).status).toBe("in_progress");
    expect((await get(id)).status).toBe("in_review");
    expect((await get(other)).meta.merge_train).toBeUndefined();
  });

  it("accepts the actual analysis execution outcome through an independent review", async () => {
    const { id, review } = await submission(["analysis"]);
    const accepted = await call("transition", { id: review, to: "done", actor: "reviewer", session: "fresh-review",
      review_result: await resultFor(review, { kind: "accepted_execution", task_id: id, receipts: [receipt] }) });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((await get(id)).status).toBe("done");
  });

  it("accepts an explicitly declared analysis artifact delivery without inventing its findings", async () => {
    const { id, review } = await submission(["analysis"], { completion: { kind: "delivery" } });
    const accepted = await call("transition", { id: review, to: "done", actor: "reviewer", session: "fresh-review",
      review_result: await resultFor(review, { kind: "accepted_direct_main", repo, commit, ci_run_url: `https://github.com/${repo}/actions/runs/1` }) });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((await get(id)).status).toBe("done");
    expect((await get(id)).meta.execution_result).toEqual(outcome);
  });

  it.each(["accepted_direct_main", "accepted_pr"] as const)("does not substitute %s for an execution outcome", async kind => {
    const { id, review } = await submission(["impl"], { completion: { kind: "execution", outcome: "Prove actual deployed recovery" } });
    const review_result = kind === "accepted_direct_main"
      ? { kind, repo, commit, ci_run_url: `https://github.com/${repo}/actions/runs/1` }
      : { kind, task_id: id, legs: [{ repo, number: 1, head_sha_at_acceptance: commit }] };
    const refused = await call("transition", { id: review, to: "done", actor: "reviewer", session: "fresh-review", review_result: await resultFor(review, review_result) });
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

  it("cannot upgrade completed findings to acceptance by editing metadata", async () => {
    const { id, review } = await submission();
    expect((await call("transition", { id: review, to: "done", actor: "reviewer", session: "fresh-review",
      review_result: { kind: "findings", summary: "Outcome is still unverified." } })).status).toBe(200);
    const forged = await call("update", { id: review, meta: { review_result: { kind: "accepted_direct_main", repo, commit,
      ci_run_url: `https://github.com/${repo}/actions/runs/1` } } });
    expect(forged.status).toBe(400);
    expect((await get(id)).status).toBe("in_review");
    expect((await get(review)).meta.review_result).toMatchObject({ kind: "findings" });
  });

  it("requires the reviewer to echo the server-captured subject revision", async () => {
    const { id, review } = await submission(["analysis"]);
    const refused = await call("transition", { id: review, to: "done", actor: "reviewer", session: "fresh-review",
      review_result: { kind: "accepted_execution", task_id: id, receipts: [receipt] } });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("subject_revision");
    expect((await get(review)).status).toBe("in_progress");
  });

  it("accepts an explicitly echoed revision through a cached connector's top-level field", async () => {
    const { id, review } = await submission(["analysis"]);
    const revision = (await get(review)).meta.review_subject!.revision;
    const accepted = await call("transition", { id: review, to: "done", actor: "reviewer", session: "fresh-review",
      subject_revision: revision, review_result: { kind: "accepted_execution", task_id: id, receipts: [receipt] } });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((await get(review)).meta.review_result).toMatchObject({ subject_revision: revision });
    expect((await get(id)).status).toBe("done");
  });

  it("rejects conflicting transport revisions without recording acceptance", async () => {
    const { id, review } = await submission(["analysis"]);
    const result = await resultFor(review, { kind: "accepted_execution", task_id: id, receipts: [receipt] });
    const refused = await call("transition", { id: review, to: "done", actor: "reviewer", session: "fresh-review",
      subject_revision: "different-submission", review_result: result });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("conflicting review subject_revision");
    expect((await get(review)).status).toBe("in_progress");
    expect((await get(id)).status).toBe("in_review");
  });

  it("fences a top-level revision against a changed submission", async () => {
    const { id, review } = await submission(["analysis"]);
    const revision = (await get(review)).meta.review_subject!.revision;
    expect((await call("update", { id, body_md: "Changed outcome definition" })).status).toBe(200);
    const refused = await call("transition", { id: review, to: "done", actor: "reviewer", session: "fresh-review",
      subject_revision: revision, review_result: { kind: "accepted_execution", task_id: id, receipts: [receipt] } });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("subject_revision");
    expect((await get(id)).status).toBe("in_review");
  });

  it.each(["definition edit", "repository input edit", "repository input deletion", "identical resubmission"])("fences late acceptance after %s", async change => {
    const { id, review } = await submission(["analysis"], { repo: "https://github.com/state-vector/original-input" });
    const result = await resultFor(review, { kind: "accepted_execution", task_id: id, receipts: [receipt] });
    if (change === "definition edit") {
      expect((await call("update", { id, body_md: "The requested outcome changed after review began." })).status).toBe(200);
    } else if (change === "repository input edit") {
      expect((await call("update", { id, meta: { repo: "https://github.com/state-vector/changed-input" } })).status).toBe(200);
    } else if (change === "repository input deletion") {
      expect((await call("update", { id, meta_delete: ["repo"] })).status).toBe(200);
    } else {
      expect((await call("transition", { id, to: "in_progress", actor: "impl", session: "impl-session", note: "New execution attempt needs a fresh submission" })).status).toBe(200);
      expect((await call("transition", { id, to: "in_review", actor: "impl", session: "impl-session", note: receipt, execution_result: outcome })).status).toBe(200);
    }
    const refused = await call("transition", { id: review, to: "done", actor: "reviewer", session: "fresh-review", review_result: result });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("subject_revision");
    expect((await get(id)).status).toBe("in_review");
    expect((await get(review)).status).toBe("in_progress");
  });

  it("does not invalidate exact-submission review on ordinary progress", async () => {
    const { id, review } = await submission(["analysis"]);
    const result = await resultFor(review, { kind: "accepted_execution", task_id: id, receipts: [receipt] });
    const revision = (await get(id)).meta.work_revision;
    expect((await call("progress.log", { id, actor: "impl", session: "impl-session", note: "Evidence remains unchanged; review is running." })).status).toBe(200);
    expect((await get(id)).meta.work_revision).toBe(revision);
    const accepted = await call("transition", { id: review, to: "done", actor: "reviewer", session: "fresh-review", review_result: result });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((await get(id)).status).toBe("done");
  });

  it("does not replay a valid old acceptance onto changed work after a structural child closes", async () => {
    const { id, review } = await submission(["analysis"]);
    const child = await task(["analysis"]);
    expect((await call("link", { src: child, relation: "child_of", dst: id })).status).toBe(200);
    const accepted = await call("transition", { id: review, to: "done", actor: "reviewer", session: "fresh-review",
      review_result: await resultFor(review, { kind: "accepted_execution", task_id: id, receipts: [receipt] }) });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((await get(id)).status).toBe("in_review"); // structural child still open
    const changed = { outcome: "A different execution outcome now needs verification.", receipts: [id] };
    expect((await call("update", { id, body_md: "New scope after the old review completed", meta: { execution_result: changed } })).status).toBe(200);
    expect((await call("transition", { id: child, to: "done", actor: "impl", session: "impl-session",
      execution_result: { outcome: "Child analysis complete", receipts: [child] } })).status).toBe(200);
    for (let pass = 0; pass < 2; pass++) await call("admin.ask_escalation_sweep", { now: Date.now() });
    expect((await get(id)).status).toBe("in_review");
    expect((await get(id)).meta.execution_result).toEqual(changed);
    expect((await get(review)).status).toBe("done"); // preserve the historical verdict
  });

  it.each(["pending", "findings"])("a newer detached %s review supersedes older acceptance authority", async state => {
    const { id, review } = await submission(["impl"], { completion: { kind: "execution", outcome: "Verify actual execution" } });
    const child = await task(["analysis"]);
    await call("link", { src: child, relation: "child_of", dst: id });
    expect((await call("transition", { id: review, to: "done", actor: "reviewer", session: "fresh-review",
      review_result: await resultFor(review, { kind: "accepted_execution", task_id: id, receipts: [receipt] }) })).status).toBe(200);
    const latest = (await call("create", { type: "task", title: "New detached review round", roles: ["review"],
      meta: { execution_review_of: id }, session: "" })).body.id;
    expect((await call("transition", { id: latest, to: "in_progress", actor: "latest-reviewer", session: "latest-review" })).status).toBe(200);
    if (state === "findings") expect((await call("transition", { id: latest, to: "done", actor: "latest-reviewer", session: "latest-review",
      review_result: { kind: "findings", summary: "The latest review does not accept this outcome." } })).status).toBe(200);
    expect((await call("transition", { id: child, to: "done", actor: "impl", session: "impl-session",
      execution_result: { outcome: "Structural child complete", receipts: [child] } })).status).toBe(200);
    for (let pass = 0; pass < 2; pass++) await call("admin.ask_escalation_sweep", { now: Date.now() });
    expect((await get(id)).status).toBe("in_review");
  });

  it("enforces session separation for a detached subject-bound review", async () => {
    const { id } = await submission(["impl"], { completion: { kind: "execution", outcome: "Verify execution" } });
    const review = (await call("create", { type: "task", title: "Detached review cannot self-accept", roles: ["review"],
      meta: { execution_review_of: id }, session: "" })).body.id;
    expect((await call("transition", { id: review, to: "in_progress", actor: "impl", session: "impl-session" })).status).toBe(200);
    const refused = await call("transition", { id: review, to: "done", actor: "impl", session: "impl-session",
      review_result: await resultFor(review, { kind: "accepted_execution", task_id: id, receipts: [receipt] }) });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("separation of duties");
    expect((await get(review)).status).toBe("in_progress");
  });

  it("reuses the canonical detached pending review when independent review is requested", async () => {
    const { id, review } = await submission(["analysis"]);
    expect((await call("transition", { id: review, to: "done", actor: "reviewer", session: "fresh-review",
      review_result: { kind: "findings", summary: "A new detached round will verify the remaining evidence." } })).status).toBe(200);
    const latest = (await call("create", { type: "task", title: "Canonical detached review", roles: ["review"],
      meta: { execution_review_of: id }, session: "" })).body.id;
    const request = await call("ask.create", { route: { kind: "independent_review", task_id: id } });
    expect(request.status, JSON.stringify(request.body)).toBe(200);
    expect(request.body.id).toBe(latest);
  });

  it("does not report old acceptance after the canonical review returned findings", async () => {
    const { id, review } = await submission(["analysis"]);
    const child = await task(["analysis"]);
    await call("link", { src: child, relation: "child_of", dst: id });
    expect((await call("transition", { id: review, to: "done", actor: "reviewer", session: "fresh-review",
      review_result: await resultFor(review, { kind: "accepted_execution", task_id: id, receipts: [receipt] }) })).status).toBe(200);
    const latest = (await call("create", { type: "task", title: "New review found missing evidence", roles: ["review"],
      meta: { execution_review_of: id }, session: "" })).body.id;
    await call("transition", { id: latest, to: "in_progress", actor: "new-reviewer", session: "new-review" });
    expect((await call("transition", { id: latest, to: "done", actor: "new-reviewer", session: "new-review",
      review_result: { kind: "findings", summary: "Newer evidence does not support acceptance." } })).status).toBe(200);
    const request = await call("ask.create", { route: { kind: "independent_review", task_id: id } });
    expect(request.status, JSON.stringify(request.body)).toBe(200);
    expect(request.body.id).not.toBe(review);
    expect((await get(request.body.id)).status).toBe("todo");
  });

  it("gives a changed submission a fresh review instead of rebinding a claimed old duty", async () => {
    const { id, review } = await submission(["analysis"]);
    const oldSubject = (await get(review)).meta.review_subject;
    expect((await call("transition", { id, to: "in_progress", actor: "impl", session: "impl-session", note: "Repair after changed evidence" })).status).toBe(200);
    const submitted = await call("transition", { id, to: "in_review", actor: "impl", session: "impl-session", execution_result: outcome });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const fresh = submitted.body.verify_task;
    expect(fresh).not.toBe(review);
    expect((await get(review)).meta.review_subject).toEqual(oldSubject);
    expect((await call("transition", { id: review, to: "done", actor: "reviewer", session: "fresh-review",
      review_result: await resultFor(review, { kind: "accepted_execution", task_id: id, receipts: [receipt] }) })).status).toBe(400);
    expect((await call("transition", { id: review, to: "done", actor: "reviewer", session: "fresh-review",
      review_result: { kind: "findings", summary: "The captured submission changed; retained as a historical review." } })).status).toBe(200);
    expect((await call("transition", { id: fresh, to: "in_progress", actor: "fresh-reviewer", session: "new-submission-review" })).status).toBe(200);
    expect((await get(fresh)).meta.review_subject?.revision).toBe((await get(id)).meta.work_revision);
    expect((await call("transition", { id: fresh, to: "done", actor: "fresh-reviewer", session: "new-submission-review",
      review_result: await resultFor(fresh, { kind: "accepted_execution", task_id: id, receipts: [receipt] }) })).status).toBe(200);
    expect((await get(id)).status).toBe("done");
  });

  it.each(["unowned", "claimed", "unknown operation"])("handles an older review that has state %s", async (oldReviewState) => {
    const { id, review } = await submission(["analysis"]);
    expect((await call("transition", { id, to: "in_progress", actor: "impl", session: "impl-session", note: "Repair after changed evidence" })).status).toBe(200);
    const fresh = await call("transition", { id, to: "in_review", actor: "impl", session: "impl-session", execution_result: outcome });
    expect(fresh.status).toBe(200);
    if (oldReviewState !== "claimed") {
      const released = await call("transition", { id: review, to: "todo", actor: "reviewer", session: "fresh-review", note: "Preserve old review evidence and release the claim" });
      expect(released.status, JSON.stringify(released.body)).toBe(200);
    }
    if (oldReviewState === "unknown operation") {
      const execution = initialExecution();
      execution.operations.push({ id: "receipt-check", action: "Check remote receipt", input_revision: "old",
        deadline: 100, state: "outcome_unknown", receipts: [] });
      expect((await call("fixture/execution", { id: review, execution })).status).toBe(200);
    }
    const current = fresh.body.verify_task;
    expect((await call("transition", { id: current, to: "in_progress", actor: "new-reviewer", session: "new-review" })).status).toBe(200);
    expect((await call("transition", { id: current, to: "done", actor: "new-reviewer", session: "new-review",
      review_result: await resultFor(current, { kind: "accepted_execution", task_id: id, receipts: [receipt] }) })).status).toBe(200);
    expect((await get(id)).status).toBe(oldReviewState === "unowned" ? "done" : "in_review");
    if (oldReviewState === "unknown operation") expect((await get(review)).status).toBe("todo");
  });

  it("can reuse an unclaimed review because no prior subject has been captured", async () => {
    const id = await task(["analysis"]);
    const first = await call("transition", { id, to: "in_review", actor: "impl", session: "impl-session", execution_result: outcome });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect((await get(first.body.verify_task)).meta.review_subject).toBeUndefined();
    await call("transition", { id, to: "in_progress", actor: "impl", session: "impl-session", note: "Replace unreviewed evidence" });
    const second = await call("transition", { id, to: "in_review", actor: "impl", session: "impl-session", execution_result: outcome });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.verify_task).toBe(first.body.verify_task);
    await call("transition", { id: second.body.verify_task, to: "in_progress", actor: "new-reviewer", session: "unclaimed-review" });
    expect((await get(second.body.verify_task)).meta.review_subject?.revision).toBe((await get(id)).meta.work_revision);
  });
});
