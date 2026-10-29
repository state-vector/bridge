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

import { tallyConsensus } from "../src/kb/core.ts";

describe("decision consensus tally (BR#903)", () => {
  it("counts agree / disagree / neutral, contributors distinct", () => {
    const t = tallyConsensus([
      { actor: "a1", note: "agree — the round pattern mirrors Verify children" },
      { actor: "a2", note: "disagree — asks already cover this; reasons: dup channel" },
      { actor: "a1", note: "agree" },
      { actor: "a3", note: "what happens to the round when the decision is superseded?" },
    ]);
    expect(t.agree).toBe(2);
    expect(t.disagree).toBe(1);
    expect(t.other).toBe(1);
    expect(t.contributors).toEqual(["a1", "a2", "a3"]);
  });

  it("dissent always surfaces: disagree beats agree, negated agree counts as disagree", () => {
    expect(tallyConsensus([{ note: "disagree with the gate" }]).disagree).toBe(1);
    expect(tallyConsensus([{ note: "I don't agree with the marker approach" }]).disagree).toBe(1);
    expect(tallyConsensus([{ note: "cannot agree with this as written" }]).disagree).toBe(1);
    expect(tallyConsensus([{ note: "I don't agree, I disagree" }]).disagree).toBe(1);
  });

  it("affirmatives in the wild count as agree; empty/null entries are safe", () => {
    expect(tallyConsensus([{ note: "I concur with the proposal" }]).agree).toBe(1);
    expect(tallyConsensus([{ note: "endorse — ship it" }]).agree).toBe(1);
    expect(tallyConsensus([])).toEqual({ agree: 0, disagree: 0, other: 0, contributors: [] });
    expect(tallyConsensus(null)).toEqual({ agree: 0, disagree: 0, other: 0, contributors: [] });
    expect(tallyConsensus([{ note: "" }, { note: "   " }]).other).toBe(0);
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

import { scoreAgent, AgentSignals, detectResultTrail, describeResultTrail } from "../src/kb/core.ts";

const zero: AgentSignals = {
  progress_count: 0, gauge_count: 0, thin_notes: 0, abandoned: 0, result_lost: 0,
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

  it("BR#3352: result_lost is a delivery-channel incident — never a score penalty, always a channel hint", () => {
    const r = scoreAgent({ ...zero, result_lost: 3 });
    expect(r.score).toBe(50); // identical to the no-incident baseline
    expect(r.hints.join(" ")).toMatch(/completed_result_lost/);
    expect(r.hints.join(" ")).toMatch(/delivery-channel incident, not abandonment/);
    // abandoned still tanks it — the exemption is scoped to the lost-report class
    const mixed = scoreAgent({ ...zero, result_lost: 2, abandoned: 1 });
    expect(mixed.score).toBe(40);
    expect(mixed.hints.join(" ")).toMatch(/watchdog-blocked/);
  });
});

describe("BR#3352 completed_result_lost — session-trail classification", () => {
  it("a GitHub PR receipt in the last progress note proves landed side effects", () => {
    const t = detectResultTrail({
      last_progress_note: "runner: run finished — exit 0 — PR https://github.com/state-vector/superpositional/pull/2341 open",
      worktree: "/Users/rayh/.bridge/worktrees/br-1234",
      session: "dispatch-metareview-finds-1025b",
    });
    expect(t).not.toBeNull();
    expect(t!.receipt_url).toBe("https://github.com/state-vector/superpositional/pull/2341");
    expect(t!.worktree).toBe("/Users/rayh/.bridge/worktrees/br-1234");
    expect(t!.session).toBe("dispatch-metareview-finds-1025b");
  });

  it("commit receipts in the recent trail notes count too (deduped, capped)", () => {
    const t = detectResultTrail({
      last_progress_note: "shipped",
      recent_notes: [
        "pushed https://github.com/state-vector/superpositional/commit/abc1234def0123456789abc1234def0123456789a",
        "repushed https://github.com/state-vector/superpositional/commit/abc1234def0123456789abc1234def0123456789a",
        "and https://github.com/state-vector/superpositional/commit/bbc1234def0123456789abc1234def0123456789b",
      ],
    });
    expect(t).not.toBeNull();
    expect(t!.receipt_url).toBeNull();
    expect(t!.commit_urls).toHaveLength(2);
  });

  it("the runner's own completed_result_lost marker alone is evidence", () => {
    const t = detectResultTrail({
      last_progress_note: "completed_result_lost — run finished (exit 0) after the claim was lost; agent reply was empty",
    });
    expect(t).not.toBeNull();
  });

  it("a registered worktree/session alone proves NOTHING — every claimed task has one", () => {
    expect(detectResultTrail({ worktree: "/home/x/.bridge/worktrees/br-9", session: "dispatch-x" })).toBeNull();
  });

  it("a genuine silent stall (no receipts, no marker) classifies null — plain abandonment path", () => {
    expect(detectResultTrail({ last_progress_note: "working on it" })).toBeNull();
  });

  it("issue receipts count as landed-work receipts", () => {
    const t = detectResultTrail({ last_progress_note: "filed https://github.com/state-vector/superpositional/issues/2338" });
    expect(t).not.toBeNull();
    expect(t!.receipt_url).toBe("https://github.com/state-vector/superpositional/issues/2338");
  });

  it("describeResultTrail is human-readable and bounded", () => {
    const d = describeResultTrail({
      receipt_url: "https://github.com/state-vector/superpositional/pull/2341",
      commit_urls: ["https://github.com/state-vector/superpositional/commit/abc1234def0123456789abc1234def0123456789a"],
      worktree: "/home/x/.bridge/worktrees/br-9",
      session: "dispatch-x",
    });
    expect(d).toMatch(/pull\/2341/);
    expect(d).toMatch(/worktree/);
    expect(d.length).toBeLessThan(220);
    expect(describeResultTrail({ receipt_url: null, commit_urls: [], worktree: null, session: null })).toMatch(/side effects present/);
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

import { releaseHold, trainPrLeg, trainProxyEvent, trainMergeReceipt, PROXY_WAIT_HOLD_RESULT_CLASS } from "../src/kb/core.ts";

// BR#4067 — the typed-proxy hold predicate: every watchdog release path
// consults this one function. The PR #257/BR#4015 class: a card carrying a
// live machine wait (train queue slot, typed await, bound ask) was released
// to todo and the wait state was destroyed.
describe("releaseHold — typed-proxy preservation (BR#4067)", () => {
  it("train queued/awaiting-ci/bounced on a live PR leg hold", () => {
    for (const state of ["queued", "awaiting-ci", "bounced"]) {
      const meta = { merge_train: { state, pr: 259, repo: "state-vector/bridge" } };
      expect(releaseHold(meta)).toMatch(new RegExp(`merge-train ${state} on PR state-vector/bridge#259`));
    }
  });

  it("train state WITHOUT a resolvable PR leg does not hold (nothing to preserve)", () => {
    expect(releaseHold({ merge_train: { state: "bounced" } })).toBeNull();
    expect(releaseHold({ merge_train: { state: "queued", pr: 0 } })).toBeNull();
  });

  it("the PR leg resolves from every stamp shape (pr.number, prs[0], merge_train.pr)", () => {
    expect(trainPrLeg({ pr: { number: 7 } })).toBe(7);
    expect(trainPrLeg({ prs: [{ number: 9 }] })).toBe(9);
    expect(trainPrLeg({ merge_train: { pr: 11 } })).toBe(11);
    expect(trainPrLeg({})).toBe(0);
  });

  it("trainProxyEvent derives the pr_merged typed await from the live leg", () => {
    expect(trainProxyEvent({ pr: { repo: "o/r", number: 5 } })).toEqual({ event: "pr_merged", repo: "o/r", n: 5 });
    expect(trainProxyEvent({ merge_train: { pr: 5 } })).toBeNull(); // no repo → not derivable
    expect(trainProxyEvent({ pr: { repo: "bad repo", number: 5 } })).toBeNull();
  });

  it("a typed await_event holds, naming its kind", () => {
    expect(releaseHold({ blocked: { reason: "x", await_event: { event: "pr_checks_green", repo: "o/r", n: 1 } } })).toMatch(/typed await_event \(pr_checks_green\)/);
  });

  it("a bound ask holds, naming the ask", () => {
    expect(releaseHold({ awaiting_ask: { ask_id: "ASK-9" } })).toMatch(/bound ask \(ASK-9\)/);
  });

  it("cards with no machine wait release freely", () => {
    expect(releaseHold(null)).toBeNull();
    expect(releaseHold({})).toBeNull();
    expect(releaseHold({ blocked: { reason: "merge-train: queued" } })).toBeNull(); // prose reason alone is not state
    expect(releaseHold({ merge_train: { state: "landed" }, pr: { number: 1 } })).toBeNull(); // landed is the machine's own close path
    expect(releaseHold({ merge_train: { state: "unbound" }, pr: { number: 1 } })).toBeNull();
  });

  it("the hold result-class is the abandonment-scoring exemption stamp", () => {
    expect(PROXY_WAIT_HOLD_RESULT_CLASS).toBe("proxy_wait_hold");
  });
});

// BR#4282 — the board's own merge receipt: the hub holds no VCS credentials
// (BR#3516 §8), so a pr_merged proxy's satisfied-atom check consults ONLY the
// stamps the train itself wrote (awaiting-ci state / per-leg merge_sha).
describe("trainMergeReceipt — board-native pr_merged receipt (BR#4282)", () => {
  const sha = "32e12f20985ee77ea17ebe458b2b8f0ec43af77e";

  it("the train's awaiting-ci stamp is a receipt for its own PR leg", () => {
    const meta = { merge_train: { state: "awaiting-ci", pr: 259, repo: "state-vector/bridge", merge_sha: sha, merged_at: 1_234 } };
    expect(trainMergeReceipt(meta, "state-vector/bridge", 259)).toEqual({ merge_sha: sha, merged_at: 1_234 });
  });

  it("a per-leg merge_sha (merge_train.legs[n]) is a receipt too — and wins over the state stamp", () => {
    const meta = {
      merge_train: {
        state: "awaiting-ci", pr: 260, repo: "o/r", merge_sha: "state-sha", merged_at: 9,
        legs: { "259": { merge_sha: sha, merged_at: 5 } },
      },
    };
    expect(trainMergeReceipt(meta, "o/r", 259)).toEqual({ merge_sha: sha, merged_at: 5 });
  });

  it("a missing merged_at degrades to 0 — the sha is the proof", () => {
    const meta = { merge_train: { state: "awaiting-ci", pr: 7, repo: "o/r", merge_sha: sha } };
    expect(trainMergeReceipt(meta, "o/r", 7)).toEqual({ merge_sha: sha, merged_at: 0 });
  });

  it("no receipt without the awaiting-ci state — queued/bounced/landed prove nothing", () => {
    for (const state of ["queued", "bounced", "landed", ""]) {
      const meta = { merge_train: { state, pr: 259, repo: "o/r", merge_sha: sha } };
      expect(trainMergeReceipt(meta, "o/r", 259)).toBeNull();
    }
  });

  it("no receipt for a DIFFERENT PR, a missing sha, or a missing card", () => {
    expect(trainMergeReceipt({ merge_train: { state: "awaiting-ci", pr: 260, repo: "o/r", merge_sha: sha } }, "o/r", 259)).toBeNull();
    expect(trainMergeReceipt({ merge_train: { state: "awaiting-ci", pr: 259, repo: "o/r", merge_sha: "" } }, "o/r", 259)).toBeNull();
    expect(trainMergeReceipt({}, "o/r", 259)).toBeNull();
    expect(trainMergeReceipt(null, "o/r", 259)).toBeNull();
  });

  it("the receipt must be for the repo the proxy names — no cross-repo smear", () => {
    const meta = { merge_train: { state: "awaiting-ci", pr: 259, repo: "o/r", merge_sha: sha } };
    expect(trainMergeReceipt(meta, "other/repo", 259)).toBeNull();
    // the card's pr stamp outranks merge_train.repo for identity
    const both = { pr: { repo: "o/r", number: 259 }, merge_train: { state: "awaiting-ci", pr: 259, repo: "p/q", merge_sha: sha } };
    expect(trainMergeReceipt(both, "o/r", 259)).toEqual({ merge_sha: sha, merged_at: 0 });
    expect(trainMergeReceipt(both, "p/q", 259)).toBeNull();
  });
});
