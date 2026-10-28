//! train.rs — the native merge-train executor (`bridge train`, BR#3879 per
//! accepted decision BR#3880). Behavior-verbatim port of the former Node
//! executor (BR#3516/BR#3517).
//!
//! Division of labour (the whole point of the design): the HUB holds NO VCS
//! credentials, ever. This executor runs on a gateway machine that HAS `gh`
//! (+ a clone of the target repo), fetches every GitHub fact live, and
//! reports them through the hub's train ops — the HUB decides (lease CAS,
//! classification, events, queue). The executor never self-certifies.
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
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const SESSION: &str = "merge-train-executor";
const RPC_TIMEOUT: Duration = Duration::from_secs(60);

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
    let _ = writeln!(
        std::io::stdout(),
        "[{}]{} {msg}",
        iso(now_ms()),
        lane.map(|l| format!(" {l}")).unwrap_or_default()
    );
    let _ = std::io::stdout().flush();
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
        Ok(Ctx {
            http: reqwest::blocking::Client::builder().timeout(RPC_TIMEOUT).build().map_err(|e| e.to_string())?,
            hub: hub.trim_end_matches('/').to_string(),
            token,
            holder,
            interval_ms: interval_secs.max(1) * 1000,
            method,
            workdir: std::env::var("MERGE_TRAIN_WORKDIR").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| ".".into()),
            lane_filter: Self::flag(args, "--lane"),
            once: args.iter().any(|a| a == "--once"),
            rpc_id: 0,
        })
    }

    /// MCP over the hub's /mcp — the same JSON-RPC surface the agents use.
    fn mcp(&mut self, name: &str, args_body: Value) -> Result<Value, String> {
        self.rpc_id += 1;
        let mut arguments = args_body;
        if let Value::Object(map) = &mut arguments {
            map.insert("session".into(), json!(SESSION));
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

    fn preflight(&self) -> Result<(), String> {
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
        if !Command::new("git")
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
        log(None, &format!("executor up — holder={} method={} interval={}s workdir={}", self.holder, self.method, self.interval_ms / 1000, self.workdir));
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

fn renew_lease(ctx: &mut Ctx, repo: &str, base: &str) -> bool {
    ctx.train_lease(repo, base, "renew", json!({})).is_ok()
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
        if ctx.once {
            std::process::exit(1);
        }
    }
}

fn drive_lane_inner(ctx: &mut Ctx, lane: &Value, key: &str, repo: &str, base: &str, typical_ms: u64) -> Result<(), String> {
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
                log(Some(key), &format!("reconcile: recorded merge {} not on base — PR #{cur_pr} bounced", &merge_sha[..merge_sha.len().min(9)]));
                return Ok(());
            }
            // merged on GitHub but the event never fired — recover by stamping now
            ctx.mcp("train_event", json!({ "repo": repo, "base": base, "kind": "merged", "pr": cur_pr, "merge_sha": facts.as_ref().and_then(|f| f.pointer("/mergeCommit/oid")).and_then(|v| v.as_str()).unwrap_or(&merge_sha), "head_sha": facts.as_ref().and_then(|f| vstr(f, "headRefOid")), "task_id": cur.get("task_id").filter(|v| !v.is_null()), "signer": ctx.holder, "reason": "reconcile: merge happened but the train event was lost — stamped from live GitHub" }))?;
            log(Some(key), &format!("reconcile: PR #{cur_pr} merged on GitHub, event recovered"));
        }
        renew_lease(ctx, repo, base);
        let runs = ctx.check_runs(repo, &merge_sha);
        let ci = ctx.mcp("train_ci", json!({ "repo": repo, "base": base, "sha": merge_sha, "checks": runs }))?;
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
        MergeAction::Bounce { defect } => ("bounce", format!(" — {defect}")),
        MergeAction::Note { reason } => ("note", format!(" — {reason}")),
        MergeAction::Skip { reason } => ("skip", format!(" — {reason}")),
        MergeAction::HumanLeg { reason } => ("human_leg", format!(" — {reason}")),
    };
    log(Some(key), &format!("queue[0] PR #{pr} ({head_id}): gate → {kind}{detail}"));

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
            log(Some(key), &format!("human leg filed: {reason}"));
            release_if_idle(ctx, key, repo, base)?;
            Ok(())
        }
        MergeAction::CloseSuperseded { reason } => {
            renew_lease(ctx, repo, base);
            ctx.sh("gh", &["pr", "close", &pr.to_string(), "--repo", repo, "--comment", &trunc(&reason, 240)])?;
            log(Some(key), &format!("PR #{pr} closed (superseded card)"));
            release_if_idle(ctx, key, repo, base)?;
            Ok(())
        }
        MergeAction::Bounce { defect } => {
            renew_lease(ctx, repo, base);
            // human-resolved conflicts invalidate the verdict: enumerate the
            // conflicting files for the fix-up brief (plumbing merge-tree —
            // no throwaway worktree needed).
            let conflicting = facts.get("mergeable") == Some(&json!(false))
                || vstr(&facts, "mergeStateStatus").map(|s| s.to_uppercase().contains("CONFLICTING")).unwrap_or(false);
            let (clean, files) = if conflicting { ctx.trial_merge(base, &head_sha)? } else { (true, vec![]) };
            let mut ev = json!({ "repo": repo, "base": base, "kind": "bounced", "pr": pr, "task_id": head_id, "head_sha": head_sha, "reason": defect });
            if !clean && !files.is_empty() {
                ev.as_object_mut().unwrap().insert("conflict_files".into(), json!(files));
            }
            ctx.mcp("train_event", ev)?;
            let files_note = if !clean && !files.is_empty() {
                format!("conflicts in {} file(s): {}{}", files.len(), files.iter().take(5).cloned().collect::<Vec<_>>().join(", "), if files.len() > 5 { ", …" } else { "" })
            } else {
                defect.clone()
            };
            log(Some(key), &format!("PR #{pr} bounced — {files_note}"));
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
                    ctx.mcp("train_event", json!({ "repo": repo, "base": base, "kind": "bounced", "pr": pr, "task_id": head_id, "head_sha": head_sha, "conflict_files": tm_files, "reason": format!("base {base} advanced into the PR's files — rebase conflicts are human-resolved; the verdict does not carry") }))?;
                    log(Some(key), &format!("PR #{pr} bounced (rebase conflicts: {}{})", tm_files.iter().take(5).cloned().collect::<Vec<_>>().join(", "), if tm_files.len() > 5 { ", …" } else { "" }));
                    release_if_idle(ctx, key, repo, base)?;
                    return Ok(());
                }
                ctx.sh("gh", &["pr", "update-branch", &pr.to_string(), "--repo", repo])?;
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
    if let Err(e) = ctx.preflight() {
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
