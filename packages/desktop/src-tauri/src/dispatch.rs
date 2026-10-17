//! Dispatch loop — polls bridge for claimable work, dispatches it to opencode,
//! and reports status back through the same protocol (orient / transition /
//! log_progress). Runs identically in menu-bar and headless mode.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::TryRecvError;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::opencode;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DispatchConfig {
    pub url: String,
    pub token: String,
    #[serde(default = "default_workdir")]
    pub workdir: String,
    #[serde(default)]
    pub agent: Option<String>, // opencode agent name (role prompt), optional
    #[serde(default = "default_poll_secs")]
    pub poll_secs: u64,
    #[serde(default = "default_timeout_mins")]
    pub timeout_mins: u64,
    #[serde(default = "default_opencode_bin")]
    pub opencode_bin: String,
    #[serde(default)]
    pub label: Option<String>, // agent identity from pairing
    #[serde(default)]
    pub ws: Option<String>, // workspace slug from pairing
}

fn default_workdir() -> String {
    std::env::current_dir()
        .map(|d| d.to_string_lossy().into_owned())
        .unwrap_or_default()
}
fn default_poll_secs() -> u64 {
    60
}
fn default_timeout_mins() -> u64 {
    30
}
fn default_opencode_bin() -> String {
    "opencode".into()
}

impl DispatchConfig {
    /// Env fallbacks so headless mode needs no config file:
    /// BRIDGE_URL, BRIDGE_TOKEN, BRIDGE_WORKDIR, BRIDGE_AGENT, BRIDGE_POLL_SECS.
    pub fn from_env() -> Option<Self> {
        let url = std::env::var("BRIDGE_URL").ok()?;
        let token = std::env::var("BRIDGE_TOKEN").ok()?;
        Some(Self {
            url: url.trim_end_matches('/').into(),
            token,
            workdir: std::env::var("BRIDGE_WORKDIR").unwrap_or_else(|_| default_workdir()),
            agent: std::env::var("BRIDGE_AGENT").ok(),
            poll_secs: std::env::var("BRIDGE_POLL_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or_else(default_poll_secs),
            timeout_mins: std::env::var("OPENCODE_TIMEOUT_MINS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or_else(default_timeout_mins),
            opencode_bin: std::env::var("OPENCODE_BIN").unwrap_or_else(|_| default_opencode_bin()),
            label: None,
            ws: None,
        })
    }

    /// Resolution order: env vars > ~/.bridge/config.json > None (→ device pairing).
    pub fn resolve() -> Option<Self> {
        Self::from_env().or_else(load_config)
    }

    pub fn save(&self) -> Result<(), String> {
        let path = config_path();
        let dir = path
            .parent()
            .ok_or("no config dir")?
            .to_path_buf();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
        }
        let body = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&path, body).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600))
            .map_err(|e| e.to_string())?;
        eprintln!("[dispatch] config saved to {}", path.display());
        Ok(())
    }
}

fn config_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".bridge").join("config.json")
}

fn load_config() -> Option<DispatchConfig> {
    let raw = std::fs::read_to_string(config_path()).ok()?;
    serde_json::from_str(&raw)
        .map_err(|e| {
            eprintln!("[dispatch] bad config file: {e}");
            e
        })
        .ok()
}

