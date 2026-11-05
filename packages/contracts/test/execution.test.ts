import { describe, expect, it } from "vitest";
import { capabilityBlockers, initialExecution, reduceExecution, nextExecutorStartBarrier, type Checkpoint, type ExecutionCommand, type ExecutionState } from "../src/execution.ts";
import { continueRecoveryLineage, reduceRecoveryEpisode, type RecoveryCause } from "../src/train-recovery.ts";

const cp: Checkpoint = { repo: "https://github.com/state-vector/bridge.git", remote_ref: "refs/heads/bridge-checkpoints/BR-1/1/1", commit: "a".repeat(40), tree: "b".repeat(40), base: "c".repeat(40), environment: ["linux"], next: "Run failing integration test", tests: [] };
const begin = { kind: "begin", attempt_id: "one", worker: "mac/worker", action_budget_ms: 60_000 } as const;
const fence = { generation: 1, attempt_id: "one" };
const step = (s: ExecutionState, c: ExecutionCommand, now = 100, host = "mac", session = "dispatch-BR-1") => reduceExecution(s, c, host, session, now);
const started = () => step(initialExecution(), begin);

describe("durable execution failure boundaries", () => {
  it("bounds unstarted failures across restarts; only changed prerequisites reset their budget", () => {
    const one = nextExecutorStartBarrier(null, "worker/config-one", "begin refused", 100);
    expect(one).toMatchObject({ kind: "cooldown", failures: 1, until_ts: 60_100 });
    const two = nextExecutorStartBarrier(JSON.parse(JSON.stringify(one)), "worker/config-one", "still refused", 70_000);
    expect(two).toMatchObject({ kind: "cooldown", failures: 2, until_ts: 190_000 });
    const three = nextExecutorStartBarrier(two, "worker/config-one", "still refused", 200_000);
    expect(three).toMatchObject({ kind: "repair_required", failures: 3 });
    expect(nextExecutorStartBarrier(null, "worker/config-one", "gate: prerequisite missing", 100, "prerequisite")).toMatchObject({ kind: "repair_required", failures: 1 });
    expect(nextExecutorStartBarrier(three, "worker/config-repaired", "new prerequisite failure", 300_000)).toMatchObject({ kind: "cooldown", failures: 1 });
    expect(() => step(started(), { kind: "start_failed", stage: "begin", reason: "unknown start outcome", retained_work: false, failure_class: "transport" })).toThrow(/unquiesced/);
  });
  it("keeps a fault's retry budget/history across unrelated commits without carrying verification coverage", () => {
    const cause: RecoveryCause = { kind: "check_failure", check: "Smoke" };
    let episode = reduceRecoveryEpisode(undefined, { head_sha: cp.base, cause, event_id: "failed", actor: "runner", now: 1,
      event: { kind: "observed", task_id: "BR#1", source: { head_sha: cp.base, run_id: 1, run_attempt: 1, url: "https://github.com/state-vector/bridge/actions/runs/1" }, next: "Inspect" } });
    episode = reduceRecoveryEpisode(episode, { head_sha: cp.base, cause, event_id: "retry", actor: "runner", now: 2,
      event: { kind: "attempt_started", task_id: "BR#1", attempt_id: "retry-one", attempt_kind: "retry", action: "Retry", next: "Check" } });
    episode = reduceRecoveryEpisode(episode, { head_sha: cp.base, cause, event_id: "retry-result", actor: "runner", now: 3,
      event: { kind: "attempt_finished", task_id: "BR#1", attempt_id: "retry-one", outcome: "failed", summary: "Still red", receipts: [], next: "Repair" } });
    const continued = continueRecoveryLineage(episode, cp.commit, "BR#1", 4);
    expect(continued.lineage_id).toBe(episode.id);
    expect(continued.attempts).toEqual(episode.attempts);
    expect(continued.verified_receipts).toEqual([]);
    const denied = reduceRecoveryEpisode(continued, { head_sha: cp.commit, cause, event_id: "new-sha-blind-retry", actor: "other-host", now: 5,
      event: { kind: "attempt_started", task_id: "BR#1", attempt_id: "retry-two", attempt_kind: "retry", action: "Retry", next: "Check" } });
    expect(denied.stage.phase).toBe("exhausted");
  });
  it("does not let lease expiry or host death imply writer quiescence", () => {
    const s = started();
    expect(() => step(s, { ...begin, attempt_id: "two" }, 1_000_000, "linux")).toThrow(/quiescence/);
    expect(() => step(s, { kind: "poll", ...fence }, 1_000_000)).toThrow(/expired/);
    expect(() => step(s, { kind: "quiesce", ...fence, writers: "process_group_empty" }, 1_000_000, "linux")).toThrow(/fenced/);
  });
  it("retains host affinity without a portable checkpoint", () => {
    const s = step(started(), { kind: "quiesce", ...fence, writers: "process_group_empty" });
    expect(() => step(s, { ...begin, attempt_id: "two" }, 200, "linux")).toThrow(/published checkpoint/);
  });
  it("requires exact restoration before starting a replacement writer and fences the old generation", () => {
    let s = step(started(), { kind: "checkpoint", ...fence, checkpoint: cp });
    s = step(s, { kind: "quiesce", ...fence, writers: "process_group_empty" });
    s = step(s, { ...begin, attempt_id: "two" }, 200, "linux");
    expect(s.attempt?.phase).toBe("restoring");
    expect(() => step(s, { kind: "prepare", generation: 2, attempt_id: "two", operation_id: "push", action: "push", input_revision: cp.commit, budget_ms: 1000 }, 200, "linux")).toThrow(/pending interruption/);
    expect(() => step(s, { kind: "restore", generation: 2, attempt_id: "two", tree: "d".repeat(40), commit: cp.commit }, 200, "linux")).toThrow(/exact commit and tree/);
    s = step(s, { kind: "restore", generation: 2, attempt_id: "two", tree: cp.tree, commit: cp.commit }, 200, "linux");
    expect(s.attempt?.phase).toBe("running");
    expect(() => step(s, { kind: "checkpoint", ...fence, checkpoint: cp })).toThrow(/fenced/);
  });
  it("rejects content-unbound test evidence", () => {
    expect(() => step(started(), { kind: "checkpoint", ...fence, checkpoint: { ...cp, tests: [{ tree: cp.base, command: "test", outcome: "passed", receipt: "run/1" }] } })).toThrow(/evidence/);
  });
  it("delivers, acknowledges and acts upon coordination in order; interruption gates mutations", () => {
    let s = step(started(), { kind: "message", message_id: "stop", text: "Use the published repair", priority: "interrupt" });
    expect(s.attempt?.phase).toBe("stopping");
    expect(() => step(s, { kind: "ack", ...fence, message_id: "stop", state: "acted" })).toThrow(/delivery/);
    s = step(s, { kind: "poll", ...fence });
    expect(s.messages[0].state).toBe("delivered");
    expect(() => step(s, { kind: "ack", ...fence, message_id: "stop", state: "acted" })).toThrow(/acknowledgement/);
    s = step(s, { kind: "ack", ...fence, message_id: "stop", state: "acknowledged" });
    s = step(s, { kind: "ack", ...fence, message_id: "stop", state: "acted" });
    expect(s.messages[0].state).toBe("acted");
  });
  it("retains unknown external effects across attempts and forbids blind re-execution", () => {
    let s = step(started(), { kind: "prepare", ...fence, operation_id: "deploy", action: "Deploy exact SHA", input_revision: cp.commit, budget_ms: 1000 });
    s = step(s, { kind: "poll", ...fence }, 1200);
    expect(s.operations[0].state).toBe("outcome_unknown");
    s = step(s, { kind: "quiesce", ...fence, writers: "process_group_empty" }, 1200);
    expect(() => step(s, { ...begin, attempt_id: "two" }, 1200)).toThrow(/unknown external/);
    s = step(s, { kind: "result", ...fence, operation_id: "deploy", outcome: "succeeded", receipts: ["https://github.com/state-vector/bridge/actions/runs/1"] }, 1200);
    expect(s.operations[0].state).toBe("succeeded");
  });
  it("persists a higher reasoning minimum and requires checkpoint/quiescence before yield", () => {
    let s = step(started(), { kind: "escalate", ...fence, tier: "large", reason: "Two failed proof attempts at medium reasoning" });
    expect(s.requirements.tier).toBe("large");
    expect(() => step(s, { kind: "yield", ...fence })).toThrow(/quiescent/);
    expect(() => step(s, { kind: "escalate", ...fence, tier: "small", reason: "downgrade" })).toThrow(/increase/);
    s = step(s, { kind: "checkpoint", ...fence, checkpoint: cp });
    s = step(s, { kind: "quiesce", ...fence, writers: "process_group_empty" });
    expect(step(s, { kind: "yield", ...fence }).requirements.tier).toBe("large");
  });
  it("composes live capability blockers without mistaking an installed CLI for cloud access", () => {
    expect(capabilityBlockers({ tier: "large", tools: ["cargo"], environment: ["aws:prod:write"], host: "mac" }, { tier: "small", tools: ["aws"], environment: ["linux"] }, "linux")).toEqual(["reasoning:large", "tool:cargo", "environment:aws:prod:write", "host:mac"]);
  });
  it("enforces an action budget even with constant transport output", () => {
    let s = step(started(), { kind: "poll", ...fence }, 60_101);
    expect(s.attempt?.phase).toBe("stopping");
    expect(s.budget_exhaustions).toBe(1);
    s = step(s, { kind: "poll", ...fence }, 60_102);
    expect(s.budget_exhaustions).toBe(1);
  });
});
