import { useEffect, useState } from "react";
import type { TrainLineProjection } from "@bridge/contracts";
import { kbApi, type KbArtefact, type KbTrainLane, type KbVersion } from "../server/kb";
import { Btn, Chip } from "./index-kit";
import { LaneRecoveryHistory, LineStopBanner, trainLineTones } from "./TrainPanel";

/** Infrastructure identity comes from structured metadata, never the title. */
export function isLaneCard(task: KbArtefact): boolean {
  const lane = task.meta?.lane;
  return typeof lane === "object" && lane !== null && "repo" in lane && "base" in lane
    && typeof lane.repo === "string" && typeof lane.base === "string";
}

const unknown: TrainLineProjection = {
  phase: "unknown", label: "Status unavailable", reason: "Waiting for a current lane status from the hub.",
  blocker: "stale_observation", evidence: [], held: 0, observed_at: 0,
  remediation: { kind: "attention", text: "Waiting for a fresh observation; lane health has not been confirmed." },
};
const age = (ts: number, now: number) => {
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
};
const cardUrl = (id: string) => `/card/${id.replace("#", "-")}`;

function CardLink({ id, onOpen, children }: { id: string; onOpen?: (id: string) => void; children?: React.ReactNode }) {
  return <a href={cardUrl(id)} onClick={onOpen ? (e) => { e.preventDefault(); onOpen(id); } : undefined}>{children ?? id}</a>;
}

async function bounded<T,>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("No response from the hub after 12 seconds")), 12_000);
    })]);
  } finally { clearTimeout(timer); }
}

export function LaneDetail({ task, onClose, onOpen }: { task: KbArtefact; onClose: () => void; onOpen?: (id: string) => void }) {
  const [lane, setLane] = useState<KbTrainLane | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [receivedAt, setReceivedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [versions, setVersions] = useState<KbVersion[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      await Promise.all([
        bounded(kbApi.train()).then((result) => {
          if (!live) return;
          setLane(result.lanes.find((l) => l.card === task.id) ?? null);
          setError(null); setLoaded(true); setReceivedAt(Date.now());
        }).catch((e: unknown) => { if (live) { setError(e instanceof Error ? e.message : String(e)); setLoaded(true); } }),
        bounded(kbApi.history(task.id)).then((result) => {
          if (live) { setVersions(result.versions); setHistoryError(null); }
        }).catch((e: unknown) => { if (live) setHistoryError(e instanceof Error ? e.message : String(e)); }),
      ]);
      loading = false;
    };
    void load();
    const poll = setInterval(() => void load(), 30_000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { live = false; clearInterval(poll); clearInterval(clock); };
  }, [task.id, retry]);
  return <LaneDetailView task={task} lane={lane} loaded={loaded} error={error} receivedAt={receivedAt} now={now}
    versions={versions} historyError={historyError} onRetry={() => setRetry((x) => x + 1)} onClose={onClose} onOpen={onOpen} />;
}

