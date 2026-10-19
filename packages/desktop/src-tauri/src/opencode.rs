//! opencode subprocess runner — spawns headless opencode runs and captures output.
//!
//! Headless invocation: `opencode run "<prompt>"` (optionally `--agent <name>`).
//! `opencode run` is already non-interactive — there is no `--auto` flag.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub struct RunOutcome {
    pub ok: bool,
    pub stdout_tail: String,
    pub stderr_tail: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub session_id: Option<String>, // kiro: captured from stream-json for resume
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

/// Run opencode headlessly against `workdir`. Blocks until exit or timeout.
/// stdout/stderr are drained on reader threads so big sessions can't deadlock
/// on full pipes. `title` tags the opencode session (`bridge-<task_id>`) so the
/// runner can rediscover it for resume; `resume` continues a prior session.
/// `live` (when given) receives the agent's most recent output line — the
/// runner heartbeats it to the bridge so the board shows mid-run activity.
/// Agent backends the runner can drive.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Backend {
    OpenCode,
    Kiro,
}

impl Backend {
    pub fn parse(s: Option<&str>) -> Self {
        match s.map(|v| v.to_ascii_lowercase()) {
            Some(ref v) if v == "kiro" => Backend::Kiro,
            _ => Backend::OpenCode,
        }
    }
}

/// Run the agent headlessly against `workdir`. Blocks until exit or timeout.
/// stdout/stderr are drained on reader threads so big sessions can't deadlock
/// on full pipes. `title` tags the opencode session (`bridge-<task_id>`) so the
/// runner can rediscover it for resume; `resume` continues a prior session.
/// `live` (when given) receives the agent's most recent output line — the
/// runner heartbeats it to the bridge so the board shows mid-run activity.
pub fn run_task(
    workdir: &str,
    bin: &str,
    backend: Backend,
    agent: Option<&str>,
    model: Option<&str>,
    prompt: &str,
    timeout: Duration,
    title: Option<&str>,
    resume: Option<&str>,
    live: Option<Arc<Mutex<String>>>,
) -> RunOutcome {
    let mut cmd = Command::new(bin);
    cmd.arg("run")
        .current_dir(workdir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Sanitize the inherited environment: desktop-client variables (e.g.
    // OPENCODE_CLIENT, XDG_STATE_HOME pointing at ai.opencode.desktop) make the
    // headless CLI resolve against the desktop's state and fail with
    // "Session not found" before any work is done. Strip them for the child.
    cmd.env_remove("OPENCODE_CLIENT")
        .env_remove("XDG_STATE_HOME")
        .env_remove("OPENCODE_SERVER_USERNAME")
        .env_remove("OPENCODE_SERVER_PASSWORD");
    match backend {
        Backend::OpenCode => {
            cmd.arg("run");
            // model override: unset delegates to opencode's own config (its
            // `model` key). Explicit override matters for RESUMED sessions —
            // opencode pins the session's original model, so a small model
            // 400s the moment history exceeds its window.
            if let Some(model) = model {
                cmd.arg("--model").arg(model);
            }
            if let Some(agent) = agent {
                cmd.arg("--agent").arg(agent);
            }
            if let Some(title) = title {
                cmd.arg("--title").arg(title);
            }
            if let Some(session) = resume {
                cmd.arg("--session").arg(session);
            }
            cmd.arg(prompt);
        }
        Backend::Kiro => {
            cmd.arg("chat").arg("--no-interactive").arg("--trust-all-tools");
            if let Some(model) = model {
                cmd.arg("--model").arg(model);
            }
            if let Some(agent) = agent {
                cmd.arg("--agent").arg(agent);
            }
            if let Some(session) = resume {
                cmd.arg("--resume-id").arg(session);
            }
            cmd.arg(prompt);
        }
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[dispatch] agent spawn failed: {e}");
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

    // reader threads accumulate raw bytes (chunk boundaries can split UTF-8);
    // the stdout reader logs pickup confirmation on the agent's first output
    let label = title
        .map(|s| s.to_string())
        .unwrap_or_else(|| "opencode".into());
    let stdout = child.stdout.take().map(|mut p| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let mut chunk = [0u8; 8192];
            let mut first = true;
            let mut shown = 0usize; // bytes already printed as complete lines
            loop {
                match p.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => {
                        if first {
                            first = false;
                            eprintln!("[dispatch] {label} picked up — agent responding");
                        }
                        bytes.extend_from_slice(&chunk[..n]);
                        // Stream complete lines as they arrive so the local
                        // console shows live agent activity mid-run, not just
                        // the truncated tail at exit.
                        while let Some(nl) = bytes[shown..].iter().position(|&b| b == b'\n') {
                            let end = shown + nl;
                            let line = String::from_utf8_lossy(&bytes[shown..end]).trim().to_string();
                            if !line.is_empty() {
                                eprintln!("[dispatch] {label} | {}", head_line(&line, 240));
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

    // Poll for exit with a deadline; opencode runs can take many minutes.
    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) => {
                if Instant::now() >= deadline {
                    timed_out = true;
                    let _ = child.kill();
                    break child.wait().ok();
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            Err(e) => {
                eprintln!("[dispatch] opencode wait failed: {e}");
                break None;
            }
        }
    };

    let drain = |h: Option<std::thread::JoinHandle<String>>| {
        h.and_then(|h| h.join().ok()).unwrap_or_default()
    };
    let stdout_full = drain(stdout);
    let stdout_tail = tail(stdout_full.clone(), 4000);
    let stderr_tail = tail(drain(stderr), 2000);

    // kiro: capture the session id for later resume. With --no-interactive the
    // id surfaces in the stream; scan for both common spellings.
    let session_id = if backend == Backend::Kiro {
        find_session_id(&stdout_full)
    } else {
        None
    };

    RunOutcome {
        ok: status.map(|s| s.success()).unwrap_or(false) && !timed_out,
        stdout_tail,
        stderr_tail,
        exit_code: status.and_then(|s| s.code()),
        timed_out,
        session_id,
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
