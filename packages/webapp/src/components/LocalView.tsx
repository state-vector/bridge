import { useEffect, useState } from "react";

/**
 * Local dispatch view (desktop shell only): shows the local runner's state —
 * identity, in-flight opencode run, and dispatch activity — via Tauri IPC.
 * Hidden in plain browsers (invoke fails there).
 */

interface Activity {
  ts: number;
  kind: string;
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

const rel = (ts: number) => {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
};

const KIND_CHIP: Record<string, string> = {
  dispatch: "chip chip-scope",
  finish: "chip ok",
  error: "chip chip-urgent",
  info: "chip",
};

export function LocalView() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [isTauri, setIsTauri] = useState(true);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const s = await invoke<Snapshot>("dispatch_snapshot");
        if (!stopped) setSnap(s);
      } catch {
        if (!stopped) setIsTauri(false);
      }
    };
    void poll();
    const t = setInterval(() => void poll(), 2000);
    return () => { stopped = true; clearInterval(t); };
  }, []);

  const toggle = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      if (snap?.running) await invoke("dispatch_stop");
      else await invoke("dispatch_start");
      setMsg("");
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  if (!isTauri) return null;

  return (
    <div className="connect-wrap">
      <div className="view-head">
        <h2>Local dispatch</h2>
        <span className="muted-note">this machine's runner + opencode sessions</span>
      </div>

      <div className="card">
        <h2>Runner</h2>
        <div className="task-row task-status-row">
          <span className={`st-chip ${snap?.running ? "st-ok" : "st-err"}`}>
            {snap?.running ? "running" : "stopped"}
          </span>
          {snap?.label && <span className="chip chip-scope" title="paired agent identity">{snap.label}</span>}
          {snap?.workspace && <span className="chip" title="workspace">@{snap.workspace}</span>}
          {snap?.agent && <span className="chip" title="opencode agent">{snap.agent}</span>}
          {snap && <span className="chip" title="WIP limit (BRIDGE_MAX_SESSIONS)">{snap.in_flight.length}/{snap.max_sessions} sessions</span>}
        </div>
        {snap?.url && <p className="muted-note">hub: {snap.url}</p>}
        {snap?.workdir && <p className="muted-note">workdir: {snap.workdir}</p>}
        <p>
          <button className="opt-btn" onClick={() => void toggle()}>
            {snap?.running ? "Stop runner" : "Start runner"}
          </button>
        </p>
        {msg && <p className="login-error">{msg}</p>}
        {!snap?.running && !snap?.url && (
          <p className="muted-note">
            Not configured — run the app headless once with BRIDGE_URL set, or pair via <code>/pair</code>.
          </p>
        )}
      </div>

      <div className="card">
        <h2>In flight</h2>
        {(snap?.in_flight ?? []).length === 0 && (
          <span className="muted-note">nothing running — idle</span>
        )}
        {(snap?.in_flight ?? []).map((inf) => (
          <div key={inf.task_id} className="progress-line">
            <span className="task-id">{inf.task_id}</span>
            <span className="progress-note">
              <b>{inf.task_title}</b> — {inf.last_note}
            </span>
            <span className="step-ts">{rel(inf.started_ms)}</span>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Activity</h2>
        {(snap?.activity ?? []).length === 0 && (
          <span className="muted-note">no local activity yet</span>
        )}
        {(snap?.activity ?? []).map((a, i) => (
          <div key={`${a.ts}-${i}`} className="progress-line">
            <span className={`chip ${KIND_CHIP[a.kind] ?? "chip"}`}>{a.kind}</span>
            <span className="progress-note">{a.msg}</span>
            <span className="step-ts">{rel(a.ts)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
