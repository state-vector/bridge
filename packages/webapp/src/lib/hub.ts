import type { Event, WsFrame } from "@bridge/specs";
import type { ConnStatus } from "./status";

/**
 * Contract client for the bridge worker (packages/worker):
 *   WS   GET  /ws        server-push only: snapshot | event | decisions | presence
 *   REST GET  /api/state snapshot (human plane, GitHub OAuth session cookie)
 *   REST POST /ingest    one door (machine plane, bearer) — the UI answers by ingesting
 */

export interface HubClientConfig {
  base: string;
  token: string;
  onStatus: (s: ConnStatus) => void;
  onFrame: (frame: WsFrame) => void;
}

let ws: WebSocket | null = null;
let stopped = true;
let backoff = 500;
let cfg: HubClientConfig | null = null;

async function probeAuth(base: string): Promise<boolean> {
  try {
    const r = await fetch(`${base}/api/state`, { credentials: "include" });
    return r.ok;
  } catch {
    return false;
  }
}

export function connectHub(config: HubClientConfig) {
  cfg = config;
  stopped = false;
  backoff = 500;
  dial();
}

export function disconnectHub() {
  stopped = true;
  ws?.close();
  ws = null;
}

/** GitHub OAuth: navigating to /login bounces through github.com and back with a session cookie. */
export function signIn(base: string) {
  window.location.href = `${base}/login`;
}

/** Who is signed in (worker: GET /api/session). null when unauthenticated/unreachable. */
export interface SessionInfo {
  mode: "github" | "access";
  user?: string | null;
  expires_ts?: number | null;
}

export async function fetchSession(base: string): Promise<SessionInfo | null> {
  try {
    const r = await fetch(`${base}/api/session`, { credentials: "include" });
    if (!r.ok) return null;
    return (await r.json()) as SessionInfo;
  } catch {
    return null;
  }
}

/** POST /logout → clears the cookie (Access mode additionally redirects through the IdP). */
export async function logout(base: string): Promise<void> {
  try {
    await fetch(`${base}/logout`, { credentials: "include", redirect: "follow" });
  } catch {
    /* clearing locally anyway */
  }
}

function dial() {
  if (stopped || !cfg) return;
  const { base, onStatus } = cfg;
  onStatus("connecting");
  const wsUrl = base.replace(/^http/, "ws") + "/ws";
  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    backoff = 500;
    onStatus("open");
  };
  ws.onmessage = (e) => {
    try {
      cfg?.onFrame(JSON.parse(e.data as string) as WsFrame);
    } catch {
      /* ignore malformed */
    }
  };
  ws.onclose = () => {
    if (stopped) return;
    onStatus("closed");
    void (async () => {
      if (cfg && !(await probeAuth(cfg.base))) {
        onStatus("auth");
        return; // stay parked until the user signs in (or config changes)
      }
      setTimeout(dial, backoff);
      backoff = Math.min(backoff * 2, 4000);
    })();
  };
  ws.onerror = () => ws?.close();
}

export function reconnect() {
  stopped = false;
  ws?.close();
  dial();
}

/** Publish through the one door. Returns accepted count (0 = dropped/rejected). */
export async function ingest(base: string, token: string, events: Event | Event[]): Promise<number> {
  const batch = Array.isArray(events) ? events : [events];
  try {
    const r = await fetch(`${base}/ingest`, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ events: batch }),
    });
    if (!r.ok) return 0;
    const body = (await r.json()) as { ok: boolean; accepted?: number };
    return body.ok ? (body.accepted ?? 0) : 0;
  } catch {
    return 0;
  }
}
