import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Chat } from "./Chat";
import { listen } from "@tauri-apps/api/event";

/** Bridge gateway UI. Four pages (For you first — the unblock inbox is the
 *  most important thing a user sees):
 *  For you — read-only inbox: proposed decisions, blocked work + unblock
 *            conditions, open questions. Human-authoritative actions stay in
 *            the webapp; rows deep-link there.
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
  backends?: Record<string, { bin?: string | null; agent?: string | null; model?: string | null }> | string[] | null;
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

/** window.open is trapped inside the Tauri webview — external URLs go
 *  through the opener plugin (Rust) into the system browser. */
const openExternal = (url: string) => {
  void invoke("open_external", { url }).catch(() => window.open(url, "_blank"));
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

interface ForYouArtefact {
  id: string;
  type: string;
  title: string;
  body_md?: string | null;
  status: string;
  owner?: string | null;
  created_ts: number;
  updated_ts: number;
  meta?: Record<string, any> | null;
  tags?: string[] | null;
}

/** For you — the human's unblock inbox (machine-plane, read-only). Verify
 *  verdicts group per target task like the webapp's For Me (BR#1782). */
function ForYou({ hubUrl }: { hubUrl: string | null }) {
  const [data, setData] = useState<{ decisions: ForYouArtefact[]; blocked: ForYouArtefact[]; questions: ForYouArtefact[] } | null>(null);
  const [err, setErr] = useState("");
  const pull = useCallback(async () => {
    try {
      const d = await invoke<any>("for_you");
      setData({ decisions: d.decisions ?? [], blocked: d.blocked ?? [], questions: d.questions ?? [] });
      setErr("");
    } catch (e) {
      setErr(String(e));
    }
  }, []);
  useEffect(() => { void pull(); }, [pull]);
  useEffect(() => {
    const t = setInterval(() => void pull(), 5000);
    return () => clearInterval(t);
  }, [pull]);

  const verdicts = (data?.decisions ?? []).filter((d) => d.meta?.decision_class === "verify-verdict" && (d.meta?.task || d.meta?.verify_target));
  const generic = (data?.decisions ?? []).filter((d) => !verdicts.includes(d));
  const byTarget = new Map<string, ForYouArtefact[]>();
  for (const d of verdicts) {
    const m = (d.meta ?? {}) as Record<string, any>;
    const key = String(m.task ?? m.verify_target);
    (byTarget.get(key) ?? byTarget.set(key, []).get(key)!).push(d);
  }
  const verdictCards = [...byTarget.values()].map((arr) => arr.sort((a, b) => b.created_ts - a.created_ts)).map((arr) => ({ latest: arr[0], prior: arr.slice(1) }));
  const openQuestions = (data?.questions ?? []).filter((t) => t.status !== "done" && t.status !== "superseded");
  const total = verdictCards.length + generic.length + (data?.blocked ?? []).length + openQuestions.length;

  const [acting, setActing] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [actMsg, setActMsg] = useState("");

  const act = async (id: string, to: "accepted" | "rejected") => {
    setActing(id);
    try {
      await invoke("decision_act", { id, act: to });
      setActMsg(`${id} ${to}`);
      setTimeout(() => setActMsg(""), 2500);
      await pull();
    } catch (e) {
      setActMsg(`failed: ${String(e)}`);
    } finally {
      setActing(null);
      void pull();
    }
  };

  const frameDecision = (d: ForYouArtefact): { q: string; verdict: string; target: string } => {
    const m = (d.meta ?? {}) as Record<string, unknown>;
    const target = String(m.task ?? m.verify_target ?? d.id);
    if (m.decision_class === "verify-verdict") {
      const bounce = String(m.verdict ?? "").toLowerCase() === "bounce";
      return {
        q: bounce ? `Bounce ${target} back to work? (verifier: receipts void)` : `Accept verification of ${target}? (receipts confirmed)`,
        verdict: bounce ? "BOUNCE" : "VERIFIED",
        target,
      };
    }
    return { q: d.title, verdict: "", target: "" };
  };

  const DecisionRow = ({ d, chips }: { d: ForYouArtefact; chips: string[] }) => {
    const busy = acting === d.id;
    const f = frameDecision(d);
    return (
      <div className="gw-agent fy-item fy-decision">
        <span className="fy-chips">
          {f.verdict && <span className={`chip ${f.verdict === "BOUNCE" ? "chip-needs" : "chip-done"}`}>{f.verdict}</span>}
          {chips.map((c) => <span key={c} className="chip chip-urgent">{c}</span>)}
          {f.target && <span className="chip chip-scope">{f.target}</span>}
        </span>
        <span className="gw-fq" title={d.title}>{f.q}</span>
        <div className="gw-row" style={{ marginLeft: "auto", gap: 6 }}>
          <button className="gw-btn act-accept" disabled={busy} onClick={() => void act(d.id, "accepted")}>
            {f.verdict === "BOUNCE" ? "Bounce it" : "Accept"}
          </button>
          <button className="gw-btn act-reject" disabled={busy} onClick={() => void act(d.id, "rejected")}>Reject</button>
          {hubUrl && <a className="gw-link" href="#" onClick={(e) => { e.preventDefault(); openExternal(`${hubUrl}/?task=${d.id}`); }}>comment ↗</a>}
        </div>
      </div>
    );
  };

  return (
    <main className="gw-main">
      {err && <div className="gw-card"><span className="gw-err">{err}</span></div>}
      <div className="gw-card">
        <h2>For you</h2>
        <span className="gw-note">{total > 0 ? `${total} awaiting you` : "nothing needs you right now"}</span>
      </div>
      {(verdictCards.length > 0 || generic.length > 0) && (
        <div className="gw-card">
          <h2>Awaiting your decision</h2>
          {verdictCards.map(({ latest, prior }) => {
            const verdict = String(latest.meta?.verdict ?? "").toLowerCase() === "bounce" ? "BOUNCE" : "VERIFIED";
            const target = String(latest.meta?.task ?? latest.meta?.verify_target ?? "");
            return (
              <div key={latest.id}>
                <DecisionRow d={latest} chips={["VERDICT", verdict, target]} />
                {prior.length > 0 && <div className="gw-note" style={{ marginLeft: 12 }}>+ {prior.length} prior round{prior.length > 1 ? "s" : ""} collapsed</div>}
              </div>
            );
          })}
          {generic.map((d) => <DecisionRow key={d.id} d={d} chips={["DECISION"]} />)}
        </div>
      )}
      {(data?.blocked ?? []).length > 0 && (
        <div className="gw-card">
          <h2>Blocked — unblock work</h2>
          {(data?.blocked ?? []).map((b) => (
            <div key={b.id} className="gw-agent fy-item">
              <span className="fy-chips"><span className="chip chip-urgent">BLOCKED</span></span>
              <span className="gw-fnote" title={b.title}>{b.title}</span>
              <span className="gw-fmeta">{b.meta?.unblock_condition ?? b.meta?.blocked_reason ?? null}</span>
              <span className="gw-fmeta gw-mono" style={{ marginLeft: "auto" }}>{b.id}</span>
            </div>
          ))}
        </div>
      )}
      {openQuestions.length > 0 && (
        <div className="gw-card">
          <h2>Open questions</h2>
          {openQuestions.map((t) => (
            <div key={t.id} className="gw-agent fy-item">
              <span className="fy-chips"><span className="chip chip-urgent">QUESTION</span></span>
              <span className="gw-fnote" title={t.title}>{t.title}</span>
              <span className="gw-fmeta gw-mono" style={{ marginLeft: "auto" }}>{t.id}</span>
            </div>
          ))}
        </div>
      )}
      {actMsg && <div className="gw-card"><span className="gw-ok">{actMsg}</span></div>}
    </main>
  );
}



interface BoardTask { id: string; title: string; status: string; meta?: Record<string, any>; updated_ts?: number; status_ts?: number }


function Top() {
  const [rows, setRows] = useState<BoardTask[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let dead = false;
    const pull = async () => {
      try {
        const d = await invoke<any>("board_lists");
        if (!dead) { setRows(d.top ?? []); setErr(""); }
      } catch (e) { if (!dead) setErr(String(e)); }
    };
    void pull();
    const t = setInterval(() => void pull(), 5000);
    return () => { dead = true; clearInterval(t); };
  }, []);
  return (
    <main className="gw-main">
      <div className="gw-card"><h2>Top</h2><span className="gw-note">{rows?.length ?? 0} in flight — live</span>{err && <span className="gw-err">{err}</span>}</div>
      <div className="gw-card">
        {(rows ?? []).map((t) => {
          const p = t.meta?.last_progress;
          return (
            <div key={t.id} className="gw-agent">
              <span className="conn conn-open">●</span>
              <span className="gw-agent-name gw-mono">{t.id}</span>
              <span className="gw-fnote" title={t.title}>{t.title}</span>
              <span className="gw-fmeta">{p?.completion_pct != null ? `${p.completion_pct}%` : t.status}</span>
            </div>
          );
        })}
        {(rows ?? []).length === 0 && <span className="gw-log-empty">nothing in flight</span>}
      </div>
    </main>
  );
}

