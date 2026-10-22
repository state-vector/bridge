import { useMemo } from "react";
import type { KbArtefact } from "../server/kb";

const SENTIMENTS = ["going_well", "converging", "neutral", "diverging", "struggling"] as const;


/** Top-of-board dashboard: activity chart + sentiment distribution + flow counters. */
export function DashboardSummary({ tasks, events }: { tasks: KbArtefact[]; events: any[] }) {
  const inFlight = tasks.filter((t) => ["todo", "in_progress", "in_review", "blocked"].includes(t.status));

  const counts: Record<string, number> = {};
  for (const t of inFlight) {
    const s = (t.meta as any)?.last_progress?.sentiment;
    if (s) counts[s] = (counts[s] ?? 0) + 1;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const dominant = SENTIMENTS.slice().sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0))[0];

  // events/min, last 60 min
  const buckets = useMemo(() => {
    const now = Date.now();
    return Array.from({ length: 60 }, (_, i) => ({ t: now - (59 - i) * 60_000, n: 0 }));
  }, [events]);
  for (const e of events) {
    const idx = 59 - Math.floor((Date.now() - e.ts) / 60_000);
    if (idx >= 0 && idx < 60) buckets[idx].n++;
  }
  const max = Math.max(1, ...buckets.map((b) => b.n));
  const last5 = events.filter((e) => Date.now() - e.ts < 300_000).length;

  // live agents (signal < 10 min)
  const agents = new Set(events.filter((e) => Date.now() - e.ts < 600_000 && e.actor).map((e) => e.actor));

  return (
    <div className="dashboard">
      <div className="dash-cell chart-box" title="events per minute, last hour">
        <svg viewBox={`0 0 ${60 * 4} 28`} className="chart-svg" preserveAspectRatio="none">
          {buckets.map((b, i) => (
            <rect key={i} x={i * 4} y={28 - (b.n / max) * 26} width={3} height={Math.max(b.n ? 2 : 0.5, (b.n / max) * 26)}
              className={b.n ? "chart-bar hot" : "chart-bar"} />
          ))}
        </svg>
        <span className="muted-note">{events.length} events/hr · {last5} last 5m · {agents.size} agents active</span>
      </div>
      <div className="dash-cell" title="aggregate sentiment, in-flight tasks">
        <div className="sentiment-bar">
          {total === 0 && <div className="sb-seg sb-neutral" style={{ width: "100%" }} />}
          {SENTIMENTS.map((s) => counts[s] ? (
            <div key={s} className={`sb-seg sb-${s}`} style={{ width: `${(counts[s] / total) * 100}%` }} title={`${s}: ${counts[s]}`} />
          ) : null)}
        </div>
        <span className="muted-note">
          {total} in flight{total > 0 && <> · leaning <b className="sentiment-word">{dominant.replace("_", " ")}</b></>}
          {counts.struggling ? <span className="st-err"> · {counts.struggling} struggling</span> : ""}
        </span>
      </div>
      <div className="dash-cell" title="task flow">
        <div className="flow-counts">
          {["todo", "in_progress", "in_review", "blocked", "done"].map((st) => (
            <span key={st} className={`fc fc-${st}`}>{tasks.filter((t) => t.status === st).length} {st.replace("_", " ")}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
