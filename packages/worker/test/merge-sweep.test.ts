import { describe, expect, it } from "vitest";
import {
  classifyHeadChecks,
  decideMergeAction,
  decidePrDisposition,
  isExemptCheckName,
  mergeSweepHumanLegTitle,
  prEscalationAskTitle,
  type MainCheckRun,
  type MergeAction,
  type MergeCandidateInput,
  type PrDispositionInput,
} from "../src/kb/core.ts";

/**
 * Standing merge-queue sweeper (BR#3198) + PR disposition law (BR#3312)
 * guards.
 *
 * Tier 1 here: the pure decision rules pinned case by case —
 *   - classifyHeadChecks: the head side of the 5c gate, with BR#2267
 *     externals pulled OUT of red (they are the human leg, never gating);
 *   - decideMergeAction: the standing order's decision table (superseded
 *     first, then mergeable/clean, then signatures, then base green, then
 *     head green, then verify lineage, then merge);
 *   - decidePrDisposition (BR#3315): the PR terminal-state law — card-terminal
 *     closes first, then the merge leg, then the orphan clock, then the stale
 *     clocks (escalate once, close on expired silence), then the bounce;
 *   - prEscalationAskTitle: the deterministic bound escalation ask;
 *   - mergeSweepHumanLegTitle: deterministic ask title (rule 5c — ONE ask per
 *     class per episode, never one per PR).
 *
 * Tier 2 (the scheduled sweep's fetch/act wiring) lives in kb/do.ts and is
 * exercised by the DO drill pattern of stop-line.test.ts.
 */

// ---------- tier 1a: classifyHeadChecks ----------

const run = (id: number, name: string, conclusion: string | null, url = `https://example.com/run/${id}`): MainCheckRun => ({
  id, name, status: conclusion == null ? "in_progress" : "completed", conclusion, html_url: url,
});

describe("isExemptCheckName (BR#2267 externals)", () => {
  it("exempts the workers-builds / Cloudflare mirror class", () => {
    expect(isExemptCheckName("Workers Builds: bridge")).toBe(true);
    expect(isExemptCheckName("workers-builds (dev)")).toBe(true);
    expect(isExemptCheckName("Cloudflare Pages: preview")).toBe(true);
    expect(isExemptCheckName("deploy preview")).toBe(true);
    expect(isExemptCheckName("deploy: production")).toBe(false); // plain deploy is not exempt
  });

  it("never exempts substance checks", () => {
    expect(isExemptCheckName("Test")).toBe(false);
    expect(isExemptCheckName("main-green gate")).toBe(false);
    expect(isExemptCheckName("CLI build")).toBe(false);
    expect(isExemptCheckName("Superpositional")).toBe(false);
  });
});

describe("classifyHeadChecks (the head half of the 5c gate)", () => {
  it("all green -> green", () => {
    const v = classifyHeadChecks([run(1, "Test", "success"), run(2, "CLI build", "success")]);
    expect(v.verdict).toBe("green");
    expect(v.green).toBe(2);
    expect(v.red).toEqual([]);
    expect(v.unsettled).toEqual([]);
    expect(v.external).toEqual([]);
  });

  it("a substance failure is RED", () => {
    const v = classifyHeadChecks([run(1, "Test", "failure", "https://example.com/r1")]);
    expect(v.verdict).toBe("red");
    expect(v.red).toEqual([{ name: "Test", conclusion: "failure", url: "https://example.com/r1" }]);
  });

  it("BR#2267 externals that fail are pulled OUT of red and recorded as external (human leg)", () => {
    const v = classifyHeadChecks([
      run(1, "Test", "success"),
      run(2, "Workers Builds: bridge", "failure", "https://example.com/r2"),
    ]);
    expect(v.verdict).toBe("green");
    expect(v.red).toEqual([]);
    expect(v.external).toEqual([{ name: "Workers Builds: bridge", conclusion: "failure", url: "https://example.com/r2" }]);
    expect(v.green).toBe(1);
  });

  it("null conclusion on a substance check is unsettled — checks still running never vouch", () => {
    const v = classifyHeadChecks([run(1, "Test", null)]);
    expect(v.verdict).toBe("unsettled");
    expect(v.unsettled).toEqual(["Test"]);
  });

  it("null conclusion on an exempt external is silent (it says nothing either way)", () => {
    const v = classifyHeadChecks([run(1, "Workers Builds: bridge", null)]);
    expect(v.verdict).toBe("green");
    expect(v.unsettled).toEqual([]);
    expect(v.external).toEqual([]);
  });

  it("an unknown conclusion is unsettled, never green", () => {
    const v = classifyHeadChecks([run(1, "Test", "weird_conclusion")]);
    expect(v.verdict).toBe("unsettled");
    expect(v.unsettled).toEqual(["Test"]);
  });
});

