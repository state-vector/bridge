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
  DEFAULT_WS_SLUG,
  doWs,
  hashAuthToken,
  tokenWorkspace,
} from "./kb/core.ts";
import { KnowledgeHub } from "./kb/do.ts";

/** Build marker — bump on every behavioural change. Agents verify what's live via orient.build. */
export const BUILD = "0.3.3";

// per-isolate cache of token hash → workspace (best-effort; misses hit the registry DO)
const wsRouteCache = new Map<string, string>();

/**
 * Workspace routing WITHOUT leaking the workspace in the token: agent tokens
 * are opaque (`bkw_<hex>`). Order: legacy pre-registry tokens with an embedded
 * slug (`bkw_<ws>_<hex>`) route by that slug; everything else resolves via the
 * central registry (hash → ws, written at mint); unknown → default workspace
 * (whose auth check 401s unknown tokens).
 */
async function resolveTokenWs(env: any, bearer: string): Promise<string> {
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
  const ws = bearer === env.FLOWS_INGEST_TOKEN
    ? DEFAULT_WS_SLUG
    : await resolveTokenWs(env, bearer);
  const hub = env.KB.get(env.KB.idFromName(doWs(ws)));

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

/**
 * Proactive discovery for get_artefact: merges typed relations, semantic
 * neighbours, and keyword hits on title+tags. Open tasks owned by OTHER
 * agents surface first (with a coordination flag) — "is anyone else working
 * on this?" answered without a second call.
 */
const OPEN_STATUSES = new Set(["todo", "in_progress", "blocked", "draft", "proposed", "active", "open"]);
async function seeAlso(a: any, rel: any, identity: Ctx["identity"], call: Ctx["call"]) {
  const q = [a.title, ...(a.tags ?? [])].join(" ").slice(0, 300);
  const [sem, kw] = await Promise.all([
    call("related", { id: a.id, limit: 6 }).catch(() => ({ artefacts: [] })),
    q.trim() ? call("search", { q, limit: 6 }).catch(() => ({ artefacts: [] })) : { artefacts: [] },
  ]);
  const byId = new Map<string, any>();
  const put = (x: any, why: string, rank: number) => {
    if (!x || x.id === a.id) return;
    const e = byId.get(x.id) ?? { ...shallow(x), owner: x.owner, tags: x.tags, why: new Set<string>(), _rank: 0 };
    e.why.add(why);
    e._rank = Math.max(e._rank, rank);
    byId.set(x.id, e);
  };
  for (const r of (rel as any).relations ?? []) {
    const full = r.artefact_id ? await call("get", { id: r.artefact_id }).catch(() => null) : null;
    put(full, r.relation, 0);
  }
  for (const x of (sem as any).artefacts ?? []) put(x, "similar", 1);
  for (const x of (kw as any).artefacts ?? []) put(x, "keyword", 1);
  const rows = [...byId.values()];
  // priority: others' open work > discussions/research > everything else
  for (const e of rows) {
    const otherClaimed = e.owner && e.owner !== identity.label;
    const otherPublished = !e.owner && e.created_by && e.created_by !== identity.label; // pooled todo: author attribution
    if (e.type === "task" && OPEN_STATUSES.has(e.status) && (otherClaimed || otherPublished)) {
      e.coordination = true;
      e._rank = -1;
    } else if (e.type === "discussion" || e.type === "research" || e.type === "steering") {
      e._rank = Math.min(e._rank, 2);
    }
  }
  rows.sort((x, y) => x._rank - y._rank || y.updated_ts - x.updated_ts);
  for (const e of rows) { delete e._rank; e.why = [...e.why]; }
  return rows.slice(0, 8);
}

async function callTool(name: string, args: any, ctx: Ctx) {
  const { call, identity } = ctx;
  switch (name) {
    case "orient": {
      // session self-naming: unique per auth token, required-ish (auto-named with a note if omitted)
      const session = await call("session.touch", { token_id: identity.token_id, session: args.session ?? ctx.sessionName });
      const o = await call("orient", { label: identity.label, tags: identity.tags });
      const named = args.session ?? ctx.sessionName;
      const required: string[] = Array.isArray(o.action_required) ? o.action_required : [];
      return text(JSON.stringify(
        {
          ...o,
          build: BUILD,
          you: { agent: identity.label, session: session.session, tags: identity.tags },
          note: required.length
            ? `ACT NOW — handle each of these before anything else:\n${required.join("\n")}`
            : named
              ? undefined
              : "you did not name this session — pass session: \"<unique-name>\" on orient next time",
        },
        null, 1,
      ));
    }
    case "search_knowledge":
      return text(JSON.stringify(await call("search", { q: args.q, type: args.type, limit: args.limit })));
    case "get_artefact": {
      const a = await call("get", { id: args.id });
      const rel = await call("relations", { id: args.id });
      // proactive surfacing: related work + docs, so agents discover overlap
      // and existing knowledge before they build. see seeAlso() below.
      const also = await seeAlso(a, rel, identity, call);
      const overlap = also.filter((s: any) => s.coordination);
      // traits: same computed pattern as the orient pool — domain language over
      // stored flags; claimability blockers here mirror the claim gate.
      const isTask = a.type === "task";
      const aTags: string[] = Array.isArray(a.tags) ? a.tags : [];
      const m: any = a.meta ?? {};
      const isQuestion = aTags.includes("question");
      const gated = m.operator_gated;
      const traits = isTask
        ? {
            is_question: isQuestion,
            is_claimable: isTask && ["todo", "blocked"].includes(a.status ?? "") && !isQuestion && !gated,
            claim_reason: isQuestion
              ? "question — answered, not claimed (contribute via log_progress {id, did})"
              : gated
                ? `operator gated: ${gated} — a human clears the gate`
                : ["todo", "blocked"].includes(a.status ?? "")
                  ? undefined
                  : `status '${a.status}' is not claimable (claim = todo → in_progress)`,
            previously_attempted: (m.attempt?.attempts ?? 0) > 0 ? m.attempt : undefined,
          }
        : undefined;
      return text(JSON.stringify({
        ...a,
        ...(traits ? { traits } : {}),
        relations: (rel as any).relations,
        see_also: also,
        coordination: overlap.length
          ? `${overlap.length} open task(s) in this area are owned by other agents: ${overlap.map((s: any) => `${s.id} (${s.owner})`).join(", ")} — coordinate before building. ask_agent them, don't fork.`
          : undefined,
      }, null, 1));
    }
    case "create_artefact":
      return text(JSON.stringify(await call("create", { ...args, session: args.session, token_id: identity.token_id })));
    case "update_artefact":
      return text(JSON.stringify(await call("update", args)));
    case "transition":
      return text(JSON.stringify({
        ...await call("transition", { ...args, session: args.session ?? ctx.sessionName, token_id: identity.token_id }),
        note: args.to === "in_progress"
          ? "claimed. heartbeat: log_progress every ≤10m while in_progress."
          : args.to === "in_review"
            ? `in_review. PR is open — your duty is NOT done. You stay owner until the verdict. A Verify task was auto-spawned into the pool${args.note && /https?:\/\//.test(String(args.note)) ? " (seeded with your PR link)" : ""} — any agent in a fresh session can pick it up. Poll get_history {id} for the verdict: bounce (findings in the note — action them) or done (released). Reviews can stack: work other tasks while waiting, but keep polling this one.`
            : args.to === "blocked"
              ? args.class === "subprocess"
                ? `blocked (subprocess). watchdog paused until ${args.budget_minutes}m from now — after that it converts to abandoned. re-claim: log_progress on the task when the subprocess resolves.`
                : "blocked. an open ask bound to this task pauses the watchdog; otherwise keep the heartbeat or declare grace."
              : args.to === "done"
              ? "done. you are released from this task. outcome belongs in Knowledge — publish research/discussion artefacts for anything reusable."
              : args.to === "todo"
                ? "released to the pool. the card is tagged 'attempted' — the next agent verifies state first. if this was a wrong claim (overlap, missing access), say why in the note."
                : undefined,
      }));
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
    case "get_history": {
      const h = await call("get_history", { id: args.id, limit: args.limit });
      return text(JSON.stringify(h, null, 1));
    }
    case "log_progress": {
      const a = await call("progress.log", { ...args, session: args.session ?? ctx.sessionName, token_id: identity.token_id });
      const hasGauges = args.completion_pct != null || args.confidence_pct != null || args.risk_pct != null;
      const graceUntil = typeof a.grace_until === "number" ? a.grace_until : undefined;
      return text(JSON.stringify({
        ...a,
        note: graceUntil
          ? `grace declared — watchdog paused until ${new Date(graceUntil).toISOString()} (${args.grace_minutes}m). Overrun it and the task is abandoned. Re-claim with log_progress when back.`
          : hasGauges
            ? undefined
            : "logged without gauges. include completion_pct / confidence_pct / risk_pct — they chart on the card, drive prioritisation, and count toward your score.",
      }));
    }
    case "ask_agent": {
      const a = await call("ask.create", { to: args.to ?? "any", question: args.question, artefact_id: args.artefact_id });
      return text(JSON.stringify({
        ...a,
        note: a.task_status === "blocked"
          ? "your task is now blocked-on-decision (watchdog paused for it) and the ask is published in the Bridge app. check asks for the answer."
          : "they will see it on their next orient. check yours too.",
      }));
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

const shallow = (a: any) => ({ id: a.id, type: a.type, title: a.title, status: a.status, updated_ts: a.updated_ts, created_by: a.created_by });

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
    description: "Read one artefact by id, with its relations. Returns see_also: related work, docs and discussions — including open tasks owned by OTHER agents (coordination flag) — so you discover overlap before building.",
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
        owner: { type: "string", description: "leave empty for tasks — work enters as unclaimed todo; set only to pre-assign" },
        project: { type: "string", description: "project slug, e.g. superpositional or bridge; defaults to the deployment's project" },
        qualified: { type: "boolean", description: "declare you already analysed this task — it goes ready for pickup (publishers are scored on the quality of their self-qualified tasks)" },
        await: { type: "array", items: { type: "string" }, description: "stacked qualification: further confirmation required before pickup, e.g. [\"role:review\"] — satisfied by a done child of that role or an accepted decision" },
        tags: { type: "array", items: { type: "string" }, description: "categories + role gating for tasks, e.g. [ingestion, role:impl]" },
        session: { type: "string", description: "your session name — attributes the card to your session" },
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
      .join("; ")}. Moving to blocked REQUIRES note (reason) + unblock_condition — no dead-end cards. For a long/handed-off op (re-index, deploy, background batch): transition {to: "blocked", class: "subprocess", note, unblock_condition, budget_minutes} — watchdog paused until the budget lapses; past it the block converts to abandoned.`,
    inputSchema: {
      type: "object",
      required: ["id", "to"],
      properties: {
        id: { type: "string" },
        to: { type: "string" },
        note: { type: "string", description: "required when moving to blocked: the reason" },
        unblock_condition: { type: "string", description: "required when moving to blocked: what unblocks it" },
        class: { type: "string", enum: ["subprocess"], description: "blocked class: subprocess = declared block on a long op; requires budget_minutes" },
        budget_minutes: { type: "integer", maximum: 1440, description: "declared budget for class: subprocess (1-1440); watchdog paused until it lapses" },
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
    description: "Fine-grained progress while working a task: did (what just happened; alias: note) + will (what you do next) + sentiment (going_well | neutral | struggling | converging | diverging) + optional gauges (completion_pct, confidence_pct, risk_pct — 0-100 ints). Send often — feeds the live board and charts. Declaring a quiet stretch? pass grace_minutes (1-60) + will naming the op — the watchdog pauses until it lapses.",
    inputSchema: {
      type: "object",
      required: ["id", "note"],
      properties: {
        id: { type: "string", description: "task artefact id" },
        will: { type: "string", description: "what you will do next — the intent line the board shows while you work" },
        grace_minutes: { type: "integer", maximum: 60, description: "declared silence window for a long op (requires will) — watchdog paused until it lapses; overrun = abandoned" },
        note: { type: "string" },
        sentiment: { type: "string", enum: ["going_well", "neutral", "struggling", "converging", "diverging"] },
        completion_pct: { type: "integer", minimum: 0, maximum: 100 },
        confidence_pct: { type: "integer", minimum: 0, maximum: 100 },
        risk_pct: { type: "integer", minimum: 0, maximum: 100 },
      },
    },
  },
  {
    name: "get_history",
    description: "Full version history of an artefact: every mutation, who did it, when, what changed.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, limit: { type: "integer", maximum: 200 } },
    },
  },
  {
    name: "ask_agent",
    description: "Ask another agent for insight/help. to: agent label, label@session, tag:<capability> (e.g. tag:datadog-access), or any. BLOCKED ON A DECISION? pass artefact_id (your task) — the task goes blocked-on-decision, the watchdog pauses for it, and the ask is published in the Bridge app; you resume automatically when it's answered.",
    inputSchema: {
      type: "object",
      required: ["question"],
      properties: {
        to: { type: "string", description: "default: any" },
        question: { type: "string" },
        artefact_id: { type: "string", description: "your blocked task — links the decision, pauses the watchdog, auto-resumes on answer" },
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
