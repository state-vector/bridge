import { Miniflare } from "miniflare";
import { readFileSync, realpathSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SchedulingOutcomeSchema } from "@bridge/contracts";
import { executorRequest } from "./executor-fixture";

let mf: Miniflare;
let stub: { fetch(url: string, init: RequestInit): Promise<Response> };
let serial = 0;
async function post(op: string, body: object) {
  const response = await stub.fetch(`https://kb/${op}`, { method: "POST", headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify(executorRequest(body)) });
  return await response.json() as Record<string, any>; // JSON transport boundary, schemas validate outcomes
}
// Every scenario gets its own real SQLite hub. Sharing one growing backlog
// made later eligibility/maintenance scans depend on unrelated earlier tests
// and exceed the CI budget; suite order must not be a scheduler input.
beforeEach(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  const root = bundle.slice(0, bundle.lastIndexOf("/"));
  const rig = `import { KnowledgeHub } from "./index.js";
    export class SchedulingRig extends KnowledgeHub {
      async fetch(request) {
        if (new URL(request.url).pathname !== "/fixture/spent-route") return super.fetch(request);
        const { id } = await request.json();
        const sql = this.state.storage.sql;
        const row = sql.exec("SELECT * FROM artefacts WHERE id=?", id).toArray()[0];
        const state = sql.exec("SELECT state FROM execution_state WHERE task_id=?", id).toArray()[0].state;
        const revision = JSON.parse(row.meta).work_revision;
        for (let i=0; i<66; i++) {
          const clone = "BR#" + (10000+i);
          sql.exec("INSERT INTO artefacts(id,type,title,body_md,status,owner,created_ts,updated_ts,status_ts,project,roles,tags,meta) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            clone,row.type,row.title,row.body_md,row.status,row.owner,1,1,1,row.project,row.roles,row.tags,
            i < 33 ? row.meta : JSON.stringify({...JSON.parse(row.meta),execution_requirements:{tier:"large",tools:["missing-tool"],environment:[]}}));
          sql.exec("INSERT INTO execution_state(task_id,state,worker_token_id) VALUES(?,?,'')",clone,state);
          if (i < 33) sql.exec("INSERT INTO execution_commands(task_id,command_id,request,result) VALUES(?,?,?,?)",clone,"spent-proxy",
            JSON.stringify({command:{kind:"begin"}}),JSON.stringify({recovery_permit:{phase:"consumed",task_revision:revision,
              proof:{witness:{kind:"configured_proxy_request"}}}}));
        }
        return Response.json({ok:true});
      }
    }
    export default {fetch(){return new Response("fixture");}};`;
  mf = new Miniflare({ modulesRoot: root, modules: [
    { type: "ESModule", path: root + "/scheduling-rig.js", contents: rig },
    { type: "ESModule", path: bundle, contents: readFileSync(bundle, "utf8") },
  ], compatibilityDate: "2025-09-06", durableObjects: { KB: { className: "SchedulingRig", useSQLite: true } } });
  const ns = await mf.getDurableObjectNamespace("KB");
  stub = await ns.get(ns.idFromName("scheduler")) as unknown as typeof stub;
});
afterEach(async () => { await mf?.dispose(); });

const publishedCheckpoint = { repo: "https://github.com/state-vector/bridge", remote_ref: "refs/heads/bridge-checkpoints/recovery-priority",
  commit: "a".repeat(40), tree: "b".repeat(40), base: "c".repeat(40), environment: ["linux"], next: "Resume the preserved verification", tests: [] };