// ---------- tier 1b: decideMergeAction (the standing order's decision table) ----------

const SHA = "5e73e68c1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";

const base = (over: Partial<MergeCandidateInput> = {}): MergeCandidateInput => ({
  prNumber: 2325,
  prTitle: "BR#2851: fix the thing",
  headSha: SHA,
  baseVerdict: "green",
  mergeable: true,
  mergeStateStatus: "clean",
  commits: [{ sha: SHA, verified: true }],
  headChecks: [run(1, "Test", "success"), run(2, "CLI build", "success")],
  cardStatus: "in_review",
  verifyAcceptedOnHead: true,
  verifyAcceptedAny: true,
  ...over,
});

describe("decideMergeAction — the standing order (BR#3033 + BR#3198)", () => {
  it("all green + verify accepted on head -> MERGE", () => {
    const a = decideMergeAction(base());
    expect(a.kind).toBe("merge");
    if (a.kind === "merge") {
      expect(a.receipt).toContain("PR #2325");
      expect(a.receipt).toContain(SHA.slice(0, 9));
      expect(a.receipt).toContain("verify accepted");
    }
  });

  it("superseded-check FIRST: a superseded card's PR closes before any gate runs", () => {
    const a = decideMergeAction(base({ cardStatus: "superseded", mergeable: false }));
    expect(a.kind).toBe("close_superseded");
  });

  it("a done card's PR is skipped quietly, never re-merged", () => {
    expect(decideMergeAction(base({ cardStatus: "done" })).kind).toBe("skip");
  });

  it("mergeable=false (conflicts) -> mechanical BOUNCE with the exact defect, kind CONFLICT (BR#4066)", () => {
    const a = decideMergeAction(base({ mergeable: false, mergeStateStatus: "dirty" }));
    expect(a.kind).toBe("bounce");
    if (a.kind === "bounce") {
      expect(a.defect).toContain("unmergeable");
      expect(a.bounceKind).toBe("conflict");
    }
    expect(a.kind === "bounce" && a.defect).toContain("Rebase");
  });

  it("mergeable=null (GitHub still computing) -> skip, not yet", () => {
    const a = decideMergeAction(base({ mergeable: null }));
    expect(a.kind).toBe("skip");
    if (a.kind === "skip") expect(a.reason).toContain("computing");
  });

  it("BR#4685: an unanswered mergeStateStatus (null/UNKNOWN) polls — never a bounce, never a merge on an unconfirmed state", () => {
    // the mergeable field rides the same async recomputation, so EVERY shape
    // waits: even a false read beside an unanswered state is a stale read
    // (the 2026-10-28 ledger bounced PRs #279/#281 28× exactly this way),
    // and green-but-unanswered must not merge either (the old null fail-open)
    for (const mergeStateStatus of [null, "", "unknown", "UNKNOWN"]) {
      for (const mergeable of [null, true, false]) {
        const a = decideMergeAction(base({ mergeable, mergeStateStatus }));
        expect(a.kind).toBe("skip");
        if (a.kind === "skip") expect(a.reason).toContain("BR#4685");
      }
    }
  });

  it("mergeStateStatus not clean/unstable -> mechanical bounce naming the state, kind GATE (BR#4066)", () => {
    const a = decideMergeAction(base({ mergeStateStatus: "blocked" }));
    expect(a.kind).toBe("bounce");
    if (a.kind === "bounce") {
      expect(a.defect).toContain("blocked");
      expect(a.bounceKind).toBe("gate");
    }
  });

  it("unsigned commits are the HUMAN LEG, not a mechanical bounce (5c class rule)", () => {
    const a = decideMergeAction(base({ commits: [{ sha: SHA, verified: false }] }));
    expect(a.kind).toBe("human_leg");
    if (a.kind === "human_leg") expect(a.reason).toContain("signing");
  });

  it("base RED -> skip (the stop-the-line sweep owns the alert; never merge onto red main)", () => {
    const a = decideMergeAction(base({ baseVerdict: "red" }));
    expect(a.kind).toBe("skip");
    if (a.kind === "skip") expect(a.reason).toContain("stop-the-line");
  });

  it("base UNSETTLED -> skip too (main in flight does not vouch for main)", () => {
    expect(decideMergeAction(base({ baseVerdict: "unsettled" })).kind).toBe("skip");
    expect(decideMergeAction(base({ baseVerdict: "empty" })).kind).toBe("skip");
  });

  it("head substance check RED -> bounce when the card is in_review, kind GATE (BR#4066)", () => {
    const a = decideMergeAction(base({ headChecks: [run(1, "Test", "failure")] }));
    expect(a.kind).toBe("bounce");
    if (a.kind === "bounce") {
      expect(a.defect).toContain("Test");
      expect(a.bounceKind).toBe("gate");
    }
  });

  it("head substance check RED but card NOT in_review -> note only (the sweep never steals a claim)", () => {
    const a = decideMergeAction(base({ headChecks: [run(1, "Test", "failure")], cardStatus: "in_progress" }));
    expect(a.kind).toBe("note");
  });

  it("head BR#2267 external RED does NOT block the merge (exempt, collected as the human leg)", () => {
    const a = decideMergeAction(base({ headChecks: [run(1, "Test", "success"), run(2, "Workers Builds: bridge", "failure")] }));
    expect(a.kind).toBe("merge");
  });

  it("head checks unsettled -> skip this tick (not yet)", () => {
    const a = decideMergeAction(base({ headChecks: [run(1, "Test", null)] }));
    expect(a.kind).toBe("skip");
    if (a.kind === "skip") expect(a.reason).toContain("unsettled");
  });

  it("head moved past the accepted verify verdict (card in_review) -> bounce to re-verify, kind COVERAGE (BR#4066)", () => {
    const a = decideMergeAction(base({ verifyAcceptedOnHead: false }));
    expect(a.kind).toBe("bounce");
    if (a.kind === "bounce") {
      expect(a.defect).toContain(SHA.slice(0, 9));
      expect(a.defect).toContain("re-verify");
      expect(a.bounceKind).toBe("coverage");
    }
  });

  it("no accepted verify verdict at all -> skip (the verify pool owns the verdict)", () => {
    const a = decideMergeAction(base({ verifyAcceptedAny: false, verifyAcceptedOnHead: false }));
    expect(a.kind).toBe("skip");
    if (a.kind === "skip") expect(a.reason).toContain("verify");
  });

  it("decision order: a conflicted PR on a red base still bounces FIRST (mergeability is a precondition, not a finding)", () => {
    const a = decideMergeAction(base({ mergeable: false, baseVerdict: "red" }));
    expect(a.kind).toBe("bounce");
  });
});

