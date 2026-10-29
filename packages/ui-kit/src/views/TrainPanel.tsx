import { useEffect, useState } from "react";
import { kbApi, type KbTrainLane } from "../server/kb";
import { Chip, type ChipTone } from "./index-kit";

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

/** Left-edge lock dot (same visual grammar as Top's status dot): green =
 *  a machine is ON the lane — lock held by a live holder, or a merge-capable
 *  gateway actively ticking it unlocked; amber = lock lapsing; red = zombie
 *  holder; grey = nobody is on the lane. Mouseover names the machine and
 *  distinguishes locked from ticking-unlocked — the "which machine is online
 *  and on this lane" answer lives in the tooltip. */
function lockDot(l: KbTrainLane, now: number): { sd: "live" | "lapse" | "dead" | "free"; title: string } {
  if (l.lease?.holder) {
    const base = `CAS lane lease held by ${l.lease.holder} — heartbeat ${age(l.lease.heartbeat_ts, now)} ago, expires in ${age(l.lease.expires_ts, now)}`;
    const t = lockTone(l, now);
    if (t === "ok") return { sd: "live", title: `locked · ${base}` };
    if (t === "warn") return { sd: "lapse", title: `lock lapsing · ${base}` };
    return { sd: "dead", title: `lock zombie (heartbeat past TTL) · ${base}` };
  }
  if (l.capable?.ready)
    return {
      sd: "live",
      title: `ticking, unlocked — merge-capable gateway ${l.capable.holder} ticked this lane ${age(l.capable.at, now)} ago and acquires the lock on its next tick (every ~45s) once work is queued`,
    };
  return { sd: "free", title: "no machine on this lane — no merge-capable gateway has ticked inside the 15-minute window; merges wait until one runs (start a gateway / bridge train)" };
}

/** The status column: what the lane is doing right now, one pill. */
function laneStatus(l: KbTrainLane, now: number): { tone: ChipTone; label: string; title: string } {
  if (l.stop)
    return {
      tone: "err",
      label: "⛔ stop-the-line",
      title: `stop-the-line: ${l.stop.reason ?? ""} (sha ${String(l.stop.sha ?? "").slice(0, 9)}, since ${age(l.stop.at, now)} ago)`,
    };
  if (l.currently)
    return {
      tone: l.currently.phase === "stopped" ? "err" : "live",
      label: l.currently.phase ?? "merging",
      title: `in-flight: ${JSON.stringify(l.currently)}`,
    };
  if (l.lease?.holder) {
    const t = lockTone(l, now);
    return {
      tone: t === "ok" ? "scope" : t === "warn" || t === "err" ? "warn" : "muted",
      label: "lock held · idle",
      title: `CAS lane lease held by ${l.lease.holder} — heartbeat ${age(l.lease.heartbeat_ts, now)} ago, expires in ${age(l.lease.expires_ts, now)}; between merge phases`,
    };
  }
  if (l.capable?.ready)
    return {
      tone: "ok",
      label: "train ready",
      title: `train ready — merge-capable gateway ${l.capable.holder} ticked this lane ${age(l.capable.at, now)} ago; it acquires the lock on its next tick (every ~45s) once work is queued`,
    };
  return {
    tone: "muted",
    label: "no gateway",
    title: "no merge-capable gateway has ticked this lane inside the 15-minute window — merges wait until one runs (start a gateway / bridge train)",
  };
}

const REFRESH_MS = 30_000;

/** Merge-train table (Ray, 2026-10-29): rides the same ktable primitive as
 *  Top — lock dot · line · status · activity, columns justified identically.
 *  Dot = CAS lock state (hover names the holding machine + liveness); line =
 *  repo@base, click opens the lane card; status = one pill (stop-the-line /
 *  in-flight phase / lock held / ready / no gateway); activity = throughput,
 *  last ledger event, derived queue (clickable card ids). Data: GET
 *  /api/kb/train (the DO's train.status snapshot — lease is executor-fed,
 *  queue is hub-computed). Polls every 30s (the tick is 45s); errors surface
 *  in-panel, never silent. */
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
      {(lanes ?? []).length > 0 && (
        <div className="ktable-head train-head-cols">
          <span title="machine-on-lane — green a machine is on it (lock held by a live holder, or a merge-capable gateway ticking it unlocked) · amber lock lapsing · red zombie · grey nobody; hover names the machine">lock</span>
          <span>line</span>
          <span>status</span>
          <span title="merge throughput · last ledger event · derived queue">activity</span>
        </div>
      )}
      {(lanes ?? []).map((l) => {
        const dot = lockDot(l, now);
        const st = laneStatus(l, now);
        const repo = l.lane.split("@")[0];
        return (
          <div key={l.lane} className={`ktable-row train-row ${hasSignal(l) ? "" : "train-row-idle"}`}>
            <span className="trainc-dot">
              <span className={`train-dot td-${dot.sd}`} title={dot.title} />
            </span>
            <span
              className={`trainc-line ${l.card && openTask ? "trainc-open" : ""}`}
              title={`${l.lane} — lane card ${l.card}${l.reason ? ` · ${l.reason}` : ""}${l.card && openTask ? " — click to open" : ""}`}
              onClick={() => l.card && openTask?.(l.card)}
            >
              {l.lane}
            </span>
            <span className="trainc-status">
              <Chip pill tone={st.tone} title={st.title}>{st.label}</Chip>
              {l.currently?.pr ? (
                <a className="train-pr" href={`https://github.com/${repo}/pull/${l.currently.pr}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>#{l.currently.pr}</a>
              ) : null}
              {l.currently?.merged_at ? (
                <span className="train-dur top-num" title={`in this phase since ${new Date(l.currently.merged_at).toLocaleTimeString()}`}>
                  {age(l.currently.merged_at, now)}
                </span>
              ) : null}
            </span>
            <span className="trainc-info">
              {hasSignal(l) ? (
                <>
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
                </>
              ) : (
                <span className="muted-note">{l.reason ?? "idle"}</span>
              )}
            </span>
          </div>
        );
      })}
      {!error && lanes && lanes.length > 0 && lanes.every((l) => !hasSignal(l)) && (
        <div className="muted-note train-all-idle">all lanes idle — queues empty; a ready lane names the machine that takes the next head</div>
      )}
    </div>
  );
}
