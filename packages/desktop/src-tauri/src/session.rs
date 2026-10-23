//! Human session (ADR BR#2673, leg 3): the desktop UI authenticates the human
//! via GitHub OAuth — the worker's own /login flow with a desktop handshake —
//! and the `bridge_session` value lives HERE, in the app process
//! (~/.bridge/session.json, 0600). Every knowledge-plane call the UI makes
//! rides this cookie (actor `web`); the gateway bearer never appears on a UI
//! call path. Fail-closed: no session → every UI call errors with a
//! sign-in prompt, and a gateway token routed by mistake still bounces off
//! the hub's human-authoritative gates (decision acceptance 400s).

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The worker's session cookie (worker/src/index.js SESSION_COOKIE).
const SESSION_COOKIE: &str = "bridge_session";
/// How long the loopback listener waits for the OAuth round-trip.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// HTTP timeout for knowledge-plane calls.
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Session {
    /// Raw cookie value `<exp_ms>.<login>.<ws>.<hmac>` — opaque here, the hub
    /// verifies the HMAC on every call.
    pub value: String,
    /// Hub the session belongs to (login may precede pairing, so the session
    /// carries its own hub url).
    pub url: String,
    pub user: String,
    pub ws: String,
    /// Epoch ms.
    pub expires_ts: u64,
}

fn session_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".bridge").join("session.json")
}

/// Load the stored session, or None when absent/expired (expired files are
/// removed so the UI shows a clean sign-in gate).
pub fn load() -> Option<Session> {
    let raw = std::fs::read_to_string(session_path()).ok()?;
    let s: Session = serde_json::from_str(&raw).ok()?;
    if s.expires_ts <= now_ms() {
        clear();
        return None;
    }
    Some(s)
}