// ---------- tier 1c: the human-leg class ask title ----------

describe("mergeSweepHumanLegTitle (rule 5c — one class ask)", () => {
  it("is deterministic, names the repo and the class, ends in ?", () => {
    const t = mergeSweepHumanLegTitle("state-vector/bridge", ["PR #96 has 3 commit(s) not GitHub-verified — signing environment class, not per-PR"]);
    expect(t).toContain("state-vector/bridge");
    expect(t).toContain("PR #96");
    expect(t.endsWith("?")).toBe(true);
    expect(t).toBe(mergeSweepHumanLegTitle("state-vector/bridge", ["PR #96 has 3 commit(s) not GitHub-verified — signing environment class, not per-PR"]));
  });

  it("stays within the 240-char ask contract and truncates cleanly", () => {
    const many = Array.from({ length: 20 }, (_, i) => `PR #${1000 + i} has unsigned commits — signing environment class`);
    const t = mergeSweepHumanLegTitle("state-vector/bridge", many);
    expect(t.length).toBeLessThanOrEqual(240);
    expect(t.endsWith("?")).toBe(true);
  });
});

// ---------- tier 1d: decidePrDisposition (the PR terminal-state law, BR#3312) ----------
//
// Every open PR lands in exactly ONE disposition per pass: merged, closed with
// a reason, or advancing with a clock. Rows pinned case by case below; the
// order is the law's: card-terminal FIRST, then the existing merge leg, then
// the orphan clock, then the stale clocks, then the existing bounce.

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

