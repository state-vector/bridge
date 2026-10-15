import { create } from "zustand";
import { connectKbWs, kbApi } from "../lib/kb";
import type { KbArtefact, KbAuthToken, KbEvent, KbProgress, KbSession } from "../lib/kb";
import { getConfig } from "../lib/config";

interface KbState {
  conn: "open" | "closed" | "off";
  tasks: KbArtefact[];
  sessions: KbSession[];
  progress: KbProgress[];
  events: KbEvent[]; // newest first
  lastSeq: number;
  tokens: KbAuthToken[];
  settings: Record<string, any>;

  start: () => void;
  stop: () => void;
  refresh: () => Promise<void>;
  refreshAdmin: () => Promise<void>;
  mint: (label: string, tags: string[], transport?: string) => Promise<{ id: string; label: string; tags: string[]; transport?: string; secret: string }>;
  revoke: (id: string) => Promise<void>;
  saveSettings: (s: Record<string, unknown>) => Promise<void>;
  transition: (id: string, to: string, extra?: { note?: string; unblock_condition?: string; sentiment?: string }) => Promise<void>;
}

let stopWs: (() => void) | null = null;

export const useKb = create<KbState>((set, get) => ({
  conn: "off",
  tasks: [],
  sessions: [],
  progress: [],
  events: [],
  lastSeq: 0,
  tokens: [],
  settings: {},

  start: () => {
    stopWs?.();
    const { mode } = getConfig();
    if (mode === "mock") {
      set({ conn: "off" });
      return;
    }
    stopWs = connectKbWs(
      (ev) => {
        const s = get();
        if (s.events.some((e) => e.seq >= ev.seq)) return;
        set({ events: [ev, ...s.events].slice(0, 500), lastSeq: Math.max(s.lastSeq, ev.seq) });
        void s.refresh();
      },
      (conn) => set({ conn }),
    );
    void get().refresh();
    void get().refreshAdmin();
  },

  stop: () => {
    stopWs?.();
    stopWs = null;
  },

  refresh: async () => {
    try {
      const board = await kbApi.board();
      set({ tasks: board.tasks, sessions: board.sessions, progress: board.progress ?? [] });
      const ev = await kbApi.events(get().lastSeq);
      if (ev.events.length) {
        const s = get();
        const merged = [...ev.events.slice().reverse(), ...s.events.filter((e) => !ev.events.some((n) => n.seq === e.seq))];
        set({ events: merged.slice(0, 500), lastSeq: Math.max(s.lastSeq, ev.last_seq) });
      }
    } catch {
      /* hub unreachable or mock mode — views show empty states */
    }
  },

  refreshAdmin: async () => {
    try {
      const t = await kbApi.tokens();
      const s = await kbApi.settings();
      set({ tokens: t.tokens, sessions: t.sessions, settings: s.settings ?? {} });
    } catch { /* not signed in yet */ }
  },

  mint: async (label, tags, transport) => {
    const r = await kbApi.mint(label, tags, transport);
    await get().refreshAdmin();
    return r;
  },
  revoke: async (id) => {
    await kbApi.revoke(id);
    await get().refreshAdmin();
  },
  saveSettings: async (s) => {
    await kbApi.saveSettings(s);
    await get().refreshAdmin();
  },
  transition: async (id, to, extra) => {
    await kbApi.transition(id, to, extra);
    await get().refresh();
  },
}));

export function kbConnected(): boolean {
  return getConfig().mode !== "mock";
}
