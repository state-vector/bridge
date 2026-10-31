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
const MERGE_EXEMPT_CHECK_PATTERNS: [&str; 6] = [
    "workers builds",
    "workers-builds",
    "cloudflare pages",
    "cloudflare workers",
    "deploy preview",
    "codeql",
];

#[derive(Clone, Debug, serde::Serialize)]
pub struct MainCheckRun {
    pub id: i64,
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
    Red,
    Unsettled,
    Empty,
}

impl MainVerdict {
    pub fn as_str(&self) -> &'static str {
        match self {
            MainVerdict::Green => "green",
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
    pub unsettled: Vec<String>,
    pub external: Vec<MainRedCheck>,
    pub green: usize,
}

fn is_red_conclusion(c: &str) -> bool {
    MAIN_RED_CONCLUSIONS.contains(&c)
}

fn settled_green(c: &str) -> bool {
    c == "success" || c == "skipped" || c == "neutral"
}

fn is_exempt_check_name(name: &str) -> bool {
    let n = name.to_lowercase();
    MERGE_EXEMPT_CHECK_PATTERNS.iter().any(|p| n.contains(p))
}

fn parse_runs(runs: &[MainCheckRun]) -> Vec<(String, Vec<&MainCheckRun>)> {
    let mut by_name: Vec<(String, Vec<&MainCheckRun>)> = Vec::new();
    for r in runs {
        match by_name.iter_mut().find(|(n, _)| *n == r.name) {
            Some((_, list)) => list.push(r),
            None => by_name.push((r.name.clone(), vec![r])),
        }
    }
    by_name
}

/// core.ts classifyMainCheckRuns (764): newest non-cancelled run per name
/// judges; red beats unsettled beats green; no runs at all = "empty".
pub fn classify_main_check_runs(runs: &[MainCheckRun]) -> CheckVerdict {
    if runs.is_empty() {
        return CheckVerdict { verdict: MainVerdict::Empty, red: vec![], unsettled: vec![], external: vec![], green: 0 };
    }
    let mut red = Vec::new();
    let mut unsettled = Vec::new();
    let mut green = 0usize;
    for (name, list) in parse_runs(runs) {
        let mut sorted: Vec<&&MainCheckRun> = list.iter().collect();
        sorted.sort_by(|a, b| b.id.cmp(&a.id));
        let judge = sorted.into_iter().find(|r| r.conclusion.as_deref() != Some("cancelled"));
        match judge {
            None => unsettled.push(format!("{} (only cancelled runs)", name)),
            Some(j) => match j.conclusion.as_deref() {
                None => unsettled.push(name),
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
    finish_verdict(red, unsettled, vec![], green)
}

/// core.ts classifyHeadChecks (846): same rule, but exempt-external failures
/// are pulled OUT of red into `external` (human-leg class ask, never gating).
pub fn classify_head_checks(runs: &[MainCheckRun]) -> CheckVerdict {
    let mut red = Vec::new();
    let mut unsettled = Vec::new();
    let mut external = Vec::new();
    let mut green = 0usize;
    for r in runs {
        let name = r.name.clone();
        match r.conclusion.as_deref() {
            None => {
                if is_exempt_check_name(&name) {
                    continue; // exempt externals in flight say nothing
                }
                unsettled.push(name);
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
        }
    }
    finish_verdict(red, unsettled, external, green)
}

fn finish_verdict(red: Vec<MainRedCheck>, unsettled: Vec<String>, external: Vec<MainRedCheck>, green: usize) -> CheckVerdict {
    let verdict = if !red.is_empty() {
        MainVerdict::Red
    } else if !unsettled.is_empty() {
        MainVerdict::Unsettled
    } else {
        MainVerdict::Green
    };
    CheckVerdict { verdict, red, unsettled, external, green }
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
/// it is tagged `root_blocker` + `main-red` AND bound to a failing main-HEAD
/// run (meta.root_fix with repo + head_sha). Tags alone never qualify — the
/// binding does (an ambient "main is red" tag without a named run would pin
/// the whole queue to a stale episode). MUST stay behaviour-identical to the
/// TS mirror (core.ts isRootFixCard, tag match case-insensitive).
pub fn is_root_fix_card(card: &Value) -> bool {
    let tags: Vec<String> = card
        .get("tags")
        .and_then(|t| t.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_lowercase())).collect())
        .unwrap_or_default();
    if !tags.iter().any(|t| t == "root_blocker") || !tags.iter().any(|t| t == "main-red") {
        return false;
    }
    let b = match card.get("meta").and_then(|m| m.get("root_fix")) {
        Some(b) if b.is_object() => b,
        _ => return false,
    };
    let repo = b.get("repo").and_then(|v| v.as_str()).unwrap_or("");
    let sha = b.get("head_sha").and_then(|v| v.as_str()).unwrap_or("");
    !repo.is_empty() && !sha.is_empty()
}

#[derive(Clone, Debug, PartialEq)]
pub enum MergeAction {
    Merge { receipt: String },
    CloseSuperseded { reason: String },
    Bounce { defect: String, bounce_kind: BounceKind },
    Note { reason: String },
    Skip { reason: String },
    HumanLeg { reason: String },
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
    /// BR#5190: the candidate IS the bound main-breakage fix (is_root_fix_card
    /// over the WHOLE card — tags live on the card row, the binding under
    /// meta.root_fix — the executor mirror of the hub's isRootFixCard).
    pub root_fix: bool,
    /// BR#5190: the base's failing check NAMES ride the gate — the fast lane
    /// matches the circular deploy-health class off them (the receipt names
    /// the red the fix cures).
    pub base_red_names: &'a [String],
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

/// core.ts decideTrainGate (1486): the executor's per-candidate gate, each
/// leg fail-closed — verdict coverage (stamp or contiguous carry) first,
/// then the standing gate.
pub fn decide_train_gate(i: TrainGateInput) -> MergeAction {
    if i.card_status == Some("superseded") {
        return MergeAction::CloseSuperseded { reason: "linked card is superseded — closing PR without review".into() };
    }
    if i.card_status == Some("done") {
        return MergeAction::Skip { reason: "linked card already done — nothing to merge under it".into() };
    }
    let legs = train_legs(i.card_meta);
    let leg_number = i.leg_number.unwrap_or(1).max(1);
    let leg = if !legs.is_empty() { legs.get(leg_number - 1) } else { None };
    if !verdict_covers_head_leg(leg, i.head_sha) {
        let stamped = leg
            .and_then(|l| l.head_sha_at_acceptance.clone())
            .map(|s| s[..s.len().min(9)].to_string())
            .unwrap_or_else(|| "(no stamp)".into());
        return MergeAction::Bounce {
            defect: format!(
                "PR #{n} live head {h} is not covered by the accepted verdict (leg {L} stamped {s}, no contiguous carry chain) — head moved past the verdict without a machine-clean update; re-verify at the new head",
                n = i.pr_number,
                h = &i.head_sha[..i.head_sha.len().min(9)],
                L = leg_number,
                s = stamped
            ),
            bounce_kind: BounceKind::Coverage,
        };
    }
    // BR#3727: mergeStateStatus=behind IS the state the carry law (BR#3516 §5)
    // was written for — base advanced, branch still mergeable. The shared law
    // stays clean/unstable and bounces behind: the SWEEP has no update-branch
    // authority. The TRAIN does — its merge leg owns trial-merge →
    // update-branch → verdict carries — so the train gate pre-clears behind
    // here. Without it, the exact PRs the carry law was written for
    // bounce-loop (bounce → re-verify → re-queue → behind again — nothing in
    // the bounce flow updates the branch). Coverage is already settled above:
    // an uncovered head bounced before this line, so behind reaching the
    // compose is always a §5-carryable head.
    let behind = i
        .merge_state_status
        .as_deref()
        .map(|s| s.eq_ignore_ascii_case("behind"))
        .unwrap_or(false);
    // BR#3727: blocked with head checks merely PENDING is a clock, not a
    // defect — strict branch protection re-runs the required checks on the
    // head right after every machine-clean update-branch, so the tick after
    // the carry reads blocked. Pending checks wait a tick; red checks note
    // (the shared law's own non-in_review row). BR#4633 L4.2 (the approval
    // anchor): blocked with GREEN checks no longer bounces — the BR verify
    // verdict IS the approval of record, and the head move that dismissed the
    // stale GitHub review is exactly the event L4.2 refuses to count as a
    // lost approval. Coverage is settled above (an uncovered head bounced
    // before this line), so blocked+green reaching the compose is a verified,
    // covered head — the merge leg pre-clears the state (supersedes the
    // BR#3727 "blocked+green bounce stands" posture).
    let blocked = i
        .merge_state_status
        .as_deref()
        .map(|s| s.eq_ignore_ascii_case("blocked"))
        .unwrap_or(false);
    if blocked {
        let head = classify_head_checks(i.head_checks);
        if head.verdict == MainVerdict::Unsettled {
            return MergeAction::Skip {
                reason: format!(
                    "PR #{n} mergeStateStatus=blocked — required checks re-running on head {h} ({u}) — pending, not a defect; next tick",
                    n = i.pr_number,
                    h = &i.head_sha[..i.head_sha.len().min(9)],
                    u = head.unsettled.join(", ")
                ),
            };
        }
        if head.verdict == MainVerdict::Red {
            return MergeAction::Note {
                reason: format!(
                    "PR #{n} head check RED: {names} — card queued (not in_review), no bounce; the linked session owns it",
                    n = i.pr_number,
                    names = head.red.iter().map(|r| r.name.as_str()).collect::<Vec<_>>().join(", ")
                ),
            };
        }
    }
    // ---- BR#5190 root-fix fast lane pre-clear (steering BR#5189): main is
    // RED and the candidate is THE bound main-breakage fix — the shared law's
    // base-red row would park the cure forever behind the very red it cures
    // (the lane is stopped; nothing else merges until main greens). Two rows:
    // (a) head green — merge the cure onto the red base NOW (receipt stamps
    //     root_fix_fast_tracked); the cure's own merge is what turns main
    //     green again.
    // (b) circular deploy-health class — the base's red NAMES the deploy
    //     health gate, which is red BECAUSE main is red: the head can never go
    //     green while the line it fixes is stopped, so no machine leg can ever
    //     pass — the one-click human merge ask is the fast lane (SP #2617
    //     precedent).
    // Coverage is settled above (an uncovered head bounced), so both rows see
    // a verified, covered head. Base red but NOT circular with a non-green
    // head falls through — the standing law's own rows own that wait; the
    // fast lane is never invented for a red the cure doesn't cure. ----
    if i.root_fix && i.base_verdict == MainVerdict::Red {
        let head = classify_head_checks(i.head_checks);
        if head.verdict == MainVerdict::Green {
            return MergeAction::Merge {
                receipt: format!(
                    "ROOT-FIX FAST-TRACK (BR#5189): PR #{n} is the bound main-breakage fix and its head is GREEN — merging onto the red base to turn the line green (root_fix_fast_tracked); base red: {reds}",
                    n = i.pr_number,
                    reds = if i.base_red_names.is_empty() { "required checks".to_string() } else { i.base_red_names.join(", ") }
                ),
            };
        }
        let base_circular = i.base_red_names.iter().any(|n| n.to_lowercase().contains(DEPLOY_HEALTH_PATTERN));
        if base_circular {
            return MergeAction::HumanLeg {
                reason: format!(
                    "PR #{n} is the bound main-breakage fix but the circular deploy-health class stands (BR#5189, SP #2617 precedent): the gate is red because MAIN is red — the head cannot go green while the line it fixes is stopped; the one-click human merge ask is the fast lane",
                    n = i.pr_number
                ),
            };
        }
    }
    let composed_state: Option<&str> = match i.merge_state_status.as_deref() {
        Some(s) if behind || blocked => Some("clean"),
        other => other,
    };
    let gate = decide_merge_action(
        i.pr_number,
        i.head_sha,
        i.card_status,
        &i.base_verdict,
        i.mergeable,
        composed_state,
        i.commits,
        i.head_checks,
        true,
        true,
    );
    match gate {
        MergeAction::Merge { .. } => MergeAction::Merge {
            receipt: format!(
                "PR #{n} merged by the serialized merge train (BR#3516) leg {L}/{M}: head {h} — verdict covers head (stamp/carry), 5c gate pass (mergeable, {state}, {k} verified commits), base green, head checks green",
                n = i.pr_number,
                L = leg_number,
                M = if legs.is_empty() { 1 } else { legs.len() },
                h = &i.head_sha[..i.head_sha.len().min(9)],
                state = if behind {
                    "behind pre-cleared — the merge leg's machine-clean update-branch carries the verdict (BR#3516 §5)"
                } else if blocked {
                    "blocked pre-cleared — the BR verify verdict is the approval of record (BR#4633 L4.2)"
                } else {
                    "clean"
                },
                k = i.commits.len()
            ),
        },
        other => other,
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

// ---------- fixtures mirrored from packages/worker/test/merge-train.test.ts ----------

#[cfg(test)]
fn run(id: i64, name: &str, conclusion: Option<&str>) -> MainCheckRun {
    MainCheckRun { id, name: name.into(), status: Some("completed".into()), conclusion: conclusion.map(String::from), html_url: None }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(matches!(v.verdict, MainVerdict::Unsettled));
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
            root_fix: false,
            base_red_names: &[],
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
            root_fix: false,
            base_red_names: &[],
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
            root_fix: false,
            base_red_names: &[],
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
            root_fix: false,
            base_red_names: &[],
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
            root_fix: false,
            base_red_names: &[],
        });
        match gate {
            MergeAction::Note { reason } => assert!(reason.contains("head check RED"), "reason: {reason}"),
            other => panic!("expected note, got {other:?}"),
        }
    }

    #[test]
    fn blocked_green_verdict_anchor_merges_br4633_l4_2() {
        // mirrored from merge-train.test.ts: blocked + GREEN head checks +
        // covered verdict MERGES — the BR verify verdict is the approval of
        // record (supersedes BR#3727's "blocked+green bounce stands" posture)
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
            root_fix: false,
            base_red_names: &[],
        });
        match gate {
            MergeAction::Merge { receipt } => {
                assert!(receipt.contains("blocked pre-cleared"), "receipt: {receipt}");
                assert!(receipt.contains("approval of record"), "receipt: {receipt}");
                assert!(receipt.contains("BR#4633 L4.2"), "receipt: {receipt}");
            }
            other => panic!("expected merge, got {other:?}"),
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
            root_fix: false,
            base_red_names: &[],
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
            root_fix: false,
            base_red_names: &[],
        }
    }

    #[test]
    fn train_gate_behind_preclear_receipts_byte_identical() {
        let head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let meta = serde_json::json!({ "prs": [ { "repo": "r", "number": 7, "head_sha_at_acceptance": head } ] });
        // BEHIND uppercase → normalized, pre-cleared, merge carries
        let gate = decide_train_gate(gate_input(&meta, Some("BEHIND"), &[run(1, "ci", Some("success"))]));
        match gate {
            MergeAction::Merge { receipt } => assert!(receipt.contains(
                "5c gate pass (mergeable, behind pre-cleared — the merge leg's machine-clean update-branch carries the verdict (BR#3516 §5), 1 verified commits)"
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
            root_fix: true,
            base_red_names: &["Deploy health (merge gate)".to_string(), "Deploy Dev".to_string()],
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
            root_fix: false,
            base_red_names: &["Deploy Dev".to_string()],
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
            root_fix: true,
            base_red_names: &["Deploy health (merge gate)".to_string()],
        });
        match gate {
            MergeAction::HumanLeg { reason } => {
                assert!(reason.contains("circular deploy-health class") && reason.contains("BR#5189"), "{reason}");
            }
            other => panic!("expected human fast lane, got {other:?}"),
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
            root_fix: false,
            base_red_names: &["Deploy health (merge gate)".to_string()],
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
            root_fix: true,
            base_red_names: &["Deploy Dev".to_string()],
        });
        assert!(!matches!(gate, MergeAction::Merge { .. }) && !matches!(gate, MergeAction::HumanLeg { .. }), "got {gate:?}");
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
            root_fix: true,
            base_red_names: &[],
        });
        assert!(matches!(gate, MergeAction::Merge { .. }), "got {gate:?}");
    }
}
