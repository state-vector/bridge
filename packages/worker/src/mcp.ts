/**
 * MCP streamable-HTTP endpoint for the knowledge layer.
 *
 * Stateless JSON-RPC over POST /mcp. Machine plane: bearer (FLOWS_INGEST_TOKEN).
 * Tool set is deliberately small and terse — schemas sit in every connected
 * agent's context, so each tool is one call, compact output, no chatter.
 */
import {
  ARTEFACT_TYPES,
  LIFECYCLES,
  RELATIONS,
} from "./kb/core.ts";
import { KnowledgeHub } from "./kb/do.ts";

export async function handleMcp(request: Request, env: any): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "MCP endpoint: POST only" }, 405);
  }
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || token !== env.FLOWS_INGEST_TOKEN) {
    return json({ error: "unauthorized" }, 401);
  }

  let msg: any;
  try {
    msg = await request.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return json({ error: "not a JSON-RPC 2.0 request" }, 400);
  }

  // notifications: no response body per JSON-RPC
  if (msg.method.startsWith("notifications/")) {
    return new Response(null, { status: 202 });
  }

  const hub = env.KB.get(env.KB.idFromName("global"));
  const call = async (op: string, payload: object) => {
    const r = await hub.fetch(`https://kb/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, actor: "mcp" }),
    });
    const out = await r.json();
    if (!r.ok) throw new Error((out as any).error ?? `kb ${op} failed`);
    return out;
  };

  let result: unknown;
  try {
    switch (msg.method) {
      case "initialize":
        result = {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "bridge-kb", version: "0.1.0" },
        };
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: TOOLS };
        break;
      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        const args = msg.params?.arguments ?? {};
        result = await callTool(name, args, call);
        break;
      }
      default:
        return json({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32601, message: `method not found: ${msg.method}` } });
    }
  } catch (e) {
    const message = String((e as Error).message ?? e);
    // tool-level failures are results with isError, not protocol errors
    if (msg.method === "tools/call") {
      result = { content: [{ type: "text", text: message }], isError: true };
    } else {
      return json({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32000, message } });
    }
  }

  return json({ jsonrpc: "2.0", id: msg.id ?? null, result });
}

async function callTool(name: string, args: any, call: (op: string, p: object) => Promise<any>) {
  switch (name) {
    case "orient": {
      const stats = await call("stats", {});
      const recent = await call("list", { limit: 20 });
      const open = (recent as any).artefacts.filter((a: any) =>
        !["achieved", "dropped", "done", "concluded", "rejected", "superseded", "implemented", "published"].includes(a.status),
      );
      return text(JSON.stringify({ counts: (stats as any).counts, open_artefacts: open.map(shallow) }, null, 1));
    }
    case "search_knowledge":
      return text(JSON.stringify(await call("search", { q: args.q, type: args.type, limit: args.limit })));
    case "get_artefact": {
      const a = await call("get", { id: args.id });
      const rel = await call("relations", { id: args.id });
      return text(JSON.stringify({ ...a, relations: (rel as any).relations }, null, 1));
    }
    case "create_artefact":
      return text(JSON.stringify(await call("create", args)));
    case "update_artefact":
      return text(JSON.stringify(await call("update", args)));
    case "transition":
      return text(JSON.stringify(await call("transition", args)));
    case "link_artefacts":
      return text(JSON.stringify(await call("link", args)));
    default:
      return err(`unknown tool: ${name}`);
  }
}

const shallow = (a: any) => ({ id: a.id, type: a.type, title: a.title, status: a.status, updated_ts: a.updated_ts });

const text = (t: string) => ({ content: [{ type: "text", text: t }] });
const err = (t: string) => ({ content: [{ type: "text", text: t }], isError: true });

const TOOLS = [
  {
    name: "orient",
    description: "Project overview: artefact counts + open items. Call at session start.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "search_knowledge",
    description: "Full-text search over artefacts.",
    inputSchema: {
      type: "object",
      required: ["q"],
      properties: {
        q: { type: "string" },
        type: { type: "string", enum: ARTEFACT_TYPES },
        limit: { type: "integer", maximum: 100 },
      },
    },
  },
  {
    name: "get_artefact",
    description: "Read one artefact by id, with its relations.",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
  },
  {
    name: "create_artefact",
    description: `Create an artefact. Types: ${ARTEFACT_TYPES.join(", ")}.`,
    inputSchema: {
      type: "object",
      required: ["type", "title"],
      properties: {
        type: { type: "string", enum: ARTEFACT_TYPES },
        title: { type: "string", maxLength: 300 },
        body_md: { type: "string" },
        meta: { type: "object" },
        owner: { type: "string" },
      },
    },
  },
  {
    name: "update_artefact",
    description: "Edit title/body/meta. Does not change status — use transition.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        body_md: { type: "string" },
        meta: { type: "object" },
      },
    },
  },
  {
    name: "transition",
    description: `Move artefact status under its lifecycle. Per type: ${Object.entries(LIFECYCLES)
      .map(([t, m]) => `${t}: ${Object.entries(m).map(([f, tos]) => `${f}→${tos.join("|")}`).join(", ")}`)
      .join("; ")}.`,
    inputSchema: {
      type: "object",
      required: ["id", "to"],
      properties: {
        id: { type: "string" },
        to: { type: "string" },
        note: { type: "string" },
        replacement_id: { type: "string", description: "for superseded: the replacing artefact" },
      },
    },
  },
  {
    name: "link_artefacts",
    description: `Typed relation. Relations: ${RELATIONS.join(", ")}.`,
    inputSchema: {
      type: "object",
      required: ["src", "relation", "dst"],
      properties: {
        src: { type: "string" },
        relation: { type: "string", enum: RELATIONS },
        dst: { type: "string" },
      },
    },
  },
];

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export { KnowledgeHub };
