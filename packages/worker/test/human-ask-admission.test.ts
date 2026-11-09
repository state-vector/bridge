import { Miniflare } from "miniflare";
import { realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HumanDecisionSchema } from "@bridge/contracts";

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
  stub = await ns.get(ns.idFromName("human-ask-admission"));
  await call("orient", { actor: "test" });
});
afterAll(async () => { await mf?.dispose(); });

const question = "Should Bridge retain records for longer than thirty days?";
const options = ["Bridge keeps thirty days", "Bridge keeps ninety days"];
const decision = (task: string) => ({ kind: "preference", task_id: task,
  context: "The export works. We still need your retention policy before scheduling deletion.",
  why_human: "Only you can choose how long your organisation keeps these records.",
  choices: options.map(label => ({ label, executor: "bridge", consequence: `${label}; deletion remains paused until this policy is implemented.`, action: "hold" })),
});

describe("every human ask passes the same admission rule", () => {
  it("rejects the missing-route bypass for every human alias, including an automatic producer", async () => {
    for (const to of ["human", "ray", "rayh"]) {
      const result = await call("ask.create", { to, actor: "hub:proxy-watch", question: "Re-scope, release, or drop?", reason: "Unparseable wait", details: "Raw event grammar", options: ["RE-SCOPE", "RELEASE", "SUPERSEDE"] });
      expect(result.status, JSON.stringify(result.body)).toBe(400);
      expect(result.body.error).toContain("human_decision requires decision");
    }
    expect((await call("list", { type: "question" })).body.artefacts).toHaveLength(0);
  });

  it("cannot bypass admission with direct create or metadata update", async () => {
    const ask = { to: "human", options: ["GO", "NO-GO"], reason: "Choose" };
    expect((await call("create", { type: "question", title: question, meta: { ask } })).status).toBe(400);
    const node = await call("create", { type: "question", title: question });
    expect((await call("update", { id: node.body.id, meta: { ask } })).status).toBe(400);
    expect((await call("get", { id: node.body.id })).body.meta.ask).toBeUndefined();
  });

  it("stores a genuine inferred-human decision and preserves its typed hold effect", async () => {
    const task = (await call("create", { type: "task", title: "Implement the chosen retention policy", qualified: true })).body.id;
    await call("transition", { id: task, to: "in_progress", actor: "owner", session: "owner" });
    const ask = await call("ask.create", { to: "ray", question, decision: decision(task) });
    expect(ask.status, JSON.stringify(ask.body)).toBe(200);
    const stored = (await call("get", { id: ask.body.id })).body;
    expect(stored.meta.ask.options).toEqual(options);
    expect(stored.meta.ask.reason).toBe(decision(task).why_human);
    expect((await call("update", { id: ask.body.id, meta: { ask: { ...stored.meta.ask, options: ["Release", "Keep"] } } })).status).toBe(400);
    expect((await call("ask.answer", { id: ask.body.id, answer: options[0], actor: "web:rayh" })).status).toBe(200);
    expect((await call("get", { id: task })).body.status).toBe("blocked");
  });

  it("rejects whitespace-only context, misleading labels and a later recommended option", () => {
    const valid = decision("BR#1");
    expect(HumanDecisionSchema.safeParse({ ...valid, context: "  " }).success).toBe(false);
    expect(HumanDecisionSchema.safeParse({ ...valid, choices: valid.choices.map(c => ({ ...c, consequence: " " })) }).success).toBe(false);
    expect(HumanDecisionSchema.safeParse({ ...valid, choices: [valid.choices[0], { ...valid.choices[1], label: "(Recommended) Keep ninety days" }] }).success).toBe(false);
  });

  it("repairs a protected prose park through one durable agent duty, without a human question or completed outcome", async () => {
    const task = (await call("create", { type: "task", title: "Verify actual billing attribution", qualified: true, actor: "opencode-ray", meta: { completion: { kind: "execution", outcome: "Observed billing split with receipts" } } })).body.id;
    await call("transition", { id: task, to: "in_progress", actor: "owner", session: "billing" });
    await call("transition", { id: task, to: "blocked", actor: "owner", session: "billing", note: "Historical park", await_event: { event: "time", until_ts: Date.now() + 86_400_000 } });
    // Historical untyped state, not a new legal park. This is the BR#8081
    // class which the sweep must repair without asking Ray to edit metadata.
    await call("update", { id: task, meta: { blocked: { reason: "Await operator action", unblock_condition: "When the billing information becomes available", ts: Date.now() } } });
    await call("admin.unblock_proxy_sweep", { now: Date.now() + 1000 });
    const parent = (await call("get", { id: task })).body;
    expect(parent.status).toBe("blocked");
    expect(parent.meta.recovery).toMatchObject({ reason: "resume_condition" });
    expect(parent.meta.blocked.await_event).toEqual({ event: "br_done", id: parent.meta.recovery.task_id });
    expect(parent.meta.completion.outcome).toBe("Observed billing split with receipts");
    await call("admin.unblock_proxy_sweep", { now: Date.now() + 2000 });
    const duties = (await call("list", { type: "task", limit: 200 })).body.artefacts.filter((a: any) => a.meta.machine_duty?.kind === "task-recovery" && a.meta.machine_duty.subject === task);
    expect(duties).toHaveLength(1);
    const humanAsks = (await call("list", { type: "question", status: "todo" })).body.artefacts.filter((a: any) => a.meta.ask?.route?.kind === "human_decision");
    expect(humanAsks).toHaveLength(0);
  });
});