pub fn store(s: &Session) -> Result<(), String> {
    let path = session_path();
    let dir = path.parent().ok_or("no session dir")?.to_path_buf();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(s).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600)).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn clear() {
    let _ = std::fs::remove_file(session_path());
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Live probe: ask the hub who this session belongs to (`GET /api/session`).
/// Returns signed_in=false (and clears the file) when the hub rejects the
/// cookie; falls back to file validity when the hub is unreachable (offline
/// tolerance — the UI stays usable with cached reads).
pub fn probe() -> Value {
    match load() {
        None => json!({ "signed_in": false }),
        Some(s) => {
            match kb_request("GET", "/api/session", None) {
                Ok(v) => {
                    let user = v.get("user").and_then(|u| u.as_str()).unwrap_or("");
                    if user.is_empty() {
                        clear();
                        json!({ "signed_in": false })
                    } else {
                        json!({
                            "signed_in": true,
                            "user": user,
                            "ws": v.get("workspace").and_then(|w| w.as_str()).unwrap_or(s.ws.as_str()),
                            "expires_ts": v.get("expires_ts").and_then(|e| e.as_u64()).unwrap_or(s.expires_ts),
                            "url": s.url,
                        })
                    }
                }
                Err(e) if e.contains("network") => json!({
                    "signed_in": true, "user": s.user, "ws": s.ws,
                    "expires_ts": s.expires_ts, "url": s.url, "stale": true,
                }),
                Err(_) => json!({ "signed_in": false }),
            }
        }
    }
}

/// One desktop login: bind an ephemeral 127.0.0.1 listener, open the hub's
/// GitHub login (`?client=desktop&port=N`), accept the single redirect with
/// the minted session, store it. `open` runs the URL in the user's browser
/// (the opener plugin needs the Tauri handle — injected by the command).
/// Blocking; run via spawn_blocking.
pub fn login(hub_url: &str, open: &dyn Fn(String)) -> Result<Session, String> {
    let hub = hub_url.trim_end_matches('/');
    if hub.is_empty() {
        return Err("hub url required — set it in Settings or pass ?url".into());
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("loopback bind failed: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    open(format!("{hub}/login?client=desktop&port={port}"));

    listener
        .set_nonblocking(true)
        .map_err(|e| e.to_string())?;
    // accept loop: GitHub may preconnect before the real redirect — ignore
    // noise, take the first well-formed /callback, overall timeout 10 min
    let deadline = std::time::Instant::now() + LOGIN_TIMEOUT;
    loop {
        if std::time::Instant::now() >= deadline {
            return Err("login timed out — no callback within 10 min".into());
        }
        match listener.accept() {
            Ok((stream, _)) => {
                if let Some(session) = handle_callback(stream, hub) {
                    return Ok(session);
                }
                // not the callback (probe/noise) — keep waiting
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => return Err(format!("loopback accept failed: {e}")),
        }
    }
}

/// Read one request off the loopback stream; on a well-formed
/// `GET /callback?bridge_session=…` respond with a friendly page and return
/// the session. Anything else (favicon probes) gets a 404 and None.
fn handle_callback(mut stream: std::net::TcpStream, hub: &str) -> Option<Session> {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .ok();
    let mut reader = BufReader::new(&stream);
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return None;
    }
    // "GET /callback?bridge_session=<value> HTTP/1.1"
    let target = line.split_whitespace().nth(1)?.to_string();
    let path = target.split('?').next().unwrap_or("");
    if path != "/callback" {
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n");
        return None;
    }
    let value = target
        .split('?')
        .nth(1)?
        .split('&')
        .find_map(|kv| kv.strip_prefix("bridge_session="))?;
    let value = urldecode(value);
    // value = <exp>.<login>.<ws>.<hmac> — none of the middle parts contain dots
    let parts: Vec<&str> = value.split('.').collect();
    if parts.len() != 4 || !parts[0].chars().all(|c| c.is_ascii_digit()) {
        let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n");
        return None;
    }
    let session = Session {
        value: value.clone(),
        url: hub.to_string(),
        user: parts[1].to_string(),
        ws: parts[2].to_string(),
        expires_ts: parts[0].parse().ok()?,
    };
    if let Err(e) = store(&session) {
        eprintln!("[session] failed to persist session: {e}");
    }
    let body = format!(
        "<html><body style=\"font-family:-apple-system,sans-serif;background:#0b0e14;color:#e6e6e6;display:grid;place-items:center;height:100vh;margin:0\"><div style=\"text-align:center\"><h1>Signed in as {}</h1><p>Return to Bridge — this tab can be closed.</p></div></body></html>",
        html_escape(&session.user),
    );
    let _ = stream.write_all(
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\n\r\n{}",
            body.len(),
            body,
        )
        .as_bytes(),
    );
    Some(session)
}

/// One knowledge-plane call as the human session. Cookie header ONLY —
/// this module has no access to any gateway token by construction, which is
/// the point (ADR BR#2673: UI call paths cannot borrow the gateway).
pub fn kb_request(method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    if !path.starts_with("/api/kb/") && path != "/api/session" && path != "/logout" {
        return Err(format!("kb_request: non-knowledge path rejected: {path}"));
    }
    let s = load().ok_or_else(|| {
        "401 no session — sign in with GitHub first".to_string()
    })?;
    let client = reqwest::blocking::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("{}{}", s.url.trim_end_matches('/'), path);
    let mut req = client
        .request(reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?, &url)
        .header("Cookie", format!("{SESSION_COOKIE}={}", s.value));
    if let Some(b) = &body {
        req = req
            .header("content-type", "application/json")
            .body(serde_json::to_string(b).map_err(|e| e.to_string())?);
    }
    let resp = req.send().map_err(|e| format!("network: {e}"))?;
    let status = resp.status();
    let v: Value = resp.json().unwrap_or(Value::Null);
    if status.as_u16() == 401 {
        // session expired/revoked server-side — drop it so the next probe
        // reports signed-out (misconfig announces itself, fail-closed)
        clear();
        return Err(format!("401 session rejected by hub: {}", err_text(&v)));
    }
    if !status.is_success() {
        return Err(format!("hub {}: {}", status.as_u16(), err_text(&v)));
    }
    Ok(v)
}

fn err_text(v: &Value) -> String {
    v.get("error")
        .and_then(|e| e.as_str())
        .unwrap_or("")
        .to_string()
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Minimal percent-decoding for the session value (digits, dots, hyphens,
/// alphanumerics are the expected alphabet; %XX sequences are decoded).
fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| -> Option<u8> {
                match b {
                    b'0'..=b'9' => Some(b - b'0'),
                    b'a'..=b'f' => Some(b - b'a' + 10),
                    b'A'..=b'F' => Some(b - b'A' + 10),
                    _ => None,
                }
            };
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
            out.push(bytes[i]);
            i += 1;
        } else if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Percent-encode a query-parameter value (everything outside the RFC 3986
/// unreserved set).
pub fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod live_probe {
    #[test]
    #[ignore = "live hub + stored session — diagnostics only; run explicitly with --ignored when debugging connectivity"]
    fn events_and_board_via_session() {
        // live probe (uses the real stored session) — diagnostics for the
        // "hub unreachable" report; not part of the suite's assertions
        let r = super::kb_request("GET", "/api/kb/events?since=0&limit=5", None);
        match &r {
            Ok(v) => println!("events OK: {}", serde_json::to_string(v).unwrap_or_default().chars().take(120).collect::<String>()),
            Err(e) => println!("events ERR: {e}"),
        }
        let b = super::kb_request("GET", "/api/kb/board", None);
        match &b {
            Ok(v) => println!("board OK: tasks={:?}", v.get("tasks").and_then(|t| t.as_array()).map(|a| a.len())),
            Err(e) => println!("board ERR: {e}"),
        }
        assert!(r.is_ok() && b.is_ok());
    }
}
