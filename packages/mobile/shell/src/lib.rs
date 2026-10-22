//! Bridge — native iOS shell wrapping @bridge/mobile-ui.
//!
//! Architecture (ADR BR#998): the shell wraps the existing mobile-ui dist
//! fork-free — no isTauri conditionals, no UI invoke calls added to the UI.
//! Shell-side pieces live here:
//! - `ios_notify`: the macOS notification core pattern (mac_notify.rs) ported
//!   to iOS, including the iOS-only willPresent delegate (a silent drop while
//!   foregrounded is not acceptable).
//! - `shellui`: the sign-in navigation bridge (hub /login?shell=1 in the same
//!   webview, so the session cookie lands in the app's cookie store) and the
//!   injected ask-watch that polls hub /api/state for open decisions.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "ios")]
mod ios_notify;
mod shellui;

use serde::Deserialize;
use shellui::AskOptionDto;
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[derive(Deserialize)]
struct NotifyAskArgs {
    ask_id: String,
    #[serde(default)]
    asker: String,
    #[serde(default)]
    question: String,
    #[serde(default)]
    urgent: bool,
    #[serde(default)]
    options: Vec<AskOptionDto>,
}

/// Dispatch one decision to the OS notification surface. Called by the
/// shell-injected ask-watch (never by the UI — fork-free contract).
#[tauri::command]
fn notify_ask(app: tauri::AppHandle, args: NotifyAskArgs) {
    let title = if args.urgent {
        format!("Now — {} needs a decision", args.asker)
    } else {
        format!("{} needs a decision", args.asker)
    };
    let body = if args.question.is_empty() {
        format!("{} asks for a decision", args.asker)
    } else {
        args.question.clone()
    };
    println!(
        "[shell] notify_ask ask_id={} asker={} options={}",
        args.ask_id,
        args.asker,
        args.options.len()
    );
    let ask_id = args.ask_id.clone();
    let options = args.options.clone();
    let dispatched = app.run_on_main_thread(move || {
        #[cfg(target_os = "ios")]
        ios_notify::send_ask_main_thread(&ask_id, &title, &body, &options);
        #[cfg(not(target_os = "ios"))]
        let _ = (&ask_id, &title, &body, &options);
    });
    if let Err(e) = dispatched {
        eprintln!("[shell] run_on_main_thread failed: {e}");
    }
}

/// Arm the sign-in bridge. The injected script then navigates the webview to
/// `<hub>/login?shell=1`; `shellui::on_navigation` brings it back once the
/// hub mints the session cookie on its own origin.
#[tauri::command]
fn shell_sign_in(state: tauri::State<'_, shellui::SignInState>, hub: String) -> Result<(), String> {
    let hub = hub.trim().trim_end_matches('/').to_string();
    if !(hub.starts_with("http://") || hub.starts_with("https://")) {
        return Err("hub must be an http(s) URL".into());
    }
    println!("[shell] sign-in armed for {hub}");
    state.begin(&hub);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(shellui::SignInState::new())
        .invoke_handler(tauri::generate_handler![notify_ask, shell_sign_in])
        .setup(|app| {
            // Permission prompt at launch so the dialog precedes any ask.
            #[cfg(target_os = "ios")]
            {
                ios_notify::ensure_authorized();
                ios_notify::install_delegate(app.handle().clone());
            }

            let handle = app.handle().clone();
            // E2E hook (see shellui::e2e_boot_script): launch env pre-connects
            // the shell and arms the login auto-submit. Unset in normal runs.
            let e2e = std::env::var("E2E_HUB_URL").ok().map(|hub| {
                let pass = std::env::var("E2E_HUB_PASSWORD").ok();
                shellui::e2e_boot_script(&hub, pass.as_deref())
            });
            let mut builder = WebviewWindowBuilder::new(app.handle(), "main", WebviewUrl::default())
                .title("Bridge")
                .initialization_script(shellui::INIT_SCRIPT)
                .on_navigation(move |url| shellui::on_navigation(&handle, &url));
            if let Some(script) = e2e {
                builder = builder.initialization_script(script);
            }
            builder.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
