import React from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { App } from "./App";
import { TaskWindow } from "./TaskWindow";
import { openDetailWindow } from "./detailWindow";
import { KbAuthError, setCardLinkOpener, setKbHubConfig, setKbTransport, useKb } from "@bridge/ui-kit";
import "@bridge/ui-kit/tokens.css";
import "@bridge/ui-kit/ui-kit.css";
import "@bridge/ui-kit/views.css";
import "./styles.css";

// Card refs in rendered text (BR#4015): a plain click opens the card in its
// own OS window — never a navigation (this shell doesn't serve the webapp's
// /card/* routes). Detail windows already pass their own opener (openOther);
// this covers every surface without one (decision popover bodies, comments).
// In a plain browser (gateway-ui dev without the Tauri shell) fall back to a
// ?task= window — the same shell, no navigation of the opener.
setCardLinkOpener((id) => {
  const kind = /^DECISION-/.test(id) ? "decision" : "task";
  if ("__TAURI_INTERNALS__" in window) {
    openDetailWindow(kind, id);
  } else {
    window.open(`${location.pathname}?${kind}=${encodeURIComponent(id)}`, "_blank", "noopener,width=800,height=880");
  }
});

// The shell renders the SAME knowledge views as the webapp off the SAME data
// layer — but every KB call is routed through the Rust host (kb_fetch), which
// attaches the human session cookie (actor `web`). The gateway token is never
// injected here: UI call paths must not carry it (ADR BR#2673).
setKbTransport(async (path, init) => {
  try {
    return await invoke("kb_fetch", {
      path,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body) : null,
    });
  } catch (e) {
    const msg = String(e);
    if (msg.startsWith("401") || /no session/i.test(msg)) throw new KbAuthError(msg);
    throw new Error(msg);
  }
});

void (async () => {
  try {
    const cfg = await invoke<{ url?: string }>("dispatch_config");
    if (cfg?.url) setKbHubConfig({ url: cfg.url });
  } catch { /* no shell — transport resolves the hub itself */ }
  useKb.getState().start();
})();

const params = new URLSearchParams(window.location.search);
const isDetailWindow = params.has("task") || params.has("decision");

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isDetailWindow ? <TaskWindow /> : <App />}
  </React.StrictMode>,
);