const disp = (over: Partial<PrDispositionInput> = {}): PrDispositionInput => ({
  // default gate: a note (card not in_review) — the quiet pre-law arm
  gate: { kind: "note", reason: "PR #7 head check RED: Test — card not in_review, no bounce; the linked session owns it" },
  repo: "state-vector/bridge",
  prNumber: 7,
  now: NOW,
  lastActivityTs: NOW - 1 * DAY, // fresh by default
  cardId: "BR#123",
  cardStatus: "in_progress",
  cardAdvancing: true,
  hasProvenance: true,
  prCreatedAt: NOW - 10 * DAY,
  cardTerminalNote: null,
  escalatedAt: null,
  escalationAskId: null,
  activitySinceEscalation: false,
  prStaleDays: 7,
  prOrphanDays: 3,
  prGraceHours: 48,
  ...over,
});

const gateMerge = (head: string): MergeAction => ({
  kind: "merge",
  receipt: `PR #7 merged by the standing merge sweep (BR#3033): head ${head.slice(0, 9)} — 5c gate pass, verify accepted on head`,
});
const gateBounce = (defect: string, bounceKind: "coverage" | "conflict" | "gate" = "conflict"): MergeAction => ({ kind: "bounce", defect, bounceKind });
const gateSkip = (why: string): MergeAction => ({ kind: "skip", reason: why });
const gateHumanLeg = (why: string): MergeAction => ({ kind: "human_leg", reason: why });

describe("decidePrDisposition — card-terminal rows close immediately", () => {
  it("superseded card closes immediately, citing the card (before any clock or gate)", () => {
    const a = decidePrDisposition(disp({ cardStatus: "superseded", gate: gateMerge("abc123def"), cardTerminalNote: "replaced by BR#456" }));
    expect(a.kind).toBe("close_superseded");
    if (a.kind === "close_superseded") {
      expect(a.reason).toContain("BR#123");
      expect(a.reason).toContain("superseded");
      expect(a.reason).toContain("replaced by BR#456"); // cites successor
    }
  });

  it("a done card's PR now CLOSES with reason (the law supersedes the old quiet skip)", () => {
    const a = decidePrDisposition(disp({ cardStatus: "done", gate: gateSkip("linked card already done — nothing to merge under it") }));
    expect(a.kind).toBe("close_superseded");
    if (a.kind === "close_superseded") expect(a.reason).toContain("done");
  });

  it("a rejected card's PR closes too", () => {
    expect(decidePrDisposition(disp({ cardStatus: "rejected" })).kind).toBe("close_superseded");
  });

  it("card-terminal beats a fully-green MERGE gate (a terminal card's PR is a leftover vehicle, never cargo)", () => {
    const a = decidePrDisposition(disp({ cardStatus: "superseded", gate: gateMerge("abc123def") }));
    expect(a.kind).toBe("close_superseded");
  });

  it("card-terminal beats the orphan and stale clocks (one disposition, the first row wins)", () => {
    const a = decidePrDisposition(disp({
      cardStatus: "superseded",
      lastActivityTs: NOW - 30 * DAY,
      prCreatedAt: NOW - 30 * DAY,
      cardAdvancing: false,
    }));
    expect(a.kind).toBe("close_superseded");
  });
});

