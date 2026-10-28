import { useEffect, useState } from "react";
import { kbApi, type KbTrainLane } from "../server/kb";
import { Chip } from "./index-kit";

/** Ticking clock — re-renders every second so lock ages stay live. */
function useClock() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
}

function age(ts: number | undefined, now: number): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return `${m}m${r ? ` ${String(r).padStart(2, "0")}s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** CAS-lock liveness: the lease TTL is 5 minutes — a heartbeat younger than
 *  2 ticks (~90s) is a live holder, anything older is lapsing/zombie. */
function lockTone(lane: KbTrainLane, now: number): "ok" | "warn" | "err" | "muted" {
  if (!lane.lease?.heartbeat_ts) return "muted";
  const s = (now - lane.lease.heartbeat_ts) / 1000;
  if (s > 300) return "err";
  if (s > 90) return "warn";
  return "ok";
}

const REFRESH_MS = 30_000;

/** Merge-train strip (Ray, 2026-10-29): one row per lane at the very top of
 *  Top — which machine holds the CAS lane lease (holder + heartbeat age),
 *  what it is doing right now (in-flight merge phase), and the derived queue
 *  (queued card ids, click to open). Data: GET /api/kb/train (the DO's
 *  train.status snapshot — lease is executor-fed, queue is hub-computed).
 *  Polls every 30s (the tick is 45s); errors surface in-panel, never silent. */
export function TrainPanel({ openTask }: { openTask?: (id: string) => void }) {
  useClock();
  const [lanes, setLanes] = useState<KbTrainLane[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const r = await kbApi.train();
        if (!dead) { setLanes(r.lanes ?? []); setError(null); }
      } catch (e) {
        if (!dead) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const t = setInterval(load, REFRESH_MS);
    return () => { dead = true; clearInterval(t); };
  }, []);

  const now = Date.now();
  const hasSignal = (l: KbTrainLane) => l.lease || l.queue.length > 0 || l.stop || l.currently;

  return (
    <div className="train-panel">
      <div className="train-head">
        <h2>merge trains</h2>
        <span className="muted-note">per-lane CAS lock + derived queue · 45s tick, 30s poll</span>
      </div>
      {error && <div className="train-lane train-lane-err" title={error}>⚠ train status unavailable — {error.slice(0, 120)}</div>}
      {!error && lanes?.length === 0 && (
        <div className="train-lane train-lane-idle">no merge-train lanes configured — a lane appears when a card enters the train</div>
      )}
      {(lanes ?? []).map((l) => (
        <div key={l.lane} className={`train-lane ${hasSignal(l) ? "" : "train-lane-idle"}`}>
          <span className="train-lane-name" title={`${l.lane} — lane card ${l.card}`}>{l.lane}</span>
          {l.lease?.holder ? (
            <Chip
              pill
              tone={lockTone(l, now)}
              title={`CAS lane lease held by ${l.lease.holder} — heartbeat ${age(l.lease.heartbeat_ts, now)} ago, expires in ${age(l.lease.expires_ts, now)}`}
            >
              lock {l.lease.holder} · hb {age(l.lease.heartbeat_ts, now)}
            </Chip>
          ) : (
            <Chip pill tone="muted" title="no gateway holds this lane's CAS lease — a tick will acquire it">lock free</Chip>
          )}
          {l.currently && (
            <span className="train-currently" title={`in-flight: ${JSON.stringify(l.currently)}`}>
              <Chip pill tone={l.currently.phase === "stopped" ? "err" : "live"}>{l.currently.phase ?? "merging"}</Chip>
              {l.currently.pr ? <a className="train-pr" href={`https://github.com/${l.lane.split("@")[0]}/pull/${l.currently.pr}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>#{l.currently.pr}</a> : null}
              {l.currently.merged_at ? (
                <span className="train-dur top-num" title={`in this phase since ${new Date(l.currently.merged_at).toLocaleTimeString()}`}>
                  {age(l.currently.merged_at, now)}
                </span>
              ) : null}
            </span>
          )}
          {l.activity && (
            <span className="train-tp top-num" title="merge throughput over trailing windows (train_events ledger) — last event: what the executor did most recently, and from which machine">
              <span className="train-tp-rate">▸ {l.activity.merged_1h}/h · {l.activity.merged_24h}/24h</span>
              {l.activity.last_event && (
                <span className="train-last-event" title={`${l.activity.last_event.kind} · ${l.activity.last_event.gateway ?? "?"} · task ${l.activity.last_event.task_id ?? "—"}`}>
                  last: {l.activity.last_event.kind}
                  {l.activity.last_event.pr ? ` #${l.activity.last_event.pr}` : ""} {age(l.activity.last_event.ts, now)} ago
                </span>
              )}
            </span>
          )}
          <span className="train-queue" title="derived queue (hub-computed, oldest first) — click a card to open it">
            <span className="train-queue-label top-num">depth {l.queue.length}{l.queue.length > 0 ? ` · head ${l.queue[0].id}` : ""}</span>
            {l.queue.map((q) => (
                <Chip
                  key={q.id}
                  tone={q.priority === "critical" ? "urgent" : "scope"}
                  className="train-queue-card"
                  onClick={() => openTask?.(q.id)}
                  title={`${q.id} — ${q.priority === "critical" ? "boosted (priority 0)" : "normal priority"}`}
                >
                  {q.id}
                </Chip>
              ))}
          </span>
          {l.stop && (
            <Chip pill tone="err" title={`stop-the-line: ${l.stop.reason ?? ""} (sha ${String(l.stop.sha ?? "").slice(0, 9)}, since ${age(l.stop.at, now)} ago)`}>
              ⛔ stop-the-line
            </Chip>
          )}
          {!hasSignal(l) && l.reason && <span className="muted-note">{l.reason}</span>}
        </div>
      ))}
      {!error && lanes && lanes.length > 0 && lanes.every((l) => !hasSignal(l)) && (
        <div className="muted-note train-all-idle">all lanes idle — no queued PRs, no lease held</div>
      )}
    </div>
  );
}
