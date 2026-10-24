import { useEffect, useMemo, useState } from "react";
import type { KbArtefact, KbThroughput } from "../server/kb";
import { kbApi } from "../server/kb";
import { useKb } from "../server/kbStore";

const SENTIMENTS = ["going_well", "converging", "neutral", "diverging", "struggling"] as const;

/** Task-done throughput (BR#2937): bars per bucket + cumulative line, from
 *  /api/kb/metrics/throughput. Refetches when the ledger ticks (a done
 *  transition is a ledger mutation) and on the day/week toggle. */
function ThroughputCell() {
  const evSeq = useKb((s) => s.events[0]?.seq ?? 0);
  const [bucket, setBucket] = useState<"day" | "week">("day");
  const [tp, setTp] = useState<KbThroughput | null>(null);

  useEffect(() => {
    let on = true;
    kbApi.throughput({ bucket, range: "30d" })
      .then((r) => { if (on) setTp(r); })
      .catch(() => { if (on) setTp(null); });
    return () => { on = false; };
  }, [bucket, evSeq]);

  const max = useMemo(
    () => Math.max(1, ...((tp?.buckets ?? []).map((b) => b.n))),
    [tp],
  );
  const maxCum = tp?.buckets?.length ? Math.max(1, tp.buckets[tp.buckets.length - 1].cumulative) : 1;

  return (
    <div className="dash-cell" title="tasks completed (verified) over time — done transitions per bucket">
      <div className="row" style={{ alignItems: "center", gap: 6 }}>
        <span className="fc fc-done" style={{ fontSize: 10.5 }}>THROUGHPUT</span>
        <span className="tp-toggle">
          {(["day", "week"] as const).map((b) => (
            <button key={b} className={bucket === b ? "tp-on" : ""} onClick={() => setBucket(b)}>{b}</button>
          ))}
        </span>
      </div>
      {tp && tp.buckets.length > 0 ? (
        <svg viewBox={`0 0 ${tp.buckets.length * 4} 28`} className="chart-svg" preserveAspectRatio="none">
          {tp.buckets.map((b, i) => (
            <rect key={i} x={i * 4} y={28 - (b.n / max) * 26} width={3}
              height={Math.max(b.n ? 2 : 0.5, (b.n / max) * 26)}
              className={b.n ? "chart-bar hot" : "chart-bar"}>
              <title>{`${new Date(b.t).toISOString().slice(0, 10)} — ${b.n} done (cumulative ${b.cumulative})`}</title>
            </rect>
          ))}
          <polyline className="tp-line"
            points={tp.buckets.map((b, i) => `${i * 4 + 1.5},${28 - (b.cumulative / maxCum) * 26}`).join(" ")} />
        </svg>
      ) : (
        <svg className="chart-svg" preserveAspectRatio="none" />
      )}
      <span className="muted-note">
        {tp ? `${tp.total} done · last ${tp.range_days}d${tp.total ? ` · peak ${max}/${tp.bucket}` : " — none yet"}` : "throughput unavailable"}
      </span>
    </div>
  );
}


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
      <ThroughputCell />
    </div>
  );
}
