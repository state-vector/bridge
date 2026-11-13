import { describe, expect, it } from "vitest";
import {
  accountingLine,
  isActionableDutyCard,
  normalizePr,
  originTaskId,
  prAgeMs,
  prRowIsOpen,
  reconcileJoin,
  type ReconcileBinding,
  type ReconcileConfig,
  type ReconcileDuty,
  type ReconcileIgnore,
  type ReconcileJudgement,
  type ReconcilePr,
} from "../src/kb/reconcile.ts";

/**
 * Board↔GitHub reconciliation (BR#4170) — the pure join + accounting layer.
 *
 * Tier 1 (this file): the law. The invariant — every open reviewed PR is
 * bound / ignored-with-reason / in-flight within one cycle, anything else
 * past the actionable age is an ALARM — plus the precedence order (binding >
 * ignore > duty-live > duty-dead-alarm > spawn matrix > grace), the
 * verify-eligibility refinement (mergeStateStatus CLEAN, or bind-only
 * tracking for BLOCKED/BEHIND), and the reverse-reconcile guard
 * (two-consecutive-missing, provenance-only close).
 *
 * Tier 2 (the real DO drill) lives in train-hub.test.ts — the application of
 * these decisions against the bundled worker.
 */

const NOW = 1_700_000_000_000;
const H = 3_600_000;
const PROGRESS = { open_total: 0, queued: 0, repairing: 0, verifying: 0, held: 0, stranded: 0 };
const CFG: ReconcileConfig = { now: NOW, verify_age_ms: 2 * H, disposition_age_ms: 24 * H };

const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * H).toISOString();

const pr = (number: number, over: Partial<ReconcilePr> = {}): ReconcilePr => ({
  number,
  title: `PR ${number}`,
  reviewDecision: "APPROVED",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  headRefOid: "a".repeat(40),
  headRefName: `feature/${number}`,
  updatedAt: iso(5),
  isDraft: false,
  state: "OPEN", // BR#6384: the helper mints open-feed rows by default
  mergeCommit: null,
  ...over,
});

const binding = (pr_: number, over: Partial<ReconcileBinding> = {}): ReconcileBinding => ({
  card: `BR#900${pr_}`,
  status: "in_progress",
  pr: pr_,
  open_verify_children: 0,
  queued: false,
  missing: false,
  missing_set_before_report: false,
  provenance: null,
  lane: false,
  ...over,
});

const duty = (pr_: number, over: Partial<ReconcileDuty> = {}): ReconcileDuty => ({
  pr: pr_,
  kind: "verify",
  duty_id: `BR#800${pr_}`,
  card_status: "in_progress",
  ...over,
});

const join = (args: {
  prs: ReconcilePr[];
  bindings?: ReconcileBinding[];
  ignores?: ReconcileIgnore[];
  duties?: ReconcileDuty[];
  cfg?: Partial<ReconcileConfig>;
}) =>
  reconcileJoin({
    repo: "state-vector/bridge",
    prs: args.prs,
    bindings: args.bindings ?? [],
    ignores: args.ignores ?? [],
    duties: args.duties ?? [],
    cfg: { ...CFG, ...args.cfg },
  });

