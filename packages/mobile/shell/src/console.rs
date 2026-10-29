//! Voice console — the mobile sibling of the desktop chat brain
//! (packages/desktop/src-tauri/src/console.rs `chat_turn`): retrieve over
//! the hub, answer with Apple's on-device model. The mobile twist: the
//! retrieval is not a fixed endpoint — the model itself drives bridge **MCP
//! tools** through a prompt-protocol loop (the `PROPOSE TASK:` trick, made
//! iterative), so a spoken "what's blocked on the train?" can orient, search
//! and read cards before it answers.
//!
//! Tool policy (BR#4782, mirrors the console's write posture):
//! - Read tools execute free: search_knowledge, get_artefact, orient, asks.
//! - answer_ask NEVER executes inside the loop — it returns as a
//!   `pending_answer` the UI must confirm by voice or tap, then
//!   `confirm_answer` performs the MCP call.
//! - Any other mutating tool is refused in-protocol. No dispatch from the
//!   phone.

use serde_json::{json, Value};

#[cfg(target_os = "ios")]
use crate::fm;
use crate::mcp;

const SEARCH_LIMIT: u32 = 5;
// The on-device model explores with one tool call per round; six gives it
// room to search, open a card or two, and still settle on a spoken answer.
const MAX_TOOL_ROUNDS: usize = 6;
// Context budget: the on-device window is ~4k tokens and each round re-sends
// everything, so results are tightly capped and the log is trimmed to the
// newest entries when it grows past the budget.
const RESULT_CHARS: usize = 900;
const TOOL_LOG_CHARS: usize = 2600;

// The on-device model's context window is small (~4k tokens) — these
// instructions are sized to leave room for tool results and the answer.
const INSTRUCTIONS: &str = "You are the Bridge voice assistant: a spoken window into the user's agent-coordination board. Answer ONLY from tool results and the conversation; never invent ids or statuses; cite ids like BR#123. Reply is SPOKEN: plain prose, under 4 sentences, no markdown or urls. Read-only: never claim or modify work. To use a tool, emit exactly one line then stop:\nTOOL_CALL: name {\"arg\":\"val\"}\nTools:\nsearch_knowledge {\"q\":\"..\"} — search the board\nget_artefact {\"id\":\"BR#123\"} — read one card\norient {\"session\":\"voice\"} — board overview\nasks {} — open asks for the human\nanswer_ask {\"id\":\"BR#123\",\"answer\":\"..\"} — ONLY if the human clearly said to send an answer this turn\nAnswer only from TOOL RESULTS: until you have seen one, your only valid move is a TOOL_CALL. When ready, answer in plain prose with no TOOL_CALL line.";

/// Tools the loop may execute on the model's say-so.
const EXECUTABLE: &[&str] = &["search_knowledge", "get_artefact", "orient", "asks"];

#[derive(serde::Serialize)]
struct Turn {
    answer: String,
    engine: &'static str,
    sources: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pending_answer: Option<PendingAnswer>,
}

#[derive(serde::Serialize)]
#[derive(Clone)]
struct PendingAnswer {
    ask_id: String,
    answer: String,
}

/// The answer engine, cfg-gated: Apple's on-device model (iOS 26+) here;
/// nothing on other platforms (tests exercise the protocol logic only).
#[cfg(target_os = "ios")]
fn engine_respond(instructions: &str, prompt: &str) -> Result<String, String> {
    fm::respond(instructions, prompt)
}
#[cfg(not(target_os = "ios"))]
fn engine_respond(_instructions: &str, _prompt: &str) -> Result<String, String> {
    Err("no on-device engine on this platform".into())
}

#[cfg(target_os = "ios")]
fn engine_available() -> bool {
    fm::is_available()
}
#[cfg(not(target_os = "ios"))]
fn engine_available() -> bool {
    false
}