describe("decidePrDisposition — the existing legs pass through", () => {
  it("gate MERGE wins over every clock (a green verified PR merges even if timestamps look stale)", () => {
    const a = decidePrDisposition(disp({
      gate: gateMerge("abc123def"),
      lastActivityTs: NOW - 30 * DAY,
      escalatedAt: NOW - 20 * DAY,
      cardAdvancing: false,
    }));
    expect(a.kind).toBe("merge");
    if (a.kind === "merge") expect(a.receipt).toContain("verify accepted");
  });

  it("gate BOUNCE stays the bounce (existing defect text), but only while within its clocks", () => {
    const a = decidePrDisposition(disp({ gate: gateBounce("PR #7 unmergeable — CONFLICTING against base. Rebase, resolve, re-push, re-enter the queue") }));
    expect(a.kind).toBe("bounce");
    if (a.kind === "bounce") expect(a.defect).toContain("CONFLICTING");
  });

  it("skip/human_leg gates pass through untouched when no clock row fires", () => {
    expect(decidePrDisposition(disp({ gate: gateSkip("no accepted verify verdict covering head abc123456") })).kind).toBe("passthrough");
    const hl = decidePrDisposition(disp({ gate: gateHumanLeg("PR #7 has 1 commit(s) not GitHub-verified — signing-environment class, never per-PR") }));
    expect(hl.kind).toBe("passthrough");
  });
});

describe("decidePrDisposition — the orphan clock (BR#3287 no-card signal)", () => {
  it("orphan closes after orphan_days: no BR# ref, no provenance, past pr_orphan_days", () => {
    const a = decidePrDisposition(disp({
      cardId: null, cardStatus: null, hasProvenance: false, cardAdvancing: false,
      prCreatedAt: NOW - 4 * DAY,
    }));
    expect(a.kind).toBe("close_orphan");
    if (a.kind === "close_orphan") {
      expect(a.reason).toContain("no bridge provenance");
      expect(a.reason).toContain("re-open via a card");
    }
  });

  it("a young orphan is left alone — the clock has not expired", () => {
    const a = decidePrDisposition(disp({
      cardId: null, cardStatus: null, hasProvenance: false, cardAdvancing: false,
      prCreatedAt: NOW - 2 * DAY,
    }));
    expect(a.kind).toBe("passthrough");
  });

  it("a linked card is never an orphan, however old (provenance exists)", () => {
    const a = decidePrDisposition(disp({ prCreatedAt: NOW - 40 * DAY, cardAdvancing: false, lastActivityTs: NOW - 1 * DAY }));
    expect(a.kind).not.toBe("close_orphan");
  });

  it("the provenance index row (BR#3287) counts even when the BR# ref was edited away", () => {
    const a = decidePrDisposition(disp({
      cardId: null, cardStatus: null, hasProvenance: true,
      prCreatedAt: NOW - 30 * DAY, lastActivityTs: NOW - 1 * DAY,
    }));
    expect(a.kind).not.toBe("close_orphan");
  });

  it("a dead card ref (card row gone) is orphan signal, not escalate signal", () => {
    const a = decidePrDisposition(disp({
      cardStatus: null, cardAdvancing: false, lastActivityTs: NOW - 8 * DAY,
      prCreatedAt: NOW - 10 * DAY, hasProvenance: false, // the ref resolves to no row, no index entry
    }));
    expect(a.kind).toBe("close_orphan");
  });

  it("unknown creation date fails safe — no orphan close on missing data", () => {
    const a = decidePrDisposition(disp({ cardId: null, cardStatus: null, hasProvenance: false, prCreatedAt: null, cardAdvancing: false }));
    expect(a.kind).toBe("passthrough");
  });
});

