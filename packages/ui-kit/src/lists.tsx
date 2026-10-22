import type { BoardTask, VerdictDecision } from "./types";
import { groupVerdicts, kindOf, ageText } from "./utils";

export function TopList({ tasks, now, onOpen }: {
  tasks: BoardTask[];
  now: number;
  onOpen?: (id: string) => void;
}) {
  return (
    <div className="bt-list">
      <div className="bt-head">
        <span>task</span><span>state</span><span>gauge</span><span>last signal</span>
      </div>
      {tasks.map((t) => {
        const kind = kindOf(t);
        const p = t.meta?.last_progress;
        const sig = Math.max(p?.ts ?? 0, t.status_ts ?? 0, t.updated_ts ?? 0);
        const st = t.status;
        const blocked = st === "blocked";
        const exit = t.meta?.blocked?.unblock_condition ?? t.meta?.awaiting_ask?.ask_id;
        const stale = now - sig > 60 * 60_000;
        return (
          <div key={t.id} className={`bt-row ${blocked ? "bt-blocked" : ""}`} onClick={() => onOpen?.(t.id)}>
            <span className={`conn conn-${now - sig < 60 * 60_000 ? "open" : "closed"}`}>●</span>
            <span className="bt-id gw-mono">{t.id}</span>
            <div className="bt-main">
              <span className={`k-pill k-${kind}`}>{kind}</span>
              <span className="bt-title" title={t.title}>{t.title}</span>
              {p?.will && <span className="bt-will" title={p.will}>▸ {String(p.will).slice(0, 70)}</span>}
              {blocked && exit && (
                <span className="bt-exit"><span className="chip chip-urgent">exit</span> {String(exit).slice(0, 90)}</span>
              )}
              {p?.note && !blocked && <span className="bt-note">{String(p.note).slice(0, 110)}</span>}
            </div>
            <div className="bt-state">
              <span className={`st-chip ${st === "in_progress" ? "st-live" : blocked ? "st-err" : "st-amber"}`}>{st.replace("_", " ")}</span>
              {p?.sentiment && <span className="bt-sent">{String(p.sentiment).replace("_", " ")}</span>}
            </div>
            <span className="bt-gauge">
              {p?.confidence_pct != null && <span className="bt-num">conf {p.confidence_pct}%</span>}
              {p?.risk_pct != null && <span className="bt-num">risk {p.risk_pct}%</span>}
              {!p && <span className="bt-num">—</span>}
            </span>
            <span className="bt-bar">
              {blocked && exit ? null : (
                <>
                  <span className="bt-barfill"><span className="bt-barin" style={{ width: `${Math.max(0, Math.min(100, p?.completion_pct ?? 0))}%` }} /></span>
                  <span className="bt-num">{p?.completion_pct != null ? `${p.completion_pct}%` : "—"}</span>
                </>
              )}
            </span>
            <span className="bt-age">{ageText(sig, now)}</span>
          </div>
        );
      })}
      {tasks.length === 0 && <span className="bt-empty">nothing in flight</span>}
    </div>
  );
}

