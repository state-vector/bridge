import { describe, expect, it } from "vitest";
import {
  checkLimits,
  ftsQuery,
  formatId,
  idSeq,
  isRelation,
  validateRelation,
  validateTransition,
} from "../src/kb/core.ts";

describe("lifecycles", () => {
  it("task in_progress → in_review → (done | bounce | blocked); bounce returns to work", () => {
    expect(validateTransition("task", "in_progress", "in_review").ok).toBe(true);
    expect(validateTransition("task", "in_review", "done").ok).toBe(true);
    expect(validateTransition("task", "in_review", "in_progress").ok).toBe(true);
    expect(validateTransition("task", "in_review", "blocked").ok).toBe(true);
    expect(validateTransition("task", "todo", "in_review").ok).toBe(false);
    expect(validateTransition("task", "in_review", "superseded").ok).toBe(false);
  });

  it("rfc draft → proposed → accepted → implemented", () => {
    expect(validateTransition("rfc", "draft", "proposed").ok).toBe(true);
    expect(validateTransition("rfc", "proposed", "accepted").ok).toBe(true);
    expect(validateTransition("rfc", "accepted", "implemented").ok).toBe(true);
  });

  it("rfc accepted can be superseded, draft cannot be accepted directly", () => {
    expect(validateTransition("rfc", "accepted", "superseded").ok).toBe(true);
    expect(validateTransition("rfc", "draft", "accepted").ok).toBe(false);
  });

  it("decisions: proposed → accepted → superseded only", () => {
    expect(validateTransition("decision", "proposed", "accepted").ok).toBe(true);
    expect(validateTransition("decision", "accepted", "superseded").ok).toBe(true);
    expect(validateTransition("decision", "accepted", "rejected").ok).toBe(false);
  });

  it("task blocked is recoverable, progress is terminal-at-birth", () => {
    expect(validateTransition("task", "blocked", "in_progress").ok).toBe(true);
    expect(validateTransition("task", "done", "in_progress").ok).toBe(false);
    expect(validateTransition("progress", "logged", "done").ok).toBe(false);
  });

  it("agent + progress artefacts have no lifecycle", () => {
    expect(validateTransition("agent", "active", "retired").ok).toBe(false);
  });
});

describe("relations", () => {
  it("knows the vocabulary", () => {
    expect(isRelation("supersedes")).toBe(true);
    expect(isRelation("loves")).toBe(false);
  });

  it("supersedes requires same type", () => {
    expect(validateRelation("supersedes", "decision", "decision").ok).toBe(true);
    expect(validateRelation("supersedes", "decision", "rfc").ok).toBe(false);
  });

  it("implements: task → rfc|goal only", () => {
    expect(validateRelation("implements", "task", "rfc").ok).toBe(true);
    expect(validateRelation("implements", "task", "goal").ok).toBe(true);
    expect(validateRelation("implements", "rfc", "task").ok).toBe(false);
  });

  it("constrains: only steering constrains", () => {
    expect(validateRelation("constrains", "steering", "task").ok).toBe(true);
    expect(validateRelation("constrains", "goal", "task").ok).toBe(false);
  });
});

describe("ids + search", () => {
  it("formats and parses ids", () => {
    expect(formatId(7)).toBe("BR#7");
    expect(idSeq("BR#7")).toBe(7);
    expect(idSeq("TASK-003")).toBe(3); // legacy ids still count
    expect(idSeq("nope")).toBeNaN();
  });

  it("fts query quotes tokens, ORs for recall; junk yields null", () => {
    expect(ftsQuery("batch  write")).toBe('"batch" OR "write"');
    expect(ftsQuery("-*( '")).toBeNull();
    expect(ftsQuery("")).toBeNull();
  });
});

describe("limits", () => {
  it("rejects bad titles/meta shapes", () => {
    expect(checkLimits("", "body", undefined)).toMatch(/title/);
    expect(checkLimits("t", "b", [] as unknown as object)).toMatch(/meta/);
    expect(checkLimits("t", "b", { a: 1 })).toBeNull();
  });
});

import { cosine, hybridMerge } from "../src/kb/core.ts";

describe("semantic helpers", () => {
  it("cosine: identical = 1, orthogonal = 0, opposite = -1", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it("hybrid merge: max-score, records via, sorts desc, caps k", () => {
    const merged = hybridMerge(
      [{ id: "A", score: 5 }, { id: "B", score: 3 }],
      [{ id: "B", score: 9 }, { id: "C", score: 1 }],
      2,
    );
    expect(merged[0]).toMatchObject({ id: "B", score: 9, via: ["keyword", "semantic"] });
    expect(merged[1]).toMatchObject({ id: "A", via: ["keyword"] });
    expect(merged.length).toBe(2);
  });
});

import { trigramVec } from "../src/kb/core.ts";

describe("trigram fuzzy vectors", () => {
  it("similar strings → high similarity, typos tolerated", () => {
    const a = trigramVec("batching ingestion latency");
    const b = trigramVec("batching ingestion latenct"); // typo
    const c = trigramVec("stripe billing ledger");
    expect(cosine(a, b)).toBeGreaterThan(0.8);
    expect(cosine(a, c)).toBeLessThan(0.3);
  });
});

import { scoreAgent, AgentSignals } from "../src/kb/core.ts";

const zero: AgentSignals = {
  progress_count: 0, gauge_count: 0, thin_notes: 0, abandoned: 0,
  asks_received: 0, asks_answered_on_time: 0, artefacts_created: 0,
};

describe("agent behaviour score", () => {
  it("idle agent sits at 50/fair with a nudge to create", () => {
    const r = scoreAgent({ ...zero });
    expect(r.score).toBe(50);
    expect(r.grade).toBe("fair");
    expect(r.hints.join(" ")).toMatch(/no artefacts created/);
  });

  it("gauges and on-time asks raise it; abandonments tank it", () => {
    const good = scoreAgent({ ...zero, gauge_count: 5, artefacts_created: 3, asks_received: 4, asks_answered_on_time: 4 });
    expect(good.score).toBeGreaterThan(60);
    expect(good.grade).toBe("good");
    const excellent = scoreAgent({ ...zero, gauge_count: 10, artefacts_created: 5, asks_received: 6, asks_answered_on_time: 6 });
    expect(excellent.score).toBeGreaterThanOrEqual(80);
    expect(excellent.grade).toBe("excellent");
    const bad = scoreAgent({ ...zero, abandoned: 3, thin_notes: 4 });
    expect(bad.score).toBeLessThan(40);
    expect(bad.grade).toBe("poor");
    expect(bad.hints.join(" ")).toMatch(/watchdog-blocked/);
  });

  it("effective range is 15..95 (base 50, penalties capped at 35, bonuses at 45)", () => {
    expect(scoreAgent({ ...zero, abandoned: 99, thin_notes: 99 }).score).toBe(15);
    expect(scoreAgent({ ...zero, gauge_count: 99, asks_answered_on_time: 99, artefacts_created: 99 }).score).toBe(95);
  });
});
