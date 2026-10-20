import { create } from "zustand";
import type { Decision, EventView, Presence, WsFrame } from "@bridge/specs";
import { getConfig, setConfig } from "./config";
import type { Mode } from "./config";
import { connectHub, disconnectHub, ingest, reconnect, fetchSession, logout, signIn } from "./hub";
import type { SessionInfo } from "./hub";
import type { ConnStatus } from "./status";
import { rankDecisions } from "./views";

export const ME = "human:ray";

interface BridgeState {
  conn: ConnStatus;
  mode: Mode;
  url: string;
  token: string;
  session: SessionInfo | null;

  decisions: Decision[];
  presence: Presence[];
  events: EventView[]; // newest first
  board: string | "all";
  selectedId: string | null;
  overlayId: string | null;

  applyFrame: (frame: WsFrame) => void;
  setBoard: (b: string | "all") => void;
  selectDecision: (id: string | null) => void;
  dismissOverlay: () => void;
  saveConfig: (patch: { mode?: Mode; url?: string; token?: string }) => void;
  retryConnection: () => void;
  signInWithGithub: () => void;
  loadSession: () => Promise<void>;
  signOut: () => Promise<void>;
  resolve: (d: Decision, action: "unblocked" | "completed", note?: string, choice?: string) => Promise<void>;
  steer: (actorId: string, text: string) => Promise<void>;
}

let seenDecisions = new Set<string>();

function notifyDecision(d: Decision) {
  // desktop notifications are the gateway shell's job (packages/desktop);
  // the web UI stays browser-pure — no Tauri invokes here.
  void d;
}

export const useBridge = create<BridgeState>((set, get) => {
  const cfg = getConfig();
  seenDecisions = new Set();

  return {
    conn: "connecting",
    mode: cfg.mode,
    url: cfg.url,
    token: cfg.token,
    session: null,

    decisions: [],
    presence: [],
    events: [],
    board: "all",
    selectedId: null,
    overlayId: null,

    applyFrame: (frame) => {
      const s = get();
      switch (frame.type) {
        case "snapshot": {
          const st = frame.state;
          for (const d of st.decisions) seenDecisions.add(d.id);
          return set({
            decisions: st.decisions,
            presence: st.presence,
            events: st.events,
          });
        }
        case "event": {
          const ev = frame.event;
          if (s.events.some((e) => e.id === ev.id)) return;
          return set({ events: [ev, ...s.events].slice(0, 400) });
        }
        case "decisions": {
          const fresh = frame.decisions.filter((d) => !seenDecisions.has(d.id));
          for (const d of frame.decisions) seenDecisions.add(d.id);
          // interrupt policy: only needs_input asks escalate (notification + overlay)
          const interrupting = fresh.find(
            (d) => d.kind === "needs_input" && (d.urgency ?? "normal") === "time-sensitive",
          ) ?? fresh.find((d) => d.kind === "needs_input");
          if (interrupting) notifyDecision(interrupting);
          return set({
            decisions: frame.decisions,
            overlayId: interrupting?.id ?? s.overlayId,
          });
        }
        case "presence":
          return set({ presence: frame.presence });
      }
    },

    setBoard: (board) => set({ board }),
    selectDecision: (selectedId) => set({ selectedId }),
    dismissOverlay: () => set({ overlayId: null }),

    saveConfig: (patch) => {
      setConfig(patch);
      const next = getConfig();
      set({ mode: next.mode, url: next.url, token: next.token, conn: "connecting" });
      disconnectHub();
      setTimeout(() => location.reload(), 50);
    },

    retryConnection: () => {
      set({ conn: "connecting" });
      reconnect();
    },

    signInWithGithub: () => {
      signIn(get().url);
    },

    loadSession: async () => {
      set({ session: await fetchSession(get().url) });
    },

    signOut: async () => {
      await logout(get().url);
      disconnectHub();
      const { useKb } = await import("../store/kb");
      useKb.getState().reset();
      set({ session: null, conn: "auth" });
    },

    resolve: async (d, action, note, choice) => {
      const { url, token } = get();
      set({ overlayId: null });
      await ingest(url, token, {
        id: `bridge-ui:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        source: "bridge-ui",
        kind: action,
        board: d.board ?? undefined,
        task_id: d.task_id ?? undefined,
        title: d.title,
        actor: ME,
        actor_kind: "human",
        actor_label: "Ray",
        payload: {
          decision_id: d.id,
          ...(choice ? { choice } : {}),
          ...(note ? { note } : {}),
        },
      });
    },

    steer: async (actorId, text) => {
      if (!text.trim()) return;
      const { url, token, events } = get();
      const task_id =
        events.find((e) => e.actor === actorId && e.task_id)?.task_id ?? undefined;
      await ingest(url, token, {
        id: `bridge-ui:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        source: "bridge-ui",
        kind: "steer",
        task_id,
        actor: ME,
        actor_kind: "human",
        actor_label: "Ray",
        title: `Steer: ${text.trim()}`.slice(0, 300),
        payload: { text: text.trim(), target: actorId },
      });
    },
  };
});

// ---------- selectors ----------
// NEVER pass a selector that builds a fresh array/object per call straight to
// useBridge() — useSyncExternalStore treats each new snapshot as a change and
// loops forever (React error #185). Select the stable slice in the component,
// derive with useMemo. (visibleDecisions removed for exactly this reason.)

export const visibleDecisions = (s: BridgeState) =>
  rankDecisions(s.decisions).filter((d) => s.board === "all" || d.board === s.board);

export { connectHub, disconnectHub, getConfig };
