//! Dispatch loop — polls bridge for claimable work, dispatches it to opencode,
//! and reports status back through the same protocol (orient / transition /
//! log_progress). Runs identically in menu-bar and headless mode.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::TryRecvError;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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
    #[serde(default = "default_max_sessions")]
    pub max_sessions: usize, // WIP limit for this node
    #[serde(default = "default_isolate")]
    pub isolate: bool, // per-task git worktrees + PR branch
}

fn default_max_sessions() -> usize {
    1
}
fn default_isolate() -> bool {
    true
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
            max_sessions: std::env::var("BRIDGE_MAX_SESSIONS")
                .ok()
                .and_then(|v| v.parse().ok())
                .filter(|&n| n > 0)
                .unwrap_or_else(default_max_sessions),
            isolate: !matches!(
                std::env::var("BRIDGE_ISOLATE").as_deref(),
                Ok("0") | Ok("false") | Ok("no")
            ),
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
                    max_sessions: default_max_sessions(),
                    isolate: default_isolate(),
                });
            }
            Some("expired") => return Err("pairing code expired — run again".into()),
            other => return Err(format!("pairing failed: {other:?}")),
        }
    }
}

/// Find the opencode session id for a dispatched task. Dispatched runs are
/// titled `bridge-<task_id>` (set at spawn), so sessions are rediscoverable
/// across runner/app restarts — no local state to lose.
fn session_id_for(bin: &str, workdir: &str, task_id: &str) -> Option<String> {
    let want = format!("bridge-{task_id}");
    let out = Command::new(bin)
        .arg("session")
        .arg("list")
        .arg("--format")
        .arg("json")
        .current_dir(workdir)
        .output()
        .ok()?;
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let items = match v {
        serde_json::Value::Array(a) => a,
        serde_json::Value::Object(o) => o.get("sessions")?.as_array()?.clone(),
        _ => return None,
    };
    for item in items {
        let title = item.get("title").and_then(|t| t.as_str()).unwrap_or("");
        let id = item
            .get("id")
            .or_else(|| item.get("sessionID"))
            .and_then(|i| i.as_str());
        if let Some(id) = id {
            if title == want || title.contains(&want) {
                return Some(id.to_string());
            }
        }
    }
    None
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
    pub max_sessions: usize,
    pub in_flight: Vec<InFlightView>,
    pub activity: Vec<DispatchActivity>, // newest first, capped
}

pub type SharedSnapshot = Arc<Mutex<DispatchSnapshot>>;

fn snap_in_flight_list(snap: &SharedSnapshot, in_flight: &[InFlight]) {
    if let Ok(mut s) = snap.lock() {
        s.in_flight = in_flight
            .iter()
            .map(|inf| InFlightView {
                task_id: inf.task_id.clone(),
                task_title: inf.task_title.clone(),
                started_ms: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0)
                    - inf.started.elapsed().as_millis() as u64,
                last_note: inf.last_note.clone(),
            })
            .collect();
    }
}

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

// ---- ephemeral flat-file state (headless observability) ----
//
// The bridge hub owns authoritative state (task status, claims, progress, PR
// handoff). The runner keeps only ephemeral per-task state as flat JSON files
// under ~/.bridge/dispatch/ so headless runs are observable without the app.
// Files are removed when the task leaves the runner (handed off, or finished
// without a PR); failed tasks keep their file until the retry succeeds.

fn dispatch_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let dir = PathBuf::from(&home).join(".bridge").join("dispatch");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn write_task_state(task_id: &str, v: &serde_json::Value) {
    if let Some(dir) = dispatch_dir() {
        let _ = std::fs::write(
            dir.join(format!("{}.json", slugify(task_id))),
            serde_json::to_string_pretty(v).unwrap_or_default(),
        );
    }
}

fn remove_task_state(task_id: &str) {
    if let Some(dir) = dispatch_dir() {
        let _ = std::fs::remove_file(dir.join(format!("{}.json", slugify(task_id))));
    }
}

