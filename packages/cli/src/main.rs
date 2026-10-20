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
use std::path::PathBuf;
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
            // run_loop pairs from BRIDGE_URL — the CLI knows the URL from the
            // arg, not the env; hand it over or pairing dead-ends immediately.
            std::env::set_var("BRIDGE_URL", &url);
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
        "doctor" => {
            let bad = doctor();
            std::process::exit(if bad { 1 } else { 0 });
        }
        "service" => {
            if let Err(e) = service_install() {
                eprintln!("[bridge] service install failed: {e}");
                std::process::exit(1);
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
                    agent_name: None,
                    ws: None,
                    model: std::env::var("BRIDGE_MODEL").ok(),
                    backend: std::env::var("BRIDGE_BACKEND").ok(),
                    backends: std::env::var("BRIDGE_BACKENDS")
                        .ok()
                        .map(|v| v.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect::<Vec<_>>()),
                    models: std::env::var("BRIDGE_MODEL")
                        .ok()
                        .map(|m| std::collections::HashMap::from([("opencode".to_string(), m)])),
                    agents: None,
                    report_minutes: std::env::var("BRIDGE_REPORT_MINUTES").ok().and_then(|v| v.parse().ok()),
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

/// Headless setup check: every failure names the fix. Exit 1 when setup is
/// incomplete so scripts can gate on it.
fn doctor() -> bool {
    let mut bad = false;
    let ok = |name: &str, detail: &str, bad: &mut bool, fatal: bool| {
        if detail.is_empty() {
            println!("  \x1b[32mok\x1b[0m   {name}");
        } else {
            if fatal { *bad = true; }
            let tag = if fatal { "\x1b[31mFAIL\x1b[0m " } else { "\x1b[33mwarn\x1b[0m " };
            println!("  {tag}{name} — {detail}");
        }
    };
    println!("bridge doctor");

    let cfg = DispatchConfig::resolve();
    match &cfg {
        None => {
            println!("  \x1b[31mFAIL\x1b[0m  config — none found. Run `bridge pair <hub-url>` or set BRIDGE_URL + BRIDGE_TOKEN");
            return true;
        }
        Some(c) => {
            ok("hub url", if c.url.is_empty() { "not set" } else { "" }, &mut bad, true);
            ok("token", if c.token.is_empty() { "not set — re-pair or set BRIDGE_TOKEN" } else { "" }, &mut bad, true);
            ok("workdir", if c.workdir.is_empty() { "not set" } else { "" }, &mut bad, true);
        }
    }
    let cfg = cfg.unwrap();

    // explicit-model policy: the runner refuses dispatch without a model per backend
    let backends: Vec<String> = cfg
        .backends
        .clone()
        .filter(|v| !v.is_empty())
        .or_else(|| cfg.backend.clone().map(|b| vec![b]))
        .unwrap_or_else(|| vec!["opencode".into()]);
    let models = cfg.models.clone().unwrap_or_default();
    for b in &backends {
        match models.get(b) {
            Some(m) if !m.trim().is_empty() => println!("  \x1b[32mok\x1b[0m   model[{b}] = {m}"),
            _ => {
                bad = true;
                println!("  \x1b[31mFAIL\x1b[0m  model[{b}] — REQUIRED (the runner refuses dispatch without it). Edit ~/.bridge/config.json: \"models\": {{ \"{b}\": \"<model-id>\" }}");
            }
        }
    }

    // agent CLI binaries reachable?
    for b in &backends {
        let bin = if b == "kiro" { "kiro" } else { cfg.opencode_bin.as_str() };
        let found = std::process::Command::new(bin)
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if found {
            println!("  \x1b[32mok\x1b[0m   {bin} CLI on PATH");
        } else {
            bad = true;
            println!("  \x1b[31mFAIL\x1b[0m  {bin} CLI not runnable — install it and authenticate (it must work non-interactively in {workdir})", workdir = cfg.workdir);
        }
    }

    // git + workdir sanity
    let git_ok = std::process::Command::new("git")
        .args(["-C", &cfg.workdir, "rev-parse", "--is-inside-work-tree"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if git_ok {
        println!("  \x1b[32mok\x1b[0m   workdir is a git repo (isolated worktrees + PR branches)");
    } else {
        bad = true;
        println!("  \x1b[31mFAIL\x1b[0m  workdir is not a git repo — dispatch needs one for isolated worktrees");
    }

    if bad {
        println!("\nsetup incomplete — fix the FAIL lines, then `bridge run` (or `bridge service install`)");
    } else {
        println!("\nready — `bridge run` to start, or `bridge service install` to run it under systemd");
    }
    bad
}

/// systemd user unit (linux): run forever, restart on failure, survive logout.
/// macOS has no systemd — prints the launchd/nohup alternative.
fn service_install() -> Result<(), String> {
    if !cfg!(target_os = "linux") {
        println!("no systemd on this OS. run the runner persistently with:");
        println!("  nohup ~/.local/bin/bridge run >> ~/.bridge/bridge.log 2>&1 &");
        println!("or a LaunchAgent — see README (Run on a server).");
        return Ok(());
    }
    let bin = std::env::current_exe().map_err(|e| e.to_string())?;
    let home = std::env::var("HOME").map_err(|_| "no HOME")?;
    let unit_dir = PathBuf::from(&home).join(".config/systemd/user");
    std::fs::create_dir_all(&unit_dir).map_err(|e| e.to_string())?;
    let unit = format!(
        "[Unit]\nDescription=bridge fleet runner\nAfter=network-online.target\n\n[Service]\nExecStart={} run\nRestart=on-failure\nRestartSec=10\nWorkingDirectory={}\nEnvironmentFile=-{}\n\n[Install]\nWantedBy=default.target\n",
        bin.display(),
        std::env::current_dir().map(|d| d.display().to_string()).unwrap_or_default(),
        PathBuf::from(&home).join(".bridge/env").display(),
    );
    let path = unit_dir.join("bridge.service");
    std::fs::write(&path, unit).map_err(|e| e.to_string())?;
    println!("wrote {}", path.display());
    println!("next steps:");
    println!("  systemctl --user daemon-reload");
    println!("  systemctl --user enable --now bridge");
    println!("  loginctl enable-linger $USER    # survive logout / run at boot");
    println!("  journalctl --user -u bridge -f  # watch the dispatch log");
    Ok(())
}

fn print_help() {
    println!(
        "bridge — headless runner for the bridge fleet hub

USAGE:
  bridge                 run the dispatch loop (BRIDGE_URL + BRIDGE_TOKEN, or ~/.bridge/config.json)
  bridge pair <url>      device-flow pairing: prints a code, you approve at <url>/pair, then it runs
  bridge status          print current runner state
  bridge doctor          check headless setup (config, models, agent CLIs, git)
  bridge service install write a systemd user unit (linux) — run forever, restart on failure
  --max-sessions N       cap concurrent agent sessions (default 1)

ENV:
  BRIDGE_URL, BRIDGE_TOKEN, BRIDGE_WORKDIR, BRIDGE_AGENT, BRIDGE_POLL_SECS, BRIDGE_MAX_SESSIONS

State: ~/.bridge/config.json (auth) · ~/.bridge/dispatch/ (ephemeral runner state)
The hub owns all authoritative state — killing the runner leaves nothing inconsistent.
"
    );
}
