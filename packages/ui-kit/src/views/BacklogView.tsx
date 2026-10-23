import { useMemo, useState } from "react";
import { useKb } from "../server/kbStore";
import { kbApi } from "../server/kb";
import { TaskDetail } from "./TaskDetail";
import { kindOf, rel } from "../server/views";
import { Btn, Chip } from "./index-kit";

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

export function BacklogView({ openTask }: { openTask?: (id: string) => void } = {}) {
  const conn = useKb((s) => s.conn);
  const tasks = useKb((s) => s.tasks);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const openDetails = (id: string) => (openTask ? openTask(id) : setSelectedTaskId(id));
  const [msg, setMsg] = useState("");

  const { queue, parked } = useMemo(() => {
    const parentOf = new Map<string, string>();
    for (const t of tasks as any[]) if ((t as any).part_of) parentOf.set(t.id, (t as any).part_of);
    const inReview = new Set((tasks as any[]).filter((t) => t.status === "in_review").map((t) => t.id));
    const decorate = (t: any) => {
      const tags: string[] = t.tags ?? [];
      const isVerify = tags.includes("role:review") && parentOf.get(t.id) && inReview.has(parentOf.get(t.id)!);
      const { rank, why } = rankOf(t, parentOf);
      const boosted = !!(t.meta?.boosted);
      return {
        t,
        rank: boosted ? -1 : (isVerify ? 2 : rank),
        why: boosted ? "boosted — priority 0 (human)" : (isVerify ? `verify duty — parks ${parentOf.get(t.id)}'s owner` : why),
        boosted,
        attempts: t.meta?.attempt?.attempts ?? 0,
      };
    };
    const all = (tasks as any[]).filter((t) => t.status === "todo" || t.status === "blocked").map(decorate);
    // parked = structurally not dispatchable (server-projected is_claimable) —
    // shown separately so hours-old items don't masquerade as a stuck queue
    const parked = all.filter(({ t }) => {
      const claimable = (t as any).is_claimable;
      if (t.status === "blocked") return !(t.meta?.blocked?.unblock_condition || t.meta?.awaiting_ask?.ask_id);
      return claimable === false;
    });
    const queue = all.filter((r) => !parked.includes(r))
      .sort((a, b) => (b.boosted ? 1 : 0) - (a.boosted ? 1 : 0) || a.rank - b.rank || a.t.updated_ts - b.t.updated_ts);
    parked.sort((a, b) => b.t.updated_ts - a.t.updated_ts);
    return { queue, parked };
  }, [tasks]);

  const parkedReason = (t: any): string => {
    if (t.status === "blocked") return "blocked without an exit condition — open the card, resolve or re-scope";
    if ((t.tags ?? []).includes("question") || t.meta?.kind === "question") return "question — collect answers, the author closes it with a decision";
    if (t.meta?.operator_gated) return `operator gate: ${t.meta.operator_gated} — a human clears it`;
    return (t as any).claim_reason || "not dispatchable — see card";
  };

  const boost = async (id: string, on: boolean, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await kbApi.boost(id, on);
      await useKb.getState().refresh();
      setMsg(on ? `boosted ${id} + dependencies` : `boost removed from ${id}`);
      setTimeout(() => setMsg(""), 2500);
    } catch (err) {
      setMsg(`failed: ${(err as Error).message}`);
    }
  };

  return (
    <div className="backlog-wrap">
      {selectedTaskId && <TaskDetail taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} onOpen={setSelectedTaskId} />}
      <div className="view-head">
        <h2>Backlog</h2>
        <span className="muted-note">{queue.length} dispatchable · {parked.length} parked — ranked by what gets picked up next</span>
        {msg && <span className="ok">{msg}</span>}
      </div>
      <div className="backlog-list">
        {queue.map(({ t, rank, why, boosted, attempts }) => {
          const kind = kindOf(t);
          return (
            <div key={t.id} className={`backlog-row ${boosted ? "backlog-boosted" : ""}`} onClick={() => openDetails(t.id)}>
              <span className="backlog-rank" title={`pickup rank: ${why}`}>{boosted ? "▲" : rank + 1}</span>
              <span className="backlog-id">{t.id}</span>
              <span className="backlog-main">
                <span className={`kind-pill kp-${kind}`}>{kind}</span>
                <span className="backlog-title">{t.title}</span>
                {t.status === "blocked" && (t.meta?.blocked?.unblock_condition || t.meta?.awaiting_ask?.ask_id) && (
                  <span className="backlog-why">
                    {t.meta?.awaiting_ask?.ask_id
                      ? <><Chip tone="urgent">ask</Chip> {t.meta.awaiting_ask.ask_id}</>
                      : <><Chip tone="scope">exit</Chip> {(t.meta.blocked.unblock_condition ?? "").slice(0, 90)}</>}
                  </span>
                )}
              </span>
              <span className="backlog-meta">
                <Btn
                  size="sm"
                  className="boost-btn"
                  on={boosted}
                  title={boosted ? "remove boost (this task + its open children)" : "boost to priority 0 (this task + its open children)"}
                  onClick={(e) => void boost(t.id, !boosted, e)}
                >
                  {boosted ? "▼ unboost" : "▲ boost"}
                </Btn>
                {attempts > 0 && <Chip tone="urgent" title={`attempted ${attempts}x`}>×{attempts}</Chip>}
                {t.owner ? <span title={`claimed by ${t.owner}`}>{t.owner}</span> : <span className="backlog-pool">pool</span>}
              </span>
              <span className="backlog-age top-num" title="last updated">{rel(t.updated_ts)}</span>
            </div>
          );
        })}
        {queue.length === 0 && <p className="empty">{conn === "closed" ? "Hub unreachable — check the gateway pairing / hub url." : "Queue empty — everything in flight, parked, or done."}</p>}
      </div>

      {parked.length > 0 && (
        <>
          <div className="view-head">
            <h2>Parked — not dispatchable</h2>
            <span className="muted-note">{parked.length} items waiting on a human, an author, or a gate — these will not move on their own</span>
          </div>
          <div className="backlog-list">
            {parked.map(({ t, attempts }) => {
              const kind = kindOf(t);
              return (
                <div key={t.id} className="backlog-row backlog-parked" onClick={() => openDetails(t.id)}>
                  <span className="backlog-rank backlog-rank-parked">▪</span>
                  <span className="backlog-id">{t.id}</span>
                  <span className="backlog-main">
                    <span className={`kind-pill kp-${kind}`}>{kind}</span>
                    <span className="backlog-title">{t.title}</span>
                    <span className="backlog-why"><Chip tone="scope">why</Chip> {parkedReason(t)}</span>
                  </span>
                  <span className="backlog-meta">
                    {attempts > 0 && <Chip tone="urgent" title={`attempted ${attempts}x`}>×{attempts}</Chip>}
                    {t.owner ? <span>{t.owner}</span> : <span className="backlog-pool">pool</span>}
                  </span>
                  <span className="backlog-age top-num" title="last updated">{rel(t.updated_ts)}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export function CompletedView({ openTask }: { openTask?: (id: string) => void } = {}) {
  const tasks = useKb((s) => s.tasks);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const openDetails = (id: string) => (openTask ? openTask(id) : setSelectedTaskId(id));

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
            <div key={t.id} className="backlog-row backlog-done" onClick={() => openDetails(t.id)}>
              <span className="backlog-id">{t.id}</span>
              <span className="backlog-main">
                <span className={`kind-pill kp-${kind}`}>{kind}</span>
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
