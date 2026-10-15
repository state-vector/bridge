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
    expect(formatId("rfc", 7)).toBe("RFC-007");
    expect(idSeq("RFC-007")).toBe(7);
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
