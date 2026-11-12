//! train_gate.rs — the merge-train admission gate, ported from
//! packages/worker/src/kb/core.ts (decision BR#3516, executor BR#3517,
//! native port BR#3879 / decision BR#3880).
//!
//! DUAL IMPLEMENTATION DISCLOSURE: the hub keeps the TypeScript original
//! (unit-pinned in packages/worker/test/merge-train.test.ts); this Rust port
//! is pinned by mirrored fixtures in this file. Every user-visible message
//! is byte-identical to the TS — the hub re-classifies executor-fed reports
//! and ask-dedupe keys on exact wording.

use serde_json::Value;

pub const TRAIN_CI_BOUND_MULTIPLIER: u64 = 3;
pub const TRAIN_CI_TYPICAL_MINUTES: u64 = 20;

const MAIN_RED_CONCLUSIONS: [&str; 4] = ["failure", "timed_out", "action_required", "startup_failure"];
// BR#6001: 'superpositional' joins the exempt list — the 'Superpositional'
// external check is posted by the superpositional-sync GitHub App, NOT a repo
// workflow, and per accepted BR#3177 a failing SP review pipeline (process
// error) is a Superpositional quality issue, never a merge gate. The app's
// indexing pipeline failures (IndexingFailed/States.Timeout, check-run
// 126241425334 on PR #387/#390 heads) held two verified PRs out of the lane
// for >60m. MUST stay behaviour-identical to core.ts MERGE_EXEMPT_CHECK_PATTERNS.
const MERGE_EXEMPT_CHECK_PATTERNS: [&str; 7] = [
    "workers builds",
    "workers-builds",
    "cloudflare pages",
    "cloudflare workers",
    "deploy preview",
    "codeql",
    "superpositional",
];

/// BR#9268: the producer class of a check-run observation — derived from the
/// provider payload itself (the check run's GitHub URL shape), never
/// caller-asserted. GitHub files an API-created check run into the creating
/// app's most recent check suite for the head SHA, so a published report can
/// share name + app id (GitHub Actions = 15368) + suite id with a native job
/// while enforcing nothing on its own (live SP PR #3057 head: check-run
/// 129034449798 `/runs/129034449798` vs job check-run 128984021963
/// `/actions/runs/42563228107/job/128984021963`, identical name/app/suite).
/// MUST stay behaviour-identical to contracts train-checks.ts
/// `CheckRunProducerSchema` / `checkRunProducer`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckRunProducer {
    /// A NATIVE Actions job (`…/actions/runs/{run}/job/{job}`) — the
    /// enforcing execution; a dispatch re-runs THIS.
    ActionsJob,
    /// An API-created check run (`…/runs/{check_run_id}`) — a report; a
    /// newer one supersedes only other published reports and can never mask
    /// (or be masked by) the native job's verdict.
    Published,
    /// URL missing or an unrecognized shape — its own obligation (never
    /// merges with a classified one), never dispatchable (fail-closed).
    Unclassified,
}

/// GitHub's own Actions app id (BR#9268): every GITHUB_TOKEN-created check
/// run — native job AND published report — carries it; it can never separate
/// the two. MUST stay identical to contracts train-checks.ts
/// GITHUB_ACTIONS_APP_ID.
pub const GITHUB_ACTIONS_APP_ID: i64 = 15368;

/// MUST stay behaviour-identical to contracts train-checks.ts `checkRunProducer`.
pub fn check_run_producer(url: Option<&str>) -> CheckRunProducer {
    let u = url.unwrap_or("").trim();
    let rest = match u.strip_prefix("https://github.com/") { Some(r) => r, None => return CheckRunProducer::Unclassified };
    let parts: Vec<&str> = rest.split('/').collect();
    match parts.as_slice() {
        // {owner}/{repo}/actions/runs/{run}/job/{job}
        [_, _, "actions", "runs", run, "job", job]
            if is_positive_digits(run) && is_positive_digits(job) => CheckRunProducer::ActionsJob,
        // {owner}/{repo}/runs/{check_run_id}
        [_, _, "runs", id] if is_positive_digits(id) => CheckRunProducer::Published,
        _ => CheckRunProducer::Unclassified,
    }
}

fn is_positive_digits(s: &str) -> bool {
    !s.is_empty() && s.as_bytes()[0].is_ascii_digit() && s.as_bytes()[0] != b'0' && s.bytes().all(|b| b.is_ascii_digit())
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CheckSource {
    Unknown,
    CheckRun { suite_id: i64, app_id: i64, producer: CheckRunProducer },
    WorkflowRun { workflow_id: i64, run_attempt: u64 },
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct MainCheckRun {
    pub id: i64,
    pub source: CheckSource,
    pub name: String,
    pub status: Option<String>,
    pub conclusion: Option<String>,
    pub html_url: Option<String>,
}

#[derive(Clone, Debug)]
pub struct MainRedCheck {
    pub name: String,
    pub conclusion: String,
    pub url: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum MainVerdict {
    Green,
    /// BR#14088: a required check that is queued/in_progress (GitHub files a
    /// check run's conclusion only at completion) has NO verdict yet — the
    /// rollup reads SETTLING: rendered amber, never green. The lane may only
    /// enter a green state when every required check is completed-success at
    /// the observed tip. MUST stay behaviour-identical to core.ts.
    Settling,
    Red,
    Unsettled,
    Empty,
}

impl MainVerdict {
    pub fn as_str(&self) -> &'static str {
        match self {
            MainVerdict::Green => "green",
            MainVerdict::Settling => "settling",
            MainVerdict::Red => "red",
            MainVerdict::Unsettled => "unsettled",
            MainVerdict::Empty => "empty",
        }
    }
}

#[derive(Clone, Debug)]
pub struct CheckVerdict {
    pub verdict: MainVerdict,
    pub red: Vec<MainRedCheck>,
    /// BR#14088: checks that are IN FLIGHT (queued/in_progress — conclusion
    /// null) or required names with no run yet ("(awaiting first run)").
    /// Rendered amber ("settling"), never green. Names ALSO fold into
    /// `unsettled` so every list-consuming surface (banner, gate rows,
    /// laneSyncReason vocabulary) keeps naming the checks while the VERDICT
    /// carries the truth. MUST stay behaviour-identical to core.ts.
    pub settling: Vec<String>,
    pub unsettled: Vec<String>,
    pub external: Vec<MainRedCheck>,
    pub green: usize,
    /// BR#5674 P1 (empty-is-loud): when verdict == Empty, explains WHY:
    /// - zero total runs on the tip → "tip carries no check runs at all"
    /// - N runs read but 0 matched required_workflows → "{N} runs read, none matched required set — check names/pagination"
    pub alarm: Option<String>,
    /// BR#5883 (gate-consumed qualifier): set ONLY when the lane-scoped
    /// verdict is Green while the repo's own merge gate (`main-green gate`,
    /// scripts/main-green-gate.sh — it judges main's WHOLE tip, the exact
    /// classify_main_check_runs predicate) would judge that same tip
    /// non-green. The lane verdict stays Green (BR#5265's law: non-required
    /// reds never park the train), but a plain green is no longer certified —
    /// the hub escalates the qualifier at P1 and the lane vocabulary names
    /// the gate-blocking checks. None whenever the verdict already speaks
    /// for the whole tip (unconfigured lanes) or is itself non-green.
    pub gate: Option<GateBlock>,
}

/// BR#5883: the repo gate's own view of the tip — what `main-green gate`
/// would report right now (per-name newest-non-cancelled judge, any red /
/// any unsettled fails, zero runs fails).
#[derive(Clone, Debug)]
pub struct GateBlock {
    pub verdict: MainVerdict,
    pub red: Vec<MainRedCheck>,
    pub unsettled: Vec<String>,
}

fn is_red_conclusion(c: &str) -> bool {
    MAIN_RED_CONCLUSIONS.contains(&c)
}

fn settled_green(c: &str) -> bool {
    c == "success" || c == "skipped" || c == "neutral"
}

/// BR#2267 exempt-external names (BR#6001 list). BR#6568: now also consumed
/// by the probe path (train.rs classify_rollup, the observation behind the
/// typed pr_checks_green await) — an exempt external failing must not park a
/// typed await, exactly as it must not bounce a merge (BR#3177 law).
pub fn is_exempt_check_name(name: &str) -> bool {
    let n = name.to_lowercase();
    MERGE_EXEMPT_CHECK_PATTERNS.iter().any(|p| n.contains(p))
}

fn parse_runs(runs: &[MainCheckRun]) -> Vec<(String, Vec<&MainCheckRun>)> {
    let mut by_name: Vec<(String, Vec<&MainCheckRun>)> = Vec::new();
    for r in runs {
        match by_name.iter_mut().find(|(n, list)| *n == r.name && same_check_obligation(&list[0].source, &r.source)) {
            Some((_, list)) => list.push(r),
            None => by_name.push((r.name.clone(), vec![r])),
        }
    }
    by_name
}

/// BR#9268: two check runs are the SAME enforcing obligation only when their
/// producer class also matches — a native Actions job and an API-published
/// report of the same name/app/suite are distinct obligations (a newer
/// published green must never supersede — mask — an older native red, and
/// vice versa; GitHub keeps BLOCKED in exactly that shape). Supersession
/// stays WITHIN one producer class.
fn same_check_obligation(a: &CheckSource, b: &CheckSource) -> bool {
    match (a, b) {
        (CheckSource::Unknown, CheckSource::Unknown) => true,
        (CheckSource::CheckRun { suite_id: a, app_id: aa, producer: pa }, CheckSource::CheckRun { suite_id: b, app_id: ba, producer: pb }) => {
            a == b && aa == ba && pa == pb
        }
        (CheckSource::WorkflowRun { workflow_id: a, .. }, CheckSource::WorkflowRun { workflow_id: b, .. }) => a == b,
        _ => false,
    }
}

/// core.ts classifyMainCheckRuns (764): newest non-cancelled run per name
/// judges; red beats settling beats unsettled beats green; no runs at all =
/// "empty". BR#14088: an in-flight judge (conclusion null — GitHub files a
/// conclusion only at completion, so null = queued/in_progress) yields
/// SETTLING, never green: the name is pushed to `settling` AND folded into
/// `unsettled` so list consumers keep naming the check while the verdict
/// carries the truth.
pub fn classify_main_check_runs(runs: &[MainCheckRun]) -> CheckVerdict {
    if runs.is_empty() {
        return CheckVerdict {
            verdict: MainVerdict::Empty,
            red: vec![],
            settling: vec![],
            unsettled: vec![],
            external: vec![],
            green: 0,
            alarm: Some("tip carries no check runs at all".to_string()),
            gate: None,
        };
    }
    let mut red = Vec::new();
    let mut settling = Vec::new();
    let mut unsettled = Vec::new();
    let mut green = 0usize;
    for (name, list) in parse_runs(runs) {
        let mut sorted: Vec<&&MainCheckRun> = list.iter().collect();
        sorted.sort_by(|a, b| b.id.cmp(&a.id));
        let judge = sorted.into_iter().find(|r| r.conclusion.as_deref() != Some("cancelled"));
        match judge {
            None => unsettled.push(format!("{} (only cancelled runs)", name)),
            Some(j) => match j.conclusion.as_deref() {
                None => {
                    settling.push(name.clone());
                    unsettled.push(name);
                }
                Some(c) if is_red_conclusion(c) => red.push(MainRedCheck {
                    name: name.clone(),
                    conclusion: c.to_string(),
                    url: j.html_url.clone().unwrap_or_default(),
                }),
                Some(c) if settled_green(c) => green += 1,
                Some(c) => unsettled.push(format!("{} (unknown conclusion: {})", name, c)),
            },
        }
    }
    finish_verdict(red, settling, unsettled, vec![], green)
}

/// BR#5265 Fix B + BR#5674 P1 (empty-is-loud): the base-green gate classifies
/// ONLY the lane's required workflows when the lane configures them (newest
/// non-cancelled run per name, red beats unsettled beats green — the same law
/// classify_main_check_runs applies to its set). Un-configured lanes keep
/// the legacy whole-tip read. When required workflows are configured and the
/// scoped filter yields zero on a tip that HAS runs, `alarm` names the exact
/// count ("{N} runs read, none matched required set — check names/pagination");
/// zero-total-runs gets the sibling alarm ("tip carries no check runs at all").
pub fn classify_base_check_runs(runs: &[MainCheckRun], required: &[String]) -> CheckVerdict {
    if runs.is_empty() {
        return CheckVerdict {
            verdict: MainVerdict::Empty,
            red: vec![],
            settling: vec![],
            unsettled: vec![],
            external: vec![],
            green: 0,
            alarm: Some("tip carries no check runs at all".to_string()),
            gate: None,
        };
    }
    if required.is_empty() {
        return classify_main_check_runs(runs);
    }
    // BR#6142: a workflow-level `startup_failure` (e.g. "Deploy Dev") creates
    // 0 job check-runs, so its name is the workflow name rather than the job
    // names in `required`. Include any non-exempt workflow whose newest
    // non-cancelled run is `startup_failure` in `scoped` so the base verdict
    // immediately speaks RED instead of Empty.
    let mut startup_failed_names: Vec<String> = Vec::new();
    for (name, list) in parse_runs(runs) {
        if is_exempt_check_name(&name) {
            continue;
        }
        let mut sorted: Vec<&&MainCheckRun> = list.iter().collect();
        sorted.sort_by(|a, b| b.id.cmp(&a.id));
        if let Some(j) = sorted.into_iter().find(|r| r.conclusion.as_deref() != Some("cancelled")) {
            if j.conclusion.as_deref() == Some("startup_failure") {
                startup_failed_names.push(name);
            }
        }
    }
    let scoped: Vec<MainCheckRun> = runs
        .iter()
        .filter(|r| required.iter().any(|n| n == &r.name) || startup_failed_names.iter().any(|n| n == &r.name))
        .cloned()
        .collect();
    let gate_runs: Vec<MainCheckRun> = runs
        .iter()
        .filter(|r| !required.iter().any(|n| n == &r.name) && is_base_health_gate_name(&r.name))
        .cloned()
        .collect();
    let gate_verdict = if !gate_runs.is_empty() {
        Some(classify_main_check_runs(&gate_runs))
    } else {
        None
    };
    if scoped.is_empty() {
        if let Some(gv) = gate_verdict {
            if gv.verdict == MainVerdict::Red {
                return gv;
            }
        }
        return CheckVerdict {
            verdict: MainVerdict::Empty,
            red: vec![],
            settling: vec![],
            unsettled: vec![],
            external: vec![],
            green: 0,
            alarm: Some(format!(
                "{} runs read, none matched required set — check names/pagination",
                runs.len()
            )),
            gate: None,
        };
    }
    // Never mask a red base_state mid-burst: when the required-set read is
    // not itself fully green, a red base-health gate folds in — the verdict
    // speaks red instead of a mid-burst green.
    let mut res = classify_main_check_runs(&scoped);
    if let Some(gv) = gate_verdict {
        if gv.verdict == MainVerdict::Red && !(res.verdict == MainVerdict::Green && res.green >= required.len()) {
            res.verdict = MainVerdict::Red;
            res.red.extend(gv.red);
        }
    }
    // BR#14088 required-completeness: green certification requires EVERY
    // required check (incl. the post-admission smoke) settled green at the
    // observed tip. A required name with NO run yet — the smoke job starts
    // last, ~40-60 min after push, so between admission and its first
    // check-run the obligation is invisible — is IN FLIGHT, not absent: it
    // yields SETTLING "(awaiting first run)" and green is forbidden. The
    // documented exception is the `main-green gate` vacuity class (BR#5847:
    // structurally absent on merge-commit tips — the BR#5883 qualifier owns
    // that read), so a vacuous gate never blocks certification.
    let mut missing_required: Vec<String> = Vec::new();
    for name in required {
        if scoped.iter().any(|r| &r.name == name) || startup_failed_names.iter().any(|n| n == name) {
            continue;
        }
        if name.to_lowercase().contains(MAIN_GREEN_GATE_PATTERN) {
            continue; // BR#5847: structurally vacuous on some tip classes
        }
        missing_required.push(name.clone());
    }
    if !missing_required.is_empty() {
        missing_required.sort();
        for name in &missing_required {
            let entry = format!("{} (awaiting first run)", name);
            res.settling.push(entry.clone());
            res.unsettled.push(entry); // fold: list consumers keep naming the check
        }
        if res.verdict != MainVerdict::Red {
            res.verdict = MainVerdict::Settling;
        }
    }
    // BR#5883 (gate-consumed qualifier): a required-set GREEN no longer
    // certifies a plain green when the repo's own merge gate would judge the
    // same tip non-green. On a merge-commit tip the required `main-green
    // gate` run is vacuous (BR#5847) and the checks it consumes (e.g. the
    // 2026-11-03 `Deploy drift alarm` FAILURE, run 41632091557) sit outside
    // the required set — the scoped read certified green while every car's
    // gate failed and the lane starved 3.5h+ with the P1 base alarm silent.
    // The qualifier rides the stamp; the verdict itself stays Green (the
    // BR#5265 law stands: non-required reds never park the walk — the cars'
    // own gate rows and the hub escalation own the block). The two arms
    // compose: the fold above speaks for mid-burst states; this qualifier
    // speaks for the fully-green lane read the fold deliberately leaves
    // untouched.
    if res.verdict == MainVerdict::Green
        && required.iter().any(|n| n.to_lowercase().contains(MAIN_GREEN_GATE_PATTERN))
    {
        let gate = classify_main_check_runs(runs);
        if gate.verdict != MainVerdict::Green {
            return CheckVerdict {
                gate: Some(GateBlock {
                    verdict: gate.verdict,
                    red: gate.red,
                    unsettled: gate.unsettled,
                }),
                ..res
            };
        }
    }
    res
}

/// core.ts classifyHeadChecks (846): same rule as classify_main_check_runs
/// (newest non-cancelled run per check name wins, by highest id — so a
/// re-run that succeeded supersedes an earlier failure of the same check),
/// with exempt-external failures pulled OUT of red into `external`
/// (human-leg class ask, never gating).
pub fn classify_head_checks(runs: &[MainCheckRun]) -> CheckVerdict {
    if runs.is_empty() {
        return finish_verdict(vec![], vec![], vec!["head checks have not started or could not be read".into()], vec![], 0);
    }
    let mut red = Vec::new();
    let mut settling = Vec::new();
    let mut unsettled = Vec::new();
    let mut external = Vec::new();
    let mut green = 0usize;
    for (name, list) in parse_runs(runs) {
        let mut sorted: Vec<&&MainCheckRun> = list.iter().collect();
        sorted.sort_by(|a, b| b.id.cmp(&a.id));
        let judge = sorted.into_iter().find(|r| r.conclusion.as_deref() != Some("cancelled"));
        match judge {
            None => {
                if !is_exempt_check_name(&name) {
                    unsettled.push(format!("{} (only cancelled runs)", name));
                }
            }
            Some(r) => match r.conclusion.as_deref() {
                None => {
                    // BR#14088: an in-flight (queued/in_progress) check has no
                    // verdict yet — SETTLING, never green; fold into unsettled
                    // for list consumers. An EXEMPT in-flight check still says
                    // nothing (the BR#6568 law is untouched).
                    if !is_exempt_check_name(&name) {
                        settling.push(name.clone());
                        unsettled.push(name);
                    }
                }
                Some(c) if is_exempt_check_name(&name) => {
                    if is_red_conclusion(c) {
                        external.push(MainRedCheck { name, conclusion: c.to_string(), url: r.html_url.clone().unwrap_or_default() });
                    } else if settled_green(c) {
                        green += 1;
                    }
                }
                Some(c) if is_red_conclusion(c) => red.push(MainRedCheck {
                    name,
                    conclusion: c.to_string(),
                    url: r.html_url.clone().unwrap_or_default(),
                }),
                Some(c) if settled_green(c) => green += 1,
                Some(c) => unsettled.push(format!("{} (unknown conclusion: {})", name, c)),
            },
        }
    }
    finish_verdict(red, settling, unsettled, external, green)
}

fn finish_verdict(red: Vec<MainRedCheck>, settling: Vec<String>, unsettled: Vec<String>, external: Vec<MainRedCheck>, green: usize) -> CheckVerdict {
    // BR#14088 precedence: red > settling > unsettled > green. A red check
    // stops the line; an in-flight check is settling (amber, never green);
    // only when every check settled green is the verdict green.
    let verdict = if !red.is_empty() {
        MainVerdict::Red
    } else if !settling.is_empty() {
        MainVerdict::Settling
    } else if !unsettled.is_empty() {
        MainVerdict::Unsettled
    } else {
        MainVerdict::Green
    };
    CheckVerdict { verdict, red, settling, unsettled, external, green, alarm: None, gate: None }
}

/// BR#5880 (live incident, tick 2026-11-03T21:23:47Z on PR #2707): the
/// self-heal's RE-RUN DISPATCH set is derived with the SAME newest-wins
/// law as the verdict that fired it (classify_head_checks: newest
/// non-cancelled run per check name, by highest id) — never the raw
/// historical check-run list. At the incident the walk cited Nov-2 red
/// runs (ids 125041293759/125040321562) while the LATEST run on that
/// exact head sha was SUCCESS (id 126074493096, 17:07Z) — a superseded
/// red read as live. Re-requesting a superseded red is worse than noise:
/// it re-opens a check whose latest run already settled, flipping a
/// healed head back to unsettled on the next tick. The dispatch set is
/// therefore: per check name, the judge run (highest id, skipping
/// cancelled) — kept only when THAT run is red-concluded and the check
/// name matches the deploy-health gate class.
/// BR#9268: the set is also PRODUCER-TYPED — only an actually dispatchable
/// execution. A published check run (`/runs/{id}`, the API-created report
/// that can share name/app/suite with the native job) is re-requested by
/// nobody: GitHub's rerequest re-executes nothing for it (the BR#9081
/// no-op burn), and the native job's own verdict is the enforcing one —
/// dispatch the ACTUAL native Actions job, once, on a canonical green
/// base. Unclassified observations are fail-closed: never dispatched. A
/// workflow-run source (a startup-failed workflow folded by BR#6142) is a
/// real run and stays dispatchable.
pub fn latest_red_deploy_health_runs(runs: &[MainCheckRun]) -> Vec<MainCheckRun> {
    let mut out = Vec::new();
    for (name, list) in parse_runs(runs) {
        let mut sorted: Vec<&&MainCheckRun> = list.iter().collect();
        sorted.sort_by(|a, b| b.id.cmp(&a.id));
        let judge = sorted.into_iter().find(|r| r.conclusion.as_deref() != Some("cancelled"));
        if let Some(r) = judge {
            let dispatchable = match &r.source {
                CheckSource::WorkflowRun { .. } => true,
                CheckSource::CheckRun { producer: CheckRunProducer::ActionsJob, .. } => true,
                _ => false,
            };
            if dispatchable
                && r.conclusion.as_deref().is_some_and(is_red_conclusion)
                && is_base_health_gate_name(&name)
            {
                out.push((*r).clone());
            }
        }
    }
    out
}

/// BR#9268: the red judge runs of the deploy-health gate class that are NOT
/// dispatchable executions — published reports (`/runs/{id}`) and
/// unclassified observations. The RerunGate arm reads this when its native
/// dispatch set comes up empty, to tell "waiting on the publisher"
/// (published red: the republisher refreshes it; no native gate job is red)
/// apart from "payload drift — fail-closed and loud" (unclassified red).
pub fn red_report_gate_judges(runs: &[MainCheckRun]) -> Vec<(String, String, bool)> {
    let mut out = Vec::new();
    for (name, list) in parse_runs(runs) {
        if !is_base_health_gate_name(&name) {
            continue;
        }
        let mut sorted: Vec<&&MainCheckRun> = list.iter().collect();
        sorted.sort_by(|a, b| b.id.cmp(&a.id));
        let judge = sorted.into_iter().find(|r| r.conclusion.as_deref() != Some("cancelled"));
        if let Some(r) = judge {
            if r.conclusion.as_deref().is_some_and(is_red_conclusion) {
                match &r.source {
                    CheckSource::CheckRun { producer: CheckRunProducer::Published, .. } => {
                        out.push((name.clone(), r.html_url.clone().unwrap_or_default(), false))
                    }
                    CheckSource::CheckRun { producer: CheckRunProducer::Unclassified, .. } => {
                        out.push((name.clone(), r.html_url.clone().unwrap_or_default(), true))
                    }
                    _ => {}
                }
            }
        }
    }
    out
}

/// BR#5639 (ghost car, 2026-11-03): a batch reached `ready` while binding
/// CLOSED PR #2659 (its live leg was #2759) — BR#3935's `== CLOSED`
/// exclusion shape missed the batch path and any non-CLOSED fall-through
/// (MERGED without a mergeCommit, an unreadable state). Fail-closed law:
/// ONLY a live read that says OPEN can ever make a leg a batch candidate;
/// every other state — CLOSED, MERGED, missing, empty — is excluded (log +
/// advance, the BR#3935 shape: the card stays for the humans, the queue
/// is not held).
pub fn pr_state_is_batch_candidate(state: Option<&str>) -> bool {
    state == Some("OPEN")
}

// ---------- legs (core.ts 1285-1338) ----------

#[derive(Clone, Debug)]
pub struct TrainLeg {
    pub repo: String,
    pub number: i64,
    pub head_sha_at_acceptance: Option<String>,
    pub base: Option<String>,
    pub carry: Option<Value>,
}

/// core.ts trainLegs (1295): meta.prs array (multi-PR) wins, else the legacy
/// meta.pr object as a single leg, else empty.
pub fn train_legs(meta: &Value) -> Vec<TrainLeg> {
    let empty = String::new();
    let legacy_repo = meta.get("pr").and_then(|p| p.get("repo")).and_then(|v| v.as_str()).unwrap_or(&empty).to_string();
    if let Some(prs) = meta.get("prs").and_then(|v| v.as_array()) {
        if !prs.is_empty() {
            return prs
                .iter()
                .map(|l| TrainLeg {
                    repo: l.get("repo").and_then(|v| v.as_str()).map(String::from).unwrap_or_else(|| legacy_repo.clone()),
                    number: l.get("number").and_then(|v| v.as_i64()).unwrap_or(0),
                    head_sha_at_acceptance: l.get("head_sha_at_acceptance").and_then(|v| v.as_str()).map(String::from),
                    base: l.get("base").and_then(|v| v.as_str()).map(String::from),
                    carry: l.get("carry").filter(|v| v.is_array()).cloned(),
                })
                .collect();
        }
    }
    if let Some(pr) = meta.get("pr").filter(|v| v.is_object()) {
        return vec![TrainLeg {
            repo: pr.get("repo").and_then(|v| v.as_str()).map(String::from).unwrap_or_default(),
            number: pr.get("number").and_then(|v| v.as_i64()).unwrap_or(0),
            head_sha_at_acceptance: pr.get("head_sha_at_acceptance").and_then(|v| v.as_str()).map(String::from),
            base: pr.get("base").and_then(|v| v.as_str()).map(String::from),
            carry: pr.get("carry").filter(|v| v.is_array()).cloned(),
        }];
    }
    vec![]
}

/// core.ts trainLegLanded (1320): the per-leg map wins, else the legacy
/// card-level landed stamp.
pub fn train_leg_landed(meta: &Value, leg: &TrainLeg) -> bool {
    let mt = meta.get("merge_train").unwrap_or(&Value::Null);
    if let Some(state) = mt
        .get("legs")
        .and_then(|l| l.get(leg.number.to_string()))
        .and_then(|l| l.get("state"))
        .and_then(|v| v.as_str())
    {
        if state == "landed" {
            return true;
        }
    }
    mt.get("state").and_then(|v| v.as_str()) == Some("landed")
}

/// Executor-side leg-state read (the hub stamps both the per-leg entry and the
/// card-level state on merge — do.ts 7444-7445): the per-leg map wins, else
/// the card-level state. `Some("awaiting-ci")` = parked leg — the drain walk
/// and the settle-window rebase skip it.
pub fn train_leg_state<'a>(meta: &'a Value, leg: &TrainLeg) -> Option<&'a str> {
    let mt = meta.get("merge_train").unwrap_or(&Value::Null);
    if let Some(state) = mt
        .get("legs")
        .and_then(|l| l.get(leg.number.to_string()))
        .and_then(|l| l.get("state"))
        .and_then(|v| v.as_str())
    {
        return Some(state);
    }
    mt.get("state").and_then(|v| v.as_str())
}

