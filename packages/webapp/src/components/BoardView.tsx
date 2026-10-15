import { useEffect, useMemo, useState } from "react";
import { useKb } from "../store/kb";
import { rel } from "../lib/views";
import { TaskDetail, SENTIMENT_CHIP } from "./TaskDetail";
import { DashboardSummary } from "./Dashboard";

const COLUMNS = [
  { key: "todo", label: "To do" },
  { key: "in_progress", label: "In progress" },
  { key: "blocked", label: "Blocked" },
  { key: "done", label: "Done" },
] as const;

function TaskCard({ task, onOpen }: { task: any; onOpen: (id: string, intent?: "blocked") => void }) {
  const progress = useKb((s) => s.progress);
  const p = task.meta?.last_progress;
  const recent = progress.filter((x) => x.artefact_id === task.id).slice(0, 2);
  const active = p && Date.now() - p.ts < 120_000;
  const next: Record<string, string[]> = {
    todo: ["in_progress", "blocked"],
    in_progress: ["done", "blocked"],
    blocked: ["in_progress"],
    done: [],
  };
  const label: Record<string, string> = { in_progress: "start", done: "done" };
  return (
    <div className={`task-card task-${task.status} ${active ? "task-active" : "task-clickable"}`} onClick={() => onOpen(task.id)}>
      <div className="task-title">
        {active && <span className="pulse" />}
        {task.title}
      </div>
      {(() => {
        const snippet = (task.body_md ?? "").split("\n").find((l: string) => l.trim() && !l.startsWith("#")) ?? "";
        return snippet ? <div className="task-snippet">{snippet.slice(0, 140)}{snippet.length > 140 ? "…" : ""}</div> : null;
      })()}
      {recent.map((x) => (
        <div key={x.seq} className="task-progress-line">
          <span className={`chip ${SENTIMENT_CHIP[x.detail?.sentiment ?? ""] ?? ""}`}>
            {x.detail?.sentiment ?? "progress"}
          </span>
          <span className="task-progress-note">{x.detail?.note}</span>
        </div>
      ))}
      {p && (
        <div className="task-progress-line">
          <span className={`chip ${SENTIMENT_CHIP[p.sentiment] ?? ""}`}>{p.sentiment}</span>
          <span className="task-progress-note">{p.note}</span>
        </div>
      )}
      {task.status === "blocked" && task.meta?.blocked && (
        <div className="task-blocked-info">
          <div className="task-progress-note"><b>why:</b> {task.meta.blocked.reason}</div>
          <div className="task-progress-note"><b>unblocks when:</b> {task.meta.blocked.unblock_condition}</div>
        </div>
      )}
      <div className="task-meta">
        {task.id} · {rel(task.updated_ts)}
        {task.owner ? ` · ${task.owner}` : ""}
        {(task.tags ?? []).length > 0 && ` · ${(task.tags ?? []).join(", ")}`}
      </div>
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


type GroupBy = "agent" | "tag" | "project" | "none";

export function BoardView() {
  const tasks = useKb((s) => s.tasks) as any[];
  const sessions = useKb((s) => s.sessions);
  const events = useKb((s) => s.events);
  const conn = useKb((s) => s.conn);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [blockedIntent, setBlockedIntent] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupBy>("agent");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const openTask = (id: string, intent?: "blocked") => { setSelectedTaskId(id); setBlockedIntent(intent === "blocked"); };

  const allTags = useMemo(() => {
    const t = new Set<string>();
    for (const task of tasks) for (const tag of (task.tags ?? [])) t.add(tag);
    return [...t].sort();
  }, [tasks]);  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  // lanes by agent (default) / tag / flat
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

  const lastEventFor = (taskId: string) => events.find((e) => e.artefact_id === taskId);

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
        </div>
        <span className="muted-note">{tasks.length} tasks</span>
      </div>
      <DashboardSummary tasks={tasks} events={events} />
      {lanes.length === 0 && (
        <p className="empty">No tasks yet — create via MCP (create_artefact type=task) or here.</p>
      )}
      {lanes.map((lane) => (
        <section key={lane.owner} className="swimlane">
          <h3 className="lane-head">
            {groupBy === "tag" ? `#${lane.owner}` : lane.owner || "All"}
            <span className="muted-note"> · {lane.tasks.length}</span>
          </h3>
          <div className="lane-columns">
            {COLUMNS.map((col) => {
              const items = lane.tasks.filter((t) => t.status === col.key);
              return (
                <div key={col.key} className={`board-col col-${col.key}`}>
                  <div className="col-head">
                    {col.label} <span className="badge">{items.length}</span>
                  </div>
                  {items.map((t) => {
                    const ev = lastEventFor(t.id);
                    return (
                      <div key={t.id}>
                        <TaskCard task={t} onOpen={openTask} />
                        {ev && <div className="task-progress">▸ {ev.op}{ev.detail?.to ? ` → ${ev.detail.to}` : ""} · {rel(ev.ts)}</div>}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
