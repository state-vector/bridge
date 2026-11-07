//! Agent transport abstraction — hides backend/protocol specifics behind one
//! trait so the runner never knows whether a task ran over `opencode run`
//! stdio, the ACP JSON-RPC protocol, or kiro chat.
//!
//! Transports:
//! - `OpencodeRun`   — `opencode run` headless (stdio). The long-standing path.
//! - `OpencodeAcp`   — `opencode acp` (ACP over stdio JSON-RPC). Bidirectional:
//!                     the gateway can drive the session and read structured
//!                     updates instead of scraping stdout. Verified working on
//!                     opencode 1.3.10 once desktop-shell env vars are stripped.
//! - `KiroChat`      — `kiro chat --no-interactive` (stream-json).
//!
//! Lane rule (BR#2451, gateway-run mode): the gateway INJECTS the bridge MCP
//! config + token into every spawned session (Mode A provisioning — the
//! runner owns the hub identity for its spawns). Spawned workers may report
//! progress, block with findings, and ask; "no spawning/claiming other work"
//! for workers is enforced hub-side via worker-scoped tokens (pending slice).
//! The caller passes that provisioning as RunRequest.extra_config; both
//! transports apply it via OPENCODE_CONFIG_CONTENT.

use std::io::{BufRead, BufWriter, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProcessIdentity { Linux { group: u32, start_ticks: u64, #[serde(default)] boot_id: String }, Unverifiable { group: u32 } }
impl ProcessIdentity { pub fn group(&self) -> u32 { match self { Self::Linux { group, .. } | Self::Unverifiable { group } => *group } } }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GroupState { Empty, ZombiesOnly, Live, Unobservable }
impl GroupState { pub fn quiescent(self) -> bool { matches!(self, Self::Empty | Self::ZombiesOnly) } }

#[cfg(target_os = "linux")]
fn proc_stat(raw: &str) -> Option<(char, u32, u64)> {
    let fields: Vec<_> = raw.get(raw.rfind(") ")? + 2..)?.split_whitespace().collect();
    Some((fields.first()?.chars().next()?, fields.get(2)?.parse().ok()?, fields.get(19)?.parse().ok()?))
}
pub fn process_identity(group: u32) -> ProcessIdentity {
    #[cfg(target_os = "linux")] {
        if let (Some((_, _, start_ticks)), Ok(boot_id)) = (std::fs::read_to_string(format!("/proc/{group}/stat")).ok().and_then(|raw| proc_stat(&raw)), std::fs::read_to_string("/proc/sys/kernel/random/boot_id")) {
            return ProcessIdentity::Linux { group, start_ticks, boot_id: boot_id.trim().into() };
        }
    }
    ProcessIdentity::Unverifiable { group }
}
pub fn group_state(identity: &ProcessIdentity) -> GroupState {
    let group = identity.group();
    if group <= 1 || group > i32::MAX as u32 { return GroupState::Unobservable; }
    #[cfg(unix)] {
        if unsafe { libc::kill(-(group as i32), 0) } == -1 {
            return if std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) { GroupState::Empty } else { GroupState::Unobservable };
        }
    }
    #[cfg(target_os = "linux")] {
        // Zombies cannot perform I/O or fork. This is a different, explicitly
        // attested proof from an empty group; hidden/denied procfs fails closed.
        let Ok(mounts) = std::fs::read_to_string("/proc/mounts") else { return GroupState::Unobservable; };
        if mounts.lines().any(|line| line.split_whitespace().nth(1) == Some("/proc") && line.contains("hidepid=") && !line.contains("hidepid=0")) { return GroupState::Unobservable; }
        let Ok(entries) = std::fs::read_dir("/proc") else { return GroupState::Unobservable; };
        let mut members = 0;
        for entry in entries {
            let Ok(entry) = entry else { return GroupState::Unobservable; };
            if !entry.file_name().to_string_lossy().bytes().all(|c| c.is_ascii_digit()) { continue; }
            let raw = match std::fs::read_to_string(entry.path().join("stat")) {
                Ok(raw) => raw, Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue, Err(_) => return GroupState::Unobservable,
            };
            let Some((state, process_group, _)) = proc_stat(&raw) else { return GroupState::Unobservable; };
            if process_group == group { members += 1; if !matches!(state, 'Z' | 'X') { return GroupState::Live; } }
        }
        if members > 0 { return GroupState::ZombiesOnly; }
    }
    GroupState::Unobservable
}

/// Recovery may stop only the exact persisted leader identity, never a recycled
/// PID, an unidentifiable group, or an arbitrary process selected by task title.
pub fn stop_recovered(identity: &ProcessIdentity) -> GroupState {
    let state = group_state(identity);
    if state != GroupState::Live { return state; }
    #[cfg(target_os = "linux")] {
        if let ProcessIdentity::Linux { group, start_ticks, boot_id } = identity {
            if !boot_id.is_empty() && matches!(process_identity(*group), ProcessIdentity::Linux { start_ticks: current, boot_id: current_boot, .. } if current == *start_ticks && current_boot == *boot_id) {
                unsafe { libc::kill(-(*group as i32), libc::SIGKILL); }
                return group_state(identity);
            }
        }
    }
    GroupState::Unobservable
}

