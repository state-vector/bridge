import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Executor-attribution laws (2026-11-03 "doctor" incident):
 *
 *  1. Task creation (`create` / `create_artefact`) without an explicit
 *     `session` leaves `meta.session` undefined — filing a `todo` task is not
 *     executing it, so the filer's session (or a probe on the filer's token)
 *     never pre-stamps executor attribution on an unclaimed card.
 *  2. A session-less write from a GATEWAY-tagged token stays anonymous — the
 *     token's last-session fallback never forges executor attribution for
 *     infrastructure.
 *  3. An explicit session on a gateway token is still honored (train lease,
 *     canary, alarm, runner task claims).
 *  4. End-to-end `/mcp`: omitting `session` on `transition` and `log_progress`
 *     preserves `undefined` (never coerced to `""`), so an agent token that
 *     oriented once as `S` stamps `S` on subsequent claims and heartbeats.
 *  5. Releasing a task to `todo` clears `meta.session`, and a fresh claim
 *     (`todo → in_progress`) re-stamps the new claimant's session.
 *  6. `/mcp` JSON-RPC `ping` (used by `bridge doctor`) authenticates the token
 *     and touches zero session rows.
 */

let mf: Miniflare;
let kb: (path: string, init?: RequestInit) => Promise<Response>;

beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  if (!existsSync(bundle)) {
    throw new Error("bundle missing — run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle (the npm test script does this before vitest)");
  }
  mf = new Miniflare({
    workers: [{
      name: "main",
      scriptPath: bundle,
      modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")),
      modules: true,
      compatibilityDate: "2025-09-06",
      durableObjects: {
        HUB: { className: "FlowsHub", useSQLite: true },
        KB: { className: "KnowledgeHub", useSQLite: true },
      },
    }],
  });
  const ns = await mf.getDurableObjectNamespace("KB");
  const stub = await ns.get(ns.idFromName("global"));
  kb = (path, init) => stub.fetch(`https://kb${path}`, init);
  await kb("/orient", { actor: "test" });
});

afterAll(async () => {
  await mf?.dispose();
});

async function kbJson(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await kb(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function mintToken(label: string, tags: string[]): Promise<{ id: string; secret: string }> {
  const { status, body } = await kbJson("/admin.mint", { label, tags });
  expect(status).toBeLessThan(500);
  expect(body.error).toBeUndefined();
  expect(body.id).toBeTruthy();
  expect(body.secret).toBeTruthy();
  return { id: body.id as string, secret: body.secret as string };
}

async function mcpRpc(secret: string, method: string, params?: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const r = await mf.dispatchFetch("https://hub/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function mcpTool(secret: string, name: string, args: Record<string, unknown>): Promise<any> {
  const { status, body } = await mcpRpc(secret, "tools/call", { name, arguments: args });
  expect(status).toBe(200);
  expect(body.error).toBeUndefined();
  expect(body.result?.isError).toBeFalsy();
  return JSON.parse(body.result.content[0].text);
}

async function createTask(tokenId: string, title: string): Promise<string> {
  const { body } = await kbJson("/create", {
    type: "task",
    title,
    body_md: "attribution-law regression fixture",
    actor: "test",
    token_id: tokenId,
  });
  expect(body.error).toBeUndefined();
  return body.id as string;
}

async function metaOf(id: string): Promise<any> {
  const { body } = await kbJson("/get", { id });
  expect(body.error).toBeUndefined();
  return typeof body.meta === "string" ? JSON.parse(body.meta) : (body.meta ?? {});
}

describe("executor attribution (doctor-probe incident laws)", () => {
  it("creating a todo task without explicit session never pre-stamps the filer's session", async () => {
    const filer = await mintToken("attr-filer", []);
    await kbJson("/session.touch", { token_id: filer.id, session: "filer-session" });
    const id = await createTask(filer.id, "attr: todo creation stays unattributed");
    expect((await metaOf(id)).session).toBeUndefined();
  });

  it("a session-less gateway write stays anonymous even with a probe session registered", async () => {
    const gw = await mintToken("attr-gateway", ["gateway"]);
    await kbJson("/session.touch", { token_id: gw.id, session: "doctor" });
    const id = await createTask(gw.id, "attr: gateway session-less claim stays anonymous");
    const { body } = await kbJson("/transition", { id, to: "in_progress", actor: "test", token_id: gw.id });
    expect(body.error).toBeUndefined();
    const meta = await metaOf(id);
    expect(meta.session).toBeUndefined();
  });

  it("an explicit session on a gateway token is still honored", async () => {
    const gw = await mintToken("attr-gateway-2", ["gateway"]);
    await kbJson("/session.touch", { token_id: gw.id, session: "doctor" });
    const id = await createTask(gw.id, "attr: gateway explicit session honored");
    const { body } = await kbJson("/transition", {
      id, to: "in_progress", actor: "test", token_id: gw.id, session: "bridge-task-attr",
    });
    expect(body.error).toBeUndefined();
    const meta = await metaOf(id);
    expect(meta.session).toBe("bridge-task-attr");
  });

  it("end-to-end /mcp: orient session resolves onto transition and log_progress when session arg is omitted", async () => {
    const agent = await mintToken("attr-mcp-agent", []);
    await mcpTool(agent.secret, "orient", { session: "mcp-exec-session" });

    // Filing a task over MCP without session leaves meta.session unset in todo
    const created = await mcpTool(agent.secret, "create_artefact", {
      type: "task",
      title: "attr: mcp end-to-end claim + heartbeat",
      body_md: "end-to-end mcp attribution test",
      qualified: true,
    });
    expect((await metaOf(created.id)).session).toBeUndefined();

    // Claiming via MCP transition WITHOUT session arg resolves "mcp-exec-session"
    await mcpTool(agent.secret, "transition", { id: created.id, to: "in_progress" });
    expect((await metaOf(created.id)).session).toBe("mcp-exec-session");

    // Logging progress via MCP WITHOUT session arg resolves the same session
    await mcpTool(agent.secret, "log_progress", {
      id: created.id,
      note: "working",
      will: "finish",
      sentiment: "going_well",
    });
    const meta = await metaOf(created.id);
    expect(meta.session).toBe("mcp-exec-session");
    expect(meta.last_progress?.session).toBe("mcp-exec-session");
  });

  it("releasing to todo clears meta.session and a fresh claim re-stamps the new executor", async () => {
    const agent = await mintToken("attr-agent-2", []);
    await kbJson("/session.touch", { token_id: agent.id, session: "old-holder" });
    const id = await createTask(agent.id, "attr: release clears and fresh claim re-stamps");
    await kbJson("/transition", { id, to: "in_progress", actor: "test", token_id: agent.id });
    expect((await metaOf(id)).session).toBe("old-holder");

    // Release to todo clears the executor lease
    await kbJson("/transition", { id, to: "todo", actor: "test", token_id: agent.id });
    expect((await metaOf(id)).session).toBeUndefined();

    // Re-claim stamps the new executor
    const { body } = await kbJson("/transition", {
      id, to: "in_progress", actor: "test", token_id: agent.id, session: "new-executor",
    });
    expect(body.error).toBeUndefined();
    expect((await metaOf(id)).session).toBe("new-executor");
  });

  it("/mcp ping authenticates the token without registering a session", async () => {
    const gw = await mintToken("attr-doctor-ping", ["gateway"]);
    const okPing = await mcpRpc(gw.secret, "ping");
    expect(okPing.status).toBe(200);
    expect(okPing.body.result).toEqual({});

    const badPing = await mcpRpc("bkw_invalid_token_00000000000000000000000000", "ping");
    expect(badPing.status).toBe(401);
  });
});
