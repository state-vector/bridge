//! train — the native merge-train executor, `bridge train [--once]` (BR#3879,
//! decision BR#3880). Mechanical port of the BR#3517 Node executor script
//! (decision BR#3516; the script is deleted by this change): same contract — 45s tick loop / single tick, doctor
//! preflight, CAS lane lease (hub API over the hub's /mcp), reconcile from
//! live GitHub via `gh`, feed reports, hub decides (decide_train_gate in
//! train_gate.rs), provenance stamps, bounce/rebase, stop-the-line. The hub
//! holds no VCS credentials; this executor shells `gh`/`git` locally.

use crate::train_gate::{
    classify_main_check_runs, decide_train_gate, merge_sweep_human_leg_title, normalize_gh_mergeable,
    normalize_gh_merge_state, short_sha, train_leg_landed, train_legs, BaseVerdict, MainCheckRun,
    PrCommit, TrainGateInput, TrainLeg, TRAIN_CI_BOUND_MULTIPLIER, TRAIN_CI_TYPICAL_MINUTES,
};
use serde_json::{json, Value};
use std::io::Write;

/// MCP session string the executor has always presented (provenance receipts
/// cite it — BR#3287 chain unaffected by the port).
const SESSION: &str = "merge-train-executor";

pub struct TrainConfig {
    pub lane_filter: Option<String>, // "repo@base"
    pub once: bool,
    pub interval_ms: u64,
    pub method: String, // merge | squash | rebase
    pub holder: String,
    pub hub: String,
    pub token: String,
    pub workdir: String,
}

impl TrainConfig {
    pub fn from_args(args: &[String]) -> TrainConfig {
        // args[0]=bin, args[1]="train"
        let mut lane_filter = None;
        let mut once = false;
        let mut interval_secs: Option<String> = None;
        let mut method_flag: Option<String> = None;
        let mut i = 2;
        while i < args.len() {
            match args[i].as_str() {
                "--lane" => {
                    lane_filter = args.get(i + 1).cloned();
                    i += 2;
                }
                "--once" => {
                    once = true;
                    i += 1;
                }
                "--interval" => {
                    interval_secs = args.get(i + 1).cloned();
                    i += 2;
                }
                "--method" => {
                    method_flag = args.get(i + 1).cloned();
                    i += 2;
                }
                _ => i += 1, // the node script ignored unknown tokens — same here
            }
        }
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let interval = interval_secs
            .or_else(|| env("MERGE_TRAIN_INTERVAL_SECS"))
            .and_then(|v| v.trim().parse::<f64>().ok())
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(45.0);
        let method = method_flag
            .or_else(|| env("MERGE_TRAIN_METHOD"))
            .unwrap_or_else(|| "merge".into());
        let holder = env("MERGE_TRAIN_HOLDER").unwrap_or_else(|| format!("merge-train@{}", hostname_short()));
        let hub = env("BRIDGE_URL")
            .unwrap_or_default()
            .trim_end_matches('/')
            .to_string();
        let token = env("BRIDGE_TOKEN").unwrap_or_default();
        let workdir = env("MERGE_TRAIN_WORKDIR")
            .unwrap_or_else(|| std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default());
        TrainConfig {
            lane_filter,
            once,
            interval_ms: (interval * 1000.0) as u64,
            method,
            holder,
            hub,
            token,
            workdir,
        }
    }
}

/// os.hostname().split(".")[0] equivalent: `hostname` output up to the first
/// dot; falls back to $HOSTNAME then "unknown".
fn hostname_short() -> String {
    let out = std::process::Command::new("hostname").output();
    let h = match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => std::env::var("HOSTNAME").unwrap_or_else(|_| "unknown".into()),
    };
    h.split('.').next().unwrap_or("unknown").to_string()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// UTC ISO-8601 with milliseconds — the node `new Date().toISOString()` shape.
