//! train_canary.rs — the merge-train canary (`bridge train-canary`, BR#4694,
//! layer L4.3 of the accepted defence-in-depth programme BR#4633). Extends
//! the hub self-canary pattern (BR#4177, `canary.rs`) to the train itself.
//!
//! A daily synthetic fixture card rides the FULL lane with the real
//! machinery — pool claim → signed labeled doc-touch PR → derived queue →
//! gate → merge → await-CI → landed → card closed — and a red alarm goes to
//! the alarm sink (BR#3124 lane) the moment any phase sticks past its bound:
//!
//!   claim ≤ 15m   (the executor-outage tripwire: the 2026-10-28 outage
//!                  would have been caught here in 15m, not ~64m)
//!   work  ≤ 15m   (claimed but no PR stamp landing — same outage class)
//!   queue ≤ 30m   stuck — NO lane progress (backlog is not stuck: the clock
//!                  resets whenever cards ahead of the fixture shrink or the
//!                  lane's in-flight merge changes; a genuinely halted lane
//!                  red-alarms)
//!   CI    ≤ 60m   merge commit green-or-landed (the hub's own fail-closed
//!                  bound is 3×20m — the canary reds exactly there)
//!   park  ≤ 15m   any non-queue park (bounce repair, watchdog release)
//!
//! Division of labour — the canary is a CLIENT of the hub (same law as
//! canary.rs): pure MCP, no GitHub writes, never self-certifies. The GitHub
//! legs (branch, commit, push, PR, label) are executed by whichever real
//! executor session claims the fixture card, following the card body; the
//! self-stamped leg head is the canary's review EXEMPTION — it tests
//! mechanics, not judgment (BR#4694 scope; signature gates stay absolute).
//!
//! Ledger law: the executor tags canary=true on the fixture's train_events;
//! this watcher VERIFIES the tag on the merged/landed rows (legger-tag leg)
//! so the BR#4363 throughput panel can exclude canary merges without lying.
//!
//! Fixture law (canary.rs): tagged `train-canary`, `meta.canary=true`,
//! parked inert with a 30-day timer on retire; at most ONE live fixture.
//! Red path: ONE deduped ask per failing class, bound to the alarm sink.
//! Every run stamps a `[train-canary]` progress report; 48h of silence on
//! that feed is the canary's own liveness alarm.
//!
//! Exit codes (cron-visible): 0 = green, 1 = red, 2 = fatal config.

use crate::canary::{iso, run_stamp};
use serde_json::{json, Value};
use std::io::Write;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SESSION: &str = "train-canary";
const RPC_TIMEOUT: Duration = Duration::from_secs(60);
const POLL_EVERY: Duration = Duration::from_secs(30);

/// Phase bounds (BR#4694 scope: queue > 30m, CI > 60m, park > 15m; the
/// claim/work tripwires are the 15m outage catch from the design history).
const CLAIM_BOUND_SECS: u64 = 900;
const WORK_BOUND_SECS: u64 = 900;
const QUEUE_BOUND_SECS: u64 = 1_800;
const CI_BOUND_SECS: u64 = 3_600;
const PARK_BOUND_SECS: u64 = 900;
/// A landed-but-unclosed window before we stop waiting for the landedFlow
/// close (the hub closes on the same landed event; this is pure slack).
const CLOSE_SLACK_SECS: u64 = 300;

const RETIRE_TIMER_MS: u64 = 30 * 24 * 3600 * 1000;
/// "Already green today" window: a landed fixture within 26h ends the run
/// green without spawning a second PR (idempotent daily cron).
const FRESH_GREEN_MS: u64 = 26 * 3600 * 1000;

const DEFAULT_SINK: &str = "BR#3124";
const DEFAULT_REPO: &str = "state-vector/bridge";
const BASE: &str = "main";
pub(crate) const CARD_TAG: &str = "train-canary";

