//! Dispatch loop — polls bridge for claimable work, dispatches it to opencode,
//! and reports status back through the same protocol (orient / transition /
//! log_progress). Runs identically in menu-bar and headless mode.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::TryRecvError;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::logging;
use crate::opencode;
use crate::scm;

#[path = "stopped_outbox.rs"]
mod stopped_outbox;

#[path = "lifecycle.rs"]
mod lifecycle;

/// Dispatch lines ride the single logging mechanism (BR#4400) — the claimed
/// card (or agent label) is the scope; process-global lines pass "".
fn dlog(scope: &str, msg: &str) {
    logging::emit("dispatch", scope, msg);
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum SchedulingOutcome {
    Reserved { task_id: String, session: String },
    Ready { candidates: Vec<String> },
    NoEligibleWork { eligible: usize, reasons: HashMap<String, usize> },
    AtCapacity { active: usize, reserved: usize, capacity: usize },
    GatewayNotReady { reason: String },
    ReservationPending {},
    ReservationLapsed { task_id: String },
}

static CLAIM_SESSIONS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
fn remember_claim_session(cfg: &DispatchConfig, tid: &str, session: &str) {
    CLAIM_SESSIONS.get_or_init(Default::default).lock().expect("claim session map poisoned")
        .insert(format!("{}:{tid}", cfg.label.as_deref().unwrap_or("runner")), session.to_string());
}
fn claim_session(cfg: &DispatchConfig, tid: &str) -> String {
    CLAIM_SESSIONS.get_or_init(Default::default).lock().expect("claim session map poisoned")
        .get(&format!("{}:{tid}", cfg.label.as_deref().unwrap_or("runner"))).cloned()
        .unwrap_or_else(|| format!("dispatch-{}", slugify(tid))) // legacy claims retain their original identity
}

fn failed_launch_has_no_writer(state: &serde_json::Value) -> bool {
    state.get("attempt").is_some_and(|attempt| attempt.is_null() || attempt["phase"] == "quiesced")
}

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
    /// BR#4489: `role: "train"` = dedicated merge-train node — the daemon
    /// runs connection + train legs and SKIPS task dispatch entirely. Default
    /// (absent) = full gateway (dispatch + train).
    #[serde(default)]
    pub role: Option<String>,
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
    /// 2026-11-02 (Ray: "worktrees are still not being cleaned up — massive
    /// disk space leakage"): extra git repo ROOTS whose REGISTERED worktrees
    /// the stale sweep enumerates via `git worktree list` — e.g. the shared
    /// checkout, where interactive agent sessions create trees per AGENTS.md
    /// rule 6 with no other lifecycle owner. The dir scans only cover the
    /// runner's own roots (<workdir>/repos/<repo>/.worktrees, the legacy
    /// ~/.bridge/worktrees, <workdir>/worktrees); everything else — the
    /// 30+ GB class observed on the checkout: .worktrees/*, ~/Projects/wt-*,
    /// /tmp trees — is registered in a repo the sweep never consulted.
    /// Env BRIDGE_SWEEP_REPOS (comma-separated paths).
    #[serde(default)]
    pub sweep_repos: Vec<String>,
    /// Explicit opt-in. Absent/null/disabled never downloads or replaces binaries.
    #[serde(default)]
    pub auto_update: Option<AutoUpdateConfig>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AutoUpdateConfig {
    #[serde(default)]
    pub enabled: bool,
    pub channel: UpdateChannel,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UpdateChannel { Main, Stable, Pinned }

/// Local request is written only by the separately supervised updater. It is
/// deliberately fail-closed across crashes: only its owner removes the hold.
fn update_request() -> Option<serde_json::Value> {
    if std::env::var("BRIDGE_MANAGED_UPDATES").as_deref() != Ok("1") { return None; }
    let home = std::env::var("HOME").ok()?;
    let value: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(PathBuf::from(home).join(".bridge/update/request.json")).ok()?).ok()?;
    value["nonce"].as_str().filter(|s| !s.is_empty())?;
    Some(value)
}

fn update_receipt(name: &str, value: &serde_json::Value) {
    if let Ok(home) = std::env::var("HOME") {
        let path = PathBuf::from(home).join(".bridge/update").join(name);
        let tmp = path.with_extension("tmp");
        if std::fs::write(&tmp, value.to_string()).is_ok() { let _ = std::fs::rename(tmp, path); }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum UpdateTrainBarrier { DrainingWorkers, Quiescent }

/// Worker draining may take an entire action budget. Keep delivery running
/// throughout it; only stop/join the train at the actual restart barrier.
fn update_train_barrier(
    active_workers: usize,
    train_stop: &AtomicBool,
    train_handle: &mut Option<std::thread::JoinHandle<()>>,
) -> Result<UpdateTrainBarrier, &'static str> {
    if active_workers > 0 { return Ok(UpdateTrainBarrier::DrainingWorkers); }
    train_stop.store(true, Ordering::SeqCst);
    if let Some(handle) = train_handle.take() {
        handle.join().map_err(|_| "update deferred: train thread panicked; no idle receipt")?;
    }
    Ok(UpdateTrainBarrier::Quiescent)
}

/// Per-provider settings. Everything optional — a provider section can be
/// empty ({}) and the runner just uses that CLI's own defaults.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendConfig {
    #[serde(default = "default_isolate")]
    pub enabled: bool,
    #[serde(default = "default_projects")]
    pub projects: Vec<String>,
    /// Explicit capability declaration; never inferred from a model-name regex.
    #[serde(default)]
    pub reasoning_tier: ReasoningTier,
    /// Explicit tier supply. Lane policy is global in Bridge, never per host.
    #[serde(default, deserialize_with = "tier_models_de", skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub models: std::collections::BTreeMap<ReasoningTier, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bin: Option<String>,   // CLI binary override (default: "opencode" / "kiro")
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>, // agent profile for this provider
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>, // model override; unset = the CLI's own default config decides
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>, // transport: "acp" (default for opencode) | "stdio"
}
fn default_projects() -> Vec<String> { vec!["*".into()] }
impl Default for BackendConfig {
    fn default() -> Self { Self { enabled: true, projects: default_projects(), reasoning_tier: ReasoningTier::Small, models: Default::default(), bin: None, agent: None, model: None, mode: None } }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningTier { #[default] Small, Medium, Large }

fn tier_models_de<'de, D: serde::Deserializer<'de>>(de: D) -> Result<std::collections::BTreeMap<ReasoningTier, String>, D::Error> {
    let models = std::collections::BTreeMap::<ReasoningTier, String>::deserialize(de)?;
    if models.values().any(|m| m.trim().is_empty()) { return Err(serde::de::Error::custom("tier models must contain non-empty CLI model IDs")); }
    Ok(models.into_iter().map(|(tier, model)| (tier, model.trim().to_string())).collect())
}

fn backend_satisfies(cfg: &DispatchConfig, backend: opencode::Backend, meta: &serde_json::Value) -> bool {
    selected_model(cfg, backend, meta).is_some()
}

fn configured_models(cfg: &DispatchConfig, bc: &BackendConfig) -> Vec<(ReasoningTier, String)> {
    if !bc.models.is_empty() {
        return bc.models.iter().filter(|(_, model)| !model.trim().is_empty()).map(|(tier, model)| (*tier, model.clone())).collect();
    }
    bc.model.clone().or_else(|| cfg.model.clone()).filter(|model| !model.trim().is_empty())
        .map(|model| vec![(bc.reasoning_tier, model)]).unwrap_or_default()
}

fn selected_model(cfg: &DispatchConfig, backend: opencode::Backend, meta: &serde_json::Value) -> Option<(ReasoningTier, String)> {
    let required = meta.pointer("/execution_scheduling_requirements/tier").or_else(|| meta.pointer("/execution_requirements/tier"))
        .and_then(|v| serde_json::from_value::<ReasoningTier>(v.clone()).ok()).unwrap_or_default();
    let name = if backend == opencode::Backend::Kiro { "kiro" } else { "opencode" };
    let bc = cfg.backends.get(name)?;
    if !bc.enabled || !bc.projects.iter().any(|p| p == "*" || Some(p.as_str()) == meta["execution_project"].as_str()) { return None; }
    let initial_selection = meta.get("execution_scheduling_requirements").is_some() && meta.get("execution_last_model").is_none();
    configured_models(cfg, bc).into_iter().filter(|(tier, _)| if initial_selection { *tier == required } else { *tier >= required }).min_by_key(|(tier, _)| *tier)
}

fn quiesced_claim_can_resume(state: &serde_json::Value, task: &serde_json::Value, host: Option<&str>) -> bool {
    task["status"] == "in_progress" && state["attempt"]["phase"] == "quiesced"
        && state.get("capacity_handoff").map(|h| h.is_null()).unwrap_or(true)
        && state["attempt"]["host"].as_str() == host && host.is_some()
        && state["attempt"]["session"].as_str().is_some()
        && state["attempt"]["session"] == task["meta"]["session"]
        && matches!(state.pointer("/handoff/phase").and_then(|v| v.as_str()), None | Some("none" | "returned"))
}

fn executor_capabilities(tier: ReasoningTier, worker: &WorkerCredential) -> serde_json::Value {
    let tools: Vec<&str> = ["git", "gh", "cargo", "npm", "aws"].into_iter().filter(|bin| {
        probe_version(bin).is_ok()
    }).collect();
    // Scope facts only: an installed AWS CLI is NOT proof of cloud authority.
    json!({ "tier": tier, "tools": tools, "environment": [std::env::consts::OS, std::env::consts::ARCH],
        "worker": { "kind": "provisioned", "label": worker.label } })
}

fn requested_worker_label(cfg: &DispatchConfig) -> String {
    match &cfg.label {
        Some(label) if !label.is_empty() => format!("{label}/{}", agent_segment(cfg)),
        _ => agent_identity(cfg),
    }
}

fn worker_config_revision(cfg: &DispatchConfig) -> String {
    format!("worker-ready-v2:task-affinity-v1:eligibility-first-v1:{}", serde_json::to_string(&cfg.backends).unwrap_or_default())
}

fn prepare_worker(cfg: &DispatchConfig, avail: &[opencode::Backend]) -> Result<(WorkerCredential, serde_json::Value), String> {
    prepare_worker_with_progress(cfg, avail, &|_| {})
}

#[derive(Clone)]
struct GatewayReadyProof { worker: WorkerCredential, observed: Instant }

enum GatewayReadinessState {
    Unavailable(String),
    Ready(GatewayReadyProof),
}

struct GatewayReadinessData {
    cfg: DispatchConfig,
    key: String,
    state: GatewayReadinessState,
}

/// Capability TTL is a gateway clock, not a side effect of completing a tick.
/// A single producer owns worker provisioning/probing and publishes no claims,
/// attempt leases, writer counts or synthetic progress.
struct GatewayReadiness {
    data: Arc<Mutex<GatewayReadinessData>>,
    maintenance: LeaseMaintenance,
}

fn gateway_readiness_key(cfg: &DispatchConfig) -> String {
    json!({"url":cfg.url,"host":cfg.label,"worker":requested_worker_label(cfg),
        "inventory":worker_config_revision(cfg),"fallback_model":cfg.model,
        "opencode_bin":cfg.opencode_bin,"capacity":cfg.max_sessions}).to_string()
}

impl GatewayReadiness {
    fn start(cfg: &DispatchConfig) -> Self {
        Self::with_probe(cfg, Duration::from_secs(20), |cfg| {
            let available = available_backends(cfg);
            if available.is_empty() {
                if let Some(name) = cfg.backends.keys().next() {
                    let capabilities = capability_inventory(cfg, &[], None, name);
                    execution_call(cfg, "gateway", json!({"kind":"advertise","capabilities":capabilities}))?;
                }
                return Err("no runnable configured backend".into());
            }
            prepare_worker(cfg, &available).map(|(worker, _)| worker)
        })
    }

    fn with_probe(cfg: &DispatchConfig, interval: Duration,
        mut probe: impl FnMut(&DispatchConfig) -> Result<WorkerCredential, String> + Send + 'static) -> Self {
        let initial = match probe(cfg) {
            Ok(worker) => GatewayReadinessState::Ready(GatewayReadyProof { worker, observed: Instant::now() }),
            Err(error) => GatewayReadinessState::Unavailable(error),
        };
        let data = Arc::new(Mutex::new(GatewayReadinessData { cfg: cfg.clone(), key: gateway_readiness_key(cfg), state: initial }));
        let shared = data.clone();
        let maintenance = LeaseMaintenance::start(interval, move || {
            let (cfg, key) = { let data = shared.lock().expect("gateway readiness poisoned"); (data.cfg.clone(), data.key.clone()) };
            let result = probe(&cfg); // no shared lock held across bounded probes/network
            let mut data = shared.lock().expect("gateway readiness poisoned");
            if data.key == key && data.cfg.token == cfg.token {
                data.state = match result {
                    Ok(worker) => {
                        dlog("gateway", "readiness renewed independently of dispatch");
                        GatewayReadinessState::Ready(GatewayReadyProof { worker, observed: Instant::now() })
                    }
                    Err(error) => {
                        dlog("gateway", &format!("readiness renewal failed: {error}; no fresh local admission proof"));
                        GatewayReadinessState::Unavailable(error)
                    }
                };
            }
            true // retry failed readiness; never renew from a cached success
        });
        Self { data, maintenance }
    }

    fn update_config(&self, cfg: &DispatchConfig) {
        let mut data = self.data.lock().expect("gateway readiness poisoned");
        let key = gateway_readiness_key(cfg);
        if data.key != key || data.cfg.token != cfg.token {
            data.state = GatewayReadinessState::Unavailable("configuration or credential changed; awaiting fresh readiness".into());
            data.key = key;
            data.cfg = cfg.clone();
            self.maintenance.wake();
        }
    }

    fn proof(&self, cfg: &DispatchConfig) -> Result<GatewayReadyProof, String> {
        self.proof_with_max_age(cfg, Duration::from_secs(60))
    }

    fn proof_with_max_age(&self, cfg: &DispatchConfig, max_age: Duration) -> Result<GatewayReadyProof, String> {
        let data = self.data.lock().expect("gateway readiness poisoned");
        if data.key != gateway_readiness_key(cfg) { return Err("configuration has no matching readiness proof".into()); }
        match &data.state {
            GatewayReadinessState::Ready(proof) if proof.observed.elapsed() < max_age => Ok(proof.clone()),
            GatewayReadinessState::Ready(_) => Err("local gateway readiness proof expired".into()),
            GatewayReadinessState::Unavailable(error) => Err(error.clone()),
        }
    }
}

fn begin_with_fresh_readiness<T>(
    observed: &mut Instant,
    force_refresh: bool,
    refresh: impl FnOnce() -> Result<(), String>,
    begin: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if observed.elapsed() >= Duration::from_secs(60) || force_refresh {
        refresh()?;
        *observed = Instant::now();
    }
    begin()
}

fn prepare_worker_with_progress(cfg: &DispatchConfig, avail: &[opencode::Backend], report: &dyn Fn(&str)) -> Result<(WorkerCredential, serde_json::Value), String> {
    let backend = avail.iter().max_by_key(|b| {
        let name = if **b == opencode::Backend::Kiro { "kiro" } else { "opencode" };
        cfg.backends.get(name).map(|bc| bc.reasoning_tier).unwrap_or_default()
    }).ok_or("no configured backend is available")?;
    let name = if *backend == opencode::Backend::Kiro { "kiro" } else { "opencode" };
    report("ready: checking the gateway worker credential");
    let worker = provision_agent_token(cfg, &requested_worker_label(cfg))?;
    report("ready: probing local tools and configured model inventory (2s limit per probe)");
    let capabilities = capability_inventory(cfg, avail, Some(&worker), name);
    report("ready: advertising capabilities to the hub (8s limit per request)");
    let reply = execution_call(cfg, "gateway", json!({ "kind": "advertise", "capabilities": capabilities }))?;
    if reply["ok"] != true || reply.pointer("/readiness/kind").and_then(|v| v.as_str()) != Some("ready") {
        return Err(format!("executor readiness held: {}", reply["readiness"]));
    }
    Ok((worker, reply))
}

/// A bounded paired-operator preflight; never claims or launches a task.
pub fn execution_ready(cfg: &DispatchConfig) -> Result<serde_json::Value, String> {
    let report = |message: &str| logging::emit("cli", "", message);
    report("ready: checking configured backend CLIs (2s limit per probe)");
    let available = available_backends_with_progress(cfg, &report);
    prepare_worker_with_progress(cfg, &available, &report).map(|(_, reply)| reply)
}

/// Recover only recorded legacy pre-begin failures, under this host's genuine
/// credential, after fresh local proof that its old runner launched no workers.
pub fn recover_unstarted(cfg: &DispatchConfig, tid: &str) -> Result<serde_json::Value, String> {
    let report: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dispatch_dir().ok_or("no dispatch directory")?.join("runner.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if report["label"].as_str() != cfg.label.as_deref() || report["in_flight"].as_array().map(|a| !a.is_empty()).unwrap_or(true)
        || now_ms().saturating_sub(report["updated_ts"].as_u64().unwrap_or(0)) > 90_000 {
        return Err("legacy recovery requires a fresh same-host runner report with zero workers".into());
    }
    let pid = report["pid"].as_u64().filter(|p| *p > 1).ok_or("runner report has no process")?;
    let children = Command::new("pgrep").args(["-P", &pid.to_string()]).output().map_err(|e| e.to_string())?;
    if children.status.code() != Some(1) { return Err("runner children exist or cannot be proved absent; preserve all claims and work".into()); }
    execution_ready(cfg)?;
    execution_call(cfg, tid, json!({ "kind": "recover_unstarted", "writers": "not_launched", "retained_work": true }))
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum StartStage { Inspect, Begin }

/// These paths have launched no child. Reconcile a committed-but-lost begin
/// by its exact attempt; never release another writer or discard local work.
fn failed_start(cfg: &DispatchConfig, tid: &str, stage: StartStage, reason: &str, expected_attempt: Option<&str>, path: Option<&Path>) {
    let result = (|| -> Result<serde_json::Value, String> {
        let state = execution_call(cfg, tid, json!({ "kind": "inspect" }))?;
        if let Some(a) = state.get("attempt").filter(|a| !a.is_null()) {
            if a["phase"] != "quiesced" {
                let session = claim_session(cfg, tid);
                let ours = expected_attempt.is_some() && expected_attempt == a["attempt_id"].as_str()
                    && a["host"].as_str() == cfg.label.as_deref() && a["session"].as_str() == Some(session.as_str());
                if !ours { return Err("prior writer is not this never-launched attempt; retain claim/WIP".into()); }
                execution_call(cfg, tid, json!({ "kind": "quiesce", "generation": a["generation"], "attempt_id": a["attempt_id"], "writers": "process_group_empty" }))?;
            }
        }
        let retained_work = path.map(|p| {
            let clean = Command::new("git").current_dir(p).args(["status", "--porcelain"]).output();
            let published = Command::new("git").current_dir(p).args(["branch", "-r", "--contains", "HEAD"]).output();
            !matches!(clean, Ok(o) if o.status.success() && o.stdout.is_empty())
                || !matches!(published, Ok(o) if o.status.success() && !o.stdout.is_empty())
        }).unwrap_or(false);
        let failure_class = if reason.contains("gate:") { "prerequisite" } else { "transport" };
        execution_call(cfg, tid, json!({ "kind": "start_failed", "stage": stage, "reason": truncate(reason, 3500), "retained_work": retained_work, "failure_class": failure_class }))
    })();
    // Progress after release would re-claim todo through the legacy API.
    match result {
        Ok(value) if value["kind"] == "released" => dlog(tid, &format!("startup failed before worker launch: {reason}; claim released; {}", if value["barrier"].is_null() { "task prerequisite retained; gateway remains ready" } else { "gateway readiness held; inspect the startup cause" })),
        Ok(value) => dlog(tid, &format!("startup reconciliation held: {value}")),
        Err(error) => dlog(tid, &format!("startup reconciliation unavailable: {error}; preserve claim and work")),
    }
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ModelAvailability { Usable, Unavailable { reason: String }, Disabled }
fn backend_capabilities(cfg: &DispatchConfig, name: &str, runnable: bool, worker: Option<&WorkerCredential>) -> serde_json::Value {
    let bc = cfg.backends.get(name).cloned().unwrap_or_default();
    let (tier, model) = configured_models(cfg, &bc).into_iter().max_by_key(|(tier, _)| *tier)
        .map(|(tier, model)| (tier, Some(model))).unwrap_or((bc.reasoning_tier, None));
    let mut facts = worker.map(|worker| executor_capabilities(tier, worker))
        .unwrap_or_else(|| json!({ "tier": tier, "tools": [], "environment": [], "worker": { "kind": "unprovisioned" } }));
    let availability = if !bc.enabled { ModelAvailability::Disabled }
        else if !runnable { ModelAvailability::Unavailable { reason: "Configured agent CLI is unavailable or its circuit breaker is open".into() } }
        else if model.as_deref().unwrap_or("").is_empty() { ModelAvailability::Unavailable { reason: "Actual configured model identity is unreported; configure it explicitly".into() } }
        else { ModelAvailability::Usable };
    facts["backend"] = json!(name); facts["model"] = json!(model); facts["projects"] = json!(bc.projects);
    facts["availability"] = json!(availability); facts["capacity"] = json!(cfg.max_sessions.clamp(1, 64));
    facts["inventory_revision"] = json!(2);
    facts["config_revision"] = json!(worker_config_revision(cfg));
    facts
}

/// Advertise the complete supply even when a task selects a smaller model.
/// Otherwise running medium temporarily erases this host's large capability.
fn inventory_dispatch_hold(mut facts: serde_json::Value, held: bool) -> serde_json::Value {
    if held {
        let availability = json!(ModelAvailability::Unavailable { reason: "Managed update is draining active workers before restart; new claims are paused".into() });
        facts["availability"] = availability.clone();
        if let Some(models) = facts.get_mut("alternatives").and_then(|v| v.as_array_mut()) {
            for model in models { model["availability"] = availability.clone(); }
        }
    }
    facts
}

fn capability_inventory(cfg: &DispatchConfig, avail: &[opencode::Backend], worker: Option<&WorkerCredential>, primary: &str) -> serde_json::Value {
    let mut inventory = Vec::new();
    for (name, bc) in &cfg.backends {
        let runnable = avail.iter().any(|b| opencode::Backend::parse(Some(name)) == *b);
        let base = backend_capabilities(cfg, name, runnable, worker);
        let models = configured_models(cfg, bc);
        if models.is_empty() { inventory.push(base); }
        else { for (tier, model) in models {
            let mut facts = base.clone(); facts["tier"] = json!(tier); facts["model"] = json!(model);
            inventory.push(facts);
        } }
    }
    let index = inventory.iter().enumerate().filter(|(_, c)| c["backend"] == primary).max_by_key(|(_, c)| serde_json::from_value::<ReasoningTier>(c["tier"].clone()).unwrap_or_default()).map(|(i, _)| i).unwrap_or(0);
    if inventory.is_empty() { return inventory_dispatch_hold(backend_capabilities(cfg, primary, false, worker), update_request().is_some()); }
    let mut main = inventory.remove(index); main["alternatives"] = json!(inventory);
    inventory_dispatch_hold(main, update_request().is_some())
}

static EXECUTION_FENCES: std::sync::OnceLock<Mutex<HashMap<String, (u64, String)>>> = std::sync::OnceLock::new();

fn execution_call(cfg: &DispatchConfig, tid: &str, command: serde_json::Value) -> Result<serde_json::Value, String> {
    execution_call_session(cfg, tid, command, None)
}

fn execution_call_session(cfg: &DispatchConfig, tid: &str, command: serde_json::Value, session: Option<&str>) -> Result<serde_json::Value, String> {
    let kind = command.get("kind").and_then(|v| v.as_str()).unwrap_or("unknown");
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|t| t.as_nanos()).unwrap_or(0);
    let mut id = 0;
    let args = json!({ "id": tid, "command_id": format!("{kind}-{}-{nonce}", std::process::id()), "command": command });
    for retry in 0..3 {
        let result = match session {
            Some(session) => mcp_call_session(cfg, &mut id, "execution", args.clone(), Some(session)),
            None => mcp_call_task(cfg, &mut id, "execution", args.clone(), tid),
        };
        match result {
            Ok(result) => return Ok(result),
            Err(e) if retry < 2 && (e.contains("bridge unreachable") || e.contains("bridge 5") || e.contains("infra_storage_fault")) => {
                logging::emit("cli", tid, &format!("execution {kind}: transient request failure; retry {}/3 with the same command_id", retry + 2));
                std::thread::sleep(Duration::from_millis(250 * (retry + 1)));
            }
            Err(e) => return Err(e), // named semantic gates are terminal
        }
    }
    unreachable!()
}

pub enum ExecutionRead { Inspect, Availability }
pub fn execution_read(cfg: &DispatchConfig, task_id: &str, kind: ExecutionRead) -> Result<serde_json::Value, String> {
    let command = match kind { ExecutionRead::Inspect => "inspect", ExecutionRead::Availability => "availability" };
    execution_call(cfg, task_id, json!({ "kind": command }))
}
pub fn execution_claims(cfg: &DispatchConfig, pause: bool) -> Result<serde_json::Value, String> {
    logging::emit("cli", "", if pause { "pause: asking the hub to pause new claims (8s limit per request)" } else { "resume: asking the hub to resume new claims (8s limit per request)" });
    execution_call(cfg, "gateway", if pause { json!({ "kind": "pause_claims", "reason": "Operator runtime update: preserve active writers while draining", "budget_ms": 300_000 }) } else { json!({ "kind": "resume_claims" }) })
}
pub fn scheduling_status(cfg: &DispatchConfig, host: Option<&str>) -> Result<serde_json::Value, String> {
    let command = match host { Some(host) => json!({ "kind": "schedule_status", "host": host }), None => json!({ "kind": "schedule_status" }) };
    execution_call(cfg, "gateway", command)
}
pub fn drain_gateway(cfg: &DispatchConfig) -> Result<serde_json::Value, String> {
    let host = cfg.label.as_deref().ok_or("gateway label missing")?;
    execution_call(cfg, "gateway", json!({ "kind": "gateway_control", "host": host, "mode": "draining", "reason": "Operator retired this gateway from autonomous dispatch" }))
}
pub fn execution_coordinate(cfg: &DispatchConfig, task_id: &str, message: &str) -> Result<serde_json::Value, String> {
    execution_call(cfg, task_id, json!({ "kind": "message", "message_id": format!("operator-{}-{}", std::process::id(), now_ms()), "text": message, "priority": "interrupt" }))
}

#[derive(Clone)]
struct ExecutionRuntime {
    generation: u64,
    attempt_id: String,
    control: Arc<crate::transport::RunControl>,
    maintenance: Option<Arc<LeaseMaintenance>>,
    last_checkpoint: Instant,
}

/// One clock per attempt: preparing other workers, Git publication and the
/// dispatch cadence must never starve a running writer's lease or inbox.
/// Cancellation joins the poller before quiesce/transfer, so no late poll can
/// renew an attempt after its finalization barrier.
enum MaintenanceSignal { Wake, Stop }
struct LeaseMaintenance {
    cancel: std::sync::mpsc::Sender<MaintenanceSignal>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}
impl LeaseMaintenance {
    fn start(interval: Duration, mut poll: impl FnMut() -> bool + Send + 'static) -> Self {
        let (cancel, cancelled) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            loop {
                match cancelled.recv_timeout(interval) {
                    Ok(MaintenanceSignal::Wake) | Err(std::sync::mpsc::RecvTimeoutError::Timeout) => if !poll() { break; },
                    _ => break,
                }
            }
        });
        Self { cancel, thread: Mutex::new(Some(thread)) }
    }
    fn stop(&self) {
        let _ = self.cancel.send(MaintenanceSignal::Stop);
        if let Ok(mut thread) = self.thread.lock() {
            if let Some(thread) = thread.take() { let _ = thread.join(); }
        }
    }
    fn wake(&self) { let _ = self.cancel.send(MaintenanceSignal::Wake); }
}
impl Drop for LeaseMaintenance {
    fn drop(&mut self) { self.stop(); }
}

#[derive(Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
enum RemoteAttemptState {
    Restoring { checkpoint: crate::checkpoint::Checkpoint },
    Running,
    Stopping,
    Quiesced,
}
#[derive(Deserialize)]
struct RemoteAttempt {
    generation: u64,
    attempt_id: String,
    #[serde(flatten)]
    state: RemoteAttemptState,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum MailboxState { Queued, Delivered, Acknowledged, Acted }
#[derive(Deserialize)]
struct RemoteMessage { state: MailboxState }
#[derive(Deserialize)]
struct RemoteExecution {
    policy_version: u32,
    attempt: Option<RemoteAttempt>,
    messages: Vec<RemoteMessage>,
    #[serde(default)]
    handoff: RemoteHandoff,
}
#[derive(Deserialize, Default, Clone, Copy)]
#[serde(tag = "phase", rename_all = "snake_case")]
enum RemoteHandoff { #[default] None, Preparing, Waiting, Accepted, Returned }
impl RemoteExecution {
    fn permits_renewal(&self, generation: u64, attempt_id: &str) -> bool {
        self.attempt.as_ref().is_some_and(|a| a.generation == generation && a.attempt_id == attempt_id && matches!(a.state, RemoteAttemptState::Running | RemoteAttemptState::Restoring { .. }))
            && !self.messages.iter().any(|m| matches!(m.state, MailboxState::Delivered))
    }
    fn parse(value: serde_json::Value) -> Result<Self, String> {
        let state: Self = serde_json::from_value(value).map_err(|e| format!("durable execution contract drift: {e}"))?;
        if state.policy_version != 1 { return Err("unsupported execution policy version".into()); }
        Ok(state)
    }
}
impl ExecutionRuntime {
    fn start_maintenance(&mut self, cfg: &DispatchConfig, tid: &str) {
        let cfg = cfg.clone();
        let session = claim_session(&cfg, tid);
        let tid = tid.to_string();
        let generation = self.generation;
        let attempt_id = self.attempt_id.clone();
        let command = self.command("poll");
        let control = self.control.clone();
        self.maintenance = Some(Arc::new(LeaseMaintenance::start(Duration::from_secs(20), move || {
            if control.stop.load(Ordering::SeqCst) { return false; }
            let state = execution_call_session(&cfg, &tid, command.clone(), Some(&session)).and_then(RemoteExecution::parse);
            match state {
                Ok(state) => {
                    if state.permits_renewal(generation, &attempt_id) {
                        control.grant_lease();
                        return true;
                    }
                }
                Err(error) => dlog(&tid, &format!("execution lease/inbox unavailable: {error}; stopping writer and retaining WIP")),
            }
            control.stop.store(true, Ordering::SeqCst);
            false
        })));
    }
    fn stop_maintenance(&self) {
        if let Some(maintenance) = &self.maintenance { maintenance.stop(); }
    }
    fn command(&self, kind: &str) -> serde_json::Value {
        json!({ "kind": kind, "generation": self.generation, "attempt_id": self.attempt_id })
    }
    fn checkpoint(&self, cfg: &DispatchConfig, tid: &str, path: &Path) -> Result<(), String> {
        let checkpoint = crate::checkpoint::publish(path, tid, self.generation, "Read task history and checkpoint; continue the remaining action, preserving any newer local WIP.", vec![std::env::consts::OS.into(), std::env::consts::ARCH.into()])?;
        let mut cmd = self.command("checkpoint");
        cmd["checkpoint"] = serde_json::to_value(checkpoint).map_err(|e| e.to_string())?;
        execution_call(cfg, tid, cmd)?;
        Ok(())
    }
}

fn stopped_outbox_root() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("HOME")?).join(".bridge/stopped-attempts"))
}

fn send_stopped_receipt(cfg: &DispatchConfig, receipt: &stopped_outbox::StoppedReceipt) -> Result<(), String> {
    if cfg.label.as_deref() != Some(receipt.host.as_str()) || cfg.url.trim_end_matches('/') != receipt.url {
        return Err("gate: stopped-writer receipt belongs to another gateway or hub".into());
    }
    let reply = mcp_call_session(cfg, &mut 0, "execution", receipt.request(), Some(&receipt.session))?;
    if reply["attempt"]["phase"] != "quiesced" { return Err("hub did not confirm stopped-writer quiescence".into()); }
    Ok(())
}

fn persist_stopped_receipt(cfg: &DispatchConfig, tid: &str, runtime: &ExecutionRuntime, group_empty: bool) -> Result<(PathBuf, stopped_outbox::StoppedReceipt), String> {
    let receipt = stopped_outbox::StoppedReceipt::capture(cfg.label.as_deref().ok_or("gateway label missing")?, &cfg.url,
        tid, &claim_session(cfg, tid), runtime.generation, &runtime.attempt_id, now_ms(), group_empty)?;
    let path = stopped_outbox::persist(&stopped_outbox_root().ok_or("outbox home missing")?, &receipt)?;
    Ok((path, receipt))
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
                let cfg = serde_json::from_value(section).map_err(serde::de::Error::custom)?;
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
            // BR#4489: the only recognized role is "train" (dedicated merge
            // node). Anything else — absent, garbage — is the default full
            // gateway; an unknown role must never silently disable dispatch.
            role: std::env::var("BRIDGE_ROLE").ok().map(|r| r.trim().to_string()).filter(|r| r == "train"),
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
            sweep_repos: std::env::var("BRIDGE_SWEEP_REPOS")
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
            auto_update: None,
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
    let code = pair_start(
        &client,
        url,
        host_slug().as_str(),
        ensure_principal_from_file().as_str(),
    )?;
    // raw dual-stream on purpose (BR#4400 exempts interactive UX from
    // logging::emit): the pairing code must reach the human now, whatever
    // stream they redirected
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
                logging::emit("pair", "", "authorized — token saved");
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
            logging::emit(
                "pair",
                cfg.ws.as_deref().unwrap_or("?"),
                &format!(
                    "authorized — token for workspace saved to the keychain (settings preserved)"
                ),
            );
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
        role: None,
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
        sweep_repos: Vec::new(),
        auto_update: None,
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
            dlog("", "device credential vended by the hub and stored");
        }
    }
    let mut cfg = load_config().unwrap_or_else(default_config);
    apply_vended_credentials(&mut cfg, url, secret, ws, label, true)?;
    dlog(
        cfg.ws.as_deref().unwrap_or("?"),
        "gateway self-provisioned for workspace — token in the OS keychain",
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
/// Irrecoverable rows are NAMED: the error text carries "re-pair required"
/// (principal unknown, revoked, or reset) — the ONLY wipe-legal signal.
pub fn repair_by_principal(
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

/// BR#4113 — the two classes a hub-call failure can be. Auth failures
/// (401/403: the hub rejected this device's credential — revoked, expired, or
/// rotated away) are repairable by the self-heal ladder and are NEVER
/// terminal while desired state is "running". Everything else (hub
/// unreachable mid-deploy, 5xx, 429, timeouts, MCP-level errors) is
/// transient: back off, keep polling — the hub may just be deploying.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HubErrClass {
    Auth,
    Transient,
}

/// The repairable-vs-transient decision point. Consumed by BOTH hub-call
/// loops on this device — the dispatch loop (below) and the merge-train
/// executor (train.rs, vendored into the CLI) — so one classification law
/// governs every hub caller (BR#4754 made it crate-visible for the train leg).
pub(crate) fn classify_hub_error(e: &str) -> HubErrClass {
    // "bridge {status} on /mcp" is mcp_call_session's shape; "hub 401:" is
    // the pairing/session-plane shape. 401 = the token is dead; 403 = the
    // identity was refused — a re-vend usually won't change a 403 either,
    // but it is the same repairable-by-ladder class, and parking loudly
    // beats a silent permanent stall either way.
    if e.starts_with("bridge 401 ")
        || e.starts_with("bridge 403 ")
        || e.starts_with("hub 401:")
        || e.starts_with("hub 403:")
    {
        return HubErrClass::Auth;
    }
    // BR#4754 — the train executor's shape: train.rs mcp() wraps every
    // JSON-RPC error as "hub rpc error (tool): <message>", and a dead/rotted
    // token surfaces as the hub's message text with NO HTTP status anywhere
    // in the string ("unknown auth token" — the Oct-29 blind-daemon
    // incident). Same repairable-by-ladder class: the token is rejected,
    // everything else about the hub is fine.
    if e.contains("unknown auth token") || e.contains("invalid auth token") {
        return HubErrClass::Auth;
    }
    HubErrClass::Transient
}

/// BR#4113 — bounded self-heal pacing for auth failures. The repair ladder
/// (keychain reload → re-vend by principal → self-provision) is attempted
/// with exponential backoff; after AUTH_PARK_ATTEMPTS failed ladder runs the
/// gateway PARKS LOUDLY — a needs-attention notice on the snapshot and UI —
/// and keeps polling on the capped cadence. It never logs out and never
/// breaks the loop while desired state is "running": a hub-side heal
/// (rotation grace, rollback, row restore) is picked up by the next poll and
/// dispatch resumes within one poll interval, zero human action.
///
/// crate-visible (BR#4754): the merge-train executor (train.rs) reuses the
/// SAME pacing + park threshold for its daemon loops — one mechanism, two
/// consumers; the hub rate-limits `/api/token/repair` per row (6/h), so an
/// unpaced ladder in a 45s tick loop would burn the mint budget in minutes.
pub(crate) struct AuthHeal {
    /// consecutive FAILED ladder runs
    pub(crate) streak: u32,
    last_attempt: Option<Instant>,
    parked: bool,
}

/// What run_loop should do about auth this iteration.
pub(crate) enum HealStep {
    /// run the repair ladder now
    Attempt,
    /// not yet due — keep polling quietly
    Wait,
}

/// Backoff between ladder runs: 5s doubling, capped at AUTH_BACKOFF_CAP_SECS.
pub(crate) fn auth_backoff_secs(failed_runs: u32) -> u64 {
    // failed_runs = 1 after the first failure → first retry after 5s
    let shift = failed_runs.saturating_sub(1).min(6);
    (5u64 << shift).min(AUTH_BACKOFF_CAP_SECS)
}

pub(crate) const AUTH_BACKOFF_CAP_SECS: u64 = 300;
pub(crate) const AUTH_PARK_ATTEMPTS: u32 = 5;

impl AuthHeal {
    pub(crate) fn new() -> Self {
        AuthHeal { streak: 0, last_attempt: None, parked: false }
    }

    /// An auth-classified tick error. Decides whether a ladder run is due.
    pub(crate) fn on_auth_failure(&mut self, now: Instant) -> HealStep {
        if let Some(t) = self.last_attempt {
            if now.duration_since(t).as_secs() < auth_backoff_secs(self.streak.max(1)) {
                return HealStep::Wait;
            }
        }
        self.last_attempt = Some(now);
        self.streak = self.streak.saturating_add(1);
        if self.streak >= AUTH_PARK_ATTEMPTS {
            self.parked = true;
        }
        HealStep::Attempt
    }

    /// A ladder leg succeeded — the hub re-vended this device. Fully re-arm.
    pub(crate) fn on_repair_success(&mut self) {
        *self = AuthHeal::new();
    }

    /// The hub accepted our token again without a repair (rollback, grace
    /// window re-opened, row restored) — same re-arm.
    pub(crate) fn on_hub_accepted(&mut self) {
        if self.streak > 0 || self.parked {
            *self = AuthHeal::new();
        }
    }
}

/// BR#4113 — one run of the auth self-heal ladder, in escalating order:
/// (1) reload the credential from the store — another process on this device
/// (the headless runner, a second window) may have re-vended the keychain
/// token after this loop started; (2) agent-plane re-vend by principal
/// (`repair_by_principal` — the rotate reflex, works headless); (3) human-
/// plane self-provision (the login is the approval; desktop only). Returns
/// the fresh config on the first leg that vends. Every failed leg is NAMED
/// in the returned reasons — logged and snapshotted by the caller, never
/// swallowed (the 2026-10-27 incidents: "repair failed" with zero why).
fn auth_repair_ladder(cfg: &DispatchConfig) -> Result<DispatchConfig, Vec<String>> {
    let mut failures: Vec<String> = Vec::new();
    // (1) keychain reload — adopt a token another process re-vended
    match DispatchConfig::resolve() {
        Some(fresh) if !fresh.token.is_empty() && fresh.token != cfg.token => {
            return Ok(fresh);
        }
        Some(_) => failures.push("keychain token unchanged — re-vending".to_string()),
        None => failures.push("no resolvable config in the store — keychain reload skipped".to_string()),
    }
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
    {
        Ok(c) => c,
        Err(be) => {
            failures.push(format!("repair client build failed: {be}"));
            return Err(failures);
        }
    };
    // (2) agent-plane re-vend by principal — headless-safe
    match repair_by_principal(&client, &cfg.url) {
        Ok(fresh) => return Ok(fresh),
        Err(pe) => failures.push(format!("principal repair: {pe}")),
    }
    // (3) human-plane self-provision — the desktop's web session is the approval
    match crate::session::load() {
        Some(s) => match self_provision(&client, &cfg.url, &s.value) {
            Ok(fresh) => Ok(fresh),
            Err(se) => {
                failures.push(format!("self-provision: {se}"));
                Err(failures)
            }
        },
        None => {
            failures.push(
                "no web session on this device — human-plane repair unavailable (headless)".to_string(),
            );
            Err(failures)
        }
    }
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

/// Operator control exchanges fail promptly; task/effect requests retain their
/// existing transport budget and the same durable retry/replay contract.
fn mcp_request_timeout(tool: &str, args: &serde_json::Value) -> Duration {
    let control = tool == "execution" && matches!(args.pointer("/command/kind").and_then(|v| v.as_str()), Some("pause_claims" | "resume_claims" | "advertise"));
    Duration::from_secs(if control { 8 } else { 30 })
}

/// MCP call with an explicit session name. Per-task attribution keeps the
/// implementation session distinct from the session that verifies it.
fn mcp_call_session(
    cfg: &DispatchConfig,
    id: &mut i64,
    tool: &str,
    args: serde_json::Value,
    session: Option<&str>,
) -> Result<serde_json::Value, String> {
    let timeout = mcp_request_timeout(tool, &args);
    mcp_call_session_with_timeout(cfg, id, tool, args, session, timeout)
}

fn mcp_call_session_with_timeout(
    cfg: &DispatchConfig,
    id: &mut i64,
    tool: &str,
    mut args: serde_json::Value,
    session: Option<&str>,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    *id += 1;
    if let Some(obj) = args.as_object_mut() {
        let name = session.map(String::from).unwrap_or_else(|| cfg.session_name());
        obj.entry("session").or_insert_with(|| json!(name));
        obj.insert("inventory_protocol".into(), json!(2));
    }
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(if timeout == Duration::from_secs(8) { Duration::from_secs(3) } else { timeout })
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())?;
    let fence = args.get("id").and_then(|v| v.as_str()).and_then(|tid| {
        EXECUTION_FENCES.get_or_init(Default::default).lock().ok().and_then(|m| m.get(tid).cloned().map(|f| (tid.to_string(), f)))
    });
    let mut request = client
        .post(format!("{}/mcp", cfg.url))
        .header("Authorization", format!("Bearer {}", cfg.token))
        .header("content-type", "application/json");
    if let Some((tid, (generation, attempt))) = fence {
        request = request.header("x-bridge-task", tid).header("x-bridge-generation", generation.to_string()).header("x-bridge-attempt", attempt);
    }
    let resp = request
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
        .map_err(|e| if e.is_timeout() {
            format!("bridge unreachable: {tool}/{} timed out after {}s (command_id={}); the request may have reached the hub", args.pointer("/command/kind").and_then(|v| v.as_str()).unwrap_or("call"), timeout.as_secs(), args["command_id"].as_str().unwrap_or("none"))
        } else { format!("bridge unreachable: {e}") })?;
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
    let body: serde_json::Value = resp.json().map_err(|e| if e.is_timeout() {
        format!("bridge unreachable: {tool} response timed out after {}s (command_id={})", timeout.as_secs(), args["command_id"].as_str().unwrap_or("none"))
    } else { format!("mcp response decode failed: {e}") })?;
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
        obj.insert("runner_protocol".into(), json!("worker-ready-v2"));
    }
    mcp_call_session(cfg, id, tool, args, Some(&claim_session(cfg, task_id)))
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
    // (identity-law run gate). The pair screen renders it
    // as a guided notice — what happened, that nothing was lost, one click to
    // re-pair — instead of leaving a silent logout in the dispatch log.
    pub logout_reason: Option<String>,
    pub logout_ts: Option<u64>,
    // BR#4113: sustained auth-failure park. The loop STAYS RUNNING (desired
    // state "running") while the hub rejects this device's credential — it
    // keeps polling and retrying the repair ladder on a capped cadence, and
    // resumes on its own the moment the hub accepts the device again. The
    // reason is surfaced loudly here (UI banner + runner.json) — never a
    // quiet stop, never a credential wipe.
    pub needs_attention: Option<String>,
    pub needs_attention_ts: Option<u64>,
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

#[derive(Clone, Copy)]
enum DispatchStage { Starting, Readiness, Checkpoint, Finalizing, Admission, Preparing, Hygiene, Waiting }

fn dispatch_stage(snap: &SharedSnapshot, stage: DispatchStage) {
    let label = match stage {
        DispatchStage::Starting => "starting",
        DispatchStage::Readiness => "checking worker readiness",
        DispatchStage::Checkpoint => "publishing checkpoint",
        DispatchStage::Finalizing => "draining completed workers",
        DispatchStage::Admission => "reserving eligible work",
        DispatchStage::Preparing => "preparing reserved worker",
        DispatchStage::Hygiene => "worktree hygiene (after admission)",
        DispatchStage::Waiting => "waiting for completion or poll",
    };
    dlog("", &format!("dispatch stage: {label}"));
    snap_activity(snap, "dispatch-stage", label);
    write_runner_state(snap);
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

/// BR#4113: raise the loud needs-attention park (sustained auth failure).
fn snap_needs_attention(snap: &SharedSnapshot, msg: &str) {
    if let Ok(mut s) = snap.lock() {
        s.needs_attention = Some(msg.to_string());
        s.needs_attention_ts = Some(now_ms());
    }
    snap_activity(snap, "error", msg);
}

/// BR#4113: clear the park — the hub accepted this device again (repair
/// succeeded, or a poll got through). The very next write_runner_state
/// persists the cleared field.
fn snap_needs_attention_clear(snap: &SharedSnapshot) {
    if let Ok(mut s) = snap.lock() {
        if s.needs_attention.is_some() {
            s.needs_attention = None;
            s.needs_attention_ts = None;
        }
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

/// BR#4113: same overlay treatment for the needs-attention park — a loop that
/// is still RUNNING (so dispatch_snapshot serves the external flat file in
/// the observing-desktop case) must still surface WHY it is not dispatching
/// when the flat file predates the park. `v` may be Null.
pub fn overlay_needs_attention(snap: &SharedSnapshot, v: &mut serde_json::Value) {
    let (reason, ts) = match snap
        .lock()
        .ok()
        .map(|s| (s.needs_attention.clone(), s.needs_attention_ts))
    {
        Some((Some(r), ts)) => (r, ts.unwrap_or(0)),
        _ => return,
    };
    if !v.is_object() {
        *v = serde_json::json!({ "running": true });
    }
    if let Some(obj) = v.as_object_mut() {
        obj.insert("needs_attention".into(), serde_json::Value::String(reason));
        obj.insert("needs_attention_ts".into(), serde_json::json!(ts));
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
    let dir = match std::env::var_os("BRIDGE_DISPATCH_DIR").filter(|v| !v.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => PathBuf::from(std::env::var("HOME").ok()?).join(".bridge").join("dispatch"),
    };
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Canonical worker-token cache file: $HOME/.bridge/dispatch/agent-tokens.json.
/// Deliberately NOT dispatch_dir(): the credential belongs to the gateway, not
/// an individual runner's ephemeral report directory (562f394) — side-by-side
/// runners (BRIDGE_DISPATCH_DIR set) must share one cache, so every read,
/// write AND clear (BR#6682) resolves this same fixed path.
fn agent_token_cache_path() -> Option<PathBuf> {
    Some(
        PathBuf::from(std::env::var("HOME").ok()?)
            .join(".bridge")
            .join("dispatch")
            .join("agent-tokens.json"),
    )
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
            // BR#4113: the sustained-auth-failure park rides the same file —
            // an observing desktop (or `bridge status`) sees WHY the gateway
            // is connected but not dispatching. Null when healthy.
            "needs_attention": s.needs_attention,
            "needs_attention_ts": s.needs_attention_ts,
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

/// Wake admission even when a worker panics/disconnects instead of returning.
struct CompletionSignal(Arc<AtomicBool>);
impl Drop for CompletionSignal {
    fn drop(&mut self) { self.0.store(true, Ordering::SeqCst); }
}

fn wait_for_dispatch_wake(poll: Duration, should_wake: impl Fn() -> bool) {
    let deadline = Instant::now() + poll;
    while Instant::now() < deadline && !should_wake() {
        std::thread::sleep(Duration::from_millis(100).min(deadline.saturating_duration_since(Instant::now())));
    }
}

struct InFlight {
    task_id: String,
    completed: Arc<AtomicBool>,
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
    execution: ExecutionRuntime,
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
    available_backends_with_progress(cfg, &|_| {})
}

fn available_backends_with_progress(cfg: &DispatchConfig, report: &dyn Fn(&str)) -> Vec<opencode::Backend> {
    cfg.backends
        .iter()
        .filter(|(name, bc)| {
            if !bc.enabled { return false; }
            let bin = bc.bin.clone().unwrap_or_else(|| match opencode::Backend::parse(Some(name)) {
                opencode::Backend::Kiro => "kiro".to_string(),
                _ => cfg.opencode_bin.clone(),
            });
            report(&format!("ready: probing backend {name}"));
            match probe_version(&bin) {
                Ok(()) => true,
                Err(error) => { report(&format!("ready: backend {name} unavailable: {error}")); false }
            }
        })
        .map(|(name, _)| opencode::Backend::parse(Some(name)))
        .collect()
}

fn probe_version(bin: &str) -> Result<(), String> {
    let mut command = Command::new(bin);
    command.arg("--version");
    probe_command(command, Duration::from_secs(2))
}

/// Readiness probes must not wait on stdin, pipe descendants, or tool startup
/// indefinitely. Each probe owns a fresh process group; never a worker's group.
fn probe_command(mut command: Command, budget: Duration) -> Result<(), String> {
    command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(unix)] {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|e| format!("cannot start version probe: {e}"))?;
    let deadline = Instant::now() + budget;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return if status.success() { Ok(()) } else { Err(format!("version probe failed: {status}")) },
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            result => {
                #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
                let _ = child.kill();
                let _ = child.wait();
                return Err(match result { Err(e) => format!("cannot poll version probe: {e}"), _ => format!("version probe timed out after {}ms", budget.as_millis()) });
            }
        }
    }
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
/// 2026-11-02: every provisioned tree is REGISTERED (the machine-local
/// worktree registry) so the sweep knows it mechanically — see
/// worktree_registry_append.
fn ensure_worktree(repo_path: &PathBuf, task_id: &str, resume: bool) -> Option<PathBuf> {
    let slug = slugify(task_id);
    let home = std::env::var("HOME").ok().map(PathBuf::from);
    let nested = repo_path.join(".worktrees").join(&slug);
    let legacy = home.as_ref().map(|h| {
        h.join(".bridge").join("worktrees").join(&slug)
    });
    // reuse: nested first (the convention), legacy second (resume compat)
    if nested.exists() {
        worktree_registry_append(home.as_deref(), &nested, &repo_path.to_string_lossy(), task_id);
        return Some(nested);
    }
    if legacy.as_ref().map(|p| p.exists()).unwrap_or(false) {
        worktree_registry_append(home.as_deref(), legacy.as_ref().unwrap(), &repo_path.to_string_lossy(), task_id);
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
        worktree_registry_append(home.as_deref(), &nested, &repo_path.to_string_lossy(), task_id);
        return Some(nested);
    }
    // nested add refused (clone predates the .gitignore convention) — fall
    // back to the legacy location so isolation still holds.
    let Some(path) = legacy else { return None };
    std::fs::create_dir_all(path.parent()?).ok()?;
    if add_at(&path) {
        worktree_registry_append(home.as_deref(), &path, &repo_path.to_string_lossy(), task_id);
        return Some(path);
    }
    let mut cmd = Command::new("git");
    cmd.current_dir(repo_path)
        .args(["worktree", "add"])
        .arg(&path)
        .arg(&branch);
    let ok = cmd.output().map(|o| o.status.success()).unwrap_or(false);
    if ok {
        worktree_registry_append(home.as_deref(), &path, &repo_path.to_string_lossy(), task_id);
    }
    ok.then_some(path)
}

/// Run a command with a hard deadline: kill on expiry and report. The sign
/// check must never hang the dispatch loop (a misconfigured signingProgram —
/// e.g. a 1Password bridge that blocks on a locked agent — must fail loudly,
/// not stall dispatch). ssh-keygen from file signs instantly; 15s is generous.
pub(crate) fn run_with_timeout(mut cmd: Command, secs: u64) -> Result<std::process::Output, String> {
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
    if !path.exists() { return None; }
    // No lossy best-effort teardown. A failed status/publication probe retains
    // the registered tree; only remotely reachable committed content is swept.
    let status = Command::new("git").current_dir(path).args(["status", "--porcelain"]).output();
    if !matches!(&status, Ok(o) if o.status.success() && o.stdout.is_empty()) {
        return Some(format!("retained {}: local WIP requires a published checkpoint before cleanup", path.display()));
    }
    let remote = Command::new("git").current_dir(path).args(["branch", "-r", "--contains", "HEAD"]).output();
    if !matches!(&remote, Ok(o) if o.status.success() && !o.stdout.is_empty()) {
        return Some(format!("retained {}: unpublished committed work", path.display()));
    }
    if !path.exists() {
        return None;
    }
    // 2026-11-02: deregister FIRST — the teardown owns this tree, the
    // registry must not outlive it (a stale line prunes on next read, but
    // the contract is explicit).
    worktree_registry_remove(std::env::var("HOME").ok().map(PathBuf::from).as_deref(), path);
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
const WORKTREE_SWEEP_CAP: usize = 4;
const WORKTREE_SWEEP_PROBE_BUDGET: Duration = Duration::from_secs(3);
const WORKTREE_STATUS_TIMEOUT: Duration = Duration::from_secs(1);
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

/// Persist a round's remaining paths, rather than starting from the same kept
/// trees every tick. Newly registered paths enter at the next oldest-first round.
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct WorktreeSweepCursor {
    remaining: std::collections::VecDeque<PathBuf>,
}

fn sweep_candidate_batch(
    candidates: Vec<WorktreeCandidate>,
    cursor: &mut WorktreeSweepCursor,
    budget: Duration,
    mut status: impl FnMut(&WorktreeCandidate, Duration) -> Option<String>,
    mut cleanup: impl FnMut(&WorktreeCandidate, bool, &str),
) -> (usize, usize) {
    if cursor.remaining.is_empty() {
        cursor.remaining.extend(candidates.iter().map(|c| c.path.clone()));
    }
    let mut by_path: HashMap<_, _> = candidates.into_iter().map(|c| (c.path.clone(), c)).collect();
    let deadline = Instant::now() + budget;
    let (mut inspected, mut swept) = (0, 0);
    while inspected < WORKTREE_SWEEP_CAP && Instant::now() < deadline {
        let Some(path) = cursor.remaining.pop_front() else { break; };
        let Some(candidate) = by_path.remove(&path) else { continue; };
        inspected += 1; // retained/unresolvable trees consume the budget too
        let age = std::time::SystemTime::now().duration_since(candidate.mtime).map(|d| d.as_secs()).unwrap_or(u64::MAX);
        let state = if age < WORKTREE_STALE_SECS {
            status(&candidate, WORKTREE_STATUS_TIMEOUT.min(deadline.saturating_duration_since(Instant::now())))
        } else { None };
        let (remove, drop_branch, reason) = sweep_disposition(age, state.as_deref());
        if remove { cleanup(&candidate, drop_branch, &reason); swept += 1; }
    }
    (inspected, swept)
}

// ---- worktree registry (2026-11-02, Ray: "you can both direct agents AND
// know what worktrees were made — no guessing, mechanical and structural
// assertions") ----
// The machine-local record of every worktree the system directed a session
// to create. Three mechanical facts close the leak loop:
//   1. the runner REGISTERS on provision (ensure_worktree) and deregisters
//      on teardown (cleanup_worktree_at) — its trees are never anonymous;
//   2. directed agents register theirs at creation — the claim-locally
//      prompt and AGENTS.md carry the exact append one-liner;
//   3. the sweep enumerates REGISTERED paths as candidates (a registry×disk
//      join), never a filesystem hunt or a hardcoded root list — dead lines
//      are dropped on read so the file stays bounded.
// Format: JSONL at ~/.bridge/worktree-registry.jsonl, one entry per line:
// {"path":"/abs","repo":"owner/name or path","task":"BR#N or slug","ts":ms}.

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
struct WorktreeRegEntry {
    path: String,
    repo: String,
    task: String,
    ts: u64,
}

fn worktree_registry_path(home: &Path) -> PathBuf {
    home.join(".bridge").join("worktree-registry.jsonl")
}

fn worktree_registry_load(home: &Path) -> Vec<WorktreeRegEntry> {
    let Ok(lines) = std::fs::read_to_string(worktree_registry_path(home)) else {
        return vec![];
    };
    lines.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

/// Best-effort registration — the path IS the record; a failed append never
/// blocks provisioning (the sweep's dir scans still cover the runner's own
/// trees). Home comes from the caller so tests inject a scratch root.
fn worktree_registry_append(home: Option<&Path>, path: &Path, repo: &str, task: &str) {
    use std::io::Write;
    let Some(home) = home else { return };
    let entry = WorktreeRegEntry {
        path: path.to_string_lossy().into_owned(),
        repo: repo.to_string(),
        task: task.to_string(),
        ts: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    };
    let _ = std::fs::create_dir_all(home.join(".bridge"));
    let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(worktree_registry_path(home))
    else {
        return;
    };
    let _ = writeln!(f, "{}", serde_json::to_string(&entry).unwrap_or_default());
}

/// Deregistration: drop every line naming this path — the teardown owns the
/// tree, the registry must not outlive it. Home comes from the caller so
/// tests inject a scratch root.
fn worktree_registry_remove(home: Option<&Path>, path: &Path) {
    let Some(home) = home else {
        return;
    };
    let reg = worktree_registry_path(&home);
    let Ok(s) = std::fs::read_to_string(&reg) else {
        return;
    };
    let p = path.to_string_lossy();
    let kept: Vec<String> = s
        .lines()
        .filter_map(|l| serde_json::from_str::<WorktreeRegEntry>(l).ok())
        .filter(|e| e.path != p)
        .filter_map(|e| serde_json::to_string(&e).ok())
        .collect();
    let _ = std::fs::write(
        &reg,
        if kept.is_empty() { String::new() } else { kept.join("\n") + "\n" },
    );
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
/// 2026-11-02: also collects (a) the runner's own `<workdir>/worktrees/<slug>`
/// root (observed leak: br4994-corpus sat there while the sweep passed it by),
/// and (b) every REGISTERED worktree of the clones under `<workdir>/repos` and
/// the configured `sweep_repos` roots (`git worktree list --porcelain`) — the
/// dir scans can only see their own roots, but registered trees live wherever
/// their session put them (the checkout's .worktrees/, ~/Projects/wt-*,
/// /tmp/...). Enumeration skips each repo's main worktree (the root itself).
fn collect_worktree_candidates(
    workdir: &Path,
    home: Option<&Path>,
    active: &HashSet<String>,
    sweep_repos: &[String],
) -> Vec<WorktreeCandidate> {
    let mut found: Vec<WorktreeCandidate> = Vec::new();
    let push_entry =
        |e: std::fs::DirEntry, found: &mut Vec<WorktreeCandidate>| {
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
                    push_entry(e, &mut found);
                }
            }
        }
    }
    // 2026-11-02: the runner's own trees root — <workdir>/worktrees/<slug>
    if let Ok(entries) = std::fs::read_dir(workdir.join("worktrees")) {
        for e in entries.flatten() {
            push_entry(e, &mut found);
        }
    }
    // legacy: ~/.bridge/worktrees/<slug>
    if let Some(home) = home {
        if let Ok(entries) = std::fs::read_dir(home.join(".bridge").join("worktrees")) {
            for e in entries.flatten() {
                push_entry(e, &mut found);
            }
        }
    }
    // registered enumeration: every clone under <workdir>/repos plus the
    // configured sweep_repos roots (e.g. the shared checkout). A repo root
    // that is not a git repo contributes nothing — scoped skip.
    let mut repo_roots: Vec<PathBuf> = std::fs::read_dir(workdir.join("repos"))
        .map(|it| it.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();
    repo_roots.extend(
        sweep_repos
            .iter()
            .map(PathBuf::from)
            .filter(|p| p.join(".git").exists()),
    );
    for root in repo_roots {
        let Ok(out) = Command::new("git")
            .current_dir(&root)
            .args(["worktree", "list", "--porcelain"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output()
        else {
            continue;
        };
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let Some(p) = line.strip_prefix("worktree ") else {
                continue;
            };
            let path = PathBuf::from(p);
            if path == root {
                continue; // the repo's own main worktree is not a candidate
            }
            let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
                continue;
            };
            if name.is_empty() || active.contains(&name) {
                continue;
            }
            // dedup by path against what the dir scans already collected
            if found.iter().any(|c| c.path == path) {
                continue;
            }
            let mtime = std::fs::metadata(&path)
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            found.push(WorktreeCandidate { slug: name, path, mtime });
        }
    }
    // registered (2026-11-02): the registry×disk join — every REGISTERED path
    // is a candidate wherever it lives on disk (the agent chose the path;
    // the sweep never hunts for it). Dead lines (path gone) are pruned on
    // read so the file stays bounded; in-flight slugs stay protected by the
    // `active` set above; the disposition rules then apply as usual.
    if let Some(home) = home {
        let entries = worktree_registry_load(home);
        let mut dead = false;
        for e in &entries {
            let p = PathBuf::from(&e.path);
            if !p.exists() {
                dead = true;
                continue;
            }
            let Some(name) = p.file_name().map(|n| n.to_string_lossy().to_string()) else {
                continue;
            };
            if name.is_empty() || active.contains(&name) {
                continue;
            }
            if found.iter().any(|c| c.path == p) {
                continue;
            }
            let mtime = std::fs::metadata(&p)
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            found.push(WorktreeCandidate { slug: name, path: p, mtime });
        }
        if dead {
            let kept: Vec<String> = entries
                .iter()
                .filter(|e| PathBuf::from(&e.path).exists())
                .filter_map(|e| serde_json::to_string(e).ok())
                .collect();
            let _ = std::fs::write(
                worktree_registry_path(home),
                if kept.is_empty() { String::new() } else { kept.join("\n") + "\n" },
            );
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
        &cfg.sweep_repos,
    );
    // dedup by slug (same name in both roots → nested wins), then drain
    // oldest-first: the cap must always bite the worst offenders
    found.sort_by(|a, b| a.slug.cmp(&b.slug));
    found.dedup_by(|a, b| a.slug == b.slug);
    found.sort_by(|a, b| a.mtime.cmp(&b.mtime).then(a.path.cmp(&b.path)));
    let cursor_path = dispatch_dir().map(|p| p.join("worktree-sweep-cursor.json"));
    let mut cursor: WorktreeSweepCursor = cursor_path.as_ref().and_then(|p| std::fs::read(p).ok())
        .and_then(|data| serde_json::from_slice(&data).ok()).unwrap_or_default();
    let (inspected, swept) = sweep_candidate_batch(found, &mut cursor, WORKTREE_SWEEP_PROBE_BUDGET,
        |candidate, timeout| {
            mcp_call_session_with_timeout(cfg, id, "get_artefact", json!({ "id": reverse_task_slug(&candidate.slug) }), None, timeout)
                .ok().and_then(|v| v["status"].as_str().map(String::from))
        },
        |candidate, drop_branch, reason| {
            let preserved = cleanup_worktree_at(&candidate.path, &reverse_task_slug(&candidate.slug), drop_branch);
            msgs.push(format!("swept worktree {} — {}{}", candidate.slug, reason,
                preserved.map(|b| format!("; WIP preserved on {b}")).unwrap_or_default()));
        });
    if let Some(path) = cursor_path {
        if let Ok(data) = serde_json::to_vec(&cursor) {
            let staged = path.with_extension("tmp");
            if std::fs::write(&staged, data).is_ok() { let _ = std::fs::rename(staged, path); }
        }
    }
    dlog("", &format!("worktree hygiene: inspected {inspected}, swept {swept}, {} pending in round", cursor.remaining.len()));
    if swept > 0 {
        // prune the clones that actually own the registrations. cfg.workdir is
        // scratch space, NOT a repo — the old prune against it was a silent
        // no-op that left ghost registrations in the owning clones (BR#2421).
        let mut prune_roots: Vec<PathBuf> = std::fs::read_dir(PathBuf::from(&cfg.workdir).join("repos"))
            .map(|it| it.flatten().map(|e| e.path()).collect())
            .unwrap_or_default();
        prune_roots.extend(
            cfg.sweep_repos
                .iter()
                .map(PathBuf::from)
                .filter(|p| p.join(".git").exists()),
        );
        for repo in prune_roots {
            let _ = Command::new("git")
                .current_dir(repo)
                .arg("worktree")
                .arg("prune")
                .output();
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
    MARKERS.iter().any(|m| text.contains(m)) || bridge_tools_missing(text)
}

const BRIDGE_TOOLS_MISSING: &str = "MCP UNAVAILABLE: bridge tools missing";

fn bridge_tools_missing(text: &str) -> bool {
    text.lines().any(|line| line.trim() == BRIDGE_TOOLS_MISSING)
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
        || bridge_tools_missing(stdout) || bridge_tools_missing(stderr)
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
        None => dlog(
            tid,
            "release raced (gate refused, card not released) — no note posted (BR#3611)",
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
        // BR#6135 interactive claim takeover: the owner/web re-took the
        // claim from this runner mid-run; the takeover-stale-holder rule
        // rejects the runner's next state change with a stand-down order.
        // Same family as a lost claim race — never a dispatch failure.
        || e.contains("was taken over by")
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
    // BR#6135: "was taken over by" is the takeover-stale-holder rule's stable
    // prefix — a stood-down runner is a lost race, not a broken agent.
    const SIGS: [&str; 3] = ["not allowed (allowed:", "is claimed by", "was taken over by"];
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
    _role_type: &str,
    avail: &[opencode::Backend],
    in_flight: &mut Vec<InFlight>,
    worker: &WorkerCredential,
    readiness_observed: &mut Instant,
) {
    let preparation_started = Instant::now();
    dispatch_stage(snap, DispatchStage::Preparing);
    let eligible: Vec<_> = avail.iter().copied().filter(|b| backend_satisfies(cfg, *b, task_meta)).collect();
    if eligible.is_empty() {
        failed_start(cfg, tid, StartStage::Begin, "gate: selected capability no longer available on this host", None, None);
        return;
    }
    let backend = *eligible.iter().min_by_key(|b| selected_model(cfg, **b, task_meta).map(|(tier, _)| tier)).unwrap();
    let (model_tier, model_id) = selected_model(cfg, backend, task_meta).expect("eligible backend has a configured model");

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
    let model = Some(model_id);
    let model_str = model.clone().unwrap_or_default();
    // A different model gets a fresh session, preserving the checkpoint/WIP.
    let previous = task_meta.get("execution_last_model");
    let model_changed = previous.and_then(|p| p["model"].as_str()) != model.as_deref()
        || previous.and_then(|p| serde_json::from_value::<ReasoningTier>(p["tier"].clone()).ok()) != Some(model_tier)
        || previous.and_then(|p| p["backend"].as_str()) != Some(backend_name);
    let resume_session = if model_changed { None } else if resume_session.is_none() && backend == opencode::Backend::Kiro {
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
        dlog(
            tid,
            &format!(
                "per-task worktree skipped — {}",
                if surgical {
                    "task is surgical-by-declaration"
                } else {
                    "repo is worktree-exempt"
                }
            ),
        );
    }
    let worktree = if let Some(url) = &repo_url {
        let repo_path = match ensure_repo_clone(&cfg.workdir, url) {
            Ok(p) => p,
            Err(e) => {
                dlog(
                    tid,
                    &format!(
                        "error: clone failed for {url} — {} — skipping spawn",
                        e.detail()
                    ),
                );
                snap_activity(
                    snap,
                    "error",
                    &format!("{tid}: clone failed ({url}): {}", e.detail()),
                );
                let reason = format!("{}clone of {url} failed: {}", if e.fatal() { "gate: " } else { "" }, e.detail());
                failed_start(cfg, tid, StartStage::Begin, &reason, None, None);
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
            let detail =
                "worktree isolation unavailable — refusing to dispatch into the shared checkout (fix git state or set isolate=false knowingly)";
            dlog(tid, &format!("error: {detail}"));
            snap_activity(snap, "error", &format!("ERROR: {tid}: {detail}"));
            failed_start(cfg, tid, StartStage::Begin, &format!("gate: {detail}"), None, Some(&repo_path));
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
                let detail = format!(
                    "identity profile failed — refusing to dispatch ({e}). Fix the runner's identity config or provision the signing key."
                );
                dlog(tid, &format!("error: {detail}"));
                snap_activity(snap, "error", &format!("ERROR: {tid}: {detail}"));
                note_task(
                    cfg,
                    tid,
                    &format!(
                        "runner: identity profile failed — {} (task not dispatched; will retry next cycle)",
                        e
                    ),
                );
                failed_start(cfg, tid, StartStage::Inspect, &format!("gate: {detail}"), None, Some(wt));
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
    let direct_main = repo_url.as_deref().map(|url| url.trim_end_matches(".git").ends_with("/state-vector/bridge")).unwrap_or(false);
    let delivery_line = if role_work || repo_url.is_none() {
        "- Deliver findings, independent verdicts and exact receipts on the board. Review only work implemented by another session. Execution tasks require actual outcome evidence; prerequisite delivery is not completion. Follow the provisioned repository's delivery policy if code changes are necessary."
    } else if direct_main {
        "- Bridge delivery policy v1: signed direct-main delivery. Work in this isolated worktree; fetch/integrate origin/main, run required gates, and push HEAD:main. Submit the commit and green CI receipts through in_review for an independent session. Docs ride with user-visible changes: README.md and packages/site/content.md. Never self-certify acceptance."
    } else {
        "- Commit signed work, push the branch and open a PR against the repository's default branch. Submit in_review with its URL. Independent verification and the merge train own acceptance/merge; do not merge your own PR or push the default branch. Fix mechanical conflicts/rebases autonomously. Update the repository's user-facing docs with behaviour changes."
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
    let bridge_session = claim_session(cfg, tid);
    let env_block = format!(
        "# Environment\n\n- Your bridge session name is `{bridge_session}` — pass `session: \"{bridge_session}\"` on every bridge MCP call (orient, log_progress, transition, ask_agent). That is the session holding this task's claim; orienting as any other name shows you an empty desk and breaks attribution.\n- The `bridge` MCP server is already configured in this CLI. Its tools (orient, log_progress, transition, ask_agent, get_artefact, search_knowledge, related_artefacts, get_history) are the only interface to the board — call them directly.\n- Do NOT hunt for a `bridge` CLI, probe the hub over HTTP, or read `~/.bridge` — that directory is runner-internal state, not yours. If the bridge tools are genuinely absent from this session, output `MCP UNAVAILABLE: bridge tools missing` and end the run; do not attempt to reconstruct access."
    );
    let mut prompt = format!(
        "{}\n\n# Task\n\n{}: {}\n\n{}\n{}\n\n{}\n\n# Delivery contract (execution policy v1)\n\n{}\n{}\n{}\n- Blocked on a specific human decision? Bind an ask to this task. Machine capability problems use the execution protocol escalation, not a human staffing request.\n- Do not touch files outside this worktree. Never detach a subprocess from the runner process group: transfer requires a proven empty writer group.\n- Scratch git worktrees or extra branches you create inside this worktree are your responsibility — remove them before you end the run. The dispatch worktree itself is managed by the runner.",
        policy, tid, title, body_md, resume_note, env_block, provisioning_line, heartbeat_line, delivery_line
    );
    // clone for the ephemeral state file: the closure below moves the original
    let resume_session_for_state = resume_session.clone();
    dlog(
        tid,
        &format!(
            "preparing — {} opencode session bridge-{tid}{}",
            if resume {
                format!(
                    "resuming session {}",
                    resume_session.as_deref().unwrap_or("?")
                )
            } else {
                "new".to_string()
            },
            worktree
                .as_ref()
                .map(|p| format!(" (worktree {})", p.display()))
                .or_else(|| scratch
                    .as_ref()
                    .map(|p| format!(" (scratch {})", p.display())))
                .unwrap_or_default(),
        ),
    );
    snap_activity(
        snap,
        "startup",
        &format!(
            "{tid} preparing launch — {}",
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
    // Provision the worker's per-agent token. There is NO second class check
    // here: the token secret is opaque (bkw_*), so a prefix test can never
    // work, and the class gate is run_loop's (config gateway flag). If
    // provisioning fails there is no fallback — dispatching under the
    // gateway's own token would mis-attribute every board action. Release
    // the claim instead; transient hub failures self-heal next tick (the
    // runner may release its own claims, BR#2419).
    // Bind the credential actually proved/minted by the hub, not the cache key
    // requested before rename/canonicalisation. Labels are not credential IDs.
    let agent_label = &worker.label;
    let agent_token = &worker.secret;
    // Durable lease BEFORE spawning; no legacy fallback when this gate fails.
    match execution_call(cfg, tid, json!({ "kind": "inspect" })).and_then(RemoteExecution::parse) {
        Ok(s) if !matches!(s.handoff, RemoteHandoff::None | RemoteHandoff::Returned) || s.attempt.as_ref().map(|a| !matches!(a.state, RemoteAttemptState::Quiesced)).unwrap_or(false) => {
            dlog(tid, "execution held: prior writer/restoration still requires quiescence reconciliation; not retrying begin");
            return;
        }
        Err(e) => { failed_start(cfg, tid, StartStage::Inspect, &e, None, worktree.as_deref()); return; }
        _ => {}
    }
    let expected_attempt = format!("{}-{}", std::process::id(), now_ms());
    let begin = begin_with_fresh_readiness(readiness_observed, update_request().is_some(), || {
        // The tick already advertised this exact worker/config inventory. Do
        // not run every local probe + hub advertisement again for every slot.
        // Refresh after slow provisioning, with margin under the hub's 120s
        // freshness gate. Begin still atomically checks live selection/scope.
        let capabilities = capability_inventory(cfg, avail, Some(worker), backend_name);
        let ready = execution_call(cfg, tid, json!({ "kind": "advertise", "capabilities": capabilities }))?;
        if ready["ok"] != true { return Err(format!("executor readiness held: {}", ready["readiness"])); }
        Ok(())
    }, || {
        execution_call(cfg, tid, json!({ "kind": "begin", "attempt_id": expected_attempt, "worker": agent_label, "action_budget_ms": (cfg.timeout_mins * 60_000).clamp(10_000, 3_600_000),
            "selection": { "backend": backend_name, "model": model_str, "tier": model_tier } }))
    });
    let state = match begin {
        Ok(s) => s,
        Err(e) => { failed_start(cfg, tid, StartStage::Begin, &e, Some(&expected_attempt), worktree.as_deref()); return; }
    };
    let remote = match RemoteExecution::parse(state.clone()).and_then(|s| s.attempt.ok_or("execution begin returned no attempt".into())) {
        Ok(a) if a.generation > 0 && !a.attempt_id.is_empty() => a,
        _ => { failed_start(cfg, tid, StartStage::Begin, "durable execution response malformed", Some(&expected_attempt), worktree.as_deref()); return; }
    };
    let generation = remote.generation;
    let attempt_id = remote.attempt_id;
    let mut execution = ExecutionRuntime { generation, attempt_id, control: Arc::new(crate::transport::RunControl::default()), maintenance: None, last_checkpoint: Instant::now() };
    execution.control.grant_lease();
    prompt.push_str(&format!("\n\n# Durable execution\nGeneration {generation}, attempt {}. Use execution(id={tid}, command_id=<unique stable id>, command=...) to acknowledge messages, request a higher minimum reasoning tier, and prepare/result external GitHub/AWS operations with exact input revisions, time budgets and receipts. An unknown outcome must be inspected, not repeated. Before acting on an outstanding coordination message, read it and explicitly report ack(state=acted) after applying it. Outstanding mailbox: {}\n", execution.attempt_id, state["messages"]));
    prompt.push_str(&format!("\nActual execution model: {model_str}, reasoning tier {}. If this task exceeds your capability, inspect execution(command={{kind:availability}}) for next_available_tier, then request execution(command={{kind:escalate,generation:{generation},attempt_id:\"{}\",tier:<larger tier>,reason:<concrete limitation and next step>}}). Stop working after escalation; the runner publishes your checkpoint, stops writers and yields the task. An explicit unavailable tier blocks rather than downgrades. Ordinary review findings are not automatic escalation; a review duty can close with review_result={{kind:stronger_implementation_required,task_id:<subject>,summary:<why a larger model is necessary>}} when a larger tier is available. Human asks are only for a specific missing human decision/authority/information; low confidence, CI waiting and mechanical recovery alone are not human blockers. Use local_handoff only for a concrete local-only operation, with full findings and continuation details.\n", serde_json::to_string(&model_tier).unwrap_or_default(), execution.attempt_id));
    EXECUTION_FENCES.get_or_init(Default::default).lock().unwrap().insert(tid.into(), (generation, execution.attempt_id.clone()));
    execution.start_maintenance(cfg, tid);
    if let RemoteAttemptState::Restoring { checkpoint: cp } = remote.state {
        let restored = (|| -> Result<(), String> {
            let path = worktree.as_deref().ok_or("portable checkpoint requires an isolated Git worktree")?;
            crate::checkpoint::restore(path, &cp)?;
            let mut cmd = execution.command("restore"); cmd["tree"] = json!(cp.tree); cmd["commit"] = json!(cp.commit);
            execution_call(cfg, tid, cmd)?;
            Ok(())
        })();
        if let Err(e) = restored {
            execution.stop_maintenance();
            dlog(tid, &format!("checkpoint restore held: {e}; no agent spawned"));
            // This attempt has never spawned a child. Preserve checkpoint/WIP;
            // don't leave an imaginary writer lease blocking reconciliation.
            let mut cmd = execution.command("quiesce"); cmd["writers"] = json!("process_group_empty");
            let _ = execution_call(cfg, tid, cmd);
            return;
        }
    }
    let safe_point = match execution_call(cfg, tid, execution.command("poll")) {
        Ok(s) => s,
        Err(e) => { execution.stop_maintenance(); failed_start(cfg, tid, StartStage::Begin, &e, Some(&execution.attempt_id), worktree.as_deref()); return; }
    };
    prompt.push_str(&format!("\nLatest safe-point mailbox (read and apply before conflicting work): {}\n", safe_point["messages"]));
    for message in safe_point["messages"].as_array().into_iter().flatten().filter(|m| m["state"] == "delivered") {
        let mut cmd = execution.command("ack"); cmd["message_id"] = message["id"].clone(); cmd["state"] = json!("acknowledged");
        if execution_call(cfg, tid, cmd).is_err() { return; }
    }
    if execution.control.stop.load(Ordering::SeqCst) || !matches!(RemoteExecution::parse(safe_point).ok().and_then(|s| s.attempt).map(|a| a.state), Some(RemoteAttemptState::Running)) {
        execution.stop_maintenance();
        let mut cmd = execution.command("quiesce"); cmd["writers"] = json!("process_group_empty");
        let _ = execution_call(cfg, tid, cmd);
        dlog(tid, "safe-point interruption before spawn; no writer launched");
        return;
    }
    execution.control.grant_lease();
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
                    "headers": { "Authorization": format!("Bearer {}", agent_token), "x-bridge-task": tid, "x-bridge-generation": generation.to_string(), "x-bridge-attempt": execution.attempt_id }
                }}
            })
            .to_string(),
        )
    };
    let completed = Arc::new(AtomicBool::new(false));
    let outcome = {
        let cfg2 = cfg.clone();
        let tid2 = tid.to_string();
        let bin = bc.bin.clone();
        let control = execution.control.clone();
        let execution_for_task = execution.clone();
        let completion_signal = CompletionSignal(completed.clone());
        let (tx, rx) = std::sync::mpsc::channel::<opencode::RunOutcome>();
        std::thread::spawn(move || {
            let _completion_signal = completion_signal;
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
                Some(control),
            );
            // Capture at transport return, not after the main loop gets around
            // to draining this receiver. A daemon crash during another task's
            // network finalization must not lose this stopped-writer proof.
            if execution_for_task.control.quiesced.load(Ordering::SeqCst) {
                if let Err(error) = persist_stopped_receipt(&cfg2, &tid2, &execution_for_task, true) {
                    dlog(&tid2, &format!("transport stopped proof could not be persisted: {error}"));
                }
            }
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
        completed,
        task_title: title.to_string(),
        role_work,
        started: std::time::Instant::now(),
        last_note: String::new(),
        worktree,
        scratch,
        pr_url: None,
        rx: outcome,
        live,
        execution,
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
    write_runner_state(snap);
    dlog(tid, &format!("worker launched after {}ms preparation", preparation_started.elapsed().as_millis()));
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
        let sig = [BRIDGE_TOOLS_MISSING, "Unexpected server error", "Model blocked by guardrail", "0 endpoints out of", "no endpoints are available matching your guardrail", "UnknownError"]
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
    readiness: &GatewayReadiness,
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
    stop: &AtomicBool,
) -> Result<Vec<String>, String> {
    let mut msgs = Vec::new();

    dispatch_stage(snap, DispatchStage::Readiness);
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
        if let Some(name) = cfg.backends.keys().next() {
            let capabilities = capability_inventory(cfg, &[], None, name);
            let _ = execution_call(cfg, "gateway", json!({ "kind": "advertise", "capabilities": capabilities }));
        }
        let msg = "FATAL: no dispatchable agents (CLI missing/unrunnable or model unconfigured) — run `bridge doctor`; exiting so systemd reports it (in-flight sessions drain first)";
        dlog("", msg);
        snap_activity(snap, "error", msg);
        if in_flight.is_empty() {
            std::process::exit(1);
        }
    } else if !*last_avail_ok {
        dlog("", "agents available — resuming claims");
        snap_activity(snap, "info", "agents available — resuming claims");
    }
    *last_avail_ok = avail_ok;
    let mut prepared_worker = match readiness.proof(cfg) {
        Ok(proof) => Some((proof.worker, proof.observed)),
        Err(error) => {
            // A refused background credential must still reach the existing
            // gateway auth-heal ladder, rather than silently waiting forever.
            if classify_hub_error(&error) == HubErrClass::Auth { return Err(error); }
            dlog("", &format!("execution protocol not ready: {error}; waiting for independent readiness renewal"));
            None
        }
    };

    // Lease/action/inbox clocks are independent of stdout. A lost hub or an
    // expired action budget stops the process group; it never buys more work
    // merely because the model keeps printing. No hot interrupt API is assumed.
    for inf in in_flight.iter_mut() {
        if !inf.execution.control.stop.load(Ordering::SeqCst) && inf.execution.last_checkpoint.elapsed() >= Duration::from_secs(300) {
            dispatch_stage(snap, DispatchStage::Checkpoint);
            if let Some(path) = inf.worktree.as_deref() {
                if let Err(e) = inf.execution.checkpoint(cfg, &inf.task_id, path) {
                    dlog(&inf.task_id, &format!("checkpoint publication failed: {e}; retain local WIP/host affinity"));
                }
            }
            inf.execution.last_checkpoint = Instant::now();
        }
    }

    // 1. drain finished sessions: finalize each (progress + in_review + cleanup)
    dispatch_stage(snap, DispatchStage::Finalizing);
    let mut finished: Vec<(InFlight, opencode::RunOutcome)> = Vec::new();
    in_flight.retain_mut(|inf| match inf.rx.try_recv() {
        Ok(outcome) => {
            finished.push((
                InFlight {
                    task_id: inf.task_id.clone(),
                    completed: inf.completed.clone(),
                    task_title: inf.task_title.clone(),
                    role_work: inf.role_work,
                    started: inf.started,
                    last_note: inf.last_note.clone(),
                    pr_url: inf.pr_url.clone(),
                    worktree: inf.worktree.clone(),
                    scratch: inf.scratch.clone(),
                    rx: std::sync::mpsc::channel().1,
                    live: inf.live.clone(),
                    execution: inf.execution.clone(),
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
                    completed: inf.completed.clone(),
                    task_title: inf.task_title.clone(),
                    role_work: inf.role_work,
                    started: inf.started,
                    last_note: inf.last_note.clone(),
                    pr_url: inf.pr_url.clone(),
                    worktree: inf.worktree.clone(),
                    scratch: inf.scratch.clone(),
                    rx: std::sync::mpsc::channel().1,
                    live: inf.live.clone(),
                    execution: inf.execution.clone(),
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
                dlog(
                    &inf.task_id,
                    &format!("{}m in · {}", inf.started.elapsed().as_secs() / 60, line),
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
        write_task_state(&inf.task_id, &json!({ "task_id": inf.task_id, "status": "result_captured", "generation": inf.execution.generation, "attempt_id": inf.execution.attempt_id, "exit_code": outcome.exit_code, "stdout_tail": outcome.stdout_tail, "stderr_tail": outcome.stderr_tail, "worktree": inf.worktree }));
        // Capture actual stopped-writer proof durably BEFORE any publication
        // or hub call. A failed finalization used to discard this proof forever
        // and charge a stopped process against capacity after every outage.
        inf.execution.stop_maintenance();
        let stopped = inf.execution.control.quiesced.load(Ordering::SeqCst);
        let receipt = persist_stopped_receipt(cfg, &inf.task_id, &inf.execution, stopped);
        if let Err(error) = &receipt { dlog(&inf.task_id, &format!("stopped-writer receipt not recorded: {error}; capacity retained")); }
        // Transfer/cleanup still needs a real portable checkpoint. Capacity
        // reconciliation alone never deletes WIP or resolves unknown effects.
        let published = inf.worktree.as_deref().map(|p| inf.execution.checkpoint(cfg, &inf.task_id, p)).unwrap_or(Ok(()));
        if let Err(e) = &published { dlog(&inf.task_id, &format!("final checkpoint failed: {e}; worktree retained")); }
        let quiesced = match receipt {
            Ok((path, receipt)) => stopped_outbox::deliver(&path, &receipt, now_ms(), |r| send_stopped_receipt(cfg, r))
                .map_err(|error| dlog(&inf.task_id, &format!("stopped-writer delivery deferred to durable outbox: {error}"))).is_ok(),
            Err(_) => false,
        };
        if inf.execution.control.stop.load(Ordering::SeqCst) {
            // Deliberate interruption is not a failed implementation/review.
            // Resume only after the durable checkpoint/quiescence barrier.
            if quiesced && published.is_ok() {
                if let Ok(state) = execution_call(cfg, &inf.task_id, json!({ "kind": "inspect" })) {
                    for m in state["messages"].as_array().into_iter().flatten().filter(|m| m["state"] == "delivered") {
                        let mut cmd = inf.execution.command("ack"); cmd["message_id"] = m["id"].clone(); cmd["state"] = json!("acknowledged");
                        let _ = execution_call(cfg, &inf.task_id, cmd);
                    }
                    let _ = execution_call(cfg, &inf.task_id, inf.execution.command("yield"));
                }
                note_task(cfg, &inf.task_id, "runner: writer stopped; checkpoint published and process group quiescent. Coordination/budget interrupt will resume from verified content, not a stdout-based restart.");
            }
            attempts.insert(inf.task_id.clone(), Instant::now());
            continue;
        }
        if !quiesced || published.is_err() {
            note_task(cfg, &inf.task_id, "runner: result captured but portable checkpoint/process quiescence barrier is incomplete. Local work retained; automatic transfer and cleanup held.");
            attempts.insert(inf.task_id.clone(), Instant::now());
            continue;
        }
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
        dlog(
            &inf.task_id,
            &format!(
                "{} in ~{}m — agent reply: {}",
                if outcome.timed_out {
                    "TIMED OUT"
                } else if !outcome_ok {
                    "FAILED"
                } else {
                    "finished"
                },
                mins,
                reply_excerpt
            ),
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
            dlog(
                &inf.task_id,
                "lost a claim race (gate rejections, no work) — not a dispatch failure",
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
                format!("{note}\nverified against: task artefact + history receipts (exit 0, session {})", claim_session(cfg, &inf.task_id))
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
                    format!("runner: dispatch VOID — no valid completion, 3 attempts — released for execution repair; cause: {}", truncate(&tail, 300))
                } else {
                    "runner: opencode failed 3 attempts (last: timed out or exited non-zero) — released for attention".to_string()
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
                    dlog(&inf.task_id, &format!("error: relay failed: {e}"));
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
            dlog(&inf.task_id, &format!("error: relay failed: {e}"));
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
    if !avail_ok || stop.load(Ordering::SeqCst) || update_request().is_some() {
        return Ok(msgs);
    }
    let Some((worker_credential, readiness_observed)) = prepared_worker.as_mut() else { return Ok(msgs); };

    // 3c. circuit breaker: agent CLI is failing deterministically — stop
    // claiming. Persist a bounded cooldown at the hub so operators see the
    // cause and recovery does not require a process restart.
    if breaker.tripped() {
        let reason = format!("{} consecutive dispatch failures ({})", breaker.consecutive_failures, breaker.last_signature);
        execution_call(cfg, "gateway", json!({ "kind": "gateway_failure", "reason": reason, "cooldown_ms": 300_000 }))?;
        msgs.push(format!("CIRCUIT BREAKER — {reason}; hub cooldown for 5m, then readiness is re-proved"));
        *breaker = CircuitBreaker::default();
        return Ok(msgs);
    }

    // 4. orient — once per tick when we have capacity
    dispatch_stage(snap, DispatchStage::Admission);
    let orient = mcp_call(cfg, id, "orient", json!({}))?;
    // BR#2844: silent zeros die here. A drifted orient shape (the renamed-key
    // incident that emptied the work lists) is now a loud tick error naming
    // the drift, not an empty candidate list that looks like a quiet board.
    orient_contract_error(&orient)?;
    // BR#4113: orient got through — the hub accepted this device's token.
    // Clear any sustained-auth-failure park; run_loop re-arms its heal
    // pacing from this flag on the Ok arm.
    snap_needs_attention_clear(snap);
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
        if let Some(session) = art.pointer("/meta/session").and_then(|v| v.as_str()) { remember_claim_session(cfg, tid, session); }
        let body_md = art.get("body_md").and_then(|b| b.as_str()).map(String::from).unwrap_or_default();
        let mut task_meta = art.get("meta").cloned().unwrap_or(json!({}));
        task_meta["execution_project"] = art["project"].clone();
        if !avail.iter().any(|b| backend_satisfies(cfg, *b, &task_meta)) {
            if gated_announced.insert(format!("{tid}:reasoning")) { dlog(tid, "SKIP: persistent minimum reasoning tier unavailable on this host"); }
            continue;
        }
        let meta_obj = task_meta.as_object();
        let sess = find_session(&sessions, tid);
        if execution_call(cfg, tid, json!({ "kind": "inspect" })).map(|state| quiesced_claim_can_resume(&state, &art, cfg.label.as_deref())).unwrap_or(false) {
            let role_work = art["roles"].as_array().map(|roles| roles.iter().any(|role| matches!(role.as_str(), Some("analysis" | "review" | "unblock")))).unwrap_or(false);
            // Authoritative quiescence beats an old conversation's recent
            // timestamp. Keep the claim/session; begin restores/fences anew.
            spawn_opencode(cfg, snap, tid, title, &body_md, &task_meta, &policy, sess.map(|s| s.id.clone()), role_work, "task", avail, in_flight, worker_credential, readiness_observed);
            attempts.insert(tid.to_string(), Instant::now());
            continue;
        }
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
                    dlog(
                        tid,
                        &format!(
                            "stale-claim check — card now {status}/{owner} (not in_progress/not mine) — skipping release + re-claim (BR#3823)",
                            status = art.get("status").and_then(|v| v.as_str()).unwrap_or("?"),
                            owner = art.get("owner").and_then(|v| v.as_str()).unwrap_or("?"),
                        ),
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
                        dlog(tid, "stale release raced (gate refused) — card not released, skipping re-claim (BR#3823)");
                        snap_activity(
                            snap,
                            "info",
                            &format!("{tid} stale release raced — skipped (BR#3823)"),
                        );
                        continue;
                    }
                    ReleaseOutcome::Failed(e) => {
                        dlog(tid, &format!("error: stale release failed: {e}"));
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
                        dlog(tid, "stale claim released, re-claim raced — skipping");
                        snap_activity(
                            snap,
                            "info",
                            &format!("{tid} re-claim raced after stale release — skipped"),
                        );
                        continue;
                    }
                    Err(e) => {
                        dlog(tid, &format!("error: re-claim failed: {e}"));
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
                spawn_opencode(cfg, snap, tid, title, &body_md, &task_meta, &policy, None, role_work, &role_type, avail, in_flight, worker_credential, readiness_observed);
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

    // New work is selected AND reserved by the hub. Local history is not a
    // second scheduling authority: a human release re-enters this path even
    // when this process previously gave up or cached a refused reference.
    // Full runners still ask the hub to arrange safe recovery capacity. This
    // mode cannot reserve more work if local and hub counts temporarily differ.
    if in_flight.len() >= cfg.max_sessions && !stop.load(Ordering::Relaxed) && update_request().is_none() {
        let scheduling = execution_call(cfg, "gateway", json!({ "kind": "schedule", "mode": "request_capacity" }))?;
        let outcome = serde_json::from_value::<SchedulingOutcome>(scheduling)
            .map_err(|error| format!("hub scheduling contract drift: {error}"))?;
        dlog("", &format!("hub capacity request: {outcome:?}"));
    }
    let mut reserved_this_tick = HashSet::new();
    while in_flight.len() < cfg.max_sessions && !stop.load(Ordering::Relaxed) && update_request().is_none() {
        let scheduling = execution_call(cfg, "gateway", json!({ "kind": "schedule", "mode": "reserve" }))?;
        let reservation = match serde_json::from_value::<SchedulingOutcome>(scheduling) {
            Ok(SchedulingOutcome::Reserved { task_id, session, .. }) => (task_id, session),
            Ok(other) => {
                let message = format!("hub scheduling: {other:?}");
                dlog("", &message);
                snap_activity(snap, "schedule", &message);
                break;
            }
            Err(error) => return Err(format!("hub scheduling contract drift: {error}")),
        };
        let (tid, session) = (&reservation.0, &reservation.1);
        if !reserved_this_tick.insert(tid.clone()) {
            return Err(format!("{tid}: repeated startup reservation in one refill; stop rather than churn"));
        }
        remember_claim_session(cfg, tid, session);
        let art = mcp_call(cfg, id, "get_artefact", json!({ "id": tid }))?;
        if art["status"].as_str() != Some("in_progress") || art.pointer("/meta/session").and_then(|v| v.as_str()) != Some(session.as_str()) {
            return Err(format!("{tid}: reservation changed before launch; preserving current holder"));
        }
        if in_flight.iter().any(|inf| inf.task_id == *tid) {
            return Err(format!("{tid}: hub reserved a task with a local writer; refusing duplicate launch"));
        }
        gave_up.remove(tid);
        finished_no_pr.remove(tid);
        let title = art["title"].as_str().ok_or("reserved task is missing title")?;
        let body_md = art["body_md"].as_str().unwrap_or("");
        let mut task_meta = art["meta"].clone();
        task_meta["execution_project"] = art["project"].clone();
        let resume_sess = None; // a new reservation is a fresh executor session; WIP remains in the registered worktree
        let _ = mcp_call_task(
            cfg,
            id,
            "log_progress",
            json!({ "id": tid, "note": "runner: claimed — preparing verified worker launch", "sentiment": "going_well" }),
            &tid,
        );
        let msg = match &resume_sess {
            Some(s) => format!("claimed {tid} — resuming opencode session {s}"),
            None => format!("claimed {tid} — worker launch requested"),
        };
        let (role_work, role_type) = art.get("roles").and_then(|v| v.as_array()).map(|a| {
            let rt = a.iter().filter_map(|x| x.as_str()).find(|s| matches!(*s, "review" | "analysis" | "unblock")).map(str::to_string);
            (rt.is_some(), rt.unwrap_or_else(|| "task".into()))
        }).unwrap_or((false, "task".to_string()));
        let before_launch = in_flight.len();
        spawn_opencode(cfg, snap, tid, title, body_md, &task_meta, &policy, resume_sess, role_work, &role_type, avail, in_flight, worker_credential, readiness_observed);
        attempts.insert(tid.to_string(), Instant::now());
        if in_flight.len() > before_launch {
            snap_activity(snap, "dispatch", &msg);
            msgs.push(msg);
        } else {
            snap_activity(snap, "error", &format!("{tid}: startup did not launch a worker; claim reconciliation recorded"));
            // A task-specific pre-spawn interruption must not leave every
            // other slot idle for another poll interval. Continue only after
            // authoritative no-writer proof; schedule rechecks gateway readiness
            // and capacity for EVERY next reservation. Unknown effects stay held.
            match execution_call(cfg, tid, json!({ "kind": "inspect" })) {
                Ok(state) if failed_launch_has_no_writer(&state) && reserved_this_tick.len() < cfg.max_sessions + 8 => {
                    dlog(tid, "no writer after startup reconciliation; continuing capacity refill");
                }
                _ => break,
            }
        }
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
                        dlog("", &format!("error: config save failed: {e}"));
                    }
                    c
                }
                Err(e) => {
                    if let Ok(mut g) = last_error.lock() {
                        *g = Some(e.clone());
                    }
                    dlog("", &format!("error: pairing failed: {e}"));
                    running.store(false, Ordering::Relaxed);
                    return;
                }
            },
            Err(_) => {
                let msg = "no config and no BRIDGE_URL — set BRIDGE_URL (or ~/.bridge/config.json) to pair".to_string();
                dlog("", &msg);
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
        dlog("", &msg);
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
    // BR#4104 — gateway-native merge train: this daemon IS an opportunistic
    // train executor now (BR#3516 edge-executor law, Ray-directed 2026-10-28).
    // The leg runs on its own thread at MERGE_TRAIN_INTERVAL_SECS (45s
    // default), contends the per-lane CAS lease exactly like `bridge train`,
    // and enforces the identity law itself: write legs only under the
    // worker-class gh credential — a personally-authed gateway reconciles and
    // reports, then stands down LOUDLY from merge legs (BR#3181). Lease
    // renewals carry proof-of-progress; MERGE_TRAIN_ENABLED=0 disables
    // (deploy.md §7).
    let mut train_stop = Arc::new(AtomicBool::new(update_request().is_some()));
    let mut train_handle = if update_request().is_none() {
        crate::train::spawn_daemon_leg(&cfg.url, &cfg.token, cfg.label.as_deref(), train_stop.clone())
    } else { None };
    // BR#4489 `role: "train"`: a dedicated merge-train node is a normal
    // gateway in a named mode — the daemon legs (train thread above, WS
    // connection/transport, epoch self-heal, liveness) keep running; the
    // DISPATCH loop below skips task claiming entirely. Nothing to dispatch,
    // nothing claimed. Default (role absent) is unchanged.
    let dispatch_enabled = cfg.role.as_deref() != Some("train");
    if !dispatch_enabled {
        // BR#4400/BR#4412: operator log line — rides the single emit() door,
        // process-global scope (BR#4733 verify finding: raw tagged eprintln
        // here survived the original conversion pass).
        dlog(
            "",
            "role: train — dedicated merge-train node: task dispatch OFF, train + connection legs ON",
        );
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
    dlog(
        &cfg.url,
        &format!(
            "loop started — poll every {}s, workdir {}, up to {} concurrent sessions",
            cfg.poll_secs, cfg.workdir, cfg.max_sessions
        ),
    );
    if let Ok(mut s) = snap.lock() {
        s.running = true;
        s.url = Some(cfg.url.clone());
        s.workspace = cfg.ws.clone();
        s.label = cfg.label.clone();
        s.agent = cfg.agent.clone();
        s.workdir = Some(cfg.workdir.clone());
        s.max_sessions = cfg.max_sessions;
        s.in_flight.clear();
    }
    dispatch_stage(&snap, DispatchStage::Starting);
    // Self-healing law (BR#2840, BR#3787, BR#4113): a hub-rejected token gets
    // a repair LADDER — keychain reload (another process may have re-vended),
    // agent-plane principal repair (headless-safe), then desktop
    // self-provision (human plane). Bounded: exponential backoff 5s→300s,
    // then a LOUD needs-attention park — but the loop STAYS RUNNING while
    // desired state is "running": it keeps polling (each poll re-detects a
    // hub-side heal) and retries the ladder on the capped cadence, resuming
    // dispatch on its own the moment the hub accepts this device again.
    // Never a silent permanent stop, never a credential wipe, never a
    // wait-for-a-human halt. Every failure reason is logged; a successful
    // repair re-arms for the NEXT rotation. (The old "loud logout last" tail
    // and its did_logout footer died with BR#4113: the loop no longer
    // self-logs-out — the identity-law gate returns before this footer, and
    // auth failures park instead of exiting.)
    let mut heal = AuthHeal::new();
    let mut cfg = cfg;
    let readiness = dispatch_enabled.then(|| {
        dispatch_stage(&snap, DispatchStage::Readiness);
        GatewayReadiness::start(&cfg)
    });
    // Separate from admission and per-writer leases: replay survives a stopped
    // worker, a blocked dispatch tick and daemon replacement. Use the readiness
    // producer's current credential/config; never keep a rotated token alive.
    let stopped_delivery = readiness.as_ref().map(|readiness| {
        let config = readiness.data.clone();
        let delivery = LeaseMaintenance::start(Duration::from_secs(20), move || {
            let cfg = config.lock().expect("gateway readiness poisoned").cfg.clone();
            if let (Some(root), Some(host)) = (stopped_outbox_root(), cfg.label.as_deref()) {
                for message in stopped_outbox::flush(&root, host, &cfg.url, now_ms(), |r| send_stopped_receipt(&cfg, r)) {
                    dlog("gateway", &message);
                }
            }
            true
        });
        delivery.wake();
        delivery
    });
    loop {
        if let Some(request) = update_request() {
            // Natural completion only: do not signal worker stop, discard
            // receivers, infer quiescence from a lease or kill a live writer.
            match update_train_barrier(in_flight.len(), &train_stop, &mut train_handle) {
                Ok(UpdateTrainBarrier::DrainingWorkers) => dlog("", "managed update: worker drain in progress; train stop deferred to final restart barrier"),
                Ok(UpdateTrainBarrier::Quiescent) => update_receipt("idle.json", &json!({"nonce":request["nonce"],"pid":std::process::id(),"phase":"idle"})),
                Err(reason) => { dlog("", reason); return; }
            }
        } else if train_stop.load(Ordering::SeqCst) {
            train_stop = Arc::new(AtomicBool::new(false));
            train_handle = crate::train::spawn_daemon_leg(&cfg.url, &cfg.token, cfg.label.as_deref(), train_stop.clone());
        }
        if stop.load(Ordering::Relaxed) {
            if in_flight.is_empty() { break; }
            // Stop is a bounded checkpoint/quiesce drain, not dropping the
            // result receivers while detached writer threads keep running.
            for inf in &in_flight { inf.execution.control.stop.store(true, Ordering::SeqCst); }
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
                        dlog("", &format!("token epoch {vend} → {seen}: re-vended by principal (proactive catch-up)"));
                        snap_activity(
                            &snap,
                            "dispatch",
                            "token rotated elsewhere — re-vended proactively (epoch catch-up)",
                        );
                        write_runner_state(&snap);
                    }
                    Err(pe) => {
                        // the reason is logged; the hub-side rate limiter is
                        // the backstop against tick-loop churn
                        dlog("", &format!("error: proactive epoch catch-up failed: {pe}"));
                        snap_activity(
                            &snap,
                            "error",
                            &format!("proactive epoch catch-up failed: {pe}"),
                        );
                    }
                }
                TOKEN_EPOCH_SEEN.store(0, Ordering::Relaxed); // re-adopt from the next response
            } else if vend == 0 && seen > 0 {
                TOKEN_EPOCH_VEND.store(seen, Ordering::Relaxed); // first observation adopts
            }
        }
        // BR#4489 role:"train" — skip ONLY the dispatch tick; the tail of the
        // loop (runner-state sync + responsive stop) still runs every pass.
        if dispatch_enabled {
            let readiness = readiness.as_ref().expect("dispatch has a readiness producer");
            readiness.update_config(&cfg);
            match tick(
                &cfg,
                readiness,
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
                &stop,
            ) {
            Ok(msgs) => {
                if update_request().is_some() && !avail.is_empty() && readiness.proof(&cfg).is_ok() && snap.lock().map(|s| s.needs_attention.is_none()).unwrap_or(false) {
                    update_receipt("health.json", &json!({"pid":std::process::id(),"commit":option_env!("BRIDGE_BUILD_COMMIT").unwrap_or("unknown"),"observed_at":now_ms(),"phase":"ready"}));
                }
                for msg in msgs {
                    dlog("", &msg);
                }
                // BR#4113: tick clears the needs-attention flag when its
                // orient gets through — the hub accepted our token again
                // (rotation grace, rollback, row restore). Re-arm the heal
                // pacing to match; the next tick dispatches normally.
                let hub_accepted = snap
                    .lock()
                    .ok()
                    .map(|s| s.needs_attention.is_none())
                    .unwrap_or(false);
                if hub_accepted {
                    heal.on_hub_accepted();
                }
            }
            Err(e) => {
                // BR#4113 — classify first. Auth failures (401/403: revoked,
                // expired, rotated away) run the bounded self-heal ladder and
                // NEVER stop the loop while desired state is "running".
                // Everything else is transient (the hub may just be
                // deploying): log, snapshot, keep polling.
                match classify_hub_error(&e) {
                    HubErrClass::Transient => {
                        dlog("", &format!("error: {e}"));
                        snap_activity(&snap, "error", &e);
                        if let Ok(mut g) = last_error.lock() {
                            *g = Some(e);
                        }
                    }
                    HubErrClass::Auth => match heal.on_auth_failure(Instant::now()) {
                        HealStep::Wait => {
                            // backoff cadence — keep polling quietly; the
                            // poll itself is the hub-side-heal detector
                        }
                        HealStep::Attempt => match auth_repair_ladder(&cfg) {
                            Ok(fresh) => {
                                cfg = fresh;
                                let was_parked = heal.parked;
                                heal.on_repair_success();
                                snap_needs_attention_clear(&snap);
                                let msg = if was_parked {
                                    "gateway self-healed — credential re-vended after sustained hub auth rejection; parked state cleared, dispatch resumes now".to_string()
                                } else {
                                    "gateway self-healed — credential re-vended after hub auth rejection; dispatch resumes now".to_string()
                                };
                                dlog("", &msg);
                                snap_activity(&snap, "dispatch", &msg);
                                if let Ok(mut g) = last_error.lock() {
                                    *g = None;
                                }
                                write_runner_state(&snap);
                                continue; // immediate re-tick with the fresh credential
                            }
                            Err(failures) => {
                                for f in &failures {
                                    dlog("", &format!("self-heal ladder: {f}"));
                                    snap_activity(
                                        &snap,
                                        "error",
                                        &format!("self-heal ladder: {f}"),
                                    );
                                }
                                // park EXACTLY once per episode — on the run
                                // that crosses the threshold
                                if heal.parked && heal.streak == AUTH_PARK_ATTEMPTS {
                                    let msg = format!(
                                        "needs attention — the hub has rejected this device's credential through {} self-heal attempts (last: {}). The gateway STAYS connected (desired state \"running\") and keeps retrying every {}s: it resumes dispatch on its own the moment the hub accepts this device again — rotation grace, rollback, or row restore; zero human action. To fix by hand now: sign in (re-vends this device's token) or re-pair. Nothing was lost: hub URL and settings are kept.",
                                        heal.streak,
                                        failures.last().map(|s| s.as_str()).unwrap_or("unknown"),
                                        AUTH_BACKOFF_CAP_SECS
                                    );
                                    dlog("", &format!("parked: {msg}"));
                                    snap_needs_attention(&snap, &msg);
                                    if let Ok(mut g) = last_error.lock() {
                                        *g = Some(msg);
                                    }
                                    write_runner_state(&snap);
                                }
                            }
                        },
                    },
                }
            }
            }
        }
        // Admission and completion handling always precede optional hygiene.
        // Never restart a backlog of status reads before filling free slots.
        if dispatch_enabled && !stop.load(Ordering::Relaxed) && update_request().is_none()
            && SWEEP_COUNTER.fetch_add(1, Ordering::Relaxed) % 10 == 0 {
            dispatch_stage(&snap, DispatchStage::Hygiene);
            let mut messages = Vec::new();
            sweep_stale_worktrees(&cfg, &mut id, &in_flight, &mut messages);
            for message in messages { dlog("", &message); }
        }
        // ephemeral flat-file state: keep ~/.bridge/dispatch/runner.json in sync
        write_runner_state(&snap);
        if update_request().is_some() { std::thread::sleep(Duration::from_secs(2)); }
        dispatch_stage(&snap, DispatchStage::Waiting);
        // A returned/disconnected worker is new capacity: do not spend the
        // whole fallback poll interval leaving its result and slot undrained.
        wait_for_dispatch_wake(Duration::from_secs(cfg.poll_secs), ||
            stop.load(Ordering::Relaxed) || update_request().is_some()
                || in_flight.iter().any(|inf| inf.completed.load(Ordering::SeqCst)));
    }
    if let Some(delivery) = stopped_delivery { delivery.stop(); }
    running.store(false, Ordering::Relaxed);
    train_stop.store(true, Ordering::SeqCst);
    if let Some(handle) = train_handle { let _ = handle.join(); }
    if let Ok(mut s) = snap.lock() {
        s.running = false;
        s.in_flight = Vec::new();
        // BR#4113: a stop-signal exit is NOT a logout — if a needs-attention
        // park was up, it survives the stop so the UI still says why the
        // gateway is not dispatching.
    }
    write_runner_state(&snap);
    dlog("", "loop stopped");
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
            dlog(
                vendored.ws.as_deref().unwrap_or("?"),
                "self-provisioned gateway token at start",
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
            dlog("", &format!("error: config save failed: {e}"));
        }
    }
    state.stop.store(false, Ordering::Relaxed);
    // fresh run: any prior auto-logout notice is stale — either the pairing
    // was fixed (re-pair) or the user restarted deliberately (BR#2532). If
    // the pairing is still unqualified, run_loop re-records it immediately.
    snap_logout_clear(&state.snapshot);
    // BR#4113: same for a stale needs-attention park — a deliberate start is
    // a fresh episode; if the hub still rejects the token, run_loop re-parks
    // on its own cadence.
    snap_needs_attention_clear(&state.snapshot);
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
    if !clear_credential {
        write_runner_state(snap);
        dlog("", "human session ended; gateway and its writer leases keep running");
        return;
    }
    stop.store(true, Ordering::Relaxed);
    running.store(false, Ordering::Relaxed);
    if clear_credential {
        if let Err(e) = crate::store::TokenStore::open().clear_token() {
            dlog("", &format!("warning: credential clear failed: {e}"));
        }
        // vendored per-agent credentials — re-provisioned after the next login.
        // BR#6682: clear the CANONICAL cache — the fixed path provision_agent_token
        // writes. The dispatch-dir resolution honors BRIDGE_DISPATCH_DIR, which
        // would delete an isolated rollout runner's report-dir copy while the
        // real shared cache survives the credential clear.
        if let Some(cache_path) = agent_token_cache_path() {
            let _ = std::fs::remove_file(&cache_path);
        }
    }
    if let Ok(mut s) = snap.lock() {
        s.running = false;
        s.in_flight = Vec::new();
    }
    // BR#2532: persist the post-logout state (incl. an auto-logout notice, if
    // this was one) so an observing desktop UI sees it in the flat file
    write_runner_state(snap);
    dlog(
        "",
        &format!(
            "logged out — {}",
            if clear_credential {
                "credential cleared; sign in to re-provision"
            } else {
                "session ended; the gateway keeps running (token stays in the keychain)"
            }
        ),
    );
}

/// Log out (Settings): end the human session — the runner continues and the
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
    #[test]
    fn failed_launch_refill_requires_conclusive_no_writer_not_expiry_or_transport_failure() {
        assert!(super::failed_launch_has_no_writer(&serde_json::json!({"attempt":null})));
        assert!(super::failed_launch_has_no_writer(&serde_json::json!({"attempt":{"phase":"quiesced"}})));
        for phase in ["running", "restoring", "stopping"] {
            assert!(!super::failed_launch_has_no_writer(&serde_json::json!({"attempt":{"phase":phase,"lease_until":0}})));
        }
        assert!(!super::failed_launch_has_no_writer(&serde_json::json!({"error":"503"})));
    }
    use super::*;
    #[test]
    fn update_drain_keeps_train_ticks_live_until_workers_finish_then_joins_before_idle() {
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let (sent, received) = std::sync::mpsc::channel();
        let mut handle = Some(std::thread::spawn(move || {
            while !thread_stop.load(Ordering::SeqCst) {
                sent.send("tick").unwrap();
                std::thread::sleep(Duration::from_millis(5));
            }
            sent.send("train_stopped").unwrap();
        }));
        assert_eq!(update_train_barrier(12, &stop, &mut handle), Ok(UpdateTrainBarrier::DrainingWorkers));
        assert!(!stop.load(Ordering::SeqCst));
        assert!(handle.is_some());
        for _ in 0..2 { assert_eq!(received.recv_timeout(Duration::from_secs(1)).unwrap(), "tick"); }
        assert_eq!(update_train_barrier(0, &stop, &mut handle), Ok(UpdateTrainBarrier::Quiescent));
        assert!(handle.is_none());
        assert_eq!(received.try_iter().last(), Some("train_stopped"), "idle is impossible before the live train has actually joined");
    }
    #[test]
    fn update_train_join_failure_never_confirms_idle() {
        let stop = AtomicBool::new(false);
        let mut handle = Some(std::thread::spawn(|| panic!("train failed during finalization")));
        assert!(update_train_barrier(0, &stop, &mut handle).is_err());
        assert!(stop.load(Ordering::SeqCst));
    }

    #[test]
    fn readiness_probe_kills_its_own_hung_process_group_within_budget() {
        let mut command = Command::new("sh"); command.args(["-c", "sleep 10 & wait"]);
        let started = Instant::now();
        assert!(probe_command(command, Duration::from_millis(100)).unwrap_err().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(2));
        let mut quick = Command::new("sh"); quick.args(["-c", "exit 0"]);
        assert!(probe_command(quick, Duration::from_secs(1)).is_ok());
    }

    #[test]
    fn worker_completion_wakes_refill_without_consuming_its_result() {
        let completed = Arc::new(AtomicBool::new(false));
        let signal = CompletionSignal(completed.clone());
        let (send, receive) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _signal = signal;
            std::thread::sleep(Duration::from_millis(20));
            send.send("real completed result").unwrap();
        });
        let started = Instant::now();
        wait_for_dispatch_wake(Duration::from_secs(5), || completed.load(Ordering::SeqCst));
        assert!(started.elapsed() < Duration::from_secs(2), "refill waited for the fallback poll");
        assert_eq!(receive.try_recv().unwrap(), "real completed result");
        worker.join().unwrap();
        let started = Instant::now();
        wait_for_dispatch_wake(Duration::from_millis(50), || false);
        assert!(started.elapsed() >= Duration::from_millis(50), "idle gateways must not busy-poll");
    }

    #[test]
    fn filling_slots_reuses_fresh_inventory_but_refresh_failure_never_begins() {
        let mut observed = Instant::now();
        for _ in 0..12 {
            assert_eq!(begin_with_fresh_readiness(&mut observed, false,
                || panic!("fresh batch should not advertise once per slot"), || Ok("begun")).unwrap(), "begun");
        }
        observed = Instant::now() - Duration::from_secs(61);
        let refreshed = std::cell::Cell::new(false);
        begin_with_fresh_readiness(&mut observed, false,
            || { refreshed.set(true); Ok(()) }, || { assert!(refreshed.get()); Ok(()) }).unwrap();
        assert!(observed.elapsed() < Duration::from_secs(1));
        let error = begin_with_fresh_readiness(&mut observed, true,
            || Err("readiness unavailable".into()), || -> Result<(), String> { panic!("failed refresh must not launch a writer") }).unwrap_err();
        assert_eq!(error, "readiness unavailable");
        assert_eq!(begin_with_fresh_readiness(&mut observed, false, || Ok(()),
            || -> Result<(), String> { Err("hub selection/scope gate refused".into()) }).unwrap_err(), "hub selection/scope gate refused");
    }

    #[test]
    fn worker_panic_also_wakes_disconnected_result_handling() {
        let completed = Arc::new(AtomicBool::new(false));
        let signal = CompletionSignal(completed.clone());
        let worker = std::thread::spawn(move || { let _signal = signal; panic!("fixture worker panic"); });
        let started = Instant::now();
        wait_for_dispatch_wake(Duration::from_secs(5), || completed.load(Ordering::SeqCst));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(worker.join().is_err());
    }

    fn retained_sweep_candidates(n: usize) -> Vec<WorktreeCandidate> {
        (0..n).map(|i| WorktreeCandidate {
            slug: format!("BR-{i}"), path: PathBuf::from(format!("/fixture/BR-{i}")),
            mtime: std::time::SystemTime::now(),
        }).collect()
    }

    #[test]
    fn retained_sweep_backlog_is_bounded_and_fair_across_restarts() {
        let mut cursor = WorktreeSweepCursor::default();
        let mut seen = Vec::new();
        for _ in 0..3 {
            let (inspected, swept) = sweep_candidate_batch(retained_sweep_candidates(11), &mut cursor,
                Duration::from_secs(1), |candidate, _| { seen.push(candidate.slug.clone()); Some("in_progress".into()) },
                |_, _, _| panic!("retained work must not be removed"));
            assert!(inspected <= WORKTREE_SWEEP_CAP);
            assert_eq!(swept, 0);
            cursor = serde_json::from_slice(&serde_json::to_vec(&cursor).unwrap()).unwrap();
        }
        assert_eq!(seen.len(), 11);
        seen.sort(); seen.dedup();
        assert_eq!(seen.len(), 11, "restarts must not keep probing just the oldest retained trees");
    }

    #[test]
    fn slow_sweep_reads_exhaust_the_probe_budget_without_losing_the_cursor() {
        let mut cursor = WorktreeSweepCursor::default();
        let (inspected, swept) = sweep_candidate_batch(retained_sweep_candidates(20), &mut cursor,
            Duration::from_millis(20), |_, limit| { std::thread::sleep(limit); None },
            |_, _, _| panic!("a failed status probe cannot delete fresh work"));
        assert_eq!((inspected, swept), (1, 0));
        assert_eq!(cursor.remaining.len(), 19);
    }

    #[test]
    fn hygiene_status_probe_has_a_real_short_http_deadline() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (done, wait) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || { let (_socket, _) = listener.accept().unwrap(); let _ = wait.recv_timeout(Duration::from_secs(3)); });
        let cfg: DispatchConfig = serde_json::from_value(json!({ "url":url, "label":"hygiene-test", "token":"fixture-only" })).unwrap();
        let started = Instant::now();
        let error = mcp_call_session_with_timeout(&cfg, &mut 0, "get_artefact", json!({"id":"BR#1"}), None, Duration::from_millis(100)).unwrap_err();
        let _ = done.send(()); server.join().unwrap();
        assert!(error.contains("timed out"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn resume_retry_keeps_the_original_command_id_and_does_not_repeat_a_new_effect() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut ids = Vec::new();
            for attempt in 0..2 {
                let (mut socket, _) = listener.accept().unwrap(); socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut request = Vec::new(); let mut buffer = [0u8; 1024];
                let (offset, length) = loop {
                    let n = socket.read(&mut buffer).unwrap(); assert!(n > 0); request.extend_from_slice(&buffer[..n]);
                    if let Some(offset) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..offset]);
                        let length = headers.lines().find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").and_then(|v| v.trim().parse::<usize>().ok())).unwrap();
                        if request.len() >= offset + 4 + length { break (offset + 4, length); }
                    }
                };
                let body: serde_json::Value = serde_json::from_slice(&request[offset..offset + length]).unwrap();
                ids.push(body["params"]["arguments"]["command_id"].as_str().unwrap().to_string());
                let response = if attempt == 0 { "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string() }
                    else {
                        let body = json!({"jsonrpc":"2.0","id":body["id"],"result":{"content":[{"type":"text","text":"{\"kind\":\"claims_resumed\"}"}]}}).to_string();
                        format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
                    };
                socket.write_all(response.as_bytes()).unwrap();
            }
            ids
        });
        let cfg: DispatchConfig = serde_json::from_value(json!({ "url":url, "label":"control-test", "token":"fixture-only" })).unwrap();
        assert_eq!(execution_claims(&cfg, false).unwrap()["kind"], "claims_resumed");
        let ids = server.join().unwrap(); assert!(!ids[0].is_empty()); assert_eq!(ids[0], ids[1]);
    }

    #[test]
    fn operator_rpc_has_a_short_real_timeout_instead_of_a_silent_thirty_second_wait() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (done, wait) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || { let (_socket, _) = listener.accept().unwrap(); let _ = wait.recv_timeout(Duration::from_secs(12)); });
        let cfg: DispatchConfig = serde_json::from_value(json!({ "url":url, "label":"timeout-test", "token":"fixture-only" })).unwrap();
        let started = Instant::now(); let mut id = 0;
        let error = mcp_call_session(&cfg, &mut id, "execution", json!({"id":"gateway","command_id":"same-receipt","command":{"kind":"resume_claims"}}), None).unwrap_err();
        let _ = done.send(()); server.join().unwrap();
        assert!(error.contains("timed out after 8s"), "{error}");
        assert!(error.contains("same-receipt"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(12));
    }
    #[test]
    fn managed_update_hold_cannot_advertise_usable_spare_models() {
        let supply = json!({"tier":"large","model":"large-model","availability":{"kind":"usable"},
            "alternatives":[{"tier":"small","model":"small-model","availability":{"kind":"usable"}},
                {"tier":"medium","model":"medium-model","availability":{"kind":"usable"}}]});
        let held = inventory_dispatch_hold(supply.clone(), true);
        assert_eq!(held["availability"]["kind"], "unavailable");
        assert!(held["availability"]["reason"].as_str().unwrap().contains("Managed update"));
        assert!(held["alternatives"].as_array().unwrap().iter().all(|m| m["availability"]["kind"] == "unavailable"));
        assert_eq!(held["model"], supply["model"]);
        assert_eq!(inventory_dispatch_hold(supply.clone(), false), supply, "fresh inventory resumes without changing model identity");
    }
    #[test]
    fn lease_maintenance_keeps_polling_while_dispatch_is_blocked_and_joins_before_finalization() {
        let (observed, polls) = std::sync::mpsc::channel();
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let polled = count.clone();
        let pump = LeaseMaintenance::start(Duration::from_millis(5), move || {
            polled.fetch_add(1, Ordering::SeqCst);
            observed.send(()).unwrap();
            true
        });
        // No tick calls: simulate a blocked worktree preparation/publication.
        for _ in 0..4 { polls.recv_timeout(Duration::from_secs(2)).unwrap(); }
        pump.stop();
        let at_barrier = count.load(Ordering::SeqCst);
        assert!(at_barrier >= 4);
        std::thread::sleep(Duration::from_millis(25));
        assert_eq!(count.load(Ordering::SeqCst), at_barrier, "no renewal after quiescence barrier");
        pump.stop(); // finalization and Drop can both cancel safely
    }

    fn readiness_fixture() -> DispatchConfig {
        serde_json::from_value(json!({"url":"http://fixture.invalid","label":"fixture-gateway","token":"fixture-only"})).unwrap()
    }

    fn wait_for_readiness_test(mut condition: impl FnMut() -> bool) {
        let until = Instant::now() + Duration::from_secs(2);
        while !condition() {
            assert!(Instant::now() < until, "readiness transition did not happen");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn gateway_readiness_stays_fresh_without_any_dispatch_ticks_and_stops_at_join() {
        let cfg = readiness_fixture();
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let probes = count.clone();
        let (observed, events) = std::sync::mpsc::channel();
        let readiness = GatewayReadiness::with_probe(&cfg, Duration::from_millis(10), move |_| {
            probes.fetch_add(1, Ordering::SeqCst);
            let _ = observed.send(());
            Ok(WorkerCredential { label:"fixture-gateway/worker".into(), secret:"fixture-only".into() })
        });
        // No tick/prepare/launch calls for several simulated capability TTLs.
        for _ in 0..35 { events.recv_timeout(Duration::from_secs(2)).unwrap(); }
        assert!(readiness.proof_with_max_age(&cfg, Duration::from_millis(100)).is_ok());
        readiness.maintenance.stop();
        let at_join = count.load(Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(count.load(Ordering::SeqCst), at_join, "dead gateway must not keep advertising");
        assert!(readiness.proof_with_max_age(&cfg, Duration::from_millis(100)).is_err());
    }

    #[test]
    fn gateway_readiness_failure_withdraws_local_admission_and_recovers_from_a_real_probe() {
        let cfg = readiness_fixture();
        let failing = Arc::new(AtomicBool::new(false));
        let fail = failing.clone();
        let readiness = GatewayReadiness::with_probe(&cfg, Duration::from_millis(10), move |_| {
            if fail.load(Ordering::SeqCst) { Err("backend unavailable".into()) }
            else { Ok(WorkerCredential {label:"fixture/worker".into(),secret:"fixture-only".into()}) }
        });
        assert!(readiness.proof(&cfg).is_ok());
        failing.store(true, Ordering::SeqCst);
        readiness.maintenance.wake();
        wait_for_readiness_test(|| readiness.proof(&cfg).is_err());
        assert!(readiness.proof(&cfg).err().unwrap().contains("backend unavailable"));
        failing.store(false, Ordering::SeqCst);
        readiness.maintenance.wake();
        wait_for_readiness_test(|| readiness.proof(&cfg).is_ok());
        readiness.maintenance.stop();
    }

    #[test]
    fn gateway_config_change_rejects_an_in_flight_obsolete_readiness_proof() {
        for credential_only in [false, true] {
        let cfg = readiness_fixture();
        let (entered, started) = std::sync::mpsc::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let (fresh_entered, fresh_started) = std::sync::mpsc::channel();
        let (fresh_release, fresh_wait) = std::sync::mpsc::channel();
        let mut round = 0;
        let readiness = GatewayReadiness::with_probe(&cfg, Duration::from_millis(5), move |cfg| {
            round += 1;
            if round == 2 { entered.send(()).unwrap(); wait.recv_timeout(Duration::from_secs(2)).unwrap(); }
            if round == 3 { fresh_entered.send(()).unwrap(); fresh_wait.recv_timeout(Duration::from_secs(2)).unwrap(); }
            Ok(WorkerCredential {label:cfg.label.clone().unwrap(),secret:cfg.token.clone()})
        });
        started.recv_timeout(Duration::from_secs(2)).unwrap();
        let mut changed = cfg.clone();
        if credential_only { changed.token = "rotated-fixture".into(); }
        else { changed.label = Some("renamed-gateway".into()); }
        readiness.update_config(&changed);
        assert!(readiness.proof(&changed).is_err());
        release.send(()).unwrap();
        fresh_started.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(readiness.proof(&changed).is_err(), "obsolete result won the config/credential race");
        fresh_release.send(()).unwrap();
        wait_for_readiness_test(|| readiness.proof(&changed).is_ok());
        let proof = readiness.proof(&changed).unwrap();
        assert_eq!(proof.worker.label, changed.label.clone().unwrap());
        assert_eq!(proof.worker.secret, changed.token);
        if !credential_only { assert!(readiness.proof(&cfg).is_err()); }
        readiness.maintenance.stop();
        }
    }

    #[test]
    fn stopping_gateway_readiness_joins_an_in_flight_publication() {
        let cfg = readiness_fixture();
        let (entered, started) = std::sync::mpsc::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let mut round = 0;
        let readiness = Arc::new(GatewayReadiness::with_probe(&cfg, Duration::from_millis(5), move |_| {
            round += 1;
            if round == 2 { entered.send(()).unwrap(); wait.recv_timeout(Duration::from_secs(2)).unwrap(); }
            Ok(WorkerCredential {label:"fixture/worker".into(),secret:"fixture-only".into()})
        }));
        started.recv_timeout(Duration::from_secs(2)).unwrap();
        let (joined, done) = std::sync::mpsc::channel();
        let stopping = readiness.clone();
        let stopper = std::thread::spawn(move || { stopping.maintenance.stop(); joined.send(()).unwrap(); });
        assert!(done.recv_timeout(Duration::from_millis(30)).is_err(), "stop must wait for the pending bounded publication");
        release.send(()).unwrap();
        done.recv_timeout(Duration::from_secs(2)).unwrap();
        stopper.join().unwrap();
    }

    #[test]
    fn lease_maintenance_terminal_poll_failure_is_not_retried() {
        let (observed, polls) = std::sync::mpsc::channel();
        let pump = LeaseMaintenance::start(Duration::from_millis(5), move || {
            observed.send(()).unwrap();
            false
        });
        polls.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(matches!(polls.recv_timeout(Duration::from_secs(2)), Err(std::sync::mpsc::RecvTimeoutError::Disconnected)));
        pump.stop();
    }

    #[test]
    fn lease_maintenance_stop_waits_for_in_flight_poll_before_quiescence() {
        let (entered, entering) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        let pump = LeaseMaintenance::start(Duration::from_millis(5), move || {
            entered.send(()).unwrap();
            released.recv().unwrap();
            true
        });
        entering.recv_timeout(Duration::from_secs(2)).unwrap();
        let (stopped, stopping) = std::sync::mpsc::channel();
        let join = std::thread::spawn(move || { pump.stop(); stopped.send(()).unwrap(); });
        assert!(matches!(stopping.recv_timeout(Duration::from_millis(25)), Err(std::sync::mpsc::RecvTimeoutError::Timeout)));
        release.send(()).unwrap();
        stopping.recv_timeout(Duration::from_secs(2)).unwrap();
        join.join().unwrap();
    }

    #[test]
    fn lease_renewal_requires_exact_active_attempt_and_no_pending_mailbox_delivery() {
        let base = json!({ "policy_version": 1, "attempt": { "generation": 7, "attempt_id": "attempt", "phase": "running" }, "messages": [] });
        let state = RemoteExecution::parse(base.clone()).unwrap();
        assert!(state.permits_renewal(7, "attempt"));
        assert!(!state.permits_renewal(8, "attempt"));
        assert!(!state.permits_renewal(7, "other"));
        let mut restoring = base.clone();
        restoring["attempt"]["phase"] = json!("restoring");
        restoring["attempt"]["checkpoint"] = json!({ "repo": "repo", "remote_ref": "refs/heads/checkpoint", "commit": "commit", "tree": "tree", "base": "base", "environment": [], "next": "restore", "tests": [] });
        assert!(RemoteExecution::parse(restoring).unwrap().permits_renewal(7, "attempt"));
        for phase in ["stopping", "quiesced"] {
            let mut value = base.clone(); value["attempt"]["phase"] = json!(phase);
            assert!(!RemoteExecution::parse(value).unwrap().permits_renewal(7, "attempt"));
        }
        let mut missing = base.clone(); missing["attempt"] = serde_json::Value::Null;
        assert!(!RemoteExecution::parse(missing).unwrap().permits_renewal(7, "attempt"));
        let mut delivered = base; delivered["messages"] = json!([{ "state": "delivered" }]);
        assert!(!RemoteExecution::parse(delivered).unwrap().permits_renewal(7, "attempt"));
    }

    #[test]
    fn quiescence_can_resume_only_the_same_hosts_unchanged_claim_without_a_local_handoff() {
        let task = json!({ "status": "in_progress", "meta": { "session": "dispatch-BR-1" } });
        let mut state = json!({ "attempt": { "phase": "running", "host": "host", "session": "dispatch-BR-1" }, "handoff": { "phase": "none" } });
        assert!(!quiesced_claim_can_resume(&state, &task, Some("host")));
        state["attempt"]["phase"] = json!("quiesced");
        assert!(quiesced_claim_can_resume(&state, &task, Some("host")));
        state["capacity_handoff"] = json!({"phase":"slot_available","recovery_id":"BR#2"});
        assert!(!quiesced_claim_can_resume(&state, &task, Some("host")), "a verifier cannot steal its yielded slot back before priority dispatch");
        state.as_object_mut().unwrap().remove("capacity_handoff");
        assert!(!quiesced_claim_can_resume(&state, &task, Some("other")));
        assert!(!quiesced_claim_can_resume(&state, &json!({ "status": "in_progress", "meta": { "session": "local-owner" } }), Some("host")));
        state["handoff"]["phase"] = json!("waiting");
        assert!(!quiesced_claim_can_resume(&state, &task, Some("host")));
    }

    #[test]
    fn multi_model_selection_respects_global_requirement_and_scope() {
        let cfg: DispatchConfig = serde_json::from_value(json!({ "url": "https://hub.test", "backends": { "opencode": {
            "projects": ["bridge"], "models": { "medium": "glm-5.3", "large": "provider/sol" }
        } } })).unwrap();
        let task = json!({ "execution_project": "bridge", "execution_scheduling_requirements": { "tier": "medium" } });
        assert_eq!(selected_model(&cfg, opencode::Backend::OpenCode, &task), Some((ReasoningTier::Medium, "glm-5.3".into())));
        let mut large = task.clone(); large["execution_scheduling_requirements"]["tier"] = json!("large");
        assert_eq!(selected_model(&cfg, opencode::Backend::OpenCode, &large), Some((ReasoningTier::Large, "provider/sol".into())));
        large["execution_project"] = json!("other");
        assert!(!backend_satisfies(&cfg, opencode::Backend::OpenCode, &large));
        let inventory = capability_inventory(&cfg, &[opencode::Backend::OpenCode], None, "opencode");
        assert_eq!(inventory["model"], "provider/sol");
        assert_eq!(inventory["alternatives"][0]["model"], "glm-5.3");
        assert_eq!(inventory["availability"]["kind"], "usable");
    }

    #[test]
    fn explicit_models_replace_legacy_pin_and_never_fall_back_below_minimum() {
        let cfg: DispatchConfig = serde_json::from_value(json!({ "url": "https://hub.test", "model": "legacy-large", "backends": { "opencode": {
            "reasoning_tier": "large", "models": { "medium": "glm-5.3" }
        } } })).unwrap();
        assert!(selected_model(&cfg, opencode::Backend::OpenCode, &json!({ "execution_requirements": { "tier": "large" } })).is_none());
        assert!(serde_json::from_value::<BackendConfig>(json!({"models": {"huge": "not-a-tier"}})).is_err());
    }

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
        // 2026-11-02: the runner's own trees root <workdir>/worktrees/<slug>
        std::fs::create_dir_all(workdir.join("worktrees").join("BR-4")).unwrap();
        let found = collect_worktree_candidates(&workdir, Some(&home), &active, &[]);
        let mut slugs: Vec<String> = found.iter().map(|c| c.slug.clone()).collect();
        slugs.sort();
        assert_eq!(slugs, vec!["BR-1", "BR-3", "BR-4", "hotfix-ext"], "active excluded from every root, the rest collected (incl. <workdir>/worktrees)");
        // the BR#3633 regression: a missing legacy root used to early-return
        // and discard the nested candidates — now it is a scoped skip
        let found = collect_worktree_candidates(&workdir, Some(&base.join("no-such-home")), &HashSet::new(), &[]);
        let mut slugs: Vec<String> = found.iter().map(|c| c.slug.clone()).collect();
        slugs.sort();
        assert_eq!(slugs, vec!["BR-1", "BR-2", "BR-4"], "nested candidates survive a missing legacy root");

        // 2026-11-02: REGISTERED enumeration — a real git repo root (the shared
        // checkout class) with worktrees registered at arbitrary paths via
        // `git worktree add` is enumerated by `git worktree list`, its own
        // main worktree skipped. The dir scans alone never saw these — this
        // is the 30+ GB checkout leak class.
        let checkout = base.join("checkout");
        std::fs::create_dir_all(&checkout).unwrap();
        let git = |args: &[&str], cwd: &std::path::Path| {
            std::process::Command::new("git").args(args).current_dir(cwd).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().unwrap().success()
        };
        assert!(git(&["init", "-q", "."], &checkout));
        git(&["config", "user.email", "t@t"], &checkout);
        git(&["config", "user.name", "t"], &checkout);
        git(&["commit", "--allow-empty", "-q", "-m", "init"], &checkout);
        let leaked = base.join("elsewhere").join("BR-9001");
        assert!(git(&["worktree", "add", "-q", leaked.to_str().unwrap()], &checkout), "register a worktree at an arbitrary path");
        let found = collect_worktree_candidates(&workdir, Some(&home), &HashSet::new(), &[checkout.to_string_lossy().to_string()]);
        let slugs: Vec<String> = found.iter().map(|c| c.slug.clone()).collect();
        assert!(slugs.contains(&"BR-9001".to_string()), "registered tree at an arbitrary path is enumerated via sweep_repos");
        assert!(!found.iter().any(|c| c.path == checkout), "the repo's own main worktree is never a candidate");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn worktree_registry_roundtrip_active_protected_dead_pruned() {
        // 2026-11-02: the registry is the mechanical record of every worktree
        // the system directed a session to create. Roundtrip: register →
        // enumerate (live) → protect (active slug) → prune (dead line) →
        // deregister (teardown).
        let base = std::env::temp_dir().join(format!("bridge-wtreg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home");
        let live = base.join("trees").join("BR-7001");
        std::fs::create_dir_all(&live).unwrap();
        let dead = base.join("trees").join("BR-7002");

        worktree_registry_append(Some(&home), &live, "state-vector/bridge", "BR-7001");
        worktree_registry_append(Some(&home), &dead, "state-vector/bridge", "BR-7002");
        assert_eq!(worktree_registry_load(&home).len(), 2);

        // enumeration: the live registered path is a candidate wherever it
        // lives; the dead line is not — and prunes on read
        let found = collect_worktree_candidates(&base.join("workdir"), Some(&home), &HashSet::new(), &[]);
        assert!(found.iter().any(|c| c.path == live), "registered live path enumerated");
        assert_eq!(worktree_registry_load(&home).len(), 1, "dead line pruned on read");

        // an in-flight slug is protected even though registered
        let mut active = HashSet::new();
        active.insert("BR-7001".to_string());
        let found = collect_worktree_candidates(&base.join("workdir"), Some(&home), &active, &[]);
        assert!(found.iter().all(|c| c.path != live), "active slug protected from the sweep");

        // teardown deregisters: the registry must not outlive the tree
        worktree_registry_remove(Some(&home), &live);
        assert!(worktree_registry_load(&home).is_empty());
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
    fn scheduling_requires_a_complete_reservation_and_preserves_hub_session_identity() {
        assert!(serde_json::from_value::<SchedulingOutcome>(json!({"kind":"reserved","task_id":"BR#1"})).is_err());
        assert!(serde_json::from_value::<SchedulingOutcome>(json!({"kind":"unknown"})).is_err());
        let result = serde_json::from_value::<SchedulingOutcome>(json!({"kind":"reserved","task_id":"BR#1","session":"dispatch-BR-1-fresh"})).unwrap();
        let SchedulingOutcome::Reserved { task_id, session } = result else { panic!("not reserved") };
        let mut cfg = default_config();
        cfg.label = Some("scheduling-test".into());
        remember_claim_session(&cfg, &task_id, &session);
        assert_eq!(claim_session(&cfg, &task_id), session);
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
            role: None,
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
            sweep_repos: vec![],
            auto_update: None,
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
        // BR#2532: the identity-law run gate must record a structured notice
        // the pair screen can render — naming the law and the one-click
        // re-pair path — instead of leaving the reason in stderr/last_error,
        // which the UI never reads.
        // BR#4113 supersedes the second former site (hub-401 logout): the
        // loop no longer signs the desktop out on a rejected token at all —
        // it parks with needs_attention. Exactly ONE auto-logout remains.
        let src = include_str!("dispatch.rs");
        // needles assembled from parts so this alarm cannot match itself
        let notice_call = format!("snap_{}(&snap", "logout");
        assert_eq!(
            src.matches(&notice_call).count(),
            1,
            "exactly one auto-logout site remains (the identity-law gate) — hub-401 parks instead of logging out (BR#4113)"
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
            >= 1;
        assert!(keeps_named, "the auto-logout reason must say what re-pairing keeps (hub URL + settings)");
    }

    #[test]
    fn hub_auth_failures_never_stop_the_loop_and_park_loudly() {
        // BR#4113: the loop's auth-failure path must NOT log out, must NOT
        // clear the credential, and must NOT break the loop while desired
        // state is "running" — it runs the bounded ladder and parks with a
        // loud needs-attention notice. This pins the exact defect from
        // tonight's token-rotation fallout (loop stopped → manual reconnect).
        let src = include_str!("dispatch.rs");
        let terminal = format!("the one-time repair {}d", "faile");
        assert!(
            !src.contains(&terminal),
            "the terminal 'one-time repair failed → logout + break' path must stay dead — auth failures park and keep polling (BR#4113)"
        );
        for needle in [
            "fn auth_repair_ladder",
            "fn classify_hub_error",
            "fn snap_needs_attention",
            "PARKED:",
            "HealStep::Attempt",
        ] {
            assert!(src.contains(needle), "BR#4113 machinery missing: {needle}");
        }
    }

    #[test]
    fn credential_clear_targets_the_canonical_token_cache_not_dispatch_dir() {
        // BR#6682 (BR#6663 audit F1): provision_agent_token caches the worker
        // credential at the FIXED path $HOME/.bridge/dispatch/agent-tokens.json
        // (562f394 — side-by-side runners share one credential). logout_core's
        // credential clear must hit that same file: resolving via
        // dispatch_dir() honors BRIDGE_DISPATCH_DIR, so a rollout runner would
        // delete only its isolated report-dir copy while the real shared cache
        // survives logout. One shared helper is the single resolution for both
        // sites — separate resolutions are exactly how this drifted.
        let src = include_str!("dispatch.rs");
        let helper = format!("agent_{}_{}_path()", "token", "cache");
        // one definition + exactly two callers (provision + credential clear)
        assert_eq!(
            src.matches(&helper).count(),
            3,
            "the canonical cache-path helper must be defined once and used by provision_agent_token AND logout_core"
        );
        let start = src
            .find(&format!("fn {}_core", "logout"))
            .expect("logout_core present");
        let body = &src[start..src[start..]
            .find("\n}\n")
            .map(|i| start + i)
            .unwrap_or(src.len())];
        assert!(
            !body.contains(&format!("{}_dir()", "dispatch")),
            "logout_core's credential clear must not resolve via dispatch_dir() — under BRIDGE_DISPATCH_DIR it deletes the isolated copy while the shared cache survives"
        );
        assert!(
            body.contains(&helper),
            "the credential clear must go through the canonical cache-path helper"
        );
    }

    #[test]
    fn classify_hub_error_sorts_auth_from_transient() {
        // BR#4113: 401/403 (revoked/expired/rotated/refused) are the
        // repairable auth class; unreachable hubs, 5xx, 429 and MCP-level
        // errors are transient — back off and keep polling.
        assert_eq!(classify_hub_error("bridge 401 Unauthorized on /mcp"), HubErrClass::Auth);
        assert_eq!(classify_hub_error("bridge 403 Forbidden on /mcp"), HubErrClass::Auth);
        assert_eq!(classify_hub_error("hub 401: token invalid"), HubErrClass::Auth);
        assert_eq!(classify_hub_error("hub 403: identity refused"), HubErrClass::Auth);
        assert_eq!(classify_hub_error("bridge unreachable: connection refused"), HubErrClass::Transient);
        assert_eq!(classify_hub_error("bridge 500 on /mcp"), HubErrClass::Transient);
        assert_eq!(classify_hub_error("bridge 429 on /mcp"), HubErrClass::Transient);
        assert_eq!(classify_hub_error("bridge 302 on /mcp"), HubErrClass::Transient);
        assert_eq!(classify_hub_error("mcp error -32000: board busy"), HubErrClass::Transient);
        // a task id that merely CONTAINS 401 must not classify as auth
        assert_eq!(classify_hub_error("task BR#4011 rejected"), HubErrClass::Transient);
        // BR#4754 — the train executor's JSON-RPC shape: mcp() wraps the hub's
        // error TEXT ("hub rpc error (tool): <message>"), and a rotted token
        // carries no HTTP status anywhere in the string. The Oct-29 incident:
        // 1,684 consecutive ticks of exactly the first line, acted on by
        // nothing because the old patterns never matched it.
        assert_eq!(classify_hub_error("hub rpc error (train_status): unknown auth token"), HubErrClass::Auth);
        assert_eq!(classify_hub_error("hub rpc error (train_lease): invalid auth token"), HubErrClass::Auth);
        // lease contention / hub-side refusals are NOT auth — the token is fine
        assert_eq!(
            classify_hub_error(
                "hub rpc error (train_lease): lane lease held live by merge-train@other until 2026-10-28T00:00:00Z — stand down this tick"
            ),
            HubErrClass::Transient
        );
    }

    #[test]
    fn auth_backoff_is_bounded_and_escalating() {
        // BR#4113: 5s doubling capped at 300s — bounded hammering, unbounded
        // patience.
        assert_eq!(auth_backoff_secs(1), 5);
        assert_eq!(auth_backoff_secs(2), 10);
        assert_eq!(auth_backoff_secs(3), 20);
        assert_eq!(auth_backoff_secs(4), 40);
        assert_eq!(auth_backoff_secs(7), AUTH_BACKOFF_CAP_SECS);
        assert_eq!(auth_backoff_secs(50), AUTH_BACKOFF_CAP_SECS);
        for n in 1..40 {
            assert!(auth_backoff_secs(n) <= AUTH_BACKOFF_CAP_SECS);
        }
    }

    #[test]
    fn auth_heal_paces_attempts_parks_once_and_rearms() {
        // BR#4113: the ladder attempts immediately, then on the backoff
        // cadence; after AUTH_PARK_ATTEMPTS failed runs it is parked (and
        // STAYS parked — no refire) while still retrying on the capped
        // cadence; success fully re-arms.
        let mut heal = AuthHeal::new();
        let t0 = Instant::now();
        assert!(matches!(heal.on_auth_failure(t0), HealStep::Attempt));
        assert!(!heal.parked);
        // too soon → Wait (the loop keeps polling)
        assert!(matches!(heal.on_auth_failure(t0 + Duration::from_secs(1)), HealStep::Wait));
        // after the backoff window → next attempt; keep failing to the threshold
        let mut t = t0;
        for i in 2..=AUTH_PARK_ATTEMPTS {
            t += Duration::from_secs(auth_backoff_secs(i as u32 - 1));
            assert!(matches!(heal.on_auth_failure(t), HealStep::Attempt), "run {i}");
        }
        assert_eq!(heal.streak, AUTH_PARK_ATTEMPTS);
        assert!(heal.parked, "sustained failure must park");
        // parked ≠ stopped: after the capped cadence the ladder still fires
        t += Duration::from_secs(AUTH_BACKOFF_CAP_SECS);
        assert!(matches!(heal.on_auth_failure(t), HealStep::Attempt));
        assert!(heal.parked, "still parked while failures continue");
        // a repair success fully re-arms
        heal.on_repair_success();
        assert!(!heal.parked);
        assert_eq!(heal.streak, 0);
        // and a hub-side acceptance (tick got through) re-arms mid-episode
        assert!(matches!(heal.on_auth_failure(t), HealStep::Attempt));
        heal.on_hub_accepted();
        assert_eq!(heal.streak, 0);
        assert!(!heal.parked);
        // hub-accepted with nothing pending is a no-op (no state churn)
        heal.on_hub_accepted();
        assert_eq!(heal.streak, 0);
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
    fn missing_bridge_tools_is_a_void_configuration_failure_not_a_completed_diagnostic_br7500() {
        for (stdout, stderr) in [(BRIDGE_TOOLS_MISSING, ""), ("", BRIDGE_TOOLS_MISSING)] {
            assert!(void_run(stdout, stderr), "exit 0 cannot hand off as done/in_review");
            assert!(is_config_error(stdout) || is_config_error(stderr), "missing tools require execution-configuration repair");
        }
        assert!(!void_run("Repaired an earlier `MCP UNAVAILABLE: bridge tools missing` launch; verified the tools now work.", ""));
        let mut breaker = CircuitBreaker::default();
        for _ in 0..CircuitBreaker::THRESHOLD { breaker.record_failure(BRIDGE_TOOLS_MISSING, ""); }
        assert!(breaker.tripped());
        assert_eq!(breaker.last_signature, BRIDGE_TOOLS_MISSING, "report the machinery fault, not 'other'");
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
/// gateway's own credentials. Secret cached in ~/.bridge/dispatch/
/// agent-tokens.json — the FIXED canonical path shared with logout_core's
/// credential clear (562f394, BR#6682); hub dedupes by label. When our local cache
/// is empty but the hub token already exists, the hub cannot re-show the secret (vended
/// once) — the only recovery is a rotate re-vend, so we retry exactly once
/// with rotate (old token revoked, fresh secret issued, cached). Without
/// this the runner dead-ends forever — the 2026-10-24 churn engine (38
/// fake in-flight cards, 38–58 watchdog releases each).
#[derive(Clone)]
struct WorkerCredential { label: String, secret: String }
fn provision_agent_token(cfg: &DispatchConfig, agent_label: &str) -> Result<WorkerCredential, String> {
    // Credentials belong to the gateway, not an individual runner's ephemeral
    // report directory. Side-by-side processes must reuse the same credential;
    // separate caches would revoke each other's active workers on every tick.
    let cache_path = agent_token_cache_path().ok_or("no home directory")?;
    std::fs::create_dir_all(cache_path.parent().ok_or("no cache directory")?).map_err(|e| e.to_string())?;
    let mut cache: HashMap<String, String> = std::fs::read_to_string(&cache_path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let hub = cfg.url.trim_end_matches('/').to_string();
    if let Some(secret) = cache.get(agent_label).filter(|s| !s.is_empty()).cloned() {
        let response = client.post(format!("{hub}/api/kb-machine/provision"))
            .header("Authorization", format!("Bearer {}", cfg.token)).json(&json!({ "label": agent_label, "cached_secret": secret })).send().map_err(|e| e.to_string())?;
        let status = response.status();
        let proof: serde_json::Value = response.json().map_err(|e| e.to_string())?;
        if status.is_success() && proof["cached"] == true {
            return Ok(WorkerCredential { label: proof["label"].as_str().filter(|s| !s.is_empty()).ok_or("worker proof missing canonical label")?.into(), secret });
        }
        if status.as_u16() != 401 && status.as_u16() != 403 {
            return Err(format!("worker credential proof not ready ({status}); keep cache and wait — never rotate on infrastructure/deploy errors"));
        }
        cache.remove(agent_label); // explicit revoked/wrong-class prerequisite
        dlog(agent_label, "cached worker credential invalid/wrong class; re-provisioning under the gateway's own namespace");
    }
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
        if !status.is_success() {
            return Err(format!("hub {}: worker provisioning refused: {}", status.as_u16(),
                body.get("error").and_then(|e| e.as_str()).unwrap_or("no error detail")));
        }
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
            dlog(
                agent_label,
                "agent token re-vended by rotate (cache was empty)",
            );
        }
        let label = body.get("label").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).ok_or("worker provision response missing canonical label")?;
        return Ok(WorkerCredential { label: label.into(), secret: secret.into() });
    }
    Err(format!(
        "agent token provisioning for '{agent_label}' failed after rotate retry — {last_err}"
    ))
}

/// The vended-secret check for the bounded re-show/rotate path. The caller
/// rejects HTTP failures first (auth must reach the repair ladder, and an
/// infrastructure failure must never revoke a worker). A successful response
/// without a usable secret is the existing-token re-show case.
fn provision_response_needs_rotate(status_ok: bool, body: &serde_json::Value) -> bool {
    let usable_secret = body
        .get("secret")
        .and_then(|s| s.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    !(status_ok && usable_secret)
}
