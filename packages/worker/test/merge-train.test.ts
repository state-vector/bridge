import { describe, expect, it } from "vitest";
import {
  DEFAULT_BURST_MAX,
  conflictsFromFileSets,
  drainBurstDecision,
  firstRedIndex,
  laneCardBody,
  laneOfMeta,
  parseBurstMax,
  // BR#5385 mid-walk merged receipt
  leaseLossHolder,
  midWalkReceiptDecide,
  type LeaseLossTransition,
  carryAppend,
  carryAppendLeg,
  classifyRequiredRuns,
  classifyHeadChecks,
  classifyCandidateGatePhase,
  classifyBaseRedEpisodeState,
  isBaseCureCardTitle,
  isRootFixCard,
  isLaneBaseFixCard,
  mainRedBinding,
  trainBaseRedAskBrief,
  trainBaseRedAskWarranted,
  decideMergeAction,
  decideTrainGate,
  leaseDecide,
  mergeTrainQueue,
  normalizeGhMergeable,
  normalizeGhMergeState,
  progressVerdict,
  renewProgressDecide,
  selectBatch,
  partitionMergeBatches,
  isValidGitHubRepo,
  parseDirectCommitReceipt,
  trainBounceBrief,
  resolveTrainBounceKind,
  trainCardMatchesLane,
  trainCloseBounceBrief,
  trainCloseFailAskDetails,
  trainCloseFailAskTitle,
  trainLandedCloseEdge,
  trainLandedCloseNote,
  trainLegLanded,
  trainLegs,
  trainLegsRemaining,
  trainParseNoteLegs,
  trainStampRefresh,
  trainQueueRemainingReason,
  trainStopAskTitle,
  trainStarvationAskTitle,
  trainStarvationAskDetails,
  trainStarvationDutyTitle,
  trainStarvationDutyBody,
  TRAIN_MERGE_STARVE_MS,
  classifyBaseCheckRuns,
  trainAwaitingReason,
  trainAwaitingHumanLeg,
  trainRequeueSwap,
  TRAIN_AWAITING_REASON_PREFIX,
  TRAIN_AWAITING_TTL_H_DEFAULT,
  TRAIN_AWAITING_GRACE_MS,
  clampAwaitingTtlHours,
  verdictCoversHead,
  verdictCoversHeadLeg,
  TRAIN_CI_BOUND_MULTIPLIER,
  TRAIN_CI_TYPICAL_MINUTES,
  TRAIN_HEAD_STAMP_RE,
  TRAIN_LEASE_TTL_MS,
  TRAIN_PROGRESS_STALE_MS,
  DEPLOY_RECONCILE_GRACE_SECS,
  formatDeployCoverageSummary,
  inferDeployWorkflow,
  isDeployWorkflowRun,
  parseIso8601EpochMs,
  reconcileDeployCoverage,
  trainDarkTipAskBrief,
  trainDarkTipAskTitle,
  type DeployWorkflowRun,
  type MainCheckRun,
  type TrainLease,
} from "../src/kb/core.ts";

/**
 * The serialized merge train's pure decision layer (decision BR#3516, impl
 * BR#3517) — the ONE gate implementation the executor imports from core.ts
 * and the hub (kb/do.ts) enforces. The DO-level drills live in
 * test/train-hub.test.ts; this file pins the decision rules case by case:
 * the lease CAS (crash-reconciling), the derived queue (computed, critical
 * first, FIFO), the carry law (machine-clean carries; human-resolved
 * invalidates), the awaiting-CI classifier (fail-closed bound), and the
 * admission gate (each leg fail-closed).
 */

const MIN = 60_000;

// ---------- the lease CAS ----------

describe("leaseDecide (the CAS check — read-check-write is atomic in the DO)", () => {
  const at = (t: number) => new Date(t).toISOString();
  const lease = (holder: string, hb: number, exp: number): TrainLease => ({ holder, heartbeat_ts: hb, expires_ts: exp });

  it("acquire on a free lane grants a full-TTL lease", () => {
    const d = leaseDecide(null, 1000, "gw-1", "acquire");
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.lease).toEqual({ holder: "gw-1", heartbeat_ts: 1000, expires_ts: 1000 + TRAIN_LEASE_TTL_MS });
      expect(d.note).toContain("lane was free");
    }
    expect(TRAIN_LEASE_TTL_MS).toBe(5 * MIN);
  });

  it("acquire on a LAPSED lease reconciles over the dead holder — a crash never poisons the lane", () => {
    const d = leaseDecide(lease("gw-dead", 0, 500), 600, "gw-2", "acquire");
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.lease?.holder).toBe("gw-2");
      expect(d.note).toContain("gw-dead lapsed");
      expect(d.note).toContain("reconciling from live GitHub state");
    }
  });

  it("acquire on a LIVE lease held by another gateway REJECTS (stand down this tick)", () => {
    const d = leaseDecide(lease("gw-1", 0, 60_000), 1000, "gw-2", "acquire");
    expect(d.ok).toBe(false);
    if (d.ok === false) {
      expect(d.reason).toContain("held live by gw-1");
      expect(d.reason).toContain("stand down this tick");
    }
  });

  it("acquire by the holder itself re-grants (live or lapsed)", () => {
    const live = leaseDecide(lease("gw-1", 0, 60_000), 1000, "gw-1", "acquire");
    expect(live.ok).toBe(true);
    const lapsed = leaseDecide(lease("gw-1", 0, 500), 1000, "gw-1", "acquire");
    expect(lapsed.ok).toBe(true);
  });

  it("renew: only the holder's lease renews; none or foreign is denied", () => {
    expect(leaseDecide(null, 1000, "gw-1", "renew").ok).toBe(false);
    const foreign = leaseDecide(lease("gw-2", 0, 60_000), 1000, "gw-1", "renew");
    expect(foreign.ok).toBe(false);
    const mine = leaseDecide(lease("gw-1", 0, 60_000), 1000, "gw-1", "renew");
    expect(mine.ok).toBe(true);
    if (mine.ok) expect(mine.lease?.expires_ts).toBe(1000 + TRAIN_LEASE_TTL_MS);
  });

  it("release: only the holder clears; a stale executor cannot kick a live one; clearing a clear lane is a no-op", () => {
    const none = leaseDecide(null, 1000, "gw-1", "release");
    expect(none.ok).toBe(true);
    const foreign = leaseDecide(lease("gw-2", 0, 60_000), 1000, "gw-1", "release");
    expect(foreign.ok).toBe(false);
    const mine = leaseDecide(lease("gw-1", 0, 60_000), 1000, "gw-1", "release");
    expect(mine.ok).toBe(true);
    if (mine.ok) expect(mine.lease).toBeNull();
  });

  it("the TTL boundary is strict: expires_ts == now is already lapsed (fail-closed)", () => {
    expect(leaseDecide(lease("gw-1", 0, 1000), 1000, "gw-2", "acquire").ok).toBe(true);
    expect(leaseDecide(lease("gw-1", 0, 1001), 1000, "gw-2", "acquire").ok).toBe(false);
    expect(at(1000)).toContain("1970");
  });
});

// ---------- the mid-walk merged receipt (BR#5385) ----------

describe("midWalkReceiptDecide (a lease lost mid-walk does not destroy a real landing's receipt)", () => {
  const NOW = 1_000_000_000;
  const loss = (action: string, ageMs: number, holder: string | null = "gw-1", actor = "gw-1"): LeaseLossTransition =>
    ({ ts: NOW - ageMs, action, actor, holder });

  it("accepts: the holder itself released mid-walk (the incident shape — a same-actor peer release)", () => {
    expect(midWalkReceiptDecide(loss("train:lease_release", 2_000), "gw-1", NOW)).toEqual({ ok: true });
  });
  it("accepts: the watch sweep lapsed the holder's lease mid-walk (holder rides the sweep stamp)", () => {
    expect(midWalkReceiptDecide(loss("lease_lapsed", 30_000, "gw-1"), "gw-1", NOW)).toEqual({ ok: true });
  });
  it("accepts: the zombie eviction removed the holder mid-walk (holder rides the zombie stamp)", () => {
    expect(midWalkReceiptDecide(loss("train:lease_evicted", 60_000, "gw-1"), "gw-1", NOW)).toEqual({ ok: true });
  });
  it("refuses: an actor that never held the lease cannot report a mid-walk merge", () => {
    const d = midWalkReceiptDecide(loss("train:lease_release", 2_000), "gw-rogue", NOW);
    expect(d.ok).toBe(false);
    if (d.ok === false) expect(d.reason).toContain("held by gw-1");
  });
  it("refuses: the loss is older than the lease TTL — history, not mid-walk", () => {
    const d = midWalkReceiptDecide(loss("train:lease_release", TRAIN_LEASE_TTL_MS + 1), "gw-1", NOW);
    expect(d.ok).toBe(false);
    if (d.ok === false) expect(d.reason).toContain("past the lease TTL");
  });
  it("refuses: no lease-loss record at all (a fresh lane — the original gate error stands)", () => {
    expect(midWalkReceiptDecide(null, "gw-1", NOW).ok).toBe(false);
    expect(midWalkReceiptDecide(undefined, "gw-1", NOW).ok).toBe(false);
  });
  it("leaseLossHolder: release rows resolve from the actor; lapsed/evicted rows from the payload; anything else resolves nothing", () => {
    expect(leaseLossHolder({ ts: 0, action: "train:lease_release", actor: "gw-1", holder: null })).toBe("gw-1");
    expect(leaseLossHolder({ ts: 0, action: "lease_lapsed", actor: "system:merge-train", holder: "gw-2" })).toBe("gw-2");
    expect(leaseLossHolder({ ts: 0, action: "train:lease_evicted", actor: "gw-3", holder: "gw-2" })).toBe("gw-2");
    expect(leaseLossHolder({ ts: 0, action: "lease_lapsed", actor: "system:merge-train", holder: null })).toBeNull();
    expect(leaseLossHolder({ ts: 0, action: "train:lease_acquire", actor: "gw-1", holder: null })).toBeNull();
  });
  it("the TTL boundary is exact: lost at TTL-1ms admits; at TTL+1ms refuses", () => {
    expect(midWalkReceiptDecide(loss("train:lease_release", TRAIN_LEASE_TTL_MS - 1), "gw-1", NOW).ok).toBe(true);
    expect(midWalkReceiptDecide(loss("train:lease_release", TRAIN_LEASE_TTL_MS), "gw-1", NOW).ok).toBe(true);
    expect(midWalkReceiptDecide(loss("train:lease_release", TRAIN_LEASE_TTL_MS + 1), "gw-1", NOW).ok).toBe(false);
  });
});

// ---------- the renew-arm zombie check (proof-of-progress, BR#4129) ----------

describe("renewProgressDecide (the hub half of proof-of-progress — deny renewal on a frozen note)", () => {
  const proof = (note: string, age_ms: number, holder = "gw-1") => ({ progress: note, progress_age_ms: age_ms, holder });

  it("STALE proof on a non-empty queue denies the renewal — the reason names holder, minutes, and queue depth", () => {
    const d = renewProgressDecide(proof("merged PR #263", 3 * 60 * 60_000), "gw-1", 4);
    expect(d.ok).toBe(false);
    if (d.ok === false) {
      expect(d.reason).toContain("zombie holder");
      expect(d.reason).toContain("no progress for 180m");
      expect(d.reason).toContain("non-empty queue (4 queued)");
      expect(d.stale_ms).toBe(3 * 60 * 60_000);
    }
  });

  it("STALE proof on an EMPTY queue allows the renewal — idle holding is harmless and correct", () => {
    const d = renewProgressDecide(proof("merged PR #263", 3 * 60 * 60_000), "gw-1", 0);
    expect(d.ok).toBe(true);
  });

  it("FRESH proof on a non-empty queue allows the renewal — an awaiting-CI holder's note refreshes every tick, it never trips", () => {
    const d = renewProgressDecide(proof("CI poll on abc123def: pending", 45_000), "gw-1", 2);
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.verdict).toBe("fresh");
  });

  it("the staleness boundary is strict: age == bound is fresh, one ms more is stale (mirrors the TTL law)", () => {
    expect(TRAIN_PROGRESS_STALE_MS).toBe(10 * MIN);
    expect(renewProgressDecide(proof("CI poll on abc123def: pending", TRAIN_PROGRESS_STALE_MS), "gw-1", 2).ok).toBe(true);
    expect(renewProgressDecide(proof("CI poll on abc123def: pending", TRAIN_PROGRESS_STALE_MS + 1), "gw-1", 2).ok).toBe(false);
  });

  it("missing or garbled proof is UNKNOWN — allowed (legacy `{}` renewals ride the deprecation window), never guessed stale", () => {
    for (const p of [undefined, null, {}, { progress: "x" }, { progress_age_ms: 5000 }, { progress: "", progress_age_ms: -1 }, { progress: 42, progress_age_ms: 1e15 }]) {
      const d = renewProgressDecide(p as any, "gw-1", 3);
      expect(d.ok).toBe(true);
      if (d.ok) expect(d.verdict).toBe("unknown");
    }
    expect(progressVerdict(null, "gw-1")).toBe("unknown");
  });

  it("a proof naming a DIFFERENT holder proves nothing about the renewer — UNKNOWN, allowed", () => {
    expect(progressVerdict(proof("merged PR #263", 3 * 60 * 60_000, "gw-9"), "gw-1")).toBe("unknown");
    expect(renewProgressDecide(proof("merged PR #263", 3 * 60 * 60_000, "gw-9"), "gw-1", 3).ok).toBe(true);
  });

  it("takeover after denial: the expired lease hands the lane to the next gateway's acquire (train handover law)", () => {
    const denied = renewProgressDecide(proof("merged PR #263", 3 * 60 * 60_000), "gw-1", 4);
    expect(denied.ok).toBe(false);
    // the DO cleared the lease on denial — the next acquire on a free lane wins
    const takeover = leaseDecide(null, 1000, "gw-2", "acquire");
    expect(takeover.ok).toBe(true);
    if (takeover.ok) expect(takeover.lease?.holder).toBe("gw-2");
  });
});

// ---------- the derived queue ----------

