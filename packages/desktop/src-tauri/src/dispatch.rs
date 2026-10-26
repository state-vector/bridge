//! Dispatch loop — polls bridge for claimable work, dispatches it to opencode,
//! and reports status back through the same protocol (orient / transition /
//! log_progress). Runs identically in menu-bar and headless mode.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::TryRecvError;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::opencode;
use crate::scm;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DispatchConfig {
    /// Serialized shape version — written by store::save_config (the one
    /// writer), checked on load; files from the future warn loudly.
    #[serde(default = "default_schema_version")]
    pub schema_version: u64,
    pub url: String,
    /// The gateway secret lives in the OS keychain (crate::keychain) — this
    /// field is runtime-only and never serialized: config.json stays
    /// secret-free, and the UI's config round-trip can never carry the token
    /// (the UI's Apply path re-reads the keychain instead). Deserializing a
    /// legacy config that still has a "token" is the one-time migration
    /// trigger (resolve() moves it to the keychain and clears it).
    #[serde(default, skip_serializing)]
    pub token: String,
    #[serde(default = "default_workdir")]
    pub workdir: String,
    #[serde(default)]
    pub agent: Option<String>, // opencode agent name (role prompt), optional
    #[serde(default)]
    pub model: Option<String>, // agent model override; unset = the agent CLI's own config decides
    #[serde(default)]
    pub backend: Option<String>, // "opencode" (default) | "kiro" — which agent CLI drives the tasks
    #[serde(default = "default_poll_secs")]
    pub poll_secs: u64,
    #[serde(default = "default_timeout_mins")]
    pub timeout_mins: u64,
    #[serde(default = "default_opencode_bin")]
    pub opencode_bin: String,
    #[serde(default)]
    pub label: Option<String>, // agent identity from pairing
    #[serde(default)]
    pub agent_name: Option<String>, // name dispatched tasks are attributed to (override for the <hostname>-<backend> autogen)
    #[serde(default)]
    pub ws: Option<String>, // workspace slug from pairing
    #[serde(default)]
    pub gateway: Option<bool>, // Some(true): paired as gateway-class — set by pairing from the vended tags (the secret is opaque; class is a trait)
    #[serde(default = "default_max_sessions")]
    pub max_sessions: usize, // WIP limit for this node
    #[serde(default)]
    pub report_minutes: Option<u64>, // Some(n): periodic heartbeat cadence for agents; None: report like a human (meaningful steps only)
    #[serde(default = "default_isolate")] // BR#3204: enforced by default — a config
    // file that omits the key used to load as `false` (plain bool default),
    // silently dispatching into the shared checkout. Explicit `isolate: false`
    // still opts out knowingly.
    pub isolate: bool, // per-task git worktrees + PR branch
    /// Repos (URLs or owner/name refs) where per-task worktrees are skipped —
    /// BR#3204: the webapp-only checkout class, where the checkout itself is
    /// the deploy surface and shared-tree editing is the design. Matched
    /// case-insensitively against the tail of the repo URL.
    #[serde(default)]
    pub worktree_exempt_repos: Vec<String>,
    /// Enabled backends, keyed by provider name. Each section carries that
    /// provider's own config — model, agent profile, CLI binary override.
    /// A dict, not an array: providers differ (opencode has its own default
    /// model config; kiro is profile-driven), so per-provider settings belong
    /// to the provider. Legacy configs (backends as an array + flat
    /// models/agents maps) are accepted and folded in on load.
    #[serde(default, deserialize_with = "backends_de")]
    pub backends: std::collections::BTreeMap<String, BackendConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<std::collections::HashMap<String, String>>, // legacy: folded into backends on load
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents: Option<std::collections::HashMap<String, String>>, // legacy: folded into backends on load
    /// Git commit/signing identity for dispatched sessions (BR#3185).
    /// Omitted = the built-in `worker` class (builtin_worker_identity).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<IdentityProfile>,
}

/// Per-provider settings. Everything optional — a provider section can be
/// empty ({}) and the runner just uses that CLI's own defaults.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BackendConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bin: Option<String>,   // CLI binary override (default: "opencode" / "kiro")
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>, // agent profile for this provider
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>, // model override; unset = the CLI's own default config decides
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>, // transport: "acp" (default for opencode) | "stdio"
}

/// Accepts the new dict shape ({ "opencode": { ... } }) or the legacy array
/// shape (["opencode", "kiro"]) — legacy entries get empty sections and are
/// folded with the flat models/agents maps in normalize().
fn backends_de<'de, D>(de: D) -> Result<std::collections::BTreeMap<String, BackendConfig>, D::Error>
where D: serde::Deserializer<'de> {
    let v = serde_json::Value::deserialize(de)?;
    match v {
        serde_json::Value::Null => Ok(Default::default()),
        serde_json::Value::Array(a) => {
            let mut m = std::collections::BTreeMap::new();
            for item in a {
                if let Some(name) = item.as_str() {
                    m.insert(name.to_string(), BackendConfig::default());
                }
            }
            Ok(m)
        }
        serde_json::Value::Object(o) => {
            let mut m = std::collections::BTreeMap::new();
            for (name, section) in o {
                let cfg = serde_json::from_value(section).unwrap_or_default();
                m.insert(name, cfg);
            }
            Ok(m)
        }
        other => Err(serde::de::Error::custom(format!(
            "backends must be a dict of provider sections or an array of names, got: {other}"
        ))),
    }
}

/// Git commit/signing identity for dispatched sessions (BR#3185). A
/// first-class property of the runner config instead of ad-hoc `-c`
/// overrides typed per session (the BR#3181 canonical invocation, made
/// enforced). Serialized keys are camelCase per the recorded contract
/// (packages/contracts/fixtures/identity-profiles.json); snake_case forms
/// are accepted as aliases so hand-written configs of either shape load.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IdentityProfile {
    pub name: String,
    pub email: String,
    #[serde(rename = "signingKeyPath", alias = "signing_key_path")]
    pub signing_key_path: String,
    #[serde(
        rename = "signingProgram",
        alias = "signing_program",
        default = "default_signing_program"
    )]
    pub signing_program: String,
}

fn default_signing_program() -> String {
    "/usr/bin/ssh-keygen".into()
}

impl IdentityProfile {
    /// The repo-local git config keys/values this profile writes at
    /// worktree provisioning. Never touches global config: the shared
    /// checkout (and the host's own commits) stay exactly as they were.
    pub fn git_config(&self) -> [(&'static str, String); 6] {
        [
            ("user.name", self.name.clone()),
            ("user.email", self.email.clone()),
            ("user.signingkey", self.signing_key_path.clone()),
            ("gpg.format", "ssh".into()),
            ("gpg.ssh.program", self.signing_program.clone()),
            ("commit.gpgsign", "true".into()),
        ]
    }
}

/// Built-in `worker` identity class (BR#3181 ruling, accepted): runner-
/// dispatched agent sessions commit as detached-cody, signed with the
/// sv-agents-signing key directly from file via plain ssh-keygen — no
/// 1Password in the loop. Ray's personal signing path is never touched.
/// Values mirror packages/contracts/fixtures/identity-profiles.json; the
/// `builtin_worker_identity_matches_contract` test fails when they drift.
pub fn builtin_worker_identity() -> IdentityProfile {
    let home = std::env::var("HOME").unwrap_or_default();
    IdentityProfile {
        name: "detached-cody".into(),
        email: "297316395+detached-cody@users.noreply.github.com".into(),
        signing_key_path: format!("{home}/.ssh/sv-agents-signing.pub"),
        signing_program: default_signing_program(),
    }
}

impl DispatchConfig {
    /// The git identity in force for this runner's dispatched sessions
    /// (BR#3185). Precedence: an explicit `identity` config block (agent
    /// config) wins; otherwise the built-in `worker` class applies — every
    /// session the runner dispatches is a worker-class agent session (its
    /// board attribution is the per-agent token provisioned under the
    /// gateway; BR#2455's gateway/worker tag law is orthogonal to the git
    /// committer identity). The profile is applied repo-locally in each
    /// provisioned worktree — global git config is never written, so a
    /// shared checkout keeps its own identity.
    pub fn identity_profile(&self) -> IdentityProfile {
        self.identity.clone().unwrap_or_else(builtin_worker_identity)
    }

    /// Fold legacy flat fields (backends array + models/agents maps) into the
    /// backends dict. Idempotent; called from every load/resolve path.
    pub fn normalize(&mut self) {
        if self.backends.is_empty() {
            if let Some(list) = self
                .backend
                .clone()
                .map(|b| vec![b])
                .or_else(|| Some(vec!["opencode".to_string()]))
            {
                for name in list {
                    self.backends.entry(name).or_default();
                }
            }
        }
        let mut fold = |map: &Option<std::collections::HashMap<String, String>>,
                        take: fn(&mut BackendConfig, String)| {
            if let Some(m) = map {
                for (k, v) in m {
                    if v.trim().is_empty() { continue; }
                    let e = self.backends.entry(k.clone()).or_default();
                    take(e, v.clone());
                }
            }
        };
        let models = self.models.clone();
        let agents = self.agents.clone();
        fold(&models, |e, v| e.model = Some(v));
        fold(&agents, |e, v| e.agent = Some(v));
    }

}

pub fn default_schema_version() -> u64 {
    crate::store::CONFIG_SCHEMA_VERSION
}
fn default_max_sessions() -> usize {
    1
}
fn default_isolate() -> bool {
    true
}

fn default_workdir() -> String {
    // scratch space for cloned task repos + worktrees — NOT a repo itself.
    // Tasks reference their git repository; the runner clones on demand.
    let home = std::env::var("HOME").unwrap_or_default();
    if home.is_empty() {
        return std::env::current_dir()
            .map(|d| d.to_string_lossy().into_owned())
            .unwrap_or_default();
    }
    PathBuf::from(home).join("bridge-work").to_string_lossy().into_owned()
}
fn default_poll_secs() -> u64 {
    60
}
fn default_timeout_mins() -> u64 {
    30
}
fn default_opencode_bin() -> String {
    "opencode".into()
}

impl DispatchConfig {
    /// Env fallbacks so headless mode needs no config file:
    /// BRIDGE_URL, BRIDGE_WORKDIR, BRIDGE_AGENT, BRIDGE_POLL_SECS.
    /// (BRIDGE_TOKEN is gone — a pasted token was the manually-paired
    /// fallback the credential-class ADR retires; headless onboards via
    /// `bridge pair` or, on the desktop, via login-time self-provision.
    /// The token always comes from the keychain.)
    pub fn from_env() -> Option<Self> {
        let url = std::env::var("BRIDGE_URL").ok()?;
        let token = String::new();
        Some(Self {
            schema_version: default_schema_version(),
            url: url.trim_end_matches('/').into(),
            token,
            workdir: std::env::var("BRIDGE_WORKDIR").unwrap_or_else(|_| default_workdir()),
            agent: std::env::var("BRIDGE_AGENT").ok(),
            model: std::env::var("BRIDGE_MODEL").ok(),
            backend: std::env::var("BRIDGE_BACKEND").ok(),
            poll_secs: std::env::var("BRIDGE_POLL_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or_else(default_poll_secs),
            timeout_mins: std::env::var("OPENCODE_TIMEOUT_MINS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or_else(default_timeout_mins),
            opencode_bin: std::env::var("OPENCODE_BIN").unwrap_or_else(|_| default_opencode_bin()),
            max_sessions: std::env::var("BRIDGE_MAX_SESSIONS")
                .ok()
                .and_then(|v| v.parse().ok())
                .filter(|&n| n > 0)
                .unwrap_or_else(default_max_sessions),
            report_minutes: std::env::var("BRIDGE_REPORT_MINUTES")
                .ok()
                .and_then(|v| v.parse().ok())
                .filter(|&n| (1..=60).contains(&n)),
            isolate: !matches!(
                std::env::var("BRIDGE_ISOLATE").as_deref(),
                Ok("0") | Ok("false") | Ok("no")
            ),
            worktree_exempt_repos: std::env::var("BRIDGE_WORKTREE_EXEMPT_REPOS")
                .unwrap_or_default()
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            backends: std::env::var("BRIDGE_BACKENDS")
                .ok()
                .map(|v| {
                    v.split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .map(|name| (name, BackendConfig::default()))
                        .collect::<std::collections::BTreeMap<_, _>>()
                })
                .unwrap_or_default(),
            models: std::env::var("BRIDGE_MODEL")
                .ok()
                .map(|m| std::collections::HashMap::from([("opencode".to_string(), m)])),
            agents: None,
            label: None,
            agent_name: None,
            ws: None,
            gateway: None,
            identity: None,
        })
    }

    /// Stable session name for this runner — every MCP call carries it so the
    /// hub's session registry (and the board's online dots) stay fresh.
    pub fn session_name(&self) -> String {
        let slug = |s: &str| -> String {
            s.chars().filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_').collect()
        };
        format!("dispatch-{}", slug(self.label.as_deref().unwrap_or("runner")))
    }

    /// Resolution order: env vars > ~/.bridge/config.json > None (→ device pairing).
    /// The token is NEVER taken from either — keychain only, via the store
    /// (which also migrates any legacy on-disk plaintext once).
    pub fn resolve() -> Option<Self> {
        let mut c = Self::from_env().or_else(load_config)?;
        c.normalize();
        crate::store::TokenStore::open().attach_token(&mut c);
        Some(c)
    }

    /// One writer for config.json (BR#2840): full versioned struct, atomic
    /// temp+rename, 0600 — see store.rs. Every caller funnels through here.
    pub fn save(&self) -> Result<(), String> {
        crate::store::TokenStore::open().save_config(self)
    }
}

/// The machine's stable principal: write-once, `~/.bridge/principal` —
/// read via the store (which migrates a legacy config.json field once).
/// Short by design — it is a handle, not a secret (the secret is the
/// bkw_ token). Survives re-pairings, rotations, renames.
pub fn ensure_principal_from_file() -> String {
    crate::store::TokenStore::open().principal()
}

/// Persist the hub-vended device credential — the store decides where it
/// lives (one file, 0600); rotation rewrites exactly that one place.
fn store_principal(p: &str) {
    crate::store::TokenStore::open().adopt_principal(p);
}

fn load_config() -> Option<DispatchConfig> {
    crate::store::TokenStore::open().load_config()
}

/// Device pairing (bridge-native github-like device flow): request a code, the
/// human approves it at {url}/pair, poll until the token arrives. The token is
/// shown once on this device — the approver never sees it.
/// Device-flow pairing, shared by the desktop app and the CLI's onboarding:
/// prints a code, polls until the human approves, returns the half-filled config.
pub fn pair_device(url: &str) -> Result<DispatchConfig, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let code = pair_start(&client, url, host_slug().as_str(), ensure_principal_from_file().as_str())?;
    eprintln!("[pair] open {url}/pair and enter code {code}");
    println!("[pair] open {url}/pair and enter code {code}");

    let deadline = std::time::Instant::now() + Duration::from_secs(15 * 60);
    loop {
        if std::time::Instant::now() >= deadline {
            return Err("pairing timed out — run again to get a fresh code".into());
        }
        std::thread::sleep(Duration::from_secs(3));
        match pair_poll(&client, url, &code)? {
            PairPoll::Pending => continue,
            PairPoll::SlowDown => {
                std::thread::sleep(Duration::from_secs(3));
                continue;
            }
            PairPoll::Authorized(cfg) => {
                eprintln!("[pair] authorized — token saved");
                return Ok(cfg);
            }
            PairPoll::Expired => return Err("pairing code expired — run again".into()),
            PairPoll::Failed(other) => return Err(format!("pairing failed: {other}")),
        }
    }
}

/// Hostname slug — the LABEL source for the gateway token (BR#899 identity
/// convention; Ray: gateway-ness is a tag, not a name prefix). Display only:
/// identity is anchored by the stored device credential (`principal`, the
/// hub-vended, generate-once-never-change secret — BR#2711 §2), never by the
/// hostname and never by an IOPlatformUUID (withdrawn).
pub fn host_slug() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "device".into())
}

/// First half of the device flow: register this device, get the enter-code.
/// This app IS a gateway — the pairing declares that class; the hub vends a
/// gateway-class token on approval. The approver never chooses. The stable
/// device credential (principal) lets the hub re-associate re-pairings
/// (rotate, not collide).
pub fn pair_start(client: &reqwest::blocking::Client, url: &str, host: &str, principal: &str) -> Result<String, String> {
    let start: serde_json::Value = client
        .post(format!("{url}/api/pair/start"))
        .header("content-type", "application/json")
        .body(json!({ "host": host, "type": "gateway", "principal": principal }).to_string())
        .send()
        .map_err(|e| format!("bridge unreachable: {e}"))?
        .json()
        .map_err(|e| e.to_string())?;
    start
        .get("code")
        .and_then(|c| c.as_str())
        .map(String::from)
        .ok_or_else(|| "pair start failed".into())
}

/// One pairing poll. Authorized merges the vended token into the EXISTING
/// config (settings survive a logout → pair cycle) and saves it.
pub fn pair_poll(client: &reqwest::blocking::Client, url: &str, code: &str) -> Result<PairPoll, String> {
    let resp: serde_json::Value = client
        .post(format!("{url}/api/pair/poll"))
        .header("content-type", "application/json")
        .body(json!({ "code": code }).to_string())
        .send()
        .map_err(|e| format!("poll failed: {e}"))?
        .json()
        .map_err(|e| e.to_string())?;
    match resp.get("status").and_then(|s| s.as_str()) {
        Some("pending") => Ok(PairPoll::Pending),
        Some("slow_down") => Ok(PairPoll::SlowDown),
        Some("authorized") => {
            let token = resp
                .get("token")
                .and_then(|t| t.as_str())
                .ok_or("authorized but no token")?
                .to_string();
            let ws = resp
                .get("ws")
                .and_then(|w| w.as_str())
                .unwrap_or("state-vector")
                .to_string();
            let label = resp
                .get("label")
                .and_then(|l| l.as_str())
                .map(|s| s.to_string());
            // merge into the existing config so user settings survive;
            // fresh defaults only when there is nothing to merge with
            let mut cfg = load_config().unwrap_or_else(default_config);
            let gateway_class = resp
                .get("tags")
                .and_then(|t| t.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str()).any(|s| s.eq_ignore_ascii_case("gateway")))
                .unwrap_or(false);
            apply_vended_credentials(&mut cfg, url, &token, &ws, label, gateway_class)?;
            // BR#3787 — fresh pairing: full re-adopt of the epoch from the
            // next response header (the vend response may not carry it).
            TOKEN_EPOCH_SEEN.store(0, Ordering::Relaxed);
            TOKEN_EPOCH_VEND.store(0, Ordering::Relaxed);
            eprintln!("[pair] authorized — token for workspace '{}' saved to the keychain (settings preserved)", cfg.ws.as_deref().unwrap_or("?"));
            Ok(PairPoll::Authorized(cfg))
        }
        Some("expired") => Ok(PairPoll::Expired),
        Some(other) => Ok(PairPoll::Failed(other.to_string())),
        None => Ok(PairPoll::Failed("no status in poll response".into())),
    }
}

pub enum PairPoll {
    Pending,
    SlowDown,
    Authorized(DispatchConfig),
    Expired,
    Failed(String),
}

/// Fresh defaults for a device with no config yet (paired fresh / first
/// self-provision). User settings always merge over this.
pub fn default_config() -> DispatchConfig {
    DispatchConfig {
        schema_version: default_schema_version(),
        url: String::new(),
        token: String::new(),
        workdir: default_workdir(),
        agent: std::env::var("BRIDGE_AGENT").ok(),
        model: std::env::var("BRIDGE_MODEL").ok(),
        backend: std::env::var("BRIDGE_BACKEND").ok(),
        poll_secs: default_poll_secs(),
        timeout_mins: default_timeout_mins(),
        opencode_bin: default_opencode_bin(),
        label: None,
        agent_name: None,
        ws: None,
        gateway: None,
        max_sessions: default_max_sessions(),
        report_minutes: None,
        isolate: default_isolate(),
        worktree_exempt_repos: Vec::new(),
        backends: Default::default(),
        models: None,
        agents: None,
        identity: None,
    }
}

/// Merge vended gateway credentials (pairing approval or login-time
/// self-provision — the only two human-approved paths to a token). The
/// secret goes to the OS keychain ONLY; the config keeps identity +
/// settings and stays secret-free.
fn apply_vended_credentials(
    cfg: &mut DispatchConfig,
    url: &str,
    token: &str,
    ws: &str,
    label: Option<String>,
    gateway_class: bool,
) -> Result<(), String> {
    let store = crate::store::TokenStore::open();
    cfg.url = url.trim_end_matches('/').to_string();
    // Rotate = persistent store AND in-memory token move together (one
    // call, no stale window; empty vends are refused — that is how
    // credentials used to vanish). The field is skip_serializing, so
    // config.json stays secret-free; later resolves reload from the store.
    store.rotate(cfg, token)?;
    cfg.ws = Some(ws.to_string());
    cfg.label = label;
    cfg.gateway = Some(gateway_class);
    cfg.normalize();
    cfg.save()
}

/// Gateway self-provision (credential-class ADR, desktop gateway leg): the
/// desktop's post-login leg. The human-auth leg hands over the hub session
/// cookie after GitHub login; this exchanges it for THIS device's
/// gateway-class token via POST /api/kb/self-provision. The login IS the
/// human approval — hub-side the audit stamps op `self_provision` with the
/// web-session actor. The secret goes straight to the OS keychain: it never
/// touches the webview, the UI, or any log (only the workspace lands in the
/// log line). Deterministic label + replace-by-principal mean re-vending at
/// every login rotates in place — same label, stable gateway_agents edges.
pub fn self_provision(
    client: &reqwest::blocking::Client,
    url: &str,
    session_cookie: &str,
) -> Result<DispatchConfig, String> {
    let cookie = session_cookie.trim();
    if cookie.is_empty() {
        return Err("no web session — sign in first (the login is what authorizes the gateway)".into());
    }
    let resp = client
        .post(format!("{url}/api/kb/self-provision"))
        .header("content-type", "application/json")
        .header("cookie", format!("bridge_session={cookie}"))
        .body(
            json!({
                // principal = the device credential (hub-vended, generate-once-
                // never-change; empty on first provision — the hub mints it);
                // host = display label source (BR#899 identity convention)
                "principal": ensure_principal_from_file(),
                "host": host_slug(),
            })
            .to_string(),
        )
        .send()
        .map_err(|e| format!("bridge unreachable: {e}"))?;
    // read the body as text first so a non-JSON response (Cloudflare error
    // page, HTML redirect, plain-text 500) is NAMED in the error instead of
    // the useless reqwest "error decoding response body"
    let body_text = resp.text().map_err(|e| format!("read body: {e}"))?;
    let resp: serde_json::Value = serde_json::from_str(&body_text).map_err(|e| {
        format!(
            "hub returned non-JSON for self-provision: {e} — body: {}",
            body_text.chars().take(200).collect::<String>()
        )
    })?;
    let err = || {
        format!(
            "self-provision failed: {}",
            resp.get("error").and_then(|e| e.as_str()).unwrap_or("no secret in response")
        )
    };
    let secret = resp.get("secret").and_then(|s| s.as_str()).filter(|s| !s.is_empty()).ok_or_else(err)?;
    let ws = resp.get("ws").and_then(|w| w.as_str()).filter(|w| !w.is_empty()).unwrap_or("state-vector");
    let label = resp.get("label").and_then(|l| l.as_str()).map(|s| s.to_string());
    // adopt the hub-vended device credential on first provision — stored
    // once, presented on every later provision, never regenerated (ONE
    // random generation approach)
    if let Some(p) = resp.get("principal").and_then(|p| p.as_str()).filter(|s| !s.is_empty()) {
        if p != ensure_principal_from_file() {
            store_principal(p);
            eprintln!("[dispatch] device credential vended by the hub and stored");
        }
    }
    let mut cfg = load_config().unwrap_or_else(default_config);
    apply_vended_credentials(&mut cfg, url, secret, ws, label, true)?;
    eprintln!(
        "[dispatch] gateway self-provisioned for workspace '{}' — token in the OS keychain",
        cfg.ws.as_deref().unwrap_or("?")
    );
    // BR#3787 — full re-adopt: the next response's epoch header becomes the
    // vend epoch (avoids repairing against a stale observed epoch).
    TOKEN_EPOCH_SEEN.store(0, Ordering::Relaxed);
    TOKEN_EPOCH_VEND.store(0, Ordering::Relaxed);
    Ok(cfg)
}

/// BR#3787 layer 2 — agent-plane repair: re-vend THIS device's row using the
/// durable principal. No human plane, no session cookie — headless gateways
/// self-heal (hermes-class boxes never could). The hub matches by principal
/// ONLY (never label — the theft class) and rate-limits per row; the
/// response's secret becomes our credential and its epoch the vend epoch.
fn repair_by_principal(
    client: &reqwest::blocking::Client,
    url: &str,
) -> Result<DispatchConfig, String> {
    let principal = ensure_principal_from_file();
    if principal.is_empty() {
        return Err("no device principal on file — re-pair required".into());
    }
    let resp = client
        .post(format!("{url}/api/token/repair"))
        .header("content-type", "application/json")
        .body(json!({ "principal": principal, "host": host_slug() }).to_string())
        .send()
        .map_err(|e| format!("bridge unreachable: {e}"))?;
    // read the body as text first so a non-JSON response (Cloudflare error
    // page, HTML redirect, plain-text 500) is NAMED in the error
    let body_text = resp.text().map_err(|e| format!("read body: {e}"))?;
    let parsed: serde_json::Value = serde_json::from_str(&body_text).map_err(|e| {
        format!(
            "hub returned non-JSON for token repair: {e} — body: {}",
            body_text.chars().take(200).collect::<String>()
        )
    })?;
    let err = || {
        format!(
            "token repair failed: {}",
            parsed.get("error").and_then(|e| e.as_str()).unwrap_or("no secret in response")
        )
    };
    let secret = parsed.get("secret").and_then(|s| s.as_str()).filter(|s| !s.is_empty()).ok_or_else(err)?;
    let ws = parsed.get("ws").and_then(|w| w.as_str()).filter(|w| !w.is_empty()).unwrap_or("state-vector").to_string();
    let label = parsed.get("label").and_then(|l| l.as_str()).map(|s| s.to_string());
    if let Some(ep) = parsed.get("epoch").and_then(|e| e.as_u64()) {
        TOKEN_EPOCH_VEND.store(ep, Ordering::Relaxed);
    } else {
        TOKEN_EPOCH_VEND.store(0, Ordering::Relaxed);
    }
    TOKEN_EPOCH_SEEN.store(0, Ordering::Relaxed);
    let mut cfg = load_config().unwrap_or_else(default_config);
    apply_vended_credentials(&mut cfg, url, secret, &ws, label, true)?;
    Ok(cfg)
}

