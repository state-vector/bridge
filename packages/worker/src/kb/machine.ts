// THE task lifecycle law — one table, one total executor. Every transition
// rule lives here as a declarative row; do.ts persists and executes the
// effects but never invents legality. Adding a rule = adding a row (+ its
// guard test); the matrix suite then covers it mechanically.
//
// Layering: core.ts LIFECYCLES owns the per-type edge shape (which statuses
// may follow which); this module owns the ROLE + INTENT law layered on top —
// who may move what, carrying what evidence. Verdict duties (role:review,
// role:unblock) are done-only terminals: blocked/in_review are not in their
// alphabet (the only carve-out is an ask-gate, which auto-resumes on answer).
//
// Contract (BR#2419 item 2): decide() is TOTAL and PURE — it returns
// Applied(effects) | Rejection{code, rule, message}. Effects (spawn, escalate,
// supersede cascades) are DECIDED here and EXECUTED by do.ts. No legality and
// no spawn/escalate decision lives outside this file.
import { parseTags, validateTransition } from "./core";

export type Role = "impl" | "analysis" | "review" | "unblock" | "human" | "plain";

/** A task's lane from its roles column (bare names, JSON array). Tags never
 *  carry roles — they are inert user labels (decision BR#2983). */
export function effectiveRole(roles: string[]): Role {
  if (roles.includes("review")) return "review";
  if (roles.includes("unblock")) return "unblock";
  if (roles.includes("analysis")) return "analysis";
  if (roles.includes("impl")) return "impl";
  if (roles.includes("human")) return "human";
  return "plain";
}

export const VERDICT_ROLES: Role[] = ["review", "unblock"];

const HUMAN_ACTOR = /^web(:|$)|^human:/;
// system actors (watchdog, churn-guard, separation) act ON claims — releases
// they perform are the machinery working, not agents dumping each other's work
const OWNER_RELEASE_EXEMPT = /^(web(:|$)|human:|system:)/;

export interface RuleInput {
  id: string;
  type: string;
  status: string;
  to: string;
  roles: string[];
  tags: string[];
  meta: any;
  actor: string;
  body: any;
  owner?: string; // current claim holder — release-ownership rule reads it
  now?: number; // executor clock (injected; keeps decide() pure/testable)
}

/** Lazy, memoization-friendly accessors — do.ts backs these with SQL; guards
 *  only touch what they need so cheap transitions stay cheap. */
export interface RuleCtx {
  qualify(kind: "analysis" | "review"): { ok: boolean; via?: string } | Promise<{ ok: boolean; via?: string }>;
  unmetBars(): string[] | Promise<string[]>;
  session(): string | null | Promise<string | null>;
  evidence(id: string): { type: string; roles?: string[]; tags?: string[]; meta: any } | null | Promise<{ type: string; roles?: string[]; tags?: string[]; meta: any } | null>;
  parent(): { id: string; status?: string; meta: any } | null | Promise<{ id: string; status?: string; meta: any } | null>;
  openChildren(): number | Promise<number>;
  /** verify-of-verify / nesting-cap guard: the spawn-blocker reason or null */
  spawnGuard(): string | null | Promise<string | null>;
  /** newest OPEN role:review child (reuse candidate), or null */
  openVerifyChild(): { id: string } | null | Promise<{ id: string } | null>;
  /** newest OPEN role:unblock child (cap ≤1 per parent), or null */
  openUnblockChild(): { id: string } | null | Promise<{ id: string } | null>;
  /** recent version-log rows (newest first) for the silent-churn fold */
  recentEvents(): { ts: number; actor: string; action: string; summary: string }[] | Promise<{ ts: number; actor: string; action: string; summary: string }[]>;
}

export type Guard = (i: RuleInput, c: RuleCtx) => string | null | Promise<string | null>;

export interface Rule {
  name: string;
  when: (i: RuleInput) => boolean;
  guard: Guard;
}

