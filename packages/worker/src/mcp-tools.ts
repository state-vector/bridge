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
  StartupWaitSchema,
  startupWaitReason,
  type ToolCtx,
  type ToolName,
  type ToolTable,
} from "@bridge/contracts";

/** Build marker — bump on every behavioural change. Agents verify what's live via orient.build. */
export const BUILD = "0.8.0";

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
  handoffs: {
    description: "Read pending local handoffs without claiming, acknowledging or resuming work. Paginated, project/recipient scoped. Includes continuation prompt, all current blockers, can_accept/prerequisites and explicit acceptance reference.",
    schema: TOOL_ARG_SCHEMAS.handoffs,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("handoff.read", { ...args, session: ctx.sessionName }))),
  },
  handoff_accept: {
    description: "Explicit episode/version-bound local acceptance. Requires a live full interactive credential (never a provisioned worker/gateway/cron) and a matching human-web authorised session/capability grant. Returns accepted/already_accepted/stale_episode/unauthorized/unmet_prerequisites. Copying a prompt or answering an ask is not acceptance.",
    schema: TOOL_ARG_SCHEMAS.handoff_accept,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("handoff.accept", args))),
  },
  handoff_checkpoint: {
    description: "Record the winning local session's newly published checkpoint before explicit human-authorised return to autonomous execution. Increments the handoff version; never requeues work by itself.",
    schema: TOOL_ARG_SCHEMAS.handoff_checkpoint,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("handoff.checkpoint", args))),
  },
  execution: {
    description: "Durable executor protocol v1: eligibility-first schedule (inspect/reserve/request_capacity), read-only schedule_status, full-agent gateway_control (draining/enabled), inspect/advertise, fenced begin/poll, checkpoint/restore/quiesce, mailbox, escalation and effect receipts. request_capacity arranges safe recovery preemption without reserving work. Reservations count against gateway capacity; lease expiry never proves writer quiescence. Stable command_id retries return the original result; never repeat an unknown external effect.",
    schema: TOOL_ARG_SCHEMAS.execution,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("execution", { ...args, session: args.session ?? ctx.sessionName }))),
  },
  orient: {
    description: "Session bootstrap + project overview. Always pass session: \"<unique-name>\". Returns goals, open work, pending asks for you, project flags. Every artefact row carries url — its stable deep link (/card/BR-NNNN), pasteable in a browser.",
    schema: TOOL_ARG_SCHEMAS.orient,
    handler: async (args, ctx) => {
      // session self-naming: unique per auth token, required-ish (auto-named with a note if omitted)
      const session = await ctx.call("session.touch", { token_id: ctx.identity.token_id, session: args.session ?? ctx.sessionName });
      const o = await ctx.call("orient", { label: ctx.identity.label, tags: ctx.identity.tags, session: args.session ?? ctx.sessionName });
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
    description: "Read one artefact by id, with its relations. Returns see_also: related work, docs, and goals — including open tasks owned by OTHER agents (coordination flag) — so you discover overlap before building. The artefact and every see_also row carry url — the card's stable deep link.",
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
      const startup = StartupWaitSchema.safeParse(m.startup_wait);
      const traits = isTask
        ? {
            is_question: isQuestion,
            is_claimable: isTask && ["todo", "blocked"].includes(a.status ?? "") && !isQuestion && !gated && !startup.success,
            claim_reason: startup.success ? startupWaitReason(startup.data) : isQuestion
              ? "question — answered, not claimed (contribute via log_progress {id, did})"
              : gated
                ? `operator gated: ${gated} — a human clears the gate`
                : ["todo", "blocked"].includes(a.status ?? "")
                  ? undefined
                  : `status '${a.status}' is not claimable (claim = todo → in_progress)`,
            previously_attempted: (m.attempt?.attempts ?? 0) > 0 ? m.attempt : undefined,
          }
        : undefined;
      // BR#3911: on a question, surface a live human hold in domain language —
      // "in hand" instead of answer prompts, even on the direct read.
      const claimLive = a.type === "question" && m.human_claimed
        && typeof m.human_claimed.expires_ts === "number" && m.human_claimed.expires_ts > Date.now()
        ? { by: String(m.human_claimed.by ?? ""), expires_ts: m.human_claimed.expires_ts }
        : undefined;
      return text(JSON.stringify({
        ...a,
        ...(claimLive ? { human_claimed: claimLive } : {}),
        ...(traits ? { traits } : {}),
        relations: (rel as any).relations,
        see_also: also,
        coordination: overlap.length
          ? `${overlap.length} open task(s) in this area are owned by other agents: ${overlap.map((s: any) => `${s.id} (${s.owner})`).join(", ")} — coordinate before building. ask_agent them, don't fork.`
          : undefined,
      }, null, 1));
    },
  },
  claim_takeover: {
    description:
      "Interactive claim takeover (BR#2997/BR#6135, amended BR#6436): the card's OWNER agent, a human via the web plane, or an authenticated FULL-AGENT credential — your token's LIVE tags classify you as a full agent (gateway and cron credentials excluded; the class is server-derived, never declared) — atomically re-takes an in_progress task whose claim is held by a dispatched runner session, across owners. ONE write flips the holder session to you (status stays in_progress): no release→pool→re-claim, so no dispatcher can win the card in between. The ex-holder's next state change is gate-rejected with a stand-down order (checkpoint last_will via log_progress — still open to it — then exit); its WIP survives in its registered worktree. Refused (terminal, named rules) on: verify/unblock duty cards (separation of duties is not transferable), cards holding a typed wait (train slot / await_event / bound ask — the wait owns the exit), and credentials with no authority anchor (server-verified from your token, never declared — BR#2673). Pause law (BR#6068 lesson): an interactive session about to wait on the human should bind an ask to the task — an open ask pauses the watchdog; a bare pause is abandonment and the claim is fairly lost.",
    schema: TOOL_ARG_SCHEMAS.claim_takeover,
    handler: async (args, ctx) => text(JSON.stringify(
      await ctx.call("claim.takeover", { ...args, session: args.session ?? ctx.sessionName, token_id: ctx.identity.token_id }),
      null, 1,
    )),
  },
  create_artefact: {
    description: `Create an artefact. Types: ${ARTEFACT_TYPES.join(", ")}.`,
    schema: TOOL_ARG_SCHEMAS.create_artefact,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("create", { ...args, session: args.session, token_id: ctx.identity.token_id }))),
  },
  update_artefact: {
    description: "Edit title/body/meta/tags/roles. meta MERGES per top-level key: keys you pass replace wholesale (nested objects must be complete), keys you omit are PRESERVED — meta is infrastructure on lane cards (lane/lease/currently/stop) and parked cards (blocked.await_event); never re-send a partial meta expecting replace (BR#5807). Remove keys explicitly with meta_delete: [\"key\"] — null values store as null, not deletes; lane/park infrastructure keys refuse meta_delete from agent sessions (route through an answered ask or the web). Does not change status — use transition.",
    schema: TOOL_ARG_SCHEMAS.update_artefact,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("update", args))),
  },
  transition: {
    description: `Move artefact status under its lifecycle. Per type: ${Object.entries(LIFECYCLES)
      .map(([t, m]) => `${t}: ${Object.entries(m as Record<string, string[]>).map(([f, tos]) => `${f}→${tos.join("|")}`).join(", ")}`)
      .join("; ")}. Moving to blocked REQUIRES note (reason) + a typed await_event from the closed grammar — pass await_event directly ({event:"ask",ask_id:"BR#N"} | {event:"time",until_ts:<epoch ms>} | {event:"pr_merged",repo,n} | {event:"br_done",id} | …), or an unblock_condition citing it as prose: "Machine proxy (typed await_event ask ask_id=BR#N): …" parses to the same typed event (BR#4062). No dead-end cards. For a long/handed-off op (re-index, deploy, background batch): transition {to: "blocked", class: "subprocess", note, unblock_condition, budget_minutes} — watchdog paused until the budget lapses; past it the block converts to abandoned. BR#6432 batch disposition: an agent cannot supersede directly (BR#2480), but when a human has ANSWERED a batch-authorization ask ("SUPERSEDE all N …", receipts in the ask body), you may apply it per target: transition {id: "<target>", to: "superseded", batch_auth: {ask: "BR#N"}} — the hub verifies the human answer server-side, checks the target is named in the ask's census and still an open park, executes the drop as system:question(<answered_by>), and stamps meta.batch_auth provenance. Recheck each target's live state FIRST — the old ruling only applies while its predicate still holds.`,
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
    description: "Typed requests: route independent_review + task_id schedules/reuses an independent agent review (no question/options needed); executor_coordination + task_id follows the current executor; agent_coordination targets a peer or pool; human_decision addresses human only for a genuine choice/authority Bridge lacks. Never ask the human to find another agent. Decisions/coordination require a complete plain-English question ≤240 chars and 2–8 explicit options naming actor and consequence. Human decisions also require reason (why Bridge needs the human) and details (self-contained user-visible context; technical evidence second). Recommended option first, prefixed '(Recommended)'. Bind artefact_id to pause your task until answered. Resolve questions via answer_ask, never progress notes. Offline agent delivery returns to the agent pool, not the human inbox.",
    schema: TOOL_ARG_SCHEMAS.ask_agent,
    handler: async (args, ctx) => {
      const a = await ctx.call("ask.create", { route: args.route, decision: args.decision, to: args.to, question: args.question, reason: args.reason, details: args.details, options: args.options, artefact_id: args.artefact_id, session: args.session ?? ctx.sessionName });
      return text(JSON.stringify({
        ...a,
        note: a.kind === "independent_review" ? a.message : a.task_status === "blocked"
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
  // ---- merge train (BR#3516/BR#3517) — executor-facing: bridge train.
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
    description: "Record a train event (kind) on a lane and let the hub act: merged (PR merged into base — stamps provenance, carry-verdicts clean updates, card → awaiting-CI), carried (a MECHANICAL head move — same patch-ids, executor-proved via git range-diff — carries the accepted verdict as a new chain leg; no bounce, no re-verify; BR#4689 L1.4), bounced (conflict with base — card → in_progress with the fix-up brief; verdict invalidated, re-verify then re-queue at the back), stopped (stop-the-line — lane halts, culprit card bounced with failing runs, ONE ask per class to the alarm sink), landed (REQUIRED inline checks proving main green — hub classifies, executor never self-certifies; closes the impl card and advances the queue), updated (BR#4687: machine update-branch on a behind worker-authored branch — stamps the carry chain, the verdict carries, the card silently re-enters the queue). Requires the lane lease.",
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
  train_bisect: {
    description: "Red-settle bisect (BR#4934) — one step per tick while the line is stopped on a burst-red settle. step {sha, verdict} stamps the probe of one intermediate merge sha (oldest→newest walk order); a RED step names culprit_task (the ONE culprit card — the hub bounces it and re-parks the wrongly-bounced final card); inconclusive:true stamps the walk failed and the pass bounces oldest-first instead. Requires the lane lease.",
    schema: TOOL_ARG_SCHEMAS.train_bisect,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("train.bisect", args), null, 1)),
  },
  train_queue_facts: {
    description: "Feed the executor's per-tick per-entry gate verdicts for the whole derived queue, in walk (rank) order — stored on the lane and served to the trains panel (queue blocks). Classes: ready | waiting | conflict | needs-review | blocked. Requires the lane lease.",
    schema: TOOL_ARG_SCHEMAS.train_queue_facts,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("train.queue_facts", args), null, 1)),
  },
  train_carry: {
    description: "Feed one machine-clean carry (BR#4934 settle-window rebase): after gh pr update-branch moved a verdict-covered head from_head→to_head content-preserving, the hub appends the carry record so the accepted verdict covers the new head (BR#3516 §5 shape). The hub appends via the carry law; the executor never writes card meta. Requires the lane lease.",
    schema: TOOL_ARG_SCHEMAS.train_carry,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("train.carry", args), null, 1)),
  },
  train_history: {
    description: "The train_events ledger for a lane — the audit chain of merged/bounced/stopped/landed/updated with provenance (sha → PR → task → verdict → session).",
    schema: TOOL_ARG_SCHEMAS.train_history,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("train.history", args), null, 1)),
  },
  train_lane: {
    description: "Find-or-create the standing lane card for repo@base, seeding config from the train_lane setting (or the spec arg). Call once per lane before leasing.",
    schema: TOOL_ARG_SCHEMAS.train_lane,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("train.lane", args), null, 1)),
  },
  train_observe_deploy: {
    description: "Report first-hand read-only GitHub deployment observations independently of the merger lease. The hub validates commit/run receipts and decides line health and recovery. Does not authorize merges or bypass checks.",
    schema: TOOL_ARG_SCHEMAS.train_observe_deploy,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("train.observe_deploy", args), null, 1)),
  },
  train_recovery_event: {
    description: "Record cause-specific recovery diagnosis, action attempt, outcome and next step. Repeated event IDs are idempotent; retry budgets survive executor restarts. Code submission never marks live recovery. Only a matched successful decisive deployment closes an episode.",
    schema: TOOL_ARG_SCHEMAS.train_recovery_event,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("train.recovery_event", args), null, 1)),
  },
  reconcile_schedule: {
    description: "View (no spec) or set the board↔GitHub reconcile schedule: enabled, interval_secs (300..21600), repos (CSV), verify_age_h, disposition_age_h. The gateway daemon reads this cadence.",
    schema: TOOL_ARG_SCHEMAS.reconcile_schedule,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("reconcile.schedule", args), null, 1)),
  },
  reconcile_report: {
    description: "Feed one daemon observation cycle: the repo's open PRs (raw `gh pr list --json` rows). The hub runs the join, applies every judgement (bind / ignore / spawn duties / reverse-close via provenance), records the accounting, and alarms when the invariant fails. Read-only on GitHub, write-only on the board.",
    schema: TOOL_ARG_SCHEMAS.reconcile_report,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("reconcile.report", args), null, 1)),
  },
  reconcile_status: {
    description: "The operator view of reconciliation: settings, recent accounting lines (the canary), the duty ledger, ignores, and PRs on the reverse-reconcile missing clock.",
    schema: TOOL_ARG_SCHEMAS.reconcile_status,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("reconcile.status", args), null, 1)),
  },
  reconcile_ignore: {
    description: "Rule one PR off the board WITH A REASON — the invariant's second disposition. {repo, pr, reason}; the report then accounts it as ignored-with-reason instead of alarming.",
    schema: TOOL_ARG_SCHEMAS.reconcile_ignore,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("reconcile.ignore", args), null, 1)),
  },
  // ---- proxy verification probes (BR#4658) — executor-facing: the daemon
  // leg beside the merge train. The hub holds no VCS credentials (BR#3516);
  // run_success / pr_checks_green parks get their closer through these two
  // tools: the executor polls the probe queue, runs gh READ-ONLY first-hand,
  // feeds the verdict back, and the hub decides (head law, flip, events).
  proxy_probes: {
    description: "Poll the proxy verification queue (BR#4658): typed-await parks on run_success / pr_checks_green that need a first-hand gh check the hub cannot make (BR#3516). Executor daemon leg: for each probe run the gh command its kind names, then report through proxy_verify. Read-only on GitHub; the hub owns every decision.",
    schema: TOOL_ARG_SCHEMAS.proxy_probes,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("proxy.probes", args), null, 1)),
  },
  proxy_verify: {
    description: "Feed one proxy probe's gh verdict back (BR#4658). {key, ok, receipt (GitHub URL(s) of the evidence), head_sha, conclusion, error, conclusive}. The hub applies the head law (mismatch = conclusive NO, BR#3409 fail-closed), stamps the proxy_verified event with the receipt on the parked card, and lets the standard satisfied-proxy path close or spawn. Transient gh failures just back off (attempt-capped).",
    schema: TOOL_ARG_SCHEMAS.proxy_verify,
    handler: async (args, ctx) => text(JSON.stringify(await ctx.call("proxy.verify", args), null, 1)),
  },
});

export type { ToolCtx, ToolName };
