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
//! reconcile from live GitHub → awaiting-CI poll → else queue[0]'s first
//! UNLANDED leg on this lane → decideTrainGate → act: merge → train:merged →
//! next tick polls CI on the merge commit. Carry law (BR#3516 §5):
//! machine-clean carries, human-resolved invalidates.

use crate::train_gate::{
    classify_main_check_runs, decide_train_gate, merge_sweep_human_leg_title, normalize_gh_mergeable,
    normalize_gh_merge_state, train_leg_landed, train_legs, MainCheckRun, MainVerdict, MergeAction,
    TRAIN_CI_TYPICAL_MINUTES,
};
use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const SESSION: &str = "merge-train-executor";
const RPC_TIMEOUT: Duration = Duration::from_secs(60);
/// Daemon-leg log routing: the standalone CLI logs to stdout (journald/nohup
/// capture both, and `> train.log` users expect stdout); the in-process
/// gateway leg flips this once at spawn so its lines land where the host
/// app's other daemon lines go (stderr, matching dispatch.rs).
static LOG_STDERR: AtomicBool = AtomicBool::new(false);

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
    /// Probed identity class (cached when decided; Unknown re-probes per tick).
    identity: Option<IdentityClass>,
    /// The identity label last announced — logs only on change.
    identity_announced: Option<String>,
    /// Lane allowlist (`repo@base` keys). Empty = every lane the hub reports.
    lane_allow: Vec<String>,
    /// Fixed workdir (MERGE_TRAIN_WORKDIR). None → managed clone cache.
    workdir_override: Option<String>,
    // ---- lease liveness: proof of progress ----
    /// Last meaningful ledger action this executor took (renewals carry it).
    last_action: String,
    /// When `last_action` happened (ms epoch).
    last_action_ms: u64,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn trunc(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// UTC ISO-8601 log timestamps without a chrono dependency (civil-from-days).
fn iso(ts_ms: u64) -> String {
    let secs = (ts_ms / 1000) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    if mo <= 2 {
        y += 1;
    }
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

fn log(lane: Option<&str>, msg: &str) {
    let line = format!("[{}]{} {msg}", iso(now_ms()), lane.map(|l| format!(" {l}")).unwrap_or_default());
    if LOG_STDERR.load(Ordering::Relaxed) {
        let _ = writeln!(std::io::stderr(), "{line}");
    } else {
        let _ = writeln!(std::io::stdout(), "{line}");
        let _ = std::io::stdout().flush();
    }
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
            identity_announced: None,
            lane_allow: vec![],
            workdir_override: workdir_env,
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
    /// credential. Decided classes are cached for the process; Unknown
    /// (gh broke / transient) re-probes every tick. Logs loudly on change —
    /// the identity law must be VISIBLE, not ambient.
    fn ensure_identity(&mut self) -> IdentityClass {
        let decided = match &self.identity {
            Some(c @ (IdentityClass::Worker(_) | IdentityClass::Personal(_))) => c.clone(),
            _ => {
                let login = self.sh("gh", &["api", "user", "--jq", ".login"]).unwrap_or_default();
                let class = classify_login(&login, &self.worker_identities);
                self.identity = Some(class.clone());
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
    /// loud, never silent.
    fn write_allowed(&mut self) -> bool {
        matches!(self.ensure_identity(), IdentityClass::Worker(_))
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
    /// brief. `git merge-tree --write-tree --name-only` exits 1 on conflict
    /// and names the files; line 0 is the (partial) tree oid.
    fn trial_merge(&self, base: &str, head_sha: &str) -> Result<(bool, Vec<String>), String> {
        self.sh("git", &["fetch", "--quiet", "origin", base])?;
        let out = Command::new("git")
            .args(["merge-tree", "--write-tree", "--name-only", &format!("origin/{base}"), head_sha])
            .current_dir(&self.workdir)
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok((true, vec![]));
        }
        let files: Vec<String> = String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .skip(1)
            .collect();
        Ok((false, files))
    }

    fn is_ancestor(&self, a: &str, b: &str) -> bool {
        Command::new("git")
            .args(["merge-base", "--is-ancestor", a, b])
            .current_dir(&self.workdir)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
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
    ctx.train_lease(repo, base, "renew", json!({ "progress": progress })).is_ok()
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

    // ---- CAS lease (the hub decides; a conflict means ANOTHER live executor).
    // holder is ALWAYS the authenticated actor (the hub stamps it). ----
    let lease = match ctx.train_lease(&repo, &base, "acquire", json!({ "required_workflows": required })) {
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
        // fail-closed: the lease lapses (5 min) and the next gateway
        // reconciles from live GitHub. Never retry-blind inside the tick.
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
        let on_base = !merge_sha.is_empty() && ctx.is_ancestor(&merge_sha, &format!("origin/{base}"));
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

    // ---- idle arm: pick queue[0] and gate it (STRICT serialization — one
    // candidate per lane per tick; a non-mergeable head blocks the train) ----
    let queue_empty = lane.get("queue").and_then(|q| q.as_array()).map(|a| a.is_empty()).unwrap_or(true);
    if queue_empty {
        release_if_idle(ctx, key, repo, base)?;
        return Ok(());
    }
    let head = &lane.get("queue").unwrap().as_array().unwrap()[0];
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
        } else {
            log(Some(key), &format!("card {head_id} has no unlanded leg on this lane ({} leg(s) cited) — moving on", legs.len()));
        }
        release_if_idle(ctx, key, repo, base)?;
        return Ok(());
    }
    let leg = legs[lane_legs[0]].clone();
    let leg_number = lane_legs[0] + 1;
    let pr = leg.number;
    if pr == 0 || leg.repo.is_empty() {
        log(Some(key), &format!("queue head {head_id} leg {leg_number} carries no PR stamp — skipping (verify convention violation; see hub audit)"));
        release_if_idle(ctx, key, repo, base)?;
        return Ok(());
    }
    let facts = ctx.pr_facts(repo, pr)?;
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
        log(Some(key), &format!("queue head PR #{pr} is CLOSED on GitHub — dropping from the lane (card stays for the humans)"));
        release_if_idle(ctx, key, repo, base)?;
        return Ok(());
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
    log(Some(key), &format!("queue[0] PR #{pr} ({head_id}): gate → {kind}{detail}"));

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

    match gate {
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
<<<<<<< HEAD
            // human-resolved conflicts invalidate the verdict: enumerate the
            // conflicting files for the fix-up brief (plumbing merge-tree —
            // no throwaway worktree needed).
            let conflicting = facts.get("mergeable") == Some(&json!(false))
                || vstr(&facts, "mergeStateStatus").map(|s| s.to_uppercase().contains("CONFLICTING")).unwrap_or(false);
            let (clean, files) = if conflicting { ctx.trial_merge(base, &head_sha)? } else { (true, vec![]) };
            // BR#4066: the bounce KIND + the gate's own defect ride with the
            // event — the hub renders per-kind copy and the accept-hook only
            // re-queues non-conflict bounces. Coverage = the verdict-coverage
            // leg's phrasing; everything else is a named gate defect.
            let bounce_kind = if !clean && !files.is_empty() { "conflict" } else if defect.contains("not covered by the accepted verdict") { "coverage" } else { "gate" };
            let mut ev = json!({ "repo": repo, "base": base, "kind": "bounced", "pr": pr, "task_id": head_id, "head_sha": head_sha, "reason": defect, "bounce_kind": bounce_kind, "defect": defect, "merge_state": vstr(&facts, "mergeStateStatus").unwrap_or("") });
            if !clean && !files.is_empty() {
=======
            // BR#4066: the bounce NAMES ITS KIND and the event carries it —
            // the hub renders per-kind copy. Trial-merge ONLY a conflict-class
            // bounce: a coverage bounce (head moved past the verdict) has no
            // conflicts to enumerate and a gate defect already names the
            // truth — trial-merging those manufactured the "conflicts with
            // its base (no file list supplied)" lie the hub used to render.
            let trial = if bounce_kind == crate::train_gate::BounceKind::Conflict {
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
>>>>>>> 27e09d28d8e08fb77ab39106516a4c94034b6a68
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
            let behind = !ctx.is_ancestor(&format!("origin/{base}"), &head_sha);
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
    }
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
    let mut ctx = match Ctx::resolve(args) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[merge-train] fatal: {e}");
            return 1;
        }
    };
    if let Err(e) = ctx.preflight(true) {
        eprintln!("[merge-train] fatal: {e}");
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
        eprintln!("[train] gateway train leg disabled (MERGE_TRAIN_ENABLED=0) — not spawning");
        return;
    }
    let spawned = std::thread::Builder::new().name("merge-train".into()).spawn(move || daemon_loop(cfg, stop));
    if let Err(e) = spawned {
        eprintln!("[train] failed to spawn gateway train leg: {e}");
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
        identity_announced: None,
        lane_allow: cfg.lanes.clone(),
        workdir_override: cfg.workdir_override.clone(),
        last_action: "gateway leg tick".into(),
        last_action_ms: now_ms(),
    })
}

fn daemon_loop(cfg: DaemonTrainConfig, stop: std::sync::Arc<AtomicBool>) {
    LOG_STDERR.store(true, Ordering::Relaxed);
    log(
        None,
        &format!(
            "gateway train leg up — holder={} interval={}s lanes={} reconcile={} (in-process, identity-gated per BR#3181)",
            cfg.holder,
            cfg.interval_ms / 1000,
            if cfg.lanes.is_empty() { "all".to_string() } else { cfg.lanes.join(",") },
            if cfg.reconcile_enabled { format!("on/{}s", cfg.reconcile_interval_ms / 1000) } else { "off".to_string() }
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
        let wake = std::time::Instant::now() + Duration::from_millis(cfg.interval_ms);
        while std::time::Instant::now() < wake {
            if stop.load(Ordering::Relaxed) {
                log(None, "gateway train leg stopping");
                return;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        if stop.load(Ordering::Relaxed) {
            log(None, "gateway train leg stopping");
            return;
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
            identity: None,
            identity_announced: None,
            lane_allow: vec![],
            workdir_override: None,
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
}
