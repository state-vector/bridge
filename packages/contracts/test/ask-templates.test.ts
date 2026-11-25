import { describe, expect, it } from "vitest";
import {
  AskTemplateSchema,
  composeTemplateAsk,
  HumanDecisionSchema,
  WEB_EXECUTABLE_ACTIONS,
} from "../src/ask.ts";

const cases = [
  { kind: "release_hold", task_id: "BR#16389", subject: "PR #3392 projection — holder offline, resumes gate-refused", why_now: "wait fired and verified 2026-11-24" },
  { kind: "clear_hold", task_id: "BR#9907", subject: "PR #3020 reconcile park", hold: "await_event" as const },
  { kind: "resume_card", task_id: "BR#15600", subject: "answered ask consumed, card still parked" },
  { kind: "close_card", task_id: "BR#16509", subject: "cure merged, deploy green", disposition: "done" as const, receipts: "PR #3474 merged 2ae9739a; deploy run 44306440423 green" },
  { kind: "churn_loop", task_id: "BR#5976", subject: "obligation minting brief", attempts: 7, last_reason: "churn guard: released 6 times" },
  { kind: "merge_now", task_id: "BR#21649", subject: "release the stopped merge train", repo: "state-vector/bridge", pr: 3989 },
];

describe("ask templates (BR#21762)", () => {
  it("every template kind composes a valid human-decision ask within the question bar", () => {
    for (const t of cases) {
      const parsed = AskTemplateSchema.parse(t);
      const composed = composeTemplateAsk(parsed);
      expect(composed.question.length, parsed.kind).toBeLessThanOrEqual(240);
      expect(composed.question.endsWith("?"), parsed.kind).toBe(true);
      const decision = HumanDecisionSchema.parse(composed.decision);
      expect(decision.task_id).toBe(parsed.task_id);
      expect(composed.options).toEqual(decision.choices.map((c) => c.label));
      expect(composed.details.trim()).not.toBe("");
      expect(composed.reason.trim()).not.toBe("");
      // requireHumanDecision's cross-field law: options mirror the choices exactly
      expect(JSON.stringify(composed.options)).toBe(JSON.stringify(decision.choices.map((c) => c.label)));
    }
  });

  it("action templates put a web-executable human choice FIRST — the button IS the action", () => {
    for (const kind of ["release_hold", "clear_hold", "close_card", "churn_loop"]) {
      const t = cases.find((c) => c.kind === kind)!;
      const { decision } = composeTemplateAsk(AskTemplateSchema.parse(t));
      expect(WEB_EXECUTABLE_ACTIONS.has(decision.choices[0].action), kind).toBe(true);
      expect(decision.choices[0].executor, kind).toBe("human");
    }
  });

  it("answer-executed templates (resume, merge) stay bridge-executor — the answer is the trigger", () => {
    for (const kind of ["resume_card", "merge_now"]) {
      const t = cases.find((c) => c.kind === kind)!;
      const { decision } = composeTemplateAsk(AskTemplateSchema.parse(t));
      expect(decision.choices[0].executor, kind).toBe("bridge");
      expect(decision.choices[0].action, kind).toBe("resume");
    }
  });

  it("the registry is closed: unknown kinds and unbounded fields are refused", () => {
    expect(AskTemplateSchema.safeParse({ kind: "explode_things", task_id: "BR#1", subject: "x" }).success).toBe(false);
    expect(AskTemplateSchema.safeParse({ kind: "release_hold", task_id: "BR#1", subject: "x".repeat(141) }).success).toBe(false);
    expect(AskTemplateSchema.safeParse({ kind: "release_hold", task_id: "task-1", subject: "x" }).success).toBe(false);
    expect(AskTemplateSchema.safeParse({ kind: "close_card", task_id: "BR#1", subject: "x", disposition: "done" }).success).toBe(false);
  });

  it("a human choice may now name a web-executable action (the amended admission rule)", () => {
    const decision = HumanDecisionSchema.parse({
      kind: "authority", task_id: "BR#1", context: "c", why_human: "w",
      choices: [
        { label: "Release", executor: "human", consequence: "One click runs the audited override.", action: "release" },
        { label: "Keep held", executor: "bridge", consequence: "stays", action: "hold" },
      ],
    });
    expect(decision.choices[0].action).toBe("release");
    // a bridge-executed release is still meaningless — executor owns the act
    expect(() => HumanDecisionSchema.parse({
      kind: "authority", task_id: "BR#1", context: "c", why_human: "w",
      choices: [
        { label: "Release", executor: "bridge", consequence: "x", action: "release" },
        { label: "Keep", executor: "bridge", consequence: "y", action: "hold" },
      ],
    })).not.toThrow();
  });
});
