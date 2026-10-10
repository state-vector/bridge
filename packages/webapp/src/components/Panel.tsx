import { useMemo } from "react";
import { useBridge, visibleDecisions } from "../lib/store";
import { myAnswers } from "../lib/views";
import { DecisionCard } from "./DecisionCard";
import { SessionList } from "./SessionList";

export function Panel() {
  const decisions = useBridge(visibleDecisions);
  const events = useBridge((s) => s.events);
  const answered = useMemo(() => myAnswers(events, "human:ray"), [events]);

  return (
    <div className="panel-scroll">
      <section className="panel-section">
        <h2>Decisions{decisions.length > 0 ? ` · ${decisions.length}` : ""}</h2>
        <div className="ask-list">
          {decisions.map((d) => (
            <DecisionCard key={d.id} d={d} />
          ))}
          {decisions.length === 0 && <p className="empty">Nothing needs you right now.</p>}
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