pub struct RunOutcome {
    pub ok: bool,
    pub stdout_tail: String,
    pub stderr_tail: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub session_id: Option<String>, // for resume (kiro stream / ACP sessionId)
}

#[derive(Default)]
pub struct RunControl {
    pub stop: AtomicBool,
    /// Set only after no process was launched, or the group has no live members.
    pub quiesced: AtomicBool,
    proof: Mutex<Option<GroupState>>,
    lease_deadline: Mutex<Option<Instant>>,
    cancel: Option<Arc<AtomicBool>>,
    process: Mutex<Option<ProcessIdentity>>,
    observer: Option<Arc<dyn Fn(ProcessIdentity) -> Result<(), String> + Send + Sync>>,
    environment: Vec<(String, String)>,
}
impl RunControl {
    pub fn with_cancel(cancel: Option<Arc<AtomicBool>>) -> Self { Self { cancel, ..Self::default() } }
    pub fn with_environment(mut self, environment: Vec<(String, String)>) -> Self { self.environment = environment; self }
    fn apply_environment(&self, command: &mut Command) { command.envs(self.environment.iter().cloned()); }
    pub fn observe_launch(mut self, observer: impl Fn(ProcessIdentity) -> Result<(), String> + Send + Sync + 'static) -> Self { self.observer = Some(Arc::new(observer)); self }
    pub fn identity(&self) -> Option<ProcessIdentity> { self.process.lock().ok().and_then(|p| p.clone()) }
    pub fn writer_state(&self) -> Option<GroupState> { self.proof.lock().ok().and_then(|p| *p) }
    fn stopped(&self, state: GroupState) {
        if let Ok(mut proof) = self.proof.lock() { *proof = Some(state); }
        self.quiesced.store(state.quiescent(), Ordering::SeqCst);
    }
    pub fn lease_valid(&self) -> bool {
        self.lease_deadline.lock().map(|d| d.map(|until| Instant::now() < until).unwrap_or(false)).unwrap_or(false)
    }
    pub fn grant_lease(&self) {
        if let Ok(mut deadline) = self.lease_deadline.lock() { *deadline = Some(Instant::now() + Duration::from_secs(90)); }
    }
    fn should_stop(&self) -> bool {
        // Local monotonic enforcement keeps working while the gateway tick is
        // blocked on a network operation or another task's checkpoint.
        let expired = self.lease_deadline.lock().map(|d| d.map(|until| Instant::now() >= until).unwrap_or(false)).unwrap_or(true);
        if expired { self.stop.store(true, Ordering::SeqCst); }
        self.stop.load(Ordering::SeqCst)
    }
}

/// Everything a transport needs to run one task.
pub struct RunRequest<'a> {
    pub workdir: &'a str,
    pub bin: &'a str,
    pub agent: Option<&'a str>,
    pub model: Option<&'a str>,
    pub prompt: &'a str,
    pub title: Option<&'a str>,
    pub resume: Option<&'a str>,
    /// Extra opencode config (JSON) merged per-key over the host config —
    /// e.g. bridge MCP provisioning. The caller decides the lane.
    pub extra_config: Option<&'a str>,
    pub control: Option<&'a Arc<RunControl>>,
}

/// The abstraction Ray asked for: backends hide their protocol specifics
/// (stdio flags, ACP JSON-RPC, kiro stream-json) behind `dispatch`.
pub trait AgentTransport: Send + Sync {
    fn dispatch(&self, req: &RunRequest, timeout: Duration, live: Option<Arc<Mutex<String>>>) -> RunOutcome;
}

fn tail(s: String, max: usize) -> String {
    let s = s.trim().to_string();
    if s.chars().count() <= max {
        s
    } else {
        let skipped = s.chars().count() - max;
        format!("…{}", s.chars().skip(skipped).collect::<String>())
    }
}

fn head_line(s: &str, max: usize) -> String {
    let mut chars = s.chars();
    let n = chars.by_ref().take(max).count();
    let truncated = n == max && s.chars().nth(max).is_some();
    let out: String = s.chars().take(max).collect();
    if truncated {
        format!("{out}…")
    } else {
        out
    }
}

/// Environment sanitization shared by every transport: desktop-client vars
/// make child processes resolve against the desktop's state dir (no auth
/// there) — the "Unauthorized"/"Session not found" failure class. Stripping
/// them is what makes `opencode acp session/new` work at all.
fn sanitized(cmd: &mut Command) {
    cmd.env_remove("OPENCODE_CLIENT")
        .env_remove("XDG_STATE_HOME")
        .env_remove("OPENCODE_SERVER_USERNAME")
        .env_remove("OPENCODE_SERVER_PASSWORD");
    // Caller-supplied extra config (bridge MCP provisioning etc.) merges
    // per-key over the host config inside opencode. No env here — the lane
    // (worker with runner-owned MCP vs leader) is the caller's decision.
}

/// Shared kill/wait helper: poll for exit up to `timeout`, then kill.
fn process_group(cmd: &mut Command) {
    #[cfg(unix)] {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
}

