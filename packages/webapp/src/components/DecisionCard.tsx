import type { Decision } from "@flows/specs";
import { useBridge } from "../lib/store";
import { rel } from "../lib/views";
import { BoardChip, KindBadge, UrgencyBadge } from "./ui";

export function WhyLine({ deadline }: { deadline?: number | null }) {
  if (!deadline) return null;
  const left = deadline - Date.now();
  return (
    <span className="why-line">
      {left < 0 ? "overdue" : left < 3_600_000 ? `due in ${Math.max(1, Math.round(left / 60_000))}m` : `due ${rel(deadline).replace(" ago", "").replace("in ", "")}`}
    </span>
  );
}

export function DecisionCard({ d }: { d: Decision }) {
  const resolve = useBridge((s) => s.resolve);
  const selectDecision = useBridge((s) => s.selectDecision);
  const token = useBridge((s) => s.token);

  return (
    <article className={`ask-card ${d.urgency === "time-sensitive" || d.kind === "needs_input" ? "ask-urgent" : "ask-diag"}`}>
      <div className="ask-chips">
        <KindBadge kind={d.kind} />
        <UrgencyBadge urgency={d.urgency} />
        <BoardChip board={d.board} />
        <span className="why-line">open {rel(d.opened_ts)}</span>
        <WhyLine deadline={d.deadline_ts} />
      </div>
      <h3 className="ask-question" onClick={() => selectDecision(d.id)}>
        {d.title}
      </h3>
      {d.reason && <p className="ask-reason">{d.reason}</p>}
      <div className="ask-actions">
        {token ? (
          d.options?.length ? (
            d.options.map((o) => (
              <button key={o.id} className="opt-btn" title={o.hint ?? undefined} onClick={() => void resolve(d, "unblocked", undefined, o.id)}>
                {o.label}
              </button>
            ))
          ) : (
            <>
              <button className="opt-btn" onClick={() => void resolve(d, "unblocked")}>
                Unblock
              </button>
              <button className="opt-btn" onClick={() => void resolve(d, "completed")}>
                Done
              </button>
            </>
          )
        ) : (
          <span className="why-line">set ingest token (⚙) to answer</span>
        )}
        <button className="opt-btn opt-ghost" onClick={() => selectDecision(d.id)}>
          Open →
        </button>
      </div>
    </article>
  );
}
