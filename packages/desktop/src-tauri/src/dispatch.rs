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
    #[serde(default)]
    pub model: Option<String>, // agent model override; unset = the agent CLI's own config decides
    #[serde(default)]
    pub backend: Option<String>, // "opencode" (default) | "kiro" — which agent CLI drives the tasks
    #[serde(default = "default_poll_secs")]
    pub poll_secs: u64,
    #[serde(default = "default_timeout_mins")]
    pub timeout_mins: u64,
    #[serde(default = "default_opencode_bin")]
    pub opencode_bin: String,
    #[serde(default)]
    pub label: Option<String>, // agent identity from pairing
    #[serde(default)]
    pub agent_name: Option<String>, // name dispatched tasks are attributed to (override for the <hostname>-<backend> autogen)
    #[serde(default)]
    pub ws: Option<String>, // workspace slug from pairing
    #[serde(default = "default_max_sessions")]
    pub max_sessions: usize, // WIP limit for this node
    #[serde(default)]
    pub report_minutes: Option<u64>, // Some(n): periodic heartbeat cadence for agents; None: report like a human (meaningful steps only)
    #[serde(default)]
    pub isolate: bool, // per-task git worktrees + PR branch
    #[serde(default)]
    pub backends: Option<Vec<String>>, // multiple agent types; rotate per dispatch
    #[serde(default)]
    pub models: Option<std::collections::HashMap<String, String>>, // model per backend — required for opencode (explicit-model policy)
    #[serde(default)]
    pub agents: Option<std::collections::HashMap<String, String>>, // agent profile per backend (opencode profiles; kiro profiles)
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
            model: std::env::var("BRIDGE_MODEL").ok(),
            backend: std::env::var("BRIDGE_BACKEND").ok(),
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
            report_minutes: std::env::var("BRIDGE_REPORT_MINUTES")
                .ok()
                .and_then(|v| v.parse().ok())
                .filter(|&n| (1..=60).contains(&n)),
            isolate: !matches!(
                std::env::var("BRIDGE_ISOLATE").as_deref(),
                Ok("0") | Ok("false") | Ok("no")
            ),
            backends: std::env::var("BRIDGE_BACKENDS")
                .ok()
                .map(|v| v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect::<Vec<_>>()),
            models: std::env::var("BRIDGE_MODEL")
                .ok()
                .map(|m| std::collections::HashMap::from([("opencode".to_string(), m)])),
            agents: None,
            label: None,
            agent_name: None,
            ws: None,
        })
    }

    /// Stable session name for this runner — every MCP call carries it so the
    /// hub's session registry (and the board's online dots) stay fresh.
    pub fn session_name(&self) -> String {
        let slug = |s: &str| -> String {
            s.chars().filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_').collect()
        };
        format!("dispatch-{}", slug(self.label.as_deref().unwrap_or("runner")))
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
/// Device-flow pairing, shared by the desktop app and the CLI's onboarding:
/// prints a code, polls until the human approves, returns the half-filled config.
pub fn pair_device(url: &str) -> Result<DispatchConfig, String> {
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
        .body(json!({ "device": device }).to_string())
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
                    model: std::env::var("BRIDGE_MODEL").ok(),
                    backend: std::env::var("BRIDGE_BACKEND").ok(),
                    poll_secs: default_poll_secs(),
                    timeout_mins: default_timeout_mins(),
                    opencode_bin: default_opencode_bin(),
                    label,
                    agent_name: None,
                ws: Some(ws),
                max_sessions: default_max_sessions(),
                report_minutes: None,
                isolate: default_isolate(),
                    backends: None,
                    models: None,
                    agents: None,
                });
            }
            Some("expired") => return Err("pairing code expired — run again".into()),
            other => return Err(format!("pairing failed: {other:?}")),
        }
    }
}

/// Snapshot of resumable opencode sessions: title → session id. Dispatched runs
/// are titled `bridge-<task_id>`, so sessions are rediscoverable across
/// runner/app restarts — one `session list` per tick serves every lookup.
fn session_map(bin: &str, workdir: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Some(out) = Command::new(bin)
        .arg("session")
        .arg("list")
        .arg("--format")
        .arg("json")
        .current_dir(workdir)
        .output()
        .ok()
    else {
        return map;
    };
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else {
        return map;
    };
    let items = match v {
        serde_json::Value::Array(a) => a,
        serde_json::Value::Object(o) => match o.get("sessions").and_then(|s| s.as_array()) {
            Some(a) => a.clone(),
            None => return map,
        },
        _ => return map,
    };
    for item in items {
        let title = item.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string();
        if let Some(id) = item
            .get("id")
            .or_else(|| item.get("sessionID"))
            .and_then(|i| i.as_str())
        {
            map.insert(title, id.to_string());
        }
    }
    map
}

/// Find the opencode session id for a dispatched task, from a fresh session map.
/// (One `session list` per lookup — use `session_map` when scanning candidates.)
#[allow(dead_code)]
fn session_id_for(bin: &str, workdir: &str, task_id: &str) -> Option<String> {
    let want = format!("bridge-{task_id}");
    session_map(bin, workdir).into_iter().find(|(title, _)| {
        title == &want || title.contains(&want)
    }).map(|(_, id)| id)
}

// ---- bridge MCP client (JSON-RPC over POST /mcp) ----

fn mcp_call(
    cfg: &DispatchConfig,
    id: &mut i64,
    tool: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    mcp_call_session(cfg, id, tool, args, None)
}

