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
  const durable = await ns.get(ns.idFromName("route-incidents")) as unknown as typeof stub;
  stub = { fetch: (url, init) => durable.fetch(url, init) };
});
afterAll(async () => { await mf?.dispose(); });

let serial = 0;
const capabilities = { tier: "large", backend: "opencode", model: "llmgw/glm-5.3", tools: ["git"], environment: ["linux"], capacity: 4, projects: ["bridge"], worker: { kind: "provisioned", label: "placeholder" } } as Record<string, unknown>;

/// A wire-exact typed provider cause: opencode v2.2.5 ACP adapter session
/// failure — -32603 with OBJECT data {service:"session", errorName}.
const quotaCause = (at_ms: number) => ({
  class: "account_action", backend: "opencode", model: "llmgw/glm-5.3", code: -32603, error_name: "provider.quota",
  message: "provider quota exceeded", data: { service: "session", errorName: "provider.quota" }, at_ms,
});

async function gatewayWithTask() {
  const host = `route-incident-host-${++serial}`;
  const gateway = (await post<{ secret: string }>("admin.mint", { label: host, tags: ["gateway"] })).data;
  const identity = (await post<{ token_id: string }>("auth.identify", { bearer: gateway.secret })).data;
  expect((await post<{ id: string }>("agent.provision", { label: `${host}/worker`, actor: host })).status).toBe(200);
  const auth = { actor: host, token_id: identity.token_id, gateway: true, agent: `${host}/worker`, session: `dispatch-${serial}` };
  expect((await post("execution", { ...auth, id: "gateway", command_id: "advertise", command: { kind: "advertise", capabilities: { ...capabilities, worker: { kind: "provisioned", label: `${host}/worker` } } } })).data.error).toBeUndefined();
  const task = (await post<{ id: string }>("create", { actor: host, type: "task", title: `Route incident ${serial}`, project: "bridge", roles: ["impl"], qualified: true })).data;
  expect((await post("transition", { ...auth, id: task.id, to: "in_progress" })).data.error).toBeUndefined();
  const execution = (command_id: string, command: object) => post("execution", { ...auth, id: task.id, command_id, command });
  expect((await execution("begin", { kind: "begin", attempt_id: "one", worker: `${host}/worker`, action_budget_ms: 60_000 })).data.error).toBeUndefined();
  return { host, auth, task, execution };
}

