import { useEffect, useMemo, useState } from "react";
import { useKb } from "../store/kb";
import type { BoardPrefs } from "../store/kb";
import { rel } from "../lib/views";
import { TaskDetail, SENTIMENT_CHIP } from "./TaskDetail";
import { DashboardSummary } from "./Dashboard";

const COLUMNS = [
  { key: "todo", label: "To do" },
  { key: "in_progress", label: "In progress" },
  { key: "blocked", label: "Blocked" },
  { key: "done", label: "Done" },
] as const;

const SENT_DOT: Record<string, string> = {
  going_well: "var(--green)", converging: "var(--accent)", neutral: "#3a4356",
  diverging: "var(--startup)", struggling: "var(--red)",
};

/** Ticking clock — "3m 42s", re-renders every second. */
function useClock() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
}

function ageClock(ts: number | undefined, now: number): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return `${m}m ${String(r).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Staleness of last signal: fresh < 30m, warn > 30m, dead > 1h. */
function staleness(ts: number | undefined, now: number): "fresh" | "warn" | "dead" {
  if (!ts) return "dead";
  const m = (now - ts) / 60_000;
  if (m > 60) return "dead";
  if (m > 30) return "warn";
  return "fresh";
}

const STALE_LABEL: Record<string, string> = { fresh: "", warn: " ⚠", dead: " †" };

function Sparkline({ series }: { series: any[] }) {
  if (series.length < 2) return null;
  const w = 110, h = 26;
  const pts = series.slice(-16);
  const line = (key: string) => {
    const vals = pts.map((p) => p[key]);
    if (vals.every((v) => v === undefined)) return null;
    const step = w / Math.max(1, pts.length - 1);
    return pts.map((p, i) => {
      const v = p[key];
      if (v === undefined) return null;
      return `${i * step},${h - (v / 100) * (h - 2) - 1}`;
    }).filter(Boolean).join(" ");
  };
  const completion = line("completion_pct");
  const confidence = line("confidence_pct");
  if (!completion && !confidence) return null;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="sparkline">
      {completion && <polyline points={completion} fill="none" stroke="var(--accent)" strokeWidth="1.5" />}
      {confidence && <polyline points={confidence} fill="none" stroke="var(--green)" strokeWidth="1.5" strokeDasharray="3 2" />}
      {pts.map((p, i) => p.sentiment ? (
        <circle key={i} cx={(w / Math.max(1, pts.length - 1)) * i} cy={h - 3} r={2.5} fill={SENT_DOT[p.sentiment] ?? "#3a4356"} opacity={0.8} />
      ) : null)}
    </svg>
  );
}

function TaskCard({ task, prefs, now, series, onOpen }: {
  task: any; prefs: BoardPrefs; now: number; series: any[];
  onOpen: (id: string, intent?: "blocked") => void;
}) {
  const p = task.meta?.last_progress;
  const lastSignal = p?.ts ?? task.updated_ts;
  const stale = staleness(lastSignal, now);
  const active = p && now - p.ts < 120_000;
  const lastEvent = task._lastEvent;
  const mine = (series ?? []).filter((x) => x.artefact_id === task.id).slice(-12);
  // done cards freeze their total lifetime; open cards show staleness live
  const doneLifetime = task.status === "done" && task.created_ts ? ageClock(task.created_ts, now) : null;

  const attention = useMemo(() => {
    const risk = p?.risk_pct ?? 0;
    const lowConf = p?.confidence_pct !== undefined ? 100 - p.confidence_pct : 0;
    return (risk * 0.5 + lowConf * 0.5) + (stale === "dead" ? 40 : stale === "warn" ? 15 : 0);
  }, [p, stale]);

  const next: Record<string, string[]> = {
    todo: ["in_progress", "blocked"],
    in_progress: ["done", "blocked"],
    blocked: ["in_progress"],
    done: [],
  };
  const label: Record<string, string> = { in_progress: "start", done: "done" };

  return (
    <div
      className={`task-card task-${task.status} ${stale === "warn" ? "task-warn" : stale === "dead" ? "task-dead" : ""} ${active ? "task-active" : ""}`}
      onClick={() => onOpen(task.id)}
    >
      <div className="task-title" title={task.title}>
        {active && <span className="pulse" title="updated recently" />}
        {prefs.issue && <span className="task-id">{task.id}</span>}
        {task.title}
      </div>
      <div className="task-row task-status-row">
        {prefs.status && <span className={`st-chip st-${task.status === "done" ? "ok" : task.status === "blocked" ? "err" : "amber"}`}>{task.status.replace("_", " ")}</span>}
        {prefs.age && task.status !== "done" && (
          <span className={`age-chip age-${stale}`} title="time since any agent touched this card — live, orange >30m, red >1h">
            {ageClock(lastSignal, now)} since update{STALE_LABEL[stale]}
          </span>
        )}
        {prefs.age && task.status !== "done" && task.status_ts && (
          <span className="age-chip" title="time in this column">
            {ageClock(task.status_ts, now)} in column
          </span>
        )}
        {prefs.age && task.status === "done" && doneLifetime && (
          <span className="age-chip age-done" title="total lifetime, arrival → done">
            ⏱ {doneLifetime} to done
          </span>
        )}
        {prefs.owner && task.owner && <span className="task-owner">{task.owner}</span>}
      </div>

      {prefs.snippet && (() => {
        const snippet = (task.body_md ?? "").split("\n").find((l: string) => l.trim() && !l.startsWith("#")) ?? "";
        return snippet ? <div className="task-snippet">{snippet.slice(0, 140)}{snippet.length > 140 ? "…" : ""}</div> : null;
      })()}

      {prefs.tags && (task.tags ?? []).length > 0 && (
        <div className="task-tags">
          {(task.tags ?? []).map((t: string) => <span key={t} className="chip chip-scope">{t}</span>)}
        </div>
      )}

      {prefs.sentiment && (p?.sentiment || mine.length > 0) && (
        <div className="task-sentiment-row">
          {p?.sentiment && <span className={`chip ${SENTIMENT_CHIP[p.sentiment] ?? ""}`}>{p.sentiment.replace("_", " ")}</span>}
          <span className="sentiment-dots">
            {mine.slice(-8).map((s: any, i: number) => (
              <span key={i} className="s-dot" style={{ background: SENT_DOT[s.sentiment] ?? "#3a4356" }} title={`${s.sentiment} · ${rel(s.ts)}`} />
            ))}
          </span>
        </div>
      )}

      {lastEvent && (
        <div key={lastEvent.seq} className="task-ephemeral">
          {lastEvent.op === "transition" ? `▸ ${lastEvent.detail?.from?.replace("_", " ")} → ${String(lastEvent.detail?.to ?? "").replace("_", " ")}` : `▸ ${lastEvent.op}`}
          <span className="task-eph-ts">{rel(lastEvent.ts)}</span>
        </div>
      )}

      {prefs.sparkline && mine.length > 1 && <Sparkline series={mine} />}

      {prefs.pct && (p?.completion_pct !== undefined || p?.confidence_pct !== undefined || p?.risk_pct !== undefined) && (
        <div className="task-pct-row">
          {p?.completion_pct !== undefined && <span className="pct-chip pct-completion" title="completion">{p.completion_pct}%</span>}
          {p?.confidence_pct !== undefined && <span className="pct-chip pct-confidence" title="confidence">{p.confidence_pct}% conf</span>}
          {p?.risk_pct !== undefined && <span className="pct-chip pct-risk" title="risk">{p.risk_pct}% risk</span>}
          <span className="task-attention" title="attention score (risk + low confidence + staleness)">{Math.round(attention)}</span>
        </div>
      )}

      {task.status === "blocked" && task.meta?.blocked && (
        <div className="task-blocked-info">
          <div className="task-progress-note"><b>why:</b> {task.meta.blocked.reason}</div>
          <div className="task-progress-note"><b>unblocks when:</b> {task.meta.blocked.unblock_condition}</div>
        </div>
      )}

      <div className="task-actions" onClick={(e) => e.stopPropagation()}>
        {(next[task.status] ?? []).map((to) => (
          <button key={to} className="opt-btn task-btn" onClick={() => onOpen(task.id, to === "blocked" ? "blocked" : undefined)}>
            {label[to] ?? to}
          </button>
        ))}
      </div>
    </div>
  );
}

const PREF_FIELDS: Array<{ key: keyof BoardPrefs; label: string }> = [
  { key: "issue", label: "Issue #" },
  { key: "status", label: "Status" },
  { key: "age", label: "Age in column" },
  { key: "owner", label: "Owner" },
  { key: "tags", label: "Tags" },
  { key: "sentiment", label: "Sentiment row" },
  { key: "snippet", label: "Snippet" },
  { key: "sparkline", label: "Sparkline" },
  { key: "pct", label: "Completion/Confidence/Risk %" },
];

function FieldsMenu({ onClose }: { onClose: () => void }) {
  const prefs = useKb((s) => s.prefs);
  const setPref = useKb((s) => s.setPref);
  const setPrefs = useKb((s) => s.setPrefs);
  return (
    <div className="fields-menu" onClick={(e) => e.stopPropagation()}>
      <div className="fields-menu-head">
        <span>Card fields</span>
        <button className="opt-btn" onClick={() => setPrefs({ issue: true, status: true, age: true, owner: false, tags: false, sentiment: false, snippet: false, sparkline: false, pct: false })}>Compact</button>
        <button className="opt-btn" onClick={() => setPrefs({ issue: true, status: true, age: true, owner: true, tags: true, sentiment: true, snippet: true, sparkline: true, pct: true })}>Full</button>
      </div>
      {PREF_FIELDS.map((f) => (
        <label key={f.key} className="fields-check">
          <input type="checkbox" checked={prefs[f.key]} onChange={(e) => setPref(f.key, e.target.checked)} />
          {f.label}
        </label>
      ))}
      <button className="opt-btn fields-done" onClick={onClose}>Done</button>
    </div>
  );
}

type GroupBy = "agent" | "tag" | "none";

export function BoardView() {
  const tasks = useKb((s) => s.tasks) as any[];
  const sessions = useKb((s) => s.sessions);
  const events = useKb((s) => s.events);
  const series = useKb((s) => s.series);
  const prefs = useKb((s) => s.prefs);
  const conn = useKb((s) => s.conn);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [blockedIntent, setBlockedIntent] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupBy>("agent");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const openTask = (id: string, intent?: "blocked") => { setSelectedTaskId(id); setBlockedIntent(intent === "blocked"); };

  useClock(); // 1s tick — ages count up live

  const allTags = useMemo(() => {
    const t = new Set<string>();
    for (const task of tasks) for (const tag of (task.tags ?? [])) t.add(tag);
    return [...t].sort();
  }, [tasks]);

  const now = Date.now();

  const seriesByTask = useMemo(() => {
    const m: Record<string, any[]> = {};
    for (const s of series) (m[s.artefact_id] ??= []).push(s);
    return m;
  }, [series]);

  const eventsByTask = useMemo(() => {
    const m: Record<string, any> = {};
    for (const e of events) if (e.artefact_id && !m[e.artefact_id]) m[e.artefact_id] = e; // events newest-first
    return m;
  }, [events]);

  const lanes = useMemo(() => {
    const filtered = tagFilter ? tasks.filter((t) => (t.tags ?? []).includes(tagFilter)) : tasks;
    if (groupBy === "none") return [{ owner: "", tasks: filtered }];
    if (groupBy === "tag") {
      const tags = [...new Set(filtered.flatMap((t) => t.tags ?? []))];
      const lanes = tags.sort().map((tag) => ({ owner: tag, tasks: filtered.filter((t) => (t.tags ?? []).includes(tag)) }));
      lanes.push({ owner: "untagged", tasks: filtered.filter((t) => !(t.tags ?? []).length) });
      return lanes.filter((l) => l.tasks.length);
    }
    const laneOf = (t: any) => t.owner || "unassigned";
    const owners = [...new Set(filtered.map(laneOf))];
    owners.sort((a, b) => {
      const live = (l: string) => (sessions.some((s) => s.label === l && Date.now() - s.last_seen_ts < 600_000) ? 0 : 1);
      return live(a) - live(b) || a.localeCompare(b);
    });
    return owners.map((o) => ({ owner: o, tasks: filtered.filter((t) => laneOf(t) === o) }));
  }, [tasks, sessions, groupBy, tagFilter]);

  // attention sort: high risk / low confidence / stale bubble to the top (except done)
  const sortColumn = (items: any[], col: string) => {
    const arr = [...items];
    if (col === "done") return arr.sort((a, b) => b.updated_ts - a.updated_ts);
    const score = (t: any) => {
      const p = t.meta?.last_progress;
      const risk = p?.risk_pct ?? 0;
      const lowConf = p?.confidence_pct !== undefined ? 100 - p.confidence_pct : 20;
      const stale = staleness(p?.ts ?? t.updated_ts, now) === "dead" ? 35 : staleness(p?.ts ?? t.updated_ts, now) === "warn" ? 15 : 0;
      return risk * 0.45 + lowConf * 0.45 + stale;
    };
    return arr.sort((a, b) => score(b) - score(a));
  };

  const lastEventFor = (taskId: string) => eventsByTask[taskId];

  return (
    <div className="board-wrap">
      {selectedTaskId && <TaskDetail taskId={selectedTaskId} openBlocked={blockedIntent} onClose={() => setSelectedTaskId(null)} />}
      <div className="view-head">
        <h2>Board</h2>
        <span className={`conn ${conn === "open" ? "conn-open" : "conn-closed"}`}>●</span>
        <div className="board-controls">
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
            <option value="agent">by agent</option>
            <option value="tag">by tag</option>
            <option value="none">flat</option>
          </select>
          {allTags.length > 0 && (
            <select value={tagFilter ?? ""} onChange={(e) => setTagFilter(e.target.value || null)}>
              <option value="">all tags</option>
              {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
          <button className="opt-btn" onClick={(e) => { e.stopPropagation(); setFieldsOpen(!fieldsOpen); }}>fields ▾</button>
        </div>
        <span className="muted-note">{tasks.length} tasks</span>
      </div>
      {fieldsOpen && <FieldsMenu onClose={() => setFieldsOpen(false)} />}
      <DashboardSummary tasks={tasks} events={events} />
      {lanes.length === 0 && (
        <p className="empty">No tasks yet — create via MCP (create_artefact type=task) or here.</p>
      )}
      {lanes.map((lane) => {
        const laneActivity = lane.tasks.filter((t) => {
          const p = t.meta?.last_progress;
          return p && now - p.ts < 120_000;
        }).length;
        return (
          <section key={lane.owner} className="swimlane">
            <h3 className="lane-head">
              {groupBy === "tag" ? `#${lane.owner}` : lane.owner || "All"}
              <span className="muted-note"> · {lane.tasks.length}</span>
              {laneActivity > 0 && <span className="lane-live">● {laneActivity} active</span>}
            </h3>
            <div className="lane-columns">
              {COLUMNS.map((col) => {
                const items = sortColumn(lane.tasks.filter((t) => t.status === col.key), col.key);
                return (
                  <div key={col.key} className={`board-col col-${col.key}`}>
                    <div className="col-head">
                      {col.label} <span className="badge">{items.length}</span>
                    </div>
                    {items.map((t) => (
                      <TaskCard key={t.id} task={{ ...t, _lastEvent: lastEventFor(t.id) }} prefs={prefs} now={now} series={seriesByTask[t.id] ?? []} onOpen={openTask} />
                    ))}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
