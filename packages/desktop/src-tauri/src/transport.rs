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
use std::time::{Duration, Instant};

pub struct RunOutcome {
    pub ok: bool,
    pub stdout_tail: String,
    pub stderr_tail: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub session_id: Option<String>, // for resume (kiro stream / ACP sessionId)
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
fn wait_or_kill(child: &mut Child, timeout: Duration) -> (Option<std::process::ExitStatus>, bool) {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(st)) => return (Some(st), false),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    return (child.wait().ok(), true);
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            Err(_) => return (None, false),
        }
    }
}

// ---------------------------------------------------------------------------
// opencode run (stdio) — the long-standing transport
// ---------------------------------------------------------------------------

pub struct OpencodeRun;

impl AgentTransport for OpencodeRun {
    fn dispatch(&self, req: &RunRequest, timeout: Duration, live: Option<Arc<Mutex<String>>>) -> RunOutcome {
        let mut cmd = Command::new(req.bin);
        cmd.arg("run")
            .current_dir(req.workdir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        sanitized(&mut cmd);
        cmd.arg("run");
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

        let mut child = match cmd.spawn() {
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
                                eprintln!("[dispatch] {label} picked up — agent responding");
                            }
                            bytes.extend_from_slice(&chunk[..n]);
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

        let (status, timed_out) = wait_or_kill(&mut child, timeout);
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
        if let Some(cfg_json) = req.extra_config {
            cmd.env("OPENCODE_CONFIG_CONTENT", cfg_json);
        }

        let mut child = match cmd.spawn() {
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
            let req = serde_json::json!({
                "jsonrpc": "2.0", "id": id, "method": method, "params": params
            });
            stdin
                .write_all(serde_json::to_string(&req).unwrap_or_default().as_bytes())
                .and_then(|_| stdin.write_all(b"\n"))
                .and_then(|_| stdin.flush())
                .map_err(|e| format!("acp stdin write failed: {e}"))?;
            let mut last_line = Instant::now();
            loop {
                // wait until whichever comes first: the stall window closing
                // (no output for 5m — hung) or the hard ceiling (budget +
                // one stall window of post-budget grace for live sessions)
                let now = Instant::now();
                let stall_end = last_line + ACP_STALL;
                let hard_end = deadline + ACP_STALL;
                let left = hard_end
                    .checked_duration_since(now)
                    .unwrap_or(Duration::ZERO)
                    .min(stall_end.checked_duration_since(now).unwrap_or(Duration::ZERO));
                let line = rx.recv_timeout(left).map_err(|_| {
                    if now >= stall_end {
                        "acp timed out — stalled: no output for 5m".to_string()
                    } else {
                        "acp timed out (budget + grace exhausted)".to_string()
                    }
                })?;
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
        let (status, timed_out) = wait_or_kill(&mut child, Duration::from_secs(30));
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
    let _ = child.kill();
    let _ = child.wait();
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
    // depending on the opencode version — accept both. A version whose frames
    // don't match here used to go completely dark to the runner: no live
    // line, no session_alive vouches, watchdog releasing working sessions as
    // "stalled" (fleet incident 2026-10-22, hermes).
    let text_of = |c: &serde_json::Value| -> Option<String> {
        if let Some(t) = c.get("text").and_then(|t| t.as_str()) {
            return Some(t.to_string());
        }
        if let Some(blocks) = c.as_array() {
            for b in blocks {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                        return Some(t.to_string());
                    }
                }
            }
        }
        None
    };
    match kind {
        "agent_message_chunk" | "agent_thought_chunk" => u.get("content").and_then(text_of),
        "tool_call" | "tool_call_update" => {
            let title = u.get("title").and_then(|t| t.as_str()).unwrap_or("tool");
            Some(format!("[tool] {title}"))
        }
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

        let mut child = match cmd.spawn() {
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
        let (status, timed_out) = wait_or_kill(&mut child, timeout);
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
