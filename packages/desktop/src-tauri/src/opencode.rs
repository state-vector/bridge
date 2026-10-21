pub use crate::transport::RunOutcome;

/// opencode subprocess runner — spawns headless runs (stdio) and ACP sessions.
/// The Backend enum + transport selection live here; protocol specifics live
/// in `transport.rs` behind the AgentTransport trait.

use std::sync::{Arc, Mutex};
use std::time::Duration;

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

/// Run the agent against `workdir` via the transport selected for `backend`
/// + `mode`. Blocks until exit or timeout. `mode`: Some("acp") forces the ACP
/// JSON-RPC transport; Some("stdio") forces headless run; None defaults to
/// acp for opencode (fallback to stdio if ACP is unavailable) and stdio for
/// kiro.
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
    extra_config: Option<&str>,
    mode: Option<&str>,
    live: Option<Arc<Mutex<String>>>,
) -> crate::transport::RunOutcome {
    let req = crate::transport::RunRequest {
        workdir,
        bin,
        agent,
        model,
        prompt,
        title,
        resume,
        extra_config,
    };
    let t = crate::transport::transport_for(backend, mode);
    t.dispatch(&req, timeout, live)
}
