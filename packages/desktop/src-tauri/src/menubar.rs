//! Native menu bar + tray — the usual macOS pattern. The desktop is its own
//! resizable window (no tray-anchored panel): "Open Bridge" shows and focuses
//! it; Settings / Logout emit events the UI acts on (page navigation, token
//! logout); Quit exits.

use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    // ---- native menu bar (app menu on macOS) ----
    let open_item = tauri::menu::MenuItem::with_id(app, "open", "Open Bridge", true, None::<&str>)?;
    let settings_item = tauri::menu::MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let logout_item = tauri::menu::MenuItem::with_id(app, "logout", "Logout", true, None::<&str>)?;
    let quit_item = tauri::menu::MenuItem::with_id(app, "quit", "Quit Bridge", true, None::<&str>)?;

    let menu = tauri::menu::MenuBuilder::new(app)
        .item(&open_item)
        .separator()
        .item(&settings_item)
        .item(&logout_item)
        .separator()
        .item(&quit_item)
        .build()?;

    // macOS: native menu bar; other platforms: window menu
    app.set_menu(menu.clone())?;

    // ---- tray (same four actions, condensed) ----
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
    let tray_menu = tauri::menu::MenuBuilder::new(app)
        .item(&open_item)
        .item(&settings_item)
        .item(&logout_item)
        .separator()
        .item(&quit_item)
        .build()?;

    TrayIconBuilder::with_id("bridge-tray")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Bridge")
        .menu(&tray_menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .build(app)?;

    // native menu events + tray menu events share one handler
    app.on_menu_event(move |app, event| handle_menu(app, event.id().as_ref()));

    Ok(())
}

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "open" => show_main(app),
        "settings" => {
            show_main(app);
            let _ = app.emit("goto-settings", ());
        }
        "logout" => {
            let _ = app.emit("do-logout", ());
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}
