//! Minimal MCP client for the voice console — stateless JSON-RPC over
//! POST `<hub>/mcp` (the same wire the desktop dispatch and the CLI canary
//! use; see packages/worker/src/mcp.ts). Machine plane: Bearer agent token,
//! minted in the hub's Connect tab.
//!
//! One POST per tool call, no initialize handshake — the endpoint is
//! stateless by design. Errors come back typed: the JSON-RPC `error` object
//! is surfaced verbatim so gate refusals read like gate refusals.

use serde_json::{json, Value};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(30);

/// One tools/call round-trip. Returns the tool's structured content —
/// the first text block parsed as JSON when possible, else the raw text.
pub fn call(hub: &str, token: &str, tool: &str, args: Value) -> Result<Value, String> {
    let hub = hub.trim().trim_end_matches('/');
    if hub.is_empty() {
        return Err("no hub url — set it in Connect".into());
    }
    if token.trim().is_empty() {
        return Err("no bridge token — paste one from the hub's Connect tab".into());
    }
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": tool, "arguments": args },
    });

    let agent = ureq::AgentBuilder::new().timeout(TIMEOUT).build();
    let resp = agent
        .post(&format!("{hub}/mcp"))
        .set("Authorization", &format!("Bearer {}", token.trim()))
        .set("Content-Type", "application/json")
        .send_string(&body.to_string())
        .map_err(|e| match e {
            ureq::Error::Status(code, resp) => {
                let text = resp.into_string().unwrap_or_default();
                format!("mcp http {code}: {}", truncate(&text, 300))
            }
            other => format!("mcp transport: {other}"),
        })?;

    let payload: Value = resp
        .into_json()
        .map_err(|e| format!("mcp bad json: {e}"))?;

    if let Some(err) = payload.get("error") {
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown error");
        return Err(format!("mcp error: {}", truncate(msg, 300)));
    }

    let result = payload
        .get("result")
        .cloned()
        .ok_or_else(|| "mcp response missing result".to_string())?;

    // Tool results arrive as content blocks; unwrap the first text block and
    // parse it as JSON when it is one (the hub's tools all return JSON text).
    if let Some(content) = result.get("content").and_then(|c| c.as_array()) {
        let text = content
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n");
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            return Ok(v);
        }
        return Ok(Value::String(text));
    }
    Ok(result)
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_empty_token_before_any_http() {
        let e = call("https://hub.example", "", "orient", json!({})).unwrap_err();
        assert!(e.contains("no bridge token"), "{e}");
    }

    #[test]
    fn refuses_empty_hub_before_any_http() {
        let e = call("  ", "tok", "orient", json!({})).unwrap_err();
        assert!(e.contains("no hub url"), "{e}");
    }
}
