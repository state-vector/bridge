/** Board↔GitHub reconciliation (BR#4170) — the pure join + accounting layer.
 *
 *  The invariant: GitHub is the source of truth for PR-shaped work; the board
 *  is a projection of it — and a projection that can drift is worse than
 *  none. Every open PR with a review decision is, at all times, one of
 *  exactly three things on the board: **bound** to a card, **explicitly
 *  ignored** with a recorded reason, or **in-flight** on a spawned duty.
 *  Anything else past the actionable age is an ALARM, not a silence (the
 *  #2466 class: a session died post-open and the PR sat APPROVED+MERGEABLE
 *  34h, invisible to every stamp-gated mechanism).
 *
 *  BR#5677: BINDING outranks the review gate. A PR whose card exists is
 *  accounted as bound even with NO review decision — train-owned PRs read
 *  reviewDecision="" (bot approvals are dismissed on every rebase, and the
 *  field has been observed empty repo-wide even beside a live approval —
 *  the BR#5640 trace refinement; whatever the cause, the accounting must
 *  not depend on it). Gating the binding lookup on a review decision made
 *  the whole accounting read green vacuously ("0 bound / 54 unreviewed")
 *  while the train held 37 cars. `unreviewed` counts only
 *  genuinely-unbound PRs.
 *
 *  Division of labour (accepted BR#3507/BR#3499: the hub holds NO VCS
 *  credentials): a gateway daemon runs the read-only `gh pr list` and feeds
 *  observations via reconcile.report; the HUB owns this join, the decisions,
 *  and every board mutation. Decisions here are ADVISORY data — the DO
 *  applies them (spawn duties, record misses, close via provenance) and
 *  audits each application. Nothing here merges, nothing queues: a spawned
 *  verify duty is the standard 5c-gated verify, and verify ACCEPTANCE stamps
 *  the queue exactly as the normal flow does (BR#4079 — reconcile FEEDS the
 *  stamps, never bypasses them).
 *
 *  Pure by construction (the provenance.ts pattern): no I/O, no clock, no
 *  randomness — `now` is a parameter. The DO drill (test/reconcile.test.ts
 *  tier 2) proves the application; this module is where the law is pinned.
 */

// ---------- observed GitHub facts (gateway-fed, hub-normalized) ----------

export interface ReconcilePr {
  number: number;
  title: string | null;
  /** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null (nobody reviewed yet). */
  reviewDecision: string | null;
  /** MERGEABLE | CONFLICTING | UNKNOWN | null. */
  mergeable: string | null;
  /** CLEAN | BLOCKED | BEHIND | DIRTY | UNSTABLE | ... (destination state). */
  mergeStateStatus: string | null;
  headRefOid: string | null;
  headRefName: string | null;
  /** ISO 8601 — the PR's last update; age is measured against it. */
  updatedAt: string | null;
  isDraft: boolean;
  /** BR#6384: OPEN | MERGED | CLOSED | null — null is the legacy open feed
   *  (a row fetched with --state open is open by construction). MERGED rows
   *  ride ADDITIVELY beside the open rows (the merged feed, BR#4658's probe
   *  grammar applied to the reconcile join) and are the anti-languish
   *  receipt: the feed itself observing a bound PR merged. */
  state: string | null;
  /** BR#6384: the merge commit sha on a MERGED row — the citable receipt
   *  for the observed-merge close. Null on open rows and legacy feeds. */
  mergeCommit: string | null;
}

/** BR#6384: the feed partition. A row is an OPEN-feed row when it carries no
 *  state (legacy shape — `--state open` rows) or state OPEN; MERGED/CLOSED
 *  rows are observation receipts, never queue members — they feed the
 *  observed-merge loop only and must never be judged as live PRs. */
export function prRowIsOpen(p: ReconcilePr): boolean {
  return p.state === null || String(p.state).toUpperCase() === "OPEN";
}

