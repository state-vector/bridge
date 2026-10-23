mod console;
mod dispatch;
mod keychain;
mod mac_notify;
mod menubar;
mod opencode;
mod scm;
mod session;
mod transport;

pub use keychain::*;
pub use session::*;
pub use mac_notify::*;
pub use menubar::*;
pub use scm::*;
pub use transport::*;


use serde::Deserialize;
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

#[derive(Deserialize)]
struct NotifyAskArgs {
    ask_id: String,
    asker: String,
    question: String,
    options: Vec<mac_notify::AskOptionDto>,
    urgent: bool,
}

/// Dispatch a decision to the OS notification surface.
/// Native buttons when bundled (.app); plain notification otherwise.
#[tauri::command]
fn notify_ask(app: tauri::AppHandle, args: NotifyAskArgs) -> bool {
    let title = if args.urgent {
        format!("Now — {} needs a decision", args.asker)
    } else {
        format!("{} needs a decision", args.asker)
    };
    let dispatched = app.run_on_main_thread({
        let ask_id = args.ask_id.clone();
        let title = title.clone();
        let question = args.question.clone();
        let options = args.options.clone();
        move || {
            mac_notify::send_ask_main_thread(&ask_id, &title, &question, &options);
        }
    });
    let _ = dispatched;
    let native = mac_notify::bundled();
    if !native {
        let _ = app
            .notification()
            .builder()
            .title(&title)
            .body(&args.question)
            .show();
    }
    native
}

// ---- dispatch commands (webapp settings can drive these via invoke) ----

#[tauri::command]
fn dispatch_status(state: tauri::State<'_, dispatch::DispatchState>) -> serde_json::Value {
    state.status()
}

/// The resolved dispatch config (env > ~/.bridge/config.json), so the settings
/// page can edit fields (concurrency, backend, model) and re-start the loop
/// with the full shape. Null when unconfigured (pairing still needed).
#[tauri::command]
fn dispatch_config() -> serde_json::Value {
    match dispatch::DispatchConfig::resolve() {
        Some(c) => serde_json::to_value(&c).unwrap_or_default(),
        None => serde_json::Value::Null,
    }
}

#[tauri::command]
fn dispatch_snapshot(state: tauri::State<'_, dispatch::DispatchState>) -> serde_json::Value {
    // in-process loop: the live snapshot is authoritative. Otherwise observe
    // an external (headless) runner via its flat-file state — the panel used
    // to go stale whenever the loop ran in a separate process.
    if state.running.load(std::sync::atomic::Ordering::Relaxed) {
        return state.snapshot.lock().map(|s| serde_json::to_value(&*s).unwrap_or_default()).unwrap_or_default();
    }
    dispatch::external_snapshot().unwrap_or(serde_json::Value::Null)
}

/// "For you" — the human's inbox (proposed decisions, blocked work, questions).
/// Read-only; human-authoritative actions ride the kb_* commands as the human
/// session (actor `web`).
#[tauri::command]
async fn kb_board() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| session::kb_request("GET", "/api/kb/board", None))
        .await
        .map_err(|e| e.to_string())?
}

/// Generic knowledge-plane door for the shell UI: path must be under
/// /api/kb/. Auth is the human session cookie ONLY (set in session.rs by
/// construction) — the gateway bearer cannot appear here even by accident.
#[tauri::command]
async fn kb_fetch(path: String, method: Option<String>, body: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    let method = method.unwrap_or_else(|| "GET".into());
    tauri::async_runtime::spawn_blocking(move || session::kb_request(&method, &path, body))
        .await
        .map_err(|e| e.to_string())?
}

/// Who is signed in (live probe of the hub's /api/session).
#[tauri::command]
async fn session_get() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(session::probe)
        .await
        .map_err(|e| e.to_string())
}