/// Device pairing (bridge-native github-like device flow): request a code, the
/// human approves it at {url}/pair, poll until the token arrives. The token is
/// shown once on this device — the approver never sees it.
fn pair(url: &str) -> Result<DispatchConfig, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let device = std::process::Command::new("hostname")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "device".into());

    let start: serde_json::Value = client
        .post(format!("{url}/api/pair/start"))
        .header("content-type", "application/json")
        .body(json!({ "device": format!("{} (dispatch runner)", device) }).to_string())
        .send()
        .map_err(|e| format!("bridge unreachable: {e}"))?
        .json()
        .map_err(|e| e.to_string())?;
    let code = start
        .get("code")
        .and_then(|c| c.as_str())
        .ok_or("pair start failed")?
        .to_string();
    eprintln!("[pair] open {url}/pair and enter code {code}");
    println!("[pair] open {url}/pair and enter code {code}");

    let deadline = std::time::Instant::now() + Duration::from_secs(15 * 60);
    loop {
        if std::time::Instant::now() >= deadline {
            return Err("pairing timed out — run again to get a fresh code".into());
        }
        std::thread::sleep(Duration::from_secs(3));
        let resp: serde_json::Value = client
            .post(format!("{url}/api/pair/poll"))
            .header("content-type", "application/json")
            .body(json!({ "code": code }).to_string())
            .send()
            .map_err(|e| format!("poll failed: {e}"))?
            .json()
            .map_err(|e| e.to_string())?;
        match resp.get("status").and_then(|s| s.as_str()) {
            Some("pending") => continue,
            Some("slow_down") => {
                std::thread::sleep(Duration::from_secs(3));
                continue;
            }
            Some("authorized") => {
                let token = resp
                    .get("token")
                    .and_then(|t| t.as_str())
                    .ok_or("authorized but no token")?
                    .to_string();
                let ws = resp
                    .get("ws")
                    .and_then(|w| w.as_str())
                    .unwrap_or("state-vector")
                    .to_string();
                let label = resp
                    .get("label")
                    .and_then(|l| l.as_str())
                    .map(|s| s.to_string());
                eprintln!("[pair] authorized — token for workspace '{ws}' saved");
                return Ok(DispatchConfig {
                    url: url.to_string(),
                    token,
                    workdir: default_workdir(),
                    agent: std::env::var("BRIDGE_AGENT").ok(),
                    poll_secs: default_poll_secs(),
                    timeout_mins: default_timeout_mins(),
                    opencode_bin: default_opencode_bin(),
                    label,
                    ws: Some(ws),
                });
            }
            Some("expired") => return Err("pairing code expired — run again".into()),
            other => return Err(format!("pairing failed: {other:?}")),
        }
    }
}

// ---- bridge MCP client (JSON-RPC over POST /mcp) ----

fn mcp_call(
    cfg: &DispatchConfig,
    id: &mut i64,
    tool: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    *id += 1;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{}/mcp", cfg.url))
        .header("Authorization", format!("Bearer {}", cfg.token))
        .header("content-type", "application/json")
        .body(
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "tools/call",
                "params": { "name": tool, "arguments": args }
            })
            .to_string(),
        )
        .send()
        .map_err(|e| format!("bridge unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("bridge {} on /mcp", resp.status()));
    }
    let body: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
    if let Some(err) = body.get("error") {
        return Err(format!(
            "mcp error {}: {}",
            err.get("code").and_then(|c| c.as_i64()).unwrap_or(0),
            err.get("message").and_then(|m| m.as_str()).unwrap_or("?")
        ));
    }
    let text = body
        .pointer("/result/content/0/text")
        .and_then(|t| t.as_str())
        .ok_or("mcp: no content")?;
    let parsed: serde_json::Value = serde_json::from_str(text).unwrap_or(json!({ "text": text }));
    if body
        .pointer("/result/isError")
        .and_then(|e| e.as_bool())
        .unwrap_or(false)
    {
        return Err(text.to_string());
    }
    Ok(parsed)
}

// ---- local dispatch snapshot (rendered by the app's Local view) ----