describe("decidePrDisposition — the stale clocks (escalate once, close on expired silence)", () => {
  const staleBase = { lastActivityTs: NOW - 8 * DAY, cardAdvancing: false };

  it("stale + card not advancing + no escalation yet -> ESCALATE once (the bound ask)", () => {
    const a = decidePrDisposition(disp(staleBase));
    expect(a.kind).toBe("escalate");
    if (a.kind === "escalate") {
      expect(a.question).toContain("PR #7");
      expect(a.question).toContain("state-vector/bridge");
      expect(a.question).toContain("BR#123");
      expect(a.question).toContain("48h");
      expect(a.question.endsWith("?")).toBe(true);
      expect(a.question.length).toBeLessThanOrEqual(240);
    }
  });

  it("stale + escalated + grace expired + owner silent -> CLOSE_STALE citing the ask id, last activity, revive path", () => {
    const a = decidePrDisposition(disp({
      ...staleBase,
      escalatedAt: NOW - 49 * HOUR,
      escalationAskId: "BR#3401",
    }));
    expect(a.kind).toBe("close_stale");
    if (a.kind === "close_stale") {
      expect(a.reason).toContain("BR#3401"); // the ask id
      expect(a.reason).toContain("revive");
      expect(a.reason).toContain("reopenable");
    }
  });

  it("stale + escalated but grace still open -> no close (the clock is running, not expired)", () => {
    const a = decidePrDisposition(disp({ ...staleBase, escalatedAt: NOW - 2 * HOUR }));
    expect(a.kind).not.toBe("close_stale");
    expect(a.kind).not.toBe("escalate"); // deduped — ONE ask per episode
  });

  it("stale + owner RESPONDED (activity after the escalation) -> does NOT close; the episode resets", () => {
    const a = decidePrDisposition(disp({
      ...staleBase,
      escalatedAt: NOW - 3 * DAY,
      lastActivityTs: NOW - 1 * DAY, // responded long after the escalation
      activitySinceEscalation: true,
    }));
    expect(a.kind).not.toBe("close_stale");
    expect(a.kind).not.toBe("escalate");
  });

  it("an ADVANCING card never closes its PR — even stale, even escalated, even expired", () => {
    const a = decidePrDisposition(disp({
      lastActivityTs: NOW - 8 * DAY,
      cardAdvancing: true, // the card carries the liveness clock
      escalatedAt: NOW - 10 * DAY,
    }));
    expect(a.kind).not.toBe("close_stale");
    expect(a.kind).not.toBe("escalate");
    expect(a.kind).not.toBe("close_orphan");
  });

  it("fresh activity (within pr_stale_days) never escalates and never closes", () => {
    const a = decidePrDisposition(disp({ lastActivityTs: NOW - 6 * DAY - HOUR, cardAdvancing: false }));
    expect(a.kind).toBe("passthrough");
  });

  it("the stale boundary is strict: exactly pr_stale_days old is NOT stale", () => {
    const a = decidePrDisposition(disp({ lastActivityTs: NOW - 7 * DAY, cardAdvancing: false }));
    expect(a.kind).toBe("passthrough");
  });

  it("unknown activity fails safe — no clock row fires on missing data", () => {
    const a = decidePrDisposition(disp({ lastActivityTs: null, cardAdvancing: false }));
    expect(a.kind).toBe("passthrough");
  });

  it("escalation needs a resolvable card to bind the ask — a stale dead-ref PR is not escalated", () => {
    const a = decidePrDisposition(disp({
      ...staleBase,
      cardId: "BR#999", cardStatus: null, // ref in text, row gone
      prCreatedAt: NOW - 2 * DAY, // young — orphan clock not expired yet
    }));
    expect(a.kind).not.toBe("escalate");
  });

  it("a stale PR past grace closes EVEN when the gate wants to bounce (the terminal path wins)", () => {
    const a = decidePrDisposition(disp({
      ...staleBase,
      gate: gateBounce("PR #7 unmergeable — CONFLICTING against base. Rebase, resolve, re-push, re-enter the queue"),
      escalatedAt: NOW - 49 * HOUR,
      escalationAskId: "BR#3402",
    }));
    expect(a.kind).toBe("close_stale");
  });
});

describe("prEscalationAskTitle (the bound escalation ask)", () => {
  it("is deterministic, names repo/PR/card/grace, ends in ?", () => {
    const t = prEscalationAskTitle("state-vector/superpositional", 2325, "BR#2851", 48, 7);
    expect(t).toContain("PR #2325");
    expect(t).toContain("state-vector/superpositional");
    expect(t).toContain("BR#2851");
    expect(t).toContain("48h");
    expect(t.endsWith("?")).toBe(true);
    expect(t).toBe(prEscalationAskTitle("state-vector/superpositional", 2325, "BR#2851", 48, 7));
  });

  it("long repo names never break the 240-char ask contract", () => {
    const t = prEscalationAskTitle("state-vector/a-very-long-repository-name-that-keeps-going", 12345, "BR#123456", 48, 7);
    expect(t.length).toBeLessThanOrEqual(240);
    expect(t.endsWith("?")).toBe(true);
  });
});
