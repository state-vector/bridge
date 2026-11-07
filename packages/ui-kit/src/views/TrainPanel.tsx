import { useEffect, useState } from "react";
import type { LineRemediation, TrainLineProjection } from "@bridge/contracts";
import { recoveryCauseLabel, recoveryIsOpen } from "@bridge/contracts";
import { kbApi, type KbTrainLane } from "../server/kb";
import { Chip, type ChipTone } from "./index-kit";

function age(ts: number | undefined, now: number): string {
  if (!ts) return "unknown";
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`;
}

const tones: Record<TrainLineProjection["phase"], ChipTone> = {
  ready: "ok", working: "live", waiting: "warn", stopped: "err", unknown: "err", retired: "muted",
};
const unavailable: TrainLineProjection = {
  phase: "unknown", label: "Status unavailable", reason: "The server has not supplied a current line status.",
  blocker: "stale_observation", evidence: [], held: 0, observed_at: 0,
  remediation: { kind: "attention", text: "Waiting for a current status from the hub. Work has not been confirmed healthy." },
};

function TaskLink({ id, url, children, openTask }: {
  id: string; url: string; children: React.ReactNode; openTask?: (id: string) => void;
}) {
  return <a className="train-banner-card" href={url} onClick={(e) => {
    if (openTask) { e.preventDefault(); openTask(id); }
  }}>{children}</a>;
}

function Recovery({ action, now, openTask }: { action: LineRemediation; now: number; openTask?: (id: string) => void }) {
  switch (action.kind) {
    case "merge":
      return <>
        <span className="train-banner-line"><strong>Your action: </strong>{action.text}</span>
        <span className="train-banner-line"><a className="train-banner-card" href={action.url} target="_blank" rel="noreferrer">
          <strong>Open fix PR #{action.pr} — bypass-merge on GitHub</strong>
        </a></span>
        {action.request && <span className="train-banner-line"><TaskLink id={action.request.id} url={action.request.url} openTask={openTask}>
          Confirm merged or hold the line
        </TaskLink></span>}
      </>;
    case "human":
      return <>
        <span className="train-banner-line"><strong>Your action: </strong>{action.text}</span>
        <span className="train-banner-line"><TaskLink id={action.action.id} url={action.action.url} openTask={openTask}>
          Open the action request — choose an answer
        </TaskLink></span>
      </>;
    case "machine":
      return <span className="train-banner-line">Recovery: {action.url
        ? <a href={action.url} target="_blank" rel="noreferrer">{action.text}</a> : action.text}</span>;
    case "agent":
    case "blocked":
    case "queued": {
      const task = action.task;
      return <>
        <span className="train-banner-line">{action.text}</span>
        <details className="train-banner-line">
          <summary>Repair details · {task.id}</summary>
          <TaskLink id={task.id} url={task.url} openTask={openTask}>{task.title}</TaskLink>
          {task.owner && <div>Owner: {task.owner}</div>}
          {task.execution_blockers?.map(b => <div key={b.episode_id}>Blocked: {b.text}</div>)}
          {task.last_progress?.note && <div>{task.last_progress.note}</div>}
        {task.last_progress && <div>
          Last update {age(task.last_progress.ts, now)} ago
          {task.last_progress.completion_pct != null ? ` · ${task.last_progress.completion_pct}%` : ""}
          {task.last_progress.will ? ` · NEXT: ${task.last_progress.will}` : action.kind === "agent" ? " · Next action not yet reported" : ""}
        </div>}
        </details>
      </>;
    }
    case "attention":
      return <span className="train-banner-line"><strong>Recovery needs attention: </strong>{action.text}</span>;
  }
}

/** A single renderer for every interruption. All classification and precedence
 * come from the hub's typed `line` projection, shared with its row and message. */
export function LineStopBanner({ lane, now, openTask }: { lane: KbTrainLane; now: number; openTask?: (id: string) => void }) {
  const line = lane.line ?? unavailable;
  return <div className={`train-blocked-banner${line.phase === "waiting" ? " train-blocked-banner-amber" : ""}`} role="alert">
    <div className="train-banner-cause">
    <span className="train-banner-line"><strong>{line.label}</strong> · {line.held} changes held</span>
    <span className="train-banner-line">{line.reason}</span>
    {line.evidence.length > 0 && <span className="train-banner-line train-banner-checks">Checks: {line.evidence.map((e, i) =>
      <span key={`${e.name}-${i}`}>{i > 0 ? " · " : ""}{e.url
        ? <a href={e.url} target="_blank" rel="noreferrer">{e.name}</a> : e.name}</span>)}</span>}
    {line.observed_at > 0 && <span className="train-banner-line train-banner-dim">Main last checked {age(line.observed_at, now)} ago</span>}
    </div>
    {(line.remediation || !!line.recoveries?.length) && <div className="train-banner-recovery">
    {line.remediation && <Recovery action={line.remediation} now={now} openTask={openTask} />}
    {lane.stalled_resolution?.last_error && <details className="train-banner-line"><summary>Merge rejection details</summary>{lane.stalled_resolution.last_error}</details>}
    <LaneRecoveryHistory line={line} now={now} openTask={openTask} />
    </div>}
  </div>;
}

export function LaneRecoveryHistory({ line, now, openTask }: { line: TrainLineProjection; now: number; openTask?: (id: string) => void }) {
  const recoveries = line.recoveries?.filter((r) => r.episode.stage.phase !== "superseded") ?? [];
  const active = recoveries.filter((r) => recoveryIsOpen(r.episode)).length;
  return recoveries.length > 0 ? <details className="train-banner-line">
    <summary>Recovery history · {active} active · {recoveries.length - active} resolved</summary>
    {recoveries.map(({ episode, task }) => (
      <div key={episode.id} className="train-banner-line">
        <strong>{recoveryCauseLabel(episode.cause)}</strong> — {episode.stage.phase}
        {task && <> · <TaskLink id={task.id} url={task.url} openTask={openTask}>{task.id}</TaskLink>{task.owner ? ` · ${task.owner}` : ""}</>}
        <div>Next: {episode.stage.next}</div>
        {episode.attempts.map((attempt) => <div key={attempt.id}>
          Action: {attempt.action} — {attempt.status === "running" ? "execution in progress; no result yet" : `${attempt.outcome}: ${attempt.summary}`}
          {attempt.status === "finished" && attempt.receipts.map((url) => <a key={url} href={url} target="_blank" rel="noreferrer"> · receipt</a>)}
        </div>)}
        <details><summary>Recovery history · {episode.sources.length} observed run attempt(s)</summary>
          {episode.history.map((event) => <div key={event.event_id}>{age(event.at, now)} ago · {event.kind}: {event.summary}</div>)}
        </details>
      </div>
    ))}
    </details> : null;
}

const REFRESH_MS = 30_000;

/** BR#5106 depth-counter honesty (Ray: "depth counters seem wrong — there
 *  are way more PRs open"): the derived queue is the ACTIONABLE subset
 *  (verdict-stamped, gate-clean heads per the BR#4079 contract) while `open`
 *  is every open PR the repo's last reconcile pass listed. Both render —
 *  `queue N · open M` — so a lane can never read nearly-empty while GitHub
 *  shows a pile (the "43 open PRs, queue EMPTY" class, BR#5022). No
 *  reconcile data yet → queue alone, never a made-up zero. */
export function trainQueueDepthLabel(l: Pick<KbTrainLane, "queue" | "open_prs">): string {
  const depth = `queue ${l.queue?.length ?? 0}`;
  return l.open_prs ? `${depth} · open ${l.open_prs.count}` : depth;
}

/** Merge-trains panel (BR#5658 v2, Ray 2026-11-03): one row per lane on the
 *  shared justified grid — the lane's PRs column carries the 3-bucket stat
 *  line (`N in progress · M verifying · K ready`) above the sequential merge
 *  batches, and the BR#5106 honest depth line (`queue N · open M`) rides the
 *  same cell so the buckets never read as the whole truth. Interruptions
 *  render through the hub's typed `line` projection (LineStopBanner).
 *  Data: GET /api/kb/train (the DO's train.status snapshot — lease is
 *  executor-fed, queue/pr_stats/batches/open_prs are hub-computed). Polls
 *  every 30s (the tick is 45s); errors surface in-panel, never silent. */
export function TrainPanel({ openTask }: { openTask?: (id: string) => void }) {
  const [lanes, setLanes] = useState<KbTrainLane[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const r = await kbApi.train();
        if (!dead) { setLanes(r.lanes ?? []); setError(null); }
      } catch (e) { if (!dead) setError(e instanceof Error ? e.message : String(e)); }
    };
    void load();
    const poll = setInterval(load, REFRESH_MS);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { dead = true; clearInterval(poll); clearInterval(clock); };
  }, []);
  return <TrainPanelView lanes={lanes} error={error} now={now} openTask={openTask} />;
}

export function TrainPanelView({ lanes, error, now, openTask }: {
  lanes: KbTrainLane[] | null; error: string | null; now: number; openTask?: (id: string) => void;
}) {
  const activeLanes = lanes?.filter(lane => !lane.retired && lane.line?.phase !== "retired");
  return <div className="train-panel">
    <div className="train-head"><h2>Merge trains</h2><span className="muted-note">Live status and recovery · updates every 30s</span>
      <span className="muted-note">Each block is a PR; repair/review return counts are in its details.</span></div>
    {error && <div className="train-lane train-lane-err" role="alert">⚠ train status unavailable — {error}</div>}
    {activeLanes?.length === 0 && <div className="muted-note">No active merge lines.</div>}
    {!!activeLanes?.length && <div className="ktable-head train-head-cols">
      <span title="Executor heartbeat" aria-label="Executor heartbeat">●</span><span>line</span><span>status</span><span>progress</span><span>message</span><span>rate</span><span>PRs</span>
    </div>}
    {(activeLanes ?? []).map((l) => {
      const line = l.line ?? unavailable;
      const needsAttention = line.phase === "stopped" || line.phase === "unknown";
      const live = !!l.lease && now - l.lease.heartbeat_ts < 300_000;
      const machine = l.lease?.holder ?? l.capable?.holder;
      const repo = l.lane.split("@")[0];
      const stats = l.pr_stats ?? { in_progress: 0, verifying: 0, ready: 0 };
      const progress = l.currently?.phase === "bursting"
        ? `${l.currently.burst_merged ?? 0} merged this batch`
        : l.currently ? "Merged — checking deployment" : `${line.held} changes queued`;
      return <section key={l.lane} className={`train-lane-group${needsAttention ? " train-lane-interrupted" : ""}`} aria-label={l.lane}>
      <div className="ktable-row train-row">
        <span className="trainc-dot"><span className={`train-dot td-${live ? "live" : "free"}`} title={machine
          ? `${machine} · last heartbeat ${age(l.lease?.heartbeat_ts ?? l.capable?.at, now)} ago` : "No executor reported"} /></span>
        <span className="trainc-line trainc-open" onClick={() => openTask?.(l.card)} title={l.lane}>{l.lane}</span>
        <span className="trainc-status"><Chip pill tone={tones[line.phase]} title={line.reason}>{line.label}</Chip>
          {l.currently?.pr && <a className="train-pr" href={`https://github.com/${repo}/pull/${l.currently.pr}`} target="_blank" rel="noreferrer">#{l.currently.pr}</a>}
        </span>
        <span className="trainc-prog top-num">{progress}</span>
        <span className="trainc-msg">{line.remediation?.text ?? line.reason}
          {(l.escalations ?? []).map((e) => <Chip key={`${e.task_id}-${e.pr}`} pill tone={e.expired ? "err" : "warn"}
            title={`bounce budget (BR#4688): ${e.task_id} PR #${e.pr} breached at ${e.bounce_no}× ${e.bounce_kind ?? "?"} bounces — de-queued, escalation ask ${e.ask_id ?? "?"}; owner clock ${e.expired ? `expired ${age(e.grace_until, now)} ago (executor closes the PR)` : `${age(e.grace_until, now)} left`}`}>⏳ {e.pr ? `#${e.pr}` : e.task_id} ×{e.bounce_no}</Chip>)}
        </span>
        <span className="trainc-rate top-num">{l.activity?.merged_1h ?? 0}/h · {l.activity?.merged_24h ?? 0}/24h</span>
        <span className="trainc-backlog">
          <span className="train-depth top-num" title={`${l.queue?.length ?? 0} card(s) waiting to merge — the derived queue, the actionable subset (verdict-stamped, gate-clean heads)${l.queue_awaiting_review ? ` · ${l.queue_awaiting_review} additionally bounced and waiting on a fresh review` : ""}${l.open_prs ? `\nopen = every open PR the repo's last reconcile pass listed (${age(l.open_prs.ts, now)} ago) — the verification buckets are not the whole truth; the derived queue is only the actionable subset (BR#5106/BR#5022)` : "\nno reconcile data yet — queue alone, never a made-up zero (BR#5106/BR#5022)"}`}>
            {trainQueueDepthLabel(l)}{l.queue_awaiting_review ? ` · ${l.queue_awaiting_review} need reviews` : ""}
          </span>
          <span className="train-stats">
            <span className="train-stat ts-ip">{stats.in_progress} in progress</span> · <span className="train-stat ts-verifying">{stats.verifying} verifying</span> · <span className="train-stat ts-ready">{stats.ready} verified</span>
          </span>
          <span className="train-blocks">{(l.batches ?? []).map((batch, bi) => <span key={bi} className="train-block-group">
          {bi > 0 && <span className="train-block-gap" />}
          {batch.map((q, qi) => <span key={`${q.id}-${q.pr ?? qi}`} className={`train-block ${q.state === "ready" ? "tb-ready" : q.state === "verifying" ? "tb-verifying" : "tb-wait"}${bi === 0 && qi === 0 ? " tb-head" : ""}${q.over_budget ? " tb-over-budget" : ""}`}
            title={`Batch ${bi + 1} · ${q.id}${q.pr ? ` · PR #${q.pr}` : ""} — ${q.detail ?? q.state}${q.bounces != null ? ` · Returned to repair/review ${q.bounces} time(s) across tracked history${q.over_budget ? " — active bounce-budget escalation" : ""}` : ""}`} onClick={() => openTask?.(q.id)} />)}
        </span>)}</span></span>
      </div>
      {needsAttention && <LineStopBanner lane={l} now={now} openTask={openTask} />}
      </section>;
    })}
  </div>;
}