fn write_runner_state(snap: &SharedSnapshot) {
    let Some(dir) = dispatch_dir() else { return };
    if let Ok(s) = snap.lock() {
        let v = serde_json::json!({
            "updated_ts": now_ms(),
            "running": s.running,
            "url": s.url,
            "workspace": s.workspace,
            "label": s.label,
            "agent": s.agent,
            "workdir": s.workdir,
            "max_sessions": s.max_sessions,
            "in_flight": s.in_flight,
            "activity": s.activity.iter().take(10).collect::<Vec<_>>(),
        });
        let _ = std::fs::write(dir.join("runner.json"), serde_json::to_string_pretty(&v).unwrap_or_default());
    }
}

// ---- dispatch state (shared with Tauri commands) ----

struct InFlight {
    task_id: String,
    task_title: String,
    started: std::time::Instant,
    last_note: String,
    worktree: Option<PathBuf>, // isolated worktree to clean up on finalize
    pr_url: Option<String>,    // PR opened by the session, monitored after handoff
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
// ---- per-task worktrees + spawning ----

fn slugify(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect()
}

/// Provision (or reuse) an isolated worktree for a task: ~/.bridge/worktrees/<slug>
/// on branch bridge/<slug>. On resume the branch already exists — attach to it.
fn ensure_worktree(workdir: &str, task_id: &str, resume: bool) -> Option<PathBuf> {
    let slug = slugify(task_id);
    let home = std::env::var("HOME").ok()?;
    let path = PathBuf::from(&home).join(".bridge").join("worktrees").join(&slug);
    if path.exists() {
        return Some(path);
    }
    std::fs::create_dir_all(path.parent()?).ok()?;
        let branch = format!("bridge/{slug}");
        // A fresh (non-resume) dispatch can still hit an existing branch: the
        // worktree is cleaned up after every finalize, but `bridge/<slug>` stays
        // behind. `worktree add -b` then fails and we'd silently fall back to
        // running in the main workdir. Try creating; if the branch exists, attach.
        let mut cmd = Command::new("git");
        cmd.current_dir(workdir);
        if resume {
            cmd.args(["worktree", "add"]).arg(&path).arg(&branch);
        } else {
            cmd.args(["worktree", "add", "-b"]).arg(&branch).arg(&path);
        }
        let ok = cmd.output().map(|o| o.status.success()).unwrap_or(false);
        if ok {
            return Some(path);
        }
        let mut cmd = Command::new("git");
        cmd.current_dir(workdir)
            .args(["worktree", "add"])
            .arg(&path)
            .arg(&branch);
        let ok = cmd.output().map(|o| o.status.success()).unwrap_or(false);
        if ok { Some(path) } else { None }
}

fn cleanup_worktree(workdir: &str, task_id: &str) {
    let slug = slugify(task_id);
    let Some(home) = std::env::var("HOME").ok() else { return };
    let path = PathBuf::from(&home).join(".bridge").join("worktrees").join(&slug);
    let _ = Command::new("git")
        .current_dir(workdir)
        .args(["worktree", "remove", "--force"])
        .arg(&path)
        .output();
}

fn extract_pr(stdout: &str) -> Option<String> {
    for tok in stdout.split_whitespace() {
        // URLs are often wrapped in markdown ("[View PR](https://…/pull/1)")
        // or prefixed with quotes/punctuation — match anywhere in the token,
        // not just at its start, so formatting can't break the handoff.
        let idx = match tok.find("https://") {
            Some(i) => i,
            None => continue,
        };
        let url = &tok[idx..];
        if !url.contains("/pull/") {
            continue;
        }
        return Some(
            url.trim_end_matches(|c| c == ')' || c == ',' || c == '.' || c == '"' || c == ']' || c == ';')
                .to_string(),
        );
    }
    None
}

/// Spawn an opencode session for a task: strict policy pre-prompt + task body +
/// delivery contract (commit, push branch, open PR). Uses an isolated worktree
/// when cfg.isolate and the repo allows it; otherwise falls back to cfg.workdir.
fn spawn_opencode(
    cfg: &DispatchConfig,
    snap: &SharedSnapshot,
    tid: &str,
    title: &str,
    body_md: &str,
    policy: &str,
    resume_session: Option<String>,
    in_flight: &mut Vec<InFlight>,
) {
    let resume = resume_session.is_some();
    let worktree = if cfg.isolate {
        ensure_worktree(&cfg.workdir, tid, resume)
    } else {
        None
    };
    let run_dir = worktree
        .clone()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| cfg.workdir.clone());
    let branch = format!("bridge/{}", slugify(tid));
    let resume_note = resume_session
        .as_ref()
        .map(|s| format!("\n\nYou are resuming session {s} — pick up where you left off; do not restart the task from scratch."))
        .unwrap_or_default();
    let prompt = format!(
        "{}\n\n# Task\n\n{}: {}\n\n{}\n{}\n\n# Delivery contract\n\n- You are working in {} on branch `{}` (an isolated git worktree).\n- Commit your work, push the branch, and open a PR against the default branch (`gh pr create`).\n- When finished, output a concise summary including the PR URL.\n- Do NOT merge, do NOT push to the default branch, do NOT touch files outside this worktree.",
        policy, tid, title, body_md, resume_note, run_dir, branch
    );
    // clone for the ephemeral state file: the closure below moves the original
    let resume_session_for_state = resume_session.clone();
    eprintln!(
        "[dispatch] {tid} dispatched — {} opencode session bridge-{tid}{}",
        if resume {
            format!("resuming session {}", resume_session.as_deref().unwrap_or("?"))
        } else {
            "new".to_string()
        },
        worktree
            .as_ref()
            .map(|p| format!(" (worktree {})", p.display()))
            .unwrap_or_default(),
    );
    snap_activity(
        snap,
        "dispatch",
        &format!(
            "{tid} dispatched — {}",
            if resume { "resumed session" } else { "new session" }
        ),
    );
    let outcome = {
        let cfg2 = cfg.clone();
        let tid2 = tid.to_string();
        let (tx, rx) = std::sync::mpsc::channel::<opencode::RunOutcome>();
        std::thread::spawn(move || {
            let out = opencode::run_task(
                &run_dir,
                &cfg2.opencode_bin,
                cfg2.agent.as_deref(),
                &prompt,
                Duration::from_secs(cfg2.timeout_mins * 60),
                Some(&format!("bridge-{tid2}")),
                resume_session.as_deref(),
            );
            let _ = tx.send(out);
        });
        rx
    };
    in_flight.push(InFlight {
        task_id: tid.to_string(),
        task_title: title.to_string(),
        started: std::time::Instant::now(),
        last_note: String::new(),
        worktree,
        pr_url: None,
        rx: outcome,
    });
    // ephemeral state file: headless observability (removed on completion)
    write_task_state(
        tid,
        &serde_json::json!({
            "task_id": tid,
            "task_title": title,
            "status": if resume { "resumed" } else { "running" },
            "started_ts": now_ms(),
            "session": resume_session_for_state,
            "worktree": in_flight.last().and_then(|i| i.worktree.clone()).map(|p| p.to_string_lossy().to_string()),
        }),
    );
    snap_in_flight_list(snap, in_flight);
}

