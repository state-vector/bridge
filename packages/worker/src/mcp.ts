/**
 * MCP streamable-HTTP endpoint for the knowledge layer.
 *
 * Stateless JSON-RPC over POST /mcp. Machine plane: per-agent auth tokens
 * (minted on the admin page) — never call them "tokens" around LLMs, it's an
 * auth token. One auth token per agent client; sessions self-name uniquely
 * via `session` on orient.
 */
import {
  ARTEFACT_TYPES,
  LIFECYCLES,
  RELATIONS,
  composeBootstrap,
} from "./kb/core.ts";
import { KnowledgeHub } from "./kb/do.ts";

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

  const hub = env.KB.get(env.KB.idFromName("global"));

  // identity: registry auth token (bkw_…) or the legacy shared ingest token
  let identity: { token_id: string; label: string; tags: string[] };
  try {
    if (bearer === env.FLOWS_INGEST_TOKEN) {
      identity = { token_id: "shared", label: "shared", tags: [] };
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
      body: JSON.stringify({ ...payload, actor: identity.label }),
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
          serverInfo: { name: "bridge-kb", version: "0.2.0", description: "Bridge — work orchestration for agents" },
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
        result = { tools: TOOLS };
        break;
      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        const args = msg.params?.arguments ?? {};
        result = await callTool(name, args, { call, identity, sessionName });
        break;
      }
      default:
        return json({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32601, message: `method not found: ${msg.method}` } });
    }
  } catch (e) {
    const message = String((e as Error).message ?? e);
    if (msg.method === "tools/call") {
      result = { content: [{ type: "text", text: message }], isError: true };
    } else {
      return json({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32000, message } });
    }
  }

  return json({ jsonrpc: "2.0", id: msg.id ?? null, result });
}

interface Ctx {
  call: (op: string, payload: object) => Promise<any>;
  identity: { token_id: string; label: string; tags: string[] };
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
  const { call, identity } = ctx;
  switch (name) {
    case "orient": {
      // session self-naming: unique per auth token, required-ish (auto-named with a note if omitted)
      const session = await call("session.touch", { token_id: identity.token_id, session: args.session ?? ctx.sessionName });
      const o = await call("orient", { label: identity.label, tags: identity.tags });
      const named = args.session ?? ctx.sessionName;
      return text(JSON.stringify(
        {
          ...o,
          you: { agent: identity.label, session: session.session, tags: identity.tags },
          note: named ? undefined : "you did not name this session — pass session: \"<unique-name>\" on orient next time",
        },
        null, 1,
      ));
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
    case "list_agents": {
      const a = await call("agents.list", {});
      return text(JSON.stringify(a, null, 1));
    }
    case "related_artefacts": {
      const a = await call("related", { id: args.id, limit: args.limit });
      return text(JSON.stringify(a, null, 1));
    }
    case "log_progress": {
      const a = await call("progress.log", args);
      return text(JSON.stringify(a));
    }
    case "ask_agent": {
      const a = await call("ask.create", { to: args.to ?? "any", question: args.question });
      return text(JSON.stringify({ ...a, note: "they will see it on their next orient. check yours too." }));
    }
    case "asks": {
      const inbox = await call("ask.inbox", { label: identity.label, tags: identity.tags });
      return text(JSON.stringify(inbox, null, 1));
    }
    case "answer_ask": {
      const a = await call("ask.answer", { id: args.id, answer: args.answer });
      return text(JSON.stringify(a));
    }
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
    description: "Session bootstrap + project overview. Always pass session: \"<unique-name>\". Returns goals, open work, pending asks for you, project flags.",
    inputSchema: {
      type: "object",
      properties: { session: { type: "string", description: "unique session name (per agent)" } },
    },
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
        tags: { type: "array", items: { type: "string" }, description: "categories, e.g. [ingestion, performance]" },
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
  {
    name: "list_agents",
    description: "List connected agents (label, capability tags, online) — use to address ask_agent.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "related_artefacts",
    description: "Artefacts semantically related to X — what supports, constrains or invalidates it.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, limit: { type: "integer", maximum: 50 } },
    },
  },
  {
    name: "log_progress",
    description: "Fine-grained progress while working a task: one line + sentiment (going_well | neutral | struggling | converging | diverging). Send often — it feeds the live board.",
    inputSchema: {
      type: "object",
      required: ["id", "note"],
      properties: {
        id: { type: "string", description: "task artefact id" },
        note: { type: "string" },
        sentiment: { type: "string", enum: ["going_well", "neutral", "struggling", "converging", "diverging"] },
      },
    },
  },
  {
    name: "ask_agent",
    description: "Ask another agent for insight/help. to: agent label, label@session, tag:<capability> (e.g. tag:datadog-access), or any.",
    inputSchema: {
      type: "object",
      required: ["question"],
      properties: {
        to: { type: "string", description: "default: any" },
        question: { type: "string" },
      },
    },
  },
  {
    name: "asks",
    description: "Your ask inbox (open asks addressed to you) + asks you sent (with answers).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "answer_ask",
    description: "Answer an ask from your inbox.",
    inputSchema: {
      type: "object",
      required: ["id", "answer"],
      properties: { id: { type: "string" }, answer: { type: "string" } },
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
