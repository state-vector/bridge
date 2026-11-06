import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AskEntries,
  Card,
  Chip,
  DashboardSummary,
  TrainPanel,
  TopView,
  TaskDetail,
  useHumanAsks,
  useKb,
} from "@bridge/ui-kit";
import { Voice } from "./Voice";
import { SignInButton } from "./SignIn";

const LS = { url: "bridge.url", token: "bridge.mcp.token" };
/** Shared hub (README) — persisted as the default when no hub url is set yet
 *  (BR#5581); the Connect card still shows it editable so a self-hosted hub
 *  can replace it. */
const DEFAULT_HUB = "https://hub.fleetbridge.run";

type Tab = "overview" | "asks" | "trains" | "top" | "voice";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "asks", label: "Asks" },
  { id: "trains", label: "Trains" },
  { id: "top", label: "Top" },
  { id: "voice", label: "Voice" },
];

function useHub() {
  const [url, setUrlState] = useState(() => {
    const v = localStorage.getItem(LS.url)?.trim() ?? "";
    if (v) return v;
    try { localStorage.setItem(LS.url, DEFAULT_HUB); } catch { /* private mode */ }
    return DEFAULT_HUB;
  });
  const [token, setTokenState] = useState(() => localStorage.getItem(LS.token) ?? "");
  const conn = useKb((s) => s.conn);
  const setUrl = (v: string) => {
    setUrlState(v.replace(/\/$/, ""));
    localStorage.setItem(LS.url, v.replace(/\/$/, ""));
  };
  const setToken = (v: string) => {
    setTokenState(v);
    localStorage.setItem(LS.token, v);
  };
  return { url, token, setUrl, setToken, conn };
}

function ConnectCard({ hub, onClose }: { hub: ReturnType<typeof useHub>; onClose: () => void }) {
  const [draftUrl, setDraftUrl] = useState(hub.url);
  const [draftToken, setDraftToken] = useState(hub.token);
  const [saving, setSaving] = useState(false);
  const refresh = useKb((s) => s.refresh);
  const save = () => {
    setSaving(true);
    hub.setUrl(draftUrl);
    hub.setToken(draftToken);
    // re-read the config from storage on the next tick — the store's start()
    // call reads getKbHubConfig() at dial time.
    setTimeout(() => {
      useKb.getState().stop();
      useKb.getState().start();
      void refresh();
      setSaving(false);
      onClose();
    }, 50);
  };
  return (
    <Card className="mb-connect-card">
      <h2>Connect</h2>
      <label className="mb-field">
        <span>hub url</span>
        <input
          value={draftUrl}
          placeholder="https://bridge…workers.dev"
          onChange={(e) => setDraftUrl(e.target.value)}
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
        />
      </label>
      <label className="mb-field">
        <span>mcp token (voice)</span>
        <input
          value={draftToken}
          placeholder="token for bridge MCP"
          onChange={(e) => setDraftToken(e.target.value)}
          type="password"
        />
      </label>
      <p className="mb-note">
        The hub url feeds every tab. The MCP token is only used by the Voice tab
        (bridge MCP tool calls); without it Voice stays read-only.
      </p>
      <div className="mb-row-actions">
        <button className="mb-btn primary" onClick={save} disabled={saving}>
          {saving ? "connecting…" : "save & connect"}
        </button>
        <button className="mb-btn" onClick={onClose}>close</button>
      </div>
    </Card>
  );
}