const role = (i: RuleInput) => effectiveRole(i.roles ?? []);
const isTask = (i: RuleInput) => i.type === "task";
const noteOf = (i: RuleInput) => String(i.body?.note ?? i.body?.resolution ?? i.body?.reason ?? "").trim();
const hasEvidenceLink = (s: string) => /https?:\/\/\S+|(^|\s)PR[\s#:]/i.test(s);
const hasReceipts = (s: string) => /https?:\/\/\S+|(^|\s)(PR|merged|passed|unblocked|still blocked)\b/i.test(s);

/** SQL rows carry meta as a JSON string; tests and callers may pass objects.
 *  Parse tolerantly either way — garbage parses as empty, never throws. */
export function metaOf(m: unknown): any {
  if (typeof m === "string") {
    try {
      return JSON.parse(m || "{}");
    } catch {
      return {};
    }
  }
  return m ?? {};
}

// Churn policy (server-side single source): a task released to the pool this
// many times without completing stops re-entering silently.
export const CHURN_REDIRECT_ATTEMPTS = 5; // impl/analysis: release redirects to blocked
export const CHURN_ESCALATE_ATTEMPTS = 3; // verdict roles: escalate to human (they may not block)

/** What the release path does with a task re-entering the pool. */
export type ChurnOutcome = "pass" | "escalate" | "redirect";

/**
 * The churn decision for one release, as a pure function so every host obeys
 * the same counter (BR#2404/BR#2420 — the silent-dispatch loop class: claim →
 * stall → watchdog release → re-claim, forever). Verdict duties
 * (role:review/role:unblock) may not block, so at CHURN_ESCALATE_ATTEMPTS they
 * escalate to a human instead of redirecting; everything else stops silently
 * re-entering at CHURN_REDIRECT_ATTEMPTS — the release becomes an honest
 * blocked record. Releasing an already-blocked task is a deliberate act and
 * never re-redirects.
 */
export function churnRelease(nextAttempts: number, verdictDuty: boolean, fromStatus: string): ChurnOutcome {
  if (verdictDuty && nextAttempts >= CHURN_ESCALATE_ATTEMPTS) return "escalate";
  if (nextAttempts >= CHURN_REDIRECT_ATTEMPTS && fromStatus !== "blocked") return "redirect";
  return "pass";
}

// Silent-churn policy: zero-output watchdog stall cycles, folded server-side
// from the version log (a stall with NO interleaved agent output is one
// cycle). Escalation must trip at ≤5 cycles per BR#2419 — no runner counter,
// no cross-host signature.
export const SILENT_ESCALATE_CYCLES = 3; // verdict duties
export const SILENT_REDIRECT_CYCLES = 5; // impl/analysis

// Flood guard: a superseded unblock round still counts while fresh (<60m) and
// the exit condition is unchanged — the BR#909 class spawned one child per
// churn cycle (17 cards) because each cycle superseded the last.
export const UNBLOCK_FLOOD_MS = 60 * 60_000;

// ---------- effects: decided here, executed by do.ts ----------

export type Effect =
  | { kind: "spawn_verify"; parent: string; pr: string | null }
  | { kind: "reuse_verify"; parent: string; verify: string }
  | { kind: "skip_verify_spawn"; parent: string; reason: string }
  | { kind: "spawn_unblock"; parent: string; reason: string; exit_condition: string }
  | { kind: "skip_unblock_spawn"; parent: string; reason: string }
  | { kind: "supersede_children"; parent: string; tag: "review" | "unblock"; keep_newest: boolean; cause: string }
  | { kind: "escalate"; attempts: number; silent_cycles: number; reason: string }
  | { kind: "release_redirect"; attempts: number; silent_cycles: number };

/** meta_patch: entries with value `undefined` DELETE the key (typed stamping). */
export interface Applied {
  ok: true;
  status: string; // final status to write — the churn redirect may override the requested edge
  owner_clear: boolean; // release semantics: drop the claim
  tags_add: string[];
  meta_patch: Record<string, unknown | undefined>;
  effects: Effect[];
}

export type RejectionCode = "illegal-edge" | "guard-failed";

export interface Rejection {
  ok: false;
  code: RejectionCode; // illegal-edge = not a lifecycle edge; guard-failed = a table row refused it
  rule: string; // "lifecycle" for illegal edges, else the table row's name
  message: string;
}

export type Verdict = Applied | Rejection;

export const RULES: Rule[] = [
  {
    name: "verdict-no-in_review",
    when: (i) => isTask(i) && i.to === "in_review" && VERDICT_ROLES.includes(role(i)),
    guard: (i) =>
      `${i.id} is a ${role(i) === "review" ? "verify" : "unblock"} task — verification is its own terminal state. ${role(i) === "review" ? "Verify" : "Unblock"} tasks close directly via done with receipts; they are never reviewed again.`,
  },
  {
    name: "verdict-no-blocked",
    when: (i) =>
      isTask(i) &&
      i.to === "blocked" &&
      VERDICT_ROLES.includes(role(i)) &&
      !i.body?.awaiting_ask_id, // an ask-gate pauses the duty; it auto-resumes on the answer
    guard: (i) =>
      `${i.id} is a ${role(i) === "review" ? "verify" : "unblock"} task — verdict duties cannot block. They either render the verdict (done with receipts) or record findings and close done; "cannot proceed" is itself a verdict. Escalate via ask_agent instead.`,
  },
  {
    name: "release-needs-ownership",
    when: (i) =>
      isTask(i) &&
      i.to === "todo" &&
      !!i.owner &&
      i.owner !== i.actor &&
      !OWNER_RELEASE_EXEMPT.test(i.actor),
    guard: (i) =>
      `task ${i.id} is claimed by ${i.owner} — only the owner or a human can release it to the pool. If the work overlaps yours, coordinate via ask_agent instead.`,
  },
  {
    name: "decision-acceptance-human",
    when: (i) => i.type === "decision" && i.to === "accepted" && !HUMAN_ACTOR.test(i.actor),
    guard: (i) =>
      `decision ${i.id} acceptance is human-authoritative — agents propose, a human accepts in the webapp. Route it to a human for the final say (an ask, or the decisions panel).`,
  },
  {
    name: "human-signoff-done",
    when: (i) => isTask(i) && i.to === "done" && role(i) === "human" && !HUMAN_ACTOR.test(i.actor),
    guard: (i) =>
      `task ${i.id} is a human sign-off task (role: human) — completion is human-authoritative; a human marks it done in the webapp.`,
  },
  {
    name: "claim-bars",
    when: (i) => isTask(i) && i.status === "todo" && i.to === "in_progress",
    guard: async (i, c) => {
      const bars = await c.unmetBars();
      if (!bars.length) return null;
      return `task ${i.id} is qualified but its publisher requested further confirmation before it goes ready — unmet bars: ${bars.join(", ")}. Satisfy them with a done child task of that role or an accepted decision.`;
    },
  },
  {
    name: "claim-separation-of-duties",
    when: (i) => isTask(i) && i.status === "todo" && i.to === "in_progress",
    guard: async (i, c) => {
      const q = await c.qualify("analysis");
      if (!q.ok || !q.via || q.via === "declared" || String(q.via).startsWith("parent:")) return null;
      const ev = await c.evidence(String(q.via));
      if (!ev || ev.type !== "task" || !(ev.roles ?? []).includes("analysis")) return null;
      const evSession = metaOf(ev.meta).session;
      const sess = await c.session();
      if (evSession && sess && evSession === sess)
        return `separation of duties: session "${sess}" completed the analysis on ${i.id} — analysis and impl are separate sessions. End this session, start a new one, then claim ${i.id} for implementation.`;
      return null;
    },
  },
  {
    name: "done-unreviewed",
    when: (i) =>
      isTask(i) &&
      i.to === "done" &&
      !["analysis", "review", "unblock"].includes(role(i)),
    guard: async (i, c) => {
      const r = await c.qualify("review");
      if (r.ok) return null;
      return `task ${i.id} cannot be completed unreviewed — complete a verify (review-role) child task or link an accepted decision (e.g. a Superpositional verdict) first`;
    },
  },
  {
    name: "question-not-claimable",
    when: (i) => i.type === "question" && i.to === "in_progress",
    guard: (i) =>
      `task ${i.id} is a question — questions are answered, not claimed. Contribute via log_progress {id, did, will}; the author closes it with an ADR (decision artefact, derived_from this task).`,
  },
  {
    name: "operator-gated",
    when: (i) => isTask(i) && i.to === "in_progress" && i.meta?.operator_gated,
    guard: (i) =>
      `task ${i.id} is operator-gated (${i.meta.operator_gated}) — a human clears this by updating the task (remove operator_gated from meta) before it can be claimed.`,
  },
  {
    name: "unblock-needs-resolution",
    when: (i) => i.status === "blocked" && i.to === "in_progress",
    guard: (i) =>
      noteOf(i)
        ? null
        : `moving out of blocked requires a resolution (note) — the card promised an unblock condition; cite how it resolved`,
  },
  {
    name: "review-needs-pr",
    when: (i) => isTask(i) && i.to === "in_review",
    guard: (i) =>
      hasEvidenceLink(noteOf(i))
        ? null
        : `moving to in_review requires the PR link in the note (you stay owner until the verdict — done requires review acceptance, not your call)`,
  },
  {
    name: "bounce-needs-findings",
    when: (i) => i.status === "in_review" && i.to === "in_progress",
    guard: (i) =>
      noteOf(i)
        ? null
        : `bouncing back from review requires the reviewer's findings (note) — "no" without reasons is not an answer`,
  },
  {
    name: "blocked-needs-path",
    when: (i) => i.to === "blocked",
    guard: (i) => {
      const reason = String(i.body?.note ?? i.body?.reason ?? "").trim();
      const unblock = String(i.body?.unblock_condition ?? "").trim();
      return reason && unblock
        ? null
        : "moving to blocked requires BOTH a reason (note) and an unblock condition — a blocked card without an unblock path is a dead end";
    },
  },
  {
    name: "verdict-done-needs-receipts",
    when: (i) => isTask(i) && i.to === "done" && (role(i) === "review" || role(i) === "unblock"),
    guard: (i) =>
      hasReceipts(noteOf(i))
        ? null
        : `${role(i) === "unblock" ? "unblock" : "review"} ${i.id} cannot complete without receipts — cite what you verified in the note (PR link, merge state, the check you ran, or the unblock verdict).`,
  },
  {
    name: "review-separation-of-duties",
    when: (i) => isTask(i) && i.to === "done" && (role(i) === "review" || role(i) === "unblock"),
    guard: async (i, c) => {
      const parent = await c.parent();
      const implSession = parent ? metaOf(parent.meta).session : undefined;
      const reviewSession = metaOf(i.meta).session;
      if (implSession && reviewSession && implSession === reviewSession)
        return `separation of duties: session "${reviewSession}" implemented ${parent?.id} — it cannot also produce the review. Review from a different session.`;
      return null;
    },
  },
  {
    name: "done-open-children",
    when: (i) => isTask(i) && i.to === "done",
    guard: async (i, c) => {
      const open = await c.openChildren();
      return open > 0
        ? `parent ${i.id} still has ${open} open child task(s) — finish or close them first (decomposition owns its children)`
        : null;
    },
  },
];

/** Total executor (BR#2419): base lifecycle + every role/intent rule, first
 *  failing rule wins, then effects are decided. Never throws. do.ts
 *  persists Applied and executes its effects; Rejection is surfaced as-is. */
export async function decide(i: RuleInput, c: RuleCtx): Promise<Verdict> {
  // ---- the law: edge shape first, then the table, first fail wins ----
  const base = validateTransition(i.type as any, i.status, i.to);
  if (base.ok === false) return { ok: false, code: "illegal-edge", rule: "lifecycle", message: base.reason };
  for (const r of RULES) {
    if (!r.when(i)) continue;
    const err = await r.guard(i, c);
    if (err) return { ok: false, code: "guard-failed", rule: r.name, message: err };
  }
  if (i.type !== "task") return { ok: true, status: i.to, owner_clear: false, tags_add: [], meta_patch: {}, effects: [] };

  // ---- effects: every spawn/escalate/stamp/supersede decision lives here ----
  const now = i.now ?? Date.now();
  const meta = metaOf(i.meta);
  const r = role(i);
  const patch: Record<string, unknown | undefined> = {};
  const tagsAdd: string[] = [];
  const effects: Effect[] = [];
  let status = i.to;
  let ownerClear = false;

  // release to the pool: attempt stamp, churn escalate/redirect — decided, not improvised
  if (i.to === "todo") {
    const nextAttempts = ((meta.attempt?.attempts as number) ?? 0) + 1;
    const silent = silentCycles(await c.recentEvents());
    const verdictDuty = r === "review" || r === "unblock";
    const lastReason = String(i.body?.note ?? "").trim() || meta.attempt?.last_reason;
    const attempt = { by: i.actor, at: now, attempts: nextAttempts, last_reason: lastReason, last_will: meta.last_progress?.will };
    if (verdictDuty && (nextAttempts >= CHURN_ESCALATE_ATTEMPTS || silent >= SILENT_ESCALATE_CYCLES)) {
      // verdict duties may not block (the table refuses it) — repeated gate
      // rejections or silent churn escalate to a human instead
      const reason =
        silent >= SILENT_ESCALATE_CYCLES && nextAttempts < CHURN_ESCALATE_ATTEMPTS
          ? `verdict duty went silent ${silent} watchdog cycles with no agent output — server-side churn escalation (last: ${String(lastReason ?? "").slice(0, 200)}). Human: review get_history, fix the recurring failure, or re-scope`
          : `verdict duty released ${nextAttempts} times without completing — the same gate keeps rejecting the handoff (last: ${String(lastReason ?? "").slice(0, 200)}). Human: review get_history, fix the recurring failure, or re-scope`;
      patch.escalate = { at: now, attempts: nextAttempts, silent_cycles: silent, reason };
      patch.attempt = attempt;
      ownerClear = true;
      effects.push({ kind: "escalate", attempts: nextAttempts, silent_cycles: silent, reason });
    } else if (!verdictDuty && i.status !== "blocked" && (nextAttempts >= CHURN_REDIRECT_ATTEMPTS || silent >= SILENT_REDIRECT_CYCLES)) {
      // churn guard: the pool has re-run this task N times (or N silent
      // cycles) and a gate keeps rejecting the completion. Re-releasing loops
      // claim → dispatch → reject forever — redirect the release into an
      // honest block: reason and exit are on the card.
      const blockReason =
        silent >= SILENT_REDIRECT_CYCLES && nextAttempts < CHURN_REDIRECT_ATTEMPTS
          ? `churn guard: ${silent} consecutive zero-output watchdog cycles — silent churn, server-side escalated`
          : `churn guard: released to the pool ${nextAttempts} times without completing — the same gate keeps rejecting the handoff (last: ${String(lastReason ?? "").slice(0, 200)})`;
      status = "blocked";
      patch.blocked = {
        reason: blockReason,
        unblock_condition: "read the task history (get_history) and the last gate error, resolve what it names, then re-claim or re-issue the task",
        ts: now,
      };
      patch.attempt = attempt;
      effects.push({ kind: "release_redirect", attempts: nextAttempts, silent_cycles: silent });
    } else {
      ownerClear = true;
      patch.attempt = {
        by: i.actor,
        at: now,
        attempts: nextAttempts,
        last_reason: meta.blocked?.reason ?? (String(i.body?.note ?? "").trim() || undefined),
        last_will: meta.last_progress?.will,
      };
      if (!i.tags.includes("attempted")) tagsAdd.push("attempted");
    }
  }

  // completion resets the churn counter (BR#2503 residual: the lifetime
  // counter tripped churn on the FIRST release of an old, completed task).
  // Shape kept for display: the last attempt is still visible, count zeroed.
  if ((i.to === "done" || i.to === "superseded") && meta.attempt && typeof meta.attempt === "object")
    patch.attempt = { ...meta.attempt, attempts: 0 };

  // entering review: the verification duty. Recursion-guarded; reuse over spawn.
  if (i.to === "in_review" && r !== "review") {
    const guard = await c.spawnGuard();
    if (guard) {
      effects.push({ kind: "skip_verify_spawn", parent: i.id, reason: guard });
    } else {
      const open = await c.openVerifyChild();
      if (open) effects.push({ kind: "reuse_verify", parent: i.id, verify: open.id });
      else
        effects.push({
          kind: "spawn_verify",
          parent: i.id,
          pr: (String(i.body?.note ?? "").match(/https?:\/\/\S+/) || [])[0] ?? null,
        });
    }
  }

  // supersede cascades: children are ephemeral — when the parent moves on,
  // their round closes (review rounds keep their newest child alive across a
  // bounce so the same round re-enters).
  if (["in_progress", "todo", "done"].includes(i.to)) {
    const cause =
      i.to === "in_progress" && i.status === "blocked"
        ? `${i.id} resumed from blocked — unblock confirmed, child superseded`
        : i.to === "in_progress" && i.status === "in_review"
          ? `${i.id} bounced — unblock round closed`
          : `${i.id} → ${i.to} — unblock round closed`;
    effects.push({ kind: "supersede_children", parent: i.id, tag: "unblock", keep_newest: false, cause });
  }
  if (i.to === "done" || (i.status === "in_review" && i.to === "in_progress")) {
    const isBounce = i.status === "in_review" && i.to === "in_progress";
    effects.push({
      kind: "supersede_children",
      parent: i.id,
      tag: "review",
      keep_newest: isBounce,
      cause: isBounce ? `${i.id} bounced — older verification rounds superseded (newest kept for re-entry)` : `${i.id} done — verification round closed`,
    });
  }

  // entering blocked: at most ONE live unblock child per parent, ever. Ask
  // gates auto-resume (a spawned child would race the answer); subprocess
  // declarations are silence-on-a-working-task, not a block; unblock duties
  // don't spawn their own kind.
  if (
    i.to === "blocked" &&
    r !== "unblock" &&
    !meta.awaiting_ask &&
    !i.body?.awaiting_ask_id &&
    i.body?.class !== "subprocess"
  ) {
    const open = await c.openUnblockChild();
    if (open) {
      effects.push({ kind: "skip_unblock_spawn", parent: i.id, reason: `existing unblock child ${open.id} reused` });
    } else {
      const exit = String(i.body?.unblock_condition ?? "").trim();
      const last = meta.last_unblock_spawn;
      if (last && typeof last.at === "number" && now - last.at < UNBLOCK_FLOOD_MS && String(last.exit ?? "") === exit) {
        effects.push({
          kind: "skip_unblock_spawn",
          parent: i.id,
          reason: `unblock round issued ${Math.round((now - last.at) / 60_000)}m ago with the same exit condition — flood guard`,
        });
      } else {
        effects.push({
          kind: "spawn_unblock",
          parent: i.id,
          reason: String(i.body?.note ?? i.body?.reason ?? "").trim(),
          exit_condition: exit,
        });
      }
    }
  }

  return { ok: true, status, owner_clear: ownerClear, tags_add: tagsAdd, meta_patch: patch, effects };
}

/** Compatibility shim over decide(): the rejection message or null. (The
 *  matrix suite asserts on messages; do.ts consumes the typed Verdict.) */
export async function check(i: RuleInput, c: RuleCtx): Promise<string | null> {
  const v = await decide(i, c);
  if (v.ok === false) return v.message;
  return null;
}

// ---------- invariants: post-conditions on the single write path ----------

/** Structural facts that must hold for any stored artefact. Violations are
 *  breaches (loud trail + quarantine), never silently repaired. */
export function invariants(a: { type: string; status: string; roles?: string[]; tags?: string[]; meta: any }): string[] {
  const v: string[] = [];
  const r = effectiveRole(a.roles ?? []);
  if (a.type === "task") {
    if (VERDICT_ROLES.includes(r) && a.status === "blocked")
      v.push(`verdict role ${r} is blocked — verdict duties are done-only terminals`);
    if (VERDICT_ROLES.includes(r) && a.status === "in_review")
      v.push(`verdict role ${r} is in_review — verdict duties are never reviewed`);
    if (!a.meta?.blocked && a.status === "blocked")
      v.push("status is blocked with no meta.blocked record (reason + unblock condition missing)");
    if (a.meta?.blocked && a.status !== "blocked")
      v.push("meta.blocked record on a non-blocked task (stale dead-end record)");
  }
  if (a.type === "question" && a.status === "in_progress")
    v.push("question is in_progress — questions are answered, not claimed");
  return v;
}

// ---------- silent-churn fold: zero-output watchdog cycles from the version log ----------

export interface CycleEvent {
  ts: number;
  actor: string;
  action: string;
  summary: string;
}

const isAgentOutput = (e: CycleEvent) => !/^system:/.test(e.actor);
const isWatchdogStall = (e: CycleEvent) => /^system:/.test(e.actor) && /stall|releas|redirect/i.test(e.summary);

/** Count consecutive zero-output watchdog stall cycles (server-side, from
 *  the version log — no runner counter, no cross-host signature). A stall
 *  with interleaved agent output resets the run. */
export function silentCycles(events: CycleEvent[]): number {
  const asc = [...events].sort((a, b) => a.ts - b.ts);
  let run = 0;
  for (const e of asc) {
    if (isAgentOutput(e)) run = 0;
    else if (isWatchdogStall(e)) run++;
  }
  return run;
}

// ---------- replay consistency: fold the version log, compare to stored state ----------

export interface ReplayEvent {
  action: string;
  data: any;
}

/** Fold transition events forward from the log. The fold RE-ANCHORS at every
 *  chain gap (a row whose `from` doesn't match the folded state — a silent
 *  status write, a stale/duplicate stamp, out-of-order history): the log's
 *  own chain continues from the row's `to`, so one historical gap cannot
 *  poison every future fold (BR#3322: the early-return contract made the
 *  BR#903 pre-gate rows re-fire the replay breach on every transition,
 *  forever). The gap count is the integrity signal; the replay LAW —
 *  fold(events) == stored_state (BR#2419 item 6) — is enforced by the
 *  caller comparing `status` with the stored status.
 *  - `ok`: the log chained without any gap.
 *  - `breaks`: how many gaps were re-anchored across.
 *  - `tailBreak`: the LAST transition row is itself a gap — fresh damage,
 *    worth an audit line the moment it lands. */
export function replayStatus(from: string, versions: ReplayEvent[]): { status: string; ok: boolean; breaks: number; tailBreak: boolean } {
  let expected = from;
  let anchored = false;
  let breaks = 0;
  let tailBreak = false;
  for (const v of versions) {
    if (v.action !== "transition") continue;
    const to = v.data?.to;
    if (typeof to !== "string") continue;
    if (anchored && v.data?.from !== expected) {
      breaks++;
      tailBreak = true; // provisional — a later row that chains clears it
    } else {
      tailBreak = false;
    }
    expected = to; // re-anchor: the log's own chain continues from here
    anchored = true;
  }
  return { status: expected, ok: breaks === 0, breaks, tailBreak };
}

// ---------- breach detection: fold over the audit stream, deduped ----------

export interface BreachEvent {
  ts: number;
  task: string;
  op: string; // transition_rejected | invariant_violation | spawn_skipped | replay_mismatch
  reason: string;
}

export interface Breach {
  key: string; // (task, class) — one OPEN breach per key, reoccurrences coalesce
  task: string;
  klass: string;
  count: number;
  first_ts: number;
  last_ts: number;
  sample: string;
}

export const BREACH_WINDOW_MS = 30 * 60_000;
export const BREACH_THRESHOLD = 3;

/** Per-class thresholds: storms (same-gate rejections) need repetition;
 *  the other classes are breaches on the FIRST event — a double-spawn
 *  attempt, an invariant violation, or a replay mismatch is never noise. */
export const BREACH_THRESHOLDS: Record<string, number> = {
  invariant: 1,
  replay: 1,
  "spawn-while-open": 1,
  default: BREACH_THRESHOLD,
};

/** Classify an audit event into a stable breach class. Known gates get named
 *  classes; unknown reasons fall into a coarse bucket so the fold stays
 *  deduped even for novel messages. */
export function breachClass(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("pr link")) return "gate:review-needs-pr";
  if (r.includes("unreviewed")) return "gate:done-unreviewed";
  if (r.includes("references no git repository")) return "gate:no-repo";
  if (r.includes("without receipts")) return "gate:verdict-receipts";
  if (r.includes("separation of duties")) return "gate:separation";
  if (r.includes("open child")) return "gate:open-children";
  if (r.includes("cannot block")) return "gate:verdict-no-blocked";
  if (r.includes("never reviewed")) return "gate:verdict-no-in_review";
  return "other";
}

