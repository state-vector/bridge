import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { getConfig, isTauri } from "./lib/config";

// Desktop + live mode: run the deployed webapp same-origin (Access SSO just works,
// WS is first-party). Mock/local mode stays on the bundled app.
const cfg = getConfig();
if (
  isTauri() &&
  cfg.mode === "live" &&
  !window.location.href.startsWith(cfg.url)
) {
  window.location.replace(cfg.url);
} else {
  class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
    state = { error: null as Error | null };

    static getDerivedStateFromError(error: Error) {
      return { error };
    }

    render() {
      if (this.state.error) {
        return (
          <div style={{ padding: 32, fontFamily: "sans-serif", color: "#e8edf4", background: "#0e1116", height: "100vh" }}>
            <h2 style={{ fontWeight: 700 }}>Bridge hit an error</h2>
            <pre style={{ color: "#8a95a6", whiteSpace: "pre-wrap", fontSize: 12 }}>{String(this.state.error.stack ?? this.state.error)}</pre>
            <button
              onClick={() => this.setState({ error: null })}
              style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #232b38", background: "#1c2330", color: "#e8edf4", cursor: "pointer" }}
            >
              Retry
            </button>
          </div>
        );
      }
      return this.props.children;
    }
  }

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
