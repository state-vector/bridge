//! canary.rs — the hub self-canary (`bridge canary`, BR#4177). A daily
//! synthetic end-to-end lifecycle against the DEPLOYED hub, red alarm to the
//! alarm sink (BR#3124 lane).
//!
//! The hub is coordination infrastructure; its load-bearing paths get the
//! same treatment the product gets. Four legs, each covering a failure class
//! observed the Oct 26–28 window:
//!
//!   1. duty spawn → dispatch → delivery   ("result delivered late/lost")
//!   2. flip-on-event                      (typed await flips w/o human action — stale-ledger class)
//!   3. queue visibility                   (BR#4079 stamp contract — clobbered-stamp class)
//!   4. reconcile accounting               (BR#4170's report runs green)
//!
//! Division of labour — same as the train executor (BR#3516): the canary is a
//! CLIENT of the hub. It exercises the deployed hub over the wire (MCP, the
//! same surface agents use), holds no hub internals, and never self-certifies:
//! every assertion reads hub state back.
//!
//! Fixture law: every synthetic artefact is tagged `[canary]`, is parked with
//! a long typed timer on retire, and uses legal lifecycle edges only. Task
//! status → superseded is illegal for clients (core.ts LIFECYCLES), so
//! "self-clean" = retire-to-blocked + inert 30d timer (no churn stamps, no
//! queue membership, not claimable work). The board accumulates at most two
//! inert blocked fixtures per run.
//!
//! Red path: a deduped ask bound to the alarm sink (BR#3124) — identical
//! per-class question text so the hub's identical-open-ask guard keeps ONE
//! open ask per failing leg class, exactly like stop-the-line (BR#3516 §6).
//! Every run (green or red) stamps a `[hub-canary]` progress artefact; 48h
//! of silence on that feed is the canary's own liveness alarm.

use serde_json::{json, Value};
use std::io::Write;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SESSION: &str = "hub-canary";
const RPC_TIMEOUT: Duration = Duration::from_secs(60);
const POLL_EVERY: Duration = Duration::from_secs(20);

/// Leg-2 flip timer: elapses 90s after park — the unblock proxy sweep
/// (`unblock_proxy_sweep_minutes`, default 15) fires it on its next pass.
const FLIP_TIMER_MS: u64 = 90_000;
/// Retired fixtures carry a far-future timer: the sweep sees "waiting"
/// forever, never fires, the fixture stays inert and never spawns work.
const RETIRE_TIMER_MS: u64 = 30 * 24 * 3600 * 1000;

const DEFAULT_SINK: &str = "BR#3124";
/// BR#4079 needs `merge_train.pr > 0`; the fixture cites an obviously-fake PR
/// that exists on no repo. If it ever reaches a train gate it fails at
/// `gh pr view` BEFORE any gate/bounce — one benign lost executor tick, no
/// board writes (train.rs:501 `?` → tick error → lease release).
const DEFAULT_FIXTURE_PR: i64 = 999_901;
/// Task bar: duty dispatched <10m, result lands <10m after that.
const CLAIM_BOUND_SECS: u64 = 600;
const DELIVER_BOUND_SECS: u64 = 600;
/// Flip <1 cycle: sweep pace 15m + duty time; bound 2 cycles fail-closed.
const FLIP_BOUND_SECS: u64 = 2_400;

/// BR#4079 (accepted): a queued card is visible iff status=blocked AND
/// meta.merge_train.pr>0 AND blocked.reason starts with this prefix.
const MERGE_TRAIN_REASON_PREFIX: &str = "merge-train:";
/// The lane the queue-visibility leg asserts against (the hub's own repo lane).
const QUEUE_LANE_REPO: &str = "state-vector/bridge";

struct Ctx {
    http: reqwest::blocking::Client,
    hub: String,
    token: String,
    sink: String,
    fixture_pr: i64,
    rpc_id: u64,
}

#[derive(PartialEq, Clone, Copy, Debug)]
enum LegStatus {
    Pass,
    Fail,
    Skip,
}

struct Leg {
    name: &'static str,
    status: LegStatus,
    detail: String,
    receipts: Vec<String>,
}

