import { useEffect, useState } from "react";
import { BacklogView, CompletedView } from "./components/BacklogView";
import { BoardView } from "./components/BoardView";
import { ConnectView } from "./components/ConnectView";
import { DecisionDetail } from "./components/DecisionDetail";
import { DiscussionsView } from "./components/DiscussionsView";
import { ForMeView } from "./components/ForMeView";
import { KnowledgeView } from "./components/KnowledgeView";
import { LogView } from "./components/LogView";
import { PairView } from "./components/PairView";
import { TopView } from "./components/TopView";
import type { WsFrame } from "@bridge/specs";
import { connectHub, disconnectHub, useBridge } from "./lib/store";
import { useKb } from "./store/kb";
import "./App.css";

/** Full web UI — no desktop-shell forks. The gateway/dispatch experience lives
 *  in packages/desktop/ui; mobile fleet view in packages/mobile. */

type Tab = "forme" | "board" | "top" | "backlog" | "completed" | "log" | "knowledge" | "discussions" | "connect";
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "forme", label: "For Me" },
  { key: "board", label: "Board" },
  { key: "top", label: "Top" },
  { key: "backlog", label: "Backlog" },
  { key: "completed", label: "Completed" },
  { key: "log", label: "Log" },
  { key: "knowledge", label: "Knowledge" },
  { key: "discussions", label: "Discussions" },
  { key: "connect", label: "Connect" },
];

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
      <div className="topbar-spacer" />
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
  const [tab, setTab] = useState<Tab>("forme");

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

    return () => {
      disconnectHub();
      useKb.getState().stop();
    };
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
        {tab === "forme" && (
          <ForMeView
            openThread={(taskId) => {
              useKb.setState({ initialThread: taskId } as any);
              setTab("discussions");
            }}
          />
        )}
        {tab === "board" && <BoardView />}
        {tab === "top" && <TopView />}
        {tab === "backlog" && <BacklogView />}
        {tab === "completed" && <CompletedView />}
        {tab === "log" && <LogView />}
        {tab === "knowledge" && <KnowledgeView />}
        {tab === "discussions" && <DiscussionsView />}
        {tab === "connect" && <ConnectView />}
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