fn spawn_agent(cmd: &mut Command, control: Option<&Arc<RunControl>>) -> std::io::Result<Child> {
    if let Some(control) = control { control.apply_environment(cmd); }
    if let Some(control) = control {
        if control.cancel.as_ref().is_some_and(|cancel| cancel.load(Ordering::SeqCst)) || control.should_stop() {
            control.stopped(GroupState::Empty); // no process was created
            return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "preparation cancelled before process creation"));
        }
    }
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => { if let Some(control) = control { control.stopped(GroupState::Empty); } return Err(error); },
    };
    if let Some(control) = control {
        let identity = process_identity(child.id());
        if let Ok(mut process) = control.process.lock() { *process = Some(identity.clone()); }
        if let Some(observer) = &control.observer {
            if let Err(error) = observer(identity) {
                kill_group(&mut child, Some(control));
                return Err(std::io::Error::other(format!("launched process ownership could not be journaled; writer stopped: {error}")));
            }
        }
    }
    Ok(child)
}

#[test]
fn all_agent_transports_apply_the_owned_disk_environment_at_the_spawn_boundary() {
    let control = Arc::new(RunControl::default().with_environment(vec![("TMPDIR".into(), "/owned/task/tmp".into()), ("CARGO_TARGET_DIR".into(), "/owned/task/cache/cargo".into())]));
    control.grant_lease();
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "printf '%s' \"$TMPDIR|$CARGO_TARGET_DIR\""]).stdout(Stdio::piped());
    let child = spawn_agent(&mut command, Some(&control)).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stdout).unwrap(), "/owned/task/tmp|/owned/task/cache/cargo");
}

fn kill_group(child: &mut Child, control: Option<&Arc<RunControl>>) {
    #[cfg(unix)] {
        let group = -(child.id() as i32);
        // SAFETY: the child was spawned into its own process group. Negative
        // pid targets that group, never the gateway's group or a positive pid.
        unsafe { libc::kill(group, libc::SIGKILL); }
        let _ = child.wait();
        // Reap before observing; never infer quiescence from child exit alone.
        let mut state = GroupState::Unobservable;
        for _ in 0..20 {
            // EPERM/other probe failures are NOT evidence of an empty group.
            state = group_state(&ProcessIdentity::Unverifiable { group: child.id() });
            if state.quiescent() { break; }
            std::thread::sleep(Duration::from_millis(50));
        }
        if let Some(c) = control { c.stopped(state); }
    }
    #[cfg(not(unix))] {
        let _ = child.kill();
        let _ = child.wait();
        // No proven process-tree boundary on this platform: retain affinity.
        let _ = control;
    }
}

fn wait_or_kill(child: &mut Child, timeout: Duration, control: Option<&Arc<RunControl>>) -> (Option<std::process::ExitStatus>, bool) {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(st)) => { kill_group(child, control); return (Some(st), false); },
            Ok(None) => {
                if Instant::now() >= deadline || control.map(|c| c.should_stop()).unwrap_or(false) {
                    kill_group(child, control);
                    return (child.wait().ok(), true);
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            Err(_) => { kill_group(child, control); return (None, false); },
        }
    }
}

// ---------------------------------------------------------------------------
// opencode run (stdio) — the long-standing transport
// ---------------------------------------------------------------------------

pub struct OpencodeRun;

#[cfg(test)]
#[test]
fn local_monotonic_lease_fences_a_writer_while_gateway_tick_is_stalled() {
    let control = RunControl::default();
    control.grant_lease();
    assert!(!control.should_stop());
    *control.lease_deadline.lock().unwrap() = Some(Instant::now() - Duration::from_secs(1));
    assert!(control.should_stop());
    assert!(control.stop.load(Ordering::SeqCst));
}

#[cfg(all(test, unix))]
#[test]
fn cancellation_stops_descendant_writers_before_acknowledging_quiescence() {
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("bridge-process-test-{nonce}"));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("run"), "sleep 30 &\nwait\n").unwrap();
    let control = Arc::new(RunControl::default());
    let stop = control.clone();
    let started = Instant::now();
    let dir2 = dir.clone();
    let handle = std::thread::spawn(move || {
        OpencodeRun.dispatch(&RunRequest { workdir: dir2.to_str().unwrap(), bin: "/bin/sh", agent: None, model: None, prompt: "", title: None, resume: None, extra_config: None, control: Some(&control) }, Duration::from_secs(30), None)
    });
    std::thread::sleep(Duration::from_millis(200));
    stop.stop.store(true, Ordering::SeqCst);
    let out = handle.join().unwrap();
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(!out.ok);
    assert!(stop.quiesced.load(Ordering::SeqCst));
    let _ = std::fs::remove_dir_all(dir);
}