describe("mergeTrainQueue (computed from the board — never a stored list)", () => {
  const card = (id: string, ts: number, reason: string | null, boosted?: boolean) => ({
    id, status_ts: ts, meta: { blocked: reason == null ? undefined : { reason }, ...(boosted ? { boosted: true } : {}) },
  });

  it("only `merge-train:`-blocked cards queue — every other blocked reason is invisible to the train", () => {
    const q = mergeTrainQueue([
      card("A", 1, "merge-train: queued"),
      card("B", 2, "needs review"),
      card("C", 3, null),
      card("D", 4, "verify expired — re-run"),
    ]);
    expect(q.map((x) => x.id)).toEqual(["A"]);
    expect(q[0].priority).toBe("normal");
  });

  it("the legacy blocked_reason field feeds the derive too (both stamps count)", () => {
    const q = mergeTrainQueue([{ id: "A", status_ts: 1, meta: { blocked_reason: "merge-train: queued" } }]);
    expect(q.map((x) => x.id)).toEqual(["A"]);
  });

  // BR#5750 — a watchdog silence-release hold-park of a QUEUED car must keep
  // its queue slot even when the park note predates the merge-train: prefix
  // (the BR#4995 silent drop). awaiting is NOT a queue slot — it re-enters
  // through the board.
  it("BR#5750: a legacy unprefixed watchdog hold-park of a queued car still queues; awaiting parks never do", () => {
    const legacy = {
      id: "H1",
      status_ts: 7,
      meta: {
        merge_train: { state: "queued", pr: 259, repo: "state-vector/bridge" },
        blocked: { reason: "silence-release held (watchdog): no update for >10m, but the card carries merge-train queued on PR state-vector/bridge#259 — parked on the typed proxy, not released (BR#4067)" },
      },
    };
    const awaiting = {
      ...legacy,
      id: "H2",
      status_ts: 8,
      meta: { ...legacy.meta, merge_train: { state: "awaiting", pr: 259, repo: "state-vector/bridge" } },
    };
    const q = mergeTrainQueue([card("B", 2, "needs review"), legacy, awaiting]);
    expect(q.map((x) => x.id)).toEqual(["H1"]);
    expect(q[0].priority).toBe("normal");
  });

  it("BOOSTED (meta.boosted) first among mortals, FIFO within class by blocked-since (BR#5190 renamed the old CRITICAL label)", () => {
    const q = mergeTrainQueue([
      card("N1", 10, "merge-train: queued"),
      card("C2", 30, "merge-train: queued", true),
      card("N2", 20, "merge-train: queued"),
      card("C1", 40, "merge-train: queued", true),
    ]);
    expect(q.map((x) => x.id)).toEqual(["C2", "C1", "N1", "N2"]);
    expect(q[0].priority).toBe("boosted");
    expect(q[2].priority).toBe("normal");
  });

  // ---- BR#5190: the root-fix fast lane — absolute p0 above every boost ----
  const rootFix = (id: string, ts: number, sha?: string) => ({
    id,
    status_ts: ts,
    meta: {
      blocked: { reason: "merge-train: queued" },
      root_fix: { repo: "o/r", head_sha: sha ?? "a".repeat(40), failing: ["Deploy Dev"], bound_at: ts },
    },
    tags: ["root_blocker", "main-red", "p0"],
  });

  it("ROOT-FIX tier 0: the bound main-breakage fix jumps boosts and normals — absolute p0 (BR#5189 §2)", () => {
    const q = mergeTrainQueue([
      card("N1", 10, "merge-train: queued"),
      card("B1", 5, "merge-train: queued", true),
      rootFix("R1", 50),
    ]);
    expect(q.map((x) => x.id)).toEqual(["R1", "B1", "N1"]);
    expect(q[0].priority).toBe("root_fix");
    expect(q[0].root_fix).toBe(true);
    expect(q[1].priority).toBe("boosted");
  });

  it("qualification is tags AND binding — a tagged-but-unbound or bound-but-untagged card never reaches tier 0", () => {
    const taggedOnly = { ...rootFix("R1", 10), meta: { blocked: { reason: "merge-train: queued" } } }; // binding stripped
    const boundOnly = card("B9", 20, "merge-train: queued");
    (boundOnly.meta as any).root_fix = { repo: "o/r", head_sha: "a".repeat(40) }; // tags missing
    const q = mergeTrainQueue([taggedOnly, boundOnly]);
    expect(q.map((x) => x.id)).toEqual(["R1", "B9"]);
    expect(q.every((x) => x.priority !== "root_fix")).toBe(true);
  });

  // ---- BR#5753: the hub queue NEVER hides held cars ----
  // The pre-5753 baseRed option (a STOPPED lane offering only tier 0) was
  // dead in production — its one caller looked the lane's stop facts up with
  // `WHERE id = laneKey(repo, base)`, and a lane key is never an
  // artefacts.id — and it must stay gone: base_red_resolution.held, the
  // alarm ask's cure-PR fallback and trainOpenRootFix all read the derived
  // queue and would go blind mid-episode if non-root_fix cars were filtered
  // out. The stop fast-lane is the WALK's law (train.rs gate), not a
  // hub-side queue filter.

  it("BR#5753: no baseRed filter — a stopped lane's queue keeps EVERY held car visible, root_fix still at rank 0", () => {
    const q = mergeTrainQueue([card("N1", 10, "merge-train: queued"), card("B1", 5, "merge-train: queued", true), rootFix("R1", 50)]);
    expect(q.map((x) => x.id)).toEqual(["R1", "B1", "N1"]);
    expect(q[0].priority).toBe("root_fix");
  });

  it("BR#5753: with NO root-fix card the queue still lists the held cars (root_fix absent, tiers intact)", () => {
    expect(mergeTrainQueue([card("B1", 5, "merge-train: queued", true), card("N1", 10, "merge-train: queued")]).map((x) => x.id)).toEqual(["B1", "N1"]);
  });

  it("empty input → empty queue (vacuity)", () => {
    expect(mergeTrainQueue([])).toEqual([]);
  });
});

// ---------- the carry law ----------

describe("verdictCoversHead (machine-clean carries; human-resolved invalidates)", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const C = "c".repeat(40);
  const A9 = A.slice(0, 9);

  it("the straight stamp covers its own head — 9-hex stamp covers the full 40 it prefixes (never the reverse)", () => {
    expect(verdictCoversHead({ pr: { head_sha_at_acceptance: A9 } }, A)).toBe(true);
    expect(verdictCoversHead({ pr: { head_sha_at_acceptance: A } }, A)).toBe(true);
    expect(verdictCoversHead({ pr: { head_sha_at_acceptance: A } }, A9)).toBe(true);
    expect(verdictCoversHead({ pr: { head_sha_at_acceptance: B } }, A)).toBe(false);
  });

  it("matching is case-insensitive and rejects malformed stamps", () => {
    expect(verdictCoversHead({ pr: { head_sha_at_acceptance: A.toUpperCase() } }, A)).toBe(true);
    expect(verdictCoversHead({ pr: { head_sha_at_acceptance: "abc12" } }, "abc123")).toBe(false);
    expect(verdictCoversHead({ pr: { head_sha_at_acceptance: "zzzzzzz" } }, "a".repeat(40))).toBe(false);
    expect(verdictCoversHead({}, A)).toBe(false);
    expect(verdictCoversHead(null, A)).toBe(false);
  });

  it("a CONTIGUOUS carry chain covers the chain's head; an intermediate query past its leg is uncovered (fail-closed)", () => {
    const meta = carryAppend(
      { pr: { head_sha_at_acceptance: A } },
      { from_head: A, to_head: B, prior_verdict_id: "BR#1", carried_ts: 1, via: "update-branch" },
    );
    expect(verdictCoversHead(meta, B)).toBe(true);
    const meta2 = carryAppend(meta, { from_head: B, to_head: C, prior_verdict_id: "BR#1", carried_ts: 2, via: "update-branch" });
    expect(verdictCoversHead(meta2, C)).toBe(true);
    // the chain's head moved on to C — the walk never stops mid-chain
    expect(verdictCoversHead(meta2, B)).toBe(false);
  });

  it("any break in the chain is uncovered — fail-closed, re-verify at the new head", () => {
    const meta = carryAppend(
      { pr: { head_sha_at_acceptance: A } },
      { from_head: A, to_head: B, prior_verdict_id: null, carried_ts: 1, via: "update-branch" },
    );
    // head moved past the carry chain without a record
    expect(verdictCoversHead(meta, C)).toBe(false);
    // a carry record that doesn't start where the chain sits breaks it
    const broken = carryAppend(meta, { from_head: "e".repeat(40), to_head: C, prior_verdict_id: null, carried_ts: 2, via: "update-branch" });
    expect(verdictCoversHead(broken, C)).toBe(false);
    // a malformed to_head breaks the chain
    const bad = carryAppend({ pr: { head_sha_at_acceptance: A } }, { from_head: A, to_head: "nothex!!", prior_verdict_id: null, carried_ts: 1, via: "update-branch" });
    expect(verdictCoversHead(bad, "nothex!!")).toBe(false);
  });

  it("carryAppend is pure — the caller's meta is never mutated", () => {
    const original: any = { pr: { head_sha_at_acceptance: A }, other: 1 };
    const next = carryAppend(original, { from_head: A, to_head: B, prior_verdict_id: null, carried_ts: 1, via: "update-branch" });
    expect(original.pr.carry).toBeUndefined();
    expect(next.other).toBe(1);
    expect(next.pr.carry).toHaveLength(1);
  });
});

// ---------- the awaiting-CI classifier ----------

describe("classifyRequiredRuns (executor-fed runs vs lane config)", () => {
  const run = (id: number, name: string, conclusion: string | null): MainCheckRun =>
    ({ id, name, status: conclusion == null ? "in_progress" : "completed", conclusion, html_url: `https://example/${id}` });
  const base = { merged_at: 0, now: 10 * MIN };

  it("all required settled green → green; skipped/neutral count as settled", () => {
    const v = classifyRequiredRuns([run(1, "Test", "success"), run(2, "Deploy", "skipped")], ["Test", "Deploy"], base);
    expect(v.verdict).toBe("green");
    expect(v.failing).toEqual([]);
    const neutral = classifyRequiredRuns([run(1, "Test", "neutral")], ["Test"], base);
    expect(neutral.verdict).toBe("green");
  });

  it("a required run settled red → red, naming the workflow with its run URL", () => {
    const v = classifyRequiredRuns([run(1, "Test", "failure"), run(2, "Deploy", "success")], ["Test", "Deploy"], base);
    expect(v.verdict).toBe("red");
    expect(v.failing).toEqual([{ name: "Test", conclusion: "failure", url: "https://example/1" }]);
  });

  it("the NEWEST run per name judges; cancelled says nothing (the sweep's judge rule)", () => {
    const newer = classifyRequiredRuns([run(1, "Test", "failure"), run(9, "Test", "success")], ["Test"], base);
    expect(newer.verdict).toBe("green");
    const cancelled = classifyRequiredRuns([run(1, "Test", "failure"), run(9, "Test", "cancelled")], ["Test"], base);
    expect(cancelled.verdict).toBe("red");
  });

  it("in-flight and unknown conclusions are pending; never-seen workflows are missing", () => {
    const v = classifyRequiredRuns([run(1, "Test", null), run(2, "Weird", "weird_future")], ["Test", "Weird", "Ghost"], base);
    expect(v.verdict).toBe("pending");
    expect(v.pending).toEqual(expect.arrayContaining(["Test", "Weird"]));
    expect(v.missing).toEqual(["Ghost"]);
  });

  it("names must match exactly — a matrix-suffixed run does not satisfy the bare required name", () => {
    const v = classifyRequiredRuns([run(1, "Test (packages/worker)", "success")], ["Test"], base);
    expect(v.verdict).toBe("pending");
    expect(v.missing).toEqual(["Test"]);
  });

  it("red wins over pending and missing (a failure stops the line regardless of noise)", () => {
    const v = classifyRequiredRuns([run(1, "Test", "failure")], ["Test", "Ghost"], base);
    expect(v.verdict).toBe("red");
    expect(v.missing).toEqual(["Ghost"]);
  });

  it("BACK-PRESSURE (Ray 2026-10-29): an unconfigured lane settles on EVERY check on the merge commit — no more vacuous pass-through", () => {
    // all observed checks settled green past the settle dwell → landed
    const settled = classifyRequiredRuns(
      [run(1, "Test", "success"), run(2, "Deploy Dev", "success")], [],
      { merged_at: 0, now: 10 * MIN },
    );
    expect(settled.verdict).toBe("green");
    // the deploy still running → the lane HOLDS (the old code merged here)
    const deployRunning = classifyRequiredRuns(
      [run(1, "Test", "success"), run(2, "Deploy Dev", null)], [],
      { merged_at: 0, now: 10 * MIN },
    );
    expect(deployRunning.verdict).toBe("pending");
    expect(deployRunning.pending).toEqual(["Deploy Dev"]);
    // deploy red → stop-the-line like any required failure
    const deployRed = classifyRequiredRuns(
      [run(1, "Test", "success"), run(2, "Deploy Dev", "failure")], [],
      { merged_at: 0, now: 10 * MIN },
    );
    expect(deployRed.verdict).toBe("red");
    expect(deployRed.failing).toEqual([{ name: "Deploy Dev", conclusion: "failure", url: "https://example/2" }]);
    // a cancelled-only deploy (the cascade this fix kills) is UNSETTLED, not success
    const cancelledOnly = classifyRequiredRuns(
      [run(1, "Test", "success"), run(2, "Deploy Dev", "cancelled")], [],
      { merged_at: 0, now: 10 * MIN },
    );
    expect(cancelledOnly.verdict).toBe("pending");
    // settle dwell: green may not land before slower-triggered workflows
    // (deploys) have even registered a check run on the commit
    const tooSoon = classifyRequiredRuns([run(1, "Test", "success")], [], { merged_at: 0, now: 1 * MIN });
    expect(tooSoon.verdict).toBe("pending");
    expect(tooSoon.pending).toContain("settle-dwell");
    const dwellPassed = classifyRequiredRuns([run(1, "Test", "success")], [], { merged_at: 0, now: 3 * MIN });
    expect(dwellPassed.verdict).toBe("green");
  });

  it("the fail-closed bound: unknown past ~3× typical ⇒ bound_exceeded (the caller stops the line)", () => {
    expect(TRAIN_CI_BOUND_MULTIPLIER).toBe(3);
    expect(TRAIN_CI_TYPICAL_MINUTES).toBe(20);
    const pending = classifyRequiredRuns([run(1, "Test", null)], ["Test"], { merged_at: 0, now: 70 * MIN });
    expect(pending.verdict).toBe("pending");
    expect(pending.bound_exceeded).toBe(true);
    const fresh = classifyRequiredRuns([run(1, "Test", null)], ["Test"], { merged_at: 0, now: 10 * MIN });
    expect(fresh.bound_exceeded).toBe(false);
    const typical = classifyRequiredRuns([run(1, "Test", null)], ["Test"], { merged_at: 0, now: 10 * MIN, typical_ms: 2 * MIN });
    expect(typical.bound_exceeded).toBe(true); // 10 min > 3 × 2 min
  });
});

// ---------- the admission gate ----------

