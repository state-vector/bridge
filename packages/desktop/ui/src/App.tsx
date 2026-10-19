import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Bridge gateway UI. Two pages:
 *  Main — runner status, live dispatch log, link to the full web UI.
 *  Settings — hub, agents (backend + profile + model), concurrency.
 *  Settings apply by restarting the dispatch loop with the merged config. */

interface Activity {
  ts: number;
  kind: string; // info | dispatch | finish | error
  msg: string;
}
interface InFlight {
  task_id: string;
  task_title: string;
  started_ms: number;
  last_note: string;
}
interface Snapshot {
  running: boolean;
  url: string | null;
  workspace: string | null;
  label: string | null;
  agent: string | null;
  workdir: string | null;
  max_sessions: number;
  in_flight: InFlight[];
  activity: Activity[];
}
/** Mirrors dispatch.rs DispatchConfig (serde). */
interface Cfg {
  url: string;
  token: string;
  workdir: string;
  agent: string | null;
  poll_secs: number;
  timeout_mins: number;
  opencode_bin: string;
  label: string | null;
  ws: string | null;
  max_sessions: number;
  isolate: boolean;
  model: string | null;
  backend: string | null;
}

const KIND_CLASS: Record<string, string> = {
  dispatch: "gw-kind-dispatch",
  finish: "gw-kind-finish",
  error: "gw-kind-error",
  info: "gw-kind-info",
};

