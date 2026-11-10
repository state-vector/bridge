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
pub(crate) fn proc_stat(raw: &str) -> Option<(char, u32, u64)> {
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
    /// Typed provider provenance (BR#8821). `None` means the failure carried
    /// no adapter-typed provider discriminator (transport/process/timeout);
    /// `Some` provenance drives the canonical route incident end-to-end.
    pub cause: Option<ProviderCause>,
}

fn ms_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Evidence classes for typed provider incidents. Only `account_action` asks
/// the owner to act; everything else is contained on the route without a
/// human ask (BR#8822: reuse/dedupe the account action, never widen it).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderCauseClass { AccountAction, RateLimit, RouteUnavailable, ProviderInternal, Diagnostic }

impl ProviderCauseClass {
    pub fn as_str(&self) -> &'static str {
        match self { Self::AccountAction => "account_action", Self::RateLimit => "rate_limit", Self::RouteUnavailable => "route_unavailable", Self::ProviderInternal => "provider_internal", Self::Diagnostic => "diagnostic" }
    }
    /// Owner asks are minted only for account-level actions (quota/auth);
    /// the human answer is never health proof — an exact-model probe clears.
    pub fn owner_action(&self) -> bool { matches!(self, Self::AccountAction) }
    pub fn text(&self, backend: &str, model: Option<&str>) -> String {
        let route = model.map(|m| format!("{backend}/{m}")).unwrap_or_else(|| backend.to_string());
        match self {
            Self::AccountAction => format!("{route}: provider account action required (quota or authentication)"),
            Self::RateLimit => format!("{route}: provider rate limit reached"),
            Self::RouteUnavailable => format!("{route}: provider route unavailable"),
            Self::ProviderInternal => format!("{route}: provider internal error"),
            Self::Diagnostic => format!("{route}: unclassified provider error"),
        }
    }
}

/// Sanitized, adapter-typed provider failure provenance. Everything here has
/// passed `redact_secrets` before durable journal/UI/owner-ask propagation.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProviderCause {
    pub class: ProviderCauseClass,
    pub backend: String,
    #[serde(default)]
    pub model: Option<String>,
    /// ACP JSON-RPC error code (v2.2.5 adapter: -32000 authRequired,
    /// -32603 service failure). Never a generic HTTP/RPC status guess.
    pub code: Option<i64>,
    /// Exact allowlisted adapter errorName (provider.quota, provider.auth, …).
    #[serde(default)]
    pub error_name: Option<String>,
    /// Redacted provider message.
    pub message: String,
    /// Redacted structured error data (object-valued where the adapter
    /// provides it — never flattened into a lossy string).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    /// One-line sanitized evidence for journal/UI surfaces.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence_line: Option<String>,
    pub at_ms: u64,
}

impl ProviderCause {
    /// `class|backend|model|config` — the route key scoping an incident. The
    /// config/credential generation is part of the identity so an old success
    /// receipt can never clear a new configuration-scoped incident.
    pub fn route_key(&self, config_revision: &str) -> String {
        format!("{}|{}|{}|{}", self.class.as_str(), self.backend, self.model.as_deref().unwrap_or(""), config_revision)
    }
    pub fn evidence_text(&self) -> String {
        let mut line = self.message.clone();
        if let Some(name) = &self.error_name { if !line.contains(name) { line = format!("[{name}] {line}"); } }
        if let Some(code) = self.code { if !line.contains(&code.to_string()) { line = format!("(code {code}) {line}"); } }
        line
    }
}

