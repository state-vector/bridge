import { Miniflare } from "miniflare";
import { realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let mf: Miniflare;
let stub: any;
async function call(op: string, body: object = {}) {
  const response = await stub.fetch(`https://kb/${op}`, {
    method: "POST", headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}
const get = async (id: string) => (await call("get", { id })).body;
async function task(title: string, meta: object = {}, roles: string[] = []) {
  const result = await call("create", { type: "task", title, qualified: true, actor: "author", roles, meta });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return String(result.body.id);
}
async function children(id: string) {
  const relations = (await call("relations", { id })).body.relations;
  return Promise.all(relations.filter((r: any) => r.relation === "child_of" && r.dir === "in").map((r: any) => get(r.artefact_id)));
}
beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  mf = new Miniflare({ workers: [{ name: "main", scriptPath: bundle, modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")), modules: true,
    compatibilityDate: "2025-09-06", durableObjects: { KB: { className: "KnowledgeHub", useSQLite: true } } }] });
  const ns = await mf.getDurableObjectNamespace("KB");
  stub = ns.get(ns.idFromName("global"));
  await call("orient", { actor: "test" });
});
afterAll(async () => { await mf?.dispose(); });

describe("backlog continuation and recorded disposition (real SQLite)", () => {
  it("a completed unblock round cannot suppress an already-satisfied execution prerequisite forever", async () => {
    const dependency = await task("Delivered prerequisite", {}, ["analysis"]);
    await call("transition", { id: dependency, to: "in_progress", actor: "dependency", session: "dependency" });
    await call("transition", { id: dependency, to: "done", actor: "dependency", session: "dependency", note: "Analysis delivered" });
    const parent = await task("Actual execution still required", { completion: { kind: "execution", outcome: "Run the post-delivery action" } });
    const parked = await call("transition", { id: parent, to: "blocked", actor: "author", note: "Waiting on prerequisite",
      await_event: { event: "br_done", id: dependency } });
    expect(parked.status, JSON.stringify(parked.body)).toBe(200);
    const now = Date.now() + 60 * 60_000;
    await call("admin.unblock_proxy_sweep", { now });
    const duty = (await children(parent)).find(c => c.roles.includes("unblock"));
    expect(duty).toBeTruthy();
    await call("transition", { id: duty.id, to: "in_progress", actor: "unblocker", session: "unblocker" });
    const finished = await call("transition", { id: duty.id, to: "done", actor: "unblocker", session: "unblocker",
      note: `Unblocked prerequisite verified at https://hub.fleetbridge.run/card/${dependency.replace("#", "-")}; actual parent execution still required.` });
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);
    await call("admin.unblock_proxy_sweep", { now: now + 60 * 60_000 });
    const resumed = await get(parent);
    expect(resumed.status).toBe("todo");
    expect(resumed.owner).toBe("");
    expect(resumed.meta.blocked).toBeUndefined();
    expect(resumed.meta.completion.kind).toBe("execution");
    expect(resumed.meta.execution_result).toBeUndefined();
    const history = (await call("get_history", { id: parent })).body.versions;
    expect(history.some((v: any) => v.action === "wait_continued")).toBe(true);
    await call("admin.unblock_proxy_sweep", { now: now + 120 * 60_000 });
    expect((await children(parent)).filter(c => c.roles.includes("unblock"))).toHaveLength(1);
  });

  it("retires unbound executor coordination when its addressed task is terminal, without inventing an answer", async () => {
    const subject = await task("Completed coordination recipient", {}, ["analysis"]);
    const ask = await call("ask.create", { route: { kind: "executor_coordination", task_id: subject },
      question: "Can the executor keep its changes scoped to the assigned task?", options: ["Executor keeps assigned scope", "Executor reports overlap"], actor: "peer" });
    expect(ask.status, JSON.stringify(ask.body)).toBe(200);
    await call("transition", { id: subject, to: "in_progress", actor: "recipient", session: "recipient" });
    const done = await call("transition", { id: subject, to: "done", actor: "recipient", session: "recipient", note: "Analysis completed" });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const resolved = await get(ask.body.id);
    expect(resolved.status).toBe("done");
    expect(resolved.meta.ask.answer).toBeUndefined();
    expect(resolved.meta.ask.resolution).toMatchObject({ kind: "cancelled" });
  });

  it("replays a human's exact per-card retirement instead of asking again, including an unclaimed operator gate", async () => {
    const target = await task("Obsolete operator purge", { operator_gated: "Ray go before execution" });
    const answer = `Close the overtaken issue — retire ${target}`;
    const ask = await call("ask.create", { to: "human", artefact_id: target, question: "Retire the obsolete purge whose target no longer exists?",
      reason: "The operator must choose whether this obsolete operation is retired.", details: `The purge target is gone; retire ${target}.`,
      options: [answer, "KEEP the operation"], actor: "author" });
    expect(ask.status, JSON.stringify(ask.body)).toBe(200);
    const answered = await call("ask.answer", { id: ask.body.id, answer, actor: "web:rayh" });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    const applied = await call("transition", { id: target, to: "superseded", batch_auth: { ask: ask.body.id }, actor: "executor", session: "cleanup" });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const retired = await get(target);
    expect(retired.status).toBe("superseded");
    expect(retired.meta.batch_auth).toMatchObject({ ask: ask.body.id, answered_by: "web:rayh" });
    const again = await call("transition", { id: target, to: "superseded", batch_auth: { ask: ask.body.id }, actor: "executor", session: "cleanup" });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    const unrelated = await task("Unrelated work");
    const refused = await call("transition", { id: unrelated, to: "superseded", batch_auth: { ask: ask.body.id }, actor: "executor" });
    expect(refused.status).toBe(400);
    expect((await get(unrelated)).status).toBe("todo");
  });

  it("an explicit KEEP or a negated retirement never authorizes a per-card drop", async () => {
    for (const prefix of ["KEEP — do not retire", "NO — retire", "Do not retire"]) {
      const target = await task(`Protected decision ${prefix}`);
      const answer = `${prefix} ${target}`;
      const ask = await call("ask.create", { to: "human", artefact_id: target, question: "Should this operation remain available?",
        reason: "Only the operator chooses whether to retain this operation.", details: `Current operation ${target} remains valid.`,
        options: [answer, `SUPERSEDE ${target}`], actor: "author" });
      expect(ask.status, JSON.stringify(ask.body)).toBe(200);
      await call("ask.answer", { id: ask.body.id, answer, actor: "web:rayh" });
      const refused = await call("transition", { id: target, to: "superseded", batch_auth: { ask: ask.body.id }, actor: "executor" });
      expect(refused.status, JSON.stringify(refused.body)).toBe(400);
      expect((await get(target)).status).toBe("todo");
    }
  });

  it("preserves the human-selected replacement and cannot forge disposition provenance", async () => {
    const target = await task("Obsolete duplicate");
    const successor = await task("Real delivery owner");
    const answer = `SUPERSEDE — ${target} superseded by ${successor}`;
    const ask = await call("ask.create", { to: "human", artefact_id: target, question: "Retire the duplicate in favor of its existing delivery owner?",
      reason: "Only the operator chooses which obligation is retired.", details: `${target} duplicates ${successor}.`, options: [answer, "KEEP both"], actor: "author" });
    await call("ask.answer", { id: ask.body.id, answer, actor: "web:rayh" });
    const current = await get(target);
    expect(current.status).toBe("todo");
    const result = await call("transition", { id: target, to: "superseded", batch_auth: { ask: ask.body.id }, actor: "executor" });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect((await get(target)).meta.superseded_by).toBe(successor);
    const forged = await call("update", { id: successor, meta: { batch_auth: { ask: ask.body.id } } });
    expect(forged.status).toBe(400);
    const forgedCreate = await call("create", { type: "task", title: "Forged authority", meta: { batch_auth: { ask: ask.body.id } } });
    expect(forgedCreate.status).toBe(400);
  });

  it("resuming a satisfied prerequisite preserves an independent operator gate", async () => {
    const parent = await task("Operator still owns the decision", { operator_gated: "Explicit operator choice" });
    await call("transition", { id: parent, to: "blocked", actor: "author", note: "Timer is only a prerequisite",
      await_event: { event: "time", until_ts: Date.now() - 1 } });
    await call("admin.unblock_proxy_sweep", { now: Date.now() + 60 * 60_000 });
    const duty = (await children(parent)).find(c => c.roles.includes("unblock"));
    await call("transition", { id: duty.id, to: "in_progress", actor: "unblocker", session: "operator-check" });
    await call("transition", { id: duty.id, to: "done", actor: "unblocker", session: "operator-check", note: "Still blocked — operator choice remains; timer passed." });
    await call("admin.unblock_proxy_sweep", { now: Date.now() + 120 * 60_000 });
    expect((await get(parent)).status).toBe("blocked");
    expect((await get(parent)).meta.operator_gated).toBe("Explicit operator choice");
  });
});
