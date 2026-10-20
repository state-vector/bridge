const LS = {
  mode: "bridge.mode",
  url: "bridge.url",
  token: "bridge.token",
};

export type Mode = "live" | "mock";

const env = import.meta.env;

export function getConfig() {
  const mode =
    ((localStorage.getItem(LS.mode) as Mode | null) ??
      ((env.VITE_HUB_MODE as Mode | undefined) ?? "live"));
  // The webapp is browser-only: the desktop gateway has its own minimal UI
  // (packages/desktop/ui), so no shell forks live here. The hub is the
  // browser origin — no personal deployment is baked into the source.
  const fallback =
    mode === "mock" ? "http://127.0.0.1:7788" : window.location.origin;
  const url = localStorage.getItem(LS.url) || fallback;
  const token = localStorage.getItem(LS.token) || (env.VITE_INGEST_TOKEN as string | undefined) || "";
  return { mode, url: url.replace(/\/$/, ""), token };
}

export function setConfig(patch: { mode?: Mode; url?: string; token?: string }) {
  if (patch.mode !== undefined) localStorage.setItem(LS.mode, patch.mode);
  if (patch.url !== undefined) localStorage.setItem(LS.url, patch.url.replace(/\/$/, ""));
  if (patch.token !== undefined) localStorage.setItem(LS.token, patch.token);
}
