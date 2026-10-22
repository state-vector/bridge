//! Desktop WS bridge — one bearer-authenticated WebSocket to the hub's KB
//! event stream, re-emitted into the webview as Tauri events.
//!
//! The webview cannot set WS headers (browser limitation), so the Rust side
//! holds the socket: `wss://{hub}/kb-ws?since=<seq>` with
//! `Authorization: Bearer <gateway-token>`. Every frame forwards to the UI
//! via `app.emit("kb-event", text)`; the React adapter merges by seq cursor.
//! Reconnect: exponential backoff 1s→30s, resuming from the last seen seq.

use std::io::Read;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

static LAST_SEQ: AtomicI64 = AtomicI64::new(0);

fn ws_url(hub_url: &str, since: i64) -> String {
    let ws = hub_url
        .trim_end_matches('/')
        .replacen("http", "ws", 1);
    format!("{}/kb-ws?since={}", ws, since)
}

pub fn start(app: tauri::AppHandle, hub_url: String, token: String) {
    std::thread::spawn(move || {
        let mut backoff_secs = 1u64;
        loop {
            if token.is_empty() {
                std::thread::sleep(Duration::from_secs(5));
                continue;
            }
            let since = LAST_SEQ.load(Ordering::Relaxed);
            let url = ws_url(&hub_url, since);
            // ClientRequestBuilder auto-adds the WS handshake headers
            // (sec-websocket-key etc.) that a raw Request would lack.
            let req = tungstenite::client::ClientRequestBuilder::new(
                url.parse().expect("hub url parses as ws uri"),
            )
            .with_header("Authorization", format!("Bearer {token}"));
            match tungstenite::connect(req) {
                Ok((mut socket, _)) => {
                    backoff_secs = 1;
                    eprintln!("[ws-bridge] connected — {url}");
                    loop {
                        match socket.read() {
                            Ok(tungstenite::Message::Text(txt)) => {
                                // track the newest event seq for reconnect resume
                                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                                    if let Some(events) = v.pointer("/events") {
                                        if let Some(arr) = events.as_array() {
                                            if let Some(last) = arr.last().and_then(|e| e.get("seq")).and_then(|s| s.as_i64()) {
                                                LAST_SEQ.store(last, Ordering::Relaxed);
                                            }
                                        }
                                    }
                                }
                                let _ = app.emit("kb-event", txt.as_str());
                            }
                            Ok(tungstenite::Message::Ping(p)) => {
                                let _ = socket.send(tungstenite::Message::Pong(p));
                            }
                            Ok(tungstenite::Message::Close(_)) | Err(tungstenite::Error::ConnectionClosed) => {
                                eprintln!("[ws-bridge] connection closed — reconnecting");
                                break;
                            }
                            Ok(_) => {} // binary/pong frames — ignore
                            Err(e) => {
                                eprintln!("[ws-bridge] read error: {e} — reconnecting");
                                break;
                            }
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[ws-bridge] connect failed: {e} — retrying in {backoff_secs}s");
                }
            }
            std::thread::sleep(Duration::from_secs(backoff_secs));
            backoff_secs = (backoff_secs * 2).min(30);
        }
    });
}
