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
  const recoveries = line.recoveries?.filter((r) => r.episode.stage.phase !== "superseded") ?? [];
  const active = recoveries.filter((r) => recoveryIsOpen(r.episode)).length;
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
    {recoveries.length > 0 && <details className="train-banner-line">
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
    </details>}
    </div>}
  </div>;
}

const REFRESH_MS = 30_000;
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
  return <div className="train-panel">
    <div className="train-head"><h2>Merge trains</h2><span className="muted-note">Live status and recovery · updates every 30s</span></div>
    {error && <div className="train-lane train-lane-err" role="alert">⚠ train status unavailable — {error}</div>}
    {lanes?.length === 0 && <div className="muted-note">No merge lines configured.</div>}
    {!!lanes?.length && <div className="ktable-head train-head-cols">
      <span title="Executor heartbeat" aria-label="Executor heartbeat">●</span><span>line</span><span>status</span><span>progress</span><span>message</span><span>rate</span><span>PRs</span>
    </div>}
    {(lanes ?? []).map((l) => {
      const line = l.line ?? unavailable;
      const live = !!l.lease && now - l.lease.heartbeat_ts < 300_000;
      const machine = l.lease?.holder ?? l.capable?.holder;
      const repo = l.lane.split("@")[0];
      const stats = l.pr_stats ?? { in_progress: 0, verifying: 0, ready: 0 };
      const progress = l.currently?.phase === "bursting"
        ? `${l.currently.burst_merged ?? 0} merged this batch`
        : l.currently ? "Merged — checking deployment" : `${line.held} changes queued`;
      return <section key={l.lane} className={`train-lane-group${line.blocker ? " train-lane-interrupted" : ""}`} aria-label={l.lane}>
      <div className="ktable-row train-row">
        <span className="trainc-dot"><span className={`train-dot td-${live ? "live" : "free"}`} title={machine
          ? `${machine} · last heartbeat ${age(l.lease?.heartbeat_ts ?? l.capable?.at, now)} ago` : "No executor reported"} /></span>
        <span className="trainc-line trainc-open" onClick={() => openTask?.(l.card)} title={l.lane}>{l.lane}</span>
        <span className="trainc-status"><Chip pill tone={tones[line.phase]} title={line.reason}>{line.label}</Chip>
          {l.currently?.pr && <a className="train-pr" href={`https://github.com/${repo}/pull/${l.currently.pr}`} target="_blank" rel="noreferrer">#{l.currently.pr}</a>}
        </span>
        <span className="trainc-prog top-num">{progress}</span>
        <span className="trainc-msg">{line.remediation?.text ?? line.reason}</span>
        <span className="trainc-rate top-num">{l.activity?.merged_1h ?? 0}/h · {l.activity?.merged_24h ?? 0}/24h</span>
        <span className="trainc-backlog"><span className="train-stats">
          <span className="train-stat ts-ip">{stats.in_progress} in progress</span> · <span className="train-stat ts-verifying">{stats.verifying} verifying</span> · <span className="train-stat ts-ready">{stats.ready} ready</span>
        </span><span className="train-blocks">{(l.batches ?? []).map((batch, bi) => <span key={bi} className="train-block-group">
          {bi > 0 && <span className="train-block-gap" />}
          {batch.map((q, qi) => <span key={`${q.id}-${q.pr ?? qi}`} className={`train-block ${q.state === "ready" ? "tb-ready" : q.state === "verifying" ? "tb-verifying" : "tb-wait"}${bi === 0 && qi === 0 ? " tb-head" : ""}`}
            title={`Batch ${bi + 1} · ${q.id}${q.pr ? ` · PR #${q.pr}` : ""} — ${q.detail ?? q.state}`} onClick={() => openTask?.(q.id)} />)}
        </span>)}</span></span>
      </div>
      {line.blocker && <LineStopBanner lane={l} now={now} openTask={openTask} />}
      </section>;
    })}
  </div>;
}
