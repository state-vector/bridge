import { useEffect, useMemo, useState } from "react";
import { useKb } from "../store/kb";
import { TaskDetail, SENTIMENT_CHIP } from "./TaskDetail";
import { DashboardSummary } from "./Dashboard";

const SENT_DOT: Record<string, string> = {
  going_well: "var(--green)", converging: "var(--accent)", neutral: "#3a4356",
  diverging: "var(--startup)", struggling: "var(--red)",
};

const GRADE_TONE: Record<string, string> = {
  excellent: "ok", good: "ok", fair: "amber", poor: "err",
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

const ONLINE_MS = 10 * 60_000;

interface TopRow {
  key: string;
  agent: string;
  session?: string;
  online: boolean;
  lastSeen: number | undefined;
  taskId?: string;
  goal?: string;
  status?: string;
  blockedClass?: string;
  score?: number;
  grade?: string;
  completion?: number;
  confidence?: number;
  risk?: number;
  sentiment?: string;
  will?: string;
  statusTs?: number;
  lastSignal?: number;
}

export function TopView() {
  useClock();
  const tasks = useKb((s) => s.tasks);
  const sessions = useKb((s) => s.sessions);
  const agents = useKb((s) => s.agents);
  const events = useKb((s) => s.events);
  const now = Date.now();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const rows = useMemo<TopRow[]>(() => {
    const scoreBy = new Map(agents.map((a) => [a.label, a]));
    // top = what is RUNNING right now: in_progress + blocked. todo/done/in_review are noise here.
    const inFlight = tasks.filter((t) => ["in_progress", "blocked"].includes(t.status));
    const taskRows: TopRow[] = inFlight.map((t) => {
      const meta = (t.meta ?? {}) as any;
      const p = meta.last_progress;
      const agent = t.owner || "unclaimed";
      const sc: any = scoreBy.get(agent);
      return {
        key: t.id,
        agent,
        session: meta.session ?? p?.session,
        online: sessions.some((s) => s.label === agent && now - s.last_seen_ts < ONLINE_MS),
        lastSeen: sessions.find((s) => s.label === agent)?.last_seen_ts,
        taskId: t.id,
        goal: t.title,
        status: t.status,
        blockedClass: meta.blocked?.class,
        score: sc?.score,
        grade: sc?.grade,
        completion: p?.completion_pct,
        confidence: p?.confidence_pct,
        risk: p?.risk_pct,
        sentiment: p?.sentiment,
        will: p?.will,
        statusTs: (t as any).status_ts,
        lastSignal: p?.ts ?? t.updated_ts,
      };
    });
    // idle online sessions — visible so you can see who's alive but unloaded
    const weight: Record<string, number> = { blocked: 0, in_progress: 1 };
    return taskRows.sort(
      (a, b) => (weight[a.status ?? ""] ?? 2) - (weight[b.status ?? ""] ?? 2)
        || (b.lastSignal ?? b.lastSeen ?? 0) - (a.lastSignal ?? a.lastSeen ?? 0),
    );
  }, [tasks, sessions, agents, now]);

  return (
    <div className="top-wrap">
      <DashboardSummary tasks={tasks} events={events} />
      <div className="view-head">
        <h2>Top</h2>
        <span className="muted-note">fleet processes — agent · goal · status · compliance · gauges · ages. click a row for the task.</span>
      </div>

      <div className="top-head">
        <span className="topc-agent">agent</span>
        <span className="topc-session">session</span>
        <span className="topc-goal">goal</span>
        <span className="topc-status">status</span>
        <span className="topc-score" title="behaviour compliance score, 7-day window">score</span>
        <span className="topc-gauge" title="confidence % — higher is better">conf</span>
        <span className="topc-gauge" title="risk % — lower is better">risk</span>
        <span className="topc-bar" title="completion % — shown in the bar">completion</span>
        <span className="topc-age" title="time in current column">col age</span>
        <span className="topc-age" title="time since last signal from this agent">last seen</span>
      </div>

      {rows.map((r) => (
        <div
          key={r.key}
          className={`top-row ${r.taskId ? "top-click" : ""} ${r.status === "blocked" && r.blockedClass !== "subprocess" ? "top-blocked" : ""}`}
          onClick={() => r.taskId && setSelectedTaskId(r.taskId)}
        >
          <span className="topc-agent" title={r.will ? `will: ${r.will}` : r.agent}>
            <span className={`conn conn-${r.online ? "open" : "closed"}`} title={r.online ? "online" : "offline"}>●</span>
            {r.agent}
          </span>
          <span className="topc-session top-num" title="the session working this task — agents can run many">{r.session ?? "—"}</span>
          <span className="topc-goal" title={r.will ? `will: ${r.will}` : r.goal ?? ""}>
            {r.goal ?? "—"}
            {r.will && <span className="top-will"> ▸ {r.will.slice(0, 60)}</span>}
          </span>
          <span className="topc-status">
            {r.status === "blocked" && r.blockedClass === "subprocess"
              ? <span className="st-chip st-amber" title="declared subprocess block">subprocess</span>
              : r.status && <span className={`st-chip st-${r.status === "done" ? "ok" : r.status === "blocked" ? "err" : "amber"}`}>{r.status.replace("_", " ")}</span>}
            {r.sentiment && <span className="s-dot" style={{ background: SENT_DOT[r.sentiment] ?? "#3a4356" }} title={`${r.sentiment}`} />}
            {r.sentiment && <span className={`chip ${SENTIMENT_CHIP[r.sentiment] ?? ""} top-sent`}>{r.sentiment.replace("_", " ")}</span>}
          </span>
          <span className="topc-score">
            {r.score != null && (
              <span className={`st-chip st-${GRADE_TONE[r.grade ?? "fair"] ?? "muted"} st-score`} title="behaviour compliance score">
                {r.score}
              </span>
            )}
          </span>
          <span className={`topc-gauge top-num ${pctTone(r.confidence, true)}`}>{r.confidence != null ? `${r.confidence}%` : "—"}</span>
          <span className={`topc-gauge top-num ${pctTone(r.risk, false)}`}>{r.risk != null ? `${r.risk}%` : "—"}</span>
          <span className="topc-bar">
            <span className="top-bar"><span className="top-bar-fill" style={{ width: `${Math.max(0, Math.min(100, r.completion ?? 0))}%` }} /></span>
            <span className="top-bar-label top-num num-comp">{r.completion != null ? `${r.completion}%` : "—"}</span>
          </span>
          <span className="topc-age top-num">{r.statusTs ? age(r.statusTs, now) : "—"}</span>
          <span className={`topc-age top-num age-${r.lastSignal ? staleness(r.lastSignal, now) : "dead"}`}>{age(r.lastSignal ?? r.lastSeen, now)}</span>
        </div>
      ))}

      {rows.length === 0 && (
        <p className="empty">No fleet activity — agents appear here when they claim work.</p>
      )}

      {selectedTaskId && <TaskDetail taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />}
    </div>
  );
}
