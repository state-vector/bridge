/**
 * THE tool table — one row per MCP tool: { name, description, schema,
 * handler }. BR#2844 item 3: the tools/list response AND the dispatch are
 * both GENERATED from this table, so the registry/dispatch divergence class
 * (ask_answer declared, answer_ask implemented) is unrepresentable — the
 * table type is total over ToolName, and a row without a handler (or a
 * handler with no row) is a compile error, enforced again at runtime by
 * test/mcp-tools.test.ts against the recorded fixture.
 *
 * Argument schemas come from @bridge/contracts (the single source); the
 * handlers are the former callTool switch, moved verbatim — behaviour is
 * unchanged, only the routing is generated.
 */
import { ARTEFACT_TYPES, LIFECYCLES, RELATIONS } from "./kb/core.ts";
import {
  TOOL_ARG_SCHEMAS,
  defineToolTable,
  mcpToolsList,
  type ToolCtx,
  type ToolName,
  type ToolTable,
} from "@bridge/contracts";

/** Build marker — bump on every behavioural change. Agents verify what's live via orient.build. */
export const BUILD = "0.4.0";

export const toolsList = (table: ToolTable) => mcpToolsList(table);

const text = (t: string) => ({ content: [{ type: "text", text: t }] });
export const err = (t: string) => ({ content: [{ type: "text", text: t }], isError: true });

/**
 * Proactive discovery for get_artefact: merges typed relations, semantic
 * neighbours, and keyword hits on title+tags. Open tasks owned by OTHER
 * agents surface first (with a coordination flag) — "is anyone else working
 * on this?" answered without a second call.
 */
const OPEN_STATUSES = new Set(["todo", "in_progress", "blocked", "draft", "proposed", "active", "open"]);
const shallow = (a: any) => ({ id: a.id, type: a.type, title: a.title, status: a.status, updated_ts: a.updated_ts, created_by: a.created_by });

async function seeAlso(a: any, rel: any, identity: ToolCtx["identity"], call: ToolCtx["call"]) {
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
  // priority: others' open work > questions/goals > everything else
  for (const e of rows) {
    const otherClaimed = e.owner && e.owner !== identity.label;
    const otherPublished = !e.owner && e.created_by && e.created_by !== identity.label; // pooled todo: author attribution
    if (e.type === "task" && OPEN_STATUSES.has(e.status) && (otherClaimed || otherPublished)) {
      e.coordination = true;
      e._rank = -1;
    } else if (e.type === "steering" || e.type === "goal") {
      e._rank = Math.min(e._rank, 2);
    }
  }
  rows.sort((x, y) => x._rank - y._rank || y.updated_ts - x.updated_ts);
  for (const e of rows) { delete e._rank; e.why = [...e.why]; }
  return rows.slice(0, 8);
}

/**
 * THE table. Handlers take (args, ctx) — args arrive exactly as the client
 * sent them (the DO remains the authority on unknown keys); the schemas in
 * this row are what tools/list ADVERTISES and what the fixture test pins.
 */
