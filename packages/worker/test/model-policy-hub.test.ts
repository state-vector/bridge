import { Miniflare } from "miniflare";
import { realpathSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { ExecutionStateSchema } from "@bridge/contracts";
import { executorRequest } from "./executor-fixture";

let mf: Miniflare;
let stub: { fetch(url: string, init: RequestInit): Promise<Response> };
interface Reply {
  error?: string; id: string; secret: string; token_id: string; ok: boolean; status: string; verify_task: string;
  meta: { execution_scheduling_requirements: { tier: string }; execution_blockers: unknown[] };
}
async function post(op: string, body: object): Promise<Reply> {
  const response = await stub.fetch(`https://kb/${op}`, { method: "POST", headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify(executorRequest(body)) });
  return await response.json() as Reply;
}
beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  mf = new Miniflare({ workers: [{ name: "main", scriptPath: bundle, modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")), modules: true, compatibilityDate: "2025-09-06", durableObjects: { HUB: { className: "FlowsHub", useSQLite: true }, KB: { className: "KnowledgeHub", useSQLite: true } } }] });
});
beforeEach(async () => {
  const ns = await mf.getDurableObjectNamespace("KB");
  stub = await ns.get(ns.idFromName(crypto.randomUUID())) as unknown as typeof stub;
});

it("atomically closes a stronger-implementation verdict and requeues its idle subject without acceptance", async () => {
  await post("admin.settings_set", { settings: { model_policy: {} } });
  const label = "review-models";
  const minted = await post("admin.mint", { label, tags: ["gateway"] });
  const identity = await post("auth.identify", { bearer: minted.secret });
  await post("agent.provision", { actor: label, label: `${label}/worker` });
  const base = { actor: label, token_id: identity.token_id, gateway: true, agent: `${label}/worker`, session: "dispatch-impl-models" };
  const medium = { tier: "medium", backend: "opencode", model: "test/medium", tools: [], environment: [], projects: ["bridge"] };
  expect((await post("execution", { ...base, id: "gateway", command_id: "review-inventory", command: { kind: "advertise", capabilities: { ...medium, worker: { kind: "provisioned", label: `${label}/worker` }, alternatives: [{ ...medium, tier: "large", model: "test/large" }] } } })).ok).toBe(true);
  const parent = await post("create", { type: "task", title: "Implementation requiring better reasoning", roles: ["impl"], project: "bridge", qualified: true, actor: "author" });
  const auth = { ...base, id: parent.id };
  expect((await post("transition", { ...auth, to: "in_progress" })).error).toBeUndefined();
  expect((await post("execution", { ...auth, command_id: "impl-begin", command: { kind: "begin", attempt_id: "impl", worker: `${label}/worker`, action_budget_ms: 60_000 } })).error).toBeUndefined();
  await post("execution", { ...auth, command_id: "impl-quiet", command: { kind: "quiesce", generation: 1, attempt_id: "impl", writers: "process_group_empty" } });
  const delivery = await post("transition", { ...auth, to: "in_review", note: "PR https://github.com/state-vector/bridge/pull/123 — implementation delivered; request independent verification" });
  expect(delivery.error).toBeUndefined();
  expect(delivery.verify_task).toBeTruthy();
  const reviewer = { ...base, id: delivery.verify_task, session: "dispatch-review-models" };
  expect((await post("transition", { ...reviewer, to: "in_progress" })).error).toBeUndefined();
  const result = await post("transition", { ...reviewer, to: "done", note: "Findings for https://github.com/state-vector/bridge/pull/123: deeper cross-system reasoning required; implementation is not accepted.", review_result: { kind: "stronger_implementation_required", task_id: parent.id, summary: "The implementation misses the cross-system invariant; retry with stronger reasoning." } });
  expect(result.error).toBeUndefined();
  const escalated = await post("get", { id: parent.id });
  expect(escalated.status).toBe("todo");
  expect(escalated.meta).toMatchObject({ execution_requirements: { tier: "large" }, execution_escalation: { kind: "review", tier: "large" } });
  const state = ExecutionStateSchema.parse(await post("execution", { ...auth, command_id: "read-delivery", command: { kind: "inspect" } }));
  expect(state.delivery).toMatchObject({ model: "test/medium", tier: "medium" });
  expect((await post("get", { id: delivery.verify_task })).status).toBe("done");
});
afterAll(async () => { await mf?.dispose(); });

it("selects globally, binds the actual model, preserves review floors and blocks/restores explicit escalation", async () => {
  const label = "multi-model";
  const minted = await post("admin.mint", { label, tags: ["gateway"] });
  const identity = await post("auth.identify", { bearer: minted.secret });
  await post("agent.provision", { actor: label, label: `${label}/worker` });
  const base = { actor: label, token_id: identity.token_id, gateway: true, agent: `${label}/worker`, session: "dispatch-model-test" };
  const models = ["medium", "large"].map(tier => ({ tier, backend: "opencode", model: `test/${tier}`, tools: [], environment: [], config_revision: "models-v1", projects: ["bridge"] }));
  const advertise = (large: boolean, command_id: string) => post("execution", { ...base, id: "gateway", command_id, command: { kind: "advertise", capabilities: { ...models[0], worker: { kind: "provisioned", label: `${label}/worker` }, alternatives: large ? [models[1]] : [] } } });
  expect((await advertise(true, "inventory")).ok).toBe(true);
  const make = (title: string, roles: string[], meta = {}) => post("create", { type: "task", title, roles, meta, project: "bridge", qualified: true, actor: "author" });
  const analysis = await make("Scope complex change", ["analysis"]);
  expect((await post("get", { id: analysis.id })).meta.execution_scheduling_requirements.tier).toBe("large");
  const impl = await make("Implement scoped change", ["impl"]);
  expect((await post("get", { id: impl.id })).meta.execution_scheduling_requirements.tier).toBe("medium");
  const auth = { ...base, id: impl.id };
  expect((await post("transition", { ...auth, to: "in_progress" })).error).toBeUndefined();
  const begin = await post("execution", { ...auth, command_id: "begin", command: { kind: "begin", attempt_id: "one", worker: `${label}/worker`, action_budget_ms: 60_000, selection: { backend: "opencode", model: "test/medium", tier: "medium" } } });
  expect(begin.error).toBeUndefined();
  expect(ExecutionStateSchema.parse(begin).attempt?.executor).toMatchObject({ model: "test/medium", tier: "medium" });
  const verify = await make("Verify actual delivery", ["review"], { execution_review_of: impl.id });
  expect((await post("get", { id: verify.id })).meta.execution_scheduling_requirements.tier).toBe("medium");
  const cmd = (command_id: string, command: object) => post("execution", { ...auth, command_id, command: { generation: 1, attempt_id: "one", ...command } });
  expect((await cmd("escalate", { kind: "escalate", tier: "large", reason: "Cross-system reasoning exceeds this execution" })).error).toBeUndefined();
  const checkpoint = { repo: "https://github.com/state-vector/bridge", remote_ref: "refs/heads/bridge-checkpoints/models/1/1", commit: "a".repeat(40), tree: "b".repeat(40), base: "c".repeat(40), environment: [], next: "Continue implementation", tests: [] };
  await cmd("checkpoint", { kind: "checkpoint", checkpoint });
  await cmd("quiesce", { kind: "quiesce", writers: "process_group_empty" });
  expect((await cmd("yield", { kind: "yield" })).error).toBeUndefined();
  await advertise(false, "remove-large");
  const blocked = await post("get", { id: impl.id });
  expect(blocked.status).toBe("blocked");
  expect(blocked.meta.execution_blockers).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "capability_unavailable", reason: "not_configured" })]));
  expect((await post("execution", { ...auth, command_id: "old-writer", command: { kind: "escalate", generation: 1, attempt_id: "one", tier: "large", reason: "Late old writer" } })).error).toMatch(/claim|session/);
  await advertise(true, "restore-large");
  expect((await post("get", { id: impl.id })).status).toBe("todo");
  expect((await post("transition", { ...auth, to: "in_progress" })).error).toBeUndefined();
  const wrong = await post("execution", { ...auth, command_id: "wrong-model", command: { kind: "begin", attempt_id: "two", worker: `${label}/worker`, action_budget_ms: 60_000, selection: { backend: "opencode", model: "test/medium", tier: "medium" } } });
  expect(wrong.error).toMatch(/capability blockers/);
  const next = await post("execution", { ...auth, command_id: "large-begin", command: { kind: "begin", attempt_id: "two", worker: `${label}/worker`, action_budget_ms: 60_000, selection: { backend: "opencode", model: "test/large", tier: "large" } } });
  expect(next.error).toBeUndefined();
  expect(ExecutionStateSchema.parse(next).attempt?.executor).toMatchObject({ model: "test/large", tier: "large" });
  expect((await post("get", { id: verify.id })).meta.execution_scheduling_requirements.tier).toBe("large");
  expect((await post("admin.settings_set", { settings: { model_policy: { impl: { kind: "minimum", tier: "large" } } } })).error).toBeUndefined();
  expect((await post("get", { id: (await make("Global override", ["impl"])).id })).meta.execution_scheduling_requirements.tier).toBe("large");
  expect((await post("admin.settings_set", { settings: { model_policy: { impl: { kind: "nonsense" } } } })).error).toBeDefined();
});
