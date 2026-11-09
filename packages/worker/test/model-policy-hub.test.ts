import { Miniflare } from "miniflare";
import { realpathSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { ExecutionStateSchema, type ExecutionModelView } from "@bridge/contracts";
import { executorRequest } from "./executor-fixture";

let mf: Miniflare;
let stub: { fetch(url: string, init: RequestInit): Promise<Response> };
interface Reply {
  error?: string; id: string; secret: string; token_id: string; ok: boolean; status: string; verify_task: string;
  meta: { execution_scheduling_requirements: { tier: string }; execution_blockers: unknown[] };
  execution: ExecutionModelView;
  versions: { action: string; summary: string; data: Record<string, unknown> }[];
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
  const provisioned = await post("agent.provision", { actor: label, label: `${label}/worker` });
  const worker = { actor: `${label}/worker`, token_id: provisioned.id, gateway: false };
  const base = { actor: label, token_id: identity.token_id, gateway: true, agent: `${label}/worker`, session: "dispatch-impl-models" };
  const medium = { tier: "medium", backend: "opencode", model: "test/medium", tools: [], environment: [], projects: ["bridge"] };
  expect((await post("execution", { ...base, id: "gateway", command_id: "review-inventory", command: { kind: "advertise", capabilities: { ...medium, worker: { kind: "provisioned", label: `${label}/worker` }, alternatives: [{ ...medium, tier: "large", model: "test/large" }] } } })).ok).toBe(true);
  const parent = await post("create", { type: "task", title: "Implementation requiring better reasoning", roles: ["impl"], project: "bridge", qualified: true, actor: "author" });
  const auth = { ...base, id: parent.id };
  // Two actual failed generations plus a third deadline failure exhaust the
  // original strategy before the independent larger-model verdict.
  for (let generation=1;generation<=2;generation++) {
    expect((await post("transition",{...auth,to:"in_progress"})).error).toBeUndefined();
    const attempt_id=`prior-${generation}`;
    expect((await post("execution",{...auth,command_id:`prior-begin-${generation}`,command:{kind:"begin",attempt_id,worker:`${label}/worker`,action_budget_ms:60_000}})).error).toBeUndefined();
    const terminal={generation,attempt_id,writers:"process_group_empty",outcome:{kind:"failed",exit_code:1,stdout_tail:"Implementation attempt retained",stderr_tail:"Cross-system invariant unresolved"}};
    expect((await post("execution",{...auth,command_id:`prior-stop-${generation}`,command:{kind:"stopped",...terminal}})).error).toBeUndefined();
    expect((await post("execution",{...auth,command_id:`prior-final-${generation}`,command:{kind:"finalize",...terminal}})).error).toBeUndefined();
  }

  expect((await post("transition", { ...auth, to: "in_progress" })).error).toBeUndefined();
  expect((await post("execution", { ...auth, command_id: "impl-begin", command: { kind: "begin", attempt_id: "impl", worker: `${label}/worker`, action_budget_ms: 10_000 } })).error).toBeUndefined();
  await new Promise(resolve=>setTimeout(resolve,10_020));
  const expired=ExecutionStateSchema.parse(await post("execution",{...auth,command_id:"impl-deadline",command:{kind:"poll",generation:3,attempt_id:"impl"}}));
  expect(expired.budget_exhaustions).toBe(3);
  const terminal={generation:3,attempt_id:"impl",writers:"process_group_empty",outcome:{kind:"timed_out",exit_code:null,stdout_tail:"Partial implementation preserved",stderr_tail:"Deadline exceeded"}};
  await post("execution",{...auth,command_id:"impl-stopped",command:{kind:"stopped",...terminal}});
  const final=ExecutionStateSchema.parse(await post("execution",{...auth,command_id:"impl-final",command:{kind:"finalize",...terminal}}));
  expect(final.budget_exhaustions).toBe(3);
  const human=await post("admin.mint",{label:"recovery-owner",tags:[]});
  const who=await post("auth.identify",{bearer:human.secret});
  const recovery={actor:"recovery-owner",token_id:who.token_id,id:parent.id,session:"recover-preserved-implementation"};
  expect((await post("transition",{...recovery,to:"in_progress"})).error).toBeUndefined();
  const delivery=await post("transition",{...recovery,to:"in_review",note:"PR https://github.com/state-vector/bridge/pull/123 — preserved implementation needs independent assessment"});
  expect(delivery.error).toBeUndefined(); expect(delivery.verify_task).toBeTruthy();
  const reviewer = { ...base, id: delivery.verify_task, session: "dispatch-review-models" };
  expect((await post("transition", { ...reviewer, to: "in_progress" })).error).toBeUndefined();
  expect((await post("execution", { ...reviewer, command_id: "review-begin", command: { kind: "begin", attempt_id: "review", worker: `${label}/worker`, action_budget_ms: 60_000 } })).error).toBeUndefined();
  const result = await post("transition", { ...worker, id: delivery.verify_task, session: reviewer.session,
    execution_scope: { id: delivery.verify_task, generation: 1, attempt_id: "review" },
    to: "done", note: "Findings for https://github.com/state-vector/bridge/pull/123: deeper cross-system reasoning required; implementation is not accepted.", review_result: { kind: "stronger_implementation_required", task_id: parent.id, summary: "The implementation misses the cross-system invariant; retry with stronger reasoning." } });
  expect(result.error).toBeUndefined();
  const escalated = await post("get", { id: parent.id });
  expect(escalated.status).toBe("todo");
  expect(escalated.meta).toMatchObject({ execution_requirements: { tier: "large" }, execution_escalation: { kind: "review", tier: "large" } });
  const state = ExecutionStateSchema.parse(await post("execution", { ...auth, command_id: "read-delivery", command: { kind: "inspect" } }));
  expect(state.delivery).toMatchObject({ model: "test/medium", tier: "medium" });
  expect(state.budget_exhaustions).toBe(3);
  expect(state.retry_strategy).toMatchObject({kind:"larger_model",failures:0,minimum_tier:"large",source:"independent_review"});
  await post("update",{id:parent.id,meta:{execution_requirements:{tier:"medium",tools:[],environment:[]}}});
  expect((await post("get",{id:parent.id})).meta.execution_scheduling_requirements.tier).toBe("large");
  await post("execution",{...reviewer,command_id:"review-quiet",command:{kind:"quiesce",generation:1,attempt_id:"review",writers:"process_group_empty"}});
  const reservation=await post("execution",{...base,id:"gateway",command_id:"strategy-reserve",command:{kind:"schedule",mode:"reserve"}}) as unknown as {kind:string;task_id:string;session:string};
  expect(reservation).toMatchObject({kind:"reserved",task_id:parent.id});
  const downgrade=await post("execution",{...auth,session:reservation.session,command_id:"strategy-wrong-tier",command:{kind:"begin",attempt_id:"wrong-tier",worker:`${label}/worker`,action_budget_ms:60_000,selection:{backend:"opencode",model:"test/medium",tier:"medium"}}});
  expect(downgrade.error).toMatch(/tier|capability|requirement/);
  const resumed=ExecutionStateSchema.parse(await post("execution",{...auth,session:reservation.session,command_id:"strategy-begin",command:{kind:"begin",attempt_id:"large-continuation",worker:`${label}/worker`,action_budget_ms:60_000,selection:{backend:"opencode",model:"test/large",tier:"large"}}}));
  expect(resumed).toMatchObject({generation:4,budget_exhaustions:3,attempt:{executor:{tier:"large",model:"test/large"}}});
  expect((await post("get", { id: delivery.verify_task })).status).toBe("done");
  const history = await post("get_history", { id: parent.id, limit: 100 });
  expect(history.versions.filter(v => v.action === "execution" && v.data.kind === "model_escalated")).toEqual([
    expect.objectContaining({ data: expect.objectContaining({ from_tier: "medium", to_tier: "large", source: "review", review_id: delivery.verify_task }) }),
  ]);
},30_000);
afterAll(async () => { await mf?.dispose(); });

