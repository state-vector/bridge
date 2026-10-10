mod mac_notify;
mod menubar;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            notify_ask,
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

            menubar::setup(app)?;
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