/// GitHub OAuth login for the desktop: opens the hub's /login with the
/// desktop handshake (loopback listener) in the OS browser, awaits the
/// callback, stores the session. Blocking up to 10 min on the callback.
#[tauri::command]
async fn session_login(app: tauri::AppHandle, url: Option<String>) -> Result<serde_json::Value, String> {
    use tauri_plugin_opener::OpenerExt;
    let hub = match url.filter(|u| !u.trim().is_empty()) {
        Some(u) => u.trim().to_string(),
        None => session::load()
            .map(|s| s.url)
            .or_else(|| dispatch::DispatchConfig::resolve().map(|c| c.url))
            .ok_or("hub url required for first sign-in")?,
    };
    tauri::async_runtime::spawn_blocking(move || {
        let opener = app.opener();
        session::login(&hub, &move |u: String| {
            let _ = opener.open_url(&u, None::<&str>);
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map(|s| {
        serde_json::json!({
            "signed_in": true, "user": s.user, "ws": s.ws,
            "expires_ts": s.expires_ts, "url": s.url,
        })
    })
}

/// Sign out of the human session (the gateway token is separate — see logout).
#[tauri::command]
fn session_logout() -> Result<(), String> {
    session::clear();
    Ok(())
}

/// One console turn: retrieve board artefacts for the question, then
/// summarise/answer with the on-device Apple model (fallback: backend CLI).
/// Read-only — the console never claims or writes work.
#[tauri::command]
async fn chat_send(question: String, history: Vec<serde_json::Value>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || console::chat_turn(&question, &history))
        .await
        .map_err(|e| e.to_string())?
}

/// Second pass after an answer: does the exchange imply a new task? Returns
/// a DRAFT ({title, body}) or null — the UI must confirm before creating.
#[tauri::command]
async fn chat_propose_task(question: String, answer: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || console::propose_task(&question, &answer))
        .await
        .map_err(|e| e.to_string())?
        .map(|v| v.unwrap_or(serde_json::Value::Null))
}

/// The human CONFIRMED a chat-drafted task — create it on the hub via MCP.
#[tauri::command]
async fn dispatch_create_task(title: String, body: String) -> Result<serde_json::Value, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("title required".into());
    }
    tauri::async_runtime::spawn_blocking(move || dispatch::create_task(&title, body.trim()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn dispatch_start(
    state: tauri::State<'_, dispatch::DispatchState>,
    config: Option<dispatch::DispatchConfig>,
) -> Result<(), String> {
    let cfg = config.or_else(dispatch::DispatchConfig::resolve);
    dispatch::start(&state, cfg)
}

#[tauri::command]
fn dispatch_stop(state: tauri::State<'_, dispatch::DispatchState>) {
    dispatch::stop(&state);
}

/// Settings "Reconnect gateway": re-vend the gateway token via the human
/// session (the login is the standing approval) and restart the loop.
#[tauri::command]
fn gateway_reconnect(state: tauri::State<'_, dispatch::DispatchState>) -> Result<serde_json::Value, String> {
    dispatch::reconnect(&state)
}

/// Log out: stop the runner and clear the gateway token (settings are kept),
/// returning the app to its onboarding state (pair again to vend a fresh
/// gateway token).
#[tauri::command]
fn logout(state: tauri::State<'_, dispatch::DispatchState>) {
    dispatch::logout(&state);
}

/// UI-driven onboarding, step 1: register the device, return the enter-code.
/// The user confirms at <hub>/pair; the UI then polls pair_poll.
#[tauri::command]
async fn pair_start(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let device = std::process::Command::new("hostname")
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "device".into());
        let principal = dispatch::ensure_principal_from_file();
        dispatch::pair_start(&client, url.trim_end_matches('/'), &device, &principal)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// UI-driven onboarding, step 2: one poll for the entered code. On
/// authorization the token is merged into the existing config (settings are
/// preserved) and saved. The UI polls every ~3s.
#[tauri::command]
async fn pair_poll(url: String, code: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        match dispatch::pair_poll(&client, url.trim_end_matches('/'), &code)? {
            dispatch::PairPoll::Pending => Ok(serde_json::json!({ "status": "pending" })),
            dispatch::PairPoll::SlowDown => Ok(serde_json::json!({ "status": "pending" })),
            dispatch::PairPoll::Authorized(cfg) => Ok(serde_json::to_value(&cfg).unwrap_or_default())
                .map(|v| serde_json::json!({ "status": "authorized", "config": v })),
            dispatch::PairPoll::Expired => Ok(serde_json::json!({ "status": "expired" })),
            dispatch::PairPoll::Failed(e) => Err(e),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Open a URL in the system browser. The webview's window.open does not
/// reach the OS (and target=_blank is trapped) — everything that must open
/// externally goes through the opener plugin here.
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// CLI flag lookup: `--flag value` → parsed value (u64), None when absent/invalid.
fn cli_u64(name: &str) -> Option<u64> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse().ok())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(dispatch::DispatchState::new())
        .invoke_handler(tauri::generate_handler![
            notify_ask,
            dispatch_status,
            dispatch_config,
            dispatch_snapshot,
            kb_board,
            kb_fetch,
            session_get,
            session_login,
            session_logout,
            chat_send,
            chat_propose_task,
            dispatch_create_task,
            dispatch_start,
            dispatch_stop,
            gateway_reconnect,
            logout,
            pair_start,
            pair_poll,
            open_external,
        ])
        .setup(|app| {
            // Regular activation policy: this is a REAL desktop app — Dock
            // icon, Cmd+Tab presence, closable. (Accessory was the old
            // tray-panel mode: the app vanished from Cmd+Tab once unfocused.)

            let handle = app.handle().clone();
            #[cfg(target_os = "macos")]
            {
                mac_notify::ensure_authorized();
                mac_notify::install_delegate(handle.clone());
            }

            // headless mode: no tray, no panel — just the dispatch loop
            let headless = std::env::args().any(|a| a == "--headless");
            if !headless {
                menubar::setup(app)?;
                // watch the inbox for new proposed decisions — OS notification
                // per arrival, independent of whether the dispatch loop runs
                console::start_decision_watch(handle.clone());
            }

            // auto-start dispatch: headless pairs (device flow) if unconfigured;
            // menubar mode only auto-starts when a config already exists
            let mut cfg = dispatch::DispatchConfig::resolve();
            if let Some(c) = cfg.as_mut() {
                // CLI override: `--max-sessions N` wins over env/file config.
                if let Some(n) = cli_u64("--max-sessions") {
                    c.max_sessions = n.max(1) as usize;
                }
            }
            if headless || cfg.is_some() {
                let state = app.state::<dispatch::DispatchState>();
                if let Some(pid) = dispatch::external_runner_pid() {
                    // a headless runner already polls this hub from another
                    // process — observe it, never race it for claims
                    eprintln!("[dispatch] runner live in pid {pid} — observing, not starting a second loop");
                } else {
                    dispatch::start(&state, cfg)?;
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // daemon semantics: closing the window keeps the dispatch loop
            // running — the window hides to the tray; quit via the tray/app
            // menu Quit.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