struct Ctx {
    http: reqwest::blocking::Client,
    hub: String,
    token: String,
    sink: String,
    repo: String,
    rpc_id: u64,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn trunc(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn log(msg: &str) {
    let _ = writeln!(std::io::stdout(), "[{}] {msg}", iso(now_ms()));
    let _ = std::io::stdout().flush();
}

fn vstr<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str())
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
        let sink = Self::flag(args, "--sink")
            .or_else(|| std::env::var("TRAIN_CANARY_SINK_ID").ok())
            .unwrap_or_else(|| DEFAULT_SINK.to_string());
        let repo = Self::flag(args, "--repo")
            .or_else(|| std::env::var("TRAIN_CANARY_REPO").ok())
            .unwrap_or_else(|| DEFAULT_REPO.to_string());
        Ok(Ctx {
            http: reqwest::blocking::Client::builder().timeout(RPC_TIMEOUT).build().map_err(|e| e.to_string())?,
            hub: hub.trim_end_matches('/').to_string(),
            token,
            sink,
            repo,
            rpc_id: 0,
        })
    }

    /// MCP over the hub's /mcp — the same JSON-RPC surface the agents use
    /// (identical to canary.rs; the canary is a client, never an insider).
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

    fn get_artefact(&mut self, id: &str) -> Result<Value, String> {
        self.mcp("get_artefact", json!({ "id": id }))
    }

    fn get_history(&mut self, id: &str) -> Result<Value, String> {
        self.mcp("get_history", json!({ "id": id }))
    }

    fn train_status(&mut self) -> Result<Value, String> {
        self.mcp("train_status", json!({ "repo": self.repo }))
    }

    fn train_history(&mut self, pr: i64) -> Result<Value, String> {
        self.mcp("train_history", json!({ "repo": self.repo, "pr": pr }))
    }

    fn transition(&mut self, id: &str, to: &str, note: &str, unblock: Option<&str>, until_ts: Option<u64>) -> Result<Value, String> {
        let mut body = json!({ "id": id, "to": to, "note": note });
        if let Some(u) = unblock {
            body["unblock_condition"] = json!(u);
        }
        if let Some(ts) = until_ts {
            body["await_event"] = json!({ "event": "time", "until_ts": ts });
        }
        self.mcp("transition", body)
    }

    fn create_fixture(&mut self, title: &str, body: &str, marker: &str) -> Result<String, String> {
        let r = self.mcp(
            "create_artefact",
            json!({
                "type": "task",
                "title": title,
                "body_md": body,
                "tags": [CARD_TAG],
                "qualified": true,
                "roles": ["impl"],
                "meta": {
                    "canary": true,
                    "train_canary": { "spawned_at": now_ms(), "repo": self.repo, "base": BASE, "marker": marker },
                },
            }),
        )?;
        artefact_id(&r).ok_or_else(|| format!("create returned no id: {}", trunc(&r.to_string(), 200)))
    }
}

/// Parse the created artefact's id out of a create_artefact payload (the MCP
/// layer has shipped several shapes — accept them all; same as canary.rs).
fn artefact_id(v: &Value) -> Option<String> {
    if let Some(id) = vstr(v, "id") {
        return Some(id.to_string());
    }
    if let Some(id) = v.get("artefact").and_then(|a| vstr(a, "id")) {
        return Some(id.to_string());
    }
    if let Some(a) = v.get("artefacts").and_then(|x| x.as_array()) {
        if let Some(first) = a.first() {
            if let Some(id) = vstr(first, "id") {
                return Some(id.to_string());
            }
        }
    }
    None
}

// ---------- the phase machine (pure, unit-tested) ----------

/// Where the fixture card is in the lane ride. Derived ONLY from board facts
/// (card status + meta.merge_train), never from watcher optimism.
#[derive(PartialEq, Clone, Copy, Debug)]
pub(crate) enum Phase {
    /// todo — spawned, not yet claimed by any executor session
    WaitingClaim,
    /// in_progress — the executor leg is building the PR
    Working,
    /// blocked with the canonical queued stamp / merge-train reason
    Queued,
    /// merged on the lane, awaiting the merge commit's CI
    AwaitingCi,
    /// landed — waiting for (or past) the landedFlow close
    Landed,
    /// done — the full ride finished green
    Closed,
    /// bounced / in repair park
    ParkedRepair,
    /// blocked on something that is NOT the queue (watchdog release, …)
    ParkedOther,
    /// superseded — someone killed the fixture
    Killed,
    /// retired by a previous watcher run (inert — do not adopt, do not red)
    Retired,
}

fn merge_train_state(card: &Value) -> Option<&str> {
    card.pointer("/meta/merge_train/state").and_then(|v| v.as_str())
}

fn card_status<'a>(card: &'a Value) -> &'a str {
    vstr(card, "status").unwrap_or("")
}

/// The card's blocked reason — watchdog releases, bounce briefs, queue
/// stamps all surface here; the queue contract (BR#4079) keys on its prefix.
fn blocked_reason(card: &Value) -> &str {
    card.pointer("/meta/blocked/reason")
        .and_then(|v| v.as_str())
        .or_else(|| card.pointer("/meta/blocked_reason").and_then(|v| v.as_str()))
        .unwrap_or("")
}

/// The per-leg awaiting-ci/landed stamp (meta.merge_train.legs[String(pr)]).
fn leg_state(card: &Value, pr: i64) -> Option<&str> {
    card.pointer(&format!("/meta/merge_train/legs/{pr}/state")).and_then(|v| v.as_str())
}

/// The fixture PR the card cites (meta.pr.number).
fn fixture_pr(card: &Value) -> i64 {
    card.pointer("/meta/pr/number").and_then(|v| v.as_i64()).unwrap_or(0)
}