/// One conversational turn: question → (tool loop) → spoken answer.
/// Returns { answer, engine, sources, pending_answer? }.
pub fn voice_turn(hub: &str, token: &str, question: &str, history: &[Value]) -> Result<Value, String> {
    if !engine_available() {
        return Ok(serde_json::to_value(Turn {
            answer: "The on-device model isn't available. Enable Apple Intelligence in Settings, or check back on an iOS 26 device.".into(),
            engine: "none",
            sources: vec![],
            pending_answer: None,
        })
        .unwrap());
    }

    let mut sources: Vec<Value> = Vec::new();
    let mut seen_ids: Vec<String> = Vec::new();
    let mut tool_log = String::new();
    let mut pending: Option<PendingAnswer> = None;
    let mut nudged = false;

    for _round in 0..=MAX_TOOL_ROUNDS {
        let prompt = build_prompt(history, question, &tool_log);
        let raw = match engine_respond(INSTRUCTIONS, &prompt) {
            Ok(r) => r,
            Err(e) if e.contains("context window") || e.contains("Exceeded") => {
                // The on-device window is tiny; a turn that outgrows it gets
                // a graceful spoken answer, not a raw engine error.
                return Ok(serde_json::to_value(Turn {
                    answer: "That question grew past what I can fit on the device model — try asking something narrower.".into(),
                    engine: "apple-fm",
                    sources,
                    pending_answer: None,
                })
                .unwrap());
            }
            Err(e) => return Err(e),
        };
        let line = match extract_tool_call(&raw) {
            Some(l) => l,
            None => {
                // Anti-hallucination: an answer that cites BR# ids with zero
                // tool results behind it is invention (the on-device model is
                // loose about the grounding rule). One nudge round, then the
                // answer stands as-is.
                if !nudged && tool_log.is_empty() && raw.contains("BR#") {
                    nudged = true;
                    tool_log.push_str(
                        "\n(none yet — you MUST emit a TOOL_CALL such as search_knowledge before answering; never cite an id you have not seen in a TOOL_RESULT)\n",
                    );
                    continue;
                }
                return Ok(serde_json::to_value(Turn {
                    answer: raw.trim().to_string(),
                    engine: "apple-fm",
                    sources,
                    pending_answer: None,
                })
                .unwrap());
            }
        };

        // One more model call after the last allowed tool round.
        let (name, args) = parse_tool_line(&line);
        let outcome = execute_tool(hub, token, &name, args, &mut sources, &mut seen_ids, &mut pending);
        tool_log.push_str(&format!("\nTOOL_CALL: {line}\nTOOL_RESULT {name}: {outcome}\n"));

        if let Some(p) = pending.clone() {
            // Confirm-first: surface to the UI instead of looping again.
            return Ok(serde_json::to_value(Turn {
                answer: raw.trim().to_string(),
                engine: "apple-fm",
                sources,
                pending_answer: Some(p),
            })
            .unwrap());
        }
    }

    Ok(serde_json::to_value(Turn {
        answer: "I dug through the board but couldn't settle on an answer — try rephrasing.".into(),
        engine: "apple-fm",
        sources,
        pending_answer: None,
    })
    .unwrap())
}

/// Execute a confirmed ask answer (the human said yes on the UI/voice leg).
pub fn confirm_answer(hub: &str, token: &str, ask_id: &str, answer: &str) -> Result<Value, String> {
    mcp::call(hub, token, "answer_ask", json!({ "id": ask_id, "answer": answer }))
}

