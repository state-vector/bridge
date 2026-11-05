import { Miniflare } from "miniflare";
import { realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { askLifecycle, askRoute, isHumanDecisionAsk, planTaskRecovery, mergeCompletesTask } from "@bridge/contracts";
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

  it("the recovery decision table has no human outcome, and current execution/dependencies outrank old queue state", () => {
    const facts = { status: "in_progress", phase: "queued", live_executor: true, queue_admitted: false, is_delivery: true, has_other_wait: false };
    expect(planTaskRecovery(facts).kind).toBe("owned");
    expect(planTaskRecovery({ ...facts, status: "in_review" }).kind).toBe("none");
    expect(planTaskRecovery({ ...facts, status: "blocked", has_other_wait: true }).kind).toBe("none");
    expect(planTaskRecovery({ ...facts, status: "blocked", is_delivery: false }).kind).toBe("none");
    expect(planTaskRecovery({ ...facts, status: "blocked", phase: "unbound" })).toEqual({ kind: "dispatch", reason: "queue_binding" });
    expect(mergeCompletesTask({ depends_on: "PR403 deployed" })).toBe(false);
  });

  it("a claimed repair does not get requeued or create a human strand request; its obsolete diagnostic is cancelled", async () => {
    const old = Date.now() - 3 * 3_600_000;
    const mint = await call("admin.mint", { label: "repair-owner", tags: [] });
    await call("auth.identify", { bearer: mint.body.secret });
    await call("orient", { actor: "repair-owner", token_id: mint.body.id, session: "repair-session" });
    const task = (await call("create", { type: "task", title: "Backlog recovery repair", qualified: true, meta: { merge_train: { state: "queued", repo: "state-vector/bridge", pr: 402, at: old }, strand_alarm: { at: old, class: "queued_out_of_queue" } } })).body.id;
    expect((await call("transition", { id: task, to: "in_progress", actor: "repair-owner", session: "repair-session" })).status).toBe(200);
    await call("progress.log", { id: task, actor: "repair-owner", session: "repair-session", note: "Repairing failing tests" });
    const sink = (await call("create", { type: "task", title: "Alarm sink", meta: { infra_anchor: true } })).body.id;
    await call("admin.settings_set", { settings: { train_alarm_sink_id: sink } });
    const obsolete = await call("ask.create", { to: "human", actor: "system:train", question: `${task} sits out of the merge queue on a train-only wait (pr_merged) while state-vector/bridge kept merging — need a human leg?`, reason: "Old diagnostic", details: "Old queue diagnostic", options: ["Investigate", "Release"], artefact_id: sink });
    expect(obsolete.status, JSON.stringify(obsolete.body)).toBe(200);
    await call("admin.alarm_sweep");
    const parent = (await call("get", { id: task })).body;
    expect(parent.status).toBe("in_progress");
    expect(parent.meta.recovery).toBeUndefined();
    expect((await call("get", { id: obsolete.body.id })).body.meta.ask.resolution.kind).toBe("cancelled");
  });

  it("a prerequisite merge resumes execution instead of closing it, despite a copied delivery PR stamp", async () => {
    const repo = "state-vector/prereq-test";
    await call("train.lane", { repo, spec: { required_workflows: [] } });
    await call("train.lease", { repo, action: "acquire", actor: "prereq-gateway" });
    const execution = (await call("create", { type: "task", title: "Apply authorised cleanup after support code deploys", qualified: true, meta: { depends_on: "PR403 deployed", completion: { kind: "execution", outcome: "Each target has a disposition receipt" }, pr: { repo, number: 403 }, merge_train: { state: "queued", repo, pr: 403 } } })).body.id;
    await call("transition", { id: execution, to: "in_progress", actor: "cleanup", session: "cleanup" });
    const park = await call("transition", { id: execution, to: "blocked", actor: "cleanup", session: "cleanup", note: "Wait for prerequisite support code", await_event: { event: "pr_merged", repo, n: 403 } });
    expect(park.status, JSON.stringify(park.body)).toBe(200);
    expect((await call("train.status", { repo })).body.lanes[0].queue).not.toContainEqual(expect.objectContaining({ id: execution }));
    await call("train.event", { repo, kind: "merged", actor: "prereq-gateway", pr: 403, merge_sha: "e".repeat(40), head_sha: "f".repeat(40) });
    await call("admin.alarm_sweep");
    const after = (await call("get", { id: execution })).body;
    expect(after.status).toBe("todo");
    expect(after.meta.prerequisite_receipt.pr).toBe(403);
    expect(after.meta.merge_train).toBeUndefined();
    await call("transition", { id: execution, to: "in_progress", actor: "cleanup2", session: "cleanup2" });
    const falseDone = await call("transition", { id: execution, to: "done", actor: "cleanup2", session: "cleanup2", note: `Prerequisite merged ${ci}` });
    expect(falseDone.status).toBe(400);
    expect(falseDone.body.error).toContain("execution_result");
    const completed = await call("transition", { id: execution, to: "in_review", actor: "cleanup2", session: "cleanup2", note: "All actions executed; inspect the outcome receipts.", execution_result: { outcome: "Each target has a disposition receipt", receipts: [`https://hub.fleetbridge.run/card/${execution.replace("#", "-")}`] } });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    const verify = completed.body.verify_task;
    const duty = (await call("get", { id: verify })).body;
    expect(duty.body_md).toContain("actual execution_result");
    expect(duty.body_md).not.toContain("gh pr view");
    await call("transition", { id: verify, to: "in_progress", actor: "outcome-reviewer", session: "outcome-reviewer" });
    const accepted = await call("transition", { id: verify, to: "done", actor: "outcome-reviewer", session: "outcome-reviewer", review_result: { kind: "accepted_execution", task_id: execution, receipts: [`https://hub.fleetbridge.run/card/${execution.replace("#", "-")}`] }, note: "Verified every applied target; passed execution outcome checks." });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((await call("get", { id: execution })).body.status).toBe("done");
  });

  it("human choices require an actual subject and execute typed consequences rather than verbs in labels", async () => {
    expect((await call("ask.create", { route: { kind: "human_decision" }, question: "Investigate the queue?", reason: "Machine uncertainty", details: "diagnostic", options: ["Investigate", "Release"] })).status).toBe(400);
    const task = (await call("create", { type: "task", title: "Retention policy choice", qualified: true })).body.id;
    await call("transition", { id: task, to: "in_progress", actor: "choice-owner", session: "choice-owner" });
    const decision = { kind: "preference", task_id: task, context: "Choose whether records are kept.", why_human: "This is your retention policy.", choices: [{ label: "Release old records", executor: "bridge", consequence: "Bridge continues implementing deletion.", action: "resume" }, { label: "Keep all records", executor: "bridge", consequence: "Bridge waits for a revised policy.", action: "hold" }] };
    const ask = await call("ask.create", { route: { kind: "human_decision" }, question: "Should Bridge delete old records?", decision });
    expect(ask.status, JSON.stringify(ask.body)).toBe(200);
    const answer = await call("ask.answer", { id: ask.body.id, answer: "Release old records", actor: "web:rayh" });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect((await call("get", { id: task })).body.status).toBe("in_progress");
    const invalid = await call("ask.create", { route: { kind: "human_decision" }, artefact_id: "BR#3124", question: "Should Bridge continue?", decision });
    expect(invalid.status).toBe(400);
  });
});
