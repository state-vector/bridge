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

/** The status column: what the lane is doing right now, one pill — in plain
 *  words (BR#5114 round 2, Ray: "remove jargon — make it clear"). The full
 *  sentence always rides the NOW column beneath the pill; tooltips carry
 *  the machine detail for those who want it. */
function laneStatus(l: KbTrainLane, now: number): { tone: ChipTone; label: string; title: string } {
  const reason = l.reason ?? "";
  if (l.stop)
    return {
      tone: "err",
      label: "⛔ line stopped",
      title: `stopped: ${l.stop.reason ?? ""}${l.stop.culprit_task ? ` — culprit ${l.stop.culprit_task}` : ""} (sha ${String(l.stop.sha ?? "").slice(0, 9)}, since ${age(l.stop.at, now)} ago)`,
    };
  if (reason.startsWith("merge-train: retired"))
    return { tone: "muted", label: "retired", title: "lane card done/superseded — the train no longer ticks this lane (BR#4977)" };
  if (reason.startsWith("merge-train: awaiting bypass merge") || l.bypass_wait) {
    const bpm = reason.match(/PR #(\d+)/);
    return {
      tone: "warn",
      label: `⏸ needs a human merge${bpm ? ` · #${bpm[1]}` : ""}`,
      title: reason || "this PR is blocked by branch protection (required review/checks a machine cannot satisfy) — a human merge is the unblock; it clears itself when the PR lands",
    };
  }
  if (l.currently) {
    // the in-flight phase, in words — never a raw enum like "awaiting-ci"
    const phaseWord: Record<string, string> = {
      "awaiting-ci": "merged — waiting on CI",
      bursting: "merging several in a row",
      stopped: "stopped",
    };
    return {
      tone: l.currently.phase === "stopped" ? "err" : "live",
      label: phaseWord[l.currently.phase ?? ""] ?? l.currently.phase ?? "merging",
      title: `in flight: PR #${l.currently.pr ?? "?"} merged as ${String(l.currently.merge_sha ?? "").slice(0, 9)} — the train waits for main's build/deploy to finish green before taking the next card`,
    };
  }
  if (l.attempt) {
    return l.attempt.hold === "awaiting-review"
      ? { tone: "warn", label: `⏸ ${l.attempt.card} · needs review`, title: l.attempt.note }
      : { tone: "live", label: `▶ ${l.attempt.card} · checking`, title: l.attempt.note };
  }
  if (l.lease?.holder) {
    const t = lockTone(l, now);
    return {
      tone: t === "ok" ? "scope" : t === "warn" || t === "err" ? "warn" : "muted",
      label: "machine on it · idle",
      title: `a machine (${l.lease.holder}) holds this lane — heartbeat ${age(l.lease.heartbeat_ts, now)} ago; between merges`,
    };
  }
  if (l.capable?.ready)
    return {
      tone: "ok",
      label: "ready",
      title: `a merge machine (${l.capable.holder}) checked this lane ${age(l.capable.at, now)} ago — it takes the next card the moment one is queued`,
    };
  return {
    tone: "muted",
    label: "no machine",
    title: "no merge-capable machine has checked this lane inside the 15-minute window — merges wait until one runs (start a gateway / bridge train)",
  };
}

/** The NOW column (Ray, 2026-10-30: "I want to know WHAT is being done right
 *  now and progress"): status pill + PR + phase age (the lane-level state)
 *  PLUS the holder's live last action (BR#5114 now_action — the executor's
 *  own tick log via the BR#4104 proof-of-progress seam), which says WHY a
 *  held head is held ("PR #2588: head check RED: Meta-review nightly").
 *  The note is shown only while fresh (lease TTL = 5 min) — a stale one is
 *  history, not now, and rendering it would be the same lie as before. */
function nowAction(l: KbTrainLane, now: number): { text: string; title: string } | null {
  const na = l.now_action;
  if (!na?.note) return null;
  const ageSec = (now - na.at) / 1000;
  if (ageSec > 300) return null; // older than the lease TTL — not "now"
  return {
    text: na.note.length > 90 ? `${na.note.slice(0, 88)}…` : na.note,
    title: `${na.holder} · ${age(na.at, now)} ago — ${na.note}`,
  };
}

const REFRESH_MS = 30_000;

/** Merge-train table (Ray 2026-10-30 restructure): the lane row is THREE
 *  labeled time-frames — NOW (what is being done right now + progress),
 *  NEXT (the first queued head the train takes after the current work),
 *  QUEUE (everything remaining, depth + clickable cards with their PRs) —
 *  plus the lock dot, the line, and the throughput rate. A held head says
 *  WHY it is held (the now_action note), the last ledger event rides the
 *  rate column with its age, and "head"/"gate"/"bounced" are never the
 *  only words on screen. Data: GET /api/kb/train (the DO's train.status
 *  snapshot — lease/now_action are executor-fed, queue is hub-computed,
 *  oldest first). Polls every 30s (the tick is 45s); errors surface
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
          <span title="what the train is doing on this lane RIGHT NOW: the in-flight phase with its PR and age, or the head being gated with the reason it is held (the executor's own tick note) — plus the throughput rate and the last completed action with its age">now</span>
          <span title="the first queued card the train takes after the current work — card + PR">next</span>
          <span title="everything remaining in the derived queue, oldest first — click a card to open it">queue</span>
        </div>
      )}
      {(lanes ?? []).map((l) => {
        const dot = lockDot(l, now);
        const st = laneStatus(l, now);
        const repo = l.lane.split("@")[0];
        const na = nowAction(l, now);
        const next = l.queue[0];
        const rest = l.queue.slice(1);
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
            <span className="trainc-now">
              <span className="train-now-state">
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
              {l.attempt ? <span className="train-now-note" title={l.attempt.note}>{l.attempt.note}</span> : null}
              {na ? <span className="train-now-note" title={na.title}>{na.text}</span> : null}
              {l.activity ? (
                <span className="train-tp top-num" title={`merges over the last hour / 24 hours${l.activity.last_event ? ` — most recent completed action: ${l.activity.last_event.kind}${l.activity.last_event.pr ? ` PR #${l.activity.last_event.pr}` : ""} by ${l.activity.last_event.gateway ?? "?"}, ${age(l.activity.last_event.ts, now)} ago` : ""}`}>
                  <span className="train-tp-rate">{l.activity.merged_1h}/h · {l.activity.merged_24h}/24h</span>
                  {l.activity.last_event && (
                    <span className="train-last-event" title={`${l.activity.last_event.kind} · ${l.activity.last_event.gateway ?? "?"} · ${age(l.activity.last_event.ts, now)} ago (history — not the current activity)`}>
                      last: {l.activity.last_event.kind}
                      {l.activity.last_event.pr ? ` #${l.activity.last_event.pr}` : ""} {age(l.activity.last_event.ts, now)} ago
                    </span>
                  )}
                  {l.queue.length > 0 && l.activity.merged_24h === 0 && (
                    <span className="train-stall" title={`nothing has merged on this lane in 24 hours while ${l.queue.length} card(s) wait — ${l.queue_awaiting_review ? `${l.queue_awaiting_review} of them are waiting on a fresh review (their PR branches changed after their last review)` : "see the NOW line for what holds the first card"}`}>
                      ⚠ nothing merged in 24h · {l.queue.length} waiting{l.queue_awaiting_review ? ` · ${l.queue_awaiting_review} need reviews` : ""}
                    </span>
                  )}
                </span>
              ) : null}
            </span>
            <span className="trainc-next">
              {next ? (
                <>
                  <Chip
                    tone={next.priority === "critical" ? "urgent" : "scope"}
                    className="train-queue-card"
                    onClick={() => openTask?.(next.id)}
                    title={`${next.id} — ${next.priority === "critical" ? "boosted (priority 0)" : "normal priority"}${next.pr ? ` · PR #${next.pr}` : ""} — the next card this lane drives after the current work`}
                  >
                    {next.id}
                  </Chip>
                  {next.pr ? (
                    <a className="train-pr" href={`https://github.com/${repo}/pull/${next.pr}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>#{next.pr}</a>
                  ) : null}
                </>
              ) : (
                <span className="muted-note">—</span>
              )}
            </span>
            <span className="trainc-queue">
              {rest.length > 0 ? (
                <>
                  <span className="train-queue-label top-num" title="the cards after the next one — click to open">
                    +{rest.length} waiting{l.queue_awaiting_review ? ` · ${l.queue_awaiting_review} need reviews` : ""}
                  </span>
                  {rest.map((q) => (
                    <Chip
                      key={q.id}
                      tone={q.priority === "critical" ? "urgent" : "scope"}
                      className="train-queue-card"
                      onClick={() => openTask?.(q.id)}
                      title={`${q.id} — ${q.priority === "critical" ? "boosted (priority 0)" : "normal priority"}${q.pr ? ` · PR #${q.pr}` : ""}`}
                    >
                      {q.id}{q.pr ? ` ·#${q.pr}` : ""}
                    </Chip>
                  ))}
                </>
              ) : (
                <span className="muted-note">{next ? "nothing after the next card" : "queue empty"}</span>
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
