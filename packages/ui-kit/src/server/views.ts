import type { Decision, EventView, Presence } from "@bridge/specs";
import { relTime } from "../relTime";

/** The API doc says EventView.ts is ms epoch; tolerate seconds-valued ts from early adapters. */
export function normTs(ts: number): number {
  return ts > 0 && ts < 10_000_000_000 ? ts * 1000 : ts;
}

/** Relative time from possibly-seconds ts — the kit formatter + normTs. */
export function rel(ms: number): string {
  return relTime(normTs(ms));
}

export function clock(ms: number): string {
  return new Date(normTs(ms)).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * Client-side ranking (hub publishes open decisions unranked):
 * needs_input before diagnostic, then most recently updated first.
 */
export function rankDecisions(decisions: Decision[]): Decision[] {
  return [...decisions].sort((a, b) => {
    const k = (b.kind === "needs_input" ? 1 : 0) - (a.kind === "needs_input" ? 1 : 0);
    if (k) return k;
    return (b.updated_ts ?? 0) - (a.updated_ts ?? 0);
  });
}

export function actorEvents(events: EventView[], actorId: string, limit = 5): EventView[] {
  return events.filter((e) => e.actor === actorId).slice(0, limit);
}

export function latestTaskId(events: EventView[], actorId: string): string | null {
  return events.find((e) => e.actor === actorId && e.task_id)?.task_id ?? null;
}

export function boardsOf(decisions: Decision[], events: EventView[]): string[] {
  const set = new Set<string>();
  for (const d of decisions) if (d.board) set.add(d.board);
  for (const e of events) if (e.board) set.add(e.board);
  return [...set].sort();
}

export function myAnswers(events: EventView[], me: string): EventView[] {
  return events.filter((e) => e.actor === me && (e.kind === "unblocked" || e.kind === "completed"));
}

export function presenceLabel(p: Presence): string {
  return p.label && p.label !== p.id ? p.label : (p.id.split(":")[1] ?? p.id);
}

/** What the task IS: question / verify / analysis / research / impl.
 *  Structural: type + roles column (BR#2983) — tags are inert user labels
 *  and can no longer change the kind. */
export function kindOf(task: { type?: string; roles?: string[] | null; tags?: string[] | null; meta?: any }): string {
  const m = task.meta ?? {};
  if (task.type === "question" || m.kind === "question") return "question";
  const roles = (task.roles ?? []) as string[];
  if (roles.includes("review") || m.kind === "review") return "verify";
  if (roles.includes("analysis") || m.kind === "analysis") return "analysis";
  if ((task.tags ?? []).includes("research")) return "research";
  return "impl";
}

/** Task references (BR#12, TASK-007) inside arbitrary text — for hyperlinking. */
export const TASK_REF_RE = /\b(BR#\d+|TASK-\d+)\b/g;

/* ---- blocked-park classes shared by Top + Backlog (2026-10-24 spec, Ray) ---- */

/** Watchdog machine parks (churn guard / rework loop): nobody — human or
 *  agent — can action these right now; the owning agent resumes or the park
 *  lapses. Top excludes them; Backlog files them under TIMEOUT. */
export const TIMEOUT_BLOCK_RX = /rework loop|churn guard/i;

/* ---- BR#2893 churn-park pattern: the client mirror of the hub's
 * ---- blockedParkVerdict (worker kb/machine.ts). The hub drains dead parks
 * ---- automatically; the board files them under the Timeout exit class.
 * ---- Textual patterns MUST stay identical to the hub — change both
 * ---- together. */

/** Churn-guard stamp, either field: the reason ("churn guard: released N
 *  times…") or the boilerplate exit condition ("read the task history…").
 *  Superset of TIMEOUT_BLOCK_RX — legacy parks carried the boilerplate on the
 *  exit condition only. */
export const CHURN_PARK_RX = /read the task history \(get_history\) and the last gate error|rework loop|churn guard/i;

/** Churn-park test kept for Top's actionable admission filter. */
export function isTimeoutBlock(t: { status?: string; meta?: any }): boolean {
  return t.status === "blocked" && TIMEOUT_BLOCK_RX.test(String(t.meta?.blocked?.reason ?? ""));
}

/* ---- exit-condition classes (2026-10-29 spec, Ray): Top shows the
 * ---- actionable fleet only; every parked card files in Backlog under
 * ---- WHAT IT AWAITS. The class reads the card's TYPED await_event first
 * ---- (BR#3578 closed set — the machine leg the hub re-checks), then the
 * ---- prose unblock condition as fallback. */

export interface ExitClass {
  key: string;
  title: string;
  icon: string;
  note: string;
  /** BR#6395 — "Who/what unblocks it": the lever that owns the exit for this
   *  class, rendered as the section-level unblocker badge. One of:
   *  You · Agent · System — merge train · System — CI · System — proxy
   *  watch · System — watchdog timer. */
  unblockedBy: string;
}

const GH_ISSUE_RX = /github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+|\bGH#\d+\b/i;
const RED_MAIN_RX = /\bred\s+main\b|\bmain\s+is\s+red\b|stop-the-line|\buntil main (is )?green\b|\bline is green\b/i;
const DATE_RX = /\b(20\d{2})-(\d{2})-(\d{2})(?!\d)/;
/** BR#4962: the typed Awaiting review park a coverage bounce stamps
 *  (per accepted BR#4960 — no asks; the parked card IS the visibility). */
const AWAITING_RX = /^Awaiting review \(verdict /i;

/** BR#6330 — ONE merge classification: the typed merge_train phase is the
 *  single source of "awaiting merge" (decision BR#6330). Pure local readers
 *  of the SAME field the hub owns (meta.merge_train.state — the closed set
 *  lives canonically in @bridge/contracts MergeTrainPhaseSchema; ui-kit
 *  does not depend on that package for bundle isolation, so this mirrors it
 *  and MUST stay in sync with contracts mergePhaseOf/isAwaitingMerge).
 *  Prose reasons and the pr_merged await_event NO LONGER classify a card
 *  into the merge group — a card cannot enter the class by text. */
const MERGE_TRAIN_PHASES = new Set(["queued", "awaiting-ci", "bounced", "conflicting", "awaiting", "unbound", "base-red-park", "landed"]);
function mergePhaseOf(t: { meta?: any }): string | null {
  const st = String(t?.meta?.merge_train?.state ?? "");
  return st && MERGE_TRAIN_PHASES.has(st) ? st : null;
}
/** exported for the pinned test (BR#6330) — the one predicate. */
export function isAwaitingMerge(t: { meta?: any }): boolean {
  const p = mergePhaseOf(t);
  return p === "queued" || p === "awaiting-ci";
}

/** The exit-class table — single source; exitClassOf returns entries from it.
 *  Every class carries `unblockedBy` (BR#6395): the section badge answers
 *  "who/what unblocks it" before the reader opens a single card. */
export const EXIT_CLASSES: Record<string, ExitClass> = {
  ask: { key: "ask", title: "Awaiting you — ask pending", icon: "⚑", note: "a human ask holds the card; answer it and the asker resumes.", unblockedBy: "You" },
  awaiting: { key: "awaiting", title: "Awaiting review — force-review", icon: "◉", note: "coverage-bounced park (BR#4960: no asks): the accepted verdict lapsed at a new head — force-review from the card: approve re-anchors the verdict and re-queues the train, changes requested bounce impl.", unblockedBy: "You" },
  verify: { key: "verify", title: "Awaiting PR verification", icon: "✓", note: "in review — a fresh verify session must rule before the train can queue it.", unblockedBy: "Agent" },
  merge: { key: "merge", title: "Awaiting PR merge — train", icon: "⇥", note: "verified; holds a live merge-train slot (typed merge_train phase queued/awaiting-ci — BR#6330: the one classification). The count here is the trains panel queue by construction.", unblockedBy: "System — merge train" },
  conflict: { key: "conflict", title: "Awaiting PR rebase — conflict on train", icon: "⚠", note: "typed merge_train phase conflicting (BR#6348): the car left the queue on a merge conflict — the budget sweep + loud alarm own it; a signed rebase/re-push re-enters it.", unblockedBy: "Agent" },
  pr: { key: "pr", title: "Awaiting PR merge — not on train", icon: "🔗", note: "waiting on an upstream PR to merge OUTSIDE the train (typed pr_merged / br_pr_merged leg with no live train phase — BR#6395: these are dependency parks, not train cars). The proxy watch verifies the merge; the PR's owner moves it.", unblockedBy: "System — proxy watch" },
  ci: { key: "ci", title: "Awaiting CI", icon: "◔", note: "waiting on check runs (pr_checks_green / run_success).", unblockedBy: "System — CI" },
  deploy: { key: "deploy", title: "Awaiting deploy", icon: "▲", note: "waiting on a hub deploy at the named commit.", unblockedBy: "System — CI" },
  task: { key: "task", title: "Awaiting another task", icon: "◈", note: "waiting on another card's done/answer (br_done / br_answered).", unblockedBy: "Agent" },
  issue: { key: "issue", title: "Awaiting GitHub issue", icon: "⊙", note: "waiting on an upstream issue closing.", unblockedBy: "Agent" },
  time: { key: "time", title: "Awaiting a date", icon: "◷", note: "time-gated — flips when the clock passes.", unblockedBy: "System — watchdog timer" },
  main: { key: "main", title: "Awaiting green main", icon: "✖", note: "red-main / stop-the-line hold — resumes when the line is green.", unblockedBy: "System — CI" },
  other: { key: "other", title: "Blocked — other", icon: "▪", note: "no typed leg matched — open the card to resolve or re-scope.", unblockedBy: "You" },
  timeout: { key: "timeout", title: "Timeout — churn parks", icon: "⏱", note: "the watchdog drains these to the pool automatically (BR#2893); Release (or Release all) to put one back now — protected parks refuse and say why.", unblockedBy: "System — watchdog timer" },
};

/** Render order for the Backlog exit-class groups: human levers first, then
 *  machine gates by blast radius, parks last. Train-adjacent merge states
 *  stay together (merge → conflict → not-on-train, BR#6395). */
export const EXIT_CLASS_ORDER = ["ask", "awaiting", "verify", "merge", "conflict", "pr", "ci", "deploy", "task", "issue", "time", "main", "other", "timeout"];

/** BR#6395 — standing merge-lane anchor cards (the lane card itself,
 *  meta.lane.key, or a standing infra_anchor): they belong to the Trains
 *  panel, not to Backlog's task exit-condition groups. */
export function isLaneAnchor(t: { meta?: any }): boolean {
  const m = t?.meta ?? {};
  return Boolean(m.lane?.key) || Boolean(m.infra_anchor);
}

/** Blocked (or in_review) card → the exit class Backlog groups it under.
 *  First match wins; the typed await_event outranks prose. */
export function exitClassOf(t: { status?: string; meta?: any }): ExitClass {
  const m = t.meta ?? {};
  const b = m.blocked ?? {};
  const reason = String(b.reason ?? "");
  const unblock = String(b.unblock_condition ?? "");
  const ev = b.await_event?.event as string | undefined;
  if (t.status === "in_review") return EXIT_CLASSES.verify;
  if (t.status !== "blocked") return EXIT_CLASSES.other;
  if (CHURN_PARK_RX.test(reason) || CHURN_PARK_RX.test(unblock)) return EXIT_CLASSES.timeout;
  // the Awaiting park outranks the typed leg it preserves (BR#4962): the
  // pr_merged await_event rides along on an Awaiting park, but the HUMAN
  // force-review owns the exit, not the proxy
  if (AWAITING_RX.test(reason)) return EXIT_CLASSES.awaiting;
  if (ev === "ask" || m.awaiting_ask?.ask_id) return EXIT_CLASSES.ask;
  // BR#6330 — ONE classification: the typed merge_train phase decides the
  // merge class (queued|awaiting-ci ⇒ awaiting merge; awaiting ⇒ the
  // force-review park; conflicting ⇒ its own rebase section, BR#6395). The
  // pr_merged await_event is the machine LEG the train flips, not a display
  // class; the prose TRAIN/PR regexes are retired. BR#6395: the pre-BR#5750
  // legacy bridge (phase === null + pr_merged ⇒ train) is DELETED — a
  // pr_merged/br_pr_merged wait with no live train phase (null, unbound,
  // bounced) is an upstream-PR dependency park, not a train car, and files
  // under EXIT_CLASSES.pr ("not on train") so it can never inflate the
  // train section again.
  const phase = mergePhaseOf(t);
  if (phase === "awaiting") return EXIT_CLASSES.awaiting;
  if (phase === "queued" || phase === "awaiting-ci") return EXIT_CLASSES.merge;
  if (phase === "conflicting") return EXIT_CLASSES.conflict;
  if ((phase === null || phase === "unbound" || phase === "bounced") && (ev === "pr_merged" || ev === "br_pr_merged")) return EXIT_CLASSES.pr;
  if (ev === "pr_checks_green" || ev === "run_success") return EXIT_CLASSES.ci;
  if (ev === "deployed") return EXIT_CLASSES.deploy;
  if (ev === "br_done" || ev === "br_answered") return EXIT_CLASSES.task;
  if (ev === "issue_closed") return EXIT_CLASSES.issue;
  if (ev === "time") return EXIT_CLASSES.time;
  // prose fallback — no typed leg on the card
  if (GH_ISSUE_RX.test(unblock)) return EXIT_CLASSES.issue;
  if (RED_MAIN_RX.test(unblock) || RED_MAIN_RX.test(reason)) return EXIT_CLASSES.main;
  if (DATE_RX.test(unblock)) return EXIT_CLASSES.time;
  return EXIT_CLASSES.other;
}

export interface UnblockTwinIndex {
  byPartOf: Map<string, any>;
  byTitle: Map<string, any>;
}

/** in_progress "Unblock: <parent title>" duty cards (roles: ["unblock"]),
 *  keyed by parent id (part_of) and by the watchdog's naming convention. */
export function unblockTwinIndex(tasks: any[]): UnblockTwinIndex {
  const byPartOf = new Map<string, any>();
  const byTitle = new Map<string, any>();
  for (const t of tasks ?? []) {
    if (t.status !== "in_progress" || !(t.roles ?? []).includes("unblock")) continue;
    if (t.part_of) byPartOf.set(t.part_of, t);
    if (String(t.title ?? "").startsWith("Unblock: ")) byTitle.set(t.title.slice("Unblock: ".length), t);
  }
  return { byPartOf, byTitle };
}

/** The live unblock duty working this blocked task, if any. */
export function activeUnblockTwinOf(t: any, idx: UnblockTwinIndex): any | undefined {
  return idx.byPartOf.get(t.id) ?? idx.byTitle.get(t.title);
}