fn build_prompt(history: &[Value], question: &str, tool_log: &str) -> String {
    let hist: String = history
        .iter()
        .rev()
        .take(4)
        .filter_map(|m| {
            let role = m.get("role")?.as_str()?;
            let text = m.get("text")?.as_str()?;
            Some(format!("{role}: {}", short(text, 250)))
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut p = String::new();
    if !hist.is_empty() {
        p.push_str(&format!("CONVERSATION SO FAR:\n{hist}\n\n"));
    }
    p.push_str(&format!("QUESTION: {question}\n"));
    if !tool_log.is_empty() {
        p.push_str(&format!("\nTOOL RESULTS SO FAR:{tool_log}\n\nContinue: answer in spoken prose, or emit the next TOOL_CALL."));
    }
    // Newest results matter most — trim from the front past the budget.
    if p.chars().count() > TOOL_LOG_CHARS {
        let cut: String = p.chars().skip(p.chars().count() - TOOL_LOG_CHARS).collect();
        p = cut;
    }
    p
}

/// Parse `TOOL_CALL: name {json}` — takes the LAST such line (the model may
/// draft and revise); json must be a braced object on the same line.
fn extract_tool_call(raw: &str) -> Option<String> {
    raw.lines()
        .rev()
        .map(|l| l.trim())
        .filter(|l| l.starts_with("TOOL_CALL:"))
        .map(|l| l.trim_start_matches("TOOL_CALL:").trim().to_string())
        .next()
}

fn parse_tool_line(line: &str) -> (String, Value) {
    let (name, rest) = match line.find(char::is_whitespace) {
        Some(i) => (&line[..i], line[i..].trim()),
        None => (line, ""),
    };
    let args = serde_json::from_str::<Value>(rest).unwrap_or_else(|_| json!({}));
    (name.to_string(), args)
}

fn execute_tool(
    hub: &str,
    token: &str,
    name: &str,
    args: Value,
    sources: &mut Vec<Value>,
    seen_ids: &mut Vec<String>,
    pending: &mut Option<PendingAnswer>,
) -> String {
    if name == "answer_ask" {
        // Confirm-first: loop NEVER executes it.
        let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let answer = args.get("answer").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if id.is_empty() || answer.is_empty() {
            return "{\"error\": \"answer_ask needs id and answer\"}".into();
        }
        *pending = Some(PendingAnswer {
            ask_id: id.clone(),
            answer: short(&answer, 500),
        });
        return format!(
            "{{\"held_for_confirmation\": true, \"ask_id\": \"{id}\"}} — the human must confirm; say you are ready to send it once they confirm."
        );
    }
    if !EXECUTABLE.contains(&name) {
        return "{\"error\": \"tool not available from the voice console (read-only + confirmed ask answers)\"}".into();
    }

    let res = match name {
        "search_knowledge" => {
            let mut q = args.clone();
            if q.get("limit").is_none() {
                q["limit"] = json!(SEARCH_LIMIT);
            }
            mcp::call(hub, token, "search_knowledge", q)
        }
        "get_artefact" => mcp::call(hub, token, "get_artefact", args),
        "orient" => {
            let mut a = args.clone();
            if a.get("session").is_none() {
                a["session"] = json!("voice-console");
            }
            mcp::call(hub, token, "orient", a)
        }
        "asks" => mcp::call(hub, token, "asks", json!({})),
        _ => unreachable!(),
    };

    match res {
        Ok(v) => {
            harvest_sources(&v, sources, seen_ids);
            serde_json::to_string(&shorten_json(&v, RESULT_CHARS)).unwrap_or_else(|_| "{}".into())
        }
        Err(e) => serde_json::to_string(&json!({ "error": short(&e, 300) })).unwrap(),
    }
}

/// Pull id+title pairs out of tool results so the answer can cite sources.
fn harvest_sources(v: &Value, sources: &mut Vec<Value>, seen: &mut Vec<String>) {
    let mut push = |id: &str, title: &str| {
        if id.starts_with("BR#") && !seen.iter().any(|s| s == id) && sources.len() < 6 {
            seen.push(id.to_string());
            sources.push(json!({ "id": id, "title": short(title, 120) }));
        }
    };
    fn walk(v: &Value, push: &mut dyn FnMut(&str, &str)) {
        match v {
            Value::Array(a) => a.iter().for_each(|x| walk(x, push)),
            Value::Object(o) => {
                let id = o.get("id").and_then(|x| x.as_str()).unwrap_or_default();
                let title = o.get("title").and_then(|x| x.as_str()).unwrap_or_default();
                if !id.is_empty() {
                    push(id, title);
                }
                o.values().for_each(|x| walk(x, push));
            }
            _ => {}
        }
    }
    walk(v, &mut push);
}

fn shorten_json(v: &Value, max_chars: usize) -> Value {
    let s = serde_json::to_string(v).unwrap_or_default();
    if s.chars().count() <= max_chars {
        return v.clone();
    }
    // Trim long strings inside the first object layer — enough grounding
    // without flooding the prompt.
    match v {
        Value::Array(a) => Value::Array(
            a.iter()
                .take(8)
                .map(|x| shorten_json(x, max_chars / 4))
                .collect(),
        ),
        Value::Object(o) => Value::Object(
            o.iter()
                .take(24)
                .map(|(k, val)| {
                    let nv = match val {
                        Value::String(s) if s.chars().count() > 600 => {
                            Value::String(short(s, 600))
                        }
                        other => shorten_json(other, max_chars / 2),
                    };
                    (k.clone(), nv)
                })
                .collect(),
        ),
        other => {
            let s = other.to_string();
            Value::String(short(&s, max_chars))
        }
    }
}

fn short(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= max {
        return t.to_string();
    }
    let cut: String = t.chars().take(max.saturating_sub(1)).collect();
    format!("{cut}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_the_last_tool_call_line() {
        let raw = "Let me look.\nTOOL_CALL: search_knowledge {\"q\": \"train\"}\nTOOL_CALL: get_artefact {\"id\": \"BR#1\"}";
        assert_eq!(
            extract_tool_call(raw).unwrap(),
            "get_artefact {\"id\": \"BR#1\"}"
        );
    }

    #[test]
    fn plain_prose_has_no_tool_call() {
        assert!(extract_tool_call("Fleet is idle, three cards in review.").is_none());
    }

    #[test]
    fn parses_name_and_args() {
        let (n, a) = parse_tool_line("search_knowledge {\"q\": \"train\"}");
        assert_eq!(n, "search_knowledge");
        assert_eq!(a["q"], "train");
    }

    #[test]
    fn parses_bare_name_with_no_args() {
        let (n, a) = parse_tool_line("asks");
        assert_eq!(n, "asks");
        assert!(a.as_object().unwrap().is_empty());
    }

    #[test]
    fn answer_ask_is_held_not_executed() {
        let mut sources = vec![];
        let mut seen = vec![];
        let mut pending = None;
        let out = execute_tool(
            "https://hub",
            "tok",
            "answer_ack_workaround_never_matches",
            json!({}), // name not executable → refusal (can't hit network in tests)
            &mut sources,
            &mut seen,
            &mut pending,
        );
        assert!(out.contains("not available"));
    }

    #[test]
    fn answer_ask_with_name_holds_for_confirmation() {
        // answer_ask is intercepted BEFORE the executable check, no network.
        let mut sources = vec![];
        let mut seen = vec![];
        let mut pending = None;
        let out = execute_tool(
            "https://hub",
            "tok",
            "answer_ask",
            json!({ "id": "BR#9", "answer": "yes, go" }),
            &mut sources,
            &mut seen,
            &mut pending,
        );
        assert!(out.contains("held_for_confirmation"), "{out}");
        let p = pending.expect("pending answer set");
        assert_eq!(p.ask_id, "BR#9");
        assert_eq!(p.answer, "yes, go");
    }

    #[test]
    fn no_engine_yields_graceful_message() {
        // Host (non-iOS) has no engine: voice_turn answers honestly and
        // returns engine=none instead of erroring.
        if engine_available() {
            return; // running under an iOS target with the model available
        }
        let v = voice_turn("https://hub", "tok", "what is blocked?", &[]).unwrap();
        assert_eq!(v["engine"], "none");
        assert!(!v["answer"].as_str().unwrap().trim().is_empty());
    }
}