impl AgentTransport for OpencodeRun {
    fn dispatch(&self, req: &RunRequest, timeout: Duration, live: Option<Arc<Mutex<String>>>) -> RunOutcome {
        let mut cmd = Command::new(req.bin);
        cmd.arg("run")
            .current_dir(req.workdir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        sanitized(&mut cmd);
        process_group(&mut cmd);
        if let Some(cfg_json) = req.extra_config { cmd.env("OPENCODE_CONFIG_CONTENT", cfg_json); }
        if let Some(model) = req.model {
            cmd.arg("--model").arg(model);
        }
        if let Some(agent) = req.agent {
            cmd.arg("--agent").arg(agent);
        }
        if let Some(title) = req.title {
            cmd.arg("--title").arg(title);
        }
        if let Some(session) = req.resume {
            cmd.arg("--session").arg(session);
        }
        cmd.arg(req.prompt);

        let mut child = match spawn_agent(&mut cmd, req.control) {
            Ok(c) => c,
            Err(e) => {
                return RunOutcome {
                    ok: false,
                    stdout_tail: String::new(),
                    stderr_tail: format!("spawn failed: {e}"),
                    exit_code: None,
                    timed_out: false,
                    session_id: None,
                };
            }
        };

        let label = req.title.map(|s| s.to_string()).unwrap_or_else(|| "opencode".into());
        let stdout = child.stdout.take().map(|mut p| {
            std::thread::spawn(move || {
                let mut bytes = Vec::new();
                let mut chunk = [0u8; 8192];
                let mut first = true;
                let mut shown = 0usize;
                loop {
                    match p.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            if first {
                                first = false;
                                crate::logging::emit(
                                    "dispatch",
                                    &label,
                                    "picked up — agent responding",
                                );
                            }
                            bytes.extend_from_slice(&chunk[..n]);
                            while let Some(nl) = bytes[shown..].iter().position(|&b| b == b'\n') {
                                let end = shown + nl;
                                let line = String::from_utf8_lossy(&bytes[shown..end]).trim().to_string();
                                if !line.is_empty() {
                                    crate::logging::emit(
                                        "dispatch",
                                        &label,
                                        &head_line(&line, 240),
                                    );
                                    if let Some(cell) = &live {
                                        if let Ok(mut slot) = cell.lock() {
                                            *slot = head_line(&line, 200);
                                        }
                                    }
                                }
                                shown = end + 1;
                            }
                        }
                        Err(_) => break,
                    }
                }
                String::from_utf8_lossy(&bytes).into_owned()
            })
        });
        let stderr = child.stderr.take().map(|mut p| {
            std::thread::spawn(move || {
                let mut bytes = Vec::new();
                let mut chunk = [0u8; 8192];
                loop {
                    match p.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => bytes.extend_from_slice(&chunk[..n]),
                        Err(_) => break,
                    }
                }
                String::from_utf8_lossy(&bytes).into_owned()
            })
        });

        let (status, timed_out) = wait_or_kill(&mut child, timeout, req.control);
        let drain = |h: Option<std::thread::JoinHandle<String>>| h.and_then(|h| h.join().ok()).unwrap_or_default();
        let stdout_tail = tail(drain(stdout), 4000);
        let stderr_tail = tail(drain(stderr), 2000);

        RunOutcome {
            ok: status.map(|s| s.success()).unwrap_or(false) && !timed_out,
            stdout_tail,
            stderr_tail,
            exit_code: status.and_then(|s| s.code()),
            timed_out,
            session_id: None,
        }
    }
}

// ---------------------------------------------------------------------------
// opencode acp — JSON-RPC over stdio (bidirectional-capable)
// ---------------------------------------------------------------------------

pub struct OpencodeAcp;

const ACP_UNAVAILABLE: &str = "ACP_UNAVAILABLE:";
/// A session that produces no output for this long is hung — model thinking
/// gaps run tens of seconds, never minutes. Applies BEFORE the task budget
/// (a hung spawner fails in minutes, not 30) and as the grace AFTER it: a
/// session still producing output past its budget gets one stall window to
/// finish, then is cut. The old post-budget cliff (1s) killed healthy
/// chattering sessions mid-work and read as "acp timed out" with the agent
/// actually fine (fleet incident 2026-10-22: three green implementations
/// declared timed out; circuit breaker tripped on false failures).
const ACP_STALL: Duration = Duration::from_secs(300);