/// Credential-shaped substrings are redacted before any provider evidence is
/// journaled or surfaced (BR#8821 review: evidence sanitization is explicit,
/// not a side effect of truncation). Marker-based scanner: `key=value`
/// pairs, `Bearer <token>` runs, `sk-…` keys and long opaque opaque runs.
pub fn redact_secrets(input: &str) -> String {
    let is_keyish = |w: &str| KEY_WORDS.contains(&w.trim_matches(|c| matches!(c, '"' | '\'' | '{' | '}' | '[' | ']')).to_ascii_lowercase().as_str());
    let token_char = |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '+' | '/' | '=');
    // Lengths of the leading/trailing NON-token punctuation runs (quotes,
    // parens, commas) — the token core between them is what gets redacted.
    let lead = |w: &str| w.len() - w.trim_start_matches(|c: char| !token_char(c)).len();
    let trail = |w: &str| w.len() - w.trim_end_matches(|c: char| !token_char(c)).len();
    let mut out = String::with_capacity(input.len());
    let mut redact_next = false;
    for word in input.split(|c: char| c.is_ascii_whitespace()) {
        if redact_next {
            redact_next = false;
            if word.trim_matches(|c: char| !token_char(c)).eq_ignore_ascii_case("bearer") {
                out.push_str(word);
                out.push(' ');
                redact_next = true;
                continue;
            }
            let l = lead(word);
            let t = trail(word);
            out.push_str(&word[..l]);
            out.push_str("[redacted]");
            out.push_str(&word[word.len() - t..]);
            out.push(' ');
            continue;
        }
        // key=value / key:value inside one word
        if let Some(idx) = word.find(['=', ':']) {
            let (key, rest) = word.split_at(idx);
            if is_keyish(key) && rest[1..].eq_ignore_ascii_case("bearer") {
                out.push_str(key);
                out.push_str(": Bearer ");
                redact_next = true;
                continue;
            }
            if is_keyish(key) && rest.len() > 1 {
                out.push_str(key);
                out.push_str("[redacted] ");
                continue;
            }
        }
        if is_keyish(word) {
            out.push_str(word);
            out.push(' ');
            redact_next = true;
            continue;
        }
        let core = word.trim_matches(|c: char| !token_char(c));
        let opaque = core.len() >= 32 && core.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=' | b'_' | b'-' | b'.'));
        if (core.starts_with("sk-") && core.len() >= 10) || opaque {
            let l = lead(word);
            let t = trail(word);
            out.push_str(&word[..l]);
            out.push_str("[redacted]");
            out.push_str(&word[word.len() - t..]);
        } else {
            out.push_str(word);
        }
        out.push(' ');
    }
    out.trim_end().to_string()
}

/// Credential-shaped key names: a value stored under one of these keys is a
/// secret regardless of its shape — `redact_secrets` only sees value strings,
/// so the KEY must drive the redaction (BR#8821 review P1).
const KEY_WORDS: &[&str] = &["authorization", "authorization:", "bearer", "bearer:", "token", "token:", "password", "password:", "secret", "secret:", "key", "key:", "api_key", "api_key:", "apikey", "apikey:", "access_token", "access_token:", "x-api-key", "x-api-key:"];

fn redact_value(value: &serde_json::Value, depth: usize) -> serde_json::Value {
    const MAX_DEPTH: usize = 6;
    match value {
        serde_json::Value::String(s) => serde_json::Value::String(redact_secrets(s)),
        serde_json::Value::Array(items) if depth < MAX_DEPTH => serde_json::Value::Array(items.iter().take(24).map(|v| redact_value(v, depth + 1)).collect()),
        serde_json::Value::Object(map) if depth < MAX_DEPTH => serde_json::Value::Object(map.iter().take(24).map(|(k, v)| {
            // Key-aware redaction: `redact_secrets` never sees object keys, so
            // a credential-named key redacts its value wholesale.
            if KEY_WORDS.contains(&k.to_ascii_lowercase().as_str()) { (k.clone(), serde_json::Value::String("[redacted]".into())) } else { (k.clone(), redact_value(v, depth + 1)) }
        }).collect()),
        // Past the depth budget the subtree is REPLACED, never cloned: cloning
        // preserves raw nested secrets the scanner never inspected (P1).
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => serde_json::Value::String("[redacted:depth]".into()),
        other => other.clone(),
    }
}

fn acp_error_text(method: &str, message: &str, data: &serde_json::Value) -> String {
    let safe_data = redact_value(data, 0);
    let data_text = safe_data.as_str().map(String::from).unwrap_or_else(|| safe_data.to_string());
    redact_secrets(&format!("acp {method} failed: {message} {data_text}"))
}