/// Resolve the config and require a vendored token. The machine-plane board
/// endpoints currently answer empty-token requests, so an unpaired desktop
/// would keep rendering board data after logout — refuse client-side instead.
fn paired_config() -> Result<DispatchConfig, String> {
    let cfg = DispatchConfig::resolve().ok_or("not configured — pair first")?;
    if cfg.token.is_empty() {
        return Err("logged out — pair first".into());
    }
    Ok(cfg)
}

/// One rediscoverable opencode session: its id plus the `updated` stamp the
/// CLI reports (ms epoch). `updated` refreshes while the session streams —
/// a stale stamp means the session process is gone. That is the runner-side
/// liveness signal for the BR#3337 stale-claim check (the hub-side signal is
/// the card's session_alive_ts / last_progress heartbeat).
#[derive(Debug, Clone)]
struct SessionEntry {
    id: String,
    updated_ms: Option<u64>,
}

/// Snapshot of resumable opencode sessions: title → entry. Dispatched runs
/// are titled `bridge-<task_id>`, so sessions are rediscoverable across
/// runner/app restarts — one `session list` per tick serves every lookup.
fn session_map(bin: &str, workdir: &str) -> HashMap<String, SessionEntry> {
    let mut map = HashMap::new();
    let Some(out) = Command::new(bin)
        .arg("session")
        .arg("list")
        .arg("--format")
        .arg("json")
        .current_dir(workdir)
        .output()
        .ok()
    else {
        return map;
    };
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else {
        return map;
    };
    let items = match v {
        serde_json::Value::Array(a) => a,
        serde_json::Value::Object(o) => match o.get("sessions").and_then(|s| s.as_array()) {
            Some(a) => a.clone(),
            None => return map,
        },
        _ => return map,
    };
    for item in items {
        let title = item.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string();
        if let Some(id) = item
            .get("id")
            .or_else(|| item.get("sessionID"))
            .and_then(|i| i.as_str())
        {
            map.insert(
                title,
                SessionEntry {
                    id: id.to_string(),
                    updated_ms: item.get("updated").and_then(|u| u.as_u64()),
                },
            );
        }
    }
    map
}

/// Find the opencode session entry for a dispatched task: exact
/// `bridge-<task_id>` title first, then the fuzzy contains-match the resume
/// path has always used.
fn find_session<'a>(
    sessions: &'a HashMap<String, SessionEntry>,
    task_id: &str,
) -> Option<&'a SessionEntry> {
    let want_title = format!("bridge-{task_id}");
    sessions.get(&want_title).or_else(|| {
        sessions
            .iter()
            .find(|(title, _)| title.contains(&want_title))
            .map(|(_, e)| e)
    })
}

// ---- bridge MCP client (JSON-RPC over POST /mcp) ----

/// BR#2844: the orient response contract — the 14 keys every runner and
/// session may rely on. Single source: packages/contracts/src/orient.ts,
/// pinned to the recorded production fixture (packages/contracts/fixtures/
/// orient.json) by the drift-alarm test at the bottom of this file. A
/// renamed or missing key here used to zero the runner's work lists
/// silently; the gate below fails the tick loudly and names the drift.
const ORIENT_REQUIRED_KEYS: [&str; 14] = [
    "board",
    "build",
    "counts",
    "gauge_debt",
    "instructions",
    "my_roles",
    "my_score",
    "my_tasks",
    "open_artefacts",
    "pending_asks",
    "project",
    "steering",
    "unclaimed_work",
    "you",
];

fn orient_expected_kind(key: &str) -> &'static str {
    match key {
        "board" | "my_score" | "you" => "object",
        "project" | "instructions" | "build" => "string",
        _ => "array",
    }
}

/// The runner-side half of the orient contract: every required key present,
/// every key the runner relies on the right kind. Extra keys (the guidance
/// `note`, future additions) are tolerated — the contract is the required
/// core, and breaching it is a loud tick error, never a silent zero.
fn orient_contract_error(orient: &serde_json::Value) -> Result<(), String> {
    let obj = match orient.as_object() {
        Some(o) => o,
        None => {
            return Err(format!(
                "orient response is not an object (got {}) — hub contract drift (BR#2844, packages/contracts)",
                if orient.is_null() { "null" } else if orient.is_array() { "array" } else { "scalar" }
            ))
        }
    };
    let mut problems: Vec<String> = Vec::new();
    for key in ORIENT_REQUIRED_KEYS {
        match obj.get(key) {
            None => problems.push(format!("missing `{key}`")),
            Some(v) => {
                let ok = match orient_expected_kind(key) {
                    "object" => v.is_object(),
                    "string" => v.is_string(),
                    _ => v.is_array(),
                };
                if !ok {
                    problems.push(format!(
                        "`{key}` should be an {kind} but is {kind_got}",
                        kind = orient_expected_kind(key),
                        kind_got = if v.is_null() {
                            "null".to_string()
                        } else if v.is_string() {
                            "a string".to_string()
                        } else if v.is_array() {
                            "an array".to_string()
                        } else {
                            "an object".to_string()
                        },
                    ));
                }
            }
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "orient response violates the contract (BR#2844, packages/contracts): {} — update packages/contracts + the fixture and redeploy the hub",
            problems.join("; ")
        ))
    }
}

fn mcp_call(
    cfg: &DispatchConfig,
    id: &mut i64,
    tool: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    mcp_call_session(cfg, id, tool, args, None)
}

/// MCP call with an explicit session name. Task-scoped calls use
/// `dispatch-<task_id>`: every opencode dispatch IS a fresh agent session, and
/// per-task attribution is what lets separation-of-duties pass honestly — the
/// session that implemented a task is never the session that verifies it.
fn mcp_call_session(
    cfg: &DispatchConfig,
    id: &mut i64,
    tool: &str,
    mut args: serde_json::Value,
    session: Option<&str>,
) -> Result<serde_json::Value, String> {
    *id += 1;
    if let Some(obj) = args.as_object_mut() {
        let name = session.map(String::from).unwrap_or_else(|| cfg.session_name());
        obj.entry("session").or_insert_with(|| json!(name));
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{}/mcp", cfg.url))
        .header("Authorization", format!("Bearer {}", cfg.token))
        .header("content-type", "application/json")
        .body(
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "tools/call",
                "params": { "name": tool, "arguments": args }
            })
            .to_string(),
        )
        .send()
        .map_err(|e| format!("bridge unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("bridge {} on /mcp", resp.status()));
    }
    // BR#3787 — the epoch rides every authenticated response; capture it
    // before the body is consumed.
    if let Some(v) = resp
        .headers()
        .get("x-bridge-token-epoch")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
    {
        TOKEN_EPOCH_SEEN.store(v, Ordering::Relaxed);
    }
    let body: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
    if let Some(err) = body.get("error") {
        return Err(format!(
            "mcp error {}: {}",
            err.get("code").and_then(|c| c.as_i64()).unwrap_or(0),
            err.get("message").and_then(|m| m.as_str()).unwrap_or("?")
        ));
    }
    let text = body
        .pointer("/result/content/0/text")
        .and_then(|t| t.as_str())
        .ok_or("mcp: no content")?;
    let parsed: serde_json::Value = serde_json::from_str(text).unwrap_or(json!({ "text": text }));
    if body
        .pointer("/result/isError")
        .and_then(|e| e.as_bool())
        .unwrap_or(false)
    {
        return Err(text.to_string());
    }
    Ok(parsed)
}

/// Task-scoped call: session attributed to the task's own dispatch session,
/// and the call attributed to the AGENT the gateway dispatched as
/// (ADR BR#899: gateways are infrastructure and never task owners). The
/// agent name autogens as <hostname>-<backend> (macbookpro-opencode) —
/// honoured by the hub only when the token carries the "gateway" tag.
fn mcp_call_task(
    cfg: &DispatchConfig,
    id: &mut i64,
    tool: &str,
    mut args: serde_json::Value,
    task_id: &str,
) -> Result<serde_json::Value, String> {
    if let Some(obj) = args.as_object_mut() {
        obj.insert("agent".into(), json!(agent_identity(cfg)));
    }
    mcp_call_session(cfg, id, tool, args, Some(&format!("dispatch-{}", slugify(task_id))))
}

/// The agent name dispatched tasks are attributed to: config override
/// (`agent_name`), else <hostname>-<backend> (autogen, stable per machine).
fn agent_identity(cfg: &DispatchConfig) -> String {
    if let Some(a) = &cfg.agent_name {
        return a.clone();
    }
    let host = std::process::Command::new("hostname")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "gateway".into());
    format!("{}-{}", slugify(&host).to_lowercase(), agent_segment(cfg))
}

/// The agent segment nested under the gateway label (<gateway>/<segment>):
/// the agent_name override when set, else just the backend name. The gateway
/// label already carries the machine — the old <hostname>-<backend> autogen
/// double-prefixed it (macbook-pro-local-2/macbook-pro-local-opencode = 46
/// chars) past the hub's 40-char token-label cap, so every dispatch 400'd on
/// provisioning and released its claim; hermes (ip-172-31-1-230/…) only fit
/// at exactly 40 by luck (BR#3846).
fn agent_segment(cfg: &DispatchConfig) -> String {
    if let Some(a) = &cfg.agent_name {
        return a.clone();
    }
    let backend = cfg.backends.keys().next().cloned()
        .or_else(|| cfg.backend.clone())
        .unwrap_or_else(|| "opencode".into());
    slugify(&backend).to_lowercase()
}

// ---- local dispatch snapshot (rendered by the app's Local view) ----

