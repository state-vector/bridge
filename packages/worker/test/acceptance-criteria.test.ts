import { Miniflare } from "miniflare";
import { readFileSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reviewOutcome } from "./completion-fixture";
import { verifyDutyBody } from "../src/kb/do.ts";
import type { AcceptanceCriterion, CriterionVerdict, ReviewResult } from "@bridge/contracts";

// BR#14366 (ADR BR#14118): meta.acceptance criteria on tasks — criteria-rendered
// verify duties, per-criterion review_result verdicts, spawn-time fencing.
//
// C1 a task with meta.acceptance produces a verify duty enumerating c1..cN as
//    dispositionable lines (with-criteria vs without-criteria render);
// C2 criteria-less parents render the EXACT current template (byte-identical);
// C3 review_result round-trips criteria[] verdicts through the transition path;
//    acceptance with an unmet criterion is gate-rejected naming the id;
// C4 a criterion added to the parent AFTER duty spawn neither appears in nor
//    binds that duty's verdict (spawn-frozen snapshot in review_subject);
// C5 impl-role mutation that adds/relaxes a criterion is rejected (role fence).

let mf: Miniflare;
let stub: { fetch(url: string, init: RequestInit): Promise<Response> };
interface Reply {
  id: string; status: string; verify_task?: string; error?: string; result_class?: string;
  body_md?: string;
  meta: { acceptance?: unknown; acceptance_snapshot?: unknown; work_revision?: string;
    review_subject?: { task_id: string; revision: string; criteria?: { id: string }[] };
    review_result?: { kind?: string; criteria?: CriterionVerdict[] } };
}
async function call(op: string, body: object = {}) {
  const response = await stub.fetch(`https://kb/${op}`, { method: "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Reply };
}
const get = async (id: string) => (await call("get", { id })).body;
const resultFor = (id: string, result: ReviewResult) => reviewOutcome((path, body) => call(path.slice(1), body), id, result);

const criteria: AcceptanceCriterion[] = [
  { id: "c1", statement: "the fix lands on main with a signed commit", kind: "receipt" },
  { id: "c2", statement: "the delivery PR merged with green checks", kind: "machine", check: { event: "pr_merged", repo: "state-vector/bridge", n: 42 } },
  { id: "c3", statement: "Ray confirms the new panel copy", kind: "human" },
];
const acceptance = { criteria, authored_by: "analysis-session", basis: "BR#14118" };
const repo = "state-vector/acceptance-criteria";
const commit = "a".repeat(40);
const receipt = `https://github.com/${repo}/commit/${commit}`;

beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  const root = bundle.slice(0, bundle.lastIndexOf("/"));
  mf = new Miniflare({ modulesRoot: root, modules: [
    { type: "ESModule", path: bundle, contents: readFileSync(bundle, "utf8") },
  ], compatibilityDate: "2025-09-06", durableObjects: { KB: { className: "KnowledgeHub", useSQLite: true } } });
});
beforeEach(async () => {
  const ns = await mf.getDurableObjectNamespace("KB");
  stub = await ns.get(ns.idFromName(crypto.randomUUID())) as unknown as typeof stub;
  await call("orient", { actor: "fixture" });
});
afterAll(async () => { await mf?.dispose(); });

/** A delivery task carrying meta.acceptance, submitted to in_review — the
 * in_review verdict-effects spawn creates the verify duty (returned). */
async function submission(meta: object = acceptance, roles: string[] = ["impl"]) {
  const created = await call("create", { type: "task", title: "Deliver the criteria-barred work",
    qualified: true, roles, meta: { acceptance: meta }, actor: "author", session: "" });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const id = created.body.id;
  expect((await call("transition", { id, to: "in_progress", actor: "impl", session: "impl-session" })).status).toBe(200);
  const submitted = await call("transition", { id, to: "in_review", actor: "impl", session: "impl-session", note: receipt });
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  return { id, review: submitted.body.verify_task! };
}

