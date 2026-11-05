import { Miniflare } from "miniflare";
import { realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExecutionStateSchema } from "@bridge/contracts";
import { executorRequest } from "./executor-fixture";

let mf: Miniflare;
let stub: { fetch: (url: string, init: RequestInit) => Promise<Response> };
async function post<T = Record<string, unknown>>(op: string, body: object): Promise<{ status: number; data: T & { error?: string } }> {
  const r = await stub.fetch(`https://kb/${op}`, { method: "POST", headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify(executorRequest(body)) });
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
afterAll(async () => { await mf?.dispose(); });

describe("durable executor on real SQLite", () => {
  it("does not let an advertised but unprovisioned runner claim work; safely releases a never-launched start", async () => {
    const host = "startup-host";
    const gateway = (await post<{ secret: string }>("admin.mint", { label: host, tags: ["gateway"] })).data;
    const identity = (await post<{ token_id: string }>("auth.identify", { bearer: gateway.secret })).data;
    const task = (await post<{ id: string }>("create", { type: "task", title: "Review startup recovery", roles: ["review"], qualified: true, actor: host })).data;
    const auth = { actor: host, token_id: identity.token_id, gateway: true, agent: `${host}/worker`, session: "dispatch-startup", id: task.id };
    const capabilities = { tier: "medium", tools: ["git"], environment: ["linux"], config_revision: "initial" };
    const cmd = (command_id: string, command: object) => post("execution", { ...auth, command_id, command });
    expect((await cmd("legacy", { kind: "advertise", capabilities })).data.ok).toBe(false);
    expect((await cmd("unavailable", { kind: "availability" })).data.phase).toBe("unavailable");
    expect((await post("transition", { ...auth, to: "in_progress" })).data.error).toMatch(/worker|readiness/);
    expect((await post("get", { id: task.id })).data.status).toBe("todo");
    await post("agent.provision", { label: `${host}/worker`, actor: host });
    const ready = { ...capabilities, worker: { kind: "provisioned", label: `${host}/worker` } };
    expect((await cmd("ready", { kind: "advertise", capabilities: ready })).data.ok).toBe(true);
    const obsolete = await post("execution", { ...auth, runner_protocol: undefined, command_id: "obsolete",
      command: { kind: "advertise", capabilities: ready } });
    expect(obsolete.data.ok).toBe(false);
    expect((await cmd("still-ready", { kind: "availability" })).data.phase).toBe("ready");
    expect((await post("transition", { ...auth, runner_protocol: undefined, to: "in_progress" })).data.error).toMatch(/runner protocol/);
    expect((await post("transition", { ...auth, to: "in_progress" })).data.error).toBeUndefined();
    const foreign = (await post<{ secret: string }>("admin.mint", { label: "foreign-startup", tags: ["gateway"] })).data;
    const foreignId = (await post<{ token_id: string }>("auth.identify", { bearer: foreign.secret })).data.token_id;
    const spoof = await post("execution", { ...auth, actor: "foreign-startup", token_id: foreignId, command_id: "forged-release",
      command: { kind: "start_failed", stage: "begin", reason: "forged", retained_work: false } });
    expect(spoof.data.error).toMatch(/authority|authenticated runner/);
    expect((await cmd("begin", { kind: "begin", worker: `${host}/worker`, attempt_id: "startup", action_budget_ms: 60_000 })).data.error).toBeUndefined();
    const failure = { kind: "start_failed", stage: "begin", reason: "launch never happened", retained_work: true };
    // A lost begin response is not permission to release an unknown writer.
    expect((await cmd("unsafe-release", failure)).data.kind).toBe("held");
    expect((await post("get", { id: task.id })).data.status).toBe("in_progress");
    await cmd("quiet", { kind: "quiesce", generation: 1, attempt_id: "startup", writers: "process_group_empty" });
    expect((await cmd("safe-release", failure)).data.kind).toBe("released");
    expect((await cmd("safe-release", failure)).data.kind).toBe("released"); // exact replay survives owner clear
    const released = (await post("get", { id: task.id })).data;
    expect(released.status).toBe("todo");
    expect(released.meta).not.toHaveProperty("session");
    expect(released.meta).not.toHaveProperty("attempt"); // not watchdog abandonment
    expect(released.meta).toMatchObject({ execution_requirements: { host } });
    expect((await cmd("cooldown", { kind: "advertise", capabilities: ready })).data.ok).toBe(false);
    expect((await cmd("changed-prerequisite", { kind: "advertise", capabilities: { ...ready, config_revision: "repaired" } })).data.ok).toBe(true);
  });
  it("recovers only proven legacy never-launched credential failures, retaining WIP affinity and real execution fences", async () => {
    const host = "legacy-startup-host";
    const gw = (await post<{ secret: string }>("admin.mint", { label: host, tags: ["gateway"], principal: "legacy-startup-principal" })).data;
    const tokenId = (await post<{ token_id: string }>("auth.identify", { bearer: gw.secret })).data.token_id;
    await post("agent.provision", { label: `${host}/worker`, actor: host });
    const task = (await post<{ id: string }>("create", { type: "task", title: "Retained legacy startup work", roles: ["impl"], qualified: true })).data;
    const auth = { id: task.id, actor: host, token_id: tokenId, gateway: true, agent: `${host}/worker`, session: "dispatch-legacy-startup" };
    const cmd = (command_id: string, command: object) => post("execution", { ...auth, command_id, command });
    await cmd("ready", { kind: "advertise", capabilities: { tier: "medium", tools: ["git"], environment: ["linux"], worker: { kind: "provisioned", label: `${host}/worker` } } });
    expect((await post("transition", { ...auth, to: "in_progress" })).data.error).toBeUndefined();
    const recover = { kind: "recover_unstarted", writers: "not_launched", retained_work: true };
    expect((await cmd("not-a-legacy-failure", recover)).data.error).toMatch(/recorded pre-begin/);
    await post("progress.log", { ...auth, did: "runner: durable execution held: ERROR: gate: worker credential must be provisioned before begin" });
    await post("update", { id: task.id, meta: { attempt: { attempts: 5, last_reason: "watchdog after unstarted worker" } } });
    expect((await post("transition", { ...auth, to: "blocked", note: "churn guard: five never-launched workers",
      await_event: { event: "time", until_ts: Date.now() + 86_400_000 } })).data.error).toBeUndefined();
    expect((await cmd("recover", recover)).data.kind).toBe("released");
    const recovered = (await post("get", { id: task.id })).data;
    expect(recovered.status).toBe("todo");
    expect(recovered.meta).toMatchObject({ execution_requirements: { host }, startup_recovery: { previous_attempts: { attempts: 5 } } });
    expect(recovered.meta).not.toHaveProperty("blocked");
    expect((await cmd("ready-again", { kind: "availability" })).data.phase).toBe("ready");
    await post("transition", { ...auth, to: "in_progress" });
    expect((await cmd("real-begin", { kind: "begin", worker: `${host}/worker`, attempt_id: "real", action_budget_ms: 60_000 })).data.error).toBeUndefined();
    expect((await cmd("cannot-erase-real-attempt", recover)).data.error).toMatch(/no execution attempt/);
  });

  it("proves a cached worker's canonical identity and refuses gateway or foreign credentials without minting", async () => {
    const gw = (await post<{ secret: string }>("admin.mint", { label: "cache-host", tags: ["gateway"] })).data;
    const worker = (await post<{ secret: string }>("agent.provision", { label: "cache-host/old", actor: "cache-host" })).data;
    const renamed = await post("token.rename", { bearer: worker.secret, label: "cache-host/current" });
    expect(renamed.data.error).toBeUndefined();
    const resolve = (cached_secret: string) => mf.dispatchFetch("https://hub.test/api/kb-machine/provision", {
      method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${gw.secret}` },
      body: JSON.stringify({ label: "cache-host/old", cached_secret, actor: "web:spoof" }),
    });
    const proof = await resolve(worker.secret);
    expect(proof.status).toBe(200);
    expect(await proof.json()).toMatchObject({ cached: true, label: "cache-host/current" });
    expect((await resolve(gw.secret)).status).toBe(403);
    expect((await resolve("not-a-credential")).status).toBe(401);
    const foreign = (await post<{ secret: string }>("admin.mint", { label: "foreign", tags: ["gateway"] })).data;
    const foreignWorker = (await post<{ secret: string }>("agent.provision", { label: "foreign/worker", actor: "foreign" })).data;
    expect((await resolve(foreignWorker.secret)).status).toBe(403);
    const stillLive = await post("auth.identify", { bearer: worker.secret });
    expect(stillLive.data.error).toBeUndefined();
  });
  it("atomically replays commands, fences missing/stale worker scope, and holds the cross-host restoration barrier", async () => {
    const gateway = await post<{ secret: string }>("admin.mint", { label: "exec-host", tags: ["gateway"] });
    const identity = await post<{ token_id: string }>("auth.identify", { bearer: gateway.data.secret });
    const worker = await post<{ secret: string }>("agent.provision", { label: "exec-host/worker", actor: "exec-host" });
    expect(worker.data.error).toBeUndefined();
    const workerId = await post<{ token_id: string }>("auth.identify", { bearer: worker.data.secret });
    const task = await post<{ id: string }>("create", { type: "task", title: "Checkpoint transfer test", roles: ["impl"], qualified: true, actor: "exec-host" });
    const id = task.data.id;
    const auth = { actor: "exec-host", token_id: identity.data.token_id, gateway: true, agent: "exec-host/worker", session: "dispatch-test", id };
    const advertised = await post("execution", { ...auth, command_id: "capabilities", command: { kind: "advertise", capabilities: { tier: "medium", tools: ["git"], environment: ["linux"], worker: { kind: "provisioned", label: "exec-host/worker" } } } });
    expect(advertised.data.error).toBeUndefined();
    const claim = await post("transition", { ...auth, to: "in_progress" });
    expect(claim.data.error).toBeUndefined();
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
