//! Desktop console — two human-facing services that are NOT dispatch:
//!
//! 1. `chat_turn` — one conversational turn over the hub's knowledge. Retrieve
//!    (machine-plane search) then summarise with Apple's on-device model
//!    (FoundationModels, macOS 26+); the configured backend CLI is the
//!    fallback engine. The console never claims work or writes to the board —
//!    it reads and summarises only.
//! 2. `start_decision_watch` — polls the For You inbox and raises an OS
//!    notification when a proposed decision appears. Clicking it emits the
//!    same "open-ask" event the ask notifications use, so the panel can jump
//!    to the inbox.

use std::collections::HashSet;
use std::time::Duration;

use serde_json::{json, Value};

use crate::dispatch::DispatchConfig;
use crate::mac_notify;
use crate::opencode;

const SEARCH_LIMIT: u32 = 8;
const SNIPPET_CHARS: usize = 700;
const CHAT_TIMEOUT: Duration = Duration::from_secs(120);
const WATCH_INTERVAL: Duration = Duration::from_secs(60);

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

/// Retrieve artefacts relevant to the question from the paired hub.
/// Empty (not error) when unconfigured — the chat still runs, it just answers
/// from the conversation alone.
fn retrieve(question: &str) -> Result<Vec<Value>, String> {
    let Some(cfg) = DispatchConfig::resolve() else {
        return Ok(vec![]);
    };
    let client = http_client()?;
    let resp = client
        .get(format!(
            "{}/api/kb-machine/search",
            cfg.url.trim_end_matches('/')
        ))
        .query(&[("q", question), ("limit", &SEARCH_LIMIT.to_string())])
        .header("Authorization", format!("Bearer {}", cfg.token))
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json::<Value>()
        .map_err(|e| e.to_string())?;
    Ok(resp
        .get("artefacts")
        .and_then(|a| a.as_array().cloned())
        .unwrap_or_default())
}

fn snippet(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        return s.to_string();
    }
    format!("{}…", s.chars().take(max).collect::<String>())
}

