//! bridge — headless runner for the bridge fleet hub.
//!
//! Claims tasks from the bridge board and dispatches them to local agent CLIs
//! (opencode). The same dispatch core powers the desktop gateway; this is the
//! no-GUI build for linux/mac hosts: `curl -fsSL …/install.sh | bash`.
//!
//! Usage:
//!   bridge                      run using env/config (BRIDGE_URL, BRIDGE_TOKEN)
//!   bridge pair <hub-url>       device-flow pairing — prints a code, saves config, runs
//!   bridge status               print runner state (~/.bridge/dispatch/runner.json)
//!
//! Signals: Ctrl-C kills the process. Ephemeral state lives under
//! ~/.bridge/dispatch/; the hub owns all authoritative state, so a killed
//! runner leaves nothing inconsistent behind.

// The dispatch core is shared verbatim with the desktop gateway (single source
// of truth — no drift between GUI and CLI).
#[path = "../../desktop/src-tauri/src/dispatch.rs"]
mod dispatch;
#[path = "../../desktop/src-tauri/src/opencode.rs"]
mod opencode;

use dispatch::DispatchConfig;
use std::sync::{Arc, Mutex};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("run");

    match cmd {
        "pair" => {
            let url = args
                .get(2)
                .map(|s| s.trim_end_matches('/').to_string())
                .or_else(|| std::env::var("BRIDGE_URL").ok())
                .unwrap_or_else(|| {
                    eprintln!("usage: bridge pair <hub-url>   (or set BRIDGE_URL)");
                    std::process::exit(2);
                });
            eprintln!("[bridge] pairing against {url} — approve at {url}/pair, then the runner starts");
            run(None);
        }
        "status" => {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            let path = std::path::Path::new(&home).join(".bridge/dispatch/runner.json");
            match std::fs::read_to_string(&path) {
                Ok(s) => println!("{s}"),
                Err(_) => {
                    eprintln!("no runner state — is a runner running?");
                    std::process::exit(1);
                }
            }
        }
        "run" | "--help" | "-h" | "help" => {
            if cmd != "run" {
                print_help();
                return;
            }
            match DispatchConfig::resolve() {
                Some(cfg) => run(Some(cfg)),
                None => {
                    // no config: run_loop handles BRIDGE_URL pairing; without
                    // BRIDGE_URL it exits with the setup message.
                    run(None);
                }
            }
        }
        other => {
            eprintln!("unknown command: {other}");
            print_help();
            std::process::exit(2);
        }
    }
}

fn run(cfg: Option<DispatchConfig>) {
    let mut cfg = cfg;
    // CLI override: --max-sessions N (wins over env/file, same as the gateway)
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--max-sessions") {
        if let Some(v) = args.get(i + 1).and_then(|v| v.parse::<usize>().ok()) {
            cfg = Some(match cfg {
                Some(c) => {
                    let mut c = c;
                    c.max_sessions = v.max(1);
                    c
                }
                None => DispatchConfig {
                    url: std::env::var("BRIDGE_URL").unwrap_or_default().trim_end_matches('/').into(),
                    token: std::env::var("BRIDGE_TOKEN").unwrap_or_default(),
                    workdir: std::env::var("BRIDGE_WORKDIR").unwrap_or_else(|_| {
                        std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default()
                    }),
                    agent: std::env::var("BRIDGE_AGENT").ok(),
                    poll_secs: std::env::var("BRIDGE_POLL_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(60),
                    timeout_mins: std::env::var("OPENCODE_TIMEOUT_MINS").ok().and_then(|v| v.parse().ok()).unwrap_or(30),
                    opencode_bin: std::env::var("OPENCODE_BIN").unwrap_or_else(|_| "opencode".into()),
                    label: None,
                    ws: None,
                    max_sessions: v.max(1),
                    isolate: !matches!(std::env::var("BRIDGE_ISOLATE").as_deref(), Ok("0") | Ok("false") | Ok("no")),
                },
            });
        }
    }
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let running = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let last_error = Arc::new(Mutex::new(None));
    let snap = Arc::new(Mutex::new(dispatch::DispatchSnapshot::default()));
    dispatch::run_loop(cfg, stop, running, last_error, snap);
}

fn print_help() {
    println!(
        "bridge — headless runner for the bridge fleet hub

USAGE:
  bridge                 run the dispatch loop (BRIDGE_URL + BRIDGE_TOKEN, or ~/.bridge/config.json)
  bridge pair <url>      device-flow pairing: prints a code, you approve at <url>/pair, then it runs
  bridge status          print current runner state
  --max-sessions N       cap concurrent agent sessions (default 1)

ENV:
  BRIDGE_URL, BRIDGE_TOKEN, BRIDGE_WORKDIR, BRIDGE_AGENT, BRIDGE_POLL_SECS, BRIDGE_MAX_SESSIONS

State: ~/.bridge/config.json (auth) · ~/.bridge/dispatch/ (ephemeral runner state)
The hub owns all authoritative state — killing the runner leaves nothing inconsistent.
"
    );
}