#[derive(Debug, Clone, Serialize)]
pub struct DispatchActivity {
    pub ts: u64,
    pub kind: String, // info | dispatch | finish | error
    pub msg: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct InFlightView {
    pub task_id: String,
    pub task_title: String,
    pub started_ms: u64,
    pub last_note: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct DispatchSnapshot {
    pub running: bool,
    pub url: Option<String>,
    pub workspace: Option<String>,
    pub label: Option<String>, // agent identity from pairing
    pub agent: Option<String>, // opencode agent name
    pub workdir: Option<String>,
    pub in_flight: Option<InFlightView>,
    pub activity: Vec<DispatchActivity>, // newest first, capped
}

pub type SharedSnapshot = Arc<Mutex<DispatchSnapshot>>;

fn snap_activity(snap: &SharedSnapshot, kind: &str, msg: &str) {
    if let Ok(mut s) = snap.lock() {
        s.activity.insert(
            0,
            DispatchActivity {
                ts: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
                kind: kind.into(),
                msg: msg.into(),
            },
        );
        s.activity.truncate(30);
    }
}

fn snap_in_flight(snap: &SharedSnapshot, in_flight: &Option<InFlight>) {
    if let Ok(mut s) = snap.lock() {
        s.in_flight = in_flight.as_ref().map(|inf| InFlightView {
            task_id: inf.task_id.clone(),
            task_title: inf.task_title.clone(),
            started_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0)
                - inf.started.elapsed().as_millis() as u64,
            last_note: inf.last_note.clone(),
        });
    }
}

// ---- dispatch state (shared with Tauri commands) ----

struct InFlight {
    task_id: String,
    task_title: String,
    started: std::time::Instant,
    last_note: String,
    rx: std::sync::mpsc::Receiver<opencode::RunOutcome>,
}

pub struct DispatchState {
    pub stop: Arc<AtomicBool>,
    pub running: Arc<AtomicBool>,
    pub last_error: Arc<Mutex<Option<String>>>,
    pub snapshot: Arc<Mutex<DispatchSnapshot>>,
    pub handle: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl DispatchState {
    pub fn new() -> Self {
        Self {
            stop: Arc::new(AtomicBool::new(false)),
            running: Arc::new(AtomicBool::new(false)),
            last_error: Arc::new(Mutex::new(None)),
            snapshot: Arc::new(Mutex::new(DispatchSnapshot::default())),
            handle: Mutex::new(None),
        }
    }

    pub fn status(&self) -> serde_json::Value {
        json!({
            "running": self.running.load(Ordering::Relaxed),
            "last_error": self.last_error.lock().ok().and_then(|g| g.clone()),
        })
    }
}

// ---- the loop ----

/// One dispatch tick. Returns Ok(Some(msg)) on notable actions.
fn tick(
    cfg: &DispatchConfig,
    id: &mut i64,
    in_flight: &mut Option<InFlight>,
    snap: &SharedSnapshot,
) -> Result<Option<String>, String> {
    // 1. heartbeat any in-flight opencode run; finalize when it exits
    if let Some(inf) = in_flight {
        match inf.rx.try_recv() {
            Ok(outcome) => {
                let inf = in_flight.take().unwrap();
                snap_in_flight(snap, &None);
                let mins = inf.started.elapsed().as_secs() / 60;
                let note = format!(
                    "opencode {} in ~{}m (exit {:?}) — {}",
                    if outcome.timed_out { "TIMED OUT" } else { "finished" },
                    mins,
                    outcome.exit_code,
                    if outcome.stdout_tail.is_empty() {
                        outcome.stderr_tail.clone()
                    } else {
                        outcome.stdout_tail.clone()
                    }
                );
                mcp_call(
                    cfg,
                    id,
                    "log_progress",
                    json!({ "id": inf.task_id, "note": note, "sentiment": if outcome.ok { "converging" } else { "struggling" } }),
                )?;
                if outcome.ok {
                    // handoff gate wants a PR link in the note; if opencode
                    // didn't produce one the gate rejects and we stay
                    // in_progress with the summary logged.
                    match mcp_call(
                        cfg,
                        id,
                        "transition",
                        json!({ "id": inf.task_id, "to": "in_review", "note": note }),
                    ) {
                        Ok(_) => {
                            let msg = format!("{} → in_review", inf.task_title);
                            snap_activity(snap, "finish", &msg);
                            return Ok(Some(msg));
                        }
                        Err(_) => {
                            let msg = format!(
                                "{} finished (no PR link — left in_progress for review pickup)",
                                inf.task_title
                            );
                            snap_activity(snap, "finish", &msg);
                            return Ok(Some(msg));
                        }
                    }
                }
                let msg = format!("{} failed/timed out — left in_progress", inf.task_title);
                snap_activity(snap, "finish", &msg);
                return Ok(Some(msg));
            }
            Err(TryRecvError::Disconnected) => {
                in_flight.take();
                snap_in_flight(snap, &None);
                let msg: String = "opencode runner dropped — will re-check next tick".into();
                snap_activity(snap, "error", &msg);
                return Ok(Some(msg));
            }
            Err(TryRecvError::Empty) => {
                let mins = inf.started.elapsed().as_secs() / 60;
                inf.last_note = format!("opencode still working (~{mins}m in)");
                mcp_call(
                    cfg,
                    id,
                    "log_progress",
                    json!({ "id": inf.task_id, "note": format!("dispatch runner: opencode still working (~{mins}m in)"), "sentiment": "neutral" }),
                )?;
                snap_in_flight(snap, in_flight);
                return Ok(None); // one job at a time
            }
        }
    }

    // 2. orient — what's claimable, what's mine
    let orient = mcp_call(cfg, id, "orient", json!({}))?;
    let my_tasks = orient
        .get("my_tasks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let open_mine: Vec<&serde_json::Value> = my_tasks
        .iter()
        .filter(|t| {
            t.get("status").and_then(|s| s.as_str()) == Some("in_progress")
        })
        .collect();

    // 3. previously-dispatched work still open → heartbeat it, don't double-dispatch
    if let Some(t) = open_mine.first() {
        if let (Some(tid), Some(title)) = (
            t.get("id").and_then(|v| v.as_str()),
            t.get("title").and_then(|v| v.as_str()),
        ) {
            mcp_call(
                cfg,
                id,
                "log_progress",
                json!({ "id": tid, "note": format!("dispatch runner heartbeat — '{title}' is open but no local opencode session is running; re-dispatch manually if needed"), "sentiment": "neutral" }),
            )?;
        }
        return Ok(None);
    }

    // 4. claim the first claimable task and dispatch it
    let candidate = orient
        .get("unclaimed_work")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first().cloned());
    let Some(task) = candidate else {
        return Ok(None); // nothing to do — exit quietly this tick
    };
    let (Some(tid), Some(title)) = (
        task.get("id").and_then(|v| v.as_str()),
        task.get("title").and_then(|v| v.as_str()),
    ) else {
        return Ok(None);
    };
    mcp_call(
        cfg,
        id,
        "transition",
        json!({ "id": tid, "to": "in_progress" }),
    )?;
    mcp_call(
        cfg,
        id,
        "log_progress",
        json!({ "id": tid, "note": format!("dispatch runner: claimed '{title}' — dispatching to opencode"), "sentiment": "going_well" }),
    )?;

    // 5. spawn opencode in the background; the loop heartbeats while it works
    let body = {
        let cfg2 = cfg.clone();
        let tid = tid.to_string();
        let title = title.to_string();
        let prompt = format!(
            "Work on this Bridge task.\n\nTask {}: {}\n\n{}\n\nWhen finished, output a concise summary of what you did. If you opened a PR, include its URL.",
            tid,
            title,
            task.get("body_md").and_then(|b| b.as_str()).unwrap_or("")
        );
        std::thread::spawn(move || {
            opencode::run_task(
                &cfg2.workdir,
                &cfg2.opencode_bin,
                cfg2.agent.as_deref(),
                &prompt,
                Duration::from_secs(cfg2.timeout_mins * 60),
            )
        })
    };
    *in_flight = Some(InFlight {
        task_id: tid.to_string(),
        task_title: title.to_string(),
        started: std::time::Instant::now(),
        last_note: "dispatching to opencode".into(),
        rx: {
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _ = tx.send(body.join().unwrap_or_else(|_| opencode::RunOutcome {
                    ok: false,
                    stdout_tail: String::new(),
                    stderr_tail: "runner thread panicked".into(),
                    exit_code: None,
                    timed_out: false,
                }));
            });
            rx
        },
    });
    snap_in_flight(snap, in_flight);
    let msg = format!("claimed {tid} — dispatched to opencode");
    snap_activity(snap, "dispatch", &msg);
    Ok(Some(msg))
}

