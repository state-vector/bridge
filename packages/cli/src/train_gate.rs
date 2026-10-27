//! train_gate — the merge-train admission gate, ported natively (BR#3879,
//! decision BR#3880). One-for-one port of the pure decision layer the executor
//! used to import from packages/worker/src/kb/core.ts: classifyMainCheckRuns,
//! classifyHeadChecks, decideMergeAction, decideTrainGate, the legs/carry law
//! (BR#3659), and the BR#3714 fact-boundary normalizers. Messages are
//! byte-identical to the TS originals — the hub's bounce/note copy is part of
//! the contract. Pinned case by case in the tests below (the TS side stays
//! pinned in packages/worker/test/merge-train.test.ts; both sides must move
//! together).

use serde_json::Value;

pub const TRAIN_CI_BOUND_MULTIPLIER: i64 = 3;
pub const TRAIN_CI_TYPICAL_MINUTES: i64 = 20;

/// Conclusions that mean the line is stopped. `cancelled` and null are NOT
/// here: a cancelled run says nothing (the judge falls back to the newest
/// non-cancelled run of that name), and a null conclusion is unsettled.
const MAIN_RED_CONCLUSIONS: [&str; 4] = ["failure", "timed_out", "action_required", "startup_failure"];

/// BR#2267 externals — CI checks that never gate a merge (external Cloudflare
/// workers-builds mirrors, deploy previews). Matched as substrings, case
/// insensitively, against the check NAME.
const MERGE_EXEMPT_CHECK_PATTERNS: [&str; 6] = [
    "workers builds",
    "workers-builds",
    "cloudflare pages",
    "cloudflare workers",
    "deploy preview",
    "codeql",
];

#[derive(Debug, Clone, serde::Serialize)]
pub struct MainCheckRun {
    pub id: i64,
    pub name: Option<String>,
    pub status: Option<String>,
    pub conclusion: Option<String>,
    pub html_url: Option<String>,
}

impl MainCheckRun {
    pub fn name_or_empty(&self) -> &str {
        self.name.as_deref().unwrap_or("")
    }
}

#[derive(Debug, Clone)]
pub struct MainRedCheck {
    pub name: String,
    pub conclusion: String,
    pub url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BaseVerdict {
    Green,
    Red,
    Unsettled,
    Empty,
}

#[derive(Debug, Clone)]
pub struct MainCheckVerdict {
    pub verdict: BaseVerdict,
    pub red: Vec<MainRedCheck>,
    pub unsettled: Vec<String>,
    pub green: u32,
}

#[derive(Debug, Clone)]
pub struct HeadCheckVerdict {
    pub verdict: HeadVerdict,
    pub red: Vec<MainRedCheck>,
    pub unsettled: Vec<String>,
    /// externals that failed but are exempt — human-leg, never gating
    pub external: Vec<MainRedCheck>,
    pub green: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeadVerdict {
    Green,
    Red,
    Unsettled,
}

#[derive(Debug, Clone)]
pub struct PrCommit {
    pub sha: String,
    pub verified: bool,
}

/// What the executor should DO with one gated candidate. Mechanical defects
/// bounce the card when it is in_review (returning to its author); otherwise
/// they are a progress note — the gate never steals a claim.
#[derive(Debug, Clone)]
pub enum MergeAction {
    Merge { receipt: String },
    CloseSuperseded { reason: String },
    Bounce { defect: String },
    Note { reason: String },
    Skip { reason: String },
    HumanLeg { reason: String },
}

impl MergeAction {
    pub fn kind(&self) -> &'static str {
        match self {
            MergeAction::Merge { .. } => "merge",
            MergeAction::CloseSuperseded { .. } => "close_superseded",
            MergeAction::Bounce { .. } => "bounce",
            MergeAction::Note { .. } => "note",
            MergeAction::Skip { .. } => "skip",
            MergeAction::HumanLeg { .. } => "human_leg",
        }
    }
    pub fn defect(&self) -> Option<&str> {
        match self {
            MergeAction::Bounce { defect } => Some(defect),
            _ => None,
        }
    }
    pub fn reason(&self) -> Option<&str> {
        match self {
            MergeAction::CloseSuperseded { reason }
            | MergeAction::Note { reason }
            | MergeAction::Skip { reason }
            | MergeAction::HumanLeg { reason } => Some(reason),
            _ => None,
        }
    }
}

pub fn is_exempt_check_name(name: &str) -> bool {
    let n = name.to_lowercase();
    MERGE_EXEMPT_CHECK_PATTERNS.iter().any(|p| n.contains(p))
}

fn is_red_conclusion(c: &str) -> bool {
    MAIN_RED_CONCLUSIONS.contains(&c)
}

fn is_green_conclusion(c: &str) -> bool {
    c == "success" || c == "skipped" || c == "neutral"
}

/// First 9 chars, the JS `slice(0, 9)` (shas are ascii hex — char-safe).
pub fn short_sha(s: &str) -> &str {
    let end = s.char_indices().nth(9).map(|(i, _)| i).unwrap_or(s.len());
    &s[..end]
}

/// Insertion-ordered grouping by check name (the TS code's Map semantics:
/// first-appearance order of each name is preserved into the verdict vectors).
fn group_by_name(runs: &[MainCheckRun]) -> Vec<(String, Vec<&MainCheckRun>)> {
    let mut order: Vec<String> = Vec::new();
    let mut map: std::collections::HashMap<String, Vec<&MainCheckRun>> = std::collections::HashMap::new();
    for r in runs {
        let name = r.name.clone().unwrap_or_default();
        if !map.contains_key(&name) {
            order.push(name.clone());
        }
        map.entry(name).or_default().push(r);
    }
    order
        .into_iter()
        .map(|name| {
            let list = map.remove(&name).unwrap_or_default();
            (name, list)
        })
        .collect()
}

/// Newest non-cancelled run of a list judges (stable sort by id desc, first
/// non-cancelled) — the cancelled runs say nothing.
fn judge_run<'a>(list: &[&'a MainCheckRun]) -> Option<&'a MainCheckRun> {
    let mut sorted: Vec<&&MainCheckRun> = list.iter().collect();
    sorted.sort_by(|a, b| b.id.cmp(&a.id));
    sorted
        .into_iter()
        .find(|r| r.conclusion.as_deref() != Some("cancelled"))
        .copied()
}