export function BacklogList({ queue, done, now, onOpen }: {
  queue: BoardTask[];
  done?: BoardTask[];
  now: number;
  onOpen?: (id: string) => void;
}) {
  return (
    <div className="bt-list">
      <div className="bl-head">
        <span>item</span><span>meta</span><span>age</span>
      </div>
      {queue.map((t) => {
        const kind = kindOf(t);
        const boosted = !!t.meta?.boosted;
        const att = t.meta?.attempt?.attempts ?? 0;
        const exit = t.meta?.blocked?.unblock_condition ?? t.meta?.awaiting_ask?.ask_id;
        return (
          <div key={t.id} className={`bl-row ${boosted ? "bl-boosted" : ""}`} onClick={() => onOpen?.(t.id)}>
            {boosted && <span className="bl-rank bl-rank-boost" title="boosted — priority 0">▲</span>}
            <span className="bl-id gw-mono">{t.id}</span>
            <div className="bl-main">
              <span className={`k-pill k-${kind}`}>{kind}</span>
              <span className="bl-title" title={t.title}>{t.title}</span>
              {exit && <span className="bl-exit"><span className="chip chip-urgent">exit</span> {String(exit).slice(0, 90)}</span>}
            </div>
            <span className="bl-meta">
              {att > 0 && <span className="chip chip-urgent" title={`attempted ${att}x`}>×{att}</span>}
              <span className="bl-age">{ageText(t.updated_ts, now)}</span>
            </span>
          </div>
        );
      })}
      {queue.length === 0 && <span className="bt-empty">queue empty</span>}
      {done && done.length > 0 && (
        <>
          <div className="bl-done-head">done</div>
          {done.map((t) => (
            <div key={t.id} className="bl-row bl-done" onClick={() => onOpen?.(t.id)}>
              <span className="bl-id gw-mono">{t.id}</span>
              <div className="bl-main"><span className="bl-title">{t.title}</span></div>
              <span className="bl-meta">{t.owner || t.meta?.session || "—"}</span>
              <span className="bl-age">{ageText(t.status_ts ?? t.updated_ts, now)} ago</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export function ForYouList({ verdictCards, genericDecisions, blocked, openQuestions, onAct, onOpen, onOpenThread }: {
  verdictCards: Array<{ latest: VerdictDecision; prior: VerdictDecision[] }>;
  genericDecisions: VerdictDecision[];
  blocked: BoardTask[];
  openQuestions: BoardTask[];
  onAct: (id: string, act: "accepted" | "rejected") => void;
  onOpen?: (id: string) => void;
  onOpenThread?: (id: string) => void;
}) {
  return (
    <div className="bt-list">
      {verdictCards.map(({ latest, prior }) => {
        const verdict = String(latest.meta?.verdict ?? "").toLowerCase() === "bounce" ? "BOUNCE" : "VERIFIED";
        const target = String(latest.meta?.task ?? latest.meta?.verify_target ?? "");
        return (
          <div key={latest.id} className="fy-verdict">
            <div className="fy-chips">
              <span className="chip chip-urgent">{verdict}</span>
              <span className="chip chip-scope">{target}</span>
              {prior.length > 0 && <span className="fy-prior">+ {prior.length} prior round{prior.length > 1 ? "s" : ""}</span>}
            </div>
            <div className="fy-title">{latest.title}</div>
            <div className="fy-actions">
              <button className="fy-btn fy-accept" onClick={() => onAct(latest.id, "accepted")}>{verdict === "BOUNCE" ? "Bounce it" : "Accept"}</button>
              <button className="fy-btn fy-reject" onClick={() => onAct(latest.id, "rejected")}>Reject</button>
            </div>
          </div>
        );
      })}
      {genericDecisions.map((d) => (
        <div key={d.id} className="fy-verdict">
          <div className="fy-chips"><span className="chip chip-urgent">DECISION</span></div>
          <div className="fy-title">{d.title}</div>
          <div className="fy-actions">
            <button className="fy-btn fy-accept" onClick={() => onAct(d.id, "accepted")}>Accept</button>
            <button className="fy-btn fy-reject" onClick={() => onAct(d.id, "rejected")}>Reject</button>
          </div>
        </div>
      ))}
      {blocked.map((t) => (
        <div key={t.id} className="fy-verdict" onClick={() => onOpen?.(t.id)}>
          <div className="fy-chips"><span className="chip chip-urgent">BLOCKED</span></div>
          <div className="fy-title">{t.title}</div>
          <div className="fy-sub">{t.meta?.blocked?.unblock_condition ?? t.meta?.blocked?.reason ?? ""}</div>
        </div>
      ))}
      {openQuestions.map((t) => (
        <div key={t.id} className="fy-verdict" onClick={() => onOpenThread?.(t.id)}>
          <div className="fy-chips"><span className="chip chip-urgent">QUESTION</span></div>
          <div className="fy-title">{t.title}</div>
        </div>
      ))}
      {verdictCards.length === 0 && genericDecisions.length === 0 && blocked.length === 0 && openQuestions.length === 0 && (
        <div className="fy-empty">nothing needs you right now</div>
      )}
    </div>
  );
}
