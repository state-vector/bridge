import { describe, expect, it } from "vitest";
import {
  accountingLine,
  isActionableDutyCard,
  normalizePr,
  prAgeMs,
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
      repo: "r", open_reviewed: 3, bound: 1, ignored: 1, inflight: 0, spawned: 1,
      grace: 0, unaccounted: 0, unreviewed: 0, reverse_missing: 0, reverse_closed: 0,
      reverse_dutied: 0, reverse_lane_exempt: 0, accounted: 3, ok: true,
    });
    expect(line).toBe("3 open reviewed / 1 bound / 1 ignored-with-reason / 1 in-flight — 3 accounted");
  });

  it("fails loudly — the ALARM tail rides exactly when ok is false", () => {
    const a = {
      repo: "r", open_reviewed: 1, bound: 0, ignored: 0, inflight: 0, spawned: 0,
      grace: 0, unaccounted: 1, unreviewed: 0, reverse_missing: 0, reverse_closed: 0,
      reverse_dutied: 0, reverse_lane_exempt: 0, accounted: 0, ok: false,
    };
    expect(accountingLine(a)).toContain("ALARM: 1 unaccounted");
    expect(accountingLine({ ...a, unaccounted: 0, ok: true, accounted: 1, bound: 1 })).not.toContain("ALARM");
  });

  it("carries the informational grace/unreviewed and reverse tails", () => {
    const line = accountingLine({
      repo: "r", open_reviewed: 1, bound: 1, ignored: 0, inflight: 0, spawned: 0,
      grace: 2, unaccounted: 0, unreviewed: 3, reverse_missing: 1, reverse_closed: 1,
      reverse_dutied: 0, reverse_lane_exempt: 0, accounted: 1, ok: true,
    });
    expect(line).toContain("(+2 in age grace, +3 unreviewed)");
    expect(line).toContain("[reverse: 1 missing, 1 closed, 0 dutied]");
  });

  it("BR#5151: lane-exempt bindings render in the reverse tail", () => {
    const line = accountingLine({
      repo: "r", open_reviewed: 1, bound: 1, ignored: 0, inflight: 0, spawned: 0,
      grace: 0, unaccounted: 0, unreviewed: 0, reverse_missing: 0, reverse_closed: 0,
      reverse_dutied: 0, reverse_lane_exempt: 2, accounted: 1, ok: true,
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
    expect(d.action).toBe("reverse_close");
    expect(d.card).toBe("BR#9001");
    expect(d.merge_sha).toBe("f".repeat(40));
    expect(d.signer).toBe("detached-cody");
    expect(r.accounting.reverse_closed).toBe(1);
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
    expect(one(r, 1).decision.action).toBe("reverse_close");
    expect(r.accounting.reverse_closed).toBe(1);
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