impl AgentTransport for OpencodeAcp {
    fn dispatch(&self, req: &RunRequest, timeout: Duration, live: Option<Arc<Mutex<String>>>) -> RunOutcome {
        let mut cmd = Command::new(req.bin);
        cmd.arg("acp")
            .current_dir(req.workdir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        sanitized(&mut cmd);
        process_group(&mut cmd);
        if let Some(cfg_json) = req.extra_config {
            cmd.env("OPENCODE_CONFIG_CONTENT", cfg_json);
        }

        let mut child = match spawn_agent(&mut cmd, req.control) {
            Ok(c) => c,
            Err(e) => {
                return RunOutcome {
                    ok: false,
                    stdout_tail: String::new(),
                    stderr_tail: format!("{ACP_UNAVAILABLE} spawn failed: {e}"),
                    exit_code: None,
                    timed_out: false,
                    session_id: None,
                };
            }
        };

        // writer owns stdin; reader thread forwards every stdout line through a
        // channel (responses AND session/update notifications interleave here).
        let stdin_handle = child.stdin.take().expect("stdin piped");
        let mut stdin = BufWriter::new(stdin_handle);
        let stdout = child.stdout.take().expect("stdout piped");
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let reader = std::thread::spawn(move || {
            let r = std::io::BufReader::new(stdout);
            for line in r.lines() {
                match line {
                    Ok(l) => {
                        if tx.send(l).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let mut next_id: i64 = 1;
        let deadline = Instant::now() + timeout;

        // Send a request, then read lines until its response arrives.
        // Non-matching lines (session/update notifications) go to `on_line`.
        // Returns Err on timeout/dead child.
        let call = |stdin: &mut BufWriter<std::process::ChildStdin>,
                        id: i64,
                        method: &str,
                        params: serde_json::Value,
                        rx: &std::sync::mpsc::Receiver<String>,
                        on_line: &mut dyn FnMut(&str),
                        deadline: Instant|
         -> Result<serde_json::Value, String> {
            let frame = serde_json::json!({
                "jsonrpc": "2.0", "id": id, "method": method, "params": params
            });
            stdin
                .write_all(serde_json::to_string(&frame).unwrap_or_default().as_bytes())
                .and_then(|_| stdin.write_all(b"\n"))
                .and_then(|_| stdin.flush())
                .map_err(|e| format!("acp stdin write failed: {e}"))?;
            let mut last_line = Instant::now();
            loop {
                if req.control.map(|c| c.should_stop()).unwrap_or(false) {
                    return Err("acp interrupted — checkpoint and resume".into());
                }
                // wait until whichever comes first: the stall window closing
                // (no output for 5m — hung) or the hard ceiling (budget +
                // one stall window of post-budget grace for live sessions)
                let now = Instant::now();
                let stall_end = if req.control.is_some() { deadline } else { last_line + ACP_STALL };
                let hard_end = if req.control.is_some() { deadline } else { deadline + ACP_STALL };
                let left = hard_end
                    .checked_duration_since(now)
                    .unwrap_or(Duration::ZERO)
                    .min(stall_end.checked_duration_since(now).unwrap_or(Duration::ZERO));
                let line = match rx.recv_timeout(left.min(Duration::from_millis(500))) {
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) if left > Duration::from_millis(500) => continue,
                    result => result.map_err(|_| {
                    if now >= stall_end {
                        "acp timed out — stalled: no output for 5m".to_string()
                    } else {
                        "acp timed out (budget + grace exhausted)".to_string()
                    }
                    })?,
                };
                last_line = Instant::now();
                on_line(&line);
                let v: serde_json::Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if v.get("id").and_then(|i| i.as_i64()) == Some(id) {
                    if let Some(err) = v.get("error") {
                        let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown");
                        let data = err.get("data").and_then(|d| d.as_str()).unwrap_or("");
                        return Err(format!("acp {method} failed: {msg} {data}"));
                    }
                    return Ok(v.get("result").cloned().unwrap_or(serde_json::Value::Null));
                }
            }
        };

        // 1. initialize
        let session_line = String::new();
        let frames = std::cell::Cell::new(0usize);
        let mut on_update = |line: &str| {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if v.get("method").and_then(|m| m.as_str()) == Some("session/update") {
                    frames.set(frames.get() + 1);
                    if let Some(cell) = &live {
                        if let Ok(mut slot) = cell.lock() {
                            let text = extract_update_text(&v)
                                .unwrap_or_else(|| format!("[acp {}]", update_kind(&v)));
                            *slot = format!("#{} {}", frames.get(), head_line(&text, 200));
                        }
                    }
                }
            }
        };
        let init = match call(
            &mut stdin,
            next_id,
            "initialize",
            serde_json::json!({
                "protocolVersion": 1,
                "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false } }
            }),
            &rx,
            &mut on_update,
            deadline,
        ) {
            Ok(v) => v,
            Err(e) => return acp_fail(child, format!("{ACP_UNAVAILABLE} {e}")),
        };
        let _ = init;
        next_id += 1;

        // 2. session/new
        let session = match call(
            &mut stdin,
            next_id,
            "session/new",
            serde_json::json!({ "cwd": req.workdir, "mcpServers": [] }), // MCP rides via merged config
            &rx,
            &mut on_update,
            deadline,
        ) {
            Ok(v) => v,
            Err(e) => return acp_fail(child, format!("{ACP_UNAVAILABLE} {e}")),
        };
        next_id += 1;
        let session_id = session
            .get("sessionId")
            .and_then(|s| s.as_str())
            .map(String::from);
        let _ = &session_line;

        // 3. session/prompt — the actual work. Resume = loadSession + prompt
        // (ACP sessions persist server-side; session/new is skipped on resume).
        let mut accumulated = String::new();
        let mut on_prompt = |line: &str| {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if v.get("method").and_then(|m| m.as_str()) == Some("session/update") {
                    frames.set(frames.get() + 1);
                    let shown = extract_update_text(&v);
                    if let Some(text) = &shown {
                        accumulated.push_str(text);
                        accumulated.push('\n');
                    }
                    // every frame moves the live cell — text or not. Liveness
                    // vouches and the operator console must not depend on the
                    // frame carrying extractable text (hermes incident: a
                    // shape we didn't match read as a dead session).
                    if let Some(cell) = &live {
                        if let Ok(mut slot) = cell.lock() {
                            let shown = shown.unwrap_or_else(|| format!("[acp {}]", update_kind(&v)));
                            *slot = format!("#{} {}", frames.get(), head_line(&shown, 200));
                        }
                    }
                }
            }
        };
        // resume: ACP loadSession is advertised but 1.3.10 resume-after-error
        // loops — a fresh session per dispatch is the honest behavior; keep
        // resume absent until upstream proves loadSession stable.
        let prompt_params = serde_json::json!({
            "sessionId": session_id.clone().unwrap_or_default(),
            "prompt": [ { "type": "text", "text": req.prompt } ],
            "cwd": req.workdir,
        });
        let prompt_res = call(
            &mut stdin,
            next_id,
            "session/prompt",
            prompt_params,
            &rx,
            &mut on_prompt,
            deadline,
        );

        // prompt returned (turn complete) — close stdin so the agent exits
        let _ = stdin.flush();
        drop(stdin);
        if prompt_res.is_err() { kill_group(&mut child, req.control); }
        let (status, timed_out) = wait_or_kill(&mut child, Duration::from_secs(30), req.control);
        let _ = reader.join();

        match prompt_res {
            Ok(v) => {
                let stop = v
                    .get("stopReason")
                    .and_then(|s| s.as_str())
                    .unwrap_or("end_turn")
                    .to_string();
                RunOutcome {
                    ok: !timed_out && stop != "refusal" && stop != "cancelled",
                    stdout_tail: tail(accumulated, 4000),
                    stderr_tail: String::new(),
                    exit_code: status.and_then(|s| s.code()).or(Some(0)),
                    timed_out,
                    session_id,
                }
            }
            Err(e) if e.contains("timed out") => RunOutcome {
                ok: false,
                stdout_tail: tail(accumulated, 4000),
                stderr_tail: e,
                exit_code: None,
                timed_out: true,
                session_id,
            },
            Err(e) => RunOutcome {
                ok: false,
                stdout_tail: tail(accumulated, 4000),
                stderr_tail: e,
                exit_code: status.and_then(|s| s.code()),
                timed_out,
                session_id,
            },
        }
    }
}

fn acp_fail(mut child: Child, msg: String) -> RunOutcome {
    kill_group(&mut child, None);
    RunOutcome {
        ok: false,
        stdout_tail: String::new(),
        // ACP_UNAVAILABLE marks transport-level failure: the caller falls back
        // to the stdio transport for this dispatch (migration safety net).
        stderr_tail: msg,
        exit_code: None,
        timed_out: false,
        session_id: None,
    }
}

/// Pull the human-readable text out of a session/update notification.
fn extract_update_text(v: &serde_json::Value) -> Option<String> {
    let u = update_payload(v)?;
    let kind = u.get("sessionUpdate").and_then(|k| k.as_str())?;
    // content is a text block ({type:"text",text:...}) or an ARRAY of blocks
    // depending on the opencode version — accept both. ALL text blocks in a
    // frame are joined (BR#3352: a multi-block frame used to silently drop
    // every block after the first). A version whose frames don't match here
    // used to go completely dark to the runner: no live line, no
    // session_alive vouches, watchdog releasing working sessions as "stalled"
    // (fleet incident 2026-10-22, hermes) — and the same class of miss emptied
    // the runner's result payload while the side effects landed (BR#3352:
    // "ran, report lost").
    let text_of = |c: &serde_json::Value| -> Option<String> {
        if let Some(t) = c.get("text").and_then(|t| t.as_str()) {
            return Some(t.to_string());
        }
        if let Some(blocks) = c.as_array() {
            let mut joined = String::new();
            for b in blocks {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                        joined.push_str(t);
                    }
                }
            }
            if !joined.is_empty() {
                return Some(joined);
            }
        }
        // nested/renamed text shapes ({text:{...}}, {content:{message:…}}):
        // scan the obvious message keys instead of dropping the frame
        deep_text(c)
    };
    match kind {
        "agent_message_chunk" | "agent_thought_chunk" => {
            u.get("content").and_then(text_of).or_else(|| u.get("message").and_then(deep_text))
        }
        "tool_call" | "tool_call_update" => {
            let title = u.get("title").and_then(|t| t.as_str()).unwrap_or("tool");
            Some(format!("[tool] {title}"))
        }
        // unknown kinds: an unmatched shape used to return None here — the
        // agent's reply never reached the runner's result payload while its
        // side effects (worktree, PRs) landed. Accept top-level message/text
        // payloads on unknown frames; shapes without them still stay None
        // (plan/mode frames are not results).
        _ => u.get("message").and_then(deep_text).or_else(|| u.get("text").and_then(deep_text)),
    }
}

/// Generic last-resort text extraction for unmatched shapes (BR#3352: the
/// empty-result class). Strings under the obvious message keys only — a deep
/// scan would drag tool inputs into the result payload.
fn deep_text(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) => {
            let t = s.trim();
            if t.is_empty() { None } else { Some(t.to_string()) }
        }
        serde_json::Value::Array(a) => a.iter().find_map(deep_text),
        serde_json::Value::Object(o) => o
            .iter()
            .filter(|(k, _)| matches!(k.as_str(), "text" | "message" | "content"))
            .find_map(|(_, v)| deep_text(v)),
        _ => None,
    }
}