/// The classifier for main's HEAD check runs (BR#3008 stop-the-line). Pure.
pub fn classify_main_check_runs(runs: &[MainCheckRun]) -> MainCheckVerdict {
    if runs.is_empty() {
        return MainCheckVerdict { verdict: BaseVerdict::Empty, red: vec![], unsettled: vec![], green: 0 };
    }
    let mut red: Vec<MainRedCheck> = vec![];
    let mut unsettled: Vec<String> = vec![];
    let mut green: u32 = 0;
    for (name, list) in group_by_name(runs) {
        match judge_run(&list) {
            // every run of this name was cancelled — the name says nothing
            None => unsettled.push(format!("{name} (only cancelled runs)")),
            Some(j) if j.conclusion.is_none() => unsettled.push(name),
            Some(j) => {
                let c = j.conclusion.as_deref().unwrap_or("");
                if is_red_conclusion(c) {
                    red.push(MainRedCheck {
                        name,
                        conclusion: c.to_string(),
                        url: j.html_url.clone().unwrap_or_default(),
                    });
                } else if is_green_conclusion(c) {
                    green += 1;
                } else {
                    unsettled.push(format!("{name} (unknown conclusion: {c})"));
                }
            }
        }
    }
    let verdict = if !red.is_empty() {
        BaseVerdict::Red
    } else if !unsettled.is_empty() {
        BaseVerdict::Unsettled
    } else {
        BaseVerdict::Green
    };
    MainCheckVerdict { verdict, red, unsettled, green }
}

/// The HEAD side of the 5c mechanical gate: same decision rule as
/// classify_main_check_runs, but exempt-external failures (BR#2267) are pulled
/// OUT of red and recorded as `external` — they are collected into the class
/// ask, never bounce a PR.
pub fn classify_head_checks(runs: &[MainCheckRun]) -> HeadCheckVerdict {
    let mut red: Vec<MainRedCheck> = vec![];
    let mut unsettled: Vec<String> = vec![];
    let mut external: Vec<MainRedCheck> = vec![];
    let mut green: u32 = 0;
    for r in runs {
        let name = r.name_or_empty();
        match &r.conclusion {
            None => {
                if is_exempt_check_name(name) {
                    continue; // exempt externals in flight say nothing
                }
                unsettled.push(name.to_string());
            }
            Some(c) => {
                if is_exempt_check_name(name) {
                    if is_red_conclusion(c) {
                        external.push(MainRedCheck {
                            name: name.to_string(),
                            conclusion: c.clone(),
                            url: r.html_url.clone().unwrap_or_default(),
                        });
                    } else if is_green_conclusion(c) {
                        green += 1;
                    }
                    continue;
                }
                if is_red_conclusion(c) {
                    red.push(MainRedCheck {
                        name: name.to_string(),
                        conclusion: c.clone(),
                        url: r.html_url.clone().unwrap_or_default(),
                    });
                } else if is_green_conclusion(c) {
                    green += 1;
                } else {
                    unsettled.push(name.to_string());
                }
            }
        }
    }
    let verdict = if !red.is_empty() {
        HeadVerdict::Red
    } else if !unsettled.is_empty() {
        HeadVerdict::Unsettled
    } else {
        HeadVerdict::Green
    };
    HeadCheckVerdict { verdict, red, unsettled, external, green }
}

pub struct MergeCandidateInput<'a> {
    pub pr_number: i64,
    pub head_sha: &'a str,
    /// classify_main_check_runs verdict on the BASE (main) HEAD
    pub base_verdict: BaseVerdict,
    /// GitHub pull API mergeable; null while GitHub computes it
    pub mergeable: Option<bool>,
    /// GitHub pull API mergeStateStatus (normalized lowercase at the fact
    /// boundary; an empty string is treated absent — the TS `&&` falsy rule)
    pub merge_state_status: Option<&'a str>,
    pub commits: &'a [PrCommit],
    pub head_checks: &'a [MainCheckRun],
    /// the linked BR# card's status, or null when the PR names no card
    pub card_status: Option<&'a str>,
    /// an ACCEPTED verify-verdict decision on the linked card cites this exact headSha
    pub verify_accepted_on_head: bool,
    /// the card has any accepted verify decision (any head)
    pub verify_accepted_any: bool,
}

