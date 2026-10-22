/** Hub connection config for the knowledge plane.
 *
 *  Reads the same localStorage keys the webapp has always used, so the webapp
 *  needs zero wiring; native shells (desktop gateway) call setKbHubConfig()
 *  once at boot with credentials from the host process. */

const LS = {
  mode: "bridge.mode",
  url: "bridge.url",
  token: "bridge.token",
};

export type KbMode = "live" | "mock";

let override: { mode?: KbMode; url?: string; token?: string } | null = null;

/** Persistent override — native shells use this (their creds live in the host,
 *  not the webview's localStorage). */
export function setKbHubConfig(patch: { mode?: KbMode; url?: string; token?: string }) {
  if (patch.url !== undefined) localStorage.setItem(LS.url, patch.url.replace(/\/$/, ""));
  if (patch.token !== undefined) localStorage.setItem(LS.token, patch.token);
  if (patch.mode !== undefined) localStorage.setItem(LS.mode, patch.mode);
  override = { ...(override ?? {}), ...patch };
}

export function clearKbHubConfig() {
  localStorage.removeItem(LS.url);
  localStorage.removeItem(LS.token);
  override = null;
}

export function getKbHubConfig(): { mode: KbMode; url: string; token: string } {
  if (override) {
    const fallback = override.mode === "mock" ? "http://127.0.0.1:7788" : window.location.origin;
    return {
      mode: override.mode ?? "live",
      url: (override.url ?? fallback).replace(/\/$/, ""),
      token: override.token ?? "",
    };
  }
  const env = ((import.meta as any).env ?? {}) as Record<string, string | undefined>;
  const mode = ((localStorage.getItem(LS.mode) as KbMode | null) ?? (env.VITE_HUB_MODE as KbMode | undefined) ?? "live");
  const fallback = mode === "mock" ? "http://127.0.0.1:7788" : window.location.origin;
  const url = localStorage.getItem(LS.url) || fallback;
  const token = localStorage.getItem(LS.token) || env.VITE_INGEST_TOKEN || "";
  return { mode, url: url.replace(/\/$/, ""), token };
}
