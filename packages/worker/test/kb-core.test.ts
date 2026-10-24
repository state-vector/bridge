import { describe, expect, it } from "vitest";
import {
  checkLimits,
  parseRolesInput,
  splitSystemTags,
  validateRelation,
  ftsQuery,
  formatId,
  idSeq,
  isQuestionTask,
  isRelation,
  parseTags,
  resolveRolePlaybook,
  sanitizeTags,
  taskKind,
  validateTransition,
  verifyVerdictStatement,
} from "../src/kb/core.ts";

describe("tag parsing (stored column is untrusted)", () => {
  it("parseTags always returns a string[]", () => {
    expect(parseTags('["role:impl","x"]')).toEqual(["role:impl", "x"]);
    expect(parseTags('"role:impl"')).toEqual(["role:impl"]); // JSON-encoded string (crashed orient)
    expect(parseTags("role:impl")).toEqual(["role:impl"]); // bare unquoted string
    expect(parseTags(null)).toEqual([]);
    expect(parseTags("")).toEqual([]);
    expect(parseTags(42)).toEqual([]);
    expect(parseTags("{bad json")).toEqual(["{bad json"]);
  });

  it("parseTags unwraps nested JSON-encoded elements (recursive verify flood)", () => {
    // legacy rows stored a JSON-encoded array as an array element: the review
    // gate missed role:review, spawning verify-of-verify on every completion
    expect(parseTags(['["role:review"]'])).toEqual(["role:review"]);
    expect(parseTags(["\"[\\\"role:review\\\"]\""])).toEqual(["role:review"]);
    expect(parseTags(['"role:impl"', '["role:x","role:y"]'])).toEqual(["role:impl", "role:x", "role:y"]);
    // comma-separated strings inside arrays also split
    expect(parseTags(["role:a,role:b"])).toEqual(["role:a", "role:b"]);
    // depth-3 still resolves; unparseable junk passes through as a literal
    expect(parseTags(['["[\\\"role:z\\\"]"]'])).toEqual(["role:z"]);
    expect(parseTags(["[{bad json"])).toEqual(["[{bad json"]);
  });

  it("sanitizeTags tolerates comma strings from clients", () => {
    expect(sanitizeTags("role:impl, x")).toEqual(["role:impl", "x"]);
    expect(sanitizeTags(["A", "a", ""])).toEqual(["a"]);
    expect(sanitizeTags(42)).toBeNull();
    expect(sanitizeTags(",,,")).toBeNull();
  });
});