/// The ACP update kind, for when text extraction fails — any session/update
/// frame still proves the session is alive and should surface as such.
fn update_kind(v: &serde_json::Value) -> String {
    update_payload(v)
        .and_then(|u| u.get("sessionUpdate").and_then(|k| k.as_str()))
        .unwrap_or("update")
        .to_string()
}

/// The update object of a session/update frame. JSON-RPC notifications carry
/// it under `params` (ACP spec: params = { sessionId, update }); opencode 1.x
/// flattened it to a top-level `update` — accept both. Reading only one shape
/// is what blinded the runner on hermes (v2.1.2, spec shape) while the same
/// parser worked on other hosts.
fn update_payload(v: &serde_json::Value) -> Option<&serde_json::Value> {
    v.pointer("/params/update").or_else(|| v.get("update"))
}

// ---------------------------------------------------------------------------
// kiro chat — stream-json
// ---------------------------------------------------------------------------

pub struct KiroChat;

impl AgentTransport for KiroChat {
    fn dispatch(&self, req: &RunRequest, timeout: Duration, _live: Option<Arc<Mutex<String>>>) -> RunOutcome {
        let mut cmd = Command::new(req.bin);
        cmd.arg("chat")
            .arg("--no-interactive")
            .arg("--trust-all-tools")
            .current_dir(req.workdir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(model) = req.model {
            cmd.arg("--model").arg(model);
        }
        if let Some(agent) = req.agent {
            cmd.arg("--agent").arg(agent);
        }
        if let Some(session) = req.resume {
            cmd.arg("--resume-id").arg(session);
        }
        cmd.arg(req.prompt);

        process_group(&mut cmd);

        let mut child = match spawn_agent(&mut cmd, req.control) {
            Ok(c) => c,
            Err(e) => {
                return RunOutcome {
                    ok: false,
                    stdout_tail: String::new(),
                    stderr_tail: format!("spawn failed: {e}"),
                    exit_code: None,
                    timed_out: false,
                    session_id: None,
                };
            }
        };
        let stdout = child.stdout.take().map(|mut p| {
            std::thread::spawn(move || {
                let mut bytes = Vec::new();
                let mut chunk = [0u8; 8192];
                loop {
                    match p.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => bytes.extend_from_slice(&chunk[..n]),
                        Err(_) => break,
                    }
                }
                String::from_utf8_lossy(&bytes).into_owned()
            })
        });
        let (status, timed_out) = wait_or_kill(&mut child, timeout, req.control);
        let stdout_full = stdout.and_then(|h| h.join().ok()).unwrap_or_default();
        let session_id = find_session_id(&stdout_full);
        RunOutcome {
            ok: status.map(|s| s.success()).unwrap_or(false) && !timed_out,
            stdout_tail: tail(stdout_full, 4000),
            stderr_tail: String::new(),
            exit_code: status.and_then(|s| s.code()),
            timed_out,
            session_id,
        }
    }
}