export function LaneDetailView({ task, lane, loaded, error, receivedAt, now, versions, historyError, onRetry, onClose, onOpen }: {
  task: KbArtefact; lane: KbTrainLane | null; loaded: boolean; error: string | null; receivedAt: number; now: number;
  versions: KbVersion[]; historyError: string | null; onRetry: () => void; onClose: () => void; onOpen?: (id: string) => void;
}) {
  const stale = receivedAt > 0 && now - receivedAt > 15 * 60_000;
  const line = error || stale ? { ...unknown, held: lane?.line?.held ?? lane?.queue.length ?? 0 } : lane?.line ?? unknown;
  const repo = lane?.lane.split("@")[0];
  const freshFacts = !error && !stale && !!lane?.queue_facts && now - lane.queue_facts.at < 15 * 60_000;
  const facts = freshFacts ? lane?.queue_facts?.entries ?? [] : [];
  const queue = lane?.queue ?? [];
  const verifying = (lane?.batches ?? []).flat().filter((entry) => !queue.some((q) => q.id === entry.id));
  const heartbeat = lane?.lease?.heartbeat_ts;
  const executorLive = !error && !stale && !!heartbeat && now - heartbeat < 300_000;
  const events = versions.filter((v) => ["train:merged", "train:landed", "train:bounced", "train:stopped", "train:updated"].includes(v.action));
  return <>
    <div className="panel-backdrop" onClick={onClose} />
    <aside className="detail-panel lane-detail" aria-label="Merge lane detail">
      <header className="detail-head"><Chip tone="scope">merge lane</Chip><button className="icon-btn" aria-label="Close lane detail" onClick={onClose}>✕</button></header>
      <h2 className="detail-question">{lane?.lane ?? task.title}</h2>
      <div className="lane-detail-status"><Chip pill tone={trainLineTones[line.phase]}>{!loaded ? "Loading lane…" : line.label}</Chip>
        {receivedAt > 0 && <span className="muted-note">Updated {age(receivedAt, now)} ago · refreshes every 30s</span>}</div>
      {error && <div className="k-err" role="alert">Lane refresh failed: {error}. Previous observations are not current. <Btn size="sm" onClick={onRetry}>Retry</Btn></div>}
      {stale && <div className="k-err" role="alert">Lane observations are out of date. <Btn size="sm" onClick={onRetry}>Refresh</Btn></div>}
      {loaded && !lane && !error && <div role="status">This lane is not available in the hub’s lane list. <Btn size="sm" onClick={onRetry}>Retry</Btn></div>}
      {lane && (line.blocker ? <LineStopBanner lane={{ ...lane, line }} now={now} openTask={onOpen} /> : <p>{line.reason}</p>)}
      {lane && <>
        <div className="lane-detail-stats">
          <span><strong>{executorLive ? "Executor online" : "No live executor confirmed"}</strong>{heartbeat ? ` · heartbeat ${age(heartbeat, now)} ago` : ""}</span>
          <span>{lane.activity?.merged_1h ?? 0} merged / hour · {lane.activity?.merged_24h ?? 0} / 24 hours</span>
        </div>
        {lane.currently?.pr && <div className="detail-block"><label>{error || stale ? "Last observed merge" : "Current merge"}</label>
          <a href={`https://github.com/${repo}/pull/${lane.currently.pr}`} target="_blank" rel="noreferrer">PR #{lane.currently.pr}</a>
          {lane.currently.task_id && <> · <CardLink id={lane.currently.task_id} onOpen={onOpen} /></>}
          {lane.currently.merge_sha && <span> · <code>{lane.currently.merge_sha.slice(0, 9)}</code></span>}
        </div>}
        <section className="detail-block"><label>{error || stale ? "Last observed queue" : "Queue"} · {queue.length} changes</label>
          {!freshFacts && queue.length > 0 && <p className="muted-note">Current queue checks unavailable; readiness has not been confirmed.</p>}
          {queue.length === 0 && <p className="muted-note">No changes queued for merge.</p>}
          <ol className="lane-detail-queue">{queue.map((entry) => {
            const fact = facts.find((f) => f.id === entry.id && f.pr === entry.pr);
            const label = fact?.cls === "ready" ? (line.blocker ? "Checks passed · waiting for lane" : "Checks passed")
              : fact?.cls === "blocked" ? "Failing checks / blocked"
              : fact?.cls === "conflict" ? "Merge conflict"
              : fact?.cls === "needs-review" ? "Needs review"
              : fact?.cls === "waiting" ? "Waiting for checks / lane" : "Readiness unconfirmed";
            return <li key={`${entry.id}-${entry.pr}`}>
              <div>{entry.pr && <><a href={`https://github.com/${repo}/pull/${entry.pr}`} target="_blank" rel="noreferrer">PR #{entry.pr}</a> · </>}
                <CardLink id={entry.id} onOpen={onOpen} />{entry.priority !== "normal" && <Chip tone="warn">{entry.priority.replace("_", " ")}</Chip>}</div>
              <span>{label}</span>
              {fact?.repair?.checks?.map((check) => <span key={check.name}>Failing: {check.url
                ? <a href={check.url} target="_blank" rel="noreferrer">{check.name}</a> : check.name}</span>)}
              {fact?.repair_task && <span>Repair: <CardLink id={fact.repair_task} onOpen={onOpen} /></span>}
            </li>;
          })}</ol>
        </section>
        {verifying.length > 0 && <details className="detail-block"><summary>Awaiting verification · {verifying.length}</summary>
          <ul className="lane-detail-queue">{verifying.map((entry) => <li key={`${entry.id}-${entry.pr}`}>
            <div>{entry.pr && <><a href={`https://github.com/${repo}/pull/${entry.pr}`} target="_blank" rel="noreferrer">PR #{entry.pr}</a> · </>}
              <CardLink id={entry.id} onOpen={onOpen} /></div><span>{entry.detail ?? "Waiting for verification"}</span>
          </li>)}</ul>
        </details>}
        <section className="detail-block"><label>Recent merge activity</label>
          {historyError && <p className="k-err">Activity unavailable: {historyError} <Btn size="sm" onClick={onRetry}>Retry</Btn></p>}
          {events.length === 0 && (lane.activity?.last_event ? <p>
            Last event: {lane.activity.last_event.kind}
            {lane.activity.last_event.pr && <> · <a href={`https://github.com/${repo}/pull/${lane.activity.last_event.pr}`} target="_blank" rel="noreferrer">PR #{lane.activity.last_event.pr}</a></>}
            {lane.activity.last_event.task_id && <> · <CardLink id={lane.activity.last_event.task_id} onOpen={onOpen} /></>}
            <span className="muted-note"> · {age(lane.activity.last_event.ts, now)} ago</span>
          </p> : <p className="muted-note">No merge events in the recent history window.</p>)}
          <ul className="lane-detail-events">{events.slice(0, 10).map((event) => <li key={event.seq}>
            <strong>{event.action.slice(6)}</strong> · {event.summary}<span className="muted-note">{age(event.ts, now)} ago</span>
          </li>)}</ul>
        </section>
        {!line.blocker && <LaneRecoveryHistory line={line} now={now} openTask={onOpen} />}
        <details className="detail-block"><summary>Required checks and configuration</summary>
          <ul>{(lane.required_workflows ?? []).map((name) => <li key={name}>{name}</li>)}</ul>
          {!lane.required_workflows?.length && <p className="muted-note">No required checks reported.</p>}
          <p>Maximum batch: {lane.burst_max ?? "not reported"}</p>
        </details>
        <details className="detail-block"><summary>Executor diagnostics</summary>
          <p>Lane record: {task.id}</p><p>Host: {lane.lease?.holder ?? lane.capable?.holder ?? "not reported"}</p>
          {lane.now_action && <p>Last executor message ({age(lane.now_action.at, now)} ago): {lane.now_action.note}</p>}
          {lane.queue_facts && <p>Queue checked {age(lane.queue_facts.at, now)} ago</p>}
        </details>
      </>}
    </aside>
  </>;
}