async function gateway(project: string, capacity = 1) {
  const host = `scheduler-${++serial}`;
  const token = await post("admin.mint", { label: host, tags: ["gateway"] });
  const identity = await post("auth.identify", { bearer: token.secret });
  const provisioned = await post("agent.provision", { label: `${host}/worker`, actor: host });
  const worker = { actor: `${host}/worker`, token_id: provisioned.id, gateway: false };
  const auth = { actor: host, token_id: identity.token_id, gateway: true, agent: `${host}/worker`, session: `gateway-${serial}` };
  const capabilities = { tier: "small", tools: ["git"], environment: ["linux"], backend: "opencode", model: "test/small", config_revision: "one", capacity, projects: [project], worker: { kind: "provisioned", label: `${host}/worker` } };
  const cmd = (command: object, command_id = `command-${++serial}`, id = "gateway", session = auth.session) => post("execution", { ...auth, id, session, command_id, command });
  expect((await cmd({ kind: "advertise", capabilities })).ok).toBe(true);
  return { auth, worker, capabilities, cmd, host };
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
  it("never reserves or claims the configured standing alarm sink", async () => {
    const project = "anchor", g = await gateway(project);
    const sink = await task(project);
    expect((await post("admin.settings_set", { settings: { train_alarm_sink_id: sink } })).error).toBeUndefined();
    expect(await reserve(g)).toMatchObject({ kind: "no_eligible_work", eligible: 0 });
    expect((await post("transition", { id: sink, to: "in_progress", actor: "operator", session: "anchor-test" })).error)
      .toMatch(/standing infrastructure/);
    const board = await (await stub.fetch("https://kb/board", { method: "GET" })).json() as { tasks: { id: string; meta: unknown }[] };
    expect(board.tasks.find(task => task.id === sink)).toMatchObject({ meta: { infra_anchor: true } });
  });

  it.each(["configured_route_observed", "configured_proxy_request", "verified_route_event"])("admits one %s recovery through scheduler and begin without erasing failures", async (witnessKind) => {
    const event = witnessKind === "verified_route_event";
    const proxy = witnessKind !== "configured_route_observed";
    const project = "provider-recovery", g = await gateway(project);
    const larger = {...g.capabilities,tier:"large"};
    await g.cmd({kind:"advertise",capabilities:{...g.capabilities,alternatives:[larger]}});
    const id = await task(project,{execution_requirements:{tier:"large",tools:[],environment:[]}});
    const outcome = { kind: "failed", exit_code: 1, stdout_tail: "Preserved partial work",
      stderr_tail: proxy
        ? "acp session/prompt failed: Internal error: No deployments available for selected model, Try again in 30 seconds. Passed model=test/small. pre-call-checks=False, cooldown_list=[]"
        : "acp session/prompt failed: Authentication required: provider authentication required " };
    async function exhaust(taskId: string) {
      let terminal: Record<string, unknown> = {};
      for (let generation = 1; generation <= 3; generation++) {
        const claim = await reserve(g);
        if (claim.kind !== "reserved") throw new Error(JSON.stringify(claim));
        const attempt_id = `failed-${generation}`, fence = { generation, attempt_id };
        expect((await g.cmd({ kind: "begin", attempt_id, worker: g.auth.agent, action_budget_ms: 60_000,selection:{backend:g.capabilities.backend,model:g.capabilities.model,tier:"large"} }, `begin-${generation}`, taskId, claim.session)).error).toBeUndefined();
        const stopped = { ...fence, writers: "process_group_empty", outcome };
        expect((await g.cmd({ kind: "stopped", ...stopped }, `stop-${generation}`, taskId, claim.session)).error).toBeUndefined();
        const final = await g.cmd({ kind: "finalize", ...stopped }, `final-${generation}`, taskId, claim.session);
        expect(final.error).toBeUndefined(); terminal = final.terminal;
        expect(final.budget_exhaustions).toBe(generation);
      }
      return terminal;
    }
    const terminal = await exhaust(id);
    expect(await reserve(g)).toMatchObject({ kind: "no_eligible_work", reasons: { retry_budget: 1 } });
    const boardTask = async (taskId = id) => {
      const response = await stub.fetch("https://kb/board", { method: "GET" });
      const board = await response.json() as { tasks: { id: string; gateway_dispatch: unknown }[] };
      return board.tasks.find(task => task.id === taskId);
    };
    expect(await boardTask()).toMatchObject({ gateway_dispatch: { kind: "held", reasons: ["retry_budget"] } });
    const needsHost = await task(project, { execution_requirements: { tier: "small", tools: ["fixture-missing-tool"], environment: [] } });
    expect(await boardTask(needsHost)).toMatchObject({ status: "blocked", meta: {
      execution_wait: { kind: "capability" }, execution_blockers: [{ kind: "capability_unavailable" }],
    } });
    expect((await g.cmd({ kind: "pause_claims", budget_ms: 60_000, reason: "fixture: temporarily unavailable" })).kind).toBe("claims_paused");
    expect(await boardTask()).toMatchObject({ gateway_dispatch: { kind: "held", reasons: ["retry_budget"] } });
    expect(await boardTask(needsHost)).toMatchObject({ status: "blocked" });
    await g.cmd({ kind: "resume_claims" });

    const additional = [];
    if (event) {
      const newer = await task(project, { boosted: true, execution_requirements: { tier: "large", tools: [], environment: [] } });
      await exhaust(newer);
      expect(await post("fixture/spent-route", { id })).toEqual({ ok: true });
    }
    if (proxy && !event) {
      for (let i = 0; i < 4; i++) {
        const taskId = await task(project, { execution_requirements: { tier: "large", tools: [], environment: [] } });
        additional.push({ taskId, terminal: await exhaust(taskId) });
      }
    }
    const token = await post("admin.mint", { label: `recovery-reviewer-${serial}`, tags: [] });
    const identity = await post("auth.identify", { bearer: token.secret });
    const auth = { actor: `recovery-reviewer-${serial}`, token_id: identity.token_id, session: "recovery-review" };
    const proof = { id: "request-one", host:g.host, backend:g.capabilities.backend, model:g.capabilities.model, config_revision:"one",
      result:{kind:"succeeded",response_receipt:"ssm:request"},observed_at:Date.now(), request:{kind:"configured_model_request",max_output_tokens:32000,tools:"none"}, actual_model:"provider/small",
      configuration_receipt:"ssm:config", receipts:["ssm:request"], witness:{kind:event ? "configured_proxy_request" : witnessKind,configured_model:g.capabilities.model,
        allowed_actual_models:["provider/small"],configured_max_output_tokens:32000,observed_max_output_tokens:32000,configuration_receipt:"ssm:config"} };
    const command = {kind:"recover_provider_failure",terminal,proof,diagnosis:proxy ? "provider_route_unavailable" : "provider_authentication",continuation:"Inspect PR before any push",evidence:["ssm:request"]};
    const recover = (command_id: string, c: object = command) => post("execution", {...auth,id,command_id,command:c});
    for (const wrong of [{...proof,actual_model:"different"},{...proof,request:{...proof.request,max_output_tokens:10}},{...proof,observed_at:1}]) {
      expect((await recover(`wrong-${++serial}`,{...command,proof:wrong})).error).toMatch(/proof|request/);
    }
    expect((await post("execution",{...g.worker,id,session:"worker-self-recovery",command_id:"worker-grant",command})).error).toMatch(/full-agent/);
    if (event) {
      const verified = { kind: "provider_route_verified", proof };
      const submit = (command_id: string) => post("execution", { ...auth, id: "gateway", command_id, command: verified });
      expect((await g.cmd(verified)).error).toMatch(/full-agent/);
      const receipt = await submit("route-observed");
      expect(receipt).toEqual({ kind: "verified_route_recovery", granted: [id] });
      const resumed = await reserve(g);
      if (resumed.kind !== "reserved") throw new Error(JSON.stringify(resumed));
      expect(resumed.task_id).toBe(id);
      const begun = await g.cmd({ kind: "begin", attempt_id: "event-recovered", worker: g.auth.agent,
        action_budget_ms: 60_000, selection: { backend: g.capabilities.backend, model: g.capabilities.model, tier: "large" } },
        "event-begin", id, resumed.session);
      expect(begun).toMatchObject({ generation: 4, budget_exhaustions: 3, recovery_permit: { phase: "consumed" } });
      expect(await submit("different-transport-command")).toEqual(receipt);
      return;
    }
    const grant = await recover("grant");
    expect(grant).toMatchObject({kind:"provider_recovery_granted",budget_exhaustions:3});
    expect(await boardTask()).toMatchObject({ gateway_dispatch: { kind: "eligible" } });
    await g.cmd({ kind: "pause_claims", budget_ms: 60_000, reason: "fixture: permit route paused" });
    expect(await boardTask()).toMatchObject({ gateway_dispatch: { kind: "gateway_unavailable", reasons: ["recovery_route"] } });
    await g.cmd({ kind: "resume_claims" });

    expect(await recover("grant")).toEqual(grant);
    expect((await recover("grant-again")).error).toMatch(/already granted/);
    const resumed = await reserve(g);
    if(resumed.kind !== "reserved") throw new Error(JSON.stringify(resumed));
    expect(resumed.task?.meta).toMatchObject({execution_recovery_selection:{backend:g.capabilities.backend,model:g.capabilities.model,config_revision:"one",tier:"large"}});
    const begin = {kind:"begin",attempt_id:"recovered",worker:g.auth.agent,action_budget_ms:60_000,selection:{backend:g.capabilities.backend,model:g.capabilities.model,tier:"large"}};
    const next = await g.cmd(begin,"recovered-begin",id,resumed.session);
    expect(next).toMatchObject({generation:4,budget_exhaustions:3,recovery_permit:{phase:"consumed",consumed_generation:4,continuation:command.continuation,terminal}});
    expect(await g.cmd(begin,"recovered-begin",id,resumed.session)).toEqual(next);
    expect((await g.cmd({...begin,attempt_id:"duplicate"},"duplicate-begin",id,resumed.session)).error).toMatch(/quiescence|budget/);
    if (proxy) {
      for (const [index, entry] of additional.entries()) {
        const trial = await post("execution", { ...auth, id: entry.taskId, command_id: "same-proxy-receipt",
          command: { ...command, terminal: entry.terminal } });
        if (index < 3) expect(trial).toMatchObject({ kind: "provider_recovery_granted" });
        else expect(trial.error).toMatch(/already granted four/);
      }
    }
    if (proxy) {
      const stopped = { generation: 4, attempt_id: begin.attempt_id, writers: "process_group_empty", outcome };
      expect((await g.cmd({ kind: "stopped", ...stopped }, "proxy-stop", id, resumed.session)).error).toBeUndefined();
      const final = await g.cmd({ kind: "finalize", ...stopped }, "proxy-final", id, resumed.session);
      expect(final.error).toBeUndefined();
      const fresh = { ...proof, id: "full-witness", observed_at: Date.now() + 1,
        witness: { ...proof.witness, kind: "configured_route_observed" } };
      while (Date.now() < fresh.observed_at) await new Promise(resolve => setTimeout(resolve, 1));
      expect(await recover("replacement", { ...command, terminal: final.terminal, proof: fresh })).toMatchObject({ kind: "provider_recovery_granted" });
      expect((await recover("repeat-proxy", { ...command, terminal: final.terminal,
        proof: { ...proof, id: "second-proxy", observed_at: fresh.observed_at } })).error).toMatch(/trial already ran/);
    }
  });

  it("carries the effective reasoning tier from reservation through begin", async () => {
    const project = "reservation-model-tier", g = await gateway(project);
    const large = { ...g.capabilities, tier: "large", model: "test/large" };
    expect((await g.cmd({ kind: "advertise", capabilities: { ...large, alternatives: [g.capabilities] } })).ok).toBe(true);
    expect((await post("admin.settings_set", { settings: { model_policy: { impl: { kind: "minimum", tier: "large" } } } })).error).toBeUndefined();
    const id = await task(project, { execution_requirements: { tier: "small", tools: [], environment: [] } });
    const claim = await reserve(g, "large-reservation");
    if (claim.kind !== "reserved") throw new Error("no reservation");
    expect(claim.task_id).toBe(id);
    expect(claim.task?.meta).toMatchObject({
      execution_requirements: { tier: "small" },
      execution_scheduling_requirements: { tier: "large" },
    });
    expect(await reserve(g, "large-reservation")).toEqual(claim);
    const begun = await g.cmd({ kind: "begin", attempt_id: "large-attempt", worker: g.auth.agent, action_budget_ms: 60_000,
      selection: { backend: large.backend, model: large.model, tier: large.tier } }, "large-begin", id, claim.session);
    expect(begun).toMatchObject({ attempt: { executor: { model: "test/large", tier: "large" } } });
  });

  it("acknowledges capability renewal without reconciling the backlog on the liveness request", async () => {
    const project = "bounded-control-plane", g = await gateway(project);
    const id = await task(project, { execution_requirements: { tier: "small", tools: ["aws"], environment: [] } });
    expect((await post("get", { id })).status).toBe("blocked");
    const capabilities = { ...g.capabilities, tools: ["git", "aws"] };
    expect((await g.cmd({ kind: "advertise", capabilities })).ok).toBe(true);
    expect((await post("get", { id })).status).toBe("blocked");
    // The scheduler owns bounded reconciliation before choosing work; moving
    // it off advertisement must not strand newly eligible tasks.
    const ready = SchedulingOutcomeSchema.parse(await g.cmd({ kind: "schedule", mode: "inspect" }));
    expect(ready).toMatchObject({ kind: "ready", candidates: [id] });
  });

  it("bounds capability maintenance and fairly reaches the whole retained backlog", async () => {
    const project = "bounded-maintenance", g = await gateway(project);
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) ids.push(await task(project, { execution_requirements: { tier: "small", tools: ["aws"], environment: [] } }));
    for (let pass = 0; pass < 4; pass++) await post("admin.execution_sweep", {});
    expect((await Promise.all(ids.map(id => post("get", { id })))).every(t => t.status === "blocked")).toBe(true);
    await g.cmd({ kind: "advertise", capabilities: { ...g.capabilities, tools: ["git", "aws"] } });
    await post("admin.execution_sweep", {});
    const first = await Promise.all(ids.map(id => post("get", { id })));
    const advanced = first.filter(t => t.status === "todo").length;
    expect(advanced).toBeGreaterThan(0);
    expect(advanced).toBeLessThanOrEqual(25);
    for (let pass = 0; pass < 4; pass++) await post("admin.execution_sweep", {});
    expect((await Promise.all(ids.map(id => post("get", { id })))).every(t => t.status === "todo")).toBe(true);
  });

  it("dispatches an unowned bounced TODO repair without consuming real waits or another recovery owner's work", async () => {
    const project = "bounced-board-repair", g = await gateway(project, 3);
    const pr = (number: number) => ({ repo: "state-vector/bridge", number });
    const bounce = (number: number) => ({ state: "bounced", repo: "state-vector/bridge", pr: number, bounce_kind: "conflict" });
    const runnable = await task(project, { pr: pr(901), merge_train: bounce(901) });
    await task(project, { pr: pr(902), merge_train: bounce(902), blocked: { reason: "Upstream still pending", await_event: { event: "time", until_ts: Date.now() + 86_400_000 } } });
    await task(project, { pr: pr(903), merge_train: { state: "queued", repo: "state-vector/bridge", pr: 903 } });
    const child = await task(project, { operator_gated: "Existing recovery owner has its own prerequisite" });
    await task(project, { pr: pr(904), merge_train: bounce(904), recovery: { kind: "duty", task_id: child, reason: "conflict" } });
    const discovery = SchedulingOutcomeSchema.parse(await g.cmd({ kind: "schedule", mode: "inspect" }));
    expect(discovery).toMatchObject({ kind: "ready", candidates: [runnable], reasons: { independent_wait: 3 } });
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: runnable });
  });
  it("cancels a never-launched reservation without poisoning readiness or spending retry budget, including lost-response replay", async () => {
    const project = "drain-cancel-reservation", g = await gateway(project), peer = await gateway(project);
    const id = await task(project), claim = await reserve(g);
    if (claim.kind !== "reserved") throw new Error("no reservation");
    const command = { kind: "cancel_start", writers: "not_launched", retained_work: true };
    expect((await peer.cmd(command, "foreign-cancel", id, claim.session)).error).toMatch(/authority|claim/);
    const cancelled = await g.cmd(command, "cancel-before-fork", id, claim.session);
    expect(cancelled).toMatchObject({ kind: "released", barrier: null });
    expect(await g.cmd(command, "cancel-before-fork", id, claim.session)).toEqual(cancelled);
    const state = await g.cmd({ kind: "inspect" }, "cancelled-state", id, claim.session);
    expect(state).toMatchObject({ generation: 0, attempt: null, budget_exhaustions: 0 });
    expect((await g.cmd({ kind: "advertise", capabilities: g.capabilities })).readiness.kind).toBe("ready");
    expect((await post("get", { id })).meta.startup_wait).toBeUndefined();
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: id });
  });
  it("atomically captures and replays a stopped result without guessing completion, then uses the same scheduler to reconcile it", async () => {
    const project = "terminal-result-protocol", g = await gateway(project), peer = await gateway(project);
    const id = await task(project), claim = await reserve(g);
    if (claim.kind !== "reserved") throw new Error("no reservation");
    await g.cmd({ kind: "begin", attempt_id: "terminal-one", worker: g.auth.agent, action_budget_ms: 60_000 }, "terminal-begin", id, claim.session);
    const final = { kind: "finalize", generation: 1, attempt_id: "terminal-one", writers: "process_group_empty",
      outcome: { kind: "completed", exit_code: 0, stdout_tail: "Work saved; explicit review still required", stderr_tail: "" } };
    expect((await peer.cmd(final, "forged-final", id, claim.session)).error).toMatch(/executor authority|originating runner/);
    expect((await g.cmd(final, "before-stop", id, claim.session)).error).toMatch(/acknowledged stopped-writer/);
    const stopped = await g.cmd({ ...final, kind: "stopped" }, "terminal-stopped", id, claim.session);
    expect(stopped).toMatchObject({ attempt: { phase: "finalizing", writers: "process_group_empty" } });
    expect((await post("get", { id })).status).toBe("in_progress");
    expect((await g.cmd({ kind: "schedule_status", host: g.host })).hosts[0].occupancy.held).toBe(0);
    expect((await g.cmd({ ...final, kind: "stopped", outcome: { ...final.outcome, stdout_tail: "replacement" } }, "changed-evidence", id, claim.session)).error).toMatch(/immutable/);
    expect((await g.cmd({ kind: "begin", attempt_id: "premature", worker: g.auth.agent, action_budget_ms: 60_000 }, "before-finalize", id, claim.session)).error).toMatch(/quiescence/);
    const first = await g.cmd(final, "terminal-final", id, claim.session);
    expect(first).toMatchObject({ attempt: { phase: "quiesced" }, terminal: { generation: 1, outcome: { kind: "completed" } } });
    expect(await g.cmd(final, "terminal-final", id, claim.session)).toEqual(first);
    expect(await g.cmd({ kind: "receipt", target_command_id: "terminal-final" }, "read-final-receipt", id, claim.session)).toEqual({ kind: "receipt_found", result: first });
    expect((await peer.cmd({ kind: "receipt", target_command_id: "terminal-final" }, "foreign-receipt", id, claim.session)).error).toMatch(/originating runner/);
    const card = await post("get", { id });
    expect(card.status).toBe("todo");
    expect(card.meta.execution_resume).toMatchObject({ kind: "terminal_result", generation: 1 });
    expect(card.meta.execution_requirements.host).toBe(g.host);
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: id });
    expect((await g.cmd(final, "old-final-not-replay", id, "wrong-session")).error).toMatch(/fenced|session/);
  });
  it("releases physical capacity but preserves unknown operations and independent waits on terminal capture", async () => {
    const project = "terminal-unknown-effects", g = await gateway(project);
    const id = await task(project), claim = await reserve(g);
    if (claim.kind !== "reserved") throw new Error("no reservation");
    await g.cmd({ kind: "begin", attempt_id: "unknown-one", worker: g.auth.agent, action_budget_ms: 60_000 }, "unknown-begin", id, claim.session);
    await g.cmd({ kind: "prepare", generation: 1, attempt_id: "unknown-one", operation_id: "publish", action: "Push exact ref", input_revision: "a", budget_ms: 60_000 }, "unknown-prepare", id, claim.session);
    const command = { kind: "finalize", generation: 1, attempt_id: "unknown-one", writers: "process_group_empty",
      outcome: { kind: "interrupted", exit_code: null, stdout_tail: "", stderr_tail: "network lost; preserve all work" } };
    expect((await g.cmd({ ...command, kind: "stopped" }, "unknown-stopped", id, claim.session)).error).toBeUndefined();
    const final = await g.cmd(command, "unknown-final", id, claim.session);
    expect(final.operations).toMatchObject([{ id: "publish", state: "prepared" }]);
    expect((await post("get", { id })).status).toBe("in_progress");
    const status = await g.cmd({ kind: "schedule_status", host: g.host });
    expect(status.hosts[0].occupancy.held).toBe(0);
    expect((await g.cmd({ kind: "begin", attempt_id: "unsafe-retry", worker: g.auth.agent, action_budget_ms: 60_000 }, "unknown-retry", id, claim.session)).error).toMatch(/unknown external operations/);
  });
  it("never resurrects stopped writers on late poll or interrupt, and bounds unfinished finalization before refilling", async () => {
    const project = "finalization-boundary", g = await gateway(project);
    const one = await task(project), two = await task(project), three = await task(project);
    const first = await reserve(g); if (first.kind !== "reserved") throw new Error("no first reservation");
    const stop = async (id: string, session: string, attempt_id: string) => {
      await g.cmd({ kind: "begin", attempt_id, worker: g.auth.agent, action_budget_ms: 60_000 }, `begin-${id}`, id, session);
      return g.cmd({ kind: "stopped", generation: 1, attempt_id, writers: "no_live_group_members",
        outcome: { kind: "result_unavailable", exit_code: null, stdout_tail: "", stderr_tail: "Recovered dead writer; preserve receipts" } }, `stop-${id}`, id, session);
    };
    const stopped = await stop(first.task_id, first.session, "stopped-one");
    expect(stopped).toMatchObject({ attempt: { phase: "finalizing", writers: "no_live_group_members" } });
    await g.cmd({ kind: "message", message_id: "late-interrupt", text: "Stop safely", priority: "interrupt" }, "late-message", first.task_id, first.session);
    await post("transition", { id: first.task_id, to: "todo", actor: "system:test", note: "Claim ended; stopped delivery remains owned" });
    const poll = await g.cmd({ kind: "poll", generation: 1, attempt_id: "stopped-one" }, "late-poll", first.task_id, first.session);
    expect(poll.attempt).toMatchObject({ phase: "finalizing", lease_until: stopped.attempt.lease_until });
    const second = await reserve(g); if (second.kind !== "reserved") throw new Error("released writer capacity was not refilled");
    expect(second.task_id).not.toBe(first.task_id);
    await stop(second.task_id, second.session, "stopped-two");
    expect(await reserve(g)).toMatchObject({ kind: "finalization_backpressure", active: 0, reserved: 0, finalizing: 2 });
    expect([one, two, three]).toContain(second.task_id);
    // Even after lease expiry, the exact finalizer can register preserved content.
    expect((await g.cmd({ kind: "checkpoint", generation: 1, attempt_id: "stopped-one", checkpoint: publishedCheckpoint }, "finalization-checkpoint", first.task_id, first.session)).error).toBeUndefined();
  });
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
  it("separates an operator admission pause from model readiness and preserves active writer control", async () => {
    const project = "operator-pause", g = await gateway(project, 2);
    const first = await task(project), claimed = await reserve(g);
    if (claimed.kind !== "reserved") throw new Error("no reservation");
    await g.cmd({ kind: "begin", attempt_id: "active", worker: g.auth.agent, action_budget_ms: 60_000 }, "begin", first, claimed.session);
    const waiting = await task(project);
    const pause = { kind: "pause_claims", reason: "Operator maintenance", budget_ms: 60_000 };
    const receipt = await g.cmd(pause, "pause"); expect(await g.cmd(pause, "pause")).toEqual(receipt);
    const advertised = await g.cmd({ kind: "advertise", capabilities: g.capabilities });
    expect(advertised.readiness).toMatchObject({ kind: "paused", reason: pause.reason, until_ts: receipt.until_ts });
    const availability = await g.cmd({ kind: "availability" }, "availability", waiting);
    expect(availability.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "executor_not_ready", causes: [expect.objectContaining({ readiness: expect.objectContaining({ kind: "paused" }) })] })]));
    expect(availability.blockers.some((b: { kind: string }) => b.kind === "capability_unavailable")).toBe(false);
    expect((await reserve(g)).kind).toBe("gateway_not_ready");
    expect((await g.cmd({ kind: "poll", generation: 1, attempt_id: "active" }, "poll", first, claimed.session)).attempt.phase).toBe("running");
    await g.cmd({ kind: "resume_claims" }, "resume");
    expect((await g.cmd({ kind: "advertise", capabilities: g.capabilities })).readiness.kind).toBe("ready");
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: waiting });
  });
  it("reports typed controller handoff while retaining the older inventory admission mask", async () => {
    const project = "typed-update", g = await gateway(project);
    const id = await task(project), reason = "Controller handoff and health verification";
    const capabilities = { ...g.capabilities, admission_hold: { kind: "update_handoff", reason }, availability: { kind: "unavailable", reason } };
    expect((await g.cmd({ kind: "advertise", capabilities })).readiness).toMatchObject({ kind: "updating", reason });
    expect((await reserve(g)).kind).toBe("gateway_not_ready");
    const availability = await g.cmd({ kind: "availability" }, "availability", id);
    expect(availability.blockers[0]).toMatchObject({ kind: "executor_not_ready", causes: [{ host: g.host, readiness: { kind: "updating", reason } }] });
    expect((await g.cmd({ kind: "advertise", capabilities: g.capabilities })).readiness.kind).toBe("ready");
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: id });
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
    await g.cmd({ kind: "schedule", mode: "inspect" });
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
  }, 15_000);
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
    expect((await g.cmd({ kind: "begin", attempt_id: "urgent-repair", worker: g.auth.agent, action_budget_ms: 60_000 }, "urgent-begin", repair, claim.session)).error).toBeUndefined();
    const handoff = await post("transition", { ...g.worker, id: repair, session: claim.session,
      execution_scope: { id: repair, generation: 1, attempt_id: "urgent-repair" }, to: "in_review",
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
  it.each(["uncheckpointed", "recovery-review", "pending-effect"])("does not interrupt protected verification: %s", async protection => {
    const project = `repair-protection-${protection}`, g = await gateway(project);
    let reviewMeta = {};
    if (protection === "recovery-review") {
      const subject = await task(project, { machine_duty: { kind: "task-recovery", reason: "head_checks" } });
      expect((await post("transition", { id: subject, to: "blocked", note: "Repair waits on an independent prerequisite",
        await_event: { event: "time", until_ts: Date.now() + 3_600_000 } })).error).toBeUndefined();
      reviewMeta = { execution_review_of: subject };
    }
    const victim = await task(project, reviewMeta); await post("update", { id: victim, roles: ["review"] });
    const r = await reserve(g); if (r.kind !== "reserved") throw new Error("no verification reservation");
    await g.cmd({ kind: "begin", attempt_id: "protected", worker: g.auth.agent, action_budget_ms: 60_000 }, "protected-begin", victim, r.session);
    if (protection !== "uncheckpointed") await g.cmd({ kind: "checkpoint", generation: 1, attempt_id: "protected", checkpoint: publishedCheckpoint }, "protected-checkpoint", victim, r.session);
    if (protection === "pending-effect") await g.cmd({ kind: "prepare", generation: 1, attempt_id: "protected", operation_id: "external", action: "publish", input_revision: "head", budget_ms: 60_000 }, "protected-effect", victim, r.session);
    await task(project, { machine_duty: { kind: "task-recovery", reason: "head_checks", subject: "candidate" } });
    expect((await reserve(g)).preemption).toBeUndefined();
    expect((await g.cmd({ kind: "inspect" }, "still-protected", victim, r.session)).messages).toHaveLength(0);
  });
});
