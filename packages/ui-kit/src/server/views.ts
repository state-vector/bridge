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

/* ---- BR#2893 park classes: the client mirror of the hub's blockedParkVerdict
 * ---- (worker kb/machine.ts). The hub drains dead parks automatically; the
 * ---- board renders the same three populations. Textual patterns MUST stay
 * ---- identical to the hub — change both together. */

/** Churn-guard stamp, either field: the reason ("churn guard: released N
 *  times…") or the boilerplate exit condition ("read the task history…").
 *  Superset of TIMEOUT_BLOCK_RX — legacy parks carried the boilerplate on the
 *  exit condition only. */
export const CHURN_PARK_RX = /read the task history \(get_history\) and the last gate error|rework loop|churn guard/i;

export type ParkClass = "sin-bin" | "external" | "plain";

/** Which top-level population a blocked card belongs to: sin-bin (churn
 *  parks — user-releasable), external (a named outside gate — ask, dated
 *  checkpoint, GitHub lane, red-main), or plain (honest park, ages out
 *  hub-side). Non-blocked cards are null. Ask-status isn't known client-side,
 *  so dead-ask detection stays hub-only; the drain fixes the card, the board
 *  need only render it. */
export function parkClassOf(t: { status?: string; meta?: any }): ParkClass | null {
  if (t.status !== "blocked") return null;
  const m = t.meta ?? {};
  const b = m.blocked ?? {};
  const reason = String(b.reason ?? "");
  const unblock = String(b.unblock_condition ?? "");
  if (CHURN_PARK_RX.test(reason) || CHURN_PARK_RX.test(unblock)) return "sin-bin";
  if (m.awaiting_ask?.ask_id) return "external";
  if (/\b(20\d{2})-(\d{2})-(\d{2})(?!\d)/.test(unblock)) return "external";
  if (/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/\d+|\bGH#\d+\b/i.test(unblock)) return "external";
  if (/\bred\s+main\b|\bmain\s+is\s+red\b|\bstop-the-line\b|\buntil main (is )?green\b/i.test(unblock)) return "external";
  return "plain";
}

/** The external owner a blocked card waits on, for the awaiting-external
 *  section: a human ask, a date, a GitHub lane, or main's health. */
export function externalGateOf(t: { meta?: any }): { owner: string; next: string } {
  const b = t.meta?.blocked ?? {};
  const unblock = String(b.unblock_condition ?? "");
  if (t.meta?.awaiting_ask?.ask_id) {
    const awaiter = /awaiting (\S+) on ask/.exec(String(b.reason ?? ""));
    return { owner: awaiter ? awaiter[1] : "you (ask)", next: `${t.meta.awaiting_ask.ask_id} — answer resumes the card` };
  }
  const date = /\b(20\d{2}-\d{2}-\d{2})/.exec(unblock);
  if (date) return { owner: "clock", next: `until ${date[1]} — ${unblock.slice(0, 90)}` };
  if (/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/\d+|\bGH#\d+\b/i.test(unblock))
    return { owner: "GitHub lane", next: unblock.slice(0, 110) };
  return { owner: "main green", next: unblock.slice(0, 110) };
}

export function isTimeoutBlock(t: { status?: string; meta?: any }): boolean {
  return t.status === "blocked" && TIMEOUT_BLOCK_RX.test(String(t.meta?.blocked?.reason ?? ""));
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