describe("all-open delivery progress", () => {
  it("starts independent verification for a stranded PR with an exact-head bot approval and no aggregate decision", () => {
    const candidate = pr(3152, { reviewDecision: null, updatedAt: iso(50) });
    const approval = { author: { login: "superpositional-sync" }, state: "APPROVED",
      commit: { oid: candidate.headRefOid }, submittedAt: iso(5) };
    const bind = binding(candidate.number, { status: "blocked", progress: "stranded" });
    const observed = normalizePr({ ...candidate, reviews: [approval] })!;
    expect(join({ prs: [observed], bindings: [bind] }).judgements[0].decision)
      .toEqual({ action: "spawn_verify", card: bind.card });

    const rejected = [
      { ...candidate, reviews: [{ ...approval, commit: { oid: "b".repeat(40) } }] },
      { ...candidate, reviews: [approval, { ...approval, state: "DISMISSED", submittedAt: iso(4) }] },
      { ...candidate, reviews: [approval, { ...approval, author: { login: "reviewer" }, state: "CHANGES_REQUESTED" }] },
      { ...candidate, reviewDecision: "CHANGES_REQUESTED", reviews: [approval] },
      { ...candidate, isDraft: true, reviews: [approval] },
    ];
    for (const row of rejected) {
      expect(join({ prs: [normalizePr(row)!], bindings: [bind] }).judgements[0].decision.action).not.toBe("spawn_verify");
    }
  });

  it("bounds undecided and draft grace, including dead duties", () => {
    for (const extra of [{ reviewDecision: null }, { isDraft: true, reviewDecision: null }]) {
      const aged = join({ prs: [pr(99, { ...extra, updatedAt: iso(50) })] });
      expect(aged.judgements[0].decision.action).toBe("spawn_disposition");
      const dead = join({ prs: [pr(99, { ...extra, updatedAt: iso(50) })], duties: [duty(99, { card_status: "done" })] });
      expect(dead.accounting.ok).toBe(false);
    }
  });

  it("requests one independent review for an accepted repair without relying on stale GitHub approval", () => {
    const repaired = binding(99, { status: "todo", progress: "stranded", repairAccepted: true });
    const observed = pr(99, { reviewDecision: null, mergeStateStatus: "UNSTABLE", updatedAt: iso(50) });
    const initial = join({ prs: [observed], bindings: [repaired] });
    expect(initial.judgements[0].decision).toEqual({ action: "verify_repaired", card: repaired.card });
    for (const changes of [
      { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" },
      { isDraft: true },
      { reviewDecision: "CHANGES_REQUESTED" },
      { headRefOid: null },
    ]) {
      expect(join({ prs: [{ ...observed, ...changes }], bindings: [repaired] }).judgements[0].decision.action).not.toBe("verify_repaired");
    }
    expect(join({ prs: [observed], bindings: [repaired], duties: [duty(99)] }).judgements[0].decision.action).not.toBe("verify_repaired");
    expect(join({ prs: [observed], bindings: [{ ...repaired, open_verify_children: 1 }] }).judgements[0].decision.action).not.toBe("verify_repaired");
  });

  it("keeps a live review ahead of a stranded duplicate in either binding order", () => {
    const observed = pr(3057, { reviewDecision: null, updatedAt: iso(50) });
    const current = binding(3057, { card: "BR#14047", status: "in_review", progress: "verifying", open_verify_children: 1 });
    const stale = binding(3057, { card: "BR#10150", status: "todo", progress: "stranded" });
    for (const bindings of [[current, stale], [stale, current]]) {
      const result = join({ prs: [observed], bindings });
      expect(result.judgements[0].decision).toEqual({ action: "inflight", duty_id: current.card, via: "verify-children" });
      expect(result.accounting).toMatchObject({ verifying: 1, stranded: 0, unaccounted: 0 });
    }
  });

  it("an existing card with no executable action is stranded, not accounted", () => {
    const r = join({ prs: [pr(99, { updatedAt: iso(50), mergeable: "CONFLICTING" })], bindings: [binding(99, { progress: "stranded" })] });
    expect(r.accounting.stranded).toBe(1);
    expect(r.accounting.accounted).toBe(0);
    expect(r.accounting.ok).toBe(false);
    expect(r.judgements[0].decision).toMatchObject({ action: "repair_binding", reason: "conflict" });
  });
});

/** The FORWARD judgement for a PR. A bound PR gets TWO rows by design — the
 *  disposition (forward loop) plus the missing-clock report (reverse loop,
 *  which emits `seen` for every present binding) — this returns the first. */
const one = (r: ReturnType<typeof join>, number_: number): ReconcileJudgement => {
  const js = r.judgements.filter((j) => j.pr === number_);
  expect(js.length, `at least one judgement for PR ${number_}`).toBeGreaterThanOrEqual(1);
  return js[0];
};

// ---------- normalizePr ----------

describe("normalizePr", () => {
  it("keeps a full row intact (no coercion — types stay types)", () => {
    const p = pr(7);
    expect(normalizePr({ ...p })).toEqual(p);
  });

  it("drops non-object rows — a malformed observation never kills a report", () => {
    expect(normalizePr(null)).toBeNull();
    expect(normalizePr("12")).toBeNull();
    expect(normalizePr(42)).toBeNull();
    expect(normalizePr([])).toBeNull();
  });

  it("drops rows whose number is not a finite positive JSON number", () => {
    expect(normalizePr({ ...pr(1), number: "12" })).toBeNull(); // string → laundered? NO.
    expect(normalizePr({ ...pr(1), number: NaN })).toBeNull();
    expect(normalizePr({ ...pr(1), number: 0 })).toBeNull();
    expect(normalizePr({ ...pr(1), number: -3 })).toBeNull();
    expect(normalizePr({ title: "no number" })).toBeNull();
  });

  it("nulls empty/whitespace string fields (missing ≠ empty)", () => {
    const p = normalizePr({ ...pr(3), reviewDecision: "  ", headRefOid: "" })!;
    expect(p.reviewDecision).toBeNull();
    expect(p.headRefOid).toBeNull();
    expect(p.title).toBe("PR 3");
  });

  it("isDraft is strictly true-or-false (truthy junk does not make a draft)", () => {
    expect(normalizePr({ ...pr(4), isDraft: "yes" })!.isDraft).toBe(false);
    expect(normalizePr({ ...pr(4), isDraft: true })!.isDraft).toBe(true);
  });
});

// ---------- prAgeMs ----------

describe("prAgeMs", () => {
  it("measures age from updatedAt and clamps the future to 0", () => {
    expect(prAgeMs(iso(5), NOW)).toBe(5 * H);
    expect(prAgeMs(new Date(NOW + 10_000).toISOString(), NOW)).toBe(0);
  });

  it("treats null/unparseable as 0 — a broken clock can never accelerate an alarm", () => {
    expect(prAgeMs(null, NOW)).toBe(0);
    expect(prAgeMs("not a date", NOW)).toBe(0);
  });
});

// ---------- accountingLine ----------

describe("accountingLine", () => {
  it("renders the canary line with the inflight total (live + this cycle's spawns)", () => {
    const line = accountingLine({
      ...PROGRESS,
      repo: "r", open_reviewed: 3, bound: 1, ignored: 1, inflight: 0, spawned: 1,
      grace: 0, unaccounted: 0, unreviewed: 0, reverse_missing: 0, reverse_closed: 0, reverse_verifying: 0,
      reverse_dutied: 0, reverse_lane_exempt: 0, reverse_train_exempt: 0, observed_merged: 0, accounted: 3, ok: true,
    });
    expect(line).toContain("3 open reviewed / 1 bound / 1 ignored-with-reason / 1 in-flight — 3 accounted");
  });

  it("fails loudly — the ALARM tail rides exactly when ok is false", () => {
    const a = {
      ...PROGRESS,
      repo: "r", open_reviewed: 1, bound: 0, ignored: 0, inflight: 0, spawned: 0,
      grace: 0, unaccounted: 1, unreviewed: 0, reverse_missing: 0, reverse_closed: 0, reverse_verifying: 0,
      reverse_dutied: 0, reverse_lane_exempt: 0, reverse_train_exempt: 0, observed_merged: 0, accounted: 0, ok: false,
    };
    expect(accountingLine(a)).toContain("ALARM: 1 unaccounted");
    expect(accountingLine({ ...a, unaccounted: 0, ok: true, accounted: 1, bound: 1 })).not.toContain("ALARM");
  });

  it("carries the informational grace/unreviewed and reverse tails", () => {
    const line = accountingLine({
      ...PROGRESS,
      repo: "r", open_reviewed: 1, bound: 1, ignored: 0, inflight: 0, spawned: 0,
      grace: 2, unaccounted: 0, unreviewed: 3, reverse_missing: 1, reverse_closed: 1, reverse_verifying: 0,
      reverse_dutied: 0, reverse_lane_exempt: 0, reverse_train_exempt: 0, observed_merged: 0, accounted: 1, ok: true,
    });
    expect(line).toContain("(+2 in age grace, +3 unreviewed)");
    expect(line).toContain("[reverse: 1 missing, 1 closed, 0 dutied]");
  });

  it("BR#5151: lane-exempt bindings render in the reverse tail", () => {
    const line = accountingLine({
      ...PROGRESS,
      repo: "r", open_reviewed: 1, bound: 1, ignored: 0, inflight: 0, spawned: 0,
      grace: 0, unaccounted: 0, unreviewed: 0, reverse_missing: 0, reverse_closed: 0, reverse_verifying: 0,
      reverse_dutied: 0, reverse_lane_exempt: 2, reverse_train_exempt: 0, observed_merged: 0, accounted: 1, ok: true,
    });
    expect(line).toContain("[reverse: 2 lane-exempt]");
  });
});

// ---------- isActionableDutyCard ----------

describe("isActionableDutyCard", () => {
  it("todo/in_progress/in_review/blocked are live; done/superseded/null are dead", () => {
    for (const s of ["todo", "in_progress", "in_review", "blocked"]) expect(isActionableDutyCard(s)).toBe(true);
    for (const s of ["done", "superseded", null, ""]) expect(isActionableDutyCard(s)).toBe(false);
  });
});

// ---------- reconcileJoin: the forward invariant ----------

describe("reconcileJoin — forward", () => {
  it("counts open_reviewed only for decided non-drafts; unreviewed and drafts are informational", () => {
    const r = join({
      prs: [pr(1), pr(2, { reviewDecision: null }), pr(3, { isDraft: true, reviewDecision: null })],
    });
    expect(r.accounting.open_reviewed).toBe(1);
    expect(r.accounting.unreviewed).toBe(2);
    expect(r.accounting.spawned).toBe(1); // PR 1: 5h orphan → spawn (not grace)
    expect(one(r, 1).decision).toEqual({ action: "spawn_verify", card: null });
    expect(one(r, 2).decision.action).toBe("grace");
    expect(r.accounting.ok).toBe(true);
  });

  it("a queued binding is the train's business — bound, never re-spawned at", () => {
    const r = join({ prs: [pr(1)], bindings: [binding(1, { queued: true, status: "blocked" })] });
    expect(one(r, 1).decision).toEqual({ action: "bound", card: "BR#9001" });
    expect(r.accounting.bound).toBe(1);
    expect(r.accounting.accounted).toBe(1);
  });

  // BR#5677 (census BR#5634): train-owned PRs read reviewDecision="" (bot
  // approvals are dismissed on every rebase — and the field has been
  // observed empty repo-wide even beside a live approval, the BR#5640
  // trace; the accounting must not depend on the cause) — the binding check
  // must run BEFORE the review gate or the whole bound/duty accounting is
  // unreachable for exactly the PRs the train owns ("0 bound / 54
  // unreviewed" against a 37-car train, reading green vacuously).
  it("BR#5677: a bound train-owned PR with NO review decision accounts bound — the dismissed-bot class", () => {
    const r = join({
      prs: [pr(1, { reviewDecision: null })],
      bindings: [binding(1, { queued: true, status: "blocked" })],
    });
    expect(one(r, 1).decision).toEqual({ action: "bound", card: "BR#9001" });
    expect(one(r, 1).reason).toContain("the train owns it");
    expect(r.accounting.bound).toBe(1);
    expect(r.accounting.accounted).toBe(1);
    expect(r.accounting.unreviewed).toBe(0);
    expect(r.accounting.open_reviewed).toBe(0); // accounted bound, not reviewed
    expect(r.accounting.ok).toBe(true);
  });

  it("BR#5677: a bound unreviewed PR (not queued, no verify children) still accounts bound — and NEVER spawns a verify duty: approval is the evidence verify needs", () => {
    const r = join({
      prs: [pr(1, { reviewDecision: null, updatedAt: iso(30) })], // past every age gate
      bindings: [binding(1)],
    });
    expect(one(r, 1).decision.action).toBe("bound");
    expect(one(r, 1).reason).toContain("bound to a card");
    expect(r.accounting.spawned).toBe(0);
    expect(r.accounting.unreviewed).toBe(0);
    expect(r.accounting.bound).toBe(1);
  });

  it("BR#5677: a lane binding on an unreviewed PR is lane_exempt — the review gate never hid the lane cards either", () => {
    const r = join({
      prs: [pr(1, { reviewDecision: null })],
      bindings: [binding(1, { lane: true, status: "blocked" })],
    });
    expect(one(r, 1).decision).toEqual({ action: "lane_exempt", card: "BR#9001" });
    expect(r.accounting.unreviewed).toBe(0);
  });

  it("BR#5677: unreviewed counts only GENUINELY-unbound PRs", () => {
    const r = join({
      prs: [pr(1, { reviewDecision: null }), pr(2, { reviewDecision: null })],
      bindings: [binding(1, { queued: true, status: "blocked" })],
    });
    expect(r.accounting.bound).toBe(1);
    expect(r.accounting.unreviewed).toBe(1); // PR 2 only
    expect(one(r, 2).decision.action).toBe("grace");
    expect(r.accounting.ok).toBe(true);
  });

  it("a binding with an open verify child is in-flight via the normal flow", () => {
    const r = join({ prs: [pr(1)], bindings: [binding(1, { open_verify_children: 1 })] });
    expect(one(r, 1).decision).toEqual({ action: "inflight", duty_id: "BR#9001", via: "verify-children" });
    expect(r.accounting.inflight).toBe(1);
  });

  it("bound but never verified + verify-eligible past the age → the standard duty on the EXISTING card", () => {
    const r = join({ prs: [pr(1)], bindings: [binding(1)] }); // 5h old, 2h grace
    expect(one(r, 1).decision).toEqual({ action: "spawn_verify", card: "BR#9001" });
    expect(r.accounting.spawned).toBe(1);
  });

  it("DEDUPE by card binding: a duty for the PR loses to the binding — action is bound, not a second spawn", () => {
    // the #2466 fix: an open card accounts the PR; precedence puts binding
    // ahead of the duty ledger, so an existing verify duty never yields a
    // duplicate card — the duty is the card's child, the binding owns it
    const r = join({
      prs: [pr(1)],
      bindings: [binding(1)],
      duties: [duty(1, { card_status: "done" })], // even a DEAD duty doesn't out-shout the binding
    });
    expect(one(r, 1).decision.action).toBe("bound");
    expect(r.accounting.bound).toBe(1);
    expect(r.accounting.unaccounted).toBe(0);
  });

  it("bound inside the verify grace stays bound (not spawned, not alarmed)", () => {
    const r = join({ prs: [pr(1, { updatedAt: iso(1) })], bindings: [binding(1)] });
    expect(one(r, 1).decision.action).toBe("bound");
    expect(one(r, 1).reason).toContain("grace not yet elapsed");
  });

  it("an ignore-with-reason accounts the PR — the second disposition", () => {
    const r = join({ prs: [pr(1)], ignores: [{ pr: 1, reason: "bot roller" }] });
    expect(one(r, 1).decision.action).toBe("ignored");
    expect(one(r, 1).reason).toBe("ignored-with-reason: bot roller");
    expect(r.accounting.ignored).toBe(1);
  });

  it("a LIVE duty on an unbound PR is in-flight", () => {
    const r = join({ prs: [pr(1)], duties: [duty(1, { kind: "disposition", card_status: "todo" })] });
    expect(one(r, 1).decision).toEqual({ action: "inflight", duty_id: "BR#8001", via: "duty" });
    expect(r.accounting.inflight).toBe(1);
  });

  it("a DEAD duty on an unbound actionable PR is the ALARM — never a silent respawn", () => {
    const r = join({ prs: [pr(1)], duties: [duty(1, { card_status: "done" })] });
    const j = one(r, 1);
    expect(j.decision.action).toBe("alarm_unaccounted");
    expect((j.decision as any).why).toContain("ended (done) without binding");
    expect(r.accounting.unaccounted).toBe(1);
    expect(r.accounting.ok).toBe(false);
    expect(r.accounting.accounted).toBe(0);
  });

  it("an orphan verify-eligible PR past the age → project + spawn (the #2466 class)", () => {
    const r = join({ prs: [pr(1)] });
    expect(one(r, 1).decision).toEqual({ action: "spawn_verify", card: null });
    expect(one(r, 1).reason).toContain("#2466");
    expect(r.accounting.spawned).toBe(1);
  });

  it("destination-blocked (BLOCKED/BEHIND) past the age → bind-only tracking, NO verify duty", () => {
    // the design refinement: a verify duty would bounce on mergeability by
    // construction — bind it so it is visible; verify comes when CLEAN
    for (const mss of ["BLOCKED", "BEHIND"]) {
      const r = join({ prs: [pr(1, { mergeStateStatus: mss })] });
      expect(one(r, 1).decision.action).toBe("spawn_tracking");
      expect(one(r, 1).reason).toContain(mss);
    }
  });

  it("destination-blocked but young → grace (the actionable age still applies)", () => {
    const r = join({ prs: [pr(1, { mergeStateStatus: "BLOCKED", updatedAt: iso(1) })] });
    expect(one(r, 1).decision.action).toBe("grace");
  });

  it("an orphan verify-eligible but CONFLICTING PR → disposition, not verify (mergeable gate)", () => {
    const r = join({ prs: [pr(1, { mergeable: "CONFLICTING" })] }); // 5h: past 2h verify age, under 24h disposition
    expect(one(r, 1).decision.action).toBe("grace");
    const r2 = join({ prs: [pr(1, { mergeable: "CONFLICTING", updatedAt: iso(30) })] });
    expect(one(r2, 1).decision.action).toBe("spawn_disposition");
  });

  it("changes-requested past the disposition age → disposition duty", () => {
    const r = join({ prs: [pr(1, { reviewDecision: "CHANGES_REQUESTED", updatedAt: iso(30) })] });
    expect(one(r, 1).decision.action).toBe("spawn_disposition");
    expect(r.accounting.spawned).toBe(1);
  });

  it("a fresh orphan approved+mergeable PR inside the grace is NOT a drift", () => {
    const r = join({ prs: [pr(1, { updatedAt: iso(1) })] });
    expect(one(r, 1).decision.action).toBe("grace");
    expect(r.accounting.grace).toBe(1);
    expect(r.accounting.ok).toBe(true);
  });
});

// ---------- reconcileJoin: reverse reconcile ----------

describe("reconcileJoin — reverse", () => {
  it("a present PR reports seen — the missing clock never starts while it is open", () => {
    const r = join({ prs: [pr(1, { updatedAt: iso(1) })], bindings: [binding(1)] });
    expect(one(r, 1).decision.action).toBe("bound");
    const actions = r.judgements.filter((j) => j.pr === 1).map((j) => j.decision.action);
    expect(actions).toContain("seen"); // the reverse-clock row for the present binding
    expect(r.accounting.reverse_missing).toBe(0);
  });

  it("the present PR clears the missing clock — seen + bound, and NO verify spawn", () => {
    // the fixed flow: storage said missing=1 (from an earlier report) but the
    // PR is back — the clock clears; the binding path (not the spawn path)
    // accounts the PR because the duty ledger is empty and grace applies
    const r = join({
      prs: [pr(1, { updatedAt: iso(1) })],
      // the DO recomputes `missing` per cycle (present → false) while the
      // STORED clock state rides missing_set_before_report
      bindings: [binding(1, { missing: false, missing_set_before_report: true })],
    });
    const actions = r.judgements.map((j) => j.decision.action);
    expect(actions).toContain("seen");
    expect(actions).toContain("bound");
    expect(actions).not.toContain("spawn_verify");
    expect(r.accounting.reverse_missing).toBe(0);
  });

  it("first miss starts the clock — mark_missing, no close, no duty", () => {
    const r = join({ prs: [], bindings: [binding(1, { missing: true })] });
    expect(one(r, 1).decision.action).toBe("mark_missing");
    expect(r.accounting.reverse_missing).toBe(1);
    expect(r.accounting.reverse_closed).toBe(0);
    expect(r.accounting.reverse_dutied).toBe(0);
  });

  it("second consecutive miss + a provenance row → close via provenance (machine proxy)", () => {
    const r = join({
      prs: [],
      bindings: [binding(1, { missing: true, missing_set_before_report: true, provenance: { merge_sha: "f".repeat(40), signer: "detached-cody" } })],
    });
    const d: any = one(r, 1).decision;
    expect(d.action).toBe("reverse_verify");
    expect(d.card).toBe("BR#9001");
    expect(d.merge_sha).toBe("f".repeat(40));
    expect(d.signer).toBe("detached-cody");
    expect(r.accounting.reverse_closed).toBe(0);
    expect(r.accounting.reverse_verifying).toBe(1);
  });

  it("second miss with NO provenance → a ruling duty, never a silent close", () => {
    const r = join({ prs: [], bindings: [binding(1, { missing: true, missing_set_before_report: true })] });
    expect(one(r, 1).decision.action).toBe("spawn_reverse");
    expect(r.accounting.reverse_dutied).toBe(1);
    expect(r.accounting.reverse_closed).toBe(0);
  });

  it("the reverse duty ledger suppresses re-ruling — one ruling per PR ever", () => {
    const r = join({
      prs: [],
      bindings: [binding(1, { missing: true, missing_set_before_report: true })],
      duties: [duty(1, { kind: "reverse", card_status: "in_progress" })],
    });
    // the live ruling duty already covers this PR: no new spawn, no close —
    // and no judgement at all (the ruling card is the accounting)
    expect(r.judgements.filter((j) => j.pr === 1)).toHaveLength(0);
    expect(r.accounting.reverse_missing).toBe(1);
    expect(r.accounting.reverse_dutied).toBe(0);
  });

  it("BR#5370: a queued binding whose PR left the open list is train-owned — the clock never arms, no ruling duty (occurrence #7)", () => {
    // occurrence #7: BR#5349 was blocked + queued on PR #345 (mid-train) when
    // the false-positive spawn fired; the PR merged 7.1 minutes LATER. A
    // queued binding (merge-train stamp) is the train's business —
    // queued/mid-rebase is not vanished (BR#4894 Finding A).
    const r = join({ prs: [], bindings: [binding(1, { status: "blocked", queued: true, missing: true })] });
    expect(one(r, 1).decision.action).toBe("seen"); // the clock is CLEARED, never armed
    expect(r.accounting.reverse_train_exempt).toBe(1);
    expect(r.accounting.reverse_dutied).toBe(0);
    expect(r.accounting.reverse_closed).toBe(0);
    // the accounting line shows the exemption — the canary sees the class
    expect(accountingLine(r.accounting)).toContain("1 train-owned");
  });

  it("BR#5370: a queued binding stays train-owned past the first miss — the exemption is not a one-cycle grace", () => {
    const r = join({ prs: [], bindings: [binding(1, { status: "blocked", queued: true, missing: true, missing_set_before_report: true })] });
    expect(one(r, 1).decision.action).toBe("seen");
    expect(r.accounting.reverse_train_exempt).toBe(1);
    expect(r.accounting.reverse_dutied).toBe(0);
  });

  it("BR#5370: the same PR bound twice (meta.pr + a meta.prs row) is judged ONCE in the reverse leg — no same-pass duplicate spawn", () => {
    // the deterministic same-ms pair (BR#5365/5366, the 5th instance): the
    // reverse loop iterated bindings raw, so a double-bound card emitted
    // spawn_reverse TWICE in one pass and the apply phase created both cards
    // before the ledger could dedupe. First binding wins (the same one the
    // apply path's bindings.find resolves).
    const r = join({
      prs: [],
      bindings: [
        binding(1, { missing: true, missing_set_before_report: true }),
        binding(1, { missing: true, missing_set_before_report: true }),
      ],
    });
    const spawns = r.judgements.filter((j) => j.decision.action === "spawn_reverse");
    expect(spawns).toHaveLength(1);
    expect(r.accounting.reverse_dutied).toBe(1);
  });
});

// ---------- BR#5151: standing merge-lane cards are exempt from reconcile ----------

describe("reconcileJoin — lane exemption (BR#5151)", () => {
  it("a bound lane card accounts as bound — never spawn_verify at it (forward)", () => {
    const r = join({
      prs: [pr(1)],
      bindings: [binding(1, { lane: true, status: "blocked" })],
      cfg: { verify_age_ms: 0 },
    });
    const d: any = one(r, 1).decision;
    expect(d.action).toBe("lane_exempt");
    expect(d.card).toBe("BR#9001");
    expect(r.accounting.bound).toBe(1);
    expect(r.accounting.spawned).toBe(0);
    expect(r.accounting.accounted).toBe(1);
    expect(r.accounting.ok).toBe(true);
  });

  it("lane exemption outranks the queued stamp — the train owns the card either way", () => {
    const r = join({
      prs: [pr(1)],
      bindings: [binding(1, { lane: true, status: "blocked", queued: true })],
    });
    expect(one(r, 1).decision.action).toBe("lane_exempt");
  });

  it("a lane card with a stamped provenance row and a vanished bootstrap PR is NOT reverse-closed", () => {
    // the BR#5050 incident, pinned: provenance on the lane + two misses used
    // to fire reverse_close; the lane flag must short-circuit before it.
    const r = join({
      prs: [],
      bindings: [binding(1, { lane: true, missing: true, missing_set_before_report: true, provenance: { merge_sha: "a".repeat(40), signer: "detached-cody" } })],
    });
    const d: any = one(r, 1).decision;
    expect(d.action).toBe("lane_exempt");
    expect(r.accounting.reverse_closed).toBe(0);
    expect(r.accounting.reverse_missing).toBe(0);
    expect(r.accounting.reverse_dutied).toBe(0);
    expect(r.accounting.reverse_lane_exempt).toBe(1);
  });

  it("a lane binding past the actionable age never spawns a verify/disposition duty (forward)", () => {
    const r = join({
      prs: [pr(1, { reviewDecision: "CHANGES_REQUESTED", updatedAt: iso(72) })],
      bindings: [binding(1, { lane: true })],
      cfg: { disposition_age_ms: 0, verify_age_ms: 0 },
    });
    expect(one(r, 1).decision.action).toBe("lane_exempt");
    expect(r.accounting.spawned).toBe(0);
  });

  it("a non-lane card with the same provenance + missing shape still reverse-closes (no over-exemption)", () => {
    const r = join({
      prs: [],
      bindings: [binding(1, { missing: true, missing_set_before_report: true, provenance: { merge_sha: "b".repeat(40), signer: "detached-cody" } })],
    });
    expect(one(r, 1).decision.action).toBe("reverse_verify");
    expect(r.accounting.reverse_closed).toBe(0);
    expect(r.accounting.reverse_verifying).toBe(1);
    expect(r.accounting.reverse_lane_exempt).toBe(0);
  });

  it("accountingLine renders the lane-exempt reverse tail", () => {
    const r = join({
      prs: [],
      bindings: [binding(1, { lane: true, missing: true, missing_set_before_report: true })],
    });
    expect(r.accounting.reverse_lane_exempt).toBe(1);
    expect(accountingLine(r.accounting)).toContain("1 lane-exempt");
  });
});

// ---------- BR#6384: the merged feed + the observed-merge close ----------

describe("normalizePr — BR#6384 merged-feed passthrough", () => {
  it("keeps state/mergeCommit on a MERGED row", () => {
    const n = normalizePr({ number: 7, state: "MERGED", mergeCommit: "f".repeat(40), title: "x" });
    expect(n).not.toBeNull();
    expect(n!.state).toBe("MERGED");
    expect(n!.mergeCommit).toBe("f".repeat(40));
  });

  it("a legacy open-feed row (no state field) normalizes to null/null — identical shape to before", () => {
    const n = normalizePr({ number: 8, title: "y", reviewDecision: "APPROVED" });
    expect(n).not.toBeNull();
    expect(n!.state).toBeNull();
    expect(n!.mergeCommit).toBeNull();
  });
});

describe("prRowIsOpen — BR#6384 feed partition", () => {
  it("legacy rows (null state) and OPEN rows are queue members; MERGED/CLOSED are observation receipts", () => {
    expect(prRowIsOpen({ ...pr(1), state: null })).toBe(true);
    expect(prRowIsOpen({ ...pr(1) })).toBe(true);
    expect(prRowIsOpen({ ...pr(1), state: "MERGED", mergeCommit: "a".repeat(40) })).toBe(false);
    expect(prRowIsOpen({ ...pr(1), state: "CLOSED" })).toBe(false);
    expect(prRowIsOpen({ ...pr(1), state: "open" })).toBe(true); // case-insensitive
  });
});

describe("reconcileJoin — BR#6384 observed-merge close", () => {
  it("a bound PR observed MERGED emits observed_merge_close citing the live mergeCommit", () => {
    const sha = "f".repeat(40);
    const r = reconcileJoin({
      repo: "o/r",
      prs: [{ ...pr(11, { state: "MERGED", mergeCommit: sha, headRefOid: sha }) }],
      bindings: [binding(11)],
      ignores: [],
      duties: [],
      cfg: CFG,
    });
    const j = r.judgements.find((x) => x.pr === 11);
    expect(j?.decision).toEqual({ action: "observed_merge_verify", card: "BR#90011", merge_sha: sha });
    expect(r.accounting.observed_merged).toBe(1);
  });

  it("the observation accounts the run green — the merged row is not an open PR, not unaccounted, not grace", () => {
    const sha = "f".repeat(40);
    const r = reconcileJoin({
      repo: "o/r",
      prs: [{ ...pr(11, { state: "MERGED", mergeCommit: sha }) }],
      bindings: [binding(11)],
      ignores: [],
      duties: [],
      cfg: CFG,
    });
    expect(r.accounting.ok).toBe(true);
    expect(r.accounting.unaccounted).toBe(0);
    expect(r.accounting.open_reviewed).toBe(0);
    expect(r.accounting.grace).toBe(0);
    expect(r.accounting.accounted).toBe(1);
    expect(accountingLine(r.accounting)).toContain("1 awaiting delivery verification");
  });

  it("a MERGED row with no bound card is silence — no judgement, no count", () => {
    const r = reconcileJoin({
      repo: "o/r",
      prs: [{ ...pr(12, { state: "MERGED", mergeCommit: "a".repeat(40) }) }],
      bindings: [],
      ignores: [],
      duties: [],
      cfg: CFG,
    });
    expect(r.judgements).toHaveLength(0);
    expect(r.accounting.observed_merged).toBe(0);
    expect(r.accounting.ok).toBe(true);
  });

  it("a lane binding observed MERGED is exempt (BR#5151) — never closed, never counted", () => {
    const r = reconcileJoin({
      repo: "o/r",
      prs: [{ ...pr(13, { state: "MERGED", mergeCommit: "a".repeat(40) }) }],
      bindings: [binding(13, { lane: true })],
      ignores: [],
      duties: [],
      cfg: CFG,
    });
    expect(r.judgements[0]?.decision).toEqual({ action: "lane_exempt", card: "BR#90013" });
    expect(r.accounting.observed_merged).toBe(0);
    expect(r.accounting.bound).toBe(1);
  });

  it("the reverse loop skips observation-owned bindings — no missing clock, no reverse close, no duty", () => {
    const sha = "f".repeat(40);
    const r = reconcileJoin({
      repo: "o/r",
      prs: [{ ...pr(14, { state: "MERGED", mergeCommit: sha }) }],
      bindings: [binding(14, { missing: true, missing_set_before_report: true, provenance: { merge_sha: "b".repeat(40), signer: "train" } })],
      ignores: [],
      duties: [],
      cfg: CFG,
    });
    const actions = r.judgements.map((x) => x.decision.action);
    expect(actions).toContain("observed_merge_verify");
    expect(actions).not.toContain("reverse_verify");
    expect(actions).not.toContain("mark_missing");
    expect(actions).not.toContain("spawn_reverse");
    expect(r.accounting.reverse_missing).toBe(0);
    expect(r.accounting.reverse_closed).toBe(0);
    expect(r.accounting.reverse_dutied).toBe(0);
  });

  it("a genuinely vanished binding still flows the reverse path beside an observed merge", () => {
    const r = reconcileJoin({
      repo: "o/r",
      prs: [{ ...pr(15, { state: "MERGED", mergeCommit: "c".repeat(40) }) }],
      bindings: [
        binding(15),
        binding(16, { missing: true, missing_set_before_report: false }),
      ],
      ignores: [],
      duties: [],
      cfg: CFG,
    });
    const actions = r.judgements.map((x) => x.decision.action);
    expect(actions).toContain("observed_merge_verify");
    expect(actions).toContain("mark_missing");
    expect(r.accounting.reverse_missing).toBe(1);
    expect(r.accounting.reverse_dutied).toBe(0);
  });

  it("a MERGED row with no mergeCommit is not a receipt — the binding falls to the reverse path, never the observation close", () => {
    // the true projection: a merged row is absent from the OPEN set, so the
    // DO passes missing=true — and with no citable sha the observation loop
    // must not close; the reverse guard owns the ruling
    const r = reconcileJoin({
      repo: "o/r",
      prs: [{ ...pr(17, { state: "MERGED", mergeCommit: null }) }],
      bindings: [binding(17, { missing: true })],
      ignores: [],
      duties: [],
      cfg: CFG,
    });
    expect(r.judgements.map((x) => x.decision.action)).toEqual(["mark_missing"]);
    expect(r.accounting.observed_merged).toBe(0);
  });

  it("a CLOSED row is not a merge receipt either — the binding falls to the reverse path, never the observation close", () => {
    const r = reconcileJoin({
      repo: "o/r",
      prs: [{ ...pr(18, { state: "CLOSED" }) }],
      bindings: [binding(18, { missing: true })],
      ignores: [],
      duties: [],
      cfg: CFG,
    });
    expect(r.judgements.map((x) => x.decision.action)).toEqual(["mark_missing"]);
    expect(r.accounting.observed_merged).toBe(0);
  });

  it("open-feed rows keep the legacy forward invariant beside merged rows (partition holds)", () => {
    const r = reconcileJoin({
      repo: "o/r",
      prs: [
        pr(19), // unbound, approved+mergeable, 5h old > 2h grace → spawn_verify
        { ...pr(20, { state: "MERGED", mergeCommit: "d".repeat(40) }) },
      ],
      bindings: [binding(20)],
      ignores: [],
      duties: [],
      cfg: CFG,
    });
    expect(r.accounting.spawned).toBe(1); // #19 the orphan verify spawn
    expect(r.accounting.observed_merged).toBe(1); // #20 the observation close
    expect(r.accounting.open_reviewed).toBe(1); // only #19 counts as open
  });

  it("a queued binding observed MERGED closes too — the train's settle path is not the only honest writer", () => {
    const r = reconcileJoin({
      repo: "o/r",
      prs: [{ ...pr(21, { state: "MERGED", mergeCommit: "e".repeat(40) }) }],
      bindings: [binding(21, { queued: true })],
      ignores: [],
      duties: [],
      cfg: CFG,
    });
    expect(r.judgements[0]?.decision).toEqual({ action: "observed_merge_verify", card: "BR#90021", merge_sha: "e".repeat(40) });
    expect(r.accounting.observed_merged).toBe(1);
  });
});

// ---------- BR#14364: origin-bind — the dead-runner rescue ----------

describe("BR#14364 origin-bind law", () => {
  // The specimen: PR #3191 sat OPEN+MERGEABLE with reviewDecision="" beside
  // a todo card for 4h because the runner died before its in_review
  // transition — the PR was UNBOUND, so the unreviewed grace swallowed it.
  const stranded = (number: number, over: Partial<ReconcilePr> = {}): ReconcilePr =>
    pr(number, { reviewDecision: null, title: `feat: t1 foundation (BR#${number})`, ...over });

  it("originTaskId: title marker wins, branch fallback, ambiguity binds nothing, zeros normalize", () => {
    expect(originTaskId("feat: t1 (BR#43125)", "feature/x")).toBe("BR#43125");
    expect(originTaskId("PR title without marker", "fix/br14125-chat-scope-t1-foundation")).toBe("BR#14125");
    expect(originTaskId("PR title without marker", "br/14125")).toBe("BR#14125");
    expect(originTaskId("PR title without marker", "br-14125")).toBe("BR#14125");
    expect(originTaskId("two in the title: BR#10 and BR#20", "feature/plain")).toBeNull();
    expect(originTaskId("one here BR#10", "fix/br-20-other")).toBe("BR#10"); // title is authoritative
    expect(originTaskId("PR title without marker", "feature/br-10-and-br-20")).toBeNull(); // branch ambiguity
    expect(originTaskId("zero-pad BR#0042", null)).toBe("BR#42");
    expect(originTaskId("zero BR#0 and BR#000", null)).toBeNull();
    expect(originTaskId("not a marker: brevity, libra, club", "fix/browser-upgrade")).toBeNull();
    expect(originTaskId(null, null)).toBeNull();
    expect(originTaskId("caps BR#77 stated twice BR#77", null)).toBe("BR#77"); // duplicates collapse; one DISTINCT id per source
    expect(originTaskId("case-insensitive BR#77 vs br#78", null)).toBeNull(); // still two distinct ids
  });

  it("an unbound marker PR past the verify grace emits bind_origin — never the grace swallow", () => {
    const r = join({ prs: [stranded(3191, { updatedAt: iso(4) })] });
    expect(r.judgements[0].decision).toEqual({ action: "bind_origin", card: "BR#3191" });
    expect(r.accounting.spawned).toBe(1);
    expect(r.accounting.accounted).toBe(1);
    expect(r.accounting.unreviewed).toBe(0);
    expect(r.accounting.ok).toBe(true);
  });

  it("a young marker PR keeps the grace — the rescue never fires inside the verify window", () => {
    const r = join({ prs: [stranded(3200, { updatedAt: iso(1) })] });
    expect(r.judgements[0].decision.action).toBe("grace");
    expect(r.accounting.spawned).toBe(0);
  });

  it("an ignored marker PR is never origin-bound — an explicit ruling outranks the inference", () => {
    // young + unreviewed lands in the pre-existing grace swallow (before the
    // ignored check) — either way bind_origin must not fire:
    const young = join({ prs: [stranded(3210)], ignores: [{ pr: 3210, reason: "docs-only" }] });
    expect(young.judgements[0].decision.action).not.toBe("bind_origin");
    // aged past the disposition grace reaches the ignored branch:
    const aged = join({ prs: [stranded(3210, { updatedAt: iso(50) })], ignores: [{ pr: 3210, reason: "docs-only" }] });
    expect(aged.judgements[0].decision.action).toBe("ignored");
  });

  it("drafts are never origin-bound", () => {
    const r = join({ prs: [stranded(3211, { isDraft: true })] });
    expect(r.judgements[0].decision.action).toBe("grace");
  });

  it("a conflicting/unmergeable marker PR falls through — greenish is the fence", () => {
    const young = join({ prs: [stranded(3212, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", updatedAt: iso(5) })] });
    expect(young.judgements[0].decision.action).toBe("grace");
    const aged = join({ prs: [stranded(3212, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", updatedAt: iso(50) })] });
    expect(aged.judgements[0].decision.action).toBe("spawn_disposition");
  });

  it("the bulk feed's UNKNOWN/UNKNOWN counts as greenish (needsProbe) — the verifier reads the exact head", () => {
    const r = join({ prs: [stranded(3213, { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" })] });
    expect(r.judgements[0].decision).toEqual({ action: "bind_origin", card: "BR#3213" });
    const unstable = join({ prs: [stranded(3214, { mergeStateStatus: "UNSTABLE" })] });
    expect(unstable.judgements[0].decision).toEqual({ action: "bind_origin", card: "BR#3214" });
  });

  it("a branch-only marker binds too — titled-but-unmarked runner PRs are the same class", () => {
    const r = join({ prs: [pr(14125, { reviewDecision: null, title: "feat: t1 foundation", headRefName: "fix/br14125-chat-scope-t1-foundation" })] });
    expect(r.judgements[0].decision).toEqual({ action: "bind_origin", card: "BR#14125" });
  });

  it("an ambiguous marker binds nothing — a wrong auto-bind advances the wrong card", () => {
    const r = join({ prs: [pr(3300, { reviewDecision: null, title: "Fix BR#10 and BR#20", headRefName: "feature/plain" })] });
    expect(r.judgements[0].decision.action).toBe("grace");
  });

  it("a bound PR never emits bind_origin — the binding branch owns it whatever the marker says", () => {
    const r = join({ prs: [stranded(3400)], bindings: [binding(3400)] });
    expect(r.judgements[0].decision.action).toBe("bound");
  });

  it("a dead duty on a marker PR is repaired by the bind, not alarmed", () => {
    const r = join({ prs: [stranded(3410)], duties: [duty(3410, { card_status: "done" })] });
    expect(r.judgements[0].decision.action).toBe("bind_origin");
    expect(r.accounting.ok).toBe(true);
  });
});
