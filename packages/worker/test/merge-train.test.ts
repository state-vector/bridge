import { describe, expect, it } from "vitest";
import {
  carryAppend,
  carryAppendLeg,
  classifyRequiredRuns,
  decideMergeAction,
  decideTrainGate,
  isTrainGateRejection,
  landedClosePolicy,
  leaseDecide,
  mergeTrainQueue,
  normalizeGhMergeable,
  normalizeGhMergeState,
  progressVerdict,
  renewProgressDecide,
  trainBounceBrief,
  resolveTrainBounceKind,
  trainCardMatchesLane,
  trainLandedCloseNote,
  trainLegLanded,
  trainLegs,
  trainLegsRemaining,
  trainParseNoteLegs,
  trainQueueRemainingReason,
  trainStopAskTitle,
  trainReviewAskTitle,
  trainReviewAskDetails,
  verdictCoversHead,
  verdictCoversHeadLeg,
  TRAIN_CI_BOUND_MULTIPLIER,
  TRAIN_CI_TYPICAL_MINUTES,
  TRAIN_HEAD_STAMP_RE,
  TRAIN_LEASE_TTL_MS,
  TRAIN_PROGRESS_STALE_MS,
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

  it("CRITICAL (meta.boosted) first, FIFO within class by blocked-since", () => {
    const q = mergeTrainQueue([
      card("N1", 10, "merge-train: queued"),
      card("C2", 30, "merge-train: queued", true),
      card("N2", 20, "merge-train: queued"),
      card("C1", 40, "merge-train: queued", true),
    ]);
    expect(q.map((x) => x.id)).toEqual(["C2", "C1", "N1", "N2"]);
    expect(q[0].priority).toBe("critical");
    expect(q[2].priority).toBe("normal");
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

  it("trainReviewAskTitle dedupes per (card, PR) — stable across re-bounces, carries the For Me phrasing, holds the ask contract (BR#4068)", () => {
    const t = trainReviewAskTitle({ repo: "state-vector/bridge" }, 2476, "BR#257");
    expect(t).toContain("Review requested");
    expect(t).toContain("one click from landed");
    expect(t).toContain("bridge#2476");
    expect(t).toContain("(BR#257)");
    expect(t.endsWith("?")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(240);
    // the dedupe key: identical per (card, PR) so the identical-open-ask
    // guard collapses re-bounces of the same leg onto the live ask
    expect(trainReviewAskTitle({ repo: "state-vector/bridge" }, 2476, "BR#257")).toBe(t);
    // a different leg is a different ask
    expect(trainReviewAskTitle({ repo: "state-vector/bridge" }, 2477, "BR#257")).not.toBe(t);
  });

  it("trainReviewAskDetails names the lapse law and the live leg; no file list → say so honestly (BR#4068)", () => {
    const d = trainReviewAskDetails({ repo: "state-vector/bridge", prNumber: 2476, taskId: "BR#257", headSha: "b".repeat(40), conflictFiles: ["src/a.ts"] });
    expect(d).toContain("dismissed the stale GitHub review");
    expect(d).toContain("priority 0");
    expect(d).toContain("- `src/a.ts`");
    expect(d).toContain("github.com/state-vector/bridge/pull/2476");
    const bare = trainReviewAskDetails({ repo: "r", prNumber: 1, taskId: "BR#1", headSha: null, conflictFiles: [] });
    expect(bare).toContain("the executor enumerates them on the trial rebase");
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

// ---------- BR#4753: the landed-close failure policy ----------

describe("landed-close failure policy (BR#4753 — the green branch resolves)", () => {
  it("a gate rejection is SEMANTIC and bounces NOW — every BR#4403 marker class matches", () => {
    // the observed BR#3633 rejection (the gate error text + the [rule:] tag)
    expect(isTrainGateRejection(new Error("parent BR#3633 still has 1 open child task(s) — finish or close them first (decomposition owns its children). If a child is genuinely unclosable, force-close grammar. [rule: done-open-children]"))).toBe(true);
    // receipt-gate rejections ride the [rule: …] tag
    expect(isTrainGateRejection(new Error("done close cites legs not receipted: state-vector/bridge#222 — [rule: done-close-legs]"))).toBe(true);
    expect(isTrainGateRejection(new Error("the in_review transition needs a PR link [rule: review-needs-pr]"))).toBe(true);
    // the other BR#4403 protocol-card classes
    expect(isTrainGateRejection(new Error("gate:review-needs-pr — re-entry note carries no PR link"))).toBe(true);
    expect(isTrainGateRejection(new Error("separation of duties: the session that implemented cannot produce the review"))).toBe(true);
    expect(isTrainGateRejection(new Error("malformed await_event condition — two machine atoms"))).toBe(true);
    expect(isTrainGateRejection(new Error("task: 'blocked' → 'done' not allowed (allowed: in_progress, todo, superseded)"))).toBe(true);
    expect(isTrainGateRejection(new Error("this close requires the review receipts"))).toBe(true);
  });

  it("a storage / infra fault is RETRYABLE — none of the gate markers match", () => {
    expect(isTrainGateRejection(new Error("Storage unit of work failed: Durable Object reset"))).toBe(false);
    expect(isTrainGateRejection(new Error("internal error"))).toBe(false);
    expect(isTrainGateRejection(null)).toBe(false);
    expect(isTrainGateRejection(undefined)).toBe(false);
  });

  it("the policy matrix: bounce on gate; retry inside the budget; stop at the budget or past the bound", () => {
    expect(landedClosePolicy({ gateRejection: true, failures: 1, boundExceeded: false })).toBe("bounce");
    expect(landedClosePolicy({ gateRejection: true, failures: 5, boundExceeded: true })).toBe("bounce");
    expect(landedClosePolicy({ gateRejection: false, failures: 1, boundExceeded: false })).toBe("retry");
    expect(landedClosePolicy({ gateRejection: false, failures: 2, boundExceeded: false })).toBe("retry");
    expect(landedClosePolicy({ gateRejection: false, failures: 3, boundExceeded: false })).toBe("stop");
    expect(landedClosePolicy({ gateRejection: false, failures: 4, boundExceeded: false })).toBe("stop");
    // bound_exceeded shortens the retry window — the BR#3633 bound-never-armed defect
    expect(landedClosePolicy({ gateRejection: false, failures: 1, boundExceeded: true })).toBe("stop");
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
    // uppercase behind PRE-CLEARS at the train gate (BR#3727 — the §5 carry
    // is reachable; supersedes this block's original "BEHIND bounces naming
    // behind" pin: the shared decideMergeAction still bounces behind, and
    // the BR#3727 describe below pins that).
    expect(decideTrainGate(gh("MERGEABLE", "BEHIND")).kind).toBe("merge");
    // UNSTABLE stays within the gate's allowance (uppercase in, allowed out)
    expect(decideTrainGate(gh("MERGEABLE", "UNSTABLE")).kind).toBe("merge");
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