/** Normalize one raw `gh pr list --json` row. Drops junk rows (missing,
 *  non-number, or non-positive number) — a malformed observation must never
 *  kill a report, and an unnormalizable PR would otherwise sit unaccounted
 *  forever. The number must be an actual JSON number: a hand-rolled reporter
 *  sending strings should fail loudly here, not be silently laundered. */
export function normalizePr(raw: unknown): ReconcilePr | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const number = r.number;
  if (typeof number !== "number" || !Number.isFinite(number) || number <= 0) return null;
  const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
  return {
    number,
    title: s(r.title),
    reviewDecision: s(r.reviewDecision),
    mergeable: s(r.mergeable),
    mergeStateStatus: s(r.mergeStateStatus),
    headRefOid: s(r.headRefOid),
    headRefName: s(r.headRefName),
    updatedAt: s(r.updatedAt),
    isDraft: r.isDraft === true,
    // BR#6384: passthrough — both null on the legacy open feed (a reporter
    // that never learned the merged feed still reports exactly as before).
    state: s(r.state),
    mergeCommit: s(r.mergeCommit),
  };
}

// ---------- board projection (DO-extracted, per repo) ----------

/** One open card bound to this repo via a PR leg (meta.pr or a meta.prs leg). */
export interface ReconcileBinding {
  card: string;
  status: string;
  pr: number;
  /** Open review-role children of the card — a verify already in flight via
   *  the normal flow (reconcile must not spawn a second one). */
  open_verify_children: number;
  /** Has the queue stamp (BR#4079: blocked + merge_train.pr>0 + the reason
   *  prefix)? A queued card is the train's business — never re-spawned at. */
  queued: boolean;
  /** Reverse reconcile inputs (reconcile_seen storage): */
  /** The binding's PR is absent from this cycle's open list. */
  missing: boolean;
  /** True when the missing-marker was set by an EARLIER report (this is the
   *  second consecutive miss — the two-consecutive guard against gh flake). */
  missing_set_before_report: boolean;
  /** Provenance row for (repo, pr), when the train stamped the merge. */
  provenance: { merge_sha: string; signer: string } | null;
  /** BR#5151: a standing merge-lane card (meta.lane / infrastructure tag).
   *  Live subsystem — reconcile never spawns at it, never duties it, and
   *  NEVER provenance-closes it (the BR#5050 incident); the train's settle
   *  path is the only lane writer. */
  lane: boolean;
}

/** A recorded ignore-with-reason (reconcile_ignores). */
export interface ReconcileIgnore {
  pr: number;
  reason: string;
}

/** One reconcile duty ever spawned for this repo (reconcile_duties — one per
 *  PR per kind, forever: dedupe by ledger, not by liveness). */
export interface ReconcileDuty {
  pr: number;
  kind: "verify" | "disposition" | "reverse";
  duty_id: string;
  /** The duty card's CURRENT status (null if the card was hard-deleted). */
  card_status: string | null;
}

// ---------- config (settings-sourced; the DO passes them in) ----------

export interface ReconcileConfig {
  now: number;
  /** An approved+mergeable unbound PR becomes actionable past this age. */
  verify_age_ms: number;
  /** A changes-requested/conflicting unbound PR becomes actionable past this age. */
  disposition_age_ms: number;
}

// ---------- decisions ----------

