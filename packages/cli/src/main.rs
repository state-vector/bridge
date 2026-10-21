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
#[path = "../../desktop/src-tauri/src/scm.rs"]
mod scm;
#[path = "../../desktop/src-tauri/src/transport.rs"]
mod transport;

use dispatch::DispatchConfig;
use std::path::PathBuf;
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
            eprintln!("[bridge] pairing against {url} — approve at {url}/pair");
            // run_loop pairs from BRIDGE_URL — the CLI knows the URL from the
            // arg, not the env; hand it over or pairing dead-ends immediately.
            std::env::set_var("BRIDGE_URL", &url);
            let mut cfg = match dispatch::pair_device(&url) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[bridge] pairing failed: {e}");
                    std::process::exit(1);
                }
            };
            eprintln!("[bridge] paired — token saved");
            onboard(&mut cfg);
            if let Err(e) = cfg.save() {
                eprintln!("[bridge] config save failed: {e}");
            }
            eprintln!("[bridge] onboarding complete — starting the runner (Ctrl-C to stop; `bridge service install` to run forever)");
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
                    eprintln!("[bridge] agent {sub} failed: {e}");
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
                            eprintln!("[bridge] pairing failed: {e}");
                            std::process::exit(1);
                        }
                    };
                    onboard(&mut cfg);
                    if let Err(e) = cfg.save() {
                        eprintln!("[bridge] config save failed: {e}");
                    }
                    eprintln!("[bridge] setup complete — starting the runner (Ctrl-C to stop; `bridge service install` to run forever)");
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
        eprintln!("[bridge] non-interactive — skipping onboarding. `bridge doctor` lists what's still missing (agent backends + models are REQUIRED).");
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

    // model per backend — REQUIRED (the runner refuses dispatch without one)
    let mut models = std::collections::HashMap::new();
    println!("\n== a model per agent (REQUIRED — the runner refuses dispatch without it) ==\n");
    for b in &backends {
        let example = if b == "kiro" { "anthropic.claude-sonnet-4-5" } else { "openrouter/~z-ai/glm-flash-latest" };
        let m = loop {
            let v = prompt(&format!("  model for {b} (e.g. {example})"), None);
            if !v.trim().is_empty() {
                break v.trim().to_string();
            }
            println!("  a model is required — the runner will not dispatch without one.");
        };
        models.insert(b.clone(), m);
    }

    println!("\n== where the work happens ==\n");
    let cwd = std::env::current_dir().map(|d| d.display().to_string()).unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();
    let default_wd = if home.is_empty() { cwd.clone() } else { format!("{home}/bridge-work") };
    let workdir = prompt("scratch workdir (task repos are cloned here)", Some(&default_wd));
    let is_git = std::process::Command::new("git")
        .args(["-C", &workdir, "rev-parse", "--is-inside-work-tree"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    let _ = is_git;
    let max_sessions = prompt("max concurrent agent sessions", Some("1"))
        .parse::<usize>()
        .ok()
        .filter(|&n| n >= 1)
        .unwrap_or(1);

    cfg.backends = backends
        .iter()
        .map(|b| {
            let section = dispatch::BackendConfig {
                model: models.get(b).cloned(),
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

    // per-provider sections: model optional (unset = the CLI's own default
    // config decides for opencode; kiro profiles pin provider+model)
    let backends = cfg.enabled_backends();
    for (b, section) in &backends {
        match &section.model {
            Some(m) if !m.trim().is_empty() => println!("  \x1b[32mok\x1b[0m   model[{b}] = {m}"),
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
                bad = true;
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
    for (b, section) in &backends {
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
  bridge                 run the dispatch loop; with no config, walks full first-time setup
  bridge pair <url>      first use: pair, then guided agent setup (backend, model, workdir)
  bridge status          print current runner state
  bridge doctor          check headless setup (config, models, agent CLIs, git)
  bridge agent install   install the bridge agent persona into opencode
  bridge agent check     verify the installed persona matches this version
  bridge service install write a systemd user unit (linux) — run forever, restart on failure
  --max-sessions N       cap concurrent agent sessions (default 1)

ENV:
  BRIDGE_URL, BRIDGE_TOKEN, BRIDGE_WORKDIR, BRIDGE_AGENT, BRIDGE_POLL_SECS, BRIDGE_MAX_SESSIONS

State: ~/.bridge/config.json (auth) · ~/.bridge/dispatch/ (ephemeral runner state)
The hub owns all authoritative state — killing the runner leaves nothing inconsistent.
"
    );
}
