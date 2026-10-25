/**
 * MCP streamable-HTTP endpoint for the knowledge layer.
 *
 * Stateless JSON-RPC over POST /mcp. Machine plane: per-agent auth tokens
 * (minted on the admin page) — never call them "tokens" around LLMs, it's an
 * auth token. One auth token per agent client; sessions self-name uniquely
 * via `session` on orient.
 *
 * The tool surface lives in ./mcp-tools.ts — ONE table of
 * { name, description, schema, handler } rows; the tools/list response and
 * the tools/call dispatch are both generated from it (BR#2844). This file is
 * protocol plumbing only: auth, workspace routing, JSON-RPC envelope.
 */
import {
  composeBootstrap,
  DEFAULT_WS_SLUG,
  doWs,
  hashAuthToken,
  tokenWorkspace,
} from "./kb/core.ts";
import { KnowledgeHub } from "./kb/do.ts";

/** Build marker lives in ./mcp-tools.ts (single source) — re-exported here. */
import { BUILD, TOOL_TABLE, err, toolsList } from "./mcp-tools.ts";
// per-isolate cache of token hash → workspace (best-effort; misses hit the registry DO)
const wsRouteCache = new Map<string, string>();

export { BUILD };

/**
 * Workspace routing WITHOUT leaking the workspace in the token: agent tokens
 * are opaque (`bkw_<hex>`). Order: legacy pre-registry tokens with an embedded
 * slug (`bkw_<ws>_<hex>`) route by that slug; everything else resolves via the
 * central registry (hash → ws, written at mint); unknown → default workspace
 * (whose auth check 401s unknown tokens).
 */
export async function resolveTokenWs(env: any, bearer: string): Promise<string> {
  const embedded = tokenWorkspace(bearer);
  if (embedded) return embedded;
  const hash = await hashAuthToken(bearer);
  const hit = wsRouteCache.get(hash);
  if (hit) return hit;
  const reg = env.KB.get(env.KB.idFromName(doWs(DEFAULT_WS_SLUG)));
  const r = await reg.fetch("https://kb/ws.token_lookup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hash }),
  });
  const out = (await r.json().catch(() => ({}))) as { ws?: string | null };
  const ws = out.ws ?? DEFAULT_WS_SLUG;
  if (wsRouteCache.size < 1000) wsRouteCache.set(hash, ws);
  return ws;
}

export async function handleMcp(request: Request, env: any): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "MCP endpoint: POST only" }, 405);
  }
  const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!bearer) return json({ error: "unauthorized: missing auth token" }, 401);

  let msg: any;
  try {
    msg = await request.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return json({ error: "not a JSON-RPC 2.0 request" }, 400);
  }
  if (msg.method.startsWith("notifications/")) {
    return new Response(null, { status: 202 });
  }

  // tokens are opaque — the workspace comes from the routing order above,
  // never from the secret itself. The shared ingest token is default-workspace.
  let ws: string;
  try {
    ws = bearer === (env.BRIDGE_INGEST_TOKEN ?? env.FLOWS_INGEST_TOKEN)
      ? DEFAULT_WS_SLUG
      : await resolveTokenWs(env, bearer);
  } catch {
    // unknown/revoked bearer: a clean JSON-RPC 401, not an unhandled throw
    // (unhandled = CF HTML error page, which reads as "the service is down")
    return json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized: unknown or revoked token" } },
      401,
    );
  }
  const hub = env.KB.get(env.KB.idFromName(doWs(ws)));

  // identity: registry auth token (bkw_…) or the legacy shared ingest token
  let identity: { token_id: string; label: string; tags: string[]; principal: string | null };
  try {
    if (bearer === (env.BRIDGE_INGEST_TOKEN ?? env.FLOWS_INGEST_TOKEN)) {
      identity = { token_id: "shared", label: "shared", tags: [], principal: null };
    } else {
      identity = await kb(hub, "auth.identify", { bearer });
    }
  } catch (e) {
    return json(
      { jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32001, message: String((e as Error).message) } },
      401,
    );
  }

  const sessionName = String(msg.params?.arguments?.session ?? msg.params?.arguments?.__session ?? "");

  const call = async (op: string, payload: object) => {
    const r = await hub.fetch(`https://kb/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, actor: identity.label, token_id: identity.token_id }),
    });
    const out = await r.json();
    if (!r.ok) throw new Error((out as any).error ?? `kb ${op} failed`);
    return out;
  };

  let result: unknown;
  try {
    switch (msg.method) {
      case "initialize": {
        const pub = (await kb(hub, "bootstrap", {}));
        const settings = { project_name: pub.project_name, board: pub.board ?? { mode: "none" }, bootstrap_md: pub.bootstrap_md };
        result = {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "bridge-kb", version: BUILD, description: "Bridge — work orchestration for agents" },
          instructions: composeBootstrap(
            settings.project_name ?? "this project",
            settings.board ?? { mode: "none" },
          ),
        };
        break;
      }
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: toolsList(TOOL_TABLE) };
        break;
      case "tools/call": {
        result = await callTool(String(msg.params?.name ?? ""), msg.params?.arguments ?? {}, { call, identity, sessionName });
        break;
      }
      default:
        return json({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32601, message: `method not found: ${msg.method}` } });
    }
  } catch (e) {
    const message = String((e as Error).message ?? e);
    if (msg.method === "tools/call") {
      result = {
        content: [{ type: "text", text: `ERROR: ${message}\nFix the cause and retry. Read the error — it states the required fix.` }],
        isError: true,
      };
    } else {
      return json({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32000, message } });
    }
  }

  return json({ jsonrpc: "2.0", id: msg.id ?? null, result });
}

interface Ctx {
  call: (op: string, payload: object) => Promise<any>;
  identity: { token_id: string; label: string; tags: string[]; principal: string | null };
  sessionName: string;
}

async function kb(hub: any, op: string, payload: object) {
  const r = await hub.fetch(`https://kb/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const out = await r.json();
  if (!r.ok) throw new Error((out as any).error ?? `kb ${op} failed`);
  return out;
}

async function callTool(name: string, args: any, ctx: Ctx) {
  // Gateway tokens (tagged "gateway") are infrastructure: they claim and
  // dispatch on behalf of the AGENT they dispatched as, and must never appear
  // as task owner (the MacBook-Pro-as-owner defect, ADR BR#899). The gateway
  // flag is DERIVED from the token, never accepted from client args — and a
  // plain agent token's `agent` field is stripped, so attribution cannot be
  // forged (BR#2455: the namespace law holds at the protocol boundary too).
  const isGatewayToken = ctx.identity.tags.some((t) => t.toLowerCase() === "gateway");
  args.gateway = isGatewayToken;
  if (!isGatewayToken) delete args.agent;
  else if (args.agent != null) args.agent = String(args.agent).trim().slice(0, 60);
  // THE dispatch: a lookup in the generated table, not a switch. A tool the
  // table declares is handled; a handler the table lacks cannot exist (the
  // type is total over ToolName) — the registry/divergence class dies here.
  const def = (TOOL_TABLE as Record<string, { handler: (args: any, ctx: Ctx) => unknown }>)[name];
  if (!def) return err(`unknown tool: ${name}`);
  return await def.handler(args, ctx);
}
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export { KnowledgeHub };