pub(crate) fn derive_phase(card: &Value) -> Phase {
    if card.pointer("/meta/canary").and_then(|v| v.as_bool()) != Some(true) {
        // not our fixture (defensive: adopt logic only ever hands us canaries)
        return Phase::Retired;
    }
    match card_status(card) {
        "done" => return Phase::Closed,
        "superseded" => return Phase::Killed,
        _ => {}
    }
    if merge_train_state(card) == Some("retired") {
        return Phase::Retired;
    }
    // the cited leg's own stamp WINS over the card-level state: after a
    // partial multi-leg landing the card-level state reverts to "queued"
    // while this leg is awaiting-ci/landed — the ride watches ITS leg.
    match leg_state(card, fixture_pr(card)) {
        Some("landed") => return Phase::Landed,
        Some("awaiting-ci") => return Phase::AwaitingCi,
        _ => {}
    }
    match merge_train_state(card) {
        Some("landed") => return Phase::Landed,
        Some("awaiting-ci") => return Phase::AwaitingCi,
        Some("queued") => return Phase::Queued,
        Some("bounced") => return Phase::ParkedRepair,
        _ => {}
    }
    // no (fresh) merge_train stamp — read the lifecycle raw
    match card_status(card) {
        "todo" => Phase::WaitingClaim,
        "in_progress" => Phase::Working,
        "blocked" => {
            if blocked_reason(card).starts_with("merge-train: awaiting-ci") {
                Phase::AwaitingCi
            } else if blocked_reason(card).starts_with("merge-train:") {
                Phase::Queued
            } else {
                Phase::ParkedOther
            }
        }
        _ => Phase::ParkedOther,
    }
}

/// Queue-stall detection inputs: what the lane looked like on the last poll.
#[derive(Clone, Debug)]
struct LaneSnap {
    /// ids queued ahead of the fixture (sorted as the hub derives them)
    ahead: Vec<String>,
    /// the lane's in-flight merge identity (pr + phase), None when idle
    currently: Option<(i64, String)>,
    /// the lane's last ledger event ts
    last_event_ts: u64,
}

impl LaneSnap {
    /// From a train_status payload for `repo@BASE` + the fixture's card id.
    fn from_status(status: &Value, repo: &str, card_id: &str) -> LaneSnap {
        let lane = status
            .get("lanes")
            .and_then(|l| l.as_array())
            .and_then(|lanes| lanes.iter().find(|l| vstr(l, "lane") == Some(&format!("{repo}@{BASE}"))))
            .cloned()
            .unwrap_or(Value::Null);
        let mut ahead: Vec<String> = Vec::new();
        if let Some(q) = lane.get("queue").and_then(|q| q.as_array()) {
            for entry in q {
                match vstr(entry, "id") {
                    Some(id) if id == card_id => break,
                    Some(id) => ahead.push(id.to_string()),
                    _ => {}
                }
            }
        }
        let currently = lane
            .pointer("/currently/phase")
            .and_then(|p| p.as_str())
            .map(|phase| (lane.pointer("/currently/pr").and_then(|v| v.as_i64()).unwrap_or(0), phase.to_string()));
        let last_event_ts = lane.pointer("/activity/last_event/ts").and_then(|v| v.as_u64()).unwrap_or(0);
        LaneSnap { ahead, currently, last_event_ts }
    }

    /// Did ANYTHING on the lane move since the previous poll? (The queue
    /// clock only accrues through stillness — backlog is not stuck.)
    fn progressed_since(&self, prev: &Option<LaneSnap>) -> bool {
        match prev {
            None => true,
            Some(p) => p.ahead != self.ahead || p.currently != self.currently || p.last_event_ts != self.last_event_ts,
        }
    }
}

/// The ledger-tag leg: the fixture's merged/landed train_events must carry
/// detail.canary=true — the contract that lets BR#4363 metrics exclude them.
/// Returns (missing_canary_events, observed_events); a missing merged row
/// counts as observed=0 (the event may not have fired yet — not a defect).
fn ledger_canary_gap(hist: &Value) -> (usize, usize) {
    let mut missing = 0usize;
    let mut observed = 0usize;
    let events = hist.get("events").or_else(|| hist.get("history")).or_else(|| hist.get("versions")).and_then(|v| v.as_array());
    if let Some(rows) = events {
        for row in rows {
            let kind = vstr(row, "kind").unwrap_or("");
            if kind != "merged" && kind != "landed" {
                continue;
            }
            observed += 1;
            let canary = row
                .get("detail")
                .map(|d| match d {
                    Value::String(s) => serde_json::from_str::<Value>(s).ok(),
                    other => Some(other.clone()),
                })
                .and_then(|d| d)
                .and_then(|d| d.get("canary").and_then(|c| c.as_bool()))
                .unwrap_or(false);
            if !canary {
                missing += 1;
            }
        }
    }
    (missing, observed)
}

// ---------- the fixture card body (the executor leg's contract) ----------

const BODY_TMPL: &str = r#"SYNTHETIC train-canary fixture (BR#4694 — merge-train lane ride L4.3). Trivial by design; do NOT expand scope, do NOT write product code.

You are the canary's executor leg: put a signed, labeled, trivial doc-touch PR on the merge train, park this card queued, end your run. The train does the rest (queue → gate → merge → CI → landed → close); the watcher (`bridge train-canary`) scores the ride and alarms if any phase sticks.

1. Orient.
2. In your worktree of {REPO}: `git fetch origin main && git checkout -b train-canary/{MARKER} origin/main`.
3. Append one line `- {MARKER} — train-canary lane ride` to `docs/train-canary-log.md` (create the file with a `# Merge-train canary log` heading first, if missing).
4. Commit (your environment signs commits — the signature gate is absolute) and push the branch.
5. Open the PR against `main`:
   `gh label create train-canary --repo {REPO} --color 888888 --description "merge-train canary fixture (BR#4694)" 2>/dev/null || true`
   `gh pr create --repo {REPO} --base main --head train-canary/{MARKER} --title "[train-canary] lane ride {MARKER}" --body "Synthetic canary PR (BR#4694): mechanics ride, not judgment. Label exempts it from human review; the executor-signed ledger events are excluded from throughput metrics."`
   `gh pr edit --repo {REPO} --add-label train-canary`