describe("decideTrainGate (executor-side, fail-closed — ONE impl with the hub)", () => {
  const HEAD = "a".repeat(40);
  const green = (id: number, name: string): MainCheckRun => ({ id, name, status: "completed", conclusion: "success", html_url: `https://example/${id}` });
  const clean = (over: Partial<Parameters<typeof decideTrainGate>[0]> = {}): Parameters<typeof decideTrainGate>[0] => ({
    prNumber: 42,
    headSha: HEAD,
    cardMeta: { pr: { head_sha_at_acceptance: HEAD.slice(0, 9) } },
    cardStatus: "blocked",
    baseVerdict: "green",
    mergeable: true,
    mergeStateStatus: "clean",
    commits: [{ sha: HEAD, verified: true }],
    headChecks: [green(1, "Test")],
    ...over,
  });

  it("a superseded card closes its PR without review (the work is gone)", () => {
    const d = decideTrainGate(clean({ cardStatus: "superseded" }));
    expect(d.kind).toBe("close_superseded");
  });

  it("a done card is skipped — nothing to merge under it", () => {
    expect(decideTrainGate(clean({ cardStatus: "done" })).kind).toBe("skip");
  });

  it("a head past the verdict (no stamp, no carry) bounces with the defect — machine-clean carries, human-resolved invalidates", () => {
    const moved = decideTrainGate(clean({ headSha: "d".repeat(40) }));
    expect(moved.kind).toBe("bounce");
    if (moved.kind === "bounce") {
      expect(moved.defect).toContain("not covered by the accepted verdict");
      expect(moved.defect).toContain("stamped aaaaaaaaa");
      expect(moved.defect).toContain("re-verify at the new head");
      // BR#4066: the bounce names its KIND — coverage (the hub's brief then
      // renders the verify-pool copy, never "conflicts with its base")
      expect(moved.bounceKind).toBe("coverage");
    }
    // no stamp at all — the honest "(no stamp)" form
    const never = decideTrainGate(clean({ headSha: "d".repeat(40), cardMeta: {} }));
    expect(never.kind).toBe("bounce");
    if (never.kind === "bounce") {
      expect(never.defect).toContain("(no stamp)");
      expect(never.bounceKind).toBe("coverage");
    }
  });

  it("a covered head on a clean, green, fully-verified PR merges — the receipt cites the train and the head", () => {
    const d = decideTrainGate(clean());
    expect(d.kind).toBe("merge");
    if (d.kind === "merge") {
      expect(d.receipt).toContain("serialized merge train (BR#3516)");
      expect(d.receipt).toContain(HEAD.slice(0, 9));
      expect(d.receipt).toContain("base green");
      expect(d.receipt).toContain("1 verified commits");
    }
  });

  it("the standing gate's fail-closed legs still hold underneath (base red stops the train)", () => {
    const d = decideTrainGate(clean({ baseVerdict: "red" }));
    expect(d.kind).not.toBe("merge");
  });

  it("STALE DEPLOY-HEALTH SELF-HEAL (2026-11-02): head red entirely the deploy-health class on a GREEN base → rerun_gate (re-run the failed gate jobs), never bounce, never a human leg — even BLOCKED (the failed required check's own state)", () => {
    const fail = (id: number, name: string): MainCheckRun => ({ id, name, status: "completed", conclusion: "failure", html_url: `https://example/${id}` });
    const d = decideTrainGate(clean({
      mergeStateStatus: "blocked",
      headChecks: [fail(1, "Deploy health (merge gate)"), green(2, "Test")],
    }));
    expect(d.kind).toBe("rerun_gate");
    if (d.kind === "rerun_gate") {
      expect(d.reason).toContain("deploy-health");
      expect(d.reason).toContain("Deploy health (merge gate)");
      expect(d.reason).toContain("GREEN");
      expect(d.reason).toContain("stale");
    }
  });

  it("STALE MAIN-GREEN-GATE SELF-HEAL (BR#5883): head red entirely the main-green gate class while the tip judges fully green under the gate's own predicate (baseGateGreen) → rerun_gate — the 2026-11-03 pinned-head-car shape; an HONEST gate conviction (baseGateGreen false — a real tip red) is NOT healed", () => {
    const fail = (id: number, name: string): MainCheckRun => ({ id, name, status: "completed", conclusion: "failure", html_url: `https://example/${id}` });
    // stale conviction: the gate judged a transiently-unsettled tip that has
    // since settled — re-run it
    const healed = decideTrainGate(clean({
      mergeStateStatus: "blocked",
      headChecks: [fail(1, "main-green gate"), green(2, "Test")],
      baseGateGreen: true,
    }));
    expect(healed.kind).toBe("rerun_gate");
    if (healed.kind === "rerun_gate") {
      expect(healed.reason).toContain("main-green gate class");
      expect(healed.reason).toContain("BR#5883");
      expect(healed.reason).toContain("stale conviction");
    }
    // honest conviction: a real tip red exists — re-running would just
    // re-convict; the standing rows own the entry (blocked+red → note)
    const honest = decideTrainGate(clean({
      mergeStateStatus: "blocked",
      headChecks: [fail(1, "main-green gate"), green(2, "Test")],
      baseGateGreen: false,
    }));
    expect(honest.kind).not.toBe("rerun_gate");
  });

  it("SELF-HEAL control: a REAL red beside the gate red is not healed — the standing law owns the defect the PR carries", () => {
    const fail = (id: number, name: string): MainCheckRun => ({ id, name, status: "completed", conclusion: "failure", html_url: `https://example/${id}` });
    const d = decideTrainGate(clean({
      mergeStateStatus: "blocked",
      headChecks: [fail(1, "Deploy health (merge gate)"), fail(2, "Rust Tests")],
    }));
    expect(d.kind).not.toBe("rerun_gate");
    // queued card → the standing note row
    expect(d.kind).toBe("note");
  });

  it("SELF-HEAL control: a red base keeps the circular law — no premise has evaporated", () => {
    const fail = (id: number, name: string): MainCheckRun => ({ id, name, status: "completed", conclusion: "failure", html_url: `https://example/${id}` });
    const d = decideTrainGate(clean({
      baseVerdict: "red",
      headChecks: [fail(1, "Deploy health (merge gate)")],
    }));
    expect(d.kind).not.toBe("rerun_gate");
  });

  it("BR#4685: UNKNOWN × N polls → no bounce event — the compose waits on an unanswered state", () => {
    // the acceptance pin: poll the gate N times over UNKNOWN/null states and
    // no bounce ever fires; the mergeable field riding the same recomputation
    // changes nothing (a false read beside an unanswered state is a stale read)
    for (let poll = 1; poll <= 6; poll++) {
      const d = decideTrainGate(clean({
        mergeable: poll % 2 ? true : false,
        mergeStateStatus: poll % 3 ? "unknown" : null,
      }));
      expect(d.kind).toBe("skip");
      if (d.kind === "skip") expect(d.reason).toContain("BR#4685");
    }
  });

  it("BR#4685 ledger replay: the 2026-10-28 null-state rows (PRs #279/#281) yield zero bounces against this gate", () => {
    // rows lifted from train_events (state-vector/bridge, seq 136-162,
    // 2026-10-28): bounced 28× with merge_state_status:null — every
    // "CONFLICTING" row trial-merged CLEAN (stale reads mid-recomputation)
    const sha279 = "1bb7e4670e2a21420528ee9d1b154658afb69d02";
    const sha281 = "9391ea4a9822c01dc40cd021dac25b3d8877c0e2";
    const row = (pr: number, headSha: string, mergeable: boolean | null) =>
      clean({ prNumber: pr, headSha, cardMeta: { pr: { head_sha_at_acceptance: headSha.slice(0, 9) } }, mergeable, mergeStateStatus: null, commits: [{ sha: headSha, verified: true }] });
    for (const [pr, sha, mergeable] of [
      [281, sha281, false],
      [279, sha279, false],
      [279, sha279, true],
      [281, sha281, true], // the old fail-open: green-but-unanswered used to merge
    ] as const) {
      expect(decideTrainGate(row(pr, sha, mergeable)).kind).toBe("skip");
    }
    // control: a DEFINITIVE dirty state still bounces — real defects stay
    const dirty = decideTrainGate(clean({ mergeable: false, mergeStateStatus: "dirty" }));
    expect(dirty.kind).toBe("bounce");
    if (dirty.kind === "bounce") expect(dirty.bounceKind).toBe("conflict");
  });
});

// ---------- ask/brief copy (the ask contract: ≤240 chars, ends "?") ----------

