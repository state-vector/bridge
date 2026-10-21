//! Native menu bar + tray — Docker-style. The desktop is its own resizable
//! window. Left-click on the tray icon opens the menu; the menu leads with a
//! live Status line, then actions: Open Bridge, Settings, Logout, Quit.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

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
    app.set_menu(menu)?;

    // ---- tray (Docker-style: click opens the menu, Status leads) ----
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
    let status_item = tauri::menu::MenuItem::with_id(app, "status", "Status — starting…", false, None::<&str>)?;
    let open_item = tauri::menu::MenuItem::with_id(app, "open", "Open Bridge", true, None::<&str>)?;
    let settings_item = tauri::menu::MenuItem::with_id(app, "t-settings", "Settings", true, None::<&str>)?;
    let logout_item = tauri::menu::MenuItem::with_id(app, "t-logout", "Logout", true, None::<&str>)?;
    let quit_item = tauri::menu::MenuItem::with_id(app, "quit", "Quit Bridge", true, None::<&str>)?;

    let tray_menu = tauri::menu::MenuBuilder::new(app)
        .item(&status_item)
        .separator()
        .item(&open_item)
        .item(&settings_item)
        .item(&logout_item)
        .separator()
        .item(&quit_item)
        .build()?;

    // live status: read the dispatch loop's running flag every 2s
    let running = app
        .try_state::<crate::dispatch::DispatchState>()
        .map(|s| s.running.clone())
        .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
    let status_handle = status_item.clone();
    std::thread::spawn(move || loop {
        let on = running.load(Ordering::Relaxed);
        let _ = status_handle.set_text(if on { "Status — running" } else { "Status — stopped" });
        std::thread::sleep(Duration::from_secs(2));
    });

    TrayIconBuilder::with_id("bridge-tray")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Bridge")
        .menu(&tray_menu)
        // Docker behavior: clicking the icon opens the menu (left or right)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .build(app)?;

    // native menu events share the handler
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
        "t-settings" => {
            show_main(app);
            let _ = app.emit("goto-settings", ());
        }
        "logout" => {
            let _ = app.emit("do-logout", ());
        }
        "t-logout" => {
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
