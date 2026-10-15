//! Native macOS notifications with action buttons.
//!
//! Action buttons require UNUserNotificationCenter, which only serves properly
//! bundled .app processes — from `tauri dev` (bare binary) this module is a
//! no-op and callers fall back to tauri-plugin-notification (no buttons).
//!
//! Routing: the notification request identifier is the ask id; each option
//! becomes a UNNotificationAction whose identifier is the option id. The
//! delegate emits Tauri events the webview listens for:
//!   "ask-action" { ask_id, option_id }  — an option button was pressed
//!   "open-ask"   { ask_id }             — the notification body was clicked

use std::sync::atomic::{AtomicBool, Ordering};

use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, ProtocolObject};
use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_foundation::{NSError, NSObjectProtocol, NSString, NSSet, NSMutableArray};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationAction,
    UNNotificationActionOptions, UNNotificationCategory, UNNotificationCategoryOptions,
    UNNotificationDefaultActionIdentifier, UNNotificationDismissActionIdentifier,
    UNNotificationRequest, UNNotificationResponse, UNNotificationSound,
    UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use block2::{DynBlock, RcBlock};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Deserialize)]
pub struct AskOptionDto {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Serialize)]
struct AskActionEvent {
    ask_id: String,
    option_id: String,
}

#[derive(Clone, Serialize)]
struct OpenAskEvent {
    ask_id: String,
}

static AUTH_REQUESTED: AtomicBool = AtomicBool::new(false);

struct DelegateIvars {
    app: AppHandle,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "BridgeNotifyDelegate"]
    #[ivars = DelegateIvars]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        unsafe fn did_receive_response(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion_handler: &DynBlock<dyn Fn()>,
        ) {
            let action = response.actionIdentifier().to_string();
            let ask_id = response.notification().request().identifier().to_string();
            completion_handler.call(());

            let default_id = UNNotificationDefaultActionIdentifier.to_string();
            let dismiss_id = UNNotificationDismissActionIdentifier.to_string();
            if action == dismiss_id {
                return;
            }
            if action == default_id {
                let _ = self.ivars().app.emit("open-ask", OpenAskEvent { ask_id });
            } else {
                let _ = self.ivars().app.emit(
                    "ask-action",
                    AskActionEvent {
                        ask_id,
                        option_id: action,
                    },
                );
            }
        }
    }
);

impl Delegate {
    fn new(app: AppHandle) -> Retained<Delegate> {
        let mtm = MainThreadMarker::new().expect("notification delegate must be created on main thread");
        let this = Delegate::alloc(mtm).set_ivars(DelegateIvars { app });
        unsafe { msg_send![super(this), init] }
    }
}

/// Only UNUserNotificationCenter inside a real .app bundle is usable.
pub fn bundled() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.canonicalize().ok())
        .map(|p| p.to_string_lossy().contains(".app/"))
        .unwrap_or(false)
}

/// Ask for notification permission at launch so the dialog precedes any ask.
pub fn ensure_authorized() {
    if !bundled() || AUTH_REQUESTED.swap(true, Ordering::Relaxed) {
        return;
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let block = RcBlock::new(move |_granted: Bool, _err: *mut NSError| {});
    center.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
        &block,
    );
}

/// Install the delegate that turns notification button presses into events.
/// Leak the delegate: the center only holds a weak reference.
pub fn install_delegate(app: AppHandle) {
    if !bundled() {
        return;
    }
    let delegate = Delegate::new(app);
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let proto: &ProtocolObject<dyn UNUserNotificationCenterDelegate> =
        ProtocolObject::from_ref(&*delegate);
    center.setDelegate(Some(proto));
    std::mem::forget(delegate);
}

thread_local! {
    static CATEGORIES: std::cell::RefCell<Vec<Retained<UNNotificationCategory>>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

/// Send one actionable notification. Must be called on the main thread.
/// Returns false when the native path is unavailable (dev run) — caller falls back.
pub fn send_ask_main_thread(
    ask_id: &str,
    title: &str,
    body: &str,
    options: &[AskOptionDto],
) -> bool {
    if !bundled() {
        return false;
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();

    let actions: Vec<Retained<UNNotificationAction>> = options
        .iter()
        .take(4)
        .map(|o| {
            UNNotificationAction::actionWithIdentifier_title_options(
                &NSString::from_str(&o.id),
                &NSString::from_str(&shorten(&o.label, 24)),
                UNNotificationActionOptions(0),
            )
        })
        .collect();

    CATEGORIES.with(|cats| {
        let mut list = cats.borrow_mut();
        list.retain(|cat| cat.identifier().to_string() != ask_id);

        let intents = NSMutableArray::<NSString>::new();
        let actions_arr = NSMutableArray::<UNNotificationAction>::new();
        for a in &actions {
            actions_arr.addObject(a);
        }
        let category = UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
            &NSString::from_str(ask_id),
            &actions_arr,
            &intents,
            UNNotificationCategoryOptions(0),
        );
        list.push(category);

        let all = NSMutableArray::<UNNotificationCategory>::new();
        for c in list.iter() {
            all.addObject(c);
        }
        let set = NSSet::setWithArray(&all);
        center.setNotificationCategories(&set);
    });

    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    content.setCategoryIdentifier(&NSString::from_str(ask_id));
    content.setThreadIdentifier(&NSString::from_str(ask_id));
    content.setSound(Some(&UNNotificationSound::defaultSound()));

    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSString::from_str(ask_id),
        &content,
        None,
    );
    center.addNotificationRequest_withCompletionHandler(&request, None);
    true
}

fn shorten(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max.saturating_sub(1)).collect();
    format!("{cut}…")
}
