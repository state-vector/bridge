import { describe, expect, it } from "vitest";
import { CheckRetryCommandSchema, checkObligationKey, checkRetryScopeKey, checkRetryScopedKey, deployCoverageReceipt } from "../src/index.ts";

/** BR#8824 — the closed retry purpose/evidence contracts. The reserve names a
 *  purpose; the hub (never the caller) derives and validates the successful
 *  coverage receipt. The keys keep ordinary budgets permanent and scope
 *  stale-destination budgets to the changed successful coverage. */
describe("BR#8824 check retry purpose/evidence contracts", () => {
  it("keeps the purpose optional for legacy callers and closed for everyone else", () => {
    const base = { kind: "reserve", task_id: "BR#1", head_sha: "a".repeat(40), name: "Deploy health (merge gate)",
      source: { kind: "workflow_run", workflow_id: 99, run_attempt: 1 }, target: { kind: "workflow_run", id: 41734497120 } };
    expect(CheckRetryCommandSchema.parse(base).purpose).toBeUndefined();
    expect(CheckRetryCommandSchema.parse({ ...base, purpose: "stale_destination_gate" }).purpose).toBe("stale_destination_gate");
    expect(CheckRetryCommandSchema.parse({ ...base, purpose: "ordinary_head_check" }).purpose).toBe("ordinary_head_check");
    expect(CheckRetryCommandSchema.safeParse({ ...base, purpose: "caller_asserted_green" }).success).toBe(false);
  });

  it("derives the coverage receipt from canonical identity only — never a timestamp", () => {
    expect(deployCoverageReceipt({ tip_sha: "b".repeat(40), covered_by_run_id: 500 })).toBe(JSON.stringify(["b".repeat(40), 500]));
    // a missing decisive run id is its own receipt, not a guess
    expect(deployCoverageReceipt({ tip_sha: "b".repeat(40), covered_by_run_id: null })).toBe(JSON.stringify(["b".repeat(40), null]));
    // a NEW successful run on the SAME sha is a CHANGED receipt
    expect(deployCoverageReceipt({ tip_sha: "b".repeat(40), covered_by_run_id: 501 }))
      .not.toBe(deployCoverageReceipt({ tip_sha: "b".repeat(40), covered_by_run_id: 500 }));
  });

  it("scopes the ledger keys to the obligation and the validated coverage receipt", () => {
    const scopeKey = checkRetryScopeKey("BR#1", "a".repeat(40), checkObligationKey({ name: "Deploy health (merge gate)", source: { kind: "check_run", suite_id: 10, app_id: 1 } }));
    // the bare scope key IS the legacy budget key — old rows keep their meaning
    expect(scopeKey).toBe(JSON.stringify(["BR#1", "a".repeat(40), JSON.stringify(["check_run", 1, 10, "Deploy health (merge gate)"])]));
    const scoped = checkRetryScopedKey(scopeKey, "stale_destination_gate", deployCoverageReceipt({ tip_sha: "b".repeat(40), covered_by_run_id: 500 }));
    // purpose + receipt pin the scoped budget; a changed coverage or a
    // different obligation is a different key, never a reset of this one
    expect(scoped).not.toBe(checkRetryScopedKey(scopeKey, "stale_destination_gate", deployCoverageReceipt({ tip_sha: "b".repeat(40), covered_by_run_id: 501 })));
    const otherSuite = checkRetryScopeKey("BR#1", "a".repeat(40), checkObligationKey({ name: "Deploy health (merge gate)", source: { kind: "check_run", suite_id: 20, app_id: 15368 } }));
    expect(scoped).not.toBe(checkRetryScopedKey(otherSuite, "stale_destination_gate", deployCoverageReceipt({ tip_sha: "b".repeat(40), covered_by_run_id: 500 })));
  });
});