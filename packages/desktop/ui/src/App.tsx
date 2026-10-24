import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TopView, BacklogView, CompletedView, StatusLights, useKb, setKbHubConfig, setKbAuthEscalator } from "@bridge/ui-kit";
import { openDetailWindow } from "./detailWindow";
import { Btn, Card, Chip, ConnDot, TextInput } from "@bridge/ui-kit";
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
  logout_reason?: string | null; // set when the run gate auto-signs-out (BR#2532) — rendered on the pair screen
  logout_ts?: number | null;
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
  backends?: Record<string, { bin?: string | null; agent?: string | null; model?: string | null; mode?: string | null }> | string[] | null;
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

export function App() {
  const [page, setPage] = useState<"top" | "backlog" | "chat" | "log" | "settings">("top");
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
  // human-session auth (credential-class ADR BR#2673): the UI gate follows the
  // GitHub session, never the gateway token
  const [session, setSession] = useState<{ signed_in?: boolean; user?: string; ws?: string } | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [signinErr, setSigninErr] = useState("");

  // signed in = the human session exists and is live (probe clears dead sessions)
  const paired = !!session?.signed_in;
  // BR#2532: the 2s poll compares keychain-token presence against this ref —
  // config reloads only when the token flips under us (re-reading on every
  // tick would clobber in-flight settings edits). The sign-in screen then
  // shows the guided auto-logout notice from the snapshot.
  const pairedRef = useRef(false);

  const refreshSession = useCallback(async () => {
    try {
      setSession(await invoke("session_get"));
    } catch {
      setSession({ signed_in: false });
    }
  }, []);

  // any 401 anywhere in the knowledge plane → back to the sign-in gate.
  // Silent failure is how "answering does nothing" happens; fail closed loud.
  useEffect(() => {
    setKbAuthEscalator(() => {
      setSession({ signed_in: false });
      void refreshSession();
    });
  }, [refreshSession]);


  // native menu (tray + app menu) actions arrive as events
  useEffect(() => {
    const offs: Array<() => void> = [];
    void listen("goto-settings", () => setPage("settings")).then((f) => offs.push(f));
    void listen("do-signin", () => signInRef.current()).then((f) => offs.push(f));
    void listen("do-logout", () => void doLogoutRef.current?.()).then((f) => offs.push(f));
    return () => offs.forEach((f) => f());
  }, []);

  const doLogoutRef = useRef<(() => void) | null>(null);
  const doLogout = async () => {
    // Sign out = clear the HUMAN session only (ADR BR#2673). The gateway
    // token is separate infrastructure — it survives and keeps dispatching.
    try {
      await invoke("session_logout");
      await refreshSession();
      setLogoutMsg("signed out");
    } catch (e) {
      setLogoutMsg(`failed: ${String(e)}`);
    }
  };
  doLogoutRef.current = doLogout;

  // Settings "Reconnect gateway": re-vend the token via the human session and
  // restart the loop (dispatch::reconnect — start() self-heals the vend)
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectMsg, setReconnectMsg] = useState("");
  const reconnectGateway = async () => {
    setReconnecting(true);
    setReconnectMsg("");
    try {
      const s = await invoke<any>("gateway_reconnect");
      setReconnectMsg(s?.running ? "gateway running — token re-vended" : `gateway stopped: ${s?.last_error ?? "unknown"}`);
      await loadCfg();
      await pull();
    } catch (e) {
      setReconnectMsg(`failed: ${String(e)}`);
    } finally {
      setReconnecting(false);
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
        pairedRef.current = !!c.token;
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

  const signIn = useCallback(async () => {
    setSigninErr("");
    setSigningIn(true);
    try {
      // opens the OS browser; blocks on the loopback callback (≤10 min)
      const r = await invoke<{ signed_in: boolean; user?: string }>("session_login", {
        url: hubUrl.trim().replace(/\/$/, "") || undefined,
      });
      if (!r?.signed_in) setSigninErr("sign-in did not complete");
      await refreshSession();
      // the dispatch loop stops when its credential was broken — bring it
      // back so the app is visibly working right after sign-in
      try {
        await invoke("dispatch_start");
      } catch { /* already running, or an external runner owns the claim */ }
      await pull();
    } catch (e) {
      setSigninErr(String(e));
    } finally {
      setSigningIn(false);
    }
  }, [hubUrl, refreshSession, pull]);
  const signInRef = useRef<() => void>(() => {});
  signInRef.current = () => void signIn();

  // session probe on mount (and the 2s loop below keeps it fresh via pull()
  // for the dispatch side; the session itself only changes on sign in/out)
  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  useEffect(() => {
    void pull();
    void loadCfg();
    const t = setInterval(async () => {
      void pull();
      // BR#2532: notice an involuntary sign-out — the run gate erases the
      // token under us, so reload config only when the paired-bit flips
      // (re-reading on every tick would clobber in-flight settings edits).
      // The pair screen then shows the guided logout notice from the snapshot.
      try {
        const c = await invoke<Cfg | null>("dispatch_config");
        if (!!c?.token !== pairedRef.current) await loadCfg();
      } catch { /* no shell */ }
    }, 2000);
    return () => clearInterval(t);
  }, [pull, loadCfg]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = 0;
  }, [snap?.activity.length]);

  // native notification click → jump to the inbox (asks + decision watch)
  useEffect(() => {
    let un: (() => void) | undefined;
    void listen("open-ask", () => setPage("top")).then((f) => { un = f; });
    return () => un?.();
  }, []);

  // logged out / first use = ONE screen: sign in as YOU (GitHub). No nav, no
  // pages, no board chrome — nothing else is reachable without the human
  // session (credential-class ADR BR#2673).
  if (!paired) {
    return (
      <div className="gw">
        <main className="gw-main">
          <Card>
            <h2>Sign in to Bridge</h2>
            {snap?.logout_reason && (
              <div style={{
                marginBottom: 14, padding: "10px 12px", borderRadius: 8,
                border: "1px solid var(--line)", background: "var(--panel, transparent)",
              }}>
                <span className="k-err" style={{ display: "block", whiteSpace: "pre-wrap" }}>{snap.logout_reason}</span>
                <span className="gw-note" style={{ display: "block", marginTop: 6 }}>
                  Signing back in is one click: your hub URL below is kept — press Sign in with GitHub and approve
                  in your browser (the page opens itself). A fresh gateway-class token is vended for this same device.
                </span>
              </div>
            )}
            <div className="gw-row">
              <TextInput style={{ flex: 1 }} value={hubUrl} placeholder="https://bridge…workers.dev"
                onChange={(e) => setHubUrl(e.target.value)} />
              <Btn variant="primary" size="sm" disabled={signingIn} onClick={() => void signIn()}>
                {signingIn ? "Waiting for browser…" : "Sign in with GitHub"}
              </Btn>
            </div>
            <span className="gw-note" style={{ display: "block", marginTop: 10 }}>
              {signingIn
                ? "Your browser opened to complete GitHub sign-in — this desktop then acts as you, the human. The gateway provisions itself in the background."
                : "Sign-in opens your browser and comes straight back. You are the human here — agent credentials are separate and never used by this UI."}
            </span>
            {session?.user && (
              <div className="gw-row" style={{ marginTop: 8 }}>
                <span className="gw-note">last session: {session.user}{session.ws ? ` · ${session.ws}` : ""}</span>
              </div>
            )}
            {signinErr && (
              <div className="gw-row" style={{ marginTop: 8 }}>
                <span className="k-err">{signinErr}</span>
              </div>
            )}
          </Card>
        </main>
      </div>
    );
  }

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
      setApplyMsg("no config yet — Start once (sign in vends the gateway token), then edit");
      return;
    }
    const ordered = BACKENDS.filter((b) => backends.includes(b));
    const missing = ordered.filter((b) => BACKEND_META[b]?.modelRequired && !(backendModels[b] ?? "").trim());
    if (missing.length) {
      setApplyMsg(`model required for: ${missing.join(", ")}`);
      return;
    }
    // backends dict: each enabled provider carries its own section. Merge
    // over the existing file config — Apply only owns what the form shows
    // (model, agent); fields it does not know about (mode, bin) must
    // survive, or saving settings silently switches the transport.
    const prevBackends = (cfg?.backends && !Array.isArray(cfg.backends) ? cfg.backends : {}) as Record<string, { bin?: string | null; agent?: string | null; model?: string | null; mode?: string | null }>;
    const backendsOut = Object.fromEntries(
      ordered.map((b) => [b, {
        ...(prevBackends[b] ?? {}),
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
        <nav className="gw-nav">
          <button className={page === "top" ? "active" : ""} onClick={() => setPage("top")}>Top</button>
          <button className={page === "backlog" ? "active" : ""} onClick={() => setPage("backlog")}>Backlog</button>
          <button className={page === "chat" ? "active" : ""} onClick={() => setPage("chat")}>Chat</button>
          <button className={page === "log" ? "active" : ""} onClick={() => setPage("log")}>Log</button>
          <button className={page === "settings" ? "active" : ""} onClick={() => setPage("settings")}>Settings</button>
          <StatusLights />
        </nav>
        <span className="gw-user">{snap?.label ?? ""}</span>
      </header>

            {page === "top" && (
        <TopView
          openTask={(id) => openDetailWindow(/^ASK-|^DECISION-/.test(id) ? "decision" : "task", id)}
        />
      )}
      {page === "backlog" && (
        <BacklogView
          openTask={(id) => openDetailWindow("task", id)}
        />
      )}
      {page === "chat" && <Chat />}


      {page === "log" && (
        <main className="gw-main">
          <Card>
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
          </Card>
        </main>
      )}

      {page === "settings" && (
        <main className="gw-main">
          <Card>
            <h2>Gateway</h2>
            <div className="gw-row">
              <ConnDot
                state={snap?.running ? "open" : "closed"}
                label={snap?.running ? `running${snap.workspace ? ` · ${snap.workspace}` : ""}` : "stopped"}
              />
              {snap?.running
                ? <Btn variant="danger" size="sm" onClick={() => void toggleRun()}>Stop</Btn>
                : <Btn variant="primary" size="sm" onClick={() => void toggleRun()}>Start</Btn>}
              <Btn size="sm" disabled={reconnecting} onClick={() => void reconnectGateway()}>
                {reconnecting ? "Reconnecting…" : "Reconnect"}
              </Btn>
              {reconnectMsg && <span className="gw-note">{reconnectMsg}</span>}
              <span className="gw-note">
                {inFlight.length}/{snap?.max_sessions ?? 1} in flight
              </span>
              {msg && <span className="k-err">{msg}</span>}
              <a className="gw-link" style={{ marginLeft: "auto" }} href="#" onClick={(e) => { e.preventDefault(); openWeb(); }}>
                open full board ↗
              </a>
            </div>
            <span className="gw-note">
              Start and Reconnect both self-heal the token: with your GitHub session live, a tokenless gateway re-vends automatically — no pairing ceremony
            </span>
            <div className="gw-inflight" style={{ marginTop: 8 }}>
              {inFlight.map((f) => (
                <div key={f.task_id} className="gw-agent">
                  <ConnDot state="open" title="in flight" />
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
          </Card>

          <Card>
            <h2>Concurrency</h2>
            <div className="gw-row">
              <Btn size="sm" onClick={() => setMaxSessions((n) => Math.max(1, n - 1))}>−</Btn>
              <span className="gw-conc">{maxSessions}</span>
              <Btn size="sm" onClick={() => setMaxSessions((n) => Math.min(8, n + 1))}>+</Btn>
              <span className="gw-note">concurrent agent sessions (WIP limit)</span>
            </div>
            <span className="gw-note">all knobs live in ~/.bridge/config.json — editing it by hand is fine; Apply writes this form there too</span>
          </Card>

          <Card>
            <h2>Providers</h2>
            <div className="gw-row">
              {BACKENDS.map((b) => (
                <Btn key={b} size="sm" on={backends.includes(b)} onClick={() => toggleBackend(b)}>
                  {backends.includes(b) ? "✓ " : ""}{b}
                </Btn>
              ))}
            </div>
            <span className="gw-note">tasks rotate across the enabled provider CLIs</span>
            {backends.map((b) => {
              const meta = BACKEND_META[b] ?? { label: b, note: "", modelRequired: true, modelPlaceholder: "model" };
              return (
                <div key={b} className="gw-provider">
                  <h3 className="gw-provider-head">{meta.label}</h3>
                  <div className="gw-row">
                    <TextInput style={{ flex: 1 }} value={backendModels[b] ?? ""}
                      placeholder={meta.modelPlaceholder}
                      onChange={(e) => setBackendModels((m) => ({ ...m, [b]: e.target.value }))} />
                  </div>
                  <div className="gw-row">
                    <TextInput style={{ flex: 1 }} value={backendAgents[b] ?? ""}
                      placeholder="agent profile (optional — the CLI's own default profile if empty)"
                      onChange={(e) => setBackendAgents((m) => ({ ...m, [b]: e.target.value }))} />
                  </div>
                  <span className="gw-note">{meta.note}</span>
                </div>
              );
            })}
          </Card>

          <Card>
            <h2>Hub</h2>
            <div className="gw-row">
              <TextInput style={{ flex: 1 }} value={hubUrl} placeholder="https://bridge…workers.dev"
                onChange={(e) => setHubUrl(e.target.value)} />
            </div>
            <span className="gw-note">identity comes from your GitHub sign-in — the gateway provisions itself against this hub</span>
          </Card>

          <Card>
            <div className="gw-row">
              <Btn variant="primary" size="sm" onClick={() => void applySettings()}>Apply</Btn>
              {applyMsg && <span className="k-ok">{applyMsg}</span>}
              <span className="gw-note">applying restarts the runner when it is running</span>
            </div>
            <div className="gw-row" style={{ marginTop: 10 }}>
              <Btn variant="danger" size="sm" onClick={() => void doLogout()}>Sign out</Btn>
              {logoutMsg && <span className="gw-note">{logoutMsg}</span>}
              <span className="gw-note">clears your GitHub session only — the gateway keeps running</span>
            </div>
          </Card>
        </main>
      )}
    </div>
  );
}
