//! Native iOS notifications — the mac_notify.rs pattern carried over.
//!
//! Same routing as the desktop core (`packages/desktop/src-tauri/src/mac_notify.rs`):
//! the notification request identifier is the ask id; each option becomes a
//! UNNotificationAction whose identifier is the option id; the delegate emits
//! Tauri events the webview can listen for:
//!   "ask-action" { ask_id, option_id }  — an option button was pressed
//!   "open-ask"   { ask_id }             — the notification body was clicked
//!
//! iOS-specific differences from the desktop core:
//! - No `bundled()` gate: on iOS the process always runs inside the app bundle,
//!   so UNUserNotificationCenter is usable at launch (the desktop .app-path
//!   check must not gate the iOS path off).
//! - The delegate implements `userNotificationCenter:willPresentNotification:`
//!   — iOS-only requirement. Without it, local notifications are silently
//!   suppressed while the app is foregrounded (macOS shows them; iOS drops
//!   them). Omitting it is exactly the "silent drop" ADR BR#998 forbids.
//! - No APNs / remote push: this is the local-notification pattern only; the
//!   ask-watch lives in the shell (see `shellui.rs`), fed from hub /api/state.

use std::sync::atomic::{AtomicBool, Ordering};

use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, ProtocolObject};
use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_foundation::{NSMutableArray, NSError, NSObjectProtocol, NSString, NSSet};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationAction,
    UNNotificationActionOptions, UNNotificationCategory, UNNotificationCategoryOptions,
    UNNotificationDefaultActionIdentifier, UNNotificationDismissActionIdentifier,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use block2::{DynBlock, RcBlock};
use tauri::{AppHandle, Emitter};

use crate::shellui::AskOptionDto;

static AUTH_REQUESTED: AtomicBool = AtomicBool::new(false);

struct DelegateIvars {
    app: AppHandle,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "BridgeMobileNotifyDelegate"]
    #[ivars = DelegateIvars]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        // iOS-only: show banner + list + sound even while the app is foregrounded.
        // Without this method iOS silently suppresses foregrounded local notifications.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        unsafe fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion_handler: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion_handler.call((
                UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,
            ));
        }

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
                println!("[shell] notification tapped — event open-ask {ask_id}");
                let _ = self.ivars().app.emit("open-ask", serde_json::json!({ "ask_id": ask_id }));
            } else {
                println!("[shell] notification action — event ask-action {ask_id} option {action}");
                let _ = self.ivars().app.emit(
                    "ask-action",
                    serde_json::json!({ "ask_id": ask_id, "option_id": action }),
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

/// Ask for notification permission at launch so the dialog precedes any ask.
pub fn ensure_authorized() {
    if AUTH_REQUESTED.swap(true, Ordering::Relaxed) {
        return;
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let block = RcBlock::new(move |_granted: Bool, _err: *mut NSError| {});
    center.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
        &block,
    );
}

/// Install the delegate that shows foreground notifications and turns taps
/// into events. Leak the delegate: the center only holds a weak reference.
pub fn install_delegate(app: AppHandle) {
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

/// Send one local notification. Must be called on the main thread.
/// The request identifier is the ask id — re-posting replaces, never stacks.
/// Options (when present) become notification action buttons, one category
/// per ask, exactly like the desktop core.
pub fn send_ask_main_thread(ask_id: &str, title: &str, body: &str, options: &[AskOptionDto]) {
    let center = UNUserNotificationCenter::currentNotificationCenter();

    if !options.is_empty() {
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
    }

    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    if !options.is_empty() {
        content.setCategoryIdentifier(&NSString::from_str(ask_id));
        content.setThreadIdentifier(&NSString::from_str(ask_id));
    }
    content.setSound(Some(&UNNotificationSound::defaultSound()));

    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSString::from_str(ask_id),
        &content,
        None,
    );
    center.addNotificationRequest_withCompletionHandler(&request, None);
}

fn shorten(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max.saturating_sub(1)).collect();
    format!("{cut}…")
}
