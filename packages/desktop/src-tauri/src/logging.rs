//! Single logging mechanism for every operator-visible runner line (BR#4400).
//!
//! One format, fixed field order:
//!
//! ```text
//! [<iso-utc>] [<subsystem>] [<scope>] <message>
//! ```
//!
//! - `subsystem` — the emitting component, fixed vocabulary:
//!   `train | dispatch | pair | store | session | keychain | cli | canary`
//! - `scope` — the object the line is about (a lane `owner/repo@base`, a card
//!   `BR#4371`, a workspace); omitted entirely when the line is process-global
//! - `message` — free text; event-style prefixes within it (`queue: …`,
//!   `lease: …`, `error: …`) are the convention
//!
//! Interactive UX (onboarding prompts, usage errors, pairing codes a human
//! must act on now) stays on println/eprintln — this door is for logs.
//!
//! The desktop gateway and the `bridge` CLI compile this module verbatim
//! (`#[path]` in the CLI) — same single-source-of-truth law as dispatch.rs.

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Stream selection: stderr by default (eprintln parity for the dispatch
/// loop); `bridge train` flips to stdout so interactive pipes keep working.
static PREFER_STDOUT: AtomicBool = AtomicBool::new(false);

pub fn prefer_stdout(v: bool) {
    PREFER_STDOUT.store(v, Ordering::Relaxed);
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// UTC ISO-8601 log timestamps without a chrono dependency (civil-from-days).
fn iso(ts_ms: u64) -> String {
    let secs = (ts_ms / 1000) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    if mo <= 2 {
        y += 1;
    }
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

/// The one door every runner log line goes through.
pub fn emit(subsystem: &str, scope: &str, msg: &str) {
    let ts = iso(now_ms());
    let line = if scope.is_empty() {
        format!("[{ts}] [{subsystem}] {msg}")
    } else {
        format!("[{ts}] [{subsystem}] [{scope}] {msg}")
    };
    if PREFER_STDOUT.load(Ordering::Relaxed) {
        let _ = writeln!(std::io::stdout(), "{line}");
        let _ = std::io::stdout().flush();
    } else {
        let _ = writeln!(std::io::stderr(), "{line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_is_civil_utc() {
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        // 2026-10-28T22:32:25Z (the format specimen from BR#4400)
        assert_eq!(iso(1_793_226_745_000), "2026-10-28T22:32:25Z");
    }

    #[test]
    fn format_brackets_scope_only_when_present() {
        // exercising emit's formatting through the same branch logic
        let with_scope = {
            let scope = "state-vector/bridge@main";
            let msg = "queue: BR#4363 → BR#4362";
            format!("[{}] [{}] [{}] {}", "ts", "train", scope, msg)
        };
        assert_eq!(
            with_scope,
            "[ts] [train] [state-vector/bridge@main] queue: BR#4363 → BR#4362"
        );
        let global = format!("[{}] [{}] {}", "ts", "dispatch", "loop stopped");
        assert_eq!(global, "[ts] [dispatch] loop stopped");
    }
}
