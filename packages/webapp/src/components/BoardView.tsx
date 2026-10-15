import { useMemo } from "react";
import { useKb } from "../store/kb";
import { rel } from "../lib/views";

const COLUMNS = [
  { key: "todo", label: "To do" },
  { key: "in_progress", label: "In progress" },
  { key: "blocked", label: "Blocked" },
  { key: "done", label: "Done" },
] as const;

function TaskCard({ task }: { task: any }) {
  const transition = useKb((s) => s.transition);
  const next: Record<string, string[]> = {
    todo: ["in_progress", "blocked"],
    in_progress: ["done", "blocked"],
    blocked: ["in_progress"],
    done: [],
  };
  const label: Record<string, string> = { in_progress: "start", done: "done", blocked: "block" };
  return (
    <div className={`task-card task-${task.status}`}>
      <div className="task-title">{task.title}</div>
      <div className="task-meta">
        {task.id} · {rel(task.updated_ts)}
        {task.owner ? ` · ${task.owner}` : ""}
      </div>
      <div className="task-actions">
        {(next[task.status] ?? []).map((to) => (
          <button key={to} className="opt-btn task-btn" onClick={() => void transition(task.id, to)}>
            {label[to] ?? to}
          </button>
        ))}
      </div>
    </div>
  );
}

export function BoardView() {
  const tasks = useKb((s) => s.tasks);
  const sessions = useKb((s) => s.sessions);
  const events = useKb((s) => s.events);
  const conn = useKb((s) => s.conn);

  // swimlane = owning agent label; sessions give us agent → live session names
  const lanes = useMemo(() => {
    const laneOf = (t: any) => t.owner || "unassigned";
    const owners = [...new Set(tasks.map(laneOf))];
    owners.sort((a, b) => {
      const live = (l: string) => (sessions.some((s) => s.label === l && Date.now() - s.last_seen_ts < 600_000) ? 0 : 1);
      return live(a) - live(b) || a.localeCompare(b);
    });
    return owners.map((o) => ({ owner: o, tasks: tasks.filter((t) => laneOf(t) === o) }));
  }, [tasks, sessions]);

  const lastEventFor = (taskId: string) => events.find((e) => e.artefact_id === taskId);

  return (
    <div className="board-wrap">
      <div className="view-head">
        <h2>Board</h2>
        <span className={`conn ${conn === "open" ? "conn-open" : "conn-closed"}`}>●</span>
        <span className="muted-note">lanes: agent · {sessions.length} sessions seen</span>
      </div>
      {lanes.length === 0 && (
        <p className="empty">No tasks yet — create via MCP (create_artefact type=task) or here.</p>
      )}
      {lanes.map((lane) => (
        <section key={lane.owner} className="swimlane">
          <h3 className="lane-head">
            {lane.owner}
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
                        <TaskCard task={t} />
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
