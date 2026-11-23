import { Miniflare } from "miniflare";
import { realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOOL_ARG_SCHEMAS } from "@bridge/contracts";
import { TOOL_TABLE, toolsList } from "../src/mcp-tools.ts";

/**
 * BR#18305 — preserve time-sensitive urgency when creating asks over MCP.
 *
 * A human escalation submitted through the MCP ask_agent tool with
 * urgency: "time-sensitive" persisted as "normal": the shared MCP tool
 * schema (packages/contracts/src/mcp.ts) declared no urgency field and the
 * adapter (mcp-tools.ts) forwarded named fields only, so the value was
 * dropped before the native ask.create — which already validates and stores
 * the contract v2 vocabulary (BR#3008) — ever saw it. The metadata editor
 * could repair the ask afterwards, but the first human surface read "normal".
 *
 * These regressions drive the ACTUAL MCP tool layer (TOOL_TABLE.ask_agent
 * handler → ask.create → the real KnowledgeHub DO) and pin:
 * 1. the schema carries the vocabulary (time-sensitive | normal; anything
 *    else is rejected) and the published inputSchema advertises it;
 * 2. a time-sensitive human decision round-trips: tool response and stored
 *    ask agree, the human route, affected task, answer options and asker
 *    ownership stay intact, and the affected task parks blocked-on-ask;
 * 3. omitting urgency keeps the "normal" default (no accidental loud asks).
 */

