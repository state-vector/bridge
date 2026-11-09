import { useEffect, useState } from "react";
import type { HubDiagnostics, LineRemediation, TrainLineProjection } from "@bridge/contracts";
import { recoveryCauseLabel, recoveryIsOpen } from "@bridge/contracts";
import { kbApi, type KbTrainLane } from "../server/kb";
import { Btn, Chip, type ChipTone } from "./index-kit";

function age(ts: number | undefined, now: number): string {
  if (!ts) return "unknown";
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`;
}

export const trainLineTones: Record<TrainLineProjection["phase"], ChipTone> = {
  idle: "muted", ready: "ok", working: "live", waiting: "warn", base_red: "err",
  error: "err", unknown: "warn", action_required: "warn", retired: "muted",
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
  return <div className={`train-blocked-banner${trainLineTones[line.phase] === "warn" ? " train-blocked-banner-amber" : ""}`} role="alert">
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


/** BR#4849: the stop-the-line banner — a red main must be the FIRST thing the
 *  Top view says (Ray 2026-10-29: "its critical we reflect this and show a)
 *  who broke it and b) who is fixing it"). Two accountability lines:
 *  - broke it: the recorded culprit, or the landing at the failing commit
 *    (labeled unconfirmed);
 *  - fixing it: a pending action from the current line, or the root repair
 *    with its owner/executor. Keep unclaimed repair work visible. */
function StopLineBanner({ l, now, openTask }: { l: KbTrainLane; now: number; openTask?: (id: string) => void }) {
  const repo = l.lane.split("@")[0];
  const line = l.line ?? unavailable;
  const remediation = line.remediation;
  const red = remediation && (remediation.kind === "agent" || remediation.kind === "queued" || remediation.kind === "blocked") ? remediation.task : null;
  const stopped = l.lane_state?.phase === "stopped_red" ? l.lane_state : null;
  const failingSha = stopped?.failing_sha ?? l.stop?.sha;
  const culprit = stopped ? stopped.culprit_task : l.stop?.culprit_task ?? null;
  const lastMerge = failingSha && l.last_merge?.merge_sha === failingSha ? l.last_merge : null;
  const fixer = red?.active_agent ? red.owner || red.executor_session : "";
  const pendingAsk = remediation?.kind === "blocked"
    ? remediation.task.execution_blockers?.find((blocker) => blocker.kind === "human_answer_required")
    : undefined;
  return (
    <div className="train-stopline" role="alert">
      <div className="train-stopline-head">
        <span className="train-stopline-flag">⛔ STOP-THE-LINE</span>
        <span className="train-stopline-line">main RED — {l.lane}</span>
      </div>
      <div
        className="train-stopline-why"
        title={[line.reason, ...line.evidence.map((f) => f.name)].join(" · ")}
      >
        {line.reason}
        {failingSha ? <span className="top-num"> @ {failingSha.slice(0, 9)}</span> : null}
      </div>
      <div className="train-stopline-who">
        <span
          className="train-stopline-cell"
          title="The recorded culprit or the landing at the failing commit"
        >
          broke it:{" "}
          {culprit ? (
            <a className="train-stopline-who-link" onClick={() => openTask?.(culprit)}>{culprit}</a>
          ) : lastMerge?.pr ? (
            <>
              <a className="train-stopline-who-link" href={`https://github.com/${repo}/pull/${lastMerge.pr}`} target="_blank" rel="noreferrer">#{lastMerge.pr}</a>
              {" "}by {lastMerge.gateway ?? "?"}
              {lastMerge.task_id ? <> — <a className="train-stopline-who-link" onClick={() => openTask?.(lastMerge.task_id!)}>{lastMerge.task_id}</a></> : null}
              {" "}<span className="muted-note">(landing at the failing commit, unconfirmed)</span>
            </>
          ) : (
            <span className="muted-note">unconfirmed for this commit</span>
          )}
        </span>
        <span className="train-stopline-cell" title="Recovery for the failing commit">
          fixing it:{" "}
          {remediation?.kind === "merge" ? (
            <a className="train-stopline-who-link" href={remediation.request?.url ?? remediation.url}
              target="_blank" rel="noreferrer" title={remediation.text}>Awaiting merge action for PR #{remediation.pr}</a>
          ) : remediation?.kind === "human" ? (
            <TaskLink id={remediation.action.id} url={remediation.action.url} openTask={openTask}>Awaiting action · {remediation.action.id}</TaskLink>
          ) : pendingAsk ? (
            <a className="train-stopline-who-link" onClick={() => openTask?.(pendingAsk.ask_id)}
              title={pendingAsk.text}>Awaiting action · {pendingAsk.ask_id}</a>
          ) : red ? (
            <>
              <a className="train-stopline-who-link" onClick={() => openTask?.(red.id)}>{red.id}</a>
              {fixer ? (
                <span> · {fixer}{red.owner && red.executor_session ? ` (${red.executor_session})` : ""}</span>
              ) : remediation?.kind === "queued" ? (
                <Chip tone="warn" title={remediation.text}>Recovery queued</Chip>
              ) : (
                <Chip tone="urgent" className="train-stopline-unowned" title={`${red.id} is open and unclaimed — claim it before anything else merges`}>
                  ⚠ UNOWNED — nobody is fixing it
                </Chip>
              )}
            </>
          ) : (
            remediation ? <Recovery action={remediation} now={now} openTask={openTask} /> : <span className="muted-note">Recovery status unavailable</span>
          )}
        </span>
      </div>
    </div>
  );
}