fn iso_now() -> String {
    let ms = now_ms();
    let secs = ms / 1000;
    let millis = ms % 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // civil-from-days (Howard Hinnant's algorithm)
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mth <= 2 { y + 1 } else { y };
    format!("{y:04}-{mth:02}-{d:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

fn log_line(lane: Option<&str>, msg: &str) {
    let lane = lane.map(|l| format!(" {l}")).unwrap_or_default();
    println!("[{}]{} {msg}", iso_now(), lane);
}

/// JS truthiness for the lane fields the executor reads (`lane.stop`,
/// `me.currently`): null/false/absent are falsy, everything else truthy.
fn is_truthy(v: Option<&Value>) -> bool {
    !matches!(v, None | Some(Value::Null) | Some(Value::Bool(false)))
}

fn as_str(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

/// `String(obj.key ?? "")` — the lane/queue/card field reads.
fn v_str(v: &Value, key: &str) -> String {
    as_str(v.get(key))
}

/// `Number(obj.key ?? 0)`.
fn v_i64(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(Value::as_i64).unwrap_or(0)
}

struct Ctx {
    cfg: TrainConfig,
    client: reqwest::blocking::Client,
    rpc: std::cell::Cell<u64>,
}

impl Ctx {
    fn new(cfg: TrainConfig) -> Ctx {
        let client = reqwest::blocking::Client::builder()
            // generous ceiling — gh/git do the slow work, hub calls are quick
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .expect("http client builds");
        Ctx { cfg, client, rpc: std::cell::Cell::new(0) }
    }

    /// MCP over the hub's /mcp (same JSON-RPC surface the agents use).
    fn mcp(&self, name: &str, args: Value) -> Result<Value, String> {
        if self.cfg.hub.is_empty() || self.cfg.token.is_empty() {
            return Err("BRIDGE_URL / BRIDGE_TOKEN not set — run `bridge doctor`, export both, retry".into());
        }
        let mut arguments = args.as_object().cloned().unwrap_or_default();
        arguments.insert("session".into(), Value::String(SESSION.into()));
        self.rpc.set(self.rpc.get() + 1);
        let body = json!({
            "jsonrpc": "2.0",
            "id": self.rpc.get(),
            "method": "tools/call",
            "params": { "name": name, "arguments": arguments },
        });
        let resp = self
            .client
            .post(format!("{}/mcp", self.cfg.hub))
            .header("content-type", "application/json")
            .header("Authorization", format!("Bearer {}", self.cfg.token))
            .body(body.to_string())
            .send()
            .map_err(|e| format!("hub unreachable: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("hub http {} ({name})", resp.status()));
        }
        let out: Value = resp.json().map_err(|e| format!("bad JSON from hub ({name}): {e}"))?;
        if let Some(err) = out.get("error").filter(|e| !e.is_null()) {
            let msg = err
                .get("message")
                .and_then(Value::as_str)
                .map(String::from)
                .unwrap_or_else(|| err.to_string());
            return Err(format!("hub rpc error ({name}): {msg}"));
        }
        let result = out.get("result").cloned().unwrap_or(Value::Null);
        let raw = result
            .get("content")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(|c| c.get("text"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if result.get("isError").and_then(Value::as_bool).unwrap_or(false) {
            return Err(format!("hub tool error ({name}): {}", raw.chars().take(300).collect::<String>()));
        }
        Ok(serde_json::from_str(&raw).unwrap_or(Value::Null))
    }

    /// gh/git inside the target clone; we read stdout, surface stderr on failure.
    fn sh(&self, cmd: &str, args: &[&str], input: Option<&str>) -> Result<String, String> {
        let mut c = std::process::Command::new(cmd);
        c.args(args)
            .current_dir(&self.cfg.workdir)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .stdin(if input.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() });
        let mut child = c.spawn().map_err(|e| format!("{cmd} {} failed (spawn): {e}", args.join(" ")))?;
        if let Some(inp) = input {
            let _ = child.stdin.take().unwrap().write_all(inp.as_bytes());
        }
        let out = child.wait_with_output().map_err(|e| format!("{cmd} {} failed (wait): {e}", args.join(" ")))?;
        if !out.status.success() {
            let code = out.status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into());
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(format!(
                "{cmd} {} failed ({code}): {}",
                args.join(" "),
                stderr.chars().take(400).collect::<String>()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    fn gh_json(&self, args: &[&str]) -> Result<Value, String> {
        let out = self.sh("gh", args, None)?;
        serde_json::from_str(&out)
            .map_err(|_| format!("gh gave non-JSON output: {}", out.chars().take(200).collect::<String>()))
    }

    fn renew(&self, repo: &str, base: &str) -> Result<Value, String> {
        self.mcp("train_lease", json!({ "repo": repo, "base": base, "action": "renew" }))
    }

    /// PR head facts: head sha, mergeability, merge state, state, merge commit.
    /// BR#3714: gh's JSON here is the GraphQL shape — `mergeable` is the enum
    /// STRING and `mergeStateStatus` is UPPERCASE. Normalized AT the fact
    /// boundary so the 5c gate's boolean/lowercase contract holds.
    fn pr_facts(&self, repo: &str, n: i64) -> Result<Value, String> {
        let raw = self.gh_json(&[
            "pr",
            "view",
            &n.to_string(),
            "--repo",
            repo,
            "--json",
            "number,headRefOid,mergeable,mergeStateStatus,state,mergeCommit,baseRefName",
        ])?;
        let mut facts = raw;
        if let Some(obj) = facts.as_object_mut() {
            let mergeable = normalize_gh_mergeable(obj.get("mergeable").unwrap_or(&Value::Null));
            let state = normalize_gh_merge_state(obj.get("mergeStateStatus").unwrap_or(&Value::Null));
            obj.insert("mergeable".into(), mergeable.map(Value::Bool).unwrap_or(Value::Null));
            obj.insert("mergeStateStatus".into(), state.map(Value::String).unwrap_or(Value::Null));
        }
        Ok(facts)
    }

    /// Check runs on a commit (merge-commit CI poll + head/base checks) — the
    /// raw jq array Value (hub-side consumption) plus the parsed gate view.
    fn check_runs(&self, repo: &str, sha: &str) -> Result<Value, String> {
        self.gh_json(&[
            "api",
            &format!("repos/{repo}/commits/{sha}/check-runs"),
            "--jq",
            "[.check_runs[] | {id, name, status, conclusion, html_url}]",
        ])
        .map(|v| if v.is_array() { v } else { Value::Array(vec![]) })
    }

    /// Every commit of the PR with GitHub's signature verification verdict.
    fn pr_commits(&self, repo: &str, n: i64) -> Result<Vec<PrCommit>, String> {
        let out = self.gh_json(&[
            "api",
            &format!("repos/{repo}/pulls/{n}/commits"),
            "--jq",
            "[.[] | {sha: .sha, verified: .commit.verification.verified}]",
        ])?;
        Ok(out
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|c| PrCommit {
                        sha: as_str(c.get("sha")),
                        verified: c.get("verified").and_then(Value::as_bool).unwrap_or(false),
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Trial merge (plumbing, no worktree): (clean, conflicting files) for the
    /// bounce brief. `git merge-tree --write-tree --name-only` exits 1 on
    /// conflict and names the files; exit 0 = clean.
    fn trial_merge(&self, base: &str, head_sha: &str) -> Result<(bool, Vec<String>), String> {
        self.sh("git", &["fetch", "--quiet", "origin", base], None)?;
        let out = std::process::Command::new("git")
            .args(["merge-tree", "--write-tree", "--name-only", &format!("origin/{base}"), head_sha])
            .current_dir(&self.cfg.workdir)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .map_err(|e| format!("git merge-tree failed (spawn): {e}"))?;
        if out.status.success() {
            return Ok((true, vec![]));
        }
        let lines: Vec<String> = String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        Ok((false, lines.into_iter().skip(1).collect())) // line 0 is the (partial) tree oid
    }
}

fn parse_check_runs(v: &Value) -> Vec<MainCheckRun> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|r| MainCheckRun {
                    id: r.get("id").and_then(Value::as_i64).unwrap_or(0),
                    name: r.get("name").and_then(Value::as_str).map(String::from),
                    status: r.get("status").and_then(Value::as_str).map(String::from),
                    conclusion: r.get("conclusion").and_then(Value::as_str).map(String::from),
                    html_url: r.get("html_url").and_then(Value::as_str).map(String::from),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Release only when nothing is in flight; an awaiting-CI lane keeps the
/// lease so the next tick polls under the same holder.
fn release_if_idle(ctx: &Ctx, key: &str, repo: &str, base: &str) -> Result<(), String> {
    let st = ctx.mcp("train_status", json!({ "repo": repo }))?;
    let me = st
        .get("lanes")
        .and_then(Value::as_array)
        .and_then(|ls| ls.iter().find(|l| l.get("lane").and_then(Value::as_str) == Some(key)));
    if let Some(me) = me {
        if !is_truthy(me.get("currently")) {
            let line_green = !is_truthy(me.get("stop"));
            let r = ctx.mcp(
                "train_lease",
                json!({ "repo": repo, "base": base, "action": "release", "line_green": line_green }),
            )?;
            log_line(Some(key), &format!("lease released — {}", r.get("note").and_then(Value::as_str).unwrap_or("idle")));
        } else {
            log_line(Some(key), "lease held — merge in flight, next tick renews + polls CI");
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// preflight — cheap, every start. `bridge doctor` owns the deep checks (gh
// authed, deploy drift, token validity); these four make the executor fail
// loud instead of limping.
// ---------------------------------------------------------------------------

fn preflight(cfg: &TrainConfig) -> Result<(), String> {
    let mut bad: Vec<String> = vec![];
    for c in ["gh", "git"] {
        let p = std::process::Command::new(c).arg("--version").output();
        if !p.map(|o| o.status.success()).unwrap_or(false) {
            bad.push(format!("{c} not runnable"));
        }
    }
    let auth = std::process::Command::new("gh").args(["auth", "status"]).output();
    if !auth.as_ref().map(|o| o.status.success()).unwrap_or(false) {
        let err = auth
            .map(|o| String::from_utf8_lossy(&o.stderr).trim().to_string())
            .unwrap_or_default();
        bad.push(format!("gh not authed ({})", err.chars().take(120).collect::<String>()));
    }
    let git = std::process::Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(&cfg.workdir)
        .output();
    if !git.map(|o| o.status.success()).unwrap_or(false) {
        bad.push(format!("{} is not a git clone (set MERGE_TRAIN_WORKDIR)", cfg.workdir));
    }
    if !["merge", "squash", "rebase"].contains(&cfg.method.as_str()) {
        bad.push(format!("unknown merge method '{}'", cfg.method));
    }
    if !bad.is_empty() {
        return Err(format!("preflight failed: {}", bad.join("; ")));
    }
    log_line(
        None,
        &format!(
            "executor up — holder={} method={} interval={}s workdir={}",
            cfg.holder,
            cfg.method,
            cfg.interval_ms / 1000,
            cfg.workdir
        ),
    );
    Ok(())
}

/// Merge method — the gh flag per method.
fn method_flag(method: &str) -> &'static str {
    match method {
        "squash" => "--squash",
        "rebase" => "--rebase",
        _ => "--merge",
    }
}

/// Silent git probe in the workdir: exit-status only (the JS spawnSync
/// `.status === 0` checks — merge-base --is-ancestor answers THROUGH the
/// status, stdout stays empty).
fn git_ok(cfg: &TrainConfig, args: &[&str]) -> bool {
    std::process::Command::new("git")
        .args(args)
        .current_dir(&cfg.workdir)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn verdict_str(v: BaseVerdict) -> &'static str {
    match v {
        BaseVerdict::Green => "green",
        BaseVerdict::Red => "red",
        BaseVerdict::Unsettled => "unsettled",
        BaseVerdict::Empty => "empty",
    }
}

fn str_vec(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().map(|x| as_str(Some(x))).collect())
        .unwrap_or_default()
}

fn trim_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

impl Ctx {
    /// train_event with the mjs's optional-key shape: absent (not null) when
    /// the executor has no value (`?? undefined` in the original).
    #[allow(clippy::too_many_arguments)]
    fn train_event(
        &self,
        repo: &str,
        base: &str,
        kind: &str,
        pr: i64,
        merge_sha: Option<String>,
        head_sha: Option<String>,
        task_id: Option<String>,
        signer: Option<String>,
        conflict_files: Option<Vec<String>>,
        reason: Option<String>,
    ) -> Result<Value, String> {
        let mut a = json!({ "repo": repo, "base": base, "kind": kind, "pr": pr });
        let o = a.as_object_mut().expect("object literal");
        if let Some(v) = merge_sha {
            o.insert("merge_sha".into(), v.into());
        }
        if let Some(v) = head_sha {
            o.insert("head_sha".into(), v.into());
        }
        if let Some(v) = task_id {
            o.insert("task_id".into(), v.into());
        }
        if let Some(v) = signer {
            o.insert("signer".into(), v.into());
        }
        if let Some(v) = conflict_files {
            if !v.is_empty() {
                o.insert("conflict_files".into(), json!(v));
            }
        }
        if let Some(v) = reason {
            o.insert("reason".into(), v.into());
        }
        self.mcp("train_event", a)
    }

    /// The lane's merged PR facts: (state, mergeCommit.oid) when present.
    fn merge_commit_of(facts: &Value) -> Option<String> {
        facts
            .get("mergeCommit")
            .and_then(|m| m.get("oid"))
            .and_then(Value::as_str)
            .map(String::from)
    }
}

// ---------------------------------------------------------------------------
// the lane driver — one lane, one tick
// ---------------------------------------------------------------------------

enum LaneOutcome {
    /// the arm ran to its own end (including its internal releases)
    Done,
    /// lease held live elsewhere — stood down silently
    Held,
    /// the lane errored mid-tick (fail-closed: logged, lease released)
    Failed,
}

fn drive_lane(ctx: &Ctx, lane: &Value) -> LaneOutcome {
    let key = v_str(lane, "lane");
    let (repo, base) = match key.split_once('@') {
        Some((r, b)) => (r.to_string(), b.to_string()),
        None => {
            log_line(Some(&key), "malformed lane key (repo@base expected) — skipping");
            return LaneOutcome::Done;
        }
    };
    match drive_lane_inner(ctx, &key, &repo, &base, lane) {
        Ok(o) => o,
        // fail-closed: the lease lapses (5 min) and the next gateway
        // reconciles from live GitHub. Log the defect; never retry-blind
        // inside the tick.
        Err(e) => {
            log_line(Some(&key), &format!("tick error: {}", trim_chars(&e, 300)));
            let _ = ctx.mcp("train_lease", json!({ "repo": repo, "base": base, "action": "release" }));
            LaneOutcome::Failed
        }
    }
}

fn drive_lane_inner(ctx: &Ctx, key: &str, repo: &str, base: &str, lane: &Value) -> Result<LaneOutcome, String> {
    let required: Vec<String> = lane
        .get("required_workflows")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let typical_ms: i64 =
        lane.get("ci_typical_minutes").and_then(Value::as_i64).unwrap_or(TRAIN_CI_TYPICAL_MINUTES) * 60_000;

    // ---- CAS lease (the hub decides; a conflict means ANOTHER live executor).
    // holder is ALWAYS the authenticated actor (the hub stamps it) — a
    // hand-set holder would not match the lease check on the mutating ops. ----
    let mut lease_args = json!({ "repo": repo, "base": base, "action": "acquire" });
    if !required.is_empty() {
        lease_args["required_workflows"] = json!(required);
    }
    let lease = match ctx.mcp("train_lease", lease_args) {
        Ok(l) => l,
        Err(e) if e.contains("lane lease held live") => {
            log_line(Some(key), "lease held live elsewhere — standing down this tick");
            return Ok(LaneOutcome::Held);
        }
        Err(e) => return Err(e),
    };
    let note = v_str(&lease, "note");
    log_line(
        Some(key),
        &format!(
            "lease: {} (holder={})",
            if note.is_empty() { "acquired".to_string() } else { note },
            ctx.cfg.holder
        ),
    );

    // ---- stop-the-line arm: main is RED and the lane is stopped ----
    if is_truthy(lane.get("stop")) {
        let stop = lane.get("stop").cloned().unwrap_or(Value::Null);
        let stop_sha = v_str(&stop, "sha");
        log_line(Some(key), &format!("line stopped — {} @ {}", v_str(&stop, "reason"), short_sha(&stop_sha)));
        let base_sha = ctx.sh("gh", &["api", &format!("repos/{repo}/commits/{base}"), "--jq", ".sha"], None)?;
        let runs = ctx.check_runs(repo, &base_sha)?;
        let v = classify_main_check_runs(&parse_check_runs(&runs));
        if v.verdict == BaseVerdict::Green {
            ctx.renew(repo, base)?;
            ctx.mcp("train_lease", json!({ "repo": repo, "base": base, "action": "release", "line_green": true }))?;
            log_line(Some(key), "main green again — stop cleared, lane released");
        } else {
            let reds = v.red.iter().map(|r| r.name.as_str()).collect::<Vec<_>>().join(", ");
            log_line(
                Some(key),
                &format!(
                    "main still {}{} — holding",
                    verdict_str(v.verdict),
                    if v.red.is_empty() { String::new() } else { format!(" (red: {reds})") }
                ),
            );
        }
        return Ok(LaneOutcome::Done);
    }

    let currently = lane.get("currently").cloned().unwrap_or(Value::Null);

    // ---- post-stop residue: the stop cleared (main green again) but the
    // in-flight record is the broken merge commit — it must never be polled
    // toward a landing. The culprit card was bounced at stop time; the lane
    // is idle for queue purposes. ----
    if v_str(&currently, "phase") == "stopped" {
        log_line(Some(key), "stop cleared — stale in-flight record; lane idle (culprit card re-enters via verify)");
        release_if_idle(ctx, key, repo, base)?;
        return Ok(LaneOutcome::Done);
    }

    // ---- awaiting-CI arm: poll the merge commit, HUB decides ----
    if v_str(&currently, "phase") == "awaiting-ci" {
        let cur_pr = currently.get("pr").and_then(Value::as_i64).unwrap_or(0);
        let merge_sha = v_str(&currently, "merge_sha");
        // reconcile first: the recorded merge sha must actually be on base —
        // a lane that says merged for a sha git can't find is a crashed
        // executor's half-truth; bounce the card instead of polling forever.
        ctx.sh("git", &["fetch", "--quiet", "origin", base], None)?;
        let on_base = git_ok(&ctx.cfg, &["merge-base", "--is-ancestor", &merge_sha, &format!("origin/{base}")]);
        if !on_base {
            ctx.renew(repo, base)?;
            let facts = ctx.pr_facts(repo, cur_pr).unwrap_or(Value::Null);
            if v_str(&facts, "state") != "MERGED" {
                ctx.train_event(
                    repo, base, "bounced", cur_pr, None, None,
                    currently.get("task_id").and_then(Value::as_str).map(String::from),
                    None, None,
                    Some("reconcile: the lane's recorded merge never landed on base (executor crashed mid-merge) — fix-forward and re-queue".into()),
                )?;
                log_line(Some(key), &format!("reconcile: recorded merge {} not on base — PR #{cur_pr} bounced", short_sha(&merge_sha)));
                return Ok(LaneOutcome::Done);
            }
            // merged on GitHub but the event never fired — recover by stamping now
            let mc = Ctx::merge_commit_of(&facts).unwrap_or_else(|| merge_sha.clone());
            ctx.train_event(
                repo, base, "merged", cur_pr, Some(mc),
                facts.get("headRefOid").and_then(Value::as_str).map(String::from),
                currently.get("task_id").and_then(Value::as_str).map(String::from),
                Some(ctx.cfg.holder.clone()), None,
                Some("reconcile: merge happened but the train event was lost — stamped from live GitHub".into()),
            )?;
            log_line(Some(key), &format!("reconcile: PR #{cur_pr} merged on GitHub, event recovered"));
        }
        ctx.renew(repo, base)?;
        let runs = ctx.check_runs(repo, &merge_sha)?;
        let ci = ctx.mcp("train_ci", json!({ "repo": repo, "base": base, "sha": merge_sha, "checks": runs }))?;
        let decided = v_str(&ci, "decided");
        let pending = str_vec(ci.get("pending"));
        let missing = str_vec(ci.get("missing"));
        log_line(
            Some(key),
            &format!(
                "CI poll on {}: {}{}{}",
                short_sha(&merge_sha),
                if decided.is_empty() { "?".to_string() } else { decided.clone() },
                if pending.is_empty() { String::new() } else { format!(" (pending: {})", pending.join(", ")) },
                if missing.is_empty() { String::new() } else { format!(" (missing: {})", missing.join(", ")) },
            ),
        );
        if decided == "pending" {
            let merged_at = currently.get("merged_at").and_then(Value::as_i64).unwrap_or(now_ms() as i64);
            let left = TRAIN_CI_BOUND_MULTIPLIER * typical_ms - (now_ms() as i64 - merged_at);
            if left > 0 {
                let mins = ((left as f64 / 60_000.0).round() as i64).max(1);
                log_line(Some(key), &format!("fail-closed bound in ~{mins}m"));
            }
        }
        return Ok(LaneOutcome::Done);
    }

    // ---- idle arm: pick queue[0] and gate it (STRICT serialization — one
    // candidate per lane per tick; a non-mergeable head blocks the train) ----
    let queue = lane.get("queue").and_then(Value::as_array).cloned().unwrap_or_default();
    if queue.is_empty() {
        release_if_idle(ctx, key, repo, base)?;
        return Ok(LaneOutcome::Done);
    }
    let head = &queue[0];
    let card_id = v_str(head, "id");
    let card = ctx.mcp("get_artefact", json!({ "id": card_id }))?;
    let card_meta = card.get("meta").cloned().unwrap_or(json!({}));
    // BR#3659: the card is a LIST of legs (meta.prs; meta.pr stays the first
    // for legacy readers). THIS lane drives the first UNLANDED leg whose
    // repo is this lane's — a multi-repo card appears in each of its lanes
    // until that repo's legs are done.
    let legs = train_legs(&card_meta);
    let lane_legs: Vec<(TrainLeg, i64)> = legs
        .iter()
        .enumerate()
        .map(|(i, leg)| (leg.clone(), i as i64 + 1))
        .filter(|(leg, _)| leg.repo == repo && !train_leg_landed(&card_meta, leg))
        .collect();
    if lane_legs.is_empty() {
        // no unlanded leg on this lane. Crash-window reconcile: every leg
        // landed but the card never closed (executor died between the last
        // merge and train:landed) — re-stamp the last leg so the hub's landed
        // flow runs; otherwise just move on (another lane owns the rest).
        let all_landed = !legs.is_empty() && legs.iter().all(|l| train_leg_landed(&card_meta, l));
        let last_landed = legs.iter().rev().find(|l| train_leg_landed(&card_meta, l)).cloned();
        if all_landed
            && last_landed.as_ref().map(|l| l.repo == repo).unwrap_or(false)
            && v_str(&card, "status") == "blocked"
        {
            let last = last_landed.expect("checked above");
            ctx.renew(repo, base)?;
            let merge_sha = card_meta
                .get("merge_train")
                .and_then(|mt| mt.get("legs"))
                .and_then(|ls| ls.get(&last.number.to_string()))
                .and_then(|e| e.get("merge_sha"))
                .and_then(Value::as_str)
                .map(String::from)
                .or_else(|| {
                    card_meta
                        .get("merge_train")
                        .and_then(|mt| mt.get("merge_sha"))
                        .and_then(Value::as_str)
                        .map(String::from)
                });
            ctx.train_event(
                repo, base, "merged", last.number, merge_sha, None, Some(card_id.clone()),
                Some(ctx.cfg.holder.clone()), None,
                Some("reconcile: all legs landed but the card never closed (crash between merge and landed) — re-stamped".into()),
            )?;
            log_line(Some(key), &format!("reconcile: card {card_id} all legs landed — re-stamped PR #{} for the landed close", last.number));
        } else {
            log_line(Some(key), &format!("card {card_id} has no unlanded leg on this lane ({} leg(s) cited) — moving on", legs.len()));
        }
        release_if_idle(ctx, key, repo, base)?;
        return Ok(LaneOutcome::Done);
    }
    let (leg, leg_number) = lane_legs[0].clone();
    let pr = leg.number;
    if pr == 0 || leg.repo.is_empty() {
        log_line(Some(key), &format!("queue head {card_id} leg {leg_number} carries no PR stamp — skipping (verify convention violation; see hub audit)"));
        release_if_idle(ctx, key, repo, base)?;
        return Ok(LaneOutcome::Done);
    }
    let facts = ctx.pr_facts(repo, pr)?;
    if v_str(&facts, "state") == "MERGED" {
        if let Some(mc) = Ctx::merge_commit_of(&facts) {
            // reconcile: merged on GitHub, no train event (crash between merge and
            // event) — stamp it and let the CI poll take over next tick.
            ctx.renew(repo, base)?;
            ctx.train_event(
                repo, base, "merged", pr, Some(mc), Some(v_str(&facts, "headRefOid")),
                Some(card_id.clone()), Some(ctx.cfg.holder.clone()), None,
                Some("reconcile: PR already merged on GitHub — event stamped from live state".into()),
            )?;
            log_line(Some(key), &format!("reconcile: PR #{pr} was already merged — stamped, awaiting CI"));
            return Ok(LaneOutcome::Done);
        }
    }
    if v_str(&facts, "state") == "CLOSED" {
        log_line(Some(key), &format!("queue head PR #{pr} is CLOSED on GitHub — dropping from the lane (card stays for the humans)"));
        release_if_idle(ctx, key, repo, base)?;
        return Ok(LaneOutcome::Done);
    }
    let head_sha = v_str(&facts, "headRefOid");
    let base_sha = ctx.sh("gh", &["api", &format!("repos/{repo}/commits/{base}"), "--jq", ".sha"], None)?;
    let base_runs = ctx.check_runs(repo, &base_sha)?;
    let base_verdict = classify_main_check_runs(&parse_check_runs(&base_runs)).verdict;
    let head_runs = ctx.check_runs(repo, &head_sha)?;
    let head_checks = parse_check_runs(&head_runs);
    let commits = ctx.pr_commits(repo, pr)?;
    let gate = decide_train_gate(TrainGateInput {
        pr_number: pr,
        head_sha: &head_sha,
        card_meta: &card_meta,
        card_status: card.get("status").and_then(Value::as_str),
        base_verdict,
        mergeable: facts.get("mergeable").and_then(Value::as_bool),
        merge_state_status: facts.get("mergeStateStatus").and_then(Value::as_str),
        commits: &commits,
        head_checks: &head_checks,
        leg_number: Some(leg_number),
    });
    let detail = gate
        .defect()
        .or_else(|| gate.reason())
        .map(|s| format!(" — {s}"))
        .unwrap_or_default();
    log_line(Some(key), &format!("queue[0] PR #{pr} ({card_id}): gate → {}{detail}", gate.kind()));

    if gate.kind() == "skip" || gate.kind() == "note" {
        release_if_idle(ctx, key, repo, base)?;
        return Ok(LaneOutcome::Done);
    }
    if gate.kind() == "human_leg" {
        // ONE ask per class (5c): identical-open-ask dedupe keeps this single.
        let reason = gate.reason().unwrap_or_default().to_string();
        ctx.renew(repo, base)?;
        ctx.mcp(
            "ask_agent",
            json!({
                "to": "human",
                "question": merge_sweep_human_leg_title(repo, &[reason.clone()]),
                "reason": reason,
                "options": ["Will re-sign and re-push", "Needs a decision"],
                "artefact_id": card_id,
            }),
        )?;
        log_line(Some(key), &format!("human leg filed: {}", gate.reason().unwrap_or_default()));
        release_if_idle(ctx, key, repo, base)?;
        return Ok(LaneOutcome::Done);
    }
    if gate.kind() == "close_superseded" {
        let reason = gate.reason().unwrap_or_default().to_string();
        ctx.renew(repo, base)?;
        ctx.sh(
            "gh",
            &["pr", "close", &pr.to_string(), "--repo", repo, "--comment", &trim_chars(&reason, 240)],
            None,
        )?;
        log_line(Some(key), &format!("PR #{pr} closed (superseded card)"));
        release_if_idle(ctx, key, repo, base)?;
        return Ok(LaneOutcome::Done);
    }
    if gate.kind() == "bounce" {
        ctx.renew(repo, base)?;
        // human-resolved conflicts invalidate the verdict: enumerate the
        // conflicting files for the fix-up brief (plumbing merge-tree — no
        // throwaway worktree needed).
        let conflicting = facts.get("mergeable").and_then(Value::as_bool) == Some(false)
            || v_str(&facts, "mergeStateStatus").to_lowercase().contains("conflicting");
        let (_clean, files) = if conflicting { ctx.trial_merge(base, &head_sha)? } else { (true, vec![]) };
        let defect = gate.defect().unwrap_or_default().to_string();
        ctx.train_event(
            repo, base, "bounced", pr, None, Some(head_sha.clone()), Some(card_id.clone()), None,
            Some(files.clone()),
            Some(defect.clone()),
        )?;
        log_line(
            Some(key),
            &format!(
                "PR #{pr} bounced — {}",
                if !files.is_empty() {
                    let head5: Vec<String> = files.iter().take(5).cloned().collect();
                    format!("conflicts in {} file(s): {}{}", files.len(), head5.join(", "), if files.len() > 5 { ", …" } else { "" })
                } else {
                    defect
                }
            ),
        );
        release_if_idle(ctx, key, repo, base)?;
        return Ok(LaneOutcome::Done);
    }
    if gate.kind() != "merge" {
        release_if_idle(ctx, key, repo, base)?;
        return Ok(LaneOutcome::Done);
    }

    // ---- the merge leg: machine-clean update first, then merge ----
    ctx.renew(repo, base)?;
    ctx.sh("git", &["fetch", "--quiet", "origin", base], None)?;
    let behind = !git_ok(&ctx.cfg, &["merge-base", "--is-ancestor", &format!("origin/{base}"), &head_sha]);
    // BR#3659: the behind-check reads THIS leg's accepted-at head, not the
    // card-level first-leg stamp — each leg carries its own verdict.
    if behind && head_sha == leg.head_sha_at_acceptance.clone().unwrap_or_default().to_lowercase() {
        // base advanced past a verdict-covered head: update-branch is the
        // MACHINE-clean rebase — if it lands, the verdict carries (BR#3516 §5);
        // if it conflicts, that's human-resolved — bounce with the file list.
        let (clean, files) = ctx.trial_merge(base, &head_sha)?;
        if !clean {
            ctx.train_event(
                repo, base, "bounced", pr, None, Some(head_sha.clone()), Some(card_id.clone()), None,
                Some(files.clone()),
                Some(format!("base {base} advanced into the PR's files — rebase conflicts are human-resolved; the verdict does not carry")),
            )?;
            let head5: Vec<String> = files.iter().take(5).cloned().collect();
            log_line(
                Some(key),
                &format!(
                    "PR #{pr} bounced (rebase conflicts: {}{})",
                    head5.join(", "),
                    if files.len() > 5 { ", …" } else { "" }
                ),
            );
            release_if_idle(ctx, key, repo, base)?;
            return Ok(LaneOutcome::Done);
        }
        ctx.sh("gh", &["pr", "update-branch", &pr.to_string(), "--repo", repo], None)?;
        let updated = ctx.pr_facts(repo, pr)?;
        log_line(
            Some(key),
            &format!(
                "machine update-branch clean: {} → {} (verdict carries)",
                short_sha(&head_sha),
                short_sha(&v_str(&updated, "headRefOid"))
            ),
        );
        if updated.get("mergeable").and_then(Value::as_bool) != Some(true) {
            log_line(Some(key), "mergeability recomputing after update-branch — next tick");
            release_if_idle(ctx, key, repo, base)?;
            return Ok(LaneOutcome::Done);
        }
    }
    ctx.sh("gh", &["pr", "merge", &pr.to_string(), "--repo", repo, method_flag(&ctx.cfg.method)], None)?;
    let merged = ctx.pr_facts(repo, pr)?;
    let merge_sha = Ctx::merge_commit_of(&merged).unwrap_or_default();
    if v_str(&merged, "state") != "MERGED" || merge_sha.is_empty() {
        return Err(format!(
            "gh pr merge reported ok but PR #{pr} is {} with no mergeCommit — DO NOT trust this tick; investigate",
            v_str(&merged, "state")
        ));
    }
    ctx.train_event(
        repo, base, "merged", pr, Some(merge_sha.clone()), Some(v_str(&merged, "headRefOid")),
        Some(card_id.clone()), Some(ctx.cfg.holder.clone()), None, None,
    )?;
    log_line(Some(key), &format!("PR #{pr} merged as {} — awaiting CI on the merge commit", short_sha(&merge_sha)));
    Ok(LaneOutcome::Done)
}

// ---------------------------------------------------------------------------
// main loop
// ---------------------------------------------------------------------------

/// One tick over every lane. Returns whether any lane errored (the once-mode
/// exit code 1 — the mjs `process.exitCode = 1` inside the lane catch).
fn tick(ctx: &Ctx) -> Result<bool, String> {
    let mut failed = false;
    let mut st_args = json!({});
    if let Some(lf) = &ctx.cfg.lane_filter {
        st_args["repo"] = json!(lf.split('@').next().unwrap_or(lf));
    }
    let st = ctx.mcp("train_status", st_args)?;
    let lanes = st.get("lanes").and_then(Value::as_array).cloned().unwrap_or_default();
    if lanes.is_empty() {
        log_line(None, "no lanes configured — seed one via train_lane or the train_lane setting");
    }
    for lane in &lanes {
        let key = v_str(lane, "lane");
        if ctx.cfg.lane_filter.as_deref().map(|lf| key != lf).unwrap_or(false) {
            continue;
        }
        let q = lane.get("queue").and_then(Value::as_array);
        if q.map(|q| !q.is_empty()).unwrap_or(false) {
            // the hub COMPUTES the queue (CRITICAL/boosted first, FIFO) — the
            // executor consumes it in order, never re-derives it.
            let items: Vec<String> = q
                .expect("checked non-empty")
                .iter()
                .map(|e| format!("{}{}", v_str(e, "id"), if v_str(e, "priority") == "critical" { "!" } else { "" }))
                .collect();
            log_line(Some(&key), &format!("queue: {}", items.join(" → ")));
        }
        if let LaneOutcome::Failed = drive_lane(ctx, lane) {
            failed = true;
        }
    }
    Ok(failed)
}

/// `bridge train [--once]` entry — returns the process exit code. Loop mode
/// never returns (Ctrl-C kills it; the hub owns all authoritative state, so
/// a killed executor leaves the 5-minute lease to lapse and the next gateway
/// reconciles from live GitHub).
pub fn run(args: &[String]) -> i32 {
    let cfg = TrainConfig::from_args(args);
    let ctx = Ctx::new(cfg);
    if let Err(e) = preflight(&ctx.cfg) {
        eprintln!("[merge-train] fatal: {e}");
        return 1;
    }
    if ctx.cfg.once {
        return match tick(&ctx) {
            Ok(failed) => {
                if failed {
                    1
                } else {
                    0
                }
            }
            Err(e) => {
                eprintln!("[merge-train] fatal: {}", trim_chars(&e, 300));
                1
            }
        };
    }
    loop {
        let started = now_ms();
        if let Err(e) = tick(&ctx) {
            log_line(None, &format!("tick failed: {}", trim_chars(&e, 300)));
        }
        let spent = now_ms() - started;
        let wait = ctx.cfg.interval_ms.saturating_sub(spent).max(1_000);
        std::thread::sleep(std::time::Duration::from_millis(wait));
    }
}

// ---------------------------------------------------------------------------
// tests — the executor's own surface (config parsing + the pure helpers the
// lane driver leans on; the decision layer is pinned in train_gate.rs and,
// on the hub side, packages/worker/test/merge-train.test.ts)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn args(extra: &[&str]) -> Vec<String> {
        let mut v = vec!["bridge".to_string(), "train".to_string()];
        v.extend(extra.iter().map(|s| s.to_string()));
        v
    }

    #[test]
    fn config_parses_the_script_flag_surface() {
        // defaults (flags absent; env overrides are the fallback path — the
        // flags win over env, so these asserts hold under any environment)
        let c = TrainConfig::from_args(&args(&[]));
        assert!(!c.once);
        assert_eq!(c.lane_filter, None);
        assert_eq!(c.interval_ms, 45_000);
        assert_eq!(c.method, "merge");
        // every flag the script accepted, accepted identically
        let c = TrainConfig::from_args(&args(&["--once", "--lane", "r/x@main", "--interval", "10", "--method", "squash"]));
        assert!(c.once);
        assert_eq!(c.lane_filter.as_deref(), Some("r/x@main"));
        assert_eq!(c.interval_ms, 10_000);
        assert_eq!(c.method, "squash");
        // unknown tokens were ignored by the script — same laxity here
        let c = TrainConfig::from_args(&args(&["--once", "--wat"]));
        assert!(c.once);
    }

    #[test]
    fn method_flag_maps_all_three_merge_methods() {
        assert_eq!(method_flag("merge"), "--merge");
        assert_eq!(method_flag("squash"), "--squash");
        assert_eq!(method_flag("rebase"), "--rebase");
        assert_eq!(method_flag("nonsense"), "--merge");
    }
}