pub fn run_loop(cfg: Option<DispatchConfig>, stop: Arc<AtomicBool>, running: Arc<AtomicBool>, last_error: Arc<Mutex<Option<String>>>, snap: SharedSnapshot) {
    // no config → device pairing (needs BRIDGE_URL; prints the code to console)
    let cfg = match cfg {
        Some(c) => c,
        None => match std::env::var("BRIDGE_URL") {
            Ok(url) => match pair(url.trim_end_matches('/')) {
                Ok(c) => {
                    if let Err(e) = c.save() {
                        eprintln!("[dispatch] config save failed: {e}");
                    }
                    c
                }
                Err(e) => {
                    if let Ok(mut g) = last_error.lock() {
                        *g = Some(e.clone());
                    }
                    eprintln!("[dispatch] pairing failed: {e}");
                    running.store(false, Ordering::Relaxed);
                    return;
                }
            },
            Err(_) => {
                let msg = "no config and no BRIDGE_URL — set BRIDGE_URL (or ~/.bridge/config.json) to pair".to_string();
                eprintln!("[dispatch] {msg}");
                if let Ok(mut g) = last_error.lock() {
                    *g = Some(msg);
                }
                running.store(false, Ordering::Relaxed);
                return;
            }
        },
    };
    running.store(true, Ordering::Relaxed);
    let mut id: i64 = 0;
    let mut in_flight: Option<InFlight> = None;
    eprintln!(
        "[dispatch] loop started — {} (poll every {}s, workdir {})",
        cfg.url, cfg.poll_secs, cfg.workdir
    );
    if let Ok(mut s) = snap.lock() {
        s.running = true;
        s.url = Some(cfg.url.clone());
        s.workspace = cfg.ws.clone();
        s.label = cfg.label.clone();
        s.agent = cfg.agent.clone();
        s.workdir = Some(cfg.workdir.clone());
    }
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        match tick(&cfg, &mut id, &mut in_flight, &snap) {
            Ok(Some(msg)) => eprintln!("[dispatch] {msg}"),
            Ok(None) => {}
            Err(e) => {
                eprintln!("[dispatch] error: {e}");
                snap_activity(&snap, "error", &e);
                if let Ok(mut g) = last_error.lock() {
                    *g = Some(e);
                }
            }
        }
        // sleep in small slices so stop is responsive
        let wake = std::time::Instant::now() + Duration::from_secs(cfg.poll_secs);
        while std::time::Instant::now() < wake {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }
    running.store(false, Ordering::Relaxed);
    if let Ok(mut s) = snap.lock() {
        s.running = false;
        s.in_flight = None;
    }
    eprintln!("[dispatch] loop stopped");
}

pub fn start(state: &DispatchState, cfg: Option<DispatchConfig>) -> Result<(), String> {
    let mut handle = state.handle.lock().map_err(|_| "state poisoned")?;
    if state.running.load(Ordering::Relaxed) {
        return Err("dispatch loop already running".into());
    }
    state.stop.store(false, Ordering::Relaxed);
    let stop = state.stop.clone();
    let running = state.running.clone();
    let last_error = state.last_error.clone();
    let snap = state.snapshot.clone();
    *handle = Some(std::thread::spawn(move || {
        run_loop(cfg, stop, running, last_error, snap)
    }));
    Ok(())
}

pub fn stop(state: &DispatchState) {
    state.stop.store(true, Ordering::Relaxed);
}
