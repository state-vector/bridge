//! opencode subprocess runner — spawns headless opencode runs and captures output.
//!
//! Headless invocation: `opencode run "<prompt>"` (optionally `--agent <name>`).
//! `opencode run` is already non-interactive — there is no `--auto` flag.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub struct RunOutcome {
    pub ok: bool,
    pub stdout_tail: String,
    pub stderr_tail: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
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

/// Run opencode headlessly against `workdir`. Blocks until exit or timeout.
/// stdout/stderr are drained on reader threads so big sessions can't deadlock
/// on full pipes. `title` tags the opencode session (`bridge-<task_id>`) so the
/// runner can rediscover it for resume; `resume` continues a prior session.
pub fn run_task(
    workdir: &str,
    bin: &str,
    agent: Option<&str>,
    prompt: &str,
    timeout: Duration,
    title: Option<&str>,
    resume: Option<&str>,
) -> RunOutcome {
    let mut cmd = Command::new(bin);
    cmd.arg("run")
        .current_dir(workdir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
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

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[dispatch] opencode spawn failed: {e}");
            return RunOutcome {
                ok: false,
                stdout_tail: String::new(),
                stderr_tail: format!("spawn failed: {e}"),
                exit_code: None,
                timed_out: false,
            };
        }
    };

    let stdout = child.stdout.take().map(|mut p| {
        std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = p.read_to_string(&mut buf);
            buf
        })
    });
    let stderr = child.stderr.take().map(|mut p| {
        std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = p.read_to_string(&mut buf);
            buf
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
    let stdout_tail = tail(drain(stdout), 4000);
    let stderr_tail = tail(drain(stderr), 2000);

    RunOutcome {
        ok: status.map(|s| s.success()).unwrap_or(false) && !timed_out,
        stdout_tail,
        stderr_tail,
        exit_code: status.and_then(|s| s.code()),
        timed_out,
    }
}
