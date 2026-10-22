import { useEffect, useState } from "react";

const LS = { url: "bridge.url" };

/** Board shape from /api/kb/board (subset the mobile view needs). */
interface Task {
  id: string;
  title: string;
  status: string;
  owner?: string;
  tags?: string[];
  updated_ts: number;
  meta?: Record<string, unknown>;
}
interface Board {
  tasks: Task[];
  agents?: Array<{ label: string; score: number; grade: string; hints: string[] }>;
}
interface Decision {
  id: string;
  status: "open" | "resolved";
  title: string;
  reason?: string;
  asker?: string | null;
  task_id?: string | null;
  opened_ts: number;
}

function rel(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const base = localStorage.getItem(LS.url)?.replace(/\/$/, "") || window.location.origin;
  const r = await fetch(`${base}${path}`, { credentials: "include", ...init });
  if (!r.ok) throw new Error(`${r.status}`);
  return (await r.json()) as T;
}

export function App() {
  const [tab, setTab] = useState<"fleet" | "forme">("fleet");
  const [board, setBoard] = useState<Board | null>(null);
  const [decisions, setDecisions] = useState<Decision[] | null>(null);
  const [proposed, setProposed] = useState<Array<{ id: string; title: string; created_ts: number }> | null>(null);
  const [url, setUrl] = useState(localStorage.getItem(LS.url) ?? "");
  const [msg, setMsg] = useState("");

  const load = async () => {
    try {
      const [b, evs] = await Promise.all([
        api<Board>("/api/kb/board"),
        api<{ decisions: Decision[] }>("/api/state"),
      ]);
      setBoard(b);
      setDecisions((evs.decisions ?? []).filter((d) => d.status === "open"));
    } catch {
      setMsg("hub unreachable");
    }
    try {
      const p = await api<{ artefacts: Array<{ id: string; title: string; created_ts: number }> }>("/api/kb/artefacts?type=decision&status=proposed");
      setProposed(p.artefacts ?? []);
    } catch {
      setProposed([]);
    }
  };

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, []);

  const act = async (d: Decision, action: "unblocked" | "completed") => {
    try {
      const base = localStorage.getItem(LS.url)?.replace(/\/$/, "") || window.location.origin;
      await fetch(`${base}/ingest`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-bridge-csrf": "1" },
        body: JSON.stringify({ events: [{ kind: action, task_id: d.task_id ?? d.id.replace(/^dec:[a-z]+:/, ""), note: `${action} via mobile` }] }),
      });
      setMsg(action === "completed" ? "done" : "unblocked");
      setTimeout(() => setMsg(""), 1500);
      await load();
    } catch (e) {
      setMsg(`failed: ${(e as Error).message}`);
    }
  };

  const tasks = board?.tasks ?? [];
  const counts = {
    todo: tasks.filter((t) => t.status === "todo").length,
    progress: tasks.filter((t) => t.status === "in_progress").length,
    review: tasks.filter((t) => t.status === "in_review").length,
    blocked: tasks.filter((t) => t.status === "blocked").length,
  };

  const agentActivity = (board?.agents ?? []).map((a) => {
    const mine = tasks.filter((t) => t.owner === a.label && (t.status === "in_progress" || t.status === "blocked"));
    const last = mine[0];
    return { label: a.label, active: mine.length, note: last?.meta?.last_progress ? String((last.meta.last_progress as any).note ?? "") : "" };
  });

  const forMeCount = (decisions?.length ?? 0) + (proposed?.length ?? 0);

  return (
    <div className="mb">
      <header className="mb-head">
        <span className="mb-brand">Bridge</span>
        <span className={`mb-conn ${board ? "mb-conn-open" : "mb-conn-closed"}`}>●</span>
      </header>

      <nav className="mb-tabs">
        <button className={tab === "fleet" ? "active" : ""} onClick={() => setTab("fleet")}>Fleet</button>
        <button className={tab === "forme" ? "active" : ""} onClick={() => setTab("forme")}>
          For You{forMeCount > 0 ? ` (${forMeCount})` : ""}
        </button>
      </nav>

      <main className="mb-main">
        {tab === "fleet" && (
          <>
            <div className="mb-counts">
              <div className="mb-count mb-todo"><b>{counts.todo}</b><span>todo</span></div>
              <div className="mb-count mb-progress"><b>{counts.progress}</b><span>active</span></div>
              <div className="mb-count mb-review"><b>{counts.review}</b><span>review</span></div>
              <div className="mb-count mb-blocked"><b>{counts.blocked}</b><span>blocked</span></div>
            </div>
            <div className="mb-card">
              <h2>Agents</h2>
              <div className="mb-fleet">
                {agentActivity.map((a) => (
                  <div key={a.label} className="mb-frow">
                    <span className="mb-dot" style={{ background: a.active > 0 ? "var(--green)" : "var(--text-faint)" }} />
                    <span className="mb-fname">{a.label}</span>
                    <span className="mb-fnote">{a.note || (a.active > 0 ? `${a.active} in flight` : "idle")}</span>
                    {a.active > 0 && <span className="mb-fcount">{a.active}</span>}
                  </div>
                ))}
                {agentActivity.length === 0 && <span className="mb-empty">no agents seen yet</span>}
              </div>
            </div>
            <div className="mb-card">
              <h2>In flight</h2>
              <div className="mb-fleet">
                {tasks.filter((t) => t.status === "in_progress").slice(0, 12).map((t) => (
                  <div key={t.id} className="mb-frow">
                    <span className="mb-dot" style={{ background: "var(--accent)" }} />
                    <span className="mb-fname">{t.id}</span>
                    <span className="mb-fnote">{t.title}</span>
                  </div>
                ))}
                {counts.progress === 0 && <span className="mb-empty">nothing running</span>}
              </div>
            </div>
          </>
        )}

        {tab === "forme" && (
          <>
            {(decisions ?? []).map((d) => (
              <div key={d.id} className="mb-item urgent">
                <div className="mb-chips">
                  <span className="mb-chip mb-chip-urgent">DECISION</span>
                  <span className="mb-why">{d.asker ?? "agent"} · {rel(d.opened_ts)}</span>
                </div>
                <h3>{d.title}</h3>
                {d.reason && <p className="mb-reason">{d.reason}</p>}
                <div className="mb-actions">
                  <button className="mb-btn primary" onClick={() => void act(d, "unblocked")}>Unblock</button>
                  <button className="mb-btn danger" onClick={() => void act(d, "completed")}>Done</button>
                </div>
              </div>
            ))}
            {(proposed ?? []).map((d) => (
              <div key={d.id} className="mb-item">
                <div className="mb-chips">
                  <span className="mb-chip mb-chip-needs">PROPOSAL</span>
                  <span className="mb-why">{rel(d.created_ts)} ago</span>
                </div>
                <h3>{d.title}</h3>
                <span className="mb-note">accept/reject in the web UI</span>
              </div>
            ))}
            {(decisions ?? []).length === 0 && (proposed ?? []).length === 0 && (
              <p className="mb-empty">Nothing needs you right now.</p>
            )}
          </>
        )}

        {!url && (
          <div className="mb-card">
            <h2>Connect</h2>
            <input
              style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10, color: "var(--text)", padding: "12px", font: "inherit", width: "100%" }}
              value={url}
              placeholder="https://bridge…workers.dev"
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => { localStorage.setItem(LS.url, url); void load(); }}
            />
            <span className="mb-note">hub url — sign-in happens in the web view</span>
          </div>
        )}
        {msg && <span className="mb-ok">{msg}</span>}
      </main>
    </div>
  );
}
