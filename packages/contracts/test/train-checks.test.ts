import { describe, expect, it } from "vitest";
import { CheckRetryCommandSchema, CheckSourceSchema, checkObligationKey, checkRetryScopeKey, checkRetryScopedKey, checkRunProducer, deployCoverageReceipt, GITHUB_ACTIONS_APP_ID, legacyCheckObligationKey } from "../src/index.ts";

/** BR#9268 — the producer class of a check-run observation. Derived from the
 *  provider payload (the check run's GitHub URL shape), never caller-asserted:
 *  GitHub files an API-created check run into the creating app's most recent
 *  suite for the head SHA, so a published gate report can share name + app
 *  15368 + suite with the native job (live SP PR #3057 head shape) while
 *  enforcing nothing on its own. */
describe("BR#9268 check-run producer identity", () => {
  it("derives the producer from the provider URL shape only", () => {
    const repo = "state-vector/superpositional";
    expect(checkRunProducer(`https://github.com/${repo}/actions/runs/42563228107/job/128984021963`)).toBe("actions_job");
    expect(checkRunProducer(`https://github.com/${repo}/runs/129034449798`)).toBe("published");
    // GitHub's own defaults and drift shapes fail CLOSED to unclassified.
    expect(checkRunProducer(`https://github.com/${repo}/runs/0123`)).toBe("unclassified");
    expect(checkRunProducer(`https://github.com/${repo}/actions/runs/42563228107`)).toBe("unclassified");
    expect(checkRunProducer("https://gitlab.com/x/y")).toBe("unclassified");
    expect(checkRunProducer(null)).toBe("unclassified");
    expect(checkRunProducer(undefined)).toBe("unclassified");
  });

  it("keeps the live #3057 collision pair distinct obligations; same-producer supersession preserved", () => {
    const native = { name: "Deploy health (merge gate)", source: { kind: "check_run", suite_id: 115286627637, app_id: GITHUB_ACTIONS_APP_ID, producer: "actions_job" } };
    const published = { name: "Deploy health (merge gate)", source: { kind: "check_run", suite_id: 115286627637, app_id: GITHUB_ACTIONS_APP_ID, producer: "published" } };
    // Same name + app + suite, different producer → different obligations.
    expect(checkObligationKey(native)).not.toBe(checkObligationKey(published));
    // Same class, same everything → one obligation (supersession holds).
    expect(checkObligationKey(native)).toBe(checkObligationKey({ ...native, source: { ...native.source, producer: "actions_job" } }));
    // A workflow_run source is unaffected by the producer split.
    expect(checkObligationKey({ name: "Deploy Dev", source: { kind: "workflow_run", workflow_id: 99, run_attempt: 1 } }))
      .toBe(JSON.stringify(["workflow_run", 99, "Deploy Dev"]));
    // The closed union still accepts a typed source with a producer…
    expect(CheckSourceSchema.safeParse(native.source).success).toBe(true);
    // …refuses a fabricated class…
    expect(CheckSourceSchema.safeParse({ ...native.source, producer: "github_job" }).success).toBe(false);
    // …and keeps the legacy (producer-less) shape lawful.
    expect(CheckSourceSchema.safeParse({ kind: "check_run", suite_id: 10, app_id: 15368 }).success).toBe(true);
  });

  it("keeps the pre-split identity byte-stable for legacy callers and derives the collapsed key for the fence", () => {
    const withProducer = { name: "Deploy health (merge gate)", source: { kind: "check_run", suite_id: 115286627637, app_id: 15368, producer: "actions_job" } };
    const withoutProducer = { name: "Deploy health (merge gate)", source: { kind: "check_run", suite_id: 115286627637, app_id: 15368 } };
    // A producer-less observation keeps the EXACT pre-split key format.
    expect(checkObligationKey(withoutProducer)).toBe(JSON.stringify(["check_run", 15368, 115286627637, "Deploy health (merge gate)"]));
    // The legacy identity of a producer-typed observation IS that key — the
    // fence surface across the migration.
    expect(legacyCheckObligationKey(withProducer)).toBe(checkObligationKey(withoutProducer));
    // For workflow_run / unknown sources the two identities coincide.
    const wf = { name: "Deploy Dev", source: { kind: "workflow_run", workflow_id: 99, run_attempt: 1 } };
    expect(legacyCheckObligationKey(wf)).toBe(checkObligationKey(wf));
    expect(legacyCheckObligationKey({ name: "Gate" })).toBe(JSON.stringify(["unknown", "Gate"]));
  });
});

/** BR#8824 — the closed retry purpose/evidence contracts. The reserve names a
 *  purpose; the hub (never the caller) derives and validates the successful
 *  coverage receipt. The keys keep ordinary budgets permanent and scope
 *  stale-destination budgets to the changed successful coverage. */
describe("BR#8824 check retry purpose/evidence contracts", () => {
  it("keeps the purpose optional for legacy callers and closed for everyone else", () => {
    const base = { kind: "reserve", task_id: "BR#1", head_sha: "a".repeat(40), name: "Deploy health (merge gate)",
      source: { kind: "workflow_run", workflow_id: 99, run_attempt: 1 }, target: { kind: "workflow_run", id: 41734497120 } };
    expect(CheckRetryCommandSchema.parse(base)).not.toHaveProperty("purpose");
    expect(CheckRetryCommandSchema.parse({ ...base, purpose: "stale_destination_gate", pr: 1 })).toMatchObject({purpose:"stale_destination_gate"});
    expect(CheckRetryCommandSchema.safeParse({ ...base, purpose: "stale_destination_gate" }).success).toBe(false);
    expect(CheckRetryCommandSchema.parse({ ...base, purpose: "ordinary_head_check" })).toMatchObject({purpose:"ordinary_head_check"});
    expect(CheckRetryCommandSchema.safeParse({ ...base, purpose: "caller_asserted_green" }).success).toBe(false);
  });

  it("derives the coverage receipt from canonical identity only — never a timestamp", () => {
    expect(deployCoverageReceipt({ tip_sha: "b".repeat(40), covered_by_run_id: 500 })).toBe(JSON.stringify(["b".repeat(40), 500, null]));
    // a missing decisive run id is its own receipt, not a guess
    expect(deployCoverageReceipt({ tip_sha: "b".repeat(40), covered_by_run_id: null })).toBe(JSON.stringify(["b".repeat(40), null, null]));
    // a NEW successful run on the SAME sha is a CHANGED receipt
    expect(deployCoverageReceipt({ tip_sha: "b".repeat(40), covered_by_run_id: 501 }))
      .not.toBe(deployCoverageReceipt({ tip_sha: "b".repeat(40), covered_by_run_id: 500 }));
    // a SAME-run rerun (a new attempt of the same run id — GitHub reruns
    // create one) is a CHANGED receipt too: it can recover the gate, so it
    // never silently reuses the consumed budget of the earlier attempt.
    expect(deployCoverageReceipt({ tip_sha: "b".repeat(40), covered_by_run_id: 500, covered_by_run_attempt: 2 }))
      .not.toBe(deployCoverageReceipt({ tip_sha: "b".repeat(40), covered_by_run_id: 500, covered_by_run_attempt: 1 }));
    expect(deployCoverageReceipt({ tip_sha: "b".repeat(40), covered_by_run_id: 500, covered_by_run_attempt: 1 }))
      .toBe(JSON.stringify(["b".repeat(40), 500, 1]));
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