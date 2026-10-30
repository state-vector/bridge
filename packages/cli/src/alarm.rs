//! alarm.rs — the host-side death-telemetry emitter (`bridge alarm`,
//! BR#4682 TRAIN-DEFENCE L0.2). One job: put an ops note on the alarm sink
//! (BR#3124 lane) from a systemd hook context where no agent session exists —
//! the ExecStopPost death hook and the give-up escalation unit that
//! `bridge service install` emits both shell out to this.
//!
//! Why a CLI command and not raw curl in the hook: the hub's /mcp transport
//! is finicky from a bare shell (Cloudflare rejects non-browser shapes, the
//! gateway bearer lives in the keychain), and the canary (BR#4177) already
//! solved client-side MCP emission in Rust. The hook stays a dumb caller;
//! all transport/auth complexity lives here.
//!
//! Fail-open contract: a death that never reaches the board is a silent
//! death — but the hub itself may be down when the daemon dies. So the
//! invocation from the hook is best-effort (the hook always logs a local
//! receipt first at ~/.bridge/bridge-death-telemetry.log); this command
//! exits non-zero on emission failure so the hook's log records it.
//!
//! Session attribution: "host-supervisor" — machine-emitted infrastructure
//! notes from the supervisor, not an agent session (same convention as the
//! canary's "hub-canary").

use serde_json::json;
use std::time::Duration;

const SESSION: &str = "host-supervisor";
const RPC_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_SINK: &str = "BR#3124";

pub fn run(args: &[String]) -> i32 {
    match emit(args) {
        Ok(line) => {
            println!("{line}");
            0
        }
        Err(e) => {
            eprintln!("alarm failed: {e}");
            1
        }
    }
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

/// Every arg that is not a flag or a flag's value is part of the message.
fn message_of(args: &[String]) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut skip_next = false;
    for a in args {
        if skip_next {
            skip_next = false;
            continue;
        }
        if a == "--sink" || a == "--kind" || a == "--host" {
            skip_next = true;
            continue;
        }
        if a.starts_with("--") {
            continue;
        }
        parts.push(a.clone());
    }
    parts.join(" ")
}

fn emit(args: &[String]) -> Result<String, String> {
    let msg = message_of(args);
    if msg.is_empty() {
        return Err(
            "usage: bridge alarm [--sink ID] [--kind death|giveup|ops] [--host HOSTNAME] \"message\""
                .into(),
        );
    }
    let paired = crate::dispatch::DispatchConfig::resolve();
    let hub = std::env::var("BRIDGE_URL")
        .ok()
        .or(paired.as_ref().map(|c| c.url.clone()))
        .unwrap_or_default();
    let token = std::env::var("BRIDGE_TOKEN")
        .ok()
        .or(paired.as_ref().map(|c| c.token.clone()))
        .unwrap_or_default();
    if hub.trim().is_empty() || token.trim().is_empty() {
        return Err("no hub/token — pair first (`bridge pair`) or set BRIDGE_URL/BRIDGE_TOKEN".into());
    }
    let sink = flag(args, "--sink")
        .or_else(|| std::env::var("BRIDGE_ALARM_SINK").ok())
        .unwrap_or_else(|| DEFAULT_SINK.to_string());
    let host = flag(args, "--host")
        .or_else(|| std::env::var("HOSTNAME").ok())
        .unwrap_or_default();

    // Kind label — the hook uses `death`, the give-up unit `giveup`. The
    // ESCALATION label is reserved for TRUE give-ups (start-limit-hit,
    // BR#4899 defect 2: the first hook version labelled every in-backoff
    // failure "GAVE UP" and spammed ~60 false escalations/hour).
    let kind = flag(args, "--kind").unwrap_or_else(|| "ops".to_string());
    let label = match kind.as_str() {
        "death" => "[daemon-death]".to_string(),
        "giveup" => "[daemon-death ESCALATION] (start-limit-hit)".to_string(),
        other => format!("[bridge-{other}]"),
    };
    let host_suffix = if host.trim().is_empty() {
        String::new()
    } else {
        format!(" (host {})", host.trim())
    };
    let note = format!("{label}{host_suffix} {msg}");

    let http = reqwest::blocking::Client::builder()
        .timeout(RPC_TIMEOUT)
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = http
        .post(format!("{}/mcp", hub.trim_end_matches('/')))
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {}", token.trim()))
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": { "name": "log_progress", "arguments": {
                "id": sink,
                "note": note,
                "session": SESSION,
                "sentiment": "neutral"
            }}
        }))
        .send()
        .map_err(|e| format!("hub unreachable: {e}"))?;
    let out: serde_json::Value = resp.json().map_err(|e| format!("hub rpc non-JSON: {e}"))?;
    if let Some(err) = out.get("error") {
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or(&err.to_string())
            .to_string();
        return Err(format!("hub rpc error: {msg}"));
    }
    let result = out.get("result").cloned().unwrap_or(serde_json::Value::Null);
    let raw = result
        .get("content")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
    if result
        .get("isError")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return Err(format!("hub tool error: {}", &raw.chars().take(300).collect::<String>()));
    }
    let _ = parsed;
    Ok(format!("alarm posted to {sink}: {note}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_of_strips_flags_and_their_values_but_keeps_hash_ids_in_the_message() {
        // BR#4682: the death hook passes `--sink BR#3124` and a message that
        // itself names a result/signal/exit — only the free-text args may
        // survive into the note.
        let args: Vec<String> = ["--sink", "BR#3124", "--kind", "death", "--host", "ip-1-2-3",
            "result=failed", "signal=KILL", "exit=1"]
            .iter().map(|s| s.to_string()).collect();
        assert_eq!(message_of(&args), "result=failed signal=KILL exit=1");
    }

    #[test]
    fn empty_message_is_a_usage_error_not_an_empty_sink_note() {
        assert!(emit(&[]).is_err());
        let flag_only: Vec<String> = ["--sink", "BR#3124"].iter().map(|s| s.to_string()).collect();
        assert!(emit(&flag_only).is_err());
    }
}
