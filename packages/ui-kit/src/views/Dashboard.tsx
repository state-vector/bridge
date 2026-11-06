import { useEffect, useMemo, useState } from "react";
import type { KbArtefact, KbThroughput } from "../server/kb";
import { kbApi } from "../server/kb";

const SENTIMENTS = ["going_well", "converging", "neutral", "diverging", "struggling"] as const;
const SENTIMENT_LABELS = { going_well: "Going well", converging: "Converging", neutral: "Neutral", diverging: "Diverging", struggling: "Struggling" };
type ActivityEvent = { ts: number; actor?: string };

/** Fresh bins on every calculation: rerendering must never accumulate counts
 * into a memoised array, or count old/future events as current activity. */
export function activityBuckets(events: ActivityEvent[], now: number) {
  const buckets = Array.from({ length: 60 }, (_, i) => ({ t: now - (59 - i) * 60_000, n: 0 }));
  for (const event of events) {
    const age = now - event.ts;
    if (age < 0 || age >= 3_600_000) continue;
    buckets[59 - Math.floor(age / 60_000)].n++;
  }
  return buckets;
}

/** One scale per chart. Axis labels stay in HTML so resizing the SVG does not
 * stretch text; there is no unrelated cumulative series on a second scale. */
export function BarTrend({ buckets, label, start, end, unit }: {
  buckets: { t: number; n: number }[]; label: string; start: string; end: string; unit: string;
}) {
  const peak = Math.max(1, ...buckets.map((b) => b.n));
  const step = 320 / Math.max(1, buckets.length);
  return <div className="dash-trend">
    <div className="dash-chart-scale"><span>{unit}</span><span>peak {Math.max(0, ...buckets.map((b) => b.n))}</span></div>
    <svg viewBox="0 0 320 64" className="dash-chart" preserveAspectRatio="none" role="img" aria-label={label}>
      <path d="M0 8H320 M0 34H320 M0 60H320" className="dash-chart-grid" />
      {buckets.map((b, i) => <rect key={b.t} x={i * step + 1} y={60 - b.n / peak * 52}
        width={Math.max(1, step - 2)} height={b.n / peak * 52} className="chart-bar hot">
        <title>{`${new Date(b.t).toISOString().slice(0, 16).replace("T", " ")} UTC · ${b.n} ${unit}`}</title>
      </rect>)}
    </svg>
    <div className="dash-chart-axis"><span>{start}</span><span>{end}</span></div>
  </div>;
}

const dateLabel = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

export function ThroughputSummary({ tp, bucket, onBucket, failed = false }: {
  tp: KbThroughput | null; bucket: "day" | "week"; onBucket: (bucket: "day" | "week") => void; failed?: boolean;
}) {
  const bins = tp?.buckets ?? [];
  return <section className="dash-cell" aria-label="Completed tasks">
    <div className="dash-cell-head"><h3>Completed tasks</h3><span className="tp-toggle" aria-label="Completion chart interval">
      {(["day", "week"] as const).map((b) => <button key={b} aria-pressed={bucket === b} className={bucket === b ? "tp-on" : ""} onClick={() => onBucket(b)}>{b}</button>)}
    </span></div>
    <div className="dash-metric">{tp ? tp.total.toLocaleString() : "—"}<span>last {tp?.range_days ?? 30} days</span></div>
    {bins.length ? <BarTrend buckets={bins} label={`Tasks completed per ${bucket} over the last ${tp?.range_days} days`}
      start={dateLabel(bins[0].t)} end={dateLabel(bins[bins.length - 1].t)} unit={`tasks/${bucket}`} />
      : <div className="dash-empty">{tp ? "No completed tasks in this period" : failed ? "Completion history unavailable" : "Loading completion history…"}</div>}
    {failed && tp && <span className="dash-caption" role="status">Last result · refresh unavailable</span>}
  </section>;
}

