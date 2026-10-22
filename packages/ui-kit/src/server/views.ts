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
