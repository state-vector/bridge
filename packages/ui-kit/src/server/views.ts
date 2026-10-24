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

/** What the task IS: question / verify / analysis / research / impl. */
export function kindOf(task: { tags?: string[] | null; meta?: any }): string {
  const tags = (task.tags ?? []) as string[];
  const m = task.meta ?? {};
  if (m.kind === "question" || tags.includes("question")) return "question";
  if (tags.includes("role:review") || m.kind === "review") return "verify";
  if (tags.includes("role:analysis") || m.kind === "analysis") return "analysis";
  if (m.kind === "research") return "research";
  return "impl";
}

/** Task references (BR#12, TASK-007) inside arbitrary text — for hyperlinking. */
export const TASK_REF_RE = /\b(BR#\d+|TASK-\d+)\b/g;

/* ---- blocked-park classes shared by Top + Backlog (2026-10-24 spec, Ray) ---- */

/** Watchdog machine parks (churn guard / rework loop): nobody — human or
 *  agent — can action these right now; the owning agent resumes or the park
 *  lapses. Top excludes them; Backlog files them under TIMEOUT. */
export const TIMEOUT_BLOCK_RX = /rework loop|churn guard/i;

export function isTimeoutBlock(t: { status?: string; meta?: any }): boolean {
  return t.status === "blocked" && TIMEOUT_BLOCK_RX.test(String(t.meta?.blocked?.reason ?? ""));
}

export interface UnblockTwinIndex {
  byPartOf: Map<string, any>;
  byTitle: Map<string, any>;
}

/** in_progress "Unblock: <parent title>" duty cards (role:unblock), keyed by
 *  parent id (part_of) and by the watchdog's naming convention. */
export function unblockTwinIndex(tasks: any[]): UnblockTwinIndex {
  const byPartOf = new Map<string, any>();
  const byTitle = new Map<string, any>();
  for (const t of tasks ?? []) {
    if (t.status !== "in_progress" || !(t.tags ?? []).includes("role:unblock")) continue;
    if (t.part_of) byPartOf.set(t.part_of, t);
    if (String(t.title ?? "").startsWith("Unblock: ")) byTitle.set(t.title.slice("Unblock: ".length), t);
  }
  return { byPartOf, byTitle };
}

/** The live unblock duty working this blocked task, if any. */
export function activeUnblockTwinOf(t: any, idx: UnblockTwinIndex): any | undefined {
  return idx.byPartOf.get(t.id) ?? idx.byTitle.get(t.title);
}