/// The 5c gate + verify lineage, as one decision table. Order matters:
/// superseded first, then the mechanical gate (mergeable / state / signatures
/// / base / head), then verify lineage, then merge.
pub fn decide_merge_action(i: MergeCandidateInput) -> MergeAction {
    // superseded-check FIRST (BR#3034 queue norm): a superseded card's PR dies
    // before any gate runs.
    if i.card_status == Some("superseded") {
        return MergeAction::CloseSuperseded {
            reason: "linked card is superseded — closing PR without review".into(),
        };
    }
    if i.card_status == Some("done") {
        return MergeAction::Skip {
            reason: "linked card already done — nothing to merge under it".into(),
        };
    }
    let short = short_sha(i.head_sha);
    // (1) mergeability is a precondition, NOT a finding (5c, 2026-10-23)
    if i.mergeable != Some(true) {
        if i.mergeable.is_none() {
            return MergeAction::Skip {
                reason: "GitHub still computing mergeability — not yet, skip this tick".into(),
            };
        }
        return MergeAction::Bounce {
            defect: format!(
                "PR #{} unmergeable — CONFLICTING against base. Rebase, resolve, re-push, re-enter the queue",
                i.pr_number
            ),
        };
    }
    if let Some(state) = i.merge_state_status {
        if !state.is_empty() && state != "clean" && state != "unstable" {
            return MergeAction::Bounce {
                defect: format!(
                    "PR #{} mergeStateStatus={state} — not clean. Fix the named state (rebase/re-sign/re-approve) and re-enter",
                    i.pr_number
                ),
            };
        }
    }
    // (2) every commit GitHub-verified (signed+valid; NO_USER/UNKNOWN are the human leg)
    let unverified = i.commits.iter().filter(|c| !c.verified).count();
    if unverified > 0 {
        return MergeAction::HumanLeg {
            reason: format!(
                "PR #{} has {unverified} commit(s) not GitHub-verified — signing-environment class, never per-PR",
                i.pr_number
            ),
        };
    }
    // (3) base green (BR#3009 destination-green; BR#3008's gate enforces it too)
    if i.base_verdict != BaseVerdict::Green {
        let base_word = if i.base_verdict == BaseVerdict::Red { "RED" } else { "not green" };
        return MergeAction::Skip {
            reason: format!(
                "base main {base_word} — the standing order never merges onto a non-green destination; the stop-the-line sweep owns the alert"
            ),
        };
    }
    // (4) head checks green (BR#2267 externals exempt)
    let head = classify_head_checks(i.head_checks);
    if head.verdict == HeadVerdict::Red {
        let names = head.red.iter().map(|r| r.name.as_str()).collect::<Vec<_>>().join(", ");
        return if i.card_status == Some("in_review") {
            MergeAction::Bounce {
                defect: format!("PR #{} head check RED: {names}. Fix or bounce to impl", i.pr_number),
            }
        } else {
            MergeAction::Note {
                reason: format!(
                    "PR #{} head check RED: {names} — card not in_review, no bounce; the linked session owns it",
                    i.pr_number
                ),
            }
        };
    }
    if head.verdict == HeadVerdict::Unsettled {
        return MergeAction::Skip {
            reason: format!(
                "head checks unsettled ({}) — not yet, skip this tick",
                head.unsettled.join(", ")
            ),
        };
    }
    // (5) verify lineage: an ACCEPTED verify verdict must cover THIS head.
    //     Head moved past an accepted verdict → the sweep's own bounce
    //     (re-verify on head change triggers the normal verify pool).
    if i.card_status == Some("in_review") && i.verify_accepted_any && !i.verify_accepted_on_head {
        return MergeAction::Bounce {
            defect: format!(
                "PR #{} head {short} moved past the accepted verify verdict — re-verify the new head (a mechanical rebase is content-preserving; fresh 5c only)",
                i.pr_number
            ),
        };
    }
    if !i.verify_accepted_on_head {
        return MergeAction::Skip {
            reason: format!(
                "no accepted verify verdict covering head {short} — the verify pool owns the verdict; the sweep merges only verified PRs"
            ),
        };
    }
    MergeAction::Merge {
        receipt: format!(
            "PR #{} merged by the standing merge sweep (BR#3033): head {short} — 5c gate pass (mergeable, clean, {} verified commits), base green, head checks green",
            i.pr_number,
            i.commits.len()
        ),
    }
}

/// Deterministic title for the human-leg class ask (rule 5c: ONE ask per
/// class per episode, never one per PR). Deduped via askCreate's
/// identical-open-ask guard. Always ≤240 chars (the ask contract) and always
/// ends in "?" (also the contract).
pub fn merge_sweep_human_leg_title(repo: &str, reasons: &[String]) -> String {
    let prefix = format!("Merge sweep human legs on {repo}: ");
    let suffix = " — fix the class?";
    // saturating budget (the JS slice would go negative on a pathological
    // repo name — clamping to empty is the honest failure there)
    let budget = (240usize).saturating_sub(prefix.chars().count()).saturating_sub(suffix.chars().count());
    let mut text = reasons.join("; ");
    if text.chars().count() > budget {
        let cut: String = text.chars().take(budget.saturating_sub(1)).collect();
        text = format!("{}\u{2026}", cut.trim_end());
    }
    format!("{prefix}{text}{suffix}")
}