/** Backlog — the queue (todo: boosted first, oldest first) + done ledger. */
function Backlog() {
  const [data, setData] = useState<{ backlog: BoardTask[]; done: BoardTask[] } | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let dead = false;
    const pull = async () => {
      try {
        const d = await invoke<any>("board_lists");
        if (!dead) { setData({ backlog: d.backlog ?? [], done: d.done ?? [] }); setErr(""); }
      } catch (e) { if (!dead) setErr(String(e)); }
    };
    void pull();
    const t = setInterval(() => void pull(), 5000);
    return () => { dead = true; clearInterval(t); };
  }, []);
  return (
    <main className="gw-main">
      <div className="gw-card"><h2>Backlog</h2><span className="gw-note">{data?.backlog?.length ?? 0} queued · {data?.done?.length ?? 0} done</span>{err && <span className="gw-err">{err}</span>}</div>
      <div className="gw-card">
        <h2>Queue</h2>
        {(data?.backlog ?? []).map((t) => (
          <div key={t.id} className="gw-agent">
            {t.meta?.boosted && <span className="chip chip-urgent">▲</span>}
            <span className="gw-agent-name gw-mono">{t.id}</span>
            <span className="gw-fnote" title={t.title}>{t.title}</span>
            {(t.meta?.attempt?.attempts ?? 0) > 0 && <span className="gw-fmeta">×{t.meta?.attempt?.attempts}</span>}
          </div>
        ))}
        {(data?.backlog ?? []).length === 0 && <span className="gw-log-empty">queue empty</span>}
      </div>
      <div className="gw-card">
        <h2>Done</h2>
        {(data?.done ?? []).slice(0, 25).map((t) => (
          <div key={t.id} className="gw-agent" style={{ opacity: 0.7 }}>
            <span className="gw-agent-name gw-mono">{t.id}</span>
            <span className="gw-fnote" title={t.title}>{t.title}</span>
          </div>
        ))}
        {(data?.done ?? []).length === 0 && <span className="gw-log-empty">nothing done yet</span>}
      </div>
    </main>
  );
}