export function HubRequestDiagnostics({ now }: { now: number }) {
  const [snapshot, setSnapshot] = useState<HubDiagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    if (loading) return;
    setLoading(true);
    try { setSnapshot(await kbApi.diagnostics()); setError(null); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };
  return <details className="muted-note" onToggle={event => { if (event.currentTarget.open && !snapshot) void load(); }}>
    <summary>Hub request diagnostics</summary>
    <div>Request timings and current processing stages. Loaded on demand; opening this view does not run scheduler or repair sweeps.</div>
    <Btn onClick={() => void load()} disabled={loading}>{loading ? "Reading hub…" : "Refresh diagnostics"}</Btn>
    {error && <div role="alert">Diagnostics unavailable: {error}</div>}
    {snapshot && <>
      <div>Observed {age(snapshot.observed_at, now)} ago · instance running since {new Date(snapshot.started_at).toISOString()} · timings reset on hub restart</div>
      <div>{snapshot.active.length} tracked requests in progress</div>
      {snapshot.active.map(r => <div key={r.id}>{r.operation}: {r.stage} · {r.elapsed_ms}ms elapsed at observation</div>)}
      {[...snapshot.operations].sort((a, b) => b.max_ms - a.max_ms).slice(0, 12).map(r => <div key={r.operation}>
        {r.operation}: {r.count} requests · {r.errors} server errors · max ingress {r.max_ingress_ms}ms · max processing {r.max_ms}ms
      </div>)}
    </>}
  </details>;
}
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
    {!error && (activeLanes ?? []).filter((l) => l.line?.phase === "base_red").map((l) => (
      <StopLineBanner key={`stopline-${l.lane}`} l={l} now={now} openTask={openTask} />
    ))}
    {activeLanes?.length === 0 && <div className="muted-note">No active merge lines.</div>}
    {!!activeLanes?.length && <div className="ktable-head train-head-cols">
      <span title="Executor heartbeat" aria-label="Executor heartbeat">●</span><span>line</span><span>status</span><span>progress</span><span>message</span><span>rate</span><span>PRs</span>
    </div>}
    {(activeLanes ?? []).map((l) => {
      const line = l.line ?? unavailable;
      const needsAttention = line.phase === "base_red" || line.phase === "error" || line.phase === "unknown" || line.phase === "action_required";
      const live = !!l.lease && now - l.lease.heartbeat_ts < 300_000;
      const machine = l.lease?.holder ?? l.capable?.holder;
      const repo = l.lane.split("@")[0];
      const stats = l.pr_stats ?? { in_progress: 0, verifying: 0, ready: 0 };
      const cars = l.batches?.flat() ?? [];
      const eligible = cars.filter(q => q.eligibility === "eligible").length;
      const reviewed = cars.filter(q => q.eligibility != null).length;
      const progress = l.currently?.phase === "bursting"
        ? `${l.currently.burst_merged ?? 0} merged this batch`
        : l.currently ? "Merged — checking deployment" : `${line.held} changes queued`;
      return <section key={l.lane} className={`train-lane-group${needsAttention ? " train-lane-interrupted" : ""}`} aria-label={l.lane}>
      <div className="ktable-row train-row">
        <span className="trainc-dot"><span className={`train-dot td-${live ? "live" : "free"}`} title={machine
          ? `${machine} · last heartbeat ${age(l.lease?.heartbeat_ts ?? l.capable?.at, now)} ago` : "No executor reported"} /></span>
        <span className="trainc-line trainc-open" onClick={() => openTask?.(l.card)} title={l.lane}>{l.lane}</span>
        <span className="trainc-status"><Chip pill tone={trainLineTones[line.phase]} title={line.reason}>{line.label}</Chip>
          {l.currently?.pr && <a className="train-pr" href={`https://github.com/${repo}/pull/${l.currently.pr}`} target="_blank" rel="noreferrer">#{l.currently.pr}</a>}
        </span>
        <span className="trainc-prog top-num">{progress}</span>
        <span className="trainc-msg">{line.remediation?.text ?? line.reason}
          {(l.escalations ?? []).map((e) => <Chip key={`${e.task_id}-${e.pr}`} pill tone={e.expired ? "err" : "warn"}
            title={`bounce budget (BR#4688): ${e.task_id} PR #${e.pr} breached at ${e.bounce_no}× ${e.bounce_kind ?? "?"} bounces — de-queued, escalation ask ${e.ask_id ?? "?"}; owner clock ${e.expired ? `expired ${age(e.grace_until, now)} ago (executor closes the PR)` : `${age(e.grace_until, now)} left`}`}>⏳ {e.pr ? `#${e.pr}` : e.task_id} ×{e.bounce_no}</Chip>)}
        </span>
        <span className="trainc-rate top-num">{l.activity?.merged_1h ?? 0}/h · {l.activity?.merged_24h ?? 0}/24h</span>
        <span className="trainc-backlog"><span className="train-stats">
          <span className="train-stat ts-ip">{stats.in_progress} in progress</span> <span className="train-stat ts-verifying">{stats.verifying} verifying</span> <span className="train-stat" title="Reviewed and conflict-free, including eligible PRs">{reviewed} reviewed &amp; clean</span> <span className="train-stat ts-ready" title="Eligible to merge now: selected by the executor for the current batch">{eligible} eligible</span>
        </span><span className="train-blocks">{(l.batches ?? []).map((batch, bi) => <span key={bi} className="train-block-group">
          {bi > 0 && <span className="train-block-gap" />}
          {batch.map((q, qi) => <span key={`${q.id}-${q.pr ?? qi}`} className={`train-block ${q.eligibility === "eligible" ? "tb-ready" : q.eligibility === "reviewed" ? "tb-reviewed" : q.state === "ready" ? "tb-unknown" : q.state === "verifying" ? "tb-verifying" : "tb-wait"}${bi === 0 && qi === 0 ? " tb-head" : ""}${q.over_budget ? " tb-over-budget" : ""}`}
            title={`Batch ${bi + 1} · ${q.id}${q.pr ? ` · PR #${q.pr}` : ""} — ${q.detail ?? q.state}${q.bounces != null ? ` · Returned to repair/review ${q.bounces} time(s) across tracked history${q.over_budget ? " — active bounce-budget escalation" : ""}` : ""}`} onClick={() => openTask?.(q.id)} />)}
        </span>)}</span></span>
      </div>
      {needsAttention && <LineStopBanner lane={l} now={now} openTask={openTask} />}
      </section>;
    })}
    <HubRequestDiagnostics now={now} />
  </div>;
}
