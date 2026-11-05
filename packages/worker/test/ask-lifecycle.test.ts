import { Miniflare } from "miniflare";
import { realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { askLifecycle, askRoute, isHumanDecisionAsk } from "@bridge/contracts";
import { exitClassOf } from "../../ui-kit/src/server/views";

let mf: Miniflare;
let stub: any;
async function call(op: string, body: object = {}) {
  const res = await stub.fetch(`https://kb/${op}`, { method: "POST", headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
}
beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  mf = new Miniflare({ workers: [{ name: "main", scriptPath: bundle, modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")), modules: true, compatibilityDate: "2025-09-06", durableObjects: { HUB: { className: "FlowsHub", useSQLite: true }, KB: { className: "KnowledgeHub", useSQLite: true } } }] });
  const ns = await mf.getDurableObjectNamespace("KB");
  stub = await ns.get(ns.idFromName("global"));
  await call("orient", { actor: "test" });
});
afterAll(async () => { await mf?.dispose(); });

const sha = "d25492985b946f814c4f3fa8134031d59c96bc26";
const ci = "https://github.com/state-vector/bridge/actions/runs/41931831809";
async function submit(title: string, stalePr = false) {
  const created = await call("create", { type: "task", title, qualified: true, actor: "impl", session: "impl", meta: stalePr ? { review_pr: { repo: "state-vector/bridge", number: 400 }, pr: { repo: "state-vector/bridge", number: 400 } } : {} });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const id = created.body.id;
  expect((await call("transition", { id, to: "in_progress", actor: "impl", session: "impl" })).status).toBe(200);
  const review = await call("transition", { id, to: "in_review", actor: "impl", session: "impl", note: `Landed https://github.com/state-vector/bridge/commit/${sha}` });
  expect(review.status, JSON.stringify(review.body)).toBe(200);
  return { id, review: review.body.verify_task };
}

describe("request audience and lifecycle", () => {
  it("bare agents, coordinator tokens, sessions, tags and pools are not human decisions", () => {
    for (const to of ["macbook-pro-local-2", "opencode-ray", "peer@unknown", "tag:review", "any"]) expect(isHumanDecisionAsk({ to })).toBe(false);
    for (const to of ["human", "ray", "rayh"]) expect(isHumanDecisionAsk({ to })).toBe(true);
    expect(askRoute({ to: "human", route: { kind: "agent_coordination" } }).kind).toBe("agent_coordination");
  });

  it("stores a complete 240-character question without chopping it to 200", async () => {
    const question = `Can you confirm ${"x".repeat(222)}?`;
    const res = await call("ask.create", { to: "peer", question, options: ["No overlap", "Overlapping edits"] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const get = await call("get", { id: res.body.id });
    expect(get.body.title).toBe(question);
  });

  it("No overlap answers atomically, disappears from inbox, and cannot be escalated or answered twice", async () => {
    const ask = await call("ask.create", { to: "unseen-peer", question: "Are our changes overlapping?", options: ["No overlap", "Overlapping edits"], actor: "sender" });
    const id = ask.body.id;
    const progress = await call("progress.log", { id, note: "No overlap", actor: "unseen-peer" });
    expect(progress.status, JSON.stringify(progress.body)).toBe(200);
    const before = await call("get", { id });
    expect(askLifecycle(before.body).state).toBe("open");
    expect((await call("transition", { id, to: "done", actor: "unseen-peer", note: "No overlap" })).status).toBe(400);
    expect((await call("ask.answer", { id, answer: "No overlap", actor: "unseen-peer" })).status).toBe(200);
    const node = (await call("get", { id })).body;
    expect(askLifecycle(node)).toEqual({ state: "answered", answer: "No overlap", by: "unseen-peer" });
    await call("admin.ask_escalation_sweep", { now: Date.now() + 3_600_000 });
    expect((await call("get", { id })).body.meta.ask.recovery).toBeUndefined();
    expect((await call("ask.answer", { id, answer: "different", actor: "unseen-peer" })).status).toBe(400);
    expect((await call("update", { id, meta: { ask: { ...node.meta.ask, answer: "forged" } } })).status).toBe(400);
    expect((await call("ask.inbox", { label: "unseen-peer" })).body.inbox.some((x: any) => x.id === id)).toBe(false);
    expect((await call("ask.inbox", { label: "sender" })).body.sent.find((x: any) => x.id === id)).toMatchObject({ status: "answered", answer: "No overlap" });
  });

  it("follows the current executor when a task is released and claimed by a different agent", async () => {
    const task = (await call("create", { type: "task", title: "Overlap target", qualified: true })).body.id;
    await call("transition", { id: task, to: "in_progress", actor: "first", session: "first-session" });
    const ask = await call("ask.create", { route: { kind: "executor_coordination", task_id: task }, question: "Do your edits overlap the ask interface?", options: ["No overlap", "Coordinate edits"] });
    expect(ask.status, JSON.stringify(ask.body)).toBe(200);
    expect((await call("ask.inbox", { label: "first" })).body.inbox.some((x: any) => x.id === ask.body.id)).toBe(true);
    await call("transition", { id: task, to: "todo", actor: "web:rayh" });
    await call("transition", { id: task, to: "in_progress", actor: "second", session: "second-session" });
    expect((await call("ask.inbox", { label: "first" })).body.inbox.some((x: any) => x.id === ask.body.id)).toBe(false);
    expect((await call("ask.inbox", { label: "second" })).body.inbox.find((x: any) => x.id === ask.body.id)?.to_target).toBe("second@second-session");
  });

  it("distinguishes agent coordination in Backlog from a human decision", () => {
    expect(exitClassOf({ status: "blocked", meta: { awaiting_ask: { ask_id: "BR#1", route: { kind: "agent_coordination" } } } }).key).toBe("coordination");
  });

  it("review requests reuse the dispatched round and create no human question", async () => {
    const task = await submit("Independent review belongs to Bridge");
    const request = { route: { kind: "independent_review", task_id: task.id } };
    const first = await call("ask.create", request);
    const second = await call("ask.create", request);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.id).toBe(task.review);
    expect(second.body.id).toBe(first.body.id);
    expect(first.body.kind).toBe("independent_review");
    expect(first.body.message).toContain("No action is needed from you");
  });

  it("accepted main delivery beats obsolete PR metadata and retires linked coordination", async () => {
    const task = await submit("Successor of obsolete PR 400", true);
    const review = (await call("get", { id: task.review })).body;
    expect(review.body_md).toContain(`/commit/${sha}`);
    expect(review.body_md).not.toContain("gh pr view");
    const ask = await call("ask.create", { to: "peer", question: "Can you arrange the independent check?", options: ["Arrange review", "Wait"], artefact_id: task.id });
    expect(ask.status, JSON.stringify(ask.body)).toBe(200);
    await call("transition", { id: task.review, to: "in_progress", actor: "reviewer", session: "reviewer" });
    const done = await call("transition", { id: task.review, to: "done", actor: "reviewer", session: "reviewer", review_result: { kind: "accepted_direct_main", repo: "state-vector/bridge", commit: sha, ci_run_url: ci }, note: `Verified https://github.com/state-vector/bridge/commit/${sha} ${ci}` });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const parent = (await call("get", { id: task.id })).body;
    expect(parent.status, JSON.stringify((await call("events?since=0&limit=500")).body)).toBe("done");
    expect(parent.meta.merge_train).toBeUndefined();
    expect(parent.meta.review_pr).toBeUndefined();
    const retired = (await call("get", { id: ask.body.id })).body;
    expect(askLifecycle(retired).state).toBe("cancelled");
    expect(retired.meta.ask.answer).toBeUndefined();
  });

  it("findings close does not accept implementation just because its body has a commit", async () => {
    const task = await submit("A findings verdict is not acceptance");
    await call("transition", { id: task.review, to: "in_progress", actor: "reviewer2", session: "reviewer2" });
    const done = await call("transition", { id: task.review, to: "done", actor: "reviewer2", session: "reviewer2", review_result: { kind: "findings", summary: "Cannot assess deployed interface" }, note: `Cannot proceed: deployed interface unavailable; receipt ${ci}` });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await call("get", { id: task.id })).body.status).toBe("in_review");
  });

  it("replays an interrupted accepted review after a real human decision resolves, without asking for a second review", async () => {
    const task = await submit("Recover interrupted acceptance", true);
    const ask = await call("ask.create", { to: "human", question: "Should Bridge retain the historical records?", reason: "Only you can choose the retention policy.", details: "The implementation is delivered. The retention policy still needs your decision.", options: ["Retain records", "Delete records"], artefact_id: task.id });
    await call("transition", { id: task.review, to: "in_progress", actor: "healing-reviewer", session: "healing-reviewer" });
    const done = await call("transition", { id: task.review, to: "done", actor: "healing-reviewer", session: "healing-reviewer", review_result: { kind: "accepted_direct_main", repo: "state-vector/bridge", commit: sha, ci_run_url: ci }, note: `Verified commit ${sha} ${ci}` });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await call("get", { id: task.id })).body.status).toBe("in_review");
    expect((await call("get", { id: ask.body.id })).body.status).toBe("todo");
    const wait = await call("ask.create", { route: { kind: "independent_review", task_id: task.id } });
    expect(wait.body.status).toBe("awaiting_dependencies");
    await call("ask.answer", { id: ask.body.id, answer: "Retain records", actor: "web:rayh" });
    await call("admin.ask_escalation_sweep", { now: Date.now() });
    expect((await call("get", { id: task.id })).body.status).toBe("done");
  });

  it("concurrent answer attempts record exactly one authoritative answer", async () => {
    const ask = await call("ask.create", { to: "peer", question: "Do our changes overlap now?", options: ["No overlap", "Overlap"] });
    const results = await Promise.all([call("ask.answer", { id: ask.body.id, answer: "No overlap", actor: "peer" }), call("ask.answer", { id: ask.body.id, answer: "Overlap", actor: "peer2" })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const node = (await call("get", { id: ask.body.id })).body;
    expect(askLifecycle(node).state).toBe("answered");
  });
});
