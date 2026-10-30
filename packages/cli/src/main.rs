//! bridge — headless runner for the bridge fleet hub.
//!
//! Claims tasks from the bridge board and dispatches them to local agent CLIs
//! (opencode). The same dispatch core powers the desktop gateway; this is the
//! no-GUI build for linux/mac hosts: `curl -fsSL …/install.sh | bash`.
//!
//! Usage:
//!   bridge                      run using env/config (BRIDGE_URL; token from the keychain)
//!   bridge pair <hub-url>       device-flow pairing — prints a code, saves config, runs
//!   bridge status               print runner state (~/.bridge/dispatch/runner.json)
//!   bridge reset-principal      clear the write-once device identity (~/.bridge/principal)
//!
//! Signals: Ctrl-C kills the process. Ephemeral state lives under
//! ~/.bridge/dispatch/; the hub owns all authoritative state, so a killed
//! runner leaves nothing inconsistent behind. Credentials live in the OS
//! keychain (file fallback `~/.bridge/gateway-token`, 0600) — never in
//! config.json.

// The dispatch core is shared verbatim with the desktop gateway (single source
// of truth — no drift between GUI and CLI).
// vendored from the desktop crate — the CLI compiles a subset (pairing,
// doctor, the loop); desktop-context functions (start/stop/logout/UI state)
// are alive in their home crate, dead only in this partial compilation
#[path = "../../desktop/src-tauri/src/dispatch.rs"]
#[allow(dead_code)]
mod dispatch;
#[path = "../../desktop/src-tauri/src/keychain.rs"]
#[allow(dead_code)]
mod keychain;
// single logging mechanism (BR#4400) — vendored verbatim, same law as above
#[path = "../../desktop/src-tauri/src/logging.rs"]
mod logging;
#[path = "../../desktop/src-tauri/src/opencode.rs"]
mod opencode;
#[path = "../../desktop/src-tauri/src/scm.rs"]
mod scm;
#[path = "../../desktop/src-tauri/src/session.rs"]
#[allow(dead_code)]
mod session;
#[path = "../../desktop/src-tauri/src/store.rs"]
mod store;
#[path = "../../desktop/src-tauri/src/transport.rs"]
mod transport;

/// The native merge-train executor (BR#3879, decision BR#3880 — install is
/// the unit): `bridge train [--once]`, replacing bridge train. Since BR#4104
/// the module's home is the desktop crate beside the dispatch core it plugs
/// into (the gateway daemon runs the train tick in-process); the CLI vendors
/// it verbatim — same single-source-of-truth law as dispatch.rs above.
#[path = "../../desktop/src-tauri/src/train.rs"]
mod train;
#[path = "../../desktop/src-tauri/src/train_gate.rs"]
mod train_gate;

/// The hub self-canary (BR#4177): `bridge canary [--once]` — a daily
/// synthetic end-to-end lifecycle against the deployed hub (duty
/// spawn→delivery, flip-on-event, queue visibility, reconcile accounting),
/// red alarm to the alarm sink. Cron-friendly, same shape as `train --once`.
mod canary;

/// Host-side death-telemetry emitter (BR#4682, TRAIN-DEFENCE L0.2):
/// `bridge alarm` posts an ops note to the alarm sink from the systemd
/// death hook / give-up escalation unit that `bridge service install`
/// emits. Machine infrastructure notes, session "host-supervisor".
mod alarm;

/// The merge-train canary (BR#4694, BR#4633 L4.3): `bridge train-canary` —
/// a synthetic signed PR rides the full lane daily (claim → queue → gate →
/// merge → CI → landed → closed); red alarm to the sink on any phase stuck
/// past its bound. Cron-friendly, same shape as `canary`.
mod train_canary;

