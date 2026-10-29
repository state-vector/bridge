//! Apple on-device model (FoundationModels) — iOS leg of the desktop
//! console's `local_answer` (packages/desktop/src-tauri/src/console.rs).
//!
//! The FoundationModels framework is Swift-only on iOS (zero OBJC_CLASS
//! symbols — checked in the iOS 26.5 SDK), so the objc2 route the desktop's
//! `foundation-models` crate takes on macOS does not exist here. Instead we
//! ship a minimal Swift bridge (gen/apple/Sources/FMVoice.swift, three
//! `@_cdecl` exports compiled into the app target) and declare those C
//! symbols here. Session-per-turn, string in → string out — the tool loop
//! lives in `console.rs`, engine-agnostic.
//!
//! Only links on iOS: the module is cfg-gated in lib.rs.

use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::mpsc;
use std::time::Duration;

const RESPOND_TIMEOUT: Duration = Duration::from_secs(120);

type FmRespondCallback = unsafe extern "C" fn(ctx: *mut c_void, response: *const c_char, error: *const c_char);

extern "C" {
    fn fm_voice_is_available() -> bool;
    fn fm_voice_respond(
        instructions: *const c_char,
        prompt: *const c_char,
        ctx: *mut c_void,
        callback: FmRespondCallback,
    ) -> *mut c_void;
    fn fm_voice_task_cancel(task: *mut c_void);
}

/// True when the on-device model is usable (iOS 26+, Apple Intelligence on).
pub fn is_available() -> bool {
    unsafe { fm_voice_is_available() }
}

/// One turn: instructions + prompt → the model's reply text.
/// Each call is its own session (the tool loop re-sends full context).
pub fn respond(instructions: &str, prompt: &str) -> Result<String, String> {
    let instr = CString::new(instructions).map_err(|_| "instructions: interior NUL")?;
    let prompt = CString::new(prompt).map_err(|_| "prompt: interior NUL")?;
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    let ctx = Box::into_raw(Box::new(tx)) as *mut c_void;

    let task = unsafe {
        fm_voice_respond(instr.as_ptr(), prompt.as_ptr(), ctx, respond_callback)
    };

    match rx.recv_timeout(RESPOND_TIMEOUT) {
        Ok(res) => res,
        Err(_) => {
            // The Swift side keeps its one-shot ctx; on timeout we leak the
            // sender (a channel) rather than race a late callback on freed
            // memory. Cancel the task so the model stops generating.
            if !task.is_null() {
                unsafe { fm_voice_task_cancel(task) };
            }
            Err("on-device model timed out".into())
        }
    }
}

unsafe extern "C" fn respond_callback(ctx: *mut c_void, response: *const c_char, error: *const c_char) {
    if ctx.is_null() {
        return;
    }
    let tx = Box::from_raw(ctx as *mut mpsc::Sender<Result<String, String>>);
    let res = if !error.is_null() && !unsafe { CStr::from_ptr(error) }.to_bytes().is_empty() {
        Err(unsafe { CStr::from_ptr(error) }.to_string_lossy().into_owned())
    } else if !response.is_null() {
        Ok(unsafe { CStr::from_ptr(response) }.to_string_lossy().into_owned())
    } else {
        Err("empty response".into())
    };
    let _ = tx.send(res);
}
