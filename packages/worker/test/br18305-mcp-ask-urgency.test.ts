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

async function inProgressTask(title: string) {
  const created = await call("create", { type: "task", title, qualified: true, actor: LABEL, session: mcpCtx.sessionName });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const id = created.body.id;
  expect((await call("transition", { id, to: "in_progress", actor: LABEL, session: mcpCtx.sessionName })).status).toBe(200);
  return id as string;
}

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