export const TOOL_TABLE: ToolTable = defineToolTable({
  orient: {
    description: "Session bootstrap + project overview. Always pass session: \"<unique-name>\". Returns goals, open work, pending asks for you, project flags.",
    schema: TOOL_ARG_SCHEMAS.orient,
    handler: async (args, ctx) => {
      // session self-naming: unique per auth token, required-ish (auto-named with a note if omitted)
      const session = await ctx.call("session.touch", { token_id: ctx.identity.token_id, session: args.session ?? ctx.sessionName });
      const o = await ctx.call("orient", { label: ctx.identity.label, tags: ctx.identity.tags });
      const named = args.session ?? ctx.sessionName;
      const required: string[] = Array.isArray(o.action_required) ? o.action_required : [];
      return text(JSON.stringify(
        {
          ...o,
          build: BUILD,
          you: { agent: ctx.identity.label, session: session.session, tags: ctx.identity.tags },
          note: required.length
            ? `ACT NOW — handle each of these before anything else:\n${required.join("\n")}`
            : named
              ? undefined
              : "you did not name this session — pass session: \"<unique-name>\" on orient next time",
        },
        null, 1,
      ));
    },
  },
  search_knowledge: {
    description: "Full-text search over artefacts.",
    schema: TOOL_ARG_SCHEMAS.search_knowledge,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("search", { q: args.q, type: args.type, limit: args.limit }))),
  },
  get_artefact: {
    description: "Read one artefact by id, with its relations. Returns see_also: related work, docs, and goals — including open tasks owned by OTHER agents (coordination flag) — so you discover overlap before building.",
    schema: TOOL_ARG_SCHEMAS.get_artefact,
    handler: async (args, ctx) => {
      const a = await ctx.call("get", { id: args.id });
      const rel = await ctx.call("relations", { id: args.id });
      // proactive surfacing: related work + docs, so agents discover overlap
      // and existing knowledge before they build. see seeAlso() above.
      const also = await seeAlso(a, rel, ctx.identity, ctx.call);
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
    },
  },
  create_artefact: {
    description: `Create an artefact. Types: ${ARTEFACT_TYPES.join(", ")}.`,
    schema: TOOL_ARG_SCHEMAS.create_artefact,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("create", { ...args, session: args.session, token_id: ctx.identity.token_id }))),
  },
  update_artefact: {
    description: "Edit title/body/meta/tags/roles. Does not change status — use transition.",
    schema: TOOL_ARG_SCHEMAS.update_artefact,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("update", args))),
  },
  transition: {
    description: `Move artefact status under its lifecycle. Per type: ${Object.entries(LIFECYCLES)
      .map(([t, m]) => `${t}: ${Object.entries(m as Record<string, string[]>).map(([f, tos]) => `${f}→${tos.join("|")}`).join(", ")}`)
      .join("; ")}. Moving to blocked REQUIRES note (reason) + unblock_condition — no dead-end cards. For a long/handed-off op (re-index, deploy, background batch): transition {to: "blocked", class: "subprocess", note, unblock_condition, budget_minutes} — watchdog paused until the budget lapses; past it the block converts to abandoned.`,
    schema: TOOL_ARG_SCHEMAS.transition,
    handler: async (args, ctx) => text(JSON.stringify({
      ...await ctx.call("transition", { ...args, session: args.session ?? ctx.sessionName, token_id: ctx.identity.token_id }),
      note: args.to === "in_progress"
        ? "claimed. heartbeat: log_progress every ≤10m while in_progress."
        : args.to === "in_review"
          ? `in_review. PR is open — your duty is NOT done. You stay owner until the verdict. A Verify task was auto-spawned into the pool${args.note && /https?:\/\//.test(String(args.note)) ? " (seeded with your PR link)" : ""} — any agent in a fresh session can pick it up. Poll get_history {id} for the verdict: bounce (findings in the note — action them) or done (released). Reviews can stack: work other tasks while waiting, but keep polling this one.`
          : args.to === "blocked"
          ? args.class === "subprocess"
            ? `subprocess declared — the task STAYS in_progress (a subprocess wait is not blocked; blocked means awaiting other tasks/decisions). watchdog paused until ${args.budget_minutes}m from now — past it the silence converts to abandoned. re-claim: log_progress on the task when the subprocess resolves.`
            : "blocked. an open ask bound to this task pauses the watchdog; otherwise keep the heartbeat or declare grace."
              : args.to === "done"
              ? "done. you are released from this task. outcome belongs in Knowledge — publish decision or knowledge artefacts for anything reusable."
              : args.to === "todo"
                ? "released to the pool. the card is tagged 'attempted' — the next agent verifies state first. if this was a wrong claim (overlap, missing access), say why in the note."
                : undefined,
    })),
  },
  link_artefacts: {
    description: `Typed relation. Relations: ${RELATIONS.join(", ")}.`,
    schema: TOOL_ARG_SCHEMAS.link_artefacts,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("link", args))),
  },
  list_agents: {
    description: "List connected identities — `agents` (label, capability tags, online) and `gateways` (each with the agent labels it dispatched recently). Address ask_agent at agent labels; gateways are infrastructure, not peers.",
    schema: TOOL_ARG_SCHEMAS.list_agents,
    handler: async (_args, ctx) => text(JSON.stringify(await ctx.call("agents.list", {}), null, 1)),
  },
  stats: {
    description: "Board + watchdog liveness: counts by type/status, watchdog last tick and last sweep (stale in_progress/in_review, open asks). Answers 'is the watchdog alive?' and 'how much work is stale?' without touching DO internals.",
    schema: TOOL_ARG_SCHEMAS.stats,
    handler: async (_args, ctx) => text(JSON.stringify(await ctx.call("stats", {}), null, 1)),
  },
  related_artefacts: {
    description: "Artefacts semantically related to X — what supports, constrains or invalidates it.",
    schema: TOOL_ARG_SCHEMAS.related_artefacts,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("related", { id: args.id, limit: args.limit }), null, 1)),
  },
  session_alive: {
    description: "Runner-side liveness vouch: the session process is alive and producing output (stdout/ACP stream moved). Updates the watchdog liveness stamp only — no board event, no progress entry. Called by the runner, throttled; agents should use log_progress for narrative.",
    schema: TOOL_ARG_SCHEMAS.session_alive,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("session.alive", { ...args, session: args.session ?? ctx.sessionName, token_id: ctx.identity.token_id }))),
  },
  log_progress: {
    description: "Fine-grained progress while working a task: did (what just happened; alias: note) + will (what you do next) + sentiment (going_well | neutral | struggling | converging | diverging) + optional gauges (completion_pct, confidence_pct, risk_pct — 0-100 ints). Send often — feeds the live board and charts. Declaring a quiet stretch? pass grace_minutes (1-60) + will naming the op — the watchdog pauses until it lapses.",
    schema: TOOL_ARG_SCHEMAS.log_progress,
    handler: async (args, ctx) => {
      const a = await ctx.call("progress.log", { ...args, session: args.session ?? ctx.sessionName, token_id: ctx.identity.token_id });
      const hasGauges = args.completion_pct != null || args.confidence_pct != null || args.risk_pct != null || args.context_pct != null;
      const graceUntil = typeof a.grace_until === "number" ? a.grace_until : undefined;
      return text(JSON.stringify({
        ...a,
        note: graceUntil
          ? `grace declared — watchdog paused until ${new Date(graceUntil).toISOString()} (${args.grace_minutes}m). Overrun it and the task is abandoned. Re-claim with log_progress when back.`
          : hasGauges
            ? undefined
            : "logged without gauges. include completion_pct / confidence_pct / risk_pct / context_pct — they chart on the card, drive prioritisation, and count toward your score.",
      }));
    },
  },
  get_history: {
    description: "Full version history of an artefact: every mutation, who did it, when, what changed.",
    schema: TOOL_ARG_SCHEMAS.get_history,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("get_history", { id: args.id, limit: args.limit }), null, 1)),
  },
  ask_agent: {
    description: "Ask another agent or the human for insight/help/decisions. to: agent label, label@session, tag:<capability> (e.g. tag:datadog-access), 'human', or any. BLOCKED ON A DECISION? pass artefact_id (your task) — the task goes blocked-on-decision, the watchdog pauses for it, and the ask is published in the Bridge app; you resume automatically when it's answered. OPTIONS ARE REQUIRED: give the human 2-8 one-click answers (e.g. [\"GO — merge now\", \"NO-GO — hold\"]) — they answer by clicking, and the ask is rejected without them.",
    schema: TOOL_ARG_SCHEMAS.ask_agent,
    handler: async (args, ctx) => {
      const a = await ctx.call("ask.create", { to: args.to ?? "any", question: args.question, reason: args.reason, details: args.details, options: args.options, artefact_id: args.artefact_id });
      return text(JSON.stringify({
        ...a,
        note: a.task_status === "blocked"
          ? "your task is now blocked-on-decision (watchdog paused for it) and the ask is published in the Bridge app. check asks for the answer."
          : "they will see it on their next orient. check yours too.",
      }));
    },
  },
  asks: {
    description: "Your ask inbox (open asks addressed to you) + asks you sent (with answers).",
    schema: TOOL_ARG_SCHEMAS.asks,
    handler: async (_args, ctx) => text(JSON.stringify(await ctx.call("ask.inbox", { label: ctx.identity.label, tags: ctx.identity.tags }), null, 1)),
  },
  answer_ask: {
    description: "Answer an ask from your inbox.",
    schema: TOOL_ARG_SCHEMAS.answer_ask,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("ask.answer", { id: args.id, answer: args.answer }))),
  },
  // ---- merge train (BR#3516/BR#3517) — executor-facing: scripts/merge-train.mjs.
  // Division of labour: the EXECUTOR fetches GitHub facts and performs the
  // merge (worker-local gh, doctor-defended); the HUB decides and holds NO
  // VCS credentials. Every mutating op requires the lane lease (train_lease
  // acquire first; CAS ~5 min TTL — renew on every tick).
  train_lease: {
    description: "Merge-train lane lease (CAS). action: acquire | renew | release — acquire fails while another holder's lease is live (~5 min TTL; lapse then reconcile from live GitHub state); renew/release only by the holder. Acquire carries the lane config (required_workflows, ci_typical_minutes — config, never hardcoded). release with line_green:true clears a stop-the-line.",
    schema: TOOL_ARG_SCHEMAS.train_lease,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("train.lease", args), null, 1)),
  },
  train_event: {
    description: "Record a train event (kind) on a lane and let the hub act: merged (PR merged into base — stamps provenance, carry-verdicts clean updates, card → awaiting-CI), bounced (conflict with base — card → in_progress with the fix-up brief; verdict invalidated, re-verify then re-queue at the back), stopped (stop-the-line — lane halts, culprit card bounced with failing runs, ONE ask per class to the alarm sink), landed (REQUIRED inline checks proving main green — hub classifies, executor never self-certifies; closes the impl card and advances the queue). Requires the lane lease.",
    schema: TOOL_ARG_SCHEMAS.train_event,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("train.event", args), null, 1)),
  },
  train_ci: {
    description: "Report required-workflow check runs (checks[]) observed on the lane's merge commit — the hub classifies (green → landed; red → stop-the-line; unknown past ~3× typical CI → fail-closed stop; else pending). Executor-fed facts, hub decides. Requires the lane lease.",
    schema: TOOL_ARG_SCHEMAS.train_ci,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("train.ci", args), null, 1)),
  },
  train_status: {
    description: "Merge-train snapshot: lane cards, lease holders, in-flight merge phase, stop state, and the DERIVED queue (computed from blocked cards, never stored). Executor's reconciliation source — never trust a prior holder's picture.",
    schema: TOOL_ARG_SCHEMAS.train_status,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("train.status", args), null, 1)),
  },
  train_history: {
    description: "The train_events ledger for a lane — the audit chain of merged/bounced/stopped/landed with provenance (sha → PR → task → verdict → session).",
    schema: TOOL_ARG_SCHEMAS.train_history,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("train.history", args), null, 1)),
  },
  train_lane: {
    description: "Find-or-create the standing lane card for repo@base, seeding config from the train_lane setting (or the spec arg). Call once per lane before leasing.",
    schema: TOOL_ARG_SCHEMAS.train_lane,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("train.lane", args), null, 1)),
  },
});

export type { ToolCtx, ToolName };
