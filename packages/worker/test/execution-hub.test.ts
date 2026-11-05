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
  const durable = await ns.get(ns.idFromName("execution-test")) as unknown as typeof stub;
  stub = { fetch: (url, init) => durable.fetch(url, init) };
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
    const advertised = await post("execution", { ...auth, command_id: "capabilities", command: { kind: "advertise", capabilities: { tier: "medium", tools: ["git"], environment: ["linux"] } } });
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