describe("BR#8821 one canonical route-scoped typed incident", () => {
  it("persists the incident on a typed failed finalize and mints ONE deduplicated account ask", async () => {
    const { auth, task, execution } = await gatewayWithTask();
    const fence = { generation: 1, attempt_id: "one" };
    const outcome = { kind: "failed", exit_code: 1, stdout_tail: "attempted", stderr_tail: "provider refused", cause: quotaCause(100) };
    expect((await execution("stop", { kind: "stopped", ...fence, writers: "no_live_group_members", outcome })).data.error).toBeUndefined();
    expect((await execution("finalize", { kind: "finalize", ...fence, writers: "no_live_group_members", outcome })).data.error).toBeUndefined();

    // the inspect response carries the canonical incident (single source of truth)
    // (read from the RAW response: ExecutionStateSchema strips undeclared keys)
    const inspected = (await execution("inspect", { kind: "inspect" })).data as unknown as Record<string, unknown>;
    const incidents = (inspected.route_incidents ?? []) as Array<Record<string, unknown>>;
    expect(incidents.length).toBeGreaterThanOrEqual(1);
    const incident = incidents.find(i => i.route_key === "account_action|opencode|llmgw/glm-5.3|legacy");
    expect(incident).toMatchObject({ class: "account_action", backend: "opencode", model: "llmgw/glm-5.3", status: "open", task_id: task.id });
    expect(incident!.ask_id).toBeTruthy();

    // ONE ask exists, bound to this route, and a second finalize does not mint another
    const asks = (await post<{ artefacts: Array<{ id: string; meta: unknown }> }>("list", { type: "question" })).data.artefacts;
    const routeKeyOf = (a: { meta: unknown }) => (typeof a.meta === "string" ? JSON.parse(a.meta) : a.meta)?.ask?.account_route_key;
    const boundAsks = asks.filter(a => routeKeyOf(a) === "account_action|opencode|llmgw/glm-5.3|legacy");
    expect(boundAsks).toHaveLength(1);
  });

  it("gates scheduler admission on the open incident and clears ONLY by an exact-model probe advertisement", async () => {
    const { auth, host, task, execution } = await gatewayWithTask();
    const fence = { generation: 1, attempt_id: "one" };
    const outcome = { kind: "failed", exit_code: 1, stdout_tail: "", stderr_tail: "provider quota", cause: quotaCause(200) };
    await execution("stop", { kind: "stopped", ...fence, writers: "no_live_group_members", outcome });
    await execution("finalize", { kind: "finalize", ...fence, writers: "no_live_group_members", outcome });
    // the finalize released the task back to todo (canRescheduleFinalized) with the incident open
    expect((await post<{ status: string }>("get", { id: task.id })).data.status).toBe("todo");

    // admission is gated: the ready gateway cannot reclaim the task while the incident is open
    const reclaim = await post("transition", { ...auth, id: task.id, to: "in_progress" });
    expect(reclaim.data.error).toMatch(/open provider incident/);

    // a FAILED probe does not clear (timestamps are real epoch: the incident's
    // observed_at is Date.now() at finalize time)
    const t0 = Date.now();
    expect((await post("execution", { ...auth, id: "gateway", command_id: "probe-fail", command: { kind: "advertise", capabilities: { ...capabilities, worker: { kind: "provisioned", label: `${host}/worker` }, probe: { model: "llmgw/glm-5.3", at: t0 + 10_000, ok: false, output_head: "402" } } } })).data.error).toBeUndefined();
    expect((await post("transition", { ...auth, id: task.id, to: "in_progress" })).data.error).toMatch(/open provider incident/);

    // a successful but STALE probe (older than the last observed failure) does not clear
    expect((await post("execution", { ...auth, id: "gateway", command_id: "probe-stale", command: { kind: "advertise", capabilities: { ...capabilities, worker: { kind: "provisioned", label: `${host}/worker` }, probe: { model: "llmgw/glm-5.3", at: t0 - 60_000, ok: true, output_head: "Reply OK" } } } })).data.error).toBeUndefined();
    expect((await post("transition", { ...auth, id: task.id, to: "in_progress" })).data.error).toMatch(/open provider incident/);

    // a successful probe on ANOTHER model does not clear this route's incident
    expect((await post("execution", { ...auth, id: "gateway", command_id: "probe-foreign", command: { kind: "advertise", capabilities: { ...capabilities, model: "other/model", worker: { kind: "provisioned", label: `${host}/worker` }, probe: { model: "other/model", at: t0 + 20_000, ok: true, output_head: "Reply OK" } } } })).data.error).toBeUndefined();
    expect((await post("transition", { ...auth, id: task.id, to: "in_progress" })).data.error).toMatch(/open provider incident/);

    // a NEWER successful exact-model probe clears — and only then admission reopens
    expect((await post("execution", { ...auth, id: "gateway", command_id: "probe-clear", command: { kind: "advertise", capabilities: { ...capabilities, worker: { kind: "provisioned", label: `${host}/worker` }, probe: { model: "llmgw/glm-5.3", at: t0 + 30_000, ok: true, output_head: "Reply OK" } } } })).data.error).toBeUndefined();
    const reopened = await post<{ error?: string }>("transition", { ...auth, id: task.id, to: "in_progress" });
    expect(reopened.data.error).toBeUndefined();
  });

  it("keeps non-account failures contained: no incident ask is minted for a diagnostic cause", async () => {
    const { execution } = await gatewayWithTask();
    const fence = { generation: 1, attempt_id: "one" };
    const diagnostic = { ...quotaCause(300), class: "diagnostic", error_name: "provider.timeout" };
    const outcome = { kind: "failed", exit_code: 1, stdout_tail: "", stderr_tail: "upstream timed out", cause: diagnostic };
    await execution("stop", { kind: "stopped", ...fence, writers: "no_live_group_members", outcome });
    expect((await execution("finalize", { kind: "finalize", ...fence, writers: "no_live_group_members", outcome })).data.error).toBeUndefined();
    const asks = (await post<{ artefacts: Array<{ meta: unknown }> }>("list", { type: "question" })).data.artefacts;
    const routeKeyOf = (a: { meta: unknown }) => (typeof a.meta === "string" ? JSON.parse(a.meta) : a.meta)?.ask?.account_route_key;
    const accountAsks = asks.filter(a => routeKeyOf(a));
    // diagnostic route incidents persist (containment evidence) but never mint an owner ask
    expect(accountAsks.filter(a => String(routeKeyOf(a)).startsWith("diagnostic|"))).toHaveLength(0);
    expect(accountAsks.filter(a => String(routeKeyOf(a)).startsWith("account_action|")).length).toBeGreaterThanOrEqual(1);
  });

  it("reuses a live covering account ask instead of minting a second one (dedupe across tasks)", async () => {
    const first = await gatewayWithTask();
    const fence = { generation: 1, attempt_id: "one" };
    const outcome = { kind: "failed", exit_code: 1, stdout_tail: "", stderr_tail: "provider quota", cause: quotaCause(400) };
    await first.execution("stop", { kind: "stopped", ...fence, writers: "no_live_group_members", outcome });
    await first.execution("finalize", { kind: "finalize", ...fence, writers: "no_live_group_members", outcome });
    const asksAfterFirst = (await post<{ artefacts: unknown[] }>("list", { type: "question" })).data.artefacts.length;

    // a SECOND task failing on the SAME provider route must not mint a second
    // ask: the covering-ask dedupe reuses the live route ask.
    const second = await gatewayWithTask();
    const outcome2 = { ...outcome, cause: quotaCause(450) };
    await second.execution("stop", { kind: "stopped", ...fence, writers: "no_live_group_members", outcome2 });
    await second.execution("finalize", { kind: "finalize", ...fence, writers: "no_live_group_members", outcome2 });
    const asksAfterSecond = (await post<{ artefacts: Array<{ id: string; meta: unknown }> }>("list", { type: "question" })).data.artefacts;
    expect(asksAfterSecond.length).toBe(asksAfterFirst); // REUSED, not minted
    // no route ever carries two asks
    const routeKeyOf = (a: { meta: unknown }) => (typeof a.meta === "string" ? JSON.parse(a.meta) : a.meta)?.ask?.account_route_key;
    const byRoute = new Map<string, number>();
    for (const a of asksAfterSecond) {
      const key = routeKeyOf(a);
      if (key) byRoute.set(key, (byRoute.get(key) ?? 0) + 1);
    }
    for (const [key, count] of byRoute) expect(count, key).toBe(1);
  });
});