function classOf(e: BreachEvent): string {
  if (e.op === "invariant_violation") return "invariant";
  if (e.op === "spawn_skipped") return "spawn-while-open";
  if (e.op === "replay_mismatch") return "replay";
  return breachClass(e.reason);
}

/** Fold events into breaches: same (task, class) within the window is ONE
 *  breach once its threshold is crossed, and never re-raised while its key
 *  is open. Raising is the caller's guarded effect. */
export function detectBreaches(
  events: BreachEvent[],
  openKeys: Set<string>,
  opts?: { windowMs?: number },
): Breach[] {
  const windowMs = opts?.windowMs ?? BREACH_WINDOW_MS;
  const relevant = events.filter((e) =>
    ["transition_rejected", "invariant_violation", "spawn_skipped", "replay_mismatch"].includes(e.op),
  );
  relevant.sort((a, b) => a.ts - b.ts);
  const groups = new Map<string, Breach>();
  for (const e of relevant) {
    const klass = classOf(e);
    const key = `${e.task}|${klass}`;
    const g = groups.get(key);
    if (g) {
      if (e.ts - g.first_ts <= windowMs) {
        g.count++;
        g.last_ts = e.ts;
      }
    } else {
      groups.set(key, { key, task: e.task, klass, count: 1, first_ts: e.ts, last_ts: e.ts, sample: e.reason.slice(0, 200) });
    }
  }
  return [...groups.values()].filter((b) => b.count >= (BREACH_THRESHOLDS[b.klass] ?? BREACH_THRESHOLDS.default) && !openKeys.has(b.key));
}