// ---- multi-PR legs (BR#3659: card-per-PR is a LIE for multi-PR parents) ----

/// One leg of a queued card: one cited PR with its accepted-at head.
/// `meta.prs` holds every leg; `meta.pr` stays the FIRST leg (backward compat).
#[derive(Debug, Clone)]
pub struct TrainLeg {
    pub repo: String,
    pub number: i64,
    pub head_sha_at_acceptance: Option<String>,
    pub base: Option<String>,
    pub carry: Option<Value>,
}

/// TS `String(v)` for the leg scalars: present-but-null becomes "null".
fn ts_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        other => other.to_string(),
    }
}

fn ts_number(v: Option<&Value>) -> i64 {
    match v {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

fn leg_from(l: &Value, fallback_repo: Option<&Value>) -> TrainLeg {
    let repo = l
        .get("repo")
        .cloned()
        .or_else(|| fallback_repo.cloned())
        .map(|v| ts_string(&v))
        .unwrap_or_default();
    let head_sha_at_acceptance = l.get("head_sha_at_acceptance").map(ts_string);
    let base = l.get("base").map(ts_string);
    let carry = match l.get("carry") {
        Some(c) if c.is_array() => Some(c.clone()),
        _ => None,
    };
    TrainLeg {
        repo,
        number: ts_number(l.get("number")),
        head_sha_at_acceptance,
        base,
        carry,
    }
}

/// The card's legs: meta.prs when stamped (multi-PR), else the legacy
/// meta.pr single leg. Empty when neither exists.
pub fn train_legs(meta: &Value) -> Vec<TrainLeg> {
    if let Some(prs) = meta.get("prs").and_then(|p| p.as_array()) {
        if !prs.is_empty() {
            let fallback = meta.get("pr").and_then(|p| p.get("repo"));
            return prs.iter().map(|l| leg_from(l, fallback)).collect();
        }
    }
    if let Some(pr) = meta.get("pr") {
        if pr.is_object() {
            return vec![leg_from(pr, None)];
        }
    }
    vec![]
}

/// Is this leg landed? The per-leg map (meta.merge_train.legs — multi-PR)
/// or the legacy card-level landed stamp.
pub fn train_leg_landed(meta: &Value, leg: &TrainLeg) -> bool {
    let mt = meta.get("merge_train").cloned().unwrap_or(Value::Null);
    if let Some(state) = mt
        .get("legs")
        .and_then(|legs| legs.as_object())
        .and_then(|o| o.get(&leg.number.to_string()))
        .and_then(|e| e.get("state"))
        .and_then(|s| s.as_str())
    {
        if state == "landed" {
            return true;
        }
    }
    mt.get("state").and_then(|s| s.as_str()) == Some("landed")
}

/// Does an accepted verdict cover this LEG's head? Same law as
/// verdictCoversHead, reading the leg's own stamp + carry chain — a
/// multi-PR card's legs verify independently (BR#3659).
pub fn verdict_covers_head_leg(leg: Option<&TrainLeg>, head_sha: &str) -> bool {
    let Some(leg) = leg else { return false };
    let stamped = leg.head_sha_at_acceptance.as_deref().unwrap_or("").to_lowercase();
    head_covered_by(&stamped, leg.carry.as_ref(), &head_sha.to_lowercase())
}

/// TS regex `/^[0-9a-f]{7,40}$/` — lowercase hex, 7..=40 chars.
fn is_sha_token(s: &str) -> bool {
    (7..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Does an accepted verdict cover this head? The straight stamp
/// (head_sha_at_acceptance === head) or a CONTIGUOUS carry chain
/// stamped → … → head. A break anywhere is uncovered — fail-closed, the
/// verdict must be re-rendered at the new head. Prefix-compatible: a 9-hex
/// stamp covers the full 40-hex it prefixes, never the reverse.
fn head_covered_by(stamped: &str, carry: Option<&Value>, target: &str) -> bool {
    if !is_sha_token(stamped) || !is_sha_token(target) {
        return false;
    }
    let mut cur = stamped.to_string();
    if target.starts_with(&cur) || cur.starts_with(target) {
        return true;
    }
    let Some(list) = carry.and_then(|c| c.as_array()) else {
        return false;
    };
    for c in list {
        let from = c.get("from_head").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
        let to = c.get("to_head").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
        if from != cur || !is_sha_token(&to) {
            return false;
        }
        cur = to;
    }
    target.starts_with(&cur) || cur.starts_with(&target)
}

pub struct TrainGateInput<'a> {
    pub pr_number: i64,
    /// the LIVE head sha from GitHub (executor-fetched, never the card's claim)
    pub head_sha: &'a str,
    /// the linked impl card's meta (carries meta.pr — the stamp + carry chain)
    pub card_meta: &'a Value,
    pub card_status: Option<&'a str>,
    pub base_verdict: BaseVerdict,
    pub mergeable: Option<bool>,
    pub merge_state_status: Option<&'a str>,
    pub commits: &'a [PrCommit],
    pub head_checks: &'a [MainCheckRun],
    /// BR#3659: which leg of the card's PR list this gate drives (1-based
    /// position in meta.prs)
    pub leg_number: Option<i64>,
}

/// The per-candidate gate the executor runs before merging (BR#3516 §2),
/// each leg fail-closed: verdict coverage (stamp or contiguous carry) ·
/// base-green · mergeable=MERGEABLE with bound-wait through null · every
/// commit GitHub-verified · head checks green (BR#2267 externals exempt).
/// Composes the standing decideMergeAction; the train layer adds the
/// carry law the sweep never had. BR#3659: coverage is judged per LEG.
pub fn decide_train_gate(i: TrainGateInput) -> MergeAction {
    if i.card_status == Some("superseded") {
        return MergeAction::CloseSuperseded {
            reason: "linked card is superseded — closing PR without review".into(),
        };
    }
    if i.card_status == Some("done") {
        return MergeAction::Skip {
            reason: "linked card already done — nothing to merge under it".into(),
        };
    }
    let legs = train_legs(i.card_meta);
    let leg_number = i.leg_number.unwrap_or(1).max(1);
    let leg = if legs.len() >= leg_number as usize { legs.get(leg_number as usize - 1).cloned() } else { None };
    if !verdict_covers_head_leg(leg.as_ref(), i.head_sha) {
        let stamped = leg
            .and_then(|l| l.head_sha_at_acceptance.clone())
            .map(|s| short_sha(&s).to_string())
            .unwrap_or_else(|| "(no stamp)".into());
        return MergeAction::Bounce {
            defect: format!(
                "PR #{} live head {} is not covered by the accepted verdict (leg {leg_number} stamped {stamped}, no contiguous carry chain) — head moved past the verdict without a machine-clean update; re-verify at the new head",
                i.pr_number,
                short_sha(i.head_sha)
            ),
        };
    }
    let gate = decide_merge_action(MergeCandidateInput {
        pr_number: i.pr_number,
        head_sha: i.head_sha,
        base_verdict: i.base_verdict,
        mergeable: i.mergeable,
        merge_state_status: i.merge_state_status,
        commits: i.commits,
        head_checks: i.head_checks,
        card_status: i.card_status,
        verify_accepted_on_head: true,
        verify_accepted_any: true,
    });
    match gate {
        MergeAction::Merge { .. } => MergeAction::Merge {
            receipt: format!(
                "PR #{} merged by the serialized merge train (BR#3516) leg {leg_number}/{}: head {} — verdict covers head (stamp/carry), 5c gate pass (mergeable, clean, {} verified commits), base green, head checks green",
                i.pr_number,
                legs.len().max(1),
                short_sha(i.head_sha),
                i.commits.len()
            ),
        },
        other => other,
    }
}

// ---- the BR#3714 fact-boundary normalizers ----

/// gh's `mergeable` is the GraphQL enum STRING "MERGEABLE"|"CONFLICTING"|
/// "UNKNOWN" (null while GitHub computes) — but the 5c gate compares
/// `mergeable !== true` (boolean). REST-shaped booleans pass through;
/// anything else is null (wait this tick, never a bounce).
pub fn normalize_gh_mergeable(v: &Value) -> Option<bool> {
    match v {
        Value::Bool(true) => Some(true),
        Value::Bool(false) => Some(false),
        Value::String(s) if s == "MERGEABLE" => Some(true),
        Value::String(s) if s == "CONFLICTING" => Some(false),
        _ => None, // "UNKNOWN", null, anything else
    }
}

/// gh's `mergeStateStatus` is UPPERCASE ("CLEAN"|"UNSTABLE"|"BEHIND"|…)
/// while the gate compares lowercase — normalize at the same boundary
/// (BR#3714), so a real state is named honestly instead of every PR
/// reading as unmergeable.
pub fn normalize_gh_merge_state(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.to_lowercase()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// tests — pin the port case by case (messages byte-identical to the TS gate)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn run(id: i64, name: &str, conclusion: Option<&str>) -> MainCheckRun {
        MainCheckRun {
            id,
            name: Some(name.into()),
            status: None,
            conclusion: conclusion.map(|c| c.into()),
            html_url: Some(format!("https://example/{id}")),
        }
    }

    fn commit(sha: &str, verified: bool) -> PrCommit {
        PrCommit { sha: sha.into(), verified }
    }

    #[test]
    fn normalizers_pin_the_3714_fact_boundary() {
        // GraphQL enum strings, REST booleans, and the wait-through-null law
        assert_eq!(normalize_gh_mergeable(&Value::String("MERGEABLE".into())), Some(true));
        assert_eq!(normalize_gh_mergeable(&Value::String("CONFLICTING".into())), Some(false));
        assert_eq!(normalize_gh_mergeable(&Value::String("UNKNOWN".into())), None);
        assert_eq!(normalize_gh_mergeable(&Value::Null), None);
        assert_eq!(normalize_gh_mergeable(&Value::Bool(true)), Some(true));
        assert_eq!(normalize_gh_mergeable(&Value::Bool(false)), Some(false));
        assert_eq!(normalize_gh_merge_state(&Value::String("CLEAN".into())).as_deref(), Some("clean"));
        assert_eq!(normalize_gh_merge_state(&Value::String("BEHIND".into())).as_deref(), Some("behind"));
        assert_eq!(normalize_gh_merge_state(&Value::Null), None);
    }

    #[test]
    fn classify_main_empty_red_unsettled_green_and_cancelled_judge() {
        let v = classify_main_check_runs(&[]);
        assert_eq!(v.verdict, BaseVerdict::Empty);
        // a cancelled run says nothing — the newest non-cancelled judges
        let v = classify_main_check_runs(&[run(1, "CI", Some("failure")), run(2, "CI", Some("cancelled"))]);
        assert_eq!(v.verdict, BaseVerdict::Red);
        assert_eq!(v.red.len(), 1);
        assert_eq!(v.red[0].conclusion, "failure");
        // ALL cancelled → the name is unsettled with the (only cancelled) marker
        let v = classify_main_check_runs(&[run(1, "CI", Some("cancelled")), run(2, "CI", Some("cancelled"))]);
        assert_eq!(v.verdict, BaseVerdict::Unsettled);
        assert_eq!(v.unsettled, vec!["CI (only cancelled runs)".to_string()]);
        // null conclusion → unsettled by name only; unknown → named conclusion
        let v = classify_main_check_runs(&[run(1, "A", None), run(2, "B", Some("weird"))]);
        assert_eq!(v.unsettled, vec!["A".to_string(), "B (unknown conclusion: weird)".to_string()]);
        // green counts settled greens; newest run wins on the same name
        let v = classify_main_check_runs(&[run(1, "CI", Some("failure")), run(3, "CI", Some("success")), run(4, "Lint", Some("skipped"))]);
        assert_eq!(v.verdict, BaseVerdict::Green);
        assert_eq!(v.green, 2);
        // first-appearance order names the reds in that order
        let v = classify_main_check_runs(&[run(1, "Zed", Some("timed_out")), run(2, "Alpha", Some("failure"))]);
        assert_eq!(v.red.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), vec!["Zed", "Alpha"]);
    }

    #[test]
    fn classify_head_pulls_exempt_externals_out_of_red() {
        let runs = vec![
            run(1, "Deploy Preview", Some("failure")), // exempt external → external, never red
            run(2, "CodeQL", Some("failure")),         // exempt external
            run(3, "CI", Some("failure")),             // real red
            run(4, "CF Workers Builds", None),         // exempt in flight → silent
            run(5, "Lint", None),                      // non-exempt in flight → unsettled
        ];
        let v = classify_head_checks(&runs);
        // red outranks unsettled, and externals ride alongside
        assert_eq!(v.verdict, HeadVerdict::Red);
        assert_eq!(v.external.len(), 2);
        assert_eq!(v.unsettled, vec!["Lint".to_string()]);
        // externals only: green verdict (they never gate)
        let v = classify_head_checks(&[run(1, "cloudflare pages", Some("failure")), run(2, "CI", Some("success"))]);
        assert_eq!(v.verdict, HeadVerdict::Green);
        assert_eq!(v.green, 1);
    }

    #[test]
    fn decide_merge_superseded_and_done_die_before_the_gate() {
        let mk = |status: Option<&str>| {
            decide_merge_action(MergeCandidateInput {
                pr_number: 7,
                head_sha: "aaaaaaaaaaaaaaaaaaaa",
                base_verdict: BaseVerdict::Red, // would skip — but status fires first
                mergeable: Some(false),
                merge_state_status: None,
                commits: &[],
                head_checks: &[],
                card_status: status,
                verify_accepted_on_head: false,
                verify_accepted_any: false,
            })
        };
        assert_eq!(mk(Some("superseded")).kind(), "close_superseded");
        assert_eq!(
            mk(Some("superseded")).reason(),
            Some("linked card is superseded — closing PR without review")
        );
        assert_eq!(mk(Some("done")).kind(), "skip");
        assert_eq!(mk(Some("done")).reason(), Some("linked card already done — nothing to merge under it"));
    }

    #[test]
    fn decide_merge_mergeability_rows_including_the_empty_state_fidelity_fix() {
        let mk = |mergeable: Option<bool>, state: Option<&str>| {
            decide_merge_action(MergeCandidateInput {
                pr_number: 9,
                head_sha: "0123456789abcdef",
                base_verdict: BaseVerdict::Green,
                mergeable,
                merge_state_status: state,
                commits: &[],
                head_checks: &[],
                card_status: Some("in_review"),
                verify_accepted_on_head: true,
                verify_accepted_any: true,
            })
        };
        // null = GitHub computing → wait, never bounce
        let a = mk(None, None);
        assert_eq!(a.kind(), "skip");
        assert_eq!(a.reason(), Some("GitHub still computing mergeability — not yet, skip this tick"));
        // false = CONFLICTING → the 5c mechanical bounce, exact copy
        let b = mk(Some(false), Some("dirty"));
        assert_eq!(b.kind(), "bounce");
        assert_eq!(
            b.defect(),
            Some("PR #9 unmergeable — CONFLICTING against base. Rebase, resolve, re-push, re-enter the queue")
        );
        // non-clean state names itself
        let c = mk(Some(true), Some("blocked"));
        assert_eq!(
            c.defect(),
            Some("PR #9 mergeStateStatus=blocked — not clean. Fix the named state (rebase/re-sign/re-approve) and re-enter")
        );
        // fidelity: an EMPTY string state is TS-falsy → treated absent, no bounce;
        // zero commits → no unverified row; base green, no head checks, and the
        // gate falls through to the verify row: accepted_on_head=true → merge
        assert_eq!(mk(Some(true), Some("")).kind(), "merge");
        let d = mk(Some(true), Some(""));
        assert_eq!(d.kind(), "merge");
        // unstable passes (the carry law's re-check window)
        assert_eq!(mk(Some(true), Some("unstable")).kind(), "merge");
    }

    #[test]
    fn decide_merge_unsigned_commits_are_the_human_leg() {
        let a = decide_merge_action(MergeCandidateInput {
            pr_number: 12,
            head_sha: "0123456789abcdef",
            base_verdict: BaseVerdict::Green,
            mergeable: Some(true),
            merge_state_status: Some("clean"),
            commits: &[commit("a".repeat(40).as_str(), true), commit("b".repeat(40).as_str(), false)],
            head_checks: &[],
            card_status: Some("in_review"),
            verify_accepted_on_head: true,
            verify_accepted_any: true,
        });
        assert_eq!(a.kind(), "human_leg");
        assert_eq!(
            a.reason(),
            Some("PR #12 has 1 commit(s) not GitHub-verified — signing-environment class, never per-PR")
        );
    }

    #[test]
    fn decide_merge_base_and_head_rows() {
        let mk = |base: BaseVerdict, checks: &[MainCheckRun], card: Option<&str>| {
            decide_merge_action(MergeCandidateInput {
                pr_number: 3,
                head_sha: "0123456789abcdef",
                base_verdict: base,
                mergeable: Some(true),
                merge_state_status: Some("clean"),
                commits: &[],
                head_checks: checks,
                card_status: card,
                verify_accepted_on_head: true,
                verify_accepted_any: true,
            })
        };
        let red_base = mk(BaseVerdict::Red, &[], Some("in_review"));
        assert_eq!(
            red_base.reason(),
            Some("base main RED — the standing order never merges onto a non-green destination; the stop-the-line sweep owns the alert")
        );
        let not_green = mk(BaseVerdict::Unsettled, &[], Some("in_review"));
        assert!(not_green.reason().unwrap().starts_with("base main not green —"));
        // head red: in_review → bounce; otherwise → note
        let head_red = [run(1, "CI", Some("startup_failure"))];
        let b = mk(BaseVerdict::Green, &head_red, Some("in_review"));
        assert_eq!(b.kind(), "bounce");
        assert_eq!(b.defect(), Some("PR #3 head check RED: CI. Fix or bounce to impl"));
        let n = mk(BaseVerdict::Green, &head_red, Some("blocked"));
        assert_eq!(n.kind(), "note");
        assert_eq!(
            n.reason(),
            Some("PR #3 head check RED: CI — card not in_review, no bounce; the linked session owns it")
        );
        // unsettled head names the checks
        let u = mk(BaseVerdict::Green, &[run(1, "Lint", None)], Some("in_review"));
        assert_eq!(u.reason(), Some("head checks unsettled (Lint) — not yet, skip this tick"));
    }

    #[test]
    fn decide_merge_merge_receipt_exact() {
        let a = decide_merge_action(MergeCandidateInput {
            pr_number: 42,
            head_sha: "d259e130e455b416463cbf8746",
            base_verdict: BaseVerdict::Green,
            mergeable: Some(true),
            merge_state_status: Some("clean"),
            commits: &[commit("a".repeat(40).as_str(), true), commit("b".repeat(40).as_str(), true), commit("c".repeat(40).as_str(), true)],
            head_checks: &[run(1, "CI", Some("success"))],
            card_status: Some("in_review"),
            verify_accepted_on_head: true,
            verify_accepted_any: true,
        });
        assert_eq!(a.kind(), "merge");
        match a {
            MergeAction::Merge { receipt } => assert_eq!(
                receipt,
                "PR #42 merged by the standing merge sweep (BR#3033): head d259e130e — 5c gate pass (mergeable, clean, 3 verified commits), base green, head checks green"
            ),
            other => panic!("expected merge, got {}", other.kind()),
        }
    }

    #[test]
    fn train_gate_coverage_rows_stamp_prefix_carry_and_bounce() {
        // 9-hex stamp covers the 40-hex prefix; carry chain covers; break bounces
        let head = "e".repeat(40);
        let covered = serde_json::json!({ "pr": { "repo": "state-vector/bridge", "number": 5, "head_sha_at_acceptance": &head[..9] } });
        let g = decide_train_gate(TrainGateInput {
            pr_number: 5,
            head_sha: &head,
            card_meta: &covered,
            card_status: Some("in_review"),
            base_verdict: BaseVerdict::Green,
            mergeable: Some(true),
            merge_state_status: Some("clean"),
            commits: &[],
            head_checks: &[],
            leg_number: Some(1),
        });
        assert_eq!(g.kind(), "merge");
        match g {
            MergeAction::Merge { receipt } => assert_eq!(
                receipt,
                "PR #5 merged by the serialized merge train (BR#3516) leg 1/1: head eeeeeeeee — verdict covers head (stamp/carry), 5c gate pass (mergeable, clean, 0 verified commits), base green, head checks green"
            ),
            other => panic!("expected merge, got {}", other.kind()),
        }
        // uncovered head → bounce naming ITS stamp
        let uncovered = serde_json::json!({ "pr": { "repo": "state-vector/bridge", "number": 5, "head_sha_at_acceptance": "1234567890" } });
        let b = decide_train_gate(TrainGateInput {
            pr_number: 5,
            head_sha: &head,
            card_meta: &uncovered,
            card_status: Some("in_review"),
            base_verdict: BaseVerdict::Green,
            mergeable: Some(true),
            merge_state_status: Some("clean"),
            commits: &[],
            head_checks: &[],
            leg_number: Some(1),
        });
        assert_eq!(b.kind(), "bounce");
        assert_eq!(
            b.defect(),
            Some("PR #5 live head eeeeeeeee is not covered by the accepted verdict (leg 1 stamped 123456789, no contiguous carry chain) — head moved past the verdict without a machine-clean update; re-verify at the new head")
        );
        // contiguous carry chain covers; a broken chain does not
        let chained = serde_json::json!({ "prs": [ {
            "repo": "r/x", "number": 6, "head_sha_at_acceptance": "aaaaaaaaa1",
            "carry": [ { "from_head": "aaaaaaaaa1", "to_head": "bbbbbbbbb2" } ] } ] });
        assert!(verdict_covers_head_leg(train_legs(&chained).first(), format!("bbbbbbbbb2{}", "b".repeat(30)).as_str()));
        let broken = serde_json::json!({ "prs": [ {
            "repo": "r/x", "number": 6, "head_sha_at_acceptance": "aaaaaaaaa1",
            "carry": [ { "from_head": "ccccccccc3", "to_head": "bbbbbbbbb2" } ] } ] });
        assert!(!verdict_covers_head_leg(train_legs(&broken).first(), format!("bbbbbbbbb2{}", "b".repeat(30)).as_str()));
        // no stamp at all → the "(no stamp)" bounce copy
        let nostamp = serde_json::json!({ "pr": { "repo": "r/x", "number": 7 } });
        let b2 = decide_train_gate(TrainGateInput {
            pr_number: 7,
            head_sha: "aaaaaaaaaaa",
            card_meta: &nostamp,
            card_status: None,
            base_verdict: BaseVerdict::Green,
            mergeable: Some(true),
            merge_state_status: Some("clean"),
            commits: &[],
            head_checks: &[],
            leg_number: None,
        });
        assert!(b2.defect().unwrap().contains("(leg 1 stamped (no stamp), no contiguous carry chain)"));
        // superseded/done still fire before coverage
        let empty_meta = serde_json::json!({});
        let s = decide_train_gate(TrainGateInput {
            pr_number: 7,
            head_sha: "aaaaaaaaaaa",
            card_meta: &empty_meta,
            card_status: Some("superseded"),
            base_verdict: BaseVerdict::Green,
            mergeable: Some(true),
            merge_state_status: Some("clean"),
            commits: &[],
            head_checks: &[],
            leg_number: None,
        });
        assert_eq!(s.kind(), "close_superseded");
    }

    #[test]
    fn legs_multi_pr_legacy_and_landed() {
        let multi = serde_json::json!({
            "prs": [
                { "repo": "r/a", "number": 1, "head_sha_at_acceptance": "aaaaaaaaa1" },
                { "repo": "r/b", "number": 2, "base": "main" }
            ],
            "merge_train": { "legs": { "1": { "state": "landed" } } }
        });
        let legs = train_legs(&multi);
        assert_eq!(legs.len(), 2);
        assert_eq!(legs[0].repo, "r/a");
        assert!(train_leg_landed(&multi, &legs[0]));
        assert!(!train_leg_landed(&multi, &legs[1]));
        // legacy single leg
        let legacy = serde_json::json!({ "pr": { "repo": "r/c", "number": 3 } });
        let legs = train_legs(&legacy);
        assert_eq!(legs.len(), 1);
        assert_eq!(legs[0].number, 3);
        assert_eq!(legs[0].repo, "r/c");
        // neither → empty
        assert!(train_legs(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn human_leg_title_contract_le240_and_ends_question_mark() {
        let t = merge_sweep_human_leg_title("state-vector/bridge", &["PR #1 has 1 commit(s) not GitHub-verified".into()]);
        assert!(t.ends_with("?"));
        assert!(t.chars().count() <= 240);
        assert!(t.starts_with("Merge sweep human legs on state-vector/bridge: "));
        // truncation keeps the contract: budget respected, ellipsis, still "?"
        let long = vec!["x".repeat(300)];
        let t = merge_sweep_human_leg_title("r", &long);
        assert!(t.chars().count() <= 240);
        assert!(t.ends_with("?"));
        assert!(t.contains('\u{2026}'));
    }
}
