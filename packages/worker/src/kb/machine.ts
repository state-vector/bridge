// THE task lifecycle law — one table, one total checker. Every transition
// rule lives here as a declarative row; do.ts executes the verdict but never
// invents legality. Adding a rule = adding a row (+ its guard test); the
// matrix suite then covers it mechanically.
//
// Layering: core.ts LIFECYCLES owns the per-type edge shape (which statuses
// may follow which); this module owns the ROLE + INTENT law layered on top —
// who may move what, carrying what evidence. Verdict duties (role:review,
// role:unblock) are done-only terminals: blocked/in_review are not in their
// alphabet (the only carve-out is an ask-gate, which auto-resumes on answer).
import { parseTags, validateTransition } from "./core";

export type Role = "impl" | "analysis" | "review" | "unblock" | "human" | "plain";

export function effectiveRole(tags: string[]): Role {
  if (tags.includes("role:review")) return "review";
  if (tags.includes("role:unblock")) return "unblock";
  if (tags.includes("role:analysis")) return "analysis";
  if (tags.includes("role:impl")) return "impl";
  if (tags.includes("role:human")) return "human";
  return "plain";
}

export const VERDICT_ROLES: Role[] = ["review", "unblock"];

const HUMAN_ACTOR = /^web(:|$)|^human:/;

export interface RuleInput {
  id: string;
  type: string;
  status: string;
  to: string;
  tags: string[];
  meta: any;
  actor: string;
  body: any;
}

/** Lazy, memoization-friendly accessors — do.ts backs these with SQL; guards
 *  only touch what they need so cheap transitions stay cheap. */
export interface RuleCtx {
  qualify(kind: "analysis" | "review"): { ok: boolean; via?: string } | Promise<{ ok: boolean; via?: string }>;
  unmetBars(): string[] | Promise<string[]>;
  session(): string | null | Promise<string | null>;
  evidence(id: string): { type: string; tags: string[]; meta: any } | null | Promise<{ type: string; tags: string[]; meta: any } | null>;
  parent(): { id: string; status?: string; meta: any } | null | Promise<{ id: string; status?: string; meta: any } | null>;
  openChildren(): number | Promise<number>;
}

export type Guard = (i: RuleInput, c: RuleCtx) => string | null | Promise<string | null>;

export interface Rule {
  name: string;
  when: (i: RuleInput) => boolean;
  guard: Guard;
}

const role = (i: RuleInput) => effectiveRole(i.tags);
const isTask = (i: RuleInput) => i.type === "task";
const noteOf = (i: RuleInput) => String(i.body?.note ?? i.body?.resolution ?? i.body?.reason ?? "").trim();
const hasEvidenceLink = (s: string) => /https?:\/\/\S+|(^|\s)PR[\s#:]/i.test(s);
const hasReceipts = (s: string) => /https?:\/\/\S+|(^|\s)(PR|merged|passed|unblocked|still blocked)\b/i.test(s);

// Churn policy (server-side single source): a task released to the pool this
// many times without completing stops re-entering silently.
export const CHURN_REDIRECT_ATTEMPTS = 5; // impl/analysis: release redirects to blocked
export const CHURN_ESCALATE_ATTEMPTS = 3; // verdict roles: escalate to human (they may not block)

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
    name: "decision-acceptance-human",
    when: (i) => i.type === "decision" && i.to === "accepted" && !HUMAN_ACTOR.test(i.actor),
    guard: (i) =>
      `decision ${i.id} acceptance is human-authoritative — agents propose, a human accepts in the webapp. Route it to a human for the final say (an ask, or the decisions panel).`,
  },
  {
    name: "human-signoff-done",
    when: (i) => isTask(i) && i.to === "done" && role(i) === "human" && !HUMAN_ACTOR.test(i.actor),
    guard: (i) =>
      `task ${i.id} is a human sign-off task (role:human) — completion is human-authoritative; a human marks it done in the webapp.`,
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
      if (!ev || ev.type !== "task" || !ev.tags.includes("role:analysis")) return null;
      const evSession = JSON.parse(ev.meta ?? "{}").session;
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
      return `task ${i.id} cannot be completed unreviewed — complete a role:review child task or link an accepted decision (e.g. a Superpositional verdict) first`;
    },
  },
  {
    name: "question-not-claimable",
    when: (i) => isTask(i) && i.to === "in_progress" && i.tags.includes("question"),
    guard: (i) =>
      `task ${i.id} is a question (tagged 'question') — questions are answered, not claimed. Contribute via log_progress {id, did, will}; the author closes it with an ADR (decision artefact, derived_from this task).`,
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
      const implSession = parent ? JSON.parse(parent.meta ?? "{}").session : undefined;
      const reviewSession = JSON.parse(i.meta ?? "{}").session;
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

/** Total: base lifecycle (core LIFECYCLES) + every role/intent rule, first
 *  failing rule wins. Returns the rejection message or null. Never throws. */
export async function check(i: RuleInput, c: RuleCtx): Promise<string | null> {
  const base = validateTransition(i.type as any, i.status, i.to);
  if (!base.ok) return base.reason;
  for (const r of RULES) {
    if (!r.when(i)) continue;
    const err = await r.guard(i, c);
    if (err) return err;
  }
  return null;
}

// ---------- invariants: post-conditions on the single write path ----------

/** Structural facts that must hold for any stored artefact. Violations are
 *  breaches (loud trail + quarantine), never silently repaired. */
export function invariants(a: { type: string; status: string; tags: string[]; meta: any }): string[] {
  const v: string[] = [];
  const r = effectiveRole(a.tags);
  if (a.type === "task") {
    if (VERDICT_ROLES.includes(r) && a.status === "blocked")
      v.push(`verdict role ${r} is blocked — verdict duties are done-only terminals`);
    if (VERDICT_ROLES.includes(r) && a.status === "in_review")
      v.push(`verdict role ${r} is in_review — verdict duties are never reviewed`);
    if (a.tags.includes("question") && a.status === "in_progress")
      v.push("question task is in_progress — questions are answered, not claimed");
    if (!a.meta?.blocked && a.status === "blocked")
      v.push("status is blocked with no meta.blocked record (reason + unblock condition missing)");
    if (a.meta?.blocked && a.status !== "blocked")
      v.push("meta.blocked record on a non-blocked task (stale dead-end record)");
  }
  return v;
}

// ---------- breach detection: fold over the audit stream, deduped ----------

export interface BreachEvent {
  ts: number;
  task: string;
  op: string; // e.g. transition_rejected, spawn_skipped, invariant_violation
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

/** Classify a rejection reason into a stable breach class. Known gates get
 *  named classes; unknown reasons fall into a coarse bucket so the fold
 *  stays deduped even for novel messages. */
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

/** Fold events into breaches: same (task, class) within the window is ONE
 *  breach once its threshold is crossed, and never re-raised while its key
 *  is open. Raising is the caller's guarded effect. */
export function detectBreaches(
  events: BreachEvent[],
  openKeys: Set<string>,
  opts?: { windowMs?: number; threshold?: number },
): Breach[] {
  const windowMs = opts?.windowMs ?? BREACH_WINDOW_MS;
  const threshold = opts?.threshold ?? BREACH_THRESHOLD;
  const rejected = events.filter((e) => e.op === "transition_rejected" || e.op === "invariant_violation");
  rejected.sort((a, b) => a.ts - b.ts);
  const groups = new Map<string, Breach>();
  for (const e of rejected) {
    const klass = e.op === "invariant_violation" ? "invariant" : breachClass(e.reason);
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
  return [...groups.values()].filter((b) => b.count >= threshold && !openKeys.has(b.key));
}
