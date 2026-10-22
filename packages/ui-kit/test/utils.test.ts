import { describe, expect, it } from "vitest";
import { kindOf, rankOf, groupVerdicts, verdictFingerprint, sameVerdictAs, ageText } from "../src/utils";

const task = (over: Partial<Parameters<typeof rankOf>[0]> & Record<string, unknown> = {}) => ({
  id: "BR#1", title: "t", status: "todo", tags: [] as string[], meta: {}, ...over,
});

describe("rankOf", () => {
  it("orders boosted < unblock < blocked-with-exit < verify < analysis/question < todo < dead-end", () => {
    const boosted = rankOf(task({ meta: { boosted: true } }));
    const unblock = rankOf(task({ tags: ["role:unblock"] }));
    const blockedExit = rankOf(task({ status: "blocked", meta: { blocked: { unblock_condition: "x" } } }));
    const verify = rankOf(task({ tags: ["role:review"] }));
    const analysis = rankOf(task({ tags: ["role:analysis"] }));
    const question = rankOf(task({ tags: ["question"] }));
    const todo = rankOf(task({}));
    const deadEnd = rankOf(task({ status: "blocked", meta: {} }));
    expect(boosted).toBeLessThan(unblock);
    expect(unblock).toBeLessThan(blockedExit);
    expect(blockedExit).toBeLessThan(verify);
    expect(verify).toBeLessThan(Math.min(analysis, question));
    expect(Math.min(analysis, question)).toBeLessThan(todo);
    expect(deadEnd).toBeGreaterThan(todo);
  });
  it("boosted is priority 0", () => {
    expect(rankOf(task({ meta: { boosted: true } }))).toBe(-1);
  });
});

describe("groupVerdicts", () => {
  const d = (id: string, target: string, verdict: string, created: number, meta: Record<string, unknown> = {}) =>
    ({ id, title: verdict + " " + target, status: "proposed", created_ts: created, updated_ts: created, meta: { decision_class: "verify-verdict", task: target, verdict, ...meta } } as any);
  it("groups by target, newest first, collapses priors", () => {
    const g = groupVerdicts([
      d("d1", "BR#50", "BOUNCE", 100),
      d("d2", "BR#50", "BOUNCE", 200, { pr: "same" }),
      d("d3", "BR#31", "PASS", 300),
    ]);
    expect(g.cards.length).toBe(2);
    expect(g.cards[0].latest.id).toBe("d3");
    expect(g.cards[1].prior.length).toBe(1);
  });
});

describe("verdictFingerprint / sameVerdictAs", () => {
  it("ignores bookkeeping keys, compares receipts", () => {
    const a = { decision_class: "verify-verdict", task: "BR#50", verdict: "BOUNCE", session: "s1", pr: "x", issue_state: "open" };
    const b = { decision_class: "verify-verdict", task: "BR#50", verdict: "BOUNCE", session: "s2", pr: "x", issue_state: "open" };
    expect(verdictFingerprint(a)).toBe(verdictFingerprint(b));
    expect(sameVerdictAs({ meta: a } as any, { meta: b } as any)).toBe(true);
    const c = { ...a, issue_state: "closed" };
    expect(verdictFingerprint(a)).not.toBe(verdictFingerprint(c));
  });
});

describe("ageText / staleness boundaries", () => {
  const now = 1_000_000_000_000;
  it("formats seconds/minutes/hours", () => {
    expect(ageText(now - 5000, now)).toBe("5s");
    expect(ageText(now - 90_000, now)).toBe("1m");
    expect(ageText(now - 2 * 3600_000, now)).toBe("2h 0m");
  });
});