6. Stamp THIS card (ONE meta write, exactly this shape):
   `canary`: true
   `pr`: { "repo": "{REPO}", "number": <PR number>, "head_sha_at_acceptance": "<full head sha>" }
   `merge_train`: { "state": "queued", "at": <now epoch ms>, "pr": <PR number>, "repo": "{REPO}", "legs_total": 1 }
   The self-stamp IS the canary's review exemption — this fixture tests mechanics, not judgment (BR#4694 scope).
7. Transition this card → blocked with note exactly `merge-train: queued — [train-canary] lane ride {MARKER}` and await_event { "event": "time", "until_ts": <now + 30 days, epoch ms> } (inert parked timer; the train's landed flow or the watcher owns the card from here).
8. log_progress the PR URL, then end your run."#;

fn fixture_body(repo: &str, marker: &str) -> String {
    BODY_TMPL.replace("{REPO}", repo).replace("{MARKER}", marker)
}

/// Retire the fixture inert (canary.rs fixture law): zero the queue atoms so
/// it can never ride the derived queue, park it blocked on a 30-day timer.
fn retire_fixture(ctx: &mut Ctx, id: &str, why: &str) {
    let _ = ctx.mcp(
        "update_artefact",
        json!({ "id": id, "meta": { "merge_train": { "state": "retired", "pr": 0 }, "retired_why": why } }),
    );
    let status_ok = ctx.get_artefact(id).map(|a| card_status(&a).to_string());
    if let Ok(status) = status_ok {
        if status != "blocked" && status != "done" && status != "superseded" {
            let _ = ctx.transition(
                id,
                "blocked",
                &format!("[train-canary] retired — {why} (fixture inert; do not act on it)"),
                Some("[train-canary] retire timer — fixture is inert; do not act on it"),
                Some(now_ms() + RETIRE_TIMER_MS),
            );
        }
    }
}

/// File the red alarm: ONE ask per failing class, bound to the alarm sink,
/// question text per-class and date-free (identical-open-ask dedupe keeps a
/// single open ask while the class keeps failing — stop-the-line semantics).
fn file_red_alarm(ctx: &mut Ctx, sink: &str, class: &str, detail: &str, fixture: &str) {
    let question = format!("[train-canary] RED — {class} phase stuck past its bound: {class}");
    let reason = format!(
        "daily merge-train canary (BR#4694) went red on the {class} leg at {} — the lane's mechanical ride is degraded; treat like a stop-the-line alarm",
        iso(now_ms())
    );
    let details = format!(
        "Train canary (BR#4694, child of BR#4633 L4.3): the synthetic PR that rides the full merge lane stuck in the '{class}' phase past its bound.\n\nPhase: {class}\nDetail: {detail}\nFixture card: {fixture} (synthetic — its PR is labeled train-canary; retire/close it once resolved).\n\nThe canary proves the lane's mechanics (queue → gate → merge → CI → landed → close) work without human action; a red here is the executor-outage/lane-stall alarm that would have caught the 2026-10-28 outage in ~15m instead of ~64m."
    );
    let r = ctx.mcp(
        "ask_agent",
        json!({
            "to": "human",
            "question": trunc(&question, 240),
            "reason": reason,
            "details": details,
            "options": ["Acknowledge — investigating", "Known incident — deprioritize"],
            "artefact_id": sink,
        }),
    );
    match r {
        Ok(v) => log(&format!("RED alarm filed to sink {sink}: {}", trunc(&v.to_string(), 160))),
        Err(e) => log(&format!("RED alarm filing FAILED ({}): {} — page the lane manually", sink, trunc(&e, 200))),
    }
}

/// Stamp the run's verdict on the board (progress artefact). 48h of silence
/// on this feed is the canary's own liveness alarm (canary.rs law).
fn stamp_report(ctx: &mut Ctx, verdict: &str, lines: &[String]) {
    let title = format!("[train-canary] {verdict} {}", iso(now_ms()));
    let body = format!(
        "Daily merge-train canary (BR#4694) — synthetic PR riding {}@{}.\n\n{}\nSinks: {}. Liveness: this artefact must refresh daily — 48h of silence means the canary itself is dead.",
        ctx.repo, BASE, lines.iter().map(|l| format!("- {l}")).collect::<Vec<_>>().join("\n"), ctx.sink
    );
    match ctx.mcp("create_artefact", json!({ "type": "progress", "title": title, "body_md": body, "tags": [CARD_TAG] })) {
        Ok(v) => log(&format!("report stamped: {}", trunc(&v.to_string(), 120))),
        Err(e) => log(&format!("report stamp failed (board still gets the exit code): {}", trunc(&e, 160))),
    }
}

// ---------- adopt-or-spawn ----------

/// The newest live fixture, if any: title-prefixed, non-terminal, not
/// retired. Returns (id, created_ts). One live fixture at a time — a cron
/// re-run ADOPTS the in-flight ride instead of spawning a duplicate PR.
fn find_live_fixture(items: &[Value]) -> Option<(String, u64)> {
    items
        .iter()
        .filter(|a| vstr(a, "title").map(|t| t.starts_with("[train-canary]")).unwrap_or(false))
        .filter(|a| matches!(vstr(a, "status").unwrap_or(""), "todo" | "in_progress" | "blocked"))
        .filter(|a| merge_train_state(a) != Some("retired"))
        .filter(|a| !vstr(a, "title").unwrap_or("").contains("retired"))
        .max_by_key(|a| a.get("created_ts").and_then(|t| t.as_u64()).unwrap_or(0))
        .and_then(|a| vstr(a, "id").map(|id| (id.to_string(), a.get("created_ts").and_then(|t| t.as_u64()).unwrap_or(0))))
}

/// The newest LANDED fixture within the fresh window → today's ride already
/// finished green; the cron re-run stamps liveness and exits without
/// spawning a second PR (idempotent daily canary).
fn fresh_green_fixture(items: &[Value], now: u64) -> bool {
    items
        .iter()
        .filter(|a| vstr(a, "title").map(|t| t.starts_with("[train-canary]")).unwrap_or(false))
        .filter(|a| vstr(a, "status").unwrap_or("") == "done")
        .any(|a| now.saturating_sub(a.get("updated_ts").and_then(|t| t.as_u64()).unwrap_or(0)) < FRESH_GREEN_MS)
}

// ---------- the watch loop ----------

struct Watch {
    queued_stuck_since: Option<u64>,
    working_since: Option<u64>,
    parked_since: Option<u64>,
    awaiting_since: Option<u64>,
    landed_since: Option<u64>,
    merged_tag_checked: bool,
    landed_tag_checked: bool,
    prev_snap: Option<LaneSnap>,
}

impl Watch {
    fn new() -> Watch {
        Watch {
            queued_stuck_since: None,
            working_since: None,
            parked_since: None,
            awaiting_since: None,
            landed_since: None,
            merged_tag_checked: false,
            landed_tag_checked: false,
            prev_snap: None,
        }
    }
}

/// One poll: read the card, advance the machine, return Some((class, detail))
/// on RED, None to keep polling, or the terminal verdicts.
enum Step {
    Keep,
    Green(String),
    Red(String, String),
}

#[allow(clippy::too_many_arguments)]
fn poll_once(ctx: &mut Ctx, w: &mut Watch, card_id: &str, spawn_ts: u64, started: Instant) -> Result<Step, String> {
    let card = ctx.get_artefact(card_id)?;
    let phase = derive_phase(&card);
    let now = now_ms();
    match phase {
        Phase::Closed => {
            let hist = ctx.train_history(fixture_pr(&card))?;
            let (missing, _observed) = ledger_canary_gap(&hist);
            if missing > 0 {
                return Ok(Step::Red("ledger-tag".into(), format!("{missing} canary train_event(s) missing detail.canary=true — BR#4363 metrics would lie")));
            }
            Ok(Step::Green(format!("full ride green — card closed done (receipts: {card_id}, pr #{})", fixture_pr(&card))))
        }
        Phase::Killed => Ok(Step::Red("killed".into(), "the fixture card was superseded mid-ride — a third party destroyed the canary".into())),
        Phase::Retired => Ok(Step::Red("retired".into(), "the fixture card was retired mid-ride — a stale watcher run interfered".into())),
        Phase::WaitingClaim => {
            if now.saturating_sub(spawn_ts) > CLAIM_BOUND_SECS * 1000 {
                return Ok(Step::Red("claim".into(), format!("not claimed within {}m — dispatch path degraded (queue starvation or runner outage: the 2026-10-28 class)", CLAIM_BOUND_SECS / 60)));
            }
            Ok(Step::Keep)
        }
        Phase::Working => {
            let since = *w.working_since.get_or_insert(now);
            if now.saturating_sub(since) > WORK_BOUND_SECS * 1000 {
                return Ok(Step::Red("work".into(), format!("claimed {}m ago but no queued stamp landed — the executor leg is stalled or died mid-PR", WORK_BOUND_SECS / 60)));
            }
            Ok(Step::Keep)
        }
        Phase::Queued => {
            let snap = LaneSnap::from_status(&ctx.train_status()?, &ctx.repo, card_id);
            if snap.progressed_since(&w.prev_snap) {
                w.queued_stuck_since = None;
            } else {
                let since = *w.queued_stuck_since.get_or_insert(now);
                if now.saturating_sub(since) > QUEUE_BOUND_SECS * 1000 {
                    let ahead = snap.ahead.len();
                    return Ok(Step::Red(
                        "queue-stalled".into(),
                        format!("no lane progress for {}m ({} card(s) ahead) — the lane is halted on the fixture's ride (executor down / stop-the-line / deadlock)", QUEUE_BOUND_SECS / 60, ahead),
                    ));
                }
            }
            w.prev_snap = Some(snap);
            if started.elapsed().as_secs() > 4 * 3600 {
                return Ok(Step::Red("queue-stalled".into(), "the fixture rode the queue for >4h without reaching the merge — the lane never serviced it".into()));
            }
            Ok(Step::Keep)
        }
        Phase::AwaitingCi => {
            if !w.merged_tag_checked {
                w.merged_tag_checked = true;
                let hist = ctx.train_history(fixture_pr(&card))?;
                let (missing, observed) = ledger_canary_gap(&hist);
                if observed > 0 && missing > 0 {
                    return Ok(Step::Red("ledger-tag".into(), format!("{missing} merged train_event(s) missing detail.canary=true — BR#4363 metrics would lie")));
                }
            }
            let merged_at = card
                .pointer(&format!("/meta/merge_train/legs/{}/merged_at", fixture_pr(&card)))
                .and_then(|v| v.as_u64())
                .or_else(|| card.pointer("/meta/merge_train/merged_at").and_then(|v| v.as_u64()))
                .unwrap_or(now);
            let since = w.awaiting_since.unwrap_or(merged_at).min(now);
            w.awaiting_since = Some(since);
            if now.saturating_sub(since) > CI_BOUND_SECS * 1000 {
                return Ok(Step::Red("ci".into(), format!("merge commit awaiting CI for {}m — the hub's fail-closed bound is {}m; CI stalled or unobservable", CI_BOUND_SECS / 60, CI_BOUND_SECS / 60)));
            }
            Ok(Step::Keep)
        }
        Phase::Landed => {
            if !w.landed_tag_checked {
                w.landed_tag_checked = true;
                let hist = ctx.train_history(fixture_pr(&card))?;
                let (missing, observed) = ledger_canary_gap(&hist);
                if observed > 0 && missing > 0 {
                    return Ok(Step::Red("ledger-tag".into(), format!("{missing} merged/landed train_event(s) missing detail.canary=true — BR#4363 metrics would lie")));
                }
            }
            let since = *w.landed_since.get_or_insert(now);
            if now.saturating_sub(since) > CLOSE_SLACK_SECS * 1000 {
                return Ok(Step::Red("park".into(), "landed but the card never closed — the landedFlow close crashed (the ride's last mechanical leg)".into()));
            }
            Ok(Step::Keep)
        }
        Phase::ParkedRepair | Phase::ParkedOther => {
            let since = *w.parked_since.get_or_insert(now);
            if now.saturating_sub(since) > PARK_BOUND_SECS * 1000 {
                let why = if phase == Phase::ParkedRepair {
                    let kind = card.pointer("/meta/merge_train/bounce_kind").and_then(|v| v.as_str()).unwrap_or("?");
                    let defect = card.pointer("/meta/merge_train/defect").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    format!("parked in bounce repair ({kind}) for {}m — defect: {}", PARK_BOUND_SECS / 60, trunc(&defect, 160))
                } else {
                    format!("parked off-queue for {}m (reason: {}) — the watchdog released the fixture or a gate parked it", PARK_BOUND_SECS / 60, trunc(blocked_reason(&card), 160))
                };
                return Ok(Step::Red("park".into(), why));
            }
            Ok(Step::Keep)
        }
    }
}

/// Entry: `bridge train-canary [--sink BR#3124] [--repo state-vector/bridge]`.
/// Exit 0 = green, 1 = red, 2 = fatal config.
pub fn run(args: &[String]) -> i32 {
    let mut ctx = match Ctx::resolve(args) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[train-canary] fatal: {e}");
            return 2;
        }
    };
    let started = Instant::now();
    log(&format!("train canary run — sink={} repo={}", ctx.sink, ctx.repo));

    // adopt-or-spawn (rule: ONE live fixture; a landed ride <26h old = green)
    let items: Vec<Value> = match ctx.mcp("search_knowledge", json!({ "q": "[train-canary]", "type": "task", "limit": 20 })) {
        Ok(s) => s.get("artefacts").and_then(|a| a.as_array()).cloned().unwrap_or_default(),
        Err(e) => {
            log(&format!("fixture search failed (will spawn fresh): {}", trunc(&e, 160)));
            vec![]
        }
    };
    let (card_id, marker, spawn_ts, adopted) = match find_live_fixture(&items) {
        Some((id, ts)) => {
            let marker = format!("adopted-{id}");
            log(&format!("adopting in-flight fixture {id}"));
            (id, marker, ts, true)
        }
        None => {
            if fresh_green_fixture(&items, now_ms()) {
                log("today's ride already landed (<26h) — green short-circuit");
                stamp_report(&mut ctx, "GREEN", &["already landed today — cron re-run, no second PR (idempotent)".to_string()]);
                return 0;
            }
            let stamp = run_stamp(now_ms());
            let marker = format!("TC-{stamp}");
            let title = format!("[train-canary] daily lane ride {marker}");
            match ctx.create_fixture(&title, &fixture_body(&ctx.repo, &marker), &marker) {
                Ok(id) => {
                    log(&format!("fixture {id} spawned — waiting for the pool to claim it"));
                    (id, marker, now_ms(), false)
                }
                Err(e) => {
                    log(&format!("fixture spawn FAILED: {e}"));
                    let sink = ctx.sink.clone();
                    stamp_report(&mut ctx, "RED", &[format!("spawn failed: {trunc_e}", trunc_e = trunc(&e, 200))]);
                    file_red_alarm(&mut ctx, &sink, "spawn", &trunc(&e, 300), "(no fixture)");
                    return 1;
                }
            }
        }
    };

    let mut w = Watch::new();
    let mut last_logged_phase = String::new();
    let verdict;
    loop {
        match poll_once(&mut ctx, &mut w, &card_id, spawn_ts, started) {
            Ok(Step::Keep) => {
                if let Ok(card) = ctx.get_artefact(&card_id) {
                    let p = format!("{:?}", derive_phase(&card));
                    if p != last_logged_phase {
                        log(&format!("phase → {p} (fixture {card_id}, marker {marker}, adopted={adopted})"));
                        last_logged_phase = p;
                    }
                }
            }
            Ok(Step::Green(g)) => {
                log(&format!("GREEN — {g}"));
                stamp_report(&mut ctx, "GREEN", &[g]);
                verdict = 0;
                break;
            }
            Ok(Step::Red(class, detail)) => {
                log(&format!("RED [{class}] — {detail}"));
                let sink = ctx.sink.clone();
                retire_fixture(&mut ctx, &card_id, &format!("{class}: {detail}"));
                stamp_report(&mut ctx, "RED", &[format!("**RED {class}** — {detail} (`{card_id}`)")]);
                file_red_alarm(&mut ctx, &sink, &class, &detail, &card_id);
                verdict = 1;
                break;
            }
            Err(e) => {
                log(&format!("poll error (will retry): {}", trunc(&e, 160)));
                if started.elapsed().as_secs() > 6 * 3600 {
                    log("hub unreachable for >6h — giving up loudly");
                    verdict = 1;
                    break;
                }
            }
        }
        std::thread::sleep(POLL_EVERY);
    }
    verdict
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(status: &str, mt_state: Option<&str>, reason: &str) -> Value {
        let mut v = json!({ "status": status, "meta": { "canary": true, "blocked": { "reason": reason }, "pr": { "repo": "r", "number": 7 } } });
        if let Some(s) = mt_state {
            v["meta"]["merge_train"] = json!({ "state": s, "pr": 7 });
        }
        v
    }

    #[test]
    fn phase_matrix_reads_status_meta_and_reason() {
        assert_eq!(derive_phase(&card("todo", None, "")), Phase::WaitingClaim);
        assert_eq!(derive_phase(&card("in_progress", None, "")), Phase::Working);
        assert_eq!(derive_phase(&card("blocked", Some("queued"), "merge-train: queued — x")), Phase::Queued);
        // a queued stamp wiped but the canonical reason intact is still queued (BR#4079)
        assert_eq!(derive_phase(&card("blocked", None, "merge-train: queued — x")), Phase::Queued);
        assert_eq!(derive_phase(&card("blocked", Some("awaiting-ci"), "merge-train: awaiting-ci")), Phase::AwaitingCi);
        assert_eq!(derive_phase(&card("blocked", Some("bounced"), "irrelevant")), Phase::ParkedRepair);
        // bounced cards usually ride in_progress with the fix-up brief
        assert_eq!(derive_phase(&card("in_progress", Some("bounced"), "")), Phase::ParkedRepair);
        assert_eq!(derive_phase(&card("blocked", None, "stalled — no update for >10m")), Phase::ParkedOther);
        assert_eq!(derive_phase(&card("blocked", Some("landed"), "merge-train: queued")), Phase::Landed);
        assert_eq!(derive_phase(&card("done", Some("landed"), "")), Phase::Closed);
        assert_eq!(derive_phase(&card("superseded", None, "")), Phase::Killed);
        assert_eq!(derive_phase(&card("blocked", Some("retired"), "[train-canary] retired")), Phase::Retired);
        // a non-canary card is never a phase (defensive adopt guard)
        let mut foreign = card("done", None, "");
        foreign["meta"]["canary"] = json!(false);
        assert_eq!(derive_phase(&foreign), Phase::Retired);
    }

    #[test]
    fn per_leg_stamp_decides_awaiting_ci_and_landed() {
        let mut c = card("blocked", Some("queued"), "merge-train: queued");
        c["meta"]["merge_train"]["legs"] = json!({ "7": { "state": "awaiting-ci", "merged_at": 1 } });
        assert_eq!(derive_phase(&c), Phase::AwaitingCi);
        c["meta"]["merge_train"]["legs"]["7"]["state"] = json!("landed");
        assert_eq!(derive_phase(&c), Phase::Landed);
    }

    #[test]
    fn lane_snap_reads_queue_ahead_currently_and_last_event() {
        let status = json!({ "lanes": [
            { "lane": "other@main", "queue": [ { "id": "BR#1" } ] },
            { "lane": "state-vector/bridge@main", "queue": [ { "id": "BR#2" }, { "id": "BR#3" }, { "id": "FIXTURE" } ],
              "currently": { "pr": 9, "phase": "awaiting-ci" },
              "activity": { "last_event": { "ts": 1234 } } },
        ]});
        let snap = LaneSnap::from_status(&status, "state-vector/bridge", "FIXTURE");
        assert_eq!(snap.ahead, vec!["BR#2".to_string(), "BR#3".to_string()]);
        assert_eq!(snap.currently, Some((9, "awaiting-ci".into())));
        assert_eq!(snap.last_event_ts, 1234);
        // unknown lane / idle lane: empty snap, never a panic
        let none = LaneSnap::from_status(&json!({ "lanes": [] }), "state-vector/bridge", "FIXTURE");
        assert!(none.ahead.is_empty() && none.currently.is_none() && none.last_event_ts == 0);
    }

    #[test]
    fn queue_clock_accrues_only_through_stillness() {
        let a = LaneSnap { ahead: vec!["BR#2".into()], currently: Some((9, "awaiting-ci".into())), last_event_ts: 1 };
        let same = a.clone();
        let moved_ahead = LaneSnap { ahead: vec![], currently: Some((9, "awaiting-ci".into())), last_event_ts: 1 };
        let moved_merge = LaneSnap { ahead: vec!["BR#2".into()], currently: Some((10, "awaiting-ci".into())), last_event_ts: 1 };
        let moved_event = LaneSnap { ahead: vec!["BR#2".into()], currently: Some((9, "awaiting-ci".into())), last_event_ts: 2 };
        assert!(!same.progressed_since(&Some(a.clone())), "identical lane = still = the stuck clock runs");
        assert!(moved_ahead.progressed_since(&Some(a.clone())), "a card landing ahead IS progress (backlog is not stuck)");
        assert!(moved_merge.progressed_since(&Some(a.clone())), "the in-flight merge advancing IS progress");
        assert!(moved_event.progressed_since(&Some(a)), "any ledger event IS progress");
        assert!(moved_ahead.progressed_since(&None), "first observation always counts as progress");
    }

    #[test]
    fn ledger_tag_gap_detects_missing_canary_stamps() {
        // shipped shape: { events: [ { kind, detail: "<json string>" } ] }
        let hist = json!({ "events": [
            { "kind": "merged", "detail": r#"{"canary":true}"# },
            { "kind": "landed", "detail": r#"{"canary":true,"run":"u"}"# },
        ]});
        assert_eq!(ledger_canary_gap(&hist), (0, 2));
        // a missing stamp on the merged row is the defect (metrics would lie)
        let hist = json!({ "events": [
            { "kind": "merged", "detail": r#"{"task":"BR#1"}"# },
        ]});
        assert_eq!(ledger_canary_gap(&hist), (1, 1));
        // detail as an object (not a string) also parses
        let hist = json!({ "events": [ { "kind": "merged", "detail": { "canary": true } } ] });
        assert_eq!(ledger_canary_gap(&hist), (0, 1));
        // no events yet: nothing observed, nothing missing (not a defect)
        assert_eq!(ledger_canary_gap(&json!({ "events": [] })), (0, 0));
        assert_eq!(ledger_canary_gap(&json!({})), (0, 0));
        // non-train rows are ignored
        let hist = json!({ "events": [ { "kind": "bounced", "detail": r#"{}"# } ] });
        assert_eq!(ledger_canary_gap(&hist), (0, 0));
    }

    #[test]
    fn fixture_body_carries_marker_and_repo() {
        let b = fixture_body("state-vector/bridge", "TC-20261029-1011");
        assert!(b.contains("TC-20261029-1011"));
        assert!(b.contains("state-vector/bridge"));
        assert!(b.contains("train-canary"), "the PR label is the review exemption");
        assert!(b.contains("head_sha_at_acceptance"), "the leg stamp is what the gate reads");
        assert!(b.contains("merge-train: queued"), "the canonical queue reason (BR#4079)");
        assert!(!b.contains("{REPO}") && !b.contains("{MARKER}"), "no unsubstituted placeholders");
    }

    #[test]
    fn adopt_logic_never_spawns_over_a_live_or_fresh_ride() {
        let now = 1_800_000_000_000u64;
        let live = json!({ "id": "BR#900", "title": "[train-canary] daily lane ride TC-1", "status": "blocked", "created_ts": now - 1000, "meta": { "canary": true, "merge_train": { "state": "queued" } } });
        let landed = json!({ "id": "BR#890", "title": "[train-canary] daily lane ride TC-0", "status": "done", "updated_ts": now - 3600_000, "meta": { "canary": true } });
        let old_landed = json!({ "id": "BR#800", "title": "[train-canary] daily lane ride TC-2", "status": "done", "updated_ts": now - 30 * 3600_000 });
        let retired = json!({ "id": "BR#700", "title": "[train-canary] retired", "status": "blocked", "created_ts": now, "meta": { "canary": true, "merge_train": { "state": "retired" } } });
        let items = vec![retired.clone(), old_landed.clone(), landed.clone(), live.clone()];
        assert_eq!(find_live_fixture(&items).as_ref().map(|(id, _)| id.as_str()), Some("BR#900"));
        assert!(fresh_green_fixture(&items, now), "a <26h landed ride ends the re-run green");
        let items = vec![retired, old_landed];
        assert!(find_live_fixture(&items).is_none(), "retired + old landed = nothing to adopt");
        assert!(!fresh_green_fixture(&items, now), ">26h old landed = spawn a fresh ride");
    }
}