function OverviewTab() {
  const tasks = useKb((s) => s.tasks);
  const agents = useKb((s) => s.agents);
  const events = useKb((s) => s.events);
  const counts = useMemo(() => {
    const c = { todo: 0, progress: 0, review: 0, blocked: 0, done: 0 };
    for (const t of tasks) {
      if (t.status === "todo") c.todo++;
      else if (t.status === "in_progress") c.progress++;
      else if (t.status === "in_review") c.review++;
      else if (t.status === "blocked") c.blocked++;
      else if (t.status === "done") c.done++;
    }
    return c;
  }, [tasks]);

  const inFlight = useMemo(
    () => tasks.filter((t) => t.status === "in_progress").slice(0, 12),
    [tasks],
  );
  const blockedWithAsks = useMemo(
    () => tasks.filter((t) => t.status === "blocked" && t.meta?.awaiting_ask).slice(0, 6),
    [tasks],
  );
  const openAsks = blockedWithAsks.length;

  return (
    <div className="mb-tab">
      <div className="mb-counts">
        <div className="mb-count mb-todo"><b>{counts.todo}</b><span>todo</span></div>
        <div className="mb-count mb-progress"><b>{counts.progress}</b><span>active</span></div>
        <div className="mb-count mb-review"><b>{counts.review}</b><span>review</span></div>
        <div className="mb-count mb-blocked"><b>{counts.blocked}</b><span>blocked</span></div>
        {openAsks > 0 && (
          <div className="mb-count mb-ask"><b>{openAsks}</b><span>asks</span></div>
        )}
      </div>
      <DashboardSummary tasks={tasks} events={events} />
      {agents && agents.length > 0 && (
        <Card>
          <h2>Agents</h2>
          <div className="mb-fleet">
            {agents.slice(0, 8).map((a) => (
              <div key={a.label} className="mb-frow">
                <Chip tone={a.score >= 80 ? "ok" : a.score >= 50 ? "warn" : "urgent"}>{a.label}</Chip>
                <span className="mb-fnote">score {a.score} · {a.grade}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
      <Card>
        <h2>In flight</h2>
        <div className="mb-fleet">
          {inFlight.map((t) => (
            <div key={t.id} className="mb-frow">
              <Chip tone="scope">{t.id}</Chip>
              <span className="mb-fnote">{t.title}</span>
            </div>
          ))}
          {inFlight.length === 0 && <span className="mb-empty">nothing running</span>}
        </div>
      </Card>
    </div>
  );
}

function AsksTab() {
  const refresh = useKb((s) => s.refresh);
  // empty visible-set = the full inbox lands in `residual` (BR#5448: the
  // Asks tab is the human inbox, not per-row nesting — that's Top's job).
  const visible = useMemo(() => new Set<string>(), []);
  const asks = useHumanAsks(visible);
  return (
    <div className="mb-tab">
      {asks.ready && asks.total > 0 && (
        <p className="mb-hint">{asks.total} {asks.total === 1 ? "ask" : "asks"} need you</p>
      )}
      <AskEntries entries={asks.residual} onDone={() => void refresh()} />
      {!asks.ready && <p className="mb-empty">loading asks…</p>}
      {asks.ready && asks.total === 0 && <p className="mb-empty">nothing needs you right now.</p>}
    </div>
  );
}

function TrainsTab({ openTask }: { openTask: (id: string) => void }) {
  return (
    <div className="mb-tab">
      <TrainPanel openTask={openTask} />
    </div>
  );
}

function TopTab({ openTask }: { openTask: (id: string) => void }) {
  return (
    <div className="mb-tab">
      <TopView openTask={openTask} />
    </div>
  );
}

export function App() {
  const hub = useHub();
  const [tab, setTab] = useState<Tab>("overview");
  const [connectOpen, setConnectOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const conn = useKb((s) => s.conn);
  const lastError = useKb((s) => s.lastError);

  const openTask = useCallback((id: string) => setDetailId(id), []);

  const signIn = () => {
    const w = window as unknown as { __bridgeShell?: unknown; __TAURI_INTERNALS__?: unknown };
    if ((w.__bridgeShell || w.__TAURI_INTERNALS__) && hub.url) {
      // Shell with a hub url: the INIT_SCRIPT owns the flow (shell_sign_in
      // invoke + navigation to <hub>/login?shell=1).
      document.dispatchEvent(new Event("bridge:sign-in"));
    } else {
      setConnectOpen(true);
    }
  };

  useEffect(() => {
    if (!hub.url) {
      setConnectOpen(true);
      return;
    }
    useKb.getState().start();
    return () => useKb.getState().stop();
  }, [hub.url]);

  return (
    <div className="mb">
      <header className="mb-head">
        <span className="mb-brand">Bridge</span>
        <SignInButton onSignIn={signIn} />
        <button
          className={`mb-connect-btn ${conn === "open" ? "mb-conn-open" : "mb-conn-closed"}`}
          onClick={() => setConnectOpen(true)}
          title="Connect — hub url + MCP token"
        >
          <span className="mb-conn-dot">{conn === "open" ? "●" : "○"}</span>
          {conn === "open" ? "connected" : "connect"}
        </button>
      </header>

      <nav className="mb-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "active" : ""}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="mb-main">
        {connectOpen && <ConnectCard hub={hub} onClose={() => setConnectOpen(false)} />}
        {lastError && (
          <div className="mb-error-card">
            <b>hub error</b> <span>{lastError.message}</span>
          </div>
        )}
        {tab === "overview" && <OverviewTab />}
        {tab === "asks" && <AsksTab />}
        {tab === "trains" && <TrainsTab openTask={openTask} />}
        {tab === "top" && <TopTab openTask={openTask} />}
        {tab === "voice" && <Voice />}
      </main>

      {detailId && <TaskDetail taskId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}
