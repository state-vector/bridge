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
//! permanently unlandable entry — CLOSED PR, stamp-less leg, no unlanded leg
//! on this lane — is logged and the walk advances in the SAME tick; a
//! transient no-op still blocks) → decideTrainGate → act: merge →
//! train:merged → next tick polls CI on the merge commit. Carry law
//! (BR#3516 §5): machine-clean carries, human-resolved invalidates. Local
//! git plumbing is three-valued (BR#3935): a git FAILURE is never folded
//! into a conflict/behind verdict — the PR head is fetched explicitly
//! before any local op names it.

use crate::train_gate::{
    classify_main_check_runs, decide_train_gate, merge_sweep_human_leg_title, normalize_gh_mergeable,
    normalize_gh_merge_state, train_leg_landed, train_legs, MainCheckRun, MainVerdict, MergeAction,
    TRAIN_CI_TYPICAL_MINUTES,
};
use serde_json::{json, Value};
use std::io::BufRead;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::logging::{emit, now_ms, prefer_stdout};

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

    fn check_runs(&self, repo: &str, sha: &str) -> Vec<MainCheckRun> {
        let out = self.gh_json(&["api", &format!("repos/{repo}/commits/{sha}/check-runs"), "--jq", "[.check_runs[] | {id, name, status, conclusion, html_url}]"]);
        let arr = match out {
            Ok(Value::Array(a)) => a,
            _ => return vec![],
        };
        arr.iter()
            .map(|r| MainCheckRun {
                id: r.get("id").and_then(|v| v.as_i64()).unwrap_or(0),
                name: r.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                status: r.get("status").and_then(|v| v.as_str()).map(String::from),
                conclusion: r.get("conclusion").and_then(|v| v.as_str()).map(String::from),
                html_url: r.get("html_url").and_then(|v| v.as_str()).map(String::from),
            })
            .collect()
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

    /// Ancestry is a three-valued answer: true / false / CANNOT-READ. Only
    /// the first two are bools — a git failure (exit ∉ {0, 1}, e.g. a bad
    /// object) is an Err, never a silent `false` (BR#3935: exit 128 used to
    /// read as behind=true). Callers decide what CANNOT-READ means: the
    /// merge arm fails the tick closed; the awaiting-CI reconcile defers to
    /// its live pr_facts double-check.
    fn is_ancestor(&self, a: &str, b: &str) -> Result<bool, String> {
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

fn vstr<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str())
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

    if let Err(e) = drive_lane_inner(ctx, lane, &key, &repo, &base, typical_ms) {
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

fn drive_lane_inner(ctx: &mut Ctx, lane: &Value, key: &str, repo: &str, base: &str, _typical_ms: u64) -> Result<(), String> {
    // ---- stop-the-line arm: main is RED and the lane is stopped ----
    if !lane.get("stop").map(|s| s.is_null()).unwrap_or(true) {
        let stop = lane.get("stop").unwrap();
        let stop_sha = vstr(stop, "sha").unwrap_or("");
        log(Some(key), &format!("line stopped — {} @ {}", vstr(stop, "reason").unwrap_or("?"), &stop_sha[..stop_sha.len().min(9)]));
        let base_sha = ctx.sh("gh", &["api", &format!("repos/{repo}/commits/{base}"), "--jq", ".sha"])?;
        let v = classify_main_check_runs(&ctx.check_runs(repo, &base_sha));
        if v.verdict == MainVerdict::Green {
            renew_lease(ctx, repo, base);
            ctx.train_lease(repo, base, "release", json!({ "line_green": true }))?;
            log(Some(key), "main green again — stop cleared, lane released");
        } else {
            let reds = v.red.iter().map(|r| r.name.as_str()).collect::<Vec<_>>().join(", ");
            log(Some(key), &format!("main still {}{} — holding", v.verdict.as_str(), if reds.is_empty() { String::new() } else { format!(" (red: {reds})") }));
        }
        return Ok(());
    }

    // ---- post-stop residue: the stop cleared (main green again) but the
    // in-flight record is the broken merge commit — never poll it toward a
    // landing. The culprit card was bounced at stop time; lane is idle. ----
    if lane.pointer("/currently/phase").and_then(|p| p.as_str()) == Some("stopped") {
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
        let runs = ctx.check_runs(repo, &merge_sha);
        let ci = ctx.mcp("train_ci", json!({ "repo": repo, "base": base, "sha": merge_sha, "checks": runs }))?;
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
        }
        return Ok(());
    }

    // ---- idle arm: walk the derived queue IN ORDER and drive the first
    // entry the tick can act on (STRICT serialization — ONE action per lane
    // per tick; a transient no-op — mergeability computing, unsettled checks,
    // no verdict — still blocks the train). A PERMANENTLY unlandable entry —
    // PR CLOSED, a leg with no PR stamp, no unlanded leg on this lane — must
    // NOT starve the lane (BR#3935: the executor used to drop the head,
    // release, and return; the hub re-derived the same queue next tick and
    // every queued card behind it rotted). It is logged and the walk advances
    // to the next entry in the SAME tick; the card itself stays queued for
    // the humans.
    let queue = lane.get("queue").and_then(|q| q.as_array()).cloned().unwrap_or_default();
    if queue.is_empty() {
        release_if_idle(ctx, key, repo, base)?;
        return Ok(());
    }
    for (qi, head) in queue.iter().enumerate() {
        let head_id = vstr(head, "id").unwrap_or("").to_string();
        let card = ctx.mcp("get_artefact", json!({ "id": head_id }))?;
        let card_meta = card.get("meta").cloned().unwrap_or(json!({}));
        let card_status = card.get("status").and_then(|v| v.as_str()).map(String::from);
        // BR#3659: the card is a LIST of legs (meta.prs; meta.pr stays the first
        // for legacy readers). THIS lane drives the first UNLANDED leg whose
        // repo is this lane's.
        let legs = train_legs(&card_meta);
        let lane_legs: Vec<usize> = legs
            .iter()
            .enumerate()
            .filter(|(_, leg)| leg.repo == repo && !train_leg_landed(&card_meta, leg))
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
            log(Some(key), &format!("queue[{qi}] {head_id} has no unlanded leg on this lane ({} leg(s) cited) — advancing to the next queue entry", legs.len()));
            continue;
        }
        let leg = legs[lane_legs[0]].clone();
        let leg_number = lane_legs[0] + 1;
        let pr = leg.number;
        if pr == 0 || leg.repo.is_empty() {
            // BR#3935: a stamp-less leg can never drive — advance (the hub
            // audit owns the convention violation; the card stays queued).
            log(Some(key), &format!("queue[{qi}] {head_id} leg {leg_number} carries no PR stamp — advancing to the next queue entry (verify convention violation; see hub audit)"));
            continue;
        }
        let mut facts = ctx.pr_facts(repo, pr)?;
        // L1.1 (BR#4685): poll, don't bounce. An unanswered mergeStateStatus
        // (null/UNKNOWN — GitHub computing, typical right after a base merge)
        // is backoff-polled inside this tick — bounded by the lease heartbeat
        // (renewed around every wait) — until GitHub answers. The gate below
        // bounces ONLY on definitive DIRTY/CONFLICTING; a merge/closure that
        // lands mid-poll reconciles through the arms below instead of gating.
        if !mergeability_definitive(&facts) {
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
            // reconcile: merged on GitHub, no train event (crash between merge and
            // event) — stamp it and let the CI poll take over next tick.
            renew_lease(ctx, repo, base);
            ctx.mcp("train_event", json!({ "repo": repo, "base": base, "kind": "merged", "pr": pr, "merge_sha": facts.pointer("/mergeCommit/oid"), "head_sha": vstr(&facts, "headRefOid"), "task_id": head_id, "signer": ctx.holder, "reason": "reconcile: PR already merged on GitHub — event stamped from live state" }))?;
            ctx.note(&format!("reconcile: stamped already-merged PR #{pr}"));
            log(Some(key), &format!("reconcile: PR #{pr} was already merged — stamped, awaiting CI"));
            return Ok(());
        }
        if vstr(&facts, "state") == Some("CLOSED") {
            // BR#3935: a CLOSED PR can never merge — the old drop-and-return
            // starved the whole lane behind its card. Log it, leave the card
            // for the humans, and drive the NEXT entry this same tick.
            log(Some(key), &format!("queue[{qi}] {head_id} PR #{pr} is CLOSED on GitHub — unlandable, advancing to the next queue entry (card stays for the humans)"));
            continue;
        }
        let head_sha = vstr(&facts, "headRefOid").unwrap_or("").to_string();
        let base_sha = ctx.sh("gh", &["api", &format!("repos/{repo}/commits/{base}"), "--jq", ".sha"])?;
        let base_verdict = classify_main_check_runs(&ctx.check_runs(repo, &base_sha)).verdict;
        let head_checks = ctx.check_runs(repo, &head_sha);
        let commits = ctx.pr_commits(repo, pr);
        let gate = decide_train_gate(crate::train_gate::TrainGateInput {
            pr_number: pr,
            head_sha: &head_sha,
            card_meta: &card_meta,
            card_status: card_status.as_deref(),
            base_verdict,
            mergeable: facts.get("mergeable").and_then(|v| v.as_bool()),
            merge_state_status: vstr(&facts, "mergeStateStatus").map(String::from),
            commits: &commits,
            head_checks: &head_checks,
            leg_number: Some(leg_number),
        });
        let (kind, detail) = match &gate {
            MergeAction::Merge { .. } => ("merge", String::new()),
            MergeAction::CloseSuperseded { reason } => ("close_superseded", format!(" — {reason}")),
            MergeAction::Bounce { defect, bounce_kind } => ("bounce", format!(" [{}] — {defect}", bounce_kind.as_str())),
            MergeAction::Note { reason } => ("note", format!(" — {reason}")),
            MergeAction::Skip { reason } => ("skip", format!(" — {reason}")),
            MergeAction::HumanLeg { reason } => ("human_leg", format!(" — {reason}")),
        };
        log(Some(key), &format!("queue[{qi}] PR #{pr} ({head_id}): gate → {kind}{detail}"));

        // ---- IDENTITY GATE (BR#3181, enforced at the write boundary) ----
        // close / update-branch / merge execute only under the worker-class
        // credential. A personally-authed or unclassifiable gateway reports
        // read-only, releases the lease (a worker gateway can take the lane), and
        // names the refusal loudly — NEVER writes GitHub as a personal identity.
        let write_leg = matches!(gate, MergeAction::Merge { .. } | MergeAction::CloseSuperseded { .. });
        if write_leg && !ctx.write_allowed() {
            ctx.note("identity gate: write leg withheld");
            log(
                Some(key),
                &format!(
                    "IDENTITY GATE: {} leg for PR #{pr} withheld — gh is NOT a worker-class credential (BR#3181); lease released for a worker gateway",
                    if matches!(gate, MergeAction::Merge { .. }) { "merge" } else { "close" }
                ),
            );
            release_if_idle(ctx, key, repo, base)?;
            return Ok(());
        }

        // ONE action per tick (strict serialization): whatever the gate
        // decided — merge, bounce, close, note, human leg — the walk ends
        // here; the next tick re-derives the queue and continues.
        return match gate {
            MergeAction::Skip { .. } | MergeAction::Note { .. } => {
                release_if_idle(ctx, key, repo, base)?;
                Ok(())
            }
            MergeAction::HumanLeg { reason } => {
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
                Ok(())
            }
            MergeAction::CloseSuperseded { reason } => {
                renew_lease(ctx, repo, base);
                ctx.sh("gh", &["pr", "close", &pr.to_string(), "--repo", repo, "--comment", &trunc(&reason, 240)])?;
                ctx.note(&format!("closed superseded PR #{pr}"));
                log(Some(key), &format!("PR #{pr} closed (superseded card)"));
                release_if_idle(ctx, key, repo, base)?;
                Ok(())
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
                Ok(())
            }
            MergeAction::Merge { .. } => {
                // ---- the merge leg: machine-clean update first, then merge ----
                renew_lease(ctx, repo, base);
                ctx.sh("git", &["fetch", "--quiet", "origin", base])?;
                ctx.fetch_pr_head(pr)?;
                // BR#3935: fail-closed — a locally-unreadable head is a tick
                // error, never a fabricated "behind" (and via trial_merge, never
                // a fabricated "conflict" with an empty file list).
                let behind = !ctx.is_ancestor(&format!("origin/{base}"), &head_sha)?;
                // BR#3659: the behind-check reads THIS leg's accepted-at head, not
                // the card-level first-leg stamp — each leg carries its own verdict.
                if behind && head_sha == leg.head_sha_at_acceptance.clone().unwrap_or_default().to_lowercase() {
                    // base advanced past a verdict-covered head: update-branch is
                    // the MACHINE-clean rebase — if it lands, the verdict carries
                    // (BR#3516 §5); if it conflicts, that's human-resolved.
                    let (clean, tm_files) = ctx.trial_merge(base, &head_sha)?;
                    if !clean {
                        let conflict_reason = format!("base {base} advanced into the PR's files — rebase conflicts are human-resolved; the verdict does not carry");
                        ctx.mcp("train_event", json!({ "repo": repo, "base": base, "kind": "bounced", "pr": pr, "task_id": head_id, "head_sha": head_sha, "conflict_files": tm_files, "bounce_kind": "conflict", "defect": conflict_reason, "reason": conflict_reason }))?;
                        log(Some(key), &format!("PR #{pr} bounced (rebase conflicts: {}{})", tm_files.iter().take(5).cloned().collect::<Vec<_>>().join(", "), if tm_files.len() > 5 { ", …" } else { "" }));
                        release_if_idle(ctx, key, repo, base)?;
                        return Ok(());
                    }
                    ctx.sh("gh", &["pr", "update-branch", &pr.to_string(), "--repo", repo])?;
                    ctx.note(&format!("machine update-branch PR #{pr} (verdict carries)"));
                    let updated = ctx.pr_facts(repo, pr)?;
                    let new_head = vstr(&updated, "headRefOid").unwrap_or("").to_string();
                    log(Some(key), &format!("machine update-branch clean: {} → {} (verdict carries)", &head_sha[..head_sha.len().min(9)], &new_head[..new_head.len().min(9)]));
                    if updated.get("mergeable").and_then(|v| v.as_bool()) != Some(true) {
                        log(Some(key), "mergeability recomputing after update-branch — next tick");
                        release_if_idle(ctx, key, repo, base)?;
                        return Ok(());
                    }
                }
                let method_flag = match ctx.method.as_str() { "squash" => "--squash", "rebase" => "--rebase", _ => "--merge" };
                ctx.sh("gh", &["pr", "merge", &pr.to_string(), "--repo", repo, method_flag])?;
                let merged = ctx.pr_facts(repo, pr)?;
                let merge_sha = merged.pointer("/mergeCommit/oid").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if vstr(&merged, "state") != Some("MERGED") || merge_sha.is_empty() {
                    return Err(format!(
                        "gh pr merge reported ok but PR #{pr} is {} with no mergeCommit — DO NOT trust this tick; investigate",
                        vstr(&merged, "state").unwrap_or("?")
                    ));
                }
                ctx.mcp("train_event", json!({ "repo": repo, "base": base, "kind": "merged", "pr": pr, "merge_sha": merge_sha, "head_sha": head_sha, "task_id": head_id, "signer": ctx.holder }))?;
                ctx.note(&format!("merged PR #{pr} as {}", &merge_sha[..merge_sha.len().min(9)]));
                log(Some(key), &format!("PR #{pr} merged as {} — awaiting CI on the merge commit", &merge_sha[..merge_sha.len().min(9)]));
                Ok(())
            }
        };
    }
    // every entry was walked and none could act — the lane is honestly idle
    release_if_idle(ctx, key, repo, base)?;
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
        if let Err(e) = tick(&mut ctx) {
            log(None, &format!("tick failed: {}", trunc(&e, 300)));
            return 1;
        }
        return 0;
    }
    loop {
        let started = now_ms();
        if let Err(e) = tick(&mut ctx) {
            log(None, &format!("tick failed: {}", trunc(&e, 300)));
        }
        let spent = now_ms() - started;
        std::thread::sleep(Duration::from_millis(ctx.interval_ms.saturating_sub(spent).max(1000)));
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
pub fn spawn_daemon_leg(hub: &str, token: &str, label: Option<&str>, stop: std::sync::Arc<AtomicBool>) {
    let cfg = DaemonTrainConfig::from_runner(hub, token, label);
    if !cfg.enabled {
        emit(
            "train",
            "",
            "gateway train leg disabled (MERGE_TRAIN_ENABLED=0) — not spawning",
        );
        return;
    }
    // BR#4806: the event-driven wake leg (best-effort; spawn failure or
    // MERGE_TRAIN_EVENTS=0 leaves the daemon poll-only — today's behaviour)
    if cfg.events_enabled {
        spawn_wake_leg(stop.clone());
    } else {
        emit("train", "", "train wake leg disabled (MERGE_TRAIN_EVENTS=0) — poll cadence only");
    }
    let spawned = std::thread::Builder::new().name("merge-train".into()).spawn(move || daemon_loop(cfg, stop));
    if let Err(e) = spawned {
        emit(
            "train",
            "",
            &format!("failed to spawn gateway train leg: {e}"),
        );
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
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                failures += 1;
                if e.contains("401") {
                    // the pairing rotated under us — rebuild from the
                    // keychain/config and let the next tick retry
                    if let Ok(fresh) = ctx_for_daemon(&cfg) {
                        ctx = fresh;
                        log(None, "gateway token rotated — train leg re-vended its pairing");
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
        let rows = ctx.gh_json(&[
            "pr", "list", "--repo", &repo, "--state", "open", "--limit", "200",
            "--json", "number,title,reviewDecision,mergeable,mergeStateStatus,headRefOid,headRefName,updatedAt,isDraft",
        ])?;
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
fn classify_rollup(rollup: &[Value], url: &str, head_sha: &str) -> ProbeVerdict {
    if rollup.is_empty() {
        return ProbeVerdict::Transient { error: "no checks reported on the PR yet".into() };
    }
    let mut failed: Vec<String> = Vec::new();
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
            "FAILURE" | "ERROR" | "CANCELLED" | "TIMED_OUT" | "STARTUP_FAILURE" | "ACTION_REQUIRED" => failed.push(format!("{name}={state}")),
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
    use super::*;
    use std::collections::VecDeque;
    use std::io::{Read, Write as IoWrite};
    use std::sync::Mutex;

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
        assert_eq!(names, vec!["train_lease", "get_artefact", "train_status", "train_lease", "train_lease"]);
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
            ok(json!({ "lanes": [ { "lane": "state-vector/bridge@main", "queue": [], "currently": null, "stop": null } ] })), // tick 2: status
            ok(json!({ "note": "lease released — idle" })),                                                            // tick 2: release
        ]);
        let mut ctx = test_ctx(&hub);
        drive_lane(&mut ctx, &lane()); // stands down
        drive_lane(&mut ctx, &lane()); // takes over
        let recorded = calls.lock().unwrap();
        let names: Vec<String> = recorded.iter().map(call_name).collect();
        assert_eq!(names, vec!["train_lease", "train_lease", "get_artefact", "train_status", "train_lease"]);
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
            }
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base_dir);
        }
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
}
