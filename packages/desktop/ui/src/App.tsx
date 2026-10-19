import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Bridge gateway UI. Three pages:
 *  Main — mini-Top: the local work in flight right now.
 *  Log — the full dispatch log stream.
 *  Settings — hub, agents (multi-select backends + profile + model), concurrency.
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
  backends?: string[] | null;
  models?: Record<string, string> | null;
  agents?: Record<string, string> | null;
  report_minutes?: number | null;
}

const KIND_CLASS: Record<string, string> = {
  dispatch: "gw-kind-dispatch",
  finish: "gw-kind-finish",
  error: "gw-kind-error",
  info: "gw-kind-info",
};

const BACKENDS = ["opencode", "kiro"];

/** Per-backend config shape: opencode dispatches a bare CLI whose default model
 *  is whatever its own config file says — there a model is REQUIRED. Kiro is
 *  profile-driven (its profiles pin provider + model), so it needs no model. */
const BACKEND_META: Record<string, { label: string; note: string; modelRequired: boolean; modelPlaceholder: string }> = {
  opencode: {
    label: "opencode",
    note: "CLI default comes from ~/.config/opencode/opencode.json — pin an explicit model so spend is predictable",
    modelRequired: true,
    modelPlaceholder: "model — REQUIRED (e.g. openrouter/~anthropic/claude-haiku-latest)",
  },
  kiro: {
    label: "kiro",
    note: "profile-driven: the kiro profile pins provider + model, so no model here",
    modelRequired: false,
    modelPlaceholder: "model — optional (profile usually decides)",
  },
};

