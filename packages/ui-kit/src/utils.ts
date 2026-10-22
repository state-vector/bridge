/** Pure view logic — no DOM, no fetch. Unit-testable in every shell. */
import type { BoardTask, VerdictDecision } from "./types";

export function kindOf(t: Pick<BoardTask, "tags" | "meta">): string {
  const tags: string[] = t.tags ?? [];
  if (tags.includes("role:unblock")) return "unblock";
  if (tags.includes("role:review")) return "verify";
  if (tags.includes("role:analysis")) return "analysis";
  if (t.meta?.kind === "question" || tags.includes("question")) return "question";
  return "impl";
}

export type Staleness = "fresh" | "warn" | "dead";

export function staleness(ts: number | undefined, now: number): Staleness {
  if (!ts) return "dead";
  const m = (now - ts) / 60_000;
  if (m > 60) return "dead";
  if (m > 30) return "warn";
  return "fresh";
}

export function ageText(ts: number | undefined, now: number): string {
  if (!ts) return "—";
  const sec = Math.max(0, Math.floor((now - ts) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** The orient-mirroring pickup rank: boosted → unblock → blocked-with-exit →
 *  verify → question/analysis → todo. Lower sorts first. */
export function rankOf(t: Pick<BoardTask, "status" | "tags" | "meta">): number {
  const tags: string[] = t.tags ?? [];
  if ((t.meta as any)?.boosted) return -1;
  if (tags.includes("role:unblock")) return 0;
  if (t.status === "blocked") {
    if ((t.meta as any)?.blocked?.unblock_condition) return 1;
    return 5;
  }
  if (tags.includes("role:review")) return 2;
  if (tags.includes("question")) return 3;
  if (tags.includes("role:analysis")) return 3;
  return 4;
}

/** For Me flood grouping: verdict decisions grouped by target task, newest
 *  first — callers render the latest and collapse the priors. */
export function groupVerdicts(decisions: VerdictDecision[]): { cards: Array<{ latest: VerdictDecision; prior: VerdictDecision[] }>; generic: VerdictDecision[] } {
  const verdicts = decisions.filter(
    (d) => (d.meta?.decision_class === "verify-verdict") && (d.meta?.task || d.meta?.verify_target),
  );
  const generic = decisions.filter((d) => !verdicts.includes(d));
  const byTarget = new Map<string, VerdictDecision[]>();
  for (const d of verdicts) {
    const key = String(d.meta?.task ?? d.meta?.verify_target);
    const arr = byTarget.get(key) ?? [];
    arr.push(d);
    byTarget.set(key, arr);
  }
  const cards = [...byTarget.values()]
    .map((arr) => arr.sort((a, b) => b.created_ts - a.created_ts))
    .map((arr) => ({ latest: arr[0], prior: arr.slice(1) }));
  cards.sort((a, b) => b.latest.created_ts - a.latest.created_ts);
  return { cards, generic };
}

/** Receipts fingerprint: identical when the verifier found the same world
 *  state — the flood dedup compares this across rounds for the same target. */
export function verdictFingerprint(meta: Record<string, unknown> | undefined): string {
  const m = meta ?? {};
  return JSON.stringify(
    Object.entries(m)
      .filter(([k]) => !["decision_class", "task", "verify_target", "verdict", "session", "round"].includes(k))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** Same verdict + same fingerprint for the same target = dedupe. */
export function sameVerdictAs(a: VerdictDecision, b: VerdictDecision): boolean {
  const av = String(a.meta?.verdict ?? "").toLowerCase();
  const bv = String(b.meta?.verdict ?? "").toLowerCase();
  return av === bv && verdictFingerprint(a.meta) === verdictFingerprint(b.meta);
}