let mf: Miniflare;
let stub: any;
async function call(op: string, body: object = {}) {
  const response = await stub.fetch(`https://kb/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}

beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  mf = new Miniflare({ workers: [{ name: "main", scriptPath: bundle, modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")), modules: true, compatibilityDate: "2025-09-06", durableObjects: { KB: { className: "KnowledgeHub", useSQLite: true } } }] });
  const ns = await mf.getDurableObjectNamespace("KB");
  stub = await ns.get(ns.idFromName("br18305-mcp-ask-urgency"));
  await call("orient", { actor: "test" });
});
afterAll(async () => { await mf?.dispose(); });

const LABEL = "dispatch-mcp-ask-urgency";
// The MCP server boundary (mcp.ts) injects actor/token on every DO call and
// throws on DO errors (kbError) — mirror both so the tool handler runs
// against the hub exactly as in production and failures fail loudly.
const mcpCtx = {
  call: async (op: string, payload: object) => {
    const r = await call(op, { ...payload, actor: LABEL, token_id: "at_test" });
    if (r.status >= 400) throw new Error(r.body?.error ?? `kb ${op} failed`);
    return r.body;
  },
  identity: { token_id: "at_test", label: LABEL, tags: [], principal: null },
  sessionName: "bridge-task-BR-18305",
};

/** A real tools/call of the ask_agent tool: table handler → ask.create → DO. */
async function mcpAskAgent(args: Record<string, unknown>) {
  const out = (await TOOL_TABLE.ask_agent.handler(args as any, mcpCtx as any)) as { content: Array<{ text: string }> };
  return JSON.parse(out.content[0].text);
}

async function inProgressTask(title: string, actor = LABEL) {
  const created = await call("create", { type: "task", title, qualified: true, actor, session: mcpCtx.sessionName });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const id = created.body.id;
  expect((await call("transition", { id, to: "in_progress", actor, session: mcpCtx.sessionName })).status).toBe(200);
  return id as string;
}

describe("bounded executor coordination", () => {
  async function namedCredential(label: string) {
    const minted = await call("admin.mint", { label });
    expect(minted.status).toBe(200);
    await call("session.touch", { token_id: minted.body.id, session: mcpCtx.sessionName });
    return minted.body.id as string;
  }

  async function setup(requestId: string) {
    const targetLabel = `coordination-executor-${requestId}`;
    await namedCredential(targetLabel);
    const task = await inProgressTask(`Coordination target ${requestId}`, targetLabel);
    const requester = `coordination-requester-${requestId}`;
    const tokenId = await namedCredential(requester);
    const caller = await inProgressTask(`Independent work ${requestId}`, requester);
    const ctx = {
      ...mcpCtx,
      identity: { ...mcpCtx.identity, label: requester, token_id: tokenId },
      async call(op: string, payload: object) {
        const r = await call(op, { ...payload, actor: requester, token_id: tokenId });
        if (r.status >= 400) throw new Error(r.body.error);
        return r.body;
      },
    };
    const args = {
      route: { kind: "executor_coordination", task_id: task },
      question: "Are you already fixing the failing test?",
      options: ["I am handling the fix", "You can handle the fix; I am not changing it"],
      coordination: { request_id: requestId, wait_ms: 0 },
    };
    const ask = async (waitMs: number, signal?: AbortSignal) => {
      const out = await TOOL_TABLE.ask_agent.handler({ ...args, coordination: { ...args.coordination, wait_ms: waitMs } }, { ...ctx, signal }) as { content: Array<{ text: string }> };
      return JSON.parse(out.content[0].text);
    };
    return { task, caller, requester, targetLabel, ctx, args, ask };
  }

  it("delivers the current executor's answer during the call without parking independent work", async () => {
    const f = await setup("during-wait");
    let published!: (id: string) => void;
    const oncePublished = new Promise<string>(resolve => { published = resolve; });
    const result = TOOL_TABLE.ask_agent.handler({ ...f.args, coordination: { request_id: "during-wait", wait_ms: 2500 } }, {
      ...f.ctx,
      call: async (op, payload) => {
        const read = await f.ctx.call(op, payload);
        if (op === "ask.coordination_status") published(read.id);
        return read;
      },
    }) as Promise<{ content: Array<{ text: string }> }>;
    const id = await oncePublished;
    const inbox = await call("ask.inbox", { label: f.targetLabel });
    expect(inbox.body.inbox).toContainEqual(expect.objectContaining({ id, to_target: `${f.targetLabel}@${mcpCtx.sessionName}` }));
    const ownTask = await call("get", { id: f.caller });
    expect(ownTask.body.status).toBe("in_progress");
    const answer = "Yes; tracked test fixture is edited in my worktree.";
    expect((await call("ask.answer", { id, answer, actor: f.targetLabel })).status).toBe(200);
    expect(JSON.parse((await result).content[0].text)).toMatchObject({ id, state: "answered", answer, by: f.targetLabel });
  });

  it("reattaches after timeout, cancellation and concurrent retries, including after answer", async () => {
    const f = await setup("lost-reply");
    const timeout = await f.ask(10);
    expect(timeout).toMatchObject({ state: "pending", note: expect.stringContaining("Continue independent work") });
    const controller = new AbortController();
    const cancelled = TOOL_TABLE.ask_agent.handler({ ...f.args, coordination: { request_id: "lost-reply", wait_ms: 15_000 } }, {
      ...f.ctx, signal: controller.signal,
      call: async (op, payload) => {
        const read = await f.ctx.call(op, payload);
        if (op === "ask.coordination_status") controller.abort();
        return read;
      },
    }) as Promise<{ content: Array<{ text: string }> }>;
    const retries = await Promise.all([cancelled, f.ask(0), f.ask(0)]);
    expect(JSON.parse(retries[0].content[0].text)).toMatchObject({ id: timeout.id, state: "pending" });
    expect(retries.slice(1).map(r => (r as { id: string }).id)).toEqual([timeout.id, timeout.id]);
    const wrongCredential = await call("ask.coordination_status", { id: timeout.id, token_id: "other-credential" });
    expect(wrongCredential.status).toBe(400);
    expect((await call("ask.answer", { id: timeout.id, answer: "No overlap", actor: LABEL })).status).toBe(200);
    expect(await f.ask(0)).toMatchObject({ id: timeout.id, state: "answered", answer: "No overlap" });
    await expect(TOOL_TABLE.ask_agent.handler({ ...f.args, question: "Is this a different question?" }, f.ctx))
      .rejects.toThrow(/request_id already used/);
    const sent = await call("ask.inbox", { label: f.requester });
    expect(sent.body.sent).toMatchObject([{ id: timeout.id, question: f.args.question }]);

    const concurrent = await setup("concurrent-creation");
    const firstCalls = await Promise.all([concurrent.ask(0), concurrent.ask(0), concurrent.ask(0)]);
    expect(new Set(firstCalls.map(r => r.id)).size).toBe(1);
    await expect(TOOL_TABLE.ask_agent.handler({ ...concurrent.args, artefact_id: f.caller }, concurrent.ctx))
      .rejects.toThrow(/unbound executor_coordination ask/);
  });

  it("returns immediately for same-session or unknown callers and resumes a retry once a distinct executor is available", async () => {
    const f = await setup("no-peer");
    const run = async (session: string | undefined) => {
      const out = await TOOL_TABLE.ask_agent.handler({
        ...f.args, route: { kind: "executor_coordination", task_id: f.caller },
        coordination: { request_id: "no-peer", wait_ms: 15_000 },
      }, { ...f.ctx, sessionName: session }) as { content: Array<{ text: string }> };
      return JSON.parse(out.content[0].text);
    };
    const same = await run(f.ctx.sessionName);
    expect(same).toMatchObject({ state: "pending", wait_skipped: "same_executor" });
    expect(await run(undefined)).toMatchObject({ id: same.id, state: "pending", wait_skipped: "caller_session_unknown" });
    expect((await call("transition", { id: f.caller, to: "todo", actor: f.requester, note: "Release fixture", session: f.ctx.sessionName })).status).toBe(200);
    expect(await run(f.ctx.sessionName)).toMatchObject({ id: same.id, state: "pending", wait_skipped: "no_live_executor" });
    expect((await call("transition", { id: f.caller, to: "in_progress", actor: f.targetLabel, session: f.ctx.sessionName })).status).toBe(200);
    expect((await call("ask.answer", { id: same.id, answer: "New executor confirms", actor: f.targetLabel })).status).toBe(200);
    expect(await run(f.ctx.sessionName)).toMatchObject({ id: same.id, state: "answered", by: f.targetLabel });
  });

  it("stops polling when the target loses its claim during the wait", async () => {
    const f = await setup("peer-disappears");
    let reads = 0;
    const out = await TOOL_TABLE.ask_agent.handler({
      ...f.args, coordination: { request_id: "peer-disappears", wait_ms: 15_000 },
    }, {
      ...f.ctx,
      async call(op, payload) {
        const result = await f.ctx.call(op, payload);
        if (op === "ask.coordination_status" && ++reads === 1) {
          expect(result).toMatchObject({ state: "pending" });
          expect(result.wait_skipped).toBeUndefined();
          expect((await call("transition", { id: f.task, to: "todo", actor: f.targetLabel, note: "Release fixture", session: f.ctx.sessionName })).status).toBe(200);
        }
        return result;
      },
    }) as { content: Array<{ text: string }> };
    expect(reads).toBe(2);
    expect(JSON.parse(out.content[0].text)).toMatchObject({ state: "pending", wait_skipped: "no_live_executor" });
  });

  it("does not use a fresh credential or task update as proof that the named executor is live", async () => {
    const f = await setup("wrong-session");
    const task = await call("create", { type: "task", title: "Task whose exact executor has not connected", qualified: true, actor: f.targetLabel });
    expect(task.status).toBe(200);
    expect((await call("transition", { id: task.body.id, to: "in_progress", actor: f.targetLabel, session: "offline-fixture" })).status).toBe(200);
    const out = await TOOL_TABLE.ask_agent.handler({
      ...f.args, route: { kind: "executor_coordination", task_id: task.body.id },
      coordination: { request_id: "wrong-session", wait_ms: 15_000 },
    }, f.ctx) as { content: Array<{ text: string }> };
    expect(JSON.parse(out.content[0].text)).toMatchObject({ state: "pending", wait_skipped: "no_live_executor" });
  });

  it("offers a failed executor delivery to the pool after grace, then routes the same ask to a reconnected holder", async () => {
    const f = await setup("agent-pool-fallback");
    const session = "returning-executor";
    const task = await call("create", { type: "task", title: "Work claimed by a disconnected session", qualified: true, actor: f.targetLabel });
    const taskId = task.body.id;
    expect((await call("transition", { id: taskId, to: "in_progress", actor: f.targetLabel, session })).status).toBe(200);
    const retry = async () => {
      const out = await TOOL_TABLE.ask_agent.handler({
        ...f.args, route: { kind: "executor_coordination", task_id: taskId },
      }, f.ctx) as { content: Array<{ text: string }> };
      return JSON.parse(out.content[0].text);
    };
    const sent = await retry();
    expect(sent).toMatchObject({ state: "pending", wait_skipped: "no_live_executor" });
    const inbox = async (label: string) => (await call("ask.inbox", { label })).body.inbox;
    expect(await inbox("pool-peer")).not.toContainEqual(expect.objectContaining({ id: sent.id }));
    expect(await inbox(f.targetLabel)).toContainEqual(expect.objectContaining({ id: sent.id, to_target: `${f.targetLabel}@${session}` }));
    const sweep = await call("admin.ask_escalation_sweep", { now: Date.now() + 3_600_000 });
    expect(sweep.body.escalated).toContain(sent.id);
    expect(await inbox("pool-peer")).toContainEqual(expect.objectContaining({ id: sent.id, to_target: "any" }));
    expect(await retry()).toMatchObject({ id: sent.id, state: "pending", wait_skipped: "no_live_executor" });

    const token = await call("admin.mint", { label: f.targetLabel });
    await call("session.touch", { token_id: token.body.id, session });
    expect(await inbox("pool-peer")).not.toContainEqual(expect.objectContaining({ id: sent.id }));
    expect(await inbox(f.targetLabel)).toContainEqual(expect.objectContaining({ id: sent.id, to_target: `${f.targetLabel}@${session}` }));
    expect(await retry()).toMatchObject({ id: sent.id, state: "pending" });
    expect((await call("ask.answer", { id: sent.id, answer: "Recovered executor replied", actor: f.targetLabel })).status).toBe(200);
    expect(await retry()).toMatchObject({ id: sent.id, state: "answered", by: f.targetLabel });
  });
});

describe("BR#18305 — the MCP schema carries the ask urgency vocabulary", () => {
  it("ask_agent accepts the contract v2 words and rejects off-vocabulary values", () => {
    const schema = TOOL_ARG_SCHEMAS.ask_agent;
    expect(schema.parse({ urgency: "time-sensitive" }).urgency).toBe("time-sensitive");
    expect(schema.parse({ urgency: "normal" }).urgency).toBe("normal");
    expect(schema.parse({}).urgency).toBeUndefined(); // omitted stays the native "normal" default
    expect(() => schema.parse({ urgency: "urgent" })).toThrow(); // not ask vocabulary (the BR#3008 lesson)
  });

  it("the published tools/list inputSchema advertises the urgency enum", () => {
    const tool = toolsList(TOOL_TABLE).find((t) => t.name === "ask_agent");
    expect(tool).toBeTruthy();
    expect((tool!.inputSchema as any).properties.urgency).toMatchObject({ enum: ["normal", "time-sensitive"] });
  });
});

describe("BR#18305 — a time-sensitive human decision survives the MCP round-trip", () => {
  it("the tool response and the stored ask both say time-sensitive, with route/task/options/ownership intact", async () => {
    const task = await inProgressTask("BR#18305 fixture: authorise the verified release");
    const labels = ["(Recommended) Approve the release", "Hold the release"];
    const response = await mcpAskAgent({
      route: { kind: "human_decision" },
      to: "human",
      question: "Do you approve the verified release now?",
      reason: "Release authority is yours alone.",
      details: "The release is verified and independently accepted; the work stays held until you choose. Approving resumes the release; holding keeps it parked for your later review.",
      decision: {
        kind: "authority",
        task_id: task,
        context: "The release is verified and independently accepted; only your authority can start it.",
        why_human: "Only you can authorise the release.",
        choices: [
          { label: labels[0], executor: "human", consequence: "Approving resumes the release immediately.", action: "hold" },
          { label: labels[1], executor: "human", consequence: "Holding keeps the release parked for your later review.", action: "hold" },
        ],
      },
      urgency: "time-sensitive",
      options: labels,
      artefact_id: task,
    });
    // the TOOL RESPONSE carries the urgency the caller asked for
    expect(response.urgency).toBe("time-sensitive");
    expect(response.task_status).toBe("blocked");

    // the STORED ASK agrees — the defect was exactly this divergence
    const stored = (await call("get", { id: response.id })).body;
    expect(stored.meta.ask.urgency).toBe("time-sensitive");
    // human route intact
    expect(stored.meta.ask.route).toEqual({ kind: "human_decision" });
    expect(stored.meta.ask.to).toBe("human");
    // affected task intact (the decision binds the same card)
    expect(stored.meta.ask.decision.task_id).toBe(task);
    expect(stored.meta.ask.artefact_id).toBe(task);
    // answer options intact (one click each, recommended first)
    expect(stored.meta.ask.options).toEqual(labels);
    // ownership intact — the asker is the calling identity, not a stranger
    expect(stored.meta.ask.from).toBe(LABEL);
    expect(stored.title).toBe("Do you approve the verified release now?");

    // the affected task parked blocked-on-ask with the binding intact
    const card = (await call("get", { id: task })).body;
    expect(card.status).toBe("blocked");
    expect(card.meta.awaiting_ask.ask_id).toBe(response.id);
    expect(card.meta.awaiting_ask.route).toEqual({ kind: "human_decision" });
  });
});

describe("BR#18305 — the normal default is preserved", () => {
  it("an ask without urgency stores and returns normal", async () => {
    const task = await inProgressTask("BR#18305 fixture: ordinary peer coordination");
    const response = await mcpAskAgent({
      to: "any",
      question: "Can you take the follow-up connector edit?",
      options: ["No overlap", "I will take it"],
      artefact_id: task,
    });
    expect(response.urgency).toBe("normal");
    const stored = (await call("get", { id: response.id })).body;
    expect(stored.meta.ask.urgency).toBe("normal");
    expect(stored.meta.ask.from).toBe(LABEL);
    expect(stored.meta.ask.artefact_id).toBe(task);
  });

  it("an explicit normal behaves identically (no accidental loud ask)", async () => {
    const response = await mcpAskAgent({
      to: "any",
      question: "Is the shared fixture free for a retry?",
      options: ["It is free", "Someone holds it"],
      urgency: "normal",
    });
    expect(response.urgency).toBe("normal");
    expect((await call("get", { id: response.id })).body.meta.ask.urgency).toBe("normal");
  });
});