export type ReconcileDecision =
  | { action: "bound"; card: string }
  | { action: "inflight"; duty_id: string; via: "duty" | "verify-children" }
  | { action: "ignored" }
  | { action: "spawn_verify"; card: string | null }
  | { action: "spawn_disposition" }
  /** Destination-blocked approved PR (base red/behind): bind it so it is
   *  visible; the verify duty comes when a later cycle sees it mergeable. */
  | { action: "spawn_tracking" }
  /** Young (or unreviewed/draft) — inside the actionable-age grace window. */
  | { action: "grace" }
  /** Reverse reconcile: the PR was seen this cycle — clear any missing marker. */
  | { action: "seen"; card: string }
  /** BR#5151: the binding is a standing merge-lane card — the train owns it
   *  forever; account it and move on (never spawn, duty, clock, or close). */
  | { action: "lane_exempt"; card: string }
  /** First miss: start the missing clock (no action yet). */
  | { action: "mark_missing"; card: string }
  /** Second consecutive miss + a provenance row: close the card (machine
   *  proxy — the train stamped the merge). */
  | { action: "reverse_close"; card: string; merge_sha: string; signer: string }
  /** Second consecutive miss, no provenance: the PR left open state without
   *  a merge record — spawn a ruling duty, never a silent close. */
  | { action: "spawn_reverse" }
  /** BR#6384 anti-languish: the feed itself observed this binding's PR
   *  MERGED (the merged rows ride beside the open feed) — close the card
   *  citing the live mergeCommit. No provenance row and no ruling duty are
   *  needed: the observation IS the receipt (extends BR#6330's
   *  provenance-only close to every merge path). */
  | { action: "observed_merge_close"; card: string; merge_sha: string }
  /** A duty already exists for this PR but the PR is STILL unbound past the
   *  actionable age (the duty died without binding it) — the drift alarm. */
  | { action: "alarm_unaccounted"; why: string };

export interface ReconcileJudgement {
  pr: number;
  decision: ReconcileDecision;
  reason: string;
}

export interface ReconcileAccounting {
  repo: string;
  /** Open PRs with a review decision (drafts excluded). */
  open_reviewed: number;
  bound: number;
  ignored: number;
  /** Duty open from a PRIOR cycle (or a live verify child on the bound card). */
  inflight: number;
  /** Duties issued THIS cycle. */
  spawned: number;
  /** Actionable-in-principle but inside the age grace — not a drift. */
  grace: number;
  /** Past every grace and still none of the three — fails the run. */
  unaccounted: number;
  /** Informational: no review decision yet (mid-review, owner active) + drafts. */
  unreviewed: number;
  /** Reverse reconcile: bindings whose PR left the open list. */
  reverse_missing: number;
  reverse_closed: number;
  reverse_dutied: number;
  /** BR#5151: standing lane bindings — accounted, exempt from the reverse
   *  legs entirely (no close, no duty, no missing clock). */
  reverse_lane_exempt: number;
  /** BR#5370: queued bindings whose PR left the open list — the train owns
   *  them (queued/mid-rebase is not vanished); the missing clock is cleared
   *  and no ruling duty spawns (BR#4894 Finding A). */
  reverse_train_exempt: number;
  /** BR#6384: bindings whose bound PR was observed MERGED by this cycle's
   *  feed — each one is a card closed citing the live mergeCommit. */
  observed_merged: number;
  accounted: number;
  /** false ⇒ the run FAILED — alarm to the sink. */
  ok: boolean;
}

const OPEN_CARD_STATUSES = new Set(["todo", "in_progress", "in_review", "blocked"]);
export const isActionableDutyCard = (status: string | null): boolean => !!status && OPEN_CARD_STATUSES.has(status);

/** PR age in ms from its updatedAt (null when unparseable — treated as 0, i.e.
 *  maximally fresh, so a malformed timestamp can never accelerate an alarm). */
export function prAgeMs(updatedAt: string | null, now: number): number {
  if (!updatedAt) return 0;
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, now - t);
}

/** The accounting line — THE canary for the invariant. A run with any
 *  unaccounted PR renders the ALARM tail and fails (ok=false). */