export function App() {
  const [page, setPage] = useState<"forme" | "top" | "backlog" | "chat" | "log" | "settings">("forme");
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
  const [logoutMsg, setLogoutMsg] = useState("");
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [pairingUrl, setPairingUrl] = useState("");
  const [pairErr, setPairErr] = useState("");

  // logged-out / first-use: config exists but no vendored gateway token
  const paired = !!cfg?.token;

  const onboarding = (
    <main className="gw-main">
      <div className="gw-card">
        <h2>Pair this desktop</h2>
        <div className="gw-row">
          <input className="gw-input" style={{ flex: 1 }} value={hubUrl} placeholder="https://bridge…workers.dev"
            onChange={(e) => setHubUrl(e.target.value)} />
          <button className="gw-btn gw-btn-run" disabled={!!pairCode} onClick={() => void startPair()}>Pair</button>
        </div>
        {pairCode && (
          <div className="gw-row" style={{ marginTop: 8 }}>
            <span className="gw-note">
              Enter code <span className="gw-mono">{pairCode}</span> at{" "}
              <a className="gw-link" href="#" onClick={(e) => { e.preventDefault(); openExternal(`${pairingUrl}/pair`); }}>
                {pairingUrl}/pair
              </a>{" "}
              — waiting for approval…
            </span>
          </div>
        )}
        {pairErr && (
          <div className="gw-row" style={{ marginTop: 8 }}>
            <span className="gw-err">{pairErr}</span>
          </div>
        )}
      </div>
    </main>
  );

  const doLogout = async () => {
    if (!window.confirm("Log out? This stops the runner and clears the gateway token — your settings are kept; pair again to onboard.")) return;
    try {
      await invoke("logout");
      await loadCfg();
      await pull();
      setLogoutMsg("logged out — token cleared, settings kept");
    } catch (e) {
      setLogoutMsg(`failed: ${String(e)}`);
    }
  };

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
        // backends dict (new) or legacy array + flat maps
        const sections: Record<string, { model?: string; agent?: string }> = {};
        if (Array.isArray(c.backends)) {
          for (const name of c.backends) sections[name] = {};
          const legacyModels = c.models ?? {};
          const legacyAgents = c.agents ?? {};
          for (const name of c.backends) {
            if (legacyModels[name]) sections[name].model = legacyModels[name];
            if (legacyAgents[name]) sections[name].agent = legacyAgents[name];
          }
        } else if (c.backends && typeof c.backends === "object") {
          for (const [name, sec] of Object.entries(c.backends)) {
            sections[name] = { model: sec?.model ?? undefined, agent: sec?.agent ?? undefined };
          }
        } else if (c.backend) {
          sections[c.backend] = {};
        }
        const enabled = Object.keys(sections).length ? Object.keys(sections) : ["opencode"];
        setBackends(enabled);
        setBackendModels(Object.fromEntries(enabled.map((b) => [b, sections[b]?.model ?? ""])));
        setBackendAgents(Object.fromEntries(enabled.map((b) => [b, sections[b]?.agent ?? ""])));
        setHubUrl(c.url);
      }
    } catch { /* no shell */ }
  }, []);

  const startPair = async () => {
    const url = hubUrl.trim().replace(/\/$/, "");
    if (!url) {
      setPairErr("hub url required");
      return;
    }
    setPairErr("");
    setPairingUrl(url);
    try {
      setPairCode(await invoke<string>("pair_start", { url }));
    } catch (e) {
      setPairErr(String(e));
    }
  };

  // pairing poll: every 3s until authorized (token merged + saved) or expired
  useEffect(() => {
    if (!pairCode || !pairingUrl) return;
    let stop = false;
    const t = setInterval(async () => {
      try {
        const r = await invoke<any>("pair_poll", { url: pairingUrl, code: pairCode });
        if (stop) return;
        if (r?.status === "authorized") {
          setPairCode(null);
          await loadCfg();
          await pull();
          setLogoutMsg("");
        } else if (r?.status === "expired") {
          setPairErr("code expired — pair again");
          setPairCode(null);
        }
      } catch (e) {
        if (!stop) {
          setPairErr(String(e));
          setPairCode(null);
        }
      }
    }, 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [pairCode, pairingUrl, loadCfg, pull]);

  useEffect(() => {
    void pull();
    void loadCfg();
    const t = setInterval(() => void pull(), 2000);
    return () => clearInterval(t);
  }, [pull, loadCfg]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = 0;
  }, [snap?.activity.length]);

  // native notification click → jump to the inbox (asks + decision watch)
  useEffect(() => {
    let un: (() => void) | undefined;
    void listen("open-ask", () => setPage("forme")).then((f) => { un = f; });
    return () => un?.();
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

  const openWeb = () => {
    if (snap?.url) openExternal(snap.url);
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
    // backends dict: each enabled provider carries its own section
    const backendsOut = Object.fromEntries(
      ordered.map((b) => [b, {
        model: (backendModels[b] ?? "").trim() || null,
        agent: (backendAgents[b] ?? "").trim() || null,
      }]),
    );
    const next: Cfg = {
      ...cfg,
      url: hubUrl.trim().replace(/\/$/, "") || cfg.url,
      max_sessions: Math.max(1, maxSessions),
      backend: ordered[0] ?? null,
      backends: backendsOut,
      agent: backendsOut[ordered[0]]?.agent ?? null,
      model: backendsOut[ordered[0]]?.model ?? null,
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
          <button className={page === "forme" ? "active" : ""} onClick={() => setPage("forme")}>For you</button>
          <button className={page === "top" ? "active" : ""} onClick={() => setPage("top")}>Top</button>
          <button className={page === "backlog" ? "active" : ""} onClick={() => setPage("backlog")}>Backlog</button>
          <button className={page === "chat" ? "active" : ""} onClick={() => setPage("chat")}>Chat</button>
          <button className={page === "log" ? "active" : ""} onClick={() => setPage("log")}>Log</button>
          <button className={page === "settings" ? "active" : ""} onClick={() => setPage("settings")}>Settings</button>
        </nav>
        <span className="gw-user">{snap?.label ?? ""}</span>
      </header>

      {page === "forme" && (paired ? <ForYou hubUrl={snap?.url ?? null} /> : onboarding)}
      {page === "top" && (paired ? <Top /> : onboarding)}
      {page === "backlog" && (paired ? <Backlog /> : onboarding)}
      {page === "chat" && (paired ? <Chat /> : onboarding)}


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

      {page === "settings" && (paired ? (
        <main className="gw-main">
          <div className="gw-card">
            <h2>Runner</h2>
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
            <div className="gw-inflight" style={{ marginTop: 8 }}>
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
            <div className="gw-row" style={{ marginTop: 10 }}>
              <button className="gw-btn gw-btn-stop" onClick={() => void doLogout()}>Log out</button>
              {logoutMsg && <span className="gw-note">{logoutMsg}</span>}
              <span className="gw-note">stops the runner and clears the token — settings kept, pair again to onboard</span>
            </div>
          </div>
        </main>
      ) : onboarding)}
    </div>
  );
}
