import { useEffect, useState } from "react";
import { BoardView } from "./components/BoardView";
import { ConnectView } from "./components/ConnectView";
import { DecisionDetail } from "./components/DecisionDetail";
import { DiscussionsView } from "./components/DiscussionsView";
import { KnowledgeView } from "./components/KnowledgeView";
import { LocalView } from "./components/LocalView";
import { LogView } from "./components/LogView";
import { PairView } from "./components/PairView";
import { Panel } from "./components/Panel";
import { SettingsView } from "./components/SettingsView";
import { TopView } from "./components/TopView";
import type { WsFrame } from "@flows/specs";
import { connectHub, disconnectHub, useBridge } from "./lib/store";
import { useKb } from "./store/kb";
import "./App.css";

type Tab = "board" | "top" | "log" | "knowledge" | "discussions" | "connect" | "settings" | "inbox" | "local";
const TABS_ALL: Array<{ key: Tab; label: string }> = [
  { key: "top", label: "Top" },
  { key: "board", label: "Board" },
  { key: "log", label: "Log" },
  { key: "knowledge", label: "Knowledge" },
  { key: "discussions", label: "Discuss" },
  { key: "connect", label: "Connect" },
  { key: "local", label: "Local" },
  { key: "settings", label: "Settings" },
  { key: "inbox", label: "Decisions" },
];
// the Local tab is desktop-shell-only (Tauri IPC); hidden in plain browsers
const TABS = TABS_ALL.filter((t) => t.key !== "local" || "__TAURI_INTERNALS__" in window);

const tauriInvoke = (cmd: string, args?: Record<string, unknown>) => {
  void (async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke(cmd, args);
    } catch {
      /* plain browser */
    }
  })();
}

function TopBar({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const conn = useBridge((s) => s.conn);
  const kbConn = useKb((s) => s.conn);
  const session = useBridge((s) => s.session);
  const signOut = useBridge((s) => s.signOut);

  return (
    <header className="topbar">
      <div className="brand">
        Bridge
        <span className={`conn conn-${conn}`} title={`hub: ${conn}`}>●</span>
        <span className={`conn conn-${kbConn === "open" ? "open" : "closed"}`} title={`kb realtime: ${kbConn}`}>●</span>
      </div>
      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>
      {session && (
        <div className="user-widget" title={session.expires_ts ? `session expires ${new Date(session.expires_ts).toLocaleString()}` : session.mode}>
          <span className="user-mode">{session.mode === "access" ? "SSO" : "GitHub"}</span>
          <span className="user-name">{session.user ?? "admin"}</span>
          <button className="opt-btn user-out" onClick={() => void signOut()}>Sign out</button>
        </div>
      )}
    </header>
  );
}

function SignIn() {
  const url = useBridge((s) => s.url);
  const signInWithGithub = useBridge((s) => s.signInWithGithub);

  return (
    <div className="auth-gate">
      <div className="auth-card">
        <div className="brand auth-brand">Bridge</div>
        <p className="auth-host">Sign in to {new URL(url).host}</p>
        <button className="opt-btn auth-submit" onClick={() => signInWithGithub()}>
          Sign in with GitHub
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const conn = useBridge((s) => s.conn);
  const selectedId = useBridge((s) => s.selectedId);
  const overlayId = useBridge((s) => s.overlayId);
  const overlayDecision = useBridge((s) => s.decisions.find((d) => d.id === overlayId));
  const resolve = useBridge((s) => s.resolve);
  const dismissOverlay = useBridge((s) => s.dismissOverlay);
  const selectDecision = useBridge((s) => s.selectDecision);
  const [tab, setTab] = useState<Tab>("top");

  useEffect(() => {
    connectHub({
      base: useBridge.getState().url,
      token: useBridge.getState().token,
      onStatus: (status) => {
        useBridge.setState({ conn: status });
        if (status === "open") void useBridge.getState().loadSession();
      },
      onFrame: (frame: WsFrame) => useBridge.getState().applyFrame(frame),
    });
    useKb.getState().start();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") tauriInvoke("hide_panel");
    };
    window.addEventListener("keydown", onKey);

    const unsubs: Array<() => void> = [];
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unsubs.push(
          await listen<{ ask_id: string; option_id: string }>("ask-action", (e) => {
            const s = useBridge.getState();
            const d = s.decisions.find((x) => x.id === e.payload.ask_id);
            if (!d) return;
            const isOption = d.options?.some((o) => o.id === e.payload.option_id);
            const action = e.payload.option_id === "done" ? "completed" : "unblocked";
            void s.resolve(d, action, undefined, isOption ? e.payload.option_id : undefined);
          }),
        );
        unsubs.push(
          await listen<{ ask_id: string }>("open-ask", (e) => {
            useBridge.getState().selectDecision(e.payload.ask_id);
            tauriInvoke("show_panel");
          }),
        );
      } catch {
        /* plain browser */
      }
    })();

    return () => {
      window.removeEventListener("keydown", onKey);
      unsubs.forEach((u) => u());
      disconnectHub();
      useKb.getState().stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const overlay = overlayId && overlayDecision ? overlayDecision : null;

  // device pairing approval is a standalone page, not a tab
  if (window.location.pathname === "/pair") return <PairView />;

  if (conn === "auth") return <SignIn />;

  return (
    <div className="app">
      <TopBar tab={tab} setTab={setTab} />
      {conn === "closed" && (
        <div className="conn-banner">
          Hub unreachable — is it deployed / mock hub running (npm run hub)?
          <button className="opt-btn" onClick={() => useBridge.getState().retryConnection()}>
            Retry
          </button>
        </div>
      )}
      <main className="main">
        {tab === "board" && <BoardView />}
        {tab === "top" && <TopView />}
        {tab === "log" && <LogView />}
        {tab === "knowledge" && <KnowledgeView />}
        {tab === "discussions" && <DiscussionsView />}
        {tab === "connect" && <ConnectView />}
        {tab === "local" && <LocalView />}
        {tab === "settings" && <SettingsView />}
        {tab === "inbox" && <Panel />}
      </main>
      {selectedId && <DecisionDetail />}
      {overlay && (
        <div className="overlay-backdrop">
          <div className="overlay-card">
            <div className="ask-chips">
              <span className="chip chip-urgent">DECISION</span>
              {overlay.board && <span className="chip chip-scope">{overlay.board.toUpperCase()}</span>}
            </div>
            <h2>{overlay.title}</h2>
            {overlay.reason && <p className="ask-reason">{overlay.reason}</p>}
            <div className="overlay-actions">
              <button className="opt-btn" onClick={() => void resolve(overlay, "unblocked")}>Unblock</button>
              <button className="opt-btn" onClick={() => void resolve(overlay, "completed")}>Done</button>
              <button className="opt-btn opt-ghost" onClick={() => { selectDecision(overlay.id); dismissOverlay(); }}>Open</button>
              <button className="opt-btn opt-ghost" onClick={dismissOverlay}>Later</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