#[derive(Debug, Clone, Serialize)]
pub struct DispatchActivity {
    pub ts: u64,
    pub kind: String, // info | dispatch | finish | error
    pub msg: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct InFlightView {
    pub task_id: String,
    pub task_title: String,
    pub started_ms: u64,
    pub last_note: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct DispatchSnapshot {
    pub running: bool,
    pub url: Option<String>,
    pub workspace: Option<String>,
    pub label: Option<String>, // agent identity from pairing
    pub agent: Option<String>, // opencode agent name
    pub workdir: Option<String>,
    pub max_sessions: usize,
    pub in_flight: Vec<InFlightView>,
    pub activity: Vec<DispatchActivity>, // newest first, capped
    // BR#2532: set when the runner INVOLUNTARILY signs the desktop out
    // (identity-law run gate, hub-rejected token). The pair screen renders it
    // as a guided notice — what happened, that nothing was lost, one click to
    // re-pair — instead of leaving a silent logout in the dispatch log.
    pub logout_reason: Option<String>,
    pub logout_ts: Option<u64>,
}

pub type SharedSnapshot = Arc<Mutex<DispatchSnapshot>>;

fn snap_in_flight_list(snap: &SharedSnapshot, in_flight: &[InFlight]) {
    if let Ok(mut s) = snap.lock() {
        s.in_flight = in_flight
            .iter()
            .map(|inf| InFlightView {
                task_id: inf.task_id.clone(),
                task_title: inf.task_title.clone(),
                started_ms: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0)
                    - inf.started.elapsed().as_millis() as u64,
                last_note: inf.last_note.clone(),
            })
            .collect();
    }
}

fn snap_activity(snap: &SharedSnapshot, kind: &str, msg: &str) {
    if let Ok(mut s) = snap.lock() {
        s.activity.insert(
            0,
            DispatchActivity {
                ts: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
                kind: kind.into(),
                msg: msg.into(),
            },
        );
        s.activity.truncate(30);
    }
}

/// Record an involuntary sign-out (identity-law run gate, hub-rejected token)
/// as a structured notice on the snapshot — BR#2532: the reason used to live
/// only in stderr/last_error, which the UI never reads, so an upgrading
/// desktop stared at onboarding with no explanation.
fn snap_logout(snap: &SharedSnapshot, msg: &str) {
    if let Ok(mut s) = snap.lock() {
        s.logout_reason = Some(msg.to_string());
        s.logout_ts = Some(now_ms());
    }
    snap_activity(snap, "error", msg);
}

/// Clear the logout notice: a user-initiated logout is not a forced sign-out
/// (the Settings UI says so itself), and a fresh run starts clean.
fn snap_logout_clear(snap: &SharedSnapshot) {
    if let Ok(mut s) = snap.lock() {
        s.logout_reason = None;
        s.logout_ts = None;
    }
}

/// BR#2532: after an auto-logout the loop is STOPPED, so `dispatch_snapshot`
/// serves the external (headless flat-file) snapshot — which knows nothing of
/// the in-memory notice. Overlay it so the pair screen can still guide the
/// re-pair. `v` may be Null (no runner file at all — the gate tripped before
/// the first tick ever wrote one).
pub fn overlay_logout_notice(snap: &SharedSnapshot, v: &mut serde_json::Value) {
    let (reason, ts) = match snap.lock().ok().map(|s| (s.logout_reason.clone(), s.logout_ts)) {
        Some((Some(r), ts)) => (r, ts.unwrap_or(0)),
        _ => return,
    };
    if !v.is_object() {
        *v = serde_json::json!({ "running": false });
    }
    if let Some(obj) = v.as_object_mut() {
        obj.insert("logout_reason".into(), serde_json::Value::String(reason));
        obj.insert("logout_ts".into(), serde_json::json!(ts));
    }
}

// ---- ephemeral flat-file state (headless observability) ----
//
// The bridge hub owns authoritative state (task status, claims, progress, PR
// handoff). The runner keeps only ephemeral per-task state as flat JSON files
// under ~/.bridge/dispatch/ so headless runs are observable without the app.
// Files are removed when the task leaves the runner (handed off, or finished
// without a PR); failed tasks keep their file until the retry succeeds.

fn dispatch_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let dir = PathBuf::from(&home).join(".bridge").join("dispatch");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn write_task_state(task_id: &str, v: &serde_json::Value) {
    if let Some(dir) = dispatch_dir() {
        let _ = std::fs::write(
            dir.join(format!("{}.json", slugify(task_id))),
            serde_json::to_string_pretty(v).unwrap_or_default(),
        );
    }
}

fn remove_task_state(task_id: &str) {
    if let Some(dir) = dispatch_dir() {
        let _ = std::fs::remove_file(dir.join(format!("{}.json", slugify(task_id))));
    }
}

fn write_runner_state(snap: &SharedSnapshot) {
    let Some(dir) = dispatch_dir() else { return };
    if let Ok(s) = snap.lock() {
        let v = serde_json::json!({
            "updated_ts": now_ms(),
            "pid": std::process::id(),
            "running": s.running,
            "url": s.url,
            "workspace": s.workspace,
            "label": s.label,
            "agent": s.agent,
            "workdir": s.workdir,
            "max_sessions": s.max_sessions,
            "in_flight": s.in_flight,
            "activity": s.activity.iter().take(10).collect::<Vec<_>>(),
            // BR#2532: an auto-logout in a HEADLESS runner must reach the
            // desktop UI too — it observes this file from another process and
            // can't see our in-memory notice. Null after a user logout.
            "logout_reason": s.logout_reason,
            "logout_ts": s.logout_ts,
        });
        let _ = std::fs::write(dir.join("runner.json"), serde_json::to_string_pretty(&v).unwrap_or_default());
    }
}

/// Snapshot of a dispatch loop running in ANOTHER process (headless runner).
/// runner.json is written every tick — in-flight list + recent activity.
/// Null when no runner has ever written state here.
pub fn external_snapshot() -> Option<serde_json::Value> {
    let dir = dispatch_dir()?;
    let raw = std::fs::read_to_string(dir.join("runner.json")).ok()?;
    let mut v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    // a stale file from a dead process must not claim the runner is alive —
    // Settings reads this file; running:true with a dead pid is a lie
    if v.get("running").and_then(|r| r.as_bool()).unwrap_or(false) {
        let pid = v.get("pid").and_then(|p| p.as_u64()).unwrap_or(0) as u32;
        let alive = pid != 0
            && pid != std::process::id()
            && Command::new("ps")
                .args(["-o", "pid=", "-p", &pid.to_string()])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
        if !alive {
            v["running"] = serde_json::Value::Bool(false);
            v["in_flight"] = serde_json::Value::Array(vec![]);
            let _ = std::fs::write(dir.join("runner.json"), serde_json::to_string_pretty(&v).unwrap_or_default());
        }
    }
    Some(v)
}

/// Pid of a dispatch loop alive in ANOTHER process, if any. Guards the
/// dual-runner race: the desktop GUI used to auto-start its own loop while a
/// headless runner polled the same hub — two claimers racing on one board.
/// Stale files (crashed runner) are detected via pid liveness; our own pid
/// never counts as external.
pub fn external_runner_pid() -> Option<u32> {
    let v = external_snapshot()?;
    let pid = v.get("pid")?.as_u64()? as u32;
    if pid == std::process::id() {
        return None;
    }
    if !v.get("running").and_then(|r| r.as_bool()).unwrap_or(false) {
        return None;
    }
    let alive = Command::new("ps")
        .args(["-o", "pid=", "-p", &pid.to_string()])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if alive { Some(pid) } else { None }
}

/// "For you" payload for the desktop panel: the human's inbox, read-only.
/// Console chat task creation: the human confirmed a draft, so create the
/// task on the hub through MCP (the paired token's one legitimate write for
/// the console — creation only, never claims/transitions; the gateway is
/// dispatch infrastructure per ADR BR#2673).
pub fn create_task(title: &str, body: &str) -> Result<serde_json::Value, String> {
    let cfg = paired_config()?;
    let mut id = 0i64;
    mcp_call(
        &cfg,
        &mut id,
        "create_artefact",
        json!({
            "type": "task",
            "title": title,
            "body_md": body,
            "meta": { "kind": "impl", "origin": "console-chat" }
        }),
    )
}

/// "For you" inbox for the decision watch (console.rs): proposed decisions,
/// blocked work, open questions. This is a UI-plane read — it rides the
/// human session cookie (actor `web`), never the gateway bearer.
pub fn for_you_payload() -> Result<serde_json::Value, String> {
    let get = |q: &str| -> Result<serde_json::Value, String> {
        Ok(crate::session::kb_request("GET", &format!("/api/kb/artefacts{q}"), None)?
            .get("artefacts")
            .cloned()
            .unwrap_or_else(|| json!([])))
    };
    let decisions = get("?type=decision&status=proposed&limit=50")?;
    let blocked = get("?type=task&status=blocked&limit=50")?;
    let questions = get("?type=task&tag=question&limit=50")?;
    let url = crate::session::load().map(|s| s.url).unwrap_or_default();
    Ok(json!({
        "url": url,
        "decisions": decisions,
        "blocked": blocked,
        "questions": questions,
    }))
}

// ---- dispatch state (shared with Tauri commands) ----

struct InFlight {
    task_id: String,
    task_title: String,
    /// role tags recorded at claim time — decide done-vs-in_review from what
    /// the task IS, not title heuristics (analysis/unblock work finished with
    /// no PR used to bounce off the in_review handoff gate and loop forever)
    role_work: bool,
    started: std::time::Instant,
    last_note: String,
    worktree: Option<PathBuf>, // isolated worktree to clean up on finalize
    scratch: Option<PathBuf>,  // repo-less dispatch dir — removed when the outcome lands (BR#2460)
    pr_url: Option<String>,    // PR opened by the session, monitored after handoff
    rx: std::sync::mpsc::Receiver<opencode::RunOutcome>,
    live: Arc<std::sync::Mutex<String>>, // agent's latest output line (mid-run)
}

impl InFlight {
    fn live_line(&self) -> String {
        self.live.lock().ok().map(|g| g.clone()).unwrap_or_default()
    }
}

pub struct DispatchState {
    pub stop: Arc<AtomicBool>,
    pub running: Arc<AtomicBool>,
    pub last_error: Arc<Mutex<Option<String>>>,
    pub snapshot: Arc<Mutex<DispatchSnapshot>>,
    pub handle: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl DispatchState {
    pub fn new() -> Self {
        Self {
            stop: Arc::new(AtomicBool::new(false)),
            running: Arc::new(AtomicBool::new(false)),
            last_error: Arc::new(Mutex::new(None)),
            snapshot: Arc::new(Mutex::new(DispatchSnapshot::default())),
            handle: Mutex::new(None),
        }
    }

    pub fn status(&self) -> serde_json::Value {
        json!({
            "running": self.running.load(Ordering::Relaxed),
            "last_error": self.last_error.lock().ok().and_then(|g| g.clone()),
        })
    }
}

// ---- the loop ----

/// One dispatch tick. Returns Ok(Some(msg)) on notable actions.
// ---- per-task worktrees + spawning ----

/// Multiple agent types: rotate across cfg.backends (config order); fall back
/// to the single `backend` field. Round-robin spreads local work across the
/// enabled CLIs instead of stacking every task on one.
fn pick_backend(avail: &[opencode::Backend]) -> opencode::Backend {
    static RR: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let i = RR.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % avail.len().max(1);
    avail.get(i).copied().unwrap_or(opencode::Backend::OpenCode)
}

/// Backends actually dispatchable right now: the provider's CLI runs on this
/// machine. Model is optional per provider — unset means the CLI's own
/// default config decides (opencode), or the provider's profile (kiro).
fn available_backends(cfg: &DispatchConfig) -> Vec<opencode::Backend> {
    cfg.backends
        .iter()
        .filter(|(name, bc)| {
            let bin = bc.bin.clone().unwrap_or_else(|| match opencode::Backend::parse(Some(name)) {
                opencode::Backend::Kiro => "kiro".to_string(),
                _ => cfg.opencode_bin.clone(),
            });
            std::process::Command::new(&bin)
                .arg("--version")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        })
        .map(|(name, _)| opencode::Backend::parse(Some(name)))
        .collect()
}

fn slugify(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect()
}

/// Extract the git repository a task references: meta.repo wins (bare
/// `owner/repo` becomes a github URL), then the first github/https-git URL in
/// the body. None = a repo-less dispatch (BR#2460): the host provisions a
/// scratch dir and the board delivery contract — never a refusal.
fn source_repo(body_md: &str, meta: &serde_json::Value) -> Option<String> {
    if let Some(r) = meta.get("repo").and_then(|v| v.as_str()) {
        let r = r.trim();
        if !r.is_empty() {
            let expanded = if r.starts_with("http") || r.starts_with("git@") {
                r.to_string()
            } else {
                format!("https://github.com/{r}")
            };
            // structured ref wins outright: if it doesn't resolve, that's an
            // authoring defect — refuse at the gate, never scrape past it
            return scm::forge_for(&expanded).and_then(|f| f.repo_ref(&expanded));
        }
    }
    // scrape the newline-unwrapped body: the runner's terminal-width capture
    // hard-wraps agent output mid-word, and a URL split across lines
    // ("…/state-vector/super\npositional/pull/2343") scraped as its truncated
    // first line — a ghost repo that failed to clone and churned the task
    // (BR#3845). Line breaks are never meaningful inside a URL, so removing
    // them before scraping can only rejoin real ones.
    let flat = body_md.replace('\r', "").replace('\n', "");
    let mut rest: &str = &flat;
    while let Some(i) = rest.find("https://") {
        rest = &rest[i..];
        let end = rest
            .find(|c: char| {
                c.is_whitespace() || matches!(c, ')' | ']' | '>' | ',' | ';' | '!' | '?' | '"' | '\'')
            })
            .unwrap_or(rest.len());
        let url = &rest[..end];
        if let Some(repo) = scm::forge_for(url).and_then(|f| f.repo_ref(url)) {
            return Some(repo);
        }
        rest = &rest[end..];
    }
    None
}

// BR#2419: state legality lives in the worker's machine (machine.ts). The
// runner never transitions tasks to blocked, never resumes blocked tasks, and
// never encodes gate verdicts as state — it releases claims and skips
// candidates. The drift-alarm test at the bottom of this file enforces it.

/// BR#2460 scratch session dir for repo-less dispatches:
/// <workdir>/sessions/bridge-<tid>/. Litter control and a deterministic cwd,
/// NOT a sandbox — agents hold full user permissions. Removed when the run
/// outcome lands; runner startup sweeps orphans.
fn ensure_scratch_dir(workdir: &str, tid: &str) -> Option<PathBuf> {
    let dir = PathBuf::from(workdir)
        .join("sessions")
        .join(format!("bridge-{}", slugify(tid)));
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Clone-on-demand cache: one bare-enough working clone per task repo under
/// <workdir>/repos/<slug>, fetched on reuse. Returns the repo path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CloneFailure {
    /// git reached the remote and got a definitive "no such repo" — an
    /// authoring defect in the card's repo reference. Retrying the same
    /// reference can never succeed; the BR#3845 class burned 13 watchdog
    /// cycles re-clone-failing a ghost repo (state-vector/super) before a
    /// human noticed.
    NotFound(String),
    /// credentials — the reference is fine, the runner's access isn't.
    /// Retrying without fixing access is futile, but it isn't the card's
    /// defect; named loudly, claimed released, retried only on access change.
    Auth(String),
    /// network/infra flake — retry next cycle is the right move.
    Transient(String),
}

impl CloneFailure {
    /// Fatal classes refuse the reference outright (recorded, skipped until it
    /// changes); Transient keeps the retry-next-cycle behaviour.
    pub(crate) fn fatal(&self) -> bool {
        matches!(self, CloneFailure::NotFound(_) | CloneFailure::Auth(_))
    }
    pub(crate) fn detail(&self) -> &str {
        match self {
            CloneFailure::NotFound(s) | CloneFailure::Auth(s) | CloneFailure::Transient(s) => s,
        }
    }
}

/// Classify a git clone/fetch stderr into the failure taxonomy. GitHub says
/// "Repository not found" for both a missing repo and a private one the
/// runner can't see — both are fatal-until-changed for this reference.
fn classify_clone_failure(stderr: &str) -> CloneFailure {
    let s = stderr.to_lowercase();
    let fatal_not_found = s.contains("repository not found")
        || s.contains("repo not found")
        || s.contains("does not appear to be a git repository")
        || s.contains("not a git repository");
    if fatal_not_found {
        CloneFailure::NotFound(stderr.trim().to_string())
    } else if s.contains("authentication failed")
        || s.contains("could not read username")
        || s.contains("permission denied")
        || s.contains("http 403")
    {
        CloneFailure::Auth(stderr.trim().to_string())
    } else {
        CloneFailure::Transient(stderr.trim().to_string())
    }
}

fn ensure_repo_clone(workdir: &str, repo_url: &str) -> Result<PathBuf, CloneFailure> {
    let tail: String = repo_url
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .rsplit('/')
        .take(2)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("-");
    let slug = slugify(&tail);
    let repos_dir = PathBuf::from(workdir).join("repos");
    std::fs::create_dir_all(&repos_dir).map_err(|e| CloneFailure::Transient(e.to_string()))?;
    let path = repos_dir.join(&slug);
    if path.join(".git").exists() {
        let out = Command::new("git")
            .current_dir(&path)
            .args(["fetch", "--all", "--prune"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .output()
            .map_err(|e| CloneFailure::Transient(e.to_string()))?;
        return if out.status.success() {
            Ok(path)
        } else {
            Err(classify_clone_failure(&String::from_utf8_lossy(&out.stderr)))
        };
    }
    let out = Command::new("git")
        .args(["clone", repo_url])
        .arg(&path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| CloneFailure::Transient(e.to_string()))?;
    if out.status.success() {
        Ok(path)
    } else {
        Err(classify_clone_failure(&String::from_utf8_lossy(&out.stderr)))
    }
}

/// ---- refused-reference cache (BR#3845 self-heal) ----
/// A card whose repo reference is fatally unclonable (ghost repo, no access)
/// must not re-enter the claim→clone-fail→watchdog-release loop forever. The
/// runner records (task → reference + reason) locally and skips the reference
/// until it CHANGES on the card — the author fixes the URL, the record no
/// longer matches, dispatch resumes. Local to this runner host: the hub
/// machine stays the verdict authority; this is provisioning self-defense.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RefusedRef {
    pub url: String,
    pub reason: String,
    pub ts: u64,
}

fn refused_cache_path() -> Option<PathBuf> {
    dispatch_dir().map(|d| d.join("refused-repos.json"))
}

fn refused_cache_load() -> HashMap<String, RefusedRef> {
    let Some(p) = refused_cache_path() else {
        return HashMap::new();
    };
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn refused_cache_store(cache: &HashMap<String, RefusedRef>) {
    if let Some(p) = refused_cache_path() {
        let _ = std::fs::write(&p, serde_json::to_string_pretty(cache).unwrap_or_default());
    }
}

/// Whether this task's CURRENT reference is the one we already refused:
/// true = skip dispatch (the defect stands); false = proceed (fresh task, or
/// the author fixed the URL — the stale record is dropped so it can't pin the
/// card forever).
fn refused_reference(cache: &mut HashMap<String, RefusedRef>, tid: &str, url: Option<&str>) -> bool {
    match (cache.get(tid), url) {
        (Some(r), Some(u)) if r.url == u => true,
        (Some(_), _) => {
            // reference changed (or removed) since the refusal — re-arm
            cache.remove(tid);
            refused_cache_store(cache);
            false
        }
        (None, _) => false,
    }
}

/// Owning repo of a worktree: the worktree's .git FILE points at
/// <clone>/.git/worktrees/<name>. Deregistering against cfg.workdir silently
/// failed whenever the worktree was owned by a clone under <workdir>/repos —
/// the dir was then deleted, leaving a prunable ghost whose branch lock made
/// the next dispatch of the same task refuse isolation and churn through the
/// watchdog (BR#2421).
fn worktree_owner(path: &Path, fallback: &str) -> String {
    std::fs::read_to_string(path.join(".git"))
        .ok()
        .and_then(|s| {
            s.trim()
                .strip_prefix("gitdir: ")
                .and_then(|g| g.split("/.git/worktrees/").next())
                .map(String::from)
        })
        .unwrap_or_else(|| fallback.to_string())
}

/// YYYY-MM-DD (UTC) — civil-from-days, no chrono dependency. Suffix for the
/// WIP preservation branches the teardown sweep writes.
fn iso_date_utc() -> String {
    let secs = (now_ms() / 1000) as i64;
    let days = secs.div_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// BR#3204 teardown sweep: a worktree being torn down must not take
/// uncommitted work with it — that is exactly the 10-24 failure mode (a
/// 32-file WIP pile frozen in the shared checkout, preserved only afterwards
/// as `wip/preserved-2026-10-24`, whose diffs turned out to be stale tree
/// state). If the tree is dirty, commit everything onto a preservation branch
/// `wip/<task>-<date>` (branch, never main) and push it best-effort so
/// preservation survives host loss. Returns the branch name when preservation
/// happened, None when the tree was clean.
///
/// `git add -A` here is the documented teardown-sweep exception to the no-`add
/// -A` rule: this worktree is being destroyed and the branch is its only
/// record; no shared checkout is touched.
fn preserve_wip(worktree_path: &Path, task_id: &str) -> Option<String> {
    let dirty = Command::new("git")
        .current_dir(worktree_path)
        .args(["status", "--porcelain"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty())
        .unwrap_or(false);
    if !dirty {
        return None;
    }
    let git = |args: &[&str]| {
        Command::new("git")
            .current_dir(worktree_path)
            .args(args)
            .output()
    };
    let slug = slugify(task_id);
    let date = iso_date_utc();
    // branch at the current HEAD — the dirty tree carries over unchanged.
    // A same-day preservation name collision gets a -2/-3… suffix.
    let mut branch = format!("wip/{slug}-{date}");
    let mut created = false;
    for n in 1..10 {
        let name = if n == 1 { branch.clone() } else { format!("wip/{slug}-{date}-{n}") };
        if git(&["switch", "-c", &name]).map(|o| o.status.success()).unwrap_or(false) {
            branch = name;
            created = true;
            break;
        }
    }
    if !created {
        return None; // mid-merge or branch lock — best-effort only, teardown proceeds
    }
    let _ = git(&["add", "-A"]);
    let committed = git(&[
        "commit",
        "-m",
        &format!("WIP preservation sweep: {task_id} teardown (BR#3204 — branch, never main; {date})"),
    ])
    .map(|o| o.status.success())
    .unwrap_or(false);
    if !committed {
        // race or nothing actually committable — undo the empty branch
        let _ = git(&["switch", "--detach"]);
        let _ = git(&["branch", "-D", &branch]);
        return None;
    }
    // preservation should survive host loss: best-effort push, failures ignored
    let _ = git(&["push", "--set-upstream", "origin", &branch]);
    Some(branch)
}

/// Provision (or reuse) an isolated worktree for a task on branch bridge/<slug>,
/// branched from the task repo's default branch. Location (BR#3204): inside
/// the checkout at <repo>/.worktrees/<slug> — the per-session tree convention
/// (the repo's .gitignore carries `.worktrees/`, so the checkout stays clean).
/// The legacy ~/.bridge/worktrees/<slug> location is checked and kept as the
/// fallback so pre-change worktrees re-attach on resume and repos whose
/// clone predates the convention still isolate.
/// On resume the branch already exists — attach to it.
fn ensure_worktree(repo_path: &PathBuf, task_id: &str, resume: bool) -> Option<PathBuf> {
    let slug = slugify(task_id);
    let nested = repo_path.join(".worktrees").join(&slug);
    let legacy = std::env::var("HOME").ok().map(|h| {
        PathBuf::from(&h).join(".bridge").join("worktrees").join(&slug)
    });
    // reuse: nested first (the convention), legacy second (resume compat)
    if nested.exists() {
        return Some(nested);
    }
    if legacy.as_ref().map(|p| p.exists()).unwrap_or(false) {
        return legacy;
    }
    std::fs::create_dir_all(nested.parent()?).ok()?;
    // Self-heal stale registrations: a worktree dir deleted without
    // deregistration leaves a "prunable" ghost whose branch lock fails both
    // worktree adds below, and the isolation guard then refuses dispatch —
    // churning the task through the watchdog (BR#2421 class). Prune is
    // idempotent and cheap.
    let _ = Command::new("git")
        .current_dir(repo_path)
        .args(["worktree", "prune"])
        .output();
    let branch = format!("bridge/{slug}");
    // Base = the clone's default branch. `origin/HEAD` is set by clone.
    let add_at = |path: &PathBuf| {
        let mut cmd = Command::new("git");
        cmd.current_dir(repo_path);
        if resume {
            cmd.args(["worktree", "add"]).arg(path).arg(&branch);
        } else {
            cmd.args(["worktree", "add", "-b"]).arg(&branch).arg(path).arg("origin/HEAD");
        }
        cmd.output().map(|o| o.status.success()).unwrap_or(false)
    };
    if add_at(&nested) {
        return Some(nested);
    }
    // nested add refused (clone predates the .gitignore convention) — fall
    // back to the legacy location so isolation still holds.
    let Some(path) = legacy else { return None };
    std::fs::create_dir_all(path.parent()?).ok()?;
    if add_at(&path) {
        return Some(path);
    }
    let mut cmd = Command::new("git");
    cmd.current_dir(repo_path)
        .args(["worktree", "add"])
        .arg(&path)
        .arg(&branch);
    cmd.output().map(|o| o.status.success()).unwrap_or(false).then_some(path)
}

/// Run a command with a hard deadline: kill on expiry and report. The sign
/// check must never hang the dispatch loop (a misconfigured signingProgram —
/// e.g. a 1Password bridge that blocks on a locked agent — must fail loudly,
/// not stall dispatch). ssh-keygen from file signs instantly; 15s is generous.
fn run_with_timeout(mut cmd: Command, secs: u64) -> Result<std::process::Output, String> {
    cmd.stdin(std::process::Stdio::null());
    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn failed: {e}"))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                return child
                    .wait_with_output()
                    .map_err(|e| format!("wait failed: {e}"));
            }
            Ok(None) => {
                if started.elapsed() >= Duration::from_secs(secs) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "timed out after {secs}s — a signing program that blocks (locked agent, hung bridge) must fail loudly, never stall dispatch"
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("try_wait failed: {e}")),
        }
    }
}

/// Write the identity profile into the repo-local git config (BR#3185).
/// Idempotent; re-applied on resume. `git config` (no scope flag) writes at
/// repo scope — for a linked worktree that is the owning clone's config,
/// shared by that clone's worktrees; --global is never touched, so the
/// host's own signing path stays exactly as it was.
fn apply_identity(worktree: &std::path::Path, p: &IdentityProfile) -> Result<(), String> {
    for (key, value) in p.git_config() {
        let ok = Command::new("git")
            .current_dir(worktree)
            .args(["config", key, &value])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok {
            return Err(format!("git config {key} failed"));
        }
    }
    Ok(())
}

/// Per-call sequence number for sign_check scratch dirs (BR#3373): keying a
/// scratch dir by pid + profile name alone made every concurrent sign check
/// in one process share ONE directory — parallel tests (and concurrent task
/// dispatches in the runner) raced, and one side's cleanup deleted the other
/// side's signature mid-check. The counter (plus wall-clock nanos, so a
/// re-used pid can never resurrect a stale dir) gives each call its own dir.
static SIGN_CHECK_SEQ: AtomicU64 = AtomicU64::new(0);

/// Validation leg (BR#3185): prove the applied identity can actually sign
/// BEFORE dispatching — one scratch sign through the profile's own program
/// and key (`ssh-keygen -Y sign`, the same invocation git uses for
/// gpg.format=ssh). A broken identity (missing key file, wrong program,
/// locked agent) refuses the dispatch loudly here, killing the whole
/// unsigned-PR bounce class at source. Refuses on hang too — a signing
/// program that blocks must fail, never stall the dispatch loop.
fn sign_check(worktree: &std::path::Path, p: &IdentityProfile) -> Result<(), String> {
    // A detached worktree's private key sits beside its .pub sibling;
    // ssh-keygen resolves the private half from the pub path's stem.
    let _ = worktree;
    let key = std::path::Path::new(&p.signing_key_path);
    if !key.exists() {
        return Err(format!(
            "signing key not found: {} — provision the key or override the identity block in config",
            p.signing_key_path
        ));
    }
    // Unique per call (BR#3373): pid + profile name alone collide across
    // concurrent calls in one process, and the losing side's cleanup deletes
    // the winning side's payload.sig between its write and its exists() check
    // — a sound identity then "produced no signature". Seq + nanos separate
    // every invocation.
    let tmp = std::env::temp_dir().join(format!(
        "bridge-signcheck-{}-{}-{}-{}",
        std::process::id(),
        slugify(&p.name),
        SIGN_CHECK_SEQ.fetch_add(1, Ordering::Relaxed),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&tmp).map_err(|e| format!("sign-check scratch dir: {e}"))?;
    let payload = tmp.join("payload");
    std::fs::write(&payload, "bridge: identity sign check (BR#3185)\n")
        .map_err(|e| format!("sign-check payload: {e}"))?;
    let out = run_with_timeout(
        {
            let mut c = Command::new(&p.signing_program);
            c.args(["-Y", "sign", "-n", "git", "-f", &p.signing_key_path])
                .arg(&payload);
            c
        },
        15,
    )
    .map_err(|e| format!("sign check hung or failed: {e}"))?;
    let sig = tmp.join("payload.sig");
    let result = if !out.status.success() {
        Err(format!(
            "sign check failed (exit {:?}): {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    } else if !sig.exists() {
        Err("sign check produced no signature".into())
    } else {
        Ok(())
    };
    // Scratch dir always cleaned — success or failure.
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

/// Tear down a worktree: preserve any WIP onto `wip/<task>-<date>` first
/// (the teardown sweep — losing tree state is the 10-24 incident), then
/// deregister + remove it, and optionally drop the task branch.
/// drop_branch=true is terminal (done): the work is merged or rejected and
/// bridge/<slug> has no future — the preservation branch survives it, since
/// the WIP commit is reachable from it. On todo releases the branch is KEPT:
/// a re-claim attaches to it (committed-but-unpushed stall work survives;
/// uncommitted WIP went to the wip branch). Returns the preservation branch
/// when one was written.
fn cleanup_worktree_at(path: &PathBuf, task_id: &str, drop_branch: bool) -> Option<String> {
    if !path.exists() {
        return None;
    }
    let preserved = preserve_wip(path, task_id);
    let slug = slugify(task_id);
    // Owning repo: a worktree's .git FILE points at <clone>/.git/worktrees/<name>.
    let owner = worktree_owner(path, &path.to_string_lossy());
    let _ = Command::new("git")
        .current_dir(&owner)
        .args(["worktree", "remove", "--force"])
        .arg(path)
        .output();
    if drop_branch {
        // terminal (done): bridge/<slug> has no future. The WIP commit survives
        // on the preservation branch — deleting this branch does not orphan it.
        let _ = Command::new("git")
            .current_dir(&owner)
            .args(["branch", "-D"])
            .arg(&format!("bridge/{slug}"))
            .output();
    }
    // belt-and-braces: a failed deregistration leaves the dir behind
    let _ = std::fs::remove_dir_all(path);
    preserved
}

/// Reconcile on-disk worktrees with live task status. Terminal tasks (done,
/// superseded) and released tasks (todo) must not hold worktrees on disk — the
/// finalize path cleans `done` handoffs, but yielded runs, pre-sweep history
/// and handoff-rejections leave stragglers. Fresh in_progress/in_review/blocked
/// worktrees are kept: they are the session's resume assets — but nothing
/// parks forever (BR#3633): a tree not held by an in-flight session that is
/// older than WORKTREE_STALE_SECS is swept regardless of status or id
/// resolvability (WIP preserved first, branch kept, so a re-claim re-attaches).
/// Capped per tick, oldest first, so a large backlog always drains the worst
/// offenders.
/// Scans BOTH locations (BR#3204): the nested <repo>/.worktrees/<slug> trees
/// and the legacy ~/.bridge/worktrees/<slug> roots — a missing root is a
/// scoped skip, never a sweep abort (the old early-return there silently
/// disabled the entire sweep on hosts where the legacy root never existed:
/// post-BR#3204 hosts provision nested-only, so the reconciler was dead code
/// while provisioning kept allocating — the BR#3618/BR#3633 leak). Before any
/// teardown the sweep preserves uncommitted state onto wip/<task>-<date>
/// (never main).
const WORKTREE_SWEEP_CAP: usize = 20;
/// Eventual-consistency horizon (BR#3633): a worktree not held by an in-flight
/// session is swept once older than this, whatever its board status — an id
/// that no longer resolves, a hub outage, or a parked blocked task all drain
/// eventually instead of pinning disk forever. Branch is kept on the age path
/// so re-claims re-attach; drop-branch stays the explicit terminal-status path.
const WORKTREE_STALE_SECS: u64 = 7 * 24 * 3600;
static SWEEP_COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// BR#3787 — negotiated token catch-up. The hub stamps every authenticated
/// /mcp response with the row's epoch (bumped at each rotation);
/// TOKEN_EPOCH_VEND is the epoch of the secret this runner holds. 0 = unknown
/// on either side: the first observation ADOPTS (never repairs on unknowns).
/// A later mismatch means the row rotated elsewhere (another login/repair) —
/// the runner re-vends its OWN row proactively at the next tick boundary
/// instead of discovering the rotation by a mid-dispatch 401.
static TOKEN_EPOCH_SEEN: AtomicU64 = AtomicU64::new(0);
static TOKEN_EPOCH_VEND: AtomicU64 = AtomicU64::new(0);

/// Does the epoch the hub just showed differ from the epoch we vended?
/// 0 on either side means unknown — never repair on unknowns.
fn epoch_repair_needed(vend: u64, seen: u64) -> bool {
    vend > 0 && seen > 0 && vend != seen
}

/// One on-disk worktree candidate found by the sweep scan.
struct WorktreeCandidate {
    slug: String,
    path: PathBuf,
    mtime: std::time::SystemTime,
}

/// Reverse slugify: BR-1003 → BR#1003. Anything else (TASK-010, session-named
/// trees like hotfix-ext) passes through unchanged — unresolvable ids are not
/// an error, the age rule sweeps them eventually (BR#3633).
fn reverse_task_slug(slug: &str) -> String {
    match slug.strip_prefix("BR-") {
        Some(num) if num.chars().all(|c| c.is_ascii_digit()) => format!("BR#{num}"),
        _ => slug.to_string(),
    }
}

/// Sweep decision for one candidate — pure so it is unit-testable. `status`
/// is the board status when it could be fetched (None = unresolvable id or
/// MCP/network error). Returns (sweep, drop_branch, reason).
fn sweep_disposition(age_secs: u64, status: Option<&str>) -> (bool, bool, String) {
    match status {
        // explicit terminal statuses sweep at any age — the board is the
        // authority and these trees hold nothing the board doesn't have
        Some(s @ ("done" | "superseded")) => (true, true, format!("task is {s}")),
        Some("todo") => (
            true,
            false,
            "task released to todo (branch kept for re-claim)".into(),
        ),
        // fresh non-terminal trees are resume assets — keep
        _ if age_secs < WORKTREE_STALE_SECS => (false, false, String::new()),
        // stale non-terminal (in_progress/blocked/in_review/unknown id/MCP
        // outage): eventual sweep — WIP preserved, branch kept for re-claim
        _ => (
            true,
            false,
            format!(
                "stale ≥{}d — swept regardless of status ({})",
                WORKTREE_STALE_SECS / 86_400,
                status.unwrap_or("id unresolvable or status unknown")
            ),
        ),
    }
}

/// Collect worktree candidates from both roots. `home` is a parameter (not
/// read from the env here) so tests can inject a scratch root. A missing root
/// contributes nothing — a scoped skip, never an abort.
fn collect_worktree_candidates(
    workdir: &Path,
    home: Option<&Path>,
    active: &HashSet<String>,
) -> Vec<WorktreeCandidate> {
    let mut found: Vec<WorktreeCandidate> = Vec::new();
    let mut push = |e: std::fs::DirEntry, found: &mut Vec<WorktreeCandidate>| {
        let name = e.file_name().to_string_lossy().to_string();
        if name.is_empty() || active.contains(&name) {
            return;
        }
        let mtime = e
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        found.push(WorktreeCandidate {
            slug: name,
            path: e.path(),
            mtime,
        });
    };
    // nested: <workdir>/repos/<repo>/.worktrees/<slug>
    if let Ok(repos) = std::fs::read_dir(workdir.join("repos")) {
        for repo in repos.flatten() {
            if let Ok(entries) = std::fs::read_dir(repo.path().join(".worktrees")) {
                for e in entries.flatten() {
                    push(e, &mut found);
                }
            }
        }
    }
    // legacy: ~/.bridge/worktrees/<slug>
    if let Some(home) = home {
        if let Ok(entries) = std::fs::read_dir(home.join(".bridge").join("worktrees")) {
            for e in entries.flatten() {
                push(e, &mut found);
            }
        }
    }
    found
}

fn sweep_stale_worktrees(cfg: &DispatchConfig, id: &mut i64, in_flight: &[InFlight], msgs: &mut Vec<String>) {
    let active: HashSet<String> = in_flight
        .iter()
        .filter_map(|inf| inf.worktree.as_ref())
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
        .collect();
    let mut found = collect_worktree_candidates(
        Path::new(&cfg.workdir),
        std::env::var("HOME").ok().map(PathBuf::from).as_deref(),
        &active,
    );
    // dedup by slug (same name in both roots → nested wins), then drain
    // oldest-first: the cap must always bite the worst offenders
    found.sort_by(|a, b| a.slug.cmp(&b.slug));
    found.dedup_by(|a, b| a.slug == b.slug);
    found.sort_by(|a, b| a.mtime.cmp(&b.mtime));
    let mut swept = 0;
    for cand in found {
        if swept >= WORKTREE_SWEEP_CAP {
            break;
        }
        let task_id = reverse_task_slug(&cand.slug);
        let age_secs = std::time::SystemTime::now()
            .duration_since(cand.mtime)
            .map(|d| d.as_secs())
            .unwrap_or(u64::MAX);
        // status lookup only for trees the age rule would keep — stale trees
        // sweep regardless, so a hub outage cannot freeze the reconciler
        let status = if age_secs < WORKTREE_STALE_SECS {
            mcp_call(cfg, id, "get_artefact", json!({ "id": task_id }))
                .ok()
                .and_then(|v| v.get("status").and_then(|s| s.as_str()).map(String::from))
        } else {
            None
        };
        let (do_sweep, drop_branch, reason) = sweep_disposition(age_secs, status.as_deref());
        if !do_sweep {
            continue;
        }
        swept += 1;
        let preserved = cleanup_worktree_at(&cand.path, &task_id, drop_branch);
        msgs.push(format!(
            "swept worktree {} — {}{}",
            cand.slug,
            reason,
            preserved.map(|b| format!("; WIP preserved on {b}")).unwrap_or_default()
        ));
    }
    if swept > 0 {
        // prune the clones that actually own the registrations. cfg.workdir is
        // scratch space, NOT a repo — the old prune against it was a silent
        // no-op that left ghost registrations in the owning clones (BR#2421).
        if let Ok(repos) = std::fs::read_dir(PathBuf::from(&cfg.workdir).join("repos")) {
            for repo in repos.flatten() {
                let _ = Command::new("git")
                    .current_dir(repo.path())
                    .arg("worktree")
                    .arg("prune")
                    .output();
            }
        }
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max).collect::<String>()) }
}

// ---- backend session registry (kiro) ----
//
// opencode sessions carry bridge-<task_id> titles so they're rediscoverable.
// Kiro has no titles: the runner records task → session_id in a sidecar file
// after each run and reads it back on resume.

fn sessions_file() -> Option<PathBuf> {
    Some(dispatch_dir()?.join("sessions.json"))
}

fn load_session_registry() -> HashMap<String, String> {
    let Some(path) = sessions_file() else { return HashMap::new() };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_session_id(task_id: &str, session_id: &str) {
    let Some(path) = sessions_file() else { return };
    let mut reg = load_session_registry();
    reg.insert(task_id.to_string(), session_id.to_string());
    let _ = std::fs::write(
        &path,
        serde_json::to_string_pretty(&reg).unwrap_or_default(),
    );
}

/// Config-class agent errors: identical on every retry, so retrying is pure
/// churn (the 104-attempt family). Tight list — false positives here would
/// block tasks that a transient retry could have saved.
fn is_config_error(text: &str) -> bool {
    const MARKERS: [&str; 6] = [
        "not found. Falling back to default agent",
        "ProviderModelNotFoundError",
        "Unknown model",
        "Model blocked by guardrail",
        "is not a valid model",
        "no such agent",
    ];
    MARKERS.iter().any(|m| text.contains(m))
}

fn extract_pr(stdout: &str) -> Option<String> {
    for tok in stdout.split_whitespace() {
        // URLs are often wrapped in markdown ("[View PR](https://…/pull/1)")
        // or prefixed with quotes/punctuation — match anywhere in the token,
        // not just at its start, so formatting can't break the handoff.
        let idx = match tok.find("https://") {
            Some(i) => i,
            None => continue,
        };
        let url = &tok[idx..];
        let end = url
            .find(|c: char| matches!(c, ')' | ']' | '>' | ',' | ';' | '"' | '\''))
            .unwrap_or(url.len());
        if let Some(pr) = scm::forge_for(&url[..end]).and_then(|f| f.pull_ref(&url[..end])) {
            return Some(pr.url);
        }
    }
    None
}

/// VOID-RUN detection (BR#877 rule 3, hard runner rule): a dispatch that
/// performed NO work — model blocked by provider guardrails, zero endpoints —
/// still exits 0 (the CLI prints the error and quits cleanly). Such a run
/// must never hand off: its "receipts" would be void (the guardrails error
/// page cited as a PR — BR#860/863/866/844/855 class). Treated as failure:
/// backoff, then blocked-for-attention, never done, never in_review.
fn void_run(stdout: &str, stderr: &str) -> bool {
    const SIGS: [&str; 6] = [
        "Model blocked by guardrail",
        "0 endpoints out of",
        "no endpoints are available matching your guardrail",
        // opencode server-side crash — the session died before any work
        // (auth expired, local server broken). Deterministic, no work done.
        "Unexpected server error. Check server logs",
        "Endpoint is unavailable",
        "\"name\": \"UnknownError\"",
    ];
    SIGS.iter().any(|s| stdout.contains(s) || stderr.contains(s))
}

/// BR#3352: local side-effect receipts appended to completed_result_lost
/// markers — what the runner can prove at completion time without the hub
/// probing disk/GitHub. The hub's watchdog classifier greps the trail for the
/// marker and for GitHub receipts; this wording feeds both.
fn result_lost_receipts(worktree: Option<&str>, pr: Option<&str>) -> String {
    let mut bits: Vec<String> = Vec::new();
    if let Some(w) = worktree {
        let w = w.trim();
        if !w.is_empty() {
            bits.push(format!("worktree {w}"));
        }
    }
    if let Some(p) = pr {
        let p = p.trim();
        if !p.is_empty() {
            bits.push(format!("PR {p}"));
        }
    }
    if bits.is_empty() {
        " (no local side-effect receipts — check the session trail)".to_string()
    } else {
        format!("; side effects: {}", bits.join(", "))
    }
}

/// Spawn an opencode session for a task: strict policy pre-prompt + task body +
/// delivery contract (commit, push branch, open PR). Uses an isolated worktree
/// when cfg.isolate and the repo allows it; otherwise falls back to cfg.workdir.
/// Leave a runner-attributed note on a task so refusals/failures are visible
/// where the work lives, not just in runner stderr.
fn note_task(cfg: &DispatchConfig, tid: &str, did: &str) {
    let mut id = 0i64;
    let _ = mcp_call(cfg, &mut id, "log_progress", json!({ "id": tid, "did": did }));
}

/// Release this runner's own claim (in_progress → todo) with a note. BR#2419:
/// the runner may release its own claims — that is the only card move it makes
/// besides claiming. BR#3611: the note is EVIDENCE — post it only when the
/// release actually happened. A claim-race rejection (the ownership gate
/// refused: another dispatcher owns the card) is skipped silently — the
/// re-claim race path already logs it, and a note here would be a phantom
/// receipt (BR#3372 seqs 131165/131238/131307: the board recorded releases
/// that were rejected). Any other failure gets an honest failure note naming
/// the error — never a success note for a release that didn't happen.
/// The outcome of a release attempt. Returned so callers that must branch on
/// it (the stale-claim flow's re-claim leg, BR#3823) CAN — review finding on
/// PR #220: the old signature returned () and a caller could not distinguish
/// a real release from a refused one. Note/honesty semantics unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ReleaseOutcome {
    /// the card was released to the pool (note posted)
    Released,
    /// the gate refused as a claim race — benign, self-healing, silent
    ClaimRace,
    /// the release FAILED for a real reason (failure note posted)
    Failed(String),
}

fn release_claim(cfg: &DispatchConfig, tid: &str, did: &str) -> ReleaseOutcome {
    let mut id = 0i64;
    let res = mcp_call_task(cfg, &mut id, "transition", json!({ "id": tid, "to": "todo" }), &tid);
    let outcome = release_outcome(&res);
    match release_note(&res, did) {
        Some(note) => note_task(cfg, tid, &note),
        None => eprintln!(
            "[dispatch] {tid}: release raced (gate refused, card not released) — no note posted (BR#3611)"
        ),
    }
    outcome
}

fn release_outcome(res: &Result<serde_json::Value, String>) -> ReleaseOutcome {
    match res {
        Ok(_) => ReleaseOutcome::Released,
        Err(e) if is_claim_race_error(e) => ReleaseOutcome::ClaimRace,
        Err(e) => ReleaseOutcome::Failed(truncate(e, 200)),
    }
}

/// The note release_claim should post for a release outcome, or None to stay
/// silent. Ok → the caller's note (the release really happened); a claim-race
/// rejection → None (benign, self-healing — never a phantom success note);
/// any other error → the caller's note prefixed with the honest failure.
fn release_note(res: &Result<serde_json::Value, String>, did: &str) -> Option<String> {
    match release_outcome(res) {
        ReleaseOutcome::Released => Some(did.to_string()),
        ReleaseOutcome::ClaimRace => None,
        ReleaseOutcome::Failed(e) => {
            Some(format!("{did} — RELEASE FAILED (card NOT released): {e}"))
        }
    }
}

// ---- BR#3337: claim races are retryable noise, never dispatch failures ----

/// How fresh a session stamp (or hub heartbeat) must be to count as live: the
/// same bar the watchdog's stall sweep uses, so the runner never declares a
/// card deader than the watchdog would.
const LIVE_WINDOW_MS: u64 = 10 * 60 * 1000;

/// Liveness verdict for an `in_progress` card of mine (BR#3337). LIVE: an
/// opencode session for the card refreshed recently, or the hub heartbeat
/// (session_alive_ts vouch / agent last_progress) is fresh — a live session
/// owns the work, skip silently. STALE: no fresh signal anywhere — the
/// dispatched session died holding its claim; release it and claim fresh
/// (the rule-9 release path the runner takes for its own dead sessions).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClaimLiveness {
    Live,
    Stale,
}

fn claim_liveness(
    session_updated_ms: Option<u64>,
    session_alive_ts: Option<u64>,
    last_progress_ts: Option<u64>,
    now_ms: u64,
) -> ClaimLiveness {
    let fresh = |ts: Option<u64>| matches!(ts, Some(t) if now_ms >= t && now_ms - t <= LIVE_WINDOW_MS);
    if fresh(session_updated_ms) || fresh(session_alive_ts) || fresh(last_progress_ts) {
        ClaimLiveness::Live
    } else {
        ClaimLiveness::Stale
    }
}

/// Classify a claim-transition rejection. Lifecycle-edge rejections
/// (`task: 'in_progress' → 'in_progress' not allowed (allowed: …)`,
/// `status 'x' is terminal for task`) and ownership rejections
/// (`task BR#N is claimed by X — only the owner, a human, or an unblock duty
/// holding proof of the met exit condition can release it…`; the structural
/// pair "claimed by" + "only the owner" matches every wording — BR#3611)
/// are claim races: the card moved under us between orient and claim, or
/// another dispatcher holds it. Retryable next tick, never a dispatch failure.
fn is_claim_race_error(e: &str) -> bool {
    e.contains("not allowed (allowed:")
        || e.contains("is terminal for")
        || (e.contains("claimed by") && e.contains("only the owner"))
}

/// A spawned session whose output is a wall of lifecycle/ownership gate
/// rejections lost a claim race — it worked a card another session owns.
/// The breaker exists for deterministic agent-CLI breakage (auth, server
/// down, guardrails); a race is not that, and counting it trips the breaker
/// on healthy hosts (2026-10-25 incident: 6 races = "6 consecutive dispatch
/// failures (other)" while the same host dispatched other tasks fine).
fn claim_race_run(stdout: &str, stderr: &str) -> bool {
    // BR#3611: no sentence literals — PR #210's guard-message edit broke the
    // hub's literal match (breachClass, specimen BR#3610). The single-atom
    // sigs below are stable fragments; the ownership shape is the same
    // structural pair is_claim_race_error uses ("claimed by" + "only the
    // owner", present in every wording of the release-needs-ownership guard).
    const SIGS: [&str; 2] = ["not allowed (allowed:", "is claimed by"];
    if SIGS.iter().any(|s| stdout.contains(s) || stderr.contains(s)) {
        return true;
    }
    let ownership = |t: &str| t.contains("claimed by") && t.contains("only the owner");
    ownership(stdout) || ownership(stderr)
}

/// BR#3823: the stale-claim flow's LIVE-card gate. The orient slice and the
/// liveness verdict describe how the card looked seconds ago; before firing
/// a release the flow re-checks the freshly-fetched card itself: still
/// `in_progress` AND still attributed to THIS runner (the owner composite the
/// hub stamped from the claim's agent identity — `agent_identity(cfg)`,
/// owner = attributedAgent ?? actor, do.ts). Anything else — the watchdog
/// stall-released it to blocked, another dispatcher re-claimed it, the fetch
/// failed, owner is missing — is "not ours to release": skip the release,
/// the note, and the re-claim (debug only). Fail-safe by construction: an
/// unverifiable card is never released. Specimen: BR#3299 22:48Z — the old
/// flow released into a card the watchdog had already redirected; the
/// ownership rejection folded as breach 'other' and a phantom "stale claim
/// released" note posted on top, then a note-less re-claim folded a second
/// 'other' — a ~10-11m cycle per session death.
fn stale_claim_live(art: &serde_json::Value, expected_owner: &str) -> bool {
    art.get("status").and_then(|v| v.as_str()) == Some("in_progress")
        && art.get("owner").and_then(|v| v.as_str()) == Some(expected_owner)
}

/// BR#3823: the re-claim leg's resolution note. If the card was redirected
/// to blocked in the race between our release and the re-claim (watchdog
/// stall-release, churn guard), the note re-stamps the card's own blocked
/// reason + unblock condition — so the blocked → in_progress leg passes
/// unblock-needs-resolution (machine.ts) with the prior promise preserved,
/// not erased, and the transition itself carries an honest account of the
/// recovery on every path.
fn reclaim_resolution_note(live: &serde_json::Value) -> String {
    let base = "runner: re-claim — stale claim released (session died), starting fresh";
    if live.get("status").and_then(|s| s.as_str()) != Some("blocked") {
        return base.to_string();
    }
    let reason = live
        .get("blocked_reason")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let cond = live
        .get("unblock_condition")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    format!("{base}; prior block re-stamped — reason: {reason} | unblock condition: {cond}")
}

fn spawn_opencode(
    cfg: &DispatchConfig,
    snap: &SharedSnapshot,
    tid: &str,
    title: &str,
    body_md: &str,
    task_meta: &serde_json::Value,
    policy: &str,
    resume_session: Option<String>,
    role_work: bool,
    role_type: &str,
    avail: &[opencode::Backend],
    in_flight: &mut Vec<InFlight>,
) {
    let backend = pick_backend(avail);

    // BR#2460: provisioning is a best-effort optimization; capability belongs
    // to the agent. A resolvable repo reference (meta.repo or the task body)
    // means the host provisions a checkout; its absence means a scratch dir
    // and the board delivery contract — never a refusal. Under-provisioning
    // is survivable (the agent clones what it needs); the old gate that
    // declined repo-less tasks parked claimed cards with no session
    // (BR#2456 class).
    let repo_url = source_repo(body_md, task_meta);
    let scratch = if repo_url.is_none() {
        ensure_scratch_dir(&cfg.workdir, tid)
    } else {
        None
    };
    let backend_name = match backend {
        opencode::Backend::OpenCode => "opencode",
        opencode::Backend::Kiro => "kiro",
    };
    // per-provider config from the backends dict: each CLI has its own config
    // surface. Model/agent are optional everywhere — unset means that CLI's
    // own default config decides (opencode default model, kiro profile).
    let bc = cfg.backends.get(backend_name).cloned().unwrap_or_default();
    let bc_mode = bc.mode.clone();
    let agent_profile = bc.agent.or_else(|| cfg.agent.clone());
    let model = bc.model.or_else(|| cfg.model.clone());
    let model_str = model.clone().unwrap_or_default();
    let resume_session = if resume_session.is_none() && backend == opencode::Backend::Kiro {
        load_session_registry().get(tid).cloned() // kiro resume via sidecar registry
    } else {
        resume_session
    };
    let resume = resume_session.is_some();
    // BR#3204 exemptions: some dispatches must NOT get a per-task worktree.
    //   1. Surgical-by-declaration tasks — meta.surgical (or meta.surgical_by_
    //      declaration): short, surgical changes to the shared checkout are the
    //      declared deliverable, and a fresh worktree would orphan them.
    //   2. Exempt repos (cfg.worktree_exempt_repos) — the webapp-only checkout
    //      class, where the checkout itself is the deploy surface and shared-
    //      tree editing is the design. Matched case-insensitively against the
    //      repo URL and its tail (owner/name, with or without .git).
    let surgical = task_meta
        .get("surgical")
        .or_else(|| task_meta.get("surgical_by_declaration"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        || body_md.contains("surgical-by-declaration");
    let repo_exempt = match &repo_url {
        Some(url) => {
            let u = url.to_ascii_lowercase();
            let tail = u.rsplit('/').next().unwrap_or(&u).trim_end_matches(".git");
            cfg.worktree_exempt_repos.iter().any(|r| {
                let r = r.trim().trim_end_matches(".git").to_ascii_lowercase();
                !r.is_empty() && (u.contains(&r.as_str()) || tail == r.as_str())
            })
        }
        None => false,
    };
    let skip_worktree = surgical || repo_exempt;
    if skip_worktree {
        eprintln!(
            "[dispatch] {tid}: per-task worktree skipped — {}",
            if surgical { "task is surgical-by-declaration" } else { "repo is worktree-exempt" }
        );
    }
    let worktree = if let Some(url) = &repo_url {
        let repo_path = match ensure_repo_clone(&cfg.workdir, url) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[dispatch] ERROR: {tid}: clone failed for {url} — {} — skipping spawn", e.detail());
                snap_activity(snap, "error", &format!("{tid}: clone failed ({url}): {}", e.detail()));
                let mut refused = refused_cache_load();
                if e.fatal() {
                    // BR#3845 self-heal: record the refusal so the claim →
                    // clone-fail → 10-min-watchdog-stall → release loop stops
                    // after ONE cycle; the candidate skip re-arms the moment
                    // the card's reference changes.
                    refused.insert(
                        tid.to_string(),
                        RefusedRef {
                            url: url.clone(),
                            reason: match &e {
                                CloneFailure::NotFound(_) => "repository not found (authoring defect in the card's repo reference)".into(),
                                CloneFailure::Auth(_) => "access denied (runner lacks credentials for this repo)".into(),
                                CloneFailure::Transient(_) => unreachable!("fatal arm"),
                            },
                            ts: std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_millis() as u64)
                                .unwrap_or(0),
                        },
                    );
                    refused_cache_store(&refused);
                    release_claim(
                        cfg,
                        tid,
                        &format!(
                            "runner: clone of {url} is fatally refused ({}) — recorded; dispatch skipped until the card's repo reference changes (fix meta.repo/body URL, or grant the runner access)",
                            e.detail()
                        ),
                    );
                } else {
                    // transient: release the claim so the retry starts NOW —
                    // holding it only bought a 10-minute watchdog stall
                    release_claim(
                        cfg,
                        tid,
                        &format!("runner: transient clone failure for {url} ({}) — claim released, will retry next cycle", e.detail()),
                    );
                }
                return;
            }
        };
        let worktree = if cfg.isolate && !skip_worktree {
            ensure_worktree(&repo_path, tid, resume)
        } else {
            None
        };
        // isolation guard: a shared checkout is a shared branch and a shared git
        // index — dispatched sessions have switched branches under humans and
        // reverted committed work (three times). If isolation was requested and
        // failed, refuse: never dispatch into cfg.workdir. Exempt dispatches
        // (surgical / exempt-repo) opted into the shared tree knowingly, so the
        // guard does not apply to them.
        if cfg.isolate && !skip_worktree && worktree.is_none() {
            let msg = format!(
                "ERROR: {tid}: worktree isolation unavailable — refusing to dispatch into the shared checkout (fix git state or set isolate=false knowingly)"
            );
            eprintln!("[dispatch] {msg}");
            snap_activity(snap, "error", &msg);
            return;
        }
        // Identity leg (BR#3185): write the profile's repo-local git config and
        // prove it can sign BEFORE dispatching. A failed sign check refuses the
        // dispatch loudly — killing the unsigned-PR bounce class at source
        // (BR#3042/BR#3134). Global git config is never touched: `git config`
        // inside a linked worktree writes at repo scope into the runner's own
        // clone (shared by that clone's worktrees) — the host checkout, the
        // shared checkout, and the host's global config stay exactly as they were.
        if let Some(wt) = &worktree {
            let profile = cfg.identity_profile();
            if let Err(e) = apply_identity(wt, &profile).and_then(|()| sign_check(wt, &profile)) {
                let msg = format!(
                    "ERROR: {tid}: identity profile failed — refusing to dispatch ({}). Fix the runner's identity config or provision the signing key.",
                    e
                );
                eprintln!("[dispatch] {msg}");
                snap_activity(snap, "error", &msg);
                note_task(
                    cfg,
                    tid,
                    &format!(
                        "runner: identity profile failed — {} (task not dispatched; will retry next cycle)",
                        e
                    ),
                );
                return;
            }
        }
        worktree
    } else {
        None
    };
    let run_dir = if let Some(wt) = &worktree {
        wt.to_string_lossy().to_string()
    } else if let Some(s) = &scratch {
        s.to_string_lossy().to_string()
    } else {
        cfg.workdir.clone()
    };
    let branch = format!("bridge/{}", slugify(tid));
    let resume_note = resume_session
        .as_ref()
        .map(|s| format!("\n\nYou are resuming opencode session `{s}` — an opencode id, NOT a bridge session name; your bridge session is stated under # Environment. Pick up where you left off; do not restart the task from scratch."))
        .unwrap_or_default();
    // Reporting cadence: None (default) = report like a human collaborator —
    // meaningful steps and findings only, no fixed interval. The runner relays
    // your stdout lines to the board every poll, so your normal narration keeps
    // the task visibly alive; you do NOT need scheduled heartbeats. Explicit
    // report_minutes restores a fixed cadence for agents that narrate nothing.
    // Gauges (BR#3225): the board and the agent score read completion /
    // confidence / risk / context from log_progress fields. Stdout narration
    // is relayed gauge-less (it keeps the task visibly alive; the server's
    // gauge carry-forward preserves the last reported values — BR#3199), so
    // the agent must set the gauges themselves via log_progress at milestones.
    let gauge_line = " At each milestone, call log_progress with the gauges: completion_pct, confidence_pct, risk_pct, context_pct (0-100) — the board cannot prioritise or score gauge-less reports.";
    let heartbeat_line = match cfg.report_minutes {
        Some(mins) => format!(
            "- HEARTBEAT: call log_progress via the bridge MCP every ~{mins} minutes — one line: what you just did + what you do next, plus the gauges (completion_pct, confidence_pct, risk_pct, context_pct, 0-100). The board is your only visible output; silence reads as abandonment and gets the task reassigned."
        ),
        None => format!(
            "- REPORTING: report progress the way you would to a human user — when you complete a meaningful step, hit a finding, or change direction; not on a timer. The runner relays your output to the board automatically, so narrating your work in your normal output (brief, one line at natural milestones) is enough to keep the task visibly alive.{gauge_line}"
        ),
    };
    // PRs only for CODE work (BR#877: receipts must match the deliverable type):
    // verify/analysis/unblock tasks deliver on the BOARD (knowledge/progress
    // notes with receipts) — a PR per receipt-finding was drowning the queue
    // (51 open docs-PRs in a day). The role flag recorded at claim time
    // decides which contract the session gets. Repo-less dispatches deliver
    // on the board too: there is no provisioned checkout to open a PR from
    // (the agent may still self-serve a clone — the board line covers that).
    let delivery_line = if role_work || repo_url.is_none() {
        "- Deliver on the board: your findings, verdicts, and receipts go into log_progress / knowledge artefacts with exact citations (GitHub PR/issue/run URLs only — a non-GitHub URL is not a receipt). No commit or PR unless you actually changed code.\n- If you DID change code: commit your work, push the branch, and open a PR against the default branch (`gh pr create`), and include the PR URL in your summary. Docs ride with the change: user-visible behaviour updates README.md and packages/site/content.md in the same branch."
    } else {
        "- Commit your work, push the branch, and open a PR against the default branch (`gh pr create`).\n- Then follow the merge ladder: needs rebase → kick the task back to the pool (note it); base red in CI → block on a base-fix task (create or associate); mergeable + checks green + you agree → merge your own PR (`gh pr merge`) and cite the merge commit in the task.\n- An existing review that is unsatisfactory: sound-but-negative → pass feedback to the implementor, kick the task back; poor and rebuttable → raise a quality issue, merge anyway with a note; incomprehensible → escalate to the human via ask.\n- When finished, output a concise summary including the PR URL and the merge commit.\n- Docs ride with the change: if your work alters user-visible behaviour (UI, config, protocol, gates), update README.md and packages/site/content.md in the same branch."
    };
    // Identity note (BR#3185): the dispatched session must know which git
    // identity is in force — repo-local in this worktree, applied by the
    // runner from the profile. Ad-hoc `-c` overrides drift the committer
    // identity away from the class; the verify gate bounces that.
    let identity = cfg.identity_profile();
    let identity_note = if worktree.is_some() {
        format!(
            " Git identity for commits in this worktree is provisioned repo-locally by the runner from its identity profile (the built-in `worker` class unless overridden): commits as `{}` <{}>, signed with key `{}`. Do not override `user.name`, `user.email`, or `user.signingkey`; ad-hoc `-c` overrides drift the committer identity and the verify gate bounces that.",
            identity.name, identity.email, identity.signing_key_path
        )
    } else {
        String::new()
    };
    let provisioning_line = if let Some(url) = &repo_url {
        if worktree.is_some() {
            format!("- You are working in {run_dir} on branch `{branch}` (an isolated git worktree of {url}). On your first orient, pass worktree: \"{run_dir}\" so the board records where your tree lives (BR#3204).{identity_note}")
        } else {
            format!(
                "- You are working in {run_dir} — the SHARED checkout of {url} (per-task worktrees are deliberately skipped for this dispatch: short, surgical changes only).\n  - Shared-checkout rules in force: verify by content, never `git add -A` (stage explicit paths), never switch branches mid-session, and re-read files before building on them — other sessions share this tree."
            )
        }
    } else {
        format!(
            "- You are working in {run_dir} — a scratch session directory, not a git checkout; it is deleted when your run ends. If the work turns out to need code, clone what you need yourself (`git` and `gh` are authenticated). Deliver anything of value to the board — the scratch dir is not a deliverable."
        )
    };
    let digits = tid.rsplit('-').next().unwrap_or(tid);
    let bridge_session = format!("bridge-{role_type}-{}", slugify(digits));
    let env_block = format!(
        "# Environment\n\n- Your bridge session name is `{bridge_session}` — pass `session: \"{bridge_session}\"` on every bridge MCP call (orient, log_progress, transition, ask_agent). That is the session holding this task's claim; orienting as any other name shows you an empty desk and breaks attribution.\n- The `bridge` MCP server is already configured in this CLI. Its tools (orient, log_progress, transition, ask_agent, get_artefact, search_knowledge, related_artefacts, get_history) are the only interface to the board — call them directly.\n- Do NOT hunt for a `bridge` CLI, probe the hub over HTTP, or read `~/.bridge` — that directory is runner-internal state, not yours. If the bridge tools are genuinely absent from this session, output `MCP UNAVAILABLE: bridge tools missing` and end the run; do not attempt to reconstruct access."
    );
    let prompt = format!(
        "{}\n\n# Task\n\n{}: {}\n\n{}\n{}\n\n{}\n\n# Delivery contract\n\n{}\n{}\n{}\n- Blocked on a decision or missing input? File the ask via ask_agent, transition the task to blocked (note + unblock condition), and END your run — do not wait. The task re-enters the pool when unblocked and a later session (possibly yours, via resume) picks it up.\n- Do NOT merge, do NOT push to the default branch, do NOT touch files outside this worktree.\n- Scratch git worktrees or extra branches you create inside this worktree are your responsibility — remove them (`git worktree remove`, `git branch -d`) before you end the run. Do not leave litter behind: the dispatch worktree itself is managed by the runner, but anything you create beyond it is on you.",
        policy, tid, title, body_md, resume_note, env_block, provisioning_line, heartbeat_line, delivery_line
    );
    // clone for the ephemeral state file: the closure below moves the original
    let resume_session_for_state = resume_session.clone();
    eprintln!(
        "[dispatch] {tid} dispatched — {} opencode session bridge-{tid}{}",
        if resume {
            format!("resuming session {}", resume_session.as_deref().unwrap_or("?"))
        } else {
            "new".to_string()
        },
        worktree
            .as_ref()
            .map(|p| format!(" (worktree {})", p.display()))
            .or_else(|| scratch.as_ref().map(|p| format!(" (scratch {})", p.display())))
            .unwrap_or_default(),
    );
    snap_activity(
        snap,
        "dispatch",
        &format!(
            "{tid} dispatched — {}",
            if resume { "resumed session" } else { "new session" }
        ),
    );
    // live progress cell: the opencode stdout reader writes the agent's latest
    // output line here; the heartbeat reads it so the board shows mid-run activity
    let live = Arc::new(std::sync::Mutex::new(String::new()));
    let live_for_task = live.clone();
    // Mode A provisioning: inject the bridge MCP server into the spawned
    // session. Merged per-server-key with the host's own opencode config, so
    // existing MCP servers are honoured. The MCP auth uses a PER-AGENT token
    // the gateway provisions from the hub on the worker's behalf (per agent,
    // not per session) — board actions attribute to the agent, not the
    // gateway. Identity law (BR#2455): this app is a gateway; the pair flow
    // vends a gw-* token; run_loop refuses to start on anything else.
    // machine/agent naming: the worker identity lives UNDER its gateway
    // (<gateway>.<agent>) — ownership filtering is then a prefix glob
    // (machinename/*), and the namespace survives re-pairings because the
    // gateway label is the stable root.
    let agent_label = match &cfg.label {
        Some(l) if !l.is_empty() => format!("{l}/{}", agent_segment(cfg)),
        _ => agent_identity(cfg),
    };
    // Provision the worker's per-agent token. There is NO second class check
    // here: the token secret is opaque (bkw_*), so a prefix test can never
    // work, and the class gate is run_loop's (config gateway flag). If
    // provisioning fails there is no fallback — dispatching under the
    // gateway's own token would mis-attribute every board action. Release
    // the claim instead; transient hub failures self-heal next tick (the
    // runner may release its own claims, BR#2419).
    let agent_token = match provision_agent_token(cfg, &agent_label) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[dispatch] ERROR: agent token provisioning failed for {agent_label}: {e} — no fallback (gateway token would mis-attribute); releasing claim");
            snap_activity(snap, "error", &format!("agent token provisioning failed for {agent_label}: {e} — claim released, no fallback attribution"));
            release_claim(
                cfg,
                tid,
                &format!("runner: per-agent token provisioning failed ({e}) — claim released; no gateway-token fallback"),
            );
            return;
        }
    };
    let mcp_json = if cfg.url.is_empty() || agent_token.is_empty() {
        None
    } else {
        Some(
            json!({
                "$schema": "https://opencode.ai/config.json",
                "model": model_str, // ACP ignores --model; the injected config is how the session learns its model
                "mcp": { "bridge": {
                    "type": "remote",
                    "url": format!("{}/mcp", cfg.url.trim_end_matches('/')),
                    "enabled": true,
                    "oauth": false,
                    "headers": { "Authorization": format!("Bearer {}", agent_token) }
                }}
            })
            .to_string(),
        )
    };
    let outcome = {
        let cfg2 = cfg.clone();
        let tid2 = tid.to_string();
        let bin = bc.bin.clone();
        let (tx, rx) = std::sync::mpsc::channel::<opencode::RunOutcome>();
        std::thread::spawn(move || {
            let backend = opencode::Backend::parse(cfg2.backend.as_deref());
            let cli_bin = bin.as_deref().unwrap_or(&cfg2.opencode_bin);
            let out = opencode::run_task(
                &run_dir,
                cli_bin,
                backend,
                agent_profile.as_deref(),
                Some(model_str.as_str()).filter(|s| !s.is_empty()),
                &prompt,
                Duration::from_secs(cfg2.timeout_mins * 60),
                Some(&format!("bridge-{tid2}")),
                resume_session.as_deref(),
                mcp_json.as_deref(),
                bc_mode.as_deref(),
                Some(live_for_task),
            );
            if backend == opencode::Backend::Kiro {
                if let Some(sid) = &out.session_id {
                    save_session_id(&tid2, sid);
                }
            }
            let _ = tx.send(out);
        });
        rx
    };
    in_flight.push(InFlight {
        task_id: tid.to_string(),
        task_title: title.to_string(),
        role_work,
        started: std::time::Instant::now(),
        last_note: String::new(),
        worktree,
        scratch,
        pr_url: None,
        rx: outcome,
        live,
    });
    // ephemeral state file: headless observability (removed on completion)
    write_task_state(
        tid,
        &serde_json::json!({
            "task_id": tid,
            "task_title": title,
            "status": if resume { "resumed" } else { "running" },
            "started_ts": now_ms(),
            "session": resume_session_for_state,
            "worktree": in_flight.last().and_then(|i| i.worktree.clone()).map(|p| p.to_string_lossy().to_string()),
        }),
    );
    snap_in_flight_list(snap, in_flight);
}

/// Dispatch circuit breaker: N consecutive failed/void dispatches with the
/// same error signature means the AGENT CLI is broken (auth, server down,
/// guardrails) — not the tasks. Claiming more work just burns the queue:
/// every session dies the same way, each attempt spins tasks through
/// blocked/unblock cycles. Break the loop: stop claiming, surface the error
/// prominently, resume on the first successful run (or manual restart).
#[derive(Default)]
struct CircuitBreaker {
    consecutive_failures: u32,
    last_signature: String,
    tripped: bool,
}
impl CircuitBreaker {
    const THRESHOLD: u32 = 3;
    fn record_failure(&mut self, stdout: &str, stderr: &str) {
        // BR#3337: claim-race output is benign, self-healing noise — the agent
        // CLI is healthy. Neither count it toward the streak nor reset the
        // streak a real failure started.
        if claim_race_run(stdout, stderr) {
            return;
        }
        let sig = ["Unexpected server error", "Model blocked by guardrail", "0 endpoints out of", "no endpoints are available matching your guardrail", "UnknownError"]
            .iter().find(|s| stdout.contains(*s) || stderr.contains(*s))
            .map(|s| s.to_string())
            .unwrap_or_else(|| "other".into());
        if sig == self.last_signature || self.consecutive_failures == 0 {
            self.consecutive_failures += 1;
        } else {
            self.consecutive_failures = 1;
        }
        self.last_signature = sig;
        if self.consecutive_failures >= Self::THRESHOLD && !self.tripped {
            self.tripped = true;
        }
    }
    fn record_success(&mut self) {
        self.consecutive_failures = 0;
        self.last_signature.clear();
        self.tripped = false;
    }
    fn tripped(&self) -> bool { self.tripped }
}

fn tick(
    cfg: &DispatchConfig,
    id: &mut i64,
    in_flight: &mut Vec<InFlight>,
    attempts: &mut HashMap<String, Instant>,
    fail_counts: &mut HashMap<String, u32>,
    finished_no_pr: &mut HashSet<String>,
    gave_up: &mut HashSet<String>,
    snap: &SharedSnapshot,
    avail: &mut Vec<opencode::Backend>,
    last_avail_ok: &mut bool,
    breaker: &mut CircuitBreaker,
    live_notes: &mut HashMap<String, (String, Instant, Instant)>,
    gated_announced: &mut HashSet<String>,
) -> Result<Vec<String>, String> {
    let mut msgs = Vec::new();

    // dispatchability gate: re-check every tick (cheap: one --version per
    // backend). No dispatchable agent -> never claim, never orient; drain
    // in-flight sessions, then EXIT non-zero. This is fatal, not a wait
    // state: the old behaviour edge-printed the error once and sat silent
    // behind a "healthy" systemd unit for hours (hermes, 2026-10-23 — the
    // single stderr line landed in an unreadable journal). Now: loud every
    // tick while draining, then exit(1) — systemd reports the failure and
    // Restart=on-failure retries every 10s, re-reporting until fixed.
    *avail = available_backends(cfg);
    let avail_ok = !avail.is_empty();
    if !avail_ok {
        let msg = "FATAL: no dispatchable agents (CLI missing/unrunnable or model unconfigured) — run `bridge doctor`; exiting so systemd reports it (in-flight sessions drain first)";
        eprintln!("[dispatch] {msg}");
        snap_activity(snap, "error", msg);
        if in_flight.is_empty() {
            std::process::exit(1);
        }
    } else if !*last_avail_ok {
        eprintln!("[dispatch] agents available — resuming claims");
        snap_activity(snap, "info", "agents available — resuming claims");
    }
    *last_avail_ok = avail_ok;

    // worktree hygiene: every 10 ticks reconcile disk worktrees with task
    // state — done/released tasks must not hold ~/.bridge/worktrees/<slug>
    let n = SWEEP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    if n % 10 == 0 {
        sweep_stale_worktrees(cfg, id, in_flight, &mut msgs);
    }

    // 1. drain finished sessions: finalize each (progress + in_review + cleanup)
    let mut finished: Vec<(InFlight, opencode::RunOutcome)> = Vec::new();
    in_flight.retain_mut(|inf| match inf.rx.try_recv() {
        Ok(outcome) => {
            finished.push((
                InFlight {
                    task_id: inf.task_id.clone(),
                    task_title: inf.task_title.clone(),
                    role_work: inf.role_work,
                    started: inf.started,
                    last_note: inf.last_note.clone(),
                    pr_url: inf.pr_url.clone(),
                    worktree: inf.worktree.clone(),
                    scratch: inf.scratch.clone(),
                    rx: std::sync::mpsc::channel().1,
                    live: inf.live.clone(),
                },
                outcome,
            ));
            false
        }
        Err(TryRecvError::Empty) => true,
        Err(TryRecvError::Disconnected) => {
            // sender thread died without sending (panic) — treat as failure
            finished.push((
                InFlight {
                    task_id: inf.task_id.clone(),
                    task_title: inf.task_title.clone(),
                    role_work: inf.role_work,
                    started: inf.started,
                    last_note: inf.last_note.clone(),
                    pr_url: inf.pr_url.clone(),
                    worktree: inf.worktree.clone(),
                    scratch: inf.scratch.clone(),
                    rx: std::sync::mpsc::channel().1,
                    live: inf.live.clone(),
                },
                opencode::RunOutcome {
                    ok: false,
                    exit_code: None,
                    timed_out: false,
                    stdout_tail: String::new(),
                    stderr_tail: "runner thread died (no outcome)".into(),
                    session_id: None,
                },
            ));
            false
        }
    });
    if !finished.is_empty() {
        snap_in_flight_list(snap, in_flight);
    }
    // liveness vouch: a session whose stdout/ACP stream is moving is WORKING.
    // Vouch via the session_alive op (watchdog signal only — no board event,
    // no progress entry), throttled to one call per ~4m per task and only
    // when the live line actually changed. The watchdog's 10m stall release
    // then fires on genuinely dead sessions — not on long quiet stretches of
    // real work (the churn epidemic: TASK-001 11x, BR#50 11x, BR#552 18x,
    // BR#911 19x were all live sessions released as "stalled"). Agent
    // narration keeps flowing over MCP log_progress as before; this is the
    // runner vouching for the machinery underneath it.
    for inf in in_flight.iter() {
        let line = inf.live_line();
        let e = live_notes
            .entry(inf.task_id.clone())
            .or_insert_with(|| (line.clone(), Instant::now(), Instant::now()));
        if e.0 != line {
            // operator-visible chatter: the agent's latest output line, head
            // only, throttled to 1/60s per task. A quiet console here reads
            // as "hung" to anyone watching (fleet incident 2026-10-22: three
            // healthy sessions declared timed out looked dead because none
            // of their output was visible until the verdict).
            if e.2.elapsed() >= Duration::from_secs(60) && !line.is_empty() {
                eprintln!(
                    "[dispatch] {} · {}m in · {}",
                    inf.task_id,
                    inf.started.elapsed().as_secs() / 60,
                    line
                );
                e.2 = Instant::now();
            }
            if e.1.elapsed() >= Duration::from_secs(240) {
                let _ = mcp_call(
                    cfg,
                    id,
                    "session_alive",
                    json!({ "id": inf.task_id }),
                );
                e.1 = Instant::now();
            }
            e.0 = line;
        }
    }

    for (mut inf, outcome) in finished {
        // BR#2460: scratch dirs are disposable on every exit path (yield
        // included) — the board is the only deliverable, and a resumed run
        // gets a fresh scratch dir. Unlike worktrees, they hold no resume
        // assets.
        live_notes.remove(&inf.task_id);
        if let Some(s) = inf.scratch.take() {
            let _ = std::fs::remove_dir_all(s);
        }
        let mins = inf.started.elapsed().as_secs() / 60;
        let pr_url = extract_pr(&outcome.stdout_tail);
        inf.pr_url = pr_url.clone();
        let tail = if outcome.stdout_tail.is_empty() {
            outcome.stderr_tail.clone()
        } else {
            outcome.stdout_tail.clone()
        };
        let exit_txt = match outcome.exit_code {
            Some(0) => "exit 0".to_string(),
            Some(c) => format!("exit {c}"),
            None if outcome.timed_out => "killed on timeout".to_string(),
            None => "no exit (crashed?)".to_string(),
        };
        let mut note = format!(
            "runner: run finished — {}, ~{mins}m — {}",
            exit_txt, tail
        );
        if let Some(pr) = &pr_url {
            note.push_str(&format!("\nPR: {pr}"));
        }
        // CLI log: the agent's final reply (first lines, capped) — the full
        // note goes to the bridge via log_progress below.
        let reply_excerpt: String = {
            let lines: Vec<&str> = tail.lines().take(4).collect();
            let mut s = lines.join(" | ");
            if s.chars().count() > 300 {
                s = s.chars().take(300).collect::<String>() + "…";
            }
            s
        };
        let outcome_ok = outcome.ok && !void_run(&outcome.stdout_tail, &outcome.stderr_tail);
        // BR#3352: an ok run with an EMPTY result payload is a delivery loss,
        // not a clean finish — the hub would receive a bare "run finished"
        // with nothing to verify while the side effects (worktree, PRs) sit
        // on disk/GitHub. Record the outcome class + the local receipts so
        // the board can distinguish "ran, report lost" from "abandoned" and
        // flag the delivery channel instead of scoring an abandonment.
        let result_lost = outcome_ok && tail.trim().is_empty();
        if result_lost {
            note.push_str(&format!(
                "\ncompleted_result_lost — agent reply was empty (result payload lost in capture){}",
                result_lost_receipts(inf.worktree.as_ref().and_then(|p| p.to_str()), pr_url.as_deref())
            ));
        }
        eprintln!(
            "[dispatch] {} {} in ~{}m — agent reply: {}",
            inf.task_id,
            if outcome.timed_out {
                "TIMED OUT"
            } else if !outcome_ok {
                "FAILED"
            } else {
                "finished"
            },
            mins,
            reply_excerpt
        );
        // final progress (with 100% on success) is logged AFTER the handoff —
        // a task must never sit in_progress showing 100% because a gate
        // rejected the close. See the handoff match below.
        // hard rule (BR#877): a run that performed no work — non-zero exit,
        // timeout, or a guardrail-void dispatch — can NEVER hand off. Void
        // runs still exit 0, so the exit code alone is not enough.
        if outcome_ok {
            breaker.record_success();
        } else if claim_race_run(&outcome.stdout_tail, &outcome.stderr_tail) {
            // BR#3337: a session that died racing for a claim performed no
            // work and proves nothing about the agent CLI — not a dispatch
            // failure, the breaker stays untouched.
            eprintln!(
                "[dispatch] {} lost a claim race (gate rejections, no work) — not a dispatch failure",
                inf.task_id
            );
            snap_activity(snap, "info", &format!("{} — claim race, not a dispatch failure", inf.task_id));
        } else {
            breaker.record_failure(&outcome.stdout_tail, &outcome.stderr_tail);
        }
        // persist final state (incl. PR link and exit code) before handoff
        write_task_state(
            &inf.task_id,
            &serde_json::json!({
                "task_id": &inf.task_id,
                "task_title": &inf.task_title,
                "status": if outcome_ok { "finished" } else { "failed" },
                "started_ts": now_ms() - inf.started.elapsed().as_millis() as u64,
                "ended_ts": now_ms(),
                "exit_code": outcome.exit_code,
                "pr_url": &pr_url,
                "last_note": &note,
                "stdout_tail": &outcome.stdout_tail,
                "result_lost": result_lost,
            }),
        );        if outcome_ok {
            // YIELD check first: the agent may have blocked/bounced/closed the
            // task mid-run (ask filed, yielded per the contract). Query the live
            // status — if the task is no longer in_progress, the agent's state
            // change is authoritative: release the slot, KEEP the worktree and
            // session (they're the resume assets), touch nothing server-side.
            let live_status = mcp_call(cfg, id, "get_artefact", json!({ "id": inf.task_id }))
                .ok()
                .and_then(|v| v.get("status").and_then(|s| s.as_str()).map(String::from));
            if let Some(st) = &live_status {
                if st != "in_progress" {
                    attempts.remove(&inf.task_id);
                    // the task left the runner (agent blocked/bounced/closed it
                    // mid-run) — drop the ephemeral state file too, not just on
                    // handoff; a retained file made finished tasks look in-flight
                    remove_task_state(&inf.task_id);
                    // BR#3352: a completed run's result must reach the hub
                    // even when the claim was lost mid-run. A watchdog release
                    // ("stalled") while the session kept working is NOT the
                    // agent yielding — dropping the result here is exactly the
                    // "ran, report lost" class the board then scored as
                    // abandoned. todo → re-claim and hand the finished work
                    // off below; any other state was the agent's own deliberate
                    // move → deliver the result as a note and touch nothing.
                    if st == "todo" {
                        match mcp_call_task(
                            cfg,
                            id,
                            "transition",
                            json!({
                                "id": inf.task_id,
                                "to": "in_progress",
                                "note": "runner: re-claiming a COMPLETED run — the watchdog released it mid-run while the session kept working; handing the finished work off",
                            }),
                            &inf.task_id,
                        ) {
                            Ok(_) => {
                                snap_activity(snap, "info", &format!("{} re-claimed a completed run (was released mid-run) — handing off", inf.task_id));
                                msgs.push(format!("{} — completed run re-claimed after a mid-run release; handing off", inf.task_title));
                            }
                            Err(e) => {
                                // claim raced (another agent picked it up) or a
                                // gate refused — fall back to delivering the
                                // result as a note; the hub still learns what
                                // happened either way.
                                snap_activity(snap, "info", &format!("{} re-claim after release failed: {} — delivering result as a note", inf.task_id, truncate(&e, 80)));
                                let late_note = if tail.trim().is_empty() {
                                    format!(
                                        "completed_result_lost — run finished ({exit_txt}, ~{mins}m) after the claim was lost; agent reply was empty (result payload lost in capture){} — result delivered late by the runner",
                                        result_lost_receipts(inf.worktree.as_ref().and_then(|p| p.to_str()), pr_url.as_deref())
                                    )
                                } else {
                                    format!("runner: run finished AFTER release ({exit_txt}, ~{mins}m) — result delivered late: {}", truncate(&tail, 400))
                                };
                                let _ = mcp_call_task(
                                    cfg,
                                    id,
                                    "log_progress",
                                    json!({ "id": inf.task_id, "note": late_note, "sentiment": "neutral" }),
                                    &inf.task_id,
                                );
                                msgs.push(format!("{} — completed after release; result delivered as a note (re-claim failed: {})", inf.task_title, truncate(&e, 60)));
                                continue;
                            }
                        }
                    } else {
                        let late_note = if tail.trim().is_empty() {
                            format!(
                                "completed_result_lost — run finished ({exit_txt}, ~{mins}m) but the task is now {st}; agent reply was empty (result payload lost in capture){} — result delivered late by the runner",
                                result_lost_receipts(inf.worktree.as_ref().and_then(|p| p.to_str()), pr_url.as_deref())
                            )
                        } else {
                            format!("runner: run finished AFTER the task moved to {st} ({exit_txt}, ~{mins}m) — result delivered late: {}", truncate(&tail, 400))
                        };
                        let _ = mcp_call_task(
                            cfg,
                            id,
                            "log_progress",
                            json!({ "id": inf.task_id, "note": late_note, "sentiment": "neutral" }),
                            &inf.task_id,
                        );
                    }
                    if st != "todo" {
                        snap_activity(snap, "info", &format!("{} yielded — task now {}, session retained for resume", inf.task_id, st));
                        msgs.push(format!("{} yielded ({}) — released, worktree + session kept", inf.task_title, st));
                        continue;
                    }
                }
            }
            // VERIFY/ANALYSIS tasks ARE the review: their completion closes them
            // (done with receipts in the note) — pushing them to in_review would
            // demand a review of a review and loop forever. IMPL tasks hand off
            // to in_review (a Verify child then checks the PR).
            // role tags recorded at claim time are authoritative; the title
            // heuristic remains as fallback for legacy in-flight entries
            let title_lower = inf.task_title.to_lowercase();
            let is_review_work = inf.role_work
                || title_lower.starts_with("verify:") || title_lower.contains("verify ")
                || title_lower.contains("analysis child") || title_lower.contains("review child")
                || title_lower.starts_with("receipt");
            let receipt_note = if pr_url.is_some() {
                note.clone()
            } else {
                format!("{note}\nverified against: task artefact + history receipts (exit 0, session dispatch-{})", slugify(&inf.task_id))
            };
            // worker-lane signal: a session that ended with BR-BLOCKED: hit a
            // blocker mid-run. The gateway files the block (and the ask the
            // session cannot file itself — it has no bridge access). This
            // takes precedence over done/in_review handoff.
            let blocked_marker = outcome
                .stdout_tail
                .lines()
                .rev()
                .find_map(|l| l.trim().strip_prefix("BR-BLOCKED:").map(|r| r.trim().to_string()));
            let (transition_to, handoff_note) = if let Some(reason) = &blocked_marker {
                ("blocked", format!("worker session blocked itself — {reason}"))
            } else if is_review_work {
                ("done", receipt_note)
            } else {
                ("in_review", note)
            };
            match mcp_call_task(
                cfg,
                id,
                "transition",
                json!({
                    "id": inf.task_id,
                    "to": transition_to,
                    "note": handoff_note,
                    "unblock_condition": blocked_marker.as_deref().unwrap_or(""),
                }),
                &inf.task_id,
            ) {
                Ok(_) => {
                    // handoff succeeded — NOW the task may show 100%: the run's
                    // duty is complete (done, or impl complete awaiting verify)
                    let _ = mcp_call_task(
                        cfg,
                        id,
                        "log_progress",
                        json!({
                            "id": inf.task_id,
                            "note": format!("runner: handed off to {} — complete", transition_to),
                            "sentiment": "converging",
                            "completion_pct": 100,
                        }),
                        &inf.task_id,
                    );
                    remove_task_state(&inf.task_id);
                    attempts.remove(&inf.task_id);
                    finished_no_pr.insert(inf.task_id.clone());
                    if transition_to == "done" && inf.worktree.is_some() {
                        // terminal: worktree + branch served their purpose —
                        // the teardown sweep preserves uncommitted state onto
                        // wip/<task>-<date> before the tree goes (BR#3204:
                        // branch, never main; the PR branch itself is dropped)
                        if let Some(preserved) = cleanup_worktree_at(inf.worktree.as_ref().unwrap(), &inf.task_id, true) {
                            msgs.push(format!("{} — teardown sweep preserved WIP on {preserved}", inf.task_id));
                        }
                    }
                    msgs.push(format!(
                        "{} → {}{}",
                        inf.task_title,
                        transition_to,
                        pr_url.as_ref().map(|p| format!(" — PR {p}")).unwrap_or_default()
                    ));
                }
                Err(e) => {
                    // gate rejected the handoff (e.g. receipts rejected, no PR).
                    // BR#2419: the runner owns no state semantics — release the
                    // claim back to the pool with the rejection as the note.
                    // The worker owns consequences: its gates emitted this
                    // rejection, its churn guard redirects repeats (escalate
                    // verdict duties at 3 releases, redirect impl at 5), its
                    // audit records everything.
                    let release_note = format!(
                        "runner: handoff to {transition_to} rejected — {e}. Run completed (~{mins}m, exit 0); session + worktree retained.",
                    );
                    match mcp_call_task(
                        cfg,
                        id,
                        "transition",
                        json!({ "id": inf.task_id, "to": "todo", "note": release_note }),
                        &inf.task_id,
                    ) {
                        Ok(_) => {
                            snap_activity(snap, "info", &format!("{} released after handoff rejection", inf.task_id));
                            msgs.push(format!("{} → todo (handoff rejected: {}) — worker churn guard owns repeats", inf.task_title, truncate(&e, 100)));
                        }
                        Err(e2) => {
                            msgs.push(format!("{} handoff AND release failed: {e2} — manual attention needed", inf.task_title));
                        }
                    }
                    finished_no_pr.insert(inf.task_id.clone());
                    remove_task_state(&inf.task_id);
                }
            }
        } else {
            // deterministic config errors (bad agent profile, bad model id,
            // auth) replay identically on every retry — retrying is pure
            // churn. BR#2419: release the claim (state semantics live in the
            // worker); stop retrying ON THIS HOST only.
            if is_config_error(&outcome.stdout_tail) || is_config_error(&outcome.stderr_tail) {
                let release_note = format!(
                    "runner: agent CLI config error (deterministic — not retrying on this host): {}",
                    truncate(&tail, 220)
                );
                let _ = mcp_call(
                    cfg,
                    id,
                    "transition",
                    json!({
                        "id": inf.task_id,
                        "to": "todo",
                        "note": release_note,
                    }),
                );
                gave_up.insert(inf.task_id.clone());
                attempts.remove(&inf.task_id);
                fail_counts.remove(&inf.task_id);
                remove_task_state(&inf.task_id);
                msgs.push(format!("{} released (agent config error — no retries on this host): {}", inf.task_title, truncate(&tail, 120)));
                snap_activity(snap, "error", &format!("{} released — deterministic agent config error", inf.task_id));
                if let Some(wt) = &inf.worktree {
                    // released (config error): branch kept for re-claim, WIP
                    // preserved onto wip/<task>-<date> before the tree goes
                    if let Some(preserved) = cleanup_worktree_at(wt, &inf.task_id, false) {
                        msgs.push(format!("{} — teardown sweep preserved WIP on {preserved}", inf.task_id));
                    }
                }
                snap_activity(snap, "finish", &msgs.last().cloned().unwrap_or_default());
                continue;
            }
            // failed/timed out — backoff and retry, capped. Retry loops must
            // NOT keep logging progress on the task: every runner note
            // refreshes last_progress.ts and defeats the watchdog (the task
            // then looks alive forever while the session does nothing).
            let n = fail_counts.entry(inf.task_id.clone()).or_insert(0);
            *n += 1;
            let fails = *n;
            if fails >= 3 {
                let void_cause = void_run(&outcome.stdout_tail, &outcome.stderr_tail);
                let note = if void_cause {
                    "runner: dispatch VOID — provider guardrails blocked the model (0 endpoints), no work performed, 3 attempts — released for attention (BR#877: void runs never hand off as complete)"
                } else {
                    "runner: opencode failed 3 attempts (last: timed out or exited non-zero) — released for attention"
                };
                let _ = mcp_call(
                    cfg,
                    id,
                    "transition",
                    json!({
                        "id": inf.task_id,
                        "to": "todo",
                        "note": note,
                    }),
                );
                gave_up.insert(inf.task_id.clone());
                attempts.remove(&inf.task_id);
                fail_counts.remove(&inf.task_id);
                remove_task_state(&inf.task_id);
                msgs.push(format!("{} failed {}x — released for attention (no more runner retries on this host)", inf.task_title, fails));
            } else {
                attempts.insert(inf.task_id.clone(), Instant::now());
                msgs.push(format!("{} failed/timed out — left in_progress (backoff, attempt {}/3)", inf.task_title, fails));
            }
        }
        // PR monitoring v1: record the handoff so the review flow can be tracked;
        // automated verdict reaction (CI fail → bounce + fix) lands with the PR watch loop
        if let Some(pr) = pr_url {
            let _ = mcp_call(
                cfg,
                id,
                "log_progress",
                json!({ "id": inf.task_id, "note": format!("runner: watching PR {pr} — awaiting verify verdict"), "sentiment": "neutral" }),
            );
        }
        // worktree + branch persist through in_review / bounce / failure — they
        // are the handoff assets (session resume or branch checkout). Only a
        // terminal `done` (handled above) tears them down.
        snap_activity(snap, "finish", &msgs.last().cloned().unwrap_or_default());
    }

    // relay, not heartbeat: the AGENT owns progress callbacks. The runner only
    // RELAYS the agent's actual stdout line — real agent output, attributed as
    // a relay — so the board never shows fabricated progress. With human-style
    // reporting (the default), agents narrate milestones in their stdout, so
    // the relay is the liveness signal; when the agent is silent (no output
    // yet, or unchanged since the last poll) the relay stays quiet — a bare
    // "alive Nm" line every poll doubles context re-reads for no information.
    // A liveness fallback only exists in explicit report_minutes mode.
    for inf in in_flight.iter_mut() {
        let live = inf.live_line();
        if live.is_empty() {
            if cfg.report_minutes.is_some() {
                let mins = inf.started.elapsed().as_secs() / 60;
                if let Err(e) = mcp_call(
                    cfg,
                    id,
                    "log_progress",
                    json!({
                        "id": inf.task_id,
                        "note": format!("runner: alive ~{mins}m, no agent output yet"),
                        "sentiment": "neutral",
                    }),
                ) {
                    eprintln!("[dispatch] ERROR: relay failed for {}: {e}", inf.task_id);
                }
            }
            continue;
        }
        if inf.last_note == live {
            continue; // unchanged since last poll — nothing new to relay
        }
        let note = format!("runner: agent output — {live}");
        if let Err(e) = mcp_call(
            cfg,
            id,
            "log_progress",
            json!({
                "id": inf.task_id,
                "note": note,
                "sentiment": "neutral",
            }),
        ) {
            eprintln!("[dispatch] ERROR: relay failed for {}: {e}", inf.task_id);
        } else if let Ok(mut s) = snap.lock() {
            if let Some(f) = s.in_flight.iter_mut().find(|f| f.task_id == inf.task_id) {
                f.last_note = live.clone();
            }
        }
    }
    if !in_flight.is_empty() {
        snap_in_flight_list(snap, in_flight);
    }

    // 3. capacity? nothing to schedule if all sessions busy
    if in_flight.len() >= cfg.max_sessions {
        return Ok(msgs);
    }

    // 3b. dispatchability gate: no agents -> do not orient, do not claim
    if !avail_ok {
        return Ok(msgs);
    }

    // 3c. circuit breaker: agent CLI is failing deterministically — stop
    // claiming. In-flight sessions keep finishing; the breaker clears on the
    // first success or a runner restart after the environment is fixed.
    if breaker.tripped() {
        msgs.push(format!(
            "CIRCUIT BREAKER — {} consecutive dispatch failures ({}). Not claiming new work: fix the agent CLI/auth, then restart the runner.",
            breaker.consecutive_failures, breaker.last_signature
        ));
        return Ok(msgs);
    }

    // 4. orient — once per tick when we have capacity
    let orient = mcp_call(cfg, id, "orient", json!({}))?;
    // BR#2844: silent zeros die here. A drifted orient shape (the renamed-key
    // incident that emptied the work lists) is now a loud tick error naming
    // the drift, not an empty candidate list that looks like a quiet board.
    orient_contract_error(&orient)?;
    let policy = orient
        .get("instructions")
        .and_then(|v| v.as_str())
        .unwrap_or("Follow the bridge protocol card: claim before coding, heartbeat every 10 min, ask when uncertain, finish with a PR.")
        .to_string();

    // 5. previously-dispatched work still open → RESUME it first (claims persist;
    // the opencode session is rediscoverable by its deterministic title
    // bridge-<task_id>, so mid-flight runs survive runner/app restarts).
    let my_tasks = orient
        .get("my_tasks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let sessions = session_map(&cfg.opencode_bin, &cfg.workdir);
    let open_mine: Vec<&serde_json::Value> = my_tasks
        .iter()
        .filter(|t| t.get("status").and_then(|s| s.as_str()) == Some("in_progress"))
        .collect();
    // BR#2844: a malformed item (missing id/title) is tolerated — one weird
    // row must not zero the list — but it is never silent.
    let mut malformed_my_tasks = 0usize;
    for t in open_mine {
        if in_flight.len() >= cfg.max_sessions {
            break;
        }
        let (Some(tid), Some(title)) = (
            t.get("id").and_then(|v| v.as_str()),
            t.get("title").and_then(|v| v.as_str()),
        ) else {
            malformed_my_tasks += 1;
            continue;
        };
        if in_flight.iter().any(|inf| inf.task_id == tid) {
            continue; // already running
        }
        // terminal: opencode already finished this task without a PR (analysis
        // /verification work). Never re-dispatch a completed session.
        if finished_no_pr.contains(tid) || gave_up.contains(tid) {
            continue;
        }
        // backoff: a task that just failed to spawn shouldn't retry every tick
        if gave_up.contains(tid) {
            continue; // handed off for attention — the watchdog owns it now
        }
        if attempts
            .get(tid)
            .map(|a| a.elapsed() < Duration::from_secs(300))
            .unwrap_or(false)
        {
            continue; // silent backoff: runner bookkeeping must not look like agent activity
        }
        // BR#3337: liveness check FIRST — never claim-and-fail a race.
        // get_artefact re-reads the card fresh (the orient slice can be
        // seconds stale) and carries the hub heartbeat in meta
        // (session_alive_ts / last_progress.ts).
        let art = mcp_call(cfg, id, "get_artefact", json!({ "id": tid })).unwrap_or(json!({}));
        let body_md = art.get("body_md").and_then(|b| b.as_str()).map(String::from).unwrap_or_default();
        let task_meta = art.get("meta").cloned().unwrap_or(json!({}));
        let meta_obj = task_meta.as_object();
        let sess = find_session(&sessions, tid);
        let disposition = claim_liveness(
            sess.and_then(|s| s.updated_ms),
            meta_obj.and_then(|m| m.get("session_alive_ts")).and_then(|v| v.as_u64()),
            meta_obj
                .and_then(|m| m.get("last_progress"))
                .and_then(|p| p.get("ts"))
                .and_then(|v| v.as_u64()),
            now_ms(),
        );
        match disposition {
            ClaimLiveness::Live => {
                // a live session owns this card — skip silently. Re-dispatching
                // into a live session would double-spawn it; resuming a live
                // session would race it. Its own MCP calls deliver the work.
                continue;
            }
            ClaimLiveness::Stale => {
                // the dispatched session died holding its claim: release the
                // stale claim (in_progress → todo), then claim fresh and spawn
                // a new session (never resume a dead conversation).
                // BR#3823: only when the LIVE card still says so. The slice +
                // liveness verdict can be stale by the time we act — the
                // watchdog stall-release may have already redirected the card
                // (blocked) or another dispatcher may hold it. Re-check the
                // freshly-fetched card: still in_progress AND still attributed
                // to this runner, else skip the release, the note, and the
                // re-claim (debug only — the card is not ours to release).
                let mine = agent_identity(cfg);
                if !stale_claim_live(&art, &mine) {
                    eprintln!(
                        "[dispatch] {tid}: stale-claim check — card now {status}/{owner} (not in_progress/not mine) — skipping release + re-claim (BR#3823)",
                        status = art.get("status").and_then(|v| v.as_str()).unwrap_or("?"),
                        owner = art.get("owner").and_then(|v| v.as_str()).unwrap_or("?"),
                    );
                    snap_activity(
                        snap,
                        "info",
                        &format!("{tid} stale-claim skipped — card moved on, not ours to release (BR#3823)"),
                    );
                    continue;
                }
                match release_claim(cfg, tid, "runner: stale claim released — session died") {
                    ReleaseOutcome::Released => {}
                    ReleaseOutcome::ClaimRace => {
                        // the release was refused (claim race) — the card was
                        // NOT released, so there is nothing to re-claim: the
                        // card is the watchdog's or another dispatcher's now.
                        eprintln!("[dispatch] {tid}: stale release raced (gate refused) — card not released, skipping re-claim (BR#3823)");
                        snap_activity(snap, "info", &format!("{tid} stale release raced — skipped (BR#3823)"));
                        continue;
                    }
                    ReleaseOutcome::Failed(e) => {
                        eprintln!("[dispatch] ERROR: stale release {tid} failed: {e}");
                        snap_activity(snap, "error", &format!("stale release {tid} failed: {e}"));
                        attempts.insert(tid.to_string(), Instant::now());
                        continue;
                    }
                }
                // BR#3823: the re-claim leg carries a resolution note — if the
                // card was redirected to blocked between our release and this
                // claim, the note re-stamps the card's own blocked reason +
                // unblock condition so the blocked → in_progress leg passes
                // unblock-needs-resolution (a note-less re-claim there folded
                // as a second breach-'other', specimen BR#3299).
                let live = mcp_call(cfg, id, "get_artefact", json!({ "id": tid })).unwrap_or(json!({}));
                let reclaim_note = reclaim_resolution_note(&live);
                match mcp_call_task(
                    cfg,
                    id,
                    "transition",
                    json!({ "id": tid, "to": "in_progress", "note": reclaim_note }),
                    &tid,
                ) {
                    Ok(_) => {}
                    Err(e) if is_claim_race_error(&e) => {
                        // raced between release and re-claim — another
                        // dispatcher won the card; skip, it is theirs now
                        eprintln!("[dispatch] {tid}: stale claim released, re-claim raced — skipping");
                        snap_activity(snap, "info", &format!("{tid} re-claim raced after stale release — skipped"));
                        continue;
                    }
                    Err(e) => {
                        eprintln!("[dispatch] ERROR: re-claim {tid} failed: {e}");
                        snap_activity(snap, "error", &format!("re-claim {tid} failed: {e}"));
                        attempts.insert(tid.to_string(), Instant::now());
                        continue;
                    }
                }
                let _ = mcp_call_task(
                    cfg,
                    id,
                    "log_progress",
                    json!({ "id": tid, "note": "runner: re-claimed — stale claim released (session died), starting fresh", "sentiment": "neutral" }),
                    &tid,
                );
                let msg = format!("re-claimed {tid} — stale claim released (session died), started fresh");
                let (role_work, role_type) = t.get("tags").and_then(|v| v.as_array()).map(|a| {
                    let rt = a.iter().filter_map(|x| x.as_str()).find(|s| s.starts_with("role:")).map(|s| s.trim_start_matches("role:").to_string());
                    (rt.is_some(), rt.unwrap_or_else(|| "task".into()))
                }).unwrap_or((false, "task".to_string()));
                spawn_opencode(cfg, snap, tid, title, &body_md, &task_meta, &policy, None, role_work, &role_type, avail, in_flight);
                attempts.insert(tid.to_string(), Instant::now());
                snap_activity(snap, "dispatch", &msg);
                msgs.push(msg);
            }
        }
    }
    if malformed_my_tasks > 0 {
        msgs.push(format!(
            "WARN: {malformed_my_tasks} my_tasks item(s) missing id/title — hub contract drift (BR#2844, packages/contracts)"
        ));
    }

    // 6. claim new claimable tasks until the WIP limit is reached.
    // BR#2419: blocked tasks are NOT candidates — resuming them is an unblock
    // duty's verdict, never a client transition. The runner only claims todo
    // work. RESUME preference: a candidate we hold an opencode session AND
    // worktree for sorts first — resuming that session restores full context
    // cheaply, which is how a task that yielded earlier routes back to "the
    // same agent".
    let candidates = orient
        .get("unclaimed_work")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut candidates: Vec<(serde_json::Value, Option<String>)> = candidates
        .into_iter()
        .map(|t| {
            let tid = t.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let sess = find_session(&sessions, &tid).map(|s| s.id.clone());
            (t, sess)
        })
        .collect();
    candidates.sort_by(|a, b| {
        let ra = if a.1.is_some() { 0 } else { 1 };
        let rb = if b.1.is_some() { 0 } else { 1 };
        ra.cmp(&rb)
    });
    // BR#2844: same law as my_tasks — one malformed candidate never zeroes
    // the dispatch surface, and it is never silent.
    let mut malformed_candidates = 0usize;
    for (task, resume_sess) in candidates {
        if in_flight.len() >= cfg.max_sessions {
            break;
        }
        let (Some(tid), Some(title)) = (
            task.get("id").and_then(|v| v.as_str()),
            task.get("title").and_then(|v| v.as_str()),
        ) else {
            malformed_candidates += 1;
            continue;
        };
        if in_flight.iter().any(|inf| inf.task_id == tid)
            || attempts
                .get(tid)
                .map(|a| a.elapsed() < Duration::from_secs(300))
                .unwrap_or(false)
        {
            continue;
        }
        // not dispatchable at all: question tasks (answered, not claimed),
        // operator gates, bar-gated work — the claim gate would reject or the
        // claim is wrong by definition. Respect the verdict; no churn.
        if task.get("needs_qualification").and_then(|q| q.as_bool()).unwrap_or(false)
            || task.get("is_claimable").and_then(|q| q.as_bool()) == Some(false)
        {
            // silence here reads as a dead runner: the queue looks full and
            // nothing moves, with no errors anywhere. Say why — once per app
            // run per task (an operator clearing the gate re-arms the note).
            if gated_announced.insert(tid.to_string()) {
                msgs.push(format!("SKIP: {tid} not claimable (qualification bars unmet) — meet the declared bars or re-issue"));
            }
            continue;
        }
        if gave_up.contains(tid) {
            continue; // escalated or handed off — the watchdog/humans own it now
        }
        // BR#2419: blocked work is not runner work. Leaving blocked is a
        // verdict delivered by a role:unblock duty or a human — never a client
        // transition. The unblock CHILD (a todo task) is what the runner
        // dispatches; it shows up here as its own candidate.
        if task.get("status").and_then(|s| s.as_str()) == Some("blocked") {
            // blocked is a verdict, and claiming it needs a resolution the
            // runner cannot invent — that is role:unblock duty. Skipping
            // silently here starved the runner in front of a full backlog:
            // ten blocked tasks filled the orient slice, every claim was
            // refused, and nothing announced why. Announce + pace.
            if gated_announced.insert(format!("{tid}:blocked")) {
                msgs.push(format!("SKIP: {tid} blocked — needs its unblock condition resolved (unblock duty or human)"));
            }
            continue;
        }
        // BR#2460: no repo gate — repo-less candidates dispatch into a scratch
        // dir with the board delivery contract. Provisioning is the runner's
        // best-effort job; capability is the agent's. Nothing is declined for
        // missing metadata.
        let art = mcp_call(cfg, id, "get_artefact", json!({ "id": tid })).unwrap_or(json!({}));
        // BR#3337: re-read the card's status at claim time — the orient slice
        // can be seconds stale, and a card another dispatcher claimed in
        // between must skip silently (race lost), never claim-and-fail.
        if let Some(st) = art.get("status").and_then(|s| s.as_str()) {
            if st != "todo" {
                eprintln!("[dispatch] {tid}: claim race lost (status now {st}) — skipping");
                snap_activity(snap, "info", &format!("{tid} claim race lost (now {st}) — skipped"));
                continue;
            }
        }
        let body_md = art.get("body_md").and_then(|b| b.as_str()).map(String::from).unwrap_or_default();
        let task_meta = art.get("meta").cloned().unwrap_or(json!({}));
        // BR#3845 self-heal: a reference this runner already refused (fatal
        // clone failure) is skipped WITHOUT claiming — the recorded refusal
        // stands until the card's repo URL changes, so a ghost reference can't
        // re-enter the claim → clone-fail → watchdog-stall loop forever. A
        // changed URL drops the record and dispatch resumes.
        let candidate_url = source_repo(&body_md, &task_meta);
        let mut refused = refused_cache_load();
        if refused_reference(&mut refused, tid, candidate_url.as_deref()) {
            let reason = refused.get(tid).map(|r| r.reason.clone()).unwrap_or_default();
            if gated_announced.insert(format!("{tid}:refused")) {
                eprintln!(
                    "[dispatch] SKIP: {tid} refused repo reference {} ({}) — fix the reference on the card to re-arm",
                    candidate_url.unwrap_or_default(),
                    reason
                );
                snap_activity(snap, "info", &format!("{tid} refused repo reference ({reason}) — skipped until it changes"));
            }
            continue;
        }
        if let Err(e) = mcp_call_task(
            cfg,
            id,
            "transition",
            json!({ "id": tid, "to": "in_progress" }),
            &tid,
        ) {
            if is_claim_race_error(&e) {
                // BR#3337: the lifecycle/ownership gate refused the claim —
                // another gateway or session owns the card. That is a claim
                // race: retryable next tick, never a dispatch failure (no
                // error bookkeeping, no backoff, breaker untouched).
                eprintln!("[dispatch] {tid}: claim raced (rejected: {}) — skipping", truncate(&e, 100));
                snap_activity(snap, "info", &format!("{tid} claim raced — skipped (retryable)"));
                continue;
            }
            // claim failed for a real reason — don't kill the tick or the whole
            // claim loop; surface it on stderr too (snap-only failures read as
            // silence) and back off this candidate
            eprintln!("[dispatch] ERROR: claim {tid} failed: {e}");
            attempts.insert(tid.to_string(), Instant::now());
            snap_activity(snap, "error", &format!("claim {tid} failed: {e}"));
            continue;
        }
        let _ = mcp_call_task(
            cfg,
            id,
            "log_progress",
            json!({ "id": tid, "note": format!("runner: claimed — dispatching to opencode"), "sentiment": "going_well" }),
            &tid,
        );
        let msg = match &resume_sess {
            Some(s) => format!("claimed {tid} — resuming opencode session {s}"),
            None => format!("claimed {tid} — dispatched to opencode"),
        };
        let (role_work, role_type) = task.get("tags").and_then(|v| v.as_array()).map(|a| {
            let rt = a.iter().filter_map(|x| x.as_str()).find(|s| s.starts_with("role:")).map(|s| s.trim_start_matches("role:").to_string());
            (rt.is_some(), rt.unwrap_or_else(|| "task".into()))
        }).unwrap_or((false, "task".to_string()));
        spawn_opencode(cfg, snap, tid, &title, &body_md, &task_meta, &policy, resume_sess, role_work, &role_type, avail, in_flight);
        attempts.insert(tid.to_string(), Instant::now());
        snap_activity(snap, "dispatch", &msg);
        msgs.push(msg);
    }
    if malformed_candidates > 0 {
        msgs.push(format!(
            "WARN: {malformed_candidates} unclaimed_work item(s) missing id/title — hub contract drift (BR#2844, packages/contracts)"
        ));
    }

    Ok(msgs)
}
pub fn run_loop(cfg: Option<DispatchConfig>, stop: Arc<AtomicBool>, running: Arc<AtomicBool>, last_error: Arc<Mutex<Option<String>>>, snap: SharedSnapshot) {
    // no config → device pairing (needs BRIDGE_URL; prints the code to console)
    let cfg = match cfg {
        Some(c) => c,
        None => match std::env::var("BRIDGE_URL") {
            Ok(url) => match pair_device(url.trim_end_matches('/')) {
                Ok(c) => {
                    if let Err(e) = c.save() {
                        eprintln!("[dispatch] ERROR: config save failed: {e}");
                    }
                    c
                }
                Err(e) => {
                    if let Ok(mut g) = last_error.lock() {
                        *g = Some(e.clone());
                    }
                    eprintln!("[dispatch] ERROR: pairing failed: {e}");
                    running.store(false, Ordering::Relaxed);
                    return;
                }
            },
            Err(_) => {
                let msg = "no config and no BRIDGE_URL — set BRIDGE_URL (or ~/.bridge/config.json) to pair".to_string();
                eprintln!("[dispatch] {msg}");
                if let Ok(mut g) = last_error.lock() {
                    *g = Some(msg);
                }
                running.store(false, Ordering::Relaxed);
                return;
            }
        },
    };
    // Identity law (BR#2455): this app is a gateway. Self-provision and
    // pairing vend a gateway-class token (gw-*); running on an agent-class
    // token is an invalid credential state — per-agent provisioning is
    // impossible and every claim would carry the wrong identity class. Log
    // out automatically: clear the dead credential and await the next login
    // (self-provision re-vends, replace-by-principal — no human click beyond
    // the login). BR#2532: a WRONG-CLASS token is a forced sign-out — the
    // reason rides the snapshot as a structured notice (an upgrading desktop
    // gets a guided sign-in, not a silent logout). An EMPTY token is plain
    // first-run onboarding: no notice, nothing was taken away.
    if cfg.token.is_empty() || cfg.gateway != Some(true) {
        let msg = if cfg.token.is_empty() {
            "no gateway token — sign in to provision this desktop's gateway".to_string()
        } else {
            let msg = "signed out automatically — the identity law reserves gateway dispatch for gateway-class tokens, and this device's saved token is not one (it predates gateway-class vending). Nothing was lost: hub URL and settings are kept, and signing in again re-vends a gateway-class token for this same device.";
            snap_logout(&snap, msg);
            msg.to_string()
        };
        eprintln!("[dispatch] {msg}");
        logout_core(&stop, &running, &snap, true);
        if let Ok(mut g) = last_error.lock() {
            *g = Some(msg.to_string());
        }
        return;
    }
    running.store(true, Ordering::Relaxed);
    // BR#2460: scratch session dirs are per-run — anything left under
    // <workdir>/sessions is an orphan from a previous run (crash/kill);
    // nothing is in flight at startup, so sweep unconditionally. Normal-path
    // cleanup happens when each run's outcome lands.
    let sessions_root = PathBuf::from(&cfg.workdir).join("sessions");
    if let Ok(entries) = std::fs::read_dir(&sessions_root) {
        for e in entries.flatten() {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
    let mut id: i64 = 0;
    let mut in_flight: Vec<InFlight> = Vec::new();
    let mut attempts: HashMap<String, Instant> = HashMap::new();
    let mut fail_counts: HashMap<String, u32> = HashMap::new();
    let mut finished_no_pr: HashSet<String> = HashSet::new();
    let mut gave_up: HashSet<String> = HashSet::new();
    let mut avail: Vec<opencode::Backend> = Vec::new();
    let mut last_avail_ok = true;
    let mut breaker = CircuitBreaker::default();
    let mut live_notes: HashMap<String, (String, Instant, Instant)> = HashMap::new();
    // gated tasks announce ONCE per app run — visibility without a flood
    let mut gated_announced: HashSet<String> = HashSet::new();
    eprintln!(
        "[dispatch] loop started — {} (poll every {}s, workdir {}, up to {} concurrent sessions)",
        cfg.url, cfg.poll_secs, cfg.workdir, cfg.max_sessions
    );
    if let Ok(mut s) = snap.lock() {
        s.running = true;
        s.url = Some(cfg.url.clone());
        s.workspace = cfg.ws.clone();
        s.label = cfg.label.clone();
        s.agent = cfg.agent.clone();
        s.workdir = Some(cfg.workdir.clone());
        s.max_sessions = cfg.max_sessions;
    }
    let mut did_logout = false;
    // Self-healing law (BR#2840, BR#3787): a hub-rejected token gets a repair
    // LADDER — agent-plane principal repair (headless-safe), then desktop
    // self-provision (human plane), then loud logout with the reason. Every
    // failure reason is logged; a successful repair re-arms for the NEXT
    // rotation. Never silent, never snap-only.
    let mut cfg = cfg;
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        // BR#3787 — negotiated catch-up at the tick boundary: the hub's epoch
        // header moved past the epoch we vended (another login/repair rotated
        // our row). Re-vend NOW, proactively — never by mid-dispatch 401.
        {
            let seen = TOKEN_EPOCH_SEEN.load(Ordering::Relaxed);
            let vend = TOKEN_EPOCH_VEND.load(Ordering::Relaxed);
            if epoch_repair_needed(vend, seen) {
                match reqwest::blocking::Client::builder()
                    .timeout(Duration::from_secs(30))
                    .build()
                    .map_err(|e| e.to_string())
                    .and_then(|client| repair_by_principal(&client, &cfg.url))
                {
                    Ok(fresh) => {
                        cfg = fresh;
                        eprintln!("[dispatch] token epoch {vend} → {seen}: re-vended by principal (proactive catch-up)");
                        snap_activity(&snap, "dispatch", "token rotated elsewhere — re-vended proactively (epoch catch-up)");
                        write_runner_state(&snap);
                    }
                    Err(pe) => {
                        // the reason is logged; the hub-side rate limiter is
                        // the backstop against tick-loop churn
                        eprintln!("[dispatch] proactive epoch catch-up failed: {pe}");
                        snap_activity(&snap, "error", &format!("proactive epoch catch-up failed: {pe}"));
                    }
                }
                TOKEN_EPOCH_SEEN.store(0, Ordering::Relaxed); // re-adopt from the next response
            } else if vend == 0 && seen > 0 {
                TOKEN_EPOCH_VEND.store(seen, Ordering::Relaxed); // first observation adopts
            }
        }
        match tick(
            &cfg,
            &mut id,
            &mut in_flight,
            &mut attempts,
            &mut fail_counts,
            &mut finished_no_pr,
            &mut gave_up,
            &snap,
            &mut avail,
            &mut last_avail_ok,
            &mut breaker,
            &mut live_notes,
            &mut gated_announced,
        ) {
            Ok(msgs) => {
                for msg in msgs {
                    eprintln!("[dispatch] {msg}");
                }
            }
            Err(e) => {
                // A hub-rejected token (401: revoked/expired/rotated away) is
                // not retryable as-is — but before giving up, repair. Ladder
                // (BR#3787): (1) agent-plane repair by principal — the
                // durable device credential, works HEADLESS; (2) the desktop
                // human-plane self-provision (the login is the approval);
                // (3) loud logout, clear the dead credential, await the next
                // login. Every failure reason is LOGGED and snapshotted —
                // never swallowed (the 2026-10-27 incidents said "the
                // one-time repair failed" with zero why). (Tick errors
                // reaching here are orient's — "bridge {status} on /mcp" —
                // so the prefix match cannot hit task IDs.)
                if e.starts_with("bridge 401 ") || e.starts_with("hub 401:") {
                    {
                        match reqwest::blocking::Client::builder()
                            .timeout(Duration::from_secs(30))
                            .build()
                        {
                            Ok(client) => {
                                match repair_by_principal(&client, &cfg.url) {
                                    Ok(fresh) => {
                                        cfg = fresh;
                                        let msg = "gateway token repaired — re-vended by principal (agent plane) after hub 401".to_string();
                                        eprintln!("[dispatch] {msg}");
                                        snap_activity(&snap, "dispatch", &msg);
                                        write_runner_state(&snap);
                                        continue;
                                    }
                                    Err(pe) => {
                                        eprintln!("[dispatch] principal repair failed: {pe}");
                                        snap_activity(&snap, "error", &format!("principal repair failed: {pe}"));
                                        // desktop fallback: human-plane self-provision
                                        match crate::session::load() {
                                            Some(s) => match self_provision(&client, &cfg.url, &s.value) {
                                                Ok(fresh) => {
                                                    cfg = fresh;
                                                    let msg = "gateway token repaired — re-vended by self-provision (human plane) after hub 401".to_string();
                                                    eprintln!("[dispatch] {msg}");
                                                    snap_activity(&snap, "dispatch", &msg);
                                                    write_runner_state(&snap);
                                                    continue;
                                                }
                                                Err(se) => {
                                                    eprintln!("[dispatch] self-provision repair failed: {se}");
                                                    snap_activity(&snap, "error", &format!("self-provision repair failed: {se}"));
                                                }
                                            },
                                            None => {
                                                eprintln!("[dispatch] no web session on this device — human-plane repair unavailable (headless)");
                                                snap_activity(&snap, "error", "no web session — human-plane repair unavailable (headless)");
                                            }
                                        }
                                    }
                                }
                            }
                            Err(be) => {
                                eprintln!("[dispatch] repair client build failed: {be}");
                                snap_activity(&snap, "error", &format!("repair client build failed: {be}"));
                            }
                        }
                    }
                    // BR#2532: same guided-surface treatment as the identity
                    // gate — the reason rides the snapshot, not just the log.
                    let msg = "signed out automatically — the hub rejected this device's token (revoked, expired, or rotated away) and the one-time repair failed. Nothing was lost: hub URL and settings are kept, and signing in again re-vends a gateway-class token for this same device.";
                    eprintln!("[dispatch] {msg} (hub said: {e})");
                    snap_logout(&snap, msg);
                    logout_core(&stop, &running, &snap, true);
                    if let Ok(mut g) = last_error.lock() {
                        *g = Some(msg.to_string());
                    }
                    did_logout = true;
                    break;
                }
                eprintln!("[dispatch] ERROR: {e}");
                snap_activity(&snap, "error", &e);
                if let Ok(mut g) = last_error.lock() {
                    *g = Some(e);
                }
            }
        }
        // ephemeral flat-file state: keep ~/.bridge/dispatch/runner.json in sync
        write_runner_state(&snap);
        // sleep in small slices so stop is responsive
        let wake = std::time::Instant::now() + Duration::from_secs(cfg.poll_secs);
        while std::time::Instant::now() < wake {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }
    running.store(false, Ordering::Relaxed);
    if let Ok(mut s) = snap.lock() {
        s.running = false;
        s.in_flight = Vec::new();
    }
    // a logout erased the derived state — do not resurrect runner.json here
    if !did_logout {
        write_runner_state(&snap);
    }
    eprintln!("[dispatch] loop stopped");
}

pub fn start(state: &DispatchState, mut cfg: Option<DispatchConfig>) -> Result<(), String> {
    let mut handle = state.handle.lock().map_err(|_| "state poisoned")?;
    if state.running.load(Ordering::Relaxed) {
        return Err("dispatch loop already running".into());
    }
    if let Some(pid) = external_runner_pid() {
        // single-claimant rule: two dispatch loops polling one hub race on
        // claims and double-dispatch. Observe the external runner instead.
        return Err(format!("runner already live in another process (pid {pid}) — stop it or kill {pid} first"));
    }
    // Self-heal (credential-class ADR BR#2673 leg 4): no gateway token but the
    // human session is live → the login IS the approval; vend this device's
    // gateway token now so the loop can start. Every start lands here: the
    // post-login kick, app boot, and the Settings Reconnect button.
    if cfg.as_ref().map(|c| c.token.is_empty()).unwrap_or(true) {
        if let Some(s) = crate::session::load() {
            let hub = cfg
                .as_ref()
                .map(|c| c.url.clone())
                .unwrap_or_else(|| s.url.clone());
            let client = reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .map_err(|e| e.to_string())?;
            let vendored = self_provision(&client, &hub, &s.value)
                .map_err(|e| format!("gateway has no token and self-provision failed: {e}"))?;
            eprintln!(
                "[dispatch] self-provisioned gateway token at start (workspace '{}')",
                vendored.ws.as_deref().unwrap_or("?")
            );
            cfg = Some(vendored);
        }
    }
    // remember explicit settings (concurrency, backend, model, hub) across
    // restarts/app runs — the settings page applies by re-starting the loop
    // with an explicit config, so persist it here (pairing-time saves keep
    // working too: resolve() order is env > file).
    if let Some(c) = &cfg {
        if let Err(e) = c.save() {
            eprintln!("[dispatch] ERROR: config save failed: {e}");
        }
    }
    state.stop.store(false, Ordering::Relaxed);
    // fresh run: any prior auto-logout notice is stale — either the pairing
    // was fixed (re-pair) or the user restarted deliberately (BR#2532). If
    // the pairing is still unqualified, run_loop re-records it immediately.
    snap_logout_clear(&state.snapshot);
    let stop = state.stop.clone();
    let running = state.running.clone();
    let last_error = state.last_error.clone();
    let snap = state.snapshot.clone();
    *handle = Some(std::thread::spawn(move || {
        run_loop(cfg, stop, running, last_error, snap)
    }));
    Ok(())
}

pub fn stop(state: &DispatchState) {
    state.stop.store(true, Ordering::Relaxed);
    // persist the stop signal immediately so the flat file reflects it even
    // before the loop drains its current sleep slice
    write_runner_state(&state.snapshot);
}

/// Settings "Reconnect gateway" (Ray, 2026-10-23): stop the loop, re-vend the
/// gateway token via the human session (start()'s self-heal — the login is
/// the standing approval, no re-pairing ceremony), start fresh.
pub fn reconnect(state: &DispatchState) -> Result<serde_json::Value, String> {
    stop(state);
    start(state, None)?;
    Ok(state.status())
}

/// Log out core: reset the session-facing state. Shared by manual logout
/// (Settings) and automatic logout on an invalid token. `clear_credential`
/// decides the credential's fate — the distinction IS the lifecycle law
/// (credential-class ADR, desktop gateway leg):
///  - UI logout (false): the gateway token STAYS in the keychain — the
///    gateway survives logout, dispatched agents keep running, and the next
///    login re-vends (rotates) in place. Only the human session ends.
///  - dead credential (true): hub 401 (revoked/rotated away) or a wrong-class
///    token at startup — the local copy is provably useless; delete it and
///    await the next login to re-vend.
fn logout_core(stop: &Arc<AtomicBool>, running: &Arc<AtomicBool>, snap: &SharedSnapshot, clear_credential: bool) {
    stop.store(true, Ordering::Relaxed);
    running.store(false, Ordering::Relaxed);
    if clear_credential {
        if let Err(e) = crate::store::TokenStore::open().clear_token() {
            eprintln!("[dispatch] WARNING: credential clear failed: {e}");
        }
        if let Some(dir) = dispatch_dir() {
            // vendored per-agent credentials — re-provisioned after the next login
            let _ = std::fs::remove_file(dir.join("agent-tokens.json"));
        }
    }
    if let Ok(mut s) = snap.lock() {
        s.running = false;
        s.in_flight = Vec::new();
    }
    // BR#2532: persist the post-logout state (incl. an auto-logout notice, if
    // this was one) so an observing desktop UI sees it in the flat file
    write_runner_state(snap);
    eprintln!(
        "[dispatch] logged out — {}",
        if clear_credential {
            "credential cleared; sign in to re-provision"
        } else {
            "session ended; the gateway keeps running (token stays in the keychain)"
        }
    );
}

/// Log out (Settings): stop the runner and end the human session — but the
/// gateway token STAYS in the keychain (credential-class ADR: the gateway
/// survives UI logout, dispatched agents keep running, admin revoke is the
/// kill switch). The next login re-vends, replacing in place.
pub fn logout(state: &DispatchState) {
    // user-initiated: not a forced sign-out — clear any stale auto-logout
    // notice BEFORE logout_core persists the runner state, so the flat file
    // doesn't present it as one either (BR#2532).
    snap_logout_clear(&state.snapshot);
    logout_core(&state.stop, &state.running, &state.snapshot, false);
    if let Ok(mut g) = state.last_error.lock() {
        *g = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orient_gate_matches_the_checked_in_production_fixture() {
        // BR#2844: the fixture IS the recorded production shape
        // (packages/contracts/fixtures/orient.json — do not re-record it).
        // Renaming an orient key on either side without the other fails here,
        // in CI, before it fails a runner silently.
        let fx: serde_json::Value = serde_json::from_str(include_str!(
            "../../../contracts/fixtures/orient.json"
        ))
        .expect("orient fixture parses");
        let recorded: Vec<&str> = fx
            .get("keys_required")
            .and_then(|v| v.as_array())
            .expect("fixture keys_required")
            .iter()
            .filter_map(|k| k.as_str())
            .collect();
        let mut mine = ORIENT_REQUIRED_KEYS.to_vec();
        mine.sort_unstable();
        let mut recorded = recorded;
        recorded.sort_unstable();
        assert_eq!(
            mine, recorded,
            "ORIENT_REQUIRED_KEYS diverged from the recorded fixture — update packages/contracts (src/orient.ts + fixtures/orient.json) and this gate in the same PR"
        );
        // the collections the parser walks carry the keys it relies on
        let shape = fx.get("shape").expect("fixture shape");
        let item_keys = |coll: &str| -> Vec<String> {
            shape
                .pointer(&format!("/{coll}/item_keys"))
                .and_then(|v| v.as_array())
                .expect("item_keys recorded")
                .iter()
                .filter_map(|k| k.as_str())
                .map(String::from)
                .collect()
        };
        let my_tasks = item_keys("my_tasks");
        for k in ["id", "title", "status", "tags"] {
            assert!(
                my_tasks.iter().any(|v| v == k),
                "fixture my_tasks items must record `{k}` — the runner reads it (tags: role:* resume routing)"
            );
        }
        let unclaimed = item_keys("unclaimed_work");
        for k in ["id", "title", "status", "is_claimable", "needs_qualification"] {
            assert!(
                unclaimed.iter().any(|v| v == k),
                "fixture unclaimed_work items must record `{k}` — the runner reads it"
            );
        }
    }

    #[test]
    fn orient_gate_fails_loud_on_the_incident_drift_and_passes_the_contract() {
        // the 14-key contract shape, exactly as the hub serializes it
        let good = serde_json::json!({
            "project": "Superpositional",
            "instructions": "follow the bridge protocol card",
            "board": { "mode": "none" },
            "counts": [{ "type": "task", "status": "todo", "n": 1 }],
            "open_artefacts": [],
            "my_tasks": [{ "id": "BR#1", "title": "t", "status": "in_progress", "tags": ["impl"] }],
            "unclaimed_work": [],
            "steering": [],
            "my_roles": [],
            "pending_asks": [],
            "gauge_debt": [],
            "my_score": { "score": 30, "label": "poor", "grade": "C" },
            "build": "0.3.5",
            "you": { "agent": "a", "session": "s", "tags": [] },
            "note": "extra keys are tolerated — the contract is the required core"
        });
        assert!(
            orient_contract_error(&good).is_ok(),
            "the contract shape must pass: {:?}",
            orient_contract_error(&good)
        );

        // THE incident: a renamed key used to zero the work lists silently.
        // Now it names the drift.
        let mut drifted = good.clone();
        let obj = drifted.as_object_mut().unwrap();
        obj.remove("unclaimed_work");
        obj.insert("unclaimedWork".into(), serde_json::json!([]));
        let err = orient_contract_error(&drifted).unwrap_err();
        assert!(err.contains("unclaimed_work"), "error must name the drifted key, got: {err}");

        // a mistyped collection is a breach too (my_tasks as object)
        let mut mistyped = good.clone();
        mistyped
            .as_object_mut()
            .unwrap()
            .insert("my_tasks".into(), serde_json::json!({}));
        assert!(orient_contract_error(&mistyped).unwrap_err().contains("my_tasks"));

        // a non-object response (an HTML error page, say) never parses as OK
        assert!(orient_contract_error(&serde_json::json!("<html>")).is_err());
        assert!(orient_contract_error(&serde_json::Value::Null).is_err());
    }

    #[test]
    fn provisioning_without_a_vended_secret_demands_a_rotate_retry() {
        // BR#2878, the churn engine: empty local cache + existing hub token.
        // The hub cannot re-show a secret (vended once) — {exists:true} and
        // every error (incl. the revoked error) are ONLY recoverable by a
        // rotate re-vend. Before this fix the runner dead-ended here and
        // every dispatch died (38 fake in-flight cards, 38–58 releases).
        let exists = serde_json::json!({ "exists": true, "id": "at_x", "label": "mac-modem-opencode" });
        assert!(provision_response_needs_rotate(true, &exists), "exists without secret must retry with rotate");
        let revoked = serde_json::json!({ "error": "token 'x' was revoked — provision with rotate to re-mint" });
        assert!(provision_response_needs_rotate(false, &revoked), "revoked error must retry with rotate");
        let server_error = serde_json::json!({ "error": "internal" });
        assert!(provision_response_needs_rotate(false, &server_error), "any error retries once (rotate is the only lever)");
        let vended = serde_json::json!({ "id": "at_x", "label": "a", "secret": "bkw_new" });
        assert!(!provision_response_needs_rotate(true, &vended), "a vended secret never retries");
        let empty_secret = serde_json::json!({ "id": "at_x", "secret": "" });
        assert!(provision_response_needs_rotate(true, &empty_secret), "empty secret is not a credential");
    }

    #[test]
    fn runner_never_moves_cards_to_blocked_and_never_resumes_blocked_work() {
        // BR#2419: state legality lives in the worker's machine. The runner is
        // hands, not judgment: it may claim todo work and release its own
        // claims — nothing else. This alarm fires if either client-side state
        // decision ever reappears.
        let src = include_str!("dispatch.rs");
        // needles assembled from parts so this alarm cannot match itself
        let blocked_edge = format!(r#""to": "{}""#, "blo".to_string() + "cked");
        let resume_marker = format!("runner {}", "resume");
        assert!(
            !src.contains(&blocked_edge),
            "runner must never transition a task to blocked — release claims instead; the worker machine owns blocked"
        );
        assert!(
            !src.contains(&resume_marker),
            "runner must never resume blocked tasks — that verdict belongs to a role:unblock duty or a human"
        );
    }

    #[test]
    fn scratch_dirs_are_per_task_deterministic_paths() {
        // BR#2460: repo-less dispatches provision <workdir>/sessions/bridge-<slug>.
        // Creation must be idempotent (resume re-enters the same dir) and
        // task-scoped (no cross-task bleed).
        let base = std::env::temp_dir().join(format!("bridge-scratch-test-{}", std::process::id()));
        let a = ensure_scratch_dir(base.to_str().unwrap(), "BR#123");
        let b = ensure_scratch_dir(base.to_str().unwrap(), "BR#123");
        assert_eq!(a, b);
        let dir = a.expect("scratch dir created");
        assert!(dir.is_dir());
        assert!(dir.to_string_lossy().contains("sessions"));
        let other = ensure_scratch_dir(base.to_str().unwrap(), "BR#456").expect("second task dir");
        assert_ne!(dir, other);
        let _ = std::fs::remove_dir_all(base);
    }

    // ---- BR#3633: worktree sweep eventual-consistency ----

    #[test]
    fn reverse_task_slug_maps_only_bare_br_slugs() {
        assert_eq!(reverse_task_slug("BR-3620"), "BR#3620");
        assert_eq!(reverse_task_slug("BR-1003"), "BR#1003");
        // not BR-<digits> → passes through unchanged (the age rule owns these;
        // an unresolvable id must never wedge the sweep)
        assert_eq!(reverse_task_slug("TASK-007"), "TASK-007");
        assert_eq!(reverse_task_slug("hotfix-ext"), "hotfix-ext");
        assert_eq!(reverse_task_slug("br-3620-stale-ledger"), "br-3620-stale-ledger");
        assert_eq!(reverse_task_slug("BR-x"), "BR-x");
    }

    #[test]
    fn sweep_disposition_eventual_rules() {
        // explicit terminal statuses sweep at any age; done/superseded drop
        // the branch (the WIP preservation branch survives it)
        assert_eq!(
            sweep_disposition(0, Some("done")),
            (true, true, "task is done".to_string())
        );
        assert_eq!(
            sweep_disposition(0, Some("superseded")),
            (true, true, "task is superseded".to_string())
        );
        // todo sweeps but keeps the branch (a re-claim re-attaches to it)
        let (sweep, drop, _) = sweep_disposition(0, Some("todo"));
        assert!(sweep && !drop);
        // fresh non-terminal trees are resume assets — kept whatever the state
        for s in [Some("in_progress"), Some("in_review"), Some("blocked"), None] {
            let (sweep, _, _) = sweep_disposition(0, s);
            assert!(!sweep, "fresh tree with status {s:?} must be kept");
        }
        // stale trees sweep regardless of status — the eventual guarantee
        // (hub outage, unresolvable id, parked blocked task all drain)
        let stale = WORKTREE_STALE_SECS + 1;
        for s in [Some("in_progress"), Some("in_review"), Some("blocked"), None] {
            let (sweep, drop, _) = sweep_disposition(stale, s);
            assert!(sweep && !drop, "stale tree with status {s:?} must sweep with branch kept");
        }
    }

    #[test]
    fn sweep_candidates_scan_both_roots_skip_active_and_survive_missing_legacy() {
        let base = std::env::temp_dir().join(format!("bridge-sweep-candidates-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let workdir = base.join("workdir");
        let repo = workdir.join("repos").join("demo");
        std::fs::create_dir_all(repo.join(".worktrees").join("BR-1")).unwrap();
        std::fs::create_dir_all(repo.join(".worktrees").join("BR-2")).unwrap();
        let home = base.join("home");
        std::fs::create_dir_all(home.join(".bridge").join("worktrees").join("BR-2")).unwrap();
        std::fs::create_dir_all(home.join(".bridge").join("worktrees").join("BR-3")).unwrap();
        std::fs::create_dir_all(home.join(".bridge").join("worktrees").join("hotfix-ext")).unwrap();
        let mut active = HashSet::new();
        active.insert("BR-2".to_string()); // in-flight on this host — excluded from BOTH roots
        let found = collect_worktree_candidates(&workdir, Some(&home), &active);
        let mut slugs: Vec<String> = found.iter().map(|c| c.slug.clone()).collect();
        slugs.sort();
        assert_eq!(slugs, vec!["BR-1", "BR-3", "hotfix-ext"], "active excluded from both roots, the rest collected");
        // the BR#3633 regression: a missing legacy root used to early-return
        // and discard the nested candidates — now it is a scoped skip
        let found = collect_worktree_candidates(&workdir, Some(&base.join("no-such-home")), &HashSet::new());
        let mut slugs: Vec<String> = found.iter().map(|c| c.slug.clone()).collect();
        slugs.sort();
        assert_eq!(slugs, vec!["BR-1", "BR-2"], "nested candidates survive a missing legacy root");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn epoch_repair_needed_only_on_known_mismatch() {
        // BR#3787 negotiated catch-up: 0 = unknown on either side — the first
        // observation adopts (never repairs on unknowns); only a KNOWN
        // mismatch (both non-zero, different) triggers a proactive re-vend.
        assert!(!epoch_repair_needed(0, 0));
        assert!(!epoch_repair_needed(0, 5), "unknown vend must adopt, not repair");
        assert!(!epoch_repair_needed(5, 0), "unknown seen must adopt, not repair");
        assert!(!epoch_repair_needed(5, 5), "same epoch: in sync");
        assert!(epoch_repair_needed(5, 6), "row rotated elsewhere: repair");
        assert!(epoch_repair_needed(6, 5), "row rotated back: repair");
    }

    #[test]
    fn source_repo_meta_repo_wins_and_normalizes() {
        // structured meta.repo wins outright: bare owner/repo expands, and
        // receipt-page URLs normalize to the owning clone URL
        assert_eq!(
            source_repo("body mentions https://github.com/other/repo", &json!({ "repo": "state-vector/bridge" })),
            Some("https://github.com/state-vector/bridge".to_string())
        );
        assert_eq!(
            source_repo("", &json!({ "repo": "https://github.com/o/r/pull/9" })),
            Some("https://github.com/o/r".to_string())
        );
        assert_eq!(
            source_repo("", &json!({ "repo": "git@gitlab.com:o/r.git" })),
            Some("git@gitlab.com:o/r".to_string())
        );
    }

    #[test]
    fn source_repo_unresolvable_meta_repo_is_a_hard_none() {
        // an authoring defect in meta.repo refuses at the gate — never scrape
        // past it to whatever URL the body happens to cite
        assert_eq!(
            source_repo("see https://github.com/other/repo", &json!({ "repo": "not a repo" })),
            None
        );
    }

    #[test]
    fn source_repo_scrape_survives_midword_line_wrap() {
        // BR#3845: the runner's terminal-width capture split the URL inside
        // the repo name; the scrape must rejoin it — the truncated first line
        // (state-vector/super) is a ghost repo whose clone failed and churned
        // the task eleven times. Line breaks are never meaningful in a URL.
        assert_eq!(
            source_repo(
                "confirm the receipts (PR: https://github.com/state-vector/super\npositional/pull/2343, merge state, findings)",
                &json!({}),
            ),
            Some("https://github.com/state-vector/superpositional".to_string())
        );
        // \r\n wrap shapes unwrap identically
        assert_eq!(
            source_repo(
                "PR https://github.com/o/r/pull/7\r\n is ready",
                &json!({}),
            ),
            Some("https://github.com/o/r".to_string())
        );
    }

    #[test]
    fn classify_clone_failure_taxonomy() {
        // BR#3845 self-heal: fatal classes stop the retry loop, transient
        // keeps the retry-next-cycle behaviour
        assert!(matches!(
            classify_clone_failure("remote: Repository not found.\nfatal: Could not read from remote repository."),
            CloneFailure::NotFound(_)
        ));
        assert!(matches!(
            classify_clone_failure("fatal: 'x' does not appear to be a git repository"),
            CloneFailure::NotFound(_)
        ));
        assert!(matches!(
            classify_clone_failure("fatal: Authentication failed for 'https://github.com/o/r.git/'"),
            CloneFailure::Auth(_)
        ));
        assert!(matches!(
            classify_clone_failure("fatal: Could not resolve host: github.com"),
            CloneFailure::Transient(_)
        ));
        assert!(classify_clone_failure("remote: Repository not found.").fatal());
        assert!(classify_clone_failure("fatal: Authentication failed").fatal());
        assert!(!classify_clone_failure("fatal: Could not resolve host: github.com").fatal());
    }

    #[test]
    fn refused_reference_skips_until_the_reference_changes() {
        let mut cache = HashMap::new();
        // fresh task: not refused
        assert!(!refused_reference(&mut cache, "BR#1", Some("https://github.com/o/r")));
        // record a refusal (as the clone-failure path does), then the SAME
        // reference is skipped...
        cache.insert(
            "BR#1".into(),
            RefusedRef { url: "https://github.com/state-vector/super".into(), reason: "repository not found".into(), ts: 0 },
        );
        assert!(refused_reference(&mut cache, "BR#1", Some("https://github.com/state-vector/super")));
        // ...but a FIXED reference re-arms dispatch and drops the record
        assert!(!refused_reference(&mut cache, "BR#1", Some("https://github.com/state-vector/superpositional")));
        assert!(!cache.contains_key("BR#1"), "stale refusal must not pin the card forever");
        // repo-less after a refusal (reference removed) also re-arms
        cache.insert("BR#2".into(), RefusedRef { url: "https://github.com/o/r".into(), reason: "x".into(), ts: 0 });
        assert!(!refused_reference(&mut cache, "BR#2", None));
        assert!(!cache.contains_key("BR#2"));
    }

    #[test]
    fn agent_segment_drops_the_host_prefix_under_a_gateway() {
        // BR#3846: compounding the gateway label with the <hostname>-<backend>
        // autogen produced macbook-pro-local-2/macbook-pro-local-opencode
        // (46 chars) — past the hub's 40-char token-label cap, so provisioning
        // 400'd and every dispatch released its claim. Under a gateway the
        // segment is the backend alone; an explicit agent_name override wins.
        let mut cfg = DispatchConfig {
            schema_version: default_schema_version(),
            url: "https://hub.example".into(),
            token: String::new(),
            workdir: default_workdir(),
            agent: None,
            model: None,
            backend: None,
            poll_secs: default_poll_secs(),
            timeout_mins: default_timeout_mins(),
            opencode_bin: default_opencode_bin(),
            label: Some("macbook-pro-local-2".into()),
            agent_name: None,
            ws: None,
            gateway: Some(true),
            max_sessions: default_max_sessions(),
            report_minutes: None,
            isolate: true,
            worktree_exempt_repos: vec![],
            backends: std::collections::BTreeMap::from([
                ("opencode".to_string(), Default::default()),
            ]),
            models: None,
            agents: None,
            identity: None,
        };
        assert_eq!(agent_segment(&cfg), "opencode");
        assert_eq!(
            format!("{}/{}", cfg.label.as_deref().unwrap(), agent_segment(&cfg)),
            "macbook-pro-local-2/opencode" // 28 chars — fits the cap
        );
        cfg.agent_name = Some("custom-agent".into());
        assert_eq!(agent_segment(&cfg), "custom-agent");
    }

    #[test]
    fn source_repo_scrapes_first_resolvable_body_url() {
        // no usable meta.repo: the first resolvable https URL in the body is
        // the clone target; trailing prose punctuation must not poison it
        assert_eq!(
            source_repo(
                "receipts: https://github.com/o/r/pull/3, merged. see also https://github.com/x/y",
                &json!({}),
            ),
            Some("https://github.com/o/r".to_string())
        );
        // non-repo URLs don't hijack the scan; an empty meta.repo falls through
        assert_eq!(
            source_repo("docs at https://example.com then https://github.com/o/r", &json!({ "repo": "" })),
            Some("https://github.com/o/r".to_string())
        );
    }

    #[test]
    fn source_repo_none_means_repo_less_dispatch_not_refusal() {
        // BR#2460: no resolvable repo reference anywhere = repo-less dispatch —
        // the caller provisions a scratch dir and the board contract
        assert_eq!(source_repo("pure board-side judgment work, no links", &json!({})), None);
        assert_eq!(source_repo("", &json!({ "repo": 42 })), None);
    }

    #[test]
    fn auto_logout_records_a_guided_notice_not_just_a_log_line() {
        // BR#2532: the identity-law run gate (and the hub-401 logout) must
        // record a structured notice the pair screen can render — naming the
        // law and the one-click re-pair path — instead of leaving the reason
        // in stderr/last_error, which the UI never reads.
        let src = include_str!("dispatch.rs");
        // needles assembled from parts so this alarm cannot match itself
        let notice_call = format!("snap_{}(&snap", "logout");
        assert!(
            src.matches(&notice_call).count() >= 2,
            "both auto-logout sites (identity-law gate + hub-401) must record the structured notice"
        );
        assert!(
            src.contains(&format!("overlay_{}out_notice", "log")),
            "stopped-loop snapshots serve the external flat file — the notice must be overlaid onto it or the UI never sees it"
        );
        let msg_kw = format!("let msg {} ", "=");
        let law = format!("{} law", "identity");
        let law_named = src.lines().filter(|l| l.contains(&msg_kw) && l.contains(&law)).count() >= 1;
        assert!(law_named, "the identity-law logout reason must name the identity law");
        let keeps = format!("{} was lost", "Nothing");
        let kept = format!("settings {} kept", "are");
        let keeps_named = src
            .lines()
            .filter(|l| l.contains(&msg_kw) && l.contains(&keeps) && l.contains(&kept))
            .count()
            >= 2;
        assert!(keeps_named, "both auto-logout reasons must say what re-pairing keeps (hub URL + settings)");
    }

    // ---- BR#3185: identity profiles -----------------------------------------

    /// The recorded contract (packages/contracts/fixtures/identity-profiles.json).
    /// The built-in worker class must equal it exactly — drift here silently
    /// re-brands every runner-dispatched commit.
    const IDENTITY_PROFILES_FIXTURE: &str =
        include_str!("../../../contracts/fixtures/identity-profiles.json");

    #[test]
    fn builtin_worker_identity_matches_contract_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(IDENTITY_PROFILES_FIXTURE).expect("identity-profiles fixture parses");
        let worker = fixture
            .pointer("/classes/worker")
            .expect("fixture records the built-in worker class");
        let profile = builtin_worker_identity();
        assert_eq!(profile.name, worker["name"].as_str().unwrap(), "worker-class name drift");
        assert_eq!(profile.email, worker["email"].as_str().unwrap(), "worker-class email drift");
        assert_eq!(
            profile.signing_program,
            worker["signingProgram"].as_str().unwrap(),
            "worker-class signing program drift"
        );
        // the fixture records ~-relative paths; the runner resolves them
        // against $HOME at provisioning time
        let home = std::env::var("HOME").unwrap_or_default();
        assert_eq!(
            profile.signing_key_path,
            worker["signingKeyPath"].as_str().unwrap().replace('~', &home),
            "worker-class signing key drift"
        );
        // every key the fixture says provisioning writes is one git_config emits
        for key in fixture
            .pointer("/provisioning/writes")
            .and_then(|w| w.as_array())
            .expect("fixture lists the provisioning writes")
        {
            let key = key.as_str().unwrap().split('=').next().unwrap();
            assert!(
                profile.git_config().iter().any(|(k, _)| *k == key),
                "fixture provisioning key `{key}` is not written by the profile"
            );
        }
    }

    #[test]
    fn identity_precedence_explicit_block_beats_builtin_worker_class() {
        let explicit = IdentityProfile {
            name: "ci-bot".into(),
            email: "ci-bot@example.com".into(),
            signing_key_path: "/keys/ci.pub".into(),
            signing_program: "/usr/bin/ssh-keygen".into(),
        };
        let cfg = default_config();
        assert_eq!(
            cfg.identity_profile(),
            builtin_worker_identity(),
            "no explicit identity block = built-in worker class (BR#3181)"
        );
        let mut cfg = default_config();
        cfg.identity = Some(explicit.clone());
        assert_eq!(cfg.identity_profile(), explicit, "explicit identity block wins");
    }

    fn temp_git_repo(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("bridge-identity-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp repo dir");
        let ok = Command::new("git")
            .current_dir(&dir)
            .args(["init", "-q"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(ok, "git init must succeed for the identity test scratch repo");
        dir
    }

    fn git_global_config_list() -> String {
        Command::new("git")
            .args(["config", "--global", "--list"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default()
    }

    #[test]
    fn apply_identity_writes_repo_local_config_and_leaves_global_alone() {
        let repo = temp_git_repo("apply");
        let profile = IdentityProfile {
            name: "detached-cody".into(),
            email: "297316395+detached-cody@users.noreply.github.com".into(),
            signing_key_path: "/keys/sv-agents-signing.pub".into(),
            signing_program: "/usr/bin/ssh-keygen".into(),
        };
        let global_before = git_global_config_list();
        apply_identity(&repo, &profile).expect("identity applied");
        assert_eq!(
            git_global_config_list(),
            global_before,
            "apply_identity must never write global git config"
        );
        // every profile key is readable from the repo's own config, with the
        // exact value the profile carried
        for (key, value) in profile.git_config() {
            let got = Command::new("git")
                .current_dir(&repo)
                .args(["config", "--get", key])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_default();
            assert_eq!(got, value, "repo-local `{key}` must carry the profile value");
        }
        // idempotent: re-apply on resume neither errors nor corrupts
        apply_identity(&repo, &profile).expect("re-apply idempotent");
        let _ = std::fs::remove_dir_all(&repo);
    }

    fn throwaway_signing_key(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("bridge-signkey-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("key dir");
        let key = dir.join("sv-agents-signing");
        let ok = Command::new("ssh-keygen")
            .args(["-t", "ed25519", "-N", "", "-q", "-f"])
            .arg(&key)
            .stdin(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(ok, "throwaway ed25519 keypair must generate");
        dir.join("sv-agents-signing.pub")
    }

    #[test]
    fn sign_check_proves_a_working_identity_can_sign() {
        let key = throwaway_signing_key("good");
        let profile = IdentityProfile {
            name: "detached-cody".into(),
            email: "297316395+detached-cody@users.noreply.github.com".into(),
            signing_key_path: key.to_string_lossy().to_string(),
            signing_program: "/usr/bin/ssh-keygen".into(),
        };
        sign_check(key.parent().unwrap(), &profile)
            .expect("a sound identity must pass the sign check");
    }

    #[test]
    fn sign_check_refuses_a_missing_key() {
        let profile = IdentityProfile {
            name: "detached-cody".into(),
            email: "297316395+detached-cody@users.noreply.github.com".into(),
            signing_key_path: format!("/nonexistent/bridge-signcheck-{}.pub", std::process::id()),
            signing_program: "/usr/bin/ssh-keygen".into(),
        };
        let scratch = std::env::temp_dir();
        let err = sign_check(&scratch, &profile).expect_err("missing key must refuse the dispatch");
        assert!(
            err.contains("signing key not found"),
            "refusal must name the missing key: {err}"
        );
    }

    #[test]
    fn sign_check_refuses_a_program_that_cannot_sign() {
        let key = throwaway_signing_key("badprog");
        let scratch = key.parent().unwrap().to_path_buf();
        let base = IdentityProfile {
            name: "detached-cody".into(),
            email: "297316395+detached-cody@users.noreply.github.com".into(),
            signing_key_path: key.to_string_lossy().to_string(),
            signing_program: String::new(),
        };
        // (a) a program that exits non-zero
        let mut p = base.clone();
        p.signing_program = "/usr/bin/false".into();
        let err = sign_check(&scratch, &p).expect_err("a failing program must refuse");
        assert!(err.contains("sign check failed"), "refusal explains the failure: {err}");
        // (b) a program that exits 0 but signs nothing — the sneaky class
        let mut p = base;
        p.signing_program = "/bin/echo".into();
        let err = sign_check(&scratch, &p).expect_err("exit-0 without a signature must refuse");
        assert!(
            err.contains("no signature"),
            "refusal names the missing signature: {err}"
        );
    }

    #[test]
    fn run_with_timeout_kills_a_hung_program() {
        // a program that blocks (the locked-1Password-agent class) must be
        // killed at the budget, never stall dispatch
        let mut hung = Command::new("sleep");
        hung.arg("30");
        let err = run_with_timeout(hung, 1).expect_err("a hung program must hit the deadline");
        assert!(
            err.contains("timed out after 1s"),
            "timeout names the budget: {err}"
        );
        // a quick program still returns its real output through the same path
        let mut quick = Command::new("echo");
        quick.arg("bridge");
        let out = run_with_timeout(quick, 5).expect("a quick program completes");
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "bridge");
    }

    // ---- BR#3337 drill: claim races are skipped, stale claims released ----

    fn drill_now() -> u64 {
        1_800_000_000_000
    }

    #[test]
    fn drill_in_progress_card_with_dead_session_is_released_and_reclaimed() {
        // canned board: card in_progress, my dispatched session listed but dead
        // (last updated 20m ago), no fresh hub heartbeat → the claim is STALE:
        // the runner releases it (in_progress → todo, "session died") and
        // claims fresh — the rule-9 path the runner takes for its own dead
        // sessions. No dispatch failure is surfaced.
        let now = drill_now();
        assert_eq!(
            claim_liveness(Some(now - 20 * 60_000), None, None, now),
            ClaimLiveness::Stale,
            "a dead session's stale claim must be released + re-claimed"
        );
        // no discoverable session at all is the same stale-claim case (the
        // re-dispatch path that used to claim-and-fail)
        assert_eq!(claim_liveness(None, None, None, now), ClaimLiveness::Stale);
    }

    #[test]
    fn drill_in_progress_card_with_live_session_is_skipped_without_error() {
        // canned board: card in_progress, an opencode session for it updated
        // 1m ago → LIVE: skip silently, never surface a dispatch failure and
        // never double-spawn into a session that is still working.
        let now = drill_now();
        assert_eq!(
            claim_liveness(Some(now - 60_000), None, None, now),
            ClaimLiveness::Live,
            "a live session owns the card — skip"
        );
        // hub heartbeat fresh (runner vouch / agent progress) → live even when
        // the local session list shows nothing
        assert_eq!(claim_liveness(None, Some(now - 240_000), None, now), ClaimLiveness::Live);
        assert_eq!(claim_liveness(None, None, Some(now - 120_000), now), ClaimLiveness::Live);
        // watchdog-consistency bar: stale everywhere at 11m = dead, releasable
        assert_eq!(
            claim_liveness(Some(now - 11 * 60_000), Some(now - 11 * 60_000), None, now),
            ClaimLiveness::Stale
        );
    }

    #[test]
    fn lifecycle_rejections_are_claim_races_not_failures() {
        // the exact shapes the hub's gates emit (worker core.ts / machine.ts)
        assert!(is_claim_race_error(
            "task: 'in_progress' → 'in_progress' not allowed (allowed: in_review, done, blocked, todo)"
        ));
        assert!(is_claim_race_error("status 'in_review' is terminal for task"));
        // BR#208 wording
        assert!(is_claim_race_error(
            "task BR#3328 is claimed by other-gateway-opencode — only the owner or a human can release it to the pool"
        ));
        // BR#3611: the PR #210 proven-unblock wording (8a1acbd) broke the hub's
        // literal classifier (specimen BR#3610) — the structural pair must
        // receive every wording of the release-needs-ownership guard
        assert!(is_claim_race_error(
            "task BR#3372 is claimed by mac-modem-opencode — only the owner, a human, or an unblock duty holding proof of the met exit condition can release it. If the work overlaps yours, coordinate via ask_agent instead. [rule: release-needs-ownership]"
        ));
        // genuine failures keep their class
        assert!(!is_claim_race_error("bridge unreachable: connection refused"));
        assert!(!is_claim_race_error("mcp error -32603: internal"));
    }

    #[test]
    fn claim_race_run_matches_every_ownership_wording_br3611() {
        // the SIG list must stay wording-proof (BR#3611): the ownership shape
        // is the structural pair, present in every wording of the guard
        assert!(claim_race_run(
            "task BR#3372 is claimed by mac-modem-opencode — only the owner, a human, or an unblock duty holding proof of the met exit condition can release it.",
            ""
        ));
        assert!(claim_race_run(
            "",
            "task BR#1 is claimed by x — only the owner or a human can release it to the pool"
        ));
        assert!(!claim_race_run("spawn ok", "exit 0"));
    }

    #[test]
    fn release_note_posts_only_on_a_real_release_br3611() {
        let did = "runner: stale claim released — session died";
        // success → the caller's note (the release really happened); the
        // outcome is ALSO exposed to callers that must branch on it (PR #220
        // review finding — the old () signature hid release failures)
        assert_eq!(
            release_outcome(&Ok(json!({ "id": "BR#1", "status": "todo" }))),
            ReleaseOutcome::Released
        );
        assert_eq!(
            release_note(&Ok(json!({ "id": "BR#1", "status": "todo" })), did).unwrap(),
            did
        );
        // claim-race rejection (the ownership gate refused) → NO note — a note
        // here was a phantom receipt (BR#3372 seqs 131165/131238/131307: the
        // board recorded releases that were rejected)
        let race = "ERROR: task BR#3372 is claimed by mac-modem-opencode — only the owner, a human, or an unblock duty holding proof of the met exit condition can release it. If the work overlaps yours, coordinate via ask_agent instead. [rule: release-needs-ownership]".to_string();
        assert_eq!(
            release_outcome(&Err(race.clone())),
            ReleaseOutcome::ClaimRace
        );
        assert!(release_note(&Err(race), did).is_none());
        // any other error → an honest failure note naming the error, never a
        // success note; the outcome names the failure for branching callers
        let failed = release_note(
            &Err("bridge unreachable: connection refused".to_string()),
            did,
        )
        .unwrap();
        assert!(failed.contains("RELEASE FAILED"));
        assert!(failed.contains("card NOT released"));
        assert!(failed.contains("bridge unreachable"));
    }

    // ---------- BR#3823: the stale-claim flow acts on the LIVE card ----------

    #[test]
    fn stale_claim_live_requires_in_progress_and_own_attribution_br3823() {
        let mine = "macbook-pro-local-opencode";
        // still ours and still in_progress → the flow may release + re-claim
        assert!(stale_claim_live(
            &json!({ "id": "BR#1", "status": "in_progress", "owner": mine }),
            mine
        ));
        // the BR#3299 specimen shape: the watchdog stall-released the card to
        // blocked before the flow fired — skip (release, note, re-claim all)
        assert!(!stale_claim_live(
            &json!({ "id": "BR#3299", "status": "blocked", "owner": "" }),
            mine
        ));
        // another dispatcher re-claimed → not ours any more
        assert!(!stale_claim_live(
            &json!({ "id": "BR#2", "status": "in_progress", "owner": "other-gw-opencode" }),
            mine
        ));
        // owner missing → unattributable → fail-safe skip
        assert!(!stale_claim_live(&json!({ "id": "BR#3", "status": "in_progress" }), mine));
        // fetch failed (empty slice) → fail-safe skip
        assert!(!stale_claim_live(&json!({}), mine));
    }

    #[test]
    fn release_outcome_maps_the_three_release_results_br3823() {
        // success → Released (the re-claim leg may run)
        assert_eq!(
            release_outcome(&Ok(json!({ "id": "BR#1", "status": "todo" }))),
            ReleaseOutcome::Released
        );
        // ownership-gate refusal → ClaimRace (re-claim leg must NOT run;
        // release_note already stays silent on this shape — BR#3611)
        assert_eq!(
            release_outcome(&Err("ERROR: task BR#3372 is claimed by mac-modem-opencode — only the owner, a human, or an unblock duty holding proof of the met exit condition can release it. If the work overlaps yours, coordinate via ask_agent instead. [rule: release-needs-ownership]".to_string())),
            ReleaseOutcome::ClaimRace
        );
        // lifecycle refusal (the card flipped to blocked under us) → ClaimRace
        assert_eq!(
            release_outcome(&Err(
                "task: 'in_progress' → 'todo' not allowed (allowed: in_review, done, blocked)".to_string()
            )),
            ReleaseOutcome::ClaimRace
        );
        // genuine failure → Failed (the honest failure note was already posted)
        match release_outcome(&Err("bridge unreachable: connection refused".to_string())) {
            ReleaseOutcome::Failed(e) => assert!(e.contains("bridge unreachable")),
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[test]
    fn reclaim_note_re_stamps_the_prior_block_br3823() {
        // the card was redirected to blocked between our release and the
        // re-claim: the note re-stamps the card's own reason + unblock
        // condition so the blocked → in_progress leg passes
        // unblock-needs-resolution with the prior promise preserved
        let note = reclaim_resolution_note(&json!({
            "status": "blocked",
            "blocked_reason": "stalled — no update for >10m; released to the pool by watchdog",
            "unblock_condition": "read the task history (get_history) and the last gate error",
        }));
        assert!(note.contains("re-claim"));
        assert!(note.contains("stalled — no update for >10m; released to the pool by watchdog"));
        assert!(note.contains("read the task history (get_history) and the last gate error"));
        // plain path (card todo after our release) → generic note, no re-stamp
        let plain = reclaim_resolution_note(&json!({ "status": "todo" }));
        assert!(plain.contains("re-claim"));
        assert!(!plain.contains("re-stamped"));
    }

    #[test]
    fn breaker_does_not_count_claim_races_and_still_trips_on_real_failures() {
        let mut b = CircuitBreaker::default();
        // a storm of raced sessions (gate-rejection walls) must never trip the
        // breaker — the 2026-10-25 incident class
        for _ in 0..9 {
            b.record_failure(
                "task: 'in_progress' → 'in_progress' not allowed (allowed: in_review, done, blocked, todo)",
                "",
            );
        }
        assert!(!b.tripped(), "claim races must not count toward the breaker");
        assert_eq!(b.consecutive_failures, 0);
        // a race between two real failures must not reset the streak either
        b.record_failure("", "Unexpected server error. Check server logs");
        b.record_failure(
            "task BR#1 is claimed by x — only the owner or a human can release it to the pool",
            "",
        );
        assert_eq!(
            b.consecutive_failures,
            1,
            "a race must not reset the consecutive-failure streak"
        );
        b.record_failure("", "Unexpected server error. Check server logs");
        b.record_failure("", "Unexpected server error. Check server logs");
        assert!(b.tripped(), "genuine dispatch errors still trip at threshold");
        // success clears, as before
        b.record_success();
        assert!(!b.tripped());
        assert_eq!(b.consecutive_failures, 0);
    }

    #[test]
    fn session_lookup_finds_exact_then_fuzzy() {
        let mut sessions = HashMap::new();
        sessions.insert(
            "bridge-BR#1".to_string(),
            SessionEntry { id: "ses_1".into(), updated_ms: Some(1) },
        );
        sessions.insert(
            "older title mentioning bridge-BR#2 inside".to_string(),
            SessionEntry { id: "ses_2".into(), updated_ms: None },
        );
        assert_eq!(find_session(&sessions, "BR#1").unwrap().id, "ses_1");
        assert_eq!(find_session(&sessions, "BR#2").unwrap().id, "ses_2");
        assert!(find_session(&sessions, "BR#3").is_none());
    }

    // BR#3352 — the empty-result class: an ok run whose agent reply never
    // reached the runner's payload must land on the hub as
    // completed_result_lost with the local side-effect receipts, never as a
    // bare "run finished" (or worse: silently dropped on the yield path).

    #[test]
    fn result_lost_receipts_names_worktree_and_pr() {
        let s = result_lost_receipts(
            Some("/Users/rayh/.bridge/worktrees/br-1234"),
            Some("https://github.com/state-vector/superpositional/pull/2341"),
        );
        assert!(s.contains("worktree /Users/rayh/.bridge/worktrees/br-1234"), "{s}");
        assert!(s.contains("PR https://github.com/state-vector/superpositional/pull/2341"), "{s}");
        assert!(s.contains("side effects:"), "{s}");
    }

    #[test]
    fn result_lost_receipts_without_local_evidence_says_so() {
        let s = result_lost_receipts(None, None);
        assert!(s.contains("no local side-effect receipts"), "{s}");
        assert!(!s.contains("worktree"), "{s}");
        // blank strings count as absent — Option::Some("") must not print noise
        let blank = result_lost_receipts(Some("  "), Some(""));
        assert!(blank.contains("no local side-effect receipts"), "{blank}");
    }

    #[test]
    fn result_lost_marker_matches_the_hub_classifier_token() {
        // the hub's watchdog classifier greps the trail for this exact token
        // (core.ts detectResultTrail) — renaming one side without the other
        // silently reverts to scoring lost reports as abandonments.
        const MARKER: &str = "completed_result_lost";
        let note = format!(
            "runner: run finished — exit 0 — \n{MARKER} — agent reply was empty (result payload lost in capture){}",
            result_lost_receipts(Some("/tmp/wt"), Some("https://github.com/o/r/pull/1"))
        );
        assert!(note.contains(MARKER));
    }
}

/// Provision (or reuse) the per-agent hub token for `agent_label` via the
/// gateway's own credentials. Secret cached in ~/.bridge/agent-tokens.json
/// (0600 dir); hub dedupes by label. When our local cache is empty but the
/// hub token already exists, the hub cannot re-show the secret (vended
/// once) — the only recovery is a rotate re-vend, so we retry exactly once
/// with rotate (old token revoked, fresh secret issued, cached). Without
/// this the runner dead-ends forever — the 2026-10-24 churn engine (38
/// fake in-flight cards, 38–58 watchdog releases each).
fn provision_agent_token(cfg: &DispatchConfig, agent_label: &str) -> Result<String, String> {
    if !cfg.token.is_empty() && agent_label == "gateway" {
        return Ok(cfg.token.clone());
    }
    let cache_dir = dispatch_dir().ok_or("no dispatch dir")?;
    let cache_path = cache_dir.join("agent-tokens.json");
    let mut cache: HashMap<String, String> = std::fs::read_to_string(&cache_path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    if let Some(secret) = cache.get(agent_label) {
        if !secret.is_empty() {
            return Ok(secret.clone());
        }
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let hub = cfg.url.trim_end_matches('/').to_string();
    // attempt 1: plain provision; attempt 2 (only when the hub has no secret
    // to re-show): rotate re-vend. Revoking-then-minting is safe here — the
    // old secret is provably not in our cache, and by label-namespace rules
    // it belongs to THIS gateway's worker.
    let mut last_err = String::new();
    for rotate in [false, true] {
        let resp = client
            .post(format!("{hub}/api/kb-machine/provision"))
            .header("Authorization", format!("Bearer {}", cfg.token))
            .header("content-type", "application/json")
            .body(serde_json::to_string(&json!({ "label": agent_label, "rotate": rotate })).unwrap_or_default())
            .send()
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        let body: serde_json::Value = resp.json().unwrap_or_default();
        if provision_response_needs_rotate(status.is_success(), &body) {
            last_err = format!(
                "hub {status}: {}",
                body.get("error").and_then(|e| e.as_str()).unwrap_or("no secret vended")
            );
            continue; // exactly one more attempt, with rotate
        }
        let secret = body
            .get("secret")
            .and_then(|s| s.as_str())
            .filter(|s| !s.is_empty())
            .ok_or("hub vended an empty secret")?;
        cache.insert(agent_label.to_string(), secret.to_string());
        let _ = std::fs::write(&cache_path, serde_json::to_string_pretty(&cache).unwrap_or_default());
        if rotate {
            eprintln!("[dispatch] agent token for '{agent_label}' re-vended by rotate (cache was empty)");
        }
        return Ok(secret.to_string());
    }
    Err(format!(
        "agent token provisioning for '{agent_label}' failed after rotate retry — {last_err}"
    ))
}

/// The provisioning retry decision, extracted for the regression test: a
/// response that carries no USABLE vended secret (exists:true, an empty
/// secret, or any error — including the revoked-token error that also
/// demands rotate) is only recoverable by a rotate re-vend.
fn provision_response_needs_rotate(status_ok: bool, body: &serde_json::Value) -> bool {
    let usable_secret = body
        .get("secret")
        .and_then(|s| s.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    !(status_ok && usable_secret)
}