fn find_session_id(stdout: &str) -> Option<String> {
    for key in ["\"session_id\"", "\"sessionId\""] {
        if let Some(idx) = stdout.find(key) {
            let rest = &stdout[idx + key.len()..];
            if let Some(cstart) = rest.find('"') {
                let after = &rest[cstart + 1..];
                if let Some(cend) = after.find('"') {
                    let id = &after[..cend];
                    if !id.is_empty() {
                        return Some(id.to_string());
                    }
                }
            }
        }
    }
    None
}

/// Transport selection: opencode defaults to ACP (bidirectional-capable) with
/// automatic stdio fallback when the ACP transport reports unavailable; kiro
/// stays on its stream-json chat.
pub fn transport_for(backend: crate::opencode::Backend, mode: Option<&str>) -> Box<dyn AgentTransport> {
    let want_acp = match mode {
        Some("acp") => true,
        Some("stdio") => false,
        _ => backend == crate::opencode::Backend::OpenCode,
    };
    if want_acp && backend == crate::opencode::Backend::OpenCode {
        Box::new(OpencodeAcp)
    } else if backend == crate::opencode::Backend::Kiro {
        Box::new(KiroChat)
    } else {
        Box::new(OpencodeRun)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The hermes incident (2026-10-22): a frame shape the extractor didn't
    // match read as a DEAD session — no live line, no session_alive vouches,
    // watchdog released working tasks, reply tail was bare "acp timed out".
    // Every ACP serialization we know of must yield text or a kind fallback,
    // and liveness itself must never depend on this matching (b02c237b9).

    #[test]
    fn message_chunk_content_as_object() {
        let v = serde_json::json!({
            "method": "session/update",
            "update": { "sessionUpdate": "agent_message_chunk",
                        "content": { "type": "text", "text": "hello" } }
        });
        assert_eq!(extract_update_text(&v).as_deref(), Some("hello"));
        assert_eq!(update_kind(&v), "agent_message_chunk");
    }

    #[test]
    fn message_chunk_content_as_array() {
        let v = serde_json::json!({
            "method": "session/update",
            "update": { "sessionUpdate": "agent_message_chunk",
                        "content": [ { "type": "text", "text": "block text" } ] }
        });
        assert_eq!(extract_update_text(&v).as_deref(), Some("block text"));
    }

    #[test]
    fn tool_call_and_update_kinds() {
        let call = serde_json::json!({
            "method": "session/update",
            "update": { "sessionUpdate": "tool_call", "title": "bash" }
        });
        assert_eq!(extract_update_text(&call).as_deref(), Some("[tool] bash"));
        let upd = serde_json::json!({
            "method": "session/update",
            "update": { "sessionUpdate": "tool_call_update", "title": "bash" }
        });
        assert_eq!(extract_update_text(&upd).as_deref(), Some("[tool] bash"));
    }

    #[test]
    fn unmatched_shape_still_names_the_kind() {
        let v = serde_json::json!({
            "method": "session/update",
            "update": { "sessionUpdate": "plan_update" }
        });
        assert_eq!(extract_update_text(&v), None);
        assert_eq!(update_kind(&v), "plan_update");
    }

    // BR#3352 — the empty-result class: an unmatched frame shape silently
    // dropped the agent's reply from the runner's result payload while the
    // side effects (worktree, PRs) landed. Unknown message shapes must reach
    // the payload; plan/mode frames without message text must not.

    #[test]
    fn br3352_multi_block_array_content_joins_every_block() {
        let v = serde_json::json!({
            "method": "session/update",
            "update": { "sessionUpdate": "agent_message_chunk",
                        "content": [ { "type": "text", "text": "first " },
                                     { "type": "text", "text": "second" } ] }
        });
        assert_eq!(extract_update_text(&v).as_deref(), Some("first second"));
    }

    #[test]
    fn br3352_unknown_kind_with_message_payload_extracts() {
        let v = serde_json::json!({
            "method": "session/update",
            "update": { "sessionUpdate": "agent_message",
                        "message": "final reply body" }
        });
        assert_eq!(extract_update_text(&v).as_deref(), Some("final reply body"));
    }

    #[test]
    fn br3352_renamed_plain_text_field_is_reachable_genuinely_unknown_stays_kind_fallback() {
        // a renamed but plain string field under content IS reachable via the
        // deep scan…
        let reachable = serde_json::json!({
            "method": "session/update",
            "update": { "sessionUpdate": "agent_message_chunk",
                        "content": { "message": "renamed but plain" } }
        });
        assert_eq!(extract_update_text(&reachable).as_deref(), Some("renamed but plain"));
        // …while a shape with no message-string anywhere stays None — the
        // live-line kind fallback covers liveness, never the result payload.
        let unknown = serde_json::json!({
            "method": "session/update",
            "update": { "sessionUpdate": "agent_message_chunk",
                        "content": { "type": "text", "text": { "value": "nested" } } }
        });
        assert_eq!(extract_update_text(&unknown), None);
        assert_eq!(update_kind(&unknown), "agent_message_chunk");
    }

    #[test]
    fn br3352_tool_input_never_leaks_into_the_result_payload() {
        let v = serde_json::json!({
            "method": "session/update",
            "update": { "sessionUpdate": "tool_call", "title": "bash",
                        "rawInput": { "command": "rm -rf /" } }
        });
        assert_eq!(extract_update_text(&v).as_deref(), Some("[tool] bash"));
    }
}
#[cfg(test)]
mod spec_shape_tests {
    use super::*;

    // opencode 2.1.2 on hermes emits the ACP-spec shape: the update object
    // rides under `params` — the parser read only a top-level `update`, so
    // every frame parsed as None (bare "acp update" kind, empty reply tails)
    // while the session worked. Both shapes must extract.

    #[test]
    fn spec_shape_params_nested() {
        let v = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": { "sessionId": "sess_1",
                        "update": { "sessionUpdate": "agent_message_chunk",
                                    "content": { "type": "text", "text": "spec text" } } }
        });
        assert_eq!(extract_update_text(&v).as_deref(), Some("spec text"));
        assert_eq!(update_kind(&v), "agent_message_chunk");
    }

    #[test]
    fn spec_shape_params_nested_array_content() {
        let v = serde_json::json!({
            "method": "session/update",
            "params": { "update": { "sessionUpdate": "tool_call", "title": "edit" } }
        });
        assert_eq!(extract_update_text(&v).as_deref(), Some("[tool] edit"));
    }

    #[test]
    fn flattened_shape_still_works() {
        let v = serde_json::json!({
            "method": "session/update",
            "update": { "sessionUpdate": "agent_message_chunk",
                        "content": { "type": "text", "text": "flat" } }
        });
        assert_eq!(extract_update_text(&v).as_deref(), Some("flat"));
    }
}