function ts(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function App() {
  const [page, setPage] = useState<"main" | "log" | "settings">("main");
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [msg, setMsg] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  // settings state
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [maxSessions, setMaxSessions] = useState(1);
  const [backends, setBackends] = useState<string[]>(["opencode"]);
  const [backendModels, setBackendModels] = useState<Record<string, string>>({});
  const [backendAgents, setBackendAgents] = useState<Record<string, string>>({});
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
        const enabled = c.backends?.length ? c.backends : c.backend ? [c.backend] : ["opencode"];
        setBackends(enabled);
        setBackendModels({ ...(c.models ?? (c.model ? { [c.backend ?? "opencode"]: c.model } : {})) });
        setBackendAgents({ ...(c.agents ?? (c.agent ? { [c.backend ?? "opencode"]: c.agent } : {})) });
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

  const toggleBackend = (b: string) => {
    setBackends((cur) => {
      if (cur.includes(b)) return cur.length > 1 ? cur.filter((x) => x !== b) : cur;
      return [...BACKENDS.filter((x) => cur.includes(x) || x === b)];
    });
  };

  const applySettings = async () => {
    if (!cfg) {
      setApplyMsg("no config yet — start once (pairs via BRIDGE_URL), then edit");
      return;
    }
    const ordered = BACKENDS.filter((b) => backends.includes(b));
    const missing = ordered.filter((b) => BACKEND_META[b]?.modelRequired && !(backendModels[b] ?? "").trim());
    if (missing.length) {
      setApplyMsg(`model required for: ${missing.join(", ")}`);
      return;
    }
    // only backends that are actually enabled carry their section's values
    const modelsOut = Object.fromEntries(
      ordered.map((b) => [b, (backendModels[b] ?? "").trim()]).filter(([, v]) => v !== ""),
    );
    const agentsOut = Object.fromEntries(
      ordered.map((b) => [b, (backendAgents[b] ?? "").trim()]).filter(([, v]) => v !== ""),
    );
    const next: Cfg = {
      ...cfg,
      url: hubUrl.trim().replace(/\/$/, "") || cfg.url,
      max_sessions: Math.max(1, maxSessions),
      backend: ordered[0] ?? null,
      backends: ordered,
      agent: agentsOut[ordered[0]] ?? null,
      model: modelsOut[ordered[0]] ?? null,
      models: modelsOut,
      agents: agentsOut,
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

  const inFlight = snap?.in_flight ?? [];
  const activity = snap?.activity ?? [];
  const now = Date.now();

  return (
    <div className="gw">
      <header className="gw-head">
        <span className="gw-brand">bridge<span className="cursor" /></span>
        <nav className="gw-nav">
          <button className={page === "main" ? "active" : ""} onClick={() => setPage("main")}>Main</button>
          <button className={page === "log" ? "active" : ""} onClick={() => setPage("log")}>Log</button>
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
                {inFlight.length}/{snap?.max_sessions ?? 1} in flight
              </span>
              {msg && <span className="gw-err">{msg}</span>}
              <a className="gw-link" style={{ marginLeft: "auto" }} href="#" onClick={(e) => { e.preventDefault(); openWeb(); }}>
                open full board ↗
              </a>
            </div>
          </div>

          <div className="gw-card">
            <h2>Local work</h2>
            <div className="gw-inflight">
              {inFlight.map((f) => (
                <div key={f.task_id} className="gw-agent">
                  <span className={`conn conn-open`} title="in flight">●</span>
                  <span className="gw-agent-name gw-mono">{f.task_id}</span>
                  <span className="gw-fnote" title={f.task_title}>{f.task_title}</span>
                  <span className="gw-fmeta">{age(now - f.started_ms)}</span>
                </div>
              ))}
              {inFlight.length === 0 && (
                <span className="gw-log-empty">nothing in flight — idle</span>
              )}
            </div>
            {inFlight.some((f) => f.last_note) && (
              <div className="gw-notes">
                {inFlight.filter((f) => f.last_note).map((f) => (
                  <div key={f.task_id} className="gw-line">
                    <span className="gw-ts">{f.task_id}</span>
                    <span className="gw-kind-info">{f.last_note}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </main>
      )}

      {page === "log" && (
        <main className="gw-main">
          <div className="gw-card">
            <h2>Dispatch log</h2>
            <div className="gw-log gw-log-tall" ref={logRef}>
              {activity.length === 0 && <span className="gw-log-empty">no activity yet — start the runner</span>}
              {activity.map((a, i) => (
                <div key={`${a.ts}-${i}`} className="gw-line">
                  <span className="gw-ts">{ts(a.ts)}</span>
                  <span className={KIND_CLASS[a.kind] ?? "gw-kind-info"}>{a.msg}</span>
                </div>
              ))}
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
            <span className="gw-note">all knobs live in ~/.bridge/config.json — editing it by hand is fine; Apply writes this form there too</span>
          </div>

          <div className="gw-card">
            <h2>Providers</h2>
            <div className="gw-row">
              {BACKENDS.map((b) => (
                <button key={b} className={`gw-btn ${backends.includes(b) ? "gw-btn-on" : ""}`} onClick={() => toggleBackend(b)}>
                  {backends.includes(b) ? "✓ " : ""}{b}
                </button>
              ))}
            </div>
            <span className="gw-note">tasks rotate across the enabled provider CLIs</span>
            {backends.map((b) => {
              const meta = BACKEND_META[b] ?? { label: b, note: "", modelRequired: true, modelPlaceholder: "model" };
              return (
                <div key={b} className="gw-provider">
                  <h3 className="gw-provider-head">{meta.label}</h3>
                  <div className="gw-row">
                    <input className="gw-input" style={{ flex: 1 }} value={backendModels[b] ?? ""}
                      placeholder={meta.modelPlaceholder}
                      onChange={(e) => setBackendModels((m) => ({ ...m, [b]: e.target.value }))} />
                  </div>
                  <div className="gw-row">
                    <input className="gw-input" style={{ flex: 1 }} value={backendAgents[b] ?? ""}
                      placeholder="agent profile (optional — the CLI's own default profile if empty)"
                      onChange={(e) => setBackendAgents((m) => ({ ...m, [b]: e.target.value }))} />
                  </div>
                  <span className="gw-note">{meta.note}</span>
                </div>
              );
            })}
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