function ts(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function App() {
  const [page, setPage] = useState<"main" | "settings">("main");
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [msg, setMsg] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  // settings state
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [maxSessions, setMaxSessions] = useState(1);
  const [backend, setBackend] = useState("opencode");
  const [agent, setAgent] = useState("");
  const [model, setModel] = useState("");
  const [hubUrl, setHubUrl] = useState("");
  const [applyMsg, setApplyMsg] = useState("");

  const pull = useCallback(async () => {
    try {
      const s = await invoke<Snapshot>("dispatch_snapshot");
      setSnap(s);
    } catch {
      setMsg("not running inside the desktop shell — invoke unavailable");
    }
  }, []);

  const loadCfg = useCallback(async () => {
    try {
      const c = await invoke<Cfg | null>("dispatch_config");
      if (c) {
        setCfg(c);
        setMaxSessions(c.max_sessions);
        setBackend(c.backend ?? "opencode");
        setAgent(c.agent ?? "");
        setModel(c.model ?? "");
        setHubUrl(c.url);
      }
    } catch { /* no shell */ }
  }, []);

  useEffect(() => {
    void pull();
    void loadCfg();
    const t = setInterval(() => void pull(), 2000);
    return () => clearInterval(t);
  }, [pull, loadCfg]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = 0;
  }, [snap?.activity.length]);

  const toggleRun = async () => {
    try {
      if (snap?.running) await invoke("dispatch_stop");
      else await invoke("dispatch_start");
      await pull();
    } catch (e) {
      setMsg(String(e));
    }
  };

  const openWeb = () => {
    if (snap?.url) window.open(snap.url, "_blank");
  };

  const applySettings = async () => {
    if (!cfg) {
      setApplyMsg("no config yet — start once (pairs via BRIDGE_URL), then edit");
      return;
    }
    const next: Cfg = {
      ...cfg,
      url: hubUrl.trim().replace(/\/$/, "") || cfg.url,
      max_sessions: Math.max(1, maxSessions),
      backend: backend || null,
      agent: agent.trim() || null,
      model: model.trim() || null,
    };
    setApplyMsg("applying…");
    try {
      const wasRunning = snap?.running ?? false;
      if (wasRunning) await invoke("dispatch_stop");
      await invoke("dispatch_start", { config: next });
      await pull();
      await loadCfg();
      setApplyMsg(wasRunning ? "applied — runner restarted" : "saved — starts on next run");
      setTimeout(() => setApplyMsg(""), 3000);
    } catch (e) {
      setApplyMsg(`failed: ${String(e)}`);
    }
  };

  const activity = snap?.activity ?? [];

  return (
    <div className="gw">
      <header className="gw-head">
        <span className="gw-brand">bridge<span className="cursor" /></span>
        <nav className="gw-nav">
          <button className={page === "main" ? "active" : ""} onClick={() => setPage("main")}>Main</button>
          <button className={page === "settings" ? "active" : ""} onClick={() => setPage("settings")}>Settings</button>
        </nav>
        <span className="gw-user">{snap?.label ?? ""}</span>
      </header>

      {page === "main" && (
        <main className="gw-main">
          <div className="gw-card">
            <div className="gw-row">
              <span className={`gw-conn ${snap?.running ? "gw-conn-open" : "gw-conn-closed"}`}>
                ● {snap?.running ? `running${snap.workspace ? ` · ${snap.workspace}` : ""}` : "stopped"}
              </span>
              {snap?.running
                ? <button className="gw-btn gw-btn-stop" onClick={() => void toggleRun()}>Stop</button>
                : <button className="gw-btn gw-btn-run" onClick={() => void toggleRun()}>Start</button>}
              <span className="gw-note">
                {snap?.max_sessions ?? 1} concurrent{snap?.workdir ? ` · ${snap.workdir}` : ""}
              </span>
              {msg && <span className="gw-err">{msg}</span>}
              <a className="gw-link" style={{ marginLeft: "auto" }} href="#" onClick={(e) => { e.preventDefault(); openWeb(); }}>
                open full board ↗
              </a>
            </div>
            {(snap?.in_flight.length ?? 0) > 0 && (
              <div className="gw-inflight">
                {snap!.in_flight.map((f) => (
                  <div key={f.task_id} className="gw-agent">
                    <span className="gw-agent-name">{f.task_id}</span>
                    <span className="gw-fnote">{f.last_note || "working"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="gw-card">
            <h2>Dispatch log</h2>
            <div className="gw-log" ref={logRef}>
              {activity.length === 0 && <span className="gw-log-empty">no activity yet — start the runner</span>}
              {activity.map((a, i) => (
                <div key={`${a.ts}-${i}`} className="gw-line">
                  <span className="gw-ts">{ts(a.ts)}</span>
                  <span className={KIND_CLASS[a.kind] ?? "gw-kind-info"}>{a.msg}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="gw-card">
            <div className="gw-row">
              <a className="gw-link" href="#" onClick={(e) => { e.preventDefault(); openWeb(); }}>
                board · knowledge · discussions in the browser ↗
              </a>
              {snap?.url && <span className="gw-note">{snap.url}</span>}
            </div>
          </div>
        </main>
      )}

      {page === "settings" && (
        <main className="gw-main">
          <div className="gw-card">
            <h2>Concurrency</h2>
            <div className="gw-row">
              <button className="gw-btn" onClick={() => setMaxSessions((n) => Math.max(1, n - 1))}>−</button>
              <span className="gw-conc">{maxSessions}</span>
              <button className="gw-btn" onClick={() => setMaxSessions((n) => Math.min(8, n + 1))}>+</button>
              <span className="gw-note">concurrent agent sessions (WIP limit)</span>
            </div>
          </div>

          <div className="gw-card">
            <h2>Agents</h2>
            <div className="gw-row">
              {["opencode", "kiro"].map((b) => (
                <button key={b} className={`gw-btn ${backend === b ? "gw-btn-on" : ""}`} onClick={() => setBackend(b)}>
                  {b}
                </button>
              ))}
              <span className="gw-note">which agent CLI drives the tasks</span>
            </div>
            <div className="gw-row">
              <input className="gw-input" style={{ flex: 1 }} value={agent} placeholder="agent profile name (optional)"
                onChange={(e) => setAgent(e.target.value)} />
              <input className="gw-input" style={{ flex: 1 }} value={model} placeholder="model override (optional)"
                onChange={(e) => setModel(e.target.value)} />
            </div>
          </div>

          <div className="gw-card">
            <h2>Hub</h2>
            <div className="gw-row">
              <input className="gw-input" style={{ flex: 1 }} value={hubUrl} placeholder="https://bridge…workers.dev"
                onChange={(e) => setHubUrl(e.target.value)} />
            </div>
            <span className="gw-note">identity comes from device pairing — a new hub needs `bridge pair &lt;url&gt;`</span>
          </div>

          <div className="gw-card">
            <div className="gw-row">
              <button className="gw-btn gw-btn-run" onClick={() => void applySettings()}>Apply</button>
              {applyMsg && <span className="gw-ok">{applyMsg}</span>}
              <span className="gw-note">applying restarts the runner when it is running</span>
            </div>
          </div>
        </main>
      )}
    </div>
  );
}
