import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Shapes matching dispatch.rs DispatchSnapshot / DispatchActivity. */
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

const KIND_CLASS: Record<string, string> = {
  dispatch: "gw-kind-dispatch",
  finish: "gw-kind-finish",
  error: "gw-kind-error",
  info: "gw-kind-info",
};

function ts(t: number): string {
  const d = new Date(t);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Detect installed agent CLIs by probing PATH via the Rust side is overkill
 *  for v1 — probe `which`-style names locally through the shell. */
const AGENT_CANDIDATES = ["opencode", "claude", "codex", "aider", "cursor-agent"];

export function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [url, setUrl] = useState("");
  const [msg, setMsg] = useState("");
  const [agents, setAgents] = useState<Record<string, boolean>>({});
  const logRef = useRef<HTMLDivElement>(null);

  const pull = useCallback(async () => {
    try {
      const s = await invoke<Snapshot>("dispatch_snapshot");
      setSnap(s);
      if (s.url && !url) setUrl(s.url);
    } catch {
      setMsg("not running inside the desktop shell — invoke unavailable");
    }
  }, [url]);

  useEffect(() => {
    void pull();
    const t = setInterval(() => void pull(), 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // log autoscroll
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = 0;
  }, [snap?.activity.length]);

  // detect agent CLIs on first mount (best-effort, via available commands)
  useEffect(() => {
    void (async () => {
      for (const name of AGENT_CANDIDATES) {
        try {
          // tauri shell plugin is not wired; use invoke-free check via fetch of
          // the runner snapshot's agent field for now, and fall back to manual list
          void name;
        } catch { /* ignore */ }
      }
      setAgents(Object.fromEntries(AGENT_CANDIDATES.map((n) => [n, n === "opencode"])));
    })();
  }, []);

  const toggleRun = async () => {
    try {
      if (snap?.running) await invoke("dispatch_stop");
      else await invoke("dispatch_start");
      await pull();
    } catch (e) {
      setMsg(String(e));
    }
  };

  const saveConfig = async () => {
    try {
      // pass through dispatch_start with an explicit config (URL override)
      await invoke("dispatch_start", { config: url ? { url, token: "" } : null });
      await pull();
      setMsg("saved");
      setTimeout(() => setMsg(""), 1500);
    } catch (e) {
      setMsg(String(e));
    }
  };

  const openWeb = () => {
    if (snap?.url) window.open(snap.url, "_blank");
  };

  const activity = snap?.activity ?? [];

  return (
    <div className="gw">
      <header className="gw-head">
        <span className="gw-brand">Bridge Gateway</span>
        <span className={`gw-conn ${snap?.running ? "gw-conn-open" : "gw-conn-closed"}`}>
          ● {snap?.running ? `running${snap.workspace ? ` · ${snap.workspace}` : ""}` : "stopped"}
        </span>
        {snap?.label && <span className="gw-user">{snap.label}</span>}
      </header>

      <main className="gw-main">
        <div className="gw-card">
          <div className="gw-row">
            {snap?.running
              ? <button className="gw-btn gw-btn-stop" onClick={() => void toggleRun()}>Stop</button>
              : <button className="gw-btn gw-btn-run" onClick={() => void toggleRun()}>Start</button>}
            <span className="gw-note">
              {snap?.max_sessions ?? 1} concurrent{snap?.workdir ? ` · ${snap.workdir}` : ""}
            </span>
            {msg && <span className="gw-ok">{msg}</span>}
          </div>
          {(snap?.in_flight.length ?? 0) > 0 && (
            <div className="gw-row">
              {snap!.in_flight.map((f) => (
                <span key={f.task_id} className="gw-note">
                  ▸ {f.task_id} — {f.last_note || "working"}
                </span>
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
          <h2>Agents</h2>
          {AGENT_CANDIDATES.map((name) => (
            <div key={name} className="gw-agent">
              <input className="gw-check" type="checkbox" checked={!!agents[name]} onChange={(e) => setAgents((a) => ({ ...a, [name]: e.target.checked }))} />
              <span className="gw-agent-name">{name}</span>
              <span className={`gw-agent-meta ${agents[name] ? "gw-agent-on" : "gw-agent-off"}`}>
                {agents[name] ? "enabled" : "disabled"}
              </span>
            </div>
          ))}
          <div className="gw-row">
            <input
              className="gw-input"
              style={{ flex: 1 }}
              value={url}
              placeholder="hub url (https://bridge…workers.dev)"
              onChange={(e) => setUrl(e.target.value)}
            />
            <button className="gw-btn" onClick={() => void saveConfig()}>Save</button>
          </div>
          <span className="gw-note">runner identity comes from device pairing — config lives in ~/.bridge/config.json</span>
        </div>

        <div className="gw-card">
          <h2>Web</h2>
          <div className="gw-row">
            <a className="gw-link" href="#" onClick={(e) => { e.preventDefault(); openWeb(); }}>
              open full board in browser ↗
            </a>
            {snap?.url && <span className="gw-note">{snap.url}</span>}
          </div>
        </div>
      </main>
    </div>
  );
}
