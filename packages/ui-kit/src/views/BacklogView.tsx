import { useMemo, useState } from "react";
import { useKb } from "../server/kbStore";
import { kbApi } from "../server/kb";
import { TaskDetail } from "./TaskDetail";
import { kindOf, rel, isTimeoutBlock, unblockTwinIndex, activeUnblockTwinOf } from "../server/views";
import { Btn, Chip } from "./index-kit";

/** Backlog + Completed: the whole queue, categorised (2026-10-24 spec, Ray):
 *  NEXT (todo, claim-ranked — boost/park from the card), BLOCKED grouped by
 *  reason (awaiting human · awaiting verify · unblock duty live · other),
 *  TIMEOUT (churn/rework machine parks — nobody can action them), PARKED
 *  (deliberately not dispatchable). Completed = done work, newest first.
 *  Same ktable primitive as Top; only --cols differ. */

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

interface BlGroup {
  key: string;
  title: string;
  note: string;
  rows: any[];
  showRank: boolean;
  showBoost: boolean;
}

export function BacklogView({ openTask }: { openTask?: (id: string) => void } = {}) {
  const conn = useKb((s) => s.conn);
  const tasks = useKb((s) => s.tasks);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const openDetails = (id: string) => (openTask ? openTask(id) : setSelectedTaskId(id));
  const [msg, setMsg] = useState("");

  const groups = useMemo<BlGroup[]>(() => {
    const ts = tasks as any[];
    const parentOf = new Map<string, string>();
    for (const t of ts) if (t.part_of) parentOf.set(t.id, t.part_of);
    const twinIdx = unblockTwinIndex(ts);
    const decorate = (t: any) => {
      const tags: string[] = t.tags ?? [];
      const inReviewParent = t.status === "todo" && tags.includes("role:review") && parentOf.get(t.id)
        && ts.some((p) => p.id === parentOf.get(t.id) && p.status === "in_review");
      const { rank, why } = rankOf(t, parentOf);
      const boosted = !!(t.meta?.boosted);
      return {
        t,
        rank: boosted ? -1 : (inReviewParent ? 2 : rank),
        why: boosted ? "boosted — priority 0 (human)" : (inReviewParent ? `verify duty — parks ${parentOf.get(t.id)}'s owner` : why),
        boosted,
        attempts: t.meta?.attempt?.attempts ?? 0,
      };
    };
    const byUpdated = (a: any, b: any) => (b.updated_ts ?? 0) - (a.updated_ts ?? 0);

    const ready = ts.filter((t) => t.status === "todo" && t.is_claimable !== false).map(decorate)
      .sort((a, b) => (b.boosted ? 1 : 0) - (a.boosted ? 1 : 0) || a.rank - b.rank || a.t.updated_ts - b.t.updated_ts);
    const blockedHuman = ts.filter((t) => t.status === "blocked" && !isTimeoutBlock(t) && t.meta?.awaiting_ask?.ask_id).sort(byUpdated);
    const verify = ts.filter((t) => t.status === "in_review").sort(byUpdated);
    const unblocking = ts.filter((t) => t.status === "blocked" && !isTimeoutBlock(t) && !t.meta?.awaiting_ask?.ask_id && activeUnblockTwinOf(t, twinIdx)).sort(byUpdated);
    const blockedOther = ts.filter((t) => t.status === "blocked" && !isTimeoutBlock(t) && !t.meta?.awaiting_ask?.ask_id && !activeUnblockTwinOf(t, twinIdx)).sort(byUpdated);
    const timeout = ts.filter((t) => isTimeoutBlock(t)).sort(byUpdated);
    const parked = ts.filter((t) => t.status === "todo" && t.is_claimable === false).sort(byUpdated);

    return [
      { key: "ready", title: "Next — ready to go", note: "claim-ranked: unblock duties → verify duties → questions → todo. ▲ boost pins priority 0; park from the card.", rows: ready, showRank: true, showBoost: true },
      { key: "human", title: "Blocked — awaiting you", note: "pending human ask — answer it and the asker resumes.", rows: blockedHuman, showRank: false, showBoost: false },
      { key: "verify", title: "Blocked — awaiting verify", note: "in review; the owner stays parked until a fresh verify session rules.", rows: verify, showRank: false, showBoost: false },
      { key: "unblocking", title: "Blocked — unblock duty live", note: "an agent is actively working the unblock; nothing for you to do.", rows: unblocking, showRank: false, showBoost: false },
      { key: "other", title: "Blocked — other", note: "machine exit conditions — they move when the condition fires.", rows: blockedOther, showRank: false, showBoost: false },
      { key: "timeout", title: "Timeout — churn/rework parks", note: "cannot be actioned by anyone; the owning agent resumes or the park lapses.", rows: timeout, showRank: false, showBoost: false },
      { key: "parked", title: "Parked — not dispatchable", note: "deliberately out of the pool; bring one back from its card.", rows: parked, showRank: false, showBoost: false },
    ].filter((g) => g.rows.length > 0);
  }, [tasks]);

  const parkedReason = (t: any): string => {
    if (isTimeoutBlock(t)) return "churn/rework park — agent resumes or it lapses";
    if (t.status === "blocked") return (t.meta?.blocked?.unblock_condition ?? "blocked — open the card, resolve or re-scope").slice(0, 90);
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

  const total = groups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <div className="backlog-wrap">
      {selectedTaskId && <TaskDetail taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} onOpen={setSelectedTaskId} />}
      <div className="view-head">
        <h2>Backlog</h2>
        <span className="muted-note">{total} items — next · blocked by reason · timeout · parked</span>
        {msg && <span className="ok">{msg}</span>}
      </div>
      {groups.map((g) => (
        <div key={g.key} className="backlog-group">
          <div className="view-head backlog-group-head">
            <h2>{g.title}</h2>
            <span className="muted-note">{g.rows.length} · {g.note}</span>
          </div>
          <div className="backlog-list">
            {g.rows.map((r: any) => {
              const t = r.t ?? r;
              const kind = kindOf(t);
              const rank = r.rank;
              const boosted = !!r.boosted;
              const attempts = r.attempts ?? t.meta?.attempt?.attempts ?? 0;
              return (
                <div
                  key={t.id}
                  className={`ktable-row backlog-row ${boosted ? "backlog-boosted" : ""} ${g.key === "timeout" || g.key === "parked" ? "backlog-parked" : ""}`}
                  onClick={() => openDetails(t.id)}
                >
                  <span className="backlog-rank" title={`pickup rank: ${r.why ?? parkedReason(t)}`}>
                    {boosted ? "▲" : g.showRank ? rank + 1 : g.key === "human" ? "⚑" : g.key === "verify" ? "✓" : g.key === "unblocking" ? "↻" : g.key === "timeout" ? "⏱" : "▪"}
                  </span>
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
                    {t.status === "in_review" && <span className="backlog-why"><Chip tone="warn">verify</Chip> awaiting a fresh verify session</span>}
                  </span>
                  <span className="backlog-meta">
                    {g.showBoost && (
                      <Btn
                        size="sm"
                        className="boost-btn"
                        on={boosted}
                        title={boosted ? "remove boost (this task + its open children)" : "boost to priority 0 (this task + its open children)"}
                        onClick={(e) => void boost(t.id, !boosted, e)}
                      >
                        {boosted ? "▼ unboost" : "▲ boost"}
                      </Btn>
                    )}
                    {attempts > 0 && <Chip tone="urgent" title={`attempted ${attempts}x`}>×{attempts}</Chip>}
                    {t.owner ? <span title={`claimed by ${t.owner}`}>{t.owner}</span> : <span className="backlog-pool">pool</span>}
                  </span>
                  <span className="backlog-age top-num" title="last updated">{rel(t.updated_ts)}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {groups.length === 0 && <p className="empty">{conn === "closed" ? "Hub unreachable — check your sign-in / hub url." : "Queue empty — everything in flight or done."}</p>}
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
            <div key={t.id} className="ktable-row backlog-row backlog-done" onClick={() => openDetails(t.id)}>
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
