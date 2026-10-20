import { getConfig } from "./config";

/** Knowledge-layer REST + realtime client (human plane, cookie session). */

export interface KbArtefact {
  id: string;
  type: string;
  title: string;
  status: string;
  tags?: string[] | null;
  board?: string | null;
  owner?: string;
  body_md?: string;
  meta?: Record<string, unknown>;
  created_ts: number;
  updated_ts: number;
  status_ts?: number;
}

export interface KbEvent {
  seq: number;
  ts: number;
  actor: string;
  op: string;
  artefact_id: string | null;
  detail: Record<string, unknown>;
}

export interface KbSession {
  token_id: string;
  label: string | null;
  name: string;
  first_seen_ts: number;
  last_seen_ts: number;
}

export interface KbAuthToken {
  id: string;
  label: string;
  tags: string[];
  transport?: string;
  created_ts: number;
  last_seen_ts?: number | null;
  revoked_ts?: number | null;
}

export interface KbProgress {
  seq: number;
  ts: number;
  actor: string;
  artefact_id: string;
  detail: { note?: string; sentiment?: string };
}

/** One point of a task's self-reported gauge series (from version history). */
export interface KbSeriesPoint {
  artefact_id: string;
  ts: number;
  actor: string;
  note?: string;
  sentiment?: string;
  completion_pct?: number;
  confidence_pct?: number;
  risk_pct?: number;
  context_pct?: number;
}

/** One entry of an artefact's version history: every mutation, who/when/what. */
export interface KbVersion {
  seq: number;
  ts: number;
  actor: string;
  action: string;
  summary: string;
  data: Record<string, unknown>;
}

export interface KbBoard {
  tasks: KbArtefact[];
  sessions: KbSession[];
  progress: KbProgress[];
  series: KbSeriesPoint[];
  agents?: Array<{ label: string; score: number; grade: string; hints: string[] } & Record<string, number | string>>;
}

const base = () => getConfig().url;

/** Thrown when the cookie session is missing/expired — the app funnels these into the sign-in gate. */
export class KbAuthError extends Error {}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${base()}${path}`, { credentials: "include", ...init });
  if (r.status === 401) throw new KbAuthError("signed out");
  if (!r.ok) throw new Error(`${r.status} ${await r.text().then((t) => t.slice(0, 200))}`);
  return (await r.json()) as T;
}

export const kbApi = {
  board: () => j<KbBoard>("/api/kb/board"),
  events: (since: number) => j<{ events: KbEvent[]; last_seq: number }>(`/api/kb/events?since=${since}&limit=200`),
  artefacts: (q?: { type?: string; status?: string; limit?: number }) => {
    const p = new URLSearchParams(Object.entries(q ?? {}).filter(([, v]) => v).map(([k, v]) => [k, String(v)]));
    return j<{ artefacts: KbArtefact[] }>(`/api/kb/artefacts${p.size ? `?${p}` : ""}`);
  },
  artefact: (id: string) => j<KbArtefact & { relations: { relation: string; artefact_id: string; dir: string }[] }>(`/api/kb/artefact?id=${encodeURIComponent(id)}`),
  search: (q: string) => j<{ artefacts: any[] }>(`/api/kb/search?q=${encodeURIComponent(q)}`),
  related: (id: string) => j<{ artefacts: KbArtefact[] }>(`/api/kb/related?id=${encodeURIComponent(id)}`),
  history: (id: string) => j<{ artefact_id: string; versions: KbVersion[] }>(`/api/kb/history?id=${encodeURIComponent(id)}`),
  // human replies on a question thread — the same log_progress door agents use
  progress: (id: string, note: string, extra?: { will?: string; sentiment?: string }) =>
    j<{ ok: boolean }>("/api/kb/progress", { method: "POST", body: JSON.stringify({ id, note, ...extra }) }),
  create: (body: { type: string; title: string; body_md?: string; meta?: object; owner?: string }) =>
    j<{ id: string }>("/api/kb/create", { method: "POST", body: JSON.stringify(body) }),
  boost: (id: string, on = true) =>
    j<{ id: string; boosted: string[]; on: boolean }>("/api/kb/boost", { method: "POST", body: JSON.stringify({ id, boost: on }) }),
  transition: (id: string, to: string, extra?: { note?: string; unblock_condition?: string; sentiment?: string }) =>
    j<{ id: string; status: string }>(`/api/kb/transition`, { method: "POST", body: JSON.stringify({ id, to, ...extra }) }),
  update: (id: string, patch: { title?: string; body_md?: string; meta?: object }) =>
    j<{ id: string }>(`/api/kb/update`, { method: "POST", body: JSON.stringify({ id, ...patch }) }),

  // admin (connect page)
  tokens: () => j<{ tokens: KbAuthToken[]; sessions: KbSession[] }>("/api/kb/admin/tokens"),
  mint: (label: string, tags: string[], transport?: string) =>
    j<{ id: string; label: string; tags: string[]; transport?: string; secret: string }>("/api/kb/admin/tokens", { method: "POST", body: JSON.stringify({ label, tags, transport }) }),
  revoke: (id: string) => j<{ id: string }>("/api/kb/admin/tokens/revoke", { method: "POST", body: JSON.stringify({ id }) }),
  updateTokenTags: (id: string, tags: string[]) =>
    j<{ id: string; label: string; tags: string[] }>("/api/kb/admin/tokens/tags", { method: "POST", body: JSON.stringify({ id, tags }) }),
  settings: () => j<{ settings: Record<string, any> }>("/api/kb/admin/settings"),
  saveSettings: (settings: Record<string, unknown>) =>
    j<{ settings: Record<string, any> }>("/api/kb/admin/settings", { method: "POST", body: JSON.stringify({ settings }) }),
};

/** Realtime KB events over WS. Reconnects with backoff; feeds a callback. */
export function connectKbWs(onEvent: (e: KbEvent) => void, onStatus: (s: "open" | "closed") => void) {
  const url = base().replace(/^http/, "ws") + "/kb-ws?since=0";
  let ws: WebSocket | null = null;
  let stopped = false;
  let backoff = 2000;
  const dial = () => {
    if (stopped) return;
    ws = new WebSocket(url);
    ws.onopen = () => {
      backoff = 2000;
      onStatus("open");
    };
    ws.onmessage = (e) => {
      try {
        const f = JSON.parse(e.data);
        if (f.type === "kb.event") onEvent(f.event);
      } catch { /* ignore */ }
    };
    ws.onclose = () => {
      if (stopped) return;
      onStatus("closed");
      setTimeout(dial, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
    ws.onerror = () => ws?.close();
  };
  dial();
  return () => {
    stopped = true;
    ws?.close();
  };
}
