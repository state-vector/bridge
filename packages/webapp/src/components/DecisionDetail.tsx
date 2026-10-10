import { useState } from "react";
import { useBridge } from "../lib/store";
import { rel } from "../lib/views";
import { BoardChip, KindBadge, UrgencyBadge } from "./ui";
import { WhyLine } from "./DecisionCard";

export function DecisionDetail() {
  const id = useBridge((s) => s.selectedId);
  const d = useBridge((s) => s.decisions.find((x) => x.id === id));
  const resolve = useBridge((s) => s.resolve);
  const selectDecision = useBridge((s) => s.selectDecision);
  const [choice, setChoice] = useState<string | null>(null);
  const [note, setNote] = useState("");

  if (!d) return null;
  const close = () => {
    selectDecision(null);
    setChoice(null);
    setNote("");
  };

  const act = (action: "unblocked" | "completed") => {
    void resolve(d, action, note.trim() || undefined, choice ?? undefined);
    close();
  };

  return (
    <>
      <div className="panel-backdrop" onClick={close} />
      <aside className="detail-panel">
        <header className="detail-head">
          <div className="ask-chips">
            <KindBadge kind={d.kind} />
            <UrgencyBadge urgency={d.urgency} />
            <BoardChip board={d.board} />
            <WhyLine deadline={d.deadline_ts} />
          </div>
          <button className="icon-btn" onClick={close} aria-label="Close">
            ✕
          </button>
        </header>

        <h2 className="detail-question">{d.title}</h2>
        {d.reason && <p className="ask-reason">{d.reason}</p>}

        {d.options?.length ? (
          <div className="option-cards">
            {d.options.map((o) => (
              <button
                key={o.id}
                className={`option-card ${choice === o.id ? "selected" : ""}`}
                onClick={() => setChoice(o.id)}
              >
                <span className="option-label">{o.label}</span>
                {o.hint && <span className="option-hint">{o.hint}</span>}
              </button>
            ))}
          </div>
        ) : null}

        {choice ? (
          <>
            <div className="detail-block">
              <label>Note (travels with your answer)</label>
              <textarea
                rows={2}
                value={note}
                placeholder="Context, constraint, nuance…"
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            <button className="primary-btn" onClick={() => act("unblocked")}>
              Answer: {d.options?.find((o) => o.id === choice)?.label}
            </button>
          </>
        ) : (
          <>
            <div className="detail-block">
              <label>Note (travels with your answer)</label>
              <textarea
                rows={2}
                value={note}
                placeholder="Context, choice, constraint…"
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            <button className="primary-btn" onClick={() => act("unblocked")}>
              Unblock — work resumes
            </button>
            <button className="secondary-btn" onClick={() => act("completed")}>
              Mark done
            </button>
          </>
        )}

        <button
          className="audit-toggle"
          onClick={(e) => e.currentTarget.nextElementSibling?.classList.toggle("hidden")}
        >
          ▸ Details
        </button>
        <dl className="audit hidden">
          <dt>id</dt>
          <dd>{d.id}</dd>
          <dt>asker</dt>
          <dd>{d.asker ?? "—"}</dd>
          <dt>task</dt>
          <dd>{d.task_id ?? "—"}</dd>
          <dt>opened</dt>
          <dd>{rel(d.opened_ts)}</dd>
          <dt>updated</dt>
          <dd>{rel(d.updated_ts)}</dd>
        </dl>
      </aside>
    </>
  );
}