// ---------- verdict coverage (core.ts 1234-1258, 1343) ----------

fn is_sha_like(s: &str) -> bool {
    (7..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// core.ts headCoveredBy (1247): straight stamp or a CONTIGUOUS carry chain,
/// prefix-compatible (9-hex stamp covers the 40-hex it prefixes). Fail-closed.
fn head_covered_by(stamped: &str, carry: Option<&Value>, target: &str) -> bool {
    if !is_sha_like(stamped) || !is_sha_like(target) {
        return false;
    }
    let mut cur = stamped.to_string();
    if target.starts_with(&cur) || cur.starts_with(target) {
        return true;
    }
    if let Some(Value::Array(records)) = carry {
        for c in records {
            let from = c.get("from_head").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            let to = c.get("to_head").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            if from != cur || !is_sha_like(&to) {
                return false;
            }
            cur = to;
        }
    }
    target.starts_with(&cur) || cur.starts_with(target)
}

/// core.ts verdictCoversHeadLeg (1343): the leg's own stamp + carry chain.
pub fn verdict_covers_head_leg(leg: Option<&TrainLeg>, head_sha: &str) -> bool {
    match leg {
        None => false,
        Some(l) => head_covered_by(
            &l.head_sha_at_acceptance.clone().unwrap_or_default().to_lowercase(),
            l.carry.as_ref(),
            &head_sha.to_lowercase(),
        ),
    }
}

/// core.ts carryChainTip (BR#4689 L1.4): the head the chain currently ends
/// at — the ONE point a new carry leg may extend. Walks stamp → … → tip
/// enforcing contiguity; a break anywhere (or a non-sha stamp) yields None —
/// a broken chain can never be covered by extension, only re-rendered.
pub fn carry_chain_tip(stamped: &str, carry: Option<&Value>) -> Option<String> {
    let s = stamped.trim().to_lowercase();
    if !is_sha_like(&s) {
        return None;
    }
    let mut cur = s;
    if let Some(Value::Array(records)) = carry {
        for c in records {
            let from = c.get("from_head").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            let to = c.get("to_head").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            if from != cur || !is_sha_like(&to) {
                return None;
            }
            cur = to;
        }
    }
    Some(cur)
}

/// The executor-proved mechanical head move (BR#4689 L1.4): the live head is
/// the stamped head REBASED — `git range-diff old...new` came back all-'='
/// pairs (same patch-ids, same order, no content delta). Executor-fed fact
/// like mergeable/commits: the gate reasons over it, it never self-certifies.
/// Field-for-field mirror of `MechanicalMove` in `@bridge/contracts`
/// (packages/contracts/src/mcp.ts) — the single TS source, consumed by core.ts
/// decideTrainGate; cross-language, one literal type cannot serve both, so
/// keep the three fields in lockstep by name (from_head/fromHead, to_head/
/// toHead, evidence).
#[derive(Clone, Debug, PartialEq)]
pub struct MechanicalMove {
    /// the chain tip the move extends (must equal carry_chain_tip of the leg)
    pub from_head: String,
    /// the live head the move lands on (must equal head_sha)
    pub to_head: String,
    /// the proof receipt — the range-diff summary riding the carry record
    pub evidence: String,
}

// ---------- fact-boundary normalizers (core.ts 1462-1476, BR#3714) ----------

/// gh's `mergeable` is the GraphQL enum STRING; the gate wants bool-or-null.
/// REST booleans pass through; anything else is None (wait this tick).
pub fn normalize_gh_mergeable(v: &Value) -> Option<bool> {
    match v {
        Value::Bool(b) => Some(*b),
        Value::String(s) => match s.as_str() {
            "MERGEABLE" => Some(true),
            "CONFLICTING" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// gh's `mergeStateStatus` is UPPERCASE; the gate compares lowercase.
pub fn normalize_gh_merge_state(v: &Value) -> Option<String> {
    v.as_str().map(|s| s.to_lowercase())
}

// ---------- the gate (core.ts MergeAction 896, decideMergeAction 907, decideTrainGate 1486) ----------

/// WHY a bounce happened (core.ts TrainBounceKind, BR#4066): the bounce brief
/// the hub renders — and the next owner it names — follows the kind. A brief
/// that renders every bounce as "conflicts with its base" lies on a coverage
/// bounce (no conflicts exist) and buries a gate defect.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BounceKind {
    /// head moved past the accepted verify verdict (authored push) — no
    /// conflicts exist; the verify pool re-verifies at the new head
    Coverage,
    /// trial-merge conflicts — the enumerated file list MUST ride the event
    Conflict,
    /// mechanical gate defect (mergeStateStatus / head checks / a stale
    /// mergeable read) — the defect text names the truth
    Gate,
}

impl BounceKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            BounceKind::Coverage => "coverage",
            BounceKind::Conflict => "conflict",
            BounceKind::Gate => "gate",
        }
    }
}

/// The executor's train_event bounce_kind (train.rs), refined from the gate's
/// classification by the trial-merge ground truth (BR#4066): a CONFLICT-class
/// bounce whose trial merge came back CLEAN was a stale GitHub mergeable read
/// (BR#3712 class) — it lands as a gate bounce naming the stale state, never
/// as a file-less conflict (the hub fail-louds on those). Coverage and gate
/// pass through untouched; neither runs a trial merge.
pub fn bounce_event_kind(gate: &BounceKind, trial_clean: bool, files_len: usize) -> &'static str {
    match gate {
        BounceKind::Coverage => "coverage",
        BounceKind::Gate => "gate",
        BounceKind::Conflict if !trial_clean && files_len > 0 => "conflict",
        BounceKind::Conflict => "gate",
    }
}

// ---------- BR#5190 root-fix fast lane: the main-breakage law's gate half ----------

/// The deploy-health gate check — matched as a lowercase substring against the
/// check NAME ("Deploy health (merge gate)" matches). A head red of this class
/// is exactly main's own deploy red: the circular class no machine leg can
/// pass — the one-click human merge ask is the fast lane (BR#5189 §5, SP #2617
/// precedent). MUST stay byte-identical to core.ts DEPLOY_HEALTH_PATTERN.
pub const DEPLOY_HEALTH_PATTERN: &str = "deploy health";

/// The destination-green gate check (BR#3008/BR#3009) — matched as a
/// lowercase substring against the check NAME ("main-green gate" matches).
/// A head red of this class judges MAIN's tip, not the PR's own code: when
/// main's tip now classifies fully green (the exact predicate the gate
/// runs, scripts/main-green-gate.sh), the conviction is stale by
/// construction and the self-heal re-runs it (BR#5883 — the 2026-11-03
/// episode: a gate red stamped 09:07:27Z against a transiently-unsettled
/// `Test` pinned the head car for hours; main settled green 20s later and
/// nothing re-opened the terminal verdict). MUST stay byte-identical to
/// core.ts MAIN_GREEN_GATE_PATTERN.
pub const MAIN_GREEN_GATE_PATTERN: &str = "main-green gate";

pub fn is_base_health_gate_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.contains(DEPLOY_HEALTH_PATTERN) || lower.contains(MAIN_GREEN_GATE_PATTERN)
}

/// The deterministic one-click human merge ask title for the circular
/// deploy-health class. BYTE-IDENTICAL to core.ts rootFixFastLaneTitle: the
/// executor files this ask and the hub re-classifies executor-fed reports, so
/// ask-dedupe keys on exact wording across hub + executor. ≤240 chars, ends
/// "?" per the ask contract.
pub fn root_fix_fast_lane_title(repo: &str, pr: impl std::fmt::Display) -> String {
    format!(
        "Root-fix fast lane (BR#5189): merge {repo} PR #{pr} now? Main is red on the exact red this PR cures — the train cannot merge it while the line it fixes is stopped; one click merges the cure?"
    )
}