describe("verifyDutyBody render — criteria in, generic template intact", () => {
  it("renders every criterion as a dispositionable line with the verdict contract (C1)", () => {
    const body = verifyDutyBody("BR#9", "the titled work", `https://github.com/o/r/pull/42`, { repo: "o/r", n: 42 }, undefined, criteria);
    for (const c of criteria) expect(body).toContain(`- ${c.id} [${c.kind}] ${c.statement}`);
    expect(body).toContain("machine probe: pr_merged state-vector/bridge#42");
    expect(body).toContain(`criteria:[{id,verdict:"met"|"unmet"|"na",receipt}]`);
    expect(body).toContain("an unmet, undispositioned or extra criterion gate-rejects acceptance naming the id(s)");
    expect(body).toContain("Findings (bounce) must NAME the unmet criterion id(s)");
    expect(body).toContain("frozen at this duty's spawn");
  });

  it("criteria-less parents render the byte-identical generic template (C2)", () => {
    const plain = verifyDutyBody("BR#9", "the titled work", "https://github.com/o/r/pull/42", { repo: "o/r", n: 42 });
    const withCriteria = verifyDutyBody("BR#9", "the titled work", "https://github.com/o/r/pull/42", { repo: "o/r", n: 42 }, undefined, criteria);
    const start = withCriteria.indexOf("\n\nACCEPTANCE CRITERIA (BR#14118)");
    const end = withCriteria.indexOf("\n\nACCEPT only after substance");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(plain).toBe(withCriteria.slice(0, start) + withCriteria.slice(end));
    // the direct-main variant splices the same section without disturbing its template
    const directPlain = verifyDutyBody("BR#9", "the titled work", `https://github.com/o/r/commit/${commit}`);
    const directWith = verifyDutyBody("BR#9", "the titled work", `https://github.com/o/r/commit/${commit}`, undefined, undefined, criteria);
    const dStart = directWith.indexOf("\n\nACCEPTANCE CRITERIA (BR#14118)");
    const dEnd = directWith.indexOf("\n\n1. Establish the actual delivery phase");
    expect(directPlain).toBe(directWith.slice(0, dStart) + directWith.slice(dEnd));
  });
});

