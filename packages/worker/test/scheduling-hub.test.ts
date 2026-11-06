import { Miniflare } from "miniflare";
import { realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SchedulingOutcomeSchema } from "@bridge/contracts";
import { executorRequest } from "./executor-fixture";

let mf: Miniflare;
let stub: { fetch(url: string, init: RequestInit): Promise<Response> };
let serial = 0;
async function post(op: string, body: object) {
  const response = await stub.fetch(`https://kb/${op}`, { method: "POST", headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify(executorRequest(body)) });
  return await response.json() as Record<string, any>; // JSON transport boundary, schemas validate outcomes
}
beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  mf = new Miniflare({ workers: [{ name: "main", scriptPath: bundle, modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")), modules: true, compatibilityDate: "2025-09-06", durableObjects: { HUB: { className: "FlowsHub", useSQLite: true }, KB: { className: "KnowledgeHub", useSQLite: true } } }] });
  const ns = await mf.getDurableObjectNamespace("KB");
  stub = await ns.get(ns.idFromName("scheduler")) as unknown as typeof stub;
});
afterAll(async () => { await mf?.dispose(); });

async function gateway(project: string, capacity = 1) {
  const host = `scheduler-${++serial}`;
  const token = await post("admin.mint", { label: host, tags: ["gateway"] });
  const identity = await post("auth.identify", { bearer: token.secret });
  await post("agent.provision", { label: `${host}/worker`, actor: host });
  const auth = { actor: host, token_id: identity.token_id, gateway: true, agent: `${host}/worker`, session: `gateway-${serial}` };
  const capabilities = { tier: "small", tools: ["git"], environment: ["linux"], backend: "opencode", model: "test/small", config_revision: "one", capacity, projects: [project], worker: { kind: "provisioned", label: `${host}/worker` } };
  const cmd = (command: object, command_id = `command-${++serial}`, id = "gateway", session = auth.session) => post("execution", { ...auth, id, session, command_id, command });
  expect((await cmd({ kind: "advertise", capabilities })).ok).toBe(true);
  return { auth, capabilities, cmd, host };
}
async function task(project: string, meta: object = {}) {
  const result = await post("create", { actor: "author", type: "task", title: `Scheduler repair ${++serial}`, body_md: "Repair repository input", project, qualified: true, meta });
  expect(result.error).toBeUndefined();
  return result.id as string;
}
async function reserve(g: Awaited<ReturnType<typeof gateway>>, key?: string) {
  return SchedulingOutcomeSchema.parse(await g.cmd({ kind: "schedule", mode: "reserve" }, key));
}

describe("eligibility-first scheduling on real SQLite", () => {
  it("keeps released old writers charged but labels them unconfirmed, and frees capacity only after same-host quiescence", async () => {
    const project = "truthful-occupancy", g = await gateway(project), peer = await gateway(project);
    const id = await task(project), r = await reserve(g);
    if (r.kind !== "reserved") throw new Error("no reservation");
    let status = await g.cmd({ kind: "schedule_status", host: g.host });
    expect(status.hosts[0].occupancy).toMatchObject({ leased: 0, starting: 1, unconfirmed: 0, held: 1 });
    expect((await g.cmd({ kind: "begin", attempt_id: "retained-writer", worker: g.auth.agent, action_budget_ms: 60_000 }, "begin-retained", id, r.session)).error).toBeUndefined();
    status = await g.cmd({ kind: "schedule_status", host: g.host });
    expect(status.hosts[0].occupancy).toMatchObject({ leased: 1, starting: 0, unconfirmed: 0, held: 1 });
    expect((await post("transition", { id, to: "todo", actor: "system:test", note: "Card released, but no stopped-process evidence exists" })).error).toBeUndefined();
    const fenced = await g.cmd({ kind: "poll", generation: 1, attempt_id: "retained-writer" }, "released-writer-poll", id, r.session);
    expect(fenced.attempt.phase).toBe("stopping");
    expect(fenced.messages).toEqual(expect.arrayContaining([expect.objectContaining({ priority: "interrupt", text: expect.stringContaining("Task claim ended") })]));
    status = await g.cmd({ kind: "schedule_status", host: g.host });
    expect(status.hosts[0]).toMatchObject({ active: 1, reserved: 0, occupancy: { leased: 0, starting: 0, unconfirmed: 1, held: 1,
      slots: [{ kind: "unconfirmed", task_id: id, generation: 1, attempt_id: "retained-writer", session: r.session, reason: "claim_changed", task_status: "todo" }] } });
    expect(await reserve(g)).toMatchObject({ kind: "at_capacity", active: 1 });
    const stop = { kind: "quiesce", generation: 1, attempt_id: "retained-writer", writers: "process_group_empty" };
    expect((await peer.cmd(stop, "foreign-stop", id, r.session)).error).toMatch(/authority|host/);
    expect((await g.cmd(stop, "confirmed-stop", id, r.session)).error).toBeUndefined();
    status = await g.cmd({ kind: "schedule_status", host: g.host });
    expect(status.hosts[0].occupancy).toMatchObject({ leased: 0, unconfirmed: 0, starting: 0, held: 0 });
    // Consume the released fixture so later global eligibility censuses do not
    // inherit its deliberately retained host affinity.
    expect((await post("transition", { ...g.auth, id, to: "in_progress" })).error).toBeUndefined();
  });
  it("bootstraps from the authenticated reservation without caller-supplied worker attribution, never from a peer or stale session", async () => {
    const project = "bootstrap", g = await gateway(project), peer = await gateway(project);
    const id = await task(project), reservation = await reserve(g);
    if (reservation.kind !== "reserved") throw new Error("no reservation");
    const begin = { id, session: reservation.session, command_id: "bootstrap-begin", command: {
      kind: "begin", attempt_id: "bootstrap", worker: g.auth.agent, action_budget_ms: 60_000,
    } };
    expect((await post("execution", { ...peer.auth, ...begin })).error).toMatch(/authority/);
    expect((await post("execution", { ...g.auth, ...begin, agent: undefined, session: "wrong-session" })).error).toMatch(/authority|claim/);
    const result = await post("execution", { ...g.auth, ...begin, agent: undefined });
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ generation: 1, attempt: { attempt_id: "bootstrap", host: g.host } });
    expect(await post("execution", { ...g.auth, ...begin, agent: undefined })).toEqual(result);
  });
  it("never hides compatible work behind more than ten boosted host-pinned tasks", async () => {
    const project = "starvation", mac = await gateway(project, 32), ec2 = await gateway(project, 12);
    for (let i = 0; i < 15; i++) await task(project, { boosted: 1, execution_requirements: { host: mac.host } });
    const runnable = await task(project);
    const orientation = await post("orient", { ...ec2.auth, label: ec2.host, tags: ["gateway"] });
    expect(orientation.unclaimed_work.map((t: { id: string }) => t.id)).toContain(runnable);
    const outcome = await reserve(ec2);
    expect(outcome).toMatchObject({ kind: "reserved", task_id: runnable, eligible: 1, capacity: 12, reasons: { host_affinity: 15 } });
    const status = await ec2.cmd({ kind: "schedule_status", host: ec2.host });
    expect(status.hosts).toHaveLength(1);
    expect(status.hosts[0]).toMatchObject({ host: ec2.host, capacity: 12, active: 0, reserved: 1, eligible: 0, last_dispatch: { kind: "reserved", task_id: runnable } });
  });
  it("atomically limits concurrent reservations, replays exactly, and counts stopped-but-unquiesced writers", async () => {
    const project = "concurrent", g = await gateway(project);
    await task(project); await task(project);
    const results = await Promise.all([reserve(g, "race-a"), reserve(g, "race-b")]);
    expect(results.map(r => r.kind).sort()).toEqual(["at_capacity", "reserved"]);
    const winner = results.find(r => r.kind === "reserved");
    if (winner?.kind !== "reserved") throw new Error("no reservation");
    expect(await reserve(g, results[0].kind === "reserved" ? "race-a" : "race-b")).toEqual(winner);
    const direct = await post("transition", { ...g.auth, id: (await task(project)), to: "in_progress" });
    expect(direct.error).toMatch(/capacity/);
    const begin = await g.cmd({ kind: "begin", attempt_id: "writer", worker: g.auth.agent, action_budget_ms: 60_000 }, "begin", winner.task_id, winner.session);
    expect(begin.error).toBeUndefined();
    await g.cmd({ kind: "message", message_id: "stop", text: "Stop safely", priority: "interrupt" }, "stop", winner.task_id, winner.session);
    expect(await reserve(g)).toMatchObject({ kind: "at_capacity", active: 1, reserved: 0 });
    await post("admin.execution_sweep", { now: Date.now() + 600_000 });
    expect(await reserve(g)).toMatchObject({ kind: "at_capacity", active: 1 });
    expect((await g.cmd({ kind: "quiesce", generation: 1, attempt_id: "writer", writers: "process_group_empty" }, "quiet", winner.task_id, winner.session)).error).toBeUndefined();
    // The future-time sweep also expires gateway capability observations and
    // parks default-tier tasks. Fresh inventory is the capability-restored event.
    await g.cmd({ kind: "advertise", capabilities: g.capabilities });
    // Quiescent attempts must not continue to consume their old start claim.
    expect((await reserve(g)).kind).toBe("reserved");
  });
  it("releases only proven pre-launch expiry without spending churn and fences a late begin", async () => {
    const project = "expiry", g = await gateway(project);
    const id = await task(project), result = await reserve(g);
    if (result.kind !== "reserved") throw new Error("no reservation");
    await post("admin.execution_sweep", { now: result.expires_at + 1 });
    await g.cmd({ kind: "advertise", capabilities: g.capabilities });
    const card = await post("get", { id });
    expect(card).toMatchObject({ status: "todo", owner: "", meta: { execution_requirements: { host: g.host }, dispatch_recovery: { kind: "reservation_expired" } } });
    expect(card.meta.attempt).toBeUndefined();
    expect((await g.cmd({ kind: "begin", attempt_id: "late", worker: g.auth.agent, action_budget_ms: 60_000 }, "late", id, result.session)).error).toMatch(/authority|claim/);
  });
  it("drains persistently across advertisements/resume, preserving active writer control and rejecting worker impersonation", async () => {
    const project = "drain", g = await gateway(project, 2), other = await gateway(project, 2);
    const id = await task(project), r = await reserve(g);
    if (r.kind !== "reserved") throw new Error("no reservation");
    expect((await g.cmd({ kind: "begin", attempt_id: "drain-writer", worker: g.auth.agent, action_budget_ms: 60_000 }, "begin", id, r.session)).error).toBeUndefined();
    const admin = await post("admin.mint", { label: "scheduler-operator", tags: [] });
    const identity = await post("auth.identify", { bearer: admin.secret });
    const control = { id: "gateway", command_id: "drain", command: { kind: "gateway_control", host: g.host, mode: "draining", reason: "Human laptop retired from autonomous work" } };
    expect((await post("execution", { ...other.auth, ...control })).error).toMatch(/full-agent/);
    expect((await post("execution", { ...g.auth, ...control, command_id: "self-drain" })).kind).toBe("gateway_controlled");
    expect((await post("execution", { ...g.auth, ...control, command_id: "self-enable", command: { ...control.command, mode: "enabled" } })).error).toMatch(/full-agent/);
    expect((await post("execution", { ...control, actor: "scheduler-operator", token_id: identity.token_id })).kind).toBe("gateway_controlled");
    const replay = await post("execution", { ...control, actor: "scheduler-operator", token_id: identity.token_id });
    expect(replay.kind).toBe("gateway_controlled");
    expect((await g.cmd({ kind: "advertise", capabilities: g.capabilities })).readiness.kind).toBe("draining");
    await g.cmd({ kind: "resume_claims" });
    expect(await reserve(g)).toMatchObject({ kind: "gateway_not_ready", reason: "Human laptop retired from autonomous work" });
    await task(project);
    expect((await reserve(other)).kind).toBe("reserved");
    expect((await g.cmd({ kind: "quiesce", generation: 1, attempt_id: "drain-writer", writers: "process_group_empty" }, "quiet", id, r.session)).error).toBeUndefined();
  });
  it("keeps a task prerequisite scoped, ignores priority/progress churn, and recovers after its repository input changes", async () => {
    const project = "suppression", g = await gateway(project, 2);
    const id = await task(project, { repo: "https://github.com/ghost/missing" }), r = await reserve(g);
    if (r.kind !== "reserved") throw new Error("no reservation");
    expect((await g.cmd({ kind: "start_failed", stage: "begin", reason: "gate: repository not found", retained_work: false, failure_class: "prerequisite" }, "failed", id, r.session)).kind).toBe("released");
    await g.cmd({ kind: "advertise", capabilities: g.capabilities });
    expect(await reserve(g)).toMatchObject({ kind: "no_eligible_work" });
    await post("update", { id, meta: { boosted: Date.now() } });
    expect((await reserve(g)).kind).toBe("no_eligible_work");
    const healthy = await task(project);
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: healthy });
    expect((await post("update", { id, meta: { repo: "https://github.com/state-vector/bridge" } })).error).toBeUndefined();
    expect((await post("get", { id })).status).toBe("todo");
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: id });
  });
  it("replays concurrent scheduling requests without a second claim and uses a fresh session for each reservation", async () => {
    const project = "replay", g = await gateway(project, 3);
    const id = await task(project);
    const requests = await Promise.all([reserve(g, "same-command"), reserve(g, "same-command")]);
    const replay = await reserve(g, "same-command");
    expect(requests.some(r => r.kind === "reserved")).toBe(true);
    expect(replay).toMatchObject({ kind: "reserved", task_id: id });
    if (replay.kind !== "reserved") throw new Error("missing reservation");
    expect(replay.session).not.toBe(`dispatch-${id.replace("#", "-")}`);
    expect((await g.cmd({ kind: "schedule_status", host: g.host })).hosts[0].reserved).toBe(1);
    await g.cmd({ kind: "start_failed", stage: "begin", reason: "transport temporary", retained_work: false, failure_class: "transport" }, "failure", id, replay.session);
    // Retry transport acknowledgement is idempotent; it cannot extend backoff.
    const failure = { kind: "gateway_failure", reason: "provider disconnected", cooldown_ms: 10_000 };
    expect(await g.cmd(failure, "provider-failure")).toEqual(await g.cmd(failure, "provider-failure"));
  });
});