export function accountingLine(a: ReconcileAccounting): string {
  const inflight = a.inflight + a.spawned;
  const base = `${a.open_reviewed} open reviewed / ${a.bound} bound / ${a.ignored} ignored-with-reason / ${inflight} in-flight — ${a.accounted} accounted`;
  const alarm = a.ok ? "" : ` — ALARM: ${a.unaccounted} unaccounted`;
  const info = a.grace || a.unreviewed ? ` (+${a.grace} in age grace, +${a.unreviewed} unreviewed)` : "";
  const reverse = a.reverse_missing ? ` [reverse: ${a.reverse_missing} missing, ${a.reverse_closed} closed, ${a.reverse_dutied} dutied${a.reverse_lane_exempt ? `, ${a.reverse_lane_exempt} lane-exempt` : ""}${a.reverse_train_exempt ? `, ${a.reverse_train_exempt} train-owned` : ""}]` : a.reverse_lane_exempt || a.reverse_train_exempt ? ` [reverse:${a.reverse_lane_exempt ? ` ${a.reverse_lane_exempt} lane-exempt` : ""}${a.reverse_train_exempt ? ` ${a.reverse_train_exempt} train-owned` : ""}]` : "";
  const observed = a.observed_merged ? ` [observed-merge: ${a.observed_merged} observed-merged closed]` : "";
  return base + alarm + info + reverse + observed;
}

/** Join one repo's observed open PRs against the board projection and emit
 *  one judgement per PR plus the accounting report. The order of checks IS
 *  the precedence: binding > review-gate (BR#5677: a bound card accounts the
 *  PR even with NO review decision — train-owned PRs read reviewDecision=""
 *  because branch protection dismisses the bot approval on every rebase) >
 *  ignore > duty(in-flight) > duty(dead, alarm) > spawn/grace. See the
 *  module docstring for the invariants. */
