import { useEffect, useMemo, useState } from "react";
import type { KbReportBucket, KbReports } from "../server/kb";
import { kbApi } from "../server/kb";
import { useKb } from "../server/kbStore";

/**
 * Reports (BR#5126) — the high-res sibling of the dashboard throughput cell:
 * tasks/h over time + PR merge throughput (train_events) on one shared bucket
 * grid, drawn as full-width SVG charts with gridlines, axes and hover detail.
 * Refetches when the ledger ticks (done/merge events are ledger mutations).
 */

const BUCKETS = ["hour", "day", "week"] as const;
type Bucket = (typeof BUCKETS)[number];

const RANGES: Record<Bucket, string[]> = {
  hour: ["1d", "3d", "7d", "14d", "30d"],
  day: ["7d", "30d", "90d", "365d"],
  week: ["28d", "90d", "365d"],
};

// chart geometry (viewBox units; the svg scales to container width)
const COL = 10;
const H = 170;
const PAD = { l: 38, r: 10, t: 10, b: 24 };

function fmtTick(t: number, bucket: Bucket) {
  const d = new Date(t);
  if (bucket === "hour") {
    // label midnights as dates, the rest as clock times
    if (d.getHours() === 0) return d.toLocaleDateString([], { month: "short", day: "numeric" });
    return `${String(d.getHours()).padStart(2, "0")}:00`;
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function fmtFull(t: number) {
  return new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** One full-width chart: per-bucket bars (+optional bounce overlay) with a
 *  cumulative line, y gridlines with value labels, and x time ticks. */
function ReportChart({
  buckets,
  bucket,
  label,
  showBounces,
  detail,
}: {
  buckets: KbReportBucket[];
  bucket: Bucket;
  label: string;
  showBounces: boolean;
  detail: (b: KbReportBucket) => string;
}) {
  const n = buckets.length;
  const W = PAD.l + n * COL + PAD.r;
  const max = Math.max(1, ...buckets.map((b) => Math.max(b.n, showBounces ? (b.bounced ?? 0) : 0)));
  const maxCum = n ? Math.max(1, buckets[n - 1].cumulative) : 1;
  const y = (v: number) => PAD.t + H - (v / max) * (H - 4);
  const cumY = (v: number) => PAD.t + H - (v / maxCum) * (H - 4);
  const tickEvery = Math.max(1, Math.ceil(n / 9));

  return (
    <div className="rep-chart">
      <div className="row" style={{ alignItems: "center", gap: 8 }}>
        <span className="rep-title">{label}</span>
        <span className="muted-note">bars: per {bucket} · line: cumulative</span>
      </div>
      <svg viewBox={`0 0 ${W} ${PAD.t + H + PAD.b}`} className="rep-svg" role="img" aria-label={label}>
        {/* y gridlines + value labels (max, 3/4, 1/2, 1/4, 0) */}
        {[1, 0.75, 0.5, 0.25, 0].map((f) => {
          const v = Math.round(max * f);
          const yy = y(v);
          return (
            <g key={f}>
              <line x1={PAD.l} x2={W - PAD.r} y1={yy} y2={yy} className="rep-grid-line" />
              <text x={PAD.l - 5} y={yy + 3} textAnchor="end" className="rep-axis">{v}</text>
            </g>
          );
        })}
        {/* bounce overlay first — merges render on top */}
        {showBounces &&
          buckets.map((b, i) => {
            const bounced = b.bounced ?? 0;
            if (!bounced) return null;
            const bh = Math.max(1.5, ((bounced / max) * (H - 4)) | 0);
            return (
              <rect key={`bo${i}`} x={PAD.l + i * COL + 1} y={PAD.t + H - bh} width={COL - 2} height={bh}
                className="rep-bar bounce">
                <title>{`${fmtFull(b.t)} — ${bounced} bounced`}</title>
              </rect>
            );
          })}
        {buckets.map((b, i) => (
          <rect key={i} x={PAD.l + i * COL + 1} y={b.n ? y(b.n) : PAD.t + H - 0.5}
            width={COL - 2} height={b.n ? Math.max(1.5, PAD.t + H - y(b.n)) : 0.5}
            className={b.n ? "rep-bar" : "rep-bar zero"}>
            <title>{detail(b)}</title>
          </rect>
        ))}
        {n > 0 && (
          <polyline className="rep-cum"
            points={buckets.map((b, i) => `${PAD.l + i * COL + COL / 2},${cumY(b.cumulative)}`).join(" ")} />
        )}
        {/* x ticks */}
        {buckets.map((b, i) =>
          i % tickEvery === 0 ? (
            <text key={`tx${i}`} x={PAD.l + i * COL + (i === 0 ? 2 : COL / 2)}
              y={PAD.t + H + 14} textAnchor={i === 0 ? "start" : "middle"} className="rep-axis">
              {fmtTick(b.t, bucket)}
            </text>
          ) : null,
        )}
        {/* full-height hover hit areas (transparent fill stays hoverable) */}
        {buckets.map((b, i) => (
          <rect key={`h${i}`} x={PAD.l + i * COL} y={PAD.t} width={COL} height={H} fill="transparent">
            <title>{detail(b)}</title>
          </rect>
        ))}
      </svg>
    </div>
  );
}

export function ReportsView() {
  const evSeq = useKb((s) => s.events[0]?.seq ?? 0);
  const [bucket, setBucket] = useState<Bucket>("hour");
  const [range, setRange] = useState("3d");
  const [rep, setRep] = useState<KbReports | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    setErr(null);
    kbApi.reports({ bucket, range })
      .then((r) => { if (on) setRep(r); })
      .catch((e) => { if (on) { setRep(null); setErr(String((e as Error).message ?? e)); } });
    return () => { on = false; };
  }, [bucket, range, evSeq]);

  const rangeDays = useMemo(() => parseInt(/^(\d+)d?$/.exec(range)?.[1] ?? "3", 10), [range]);
  const rangeHours = Math.max(1, rangeDays * 24);
  const taskRate = rep ? rep.tasks.total / rangeHours : 0;
  const prRate = rep ? rep.prs.total / Math.max(1, rangeDays) : 0;
  const bounceRate = rep && rep.prs.total + rep.prs.bounced_total > 0
    ? Math.round((rep.prs.bounced_total / (rep.prs.total + rep.prs.bounced_total)) * 100)
    : 0;

  return (
    <div className="reports">
      <div className="rep-head">
        <span className="fc fc-done">REPORTS</span>
        <span className="tp-toggle" title="bucket size">
          {BUCKETS.map((b) => (
            <button key={b} className={bucket === b ? "tp-on" : ""} onClick={() => setBucket(b)}>{b}</button>
          ))}
        </span>
        <span className="tp-toggle" title="look-back window">
          {RANGES[bucket].map((r) => (
            <button key={r} className={range === r ? "tp-on" : ""} onClick={() => setRange(r)}>{r}</button>
          ))}
        </span>
        {err && <span className="rep-error">{err}</span>}
      </div>

      {rep && (
        <div className="rep-stats">
          <span className="rep-stat"><b>{rep.tasks.total}</b> tasks closed · avg <b>{taskRate.toFixed(1)}</b> task/h</span>
          <span className="rep-stat"><b>{rep.prs.total}</b> PRs merged · avg <b>{prRate.toFixed(1)}</b> PR/day{rep.prs.bounced_total > 0 && <> · <b>{rep.prs.bounced_total}</b> bounces ({bounceRate}%)</>}</span>
          <span className="rep-stat muted-note">{fmtFull(rep.from_ts)} → {fmtFull(rep.to_ts)}</span>
        </div>
      )}

      {rep && rep.tasks.buckets.length > 0 && (
        <ReportChart
          buckets={rep.tasks.buckets}
          bucket={bucket}
          label="TASKS CLOSED"
          showBounces={false}
          detail={(b) => `${fmtFull(b.t)} — ${b.n} closed (cumulative ${b.cumulative})`}
        />
      )}
      {rep && rep.prs.buckets.length > 0 && (
        <ReportChart
          buckets={rep.prs.buckets}
          bucket={bucket}
          label="PR THROUGHPUT"
          showBounces
          detail={(b) => `${fmtFull(b.t)} — ${b.n} merged${b.bounced ? `, ${b.bounced} bounced` : ""} (cumulative ${b.cumulative})`}
        />
      )}
      {!rep && !err && <span className="muted-note">loading reports…</span>}
    </div>
  );
}
