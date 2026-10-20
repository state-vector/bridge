import { useMemo, useState } from "react";
import { useKb } from "../store/kb";
import { TaskDetail } from "./TaskDetail";
import { kindOf, rel } from "../lib/views";

/** Backlog + Completed: the queue and the ledger.
 *  Backlog = work to be done, ranked by what gets picked up next (the same
 *  ranking orient feeds the runner: unblock duties first, then blocked with an
 *  exit condition, then verify duty, then questions, then plain todo — oldest
 *  first within a rank). Completed = done work, newest first. Everything else
 *  lives in Top; Board keeps the swimlane view. */

function rankOf(t: any, parentIdOf: Map<string, string>): { rank: number; why: string } {
  const tags: string[] = t.tags ?? [];
  const m = t.meta ?? {};
  if (tags.includes("role:unblock")) return { rank: 0, why: "unblock duty — cheapest lever on parked work" };
  if (t.status === "blocked") {
    if (m.blocked?.unblock_condition) return { rank: 1, why: "blocked with an exit condition — resumable now" };
    return { rank: 5, why: "blocked without an exit condition — needs re-scope" };
  }
  const parentId = parentIdOf.get(t.id);
  if (parentId && tags.includes("role:review")) return { rank: 2, why: `verify duty — parks ${parentId}'s owner` };
  if (tags.includes("question")) return { rank: 3, why: "question — open for contributions" };
  if (tags.includes("role:analysis")) return { rank: 3, why: "analysis — qualifies downstream impl" };
  return { rank: 4, why: "todo" };
}

export function BacklogView() {
  const tasks = useKb((s) => s.tasks);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const rows = useMemo(() => {
    const parentOf = new Map<string, string>();
    for (const t of tasks as any[]) if ((t as any).part_of) parentOf.set(t.id, (t as any).part_of);
    const inReview = new Set((tasks as any[]).filter((t) => t.status === "in_review").map((t) => t.id));
    return (tasks as any[])
      .filter((t) => t.status === "todo" || t.status === "blocked")
      .map((t) => {
        const tags: string[] = t.tags ?? [];
        const isVerify = tags.includes("role:review") && parentOf.get(t.id) && inReview.has(parentOf.get(t.id)!);
        const { rank, why } = rankOf(t, parentOf);
        return {
          t,
          rank: isVerify ? 2 : rank,
          why: isVerify ? `verify duty — parks ${parentOf.get(t.id)}'s owner` : why,
          attempts: t.meta?.attempt?.attempts ?? 0,
        };
      })
      .sort((a, b) => a.rank - b.rank || a.t.updated_ts - b.t.updated_ts);
  }, [tasks]);

  return (
    <div className="backlog-wrap">
      {selectedTaskId && <TaskDetail taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} onOpen={setSelectedTaskId} />}
      <div className="view-head">
        <h2>Backlog</h2>
        <span className="muted-note">{rows.length} items — ranked by what gets picked up next; unblock and verify duty first, oldest first within a rank</span>
      </div>
      <div className="backlog-list">
        {rows.map(({ t, rank, why, attempts }) => {
          const kind = kindOf(t);
          return (
            <div key={t.id} className="backlog-row" onClick={() => setSelectedTaskId(t.id)}>
              <span className="backlog-rank" title={`pickup rank ${rank}: ${why}`}>{rank + 1}</span>
              <span className="backlog-id">{t.id}</span>
              <span className="backlog-main">
                <span className={`chip chip-kind kind-pill kp-${kind}`}>{kind}</span>
                <span className="backlog-title">{t.title}</span>
                {t.status === "blocked" && (t.meta?.blocked?.unblock_condition || t.meta?.awaiting_ask?.ask_id) && (
                  <span className="backlog-why">
                    {t.meta?.awaiting_ask?.ask_id
                      ? <><span className="chip chip-urgent">ask</span> {t.meta.awaiting_ask.ask_id}</>
                      : <><span className="chip chip-scope">exit</span> {(t.meta.blocked.unblock_condition ?? "").slice(0, 90)}</>}
                  </span>
                )}
              </span>
              <span className="backlog-meta">
                {attempts > 0 && <span className="chip chip-urgent" title={`attempted ${attempts}x`}>×{attempts}</span>}
                {t.owner ? <span title={`claimed by ${t.owner}`}>{t.owner}</span> : <span className="backlog-pool">pool</span>}
              </span>
              <span className="backlog-age top-num" title="last updated">{rel(t.updated_ts)}</span>
            </div>
          );
        })}
        {rows.length === 0 && <p className="empty">Backlog empty — everything in flight or done.</p>}
      </div>
    </div>
  );
}

export function CompletedView() {
  const tasks = useKb((s) => s.tasks);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const rows = useMemo(
    () => (tasks as any[]).filter((t) => t.status === "done").sort((a, b) => (b.status_ts ?? b.updated_ts) - (a.status_ts ?? a.updated_ts)),
    [tasks],
  );

  return (
    <div className="backlog-wrap">
      {selectedTaskId && <TaskDetail taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} onOpen={setSelectedTaskId} />}
      <div className="view-head">
        <h2>Completed</h2>
        <span className="muted-note">{rows.length} items — newest first</span>
      </div>
      <div className="backlog-list">
        {rows.map((t) => {
          const kind = kindOf(t);
          const lifetime = t.created_ts && t.status_ts ? Math.round((t.status_ts - t.created_ts) / 60000) : null;
          return (
            <div key={t.id} className="backlog-row backlog-done" onClick={() => setSelectedTaskId(t.id)}>
              <span className="backlog-id">{t.id}</span>
              <span className="backlog-main">
                <span className={`chip chip-kind kind-pill kp-${kind}`}>{kind}</span>
                <span className="backlog-title">{t.title}</span>
              </span>
              <span className="backlog-meta">{t.owner || t.meta?.session || "—"}</span>
              <span className="backlog-age top-num" title={lifetime ? `lifetime ${lifetime}m` : undefined}>
                done {rel(t.status_ts ?? t.updated_ts)}
                {lifetime != null && lifetime >= 60 ? ` · ${Math.floor(lifetime / 60)}h+` : lifetime != null ? ` · ${lifetime}m` : ""}
              </span>
            </div>
          );
        })}
        {rows.length === 0 && <p className="empty">Nothing completed yet.</p>}
      </div>
    </div>
  );
}
