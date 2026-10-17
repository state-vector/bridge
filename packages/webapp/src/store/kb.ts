import { create } from "zustand";
import { connectKbWs, kbApi, KbAuthError } from "../lib/kb";
import type { KbArtefact, KbAuthToken, KbEvent, KbProgress, KbSeriesPoint, KbSession } from "../lib/kb";
import { getConfig } from "../lib/config";
import { useBridge } from "../lib/store";

/** 401 anywhere on the knowledge plane → raise the app-wide sign-in gate. */
function escalateAuth(e: unknown) {
  if (e instanceof KbAuthError) useBridge.setState({ conn: "auth" });
}

export interface BoardPrefs {
  issue: boolean; status: boolean; age: boolean; owner: boolean;
  tags: boolean; sentiment: boolean; snippet: boolean; sparkline: boolean; pct: boolean;
}

const PREFS_KEY = "bridge.board.prefs";
const DEFAULT_PREFS: BoardPrefs = {
  issue: true, status: true, age: true, owner: true,
  tags: true, sentiment: true, snippet: true, sparkline: true, pct: true,
};
function loadPrefs(): BoardPrefs {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") }; }
  catch { return DEFAULT_PREFS; }
}

interface KbState {
  conn: "open" | "closed" | "off";
  tasks: KbArtefact[];
  sessions: KbSession[];
  progress: KbProgress[];
  series: KbSeriesPoint[];
  agents: Array<{ label: string; score: number; grade: string; hints: string[] } & Record<string, number | string>>;
  events: KbEvent[]; // newest first
  prefs: BoardPrefs;
  lastSeq: number;
  tokens: KbAuthToken[];
  settings: Record<string, any>;

  start: () => void;
  stop: () => void;
  reset: () => void;
  refresh: () => Promise<void>;
  refreshAdmin: () => Promise<void>;
  mint: (label: string, tags: string[], transport?: string) => Promise<{ id: string; label: string; tags: string[]; transport?: string; secret: string }>;
  revoke: (id: string) => Promise<void>;
  saveSettings: (s: Record<string, unknown>) => Promise<void>;
  transition: (id: string, to: string, extra?: { note?: string; unblock_condition?: string; sentiment?: string }) => Promise<void>;
  setPref: (k: keyof BoardPrefs, v: boolean) => void;
  setPrefs: (p: BoardPrefs) => void;
}

let stopWs: (() => void) | null = null;

export const useKb = create<KbState>((set, get) => ({
  conn: "off",
  tasks: [],
  agents: [],
  sessions: [],
  progress: [],
  series: [],
  events: [],
  prefs: loadPrefs(),
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

  reset: () => {
    stopWs?.();
    stopWs = null;
    set({ conn: "off", tasks: [], sessions: [], progress: [], series: [], agents: [], events: [], lastSeq: 0, tokens: [], settings: {} });
  },

  refresh: async () => {
    try {
      const board = await kbApi.board();
      set({ tasks: board.tasks, sessions: board.sessions, progress: board.progress ?? [], series: board.series ?? [], agents: board.agents ?? [] });
      const ev = await kbApi.events(get().lastSeq);
      if (ev.events.length) {
        const s = get();
        const merged = [...ev.events.slice().reverse(), ...s.events.filter((e) => !ev.events.some((n) => n.seq === e.seq))];
        set({ events: merged.slice(0, 500), lastSeq: Math.max(s.lastSeq, ev.last_seq) });
      }
    } catch (e) {
      escalateAuth(e); /* hub unreachable or mock mode — views show empty states */
    }
  },

  refreshAdmin: async () => {
    try {
      const t = await kbApi.tokens();
      const s = await kbApi.settings();
      set({ tokens: t.tokens, sessions: t.sessions, settings: s.settings ?? {} });
    } catch (e) {
      escalateAuth(e); /* not signed in yet */
    }
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
  setPref: (k, v) => {
    const prefs = { ...get().prefs, [k]: v };
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    set({ prefs });
  },
  setPrefs: (p) => {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
    set({ prefs: p });
  },
}));

export function kbConnected(): boolean {
  return getConfig().mode !== "mock";
}
