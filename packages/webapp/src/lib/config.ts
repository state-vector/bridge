const LS = {
  mode: "bridge.mode",
  url: "bridge.url",
  token: "bridge.token",
};

export type Mode = "live" | "mock";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const env = import.meta.env;
// Hub URL comes from the environment (VITE_HUB_URL at build time) or the
// browser origin — no personal deployment is baked into the source.
const DEFAULT_LIVE_URL = (env.VITE_HUB_URL as string | undefined) ?? "";

export function getConfig() {
  const mode =
    ((localStorage.getItem(LS.mode) as Mode | null) ??
      ((env.VITE_HUB_MODE as Mode | undefined) ?? "live"));
  const fallback =
    mode === "mock"
      ? "http://127.0.0.1:7788"
      : isTauri()
        ? DEFAULT_LIVE_URL
        : window.location.origin;
  const url = localStorage.getItem(LS.url) || fallback;
  const token = localStorage.getItem(LS.token) || (env.VITE_INGEST_TOKEN as string | undefined) || "";
  return { mode, url: url.replace(/\/$/, ""), token };
}

export function setConfig(patch: { mode?: Mode; url?: string; token?: string }) {
  if (patch.mode !== undefined) localStorage.setItem(LS.mode, patch.mode);
  if (patch.url !== undefined) localStorage.setItem(LS.url, patch.url.replace(/\/$/, ""));
  if (patch.token !== undefined) localStorage.setItem(LS.token, patch.token);
}
