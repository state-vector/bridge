import { useEffect, useState } from "react";
import { DecisionDetail } from "./components/DecisionDetail";
import { Panel } from "./components/Panel";
import type { WsFrame } from "@flows/specs";
import { boardsOf } from "./lib/views";
import { connectHub, disconnectHub, useBridge } from "./lib/store";
import "./App.css";

const tauriInvoke = (cmd: string, args?: Record<string, unknown>) => {
  void (async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke(cmd, args);
    } catch {
      /* plain browser */
    }
  })();
};

function TopBar() {
  const conn = useBridge((s) => s.conn);
  const board = useBridge((s) => s.board);
  const setBoard = useBridge((s) => s.setBoard);
  const decisions = useBridge((s) => s.decisions);
  const events = useBridge((s) => s.events);
  const [settings, setSettings] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const boards = boardsOf(decisions, events);
  const saveConfig = useBridge((s) => s.saveConfig);

  const openSettings = () => {
    setUrlDraft(useBridge.getState().url);
    setTokenDraft(useBridge.getState().token);
    setSettings(!settings);
  };

  return (
    <header className="topbar">
      <div className="brand">
        Bridge
        <span className={`conn conn-${conn}`} title={conn}>
          ●
        </span>
      </div>
      <div className="scope-chips">
        {["all", ...boards].slice(0, 5).map((b) => (
          <button
            key={b}
            className={`chip chip-scope ${board === b ? "active" : ""}`}
            onClick={() => setBoard(b as typeof board)}
          >
            {b === "all" ? "ALL" : b.toUpperCase()}
          </button>
        ))}
        <button className="icon-btn" onClick={openSettings} aria-label="Settings">
          ⚙
        </button>
      </div>
      {settings && (
        <div className="settings-drawer">
          <label>
            Hub URL
            <input value={urlDraft} onChange={(e) => setUrlDraft(e.target.value)} />
          </label>
          <label>
            Ingest token
            <input
              type="password"
              value={tokenDraft}
              placeholder="FLOWS_INGEST_TOKEN"
              onChange={(e) => setTokenDraft(e.target.value)}
            />
          </label>
          <div className="settings-actions">
            <button
              className="opt-btn"
              onClick={() => {
                saveConfig({ url: urlDraft, token: tokenDraft });
              }}
            >
              Save & reconnect
            </button>
          </div>
        </div>
      )}
    </header>
  );
}

function AuthBanner() {
  const url = useBridge((s) => s.url);
  const loginError = useBridge((s) => s.loginError);
  const loginWithPassword = useBridge((s) => s.loginWithPassword);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!pw || busy) return;
    setBusy(true);
    await loginWithPassword(pw);
    setBusy(false);
    setPw("");
  };

  return (
    <div className="conn-banner">
      <span>Signed out of {new URL(url).host}.</span>
      <input
        type="password"
        className="login-input"
        placeholder="hub password"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void submit()}
        autoFocus
      />
      <button className="opt-btn" onClick={() => void submit()} disabled={!pw || busy}>
        {busy ? "…" : "Sign in"}
      </button>
      {loginError && <span className="login-error">{loginError}</span>}
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

  useEffect(() => {
    connectHub({
      base: useBridge.getState().url,
      token: useBridge.getState().token,
      onStatus: (status) => useBridge.setState({ conn: status }),
      onFrame: (frame: WsFrame) => useBridge.getState().applyFrame(frame),
    });

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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const overlay = overlayId && overlayDecision ? overlayDecision : null;

  return (
    <div className="app">
      <TopBar />
      {conn === "auth" && <AuthBanner />}
      {conn === "closed" && (
        <div className="conn-banner">
          Hub unreachable — is it deployed / mock hub running (npm run hub)?
          <button className="opt-btn" onClick={() => useBridge.getState().retryConnection()}>
            Retry
          </button>
        </div>
      )}
      <main className="main">
        <Panel />
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
              <button className="opt-btn" onClick={() => void resolve(overlay, "unblocked")}>
                Unblock
              </button>
              <button className="opt-btn" onClick={() => void resolve(overlay, "completed")}>
                Done
              </button>
              <button
                className="opt-btn opt-ghost"
                onClick={() => {
                  selectDecision(overlay.id);
                  dismissOverlay();
                }}
              >
                Open
              </button>
              <button className="opt-btn opt-ghost" onClick={dismissOverlay}>
                Later
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
