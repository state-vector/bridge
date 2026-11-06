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

const publishedCheckpoint = { repo: "https://github.com/state-vector/bridge", remote_ref: "refs/heads/bridge-checkpoints/recovery-priority",
  commit: "a".repeat(40), tree: "b".repeat(40), base: "c".repeat(40), environment: ["linux"], next: "Resume the preserved verification", tests: [] };

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
  it("backs off old-runner scratch ENOSPC without latching identity repair or extending cooldown on advertisements", async () => {
    const project = "scratch-resource-recovery", g = await gateway(project);
    const id = await task(project), reservation = await reserve(g);
    if (reservation.kind !== "reserved") throw new Error("no reservation");
    const reason = "gate: identity profile failed — refusing to dispatch (sign-check scratch dir: No space left on device (os error 28)). Fix the runner's identity config or provision the signing key.";
    const result = await g.cmd({ kind: "start_failed", stage: "inspect", reason, retained_work: true, failure_class: "prerequisite" }, "resource-failed", id, reservation.session);
    expect(result).toMatchObject({ kind: "released", barrier: { kind: "cooldown", failures: 1, reason } });
    const first = await g.cmd({ kind: "advertise", capabilities: g.capabilities });
    const second = await g.cmd({ kind: "advertise", capabilities: g.capabilities });
    expect(first.readiness).toMatchObject({ kind: "cooldown", reason, until_ts: result.barrier.until_ts });
    expect(second.readiness).toEqual(first.readiness);
    const card = await post("get", { id });
    expect(card.meta.startup_wait).toMatchObject({ phase: "waiting_executor", retained_work: true, host: g.host });
    expect(card.meta.execution_requirements.host).toBe(g.host);
  });
  it("publishes the actual managed-update hold instead of ready or a generic missing-model explanation", async () => {
    const g = await gateway("update-hold");
    const reason = "Managed update is draining active workers before restart; new claims are paused";
    await g.cmd({ kind: "advertise", capabilities: { ...g.capabilities, availability: { kind: "unavailable", reason } } });
    const response = await stub.fetch("https://kb/board", { method: "GET" });
    const board = await response.json() as { workers: { host: string; state: string; reason: string }[] };
    expect(board.workers.find(worker => worker.host === g.host)).toMatchObject({ state: "unavailable", reason });
  });
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