export function reconcileJoin(args: {
  repo: string;
  prs: ReconcilePr[];
  bindings: ReconcileBinding[];
  ignores: ReconcileIgnore[];
  duties: ReconcileDuty[];
  cfg: ReconcileConfig;
}): { judgements: ReconcileJudgement[]; accounting: ReconcileAccounting } {
  const { repo, prs, cfg } = args;
  const bindings = new Map(args.bindings.map((b) => [b.pr, b]));
  const ignores = new Map(args.ignores.map((i) => [i.pr, i]));
  const dutiesByPr = new Map<number, ReconcileDuty[]>();
  for (const d of args.duties) dutiesByPr.set(d.pr, [...(dutiesByPr.get(d.pr) ?? []), d]);

  const acc: ReconcileAccounting = {
    repo,
    open_reviewed: 0,
    bound: 0,
    ignored: 0,
    inflight: 0,
    spawned: 0,
    grace: 0,
    unaccounted: 0,
    unreviewed: 0,
    reverse_missing: 0,
    reverse_closed: 0,
    reverse_dutied: 0,
    reverse_lane_exempt: 0,
    reverse_train_exempt: 0,
    observed_merged: 0,
    accounted: 0,
    ok: true,
  };
  const judgements: ReconcileJudgement[] = [];

  // BR#6384: the feed partition — only OPEN-feed rows are queue members.
  // MERGED/CLOSED rows riding beside them are observation receipts for the
  // observed-merge loop below; judging them as live PRs would mis-account
  // every merged PR on the repo as board state.
  const openRows = prs.filter(prRowIsOpen);
  const drafts = openRows.filter((p) => p.isDraft);
  const reviewed = openRows.filter((p) => !p.isDraft);
  for (const p of reviewed) {
    const age = prAgeMs(p.updatedAt, cfg.now);
    const approved = p.reviewDecision === "APPROVED";
    // verify-eligible = the PR could pass the 5c gate TODAY: mergeable AND a
    // clean destination. BLOCKED/BEHIND is the base-fix class (bind-only — a
    // verify duty would bounce on mergeability by construction).
    const verifyEligible = approved && p.mergeable === "MERGEABLE" && p.mergeStateStatus === "CLEAN";
    const destinationBlocked = approved && (p.mergeStateStatus === "BLOCKED" || p.mergeStateStatus === "BEHIND");
    const conflicting = p.mergeable === "CONFLICTING" || p.mergeStateStatus === "DIRTY";
    const changesRequested = p.reviewDecision === "CHANGES_REQUESTED";
    // 1. bound — an open card rides this PR (the #2466 fix: a card that
    //    exists but was never queued still accounts the PR; if its verify
    //    never spawned and the PR is verify-eligible past the grace, spawn
    //    the standard duty on the EXISTING card — never a second card).
    //    BR#5677: the binding check runs BEFORE the reviewDecision gate.
    //    Train-owned PRs read reviewDecision="" (bot approvals are
    //    dismissed on every rebase — and the field has been observed empty
    //    repo-wide even beside a live approval, the BR#5640 trace; the
    //    accounting must not depend on the cause), so gating the binding
    //    lookup on a review decision made the entire bound/duty accounting
    //    unreachable for exactly the PRs the train owns — 56 of them read
    //    "unreviewed" while their cards sat in the bindings map (the
    //    census: "0 bound / 54 unreviewed" against a 37-car train). A
    //    bound card accounts the PR regardless of reviewDecision; with no
    //    decision, approved/verifyEligible are false by construction, so
    //    an unreviewed bound card can never spawn a verify duty — it
    //    accounts as bound (queued/lane/in-flight per its stamps).
    const b = bindings.get(p.number);
    if (b) {
      if (b.lane) {
        // BR#5151: the bound card is a standing merge-lane lane — the train
        // owns it forever. Account it as bound and never spawn at it (the
        // BR#5050 class: a verify duty parented onto the lane card is the
        // foothold for the provenance mis-stamp).
        acc.bound++;
        acc.accounted++;
        judgements.push({ pr: p.number, decision: { action: "lane_exempt", card: b.card }, reason: "standing merge-lane card (BR#5151) — the train owns it; reconcile never spawns or closes at it" });
      } else if (b.queued) {
        acc.bound++;
        acc.accounted++;
        judgements.push({ pr: p.number, decision: { action: "bound", card: b.card }, reason: "queued on the merge train (BR#4079 stamp) — the train owns it" });
      } else if (b.open_verify_children > 0) {
        acc.inflight++;
        acc.accounted++;
        judgements.push({ pr: p.number, decision: { action: "inflight", duty_id: b.card, via: "verify-children" }, reason: "bound; a verify duty is open on the bound card (normal flow)" });
      } else if (verifyEligible && age > cfg.verify_age_ms && !hasDuty(dutiesByPr, p.number, "verify")) {
        acc.spawned++;
        acc.accounted++;
        judgements.push({ pr: p.number, decision: { action: "spawn_verify", card: b.card }, reason: `bound but never verified — approved+mergeable ${Math.round(age / 3_600_000)}h; spawning the standard verify duty on ${b.card}` });
      } else {
        acc.bound++;
        acc.accounted++;
        judgements.push({ pr: p.number, decision: { action: "bound", card: b.card }, reason: boundReason(approved, verifyEligible, age, cfg) });
      }
      continue;
    }
    // BR#5677: only GENUINELY-unbound PRs reach the unreviewed bucket — a
    // bound PR above is accounted whatever GitHub says about its reviews.
    if (!p.reviewDecision) {
      acc.unreviewed++;
      judgements.push({ pr: p.number, decision: { action: "grace" }, reason: "no review decision yet — owner active, out of the invariant's scope" });
      continue;
    }
    acc.open_reviewed++;
    // 2. ignored-with-reason — an explicit human/agent ruling.
    if (ignores.has(p.number)) {
      acc.ignored++;
      acc.accounted++;
      judgements.push({ pr: p.number, decision: { action: "ignored" }, reason: `ignored-with-reason: ${ignores.get(p.number)!.reason}` });
      continue;
    }
    // 3. a duty for this PR — in-flight while its card lives; a DEAD duty on
    //    a still-unbound actionable PR is exactly the drift this module exists
    //    to alarm on (one duty per PR ever — no silent respawn over a corpse).
    const ds = dutiesByPr.get(p.number) ?? [];
    const live = ds.find((d) => isActionableDutyCard(d.card_status));
    if (live) {
      acc.inflight++;
      acc.accounted++;
      judgements.push({ pr: p.number, decision: { action: "inflight", duty_id: live.duty_id, via: "duty" }, reason: `${live.kind} duty ${live.duty_id} in flight` });
      continue;
    }
    const dead = ds.find((d) => !isActionableDutyCard(d.card_status));
    const actionable = (verifyEligible || destinationBlocked || ((changesRequested || conflicting) && age > cfg.disposition_age_ms)) && age > cfg.verify_age_ms;
    if (dead && actionable) {
      acc.unaccounted++;
      judgements.push({ pr: p.number, decision: { action: "alarm_unaccounted", why: `${dead.kind} duty ${dead.duty_id} ended (${dead.card_status ?? "deleted"}) without binding the PR` }, reason: `past the actionable age and none of the three — the prior duty died unbound` });
      continue;
    }
    // 4. spawn per the action matrix.
    if (verifyEligible && age > cfg.verify_age_ms) {
      acc.spawned++;
      acc.accounted++;
      judgements.push({ pr: p.number, decision: { action: "spawn_verify", card: null }, reason: `orphan approved+mergeable PR ${Math.round(age / 3_600_000)}h old — binding + spawning the standard verify duty (the #2466 class)` });
      continue;
    }
    if (destinationBlocked && age > cfg.verify_age_ms) {
      acc.spawned++;
      acc.accounted++;
      judgements.push({ pr: p.number, decision: { action: "spawn_tracking" }, reason: `approved but destination-blocked (${p.mergeStateStatus}) — binding so it is visible; verify comes when the base greens` });
      continue;
    }
    if ((changesRequested || conflicting) && age > cfg.disposition_age_ms) {
      acc.spawned++;
      acc.accounted++;
      judgements.push({ pr: p.number, decision: { action: "spawn_disposition" }, reason: `${changesRequested ? "changes requested" : "conflicting"} unbound ${Math.round(age / 3_600_000)}h — spawning a disposition duty (fix, or close-with-reason)` });
      continue;
    }
    // 5. inside the grace window.
    acc.grace++;
    judgements.push({ pr: p.number, decision: { action: "grace" }, reason: `unbound but inside the actionable grace (${Math.round(age / 3_600_000)}h old)` });
  }
  acc.unreviewed += drafts.length; // drafts are informational, outside the invariant

  // ---- BR#6384 observation loop: MERGED rows against the bindings ----
  // The feed's MERGED rows are the anti-languish receipt: a binding whose PR
  // shows MERGED with a citable mergeCommit has LANDED — the card closes
  // citing the live sha, whatever path merged it (train, human click, gh pr
  // merge out-of-band). Lane cards stay exempt (BR#5151: the train's settle
  // path is the only lane writer). Bindings closed here are skipped by the
  // reverse loop below — the observation owns them this cycle, and a
  // "vanished from the open list" ruling would be noise on top of a receipt.
  const observedClosed = new Set<number>();
  for (const p of prs) {
    if (String(p.state ?? "").toUpperCase() !== "MERGED" || !p.mergeCommit) continue;
    const b = bindings.get(p.number);
    if (!b) continue; // merged with no bound card — nothing to close
    if (b.lane) {
      acc.bound++;
      judgements.push({ pr: p.number, decision: { action: "lane_exempt", card: b.card }, reason: "standing merge-lane card (BR#5151) — the observation never closes it; the train's settle path is the only lane writer" });
      continue;
    }
    observedClosed.add(p.number);
    acc.observed_merged++;
    judgements.push({ pr: p.number, decision: { action: "observed_merge_close", card: b.card, merge_sha: p.mergeCommit }, reason: `the feed observed the bound PR MERGED (${p.mergeCommit.slice(0, 9)}) — closing citing the live mergeCommit (BR#6384), no provenance row or ruling duty needed` });
  }

  acc.accounted = acc.bound + acc.ignored + acc.inflight + acc.spawned + acc.observed_merged;
  acc.ok = acc.unaccounted === 0;

  // ---- reverse reconcile: bindings whose PR is gone from the open list ----
  const openPrs = new Set(prs.map((p) => p.number));
  // BR#5370: a card whose meta binds the same PR twice (meta.pr + a meta.prs
  // row) produces TWO bindings for one pr — the reverse loop is the only
  // per-binding loop, so without a per-pr guard it emitted the spawn decision
  // TWICE in one pass (BR#5365/5366: created_ts identical to the ms — the
  // 5th same-ms duty pair). First binding wins, exactly as the apply path's
  // `bindings.find` resolves the parent.
  const reverseJudged = new Set<number>();
  for (const b of args.bindings) {
    if (reverseJudged.has(b.pr)) continue;
    reverseJudged.add(b.pr);
    if (observedClosed.has(b.pr)) {
      // BR#6384: the observation loop closed this binding this cycle — its
      // PR "leaving the open list" is the merge, already receipted. No
      // missing clock, no reverse close, no ruling duty on top.
      continue;
    }
    if (b.lane) {
      // BR#5151: a standing lane card is never a zombie — its bootstrap PR
      // leaving the open list (or a stray provenance row on the card) is not
      // a merge to close over. No missing clock, no ruling duty, no close.
      acc.reverse_lane_exempt++;
      judgements.push({ pr: b.pr, decision: { action: "lane_exempt", card: b.card }, reason: "standing merge-lane card (BR#5151) — exempt from reverse reconcile: never closed, never dutied, never clocked" });
      continue;
    }
    if (!b.missing) {
      judgements.push({ pr: b.pr, decision: { action: "seen", card: b.card }, reason: "PR still open — missing clock cleared" });
      continue;
    }
    acc.reverse_missing++;
    if (b.queued) {
      // BR#4894 Finding A / BR#5370: queued/mid-rebase is NOT vanished. A
      // queued binding (blocked + the merge_train stamp) is the train's
      // business — its PR leaving the open list (rebase window, gh page
      // drift) must not start the missing clock or spawn a ruling duty.
      // Occurrence #7: BR#5349 was queued on PR #345 when the false-positive
      // spawn fired (the PR merged 7.1 minutes LATER). Clear the clock so
      // the two-consecutive guard re-arms fresh if the binding ever unqueues.
      acc.reverse_train_exempt++;
      judgements.push({ pr: b.pr, decision: { action: "seen", card: b.card }, reason: "queued on the merge train — queued/mid-rebase is not vanished (BR#4894 Finding A); missing clock cleared, no ruling duty" });
      continue;
    }
    if (!b.missing_set_before_report) {
      judgements.push({ pr: b.pr, decision: { action: "mark_missing", card: b.card }, reason: "first cycle absent from the open list — starting the two-consecutive-missing guard" });
      continue;
    }
    if (b.provenance) {
      acc.reverse_closed++;
      judgements.push({ pr: b.pr, decision: { action: "reverse_close", card: b.card, merge_sha: b.provenance.merge_sha, signer: b.provenance.signer }, reason: `PR left the open list and the train stamped the merge (${b.provenance.merge_sha.slice(0, 9)}) — closing via provenance, no zombie card` });
      continue;
    }
    const ruled = (dutiesByPr.get(b.pr) ?? []).some((d) => d.kind === "reverse");
    if (ruled) continue; // already accounted by the prior cycle's duty
    acc.reverse_dutied++;
    judgements.push({ pr: b.pr, decision: { action: "spawn_reverse" }, reason: "PR left the open list with NO provenance row — spawning a ruling duty (merged outside the train, or closed: someone rules, never silence)" });
  }

  return { judgements, accounting: acc };
}

function hasDuty(byPr: Map<number, ReconcileDuty[]>, pr: number, kind: ReconcileDuty["kind"]): boolean {
  return (byPr.get(pr) ?? []).some((d) => d.kind === kind);
}

function boundReason(approved: boolean, verifyEligible: boolean, ageMs: number, cfg: ReconcileConfig): string {
  if (verifyEligible) return `bound; verify grace not yet elapsed (${Math.round(ageMs / 3_600_000)}h of ${Math.round(cfg.verify_age_ms / 3_600_000)}h)`;
  if (approved) return "bound; waiting on a clean destination (base green / up to date)";
  return "bound to a card — accounted";
}
