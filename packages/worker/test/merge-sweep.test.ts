import { describe, expect, it } from "vitest";
import {
  classifyHeadChecks,
  decideMergeAction,
  isExemptCheckName,
  mergeSweepHumanLegTitle,
  type MainCheckRun,
  type MergeCandidateInput,
} from "../src/kb/core.ts";

/**
 * Standing merge-queue sweeper (BR#3198) guards.
 *
 * Tier 1 here: the pure decision rules pinned case by case —
 *   - classifyHeadChecks: the head side of the 5c gate, with BR#2267
 *     externals pulled OUT of red (they are the human leg, never gating);
 *   - decideMergeAction: the standing order's decision table (superseded
 *     first, then mergeable/clean, then signatures, then base green, then
 *     head green, then verify lineage, then merge);
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

  it("mergeable=false (conflicts) -> mechanical BOUNCE with the exact defect", () => {
    const a = decideMergeAction(base({ mergeable: false, mergeStateStatus: "dirty" }));
    expect(a.kind).toBe("bounce");
    if (a.kind === "bounce") expect(a.defect).toContain("unmergeable");
    expect(a.kind === "bounce" && a.defect).toContain("Rebase");
  });

  it("mergeable=null (GitHub still computing) -> skip, not yet", () => {
    const a = decideMergeAction(base({ mergeable: null }));
    expect(a.kind).toBe("skip");
    if (a.kind === "skip") expect(a.reason).toContain("computing");
  });

  it("mergeStateStatus not clean/unstable -> mechanical bounce naming the state", () => {
    const a = decideMergeAction(base({ mergeStateStatus: "blocked" }));
    expect(a.kind).toBe("bounce");
    if (a.kind === "bounce") expect(a.defect).toContain("blocked");
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

  it("head substance check RED -> bounce when the card is in_review", () => {
    const a = decideMergeAction(base({ headChecks: [run(1, "Test", "failure")] }));
    expect(a.kind).toBe("bounce");
    if (a.kind === "bounce") expect(a.defect).toContain("Test");
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

  it("head moved past the accepted verify verdict (card in_review) -> bounce to re-verify", () => {
    const a = decideMergeAction(base({ verifyAcceptedOnHead: false }));
    expect(a.kind).toBe("bounce");
    if (a.kind === "bounce") {
      expect(a.defect).toContain(SHA.slice(0, 9));
      expect(a.defect).toContain("re-verify");
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