describe("priority line recovery capacity", () => {
  it("keeps independent review of an urgent concrete repair ahead of unrelated repair backlog", async () => {
    const project = "critical-repair-review", g = await gateway(project, 3);
    const older = await task(project, { machine_duty: { kind: "task-recovery", reason: "queue_binding" } });
    const repair = await task(project, { boosted: Date.now(), machine_duty: { kind: "task-recovery", reason: "head_checks" } });
    const claim = await reserve(g);
    if (claim.kind !== "reserved" || claim.task_id !== repair) throw new Error("urgent repair not reserved");
    const handoff = await post("transition", { ...g.auth, id: repair, session: claim.session, to: "in_review",
      note: "PR https://github.com/state-vector/bridge/pull/6998 — repair delivered, independent review required" });
    expect(handoff.error).toBeUndefined();
    const review = await post("get", { id: handoff.verify_task });
    expect(review.meta).toMatchObject({ execution_review_of: repair,
      machine_duty: { kind: "task-recovery", by: "recovery-review", subject: repair, reason: "head_checks" } });
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: handoff.verify_task });
    expect(handoff.verify_task).not.toBe(older);
  });
  it("honours explicit urgency within concrete repairs in both discovery and atomic reservation", async () => {
    const project = "urgent-repair", g = await gateway(project);
    const older = await task(project, { machine_duty: { kind: "task-recovery", reason: "queue_binding" } });
    const urgent = await task(project, { boosted: Date.now(), machine_duty: { kind: "task-recovery", reason: "head_checks" } });
    const orientation = await post("orient", { ...g.auth, label: g.host, tags: ["gateway"] });
    const ids = orientation.unclaimed_work.map((t: { id: string }) => t.id);
    expect(ids.indexOf(urgent)).toBeLessThan(ids.indexOf(older));
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: urgent });
  });
  it("ranks concrete repairs above ordinary verification and generic diagnostics in discovery and reservation", async () => {
    const project = "repair-priority", g = await gateway(project, 3);
    const verify = await task(project); await post("update", { id: verify, roles: ["review"] });
    const diagnostic = await task(project, { machine_duty: { kind: "diagnostic", subject: "lane" } });
    const repair = await task(project, { machine_duty: { kind: "task-recovery", reason: "head_checks", subject: "candidate" } });
    const orientation = await post("orient", { ...g.auth, label: g.host, tags: ["gateway"] });
    const ids = orientation.unclaimed_work.map((t: { id: string }) => t.id);
    expect(ids.indexOf(repair)).toBeLessThan(ids.indexOf(diagnostic));
    expect(ids.indexOf(repair)).toBeLessThan(ids.indexOf(verify));
    expect(await g.cmd({ kind: "schedule", mode: "request_capacity" })).toMatchObject({ kind: "ready", active: 0, reserved: 0 });
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: repair });
  });
  it("checkpoint-preempts exactly one verifier, retains its slot until quiescence and dispatches recovery before the verifier resumes", async () => {
    const project = "repair-preemption", g = await gateway(project);
    const victim = await task(project); await post("update", { id: victim, roles: ["review"] });
    const r = await reserve(g); if (r.kind !== "reserved") throw new Error("no verification reservation");
    await g.cmd({ kind: "begin", attempt_id: "verification", worker: g.auth.agent, action_budget_ms: 60_000 }, "verify-begin", victim, r.session);
    await g.cmd({ kind: "checkpoint", generation: 1, attempt_id: "verification", checkpoint: publishedCheckpoint }, "verify-checkpoint", victim, r.session);
    const repair = await task(project, { machine_duty: { kind: "task-recovery", reason: "head_checks", subject: "candidate" } });
    expect((await g.cmd({ kind: "schedule", mode: "inspect" })).preemption).toBeUndefined();
    expect((await g.cmd({ kind: "inspect" }, "before-preempt", victim, r.session)).messages).toHaveLength(0);
    const responses = await Promise.all([g.cmd({ kind: "schedule", mode: "request_capacity" }, "full-runner-capacity"), reserve(g, "preempt-a"), reserve(g, "preempt-b")]);
    for (const result of responses) expect(result).toMatchObject({ kind: "at_capacity", active: 1, reserved: 0,
      preemption: { phase: "stopping_verification", recovery_id: repair, victim_id: victim, generation: 1, checkpoint_commit: publishedCheckpoint.commit } });
    const stopped = await g.cmd({ kind: "poll", generation: 1, attempt_id: "verification" }, "verify-poll", victim, r.session);
    expect(stopped.attempt.phase).toBe("stopping");
    expect(stopped.messages).toHaveLength(1);
    const message = stopped.messages[0].id;
    await g.cmd({ kind: "ack", generation: 1, attempt_id: "verification", message_id: message, state: "acknowledged" }, "verify-ack", victim, r.session);
    await g.cmd({ kind: "ack", generation: 1, attempt_id: "verification", message_id: message, state: "acted" }, "verify-acted", victim, r.session);
    expect(await reserve(g)).toMatchObject({ kind: "at_capacity", active: 1 });
    await g.cmd({ kind: "quiesce", generation: 1, attempt_id: "verification", writers: "process_group_empty" }, "verify-quiet", victim, r.session);
    expect((await g.cmd({ kind: "inspect" }, "recovery-slot-owner", victim, r.session)).capacity_handoff).toMatchObject({ phase: "slot_available", recovery_id: repair });
    expect((await g.cmd({ kind: "begin", attempt_id: "cannot-steal-slot", worker: g.auth.agent, action_budget_ms: 60_000 }, "verify-cannot-resume-first", victim, r.session)).error).toMatch(/priority recovery/);
    await g.cmd({ kind: "yield", generation: 1, attempt_id: "verification" }, "verify-yield", victim, r.session);
    expect((await post("get", { id: victim })).status).toBe("todo");
    expect((await g.cmd({ kind: "inspect" }, "preserved-verifier", victim, r.session)).attempt.checkpoint).toEqual(publishedCheckpoint);
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: repair });
    expect((await g.cmd({ kind: "schedule_status", host: g.host })).hosts[0]).toMatchObject({ active: 0, reserved: 1 });
  });
  it("does not interrupt uncheckpointed verification, recovery verification or pending external operations", async () => {
    const project = "repair-protection", g = await gateway(project);
    const victim = await task(project); await post("update", { id: victim, roles: ["review"] });
    const r = await reserve(g); if (r.kind !== "reserved") throw new Error("no verification reservation");
    await g.cmd({ kind: "begin", attempt_id: "protected", worker: g.auth.agent, action_budget_ms: 60_000 }, "protected-begin", victim, r.session);
    const repair = await task(project, { machine_duty: { kind: "task-recovery", reason: "head_checks", subject: "candidate" } });
    expect((await reserve(g)).preemption).toBeUndefined();
    await g.cmd({ kind: "checkpoint", generation: 1, attempt_id: "protected", checkpoint: publishedCheckpoint }, "protected-checkpoint", victim, r.session);
    await post("update", { id: victim, meta: { execution_review_of: repair } });
    expect((await reserve(g)).preemption).toBeUndefined();
    await post("update", { id: victim, meta_delete: ["execution_review_of"] });
    await g.cmd({ kind: "prepare", generation: 1, attempt_id: "protected", operation_id: "external", action: "publish", input_revision: "head", budget_ms: 60_000 }, "protected-effect", victim, r.session);
    expect((await reserve(g)).preemption).toBeUndefined();
    expect((await g.cmd({ kind: "inspect" }, "still-protected", victim, r.session)).messages).toHaveLength(0);
  });
});