fn truncate_chars(input: &str, max: usize) -> String {
    if input.chars().count() <= max { input.to_string() } else { input.chars().take(max).collect() }
}

/// Classify an ACP JSON-RPC error object using ONLY the installed adapter's
/// typed discriminators (opencode v2.2.5, receipted on the board):
/// `provider.auth` failures serialize as ACP code -32000 (AuthRequiredError);
/// every other session failure as -32603 with OBJECT data
/// `{service:"session", errorName:"provider.*"}`. Prose never classifies:
/// quota/credit flavor in a message proves nothing on its own. Unrecognized
/// provider errors keep the full sanitized evidence under `diagnostic` so the
/// route is still contained without a quota-specific owner ask.
const ACP_SESSION_ERROR_NAMES: &[(&str, ProviderCauseClass)] = &[
    ("provider.auth", ProviderCauseClass::AccountAction),
    ("provider.quota", ProviderCauseClass::AccountAction),
    ("provider.rate-limit", ProviderCauseClass::RateLimit),
    ("provider.no-route", ProviderCauseClass::RouteUnavailable),
    ("provider.transport", ProviderCauseClass::RouteUnavailable),
    ("provider.internal", ProviderCauseClass::ProviderInternal),
    ("provider.timeout", ProviderCauseClass::Diagnostic),
];

pub fn classify_provider_error(backend: &str, model: Option<&str>, code: Option<i64>, message: &str, data: &serde_json::Value, now: u64) -> Option<ProviderCause> {
    let error_name = data.get("errorName").and_then(|n| n.as_str());
    let service = data.get("service").and_then(|s| s.as_str());
    let (class, classified_name) = match (code, service, error_name) {
        (Some(-32000), _, _) => (Some(ProviderCauseClass::AccountAction), Some("provider.auth")), // AuthRequiredError wire shape
        (Some(-32603), Some("session"), Some(name)) => ACP_SESSION_ERROR_NAMES.iter().find(|(n, _)| *n == name)
            .map(|(n, c)| (Some(*c), Some(*n)))
            // Unlisted provider-prefixed names stay contained as diagnostic
            // evidence. Session-local failures (permission.rejected,
            // tool.execution, unknown…) are NOT provider outages — they stay
            // task evidence in the stderr tail, never a route incident (P2).
            .unwrap_or_else(|| if name.starts_with("provider.") {
                (Some(ProviderCauseClass::Diagnostic), Some(name))
            } else {
                // Unrecognized session errorName: not a typed provider
                // discriminator — no route incident.
                (None, None)
            }),
        (Some(-32603), Some("session"), None) => (None, None),
        _ => (None, None),
    };
    let class = class?;
    let redacted_data = match data {
        serde_json::Value::Null => None,
        value => {
            let redacted = redact_value(value, 0);
            (serde_json::to_string(&redacted).unwrap_or_default().chars().count() <= 4000).then_some(redacted)
        },
    };
    let sanitized_message = truncate_chars(&redact_secrets(message), 500);
    Some(ProviderCause {
        class,
        backend: backend.to_string(),
        model: model.map(String::from),
        code,
        error_name: classified_name.map(String::from),
        message: sanitized_message,
        data: redacted_data,
        evidence_line: None,
        at_ms: now,
    })
}

