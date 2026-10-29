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
//! - `voice` + `console` + `fm` + `mcp` (BR#4782): the voice console legs —
//!   on-device STT/TTS, the Apple-FM tool loop and the hub MCP client.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "ios")]
mod ios_notify;
#[cfg(target_os = "ios")]
mod fm;
mod console;
mod mcp;
#[cfg(target_os = "ios")]
mod voice;
mod shellui;

use serde::Deserialize;
use serde_json::Value;
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

// ---- voice console (BR#4782) -----------------------------------------------
// Commands are declared on every target (the webview calls them the same way
// everywhere); the legs are iOS-only. On non-iOS builds they fail with a
// named error so a stray browser/simulator call reads honestly.

#[cfg(target_os = "ios")]
fn speak_inner(_app: tauri::AppHandle, text: String) -> Result<(), String> {
    voice::speak(&text)
}
#[cfg(not(target_os = "ios"))]
fn speak_inner(_app: tauri::AppHandle, _text: String) -> Result<(), String> {
    Err("voice requires the iOS app".into())
}

#[cfg(target_os = "ios")]
fn listen_start_inner(app: tauri::AppHandle) -> Result<(), String> {
    voice::listen_start(app)
}
#[cfg(not(target_os = "ios"))]
fn listen_start_inner(_app: tauri::AppHandle) -> Result<(), String> {
    Err("voice requires the iOS app".into())
}

#[cfg(target_os = "ios")]
fn speak_stop_inner(_app: tauri::AppHandle) {
    voice::speak_stop();
}
#[cfg(not(target_os = "ios"))]
fn speak_stop_inner(_app: tauri::AppHandle) {}

#[derive(Deserialize)]
struct VoiceTurnArgs {
    hub: String,
    token: String,
    question: String,
    #[serde(default)]
    history: Vec<Value>,
}

/// One console turn: STT transcript in → spoken answer out. Runs the FM tool
/// loop over hub MCP; blocking by design (the webview shows a thinking state).
#[tauri::command]
fn voice_turn(app: tauri::AppHandle, args: VoiceTurnArgs) -> Result<Value, String> {
    println!("[shell] voice_turn q={:?}", args.question);
    let result = console::voice_turn(&args.hub, &args.token, &args.question, &args.history);

    // E2E receipt (BR#4782 simulator lane): the sim app's stdout is not
    // capturable, so when E2E_VOICE_OUT names a file the turn writes itself
    // there (app-sandbox tmp) for the drive script to fetch. Unset normally.
    if let Ok(out) = std::env::var("E2E_VOICE_OUT") {
        let body = match &result {
            Ok(v) => v.to_string(),
            Err(e) => serde_json::json!({ "error": e }).to_string(),
        };
        let path = std::env::temp_dir().join(out);
        if let Err(e) = std::fs::write(&path, body) {
            println!("[shell] e2e receipt write failed: {e}");
        }
    }

    match &result {
        Ok(v) => {
            // Speak the answer when the turn produced one.
            if let Some(answer) = v.get("answer").and_then(|a| a.as_str()) {
                if !answer.is_empty() {
                    if let Err(e) = speak_inner(app, answer.to_string()) {
                        println!("[shell] speak after turn failed: {e}");
                    }
                }
            }
        }
        Err(e) => {
            let _ = speak_inner(app, format!("Something went wrong. {e}"));
        }
    }
    result
}

/// Execute a confirmed ask answer — the human already said yes.
#[tauri::command]
fn voice_confirm_answer(hub: String, token: String, ask_id: String, answer: String) -> Result<Value, String> {
    println!("[shell] voice_confirm_answer {ask_id}");
    console::confirm_answer(&hub, &token, &ask_id, &answer)
}

#[tauri::command]
fn voice_listen_start(app: tauri::AppHandle) -> Result<(), String> {
    println!("[shell] voice_listen_start");
    listen_start_inner(app)
}

#[tauri::command]
fn voice_listen_stop() -> Result<(), String> {
    println!("[shell] voice_listen_stop");
    #[cfg(target_os = "ios")]
    {
        voice::listen_stop()
    }
    #[cfg(not(target_os = "ios"))]
    {
        Err("voice requires the iOS app".into())
    }
}

#[tauri::command]
fn voice_speak(app: tauri::AppHandle, text: String) -> Result<(), String> {
    let _ = app;
    speak_inner(app, text)
}

#[tauri::command]
fn voice_speak_stop(app: tauri::AppHandle) {
    speak_stop_inner(app);
}

#[tauri::command]
fn voice_permissions() -> Value {
    #[cfg(target_os = "ios")]
    {
        voice::permission_status()
    }
    #[cfg(not(target_os = "ios"))]
    {
        serde_json::json!({ "speech": "unsupported", "mic": "unsupported" })
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(shellui::SignInState::new())
        .invoke_handler(tauri::generate_handler![
            notify_ask,
            shell_sign_in,
            voice_turn,
            voice_confirm_answer,
            voice_listen_start,
            voice_listen_stop,
            voice_speak,
            voice_speak_stop,
            voice_permissions
        ])
        .setup(|app| {
            // Permission prompt at launch so the dialog precedes any ask.
            #[cfg(target_os = "ios")]
            {
                ios_notify::ensure_authorized();
                ios_notify::install_delegate(app.handle().clone());
                voice::init(app.handle().clone());
                voice::request_permissions();
            }

            let handle = app.handle().clone();
            // E2E hook (see shellui::e2e_boot_script): launch env pre-connects
            // the shell and arms the login auto-submit. Unset in normal runs.
            let e2e = std::env::var("E2E_HUB_URL").ok().map(|hub| {
                let pass = std::env::var("E2E_HUB_PASSWORD").ok();
                let voice = std::env::var("E2E_VOICE_TEXT").ok();
                let voice_token = std::env::var("E2E_VOICE_TOKEN").ok();
                shellui::e2e_boot_script(&hub, pass.as_deref(), voice.as_deref(), voice_token.as_deref())
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
