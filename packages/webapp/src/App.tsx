import { useEffect, useState } from "react";
import { BacklogView, CompletedView } from "./components/BacklogView";
import { ConnectView } from "./components/ConnectView";
import { DecisionDetail } from "./components/DecisionDetail";
import { DiscussionsView } from "./components/DiscussionsView";
import { KnowledgeView } from "./components/KnowledgeView";
import { LogView } from "./components/LogView";
import { PairView } from "./components/PairView";
import { TopView } from "./components/TopView";
import { WorkspacePicker } from "./components/WorkspacePicker";
import type { WsFrame } from "@bridge/specs";
import { cardIdFromPathSegment, cardPath } from "@bridge/specs";
import { Btn, Chip, StatusLights, ReportsView, TaskDetail } from "@bridge/ui-kit";
import { connectHub, disconnectHub, useBridge } from "./lib/store";
import { useKb } from "./store/kb";
import "@bridge/ui-kit/tokens.css";
import "@bridge/ui-kit/ui-kit.css";
import "@bridge/ui-kit/views.css";
import "./App.css";

/** Full web UI — no desktop-shell forks. The gateway/dispatch experience lives
 *  in packages/desktop/ui; mobile fleet view in packages/mobile. */

type Tab = "top" | "reports" | "backlog" | "completed" | "log" | "knowledge" | "discussions" | "connect";
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "top", label: "Top" },
  { key: "reports", label: "Reports" },
  { key: "backlog", label: "Backlog" },
  { key: "completed", label: "Completed" },
  { key: "log", label: "Log" },
  { key: "knowledge", label: "Knowledge" },
  { key: "discussions", label: "Discussions" },
  { key: "connect", label: "Connect" },
];

function TopBar({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const conn = useBridge((s) => s.conn);
  const session = useBridge((s) => s.session);
  const signOut = useBridge((s) => s.signOut);

  return (
    <header className="topbar">
      <div className="brand">Bridge</div>
      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>
      <div className="topbar-spacer" />
      <StatusLights bridgeConn={conn === "open" ? "open" : conn === "connecting" ? "connecting" : "closed"} />
      <WorkspacePicker />
      {session && (
        <div className="user-widget" title={session.expires_ts ? `session expires ${new Date(session.expires_ts).toLocaleString()}` : session.mode}>
          <span className="user-mode">{session.mode === "access" ? "SSO" : "GitHub"}</span>
          <span className="user-name">{session.user ?? "admin"}</span>
          <Btn size="sm" quiet className="user-out" onClick={() => void signOut()}>Sign out</Btn>
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
        <Btn className="auth-submit" onClick={() => signInWithGithub()}>
          Sign in with GitHub
        </Btn>
      </div>
    </div>
  );
}

// ---------- card permalinks (BR#3990) ----------
// /card/BR-3990 (any artefact id, dash or # form) opens that card's detail
// panel; opening/closing a card keeps the URL in sync, so every card view is
// a shareable, stable link. The SPA fallback serves index.html for the path,
// and sign-in returns to it (cookie + back-here render), so deep links work
// straight from chat/PR/MCP-payload pastes.

function cardIdFromLocation(): string | null {
  const m = /^\/card\/([^/]+)\/?$/.exec(window.location.pathname);
  return m ? cardIdFromPathSegment(m[1]) : null;
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
  // deep-linked / opened card — one state, URL-synced (BR#3990)
  const [cardId, setCardId] = useState<string | null>(cardIdFromLocation);

  useEffect(() => {
    const onPop = () => setCardId(cardIdFromLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const openCard = (id: string | null) => {
    setCardId(id);
    const path = (id && cardPath(id)) || "/";
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
  };

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
          <Btn size="sm" onClick={() => useBridge.getState().retryConnection()}>
            Retry
          </Btn>
        </div>
      )}
      <main className="main">
        {tab === "top" && <TopView openTask={openCard} />}
        {tab === "reports" && <ReportsView />}
        {tab === "backlog" && <BacklogView openTask={openCard} />}
        {tab === "completed" && <CompletedView openTask={openCard} />}
        {tab === "log" && <LogView />}
        {tab === "knowledge" && <KnowledgeView />}
        {tab === "discussions" && <DiscussionsView />}
        {tab === "connect" && <ConnectView />}
      </main>
      {cardId && (
        <TaskDetail taskId={cardId} onClose={() => openCard(null)} onOpen={(id) => openCard(id)} />
      )}
      {selectedId && <DecisionDetail />}
      {overlay && (
        <div className="overlay-backdrop">
          <div className="overlay-card">
            <div className="ask-chips">
              <Chip tone="urgent">DECISION</Chip>
              {overlay.board && <Chip tone="scope">{overlay.board.toUpperCase()}</Chip>}
            </div>
            <h2>{overlay.title}</h2>
            {overlay.reason && <p className="ask-reason">{overlay.reason}</p>}
            <div className="overlay-actions">
              <Btn onClick={() => void resolve(overlay, "unblocked")}>Unblock</Btn>
              <Btn onClick={() => void resolve(overlay, "completed")}>Done</Btn>
              <Btn quiet onClick={() => { selectDecision(overlay.id); dismissOverlay(); }}>Open</Btn>
              <Btn quiet onClick={dismissOverlay}>Later</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
