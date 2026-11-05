import { describe, expect, it } from "vitest";
import { RecoveryEventSchema, reduceRecoveryEpisode, recoveryEpisodeKey, verifyRecoveryEpisode,
  type RecoveryCause, type RecoveryEpisode, type RecoveryEvent } from "@bridge/contracts";

const head = "7".repeat(40);
const cause: RecoveryCause = { kind: "capability_unavailable", check: "Cortex Quality Smoke", scenario: "php-sql-injection", capability: "callers", scope: "includes/User/User.php:2416" };
const source = { head_sha: head, run_id: 41926939169, run_attempt: 5, url: "https://github.com/o/r/actions/runs/41926939169/job/1" };
const initial = () => reduceRecoveryEpisode(undefined, { head_sha: head, cause, event_id: "observed-5", actor: "observer", now: 100,
  event: { kind: "observed", task_id: "BR#6494", source, next: "Diagnose callers latency" } });
const apply = (previous: RecoveryEpisode, event_id: string, event: RecoveryEvent) => reduceRecoveryEpisode(previous, { head_sha: head, cause, event_id, event, actor: "repairer", now: 200 + previous.history.length });

describe("durable cause-specific recovery loop", () => {
  it("workflow retries are observations of the same incident, while independent failures remain separate", () => {
    const first = initial();
    const again = apply(first, "observed-6", { kind: "observed", task_id: "BR#6494", source: { ...source, run_attempt: 6 }, next: "Repair callers" });
    expect(again.id).toBe(first.id);
    expect(again.sources).toHaveLength(2);
    expect(again.attempts).toHaveLength(0); // observing a run is not a repair action
    expect(recoveryEpisodeKey(head, { ...cause, scope: "includes/User/User.php:2420" })).toBe(first.id);
    expect(recoveryEpisodeKey(head, { kind: "test_failure", check: cause.check, suite: "classifier_integration", test: "smoke::chat_honest_refusal" })).not.toBe(first.id);
  });
  it("retry budgets survive serialization, process restarts and changed attempt IDs", () => {
    let episode = apply(initial(), "retry-1", { kind: "attempt_started", task_id: "BR#6494", attempt_id: "r1", attempt_kind: "retry", action: "Re-run smoke", next: "Observe result" });
    episode = apply(episode, "result-1", { kind: "attempt_finished", task_id: "BR#6494", attempt_id: "r1", outcome: "failed", summary: "callers still times out", receipts: [source.url], next: "Repair adjacency read" });
    episode = JSON.parse(JSON.stringify(episode));
    episode = apply(episode, "retry-2", { kind: "attempt_started", task_id: "BR#6494", attempt_id: "different-id", attempt_kind: "retry", action: "Try again", next: "Observe result" });
    expect(episode.stage.phase).toBe("exhausted");
    expect(episode.attempts).toHaveLength(1);
    expect(episode.history.at(-1)?.summary).toContain("Retry denied");
  });
  it("duplicate command receipts never execute twice", () => {
    const event: RecoveryEvent = { kind: "attempt_started", task_id: "BR#6494", attempt_id: "repair-1", attempt_kind: "repair", action: "Run query regressions", next: "Read regression result" };
    const first = apply(initial(), "command-1", event);
    expect(apply(first, "command-1", event)).toBe(first);
    expect(first.attempts).toHaveLength(1);
  });
  it("code delivery and task completion only start verification, never recovery", () => {
    let episode = apply(initial(), "repair-1", { kind: "attempt_started", task_id: "BR#6494", attempt_id: "repair", attempt_kind: "repair", action: "Implement adjacency pruning", next: "Publish fix" });
    episode = apply(episode, "delivered", { kind: "attempt_finished", task_id: "BR#6494", attempt_id: "repair", outcome: "delivered", summary: "Fix published", receipts: ["https://github.com/o/r/commit/123"], next: "Deploy" });
    expect(episode.stage.phase).toBe("verifying");
    episode = apply(episode, "task-done", { kind: "delivery_submitted", task_id: "BR#6494" });
    expect(episode.stage.phase).toBe("verifying");
    expect(RecoveryEventSchema.safeParse({ kind: "recovered", task_id: "BR#6494" }).success).toBe(false);
    expect(RecoveryEventSchema.safeParse({ kind: "executor_assigned", task_id: "BR#6494" }).success).toBe(false);
  });
  it("an outcome requires an actual running attempt and bound repair ownership", () => {
    expect(() => apply(initial(), "result", { kind: "attempt_finished", task_id: "BR#6494", attempt_id: "missing", outcome: "delivered", summary: "done", receipts: [], next: "Verify" })).toThrow("running attempt");
    expect(() => apply(initial(), "wrong", { kind: "progress", task_id: "BR#6482", did: "working", next: "Test" })).toThrow("bound repair task");
  });
  it("only verified deployment evidence recovers; stale observations cannot reopen, but a genuine relapse can", () => {
    const verified = verifyRecoveryEpisode(initial(), { ...source, run_attempt: 6 }, 300);
    expect(verified.stage.phase).toBe("recovered");
    const stale = apply(verified, "late-failure-5", { kind: "observed", task_id: "BR#6494", source, next: "Diagnose" });
    expect(stale.stage.phase).toBe("recovered");
    const relapse = apply(verified, "failure-7", { kind: "observed", task_id: "BR#6494", source: { ...source, run_attempt: 7 }, next: "Investigate relapse" });
    expect(relapse.stage.phase).toBe("diagnosing");
    expect(relapse.history.length).toBeGreaterThan(verified.history.length);
  });
  it("honors a multi-deployment stability bar without counting polls as new proof", () => {
    let episode = reduceRecoveryEpisode(undefined, { head_sha: head, cause, event_id: "stability", actor: "observer", now: 1,
      event: { kind: "observed", task_id: "BR#6494", source, next: "Prove stable service", successful_deployments_required: 3 } });
    episode = verifyRecoveryEpisode(episode, { ...source, run_id: source.run_id + 1, run_attempt: 1 }, 300);
    expect(episode.stage.phase).toBe("verifying");
    episode = verifyRecoveryEpisode(episode, { ...source, run_id: source.run_id + 1, run_attempt: 1 }, 301);
    expect(episode.verified_receipts).toHaveLength(1);
    episode = verifyRecoveryEpisode(episode, { ...source, run_id: source.run_id + 2, run_attempt: 1 }, 302);
    episode = verifyRecoveryEpisode(episode, { ...source, run_id: source.run_id + 3, run_attempt: 1 }, 303);
    expect(episode.stage.phase).toBe("recovered");
  });
});
