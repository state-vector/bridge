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

let serial = 0;
const checkpoint = { repo: "https://github.com/state-vector/bridge", remote_ref: "refs/heads/bridge-checkpoints/test/1/1", commit: "a".repeat(40), tree: "b".repeat(40), base: "c".repeat(40), environment: ["linux"], next: "Continue repair", tests: [] };
const localCapabilities = { tier: "large", backend: "interactive", model: "test/large", tools: ["git"], environment: ["linux"], projects: ["bridge"] };
async function runtimeTask() {
  const name = `handoff-host-${++serial}`;
  const gateway = (await post<{ secret: string }>("admin.mint", { label: name, tags: ["gateway"] })).data;
  const identity = (await post<{ token_id: string }>("auth.identify", { bearer: gateway.secret })).data;
  const worker = (await post<{ id: string; secret: string }>("agent.provision", { label: `${name}/worker`, actor: name })).data;
  const base = { actor: name, token_id: identity.token_id, gateway: true, agent: `${name}/worker`, session: `dispatch-${serial}` };
  await post("execution", { ...base, id: "gateway", command_id: "advertise", command: { kind: "advertise", capabilities: { ...localCapabilities, backend: "opencode", capacity: 4, worker: { kind: "provisioned", label: `${name}/worker` } } } });
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
  it("lets a direct interactive claimant resolve an unstarted gateway prerequisite without repairing that gateway", async () => {
    const r = await runtimeTask();
    const id = (await post<{ id: string }>("create", { type: "task", title: "Unstarted gateway prerequisite", project: "bridge", qualified: true })).data.id;
    const auth = { ...r.auth, id, session: "dispatch-prerequisite-pickup" };
    expect((await post("transition", { ...auth, to: "in_progress" })).data.error).toBeUndefined();
    expect((await post("execution", { ...auth, command_id: "missing-snapshot", command: { kind: "start_failed", stage: "begin", failure_class: "prerequisite", retained_work: true, reason: "gate: snapshot unavailable on gateway" } })).data.kind).toBe("released");
    expect((await post("execution", { ...auth, command_id: "prerequisite-state", command: { kind: "availability" } })).data.startup_wait).toMatchObject({ phase: "recovery_required" });
    const local = await interactive(`direct-startup-${serial}`);
    const pickup = { id, actor: local.label, token_id: local.token_id, session: "human-startup-recovery" };
    expect((await post("transition", { ...pickup, to: "in_progress", note: "Human requested direct recovery with local source" })).data.error).toBeUndefined();
    expect((await post("progress.log", { ...pickup, note: "Local source available" })).data.kind).not.toBe("commentary");
    expect((await post("get", { id })).data.meta).not.toHaveProperty("startup_wait");
  });
  it("lets human-directed agents claim a capability wait directly, heartbeat and release without a grant loop", async () => {
    const local = await interactive(`direct-capability-${++serial}`);
    const task = (await post<{ id: string }>("create", { actor: "test", type: "task", title: "Interactive recovery of an unavailable gateway", qualified: true, project: "bridge",
      meta: { execution_requirements: { tier: "large", environment: ["offline-only"] } } })).data;
    expect((await post("get", { id: task.id })).data.status).toBe("blocked");
    const auth = { id: task.id, actor: local.label, token_id: local.token_id, session: "human-directed-recovery" };
    const claimed = await post("transition", { ...auth, to: "in_progress", note: "Human requested this recovery interactively" });
    expect(claimed.data.error).toBeUndefined();
    expect((await post("progress.log", { ...auth, note: "Actual repair in progress", completion_pct: 60, grace_minutes: 20, will: "Watch the decisive deployment" })).data.kind).not.toBe("commentary");
    const card = (await post("get", { id: task.id })).data;
    expect(card).toMatchObject({ status: "in_progress", meta: { session: auth.session, interactive_execution: { token_id: local.token_id, session: auth.session }, last_progress: { note: "Actual repair in progress", completion_pct: 60 } } });
    expect(card.meta).not.toHaveProperty("execution_wait");
    expect((await post("update", { ...auth, meta_delete: ["interactive_execution"] })).data.error).toMatch(/lifecycle infrastructure/);
    const foreign = { ...auth, session: "another-session" };
    expect((await post("progress.log", { ...foreign, note: "An additive observation" })).data.kind).toBe("commentary");
    expect((await post("transition", { ...foreign, to: "todo", note: "Cannot release another executor" })).data.error).toMatch(/claiming credential\/session/);
    expect((await post("transition", { ...auth, to: "todo", note: "Release with preserved continuation" })).data.error).toBeUndefined();
    expect((await post("get", { id: task.id })).data.meta).not.toHaveProperty("interactive_execution");
    expect((await post("transition", { ...auth, to: "in_progress", note: "Human resumes the released work" })).data.error).toBeUndefined();
  });
  it("atomically consumes a prepared local pickup, preserves checkpoints and accepts exactly one direct claimant", async () => {
    const r = await runtimeTask(); const a = await interactive(`direct-a-${serial}`); const b = await interactive(`direct-b-${serial}`);
    const claim = (agent: typeof a) => post("transition", { id: r.id, token_id: agent.token_id, actor: agent.label, session: `human-${agent.label}`, to: "in_progress", note: "Human-directed local pickup" });
    const results = await Promise.all([claim(a), claim(b)]);
    expect(results.filter(r => !r.data.error)).toHaveLength(1);
    const winner = results[0].data.error ? b : a;
    const auth = { id: r.id, token_id: winner.token_id, actor: winner.label, session: `human-${winner.label}` };
    expect((await post("progress.log", { ...auth, note: "Preserved checkpoint inspected", completion_pct: 90 })).data.kind).not.toBe("commentary");
    expect((await post("get", { id: r.id })).data.meta).toMatchObject({ last_progress: { completion_pct: 90, session: auth.session } });
    const state = ExecutionStateSchema.parse((await post("execution", { ...auth, command_id: "direct-inspect", command: { kind: "inspect" } })).data);
    expect(state.handoff).toMatchObject({ phase: "returned", checkpoint });
    expect(state.attempt?.checkpoint).toEqual(checkpoint);
    expect((await post("transition", { ...auth, to: "in_review", note: "Executed recovery: https://github.com/state-vector/bridge/actions/runs/1" })).data.error).toBeUndefined();
    expect((await post("get", { id: r.id })).data.status).toBe("in_review");
    expect((await post("progress.log", { ...r.auth, note: "Late runner must not overwrite current progress" })).data.kind).toBe("commentary");
  });
  it("does not treat cron, provisioned workers or open human decisions as direct interactive authority", async () => {
    const task = (await post<{ id: string }>("create", { actor: "test", type: "task", title: "Human decision and unavailable executor", project: "bridge", qualified: true,
      meta: { execution_requirements: { tier: "large", environment: ["offline-only"] } } })).data;
    for (const tags of [["cadence:cron"], ["provisioned"], ["by:gateway"]]) {
      const label = `not-interactive-${++serial}`;
      const token = (await post<{ secret: string }>("admin.mint", { label, tags })).data;
      const identity = (await post<{ token_id: string }>("auth.identify", { bearer: token.secret })).data;
      expect((await post("transition", { id: task.id, actor: label, token_id: identity.token_id, session: "fake-interactive", to: "in_progress", note: "Cannot impersonate" })).data.error).toMatch(/full interactive credential|wait owns/);
    }
    const ask = await post<{ id: string }>("ask.create", { actor: "test", route: { kind: "human_decision" }, to: "human", artefact_id: task.id,
      question: "Which dataset should this task repair?", details: "The dataset is a human choice before execution.",
      decision: { kind: "information", task_id: task.id, context: "Dataset missing", why_human: "Only the human knows which dataset", choices: [
        { label: "Dataset A", executor: "bridge", consequence: "Repair dataset A", action: "resume" },
        { label: "Hold", executor: "human", consequence: "Keep held", action: "hold" }] } });
    expect(ask.data.error).toBeUndefined();
    const local = await interactive(`direct-with-human-hold-${serial}`);
    expect((await post("transition", { id: task.id, actor: local.label, token_id: local.token_id, session: "human-hold", to: "in_progress", note: "Cannot bypass the unanswered choice" })).data.error).toMatch(/open human decision/);
  });
  it("requires actual old-writer quiescence before a direct claim, even when the card is parked", async () => {
    const r = await runtimeTask();
    const task = (await post<{ id: string }>("create", { actor: r.auth.actor, type: "task", title: "Writer still running", qualified: true, project: "bridge" })).data;
    const auth = { ...r.auth, id: task.id, session: "dispatch-still-running" };
    expect((await post("transition", { ...auth, to: "in_progress" })).data.error).toBeUndefined();
    expect((await post("execution", { ...auth, command_id: "begin-active-writer", command: { kind: "begin", attempt_id: "active", worker: r.auth.agent, action_budget_ms: 60_000 } })).data.error).toBeUndefined();
    await post("transition", { ...auth, to: "blocked", note: "Waiting for operation completion", await_event: { event: "time", until_ts: Date.now() + 60_000 } });
    const local = await interactive(`cannot-steal-writer-${serial}`);
    expect((await post("transition", { id: task.id, actor: local.label, token_id: local.token_id, session: "human-active-writer", to: "in_progress", note: "Need writer to stop first" })).data.error).toMatch(/writer not quiescent/);
  });
  it("prevents an old GUI sharing the gateway token from overwriting or borrowing a scoped inventory", async () => {
    const r = await runtimeTask();
    const capability = { ...localCapabilities, backend: "opencode", inventory_revision: 2, worker: { kind: "provisioned", label: `${r.auth.actor}/worker` } };
    expect((await r.command("scoped-inventory", { kind: "advertise", capabilities: capability })).data.ok).toBe(true);
    expect((await r.command("old-gui", { kind: "advertise", capabilities: { ...capability, inventory_revision: undefined, projects: ["*"] } })).data.ok).toBe(false);
    const availability = await r.command("inventory-after-old-gui", { kind: "availability" });
    expect(availability.data.hosts).toEqual(expect.arrayContaining([expect.objectContaining({ host: r.auth.actor, capabilities: expect.objectContaining({ inventory_revision: 2, projects: ["bridge"] }) })]));
    const task = (await post<{ id: string }>("create", { actor: r.auth.actor, type: "task", title: "Scoped inventory claim", project: "bridge", qualified: true })).data;
    expect((await post("transition", { ...r.auth, id: task.id, to: "in_progress", inventory_protocol: undefined })).data.error).toMatch(/scoped-inventory/);
    expect((await post("transition", { ...r.auth, id: task.id, to: "in_progress" })).data.error).toBeUndefined();
    const begin = { ...r.auth, id: task.id, command_id: "scoped-begin", command: { kind: "begin", attempt_id: "scoped", worker: r.auth.agent, action_budget_ms: 60_000 } };
    expect((await post("execution", { ...begin, inventory_protocol: undefined })).data.error).toMatch(/scoped-inventory/);
    expect((await post("execution", begin)).data.error).toBeUndefined();
    // The upgrade fence must not prevent an older writer from stopping safely.
    expect((await post("execution", { ...r.auth, id: task.id, inventory_protocol: undefined, command_id: "old-drain", command: { kind: "quiesce", generation: 1, attempt_id: "scoped", writers: "process_group_empty" } })).data.error).toBeUndefined();
  });
  it("pauses only new gateway claims without turning an operator drain into a credential repair barrier", async () => {
    const r = await runtimeTask();
    const task = (await post<{ id: string }>("create", { actor: r.auth.actor, type: "task", title: "Pending update claim", project: "bridge", qualified: true })).data;
    const auth = { ...r.auth, id: task.id, session: "dispatch-update-drain" };
    expect((await post("transition", { ...auth, to: "in_progress" })).data.error).toBeUndefined();
    const pause = await r.command("pause-gateway", { kind: "pause_claims", reason: "Operator update drain", budget_ms: 60_000 });
    expect(pause.data.kind).toBe("claims_paused");
    const availability = await post<{ hosts: { host: string; readiness: { kind: string } }[] }>("execution", { ...auth, command_id: "paused-availability", command: { kind: "availability" } });
    expect(availability.data.hosts.find(host => host.host === r.auth.actor)?.readiness.kind).toBe("cooldown");
    const release = await post("execution", { ...auth, command_id: "drain-start", command: { kind: "start_failed", stage: "begin", reason: "gate: operator paused launch", retained_work: false, failure_class: "prerequisite" } });
    expect(release.data).toMatchObject({ kind: "released", barrier: null });
    expect((await r.command("resume-gateway", { kind: "resume_claims" })).data.kind).toBe("claims_resumed");
    expect((await post("transition", { ...auth, to: "in_progress" })).data.error).toBeUndefined();
    const agent = await interactive(`cannot-pause-${serial}`);
    expect((await post("execution", { id: task.id, token_id: agent.token_id, actor: agent.label, command_id: "unauthorised-pause", command: { kind: "pause_claims", reason: "Not a gateway", budget_ms: 60_000 } })).data.error).toMatch(/authenticated gateway/);
  });
  it("converts an explicit human local choice, accepts manual preparation only with attestation, and expires grants without resuming", async () => {
    const task = (await post<{ id: string }>("create", { actor: "manual-author", type: "task", title: "Manual origin repair", project: "bridge", qualified: true })).data;
    await post("transition", { id: task.id, to: "in_progress", actor: "manual-author", session: "local-original" });
    const ask = await post<{ id: string }>("ask.create", { actor: "manual-author", route: { kind: "human_decision" }, to: "human", artefact_id: task.id,
      question: "Should this repair move to a local session?", details: "Local dataset access is required for this repair.", options: ["Work locally", "Hold"],
      decision: { kind: "authority", task_id: task.id, context: "The repair needs local dataset access.", why_human: "Only the human can approve and identify the local execution session.",
        choices: [{ label: "Work locally", executor: "human", consequence: "Prepare an explicitly authorised local handoff", action: "local_handoff" }, { label: "Hold", executor: "human", consequence: "Keep the repair parked", action: "hold" }] } });
    expect(ask.data.error).toBeUndefined();
    expect((await post("ask.answer", { id: ask.data.id, answer: "Work locally", actor: "agent" })).data.error).toMatch(/human-web/);
    expect((await post("ask.answer", { id: ask.data.id, answer: "Work locally", actor: "web:test" })).data.error).toBeUndefined();
    const state = ExecutionStateSchema.parse((await post("execution", { id: task.id, actor: "manual-author", token_id: (await interactive("manual-reader")).token_id, command_id: "read-manual", command: { kind: "inspect" } })).data);
    if (state.handoff.phase !== "preparing") throw new Error("human choice did not prepare local handoff");
    const control = { id: task.id, handoff_id: state.handoff.id, version: 1, actor: "web:test" };
    expect((await post("handoff.control", { ...control, kind: "confirm_preparation", checkpoint, writers: "human_confirmed_quiescent", evidence: "Human verified remote publication and stopped the manual writer" })).data.kind).toBe("preparation_confirmed");
    const local = await interactive("manual-local");
    const accept = { id: task.id, handoff_id: state.handoff.id, version: 2, session: "local-manual", token_id: local.token_id };
    expect((await post("handoff.control", { ...control, version: 2, kind: "authorize", label: local.label, session: accept.session, host: "manual-host", evidence: "Restored exact snapshot with the stated model/access", capabilities: localCapabilities, ttl_ms: 1 })).data.kind).toBe("authorized");
    await new Promise(resolve => setTimeout(resolve, 8));
    expect((await post("handoff.accept", accept)).data.kind).toBe("unauthorized");
    expect((await post<{ status: string }>("get", { id: task.id })).data.status).toBe("blocked");
    expect((await post("handoff.control", { ...control, version: 2, kind: "authorize", label: local.label, session: accept.session, host: "manual-host", evidence: "Human renewed explicit permission", capabilities: localCapabilities })).data.kind).toBe("authorized");
    expect((await post("handoff.accept", accept)).data.kind).toBe("accepted");
  });
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
    const model = await post<{ execution: { current: { kind: string; tier: string; session: string } } }>("get", { id: r.id });
    expect(model.data.execution.current).toMatchObject({ kind: "local", tier: "large", session: winner.session });
    expect((await post("transition", { id: r.id, to: "todo", actor: winner.label, token_id: winner.token_id, session: winner.session })).data.error).toMatch(/explicit human-authorised return/);
    const cp = await post("handoff.checkpoint", { ...request, session: winner.session, token_id: winner.token_id, checkpoint: { ...checkpoint, commit: "d".repeat(40) } });
    expect(cp.data.version).toBe(2);
    expect((await post("handoff.control", { kind: "return_autonomous", id: r.id, handoff_id: r.h.id, version: 1, writers: "human_confirmed_quiescent", actor: "web:test" })).data.kind).toBe("stale_episode");
    expect((await post("handoff.control", { kind: "return_autonomous", id: r.id, handoff_id: r.h.id, version: 2, writers: "human_confirmed_quiescent", actor: "web:test" })).data.kind).toBe("returned_autonomous");
    const history = await post<{ versions: { action: string; data: { kind?: string } }[] }>("get_history", { id: r.id, limit: 100 });
    for (const kind of ["local_handoff_requested", "local_handoff_accepted", "local_handoff_returned"]) {
      expect(history.data.versions.filter(v => v.action === "execution" && v.data.kind === kind)).toHaveLength(1);
    }
  });
  it("blocks unsupported seeded requirements immediately and restores only its capability wait", async () => {
    const task = (await post<{ id: string; status: string }>("create", { actor: "test", type: "task", title: "Needs unavailable environment", project: "bridge", qualified: true, meta: { execution_requirements: { tier: "large", tools: ["cargo"], environment: ["special-access"] } } })).data;
    expect(task.status).toBe("blocked");
    const gateway = (await post<{ secret: string }>("admin.mint", { label: "cap-restoration", tags: ["gateway"] })).data;
    const identity = (await post<{ token_id: string }>("auth.identify", { bearer: gateway.secret })).data;
    await post("agent.provision", { label: "cap-restoration/worker", actor: "cap-restoration" });
    const ready = await post("execution", { actor: "cap-restoration", token_id: identity.token_id,
      id: "gateway", command_id: "restore", command: { kind: "advertise", capabilities: { tier: "large", backend: "opencode", model: "test/large", tools: ["cargo"], environment: ["special-access"], projects: ["bridge"], worker: { kind: "provisioned", label: "cap-restoration/worker" } } } });
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
  it("does not let an advertised but unprovisioned runner claim work; safely releases a never-launched start", async () => {
    const host = "startup-host";
    const gateway = (await post<{ secret: string }>("admin.mint", { label: host, tags: ["gateway"] })).data;
    const identity = (await post<{ token_id: string }>("auth.identify", { bearer: gateway.secret })).data;
    const task = (await post<{ id: string }>("create", { type: "task", title: "Review startup recovery", roles: ["review"], qualified: true, actor: host })).data;
    const auth = { actor: host, token_id: identity.token_id, gateway: true, agent: `${host}/worker`, session: "dispatch-startup", id: task.id };
    const capabilities = { tier: "medium", model: "test/medium", tools: ["git"], environment: ["linux"], config_revision: "initial" };
    const cmd = (command_id: string, command: object) => post("execution", { ...auth, command_id, command });
    expect((await cmd("legacy", { kind: "advertise", capabilities })).data.ok).toBe(false);
    expect((await cmd("unavailable", { kind: "availability" })).data.phase).toBe("unavailable");
    expect((await post("transition", { ...auth, to: "in_progress" })).data.error).toMatch(/worker|readiness/);
    expect((await post("get", { id: task.id })).data.status).toBe("blocked"); // global policy exposes unavailable worker capacity
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
    const failure = { kind: "start_failed", stage: "begin", reason: "launch transport unavailable", retained_work: true, failure_class: "transport" };
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
  it("keeps task prerequisites from poisoning the gateway and projects persisted checkpoint affinity before claim", async () => {
    const provision = async (host: string) => {
      const gw = (await post<{ secret: string }>("admin.mint", { label: host, tags: ["gateway"] })).data;
      const token_id = (await post<{ token_id: string }>("auth.identify", { bearer: gw.secret })).data.token_id;
      await post("agent.provision", { label: `${host}/worker`, actor: host });
      const auth = { actor: host, token_id, gateway: true, agent: `${host}/worker`, session: "dispatch-affinity" };
      const capabilities = { tier: "medium", model: "test/medium", tools: ["git"], environment: ["linux"], worker: { kind: "provisioned", label: `${host}/worker` } };
      await post("execution", { ...auth, id: "gateway", command_id: "ready", command: { kind: "advertise", capabilities } });
      return { auth, capabilities };
    };
    const original = await provision("affinity-original");
    const other = await provision("affinity-other");
    const task = (await post<{ id: string }>("create", { type: "task", title: "Task startup prerequisite", roles: ["review"], qualified: true })).data;
    const auth = { ...original.auth, id: task.id };
    const cmd = (command_id: string, command: object) => post("execution", { ...auth, command_id, command });
    expect((await post("transition", { ...auth, to: "in_progress" })).data.error).toBeUndefined();
    const rejected = await cmd("task-prerequisite", { kind: "start_failed", stage: "begin", reason: "gate: task prerequisite missing", retained_work: false });
    expect(rejected.data).toMatchObject({ kind: "released", barrier: null });
    expect((await post("execution", { ...auth, command_id: "still-ready", command: { kind: "advertise", capabilities: original.capabilities } })).data.ok).toBe(true);
    expect((await post("transition", { ...auth, to: "in_progress" })).data.error).toMatch(/startup prerequisite|Startup prerequisite/);
    await post("execution", { ...auth, command_id: "repaired-task-prerequisite", command: { kind: "advertise", capabilities: { ...original.capabilities, config_revision: "task-repaired" } } });
    expect((await post("transition", { ...auth, to: "in_progress" })).data.error).toBeUndefined();
    expect((await cmd("begin", { kind: "begin", worker: "affinity-original/worker", attempt_id: "prior", action_budget_ms: 60_000 })).data.error).toBeUndefined();
    await cmd("quiet", { kind: "quiesce", generation: 1, attempt_id: "prior", writers: "process_group_empty" });
    expect((await cmd("release", { kind: "start_failed", stage: "begin", reason: "gate: task prerequisite missing", retained_work: false })).data.kind).toBe("released");
    // Legacy metadata may predate the execution record. Durable affinity must win.
    await post("update", { id: task.id, meta: { execution_requirements: {} } });
    const foreign = { ...other.auth, id: task.id };
    const availability = await post<{ requirements: { host: string }; hosts: { host: string; blockers: string[] }[] }>("execution", { ...foreign, command_id: "availability", command: { kind: "availability" } });
    expect(availability.data.requirements.host).toBe("affinity-original");
    expect(availability.data.hosts.find(h => h.host === "affinity-other")?.blockers).toContain("host:affinity-original");
    expect((await post("transition", { ...foreign, to: "in_progress" })).data.error).toMatch(/host:affinity-original/);
    expect((await post("get", { id: task.id })).data.status).toBe("todo");
    expect((await post("execution", { ...foreign, command_id: "other-still-ready", command: { kind: "advertise", capabilities: other.capabilities } })).data.ok).toBe(true);
  });
  it("recovers only proven legacy never-launched credential failures, retaining WIP affinity and real execution fences", async () => {
    const host = "legacy-startup-host";
    const gw = (await post<{ secret: string }>("admin.mint", { label: host, tags: ["gateway"], principal: "legacy-startup-principal" })).data;
    const tokenId = (await post<{ token_id: string }>("auth.identify", { bearer: gw.secret })).data.token_id;
    await post("agent.provision", { label: `${host}/worker`, actor: host });
    const task = (await post<{ id: string }>("create", { type: "task", title: "Retained legacy startup work", roles: ["impl"], qualified: true })).data;
    const auth = { id: task.id, actor: host, token_id: tokenId, gateway: true, agent: `${host}/worker`, session: "dispatch-legacy-startup" };
    const cmd = (command_id: string, command: object) => post("execution", { ...auth, command_id, command });
    await cmd("ready", { kind: "advertise", capabilities: { tier: "medium", model: "test/medium", tools: ["git"], environment: ["linux"], worker: { kind: "provisioned", label: `${host}/worker` } } });
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

  it("automatically recovers owner-lapsed legacy startup parks, preserves affinity and permits exactly one new claim", async () => {
    const host = "automatic-startup-host";
    const gw = (await post<{ secret: string }>("admin.mint", { label: host, tags: ["gateway"] })).data;
    const token_id = (await post<{ token_id: string }>("auth.identify", { bearer: gw.secret })).data.token_id;
    const auth = { actor: host, token_id, gateway: true, agent: `${host}/worker`, session: "automatic-startup" };
    const task = (await post<{ id: string }>("create", { type: "task", title: "Ownerless critical legacy startup", roles: ["impl"], tags: ["p0"], qualified: true, owner: "" })).data;
    const id = task.id;
    expect((await post("transition", { id, actor: "system:fixture", to: "blocked", note: "churn guard: five startup failures", await_event: { event: "time", until_ts: Date.now() + 86_400_000 } })).data.error).toBeUndefined();
    await post("progress.log", { ...auth, id, did: "runner: durable execution held: ERROR: gate: worker credential must be provisioned before begin" });
    await post("update", { id, meta: { session: "dead-original-runner", attempt: { attempts: 5 }, last_progress: {
      actor: host, ts: Date.now() - 3_600_000, note: "runner: durable execution held: ERROR: gate: worker credential must be provisioned before begin",
    }, execution_requirements: { tier: "medium", tools: ["git"], environment: ["linux"] } } });
    // A healthy foreign gateway cannot steal retained legacy work.
    const foreignGw = (await post<{ secret: string }>("admin.mint", { label: "automatic-foreign", tags: ["gateway"] })).data;
    const foreignId = (await post<{ token_id: string }>("auth.identify", { bearer: foreignGw.secret })).data.token_id;
    await post("agent.provision", { label: "automatic-foreign/worker", actor: "automatic-foreign" });
    const capabilities = { tier: "medium", model: "test/medium", tools: ["git"], environment: ["linux"], config_revision: "healthy" };
    await post("execution", { id: "gateway", actor: "automatic-foreign", token_id: foreignId, command_id: "foreign-ready", command: { kind: "advertise", capabilities: { ...capabilities, worker: { kind: "provisioned", label: "automatic-foreign/worker" } } } });
    expect((await post("get", { id })).data).toMatchObject({ status: "blocked", meta: { startup_wait: { phase: "waiting_executor", host } } });
    // Startup migration owns the exit even after the old cooldown elapses.
    await post("admin.startup_sweep", { now: Date.now() + 86_400_001 });
    await post("admin.startup_sweep", { now: Date.now() + 86_400_002 });
    expect((await post("get", { id })).data.status).toBe("blocked");
    expect((await post("transition", { id, actor: "interactive", session: "unsafe-claim", to: "in_progress" })).data.error).toMatch(/Waiting for a healthy executor/);
    await post("agent.provision", { label: `${host}/worker`, actor: host });
    const ready = { ...capabilities, worker: { kind: "provisioned", label: `${host}/worker` } };
    await Promise.all(["ready-one", "ready-two"].map(command_id => post("execution", { ...auth, id: "gateway", command_id, command: { kind: "advertise", capabilities: ready } })));
    const recovered = (await post("get", { id })).data;
    expect(recovered).toMatchObject({ status: "todo", meta: { execution_requirements: { host, tier: "medium", tools: ["git"] }, startup_recovery: { previous_attempts: { attempts: 5 } } } });
    expect(recovered.meta).not.toHaveProperty("blocked");
    expect(recovered.meta).not.toHaveProperty("attempt");
    expect(recovered.meta).not.toHaveProperty("startup_wait");
    const claims = await Promise.all(["claim-one", "claim-two"].map(session => post("transition", { ...auth, id, session, to: "in_progress" })));
    expect(claims.filter(c => !c.data.error)).toHaveLength(1);
    const history = (await post<{ versions: { summary: string }[] }>("get_history", { id, limit: 100 })).data;
    expect(history.versions.filter(v => v.summary.includes("startup readiness restored"))).toHaveLength(1);
    expect(history.versions.filter(v => v.summary.includes("Critical work is waiting"))).toHaveLength(1);
  });

  it("requires a historical gateway receipt and a fresh compatible proof, not edited metadata or an expired advertisement", async () => {
    const host = "receipt-startup-host";
    const gw = (await post<{ secret: string }>("admin.mint", { label: host, tags: ["gateway"] })).data;
    const token_id = (await post<{ token_id: string }>("auth.identify", { bearer: gw.secret })).data.token_id;
    await post("agent.provision", { label: `${host}/worker`, actor: host });
    const auth = { actor: host, token_id, gateway: true, agent: `${host}/worker`, session: "receipt-startup" };
    const capabilities = { tier: "medium", model: "test/medium", tools: ["git"], environment: ["linux"], worker: { kind: "provisioned", label: `${host}/worker` } };
    const advertise = () => post("execution", { ...auth, id: "gateway", command_id: "receipt-ready", command: { kind: "advertise", capabilities } });
    await advertise();
    const ids: string[] = [];
    for (const receipted of [false, true]) {
      const id = (await post<{ id: string }>("create", { type: "task", title: `Legacy receipt ${receipted}`, qualified: true })).data.id;
      ids.push(id);
      await post("transition", { id, actor: "system:fixture", to: "blocked", note: "churn guard: legacy startup", await_event: { event: "time", until_ts: Date.now() + 86_400_000 } });
      if (receipted) await post("progress.log", { ...auth, id, did: "runner: durable execution held: ERROR: gate: worker credential must be provisioned before begin" });
      await post("update", { id, meta: { last_progress: { actor: host, ts: Date.now(), note: "runner: durable execution held: ERROR: gate: worker credential must be provisioned before begin" } } });
    }
    await post("admin.startup_sweep", { now: Date.now() + 121_000 });
    expect((await post("get", { id: ids[0] })).data.meta).not.toHaveProperty("startup_wait");
    expect((await post("get", { id: ids[1] })).data).toMatchObject({ status: "blocked", meta: { startup_wait: { host } } });
    await advertise();
    expect((await post("get", { id: ids[0] })).data.status).toBe("blocked");
    expect((await post("get", { id: ids[1] })).data.status).toBe("todo");
  });

  it("holds unchanged task prerequisites without poisoning other tasks, hidden progress claims or metadata bypass", async () => {
    const host = "task-prerequisite-host";
    const gw = (await post<{ secret: string }>("admin.mint", { label: host, tags: ["gateway"] })).data;
    const token_id = (await post<{ token_id: string }>("auth.identify", { bearer: gw.secret })).data.token_id;
    await post("agent.provision", { label: `${host}/worker`, actor: host });
    const auth = { actor: host, token_id, gateway: true, agent: `${host}/worker`, session: "task-prerequisite" };
    const capabilities = { tier: "medium", model: "test/medium", tools: ["git"], environment: ["linux"], capacity: 4, config_revision: "before-repair", worker: { kind: "provisioned", label: `${host}/worker` } };
    const advertise = (config_revision: string) => post("execution", { ...auth, id: "gateway", command_id: config_revision, command: { kind: "advertise", capabilities: { ...capabilities, config_revision } } });
    await advertise("before-repair");
    const task = (await post<{ id: string }>("create", { type: "task", title: "Task-specific startup rejection", qualified: true })).data;
    const id = task.id;
    expect((await post("transition", { ...auth, id, to: "in_progress" })).data.error).toBeUndefined();
    const failure = { ...auth, id, command_id: "prerequisite-failed", command: { kind: "start_failed", stage: "begin", failure_class: "prerequisite", retained_work: true, reason: "gate: task snapshot unavailable" } };
    expect((await post("execution", failure)).data).toMatchObject({ kind: "released", barrier: null });
    expect((await post("execution", failure)).data.kind).toBe("released");
    await advertise("before-repair");
    expect((await post("execution", { ...auth, id, command_id: "held-availability", command: { kind: "availability" } })).data).toMatchObject({ phase: "unavailable", startup_wait: { phase: "recovery_required" } });
    expect((await post("progress.log", { ...auth, id, did: "late output must not reclaim" })).data.kind).toBe("commentary");
    expect((await post("get", { id })).data.status).toBe("todo");
    expect((await post("update", { id, meta_delete: ["startup_wait"] })).data.error).toMatch(/owned by executor/);
    expect((await post("update", { id, meta: { startup_wait: null } })).data.error).toMatch(/owned by executor/);
    const other = (await post<{ id: string }>("create", { type: "task", title: "Unrelated dispatch remains healthy", qualified: true })).data;
    expect((await post("transition", { ...auth, id: other.id, session: "unrelated-work", to: "in_progress" })).data.error).toBeUndefined();
    await advertise("after-repair");
    expect((await post("get", { id })).data.meta).not.toHaveProperty("startup_wait");
    expect((await post("transition", { ...auth, id, session: "repaired-work", to: "in_progress" })).data.error).toBeUndefined();
    const localId = (await post<{ id: string }>("create", { type: "task", title: "Explicit local conversion of startup wait", qualified: true })).data.id;
    await post("transition", { ...auth, id: localId, to: "in_progress" });
    await post("execution", { ...failure, id: localId });
    expect((await post("handoff.control", { id: localId, actor: "web:test", kind: "request_local", reason: "Needs local source", action: "Prepare local source repair" })).data.kind).toBe("requested");
    await advertise("after-local-request");
    const localTask = (await post("get", { id: localId })).data;
    expect(localTask).toMatchObject({ status: "blocked", meta: { blocked: { await_event: { event: "local_handoff" } } } });
    expect(localTask.meta).not.toHaveProperty("startup_wait");
  });

  it("does not migrate independent waits, recent claims, or any real execution history", async () => {
    const host = "protected-startup-host";
    const gw = (await post<{ secret: string }>("admin.mint", { label: host, tags: ["gateway"] })).data;
    const token_id = (await post<{ token_id: string }>("auth.identify", { bearer: gw.secret })).data.token_id;
    await post("agent.provision", { label: `${host}/worker`, actor: host });
    const auth = { actor: host, token_id, gateway: true, agent: `${host}/worker`, session: "protected-startup" };
    const capabilities = { tier: "medium", model: "test/medium", tools: ["git"], environment: ["linux"], capacity: 5, worker: { kind: "provisioned", label: `${host}/worker` } };
    await post("execution", { ...auth, id: "gateway", command_id: "protected-ready", command: { kind: "advertise", capabilities } });
    const ids: string[] = [];
    for (const variant of ["ask", "pr", "live", "writer", "unknown-operation"]) {
      const id = (await post<{ id: string }>("create", { type: "task", title: `Protected startup ${variant}`, qualified: true })).data.id;
      ids.push(id);
      expect((await post("transition", { ...auth, id, to: "in_progress" })).data.error).toBeUndefined();
      if (variant === "writer" || variant === "unknown-operation") {
        await post("execution", { ...auth, id, command_id: "real-begin", command: { kind: "begin", worker: `${host}/worker`, attempt_id: variant, action_budget_ms: 60_000 } });
        if (variant === "unknown-operation") {
          await post("execution", { ...auth, id, command_id: "external", command: { kind: "prepare", generation: 1, attempt_id: variant, operation_id: "external", action: "publish", input_revision: "input", budget_ms: 1000 } });
          await post("execution", { ...auth, id, command_id: "quiesce", command: { kind: "quiesce", generation: 1, attempt_id: variant, writers: "process_group_empty" } });
        }
      }
      if (variant !== "live") await post("transition", { ...auth, id, to: "blocked", note: variant === "pr" ? "waiting for PR" : "churn guard: startup failure", await_event: variant === "pr" ? { event: "pr_merged", repo: "state-vector/example", n: 1 } : { event: "time", until_ts: Date.now() + 86_400_000 } });
      await post("progress.log", { ...auth, id, did: "runner: durable execution held: ERROR: gate: worker credential must be provisioned before begin" });
      await post("update", { id, meta: { ...(variant === "ask" ? { awaiting_ask: { ask_id: "existing-human-decision" } } : {}), last_progress: {
        actor: host, ts: variant === "live" ? Date.now() : Date.now() - 3_600_000, note: "runner: durable execution held: ERROR: gate: worker credential must be provisioned before begin",
      } } });
    }
    await post("admin.startup_sweep", {});
    for (const id of ids) {
      const task = (await post("get", { id })).data;
      expect(task.status).not.toBe("todo");
      expect(task.meta).not.toHaveProperty("startup_wait");
      expect(task.meta).not.toHaveProperty("startup_recovery");
    }
    // Five protected scenarios perform dozens of real DO round trips. The CI
    // host exceeded Vitest's default 5s under suite load; this is a bounded
    // integration budget, not an executor lease or a relaxed state assertion.
  }, 15_000);

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
    const advertised = await post("execution", { ...auth, command_id: "capabilities", command: { kind: "advertise", capabilities: { tier: "medium", model: "test/medium", tools: ["git"], environment: ["linux"], worker: { kind: "provisioned", label: "exec-host/worker" } } } });
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
