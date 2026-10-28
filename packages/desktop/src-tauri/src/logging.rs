//! logging.rs — the single emit() for every runner log line (BR#4400).
//!
//! One process used to interleave two log dialects — train.rs's timestamped
//! lane lines vs dispatch.rs's bare `[subsystem]` eprintln!s — since BR#4104
//! put the train daemon in-process beside the dispatch loop. Every
//! operator-visible runner line in both binaries (Bridge desktop, bridge
//! CLI) now flows through `emit`:
//!
//! ```text
//! [<iso-utc>] [<subsystem>] [<scope>] <message>
//! ```
//!
//! - `subsystem` — fixed vocabulary: `train`, `dispatch`, `store`,
//!   `session`, `keychain`
//! - `scope` — the object the line is about: lane `state-vector/bridge@main`
//!   (train), task `BR#4371` (dispatch). `None` renders no brackets — never
//!   empty ones — for process-global lines. A call site whose message body
//!   already names the object (the string is shared with non-log consumers
//!   such as the activity snapshot) passes `None` rather than duplicate it.
//! - message body — free text; existing flow prefixes (`queue:`, `lease:`,
//!   `tick error:`, `pair:`, `ERROR:`) keep flowing unchanged.
//!
//! Stream: stderr by default (eprintln! parity for the gateway daemon, where
//! the host app's other daemon lines go). The standalone `bridge train` CLI
//! calls `prefer_stdout(true)` once at startup — stdout is what `> train.log`
//! users and journald capture expect (BR#3879).

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Stream routing (moved from train.rs's LOG_STDERR, inverted): the default
/// is stderr; the standalone CLI flips this once at startup.
static PREFER_STDOUT: AtomicBool = AtomicBool::new(false);

/// Route subsequent `emit` lines to stdout (standalone `bridge train`).
pub fn prefer_stdout(yes: bool) {
    PREFER_STDOUT.store(yes, Ordering::Relaxed);
}

/// Milliseconds since the epoch (moved verbatim from train.rs).
pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// UTC ISO-8601 log timestamps without a chrono dependency (civil-from-days;
/// moved verbatim from train.rs).
pub fn iso(ts_ms: u64) -> String {
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

/// Pure line formatter (the `scope` bracket is omitted, never empty).
fn line(subsystem: &str, scope: Option<&str>, msg: &str, ts_ms: u64) -> String {
    match scope.filter(|s| !s.is_empty()) {
        Some(s) => format!("[{}] [{subsystem}] [{s}] {msg}", iso(ts_ms)),
        None => format!("[{}] [{subsystem}] {msg}", iso(ts_ms)),
    }
}

/// The single mechanism: one format for every operator-visible runner line.
/// The desktop crate declares this module; the CLI vendors it verbatim via
/// `#[path]` (same single-source-of-truth law as dispatch.rs).
pub fn emit(subsystem: &str, scope: Option<&str>, msg: &str) {
    let text = line(subsystem, scope, msg, now_ms());
    if PREFER_STDOUT.load(Ordering::Relaxed) {
        let _ = writeln!(std::io::stdout(), "{text}");
        let _ = std::io::stdout().flush();
    } else {
        let _ = writeln!(std::io::stderr(), "{text}");
        let _ = std::io::stderr().flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_is_bracketed_when_present() {
        assert_eq!(
            line("dispatch", Some("BR#4371"), "dispatched — new", 0),
            "[1970-01-01T00:00:00Z] [dispatch] [BR#4371] dispatched — new"
        );
    }

    #[test]
    fn no_scope_renders_no_brackets() {
        assert_eq!(
            line("dispatch", None, "loop started", 0),
            "[1970-01-01T00:00:00Z] [dispatch] loop started"
        );
    }

    #[test]
    fn empty_scope_is_omitted_never_empty_bracketed() {
        assert_eq!(
            line("train", Some(""), "tick failed: boom", 86_400_000),
            "[1970-01-02T00:00:00Z] [train] tick failed: boom"
        );
    }

    #[test]
    fn train_lane_scopes_ride_the_same_format() {
        assert_eq!(
            line("train", Some("state-vector/bridge@main"), "lease: acquired (holder=x)", 0),
            "[1970-01-01T00:00:00Z] [train] [state-vector/bridge@main] lease: acquired (holder=x)"
        );
    }
}