/// MCP call with an explicit session name. Task-scoped calls use
/// `dispatch-<task_id>`: every opencode dispatch IS a fresh agent session, and
/// per-task attribution is what lets separation-of-duties pass honestly — the
/// session that implemented a task is never the session that verifies it.
fn mcp_call_session(
    cfg: &DispatchConfig,
    id: &mut i64,
    tool: &str,
    mut args: serde_json::Value,
    session: Option<&str>,
) -> Result<serde_json::Value, String> {
    *id += 1;
    if let Some(obj) = args.as_object_mut() {
        let name = session.map(String::from).unwrap_or_else(|| cfg.session_name());
        obj.entry("session").or_insert_with(|| json!(name));
    }
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

/// Task-scoped call: session attributed to the task's own dispatch session,
/// and the call attributed to the AGENT the gateway dispatched as
/// (ADR BR#899: gateways are infrastructure and never task owners). The
/// agent name autogens as <hostname>-<backend> (macbookpro-opencode) —
/// honoured by the hub only when the token carries the "gateway" tag.
fn mcp_call_task(
    cfg: &DispatchConfig,
    id: &mut i64,
    tool: &str,
    mut args: serde_json::Value,
    task_id: &str,
) -> Result<serde_json::Value, String> {
    if let Some(obj) = args.as_object_mut() {
        obj.insert("agent".into(), json!(agent_identity(cfg)));
    }
    mcp_call_session(cfg, id, tool, args, Some(&format!("dispatch-{}", slugify(task_id))))
}

/// The agent name dispatched tasks are attributed to: config override
/// (`agent_name`), else <hostname>-<backend> (autogen, stable per machine).
fn agent_identity(cfg: &DispatchConfig) -> String {
    if let Some(a) = &cfg.agent_name {
        return a.clone();
    }
    let host = std::process::Command::new("hostname")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "gateway".into());
    let backend = cfg.backends.as_ref().and_then(|b| b.first().cloned())
        .or_else(|| cfg.backend.clone())
        .unwrap_or_else(|| "opencode".into());
    format!("{}-{}", slugify(&host).to_lowercase(), slugify(&backend).to_lowercase())
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
            "pid": std::process::id(),
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

/// Snapshot of a dispatch loop running in ANOTHER process (headless runner).
/// runner.json is written every tick — in-flight list + recent activity.
/// Null when no runner has ever written state here.
pub fn external_snapshot() -> Option<serde_json::Value> {
    let dir = dispatch_dir()?;
    let raw = std::fs::read_to_string(dir.join("runner.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    Some(v)
}

/// Pid of a dispatch loop alive in ANOTHER process, if any. Guards the
/// dual-runner race: the desktop GUI used to auto-start its own loop while a
/// headless runner polled the same hub — two claimers racing on one board.
/// Stale files (crashed runner) are detected via pid liveness; our own pid
/// never counts as external.
pub fn external_runner_pid() -> Option<u32> {
    let v = external_snapshot()?;
    let pid = v.get("pid")?.as_u64()? as u32;
    if pid == std::process::id() {
        return None;
    }
    if !v.get("running").and_then(|r| r.as_bool()).unwrap_or(false) {
        return None;
    }
    let alive = Command::new("ps")
        .args(["-o", "pid=", "-p", &pid.to_string()])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if alive { Some(pid) } else { None }
}

/// "For you" payload for the desktop panel: the human's inbox, read-only.
/// Machine-plane list queries (agent token) — decisions/blocked/questions.
/// Human-authoritative actions (accept/reject) stay in the webapp; rows carry
/// the hub URL so the panel can deep-link. Runs on a blocking thread.
pub fn for_you_payload() -> Result<serde_json::Value, String> {
    let cfg = DispatchConfig::resolve().ok_or("not configured — pair first")?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let get = |q: &str| -> Result<serde_json::Value, String> {
        Ok(client
            .get(format!("{}/api/kb-machine/list{}", cfg.url.trim_end_matches('/'), q))
            .header("Authorization", format!("Bearer {}", cfg.token))
            .send()
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json::<serde_json::Value>()
            .map_err(|e| e.to_string())?
            .get("artefacts")
            .cloned()
            .unwrap_or_else(|| json!([])))
    };
    let decisions = get("?type=decision&status=proposed&limit=50")?;
    let blocked = get("?type=task&status=blocked&limit=50")?;
    let questions = get("?type=task&tag=question&limit=50")?;
    Ok(json!({
        "url": cfg.url,
        "decisions": decisions,
        "blocked": blocked,
        "questions": questions,
    }))
}

// ---- dispatch state (shared with Tauri commands) ----

struct InFlight {
    task_id: String,
    task_title: String,
    /// role tags recorded at claim time — decide done-vs-in_review from what
    /// the task IS, not title heuristics (analysis/unblock work finished with
    /// no PR used to bounce off the in_review handoff gate and loop forever)
    role_work: bool,
    started: std::time::Instant,
    last_note: String,
    worktree: Option<PathBuf>, // isolated worktree to clean up on finalize
    pr_url: Option<String>,    // PR opened by the session, monitored after handoff
    rx: std::sync::mpsc::Receiver<opencode::RunOutcome>,
    live: Arc<std::sync::Mutex<String>>, // agent's latest output line (mid-run)
}

impl InFlight {
    fn live_line(&self) -> String {
        self.live.lock().ok().map(|g| g.clone()).unwrap_or_default()
    }
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

/// Multiple agent types: rotate across cfg.backends (config order); fall back
/// to the single `backend` field. Round-robin spreads local work across the
/// enabled CLIs instead of stacking every task on one.
fn pick_backend(avail: &[opencode::Backend]) -> opencode::Backend {
    static RR: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let i = RR.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % avail.len().max(1);
    avail.get(i).copied().unwrap_or(opencode::Backend::OpenCode)
}

/// Backends actually dispatchable right now: the CLI runs on this machine AND
/// a model is configured for it (explicit-model policy). The gateway must not
/// claim work it has no agent to dispatch to — claiming first and failing
/// spawn second pollutes the board with claimed-but-stuck tasks.
fn available_backends(cfg: &DispatchConfig) -> Vec<opencode::Backend> {
    let configured: Vec<(opencode::Backend, String)> = cfg
        .backends
        .clone()
        .filter(|v| !v.is_empty())
        .or_else(|| cfg.backend.clone().map(|b| vec![b]))
        .unwrap_or_else(|| vec!["opencode".into()])
        .into_iter()
        .map(|name| (opencode::Backend::parse(Some(&name)), name))
        .collect();
    configured
        .into_iter()
        .filter(|(backend, name)| {
            let model_ok = cfg
                .models
                .as_ref()
                .and_then(|m| m.get(name))
                .map(|m| !m.trim().is_empty())
                .unwrap_or(false)
                || (cfg.backends.is_none()
                    && cfg.model.as_deref().map(|m| !m.trim().is_empty()).unwrap_or(false));
            let bin = match backend {
                opencode::Backend::OpenCode => cfg.opencode_bin.clone(),
                opencode::Backend::Kiro => "kiro".to_string(),
            };
            let bin_ok = std::process::Command::new(&bin)
                .arg("--version")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            model_ok && bin_ok
        })
        .map(|(b, _)| b)
        .collect()
}

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

fn cleanup_worktree(workdir: &str, task_id: &str, drop_branch: bool) {
    let slug = slugify(task_id);
    let Some(home) = std::env::var("HOME").ok() else { return };
    let path = PathBuf::from(&home).join(".bridge").join("worktrees").join(&slug);
    let _ = Command::new("git")
        .current_dir(workdir)
        .args(["worktree", "remove", "--force"])
        .arg(&path)
        .output();
    if drop_branch {
        // terminal (done): the work is merged or rejected — bridge/<slug> has
        // no future. On todo releases the branch is KEPT: a re-claim attaches
        // to it, preserving any unpushed stall work.
        let _ = Command::new("git")
            .current_dir(workdir)
            .args(["branch", "-D"])
            .arg(&format!("bridge/{slug}"))
            .output();
    }
}

/// Reconcile ~/.bridge/worktrees/ with live task status. Terminal tasks (done,
/// superseded) and released tasks (todo) must not hold worktrees on disk — the finalize
/// path cleans `done` handoffs, but yielded runs, pre-sweep history and
/// handoff-rejections leave stragglers. in_progress/in_review/blocked worktrees
/// are kept: they are the session's resume assets. Capped per tick so a large
/// backlog drains without stalling the dispatch loop.
const WORKTREE_SWEEP_CAP: usize = 20;
static SWEEP_COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn sweep_stale_worktrees(cfg: &DispatchConfig, id: &mut i64, in_flight: &[InFlight], msgs: &mut Vec<String>) {
    let Some(home) = std::env::var("HOME").ok() else { return };
    let dir = PathBuf::from(&home).join(".bridge").join("worktrees");
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    let active: HashSet<String> = in_flight
        .iter()
        .filter_map(|inf| inf.worktree.as_ref())
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
        .collect();
    let mut slugs: Vec<String> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|s| !s.is_empty() && !active.contains(s))
        .collect();
    slugs.sort();
    let mut swept = 0;
    for slug in slugs {
        if swept >= WORKTREE_SWEEP_CAP {
            break;
        }
        // reverse slugify: BR-1003 → BR#1003; TASK-010 → TASK-010
        let task_id = match slug.strip_prefix("BR-") {
            Some(num) if num.chars().all(|c| c.is_ascii_digit()) => format!("BR#{num}"),
            _ => slug.clone(),
        };
        // only explicit statuses — an MCP/network error keeps the worktree
        let status = mcp_call(cfg, id, "get_artefact", json!({ "id": task_id }))
            .ok()
            .and_then(|v| v.get("status").and_then(|s| s.as_str()).map(String::from));
        match status.as_deref() {
            Some("done") | Some("superseded") => {
                swept += 1;
                cleanup_worktree(&cfg.workdir, &task_id, true);
                let _ = std::fs::remove_dir_all(dir.join(&slug));
                msgs.push(format!("swept worktree {slug} — task {task_id} is {}", status.unwrap_or_else(|| "done".into())));
            }
            Some("todo") => {
                swept += 1;
                cleanup_worktree(&cfg.workdir, &task_id, false);
                let _ = std::fs::remove_dir_all(dir.join(&slug));
                msgs.push(format!("swept worktree {slug} — task {task_id} released to todo (branch kept for re-claim)"));
            }
            _ => {}
        }
    }
    if swept > 0 {
        let _ = Command::new("git").current_dir(&cfg.workdir).arg("worktree").arg("prune").output();
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max).collect::<String>()) }
}

// ---- backend session registry (kiro) ----
//
// opencode sessions carry bridge-<task_id> titles so they're rediscoverable.
// Kiro has no titles: the runner records task → session_id in a sidecar file
// after each run and reads it back on resume.

fn sessions_file() -> Option<PathBuf> {
    Some(dispatch_dir()?.join("sessions.json"))
}

fn load_session_registry() -> HashMap<String, String> {
    let Some(path) = sessions_file() else { return HashMap::new() };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_session_id(task_id: &str, session_id: &str) {
    let Some(path) = sessions_file() else { return };
    let mut reg = load_session_registry();
    reg.insert(task_id.to_string(), session_id.to_string());
    let _ = std::fs::write(
        &path,
        serde_json::to_string_pretty(&reg).unwrap_or_default(),
    );
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

/// VOID-RUN detection (BR#877 rule 3, hard runner rule): a dispatch that
/// performed NO work — model blocked by provider guardrails, zero endpoints —
/// still exits 0 (the CLI prints the error and quits cleanly). Such a run
/// must never hand off: its "receipts" would be void (the guardrails error
/// page cited as a PR — BR#860/863/866/844/855 class). Treated as failure:
/// backoff, then blocked-for-attention, never done, never in_review.
fn void_run(stdout: &str, stderr: &str) -> bool {
    const SIGS: [&str; 3] = [
        "Model blocked by guardrail",
        "0 endpoints out of",
        "no endpoints are available matching your guardrail",
    ];
    SIGS.iter().any(|s| stdout.contains(s) || stderr.contains(s))
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
    role_work: bool,
    avail: &[opencode::Backend],
    in_flight: &mut Vec<InFlight>,
) {
    let backend = pick_backend(avail);
    let backend_name = match backend {
        opencode::Backend::OpenCode => "opencode",
        opencode::Backend::Kiro => "kiro",
    };
    // per-backend settings: each CLI talks to different providers, so model
    // requirements differ. opencode dispatches a bare CLI whose default model
    // is whatever its own config says (the stale-haiku lesson) — there a model
    // is REQUIRED. kiro is profile-driven (its profiles pin provider+model),
    // so a model here is optional; the profile is the config.
    let agent_profile = cfg
        .agents
        .as_ref()
        .and_then(|m| m.get(backend_name))
        .cloned()
        .or_else(|| cfg.agent.clone());
    let model = cfg
        .models
        .as_ref()
        .and_then(|m| m.get(backend_name))
        .cloned()
        .or_else(|| cfg.model.clone());
    if model.is_none() && backend == opencode::Backend::OpenCode {
        let msg = format!(
            "runner: no model configured for backend '{backend_name}' — set it in Settings (opencode needs an explicit model); task {tid} not dispatched",
        );
        eprintln!("[dispatch] {msg}");
        snap_activity(snap, "error", &msg);
        return;
    }
    let model_str = model.clone().unwrap_or_default();
    let resume_session = if resume_session.is_none() && backend == opencode::Backend::Kiro {
        load_session_registry().get(tid).cloned() // kiro resume via sidecar registry
    } else {
        resume_session
    };
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
    // Reporting cadence: None (default) = report like a human collaborator —
    // meaningful steps and findings only, no fixed interval. The runner relays
    // your stdout lines to the board every poll, so your normal narration keeps
    // the task visibly alive; you do NOT need scheduled heartbeats. Explicit
    // report_minutes restores a fixed cadence for agents that narrate nothing.
    let heartbeat_line = match cfg.report_minutes {
        Some(mins) => format!(
            "- HEARTBEAT: call log_progress via the bridge MCP every ~{mins} minutes — one line: what you just did + what you do next. The board is your only visible output; silence reads as abandonment and gets the task reassigned."
        ),
        None => "- REPORTING: report progress the way you would to a human user — when you complete a meaningful step, hit a finding, or change direction; not on a timer. The runner relays your output to the board automatically, so narrating your work in your normal output (brief, one line at natural milestones) is enough to keep the task visibly alive.".to_string(),
    };
    // PRs only for CODE work (BR#877: receipts must match the deliverable type):
    // verify/analysis/unblock tasks deliver on the BOARD (knowledge/progress
    // notes with receipts) — a PR per receipt-finding was drowning the queue
    // (51 open docs-PRs in a day). The role flag recorded at claim time
    // decides which contract the session gets.
    let delivery_line = if role_work {
        "- Deliver on the board: your findings, verdicts, and receipts go into log_progress / knowledge artefacts with exact citations (GitHub PR/issue/run URLs only — a non-GitHub URL is not a receipt). No commit or PR unless you actually changed code.\n- If you DID change code: commit your work, push the branch, and open a PR against the default branch (`gh pr create`), and include the PR URL in your summary. Docs ride with the change: user-visible behaviour updates README.md and packages/site/content.md in the same branch."
    } else {
        "- Commit your work, push the branch, and open a PR against the default branch (`gh pr create`).\n- When finished, output a concise summary including the PR URL.\n- Docs ride with the change: if your work alters user-visible behaviour (UI, config, protocol, gates), update README.md and packages/site/content.md in the same branch."
    };
    let prompt = format!(
        "{}\n\n# Task\n\n{}: {}\n\n{}\n{}\n\n# Delivery contract\n\n- You are working in {} on branch `{}` (an isolated git worktree).\n{}\n{}\n- Blocked on a decision or missing input? File the ask via ask_agent, transition the task to blocked (note + unblock condition), and END your run — do not wait. The task re-enters the pool when unblocked and a later session (possibly yours, via resume) picks it up.\n- Do NOT merge, do NOT push to the default branch, do NOT touch files outside this worktree.\n- Scratch git worktrees or extra branches you create inside this worktree are your responsibility — remove them (`git worktree remove`, `git branch -d`) before you end the run. Do not leave litter behind: the dispatch worktree itself is managed by the runner, but anything you create beyond it is on you.",
        policy, tid, title, body_md, resume_note, run_dir, branch, heartbeat_line, delivery_line
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
    // live progress cell: the opencode stdout reader writes the agent's latest
    // output line here; the heartbeat reads it so the board shows mid-run activity
    let live = Arc::new(std::sync::Mutex::new(String::new()));
    let live_for_task = live.clone();
    let outcome = {
        let cfg2 = cfg.clone();
        let tid2 = tid.to_string();
        let (tx, rx) = std::sync::mpsc::channel::<opencode::RunOutcome>();
        std::thread::spawn(move || {
            let backend = opencode::Backend::parse(cfg2.backend.as_deref());
            let out = opencode::run_task(
                &run_dir,
                &cfg2.opencode_bin,
                backend,
                agent_profile.as_deref(),
                Some(model_str.as_str()).filter(|s| !s.is_empty()),
                &prompt,
                Duration::from_secs(cfg2.timeout_mins * 60),
                Some(&format!("bridge-{tid2}")),
                resume_session.as_deref(),
                Some(live_for_task),
            );
            if backend == opencode::Backend::Kiro {
                if let Some(sid) = &out.session_id {
                    save_session_id(&tid2, sid);
                }
            }
            let _ = tx.send(out);
        });
        rx
    };
    in_flight.push(InFlight {
        task_id: tid.to_string(),
        task_title: title.to_string(),
        role_work,
        started: std::time::Instant::now(),
        last_note: String::new(),
        worktree,
        pr_url: None,
        rx: outcome,
        live,
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
    fail_counts: &mut HashMap<String, u32>,
    finished_no_pr: &mut HashSet<String>,
    gave_up: &mut HashSet<String>,
    snap: &SharedSnapshot,
    avail: &mut Vec<opencode::Backend>,
    last_avail_ok: &mut bool,
) -> Result<Vec<String>, String> {
    let mut msgs = Vec::new();

    // dispatchability gate: re-check every tick (cheap: one --version per
    // backend). No dispatchable agent -> never claim, never orient; drain
    // finished sessions only. Edge-detected so the state change is loud once.
    *avail = available_backends(cfg);
    let avail_ok = !avail.is_empty();
    if avail_ok != *last_avail_ok {
        if !avail_ok {
            let msg = "no dispatchable agents (CLI missing/unrunnable or model unconfigured) — NOT claiming work until one is available; run `bridge doctor`";
            eprintln!("[dispatch] {msg}");
            snap_activity(snap, "error", msg);
        } else {
            eprintln!("[dispatch] agents available — resuming claims");
            snap_activity(snap, "info", "agents available — resuming claims");
        }
        *last_avail_ok = avail_ok;
    }

    // worktree hygiene: every 10 ticks reconcile disk worktrees with task
    // state — done/released tasks must not hold ~/.bridge/worktrees/<slug>
    let n = SWEEP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    if n % 10 == 0 {
        sweep_stale_worktrees(cfg, id, in_flight, &mut msgs);
    }

    // 1. drain finished sessions: finalize each (progress + in_review + cleanup)
    let mut finished: Vec<(InFlight, opencode::RunOutcome)> = Vec::new();
    in_flight.retain_mut(|inf| match inf.rx.try_recv() {
        Ok(outcome) => {
            finished.push((
                InFlight {
                    task_id: inf.task_id.clone(),
                    task_title: inf.task_title.clone(),
                    role_work: inf.role_work,
                    started: inf.started,
                    last_note: inf.last_note.clone(),
                    pr_url: inf.pr_url.clone(),
                    worktree: inf.worktree.clone(),
                    rx: std::sync::mpsc::channel().1,
                    live: inf.live.clone(),
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
                    role_work: inf.role_work,
                    started: inf.started,
                    last_note: inf.last_note.clone(),
                    pr_url: inf.pr_url.clone(),
                    worktree: inf.worktree.clone(),
                    rx: std::sync::mpsc::channel().1,
                    live: inf.live.clone(),
                },
                opencode::RunOutcome {
                    ok: false,
                    exit_code: None,
                    timed_out: false,
                    stdout_tail: String::new(),
                    stderr_tail: "runner thread died (no outcome)".into(),
                    session_id: None,
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
        let exit_txt = match outcome.exit_code {
            Some(0) => "exit 0".to_string(),
            Some(c) => format!("exit {c}"),
            None if outcome.timed_out => "killed on timeout".to_string(),
            None => "no exit (crashed?)".to_string(),
        };
        let mut note = format!(
            "runner: run finished — {}, ~{mins}m — {}",
            exit_txt, tail
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
        // final progress (with 100% on success) is logged AFTER the handoff —
        // a task must never sit in_progress showing 100% because a gate
        // rejected the close. See the handoff match below.
        // hard rule (BR#877): a run that performed no work — non-zero exit,
        // timeout, or a guardrail-void dispatch — can NEVER hand off. Void
        // runs still exit 0, so the exit code alone is not enough.
        let outcome_ok = outcome.ok && !void_run(&outcome.stdout_tail, &outcome.stderr_tail);
        // persist final state (incl. PR link and exit code) before handoff
        write_task_state(
            &inf.task_id,
            &serde_json::json!({
                "task_id": &inf.task_id,
                "task_title": &inf.task_title,
                "status": if outcome_ok { "finished" } else { "failed" },
                "started_ts": now_ms() - inf.started.elapsed().as_millis() as u64,
                "ended_ts": now_ms(),
                "exit_code": outcome.exit_code,
                "pr_url": &pr_url,
                "last_note": &note,
                "stdout_tail": &outcome.stdout_tail,
            }),
        );        if outcome_ok {
            // YIELD check first: the agent may have blocked/bounced/closed the
            // task mid-run (ask filed, yielded per the contract). Query the live
            // status — if the task is no longer in_progress, the agent's state
            // change is authoritative: release the slot, KEEP the worktree and
            // session (they're the resume assets), touch nothing server-side.
            let live_status = mcp_call(cfg, id, "get_artefact", json!({ "id": inf.task_id }))
                .ok()
                .and_then(|v| v.get("status").and_then(|s| s.as_str()).map(String::from));
            if let Some(st) = &live_status {
                if st != "in_progress" {
                    attempts.remove(&inf.task_id);
                    // the task left the runner (agent blocked/bounced/closed it
                    // mid-run) — drop the ephemeral state file too, not just on
                    // handoff; a retained file made finished tasks look in-flight
                    remove_task_state(&inf.task_id);
                    snap_activity(snap, "info", &format!("{} yielded — task now {}, session retained for resume", inf.task_id, st));
                    msgs.push(format!("{} yielded ({}) — released, worktree + session kept", inf.task_title, st));
                    continue;
                }
            }
            // VERIFY/ANALYSIS tasks ARE the review: their completion closes them
            // (done with receipts in the note) — pushing them to in_review would
            // demand a review of a review and loop forever. IMPL tasks hand off
            // to in_review (a Verify child then checks the PR).
            // role tags recorded at claim time are authoritative; the title
            // heuristic remains as fallback for legacy in-flight entries
            let title_lower = inf.task_title.to_lowercase();
            let is_review_work = inf.role_work
                || title_lower.starts_with("verify:") || title_lower.contains("verify ")
                || title_lower.contains("analysis child") || title_lower.contains("review child")
                || title_lower.starts_with("receipt");
            let receipt_note = if pr_url.is_some() {
                note.clone()
            } else {
                format!("{note}\nverified against: task artefact + history receipts (exit 0, session dispatch-{})", slugify(&inf.task_id))
            };
            let (transition_to, handoff_note) = if is_review_work {
                ("done", receipt_note)
            } else {
                ("in_review", note)
            };
            match mcp_call_task(
                cfg,
                id,
                "transition",
                json!({ "id": inf.task_id, "to": transition_to, "note": handoff_note }),
                &inf.task_id,
            ) {
                Ok(_) => {
                    // handoff succeeded — NOW the task may show 100%: the run's
                    // duty is complete (done, or impl complete awaiting verify)
                    let _ = mcp_call_task(
                        cfg,
                        id,
                        "log_progress",
                        json!({
                            "id": inf.task_id,
                            "note": format!("runner: handed off to {} — complete", transition_to),
                            "sentiment": "converging",
                            "completion_pct": 100,
                        }),
                        &inf.task_id,
                    );
                    remove_task_state(&inf.task_id);
                    attempts.remove(&inf.task_id);
                    finished_no_pr.insert(inf.task_id.clone());
                    if transition_to == "done" && inf.worktree.is_some() {
                        // terminal: worktree + branch served their purpose
                        cleanup_worktree(&cfg.workdir, &inf.task_id, true);
                    }
                    msgs.push(format!(
                        "{} → {}{}",
                        inf.task_title,
                        transition_to,
                        pr_url.as_ref().map(|p| format!(" — PR {p}")).unwrap_or_default()
                    ));
                }
                Err(e) => {
                    // gate rejected the handoff (e.g. receipts rejected, no PR).
                    // Do NOT release to todo: a release puts the task straight
                    // back into the claim pool, and the next dispatch hits the
                    // same gate — the 104-attempt churn loop. The gate's verdict
                    // is information: block the task with the rejection as the
                    // reason and the gate's own demand as the exit condition.
                    let block_note = format!(
                        "runner: handoff to {transition_to} rejected — {e}. Run completed (~{mins}m, exit 0); session + worktree retained.",
                    );
                    let unblock = format!("satisfy the rejected gate, then re-claim: {}", truncate(&e, 220));
                    match mcp_call_task(
                        cfg,
                        id,
                        "transition",
                        json!({ "id": inf.task_id, "to": "blocked", "note": block_note, "unblock_condition": unblock }),
                        &inf.task_id,
                    ) {
                        Ok(_) => {
                            snap_activity(snap, "info", &format!("{} blocked after handoff rejection", inf.task_id));
                            msgs.push(format!("{} → blocked (handoff rejected: {}) — gate demand on the card", inf.task_title, truncate(&e, 100)));
                        }
                        Err(e2) => {
                            msgs.push(format!("{} handoff AND block failed: {e2} — manual attention needed", inf.task_title));
                        }
                    }
                    finished_no_pr.insert(inf.task_id.clone());
                    remove_task_state(&inf.task_id);
                }
            }
        } else {
            // failed/timed out — backoff and retry, capped. Retry loops must
            // NOT keep logging progress on the task: every runner note
            // refreshes last_progress.ts and defeats the watchdog (the task
            // then looks alive forever while the session does nothing).
            let n = fail_counts.entry(inf.task_id.clone()).or_insert(0);
            *n += 1;
            let fails = *n;
            if fails >= 3 {
                let void_cause = void_run(&outcome.stdout_tail, &outcome.stderr_tail);
                let note = if void_cause {
                    "runner: dispatch VOID — provider guardrails blocked the model (0 endpoints), no work performed, 3 attempts — handed off for attention (BR#877: void runs never hand off as complete)"
                } else {
                    "runner: opencode failed 3 attempts (last: timed out or exited non-zero) — handed off for attention"
                };
                let _ = mcp_call(
                    cfg,
                    id,
                    "transition",
                    json!({
                        "id": inf.task_id,
                        "to": "blocked",
                        "note": note,
                        "unblock_condition": "fix the failure, then log_progress to re-claim (the runner will re-dispatch)",
                    }),
                );
                gave_up.insert(inf.task_id.clone());
                attempts.remove(&inf.task_id);
                fail_counts.remove(&inf.task_id);
                remove_task_state(&inf.task_id);
                msgs.push(format!("{} failed {}x — blocked for attention (no more runner retries)", inf.task_title, fails));
            } else {
                attempts.insert(inf.task_id.clone(), Instant::now());
                msgs.push(format!("{} failed/timed out — left in_progress (backoff, attempt {}/3)", inf.task_title, fails));
            }
        }
        // PR monitoring v1: record the handoff so the review flow can be tracked;
        // automated verdict reaction (CI fail → bounce + fix) lands with the PR watch loop
        if let Some(pr) = pr_url {
            let _ = mcp_call(
                cfg,
                id,
                "log_progress",
                json!({ "id": inf.task_id, "note": format!("runner: watching PR {pr} — awaiting verify verdict"), "sentiment": "neutral" }),
            );
        }
        // worktree + branch persist through in_review / bounce / failure — they
        // are the handoff assets (session resume or branch checkout). Only a
        // terminal `done` (handled above) tears them down.
        snap_activity(snap, "finish", &msgs.last().cloned().unwrap_or_default());
    }

    // relay, not heartbeat: the AGENT owns progress callbacks. The runner only
    // RELAYS the agent's actual stdout line — real agent output, attributed as
    // a relay — so the board never shows fabricated progress. With human-style
    // reporting (the default), agents narrate milestones in their stdout, so
    // the relay is the liveness signal; when the agent is silent (no output
    // yet, or unchanged since the last poll) the relay stays quiet — a bare
    // "alive Nm" line every poll doubles context re-reads for no information.
    // A liveness fallback only exists in explicit report_minutes mode.
    for inf in in_flight.iter_mut() {
        let live = inf.live_line();
        if live.is_empty() {
            if cfg.report_minutes.is_some() {
                let mins = inf.started.elapsed().as_secs() / 60;
                if let Err(e) = mcp_call(
                    cfg,
                    id,
                    "log_progress",
                    json!({
                        "id": inf.task_id,
                        "note": format!("runner: alive ~{mins}m, no agent output yet"),
                        "sentiment": "neutral",
                    }),
                ) {
                    eprintln!("[dispatch] relay failed for {}: {e}", inf.task_id);
                }
            }
            continue;
        }
        if inf.last_note == live {
            continue; // unchanged since last poll — nothing new to relay
        }
        let note = format!("runner: agent output — {live}");
        if let Err(e) = mcp_call(
            cfg,
            id,
            "log_progress",
            json!({
                "id": inf.task_id,
                "note": note,
                "sentiment": "neutral",
            }),
        ) {
            eprintln!("[dispatch] relay failed for {}: {e}", inf.task_id);
        } else if let Ok(mut s) = snap.lock() {
            if let Some(f) = s.in_flight.iter_mut().find(|f| f.task_id == inf.task_id) {
                f.last_note = live.clone();
            }
        }
    }
    if !in_flight.is_empty() {
        snap_in_flight_list(snap, in_flight);
    }

    // 3. capacity? nothing to schedule if all sessions busy
    if in_flight.len() >= cfg.max_sessions {
        return Ok(msgs);
    }

    // 3b. dispatchability gate: no agents -> do not orient, do not claim
    if !avail_ok {
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
    let sessions = session_map(&cfg.opencode_bin, &cfg.workdir);
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
        if finished_no_pr.contains(tid) || gave_up.contains(tid) {
            continue;
        }
        // backoff: a task that just failed to spawn shouldn't retry every tick
        if gave_up.contains(tid) {
            continue; // handed off for attention — the watchdog owns it now
        }
        if attempts
            .get(tid)
            .map(|a| a.elapsed() < Duration::from_secs(300))
            .unwrap_or(false)
        {
            continue; // silent backoff: runner bookkeeping must not look like agent activity
        }
        let want_title = format!("bridge-{tid}");
        let sess = sessions.get(&want_title).cloned().or_else(|| {
            sessions.iter().find(|(title, _)| title.contains(&want_title)).map(|(_, id)| id.clone())
        });
        let msg = match &sess {
            Some(s) => format!("resumed {tid} — continuing opencode session {s}"),
            None => format!("re-dispatched {tid} — no prior opencode session found, started fresh"),
        };
        let role_work = t.get("tags").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).any(|s| ["role:analysis","role:review","role:impl","role:unblock"].contains(&s))).unwrap_or(false);
        spawn_opencode(cfg, snap, tid, title, "", &policy, sess, role_work, avail, in_flight);
        attempts.insert(tid.to_string(), Instant::now());
        snap_activity(snap, "dispatch", &msg);
        msgs.push(msg);
    }

    // 6. claim new claimable tasks until the WIP limit is reached.
    // BLOCKED tasks with an exit condition rank first: unblocking is priority.
    // A blocked task is resumed by transitioning back to in_progress with the
    // resolution — then dispatched like any other work.
    // RESUME preference: a candidate we hold an opencode session AND worktree
    // for sorts first — resuming that session restores full context cheaply,
    // which is how a task that yielded earlier routes back to "the same agent".
    let candidates = orient
        .get("unclaimed_work")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut candidates: Vec<(serde_json::Value, Option<String>)> = candidates
        .into_iter()
        .map(|t| {
            let tid = t.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let want_title = format!("bridge-{tid}");
            let sess = sessions.get(&want_title).cloned();
            (t, sess)
        })
        .collect();
    candidates.sort_by(|a, b| {
        let ra = if a.1.is_some() { 0 } else { 1 };
        let rb = if b.1.is_some() { 0 } else { 1 };
        ra.cmp(&rb)
    });
    for (task, resume_sess) in candidates {
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
        // not dispatchable at all: question tasks (answered, not claimed),
        // operator gates, bar-gated work — the claim gate would reject or the
        // claim is wrong by definition. Respect the verdict; no churn.
        if task.get("needs_qualification").and_then(|q| q.as_bool()).unwrap_or(false)
            || task.get("is_claimable").and_then(|q| q.as_bool()) == Some(false)
        {
            continue;
        }
        let is_blocked = task.get("status").and_then(|s| s.as_str()) == Some("blocked");
        if is_blocked {
            // resume the blocked task. Preferred context: the unblock condition
            // (the exit condition on record). No exit condition? The blocked
            // REASON is still actionable context — an agent reading the card can
            // decide: clear it, re-scope the task, or escalate to a human. A
            // blocked task is never skipped for missing metadata.
            let unblock = task.get("unblock_condition").and_then(|u| u.as_str()).unwrap_or("");
            let reason = task.get("blocked_reason").and_then(|u| u.as_str()).unwrap_or("");
            let context = if !unblock.is_empty() {
                format!("exit condition: {unblock}")
            } else if !reason.is_empty() {
                format!("blocked with no recorded exit condition — reason: {reason}. Read the card and history, then: clear the block, re-scope the task, or file an ask to escalate")
            } else {
                "blocked with no reason recorded — read the card and history, then: unblock, re-scope, or escalate".to_string()
            };
            if let Err(e) = mcp_call_task(
                cfg,
                id,
                "transition",
                json!({ "id": tid, "to": "in_progress", "note": format!("runner resume — {context}"), "session": format!("dispatch-{}", slugify(tid)) }),
                &tid,
            ) {
                attempts.insert(tid.to_string(), Instant::now());
                snap_activity(snap, "error", &format!("unblock {tid} failed: {e}"));
                continue;
            }
            let msg = format!("unblocked {tid} — {context}");
            snap_activity(snap, "dispatch", &msg);
            msgs.push(msg);
        } else if let Err(e) = mcp_call_task(
            cfg,
            id,
            "transition",
            json!({ "id": tid, "to": "in_progress" }),
            &tid,
        ) {
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
        let _ = mcp_call_task(
            cfg,
            id,
            "log_progress",
            json!({ "id": tid, "note": format!("runner: claimed — dispatching to opencode"), "sentiment": "going_well" }),
            &tid,
        );
        let msg = match &resume_sess {
            Some(s) => format!("claimed {tid} — resuming opencode session {s}"),
            None => format!("claimed {tid} — dispatched to opencode"),
        };
        let role_work = task.get("tags").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).any(|s| ["role:analysis","role:review","role:impl","role:unblock"].contains(&s))).unwrap_or(false);
        spawn_opencode(cfg, snap, tid, &title, &body_md, &policy, resume_sess, role_work, avail, in_flight);
        attempts.insert(tid.to_string(), Instant::now());
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
            Ok(url) => match pair_device(url.trim_end_matches('/')) {
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
    let mut fail_counts: HashMap<String, u32> = HashMap::new();
    let mut finished_no_pr: HashSet<String> = HashSet::new();
    let mut gave_up: HashSet<String> = HashSet::new();
    let mut avail: Vec<opencode::Backend> = Vec::new();
    let mut last_avail_ok = true;
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
            &mut fail_counts,
            &mut finished_no_pr,
            &mut gave_up,
            &snap,
            &mut avail,
            &mut last_avail_ok,
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
    if let Some(pid) = external_runner_pid() {
        // single-claimant rule: two dispatch loops polling one hub race on
        // claims and double-dispatch. Observe the external runner instead.
        return Err(format!("runner already live in another process (pid {pid}) — stop it or kill {pid} first"));
    }
    // remember explicit settings (concurrency, backend, model, hub) across
    // restarts/app runs — the settings page applies by re-starting the loop
    // with an explicit config, so persist it here (pairing-time saves keep
    // working too: resolve() order is env > file).
    if let Some(c) = &cfg {
        if let Err(e) = c.save() {
            eprintln!("[dispatch] config save failed: {e}");
        }
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
