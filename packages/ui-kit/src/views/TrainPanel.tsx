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
          <span title="machine-on-lane — green a machine is on it · amber busy/lapsing · red stuck · grey nobody; hover names the machine">mach</span>
          <span>line</span>
          <span>status</span>
          <span title="the card + GitHub PR the train is processing right now — click the card to open it, the PR number opens GitHub">current</span>
          <span title="x of y PRs merged in the current batch (a batch lands back-to-back, then main settles before the next batch)">progress</span>
          <span title="the latest status message — what the machine did or hit most recently, and when">msg</span>
          <span title="PRs merged over the last hour / 24 hours">rate</span>
          <span title="how many cards are waiting to merge, and how many of those waiting cards are blocked on a fresh review">backlog</span>
        </div>
      )}
      {(lanes ?? []).map((l) => {
        const dot = lockDot(l, now);
        const st = laneStatus(l, now);
        const repo = l.lane.split("@")[0];
        const na = nowAction(l, now);
        // CURRENT: the card + PR being processed — in-flight merge first,
        // else the head the train is checking/holding
        const curCard = l.currently?.task_id ?? l.attempt?.card ?? null;
        const curPr = l.currently?.pr ?? l.queue[0]?.pr ?? null;
        // PROGRESS: x of y in the current batch (burst passes merge several
        // back-to-back; a single merge is a batch of 1)
        const prog =
          l.currently?.phase === "bursting"
            ? `${Number(l.currently.burst_merged ?? 0)} of ${l.currently.burst_cap === 0 ? "∞" : Number(l.currently.burst_cap ?? 0)} merged this batch`
            : l.currently
              ? "1 of 1 merged — settling"
              : l.queue.length > 0
                ? "0 of 1 — batch not started"
                : "—";
        // MSG: the freshest true message — the machine's live note first,
        // else the current attempt sentence, else the last ledger action
        const msg = na
          ? { text: na.text, title: na.title }
          : l.attempt
            ? { text: l.attempt.note, title: l.attempt.note }
            : l.activity?.last_event
              ? { text: `${l.activity.last_event.kind}${l.activity.last_event.pr ? ` PR #${l.activity.last_event.pr}` : ""} ${age(l.activity.last_event.ts, now)} ago`, title: `${l.activity.last_event.kind} by ${l.activity.last_event.gateway ?? "?"} ${age(l.activity.last_event.ts, now)} ago (history — no live machine note yet)` }
              : null;
        const stalled = l.queue.length > 0 && (l.activity?.merged_24h ?? 0) === 0;
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
            <span className="trainc-status"><Chip pill tone={st.tone} title={st.title}>{st.label}</Chip></span>
            <span className="trainc-cur">
              {curCard ? (
                <>
                  <span className={`train-cur-card ${openTask ? "trainc-open" : ""}`} onClick={() => openTask?.(curCard)} title={`${curCard} — click to open the card`}>{curCard}</span>
                  {curPr ? (
                    <a className="train-pr" href={`https://github.com/${repo}/pull/${curPr}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>#{curPr}</a>
                  ) : null}
                </>
              ) : (
                <span className="muted-note">—</span>
              )}
            </span>
            <span className="trainc-prog top-num" title={prog}>{prog}</span>
            <span className="trainc-msg">
              {msg ? <span className="train-now-note" title={msg.title}>{msg.text}</span> : <span className="muted-note">—</span>}
              {stalled && (
                <span className="train-stall" title={`nothing has merged on this lane in 24 hours while ${l.queue.length} card(s) wait${l.queue_awaiting_review ? ` — ${l.queue_awaiting_review} are blocked on a fresh review (their PR branches changed after their last review)` : ""}`}>
                  ⚠ nothing merged in 24h
                </span>
              )}
            </span>
            <span className="trainc-rate top-num" title={`PRs merged: last hour ${l.activity?.merged_1h ?? 0} · last 24h ${l.activity?.merged_24h ?? 0}`}>{l.activity?.merged_1h ?? 0}/h · {l.activity?.merged_24h ?? 0}/24h</span>
            <span className="trainc-backlog top-num" title={`${l.queue.length} card(s) waiting to merge (oldest first: ${l.queue.slice(0, 6).map((q) => q.id + (q.pr ? ` ·#${q.pr}` : "")).join(", ")}${l.queue.length > 6 ? " …" : ""})${l.queue_awaiting_review ? `\n${l.queue_awaiting_review} additionally bounced and waiting on a fresh review` : ""}`}>
              {l.queue.length} queued{l.queue_awaiting_review ? ` · ${l.queue_awaiting_review} need reviews` : ""}
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
