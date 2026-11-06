//! train.rs — the native merge-train executor (`bridge train`, BR#3879 per
//! accepted decision BR#3880). Behavior-verbatim port of the former Node
//! executor (BR#3516/BR#3517). Since BR#4104 the module also powers the
//! GATEWAY-NATIVE leg: the daemon (desktop app / headless `bridge` runner)
//! spawns it beside the dispatch loop and runs the very same tick
//! opportunistically — any gateway contends the lane lease, first-to-lease
//! wins, no hand-installed systemd unit, binary updates ride the normal
//! deploy path.
//!
//! Division of labour (the whole point of the design): the HUB holds NO VCS
//! credentials, ever. This executor runs on a gateway machine that HAS `gh`
//! (+ a clone of the target repo), fetches every GitHub fact live, and
//! reports them through the hub's train ops — the HUB decides (lease CAS,
//! classification, events, queue). The executor never self-certifies.
//!
//! Identity law (BR#3181, enforced here since BR#4104): the tick probes its
//! gh identity class before any GitHub WRITE — merge / update-branch / close
//! legs execute only under the worker-class credential (detached-cody). A
//! personally-authed gateway (e.g. rayh's keyring gh) still reconciles and
//! reports, but refuses the write legs LOUDLY and releases the lease so a
//! worker-class gateway can take the lane. An unclassifiable identity is
//! refused writes too (fail-closed).
//!
//! Lease liveness (the zombie fix, BR#4104): every renewal carries
//! proof-of-progress (last ledger action + its age + queue depth). The hub
//! ignores the payload today; consuming it (deny renewal when progress is
//! stale while the queue is non-empty) is the filed hub-eviction follow-up —
//! the seam is real and already on the wire.
//!
//! Loop (one tick): preflight → train_status → per lane: CAS-lease →
//! reconcile from live GitHub → awaiting-CI poll → else WALK the derived
//! queue in order and drive the first entry that can act (BR#3935: a
//! permanently unlandable entry must not starve the lane — a stamp-less leg
//! is BOUNCED off the hub so lane.queue self-heals (BR#5753), a CLOSED PR or
//! an entry with no unlanded leg on this lane is logged and the walk
//! advances in the SAME tick; a transient no-op still blocks) →
//! decideTrainGate → act: merge → train:merged → next tick polls CI on the
//! merge commit. Carry law (BR#3516 §5): machine-clean carries,
//! human-resolved invalidates. Local git plumbing is three-valued (BR#3935):
//! a git FAILURE is never folded into a conflict/behind verdict — the PR
//! head is fetched explicitly before any local op names it.

use crate::train_gate::{
    classify_base_check_runs, decide_train_gate, drain_burst_decision, format_deploy_coverage_summary,
    is_root_fix_card, latest_red_deploy_health_runs, merge_sweep_human_leg_title, normalize_gh_mergeable,
    normalize_gh_merge_state, parse_burst_max, parse_iso8601_epoch_ms, reconcile_base_verdict_with_deploy_coverage,
    reconcile_deploy_coverage, root_fix_fast_lane_title, train_leg_landed, train_leg_state, train_legs,
    verdict_covers_head_leg, CheckVerdict, DeployCoverageState, DeployReconcilePlan, DeployWorkflowRun,
    DrainDecision, MainCheckRun, MainVerdict, MergeAction, DEPLOY_RECONCILE_GRACE_SECS, TRAIN_CI_BOUND_MULTIPLIER,
    TRAIN_CI_TYPICAL_MINUTES,
};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::BufRead;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::logging::{emit, iso, now_ms, prefer_stdout};

const SESSION: &str = "merge-train-executor";
const RPC_TIMEOUT: Duration = Duration::from_secs(60);

/// How the tick's gh credential classifies (BR#3181). Probed from
/// `gh api user --jq .login`; Worker = an identity on the worker allowlist.
#[derive(Clone, Debug, PartialEq)]
pub enum IdentityClass {
    /// Worker-class credential — merge/carry legs allowed.
    Worker(String),
    /// A named personal credential — read-only reconcile/report; write legs
    /// REFUSED loudly. NEVER merges as this identity.
    Personal(String),
    /// Probe failed (gh broken/transient) — fail-closed, re-probed next tick.
    Unknown(String),
}

/// Pure classifier — the identity law's decision point (unit-pinned below).
fn classify_login(login: &str, worker_identities: &[String]) -> IdentityClass {
    let l = login.trim().to_lowercase();
    if l.is_empty() {
        return IdentityClass::Unknown(login.trim().to_string());
    }
    if worker_identities.iter().any(|w| w.trim().to_lowercase() == l) {
        IdentityClass::Worker(login.trim().to_string())
    } else {
        IdentityClass::Personal(login.trim().to_string())
    }
}

/// BR#4687 (L1.2) branch provenance — pure, unit-pinned. The branch is the
/// train's own (machine-updatable) iff it is non-empty and EVERY commit was
/// authored by a worker-class identity. An empty commit list (API hiccup)
/// fails closed to human-owned: a bounce is the safe direction, a machine
/// rewrite of an unknown branch is not.
fn branch_is_worker_authored(commit_logins: &[String], worker_identities: &[String]) -> bool {
    !commit_logins.is_empty()
        && commit_logins
            .iter()
            .all(|l| matches!(classify_login(l, worker_identities), IdentityClass::Worker(_)))
}

/// A merge recorded from GitHub may be an intermediate topic merge with no
/// main-push CI of its own. Only a proven containing live tip can settle it.
fn settle_from_descendant_ci(proven_descendant: bool, runs: &[MainCheckRun], required: &[String]) -> bool {
    if !proven_descendant || required.is_empty() || !runs.iter().all(|r| r.status.as_deref() == Some("completed")) {
        return false;
    }
    let required_run = |r: &MainCheckRun| required.iter().any(|n| n == &r.name);
    if runs.iter().any(|r| required_run(r) && matches!(r.conclusion.as_deref(), Some("failure" | "timed_out" | "action_required"))) {
        return false;
    }
    runs.is_empty()
        || runs.iter().any(|r| required_run(r) && r.conclusion.as_deref() == Some("cancelled"))
        || !runs.iter().any(required_run)
        || runs.iter().any(|r| r.conclusion.as_deref() == Some("startup_failure"))
}

/// "detached-cody, rayh" → ["detached-cody", "rayh"] — trimmed, lowercased.
fn parse_identities(raw: &str) -> Vec<String> {
    raw.split(',').map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect()
}

/// MERGE_TRAIN_ENABLED parsing: absent → on; "0"/"false"/"no"/"off" → off.
fn env_enabled(raw: Option<String>) -> bool {
    !matches!(raw.as_deref().map(|s| s.trim().to_lowercase()).as_deref(), Some("0" | "false" | "no" | "off"))
}

/// Daemon tick cadence: clamped so a gateway can never starve the lease
/// (TTL is 5 min) or hammer the hub.
fn clamp_interval_secs(v: u64) -> u64 {
    v.clamp(5, 240)
}

/// BR#4170 reconcile cadence: clamped so the read-only `gh pr list` leg can
/// neither hammer GitHub (≥ 5 min) nor let the board↔GitHub invariant go
/// stale for a day (≤ 6 h).
fn clamp_reconcile_interval_secs(v: u64) -> u64 {
    v.clamp(300, 21_600)
}

/// L1.1 (BR#4685): the mergeability backoff-poll ladder, in seconds. MERGE_TRAIN_POLL_SECS
/// overrides ("15,30,60" shape); anything unparsable/empty keeps the default.
fn parse_poll_secs(raw: &str) -> Vec<u64> {
    let parsed: Vec<u64> = raw.split(',').filter_map(|s| s.trim().parse::<u64>().ok()).collect();
    if parsed.is_empty() {
        vec![15, 30, 60]
    } else {
        parsed
    }
}

fn mergeability_poll_secs() -> Vec<u64> {
    parse_poll_secs(&std::env::var("MERGE_TRAIN_POLL_SECS").unwrap_or_default())
}

/// L1.1 (BR#4685): has GitHub ANSWERED the mergeability question? The state
/// is the answer — null/"" (computing) or "unknown" (GraphQL UNKNOWN) is not
/// an answer, and the `mergeable` field rides the same async recomputation,
/// so neither field is definitive until the state names itself. Facts are
/// normalized at the boundary (pr_facts), so comparison is lowercase; the
/// normalizer is idempotent, so raw uppercase shapes work too (tests).
fn mergeability_definitive(facts: &Value) -> bool {
    match normalize_gh_merge_state(facts.get("mergeStateStatus").unwrap_or(&Value::Null)) {
        Some(s) => {
            let s = s.trim();
            !s.is_empty() && s != "unknown"
        }
        None => false,
    }
}

/// Managed clone-cache path for a lane repo: base/owner/name — one clone per
/// repo per gateway, shared by every lane of that repo.
fn cache_dir(base: &str, repo: &str) -> PathBuf {
    let mut p = PathBuf::from(base);
    for seg in repo.split('/') {
        let seg = seg.trim();
        if seg.is_empty() || seg == "." || seg == ".." {
            continue; // never let a lane key walk out of the cache
        }
        p.push(seg);
    }
    p
}

/// Root of the managed clone cache. MERGE_TRAIN_CACHE_DIR overrides (tests).
fn clone_cache_base() -> String {
    std::env::var("MERGE_TRAIN_CACHE_DIR")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("{}/.bridge/train", std::env::var("HOME").unwrap_or_else(|_| ".".into())))
}

struct Ctx {
    http: reqwest::blocking::Client,
    hub: String,
    token: String,
    holder: String,
    interval_ms: u64,
    method: String,
    workdir: String,
    lane_filter: Option<String>,
    once: bool,
    rpc_id: u64,
    // ---- gateway-native leg (BR#4104) ----
    /// true: running inside the daemon — never `std::process::exit`, per-lane
    /// clone-cache workdirs, stderr logging, lane allowlist honoured.
    in_process: bool,
    /// MCP session name (hub attribution). Standalone: SESSION; the daemon leg
    /// names the gateway (`merge-train@<label>`).
    session: String,
    /// Worker-class gh identities allowed to execute write legs (BR#3181).
    worker_identities: Vec<String>,
    /// Probed identity class (cached ≤5 min — claim-time truth, not startup
    /// truth; Unknown re-probes every tick).
    identity: Option<IdentityClass>,
    /// When `identity` was probed (ms epoch) — drives the ≤5-min re-probe.
    identity_probed_ms: u64,
    /// The identity label last announced — logs only on change.
    identity_announced: Option<String>,
    /// BR#4489: a mid-merge permission refusal demotes the host for the
    /// PROCESS LIFETIME — startup truth was runtime falsehood; gh could
    /// still classify the login as a worker, so this gate is separate from
    /// `identity` and never re-probes away.
    demoted: Option<String>,
    skip_log_ms: u64,
    /// Lane allowlist (`repo@base` keys). Empty = every lane the hub reports.
    lane_allow: Vec<String>,
    /// Fixed workdir (MERGE_TRAIN_WORKDIR). None → managed clone cache.
    workdir_override: Option<String>,
    /// BR#4977: shell out to gh before acquiring a lane to prove its base
    /// branch still exists on the remote (404 ⇒ the lane is retired — skip
    /// with no lease, no hub meta writes). On in production; off in the
    /// test ctxs so the drills stay hermetic.
    base_probe: bool,
    // ---- lease liveness: proof of progress ----
    /// Last meaningful ledger action this executor took (renewals carry it).
    last_action: String,
    /// When `last_action` happened (ms epoch).
    last_action_ms: u64,
    // ---- BR#5376: the batch-stall tracker + merge-method fallback ----
    /// Per-lane (`repo@base`) batch-stall state: a batch that selects
    /// members and attempts merges but lands NOTHING, consecutive ticks.
    /// At the threshold the walk fires ONE "stalled" train event per
    /// episode; the hub renders the loud STALLED lane and files the
    /// one-per-episode alarm ask (the same dedupe law as base-red).
    stall: std::collections::HashMap<String, BatchStall>,
    /// Per-repo merge method discovered by the BR#5376 fallback (the repo
    /// refuses the configured method — GitHub enforces its merge policy at
    /// the mutation even when REST still reads the flag true). Remembered
    /// for the process so a batch lands back-to-back without one wasted
    /// refusal per member.
    method_sub: std::collections::HashMap<String, String>,
    /// Per-tick scratch (drive_lane resets, drive_lane_inner fills,
    /// stall_settle reads): the batch this tick selected, whether a merge
    /// attempt ran, how many members landed, the error that ended the tick.
    tick_batch: Vec<i64>,
    tick_attempted: bool,
    tick_landed: u32,
    tick_error: Option<String>,
    /// Per-(lane, sha) auto-rerun guard for rapid red-train self-healing:
    /// when a lane stops on a failing required workflow (no burst bisect),
    /// the executor automatically triggers one `gh run rerun` per `(key, sha)`
    /// so marginal races (e.g. Post-Deploy Smoke deadline race) self-heal.
    auto_rerun_shas: std::collections::HashSet<String>,
    /// BR#6179: Per-(lane, tip_sha) auto-dispatch guard (`"{key}:{sha}"` -> `dispatched_at_ms`)
    /// so level-based deploy reconciliation dispatches `workflow_dispatch` at most ONCE per sha.
    auto_deploy_dispatched_shas: std::collections::HashMap<String, u64>,
    /// BR#6179: Redundant queued workflow run IDs already cancelled this process lifetime.
    cancelled_redundant_runs: std::collections::HashSet<i64>,
    #[cfg(test)]
    sh_mock: Option<std::sync::Arc<dyn Fn(&str, &[&str]) -> Option<Result<String, String>> + Send + Sync>>,
    // ---- token-rot visibility (BR#4754) ----
    /// The lane card id train_status last reported (the one-per-episode
    /// token-rot note lands there after a self-healed blind episode).
    last_lane_card: Option<String>,
}

fn trunc(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Train lines ride the single logging mechanism (BR#4400): the lane
/// (`owner/repo@base`) is the scope; stream selection lives in logging.rs
/// (stdout for the standalone CLI via `prefer_stdout`, stderr in-process
/// beside the dispatch loop).
fn log(lane: Option<&str>, msg: &str) {
    emit("train", lane.unwrap_or(""), msg);
}

fn short_host() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .or_else(|| Command::new("hostname").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()))
        .unwrap_or_default()
        .split('.')
        .next()
        .unwrap_or("")
        .to_string()
}

/// Worker-class gh identities from env, defaulting to the BR#3181 ruling:
/// merge legs execute as detached-cody or not at all.
fn worker_identities_from_env() -> Vec<String> {
    let parsed = parse_identities(&std::env::var("MERGE_TRAIN_WORKER_IDENTITIES").unwrap_or_default());
    if parsed.is_empty() { vec!["detached-cody".into()] } else { parsed }
}

impl Ctx {
    fn flag(args: &[String], name: &str) -> Option<String> {
        args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
    }

    fn resolve(args: &[String]) -> Result<Ctx, String> {
        let paired = crate::dispatch::DispatchConfig::resolve();
        let hub = std::env::var("BRIDGE_URL").ok().or(paired.as_ref().map(|c| c.url.clone())).unwrap_or_default();
        let token = std::env::var("BRIDGE_TOKEN").ok().or(paired.as_ref().map(|c| c.token.clone())).unwrap_or_default();
        if hub.trim().is_empty() || token.trim().is_empty() {
            return Err("BRIDGE_URL / BRIDGE_TOKEN not set and no pairing found — run `bridge pair` (or `bridge doctor`), retry".into());
        }
        let method = Self::flag(args, "--method").or_else(|| std::env::var("MERGE_TRAIN_METHOD").ok()).unwrap_or_else(|| "merge".into());
        let holder = std::env::var("MERGE_TRAIN_HOLDER")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("merge-train@{}", short_host()));
        let interval_secs: u64 = Self::flag(args, "--interval")
            .and_then(|v| v.parse().ok())
            .or_else(|| std::env::var("MERGE_TRAIN_INTERVAL_SECS").ok().and_then(|v| v.parse().ok()))
            .unwrap_or(45);
        let workdir_env = std::env::var("MERGE_TRAIN_WORKDIR").ok().filter(|s| !s.is_empty());
        Ok(Ctx {
            http: reqwest::blocking::Client::builder().timeout(RPC_TIMEOUT).build().map_err(|e| e.to_string())?,
            hub: hub.trim_end_matches('/').to_string(),
            token,
            holder,
            interval_ms: interval_secs.max(1) * 1000,
            method,
            workdir: workdir_env.clone().unwrap_or_else(|| ".".into()),
            lane_filter: Self::flag(args, "--lane"),
            once: args.iter().any(|a| a == "--once"),
            rpc_id: 0,
            in_process: false,
            session: SESSION.into(),
            worker_identities: worker_identities_from_env(),
            identity: None,
            identity_probed_ms: 0,
            identity_announced: None,
            demoted: None,
            skip_log_ms: 0,
            lane_allow: vec![],
            workdir_override: workdir_env,
            base_probe: true,
            last_action: "executor started".into(),
            last_action_ms: now_ms(),
            stall: std::collections::HashMap::new(),
            method_sub: std::collections::HashMap::new(),
            tick_batch: Vec::new(),
            tick_attempted: false,
            tick_landed: 0,
            tick_error: None,
            auto_rerun_shas: std::collections::HashSet::new(),
            auto_deploy_dispatched_shas: std::collections::HashMap::new(),
            cancelled_redundant_runs: std::collections::HashSet::new(),
            #[cfg(test)]
            sh_mock: None,
            last_lane_card: None,
        })
    }

    /// MCP over the hub's /mcp — the same JSON-RPC surface the agents use.
    fn mcp(&mut self, name: &str, args_body: Value) -> Result<Value, String> {
        self.rpc_id += 1;
        let mut arguments = args_body;
        if let Value::Object(map) = &mut arguments {
            map.insert("session".into(), json!(self.session));
        }
        let resp = self
            .http
            .post(format!("{}/mcp", self.hub))
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {}", self.token))
            .json(&json!({ "jsonrpc": "2.0", "id": self.rpc_id, "method": "tools/call", "params": { "name": name, "arguments": arguments } }))
            .send()
            .map_err(|e| format!("hub unreachable ({name}): {e}"))?;
        let out: Value = resp.json().map_err(|e| format!("hub rpc non-JSON ({name}): {e}"))?;
        if let Some(err) = out.get("error") {
            let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or(&err.to_string()).to_string();
            return Err(format!("hub rpc error ({name}): {msg}"));
        }
        let result = out.get("result").cloned().unwrap_or(Value::Null);
        let raw = result
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        let parsed: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        if result.get("isError").and_then(|v| v.as_bool()).unwrap_or(false) {
            return Err(format!("hub tool error ({name}): {}", trunc(&raw, 300)));
        }
        Ok(parsed)
    }

    fn train_lease(&mut self, repo: &str, base: &str, action: &str, extra: Value) -> Result<Value, String> {
        let mut body = json!({ "repo": repo, "base": base, "action": action });
        if let (Value::Object(dst), Value::Object(src)) = (&mut body, &extra) {
            for (k, v) in src {
                dst.insert(k.clone(), v.clone());
            }
        }
        self.mcp("train_lease", body)
    }

    // gh/git inside the target clone; we read stdout, surface stderr on failure.
    fn sh(&self, cmd: &str, cmd_args: &[&str]) -> Result<String, String> {
        #[cfg(test)]
        if let Some(ref mock) = self.sh_mock {
            if let Some(res) = mock(cmd, cmd_args) {
                return res;
            }
        }
        let out = Command::new(cmd)
            .args(cmd_args)
            .current_dir(&self.workdir)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!("{cmd} {} failed ({}): {}", cmd_args.join(" "), out.status, trunc(String::from_utf8_lossy(&out.stderr).trim(), 400)));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    fn gh_json(&self, cmd_args: &[&str]) -> Result<Value, String> {
        let out = self.sh("gh", cmd_args)?;
        serde_json::from_str(&out).map_err(|_| format!("gh gave non-JSON output: {}", trunc(&out, 200)))
    }

    /// Record a meaningful ledger action — renewals carry this as the lease's
    /// proof-of-progress (the zombie fix's gateway half, BR#4104).
    fn note(&mut self, action: &str) {
        self.last_action = trunc(action, 200);
        self.last_action_ms = now_ms();
    }

    /// Probe (`gh api user --jq .login`) and classify this tick's gh
    /// credential. Decided classes are cached ≤5 min (BR#4489: startup truth
    /// is not runtime truth — the check re-runs at claim time on that
    /// cadence); Unknown (gh broke / transient) re-probes every tick. Logs
    /// loudly on change — the identity law must be VISIBLE, not ambient.
    fn ensure_identity(&mut self) -> IdentityClass {
        const IDENTITY_CACHE_MS: u64 = 5 * 60_000;
        let decided = match &self.identity {
            Some(c @ (IdentityClass::Worker(_) | IdentityClass::Personal(_)))
                if now_ms().saturating_sub(self.identity_probed_ms) < IDENTITY_CACHE_MS =>
            {
                c.clone()
            }
            _ => {
                let login = self.sh("gh", &["api", "user", "--jq", ".login"]).unwrap_or_default();
                let class = classify_login(&login, &self.worker_identities);
                self.identity_probed_ms = now_ms();
                let changed = matches!(&self.identity, Some(prev) if *prev != class);
                self.identity = Some(class.clone());
                if changed {
                    log(None, &format!("gh identity CHANGED mid-run → {class:?} — re-classified at claim time (≤5-min cache)"));
                }
                class
            }
        };
        let label = match &decided {
            IdentityClass::Worker(l) => format!("{l} (worker class — merge legs allowed)"),
            IdentityClass::Personal(l) => format!("{l} (PERSONAL class — merge legs REFUSED per BR#3181)"),
            IdentityClass::Unknown(e) => format!("unknown ({e}) (fail-closed — merge legs REFUSED)"),
        };
        if self.identity_announced.as_deref() != Some(&label) {
            log(None, &format!("gh identity: {label}"));
            self.identity_announced = Some(label);
        }
        decided
    }

    /// THE identity gate (BR#3181): only a worker-class credential may execute
    /// GitHub write legs (merge / update-branch / close). Personal and
    /// unknown identities are refused — fail-closed — and the refusal is
    /// loud, never silent. A demoted host (BR#4489: gh refused a write this
    /// process had every reason to believe it could make) is refused
    /// unconditionally for the process lifetime.
    fn write_allowed(&mut self) -> bool {
        if self.demoted.is_some() {
            return false;
        }
        matches!(self.ensure_identity(), IdentityClass::Worker(_))
    }

    /// BR#4489 self-demotion: the capability claim was false at merge time —
    /// never trust this process's classification again. The demote is
    /// process-lifetime by construction (a fresh process re-classifies from
    /// live gh, which is the recovery path: fix the credential, restart).
    fn demote(&mut self, reason: &str) {
        if self.demoted.is_none() {
            log(None, &format!("SELF-DEMOTED: {reason} — this process will not claim the train lock again (restart the gateway after fixing the credential)"));
        }
        self.demoted = Some(reason.to_string());
        self.identity_announced = None;
    }

    /// BR#4489: the incapable-host skip, logged on a slow throttle (once per
    /// 10 min) — visible without spamming a 45s loop.
    fn note_skip_throttled(&mut self, key: &str, reason: &str) {
        let now = now_ms();
        if now - self.skip_log_ms >= 10 * 60_000 {
            self.skip_log_ms = now;
            log(Some(key), reason);
            self.note(reason);
        }
    }

    /// Resolve the workdir for a lane's repo: the explicit override
    /// (MERGE_TRAIN_WORKDIR, standalone behavior) or the managed clone cache
    /// (`~/.bridge/train/<owner>/<repo>`, cloned on first use). Daemon mode
    /// calls this per lane right before driving it.
    fn workdir_for(&mut self, repo: &str) -> Result<(), String> {
        if let Some(wd) = &self.workdir_override {
            self.workdir = wd.clone();
            return Ok(());
        }
        if !self.in_process {
            return Ok(()); // standalone: workdir was resolved once from env/cwd
        }
        let dir = cache_dir(&clone_cache_base(), repo);
        if !dir.join(".git").exists() {
            if let Some(parent) = dir.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            log(None, &format!("clone cache: fetching {repo} → {}", dir.display()));
            let url = format!("https://github.com/{repo}");
            let out = Command::new("git")
                .args(["clone", "--quiet", &url])
                .arg(&dir)
                .env("GIT_TERMINAL_PROMPT", "0")
                .output()
                .map_err(|e| e.to_string())?;
            if !out.status.success() {
                return Err(format!("clone {repo} failed: {}", trunc(String::from_utf8_lossy(&out.stderr).trim(), 200)));
            }
            self.note(&format!("cloned {repo} into the gateway train cache"));
        }
        self.workdir = dir.to_string_lossy().to_string();
        Ok(())
    }

    fn preflight(&self, announce: bool) -> Result<(), String> {
        let mut bad: Vec<String> = vec![];
        for c in ["gh", "git"] {
            if Command::new(c).arg("--version").output().map(|o| !o.status.success()).unwrap_or(true) {
                bad.push(format!("{c} not runnable"));
            }
        }
        match Command::new("gh").args(["auth", "status"]).output() {
            Ok(o) if !o.status.success() => bad.push(format!("gh not authed ({})", trunc(String::from_utf8_lossy(&o.stderr).trim(), 120))),
            Ok(_) => {}
            Err(_) => bad.push("gh not authed".into()),
        }
        // The daemon resolves the workdir per lane from the managed clone
        // cache — there is no single cwd to check.
        let check_workdir = !self.in_process || self.workdir_override.is_some();
        if check_workdir
            && !Command::new("git")
                .args(["rev-parse", "--is-inside-work-tree"])
                .current_dir(&self.workdir)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        {
            bad.push(format!("{} is not a git clone (set MERGE_TRAIN_WORKDIR)", self.workdir));
        }
        if !["merge", "squash", "rebase"].contains(&self.method.as_str()) {
            bad.push(format!("unknown merge method '{}'", self.method));
        }
        if !bad.is_empty() {
            return Err(format!("preflight failed: {}", bad.join("; ")));
        }
        if announce {
            log(None, &format!("executor up — holder={} method={} interval={}s workdir={}", self.holder, self.method, self.interval_ms / 1000, self.workdir));
        }
        Ok(())
    }

    /// PR head facts, normalized AT the fact boundary (BR#3714).
    fn pr_facts(&self, repo: &str, n: i64) -> Result<Value, String> {
        let mut raw = self.gh_json(&[
            "pr",
            "view",
            &n.to_string(),
            "--repo",
            repo,
            "--json",
            "number,headRefOid,mergeable,mergeStateStatus,state,mergeCommit,baseRefName",
        ])?;
        let norm_mergeable = normalize_gh_mergeable(raw.get("mergeable").unwrap_or(&Value::Null));
        let norm_state = normalize_gh_merge_state(raw.get("mergeStateStatus").unwrap_or(&Value::Null));
        if let Value::Object(map) = &mut raw {
            map.insert("mergeable".into(), json!(norm_mergeable));
            map.insert("mergeStateStatus".into(), json!(norm_state));
        }
        Ok(raw)
    }

    /// BR#5623: PAGINATED — GitHub defaults to per_page=30 and returns runs
    /// newest-first. The 2026-11-02 lane death (10.6h BLOCKED, 54-PR pileup):
    /// the tip froze after the last merge while scheduled workflows kept
    /// attaching check-runs to it; once the newest-30 were all newer than the
    /// deploy runs, the four lane-required runs fell onto page 2 and the
    /// base-green gate read a false "empty" verdict every tick — fail-closed
    /// on a green base, self-sustaining (no merge → frozen tip → still more
    /// runs → worse each hour). Read per_page=100 pages until a short page;
    /// any gh/parse failure still yields an EMPTY vec (→ Empty verdict →
    /// lane blocked → fail-closed), never a partial read.
    fn check_runs(&self, repo: &str, sha: &str) -> Vec<MainCheckRun> {
        let mut pages: Vec<Option<Vec<Value>>> = Vec::new();
        for page in 1..=10 {
            let out = self.gh_json(&[
                "api",
                &format!("repos/{repo}/commits/{sha}/check-runs?per_page=100&page={page}"),
                "--jq",
                "[.check_runs[] | {id, name, status, conclusion, html_url, check_suite, app}]",
            ]);
            match out {
                Ok(Value::Array(a)) => {
                    let short = a.len() < 100;
                    pages.push(Some(a));
                    if short {
                        break;
                    }
                }
                _ => {
                    pages.push(None);
                    break;
                }
            }
        }
        let mut runs = check_runs_from_pages(&pages);
        // BR#6142: when a GitHub Actions workflow fails with `conclusion ==
        // "startup_failure"` (e.g. invalid reusable workflow permissions or YAML
        // syntax error), GitHub creates a workflow_run in `/actions/runs` with
        // `conclusion: "startup_failure"` and ZERO job entries in `/check-runs`.
        // Without folding those workflow-level startup_failures into `check_runs`,
        // a PR whose CI workflow died at startup reads 0 red checks (Green), and
        // a main deploy that died at startup reads 0 required checks (Empty /
        // 60m pending settle).
        if let Ok(Value::Array(wf_runs)) = self.gh_json(&[
            "api",
            &format!("repos/{repo}/actions/runs?head_sha={sha}&per_page=100"),
            "--jq",
            "[.workflow_runs[] | {id, name, status, conclusion, html_url, workflow_id, run_attempt}]",
        ]) {
            runs.extend(workflow_startup_failures(&wf_runs));
        }
        runs
    }

    /// BR#6179: Read the base branch tip SHA and its commit age in seconds
    /// (`now_ms - committed_at`). Accepts either `{sha, committed_at}` JSON
    /// or a bare SHA string (backwards-compatible with `.sha` mocks).
    fn base_tip_facts(&self, repo: &str, base: &str) -> Result<(String, u64), String> {
        if let Ok(out) = self.sh(
            "gh",
            &[
                "api",
                &format!("repos/{repo}/commits/{base}"),
                "--jq",
                "{sha: .sha, committed_at: (.commit.committer.date // .commit.author.date)}",
            ],
        ) {
            if let Ok(v) = serde_json::from_str::<Value>(&out) {
                if let Some(sha) = v.get("sha").and_then(|s| s.as_str()).filter(|s| !s.is_empty()) {
                    let age_secs = v
                        .get("committed_at")
                        .and_then(|d| d.as_str())
                        .and_then(parse_iso8601_epoch_ms)
                        .map(|ms| now_ms().saturating_sub(ms) / 1000)
                        .unwrap_or(0);
                    return Ok((sha.to_string(), age_secs));
                }
            }
            let trimmed = out.trim().trim_matches('"').to_string();
            if !trimmed.is_empty() && !trimmed.starts_with('{') {
                return Ok((trimmed, 0));
            }
        }
        let sha = self.sh("gh", &["api", &format!("repos/{repo}/commits/{base}"), "--jq", ".sha"])?;
        Ok((sha.trim().trim_matches('"').to_string(), 0))
    }

    /// BR#6179: Read recent workflow runs on `base` (and on `tip_sha`) for
    /// level-based deploy coverage and redundant-queued-run detection.
    fn workflow_runs(&self, repo: &str, base: &str, tip_sha: &str) -> Vec<DeployWorkflowRun> {
        let mut combined: Vec<DeployWorkflowRun> = Vec::new();
        if let Ok(Value::Array(branch_runs)) = self.gh_json(&[
            "api",
            &format!("repos/{repo}/actions/runs?branch={base}&per_page=30"),
            "--jq",
            "[.workflow_runs[] | {id, name, path, head_sha, event, status, conclusion, html_url}]",
        ]) {
            for r in parse_deploy_workflow_runs(&branch_runs) {
                if !combined.iter().any(|x| x.id == r.id) {
                    combined.push(r);
                }
            }
        }
        if !tip_sha.is_empty() {
            if let Ok(Value::Array(sha_runs)) = self.gh_json(&[
                "api",
                &format!("repos/{repo}/actions/runs?head_sha={tip_sha}&per_page=100"),
                "--jq",
                "[.workflow_runs[] | {id, name, path, head_sha, event, status, conclusion, html_url}]",
            ]) {
                for r in parse_deploy_workflow_runs(&sha_runs) {
                    if !combined.iter().any(|x| x.id == r.id) {
                        combined.push(r);
                    }
                }
            }
        }
        combined
    }

    fn pr_commits(&self, repo: &str, n: i64) -> Vec<(String, bool)> {
        let out = self.gh_json(&["api", &format!("repos/{repo}/pulls/{n}/commits"), "--jq", "[.[] | {sha: .sha, verified: .commit.verification.verified}]"]);
        match out {
            Ok(Value::Array(a)) => a
                .iter()
                .map(|c| {
                    (
                        c.get("sha").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        c.get("verified").and_then(|v| v.as_bool()).unwrap_or(false),
                    )
                })
                .collect(),
            _ => vec![],
        }
    }

    /// BR#4687 (L1.2): branch provenance — the GitHub author LOGIN of every
    /// commit on the PR head. The pulls API resolves the commit email to the
    /// owning account (`author.login`; null when the email maps to no
    /// account). Worker-authored = every commit's login on the worker
    /// allowlist; anything else (a human's login, an unlinked email) fails
    /// closed to human-owned — the train never machine-updates a branch it
    /// cannot prove is its own fleet's.
    fn pr_commit_logins(&self, repo: &str, n: i64) -> Vec<String> {
        let out = self.gh_json(&["api", &format!("repos/{repo}/pulls/{n}/commits"), "--jq", "[.[] | {login: (.author.login // \"\")}]"]);
        match out {
            Ok(Value::Array(a)) => a
                .iter()
                .map(|c| c.get("login").and_then(|v| v.as_str()).unwrap_or("").trim().to_string())
                .collect(),
            _ => vec![],
        }
    }

    /// Trial merge (plumbing, no worktree): {clean, files} for the bounce
    /// brief. `git merge-tree --write-tree --name-only --no-messages` exits
    /// 1 on conflict and names the files; line 0 is the (partial) tree oid.
    /// CAUTION (BR#3935, probed on git 2.50): merge-tree exits 1 for a BAD
    /// OBJECT too ("not something we can merge") — the same code as a real
    /// conflict — so both inputs are verified commits FIRST
    /// (`git cat-file -e`), and exit 1 can only ever mean a genuine
    /// conflict. Any other failure is an Err — it used to be folded into
    /// `clean=false`, producing a lying bounce with an empty conflict list.
    /// `--no-messages` keeps the file list pure — without it the
    /// informational "Auto-merging …" / "CONFLICT (content) …" lines land
    /// in the parsed files and ride the bounce brief as fake filenames.
    fn trial_merge(&self, base: &str, head_sha: &str) -> Result<(bool, Vec<String>), String> {
        self.sh("git", &["fetch", "--quiet", "origin", base])?;
        for obj in [format!("origin/{base}"), head_sha.to_string()] {
            let known = Command::new("git")
                .args(["cat-file", "-e", &format!("{obj}^{{commit}}")])
                .current_dir(&self.workdir)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            if !known {
                return Err(format!(
                    "trial merge aborted: {obj} is not a commit object in {} — fetch it explicitly first (BR#3935: merge-tree cannot be trusted to say so)",
                    self.workdir
                ));
            }
        }
        let out = Command::new("git")
            .args(["merge-tree", "--write-tree", "--name-only", "--no-messages", &format!("origin/{base}"), head_sha])
            .current_dir(&self.workdir)
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok((true, vec![]));
        }
        if out.status.code() != Some(1) {
            return Err(format!(
                "git merge-tree {} {} failed ({}) — not a conflict verdict, fail-closed: {}",
                format!("origin/{base}"),
                head_sha,
                out.status,
                trunc(String::from_utf8_lossy(&out.stderr).trim(), 300)
            ));
        }
        let files: Vec<String> = String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .skip(1)
            .collect();
        Ok((false, files))
    }

    /// Fetch the PR head EXPLICITLY before any local git op names it
    /// (BR#3935). The executor's git plumbing runs against a local clone
    /// (MERGE_TRAIN_WORKDIR / the managed clone cache): a head authored on
    /// another box is a bad object there, and `git merge-base` exit 128 used
    /// to read as `behind=true` — a lying bounce with an empty conflict list.
    /// GitHub serves `refs/pull/<n>/head` to anyone who can read the repo;
    /// head_sha itself always comes from live pr_facts (headRefOid).
    fn fetch_pr_head(&self, n: i64) -> Result<(), String> {
        self.sh("git", &["fetch", "--quiet", "origin", &format!("+refs/pull/{n}/head")]).map(|_| ())
    }

    /// BR#4996 batch plumbing: a candidate head's changed-file set — `git
    /// diff --name-only merge-base(origin/base, head)..head`. The PR head is
    /// fetched EXPLICITLY first (BR#3935); a git failure is an Err, never a
    /// silently-empty set (the caller excludes the member as not-known-clean).
    fn pr_file_set(&self, base: &str, n: i64, head_sha: &str) -> Result<crate::train_gate::FileSet, String> {
        self.fetch_pr_head(n)?;
        let mb = self.sh("git", &["merge-base", &format!("origin/{base}"), head_sha])?;
        let out = self.sh("git", &["diff", "--name-only", &mb, head_sha])?;
        Ok(out.lines().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
    }

    /// BR#4996 batch plumbing: do two candidate heads conflict head-vs-head?
    /// Three-valued (BR#3935): true / false / CANNOT-READ (Err) — a merge-tree
    /// exit ∉ {0, 1} is never folded into a conflict verdict.
    fn heads_conflict(&self, a: &str, b: &str) -> Result<bool, String> {
        for obj in [a.to_string(), b.to_string()] {
            let known = Command::new("git")
                .args(["cat-file", "-e", &format!("{obj}^{{commit}}")])
                .current_dir(&self.workdir)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            if !known {
                return Err(format!(
                    "conflict probe aborted: {obj} is not a commit object in {} — fetch it explicitly first (BR#3935: merge-tree cannot be trusted to say so)",
                    self.workdir
                ));
            }
        }
        let out = Command::new("git")
            .args(["merge-tree", "--write-tree", "--name-only", "--no-messages", a, b])
            .current_dir(&self.workdir)
            .output()
            .map_err(|e| e.to_string())?;
        match out.status.code() {
            Some(0) => Ok(false),
            Some(1) => Ok(true),
            code => Err(format!(
                "git merge-tree {a} {b} failed ({code:?}) — not a conflict verdict, fail-closed: {}",
                trunc(String::from_utf8_lossy(&out.stderr).trim(), 300)
            )),
        }
    }

    /// Ancestry is a three-valued answer: true / false / CANNOT-READ. Only
    /// the first two are bools — a git failure (exit ∉ {0, 1}, e.g. a bad
    /// object) is an Err, never a silent `false` (BR#3935: exit 128 used to
    /// read as behind=true). Callers decide what CANNOT-READ means: the
    /// merge arm fails the tick closed; the awaiting-CI reconcile defers to
    /// its live pr_facts double-check.
    fn is_ancestor(&self, a: &str, b: &str) -> Result<bool, String> {
        #[cfg(test)]
        if let Some(mock) = &self.sh_mock {
            if let Some(result) = mock("git", &["merge-base", "--is-ancestor", a, b]) {
                return result.map(|value| value.trim() != "false");
            }
        }
        let out = Command::new("git")
            .args(["merge-base", "--is-ancestor", a, b])
            .current_dir(&self.workdir)
            .output()
            .map_err(|e| e.to_string())?;
        match out.status.code() {
            Some(0) => Ok(true),
            Some(1) => Ok(false),
            code => Err(format!(
                "git merge-base --is-ancestor {a} {b} failed ({code:?}) — cannot read ancestry, fail-closed: {}",
                trunc(String::from_utf8_lossy(&out.stderr).trim(), 300)
            )),
        }
    }
}

/// BR#5623: fold paginated check-run pages into MainCheckRuns. A `None`
/// page (gh/parse failure) fails CLOSED — empty vec, never a partial read:
/// downstream classifies empty as an "empty" verdict and blocks the lane,
/// which is the safe direction (a partial page-1-only read is exactly the
/// bug that killed the lane for 10.6h).
fn check_runs_from_pages(pages: &[Option<Vec<Value>>]) -> Vec<MainCheckRun> {
    let mut runs = Vec::new();
    for page in pages {
        let arr = match page {
            None => return vec![],
            Some(a) => a,
        };
        runs.extend(arr.iter().map(|r| MainCheckRun {
            id: r.get("id").and_then(|v| v.as_i64()).unwrap_or(0),
            source: match r.pointer("/check_suite/id").and_then(Value::as_i64).filter(|id| *id > 0) {
                Some(suite_id) => crate::train_gate::CheckSource::CheckRun { suite_id, app_id: r.pointer("/app/id").and_then(Value::as_i64).unwrap_or(0) },
                None => crate::train_gate::CheckSource::Unknown,
            },
            name: r.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            status: r.get("status").and_then(|v| v.as_str()).map(String::from),
            conclusion: r.get("conclusion").and_then(|v| v.as_str()).map(String::from),
            html_url: r.get("html_url").and_then(|v| v.as_str()).map(String::from),
        }));
    }
    runs
}

/// BR#6142: extract workflow-level `startup_failure` runs from `/actions/runs`
/// when the newest non-cancelled run of a workflow on the commit died at
/// startup (producing 0 job check-runs in `/commits/{sha}/check-runs`).
fn workflow_startup_failures(wf_runs: &[Value]) -> Vec<MainCheckRun> {
    let mut by_name: Vec<(String, Vec<MainCheckRun>)> = Vec::new();
    for r in wf_runs {
        let name = r.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if name.is_empty() {
            continue;
        }
        let item = MainCheckRun {
            id: r.get("id").and_then(|v| v.as_i64()).unwrap_or(0),
            source: match r.get("workflow_id").and_then(Value::as_i64).filter(|id| *id > 0) {
                Some(workflow_id) => crate::train_gate::CheckSource::WorkflowRun { workflow_id, run_attempt: r.get("run_attempt").and_then(Value::as_u64).unwrap_or(1) },
                None => crate::train_gate::CheckSource::Unknown,
            },
            name: name.clone(),
            status: r.get("status").and_then(|v| v.as_str()).map(String::from),
            conclusion: r.get("conclusion").and_then(|v| v.as_str()).map(String::from),
            html_url: r.get("html_url").and_then(|v| v.as_str()).map(String::from),
        };
        match by_name.iter_mut().find(|(n, _)| *n == name) {
            Some((_, list)) => list.push(item),
            None => by_name.push((name, vec![item])),
        }
    }
    let mut out = Vec::new();
    for (_, mut list) in by_name {
        list.sort_by(|a, b| b.id.cmp(&a.id));
        if let Some(judge) = list.into_iter().find(|r| r.conclusion.as_deref() != Some("cancelled")) {
            if judge.conclusion.as_deref() == Some("startup_failure") {
                out.push(judge);
            }
        }
    }
    out
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum CheckRetryTarget {
    CheckRun { id: i64 },
    ActionsJob { id: i64 },
    WorkflowRun { id: i64 },
}

impl CheckRetryTarget {
    fn endpoint(&self, repo: &str) -> String {
        match self {
            Self::CheckRun { id } => format!("repos/{repo}/check-runs/{id}/rerequest"),
            Self::ActionsJob { id } => format!("repos/{repo}/actions/jobs/{id}/rerun"),
            Self::WorkflowRun { id } => format!("repos/{repo}/actions/runs/{id}/rerun"),
        }
    }
}

fn check_retry_target(repo: &str, run: &MainCheckRun) -> Result<CheckRetryTarget, String> {
    use crate::train_gate::CheckSource;
    if run.id <= 0 { return Err("Cannot retry a check without a positive GitHub id".into()); }
    match &run.source {
        CheckSource::Unknown => Err("Cannot retry an untyped observation; refresh GitHub source identity".into()),
        CheckSource::WorkflowRun { .. } => Ok(CheckRetryTarget::WorkflowRun { id: run.id }),
        CheckSource::CheckRun { .. } => {
            // The Actions job id is not the Checks API id. Read the job's
            // explicit GitHub URL, scoped to this repository; never guess.
            let prefix = format!("https://github.com/{repo}/actions/runs/");
            if let Some(path) = run.html_url.as_deref().and_then(|url| url.strip_prefix(&prefix)) {
                let parts: Vec<_> = path.split('/').collect();
                if parts.len() == 3 && parts[1] == "job" {
                    if let (Ok(workflow), Ok(job)) = (parts[0].parse::<i64>(), parts[2].parse::<i64>()) {
                        if workflow > 0 && job > 0 { return Ok(CheckRetryTarget::ActionsJob { id: job }); }
                    }
                }
                return Err("Actions check URL does not identify a dispatchable job".into());
            }
            if run.html_url.as_deref().is_some_and(|url| url.contains("/actions/runs/")) {
                return Err("Actions job URL belongs to a different repository".into());
            }
            Ok(CheckRetryTarget::CheckRun { id: run.id })
        }
    }
}

fn dispatch_check_retry(ctx: &mut Ctx, repo: &str, base: &str, task: &str, head: &str, run: &MainCheckRun) -> Result<(), String> {
    let target = check_retry_target(repo, run)?;
    let reservation = ctx.mcp("train_queue_facts", json!({ "repo": repo, "base": base, "check_retry": {
        "kind": "reserve", "task_id": task, "head_sha": head, "name": run.name, "source": run.source, "target": target,
    } }))?;
    if reservation.get("kind").and_then(Value::as_str) != Some("reserved") {
        return Err(format!("Retry budget consumed for this head/obligation: {}", reservation));
    }
    let key = reservation.get("key").and_then(Value::as_str).ok_or("Retry reservation missing key")?;
    let endpoint = target.endpoint(repo);
    let result = ctx.sh("gh", &["api", &endpoint, "-X", "POST"]);
    // A lost response is an unknown effect, never permission to repeat. The
    // durable prepared reservation already fences restarts and lease takeovers.
    ctx.mcp("train_queue_facts", json!({ "repo": repo, "base": base, "check_retry": {
        "kind": "result", "key": key, "outcome": if result.is_ok() { "dispatched" } else { "outcome_unknown" },
        "receipt": match &result { Ok(_) => endpoint.clone(), Err(e) => e.clone() },
    } }))?;
    result.map(|_| ())
}

fn parse_deploy_workflow_runs(wf_runs: &[Value]) -> Vec<DeployWorkflowRun> {
    let mut out = Vec::new();
    for r in wf_runs {
        let id = r.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
        let name = r.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let head_sha = r.get("head_sha").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if id <= 0 || name.is_empty() {
            continue;
        }
        out.push(DeployWorkflowRun {
            id,
            run_attempt: r.get("run_attempt").and_then(|v| v.as_i64()),
            name,
            path: r.get("path").and_then(|v| v.as_str()).map(String::from),
            head_sha,
            event: r.get("event").and_then(|v| v.as_str()).map(String::from),
            status: r.get("status").and_then(|v| v.as_str()).map(String::from),
            conclusion: r.get("conclusion").and_then(|v| v.as_str()).map(String::from),
            html_url: r.get("html_url").and_then(|v| v.as_str()).map(String::from),
        });
    }
    out
}

fn vstr<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str())
}

/// BR#5911 (F2): the self-heal's stall fact, stamped onto the entry's
/// queue_facts payload. PRECONDITION: only called from the RerunGate arm —
/// the gate firing already proves the classification found ≥1 healable
/// deploy-health red, so `dispatched == 0` (every gh rerun attempt failed,
/// or the dispatch set resolved no run ids) is a loud contradiction: a
/// remediation reporting success while doing nothing (proactive-support:
/// a no-op loop ran 5h on PR #2707 logging "dispatched 0" every tick).
/// The hub panel and the starvation duty read the stamp off train.status;
/// the next walk's entries rebuild drops it (self-clearing on success).
fn self_heal_stall_fact(reds: usize, dispatched: usize, last_error: Option<&str>) -> Option<Value> {
    (dispatched == 0).then(|| {
        json!({
            "reds": reds,
            "dispatched": dispatched,
            "error": last_error.unwrap_or("(no run resolved — dispatch set was empty against a red verdict)"),
        })
    })
}

/// Lease renewal carries proof-of-progress (BR#4104): the last ledger action
/// this holder took and its age. The hub ignores the payload today — consuming
/// it (deny renewal on stale progress while the queue is non-empty) is the
/// filed hub-eviction follow-up. The seam is on the wire either way.
fn renew_lease(ctx: &mut Ctx, repo: &str, base: &str) -> bool {
    let progress = json!({
        "progress": ctx.last_action,
        "progress_age_ms": now_ms().saturating_sub(ctx.last_action_ms),
        "holder": ctx.holder,
    });
    ctx.train_lease(repo, base, "renew", json!({ "progress": progress, "merge_capable": true })).is_ok()
}

/// Release only when nothing is in flight; an awaiting-CI lane keeps the
/// lease so the next tick polls under the same holder.
fn release_if_idle(ctx: &mut Ctx, key: &str, repo: &str, base: &str) -> Result<(), String> {
    let st = ctx.mcp("train_status", json!({ "repo": repo }))?;
    let me = st.get("lanes").and_then(|l| l.as_array()).and_then(|ls| ls.iter().find(|l| vstr(l, "lane") == Some(key)));
    match me {
        Some(me) if me.get("currently").map(|c| c.is_null()).unwrap_or(true) => {
            let line_green = !me.get("stop").map(|s| !s.is_null()).unwrap_or(false);
            let r = ctx.train_lease(repo, base, "release", json!({ "line_green": line_green }))?;
            log(Some(key), &format!("lease released — {}", vstr(&r, "note").unwrap_or("idle")));
        }
        Some(_) => log(Some(key), "lease held — merge in flight, next tick renews + polls CI"),
        None => {}
    }
    Ok(())
}

/// BR#5376 method fallback: the repo refused a merge METHOD — retry the
/// remaining allowed methods (squash first), loud, and land the member.
/// The working method is remembered per-repo for the process so the batch's
/// next members go straight to it (no wasted refusal per member).
fn method_fallback_merge(ctx: &mut Ctx, key: &str, repo: &str, base: &str, pr: i64, head_sha: &str, refused_err: &str) -> Result<(), String> {
    let configured = ctx.method.clone();
    let candidates = merge_fallback_candidates(&configured, refused_merge_method(refused_err), true);
    let allowed = effective_merge_methods(ctx, repo, base)?;
    let mut last: Option<String> = None;
    for m in candidates {
        if !allowed.iter().any(|method| method.name() == m) { continue; }
        match ctx.sh("gh", &["pr", "merge", &pr.to_string(), "--repo", repo, method_flag_for(&m), "--match-head-commit", head_sha]) {
            Ok(_) => {
                ctx.note(&format!(
                    "merge-method fallback: repo refuses {} — landed PR #{pr} as {} (if unintended, check the repo/org merge-commit policy)",
                    configured, m
                ));
                log(Some(key), &format!("BR#5376 method fallback: {} refused → PR #{pr} landed via {}", configured, m));
                ctx.method_sub.insert(repo.to_string(), m);
                return Ok(());
            }
            Err(e) => {
                log(Some(key), &format!("method fallback {} refused PR #{pr}: {}", m, trunc(&e, 160)));
                last = Some(e);
            }
        }
    }
    Err(last.unwrap_or_else(|| "no merge method left to try".into()))
}

/// BR#5376: per-tick stall bookkeeping, called from `drive_lane` after the
/// inner walk returns (Ok or Err) with the tick's landing truth. Pure-state
/// update; the EVENT itself fires on the next walk under the lease
/// (`stall_fire_check` at the queue_facts stamp) — the lease is guaranteed
/// there, which the event handler requires.
fn stall_settle(ctx: &mut Ctx, key: &str) {
    let batch = std::mem::take(&mut ctx.tick_batch);
    let attempted = ctx.tick_attempted;
    let landed = ctx.tick_landed;
    let err = ctx.tick_error.clone().unwrap_or_default();
    let (next, _fire) = stall_next(ctx.stall.get(key), &batch, attempted, landed, &err, now_ms(), stall_alarm_ticks());
    match next {
        Some(st) => {
            log(
                Some(key),
                &format!(
                    "batch stall: {} member(s) selected, 0 landed, {} tick(s) this episode{}",
                    st.members.len(),
                    st.ticks,
                    if st.fired { " — alarm fired" } else { "" }
                ),
            );
            ctx.stall.insert(key.to_string(), st);
        }
        None => {
            if ctx.stall.remove(key).is_some() {
                log(Some(key), "stall episode cleared — the batch landed (or the lane stopped attempting)");
            }
        }
    }
}

/// BR#5376: fires the ONE-per-episode stalled event, under the walk's lease
/// (called right after the queue_facts stamp, before phase C), when the
/// tracker crossed the threshold on a previous settle. Returns the event
/// payload and marks the episode fired.
fn stall_fire_check(ctx: &mut Ctx, key: &str, repo: &str, base: &str) -> Option<Value> {
    let threshold = stall_alarm_ticks();
    let st = ctx.stall.get_mut(key)?;
    if st.fired || st.ticks < threshold {
        return None;
    }
    st.fired = true;
    Some(json!({
        "repo": repo, "base": base, "kind": "stalled",
        "pr": 0,
        "batch_members": st.members,
        "ticks": st.ticks,
        "since": st.since_ms,
        "last_error": st.last_error,
        "reason": format!("selected {} PR(s) to merge, landed 0 across {} tick(s) — likely executor breakage; restart the gateway onto the current build", st.members.len(), st.ticks),
    }))
}

/// BR#4977: is the lane's base branch gone from the remote? A 404 /
/// not-found from `gh api repos/<repo>/branches/<base>` is definitive (the
/// branch was deleted — the lane can never advance again); every other
/// failure is transient (gh absent, network, auth, no workdir) and fails
/// OPEN — the tick proceeds and the normal paths surface the error.
/// Gated by `ctx.base_probe` so tests stay hermetic.
fn base_missing_on_remote(ctx: &Ctx, repo: &str, base: &str) -> bool {
    if !ctx.base_probe {
        return false;
    }
    match ctx.sh("gh", &["api", &format!("repos/{repo}/branches/{base}"), "--jq", ".name"]) {
        Ok(_) => false,
        Err(e) => not_found_err(&e),
    }
}

/// The missing-branch classifier: 404 / "not found" in gh's error text is a
/// definitive no-such-branch; anything else is not a retirement signal.
fn not_found_err(e: &str) -> bool {
    let low = e.to_lowercase();
    low.contains("404") || low.contains("not found")
}

/// BR#5376 (hotfix P0, Ray directive 2026-11-01: "im still not convinced that
/// sp main is running… just says 'checking' — which doesnt take that long").
/// The receipt: state-vector/superpositional@main selected batches every
/// tick, attempted `gh pr merge --merge` every tick, and GitHub refused EVERY
/// attempt ("GraphQL: Merge commits are not allowed on this repository") from
/// 2026-10-30T11:30:23Z onward — 945+ consecutive attempts, logged to the
/// executor's local log only, ZERO hub events, while the lane read fake-busy
/// "checking review, signatures and CI" for days. Two laws close the class:
///
/// 1. LOUD STALL (this tracker): a batch that selects members and attempts
///    merges but lands NOTHING for `STALL_ALARM_TICKS` consecutive ticks
///    fires ONE "stalled" train event per episode — the hub renders the
///    STALLED lane/banner and files the one-per-episode alarm ask (the same
///    dedupe law as base-red, BR#5265).
/// 2. METHOD FALLBACK (`is_merge_method_refusal` + `method_fallback_merge`):
///    a merge-method refusal is a REPO POLICY mismatch, not a PR defect —
///    fall back to an allowed method (squash first, the standing sp law,
///    Ray 2026-10-30) and land the member instead of failing the tick.
const STALL_ALARM_TICKS_DEFAULT: u32 = 3;

/// Env override (`MERGE_TRAIN_STALL_TICKS`) for ops; clamped to ≥2 — a
/// single transient gh blip must never page a human.
fn stall_alarm_ticks() -> u32 {
    std::env::var("MERGE_TRAIN_STALL_TICKS")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .map(|v| v.max(2))
        .unwrap_or(STALL_ALARM_TICKS_DEFAULT)
}

/// One lane's batch-stall episode state.
#[derive(Clone, Debug, PartialEq)]
struct BatchStall {
    /// Consecutive land-0 ticks (batch non-empty + a merge attempt ran +
    /// nothing landed).
    ticks: u32,
    /// Episode start (ms epoch) — the display's "none landed in Xm".
    since_ms: u64,
    /// The batch members (landing order) as of the last land-0 tick.
    members: Vec<i64>,
    /// The error that ended the last land-0 tick (truncated) — the display
    /// says WHY, never a bare "stalled".
    last_error: String,
    /// true once the threshold event fired for THIS episode; resets only
    /// when the episode clears (any landing / a land-0-free tick).
    fired: bool,
}

/// The stall counter's transition law, pure for the fixture. Called once per
/// lane per tick (after the walk's landing leg settled, Ok or Err). A tick
/// counts as STALLED only when a batch was selected, a merge attempt ran,
/// and NOTHING landed — a lane that never attempts is idle, not stalled, and
/// any landing resets the episode (progress is the anti-alarm).
/// Returns the next state (None = no active episode) and whether the
/// threshold event should fire this tick.
fn stall_next(
    prev: Option<&BatchStall>,
    batch: &[i64],
    attempted: bool,
    landed: u32,
    last_error: &str,
    now_ms: u64,
    threshold: u32,
) -> (Option<BatchStall>, bool) {
    if batch.is_empty() || !attempted || landed > 0 {
        return (None, false);
    }
    let (ticks, since_ms, was_fired) = match prev {
        Some(p) => (p.ticks.saturating_add(1), p.since_ms, p.fired),
        None => (1, now_ms, false),
    };
    let fire = ticks >= threshold && !was_fired;
    (
        Some(BatchStall {
            ticks,
            since_ms,
            members: batch.to_vec(),
            last_error: trunc(last_error, 200),
            fired: was_fired || fire,
        }),
        fire,
    )
}

/// BR#5376: does this gh refusal name a MERGE METHOD the repo disallows?
/// Two eras of the same repo-policy refusal, both method mismatches:
/// - the classic repo-settings GraphQL answer "Merge commits are not allowed
///   on this repository." (squash/rebase variants exist), and
/// - the ruleset-era REST/gh answer "the base branch policy prohibits the
///   merge." (BR#6442/BR#6673: ruleset 24656303 "main: signed commits and
///   PRs" pins allowed_merge_methods to squash+rebase with no bypass, so
///   every `gh pr merge --merge` attempt is refused with that text — the
///   sp@main lane read fake-busy 22h+ while the queue starved because the
///   fallback never fired on this string).
/// Every other refusal is NOT a method mismatch.
fn is_merge_method_refusal(err: &str) -> bool {
    let low = err.to_lowercase();
    low.contains("not allowed on this repository")
        || low.contains("base branch policy prohibits the merge")
}

/// Which merge method did the refusal name? (Drives the fallback's skip.)
fn refused_merge_method(err: &str) -> Option<&'static str> {
    let low = err.to_lowercase();
    if low.contains("merge commit") {
        Some("merge")
    } else if low.contains("squash") {
        Some("squash")
    } else if low.contains("rebase") {
        Some("rebase")
    } else {
        None
    }
}

/// The fallback's method order: squash FIRST (the standing sp landing shape,
/// Ray 2026-10-30: "if it's still mergeable, go (squash merges)"), rebase
/// second, merge last. The just-refused method is skipped; the configured
/// method is skipped when the PRIMARY attempt itself was the refusal (it
/// already failed once — a second refused attempt is one wasted call).
fn merge_fallback_candidates(configured: &str, refused: Option<&str>, primary_refused: bool) -> Vec<String> {
    ["squash", "rebase", "merge"]
        .iter()
        .map(|m| m.to_string())
        .filter(|m| Some(m.as_str()) != refused)
        .filter(|m| !(primary_refused && m.as_str() == configured))
        .collect()
}

fn method_flag_for(m: &str) -> &'static str {
    match m {
        "squash" => "--squash",
        "rebase" => "--rebase",
        _ => "--merge",
    }
}

/// Effective branch rules can forbid a method even when the repository's
/// allow_merge_commit flag is true. Read policy BEFORE writing: gh's generic
/// "base branch policy prohibits the merge" does not identify a method.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MergeMethod {
    Squash,
    Rebase,
    Merge,
}

impl MergeMethod {
    fn name(self) -> &'static str {
        match self { Self::Squash => "squash", Self::Rebase => "rebase", Self::Merge => "merge" }
    }
}

fn policy_merge_methods(repo: &Value, rules: &Value, preferred: &str) -> Result<Vec<MergeMethod>, String> {
    let rules = rules.as_array().ok_or("Cannot read effective branch merge rules; holding merges")?;
    let mut allowed = vec![MergeMethod::Squash, MergeMethod::Rebase, MergeMethod::Merge];
    for (method, flag) in [(MergeMethod::Squash, "allow_squash_merge"), (MergeMethod::Rebase, "allow_rebase_merge"), (MergeMethod::Merge, "allow_merge_commit")] {
        let enabled = repo.get(flag).and_then(Value::as_bool).ok_or_else(|| format!("Cannot read repository {flag}; holding merges"))?;
        if !enabled { allowed.retain(|m| *m != method); }
    }
    for rule in rules {
        match vstr(rule, "type") {
            Some("required_linear_history") => allowed.retain(|m| *m != MergeMethod::Merge),
            Some("pull_request") => {
                if let Some(methods) = rule.pointer("/parameters/allowed_merge_methods") {
                    let methods = methods.as_array().ok_or("Cannot read allowed_merge_methods; holding merges")?;
                    allowed.retain(|m| methods.iter().any(|v| v.as_str() == Some(m.name())));
                }
            }
            _ => {}
        }
    }
    if allowed.is_empty() { return Err("No merge method satisfies the repository and effective branch rules; holding merges".into()); }
    // Honour configuration only within the policy intersection. Squash is
    // the first alternative, never an implicit admin/policy bypass.
    allowed.sort_by_key(|m| usize::from(m.name() != preferred));
    Ok(allowed)
}

fn effective_merge_methods(ctx: &Ctx, repo: &str, base: &str) -> Result<Vec<MergeMethod>, String> {
    let settings = ctx.gh_json(&["api", &format!("repos/{repo}")])?;
    let branch: String = base.bytes().map(|b| {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() }
        else { format!("%{b:02X}") }
    }).collect();
    let rules = ctx.gh_json(&["api", &format!("repos/{repo}/rules/branches/{branch}")])?;
    let preferred = ctx.method_sub.get(repo).unwrap_or(&ctx.method);
    policy_merge_methods(&settings, &rules, preferred)
}

/// BR#5252 — the merge-refusal fallback's decision law, pure so the fixture
/// locks it in both implementations (the `gh pr merge` refusal arm and the
/// settle-window probe). The refusal that reaches this fallback can be
/// PHANTOM (PR #332 episode, 2026-10-31: an out-of-date-shaped gh error on a
/// 0-behind MERGEABLE/CLEAN head), so the local ground truth — ancestry +
/// trial merge — outranks the gh error text:
/// - trial merge clean → the branch merges cleanly after all: the machine
///   update-branch leg (verdict carries, BR#3516 §5), merge next tick;
/// - not clean AND base tip ∉ head ancestry AND files enumerated → a real
///   conflict: bounce conflict-class with the file list (fail-closed stays);
/// - anything else → stale-or-infra garbage, NEVER a conflict bounce: a
///   file-less not-clean read is structurally impossible for a real text
///   conflict (`merge-tree --name-only` always lists paths), and a 0-behind
///   head (base tip ∈ head ancestry) is structurally conflict-free.
enum RefusalFallback {
    UpdateBranch,
    ConflictBounce,
    StaleOrInfra,
}

fn merge_refusal_fallback(zero_behind: bool, trial_clean: bool, conflict_files: &[String]) -> RefusalFallback {
    if trial_clean {
        RefusalFallback::UpdateBranch
    } else if !zero_behind && !conflict_files.is_empty() {
        RefusalFallback::ConflictBounce
    } else {
        RefusalFallback::StaleOrInfra
    }
}

/// One lane, one tick. Port of the former Node executor's driveLane.
fn drive_lane(ctx: &mut Ctx, lane: &Value) {
    let key = vstr(lane, "lane").unwrap_or("").to_string();
    let (repo, base) = key.split_once('@').map(|(r, b)| (r.to_string(), b.to_string())).unwrap_or_default();
    if repo.is_empty() || base.is_empty() {
        log(Some(&key), "malformed lane key (want repo@base) — skipping");
        return;
    }
    let required: Vec<String> = lane
        .get("required_workflows")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let typical_ms = lane.get("ci_typical_minutes").and_then(|v| v.as_u64()).unwrap_or(TRAIN_CI_TYPICAL_MINUTES) * 60_000;
    // BR#4934 lane config: the burst-drain cap per settle pass (0 = unlimited).
    let burst_cap = parse_burst_max(lane.get("burst_max").unwrap_or(&Value::Null));

    // ---- BR#4489 capability honesty: a host that cannot merge does not
    // contend the lock. Claiming without capability made the lane LOOK
    // served while nothing could advance (the 2026-10-29 outage). The check
    // re-probes gh on a ≤5-min cache at claim time; the skip logs on a
    // slow throttle so the reason stays visible without spamming. ----
    let capable = ctx.write_allowed();
    if !capable {
        ctx.note_skip_throttled(&key, "will not claim train lock as I cannot merge PRs (identity gate BR#3181 — bridge doctor names the fix)");
        return;
    }

    // ---- BR#4977 lane lifecycle: a lane whose base branch no longer exists
    // on the remote can never advance — a merge there is meaningless and the
    // lease stamps would keep a dead lane looking served. Skip WITHOUT
    // leasing (no hub meta writes). A 404 / not-found is definitive; any
    // other gh failure is transient — fail open and let the normal paths
    // surface it (a deleted base on a stopped lane already errors honestly
    // in the stop arm). ----
    if base_missing_on_remote(ctx, &repo, &base) {
        log(Some(&key), &format!("base branch `{base}` missing on the remote — lane retired, skipping (BR#4977)"));
        return;
    }

    // ---- CAS lease (the hub decides; a conflict means ANOTHER live executor).
    // holder is ALWAYS the authenticated actor (the hub stamps it). ----
    let lease = match ctx.train_lease(&repo, &base, "acquire", json!({ "required_workflows": required, "merge_capable": true })) {
        Ok(l) => l,
        Err(e) => {
            if e.contains("lane lease held live") {
                log(Some(&key), "lease held live elsewhere — standing down this tick");
            } else {
                log(Some(&key), &format!("tick error: {}", trunc(&e, 300)));
            }
            return;
        }
    };
    log(Some(&key), &format!("lease: {} (holder={})", vstr(&lease, "note").unwrap_or("acquired"), ctx.holder));

    // BR#5376: per-tick scratch reset — the inner walk fills, stall_settle
    // reads after it returns (Ok or Err).
    ctx.tick_batch.clear();
    ctx.tick_attempted = false;
    ctx.tick_landed = 0;
    ctx.tick_error = None;
    ctx.note(&format!("ticking {key}"));
    let result = drive_lane_inner(ctx, lane, &key, &repo, &base, typical_ms, burst_cap);
    // BR#5376: the tick's landing truth feeds the stall tracker BEFORE the
    // error path releases the lease. Pure state here; the EVENT fires on the
    // next walk under the lease (stall_fire_check at the queue_facts stamp).
    if let Err(e) = &result {
        ctx.tick_error = Some(e.clone());
    }
    stall_settle(ctx, &key);
    if let Err(e) = result {
        // BR#4489: a permission refusal mid-merge demotes the host for the
        // process lifetime — startup truth was runtime falsehood; fail closed.
        let low = e.to_lowercase();
        if low.contains("403") || low.contains("permission") || low.contains("not authorized") {
            ctx.demote("gh refused a merge write (403/permission)");
        }
        // fail-closed: the lease is released here (a demoted holder must not
        // keep the lane parked) and the next gateway reconciles from live
        // GitHub. Never retry-blind inside the tick.
        log(Some(&key), &format!("tick error: {}", trunc(&e, 300)));
        let _ = ctx.train_lease(&repo, &base, "release", json!({}));
        // The daemon leg must NEVER kill its host process (BR#4104): the
        // gateway keeps dispatching; the lease lapses; another gateway
        // reconciles. Only the standalone CLI exits nonzero on --once.
        if ctx.once && !ctx.in_process {
            std::process::exit(1);
        }
    }
}

/// BR#5190: the root-fix fast lane's stop carve-out condition — the DERIVED
/// queue's head is the bound root-fix card (the hub offers only tier 0 while
/// the base is red, so "head is the cure" == "a cure is in flight"). Only
/// then does the stopped lane fall through to the walk, so the gate can see
/// base red + the cure's head.
fn root_fix_head_under_stop(lane: &Value) -> bool {
    lane.get("queue")
        .and_then(|q| q.as_array())
        .map(|q| q.iter().any(|h| h.get("root_fix").and_then(|v| v.as_bool()).unwrap_or(false)))
        .unwrap_or(false)
}

/// BR#4996: one gate-clean queue head, classified in phase A of the drain
/// walk, eligible for phase B's batch selection and phase C's back-to-back
/// landing. Landing order is queue order (oldest-first).
struct BatchCandidate {
    qi: usize,
    head_id: String,
    pr: i64,
    head_sha: String,
    root_fix: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum IntegrationAdmission {
    Current,
    AwaitingCi { base_sha: String, head_sha: String },
    RepairDispatched,
}

fn admit_current_base(ctx: &mut Ctx, repo: &str, base: &str, cand: &BatchCandidate) -> Result<IntegrationAdmission, String> {
    let pr = cand.pr;
    let head = cand.head_sha.as_str();
    ctx.fetch_pr_head(pr)?;
    ctx.sh("git", &["fetch", "--quiet", "origin", base])?;
    let base_sha = ctx.sh("git", &["rev-parse", &format!("origin/{base}")])?.trim().to_string();
    if ctx.is_ancestor(&base_sha, head)? { return Ok(IntegrationAdmission::Current); }
    renew_lease(ctx, repo, base);
    let owned = branch_is_worker_authored(&ctx.pr_commit_logins(repo, pr), &ctx.worker_identities);
    let (clean, files) = ctx.trial_merge(base, head)?;
    if !clean || !owned {
        ctx.mcp("train_event", json!({ "repo": repo, "base": base, "kind": "bounced", "pr": pr,
            "task_id": cand.head_id, "head_sha": head, "bounce_kind": if clean { "gate" } else { "conflict" },
            "conflict_files": files, "reason": if clean {
                "Candidate has not been tested against current base; branch is not worker-authored. Repair executor must integrate current base and re-run CI."
            } else { "Current-base integration conflicts; resolve the named files and run fresh CI." } }))?;
        return Ok(IntegrationAdmission::RepairDispatched);
    }
    ctx.sh("gh", &["api", &format!("repos/{repo}/pulls/{pr}/update-branch"), "-X", "PUT", "-f", &format!("expected_head_sha={head}")])?;
    let updated = ctx.pr_facts(repo, pr)?;
    let to_head = vstr(&updated, "headRefOid").ok_or("Updated branch has no readable head")?;
    if to_head == head { return Err("Branch update accepted but new head not yet observable; hold for fresh CI".into()); }
    ctx.mcp("train_carry", json!({ "repo": repo, "base": base, "pr": pr, "from_head": head, "to_head": to_head }))?;
    Ok(IntegrationAdmission::AwaitingCi { base_sha, head_sha: to_head.into() })
}

// ---- BR#5633: the Awaiting-park sweep ---------------------------------
//
// The Awaiting park had NO machine exit: a card parked by a coverage
// bounce (hub train:bounced → awaiting_park) was never re-evaluated —
// the machine re-queue existed only at bounce-event time, so cars whose
// verdicts lapsed while the lane was blocked sat parked forever
// (bridge#364: 10 cars dead since Oct 30; the panel's aging/lapsed chips
// are render-only). The sweep re-asserts every parked card through the
// EXISTING audited bounce path with LIVE facts; the hub handler branches
// correctly for all three cases:
//   (a) accepted verdict covers the live head → machine re-queue (BR#5226)
//   (b) machine-clean lapse / head moved → impl bounce — the verify pool
//       re-verifies at the new head
//   (c) human-leg class (conflict files / dismissed review / signing env)
//       → stays parked (the hub classifies a re-asserted park on its
//       STORED defect/conflict files — the sweep reason is only a trigger
//       marker, deliberately free of the human-leg vocabulary)
// Verdict validity becomes head-anchored, not clock-anchored. Runs every
// tick BEFORE the stop arm: verdicts lapse exactly while the lane is
// stopped / settling — the states the walk never reaches.

/// One Awaiting-park entry as the hub's train.status serves it on the lane.
struct AwaitingPark {
    task: String,
    pr: i64,
}

/// The per-card sweep decision (pure — table-tested below).
#[derive(Debug, PartialEq)]
enum SweepAction {
    /// Re-assert the bounce through the audited hub path with live facts.
    Reassert {
        task: String,
        pr: i64,
        head_sha: String,
    },
    /// Leave the card this tick; the reason names whose path owns it.
    Skip {
        task: String,
        why: &'static str,
    },
}

fn awaiting_sweep_action(task: &str, pr: i64, facts: Result<&Value, &str>, last_sweep: Option<&Value>) -> SweepAction {
    let facts = match facts {
        Ok(f) => f,
        Err(_) => {
            // transient gh read — no stamp, the next tick retries
            return SweepAction::Skip { task: task.to_string(), why: "live facts unreadable — retry next tick" };
        }
    };
    if vstr(facts, "state").unwrap_or("") != "OPEN" {
        // MERGED/CLOSED — the landed/close path owns the card
        return SweepAction::Skip { task: task.to_string(), why: "PR not OPEN — the landed/close path owns it" };
    }
    let head = vstr(facts, "headRefOid").unwrap_or("").to_string();
    if head.is_empty() {
        return SweepAction::Skip { task: task.to_string(), why: "OPEN PR with no live head — fail closed, retry next tick" };
    }
    if let Some(last) = last_sweep {
        let same_head = last.get("head").and_then(|v| v.as_str()) == Some(head.as_str());
        let settled = last.get("outcome").and_then(|v| v.as_str()) == Some("awaiting_park");
        if same_head && settled {
            // a human-leg park re-asserted at an unchanged head re-parked
            // identically — one event per (card, head), never per tick
            return SweepAction::Skip { task: task.to_string(), why: "settled human-leg park at an unchanged head — rate-limited" };
        }
    }
    SweepAction::Reassert { task: task.to_string(), pr, head_sha: head }
}

/// The train_event payload a sweep re-assert emits — mirrors the executor's
/// real coverage-bounce shape (kind bounced + bounce_kind coverage + the
/// live head + the task). The reason is a trigger marker: it must carry NO
/// human-leg vocabulary (conflict files ride `conflict_files`, never prose;
/// "dismiss…review" / "signing environment" / "key unavailable" /
/// "NO_USER" would misclassify a re-asserted park).
fn awaiting_sweep_bounce_event(repo: &str, base: &str, task: &str, pr: i64, head_sha: &str) -> Value {
    json!({
        "repo": repo, "base": base, "kind": "bounced", "pr": pr, "task_id": task,
        "head_sha": head_sha, "bounce_kind": "coverage",
        "reason": "awaiting sweep: re-assert parked card with live facts (BR#5633)",
    })
}

/// Per-tick awaiting sweep (BR#5633) — see the block comment above.
/// Never fails the tick: per-card errors are logged and retried next tick.
fn awaiting_sweep(ctx: &mut Ctx, key: &str, repo: &str, base: &str, lane: &Value) {
    let parks: Vec<AwaitingPark> = lane
        .get("awaiting")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|e| {
            let task = e.get("task").and_then(|v| v.as_str())?.to_string();
            let pr = e.get("pr").and_then(|v| v.as_i64()).unwrap_or(0);
            Some(AwaitingPark { task, pr })
        })
        .filter(|p| p.pr > 0)
        .collect();
    if parks.is_empty() {
        return;
    }
    log(Some(key), &format!("awaiting sweep: {} parked card(s) (BR#5633)", parks.len()));
    let stamps = lane.get("awaiting_sweep").cloned().unwrap_or(json!({}));
    let mut asserted: Vec<(String, Value)> = Vec::new();
    for park in parks {
        let facts = ctx.pr_facts(repo, park.pr);
        let action = match &facts {
            Ok(f) => awaiting_sweep_action(&park.task, park.pr, Ok(f), stamps.get(park.task.as_str())),
            Err(e) => awaiting_sweep_action(&park.task, park.pr, Err(e.as_str()), stamps.get(park.task.as_str())),
        };
        let (task, pr, head) = match action {
            SweepAction::Reassert { task, pr, head_sha } => (task, pr, head_sha),
            SweepAction::Skip { task, why } => {
                log(Some(key), &format!("awaiting sweep: {task} PR #{} — {why}", park.pr));
                continue;
            }
        };
        renew_lease(ctx, repo, base);
        match ctx.mcp("train_event", awaiting_sweep_bounce_event(repo, base, &task, pr, &head)) {
            Ok(resp) => {
                let outcome = if resp.get("machine_requeue").and_then(|v| v.as_bool()).unwrap_or(false) {
                    "machine_requeue"
                } else if resp.get("awaiting_park").and_then(|v| v.as_bool()).unwrap_or(false) {
                    "awaiting_park"
                } else {
                    "impl_bounce"
                };
                log(Some(key), &format!("awaiting sweep: {task} PR #{pr} re-asserted at {} → {outcome}", &head[..head.len().min(9)]));
                ctx.note(&format!("awaiting sweep: {task} PR #{pr} → {outcome} (BR#5633)"));
                asserted.push((task, json!({ "head": head, "outcome": outcome, "at": now_ms() })));
            }
            Err(e) => {
                // no stamp — the refusal is loud here and the next tick retries
                log(Some(key), &format!("awaiting sweep: {task} re-assert refused — {} (retry next tick)", trunc(&e, 200)));
            }
        }
    }
    if asserted.is_empty() {
        return;
    }
    // one stamp op for the whole tick (the rate-limit ledger lives hub-side
    // — the executor is stateless across ticks by design). ABSENT entries
    // preserve the walk's stored queue blocks (the hub merges, BR#5633).
    let mut map = serde_json::Map::new();
    for (task, v) in asserted {
        map.insert(task, v);
    }
    if let Err(e) = ctx.mcp("train_queue_facts", json!({ "repo": repo, "base": base, "awaiting_sweep": Value::Object(map) })) {
        log(Some(key), &format!("awaiting sweep: rate-limit stamp failed — settled parks may re-assert next tick: {}", trunc(&e, 200)));
    }
}

fn lane_required_workflows(lane: &Value) -> Vec<String> {
    lane.get("required_workflows")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

fn has_rerun_request(lane: &Value) -> bool {
    lane.get("rerun_failed").filter(|v| !v.is_null()).is_some()
}

/// Extract the GitHub Actions workflow run ID from a check-run `html_url`
/// (`https://github.com/<owner>/<repo>/actions/runs/<run_id>/job/<job_id>`),
/// falling back to the last all-digit path segment when no `/runs/<id>` pair
/// is present.
fn extract_actions_run_id(url: &str) -> Option<i64> {
    let segs: Vec<&str> = url.split('/').filter(|s| !s.is_empty()).collect();
    for w in segs.windows(2) {
        if w[0] == "runs" && w[1].chars().all(|c| c.is_ascii_digit()) {
            if let Ok(id) = w[1].parse::<i64>() {
                return Some(id);
            }
        }
    }
    segs.iter()
        .rev()
        .find(|p| p.chars().all(|c| c.is_ascii_digit()))
        .and_then(|p| p.parse::<i64>().ok())
}

fn build_base_state(base_class: &CheckVerdict, required: &[String], pass_merged: u32) -> Value {
    let mut base_state = json!({
        // mid-drain (pass_merged > 0): destination-green is owned by the
        // pass settle (BR#4934) — only non-red unsettled/empty reads are
        // suppressed mid-burst; a RED base is ALWAYS reported as red so the
        // UI never lies that a red base is green.
        "verdict": if pass_merged > 0 && base_class.verdict != MainVerdict::Red {
            "green"
        } else {
            base_class.verdict.as_str()
        },
        "scoped_to_required": !required.is_empty(),
        "red": base_class.red.iter().map(|r| json!({ "name": r.name, "url": r.url })).collect::<Vec<_>>(),
        "unsettled": base_class.unsettled,
    });
    // BR#5674 P1 (empty-is-loud): annotate base_state with the alarm string
    // when the base verdict is empty (either N runs read with 0 matching
    // required_workflows, or 0 total runs on the tip).
    if pass_merged == 0 {
        if let Some(ref alarm) = base_class.alarm {
            base_state.as_object_mut().unwrap().insert("alarm".into(), json!(alarm));
        }
        // BR#5883 (gate-consumed qualifier): the scoped verdict reads green
        // but the repo's own merge gate (`main-green gate`, which judges
        // main's WHOLE tip) would judge it non-green — stamp the qualifier
        // whole so the hub escalates at P1 (immediate diagnostic duty +
        // one-per-episode ask) instead of the P4 starve clock, and the lane
        // vocabulary names the gate-blocking checks. Mid-drain the stamp
        // mirrors the gate's forced green (BR#4934) and omits the
        // qualifier — the pass settle owns destination-green.
        if let Some(ref gate) = base_class.gate {
            let obj = base_state.as_object_mut().unwrap();
            obj.insert("gate_blocked".into(), json!(true));
            obj.insert("gate_verdict".into(), json!(gate.verdict.as_str()));
            obj.insert(
                "gate_red".into(),
                json!(gate.red.iter().map(|r| json!({ "name": r.name, "url": r.url })).collect::<Vec<_>>()),
            );
            obj.insert("gate_unsettled".into(), json!(gate.unsettled));
        }
    }
    base_state
}

fn build_base_state_with_coverage(
    base_class: &CheckVerdict,
    required: &[String],
    pass_merged: u32,
    plan: Option<&DeployReconcilePlan>,
    cancelled_runs: &[i64],
) -> Value {
    let reconciled_class = match plan {
        Some(p) => reconcile_base_verdict_with_deploy_coverage(base_class, &p.coverage),
        None => base_class.clone(),
    };
    let mut base_state = build_base_state(&reconciled_class, required, pass_merged);
    if pass_merged == 0 {
        if let Some(p) = plan {
            let obj = base_state.as_object_mut().unwrap();
            let (tip_sha, tip_age_secs) = match &p.coverage {
                DeployCoverageState::Covered { tip_sha, tip_age_secs, .. }
                | DeployCoverageState::Settling { tip_sha, tip_age_secs, .. }
                | DeployCoverageState::UncoveredGrace { tip_sha, tip_age_secs, .. }
                | DeployCoverageState::UncoveredDispatched { tip_sha, tip_age_secs, .. }
                | DeployCoverageState::UncoveredDark { tip_sha, tip_age_secs, .. }
                | DeployCoverageState::Failed { tip_sha, tip_age_secs, .. } => (tip_sha.clone(), *tip_age_secs),
            };
            if !tip_sha.is_empty() {
                obj.insert("tip_sha".into(), json!(tip_sha));
                obj.insert("tip_age_secs".into(), json!(tip_age_secs));
                obj.insert("covered_by".into(), json!(p.covered_by_sha));
                obj.insert("coverage_age_secs".into(), json!(p.coverage_age_secs));
                if let Ok(cov_val) = serde_json::to_value(&p.coverage) {
                    obj.insert("deploy_coverage".into(), cov_val);
                }
            }
            if !cancelled_runs.is_empty() {
                obj.insert("cancelled_redundant_runs".into(), json!(cancelled_runs));
            }
        }
    }
    base_state
}

/// BR#6179 level-based deploy reconciler (A + B + D):
/// 1. Evaluates `reconcile_deploy_coverage` on `tip_sha`.
/// 2. (D) Cancels redundant queued deploy runs (`gh run cancel <id>`) when the
///    same `head_sha` is already covered by an `in_progress` or `completed/success`
///    deploy run (or duplicate queued runs).
/// 3. (A) Auto-dispatches `workflow_dispatch` (`gh workflow run <wf> --ref <base>`)
///    ONCE per `tip_sha` when the tip is uncovered past `DEPLOY_RECONCILE_GRACE_SECS`.
/// 4. (B) Returns the enriched `base_state` JSON carrying `deploy_coverage`,
///    `covered_by`, `coverage_age_secs`, and `cancelled_redundant_runs`.
fn reconcile_base_deploy(
    ctx: &mut Ctx,
    lane: &Value,
    key: &str,
    repo: &str,
    base: &str,
    tip_sha: &str,
    tip_age_secs: u64,
    base_class: &mut CheckVerdict,
    required: &[String],
    pass_merged: u32,
) -> Value {
    if tip_sha.is_empty() || !ctx.base_probe {
        return build_base_state(base_class, required, pass_merged);
    }
    let wf_runs = ctx.workflow_runs(repo, base, tip_sha);
    // Observation is not a merger action. Keep the hub's durable recovery
    // proof current on every normal base probe, including matching reruns.
    if pass_merged == 0 && tip_sha.len() == 40 {
        let reportable: Vec<&DeployWorkflowRun> = wf_runs.iter().filter(|r|
            crate::train_gate::is_deploy_workflow_run(r, required) && r.head_sha.len() == 40 && r.html_url.is_some()
        ).collect();
        if reportable.iter().any(|r| r.head_sha == tip_sha) {
            if let Err(e) = ctx.mcp("train_observe_deploy", json!({ "repo": repo, "base": base,
                "observation": { "tip_sha": tip_sha, "observed_at": now_ms(), "runs": reportable } })) {
                // 600 chars keeps the zod issue's `path` + `message` visible —
                // 200 cut the error inside the enum values list and hid the
                // failing field entirely during the 2026-11-05 incident.
                log(Some(key), &format!("deployment observation not accepted: {}", trunc(&e, 600)));
            }
        }
    }
    let auto_key = format!("{key}:{tip_sha}");
    let manual_redispatch = lane.get("dispatch_deploy").filter(|v| !v.is_null()).is_some();
    let hub_dispatched_at = if manual_redispatch {
        None
    } else {
        lane.get("deploy_dispatched")
            .filter(|d| d.get("sha").and_then(|v| v.as_str()) == Some(tip_sha))
            .and_then(|d| d.get("at").and_then(|v| v.as_u64()))
    };
    let already_dispatched = if manual_redispatch {
        None
    } else {
        hub_dispatched_at.or_else(|| ctx.auto_deploy_dispatched_shas.get(&auto_key).copied())
    };
    let mut plan = reconcile_deploy_coverage(
        tip_sha,
        tip_age_secs,
        DEPLOY_RECONCILE_GRACE_SECS,
        base_class,
        required,
        &wf_runs,
        already_dispatched,
    );
    let mut cancelled_ok: Vec<i64> = Vec::new();
    for &run_id in &plan.cancel_run_ids {
        if !ctx.cancelled_redundant_runs.contains(&run_id) {
            if ctx.sh("gh", &["run", "cancel", &run_id.to_string(), "--repo", repo]).is_ok() {
                ctx.cancelled_redundant_runs.insert(run_id);
                cancelled_ok.push(run_id);
                log(
                    Some(key),
                    &format!(
                        "deploy reconcile (D): cancelled redundant queued deploy run #{run_id} for already-covered sha {} (BR#6179)",
                        &tip_sha[..tip_sha.len().min(8)]
                    ),
                );
            }
        }
    }
    if pass_merged == 0 {
        if let Some(ref wf) = plan.dispatch_workflow.clone() {
            if ctx.sh("gh", &["workflow", "run", wf, "--repo", repo, "--ref", base]).is_ok() {
                let ts = now_ms();
                ctx.auto_deploy_dispatched_shas.insert(auto_key, ts);
                let (last_green_sha, last_green_run_id) = match &plan.coverage {
                    DeployCoverageState::UncoveredDark { last_green_sha, last_green_run_id, .. }
                    | DeployCoverageState::UncoveredGrace { last_green_sha, last_green_run_id, .. }
                    | DeployCoverageState::UncoveredDispatched { last_green_sha, last_green_run_id, .. }
                    | DeployCoverageState::Settling { last_green_sha, last_green_run_id, .. }
                    | DeployCoverageState::Failed { last_green_sha, last_green_run_id, .. } => {
                        (last_green_sha.clone(), *last_green_run_id)
                    }
                    DeployCoverageState::Covered { covered_by_sha, covered_by_run_id, .. } => {
                        (Some(covered_by_sha.clone()), *covered_by_run_id)
                    }
                };
                plan.coverage = DeployCoverageState::UncoveredDispatched {
                    tip_sha: tip_sha.to_string(),
                    tip_age_secs,
                    workflow: wf.clone(),
                    dispatched_at: ts,
                    last_green_sha,
                    last_green_run_id,
                };
                let summary = format_deploy_coverage_summary(&plan.coverage);
                ctx.note(&format!("self-heal: {summary}"));
                log(
                    Some(key),
                    &format!("deploy reconcile (A): {summary} on {base} (once per sha, BR#6179)"),
                );
            }
        }
    }
    *base_class = reconcile_base_verdict_with_deploy_coverage(base_class, &plan.coverage);
    build_base_state_with_coverage(base_class, required, pass_merged, Some(&plan), &cancelled_ok)
}

fn request_main_recovery_retry(ctx: &mut Ctx, lane: &Value, repo: &str, base: &str, head: &str) -> Option<Value> {
    let episodes = lane.pointer("/line/recoveries").and_then(Value::as_array)?;
    for view in episodes {
        let episode = view.get("episode")?;
        if vstr(episode, "head_sha") != Some(head) { continue; }
        let cause: crate::train_gate::RecoveryCause = serde_json::from_value(episode.get("cause")?.clone()).ok()?;
        if !matches!(cause, crate::train_gate::RecoveryCause::CheckFailure { .. }) { continue; }
        let stage = episode.get("stage")?;
        if !matches!(vstr(stage, "phase"), Some("diagnosing" | "repairing")) { continue; }
        let task = vstr(stage, "task_id")?;
        let attempt_id = format!("auto-main-retry:{head}");
        let command = json!({ "repo": repo, "base": base, "head_sha": head, "cause": cause,
            "event_id": format!("retry-request:{head}:{}", vstr(episode, "id").unwrap_or("")),
            "event": { "kind": "attempt_started", "task_id": task, "attempt_id": attempt_id,
                "attempt_kind": "retry", "action": "Re-run failed required workflows on main once",
                "next": "Read the actual rerun result; repeated failure requires diagnosis and repair" } });
        match ctx.mcp("train_recovery_event", command.clone()) {
            Ok(result) if result.get("authorized").and_then(Value::as_bool) == Some(true) => return Some(command),
            Ok(_) => log(None, "main retry not authorized: durable recovery budget or replay guard owns the next action"),
            Err(e) => log(None, &format!("main retry withheld: no durable authorization ({})", trunc(&e, 160))),
        }
    }
    None
}

fn drive_lane_inner(ctx: &mut Ctx, lane: &Value, key: &str, repo: &str, base: &str, _typical_ms: u64, burst_cap: u32) -> Result<(), String> {
    let required = lane_required_workflows(lane);
    // ---- 2026-11-02 BYPASS + RERUN legs (Ray: "I keep answering B and nothing
    // happens — it's broken"): the answered alarm ask IS the authority. The
    // hub's askAnswer stamps `meta.lane.bypass_merge {pr}` (a BYPASS answer on
    // the base-red alarm ask — the option carries the cure PR's number — or
    // "Merge the cure now" on the root-fix fast-lane ask) and
    // `meta.lane.rerun_failed` (a RETRY answer). Nothing consumed them before:
    // the answer was recorded, the question closed, and the next red tick
    // filed a fresh identical ask — the human answered B forever in a loop.
    //
    // bypass: merge the named PR OUT OF TURN, ahead of the queue, onto the
    // red/stopped base. This is the circular cure's ONLY machine path: its own
    // deploy-health check can never pass while the line it fixes is held, so
    // the normal gate would refuse it forever. Runs BEFORE the stop arm for
    // exactly that reason. The merged event carries `bypass: true` so
    // provenance shows the lane was cured by an answered ask, and the ack
    // (bypass_consumed) rides the queue_facts stamp.
    //
    // rerun: re-run the base tip's failing checks (`gh run rerun`) — a
    // transient red (internet weather, flaky check) clears on the next run.
    // Both stamps are consumed + acked through queue_facts, one per episode. ----
    let bypass_pr = lane
        .get("bypass_merge")
        .and_then(|b| b.get("pr"))
        .and_then(|v| v.as_i64())
        .filter(|p| *p > 0);
    let rerun_requested = has_rerun_request(lane);
    if let Some(bpr) = bypass_pr {
        renew_lease(ctx, repo, base);
        let facts = ctx.pr_facts(repo, bpr);
        let ack = |ctx: &mut Ctx, outcome: &str| -> Result<(), String> {
            ctx.mcp(
                "train_queue_facts",
                json!({ "repo": repo, "base": base, "bypass_consumed": outcome }),
            )
            .map(|_| ())
        };
        match facts.as_ref().map(|f| {
            (
                vstr(f, "state").unwrap_or("").to_string(),
                f.pointer("/mergeCommit/oid").and_then(|v| v.as_str()).map(String::from),
                vstr(f, "headRefOid").unwrap_or("").to_string(),
            )
        }) {
            Ok((state, Some(merge_sha), head_sha)) if state == "MERGED" => {
                // BR#6390: the human merged it themselves (the HUMAN GATE's
                // DONE) — stamp the merged event so the lane settles on the
                // cure (awaiting-ci on this sha, provenance, the episode
                // phase flips to cure_pr_merged_awaiting_ci and any straggler
                // ask auto-closes). Consuming the stamp WITHOUT the event left
                // external merges invisible to the episode state.
                ctx.tick_landed += 1;
                ctx.mcp(
                    "train_event",
                    json!({
                        "repo": repo, "base": base, "kind": "merged", "pr": bpr,
                        "merge_sha": merge_sha, "head_sha": head_sha,
                        "signer": ctx.holder, "bypass": true,
                        "reason": "bypass-merge (merged-elsewhere) — the human landed the cure out of turn via the answered HUMAN GATE ask; stamping the merged event so the lane settles on it",
                    }),
                )?;
                ack(ctx, "merged-elsewhere")?;
                ctx.note(&format!("bypass: PR #{bpr} already MERGED by the human ({}) — merged event stamped, authorization consumed", &merge_sha[..merge_sha.len().min(9)]));
                log(Some(key), &format!("bypass: PR #{bpr} already merged by the human as {} — merged event stamped, stamp consumed", &merge_sha[..merge_sha.len().min(9)]));
            }
            Ok((state, _, _)) if state == "CLOSED" => {
                ack(ctx, "closed")?;
                log(Some(key), &format!("bypass: PR #{bpr} is CLOSED — authorization consumed (nothing to merge)"));
            }
            Ok((_, _, head_sha)) => {
                // BR#6390 DONE grace: the human clicked DONE ("I merged it") —
                // GitHub may lag the click by seconds, or the click landed a
                // hair early. Give the authorization a 10-minute window where
                // the tick only WATCHES (no merge attempt, stamp kept); the
                // next tick after the merge lands takes the MERGED arm above.
                // Past the window, the pre-existing behavior applies: try the
                // machine merge (plain, then --admin), else consume with the
                // needs-human receipt.
                let stamped_at = lane
                    .pointer("/bypass_merge/at")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                let grace_ms = 10 * 60 * 1000i64;
                if stamped_at > 0 && (now_ms() as i64 - stamped_at) < grace_ms {
                    ctx.note(&format!("bypass: PR #{bpr} authorized (DONE) — watching for the human's merge (stamp held, grace {}s left)", ((grace_ms - (now_ms() as i64 - stamped_at)) / 1000).max(0)));
                    log(Some(key), &format!("bypass: PR #{bpr} authorized (DONE) and still open — holding the stamp inside the 10m DONE grace; no merge attempt this tick"));
                } else {
                // open: land it out of turn with the BR#5376 method fallback
                // (squash → rebase → merge, remembered per repo) — a policy
                // mismatch must ride the landing path, not loop.
                let methods: Vec<String> = effective_merge_methods(ctx, repo, base)?.iter().map(|m| m.name().to_string()).collect();
                let mut landed_sha: Option<String> = None;
                let mut refusal: Option<String> = None;
                ctx.tick_attempted = true;
                for m in &methods {
                    match ctx.sh("gh", &["pr", "merge", &bpr.to_string(), "--repo", repo, method_flag_for(m)]) {
                        Ok(_) => {}
                        Err(e) => {
                            if is_merge_method_refusal(&e) {
                                refusal = Some(e);
                                continue;
                            }
                            // BR#6012: branch protection refuses plain `gh pr merge` on a
                            // circular red-base gate (`BLOCKED`). Try `--admin` in case the
                            // gateway token holds admin; if not, report that human `--admin`
                            // is required instead of pretending the machine could bypass.
                            match ctx.sh("gh", &["pr", "merge", &bpr.to_string(), "--repo", repo, method_flag_for(m), "--admin"]) {
                                Ok(_) => {}
                                Err(admin_err) => {
                                    if is_merge_method_refusal(&admin_err) {
                                        refusal = Some(admin_err);
                                        continue;
                                    }
                                    refusal = Some(format!("{e} (--admin also refused: {admin_err})"));
                                    break; // non-method refusal: branch protection et al — never loop
                                }
                            }
                        }
                    }
                    // claimed ok — verify from live facts, never trust the exit code
                    if let Ok(f2) = ctx.pr_facts(repo, bpr) {
                        if let Some(oid) = f2.pointer("/mergeCommit/oid").and_then(|v| v.as_str()) {
                            landed_sha = Some(oid.to_string());
                        }
                    }
                    if landed_sha.is_some() {
                        ctx.method_sub.insert(repo.to_string(), m.clone());
                        break;
                    }
                }
                match landed_sha {
                    Some(merge_sha) => {
                        ctx.tick_landed += 1;
                        ctx.mcp(
                            "train_event",
                            json!({
                                "repo": repo, "base": base, "kind": "merged", "pr": bpr,
                                "merge_sha": merge_sha, "head_sha": head_sha,
                                "signer": ctx.holder, "bypass": true,
                                "reason": "bypass-merge — human-authorized out-of-turn merge (the answered alarm ask); the circular cure lands ahead of the queue",
                            }),
                        )?;
                        ack(ctx, "merged")?;
                        ctx.note(&format!("bypass: PR #{bpr} merged out of turn ({}) — authorization consumed", &merge_sha[..merge_sha.len().min(9)]));
                        log(Some(key), &format!("bypass: PR #{bpr} MERGED out of turn as {} — the answered ask landed the cure", &merge_sha[..merge_sha.len().min(9)]));
                    }
                    None => {
                        let why = refusal.unwrap_or_else(|| "gh pr merge reported ok but no mergeCommit — DO NOT trust this tick".into());
                        ack(ctx, &format!("refused (needs human --admin: gh pr merge {bpr} --repo {repo} --admin --squash): {}", trunc(&why, 160)))?;
                        log(Some(key), &format!("bypass: PR #{bpr} merge refused — needs human --admin (`gh pr merge {bpr} --repo {repo} --admin --squash`), reason on the lane card: {}", trunc(&why, 160)));
                    }
                }
                }
            }
            Err(e) => {
                log(Some(key), &format!("bypass: PR #{bpr} facts unreadable — retrying next tick: {}", trunc(&e, 200)));
            }
        }
    }
    if rerun_requested {
        renew_lease(ctx, repo, base);
        let base_sha = ctx.sh("gh", &["api", &format!("repos/{repo}/commits/{base}"), "--jq", ".sha"])?;
        let v = classify_base_check_runs(&ctx.check_runs(repo, &base_sha), &required);
        // the red verdict carries urls (`…/actions/runs/<id>/job/<job_id>`) — rerun by workflow run id
        let reds: Vec<(i64, &str)> = v
            .red
            .iter()
            .filter_map(|r| {
                let id = extract_actions_run_id(&r.url)?;
                Some((id, r.name.as_str()))
            })
            .collect();
        if reds.is_empty() {
            let _ = ctx.mcp("train_queue_facts", json!({ "repo": repo, "base": base, "rerun_consumed": "nothing-red" }));
            log(Some(key), "rerun: nothing red on the base tip — stamp consumed");
        } else {
            let mut rerun_ok = 0;
            for (id, name) in &reds {
                if ctx.sh("gh", &["run", "rerun", &id.to_string(), "--repo", repo]).is_ok() {
                    rerun_ok += 1;
                } else {
                    log(Some(key), &format!("rerun: gh run rerun {id} ({name}) failed — partial"));
                }
            }
            let outcome = if rerun_ok == reds.len() { "issued".to_string() } else { format!("partial: {rerun_ok}/{}", reds.len()) };
            let _ = ctx.mcp("train_queue_facts", json!({ "repo": repo, "base": base, "rerun_consumed": outcome }));
            log(Some(key), &format!("rerun: re-ran {} failing check(s) on the base tip — stamp consumed ({outcome})", reds.len()));
        }
    }
    // ---- BR#5633 awaiting-park sweep: every parked card gets its machine
    // exit EVERY tick, before any arm that can return early — verdicts
    // lapse exactly while the lane is stopped / mid-settle, the states the
    // walk never reaches (bridge#364: 10 cars parked dead since Oct 30).
    // See the block comment at awaiting_sweep for the three hub outcomes. ----
    awaiting_sweep(ctx, key, repo, base, lane);

    // ---- stop-the-line arm: main is RED and the lane is stopped ----
    if !lane.get("stop").map(|s| s.is_null()).unwrap_or(true) {
        let stop = lane.get("stop").unwrap();
        let stop_sha = vstr(stop, "sha").unwrap_or("");
        log(Some(key), &format!("line stopped — {} @ {}", vstr(stop, "reason").unwrap_or("?"), &stop_sha[..stop_sha.len().min(9)]));
        let (base_sha, base_age_secs) = ctx.base_tip_facts(repo, base)?;
        let base_runs = ctx.check_runs(repo, &base_sha);
        let mut v = classify_base_check_runs(&base_runs, &required);
        let observed = reconcile_base_deploy(ctx, lane, key, repo, base, &base_sha, base_age_secs, &mut v, &required, 0);
        let _ = ctx.mcp("train_queue_facts", json!({ "repo": repo, "base": base, "base_state": observed }));
        if v.verdict == MainVerdict::Green {
            renew_lease(ctx, repo, base);
            ctx.train_lease(repo, base, "release", json!({ "line_green": true }))?;
            log(Some(key), "main green again — stop cleared, lane released");
            return Ok(());
        }
        // BR#5190 root-fix fast lane: while the line holds, a bound root-fix
        // card at the queue head falls through to the walk below — the gate
        // sees base red + the cure's head and either fast-tracks the merge
        // (head green) or opens the human fast-lane ask (the circular
        // deploy-health class). Without this carve-out the stop arm returned
        // before the queue walk, so the fast lane was unreachable exactly
        // when it mattered. The bisect walk is PARKED while the cure is in
        // flight — its state lives hub-side (stop.bisect) and resumes once
        // the fix lands or the head stops being the cure.
        if root_fix_head_under_stop(lane) {
            log(Some(key), "root-fix card heads the queue — fast lane under stop: falling through to the walk (bisect parked, BR#5190)");
        } else {
            // BR#4934 red-settle bisect: a burst stop pre-stamps stop.bisect —
            // drive the walk ONE step per tick while the line holds (state
            // hub-side, crash-safe: any executor picks it up mid-flight).
            match bisect_step(ctx, key, repo, base, stop, &required) {
                Ok(()) => {}
                Err(e) => log(Some(key), &format!("bisect step error: {}", trunc(&e, 200))),
            }
            // Rapid self-heal on a non-bisect red stop: auto-rerun failing
            // required workflow runs ONCE per (lane, base_sha) so transient/race
            // failures (e.g. Post-Deploy Smoke 300s race) heal automatically.
            let has_bisect = stop.get("bisect").filter(|b| !b.is_null()).is_some();
            let auto_key = format!("{key}:{base_sha}");
            if v.verdict == MainVerdict::Red && !has_bisect && !rerun_requested && !base_sha.is_empty() && !ctx.auto_rerun_shas.contains(&auto_key) {
                ctx.auto_rerun_shas.insert(auto_key);
                let retry = request_main_recovery_retry(ctx, lane, repo, base, &base_sha);
                let mut auto_rerun_ok = 0usize;
                let mut seen_run_ids = HashSet::new();
                for r in &v.red {
                    if retry.is_none() { break; }
                    if let Some(run_id) = extract_actions_run_id(&r.url) {
                        if !seen_run_ids.insert(run_id.clone()) { continue; }
                        if ctx.sh("gh", &["run", "rerun", &run_id.to_string(), "--repo", repo]).is_ok() {
                            auto_rerun_ok += 1;
                        }
                    }
                }
                if let Some(mut command) = retry {
                    let attempt_id = command.pointer("/event/attempt_id").cloned().unwrap_or(Value::Null);
                    let task_id = command.pointer("/event/task_id").cloned().unwrap_or(Value::Null);
                    command["event_id"] = json!(format!("auto-retry-result:{base_sha}"));
                    command["event"] = json!({ "kind": "attempt_finished", "task_id": task_id, "attempt_id": attempt_id,
                        "outcome": if auto_rerun_ok > 0 { "delivered" } else { "failed" },
                        "summary": format!("Dispatched {auto_rerun_ok} required-workflow rerun(s); recovery not yet verified"),
                        "receipts": [], "next": "Observe the actual workflow result; diagnose and repair if the same cause remains" });
                    if let Err(e) = ctx.mcp("train_recovery_event", command) { log(Some(key), &format!("recovery outcome recording failed: {}", trunc(&e, 200))); }
                }
                if auto_rerun_ok > 0 {
                    log(Some(key), &format!("self-heal: auto-dispatched rerun for {auto_rerun_ok} failing required workflow(s) on stopped tip {}", &base_sha[..base_sha.len().min(9)]));
                }
            }
            // BR#6012 stopped-lane self-healing & live base_state refresh:
            // (a) Keep queue_facts.base_state fresh while stopped so the UI banner
            //     reflects live failing/pending checks instead of a stale stop.failing
            //     snapshot from hours ago. When base_sha reads Empty (e.g. a hotfix
            //     merged onto main and its deploy workflow is queued behind stop_sha's
            //     concurrency lock), fall back to stop_sha's live check-runs.
            // (b) Run settle_window_rebase over the held queue so any queued PR that
            //     became CONFLICTING against moved main (e.g. PR #2800 after #2817)
            //     is immediately trial-merged and bounced (`kind: "bounced"`,
            //     `bounce_kind: "conflict"`, `conflict_files`) — the hub parks it
            //     TYPED conflicting (BR#6348: queue-visible, bounded budget, loud
            //     alarm at expiry; the mechanical rebase leg owns the exit) instead
            //     of churning it through the pool.
            if ctx.base_probe {
                let mut effective_v = if v.verdict == MainVerdict::Empty && !stop_sha.is_empty() && stop_sha != base_sha {
                    let stop_runs = ctx.check_runs(repo, stop_sha);
                    let sv = classify_base_check_runs(&stop_runs, &required);
                    if sv.verdict != MainVerdict::Empty { sv } else { v.clone() }
                } else {
                    v.clone()
                };
                let live_base_state = reconcile_base_deploy(ctx, lane, key, repo, base, &base_sha, base_age_secs, &mut effective_v, &required, 0);
                let _ = ctx.mcp("train_queue_facts", json!({ "repo": repo, "base": base, "base_state": live_base_state }));
                let _ = settle_window_rebase(ctx, key, repo, base, lane);
            }
            let reds = v.red.iter().map(|r| r.name.as_str()).collect::<Vec<_>>().join(", ");
            let hold_msg = format!("main still {}{} — holding", v.verdict.as_str(), if reds.is_empty() { String::new() } else { format!(" (red: {reds})") });
            ctx.note(&hold_msg);
            renew_lease(ctx, repo, base);
            log(Some(key), &hold_msg);
            return Ok(());
        }
    }

    // ---- post-stop residue: the stop cleared (main green again) but the
    // in-flight record is the broken merge commit — never poll it toward a
    // landing. The culprit card was bounced at stop time; lane is idle.
    // BR#5190: runs ONLY when the stop is actually gone — a live stop that
    // fell through above (root-fix head) must not read as residue. ----
    if lane.get("stop").map(|s| s.is_null()).unwrap_or(true)
        && lane.pointer("/currently/phase").and_then(|p| p.as_str()) == Some("stopped")
    {
        log(Some(key), "stop cleared — stale in-flight record; lane idle (culprit card re-enters via verify)");
        release_if_idle(ctx, key, repo, base)?;
        return Ok(());
    }

    // ---- awaiting-CI arm: poll the merge commit, HUB decides ----
    if lane.pointer("/currently/phase").and_then(|p| p.as_str()) == Some("awaiting-ci") {
        let cur = lane.get("currently").unwrap();
        let cur_pr = cur.get("pr").and_then(|v| v.as_i64()).unwrap_or(0);
        let merge_sha = cur.get("merge_sha").and_then(|v| v.as_str()).unwrap_or("").to_string();
        // reconcile first: the recorded merge sha must actually be on base —
        // a lane that says merged for a sha git can't find is a crashed
        // executor's half-truth; bounce the card instead of polling forever.
        ctx.sh("git", &["fetch", "--quiet", "origin", base])?;
        // BR#3935: a locally-unreadable ancestry (bad object, shallow clone)
        // must not fake "not on base" — it defers to the reconcile below,
        // which double-checks live pr_facts before bouncing or recovering.
        let on_base = !merge_sha.is_empty() && ctx.is_ancestor(&merge_sha, &format!("origin/{base}")).unwrap_or(false);
        if !on_base {
            renew_lease(ctx, repo, base);
            let facts = ctx.pr_facts(repo, cur_pr).ok();
            if facts.as_ref().and_then(|f| vstr(f, "state")) != Some("MERGED") {
                ctx.mcp("train_event", json!({ "repo": repo, "base": base, "kind": "bounced", "pr": cur_pr, "task_id": cur.get("task_id").filter(|v| !v.is_null()), "reason": "reconcile: the lane's recorded merge never landed on base (executor crashed mid-merge) — fix-forward and re-queue" }))?;
                ctx.note(&format!("reconcile: bounced PR #{cur_pr} (recorded merge never landed on {base})"));
                log(Some(key), &format!("reconcile: recorded merge {} not on base — PR #{cur_pr} bounced", &merge_sha[..merge_sha.len().min(9)]));
                return Ok(());
            }
            // merged on GitHub but the event never fired — recover by stamping now
            ctx.mcp("train_event", json!({ "repo": repo, "base": base, "kind": "merged", "pr": cur_pr, "merge_sha": facts.as_ref().and_then(|f| f.pointer("/mergeCommit/oid")).and_then(|v| v.as_str()).unwrap_or(&merge_sha), "head_sha": facts.as_ref().and_then(|f| vstr(f, "headRefOid")), "task_id": cur.get("task_id").filter(|v| !v.is_null()), "signer": ctx.holder, "reason": "reconcile: merge happened but the train event was lost — stamped from live GitHub" }))?;
            ctx.note(&format!("reconcile: stamped lost merged event for PR #{cur_pr}"));
            log(Some(key), &format!("reconcile: PR #{cur_pr} merged on GitHub, event recovered"));
        }
        renew_lease(ctx, repo, base);
        let mut runs = ctx.check_runs(repo, &merge_sha);
        if ctx.base_probe {
            if let Ok((live_base_sha, live_base_age_secs)) = ctx.base_tip_facts(repo, base) {
                let live_runs = if live_base_sha == merge_sha {
                    runs.clone()
                } else {
                    ctx.check_runs(repo, &live_base_sha)
                };
                let mut live_base_class = classify_base_check_runs(&live_runs, &required);
                let live_base_state = reconcile_base_deploy(ctx, lane, key, repo, base, &live_base_sha, live_base_age_secs, &mut live_base_class, &required, 0);
                let _ = ctx.mcp("train_queue_facts", json!({ "repo": repo, "base": base, "base_state": live_base_state }));
                // If merge_sha's own runs are all completed with a cancelled required run
                // or missing/startup_failure required runs (superseded because a hotfix
                // live_base_sha was pushed on top of merge_sha), judge the settle from
                // live_base_sha's runs instead of hanging on merge_sha.
                let proven_descendant = live_base_sha != merge_sha && ctx.is_ancestor(&merge_sha, &live_base_sha).unwrap_or(false);
                if settle_from_descendant_ci(proven_descendant, &runs, &required) {
                    runs = live_runs;
                }
            }
        }
        // BR#4934: the settle feed carries executor-fed git ancestry — the
        // pass's earlier merge shas verified on base — so the hub can close
        // the pass's parked cards on a green verdict (BR#3516: no hub
        // GitHub calls; BR#3935: unreadable shas are excluded, never faked).
        let mut ci_body = json!({ "repo": repo, "base": base, "sha": merge_sha, "checks": runs });
        let ancestors = settle_ancestors(ctx, repo, base, &merge_sha)?;
        if !ancestors.is_empty() {
            ci_body.as_object_mut().unwrap().insert("ancestors_of_settled".into(), json!(ancestors));
        }
        let ci = ctx.mcp("train_ci", ci_body)?;
        ctx.note(&format!("CI poll on {}: {}", &merge_sha[..merge_sha.len().min(9)], vstr(&ci, "decided").unwrap_or("?")));
        let pend = ci.get("pending").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default();
        let missing = ci.get("missing").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default();
        log(
            Some(key),
            &format!(
                "CI poll on {}: {}{}{}",
                &merge_sha[..merge_sha.len().min(9)],
                vstr(&ci, "decided").unwrap_or("?"),
                if pend.is_empty() { String::new() } else { format!(" (pending: {pend})") },
                if missing.is_empty() { String::new() } else { format!(" (missing: {missing})") }
            ),
        );
        if vstr(&ci, "decided") == Some("pending") {
            let merged_at = cur.get("merged_at").and_then(|v| v.as_u64()).unwrap_or_else(now_ms);
            let left = (TRAIN_CI_TYPICAL_MINUTES * 3 * 60_000) as i128 - (now_ms() as i128 - merged_at as i128);
            if left > 0 {
                log(Some(key), &format!("fail-closed bound in ~{}m", (left / 60_000).max(1)));
            }
            let cur_merged = cur.get("burst_merged").and_then(|v| v.as_u64()).unwrap_or(1).min(u32::MAX as u64) as u32;
            let cur_task = vstr(cur, "task_id").unwrap_or("");
            let has_other_queued = lane
                .get("queue")
                .and_then(|q| q.as_array())
                .map(|q| q.iter().any(|item| vstr(item, "id").unwrap_or("") != cur_task && item.get("pr").and_then(|v| v.as_i64()) != Some(cur_pr)))
                .unwrap_or(false);
            if (burst_cap == 0 || cur_merged < burst_cap) && has_other_queued {
                log(Some(key), &format!("awaiting-ci with batch slot open ({cur_merged}/{}) — checking remaining queued PRs to merge into this batch before settling CI", if burst_cap == 0 { "∞".to_string() } else { burst_cap.to_string() }));
            } else {
                settle_window_rebase(ctx, key, repo, base, lane)?;
                return Ok(());
            }
        } else {
            // BR#4934 §6: the settle wait is the rebase window — ONE machine-clean
            // update-branch per tick on the first behind+covered queued head, so
            // conflicts surface during the wait, not at the drain.
            settle_window_rebase(ctx, key, repo, base, lane)?;
            return Ok(());
        }
    }

    // ---- drain arm (idle, or mid-pass "bursting"): THREE phases (BR#4996,
    // Ray ruling 2026-10-29, amending the BR#4934 burst-drain). PHASE A
    // classifies the whole derived queue IN ORDER without landing anything:
    // gate-clean heads become batch candidates; Skip/Note entries are
    // skipped past (a transient no-op no longer settles the pass or ends
    // the walk); Bounce / HumanLeg / CloseSuperseded still fire ON SIGHT
    // and end the tick. PHASE B selects the batch: the maximal set of
    // MUTUALLY non-conflicting candidates (select_batch — file-set
    // intersection, merge-tree-confirmed, BR#3935 fail-closed; queue order
    // = landing order, oldest-first; burst_max caps the batch). PHASE C
    // lands the batch back-to-back with NO settle between members — the
    // per-member merge leg law is unchanged — and the pass runs exactly
    // ONE settle wait, on the FINAL merge commit. The pass state is the
    // HUB's (currently.phase/​burst_*), never executor-local — crash-safe.
    // A PERMANENTLY unlandable entry must NOT starve the lane (BR#3935): a
    // leg with no PR stamp is BOUNCED off the hub — the card leaves the
    // derived queue that tick (BR#5753, the self-heal); a CLOSED PR or an
    // entry with no unlanded leg on this lane is logged and classification
    // advances to the next entry. A red
    // pass sha (tip classify, re-checked before EACH member) stops the
    // line IMMEDIATELY (GH#2261) — it never waits for the settle; earlier
    // pass-sha reds surface at the settle (and its bisect, if the settle
    // lands red). A merge refused mid-batch soft-breaks: the landed prefix
    // settles, the refused member waits for the next pass (a fresh pass —
    // pass_merged == 0 — keeps the loud tick error).
    let cur = lane.get("currently").filter(|c| !c.is_null());
    let cur_phase = lane.pointer("/currently/phase").and_then(|p| p.as_str());
    let from_awaiting_ci = cur_phase == Some("awaiting-ci");
    let bursting = cur_phase == Some("bursting") || from_awaiting_ci;
    let mut pass_merged: u32 = if bursting {
        cur.and_then(|c| c.get("burst_merged")).and_then(|v| v.as_u64()).unwrap_or(if from_awaiting_ci { 1 } else { 0 }).min(u32::MAX as u64) as u32
    } else {
        0
    };
    let initial_pass_merged = pass_merged;
    let mut tip_sha: String = if bursting {
        cur.and_then(|c| c.get("merge_sha")).and_then(|v| v.as_str()).unwrap_or("").to_string()
    } else {
        String::new()
    };
    let queue = lane.get("queue").and_then(|q| q.as_array()).cloned().unwrap_or_default();
    // BR#5114: per-entry gate verdicts in walk (rank) order — stamped onto
    // the lane at the end of the walk; the panel renders them as the queue
    // block row (ready blocks = the current batch, Ray 2026-10-30: "we
    // merge what we can in batches").
    let mut qfacts: Vec<serde_json::Value> = Vec::new();
    if queue.is_empty() {
        if pass_merged > 0 {
            // a bursting lane with an empty queue still owes its settle —
            // all pass heads merged, nothing clean left behind them
            burst_settle_feed(ctx, key, repo, base, &tip_sha, pass_merged)?;
            return Ok(());
        }
        release_if_idle(ctx, key, repo, base)?;
        return Ok(());
    }
    let mut candidates: Vec<BatchCandidate> = Vec::new();
    // BR#5265 Fix B + Fix A: ONE base read per walk, hoisted before the
    // loop (the old lazy base_cache re-fetched per gate-reaching entry —
    // same values, wasted calls) — classified SCOPED to the lane's
    // required workflows when configured (Fix B: nightly/battery reds
    // never park the train), and stamped whole into the queue_facts
    // payload (Fix A) so the hub renders a loud BLOCKED lane + files the
    // ONE-per-episode human alarm ask while cars are held.
    let required: Vec<String> = lane
        .get("required_workflows")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let (probed_base_sha, probed_base_age_secs, mut base_class) = if !ctx.base_probe {
        // BR#5265 fix-up (verify bounce, CI run 41261611797 — the PR's own
        // drills failed in CI): the hoisted read is HERMETIC — the drills
        // (base_probe=false) never shell out to gh; the Unsettled stamp
        // names why. In production it also DEGRADES instead of erroring:
        // a gh flake used to `?`-error the walk before the first card
        // fetch (no gate, no stamp, no queue_facts — the lane stayed
        // fake-busy). Now it stamps Unsettled with the failure NAMED and
        // walks on — the gate still refuses to merge onto a non-green
        // destination (leg 3), so the fail-closed law holds; the lane just
        // says WHY it holds.
        (
            String::new(),
            0u64,
            CheckVerdict { verdict: MainVerdict::Unsettled, red: vec![], unsettled: vec!["base read skipped (hermetic)".to_string()], external: vec![], green: 0, alarm: None, gate: None },
        )
    } else {
        match ctx.base_tip_facts(repo, base).map(|(base_sha, age_secs)| {
            let runs = ctx.check_runs(repo, &base_sha);
            (base_sha, age_secs, runs)
        }) {
            Ok((base_sha, age_secs, runs)) => (base_sha, age_secs, classify_base_check_runs(&runs, &required)),
            Err(e) => (
                String::new(),
                0u64,
                CheckVerdict { verdict: MainVerdict::Unsettled, red: vec![], unsettled: vec![format!("base read failed: {}", trunc(&e, 120))], external: vec![], green: 0, alarm: None, gate: None },
            ),
        }
    };
    let base_state = reconcile_base_deploy(
        ctx,
        lane,
        key,
        repo,
        base,
        &probed_base_sha,
        probed_base_age_secs,
        &mut base_class,
        &required,
        if from_awaiting_ci { 0 } else { pass_merged },
    );
    if let Some(ref alarm) = base_class.alarm {
        log(Some(key), &format!("base check alarm (BR#5674 P1): {alarm}"));
    }
    if from_awaiting_ci && base_class.verdict == MainVerdict::Red {
        let _ = ctx.mcp("train_queue_facts", json!({ "repo": repo, "base": base, "base_state": base_state }));
        log(Some(key), "awaiting-ci: base tip is RED — holding batch continuation until base is green");
        return Ok(());
    }
    for (qi, head) in queue.iter().enumerate() {
        // BR#4934 cap: at burst_max merges per pass the drain settles even
        // with clean heads queued (drain_burst_decision: Settle, not Drain).
        if pass_merged > 0 && drain_burst_decision(pass_merged, burst_cap, true, false) != DrainDecision::Drain {
            log(Some(key), &format!(
                "burst cap {} reached after {} merge(s) — settling the pass on {}",
                if burst_cap == 0 { "∞".to_string() } else { burst_cap.to_string() },
                pass_merged,
                &tip_sha[..tip_sha.len().min(9)]
            ));
            break;
        }
        // BR#4934 mid-drain tip check: before each merge, classify the pass
        // tip's fed checks — RED stops the line immediately (GH#2261 law);
        // pending/green keeps draining (destination-green is the settle's).
        if pass_merged > 0 && !tip_sha.is_empty() {
            let tip_runs = ctx.check_runs(repo, &tip_sha);
            if classify_base_check_runs(&tip_runs, &required).verdict == MainVerdict::Red {
                renew_lease(ctx, repo, base);
                ctx.mcp("train_ci", json!({ "repo": repo, "base": base, "sha": tip_sha, "checks": tip_runs }))?;
                ctx.note(&format!("burst drain: pass tip {} RED — stop fed (GH#2261)", &tip_sha[..tip_sha.len().min(9)]));
                log(Some(key), &format!("burst drain: pass tip {} went RED — stop-the-line fed, drain aborted", &tip_sha[..tip_sha.len().min(9)]));
                return Ok(());
            }
        }
        let head_id = vstr(head, "id").unwrap_or("").to_string();
        let card = ctx.mcp("get_artefact", json!({ "id": head_id }))?;
        let card_meta = card.get("meta").cloned().unwrap_or(json!({}));
        let card_status = card.get("status").and_then(|v| v.as_str()).map(String::from);
        // BR#3659: the card is a LIST of legs (meta.prs; meta.pr stays the first
        // for legacy readers). THIS lane drives the first UNLANDED, UNPARKED
        // leg whose repo is this lane's — BR#4934: a leg stamped awaiting-ci
        // is PARKED on this pass (its merge is in; the settle owns it) and
        // must never re-gate as if unmerged.
        let legs = train_legs(&card_meta);
        // "On this lane" is repo AND base — a leg without a base stamp
        // defaults to "main" (the card-stamp convention), the exact scoping
        // the hub's derived queue uses (core.ts trainLegsRemaining,
        // BR#4977). Without the base half, a second base's leg on this repo
        // could be classified (and driven) by the wrong lane's walk; with it,
        // an entry whose legs all target other bases is honestly "no unlanded
        // leg on this lane" below. (BR#5753 walk half.)
        let lane_legs: Vec<usize> = legs
            .iter()
            .enumerate()
            .filter(|(_, leg)| {
                leg.repo == repo
                    && leg.base.as_deref().unwrap_or("main") == base
                    && !train_leg_landed(&card_meta, leg)
            })
            .map(|(i, _)| i)
            .collect();
        if lane_legs.is_empty() {
            // Crash-window reconcile: every leg landed but the card never closed
            // (executor died between the last merge and train:landed) — re-stamp
            // the last leg so the hub's landed flow runs.
            let all_landed = !legs.is_empty() && legs.iter().all(|l| train_leg_landed(&card_meta, l));
            let last_landed = legs.iter().rev().find(|l| train_leg_landed(&card_meta, l));
            if all_landed && last_landed.map(|l| l.repo == repo).unwrap_or(false) && card_status.as_deref() == Some("blocked") {
                let last = last_landed.unwrap();
                renew_lease(ctx, repo, base);
                ctx.mcp("train_event", json!({
                    "repo": repo, "base": base, "kind": "merged", "pr": last.number,
                    "merge_sha": card_meta.pointer(&format!("/merge_train/legs/{}/merge_sha", last.number)).and_then(|v| v.as_str())
                        .or_else(|| card_meta.pointer("/merge_train/merge_sha").and_then(|v| v.as_str())),
                    "task_id": head_id, "signer": ctx.holder,
                    "reason": "reconcile: all legs landed but the card never closed (crash between merge and landed) — re-stamped",
                }))?;
                ctx.note(&format!("reconcile: re-stamped landed card {head_id}"));
                log(Some(key), &format!("reconcile: card {head_id} all legs landed — re-stamped PR #{} for the landed close", last.number));
                release_if_idle(ctx, key, repo, base)?;
                return Ok(());
            }
            // BR#3935: this entry can never drive on this lane — advance.
            // BR#5753: this stays an ADVANCE, not a bounce — post-BR#4977 the
            // hub's derived queue only lists cards with an unlanded leg on
            // THIS repo+base, so a static no-lane-leg entry cannot persist in
            // lane.queue (the snapshot re-derives within one tick). A firing
            // here is mid-tick drift, and the card may legitimately ride a
            // SIBLING lane via its other unlanded legs — a hub bounce here
            // would yank it off that lane's queue.
            log(Some(key), &format!("queue[{qi}] {head_id} has no unlanded leg on this lane ({} leg(s) cited) — advancing to the next queue entry", legs.len()));
            continue;
        }
        // BR#4934 parked filter: advance past awaiting-ci legs to the first
        // leg this tick can actually drive; ALL parked → the pass settle
        // owns the card, advance.
        let drive_idx = lane_legs.iter().find(|&&i| train_leg_state(&card_meta, &legs[i]) != Some("awaiting-ci"));
        let leg_idx = match drive_idx {
            Some(&i) => i,
            None => {
                log(Some(key), &format!("queue[{qi}] {head_id} is parked awaiting-ci on this lane — the pass settle owns it, advancing"));
                continue;
            }
        };
        let leg = legs[leg_idx].clone();
        let leg_number = leg_idx + 1;
        let pr = leg.number;
        if pr == 0 || leg.repo.is_empty() {
            // BR#5753: a stamp-less leg can NEVER drive — and the old
            // advance-only path left the card in the hub's derived queue
            // FOREVER: the hub keeps matching the leg on repo+base+unlanded
            // regardless of its missing number, so the entry re-derived into
            // lane.queue every tick, a silent zombie inflating queue.length.
            // Un-queue it on the hub: the audited impl bounce (train:bounced,
            // gate class) stamps merge_train.state = "bounced" and flips the
            // card blocked → in_progress with the fix-up brief — impl
            // re-stamps the PR binding, re-verifies, re-queues. The bounce
            // needs pr > 0: the card's own merge_train stamp supplies it
            // (the hub's laneQueue SQL only queues cards with
            // merge_train.pr > 0, falling back to any stamped leg). When
            // even that is missing the entry is not hub-queueable anymore —
            // snapshot drift: advance and let the snapshot re-derive.
            let bounce_pr = card_meta
                .pointer("/merge_train/pr")
                .and_then(|v| v.as_i64())
                .filter(|&n| n > 0)
                .or_else(|| legs.iter().map(|l| l.number).find(|&n| n > 0))
                .unwrap_or(0);
            if bounce_pr > 0 {
                renew_lease(ctx, repo, base);
                let defect = format!(
                    "queue entry leg {leg_number} on this lane carries no PR stamp (number 0 / empty repo) — the entry can never drive or land (BR#5753); re-stamp the card's PR binding (meta.prs leg), re-verify, re-queue"
                );
                ctx.mcp("train_event", json!({
                    "repo": repo, "base": base, "kind": "bounced", "pr": bounce_pr, "task_id": head_id,
                    "reason": defect, "bounce_kind": "gate",
                }))?;
                ctx.note(&format!("bounced {head_id} (gate, stamp-less) — leg {leg_number} carries no PR stamp; lane.queue self-heals this tick"));
                log(Some(key), &format!("queue[{qi}] {head_id} leg {leg_number} carries no PR stamp — bounced off the hub (impl re-stamps the binding, re-verifies, re-queues; BR#5753)"));
                release_if_idle(ctx, key, repo, base)?;
                return Ok(());
            }
            // BR#3935 (fail-open residue): no bounceable pr stamp at all —
            // advance (the hub audit owns the convention violation).
            log(Some(key), &format!("queue[{qi}] {head_id} leg {leg_number} carries no PR stamp and no bounceable train stamp — advancing to the next queue entry (verify convention violation; see hub audit)"));
            continue;
        }
        let mut facts = ctx.pr_facts(repo, pr)?;
        if vstr(&facts, "state") == Some("MERGED") && facts.pointer("/mergeCommit/oid").is_some() {
            // reconcile: merged on GitHub, no train event (crash between merge and
            // event) — stamp it and continue walking the remaining queue entries.
            renew_lease(ctx, repo, base);
            ctx.mcp("train_event", json!({ "repo": repo, "base": base, "kind": "merged", "pr": pr, "merge_sha": facts.pointer("/mergeCommit/oid"), "head_sha": vstr(&facts, "headRefOid"), "task_id": head_id, "signer": ctx.holder, "reason": "reconcile: PR already merged on GitHub — event stamped from live state" }))?;
            ctx.note(&format!("reconcile: stamped already-merged PR #{pr}"));
            log(Some(key), &format!("reconcile: PR #{pr} was already merged — stamped, continuing walk"));
            continue;
        }
        // L1.1 (BR#4685): poll, don't bounce. An unanswered mergeStateStatus
        // (null/UNKNOWN — GitHub computing, typical right after a base merge)
        // is backoff-polled inside this tick — bounded by the lease heartbeat
        // (renewed around every wait) — until GitHub answers. The gate below
        // bounces ONLY on definitive DIRTY/CONFLICTING; a merge/closure that
        // lands mid-poll reconciles through the arms below instead of gating.
        if vstr(&facts, "state") == Some("OPEN") && !mergeability_definitive(&facts) {
            log(Some(key), &format!("queue[{qi}] PR #{pr} mergeStateStatus not yet computed — backoff-polling before the gate (BR#4685, lease-bounded)"));
            for wait in mergeability_poll_secs() {
                renew_lease(ctx, repo, base);
                std::thread::sleep(Duration::from_secs(wait));
                renew_lease(ctx, repo, base);
                facts = ctx.pr_facts(repo, pr)?;
                let st = vstr(&facts, "state").unwrap_or("");
                if st == "MERGED" || st == "CLOSED" || mergeability_definitive(&facts) {
                    break;
                }
            }
        }
        if vstr(&facts, "state") == Some("MERGED") && facts.pointer("/mergeCommit/oid").is_some() {
            renew_lease(ctx, repo, base);
            ctx.mcp("train_event", json!({ "repo": repo, "base": base, "kind": "merged", "pr": pr, "merge_sha": facts.pointer("/mergeCommit/oid"), "head_sha": vstr(&facts, "headRefOid"), "task_id": head_id, "signer": ctx.holder, "reason": "reconcile: PR already merged on GitHub — event stamped from live state" }))?;
            ctx.note(&format!("reconcile: stamped already-merged PR #{pr}"));
            log(Some(key), &format!("reconcile: PR #{pr} was already merged — stamped, continuing walk"));
            continue;
        }
        // BR#5639 ghost car + BR#3935/BR#5897 lineage, fail-closed
        // (BR#5911 F3): a leg whose live PR state is not OPEN can NEVER be
        // a batch candidate — the 2026-11-03 incident reached batch `ready`
        // while binding CLOSED PR #2659 (real leg #2759). The old
        // `== CLOSED` shape let non-CLOSED fall-throughs (MERGED without a
        // mergeCommit, an unreadable state) sail into the gate. Only a live
        // OPEN read passes; everything else stamps cls:"blocked" so the
        // hub never counts an unlandable PR as ready/green, and advances —
        // the card stays for the humans, the queue is not held.
        if !crate::train_gate::pr_state_is_batch_candidate(vstr(&facts, "state")) {
            let st = vstr(&facts, "state").unwrap_or("(unreadable)");
            qfacts.push(json!({ "id": head_id, "pr": pr, "cls": "blocked" }));
            log(Some(key), &format!("queue[{qi}] {head_id} PR #{pr} live state is {st} (not OPEN) — unlandable, never a batch candidate, advancing to the next queue entry (card stays for the humans)"));
            continue;
        }
        let head_sha = vstr(&facts, "headRefOid").unwrap_or("").to_string();
        // BR#4996: the lane's base sha + verdict are read ONCE per
        // classification walk, LAZILY — only an entry that reaches the gate
        // pays the read (the BR#3935 advance paths stay gh-free), and every
        // candidate gates on the same base truth: the REAL verdict while the
        // pass hasn't landed (BR#3009: the pass's FIRST landing still gates
        // on it), FORCED green mid-pass (destination-green is the pass
        // settle's, BR#4934 — the per-member tip RED check owns the stop).
        // BR#5190: the base's failing check NAMES ride the gate too — the
        // root-fix fast lane matches the circular deploy-health class off
        // them (the receipt names the red the fix cures). BR#5265: the
        // verdict is the hoisted per-walk read (scoped, Fix B) — mid-drain
        // composes with base FORCED green (BR#4934).
        let (gate_base, base_red_names) = if pass_merged > 0 {
            (MainVerdict::Green, Vec::new())
        } else {
            (
                base_class.verdict.clone(),
                base_class.red.iter().map(|r| r.name.clone()).collect(),
            )
        };
        // BR#5190: the candidate IS the main-breakage fix iff it is the
        // bound root-fix card (tags + meta.root_fix binding) — the executor
        // mirror of the hub's isRootFixCard. The WHOLE card rides (tags live
        // on the card row, the binding under meta.root_fix).
        let root_fix = is_root_fix_card(&card);
        // BR#5880 (live incident, tick 2026-11-03T21:23:47Z): every gate
        // DECISION reads the LIVE check-runs for THIS head sha — the
        // paginated ctx.check_runs() fetch above, this tick — never a
        // cached, panel, or prior-tick value. The incident shape: the
        // self-heal cited Nov-2 red runs on PR #2707's head while that
        // head's latest run was SUCCESS (id 126074493096, 17:07Z) — the
        // classification newest-wins law (aeae01cd2) plus this live-read
        // rule make the cited-verdict-must-be-the-live-verdict invariant:
        // a cache may speed renders, it must never feed a merge or
        // self-heal decision.
        let head_checks = ctx.check_runs(repo, &head_sha);
        let commits = ctx.pr_commits(repo, pr);
        // BR#5883: the tip's whole-tip gate predicate (the `main-green gate`
        // judge) is green iff the hoisted scoped verdict is Green with NO
        // gate qualifier attached — walk-start truth, never composed with
        // the mid-drain forced green (a stale gate re-run must rest on the
        // gate's own predicate, not on the burst's pass-green fiction).
        let base_gate_green = base_class.verdict == MainVerdict::Green && base_class.gate.is_none();
        // BR#4687 (L1.2): branch provenance for the behind pre-clear — the
        // PR's commit author logins against the worker allowlist. One extra
        // read-only gh call, fetched only when the state could be behind
        // (the only provenance-sensitive state) to keep the common tick's
        // gh budget unchanged.
        let merge_state = vstr(&facts, "mergeStateStatus").unwrap_or("").to_lowercase();
        let train_owned_branch = if merge_state == "behind" {
            let logins = ctx.pr_commit_logins(repo, pr);
            let owned = branch_is_worker_authored(&logins, &ctx.worker_identities);
            if !owned {
                log(
                    Some(key),
                    &format!(
                        "PR #{pr} is behind but NOT worker-authored ({} commit author(s)) — the bounce goes to its owner; the train does not move human branches",
                        logins.len()
                    ),
                );
            }
            owned
        } else {
            false
        };
        let gate = decide_train_gate(crate::train_gate::TrainGateInput {
            pr_number: pr,
            head_sha: &head_sha,
            card_meta: &card_meta,
            card_status: card_status.as_deref(),
            base_verdict: gate_base.clone(),
            mergeable: facts.get("mergeable").and_then(|v| v.as_bool()),
            merge_state_status: vstr(&facts, "mergeStateStatus").map(String::from),
            commits: &commits,
            head_checks: &head_checks,
            leg_number: Some(leg_number),
            root_fix,
            base_red_names: &base_red_names,
            base_gate_green,
            train_owned_branch,
        });
        // BR#6348: a car ALREADY parked TYPED conflicting is a clock, not a
        // bounce. The hub's conflict bounce parks it (merge_train.state =
        // "conflicting") IN the derived queue on a bounded budget with a
        // loud alarm at expiry; re-verdicting it every tick would bounce-
        // storm the ledger (the #279 ×31 class) and end this walk behind a
        // car whose exit is the mechanical rebase leg, not a re-bounce.
        // Convert the repeat conflicting verdict to a Skip: the walk
        // advances (the queue is not held), and the queue_facts stamp below
        // keeps cls "conflict" so the panel + starvation accounting still
        // see the car. The FIRST conflicting verdict still bounces — that
        // establishes the typed park with the trial-merge file list.
        let gate = match gate {
            MergeAction::Bounce { bounce_kind: crate::train_gate::BounceKind::Conflict, defect }
                if card_meta.pointer("/merge_train/state").and_then(|v| v.as_str()) == Some("conflicting") =>
            {
                log(Some(key), &format!("queue[{qi}] PR #{pr} ({head_id}) already parked TYPED conflicting — skip (the bounded clock + budget alarm own the exit, BR#6348)"));
                MergeAction::Skip { reason: format!("parked conflicting (BR#6348) — the typed clock + budget alarm own the exit; {defect}") }
            }
            g => g,
        };
        let (kind, detail) = match &gate {
            MergeAction::Merge { .. } => ("merge", String::new()),
            MergeAction::CloseSuperseded { reason } => ("close_superseded", format!(" — {reason}")),
            MergeAction::Bounce { defect, bounce_kind } => ("bounce", format!(" [{}] — {defect}", bounce_kind.as_str())),
            MergeAction::Note { reason } => ("note", format!(" — {reason}")),
            MergeAction::Skip { reason } => ("skip", format!(" — {reason}")),
            MergeAction::HumanLeg { reason } => ("human_leg", format!(" — {reason}")),
            MergeAction::RerunGate { reason } => ("rerun_gate", format!(" — {reason}")),
        };
        log(Some(key), &format!("queue[{qi}] PR #{pr} ({head_id}): gate → {kind}{detail}"));
        let ready_on_own_head = if gate_base != MainVerdict::Green && matches!(&gate, MergeAction::Skip { reason } if reason.starts_with("base main ")) {
            matches!(
                decide_train_gate(crate::train_gate::TrainGateInput {
                    pr_number: pr,
                    head_sha: &head_sha,
                    card_meta: &card_meta,
                    card_status: card_status.as_deref(),
                    base_verdict: MainVerdict::Green,
                    mergeable: facts.get("mergeable").and_then(|v| v.as_bool()),
                    merge_state_status: vstr(&facts, "mergeStateStatus").map(String::from),
                    commits: &commits,
                    head_checks: &head_checks,
                    leg_number: Some(leg_number),
                    root_fix,
                    base_red_names: &[],
                    // simulated green base ⇒ the qualifier-free green tip the
                    // BR#5883 field encodes (RerunGate ≠ Merge, so the
                    // ready_on_own_head predicate reads identically either way)
                    base_gate_green: true,
                    train_owned_branch,
                }),
                MergeAction::Merge { .. }
            )
        } else {
            false
        };
        qfacts.push(json!({ "id": head_id, "pr": pr, "cls": match &gate {
            MergeAction::Merge { .. } => "ready",
            MergeAction::Bounce { bounce_kind, .. } => match bounce_kind {
                crate::train_gate::BounceKind::Conflict => "conflict",
                crate::train_gate::BounceKind::Coverage => "needs-review",
                _ => "blocked",
            },
            MergeAction::Skip { reason } => if reason.contains("no accepted verify") {
                "needs-review"
            } else if reason.contains("parked conflicting (BR#6348)") {
                // BR#6348: a parked conflicting car stays honestly conflict-
                // classed in the queue block — not "waiting"
                "conflict"
            } else if ready_on_own_head {
                "ready"
            } else {
                "waiting"
            },
            MergeAction::RerunGate { .. } => "waiting",
            _ => "blocked",
        } }));
        let head_verdict = crate::train_gate::classify_head_checks(&head_checks);
        if matches!(&gate, MergeAction::Note { .. }) && !head_verdict.red.is_empty() {
            qfacts.last_mut().unwrap()["repair"] = json!({ "kind": "head_checks", "head_sha": head_sha,
                "checks": head_verdict.red.iter().map(|r| json!({ "name": r.name, "url": r.url })).collect::<Vec<_>>() });
        }
        if matches!(&gate, MergeAction::Note { .. }) && head_verdict.red.is_empty() && merge_state == "blocked" {
            qfacts.last_mut().unwrap()["repair"] = json!({ "kind": "head_checks", "head_sha": head_sha,
                "checks": [{ "name": "GitHub branch policy remains BLOCKED", "url": format!("https://github.com/{repo}/pull/{pr}") }] });
        }

        // ONE write action per tick (strict serialization): a Bounce /
        // HumanLeg / CloseSuperseded fires ON SIGHT and the walk ends — the
        // next tick re-derives the queue and continues. THE ONE EXCEPTION is
        // the merge (BR#4934): gate-clean heads ride the phase-B/C batch
        // (BR#4996) — classified here, landed back-to-back after the walk.
        // A NOT-READY head no longer holds the queue (Ray, 2026-10-30: "PRs
        // shouldn't be in the merge queue if they are not ready to merge —
        // or, if they must be, we don't hold up the queue, obviously"):
        // Skip/Note ADVANCES past it in the same walk. The identity gate
        // (BR#3181) is enforced at each write boundary: the close arm
        // below, and the batch landing (phase C).
        match gate {
            MergeAction::Skip { reason } | MergeAction::Note { reason } => {
                // BR#4996: a transient no-op means THIS head isn't landable —
                // it no longer settles the pass or ends the walk (the BR#4934
                // behavior starved a whole batch behind one skipped head).
                // The walk classifies past it; the pass still settles exactly
                // once, on the final merge of the batch (phase C tail).
                ctx.note(&format!("PR #{pr} ({head_id}) not ready — {reason}; continuing to the next queued PR"));
                log(Some(key), &format!("queue[{qi}] PR #{pr} ({head_id}) not ready — advancing (the queue is not held)"));
                continue;
            }
            MergeAction::RerunGate { reason } => {
                // STALE DEPLOY-HEALTH SELF-HEAL (2026-11-02 Ray directive —
                // "the train already runs; the system aggressively
                // self-heals"): the red is entirely the deploy-health class on
                // a GREEN base — a verdict stamped against a superseded main
                // deploy. Dispatch the re-run (check-runs rerequest, the same
                // write the bisect re-run leg uses) and treat the entry as a
                // clock: the next tick reads the fresh run green → merge, or
                // honestly red → the standing law owns it. Once the rerequest
                // is accepted the check goes in-flight (conclusion null →
                // unsettled → Skip), so this arm fires once, never a storm.
                if !ctx.write_allowed() {
                    log(Some(key), &format!("IDENTITY GATE: gate re-run dispatch for PR #{pr} withheld — gh is NOT a worker-class credential (BR#3181); a worker gateway heals the stale red"));
                } else {
                    // BR#5880: the dispatch set uses the SAME newest-wins law
                    // as the verdict that fired this arm (latest judge run per
                    // check name) — re-requesting a SUPERSEDED red (an older
                    // run of a name whose latest is green) would re-open a
                    // healed check and flip the head back to unsettled next
                    // tick. Never the raw historical list.
                    let stale = latest_red_deploy_health_runs(&head_checks);
                    let mut dispatched = 0usize;
                    let mut last_err: Option<String> = None;
                    for r in &stale {
                        // BR#5911 (F2): "classified fixable, dispatched 0" is a
                        // loud contradiction, never a quiet no-op — the 5h
                        // silent self-heal loop on PR #2707 dispatched 0 re-runs
                        // every tick while logging success-shaped lines. The
                        // failure is CAPTURED per attempt and, when nothing
                        // dispatched, escalated: error-level log + a
                        // self_heal_stalled stamp on this entry's queue_facts
                        // (the hub panel and the starvation duty read it).
                        let attempt = dispatch_check_retry(ctx, repo, base, &head_id, &head_sha, r);
                        match attempt {
                            Ok(_) => dispatched += 1,
                            Err(e) => last_err = Some(trunc(&e, 240)),
                        }
                    }
                    renew_lease(ctx, repo, base);
                    // BR#5911 (F2): RerunGate firing already proves the
                    // classification found ≥1 healable red — dispatched == 0
                    // (gh rerun failed, or the dispatch set resolved no run
                    // ids) is therefore always a loud contradiction, never a
                    // quiet no-op. The 5h silent loop on PR #2707 logged
                    // success-shaped "dispatched 0" lines every tick.
                    if let Some(fact) = self_heal_stall_fact(stale.len(), dispatched, last_err.as_deref()) {
                        // the stall stamp rides THIS tick's entry — the next
                        // walk rebuilds the entries, so a tick that dispatches
                        // cleanly drops it (self-clearing, same law as the
                        // whole-row stalled field).
                        if let Some(entry) = qfacts.last_mut() {
                            entry.as_object_mut().map(|o| o.insert("self_heal_stalled".into(), fact.clone()));
                            entry["repair"] = json!({ "kind": "head_checks", "head_sha": head_sha,
                                "checks": stale.iter().map(|r| json!({ "name": r.name, "url": r.html_url.clone().unwrap_or_default() })).collect::<Vec<_>>() });
                        }
                        let err_note = last_err.as_deref().unwrap_or("(no run resolved — dispatch set was empty against a red verdict)");
                        ctx.note(&format!("SELF-HEAL STALLED on PR #{pr}: classified healable red(s), dispatched 0 — {err_note}"));
                        log(Some(key), &format!("ERROR — queue[{qi}] PR #{pr} self-heal STALLED: dispatch set resolved {reds} run(s), 0 re-run(s) dispatched ({err_note}); stamped self_heal_stalled into queue_facts (BR#5911)", reds = stale.len()));
                    } else {
                        let err_suffix = match last_err.as_deref() {
                            Some(e) => format!(" (partial: {e})"),
                            None => String::new(),
                        };
                        ctx.note(&format!("self-heal: dispatched {dispatched} stale gate re-run(s) on PR #{pr} — {reason}"));
                        log(Some(key), &format!("queue[{qi}] PR #{pr} self-heal: {dispatched} stale deploy-health gate re-run(s) dispatched on a green base — polling next tick{err_suffix}"));
                    }
                }
                // the entry is a clock (waiting), never a defect: advance —
                // the queue is not held by a stale red
                continue;
            }
            MergeAction::HumanLeg { reason } => {
                // BR#5190: the root-fix fast lane's HumanLeg is the CIRCULAR
                // deploy-health class — the deterministic one-click merge ask
                // (title byte-identical to the hub's, ask-dedupe keys on exact
                // wording). First option IS the recommendation: one click
                // merges the cure onto the red base.
                if root_fix {
                    renew_lease(ctx, repo, base);
                    // BR#6390 human-gate contract: the ask says DO THIS, then
                    // CLICK DONE — the copyable --admin merge command + PR and
                    // card links inline, and the options are the accept/decline
                    // pair the ask planes render as inline buttons. DONE is
                    // dispatched hub-side (trainAlarmAnswerDispatch stamps
                    // lane.bypass_merge; the executor's stamp consumer lands or
                    // acks the merge). DECLINE holds the line, stamps nothing.
                    let fast_details = [
                        format!("Main on {repo}@{base} is RED; PR #{pr} ({head_id}) is the bound root-fix card (BR#5189 absolute p0)."),
                        "The base red is the circular deploy-health class: the gate is red because MAIN is red, so this PR's own deploy-health check can never go green while the line it fixes is stopped — no machine leg can pass (SP #2617 precedent).".to_string(),
                        "HUMAN GATE — do this and click DONE when done to unblock:".to_string(),
                        "1. Merge the cure out of turn (the gate fails every PR — including this fix PR itself — until the fix lands on the base). Copy-paste:".to_string(),
                        "   ```".to_string(),
                        format!("   gh pr merge {pr} --repo {repo} --admin --squash"),
                        "   ```".to_string(),
                        format!("2. Click DONE — PR #{pr} merged below. The queue unblocks itself: main's checks re-run on the new merge commit and the train drains once they settle green."),
                        format!("Links: fix PR {repo}#{pr} — https://github.com/{repo}/pull/{pr} · fix card {head_id}."),
                        "DECLINE — hold the line keeps the queue parked until main greens some other way; the fix work keeps digging.".to_string(),
                    ].join("\n\n");
                    ctx.mcp("ask_agent", json!({
                        "to": "human",
                        "question": root_fix_fast_lane_title(repo, pr),
                        "reason": reason,
                        "details": fast_details,
                        "options": [format!("DONE — PR #{pr} merged"), "DECLINE — hold the line"],
                        "artefact_id": head_id,
                    }))?;
                    ctx.note(&format!("root-fix fast lane: filed the human-gate merge ask for PR #{pr} (circular deploy-health class)"));
                    log(Some(key), &format!("root-fix fast lane: human gate filed for PR #{pr} — merge with --admin, click DONE; the train cannot merge through the circular gate"));
                    release_if_idle(ctx, key, repo, base)?;
                    return Ok(());
                }
                // ONE ask per class (5c): identical-open-ask dedupe keeps this single.
                renew_lease(ctx, repo, base);
                ctx.mcp("ask_agent", json!({
                    "to": "human",
                    "question": merge_sweep_human_leg_title(repo, &[reason.clone()]),
                    "reason": reason,
                    "options": ["Will re-sign and re-push", "Needs a decision"],
                    "artefact_id": head_id,
                }))?;
                ctx.note(&format!("filed human-leg ask for {head_id}"));
                log(Some(key), &format!("human leg filed: {reason}"));
                release_if_idle(ctx, key, repo, base)?;
                return Ok(());
            }
            MergeAction::CloseSuperseded { reason } => {
                // identity gate at the write boundary (BR#3181)
                if !ctx.write_allowed() {
                    ctx.note("identity gate: write leg withheld");
                    log(Some(key), &format!("IDENTITY GATE: close leg for PR #{pr} withheld — gh is NOT a worker-class credential (BR#3181); lease released for a worker gateway"));
                    release_if_idle(ctx, key, repo, base)?;
                    return Ok(());
                }
                renew_lease(ctx, repo, base);
                ctx.sh("gh", &["pr", "close", &pr.to_string(), "--repo", repo, "--comment", &trunc(&reason, 240)])?;
                ctx.note(&format!("closed superseded PR #{pr}"));
                log(Some(key), &format!("PR #{pr} closed (superseded card)"));
                release_if_idle(ctx, key, repo, base)?;
                return Ok(());
            }
            MergeAction::Bounce { defect, bounce_kind } => {
                renew_lease(ctx, repo, base);
                // BR#4066: the bounce NAMES ITS KIND and the event carries it —
                // the hub renders per-kind copy. Trial-merge ONLY a conflict-class
                // bounce: a coverage bounce (head moved past the verdict) has no
                // conflicts to enumerate and a gate defect already names the
                // truth — trial-merging those manufactured the "conflicts with
                // its base (no file list supplied)" lie the hub used to render.
                let trial = if bounce_kind == crate::train_gate::BounceKind::Conflict {
                    // BR#3935: fetch the head explicitly — merge-tree cannot be
                    // trusted to distinguish a conflict from a bad object.
                    ctx.fetch_pr_head(pr)?;
                    Some(ctx.trial_merge(base, &head_sha)?)
                } else {
                    None
                };
                let (clean, files) = trial.unwrap_or((true, vec![]));
                let event_kind = crate::train_gate::bounce_event_kind(&bounce_kind, clean, files.len());
                let merge_state = vstr(&facts, "mergeStateStatus").unwrap_or("").to_string();
                let mut ev = json!({
                    "repo": repo, "base": base, "kind": "bounced", "pr": pr, "task_id": head_id,
                    "head_sha": head_sha, "reason": defect,
                    "bounce_kind": event_kind,
                    "merge_state_status": merge_state,
                });
                if event_kind == "conflict" {
                    ev.as_object_mut().unwrap().insert("conflict_files".into(), json!(files));
                }
                ctx.mcp("train_event", ev)?;
                ctx.note(&format!("bounced PR #{pr} [{}] — {}", event_kind, trunc(&defect, 120)));
                let files_note = match event_kind {
                    "conflict" => format!("conflicts in {} file(s): {}{}", files.len(), files.iter().take(5).cloned().collect::<Vec<_>>().join(", "), if files.len() > 5 { ", …" } else { "" }),
                    "coverage" => "head moved past the accepted verdict — the verify pool re-verifies at the new head".to_string(),
                    _ => defect.clone(),
                };
                log(Some(key), &format!("PR #{pr} bounced ({event_kind}) — {files_note}"));
                release_if_idle(ctx, key, repo, base)?;
                return Ok(());
            }
            MergeAction::Merge { .. } => {
                // PHASE A (BR#4996): gate-clean — this head becomes a batch
                // candidate; the landing is phase C (one batch selection,
                // then back-to-back with no settle between members). The
                // per-member merge leg is Ray's 2026-10-30 law (mergeable ⇒
                // merge directly; update-branch only on strict-protection
                // refusal), applied at the phase C write boundary below.
                candidates.push(BatchCandidate {
                    qi,
                    head_id: head_id.clone(),
                    pr,
                    head_sha: head_sha.clone(),
                    root_fix,
                });
                continue;
            }
        }
    }
    // BR#5114: stamp this walk's per-entry verdicts (rank order preserved —
    // collected as the walk touched them) so the panel's queue blocks show
    // the truth of this pass: which entries are ready (the next batch) and
    // which wait/leave. One write per tick; failures never break the tick.
    // BR#5265: the stamp now rides whenever CARS ARE QUEUED (not only when
    // ---- PHASE B (BR#4996 + BR#5658): select the batch — the maximal set of
    // MUTUALLY non-conflicting candidates, queue order = landing order.
    // Conflict pairs come from the candidates' changed-file sets (merge-base
    // diff), then each intersecting pair is CONFIRMED head-vs-head with
    // merge-tree (BR#3935 fail-closed: a probe that cannot run counts as
    // conflicting, and a candidate whose file set cannot be computed is
    // excluded as not-known-clean — select_batch's clean[i] == false law).
    // Computed before the queue_facts stamp so conflict_pairs ([pr_a, pr_b])
    // ride the stamp and the hub can partition the backlog into sequential
    // merge batches (Batch 1 | Batch 2 | …).
    let mut batch: Vec<usize> = Vec::new();
    let mut conflict_pairs_prs: Vec<[i64; 2]> = Vec::new();
    let mut batch_deferred_log: Option<String> = None;
    let mut batch_selected_log: Option<(usize, String)> = None;
    if !candidates.is_empty() {
        let mut clean: Vec<bool> = vec![true; candidates.len()];
        let mut file_sets: Vec<crate::train_gate::FileSet> = Vec::with_capacity(candidates.len());
        for (i, c) in candidates.iter().enumerate() {
            match ctx.pr_file_set(base, c.pr, &c.head_sha) {
                Ok(set) => file_sets.push(set),
                Err(e) => {
                    log(Some(key), &format!("batch: PR #{} file set unreadable ({}) — excluded from the batch as not-known-clean (BR#3935 fail-closed)", c.pr, trunc(&e, 160)));
                    clean[i] = false;
                    file_sets.push(crate::train_gate::FileSet::new());
                }
            }
        }
        let mut conflict_pairs: Vec<(usize, usize)> = Vec::new();
        for (i, j) in crate::train_gate::conflicts_from_file_sets(&file_sets) {
            match ctx.heads_conflict(&candidates[i].head_sha, &candidates[j].head_sha) {
                Ok(true) => {
                    conflict_pairs.push((i, j));
                    conflict_pairs_prs.push([candidates[i].pr, candidates[j].pr]);
                }
                Ok(false) => {}
                Err(e) => {
                    log(Some(key), &format!("batch: PR #{} × #{} conflict probe unreadable ({}) — pair counted CONFLICTING (BR#3935 fail-closed)", candidates[i].pr, candidates[j].pr, trunc(&e, 160)));
                    conflict_pairs.push((i, j));
                    conflict_pairs_prs.push([candidates[i].pr, candidates[j].pr]);
                }
            }
        }
        batch = crate::train_gate::select_batch(&clean, &conflict_pairs, if burst_cap == 0 { usize::MAX } else { burst_cap as usize });
        if batch.len() < candidates.len() {
            let dropped: Vec<String> = candidates
                .iter()
                .enumerate()
                .filter(|(i, _)| !batch.contains(i))
                .map(|(_, c)| format!("PR #{} (queue[{}])", c.pr, c.qi))
                .collect();
            batch_deferred_log = Some(format!("batch selection: {} of {} candidate(s) — deferred to the next pass: {}", batch.len(), candidates.len(), dropped.join(", ")));
        }
        let batch_ids: Vec<String> = batch.iter().map(|&i| format!("PR #{} [{}]", candidates[i].pr, candidates[i].head_id)).collect();
        batch_selected_log = Some((batch.len(), batch_ids.join(", ")));
    }

    // BR#5265: the stamp now rides whenever CARS ARE QUEUED (not only when
    // the walk produced verdicts — entries can short-circuit pre-gate) and
    // carries base_state (Fix A): the hub renders the lane BLOCKED with
    // the base red names + files the one-per-episode human alarm ask.
    if !queue.is_empty() {
        // BR#5376: an ACTIVE stall episode rides the stamp — the hub renders
        // the loud STALLED lane/banner off it (freshness-guarded, same law as
        // base_state); the next stamp after a landing omits it, which clears
        // the state by itself.
        let mut qf = json!({ "repo": repo, "base": base, "entries": qfacts, "base_state": base_state });
        if !conflict_pairs_prs.is_empty() {
            qf.as_object_mut().unwrap().insert("conflict_pairs".into(), json!(conflict_pairs_prs));
        }
        if let Some(st) = ctx.stall.get(key) {
            qf.as_object_mut().unwrap().insert(
                "stalled".into(),
                json!({
                    "batch": st.members,
                    "ticks": st.ticks,
                    "since": st.since_ms,
                    "for_ms": now_ms().saturating_sub(st.since_ms),
                    "last_error": st.last_error,
                }),
            );
        }
        let _ = ctx.mcp("train_queue_facts", qf);
        // BR#5376: the ONE-per-episode stall alarm — fired under the walk's
        // lease (the handler requires it), only when a previous settle
        // crossed the threshold. The hub renders the STALLED banner and
        // files the alarm ask off this event + the stamp above.
        if let Some(ev) = stall_fire_check(ctx, key, repo, base) {
            ctx.mcp("train_event", ev)?;
        }
    }

    if let Some(msg) = batch_deferred_log {
        log(Some(key), &msg);
    }
    if let Some((n_sel, ids_str)) = batch_selected_log {
        ctx.note(&format!("batch selected: {} member(s) — landing back-to-back", n_sel));
        log(Some(key), &format!("batch (BR#4996): {} mutually non-conflicting member(s), landing in queue order: {}", n_sel, ids_str));
    }

    // identity gate at the write boundary (BR#3181): the batch's merge legs
    // execute only under the worker-class credential — checked ONCE, before
    // the first write.
    if !batch.is_empty() && !ctx.write_allowed() {
        ctx.note("identity gate: write leg withheld");
        log(Some(key), &format!("IDENTITY GATE: batch merge legs ({} PR(s)) withheld — gh is NOT a worker-class credential (BR#3181); lease released for a worker gateway", batch.len()));
        release_if_idle(ctx, key, repo, base)?;
        return Ok(());
    }

    // ---- PHASE C (BR#4996): land the batch back-to-back — no settle
    // between members. The per-member merge leg law is the standing law
    // (BR#4934): machine-clean update first (the verdict carries), then
    // merge. Before EACH member: the burst cap (drain_burst_decision) and
    // the mid-drain tip RED classify (GH#2261). A refused merge
    // soft-breaks: pass_merged > 0 settles the landed prefix and ends the
    // tick; pass_merged == 0 keeps the loud tick error. Every merged event
    // carries batch_members — the batch composition in landing order (the
    // hub sanitizes it; do.ts).
    let batch_prs: Vec<i64> = batch.iter().map(|&i| candidates[i].pr).collect();
    ctx.tick_batch = batch_prs.clone();
    if !batch.is_empty() {
        let allowed_methods = effective_merge_methods(ctx, repo, base)?;
        let selected_method = allowed_methods[0].name();
        ctx.method_sub.insert(repo.to_string(), selected_method.to_string());
    }
    for (bi, &ci) in batch.iter().enumerate() {
        let cand = &candidates[ci];
        let head_id = cand.head_id.as_str();
        let pr = cand.pr;
        let head_sha = cand.head_sha.as_str();
        // BR#4934 cap: at burst_max merges per pass the drain settles even
        // with batch members left (drain_burst_decision: Settle, not Drain).
        if pass_merged > 0 && drain_burst_decision(pass_merged, burst_cap, true, false) != DrainDecision::Drain {
            log(Some(key), &format!(
                "burst cap {} reached after {} merge(s) — settling the pass on {}",
                if burst_cap == 0 { "∞".to_string() } else { burst_cap.to_string() },
                pass_merged,
                &tip_sha[..tip_sha.len().min(9)]
            ));
            break;
        }
        // BR#4934 mid-drain tip check: before each member, classify the pass
        // tip's fed checks — RED stops the line immediately (GH#2261 law);
        // pending/green keeps landing (destination-green is the settle's).
        if pass_merged > 0 && !tip_sha.is_empty() {
            let tip_runs = ctx.check_runs(repo, &tip_sha);
            if classify_base_check_runs(&tip_runs, &required).verdict == MainVerdict::Red {
                renew_lease(ctx, repo, base);
                ctx.mcp("train_ci", json!({ "repo": repo, "base": base, "sha": tip_sha, "checks": tip_runs }))?;
                ctx.note(&format!("batch drain: pass tip {} RED — stop fed (GH#2261)", &tip_sha[..tip_sha.len().min(9)]));
                log(Some(key), &format!("batch drain: pass tip {} went RED — stop-the-line fed, batch aborted", &tip_sha[..tip_sha.len().min(9)]));
                return Ok(());
            }
        }
        // Current-base admission (BR#6776): file-clean is not compile-clean.
        // A stale car integrated against newer contracts caused the E0063
        // main-red. Carry the substance verdict across a clean base update,
        // but never carry CI: the integrated head must run its actual checks.
        // Re-evaluate for EACH member, including after this pass advanced base.
        match admit_current_base(ctx, repo, base, cand)? {
            IntegrationAdmission::Current => {},
            IntegrationAdmission::RepairDispatched => break,
            IntegrationAdmission::AwaitingCi { base_sha, head_sha: integrated_head } => {
                for entry in &mut qfacts {
                    if entry.get("id").and_then(Value::as_str) == Some(cand.head_id.as_str()) {
                        entry["cls"] = json!("waiting");
                        entry["integration"] = json!({ "phase": "awaiting_ci", "base_sha": base_sha, "head_sha": integrated_head });
                    }
                }
                ctx.mcp("train_queue_facts", json!({ "repo": repo, "base": base, "entries": qfacts, "base_state": base_state }))?;
                log(Some(key), &format!("PR #{pr}: current base integrated; substance verdict carried, fresh integrated-head CI required"));
                break;
            }
        }
        renew_lease(ctx, repo, base);
        // BR#5376: a remembered working method (the repo refused the
        // configured one earlier) goes straight there — no wasted refusal
        // per member.
        let method_flag = match ctx.method_sub.get(repo) {
            Some(m) => method_flag_for(m),
            None => method_flag_for(&ctx.method),
        };
        ctx.tick_attempted = true;
        let mut merge_res = ctx.sh("gh", &["pr", "merge", &pr.to_string(), "--repo", repo, method_flag, "--match-head-commit", head_sha]);
        if merge_res.is_err() && cand.root_fix {
            if let Ok(out) = ctx.sh("gh", &["pr", "merge", &pr.to_string(), "--repo", repo, method_flag, "--admin", "--match-head-commit", head_sha]) {
                merge_res = Ok(out);
            }
        }
        if pass_merged > 0 {
            for wait_secs in [3u64, 5, 8] {
                let is_transient_post_merge = match &merge_res {
                    Err(e) => {
                        let l = e.to_lowercase();
                        l.contains("base branch was modified")
                            || l.contains("try the merge again")
                            || l.contains("pull request is not mergeable")
                    }
                    Ok(_) => false,
                };
                if !is_transient_post_merge {
                    break;
                }
                renew_lease(ctx, repo, base);
                std::thread::sleep(Duration::from_secs(wait_secs));
                renew_lease(ctx, repo, base);
                merge_res = ctx.sh("gh", &["pr", "merge", &pr.to_string(), "--repo", repo, method_flag, "--match-head-commit", head_sha]);
            }
        }
        if let Err(err) = merge_res {
            let low = err.to_lowercase();
            if low.contains("up to date") || low.contains("behind") || low.contains("out of date") {
                // strict protection wants the branch current — the one case
                // the machine rebase exists for. But the refusal can be
                // PHANTOM (BR#5252, PR #332 episode 2026-10-31: an
                // out-of-date-shaped error on a 0-behind MERGEABLE/CLEAN
                // head) — the legs below are judged from LOCAL ground truth,
                // never the gh text, and the bounce rides the BR#4066
                // refinement so a lying file-less "conflict" can never fire.
                ctx.sh("git", &["fetch", "--quiet", "origin", base])?;
                ctx.fetch_pr_head(pr)?;
                // BR#3935: ancestry is three-valued — a cannot-read fails the
                // tick closed (retry next tick), never a silent `behind`
                // (the lying-bounce ingredient).
                let zero_behind = ctx.is_ancestor(&format!("origin/{base}"), head_sha)?;
                let (clean, tm_files) = ctx.trial_merge(base, head_sha)?;
                match merge_refusal_fallback(zero_behind, clean, &tm_files) {
                    RefusalFallback::UpdateBranch => {
                        ctx.sh("gh", &["pr", "update-branch", &pr.to_string(), "--repo", repo])?;
                        if let Ok(updated) = ctx.pr_facts(repo, pr) {
                            let to_head = vstr(&updated, "headRefOid").unwrap_or("");
                            if !to_head.is_empty() && !to_head.eq_ignore_ascii_case(head_sha) {
                                let _ = ctx.mcp("train_carry", json!({
                                    "repo": repo,
                                    "base": base,
                                    "pr": pr,
                                    "from_head": head_sha,
                                    "to_head": to_head,
                                }));
                            }
                        }
                        ctx.note(&format!("strict protection: machine update-branch PR #{pr} (verdict carried); merging next tick"));
                        log(Some(key), &format!("PR #{pr}: merge refused (branch not up to date) — machine update-branch + train_carry recorded, continuing batch"));
                        continue;
                    }
                    RefusalFallback::ConflictBounce => {
                        // BR#4066: the event kind is REFINED from the
                        // trial-merge ground truth, same as the generic Bounce
                        // arm. BR#5252 (c): the raw gh refusal rides the
                        // event — diagnosis needs no archaeology.
                        let conflict_reason = format!("base {base} advanced into the PR's files — rebase conflicts are human-resolved; the verdict does not carry");
                        let event_kind = crate::train_gate::bounce_event_kind(&crate::train_gate::BounceKind::Conflict, clean, tm_files.len());
                        let mut ev = json!({
                            "repo": repo, "base": base, "kind": "bounced", "pr": pr, "task_id": head_id, "head_sha": head_sha,
                            "bounce_kind": event_kind, "defect": conflict_reason, "reason": conflict_reason,
                            "gh_refusal": trunc(&err, 300),
                        });
                        if event_kind == "conflict" {
                            ev.as_object_mut().unwrap().insert("conflict_files".into(), json!(tm_files));
                        }
                        ctx.mcp("train_event", ev)?;
                        ctx.note(&format!("bounced PR #{pr} [{event_kind}] — {}", trunc(&conflict_reason, 120)));
                        let files_note = format!("conflicts in {} file(s): {}{}", tm_files.len(), tm_files.iter().take(5).cloned().collect::<Vec<_>>().join(", "), if tm_files.len() > 5 { ", …" } else { "" });
                        log(Some(key), &format!("PR #{pr} bounced ({event_kind}) — {files_note}; continuing batch"));
                        continue;
                    }
                    RefusalFallback::StaleOrInfra => {
                        // BR#5252 (b): a file-less not-clean read (real text
                        // conflicts always enumerate paths) or a not-clean
                        // read on a 0-behind head (merge-base == base tip —
                        // conflict is structurally impossible) is
                        // stale-or-infra garbage, NOT a conflict. NO bounce —
                        // the PR stays queued and the next tick re-reads
                        // mergeable fresh (the PR #332 episode bounced here
                        // and burned 2 dispatches + a watchdog cycle).
                        ctx.note(&format!(
                            "PR #{pr}: gh merge refused as out-of-date but the local read disagrees ({}{}) — phantom/stale refusal (BR#5252), no bounce; retrying next tick. gh: {}",
                            if clean { "trial merge clean" } else { "trial merge not-clean, 0 conflict files" },
                            if zero_behind { "; head is 0 behind (base tip ∈ ancestry)" } else { "" },
                            trunc(&err, 200)
                        ));
                        log(Some(key), &format!("PR #{pr}: phantom merge refusal (BR#5252) — no bounce, continuing batch"));
                        continue;
                    }
                }
            }
            // BR#5376: a merge-METHOD refusal ("Merge commits are not allowed
            // on this repository.") is a repo-policy mismatch, not a PR
            // defect — GitHub refuses the mutation even when REST still reads
            // the flag true (the 2026-10-30 → 11-01 sp outage: 945+ refused
            // attempts over 5 days, zero hub events). Fall back to an allowed
            // method (squash first — Ray's 2026-10-30 law) and LAND the
            // member; the refusal that precedes it is the episode's receipt.
            if is_merge_method_refusal(&err) {
                match method_fallback_merge(ctx, key, repo, base, pr, head_sha, &err) {
                    Ok(()) => {
                        // landed via the fallback — control falls through to
                        // the post-merge verification below.
                    }
                    Err(fb_err) => {
                        // every allowed method refused — the combined error
                        // feeds the tick error → the stall tracker → the
                        // alarm ask. Bouncing would be wrong: the PR is fine,
                        // the executor's method book is stale.
                        return Err(format!("{}; merge-method fallback also failed: {}", trunc(&err, 240), trunc(&fb_err, 240)));
                    }
                }
            } else {
                // BR#4996 soft-break: a refused merge mid-batch must not fail the
                // whole tick — continue to the remaining batch members and settle
                // at the end of the batch.
                if pass_merged > 0 || bi + 1 < batch.len() {
                    log(Some(key), &format!("batch soft-skip: gh pr merge refused PR #{pr} ({}) — continuing to remaining batch members", trunc(&err, 200)));
                    continue;
                }
                return Err(err);
            }
        }
        let merged = ctx.pr_facts(repo, pr)?;
        let merge_sha = merged.pointer("/mergeCommit/oid").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if vstr(&merged, "state") != Some("MERGED") || merge_sha.is_empty() {
            return Err(format!(
                "gh pr merge reported ok but PR #{pr} is {} with no mergeCommit — DO NOT trust this tick; investigate",
                vstr(&merged, "state").unwrap_or("?")
            ));
        }
        // BR#4934/BR#4996: the burst pass rides the merged event — count
        // INCLUDES this merge; batch_members carries the batch composition
        // in landing order. The settle comes later as the pass's single
        // settle feed (the hub flips bursting → awaiting-ci on the first
        // settle poll, not here).
        pass_merged = pass_merged.saturating_add(1);
        ctx.tick_landed += 1;
        // BR#5190: the event carries root_fix so the hub knows the
        // lane was cured by this landing (settle copy + fast receipt).
        let mut merged_ev = json!({
            "repo": repo, "base": base, "kind": "merged", "pr": pr, "merge_sha": merge_sha, "head_sha": head_sha, "task_id": head_id, "signer": ctx.holder,
            "burst_merged": pass_merged, "burst_cap": burst_cap, "burst_settling": false,
            "batch_members": batch_prs,
        });
        if cand.root_fix {
            merged_ev.as_object_mut().unwrap().insert("root_fix".into(), json!(true));
        }
        ctx.mcp("train_event", merged_ev)?;
        tip_sha = merge_sha.clone();
        // BR#5190: the fast-track receipt rides the merged note when this
        // landing IS the cure (root_fix wired into the event above).
        let fast_note = if cand.root_fix { " — ROOT-FIX FAST-TRACK (BR#5189): the cure is in flight; the line greens when its CI settles" } else { "" };
        ctx.note(&format!("merged PR #{pr} as {}{}", &tip_sha[..tip_sha.len().min(9)], fast_note));
        log(
            Some(key),
            &format!(
                "PR #{pr} merged as {} — batch member {}/{} ({pass_merged} merged this pass, cap {}): no settle between members{fast_note}",
                &tip_sha[..tip_sha.len().min(9)],
                bi + 1,
                batch.len(),
                if burst_cap == 0 { "unlimited".to_string() } else { burst_cap.to_string() }
            ),
        );
        // THE DRAIN (BR#4934, batched by BR#4996): the next batch member is
        // landed in the SAME tick — the loop continues.
    }
    // the batch ended: if a pass drained this tick — or a mid-pass tick
    // found nothing more to land — it settles NOW: exactly ONE settle wait
    // per drain pass, on the FINAL merge commit (BR#4934, unchanged).
    // Otherwise the lane is honestly idle.
    if pass_merged > 0 && !tip_sha.is_empty() {
        if from_awaiting_ci && pass_merged == initial_pass_merged {
            settle_window_rebase(ctx, key, repo, base, lane)?;
            return Ok(());
        }
        burst_settle_feed(ctx, key, repo, base, &tip_sha, pass_merged)?;
        return Ok(());
    }
    release_if_idle(ctx, key, repo, base)?;
    Ok(())
}

/// BR#4934 settle feed: the pass's ONE settle wait, entered when the drain
/// ends (queue empty of clean heads / burst_max reached). Feeds the tip's
/// checks + executor-fed ancestry; the HUB classifies and flips bursting →
/// awaiting-ci on this first settle poll.
fn burst_settle_feed(ctx: &mut Ctx, key: &str, repo: &str, base: &str, tip_sha: &str, pass_merged: u32) -> Result<(), String> {
    renew_lease(ctx, repo, base);
    let ancestors = settle_ancestors(ctx, repo, base, tip_sha)?;
    let tip_runs = ctx.check_runs(repo, tip_sha);
    let mut body = json!({ "repo": repo, "base": base, "sha": tip_sha, "checks": tip_runs });
    if !ancestors.is_empty() {
        body.as_object_mut().unwrap().insert("ancestors_of_settled".into(), json!(ancestors));
    }
    let ci = ctx.mcp("train_ci", body)?;
    ctx.note(&format!("burst settle on {}: {}", &tip_sha[..tip_sha.len().min(9)], vstr(&ci, "decided").unwrap_or("?")));
    log(
        Some(key),
        &format!(
            "burst settle: pass of {pass_merged} merge(s) settles on {} — hub decides{}",
            &tip_sha[..tip_sha.len().min(9)],
            if ancestors.is_empty() { String::new() } else { format!(" ({} fed ancestor(s))", ancestors.len()) }
        ),
    );
    Ok(())
}

/// BR#4934: the pass's earlier merge shas (provenance ledger, BR#3287),
/// verified on-base — executor-fed ancestry for the hub's burst-park closes
/// (the hub holds no VCS creds, BR#3516). Three-valued law (BR#3935): a sha
/// git cannot read is EXCLUDED, never faked as ancestor-or-not. Bounded at
/// 50 verifications per settle.
fn settle_ancestors(ctx: &mut Ctx, repo: &str, base: &str, tip_sha: &str) -> Result<Vec<String>, String> {
    ctx.sh("git", &["fetch", "--quiet", "origin", base])?;
    let hist = ctx.mcp("train_history", json!({ "repo": repo, "base": base, "kind": "merged", "limit": 200 }))?;
    let tip = tip_sha.to_lowercase();
    let mut out: Vec<String> = Vec::new();
    for e in hist.get("events").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
        if out.len() >= 50 {
            break;
        }
        let sha = e.get("merge_sha").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
        if sha.len() < 7 || sha == tip || out.contains(&sha) {
            continue;
        }
        if ctx.is_ancestor(&sha, &tip).unwrap_or(false) {
            out.push(sha);
        }
    }
    Ok(out)
}

/// BR#4934 §6: the settle wait is the rebase window. ONE machine-clean leg
/// per tick: the first queued head that is BEHIND base and verdict-covered
/// at its CURRENT head gets `gh pr update-branch` (trial-merge first — a
/// conflict bounces with the file list, human-resolved), then the hub
/// appends the carry record (train.carry) so the verdict covers the moved
/// head (BR#3516 §5). Parked awaiting-ci legs are skipped — the settle owns
/// them; the identity gate withholds the write from a non-worker credential.
fn settle_window_rebase(ctx: &mut Ctx, key: &str, repo: &str, base: &str, lane: &Value) -> Result<(), String> {
    let queue = lane.get("queue").and_then(|q| q.as_array()).cloned().unwrap_or_default();
    for (qi, head) in queue.iter().enumerate() {
        let head_id = vstr(head, "id").unwrap_or("").to_string();
        if head_id.is_empty() {
            continue;
        }
        let card = ctx.mcp("get_artefact", json!({ "id": head_id }))?;
        if card.get("status").and_then(|v| v.as_str()) != Some("blocked") {
            continue;
        }
        let card_meta = card.get("meta").cloned().unwrap_or(json!({}));
        let legs = train_legs(&card_meta);
        let leg = legs
            .iter()
            .enumerate()
            .find(|(_, l)| l.repo == repo && !train_leg_landed(&card_meta, l) && train_leg_state(&card_meta, l) != Some("awaiting-ci"))
            .map(|(i, l)| (i + 1, l.clone()));
        let (leg_number, leg) = match leg {
            Some(x) => x,
            None => continue,
        };
        let pr = leg.number;
        if pr == 0 {
            continue;
        }
        let facts = ctx.pr_facts(repo, pr)?;
        if vstr(&facts, "state") != Some("OPEN") {
            continue;
        }
        let head_sha = vstr(&facts, "headRefOid").unwrap_or("").to_lowercase();
        if head_sha.is_empty() {
            continue;
        }
        // behind: base tip is NOT an ancestor of the head
        ctx.sh("git", &["fetch", "--quiet", "origin", base])?;
        ctx.fetch_pr_head(pr)?;
        if ctx.is_ancestor(&format!("origin/{base}"), &head_sha).unwrap_or(true) {
            continue;
        }
        // coverage extends, never created: the verdict must cover the head
        // AS IT IS now (stamp/carry) — an uncovered head is verify's business
        if !verdict_covers_head_leg(Some(&leg), &head_sha) {
            log(Some(key), &format!("settle-window probe: queue[{qi}] {head_id} leg {leg_number} uncovered at head — verify owns it, skipping"));
            continue;
        }
        let (clean, files) = ctx.trial_merge(base, &head_sha)?;
        if !clean {
            // BR#5252: the same decision law as the merge-refusal arm — a
            // file-less not-clean read is structurally impossible for a real
            // text conflict (merge-tree --name-only always lists paths), so
            // it is stale-or-infra garbage: NO bounce, the probe just skips
            // and the next tick re-reads. (A 0-behind head cannot reach here
            // — the ancestry skip above excludes it.)
            if files.is_empty() {
                log(Some(key), &format!("settle-window probe: PR #{pr} not-clean with NO conflict files — stale/infra read (BR#5252), skipping the probe without a bounce"));
                continue;
            }
            // BR#4066 refinement rides here too — one law, both implementations.
            let event_kind = crate::train_gate::bounce_event_kind(&crate::train_gate::BounceKind::Conflict, clean, files.len());
            let reason = format!("settle-window probe (BR#4934): base {base} advanced into the PR's files — rebase conflicts bounced to impl agent to resolve; the verdict does not carry");
            let mut ev = json!({ "repo": repo, "base": base, "kind": "bounced", "pr": pr, "task_id": head_id, "head_sha": head_sha, "bounce_kind": event_kind, "reason": reason });
            if event_kind == "conflict" {
                ev.as_object_mut().unwrap().insert("conflict_files".into(), json!(files));
            }
            ctx.mcp("train_event", ev)?;
            log(Some(key), &format!("settle-window probe: PR #{pr} conflicts ({} file(s)) — bounced to impl agent to resolve", files.len()));
            return Ok(());
        }
        // Ray 2026-10-30: "if it's still mergeable, go — we only need a
        // rebase if there are conflicts." Clean ⇒ NO proactive update-branch
        // (no machine push, no PR-branch CI churn): the drain merges this
        // head directly. The probe's only job now is surfacing conflicts
        // during the settle wait so impl work pipelines.
        log(Some(key), &format!("settle-window probe: PR #{pr} merges cleanly against base — the drain merges it directly (no rebase)"));
    }
    Ok(())
}

/// BR#4934 red-settle bisect driver — ONE step per tick while the line is
/// stopped on a burst-red settle. All walk state lives hub-side
/// (stop.bisect.steps/pass/culprit), crash-safe. Walk order: the pass's
/// intermediate merge shas OLDEST→NEWEST; the first RED probe names the ONE
/// culprit (train_bisect bounces it and re-parks the final card); all-green
/// probes pin the final card; an unreadable or bound-stalled probe stamps
/// inconclusive and the pass bounces oldest-first, one per tick. GitHub
/// re-run dispatch (check-runs rerequest) is a WRITE — worker-class only.
fn bisect_step(ctx: &mut Ctx, key: &str, repo: &str, base: &str, stop: &Value, required: &[String]) -> Result<(), String> {
    let bisect = match stop.get("bisect").filter(|b| !b.is_null()) {
        Some(b) => b,
        None => return Ok(()), // legacy stop — nothing to bisect
    };
    if bisect.get("culprit_task").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false)
        || bisect.get("inconclusive").and_then(|v| v.as_bool()).unwrap_or(false)
    {
        log(Some(key), "bisect settled — holding the stop until main is green again");
        return Ok(());
    }
    let step_verdict = |steps: &Value, sha: &str| -> Option<String> {
        steps.get(sha).map(|v| {
            if v.is_string() {
                v.as_str().unwrap_or("").to_string()
            } else {
                v.get("verdict").and_then(|x| x.as_str()).unwrap_or("").to_string()
            }
        })
    };
    let steps = bisect.get("steps").cloned().unwrap_or(json!({}));
    // an inconclusive probe anywhere → the whole walk failed: bounce the
    // pass's still-queued cards OLDEST-FIRST, one per tick, then stamp it
    let inconclusive = steps.as_object().map(|m| {
        m.values().any(|v| {
            let s = if v.is_string() { v.as_str().unwrap_or("").to_string() } else { v.get("verdict").and_then(|x| x.as_str()).unwrap_or("").to_string() };
            s == "inconclusive"
        })
    }).unwrap_or(false);
    let pass_merged = bisect.pointer("/pass/merged").and_then(|v| v.as_u64()).unwrap_or(0).min(200) as usize;
    let hist = ctx.mcp("train_history", json!({ "repo": repo, "base": base, "kind": "merged", "limit": 200 }))?;
    let events = hist.get("events").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut pass: Vec<(String, String, i64)> = Vec::new(); // (sha, task_id, pr), newest first
    for e in &events {
        if pass.len() >= pass_merged.max(1) {
            break;
        }
        let sha = e.get("merge_sha").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
        if sha.len() < 7 {
            continue;
        }
        pass.push((sha, e.get("task_id").and_then(|v| v.as_str()).unwrap_or("").to_string(), e.get("pr").and_then(|v| v.as_i64()).unwrap_or(0)));
    }
    if pass.len() < 2 {
        log(Some(key), "bisect: the pass has no intermediate merges — the stop-bounced card owns the red; holding");
        return Ok(());
    }
    let (final_sha, final_task, _) = pass[0].clone();
    let inters: Vec<(String, String, i64)> = pass[1..].iter().rev().cloned().collect(); // oldest → newest
    if inconclusive {
        for (sha, task, pr) in &inters {
            if task.is_empty() {
                continue;
            }
            let card = ctx.mcp("get_artefact", json!({ "id": task }))?;
            if card.get("status").and_then(|v| v.as_str()) != Some("blocked") {
                continue; // already bounced (or closed) — sweep advances
            }
            renew_lease(ctx, repo, base);
            ctx.mcp("train_event", json!({
                "repo": repo, "base": base, "kind": "bounced", "pr": pr, "task_id": task,
                "bounce_kind": "coverage",
                "reason": format!("bisect inconclusive (BR#4934): the red settle's per-sha probes could not name one culprit — this pass card (merge {}) re-verifies and re-queues (oldest-first sweep)", &sha[..sha.len().min(9)]),
            }))?;
            ctx.note(&format!("bisect inconclusive: bounced pass card {task} (oldest-first sweep)"));
            log(Some(key), &format!("bisect inconclusive: PR #{pr} ({}) bounced — re-verify, re-queue (one per tick)", &sha[..sha.len().min(9)]));
            return Ok(());
        }
        renew_lease(ctx, repo, base);
        ctx.mcp("train_bisect", json!({ "repo": repo, "base": base, "inconclusive": true }))?;
        log(Some(key), "bisect inconclusive: pass fully swept — stamped on the lane stop");
        return Ok(());
    }
    // the walk: first intermediate without a stamped verdict
    let target = inters.iter().find(|(sha, _, _)| step_verdict(&steps, sha).is_none()).cloned();
    let (sha, task, pr) = match target {
        Some(t) => t,
        None => {
            // every intermediate probed GREEN → the culprit is the final
            // card (already stop-bounced — this just pins the verdict)
            renew_lease(ctx, repo, base);
            ctx.mcp("train_bisect", json!({ "repo": repo, "base": base, "culprit_task": final_task, "culprit_sha": final_sha }))?;
            ctx.note(&format!("bisect: all intermediates green — culprit pinned to final card {final_task}"));
            log(Some(key), &format!("bisect: intermediates all green — culprit = the final merge {}", &final_sha[..final_sha.len().min(9)]));
            return Ok(());
        }
    };
    let runs = ctx.check_runs(repo, &sha);
    match classify_base_check_runs(&runs, required).verdict {
        MainVerdict::Red => {
            renew_lease(ctx, repo, base);
            ctx.mcp("train_bisect", json!({ "repo": repo, "base": base, "step": { "sha": sha, "verdict": "red" }, "culprit_task": task, "culprit_sha": sha }))?;
            ctx.note(&format!("bisect: {} RED — culprit {task}", &sha[..sha.len().min(9)]));
            log(Some(key), &format!("bisect: intermediate {} RED — ONE culprit named: {task} (PR #{pr})", &sha[..sha.len().min(9)]));
        }
        MainVerdict::Green => {
            renew_lease(ctx, repo, base);
            ctx.mcp("train_bisect", json!({ "repo": repo, "base": base, "step": { "sha": sha, "verdict": "green" } }))?;
            log(Some(key), &format!("bisect: intermediate {} green — walk advances next tick", &sha[..sha.len().min(9)]));
        }
        _ => {
            // unsettled: dispatch a re-run once, then hold for the bound;
            // stalled past the CI bound → inconclusive (the sweep takes over)
            let bound_ms = TRAIN_CI_BOUND_MULTIPLIER * TRAIN_CI_TYPICAL_MINUTES * 60_000;
            match step_verdict(&steps, &sha).as_deref() {
                Some("dispatched") => {
                    let at = steps.get(&sha).and_then(|v| v.get("at")).and_then(|x| x.as_u64()).unwrap_or(0);
                    if at > 0 && now_ms().saturating_sub(at) > bound_ms {
                        renew_lease(ctx, repo, base);
                        ctx.mcp("train_bisect", json!({ "repo": repo, "base": base, "step": { "sha": sha, "verdict": "inconclusive" } }))?;
                        log(Some(key), &format!("bisect: probe {} unsettled past the CI bound — inconclusive, pass sweeps oldest-first", &sha[..sha.len().min(9)]));
                    } else {
                        log(Some(key), &format!("bisect: probe {} re-run in flight — bound in ~{}m", &sha[..sha.len().min(9)], ((bound_ms - now_ms().saturating_sub(at)) / 60_000).max(1)));
                    }
                }
                _ => {
                    if !ctx.write_allowed() {
                        log(Some(key), "IDENTITY GATE: bisect re-run dispatch withheld — gh is NOT a worker-class credential (BR#3181)");
                        return Ok(());
                    }
                    renew_lease(ctx, repo, base);
                    let mut seen = std::collections::HashSet::new();
                    let mut dispatched = 0usize;
                    for r in &runs {
                        if !seen.insert(r.name.clone()) {
                            continue; // newest run per name only
                        }
                        let ok = dispatch_check_retry(ctx, repo, base, &task, &sha, r).is_ok();
                        if ok {
                            dispatched += 1;
                        }
                    }
                    if dispatched == 0 {
                        // no runs to re-run (workflows never ran on this sha) —
                        // the walk cannot classify it
                        ctx.mcp("train_bisect", json!({ "repo": repo, "base": base, "step": { "sha": sha, "verdict": "inconclusive" } }))?;
                        log(Some(key), &format!("bisect: probe {} has no re-runnable checks — inconclusive", &sha[..sha.len().min(9)]));
                    } else {
                        ctx.mcp("train_bisect", json!({ "repo": repo, "base": base, "step": { "sha": sha, "verdict": "dispatched" } }))?;
                        ctx.note(&format!("bisect: dispatched {dispatched} re-run(s) on {}", &sha[..sha.len().min(9)]));
                        log(Some(key), &format!("bisect: dispatched {dispatched} re-run(s) on {} — polling next tick", &sha[..sha.len().min(9)]));
                    }
                }
            }
        }
    }
    Ok(())
}

/// One tick: train_status → driveLane per lane (the hub COMPUTES the queue —
/// CRITICAL first, FIFO — the executor consumes it in order, never re-derives).
fn tick(ctx: &mut Ctx) -> Result<(), String> {
    let status_body = match &ctx.lane_filter {
        Some(l) => json!({ "repo": l.split('@').next().unwrap_or("") }),
        None => json!({}),
    };
    let st = ctx.mcp("train_status", status_body)?;
    let lanes = st.get("lanes").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    if lanes.is_empty() {
        log(None, "no lanes configured — seed one via train_lane or the train_lane setting");
    }
    for lane in &lanes {
        let key = vstr(lane, "lane").unwrap_or("").to_string();
        if let Some(f) = &ctx.lane_filter {
            if &key != f {
                continue;
            }
        }
        // Daemon allowlist (MERGE_TRAIN_LANES): empty = every lane the hub
        // reports; otherwise only the named `repo@base` lanes (BR#4104).
        if !ctx.lane_allow.is_empty() && !ctx.lane_allow.iter().any(|a| a == &key) {
            continue;
        }
        // BR#4977 lane lifecycle: the hub marks a RETIRED lane (its lane card
        // is done/superseded — the base was deleted or the lane deliberately
        // closed, "never tick again"). The tick never touches it: no lease
        // traffic, no hub meta writes, no workdir spin-up.
        if lane.get("retired").and_then(|v| v.as_bool()).unwrap_or(false) {
            log(Some(&key), "lane retired (lane card closed) — skipping (BR#4977)");
            continue;
        }
        // BR#4754: remember the lane card — the one-per-episode token-rot
        // note lands there when a blind episode self-heals.
        if let Some(c) = lane.get("card").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            ctx.last_lane_card = Some(c.to_string());
        }
        // Daemon mode resolves the workdir per lane from the managed clone
        // cache (or the MERGE_TRAIN_WORKDIR override) before driving it.
        if ctx.in_process {
            let repo = key.split('@').next().unwrap_or("").to_string();
            if let Err(e) = ctx.workdir_for(&repo) {
                log(Some(&key), &format!("workdir unavailable — lane skipped this tick: {}", trunc(&e, 200)));
                continue;
            }
        }
        if let Some(q) = lane.get("queue").and_then(|v| v.as_array()) {
            let list = q
                .iter()
                .map(|c| format!("{}{}", vstr(c, "id").unwrap_or(""), if vstr(c, "priority") == Some("critical") { "!" } else { "" }))
                .collect::<Vec<_>>()
                .join(" → ");
            if !list.is_empty() {
                log(Some(&key), &format!("queue: {list}"));
            }
        }
        drive_lane(ctx, lane);
    }
    Ok(())
}

/// Entry: `bridge train [--once] [--lane repo@base] [--interval secs] [--method merge|squash|rebase]`.
pub fn run(args: &[String]) -> i32 {
    // standalone CLI form: stdout logging (journald/nohup capture both, and
    // `> train.log` users expect stdout) — the in-process daemon leg keeps
    // the stderr default, beside the dispatch loop's lines.
    prefer_stdout(true);
    let mut ctx = match Ctx::resolve(args) {
        Ok(c) => c,
        Err(e) => {
            emit("train", "", &format!("fatal: {e}"));
            return 1;
        }
    };
    if let Err(e) = ctx.preflight(true) {
        emit("train", "", &format!("fatal: {e}"));
        return 1;
    }
    if ctx.once {
        return once_run(&mut ctx);
    }
    let mut heal = crate::dispatch::AuthHeal::new();
    let mut blind: Option<BlindStreak> = None;
    loop {
        let started = now_ms();
        match tick(&mut ctx) {
            Ok(()) => {
                heal.on_hub_accepted();
                // BR#4754: a blind episode just ended — report it once so the
                // board learns WHY the lane went quiet (the token-rot class),
                // not just that it did.
                if let Some(s) = blind.take() {
                    if s.ticks >= BLIND_NOTE_MIN_TICKS {
                        board_note_token_rot(&mut ctx, &s);
                    }
                }
            }
            Err(e) => {
                log(None, &format!("tick failed: {}", trunc(&e, 300)));
                if crate::dispatch::classify_hub_error(&e) == crate::dispatch::HubErrClass::Auth {
                    let s = blind.get_or_insert(BlindStreak { since_ms: now_ms(), ticks: 0 });
                    s.ticks += 1;
                    if on_tick_auth_failure(&mut ctx, &mut heal, &e) == AuthOutcome::Park {
                        // BR#4754: fail LOUDLY and exit non-zero — a supervisor
                        // (systemd/launchd/nohup loop) restarts a fresh process
                        // that re-resolves the store and re-runs the ladder with
                        // a clean slate; the pre-fix loop instead ticked blindly
                        // forever (1,684 silent failures on the super lane).
                        let (since, ticks) = match blind.as_ref() {
                            Some(b) => (b.since_ms, b.ticks),
                            None => (now_ms(), 0),
                        };
                        log(
                            None,
                            &format!(
                                "TOKEN-BLIND — EXITING (exit 1): the hub rejected this executor's credential for {} tick(s) since {} and the auth ladder (store reload + principal re-vend) failed {} consecutive runs. A supervisor restart picks up fresh credentials; if the principal itself is dead, the operator must re-pair (`bridge pair <hub-url>`).",
                                ticks,
                                iso(since),
                                heal.streak,
                            ),
                        );
                        return 1;
                    }
                }
            }
        }
        let spent = now_ms() - started;
        std::thread::sleep(Duration::from_millis(ctx.interval_ms.saturating_sub(spent).max(1000)));
    }
}

/// `--once`: one tick, one ladder attempt on an auth-class failure (cron
/// re-runs pick up the healed pairing). Exit 0 on a clean tick, else 1.
fn once_run(ctx: &mut Ctx) -> i32 {
    match tick(ctx) {
        Ok(()) => 0,
        Err(e) => {
            log(None, &format!("tick failed: {}", trunc(&e, 300)));
            if crate::dispatch::classify_hub_error(&e) == crate::dispatch::HubErrClass::Auth {
                log(None, "auth-class failure — one ladder attempt before giving up");
                if try_auth_ladder(ctx, &mut crate::dispatch::AuthHeal::new()) {
                    return match tick(ctx) {
                        Ok(()) => 0,
                        Err(e2) => {
                            log(None, &format!("tick failed after re-vend: {}", trunc(&e2, 300)));
                            1
                        }
                    };
                }
            }
            1
        }
    }
}

/// BR#4754 — a token-rot episode: consecutive auth-class tick failures since
/// `since_ms`. Cleared by the first successful tick (which also fires the
/// one-per-episode board note once the episode is worth naming).
struct BlindStreak {
    since_ms: u64,
    ticks: u32,
}

/// A blind episode shorter than this is a hiccup (a single rotated mid-flight
/// tick), not an outage — it does not earn a board note.
const BLIND_NOTE_MIN_TICKS: u32 = 3;

/// What the daemon loop should do after an auth-classified tick failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuthOutcome {
    /// stay in the loop (ladder attempted or paced out)
    Continue,
    /// the ladder is exhausted — exit loudly (standalone daemon only)
    Park,
}

/// Shared auth failure path for BOTH daemon loops: the caller has already
/// classified the error auth-class and streaked it; this paces (the hub
/// rate-limits /api/token/repair at 6/h per row — an unpaced ladder in a 45s
/// loop would burn the mint budget in minutes) and attempts the ladder when
/// due. Returns Park when AUTH_PARK_ATTEMPTS consecutive ladder runs failed.
fn on_tick_auth_failure(ctx: &mut Ctx, heal: &mut crate::dispatch::AuthHeal, e: &str) -> AuthOutcome {
    if crate::dispatch::classify_hub_error(e) != crate::dispatch::HubErrClass::Auth {
        return AuthOutcome::Continue;
    }
    match heal.on_auth_failure(std::time::Instant::now()) {
        crate::dispatch::HealStep::Wait => AuthOutcome::Continue,
        crate::dispatch::HealStep::Attempt => {
            if try_auth_ladder(ctx, heal) {
                AuthOutcome::Continue
            } else if heal.streak >= crate::dispatch::AUTH_PARK_ATTEMPTS {
                AuthOutcome::Park
            } else {
                AuthOutcome::Continue
            }
        }
    }
}

/// One run of the BR#4754 auth ladder when a hub call comes back
/// auth-rejected. True = the ctx now carries a fresh pairing.
/// `Ok`/`Err` reasons are logged by the caller — never swallowed (the 2026-10-27
/// incidents: "repair failed" with zero why).
fn try_auth_ladder(ctx: &mut Ctx, heal: &mut crate::dispatch::AuthHeal) -> bool {
    match auth_ladder_with(&ctx.hub, &ctx.token, &|| crate::dispatch::DispatchConfig::resolve()) {
        Ok((hub, token)) => {
            ctx.hub = hub;
            ctx.token = token;
            heal.on_repair_success();
            log(None, "hub rejected the stored token — the auth ladder re-vended the pairing; re-ticking");
            true
        }
        Err(why) => {
            log(
                None,
                &format!(
                    "auth ladder failed (attempt {}/{}): {}",
                    heal.streak,
                    crate::dispatch::AUTH_PARK_ATTEMPTS,
                    trunc(&why.join("; "), 240)
                ),
            );
            false
        }
    }
}

/// BR#4754 — the train executor's auth self-heal ladder (the BR#4113
/// ladder's train-leg twin). A token-blind daemon cannot ask the hub for
/// ANYTHING under the dead bearer — but the repair route authenticates by
/// PRINCIPAL (the durable device credential, BR#2711 §2), so self-heal is
/// possible while fully blind: (1) reload the store — another process on
/// this device (the runner's dispatch loop) may have re-vended the token;
/// (2) agent-plane re-vend by principal (`repair_by_principal` —
/// headless-safe, and it PERSISTS the fresh secret to the store so a
/// supervisor-restarted process resolves it directly). The human-plane leg
/// is desktop-only by design. Returns the fresh (hub, token) to adopt.
/// The store leg is injected (see `auth_ladder_with`) so unit tests stay
/// machine-independent.
fn auth_ladder_with(
    prev_url: &str,
    prev_token: &str,
    store: &dyn Fn() -> Option<crate::dispatch::DispatchConfig>,
) -> Result<(String, String), Vec<String>> {
    let mut failures: Vec<String> = Vec::new();
    match store() {
        Some(fresh) if !fresh.token.is_empty() && fresh.token != prev_token => {
            return Ok((fresh.url, fresh.token));
        }
        Some(_) => failures.push("store token unchanged".into()),
        None => failures.push("no resolvable config in the store".into()),
    }
    let client = match reqwest::blocking::Client::builder().timeout(Duration::from_secs(30)).build() {
        Ok(c) => c,
        Err(e) => {
            failures.push(format!("repair client build failed: {e}"));
            return Err(failures);
        }
    };
    match crate::dispatch::repair_by_principal(&client, prev_url) {
        Ok(cfg) => Ok((cfg.url, cfg.token)),
        Err(e) => {
            failures.push(format!("principal repair: {e}"));
            Err(failures)
        }
    }
}

/// BR#4754 — the board-visible half of the token-rot fix. A token-blind
/// daemon is board-MUTE by construction (every hub write needs the bearer
/// the hub just rejected), so the alarm cannot fire mid-blind; what CAN
/// reach the board is the retroactive note once the ladder heals: one
/// log_progress per episode on the lane card naming the class, the window,
/// and the remedy — so the board holds the CAUSE, not just a lease-less lane.
fn board_note_token_rot(ctx: &mut Ctx, streak: &BlindStreak) {
    let Some(card) = ctx.last_lane_card.clone() else {
        return;
    };
    let did = format!(
        "token-rot episode: {} tick(s) failed 'unknown auth token' since {} — the executor self-healed via the auth ladder (store reload / principal re-vend, BR#4754) and the lane tick resumed",
        streak.ticks,
        iso(streak.since_ms)
    );
    if let Err(e) = ctx.mcp("log_progress", json!({ "id": card, "did": did, "will": "none — the executor is ticking again", "sentiment": "neutral" })) {
        log(None, &format!("token-rot board note failed (non-fatal): {}", trunc(&e, 160)));
    }
}

// ===========================================================================
// Gateway-native leg (BR#4104) — the daemon IS an opportunistic executor.
// Spawned beside the dispatch loop in dispatch::run_loop (one dispatch core
// shared by the desktop gateway and the headless `bridge` runner). Replaces
// the hand-installed systemd unit: any gateway on a stock build contends the
// lane lease, first-to-lease wins, binary updates ride the normal deploy
// path, and the identity law is enforced at the write boundary.
// ===========================================================================

/// What the daemon leg carries from the runner. Spawn-time snapshot of the
/// pairing; the per-tick `ctx_for_daemon` re-resolves the pairing so gateway
/// token rotations self-heal within one tick.
pub struct DaemonTrainConfig {
    pub hub: String,
    pub token: String,
    pub holder: String,
    pub session: String,
    pub interval_ms: u64,
    pub method: String,
    /// Lane allowlist (`repo@base`). Empty = every lane the hub reports.
    pub lanes: Vec<String>,
    pub workdir_override: Option<String>,
    pub enabled: bool,
    /// BR#4170: the read-only reconcile leg (board↔GitHub). On by default;
    /// RECONCILE_ENABLED=0 turns it off independently of the train leg.
    pub reconcile_enabled: bool,
    pub reconcile_interval_ms: u64,
    /// BR#4658: the proxy verification probe leg (read-only gh for
    /// run_success / pr_checks_green typed-await parks). On by default;
    /// PROXY_PROBES_ENABLED=0 turns it off independently.
    pub probes_enabled: bool,
    /// BR#4806: the event-driven wake leg (SSE subscription to the hub's
    /// `lane.queued` broadcast). On by default; MERGE_TRAIN_EVENTS=0 turns
    /// it off independently — the poll cadence remains the fallback.
    pub events_enabled: bool,
}

impl DaemonTrainConfig {
    pub fn from_runner(hub: &str, token: &str, label: Option<&str>) -> Self {
        let ident = label.map(|l| l.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(short_host);
        let interval_secs: u64 = std::env::var("MERGE_TRAIN_INTERVAL_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(45);
        let reconcile_secs: u64 = std::env::var("RECONCILE_INTERVAL_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(1800);
        Self {
            hub: hub.trim_end_matches('/').to_string(),
            token: token.to_string(),
            holder: std::env::var("MERGE_TRAIN_HOLDER").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| format!("merge-train@{ident}")),
            session: format!("merge-train@{ident}"),
            interval_ms: clamp_interval_secs(interval_secs) * 1000,
            method: std::env::var("MERGE_TRAIN_METHOD").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "merge".into()),
            lanes: parse_identities(&std::env::var("MERGE_TRAIN_LANES").unwrap_or_default()),
            workdir_override: std::env::var("MERGE_TRAIN_WORKDIR").ok().filter(|s| !s.is_empty()),
            enabled: env_enabled(std::env::var("MERGE_TRAIN_ENABLED").ok()),
            reconcile_enabled: env_enabled(std::env::var("RECONCILE_ENABLED").ok()),
            reconcile_interval_ms: clamp_reconcile_interval_secs(reconcile_secs) * 1000,
            probes_enabled: env_enabled(std::env::var("PROXY_PROBES_ENABLED").ok()),
            // BR#4806 event-driven tick: subscribe to the hub's `lane.queued`
            // broadcast and tick on arrival. MERGE_TRAIN_EVENTS=0 turns the
            // subscription off independently (the kill-the-event-path drill)
            // — the 45s poll cadence is the fallback and stays untouched.
            events_enabled: env_enabled(std::env::var("MERGE_TRAIN_EVENTS").ok()),
        }
    }
}

/// Spawn the in-process train leg beside the dispatch loop. The leg inherits
/// the pairing and the stop flag, runs on its own thread (a tick may take
/// seconds — the dispatch loop must not stall behind it), and NEVER kills its
/// host: panics are caught per tick, auth failures rebuild the pairing, and
/// errors just log — the 5-minute lease TTL is the designed fail-closed.
pub fn spawn_daemon_leg(hub: &str, token: &str, label: Option<&str>, stop: std::sync::Arc<AtomicBool>) -> Option<std::thread::JoinHandle<()>> {
    let cfg = DaemonTrainConfig::from_runner(hub, token, label);
    if !cfg.enabled {
        emit(
            "train",
            "",
            "gateway train leg disabled (MERGE_TRAIN_ENABLED=0) — not spawning",
        );
        return None;
    }
    // BR#4806: the event-driven wake leg (best-effort; spawn failure or
    // MERGE_TRAIN_EVENTS=0 leaves the daemon poll-only — today's behaviour)
    if cfg.events_enabled {
        spawn_wake_leg(stop.clone());
    } else {
        emit("train", "", "train wake leg disabled (MERGE_TRAIN_EVENTS=0) — poll cadence only");
    }
    let spawned = std::thread::Builder::new().name("merge-train".into()).spawn(move || daemon_loop(cfg, stop));
    match spawned {
        Ok(handle) => Some(handle),
        Err(e) => { emit("train", "", &format!("failed to spawn gateway train leg: {e}")); None }
    }
}

// ===========================================================================
// Event-driven tick (BR#4806) — the hub broadcasts `lane.queued {repo, base,
// depth}` on its push channel when a lane's derived queue transitions
// empty → non-empty; a subscribed gateway wakes and runs ONE tick on arrival.
// The tick itself is UNCHANGED: the same CAS lease acquire (a push+poll
// double-fire serializes — the second acquirer stands down), the same
// identity gate (BR#3181), the same proof-of-progress renewal (BR#4129).
// The poll cadence stays as the fallback: a missed event degrades to
// today's 45s pick-up, and MERGE_TRAIN_EVENTS=0 kills the subscription for
// the kill-the-event-path drill. Transport: the hub's SSE flavor of the
// push channel (/api/kb/sse — the same audit-event frames the browser WS
// carries), read with plain reqwest blocking so the vendored module needs
// NO new dependency in either crate.
// ===========================================================================

/// Wake flag: the SSE leg sets it when `lane.queued` names a lane this
/// daemon serves; the daemon loop's sleep slices check it and break out to
/// a tick immediately. Plain AtomicBool — std only.
static TRAIN_WAKE: AtomicBool = AtomicBool::new(false);

/// Request a tick now. Returns false when a wake was ALREADY pending — the
/// pending tick covers this event too (a burst of lane.queued collapses to
/// one tick; the tick itself re-reads live queue state from the hub).
fn request_wake() -> bool {
    !TRAIN_WAKE.swap(true, Ordering::Relaxed)
}

/// Drain the flag — true means a tick was requested since the last drain.
fn drain_wake() -> bool {
    TRAIN_WAKE.swap(false, Ordering::Relaxed)
}

/// One SSE `data:` line → wake decision. The frame shape matches the WS
/// push channel exactly: `{"type":"kb.event","event":{"op":..., "detail":
/// {…}}}`. Only `lane.queued` frames for a lane this daemon serves (the
/// MERGE_TRAIN_LANES allowlist, empty = every lane) wake the tick — every
/// other audit event on this channel is board traffic, not a wake.
fn sse_wake_on_frame(line: &str, lane_allow: &[String]) -> bool {
    let data = match line.strip_prefix("data:") {
        Some(d) => d.trim(),
        None => return false,
    };
    let v: Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(_) => return false, // keepalives (`: ping`) never reach here; junk is ignored
    };
    if v.get("type").and_then(|t| t.as_str()) != Some("kb.event") {
        return false;
    }
    let ev = match v.get("event") {
        Some(e) => e,
        None => return false,
    };
    if ev.get("op").and_then(|o| o.as_str()) != Some("lane.queued") {
        return false;
    }
    let detail = ev.get("detail").cloned().unwrap_or(Value::Null);
    let repo = detail.get("repo").and_then(|r| r.as_str()).unwrap_or("");
    if repo.is_empty() {
        return false;
    }
    let base = detail.get("base").and_then(|b| b.as_str()).unwrap_or("main");
    if !lane_allow.is_empty() && !lane_allow.iter().any(|a| a == &format!("{repo}@{base}")) {
        return false;
    }
    true
}

/// The wake leg: subscribe to the hub's SSE push channel and set the wake
/// flag on `lane.queued`. Runs beside the daemon loop until `stop`; every
/// failure backs off (5s doubling to 60s) and reconnects — the event path
/// may be dead for hours without the poll cadence ever noticing, by design.
fn wake_leg_loop(stop: std::sync::Arc<AtomicBool>) {
    let mut backoff = Duration::from_secs(5);
    // Connection generation (the keepalive watchdog, BR#4806): reqwest's
    // blocking client exposes no read timeout, so the parent WATCHES the
    // reader instead. The hub pings the stream on its 60s alarm; silence
    // past 150s (two missed pings + margin) means the connection is dead
    // (hub restart, network break). The parent bumps the generation and
    // redials; the stalled reader — blocked in a read that ALWAYS unblocks
    // eventually (CF idle bounds / TCP retransmit timeouts) — finds a stale
    // generation on wake and exits WITHOUT redialing. Bounded: at most one
    // zombie reader per dead connection, and none of them ever re-dials.
    let gen = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(1));
    loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        // pairing re-resolved per attempt — token rotations self-heal here
        // exactly as they do in ctx_for_daemon (BR#4104's law)
        let (hub, token) = match crate::dispatch::DispatchConfig::resolve() {
            Some(p) if !p.url.trim().is_empty() && !p.token.trim().is_empty() => (p.url, p.token),
            _ => (String::new(), String::new()),
        };
        if hub.trim().is_empty() || token.trim().is_empty() {
            std::thread::sleep(backoff);
            continue;
        }
        let hub = hub.trim_end_matches('/').to_string();
        // NO total timeout on this client — the stream must stay open
        // indefinitely between frames; liveness is the watchdog above.
        let client = match reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                log(None, &format!("wake leg client build failed: {}", trunc(&e.to_string(), 160)));
                std::thread::sleep(backoff);
                continue;
            }
        };
        let lane_allow = parse_identities(&std::env::var("MERGE_TRAIN_LANES").unwrap_or_default());
        let resp = client
            .get(format!("{hub}/api/kb/sse"))
            .header("authorization", format!("Bearer {token}"))
            .header("accept", "text/event-stream")
            .send();
        let resp = match resp {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                let code = r.status();
                let _ = r.error_for_status();
                log(None, &format!("wake leg dial failed ({code}) — retrying in {}s", backoff.as_secs()));
                std::thread::sleep(backoff);
                backoff = (backoff * 2).min(Duration::from_secs(60));
                continue;
            }
            Err(e) => {
                log(None, &format!("wake leg unreachable: {} — retrying in {}s", trunc(&e.to_string(), 160), backoff.as_secs()));
                std::thread::sleep(backoff);
                backoff = (backoff * 2).min(Duration::from_secs(60));
                continue;
            }
        };
        backoff = Duration::from_secs(5);
        log(None, &format!("wake leg subscribed — {hub}/api/kb/sse (lane.queued → tick, poll cadence stays as fallback)"));
        let cur = gen.load(Ordering::Relaxed);
        let (beat_tx, beat_rx) = std::sync::mpsc::channel::<()>();
        let gen_r = gen.clone();
        let stop_r = stop.clone();
        // the reader owns the response — line-oriented SSE over a BufReader
        // (blocking Response implements std::io::Read; no async runtime, no
        // new dependency in the vendored module)
        let reader = std::thread::Builder::new().name("train-wake-read".into()).spawn(move || {
            let mut stream = std::io::BufReader::new(resp);
            loop {
                let mut line = String::new();
                match stream.read_line(&mut line) {
                    Ok(0) => break, // stream closed — parent redials
                    Ok(_) => {
                        if stop_r.load(Ordering::Relaxed) || gen_r.load(Ordering::Relaxed) != cur {
                            break; // stopped, or the watchdog replaced this generation
                        }
                        let trimmed = line.trim_end_matches(['\r', '\n']);
                        if trimmed.starts_with(':') {
                            let _ = beat_tx.send(()); // keepalive comment — alive
                            continue;
                        }
                        if sse_wake_on_frame(trimmed, &lane_allow) {
                            let woke = request_wake();
                            if woke {
                                log(None, "lane.queued wake — ticking now (event-driven, BR#4806; CAS lease serializes with any concurrent poll tick)");
                            }
                        }
                        let _ = beat_tx.send(()); // any frame counts as alive
                    }
                    Err(_) => break,
                }
            }
            let _ = beat_tx.send(()); // final signal — the parent must not sit out the full silent window on a clean close
        });
        if let Err(e) = reader {
            log(None, &format!("wake leg reader spawn failed: {e} — retrying"));
            std::thread::sleep(backoff);
            continue;
        }
        loop {
            match beat_rx.recv_timeout(Duration::from_secs(150)) {
                Ok(()) => {
                    if stop.load(Ordering::Relaxed) || gen.load(Ordering::Relaxed) != cur {
                        break;
                    }
                    // alive — keep watching (Disconnected arrives next on a
                    // clean close, ending this watch immediately)
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    gen.fetch_add(1, Ordering::Relaxed); // stale reader exits, never redials
                    log(None, "wake leg stream silent >150s (keepalive lost) — redialing");
                    break;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        if stop.load(Ordering::Relaxed) {
            return;
        }
        // the stream broke: back off briefly so a hub restart cycle doesn't
        // spin the redial, then reconnect
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// Spawn the wake leg beside the daemon (shared stop flag). The leg is
/// best-effort by construction: spawn failure logs and the daemon stays
/// poll-only — identical to today's behaviour.
fn spawn_wake_leg(stop: std::sync::Arc<AtomicBool>) {
    let spawned = std::thread::Builder::new().name("train-wake".into()).spawn(move || wake_leg_loop(stop));
    if let Err(e) = spawned {
        emit("train", "", &format!("failed to spawn train wake leg (poll cadence unaffected): {e}"));
    }
}

/// Fresh Ctx for the daemon leg: pairing re-resolved (token rotations picked
/// up), env knobs re-read, in-process semantics on.
fn ctx_for_daemon(cfg: &DaemonTrainConfig) -> Result<Ctx, String> {
    // Re-resolve the pairing first — a rotated gateway token lands in the
    // keychain/config; the spawn-time snapshot is the fallback.
    let (hub, token) = match crate::dispatch::DispatchConfig::resolve() {
        Some(p) if !p.url.trim().is_empty() && !p.token.trim().is_empty() => (p.url, p.token),
        _ => (cfg.hub.clone(), cfg.token.clone()),
    };
    if hub.trim().is_empty() || token.trim().is_empty() {
        return Err("no pairing — the gateway leg needs `bridge pair` (or a signed-in desktop app)".into());
    }
    Ok(Ctx {
        http: reqwest::blocking::Client::builder().timeout(RPC_TIMEOUT).build().map_err(|e| e.to_string())?,
        hub: hub.trim_end_matches('/').to_string(),
        token,
        holder: cfg.holder.clone(),
        interval_ms: cfg.interval_ms,
        method: cfg.method.clone(),
        workdir: cfg.workdir_override.clone().unwrap_or_else(|| ".".into()),
        lane_filter: None,
        once: false,
        rpc_id: 0,
        in_process: true,
        session: cfg.session.clone(),
        worker_identities: worker_identities_from_env(),
        identity: None,
        identity_probed_ms: 0,
        identity_announced: None,
        demoted: None,
        skip_log_ms: 0,
        lane_allow: cfg.lanes.clone(),
        workdir_override: cfg.workdir_override.clone(),
        base_probe: true,
        last_action: "gateway leg tick".into(),
        last_action_ms: now_ms(),
        stall: std::collections::HashMap::new(),
        method_sub: std::collections::HashMap::new(),
        tick_batch: Vec::new(),
        tick_attempted: false,
        tick_landed: 0,
        tick_error: None,
        auto_rerun_shas: std::collections::HashSet::new(),
        auto_deploy_dispatched_shas: std::collections::HashMap::new(),
        cancelled_redundant_runs: std::collections::HashSet::new(),
        #[cfg(test)]
        sh_mock: None,
        last_lane_card: None,
    })
}

fn daemon_loop(cfg: DaemonTrainConfig, stop: std::sync::Arc<AtomicBool>) {
    // stream default (stderr) already matches this leg — see logging.rs
    log(
        None,
        &format!(
            "gateway train leg up — holder={} interval={}s lanes={} reconcile={} probes={} (in-process, identity-gated per BR#3181)",
            cfg.holder,
            cfg.interval_ms / 1000,
            if cfg.lanes.is_empty() { "all".to_string() } else { cfg.lanes.join(",") },
            if cfg.reconcile_enabled { format!("on/{}s", cfg.reconcile_interval_ms / 1000) } else { "off".to_string() },
            if cfg.probes_enabled { "on".to_string() } else { "off".to_string() },
        ),
    );
    let mut ctx = match ctx_for_daemon(&cfg) {
        Ok(c) => c,
        Err(e) => {
            log(None, &format!("leg idle — {e}"));
            return;
        }
    };
    let mut preflighted = false;
    let mut failures: u32 = 0;
    let mut ticks: u64 = 0;
    // BR#4754: the same paced auth ladder the standalone daemon runs —
    // role:"train" nodes have NO dispatch loop, so this leg is the only
    // thing that can re-vend a rotated pairing on those hosts.
    let mut heal = crate::dispatch::AuthHeal::new();
    let mut blind: Option<BlindStreak> = None;
    let mut last_reconcile: Option<std::time::Instant> = None;
    loop {
        // sleep in small slices so stop is responsive (same law as run_loop)
        // — and so a `lane.queued` wake (BR#4806) breaks out to a tick
        // immediately instead of waiting out the poll interval
        let wake = std::time::Instant::now() + Duration::from_millis(cfg.interval_ms);
        let mut woken = false;
        while std::time::Instant::now() < wake {
            if stop.load(Ordering::Relaxed) {
                log(None, "gateway train leg stopping");
                return;
            }
            if drain_wake() {
                woken = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        if stop.load(Ordering::Relaxed) {
            log(None, "gateway train leg stopping");
            return;
        }
        if woken {
            log(None, "event wake — running a tick ahead of the poll cadence (BR#4806)");
        }
        ticks += 1;
        // Proactively re-resolve the pairing every ~30 ticks (~22 min at the
        // default cadence) so token rotations never surface as 401 churn.
        if ticks % 30 == 0 {
            if let Ok(fresh) = ctx_for_daemon(&cfg) {
                ctx = fresh;
            }
        }
        if !preflighted {
            match ctx.preflight(false) {
                Ok(()) => {
                    preflighted = true;
                    failures = 0;
                    log(None, "gateway train leg preflight ok — contending lanes");
                }
                Err(e) => {
                    failures += 1;
                    if failures == 1 || failures % 20 == 0 {
                        log(None, &format!("preflight not satisfied (attempt {}) — standing down until it is: {}", failures, trunc(&e, 200)));
                    }
                    continue;
                }
            }
        }
        // A panicking tick must not kill the leg (or its host): catch, log
        // loudly, continue — the lease TTL reconciles any half-state.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| tick(&mut ctx)));
        match result {
            Ok(Ok(())) => {
                heal.on_hub_accepted();
                // BR#4754: a blind episode just ended — name it on the lane
                // card (once per episode) so the board holds the CAUSE.
                if let Some(s) = blind.take() {
                    if s.ticks >= BLIND_NOTE_MIN_TICKS {
                        board_note_token_rot(&mut ctx, &s);
                    }
                }
            }
            Ok(Err(e)) => {
                failures += 1;
                // BR#4754: the old sniff (`e.contains("401")`) missed the
                // JSON-RPC shape the hub actually returns for a dead token
                // ("unknown auth token" — no HTTP status in the string), so a
                // rotated pairing stayed broken here too on role:"train"
                // nodes (no dispatch loop to refresh the store). Classified
                // + paced ladder now; the leg NEVER exits its host.
                if crate::dispatch::classify_hub_error(&e) == crate::dispatch::HubErrClass::Auth {
                    let s = blind.get_or_insert(BlindStreak { since_ms: now_ms(), ticks: 0 });
                    s.ticks += 1;
                    if on_tick_auth_failure(&mut ctx, &mut heal, &e) == AuthOutcome::Park {
                        // the leg itself survives — it just stops hammering
                        // the ladder; the capped cadence keeps retrying (the
                        // dispatch loop's park path owns the loud surface)
                        log(None, "auth ladder exhausted — the train leg keeps ticking on the capped cadence (host loop owns the park/alarm surface)");
                    }
                }
                log(None, &format!("tick failed: {}", trunc(&e, 300)));
            }
            Err(p) => {
                let msg = p.downcast_ref::<String>().cloned().unwrap_or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()).unwrap_or_else(|| "panic".into()));
                log(None, &format!("tick PANIC (leg survives): {}", trunc(&msg, 300)));
            }
        }
        // BR#4170: the read-only board↔GitHub reconcile leg — its own cadence
        // beside the train tick, same survivability rules (a panicking pass
        // must not kill the leg; the hub owns every decision and mutation).
        if cfg.reconcile_enabled {
            let due = last_reconcile
                .map(|t| t.elapsed() >= Duration::from_millis(cfg.reconcile_interval_ms))
                .unwrap_or(true);
            if due {
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| reconcile_pass(&mut ctx)));
                match r {
                    Ok(Ok(lines)) => {
                        last_reconcile = Some(std::time::Instant::now());
                        for l in lines {
                            log(None, &l);
                        }
                    }
                    Ok(Err(e)) => log(None, &format!("[reconcile] pass failed (retries next cadence): {}", trunc(&e, 300))),
                    Err(p) => {
                        let msg = p.downcast_ref::<String>().cloned().unwrap_or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()).unwrap_or_else(|| "panic".into()));
                        log(None, &format!("[reconcile] pass PANIC (leg survives): {}", trunc(&msg, 300)));
                    }
                }
            }
        }
        // BR#4658: the proxy verification probe leg — read-only gh checks the
        // hub cannot make (it holds no VCS credentials), giving non-train
        // typed-await parks (run_success / pr_checks_green) their machine
        // closer. Runs every tick (one cheap poll; gh only when probes are
        // pending); same survivability rules as the reconcile leg.
        if cfg.probes_enabled {
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| proxy_probe_pass(&mut ctx)));
            match r {
                Ok(Ok(lines)) => {
                    for l in lines {
                        log(None, &l);
                    }
                }
                Ok(Err(e)) => log(None, &format!("[probe] pass failed (retries next tick): {}", trunc(&e, 300))),
                Err(p) => {
                    let msg = p.downcast_ref::<String>().cloned().unwrap_or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()).unwrap_or_else(|| "panic".into()));
                    log(None, &format!("[probe] pass PANIC (leg survives): {}", trunc(&msg, 300)));
                }
            }
        }
        if failures > 0 {
            failures = failures.saturating_sub(1); // a completed tick heals the breaker
        }
    }
}

/// BR#4170 — one reconcile pass: for each repo the hub's schedule lists, run
/// the read-only `gh pr list` and feed the observations to the hub. The
/// DAEMON only observes (identity read-only; it never writes the board) —
/// the HUB runs the join, decides, mutates, and alarms (reconcile.report).
fn reconcile_pass(ctx: &mut Ctx) -> Result<Vec<String>, String> {
    let schedule = ctx.mcp("reconcile_schedule", json!({}))?;
    if schedule.get("enabled").and_then(|v| v.as_bool()) != Some(true) {
        return Ok(vec!["[reconcile] disabled by hub schedule — skipping".into()]);
    }
    let repos: Vec<String> = schedule
        .get("repos")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|r| r.as_str().map(String::from)).filter(|s| !s.trim().is_empty()).collect())
        .unwrap_or_default();
    if repos.is_empty() {
        return Ok(vec!["[reconcile] hub schedule lists no repos — skipping".into()]);
    }
    let mut lines = Vec::new();
    for repo in repos {
        // Read-only by construction: `gh pr list` is the ONLY GitHub call
        // this leg makes (accepted BR#3499/BR#3507 — the gateway holds no
        // board authority and the hub holds no VCS credentials).
        let rows = match ctx.gh_json(&[
            "pr", "list", "--repo", &repo, "--state", "open", "--limit", "200",
            "--json", "number,title,reviewDecision,mergeable,mergeStateStatus,headRefOid,headRefName,updatedAt,isDraft",
        ]) {
            Ok(r) => r,
            Err(e) if e.contains("502") || e.contains("504") || e.contains("Bad Gateway") || e.contains("timeout") => {
                ctx.gh_json(&[
                    "pr", "list", "--repo", &repo, "--state", "open", "--limit", "100",
                    "--json", "number,title,reviewDecision,mergeable,mergeStateStatus,headRefOid,headRefName,updatedAt,isDraft",
                ])?
            }
            Err(e) => return Err(e),
        };
        let res = ctx.mcp("reconcile_report", json!({ "repo": repo, "prs": pr_payload(&rows) }))?;
        let line = res.get("line").and_then(|v| v.as_str()).unwrap_or("(no accounting line)");
        let ok = res.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
        lines.push(format!("[reconcile] {repo}: {line}{}", if ok { String::new() } else { " — ALARM routed to the sink".to_string() }));
    }
    Ok(lines)
}

/// Pass the `gh pr list` rows through to the hub unchanged (the hub
/// normalizes and drops junk rows) — the daemon never decides what a PR is.
fn pr_payload(rows: &Value) -> Value {
    match rows {
        Value::Array(a) => Value::Array(a.iter().filter(|r| r.is_object()).cloned().collect()),
        _ => Value::Array(Vec::new()),
    }
}

// ===========================================================================
// BR#4658 — the proxy verification probe leg. Non-train typed-await parks
// (run_success / pr_checks_green) had NO machine closer: the hub holds no
// VCS credentials (BR#3516), so its proxy sweep could never verify the gate
// (specimen BR#3621 — the run concluded SUCCESS and the card sat blocked
// ~60h past its exit). The sweep enqueues probes; THIS leg (beside the
// reconcile leg) runs the read-only gh command each probe names and feeds
// the verdict back through proxy_verify. The DAEMON only observes; the HUB
// decides (head law BR#3409, the proxy_verified event, the flip). Every gh
// call here is read-only — the same class as the reconcile leg, never
// identity-gated (BR#3181 gates WRITE legs only).
// ===========================================================================

/// What one probe observation means (pure — unit-testable). The mapping to
/// proxy_verify payloads lives in proxy_probe_pass; this enum is the whole
/// decision surface the executor owns.
#[derive(Debug, PartialEq)]
enum ProbeVerdict {
    /// The gate fired — feed ok=true with the evidence URL.
    Satisfied { receipt: String, head_sha: String, conclusion: String },
    /// The gate conclusively did NOT fire (run failed/cancelled, checks red)
    /// — feed ok=false conclusive=true; the hub stamps a negative
    /// proxy_verified and the park stands (BR#3409 fail-closed).
    Conclusive { error: String, receipt: String, conclusion: String },
    /// Nothing decidable yet (gh error, run in flight, checks pending) —
    /// feed ok=false transient; the hub backs off, attempt-capped.
    Transient { error: String },
}

/// gh emits run conclusions uppercase; SUCCESS is the only green. The
/// terminal-failure classes are conclusive (a re-poll will not change them);
/// everything else (empty, in-progress classes) stays transient.
fn classify_run_conclusion(conclusion: &str, url: &str, head_sha: &str) -> ProbeVerdict {
    match conclusion.to_ascii_uppercase().as_str() {
        "SUCCESS" => ProbeVerdict::Satisfied {
            receipt: url.to_string(),
            head_sha: head_sha.to_string(),
            conclusion: "success".into(),
        },
        "FAILURE" | "CANCELLED" | "TIMED_OUT" | "STARTUP_FAILURE" | "ACTION_REQUIRED" => ProbeVerdict::Conclusive {
            error: format!("run concluded {conclusion}"),
            receipt: url.to_string(),
            conclusion: conclusion.to_ascii_lowercase(),
        },
        _ => ProbeVerdict::Transient { error: format!("run not concluded yet (conclusion {conclusion:?})") },
    }
}

/// The newer_than form: "a run NEWER than <id> concluded success" — scan the
/// run list (newest first) for any qualifying row; none yet = transient (a
/// future run may still satisfy; one failed newer run does not falsify).
fn classify_run_list(rows: &[Value], newer_than: &str) -> ProbeVerdict {
    let floor: u64 = newer_than.parse().unwrap_or(0);
    for r in rows {
        let id = r.get("databaseId").and_then(|v| v.as_u64()).unwrap_or(0);
        let conclusion = r.get("conclusion").and_then(|v| v.as_str()).unwrap_or("");
        if id > floor && conclusion.eq_ignore_ascii_case("success") {
            return ProbeVerdict::Satisfied {
                receipt: r.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                head_sha: r.get("headSha").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                conclusion: "success".into(),
            };
        }
    }
    ProbeVerdict::Transient { error: format!("no successful run newer than {newer_than} yet") }
}

/// pr_checks_green: gh's statusCheckRollup reflects the PR's CURRENT head
/// (head-consistency by construction). SUCCESS/NEUTRAL/SKIPPED don't block;
/// the terminal-failure classes are conclusive; everything else is pending.
/// BR#6568: failing checks whose NAME matches MERGE_EXEMPT_CHECK_PATTERNS
/// (BR#2267 mechanism, BR#6001 list — the same law the head gate applies via
/// classify_head_checks) route into a NON-BLOCKING external bucket: the
/// verdict still names the exempt external in its conclusion (the receipt
/// stays the GitHub checks URL per the BR#4658 evidence contract), but it
/// SATISFIES the probe — a degraded Superpositional flow runner must not
/// park a typed pr_checks_green await (live: PR state-vector/bridge#323,
/// BR#4694). A REQUIRED (non-exempt) check failing still stamps negative,
/// and any pending check still stays transient (fail-closed, BR#3409).
fn classify_rollup(rollup: &[Value], url: &str, head_sha: &str) -> ProbeVerdict {
    if rollup.is_empty() {
        return ProbeVerdict::Transient { error: "no checks reported on the PR yet".into() };
    }
    let mut failed: Vec<String> = Vec::new();
    let mut external: Vec<String> = Vec::new();
    let mut pending = 0usize;
    for e in rollup {
        let state = e
            .get("conclusion")
            .and_then(|v| v.as_str())
            .or_else(|| e.get("state").and_then(|v| v.as_str()))
            .unwrap_or("");
        let name = e.get("name").and_then(|v| v.as_str()).or_else(|| e.get("context").and_then(|v| v.as_str())).unwrap_or("?");
        match state.to_ascii_uppercase().as_str() {
            "SUCCESS" | "NEUTRAL" | "SKIPPED" => {}
            "FAILURE" | "ERROR" | "CANCELLED" | "TIMED_OUT" | "STARTUP_FAILURE" | "ACTION_REQUIRED" => {
                if crate::train_gate::is_exempt_check_name(name) {
                    external.push(format!("{name}={state}"));
                } else {
                    failed.push(format!("{name}={state}"));
                }
            }
            _ => pending += 1,
        }
    }
    if let Some(first) = failed.first() {
        let more = if failed.len() > 1 { format!(" (+{} more)", failed.len() - 1) } else { String::new() };
        return ProbeVerdict::Conclusive {
            error: format!("checks failing: {first}{more}"),
            receipt: url.to_string(),
            conclusion: "failing".into(),
        };
    }
    if pending > 0 {
        return ProbeVerdict::Transient { error: format!("checks pending ({pending} of {} not concluded)", rollup.len()) };
    }
    if let Some(first) = external.first() {
        // green-modulo-externals: satisfied, and the verdict NAMES what was
        // exempted (BR#6568 — the atom passes, the receipt still speaks)
        let more = if external.len() > 1 { format!(" (+{} more)", external.len() - 1) } else { String::new() };
        return ProbeVerdict::Satisfied {
            receipt: url.to_string(),
            head_sha: head_sha.to_string(),
            conclusion: format!("checks green (exempt external: {first}{more})"),
        };
    }
    ProbeVerdict::Satisfied { receipt: url.to_string(), head_sha: head_sha.to_string(), conclusion: "checks green".into() }
}

/// Run the read-only gh observation for one probe — the only GitHub I/O on
/// this leg. gh errors surface as Err → reported transient (the hub backs
/// off; nothing here ever fabricates a verdict).
fn observe_probe(ctx: &Ctx, repo: &str, kind: &str, p: &Value) -> Result<ProbeVerdict, String> {
    match kind {
        "run_success" => {
            if let Some(run_id) = vstr(p, "run_id").filter(|s| !s.is_empty()) {
                let v = ctx.gh_json(&["run", "view", run_id, "--repo", repo, "--json", "conclusion,headSha,url"])?;
                Ok(classify_run_conclusion(
                    vstr(&v, "conclusion").unwrap_or(""),
                    vstr(&v, "url").unwrap_or(""),
                    vstr(&v, "headSha").unwrap_or(""),
                ))
            } else if let Some(newer) = vstr(p, "newer_than").filter(|s| !s.is_empty()) {
                let v = ctx.gh_json(&["run", "list", "--repo", repo, "--limit", "30", "--json", "databaseId,conclusion,headSha,url"])?;
                let rows = v.as_array().cloned().unwrap_or_default();
                Ok(classify_run_list(&rows, newer))
            } else {
                Ok(ProbeVerdict::Transient { error: "probe names neither run_id nor newer_than".into() })
            }
        }
        "pr_checks_green" => {
            let pr = p.get("pr").and_then(|v| v.as_i64()).unwrap_or(0);
            if pr <= 0 {
                return Ok(ProbeVerdict::Transient { error: "probe carries no PR number".into() });
            }
            let v = ctx.gh_json(&["pr", "view", &pr.to_string(), "--repo", repo, "--json", "headRefOid,statusCheckRollup,url"])?;
            let rollup = v.get("statusCheckRollup").and_then(|x| x.as_array()).cloned().unwrap_or_default();
            Ok(classify_rollup(
                &rollup,
                vstr(&v, "url").unwrap_or(""),
                vstr(&v, "headRefOid").unwrap_or(""),
            ))
        }
        other => Ok(ProbeVerdict::Transient { error: format!("unknown probe kind {other}") }),
    }
}

/// Map one probe observation to its proxy_verify payload (pure — the report
/// contract in one place). An Err observation maps to a transient report.
fn probe_report_body(key: &str, observed: Result<ProbeVerdict, String>) -> Value {
    let mut body = json!({ "key": key });
    match observed {
        Ok(ProbeVerdict::Satisfied { receipt, head_sha, conclusion }) => {
            body["ok"] = json!(true);
            body["receipt"] = json!(receipt);
            body["head_sha"] = json!(head_sha);
            body["conclusion"] = json!(conclusion);
        }
        Ok(ProbeVerdict::Conclusive { error, receipt, conclusion }) => {
            body["ok"] = json!(false);
            body["conclusive"] = json!(true);
            body["error"] = json!(error);
            body["receipt"] = json!(receipt);
            body["conclusion"] = json!(conclusion);
        }
        Ok(ProbeVerdict::Transient { error }) => {
            body["ok"] = json!(false);
            body["error"] = json!(error);
        }
        Err(e) => {
            body["ok"] = json!(false);
            body["error"] = json!(trunc(&e, 300));
        }
    }
    body
}

/// One probe pass: poll the hub's queue, observe each probe first-hand, feed
/// the verdict back. Errors NEVER fabricate satisfaction — a gh failure is
/// reported transient and the hub retries on its own backoff.
fn proxy_probe_pass(ctx: &mut Ctx) -> Result<Vec<String>, String> {
    let res = ctx.mcp("proxy_probes", json!({}))?;
    let probes = res.get("probes").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut lines = Vec::new();
    for p in &probes {
        let key = vstr(p, "key").unwrap_or("").to_string();
        let repo = vstr(p, "repo").unwrap_or("").to_string();
        let kind = vstr(p, "kind").unwrap_or("").to_string();
        if key.is_empty() || repo.is_empty() {
            continue;
        }
        let body = probe_report_body(&key, observe_probe(ctx, &repo, &kind, p));
        match ctx.mcp("proxy_verify", body) {
            Ok(rep) => {
                let verdict = rep.get("verdict").and_then(|v| v.as_str()).unwrap_or("?");
                lines.push(format!("[probe] {key}: {verdict}"));
            }
            Err(e) => {
                // the hub kept the probe (it is still ours to report next
                // tick) — log, never fabricate, never retry in-pass
                log(Some(&key), &format!("proxy_verify refused (hub retains the probe): {}", trunc(&e, 200)));
            }
        }
    }
    Ok(lines)
}

#[cfg(test)]
mod tests {
    #[test]
    fn effective_branch_rules_override_repo_merge_flags() {
        let repo = json!({"allow_merge_commit": true, "allow_squash_merge": true, "allow_rebase_merge": true});
        // Exact live #2513 incident: repo flags all true; the effective
        // ruleset permits only squash/rebase and enforces linear history.
        let rules = json!([
            {"type": "pull_request", "parameters": {"allowed_merge_methods": ["squash", "rebase"]}},
            {"type": "required_linear_history"}
        ]);
        assert_eq!(policy_merge_methods(&repo, &rules, "merge").unwrap(), vec![MergeMethod::Squash, MergeMethod::Rebase]);
        assert_eq!(policy_merge_methods(&repo, &rules, "rebase").unwrap()[0], MergeMethod::Rebase);
        assert_eq!(policy_merge_methods(&repo, &json!([]), "merge").unwrap()[0], MergeMethod::Merge);
        // Every applicable rule intersects; policy never widens another rule.
        let rules = json!([
            {"type": "pull_request", "parameters": {"allowed_merge_methods": ["merge"]}},
            {"type": "required_linear_history"}
        ]);
        assert!(policy_merge_methods(&repo, &rules, "merge").is_err());
        assert!(policy_merge_methods(&repo, &json!({"message": "Forbidden"}), "merge").is_err());
        assert!(policy_merge_methods(&json!({}), &json!([]), "merge").is_err());
        let repo = json!({"allow_merge_commit": false, "allow_squash_merge": false, "allow_rebase_merge": true});
        assert_eq!(policy_merge_methods(&repo, &json!([]), "squash").unwrap(), vec![MergeMethod::Rebase]);
    }
    use super::*;
    use std::collections::VecDeque;
    use std::io::{Read, Write as IoWrite};
    use std::sync::Mutex;

    // ---- BR#5376: the batch-stall tracker + merge-method fallback laws ----

    const T0: u64 = 1_790_000_000_000;

    fn stall(threshold: u32) -> (Vec<i64>, bool, u32) {
        (vec![2679, 2676, 2432], true, threshold)
    }

    #[test]
    fn stall_never_starts_without_an_attempt_or_a_batch_br5376() {
        let (batch, attempted, th) = stall(3);
        // no batch → idle, never stalled
        assert_eq!(stall_next(None, &[], attempted, 0, "", T0, th).0, None);
        // batch but no attempt (identity gate, pre-merge skip) → not a stall
        assert_eq!(stall_next(None, &batch, false, 0, "", T0, th).0, None);
        // any landing resets (or never starts) the episode — progress is the
        // anti-alarm
        let (next, fire) = stall_next(None, &batch, attempted, 1, "", T0, th);
        assert_eq!(next, None);
        assert!(!fire);
    }

    #[test]
    fn stall_accumulates_and_fires_exactly_once_per_episode_br5376() {
        let (batch, attempted, th) = stall(3);
        let (s1, f1) = stall_next(None, &batch, attempted, 0, "refused: not allowed", T0, th);
        let s1 = s1.unwrap();
        assert!(!f1);
        assert_eq!(s1.ticks, 1);
        assert_eq!(s1.since_ms, T0);
        assert_eq!(s1.last_error, "refused: not allowed");
        let (s2, f2) = stall_next(Some(&s1), &batch, attempted, 0, "refused: not allowed", T0 + 45_000, th);
        let s2 = s2.unwrap();
        assert!(!f2);
        assert_eq!(s2.ticks, 2);
        assert_eq!(s2.since_ms, T0, "episode start never re-inits");
        let (s3, f3) = stall_next(Some(&s2), &batch, attempted, 0, "refused: not allowed", T0 + 90_000, th);
        let s3 = s3.unwrap();
        assert!(f3, "threshold crossing fires");
        assert!(s3.fired, "the episode remembers its own alarm");
        // a REPEAT crossing never re-fires — one event per episode
        let (_s4, f4) = stall_next(Some(&s3), &batch, attempted, 0, "refused: not allowed", T0 + 135_000, th);
        assert!(!f4);
    }

    #[test]
    fn stall_resets_the_moment_anything_lands_br5376() {
        let (batch, attempted, th) = stall(3);
        let (s1, _) = stall_next(None, &batch, attempted, 0, "e", T0, th);
        let s1 = s1.unwrap();
        let (s2, f2) = stall_next(Some(&s1), &batch, attempted, 2, "e", T0 + 45_000, th);
        assert_eq!(s2, None, "a landed prefix settles the episode");
        assert!(!f2);
    }

    // ---- BR#5633: the awaiting-park sweep decision (bridge#364) ----

    fn open_pr_at(head: &str) -> Value {
        json!({ "state": "OPEN", "headRefOid": head, "mergeable": true, "mergeStateStatus": "CLEAN" })
    }

    const SWEEP_HEAD: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    /// The covered-head case: an OPEN parked card with no prior sweep stamp
    /// (or a stamp from a DIFFERENT head) is re-asserted through the audited
    /// bounce path — the hub then re-queues it (verdict covers the live
    /// head) or bounces it to impl for a fresh verify. Either way the park
    /// has its machine exit.
    #[test]
    fn awaiting_sweep_reasserts_an_open_card_br5633() {
        let a = awaiting_sweep_action("BR#1", 2518, Ok(&open_pr_at(SWEEP_HEAD)), None);
        assert_eq!(a, SweepAction::Reassert { task: "BR#1".into(), pr: 2518, head_sha: SWEEP_HEAD.into() });
        // a stamp at a DIFFERENT head never rate-limits — live facts moved
        let stamp = json!({ "head": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "outcome": "awaiting_park", "at": T0 });
        let a = awaiting_sweep_action("BR#1", 2518, Ok(&open_pr_at(SWEEP_HEAD)), Some(&stamp));
        assert!(matches!(a, SweepAction::Reassert { .. }));
    }

    /// The pr-closed case: MERGED/CLOSED PRs are skipped entirely — the
    /// landed/close path owns those cards; the sweep never speaks for them.
    #[test]
    fn awaiting_sweep_skips_non_open_prs_br5633() {
        for state in ["MERGED", "CLOSED"] {
            let facts = json!({ "state": state, "headRefOid": SWEEP_HEAD });
            let a = awaiting_sweep_action("BR#1", 2518, Ok(&facts), None);
            assert!(matches!(a, SweepAction::Skip { why, .. } if why.contains("landed/close")), "{state} must skip to the landed/close path");
        }
    }

    /// The unchanged-human-leg case: a card the hub re-parked (awaiting_park
    /// outcome) at the SAME head is rate-limited — one event per
    /// (card, head), never one per tick. Any other outcome at the same head
    /// re-asserts (the card should have LEFT the awaiting set; if it did
    /// not, it must not strand).
    #[test]
    fn awaiting_sweep_rate_limits_the_settled_human_leg_park_br5633() {
        let stamp = json!({ "head": SWEEP_HEAD, "outcome": "awaiting_park", "at": T0 });
        let a = awaiting_sweep_action("BR#1", 2518, Ok(&open_pr_at(SWEEP_HEAD)), Some(&stamp));
        assert!(matches!(a, SweepAction::Skip { why, .. } if why.contains("rate-limited")));
        for outcome in ["machine_requeue", "impl_bounce"] {
            let stamp = json!({ "head": SWEEP_HEAD, "outcome": outcome, "at": T0 });
            let a = awaiting_sweep_action("BR#1", 2518, Ok(&open_pr_at(SWEEP_HEAD)), Some(&stamp));
            assert!(matches!(a, SweepAction::Reassert { .. }), "{outcome} at an unchanged head must re-assert, not strand");
        }
    }

    /// Unreadable live facts and headless OPEN PRs fail closed: skip with no
    /// stamp, retry next tick — the sweep never asserts a head it did not
    /// read.
    #[test]
    fn awaiting_sweep_fails_closed_on_unreadable_facts_br5633() {
        let a = awaiting_sweep_action("BR#1", 2518, Err("gh: connection reset"), None);
        assert!(matches!(a, SweepAction::Skip { why, .. } if why.contains("retry next tick")));
        let headless = json!({ "state": "OPEN", "headRefOid": "" });
        let a = awaiting_sweep_action("BR#1", 2518, Ok(&headless), None);
        assert!(matches!(a, SweepAction::Skip { why, .. } if why.contains("fail closed")));
    }

    /// The wire contract: the sweep's bounce event mirrors the executor's
    /// real coverage-bounce shape, and its reason carries NONE of the
    /// human-leg vocabulary (the hub classifies a re-asserted park on the
    /// card's STORED defect/conflict files — a marker that named a human leg
    /// would strand every machine-lapsed park back into the park).
    #[test]
    fn awaiting_sweep_bounce_event_mirrors_the_real_coverage_bounce_br5633() {
        let ev = awaiting_sweep_bounce_event("state-vector/superpositional", "main", "BR#4711", 2518, SWEEP_HEAD);
        assert_eq!(ev.get("kind").and_then(|v| v.as_str()), Some("bounced"));
        assert_eq!(ev.get("bounce_kind").and_then(|v| v.as_str()), Some("coverage"));
        assert_eq!(ev.get("task_id").and_then(|v| v.as_str()), Some("BR#4711"));
        assert_eq!(ev.get("pr").and_then(|v| v.as_i64()), Some(2518));
        assert_eq!(ev.get("head_sha").and_then(|v| v.as_str()), Some(SWEEP_HEAD));
        assert_eq!(ev.get("repo").and_then(|v| v.as_str()), Some("state-vector/superpositional"));
        assert_eq!(ev.get("base").and_then(|v| v.as_str()), Some("main"));
        let reason = ev.get("reason").and_then(|v| v.as_str()).unwrap_or("");
        assert!(reason.to_lowercase().contains("awaiting sweep"), "the reason must carry the sweep marker the hub restores on");
        for banned in ["dismiss", "review", "approval", "signing environment", "key unavailable", "NO_USER", "conflict"] {
            assert!(!reason.to_lowercase().contains(&banned.to_lowercase()), "reason must not carry human-leg vocabulary: {banned}");
        }
    }

    #[test]
    fn merge_method_refusal_matches_githubs_exact_class_br5376() {
        // the 2026-10-30 → 11-01 sp outage text, verbatim from the executor log
        assert!(is_merge_method_refusal("GraphQL: Merge commits are not allowed on this repository. (mergePullRequest)"));
        assert!(is_merge_method_refusal("Squash merges are not allowed on this repository."));
        assert!(is_merge_method_refusal("Rebase merges are not allowed on this repository."));
        // BR#6673: the ruleset-era REST/gh refusal — ruleset 24656303 pins
        // allowed_merge_methods to squash+rebase (no bypass), so every
        // `gh pr merge --merge` attempt is refused with exactly this text
        assert!(is_merge_method_refusal(
            "Pull request state-vector/superpositional#2513 is not mergeable: the base branch policy prohibits the merge."
        ));
        // a PR defect or a permission refusal is NOT a method mismatch
        assert!(!is_merge_method_refusal("gh: permission denied"));
        assert!(!is_merge_method_refusal("Pull request is not up to date"));
        assert!(!is_merge_method_refusal(""));
    }

    #[test]
    fn refused_method_parse_and_fallback_order_br5376() {
        assert_eq!(refused_merge_method("GraphQL: Merge commits are not allowed on this repository. (mergePullRequest)"), Some("merge"));
        assert_eq!(refused_merge_method("Squash merges are not allowed on this repository."), Some("squash"));
        assert_eq!(refused_merge_method("gh: something else"), None);
        // BR#6673: the ruleset-era text names NO method — None is correct
        assert_eq!(
            refused_merge_method(
                "Pull request state-vector/superpositional#2513 is not mergeable: the base branch policy prohibits the merge."
            ),
            None
        );
        // sp class: configured merge refused → squash first (Ray's law), then rebase
        assert_eq!(
            merge_fallback_candidates("merge", Some("merge"), true),
            vec!["squash".to_string(), "rebase".to_string()]
        );
        // BR#6673 ruleset-era shape: the refusal names no method (None) but
        // the PRIMARY attempt was refused, so the configured method is still
        // skipped — squash first, then rebase (the standing sp landing shape)
        assert_eq!(
            merge_fallback_candidates("merge", None, true),
            vec!["squash".to_string(), "rebase".to_string()]
        );
        // a squash-configured lane refused squash → rebase, then merge
        assert_eq!(
            merge_fallback_candidates("squash", Some("squash"), true),
            vec!["rebase".to_string(), "merge".to_string()]
        );
        // the just-refused method never re-tries even when the primary
        // refusal came from a remembered sub-method
        assert_eq!(
            merge_fallback_candidates("merge", Some("squash"), false),
            vec!["rebase".to_string(), "merge".to_string()]
        );
    }

    #[test]
    fn method_flag_covers_all_three() {
        assert_eq!(method_flag_for("squash"), "--squash");
        assert_eq!(method_flag_for("rebase"), "--rebase");
        assert_eq!(method_flag_for("merge"), "--merge");
    }

    // ---- BR#5623: paginated check-run read — the base-green gate must see
    // past GitHub's default 30-entry page 1 ----

    fn filler_run(i: usize) -> Value {
        json!({
            "id": 1_000_000 + i as i64,
            "name": format!("Product surface canary (dev) #{i}"),
            "status": "completed",
            "conclusion": "success",
            "html_url": format!("https://github.example/run/{i}"),
        })
    }

    fn required_run(name: &str, id: i64) -> Value {
        json!({
            "id": id,
            "name": name,
            "status": "completed",
            "conclusion": "success",
            "html_url": format!("https://github.example/run/{id}"),
        })
    }

    const LANE_REQUIRED: [&str; 4] = [
        "deploy / Deploy to dev",
        "post-deploy / Post-Deploy Smoke",
        "post-deploy / DNS chain (front doors)",
        "post-deploy / Lodestar Storage Health",
    ];

    #[test]
    fn check_runs_pagination_finds_required_runs_past_page_one_br5623() {
        // The 2026-11-02 lane-death shape: a frozen tip with 100 scheduled
        // runs newer than the four lane-required deploy runs — page 1 (even
        // at per_page=100) holds only filler, the required runs live on
        // page 2. The old single-page read classified this exact shape as
        // verdict "empty" and blocked the lane for 10.6h.
        let page1: Vec<Value> = (0..100).map(filler_run).collect();
        let page2: Vec<Value> = LANE_REQUIRED
            .iter()
            .enumerate()
            .map(|(i, name)| required_run(name, 2_000_000 + i as i64))
            .collect();
        let runs = check_runs_from_pages(&[Some(page1), Some(page2)]);
        assert_eq!(runs.len(), 104, "both pages accumulated");
        let required: Vec<String> = LANE_REQUIRED.iter().map(|s| s.to_string()).collect();
        assert_eq!(classify_base_check_runs(&runs, &required).verdict, MainVerdict::Green);
    }

    #[test]
    fn retry_routes_workflow_and_job_ids_without_guessing_namespaces() {
        let workflows = workflow_startup_failures(&[json!({ "id": 41734497120i64, "workflow_id": 90,
            "run_attempt": 1, "name": "Deploy Health Branch Gate", "conclusion": "startup_failure", "status": "completed" })]);
        assert_eq!(check_retry_target("o/r", &workflows[0]).unwrap().endpoint("o/r"),
            "repos/o/r/actions/runs/41734497120/rerun");
        let checks = check_runs_from_pages(&[Some(vec![json!({ "id": 100, "name": "Deploy health (merge gate)",
            "check_suite": { "id": 3 }, "app": { "id": 1 }, "conclusion": "failure",
            "html_url": "https://github.com/o/r/actions/runs/200/job/300" })])]);
        assert_eq!(check_retry_target("o/r", &checks[0]).unwrap(), CheckRetryTarget::ActionsJob { id: 300 });
        assert!(check_retry_target("other/repo", &checks[0]).is_err());
        let untyped = check_runs_from_pages(&[Some(vec![json!({ "id": 41734497120i64, "name": "Gate", "conclusion": "failure" })])]);
        assert!(check_retry_target("o/r", &untyped[0]).is_err());
    }

    #[test]
    fn check_runs_fail_closed_on_a_failed_page_br5623() {
        // A None page (gh/parse failure) yields an EMPTY vec — never a
        // partial read. Downstream classifies empty as an "empty" verdict
        // and blocks the lane: the fail-closed direction is unchanged.
        let page1: Vec<Value> = (0..100).map(filler_run).collect();
        assert!(check_runs_from_pages(&[Some(page1), None]).is_empty());
        assert!(check_runs_from_pages(&[None]).is_empty());
        assert!(check_runs_from_pages(&[]).is_empty());
    }

    #[test]
    fn workflow_startup_failure_surfaces_red_on_base_and_pr_head_br6142() {
        // 2026-11-04 incident (BR#6142): PR #2707 added `actions: read` to
        // reusable deploy.yml without granting it on caller workflows. GitHub
        // Actions failed `PR` (on PR #2707) and `Deploy Dev` (on main 66c506a99)
        // with `conclusion: "startup_failure"` in `/actions/runs` and created
        // ZERO job entries in `/commits/{sha}/check-runs`.
        let wf_runs = vec![
            json!({
                "id": 41783432309i64,
                "name": "Deploy Dev",
                "status": "completed",
                "conclusion": "startup_failure",
                "html_url": "https://github.com/state-vector/superpositional/actions/runs/41783432309",
            }),
            // A workflow whose older startup_failure was superseded by a newer success must NOT report red
            json!({
                "id": 100i64,
                "name": "Deploy Health Branch Gate",
                "status": "completed",
                "conclusion": "startup_failure",
                "html_url": "https://github.com/state-vector/superpositional/actions/runs/100",
            }),
            json!({
                "id": 200i64,
                "name": "Deploy Health Branch Gate",
                "status": "completed",
                "conclusion": "success",
                "html_url": "https://github.com/state-vector/superpositional/actions/runs/200",
            }),
        ];
        let sf = workflow_startup_failures(&wf_runs);
        assert_eq!(sf.len(), 1);
        assert_eq!(sf[0].name, "Deploy Dev");
        assert_eq!(sf[0].conclusion.as_deref(), Some("startup_failure"));

        let mut base_runs = check_runs_from_pages(&[Some(vec![filler_run(1)])]);
        base_runs.extend(sf);
        let required: Vec<String> = LANE_REQUIRED.iter().map(|s| s.to_string()).collect();
        let base_verdict = classify_base_check_runs(&base_runs, &required);
        assert_eq!(base_verdict.verdict, MainVerdict::Red);
        assert_eq!(base_verdict.red.len(), 1);
        assert_eq!(base_verdict.red[0].name, "Deploy Dev");
        assert_eq!(base_verdict.red[0].conclusion, "startup_failure");
    }

    // ---- BR#5911 (F2): the self-heal stall fact — "classified fixable,
    // dispatched 0" is a loud contradiction, never a quiet no-op ----

    #[test]
    fn self_heal_stall_fact_fires_when_dispatched_zero_with_failures_br5911() {
        // gh rerun failed on every resolved run: the 5h no-op loop shape on
        // PR #2707 — classified healable, dispatched nothing, logged
        // success-shaped lines. The fact names the failure verbatim.
        let f = self_heal_stall_fact(2, 0, Some("gh: HttpError 403 — resource not accessible"));
        let f = f.expect("stalled: reds>=1, dispatched 0");
        assert_eq!(f["reds"], json!(2));
        assert_eq!(f["dispatched"], json!(0));
        assert_eq!(f["error"], json!("gh: HttpError 403 — resource not accessible"));
    }

    #[test]
    fn self_heal_stall_fact_fires_when_no_run_ids_resolved_br5911() {
        // The "resolves no run ids" cause: dispatch set empty against a red
        // verdict — still dispatched 0, still a contradiction, fact fires
        // with the no-ids error.
        let f = self_heal_stall_fact(0, 0, None).expect("stalled: no ids resolved, dispatched 0");
        assert_eq!(f["reds"], json!(0));
        assert_eq!(f["error"], json!("(no run resolved — dispatch set was empty against a red verdict)"));
    }

    #[test]
    fn self_heal_stall_fact_absent_when_dispatch_succeeded_br5911() {
        // Healthy and partial dispatches never stamp — partial failures ride
        // the normal log line's error suffix, and post-F1 the dispatch set
        // holds at most one run per check name, so a partial dispatch still
        // settles every name it re-requested; the missed name re-fires
        // RerunGate next tick (retry, not silence).
        assert!(self_heal_stall_fact(2, 2, None).is_none());
        assert!(self_heal_stall_fact(2, 1, Some("one job rerun failed")).is_none());
    }

    // ---- pure helpers: the identity law and its plumbing (BR#4104) ----

    #[test]
    fn identity_law_worker_class_by_allowlist() {
        let workers = vec!["detached-cody".to_string()];
        assert_eq!(classify_login("detached-cody", &workers), IdentityClass::Worker("detached-cody".into()));
        assert_eq!(classify_login("Detached-Cody", &workers), IdentityClass::Worker("Detached-Cody".into()));
        assert_eq!(classify_login("rayh", &workers), IdentityClass::Personal("rayh".into()));
        assert_eq!(classify_login("", &workers), IdentityClass::Unknown("".into()));
        assert_eq!(classify_login("  ", &workers), IdentityClass::Unknown("".into()));
    }

    #[test]
    fn identity_law_empty_allowlist_never_grants_writes() {
        // An empty allowlist classifies EVERY login personal — the law cannot
        // be bypassed by unsetting the env (BR#3181: merge as worker or not).
        let workers: Vec<String> = vec![];
        assert!(matches!(classify_login("detached-cody", &workers), IdentityClass::Personal(_)));
    }

    #[test]
    fn branch_provenance_worker_authored_fail_closed() {
        // BR#4687 (L1.2): the branch is machine-updatable iff EVERY commit was
        // authored by a worker-class identity — and every missing/blank/unknown
        // case fails closed to human-owned.
        let workers = vec!["detached-cody".to_string()];
        // all-worker authorship → the train owns the branch (case-insensitive)
        assert!(branch_is_worker_authored(&["detached-cody".into(), "Detached-Cody".into()], &workers));
        // ONE personal author → a protected human branch, never machine-moved
        assert!(!branch_is_worker_authored(&["detached-cody".into(), "rayh".into()], &workers));
        // empty logins (API hiccup) → fail-closed human-owned
        assert!(!branch_is_worker_authored(&[], &workers));
        // empty allowlist → every login personal → never owned
        assert!(!branch_is_worker_authored(&["detached-cody".into()], &vec![]));
        // blank/unknown login → not worker class → not owned
        assert!(!branch_is_worker_authored(&["".into()], &workers));
        assert!(!branch_is_worker_authored(&["ghost-login".into()], &workers));
    }

    #[test]
    fn intermediate_merge_without_ci_settles_only_from_proven_descendant() {
        let required = vec!["Test".to_string()];
        let run = |status: &str, conclusion: &str| MainCheckRun { id: 1, source: crate::train_gate::CheckSource::Unknown, name: "Test".into(), status: Some(status.into()),
            conclusion: Some(conclusion.into()), html_url: None };
        assert!(settle_from_descendant_ci(true, &[], &required));
        assert!(!settle_from_descendant_ci(false, &[], &required));
        assert!(!settle_from_descendant_ci(true, &[], &[]));
        assert!(!settle_from_descendant_ci(true, &[run("in_progress", "")], &required));
        assert!(!settle_from_descendant_ci(true, &[run("completed", "failure")], &required));
        assert!(!settle_from_descendant_ci(true, &[run("completed", "failure"), run("completed", "cancelled")], &required));
        assert!(!settle_from_descendant_ci(true, &[run("completed", "success")], &required));
        assert!(settle_from_descendant_ci(true, &[run("completed", "cancelled")], &required));
    }

    #[test]
    fn write_gate_allows_only_worker_class() {
        let hub = mock_hub(vec![]).0;
        let mut ctx = test_ctx(&hub);
        ctx.identity = Some(IdentityClass::Worker("detached-cody".into()));
        assert!(ctx.write_allowed());
        ctx.identity = Some(IdentityClass::Personal("rayh".into()));
        assert!(!ctx.write_allowed());
        // Unknown class is fail-closed at the classifier; a decided-Unknown
        // ctx re-probes (shells gh) so it is not asserted here.
    }

    #[test]
    fn parse_and_flags() {
        assert_eq!(parse_identities("a, b ,,c"), vec!["a", "b", "c"]);
        assert!(env_enabled(None));
        assert!(env_enabled(Some("1".into())));
        assert!(!env_enabled(Some("0".into())));
        assert!(!env_enabled(Some("false".into())));
        assert!(!env_enabled(Some(" off ".into())));
        assert_eq!(clamp_interval_secs(1), 5);
        assert_eq!(clamp_interval_secs(45), 45);
        assert_eq!(clamp_interval_secs(9_999), 240);
    }

    #[test]
    fn clone_cache_paths_are_contained() {
        let base = "/tmp/bridge-train-test";
        assert_eq!(cache_dir(base, "owner/repo"), PathBuf::from("/tmp/bridge-train-test/owner/repo"));
        assert_eq!(cache_dir(base, "owner/../repo"), PathBuf::from("/tmp/bridge-train-test/owner/repo"));
        assert_eq!(cache_dir(base, "a/b/c"), PathBuf::from("/tmp/bridge-train-test/a/b/c"));
    }

    #[test]
    fn mergeability_definitive_keys_on_the_state_answer_br4685() {
        // unanswered: missing field / null / "" / unknown / UNKNOWN — GitHub
        // has not answered, poll (never bounce, never merge)
        assert!(!mergeability_definitive(&json!({ "state": "OPEN" })));
        assert!(!mergeability_definitive(&json!({ "mergeStateStatus": null })));
        assert!(!mergeability_definitive(&json!({ "mergeStateStatus": "" })));
        assert!(!mergeability_definitive(&json!({ "mergeStateStatus": "unknown" })));
        assert!(!mergeability_definitive(&json!({ "mergeStateStatus": "UNKNOWN" }))); // raw pre-normalization shape
        // definitive: any NAMED state answers — including the bad ones (the
        // gate owns those rows; polling is only for the unanswered class)
        for s in ["clean", "CLEAN", "dirty", "behind", "blocked", "unstable"] {
            assert!(mergeability_definitive(&json!({ "mergeStateStatus": s })), "answered: {s}");
        }
    }

    #[test]
    fn poll_ladder_parses_and_defaults_br4685() {
        assert_eq!(parse_poll_secs("15,30,60"), vec![15, 30, 60]);
        assert_eq!(parse_poll_secs(" 5 , 10 "), vec![5, 10]);
        assert_eq!(parse_poll_secs("0,0,0"), vec![0, 0, 0]); // tests collapse the waits
        assert_eq!(parse_poll_secs(""), vec![15, 30, 60]); // never an empty ladder
        assert_eq!(parse_poll_secs("garbage"), vec![15, 30, 60]);
        assert_eq!(parse_poll_secs("garbage,,7"), vec![7]);
    }

    #[test]
    fn daemon_config_defaults_name_the_gateway() {
        let cfg = DaemonTrainConfig::from_runner("https://hub.example/", "tok", Some("mac-modem"));
        assert_eq!(cfg.hub, "https://hub.example");
        assert_eq!(cfg.holder, "merge-train@mac-modem");
        assert_eq!(cfg.session, "merge-train@mac-modem");
        assert_eq!(cfg.interval_ms, 45_000);
        assert!(cfg.enabled);
        assert!(cfg.lanes.is_empty());
        let nolabel = DaemonTrainConfig::from_runner("https://hub.example", "tok", None);
        assert!(nolabel.holder.starts_with("merge-train@"));
    }

    // ---- BR#4754: token rot is auth-class, heals through the ladder, and
    // ---- parks LOUDLY when the ladder is exhausted ----

    #[test]
    fn token_rot_jsonrpc_errors_classify_auth() {
        // The incident shape (1,684 consecutive super-lane failures): mcp()
        // wraps the hub's error TEXT and a rotted token carries no HTTP
        // status — the old `contains("401")` sniff and the status-prefix
        // classifier patterns both missed it.
        assert_eq!(
            crate::dispatch::classify_hub_error("hub rpc error (train_status): unknown auth token"),
            crate::dispatch::HubErrClass::Auth
        );
        assert_eq!(
            crate::dispatch::classify_hub_error("hub rpc error (train_lease): invalid auth token"),
            crate::dispatch::HubErrClass::Auth
        );
    }

    #[test]
    fn lane_lease_contention_stays_transient() {
        // NOT auth: the token is fine, another executor holds the lane.
        assert_eq!(
            crate::dispatch::classify_hub_error(
                "hub rpc error (train_lease): lane lease held live by merge-train@other — stand down this tick"
            ),
            crate::dispatch::HubErrClass::Transient
        );
    }

    #[test]
    fn auth_ladder_failure_names_every_failed_leg() {
        // Store leg injected to None (dev machines hold a REAL pairing — an
        // un-injected store leg makes this test machine-dependent), repair
        // leg aimed at a dead port: BOTH legs must be NAMED in the reasons —
        // never a bare "repair failed" (the 2026-10-27 class).
        let errs = auth_ladder_with("http://127.0.0.1:9", "sentinel-store-token", &||
            None::<crate::dispatch::DispatchConfig>)
            .expect_err("unreachable hub must fail the ladder");
        let joined = errs.join("; ");
        assert!(joined.contains("no resolvable config in the store"), "names the store leg: {joined}");
        assert!(joined.contains("principal repair:"), "names the principal-repair leg: {joined}");
    }

    #[test]
    fn auth_ladder_adopts_a_changed_store_token() {
        // Leg 1: another process (the runner's dispatch loop) re-vended the
        // store token — the ladder adopts it WITHOUT hitting the repair route.
        let fresh = crate::dispatch::DispatchConfig {
            url: "https://hub.example".into(),
            token: "fresh-from-store".into(),
            ..crate::dispatch::default_config()
        };
        let (hub, token) = auth_ladder_with("https://hub.example", "stale-snapshot", &move || {
            Some(fresh.clone())
        })
        .expect("a changed store token is a completed ladder");
        assert_eq!(token, "fresh-from-store");
        assert_eq!(hub, "https://hub.example");
    }

    #[test]
    fn both_daemon_loops_wire_the_ladder_and_park_loudly() {
        // Source-scan pin (the dispatch.rs convention): the standalone run()
        // loop AND the in-process daemon loop must classify auth errors,
        // run the injected ladder, pace it, and the standalone must exit
        // non-zero when the ladder is exhausted — a regression to the silent
        // tick-forever loop is the exact Oct-29 incident.
        let src = include_str!("train.rs");
        for needle in [
            "fn auth_ladder_with",
            "fn on_tick_auth_failure",
            "AuthOutcome::Park",
            "TOKEN-BLIND — EXITING (exit 1)",
            "fn board_note_token_rot",
            "BLIND_NOTE_MIN_TICKS",
        ] {
            assert!(src.contains(needle), "BR#4754 machinery missing: {needle}");
        }
    }

    // ---- the gate law, restated: writes flow only through worker creds ----

    #[test]
    fn progress_renewal_rides_the_seam() {
        let (hub, calls) = mock_hub(vec![
            ok(json!({ "note": "lease renewed" })),
        ]);
        let mut ctx = test_ctx(&hub);
        ctx.note("merged PR #7 as abc1234");
        assert!(renew_lease(&mut ctx, "state-vector/bridge", "main"));
        let bodies = calls.lock().unwrap().clone();
        let args = call_args(&bodies[0]);
        let progress = args.get("progress").unwrap();
        assert_eq!(progress.get("progress").and_then(|v| v.as_str()), Some("merged PR #7 as abc1234"));
        assert!(progress.get("progress_age_ms").and_then(|v| v.as_u64()).is_some());
    }

    // ---- mock hub: JSON-RPC over HTTP, scripted responses ----

    type Script = Vec<Result<Value, String>>;

    fn ok(v: Value) -> Result<Value, String> {
        Ok(v)
    }

    /// Spawns a one-thread JSON-RPC mock. Returns (base_url, recorded calls).
    /// Each recorded call is the full `params` object of the tools/call.
    fn mock_hub(script: Script) -> (String, std::sync::Arc<Mutex<Vec<Value>>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let script = std::sync::Arc::new(Mutex::new(VecDeque::from(script)));
        let calls: std::sync::Arc<Mutex<Vec<Value>>> = std::sync::Arc::new(Mutex::new(Vec::new()));
        let calls_t = calls.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = match stream {
                    Ok(s) => s,
                    Err(_) => break,
                };
                let mut buf = vec![0u8; 16 * 1024];
                let mut raw = Vec::new();
                let mut header_end = 0usize;
                loop {
                    let n = match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    raw.extend_from_slice(&buf[..n]);
                    if let Some(pos) = find_subslice(&raw, b"\r\n\r\n") {
                        header_end = pos + 4;
                        let head = String::from_utf8_lossy(&raw[..pos]);
                        let len: usize = head
                            .lines()
                            .find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().ok()))
                            .flatten()
                            .unwrap_or(0);
                        if raw.len() >= header_end + len {
                            break;
                        }
                    }
                }
                let body = String::from_utf8_lossy(&raw[header_end..]).to_string();
                let req: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                let params = req.get("params").cloned().unwrap_or(Value::Null);
                calls_t.lock().unwrap().push(params.clone());
                let next = script.lock().unwrap().pop_front();
                let payload = match next {
                    Some(Ok(v)) => json!({ "jsonrpc": "2.0", "id": 1, "result": { "content": [{ "type": "text", "text": v.to_string() }], "isError": false } }),
                    Some(Err(msg)) => json!({ "jsonrpc": "2.0", "id": 1, "error": { "code": -32000, "message": msg } }),
                    None => json!({ "jsonrpc": "2.0", "id": 1, "error": { "code": -32000, "message": "mock script exhausted" } }),
                };
                let payload = payload.to_string();
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    payload.len(),
                    payload
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
            }
        });
        (url, calls)
    }

    fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack.windows(needle.len()).position(|w| w == needle)
    }

    fn test_ctx(hub: &str) -> Ctx {
        Ctx {
            http: reqwest::blocking::Client::builder().timeout(Duration::from_secs(5)).build().unwrap(),
            hub: hub.to_string(),
            token: "test-token".into(),
            holder: "merge-train@test".into(),
            interval_ms: 45_000,
            method: "merge".into(),
            workdir: ".".into(),
            lane_filter: None,
            once: false,
            rpc_id: 0,
            in_process: true,
            session: "merge-train@test".into(),
            worker_identities: vec!["detached-cody".into()],
            identity: Some(IdentityClass::Worker("detached-cody".into())), // test ctx: pre-classified worker — no live gh probe
            identity_probed_ms: now_ms(),
            identity_announced: None,
            demoted: None,
            skip_log_ms: 0,
            lane_allow: vec![],
            workdir_override: None,
            base_probe: false, // hermetic drills — the base probe shells out to gh
            last_action: "test".into(),
            last_action_ms: now_ms(),
            stall: std::collections::HashMap::new(),
            method_sub: std::collections::HashMap::new(),
            tick_batch: Vec::new(),
            tick_attempted: false,
            tick_landed: 0,
            tick_error: None,
            auto_rerun_shas: std::collections::HashSet::new(),
            auto_deploy_dispatched_shas: std::collections::HashMap::new(),
            cancelled_redundant_runs: std::collections::HashSet::new(),
            #[cfg(test)]
            sh_mock: None,
            last_lane_card: None,
        }
    }

    fn lane() -> Value {
        json!({ "lane": "state-vector/bridge@main", "required_workflows": [], "queue": [ { "id": "BR#1" } ] })
    }

    /// A queue-head card with no PR stamp on this lane → the executor moves
    /// on and releases the lease (the minimal full-lane path that never
    /// shells out to gh/git).
    fn card_without_lane_legs() -> Value {
        json!({ "id": "BR#1", "status": "blocked", "meta": { "prs": [ { "repo": "some/other-repo", "number": 5 } ] } })
    }

    fn call_name(params: &Value) -> String {
        params.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string()
    }

    fn call_args<'a>(params: &'a Value) -> &'a Value {
        params.get("arguments").unwrap_or(&Value::Null)
    }

    #[test]
    fn lease_contention_exactly_one_executor_proceeds() {
        // Two gateways contend one lane: the first acquires and drives the
        // tick; the second's acquire hits the hub CAS and it stands down
        // with ZERO further hub calls.
        let (hub, calls) = mock_hub(vec![
            ok(json!({ "note": "lease granted — lane was free" })),                       // A: acquire
            ok(card_without_lane_legs()),                                                 // A: get_artefact
            ok(json!({ "ok": true })),                                                    // A: train_queue_facts (BR#5265 base_state stamp)
            ok(json!({ "lanes": [ { "lane": "state-vector/bridge@main", "queue": [], "currently": null, "stop": null } ] })), // A: release_if_idle status
            ok(json!({ "note": "lease released — idle" })),                               // A: release
            Err("lane lease held live by merge-train@other until 2026-10-28T00:00:00Z — stand down this tick".into()), // B: acquire CONFLICT
        ]);
        let mut a = test_ctx(&hub);
        let mut b = test_ctx(&hub);
        a.holder = "merge-train@a".into();
        b.holder = "merge-train@b".into();
        drive_lane(&mut a, &lane());
        drive_lane(&mut b, &lane());
        let recorded = calls.lock().unwrap();
        let names: Vec<String> = recorded.iter().map(call_name).collect();
        // BR#5265: the base_state stamp rides train_queue_facts whenever cars
        // are queued (even when the walk produced no verdicts — this card has
        // no unlanded legs), between the card fetch and release_if_idle; the
        // walk closes with release_if_idle's status + release, and B's only
        // hub call is the losing acquire.
        assert_eq!(names, vec!["train_lease", "get_artefact", "train_queue_facts", "train_status", "train_lease", "train_lease"]);
        // BR#4489: the acquire declares capability so the hub can starve-detect
        assert_eq!(call_args(&recorded[0]).get("merge_capable"), Some(&json!(true)));
        // B's only call is the failed acquire — it never touched the lane.
        let b_acquire = recorded.last().unwrap();
        assert_eq!(call_args(b_acquire).get("action").and_then(|v| v.as_str()), Some("acquire"));
        // and the loser's acquire still carries the hub-attributed session.
        assert_eq!(call_args(b_acquire).get("session").and_then(|v| v.as_str()), Some("merge-train@test"));
    }

    #[test]
    fn takeover_within_ttl_after_holder_lapse() {
        // Tick 1: another live holder — stand down. Tick 2 (TTL lapsed): the
        // hub grants the lease and this executor drives the lane.
        let (hub, calls) = mock_hub(vec![
            Err("lane lease held live by merge-train@other until 2026-10-28T00:00:00Z — stand down this tick".into()), // tick 1: conflict
            ok(json!({ "note": "lease granted — prior holder merge-train@other lapsed" })),                            // tick 2: acquire
            ok(card_without_lane_legs()),                                                                              // tick 2: get_artefact
            ok(json!({ "ok": true })),                                                                                // tick 2: train_queue_facts (BR#5265 base_state stamp)
            ok(json!({ "lanes": [ { "lane": "state-vector/bridge@main", "queue": [], "currently": null, "stop": null } ] })), // tick 2: status
            ok(json!({ "note": "lease released — idle" })),                                                            // tick 2: release
        ]);
        let mut ctx = test_ctx(&hub);
        drive_lane(&mut ctx, &lane()); // stands down
        drive_lane(&mut ctx, &lane()); // takes over
        let recorded = calls.lock().unwrap();
        let names: Vec<String> = recorded.iter().map(call_name).collect();
        // BR#5265: the takeover tick stamps base_state (queue_facts) before
        // release_if_idle — the walk always reports the base verdict now.
        assert_eq!(names, vec!["train_lease", "train_lease", "get_artefact", "train_queue_facts", "train_status", "train_lease"]);
        let acquire2 = call_args(&recorded[1]);
        assert_eq!(acquire2.get("action").and_then(|v| v.as_str()), Some("acquire"));
    }

    #[test]
    fn incapable_host_never_claims_the_lock_br4489() {
        // A personally-classed gateway does not even contend: zero hub calls,
        // the skip names itself (Ray's line), and no lease is taken.
        let (hub, calls) = mock_hub(vec![]);
        let mut ctx = test_ctx(&hub);
        ctx.identity = Some(IdentityClass::Personal("rayh".into()));
        drive_lane(&mut ctx, &lane());
        let recorded = calls.lock().unwrap();
        assert!(recorded.is_empty(), "incapable host must not touch the hub, got {:?}", recorded.iter().map(call_name).collect::<Vec<_>>());
        assert!(ctx.last_action.contains("cannot merge PRs"), "skip must be self-naming, got: {}", ctx.last_action);
    }

    #[test]
    fn queue_head_stampless_leg_bounces_off_the_hub_br5753() {
        // BR#5753: a queued card whose lane leg carries no PR stamp used to be
        // logged and advanced — the hub keeps matching that leg on
        // repo+base+unlanded, so the entry re-derived into lane.queue on every
        // tick, a silent zombie inflating queue.length forever. The walk now
        // bounces it off the hub (the audited impl bounce: train:bounced, gate
        // class) with the card's own merge_train.pr stamp, and the tick ends —
        // lane.queue self-heals within one tick.
        let (hub, calls) = mock_hub(vec![
            ok(json!({ "note": "lease granted — lane was free" })),   // acquire
            ok(json!({ "id": "BR#1", "status": "blocked", "meta": {
                "prs": [ { "repo": "state-vector/bridge", "number": 0 } ],
                "merge_train": { "pr": 7, "state": "queued" },
            } })),                                                    // get_artefact
            ok(json!({ "ok": true })),                                // renew_lease (bounce arm)
            ok(json!({ "ok": true })),                                // train_event bounced
            ok(json!({ "lanes": [ { "lane": "state-vector/bridge@main", "queue": [], "currently": null, "stop": null } ] })), // release_if_idle status
            ok(json!({ "note": "lease released — idle" })),           // release
        ]);
        let mut ctx = test_ctx(&hub);
        drive_lane(&mut ctx, &lane());
        let recorded = calls.lock().unwrap();
        let names: Vec<String> = recorded.iter().map(call_name).collect();
        assert_eq!(
            names,
            vec!["train_lease", "get_artefact", "train_lease", "train_event", "train_status", "train_lease"],
            "the stamp-less arm must bounce (renew → train_event) and end the tick, got {:?}",
            names
        );
        let ev = call_args(&recorded[3]);
        assert_eq!(call_name(&recorded[3]), "train_event");
        assert_eq!(ev.get("kind"), Some(&json!("bounced")));
        assert_eq!(ev.get("pr"), Some(&json!(7)), "the bounce rides the card's own merge_train.pr stamp");
        assert_eq!(ev.get("task_id"), Some(&json!("BR#1")));
        assert_eq!(ev.get("bounce_kind"), Some(&json!("gate")));
        assert!(
            String::from(ev.get("reason").and_then(|v| v.as_str()).unwrap_or("")).contains("no PR stamp"),
            "the defect must name the stamp-less leg, got: {:?}",
            ev.get("reason")
        );
    }

    #[test]
    fn queue_head_stampless_leg_without_train_stamp_advances_br5753() {
        // Fail-open residue: a stamp-less leg on a card with NO bounceable
        // merge_train.pr / stamped leg anywhere cannot call train:bounced (the
        // hub requires pr > 0) — the walk advances instead of erroring the
        // tick (the entry is not hub-queueable anymore; snapshot drift).
        let (hub, calls) = mock_hub(vec![
            ok(json!({ "note": "lease granted — lane was free" })),   // acquire
            ok(json!({ "id": "BR#1", "status": "blocked", "meta": {
                "prs": [ { "repo": "state-vector/bridge", "number": 0 } ],
            } })),                                                    // get_artefact
            ok(json!({ "ok": true })),                                // train_queue_facts (walk end)
            ok(json!({ "lanes": [ { "lane": "state-vector/bridge@main", "queue": [], "currently": null, "stop": null } ] })), // release_if_idle status
            ok(json!({ "note": "lease released — idle" })),           // release
        ]);
        let mut ctx = test_ctx(&hub);
        drive_lane(&mut ctx, &lane());
        let recorded = calls.lock().unwrap();
        let names: Vec<String> = recorded.iter().map(call_name).collect();
        assert_eq!(
            names,
            vec!["train_lease", "get_artefact", "train_queue_facts", "train_status", "train_lease"],
            "no bounceable stamp → advance (no train_event), got {:?}",
            names
        );
    }

    #[test]
    fn tick_skips_a_retired_lane_before_any_traffic_br4977() {
        // The hub marks a retired lane (its lane card is done/superseded —
        // the base was deleted or the lane was deliberately closed, the
        // BR#4772 drill-residue class). The tick consumes the status snapshot
        // and NOTHING else: no lease, no release, no workdir spin-up — a
        // further mock request would exhaust the script loud.
        let (hub, calls) = mock_hub(vec![
            ok(json!({ "lanes": [ { "lane": "state-vector/bridge@main", "retired": true, "queue": [], "currently": null, "stop": null } ] })),
        ]);
        let mut ctx = test_ctx(&hub);
        tick(&mut ctx).unwrap();
        let recorded = calls.lock().unwrap();
        let names: Vec<String> = recorded.iter().map(call_name).collect();
        assert_eq!(names, vec!["train_status"], "a retired lane must not be leased or driven, got {:?}", names);
    }

    #[test]
    fn not_found_is_the_only_missing_branch_signal_br4977() {
        // The base-existence probe retires a lane ONLY on gh's definitive
        // 404 — transient failures (auth, network, gh absent) fail open so a
        // flaky environment can never silently retire live lanes.
        assert!(not_found_err("gh api repos/o/r/branches/dead failed (exit status 1): gh: Not found (HTTP 404)"));
        assert!(!not_found_err("gh: To request access run `gh auth login`"));
        assert!(!not_found_err("dial tcp 1.2.3.4:443: connection refused"));
    }

    #[test]
    fn classify_login_pins_the_identity_law_br4489() {
        // The doctor and the claim-time gate share this decision point: a
        // worker-allowlist login is Worker, anything else (including case
        // variants and blanks) is Personal/Unknown — fail-closed.
        let ids = vec!["detached-cody".to_string()];
        assert_eq!(classify_login("detached-cody", &ids), IdentityClass::Worker("detached-cody".into()));
        assert_eq!(classify_login("  Detached-Cody ", &ids), IdentityClass::Worker("Detached-Cody".into()), "classification is case-insensitive, label preserved");
        assert_eq!(classify_login("rayh", &ids), IdentityClass::Personal("rayh".into()));
        assert!(matches!(classify_login("", &ids), IdentityClass::Unknown(_)), "empty probe → Unknown (fail-closed, re-probes)");
    }

    #[test]
    fn merge_403_self_demotes_for_the_process_lifetime_br4489() {
        // A permission refusal mid-drive: the lease is released IMMEDIATELY
        // (a demoted holder must not park the lane) and the very next tick
        // claims nothing — the demote outlives any gh re-classification.
        let (hub, calls) = mock_hub(vec![
            ok(json!({ "note": "lease granted — lane was free" })), // acquire
            Err("gh api repos/x/y/pulls/9: 403 Permission denied (resource not accessible by personal access token)".into()), // get_artefact refused
            ok(json!({ "note": "lease released — write refused" })), // release
        ]);
        let mut ctx = test_ctx(&hub);
        drive_lane(&mut ctx, &lane());
        assert!(ctx.demoted.is_some(), "403 must demote the host");
        drive_lane(&mut ctx, &lane()); // demoted: must not touch the hub at all
        let recorded = calls.lock().unwrap();
        let names: Vec<String> = recorded.iter().map(call_name).collect();
        assert_eq!(
            names,
            vec!["train_lease", "get_artefact", "train_lease"],
            "expected acquire → refused read → release, then ZERO calls from the demoted tick, got {names:?}"
        );
        let release = call_args(&recorded[2]);
        assert_eq!(release.get("action").and_then(|v| v.as_str()), Some("release"), "the demote must release the lease, not let it lapse");
    }

    #[test]
    fn identity_cache_reprobes_after_five_minutes_br4489() {
        // The ≤5-min cache, deterministically: the allowlist is a sentinel no
        // real gh login can match, so ANY probe classifies non-Worker. A fresh
        // Worker classification must stand WITHOUT probing; a stale one MUST
        // re-probe (and therefore refuse).
        let (hub, _calls) = mock_hub(vec![]);
        let mut ctx = test_ctx(&hub);
        ctx.worker_identities = vec!["test-only-no-such-worker".into()];
        ctx.identity = Some(IdentityClass::Worker("test-only-no-such-worker".into()));
        ctx.identity_probed_ms = now_ms();
        assert!(ctx.write_allowed(), "fresh classification is authoritative inside the window — a probe would have refused");
        ctx.identity_probed_ms = now_ms().saturating_sub(6 * 60_000);
        assert!(!ctx.write_allowed(), "outside the window the gate must re-probe gh (which cannot classify the sentinel as Worker)");
        assert!(ctx.identity_probed_ms >= now_ms().saturating_sub(5_000), "the re-probe must refresh the probe clock");
    }

    // ---------- BR#4170: the reconcile leg ----------

    #[test]
    fn reconcile_interval_clamp_bounds_and_default() {
        // the read-only leg may neither hammer GitHub nor go stale for a day
        assert_eq!(clamp_reconcile_interval_secs(1800), 1800);
        assert_eq!(clamp_reconcile_interval_secs(0), 300);
        assert_eq!(clamp_reconcile_interval_secs(299), 300);
        assert_eq!(clamp_reconcile_interval_secs(21_600), 21_600);
        assert_eq!(clamp_reconcile_interval_secs(u64::MAX), 21_600);
    }

    #[test]
    fn reconcile_config_defaults_on_with_30min_cadence() {
        // SEQUENTIAL env mutations (same-process tests share env): the two
        // from_runner reads below must never interleave with each other.
        // Absent env → the leg is ON (the invariant must not depend on the
        // gateway operator remembering it exists) at the default 1800s.
        std::env::remove_var("RECONCILE_ENABLED");
        let cfg = DaemonTrainConfig::from_runner("http://hub.test", "tok", Some("unit"));
        assert!(cfg.reconcile_enabled, "reconcile defaults ON");
        assert_eq!(cfg.reconcile_interval_ms, 1800 * 1000);
        // the off switch is independent of the train leg's
        std::env::set_var("RECONCILE_ENABLED", "0");
        let cfg = DaemonTrainConfig::from_runner("http://hub.test", "tok", Some("unit"));
        assert!(!cfg.reconcile_enabled);
        assert!(cfg.enabled, "train leg unaffected");
        std::env::remove_var("RECONCILE_ENABLED");
    }

    #[test]
    fn pr_payload_passes_rows_through_and_drops_junk() {
        // the daemon never decides what a PR is — objects ride unchanged,
        // everything else is dropped (the hub's normalizePr would too, but
        // the leg must not ship noise)
        let rows = json!([
            { "number": 7, "title": "x", "reviewDecision": "APPROVED" },
            "garbage",
            42,
            null,
            { "number": 9 }
        ]);
        let out = pr_payload(&rows);
        let arr = out.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0].get("number").and_then(|v| v.as_i64()), Some(7));
        assert_eq!(arr[1].get("number").and_then(|v| v.as_i64()), Some(9));
        // a non-array gh answer ships as an empty payload, never an error —
        // the hub's join decides what that means (a full missing sweep!)
        assert_eq!(pr_payload(&json!("oops")).as_array().unwrap().len(), 0);
    }

    // ---------- BR#3935: the local git plumbing is three-valued ----------

    /// A throwaway work clone with a bare `origin`, for the LOCAL git
    /// plumbing verdicts (trial_merge / is_ancestor / fetch_pr_head never
    /// touch the hub or gh). BR#3935 pins the three-valued law there:
    /// clean / conflict / git-FAILURE — the third is an Err, never a
    /// silently-folded verdict.
    struct Repo {
        dir: std::path::PathBuf,
        base_dir: std::path::PathBuf,
    }

    impl Repo {
        fn new(tag: &str) -> Repo {
            let base_dir = std::env::temp_dir().join(format!("br3935-{}-{}", tag, std::process::id()));
            let _ = std::fs::remove_dir_all(&base_dir);
            std::fs::create_dir_all(&base_dir).unwrap();
            let run = |dir: &std::path::Path, args: &[&str]| {
                let out = Command::new("git").args(args).current_dir(dir).output().unwrap();
                assert!(out.status.success(), "git {} failed: {}", args.join(" "), String::from_utf8_lossy(&out.stderr));
                String::from_utf8_lossy(&out.stdout).trim().to_string()
            };
            run(&base_dir, &["init", "-q", "--bare", "origin.git"]);
            let work = base_dir.join("work");
            run(&base_dir, &["init", "-q", "-b", "main", "work"]);
            run(&work, &["config", "user.email", "train@test"]);
            run(&work, &["config", "user.name", "train"]);
            // BR#5252: hermetic on signing machines — a global commit-gpgsign
            // (1Password SSH agent) breaks `git commit` in a non-interactive
            // test process; the fixture's commits must never sign.
            run(&work, &["config", "commit.gpgsign", "false"]);
            run(&work, &["remote", "add", "origin", base_dir.join("origin.git").to_str().unwrap()]);
            std::fs::write(work.join("f.txt"), "base line\n").unwrap();
            run(&work, &["add", "."]);
            run(&work, &["commit", "-q", "-m", "base"]);
            run(&work, &["push", "-q", "-u", "origin", "main"]);
            Repo { dir: work, base_dir }
        }

        fn git(&self, args: &[&str]) -> String {
            let out = Command::new("git").args(args).current_dir(&self.dir).output().unwrap();
            assert!(out.status.success(), "git {} failed: {}", args.join(" "), String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }

        /// New branch off main editing f.txt; returns the new head sha.
        fn side_commit(&self, branch: &str, content: &str) -> String {
            self.git(&["checkout", "-q", "-b", branch, "main"]);
            std::fs::write(self.dir.join("f.txt"), format!("{content}\n")).unwrap();
            self.git(&["commit", "-q", "-am", branch]);
            self.git(&["rev-parse", "HEAD"])
        }

        /// Advance main itself (f.txt), push; returns the new main head sha.
        fn advance_main(&self, content: &str) -> String {
            self.git(&["checkout", "-q", "main"]);
            std::fs::write(self.dir.join("f.txt"), format!("{content}\n")).unwrap();
            self.git(&["commit", "-q", "-am", "main advances"]);
            self.git(&["push", "-q", "origin", "main"]);
            self.git(&["rev-parse", "main"])
        }

        /// A Ctx for the LOCAL git-plumbing verdicts only: it never talks to
        /// the hub (trial_merge / is_ancestor / fetch_pr_head shell out to
        /// git in `workdir` and touch nothing else).
        fn ctx(&self) -> Ctx {
            Ctx {
                http: reqwest::blocking::Client::new(),
                hub: String::new(),
                token: String::new(),
                holder: String::new(),
                interval_ms: 45_000,
                method: "merge".into(),
                workdir: self.dir.to_string_lossy().to_string(),
                lane_filter: None,
                once: true,
                rpc_id: 0,
                in_process: false,
                session: String::new(),
                worker_identities: vec![],
                identity: None,
                identity_probed_ms: 0,
                identity_announced: None,
                demoted: None,
                skip_log_ms: 0,
                lane_allow: vec![],
                workdir_override: None,
                base_probe: false, // local git-plumbing verdicts only — no gh
                last_action: String::new(),
                last_action_ms: now_ms(),
                stall: std::collections::HashMap::new(),
                method_sub: std::collections::HashMap::new(),
                tick_batch: Vec::new(),
                tick_attempted: false,
                tick_landed: 0,
                tick_error: None,
                auto_rerun_shas: std::collections::HashSet::new(),
                auto_deploy_dispatched_shas: std::collections::HashMap::new(),
                cancelled_redundant_runs: std::collections::HashSet::new(),
                #[cfg(test)]
                sh_mock: None,
                last_lane_card: None,
            }
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base_dir);
        }
    }

    #[test]
    fn file_clean_but_compile_broken_stale_head_must_integrate_and_wait_for_ci() {
        let repo = Repo::new("semantic-integration");
        std::fs::write(repo.dir.join("contracts.rs"), "pub struct Metadata { pub a: u8 }\n").unwrap();
        repo.git(&["add", "contracts.rs"]);
        repo.git(&["commit", "-qm", "contract"]);
        repo.git(&["checkout", "-qb", "feature"]);
        std::fs::write(repo.dir.join("main.rs"), "mod contracts; fn main() { let _ = contracts::Metadata { a: 1 }; }\n").unwrap();
        repo.git(&["add", "main.rs"]);
        repo.git(&["commit", "-qm", "old constructor"]);
        let old = repo.git(&["rev-parse", "HEAD"]);
        repo.git(&["push", "-q", "origin", "feature:refs/pull/7/head"]);
        repo.git(&["checkout", "-q", "main"]);
        std::fs::write(repo.dir.join("contracts.rs"), "pub struct Metadata { pub a: u8, pub b: u8 }\n").unwrap();
        repo.git(&["commit", "-qam", "new required field"]);
        repo.git(&["push", "-q", "origin", "main"]);
        let base = repo.git(&["rev-parse", "HEAD"]);
        assert!(repo.ctx().trial_merge("main", &old).unwrap().0, "file merge is clean");
        repo.git(&["merge", "-q", "--no-edit", "feature"]);
        let integrated = repo.git(&["rev-parse", "HEAD"]);
        let compile = Command::new("rustc").args(["main.rs", "-o", "probe"]).current_dir(&repo.dir).output().unwrap();
        assert!(!compile.status.success());
        assert!(String::from_utf8_lossy(&compile.stderr).contains("missing field `b`"));

        let (hub, calls) = mock_hub(vec![ok(json!({"ok": true})), ok(json!({"ok": true}))]);
        let mut ctx = test_ctx(&hub);
        ctx.workdir = repo.dir.to_string_lossy().to_string();
        ctx.worker_identities = vec!["worker".into()];
        let new_head = integrated.clone();
        ctx.sh_mock = Some(std::sync::Arc::new(move |cmd, args| {
            if cmd != "gh" { return None; }
            if args.get(1) == Some(&"repos/o/r/pulls/7/commits") { return Some(Ok(json!([{"login":"worker"}]).to_string())); }
            if args.get(1) == Some(&"repos/o/r/pulls/7/update-branch") { return Some(Ok("{}".into())); }
            if args.first() == Some(&"pr") { return Some(Ok(json!({"headRefOid":new_head,"mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED"}).to_string())); }
            panic!("unexpected command {args:?}");
        }));
        let candidate = BatchCandidate { qi: 0, head_id: "BR#7".into(), pr: 7, head_sha: old.clone(), root_fix: false };
        assert_eq!(admit_current_base(&mut ctx, "o/r", "main", &candidate).unwrap(),
            IntegrationAdmission::AwaitingCi { base_sha: base, head_sha: integrated });
        let events = calls.lock().unwrap();
        assert!(events.iter().any(|c| call_name(c) == "train_carry"));
        assert!(!events.iter().any(|c| call_name(c) == "train_event"), "integration is not a merge receipt");
        assert_eq!(crate::train_gate::classify_head_checks(&[]).verdict, MainVerdict::Unsettled, "no fresh CI is never admission");
    }

    const BOGUS_SHA: &str = "0123456789abcdef0123456789abcdef01234567";

    #[test]
    fn ancestry_true_false_and_git_failure() {
        // BR#3935: merge-base exit 0/1 are the only bools; a bad object
        // (exit 128) is an Err — it used to read as `false` (behind=true),
        // the lying-bounce ingredient.
        let repo = Repo::new("anc");
        let base_sha = repo.git(&["rev-parse", "main"]);
        let main_tip = repo.advance_main("main line");
        let ctx = repo.ctx();
        assert_eq!(ctx.is_ancestor(&base_sha, &main_tip).unwrap(), true);
        assert_eq!(ctx.is_ancestor(&main_tip, &base_sha).unwrap(), false);
        assert!(ctx.is_ancestor(BOGUS_SHA, &main_tip).is_err());
    }

    #[test]
    fn trial_merge_clean_conflict_and_git_failure() {
        // BR#3935: merge-tree exit 1 is the ONLY conflict verdict; a git
        // failure (bad object) is an Err — it used to fold into clean=false
        // with an EMPTY conflict list (the lying bounce).
        let repo = Repo::new("tm");
        let ctx = repo.ctx();
        // a side branch edits the line main will also edit → divergent conflict
        let conflicting_sha = repo.side_commit("side", "side line");
        let main_tip = repo.advance_main("main line");
        // a branch touching a DIFFERENT file merges clean
        repo.git(&["checkout", "-q", "-b", "tidy", &main_tip]);
        std::fs::write(repo.dir.join("g.txt"), "elsewhere\n").unwrap();
        repo.git(&["add", "."]);
        repo.git(&["commit", "-q", "-m", "tidy"]);
        let clean_sha = repo.git(&["rev-parse", "HEAD"]);
        let (clean, files) = ctx.trial_merge("main", &clean_sha).unwrap();
        assert!(clean, "disjoint edits must merge clean");
        assert!(files.is_empty());
        let (clean, files) = ctx.trial_merge("main", &conflicting_sha).unwrap();
        assert!(!clean, "same-line divergent edits must conflict");
        assert_eq!(files, vec!["f.txt"]);
        assert!(ctx.trial_merge("main", BOGUS_SHA).is_err(), "a git failure must not read as a conflict");
    }

    #[test]
    fn merge_refusal_fallback_law_br5252() {
        // The pure law (BR#5252): the trial-merge ground truth + the ancestry
        // read outrank the gh error text — a refusal arm bounce must survive
        // BOTH guards or it is not a conflict.
        use crate::train_gate::BounceKind;
        // trial merge clean → the machine update-branch carry (unchanged).
        assert!(matches!(merge_refusal_fallback(false, true, &[]), RefusalFallback::UpdateBranch));
        assert!(matches!(merge_refusal_fallback(true, true, &["f.txt".to_string()]), RefusalFallback::UpdateBranch));
        // a real conflict: base tip NOT in the head's ancestry + files enumerated.
        assert!(matches!(merge_refusal_fallback(false, false, &["f.txt".to_string()]), RefusalFallback::ConflictBounce));
        // FILE-LESS not-clean read (the PR #332 episode's exact shape):
        // structurally impossible for a real text conflict — stale-or-infra,
        // NEVER a conflict bounce.
        assert!(matches!(merge_refusal_fallback(false, false, &[]), RefusalFallback::StaleOrInfra));
        // a 0-behind head (base tip ∈ ancestry) can NEVER bounce conflict —
        // even against a lying not-clean read with files.
        assert!(matches!(merge_refusal_fallback(true, false, &[]), RefusalFallback::StaleOrInfra));
        assert!(matches!(merge_refusal_fallback(true, false, &["f.txt".to_string()]), RefusalFallback::StaleOrInfra));
        // the two guards compose with the BR#4066 refinement: whatever the
        // event kind, a ConflictBounce only fires for enumerated files, and
        // the refinement lands every other conflict-class read as gate.
        assert_eq!(crate::train_gate::bounce_event_kind(&BounceKind::Conflict, false, 2), "conflict");
        assert_eq!(crate::train_gate::bounce_event_kind(&BounceKind::Conflict, false, 0), "gate");
        assert_eq!(crate::train_gate::bounce_event_kind(&BounceKind::Conflict, true, 0), "gate");
    }

    #[test]
    fn zero_behind_head_is_structurally_conflict_free_br5252() {
        // BR#5252 (d), pinned at the plumbing level: a head whose base tip is
        // its ANCESTOR (0 behind — the PR #332 episode's shape) trials CLEAN
        // and reads 0-behind, so the merge-refusal fallback can only take the
        // update-branch leg for it. The episode's "conflict" bounce was the
        // gh refusal lying, never the merge state.
        let repo = Repo::new("br5252");
        let ctx = repo.ctx();
        let side_sha = repo.side_commit("side", "side line"); // base NOT advanced → 0 behind
        let zero_behind = ctx.is_ancestor("origin/main", &side_sha).unwrap();
        assert!(zero_behind, "an unadvanced base tip must be the head's ancestor");
        let (clean, files) = ctx.trial_merge("main", &side_sha).unwrap();
        assert!(clean && files.is_empty(), "a 0-behind head cannot conflict with base");
        assert!(matches!(merge_refusal_fallback(zero_behind, clean, &files), RefusalFallback::UpdateBranch));
        // the contrast: base advances → the SAME head is genuinely behind and
        // conflicts — files enumerate, and the law takes the conflict leg
        // (fail-closed stays).
        let _ = repo.advance_main("main line");
        assert!(!ctx.is_ancestor("origin/main", &side_sha).unwrap());
        let (clean2, files2) = ctx.trial_merge("main", &side_sha).unwrap();
        assert!(!clean2, "same-line divergent edits must conflict");
        assert_eq!(files2, vec!["f.txt"]);
        assert!(matches!(merge_refusal_fallback(false, clean2, &files2), RefusalFallback::ConflictBounce));
    }

    #[test]
    fn fetch_pr_head_pulls_the_pull_ref_into_the_object_store() {
        // BR#3935: a head authored "on another box" — reachable only behind
        // GitHub's refs/pull/<n>/head — is a bad object in a fresh clone.
        // merge-base used to exit 128 and read as behind=true; now the
        // plumbing fails closed (Err) until fetch_pr_head lands the object.
        let repo = Repo::new("fetch");
        let pr_head = repo.side_commit("pr7", "pr line");
        // publish ONLY the pull ref (GitHub-style: the head exists behind
        // refs/pull/<n>/head, no branch) — a local bare repo accepts the push
        repo.git(&["push", "-q", "origin", "pr7:refs/pull/7/head"]);
        // fresh clone via transport (--no-local: no hardlinked object store)
        let origin = repo.base_dir.join("origin.git");
        let fresh = repo.base_dir.join("fresh");
        let out = Command::new("git")
            .args(["clone", "-q", "--no-local", origin.to_str().unwrap(), "-b", "main", fresh.to_str().unwrap()])
            .current_dir(&repo.base_dir)
            .output()
            .unwrap();
        assert!(out.status.success());
        let mut ctx = repo.ctx();
        ctx.workdir = fresh.to_string_lossy().to_string();
        assert!(ctx.is_ancestor("main", &pr_head).is_err(), "an unfetched head must fail closed, not read as behind");
        ctx.fetch_pr_head(7).unwrap();
        assert_eq!(ctx.is_ancestor("main", &pr_head).unwrap(), true, "the fetched head must be a readable object");
    }

    // ---- BR#4658: the probe verdict law (pure classifiers + report map) ----

    #[test]
    fn run_conclusion_success_is_the_only_green() {
        let v = classify_run_conclusion("success", "https://github.com/o/r/actions/runs/1", "ca18675f0f");
        assert!(matches!(v, ProbeVerdict::Satisfied { .. }));
        let v = classify_run_conclusion("SUCCESS", "https://github.com/o/r/actions/runs/1", "ca18675f0f");
        assert!(matches!(v, ProbeVerdict::Satisfied { .. }));
    }

    #[test]
    fn run_conclusion_terminal_failures_are_conclusive_never_transient() {
        for c in ["failure", "CANCELLED", "timed_out", "startup_failure", "action_required"] {
            let v = classify_run_conclusion(c, "https://github.com/o/r/actions/runs/2", "");
            assert!(matches!(v, ProbeVerdict::Conclusive { .. }), "{c} must be conclusive");
        }
    }

    #[test]
    fn run_in_flight_is_transient_never_a_verdict() {
        for c in ["", "in_progress", "queued", "unknown-future-class"] {
            let v = classify_run_conclusion(c, "https://github.com/o/r/actions/runs/3", "");
            assert!(matches!(v, ProbeVerdict::Transient { .. }), "{c:?} must stay transient (BR#3409: no fabricated verdict)");
        }
    }

    #[test]
    fn run_list_newer_than_finds_only_newer_success() {
        let rows = json!([
            { "databaseId": 500u64, "conclusion": "success", "headSha": "aaa", "url": "https://github.com/o/r/actions/runs/500" },
            { "databaseId": 400u64, "conclusion": "failure", "headSha": "bbb", "url": "https://github.com/o/r/actions/runs/400" },
            { "databaseId": 300u64, "conclusion": "success", "headSha": "ccc", "url": "https://github.com/o/r/actions/runs/300" }
        ]);
        let as_arr = rows.as_array().unwrap();
        // newer than 300: run 500 is a newer success → satisfied on IT
        let v = classify_run_list(as_arr, "300");
        match v {
            ProbeVerdict::Satisfied { receipt, head_sha, .. } => {
                assert!(receipt.ends_with("/500"));
                assert_eq!(head_sha, "aaa");
            }
            other => panic!("expected satisfied, got {other:?}"),
        }
        // newer than 500: nothing newer → transient (one failed newer run
        // does not falsify the gate — a future run may still satisfy)
        let v = classify_run_list(as_arr, "500");
        assert!(matches!(v, ProbeVerdict::Transient { .. }));
    }

    #[test]
    fn rollup_green_counts_neutral_and_skipped_as_green() {
        let rollup = json!([
            { "name": "Test", "conclusion": "SUCCESS" },
            { "name": "Lint", "state": "NEUTRAL" },
            { "name": "Gen", "state": "SKIPPED" }
        ]);
        let v = classify_rollup(rollup.as_array().unwrap(), "https://github.com/o/r/pull/9/checks", "deadbeef");
        assert!(matches!(v, ProbeVerdict::Satisfied { .. }));
    }

    #[test]
    fn rollup_red_is_conclusive_and_names_the_failing_check() {
        let rollup = json!([
            { "name": "Test", "conclusion": "SUCCESS" },
            { "name": "Rust Tests", "conclusion": "FAILURE" }
        ]);
        let v = classify_rollup(rollup.as_array().unwrap(), "https://github.com/o/r/pull/9/checks", "deadbeef");
        match v {
            ProbeVerdict::Conclusive { error, .. } => assert!(error.contains("Rust Tests=FAILURE")),
            other => panic!("expected conclusive, got {other:?}"),
        }
    }

    // ---- BR#6568: the probe path applies the BR#2267/BR#6001 external-check
    // exemption the head gate already applies — a degraded Superpositional
    // flow runner must not park a typed pr_checks_green await (live: PR
    // state-vector/bridge#323, BR#4694). ----

    #[test]
    fn rollup_exempt_external_failure_satisfies_and_names_the_external() {
        // the exact live specimen: required checks SUCCESS, only the exempt
        // external 'Superpositional' FAILURE → SATISFIED naming the external
        let rollup = json!([
            { "name": "Test", "conclusion": "SUCCESS" },
            { "name": "CLI build (packages/cli)", "conclusion": "SUCCESS" },
            { "name": "main-green gate", "conclusion": "SUCCESS" },
            { "name": "Superpositional", "conclusion": "FAILURE" }
        ]);
        let v = classify_rollup(rollup.as_array().unwrap(), "https://github.com/o/r/pull/9/checks", "deadbeef");
        match v {
            ProbeVerdict::Satisfied { conclusion, head_sha, .. } => {
                assert!(conclusion.contains("Superpositional=FAILURE"), "verdict must name the exempt external, got: {conclusion}");
                assert_eq!(head_sha, "deadbeef");
            }
            other => panic!("expected satisfied (exempt external must not fail the atom), got {other:?}"),
        }
    }

    #[test]
    fn rollup_exempt_external_failure_with_pending_stays_transient() {
        // fail-closed: exempting an external never greens an unsettled head
        let rollup = json!([
            { "name": "Test", "conclusion": null, "status": "IN_PROGRESS" },
            { "name": "Superpositional", "conclusion": "FAILURE" }
        ]);
        let v = classify_rollup(rollup.as_array().unwrap(), "u", "");
        assert!(matches!(v, ProbeVerdict::Transient { .. }));
    }

    #[test]
    fn rollup_required_check_failure_beats_exempt_external_and_stays_conclusive() {
        let rollup = json!([
            { "name": "Test", "conclusion": "FAILURE" },
            { "name": "Superpositional", "conclusion": "FAILURE" }
        ]);
        let v = classify_rollup(rollup.as_array().unwrap(), "https://github.com/o/r/pull/9/checks", "deadbeef");
        match v {
            ProbeVerdict::Conclusive { error, .. } => {
                assert!(error.contains("Test=FAILURE"), "required red must gate, got: {error}");
                assert!(!error.contains("Superpositional"), "exempt external must not ride the gating error, got: {error}");
            }
            other => panic!("expected conclusive, got {other:?}"),
        }
    }

    #[test]
    fn rollup_exempt_external_success_is_plain_green() {
        // no regression: the external succeeding keeps the plain green receipt
        let rollup = json!([
            { "name": "Test", "conclusion": "SUCCESS" },
            { "name": "Superpositional", "conclusion": "SUCCESS" }
        ]);
        let v = classify_rollup(rollup.as_array().unwrap(), "https://github.com/o/r/pull/9/checks", "deadbeef");
        match v {
            ProbeVerdict::Satisfied { conclusion, .. } => assert_eq!(conclusion, "checks green"),
            other => panic!("expected satisfied, got {other:?}"),
        }
    }

    #[test]
    fn rollup_pending_is_transient_and_empty_rollup_is_transient() {
        let rollup = json!([{ "name": "Test", "conclusion": null, "status": "IN_PROGRESS" }]);
        let v = classify_rollup(rollup.as_array().unwrap(), "u", "");
        assert!(matches!(v, ProbeVerdict::Transient { .. }));
        let v = classify_rollup(&[], "u", "");
        assert!(matches!(v, ProbeVerdict::Transient { .. }));
    }

    #[test]
    fn report_body_maps_the_three_verdicts_and_errors() {
        let sat = probe_report_body("run:o:r:1", Ok(ProbeVerdict::Satisfied { receipt: "https://github.com/o/r/actions/runs/1".into(), head_sha: "ca18675f0f".into(), conclusion: "success".into() }));
        assert_eq!(sat["ok"], json!(true));
        assert!(sat["receipt"].as_str().unwrap().starts_with("https://github.com/"));
        let con = probe_report_body("checks:o/r#9", Ok(ProbeVerdict::Conclusive { error: "checks failing: Test=FAILURE".into(), receipt: "u".into(), conclusion: "failing".into() }));
        assert_eq!(con["ok"], json!(false));
        assert_eq!(con["conclusive"], json!(true));
        let tr = probe_report_body("run:o:r:3", Ok(ProbeVerdict::Transient { error: "run not concluded yet".into() }));
        assert_eq!(tr["ok"], json!(false));
        assert!(tr.get("conclusive").is_none(), "transient must NOT claim conclusiveness");
        let err = probe_report_body("run:o:r:4", Err("gh not authed".into()));
        assert_eq!(err["ok"], json!(false));
        assert_eq!(err["error"], json!("gh not authed"));
    }

    // ---- event-driven tick (BR#4806): the SSE wake leg ----

    /// The hub's push channel carries EVERY audit event; only a `lane.queued`
    /// frame naming a lane this daemon serves may wake a tick. Everything
    /// else — board traffic, other ops, junk, keepalives — is not a wake.
    #[test]
    fn sse_frames_wake_only_on_lane_queued_for_served_lanes() {
        let frame = |op: &str, repo: &str, base: &str| {
            format!(
                "data: {}",
                json!({ "type": "kb.event", "event": { "seq": 1, "op": op, "artefact_id": "BR#1", "detail": { "repo": repo, "base": base, "depth": 1 } } })
            )
        };
        let empty: Vec<String> = vec![];
        // the wake frame itself
        assert!(sse_wake_on_frame(&frame("lane.queued", "state-vector/bridge", "main"), &empty));
        // allowlist honoured (MERGE_TRAIN_LANES)
        let allow = vec!["state-vector/superpositional@main".to_string()];
        assert!(!sse_wake_on_frame(&frame("lane.queued", "state-vector/bridge", "main"), &allow));
        assert!(sse_wake_on_frame(&frame("lane.queued", "state-vector/superpositional", "main"), &allow));
        // every other op is board traffic, never a wake
        assert!(!sse_wake_on_frame(&frame("lane.starved", "state-vector/bridge", "main"), &empty));
        assert!(!sse_wake_on_frame(&frame("train_queued", "state-vector/bridge", "main"), &empty));
        // malformed / non-event frames are ignored, never panic
        assert!(!sse_wake_on_frame("data: not json", &empty));
        assert!(!sse_wake_on_frame("data: {\"type\":\"kb.board\",\"board\":{}}", &empty));
        assert!(!sse_wake_on_frame(": ping 1793273600000", &empty));
        assert!(!sse_wake_on_frame("retry: 5000", &empty));
        // a frame missing detail is dropped fail-closed (no repo → no wake)
        assert!(!sse_wake_on_frame("data: {\"type\":\"kb.event\",\"event\":{\"op\":\"lane.queued\"}}", &empty));
    }

    /// A burst of lane.queued events collapses to ONE wake: the first sets
    /// the flag, duplicates are no-ops, and the drain clears it exactly once.
    #[test]
    fn wake_flag_dedupes_bursts_and_drains_clean() {
        drain_wake(); // whatever a parallel test left — this test owns the flag
        assert!(request_wake(), "first request flips the flag");
        assert!(!request_wake(), "a pending wake dedupes the burst");
        assert!(drain_wake(), "the drain observes the request");
        assert!(!drain_wake(), "drain clears the flag");
        assert!(!drain_wake(), "a second drain is a no-op");
    }

    /// BR#4806 double-fire pin: push and poll can both wake a tick; the CAS
    /// lease serializes them — the second acquirer stands down with ZERO
    /// further hub calls (no renew, no release, no lane driving). Same seam
    /// the concurrent-gateway tests pin; this names the push+poll case.
    #[test]
    fn push_and_poll_double_fire_second_acquirer_stands_down() {
        let (hub, calls) = mock_hub(vec![
            // the poll-side tick already holds the live lease when the
            // push-woken tick races in for the acquire
            Err("lane lease held live by merge-train@test — standing down this tick".into()),
        ]);
        let mut pushed = test_ctx(&hub);
        pushed.identity = Some(IdentityClass::Worker("detached-cody".into()));
        drive_lane(&mut pushed, &lane());
        let recorded = calls.lock().unwrap();
        // exactly one call total — the losing acquire; the loser touched nothing
        assert_eq!(recorded.len(), 1, "a stood-down tick makes no further hub calls");
        let args = call_args(&recorded[0]);
        assert_eq!(args.get("action").and_then(|v| v.as_str()), Some("acquire"));
        assert_eq!(args.get("merge_capable"), Some(&json!(true)));
    }

    #[test]
    fn rerun_failed_null_is_not_a_request_and_run_id_ignores_job_suffix_br5679() {
        assert!(!has_rerun_request(&json!({})));
        assert!(!has_rerun_request(&json!({ "rerun_failed": null })));
        assert!(has_rerun_request(&json!({ "rerun_failed": { "at": 1793680000000_i64 } })));
        assert_eq!(
            extract_actions_run_id("https://github.com/state-vector/superpositional/actions/runs/41576347395/job/125726311965"),
            Some(41576347395)
        );
        assert_eq!(
            extract_actions_run_id("https://github.com/state-vector/superpositional/actions/runs/41576347395"),
            Some(41576347395)
        );
        assert_eq!(extract_actions_run_id("https://github.example/run/999"), Some(999));
        assert_eq!(extract_actions_run_id("https://github.example/no-digits"), None);
    }

    #[test]
    fn stop_recovery_and_all_lane_arms_scope_to_required_workflows_br5679() {
        // Structural guard (BR#5679): train.rs production code must never call
        // unscoped `classify_main_check_runs(` — every base/stop/mid-drain/bisect
        // classification routes through `classify_base_check_runs(&runs, &required)`
        // so a non-required nightly failure (e.g. Guard Fixture Gate) cannot
        // trap a stopped lane after its required workflows recover green.
        let src = include_str!("train.rs");
        let prod = src.split("#[cfg(test)]").next().unwrap_or(src);
        assert!(
            !prod.contains("classify_main_check_runs("),
            "train.rs production code must use classify_base_check_runs(&runs, &required), never unscoped classify_main_check_runs"
        );
    }

    #[test]
    fn base_state_annotates_empty_alarm_and_omits_it_mid_burst_br5674_p1() {
        let tip = vec![
            MainCheckRun { id: 1, source: crate::train_gate::CheckSource::Unknown, name: "Product surface canary (dev)".into(), status: Some("completed".into()), conclusion: Some("success".into()), html_url: None },
            MainCheckRun { id: 2, source: crate::train_gate::CheckSource::Unknown, name: "Nightly Release".into(), status: Some("completed".into()), conclusion: Some("success".into()), html_url: None },
        ];
        let required = vec!["deploy / Deploy to dev".to_string()];
        // N runs read, none matched required set → alarm on base_state
        let c_unmatched = classify_base_check_runs(&tip, &required);
        let bs_unmatched = build_base_state(&c_unmatched, &required, 0);
        assert_eq!(bs_unmatched.get("verdict").and_then(|v| v.as_str()), Some("empty"));
        assert_eq!(bs_unmatched.get("scoped_to_required").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            bs_unmatched.get("alarm").and_then(|v| v.as_str()),
            Some("2 runs read, none matched required set — check names/pagination")
        );
        // mid-burst (pass_merged > 0): verdict is forced green and no false alarm rides
        let bs_burst = build_base_state(&c_unmatched, &required, 1);
        assert_eq!(bs_burst.get("verdict").and_then(|v| v.as_str()), Some("green"));
        assert!(bs_burst.get("alarm").is_none());
        // zero total runs on tip → sibling alarm
        let c_zero = classify_base_check_runs(&[], &required);
        let bs_zero = build_base_state(&c_zero, &required, 0);
        assert_eq!(bs_zero.get("verdict").and_then(|v| v.as_str()), Some("empty"));
        assert_eq!(
            bs_zero.get("alarm").and_then(|v| v.as_str()),
            Some("tip carries no check runs at all")
        );
    }

    #[test]
    fn base_state_stamps_the_gate_blocked_qualifier_br5883() {
        // The 2026-11-03 starve stamp: scoped green + `Deploy drift alarm`
        // red on the tip → base_state carries the qualifier whole (verdict
        // STAYS green — BR#5265 law — but a plain green is never certified).
        let tip = vec![
            MainCheckRun { id: 1, source: crate::train_gate::CheckSource::Unknown, name: "Test".into(), status: Some("completed".into()), conclusion: Some("success".into()), html_url: None },
            MainCheckRun { id: 2, source: crate::train_gate::CheckSource::Unknown, name: "Deploy drift alarm".into(), status: Some("completed".into()), conclusion: Some("failure".into()), html_url: Some("https://example.test/drift".into()) },
        ];
        let required = vec!["Test".to_string(), "main-green gate".to_string()];
        let c = classify_base_check_runs(&tip, &required);
        assert_eq!(c.verdict, MainVerdict::Green);
        let bs = build_base_state(&c, &required, 0);
        assert_eq!(bs.get("verdict").and_then(|v| v.as_str()), Some("green"));
        assert_eq!(bs.get("gate_blocked").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(bs.get("gate_verdict").and_then(|v| v.as_str()), Some("red"));
        assert_eq!(bs.pointer("/gate_red/0/name").and_then(|v| v.as_str()), Some("Deploy drift alarm"));
        assert_eq!(bs.pointer("/gate_red/0/url").and_then(|v| v.as_str()), Some("https://example.test/drift"));
        // honest green (no qualifier) → no gate fields on the stamp
        let tip_green = vec![
            MainCheckRun { id: 1, source: crate::train_gate::CheckSource::Unknown, name: "Test".into(), status: Some("completed".into()), conclusion: Some("success".into()), html_url: None },
            MainCheckRun { id: 2, source: crate::train_gate::CheckSource::Unknown, name: "Deploy drift alarm".into(), status: Some("completed".into()), conclusion: Some("success".into()), html_url: None },
        ];
        let bs_green = build_base_state(&classify_base_check_runs(&tip_green, &required), &required, 0);
        assert!(bs_green.get("gate_blocked").is_none());
        assert!(bs_green.get("gate_red").is_none());
        // mid-burst: forced green composes away the qualifier (the pass
        // settle owns destination-green, BR#4934)
        let bs_burst = build_base_state(&c, &required, 1);
        assert_eq!(bs_burst.get("verdict").and_then(|v| v.as_str()), Some("green"));
        assert!(bs_burst.get("gate_blocked").is_none());
    }

    #[test]
    fn recovery_retry_needs_durable_authorization_and_never_retries_known_capability_defects() {
        let head = "7".repeat(40);
        let lane = json!({ "line": { "recoveries": [{ "episode": { "id": "cause", "head_sha": head,
            "cause": { "kind": "check_failure", "check": "Deploy smoke" },
            "stage": { "phase": "diagnosing", "task_id": "BR#1" } } }] } });
        let (hub, calls) = mock_hub(vec![ok(json!({ "authorized": true }))]);
        let mut ctx = test_ctx(&hub);
        assert!(request_main_recovery_retry(&mut ctx, &lane, "o/r", "main", &head).is_some());
        assert_eq!(call_name(&calls.lock().unwrap()[0]), "train_recovery_event");
        let (refused, _) = mock_hub(vec![ok(json!({ "authorized": false }))]);
        assert!(request_main_recovery_retry(&mut test_ctx(&refused), &lane, "o/r", "main", &head).is_none());
        let known = json!({ "line": { "recoveries": [{ "episode": { "id": "cause", "head_sha": head,
            "cause": { "kind": "capability_unavailable", "check": "Deploy smoke", "scenario": "php-sql-injection", "capability": "callers", "scope": "User.php" },
            "stage": { "phase": "repairing", "task_id": "BR#1" } } }] } });
        let (untouched, calls) = mock_hub(vec![]);
        assert!(request_main_recovery_retry(&mut test_ctx(&untouched), &known, "o/r", "main", &head).is_none());
        assert!(calls.lock().unwrap().is_empty());
    }

    #[test]
    fn synthetic_dark_tip_drill_dispatches_once_cancels_redundant_and_merges_when_green_br6179() {
        // Synthetic dark-tip drill (BR#6179 Done-When):
        // - Tick 1 (dark tip 7f5efec2, 17m old, zero required check runs, only DHR ran):
        //   executor auto-dispatches `gh workflow run deploy-dev.yml --repo state-vector/superpositional --ref main`
        //   ONCE for 7f5efec2, stamps `deploy_coverage: { phase: "uncovered_dispatched", ... }`
        //   and `covered_by: ebbe1826...` in `train_queue_facts`, holds queued PR #2880 without bouncing.
        // - Tick 2 (dispatched run 41798951196 is in_progress + duplicate push run 41798949143 is queued
        //   for the SAME sha 7f5efec2): executor does NOT re-dispatch `deploy-dev.yml`, cancels the
        //   redundant queued run (`gh run cancel 41798949143`), stamps `cancelled_redundant_runs: [41798949143]`.
        // - Tick 3 (deploy + post-deploy jobs settle green on 7f5efec2): executor stamps
        //   `deploy_coverage: { phase: "covered", covered_by_sha: 7f5efec2... }` and merges PR #2880
        //   (`gh pr merge 2880` -> `train_event` `kind: "merged"`), zero human legs.
        let repo = "state-vector/superpositional";
        let dark_tip = "7f5efec26cc5b715ef0ff42eb8ebbf2da0fc1a6f";
        let prev_green = "ebbe182633c5351f5bcbc9cd6d4924659bd604a2";
        let pr_head = "9533e5ffbc0b3c94f420adb24fd58f1b297a137b";
        let merged_sha = "dd91af5f33c5351f5bcbc9cd6d4924659bd604a2";
        let required = vec![
            "deploy / Deploy to dev".to_string(),
            "post-deploy / Post-Deploy Smoke".to_string(),
            "post-deploy / DNS chain".to_string(),
            "post-deploy / Lodestar Storage Health".to_string(),
        ];
        let lane_val = json!({
            "lane": "state-vector/superpositional@main",
            "required_workflows": required,
            "queue": [{ "id": "BR#6165", "pr": 2880 }]
        });
        let card_val = json!({
            "id": "BR#6165",
            "status": "blocked",
            "meta": {
                "prs": [{
                    "repo": repo,
                    "number": 2880,
                    "head_sha_at_acceptance": pr_head
                }],
                "merge_train": { "pr": 2880, "state": "queued" }
            }
        });

        let (hub, calls) = mock_hub(vec![
            // ---- Tick 1 (dark tip -> auto-dispatch deploy-dev.yml, hold car) ----
            ok(json!({ "note": "lease granted" })),      // train_lease acquire
            ok(card_val.clone()),                        // get_artefact BR#6165
            ok(json!({ "ok": true })),                   // train_queue_facts
            ok(json!({ "lanes": [{ "lane": "state-vector/superpositional@main", "queue": [{ "id": "BR#6165" }], "currently": null, "stop": null }] })), // release_if_idle status
            ok(json!({ "note": "lease released" })),     // train_lease release
            // ---- Tick 2 (in_progress + redundant queued -> cancel 41798949143, no 2nd dispatch) ----
            ok(json!({ "note": "lease granted" })),      // train_lease acquire
            ok(json!({ "ok": true })),                   // independent deployment observation
            ok(card_val.clone()),                        // get_artefact BR#6165
            ok(json!({ "ok": true })),                   // train_queue_facts
            ok(json!({ "lanes": [{ "lane": "state-vector/superpositional@main", "queue": [{ "id": "BR#6165" }], "currently": null, "stop": null }] })), // release_if_idle status
            ok(json!({ "note": "lease released" })),     // train_lease release
            // ---- Tick 3 (base settled green -> PR #2880 merges, burst_settle_feed) ----
            ok(json!({ "note": "lease granted" })),      // train_lease acquire
            ok(json!({ "ok": true })),                   // independent deployment observation
            ok(card_val.clone()),                        // get_artefact BR#6165
            ok(json!({ "ok": true })),                   // renew_lease (Merge candidate arm)
            ok(json!({ "ok": true })),                   // train_queue_facts (ready)
            ok(json!({ "ok": true })),                   // renew_lease (before merge)
            ok(json!({ "ok": true })),                   // train_event (merged)
            ok(json!({ "ok": true })),                   // renew_lease (burst_settle_feed)
            ok(json!({ "decided": "pending" })),         // train_ci (burst_settle_feed)
        ]);

        let tick_phase = std::sync::Arc::new(Mutex::new(1u32));
        let pr_merged_flag = std::sync::Arc::new(Mutex::new(false));
        let sh_log: std::sync::Arc<Mutex<Vec<String>>> = std::sync::Arc::new(Mutex::new(Vec::new()));
        let tick_phase_c = tick_phase.clone();
        let pr_merged_c = pr_merged_flag.clone();
        let sh_log_c = sh_log.clone();

        let mut ctx = test_ctx(&hub);
        ctx.base_probe = true;
        ctx.identity = Some(IdentityClass::Worker("detached-cody".into()));
        ctx.sh_mock = Some(std::sync::Arc::new(move |cmd, args| {
            let line = format!("{cmd} {}", args.join(" "));
            sh_log_c.lock().unwrap().push(line.clone());
            let phase = *tick_phase_c.lock().unwrap();
            if cmd == "git" {
                return Some(Ok(String::new()));
            }
            if cmd == "gh" {
                if args == ["api", "repos/state-vector/superpositional"] {
                    return Some(Ok(json!({"allow_merge_commit": true, "allow_squash_merge": true, "allow_rebase_merge": true}).to_string()));
                }
                if args == ["api", "repos/state-vector/superpositional/rules/branches/main"] {
                    return Some(Ok(json!([{"type": "required_linear_history"}, {"type": "pull_request", "parameters": {"allowed_merge_methods": ["squash", "rebase"]}}]).to_string()));
                }
                if args.first() == Some(&"workflow") && args.get(1) == Some(&"run") {
                    return Some(Ok(String::new()));
                }
                if args.first() == Some(&"run") && args.get(1) == Some(&"cancel") {
                    return Some(Ok(String::new()));
                }
                if args.first() == Some(&"pr") && args.get(1) == Some(&"merge") {
                    assert!(args.contains(&"--squash"), "effective rules prohibit --merge even though repository flags allow it");
                    assert!(!args.contains(&"--admin"), "method selection must not bypass checks");
                    *pr_merged_c.lock().unwrap() = true;
                    return Some(Ok("merged".into()));
                }
                if args.first() == Some(&"pr") && args.get(1) == Some(&"view") {
                    let is_merged = *pr_merged_c.lock().unwrap();
                    return Some(Ok(if is_merged {
                        json!({
                            "number": 2880,
                            "headRefOid": pr_head,
                            "mergeable": "MERGEABLE",
                            "mergeStateStatus": "CLEAN",
                            "state": "MERGED",
                            "mergeCommit": { "oid": merged_sha },
                            "baseRefName": "main"
                        }).to_string()
                    } else {
                        json!({
                            "number": 2880,
                            "headRefOid": pr_head,
                            "mergeable": "MERGEABLE",
                            "mergeStateStatus": "CLEAN",
                            "state": "OPEN",
                            "mergeCommit": null,
                            "baseRefName": "main"
                        }).to_string()
                    }));
                }
                if args.first() == Some(&"api") {
                    let endpoint = args.get(1).copied().unwrap_or("");
                    if endpoint.ends_with("/commits/main") {
                        let committed_iso = crate::logging::iso(now_ms().saturating_sub(17 * 60_000));
                        return Some(Ok(json!({ "sha": dark_tip, "committed_at": committed_iso }).to_string()));
                    }
                    if endpoint.contains(&format!("/commits/{dark_tip}/check-runs")) {
                        return Some(Ok(match phase {
                            1 => json!([]).to_string(),
                            2 => json!([
                                { "id": 9001, "name": "deploy / Deploy to dev", "status": "in_progress", "conclusion": null, "html_url": "https://github.com/state-vector/superpositional/actions/runs/41798951196/job/1" }
                            ]).to_string(),
                            _ => json!([
                                { "id": 9001, "name": "deploy / Deploy to dev", "status": "completed", "conclusion": "success", "html_url": "https://github.com/state-vector/superpositional/actions/runs/41798951196/job/1" },
                                { "id": 9002, "name": "post-deploy / Post-Deploy Smoke", "status": "completed", "conclusion": "success", "html_url": "https://github.com/state-vector/superpositional/actions/runs/41798951196/job/2" },
                                { "id": 9003, "name": "post-deploy / DNS chain", "status": "completed", "conclusion": "success", "html_url": "https://github.com/state-vector/superpositional/actions/runs/41798951196/job/3" },
                                { "id": 9004, "name": "post-deploy / Lodestar Storage Health", "status": "completed", "conclusion": "success", "html_url": "https://github.com/state-vector/superpositional/actions/runs/41798951196/job/4" }
                            ]).to_string(),
                        }));
                    }
                    if endpoint.contains(&format!("/commits/{pr_head}/check-runs")) || endpoint.contains(&format!("/commits/{merged_sha}/check-runs")) {
                        return Some(Ok(json!([
                            { "id": 8001, "name": "ci / Rust Tests", "status": "completed", "conclusion": "success", "html_url": "https://github.com/state-vector/superpositional/actions/runs/41790000000/job/1" }
                        ]).to_string()));
                    }
                    if endpoint.contains("/actions/runs") {
                        return Some(Ok(match phase {
                            1 => json!([
                                { "id": 41791923312_i64, "name": "Deploy Health Record", "path": ".github/workflows/deploy-health.yml", "head_sha": dark_tip, "event": "schedule", "status": "completed", "conclusion": "success", "html_url": "https://github.com/state-vector/superpositional/actions/runs/41791923312" },
                                { "id": 41780000001_i64, "name": "Deploy Dev", "path": ".github/workflows/deploy-dev.yml", "head_sha": prev_green, "event": "push", "status": "completed", "conclusion": "success", "html_url": "https://github.com/state-vector/superpositional/actions/runs/41780000001" }
                            ]).to_string(),
                            2 => json!([
                                { "id": 41798951196_i64, "name": "Deploy Dev", "path": ".github/workflows/deploy-dev.yml", "head_sha": dark_tip, "event": "workflow_dispatch", "status": "in_progress", "conclusion": null, "html_url": "https://github.com/state-vector/superpositional/actions/runs/41798951196" },
                                { "id": 41798949143_i64, "name": "Deploy Dev", "path": ".github/workflows/deploy-dev.yml", "head_sha": dark_tip, "event": "push", "status": "queued", "conclusion": null, "html_url": "https://github.com/state-vector/superpositional/actions/runs/41798949143" },
                                { "id": 41780000001_i64, "name": "Deploy Dev", "path": ".github/workflows/deploy-dev.yml", "head_sha": prev_green, "event": "push", "status": "completed", "conclusion": "success", "html_url": "https://github.com/state-vector/superpositional/actions/runs/41780000001" }
                            ]).to_string(),
                            _ => json!([
                                { "id": 41798951196_i64, "name": "Deploy Dev", "path": ".github/workflows/deploy-dev.yml", "head_sha": dark_tip, "event": "workflow_dispatch", "status": "completed", "conclusion": "success", "html_url": "https://github.com/state-vector/superpositional/actions/runs/41798951196" }
                            ]).to_string(),
                        }));
                    }
                    if endpoint.contains("/pulls/2880/commits") {
                        return Some(Ok(json!([{ "sha": pr_head, "verified": true }]).to_string()));
                    }
                }
            }
            Some(Ok(String::new()))
        }));

        // Run Tick 1 (dark tip -> auto-dispatches deploy-dev.yml once)
        drive_lane(&mut ctx, &lane_val);
        // Run Tick 2 (deploy in flight + redundant queued run -> cancels 41798949143, does NOT dispatch again)
        *tick_phase.lock().unwrap() = 2;
        drive_lane(&mut ctx, &lane_val);
        // Run Tick 3 (deploy settled green -> merges PR #2880, zero human legs)
        *tick_phase.lock().unwrap() = 3;
        drive_lane(&mut ctx, &lane_val);

        let sh_calls = sh_log.lock().unwrap().clone();
        let dispatches: Vec<&String> = sh_calls
            .iter()
            .filter(|c| c.starts_with("gh workflow run deploy-dev.yml"))
            .collect();
        assert_eq!(
            dispatches.len(),
            1,
            "executor must dispatch deploy-dev.yml ONCE for the dark tip sha, got: {dispatches:?}"
        );
        assert_eq!(
            dispatches[0],
            "gh workflow run deploy-dev.yml --repo state-vector/superpositional --ref main"
        );

        let cancels: Vec<&String> = sh_calls
            .iter()
            .filter(|c| c.starts_with("gh run cancel"))
            .collect();
        assert_eq!(
            cancels,
            vec!["gh run cancel 41798949143 --repo state-vector/superpositional"],
            "executor must cancel the redundant queued deploy run on the same sha"
        );

        let merges: Vec<&String> = sh_calls
            .iter()
            .filter(|c| c.starts_with("gh pr merge 2880"))
            .collect();
        assert_eq!(merges.len(), 1, "PR #2880 must merge automatically on tick 3 once deploy settles green");

        let hub_calls = calls.lock().unwrap().clone();
        let qf_calls: Vec<&Value> = hub_calls
            .iter()
            .filter(|c| call_name(c) == "train_queue_facts")
            .collect();
        assert_eq!(qf_calls.len(), 3, "each tick stamps train_queue_facts");

        // Tick 1 base_state: uncovered_dispatched, covered_by prev_green
        let bs1 = call_args(qf_calls[0]).get("base_state").unwrap();
        assert_eq!(bs1.get("verdict").and_then(|v| v.as_str()), Some("unsettled"));
        assert_eq!(bs1.get("covered_by").and_then(|v| v.as_str()), Some(prev_green));
        assert_eq!(bs1.pointer("/deploy_coverage/phase").and_then(|v| v.as_str()), Some("uncovered_dispatched"));
        assert_eq!(bs1.pointer("/deploy_coverage/workflow").and_then(|v| v.as_str()), Some("deploy-dev.yml"));

        // Tick 2 base_state: settling + cancelled_redundant_runs = [41798949143]
        let bs2 = call_args(qf_calls[1]).get("base_state").unwrap();
        assert_eq!(bs2.get("verdict").and_then(|v| v.as_str()), Some("unsettled"));
        assert_eq!(bs2.pointer("/deploy_coverage/phase").and_then(|v| v.as_str()), Some("settling"));
        assert_eq!(bs2.get("cancelled_redundant_runs"), Some(&json!([41798949143_i64])));

        // Tick 3 base_state: covered by dark_tip + train_event merged fired, ZERO ask_agent calls
        let bs3 = call_args(qf_calls[2]).get("base_state").unwrap();
        assert_eq!(bs3.get("verdict").and_then(|v| v.as_str()), Some("green"));
        assert_eq!(bs3.get("covered_by").and_then(|v| v.as_str()), Some(dark_tip));
        assert_eq!(bs3.pointer("/deploy_coverage/phase").and_then(|v| v.as_str()), Some("covered"));
        assert!(
            hub_calls.iter().any(|c| call_name(c) == "train_event" && call_args(c).get("kind") == Some(&json!("merged"))),
            "tick 3 must record train_event kind=merged"
        );
        assert!(
            !hub_calls.iter().any(|c| call_name(c) == "ask_agent"),
            "synthetic dark-tip drill must complete with zero human legs"
        );
    }
}