describe("lifecycles", () => {
  it("task in_progress → in_review → (done | bounce | blocked); bounce returns to work", () => {
    expect(validateTransition("task", "in_progress", "in_review").ok).toBe(true);
    expect(validateTransition("task", "in_review", "done").ok).toBe(true);
    expect(validateTransition("task", "in_review", "in_progress").ok).toBe(true);
    expect(validateTransition("task", "in_review", "blocked").ok).toBe(true);
    expect(validateTransition("task", "todo", "in_review").ok).toBe(false);
    expect(validateTransition("task", "in_review", "superseded").ok).toBe(false);
  });

  it("rfc + discussion are gone — question tasks and decisions replaced them", () => {
    // taskKind is meta-driven; validateTransition for "rfc" must fail as unknown type
    expect(validateTransition("rfc" as any, "draft", "proposed").ok).toBe(false);
    expect(validateTransition("discussion" as any, "open", "concluded").ok).toBe(false);
  });

  it("task kinds: question is claimable-gated, impl is the default", () => {
    expect(taskKind({})).toBe("impl");
    expect(taskKind({ kind: "question" })).toBe("question");
    expect(taskKind({ kind: "bogus" })).toBe("impl");
    expect(isQuestionTask({ kind: "question" })).toBe(true);
    expect(isQuestionTask({ kind: "impl" })).toBe(false);
    expect(isQuestionTask({})).toBe(false);
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
    expect(validateRelation("supersedes", "decision", "rfc" as any).ok).toBe(false);
  });

  it("implements: task → goal only (rfc type is gone)", () => {
    expect(validateRelation("implements", "task", "goal").ok).toBe(true);
    expect(validateRelation("implements", "task", "rfc" as any).ok).toBe(false);
    expect(validateRelation("implements", "rfc" as any, "task").ok).toBe(false);
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
  reassigned: 0, asks_received: 0, asks_answered_on_time: 0,
  artefacts_created: 0, verify_duty_backlog: 0,
};

describe("role playbook resolution (settings.roles overrides)", () => {
  it("a non-blank override wins over the hub default", () => {
    expect(resolveRolePlaybook({ impl: "  CUSTOM LANE  " }, "impl")).toBe("CUSTOM LANE");
  });

  it("a blank override resets to the hub default — never drops the playbook", () => {
    expect(resolveRolePlaybook({ analysis: "" }, "analysis")).toMatch(/DECOMPOSE/);
    expect(resolveRolePlaybook({ analysis: "   " }, "analysis")).toMatch(/DECOMPOSE/);
  });

  it("missing override and unknown roles fall back safely", () => {
    expect(resolveRolePlaybook(undefined, "review")).toMatch(/VERIFY/);
    expect(resolveRolePlaybook({}, "review")).toMatch(/VERIFY/);
    expect(resolveRolePlaybook({ analysis: "x" }, "review")).toMatch(/VERIFY/);
    expect(resolveRolePlaybook({}, "nonexistent")).toBe("");
    expect(resolveRolePlaybook({ impl: 42 }, "impl")).toMatch(/BUILD/); // non-string junk = no override
  });
});

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

describe("verify-verdict decision statement (human-facing ask prepended at creation)", () => {
  it("PASS frames the accept-and-close ask with target, receipts source and round", () => {
    const s = verifyVerdictStatement({
      decision_class: "verify-verdict",
      verify_target: "BR#1865",
      verdict: "pass",
      round: "1",
      session: "dispatch-BR-2391",
    });
    expect(s).toContain("What you are deciding");
    expect(s).toContain("agents propose, only a human accepts");
    expect(s).toContain("closes **BR#1865** as **done**");
    expect(s).toContain("dispatch-BR-2391");
    expect(s).toContain("round 1");
    expect(s).toContain("auto-added"); // clearly marked as machine-generated
  });

  it("BOUNCE frames the bounce-back ask", () => {
    const s = verifyVerdictStatement({ decision_class: "verify-verdict", task: "BR#42", verdict: "bounce" });
    expect(s).toContain("bounces **BR#42** back to `in_progress` with the findings");
    expect(s).not.toContain("closes **");
  });

  it("falls back gracefully when meta fields are missing", () => {
    const s = verifyVerdictStatement({ decision_class: "verify-verdict" });
    expect(s).toContain("the task");
    expect(s).not.toContain("by session"); // no session clause when absent
    expect(s).not.toContain("round ");
  });

  it("accepts meta-shaped round numbers and prefers task over verify_target", () => {
    const s = verifyVerdictStatement({ decision_class: "verify-verdict", task: "BR#9", verify_target: "BR#8", verdict: "pass", round: 4, session: "s1" });
    expect(s).toContain("**BR#9**");
    expect(s).not.toContain("BR#8");
    expect(s).toContain("round 4");
  });

  it("stays well under the body limit so prepending never trips checkLimits", () => {
    const s = verifyVerdictStatement({ decision_class: "verify-verdict", verify_target: "BR#123456", verdict: "pass", round: "12", session: "a-very-long-session-name-indeed" });
    expect(s.length).toBeLessThan(1000);
  });
});

// ---------- BR#2983: question type, roles parsing, splitSystemTags migration ----------

describe("question type (BR#2983)", () => {
  it("question lifecycle: todo → done|superseded only — never claimed", () => {
    expect(validateTransition("question", "todo", "done").ok).toBe(true);
    expect(validateTransition("question", "todo", "superseded").ok).toBe(true);
    expect(validateTransition("question", "todo", "in_progress").ok).toBe(false);
    expect(validateTransition("question", "todo", "blocked").ok).toBe(false);
  });
  it("child_of: question may nest under its subject task; questions are never parents", () => {
    expect(validateRelation("child_of", "question", "task").ok).toBe(true);
    expect(validateRelation("child_of", "task", "task").ok).toBe(true);
    expect(validateRelation("child_of", "task", "question").ok).toBe(false);
    expect(validateRelation("child_of", "question", "question").ok).toBe(false);
  });
});

describe("parseRolesInput", () => {
  it("accepts bare names, tolerates role: prefix, dedupes", () => {
    expect(parseRolesInput(null)).toEqual({ ok: true, roles: [] });
    expect(parseRolesInput(["review"])).toEqual({ ok: true, roles: ["review"] });
    expect(parseRolesInput(["role:unblock", "unblock"])).toEqual({ ok: true, roles: ["unblock"] });
    expect(parseRolesInput("review, impl")).toEqual({ ok: true, roles: ["review", "impl"] });
  });
  it("rejects unknown roles loudly", () => {
    expect(parseRolesInput(["reveiw"]).ok).toBe(false);
    expect(parseRolesInput(["gateway"]).ok).toBe(false); // token trait, not an artefact role
  });
});

describe("splitSystemTags (roles_v1 migration transform)", () => {
  it("extracts role tags to bare roles, keeps user tags untouched", () => {
    const out = splitSystemTags("task", ["role:review", "gtm", "role:analysis"], {}, 1);
    expect(out.roles).toEqual(["review", "analysis"]);
    expect(out.tags).toEqual(["gtm"]);
    expect(out.type).toBe("task");
    expect(out.changed).toBe(true);
  });
  it("question tag on a task becomes type question (asks v2 nodes)", () => {
    const out = splitSystemTags("task", ["question", "gtm"], {}, 1);
    expect(out.type).toBe("question");
    expect(out.tags).toEqual(["gtm"]);
  });
  it("question tag on non-task types is dropped without a type change", () => {
    const out = splitSystemTags("decision", ["question"], {}, 1);
    expect(out.type).toBe("decision");
  });
  it("attempted tag backfills meta.attempt; existing attempt record wins", () => {
    const a = splitSystemTags("task", ["attempted"], {}, 123);
    expect(a.meta.attempt).toEqual({ by: "system:migration", at: 123, attempts: 1 });
    const b = splitSystemTags("task", ["attempted"], { attempt: { by: "x", attempts: 5 } }, 123);
    expect(b.meta.attempt.attempts).toBe(5);
  });
  it("legacy encodings via parseTags: bare strings, nested JSON, comma lists", () => {
    const encodings = ['["role:impl","x"]', '"role:impl"', "role:impl", ["role:review"], ['"[\\\"role:z\\"]"']];
    for (const enc of encodings) {
      const out = splitSystemTags("task", parseTags(enc), {}, 1);
      expect(out.roles.length).toBeGreaterThan(0);
      expect(out.tags.some((t) => t.startsWith("role:"))).toBe(false);
    }
  });
  it("pure user tags: unchanged, not a migration", () => {
    const out = splitSystemTags("task", ["gtm", "deploy-train"], { a: 1 }, 1);
    expect(out).toEqual({ type: "task", tags: ["gtm", "deploy-train"], roles: [], meta: { a: 1 }, changed: false });
  });
});
