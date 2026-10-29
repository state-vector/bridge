import { useEffect, useMemo, useState } from "react";
import { useKb } from "../server/kbStore";
import { TaskDetail, SENTIMENT_CHIP } from "./TaskDetail";
import { DashboardSummary } from "./Dashboard";
import { AskBand, useHumanAsks, AskEntries, type AskEntry } from "./AskBand";
import { TagThemeBar, TagChips, useTagTheme } from "./TagFilter";
import { kindOf, isTimeoutBlock, unblockTwinIndex, activeUnblockTwinOf, parkClassOf, externalGateOf } from "../server/views";
import { Chip, Btn, type ChipTone } from "./index-kit";

const SENT_DOT: Record<string, string> = {
  going_well: "var(--green)", converging: "var(--accent)", neutral: "#3a4356",
  diverging: "var(--startup)", struggling: "var(--red)",
};

const GRADE_TONE: Record<string, ChipTone> = {
  excellent: "ok", good: "ok", fair: "warn", poor: "err",
};

/** Consistent pct colouring: higher-is-better gauges green/amber/red at 70/40;
 *  lower-is-better (risk) red/amber/green at 50/20. */
function pctTone(v: number | undefined, higherIsBetter: boolean): string {
  if (v == null) return "";
  if (higherIsBetter) return v >= 70 ? "pos" : v >= 40 ? "warn" : "bad";
  return v < 20 ? "pos" : v < 50 ? "warn" : "bad";
}

/** Ticking clock — re-renders every second so ages stay live. */
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

function staleness(ts: number | undefined, now: number): "fresh" | "warn" | "dead" {
  if (!ts) return "dead";
  const m = (now - ts) / 60_000;
  if (m > 60) return "dead";
  if (m > 30) return "warn";
  return "fresh";
}

/** Status dot colour — scannable status on the LEFT edge (2026-10-24, Ray):
 *  green = in progress, red = blocked, amber = in review. Duplicates the
 *  status column by design; liveness stays readable in "last signal". */
const STATUS_DOT_TITLE: Record<string, string> = {
  in_progress: "in progress",
  blocked: "blocked",
  in_review: "in review",
};

interface TopRow {
  key: string;
  agent: string;
  session?: string;
  lastSeen: number | undefined;
  taskId?: string;
  goal?: string;
  status?: string;
  blockedClass?: string;
  subprocess?: boolean;
  pinned?: boolean;
  boosted?: boolean;
  kind?: string;
  tags?: string[];
  partOf?: string;
  score?: number;
  grade?: string;
  completion?: number;
  confidence?: number;
  risk?: number;
  context?: number;
  sentiment?: string;
  will?: string;
  unblock?: string;
  askPending?: string;
  statusTs?: number;
  lastSignal?: number;
  /** PR provenance (BR#3287), stamped board-side by provenanceSweep —
   *  rendered on in-flight rows as a PR link + verifier badge (BR#3307). */
  prov?: { repo: string; pr: number; verdict_id?: string | null; session?: string | null; signer?: string };
}

/** Compact gateway strip: ONLY gateway identity sessions (dispatch-<gw>),
 *  never dispatched agent sessions — those are rows in the table, not
 *  infrastructure. Per-task dispatch sessions only feed the in-flight count. */