/// The main-breakage qualification (BR#5189 §1): the card is THE root fix iff
/// it is tagged `root_blocker` (also root-blocker / root-fix / base-fix) +
/// `main-red` (also main_red / stop-the-line, BR#6390 — the BASE-FIX /
/// stop-the-line spellings the field stamps, BR#6378 class; also
/// deploy-red / deploy_red, BR#14075 — the documented main-red synonyms) AND
/// bound to a failing main-HEAD run (meta.root_fix repo+head_sha; fallback
/// sha sources main_tip / tip_sha / red_since; fallback repo sources
/// root_fix.repo / repo / pr.repo / prs[0].repo / merge_train.repo /
/// root_blocker_for_lane "<repo>@<base>"). BR#6390: a field-minted BASE-FIX
/// card can carry NO root-side tag at all — the marker then lives in meta
/// (`root_blocker_for_lane` "<repo>@<base>" or a `root_blocker` id string,
/// the BR#6378 exemplar) — so a meta marker qualifies as the root-side half.
/// Meta markers never qualify ALONE: the binding (a named failing run) is
/// still required — an ambient "main is red" tag without a named run would
/// pin the whole queue to a stale episode. MUST stay behaviour-identical to
/// the TS mirror (core.ts isRootFixCard, tag match case-insensitive).
pub fn is_root_fix_card(card: &Value) -> bool {
    let tags: Vec<String> = card
        .get("tags")
        .and_then(|t| t.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_lowercase())).collect())
        .unwrap_or_default();
    let meta_ref = card.get("meta").filter(|m| m.is_object());
    // BR#6390: a field-minted BASE-FIX card can carry NO root-side tag at
    // all — the marker then lives in meta (`root_blocker_for_lane`
    // "<repo>@<base>" or a `root_blocker` id string, the BR#6378 exemplar)
    // — so a meta marker qualifies as the root-side half. Meta markers never
    // qualify ALONE: the binding (a named failing run) is still required.
    let has_root = tags.iter().any(|t| t == "root_blocker" || t == "root-blocker" || t == "root-fix" || t == "base-fix")
        || meta_ref
            .and_then(|m| m.get("root_blocker_for_lane"))
            .and_then(|v| v.as_str())
            .map(|s| s.contains('@'))
            .unwrap_or(false)
        || meta_ref.and_then(|m| m.get("root_blocker")).and_then(|v| v.as_str()).is_some();
    let has_main_red = tags.iter().any(|t| t == "main-red" || t == "main_red" || t == "stop-the-line" || t == "deploy-red" || t == "deploy_red");
    if !has_root || !has_main_red {
        return false;
    }
    let meta = match meta_ref {
        Some(m) => m,
        None => return false,
    };
    if let Some(b) = meta.get("root_fix").filter(|b| b.is_object()) {
        let repo = b.get("repo").and_then(|v| v.as_str()).unwrap_or("");
        let sha = b.get("head_sha").and_then(|v| v.as_str()).unwrap_or("");
        if !repo.is_empty() && !sha.is_empty() {
            return true;
        }
    }
    let fallback_sha = meta
        .get("main_tip")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        // BR#6390: agent-filed BASE-FIX cards carry tip_sha (the failing main
        // tip) — same meaning as main_tip. MUST mirror core.ts mainRedBinding.
        .or_else(|| meta.get("tip_sha").and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
        .or_else(|| meta.get("red_since").and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
        .unwrap_or("");
    let fallback_repo = meta
        .pointer("/root_fix/repo")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .or_else(|| meta.get("repo").and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
        .or_else(|| meta.pointer("/pr/repo").and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
        .or_else(|| meta.pointer("/prs/0/repo").and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
        .or_else(|| meta.pointer("/merge_train/repo").and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
        // BR#6390: the field-minted BASE-FIX shape names the lane, not a PR
        // ("repo@base") — split the repo half out as the binding's repo.
        .or_else(|| {
            meta.get("root_blocker_for_lane")
                .and_then(|v| v.as_str())
                .and_then(|s| s.split_once('@'))
                .map(|(repo, _)| repo)
                .filter(|s| !s.is_empty())
        })
        .unwrap_or("");
    !fallback_repo.is_empty() && !fallback_sha.is_empty()
}

#[derive(Clone, Debug, PartialEq)]
pub enum MergeAction {
    Merge { receipt: String },
    CloseSuperseded { reason: String },
    Bounce { defect: String, bounce_kind: BounceKind },
    Note { reason: String },
    Skip { reason: String },
    HumanLeg { reason: String },
    RootFixBypass { reason: String },
    /// BR#4689 L1.4: the head moved MECHANICALLY (same patch-ids) — stamp
    /// the carry leg (hub event `carried`) and let the next tick merge the
    /// covered head. Never a bounce, never a re-verify duty, never a
    /// review re-ask.
    Carry { from_head: String, to_head: String, evidence: String, receipt: String },
    /// STALE DEPLOY-HEALTH SELF-HEAL: the head red is ENTIRELY the
    /// deploy-health class while the base is GREEN — a verdict stamped
    /// against a deploy that has since settled. The executor re-runs the
    /// failed gate jobs (check-runs rerequest) and treats the entry as a
    /// clock (waiting), never a bounce, never a human leg.
    RerunGate { reason: String },
}

#[derive(Clone)]
pub struct TrainGateInput<'a> {
    pub pr_number: i64,
    pub head_sha: &'a str,
    pub card_meta: &'a Value,
    pub card_status: Option<&'a str>,
    pub base_verdict: MainVerdict,
    pub mergeable: Option<bool>,
    pub merge_state_status: Option<String>,
    pub commits: &'a [(String, bool)],
    pub head_checks: &'a [MainCheckRun],
    pub leg_number: Option<usize>,
    /// BR#4689 L1.4: the executor's mechanical head-move proof (git
    /// range-diff all-'='), present only when the live head is an uncovered
    /// move AND the executor could prove the move content-preserving.
    /// Absent → the coverage bounce stands (fail-closed unchanged).
    pub mechanical_move: Option<MechanicalMove>,
    /// The candidate is the bound main-breakage cure (BR#5190).
    pub root_fix: bool,
    /// Names of the base failures, used by the circular-gate fast lane.
    pub base_red_names: &'a [String],
    /// BR#5883: the tip's whole-tip gate predicate is GREEN — main's tip
    /// classifies fully green under `classify_main_check_runs` (the exact
    /// predicate `main-green gate` runs), i.e. the walk-start scoped verdict
    /// is Green with no gate qualifier attached. Gates the stale
    /// main-green-gate self-heal: a gate conviction against a since-settled
    /// tip re-runs; a conviction against a still-red tip is honest and
    /// stands (the base alarm / P1 escalation owns it).
    pub base_gate_green: bool,
    /// BR#4687 (L1.2): every commit's GitHub author login is on the worker
    /// allowlist — the branch belongs to the train's own fleet. Provenance
    /// gate for the behind pre-clear below: the train machine-updates its
    /// OWN branches; a protected human branch still bounces to its owner.
    /// Fail-closed: absent/false is human-treated.
    pub train_owned_branch: bool,
}

/// core.ts decideMergeAction (907): the 5c gate + verify lineage as one
/// decision table; order is the law's.
pub fn decide_merge_action(
    pr_number: i64,
    head_sha: &str,
    card_status: Option<&str>,
    base_verdict: &MainVerdict,
    mergeable: Option<bool>,
    merge_state_status: Option<&str>,
    commits: &[(String, bool)],
    head_checks: &[MainCheckRun],
    verify_accepted_on_head: bool,
    verify_accepted_any: bool,
) -> MergeAction {
    if card_status == Some("superseded") {
        return MergeAction::CloseSuperseded { reason: "linked card is superseded — closing PR without review".into() };
    }
    if card_status == Some("done") {
        return MergeAction::Skip { reason: "linked card already done — nothing to merge under it".into() };
    }
    let short = &head_sha[..head_sha.len().min(9)];
    // (1) mergeability is a precondition, NOT a finding (5c, 2026-10-23).
    //     BR#4685: GitHub computes mergeability ASYNC — right after a base
    //     merge the state reads null/UNKNOWN and `mergeable` rides the same
    //     recomputation, so an answer is definitive only when the state
    //     names itself. An unanswered state is a clock, never a defect: the
    //     executor backoff-polls before this gate, and here it waits this
    //     tick — never a bounce, and never a merge on an unconfirmed state
    //     (the old null-state fall-through). The 2026-10-28 ledger is the
    //     receipt: PRs #279/#281 bounced 28× with merge_state_status:null.
    let state = merge_state_status.map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty());
    if state.as_deref().map_or(true, |s| s == "unknown") {
        return MergeAction::Skip {
            reason: format!("PR #{pr_number} mergeStateStatus not yet computed (null/UNKNOWN) — GitHub is computing mergeability; poll, never a defect (BR#4685)"),
        };
    }
    let state = state.unwrap_or_default();
    if mergeable != Some(true) {
        if mergeable.is_none() {
            return MergeAction::Skip { reason: "GitHub still computing mergeability — not yet, skip this tick".into() };
        }
        return MergeAction::Bounce {
            defect: format!("PR #{pr_number} unmergeable — CONFLICTING against base. Rebase, resolve, re-push, re-enter the queue"),
            bounce_kind: BounceKind::Conflict,
        };
    }
    if state != "clean" && state != "unstable" {
        return MergeAction::Bounce {
            defect: format!("PR #{pr_number} mergeStateStatus={state} — not clean. Fix the named state (rebase/re-sign) and re-enter — the accepted BR verify verdict is the approval of record (BR#4633 L4.2); there is no GitHub re-approve leg"),
            bounce_kind: BounceKind::Gate,
        };
    }
    // (2) every commit GitHub-verified (signed+valid; NO_USER/UNKNOWN are the human leg)
    let unverified = commits.iter().filter(|(_, v)| !v).count();
    if unverified > 0 {
        return MergeAction::HumanLeg {
            reason: format!("PR #{pr_number} has {unverified} commit(s) not GitHub-verified — signing-environment class, never per-PR"),
        };
    }
    // (3) base green (BR#3009 destination-green)
    if *base_verdict != MainVerdict::Green {
        let w = if *base_verdict == MainVerdict::Red { "RED" } else { "not green" };
        return MergeAction::Skip {
            reason: format!("base main {w} — the standing order never merges onto a non-green destination; the stop-the-line sweep owns the alert"),
        };
    }
    // (4) head checks green (BR#2267 externals exempt)
    let head = classify_head_checks(head_checks);
    if head.verdict == MainVerdict::Red {
        let names = head.red.iter().map(|r| r.name.as_str()).collect::<Vec<_>>().join(", ");
        return if card_status == Some("in_review") {
            MergeAction::Bounce { defect: format!("PR #{pr_number} head check RED: {names}. Fix or bounce to impl"), bounce_kind: BounceKind::Gate }
        } else {
            MergeAction::Note {
                reason: format!("PR #{pr_number} head check RED: {names} — card not in_review, no bounce; the linked session owns it"),
            }
        };
    }
    if head.verdict == MainVerdict::Unsettled {
        return MergeAction::Skip {
            reason: format!("head checks unsettled ({}) — not yet, skip this tick", head.unsettled.join(", ")),
        };
    }
    // (5) verify lineage
    // BR#5114 round 2 (Ray ruling 2026-10-30: "if it can't merge, bounce it
    // and move onto the next one — the train goes regardless"): an ACCEPTED
    // verdict that no longer covers the live head is a coverage BOUNCE for
    // ANY card status. The old in_review-only condition made a QUEUED card
    // with a stale stamp Skip silently every tick — no ledger event, no
    // bounce, the lane frozen behind an invisible head (observed:
    // superpositional@main — 64 minutes of ledger silence, 12-deep queue).
    if verify_accepted_any && !verify_accepted_on_head {
        return MergeAction::Bounce {
            defect: format!("PR #{pr_number} head {short} moved past the accepted verify verdict — re-verify the new head (a mechanical rebase is content-preserving; fresh 5c only)"),
            bounce_kind: BounceKind::Coverage,
        };
    }
    if !verify_accepted_on_head {
        return MergeAction::Skip {
            reason: format!("no accepted verify verdict covering head {short} — the verify pool owns the verdict; the sweep merges only verified PRs"),
        };
    }
    MergeAction::Merge {
        receipt: format!(
            "PR #{pr_number} merged by the standing merge sweep (BR#3033): head {short} — 5c gate pass (mergeable, clean, {commits_len} verified commits), base green, head checks green, verify accepted on head",
            commits_len = commits.len()
        ),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum CandidateHeadCheckState {
    Green,
    Pending { unsettled: Vec<String> },
    RedCircularDeployGate { names: Vec<String> },
    RedCircularMainGreenGate { names: Vec<String> },
    RedCircularMixedGates { names: Vec<String> },
    RedSubstantive { names: Vec<String> },
}

#[derive(Clone, Debug, PartialEq)]
pub enum CandidateMergeState {
    Clean,
    Unstable,
    Behind,
    Blocked,
}

#[derive(Clone, Debug, PartialEq)]
pub enum CandidateGatePhase {
    CardSuperseded,
    CardDone,
    HeadUncovered { leg_number: usize, stamped: String },
    MergeabilityComputing { reason: String },
    Conflicting,
    CommitEvidenceMissing,
    UnverifiedCommits { count: usize },
    UnhandledMergeState { state: String },
    MechanicallySound {
        leg_number: usize,
        legs_total: usize,
        merge_state: CandidateMergeState,
        head_state: CandidateHeadCheckState,
    },
}

/// BR#6012 defense-in-depth state machine (mirror of core.ts
/// classifyCandidateGatePhase): classifies a train candidate into an exhaustive,
/// mutually-exclusive phase BEFORE any transition rule runs, so impossible
/// states (a conflicting PR reaching RerunGate/Note/Merge/HumanLeg, or a
/// circular root-fix PR on a red base being swallowed by `blocked -> Note`)
/// are unrepresentable by construction. BR#4689 L1.4: an uncovered head is
/// HEAD-UNCOVERED, never decided here — the gate's arm offers the
/// mechanical-carry row (the executor's range-diff proof of a
/// content-preserving rebase extends the chain); only substantive content,
/// an unprovable move, or a broken chain bounces.
pub fn classify_candidate_gate_phase(i: &TrainGateInput) -> CandidateGatePhase {
    if i.card_status == Some("superseded") {
        return CandidateGatePhase::CardSuperseded;
    }
    if i.card_status == Some("done") {
        return CandidateGatePhase::CardDone;
    }
    let legs = train_legs(i.card_meta);
    let leg_number = i.leg_number.unwrap_or(1).max(1);
    let leg = if !legs.is_empty() { legs.get(leg_number - 1) } else { None };
    if !verdict_covers_head_leg(leg, i.head_sha) {
        let stamped = leg
            .and_then(|l| l.head_sha_at_acceptance.clone())
            .map(|s| s[..s.len().min(9)].to_string())
            .unwrap_or_else(|| "(no stamp)".into());
        return CandidateGatePhase::HeadUncovered { leg_number, stamped };
    }
    let state = i
        .merge_state_status
        .as_deref()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    if state.as_deref().map_or(true, |s| s == "unknown") {
        return CandidateGatePhase::MergeabilityComputing {
            reason: format!(
                "PR #{n} mergeStateStatus not yet computed (null/UNKNOWN) — GitHub is computing mergeability; poll, never a defect (BR#4685)",
                n = i.pr_number
            ),
        };
    }
    let state = state.unwrap_or_default();
    if i.mergeable != Some(true) {
        if i.mergeable.is_none() {
            return CandidateGatePhase::MergeabilityComputing {
                reason: "GitHub still computing mergeability — not yet, skip this tick".into(),
            };
        }
        return CandidateGatePhase::Conflicting;
    }
    let merge_state = match state.as_str() {
        "clean" => CandidateMergeState::Clean,
        "unstable" => CandidateMergeState::Unstable,
        "behind" => CandidateMergeState::Behind,
        "blocked" => CandidateMergeState::Blocked,
        _ => return CandidateGatePhase::UnhandledMergeState { state },
    };
    if !i.commits.iter().any(|(sha, _)| sha == i.head_sha) { return CandidateGatePhase::CommitEvidenceMissing; }
    let unverified = i.commits.iter().filter(|(_, v)| !v).count();
    if unverified > 0 {
        return CandidateGatePhase::UnverifiedCommits { count: unverified };
    }
    let head = classify_head_checks(i.head_checks);
    let head_state = match head.verdict {
        MainVerdict::Green | MainVerdict::Empty => CandidateHeadCheckState::Green,
        // BR#14088: a settling head (queued/in_progress checks) is pending —
        // never admission, same wait class as an unsettled read.
        MainVerdict::Settling | MainVerdict::Unsettled => CandidateHeadCheckState::Pending { unsettled: head.unsettled },
        MainVerdict::Red => {
            let names: Vec<String> = head.red.iter().map(|r| r.name.clone()).collect();
            let all_base_health = !names.is_empty() && names.iter().all(|n| is_base_health_gate_name(n));
            let all_main_green = !names.is_empty() && names.iter().all(|n| n.to_lowercase().contains(MAIN_GREEN_GATE_PATTERN));
            let none_main_green = names.iter().all(|n| !n.to_lowercase().contains(MAIN_GREEN_GATE_PATTERN));
            if all_base_health && !head.unsettled.is_empty() {
                CandidateHeadCheckState::Pending { unsettled: head.unsettled }
            } else if all_base_health && none_main_green {
                CandidateHeadCheckState::RedCircularDeployGate { names }
            } else if all_main_green {
                CandidateHeadCheckState::RedCircularMainGreenGate { names }
            } else if all_base_health {
                CandidateHeadCheckState::RedCircularMixedGates { names }
            } else {
                CandidateHeadCheckState::RedSubstantive { names }
            }
        }
    };
    CandidateGatePhase::MechanicallySound {
        leg_number,
        legs_total: legs.len().max(1),
        merge_state,
        head_state,
    }
}

/// core.ts decideTrainGate (1486): the executor's per-candidate gate, driven by
/// the exhaustive `CandidateGatePhase` state machine (BR#6012).
pub fn decide_train_gate(i: TrainGateInput) -> MergeAction {
    match classify_candidate_gate_phase(&i) {
        CandidateGatePhase::CardSuperseded => MergeAction::CloseSuperseded {
            reason: "linked card is superseded — closing PR without review".into(),
        },
        CandidateGatePhase::CardDone => MergeAction::Skip {
            reason: "linked card already done — nothing to merge under it".into(),
        },
        CandidateGatePhase::HeadUncovered { leg_number, stamped } => {
            // BR#4689 L1.4: carry is the DEFAULT path for a mechanical head
            // move. The executor proved the live head is the stamped head
            // rebased — same patch-ids, no content delta (git range-diff
            // all-'=' pairs). The carry must extend the leg's chain tip
            // exactly (contiguity re-checked here; the hub re-checks it
            // again server-side when stamping `carried`). A substantive
            // change (different patch-ids), an unprovable move, or a broken
            // chain still bounces — fail-closed, unchanged.
            let legs = train_legs(i.card_meta);
            let leg = if !legs.is_empty() { legs.get(leg_number - 1) } else { None };
            let tip = carry_chain_tip(
                leg.and_then(|l| l.head_sha_at_acceptance.as_deref()).unwrap_or(""),
                leg.and_then(|l| l.carry.as_ref()),
            );
            if let Some(mv) = &i.mechanical_move {
                let to_norm = mv.to_head.trim().to_lowercase();
                let contiguous = tip
                    .as_deref()
                    .map(|t| t == mv.from_head.trim().to_lowercase())
                    .unwrap_or(false)
                    && is_sha_like(&to_norm)
                    && to_norm == i.head_sha.trim().to_lowercase();
                if contiguous {
                    let tip = tip.unwrap();
                    let short_tip = tip[..tip.len().min(9)].to_string();
                    let short_to = i.head_sha[..i.head_sha.len().min(9)].to_string();
                    let evidence = mv.evidence.trim();
                    let evidence = if evidence.len() > 300 { &evidence[..300] } else { evidence };
                    return MergeAction::Carry {
                        from_head: tip,
                        to_head: i.head_sha.to_string(),
                        evidence: evidence.to_string(),
                        receipt: format!(
                            "PR #{n} head moved mechanically {f}→{t} (same patch-ids, no content delta) — verdict carries as a new chain leg (BR#4689 L1.4); no bounce, no re-verify duty; merge re-gated next tick",
                            n = i.pr_number,
                            f = short_tip,
                            t = short_to,
                        ),
                    };
                }
            }
            MergeAction::Bounce {
                defect: format!(
                    "PR #{n} live head {h} is not covered by the accepted verdict (leg {L} stamped {s}, no contiguous carry chain) — head moved past the verdict without a machine-clean update; re-verify at the new head",
                    n = i.pr_number,
                    h = &i.head_sha[..i.head_sha.len().min(9)],
                    L = leg_number,
                    s = stamped
                ),
                bounce_kind: BounceKind::Coverage,
            }
        }
        CandidateGatePhase::MergeabilityComputing { reason } => MergeAction::Skip { reason },
        CandidateGatePhase::Conflicting => MergeAction::Bounce {
            defect: format!(
                "PR #{n} unmergeable — CONFLICTING against base. Rebase, resolve, re-push, re-enter the queue",
                n = i.pr_number
            ),
            bounce_kind: BounceKind::Conflict,
        },
        CandidateGatePhase::UnhandledMergeState { state } => MergeAction::Bounce {
            defect: format!(
                "PR #{n} mergeStateStatus={state} — not clean. Fix the named state (rebase/re-sign) and re-enter — the accepted BR verify verdict is the approval of record (BR#4633 L4.2); there is no GitHub re-approve leg",
                n = i.pr_number
            ),
            bounce_kind: BounceKind::Gate,
        },
        CandidateGatePhase::CommitEvidenceMissing => MergeAction::Skip {
            reason: "Commit signature evidence does not cover the live head; wait for a complete GitHub read".into(),
        },
        CandidateGatePhase::UnverifiedCommits { count } => MergeAction::HumanLeg {
            reason: format!(
                "PR #{n} has {count} commit(s) not GitHub-verified — signing-environment class, never per-PR",
                n = i.pr_number
            ),
        },
        CandidateGatePhase::MechanicallySound {
            leg_number,
            legs_total,
            merge_state,
            head_state,
        } => {
            let behind = merge_state == CandidateMergeState::Behind;
            let blocked = merge_state == CandidateMergeState::Blocked;
            // (1) Stale base-health gate self-heal on a GREEN base
            if i.base_verdict == MainVerdict::Green {
                if let CandidateHeadCheckState::RedCircularDeployGate { names } = &head_state {
                    return MergeAction::RerunGate {
                        reason: format!(
                            "PR #{n} head red is entirely the deploy-health class ({names}) while the base is GREEN — a stale verdict stamped against a superseded main deploy; re-running the failed gate jobs, the red clears or re-convicts on the fresh run",
                            n = i.pr_number,
                            names = names.join(", ")
                        ),
                    };
                }
                if i.base_gate_green {
                    if let CandidateHeadCheckState::RedCircularMainGreenGate { names } = &head_state {
                        return MergeAction::RerunGate {
                            reason: format!(
                                "PR #{n} head red is entirely the main-green gate class ({names}) while main's tip now judges fully green under the gate's own predicate — a stale conviction stamped against a transiently-unsettled or since-settled tip (BR#5883); re-running the gate job, the red clears or re-convicts on the fresh run",
                                n = i.pr_number,
                                names = names.join(", ")
                            ),
                        };
                    }
                }
            }
            // (2) Root-fix fast lane on a RED base (above `blocked` so a BLOCKED
            //     circular gate check on the cure PR is never swallowed as Note)
            if i.root_fix && i.base_verdict == MainVerdict::Red {
                if head_state == CandidateHeadCheckState::Green {
                    return MergeAction::Merge {
                        receipt: format!(
                            "ROOT-FIX FAST-TRACK (BR#5189): PR #{n} is the bound main-breakage fix and its head is GREEN — merging onto the red base to turn the line green (root_fix_fast_tracked); base red: {reds}",
                            n = i.pr_number,
                            reds = if i.base_red_names.is_empty() {
                                "required checks".to_string()
                            } else {
                                i.base_red_names.join(", ")
                            }
                        ),
                    };
                }
                let head_circular = matches!(
                    &head_state,
                    CandidateHeadCheckState::RedCircularDeployGate { .. }
                        | CandidateHeadCheckState::RedCircularMainGreenGate { .. }
                        | CandidateHeadCheckState::RedCircularMixedGates { .. }
                );
                if head_circular {
                    return MergeAction::RootFixBypass {
                        reason: format!(
                            "PR #{n} is the bound main-breakage fix but the circular deploy-health class stands (BR#5189, SP #2617 precedent): the gate is red because MAIN is red — the head cannot go green while the line it fixes is stopped; the one-click human merge ask is the fast lane",
                            n = i.pr_number
                        ),
                    };
                }
            }
            // (3) Blocked with pending or red head checks
            if blocked {
                if let CandidateHeadCheckState::Pending { unsettled } = &head_state {
                    return MergeAction::Skip {
                        reason: format!(
                            "PR #{n} mergeStateStatus=blocked — required checks re-running on head {h} ({u}) — pending, not a defect; next tick",
                            n = i.pr_number,
                            h = &i.head_sha[..i.head_sha.len().min(9)],
                            u = unsettled.join(", ")
                        ),
                    };
                }
                let only_circular_base_gate = i.base_verdict != MainVerdict::Green
                    && matches!(
                        &head_state,
                        CandidateHeadCheckState::RedCircularDeployGate { .. }
                            | CandidateHeadCheckState::RedCircularMainGreenGate { .. }
                            | CandidateHeadCheckState::RedCircularMixedGates { .. }
                    );
                if !only_circular_base_gate {
                    match &head_state {
                        CandidateHeadCheckState::RedCircularDeployGate { names }
                        | CandidateHeadCheckState::RedCircularMainGreenGate { names }
                        | CandidateHeadCheckState::RedCircularMixedGates { names }
                        | CandidateHeadCheckState::RedSubstantive { names } => {
                            return MergeAction::Note {
                                reason: format!(
                                    "PR #{n} head check RED: {names} — card queued (not in_review), no bounce; the linked session owns it",
                                    n = i.pr_number,
                                    names = names.join(", ")
                                ),
                            };
                        }
                        CandidateHeadCheckState::Green | CandidateHeadCheckState::Pending { .. } => {}
                    }
                }
            }
            // (4) Non-green base
            if i.base_verdict != MainVerdict::Green {
                let w = if i.base_verdict == MainVerdict::Red { "RED" } else { "not green" };
                return MergeAction::Skip {
                    reason: format!(
                        "base main {w} — the standing order never merges onto a non-green destination; the stop-the-line sweep owns the alert"
                    ),
                };
            }
            // (5) Green base, non-blocked head check states
            match &head_state {
                CandidateHeadCheckState::Pending { unsettled } => MergeAction::Skip {
                    reason: format!("head checks unsettled ({}) — not yet, skip this tick", unsettled.join(", ")),
                },
                CandidateHeadCheckState::RedCircularDeployGate { names }
                | CandidateHeadCheckState::RedCircularMainGreenGate { names }
                | CandidateHeadCheckState::RedCircularMixedGates { names }
                | CandidateHeadCheckState::RedSubstantive { names } => {
                    let joined = names.join(", ");
                    if i.card_status == Some("in_review") {
                        MergeAction::Bounce {
                            defect: format!("PR #{n} head check RED: {joined}. Fix or bounce to impl", n = i.pr_number),
                            bounce_kind: BounceKind::Gate,
                        }
                    } else {
                        MergeAction::Note {
                            reason: format!(
                                "PR #{n} head check RED: {joined} — card not in_review, no bounce; the linked session owns it",
                                n = i.pr_number
                            ),
                        }
                    }
                }
                CandidateHeadCheckState::Green => {
                    if blocked {
                        return MergeAction::Note { reason: format!("PR #{} GitHub branch policy remains BLOCKED despite observed green head checks — reconcile required checks and policy; no merge attempted", i.pr_number) };
                    }
                    if behind && !i.train_owned_branch {
                        return MergeAction::Bounce {
                            defect: format!("PR #{} mergeStateStatus=behind against base on a protected (non-worker-authored) branch — the train does not move human branches. Rebase, re-sign, re-push and re-enter the queue", i.pr_number),
                            bounce_kind: BounceKind::Gate,
                        };
                    }
                    let state_clause = if behind {
                        "behind pre-cleared — worker-authored branch, the merge leg's machine-clean update-branch carries the verdict (BR#3516 §5, BR#4687)"
                    } else if blocked {
                        "blocked pre-cleared — the BR verify verdict is the approval of record (BR#4633 L4.2)"
                    } else {
                        "clean"
                    };
                    MergeAction::Merge {
                        receipt: format!(
                            "PR #{n} merged by the serialized merge train (BR#3516) leg {L}/{T}: head {h} — verdict covers head (stamp/carry), 5c gate pass (mergeable, {state_clause}, {c} verified commits), base green, head checks green",
                            n = i.pr_number,
                            L = leg_number,
                            T = legs_total,
                            h = &i.head_sha[..i.head_sha.len().min(9)],
                            c = i.commits.len()
                        ),
                    }
                }
            }
        }
    }
}

// ---------- burst-drain settle (BR#4934, decision BR#4932 amends BR#4804) ----------

/// lane.burst_max default (BR#4934): back-to-back merges per settle pass.
pub const DEFAULT_BURST_MAX: u32 = 10;

/// Parse lane.burst_max (BR#4934): 0 = unlimited; absent or junk → default.
pub fn parse_burst_max(v: &Value) -> u32 {
    match v.as_u64() {
        Some(n) if n <= u32::MAX as u64 => n as u32,
        _ => DEFAULT_BURST_MAX,
    }
}

/// WHY this tick's drain pass ended (the executor acts per arm):
/// more gate-clean heads to merge back-to-back, the pass's ONE settle wait,
/// or the line stopped on a red pass sha.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrainDecision {
    /// another gate-clean head exists and the cap isn't reached — merge it
    /// this tick, no settle between merges
    Drain,
    /// queue empty of clean heads (or cap reached) — enter the ONE settle
    /// wait on the FINAL merge commit of the pass
    Settle,
    /// a pass sha's fed checks went RED mid-drain — stop the line
    /// immediately (GH#2261 law); the settle's bisect owns earlier reds
    Stop,
}

/// The burst-drain law (BR#4934): after a merge, keep draining gate-clean
/// heads back-to-back — ONE settle per drain pass, on the final merge
/// commit; rebase work rides the settle wait. Red at any point stops the
/// line immediately (GH#2261); it never waits for the settle.
pub fn drain_burst_decision(merged: u32, cap: u32, has_next: bool, red_seen: bool) -> DrainDecision {
    if red_seen {
        return DrainDecision::Stop;
    }
    if has_next && (cap == 0 || merged < cap) {
        return DrainDecision::Drain;
    }
    DrainDecision::Settle
}

/// The red-settle bisect walk order (BR#4934): the pass's stamped merge
/// shas, oldest first — the first RED one names the ONE culprit merge.
pub fn first_red_index(reds: &[bool]) -> Option<usize> {
    reds.iter().position(|r| *r)
}

/// BR#4996 batch inputs: one candidate head's changed-file set (`git diff
/// --name-only merge-base(origin/base, head)..head`), keyed by file path.
pub type FileSet = std::collections::BTreeSet<String>;

/// BR#4996: conflict pairs among batch candidates, from their changed-file
/// sets — two heads are pair-candidates when their sets INTERSECT. A pure
/// set law, testable without git; the executor's plumbing that PRODUCES the
/// sets fails closed per BR#3935 (an unreadable head never yields a silent
/// empty set), and each intersecting pair is merge-tree-confirmed before it
/// gates a landing (train.rs).
pub fn conflicts_from_file_sets(file_sets: &[FileSet]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    for i in 0..file_sets.len() {
        for j in (i + 1)..file_sets.len() {
            if file_sets[i].iter().any(|f| file_sets[j].contains(f)) {
                out.push((i, j));
            }
        }
    }
    out
}

/// The batch-merge law (BR#4996, Ray ruling 2026-10-29, amending the
/// BR#4934 burst-drain): select the maximal set of MUTUALLY non-conflicting
/// heads from the gate-clean queue, in queue order — which is landing order
/// (oldest-first). Greedy: a head joins the batch unless it conflicts
/// (either pair orientation) with an already-selected head; `clean[i] ==
/// false` excludes just that member (fail-closed: only KNOWN-clean heads
/// are eligible — an exclusion never poisons its neighbours, so a chain
/// A↔B↔C lands [A, C] and skips only B); `cap > 0` binds when the batch
/// reaches it, `cap == 0` is unlimited.
pub fn select_batch(clean: &[bool], conflict_pairs: &[(usize, usize)], cap: usize) -> Vec<usize> {
    let mut selected: Vec<usize> = Vec::new();
    for (i, ok) in clean.iter().enumerate() {
        if !ok {
            continue;
        }
        if cap > 0 && selected.len() >= cap {
            break;
        }
        let clashing = selected.iter().any(|&s| {
            conflict_pairs.iter().any(|&(a, b)| (a == i && b == s) || (a == s && b == i))
        });
        if !clashing {
            selected.push(i);
        }
    }
    selected
}

/// core.ts mergeSweepHumanLegTitle (953): deterministic class-ask title,
/// ≤240 chars, ends "?" (the ask contract).
pub fn merge_sweep_human_leg_title(repo: &str, reasons: &[String]) -> String {
    let prefix = format!("Merge sweep human legs on {repo}: ");
    let suffix = " — fix the class?";
    let budget = 240usize.saturating_sub(prefix.len() + suffix.len());
    let mut text = reasons.join("; ");
    if text.len() > budget {
        let cut = text.char_indices().nth(budget.saturating_sub(1)).map(|(i, _)| i).unwrap_or(0);
        text.truncate(cut);
        text = format!("{}…", text.trim_end());
    }
    format!("{prefix}{text}{suffix}")
}

// ---------- BR#6179 level-based deploy reconciliation (dark-tip self-heal) ----------

/// Default grace window (5 minutes) before an uncovered tip triggers automatic
/// `workflow_dispatch` and fast-page escalation (BR#6179). Mirrored in `core.ts`.
pub const DEPLOY_RECONCILE_GRACE_SECS: u64 = 300;

/// Wire mirror of @bridge/contracts RecoveryCauseSchema. Only an unknown
/// check failure is eligible for a generic retry; identified test/capability
/// defects belong to their repair executors.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RecoveryCause {
    TestFailure { check: String, suite: String, test: String },
    CapabilityUnavailable { check: String, scenario: String, capability: String, scope: String },
    CheckFailure { check: String },
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DeployWorkflowRun {
    pub id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_attempt: Option<i64>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub head_sha: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Serialized ALWAYS — explicit `null` while a run is queued/in_progress.
    /// The hub schema rejects a MISSING conclusion key (nullable ≠ optional),
    /// so `skip_serializing_if` here made every observation containing an
    /// in-flight deploy run fail validation (2026-11-05 incident, 123 rejects).
    #[serde(default)]
    pub conclusion: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html_url: Option<String>,
}

/// Closed 6-state discriminated union on `phase` representing whether the base
/// tip commit (`tip_sha`) is covered by a decisive deploy workflow run,
/// settling in flight, inside the initial push-trigger grace window,
/// auto-dispatched by the executor, stranded dark past grace, or failed.
/// Mirrored in `@bridge/contracts` `DeployCoverageStateSchema` and `core.ts`.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum DeployCoverageState {
    Covered {
        tip_sha: String,
        tip_age_secs: u64,
        covered_by_sha: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        covered_by_run_id: Option<i64>,
        /// BR#8824: canonical same-run rerun identity — a new attempt of the
        /// same run id on the same tip is a CHANGED coverage receipt (it can
        /// recover the gate), so the executor stamps the attempt alongside the
        /// run id. Mirrored in `DeployCoverageStateSchema` + `deployCoverageReceipt`.
        #[serde(skip_serializing_if = "Option::is_none")]
        covered_by_run_attempt: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        covered_by_url: Option<String>,
    },
    Settling {
        tip_sha: String,
        tip_age_secs: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        active_run_id: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        active_run_url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        last_green_sha: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        last_green_run_id: Option<i64>,
    },
    UncoveredGrace {
        tip_sha: String,
        tip_age_secs: u64,
        grace_secs: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        workflow: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        last_green_sha: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        last_green_run_id: Option<i64>,
    },
    UncoveredDispatched {
        tip_sha: String,
        tip_age_secs: u64,
        workflow: String,
        dispatched_at: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        last_green_sha: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        last_green_run_id: Option<i64>,
    },
    UncoveredDark {
        tip_sha: String,
        tip_age_secs: u64,
        grace_secs: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        workflow: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        last_green_sha: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        last_green_run_id: Option<i64>,
        reason: String,
    },
    Failed {
        tip_sha: String,
        tip_age_secs: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        failing_run_id: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        failing_run_url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        last_green_sha: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        last_green_run_id: Option<i64>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct DeployReconcilePlan {
    pub coverage: DeployCoverageState,
    pub dispatch_workflow: Option<String>,
    pub cancel_run_ids: Vec<i64>,
    pub covered_by_sha: Option<String>,
    pub coverage_age_secs: u64,
}

/// Pure ISO-8601 timestamp parser (e.g. `"2026-11-04T08:01:57Z"` or
/// `"2026-11-04T08:01:57+00:00"`) → epoch milliseconds, using Howard Hinnant's
/// civil-from-days algorithm. Zero external dependencies.
pub fn parse_iso8601_epoch_ms(s: &str) -> Option<u64> {
    let t = s.trim();
    if t.len() < 19 {
        return None;
    }
    let b = t.as_bytes();
    if b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b't' && b[10] != b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let year: i64 = t.get(0..4)?.parse().ok()?;
    let month: i64 = t.get(5..7)?.parse().ok()?;
    let day: i64 = t.get(8..10)?.parse().ok()?;
    let hour: i64 = t.get(11..13)?.parse().ok()?;
    let min: i64 = t.get(14..16)?.parse().ok()?;
    let sec: i64 = t.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || !(0..=23).contains(&hour) || !(0..=59).contains(&min) || !(0..=60).contains(&sec) {
        return None;
    }
    let mut rest = t.get(19..)?;
    let mut millis: i64 = 0;
    if let Some(after_dot) = rest.strip_prefix('.') {
        let digits_len = after_dot.bytes().take_while(|c| c.is_ascii_digit()).count();
        if digits_len > 0 {
            let mut frac_str = after_dot[..digits_len.min(3)].to_string();
            while frac_str.len() < 3 {
                frac_str.push('0');
            }
            millis = frac_str.parse().unwrap_or(0);
        }
        rest = &after_dot[digits_len..];
    }
    let mut tz_offset_secs: i64 = 0;
    if !rest.is_empty() && rest != "Z" && rest != "z" {
        let sign: i64 = if rest.starts_with('+') {
            1
        } else if rest.starts_with('-') {
            -1
        } else {
            return None;
        };
        let tz = &rest[1..];
        let (tz_h, tz_m): (i64, i64) = if tz.len() >= 5 && tz.as_bytes()[2] == b':' {
            (tz.get(0..2)?.parse().ok()?, tz.get(3..5)?.parse().ok()?)
        } else if tz.len() >= 4 {
            (tz.get(0..2)?.parse().ok()?, tz.get(2..4)?.parse().ok()?)
        } else {
            return None;
        };
        tz_offset_secs = sign * (tz_h * 3600 + tz_m * 60);
    }
    // Howard Hinnant days_from_civil: days since 1970-01-01
    let y = year - if month <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m_adj = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * m_adj + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let total_secs = days * 86400 + hour * 3600 + min * 60 + sec - tz_offset_secs;
    if total_secs <= 0 {
        return None;
    }
    Some((total_secs as u64) * 1000 + (millis as u64))
}

/// True when a workflow run represents the lane's primary deploy workflow
/// (e.g. `Deploy Dev` / `.github/workflows/deploy-dev.yml`) rather than a
/// secondary observer/gate (`Deploy Health Record`, `Deploy drift alarm`,
/// `Deploy health (merge gate)`). Mirrored in `core.ts` `isDeployWorkflowRun`.
pub fn is_deploy_workflow_run(r: &DeployWorkflowRun, required: &[String]) -> bool {
    let name_lower = r.name.trim().to_lowercase();
    let path_lower = r.path.as_deref().unwrap_or("").trim().to_lowercase();
    if name_lower.contains("health record")
        || name_lower.contains("drift alarm")
        || name_lower.contains("merge gate")
        || path_lower.ends_with("deploy-health.yml")
        || path_lower.ends_with("deploy-drift.yml")
    {
        return false;
    }
    if path_lower.ends_with("/deploy-dev.yml")
        || path_lower == "deploy-dev.yml"
        || path_lower.ends_with("/deploy.yml")
        || path_lower == "deploy.yml"
    {
        return true;
    }
    // The bridge repo's own deploy pipeline is `dev-build` (dev-build.yml, on:
    // push to main): it builds every CLI target and publishes the Cloudflare
    // Worker + manifest — the decisive deployment this lane actually waits on.
    // Without recognizing it, deploy coverage stamps `covered` with no run id
    // and recovery episodes on this lane can never verify (BR#7572). Mirrors
    // core.ts isDeployWorkflowRun.
    if path_lower.ends_with("/dev-build.yml") || path_lower == "dev-build.yml" || name_lower == "dev-build" {
        return true;
    }
    if name_lower == "deploy dev" || name_lower == "deploy" || name_lower.starts_with("deploy to ") {
        return true;
    }
    for req in required {
        let req_lower = req.trim().to_lowercase();
        let prefix = match req_lower.find(" / ") {
            Some(idx) => req_lower[..idx].trim(),
            None => req_lower.as_str(),
        };
        if !prefix.is_empty() && (name_lower == prefix || name_lower == format!("{prefix} dev")) {
            return true;
        }
    }
    false
}

/// Infer the dispatchable workflow filename (e.g. `"deploy-dev.yml"`) from
/// observed workflow runs and the lane's `required_workflows`. Mirrored in
/// `core.ts` `inferDeployWorkflow`.
pub fn infer_deploy_workflow(required: &[String], workflow_runs: &[DeployWorkflowRun]) -> Option<String> {
    let mut sorted: Vec<&DeployWorkflowRun> = workflow_runs.iter().collect();
    sorted.sort_by(|a, b| b.id.cmp(&a.id));
    for r in &sorted {
        if !is_deploy_workflow_run(r, required) {
            continue;
        }
        if let Some(raw_path) = r.path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
            let file = raw_path.rsplit('/').next().unwrap_or("");
            if (file.ends_with(".yml") || file.ends_with(".yaml")) && file != "deploy.yml" {
                return Some(file.to_string());
            }
        }
    }
    for r in &sorted {
        if !is_deploy_workflow_run(r, required) {
            continue;
        }
        if let Some(raw_path) = r.path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
            let file = raw_path.rsplit('/').next().unwrap_or("");
            if file.ends_with(".yml") || file.ends_with(".yaml") {
                return Some(file.to_string());
            }
        }
        if r.name.trim().eq_ignore_ascii_case("deploy dev") {
            return Some("deploy-dev.yml".to_string());
        }
    }
    let has_deploy_req = required.iter().any(|w| {
        let lw = w.trim().to_lowercase();
        lw.starts_with("deploy /") || lw.starts_with("post-deploy /") || lw == "deploy dev"
    });
    if has_deploy_req {
        return Some("deploy-dev.yml".to_string());
    }
    None
}

fn is_queued_workflow_status(status: Option<&str>) -> bool {
    matches!(
        status.unwrap_or("").trim().to_lowercase().as_str(),
        "queued" | "waiting" | "pending" | "requested"
    )
}

fn is_in_progress_workflow_status(status: Option<&str>) -> bool {
    status.unwrap_or("").trim().eq_ignore_ascii_case("in_progress")
}

fn only_derived_deploy_gate_red(verdict: &CheckVerdict, required: &[String]) -> bool {
    const GATE: &str = "Deploy health (merge gate)";
    !required.iter().any(|name| name == GATE)
        && !verdict.red.is_empty()
        && verdict.red.iter().all(|check| {
            if check.name != GATE { return false; }
            let Some(path) = check.url.strip_prefix("https://github.com/") else { return false; };
            let parts: Vec<&str> = path.split('/').collect();
            matches!(parts.as_slice(), [owner, repo, "runs", id] if !owner.is_empty() && !repo.is_empty()
                && id.as_bytes().first().is_some_and(|digit| matches!(digit, b'1'..=b'9'))
                && id.bytes().all(|digit| digit.is_ascii_digit()))
        })
}

/// Pure level-based deploy coverage & reconciliation state machine (BR#6179):
/// - Computes `DeployCoverageState` (closed 6-state union on `phase`).
/// - Decides whether to dispatch `workflow_dispatch` (`dispatch_workflow`) once
///   per `tip_sha` when the tip is uncovered past `grace_secs` with no active run.
/// - Identifies redundant queued deploy runs (`cancel_run_ids`) when the same
///   `head_sha` already has an `in_progress` or `completed/success` deploy run
///   (or duplicate queued runs for the same `head_sha`).
/// Mirrored in `core.ts` `reconcileDeployCoverage`.
pub fn reconcile_deploy_coverage(
    tip_sha: &str,
    tip_age_secs: u64,
    grace_secs: u64,
    base_verdict: &CheckVerdict,
    required: &[String],
    workflow_runs: &[DeployWorkflowRun],
    already_dispatched_at: Option<u64>,
) -> DeployReconcilePlan {
    let tip_sha = tip_sha.trim().to_string();
    let grace_secs = grace_secs.max(1);
    let mut deploy_runs: Vec<&DeployWorkflowRun> = workflow_runs
        .iter()
        .filter(|r| is_deploy_workflow_run(r, required))
        .collect();
    deploy_runs.sort_by_key(|r| std::cmp::Reverse((r.id, r.run_attempt.unwrap_or(1))));
    deploy_runs.dedup_by_key(|r| r.id);

    let newest_green = deploy_runs.iter().copied().find(|r| {
        r.status.as_deref().unwrap_or("").eq_ignore_ascii_case("completed")
            && r.conclusion.as_deref().unwrap_or("").eq_ignore_ascii_case("success")
    });
    let last_green_sha = newest_green
        .map(|r| r.head_sha.clone())
        .filter(|s| !s.is_empty());
    let last_green_run_id = newest_green.map(|r| r.id);

    // (D) Redundant queued runs per head_sha:
    // Preserve first-seen SHA order from `deploy_runs` (already sorted by id desc).
    let mut by_sha: Vec<(String, Vec<&DeployWorkflowRun>)> = Vec::new();
    for r in &deploy_runs {
        let sha = r.head_sha.trim();
        if sha.is_empty() {
            continue;
        }
        match by_sha.iter_mut().find(|(s, _)| s == sha) {
            Some((_, list)) => list.push(*r),
            None => by_sha.push((sha.to_string(), vec![*r])),
        }
    }
    let mut cancel_run_ids: Vec<i64> = Vec::new();
    for (_, list) in &by_sha {
        let has_active_or_green = list.iter().any(|r| {
            is_in_progress_workflow_status(r.status.as_deref())
                || (r.status.as_deref().unwrap_or("").eq_ignore_ascii_case("completed")
                    && r.conclusion.as_deref().unwrap_or("").eq_ignore_ascii_case("success"))
        });
        let queued: Vec<&&DeployWorkflowRun> = list
            .iter()
            .filter(|r| is_queued_workflow_status(r.status.as_deref()))
            .collect();
        if has_active_or_green {
            for q in queued {
                if q.id > 0 && !cancel_run_ids.contains(&q.id) {
                    cancel_run_ids.push(q.id);
                }
            }
        } else if queued.len() > 1 {
            for q in queued.into_iter().skip(1) {
                if q.id > 0 && !cancel_run_ids.contains(&q.id) {
                    cancel_run_ids.push(q.id);
                }
            }
        }
    }

    let tip_runs: Vec<&DeployWorkflowRun> = deploy_runs
        .iter()
        .copied()
        .filter(|r| r.head_sha == tip_sha)
        .collect();
    let tip_active = tip_runs.iter().copied().find(|r| {
        (is_in_progress_workflow_status(r.status.as_deref()) || is_queued_workflow_status(r.status.as_deref()))
            && !cancel_run_ids.contains(&r.id)
    });
    let tip_green = tip_runs.iter().copied().find(|r| {
        r.status.as_deref().unwrap_or("").eq_ignore_ascii_case("completed")
            && r.conclusion.as_deref().unwrap_or("").eq_ignore_ascii_case("success")
    });
    let tip_red = tip_runs.iter().copied().find(|r| {
        r.status.as_deref().unwrap_or("").eq_ignore_ascii_case("completed")
            && r.conclusion.as_deref().map(|c| c != "cancelled" && is_red_conclusion(c)).unwrap_or(false)
    });

    // Workflow evidence outranks a green SUBSET of job checks. Never attach an
    // older SHA's green run to this tip (the false-green incident, BR#6458).
    let newest_tip = tip_runs.iter().copied().find(|r| !matches!(
        r.conclusion.as_deref(), Some("cancelled" | "skipped")
    ));
    let decisive_failure = newest_tip.filter(|r| r.status.as_deref() == Some("completed")
        && r.conclusion.as_deref().map(is_red_conclusion).unwrap_or(false));
    if base_verdict.verdict == MainVerdict::Green && decisive_failure.is_none()
        && tip_active.is_none()
        && (tip_green.is_some() || infer_deploy_workflow(required, workflow_runs).is_none())
    {
        return DeployReconcilePlan {
            coverage: DeployCoverageState::Covered {
                tip_sha: tip_sha.clone(),
                tip_age_secs,
                covered_by_sha: tip_sha.clone(),
                covered_by_run_id: tip_green.map(|r| r.id),
                covered_by_run_attempt: tip_green.and_then(|r| r.run_attempt),
                covered_by_url: tip_green.and_then(|r| r.html_url.clone()),
            },
            dispatch_workflow: None,
            cancel_run_ids,
            covered_by_sha: Some(tip_sha),
            coverage_age_secs: 0,
        };
    }

    // The synthetic push gate can report an unjudged snapshot while the
    // authoritative Deploy Dev attempt is still running on this exact tip.
    let active_supersedes_derived_red = tip_active.zip(newest_tip).is_some_and(|(active, latest)| active.id == latest.id)
        && only_derived_deploy_gate_red(base_verdict, required);
    if (base_verdict.verdict == MainVerdict::Red && !active_supersedes_derived_red)
        || decisive_failure.is_some()
    {
        return DeployReconcilePlan {
            coverage: DeployCoverageState::Failed {
                tip_sha,
                tip_age_secs,
                failing_run_id: tip_red.map(|r| r.id),
                failing_run_url: tip_red.and_then(|r| r.html_url.clone()),
                last_green_sha: last_green_sha.clone(),
                last_green_run_id,
            },
            dispatch_workflow: None,
            cancel_run_ids,
            covered_by_sha: last_green_sha,
            coverage_age_secs: tip_age_secs,
        };
    }

    // BR#14088: a SETTLING base (required checks in flight) is the same
    // wait class as an unsettled read — the tip's verdict is not known yet.
    if base_verdict.verdict == MainVerdict::Unsettled
        || base_verdict.verdict == MainVerdict::Settling
        || tip_active.is_some()
    {
        return DeployReconcilePlan {
            coverage: DeployCoverageState::Settling {
                tip_sha,
                tip_age_secs,
                active_run_id: tip_active.map(|r| r.id),
                active_run_url: tip_active.and_then(|r| r.html_url.clone()),
                last_green_sha: last_green_sha.clone(),
                last_green_run_id,
            },
            dispatch_workflow: None,
            cancel_run_ids,
            covered_by_sha: last_green_sha,
            coverage_age_secs: tip_age_secs,
        };
    }

    let workflow = infer_deploy_workflow(required, workflow_runs);
    if let Some(dispatched_at) = already_dispatched_at.filter(|&ts| ts > 0) {
        return DeployReconcilePlan {
            coverage: DeployCoverageState::UncoveredDispatched {
                tip_sha,
                tip_age_secs,
                workflow: workflow.unwrap_or_else(|| "deploy-dev.yml".to_string()),
                dispatched_at,
                last_green_sha: last_green_sha.clone(),
                last_green_run_id,
            },
            dispatch_workflow: None,
            cancel_run_ids,
            covered_by_sha: last_green_sha,
            coverage_age_secs: tip_age_secs,
        };
    }

    if tip_age_secs < grace_secs {
        return DeployReconcilePlan {
            coverage: DeployCoverageState::UncoveredGrace {
                tip_sha,
                tip_age_secs,
                grace_secs,
                workflow,
                last_green_sha: last_green_sha.clone(),
                last_green_run_id,
            },
            dispatch_workflow: None,
            cancel_run_ids,
            covered_by_sha: last_green_sha,
            coverage_age_secs: tip_age_secs,
        };
    }

    let only_cancelled_or_skipped = !tip_runs.is_empty()
        && tip_runs.iter().all(|r| {
            matches!(
                r.conclusion.as_deref().unwrap_or("").to_lowercase().as_str(),
                "cancelled" | "skipped"
            )
        });
    let reason = if only_cancelled_or_skipped {
        "all deploy runs on tip were cancelled/skipped".to_string()
    } else {
        "no deploy workflow run fired on tip (push trigger suppressed or run deleted)".to_string()
    };
    let dispatch_workflow = if tip_sha.is_empty() { None } else { workflow.clone() };

    DeployReconcilePlan {
        coverage: DeployCoverageState::UncoveredDark {
            tip_sha,
            tip_age_secs,
            grace_secs,
            workflow,
            last_green_sha: last_green_sha.clone(),
            last_green_run_id,
            reason,
        },
        dispatch_workflow,
        cancel_run_ids,
        covered_by_sha: last_green_sha,
        coverage_age_secs: tip_age_secs,
    }
}

fn format_coverage_age_short(secs: u64) -> String {
    if secs < 60 {
        format!("{secs}s")
    } else {
        format!("{}m", secs / 60)
    }
}

/// Human-readable single-line deploy coverage summary for lane reasons and
/// TrainPanel banners (BR#6179 B). Mirrored in `core.ts` `formatDeployCoverageSummary`.
pub fn format_deploy_coverage_summary(cov: &DeployCoverageState) -> String {
    match cov {
        DeployCoverageState::Covered { tip_sha, covered_by_run_id, .. } => {
            let short = if tip_sha.is_empty() { "unknown" } else { &tip_sha[..tip_sha.len().min(8)] };
            let run_suffix = covered_by_run_id.map(|id| format!(" (run #{id})")).unwrap_or_default();
            format!("tip {short} covered by deploy{run_suffix}")
        }
        DeployCoverageState::Settling { tip_sha, tip_age_secs, active_run_id, .. } => {
            let short = if tip_sha.is_empty() { "unknown" } else { &tip_sha[..tip_sha.len().min(8)] };
            let age_str = format_coverage_age_short(*tip_age_secs);
            let run_suffix = active_run_id.map(|id| format!(", run #{id}")).unwrap_or_default();
            format!("tip {short} deploy in flight (age {age_str}{run_suffix})")
        }
        DeployCoverageState::UncoveredGrace { tip_sha, tip_age_secs, grace_secs, .. } => {
            let short = if tip_sha.is_empty() { "unknown" } else { &tip_sha[..tip_sha.len().min(8)] };
            let age_str = format_coverage_age_short(*tip_age_secs);
            let gm = (*grace_secs / 60).max(1);
            format!("tip {short} not covered by any deploy (age {age_str}, grace {gm}m)")
        }
        DeployCoverageState::UncoveredDispatched { tip_sha, tip_age_secs, workflow, .. } => {
            let short = if tip_sha.is_empty() { "unknown" } else { &tip_sha[..tip_sha.len().min(8)] };
            let age_str = format_coverage_age_short(*tip_age_secs);
            format!("tip {short} not covered by any deploy (age {age_str}) — auto-dispatched {workflow}")
        }
        DeployCoverageState::UncoveredDark { tip_sha, tip_age_secs, last_green_sha, .. } => {
            let short = if tip_sha.is_empty() { "unknown" } else { &tip_sha[..tip_sha.len().min(8)] };
            let age_str = format_coverage_age_short(*tip_age_secs);
            let prev = last_green_sha
                .as_deref()
                .filter(|s| !s.is_empty())
                .map(|s| format!(" — last green deploy {}", &s[..s.len().min(8)]))
                .unwrap_or_default();
            format!("tip {short} not covered by any deploy (age {age_str}){prev}")
        }
        DeployCoverageState::Failed { tip_sha, tip_age_secs, .. } => {
            let short = if tip_sha.is_empty() { "unknown" } else { &tip_sha[..tip_sha.len().min(8)] };
            let age_str = format_coverage_age_short(*tip_age_secs);
            format!("tip {short} deploy failed (age {age_str})")
        }
    }
}

/// Reconciles `CheckVerdict` (computed from commit check-runs) with
/// `DeployCoverageState` (computed from deploy workflow runs) into a single
/// cohesive base verdict (BR#6389):
/// - When `base_verdict.verdict == MainVerdict::Empty` because a multi-stage
///   deploy workflow (e.g. `Deploy Dev` in `Prepare deploy to dev (build on spot)`)
///   has not created downstream `required_workflows` check-runs yet, but
///   `coverage` is `DeployCoverageState::Settling`, the effective verdict is
///   `MainVerdict::Unsettled` (with `alarm: None`), NEVER `Empty` ("dark tip").
/// - When `base_verdict.verdict == MainVerdict::Empty` and `coverage` is
///   `DeployCoverageState::Failed` (the deploy workflow failed in build/setup
///   before creating downstream check-runs), the effective verdict is
///   `MainVerdict::Red` naming `Deploy Dev`.
/// - When `base_verdict.verdict == MainVerdict::Empty` and `coverage` is
///   `DeployCoverageState::Covered`, keep waiting for required check evidence.
/// Mirrored in `core.ts` `reconcileBaseVerdictWithDeployCoverage`.
pub fn reconcile_base_verdict_with_deploy_coverage(
    base_verdict: &CheckVerdict,
    coverage: &DeployCoverageState,
    required: &[String],
) -> CheckVerdict {
    // This is the effective line-health reducer, not an empty-checks cosmetic
    // adapter. Deployment failure must override scoped job-subset GREEN.
    let active_supersedes_derived_red =
        matches!(coverage, DeployCoverageState::Settling { active_run_id: Some(id), .. } if *id > 0)
            && only_derived_deploy_gate_red(base_verdict, required);
    if base_verdict.verdict == MainVerdict::Red && !active_supersedes_derived_red {
        return base_verdict.clone();
    }
    match coverage {
        DeployCoverageState::Settling { active_run_id, .. } => {
            let mut v = base_verdict.clone();
            // BR#14088: the deploy is IN FLIGHT — the verdict is unknown, so
            // the rollup reads SETTLING (amber), never green/unsettled: the
            // in-flight class is distinguishable from an inconclusive read.
            v.verdict = MainVerdict::Settling;
            v.red.clear();
            v.alarm = None;
            let label = match active_run_id {
                Some(id) => format!("Deploy Dev (run #{id} in flight)"),
                None => "Deploy Dev (in flight)".to_string(),
            };
            if v.settling.is_empty() {
                v.settling.push(label.clone());
            }
            if v.unsettled.is_empty() {
                v.unsettled.push(label); // fold: list consumers keep naming the check
            }
            v
        }
        DeployCoverageState::Failed { failing_run_id, failing_run_url, .. } => {
            let mut v = base_verdict.clone();
            v.verdict = MainVerdict::Red;
            v.alarm = None;
            if v.red.is_empty() {
                let name = match failing_run_id {
                    Some(id) => format!("Deploy Dev (run #{id})"),
                    None => "Deploy Dev".to_string(),
                };
                v.red.push(MainRedCheck {
                    name,
                    conclusion: "failure".to_string(),
                    url: failing_run_url.clone().unwrap_or_default(),
                });
            }
            v
        }
        DeployCoverageState::Covered { .. } => {
            if base_verdict.verdict != MainVerdict::Empty {
                return base_verdict.clone();
            }
            let mut v = base_verdict.clone();
            v.verdict = MainVerdict::Unsettled;
            v.unsettled.push("Deployment finished; waiting for required checks".to_string());
            v.alarm = None;
            v
        }
        DeployCoverageState::UncoveredGrace { .. } | DeployCoverageState::UncoveredDispatched { .. } => {
            let mut v = base_verdict.clone();
            v.verdict = MainVerdict::Unsettled;
            v.unsettled.push("Waiting for a covering deployment to start".to_string());
            v
        }
        DeployCoverageState::UncoveredDark { reason, .. } => {
            let mut v = base_verdict.clone();
            v.verdict = MainVerdict::Empty;
            v.alarm = Some(reason.clone());
            v
        }
    }
}

// ---------- fixtures mirrored from packages/worker/test/merge-train.test.ts ----------

#[cfg(test)]
fn run(id: i64, name: &str, conclusion: Option<&str>) -> MainCheckRun {
    MainCheckRun { id, source: CheckSource::Unknown, name: name.into(), status: Some("completed".into()), conclusion: conclusion.map(String::from), html_url: None }
}

/// BR#9268 test helper: a NATIVE Actions job check run — the dispatchable
/// execution class (`/actions/runs/{run}/job/{job}` URL, Actions app, the
/// live gate suite). The plain `run()` helper stays `Unknown` for the
/// fail-closed tests; anything asserting DISPATCH must use a genuinely
/// dispatchable provider shape, or the test passes for the wrong reason.
#[cfg(test)]
fn native_run(id: i64, name: &str, conclusion: Option<&str>) -> MainCheckRun {
    MainCheckRun {
        id,
        source: CheckSource::CheckRun { suite_id: 115286627637, app_id: GITHUB_ACTIONS_APP_ID, producer: CheckRunProducer::ActionsJob },
        name: name.into(),
        status: Some("completed".into()),
        conclusion: conclusion.map(String::from),
        html_url: Some(format!("https://github.com/state-vector/superpositional/actions/runs/42563228107/job/{id}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_name_different_suites_remain_independent_obligations() {
        let mut original = run(126988470498, "Deploy health (merge gate)", Some("failure"));
        original.source = CheckSource::CheckRun { suite_id: 10, app_id: 1, producer: CheckRunProducer::Published };
        let mut republished = run(127642055356, "Deploy health (merge gate)", Some("success"));
        republished.source = CheckSource::CheckRun { suite_id: 20, app_id: 1, producer: CheckRunProducer::Published };
        let mut runs = vec![original.clone(), republished];
        assert_eq!(classify_head_checks(&runs).verdict, MainVerdict::Red);
        assert_eq!(classify_main_check_runs(&runs).verdict, MainVerdict::Red);
        // BR#9268: a published report is a report — never in the dispatch set
        assert!(latest_red_deploy_health_runs(&runs).is_empty());
        assert_eq!(red_report_gate_judges(&runs)[0].0, "Deploy health (merge gate)");
        original.id = 127653739994;
        original.conclusion = Some("success".into());
        runs.push(original);
        assert_eq!(classify_head_checks(&runs).verdict, MainVerdict::Green);
        assert!(latest_red_deploy_health_runs(&runs).is_empty());
        assert!(red_report_gate_judges(&runs).is_empty());
    }

    /// BR#9268 live shape — SP PR #3057 head b6e84012 (2026-11-09): the
    /// GitHub Actions app (15368) filed an API-created `Deploy health (merge
    /// gate)` check run into the SAME check suite as the native gate job —
    /// identical name, app id and suite id; only the URL shape separates
    /// them. A newer published green must never supersede — mask — the
    /// older native job's failure while GitHub keeps the PR BLOCKED.
    #[test]
    fn published_report_cannot_mask_native_job_failure_same_suite() {
        let repo = "state-vector/superpositional";
        let suite = 115286627637;
        let native = MainCheckRun {
            id: 128984021963,
            source: CheckSource::CheckRun { suite_id: suite, app_id: GITHUB_ACTIONS_APP_ID, producer: CheckRunProducer::ActionsJob },
            name: "Deploy health (merge gate)".into(),
            status: Some("completed".into()),
            conclusion: Some("failure".into()),
            html_url: Some(format!("https://github.com/{repo}/actions/runs/42563228107/job/128984021963")),
        };
        let published_green = MainCheckRun {
            id: 129034449798,
            source: CheckSource::CheckRun { suite_id: suite, app_id: GITHUB_ACTIONS_APP_ID, producer: CheckRunProducer::Published },
            name: "Deploy health (merge gate)".into(),
            status: Some("completed".into()),
            conclusion: Some("success".into()),
            html_url: Some(format!("https://github.com/{repo}/runs/129034449798")),
        };
        let runs = vec![native.clone(), published_green.clone()];
        // The pre-split collapse judged this obligation by the newest id —
        // the published green — and read the head green while GitHub held it
        // BLOCKED. The producer split keeps the native red speaking.
        assert_eq!(classify_head_checks(&runs).verdict, MainVerdict::Red);
        assert_eq!(classify_main_check_runs(&runs).verdict, MainVerdict::Red);
        assert_eq!(classify_head_checks(&runs).red[0].url, native.html_url.clone().unwrap());
        // The dispatch set is the ACTUAL native job — the published report
        // is never re-requested.
        let stale = latest_red_deploy_health_runs(&runs);
        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].id, native.id);
        assert!(red_report_gate_judges(&runs).is_empty()); // the published judge here is green
        // Mirror direction: a newer published FAILURE is its own red even
        // against an older native GREEN — never masked, never masked by.
        let native_green = MainCheckRun { conclusion: Some("success".into()), ..native.clone() };
        let published_red = MainCheckRun { conclusion: Some("failure".into()), ..published_green.clone() };
        let runs = vec![native_green, published_red];
        assert_eq!(classify_head_checks(&runs).verdict, MainVerdict::Red);
        let stale = latest_red_deploy_health_runs(&runs);
        assert!(stale.is_empty());
        let reports = red_report_gate_judges(&runs);
        assert_eq!(reports.len(), 1);
        assert!(!reports[0].2); // published, not unclassified
    }

    /// BR#9268: supersession stays WITHIN one producer class. A newer
    /// native attempt supersedes an older native attempt; a fresher
    /// publication supersedes an older report; neither class touches the
    /// other's judge.
    #[test]
    fn same_producer_supersession_stays_within_class() {
        let repo = "state-vector/superpositional";
        let suite = 114954645548;
        let native_red = MainCheckRun {
            id: 128960757729,
            source: CheckSource::CheckRun { suite_id: suite, app_id: GITHUB_ACTIONS_APP_ID, producer: CheckRunProducer::ActionsJob },
            name: "Deploy health (merge gate)".into(),
            status: Some("completed".into()),
            conclusion: Some("failure".into()),
            html_url: Some(format!("https://github.com/{repo}/actions/runs/42433292307/job/128960757729")),
        };
        let native_green_rerun = MainCheckRun {
            id: 129099999999,
            html_url: Some(format!("https://github.com/{repo}/actions/runs/42433292307/job/129099999999")),
            conclusion: Some("success".into()),
            ..native_red.clone()
        };
        let published_green = MainCheckRun {
            id: 129034481458,
            source: CheckSource::CheckRun { suite_id: suite, app_id: GITHUB_ACTIONS_APP_ID, producer: CheckRunProducer::Published },
            name: "Deploy health (merge gate)".into(),
            status: Some("completed".into()),
            conclusion: Some("success".into()),
            html_url: Some(format!("https://github.com/{repo}/runs/129034481458")),
        };
        let published_red_older = MainCheckRun { id: 128000000000, conclusion: Some("failure".into()), ..published_green.clone() };
        // A native re-run that succeeded supersedes the older native failure
        // (same class); the published green (other class) neither masks the
        // older native red nor is masked by it — but with the native judge
        // now green, the head is green.
        let runs = vec![native_red.clone(), native_green_rerun.clone(), published_green.clone()];
        assert_eq!(classify_head_checks(&runs).verdict, MainVerdict::Green);
        // Drop the native re-run: the native red speaks again even though a
        // newer published green exists (the live #3057 masking shape).
        let runs = vec![native_red.clone(), published_green.clone()];
        assert_eq!(classify_head_checks(&runs).verdict, MainVerdict::Red);
        // A fresher publication supersedes an older report of its own class:
        // the older published red cannot survive a newer published green.
        let runs = vec![native_green_rerun.clone(), published_red_older, published_green.clone()];
        assert_eq!(classify_head_checks(&runs).verdict, MainVerdict::Green);
        // Unclassified observations are their own class: they never merge
        // with a classified obligation, so they can never vouch over (or be
        // masked by) the native job's verdict.
        let unclassified = MainCheckRun {
            id: 130000000000,
            source: CheckSource::CheckRun { suite_id: suite, app_id: GITHUB_ACTIONS_APP_ID, producer: CheckRunProducer::Unclassified },
            conclusion: Some("success".into()),
            html_url: None,
            ..native_red.clone()
        };
        let runs = vec![native_red, unclassified];
        assert_eq!(classify_head_checks(&runs).verdict, MainVerdict::Red);
    }

    /// BR#9268 retired push-workflow shape — SP PR #2942 head ae303a44: the
    /// head carries THREE `Deploy health (merge gate)` runs across TWO
    /// suites. The retired push-triggered Deploy Dev's suite (114954639280)
    /// holds a native job failure AND the republished report; the PR CI
    /// suite (114954645548) holds a native job success. Suite separation
    /// keeps the PR CI green independent; within the push suite the native
    /// failure must stay visible next to the report.
    #[test]
    fn retired_push_workflow_two_suite_shape_stays_distinct() {
        let repo = "state-vector/superpositional";
        let push_suite = 114954639280;
        let ci_suite = 114954645548;
        let native_push_failure = MainCheckRun {
            id: 128586665979,
            source: CheckSource::CheckRun { suite_id: push_suite, app_id: GITHUB_ACTIONS_APP_ID, producer: CheckRunProducer::ActionsJob },
            name: "Deploy health (merge gate)".into(),
            status: Some("completed".into()),
            conclusion: Some("failure".into()),
            html_url: Some(format!("https://github.com/{repo}/actions/runs/42433289639/job/128586665979")),
        };
        let published_push_report = MainCheckRun {
            id: 129034481458,
            source: CheckSource::CheckRun { suite_id: push_suite, app_id: GITHUB_ACTIONS_APP_ID, producer: CheckRunProducer::Published },
            name: "Deploy health (merge gate)".into(),
            status: Some("completed".into()),
            conclusion: Some("failure".into()),
            html_url: Some(format!("https://github.com/{repo}/runs/129034481458")),
        };
        let native_ci_success = MainCheckRun {
            id: 128960757729,
            source: CheckSource::CheckRun { suite_id: ci_suite, app_id: GITHUB_ACTIONS_APP_ID, producer: CheckRunProducer::ActionsJob },
            name: "Deploy health (merge gate)".into(),
            status: Some("completed".into()),
            conclusion: Some("success".into()),
            html_url: Some(format!("https://github.com/{repo}/actions/runs/42433292307/job/128960757729")),
        };
        let runs = vec![native_push_failure.clone(), published_push_report.clone(), native_ci_success.clone()];
        assert_eq!(classify_head_checks(&runs).verdict, MainVerdict::Red);
        // The self-heal dispatches the ACTUAL native job once — the push
        // suite's red job, never the report, never the green CI job.
        let stale = latest_red_deploy_health_runs(&runs);
        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].id, native_push_failure.id);
        let reports = red_report_gate_judges(&runs);
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].1, published_push_report.html_url.clone().unwrap());
    }

    /// BR#9268: the producer class comes from the provider URL shape — never
    /// caller-asserted. MUST stay behaviour-identical to contracts
    /// train-checks.ts `checkRunProducer`.
    #[test]
    fn check_run_producer_derivation_is_provider_shaped() {
        let repo = "state-vector/superpositional";
        assert_eq!(check_run_producer(Some(&format!("https://github.com/{repo}/actions/runs/42563228107/job/128984021963"))), CheckRunProducer::ActionsJob);
        assert_eq!(check_run_producer(Some(&format!("https://github.com/{repo}/runs/129034449798"))), CheckRunProducer::Published);
        assert_eq!(check_run_producer(Some(&format!("https://github.com/{repo}/runs/0123"))), CheckRunProducer::Unclassified);
        assert_eq!(check_run_producer(Some(&format!("https://github.com/{repo}/actions/runs/42563228107"))), CheckRunProducer::Unclassified);
        assert_eq!(check_run_producer(Some("https://example.com/other")), CheckRunProducer::Unclassified);
        assert_eq!(check_run_producer(None), CheckRunProducer::Unclassified);
        assert_eq!(check_run_producer(Some("  ")), CheckRunProducer::Unclassified);
    }

    #[test]
    fn active_exact_deploy_attempt_supersedes_only_derived_gate_red() {
        let tip = "e1b6b5954433ccf38c328104447f4af0176a7cf6";
        let run_id = 42562274448;
        let run_url = "https://github.com/state-vector/superpositional/actions/runs/42562274448";
        let required: Vec<String> = vec!["deploy / Deploy to dev".into(), "post-deploy / Lodestar Operational Health".into()];
        let mut gate = run(128982701091, "Deploy health (merge gate)", Some("failure"));
        gate.html_url = Some("https://github.com/state-vector/superpositional/runs/128982701091".into());
        let scoped = classify_base_check_runs(&[gate.clone(), run(128986714690, &required[1], None)], &required);
        assert_eq!(scoped.verdict, MainVerdict::Red);
        let first = DeployWorkflowRun {
            id: run_id, run_attempt: Some(1), name: "Deploy Dev".into(), path: Some(".github/workflows/deploy-dev.yml".into()),
            head_sha: tip.into(), event: Some("push".into()), status: Some("completed".into()),
            conclusion: Some("failure".into()), html_url: Some(run_url.into()),
        };
        let second = DeployWorkflowRun { run_attempt: Some(2), status: Some("in_progress".into()), conclusion: None, ..first.clone() };
        let plan = reconcile_deploy_coverage(tip, 1350, 300, &scoped, &required, &[first.clone(), second.clone()], None);
        assert!(matches!(plan.coverage, DeployCoverageState::Settling { active_run_id: Some(id), .. } if id == run_id));
        let effective = reconcile_base_verdict_with_deploy_coverage(&scoped, &plan.coverage, &required);
        // BR#14088: the in-flight deploy attempt reads SETTLING (amber, never
        // green); the derived-gate red stays superseded (red empty).
        assert_eq!(effective.verdict, MainVerdict::Settling);
        assert!(effective.red.is_empty());

        let mut native_gate = gate.clone();
        native_gate.html_url = Some(format!("{run_url}/job/128986714690"));
        for checks in [vec![native_gate], vec![gate.clone(), run(128986714690, &required[1], Some("failure"))]] {
            let red = classify_base_check_runs(&checks, &required);
            let plan = reconcile_deploy_coverage(tip, 1350, 300, &red, &required, &[second.clone()], None);
            assert!(matches!(plan.coverage, DeployCoverageState::Failed { .. }));
        }
        let explicitly_required = [required.as_slice(), &[gate.name]].concat();
        assert!(matches!(reconcile_deploy_coverage(tip, 1350, 300, &scoped, &explicitly_required, &[second.clone()], None).coverage,
            DeployCoverageState::Failed { .. }));
        let foreign = DeployWorkflowRun { head_sha: "a".repeat(40), ..second.clone() };
        assert!(matches!(reconcile_deploy_coverage(tip, 1350, 300, &scoped, &required, &[foreign], None).coverage,
            DeployCoverageState::Failed { .. }));
        let third = DeployWorkflowRun { run_attempt: Some(3), ..first.clone() };
        assert!(matches!(reconcile_deploy_coverage(tip, 1350, 300, &scoped, &required, &[first, second, third], None).coverage,
            DeployCoverageState::Failed { failing_run_id: Some(id), .. } if id == run_id));
    }

    #[test]
    fn decisive_failed_deploy_overrules_scoped_green_and_never_borrows_old_receipt() {
        let required: Vec<String> = vec!["deploy / Deploy to dev".into(), "post-deploy / Post-Deploy Smoke".into(),
            "post-deploy / DNS chain (front doors)".into(), "post-deploy / Lodestar Operational Health".into()];
        let runs: Vec<MainCheckRun> = required.iter().enumerate().map(|(i, name)| run(i as i64, name, Some("success"))).collect();
        let scoped = classify_base_check_runs(&runs, &required);
        assert_eq!(scoped.verdict, MainVerdict::Green);
        let workflow = |id, sha: &str, conclusion: &str| DeployWorkflowRun { id, run_attempt: Some(1), name: "Deploy Dev".into(),
            path: Some(".github/workflows/deploy-dev.yml".into()), head_sha: sha.into(), event: Some("push".into()),
            status: Some("completed".into()), conclusion: Some(conclusion.into()), html_url: Some(format!("https://github.com/actions/runs/{id}")) };
        let workflows = vec![workflow(41926939169, "78760d10", "failure"), workflow(41924676992, "e99f74f8", "success")];
        let plan = reconcile_deploy_coverage("78760d10", 7800, 300, &scoped, &required, &workflows, None);
        assert!(matches!(plan.coverage, DeployCoverageState::Failed { failing_run_id: Some(41926939169), .. }));
        assert_eq!(plan.covered_by_sha.as_deref(), Some("e99f74f8"));
        let effective = reconcile_base_verdict_with_deploy_coverage(&scoped, &plan.coverage, &required);
        assert_eq!(effective.verdict, MainVerdict::Red);
        assert!(effective.red[0].url.ends_with("41926939169"));
        // Effective red cannot dispatch stale-gate recovery or clear a stop.
        assert_ne!(effective.verdict, MainVerdict::Green);
        let newer_failure = vec![workflow(3, "tip", "failure"), workflow(2, "tip", "success")];
        assert!(matches!(reconcile_deploy_coverage("tip", 900, 300, &scoped, &required, &newer_failure, None).coverage,
            DeployCoverageState::Failed { .. }));
    }

    #[test]
    fn latest_red_deploy_health_ignores_superseded_red_when_latest_green_br5880() {
        // The exact BR#5880 incident shape on PR #2707's head sha: Nov-2
        // deploy-health reds (ids 125040321562, 125041293759) still attached
        // to the sha, while the LATEST run of the same check name was
        // SUCCESS (id 126074493096, 2026-11-03 17:07Z). The dispatch set
        // must be EMPTY — re-requesting the superseded reds would re-open a
        // healed check and flip the head back to unsettled next tick.
        // (The live fetch itself — ctx.check_runs, a paginated gh read — is
        // not unit-testable here; this newest-wins law over the fetched set
        // is the testable half of the invariant.) BR#9268: the fixtures are
        // NATIVE jobs so the empty set comes from supersession, not from
        // non-dispatchability — every one of them would dispatch if it were
        // the judge.
        let runs = vec![
            native_run(125_040_321_562, "Deploy health (merge gate)", Some("failure")),
            native_run(125_041_293_759, "Deploy health (merge gate)", Some("failure")),
            native_run(126_074_493_096, "Deploy health (merge gate)", Some("success")),
        ];
        assert!(latest_red_deploy_health_runs(&runs).is_empty());
    }

    #[test]
    fn latest_red_deploy_health_dispatches_the_latest_red_only_br5880() {
        // A REAL red (the judge run — highest id, non-cancelled — is red):
        // exactly that run is dispatchable, never the superseded older red.
        let runs = vec![
            native_run(100, "Deploy health (merge gate)", Some("failure")),
            native_run(200, "Deploy health (merge gate)", Some("timed_out")),
        ];
        let got = latest_red_deploy_health_runs(&runs);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, 200, "the judge (newest non-cancelled) run only");
    }

    #[test]
    fn latest_red_deploy_health_skips_cancelled_judge_br5880() {
        // Same judge law as classify_head_checks: a CANCELLED newest run is
        // not the judge — the next non-cancelled run down decides.
        let runs = vec![
            native_run(300, "Deploy health (merge gate)", Some("cancelled")),
            native_run(200, "Deploy health (merge gate)", Some("failure")),
        ];
        let got = latest_red_deploy_health_runs(&runs);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, 200);
    }

    #[test]
    fn latest_red_deploy_health_ignores_other_check_names_br5880() {
        // Non-deploy-health reds are NOT self-heal dispatchable (the arm
        // heals only the stale main-deploy-judging gate class).
        let runs = vec![run(400, "Rust Tests", Some("failure"))];
        assert!(latest_red_deploy_health_runs(&runs).is_empty());
    }

    /// BR#9268: an unclassified red judge (no recognizable provider URL
    /// shape) is fail-closed — GitHub's rerequest would aim at nothing, so
    /// it is never dispatched; `red_report_gate_judges` reports it as the
    /// LOUD variant so payload drift surfaces instead of burning no-op
    /// rerequests (the BR#9081 class).
    #[test]
    fn unclassified_red_judge_is_fail_closed_never_dispatched_br9268() {
        // Live shape: a real check run whose html_url carries no recognizable
        // GitHub URL shape (payload drift) — the read classifies it
        // CheckRun/Unclassified, never an execution.
        let unclassified = MainCheckRun {
            id: 500,
            source: CheckSource::CheckRun { suite_id: 115286627637, app_id: GITHUB_ACTIONS_APP_ID, producer: CheckRunProducer::Unclassified },
            name: "Deploy health (merge gate)".into(),
            status: Some("completed".into()),
            conclusion: Some("failure".into()),
            html_url: Some("https://example.com/other".into()),
        };
        let runs = vec![unclassified];
        assert!(latest_red_deploy_health_runs(&runs).is_empty());
        let loud = red_report_gate_judges(&runs);
        assert_eq!(loud.len(), 1);
        assert!(loud[0].2, "the unclassified judge is the loud variant");
    }

    #[test]
    fn only_live_open_prs_are_batch_candidates_br5639() {
        // BR#5639 ghost car: the batch reached `ready` while binding CLOSED
        // PR #2659. Fail-closed: ONLY an OPEN live read can be a batch
        // candidate — CLOSED, MERGED (incl. without a mergeCommit), a
        // missing state (gh partial read), or an empty string all exclude.
        assert!(pr_state_is_batch_candidate(Some("OPEN")));
        assert!(!pr_state_is_batch_candidate(Some("CLOSED")), "the ghost-car state itself");
        assert!(!pr_state_is_batch_candidate(Some("MERGED")), "MERGED without mergeCommit fell through the old ==CLOSED shape");
        assert!(!pr_state_is_batch_candidate(None), "unreadable state is never a candidate (fail-closed)");
        assert!(!pr_state_is_batch_candidate(Some("")), "empty state is never a candidate");
    }

    #[test]
    fn classify_main_empty_red_unsettled_green() {
        assert!(matches!(classify_main_check_runs(&[]).verdict, MainVerdict::Empty));
        let red = classify_main_check_runs(&[run(1, "ci", Some("success")), run(2, "ci2", Some("failure"))]);
        assert!(matches!(red.verdict, MainVerdict::Red));
        assert_eq!(red.red[0].name, "ci2");
        let unsettled = classify_main_check_runs(&[run(1, "ci", Some("in_progress"))]);
        assert!(matches!(unsettled.verdict, MainVerdict::Unsettled));
        let green = classify_main_check_runs(&[run(1, "ci", Some("success")), run(2, "ci", Some("cancelled")), run(3, "lint", Some("skipped"))]);
        assert!(matches!(green.verdict, MainVerdict::Green));
        assert_eq!(green.green, 2);
    }

    #[test]
    fn newest_non_cancelled_judges() {
        let v = classify_main_check_runs(&[run(1, "ci", Some("failure")), run(2, "ci", Some("success"))]);
        assert!(matches!(v.verdict, MainVerdict::Green));
        let v = classify_main_check_runs(&[run(1, "ci", Some("success")), run(2, "ci", Some("failure")), run(3, "ci", Some("cancelled"))]);
        assert!(matches!(v.verdict, MainVerdict::Red));
    }

    #[test]
    fn head_checks_pull_externals_out_of_red() {
        let v = classify_head_checks(&[run(1, "ci", Some("success")), run(2, "Cloudflare Workers", Some("failure"))]);
        assert!(matches!(v.verdict, MainVerdict::Green));
        assert_eq!(v.external.len(), 1);
        let v = classify_head_checks(&[run(1, "Cloudflare Workers", None)]);
        assert!(matches!(v.verdict, MainVerdict::Green)); // exempt in-flight says nothing
        let v = classify_head_checks(&[run(1, "ci", None)]);
        // BR#14088: an in-flight (conclusion null) check is SETTLING — amber,
        // never green, and never the inconclusive "unsettled" class. The name
        // still folds into `unsettled` for list consumers.
        assert!(matches!(v.verdict, MainVerdict::Settling));
        assert_eq!(v.settling, vec!["ci"]);
        assert_eq!(v.unsettled, vec!["ci"]);
    }

    // ---------- BR#6001: the Superpositional external check is never gating
    // (implements accepted BR#3177 — a failing SP review pipeline is an SP
    // quality issue; the app-side IndexingFailed/States.Timeout on check-run
    // 126241425334 held verified PRs #387/#390 out of the lane >60m). ----------
    #[test]
    fn superpositional_failure_is_exempt_external_never_gating_br6001() {
        // FAILURE beside all-green substance checks → GREEN with external[]
        // populated — never RED, never the note/bounce rows.
        let v = classify_head_checks(&[run(1, "ci", Some("success")), run(2, "Superpositional", Some("failure"))]);
        assert!(matches!(v.verdict, MainVerdict::Green), "SP process failure must not gate: {:?}", v.verdict);
        assert_eq!(v.external.len(), 1);
        assert_eq!(v.external[0].name, "Superpositional");
        assert_eq!(v.external[0].conclusion, "failure");
        assert!(v.red.is_empty());
    }

    #[test]
    fn superpositional_success_still_counts_green_br6001() {
        // no regression: SUCCESS on the SP check counts as a green check
        let v = classify_head_checks(&[run(1, "Superpositional", Some("success")), run(2, "ci", Some("success"))]);
        assert!(matches!(v.verdict, MainVerdict::Green));
        assert_eq!(v.green, 2);
        assert!(v.external.is_empty());
        // in-flight SP check says nothing (BR#2267 law unchanged)
        let v = classify_head_checks(&[run(1, "Superpositional", None)]);
        assert!(matches!(v.verdict, MainVerdict::Green));
        assert!(v.unsettled.is_empty());
    }

    #[test]
    fn unrelated_external_check_names_still_gate_br6001() {
        // the exemption is pattern-listed, not a blanket — a name not on the
        // list is unchanged: RED, external[] empty
        let v = classify_head_checks(&[run(1, "ci", Some("success")), run(2, "Some Other App", Some("failure"))]);
        assert!(matches!(v.verdict, MainVerdict::Red));
        assert!(v.external.is_empty());
    }

    #[test]
    fn sp_failure_head_gate_merges_no_note_no_bounce_br6001() {
        // the BR#5994 starvation shape end-to-end at the head gate: every
        // substance check SUCCESS, only 'Superpositional' FAILURE → the lane
        // MERGES — never the note row, never a bounce.
        let head = "cccccccccccccccccccccccccccccccccccccccc";
        let meta = serde_json::json!({ "prs": [ { "repo": "state-vector/bridge", "number": 387, "head_sha_at_acceptance": head } ] });
        let gate = decide_train_gate(TrainGateInput {
            pr_number: 387,
            head_sha: head,
            card_meta: &meta,
            card_status: Some("blocked"),
            base_verdict: MainVerdict::Green,
            mergeable: Some(true),
            merge_state_status: Some("clean".into()),
            commits: &[(head.into(), true)],
            head_checks: &[
                run(1, "Test", Some("success")),
                run(2, "Superpositional", Some("failure")),
            ],
            leg_number: Some(1),
            mechanical_move: None,
            root_fix: false,
            base_red_names: &[],
            base_gate_green: false,
            train_owned_branch: false,
        });
        match gate {
            MergeAction::Merge { receipt } => assert!(receipt.contains("BR#3516"), "receipt: {receipt}"),
            other => panic!("expected merge (SP failure never gates), got {other:?}"),
        }
    }

    #[test]
    fn base_class_scopes_to_required_workflows() {
        // BR#5265 Fix B: the 2026-10-31 outage shape — deploy-required
        // workflows green on the tip, three non-required nightly reds
        // parking the train. Scoped to the required list the verdict is
        // GREEN (nightly reds never gate the train); un-scoped (legacy,
        // empty required list) the same tip reads RED.
        let tip = [
            run(1, "deploy / Deploy to dev", Some("success")),
            run(2, "post-deploy / Lodestar Storage Health", Some("success")),
            run(3, "Quality Replay (corpus → verdicts → full battery)", Some("failure")),
            run(4, "Meta-review nightly", Some("failure")),
            run(5, "Republish gate on open PR heads", Some("failure")),
        ];
        let required: Vec<String> = vec![
            "deploy / Deploy to dev".into(),
            "post-deploy / Lodestar Storage Health".into(),
        ];
        let scoped = classify_base_check_runs(&tip, &required);
        assert!(matches!(scoped.verdict, MainVerdict::Green), "nightly reds must not park the train: got {:?}", scoped.verdict);
        // a REQUIRED red still stops the train — scoping narrows the judge
        // set, it never blinds the gate to its own workflows
        let required_red = classify_base_check_runs(
            &[run(1, "deploy / Deploy to dev", Some("failure")), run(2, "Meta-review nightly", Some("failure"))],
            &required,
        );
        assert!(matches!(required_red.verdict, MainVerdict::Red));
        assert_eq!(required_red.red.len(), 1);
        assert_eq!(required_red.red[0].name, "deploy / Deploy to dev");
        // newest non-cancelled per name still judges inside the scope: the
        // rerun's success heals the earlier failure. Every required name must
        // be present-and-green for GREEN — the second required workflow is
        // added below so the healed read certifies green (BR#14088
        // required-completeness), and the missing-post-deploy variant reads
        // SETTLING "(awaiting first run)", never green.
        let healed = classify_base_check_runs(
            &[run(1, "deploy / Deploy to dev", Some("failure")), run(2, "deploy / Deploy to dev", Some("success")), run(3, "post-deploy / Lodestar Storage Health", Some("success"))],
            &required,
        );
        assert!(matches!(healed.verdict, MainVerdict::Green));
        let missing_post_deploy = classify_base_check_runs(
            &[run(1, "deploy / Deploy to dev", Some("failure")), run(2, "deploy / Deploy to dev", Some("success"))],
            &required,
        );
        // BR#14088: the post-admission smoke starts LAST (~40-60 min after
        // push) — until its first check-run the rollup is settling, never green.
        assert!(matches!(missing_post_deploy.verdict, MainVerdict::Settling), "got {:?}", missing_post_deploy.verdict);
        assert!(missing_post_deploy.settling.iter().any(|s| s.contains("post-deploy / Lodestar Storage Health") && s.contains("(awaiting first run)")));
        // required set matching NOTHING on the tip → Empty (a lane-config
        // defect, rendered loud by the Fix A BLOCKED line — never green)
        // BR#5674 P1 (empty-is-loud): distinguishes some-runs-none-matched vs zero-total-runs
        let phantom = classify_base_check_runs(&tip, &["ci / Never Runs".to_string()]);
        assert!(matches!(phantom.verdict, MainVerdict::Empty));
        assert_eq!(
            phantom.alarm.as_deref(),
            Some("5 runs read, none matched required set — check names/pagination")
        );
        let zero_runs = classify_base_check_runs(&[], &required);
        assert!(matches!(zero_runs.verdict, MainVerdict::Empty));
        assert_eq!(
            zero_runs.alarm.as_deref(),
            Some("tip carries no check runs at all")
        );
        let zero_unconfigured = classify_base_check_runs(&[], &[]);
        assert!(matches!(zero_unconfigured.verdict, MainVerdict::Empty));
        assert_eq!(
            zero_unconfigured.alarm.as_deref(),
            Some("tip carries no check runs at all")
        );
        // un-configured lane keeps the legacy whole-tip read (and no empty alarm)
        let legacy = classify_base_check_runs(&tip, &[]);
        assert!(matches!(legacy.verdict, MainVerdict::Red));
        assert!(legacy.alarm.is_none());
        assert!(scoped.alarm.is_none());
    }

    #[test]
    fn gate_qualifier_fires_when_scoped_green_but_repo_gate_judges_red_br5883() {
        // The 2026-11-03 starve shape (BR#5822 episode 2): tip is a MERGE
        // commit — the required `main-green gate` run is vacuous there
        // (BR#5847) — `Test`/`CLI build` are green, but the non-required
        // `Deploy drift alarm` FAILED. The scoped verdict must stay GREEN
        // (BR#5265 law: non-required reds never park the walk) while the
        // qualifier names exactly what the repo's own gate would report.
        let tip = [
            run(1, "Test", Some("success")),
            run(2, "CLI build (packages/cli)", Some("success")),
            run(3, "Deploy drift alarm", Some("failure")),
        ];
        let required: Vec<String> = vec!["Test".into(), "CLI build (packages/cli)".into(), "main-green gate".into()];
        let v = classify_base_check_runs(&tip, &required);
        assert!(matches!(v.verdict, MainVerdict::Green), "scoped verdict stays green: got {:?}", v.verdict);
        let gate = v.gate.expect("gate qualifier must ride a scoped-green tip the repo gate judges red");
        assert!(matches!(gate.verdict, MainVerdict::Red));
        assert_eq!(gate.red.len(), 1);
        assert_eq!(gate.red[0].name, "Deploy drift alarm");
        assert!(gate.unsettled.is_empty());
    }

    #[test]
    fn gate_qualifier_covers_unsettled_and_stays_silent_when_honest_br5883() {
        let required: Vec<String> = vec!["Test".into(), "main-green gate".into()];
        // gate verdict SETTLING (BR#14088): a tip check still in flight fails the
        // gate script too ("an in-flight main does not vouch for main") — the
        // in-flight class now reads Settling, never green; the qualifier still
        // fires (verdict != Green) and the name stays in the unsettled list.
        let v = classify_base_check_runs(
            &[run(1, "Test", Some("success")), run(2, "Deploy health (merge gate)", None)],
            &required,
        );
        assert!(matches!(v.verdict, MainVerdict::Green));
        let gate = v.gate.expect("in-flight non-required check fails the gate: qualifier must fire");
        assert!(matches!(gate.verdict, MainVerdict::Settling));
        assert_eq!(gate.unsettled, vec!["Deploy health (merge gate)"]);
        // fully green tip → NO qualifier (silence is the point)
        let v = classify_base_check_runs(
            &[run(1, "Test", Some("success")), run(2, "main-green gate", Some("success")), run(3, "Deploy drift alarm", Some("success"))],
            &required,
        );
        assert!(matches!(v.verdict, MainVerdict::Green));
        assert!(v.gate.is_none(), "a tip the gate judges green must not carry the qualifier");
        // scoped verdict RED → the verdict itself speaks; no qualifier
        let v = classify_base_check_runs(
            &[run(1, "Test", Some("failure")), run(2, "Deploy drift alarm", Some("failure"))],
            &required,
        );
        assert!(matches!(v.verdict, MainVerdict::Red));
        assert!(v.gate.is_none());
        // un-configured lane → the whole-tip read IS the gate verdict; no qualifier
        let v = classify_base_check_runs(&[run(1, "ci", Some("failure"))], &[]);
        assert!(matches!(v.verdict, MainVerdict::Red));
        assert!(v.gate.is_none());
    }

    // ---------- BR#14088: no green until settled — the post-admission smoke
    // window (settling state + required-completeness). The live shape:
    // superpositional main tip edfb114682 pushed 20:17Z; the Cortex Quality
    // Smoke job (INSIDE the required Deploy Dev workflow) settles LAST
    // (~50-60 min after admission) and its check-run carries conclusion=null
    // while in flight; every surface that read "0 failing checks" reported
    // green while the verdict was UNKNOWN. ----------

    /// BR#14088 helper: an IN-FLIGHT check run — queued/in_progress, no
    /// conclusion yet (GitHub files a conclusion only at completion).
    fn in_flight(id: i64, name: &str) -> MainCheckRun {
        MainCheckRun { id, source: CheckSource::Unknown, name: name.into(), status: Some("in_progress".into()), conclusion: None, html_url: None }
    }

    #[test]
    fn br14088_green_deploy_plus_in_flight_smoke_is_settling_never_green() {
        // THE evidence scenario: the deploy job settled green, the post-deploy
        // smoke inside the same workflow is still in flight. The rollup is
        // SETTLING — rendered amber, never green.
        let required: Vec<String> = vec!["deploy / Deploy to dev".into()];
        let v = classify_base_check_runs(
            &[run(1, "deploy / Deploy to dev", Some("success")), in_flight(2, "deploy / Deploy to dev")],
            &required,
        );
        assert!(matches!(v.verdict, MainVerdict::Settling), "got {:?}", v.verdict);
        assert!(v.settling.contains(&"deploy / Deploy to dev".to_string()));
        assert!(v.unsettled.contains(&"deploy / Deploy to dev".to_string()), "fold: list consumers keep naming the in-flight check");
        // same shape at the whole-tip level
        let m = classify_main_check_runs(&[run(1, "deploy / Deploy to dev", Some("success")), in_flight(2, "deploy / Deploy to dev")]);
        assert!(matches!(m.verdict, MainVerdict::Settling));
    }

    #[test]
    fn br14088_all_completed_green_certifies_green() {
        let required: Vec<String> = vec!["deploy / Deploy to dev".into()];
        let v = classify_base_check_runs(
            &[run(2, "deploy / Deploy to dev", Some("success")), run(1, "deploy / Deploy to dev", Some("failure"))],
            &required,
        );
        assert!(matches!(v.verdict, MainVerdict::Green), "newest attempt settled green: got {:?}", v.verdict);
    }

    #[test]
    fn br14088_missing_required_run_is_settling_not_green() {
        // The smoke starts LAST (~40-60 min after push): before its first
        // check-run exists the obligation is INVISIBLE to the old law — green
        // was certified with green < required.len(). Now: SETTLING.
        let required: Vec<String> = vec!["deploy / Deploy to dev".into(), "post-deploy / Cortex Quality Smoke".into()];
        let v = classify_base_check_runs(&[run(1, "deploy / Deploy to dev", Some("success"))], &required);
        assert!(matches!(v.verdict, MainVerdict::Settling), "got {:?}", v.verdict);
        assert!(v.settling.iter().any(|s| s.contains("post-deploy / Cortex Quality Smoke") && s.contains("(awaiting first run)")));
        // the vacuity class stays exempt (BR#5847): a structurally-absent
        // `main-green gate` on a merge-commit tip never blocks certification
        let bridge_required: Vec<String> = vec!["Test".into(), "main-green gate".into()];
        let v = classify_base_check_runs(&[run(1, "Test", Some("success"))], &bridge_required);
        assert!(matches!(v.verdict, MainVerdict::Green), "BR#5847 vacuous gate must not block green: got {:?}", v.verdict);
    }

    #[test]
    fn br14088_red_wins_over_settling() {
        let required: Vec<String> = vec!["deploy / Deploy to dev".into()];
        let v = classify_base_check_runs(
            &[run(1, "deploy / Deploy to dev", Some("failure")), in_flight(2, "post-deploy / Cortex Quality Smoke")],
            &required,
        );
        assert!(matches!(v.verdict, MainVerdict::Red), "red stops the line even while other checks settle: got {:?}", v.verdict);
        assert_eq!(v.red.len(), 1);
        assert!(v.red[0].name.contains("Deploy to dev"));
    }

    #[test]
    fn stale_main_green_gate_red_self_heals_on_a_gate_green_tip_br5883() {
        // The sibling defect (BR#5822 episode 2): the head car's gate red was
        // stamped 09:07:27Z against a transiently-unsettled `Test` on main;
        // main settled green 09:07:47Z and nothing re-ran the terminal
        // verdict. With base GREEN (scoped) AND the tip judging fully green
        // under the gate's own predicate (base_gate_green), the stale
        // conviction must re-run — never bounce, never a human leg.
        let head = [run(1, "Test", Some("success")), run(2, "main-green gate", Some("failure"))];
        let g = MainVerdict::Green;
        let commits = [(format!("{:040x}", 2), true)];
        let action = decide_train_gate(crate::train_gate::TrainGateInput {
            pr_number: 377,
            head_sha: &format!("{:040x}", 2),
            card_meta: &serde_json::json!({ "pr": { "repo": "state-vector/bridge", "number": 377, "head_sha_at_acceptance": format!("{:040x}", 2) } }),
            card_status: Some("blocked"),
            base_verdict: g.clone(),
            mergeable: Some(true),
            merge_state_status: Some("blocked".to_string()),
            commits: &commits,
            head_checks: &head,
            leg_number: Some(1),
            mechanical_move: None,
            root_fix: false,
            base_red_names: &[],
            base_gate_green: true,
            train_owned_branch: false,
        });
        match action {
            MergeAction::RerunGate { reason } => {
                assert!(reason.contains("main-green gate class"), "reason must name the class: {reason}");
                assert!(reason.contains("BR#5883"), "reason must cite the card: {reason}");
            }
            other => panic!("expected rerun_gate, got {:?}", other),
        }
        // The HONEST gate red: the tip still judges non-green (a real
        // `Deploy drift alarm` red sits on main) — NO self-heal; the entry
        // falls through to the standing blocked rows (queued card → Note).
        let action = decide_train_gate(crate::train_gate::TrainGateInput {
            pr_number: 377,
            head_sha: &format!("{:040x}", 2),
            card_meta: &serde_json::json!({ "pr": { "repo": "state-vector/bridge", "number": 377, "head_sha_at_acceptance": format!("{:040x}", 2) } }),
            card_status: Some("blocked"),
            base_verdict: g,
            mergeable: Some(true),
            merge_state_status: Some("blocked".to_string()),
            commits: &commits,
            head_checks: &head,
            leg_number: Some(1),
            mechanical_move: None,
            root_fix: false,
            base_red_names: &[],
            base_gate_green: false,
            train_owned_branch: false,
        });
        assert!(
            !matches!(action, MergeAction::RerunGate { .. }),
            "an honest gate conviction must not re-run against a red tip: got {:?}",
            action
        );
    }

    #[test]
    fn merge_action_order_is_the_law() {
        let ok = |n: i64| (format!("{n:040x}"), true);
        let g = MainVerdict::Green;
        // mergeable null → skip; false → bounce; state dirty → bounce
        assert!(matches!(
            decide_merge_action(1, &"a".repeat(40), None, &g, None, Some("clean"), &[ok(1)], &[], true, true),
            MergeAction::Skip { .. }
        ));
        assert!(matches!(
            decide_merge_action(1, &"a".repeat(40), None, &g, Some(false), Some("clean"), &[ok(1)], &[], true, true),
            MergeAction::Bounce { .. }
        ));
        assert!(matches!(
            decide_merge_action(1, &"a".repeat(40), None, &g, Some(true), Some("behind"), &[ok(1)], &[], true, true),
            MergeAction::Bounce { .. }
        ));
        // unsigned commit → human_leg; base not green → skip
        assert!(matches!(
            decide_merge_action(1, &"a".repeat(40), None, &g, Some(true), Some("clean"), &[("a".repeat(40), false)], &[], true, true),
            MergeAction::HumanLeg { .. }
        ));
        assert!(matches!(
            decide_merge_action(1, &"a".repeat(40), None, &MainVerdict::Red, Some(true), Some("clean"), &[ok(1)], &[], true, true),
            MergeAction::Skip { .. }
        ));
        // clean full pass → merge
        assert!(matches!(
            decide_merge_action(1, &"a".repeat(40), None, &g, Some(true), Some("clean"), &[ok(1)], &[run(1, "ci", Some("success"))], true, true),
            MergeAction::Merge { .. }
        ));
    }

    #[test]
    fn unknown_state_polls_never_bounces_br4685() {
        // BR#4685: an unanswered mergeStateStatus (null/""/UNKNOWN) is "not yet
        // computed" — UNKNOWN × N polls → no bounce event, whatever the
        // mergeable field reads (it rides the same async recomputation, so a
        // false read beside an unanswered state is a stale read, the
        // 2026-10-28 ledger class). A merge on an unconfirmed state is
        // equally off the table — the old null-state fall-through is closed.
        let ok = |n: i64| (format!("{n:040x}"), true);
        let g = MainVerdict::Green;
        for state in [None, Some(""), Some("unknown"), Some("UNKNOWN")] {
            for mergeable in [None, Some(true), Some(false)] {
                let a = decide_merge_action(281, &"a".repeat(40), None, &g, mergeable, state, &[ok(1)], &[], true, true);
                assert!(matches!(a, MergeAction::Skip { .. }), "state={state:?} mergeable={mergeable:?} must poll/wait, got {a:?}");
            }
        }
        // definitive states keep their rows: dirty conflict-bounces, blocked
        // gate-bounces (the answered world is unchanged)
        assert!(matches!(
            decide_merge_action(1, &"a".repeat(40), None, &g, Some(false), Some("dirty"), &[ok(1)], &[], true, true),
            MergeAction::Bounce { bounce_kind: BounceKind::Conflict, .. }
        ));
        assert!(matches!(
            decide_merge_action(1, &"a".repeat(40), None, &g, Some(true), Some("blocked"), &[ok(1)], &[], true, true),
            MergeAction::Bounce { bounce_kind: BounceKind::Gate, .. }
        ));
    }

    #[test]
    fn ledger_replay_2026_10_28_zero_null_state_bounces() {
        // Acceptance (BR#4685): the 2026-10-28 ledger replayed against this
        // gate yields zero null-state bounces. Rows lifted from train_events
        // (state-vector/bridge, seq 136-162, 2026-10-28T00:52Z→07:00Z): PRs
        // #279 (BR#4263) / #281 (BR#4282) bounced 28× with
        // merge_state_status:null — every "CONFLICTING" row of the loop
        // trial-merged CLEAN (conflict_files: []), i.e. stale mergeability
        // reads while GitHub recomputed after base merges.
        let g = MainVerdict::Green;
        let sha279 = "1bb7e4670e2a21420528ee9d1b154658afb69d02";
        let sha281 = "9391ea4a9822c01dc40cd021dac25b3d8877c0e2";
        let rows: [(i64, &str, Option<bool>, Option<&str>); 4] = [
            (281, sha281, Some(false), None), // seq 157: "unmergeable — CONFLICTING", null state, clean trial
            (279, sha279, Some(false), None), // seq 159: same class
            (279, sha279, Some(true), None),  // seq 162: gate bounce, null state stamp
            (281, sha281, Some(true), None),  // the old fail-open: green-but-unanswered used to MERGE
        ];
        for (pr, sha, mergeable, state) in rows {
            let a = decide_merge_action(pr, sha, None, &g, mergeable, state, &[(sha.to_string(), true)], &[], true, true);
            assert!(matches!(a, MergeAction::Skip { .. }), "ledger row PR #{pr} (mergeable={mergeable:?}, state={state:?}) must poll/wait, got {a:?}");
        }
        // control: the same PR with a DEFINITIVE dirty state still bounces —
        // the fix narrows to the unanswered class; real defects stay defects.
        assert!(matches!(
            decide_merge_action(281, sha281, None, &g, Some(false), Some("dirty"), &[(sha281.to_string(), true)], &[], true, true),
            MergeAction::Bounce { bounce_kind: BounceKind::Conflict, .. }
        ));
    }

    #[test]
    fn carry_chain_prefix_coverage() {
        let stamp = "aaaaaaa";
        let full = format!("{stamp}{}", "b".repeat(33));
        assert!(head_covered_by(stamp, None, &full)); // prefix-compat is symmetric (TS 1250)
        assert!(head_covered_by(&full, None, stamp)); // startsWith both directions, per TS
        let carry = serde_json::json!([{ "from_head": "aaaaaaa", "to_head": "ccccccc", "prior_verdict_id": null, "carried_ts": 0, "via": "update-branch" }]);
        assert!(head_covered_by(stamp, Some(&carry), "ccccccc"));
        assert!(!head_covered_by(stamp, Some(&carry), "ddddddd")); // break = uncovered
        assert!(!head_covered_by("zzz", None, "aaaaaaa")); // non-sha → fail-closed
    }

    #[test]
    fn train_gate_leg_coverage_bounces_verbatim() {
        let meta = serde_json::json!({ "pr": { "repo": "state-vector/bridge", "number": 7, "head_sha_at_acceptance": "1234567890" } });
        let head = "9999999aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let gate = decide_train_gate(TrainGateInput {
            pr_number: 7,
            head_sha: head,
            card_meta: &meta,
            card_status: Some("in_review"),
            base_verdict: MainVerdict::Green,
            mergeable: Some(true),
            merge_state_status: Some("clean".into()),
            commits: &[(head.into(), true)],
            head_checks: &[],
            leg_number: Some(1),
            mechanical_move: None,
            root_fix: false,
            base_red_names: &[],
            base_gate_green: false,
            train_owned_branch: false,
        });
        match gate {
            MergeAction::Bounce { defect, bounce_kind } => {
                assert_eq!(
                    defect,
                    format!(
                        "PR #7 live head {h} is not covered by the accepted verdict (leg 1 stamped 123456789, no contiguous carry chain) — head moved past the verdict without a machine-clean update; re-verify at the new head",
                        h = &head[..9]
                    )
                );
                // the bounce NAMES its kind (BR#4066): a coverage bounce — the
                // hub's brief must not render conflict language for it
                assert_eq!(bounce_kind, BounceKind::Coverage);
            }
            other => panic!("expected bounce, got {other:?}"),
        }
    }

    // ---- BR#4689 L1.4: mechanical head moves carry by default ----

    #[test]
    fn mechanical_carry_is_the_default_path_for_a_rebase_only_head_move() {
        let meta = serde_json::json!({ "pr": { "repo": "r", "number": 7, "head_sha_at_acceptance": "aaaaaaaaa" } });
        let new_head = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let gate = decide_train_gate(TrainGateInput {
            pr_number: 7,
            head_sha: new_head,
            card_meta: &meta,
            card_status: Some("blocked"),
            base_verdict: MainVerdict::Green,
            mergeable: Some(true),
            merge_state_status: Some("clean".into()),
            commits: &[(new_head.into(), true)],
            head_checks: &[run(1, "ci", Some("success"))],
            leg_number: Some(1),
            mechanical_move: Some(MechanicalMove {
                from_head: "aaaaaaaaa".into(),
                to_head: new_head.into(),
                evidence: "git range-diff aaaaaaaaa...bbbbbbbbb — 2 patch-id pairs, all '='".into(),
            }),
            root_fix: false,
            base_red_names: &[],
            base_gate_green: false,
            train_owned_branch: false,
        });
        match gate {
            MergeAction::Carry { from_head, to_head, evidence, receipt } => {
                assert_eq!(from_head, "aaaaaaaaa");
                assert_eq!(to_head, new_head);
                assert!(evidence.contains("all '='"));
                assert!(receipt.contains("BR#4689") && receipt.contains("same patch-ids"));
            }
            other => panic!("expected carry, got {other:?}"),
        }
    }

    #[test]
    fn a_content_change_still_bounces_even_with_proof_claims() {
        let meta = serde_json::json!({ "pr": { "repo": "r", "number": 7, "head_sha_at_acceptance": "aaaaaaaaa" } });
        let new_head = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        // the proof's to_head doesn't match the live head — no carry
        let gate = decide_train_gate(TrainGateInput {
            pr_number: 7,
            head_sha: new_head,
            card_meta: &meta,
            card_status: Some("blocked"),
            base_verdict: MainVerdict::Green,
            mergeable: Some(true),
            merge_state_status: Some("clean".into()),
            commits: &[(new_head.into(), true)],
            head_checks: &[run(1, "ci", Some("success"))],
            leg_number: Some(1),
            mechanical_move: Some(MechanicalMove {
                from_head: "aaaaaaaaa".into(),
                to_head: "cccccccccccccccccccccccccccccccccccccccc".into(),
                evidence: "stale proof".into(),
            }),
            root_fix: false,
            base_red_names: &[],
            base_gate_green: false,
            train_owned_branch: false,
        });
        assert!(matches!(gate, MergeAction::Bounce { bounce_kind: BounceKind::Coverage, .. }));
        // no proof at all — the unchanged fail-closed bounce
        let gate = decide_train_gate(TrainGateInput {
            pr_number: 7,
            head_sha: new_head,
            card_meta: &meta,
            card_status: Some("blocked"),
            base_verdict: MainVerdict::Green,
            mergeable: Some(true),
            merge_state_status: Some("clean".into()),
            commits: &[(new_head.into(), true)],
            head_checks: &[run(1, "ci", Some("success"))],
            leg_number: Some(1),
            mechanical_move: None,
            root_fix: false,
            base_red_names: &[],
            base_gate_green: false,
            train_owned_branch: false,
        });
        assert!(matches!(gate, MergeAction::Bounce { bounce_kind: BounceKind::Coverage, .. }));
    }

    #[test]
    fn a_carry_must_extend_the_chain_tip_and_a_broken_chain_cannot_be_extended() {
        // an existing chain a→c: the tip is c — a proof claiming from=a skips
        // a link and is refused (bounce), a proof from=c carries
        let meta = serde_json::json!({ "pr": { "repo": "r", "number": 7, "head_sha_at_acceptance": "aaaaaaaaa", "carry": [
            { "from_head": "aaaaaaaaa", "to_head": "ccccccccc", "prior_verdict_id": null, "carried_ts": 1, "via": "update-branch" }
        ] } });
        let new_head = "dddddddddddddddddddddddddddddddddddddddd";
        let gate_for = |from_head: &str| {
            decide_train_gate(TrainGateInput {
                pr_number: 7,
                head_sha: new_head,
                card_meta: &meta,
                card_status: Some("blocked"),
                base_verdict: MainVerdict::Green,
                mergeable: Some(true),
                merge_state_status: Some("clean".into()),
                commits: &[(new_head.into(), true)],
                head_checks: &[run(1, "ci", Some("success"))],
                leg_number: Some(1),
                mechanical_move: Some(MechanicalMove {
                    from_head: from_head.into(),
                    to_head: new_head.into(),
                    evidence: "range-diff all '='".into(),
                }),
                root_fix: false,
                base_red_names: &[],
                base_gate_green: false,
                train_owned_branch: false,
            })
        };
        assert!(matches!(gate_for("ccccccccc"), MergeAction::Carry { .. }));
        assert!(matches!(gate_for("aaaaaaaaa"), MergeAction::Bounce { .. }));
        // a BROKEN chain (second record starts off-chain) yields no tip —
        // it can never be covered by extension, so even a fresh proof bounces
        let broken = serde_json::json!({ "pr": { "repo": "r", "number": 7, "head_sha_at_acceptance": "aaaaaaaaa", "carry": [
            { "from_head": "aaaaaaaaa", "to_head": "ccccccccc", "prior_verdict_id": null, "carried_ts": 1, "via": "update-branch" },
            { "from_head": "eeeeeeeee", "to_head": "fffffffff", "prior_verdict_id": null, "carried_ts": 2, "via": "update-branch" }
        ] } });
        let gate = decide_train_gate(TrainGateInput {
            pr_number: 7,
            head_sha: new_head,
            card_meta: &broken,
            card_status: Some("blocked"),
            base_verdict: MainVerdict::Green,
            mergeable: Some(true),
            merge_state_status: Some("clean".into()),
            commits: &[(new_head.into(), true)],
            head_checks: &[run(1, "ci", Some("success"))],
            leg_number: Some(1),
            mechanical_move: Some(MechanicalMove {
                from_head: "ccccccccc".into(),
                to_head: new_head.into(),
                evidence: "range-diff all '='".into(),
            }),
            root_fix: false,
            base_red_names: &[],
            base_gate_green: false,
            train_owned_branch: false,
        });
        assert!(matches!(gate, MergeAction::Bounce { bounce_kind: BounceKind::Coverage, .. }));
    }

    #[test]
    fn carry_chain_tip_walks_contiguous_and_refuses_breaks() {
        assert_eq!(carry_chain_tip("aaaaaaaaa", None).as_deref(), Some("aaaaaaaaa"));
        let one = serde_json::json!([{ "from_head": "aaaaaaaaa", "to_head": "ccccccccc" }]);
        assert_eq!(carry_chain_tip("aaaaaaaaa", Some(&one)).as_deref(), Some("ccccccccc"));
        let broken = serde_json::json!([{ "from_head": "aaaaaaaaa", "to_head": "ccccccccc" }, { "from_head": "ddddddddd", "to_head": "eeeeeeeee" }]);
        assert_eq!(carry_chain_tip("aaaaaaaaa", Some(&broken)), None); // break → not extensible
        assert_eq!(carry_chain_tip("zzz", None), None); // non-sha stamp → None
    }

    #[test]
    fn queued_stale_verdict_head_bounces_too_br5114() {
        // BR#5114 round 2 (Ray: "if it can't merge, bounce it and move onto
        // the next one"): a QUEUED (blocked) card whose accepted verdict no
        // longer covers the live head bounces — the old in_review-only law
        // Skipped it silently every tick, freezing the lane behind an
        // invisible head (superpositional@main: 64 min of ledger silence).
        let meta = serde_json::json!({ "pr": { "repo": "state-vector/superpositional", "number": 2458, "head_sha_at_acceptance": "1234567890" } });
        let head = "8888888aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let gate = decide_train_gate(TrainGateInput {
            pr_number: 2458,
            head_sha: head,
            card_meta: &meta,
            card_status: Some("blocked"),
            base_verdict: MainVerdict::Green,
            mergeable: Some(true),
            merge_state_status: Some("clean".into()),
            commits: &[(head.into(), true)],
            head_checks: &[],
            leg_number: Some(1),
            mechanical_move: None,
            root_fix: false,
            base_red_names: &[],
            base_gate_green: false,
            train_owned_branch: false,
        });
        match gate {
            MergeAction::Bounce { bounce_kind, .. } => assert_eq!(bounce_kind, BounceKind::Coverage),
            other => panic!("expected coverage bounce for a queued stale-verdict head, got {other:?}"),
        }
    }

    #[test]
    fn behind_pre_clears_at_the_train_gate_br3727() {
        // mirrored from merge-train.test.ts: uppercase behind PRE-CLEARS at
        // the train gate — the §5 carry is reachable (the shared
        // decide_merge_action still bounces behind; the sweep owns that)
        let meta = serde_json::json!({ "pr": { "repo": "state-vector/bridge", "number": 4700, "head_sha_at_acceptance": "ccccccccc" } });
        let head = "c".repeat(40);
        let checks = [run(1, "ci", Some("success"))];
        let gate = decide_train_gate(TrainGateInput {
            pr_number: 4700,
            head_sha: &head,
            card_meta: &meta,
            card_status: Some("blocked"),
            base_verdict: MainVerdict::Green,
            mergeable: Some(true),
            merge_state_status: Some("BEHIND".into()),
            commits: &[(head.clone(), true)],
            head_checks: &checks,
            leg_number: Some(1),
            mechanical_move: None,
            root_fix: false,
            base_red_names: &[],
            base_gate_green: false,
            train_owned_branch: true,
        });
        match gate {
            MergeAction::Merge { receipt } => {
                assert!(receipt.contains("behind pre-cleared"), "receipt: {receipt}");
                assert!(receipt.contains("BR#3516 §5"), "receipt: {receipt}");
            }
            other => panic!("expected merge, got {other:?}"),
        }
    }

    #[test]
    fn blocked_pending_is_a_clock_blocked_red_notes_br3727() {
        // mirrored from merge-train.test.ts: strict protection re-runs the
        // required checks on the head after every machine-clean update-branch
        let meta = serde_json::json!({ "pr": { "repo": "state-vector/bridge", "number": 4700, "head_sha_at_acceptance": "ccccccccc" } });
        let head = "c".repeat(40);
        let commits = [(head.clone(), true)];
        // pending (in-flight required check) → skip this tick, never a bounce
        let pending = [run(1, "ci", Some("success")), run(2, "lint", None)];
        let gate = decide_train_gate(TrainGateInput {
            pr_number: 4700,
            head_sha: &head,
            card_meta: &meta,
            card_status: Some("blocked"),
            base_verdict: MainVerdict::Green,
            mergeable: Some(true),
            merge_state_status: Some("blocked".into()),
            commits: &commits,
            head_checks: &pending,
            leg_number: Some(1),
            mechanical_move: None,
            root_fix: false,
            base_red_names: &[],
            base_gate_green: false,
            train_owned_branch: false,
        });
        match gate {
            MergeAction::Skip { reason } => {
                assert!(reason.contains("mergeStateStatus=blocked"), "reason: {reason}");
                assert!(reason.contains("pending, not a defect"), "reason: {reason}");
            }
            other => panic!("expected skip, got {other:?}"),
        }
        // red → note (the shared law's own non-in_review row)
        let red = [run(1, "ci", Some("failure"))];
        let gate = decide_train_gate(TrainGateInput {
            pr_number: 4700,
            head_sha: &head,
            card_meta: &meta,
            card_status: Some("blocked"),
            base_verdict: MainVerdict::Green,
            mergeable: Some(true),
            merge_state_status: Some("blocked".into()),
            commits: &commits,
            head_checks: &red,
            leg_number: Some(1),
            mechanical_move: None,
            root_fix: false,
            base_red_names: &[],
            base_gate_green: false,
            train_owned_branch: false,
        });
        match gate {
            MergeAction::Note { reason } => assert!(reason.contains("head check RED"), "reason: {reason}"),
            other => panic!("expected note, got {other:?}"),
        }
    }

    #[test]
    fn blocked_green_verdict_does_not_override_github_admission_br6776() {
        // Substance approval is not evidence of GitHub branch admission.
        let meta = serde_json::json!({ "pr": { "repo": "state-vector/bridge", "number": 4700, "head_sha_at_acceptance": "ccccccccc" } });
        let head = "c".repeat(40);
        let checks = [run(1, "ci", Some("success"))];
        let gate = decide_train_gate(TrainGateInput {
            pr_number: 4700,
            head_sha: &head,
            card_meta: &meta,
            card_status: Some("blocked"),
            base_verdict: MainVerdict::Green,
            mergeable: Some(true),
            merge_state_status: Some("blocked".into()),
            commits: &[(head.clone(), true)],
            head_checks: &checks,
            leg_number: Some(1),
            mechanical_move: None,
            root_fix: false,
            base_red_names: &[],
            base_gate_green: false,
            train_owned_branch: false,
        });
        match gate {
            MergeAction::Note { reason } => assert!(reason.contains("GitHub branch policy remains BLOCKED")),
            other => panic!("expected policy reconciliation, got {other:?}"),
        }
    }

    #[test]
    fn shared_law_names_the_br_verdict_not_reapprove_br4633_l4_2() {
        // mirrored from merge-train.test.ts: decide_merge_action's blocked
        // bounce names the BR verdict as the approval of record — the old
        // "re-approve" posture is gone (byte-identical TS↔Rust wording)
        let head = "c".repeat(40);
        let g = MainVerdict::Green;
        let checks = [run(1, "ci", Some("success"))];
        let gate = decide_merge_action(4701, &head, Some("blocked"), &g, Some(true), Some("blocked"), &[(head.clone(), true)], &checks, true, true);
        match gate {
            MergeAction::Bounce { defect, bounce_kind } => {
                assert_eq!(bounce_kind, BounceKind::Gate);
                assert!(defect.contains("approval of record"), "defect: {defect}");
                assert!(defect.contains("BR#4633 L4.2"), "defect: {defect}");
                assert!(!defect.contains("re-approve)"), "defect: {defect}");
            }
            other => panic!("expected bounce, got {other:?}"),
        }
    }

    #[test]
    fn bounce_event_kind_refines_conflict_by_trial_merge_truth() {
        use BounceKind::{Conflict, Coverage, Gate};
        // gate said conflict + dirty trial merge with files → a real conflict
        assert_eq!(bounce_event_kind(&Conflict, false, 3), "conflict");
        // gate said conflict but the trial merge is CLEAN → a stale GitHub
        // mergeable read (BR#3712 class) — lands as gate, never a file-less
        // conflict (the hub fail-louds on those)
        assert_eq!(bounce_event_kind(&Conflict, true, 0), "gate");
        assert_eq!(bounce_event_kind(&Conflict, false, 0), "gate");
        // coverage and gate pass through untouched — neither trial-merges
        assert_eq!(bounce_event_kind(&Coverage, true, 0), "coverage");
        assert_eq!(bounce_event_kind(&Gate, true, 0), "gate");
    }

    #[test]
    fn train_gate_full_pass_receipt_cites_leg() {
        let head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let meta = serde_json::json!({ "prs": [ { "repo": "r", "number": 7, "head_sha_at_acceptance": head } ] });
        let gate = decide_train_gate(TrainGateInput {
            pr_number: 7,
            head_sha: head,
            card_meta: &meta,
            card_status: Some("in_review"),
            base_verdict: MainVerdict::Green,
            mergeable: Some(true),
            merge_state_status: Some("clean".into()),
            commits: &[(head.into(), true)],
            head_checks: &[run(1, "ci", Some("success"))],
            leg_number: Some(1),
            mechanical_move: None,
            root_fix: false,
            base_red_names: &[],
            base_gate_green: false,
            train_owned_branch: false,
        });
        match gate {
            MergeAction::Merge { receipt } => assert!(receipt.contains("leg 1/1") && receipt.contains("BR#3516")),
            other => panic!("expected merge, got {other:?}"),
        }
    }

    #[test]
    fn legs_legacy_and_multi() {
        let legacy = serde_json::json!({ "pr": { "repo": "r", "number": 3, "head_sha_at_acceptance": "a" } });
        assert_eq!(train_legs(&legacy).len(), 1);
        let multi = serde_json::json!({ "prs": [ { "repo": "r", "number": 1 }, { "repo": "r2", "number": 2 } ] });
        assert_eq!(train_legs(&multi).len(), 2);
        assert!(train_legs(&serde_json::json!({})).is_empty());
        let landed = serde_json::json!({ "prs": [ { "repo": "r", "number": 1 } ], "merge_train": { "legs": { "1": { "state": "landed" } } } });
        assert!(train_leg_landed(&landed, &TrainLeg { repo: "r".into(), number: 1, head_sha_at_acceptance: None, base: None, carry: None }));
        let leg = TrainLeg { repo: "r".into(), number: 1, head_sha_at_acceptance: None, base: None, carry: None };
        let parked = serde_json::json!({ "prs": [ { "repo": "r", "number": 1 } ], "merge_train": { "legs": { "1": { "state": "awaiting-ci" } }, "state": "landed" } });
        assert_eq!(train_leg_state(&parked, &leg), Some("awaiting-ci"));
        let card_level = serde_json::json!({ "pr": { "repo": "r", "number": 2 }, "merge_train": { "state": "awaiting-ci" } });
        assert_eq!(train_leg_state(&card_level, &TrainLeg { repo: "r".into(), number: 2, head_sha_at_acceptance: None, base: None, carry: None }), Some("awaiting-ci"));
        assert_eq!(train_leg_state(&landed, &leg), Some("landed"));
        assert_eq!(train_leg_state(&serde_json::json!({}), &leg), None);
    }

    #[test]
    fn normalizers_at_the_fact_boundary() {
        assert_eq!(normalize_gh_mergeable(&serde_json::json!("MERGEABLE")), Some(true));
        assert_eq!(normalize_gh_mergeable(&serde_json::json!("CONFLICTING")), Some(false));
        assert_eq!(normalize_gh_mergeable(&serde_json::json!("UNKNOWN")), None);
        assert_eq!(normalize_gh_mergeable(&serde_json::json!(true)), Some(true));
        assert_eq!(normalize_gh_merge_state(&serde_json::json!("CLEAN")), Some("clean".into()));
        assert_eq!(normalize_gh_merge_state(&serde_json::json!(null)), None);
    }

    #[test]
    fn human_leg_title_contract() {
        let t = merge_sweep_human_leg_title("state-vector/bridge", &["unsigned commits".into()]);
        assert!(t.ends_with("?") && t.len() <= 240 && t.starts_with("Merge sweep human legs on state-vector/bridge: "));
    }

    // ---------- BR#3727 port mirrors (TS decideTrainGate 1953-1997) ----------

    fn gate_input<'a>(
        meta: &'a serde_json::Value,
        merge_state: Option<&'a str>,
        head_checks: &'a [MainCheckRun],
    ) -> TrainGateInput<'a> {
        let head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let commits: &'a [(String, bool)] = Box::leak(vec![(head.to_string(), true)].into_boxed_slice());
        // the executor normalizes gh's uppercase shapes at the boundary (the TS
        // tests' gh() helper does the same via normalizeGhMergeState)
        let merge_state_status = merge_state.and_then(|s| normalize_gh_merge_state(&serde_json::json!(s)));
        TrainGateInput {
            pr_number: 7,
            head_sha: head,
            card_meta: meta,
            card_status: Some("in_review"),
            base_verdict: MainVerdict::Green,
            mergeable: Some(true),
            merge_state_status,
            commits,
            head_checks,
            leg_number: Some(1),
            mechanical_move: None,
            root_fix: false,
            base_red_names: &[],
            base_gate_green: false,
            train_owned_branch: true,
        }
    }

    // ---- BR#4687 (L1.2): the provenance-gated behind pre-clear + the
    // BR#3727 blocked rows, one row per gate input ----

    #[cfg(test)]
    fn gate_input_provenance<'a>(
        head: &'a str,
        meta: &'a Value,
        status: Option<&'a str>,
        state: Option<&str>,
        checks: &'a [MainCheckRun],
        commits: &'a [(String, bool)],
        owned: bool,
    ) -> TrainGateInput<'a> {
        TrainGateInput {
            pr_number: 7,
            head_sha: head,
            card_meta: meta,
            card_status: status,
            base_verdict: MainVerdict::Green,
            mergeable: Some(true),
            merge_state_status: state.map(String::from),
            commits,
            head_checks: checks,
            leg_number: Some(1),
            mechanical_move: None,
            train_owned_branch: owned,
            root_fix: false,
            base_red_names: &[],
            base_gate_green: false,
        }
    }

    #[test]
    fn train_gate_behind_preclear_receipts_byte_identical() {
        let head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let meta = serde_json::json!({ "prs": [ { "repo": "r", "number": 7, "head_sha_at_acceptance": head } ] });
        // BEHIND uppercase → normalized, pre-cleared, merge carries (BR#4687:
        // the receipt names the worker-authored branch provenance)
        let gate = decide_train_gate(gate_input(&meta, Some("BEHIND"), &[run(1, "ci", Some("success"))]));
        match gate {
            MergeAction::Merge { receipt } => assert!(receipt.contains(
                "5c gate pass (mergeable, behind pre-cleared — worker-authored branch, the merge leg's machine-clean update-branch carries the verdict (BR#3516 §5, BR#4687), 1 verified commits)"
            )),
            other => panic!("expected merge, got {other:?}"),
        }
        // clean → the legacy receipt wording
        let gate = decide_train_gate(gate_input(&meta, Some("CLEAN"), &[run(1, "ci", Some("success"))]));
        match gate {
            MergeAction::Merge { receipt } => {
                assert!(receipt.contains("5c gate pass (mergeable, clean, 1 verified commits)"));
                assert!(!receipt.contains("behind pre-cleared"));
            }
            other => panic!("expected merge, got {other:?}"),
        }
    }

    #[test]
    fn train_gate_behind_worker_authored_preclears_to_merge() {
        let head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let meta = serde_json::json!({ "prs": [ { "repo": "r", "number": 7, "head_sha_at_acceptance": head } ] });
        let gate = decide_train_gate(gate_input_provenance(head, &meta, Some("in_review"), Some("behind"), &[run(1, "ci", Some("success"))], &[(head.to_string(), true)], true));
        match gate {
            MergeAction::Merge { receipt } => {
                assert!(receipt.contains("behind pre-cleared"), "receipt: {receipt}");
                assert!(receipt.contains("BR#4687"), "receipt: {receipt}");
            }
            other => panic!("expected merge with pre-clear, got {other:?}"),
        }
    }

    #[test]
    fn train_gate_blocked_pending_is_a_clock_not_a_defect() {
        let head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let meta = serde_json::json!({ "prs": [ { "repo": "r", "number": 7, "head_sha_at_acceptance": head } ] });
        // blocked + pending head checks → skip this tick, exact TS wording
        let gate = decide_train_gate(gate_input(&meta, Some("BLOCKED"), &[run(1, "ci", None)]));
        match gate {
            MergeAction::Skip { reason } => assert_eq!(
                reason,
                "PR #7 mergeStateStatus=blocked — required checks re-running on head aaaaaaaaa (ci) — pending, not a defect; next tick"
            ),
            other => panic!("expected skip, got {other:?}"),
        }
        // blocked + RED head check on a non-in_review card → note, no bounce
        let gate = decide_train_gate(gate_input(&meta, Some("blocked"), &[run(1, "ci", Some("failure"))]));
        match gate {
            MergeAction::Note { reason } => assert_eq!(
                reason,
                "PR #7 head check RED: ci — card queued (not in_review), no bounce; the linked session owns it"
            ),
            other => panic!("expected note, got {other:?}"),
        }
        // blocked + GREEN head checks: BR#3727's "the shared law's bounce stands"
        // posture is SUPERSEDED by BR#4633 L4.2 — blocked+green now pre-clears and
        // MERGES (the BR verify verdict is the approval of record). That posture is
        // pinned by `blocked_green_verdict_anchor_merges_br4633_l4_2` above; the old
        // Gate-bounce leg was removed with the superseded law.
    }

    // ---------- burst-drain law mirrors (BR#4934) ----------

    #[test]
    fn drain_burst_decision_law() {
        use DrainDecision::{Drain, Settle, Stop};
        // clean heads remain, cap not reached → drain back-to-back
        assert_eq!(drain_burst_decision(0, 10, true, false), Drain);
        assert_eq!(drain_burst_decision(9, 10, true, false), Drain);
        // cap reached → settle on the final merge
        assert_eq!(drain_burst_decision(10, 10, true, false), Settle);
        // queue empty of clean heads → settle even below cap
        assert_eq!(drain_burst_decision(3, 10, false, false), Settle);
        // cap 0 = unlimited → keep draining
        assert_eq!(drain_burst_decision(500, 0, true, false), Drain);
        // red seen stops the line immediately — never waits for the settle
        assert_eq!(drain_burst_decision(0, 10, true, true), Stop);
        assert_eq!(drain_burst_decision(0, 10, false, true), Stop);
    }

    #[test]
    fn parse_burst_max_defaults_and_unlimited() {
        assert_eq!(parse_burst_max(&serde_json::json!(null)), DEFAULT_BURST_MAX);
        assert_eq!(parse_burst_max(&serde_json::json!(7)), 7);
        assert_eq!(parse_burst_max(&serde_json::json!(0)), 0); // unlimited
        assert_eq!(parse_burst_max(&serde_json::json!("ten")), DEFAULT_BURST_MAX); // junk → default
        assert_eq!(parse_burst_max(&serde_json::json!(-3)), DEFAULT_BURST_MAX);
        assert_eq!(parse_burst_max(&serde_json::json!(4294967295u64)), u32::MAX);
    }

    #[test]
    fn first_red_index_walks_oldest_first() {
        assert_eq!(first_red_index(&[false, false, true, false]), Some(2));
        assert_eq!(first_red_index(&[false, false]), None);
        assert_eq!(first_red_index(&[]), None);
        assert_eq!(first_red_index(&[true]), Some(0));
    }

    #[test]
    fn select_batch_skips_conflicting_members_greedily() {
        // 0 conflicts with 2: the batch is [0, 1]; 2 waits for the next pass
        assert_eq!(select_batch(&[true, true, true], &[(0, 2)], 0), vec![0, 1]);
        // chain 0+1 conflict, 1+2 conflict: only 1 is skipped — [0, 2] land
        // together (conflicts are checked against SELECTED heads only)
        assert_eq!(select_batch(&[true, true, true], &[(0, 1), (1, 2)], 0), vec![0, 2]);
        // both pair orientations are checked: (2, 0) is the same conflict
        assert_eq!(select_batch(&[true, true, true], &[(2, 0)], 0), vec![0, 1]);
    }

    #[test]
    fn select_batch_cap_binds_and_zero_is_unlimited() {
        assert_eq!(select_batch(&[true, true, true], &[], 2), vec![0, 1]);
        assert_eq!(select_batch(&[true, true, true], &[], 0), vec![0, 1, 2]);
        assert_eq!(select_batch(&[true], &[], 0), vec![0]);
        assert_eq!(select_batch(&[], &[], 0), Vec::<usize>::new());
    }

    #[test]
    fn select_batch_fail_closed_not_known_clean_excludes_just_that_member() {
        assert_eq!(select_batch(&[false, true, true], &[], 0), vec![1, 2]);
        assert_eq!(select_batch(&[false, false, false], &[], 0), Vec::<usize>::new());
        // an excluded member shields nothing: conflicts are vs SELECTED only
        assert_eq!(select_batch(&[false, true], &[(0, 1)], 0), vec![1]);
    }

    #[test]
    fn conflicts_from_file_sets_pairwise_intersection() {
        let sets: Vec<FileSet> = vec![
            ["a.rs", "b.ts"].iter().map(|s| s.to_string()).collect(),
            ["c.rs"].iter().map(|s| s.to_string()).collect(),
            ["b.ts", "d.md"].iter().map(|s| s.to_string()).collect(),
        ];
        assert_eq!(conflicts_from_file_sets(&sets), vec![(0, 2)]);
        let disjoint: Vec<FileSet> = vec![
            ["a.rs"].iter().map(|s| s.to_string()).collect(),
            ["b.rs"].iter().map(|s| s.to_string()).collect(),
        ];
        assert!(conflicts_from_file_sets(&disjoint).is_empty());
        // an empty set (no files changed) conflicts with nothing
        let with_empty: Vec<FileSet> = vec![FileSet::new(), ["a.rs"].iter().map(|s| s.to_string()).collect()];
        assert!(conflicts_from_file_sets(&with_empty).is_empty());
    }

    // ---------- BR#5190 root-fix fast lane ----------

    fn root_fix_row(head: &str) -> serde_json::Value {
        // the WHOLE card row as the executor's get_artefact sees it (tags are a
        // row column, the binding nests under meta)
        serde_json::json!({
            "tags": ["root_blocker", "main-red", "p0"],
            "meta": {
                "root_fix": { "repo": "o/r", "head_sha": "deadbeef0000" },
                "prs": [ { "repo": "o/r", "number": 339, "head_sha_at_acceptance": head } ],
            },
        })
    }

    fn root_fix_meta(head: &str) -> serde_json::Value {
        // the card META as the gate receives it (card_meta)
        serde_json::json!({
            "root_fix": { "repo": "o/r", "head_sha": "deadbeef0000" },
            "prs": [ { "repo": "o/r", "number": 339, "head_sha_at_acceptance": head } ],
        })
    }

    #[test]
    fn root_fix_qualification_needs_tags_and_binding() {
        let head = "cccccccccccccccccccccccccccccccccccccccc";
        assert!(is_root_fix_card(&root_fix_row(head)));
        // tags without a binding never qualify
        assert!(!is_root_fix_card(&serde_json::json!({ "tags": ["root_blocker", "main-red"], "meta": { "root_fix": {} } })));
        // binding without tags never qualifies
        assert!(!is_root_fix_card(&serde_json::json!({ "meta": { "root_fix": { "repo": "o/r", "head_sha": "deadbeef0000" } } })));
        // empty binding halves never qualify
        assert!(!is_root_fix_card(&serde_json::json!({ "tags": ["root_blocker", "main-red"], "meta": { "root_fix": { "repo": "o/r", "head_sha": "" } } })));
        // tag match is case-insensitive (the executor sees gh/board casing)
        assert!(is_root_fix_card(&serde_json::json!({ "tags": ["ROOT_BLOCKER", "Main-Red"], "meta": { "root_fix": { "repo": "o/r", "head_sha": "d" } } })));
        // BR#14075: the documented main-red synonyms qualify — deploy-red /
        // deploy_red with a meta root-side marker and a bound run
        assert!(is_root_fix_card(&serde_json::json!({ "tags": ["deploy-red"], "meta": { "root_fix": { "repo": "o/r", "head_sha": "d" }, "root_blocker_for_lane": "o/r@main" } })));
        assert!(is_root_fix_card(&serde_json::json!({ "tags": ["deploy_red"], "meta": { "root_fix": { "repo": "o/r", "head_sha": "d" }, "root_blocker": "BR#1234" } })));
        // BR#14075 no-gaming: fake tags without a binding never rank up
        assert!(!is_root_fix_card(&serde_json::json!({ "tags": ["root_blocker", "main-red", "deploy-red"], "meta": {} })));
    }

    #[test]
    fn root_fix_fast_lane_title_contract() {
        let t = root_fix_fast_lane_title("state-vector/bridge", 339);
        assert!(t.ends_with("?") && t.len() <= 240);
        assert!(t.starts_with("Root-fix fast lane (BR#5189): merge state-vector/bridge PR #339"));
        // byte-identity with the TS mirror is pinned on the core side by the
        // shared wording here; ask-dedupe keys on exact wording
        assert_eq!(
            t,
            "Root-fix fast lane (BR#5189): merge state-vector/bridge PR #339 now? Main is red on the exact red this PR cures — the train cannot merge it while the line it fixes is stopped; one click merges the cure?"
        );
    }

    #[test]
    fn base_red_head_green_root_fix_merges_fast_tracked() {
        let head = "cccccccccccccccccccccccccccccccccccccccc";
        let meta = root_fix_meta(head);
        let gate = decide_train_gate(TrainGateInput {
            pr_number: 339,
            head_sha: head,
            card_meta: &meta,
            card_status: Some("blocked"),
            base_verdict: MainVerdict::Red,
            mergeable: Some(true),
            merge_state_status: Some("clean".into()),
            commits: &[(head.into(), true)],
            head_checks: &[run(1, "ci", Some("success"))],
            leg_number: Some(1),
            mechanical_move: None,
            root_fix: true,
            base_red_names: &["Deploy health (merge gate)".to_string(), "Deploy Dev".to_string()],
            base_gate_green: false,
            train_owned_branch: false,
        });
        match gate {
            MergeAction::Merge { receipt } => {
                assert!(receipt.contains("ROOT-FIX FAST-TRACK") && receipt.contains("root_fix_fast_tracked"), "{receipt}");
                assert!(receipt.contains("Deploy health (merge gate)"), "{receipt}");
            }
            other => panic!("expected fast-track merge, got {other:?}"),
        }
    }

    #[test]
    fn train_gate_behind_human_branch_still_bounces() {
        let head = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let meta = serde_json::json!({ "prs": [ { "repo": "r", "number": 7, "head_sha_at_acceptance": head } ] });
        let gate = decide_train_gate(gate_input_provenance(head, &meta, Some("in_review"), Some("behind"), &[run(1, "ci", Some("success"))], &[(head.to_string(), true)], false));
        match gate {
            MergeAction::Bounce { defect, bounce_kind } => {
                assert!(defect.contains("behind"), "defect must name the state: {defect}");
                assert_eq!(bounce_kind, BounceKind::Gate);
            }
            other => panic!("expected gate bounce for a human-owned behind branch, got {other:?}"),
        }
    }

    #[test]
    fn base_red_head_green_without_root_fix_stays_parked() {
        // the SAME shape but unqualified — the standing law's base-red row owns it
        let head = "cccccccccccccccccccccccccccccccccccccccc";
        let meta = serde_json::json!({ "prs": [ { "repo": "o/r", "number": 340, "head_sha_at_acceptance": head } ] });
        let gate = decide_train_gate(TrainGateInput {
            pr_number: 340,
            head_sha: head,
            card_meta: &meta,
            card_status: Some("blocked"),
            base_verdict: MainVerdict::Red,
            mergeable: Some(true),
            merge_state_status: Some("clean".into()),
            commits: &[(head.into(), true)],
            head_checks: &[run(1, "ci", Some("success"))],
            leg_number: Some(1),
            mechanical_move: None,
            root_fix: false,
            base_red_names: &["Deploy Dev".to_string()],
            base_gate_green: false,
            train_owned_branch: false,
        });
        assert!(matches!(gate, MergeAction::Skip { .. }), "got {gate:?}");
    }

    #[test]
    fn circular_deploy_health_class_is_the_human_fast_lane() {
        // head RED (it carries the same deploy-health red main has) + base red
        // naming deploy health — no machine leg can ever pass: HumanLeg
        let head = "cccccccccccccccccccccccccccccccccccccccc";
        let meta = root_fix_meta(head);
        let gate = decide_train_gate(TrainGateInput {
            pr_number: 339,
            head_sha: head,
            card_meta: &meta,
            card_status: Some("blocked"),
            base_verdict: MainVerdict::Red,
            mergeable: Some(true),
            merge_state_status: Some("clean".into()),
            commits: &[(head.into(), true)],
            head_checks: &[run(1, "Deploy health (merge gate)", Some("failure"))],
            leg_number: Some(1),
            mechanical_move: None,
            root_fix: true,
            base_red_names: &["Deploy health (merge gate)".to_string()],
            base_gate_green: false,
            train_owned_branch: false,
        });
        match gate {
            MergeAction::RootFixBypass { reason } => {
                assert!(reason.contains("circular deploy-health class") && reason.contains("BR#5189"), "{reason}");
            }
            other => panic!("expected human fast lane, got {other:?}"),
        }
    }

    #[test]
    fn train_gate_blocked_pending_checks_skip_a_tick() {
        // BR#3727: blocked + re-running required checks is a clock, not a defect
        let head = "cccccccccccccccccccccccccccccccccccccccc";
        let meta = serde_json::json!({ "prs": [ { "repo": "r", "number": 7, "head_sha_at_acceptance": head } ] });
        let checks = [run(1, "ci", Some("in_progress"))];
        let gate = decide_train_gate(gate_input_provenance(head, &meta, Some("in_review"), Some("blocked"), &checks, &[(head.to_string(), true)], true));
        match gate {
            MergeAction::Skip { reason } => assert!(reason.contains("pending, not a defect"), "reason: {reason}"),
            other => panic!("expected skip-a-tick, got {other:?}"),
        }
    }

    #[test]
    fn circular_human_lane_never_fires_for_an_unqualified_card() {
        // same circular base, same red head — but NOT the root fix: standing law
        let head = "cccccccccccccccccccccccccccccccccccccccc";
        let meta = serde_json::json!({ "prs": [ { "repo": "o/r", "number": 341, "head_sha_at_acceptance": head } ] });
        let gate = decide_train_gate(TrainGateInput {
            pr_number: 341,
            head_sha: head,
            card_meta: &meta,
            card_status: Some("blocked"),
            base_verdict: MainVerdict::Red,
            mergeable: Some(true),
            merge_state_status: Some("clean".into()),
            commits: &[(head.into(), true)],
            head_checks: &[run(1, "Deploy health (merge gate)", Some("failure"))],
            leg_number: Some(1),
            mechanical_move: None,
            root_fix: false,
            base_red_names: &["Deploy health (merge gate)".to_string()],
            base_gate_green: false,
            train_owned_branch: false,
        });
        assert!(!matches!(gate, MergeAction::HumanLeg { .. }), "got {gate:?}");
    }

    #[test]
    fn base_red_non_circular_head_red_root_fix_waits_like_everyone() {
        // base red (real red, not deploy-health) + the cure's own head red —
        // no fast lane is invented for a red the cure doesn't cure: the
        // standing law's note row owns the wait
        let head = "cccccccccccccccccccccccccccccccccccccccc";
        let meta = root_fix_meta(head);
        let gate = decide_train_gate(TrainGateInput {
            pr_number: 339,
            head_sha: head,
            card_meta: &meta,
            card_status: Some("blocked"),
            base_verdict: MainVerdict::Red,
            mergeable: Some(true),
            merge_state_status: Some("clean".into()),
            commits: &[(head.into(), true)],
            head_checks: &[run(1, "Rust Tests", Some("failure"))],
            leg_number: Some(1),
            mechanical_move: None,
            root_fix: true,
            base_red_names: &["Deploy Dev".to_string()],
            base_gate_green: false,
            train_owned_branch: false,
        });
        assert!(!matches!(gate, MergeAction::Merge { .. }) && !matches!(gate, MergeAction::HumanLeg { .. }), "got {gate:?}");
    }

    #[test]
    fn bypass_requires_settled_verified_covered_head() {
        let head = "cccccccccccccccccccccccccccccccccccccccc";
        let meta = root_fix_meta(head);
        for (verified, live_head, pending, missing) in [(true, head, true, false), (false, head, false, false),
            (true, "dddddddddddddddddddddddddddddddddddddddd", false, false), (true, head, false, true)] {
            let mut checks = vec![run(1, "Deploy health (merge gate)", Some("failure"))];
            if pending { checks.push(run(2, "Rust Tests", None)); }
            let commits = if missing { vec![] } else { vec![(live_head.into(), verified)] };
            let gate = decide_train_gate(TrainGateInput {
                pr_number: 339, head_sha: live_head, card_meta: &meta, card_status: Some("blocked"),
                base_verdict: MainVerdict::Red, mergeable: Some(true), merge_state_status: Some("blocked".into()),
                commits: &commits, head_checks: &checks, leg_number: Some(1),
                mechanical_move: None, root_fix: true, base_red_names: &["Deploy health (merge gate)".into()],
                base_gate_green: false, train_owned_branch: false,
            });
            assert!(!matches!(gate, MergeAction::RootFixBypass { .. } | MergeAction::Merge { .. }), "{gate:?}");
        }
        let truncated = vec![("9".repeat(40), true)];
        let gate = decide_train_gate(TrainGateInput {
            pr_number: 339, head_sha: head, card_meta: &meta, card_status: Some("blocked"),
            base_verdict: MainVerdict::Red, mergeable: Some(true), merge_state_status: Some("blocked".into()),
            commits: &truncated, head_checks: &[run(1, "Deploy health (merge gate)", Some("failure"))], leg_number: Some(1),
            mechanical_move: None, root_fix: true, base_red_names: &["Deploy health (merge gate)".into()],
            base_gate_green: false, train_owned_branch: false,
        });
        assert!(matches!(gate, MergeAction::Skip { .. }), "{gate:?}");
    }

    #[test]
    fn base_green_root_fix_is_a_noop_on_the_standing_law() {
        // base green — the fast lane is silent and the standing law merges
        let head = "cccccccccccccccccccccccccccccccccccccccc";
        let meta = root_fix_meta(head);
        let gate = decide_train_gate(TrainGateInput {
            pr_number: 339,
            head_sha: head,
            card_meta: &meta,
            card_status: Some("blocked"),
            base_verdict: MainVerdict::Green,
            mergeable: Some(true),
            merge_state_status: Some("clean".into()),
            commits: &[(head.into(), true)],
            head_checks: &[run(1, "ci", Some("success"))],
            leg_number: Some(1),
            mechanical_move: None,
            root_fix: true,
            base_red_names: &[],
            base_gate_green: false,
            train_owned_branch: false,
        });
        assert!(matches!(gate, MergeAction::Merge { .. }), "got {gate:?}");
    }

    #[test]
    fn stale_deploy_health_red_on_green_base_is_the_self_heal() {
        // 2026-11-02: head red ENTIRELY the deploy-health class + base GREEN —
        // a verdict stamped against a superseded main deploy. Re-run the gate,
        // never a bounce, never a human leg. BLOCKED (the failed required
        // check's own state) must heal too — the row sits above the blocked
        // pre-clear.
        let head = "cccccccccccccccccccccccccccccccccccccccc";
        let meta = serde_json::json!({ "prs": [ { "repo": "o/r", "number": 342, "head_sha_at_acceptance": head } ] });
        let gate = decide_train_gate(TrainGateInput {
            pr_number: 342,
            head_sha: head,
            card_meta: &meta,
            card_status: Some("blocked"),
            base_verdict: MainVerdict::Green,
            mergeable: Some(true),
            merge_state_status: Some("blocked".into()),
            commits: &[(head.into(), true)],
            head_checks: &[
                run(1, "Deploy health (merge gate)", Some("failure")),
                run(2, "ci", Some("success")),
            ],
            leg_number: Some(1),
            mechanical_move: None,
            root_fix: false,
            base_red_names: &[],
            base_gate_green: false,
            train_owned_branch: false,
        });
        match gate {
            MergeAction::RerunGate { reason } => {
                assert!(reason.contains("deploy-health") && reason.contains("GREEN"), "{reason}");
                assert!(reason.contains("Deploy health (merge gate)"), "{reason}");
            }
            other => panic!("expected rerun_gate, got {other:?}"),
        }
    }

    #[test]
    fn mixed_red_on_green_base_is_not_the_self_heal() {
        // a REAL red beside the gate red → not entirely the deploy-health
        // class: no self-heal on a defect the PR carries (the standing law
        // owns it — queued card, so the note row)
        let head = "cccccccccccccccccccccccccccccccccccccccc";
        let meta = serde_json::json!({ "prs": [ { "repo": "o/r", "number": 343, "head_sha_at_acceptance": head } ] });
        let gate = decide_train_gate(TrainGateInput {
            pr_number: 343,
            head_sha: head,
            card_meta: &meta,
            card_status: Some("blocked"),
            base_verdict: MainVerdict::Green,
            mergeable: Some(true),
            merge_state_status: Some("blocked".into()),
            commits: &[(head.into(), true)],
            head_checks: &[
                run(1, "Deploy health (merge gate)", Some("failure")),
                run(2, "Rust Tests", Some("failure")),
            ],
            leg_number: Some(1),
            mechanical_move: None,
            root_fix: false,
            base_red_names: &[],
            base_gate_green: false,
            train_owned_branch: false,
        });
        assert!(!matches!(gate, MergeAction::RerunGate { .. }), "got {gate:?}");
        assert!(matches!(gate, MergeAction::Note { .. }), "got {gate:?}");
    }

    #[test]
    fn deploy_health_red_on_red_base_keeps_the_circular_law() {
        // base RED → the self-heal is silent: no premise has evaporated (the
        // BR#5189 circular rows own a red base, root fix or not)
        let head = "cccccccccccccccccccccccccccccccccccccccc";
        let meta = serde_json::json!({ "prs": [ { "repo": "o/r", "number": 344, "head_sha_at_acceptance": head } ] });
        let gate = decide_train_gate(TrainGateInput {
            pr_number: 344,
            head_sha: head,
            card_meta: &meta,
            card_status: Some("blocked"),
            base_verdict: MainVerdict::Red,
            mergeable: Some(true),
            merge_state_status: Some("clean".into()),
            commits: &[(head.into(), true)],
            head_checks: &[run(1, "Deploy health (merge gate)", Some("failure"))],
            leg_number: Some(1),
            mechanical_move: None,
            root_fix: false,
            base_red_names: &["Deploy health (merge gate)".to_string()],
            base_gate_green: false,
            train_owned_branch: false,
        });
        assert!(!matches!(gate, MergeAction::RerunGate { .. }), "got {gate:?}");
    }

    #[test]
    fn head_checks_newest_non_cancelled_run_per_name_supersedes_stale_failure() {
        let head = "cccccccccccccccccccccccccccccccccccccccc";
        let meta = serde_json::json!({ "prs": [ { "repo": "o/r", "number": 2707, "head_sha_at_acceptance": head } ] });
        let checks = [
            run(100, "Deploy health (merge gate)", Some("failure")),
            run(101, "Deploy health (merge gate)", Some("failure")),
            run(200, "Deploy health (merge gate)", Some("success")),
            run(201, "ci", Some("success")),
        ];
        let v = classify_head_checks(&checks);
        assert_eq!(v.verdict, MainVerdict::Green);
        assert!(v.red.is_empty());
        assert_eq!(v.green, 2);
        let gate = decide_train_gate(TrainGateInput {
            pr_number: 2707,
            head_sha: head,
            card_meta: &meta,
            card_status: Some("blocked"),
            base_verdict: MainVerdict::Green,
            mergeable: Some(true),
            merge_state_status: Some("behind".into()),
            commits: &[(head.into(), true)],
            head_checks: &checks,
            leg_number: Some(1),
            mechanical_move: None,
            root_fix: false,
            base_red_names: &[],
            base_gate_green: false,
            train_owned_branch: true,
        });
        assert!(matches!(gate, MergeAction::Merge { .. }), "expected Merge when newest gate run is green, got {gate:?}");
    }

    #[test]
    fn stale_main_green_gate_on_green_base_triggers_rerun_gate() {
        let head = "dddddddddddddddddddddddddddddddddddddddd";
        let meta = serde_json::json!({ "prs": [ { "repo": "state-vector/bridge", "number": 377, "head_sha_at_acceptance": head } ] });
        let checks = [
            run(10, "main-green gate", Some("failure")),
            run(11, "Test", Some("success")),
        ];
        let gate = decide_train_gate(TrainGateInput {
            pr_number: 377,
            head_sha: head,
            card_meta: &meta,
            card_status: Some("blocked"),
            base_verdict: MainVerdict::Green,
            mergeable: Some(true),
            merge_state_status: Some("behind".into()),
            commits: &[(head.into(), true)],
            head_checks: &checks,
            leg_number: Some(1),
            mechanical_move: None,
            root_fix: false,
            base_red_names: &[],
            base_gate_green: true,
            train_owned_branch: false,
        });
        assert!(matches!(gate, MergeAction::RerunGate { .. }), "expected RerunGate on stale main-green gate, got {gate:?}");
    }

    #[test]
    fn br6012_state_machine_defends_blocked_circular_root_fix_and_conflicting_preconditions() {
        let head = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        let meta = root_fix_meta(head);
        // 1. Agent-filed root-blocker card shape (hyphen tag + main_tip + pr.repo) qualifies
        assert!(is_root_fix_card(&serde_json::json!({
            "tags": ["root-blocker", "main-red"],
            "meta": { "main_tip": "8454ae7bb", "pr": { "repo": "state-vector/superpositional", "number": 2800 } }
        })));
        // 2. Real GitHub circular root-fix state: mergeStateStatus="blocked" +
        //    head check RED on "Deploy health (merge gate)" + base_red_names="deploy / Deploy to dev"
        //    must NOT be swallowed by `blocked -> Note`; it transitions to HumanLeg!
        let circular_blocked = decide_train_gate(TrainGateInput {
            pr_number: 2800,
            head_sha: head,
            card_meta: &meta,
            card_status: Some("blocked"),
            base_verdict: MainVerdict::Red,
            mergeable: Some(true),
            merge_state_status: Some("blocked".into()),
            commits: &[(head.into(), true)],
            head_checks: &[
                run(1, "Deploy health (merge gate)", Some("failure")),
                run(2, "ci / Rust Tests", Some("success")),
            ],
            leg_number: Some(1),
            mechanical_move: None,
            root_fix: true,
            base_red_names: &["deploy / Deploy to dev".to_string()],
            base_gate_green: false,
            train_owned_branch: false,
        });
        assert!(
            matches!(circular_blocked, MergeAction::RootFixBypass { .. }),
            "expected HumanLeg on BLOCKED circular root-fix PR, got {circular_blocked:?}"
        );
        // 3. A CONFLICTING PR (`mergeable == Some(false)`) ALWAYS bounces as Conflict,
        //    even when `merge_state_status == "blocked"` or `root_fix == true` or `base_verdict == Green`!
        let conflicting_root_fix = decide_train_gate(TrainGateInput {
            pr_number: 2800,
            head_sha: head,
            card_meta: &meta,
            card_status: Some("blocked"),
            base_verdict: MainVerdict::Red,
            mergeable: Some(false),
            merge_state_status: Some("blocked".into()),
            commits: &[(head.into(), true)],
            head_checks: &[run(1, "ci / Rust Tests", Some("success"))],
            leg_number: Some(1),
            mechanical_move: None,
            root_fix: true,
            base_red_names: &["deploy / Deploy to dev".to_string()],
            base_gate_green: false,
            train_owned_branch: false,
        });
        assert!(
            matches!(
                conflicting_root_fix,
                MergeAction::Bounce {
                    bounce_kind: BounceKind::Conflict,
                    ..
                }
            ),
            "expected Bounce(Conflict) on CONFLICTING root-fix PR, got {conflicting_root_fix:?}"
        );
    }

    #[test]
    fn br6179_level_based_deploy_reconciliation_dark_tip_grace_dispatch_and_redundant_cancel() {
        let required: Vec<String> = vec![
            "deploy / Deploy to dev".into(),
            "post-deploy / Post-Deploy Smoke".into(),
            "post-deploy / DNS chain".into(),
            "post-deploy / Lodestar Storage Health".into(),
        ];
        let dark_tip = "7f5efec26cc5b715ef0ff42eb8ebbf2da0fc1a6f";
        let prev_green_tip = "ebbe182633c5351f5bcbc9cd6d4924659bd604a2";
        let empty_verdict = classify_base_check_runs(&[], &required);
        assert_eq!(empty_verdict.verdict, MainVerdict::Empty);

        // 1. Deploy Health Record on the dark tip (the exact 2026-11-04 08:19:23Z receipt)
        //    must NEVER be mistaken for a covering Deploy Dev workflow run.
        let wf_runs_with_dhr = vec![
            DeployWorkflowRun {
                id: 41791923312,
                run_attempt: Some(1),
                name: "Deploy Health Record".into(),
                path: Some(".github/workflows/deploy-health.yml".into()),
                head_sha: dark_tip.into(),
                event: Some("schedule".into()),
                status: Some("completed".into()),
                conclusion: Some("success".into()),
                html_url: None,
            },
            DeployWorkflowRun {
                id: 41780000001,
                run_attempt: Some(1),
                name: "Deploy Dev".into(),
                path: Some(".github/workflows/deploy-dev.yml".into()),
                head_sha: prev_green_tip.into(),
                event: Some("push".into()),
                status: Some("completed".into()),
                conclusion: Some("success".into()),
                html_url: Some("https://github.com/state-vector/superpositional/actions/runs/41780000001".into()),
            },
        ];
        assert!(!is_deploy_workflow_run(&wf_runs_with_dhr[0], &required));
        assert!(is_deploy_workflow_run(&wf_runs_with_dhr[1], &required));
        assert_eq!(infer_deploy_workflow(&required, &wf_runs_with_dhr), Some("deploy-dev.yml".into()));
        assert_eq!(infer_deploy_workflow(&required, &[]), Some("deploy-dev.yml".into()));

        // BR#7572: the bridge repo's own deploy pipeline `dev-build`
        // (dev-build.yml, push-to-main Workers + CLI binaries) is the decisive
        // deploy workflow — recognized by name alone and by path; a
        // differently-named lookalike stays unrecognized.
        let dev_build_run = DeployWorkflowRun {
            id: 42361588979,
            run_attempt: Some(1),
            name: "dev-build".into(),
            path: Some(".github/workflows/dev-build.yml".into()),
            head_sha: dark_tip.into(),
            event: Some("push".into()),
            status: Some("completed".into()),
            conclusion: Some("success".into()),
            html_url: None,
        };
        assert!(is_deploy_workflow_run(&dev_build_run, &required));
        let dev_build_name_only = DeployWorkflowRun {
            path: None,
            ..dev_build_run.clone()
        };
        assert!(is_deploy_workflow_run(&dev_build_name_only, &required));
        // renamed display on the genuine path: the path identifies the workflow file
        let dev_build_renamed = DeployWorkflowRun {
            name: "dev-build canary".into(),
            ..dev_build_run.clone()
        };
        assert!(is_deploy_workflow_run(&dev_build_renamed, &required));
        // a differently-named lookalike on its own path stays unrecognized
        // (dev-build-canary.yml does not end with "/dev-build.yml")
        let dev_build_lookalike = DeployWorkflowRun {
            name: "dev-build canary".into(),
            path: Some(".github/workflows/dev-build-canary.yml".into()),
            ..dev_build_run.clone()
        };
        assert!(!is_deploy_workflow_run(&dev_build_lookalike, &required));

        // 2. Inside grace window (age 120s < 300s): UncoveredGrace, no dispatch yet
        let plan_grace = reconcile_deploy_coverage(
            dark_tip,
            120,
            DEPLOY_RECONCILE_GRACE_SECS,
            &empty_verdict,
            &required,
            &wf_runs_with_dhr,
            None,
        );
        assert_eq!(plan_grace.dispatch_workflow, None);
        assert_eq!(plan_grace.covered_by_sha.as_deref(), Some(prev_green_tip));
        assert!(matches!(plan_grace.coverage, DeployCoverageState::UncoveredGrace { tip_age_secs: 120, .. }));
        assert_eq!(
            format_deploy_coverage_summary(&plan_grace.coverage),
            "tip 7f5efec2 not covered by any deploy (age 2m, grace 5m)"
        );

        // 3. Past grace window (age 1020s = 17m >= 300s) and not yet dispatched:
        //    UncoveredDark + dispatch_workflow = Some("deploy-dev.yml")
        let plan_dark = reconcile_deploy_coverage(
            dark_tip,
            1020,
            DEPLOY_RECONCILE_GRACE_SECS,
            &empty_verdict,
            &required,
            &wf_runs_with_dhr,
            None,
        );
        assert_eq!(plan_dark.dispatch_workflow.as_deref(), Some("deploy-dev.yml"));
        assert_eq!(plan_dark.covered_by_sha.as_deref(), Some(prev_green_tip));
        assert_eq!(plan_dark.coverage_age_secs, 1020);
        assert_eq!(
            format_deploy_coverage_summary(&plan_dark.coverage),
            "tip 7f5efec2 not covered by any deploy (age 17m) — last green deploy ebbe1826"
        );

        // 4. Once dispatched for this SHA (`already_dispatched_at = Some(...)`):
        //    UncoveredDispatched + dispatch_workflow = None (idempotent once-per-sha guard)
        let plan_dispatched = reconcile_deploy_coverage(
            dark_tip,
            1020,
            DEPLOY_RECONCILE_GRACE_SECS,
            &empty_verdict,
            &required,
            &wf_runs_with_dhr,
            Some(1793780527000),
        );
        assert_eq!(plan_dispatched.dispatch_workflow, None);
        assert!(matches!(
            plan_dispatched.coverage,
            DeployCoverageState::UncoveredDispatched { dispatched_at: 1793780527000, .. }
        ));
        assert_eq!(
            format_deploy_coverage_summary(&plan_dispatched.coverage),
            "tip 7f5efec2 not covered by any deploy (age 17m) — auto-dispatched deploy-dev.yml"
        );

        // 5. Redundant queued run cancellation (Leg D, exact 2026-11-04 08:22 receipt):
        //    workflow_dispatch run 41798951196 is `in_progress` on `prev_green_tip` while
        //    push run 41798949143 is `queued` on the SAME `prev_green_tip` → cancel 41798949143!
        let wf_runs_redundant = vec![
            DeployWorkflowRun {
                id: 41798951196,
                run_attempt: Some(1),
                name: "Deploy Dev".into(),
                path: Some(".github/workflows/deploy-dev.yml".into()),
                head_sha: prev_green_tip.into(),
                event: Some("workflow_dispatch".into()),
                status: Some("in_progress".into()),
                conclusion: None,
                html_url: Some("https://github.com/state-vector/superpositional/actions/runs/41798951196".into()),
            },
            DeployWorkflowRun {
                id: 41798949143,
                run_attempt: Some(1),
                name: "Deploy Dev".into(),
                path: Some(".github/workflows/deploy-dev.yml".into()),
                head_sha: prev_green_tip.into(),
                event: Some("push".into()),
                status: Some("queued".into()),
                conclusion: None,
                html_url: Some("https://github.com/state-vector/superpositional/actions/runs/41798949143".into()),
            },
        ];
        let unsettled_verdict = classify_base_check_runs(
            &[MainCheckRun {
                id: 1,
                source: CheckSource::Unknown,
                name: "deploy / Deploy to dev".into(),
                status: Some("in_progress".into()),
                conclusion: None,
                html_url: None,
            }],
            &required,
        );
        let plan_settling = reconcile_deploy_coverage(
            prev_green_tip,
            30,
            DEPLOY_RECONCILE_GRACE_SECS,
            &unsettled_verdict,
            &required,
            &wf_runs_redundant,
            None,
        );
        assert_eq!(plan_settling.cancel_run_ids, vec![41798949143]);
        assert_eq!(plan_settling.dispatch_workflow, None);
        assert!(matches!(
            plan_settling.coverage,
            DeployCoverageState::Settling { active_run_id: Some(41798951196), .. }
        ));

        // 5b. Stage-1 Spot build (exact 20b508b328 PR #2899 incident, BR#6389):
        //     `check_runs` has only `deploy / Prepare deploy to dev (build on spot)` (0 of 4 required runs),
        //     so `classify_base_check_runs` returns `Empty` with alarm, while `Deploy Dev` workflow run
        //     41911085476 is `in_progress`. `reconcile_base_verdict_with_deploy_coverage` MUST promote
        //     the base verdict from `Empty` to `Unsettled` and clear the spurious alarm so the UI/hub
        //     never misclassifies an active deploy as a dark tip.
        let spot_build_verdict = classify_base_check_runs(
            &[MainCheckRun {
                id: 126859440408,
                source: CheckSource::Unknown,
                name: "deploy / Prepare deploy to dev (build on spot)".into(),
                status: Some("in_progress".into()),
                conclusion: None,
                html_url: None,
            }],
            &required,
        );
        assert_eq!(spot_build_verdict.verdict, MainVerdict::Empty);
        let plan_spot = reconcile_deploy_coverage(
            "20b508b3281abf77e7cfec680d920df0e27a7ef2",
            147,
            DEPLOY_RECONCILE_GRACE_SECS,
            &spot_build_verdict,
            &required,
            &[DeployWorkflowRun {
                id: 41911085476,
                run_attempt: Some(1),
                name: "Deploy Dev".into(),
                path: Some(".github/workflows/deploy-dev.yml".into()),
                head_sha: "20b508b3281abf77e7cfec680d920df0e27a7ef2".into(),
                event: Some("push".into()),
                status: Some("in_progress".into()),
                conclusion: None,
                html_url: Some("https://github.com/state-vector/superpositional/actions/runs/41911085476".into()),
            }],
            None,
        );
        assert!(matches!(
            plan_spot.coverage,
            DeployCoverageState::Settling { active_run_id: Some(41911085476), .. }
        ));
        let reconciled_spot = reconcile_base_verdict_with_deploy_coverage(&spot_build_verdict, &plan_spot.coverage, &required);
        // BR#14088: in-flight deploy = SETTLING (amber, never green); the name
        // still folds into `unsettled` so list consumers keep naming it.
        assert_eq!(reconciled_spot.verdict, MainVerdict::Settling);
        assert!(reconciled_spot.alarm.is_none());
        assert_eq!(reconciled_spot.settling, vec!["Deploy Dev (run #41911085476 in flight)"]);
        assert_eq!(reconciled_spot.unsettled, vec!["Deploy Dev (run #41911085476 in flight)"]);

        // 5c. Stage-1 failed build (0 required check-runs created because Spot build failed):
        //     `reconcile_deploy_coverage` classifies `Failed` (not `UncoveredDark`) and
        //     `reconcile_base_verdict_with_deploy_coverage` promotes `Empty` -> `Red`.
        let plan_failed_spot = reconcile_deploy_coverage(
            "20b508b3281abf77e7cfec680d920df0e27a7ef2",
            600,
            DEPLOY_RECONCILE_GRACE_SECS,
            &spot_build_verdict,
            &required,
            &[DeployWorkflowRun {
                id: 41911085476,
                run_attempt: Some(1),
                name: "Deploy Dev".into(),
                path: Some(".github/workflows/deploy-dev.yml".into()),
                head_sha: "20b508b3281abf77e7cfec680d920df0e27a7ef2".into(),
                event: Some("push".into()),
                status: Some("completed".into()),
                conclusion: Some("failure".into()),
                html_url: Some("https://github.com/state-vector/superpositional/actions/runs/41911085476".into()),
            }],
            None,
        );
        assert_eq!(plan_failed_spot.dispatch_workflow, None);
        assert!(matches!(
            plan_failed_spot.coverage,
            DeployCoverageState::Failed { failing_run_id: Some(41911085476), .. }
        ));
        let reconciled_failed = reconcile_base_verdict_with_deploy_coverage(&spot_build_verdict, &plan_failed_spot.coverage, &required);
        assert_eq!(reconciled_failed.verdict, MainVerdict::Red);
        assert_eq!(reconciled_failed.red.len(), 1);
        assert_eq!(reconciled_failed.red[0].name, "Deploy Dev (run #41911085476)");

        // 6. ISO-8601 parser accuracy
        assert_eq!(parse_iso8601_epoch_ms("2026-11-04T08:01:57Z"), Some(1_793_779_317_000));
        assert_eq!(parse_iso8601_epoch_ms("2026-11-04T08:01:57.250Z"), Some(1_793_779_317_250));
        assert_eq!(parse_iso8601_epoch_ms("invalid"), None);
    }

    #[test]
    fn train_gate_blocked_red_checks_note_not_bounce() {
        // blocked + RED on a QUEUED card: the linked session owns it — a Note,
        // never a bounce cascade (core.ts verbatim parity)
        let head = "dddddddddddddddddddddddddddddddddddddddd";
        let meta = serde_json::json!({ "prs": [ { "repo": "r", "number": 7, "head_sha_at_acceptance": head } ] });
        let checks = [run(1, "ci", Some("failure"))];
        let gate = decide_train_gate(gate_input_provenance(head, &meta, Some("blocked"), Some("blocked"), &checks, &[(head.to_string(), true)], true));
        match gate {
            MergeAction::Note { reason } => assert!(reason.contains("no bounce"), "reason: {reason}"),
            other => panic!("expected note, got {other:?}"),
        }
    }

    #[test]
    fn train_gate_repeated_behind_on_carried_verdict_still_preclears() {
        // stamp → carry → head: the leg's verdict covers the post-update head,
        // so a SECOND behind machine-updates again instead of attempting a
        // doomed merge (BR#3659's per-leg coverage + BR#4687's carry)
        let stamp = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let head = "cccccccccccccccccccccccccccccccccccccccc";
        let carry = serde_json::json!([{ "from_head": stamp, "to_head": head, "prior_verdict_id": null, "carried_ts": 0, "via": "update-branch" }]);
        let meta = serde_json::json!({ "prs": [ { "repo": "r", "number": 7, "head_sha_at_acceptance": stamp, "carry": carry } ] });
        let gate = decide_train_gate(gate_input_provenance(head, &meta, Some("in_review"), Some("behind"), &[run(1, "ci", Some("success"))], &[(head.to_string(), true)], true));
        match gate {
            MergeAction::Merge { receipt } => assert!(receipt.contains("behind pre-cleared"), "receipt: {receipt}"),
            other => panic!("expected carried verdict to pre-clear a second behind, got {other:?}"),
        }
    }
}
