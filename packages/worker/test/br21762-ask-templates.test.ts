import { Miniflare } from "miniflare";
import { realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let mf: Miniflare;
let stub: any;
async function call(op: string, body: object = {}) {
  const response = await stub.fetch(`https://kb/${op}`, { method: "POST", headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  mf = new Miniflare({ workers: [{ name: "main", scriptPath: bundle, modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")), modules: true, compatibilityDate: "2025-09-06", durableObjects: { KB: { className: "KnowledgeHub", useSQLite: true } } }] });
  const ns = await mf.getDurableObjectNamespace("KB");
  stub = await ns.get(ns.idFromName("br21762-ask-templates"));
  await call("orient", { actor: "test" });
});
afterAll(async () => { await mf?.dispose(); });

describe("typed ask templates (BR#21762)", () => {
  it("composes a release_hold ask end-to-end: fixed concise copy, typed one-click action, template stamped", async () => {
    const task = (await call("create", { type: "task", title: "Hold the line", qualified: true })).body.id;
    await call("transition", { id: task, to: "in_progress", actor: "owner", session: "holder-1" });
    const r = await call("ask.create", { template: { kind: "release_hold", task_id: task, subject: "holder gone; machine exits gate-refused" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const node = (await call("get", { id: r.body.id })).body;
    expect(node.type).toBe("question");
    expect(node.title.endsWith("?")).toBe(true);
    expect(node.title).toContain(task);
    const ask = node.meta.ask;
    expect(ask.template).toMatchObject({ kind: "release_hold", task_id: task });
    expect(ask.options).toEqual(["Release", "Keep held"]);
    expect(ask.decision.choices[0]).toMatchObject({ executor: "human", action: "release" });
    expect(ask.decision.task_id).toBe(task);
    expect(ask.to).toBe("human");
    expect(ask.route).toEqual({ kind: "human_decision" });
    // the ask is bound to its subject and pauses it (rule 6 fold)
    expect(ask.artefact_id).toBe(task);
    expect(node.status).toBe("todo");
    const subject = (await call("get", { id: task })).body;
    expect(subject.status).toBe("blocked");
    expect(subject.meta.awaiting_ask?.ask_id).toBe(node.id);
    // answering through the normal machinery releases the fold (the subject
    // leaves blocked and the awaiting-ask hold is consumed — the resume leg
    // routes by answer semantics; both todo and in_progress are legal exits)
    const answered = await call("ask.answer", { id: node.id, answer: "Release" });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    const resumed = (await call("get", { id: task })).body;
    expect(["todo", "in_progress"]).toContain(resumed.status);
    expect(resumed.meta.awaiting_ask?.ask_id ?? null).not.toBe(node.id);
  });

  it("refuses producer-side drift of the composed copy", async () => {
    const task = (await call("create", { type: "task", title: "Drift guard", qualified: true })).body.id;
    const drift = await call("ask.create", { template: { kind: "release_hold", task_id: task, subject: "s" }, question: "Override the copy?" });
    expect(drift.status).toBe(400);
    expect(drift.body.error).toContain("template composes");
    const mismatch = await call("ask.create", { template: { kind: "release_hold", task_id: task, subject: "s2" }, artefact_id: "BR#999999" });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error).toContain("task_id must match artefact_id");
    const wrongRoute = await call("ask.create", { template: { kind: "release_hold", task_id: task, subject: "s3" }, route: { kind: "agent_coordination" } });
    expect(wrongRoute.status).toBe(400);
    expect(wrongRoute.body.error).toContain("templates are human_decision asks");
  });

  it("the identical-open-ask guard dedupes re-asked templates on the same subject", async () => {
    const task = (await call("create", { type: "task", title: "Dedupe probe", qualified: true })).body.id;
    await call("transition", { id: task, to: "in_progress", actor: "owner", session: "holder-2" });
    const first = await call("ask.create", { template: { kind: "clear_hold", task_id: task, subject: "stale typed wait", hold: "await_event" } });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const dup = await call("ask.create", { template: { kind: "clear_hold", task_id: task, subject: "stale typed wait", hold: "await_event" } });
    expect(dup.status).toBe(400);
    expect(dup.body.error).toContain("identical ask is already open");
  });
});