fn tick(
    cfg: &DispatchConfig,
    id: &mut i64,
    in_flight: &mut Vec<InFlight>,
    attempts: &mut HashMap<String, Instant>,
    finished_no_pr: &mut HashSet<String>,
    snap: &SharedSnapshot,
) -> Result<Vec<String>, String> {
    let mut msgs = Vec::new();

    // 1. drain finished sessions: finalize each (progress + in_review + cleanup)
    let mut finished: Vec<(InFlight, opencode::RunOutcome)> = Vec::new();
    in_flight.retain_mut(|inf| match inf.rx.try_recv() {
        Ok(outcome) => {
            finished.push((
                InFlight {
                    task_id: inf.task_id.clone(),
                    task_title: inf.task_title.clone(),
                    started: inf.started,
                    last_note: inf.last_note.clone(),
                    pr_url: inf.pr_url.clone(),
                    worktree: inf.worktree.clone(),
                    rx: std::sync::mpsc::channel().1,
                },
                outcome,
            ));
            false
        }
        Err(TryRecvError::Empty) => true,
        Err(TryRecvError::Disconnected) => {
            // sender thread died without sending (panic) — treat as failure
            finished.push((
                InFlight {
                    task_id: inf.task_id.clone(),
                    task_title: inf.task_title.clone(),
                    started: inf.started,
                    last_note: inf.last_note.clone(),
                    pr_url: inf.pr_url.clone(),
                    worktree: inf.worktree.clone(),
                    rx: std::sync::mpsc::channel().1,
                },
                opencode::RunOutcome {
                    ok: false,
                    exit_code: None,
                    timed_out: false,
                    stdout_tail: String::new(),
                    stderr_tail: "opencode runner thread died (no outcome)".into(),
                },
            ));
            false
        }
    });
    if !finished.is_empty() {
        snap_in_flight_list(snap, in_flight);
    }
    for (mut inf, outcome) in finished {
        let mins = inf.started.elapsed().as_secs() / 60;
        let pr_url = extract_pr(&outcome.stdout_tail);
        inf.pr_url = pr_url.clone();
        let tail = if outcome.stdout_tail.is_empty() {
            outcome.stderr_tail.clone()
        } else {
            outcome.stdout_tail.clone()
        };
        let mut note = format!(
            "opencode {} in ~{}m (exit {:?}) — {}",
            if outcome.timed_out { "TIMED OUT" } else { "finished" },
            mins,
            outcome.exit_code,
            tail
        );
        if let Some(pr) = &pr_url {
            note.push_str(&format!("\nPR: {pr}"));
        }
        // CLI log: the agent's final reply (first lines, capped) — the full
        // note goes to the bridge via log_progress below.
        let reply_excerpt: String = {
            let lines: Vec<&str> = tail.lines().take(4).collect();
            let mut s = lines.join(" | ");
            if s.chars().count() > 300 {
                s = s.chars().take(300).collect::<String>() + "…";
            }
            s
        };
        eprintln!(
            "[dispatch] {} {} in ~{}m — agent reply: {}",
            inf.task_id,
            if outcome.timed_out { "TIMED OUT" } else { "finished" },
            mins,
            reply_excerpt
        );
        let _ = mcp_call(
            cfg,
            id,
            "log_progress",
            json!({
                "id": inf.task_id,
                "note": note,
                "sentiment": if outcome.ok { "converging" } else { "struggling" },
            }),
        );
        // persist final state (incl. PR link and exit code) before handoff
        write_task_state(
            &inf.task_id,
            &serde_json::json!({
                "task_id": &inf.task_id,
                "task_title": &inf.task_title,
                "status": if outcome.ok { "finished" } else { "failed" },
                "started_ts": now_ms() - inf.started.elapsed().as_millis() as u64,
                "ended_ts": now_ms(),
                "exit_code": outcome.exit_code,
                "pr_url": &pr_url,
                "last_note": &note,
                "stdout_tail": &outcome.stdout_tail,
            }),
        );
        if outcome.ok {
            // handoff gate wants a PR link in the note; if opencode didn't
            // produce one the gate rejects and we stay in_progress.
            match mcp_call(
                cfg,
                id,
                "transition",
                json!({ "id": inf.task_id, "to": "in_review", "note": note }),
            ) {
                Ok(_) => {
                    // handed off: work is done — remove the ephemeral state file
                    remove_task_state(&inf.task_id);
                    attempts.remove(&inf.task_id);
                    msgs.push(format!(
                        "{} → in_review{}",
                        inf.task_title,
                        pr_url
                            .as_ref()
                            .map(|p| format!(" — PR {p}"))
                            .unwrap_or_default()
                    ));
                }
                Err(_) => {
                    // opencode exited cleanly but produced no PR — likely an
                    // analysis/verification task with nothing to ship. Terminal
                    // for this runner: review pickup takes over from here.
                    // Without this mark the resume loop re-dispatched the same
                    // finished session every tick forever.
                    finished_no_pr.insert(inf.task_id.clone());
                    remove_task_state(&inf.task_id);
                    msgs.push(format!(
                        "{} finished (no PR link — left in_progress for review pickup)",
                        inf.task_title
                    ));
                }
            }
        } else {
            // failed/timed out — keep in_progress and set backoff so we don't
            // hammer the same failing task every tick (previously removed the
            // backoff entry here, causing an immediate re-dispatch loop).
            attempts.insert(inf.task_id.clone(), Instant::now());
            msgs.push(format!("{} failed/timed out — left in_progress (backoff)", inf.task_title));
        }
        // PR monitoring v1: record the handoff so the review flow can be tracked;
        // automated verdict reaction (CI fail → bounce + fix) lands with the PR watch loop
        if let Some(pr) = pr_url {
            let _ = mcp_call(
                cfg,
                id,
                "log_progress",
                json!({ "id": inf.task_id, "note": format!("watching PR {pr} for review verdict"), "sentiment": "neutral" }),
            );
        }
        if inf.worktree.is_some() {
            cleanup_worktree(&cfg.workdir, &inf.task_id);
        }
        snap_activity(snap, "finish", &msgs.last().cloned().unwrap_or_default());
    }

    // heartbeat is the AGENT's job (protocol card: log_progress every ≤10 min
    // via its own bridge MCP). The dispatcher must not fabricate "still working"
    // notes on the agent's behalf — that would mask genuine agent silence from
    // the watchdog. The dispatcher only logs its OWN actions (claim, handoff,
    // finish) in the sections below.
    if !in_flight.is_empty() {
        snap_in_flight_list(snap, in_flight);
    }

    // 3. capacity? nothing to schedule if all sessions busy
    if in_flight.len() >= cfg.max_sessions {
        return Ok(msgs);
    }

    // 4. orient — once per tick when we have capacity
    let orient = mcp_call(cfg, id, "orient", json!({}))?;
    let policy = orient
        .get("instructions")
        .and_then(|v| v.as_str())
        .unwrap_or("Follow the bridge protocol card: claim before coding, heartbeat every 10 min, ask when uncertain, finish with a PR.")
        .to_string();

    // 5. previously-dispatched work still open → RESUME it first (claims persist;
    // the opencode session is rediscoverable by its deterministic title
    // bridge-<task_id>, so mid-flight runs survive runner/app restarts).
    let my_tasks = orient
        .get("my_tasks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let open_mine: Vec<&serde_json::Value> = my_tasks
        .iter()
        .filter(|t| t.get("status").and_then(|s| s.as_str()) == Some("in_progress"))
        .collect();
    for t in open_mine {
        if in_flight.len() >= cfg.max_sessions {
            break;
        }
        let (Some(tid), Some(title)) = (
            t.get("id").and_then(|v| v.as_str()),
            t.get("title").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        if in_flight.iter().any(|inf| inf.task_id == tid) {
            continue; // already running
        }
        // terminal: opencode already finished this task without a PR (analysis
        // /verification work). Never re-dispatch a completed session.
        if finished_no_pr.contains(tid) {
            continue;
        }
        // backoff: a task that just failed to spawn shouldn't retry every tick
        if attempts
            .get(tid)
            .map(|a| a.elapsed() < Duration::from_secs(300))
            .unwrap_or(false)
        {
            mcp_call(
                cfg,
                id,
                "log_progress",
                json!({ "id": tid, "note": format!("dispatch runner heartbeat — '{title}' is open; opencode resume backed off after a failed attempt"), "sentiment": "neutral" }),
            )?;
            continue;
        }
        let sess = session_id_for(&cfg.opencode_bin, &cfg.workdir, tid);
        let msg = match &sess {
            Some(s) => format!("resumed {tid} — continuing opencode session {s}"),
            None => format!("re-dispatched {tid} — no prior opencode session found, started fresh"),
        };
        spawn_opencode(cfg, snap, tid, title, "", &policy, sess, in_flight);
        attempts.insert(tid.to_string(), Instant::now());
        snap_activity(snap, "dispatch", &msg);
        msgs.push(msg);
    }

    // 6. claim new claimable tasks until the WIP limit is reached
    let candidates = orient
        .get("unclaimed_work")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for task in candidates {
        if in_flight.len() >= cfg.max_sessions {
            break;
        }
        let (Some(tid), Some(title)) = (
            task.get("id").and_then(|v| v.as_str()),
            task.get("title").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        if in_flight.iter().any(|inf| inf.task_id == tid)
            || attempts
                .get(tid)
                .map(|a| a.elapsed() < Duration::from_secs(300))
                .unwrap_or(false)
        {
            continue;
        }
        if let Err(e) = mcp_call(cfg, id, "transition", json!({ "id": tid, "to": "in_progress" })) {
            // claim raced or failed — don't kill the tick or the whole claim loop
            attempts.insert(tid.to_string(), Instant::now());
            snap_activity(snap, "error", &format!("claim {tid} failed: {e}"));
            continue;
        }
        // fetch the body so the policy pre-prompt carries the actual task
        let body_md = mcp_call(cfg, id, "get_artefact", json!({ "id": tid }))
            .ok()
            .and_then(|v| v.get("body_md").and_then(|b| b.as_str()).map(String::from))
            .unwrap_or_default();
        let _ = mcp_call(
            cfg,
            id,
            "log_progress",
            json!({ "id": tid, "note": format!("dispatch runner: claimed '{title}' — dispatching to opencode"), "sentiment": "going_well" }),
        );
        spawn_opencode(cfg, snap, tid, &title, &body_md, &policy, None, in_flight);
        attempts.insert(tid.to_string(), Instant::now());
        let msg = format!("claimed {tid} — dispatched to opencode");
        snap_activity(snap, "dispatch", &msg);
        msgs.push(msg);
    }

    Ok(msgs)
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
    let mut in_flight: Vec<InFlight> = Vec::new();
    let mut attempts: HashMap<String, Instant> = HashMap::new();
    let mut finished_no_pr: HashSet<String> = HashSet::new();
    eprintln!(
        "[dispatch] loop started — {} (poll every {}s, workdir {}, up to {} concurrent sessions)",
        cfg.url, cfg.poll_secs, cfg.workdir, cfg.max_sessions
    );
    if let Ok(mut s) = snap.lock() {
        s.running = true;
        s.url = Some(cfg.url.clone());
        s.workspace = cfg.ws.clone();
        s.label = cfg.label.clone();
        s.agent = cfg.agent.clone();
        s.workdir = Some(cfg.workdir.clone());
        s.max_sessions = cfg.max_sessions;
    }
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        match tick(
            &cfg,
            &mut id,
            &mut in_flight,
            &mut attempts,
            &mut finished_no_pr,
            &snap,
        ) {
            Ok(msgs) => {
                for msg in msgs {
                    eprintln!("[dispatch] {msg}");
                }
            }
            Err(e) => {
                eprintln!("[dispatch] error: {e}");
                snap_activity(&snap, "error", &e);
                if let Ok(mut g) = last_error.lock() {
                    *g = Some(e);
                }
            }
        }
        // ephemeral flat-file state: keep ~/.bridge/dispatch/runner.json in sync
        write_runner_state(&snap);
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
        s.in_flight = Vec::new();
    }
    write_runner_state(&snap);
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
    // persist the stop signal immediately so the flat file reflects it even
    // before the loop drains its current sleep slice
    write_runner_state(&state.snapshot);
}
