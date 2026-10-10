import { useMemo } from "react";
import { useBridge } from "../lib/store";
import { myAnswers, rankDecisions } from "../lib/views";
import { DecisionCard } from "./DecisionCard";
import { SessionList } from "./SessionList";

export function Panel() {
  // selectors must return stable refs; derive new arrays via useMemo
  const decisions = useBridge((s) => s.decisions);
  const board = useBridge((s) => s.board);
  const visible = useMemo(
    () => rankDecisions(decisions).filter((d) => board === "all" || d.board === board),
    [decisions, board],
  );
  const events = useBridge((s) => s.events);
  const answered = useMemo(() => myAnswers(events, "human:ray"), [events]);

  return (
    <div className="panel-scroll">
      <section className="panel-section">
        <h2>Decisions{visible.length > 0 ? ` · ${visible.length}` : ""}</h2>
        <div className="ask-list">
          {visible.map((d) => (
            <DecisionCard key={d.id} d={d} />
          ))}
          {visible.length === 0 && <p className="empty">Nothing needs you right now.</p>}
        </div>
        {answered.length > 0 && (
          <div className="answered-strip">
            <span className="answered-label">Answered today</span>
            {answered.slice(0, 4).map((e) => (
              <span key={e.id} className="chip chip-done">
                {e.kind} · {(e.title ?? e.task_id ?? "").slice(0, 22)}
              </span>
            ))}
          </div>
        )}
      </section>
      <section className="panel-section">
        <h2>Sessions</h2>
        <SessionList />
      </section>
    </div>
  );
}