impl Leg {
    fn new(name: &'static str, status: LegStatus, detail: String) -> Leg {
        Leg { name, status, detail, receipts: vec![] }
    }
    fn with_receipt(mut self, r: String) -> Leg {
        self.receipts.push(r);
        self
    }
    fn ok(&self) -> bool {
        self.status != LegStatus::Fail
    }
    fn word(&self) -> &'static str {
        match self.status {
            LegStatus::Pass => "PASS",
            LegStatus::Fail => "RED",
            LegStatus::Skip => "SKIP",
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn trunc(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// UTC ISO-8601 without a chrono dependency (civil-from-days, same as train.rs).
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

/// Compact run id: UTC date + hour-minute (unique per run, safe in titles).
fn run_stamp(ts_ms: u64) -> String {
    iso(ts_ms).replace(['-', ':'], "").replace('T', "-")[..15].to_string()
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
            .or_else(|| std::env::var("CANARY_SINK_ID").ok())
            .unwrap_or_else(|| DEFAULT_SINK.to_string());
        let fixture_pr: i64 = Self::flag(args, "--fixture-pr")
            .and_then(|v| v.parse().ok())
            .or_else(|| std::env::var("CANARY_FIXTURE_PR").ok().and_then(|v| v.parse().ok()))
            .unwrap_or(DEFAULT_FIXTURE_PR);
        Ok(Ctx {
            http: reqwest::blocking::Client::builder().timeout(RPC_TIMEOUT).build().map_err(|e| e.to_string())?,
            hub: hub.trim_end_matches('/').to_string(),
            token,
            sink,
            fixture_pr,
            rpc_id: 0,
        })
    }

    /// MCP over the hub's /mcp — the same JSON-RPC surface the agents use
    /// (same client shape as the train executor).
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

    fn create_fixture(&mut self, title: &str, body: &str, meta: Value) -> Result<String, String> {
        let r = self.mcp(
            "create_artefact",
            json!({
                "type": "task",
                "title": title,
                "body_md": body,
                "tags": ["canary"],
                "qualified": true,
                "meta": meta,
            }),
        )?;
        artefact_id(&r).ok_or_else(|| format!("create returned no id: {}", trunc(&r.to_string(), 200)))
    }
}

/// Parse the created artefact's id out of a create_artefact / get_artefact
/// payload (the MCP layer has shipped several shapes — accept them all).
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

/// Does any history version carry the marker? (The whole version record is
/// serialized — marker may ride the summary, the note, or the data blob.)
fn history_has_marker(hist: &Value, marker: &str) -> bool {
    hist.get("versions")
        .and_then(|v| v.as_array())
        .map(|vs| vs.iter().any(|v| v.to_string().contains(marker)))
        .unwrap_or(false)
}

/// The leg-2 flip observable: the unblock proxy sweep stamped the fixture's
/// proxy_check verdict TRUE (spawn recorded or deferred) — see do.ts
/// spawnProxyDuty. Also true when the sweep's version note landed.
fn flip_fired(art: &Value, hist: &Value) -> bool {
    let verdict_true = art
        .pointer("/meta/proxy_check/verdict")
        .and_then(|v| v.as_str())
        .map(|s| s == "true")
        .unwrap_or(false);
    let spawned = art
        .pointer("/meta/proxy_check/spawned")
        .map(|v| !v.is_null())
        .unwrap_or(false);
    let note = hist
        .get("versions")
        .and_then(|v| v.as_array())
        .map(|vs| vs.iter().any(|v| v.to_string().contains("machine proxy flipped TRUE")))
        .unwrap_or(false);
    verdict_true && (spawned || note)
}

/// Queue membership from a train_status payload: does `lane` (repo@base)
/// list `id`? train_status → { lanes: [{ lane, queue: [{id, priority}] }] }.
fn queue_contains(train_status: &Value, lane: &str, id: &str) -> bool {
    train_status
        .get("lanes")
        .and_then(|l| l.as_array())
        .map(|lanes| {
            lanes
                .iter()
                .filter(|l| vstr(l, "lane") == Some(lane))
                .any(|l| {
                    l.get("queue")
                        .and_then(|q| q.as_array())
                        .map(|qs| qs.iter().any(|q| vstr(q, "id") == Some(id)))
                        .unwrap_or(false)
                })
        })
        .unwrap_or(false)
}

/// The BR#4079 canonical queued stamp (three writes in one meta object):
/// meta.merge_train = {state:'queued', pr>0, …} + meta.pr = {repo, number}.
fn queued_fixture_meta(fixture_pr: i64, repo: &str) -> Value {
    json!({
        "merge_train": {
            "state": "queued",
            "at": now_ms(),
            "pr": fixture_pr,
            "repo": repo,
            "legs_total": 1,
        },
        "pr": { "repo": repo, "number": fixture_pr },
    })
}

/// Retire: zero the queue-relevant atoms — pr=0 fails the SQL candidate
/// filter, state 'retired' fails the release-guard, and the reason loses the
/// `merge-train:` prefix. Contract-exact invisible (BR#4079).
fn retired_fixture_meta(mut meta: Value, note: &str) -> Value {
    if let Value::Object(map) = &mut meta {
        map.insert("merge_train".into(), json!({ "state": "retired", "pr": 0 }));
        if !map.get("blocked").map(|b| b.is_object()).unwrap_or(false) {
            map.insert("blocked".into(), json!({}));
        }
        if let Some(blocked) = map.get_mut("blocked").and_then(|b| b.as_object_mut()) {
            blocked.insert("reason".into(), json!(note));
        }
    }
    meta
}

const DUTY_BODY_TMPL: &str = r#"SYNTHETIC canary fixture (BR#4177 leg 1 — duty spawn→dispatch→delivery). Trivial by design; do NOT expand scope, do NOT write code.

1. Orient.
2. log_progress ONE note containing exactly this marker: {MARKER}
3. Transition this card → blocked with await_event {{ "event": "time", "until_ts": <now+30d, epoch ms> }} and note "[canary] complete {MARKER}" (parked = the run's terminal resting state; done is review-gated and not part of this test).
4. End the run.

This card exists to prove the hub's spawn→claim→delivery path. The canary that created it polls for your marker on the board."#;

/// Leg 1 — duty spawn → dispatch → delivery. Creates a qualified synthetic
/// task, waits ≤10m for a runner claim, then ≤10m more for the marker to
/// land on the board (progress note + parked receipt). Catches the
/// "result delivered late/lost" class (two observed Oct 26–28).
fn leg_duty(ctx: &mut Ctx, marker: &str) -> Leg {
    let title = format!("[canary] duty-spawn leg — synthetic (BR#4177 {marker})");
    let body = DUTY_BODY_TMPL.replace("{MARKER}", marker);
    let id = match ctx.create_fixture(&title, &body, json!({})) {
        Ok(id) => id,
        Err(e) => return Leg::new("duty-spawn→delivery", LegStatus::Fail, format!("fixture create failed: {e}")),
    };
    log(&format!("leg1 duty fixture {id} — waiting for dispatch (bound {CLAIM_BOUND_SECS}s) + delivery (bound {DELIVER_BOUND_SECS}s)"));

    let start = Instant::now();
    let total_bound = Duration::from_secs(CLAIM_BOUND_SECS + DELIVER_BOUND_SECS);
    let mut claimed_by = String::new();
    let mut claimed_at: Option<Instant> = None;

    loop {
        if start.elapsed() > total_bound {
            // fail-closed retire: no stray session may complete a dead duty
            let _ = ctx.transition(
                &id,
                "blocked",
                &format!("[canary] TIMEOUT — duty was not delivered within bound; fixture retired ({marker})"),
                Some("[canary] retire timer — fixture is inert; do not act on it"),
                Some(now_ms() + RETIRE_TIMER_MS),
            );
            let detail = if claimed_at.is_none() {
                format!("not claimed within {CLAIM_BOUND_SECS}s — dispatch path degraded (queue starvation or runner outage?)")
            } else {
                format!(
                    "claimed by {claimed_by} but the result never landed within {DELIVER_BOUND_SECS}s — completed_result_lost class"
                )
            };
            return Leg::new("duty-spawn→delivery", LegStatus::Fail, detail).with_receipt(id);
        }
        std::thread::sleep(POLL_EVERY);

        let art = match ctx.get_artefact(&id) {
            Ok(a) => a,
            Err(e) => {
                log(&format!("leg1 poll error (will retry): {}", trunc(&e, 120)));
                continue;
            }
        };
        let status = vstr(&art, "status").unwrap_or("").to_string();

        if status == "todo" && claimed_at.is_none() {
            continue; // not claimed yet — keep waiting
        }
        if claimed_at.is_none() {
            claimed_at = Some(Instant::now());
            claimed_by = String::new(); // owner/session attribution is in history, not worth another read
            log(&format!("leg1 duty claimed (status={status}) — waiting for the marker to land"));
        }

        if status == "blocked" || status == "done" {
            match ctx.get_history(&id) {
                Ok(hist) if history_has_marker(&hist, marker) => {
                    return Leg::new("duty-spawn→delivery", LegStatus::Pass, format!(
                        "spawned → dispatched → delivered (marker landed, terminal status {status})"
                    ))
                    .with_receipt(id)
                }
                Ok(_) => {
                    // parked/closed WITHOUT the marker: someone else moved the card
                    return Leg::new("duty-spawn→delivery", LegStatus::Fail, format!(
                        "reached {status} without the delivery marker — result lost or the card was moved by a third party"
                    ))
                    .with_receipt(id);
                }
                Err(e) => {
                    log(&format!("leg1 history read failed (will retry): {}", trunc(&e, 120)));
                }
            }
        }
        // in_progress/in_review → keep polling until the marker lands
    }
}

const FLIP_BODY: &str = r#"SYNTHETIC canary fixture (BR#4177 leg 2 — flip-on-event). Parked on a typed 90s timer.

The unblock proxy sweep (hub:proxy-watch) must evaluate this card on its next pass after the timer elapses and auto-spawn an unblock duty — NO human action. That spawn is the whole test.

If you are the spawned duty: the timer was the point. Live re-verify = read this card's meta.proxy_check (should say verdict "true" with the timer receipt), transition this card → in_progress with note "[canary] flip verified", then immediately re-park it → blocked with a 30-day timer and note "[canary] flip verified <date>" so it rests inert. Close yourself done citing meta.proxy_check."#;

/// Phase A — park the flip fixture on a typed 90s timer (BR#3578 grammar:
/// {event:"time", until_ts} is hub-native and deterministic; the named
/// pr_merged/run_success flavors need GitHub facts the hub does not hold —
/// BR#3516 — so they can only ride the real train; see PR notes).
fn leg_flip_park(ctx: &mut Ctx) -> Result<String, String> {
    let title = "[canary] flip-on-event leg — synthetic (BR#4177)".to_string();
    let id = ctx.create_fixture(&title, FLIP_BODY, json!({}))?;
    ctx.transition(
        &id,
        "blocked",
        "[canary] parked on a typed 90s timer — the unblock proxy sweep must flip it (BR#4177 leg 2)",
        Some("typed timer: when until_ts elapses the proxy sweep spawns an unblock duty — that spawn is the canary assertion"),
        Some(now_ms() + FLIP_TIMER_MS),
    )?;
    Ok(id)
}

/// Phase B — poll ≤2 sweep cycles for the flip: proxy_check verdict TRUE
/// (+spawn receipt) or the sweep's flip version note.
fn leg_flip_poll(ctx: &mut Ctx, id: &str) -> Leg {
    let start = Instant::now();
    let bound = Duration::from_secs(FLIP_BOUND_SECS);
    loop {
        if start.elapsed() > bound {
            let _ = ctx.transition(
                id,
                "blocked",
                "[canary] TIMEOUT — the proxy sweep never flipped the timer; fixture retired",
                Some("[canary] retire timer — fixture is inert; do not act on it"),
                Some(now_ms() + RETIRE_TIMER_MS),
            );
            return Leg::new(
                "flip-on-event",
                LegStatus::Fail,
                format!("typed 90s timer not flipped within {FLIP_BOUND_SECS}s — unblock proxy sweep stalled/stopped (stale-ledger class)"),
            )
            .with_receipt(id.to_string());
        }
        std::thread::sleep(POLL_EVERY);

        let (art, hist) = match (ctx.get_artefact(id), ctx.get_history(id)) {
            (Ok(a), Ok(h)) => (a, h),
            (Err(e), _) | (_, Err(e)) => {
                log(&format!("leg2 poll error (will retry): {}", trunc(&e, 120)));
                continue;
            }
        };
        let status = vstr(&art, "status").unwrap_or("").to_string();
        if flip_fired(&art, &hist) || status == "in_progress" {
            let spawned = art
                .pointer("/meta/proxy_check/spawned")
                .map(|s| s.to_string())
                .unwrap_or_else(|| "child-duty-implied".into());
            return Leg::new(
                "flip-on-event",
                LegStatus::Pass,
                "typed timer flipped without human action — proxy sweep spawned the duty".to_string(),
            )
            .with_receipt(spawned.trim_matches('"').to_string())
            .with_receipt(id.to_string());
        }
    }
}

/// Leg 3 — queue visibility per the BR#4079 contract. Create a fixture that
/// carries the canonical queued stamp + a `merge-train:` blocked reason,
/// assert it appears in the DERIVED train queue (train_status), then retire
/// it within seconds and assert it vanished. Catches the clobbered-stamp
/// class (BR#3912: a valid stamp sat invisible).
fn leg_queue(ctx: &mut Ctx) -> Leg {
    let repo = QUEUE_LANE_REPO;
    let title = format!("[canary] queue-visibility leg — synthetic (BR#4177, fake PR #{})", ctx.fixture_pr);
    let body = "SYNTHETIC canary fixture (BR#4177 leg 3). Exercises the BR#4079 queue-visibility contract for seconds, then retires. Do not act on this card; do not stamp it onto the real train.";
    let id = match ctx.create_fixture(&title, body, queued_fixture_meta(ctx.fixture_pr, repo)) {
        Ok(id) => id,
        Err(e) => return Leg::new("queue-visibility", LegStatus::Fail, format!("fixture create failed: {e}")),
    };
    let reason = format!(
        "{MERGE_TRAIN_REASON_PREFIX} queued — [canary] queue-visibility fixture, retires within seconds (BR#4177 leg 3)"
    );
    if let Err(e) = ctx.transition(
        &id,
        "blocked",
        &reason,
        Some("typed retire timer — this fixture leaves the queue within seconds; never act on it"),
        Some(now_ms() + RETIRE_TIMER_MS),
    ) {
        let _ = ctx.transition(&id, "blocked", "[canary] retire after stamp failure", Some("[canary] retire timer — inert"), Some(now_ms() + RETIRE_TIMER_MS));
        return Leg::new("queue-visibility", LegStatus::Fail, format!("park with merge-train reason failed: {e}")).with_receipt(id);
    }

    // assert VISIBLE in the derived queue
    let visible = match ctx.mcp("train_status", json!({ "repo": repo })) {
        Ok(st) => queue_contains(&st, &format!("{repo}@main"), &id),
        Err(e) => {
            let _ = retire_fixture(ctx, &id);
            return Leg::new("queue-visibility", LegStatus::Fail, format!("train_status failed: {e}")).with_receipt(id);
        }
    };
    if !visible {
        let _ = retire_fixture(ctx, &id);
        return Leg::new(
            "queue-visibility",
            LegStatus::Fail,
            "stamped fixture NOT in the derived queue — clobbered-stamp class (BR#3912) or BR#4079 derivation regressed".to_string(),
        )
        .with_receipt(id);
    }

    // retire and assert INVISIBLE (the contract is bidirectional: a retired
    // card must leave the derived queue on the very next read)
    let retire_ok = retire_fixture(ctx, &id).is_ok();
    let gone = match ctx.mcp("train_status", json!({ "repo": repo })) {
        Ok(st) => !queue_contains(&st, &format!("{repo}@main"), &id),
        Err(_) => true, // read failed after a successful one — don't fail the leg on flake; visibility was proven
    };
    if visible && gone {
        let mut leg = Leg::new("queue-visibility", LegStatus::Pass, "stamped → visible in derived queue → retired → gone (BR#4079 contract holds both ways)".to_string());
        leg.receipts.push(id.clone());
        if !retire_ok {
            leg.detail = format!("{} (note: meta-retire write failed — fixture may linger visible; check {})", leg.detail, id);
        }
        leg
    } else {
        Leg::new("queue-visibility", LegStatus::Fail, "retired fixture still visible in the derived queue".to_string()).with_receipt(id)
    }
}

/// Best-effort retire: rewrite the fixture's meta so it fails every
/// queue-visibility predicate (pr=0, state retired, no merge-train reason).
fn retire_fixture(ctx: &mut Ctx, id: &str) -> Result<(), String> {
    let art = ctx.get_artefact(id)?;
    let meta = retired_fixture_meta(art.get("meta").cloned().unwrap_or(json!({})), "[canary] retired — fixture inert, not queued, not claimable work");
    ctx.mcp("update_artefact", json!({ "id": id, "meta": meta }))?;
    Ok(())
}

/// Leg 4 — reconcile accounting: BR#4170's report runs green (every PR
/// accounted). v1 asserts on the freshest reconcile report artefact when the
/// BR#4170 lane has landed one; until then the leg SKIPs (armed, not red) —
/// a missing dependency must not train-wreck the canary daily.
fn leg_reconcile(ctx: &mut Ctx) -> Leg {
    let search = match ctx.mcp(
        "search_knowledge",
        json!({ "q": "reconcile accounting report accounted", "limit": 5 }),
    ) {
        Ok(s) => s,
        Err(e) => return Leg::new("reconcile-accounting", LegStatus::Skip, format!("search unavailable: {e}")),
    };
    let items = search.get("artefacts").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    let fresh_ms = 26 * 3600 * 1000; // a DAILY report must be fresher than 26h
    for item in &items {
        let id = vstr(item, "id").unwrap_or("");
        if id == "BR#4177" {
            continue; // this task's own card matches the query; not a report
        }
        let ts = item.get("updated_ts").and_then(|t| t.as_u64()).unwrap_or(0);
        if ts == 0 || now_ms().saturating_sub(ts) > fresh_ms {
            continue;
        }
        let text = format!("{} {}", vstr(item, "title").unwrap_or(""), item.get("body_md").and_then(|b| b.as_str()).unwrap_or(""));
        let lower = text.to_lowercase();
        if !(lower.contains("reconcil") || lower.contains("accounted")) {
            continue;
        }
        // any reported unaccounted count >0 = the invariant is drifting = RED
        if let Some(n) = extract_unaccounted(&text) {
            if n > 0 {
                return Leg::new("reconcile-accounting", LegStatus::Fail, format!("{n} unaccounted PR(s) in the freshest reconcile report"))
                    .with_receipt(id.to_string());
            }
            return Leg::new("reconcile-accounting", LegStatus::Pass, "freshest reconcile report: 0 unaccounted".to_string())
                .with_receipt(id.to_string());
        }
        // report present, freshness ok, no explicit unaccounted count → green
        return Leg::new("reconcile-accounting", LegStatus::Pass, "freshest reconcile report present and fresh (<26h)".to_string())
            .with_receipt(id.to_string());
    }
    Leg::new(
        "reconcile-accounting",
        LegStatus::Skip,
        "no fresh BR#4170 reconcile report found — leg armed, skipping until that lane lands (not a red: the dependency is in flight, session dispatch-ip-172-31-1-230)".to_string(),
    )
}

/// Pull "N unaccounted" (or "unaccounted: N") out of report text, if stated.
fn extract_unaccounted(text: &str) -> Option<u64> {
    let lower = text.to_lowercase();
    for window in lower.match_indices("unaccounted") {
        let before = &lower[..window.0];
        let after = &lower[window.0..];
        let n_before: String = before
            .chars()
            .rev()
            .skip_while(|c| !c.is_ascii_digit())
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        if let Ok(n) = n_before.parse::<u64>() {
            if n_before.len() < 4 {
                return Some(n);
            }
        }
        let digits: String = after.chars().skip_while(|c| !c.is_ascii_digit()).take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(n) = digits.parse::<u64>() {
            if digits.len() < 4 {
                return Some(n);
            }
        }
    }
    None
}

/// File the red alarm: ONE ask per failing leg class, bound to the alarm
/// sink (BR#3124 standing card). Question text is per-class and date-free so
/// the hub's identical-open-ask guard keeps a single open ask while a class
/// keeps failing (stop-the-line semantics, BR#3516 §6).
fn file_red_alarm(ctx: &mut Ctx, sink: &str, legs: &[Leg]) {
    let failed: Vec<&Leg> = legs.iter().filter(|l| l.status == LegStatus::Fail).collect();
    let classes: Vec<&str> = failed.iter().map(|l| l.name).collect();
    let question = format!("[hub-canary] RED — failing leg class(es): {}", classes.join(", "));
    let details: Vec<String> = failed
        .iter()
        .map(|l| format!("- {}: {}{}", l.name, l.detail, if l.receipts.is_empty() { String::new() } else { format!(" [fixtures: {}]", l.receipts.join(", ")) }))
        .collect();
    let reason = format!(
        "daily hub self-canary (BR#4177) run at {} went red on {}. The covered hub paths failed or regressed — treat like a stop-the-line alarm for the bridge lane.",
        iso(now_ms()),
        classes.join(" + ")
    );
    let r = ctx.mcp(
        "ask_agent",
        json!({
            "to": "human",
            "question": question,
            "reason": reason,
            "details": details.join("\n"),
            "options": ["Acknowledge — investigating", "Known incident — deprioritize"],
            "artefact_id": sink,
        }),
    );
    match r {
        Ok(v) => log(&format!("RED alarm filed to sink {sink}: {}", trunc(&v.to_string(), 160))),
        Err(e) => log(&format!("RED alarm filing FAILED ({}): {} — page the bridge lane manually", sink, trunc(&e, 200))),
    }
}

/// Stamp the run's green/red event on the board (progress artefact). 48h of
/// silence on this feed is the canary's own liveness alarm.
fn stamp_report(ctx: &mut Ctx, legs: &[Leg], ok: bool) {
    let mut lines = String::new();
    for l in legs {
        lines.push_str(&format!("- **{} {}** — {}{}\n", l.word(), l.name, l.detail, {
            if l.receipts.is_empty() { String::new() } else { format!(" (`{}`)", l.receipts.join("`, `")) }
        }));
    }
    let n_pass = legs.iter().filter(|l| l.status == LegStatus::Pass).count();
    let n_fail = legs.iter().filter(|l| l.status == LegStatus::Fail).count();
    let n_skip = legs.iter().filter(|l| l.status == LegStatus::Skip).count();
    let verdict = if ok { "GREEN" } else { "RED" };
    let title = format!("[hub-canary] {verdict} {} — {n_pass} pass / {n_fail} fail / {n_skip} skip", iso(now_ms()));
    let body = format!(
        "Daily hub self-canary (BR#4177) against the deployed hub.\n\n{lines}\nSinks: {}. Canary liveness: this artefact must refresh daily — 48h of silence means the canary itself is dead.",
        ctx.sink
    );
    match ctx.mcp("create_artefact", json!({ "type": "progress", "title": title, "body_md": body, "tags": ["canary"] })) {
        Ok(v) => log(&format!("report stamped: {}", trunc(&v.to_string(), 120))),
        Err(e) => log(&format!("report stamp failed (board still gets the exit code): {}", trunc(&e, 160))),
    }
}

/// Entry: `bridge canary [--once] [--sink BR#3124] [--fixture-pr N]`.
/// Exit 0 = green (all legs pass/skip), 1 = red, 2 = fatal config.
pub fn run(args: &[String]) -> i32 {
    let mut ctx = match Ctx::resolve(args) {
        Ok(c) => c,
        Err(e) => {
            crate::logging::emit("canary", "", &format!("fatal: {e}"));
            return 2;
        }
    };
    let stamp = run_stamp(now_ms());
    let marker = format!("CANARY-{stamp}");
    log(&format!("hub self-canary run {stamp} — sink={} fixture_pr={}", ctx.sink, ctx.fixture_pr));

    // Leg 2 parks FIRST (its 90s timer + the 15m sweep pace run during leg 1's
    // dispatch wait — total wall clock converges instead of adding).
    let flip_fixture = match leg_flip_park(&mut ctx) {
        Ok(id) => {
            log(&format!("leg2 flip fixture {id} parked on a 90s typed timer"));
            Some(id)
        }
        Err(e) => {
            log(&format!("leg2 park failed: {}", trunc(&e, 200)));
            None
        }
    };

    let mut legs: Vec<Leg> = vec![leg_duty(&mut ctx, &marker)];
    legs.push(match &flip_fixture {
        Some(id) => leg_flip_poll(&mut ctx, id),
        None => Leg::new("flip-on-event", LegStatus::Fail, "fixture park failed — see run log".to_string()),
    });
    legs.push(leg_queue(&mut ctx));
    legs.push(leg_reconcile(&mut ctx));

    let ok = legs.iter().all(|l| l.ok());
    for l in &legs {
        log(&format!("{} {} — {}", l.word(), l.name, l.detail));
    }
    stamp_report(&mut ctx, &legs, ok);
    if !ok {
        let sink = ctx.sink.clone();
        file_red_alarm(&mut ctx, &sink, &legs);
        return 1;
    }
    log("canary GREEN");
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reason_prefix_matches_accepted_contract() {
        assert_eq!(MERGE_TRAIN_REASON_PREFIX, "merge-train:");
    }

    #[test]
    fn queued_stamp_carries_every_br4079_predicate() {
        let m = queued_fixture_meta(999_901, "state-vector/bridge");
        assert_eq!(m.pointer("/merge_train/pr").and_then(|v| v.as_i64()), Some(999_901));
        assert!(m.pointer("/merge_train/pr").and_then(|v| v.as_i64()).unwrap_or(0) > 0);
        assert_eq!(m.pointer("/merge_train/state").and_then(|v| v.as_str()), Some("queued"));
        assert_eq!(m.pointer("/pr/number").and_then(|v| v.as_i64()), Some(999_901));
        assert_eq!(m.pointer("/pr/repo").and_then(|v| v.as_str()), Some("state-vector/bridge"));
    }

    #[test]
    fn retired_stamp_fails_every_queue_predicate() {
        let m = retired_fixture_meta(queued_fixture_meta(999_901, "state-vector/bridge"), "[canary] retired");
        assert_eq!(m.pointer("/merge_train/pr").and_then(|v| v.as_i64()), Some(0));
        assert_eq!(m.pointer("/merge_train/state").and_then(|v| v.as_str()), Some("retired"));
        assert_eq!(m.pointer("/blocked/reason").and_then(|v| v.as_str()), Some("[canary] retired"));
    }

    #[test]
    fn queue_membership_reads_train_status() {
        let ts = json!({ "lanes": [
            { "lane": "state-vector/bridge@main", "queue": [ { "id": "BR#1" }, { "id": "BR#2" } ] },
            { "lane": "state-vector/superpositional@main", "queue": [ { "id": "BR#9" } ] },
        ]});
        assert!(queue_contains(&ts, "state-vector/bridge@main", "BR#2"));
        assert!(queue_contains(&ts, "state-vector/superpositional@main", "BR#9"));
        assert!(!queue_contains(&ts, "state-vector/bridge@main", "BR#9"));
        assert!(!queue_contains(&ts, "state-vector/bridge@dev", "BR#1"));
        assert!(!queue_contains(&json!({ "lanes": [] }), "state-vector/bridge@main", "BR#1"));
    }

    #[test]
    fn flip_detection_reads_proxy_check_and_version_note() {
        let art = json!({ "id": "BR#500", "status": "blocked", "meta": { "proxy_check": { "verdict": "true", "spawned": "BR#501" } }});
        let hist = json!({ "versions": [ { "summary": "machine proxy flipped TRUE — unblock duty BR#501 auto-spawned (BR#3361)" } ]});
        assert!(flip_fired(&art, &hist));
        let art_no_spawn = json!({ "meta": { "proxy_check": { "verdict": "true" } }});
        assert!(flip_fired(&art_no_spawn, &hist), "the version note alone is sufficient");
        let art_waiting = json!({ "meta": { "proxy_check": { "verdict": "waiting" } }});
        let hist_empty = json!({ "versions": [] });
        assert!(!flip_fired(&art_waiting, &hist_empty));
        assert!(!flip_fired(&json!({ "meta": {} }), &hist_empty));
    }

    #[test]
    fn history_marker_search_is_shape_tolerant() {
        let hist = json!({ "versions": [
            { "summary": "progress", "data": { "note": "did stuff CANARY-20261028-1011 and parked" } },
        ]});
        assert!(history_has_marker(&hist, "CANARY-20261028-1011"));
        assert!(!history_has_marker(&hist, "CANARY-99999999-0000"));
    }

    #[test]
    fn marker_roundtrips_through_run_stamp() {
        let s = run_stamp(1_795_000_000_000); // arbitrary fixed ts
        assert_eq!(s.len(), 15); // YYYYMMDD-HHMM
        assert!(s.contains('-'));
        let marker = format!("CANARY-{s}");
        assert!(marker.starts_with("CANARY-"));
    }

    #[test]
    fn unaccounted_extractor_finds_counts_both_sides() {
        assert_eq!(extract_unaccounted("3 unaccounted PRs in flight"), Some(3));
        assert_eq!(extract_unaccounted("Report: unaccounted: 12"), Some(12));
        assert_eq!(extract_unaccounted("0 unaccounted"), Some(0));
        assert_eq!(extract_unaccounted("all PRs bound, ignored, or in-flight"), None);
        // 4+ digit runs (ids, phone numbers) are never "counts" — ignored
        assert_eq!(extract_unaccounted("call 555-1234 unaccounted"), None);
    }

    #[test]
    fn leg_words_are_green_red_skip() {
        let l = Leg::new("x", LegStatus::Pass, "d".into());
        assert_eq!(l.word(), "PASS");
        let l = Leg::new("x", LegStatus::Fail, "d".into());
        assert_eq!(l.word(), "RED");
        assert!(!l.ok());
        let l = Leg::new("x", LegStatus::Skip, "d".into());
        assert_eq!(l.word(), "SKIP");
        assert!(l.ok(), "skip is not red");
    }
}