/// OpenCode v2 reports pending provider retries as typed session metadata,
/// before session/prompt returns. Never infer this from progress/stdout text.
/// https://opencode.ai/docs/cli/acp/#retry-status
#[derive(Debug, PartialEq)]
enum ProviderRetryUpdate { Unchanged, Cleared, Failed(ProviderCause) }
fn provider_retry_update(frame: &serde_json::Value, session: &str, model: Option<&str>, now: u64) -> ProviderRetryUpdate {
    if frame.get("method").and_then(|v|v.as_str()) != Some("session/update")
        || frame.pointer("/params/sessionId").or_else(||frame.get("sessionId")).and_then(|v|v.as_str()) != Some(session) {
        return ProviderRetryUpdate::Unchanged;
    }
    let Some(update) = update_payload(frame) else { return ProviderRetryUpdate::Unchanged; };
    if update.get("sessionUpdate").and_then(|v|v.as_str()) != Some("session_info_update")
        || update.pointer("/_meta/opencode~1child-session").is_some()
        || frame.pointer("/params/_meta/opencode~1child-session").is_some() {
        return ProviderRetryUpdate::Unchanged;
    }
    let Some(retry) = update.pointer("/_meta/opencode~1retry") else { return ProviderRetryUpdate::Unchanged; };
    if retry.is_null() { return ProviderRetryUpdate::Cleared; }
    let Some(name) = retry.pointer("/error/type").and_then(|v|v.as_str()) else { return ProviderRetryUpdate::Unchanged; };
    if !name.starts_with("provider.") { return ProviderRetryUpdate::Cleared; }
    let class = ACP_SESSION_ERROR_NAMES.iter().find(|(n,_)|*n==name).map(|(_,class)|*class).unwrap_or(ProviderCauseClass::Diagnostic);
    let data = redact_value(retry, 0);
    let data = (serde_json::to_string(&data).unwrap_or_default().chars().count() <= 4000).then_some(data);
    ProviderRetryUpdate::Failed(ProviderCause {
        class, backend:"opencode".into(), model:model.map(String::from),
        // This is a notification, not an RPC error response. HTTP status stays
        // in the sanitized original metadata; never invent an RPC code.
        code:None, error_name:Some(name.into()),
        message:truncate_chars(&redact_secrets(retry.pointer("/error/message").and_then(|v|v.as_str()).unwrap_or("Provider retry pending")),500),
        data, evidence_line:Some("ACP opencode/retry was pending when the prompt stopped".into()), at_ms:now,
    })
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
    pub fn grant_lease_from(&self, requested_at: Instant) {
        // A replay can return the lease from the first delivery of the RPC.
        // Anchor the local deadline to that request, never its late receipt.
        let proved_until = requested_at + Duration::from_secs(90);
        if let Ok(mut deadline) = self.lease_deadline.lock() {
            *deadline = Some(deadline.map_or(proved_until, |current| current.max(proved_until)));
        }
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
    control.grant_lease_from(Instant::now());
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
    control.grant_lease_from(Instant::now());
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
                    cause: None,
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
            cause: None,
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
                    cause: None,
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
        // Returns Err on timeout/dead child. A JSON-RPC error object carries
        // its typed provider cause alongside the sanitized flat text.
        #[derive(PartialEq)]
        enum AcpFailureOrigin { Transport, Response }
        struct AcpCallError { text: String, cause: Option<ProviderCause>, origin: AcpFailureOrigin }
        let call = |stdin: &mut BufWriter<std::process::ChildStdin>,
                        id: i64,
                        method: &str,
                        params: serde_json::Value,
                        rx: &std::sync::mpsc::Receiver<String>,
                        on_line: &mut dyn FnMut(&str),
                        deadline: Instant|
         -> Result<serde_json::Value, AcpCallError> {
            let frame = serde_json::json!({
                "jsonrpc": "2.0", "id": id, "method": method, "params": params
            });
            stdin
                .write_all(serde_json::to_string(&frame).unwrap_or_default().as_bytes())
                .and_then(|_| stdin.write_all(b"\n"))
                .and_then(|_| stdin.flush())
                .map_err(|e| AcpCallError { text: format!("acp stdin write failed: {e}"), cause: None, origin: AcpFailureOrigin::Transport })?;
            let mut last_line = Instant::now();
            loop {
                if req.control.map(|c| c.should_stop()).unwrap_or(false) {
                    return Err(AcpCallError { text: "acp interrupted — stop for a fresh attempt".into(), cause: None, origin: AcpFailureOrigin::Transport });
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
                    result => result.map_err(|_| AcpCallError {
                    text: if now >= stall_end {
                        "acp timed out — stalled: no output for 5m".to_string()
                    } else {
                        "acp timed out (budget + grace exhausted)".to_string()
                    },
                    cause: None,
                    origin: AcpFailureOrigin::Transport,
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
                        let code = err.get("code").and_then(|c| c.as_i64());
                        let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown");
                        let data = err.get("data").cloned().unwrap_or(serde_json::Value::Null);
                        // Keep the flattened stderr text (string data renders as
                        // itself; object data renders compactly) but redact it,
                        // and attach the typed provenance for the incident route.

                        let cause = classify_provider_error("opencode", req.model, code, msg, &data, ms_now());
                        return Err(AcpCallError {
                            text: acp_error_text(method, msg, &data),
                            cause,
                            origin: AcpFailureOrigin::Response,
                        });
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
            Err(e) => return acp_fail(child, format!("{ACP_UNAVAILABLE} {}", e.text), e.cause),
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
            Err(e) => return acp_fail(child, format!("{ACP_UNAVAILABLE} {}", e.text), e.cause),
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
        let mut retry_cause = None;
        let mut on_prompt = |line: &str| {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(session) = session_id.as_deref() {
                    match provider_retry_update(&v, session, req.model, ms_now()) {
                        ProviderRetryUpdate::Unchanged => {},
                        ProviderRetryUpdate::Cleared => retry_cause = None,
                        ProviderRetryUpdate::Failed(cause) => retry_cause = Some(cause),
                    }
                }
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
                    cause: None,
                }
            }
            Err(e) if e.text.contains("timed out") => RunOutcome {
                ok: false,
                stdout_tail: tail(accumulated, 4000),
                stderr_tail: e.text,
                exit_code: None,
                timed_out: true,
                session_id,
                cause: if e.origin == AcpFailureOrigin::Response { e.cause } else { e.cause.or(retry_cause) },
            },
            Err(e) => RunOutcome {
                ok: false,
                stdout_tail: tail(accumulated, 4000),
                stderr_tail: e.text,
                exit_code: status.and_then(|s| s.code()),
                timed_out,
                session_id,
                cause: if e.origin == AcpFailureOrigin::Response { e.cause } else { e.cause.or(retry_cause) },
            },
        }
    }
}

fn acp_fail(mut child: Child, msg: String, cause: Option<ProviderCause>) -> RunOutcome {
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
        cause,
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
                    cause: None,
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
            cause: None,
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

    #[test]
    fn a_replayed_renewal_cannot_extend_an_expired_local_lease() {
        let control = RunControl::with_cancel(None);
        let requested_at = Instant::now() - Duration::from_secs(91);
        control.grant_lease_from(requested_at);
        assert!(!control.lease_valid());

        let fresh_request = Instant::now();
        control.grant_lease_from(fresh_request);
        control.grant_lease_from(requested_at);
        assert_eq!(*control.lease_deadline.lock().unwrap(), Some(fresh_request + Duration::from_secs(90)));
        assert!(control.lease_valid());
    }


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

#[cfg(test)]
mod provider_cause_tests {
    use super::*;
    use serde_json::json;

    fn retry_frame(session: &str, retry: serde_json::Value) -> serde_json::Value {
        json!({"method":"session/update","params":{"sessionId":session,"update":{"sessionUpdate":"session_info_update","_meta":{"opencode/retry":retry}}}})
    }
    /// Exercise the real subprocess/JSON-RPC path: metadata must survive a
    /// lost prompt response, but must never override a terminal task error.
    #[cfg(unix)]
    #[test]
    fn acp_prompt_retry_cause_tracks_response_and_clear_boundaries() {
        use std::os::unix::fs::PermissionsExt;
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("bridge-acp-retry-{nonce}"));
        std::fs::create_dir_all(&dir).unwrap();
        for mode in ["lost", "cleared", "success", "task_error"] {
            let mut frames = vec![retry_frame("parent", json!({"error":{"type":"provider.quota","message":"Credit exhausted","status":402}}))];
            match mode {
                "cleared" => frames.push(retry_frame("parent", serde_json::Value::Null)),
                "success" => frames.push(json!({"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}})),
                "task_error" => frames.push(json!({"jsonrpc":"2.0","id":3,"error":{"code":-32603,"message":"Tool rejected","data":{"service":"session","errorName":"tool.execution"}}})),
                _ => {},
            }
            let script = dir.join(mode);
            let mut body = String::from("#!/bin/sh\nread -r line\nprintf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}'\nread -r line\nprintf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"sessionId\":\"parent\"}}'\nread -r line\n");
            for frame in frames { body.push_str(&format!("printf '%s\\n' '{}'\n", frame)); }
            std::fs::write(&script,body).unwrap();
            std::fs::set_permissions(&script,std::fs::Permissions::from_mode(0o700)).unwrap();
            let out = OpencodeAcp.dispatch(&RunRequest {workdir:dir.to_str().unwrap(),bin:script.to_str().unwrap(),agent:None,model:Some("llmgw/glm-5.3"),prompt:"test",title:None,resume:None,extra_config:None,control:None},Duration::from_secs(5),None);
            assert_eq!(out.session_id.as_deref(),Some("parent"),"{mode}");
            assert_eq!(out.ok,mode=="success","{mode}");
            if mode=="lost" {
                assert_eq!(out.cause.unwrap().error_name.as_deref(),Some("provider.quota"));
            } else {assert!(out.cause.is_none(),"{mode}: stale provider cause");}
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn pending_retry_preserves_typed_cause_without_inventing_rpc_code() {
        let frame=retry_frame("parent",json!({"attempt":2,"nextRetryAt":"2026-11-09T01:00:00Z","error":{"type":"provider.quota","message":"Credit exhausted","status":402,"response":{"headers":{"authorization":"Bearer short-secret"}}}}));
        let ProviderRetryUpdate::Failed(cause)=provider_retry_update(&frame,"parent",Some("llmgw/glm-5.3"),100) else {panic!("typed retry missing")};
        assert_eq!(cause.class,ProviderCauseClass::AccountAction);
        assert_eq!(cause.code,None);
        assert_eq!(cause.error_name.as_deref(),Some("provider.quota"));
        assert!(!serde_json::to_string(&cause).unwrap().contains("short-secret"));
        assert_eq!(cause.data.unwrap()["error"]["status"],402);
    }
    #[test]
    fn retry_clear_and_session_child_fences_prevent_stale_provider_blame() {
        let mut frame=retry_frame("parent",json!({"error":{"type":"provider.rate-limit","message":"Busy"}}));
        assert_eq!(provider_retry_update(&frame,"another",None,1),ProviderRetryUpdate::Unchanged);
        frame["params"]["update"]["_meta"]["opencode/child-session"]=json!({"id":"child"});
        assert_eq!(provider_retry_update(&frame,"parent",None,1),ProviderRetryUpdate::Unchanged);
        assert_eq!(provider_retry_update(&retry_frame("parent",serde_json::Value::Null),"parent",None,2),ProviderRetryUpdate::Cleared);
        assert_eq!(provider_retry_update(&retry_frame("parent",json!({"error":{"type":"tool.execution","message":"Credit exhausted"}})),"parent",None,2),ProviderRetryUpdate::Cleared);
    }
    #[test]
    fn generic_provider_retry_stays_diagnostic_and_progress_text_is_not_evidence() {
        let frame=retry_frame("parent",json!({"error":{"type":"provider.unknown","message":"NoDeploymentsAvailable"}}));
        let ProviderRetryUpdate::Failed(cause)=provider_retry_update(&frame,"parent",None,1) else {panic!("diagnostic missing")};
        assert_eq!(cause.class,ProviderCauseClass::Diagnostic);
        let prose=json!({"method":"session/update","params":{"sessionId":"parent","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"provider.quota"}}}});
        assert_eq!(provider_retry_update(&prose,"parent",None,1),ProviderRetryUpdate::Unchanged);
    }

    #[test]
    fn stderr_error_serializes_only_key_redacted_structured_data() {
        let data = json!({"service":"session", "password":"short-pass", "nested":{"api_key":"short-key"}, "headers":{"authorization":"Bearer short-token"}});
        let text = acp_error_text("session/prompt", "Authentication required", &data);
        for secret in ["short-pass", "short-key", "short-token"] { assert!(!text.contains(secret), "{text}"); }
        assert!(text.contains("session"));
    }

    /// Official v2.2.5 wire fixture (cli/test/acp/prompt.test.ts): provider.auth
    /// serializes as ACP -32000. Classification must yield the account-action
    /// class WITHOUT prose matching.
    #[test]
    fn auth_required_error_classifies_account_action_from_wire_code() {
        let cause = classify_provider_error("opencode", Some("llmgw/glm-5.3-flash"), Some(-32000),
            "Authentication required. Visit https://example.tld/auth to authenticate", &json!({}), 1000)
            .expect("typed adapter shape must classify");
        assert_eq!(cause.class, ProviderCauseClass::AccountAction);
        assert_eq!(cause.error_name.as_deref(), Some("provider.auth"));
        assert_eq!(cause.code, Some(-32000));
        assert_eq!(cause.backend, "opencode");
        assert_eq!(cause.model.as_deref(), Some("llmgw/glm-5.3-flash"));
        assert!(cause.class.owner_action());
    }

    /// provider.quota rides -32603 with OBJECT data {service, errorName}.
    #[test]
    fn quota_error_name_classifies_account_action_without_prose() {
        let cause = classify_provider_error("opencode", Some("llmgw/glm-5.3"), Some(-32603),
            "provider quota exceeded", &json!({"service":"session","errorName":"provider.quota"}), 1000)
            .expect("provider.quota is an allowlisted adapter errorName");
        assert_eq!(cause.class, ProviderCauseClass::AccountAction);
        assert_eq!(cause.error_name.as_deref(), Some("provider.quota"));
        assert_eq!(cause.data.as_ref().and_then(|d| d.get("service")).and_then(|s| s.as_str()), Some("session"));
    }

    /// provider.rate-limit / no-route / transport / internal map to their own
    /// classes and NEVER mint an owner ask.
    #[test]
    fn allowlisted_session_error_names_map_to_their_classes() {
        for (name, expected) in [
            ("provider.rate-limit", ProviderCauseClass::RateLimit),
            ("provider.no-route", ProviderCauseClass::RouteUnavailable),
            ("provider.transport", ProviderCauseClass::RouteUnavailable),
            ("provider.internal", ProviderCauseClass::ProviderInternal),
            ("provider.timeout", ProviderCauseClass::Diagnostic),
        ] {
            let cause = classify_provider_error("opencode", Some("m"), Some(-32603), "failed",
                &json!({"service":"session","errorName":name}), 1000).expect("allowlisted");
            assert_eq!(cause.class, expected, "{name}");
            assert!(!cause.class.owner_action());
        }
    }

    /// Object-valued provider data survives classification (no string
    /// flattening); unclassified -32603 session failures stay diagnostic and
    /// preserve sanitized evidence — containment without an owner ask.
    #[test]
    fn unclassified_session_failures_keep_diagnostic_with_structured_evidence() {
        let cause = classify_provider_error("opencode", Some("m"), Some(-32603), "upstream exploded",
            &json!({"service":"session","errorName":"provider.something-new","detail":{"status":502,"body":"bad gateway"}}), 1000)
            .expect("session-scoped -32603 always carries evidence");
        assert_eq!(cause.class, ProviderCauseClass::Diagnostic);
        assert_eq!(cause.error_name.as_deref(), Some("provider.something-new"));
        assert!(cause.data.is_some());
        assert!(!cause.class.owner_action());
    }

    /// Non-provider JSON-RPC codes (no session scope, no auth code) do NOT
    /// classify — generic RPC codes are not HTTP statuses and never invent
    /// quota/credit subtypes.
    #[test]
    fn generic_rpc_errors_do_not_classify() {
        assert!(classify_provider_error("opencode", Some("m"), Some(-32603), "not a provider error",
            &json!({"detail":"workspace rejected"}), 1000).is_none());
        assert!(classify_provider_error("opencode", Some("m"), Some(-32700), "parse error", &json!({}), 1000).is_none());
        assert!(classify_provider_error("opencode", Some("m"), Some(-2), "ZAI 1310 quota exhausted", &json!({}), 1000).is_none());
    }

    /// Credentials in provider messages/data are redacted before evidence
    /// leaves the transport.
    #[test]
    fn provider_evidence_is_sanitized_of_secrets() {
        let cause = classify_provider_error("opencode", Some("m"), Some(-32000),
            "Authorization Bearer sk-abcdef1234567890abcdef rejected",
            &json!({"api_key":"sk-zzzzzz1234567890","service":"session"}), 1000).unwrap();
        assert!(!cause.message.contains("sk-abcdef"));
        assert!(!serde_json::to_string(cause.data.as_ref().unwrap()).unwrap().contains("sk-zzzzzz"));
        let redacted = redact_secrets("token=supersecret123 and Bearer supersecret456 keep-this");
        assert!(!redacted.contains("supersecret"));
        assert!(redacted.contains("keep-this"));
    }

    /// Route identity scopes config/credential generation: same model under a
    /// new config revision is a DIFFERENT route, so stale success receipts can
    /// never clear a new configuration incident.
    #[test]
    fn route_key_scopes_config_revision() {
        let cause = ProviderCause { class: ProviderCauseClass::AccountAction, backend: "opencode".into(), model: Some("m".into()),
            code: Some(-32000), error_name: Some("provider.auth".into()), message: "x".into(), data: None, evidence_line: None, at_ms: 1 };
        assert_ne!(cause.route_key("rev-1"), cause.route_key("rev-2"));
        assert_eq!(cause.route_key("rev-1"), "account_action|opencode|m|rev-1");
    }

    /// Unlisted NON-provider session failures (permission.rejected,
    /// tool.execution, unknown…) are task-local evidence — no route
    /// containment, no provider incident (BR#8821 review P2).
    #[test]
    fn session_local_errors_do_not_become_route_incidents() {
        for name in ["permission.rejected", "tool.execution", "unknown", ""] {
            assert!(classify_provider_error("opencode", Some("m"), Some(-32603), "task-level failure",
                &json!({"service":"session","errorName":name}), 1000).is_none(), "{name}");
        }
        // Unlisted provider-prefixed names stay contained as diagnostic.
        let contained = classify_provider_error("opencode", Some("m"), Some(-32603), "upstream",
            &json!({"service":"session","errorName":"provider.mystery"}), 1000).expect("provider-prefixed stays contained");
        assert_eq!(contained.class, ProviderCauseClass::Diagnostic);
    }

    /// Key-aware redaction (P1): a credential-named object key redacts its
    /// value wholesale — the value string is short enough that the
    /// token-length scanner would keep it raw.
    #[test]
    fn credential_named_object_keys_redact_values() {
        let redacted = redact_value(&json!({"api_key":"short-secret","password":"pw","ok":"visible"}), 0);
        assert_eq!(redacted.get("api_key").and_then(|v| v.as_str()), Some("[redacted]"));
        assert_eq!(redacted.get("password").and_then(|v| v.as_str()), Some("[redacted]"));
        assert_eq!(redacted.get("ok").and_then(|v| v.as_str()), Some("visible"));
        // Authorization headers split across words redact the bearer token.
        let header = redact_secrets("Authorization: Bearer abc123");
        assert!(!header.contains("abc123"), "{header}");
        assert!(header.contains("Bearer") || header.contains("[redacted]"), "{header}");
    }

    /// Depth-limited subtrees are REPLACED, never cloned: cloning past the
    /// budget preserves raw nested secrets the scanner never saw (P1).
    #[test]
    fn deep_subtrees_are_replaced_not_cloned() {
        let mut deep = json!({"note":"visible"});
        for _ in 0..8 { deep = json!({"nest": deep, "leak": "sk-abcdef1234567890"}); }
        let redacted = redact_value(&deep, 0);
        assert!(!serde_json::to_string(&redacted).unwrap().contains("sk-abcdef1234567890"));
        let replaced = serde_json::to_string(&redacted).unwrap();
        assert!(replaced.contains("[redacted:depth]"), "{replaced}");
    }
}