describe("hub end-to-end — criteria spawn, fence, gate (real SQLite hub)", () => {
  it("spawn renders criteria into the duty body and freezes the snapshot; claim folds it into review_subject (C1+C4)", async () => {
    const { id, review } = await submission();
    const duty = await get(review);
    expect(duty.body_md).toContain("- c1 [receipt] the fix lands on main with a signed commit");
    expect(duty.body_md).toContain("- c2 [machine] the delivery PR merged with green checks");
    expect(duty.meta.acceptance_snapshot).toMatchObject({ criteria: [{ id: "c1" }, { id: "c2" }, { id: "c3" }] });
    expect((await call("transition", { id: review, to: "in_progress", actor: "reviewer", session: "fresh-review" })).status).toBe(200);
    const claimed = await get(review);
    expect(claimed.meta.review_subject?.criteria?.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(claimed.meta.review_subject?.revision).toBe((await get(id)).meta.work_revision);
  });

  it("gate-rejects acceptance without verdicts, NAMING every undispositioned id (C3)", async () => {
    const { id, review } = await submission();
    expect((await call("transition", { id: review, to: "in_progress", actor: "reviewer", session: "fresh-review" })).status).toBe(200);
    const refused = await call("transition", { id: review, to: "done", actor: "reviewer", session: "fresh-review",
      review_result: await resultFor(review, { kind: "accepted_direct_main", repo, commit, ci_run_url: `https://github.com/${repo}/actions/runs/1` }) });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(refused.body.error).toContain("every criterion met or na");
    expect(refused.body.error).toContain("c1: no verdict");
    expect(refused.body.error).toContain("c3: no verdict");
    expect((await get(id)).status).toBe("in_review");
  });

  it("gate-rejects acceptance with an unmet criterion, NAMING the id (C3)", async () => {
    const { id, review } = await submission();
    expect((await call("transition", { id: review, to: "in_progress", actor: "reviewer", session: "fresh-review" })).status).toBe(200);
    const verdicts: CriterionVerdict[] = [
      { id: "c1", verdict: "met", receipt: "signed commit verified on main" },
      { id: "c2", verdict: "unmet", receipt: "PR #42 is still open — checks red" },
      { id: "c3", verdict: "na", receipt: "no human-facing copy changed in this round" },
    ];
    const refused = await call("transition", { id: review, to: "done", actor: "reviewer", session: "fresh-review",
      review_result: await resultFor(review, { kind: "accepted_direct_main", repo, commit, ci_run_url: `https://github.com/${repo}/actions/runs/1`, criteria: verdicts }) });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(refused.body.error).toContain("c2: unmet");
    expect((await get(id)).status).toBe("in_review");
  });

  it("accepts when every criterion is met or na with receipts; verdicts round-trip onto the duty (C3)", async () => {
    const { id, review } = await submission();
    expect((await call("transition", { id: review, to: "in_progress", actor: "reviewer", session: "fresh-review" })).status).toBe(200);
    const criteriaVerdicts: CriterionVerdict[] = [
      { id: "c1", verdict: "met", receipt: "signed commit verified on main" },
      { id: "c2", verdict: "met", receipt: "PR merged, all checks green" },
      { id: "c3", verdict: "na", receipt: "no human-facing copy changed in this round" },
    ];
    const accepted = await call("transition", { id: review, to: "done", actor: "reviewer", session: "fresh-review",
      review_result: await resultFor(review, { kind: "accepted_direct_main", repo, commit, ci_run_url: `https://github.com/${repo}/actions/runs/1`, criteria: criteriaVerdicts }) });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((await get(review)).meta.review_result).toMatchObject({ kind: "accepted_direct_main", criteria: criteriaVerdicts });
    expect((await get(id)).status).toBe("done");
  });

  it("a criterion added to the parent AFTER spawn neither appears in nor binds the duty (C4 fencing)", async () => {
    const { id, review } = await submission();
    // the parent gains a NEW criterion after the duty already spawned — the
    // add rides the web plane (authoring authority; an impl-lane card's bar is
    // fenced against non-exempt writers)
    const late = { ...acceptance, criteria: [...criteria, { id: "c4", statement: "a late-added bar", kind: "receipt" }] };
    expect((await call("update", { id, meta: { acceptance: late }, actor: "web:rayh" })).status).toBe(200);
    expect((await call("transition", { id: review, to: "in_progress", actor: "reviewer", session: "fresh-review" })).status).toBe(200);
    const claimed = await get(review);
    // the duty's bar is the SPAWN snapshot: c1..c3, never c4
    expect(claimed.body_md).not.toContain("c4");
    expect(claimed.meta.review_subject?.criteria?.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    // acceptance dispositioning exactly the bound criteria succeeds — c4 is not required
    const accepted = await call("transition", { id: review, to: "done", actor: "reviewer", session: "fresh-review",
      review_result: await resultFor(review, { kind: "accepted_direct_main", repo, commit, ci_run_url: `https://github.com/${repo}/actions/runs/1`,
        criteria: [{ id: "c1", verdict: "met", receipt: "r1" }, { id: "c2", verdict: "met", receipt: "r2" }, { id: "c3", verdict: "na", receipt: "n/a this round" }] }) });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((await get(id)).status).toBe("done");
  });

  it("an impl-role session cannot add, drop or relax criteria, but may attach evidence (C5)", async () => {
    const created = await call("create", { type: "task", title: "Impl task measured by criteria",
      qualified: true, roles: ["impl"], meta: { acceptance }, actor: "author", session: "" });
    const id = created.body.id;
    expect((await call("transition", { id, to: "in_progress", actor: "impl", session: "impl-session" })).status).toBe(200);
    // adding a criterion is refused
    const added = await call("update", { id, actor: "impl", session: "impl-session",
      meta: { acceptance: { ...acceptance, criteria: [...criteria, { id: "c4", statement: "self-graded extra credit", kind: "receipt" }] } } });
    expect(added.status).toBe(400);
    expect(added.body.error).toContain("cannot add, drop or relax");
    // relaxing a statement is refused
    const relaxed = await call("update", { id, actor: "impl", session: "impl-session",
      meta: { acceptance: { ...acceptance, criteria: [{ ...criteria[0], statement: "or really, anything goes" }, ...criteria.slice(1)] } } });
    expect(relaxed.status).toBe(400);
    expect(relaxed.body.error).toContain("cannot add, drop or relax");
    // deleting the bar is refused
    expect((await call("update", { id, actor: "impl", session: "impl-session", meta_delete: ["acceptance"] })).status).toBe(400);
    // attaching evidence per criterion is allowed (identity untouched)
    const evidence = { ...acceptance, criteria: [{ ...criteria[0], evidence: ["commit abc def proof"] }, ...criteria.slice(1)] };
    expect((await call("update", { id, actor: "impl", session: "impl-session", meta: { acceptance: evidence } })).status).toBe(200);
    expect((await get(id)).meta.acceptance).toMatchObject({ criteria: [
      { id: "c1", evidence: ["commit abc def proof"] },
      { id: "c2" },
      { id: "c3" },
    ] });
    // the bar itself is intact
    expect((await get(id)).meta.acceptance).toMatchObject({ criteria: [
      { id: "c1", statement: criteria[0].statement },
      { id: "c2", statement: criteria[1].statement },
      { id: "c3", statement: criteria[2].statement },
    ] });
    // the web plane keeps authoring authority (exempt actor)
    const webRelax = await call("update", { id, actor: "web:rayh",
      meta: { acceptance: { ...acceptance, criteria: [...criteria, { id: "c4", statement: "human-authored late bar", kind: "receipt" }] } } });
    expect(webRelax.status).toBe(200);
  });

  it("validates meta.acceptance on write — unknown kinds, duplicate ids, empty statements (C5 validation)", async () => {
    const bad = [
      { criteria: [{ id: "c1", statement: "s", kind: "vibes" }], authored_by: "a", basis: "b" },
      { criteria: [{ id: "c1", statement: "s", kind: "receipt" }, { id: "c1", statement: "t", kind: "receipt" }], authored_by: "a", basis: "b" },
      { criteria: [{ id: "c1", statement: "  ", kind: "receipt" }], authored_by: "a", basis: "b" },
      { criteria: [{ id: "c1", statement: "s", kind: "machine", check: { event: "deploy_the_world" } }], authored_by: "a", basis: "b" },
      { criteria: [], authored_by: "a", basis: "b" },
      { criteria: [{ id: "c1", statement: "s", kind: "receipt" }], authored_by: "", basis: "b" },
    ];
    for (const acceptance of bad) {
      const created = await call("create", { type: "task", title: "Bad acceptance", qualified: true, roles: ["impl"], meta: { acceptance }, actor: "author", session: "" });
      expect(created.status, JSON.stringify(acceptance)).toBe(400);
    }
    // machine-kind check must use the existing typed probe grammar
    const probe = { criteria: [{ id: "c1", statement: "s", kind: "machine", check: { event: "pr_merged", repo: "o/r", n: 7 } }], authored_by: "a", basis: "b" };
    const ok = await call("create", { type: "task", title: "Good machine acceptance", qualified: true, roles: ["impl"], meta: { acceptance: probe }, actor: "author", session: "" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("an execution-completion parent renders the criteria block through the outcome-review duty too (C1)", async () => {
    const created = await call("create", { type: "task", title: "Execution work with criteria",
      qualified: true, roles: ["impl"], meta: { acceptance, completion: { kind: "execution", outcome: "Run the recovery drill" } }, actor: "author", session: "" });
    const id = created.body.id;
    expect((await call("transition", { id, to: "in_progress", actor: "impl", session: "impl-session" })).status).toBe(200);
    const submitted = await call("transition", { id, to: "in_review", actor: "impl", session: "impl-session",
      execution_result: { outcome: "Recovery drill executed", receipts: [receipt] } });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const duty = await get(submitted.body.verify_task!);
    expect(duty.body_md).toContain("Independent outcome review");
    expect(duty.body_md).toContain("- c1 [receipt] the fix lands on main with a signed commit");
    expect(duty.body_md).toContain("criteria:[{id,verdict:\"met\"|\"unmet\"|\"na\",receipt}]");
  });
});
