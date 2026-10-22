import React from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { App } from "./App";
import { setKbHubConfig, useKb } from "@bridge/ui-kit";
import "@bridge/ui-kit/tokens.css";
import "@bridge/ui-kit/ui-kit.css";
import "@bridge/ui-kit/views.css";
import "./styles.css";

// The shell renders the SAME knowledge views as the webapp, off the SAME data
// layer — the gateway's hub url + token (host config) drive the kit client.
void (async () => {
  try {
    const cfg = await invoke<{ url?: string; token?: string }>("dispatch_config");
    if (cfg?.url && cfg?.token) {
      setKbHubConfig({ url: cfg.url, token: cfg.token });
      useKb.getState().start();
    }
  } catch { /* logged out — views show their empty states */ }
})();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
