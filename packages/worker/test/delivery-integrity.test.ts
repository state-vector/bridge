import { Miniflare } from "miniflare";
import { realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let mf: Miniflare;
let stub: any;
const repo = "state-vector/delivery-drill";
const head = "a".repeat(40);
async function call(op: string, body: object = {}) {
  const res = await stub.fetch(`https://kb/${op}`, { method: "POST", headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
}
const get = async (id: string) => (await call("get", { id })).body;
async function create(number: number) {
  const r = await call("create", { type: "task", title: `Delivery ${number}`, qualified: true, actor: "impl", meta: { pr: { repo, number } } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return String(r.body.id);
}
beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  mf = new Miniflare({ workers: [{ name: "main", scriptPath: bundle, modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")), modules: true, compatibilityDate: "2025-09-06", durableObjects: { KB: { className: "KnowledgeHub", useSQLite: true } } }] });
  const ns = await mf.getDurableObjectNamespace("KB");
  stub = await ns.get(ns.idFromName("global"));
  await call("orient", { actor: "test" });
});
afterAll(async () => { await mf?.dispose(); });

describe("delivery responsibility (real SQLite hub)", () => {
  it("refuses a bare terminal drop without mutating source; replacement transfers bindings atomically", async () => {
    const id = await create(1);
    const before = await get(id);
    const refused = await call("supersede.task", { id, actor: "web:rayh" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("delivery responsibility");
    expect((await get(id)).status).toBe(before.status);
    const successor = await create(2);
    const replaced = await call("supersede.task", { id, replacement_id: successor, actor: "web:rayh" });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    expect((await get(id)).meta.delivery_disposition.kind).toBe("replace");
    expect((await get(successor)).meta.prs.map((l: any) => l.number).sort()).toEqual([1, 2]);
  });

  it("refuses terminal replacements, retains bounded holds and protects disposition metadata", async () => {
    const id = await create(3);
    const deadline = Date.now() + 3_600_000;
    const held = await call("supersede.task", { id, actor: "web:rayh", disposition: { kind: "hold", owner: "impl", reason: "family dependency", next: "Observe family delivery", deadline } });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    expect((await get(id)).meta.delivery_disposition).toMatchObject({ kind: "hold", deadline, owner: "impl" });
    expect((await call("update", { id, meta: { delivery_disposition: { kind: "abandon", closure: { phase: "closed", receipts: ["forged"] } } } })).status).toBe(400);
  });

  it("authorised abandonment remains pending and owned until a closure executor returns accepted receipts", async () => {
    const id = await create(4);
    const abandon = await call("supersede.task", { id, actor: "web:rayh", disposition: { kind: "abandon", reason: "Product outcome explicitly cancelled" } });
    expect(abandon.status, JSON.stringify(abandon.body)).toBe(200);
    const source = await get(id);
    expect(source.status).toBe("blocked");
    expect(source.owner).toBeTruthy();
    const d = source.meta.delivery_disposition;
    expect(d.closure.phase).toBe("pending");
    const duty = await get(d.closure.duty_id);
    expect(duty.meta.closure_authority).toMatchObject({ actor: "web:rayh", legs: [{ repo, number: 4 }] });
    const again = await call("supersede.task", { id, actor: "web:rayh", disposition: { kind: "abandon", reason: "Same authorisation" } });
    expect(again.body.disposition.closure.duty_id).toBe(d.closure.duty_id);
    const close = d.closure.duty_id;
    const receipt = `https://github.com/${repo}/pull/4 — state CLOSED`;
    expect((await call("transition", { id: close, to: "in_progress", actor: "closer", session: "closure-4" })).status).toBe(200);
    const submitted = await call("transition", { id: close, to: "in_review", actor: "closer", session: "closure-4", note: "Executed authorised close; re-read GitHub state CLOSED.", execution_result: { outcome: "PR closed", receipts: [receipt] } });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect((await get(id)).status).toBe("blocked");
    const review = submitted.body.verify_task;
    await call("transition", { id: review, to: "in_progress", actor: "closure-reviewer", session: "closure-review-4" });
    const accepted = await call("transition", { id: review, to: "done", actor: "closure-reviewer", session: "closure-review-4", note: `Verified actual closure ${receipt}`, review_result: { kind: "accepted_execution", task_id: close, receipts: [receipt] } });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((await get(id)).status).toBe("superseded");
    expect((await get(id)).meta.delivery_disposition.closure.phase).toBe("closed");
  });

  it("old decisionless PRs acquire one duty; a fresh one has bounded grace; changed heads get a new episode", async () => {
    const r = "state-vector/decisionless-drill";
    const row = (number: number, age: number, sha = head) => ({ number, title: "Decisionless", reviewDecision: "", headRefOid: sha, updatedAt: new Date(Date.now() - age * 3_600_000).toISOString() });
    const first = await call("reconcile.report", { repo: r, prs: [row(10, 50), row(11, 1)] });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.accounting.open_total).toBe(2);
    expect(first.body.spawned).toHaveLength(1);
    const duty = first.body.spawned[0].card;
    expect((await call("reconcile.report", { repo: r, prs: [row(10, 50), row(11, 1)] })).body.spawned).toHaveLength(0);
    // Retire the duty by explicit replacement: it binds the PR, so it cannot
    // simply be dropped. The ledger's completed episode still re-arms on head.
    const successor = (await call("create", { type: "task", title: "Successor", actor: "test" })).body.id;
    expect((await call("supersede.task", { id: duty, replacement_id: successor, actor: "web:rayh" })).status).toBe(200);
    const changed = await call("reconcile.report", { repo: r, prs: [row(10, 50, "b".repeat(40))] });
    expect(changed.status).toBe(200);
    const ledger = (await call("reconcile.status", { repo: r })).body.duties;
    expect(ledger.every((d: any) => d.duty_id !== duty)).toBe(true);
  });

  it("typed PR acceptance queues the exact accepted head, and replay is idempotent", async () => {
    const id = await create(20);
    expect((await call("transition", { id, to: "in_progress", actor: "impl", session: "impl-20" })).status).toBe(200);
    const submitted = await call("transition", { id, to: "in_review", actor: "impl", session: "impl-20", note: `PR https://github.com/${repo}/pull/20` });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const review = submitted.body.verify_task;
    expect((await call("transition", { id: review, to: "in_progress", actor: "reviewer", session: "review-20" })).status).toBe(200);
    const accepted = await call("transition", { id: review, to: "done", actor: "reviewer", session: "review-20", review_result: { kind: "accepted_pr", task_id: id, legs: [{ repo, number: 20, head_sha_at_acceptance: head }] }, note: `Verified https://github.com/${repo}/pull/20 head ${head}` });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((await get(id)).meta.pr.head_sha_at_acceptance).toBe(head);
    expect((await get(id)).meta.merge_train.state).toBe("queued");
    await call("orient", { actor: "test" });
    expect((await get(id)).meta.pr.head_sha_at_acceptance).toBe(head);
  });

  it("a standalone historical ACCEPT restores delivery even when its exact bound parent is already done", async () => {
    const original = await call("create", { type: "task", title: "Historical done parent", roles: ["analysis"], actor: "old-impl", meta: { pr: { repo, number: 2329 } } });
    const id = original.body.id;
    expect((await call("transition", { id, to: "in_progress", actor: "old-impl" })).status).toBe(200);
    expect((await call("transition", { id, to: "done", actor: "old-impl", note: "Analysis outcome complete" })).status).toBe(200);
    await call("reconcile.report", { repo, prs: [{ number: 2329, state: "OPEN", headRefOid: head, updatedAt: new Date().toISOString() }] });
    const review = (await call("create", { type: "task", title: "Standalone review", roles: ["review"], actor: "fresh-reviewer" })).body.id;
    expect((await call("transition", { id: review, to: "in_progress", actor: "fresh-reviewer", session: "fresh-2329" })).status).toBe(200);
    const accepted = await call("transition", { id: review, to: "done", actor: "fresh-reviewer", session: "fresh-2329", note: `VERDICT: ACCEPT — head ${head}. PR https://github.com/${repo}/pull/2329. Scope ${id}. A prior attempt was rejected; this acceptance is at the live head.` });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((await get(id)).status).toBe("done");
    // Fresh observation AFTER the acceptance seals the historical handoff.
    await call("reconcile.report", { repo, prs: [{ number: 2329, state: "OPEN", headRefOid: head, updatedAt: new Date().toISOString() }] });
    await call("admin.alarm_sweep");
    const lane = await call("train.status", { repo });
    expect(lane.status, JSON.stringify(lane.body)).toBe(200);
    const cards = (await call("list", { type: "task", limit: 200 })).body.artefacts;
    const successor = await Promise.all(cards.map((c: any) => get(c.id)));
    const queued = successor.find(c => c.meta?.delivery_predecessor === id);
    expect(queued, JSON.stringify(successor.map(c => ({ id: c.id, meta: c.meta })))).toBeTruthy();
    expect(queued.meta.merge_train.state).toBe("queued");
    expect(queued.meta.pr.head_sha_at_acceptance).toBe(head);
  });

  it("superseded dependencies wait for a replacement outcome; bare retirement is never success", async () => {
    const createPlain = async (title: string, roles: string[] = []) => (await call("create", { type: "task", title, roles, actor: "test", qualified: true })).body.id;
    const predecessor = await createPlain("Retired dependency");
    const successor = await createPlain("Replacement outcome", ["analysis"]);
    await call("supersede.task", { id: predecessor, replacement_id: successor, actor: "web:rayh" });
    const dependent = await createPlain("Outcome consumer");
    await call("transition", { id: dependent, to: "in_progress", actor: "test" });
    const parked = await call("transition", { id: dependent, to: "blocked", actor: "test", note: "Wait for dependency outcome", await_event: { event: "br_done", id: predecessor } });
    expect(parked.status, JSON.stringify(parked.body)).toBe(200);
    await call("admin.unblock_proxy_sweep", { now: Date.now() + 60 * 60_000 });
    expect((await get(dependent)).meta.proxy_check.verdict).toBe("false");
    await call("transition", { id: successor, to: "in_progress", actor: "successor" });
    await call("transition", { id: successor, to: "done", actor: "successor", note: "Replacement outcome completed" });
    await call("admin.unblock_proxy_sweep", { now: Date.now() + 90 * 60_000 });
    expect((await get(dependent)).meta.proxy_check.verdict).toBe("true");
  });

  it("closing an unblock duty can atomically replace its parent's consumed predicate", async () => {
    const parent = await create(30);
    await call("transition", { id: parent, to: "in_progress", actor: "impl" });
    await call("transition", { id: parent, to: "blocked", actor: "impl", note: "Waiting for old timer", await_event: { event: "time", until_ts: Date.now() + 3_600_000 } });
    const relations = (await call("relations", { id: parent })).body.relations;
    const children = await Promise.all(relations.filter((r: any) => r.relation === "child_of" && r.dir === "in").map((r: any) => get(r.artefact_id)));
    const duty = children.find(c => c.roles.includes("unblock"));
    expect(duty).toBeTruthy();
    await call("transition", { id: duty.id, to: "in_progress", actor: "unblocker", session: "unblock-30" });
    const next = { event: "pr_checks_green", repo, n: 30 };
    const done = await call("transition", { id: duty.id, to: "done", actor: "unblocker", session: "unblock-30", note: `Still blocked on actual checks https://github.com/${repo}/pull/30`, unblock_result: { kind: "reblocked", parent_id: parent, reason: "Checks failing", next: "Observe repaired checks at live head", await_event: next } });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await get(parent)).meta.blocked.await_event).toEqual(next);
    expect((await get(parent)).meta.blocked.reason).toBe("Checks failing");
    expect((await get(duty.id)).status).toBe("done");
  });
});