function ThroughputCell() {
  const [bucket, setBucket] = useState<"day" | "week">("day");
  const [tp, setTp] = useState<KbThroughput | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let on = true;
    setTp(null);
    setFailed(false);
    const load = () => kbApi.throughput({ bucket, range: "30d" })
      .then((r) => { if (on) { setTp(r); setFailed(false); } })
      .catch(() => { if (on) setFailed(true); });
    void load();
    const poll = setInterval(load, 30_000);
    return () => { on = false; clearInterval(poll); };
  }, [bucket]);
  return <ThroughputSummary tp={tp} bucket={bucket} onBucket={setBucket} failed={failed} />;
}

export function DashboardSummary({ tasks, events, children }: { tasks: KbArtefact[]; events: ActivityEvent[]; children?: React.ReactNode }) {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const buckets = useMemo(() => activityBuckets(events, now), [events, now]);
  const recent = events.filter((e) => e.ts <= now && now - e.ts < 3_600_000);
  const last5 = recent.filter((e) => now - e.ts < 300_000).length;
  const sources = new Set(recent.filter((e) => now - e.ts < 600_000 && e.actor).map((e) => e.actor));
  const openTasks = tasks.filter((t) => ["todo", "in_progress", "in_review", "blocked"].includes(t.status));
  const counts = new Map<string, number>();
  for (const task of openTasks) {
    const report = task.meta?.last_progress as { sentiment?: unknown } | undefined;
    const sentiment = SENTIMENTS.find((s) => s === report?.sentiment);
    if (sentiment) counts.set(sentiment, (counts.get(sentiment) ?? 0) + 1);
  }
  const reported = [...counts.values()].reduce((a, b) => a + b, 0);
  const dominant = SENTIMENTS.slice().sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))[0];
  return <div className="dashboard" aria-label="Fleet overview">
    <section className="dash-cell" aria-label="Recent activity">
      <div className="dash-cell-head"><h3>Activity</h3><span className="muted-note">last hour</span></div>
      <div className="dash-metric">{recent.length.toLocaleString()}<span>observed events</span></div>
      <BarTrend buckets={buckets} label="Observed events per minute over the last hour" start="60 min ago" end="Now" unit="events/min" />
      <p className="dash-caption">{last5} in the last 5 min · {sources.size} active sources</p>
    </section>
    <section className="dash-cell" aria-label="Work outlook">
      <div className="dash-cell-head"><h3>Work outlook</h3><span className="muted-note">reported sentiment</span></div>
      <div className="dash-metric dash-metric-word">{reported ? SENTIMENT_LABELS[dominant] : "No reports"}</div>
      <div className="sentiment-bar" role="img" aria-label={reported ? SENTIMENTS.filter((s) => counts.has(s)).map((s) => `${SENTIMENT_LABELS[s]}: ${counts.get(s)}`).join(", ") : "No sentiment reported"}>
        {SENTIMENTS.map((s) => counts.has(s) && <span key={s} className={`sb-seg sb-${s}`} style={{ width: `${counts.get(s)! / reported * 100}%` }} />)}
      </div>
      <div className="dash-legend">{SENTIMENTS.filter((s) => counts.has(s)).map((s) => <span key={s}><i className={`sb-${s}`} />{SENTIMENT_LABELS[s]} {counts.get(s)}</span>)}</div>
      <p className="dash-caption">{reported} of {openTasks.length} open tasks have reported sentiment</p>
    </section>
    <section className="dash-cell" aria-label="Board task counts">
      <div className="dash-cell-head"><h3>Board tasks</h3><span className="muted-note">current snapshot</span></div>
      <dl className="dash-task-counts">{([['in_progress', 'In progress'], ['in_review', 'In review'], ['blocked', 'Blocked'], ['todo', 'To do'], ['done', 'Done']] as const).map(([status, label]) => <div key={status}>
        <dt>{label}</dt><dd className={status === 'blocked' ? 'bad' : ''}>{tasks.filter((t) => t.status === status).length}</dd>
      </div>)}</dl>
      <p className="dash-caption">Counts shown for tasks loaded on this board</p>
    </section>
    {children ?? <ThroughputCell />}
  </div>;
}
