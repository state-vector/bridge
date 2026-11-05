import { Miniflare } from "miniflare";
import { realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExecutionStateSchema } from "@bridge/contracts";

let mf: Miniflare;
let stub: { fetch: (url: string, init: RequestInit) => Promise<Response> };
async function post<T = Record<string, unknown>>(op: string, body: object): Promise<{ status: number; data: T & { error?: string } }> {
  const r = await stub.fetch(`https://kb/${op}`, { method: "POST", headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() as T & { error?: string } };
}
beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  mf = new Miniflare({ workers: [{ name: "main", scriptPath: bundle, modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")), modules: true, compatibilityDate: "2025-09-06", durableObjects: { HUB: { className: "FlowsHub", useSQLite: true }, KB: { className: "KnowledgeHub", useSQLite: true } } }] });
  const ns = await mf.getDurableObjectNamespace("KB");
  // Miniflare's RPC proxy type and workers-types' fetch graph do not meet.
  // Narrow only this harness boundary; protocol payloads validate below.
  const durable = await ns.get(ns.idFromName("global")) as unknown as typeof stub;
  stub = { fetch: (url, init) => durable.fetch(url, init) };
});

let serial = 0;
const checkpoint = { repo: "https://github.com/state-vector/bridge", remote_ref: "refs/heads/bridge-checkpoints/test/1/1", commit: "a".repeat(40), tree: "b".repeat(40), base: "c".repeat(40), environment: ["linux"], next: "Continue repair", tests: [] };
const localCapabilities = { tier: "large", backend: "interactive", model: "test/large", tools: ["git"], environment: ["linux"], projects: ["bridge"] };
async function runtimeTask() {
  const name = `handoff-host-${++serial}`;
  const gateway = (await post<{ secret: string }>("admin.mint", { label: name, tags: ["gateway"] })).data;
  const identity = (await post<{ token_id: string }>("auth.identify", { bearer: gateway.secret })).data;
  const worker = (await post<{ id: string; secret: string }>("agent.provision", { label: `${name}/worker`, actor: name })).data;
  const base = { actor: name, token_id: identity.token_id, gateway: true, agent: `${name}/worker`, session: `dispatch-${serial}` };
  await post("execution", { ...base, id: "gateway", command_id: "advertise", command: { kind: "advertise", capabilities: { ...localCapabilities, backend: "opencode", capacity: 4 } } });
  const task = (await post<{ id: string }>("create", { actor: name, type: "task", title: `Local repair ${serial}`, project: "bridge", roles: ["impl"], qualified: true })).data;
  const auth = { ...base, id: task.id };
  expect((await post("transition", { ...auth, to: "in_progress" })).data.error).toBeUndefined();
  expect((await post("execution", { ...auth, command_id: "begin", command: { kind: "begin", attempt_id: "one", worker: `${name}/worker`, action_budget_ms: 60_000 } })).data.error).toBeUndefined();
  const oldFence = { generation: 1, attempt_id: "one" };
  const before = (command_id: string, command: object) => post("execution", { ...auth, command_id, command: { ...oldFence, ...command } });
  await before("first-checkpoint", { kind: "checkpoint", checkpoint });
  await before("first-quiet", { kind: "quiesce", writers: "process_group_empty" });
  expect((await before("first-yield", { kind: "yield" })).data.error).toBeUndefined();
  const note = await post("progress.log", { ...auth, note: "Late runner result after yield", completion_pct: 100 });
  expect(note.data.kind).toBe("commentary");
  expect((await post<{ status: string }>("get", { id: task.id })).data.status).toBe("todo");
  expect((await post("transition", { ...auth, to: "in_progress" })).data.error).toBeUndefined();
  expect((await post("execution", { ...auth, command_id: "second-begin", command: { kind: "begin", attempt_id: "two", worker: `${name}/worker`, action_budget_ms: 60_000 } })).data.error).toBeUndefined();
  expect((await post("execution", { ...auth, command_id: "restore", command: { kind: "restore", generation: 2, attempt_id: "two", tree: checkpoint.tree, commit: checkpoint.commit } })).data.error).toBeUndefined();
  const fence = { generation: 2, attempt_id: "two" };
  const command = async (command_id: string, command: object) => post("execution", { ...auth, command_id, command: { ...fence, ...command } });
  await command("handoff", { kind: "local_handoff", reason: "Needs local workspace", action: "Repair dataset", findings: "Remote dataset missing", tried: "Inspected remote", next: "Restore exact checkpoint", evidence: ["https://github.com/state-vector/bridge/actions/runs/1"], approvals: [], recipient: null });
  expect((await command("too-early-yield", { kind: "yield" })).data.error).toMatch(/checkpoint/);
  await command("checkpoint", { kind: "checkpoint", checkpoint });
  await command("quiet", { kind: "quiesce", writers: "process_group_empty" });
  const yielded = await command("yield", { kind: "yield" });
  expect(yielded.data.error).toBeUndefined();
  const h = ExecutionStateSchema.parse(yielded.data).handoff;
  if (h.phase !== "waiting") throw new Error("handoff did not reach waiting");
  return { id: task.id, auth, fence, h, worker, gateway, command };
}
async function interactive(label: string) {
  const token = (await post<{ secret: string }>("admin.mint", { label, tags: [] })).data;
  const identity = (await post<{ token_id: string }>("auth.identify", { bearer: token.secret })).data;
  return { ...token, ...identity, label };
}

describe("local handoff authority and lifecycle", () => {
  it("keeps a local-only wait through ordinary answers, progress, watchdog and autonomous claims", async () => {
    const r = await runtimeTask();
    expect((await post<{ status: string }>("get", { id: r.id })).data.status).toBe("blocked");
    expect((await post("transition", { ...r.auth, to: "in_progress" })).data.error).toMatch(/wait owns/);
    expect((await post("update", { id: r.id, meta: { blocked: {} } })).data.error).toMatch(/lifecycle infrastructure/);
    expect((await post("progress.log", { ...r.auth, note: "A comment is not acceptance" })).data.kind).toBe("commentary");
    const ask = await post<{ id: string }>("ask.create", { actor: "coordinator", to: "human", artefact_id: r.id, question: "Is the dataset approved?", reason: "Dataset choice", details: "Choose the data source for the local repair.", options: ["GO", "Hold"] });
    expect(ask.data.error).toBeUndefined();
    expect((await post("ask.answer", { id: ask.data.id, answer: "GO", actor: "web:test" })).data.error).toBeUndefined();
    await post("admin.stall_sweep", { now: Date.now() + 7 * 86_400_000 });
    await post("admin.alarm_sweep", {});
    const current = await post<{ status: string; owner: string }>("get", { id: r.id });
    expect(current.data.status).toBe("blocked"); expect(current.data.owner).toBe("");
    const read1 = await post("handoff.read", {}); const read2 = await post("handoff.read", {});
    expect(read1.data).toEqual(read2.data);
    const card = await post<{ status: string }>("get", { id: r.id }); expect(card.data.status).toBe("blocked");
  });
  it("rejects worker impersonation over real MCP, requires scoped human grants, and chooses exactly one local acceptor", async () => {
    const r = await runtimeTask(); const a = await interactive(`local-a-${serial}`); const b = await interactive(`local-b-${serial}`);
    const request = { id: r.id, handoff_id: r.h.id, version: r.h.version, session: "local-a" };
    expect((await post("handoff.accept", { ...request, token_id: a.token_id })).data.kind).toBe("unauthorized");
    const impersonation = await mf.dispatchFetch("https://hub.test/mcp", { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${r.worker.secret}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "handoff_accept", arguments: { ...request, token_id: a.token_id, actor: "web:test", interactive: true } } }) });
    const envelope = await impersonation.json() as { result: { content: { text: string }[] } };
    expect(JSON.parse(envelope.result.content[0].text).kind).toBe("unauthorized");
    const webOnly = await mf.dispatchFetch("https://hub.test/api/kb/handoff_control", { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${r.gateway.secret}` }, body: "{}" });
    expect(webOnly.status).toBe(403);
    for (const [token, session] of [[a, "local-a"], [b, "local-b"]] as const) {
      const grant = await post("handoff.control", { kind: "authorize", id: r.id, handoff_id: r.h.id, version: 1, label: token.label, session, host: "local-host", capabilities: localCapabilities, evidence: "Human checked actual model/tools and exact restored checkpoint", actor: "web:test" });
      expect(grant.data.kind).toBe("authorized");
    }
    const results = await Promise.all([post("handoff.accept", { ...request, token_id: a.token_id }), post("handoff.accept", { ...request, session: "local-b", token_id: b.token_id })]);
    expect(results.map(r => r.data.kind).sort()).toEqual(["accepted", "stale_episode"]);
    const winner = results[0].data.kind === "accepted" ? { ...a, session: "local-a" } : { ...b, session: "local-b" };
    expect((await post("handoff.accept", { ...request, session: winner.session, token_id: winner.token_id })).data.kind).toBe("already_accepted");
    expect((await post("transition", { id: r.id, to: "todo", actor: winner.label, token_id: winner.token_id, session: winner.session })).data.error).toMatch(/explicit human-authorised return/);
    const cp = await post("handoff.checkpoint", { ...request, session: winner.session, token_id: winner.token_id, checkpoint: { ...checkpoint, commit: "d".repeat(40) } });
    expect(cp.data.version).toBe(2);
    expect((await post("handoff.control", { kind: "return_autonomous", id: r.id, handoff_id: r.h.id, version: 1, writers: "human_confirmed_quiescent", actor: "web:test" })).data.kind).toBe("stale_episode");
    expect((await post("handoff.control", { kind: "return_autonomous", id: r.id, handoff_id: r.h.id, version: 2, writers: "human_confirmed_quiescent", actor: "web:test" })).data.kind).toBe("returned_autonomous");
  });
  it("blocks unsupported seeded requirements immediately and restores only its capability wait", async () => {
    const task = (await post<{ id: string; status: string }>("create", { actor: "test", type: "task", title: "Needs unavailable environment", project: "bridge", qualified: true, meta: { execution_requirements: { tier: "large", tools: ["cargo"], environment: ["special-access"] } } })).data;
    expect(task.status).toBe("blocked");
    const ready = await post("execution", { actor: "exec-host", token_id: (await post<{ token_id: string }>("auth.identify", { bearer: (await post<{ secret: string }>("admin.mint", { label: "cap-restoration", tags: ["gateway"] })).data.secret })).data.token_id,
      id: "gateway", command_id: "restore", command: { kind: "advertise", capabilities: { tier: "large", backend: "opencode", model: "test/large", tools: ["cargo"], environment: ["special-access"], projects: ["bridge"] } } });
    expect(ready.data.error).toBeUndefined();
    expect((await post<{ status: string }>("get", { id: task.id })).data.status).toBe("todo");
    await post("admin.execution_sweep", { now: Date.now() + 121_000 });
    expect((await post<{ status: string }>("get", { id: task.id })).data.status).toBe("blocked");
    expect((await post("update", { id: task.id, meta: { execution_requirements: { tier: "small", tools: [], environment: [] } } })).data.error).toMatch(/cannot silently weaken/);
    expect((await post("update", { id: task.id, meta_delete: ["execution_requirements"] })).data.error).toMatch(/cannot be deleted/);
  });
});
afterAll(async () => { await mf?.dispose(); });

describe("durable executor on real SQLite", () => {
  it("atomically replays commands, fences missing/stale worker scope, and holds the cross-host restoration barrier", async () => {
    const gateway = await post<{ secret: string }>("admin.mint", { label: "exec-host", tags: ["gateway"] });
    const identity = await post<{ token_id: string }>("auth.identify", { bearer: gateway.data.secret });
    const worker = await post<{ secret: string }>("agent.provision", { label: "exec-host/worker", actor: "exec-host" });
    expect(worker.data.error).toBeUndefined();
    const workerId = await post<{ token_id: string }>("auth.identify", { bearer: worker.data.secret });
    const task = await post<{ id: string }>("create", { type: "task", title: "Checkpoint transfer test", roles: ["impl"], qualified: true, actor: "exec-host" });
    const id = task.data.id;
    const auth = { actor: "exec-host", token_id: identity.data.token_id, gateway: true, agent: "exec-host/worker", session: "dispatch-test", id };
    const claim = await post("transition", { ...auth, to: "in_progress" });
    expect(claim.data.error).toBeUndefined();
    const advertised = await post("execution", { ...auth, command_id: "capabilities", command: { kind: "advertise", capabilities: { tier: "medium", model: "test/medium", tools: ["git"], environment: ["linux"] } } });
    expect(advertised.data.error).toBeUndefined();
    const cmd = { ...auth, command_id: "begin-one", command: { kind: "begin", attempt_id: "one", worker: "exec-host/worker", action_budget_ms: 60_000 } };
    const first = await post("execution", cmd);
    expect(first.data.error).toBeUndefined();
    const s = ExecutionStateSchema.parse(first.data);
    expect(s.attempt?.phase).toBe("running");
    expect((await post("execution", cmd)).data).toEqual(first.data);
    expect((await post("execution", { ...cmd, command: { ...cmd.command, action_budget_ms: 70_000 } })).data.error).toMatch(/reused/);
    const workerAuth = { actor: "exec-host/worker", token_id: workerId.data.token_id, id, session: "dispatch-test" };
    expect((await post("update", { ...workerAuth, title: "unfenced" })).data.error).toMatch(/fenced/);
    const scoped = { ...workerAuth, execution_scope: { id, generation: 1, attempt_id: "one" } };
    expect((await post("update", { ...scoped, title: "properly fenced" })).data.error).toBeUndefined();
    await post("execution", { ...auth, command_id: "interrupt", command: { kind: "message", message_id: "coordination", text: "Stop duplicate repair", priority: "interrupt" } });
    expect((await post("update", { ...scoped, title: "stale writer" })).data.error).toMatch(/fenced/);
    const fence = { generation: 1, attempt_id: "one" };
    const quiesced = await post("execution", { ...auth, command_id: "quiet", command: { kind: "quiesce", ...fence, writers: "process_group_empty" } });
    expect(quiesced.data.error).toBeUndefined();
    expect((await post("execution", { ...auth, command_id: "yield-without-content", command: { kind: "yield", ...fence } })).data.error).toMatch(/checkpoint/);
    expect((await post("execution", { ...auth, command_id: "pretend-new-host", actor: "other", command: { ...cmd.command, attempt_id: "two" } })).data.error).toBeDefined();
    const state = await post("execution", { ...auth, command_id: "inspect", command: { kind: "inspect" } });
    expect(ExecutionStateSchema.parse(state.data).attempt?.phase).toBe("quiesced");
  });
});