describe("train event copy", () => {
  it("trainStopAskTitle dedupes per (lane, sha, failing) and holds the 240-char line", () => {
    const lane = { repo: "state-vector/superpositional", base: "main" };
    const t = trainStopAskTitle(lane, "f".repeat(40), ["Test"]);
    expect(t).toContain("superpositional@main");
    expect(t).toContain("fffffffff");
    expect(t.endsWith("?")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(240);
    expect(trainStopAskTitle(lane, "f".repeat(40), ["Test"])).toBe(t);
    expect(trainStopAskTitle(lane, "f".repeat(40), ["Test", "CLI"])).not.toBe(t);
    const huge = trainStopAskTitle(lane, "f".repeat(40), Array.from({ length: 20 }, (_, i) => `matrix-job-number-${i}`));
    expect(huge.length).toBeLessThanOrEqual(240);
    expect(huge.endsWith("?")).toBe(true);
  });

  it("trainBounceBrief renders PER KIND (BR#4066) — coverage names the head-move and the verify pool, no conflict language, no file list", () => {
    const cov = trainBounceBrief({ prNumber: 2601, repo: "state-vector/bridge", headSha: "b".repeat(40), conflictFiles: [], verdictId: "BR#9", bounceKind: "coverage" });
    expect(cov).toContain("Merge-train bounce (coverage): PR #2601 (state-vector/bridge)");
    expect(cov).toContain("head moved past the accepted verify verdict");
    expect(cov).toContain("the push was authored");
    expect(cov).toContain("NOT a merge conflict");
    expect(cov).toContain("the verify pool");
    expect(cov).toContain("(BR#9) at the new head");
    expect(cov).toContain("re-verify at the new head");
    // the lie is gone: no conflict language, no file list, no "(no file list supplied)" dead-end
    expect(cov).not.toContain("conflicts with its base");
    expect(cov).not.toContain("Conflicting files");
    expect(cov).not.toContain("no file list supplied");
  });

  it("trainBounceBrief conflict kind keeps the file list and names the impl repair leg; a file-less conflict renders the honest fallback (the hub fail-louds upstream)", () => {
    const b = trainBounceBrief({ prNumber: 2601, repo: "state-vector/bridge", headSha: "b".repeat(40), conflictFiles: ["src/a.ts", "src/b.ts"], verdictId: "BR#9", bounceKind: "conflict" });
    expect(b).toContain("Merge-train bounce (conflict): PR #2601 (state-vector/bridge)");
    expect(b).toContain("conflicts with its base");
    expect(b).toContain("- `src/a.ts`");
    expect(b).toContain("- `src/b.ts`");
    expect(b).toContain("(BR#9) is INVALID at the new head");
    expect(b).toContain("machine-clean carries, human-resolved invalidates");
    expect(b).toContain("re-queues at the BACK");
    // BR#4066: bare (no kind, no defect, no files) classifies as GATE —
    // conflict language is never fabricated for a bounce with no files.
    const bare = trainBounceBrief({ prNumber: 1, repo: "r", headSha: null, conflictFiles: [], verdictId: null });
    expect(bare).toContain("(gate)");
    expect(bare).not.toMatch(/conflicts with its base/);
    expect(b).toContain("the impl repair leg");
    // an explicit conflict kind with no files renders the loud executor-defect
    // marker in the brief (the train:bounced HANDLER fails even louder).
    const bareConflict = trainBounceBrief({ prNumber: 1, repo: "r", headSha: null, conflictFiles: [], verdictId: null, bounceKind: "conflict" });
    expect(bareConflict).toContain("(CONFLICT BOUNCE WITHOUT A FILE LIST");
    expect(bareConflict).toContain("prior verdict is INVALID");
  });

  it("trainBounceBrief gate kind quotes the named defect + mergeStateStatus, no conflict language, next owner impl", () => {
    const g = trainBounceBrief({ prNumber: 7, repo: "o/r", headSha: "c".repeat(40), conflictFiles: [], verdictId: "BR#3", bounceKind: "gate", mergeStateStatus: "behind", defect: "PR #7 mergeStateStatus=behind — not clean. Fix the named state and re-enter" });
    expect(g).toContain("Merge-train bounce (gate): PR #7 (o/r)");
    expect(g).toContain("mergeStateStatus=BEHIND");
    expect(g).toContain("**Defect:** PR #7 mergeStateStatus=behind — not clean");
    expect(g).toContain("**Next owner: impl**");
    expect(g).not.toContain("conflicts with its base");
    expect(g).not.toContain("Conflicting files");
    expect(g).not.toContain("no file list supplied");
  });

  it("trainBounceBrief BASE-RED class (BR#5349, Ray directive): a gate bounce whose red is MAIN's own — the circular deploy-health merge gate, or a defect naming main red — renders the PLAIN brief (your PR is fine, nothing to do on this PR, the fix card named), never the rebase/re-sign/re-approve loop on a clean PR", () => {
    // the circular class: the red check named by the executor's head-check
    // defect is the deploy-health gate, which only judges MAIN
    const b = trainBounceBrief({
      prNumber: 2623, repo: "state-vector/superpositional", headSha: "9".repeat(40),
      conflictFiles: [], verdictId: "BR#5103", bounceKind: "gate",
      defect: "PR #2623 head check RED: Deploy health (merge gate). Fix or bounce to impl",
      fixCard: { id: "BR#5346", status: "in_progress" },
    });
    expect(b).toContain("Merge-train bounce (base-red): PR #2623 (state-vector/superpositional)");
    expect(b).toContain("MAIN is red (Deploy health (merge gate))");
    expect(b).toContain("**Your PR is fine — nothing to do on this PR.**");
    expect(b).toContain("the fix lives on BR#5346 (in progress)");
    expect(b).toContain("or re-run the flaky check");
    expect(b).toContain("or bypass-merge a cure PR");
    // the BR#5193 circular-park lie is gone: a clean PR is never told to
    // rebase/re-sign/re-approve
    expect(b).not.toContain("rebase");
    expect(b).not.toContain("re-sign");
    expect(b).not.toContain("re-approve");
    // no fix card open → the brief says so honestly (plain, still no loop)
    const noFix = trainBounceBrief({ prNumber: 1, repo: "o/r", headSha: null, conflictFiles: [], verdictId: null, bounceKind: "gate", defect: "base main RED — the standing order never merges onto a non-green destination" });
    expect(noFix).toContain("MAIN is red");
    expect(noFix).toContain("none open yet");
    expect(noFix).toContain("nothing to do on this PR");
    // a genuinely PR-owned red keeps the mechanical brief (impl fixes the
    // named defect) — the base-red class must not swallow real failures
    const prOwned = trainBounceBrief({ prNumber: 1, repo: "o/r", headSha: null, conflictFiles: [], verdictId: null, bounceKind: "gate", defect: "PR #1 head check RED: TypeScript Tests. Fix or bounce to impl" });
    expect(prOwned).toContain("Merge-train bounce (gate): PR #1 (o/r)");
    expect(prOwned).toContain("**Next owner: impl**");
    expect(prOwned).not.toContain("Your PR is fine");
  });

  it("resolveTrainBounceKind: explicit kind wins; legacy events infer from files then defect text; a kindless file-less event is an honest GATE bounce, never a manufactured conflict", () => {
    expect(resolveTrainBounceKind({ bounceKind: "coverage" })).toBe("coverage");
    expect(resolveTrainBounceKind({ bounceKind: "CONFLICT" })).toBe("conflict");
    expect(resolveTrainBounceKind({ bounceKind: "gate" })).toBe("gate");
    // legacy executor: files rode → conflict
    expect(resolveTrainBounceKind({ conflictFiles: ["a.ts"] })).toBe("conflict");
    // legacy executor: coverage defect text → coverage
    expect(resolveTrainBounceKind({ defect: "PR #7 head aaa bbb moved past the accepted verify verdict — re-verify the new head" })).toBe("coverage");
    expect(resolveTrainBounceKind({ defect: "PR #7 live head aaa is not covered by the accepted verdict (leg 1 stamped bbb) — re-verify at the new head" })).toBe("coverage");
    // kindless, fileless, unrecognized defect → gate copy (honest defect), NOT conflict language
    expect(resolveTrainBounceKind({})).toBe("gate");
    expect(resolveTrainBounceKind({ defect: "PR #7 head check RED: Test" })).toBe("gate");
  });

  it("trainAwaitingReason: the typed park reason is plain-readable — verdict + anchored head inline, stable per (card, leg) (BR#4962)", () => {
    const r = trainAwaitingReason("BR#2601", "b".repeat(40));
    // the exact format the acceptance pins (BR#4960 pull model — no ask)
    expect(r).toBe(`Awaiting review (verdict BR#2601, anchored at head ${"b".repeat(9)})`);
    expect(r.startsWith(TRAIN_AWAITING_REASON_PREFIX)).toBe(true);
    // the backlog/backlog-filter readers match on the prefix, never prose
    expect(TRAIN_AWAITING_REASON_PREFIX).toBe("Awaiting review (verdict ");
    // head is ALWAYS truncated to 9 — the reason never carries a 40-hex wall
    expect(trainAwaitingReason("BR#1", "c".repeat(40))).toContain(`head ${"c".repeat(9)}`);
    // honest degenerate shapes: unrecorded verdict / headless bounce
    expect(trainAwaitingReason(null, null)).toBe("Awaiting review (verdict unrecorded, anchored at head unknown)");
  });

  it("trainAwaitingReason: re-bounces of the same leg refresh IN PLACE — the reason is a pure function, never a second row (BR#4962)", () => {
    const a = trainAwaitingReason("BR#2601", "b".repeat(40));
    const b = trainAwaitingReason("BR#2601", "b".repeat(40));
    expect(a).toBe(b);
  });

  it("trainLandedCloseNote cites the PR, the gateway, and the machine proxy", () => {
    const n = trainLandedCloseNote({ repo: "state-vector/bridge", prNumber: 2600, mergeSha: "c".repeat(40), gateway: "gw-1", greenRunUrl: "https://example/green" });
    expect(n).toContain("landed via the serialized merge train (BR#3516)");
    expect(n).toContain("PR [#2600]");
    expect(n).toContain("merged as ccccccccc by gateway gw-1");
    expect(n).toContain("machine proxy held: mergeCommit non-null AND required main workflows green (https://example/green)");
    expect(n).toContain(`github.com/state-vector/bridge/commit/${"c".repeat(40)}`);
  });

  it("TRAIN_HEAD_STAMP_RE parses the verifier's head stamp (the no-GitHub binding)", () => {
    expect(TRAIN_HEAD_STAMP_RE.exec("verified head abc123def and merged")?.[1]).toBe("abc123def");
    expect(TRAIN_HEAD_STAMP_RE.exec("head=abc123def")?.[1]).toBe("abc123def");
    expect(TRAIN_HEAD_STAMP_RE.exec("head: ABC123DEF")?.[1]).toBe("ABC123DEF");
    // mid-word "head"/"heads" is not a stamp; nothing is a guess
    expect(TRAIN_HEAD_STAMP_RE.exec("forehead abc123def")).toBeNull();
    expect(TRAIN_HEAD_STAMP_RE.exec("heads abc123def")).toBeNull();
    expect(TRAIN_HEAD_STAMP_RE.exec("verified, no stamp here")).toBeNull();
  });
});

// ---------- BR#4962 / BR#4960: the Awaiting park's visible-age window ----------

describe("clampAwaitingTtlHours (the park never expires itself — the knob feeds the chip only)", () => {
  it("settings garbage clamps to the honest default window; the legacy knob falls back first", () => {
    expect(TRAIN_AWAITING_TTL_H_DEFAULT).toBe(24);
    expect(TRAIN_AWAITING_GRACE_MS).toBe(2 * 60 * 60_000);
    expect(clampAwaitingTtlHours("36")).toBe(36);
    expect(clampAwaitingTtlHours(48)).toBe(48);
    // legacy fallback: the awaiting knob unset, the old review-ask knob set
    expect(clampAwaitingTtlHours("", "72")).toBe(72);
    expect(clampAwaitingTtlHours(undefined, "72")).toBe(72);
    // the awaiting knob outranks the legacy one
    expect(clampAwaitingTtlHours("36", "72")).toBe(36);
    // garbage in BOTH → the default
    expect(clampAwaitingTtlHours("0", "abc")).toBe(24); // falsy garbage → the default
    expect(clampAwaitingTtlHours(-5)).toBe(24);
    expect(clampAwaitingTtlHours("abc")).toBe(24);
    expect(clampAwaitingTtlHours("9999")).toBe(720); // the 1..720 clamp
    expect(clampAwaitingTtlHours()).toBe(24);
  });
});

// ---------- BR#5226: the human-leg park classes + the shared re-queue swap ----------

describe("trainAwaitingHumanLeg (the ONLY Awaiting parks — BR#4960: human legs for genuine human cases)", () => {
  it("human-resolved conflicts invalidate the verdict — conflict files on the event park", () => {
    expect(trainAwaitingHumanLeg("head moved past the accepted verdict", ["src/a.ts"])).toBe(true);
    expect(trainAwaitingHumanLeg(null, ["a.ts", "b.ts"])).toBe(true);
    // zero files = no conflict invalidation
    expect(trainAwaitingHumanLeg("head moved past the accepted verdict", [])).toBe(false);
  });
  it("a dismissed external review with no machine replacement parks; a plain machine lapse does not", () => {
    expect(trainAwaitingHumanLeg("external review dismissed on the head move — no machine replacement", [])).toBe(true);
    expect(trainAwaitingHumanLeg("the GitHub approval was dismissed when the head moved", [])).toBe(true);
    expect(trainAwaitingHumanLeg("reviewer dismissed the review", [])).toBe(true);
    // the plain lapse text the executor renders — machine-reviable, never a park
    expect(trainAwaitingHumanLeg("PR #1 live head abc is not covered by the accepted verdict (leg 1 stamped def, no contiguous carry chain) — head moved past the verdict without a machine-clean update; re-verify at the new head", [])).toBe(false);
    expect(trainAwaitingHumanLeg(null, [])).toBe(false);
    expect(trainAwaitingHumanLeg("", [])).toBe(false);
  });
  it("the signing-environment class parks (the verify gate's only human escalation)", () => {
    expect(trainAwaitingHumanLeg("signing environment broken — key unavailable", [])).toBe(true);
    expect(trainAwaitingHumanLeg("commit author NO_USER — no signing identity", [])).toBe(true);
    // an ordinary unsigned-commit gate defect is NOT the environment class
    expect(trainAwaitingHumanLeg("PR #1 unmergeable — unsigned commits", [])).toBe(false);
  });
});

describe("trainRequeueSwap (the shared in-place machine re-entry — BR#5226)", () => {
  it("state queued, awaiting cleared, boost decayed, queued reason restored — stamps and the typed await_event untouched", () => {
    const H = "a".repeat(40);
    const m = trainRequeueSwap({
      pr: { repo: "state-vector/bridge", number: 1, head_sha_at_acceptance: H, carry: [{ from_head: H, to_head: "b".repeat(40), prior_verdict_id: "BR#1", carried_ts: 1, via: "update-branch" }] },
      merge_train: { state: "awaiting", bounce_kind: "coverage", awaiting: { at: 1, head_sha: H, verdict_id: "BR#9" }, pr: 1, repo: "state-vector/bridge" },
      boosted: 123,
      blocked: { reason: "Awaiting review (verdict BR#9, anchored at head aaaaaaaaa)", await_event: { event: "pr_merged", repo: "state-vector/bridge", n: 1 } },
    });
    expect(m.merge_train.state).toBe("queued");
    expect(m.merge_train.awaiting).toBeUndefined();
    expect(m.boosted).toBeUndefined();
    expect(m.blocked.reason).toBe("merge-train: queued");
    // the machine proxy exit + the verdict stamps survive the swap
    expect(m.blocked.await_event).toEqual({ event: "pr_merged", repo: "state-vector/bridge", n: 1 });
    expect(m.pr.head_sha_at_acceptance).toBe(H);
    expect(m.pr.carry).toHaveLength(1);
  });
  it("tolerates a bare meta (no merge_train, no blocked box) — the swap still renders the queued state", () => {
    const m = trainRequeueSwap({});
    expect(m.merge_train.state).toBe("queued");
    expect(m.blocked.reason).toBe("merge-train: queued");
  });
});

// ---------- BR#3727 clock + BR#4633 L4.2 approval anchor ----------

describe("decideTrainGate blocked/behind (BR#3727 clock + BR#4633 L4.2 approval anchor)", () => {
  const HEAD = "c".repeat(40);
  const run = (id: number, conclusion: string | null): MainCheckRun =>
    ({ id, name: "Test", status: conclusion == null ? "in_progress" : "completed", conclusion, html_url: `https://example/${id}` });
  const gate = (over: Partial<Parameters<typeof decideTrainGate>[0]> = {}) =>
    decideTrainGate({
      prNumber: 4700,
      headSha: HEAD,
      cardMeta: { pr: { repo: "state-vector/bridge", number: 4700, head_sha_at_acceptance: HEAD.slice(0, 9) } },
      cardStatus: "blocked",
      baseVerdict: "green",
      mergeable: true,
      mergeStateStatus: "blocked",
      commits: [{ sha: HEAD, verified: true }],
      headChecks: [run(1, "success")],
      ...over,
    });

  it("BR#3727 clock: blocked with PENDING required checks is a wait, not a bounce — skip this tick", () => {
    // strict protection re-runs the required checks on the head after every
    // machine-clean update-branch — the tick after the carry reads blocked
    const d = gate({ headChecks: [run(1, "success"), run(2, null)] });
    expect(d.kind).toBe("skip");
    if (d.kind === "skip") {
      expect(d.reason).toContain("mergeStateStatus=blocked");
      expect(d.reason).toContain("pending, not a defect");
    }
  });

  it("blocked with RED head checks notes (no bounce) — the queued card's session owns it", () => {
    const d = gate({ headChecks: [run(1, "failure")] });
    expect(d.kind).toBe("note");
    if (d.kind === "note") expect(d.reason).toContain("head check RED");
  });

  it("BR#6776: a substance verdict cannot overrule GitHub's still-BLOCKED admission", () => {
    const d = gate();
    expect(d.kind).toBe("note");
    if (d.kind === "note") expect(d.reason).toContain("GitHub branch policy remains BLOCKED");
  });

  it("the shared law keeps the anchor: decideMergeAction's blocked bounce names the BR verdict, not a re-approve leg", () => {
    const d = decideMergeAction({
      prNumber: 4701,
      prTitle: "",
      headSha: HEAD,
      baseVerdict: "green",
      mergeable: true,
      mergeStateStatus: "blocked",
      commits: [{ sha: HEAD, verified: true }],
      headChecks: [run(1, "success")],
      cardStatus: "blocked",
      verifyAcceptedOnHead: true,
      verifyAcceptedAny: true,
    });
    expect(d.kind).toBe("bounce");
    if (d.kind === "bounce") {
      expect(d.bounceKind).toBe("gate");
      expect(d.defect).toContain("approval of record");
      expect(d.defect).toContain("BR#4633 L4.2");
      expect(d.defect).not.toContain("re-approve)"); // the old posture is gone
    }
  });
});

// ---------- BR#3659: the close-note leg parser ----------

describe("trainParseNoteLegs (the close-note leg parser — BR#3659)", () => {
  const u = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;
  it("single-PR notes bind the note's FIRST head wherever it sits (the pre-3659 convention, unchanged)", () => {
    const R = "state-vector/bridge";
    const h = "a".repeat(40);
    // head after the PR — the documented convention
    expect(trainParseNoteLegs(`verified head ${h} — PR ${u(R, 7)}`)).toEqual([
      { repo: R, number: 7, head_sha_at_acceptance: h },
    ]);
    // head BEFORE the PR, same note — the first head pairs with the one URL
    expect(trainParseNoteLegs(`verified head ${h} (drill) — PR ${u(R, 7)}`)).toEqual([
      { repo: R, number: 7, head_sha_at_acceptance: h },
    ]);
    // punctuation terminates the stamp (the widened lookahead)
    expect(trainParseNoteLegs(`verified head ${h.slice(0, 9)}; PR ${u(R, 7)}`)).toEqual([
      { repo: R, number: 7, head_sha_at_acceptance: h.slice(0, 9) },
    ]);
  });
  it("BR#6349: a receipts deep-link re-citing an already-cited PR collapses to ONE leg — never a phantom second citation", () => {
    const R = "state-vector/bridge";
    const h = "d401a35bbe2faaa6cc8c9060a2b3413b039b9344";
    // the BR#4684/PR#309 incident note: canonical /pull/ URL + the
    // /pull/N/commits/<sha> receipt deep-link, which TRAIN_PR_URL_RE also
    // matches. Before the fix this parsed TWO legs for one PR, broke the
    // adjacency pairing, and the queue arm silently re-stamped the STALE head.
    expect(trainParseNoteLegs(
      `Verify ACCEPT — PR ${u(R, 309)} head ${h}\nreceipts: ${u(R, 309)}/commits/${h}`,
    )).toEqual([{ repo: R, number: 309, head_sha_at_acceptance: h }]);
    // with ONE cited leg the lenient single-PR binding applies again: even a
    // clause break between the head and its citation still binds (the incident
    // died exactly here — two legs forced strict adjacency and bound neither)
    expect(trainParseNoteLegs(
      `Verify ACCEPT (duty drill). head ${h}\nPR ${u(R, 309)}; receipts: ${u(R, 309)}/commits/${h}`,
    )).toEqual([{ repo: R, number: 309, head_sha_at_acceptance: h }]);
    // URL + owner/name#N shorthand citing the same PR also stays ONE leg
    expect(trainParseNoteLegs(
      `PR ${u(R, 309)} head ${h} (${R}#309, merged)`,
    )).toEqual([{ repo: R, number: 309, head_sha_at_acceptance: h }]);
  });
  it("multi-PR notes pair each PR with its NEAREST head (line by line — either order binds)", () => {
    const R = "state-vector/bridge";
    const b = "b".repeat(40), c = "c".repeat(40);
    const expectLegs = [
      { repo: R, number: 11, head_sha_at_acceptance: b },
      { repo: R, number: 12, head_sha_at_acceptance: c },
    ];
    // head after each PR (the documented convention)
    expect(trainParseNoteLegs(`accepted both legs — PR ${u(R, 11)} head ${b}; PR ${u(R, 12)} head ${c}`)).toEqual(expectLegs);
    // head before each PR, same line — proximity binds them correctly, no cross-pair
    expect(trainParseNoteLegs(`head ${b} — PR ${u(R, 11)}; head ${c} — PR ${u(R, 12)}`)).toEqual(expectLegs);
    // the list layout: the head on the line BELOW its PR
    expect(trainParseNoteLegs(`- PR ${u(R, 11)}\n  head ${b}\n- PR ${u(R, 12)}\n  head ${c}`)).toEqual(expectLegs);
    // a PR whose receipt was never cited stays unbound — fail-closed, no guessing
    expect(trainParseNoteLegs(`PR ${u(R, 11)} head ${b}; PR ${u(R, 12)}`)).toEqual([
      { repo: R, number: 11, head_sha_at_acceptance: b },
      { repo: R, number: 12 },
    ]);
    // a stray head is never stolen by the wrong PR: the nearer PR binds it
    expect(trainParseNoteLegs(`PR ${u(R, 11)}; PR ${u(R, 12)} head ${c}`)).toEqual([
      { repo: R, number: 11 },
      { repo: R, number: 12, head_sha_at_acceptance: c },
    ]);
  });
  it("multi-repo legs parse with their own repo", () => {
    expect(trainParseNoteLegs(`PR ${u("o/r1", 3)} head ${"a".repeat(7)}; PR ${u("o/r2", 4)} head ${"b".repeat(7)}`)).toEqual([
      { repo: "o/r1", number: 3, head_sha_at_acceptance: "a".repeat(7) },
      { repo: "o/r2", number: 4, head_sha_at_acceptance: "b".repeat(7) },
    ]);
  });
  it("no PR reference parses empty", () => {
    expect(trainParseNoteLegs("verified head abc123def, no PR cited")).toEqual([]);
  });
  it("BR#4648: the board's owner/name#N shorthand is a PR reference — it pairs heads exactly like a URL", () => {
    const R = "state-vector/superpositional";
    const h = "6".repeat(40);
    // the exact production shape that spun the coverage loop (BR#3764 cycles 2-6):
    // shorthand citation + the head token present — this must parse to a bound leg
    expect(trainParseNoteLegs(`Verify ACCEPT — PR ${R}#2466 OPEN, all commits verified; head ${h}`)).toEqual([
      { repo: R, number: 2466, head_sha_at_acceptance: h },
    ]);
    // multi-PR adjacency through shorthand, both orders
    const b = "b".repeat(40), c = "c".repeat(40);
    expect(trainParseNoteLegs(`PR o/r#11 head ${b}; PR o/r#12 head ${c}`)).toEqual([
      { repo: "o/r", number: 11, head_sha_at_acceptance: b },
      { repo: "o/r", number: 12, head_sha_at_acceptance: c },
    ]);
    expect(trainParseNoteLegs(`head ${b} — PR o/r#11; head ${c} — PR o/r#12`)).toEqual([
      { repo: "o/r", number: 11, head_sha_at_acceptance: b },
      { repo: "o/r", number: 12, head_sha_at_acceptance: c },
    ]);
    // a shorthand-cited PR with no head stays unbound — fail-closed, no guessing
    expect(trainParseNoteLegs(`PR o/r#11 head ${b}; PR o/r#12`)).toEqual([
      { repo: "o/r", number: 11, head_sha_at_acceptance: b },
      { repo: "o/r", number: 12 },
    ]);
  });
  it("BR#4648: URL + shorthand citing the same PR collapse to one leg; bare #N (card ids, prose) never matches", () => {
    const R = "state-vector/bridge";
    const h = "a".repeat(40);
    expect(trainParseNoteLegs(`PR https://github.com/${R}/pull/7 merged; re-verified ${R}#7 head ${h}`)).toEqual([
      { repo: R, number: 7, head_sha_at_acceptance: h },
    ]);
    // `#N` without an owner/name prefix is inert — BR#NNNN card refs and
    // "the unrelated #2534 merge" prose never become legs
    expect(trainParseNoteLegs(`rebased over the unrelated #2534 merge; BR#4648 spins no more; head ${h}`)).toEqual([]);
  });
  it("BR#5658 / BR#5324 / BR#5805: rejects /BR#N cross-references, CSS tokens, and numeric-owner fragments (never mints ghost lanes like tb-pulse/BR or 5563/BR)", () => {
    const h = "a".repeat(40);
    expect(isValidGitHubRepo("state-vector/bridge")).toBe(true);
    expect(isValidGitHubRepo("o/r")).toBe(true);
    expect(isValidGitHubRepo("tb-pulse/BR")).toBe(false);
    expect(isValidGitHubRepo("5563/BR")).toBe(false);
    expect(isValidGitHubRepo("1768/BR")).toBe(false);
    expect(isValidGitHubRepo("5022/BR")).toBe(false);
    expect(isValidGitHubRepo("foo/GH")).toBe(false);
    expect(trainParseNoteLegs(`added @keyframes tb-pulse/BR#5658 and BR#5563/BR#5635; (#1768/BR#4993) head ${h}`)).toEqual([]);
    expect(parseDirectCommitReceipt(`Landed direct to main — https://github.com/state-vector/bridge/commit/${h}`)).toEqual({
      repo: "state-vector/bridge",
      sha: h,
    });
    expect(parseDirectCommitReceipt(`PR https://github.com/state-vector/bridge/pull/350 head ${h}`)).toBeNull();
  });
  it("BR#5658: partitionMergeBatches partitions verifying + ready PRs into sequential non-conflicting merge passes", () => {
    const cars = [
      { id: "BR#1", pr: 101, state: "ready" as const },
      { id: "BR#2", pr: 102, state: "verifying" as const },
      { id: "BR#3", pr: 103, state: "waiting" as const },
      { id: "BR#4", pr: 104, state: "ready" as const },
    ];
    // PR 101 and PR 104 conflict → Batch 1 takes [101, 102, 103], Batch 2 takes [104]
    const batches = partitionMergeBatches(cars, [[101, 104]], 10);
    expect(batches.map((b) => b.map((c) => c.pr))).toEqual([
      [101, 102, 103],
      [104],
    ]);
    // burst_max cap = 2 with no conflicts → ready cars [101, 104] first in Batch 1, then [102, 103] in Batch 2
    const capped = partitionMergeBatches(cars, [], 2);
    expect(capped.map((b) => b.map((c) => c.pr))).toEqual([
      [101, 104],
      [102, 103],
    ]);
  });
  it("BR#5897: classifyHeadChecks deduplicates by check name (newest non-cancelled run wins over stale failure)", () => {
    const v = classifyHeadChecks([
      { id: 100, name: "Deploy health (merge gate)", conclusion: "failure", html_url: "https://example/old1" },
      { id: 101, name: "Deploy health (merge gate)", conclusion: "failure", html_url: "https://example/old2" },
      { id: 200, name: "Deploy health (merge gate)", conclusion: "success", html_url: "https://example/new" },
      { id: 201, name: "Rust Tests", conclusion: "success", html_url: "https://example/rust" },
    ]);
    expect(v.verdict).toBe("green");
    expect(v.red).toEqual([]);
    expect(v.green).toBe(2);
  });
});

// ---------- BR#5329: ghost rows + prose-only accepts ----------

describe("trainParseNoteLegs (BR#5329 — ghost-row validation + machine-leg prose)", () => {
  const h = "a".repeat(40);
  it("BR#5329 defect 2: slash-joined card-reference prose never becomes a leg (the ghost meta.prs row defect)", () => {
    // the exact production specimens (BR#5202 / BR#5304 close notes):
    // `BR#4365/BR#4875` parsed as repo '4365/BR' #4875 and `BR#4728/BR#5299`
    // as repo '4728/BR' #5299 — both gh 404, both queued ghost merge lanes
    expect(trainParseNoteLegs(`parent BR#4365/BR#4875 re-verified; head ${h}`)).toEqual([]);
    expect(trainParseNoteLegs(`base-owned BR#4728/BR#5299 class, train waits it out; head ${h}`)).toEqual([]);
    // a card ref '#' glued to a REAL repo name is inert too (the lookbehind
    // keeps the match from starting mid-token — the misparse could otherwise
    // surface a WRONG but well-shaped repo)
    expect(trainParseNoteLegs(`BR#1234/state-vector/bridge#307 head ${h}`)).toEqual([]);
  });
  it("BR#5329 defect 2: an all-numeric owner is rejected even when the prose hands the shape to the parser", () => {
    expect(trainParseNoteLegs(`PR 4365/BR#4875 head ${h}`)).toEqual([]);
    expect(trainParseNoteLegs(`PR 4728/BR#5299 head ${h}`)).toEqual([]);
    // real repos with digits in the owner keep parsing (GitHub allows them)
    expect(trainParseNoteLegs(`PR 4state/r#11 head ${h}`)).toEqual([
      { repo: "4state/r", number: 11, head_sha_at_acceptance: h },
    ]);
  });
  it("BR#5329 defect 1: the typed machine-leg prose repo=o/r n=N is a PR reference", () => {
    // the exact BR#5315 close-note shape — the note carried the head token and
    // this prose only, so the accept stamp stayed at the PRIOR verdict's head
    // and every re-verify coverage-bounced at an unchanged live head
    expect(trainParseNoteLegs(`head ${h} — Parent BR#5202 parked with the ONE typed leg await_event pr_merged repo=state-vector/superpositional n=2624 (conjunction as prose, BR#3986)`)).toEqual([
      { repo: "state-vector/superpositional", number: 2624, head_sha_at_acceptance: h },
    ]);
  });
  it("BR#5329 defect 1: the seeded duty brief's JSON-ish leg repo:\"o/r\", n:N is a PR reference", () => {
    expect(trainParseNoteLegs(`head ${h}; pass await_event {event:"pr_merged", repo:"state-vector/bridge", n:307}`)).toEqual([
      { repo: "state-vector/bridge", number: 307, head_sha_at_acceptance: h },
    ]);
  });
  it("BR#5329: a repo=/n= citation without its n= half (or vice versa) never invents a leg", () => {
    expect(trainParseNoteLegs(`repo=state-vector/superpositional without the number; head ${h}`)).toEqual([]);
    expect(trainParseNoteLegs(`n=2624 alone names no repo; head ${h}`)).toEqual([]);
  });
});

describe("trainStampRefresh (BR#5329 — the no-PR-citation stamp refresh, pure)", () => {
  const R = "state-vector/superpositional";
  const old1 = "1".repeat(40), old2 = "2".repeat(40), fresh = "f".repeat(40);
  const legs2 = [
    { repo: R, number: 2624, head_sha_at_acceptance: old1 },
    { repo: R, number: 2633, head_sha_at_acceptance: old2 },
  ];
  it("BR#4648 unchanged: lone head + a single open leg refreshes it", () => {
    const r = trainStampRefresh({ legs: [{ repo: R, number: 2624, head_sha_at_acceptance: old1 }], meta: {}, note: `head ${fresh} — VERIFY ACCEPT` });
    expect(r.legs[0].head_sha_at_acceptance).toBe(fresh);
    expect(r.refreshed).toEqual([{ number: 2624, repo: R, head: fresh, via: expect.stringContaining("BR#4648") }]);
  });
  it("BR#5329: lone head + a bare `PR #N` citation refreshes the NAMED leg on a multi-leg stamp", () => {
    const r = trainStampRefresh({ legs: legs2, meta: {}, note: `head ${fresh} — PR #2633 verified, rebase-only, content unchanged` });
    expect(r.legs[0].head_sha_at_acceptance).toBe(old1);
    expect(r.legs[1].head_sha_at_acceptance).toBe(fresh);
    expect(r.refreshed).toEqual([{ number: 2633, repo: R, head: fresh, via: expect.stringContaining("BR#5329") }]);
  });
  it("multi-leg stamp, no leg named — fail-closed, no guessing which leg the head names", () => {
    const r = trainStampRefresh({ legs: legs2, meta: {}, note: `head ${fresh} — VERIFY ACCEPT` });
    expect(r.legs).toEqual(legs2);
    expect(r.refreshed).toEqual([]);
  });
  it("a landed leg is out of the refresh pool; a no-op head stays a no-op", () => {
    const meta = { merge_train: { legs: { "2624": { state: "landed" } } } };
    const r = trainStampRefresh({ legs: legs2, meta, note: `head ${fresh} — PR #2624` });
    // 2624 landed → the one OPEN leg (2633) is the lone-head target (BR#4648);
    // the landed leg's stamp never moves
    expect(r.legs[0].head_sha_at_acceptance).toBe(old1);
    expect(r.legs[1].head_sha_at_acceptance).toBe(fresh);
    expect(r.refreshed.map((x) => x.number)).toEqual([2633]);
    const noop = trainStampRefresh({ legs: [{ repo: R, number: 2624, head_sha_at_acceptance: fresh }], meta: {}, note: `head ${fresh}` });
    expect(noop.refreshed).toEqual([]);
  });
  it("no head token — nothing to do", () => {
    const r = trainStampRefresh({ legs: legs2, meta: {}, note: `PR #2633 verified, head omitted` });
    expect(r.legs).toEqual(legs2);
    expect(r.refreshed).toEqual([]);
  });
});

// ---------- BR#3659: the leg model ----------

describe("trainLegs / trainLegLanded / trainLegsRemaining (the leg model)", () => {
  const meta2 = {
    pr: { repo: "o/r", number: 1, head_sha_at_acceptance: "a".repeat(40) },
    prs: [
      { repo: "o/r", number: 1, head_sha_at_acceptance: "a".repeat(40) },
      { repo: "o/r", number: 2, head_sha_at_acceptance: "b".repeat(40) },
    ],
    merge_train: { state: "queued", pr: 1, legs: { "1": { state: "landed", merge_sha: "m1" } } },
  };
  it("meta.prs is the leg list; meta.pr alone is the pre-3659 single-leg fallback", () => {
    expect(trainLegs(meta2).map((l) => l.number)).toEqual([1, 2]);
    expect(trainLegs({ pr: { repo: "o/r", number: 9, head_sha_at_acceptance: "z".repeat(40) } }).map((l) => l.number)).toEqual([9]);
    expect(trainLegs({})).toEqual([]);
  });
  it("a leg is landed via the per-leg map, or the legacy card-level landed stamp", () => {
    expect(trainLegLanded(meta2, trainLegs(meta2)[0])).toBe(true);
    expect(trainLegLanded(meta2, trainLegs(meta2)[1])).toBe(false);
    const legacy = { pr: { repo: "o/r", number: 7 }, merge_train: { state: "landed", pr: 7 } };
    expect(trainLegLanded(legacy, trainLegs(legacy)[0])).toBe(true);
    expect(trainLegLanded({}, { repo: "o/r", number: 7 })).toBe(false);
  });
  it("remaining legs are what keep the card queued — repo-scoped for the lane", () => {
    expect(trainLegsRemaining(meta2).map((l) => l.number)).toEqual([2]);
    expect(trainLegsRemaining(meta2, "o/r").map((l) => l.number)).toEqual([2]);
    const two = { prs: [{ repo: "o/r1", number: 1 }, { repo: "o/r2", number: 2 }] };
    expect(trainLegsRemaining(two, "o/r1").map((l) => l.number)).toEqual([1]);
    expect(trainLegsRemaining(two, "o/r2").map((l) => l.number)).toEqual([2]);
    // all landed → nothing remains (the card must not keep riding any lane)
    const done = { prs: [{ repo: "o/r", number: 1 }], merge_train: { state: "landed" } };
    expect(trainLegsRemaining(done)).toEqual([]);
  });
  it("a card rides exactly the lanes owning one of its UNLANDED legs (BR#3659 lane filter)", () => {
    expect(trainCardMatchesLane(meta2, "o/r")).toBe(true);
    // repo 1's legs are all landed: the card left THAT lane, still rides r2's
    const r2Only = {
      prs: [
        { repo: "o/r1", number: 1, head_sha_at_acceptance: "a".repeat(40) },
        { repo: "o/r2", number: 2, head_sha_at_acceptance: "b".repeat(40) },
      ],
      merge_train: { legs: { "1": { state: "landed", merge_sha: "m1" } } },
    };
    expect(trainCardMatchesLane(r2Only, "o/r1")).toBe(false);
    expect(trainCardMatchesLane(r2Only, "o/r2")).toBe(true);
  });
  it("a lane's BASE filters the queue — baseless legs default to main (BR#4977)", () => {
    // A card stamped with base "release/1" rides the release lane, NEVER the
    // main lane of the same repo (the drill-lane inheritance defect), and a
    // baseless stamp (the legacy/pre-stamp convention) defaults to "main".
    const onRelease = {
      pr: { repo: "o/r", number: 3, head_sha_at_acceptance: "c".repeat(40), base: "release/1" },
    };
    expect(trainCardMatchesLane(onRelease, "o/r", "release/1")).toBe(true);
    expect(trainCardMatchesLane(onRelease, "o/r", "main")).toBe(false);
    const baseless = { pr: { repo: "o/r", number: 4, head_sha_at_acceptance: "d".repeat(40) } };
    expect(trainCardMatchesLane(baseless, "o/r", "main")).toBe(true);
    expect(trainCardMatchesLane(baseless, "o/r", "release/1")).toBe(false);
    // repo scoping still applies first — a leg on another repo never matches
    expect(trainCardMatchesLane(onRelease, "o/other", "release/1")).toBe(false);
    // landed legs on the matching base still drop off
    const landedOnRelease = { pr: { repo: "o/r", number: 5 }, merge_train: { state: "landed" } };
    expect(trainCardMatchesLane(landedOnRelease, "o/r", "release/1")).toBe(false);
  });
});

// ---------- BR#3659: per-leg carry ----------

describe("verdictCoversHeadLeg / carryAppendLeg (per-leg carry — BR#3659)", () => {
  const legs = [
    { repo: "o/r", number: 1, head_sha_at_acceptance: "a".repeat(9) },
    { repo: "o/r", number: 2, head_sha_at_acceptance: "b".repeat(40) },
  ];
  it("each leg is judged by ITS own stamp — one leg's coverage never covers the other", () => {
    expect(verdictCoversHeadLeg(legs[0], "a".repeat(40))).toBe(true); // 9-hex stamp prefixes the full 40
    expect(verdictCoversHeadLeg(legs[0], "b".repeat(40))).toBe(false); // never cross-leg
    expect(verdictCoversHeadLeg(legs[1], "b".repeat(40))).toBe(true);
    expect(verdictCoversHeadLeg(undefined, "a".repeat(40))).toBe(false);
  });
  it("a leg's carry chain covers the chain's head, fail-closed", () => {
    const leg = {
      repo: "o/r", number: 3, head_sha_at_acceptance: "a".repeat(40),
      carry: [{ from_head: "a".repeat(40), to_head: "c".repeat(40), prior_verdict_id: "v1", carried_ts: 1, via: "update-branch" as const }],
    };
    expect(verdictCoversHeadLeg(leg, "c".repeat(40))).toBe(true);
    expect(verdictCoversHeadLeg(leg, "d".repeat(40))).toBe(false);
  });
  it("carryAppendLeg is pure — appends to the matching leg (and meta.pr when it is that leg), others untouched", () => {
    const meta: any = {
      pr: { repo: "o/r", number: 1, head_sha_at_acceptance: "a".repeat(9) },
      prs: [
        { repo: "o/r", number: 1, head_sha_at_acceptance: "a".repeat(9) },
        { repo: "o/r", number: 2, head_sha_at_acceptance: "b".repeat(40) },
      ],
    };
    const rec = { from_head: "a".repeat(9), to_head: "e".repeat(40), prior_verdict_id: "v2", carried_ts: 2, via: "update-branch" as const };
    const next = carryAppendLeg(meta, 1, rec);
    expect(next).not.toBe(meta);
    expect(meta.prs[0].carry).toBeUndefined(); // the caller's meta is never mutated
    expect(next.prs[0].carry).toEqual([rec]);
    expect(next.prs[1].carry).toBeUndefined();
    expect(next.pr.carry).toEqual([rec]); // legacy mirror — meta.pr IS leg 1
    // a leg that is NOT meta.pr never leaks its carry onto meta.pr
    const next2 = carryAppendLeg(meta, 2, rec);
    expect(next2.prs[1].carry).toEqual([rec]);
    expect(next2.pr.carry).toBeUndefined();
  });
});

// ---------- BR#3659: honest queue reason + the multi-leg landed close ----------

describe("the remaining-legs queue reason + the multi-leg landed close note (BR#3659)", () => {
  it("the reason names the legs still out and keeps the merge-train: prefix (the derive sees only that prefix)", () => {
    const meta = {
      prs: [{ repo: "o/r", number: 1 }, { repo: "o/r2", number: 2 }],
      merge_train: { legs: { "1": { state: "landed", merge_sha: "m1" } } },
    };
    const reason = trainQueueRemainingReason(meta);
    expect(reason.startsWith("merge-train: queued")).toBe(true);
    expect(reason).toContain("o/r2#2");
    expect(reason).not.toContain("#1");
  });
  it("trainLandedCloseNote cites EVERY leg on the final close; a single leg reads exactly as before", () => {
    const note = trainLandedCloseNote({
      repo: "o/r", prNumber: 2, mergeSha: "4".repeat(40), gateway: "gw",
      legs: [{ repo: "o/r", number: 1, mergeSha: "3".repeat(40) }, { repo: "o/r", number: 2, mergeSha: "4".repeat(40) }],
    });
    expect(note).toContain("all 2 queued PRs merged");
    expect(note).toContain("#1");
    expect(note).toContain("#2");
    expect(note).toContain("machine proxy held: mergeCommit non-null AND required main workflows green");
    const single = trainLandedCloseNote({ repo: "o/r", prNumber: 5, mergeSha: "5".repeat(40), gateway: "gw" });
    expect(single).toContain("PR [#5](https://github.com/o/r/pull/5) merged as 555555555");
  });
});

// ---------- BR#3659: the gate is per-leg ----------

describe("decideTrainGate legs (BR#3659 — the gate is per-leg)", () => {
  const H1 = "1".repeat(40), H2 = "2".repeat(40);
  const twoLegs = {
    pr: { repo: "o/r", number: 11, head_sha_at_acceptance: H1.slice(0, 9) },
    prs: [
      { repo: "o/r", number: 11, head_sha_at_acceptance: H1.slice(0, 9) },
      { repo: "o/r", number: 12, head_sha_at_acceptance: H2.slice(0, 9) },
    ],
  };
  const green = (id: number): MainCheckRun => ({ id, name: "Test", status: "completed", conclusion: "success", html_url: `https://example/${id}` });
  const gate = (legNumber: number, over: Partial<Parameters<typeof decideTrainGate>[0]> = {}) =>
    decideTrainGate({
      prNumber: legNumber === 1 ? 11 : 12,
      headSha: legNumber === 1 ? H1 : H2,
      cardMeta: twoLegs,
      cardStatus: "blocked",
      baseVerdict: "green",
      mergeable: true,
      mergeStateStatus: "clean",
      commits: [{ sha: legNumber === 1 ? H1 : H2, verified: true }],
      headChecks: [green(1)],
      legNumber,
      ...over,
    });
  it("a leg covered by its own stamp merges; an uncovered leg bounces naming ITS stamp", () => {
    expect(gate(1).kind).toBe("merge");
    expect(gate(2).kind).toBe("merge");
    const bounce = gate(2, { headSha: "d".repeat(40) });
    expect(bounce.kind).toBe("bounce");
    if (bounce.kind === "bounce") {
      expect(bounce.defect).toContain("leg 2 stamped 222222222");
      expect(bounce.defect).not.toContain("111111111");
      expect(bounce.bounceKind).toBe("coverage");
    }
  });
  it("a leg with NO stamp bounces fail-closed, naming the leg", () => {
    const noStamp = {
      pr: { repo: "o/r", number: 11 },
      prs: [{ repo: "o/r", number: 11 }, { repo: "o/r", number: 12, head_sha_at_acceptance: H2.slice(0, 9) }],
    };
    const d = gate(1, { cardMeta: noStamp });
    expect(d.kind).toBe("bounce");
    if (d.kind === "bounce") {
      expect(d.defect).toContain("leg 1 stamped (no stamp)");
      expect(d.bounceKind).toBe("coverage");
    }
  });
  it("the merge receipt cites the leg position (multi-leg provenance, never a leg-1-only lie)", () => {
    const d = gate(2);
    expect(d.kind).toBe("merge");
    if (d.kind === "merge") {
      expect(d.receipt).toContain("leg 2/2");
      expect(d.receipt).toContain("serialized merge train (BR#3516)");
      expect(d.receipt).toContain(H2.slice(0, 9));
    }
  });
  it("a legacy single-leg card (meta.pr only) gates exactly as before — legNumber defaults to 1", () => {
    const legacy = decideTrainGate({
      prNumber: 42,
      headSha: H1,
      cardMeta: { pr: { repo: "o/r", number: 42, head_sha_at_acceptance: H1.slice(0, 9) } },
      cardStatus: "blocked",
      baseVerdict: "green",
      mergeable: true,
      mergeStateStatus: "clean",
      commits: [{ sha: H1, verified: true }],
      headChecks: [green(1)],
    });
    expect(legacy.kind).toBe("merge");
  });
});

// ---------- BR#3714: the executor's fact boundary ----------

describe("normalizeGhMergeable / normalizeGhMergeState (BR#3714 — gh enums → the gate's contract)", () => {
  it("gh's GraphQL enum strings map to the boolean the 5c gate compares", () => {
    expect(normalizeGhMergeable("MERGEABLE")).toBe(true);
    expect(normalizeGhMergeable("CONFLICTING")).toBe(false);
    expect(normalizeGhMergeable("UNKNOWN")).toBe(null); // GitHub still computing
    expect(normalizeGhMergeable(null)).toBe(null);
    expect(normalizeGhMergeable(undefined)).toBe(null);
    expect(normalizeGhMergeable("MERGEABLE ")).toBe(null); // no sloppy truth — exact enum only
    // REST-shaped booleans pass through (both shapes are legal gh output)
    expect(normalizeGhMergeable(true)).toBe(true);
    expect(normalizeGhMergeable(false)).toBe(false);
  });

  it("gh's UPPERCASE mergeStateStatus lands lowercase; non-strings are null", () => {
    expect(normalizeGhMergeState("CLEAN")).toBe("clean");
    expect(normalizeGhMergeState("UNSTABLE")).toBe("unstable");
    expect(normalizeGhMergeState("BEHIND")).toBe("behind");
    expect(normalizeGhMergeState("DIRTY")).toBe("dirty");
    expect(normalizeGhMergeState("BLOCKED")).toBe("blocked");
    expect(normalizeGhMergeState(null)).toBe(null);
    expect(normalizeGhMergeState(42)).toBe(null);
  });

  it("THE REPRO: a gh-shaped PR (enum strings, pre-fix the bouncing case) merges through the SAME gate", () => {
    // Live receipt 2026-10-27: gh pr view 222 --repo state-vector/bridge
    // → mergeable:"MERGEABLE", mergeStateStatus:"BEHIND" (strings). Fed raw,
    // decideMergeAction read "MERGEABLE" ≠ true → bounce "unmergeable —
    // CONFLICTING" — the lie every tick told a perfectly mergeable PR.
    const HEAD = "a".repeat(40);
    const d = decideTrainGate({
      prNumber: 222,
      headSha: HEAD,
      cardMeta: { pr: { repo: "state-vector/bridge", number: 222, head_sha_at_acceptance: HEAD.slice(0, 9) } },
      cardStatus: "blocked",
      baseVerdict: "green",
      mergeable: normalizeGhMergeable("MERGEABLE"),
      mergeStateStatus: normalizeGhMergeState("CLEAN"),
      commits: [{ sha: HEAD, verified: true }],
      headChecks: [{ id: 1, name: "Test", status: "completed", conclusion: "success", html_url: "https://example/1" }],
    });
    expect(d.kind).toBe("merge");
  });

  it("the boundary is fail-closed in gh's shapes too — CONFLICTING bounces, UNKNOWN waits, states name themselves honestly", () => {
    const HEAD = "b".repeat(40);
    const base = {
      prNumber: 220,
      headSha: HEAD,
      cardMeta: { pr: { repo: "state-vector/bridge", number: 220, head_sha_at_acceptance: HEAD.slice(0, 9) } },
      cardStatus: "blocked",
      baseVerdict: "green",
      commits: [{ sha: HEAD, verified: true }],
      headChecks: [{ id: 1, name: "Test", status: "completed", conclusion: "success", html_url: "https://example/1" }],
    } as Parameters<typeof decideTrainGate>[0];
    const gh = (m: unknown, s: unknown): Parameters<typeof decideTrainGate>[0] =>
      ({ ...base, mergeable: normalizeGhMergeable(m), mergeStateStatus: normalizeGhMergeState(s) });
    // genuinely conflicting → the honest bounce (PR #220's real state)
    const conflict = decideTrainGate(gh("CONFLICTING", "DIRTY"));
    expect(conflict.kind).toBe("bounce");
    if (conflict.kind === "bounce") {
      expect(conflict.defect).toContain("CONFLICTING against base");
      expect(conflict.bounceKind).toBe("conflict");
    }
    // UNKNOWN → null → skip this tick (never a bounce)
    expect(decideTrainGate(gh("UNKNOWN", "UNKNOWN")).kind).toBe("skip");
    // uppercase behind PRE-CLEARS at the train gate for a WORKER-AUTHORED
    // branch (BR#3727 pre-clear, provenance-gated by BR#4687 L1.2 — the §5
    // carry is reachable; supersedes this block's original "BEHIND bounces
    // naming behind" pin: the shared decideMergeAction still bounces behind,
    // and the BR#3727 describe below pins that).
    expect(decideTrainGate({ ...gh("MERGEABLE", "BEHIND"), trainOwnedBranch: true }).kind).toBe("merge");
    // BR#4687: the SAME behind state on a branch the train cannot prove is
    // its own fleet's (a human's commits, or an unknown author) still
    // bounces naming behind — the train never moves human branches.
    const humanBehind = decideTrainGate(gh("MERGEABLE", "BEHIND"));
    expect(humanBehind.kind).toBe("bounce");
    if (humanBehind.kind === "bounce") {
      expect(humanBehind.bounceKind).toBe("gate");
      expect(humanBehind.defect).toContain("mergeStateStatus=behind");
    }
    // UNSTABLE stays within the gate's allowance (uppercase in, allowed out)
    expect(decideTrainGate(gh("MERGEABLE", "UNSTABLE")).kind).toBe("merge");
  });

  // BR#4687 (L1.2): the tick AFTER a machine update-branch — strict branch
  // protection re-runs the required checks on the new head, so mergeStateStatus
  // reads blocked while the head checks are unsettled. That is a clock, not a
  // defect: skip, and the carried verdict holds the queue slot silently.
  it("blocked-with-pending-checks after a machine update waits (never bounces the carry) — BR#3727 executor parity", () => {
    const HEAD = "c".repeat(40);
    const green = [{ id: 1, name: "Test", status: "completed", conclusion: "success", html_url: "https://example/1" }];
    const pending = [{ id: 2, name: "Test", status: "in_progress", conclusion: null, html_url: "https://example/2" }];
    const red = [{ id: 3, name: "Test", status: "completed", conclusion: "failure", html_url: "https://example/3" }];
    const input = (checks: unknown, status: string): Parameters<typeof decideTrainGate>[0] => ({
      prNumber: 320,
      headSha: HEAD,
      cardMeta: { pr: { repo: "state-vector/bridge", number: 320, head_sha_at_acceptance: HEAD.slice(0, 9) } },
      cardStatus: "blocked",
      baseVerdict: "green",
      mergeable: normalizeGhMergeable("MERGEABLE"),
      mergeStateStatus: normalizeGhMergeState(status),
      commits: [{ sha: HEAD, verified: true }],
      headChecks: checks as Parameters<typeof decideTrainGate>[0]["headChecks"],
      trainOwnedBranch: true,
    });
    const mk = (checks: unknown, status: string) => decideTrainGate(input(checks, status));
    // pending checks on blocked → wait this tick, NO bounce
    const waiting = mk(pending, "BLOCKED");
    expect(waiting.kind).toBe("skip");
    if (waiting.kind === "skip") expect(waiting.reason).toContain("required checks re-running");
    // red checks on blocked → note, never bounce — the linked session owns it
    // (the shared law's own non-in_review row, taken early by the blocked arm)
    expect(mk(red, "BLOCKED").kind).toBe("note");
    // A carried substance verdict does not override GitHub admission.
    const landed = mk(green, "BLOCKED");
    expect(landed.kind).toBe("note");
    if (landed.kind === "note") expect(landed.reason).toContain("no merge attempted");
  });

  // BR#4687 (L1.2): the merge receipt must name the provenance-qualified
  // pre-clear, so the ledger and the verify round can tell a machine-updated
  // worker branch from a plain clean merge.
  it("behind pre-clear receipt names the worker-authored branch and the update-branch carry", () => {
    const HEAD = "d".repeat(40);
    const r = decideTrainGate({
      prNumber: 311,
      headSha: HEAD,
      cardMeta: { pr: { repo: "state-vector/bridge", number: 311, head_sha_at_acceptance: HEAD.slice(0, 9) } },
      cardStatus: "blocked",
      baseVerdict: "green",
      mergeable: normalizeGhMergeable("MERGEABLE"),
      mergeStateStatus: normalizeGhMergeState("BEHIND"),
      commits: [{ sha: HEAD, verified: true }],
      headChecks: [{ id: 1, name: "Test", status: "completed", conclusion: "success", html_url: "https://example/1" }],
      trainOwnedBranch: true,
    });
    expect(r.kind).toBe("merge");
    if (r.kind === "merge") expect(r.receipt).toContain("behind pre-cleared");
  });
});

// BR#4066 — bounce KINDS: coverage / conflict / gate briefs name their cause
// and next owner; only a conflict bounce claims conflicts.
describe("trainBounceBrief kinds (BR#4066)", () => {
  const base = { prNumber: 2601, repo: "state-vector/bridge", headSha: "b".repeat(40), verdictId: "BR#9" };

  it("coverage bounce: no conflict language, verify pool owns the next leg", () => {
    const b = trainBounceBrief({ ...base, conflictFiles: [], bounceKind: "coverage", defect: "PR #2601 live head bbb is not covered by the accepted verdict (leg 1 stamped aaa)" });
    expect(b).toContain("(coverage)");
    expect(b).not.toContain("Conflicting files");
    expect(b).not.toMatch(/conflicts with its base/);
    expect(b).toContain("verify pool");
  });

  it("gate bounce: the gate's own defect renders, never conflict copy", () => {
    const b = trainBounceBrief({ ...base, conflictFiles: [], bounceKind: "gate", defect: "PR #2601 mergeStateStatus=behind — not clean", mergeStateStatus: "behind" });
    expect(b).toContain("mergeStateStatus=behind");
    expect(b).not.toMatch(/conflicts with its base/);
  });

  it("conflict bounce without files fails LOUD (executor defect), not the old shrug", () => {
    const b = trainBounceBrief({ ...base, conflictFiles: [], bounceKind: "conflict" });
    expect(b).toContain("CONFLICT BOUNCE WITHOUT A FILE LIST");
  });

  it("resolveTrainBounceKind: explicit kind wins, files win second, coverage phrasing third, else gate", () => {
    expect(resolveTrainBounceKind({ bounceKind: "gate", defect: "not covered", conflictFiles: ["a.ts"] })).toBe("gate");
    expect(resolveTrainBounceKind({ defect: "x", conflictFiles: ["a.ts"] })).toBe("conflict");
    expect(resolveTrainBounceKind({ defect: "head is not covered by the accepted verdict (leg 1)", conflictFiles: [] })).toBe("coverage");
    expect(resolveTrainBounceKind({ defect: "mergeStateStatus=dirty", conflictFiles: [] })).toBe("gate");
  });
});

// ---------- the landed-close recovery ladder (BR#4753) ----------

describe("trainLandedCloseEdge (green-branch wedge fix: never raw-throw, never wedge)", () => {
  it("a SEMANTIC gate rejection bounces on the FIRST failure — retrying cannot succeed (BR#4403 retry law)", () => {
    // the observed incident class: done-open-children
    expect(trainLandedCloseEdge({ breach_class: "gate:open-children", failures: 1, bound_exceeded: false })).toEqual({ edge: "bounce", bound_fired: false });
    expect(trainLandedCloseEdge({ breach_class: "gate:separation", failures: 1, bound_exceeded: false })).toEqual({ edge: "bounce", bound_fired: false });
  });

  it("a transient/unknown failure retries the next tick — a storage fault may self-heal", () => {
    expect(trainLandedCloseEdge({ breach_class: "claim_race", failures: 1, bound_exceeded: false })).toEqual({ edge: "retry", bound_fired: false });
    expect(trainLandedCloseEdge({ breach_class: "unclassified", failures: 1, bound_exceeded: false })).toEqual({ edge: "retry", bound_fired: false });
    expect(trainLandedCloseEdge({ breach_class: "unclassified", failures: 2, bound_exceeded: false })).toEqual({ edge: "retry", bound_fired: false });
  });

  it("the retry budget is bounded: 3 consecutive failures bounce even with bound far away", () => {
    expect(trainLandedCloseEdge({ breach_class: "unclassified", failures: 3, bound_exceeded: false })).toEqual({ edge: "bounce", bound_fired: false });
    expect(trainLandedCloseEdge({ breach_class: "claim_race", failures: 5, bound_exceeded: false })).toEqual({ edge: "bounce", bound_fired: false });
  });

  it("the FAIL-CLOSED bound fires on the green branch too — the incident: 60+ min past bound with zero stop arms reachable", () => {
    // first observed failure already past the bound → bounce immediately, honestly named
    expect(trainLandedCloseEdge({ breach_class: "unclassified", failures: 1, bound_exceeded: true })).toEqual({ edge: "bounce", bound_fired: true });
    // a benign race that outlives the bound still terminates (never wedge)
    expect(trainLandedCloseEdge({ breach_class: "claim_race", failures: 1, bound_exceeded: true })).toEqual({ edge: "bounce", bound_fired: true });
  });
});

describe("trainCloseBounceBrief + alarm ask copy (BR#4753)", () => {
  const lane = { repo: "state-vector/bridge", base: "main" };
  const sha = "c".repeat(40);
  const err = "parent BR#3633 still has 1 open child task(s) — finish or close them first (decomposition owns its children)";

  it("the brief says the PR IS MERGED and main GREEN — impl must not re-merge or re-verify", () => {
    const b = trainCloseBounceBrief({ repo: lane.repo, prNumber: 222, mergeSha: sha, gateway: "gw-1", error: err, breachClass: "gate:open-children", boundFired: false, failures: 1 });
    expect(b).toContain("IS MERGED");
    expect(b).toContain("main is GREEN");
    expect(b).toContain("gate:open-children");
    expect(b).toContain(err);
    expect(b).toContain("Do NOT re-merge");
    expect(b).toContain(`https://github.com/${lane.repo}/commit/${sha}`);
  });

  it("the bound-fired variant names the fail-closed bound (BR#3516 §2), not the retry law", () => {
    const b = trainCloseBounceBrief({ repo: lane.repo, prNumber: 222, mergeSha: sha, gateway: "gw-1", error: "storage write failed", breachClass: "unclassified", boundFired: true, failures: 3 });
    expect(b).toContain("Fail-closed bound fired");
    expect(b).not.toContain("cannot succeed on retry");
  });

  it("the alarm title is a per-episode ask: ≤240 chars, ends '?', sha-keyed for dedupe", () => {
    const t = trainCloseFailAskTitle(lane, sha, 222, "gate:open-children", false);
    expect(t.length).toBeLessThanOrEqual(240);
    expect(t.endsWith("?")).toBe(true);
    expect(t).toContain(lane.repo);
    expect(t).toContain(sha.slice(0, 9));
    expect(t).toContain("gate:open-children");
    // same episode (same sha) → identical title (askCreate dedupe); a new
    // merge sha is a new episode (fresh ask)
    expect(trainCloseFailAskTitle(lane, sha, 222, "gate:open-children", false)).toBe(t);
    expect(trainCloseFailAskTitle(lane, "d".repeat(40), 222, "gate:open-children", false)).not.toBe(t);
    const bound = trainCloseFailAskTitle(lane, sha, 222, "unclassified", true);
    expect(bound).toContain("bound fired");
  });

  it("the alarm details carry the whole story: PR, card, gate error, attempts, episode history", () => {
    const d = trainCloseFailAskDetails({ repo: lane.repo, base: "main", prNumber: 222, mergeSha: sha, taskId: "BR#3633", error: err, breachClass: "gate:open-children", boundFired: false, failures: 1, gateway: "gw-1" });
    expect(d).toContain(`https://github.com/${lane.repo}/pull/222`);
    expect(d).toContain("BR#3633");
    expect(d).toContain(err);
    expect(d).toContain("BR#4753");
  });
});

// ---------- burst-drain settle law (BR#4934, decision BR#4932 amends BR#4804) ----------

describe("burst-drain law (BR#4934)", () => {
  it("drainBurstDecision: clean heads drain back-to-back; cap or queue-end settles; red stops instantly", () => {
    // clean heads remain, cap not reached → drain back-to-back
    expect(drainBurstDecision(0, 10, true, false)).toBe("drain");
    expect(drainBurstDecision(9, 10, true, false)).toBe("drain");
    // cap reached → settle on the final merge
    expect(drainBurstDecision(10, 10, true, false)).toBe("settle");
    // queue empty of clean heads → settle even below cap
    expect(drainBurstDecision(3, 10, false, false)).toBe("settle");
    expect(drainBurstDecision(0, 10, false, false)).toBe("settle");
    // cap 0 = unlimited → keep draining
    expect(drainBurstDecision(500, 0, true, false)).toBe("drain");
    // red seen stops the line immediately — never waits for the settle (GH#2261)
    expect(drainBurstDecision(0, 10, true, true)).toBe("stop");
    expect(drainBurstDecision(0, 10, false, true)).toBe("stop");
    expect(drainBurstDecision(500, 0, false, true)).toBe("stop");
  });

  it("parseBurstMax: default on absent/junk; 0 = unlimited; integers pass", () => {
    expect(DEFAULT_BURST_MAX).toBe(10);
    expect(parseBurstMax(undefined)).toBe(10);
    expect(parseBurstMax(null)).toBe(10);
    expect(parseBurstMax("7")).toBe(10); // junk shape → default
    expect(parseBurstMax(7.5)).toBe(10); // non-integer → default
    expect(parseBurstMax(-1)).toBe(10); // negative → default
    expect(parseBurstMax(7)).toBe(7);
    expect(parseBurstMax(0)).toBe(0); // unlimited
  });

  it("laneOfMeta parses burst_max off meta.lane; wrong shape still fails loud (null)", () => {
    expect(laneOfMeta({ lane: { repo: "state-vector/bridge", base: "main", burst_max: 3 } })).toMatchObject({
      repo: "state-vector/bridge",
      base: "main",
      burst_max: 3,
    });
    // absent burst_max → DEFAULT (never a guessed 0)
    expect(laneOfMeta({ lane: { repo: "r", base: "main" } })?.burst_max).toBe(DEFAULT_BURST_MAX);
    // junk burst_max → DEFAULT
    expect(laneOfMeta({ lane: { repo: "r", base: "main", burst_max: "lots" } })?.burst_max).toBe(DEFAULT_BURST_MAX);
    expect(laneOfMeta({ lane: { repo: "r", base: "main", burst_max: 0 } })?.burst_max).toBe(0);
    expect(laneOfMeta({})).toBeNull();
    expect(laneOfMeta({ lane: { repo: "", base: "main" } })).toBeNull();
  });

  it("laneCardBody carries the burst line: cap named (or unlimited), one settle, red stops, bisect names one culprit", () => {
    const cfg = { alarm_sink: "sink" };
    const capped = laneCardBody({ repo: "r", base: "main", required_workflows: [], burst_max: 4 }, cfg);
    expect(capped).toContain("up to 4 gate-clean heads");
    expect(capped).toContain("ONE settle wait");
    expect(capped).toContain("ONE culprit");
    const unlimited = laneCardBody({ repo: "r", base: "main", required_workflows: [], burst_max: 0 }, cfg);
    expect(unlimited).toContain("up to unlimited gate-clean heads");
    const def = laneCardBody({ repo: "r", base: "main", required_workflows: [], burst_max: DEFAULT_BURST_MAX }, cfg);
    expect(def).toContain(`up to ${DEFAULT_BURST_MAX} gate-clean heads`);
  });

  it("firstRedIndex: the OLDEST red names the culprit; null when the whole pass is green", () => {
    expect(firstRedIndex([false, false, false])).toBeNull();
    expect(firstRedIndex([false, true, false, true])).toBe(1);
    expect(firstRedIndex([true])).toBe(0);
    expect(firstRedIndex([])).toBeNull();
  });
});

// ---------- batch-merge selection law (BR#4996, Ray ruling 2026-10-29) ----------

describe("batch-merge law (BR#4996)", () => {
  it("selectBatch: maximal mutually non-conflicting set, queue order = landing order", () => {
    // 0 conflicts with 2: the batch is [0, 1]; 2 waits for the next pass
    expect(selectBatch([true, true, true], [[0, 2]], 0)).toEqual([0, 1]);
    // chain 0+1 conflict, 1+2 conflict: only 1 is skipped — [0, 2] land together
    // (conflicts are checked against SELECTED heads only)
    expect(selectBatch([true, true, true], [[0, 1], [1, 2]], 0)).toEqual([0, 2]);
    // both pair orientations are checked
    expect(selectBatch([true, true, true], [[2, 0]], 0)).toEqual([0, 1]);
  });

  it("selectBatch: cap binds; cap 0 is unlimited", () => {
    expect(selectBatch([true, true, true], [], 2)).toEqual([0, 1]);
    expect(selectBatch([true, true, true], [], 0)).toEqual([0, 1, 2]);
    expect(selectBatch([true], [], 0)).toEqual([0]);
    expect(selectBatch([], [], 0)).toEqual([]);
  });

  it("selectBatch: fail-closed — not-known-clean excludes just that member", () => {
    expect(selectBatch([false, true, true], [], 0)).toEqual([1, 2]);
    expect(selectBatch([false, false, false], [], 0)).toEqual([]);
    // an excluded member shields nothing: conflicts are vs SELECTED only
    expect(selectBatch([false, true], [[0, 1]], 0)).toEqual([1]);
  });

  it("conflictsFromFileSets: pairwise set intersection; empty set conflicts with nothing", () => {
    expect(conflictsFromFileSets([new Set(["a.rs", "b.ts"]), new Set(["c.rs"]), new Set(["b.ts", "d.md"])])).toEqual([[0, 2]]);
    expect(conflictsFromFileSets([new Set(["a.rs"]), new Set(["b.rs"])])).toEqual([]);
    expect(conflictsFromFileSets([new Set<string>(), new Set(["a.rs"])])).toEqual([]);
  });

  it("laneCardBody names the batch law: mutually non-conflicting members, one settle, conflicts wait", () => {
    const body = laneCardBody({ repo: "r", base: "main", required_workflows: [], burst_max: 4 }, { alarm_sink: "sink" });
    expect(body).toContain("MUTUALLY non-conflicting");
    expect(body).toContain("BR#4996");
    expect(body).toContain("waits for the next pass");
  });
});

// ---------- BR#5674 P1 + P4: empty-is-loud + starvation ask/duty copy ----------

describe("BR#5674 P1 + P4 — empty-is-loud base classifier + starvation ask/duty builders", () => {
  const run = (id: number, name: string, conclusion: string | null = "success"): MainCheckRun => ({
    id,
    name,
    status: conclusion ? "completed" : "in_progress",
    conclusion,
  });

  it("P1 classifyBaseCheckRuns: distinguishes N runs with 0 required matches from 0 total runs", () => {
    const tip = [run(1, "Product surface canary (dev)"), run(2, "Nightly Release")];
    const unmatched = classifyBaseCheckRuns(tip, ["deploy / Deploy to dev"]);
    expect(unmatched.verdict).toBe("empty");
    expect(unmatched.alarm).toBe("2 runs read, none matched required set — check names/pagination");

    const zero = classifyBaseCheckRuns([], ["deploy / Deploy to dev"]);
    expect(zero.verdict).toBe("empty");
    expect(zero.alarm).toBe("tip carries no check runs at all");

    const matched = classifyBaseCheckRuns([...tip, run(3, "deploy / Deploy to dev", "success")], ["deploy / Deploy to dev"]);
    expect(matched.verdict).toBe("green");
    expect(matched.alarm).toBeUndefined();
  });

  it("BR#5883 classifyBaseCheckRuns: a scoped GREEN on a tip the repo gate judges non-green carries the gate qualifier — verdict stays green, the qualifier names what main-green-gate.sh would report", () => {
    // the 2026-11-03 starve shape: merge-commit tip, required `main-green
    // gate` vacuous (BR#5847), non-required `Deploy drift alarm` FAILED
    const tip = [
      run(1, "Test"),
      run(2, "CLI build (packages/cli)"),
      run(3, "Deploy drift alarm", "failure"),
    ];
    const required = ["Test", "CLI build (packages/cli)", "main-green gate"];
    const v = classifyBaseCheckRuns(tip, required);
    expect(v.verdict).toBe("green");
    expect(v.gate).toBeTruthy();
    expect(v.gate?.verdict).toBe("red");
    expect(v.gate?.red.map((r) => r.name)).toEqual(["Deploy drift alarm"]);
    // in-flight non-required check → the gate refuses unsettled too
    const unsettled = classifyBaseCheckRuns([run(1, "Test"), run(2, "Deploy health (merge gate)", null)], ["Test", "main-green gate"]);
    expect(unsettled.verdict).toBe("green");
    expect(unsettled.gate?.verdict).toBe("unsettled");
    // fully green tip → no qualifier
    const allGreen = classifyBaseCheckRuns([run(1, "Test"), run(2, "Deploy drift alarm")], ["Test", "main-green gate"]);
    expect(allGreen.verdict).toBe("green");
    expect(allGreen.gate).toBeUndefined();
    // scoped red → the verdict itself speaks; no qualifier
    const scopedRed = classifyBaseCheckRuns([run(1, "Test", "failure")], ["Test", "main-green gate"]);
    expect(scopedRed.verdict).toBe("red");
    expect(scopedRed.gate).toBeUndefined();
  });

  it("P4 trainStarvationAskTitle + details + duty builders hold the ask contract and carry full diagnosis", () => {
    expect(TRAIN_MERGE_STARVE_MS).toBe(60 * MIN);
    const lane = { repo: "state-vector/superpositional", base: "main" };
    const title = trainStarvationAskTitle(lane);
    expect(title.length).toBeLessThanOrEqual(240);
    expect(title.endsWith("?")).toBe(true);
    expect(title).toBe(trainStarvationAskTitle(lane));

    const diag = {
      lane,
      laneId: "BR#3637",
      blockedReason: "merge-train: BLOCKED — base main carries none of the lane's required workflow runs (30 runs read, none matched required set — check names/pagination) — 3 car(s) held",
      baseVerdict: "empty",
      requiredWorkflows: ["deploy / Deploy to dev", "post-deploy / Post-Deploy Smoke"],
      redNames: [],
      unsettledNames: [],
      baseAlarm: "30 runs read, none matched required set — check names/pagination",
      queue: [{ id: "BR#5422", pr: 2692 }, { id: "BR#5421", pr: 2693 }],
      awaiting: [{ task: "BR#4711", pr: 2518 }],
      lastMergeTs: 1793627633028,
      mins: 636,
      dutyId: "BR#5999",
    };
    const details = trainStarvationAskDetails(diag);
    expect(details).toContain("30 runs read, none matched required set — check names/pagination");
    expect(details).toContain("2 queued");
    expect(details).toContain("1 awaiting");
    expect(details).toContain("1793627633028");
    expect(details).toContain("BR#5999");

    const dutyTitle = trainStarvationDutyTitle(lane, 2, 1);
    expect(dutyTitle.length).toBeLessThanOrEqual(240);
    const dutyBody = trainStarvationDutyBody(diag);
    expect(dutyBody).toContain("per_page");
    expect(dutyBody).toContain("required_workflows");
    expect(dutyBody).toContain("Verify pool depth");
    expect(dutyBody).toContain("Park exits");
  });

  it("partitionMergeBatches orders ready cars ahead of verifying and waiting cars (non-FIFO readiness priority)", () => {
    const cars = [
      { id: "BR#1", pr: 101, state: "verifying" as const },
      { id: "BR#2", pr: 102, state: "waiting" as const },
      { id: "BR#3", pr: 103, state: "ready" as const },
      { id: "BR#4", pr: 104, state: "verifying" as const },
      { id: "BR#5", pr: 105, state: "ready" as const },
    ];
    const batches = partitionMergeBatches(cars, [[103, 101]], 3);
    // Batch 1 gets both ready cars (103, 105) first, plus non-conflicting verifying car (104)
    expect(batches[0].map((c) => ({ pr: c.pr, state: c.state }))).toEqual([
      { pr: 103, state: "ready" },
      { pr: 105, state: "ready" },
      { pr: 104, state: "verifying" },
    ]);
    // Batch 2 gets verifying car 101 (conflicted with 103) and waiting car 102
    expect(batches[1].map((c) => ({ pr: c.pr, state: c.state }))).toEqual([
      { pr: 101, state: "verifying" },
      { pr: 102, state: "waiting" },
    ]);
  });

  it("decideTrainGate self-heals stale main-green gate reds on a green base via rerun_gate", () => {
    const head = "d".repeat(40);
    const gate = decideTrainGate({
      prNumber: 377,
      headSha: head,
      cardMeta: { prs: [{ repo: "state-vector/bridge", number: 377, head_sha_at_acceptance: head }] },
      cardStatus: "blocked",
      baseVerdict: "green",
      mergeable: true,
      mergeStateStatus: "behind",
      commits: [{ sha: head, verified: true }],
      headChecks: [
        { id: 10, name: "main-green gate", status: "completed", conclusion: "failure" },
        { id: 11, name: "Test", status: "completed", conclusion: "success" },
      ],
    });
    expect(gate.kind).toBe("rerun_gate");
  });

  it("BR#6012 state machine: CandidateGatePhase & BaseRedEpisodeState make illegal transitions unrepresentable", () => {
    const head = "e".repeat(40);
    // 1. A conflicting PR (mergeable: false) ALWAYS classifies as phase:'conflicting' -> bounce(conflict),
    //    even if mergeStateStatus is 'blocked' and baseVerdict is 'green' with a stale deploy-health red
    const conflictInput = {
      prNumber: 2800,
      headSha: head,
      cardMeta: { prs: [{ repo: "state-vector/superpositional", number: 2800, head_sha_at_acceptance: head }] },
      cardStatus: "blocked",
      baseVerdict: "green" as const,
      mergeable: false,
      mergeStateStatus: "blocked",
      commits: [{ sha: head, verified: true }],
      headChecks: [{ id: 1, name: "Deploy health (merge gate)", status: "completed", conclusion: "failure" }],
    };
    expect(classifyCandidateGatePhase(conflictInput)).toEqual({ phase: "conflicting" });
    const conflictDecision = decideTrainGate(conflictInput);
    expect(conflictDecision.kind).toBe("bounce");
    if (conflictDecision.kind === "bounce") {
      expect(conflictDecision.bounceKind).toBe("conflict");
    }

    // 2. isBaseCureCardTitle rejects generic product bugfix titles (`fix(chat): ...`) and accepts base/CI/deploy cures
    expect(isBaseCureCardTitle("Trace: superpositional PR #2555 — fix(chat): classifier propagates total LLM failure (BR#2985)")).toBe(false);
    expect(isBaseCureCardTitle("fix(web): dashboard crash")).toBe(false);
    expect(isBaseCureCardTitle("fix(ci): main-green gate structurally self-failing")).toBe(true);
    expect(isBaseCureCardTitle("fix(deploy): make the mutation-runner ram pin satisfiable (BR#5955)")).toBe(true);

    // 3. Agent-filed root-blocker card (hyphen tag + main_tip + pr.repo) qualifies under isRootFixCard
    expect(
      isRootFixCard({
        tags: ["root-blocker", "main-red"],
        meta: { main_tip: "8454ae7bb", pr: { repo: "state-vector/superpositional", number: 2800 } },
      }),
    ).toBe(true);
    // 3b. BR#6390: the BASE-FIX card shape (BR#6378) — tip_sha + meta.repo +
    // root_blocker_for_lane, main-red + stop-the-line tags, NO root_blocker
    // tag — QUALIFIES under isRootFixCard too (BR#6390: a lane base-fix is a
    // human-gate carrier exactly like a root-fix card) and isLaneBaseFixCard
    // additionally binds it to its lane via mainRedBinding
    expect(
      isRootFixCard({
        tags: ["main-red", "merge-train", "stop-the-line", "cortex", "p0"],
        meta: { repo: "state-vector/superpositional", tip_sha: "2c2a6ae5e217adc0fdc73de3774b46e7aa938879", root_blocker_for_lane: "state-vector/superpositional@main" },
      }),
    ).toBe(true); // the lane's base-fix carries the human gate too
    // a card WITHOUT any binding marker stays a non-root card
    expect(
      isRootFixCard({
        tags: ["main-red", "merge-train", "stop-the-line", "p0"],
        meta: { repo: "state-vector/superpositional", tip_sha: "2c2a6ae5e217adc0fdc73de3774b46e7aa938879" },
      }),
    ).toBe(false); // names no root_blocker/root_blocker_for_lane — binding is mandatory
    expect(
      isLaneBaseFixCard(
        {
          tags: ["main-red", "merge-train", "stop-the-line", "cortex", "p0"],
          meta: { repo: "state-vector/superpositional", tip_sha: "2c2a6ae5e217adc0fdc73de3774b46e7aa938879", root_blocker_for_lane: "state-vector/superpositional@main" },
        },
        "state-vector/superpositional",
      ),
    ).toBe(true);
    expect(
      isLaneBaseFixCard(
        {
          tags: ["main-red", "merge-train", "stop-the-line", "cortex", "p0"],
          meta: { repo: "state-vector/superpositional", tip_sha: "2c2a6ae5e217adc0fdc73de3774b46e7aa938879", root_blocker_for_lane: "state-vector/superpositional@main" },
        },
        "state-vector/bridge",
      ),
    ).toBe(false); // another repo's lane must not adopt it
    expect(mainRedBinding({ repo: "state-vector/superpositional", tip_sha: "2c2a6ae5e217adc0fdc73de3774b46e7aa938879" })).toEqual({
      repo: "state-vector/superpositional",
      head_sha: "2c2a6ae5e217adc0fdc73de3774b46e7aa938879",
    });

    // 4. BaseRedEpisodeState: conflicting PR never warrants a human ask; valid cure PR produces `--admin` command + why
    const conflictingEp = classifyBaseRedEpisodeState({
      card: { id: "BR#5955", title: "ROOT BLOCKER: deploy red", status: "blocked" },
      curePr: null,
      conflictPr: { repo: "state-vector/superpositional", number: 2800 },
    });
    expect(conflictingEp.phase).toBe("cure_pr_conflicting");
    expect(conflictingEp.warrantAsk).toBe(false);
    expect(trainBaseRedAskWarranted({ card: { id: "BR#5955" }, curePr: null, conflictPr: { repo: "state-vector/superpositional", number: 2800 } })).toBe(false);

    const readyEp = classifyBaseRedEpisodeState({
      card: { id: "BR#5968", title: "ROOT-FIX: deploy red", status: "blocked" },
      curePr: { repo: "state-vector/superpositional", number: 2800 },
      conflictPr: null,
    });
    expect(readyEp.phase).toBe("cure_pr_awaiting_force_merge");
    expect(readyEp.warrantAsk).toBe(true);
    if (readyEp.phase === "cure_pr_awaiting_force_merge") {
      expect(readyEp.command).toBe("gh pr merge 2800 --repo state-vector/superpositional --admin --squash");
    }
    const brief = trainBaseRedAskBrief(
      { repo: "state-vector/superpositional", base: "main" },
      [{ name: "deploy / Deploy to dev", url: "https://example.test/run" }],
      11,
      { card: { id: "BR#5968", title: "ROOT-FIX", status: "blocked" }, curePr: { repo: "state-vector/superpositional", number: 2800 }, culpritPr: 2612 },
    );
    // BR#6390: the cure-bound ask is a HUMAN GATE — do-the-thing + DONE/DECLINE
    expect(brief.details).toContain("HUMAN GATE");
    expect(brief.details).toContain("gh pr merge 2800 --repo state-vector/superpositional --admin --squash");
    expect(brief.details).toContain("https://github.com/state-vector/superpositional/pull/2800");
    expect(brief.details).toContain("11 held PRs drain automatically");
    expect(brief.options).toEqual([
      "DONE — PR #2800 merged",
      "DECLINE — hold the line",
    ]);
  });

  it("BR#6142: workflow-level startup_failure (0 job check-runs) classifies RED in classifyBaseCheckRuns and classifyRequiredRuns", () => {
    const required = [
      "deploy / Deploy to dev",
      "post-deploy / Post-Deploy Smoke",
      "post-deploy / DNS chain (front doors)",
      "post-deploy / Lodestar Storage Health",
    ];
    const runs = [
      { id: 1, name: "drift", status: "completed", conclusion: "success", html_url: "https://example.test/drift" },
      {
        id: 41783432309,
        name: "Deploy Dev",
        status: "completed",
        conclusion: "startup_failure",
        html_url: "https://github.com/state-vector/superpositional/actions/runs/41783432309",
      },
    ];
    const baseV = classifyBaseCheckRuns(runs, required);
    expect(baseV.verdict).toBe("red");
    expect(baseV.red).toEqual([
      {
        name: "Deploy Dev",
        conclusion: "startup_failure",
        url: "https://github.com/state-vector/superpositional/actions/runs/41783432309",
      },
    ]);

    const settleV = classifyRequiredRuns(runs, required, { merged_at: 1000, now: 2000 });
    expect(settleV.verdict).toBe("red");
    expect(settleV.failing).toEqual([
      {
        name: "Deploy Dev",
        conclusion: "startup_failure",
        url: "https://github.com/state-vector/superpositional/actions/runs/41783432309",
      },
    ]);
  });

  it("BR#6179: level-based deploy reconciliation (dark-tip grace, auto-dispatch once per sha, coverage summary, and redundant queued run cancellation)", () => {
    const required = [
      "deploy / Deploy to dev",
      "post-deploy / Post-Deploy Smoke",
      "post-deploy / DNS chain",
      "post-deploy / Lodestar Storage Health",
    ];
    const darkTip = "7f5efec26cc5b715ef0ff42eb8ebbf2da0fc1a6f";
    const prevGreenTip = "ebbe182633c5351f5bcbc9cd6d4924659bd604a2";
    const emptyVerdict = classifyBaseCheckRuns([], required);
    expect(emptyVerdict.verdict).toBe("empty");

    // 1. Deploy Health Record (2026-11-04 08:19:23Z receipt) is NOT a covering deploy workflow
    const wfRunsWithDhr: DeployWorkflowRun[] = [
      {
        id: 41791923312,
        name: "Deploy Health Record",
        path: ".github/workflows/deploy-health.yml",
        head_sha: darkTip,
        event: "schedule",
        status: "completed",
        conclusion: "success",
      },
      {
        id: 41780000001,
        name: "Deploy Dev",
        path: ".github/workflows/deploy-dev.yml",
        head_sha: prevGreenTip,
        event: "push",
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/state-vector/superpositional/actions/runs/41780000001",
      },
    ];
    expect(isDeployWorkflowRun(wfRunsWithDhr[0], required)).toBe(false);
    expect(isDeployWorkflowRun(wfRunsWithDhr[1], required)).toBe(true);
    expect(inferDeployWorkflow(required, wfRunsWithDhr)).toBe("deploy-dev.yml");
    expect(inferDeployWorkflow(required, [])).toBe("deploy-dev.yml");

    // 2. Inside grace window (age 120s < 300s): uncovered_grace, no dispatch yet
    const planGrace = reconcileDeployCoverage({
      tipSha: darkTip,
      tipAgeSecs: 120,
      graceSecs: DEPLOY_RECONCILE_GRACE_SECS,
      baseVerdict: emptyVerdict,
      required,
      workflowRuns: wfRunsWithDhr,
    });
    expect(planGrace.dispatch_workflow).toBeNull();
    expect(planGrace.covered_by_sha).toBe(prevGreenTip);
    expect(planGrace.coverage.phase).toBe("uncovered_grace");
    expect(formatDeployCoverageSummary(planGrace.coverage)).toBe("tip 7f5efec2 not covered by any deploy (age 2m, grace 5m)");

    // 3. Past grace window (age 1020s = 17m >= 300s) and not yet dispatched:
    //    uncovered_dark + dispatch_workflow = "deploy-dev.yml"
    const planDark = reconcileDeployCoverage({
      tipSha: darkTip,
      tipAgeSecs: 1020,
      graceSecs: DEPLOY_RECONCILE_GRACE_SECS,
      baseVerdict: emptyVerdict,
      required,
      workflowRuns: wfRunsWithDhr,
    });
    expect(planDark.dispatch_workflow).toBe("deploy-dev.yml");
    expect(planDark.covered_by_sha).toBe(prevGreenTip);
    expect(planDark.coverage_age_secs).toBe(1020);
    expect(planDark.coverage.phase).toBe("uncovered_dark");
    expect(formatDeployCoverageSummary(planDark.coverage)).toBe(
      "tip 7f5efec2 not covered by any deploy (age 17m) — last green deploy ebbe1826",
    );

    // 4. Once dispatched for this SHA (`alreadyDispatchedAt` set):
    //    uncovered_dispatched + dispatch_workflow = null (idempotent once-per-sha guard)
    const planDispatched = reconcileDeployCoverage({
      tipSha: darkTip,
      tipAgeSecs: 1020,
      graceSecs: DEPLOY_RECONCILE_GRACE_SECS,
      baseVerdict: emptyVerdict,
      required,
      workflowRuns: wfRunsWithDhr,
      alreadyDispatchedAt: 1793780527000,
    });
    expect(planDispatched.dispatch_workflow).toBeNull();
    expect(planDispatched.coverage.phase).toBe("uncovered_dispatched");
    expect(formatDeployCoverageSummary(planDispatched.coverage)).toBe(
      "tip 7f5efec2 not covered by any deploy (age 17m) — auto-dispatched deploy-dev.yml",
    );

    // 5. Fast-page ask title + brief contract (Leg C)
    const askTitle = trainDarkTipAskTitle({ repo: "state-vector/superpositional", base: "main" }, darkTip);
    expect(askTitle).toBe("MERGE TRAIN DARK TIP: state-vector/superpositional@main — tip 7f5efec2 not covered by any deploy run. Remedy?");
    expect(askTitle.length).toBeLessThanOrEqual(240);
    expect(askTitle.endsWith("?")).toBe(true);
    const brief = trainDarkTipAskBrief({
      lane: { repo: "state-vector/superpositional", base: "main" },
      held: 18,
      alarm: "tip carries no check runs at all",
      coverage: planDispatched.coverage,
    });
    expect(brief.options[0].startsWith("(Recommended)")).toBe(true);
    expect(brief.details).toContain("tip 7f5efec2 not covered by any deploy (age 17m) — auto-dispatched deploy-dev.yml");

    // 6. Redundant queued run cancellation (Leg D, exact 2026-11-04 08:22 receipt):
    //    workflow_dispatch 41798951196 is in_progress while push 41798949143 is queued on the same sha
    const wfRunsRedundant: DeployWorkflowRun[] = [
      {
        id: 41798951196,
        name: "Deploy Dev",
        path: ".github/workflows/deploy-dev.yml",
        head_sha: prevGreenTip,
        event: "workflow_dispatch",
        status: "in_progress",
      },
      {
        id: 41798949143,
        name: "Deploy Dev",
        path: ".github/workflows/deploy-dev.yml",
        head_sha: prevGreenTip,
        event: "push",
        status: "queued",
      },
    ];
    const unsettledVerdict = classifyBaseCheckRuns(
      [{ id: 1, name: "deploy / Deploy to dev", status: "in_progress", conclusion: null }],
      required,
    );
    const planSettling = reconcileDeployCoverage({
      tipSha: prevGreenTip,
      tipAgeSecs: 30,
      graceSecs: DEPLOY_RECONCILE_GRACE_SECS,
      baseVerdict: unsettledVerdict,
      required,
      workflowRuns: wfRunsRedundant,
    });
    expect(planSettling.cancel_run_ids).toEqual([41798949143]);
    expect(planSettling.dispatch_workflow).toBeNull();
    expect(planSettling.coverage.phase).toBe("settling");

    // 7. ISO-8601 parser parity with Rust
    expect(parseIso8601EpochMs("2026-11-04T08:01:57Z")).toBe(1_793_779_317_000);
    expect(parseIso8601EpochMs("invalid")).toBeNull();
  });
});