fn context_block(artefacts: &[Value]) -> String {
    if artefacts.is_empty() {
        return "(no board artefacts matched — the hub may be unconfigured or the topic unknown)".into();
    }
    artefacts
        .iter()
        .map(|a| {
            format!(
                "[{}] {} | type={} status={} owner={}\n{}",
                a.get("id").and_then(|v| v.as_str()).unwrap_or("?"),
                a.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                a.get("type").and_then(|v| v.as_str()).unwrap_or("?"),
                a.get("status").and_then(|v| v.as_str()).unwrap_or("?"),
                a.get("owner").and_then(|v| v.as_str()).unwrap_or("—"),
                snippet(
                    a.get("body_md").and_then(|v| v.as_str()).unwrap_or(""),
                    SNIPPET_CHARS,
                )
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

const INSTRUCTIONS: &str = "You are the Bridge console assistant — a human operator's window into their agent-coordination board (tasks, decisions, questions, progress). Answer ONLY from the supplied board artefacts and the conversation so far; never invent artefacts, ids, or statuses. Cite artefact ids like BR#123 when you use them. Be concise and factual. You cannot claim, dispatch, or modify work — if the human asks for that, tell them to use the board or the dispatch runner.";

fn history_block(history: &[Value]) -> String {
    history
        .iter()
        .filter_map(|m| {
            let role = m.get("role")?.as_str()?;
            let text = m.get("text")?.as_str()?;
            Some(format!("{}: {}", role, snippet(text, 400)))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Try the on-device Apple model. Ok(None) when unavailable (pre-26 OS,
/// Apple Intelligence off) so the caller can fall back.
fn local_answer(prompt: &str) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        if !foundation_models::SystemLanguageModel::is_available() {
            return Ok(None);
        }
        let session = foundation_models::LanguageModelSession::with_instructions(INSTRUCTIONS)
            .map_err(|e| format!("apple-fm session: {e}"))?;
        let reply = session
            .respond(prompt)
            .map_err(|e| format!("apple-fm respond: {e}"))?;
        Ok(Some(reply))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = prompt;
        Ok(None)
    }
}

/// Fallback engine: one-shot through the configured dispatch backend CLI.
/// Read-only relative to the board, but it runs in the workspace like any
/// dispatch run — so this is the slower, more capable second choice.
fn cli_answer(question: &str, context: &str, history: &str) -> Result<Option<(String, String)>, String> {
    let Some(cfg) = DispatchConfig::resolve() else {
        return Ok(None);
    };
    let backend = opencode::Backend::parse(Some(cfg.backend.as_deref().unwrap_or("opencode")));
    let model = cfg
        .models
        .as_ref()
        .and_then(|m| m.get(cfg.backend.as_deref().unwrap_or("opencode")))
        .cloned()
        .or_else(|| cfg.model.clone());
    let workdir = if std::path::Path::new(&cfg.workdir).exists() {
        cfg.workdir.clone()
    } else {
        std::env::var("HOME").unwrap_or_else(|_| ".".into())
    };
    let prompt = format!(
        "{INSTRUCTIONS}\n\nBOARD CONTEXT:\n{context}\n\nCONVERSATION SO FAR:\n{history}\n\nQUESTION: {question}\n\nAnswer concisely, citing artefact ids."
    );
    let outcome = opencode::run_task(
        &workdir,
        &cfg.opencode_bin,
        backend,
        None,
        model.as_deref(),
        &prompt,
        CHAT_TIMEOUT,
        Some("bridge-console"),
        None,
        None,
    );
    if outcome.ok {
        let text = outcome.stdout_tail.trim().to_string();
        if !text.is_empty() {
            let engine = match backend {
                opencode::Backend::OpenCode => "opencode".into(),
                opencode::Backend::Kiro => "kiro".into(),
            };
            return Ok(Some((text, engine)));
        }
    }
    Ok(None)
}

/// One console turn: retrieve → ground → summarise.
/// Returns {answer, sources, engine} — answer is an error string only when
/// no engine could produce a reply.
pub fn chat_turn(question: &str, history: &[Value]) -> Result<Value, String> {
    let artefacts = retrieve(question)?;
    let context = context_block(&artefacts);
    let history = history_block(history);
    let prompt = format!(
        "BOARD CONTEXT:\n{context}\n\nCONVERSATION SO FAR:\n{history}\n\nQUESTION: {question}"
    );

    let sources: Vec<Value> = artefacts
        .iter()
        .map(|a| {
            json!({
                "id": a.get("id").and_then(|v| v.as_str()).unwrap_or("?"),
                "title": a.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                "status": a.get("status").and_then(|v| v.as_str()).unwrap_or("?"),
            })
        })
        .collect();

    if let Some(answer) = local_answer(&prompt)? {
        return Ok(json!({ "answer": answer, "sources": sources, "engine": "apple-fm" }));
    }
    if let Some((answer, engine)) = cli_answer(question, &context, &history)? {
        return Ok(json!({ "answer": answer, "sources": sources, "engine": engine }));
    }
    Ok(json!({
        "answer": "No chat engine available — Apple Intelligence is unavailable and no dispatch backend is configured. Pair and configure a backend in Settings, or enable Apple Intelligence in System Settings.",
        "sources": sources,
        "engine": "none",
    }))
}

// ---- decision watch ----

/// Poll the For You inbox and notify on NEW proposed decisions. The first
/// successful pass seeds the seen-set silently (no launch spam); a decision
/// that leaves the proposed set may re-notify if it returns. Clicks emit
/// "open-ask" so the panel jumps to the inbox.
pub fn start_decision_watch(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut seen: Option<HashSet<String>> = None;
        loop {
            std::thread::sleep(WATCH_INTERVAL);
            let Ok(payload) = crate::dispatch::for_you_payload() else {
                continue;
            };
            let current: HashSet<String> = payload
                .get("decisions")
                .and_then(|d| d.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|d| d.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            let Some(prev) = seen.replace(current.clone()) else {
                continue; // seed pass — never notify on first sight
            };
            for id in current.difference(&prev) {
                let artefact = payload
                    .get("decisions")
                    .and_then(|d| d.as_array())
                    .and_then(|arr| {
                        arr.iter()
                            .find(|d| d.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
                    });
                let title = artefact
                    .and_then(|d| d.get("title").and_then(|v| v.as_str()))
                    .unwrap_or("");
                let awaiting = artefact
                    .and_then(|d| d.get("meta"))
                    .and_then(|m| m.get("awaiting_decision"))
                    .map(|v| !v.is_null() && v.as_bool().unwrap_or(true))
                    .unwrap_or(false);
                let body = if awaiting {
                    format!("AWAITING DECISION · {id} — {}", snippet(title, 140))
                } else {
                    format!("{id} — {}", snippet(title, 140))
                };
                notify_decision(&app, id, &body);
            }
        }
    });
}

fn notify_decision(app: &tauri::AppHandle, id: &str, body: &str) {
    let title = "Decision awaits — bridge";
    let dispatched = app.run_on_main_thread({
        let app = app.clone();
        let id = id.to_string();
        let title = title.to_string();
        let body = body.to_string();
        move || {
            if mac_notify::send_ask_main_thread(&id, &title, &body, &[]) {
                return;
            }
            // dev run (not bundled): plain notification, no buttons
            use tauri_plugin_notification::NotificationExt;
            let _ = app.notification().builder().title(&title).body(&body).show();
        }
    });
    if dispatched.is_err() {
        // main thread unavailable (headless) — plugin path only
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title(title).body(body).show();
    }
}
