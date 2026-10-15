use std::sync::atomic::{AtomicI64, Ordering};

use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Rect, Size, WebviewWindow};

static LAST_HIDE_MS: AtomicI64 = AtomicI64::new(0);

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?;

    let show_item = tauri::menu::MenuItem::with_id(app, "show", "Show Bridge", true, None::<&str>)?;
    let quit_item = tauri::menu::MenuItem::with_id(app, "quit", "Quit Bridge", true, None::<&str>)?;
    let menu = tauri::menu::MenuBuilder::new(app).items(&[&show_item, &quit_item]).build()?;

    TrayIconBuilder::with_id("bridge-tray")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Bridge — the decision inbox")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                toggle(tray.app_handle(), &rect);
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_panel_at_tray(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn toggle(app: &AppHandle, rect: &Rect) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        hide_panel_win(app);
    } else {
        let since_hide = now_ms() - LAST_HIDE_MS.load(Ordering::Relaxed);
        if since_hide < 350 {
            return;
        }
        position_under_icon(&win, rect);
        let _ = win.show();
        let _ = win.set_focus();
    }
}

pub fn hide_panel_win(app: &AppHandle) {
    LAST_HIDE_MS.store(now_ms(), Ordering::Relaxed);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
}

pub fn position_under_icon(win: &WebviewWindow, rect: &Rect) {
    let scale = win.scale_factor().unwrap_or(1.0);
    let (ix, iy, iw, ih) = match (rect.position, rect.size) {
        (Position::Physical(p), Size::Physical(s)) => {
            (p.x as f64, p.y as f64, s.width as f64, s.height as f64)
        }
        (Position::Logical(p), Size::Logical(s)) => {
            (p.x * scale, p.y * scale, s.width * scale, s.height * scale)
        }
        _ => (0.0, 0.0, 22.0, 22.0),
    };
    let win_size = win.outer_size().unwrap_or(PhysicalSize::new(400, 640));
    let x = (ix + iw / 2.0 - win_size.width as f64 / 2.0).max(8.0);
    let y = iy + ih + 8.0;
    let _ = win.set_position(PhysicalPosition::new(x as f64, y));
}

pub fn show_panel_at_tray(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    if let Ok(Some(mon)) = win.primary_monitor() {
        let scale = win.scale_factor().unwrap_or(1.0);
        let win_size = win.outer_size().unwrap_or(PhysicalSize::new(400, 640));
        let x = mon.size().width as f64 - win_size.width as f64 - 16.0 * scale;
        let y = 38.0 * scale;
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
    let _ = win.show();
    let _ = win.set_focus();
}

#[tauri::command]
pub fn show_panel(app: AppHandle) {
    show_panel_at_tray(&app);
}

#[tauri::command]
pub fn hide_panel(app: AppHandle) {
    hide_panel_win(&app);
}
