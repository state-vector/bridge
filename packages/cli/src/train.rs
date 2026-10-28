//! train — the native merge-train executor, `bridge train [--once]` (BR#3879,
//! decision BR#3880). Mechanical port of scripts/merge-train.mjs (BR#3517,
//! decision BR#3516): same contract — 45s tick loop / single tick, doctor
//! preflight, CAS lane lease (hub API over the hub's /mcp), reconcile from
//! live GitHub via `gh`, feed reports, hub decides (decide_train_gate in
//! train_gate.rs), provenance stamps, bounce/rebase, stop-the-line. The hub
//! holds no VCS credentials; this executor shells `gh`/`git` locally.

use crate::train_gate::{
    classify_main_check_runs, decide_train_gate, merge_sweep_human_leg_title, normalize_gh_mergeable,
    normalize_gh_merge_state, short_sha, train_leg_landed, train_legs, BaseVerdict, MainCheckRun,
    MergeAction, PrCommit, TrainGateInput, TRAIN_CI_BOUND_MULTIPLIER, TRAIN_CI_TYPICAL_MINUTES,
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