it("selects globally, binds the actual model, preserves review floors and blocks/restores explicit escalation", async () => {
  const label = "multi-model";
  const minted = await post("admin.mint", { label, tags: ["gateway"] });
  const identity = await post("auth.identify", { bearer: minted.secret });
  await post("agent.provision", { actor: label, label: `${label}/worker` });
  const base = { actor: label, token_id: identity.token_id, gateway: true, agent: `${label}/worker`, session: "dispatch-model-test" };
  const models = ["medium", "large"].map(tier => ({ tier, backend: "opencode", model: `test/${tier}`, tools: [], environment: [], config_revision: "models-v1", projects: ["bridge"] }));
  const advertise = (large: boolean, command_id: string) => post("execution", { ...base, id: "gateway", command_id, command: { kind: "advertise", capabilities: { ...models[0], inventory_revision: 2, worker: { kind: "provisioned", label: `${label}/worker` }, alternatives: large ? [models[1]] : [] } } });
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
  expect((await post("get", { id: impl.id })).execution.current).toMatchObject({ kind: "managed", tier: "medium", phase: "running", model: "test/medium" });
  const boardResponse = await stub.fetch("https://kb/board", { method: "GET" });
  const board = await boardResponse.json() as { tasks: { id: string; execution: ExecutionModelView }[] };
  expect(board.tasks.find(t => t.id === impl.id)?.execution.current).toMatchObject({ kind: "managed", tier: "medium", model: "test/medium" });
  const verify = await make("Verify actual delivery", ["review"], { execution_review_of: impl.id });
  expect((await post("get", { id: verify.id })).meta.execution_scheduling_requirements.tier).toBe("medium");
  const cmd = (command_id: string, command: object) => post("execution", { ...auth, command_id, command: { generation: 1, attempt_id: "one", ...command } });
  expect((await cmd("escalate", { kind: "escalate", tier: "large", reason: "Cross-system reasoning exceeds this execution" })).error).toBeUndefined();
  expect((await cmd("escalate", { kind: "escalate", tier: "large", reason: "Cross-system reasoning exceeds this execution" })).error).toBeUndefined(); // exact retry, one history event
  expect((await post("get", { id: impl.id })).execution).toMatchObject({ minimum_tier: "large", current: { tier: "medium", phase: "stopping" } });
  const escalationHistory = await post("get_history", { id: impl.id, limit: 100 });
  expect(escalationHistory.versions.filter(v => v.action === "execution" && v.data.kind === "model_escalated")).toHaveLength(1);
  expect(escalationHistory.versions).toEqual(expect.arrayContaining([expect.objectContaining({ data: expect.objectContaining({ kind: "model_started", tier: "medium", model: "test/medium" }) })]));
  const checkpoint = { repo: "https://github.com/state-vector/bridge", remote_ref: "refs/heads/bridge-checkpoints/models/1/1", commit: "a".repeat(40), tree: "b".repeat(40), base: "c".repeat(40), environment: [], next: "Continue implementation", tests: [] };
  await cmd("checkpoint", { kind: "checkpoint", checkpoint });
  await cmd("quiesce", { kind: "quiesce", writers: "process_group_empty" });
  expect((await cmd("yield", { kind: "yield" })).error).toBeUndefined();
  expect((await post("get_history", { id: impl.id, limit: 100 })).versions).toEqual(expect.arrayContaining([expect.objectContaining({ data: expect.objectContaining({ kind: "execution_yielded", destination: "agent_pool", minimum_tier: "large" }) })]));
  await advertise(false, "remove-large");
  await post("admin.execution_sweep", {});
  const blocked = await post("get", { id: impl.id });
  expect(blocked.status).toBe("blocked");
  expect(blocked.meta.execution_blockers).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "capability_unavailable", reason: "not_configured" })]));
  expect((await post("execution", { ...auth, command_id: "old-writer", command: { kind: "escalate", generation: 1, attempt_id: "one", tier: "large", reason: "Late old writer" } })).error).toMatch(/claim|session/);
  await advertise(true, "restore-large");
  await post("admin.execution_sweep", {});
  expect((await post("get", { id: impl.id })).status).toBe("todo");
  expect((await post("transition", { ...auth, to: "in_progress" })).error).toBeUndefined();
  const wrong = await post("execution", { ...auth, command_id: "wrong-model", command: { kind: "begin", attempt_id: "two", worker: `${label}/worker`, action_budget_ms: 60_000, selection: { backend: "opencode", model: "test/medium", tier: "medium" } } });
  expect(wrong.error).toMatch(/capability blockers/);
  const obsolete = await post("execution", { ...auth, inventory_protocol: undefined, command_id: "obsolete-selection", command: { kind: "begin", attempt_id: "two", worker: `${label}/worker`, action_budget_ms: 60_000, selection: { backend: "opencode", model: "test/large", tier: "large" } } });
  expect(obsolete.error).toMatch(/scoped-inventory runner protocol/);
  const next = await post("execution", { ...auth, command_id: "large-begin", command: { kind: "begin", attempt_id: "two", worker: `${label}/worker`, action_budget_ms: 60_000, selection: { backend: "opencode", model: "test/large", tier: "large" } } });
  expect(next.error).toBeUndefined();
  expect(ExecutionStateSchema.parse(next).attempt?.executor).toMatchObject({ model: "test/large", tier: "large", inventory_revision: 2 });
  expect((await post("get", { id: verify.id })).meta.execution_scheduling_requirements.tier).toBe("large");
  expect((await post("admin.settings_set", { settings: { model_policy: { impl: { kind: "minimum", tier: "large" } } } })).error).toBeUndefined();
  expect((await post("get", { id: (await make("Global override", ["impl"])).id })).meta.execution_scheduling_requirements.tier).toBe("large");
  expect((await post("admin.settings_set", { settings: { model_policy: { impl: { kind: "nonsense" } } } })).error).toBeDefined();
});
