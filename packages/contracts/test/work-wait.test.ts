import { describe, expect, it } from "vitest";
import { SchedulingReasonSchema } from "../src/scheduling.ts";
import { SCHEDULING_REASON_WAIT_PLAN, type SchedulingReasonWaitPlan } from "../src/work-wait.ts";

// BR#23275 — the invariant behind Ray's "this must be systematically
// impossible": every dispatch hold class declares the WorkWait kind whose
// exit carries its release. The Record in work-wait.ts enforces this at
// compile time (a reason without a plan fails typecheck); this test is the
// runtime leg — it catches any path that bypasses the types (string-built
// reasons, schema drift, a hand-edited map) before the scheduler can
// silently skip a held class.
describe("scheduling reason → wait exit exhaustiveness (BR#23275)", () => {
  it("every SchedulingReason declares exactly one wait plan — no silent classes", () => {
    for (const reason of SchedulingReasonSchema.options) {
      const plan: SchedulingReasonWaitPlan | undefined = SCHEDULING_REASON_WAIT_PLAN[reason];
      expect(plan, `reason ${reason} declares no wait plan — add it to SCHEDULING_REASON_WAIT_PLAN in work-wait.ts`).toBeTruthy();
      expect(["prerequisite", "execution_recovery", "prior_attempt_reconciliation"],
        `reason ${reason} routes to an unknown wait kind`).toContain(plan!.wait);
      // The declared wait carries the reason itself, so the exit names its
      // class — except the two reconciliation classes, whose exit comes from
      // execution state (single source of truth for hold and exit alike).
      if (plan!.wait !== "prior_attempt_reconciliation") expect(plan!.reason).toBe(reason);
    }
    // And nothing beyond the closed vocabulary: no hand-written arm can
    // outlive its enum member.
    expect(Object.keys(SCHEDULING_REASON_WAIT_PLAN).sort())
      .toEqual([...SchedulingReasonSchema.options].sort());
  });
});