use dispatch::DispatchConfig;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// The bridge agent persona, shipped in source control and installed into the
/// agent CLI's own config (opencode reads ~/.config/opencode/agent/*.md).
const BRIDGE_AGENT_MD: &str = include_str!("../agents/bridge.md");
const BRIDGE_AGENT_NAME: &str = "bridge";

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
            logging::emit("cli", &url, "pairing against hub — approve at /pair on the same URL");
            // run_loop pairs from BRIDGE_URL — the CLI knows the URL from the
            // arg, not the env; hand it over or pairing dead-ends immediately.
            std::env::set_var("BRIDGE_URL", &url);
            let mut cfg = match dispatch::pair_device(&url) {
                Ok(c) => c,
                Err(e) => {
                    logging::emit("cli", &url, &format!("error: pairing failed: {e}"));
                    std::process::exit(1);
                }
            };
            logging::emit("cli", &url, "paired — token saved");
            onboard(&mut cfg);
            if let Err(e) = cfg.save() {
                logging::emit("cli", &url, &format!("error: config save failed: {e}"));
            }
            logging::emit("cli", &url, "onboarding complete — starting the runner (Ctrl-C to stop; `bridge service install` to run forever)");
            run(Some(cfg));
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
        "reset-principal" => {
            // the ONLY local principal clear (BR#2840): debugging tool — the
            // hub mints a fresh device credential on the next provision
            let store = store::TokenStore::open();
            let had = !store.principal().is_empty();
            if let Err(e) = store.reset_principal() {
                logging::emit("cli", "", &format!("error: reset-principal failed: {e}"));
                std::process::exit(1);
            }
            println!(
                "{}",
                if had { "principal cleared — the hub mints a new one at the next provision" }
                else { "no principal on this machine — nothing to clear" }
            );
        }
        "agent" => {
            let sub = args.get(2).map(|s| s.as_str()).unwrap_or("install");
            if sub != "install" && sub != "check" {
                eprintln!("usage: bridge agent install|check   (opencode only for now)");
                std::process::exit(2);
            }
            match agent_op(BRIDGE_AGENT_MD, BRIDGE_AGENT_NAME, sub == "install") {
                Ok(lines) => {
                    let fail = lines.iter().any(|m| m.contains("FAIL"));
                    for m in &lines {
                        println!("{m}");
                    }
                    if sub == "check" {
                        std::process::exit(if fail { 1 } else { 0 });
                    }
                }
                Err(e) => {
                    logging::emit("cli", "", &format!("error: agent {sub} failed: {e}"));
                    std::process::exit(1);
                }
            }
        }
        "train" => {
            // native merge-train executor (BR#3879): `bridge train [--once]`
            std::process::exit(train::run(&args[2..]));
        }
        "canary" => {
            // hub self-canary (BR#4177): `bridge canary [--once]` — single
            // lifecycle pass; cron re-runs it daily.
            std::process::exit(canary::run(&args[2..]));
        }
        "train-canary" => {
            // merge-train canary (BR#4694): a synthetic PR rides the full
            // lane; single pass, cron re-runs it daily.
            std::process::exit(train_canary::run(&args[2..]));
        }
        "doctor" => {
            let bad = doctor();
            std::process::exit(if bad { 1 } else { 0 });
        }
        "logs" => {
            // headless log view — Ray 2026-10-25. Reads the hub's KB events
            // feed (GET /api/kb/events) with the gateway bearer; same source
            // the webapp's Log view renders. Modes:
            //   bridge logs                last 30 events (compact)
            //   bridge logs --limit 100    last N events
            //   bridge logs -f             follow — poll every 5s, print new
            //   bridge logs --task BR#123  filter to one artefact
            //   bridge logs --json         raw JSON, no formatting
            match DispatchConfig::resolve() {
                Some(cfg) => cmd_logs(&cfg, &args),
                None => {
                    eprintln!("bridge logs: no pairing found — run `bridge pair <hub-url>` first (or bridge run to onboard interactively)");
                    std::process::exit(1);
                }
            }
        }
        "service" => {
            if let Err(e) = service_install() {
                logging::emit("cli", "", &format!("error: service install failed: {e}"));
                std::process::exit(1);
            }
        }
        "alarm" => {
            // death-telemetry emitter (BR#4682): posts to the alarm sink via
            // the hub MCP — invoked by the systemd death hook and give-up unit.
            std::process::exit(alarm::run(&args[2..]));
        }
        "run" | "--help" | "-h" | "help" => {
            if cmd != "run" {
                print_help();
                return;
            }
            match DispatchConfig::resolve() {
                Some(cfg) => run(Some(cfg)),
                None => {
                    // first use: guide the user through the whole setup — hub
                    // pairing AND agent setup (backend, required model,
                    // workdir, WIP) — before anything polls.
                    let hub = prompt("hub url (e.g. https://bridge.your-subdomain.workers.dev)", None);
                    if hub.trim().is_empty() {
                        eprintln!("a hub url is required. Run `bridge pair <hub-url>`.");
                        std::process::exit(2);
                    }
                    let url = hub.trim().trim_end_matches('/').to_string();
                    std::env::set_var("BRIDGE_URL", &url);
                    println!("\napproving the pairing code at {url}/pair …\n");
                    let mut cfg = match dispatch::pair_device(&url) {
                        Ok(c) => c,
                        Err(e) => {
                            logging::emit("cli", &url, &format!("error: pairing failed: {e}"));
                            std::process::exit(1);
                        }
                    };
                    onboard(&mut cfg);
                    if let Err(e) = cfg.save() {
                        logging::emit("cli", &url, &format!("error: config save failed: {e}"));
                    }
                    logging::emit("cli", &url, "setup complete — starting the runner (Ctrl-C to stop; `bridge service install` to run forever)");
                    run(Some(cfg));
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
    // Self-heal the credential: a runner may not start on a missing or
    // non-gateway token — and it does not have to fail there either.
    // BR#4113 headless-first: the device principal (write-once file) re-vends
    // a gateway-class token with NO human — principal repair runs before the
    // device flow. Only when the principal is absent or the hub names the
    // credential dead ("re-pair required") does a human approve a code.
    if let Some(c) = cfg.as_mut() {
        if c.token.is_empty() || c.gateway != Some(true) {
            let url = c.url.clone();
            if !url.is_empty() {
                let mut healed = false;
                match reqwest::blocking::Client::builder()
                    .timeout(std::time::Duration::from_secs(30))
                    .build()
                    .map_err(|e| e.to_string())
                    .and_then(|client| dispatch::repair_by_principal(&client, &url))
                {
                    Ok(fresh) => {
                        *c = fresh;
                        healed = true;
                        println!("\n== gateway token re-vended by device principal — starting the runner ==\n");
                    }
                    Err(pe) => {
                        logging::emit("cli", &url, &format!("error: principal repair failed: {pe}"));
                    }
                }
                if !healed {
                    println!("\n== gateway pairing required — starting device flow (approve at {url}/pair) ==\n");
                    match dispatch::pair_device(&url) {
                        Ok(fresh) => {
                            *c = fresh;
                            if let Err(e) = c.save() {
                                logging::emit("cli", &url, &format!("warning: config save failed after repair-pair: {e}"));
                            }
                            println!("\n== paired — starting the runner ==\n");
                        }
                        Err(e) => {
                            logging::emit("cli", &url, &format!("error: automatic pairing failed: {e}"));
                            logging::emit("cli", &url, &format!("fix the credential and start again: bridge pair {url}"));
                            std::process::exit(1);
                        }
                    }
                }
            }
        }
    }
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
                    schema_version: dispatch::default_schema_version(),
                    url: std::env::var("BRIDGE_URL").unwrap_or_default().trim_end_matches('/').into(),
                    // token never comes from env (credential-class ADR) —
                    // the store attaches it from the keychain
                    token: String::new(),
                    workdir: std::env::var("BRIDGE_WORKDIR").unwrap_or_else(|_| {
                        std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default()
                    }),
                    agent: std::env::var("BRIDGE_AGENT").ok(),
                    role: None,
                    poll_secs: std::env::var("BRIDGE_POLL_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(60),
                    timeout_mins: std::env::var("OPENCODE_TIMEOUT_MINS").ok().and_then(|v| v.parse().ok()).unwrap_or(30),
                    opencode_bin: std::env::var("OPENCODE_BIN").unwrap_or_else(|_| "opencode".into()),
                    label: None,
                    agent_name: None,
                    ws: None,
                    gateway: None,
                    model: std::env::var("BRIDGE_MODEL").ok(),
                    backend: std::env::var("BRIDGE_BACKEND").ok(),
                    backends: std::env::var("BRIDGE_BACKENDS")
                        .ok()
                        .map(|v| {
                            v.split(',')
                                .map(|x| x.trim().to_string())
                                .filter(|x| !x.is_empty())
                                .map(|name| (name, dispatch::BackendConfig::default()))
                                .collect::<std::collections::BTreeMap<_, _>>()
                        })
                        .unwrap_or_default(),
                    models: std::env::var("BRIDGE_MODEL")
                        .ok()
                        .map(|m| std::collections::HashMap::from([("opencode".to_string(), m)])),
                    agents: None,
                    report_minutes: std::env::var("BRIDGE_REPORT_MINUTES").ok().and_then(|v| v.parse().ok()),
                    max_sessions: v.max(1),
                    isolate: !matches!(std::env::var("BRIDGE_ISOLATE").as_deref(), Ok("0") | Ok("false") | Ok("no")),
                    worktree_exempt_repos: std::env::var("BRIDGE_WORKTREE_EXEMPT_REPOS")
                        .unwrap_or_default()
                        .split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect(),
                    identity: None, // built-in worker class applies (BR#3185)
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

fn prompt(label: &str, default: Option<&str>) -> String {
    use std::io::Write;
    match default {
        Some(d) => print!("{label} [{d}]: "),
        None => print!("{label}: "),
    }
    std::io::stdout().flush().ok();
    let mut line = String::new();
    let _ = std::io::stdin().read_line(&mut line);
    let v = line.trim().to_string();
    if v.is_empty() { default.unwrap_or("").to_string() } else { v }
}

fn bin_detected(bin: &str) -> bool {
    std::process::Command::new(bin)
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// First-run onboarding: pair leaves a half-filled config (url, token, label).
/// Nothing dispatchable yet: no agent backend, no model — and the runner
/// refuses to dispatch without both. Walk the human through the rest BEFORE
/// the loop starts polling, instead of a zombie runner.
fn onboard(cfg: &mut DispatchConfig) {
    let tty = std::io::IsTerminal::is_terminal(&std::io::stdin());
    if !tty {
        logging::emit("cli", "", "non-interactive — skipping onboarding. `bridge doctor` lists what's still missing (agent backends are required; models are optional (CLI defaults apply)).");
        return;
    }
    println!("\n== onboard: which agents will drive tasks on this machine? ==\n");

    // detect installed agent CLIs
    let all = [("opencode", "opencode"), ("kiro", "kiro")];
    let detected: Vec<&str> = all.iter().filter(|(name, _)| bin_detected(name)).map(|(name, _)| *name).collect();
    if detected.is_empty() {
        println!("  no agent CLI found on PATH.");
        let try_install = prompt("install opencode now? (curl installer, linux/macOS) y/n", Some("y"));
        if try_install.trim().eq_ignore_ascii_case("y") {
            println!("  installing opencode…");
            let script = "curl -fsSL https://opencode.ai/install | bash";
            let ok = std::process::Command::new("sh")
                .arg("-c")
                .arg(script)
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if ok {
                // re-detect; install scripts may modify the current shell's PATH —
                // check the well-known install location too
                let local_bin = PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".opencode/bin/opencode");
                let found = bin_detected("opencode") || local_bin.exists();
                if found {
                    println!("  opencode installed. Authenticate it now (the runner runs it non-interactively):");
                    let _ = std::process::Command::new("opencode").arg("auth").status();
                    return onboard(cfg); // restart detection with the new CLI
                }
            }
            println!("  install failed. install manually: https://opencode.ai — then re-run `bridge pair`.");
        }
        println!("  set backends/models in ~/.bridge/config.json by hand, or re-run `bridge pair` after installing.");
        std::process::exit(1);
    }
    for d in &detected {
        println!("  detected: {d}");
    }
    let default_backend = detected.first().unwrap_or(&"opencode").to_string();
    let choice = prompt(
        &format!("agent backends to enable, comma-separated ({})", detected.join(", ")),
        Some(&default_backend),
    );
    let backends: Vec<String> = choice
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| detected.contains(&s.as_str()))
        .collect::<Vec<_>>();
    let backends = if backends.is_empty() { vec![default_backend.clone()] } else { backends };

    // transport for opencode: ACP is the default (bidirectional, live session
    // updates); stdio is the fallback for hosts where the ACP path misbehaves.
    let mut transport: std::collections::HashMap<String, Option<String>> = std::collections::HashMap::new();
    if backends.iter().any(|b| b == "opencode") {
        let existing_mode = cfg.backends.get("opencode").and_then(|s| s.mode.clone()).unwrap_or_else(|| "acp".into());
        let t = prompt(
            "opencode transport — acp (default, live updates) or stdio",
            Some(&existing_mode),
        );
        let t = t.trim().to_lowercase();
        transport.insert("opencode".to_string(), if t == "stdio" { Some("stdio".into()) } else { None });
    }

    // model per backend — optional: empty means the agent CLI's own default
    // config decides (the runner injects an explicit model only when set)
    let mut models = std::collections::HashMap::new();
    println!("\n== a model per agent (empty = use the agent CLI's own default) ==\n");
    for b in &backends {
        let existing = cfg.backends.get(b).and_then(|s| s.model.clone()).unwrap_or_default();
        let v = prompt(&format!("  model for {b} (empty = keep `{}` / CLI default)", if existing.is_empty() { "unset" } else { &existing }), Some(&existing));
        let v = v.trim().to_string();
        if !v.is_empty() {
            models.insert(b.clone(), v);
        }
    }

    println!("\n== where the work happens ==\n");
    let cwd = std::env::current_dir().map(|d| d.display().to_string()).unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();
    let default_wd = if cfg.workdir.is_empty() {
        if home.is_empty() { cwd.clone() } else { format!("{home}/bridge-work") }
    } else {
        cfg.workdir.clone()
    };
    let workdir = prompt("scratch workdir (task repos are cloned here)", Some(&default_wd));
    let is_git = std::process::Command::new("git")
        .args(["-C", &workdir, "rev-parse", "--is-inside-work-tree"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    let _ = is_git;
    let max_sessions = prompt("max concurrent agent sessions", Some(&cfg.max_sessions.to_string()))
        .parse::<usize>()
        .ok()
        .filter(|&n| n >= 1)
        .unwrap_or(cfg.max_sessions.max(1));

    cfg.backends = backends
        .iter()
        .map(|b| {
            let section = dispatch::BackendConfig {
                model: models.get(b).cloned(),
                mode: transport.get(b).cloned().flatten(),
                ..Default::default()
            };
            (b.clone(), section)
        })
        .collect();
    cfg.workdir = workdir;
    cfg.max_sessions = max_sessions;
    println!();
}

/// Install (or verify) the bridge agent persona into opencode's config dir.
/// Returns lines to print. "FAIL" lines indicate doctor-reportable problems.
fn agent_op(md: &str, name: &str, install: bool) -> Result<Vec<String>, String> {
    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    let home = std::env::var("HOME").map_err(|_| "no HOME")?;
    let xdg = std::env::var("XDG_CONFIG_HOME").unwrap_or_else(|_| format!("{home}/.config"));
    let link_dir = PathBuf::from(&xdg).join("opencode/agent");
    let link_path = link_dir.join(format!("{name}.md"));
    // canonical copy lives in BRIDGE's own config dir — the agent CLI's entry
    // is a symlink, so opencode reads our file instead of owning a copy.
    let canonical_dir = PathBuf::from(&home).join(".bridge/agent");
    let canonical = canonical_dir.join(format!("{name}.md"));
    let mut out = Vec::new();

    if install {
        std::fs::create_dir_all(&canonical_dir).map_err(|e| e.to_string())?;
        std::fs::write(&canonical, md).map_err(|e| e.to_string())?;
    }

    // canonical state
    let canonical_cur = std::fs::read_to_string(&canonical).ok();
    match canonical_cur {
        Some(cur) if cur == md => {
            out.push(format!("\x1b[32mok\x1b[0m   persona `{name}` up to date ({})", canonical.display()));
        }
        _ => {
            let msg = format!("persona `{name}` {} — run `bridge agent install`", if canonical_cur.is_some() { "outdated" } else { "not installed" });
            if install {
                return Err(msg); // install already wrote it; a failure here is fs-level
            }
            out.push(format!("\x1b[31mFAIL\x1b[0m  {msg} ({})", canonical.display()));
            return Ok(out);
        }
    }

    // link state (opencode reads through the symlink)
    let meta = std::fs::symlink_metadata(&link_path).ok();
    let existed = meta.is_some();
    let is_symlink_to_canonical = meta
        .map(|m| m.file_type().is_symlink() && std::fs::read_to_string(&link_path).is_ok_and(|c| c == md))
        .unwrap_or(false);
    if is_symlink_to_canonical {
        out.push(format!("\x1b[32mok\x1b[0m   agent profile `{name}` linked into opencode ({})", link_path.display()));
        return Ok(out);
    }
    if install {
        std::fs::create_dir_all(&link_dir).map_err(|e| e.to_string())?;
        if existed {
            std::fs::remove_file(&link_path).map_err(|e| e.to_string())?; // replaces a stale copy
        }
        #[cfg(unix)]
        symlink(&canonical, &link_path).map_err(|e| e.to_string())?;
        #[cfg(not(unix))]
        std::fs::copy(&canonical, &link_path).map_err(|e| e.to_string())?;
        out.push(format!("linked agent profile `{name}` into opencode ({})", link_path.display()));
    } else {
        out.push(format!(
            "\x1b[31mFAIL\x1b[0m  agent profile `{name}` not linked into opencode — run `bridge agent install` ({})",
            link_path.display()
        ));
    }
    Ok(out)
}

/// Headless log view (Ray 2026-10-25): the hub's KB event feed, same source
/// the webapp's Log view renders. Everything the fleet did, chronological.
/// A log command that 500s or hangs in headless is worse than none — every
/// failure path prints the reason and exits non-zero.
fn cmd_logs(cfg: &DispatchConfig, args: &[String]) {
    let mut limit: usize = 30;
    let mut follow = false;
    let mut task_filter: Option<String> = None;
    let mut json_out = false;
    let mut i = 2; // args[0]=bin, args[1]="logs"
    while i < args.len() {
        match args[i].as_str() {
            "--limit" => {
                limit = args.get(i + 1).and_then(|s| s.parse().ok()).unwrap_or(30);
                i += 2;
            }
            "-f" | "--follow" => {
                follow = true;
                i += 1;
            }
            "--task" => {
                task_filter = args.get(i + 1).map(|s| s.to_string());
                i += 2;
            }
            "--json" => {
                json_out = true;
                i += 1;
            }
            _ => {
                eprintln!("bridge logs: unknown arg '{}' — usage: bridge logs [--limit N] [-f] [--task BR#123] [--json]", args[i]);
                std::process::exit(2);
            }
        }
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|e| {
            eprintln!("bridge logs: http client: {e}");
            std::process::exit(1);
        });
    let url = format!("{}/api/kb/events", cfg.url.trim_end_matches('/'));
    let token = cfg.token.clone();
    let fetch = |since: u64| -> Result<serde_json::Value, String> {
        client
            .get(&url)
            .query(&[("since", since.to_string()), ("limit", limit.to_string())])
            .header("Authorization", format!("Bearer {token}"))
            .send()
            .map_err(|e| format!("hub unreachable ({e}) — check `bridge doctor`"))?
            .error_for_status()
            .map_err(|e| format!("hub rejected the request ({e}) — is the gateway token valid? `bridge doctor` checks"))
            .and_then(|r| r.json::<serde_json::Value>().map_err(|e| format!("bad JSON from hub: {e}")))
    };

    let rel_time = |ts_ms: u64| -> String {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let s = now.saturating_sub(ts_ms) / 1000;
        if s < 60 { format!("{s}s") }
        else if s < 3600 { format!("{}m{}s", s / 60, s % 60) }
        else { format!("{}h{:02}m", s / 3600, (s % 3600) / 60) }
    };

    let render = |e: &serde_json::Value, json_out: bool| -> Option<String> {
        if json_out {
            // SP-review fix (PR #194): never silently render an empty line —
            // a serialization failure is loud, named, non-zero.
            return Some(serde_json::to_string(e).unwrap_or_else(|err| {
                eprintln!("bridge logs: event serialization failed ({err}) — raw: {e}");
                std::process::exit(1);
            }));
        }
        let ts = e.get("ts")?.as_u64()?;
        let actor = e.get("actor")?.as_str().unwrap_or("?");
        let op = e.get("op")?.as_str().unwrap_or("?");
        let artefact = e.get("artefact_id").and_then(|v| v.as_str()).unwrap_or("");
        let detail = e.get("detail").and_then(|v| v.as_str()).unwrap_or("");
        let age = rel_time(ts);
        if task_filter.as_deref() != Some(artefact) && task_filter.is_some() {
            return None;
        }
        Some(format!("{age:>8}  {actor:<28} {op:<18} {artefact:<10} {detail}"))
    };

    if !follow {
        let body = fetch(0).unwrap_or_else(|e| {
            eprintln!("bridge logs: {e}");
            std::process::exit(1);
        });
        let events = body.get("events").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        if events.is_empty() {
            println!("no events yet — the fleet hasn't done anything");
            return;
        }
        for e in events.iter().rev() {
            // newest first in the feed; render oldest→newest for log reading
            if let Some(line) = render(e, json_out) {
                println!("{line}");
            }
        }
        if !json_out {
            let n = events.len();
            println!("\n{n} events (oldest → newest) — bridge logs -f to follow");
        }
        return;
    }

    // follow mode: poll, track the last seq, print new events as they land.
    // SP-review fix (PR #194): repeated hub failures must never become a
    // silent infinite retry loop — 20 consecutive failures exit loudly with
    // the last error, so an outage in a `systemctl` unit surfaces in the
    // journal instead of hanging forever.
    let mut last_seq: u64 = 0;
    let mut consecutive_failures: u32 = 0;
    const MAX_CONSECUTIVE_FAILURES: u32 = 20;
    let poll_secs = std::time::Duration::from_secs(5);
    eprintln!("following the event log (Ctrl-C to stop) — polling {url} every 5s");
    loop {
        match fetch(last_seq) {
            Ok(body) => {
                consecutive_failures = 0;
                let events = body.get("events").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                for e in &events {
                    let seq = e.get("seq").and_then(|v| v.as_u64()).unwrap_or(0);
                    if seq <= last_seq {
                        continue;
                    }
                    if let Some(line) = render(e, json_out) {
                        println!("{line}");
                    }
                    if seq > last_seq {
                        last_seq = seq;
                    }
                }
            }
            Err(e) => {
                consecutive_failures += 1;
                if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                    eprintln!("bridge logs: {MAX_CONSECUTIVE_FAILURES} consecutive hub failures — giving up. Last error: {e}");
                    std::process::exit(1);
                }
                logging::emit("cli", "", &format!("logs follow: {e} — retrying ({consecutive_failures}/{MAX_CONSECUTIVE_FAILURES})"));
            }
        }
        std::thread::sleep(poll_secs);
    }
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
                println!("  \x1b[31mFAIL\x1b[0m  config — none found. Run `bridge pair <hub-url>` or set BRIDGE_URL");
                return true;
            }
        Some(c) => {
            ok("hub url", if c.url.is_empty() { "not set" } else { "" }, &mut bad, true);
            ok(
                "token",
                if c.token.is_empty() {
                    if !store::TokenStore::open().principal().is_empty() {
                        // BR#4113: the device principal survives a wiped/absent
                        // token — `bridge run` re-vends headless by principal.
                        "not set — device principal on file; `bridge run` re-vends it headless (or `bridge pair <hub-url>`)"
                    } else {
                        "not set — re-pair (`bridge pair <hub-url>`) to provision one"
                    }
                } else {
                    ""
                },
                &mut bad,
                true,
            );
            ok("workdir", if c.workdir.is_empty() { "not set" } else { "" }, &mut bad, true);
        }
    }
    let cfg = cfg.unwrap();

    // live probes: hub reachability, deploy drift (__version vs HEAD when in
    // a checkout), token validity (one MCP orient). The deploy-stall incident
    // was invisible for hours — these make it a named FAIL.
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .ok();
    if let Some(client) = &client {
        match client.get(format!("{}/__version", cfg.url.trim_end_matches('/'))).send() {
            Ok(resp) if resp.status().is_success() => {
                let v: serde_json::Value = resp.json().unwrap_or_default();
                let live = v.get("commit").and_then(|c| c.as_str()).unwrap_or("?").to_string();
                ok("hub reachable", "", &mut bad, false);
                if let Ok(head) = std::process::Command::new("git").args(["rev-parse", "HEAD"]).output() {
                    if head.status.success() {
                        let head = String::from_utf8_lossy(&head.stdout).trim().to_string();
                        if live == head {
                            ok("deploy matches HEAD", "", &mut bad, false);
                        } else {
                            ok("deploy drift", &format!("live {live} != HEAD {head} — CF Builds stalled or bypassed?"), &mut bad, true);
                        }
                    }
                }
            }
            _ => ok("hub reachable", "hub unreachable or /__version broken", &mut bad, true),
        }
        if !cfg.token.is_empty() {
            let body = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"orient","arguments":{"session":"doctor"}}}"#;
            match client
                .post(format!("{}/mcp", cfg.url.trim_end_matches('/')))
                .header("content-type", "application/json")
                .header("Authorization", format!("Bearer {}", cfg.token))
                .body(body)
                .send()
            {
                Ok(r) if r.status().is_success() => ok("token valid (orient 200)", "", &mut bad, false),
                Ok(r) => ok("token valid", &format!("hub rejected it ({}) — re-pair to repair", r.status()), &mut bad, true),
                Err(e) => ok("token valid", &format!("probe failed: {e}"), &mut bad, false),
            }
        }
        // ---- merge-train executor prerequisites (BR#3517): gh (authed, repo
        // scope), git, node with type stripping, and the executor script in
        // the checkout. Warnings (the doctor serves every CLI, not only train
        // machines) but each one names the fix. ----
        let gh_ver = std::process::Command::new("gh").arg("--version").output();
        ok(
            "gh present",
            if gh_ver.map(|o| o.status.success()).unwrap_or(false) { "" } else { "gh not runnable — the merge-train executor needs it (winget/brew install gh)" },
            &mut bad, false,
        );
        let gh_auth = std::process::Command::new("gh").args(["auth", "status"]).output();
        match gh_auth {
            Ok(o) if o.status.success() => {
                ok("gh authed", "", &mut bad, false);
                let text = format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
                if !text.contains("repo") {
                    ok("gh token scopes", "no `repo` scope — the executor cannot merge; fix: gh auth refresh -h github.com -s repo", &mut bad, false);
                }
            }
            _ => ok("gh authed", "gh auth status failed — run `gh auth login`", &mut bad, false),
        }
        // BR#4489 merge-train capability: the merge executor must be a
        // worker-class identity (default detached-cody, BR#3181) AND be able
        // to push the lane repos. A host that cannot merge must learn it
        // HERE, loudly: it will not claim the train lock (the executor
        // enforces the same gate at claim time) and doctor exits with the
        // merge-train leg flagged. Non-fatal for non-train functions — the
        // rest of the checks below still run and a non-train gateway is
        // unaffected.
        let worker_ids: Vec<String> = std::env::var("MERGE_TRAIN_WORKER_IDENTITIES")
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect();
        let worker_ids = if worker_ids.is_empty() { vec!["detached-cody".to_string()] } else { worker_ids };
        let login = std::process::Command::new("gh")
            .args(["api", "user", "--jq", ".login"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_lowercase());
        let mut lane_repos: Vec<String> = std::env::var("MERGE_TRAIN_LANES")
            .unwrap_or_default()
            .split(',')
            .filter_map(|l| l.trim().split_once('@').map(|(r, _)| r.trim().to_string()))
            .filter(|r| !r.is_empty())
            .collect();
        if lane_repos.is_empty() {
            // lanes are hub-defined — ask the hub (the doctor already has an
            // authenticated client); a hub miss degrades to a note, not a FAIL
            if let Ok(resp) = client
                .post(format!("{}/train.status", cfg.url.trim_end_matches('/')))
                .header("content-type", "application/json")
                .header("Authorization", format!("Bearer {}", cfg.token))
                .json(&serde_json::json!({}))
                .send()
            {
                if resp.status().is_success() {
                    if let Ok(v) = resp.json::<serde_json::Value>() {
                        if let Some(lanes) = v.get("lanes").and_then(|l| l.as_array()) {
                            for l in lanes {
                                if let Some(key) = l.get("lane").and_then(|x| x.as_str()) {
                                    if let Some((r, _)) = key.split_once('@') {
                                        let r = r.trim().to_string();
                                        if !r.is_empty() && !lane_repos.contains(&r) {
                                            lane_repos.push(r);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        let mut train_capable = true;
        match login {
            Some(l) if worker_ids.contains(&l) => ok("merge-train identity", &format!("{l} is worker-class — this host can claim the train lock"), &mut bad, false),
            Some(l) => {
                train_capable = false;
                ok(
                    "merge-train identity",
                    &format!("gh is authed as '{l}' (personal) — will not claim train lock as I cannot merge PRs; fix: auth gh as one of [{}] for the merge-train host", worker_ids.join(", ")),
                    &mut bad, true,
                );
            }
            None => ok("merge-train identity", "gh api user failed — cannot classify; the train will fail closed (transient? re-run doctor)", &mut bad, false),
        }
        // identity is necessary, not sufficient: the credential must also
        // push each lane repo (per-lane permissions.push). Capped at 5 repos
        // to respect gh rate limits; the count of unchecked lanes rides the note.
        for repo in lane_repos.iter().take(5) {
            let push = std::process::Command::new("gh")
                .args(["api", &format!("repos/{repo}"), "--jq", ".permissions.push == true"])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "true");
            match push {
                Some(true) => ok("merge-train push", &format!("{repo}: push allowed"), &mut bad, false),
                Some(false) => {
                    train_capable = false;
                    ok(
                        "merge-train push",
                        &format!("{repo}: this credential CANNOT push — will not claim train lock as I cannot merge PRs; fix: grant push on {repo} (or authenticate a credential that has it)"),
                        &mut bad, true,
                    );
                }
                None => ok("merge-train push", &format!("{repo}: repo lookup failed (no access or transient) — the train fails closed; check `gh api repos/{repo}`"), &mut bad, false),
            }
        }
        if lane_repos.len() > 5 {
            ok("merge-train push", &format!("{} more lane repo(s) unchecked (rate-limit cap) — the claim-time gate re-checks every ≤5 min regardless", lane_repos.len() - 5), &mut bad, false);
        }
        if !train_capable {
            println!("  \x1b[31mFAIL\x1b[0m  merge-train capability — will not claim train lock as I cannot merge PRs (train functions off; all other gateway functions unaffected)");
            bad = true;
        }
        let git_ver = std::process::Command::new("git").arg("--version").output();
        ok(
            "git present",
            if git_ver.map(|o| o.status.success()).unwrap_or(false) { "" } else { "git not runnable" },
            &mut bad, false,
        );
        // BR#3880 (install is the unit): the merge-train executor is native
        // (`bridge train`) — no Node runtime, no executor script in the
        // workdir, no node/script doctor checks.
        // BR#4252: NO hub-side model check. The hub is not a model gateway
        // and never was — the agent CLI resolves its model id against its
        // OWN provider config; a hub-served list is fabricated authority
        // (it shipped empty and FAILed every valid pin fleet-wide).
    }

    // per-provider sections: model optional (unset = the CLI's own default
    // config decides for opencode; kiro profiles pin provider+model).
    // BR#4252: models are the agent CLI's business — doctor reports the pin
    // as configuration, it does NOT validate it against anything hub-side.
    let backends = &cfg.backends;
    for (b, section) in backends {
        match &section.model {
            Some(m) if !m.trim().is_empty() => {
                println!("  \x1b[32mok\x1b[0m   model[{b}] = {m} (resolved by the agent CLI against its own provider config)");
            }
            _ => println!("  \x1b[33mwarn\x1b[0m  model[{b}] — not set; the CLI's own default config decides (set \"backends.{b}.model\" to pin spend)"),
        }
    }

    // configured agent profiles must actually exist in the agent CLI's own
    // config — a stale profile name (opencode-glm class) fails every dispatch
    // identically and deterministically.
    if let Ok(list) = std::process::Command::new("opencode")
        .args(["agent", "list"])
        .output()
    {
        let out = String::from_utf8_lossy(&list.stdout).to_string();
        let known: Vec<&str> = out
            .lines()
            .filter_map(|l| {
                let l = l.trim();
                l.find(" (").map(|i| &l[..i])
            })
            .collect();
        let mut named: Vec<(String, String)> = cfg
            .backends
            .iter()
            .filter_map(|(b, sec)| sec.agent.clone().map(|a| (b.clone(), a)))
            .collect();
        if let Some(a) = &cfg.agent {
            named.push(("opencode".into(), a.clone()));
        }
        for (backend, profile) in named {
            if profile.trim().is_empty() { continue; }
            if known.iter().any(|k| *k == profile.as_str()) {
                println!("  \x1b[32mok\x1b[0m   agent profile [{backend}] = {profile}");
                // the bridge persona is ours: verify content freshness too
                if profile == BRIDGE_AGENT_NAME {
                    match agent_op(BRIDGE_AGENT_MD, BRIDGE_AGENT_NAME, false) {
                        Ok(lines) => {
                            for line in lines {
                                if line.contains("FAIL") { bad = true; }
                                println!("  {line}");
                            }
                        }
                        Err(e) => {
                            bad = true;
                            println!("  \x1b[31mFAIL\x1b[0m  agent profile check failed: {e}");
                        }
                    }
                }
            } else {
                if profile == BRIDGE_AGENT_NAME {
                    bad = true;
                    println!("  \x1b[31mFAIL\x1b[0m  agent profile [{backend}] = {profile} — not in the CLI's agent list. Run `bridge agent install`, then verify with `opencode agent list`");
                } else {
                    bad = true;
                    println!("  \x1b[31mFAIL\x1b[0m  agent profile [{backend}] = {profile} — NOT FOUND in the agent CLI's config. Clear \"agents\" in ~/.bridge/config.json (default agent is fine), or create the profile (`opencode agent create`)");
                }
            }
        }
    }

    // agent CLI binaries reachable?
    for (b, section) in backends {
        let bin = section.bin.clone().unwrap_or_else(|| if b == "kiro" { "kiro".to_string() } else { cfg.opencode_bin.clone() });
        let bin = bin.as_str();
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
    // workdir is scratch space: task repos are cloned into it on demand
    let wd = PathBuf::from(&cfg.workdir);
    let wd_writable = std::fs::create_dir_all(&wd).is_ok()
        && std::fs::write(wd.join(".bridge-write-test"), b"ok").is_ok()
        && std::fs::remove_file(wd.join(".bridge-write-test")).is_ok();
    if wd_writable {
        println!("  \x1b[32mok\x1b[0m   workdir writable (task repos cloned into {}/repos on demand)", cfg.workdir);
    } else {
        bad = true;
        println!("  \x1b[31mFAIL\x1b[0m  workdir {} not writable", cfg.workdir);
    }
    let git_ok = std::process::Command::new("git")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if git_ok {
        println!("  \x1b[32mok\x1b[0m   git present (clone task repos + isolated worktrees)");
    } else {
        bad = true;
        println!("  \x1b[31mFAIL\x1b[0m  git not on PATH — dispatch clones task repos");
    }

    if bad {
        println!("\nsetup incomplete — fix the FAIL lines, then `bridge run` (or `bridge service install`)");
    } else {
        println!("\nready — `bridge run` to start, or `bridge service install` to run it under systemd");
    }
    bad
}

/// systemd user units (linux): run forever under Restart=always with
/// exponential backoff + start jitter, death telemetry to the alarm sink on
/// every restart-causing death, and a give-up escalation unit (BR#4682,
/// TRAIN-DEFENCE L0.2). macOS has no systemd — prints the launchd/nohup
/// alternative.
///
/// Things the service environment gets wrong on real hosts, all baked at
/// install time:
/// - logs go to ~/bridge.log (StandardOutput/Error=append:), not the journal —
///   user journals are unreadable on many minimal cloud images (journald
///   Storage=volatile, or the session predates linger), which turned
///   `journalctl --user` into a dead end while the service itself ran fine;
/// - PATH: systemd runs user units with a minimal default PATH that misses
///   ~/.local/bin, so agent CLIs that work in the operator's shell are
///   unrunnable under the service. The install shell's PATH is written into
///   the unit, with the configured agent CLIs' dirs pinned first;
/// - WorkingDirectory is %h, never the installer's cwd (BR#4899: an install
///   run from a scratch dir baked that dir into the unit; the dir was
///   deleted later and the unit broke);
/// - the daemon's death is LOUD: Restart=always + backoff/jitter (the
///   BR#4431 silent-death class), a deduped death note to the alarm sink
///   per distinct cause (ExecStopPost hook), and a give-up escalation that
///   fires only on a true start-limit-hit (BR#4899 defect 2: never label
///   an in-backoff retry as "GAVE UP").
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

    // PATH to bake: dirs of the configured agent CLIs first, then the install
    // shell's PATH — whatever dispatches here keeps dispatching under the
    // service. A configured bin that doesn't resolve is a warning, not a
    // failure (doctor is the gate for that).
    let mut agent_bins: Vec<String> = Vec::new();
    if let Some(cfg) = DispatchConfig::resolve() {
        for (b, section) in &cfg.backends {
            agent_bins.push(
                section
                    .bin
                    .clone()
                    .unwrap_or_else(|| if b == "kiro" { "kiro".to_string() } else { cfg.opencode_bin.clone() }),
            );
        }
    }
    let (dirs, missing) = baked_path_dirs(&agent_bins);
    let baked_path = std::env::join_paths(&dirs)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".to_string());

    let log_path = PathBuf::from(&home).join("bridge.log");
    let hook_path = PathBuf::from(&home).join(".bridge/bridge-death-hook");
    let unit = render_unit(&bin, &home, &baked_path, &log_path, &hook_path);
    let path = unit_dir.join("bridge.service");
    std::fs::write(&path, unit).map_err(|e| e.to_string())?;
    println!("wrote {}", path.display());

    // Give-up escalation (BR#4682): OnFailure fires on EVERY failed start,
    // so the @-template gates on the failed unit's Result internally and
    // alarms only on a true start-limit-hit — never per attempt.
    let giveup_path = unit_dir.join("bridge-death-giveup@.service");
    std::fs::write(&giveup_path, render_giveup_unit(&bin)).map_err(|e| e.to_string())?;
    println!("wrote {}", giveup_path.display());

    // Death-telemetry hook (BR#4682): ExecStopPost on every unit exit —
    // one alarm-sink note per distinct cause per 10-minute cooldown,
    // deliberate TERM stops log locally only, local receipt always lands
    // (no silent deaths even when the hub itself is unreachable).
    std::fs::create_dir_all(hook_path.parent().expect("hook parent")).map_err(|e| e.to_string())?;
    std::fs::write(&hook_path, render_death_hook(&bin, &home, &log_path)).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }
    println!("wrote {}", hook_path.display());

    println!("next steps:");
    println!("  systemctl --user daemon-reload");
    println!("  systemctl --user enable --now bridge");
    println!("  loginctl enable-linger $USER    # survive logout / run at boot");
    println!("  tail -f ~/bridge.log            # watch the dispatch log (file logging — the journal is bypassed)");
    println!("  tail -f ~/bridge-death-telemetry.log  # death receipts (one sink note per distinct cause / 10 min)");
    for agent_bin in &missing {
        println!("  \x1b[33mwarn\x1b[0m  {agent_bin} not found on this PATH — the service won't dispatch with it until it's runnable (`bridge doctor`)");
    }
    println!("PATH baked from this shell — re-run `bridge service install` if agent CLIs move (or set PATH in ~/.bridge/env to override)");
    Ok(())
}

/// The jitter line, verbatim. Its quoting is load-bearing: BR#4899 shipped
/// `awk 'BEGIN{srand();printf %.1f, rand()*7}'` — the UNQUOTED format string
/// is an awk syntax error, `sleep` got no operand, and every start attempt
/// died before the daemon launched (the fleet executor host crash-looped for
/// hours). Three independent guards here:
///   1. the awk format string is quoted ("%.1f");
///   2. jitter failure degrades to no sleep (`|| true` on the whole line
///      body), never a failed ExecStartPre;
///   3. the systemd `-` prefix makes even that non-fatal.
const EXEC_START_PRE_JITTER: &str = r#"ExecStartPre=-/bin/sh -c 'sleep "$(awk "BEGIN { srand(); printf \"%.1f\", rand()*7 }" 2>/dev/null)" || true'"#;

/// The systemd user unit (BR#4682): Restart=always (clean exits are the
/// silent-death class — the daemon quitting quietly froze the merge lane,
/// BR#4431), exponential restart backoff 5s→60s (RestartSteps on systemd
/// ≥249; older systemd ignores the two backoff knobs and restarts at a flat
/// 5s — degraded but correct), a start jitter that cannot fail a start, and
/// a 50-starts/10-min start limit so give-up stays effectively unreachable
/// at the 60s backoff cap. WorkingDirectory is %h — NEVER the installer's
/// cwd (BR#4899: an install from a scratch dir baked that dir in; the dir
/// was deleted and the unit broke).
fn render_unit(bin: &Path, home: &str, baked_path: &str, log_path: &Path, hook_path: &Path) -> String {
    format!(
        "[Unit]\nDescription=bridge fleet runner\nAfter=network-online.target\n# give-up escalation — the @-template alarms only on start-limit-hit\nOnFailure=bridge-death-giveup@%n.service\n\n[Service]\nExecStart={} run\n{}\n# auto-restart on ANY exit; exponential backoff 5s→60s\nRestart=always\nRestartSec=5s\nRestartSteps=4\nRestartMaxDelaySec=60s\nStartLimitIntervalSec=600\nStartLimitBurst=50\n# death telemetry: one note per distinct cause per 10 min on the alarm sink\nExecStopPost={}\nWorkingDirectory=%h\nEnvironmentFile=-{}\nEnvironment=PATH={}\nStandardOutput=append:{}\nStandardError=append:{}\n\n[Install]\nWantedBy=default.target\n",
        bin.display(),
        EXEC_START_PRE_JITTER,
        hook_path.display(),
        PathBuf::from(home).join(".bridge/env").display(),
        baked_path,
        log_path.display(),
        log_path.display(),
    )
}

/// Give-up escalation unit (template; instance = the failed unit, %i).
/// Gated: `OnFailure=` fires per failed start, so this checks the failed
/// unit's `Result` and alarms ONLY on `start-limit-hit` — per-attempt death
/// notes are the ExecStopPost hook's job (deduped there), false "GAVE UP"
/// spam was BR#4899 defect 2.
fn render_giveup_unit(bin: &Path) -> String {
    format!(
        "[Unit]\nDescription=bridge supervisor give-up escalation (start-limit-hit only)\n\n[Service]\nType=oneshot\nExecStart=/bin/sh -c 'r=$(systemctl --user show %i -p Result --value 2>/dev/null); [ \"$r\" = \"start-limit-hit\" ] || exit 0; exec \"{}\" alarm --kind giveup \"supervisor GAVE UP (start-limit-hit) — %i stopped retrying and needs manual intervention (systemctl --user status %i; journalctl --user -u %i -n 50)\"'\n",
        bin.display(),
    )
}

/// The ExecStopPost death-telemetry hook (POSIX sh; placeholders replaced
/// verbatim — the script is full of shell braces, so no format! here).
/// Semantics (BR#4682): one alarm-sink note per DISTINCT cause per 10-minute
/// cooldown; a cause change always emits; deliberate TERM stops (systemctl
/// stop/restart) log locally without alarming; every death leaves a local
/// receipt BEFORE the best-effort board emission (no silent deaths when the
/// hub is down). Give-up claims are never made here — that is the give-up
/// unit's job, gated on Result=start-limit-hit.
fn render_death_hook(bin: &Path, home: &str, log_path: &Path) -> String {
    r#"#!/bin/sh
# bridge death-telemetry hook — emitted by `bridge service install` (BR#4682,
# TRAIN-DEFENCE L0.2). Runs as ExecStopPost on every unit exit.
set -u
BIN="{BIN}"
STATE="{HOME_DIR}/bridge-death-hook.state"
RECEIPTS="{HOME_DIR}/bridge-death-telemetry.log"
LOG="{LOG}"
COOLDOWN=600

stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
result="${SERVICE_RESULT:-unknown}"
signal="${SIGNAL:-}"
exit_status="${EXIT_STATUS:-}"

# deliberate stop (systemctl stop/restart TERMs the unit) — local log only
if [ "$result" = "success" ] && [ -n "$signal" ]; then
  echo "$stamp deliberate-stop (TERM) — no alarm" >> "$RECEIPTS"
  exit 0
fi

tail_txt=""
if [ -f "$LOG" ]; then
  tail_txt=$(tail -n 5 "$LOG" 2>/dev/null | tr '\n' '|' | cut -c 1-400)
fi
# cause signature: result + signal + exit only — NOT the log tail (log
# timestamps would differ every attempt and defeat the cooldown that stops
# crash-loop spam, BR#4899 defect 2)
sig="$result|signal=$signal|exit=$exit_status"

now=$(date +%s)
last_ts=$(head -n 1 "$STATE" 2>/dev/null)
last_sig=$(sed -n '2p' "$STATE" 2>/dev/null)
if [ "$sig" = "$last_sig" ] && [ -n "$last_ts" ]; then
  age=$((now - last_ts))
  if [ "$age" -ge 0 ] && [ "$age" -lt "$COOLDOWN" ]; then
    echo "$stamp suppressed (cooldown ${age}s) $sig" >> "$RECEIPTS"
    exit 0
  fi
fi

printf '%s\n%s\n' "$now" "$sig" > "$STATE" 2>/dev/null || true
# state write must never fail the hook: it lives at the home root (no
# subdir dependency) and a lost state file only costs one extra note
msg="result=$result signal=${signal:-none} exit=$exit_status last-log: ${tail_txt:-unavailable}"
echo "$stamp ALARM $msg" >> "$RECEIPTS"
# best-effort board emission; the receipt above is the no-silent-deaths
# guarantee when the hub itself is unreachable (fail-open by design)
"$BIN" alarm --kind death "$msg" >> "$RECEIPTS" 2>&1 || true
exit 0
"#.replace("{BIN}", &bin.display().to_string())
        .replace("{HOME_DIR}", home)
        .replace("{LOG}", &log_path.display().to_string())
}

/// PATH lookup for a bare bin name; an absolute/relative path resolves as-is.
fn which(bin: &str) -> Option<PathBuf> {
    if bin.contains('/') {
        let p = PathBuf::from(bin);
        return if p.is_file() { Some(p) } else { None };
    }
    let path = std::env::var("PATH").ok()?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(bin))
        .find(|cand| cand.is_file())
}

/// Dirs to bake into the unit's `Environment=PATH`: the configured agent
/// CLIs' dirs first, then the install shell's PATH — order-preserving,
/// de-duplicated. Also returns the bins that didn't resolve (warning fodder:
/// the service can't dispatch with them until they're runnable).
fn baked_path_dirs(agent_bins: &[String]) -> (Vec<PathBuf>, Vec<String>) {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    for bin in agent_bins {
        match which(bin) {
            Some(found) => {
                if let Some(dir) = found.parent() {
                    push_unique(&mut dirs, dir.to_path_buf());
                }
            }
            None => missing.push(bin.clone()),
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            if dir.as_os_str().is_empty() {
                continue;
            }
            push_unique(&mut dirs, dir);
        }
    }
    (dirs, missing)
}

fn push_unique(dirs: &mut Vec<PathBuf>, dir: PathBuf) {
    if !dirs.contains(&dir) {
        dirs.push(dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn baked_path_pins_agent_cli_dirs_first_then_carries_the_install_shell_path() {
        // BR#2633: systemd user units run with a minimal default PATH that
        // misses ~/.local/bin — the unit must carry the install shell's PATH,
        // with the agent CLIs' dirs pinned ahead of it, or dispatch regresses
        // to "no dispatchable agents" under the service while the same binary
        // works fine in the operator's shell.
        let sh = which("sh").expect("sh resolves on any host/CI");
        let (dirs, missing) = baked_path_dirs(&["sh".to_string(), "bridge-no-such-bin-2633".to_string()]);
        assert_eq!(dirs.first().map(|d| d.as_path()), sh.parent());
        assert_eq!(missing, vec!["bridge-no-such-bin-2633".to_string()]);
        // every dir on the current PATH survives the bake (minus empties)
        if let Ok(path) = std::env::var("PATH") {
            for dir in std::env::split_paths(&path) {
                if dir.as_os_str().is_empty() {
                    continue;
                }
                assert!(dirs.contains(&dir), "install-shell dir dropped from the bake: {dir:?}");
            }
        }
    }

    #[test]
    fn which_resolves_absolute_bins_directly_and_bare_names_on_path() {
        // backends.*.bin may be an absolute path (no PATH search needed) or a
        // bare name (resolved on the install shell's PATH); neither may panic.
        let sh = which("sh").unwrap();
        assert_eq!(which(sh.to_str().unwrap()).as_deref(), Some(sh.as_path()));
        assert_eq!(which("bridge-definitely-not-a-bin-2633"), None);
    }

    #[test]
    fn unit_pins_restart_always_backoff_and_a_quoted_failsafe_jitter_br4682() {
        // BR#4682 / BR#4899: the supervisor must auto-restart on ANY exit
        // (clean exits are the BR#4431 silent-death class) with exponential
        // backoff; the start jitter's awk format string MUST be quoted — the
        // unquoted `printf %.1f` was an awk syntax error whose failed
        // ExecStartPre killed every start attempt (host crash-looped hours).
        let unit = render_unit(
            Path::new("/home/u/.local/bin/bridge"),
            "/home/u",
            "/usr/local/bin:/usr/bin",
            Path::new("/home/u/bridge.log"),
            Path::new("/home/u/.bridge/bridge-death-hook"),
        );
        for pin in [
            "Restart=always",
            "RestartSec=5s",
            "RestartSteps=4",
            "RestartMaxDelaySec=60s",
            "StartLimitIntervalSec=600",
            "StartLimitBurst=50",
            "OnFailure=bridge-death-giveup@%n.service",
            "ExecStopPost=/home/u/.bridge/bridge-death-hook",
            "StandardOutput=append:/home/u/bridge.log",
            "EnvironmentFile=-/home/u/.bridge/env",
        ] {
            assert!(unit.contains(pin), "unit lost the pin `{pin}`:\n{unit}");
        }
        // the jitter line: quoted format string + whole-line fail-safety +
        // the systemd `-` prefix (three independent guards — jitter may
        // skip, never block a start)
        assert!(
            EXEC_START_PRE_JITTER.starts_with("ExecStartPre=-"),
            "jitter line must carry the non-fatal `-` prefix: {EXEC_START_PRE_JITTER}"
        );
        assert!(
            EXEC_START_PRE_JITTER.contains("printf \\\"%.1f\\\""),
            "awk format string must be quoted (BR#4899 root cause): {EXEC_START_PRE_JITTER}"
        );
        assert!(
            !EXEC_START_PRE_JITTER.contains("printf %.1f"),
            "UNQUOTED awk format string — the BR#4899 crash-loop defect is back: {EXEC_START_PRE_JITTER}"
        );
        assert!(
            EXEC_START_PRE_JITTER.contains("|| true"),
            "jitter must degrade to no sleep, never a failed ExecStartPre: {EXEC_START_PRE_JITTER}"
        );
        // WorkingDirectory is the home specifier — NEVER the installer's cwd
        // (BR#4899: a scratch-dir install baked a soon-to-be-deleted path in)
        assert!(unit.contains("WorkingDirectory=%h"), "unit:\n{unit}");
        assert!(
            !unit.contains("WorkingDirectory=/"),
            "WorkingDirectory must not be an absolute baked path: \n{unit}"
        );
    }

    #[test]
    fn giveup_unit_alarms_only_on_a_true_start_limit_br4682() {
        // BR#4899 defect 2: the first hook version labelled every in-backoff
        // failure "GAVE UP" (~60 false escalations/hour). The give-up unit
        // must gate on the failed unit's Result=start-limit-hit.
        let giveup = render_giveup_unit(Path::new("/home/u/.local/bin/bridge"));
        assert!(giveup.contains("start-limit-hit"), "giveup:\n{giveup}");
        assert!(giveup.contains("alarm --kind giveup"), "giveup:\n{giveup}");
        assert!(giveup.contains("%i"), "giveup must name the failed unit via %i:\n{giveup}");
        // and the death hook must never claim give-up
        let hook = render_death_hook(
            Path::new("/home/u/.local/bin/bridge"),
            "/home/u",
            Path::new("/home/u/bridge.log"),
        );
        assert!(
            !hook.contains("GAVE UP"),
            "the death hook must never make give-up claims (BR#4899 defect 2):\n{hook}"
        );
    }

    #[test]
    fn death_hook_dedupes_same_cause_and_fails_open_br4682() {
        let hook = render_death_hook(
            Path::new("/home/u/.local/bin/bridge"),
            "/home/u",
            Path::new("/home/u/bridge.log"),
        );
        // cooldown dedupe: one note per distinct cause per 10 min
        assert!(hook.contains("COOLDOWN=600"), "hook:\n{hook}");
        assert!(
            hook.contains("sig=\"$result|signal=$signal|exit=$exit_status\""),
            "cause signature must exclude the log tail (timestamps would break dedupe):\n{hook}"
        );
        // deliberate TERM stops never alarm
        assert!(
            hook.contains("[ \"$result\" = \"success\" ] && [ -n \"$signal\" ]"),
            "deliberate-stop branch lost:\n{hook}"
        );
        // fail-open: local receipt lands BEFORE the best-effort emission
        let alarm_idx = hook.find("alarm --kind death").expect("alarm call");
        let receipt_write = hook.find(">> \"$RECEIPTS\"").expect("receipt write");
        assert!(
            receipt_write < alarm_idx,
            "receipts must land before the best-effort emission"
        );
        assert!(
            hook.contains("|| true"),
            "hook must fail open (a hub outage must not break the unit's exit path):\n{hook}"
        );
        // placeholders all replaced
        assert!(!hook.contains("{BIN}"), "unreplaced placeholder:\n{hook}");
        assert!(!hook.contains("{HOME_DIR}"), "unreplaced placeholder:\n{hook}");
        assert!(!hook.contains("{LOG}"), "unreplaced placeholder:\n{hook}");
    }
}

fn print_help() {
    println!(
        "bridge — headless runner for the bridge fleet hub

USAGE:
  bridge                 run the dispatch loop; with no config, walks full first-time setup
  bridge pair <url>      first use: pair, then guided agent setup (backend, model, workdir)
  bridge status          print current runner state
  bridge doctor          check headless setup (config, models, agent CLIs, git)
  bridge logs [opts]     view the hub event log (headless):
                           --limit N    last N events (default 30)
                           -f           follow — poll for new events
                           --task ID    filter to one artefact (BR#123)
                           --json       raw JSON output
  bridge agent install   install the bridge agent persona into opencode
  bridge agent check     verify the installed persona matches this version
  bridge service install write systemd user units (linux): Restart=always with
                         backoff + jitter, death telemetry to the alarm sink,
                         give-up escalation — run forever, deaths are loud
  bridge alarm [opts]    post an ops note to the alarm sink (used by the death
                         telemetry hook; --sink ID, --kind death|giveup|ops,
                         --host H, then the message text)
  bridge canary [--once] hub self-canary (BR#4177): synthetic lifecycle vs the deployed hub;
                         red alarm to the sink (BR#3124). Cron daily:
                         --sink BR#3124    alarm sink card (default BR#3124)
                         --fixture-pr N    fake PR number for the queue fixture (default 999901)
  bridge train-canary    merge-train canary (BR#4694): a synthetic signed, labeled PR rides the
                         full lane daily (claim → queue → gate → merge → CI → landed → close);
                         red alarm to the sink on any stuck phase (claim/work 15m, queue 30m,
                         CI 60m, park 15m). Cron daily:
                         --sink BR#3124              alarm sink card (default BR#3124)
                         --repo state-vector/bridge  the lane to ride (default the hub's own)
  --max-sessions N       cap concurrent agent sessions (default 1)

ENV:
  BRIDGE_URL, BRIDGE_TOKEN, BRIDGE_WORKDIR, BRIDGE_AGENT, BRIDGE_POLL_SECS, BRIDGE_MAX_SESSIONS
  CANARY_SINK_ID, CANARY_FIXTURE_PR (canary overrides, same as the flags above)
  TRAIN_CANARY_SINK_ID, TRAIN_CANARY_REPO (train-canary overrides, same as the flags above)

State: ~/.bridge/config.json (auth) · ~/.bridge/dispatch/ (ephemeral runner state)
The hub owns all authoritative state — killing the runner leaves nothing inconsistent.
"
    );
}
