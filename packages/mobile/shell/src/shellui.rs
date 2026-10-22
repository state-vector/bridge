//! Shell glue between the app webview and the hub:
//! - sign-in bridge: the injected script routes the webview through the hub's
//!   own `/login?shell=1` flow (GitHub OAuth or the password-mode form); the
//!   navigation hook brings the webview back once the session cookie is minted
//!   on the hub origin. mobile-ui stays fork-free — the hub URL comes from the
//!   same localStorage key the UI already writes (`bridge.url`).
//! - the initialization script: a shell-owned ask-watch that polls hub
//!   /api/state for open decisions and hands them to the Rust notification
//!   core, plus a 401-triggered sign-in affordance. Nothing here changes the
//!   @bridge/mobile-ui dist (PR bridge#40's fork-free contract).

use tauri::Url;

/// One ask option — same shape the desktop `notify_ask` command receives.
/// Lives here (target-independent) so the command args compile everywhere.
#[derive(Clone, serde::Deserialize)]
pub struct AskOptionDto {
    pub id: String,
    pub label: String,
}

/// Shared sign-in state: set when the shell starts a `/login?shell=1` flow,
/// cleared when the webview lands back on the hub root post-callback.
pub struct SignInState(std::sync::Mutex<Option<Url>>);

impl SignInState {
    pub fn new() -> Self {
        Self(std::sync::Mutex::new(None))
    }

    pub fn begin(&self, hub: &str) {
        *self.0.lock().unwrap() = Url::parse(hub).ok().filter(|u| u.host_str().is_some());
    }

    fn signing_in(&self) -> bool {
        self.0.lock().unwrap().is_some()
    }

    /// True when `url` is the recorded hub origin's root — where both the
    /// GitHub OAuth callback and the password form redirect after success.
    fn is_hub_landing(&self, url: &Url) -> bool {
        let Some(hub) = &*self.0.lock().unwrap() else { return false };
        url.host_str() == hub.host_str()
            && url.port() == hub.port()
            && url.scheme() == hub.scheme()
            && url.path() == "/"
    }

    fn finish(&self) {
        *self.0.lock().unwrap() = None;
    }
}

/// Handles top-level navigations while a sign-in flow is in flight.
/// Returns true to allow the navigation, false to block it.
pub fn on_navigation(app: &tauri::AppHandle, url: &Url) -> bool {
    use tauri::Manager;
    let state = app.state::<SignInState>();
    if !state.signing_in() {
        return true;
    }
    // Sign-in leg: the hub login route(s) and GitHub's OAuth pages must load.
    let host = url.host_str().unwrap_or_default();
    if host == "github.com" || url.path().starts_with("/login") {
        println!("[shell] sign-in navigation allowed: {url}");
        return true;
    }
    // Post-callback landing on the hub root: the session cookie is minted —
    // block the hub SPA and bring the webview back to the app.
    if state.is_hub_landing(url) {
        state.finish();
        println!("[shell] sign-in complete — returning to app");
        if let Some(webview) = app.get_webview_window("main") {
            let _ = webview.eval("location.replace('tauri://localhost/index.html')");
        }
        return false;
    }
    true
}

/// Injected into the app webview before any page script runs.
pub const INIT_SCRIPT: &str = r#"(function () {
  if (window.__bridgeShell) return; window.__bridgeShell = true;
  var HUB_KEY = "bridge.url";
  var SEEN_KEY = "bridge.shell.notified";
  var hub = function () { return (localStorage.getItem(HUB_KEY) || "").replace(/\/$/, ""); };
  var log = function () { try { console.log.apply(console, ["[bridge-shell]"].concat([].slice.call(arguments))); } catch (e) {} };
  var invoke = function (cmd, args) {
    var t = window.__TAURI_INTERNALS__;
    if (!t) { log("no tauri ipc"); return Promise.reject(new Error("no ipc")); }
    return t.invoke(cmd, args);
  };

  // ---- sign-in affordance (shell-owned; the mobile-ui dist stays untouched) ----
  var banner = null;
  var showBanner = function () {
    if (banner || !document.body) return;
    banner = document.createElement("button");
    banner.textContent = "Sign in to hub";
    banner.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:24px;z-index:2147483647;" +
      "padding:12px 22px;border-radius:999px;border:0;background:#4f46e5;color:#fff;" +
      "font:600 15px -apple-system,system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35)";
    banner.onclick = function () {
      var h = hub();
      if (!h) { log("no hub url — enter it in Connect first"); return; }
      invoke("shell_sign_in", { hub: h }).then(function () {
        log("navigating to sign-in:", h + "/login?shell=1");
        location.href = h + "/login?shell=1";
      });
    };
    document.body.appendChild(banner);
    log("auth needed — sign-in banner shown");
  };
  var hideBanner = function () { if (banner) { banner.remove(); banner = null; log("session ok — banner hidden"); } };

  // Wrap fetch to notice hub 401s (the app shows only generic "hub unreachable").
  var origFetch = window.fetch.bind(window);
  window.fetch = function () {
    var args = arguments;
    return origFetch.apply(null, args).then(function (r) {
      try {
        var u = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
        if (r.status === 401 && hub() && u.indexOf(hub()) === 0) showBanner();
      } catch (e) {}
      return r;
    });
  };

  // ---- ask-watch: poll hub /api/state, notify open decisions via the Rust core ----
  var readSeen = function () { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || "[]"); } catch (e) { return []; } };
  var writeSeen = function (ids) { try { localStorage.setItem(SEEN_KEY, JSON.stringify(ids.slice(-200))); } catch (e) {} };
  var poll = function () {
    var h = hub();
    if (!h) { return Promise.resolve(); }
    return origFetch(h + "/api/state", { credentials: "include" }).then(function (r) {
      if (r.status === 401) { showBanner(); return null; }
      if (!r.ok) { log("state poll status", r.status); return null; }
      return r.json().then(function (s) {
        hideBanner();
        var open = (s.decisions || []).filter(function (d) { return d.status === "open"; });
        var seen = readSeen();
        var chain = Promise.resolve();
        open.forEach(function (d) {
          if (seen.indexOf(d.id) !== -1) return;
          seen.push(d.id);
          chain = chain.then(function () {
            log("notify:", d.id, d.title || "");
            return invoke("notify_ask", {
              args: {
                ask_id: String(d.id),
                asker: String(d.asker || "hub"),
                question: String(d.title || d.reason || ""),
                urgent: !!d.urgency,
                options: Array.isArray(d.options) ? d.options : []
              }
            }).catch(function (e) { log("notify_ask failed:", e); });
          });
        });
        writeSeen(seen);
        return chain;
      });
    }).catch(function (e) { log("poll failed:", String(e)); });
  };
  setInterval(function () { void poll(); }, 60000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) void poll(); });
  window.setTimeout(function () { void poll(); }, 2500);
  log("shell init ok (ask-watch 60s, sign-in bridge armed)");
})();
"#;
