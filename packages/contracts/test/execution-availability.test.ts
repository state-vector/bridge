import { describe, expect, it } from "vitest";
import { ExecutorCapabilitiesSchema, ExecutionRequirementsSchema, initialExecution, projectExecutionBlockers, reduceExecution } from "../src/index.ts";
import type { ExecutorReadiness } from "../src/index.ts";

const required = ExecutionRequirementsSchema.parse({ tier: "large", tools: ["cargo"], environment: ["dev-access"] });
const capabilities = ExecutorCapabilitiesSchema.parse({ tier: "large", model: "test/large", tools: ["cargo"], environment: ["dev-access"], projects: ["bridge"] });
const base = { id: "BR#1", project: "bridge", requirements: required, handoff: { phase: "none" as const }, hosts: [], asks: [], now: 200_000 };
describe("composable execution blockers", () => {
  const holds: Exclude<ExecutorReadiness, { kind: "ready" }>[] = [
    { kind: "paused", reason: "Operator paused new claims", until_ts: 300_000 },
    { kind: "updating", reason: "Controller update handoff" },
    { kind: "cooldown", reason: "Transport retry backoff", until_ts: 300_000 },
    { kind: "repair_required", reason: "Identity needs repair" },
    { kind: "task_prerequisite", reason: "Repository input needs repair" },
    { kind: "unprovisioned", reason: "Worker credential is absent" },
    { kind: "draining", reason: "Gateway is retired from admission" },
  ];
  it.each(holds)("retains typed $kind readiness without inventing model absence or human action", readiness => {
    const blockers = projectExecutionBlockers({ ...base, hosts: [{ host: "host", observed_at: base.now, active: 0, capabilities, readiness }] });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({ kind: "executor_not_ready", causes: [{ host: "host", readiness }], text: expect.stringContaining(readiness.reason) });
  });
  it("clears a held host blocker when another matching host is genuinely ready", () => {
    expect(projectExecutionBlockers({ ...base, hosts: [
      { host: "held", observed_at: base.now, active: 0, capabilities, readiness: holds[0] },
      { host: "ready", observed_at: base.now, active: 0, capabilities, readiness: { kind: "ready", worker_id: "worker", fingerprint: "proof" } },
    ] })).toEqual([]);
  });
  it("distinguishes unconfigured, offline, unavailable and busy without downgrading or a human ask", () => {
    expect(projectExecutionBlockers(base)[0]).toMatchObject({ reason: "not_configured" });
    const host = { host: "host", capabilities, observed_at: 1, active: 0 };
    expect(projectExecutionBlockers({ ...base, hosts: [host] })[0]).toMatchObject({ reason: "offline" });
    expect(projectExecutionBlockers({ ...base, hosts: [{ ...host, observed_at: base.now, capabilities: { ...capabilities, availability: { kind: "unavailable", reason: "Model auth expired" } } }] })[0]).toMatchObject({ reason: "unavailable" });
    expect(projectExecutionBlockers({ ...base, hosts: [{ ...host, observed_at: base.now, active: 1 }] })[0]).toMatchObject({ kind: "capacity_wait" });
    expect(projectExecutionBlockers({ ...base, hosts: [{ ...host, observed_at: base.now }] })).toEqual([]);
  });
  it("does not equate unreported model identity, disabled configuration or another project with runnable capacity", () => {
    const host = { host: "host", observed_at: base.now, active: 0, capabilities };
    expect(projectExecutionBlockers({ ...base, hosts: [{ ...host, capabilities: { ...capabilities, model: null } }] })[0]).toMatchObject({ reason: "unavailable" });
    expect(projectExecutionBlockers({ ...base, hosts: [{ ...host, capabilities: { ...capabilities, availability: { kind: "disabled" } } }] })[0]).toMatchObject({ reason: "not_configured" });
    expect(projectExecutionBlockers({ ...base, project: "other", hosts: [host] })[0]).toMatchObject({ reason: "not_configured" });
  });
  it("keeps human, local and model blockers independent, including an explicit local host constraint", () => {
    let state = reduceExecution(initialExecution(required), { kind: "begin", attempt_id: "a", worker: "gw/agent", action_budget_ms: 60_000 }, "gw", "dispatch-1", 1);
    state = reduceExecution(state, { kind: "local_handoff", generation: 1, attempt_id: "a", reason: "Local dataset required", action: "Recover dataset", findings: "Snapshot inspected", tried: "Remote restoration attempted", next: "Restore locally", evidence: ["run/1"], approvals: [], recipient: null }, "gw", "dispatch-1", 2);
    const blocked = projectExecutionBlockers({ ...base, handoff: state.handoff, asks: [{ id: "BR#2", question: "Which dataset?" }] });
    expect(blocked.map(b => b.kind)).toEqual(["capability_unavailable", "human_answer_required", "writer_quiescence_required"]);
    expect(() => reduceExecution(state, { kind: "begin", attempt_id: "b", worker: "other/agent", action_budget_ms: 60_000 }, "other", "new", 3)).toThrow(/local handoff/);
    expect(projectExecutionBlockers({ ...base, requirements: { ...required, host: "mac" }, local: { host: "linux", capabilities } })[0]).toMatchObject({ kind: "capability_unavailable" });
  });
});