export function TopView({ openTask }: { openTask?: (id: string) => void }) {
  const openDetails = (id: string) => (openTask ? openTask(id) : setSelectedTaskId(id));
  useClock();
  const conn = useKb((s) => s.conn);
  const refreshKb = useKb((s) => s.refresh);
  const tasks = useKb((s) => s.tasks);
  const sessions = useKb((s) => s.sessions);
  const agents = useKb((s) => s.agents);
  const events = useKb((s) => s.events);
  const now = Date.now();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);



  const rows = useMemo<TopRow[]>(() => {
    const scoreBy = new Map(agents.map((a) => [a.label, a]));
    // top = what is RUNNING right now, plus ONLY the blocked rows a human or
    // an active duty can move (2026-10-24 spec, Ray): in_progress always;
    // blocked only with a pending human ask (meta.awaiting_ask) or a live
    // "Unblock:" twin. Churn/rework machine parks and blocked-with-no-lever
    // rows live in Backlog (TIMEOUT / blocked groups), not here.
    const twinIdx = unblockTwinIndex(tasks as any[]);
    const admitted = (tasks as any[]).filter((t) =>
      t.status === "in_progress"
      || (t.status === "blocked"
        && !isTimeoutBlock(t)
        && (t.meta?.awaiting_ask?.ask_id || activeUnblockTwinOf(t, twinIdx))),
    );
    const taskRows: TopRow[] = admitted.map((t) => {
      const meta = (t.meta ?? {}) as any;
      const p = meta.last_progress;
      const agent = t.owner || "unclaimed";
      const sc: any = scoreBy.get(agent);
      const sessionSeen = sessions.find((s) => s.label === agent)?.last_seen_ts;
      // task-scoped signal: when THIS task was last touched by anyone (agent
      // log, transition). Deliberately excludes the label's session ping — a
      // runner or cron touching the hub must not make idle tasks look alive.
      // blocked cards: the completion column shows the EXIT CONDITION — the
      // actionable part of being blocked. That is the "completion" of a block.
      const unblock: string | undefined = meta.blocked?.unblock_condition;
      const askPending: string | undefined = meta.awaiting_ask?.ask_id;
      return {
        key: t.id,
        agent,
        session: meta.session ?? p?.session,
        lastSeen: sessionSeen,
        taskId: t.id,
        goal: t.title,
        status: t.status,
        blockedClass: meta.blocked?.class,
        subprocess: !!meta.subprocess,
        pinned: !!meta.pinned,
        boosted: !!meta.boosted,
        kind: kindOf(t as any),
        tags: (t as any).tags,
        partOf: (t as any).part_of,
        score: sc?.score,
        grade: sc?.grade,
        completion: p?.completion_pct,
        confidence: p?.confidence_pct,
        risk: p?.risk_pct,
        context: p?.context_pct,
        sentiment: p?.sentiment,
        will: p?.will,
        unblock: unblock?.slice(0, 140),
        askPending,
        statusTs: (t as any).status_ts,
        lastSignal: Math.max(p?.ts ?? 0, (t as any).updated_ts ?? 0),
        prov: meta.provenance?.repo ? {
          repo: meta.provenance.repo,
          pr: meta.provenance.pr,
          verdict_id: meta.provenance.verdict_id,
          session: meta.provenance.session,
          signer: meta.provenance.signer,
        } : undefined,
      };
    });
    // the live unblock twin is itself in_progress → already in the set; force
    // it to NEST under its blocked parent (part_of when the server set it,
    // title-convention match otherwise) so no blocked row stands alone.
    const rowById = new Map(taskRows.map((r) => [r.taskId ?? r.key, r]));
    const idByTitle = new Map((tasks as any[]).map((t) => [t.title, t.id]));
    for (const twin of twinIdx.byPartOf.values()) {
      const tr = rowById.get(twin.id);
      if (tr) tr.partOf = twin.part_of;
    }
    for (const [parentTitle, twin] of twinIdx.byTitle) {
      const tr = rowById.get(twin.id);
      const pid = idByTitle.get(parentTitle);
      if (tr && pid && !tr.partOf) tr.partOf = pid;
    }
    // pinned first (meta.pinned), then blocked, then in_progress;
    // within a bucket, most recent signal first
    const weight: Record<string, number> = { blocked: 0, in_progress: 1 };
    return taskRows.sort(
      (a, b) => (b.boosted ? 1 : 0) - (a.boosted ? 1 : 0)
        || (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
        || (weight[a.status ?? ""] ?? 2) - (weight[b.status ?? ""] ?? 2)
        || (b.lastSignal ?? b.lastSeen ?? 0) - (a.lastSignal ?? a.lastSeen ?? 0),
    );
  }, [tasks, sessions, agents, now]);

  // tag themes: counts over ALL open work (not just in-flight), filter applies here
  const tagTheme = useTagTheme(tasks.filter((t) => !["done", "superseded"].includes(t.status)));

  // tree view: children (verify / unblock / analysis / impl children) nested
  // under their parent task — you can see at a glance whether the confirm
  // round is running, parked, or missing. Orphan children (parent not in the
  // in-flight set) render flat at the bottom.
  const treeRows = useMemo<Array<{ row: TopRow; depth: number }>>(() => {
    const byId = new Map(rows.map((r) => [r.taskId ?? r.key, r]));
    const childrenOf = new Map<string, TopRow[]>();
    const roots: TopRow[] = [];
    for (const r of rows) {
      if (r.partOf && byId.has(r.partOf)) {
        const list = childrenOf.get(r.partOf) ?? [];
        list.push(r);
        childrenOf.set(r.partOf, list);
      } else {
        roots.push(r);
      }
    }
    const out: Array<{ row: TopRow; depth: number }> = [];
    const walk = (r: TopRow, depth: number) => {
      out.push({ row: r, depth });
      for (const c of childrenOf.get(r.taskId ?? r.key) ?? []) walk(c, depth + 1);
    };
    for (const r of roots) walk(r, 0);
    return out.filter(({ row }) => tagTheme.passes({ tags: row.tags }));
  }, [rows, tagTheme]);

  // human-ask plane: exactly-once placement — nested under a visible subject,
  // else the residual band (2026-10-23 design)
  const visibleTaskIds = useMemo(() => new Set(rows.map((r) => r.taskId ?? r.key)), [rows]);
  const humanAsks = useHumanAsks(visibleTaskIds);
  const openAskDetails = (id: string) => (openTask ? openTask(id) : setSelectedTaskId(id));
  const bumpAsks = () => { void refreshKb(); };
  useEffect(() => {
    if (useKb.getState().awaitingHuman !== humanAsks.total) useKb.setState({ awaitingHuman: humanAsks.total });
  }, [humanAsks.total]);

  // BR#2893 board split: top = actionable (the table above) / sin-bin (churn
  // parks — the watchdog drains them automatically, a human can release one
  // early) / awaiting-external (a NAMED outside gate: ask, date, GitHub lane,
  // red-main — each rendered with its owner + next action).
  const sinBin = useMemo(
    () => (tasks as any[]).filter((t) => parkClassOf(t) === "sin-bin")
      .sort((a, b) => (a.status_ts ?? a.updated_ts ?? 0) - (b.status_ts ?? b.updated_ts ?? 0)),
    [tasks],
  );
  const externalGates = useMemo(
    () => (tasks as any[]).filter((t) => parkClassOf(t) === "external" && !visibleTaskIds.has(t.id))
      .sort((a, b) => (b.updated_ts ?? 0) - (a.updated_ts ?? 0)),
    [tasks, visibleTaskIds],
  );
  const releaseSinbin = async (id: string) => {
    try {
      await useKb.getState().transition(id, "todo", { note: "released from sin-bin — human override" });
      void refreshKb();
    } catch { /* park stands (e.g. an ask landed meanwhile) — the card stays blocked */ }
  };
  const sinOpenDefault = sinBin.length > 0 && sinBin.length <= 5;
  const [sinOpen, setSinOpen] = useState<boolean | null>(null);

  return (
    <div className="top-wrap">
      <DashboardSummary tasks={tasks} events={events} />
      <AskBand asks={humanAsks} onChanged={bumpAsks} openDecision={openAskDetails} />
      <div className="view-head">
        <h2>Top</h2>
        <span className="muted-note">fleet processes — status dot · agent · gauges · ages. actionable work on top; churn parks collapse into the sin-bin (the watchdog drains them; release one early when you disagree); named external gates list their owner + next action.</span>
      </div>
      <TagThemeBar theme={tagTheme} />

      <div className="ktable-head top-head">
        <span className="topc-task" title="task id">task id</span>
        <span className="topc-agent">machine / agent</span>
        <span className="topc-session">session</span>
        <span className="topc-goal">task</span>
        <span className="topc-status">status</span>
        <span className="topc-score" title="behaviour compliance score, 7-day window">score</span>
        <span className="topc-gauge" title="confidence % — higher is better">conf</span>
        <span className="topc-gauge" title="risk % — lower is better">risk</span>
        <span className="topc-gauge" title="context % — how full the agent's window is">ctx</span>
        <span className="topc-bar" title="completion % — shown in the bar">completion</span>
        <span className="topc-age" title="time in the current status">in col</span>
        <span className="topc-age" title="time since the agent's last signal on this task">last signal</span>
      </div>

      {treeRows.flatMap(({ row: r, depth }) => {
        const asks: AskEntry[] = humanAsks.byTask.get(r.taskId ?? r.key) ?? [];
        // every blocked row carries a child: its live unblock twin (nested via
        // partOf), the human question (nested ask rows below), or — when the
        // ask node isn't renderable (e.g. an answered GO awaiting execution) —
        // a synthetic "awaiting you" child. No blocked row stands alone.
        const needsAwaitChild = depth === 0 && r.status === "blocked"
          && asks.length === 0 && !treeRows.some((x) => x.row.partOf === (r.taskId ?? r.key));
        return [
        <div
          key={r.key}
          className={`ktable-row top-row ${r.taskId ? "top-click" : ""} ${depth > 0 ? "ktable-child" : ""}`}
          style={depth > 0 ? { borderLeft: "2px solid var(--line)", borderRadius: "0 8px 8px 0" } : undefined}
          onClick={() => r.taskId && openDetails(r.taskId)}
        >
          <span className="topc-task" title={r.taskId ?? ""}>
            <span
              className={`top-sdot sd-${r.status ?? "none"}`}
              title={STATUS_DOT_TITLE[r.status ?? ""] ?? r.status ?? ""}
            />
            {r.taskId && <span className="task-id top-task-id">{r.taskId}</span>}
          </span>
          <span className="topc-agent" title={r.will ? `will: ${r.will}` : r.agent}>
            {r.agent}
          </span>
          <span className="topc-session top-num" title="the session working this task — agents can run many">{r.session ?? "—"}</span>
          <span className="topc-goal" title={r.will ? `will: ${r.will}` : r.goal ?? ""}>
            {depth > 0 && <span className="tree-branch" title={`child of ${r.partOf ?? "parent"}`}>└─ </span>}
            <span className={`kind-pill kp-${r.kind ?? "impl"}`} title="task kind">{r.kind ?? "impl"}</span>
            {r.goal ?? "—"}
            <TagChips tags={r.tags} />
            {r.prov ? (
              <>
                {" "}
                <a
                  className="topc-prov"
                  href={`https://github.com/${r.prov.repo}/pull/${r.prov.pr}`}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  title={`PR provenance (BR#3287): ${r.prov.repo}#${r.prov.pr}${r.prov.session ? ` · session ${r.prov.session}` : ""} · signer ${r.prov.signer ?? "unknown"}`}
                >
                  <Chip tone="scope">PR #{r.prov.pr}</Chip>
                </a>
                <Chip
                  tone={r.prov.verdict_id ? "ok" : "warn"}
                  title={r.prov.verdict_id
                    ? `verified by ${r.prov.verdict_id}${r.prov.session ? ` (${r.prov.session})` : ""}`
                    : "merged without an accepted verify verdict on the head sha"}
                >
                  {r.prov.verdict_id ? "verified" : "unverified"}
                </Chip>
              </>
            ) : (
              <>
                {" "}
                <Chip
                  tone="muted"
                  className="topc-prov-none"
                  title="no PR provenance stamped (BR#3287): untracked merge, non-bridge work, or the sweep has not stamped this row yet — absence is itself a signal"
                >
                  no bridge provenance
                </Chip>
              </>
            )}
            {r.will && <span className="top-will"> ▸ {r.will.slice(0, 60)}</span>}
          </span>
          <span className="topc-status">
            {r.status === "in_progress" && (
              <Chip tone="live" pill title="in progress — the last log line says what it is running">
                in progress
              </Chip>
            )}
            {r.status && r.status !== "in_progress" && (
              <Chip pill tone={r.status === "done" ? "ok" : r.status === "blocked" ? "err" : "warn"}>{r.status.replace("_", " ")}</Chip>
            )}
            {r.sentiment && <span className="s-dot" style={{ background: SENT_DOT[r.sentiment] ?? "#3a4356" }} title={`agent mood: ${r.sentiment.replace("_", " ")}`} />}
            {r.sentiment && <Chip tone={SENTIMENT_CHIP[r.sentiment] ?? "neutral"} className="top-sent">{r.sentiment.replace("_", " ")}</Chip>}
          </span>
          <span className="topc-score">
            {r.score != null && (
              <Chip pill tone={GRADE_TONE[r.grade ?? "fair"] ?? "muted"} className="st-score" title="behaviour compliance score">
                {r.score}
              </Chip>
            )}
          </span>
          <span className={`topc-gauge top-num ${pctTone(r.confidence, true)}`}>{r.confidence != null ? `${r.confidence}%` : "—"}</span>
          <span className={`topc-gauge top-num ${pctTone(r.risk, false)}`}>{r.risk != null ? `${r.risk}%` : "—"}</span>
          <span className={`topc-gauge top-num ${pctTone(r.context, false)}`} title="context % — how full the agent's window is; high values mean it should hand off soon">{r.context != null ? `${r.context}%` : "—"}</span>
          <span className="topc-bar">
            {r.status === "blocked" && r.unblock ? (
              <span className="top-unblock" title={`blocked — unblocks when: ${r.unblock}`}>
                <Chip tone="scope">exit</Chip> {r.unblock}
              </span>
            ) : r.status === "blocked" && r.askPending ? (
              <span className="muted-note">blocked on a question — answered below</span>
            ) : (
              <>
                <span className="top-bar"><span className="top-bar-fill" style={{ width: `${Math.max(0, Math.min(100, r.completion ?? 0))}%` }} /></span>
                <span className="top-bar-label top-num num-comp">{r.completion != null ? `${r.completion}%` : "—"}</span>
              </>
            )}
          </span>
          <span className="topc-age top-num">{r.statusTs ? age(r.statusTs, now) : "—"}</span>
          <span className={`topc-age top-num age-${r.lastSignal ? staleness(r.lastSignal, now) : "dead"}`}>{age(r.lastSignal ?? r.lastSeen, now)}</span>
        </div>,
        asks.length > 0 && (
          <div key={`${r.key}-asks`} className="ask-band ask-band-nested-group">
            <AskEntries entries={asks} onDone={bumpAsks} openDecision={openAskDetails} nested />
          </div>
        ),
        needsAwaitChild && (
          <div key={`${r.key}-await`} className="ktable-child top-await-note" onClick={() => r.taskId && openDetails(r.taskId)}>
            <Chip tone="needs">awaiting you</Chip>
            <span className="top-await-text" title={r.unblock ?? r.askPending ?? ""}>
              {r.unblock || r.askPending || "human input required — open the card"}
            </span>
          </div>
        ),
        ];
      })}

      {sinBin.length > 0 && (
        <details
          className="top-parked sinbin"
          open={sinOpen ?? sinOpenDefault}
          onToggle={(e) => setSinOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary>
            Sin-bin — churn parks
            <span className="muted-note">
              {" "}· {sinBin.length} · oldest {age(sinBin[0]?.status_ts ?? sinBin[0]?.updated_ts, now)} in park — the watchdog demotes these automatically (retry instructions, dead asks); release early if you disagree
            </span>
          </summary>
          <div className="backlog-list">
            {sinBin.map((t: any) => {
              const attempts = t.meta?.attempt?.attempts ?? 0;
              return (
                <div key={t.id} className="ktable-row backlog-row backlog-parked" onClick={() => openDetails(t.id)}>
                  <span className="backlog-rank" title="churn/rework park — drains automatically on the next watchdog tick">⏱</span>
                  <span className="backlog-id">{t.id}</span>
                  <span className="backlog-main">
                    <span className={`kind-pill kp-${kindOf(t)}`}>{kindOf(t)}</span>
                    <span className="backlog-title">{t.title}</span>
                    <span className="backlog-why"><Chip tone="urgent">why</Chip> {(t.meta?.blocked?.reason ?? "").slice(0, 110)}</span>
                  </span>
                  <span className="backlog-meta">
                    {attempts > 0 && <Chip tone="urgent" title={`attempted ${attempts}x`}>×{attempts}</Chip>}
                    {t.owner ? <span title={`parked under ${t.owner}`}>{t.owner}</span> : <span className="backlog-pool">pool</span>}
                    <Btn
                      size="sm"
                      className="sinbin-release"
                      title="release now — pushes the card back to the todo pool ahead of the watchdog's automatic drain"
                      onClick={(e) => { e.stopPropagation(); void releaseSinbin(t.id); }}
                    >
                      release
                    </Btn>
                  </span>
                  <span className="backlog-age top-num" title="time in park">{age(t.status_ts ?? t.updated_ts, now)}</span>
                </div>
              );
            })}
          </div>
        </details>
      )}

      {externalGates.length > 0 && (
        <div className="top-parked awaiting-external">
          <div className="view-head backlog-group-head">
            <h2>Awaiting external input</h2>
            <span className="muted-note">{externalGates.length} · named outside gates — the watchdog exempts these from the age drain</span>
          </div>
          <div className="backlog-list">
            {externalGates.map((t: any) => {
              const gate = externalGateOf(t);
              return (
                <div key={t.id} className="ktable-row backlog-row" onClick={() => openDetails(t.id)}>
                  <span className="backlog-rank" title={`external gate — owner: ${gate.owner}`}>⚑</span>
                  <span className="backlog-id">{t.id}</span>
                  <span className="backlog-main">
                    <span className={`kind-pill kp-${kindOf(t)}`}>{kindOf(t)}</span>
                    <span className="backlog-title">{t.title}</span>
                    <span className="backlog-why"><Chip tone="scope">{gate.owner}</Chip> {gate.next}</span>
                  </span>
                  <span className="backlog-meta">{t.owner || "—"}</span>
                  <span className="backlog-age top-num" title="time in park">{age(t.status_ts ?? t.updated_ts, now)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {treeRows.length === 0 && sinBin.length === 0 && externalGates.length === 0 && (
        <p className="empty">{conn === "closed" ? "Hub unreachable — check your sign-in / hub url." : "No fleet activity — agents appear here when they claim work. Churn parks drain to the sin-bin; true external gates list their owner below."}</p>
      )}

      {selectedTaskId && <TaskDetail taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} onOpen={setSelectedTaskId} />}
    </div>
  );
}
