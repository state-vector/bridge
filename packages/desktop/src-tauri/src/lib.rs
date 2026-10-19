mod dispatch;
mod mac_notify;
mod menubar;
mod opencode;

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
    state.snapshot.lock().map(|s| serde_json::to_value(&*s).unwrap_or_default()).unwrap_or_default()
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
            dispatch_start,
            dispatch_stop,
            menubar::show_panel,
            menubar::hide_panel
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

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
                dispatch::start(&state, cfg)?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(false) = event {
                if window.label() == "main" {
                    #[cfg(target_os = "macos")]
                    menubar::hide_panel_win(window.app_handle());
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
