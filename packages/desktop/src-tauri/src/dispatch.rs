//! Dispatch loop — polls bridge for claimable work, dispatches it to opencode,
//! and reports status back through the same protocol (orient / transition /
//! log_progress). Runs identically in menu-bar and headless mode.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::TryRecvError;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;

use crate::opencode;

#[derive(Debug, Clone, Deserialize)]
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
        })
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

// ---- dispatch state (shared with Tauri commands) ----

struct InFlight {
    task_id: String,
    task_title: String,
    started: std::time::Instant,
    rx: std::sync::mpsc::Receiver<opencode::RunOutcome>,
}

pub struct DispatchState {
    pub stop: Arc<AtomicBool>,
    pub running: Arc<AtomicBool>,
    pub last_error: Arc<Mutex<Option<String>>>,
    pub handle: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl DispatchState {
    pub fn new() -> Self {
        Self {
            stop: Arc::new(AtomicBool::new(false)),
            running: Arc::new(AtomicBool::new(false)),
            last_error: Arc::new(Mutex::new(None)),
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
) -> Result<Option<String>, String> {
    // 1. heartbeat any in-flight opencode run; finalize when it exits
    if let Some(inf) = in_flight {
        match inf.rx.try_recv() {
            Ok(outcome) => {
                let inf = in_flight.take().unwrap();
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
                        Ok(_) => return Ok(Some(format!("{} → in_review", inf.task_title))),
                        Err(_) => {
                            return Ok(Some(format!(
                                "{} finished (no PR link — left in_progress for review pickup)",
                                inf.task_title
                            )))
                        }
                    }
                }
                return Ok(Some(format!("{} failed/timed out — left in_progress", inf.task_title)));
            }
            Err(TryRecvError::Disconnected) => {
                in_flight.take();
                return Ok(Some("opencode runner dropped — will re-check next tick".into()));
            }
            Err(TryRecvError::Empty) => {
                let mins = inf.started.elapsed().as_secs() / 60;
                mcp_call(
                    cfg,
                    id,
                    "log_progress",
                    json!({ "id": inf.task_id, "note": format!("dispatch runner: opencode still working (~{mins}m in)"), "sentiment": "neutral" }),
                )?;
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
    Ok(Some(format!("claimed {tid} — dispatched to opencode")))
}

pub fn run_loop(cfg: DispatchConfig, stop: Arc<AtomicBool>, running: Arc<AtomicBool>, last_error: Arc<Mutex<Option<String>>>) {
    running.store(true, Ordering::Relaxed);
    let mut id: i64 = 0;
    let mut in_flight: Option<InFlight> = None;
    eprintln!(
        "[dispatch] loop started — {} (poll every {}s, workdir {})",
        cfg.url, cfg.poll_secs, cfg.workdir
    );
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        match tick(&cfg, &mut id, &mut in_flight) {
            Ok(Some(msg)) => eprintln!("[dispatch] {msg}"),
            Ok(None) => {}
            Err(e) => {
                eprintln!("[dispatch] error: {e}");
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
    eprintln!("[dispatch] loop stopped");
}

pub fn start(state: &DispatchState, cfg: DispatchConfig) -> Result<(), String> {
    let mut handle = state.handle.lock().map_err(|_| "state poisoned")?;
    if state.running.load(Ordering::Relaxed) {
        return Err("dispatch loop already running".into());
    }
    state.stop.store(false, Ordering::Relaxed);
    let stop = state.stop.clone();
    let running = state.running.clone();
    let last_error = state.last_error.clone();
    *handle = Some(std::thread::spawn(move || {
        run_loop(cfg, stop, running, last_error)
    }));
    Ok(())
}

pub fn stop(state: &DispatchState) {
    state.stop.store(true, Ordering::Relaxed);
}
