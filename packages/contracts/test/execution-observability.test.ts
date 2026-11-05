import { expect, it } from "vitest";
import { initialExecution, reduceExecution, ExecutorCapabilitiesSchema, projectExecutionModel, executionCommandHistory, executionHistorySummary } from "../src/index.ts";

function running() {
  const state = reduceExecution(initialExecution(), { kind: "begin", attempt_id: "one", worker: "host/worker", action_budget_ms: 60_000 }, "host", "session", 1_000);
  state.attempt!.executor = ExecutorCapabilitiesSchema.parse({ tier: "medium", model: "provider/glm", tools: [], environment: [] });
  return state;
}
it("never labels a required tier as an actual model and expires live observations", () => {
  expect(projectExecutionModel(null, { status: "in_progress", requirements: { tier: "large" } }, 1_000)).toEqual({ minimum_tier: "large", current: { kind: "unreported" } });
  const state = running();
  const task = { status: "in_progress", session: "session", requirements: { tier: "large" } };
  expect(projectExecutionModel(state, task, 2_000)).toMatchObject({ minimum_tier: "large", current: { kind: "managed", tier: "medium", model: "provider/glm", phase: "running" } });
  expect(projectExecutionModel(state, task, 200_000).current).toMatchObject({ phase: "expired" });
  expect(projectExecutionModel(state, { ...task, session: "new-session" }, 2_000).current).toMatchObject({ phase: "previous" });
  expect(projectExecutionModel(state, { ...task, status: "blocked" }, 2_000).current).toMatchObject({ phase: "paused" });
  state.attempt!.phase = "quiesced";
  expect(projectExecutionModel(state, task, 200_000).current).toMatchObject({ phase: "quiesced" });
});
it("records actual model selection, escalation reason/from/to, and omits poll noise", () => {
  const before = running();
  const command = { kind: "escalate" as const, generation: 1, attempt_id: "one", tier: "large" as const, reason: "Cross-system invariant exceeds current reasoning" };
  const after = reduceExecution(before, command, "host", "session", 2_000);
  const event = executionCommandHistory(before, after, command);
  expect(event).toMatchObject({ kind: "model_escalated", from_tier: "medium", to_tier: "large", reason: command.reason, source: "agent" });
  expect(executionHistorySummary(event!)).toContain(command.reason);
  expect(executionCommandHistory(before, after, { kind: "poll", generation: 1, attempt_id: "one" })).toBeNull();
});
