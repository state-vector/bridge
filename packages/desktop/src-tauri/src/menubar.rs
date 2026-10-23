//! Native menu bar + tray — Docker-style. The desktop is its own resizable
//! window; clicking the tray icon opens the menu.
//!
//! Menus follow the auth state: logged out, the only options are
//! "Sign in with GitHub" (the human-session onboarding) and Quit. Signed in,
//! the full menu appears: live Status, Open Bridge, Settings, Sign out, Quit.
//! (Credential-class ADR BR#2673: the UI follows the HUMAN session; the
//! gateway token is invisible infrastructure and never gates the menu.)

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

fn paired() -> bool {
    crate::session::load().is_some()
}

pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    // ---- shared items ----
    let status_item = tauri::menu::MenuItem::with_id(app, "status", "Status — starting…", false, None::<&str>)?;
    let open_item = tauri::menu::MenuItem::with_id(app, "open", "Open Bridge", true, None::<&str>)?;
    let settings_item = tauri::menu::MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let logout_item = tauri::menu::MenuItem::with_id(app, "logout", "Sign out", true, None::<&str>)?;
    let quit_item = tauri::menu::MenuItem::with_id(app, "quit", "Quit Bridge", true, None::<&str>)?;
    let signin_item = tauri::menu::MenuItem::with_id(app, "signin", "Sign in with GitHub…", true, None::<&str>)?;

    // ---- paired menu: live status + full actions ----
    let menu_full = tauri::menu::MenuBuilder::new(app)
        .item(&status_item)
        .separator()
        .item(&open_item)
        .item(&settings_item)
        .item(&logout_item)
        .separator()
        .item(&quit_item)
        .build()?;

    // ---- logged-out menu: Sign in and Quit — nothing else is usable ----
    let menu_pair = tauri::menu::MenuBuilder::new(app)
        .item(&signin_item)
        .separator()
        .item(&quit_item)
        .build()?;

    // ---- native menu bar (app menu on macOS) ----
    let app_menu_full = tauri::menu::MenuBuilder::new(app)
        .item(&open_item)
        .separator()
        .item(&settings_item)
        .item(&logout_item)
        .separator()
        .item(&quit_item)
        .build()?;
    let app_menu_pair = tauri::menu::MenuBuilder::new(app)
        .item(&signin_item)
        .separator()
        .item(&quit_item)
        .build()?;

    let start_paired = paired();
    app.set_menu(if start_paired {
        app_menu_full.clone()
    } else {
        app_menu_pair.clone()
    })?;

    // ---- tray ----
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
    let tray = TrayIconBuilder::with_id("bridge-tray")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Bridge")
        .menu(if start_paired { &menu_full } else { &menu_pair })
        // Docker behavior: clicking the icon opens the menu
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .build(app)?;

    // ---- state watcher: swap menus on auth flips, tick the status line ----
    let running = app
        .try_state::<crate::dispatch::DispatchState>()
        .map(|s| s.running.clone())
        .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
    let app_handle = app.handle().clone();
    std::thread::spawn(move || {
        let mut last_paired = start_paired;
        loop {
            let p = paired();
            if p != last_paired {
                last_paired = p;
                let _ = tray.set_menu(if p { Some(menu_full.clone()) } else { Some(menu_pair.clone()) });
                if p {
                    let _ = app_handle.set_menu(app_menu_full.clone());
                } else {
                    let _ = app_handle.set_menu(app_menu_pair.clone());
                }
            }
            if running.load(Ordering::Relaxed) {
                let _ = status_item.set_text("Status — running");
            } else {
                let _ = status_item.set_text("Status — stopped");
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    });

    Ok(())
}

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "signin" => {
            show_main(app);
            let _ = app.emit("do-signin", ());
        }
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
