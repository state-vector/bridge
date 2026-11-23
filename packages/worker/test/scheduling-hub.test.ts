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
        const path = new URL(request.url).pathname;
        if (path === "/fixture/legacy-route-observation") {
          const { host } = await request.json();
          this.state.storage.sql.exec(
            "UPDATE managed_review_route_success SET proof=json_remove(proof, '$.witness.assignment') WHERE host=?", host,
          );
          return Response.json({ ok: true });
        }
        if (path === "/fixture/expired-stopping") {
          const { id } = await request.json();
          const row = this.state.storage.sql.exec("SELECT state FROM execution_state WHERE task_id=?", id).toArray()[0];
          const state = JSON.parse(row.state);
          state.attempt.phase = "stopping";
          state.attempt.lease_until = 1;
          state.attempt.action_deadline = 1;
          this.state.storage.sql.exec("UPDATE execution_state SET state=? WHERE task_id=?", JSON.stringify(state), id);
          this.reconcileSchedulingHealth(Date.now());
          return Response.json(this.executionState(id));
        }
        if (path === "/fixture/attempt-diagnosis") {
          await this.scheduleAttemptDiagnosis();
          return Response.json({ok:true});
        }
        if (path === "/fixture/bypass-budget") {
          const { id } = await request.json();
          const row = this.state.storage.sql.exec("SELECT bypasses FROM dispatch_selection_bypasses WHERE task_id=? AND stage='dispatch'", id).toArray()[0];
          return Response.json({ bypasses: row ? Number(row.bypasses) : 0 });
        }
        if (path === "/fixture/equal-queue-timestamps") {
          const { first, second } = await request.json();
          this.state.storage.sql.exec(
            "UPDATE artefacts SET created_ts=(SELECT last_reserved_at FROM dispatch_queue_turns WHERE task_id=?) WHERE id=?",
            first, second,
          );
          return Response.json({ok:true});
        }
        if (path === "/fixture/dispatch-inventory") {
           const { host, repeat = false } = await request.json();
          const executor = this.state.storage.sql.exec(
            "SELECT h.token_id,h.capabilities FROM execution_hosts h JOIN auth_tokens t ON t.id=h.token_id WHERE t.label=?", host,
          ).toArray()[0];
           const work = this.executionWork();
           const inventory = work.hostInventory.bind(work);
           const readiness = work.readiness, policy = work.modelPolicy;
           let scans = 0, readinessReads = 0, policyReads = 0;
           work.hostInventory = () => { scans++; return inventory(); };
           work.readiness = (...args) => { readinessReads++; return readiness(...args); };
           work.modelPolicy = () => { policyReads++; return policy(); };
          const original = this.executionWork;
          this.executionWork = () => work;
          try {
             const selection = this.dispatchCandidates(executor.token_id, host, JSON.parse(executor.capabilities));
             if (repeat) this.dispatchCandidates(executor.token_id, host, JSON.parse(executor.capabilities));
             return Response.json({ scans, readinessReads, policyReads, eligible: selection.eligible.map(row => row.id) });
          } finally {
            this.executionWork = original;
          }
        }
        // BR#14761 — the reserve path's own scheduling duty, with the fleet
        // pass instrumented. The reserve reopens the blocked capability wait
        // AND selects work under ONE shared ExecutionWork instance, so the
        // host inventory / host readiness / model policy reads happen once
        // for the pair; the claim's own scheduling-requirements annotation
        // stays a per-reserved-task read (first-hand by design).
        if (path === "/fixture/reserve-inventory") {
          const { host, mode = "reserve" } = await request.json();
          const executor = this.state.storage.sql.exec(
            "SELECT h.token_id,h.capabilities FROM execution_hosts h JOIN auth_tokens t ON t.id=h.token_id WHERE t.label=?", host,
          ).toArray()[0];
          const work = this.executionWork();
          const inventory = work.hostInventory.bind(work);
          const readiness = work.readiness, policy = work.modelPolicy;
          let scans = 0, readinessReads = 0, policyReads = 0;
          work.hostInventory = () => { scans++; return inventory(); };
          work.readiness = (...args) => { readinessReads++; return readiness(...args); };
          work.modelPolicy = () => { policyReads++; return policy(); };
          const original = this.executionWork;
          this.executionWork = () => work;
          try {
            const started = Date.now();
            const probeId = "reserve-inventory-" + crypto.randomUUID();
            const outcome = await this.scheduleGateway(
              { actor: host, token_id: executor.token_id, runner_protocol: "worker-ready-v2", inventory_protocol: 2 },
              executor.token_id, host, mode, probeId);
            const rejections = this.state.storage.sql.exec(
              "SELECT data FROM ledger WHERE action='dispatch_candidate_rejected' AND ts>=? ORDER BY seq DESC LIMIT 3", started).toArray();
            return Response.json({ scans, readinessReads, policyReads, kind: outcome.kind,
              task_id: outcome.task_id ?? null, candidates: outcome.candidates ?? [], reasons: outcome.reasons ?? {},
              rejections: rejections.map(r => JSON.parse(String(r.data)).reason) });
          } finally {
            this.executionWork = original;
          }
        }
        // BR#14761 — statement counter for the reserve's scheduling duty: the
        // bounded reopen pass must pay for matching capability-wait rows only,
        // never a full maintenance page of unrelated tasks.
        if (path === "/fixture/capability-cost") {
          const { host, with_reserve = false } = await request.json();
          const work = this.executionWork();
          const proto = Object.getPrototypeOf(work);
          const sqlDesc = Object.getOwnPropertyDescriptor(proto, "sql");
          let count = 0;
          Object.defineProperty(proto, "sql", {
            get() {
              const real = sqlDesc.get.call(this);
              if (!this.__probe) return real;
              if (!this.__probeSql) {
                const exec = real.exec.bind(real);
                this.__probeSql = { exec: (...args) => { count++; return exec(...args); } };
              }
              return this.__probeSql;
            },
            configurable: true,
          });
          const executor = this.state.storage.sql.exec(
            "SELECT h.token_id FROM execution_hosts h JOIN auth_tokens t ON t.id=h.token_id WHERE t.label=?", host,
          ).toArray()[0];
          try {
            proto.__probe = true;
            const sweepStatements = (count = 0, work.sweep(), count);
            const reopenStatements = (count = 0, work.reopenCapabilityWaits(), count);
            const reserveStatements = with_reserve ? (count = 0, await this.scheduleGateway(
              { actor: "cost-probe", token_id: executor.token_id, runner_protocol: "worker-ready-v2", inventory_protocol: 2 },
              executor.token_id, host, "inspect", "capability-cost-" + crypto.randomUUID()), count) : null;
            return Response.json({ sweepStatements, reopenStatements, reserveStatements });
          } finally {
            proto.__probe = false;
            Object.defineProperty(proto, "sql", sqlDesc);
          }
        }
        if (path === "/fixture/root-fix-starve") {
          const { id, age_ms = 180_000 } = await request.json();
          // Age the card past the dispatch grace so the invariant sweep sees
          // a root-fix that demonstrably was not claimed by a reserve poll.
          this.state.storage.sql.exec("UPDATE artefacts SET updated_ts=? WHERE id=?", Date.now() - age_ms, id);
          const started = Date.now();
          this.rootFixDispatchStarvationSweep(Date.now());
          const alarms = this.state.storage.sql.exec(
            "SELECT artefact_id, action FROM ledger WHERE kind='signal' AND action='root_fix_dispatch_starved' AND ts>=? ORDER BY seq DESC",
            started,
          ).toArray();
          return Response.json({ ok: true, alarms });
        }
        // BR#14703 — scheduler-health probe: seed the starved shape (eligible
        // work, free capacity, since/attention backdated past the alarm and
        // re-fire thresholds), tick the sweep once, and report the class
        // alarms it raised so a test can assert the throttle windows exactly.
        if (path === "/fixture/scheduling-health") {
          const { age_s = 0, backdate_attention_s = 0, backdate_alarm_ms = 0 } = await request.json();
          const now = Date.now();
          if (age_s) {
            // Seed a dispatch_health row for every advertised host so the
            // backdate lands even before the first sweep saw this host.
            this.state.storage.sql.exec(
              "INSERT OR IGNORE INTO dispatch_health(token_id, since) SELECT h.token_id, ? FROM execution_hosts h JOIN auth_tokens t ON t.id=h.token_id WHERE t.revoked_ts IS NULL", now,
            );
            this.state.storage.sql.exec("UPDATE dispatch_health SET since=?", now - age_s * 1000);
          }
          if (backdate_attention_s) this.state.storage.sql.exec("UPDATE dispatch_health SET attention_at=?", now - backdate_attention_s * 1000);
          if (backdate_alarm_ms) this.state.storage.sql.exec("UPDATE ledger SET ts=? WHERE kind='signal' AND action='dispatch_starved'", now - backdate_alarm_ms);
          const started = now;
          this.reconcileSchedulingHealth(Date.now());
          const alarms = this.state.storage.sql.exec(
            "SELECT action, data FROM ledger WHERE kind='signal' AND action IN ('dispatch_starved','retry_budget_pile') AND ts>=? ORDER BY seq", started,
          ).toArray().map(row => ({ action: String(row.action), data: JSON.parse(String(row.data)) }));
          return Response.json({ ok: true, alarms });
        }
        // Arm a recorded retry-budget hold, including historic exhaustions.
        if (path === "/fixture/budget-pile") {
          const { ids, age_ms = 60_000 } = await request.json();
          const now = Date.now();
          let stamped = 0;
          for (const id of ids) {
            const row = this.state.storage.sql.exec("SELECT state FROM execution_state WHERE task_id=?", id).toArray()[0];
            const state = row ? JSON.parse(row.state) : { policy_version: 1, revision: 0, generation: 0, attempt: null, requirements: {}, messages: [], operations: [] };
            state.budget_exhaustions = 3;
            state.budget_exhausted_at = now - age_ms;
            this.state.storage.sql.exec("INSERT INTO execution_state (task_id, state, worker_token_id) VALUES (?, ?, '') ON CONFLICT(task_id) DO UPDATE SET state=excluded.state", id, JSON.stringify(state));
            stamped++;
          }
          return Response.json({ ok: true, stamped });
        }
        if (path === "/fixture/closed-diagnosis") {
          const { id } = await request.json();
          this.state.storage.sql.exec("UPDATE artefacts SET status='done' WHERE id=?", id);
          return Response.json({ ok: true });
        }
        // GH #478 — park a card blocked exactly as the board parks it (typed
        // await, owner optional, session released), without a live writer path.
        if (path === "/fixture/park-blocked") {
          const { id, owner = "", await_event } = await request.json();
          const row = this.state.storage.sql.exec("SELECT meta FROM artefacts WHERE id=?", id).toArray()[0];
          const meta = JSON.parse(String(row.meta ?? "{}"));
          delete meta.session;
          meta.blocked = { reason: "fixture park", unblock_condition: "fixture park", await_event, ts: Date.now() };
          this.state.storage.sql.exec("UPDATE artefacts SET status='blocked',owner=?,meta=? WHERE id=?", owner, JSON.stringify(meta), id);
          return Response.json({ ok: true });
        }
        if (path !== "/fixture/spent-route" && path !== "/fixture/watchdog-release") return super.fetch(request);
        const { id } = await request.json();
        const sql = this.state.storage.sql;
        const row = sql.exec("SELECT * FROM artefacts WHERE id=?", id).toArray()[0];
        if (path === "/fixture/watchdog-release") {
          const meta = JSON.parse(row.meta);
          delete meta.session;
          sql.exec("UPDATE artefacts SET status='todo',owner='',meta=? WHERE id=?", JSON.stringify(meta), id);
          return Response.json({ok:true});
        }
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
  it("keeps the oldest eligible task first after its card is updated", async () => {
    const project = "oldest-eligible", g = await gateway(project);
    const older = await task(project), newer = await task(project);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect((await post("update", { id: older, actor: "author", title: "Older task with updated evidence" })).error).toBeUndefined();
    const status = await g.cmd({ kind: "schedule_status", refresh: true, host: g.host });
    expect(status.hosts[0].candidates.slice(0, 2)).toEqual([older, newer]);
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: older });
  });

  it("lets the next equally ranked repair run after a startup reservation is cancelled", async () => {
    const project = "fair-repair-retry", g = await gateway(project);
    const recovery = { machine_duty: { kind: "task-recovery", reason: "execution_environment" } };
    const first = await task(project, recovery), second = await task(project, recovery);
    const reservation = await reserve(g);
    expect(reservation).toMatchObject({ kind: "reserved", task_id: first });
    if (reservation.kind !== "reserved") throw new Error("expected a reservation");
    const equal = await stub.fetch("https://kb/fixture/equal-queue-timestamps", {
      method: "POST", body: JSON.stringify({ first, second }),
    });
    expect(await equal.json()).toEqual({ok:true});
    const cancelled = await g.cmd({ kind: "cancel_start", writers: "not_launched", retained_work: true },
      undefined, first, reservation.session);
    expect(cancelled.kind).toBe("released");
    const status = await g.cmd({ kind: "schedule_status", refresh: true, host: g.host });
    expect(status.hosts[0].candidates.slice(0, 2)).toEqual([second, first]);
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: second });
  });

  it("resolves fresh tasks from one fleet inventory without changing their order", async () => {
    const project = "fleet-inventory", g = await gateway(project);
    const expected = [];
    for (let i = 0; i < 12; i++) expected.push(await task(project));
    const response = await stub.fetch("https://kb/fixture/dispatch-inventory", {
      method: "POST", body: JSON.stringify({ host: g.host }),
    });
    expect(await response.json()).toEqual({ scans: 1, readinessReads: 1, policyReads: 1, eligible: expected });
  });
  it("discards readiness and model-policy snapshots between independent passes", async () => {
    const project = "snapshot-lifetime", g = await gateway(project);
    const expected = [await task(project), await task(project)];
    const response = await stub.fetch("https://kb/fixture/dispatch-inventory", {
      method: "POST", body: JSON.stringify({ host: g.host, repeat: true }),
    });
    expect(await response.json()).toEqual({ scans: 2, readinessReads: 2, policyReads: 2, eligible: expected });
  });

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
    async function holdForRecovery(taskId: string) {
      let terminal: Record<string, unknown> = {};
      for (let generation = 1; generation <= 3; generation++) {
        const claim = await reserve(g);
        if (claim.kind !== "reserved") throw new Error(JSON.stringify(claim));
        const attempt_id = `failed-${generation}`, fence = { generation, attempt_id };
        expect((await g.cmd({ kind: "begin", attempt_id, worker: g.auth.agent, action_budget_ms: 60_000,selection:{backend:g.capabilities.backend,model:g.capabilities.model,tier:"large"} }, `begin-${generation}`, taskId, claim.session)).error).toBeUndefined();
        const terminalOutcome = proxy && generation < 3 ? { ...outcome, stderr_tail: "Task failed before delivery" } : outcome;
        const stopped = { ...fence, writers: "process_group_empty", outcome: terminalOutcome };
        expect((await g.cmd({ kind: "stopped", ...stopped }, `stop-${generation}`, taskId, claim.session)).error).toBeUndefined();
        const final = await g.cmd({ kind: "finalize", ...stopped }, `final-${generation}`, taskId, claim.session);
        expect(final.error).toBeUndefined(); terminal = final.terminal;
        expect(final.budget_exhaustions).toBe(proxy ? Math.min(generation, 2) : generation);
      }
      return terminal;
    }
    const terminal = await holdForRecovery(id);
    const hold = proxy ? "provider_route" : "retry_budget";
    expect(await reserve(g)).toMatchObject({ kind: "no_eligible_work", reasons: { [hold]: 1 } });
    const boardTask = async (taskId = id) => {
      const response = await stub.fetch("https://kb/board", { method: "GET" });
      const board = await response.json() as { tasks: { id: string; gateway_dispatch: unknown }[] };
      return board.tasks.find(task => task.id === taskId);
    };
    expect(await boardTask()).toMatchObject({ gateway_dispatch: { kind: "held", reasons: [hold] } });
    const needsHost = await task(project, { execution_requirements: { tier: "small", tools: ["fixture-missing-tool"], environment: [] } });
    expect(await boardTask(needsHost)).toMatchObject({ status: "blocked", meta: {
      execution_wait: { kind: "capability" }, execution_blockers: [{ kind: "capability_unavailable" }],
    } });
    expect((await g.cmd({ kind: "pause_claims", budget_ms: 60_000, reason: "fixture: temporarily unavailable" })).kind).toBe("claims_paused");
    expect(await boardTask()).toMatchObject({ gateway_dispatch: { kind: "held", reasons: [hold] } });
    expect(await boardTask(needsHost)).toMatchObject({ status: "blocked" });
    await g.cmd({ kind: "resume_claims" });

    const additional = [];
    if (event) {
      const newer = await task(project, { boosted: true, execution_requirements: { tier: "large", tools: [], environment: [] } });
      await holdForRecovery(newer);
      expect(await post("fixture/spent-route", { id })).toEqual({ ok: true });
    }
    if (proxy && !event) {
      for (let i = 0; i < 4; i++) {
        const taskId = await task(project, { execution_requirements: { tier: "large", tools: [], environment: [] } });
        additional.push({ taskId, terminal: await holdForRecovery(taskId) });
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
      expect(begun).toMatchObject({ generation: 4, budget_exhaustions: 2, recovery_permit: { phase: "consumed" } });
      expect(await submit("different-transport-command")).toEqual(receipt);
      return;
    }
    const grant = await recover("grant");
    expect(grant).toMatchObject({kind:"provider_recovery_granted",budget_exhaustions:proxy ? 2 : 3});
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
    expect(next).toMatchObject({generation:4,budget_exhaustions:proxy ? 2 : 3,recovery_permit:{phase:"consumed",consumed_generation:4,continuation:command.continuation,terminal}});
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

  it("refuses foreign, mismatched, mutated, misdiagnosed, stale and duplicate recovery evidence without granting a permit", async () => {
    const project = "provider-recovery-refusals", g = await gateway(project);
    const larger = {...g.capabilities, tier: "large"};
    await g.cmd({kind: "advertise", capabilities: {...g.capabilities, alternatives: [larger]}});
    const id = await task(project, {execution_requirements: {tier: "large", tools: [], environment: []}});
    const outcome = { kind: "failed", exit_code: 1, stdout_tail: "Preserved partial work",
      stderr_tail: "acp session/prompt failed: Internal error: No deployments available for selected model, Try again in 30 seconds. Passed model=test/small. pre-call-checks=False, cooldown_list=[]" };
    const claim = await reserve(g);
    if (claim.kind !== "reserved") throw new Error(JSON.stringify(claim));
    expect((await g.cmd({ kind: "begin", attempt_id: "failed-large", worker: g.auth.agent, action_budget_ms: 60_000,
      selection: { backend: g.capabilities.backend, model: g.capabilities.model, tier: "large" } },
      "begin-failed", id, claim.session)).error).toBeUndefined();
    const stopped = { generation: 1, attempt_id: "failed-large", writers: "process_group_empty", outcome };
    expect((await g.cmd({ kind: "stopped", ...stopped }, "stop-failed", id, claim.session)).error).toBeUndefined();
    const final = await g.cmd({ kind: "finalize", ...stopped }, "final-failed", id, claim.session);
    expect(final.terminal).toBeDefined();
    // One typed route failure arms the provider_route hold: the same task is
    // refused until a witnessed grant releases it.
    expect(await reserve(g)).toMatchObject({ kind: "no_eligible_work", reasons: { provider_route: 1 } });

    const token = await post("admin.mint", { label: `recovery-reviewer-${serial}`, tags: [] });
    const identity = await post("auth.identify", { bearer: token.secret });
    const auth = { actor: `recovery-reviewer-${serial}`, token_id: identity.token_id, session: "recovery-review" };
    const proof = { id: "request-refusal", host: g.host, backend: g.capabilities.backend, model: g.capabilities.model, config_revision: "one",
      result: { kind: "succeeded", response_receipt: "ssm:request" }, observed_at: Date.now(),
      request: { kind: "configured_model_request", max_output_tokens: 32000, tools: "none" }, actual_model: "provider/small",
      configuration_receipt: "ssm:config", receipts: ["ssm:request"],
      witness: { kind: "configured_proxy_request", configured_model: g.capabilities.model, allowed_actual_models: ["provider/small"],
        observed_max_output_tokens: 32000, configuration_receipt: "ssm:config" } };
    const command = { kind: "recover_provider_failure", terminal: final.terminal, proof, diagnosis: "provider_route_unavailable",
      continuation: "Continue from the recorded checkpoint", evidence: ["ssm:request"] };
    const recover = (command_id: string, c: object = command) => post("execution", { ...auth, id, command_id, command: c });
    expect((await recover("foreign-host", { ...command, proof: { ...proof, host: "never-inventoried-host" } })).error).toMatch(/inventory is missing or stale/);
    expect((await recover("capability-mismatch", { ...command, proof: { ...proof, model: "test/other",
      witness: { ...proof.witness, configured_model: "test/other" } } })).error).toMatch(/usable selected configured capability/);
    expect((await recover("mutated-terminal", { ...command, terminal: { ...final.terminal, generation: 99 } })).error).toMatch(/terminal evidence changed/);
    expect((await recover("wrong-diagnosis", { ...command, diagnosis: "provider_quota",
      proof: { ...proof, witness: { ...proof.witness, kind: "configured_route_observed", configured_max_output_tokens: 32000 } } })).error).toMatch(/no matching typed or recognized/);
    expect((await recover("stale-proof", { ...command, proof: { ...proof, id: "stale-proof", observed_at: Date.now() - 400_000 } })).error)
      .toMatch(/needs a fresh configured-model request/);
    // The refusals consumed nothing: the healthy grant still goes through afterwards.
    expect(await recover("valid-grant")).toMatchObject({ kind: "provider_recovery_granted" });
    // One-use proof: replaying the granted proof id refuses...
    expect((await recover("duplicate-grant")).error).toMatch(/already granted/);
    // ...and the diagnosed task is reservable again on the granted route.
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: id });
  });

  it("uses a fresh managed review prompt once for an exact-route retry", async () => {
    const project = "managed-review-recovery", g = await gateway(project, 7);
    const otherModels = Array.from({ length: 4 }, (_, i) => ({ ...g.capabilities, model: `test/different-${i}` }));
    const [otherModel] = otherModels;
    await g.cmd({ kind: "advertise", capabilities: { ...g.capabilities, alternatives: otherModels } });
    const failed = { kind: "failed", exit_code: null, stdout_tail: "",
      stderr_tail: "acp session/prompt failed: Internal error: No deployments available for selected model, Try again in 30 seconds. Passed model=test/small. pre-call-checks=False, cooldown_list=[]" };
    const completed = { kind: "completed", exit_code: 0, stdout_tail: "Checked the change", stderr_tail: "" };
    async function review() {
      const id = await task(project);
      expect((await post("update", { id, roles: ["review"] })).error).toBeUndefined();
      return id;
    }
    async function begin(id: string, model = g.capabilities.model, generation = 1) {
      const reservation = await reserve(g);
      if (reservation.kind !== "reserved" || reservation.task_id !== id) throw new Error(JSON.stringify(reservation));
      const attempt_id = `${id}-${generation}`, session = reservation.session;
      const result = await g.cmd({ kind: "begin", worker: g.auth.agent, action_budget_ms: 60_000,
        attempt_id, selection: { backend: "opencode", model, tier: "small" } }, undefined, id, session);
      expect(result.error).toBeUndefined();
      return { id, session, generation, attempt_id, result };
    }
    async function finalize(attempt: Awaited<ReturnType<typeof begin>>, outcome: object) {
      const { id, session, generation, attempt_id } = attempt;
      const stopped = { generation, attempt_id, writers: "process_group_empty", outcome };
      expect((await g.cmd({ kind: "stopped", ...stopped }, undefined, id, session)).error).toBeUndefined();
      const finalize = { kind: "finalize", ...stopped }, commandId = `finish-${attempt_id}`;
      const result = await g.cmd(finalize, commandId, id, session);
      expect(result.error).toBeUndefined();
      expect(await g.cmd(finalize, commandId, id, session)).toEqual(result);
    }
    async function completeObservation(attempt: Awaited<ReturnType<typeof begin>>, observed?: number) {
      await finalize(attempt, { ...completed, acp_parent_prompt_observed_at: observed });
      expect((await post("update", { id: attempt.id, meta: { operator_gated: true } })).error).toBeUndefined();
    }
    async function observation(model: string, observe?: () => number) {
      const attempt = await begin(await review(), model);
      await completeObservation(attempt, observe?.());
    }
    const id = await review();
    await finalize(await begin(id), failed);
    await observation(g.capabilities.model); // An older runner provides only exit status.
    expect(await reserve(g)).toMatchObject({ kind: "no_eligible_work", reasons: { provider_route: 1 } });
    await observation(otherModel.model, Date.now);
    expect(await reserve(g)).toMatchObject({ kind: "no_eligible_work", reasons: { provider_route: 1 } });
    await observation(g.capabilities.model, () => Date.now() - 301_000);
    const beforeSourceBegan = Date.now();
    await observation(g.capabilities.model, () => beforeSourceBegan);
    const retagged = await begin(await task(project));
    expect((await post("update", { id: retagged.id, roles: ["review"] })).error).toBeUndefined();
    await completeObservation(retagged, Date.now());
    expect(await reserve(g)).toMatchObject({ kind: "no_eligible_work", reasons: { provider_route: 1 } });

    const legacyRunner = await begin(await review());
    await finalize(legacyRunner, { ...completed, acp_prompt_observed_at: Date.now() });
    expect((await post("update", { id: legacyRunner.id, meta: { operator_gated: true } })).error).toBeUndefined();
    expect(await reserve(g)).toMatchObject({ kind: "no_eligible_work", reasons: { provider_route: 1 } });

    const retaggedTarget = await begin(await task(project));
    await finalize(retaggedTarget, failed);
    expect((await post("update", { id: retaggedTarget.id, roles: ["review"] })).error).toBeUndefined();

    // Complete the exact review, then four newer reviews on different models
    // before the next reserve. Unrelated observations must never mask it.
    const exact = await begin(await review());
    const unrelated = [];
    for (const model of otherModels) unrelated.push(await begin(await review(), model.model));
    const exactObservedAt = Date.now();
    await observation(g.capabilities.model, Date.now);
    expect(await post("fixture/legacy-route-observation", { host: g.host })).toEqual({ ok: true });
    expect(await reserve(g)).toMatchObject({ kind: "no_eligible_work", reasons: { provider_route: 2 } });
    await completeObservation(exact, exactObservedAt);
    for (const attempt of unrelated) await completeObservation(attempt, Date.now());
    const retry = await begin(id, g.capabilities.model, 2);
    expect(retry.result).toMatchObject({ generation: 2, budget_exhaustions: 0, recovery_permit: {
      phase: "consumed", proof: { witness: { kind: "managed_review_prompt", project, tier: "small" } },
    } });
    await finalize(retry, failed);
    await observation(g.capabilities.model, Date.now);
    expect(await reserve(g)).toMatchObject({ kind: "no_eligible_work", reasons: { provider_route: 2 } });
  });

  it("learns from a fenced review verdict even when normal worker teardown interrupts ACP", async () => {
    const project = "managed-verdict-recovery", g = await gateway(project, 2);
    const failed = { kind: "failed", exit_code: null, stdout_tail: "",
      stderr_tail: "acp session/prompt failed: Internal error: No deployments available for selected model, Try again in 30 seconds. Passed model=test/small. pre-call-checks=False, cooldown_list=[]" };
    const interrupted = { kind: "interrupted", exit_code: null, stdout_tail: "Reviewed the change",
      stderr_tail: "acp interrupted — stop for a fresh attempt" };

    async function startReview() {
      const id = await task(project);
      expect((await post("update", { id, roles: ["review"] })).error).toBeUndefined();
      const reservation = await reserve(g);
      if (reservation.kind !== "reserved" || reservation.task_id !== id) throw new Error(JSON.stringify(reservation));
      const attempt_id = `${id}-attempt`, session = reservation.session;
      expect((await g.cmd({ kind: "begin", attempt_id, worker: g.auth.agent, action_budget_ms: 60_000 },
        undefined, id, session)).error).toBeUndefined();
      return { id, session, scope: { id, generation: 1, attempt_id } };
    }
    async function finalize(source: Awaited<ReturnType<typeof startReview>>, outcome: object) {
      const { id, session, scope: { generation, attempt_id } } = source;
      const stopped = { generation, attempt_id, writers: "process_group_empty", outcome };
      expect((await g.cmd({ kind: "stopped", ...stopped }, undefined, id, session)).error).toBeUndefined();
      const cmd = { kind: "finalize", ...stopped }, commandId = `${attempt_id}-finalize`;
      const receipt = await g.cmd(cmd, commandId, id, session);
      expect(receipt.error).toBeUndefined();
      expect(await g.cmd(cmd, commandId, id, session)).toEqual(receipt);
    }
    const target = await startReview();
    await finalize(target, failed);
    const sibling = await startReview();
    await finalize(sibling, failed);
    const reviewResult = { kind: "findings", summary: "Checked the exact review subject and found a fix to request." };
    const verdict = (source: Awaited<ReturnType<typeof startReview>>) => ({
      ...g.worker, id: source.id, session: source.session, to: "done",
      note: "Reviewed the submitted revision and recorded a finding.", review_result: reviewResult,
    });

    const unobserved = await startReview();
    expect((await post("transition", { ...verdict(unobserved), execution_scope: unobserved.scope })).error).toBeUndefined();
    // An older runner may retain a natural-prompt marker on interruption.
    // It did not attest teardown through the new no-work filter.
    await finalize(unobserved, { ...interrupted, acp_parent_prompt_observed_at: Date.now() });
    expect(await reserve(g)).toMatchObject({ kind: "no_eligible_work", reasons: { provider_route: 2 } });

    const noVerdict = await startReview();
    await finalize(noVerdict, { ...interrupted, acp_parent_teardown_observed_at: Date.now() });
    expect((await post("update", { id: noVerdict.id, meta: { operator_gated: true } })).error).toBeUndefined();
    expect(await reserve(g)).toMatchObject({ kind: "no_eligible_work", reasons: { provider_route: 2 } });

    const source = await startReview();
    const observedAt = Date.now();
    expect((await post("transition", { ...verdict(source), execution_scope: { ...source.scope, generation: 2 } })).error).toMatch(/execution mutation fenced/);
    expect(await reserve(g)).toMatchObject({ kind: "no_eligible_work", reasons: { provider_route: 2 } });
    expect((await post("transition", { ...verdict(source), execution_scope: source.scope })).error).toBeUndefined();
    await finalize(source, { ...interrupted, acp_parent_teardown_observed_at: observedAt });

    const resumed = await reserve(g);
    if (resumed.kind !== "reserved") throw new Error(JSON.stringify(resumed));
    expect(resumed.task_id).toBe(target.id);
    const begun = await g.cmd({ kind: "begin", attempt_id: "verdict-retry", worker: g.auth.agent, action_budget_ms: 60_000 },
      undefined, target.id, resumed.session);
    expect(begun).toMatchObject({ generation: 2, recovery_permit: {
      phase: "consumed", proof: { observed_at: observedAt,
        result: { response_receipt: `review-verdict:${source.id}:1:${source.scope.attempt_id}` } },
    } });
    expect(await reserve(g)).toMatchObject({ kind: "no_eligible_work", reasons: { provider_route: 1 } });
  });

  it("requires a witnessed request on a replacement route before reservation and begin", async () => {
    const project = "replacement-route", g = await gateway(project);
    const held = await task(project);
    const claim = await reserve(g);
    if (claim.kind !== "reserved") throw new Error(JSON.stringify(claim));
    const start = { kind: "begin", worker: g.auth.agent, action_budget_ms: 60_000 };
    expect((await g.cmd({ ...start, attempt_id: "failed-route" }, undefined, held, claim.session)).error).toBeUndefined();
    const outcome = { kind: "failed", exit_code: 1, stdout_tail: "",
      stderr_tail: "acp session/prompt failed: Internal error: No deployments available for selected model, Try again in 30 seconds. Passed model=test/small. pre-call-checks=False, cooldown_list=[]" };
    const failed = { generation: 1, attempt_id: "failed-route", writers: "process_group_empty", outcome };
    expect((await g.cmd({ kind: "stopped", ...failed }, undefined, held, claim.session)).error).toBeUndefined();
    const final = await g.cmd({ kind: "finalize", ...failed }, undefined, held, claim.session);
    expect(final.terminal).toBeDefined();
    const replacement = { ...g.capabilities, config_revision: "two" };
    expect(await g.cmd({ kind: "advertise", capabilities: replacement })).toMatchObject({ ok: true });
    expect(await reserve(g)).toMatchObject({ kind: "no_eligible_work", reasons: { provider_route: 1 } });

    const other = await task(project), otherClaim = await reserve(g);
    if (otherClaim.kind !== "reserved" || otherClaim.task_id !== other) throw new Error(JSON.stringify(otherClaim));
    expect((await g.cmd({ ...start, attempt_id: "unrelated" }, undefined, other, otherClaim.session)).error).toBeUndefined();
    const completed = { ...failed, attempt_id: "unrelated", outcome: { kind: "completed", exit_code: 0, stdout_tail: "", stderr_tail: "" } };
    expect((await g.cmd({ kind: "stopped", ...completed }, undefined, other, otherClaim.session)).error).toBeUndefined();
    expect((await g.cmd({ kind: "finalize", ...completed }, undefined, other, otherClaim.session)).error).toBeUndefined();
    expect((await post("transition", { id: other, to: "blocked", actor: "author", note: "Fixture wait",
      await_event: { event: "time", until_ts: Date.now() + 60_000 } })).error).toBeUndefined();
    expect(await reserve(g)).toMatchObject({ kind: "no_eligible_work", reasons: { provider_route: 1 } });

    const reviewer = await post("admin.mint", { label: "replacement-route-diagnostician", tags: [] });
    const auth = await post("auth.identify", { bearer: reviewer.secret });
    const configuration_receipt = "request-config:two", request_receipt = "response:two";
    const proof = { id: "witness-two", host: g.host, backend: replacement.backend, model: replacement.model, config_revision: "two",
      observed_at: Date.now(), request: { kind: "configured_model_request", max_output_tokens: 32000, tools: "none" },
      actual_model: "provider/small", result: { kind: "succeeded", response_receipt: request_receipt }, configuration_receipt,
      receipts: [request_receipt], witness: { kind: "configured_route_observed", configured_model: replacement.model,
        allowed_actual_models: ["provider/small"], configured_max_output_tokens: 32000, observed_max_output_tokens: 32000, configuration_receipt } };
    expect(await post("execution", { id: held, token_id: auth.token_id, actor: "replacement-route-diagnostician",
      session: "route-diagnosis", command_id: "grant-two", command: { kind: "recover_provider_failure", terminal: final.terminal, proof,
        diagnosis: "provider_route_unavailable", continuation: "Check retained work at the stopped attempt", evidence: [request_receipt] },
    })).toMatchObject({ kind: "provider_recovery_granted" });
    const resumed = await reserve(g);
    if (resumed.kind !== "reserved" || resumed.task_id !== held) throw new Error(JSON.stringify(resumed));
    expect(resumed.task?.meta.execution_recovery_selection).toMatchObject({ config_revision: "two" });
    expect(await g.cmd({ ...start, attempt_id: "witnessed" }, undefined, held, resumed.session)).toMatchObject({
      generation: 2, recovery_permit: { phase: "consumed" }, attempt: { phase: "running" },
    });
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

  it("reopens and claims a newly serviceable wait through one shared fleet pass per reserve", async () => {
    const project = "reserve-shared-pass", g = await gateway(project, 2);
    const id = await task(project, { execution_requirements: { tier: "small", tools: ["aws"], environment: [] } });
    expect((await post("get", { id })).status).toBe("blocked");
    // Capability renewal advertises without reconciling the backlog; the
    // reserve's own bounded duty must flip the wait and claim it.
    await g.cmd({ kind: "advertise", capabilities: { ...g.capabilities, tools: ["git", "aws"] } });
    expect((await post("get", { id })).status).toBe("blocked");
    const reserveFixture = async () => JSON.parse(await (await stub.fetch("https://kb/fixture/reserve-inventory", {
      method: "POST", body: JSON.stringify({ host: g.host }),
    })).text()) as { scans: number; readinessReads: number; policyReads: number; kind: string; task_id: string | null; reasons?: Record<string, number> };
    const base = await reserveFixture();
    expect(base).toMatchObject({ kind: "reserved", task_id: id });
    expect((await post("get", { id })).status).toBe("in_progress");
    // Grow the board by 100 rows of unrelated todo/blocked work: the reserve
    // pays the SAME bounded fleet passes. The counts decompose as the shared
    // reopen+selection pass, the claim fence's own blockers read and the
    // claim's per-task scheduling-requirements read — all small constants,
    // never a 25-card maintenance page per reserve.
    const extra: string[] = [];
    for (let i = 0; i < 60; i++) extra.push(await task(project, { execution_requirements: { tier: "small", tools: ["aws"], environment: [] } }));
    for (let i = 0; i < 40; i++) await task(project);
    await g.cmd({ kind: "advertise", capabilities: { ...g.capabilities, tools: ["git", "aws"] } });
    const scaled = await reserveFixture();
    expect(scaled).toMatchObject({ kind: "reserved", task_id: extra[0] });
    expect(scaled.scans).toBe(base.scans);
    expect(scaled.readinessReads).toBe(base.readinessReads);
    expect(scaled.policyReads).toBe(base.policyReads);
    expect(base.scans).toBeLessThanOrEqual(3);
    expect(base.readinessReads).toBeLessThanOrEqual(3);
    expect(base.policyReads).toBeLessThanOrEqual(3);
    expect((await post("get", { id: extra[0] })).status).toBe("in_progress");
  });

  it("advances the reopen cursor fairly across reserves and never flips an ask-owned wait", async () => {
    const project = "reopen-fairness", g = await gateway(project, 3);
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push(await task(project, { execution_requirements: { tier: "small", tools: ["aws"], environment: [] } }));
    // The held wait carries an open human decision: it occupies the reopen
    // page and advances the cursor, but no reserve may flip it.
    const held = ids[15];
    const ask = await post("create", { actor: "author", type: "question", title: "Resume the held repair despite the outstanding policy choice?",
      meta: { ask: { route: { kind: "human_decision" }, decision: {
        kind: "preference", task_id: held,
        context: "The held repair waits on a policy choice while the fleet gains the capability it needs.",
        why_human: "The operator owns the policy; the scheduler must not flip the wait implicitly.",
        choices: [
          { label: "Resume the repair", executor: "bridge", consequence: "The wait returns to the eligible queue.", action: "resume" },
          { label: "Hold the repair", executor: "bridge", consequence: "The card stays blocked on the human decision.", action: "hold" },
        ],
      } } } });
    expect(ask.error).toBeUndefined();
    await post("link", { src: ask.id, relation: "child_of", dst: held });
    await g.cmd({ kind: "advertise", capabilities: { ...g.capabilities, tools: ["git", "aws"] } });
    const claimed: string[] = [];
    for (let n = 0; n < 3; n++) {
      const outcome = SchedulingOutcomeSchema.parse(await g.cmd({ kind: "schedule", mode: "reserve" }));
      expect(outcome.kind).toBe("reserved");
      if (outcome.kind === "reserved") claimed.push(outcome.task_id);
    }
    expect(claimed).toEqual(ids.slice(0, 3));
    const states = await Promise.all(ids.map(id => post("get", { id })));
    expect(states.filter(t => t.status === "blocked").map(t => t.id)).toEqual([held]);
    expect(states.filter(t => t.status === "in_progress").map(t => t.id)).toEqual(ids.slice(0, 3));
    expect(states.filter(t => t.status === "todo").map(t => t.id)).toEqual(ids.slice(3).filter(id => id !== held));
    const heldState = await post("get", { id: held });
    expect(heldState.meta?.execution_wait).toMatchObject({ kind: "capability" });
  });

  it("pays the reopen duty for matching capability waits only, never a full maintenance page", async () => {
    const project = "reopen-cost", g = await gateway(project);
    for (let i = 0; i < 120; i++) await task(project, { operator_gated: "Unrelated maintenance hold" });
    // Probe 1 carries with_reserve:true so the fixture measures the reserve's
    // whole scheduling duty on the unrelated board; the flip-heavy probe 2
    // below stays reserve-free so the fixture's reserve segment cannot reopen
    // the tail it is meant to pin.
    let probe = await (await stub.fetch("https://kb/fixture/capability-cost", { method: "POST", body: JSON.stringify({ host: g.host, with_reserve: true }) })).json() as { sweepStatements: number; reopenStatements: number; reserveStatements: number };
    expect(probe.reopenStatements).toBeLessThanOrEqual(5);
    expect(probe.sweepStatements).toBeGreaterThanOrEqual(100);
    // The reserve's whole scheduling duty costs less than one maintenance
    // page walk over the same board — it never pays the 25-card sweep.
    expect(probe.reserveStatements).toBeGreaterThan(0);
    expect(probe.reserveStatements).toBeLessThan(probe.sweepStatements);
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push(await task(project, { execution_requirements: { tier: "small", tools: ["aws"], environment: [] } }));
    await g.cmd({ kind: "advertise", capabilities: { ...g.capabilities, tools: ["git", "aws"] } });
    probe = await (await stub.fetch("https://kb/fixture/capability-cost", { method: "POST", body: JSON.stringify({ host: g.host }) })).json() as { sweepStatements: number; reopenStatements: number; reserveStatements: number };
    // Flipping the matching page costs per-matching-row work, bounded by the
    // 25-row page — never the 120-row retained todo board behind it.
    expect(probe.reopenStatements).toBeGreaterThanOrEqual(25);
    expect(probe.reopenStatements).toBeLessThan(500);
    expect(probe.sweepStatements).toBeGreaterThanOrEqual(100);
    const states = await Promise.all(ids.map(id => post("get", { id })));
    expect(states.filter(t => t.status === "todo")).toHaveLength(25);
    expect(states.filter(t => t.status === "blocked")).toHaveLength(5);
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
  it("holds a todo card parked on durable external-CI checks (independent_wait) and wakes exactly one verifier when the bound checks settle (BR#18328)", async () => {
    const project = "external-ci-wait", g = await gateway(project, 2);
    const runnable = await task(project);
    const parked = await task(project, { execution_wait: { kind: "external_checks", await: { repo: "state-vector/superpositional", pr: 3644, head_sha: "3".repeat(40), contexts: ["ci / Build"] }, generation: 1, attempt_id: "one", declared_at: Date.now() } });
    // the parked card is held from dispatch without a worker slot or a blocked leg
    const discovery = SchedulingOutcomeSchema.parse(await g.cmd({ kind: "schedule", mode: "inspect" }));
    expect(discovery).toMatchObject({ kind: "ready", candidates: [runnable], reasons: { independent_wait: 1 } });
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: runnable });
    // the wake evaluator enqueues the head-bound probe; the executor feeds green at the bound head; the sweep clears the wait
    const key = `extchecks:state-vector/superpositional#3644@${"3".repeat(40)}`;
    expect((await post("admin.external_waits_sweep", {})).error ?? null).toBeNull();
    expect((await post("proxy.verify", { key, ok: true, receipt: "https://github.com/state-vector/superpositional/pull/3644", head_sha: "3".repeat(40), conclusion: "checks green", contexts: ["ci / Build=SUCCESS"] })).error ?? null).toBeNull();
    expect((await post("admin.external_waits_sweep", {})).error ?? null).toBeNull();
    expect((await post("get", { id: parked })).meta.execution_wait).toBeUndefined();
    expect((await post("get", { id: parked })).meta.execution_external_checks).toMatchObject({ outcome: "checks_green" });
    // the released card is the ONE fresh verifier generation the scheduler reserves
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: parked });
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
    expect((await g.cmd({ kind: "schedule_status", refresh: true, host: g.host })).hosts[0].occupancy.held).toBe(0);
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
    expect(card.meta.execution_requirements.host).toBeUndefined();
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: id });
    expect((await g.cmd(final, "old-final-not-replay", id, "wrong-session")).error).toMatch(/fenced|session/);
  });
  it("diagnoses a stranded repair and resumes it only after an attempt-bound receipt", async () => {
    const project = "stranded-repair", g = await gateway(project, 2);
    const id = await task(project, { machine_duty: { by: "recovery", kind: "task-recovery", subject: "BR#999", reason: "queue_binding" } });
    const claim = await reserve(g);
    if (claim.kind !== "reserved") throw new Error(JSON.stringify(claim));
    const fence = { generation: 1, attempt_id: "stranded" };
    await g.cmd({ kind: "begin", attempt_id: fence.attempt_id, worker: g.auth.agent, action_budget_ms: 60_000 }, "begin-stranded", id, claim.session);
    const operation_id = "publish";
    const input_revision = "old-head";
    await g.cmd({ kind: "prepare", ...fence, operation_id, input_revision, action: "Push exact ref", budget_ms: 60_000 }, "prepare-stranded", id, claim.session);
    const terminal = { ...fence, writers: "process_group_empty", outcome: { kind: "interrupted", exit_code: null, stdout_tail: "", stderr_tail: "runner stopped" } };
    await g.cmd({ kind: "stopped", ...terminal }, "stopped-stranded", id, claim.session);
    await g.cmd({ kind: "finalize", ...terminal }, "finalize-stranded", id, claim.session);
    const fixture = (path: string) => stub.fetch("https://kb/fixture/" + path, { method: "POST", body: JSON.stringify({ id }) });
    await fixture("watchdog-release");
    await fixture("attempt-diagnosis");
    const recovery = (await post("get", { id })).meta.execution_diagnosis;
    expect(recovery).toMatchObject({ generation: 1, hold: "unknown_operations" });
    expect((await post("get", { id: recovery.duty })).meta.machine_duty).toMatchObject({ subject: id, reason: "execution_environment" });
    await fixture("attempt-diagnosis");
    expect((await post("get", { id })).meta.execution_diagnosis).toEqual(recovery);

    const diagnostic = await reserve(g);
    if (diagnostic.kind !== "reserved") throw new Error(JSON.stringify(diagnostic));
    expect(diagnostic.task_id).toBe(recovery.duty);
    const receipt = { kind: "reconcile_operation", ...fence, operation_id, input_revision,
      outcome: "succeeded", receipts: ["GitHub ref readback at exact commit"] };
    const scope = { id: diagnostic.task_id, generation: 1, attempt_id: "diagnostic" };
    const reconcile = (command_id: string, command: object = receipt, execution_scope = scope) => post("execution", {
      ...g.worker, id, session: diagnostic.session, command_id, command, execution_scope,
    });
    expect((await reconcile("before-begin")).error).toMatch(/assigned diagnostic/);
    await g.cmd({ kind: "begin", attempt_id: "diagnostic", worker: g.auth.agent, action_budget_ms: 60_000 },
      "begin-diagnostic", diagnostic.task_id, diagnostic.session);
    expect((await g.cmd(receipt, "gateway-bypass", id, claim.session)).error).toMatch(/full-agent/);
    expect((await reconcile("wrong-scope", receipt, { ...scope, attempt_id: "old-diagnostic" })).error).toMatch(/assigned diagnostic/);
    expect((await reconcile("stale", { ...receipt, input_revision: "other-head" })).error).toMatch(/stale/);
    const result = await reconcile("confirmed");
    expect(result.operations).toMatchObject([{ id: operation_id, state: "succeeded" }]);
    expect(await reconcile("confirmed")).toEqual(result);
    const resumed = await reserve(g);
    if (resumed.kind !== "reserved") throw new Error(JSON.stringify(resumed));
    expect(resumed.task_id).toBe(id);
    expect(await g.cmd({ kind: "begin", attempt_id: "resumed-repair", worker: g.auth.agent, action_budget_ms: 60_000 },
      "begin-resumed", id, resumed.session)).toMatchObject({
      generation: 2, attempt: { phase: "running" }, operations: [{ id: operation_id, state: "succeeded" }],
    });
  });
  it("settles a satisfied typed-wait park's stopped-writer receipt and releases the wait exactly once (GH #478)", async () => {
    const project = "satisfied-wait-reconcile", g = await gateway(project, 2);
    // The prerequisite the parked subject awaits is already done on the board:
    // the typed wait is satisfied, but the prepared operation still fences
    // both the interactive pickup and the blocked→todo release (the deadlock).
    const prereq = await task(project);
    expect(await post("fixture/closed-diagnosis", { id: prereq })).toEqual({ ok: true });
    const fence = { generation: 1, attempt_id: "parked-writer" };
    const writerCycle = async (gw: typeof g, subject: string, operation_id: string, input_revision: string) => {
      const claim = await reserve(gw);
      if (claim.kind !== "reserved" || claim.task_id !== subject) throw new Error("expected reservation: " + JSON.stringify(claim));
      await gw.cmd({ kind: "begin", attempt_id: fence.attempt_id, worker: gw.auth.agent, action_budget_ms: 60_000 }, `begin-${subject}`, subject, claim.session);
      await gw.cmd({ kind: "prepare", ...fence, operation_id, input_revision, action: "Rerun the failed health leg", budget_ms: 60_000 }, `prepare-${subject}`, subject, claim.session);
      const terminal = { ...fence, writers: "process_group_empty", outcome: { kind: "timed_out", exit_code: null, stdout_tail: "", stderr_tail: "acp timed out (budget + grace exhausted)" } };
      await gw.cmd({ kind: "stopped", ...terminal }, `stopped-${subject}`, subject, claim.session);
      await gw.cmd({ kind: "finalize", ...terminal }, `finalize-${subject}`, subject, claim.session);
      expect(await post("fixture/watchdog-release", { id: subject })).toEqual({ ok: true });
    };
    const id = await task(project);
    await writerCycle(g, id, "publish", "old-head");
    expect((await post("transition", { id, to: "blocked", actor: "author", note: "Await the merged prerequisite fix",
      await_event: { event: "br_done", id: prereq } })).status).toBe("blocked");

    // Authorization is unchanged: only the assigned diagnostic or an
    // authenticated interactive (full-agent) session settles receipts.
    const fixer = await post("admin.mint", { label: "fixer", tags: [] });
    const fixerId = (await post("auth.identify", { bearer: fixer.secret })).token_id;
    const receipt = { kind: "reconcile_operation", ...fence, operation_id: "publish", input_revision: "old-head", outcome: "failed",
      receipts: ["https://github.com/state-vector/superpositional/actions/runs/44499480063/job/135513689306 — terminal failure at the exact head"] };
    const settle = (card: string, command_id: string, command: object = receipt) => post("execution",
      { actor: "fixer", token_id: fixerId, gateway: false, id: card, session: "fixer-interactive", command_id, command });
    expect((await post("execution", { ...g.worker, id, session: "worker-1", command_id: "worker-refused", command: receipt })).error).toMatch(/assigned diagnostic/);
    expect((await settle(id, "mismatched", { ...receipt, input_revision: "other-head" })).error).toMatch(/stale/);
    // The request contract itself refuses a conclusive settle with no receipts.
    expect((await settle(id, "no-receipts", { ...receipt, receipts: [] })).error).toMatch(/receipts/);

    // An unsatisfied typed wait is not settleable: the same writer shape parked
    // on a still-open prerequisite stays refused (separate project pool so the
    // reserve order stays deterministic).
    const sibling = "satisfied-wait-reconcile-unsat", g2 = await gateway(sibling);
    const unsat = await task(sibling);
    await writerCycle(g2, unsat, "publish-unsat", "old-head");
    const pending = await task(sibling); // an unsatisfied prerequisite (never closed)
    expect((await post("transition", { id: unsat, to: "blocked", actor: "author", note: "Await the still-open prerequisite",
      await_event: { event: "br_done", id: pending } })).status).toBe("blocked");
    expect((await settle(unsat, "unsatisfied-wait")).error).toMatch(/unassigned task/);

    // The settle itself: ledger-only, exact identity, conclusive receipts.
    const settled = await settle(id, "confirmed");
    expect(settled.operations).toMatchObject([{ id: "publish", state: "failed", receipts: [receipt.receipts[0]] }]);
    expect(await settle(id, "confirmed")).toEqual(settled); // stable-command replay
    expect((await settle(id, "confirmed", { ...receipt, outcome: "succeeded" })).error).toMatch(/reused with different input/);
    expect((await settle(id, "second-settle")).error).toMatch(/operation missing or already resolved/);
    expect((await g.cmd({ kind: "inspect" }, "inspected", id, "fixer-interactive")).operations)
      .toMatchObject([{ id: "publish", state: "failed", receipts: [receipt.receipts[0]] }]);
    // The typed wait is untouched by the settle — only the ordinary
    // continuation consumes it, exactly once.
    expect((await post("get", { id })).meta.blocked.await_event).toEqual({ event: "br_done", id: prereq });
    expect((await post("admin.unblock_proxy_sweep", { now: Date.now() })).ok).toBe(true);
    const released = await post("get", { id });
    expect(released.status).toBe("todo");
    expect(released.meta.blocked).toBeUndefined();
    expect(released.meta.proxy_check).toMatchObject({ verdict: "true" });
    expect(released.meta.provenance).toMatchObject({ kind: "system_auto_resume", via: "consumed_wait" });
    const resumed = await reserve(g);
    if (resumed.kind !== "reserved") throw new Error(JSON.stringify(resumed));
    expect(resumed.task_id).toBe(id);
    expect(await g.cmd({ kind: "begin", attempt_id: "resumed-after-wait", worker: g.auth.agent, action_budget_ms: 60_000 },
      "begin-resumed", id, resumed.session)).toMatchObject({
      generation: 2, attempt: { phase: "running" }, operations: [{ id: "publish", state: "failed" }],
    });
    // A later sweep pass finds nothing left to consume: the fired wait was
    // consumed exactly once and cannot fire again — the card is already
    // claimed (in_progress) with no park and no second consumption receipt.
    expect((await post("admin.unblock_proxy_sweep", { now: Date.now() + 20 * 60_000 })).ok).toBe(true);
    const after = await post("get", { id });
    expect(after.status).toBe("in_progress");
    expect(after.meta.blocked).toBeUndefined();
    expect(after.meta.provenance).toEqual(released.meta.provenance);

    // Owned parked cards stay refused — the owner check is not relaxed.
    const owned = await task(project);
    expect(await post("fixture/park-blocked", { id: owned, owner: g.auth.actor, await_event: { event: "br_done", id: prereq } })).toEqual({ ok: true });
    expect((await settle(owned, "owned-refused")).error).toMatch(/unassigned task/);
    // A live writer is not a stopped writer, even unowned and parked.
    const running = await task(project);
    const runningClaim = await reserve(g);
    if (runningClaim.kind !== "reserved" || runningClaim.task_id !== running) throw new Error(JSON.stringify(runningClaim));
    await g.cmd({ kind: "begin", attempt_id: fence.attempt_id, worker: g.auth.agent, action_budget_ms: 60_000 }, "begin-running", running, runningClaim.session);
    expect(await post("fixture/park-blocked", { id: running, await_event: { event: "br_done", id: prereq } })).toEqual({ ok: true });
    expect((await settle(running, "running-refused")).error).toMatch(/unassigned task/);
  });
  it("recovers a stranded diagnosis after the old cooldown without retrying the unchanged work", async () => {
    const project = "aged-diagnosis", g = await gateway(project);
    const id = await task(project);
    expect(await post("fixture/budget-pile", { ids: [id], age_ms: 3 * 86_400_000 })).toEqual({ ok: true, stamped: 1 });
    expect(await reserve(g)).toMatchObject({ kind: "no_eligible_work", reasons: { retry_budget: 1 } });
    await post("fixture/attempt-diagnosis", {});
    const original = (await post("get", { id })).meta.execution_diagnosis;
    expect(original).toMatchObject({ hold: "retry_budget" });
    // Import the historical failure mode: the old duty closed without an exit.
    expect(await post("fixture/closed-diagnosis", { id: original.duty })).toEqual({ ok: true });
    await post("fixture/attempt-diagnosis", {});
    const recovered = (await post("get", { id })).meta.execution_diagnosis;
    expect(recovered.duty).not.toBe(original.duty);
    await post("fixture/attempt-diagnosis", {});
    expect((await post("get", { id })).meta.execution_diagnosis).toEqual(recovered);

    const reservation = await reserve(g);
    if (reservation.kind !== "reserved" || reservation.task_id !== recovered.duty) throw new Error(JSON.stringify(reservation));
    const attempt_id = "diagnostic";
    expect((await g.cmd({ kind: "begin", attempt_id, worker: g.auth.agent, action_budget_ms: 60_000 },
      undefined, recovered.duty, reservation.session)).error).toBeUndefined();
    const submission = { ...g.worker, id: recovered.duty, to: "in_review", session: reservation.session,
      execution_scope: { id: recovered.duty, generation: 1, attempt_id },
      execution_result: { outcome: "Identified a persistent build prerequisite failure", receipts: ["retained-build-log"] } };
    expect((await post("transition", submission)).error).toMatch(/still needs a continuation/);

    const repair = await task(project);
    expect((await post("transition", { id, to: "blocked", actor: "author", note: "Repair the build prerequisite",
      await_event: { event: "br_done", id: repair } })).status).toBe("blocked");
    expect((await post("transition", submission)).status).toBe("in_review");
    expect((await post("get", { id })).meta.blocked.await_event).toEqual({ event: "br_done", id: repair });
  });
  it("lets a gateway-runner diagnostic exit through the board-side continuation its refusal names (BR#17881)", async () => {
    const project = "diagnosis-board-continuation", g = await gateway(project);
    const id = await task(project);
    expect(await post("fixture/budget-pile", { ids: [id] })).toEqual({ ok: true, stamped: 1 });
    await post("fixture/attempt-diagnosis", {});
    const original = (await post("get", { id })).meta.execution_diagnosis;
    expect(original).toMatchObject({ hold: "retry_budget" });
    const reservation = await reserve(g);
    if (reservation.kind !== "reserved" || reservation.task_id !== original.duty) throw new Error(JSON.stringify(reservation));
    const attempt_id = "diagnostic";
    expect((await g.cmd({ kind: "begin", attempt_id, worker: g.auth.agent, action_budget_ms: 60_000 },
      undefined, original.duty, reservation.session)).error).toBeUndefined();
    const submission = { ...g.worker, id: original.duty, to: "in_review", session: reservation.session,
      execution_scope: { id: original.duty, generation: 1, attempt_id },
      execution_result: { outcome: "Diagnosed the stranded attempt; continuation scope bound on the subject", receipts: ["availability-probe-series-001"] } };
    // Receipts alone are not a continuation: the single-host gateway holds its
    // only slot for this attempt, so the subject's dispatch gate is not clear
    // either — the refusal stands until a named exit exists.
    expect((await post("transition", submission)).error).toMatch(/still needs a continuation/);
    // The board-side binding such a duty CAN author: a decision bound to the
    // subject (the BR#17814 shape). The message names it; the gate must
    // honour it once the receipt-backed close rides the same submission.
    const decision = await post("create", { actor: "author", type: "decision",
      title: `Continuation scope for ${id}`, body_md: "Durable receipts stand; the fresh diagnostic re-verifies mechanically." });
    expect(decision.error).toBeUndefined();
    expect((await post("link", { src: decision.id, relation: "derived_from", dst: id, actor: "author" })).error).toBeUndefined();
    expect((await post("transition", submission)).status).toBe("in_review");
    expect((await post("get", { id: original.duty })).meta.execution_result).toMatchObject({ outcome: submission.execution_result.outcome });
  });
  it("accepts the honest diagnostic close once the subject's dispatch gate demonstrably clears (BR#17881)", async () => {
    const project = "diagnosis-dispatch-cleared", g = await gateway(project, 2);
    const id = await task(project);
    expect(await post("fixture/budget-pile", { ids: [id] })).toEqual({ ok: true, stamped: 1 });
    await post("fixture/attempt-diagnosis", {});
    const original = (await post("get", { id })).meta.execution_diagnosis;
    expect(original).toMatchObject({ hold: "retry_budget" });
    const reservation = await reserve(g);
    if (reservation.kind !== "reserved" || reservation.task_id !== original.duty) throw new Error(JSON.stringify(reservation));
    const attempt_id = "diagnostic";
    expect((await g.cmd({ kind: "begin", attempt_id, worker: g.auth.agent, action_budget_ms: 60_000 },
      undefined, original.duty, reservation.session)).error).toBeUndefined();
    const submission = { ...g.worker, id: original.duty, to: "in_review", session: reservation.session,
      execution_scope: { id: original.duty, generation: 1, attempt_id } };
    // A bare close stays refused even with the gate cleared — the receipts
    // contract owns the evidence leg first, and the diagnosis gate still
    // requires the receipt-backed result on the exit itself.
    expect((await post("transition", submission)).error).toMatch(/requires execution_result/);
    // Subject is todo, unowned, and the spare host slot keeps its live
    // dispatch blockers empty: the receipt-backed close is itself the
    // admissible continuation, the scheduler's next reservation owning the retry.
    const cleared = { ...submission, execution_result: { outcome: "Subject dispatch gate cleared (capacity free); the scheduler owns the next reservation", receipts: ["availability-probe-series-001", "availability-probe-series-002"] } };
    expect((await post("transition", cleared)).status).toBe("in_review");
    expect((await post("get", { id })).meta.execution_diagnosis?.duty).toBe(original.duty);
  });
  it("stamps an accepted recovery diagnosis into the durable record: no re-arm, the scheduler owns the retry (BR#18198)", async () => {
    const project = "diagnosis-stamp", g = await gateway(project, 2);
    const id = await task(project);
    // A real stopped attempt: begin, stop, finalize — the BR#17785 shape.
    const first = await reserve(g);
    if (first.kind !== "reserved" || first.task_id !== id) throw new Error(JSON.stringify(first));
    const fence = { generation: 1, attempt_id: "subject-attempt" };
    await g.cmd({ kind: "begin", attempt_id: fence.attempt_id, worker: g.auth.agent, action_budget_ms: 60_000 }, "begin-subject", id, first.session);
    const stopped = { ...fence, writers: "process_group_empty", outcome: { kind: "failed", exit_code: 1, stdout_tail: "", stderr_tail: "writer stopped" } };
    await g.cmd({ kind: "stopped", ...stopped }, "stopped-subject", id, first.session);
    await g.cmd({ kind: "finalize", ...stopped }, "finalize-subject", id, first.session);
    await post("fixture/watchdog-release", { id });
    // Budget exhausted on the SAME stopped attempt (the fixture preserves it).
    expect(await post("fixture/budget-pile", { ids: [id] })).toEqual({ ok: true, stamped: 1 });
    await post("fixture/attempt-diagnosis", {});
    const original = (await post("get", { id })).meta.execution_diagnosis;
    expect(original).toMatchObject({ generation: 1, hold: "retry_budget" });
    const reservation = await reserve(g);
    if (reservation.kind !== "reserved" || reservation.task_id !== original.duty) throw new Error(JSON.stringify(reservation));
    expect((await g.cmd({ kind: "begin", attempt_id: "diagnostic", worker: g.auth.agent, action_budget_ms: 60_000 },
      undefined, original.duty, reservation.session)).error).toBeUndefined();
    // The receipt-backed close exits through the dispatch-gate exit (BR#17881),
    // then an independent reviewer accepts the execution — the done write.
    const submission = { ...g.worker, id: original.duty, to: "in_review", session: reservation.session,
      execution_scope: { id: original.duty, generation: 1, attempt_id: "diagnostic" },
      execution_result: { outcome: "Environment verified usable; the scheduler owns the next reservation", receipts: ["availability-probe-series-001", "availability-probe-series-002"] } };
    const submitted = await post("transition", submission);
    expect(submitted.status).toBe("in_review");
    const terminal = { generation: 1, attempt_id: "diagnostic", writers: "process_group_empty", outcome: { kind: "completed", exit_code: 0, stdout_tail: "diagnosis submitted", stderr_tail: "" } };
    await g.cmd({ kind: "stopped", ...terminal }, "stopped-diagnostic", original.duty, reservation.session);
    await g.cmd({ kind: "finalize", ...terminal }, "finalize-diagnostic", original.duty, reservation.session);
    const verify = String(submitted.verify_task);
    const reviewClaim = await post("transition", { id: verify, to: "in_progress", actor: "diagnosis-reviewer", session: "diagnosis-reviewer" });
    expect((await post("transition", { id: verify, to: "done", actor: "diagnosis-reviewer", session: "diagnosis-reviewer", review_result: {
      kind: "accepted_execution", task_id: original.duty, subject_revision: reviewClaim.review_subject.revision,
      receipts: ["Verified the availability probes recorded on the duty card"] } })).error).toBeUndefined();
    // The stamp: the subject's durable execution record carries the accepted
    // reconciliation, visible to the sweep.
    const probe = await post("execution", { ...g.worker, id, command_id: "inspect-stamp-0001", command: { kind: "inspect" } });
    expect(probe.attempt_diagnosis).toMatchObject({ generation: 1, attempt_id: fence.attempt_id, hold: "retry_budget", duty: original.duty });
    expect(probe.recovery_permit).toBeNull();
    // No session can self-stamp: the wire refuses the hub-authoritative kind.
    expect((await post("execution", { ...g.worker, id, session: "attacker-session", command_id: "self-stamp-refused",
      command: { kind: "diagnosis_accepted", generation: 1, attempt_id: fence.attempt_id, hold: "retry_budget", duty: original.duty, accepted_by: "attacker" } })).error)
      .toMatch(/hub-authoritative/);
    // The next sweep tick re-reads the SAME stopped attempt and must NOT
    // re-arm: no new duty, the hold is not re-keyed.
    await post("fixture/attempt-diagnosis", {});
    const after = (await post("get", { id })).meta;
    expect(after.execution_diagnosis).toEqual(original);
    expect(after.recovery.task_id).toBe(original.duty);
    // The scheduler wins the race it always lost: the subject is reserved
    // within the tick and a fresh generation begins with no permit.
    const resumed = await reserve(g);
    expect(resumed).toMatchObject({ kind: "reserved", task_id: id });
    expect(await g.cmd({ kind: "begin", attempt_id: "fresh-generation", worker: g.auth.agent, action_budget_ms: 60_000 },
      "begin-resumed", id, (resumed as { session: string }).session)).toMatchObject({
      generation: 2, attempt: { phase: "running" }, recovery_permit: null, attempt_diagnosis: { duty: original.duty },
    });
  });
  it("routes stopped attempts to diagnosis by the dispatch priority law, not age alone (BR#17649)", async () => {
    const project = "diagnosis-order", g = await gateway(project);
    const ordinary = await task(project);
    // A concrete repair duty that itself stopped: rank 0, despite being the
    // youngest candidate here.
    const repair = await task(project, { machine_duty: { kind: "task-recovery", reason: "head_checks" } });
    const boosted = await task(project, { boosted: Date.now() });
    expect(await post("fixture/budget-pile", { ids: [ordinary, repair, boosted] })).toEqual({ ok: true, stamped: 3 });
    await post("fixture/attempt-diagnosis", {});
    const duty = async (id: string) => String((await post("get", { id })).meta.execution_diagnosis.duty);
    // Diagnosis duties are created in the shared law's order: line-repair
    // class first, then the explicit boost, then the oldest ordinary work.
    const serial = (dutyId: string) => Number(dutyId.slice(3));
    expect(serial(await duty(repair))).toBeLessThan(serial(await duty(boosted)));
    expect(serial(await duty(boosted))).toBeLessThan(serial(await duty(ordinary)));
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: await duty(repair) });
  });
  it("bounds diagnosis bypasses: continuously eligible stopped work is diagnosed within the tested bound (BR#17649)", async () => {
    const project = "diagnosis-bound", g = await gateway(project);
    const ordinary = await task(project);
    expect(await post("fixture/budget-pile", { ids: [ordinary] })).toEqual({ ok: true, stamped: 1 });
    // Each sweep tick diagnoses at most four candidates; a sustained stream of
    // boosted stopped attempts keeps consuming that capacity — until the bound.
    for (let i = 0; i < 10; i++) {
      const batch = [];
      for (let j = 0; j < 4; j++) batch.push(await task(project, { boosted: Date.now() + i * 4 + j }));
      expect(await post("fixture/budget-pile", { ids: batch })).toEqual({ ok: true, stamped: 4 });
      await post("fixture/attempt-diagnosis", {});
      expect((await post("get", { id: ordinary })).meta.execution_diagnosis).toBeUndefined();
    }
    // The tested bound: the next sweep tick is the ordinary work's turn.
    await post("fixture/attempt-diagnosis", {});
    expect((await post("get", { id: ordinary })).meta.execution_diagnosis).toBeDefined();
  });
  it("rejects a well-typed completion wait when its target is missing or would close a cycle", async () => {
    const [first, second, third] = [await task("waits"), await task("waits"), await task("waits")];
    const park = (id: string, target: string) => post("transition", { id, to: "blocked", actor: "author", note: "Upstream repair",
      await_event: { event: "br_done", id: target } });
    expect((await park(first, "BR#999999")).error).toMatch(/not found/);
    expect((await park(first, second)).status).toBe("blocked");
    expect((await park(second, third)).status).toBe("blocked");
    expect((await park(third, first)).error).toMatch(/completion dependency cycle/);
    expect((await post("get", { id: third })).status).toBe("todo");
  });
  it("releases physical capacity but preserves unknown operations and independent waits on terminal capture", async () => {
    const project = "terminal-unknown-effects", g = await gateway(project), peer = await gateway(project);
    const id = await task(project), claim = await reserve(g);
    if (claim.kind !== "reserved") throw new Error("no reservation");
    await g.cmd({ kind: "begin", attempt_id: "unknown-one", worker: g.auth.agent, action_budget_ms: 60_000 }, "unknown-begin", id, claim.session);
    await g.cmd({ kind: "prepare", generation: 1, attempt_id: "unknown-one", operation_id: "publish", action: "Push exact ref", input_revision: "a", budget_ms: 60_000 }, "unknown-prepare", id, claim.session);
    await g.cmd({ kind: "prepare", generation: 1, attempt_id: "unknown-one", operation_id: "deploy", action: "Start exact deployment", input_revision: "a", budget_ms: 60_000 }, "unknown-prepare-deploy", id, claim.session);
    const command = { kind: "finalize", generation: 1, attempt_id: "unknown-one", writers: "process_group_empty",
      outcome: { kind: "interrupted", exit_code: null, stdout_tail: "", stderr_tail: "network lost; preserve all work" } };
    expect((await g.cmd({ ...command, kind: "stopped" }, "unknown-stopped", id, claim.session)).error).toBeUndefined();
    expect((await g.cmd({ kind: "checkpoint", generation: 1, attempt_id: "unknown-one", checkpoint: publishedCheckpoint },
      "unknown-checkpoint", id, claim.session)).error).toBeUndefined();
    const final = await g.cmd(command, "unknown-final", id, claim.session);
    expect(final.operations).toMatchObject([{ id: "publish", state: "prepared" }, { id: "deploy", state: "prepared" }]);
    expect((await post("get", { id })).status).toBe("in_progress");
    const status = await g.cmd({ kind: "schedule_status", refresh: true, host: g.host });
    expect(status.hosts[0].occupancy.held).toBe(0);
    expect((await g.cmd({ kind: "begin", attempt_id: "unsafe-retry", worker: g.auth.agent, action_budget_ms: 60_000 }, "unknown-retry", id, claim.session)).error).toMatch(/unknown external operations/);
    const result = { kind: "result", generation: 1, attempt_id: "unknown-one", operation_id: "publish",
      outcome: "succeeded", receipts: ["GitHub ref readback at exact commit"] };
    expect((await peer.cmd(result, "foreign-operation", id, claim.session)).error).toMatch(/authority/);
    expect((await g.cmd({ ...result, receipts: [] }, "empty-operation", id, claim.session)).error).toMatch(/requires receipts/);
    expect((await g.cmd(result, "wrong-session-operation", id, "different-session")).error).toMatch(/fenced/);
    expect(await g.cmd(result, "record-push", id, claim.session)).toMatchObject({ task_status: "in_progress" });
    expect((await post("get", { id })).status).toBe("in_progress");
    const last = { ...result, operation_id: "deploy", outcome: "failed", receipts: ["Deployment API confirmed no deployment was created"] };
    const reconciled = await g.cmd(last, "record-deploy", id, claim.session);
    expect(reconciled).toMatchObject({ task_status: "todo", terminal: final.terminal,
      operations: [{ id: "publish", state: "succeeded" }, { id: "deploy", state: "failed" }] });
    const recovered = await reserve(peer);
    if (recovered.kind !== "reserved") throw new Error(JSON.stringify(recovered));
    expect(recovered.task_id).toBe(id);
    const next = await peer.cmd({ kind: "begin", attempt_id: "next-host", worker: peer.auth.agent, action_budget_ms: 60_000 },
      "other-host-begin", id, recovered.session);
    expect(next).toMatchObject({ generation: 2, attempt: { host: peer.host, phase: "running", checkpoint: null } });
    expect(await g.cmd(last, "record-deploy", id, claim.session)).toEqual(reconciled);
    expect((await g.cmd(last, "new-old-host-command", id, claim.session)).error).toMatch(/authority/);
    expect((await g.cmd({ ...last, outcome: "succeeded" }, "record-deploy", id, claim.session)).error).toMatch(/reused/);
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
  it("backs off a begin that raced a gateway cooldown and releases its task after fresh readiness", async () => {
    const project = "begin-readiness-race", g = await gateway(project);
    const id = await task(project), reservation = await reserve(g);
    if (reservation.kind !== "reserved") throw new Error("no reservation");
    await g.cmd({ kind: "gateway_failure", reason: "advertise timeout", cooldown_ms: 10_000 });
    const begin = await g.cmd({ kind: "begin", attempt_id: "readiness-race", worker: g.capabilities.worker.label,
      action_budget_ms: 60_000 }, "begin-race", id, reservation.session);
    expect(begin.error).toContain("gateway admission changed before begin");
    const failed = await g.cmd({ kind: "start_failed", stage: "begin", reason: begin.error, retained_work: false,
      failure_class: "prerequisite" }, "begin-race-failed", id, reservation.session);
    expect(failed).toMatchObject({ kind: "released", barrier: { kind: "cooldown", failures: 1 } });
    await post("admin.startup_sweep", { now: failed.barrier.until_ts + 1 });
    expect((await post("get", { id })).meta.startup_wait).toBeUndefined();
  });
  it("keeps a gateway upgrade hold when beginning on an alternative model", async () => {
    const project = "alternative-upgrade-hold", g = await gateway(project);
    const id = await task(project), reservation = await reserve(g);
    if (reservation.kind !== "reserved") throw new Error("no reservation");
    const alternate = { ...g.capabilities, model: "test/alternate" };
    const reason = "Managed gateway upgrade";
    const advertised = await g.cmd({ kind: "advertise", capabilities: { ...g.capabilities, alternatives: [alternate],
      admission_hold: { kind: "update_handoff", reason } } });
    expect(advertised.readiness).toMatchObject({ kind: "updating" });
    const begin = await g.cmd({ kind: "begin", attempt_id: "upgrade-race", worker: g.capabilities.worker.label,
      selection: { backend: alternate.backend, model: alternate.model, tier: alternate.tier },
      action_budget_ms: 60_000 }, "begin-alternate", id, reservation.session);
    expect(begin.error).toContain("gateway admission changed before begin");
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
    let status = await g.cmd({ kind: "schedule_status", refresh: true, host: g.host });
    expect(status.hosts[0].occupancy).toMatchObject({ leased: 0, starting: 1, unconfirmed: 0, held: 1 });
    const begun = await g.cmd({ kind: "begin", attempt_id: "retained-writer", worker: g.auth.agent, action_budget_ms: 60_000 }, "begin-retained", id, r.session);
    expect(begun.error).toBeUndefined();
    status = await g.cmd({ kind: "schedule_status", refresh: true, host: g.host });
    expect(status.hosts[0].occupancy).toMatchObject({ leased: 1, starting: 0, unconfirmed: 0, held: 1 });
    expect((await post("transition", { id, to: "todo", actor: "system:test", note: "Card released, but no stopped-process evidence exists" })).error).toBeUndefined();
    const released = await g.cmd({ kind: "inspect" }, "released-writer-inspect", id, r.session);
    expect(released).toMatchObject({ attempt: { phase: "stopping" }, revision: begun.revision + 1, messages: [] });
    const fenced = await g.cmd({ kind: "poll", generation: 1, attempt_id: "retained-writer" }, "released-writer-poll", id, r.session);
    expect(fenced.attempt.phase).toBe("stopping");
    status = await g.cmd({ kind: "schedule_status", refresh: true, host: g.host });
    expect(status.hosts[0]).toMatchObject({ active: 1, reserved: 0, occupancy: { leased: 0, starting: 0, unconfirmed: 1, held: 1,
      slots: [{ kind: "unconfirmed", task_id: id, generation: 1, attempt_id: "retained-writer", session: r.session, reason: "claim_changed", task_status: "todo" }] } });
    expect(await reserve(g)).toMatchObject({ kind: "at_capacity", active: 1 });
    const stop = { kind: "quiesce", generation: 1, attempt_id: "retained-writer", writers: "process_group_empty" };
    expect((await peer.cmd(stop, "foreign-stop", id, r.session)).error).toMatch(/authority|host/);
    expect((await g.cmd(stop, "confirmed-stop", id, r.session)).error).toBeUndefined();
    status = await g.cmd({ kind: "schedule_status", refresh: true, host: g.host });
    expect(status.hosts[0].occupancy).toMatchObject({ leased: 0, unconfirmed: 0, starting: 0, held: 0 });
    // Consume the released fixture so later global eligibility censuses do not
    // inherit its deliberately retained host affinity.
    expect((await post("transition", { ...g.auth, id, to: "in_progress" })).error).toBeUndefined();
  });
  it("never converts expired deadlines into stopped-writer proof during scheduling maintenance", async () => {
    const g = await gateway("expired-stopping"), id = await task("expired-stopping"), r = await reserve(g);
    if (r.kind !== "reserved") throw new Error("no reservation");
    await g.cmd({ kind: "begin", attempt_id: "needs-proof", worker: g.auth.agent, action_budget_ms: 60_000 }, "begin", id, r.session);
    const expired = await stub.fetch("https://fixture/fixture/expired-stopping", { method: "POST", body: JSON.stringify({ id }) });
    expect(await expired.json()).toMatchObject({ attempt: { phase: "stopping", lease_until: 1, action_deadline: 1 } });
    const status = await g.cmd({ kind: "schedule_status", refresh: true, host: g.host });
    expect(status.hosts[0].active).toBe(1);
    expect((await reserve(g)).kind).toBe("at_capacity");
  });
  it("BR#14703: a starved scheduler re-fires one throttled class alarm and stats carries starved_1h plus held-by-reason", async () => {
    const project = "starve-1h", g = await gateway(project, 2);
    // Eligible work with free capacity and no reserve poll: the work-starved
    // shape. Two tasks keep eligible > 0 across both health ticks.
    await task(project);
    await task(project);
    const health = async (options: object) => (await stub.fetch("https://fixture/fixture/scheduling-health", { method: "POST", body: JSON.stringify(options) })).json() as Promise<{ alarms: { action: string; data: Record<string, unknown> }[] }>;
    const first = await health({ age_s: 7200 });
    expect(first.alarms).toHaveLength(1);
    expect(first.alarms[0]).toMatchObject({ action: "dispatch_starved" });
    expect(String(first.alarms[0].data.host)).toBe(g.host);
    // One class alarm per 30m window: an immediate re-tick is silent.
    expect((await health({})).alarms).toHaveLength(0);
    // Past the throttle window the alarm re-fires for the still-starved host.
    const refire = await health({ backdate_attention_s: 1801 });
    expect(refire.alarms).toHaveLength(1);
    expect(refire.alarms[0]).toMatchObject({ action: "dispatch_starved" });
    const stats = await post("stats", {});
    expect(stats.starved_1h).toBe(2);
    const scheduler = stats.scheduler as { host: string; starved_since: number; eligible: number; held: Record<string, number> }[];
    expect(scheduler?.[0]).toMatchObject({ host: g.host, eligible: 2 });
    expect(scheduler?.[0].starved_since).toBeLessThanOrEqual(Date.now() - 120_000);
    // A healthy re-check clears the counter's source: alarms age out of the
    // trailing hour only — here the counter still reflects the live storm.
    expect((await health({})).alarms).toHaveLength(0);
    expect((await post("stats", {})).starved_1h).toBe(2);
  });
  it("BR#14703: a retry-budget pile over 30 raises one throttled class alarm and stats carries held-by-reason", async () => {
    const project = "budget-pile", g = await gateway(project);
    const ids: string[] = [];
    for (let i = 0; i < 31; i++) ids.push(await task(project));
    expect(await post("fixture/budget-pile", { ids })).toMatchObject({ ok: true, stamped: 31 });
    const health = async (options: object) => (await stub.fetch("https://fixture/fixture/scheduling-health", { method: "POST", body: JSON.stringify(options) })).json() as Promise<{ alarms: { action: string; data: Record<string, unknown> }[] }>;
    const first = await health({});
    const pile = first.alarms.filter(alarm => alarm.action === "retry_budget_pile");
    expect(pile).toHaveLength(1);
    expect(Number(pile[0].data.pile)).toBeGreaterThanOrEqual(31);
    expect(Number(pile[0].data.threshold)).toBe(30);
    // One class alarm per 30m window while the storm persists.
    expect((await health({})).alarms.filter(alarm => alarm.action === "retry_budget_pile")).toHaveLength(0);
    const stats = await post("stats", {});
    const scheduler = stats.scheduler as { held: Record<string, number> }[];
    expect((scheduler?.[0].held.retry_budget ?? 0)).toBeGreaterThanOrEqual(31);
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
    const status = await ec2.cmd({ kind: "schedule_status", refresh: true, host: ec2.host });
    expect(status.hosts).toHaveLength(1);
    expect(status.hosts[0]).toMatchObject({ host: ec2.host, capacity: 12, active: 0, reserved: 1, eligible: 0, last_dispatch: { kind: "reserved", task_id: runnable } });
  });
  it.each(["boost", "unrelated recovery"])("gives ordinary work its turn under sustained %s while protecting the running line repair (BR#17649)", async (contender) => {
    const project = `bounded-bypass-${contender}`, repo = `state-vector/br17649-${contender === "boost" ? "boost" : "repair"}`;
    const actor = "gw-bounded-bypass", red = "e".repeat(40);
    expect((await post("train.lease", { repo, actor, action: "acquire", required_workflows: ["Deploy Dev"] })).error).toBeUndefined();
    const g = await gateway(project, 2);
    const ordinary = await task(project);
    const release = async (r: { kind: string; task_id?: string; session?: string }) => {
      if (r.kind !== "reserved" || !r.task_id) throw new Error(JSON.stringify(r));
      expect(await g.cmd({ kind: "cancel_start", writers: "not_launched", retained_work: true }, undefined, r.task_id, r.session)).toMatchObject({ kind: "released" });
    };
    // A sustained stream of boosted work: every compatible opportunity takes
    // boosted work while the continuously eligible ordinary task loses one
    // bypass tick — never more than the tested bound.
    for (let i = 0; i < 10; i++) {
      await task(project, contender === "boost" ? { boosted: Date.now() + i } : { machine_duty: { kind: "task-recovery", reason: "head_checks" } });
      const bypassed = await reserve(g, `br17649-bypass-${i}`);
      if (bypassed.kind !== "reserved" || bypassed.task_id === ordinary) throw new Error(`expected a priority bypass, got ${JSON.stringify(bypassed)}`);
      if (i === 0) {
        expect(await reserve(g, "br17649-bypass-0")).toEqual(bypassed);
        expect(await post("fixture/bypass-budget", { id: ordinary })).toEqual({ bypasses: 1 });
      }
      await release(bypassed);
    }
    // Protected line recovery still outranks a starved task's pending turn,
    // and bypassing around it spends none of the ordinary task's budget.
    // Bind a real current episode and exercise a different phase in each run.
    const repair = await post("create", { type: "task", title: "Repair current main", project, qualified: true, tags: ["root_blocker", "main-red"],
      meta: { root_fix: { repo, base: "main", head_sha: red } } });
    const runUrl = `https://github.com/${repo}/actions/runs/1`;
    expect((await post("train.observe_deploy", { repo, actor, observation: { tip_sha: red, observed_at: Date.now(),
      runs: [{ id: 1, name: "Deploy Dev", head_sha: red, run_attempt: 1, status: "completed", conclusion: "failure", html_url: runUrl }],
      failures: [{ run_id: 1, name: "Deploy Dev", url: `${runUrl}/job/1`, repair_task_id: repair.id }] } })).error).toBeUndefined();
    expect((await post("train.queue_facts", { repo, actor, entries: [], base_state: { verdict: "red", tip_sha: red, red: [{ name: "Deploy Dev", url: runUrl }] } })).error).toBeUndefined();
    let protectedId: string;
    if (contender === "boost") {
      protectedId = await task(project);
      expect((await post("transition", { id: repair.id, actor: "author", to: "blocked", note: "Line repair waits for the concrete prerequisite", await_event: { event: "br_done", id: protectedId } })).error).toBeUndefined();
    } else {
      const claim = { id: repair.id, actor: "author", session: "fixture-line-repair" };
      expect((await post("transition", { ...claim, to: "in_progress" })).error).toBeUndefined();
      const submitted = await post("transition", { ...claim, to: "in_review", note: `PR https://github.com/${repo}/pull/1` });
      expect(submitted.verify_task, JSON.stringify(submitted)).toBeTruthy();
      protectedId = submitted.verify_task;
    }
    expect(await post("fixture/bypass-budget", { id: ordinary })).toEqual({ bypasses: 10 });
    const preempted = await reserve(g);
    expect(preempted).toMatchObject({ kind: "reserved", task_id: protectedId });
    expect(await post("fixture/bypass-budget", { id: ordinary })).toEqual({ bypasses: 10 });
    // The tested bound: the next compatible opportunity is ordinary's turn.
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: ordinary });
    expect((await post("get", { id: ordinary })).status).toBe("in_progress");
  });
  it("counts only compatible bypass opportunities: a same-class queue tick and ineligible boosted work spend nothing (BR#17649)", async () => {
    const project = "compatible-only", mac = await gateway(project, 32), ec2 = await gateway(project, 12);
    const pinned = await task(project, { boosted: Date.now(), execution_requirements: { host: mac.host } });
    const olderOrdinary = await task(project);
    const waiter = await task(project);
    // mac's opportunity: the boosted pinned winner bypasses each compatible
    // ordinary waiter exactly once — one class bypass, one tick.
    expect(await reserve(mac)).toMatchObject({ kind: "reserved", task_id: pinned });
    expect(await post("fixture/bypass-budget", { id: waiter })).toEqual({ bypasses: 1 });
    // ec2's opportunity: the pinned boosted work is NOT eligible there, so it
    // bypasses nothing; the ordinary winner is a same-class queue tick, not a
    // bypass — the waiter's budget stays where it was.
    expect(await reserve(ec2)).toMatchObject({ kind: "reserved", task_id: olderOrdinary });
    expect(await post("fixture/bypass-budget", { id: waiter })).toEqual({ bypasses: 1 });
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
    expect((await g.cmd({ kind: "schedule_status", refresh: true, host: g.host })).hosts[0].reserved).toBe(1);
    await g.cmd({ kind: "start_failed", stage: "begin", reason: "transport temporary", retained_work: false, failure_class: "transport" }, "failure", id, replay.session);
    // Retry transport acknowledgement is idempotent; it cannot extend backoff.
    const failure = { kind: "gateway_failure", reason: "provider disconnected", cooldown_ms: 10_000 };
    expect(await g.cmd(failure, "provider-failure")).toEqual(await g.cmd(failure, "provider-failure"));
  });
});

describe("priority line recovery capacity", () => {
  it("dispatches the original implementation after current PR findings on an accepted recovery", async () => {
    const project = "review-to-repair", g = await gateway(project);
    const repo = "state-vector/review-to-repair", pr = 45;
    const parent = await task(project, { pr: { repo, number: pr, head_sha_at_acceptance: "a".repeat(40) },
      merge_train: { state: "bounced", repo, pr } });
    const report = (mergeable: string, mergeStateStatus: string) => post("reconcile.report", {
      repo, actor: "system:reconcile", prs: [{ number: pr, title: "PR recovery fixture", mergeable, mergeStateStatus,
        headRefOid: "b".repeat(40), updatedAt: new Date(Date.now() - 90 * 3_600_000).toISOString() }],
    });
    const transition = (id: string, to: string, actor: string, fields: object = {}) =>
      post("transition", { id, to, actor, session: actor, ...fields });
    const repair = (await report("CONFLICTING", "DIRTY")).spawned.find((x: { card: string }) => x.card === parent)?.duty;
    expect(repair).toBeTruthy();
    expect((await transition(repair, "in_progress", "repairer")).error).toBeUndefined();
    const submitted = await transition(repair, "in_review", "repairer", {
      execution_result: { outcome: "Restored mergeability", receipts: ["GitHub branch readback"] },
    });
    const repairClaim = await transition(submitted.verify_task, "in_progress", "repair-reviewer");
    expect((await transition(submitted.verify_task, "done", "repair-reviewer", { review_result: {
      kind: "accepted_execution", task_id: repair, subject_revision: repairClaim.review_subject.revision,
      receipts: ["Verified recovery evidence"],
    } })).error).toBeUndefined();
    const review = (await report("MERGEABLE", "UNSTABLE")).spawned.find((x: { action: string }) => x.action === "verify")?.duty;
    expect(review).toBeTruthy();
    expect((await post("get", { id: review })).project).toBe(project);
    expect((await g.cmd({ kind: "schedule_status", refresh: true, host: g.host })).hosts[0].held.independent_wait).toContain(parent);
    expect((await transition(review, "in_progress", "pr-reviewer")).error).toBeUndefined();
    expect((await transition(review, "done", "pr-reviewer", { review_result: {
      kind: "findings", summary: "The feature still needs a regression repair",
    } })).error).toBeUndefined();
    const next = await report("MERGEABLE", "UNSTABLE");
    expect(next.spawned).toEqual([]);
    expect(next.accounting.repairing).toBe(1);
    const claim = await reserve(g);
    expect(claim).toMatchObject({ kind: "reserved", task_id: parent, task: { meta: { merge_train: { state: "unbound" } } } });
    if (claim.kind !== "reserved") throw new Error("implementation was not reserved");
    expect(claim.task.body_md).toContain("The feature still needs a regression repair");
    expect((await post("get", { id: parent })).meta.recovery.task_id).toBe(repair);
  });

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
  it("keeps an unboosted repair's queue position through independent review", async () => {
    const project = "repair-review-fifo", g = await gateway(project, 3);
    const repair = await task(project, { machine_duty: { kind: "task-recovery", reason: "head_checks" } });
    const claim = await reserve(g);
    if (claim.kind !== "reserved" || claim.task_id !== repair) throw new Error("repair not reserved");
    const begin = await g.cmd({ kind: "begin", attempt_id: "fifo-repair", worker: g.auth.agent, action_budget_ms: 60_000 }, "fifo-begin", repair, claim.session);
    expect(begin.error).toBeUndefined();
    const later = await task(project, { machine_duty: { kind: "task-recovery", reason: "head_checks" } });
    const handoff = await post("transition", { ...g.worker, id: repair, session: claim.session,
      execution_scope: { id: repair, generation: 1, attempt_id: "fifo-repair" }, to: "in_review",
      note: "PR https://github.com/state-vector/bridge/pull/6998 — repair delivered, independent review required" });
    expect(handoff.error).toBeUndefined();
    const status = await g.cmd({ kind: "schedule_status", refresh: true, host: g.host });
    expect(status.hosts[0].candidates.slice(0, 2)).toEqual([handoff.verify_task, later]);
    const reviewClaim = await reserve(g);
    if (reviewClaim.kind !== "reserved") throw new Error("review not reserved");
    expect(reviewClaim.task_id).toBe(handoff.verify_task);
    const failed = await g.cmd({ kind: "cancel_start", writers: "not_launched", retained_work: true },
      "fifo-review-cancelled", handoff.verify_task, reviewClaim.session);
    expect(failed.kind).toBe("released");
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: later });
  });
  it.each(["registered", "caller-linked"] as const)("uses train priority only for a %s review", async (source) => {
    const project = "train-review-dispatch";
    const repo = "state-vector/bridge", pr = 6997, head = "b".repeat(40);
    const train = "train-review-gateway";
    expect((await post("train.lease", { repo, actor: train, action: "acquire", required_workflows: ["Test"] })).error).toBeUndefined();
    const g = await gateway(project, 3);
    const parent = await task(project, {
      pr: { repo, number: pr, head_sha_at_acceptance: head },
      merge_train: { state: "unbound", repo, pr, bounced_at: Date.now() },
    });
    expect((await post("train.event", { repo, actor: train, kind: "bounced", pr, task_id: parent,
      head_sha: head, bounce_kind: "gate", reason: "Candidate tests required a repair" })).error).toBeUndefined();
    expect((await post("transition", { id: parent, to: "in_progress", actor: "train-repairer", session: "train-repairer" })).error).toBeUndefined();
    const later = await task(project, { machine_duty: { kind: "task-recovery", reason: "head_checks" } });
    const linkUnrelated = async () => {
      const review = await post("create", { type: "task", title: "Standalone review", project, roles: ["review"], meta: { execution_review_of: parent } });
      expect((await post("link", { src: review.id, relation: "child_of", dst: parent })).error).toBeUndefined();
      return review.id;
    };
    const callerLinked = source === "caller-linked" ? await linkUnrelated() : null;
    const submitted = await post("transition", { id: parent, to: "in_review", actor: "train-repairer", session: "train-repairer",
      note: `PR https://github.com/${repo}/pull/${pr} — repaired at ${head}` });
    expect(submitted.error).toBeUndefined();
    expect(submitted.verify_task).toBeTruthy();
    if (callerLinked) {
      expect(submitted.verify_task).toBe(callerLinked);
      expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: later });
      return;
    }
    const unrelated = await linkUnrelated();
    const status = await g.cmd({ kind: "schedule_status", refresh: true, host: g.host });
    expect(status.hosts[0].candidates.slice(0, 3)).toEqual([submitted.verify_task, later, unrelated]);
    const review = await reserve(g);
    if (review.kind !== "reserved") throw new Error("train review was not reserved");
    expect(review.task_id).toBe(submitted.verify_task);
    expect((await g.cmd({ kind: "cancel_start", writers: "not_launched", retained_work: true },
      "train-review-cancelled", review.task_id, review.session)).kind).toBe("released");
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: later });
  });

  it("does not accept caller-assigned recovery review priority", async () => {
    const project = "repair-review-authority";
    const ordinary = await task(project);
    const machine_duty = { kind: "task-recovery", by: "recovery-review", subject: ordinary };
    expect((await post("create", { type: "task", title: "Forged recovery review", project, roles: ["review"], meta: { machine_duty } })).error)
      .toContain("recovery review priority is assigned by Bridge");
    expect((await post("update", { id: ordinary, meta: { machine_duty } })).error)
      .toContain("recovery review priority is assigned by Bridge");
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
  it("preempts exactly one verifier without a checkpoint, retains its slot until quiescence and dispatches recovery before the verifier resumes", async () => {
    const project = "repair-preemption", g = await gateway(project);
    const victim = await task(project); await post("update", { id: victim, roles: ["review"] });
    const r = await reserve(g); if (r.kind !== "reserved") throw new Error("no verification reservation");
    await g.cmd({ kind: "begin", attempt_id: "verification", worker: g.auth.agent, action_budget_ms: 60_000 }, "verify-begin", victim, r.session);
    const repair = await task(project, { machine_duty: { kind: "task-recovery", reason: "head_checks", subject: "candidate" } });
    expect((await g.cmd({ kind: "schedule", mode: "inspect" })).preemption).toBeUndefined();
    expect((await g.cmd({ kind: "inspect" }, "before-preempt", victim, r.session)).messages).toHaveLength(0);
    const responses = await Promise.all([g.cmd({ kind: "schedule", mode: "request_capacity" }, "full-runner-capacity"), reserve(g, "preempt-a"), reserve(g, "preempt-b")]);
    for (const result of responses) expect(result).toMatchObject({ kind: "at_capacity", active: 1, reserved: 0,
      preemption: { phase: "stopping_verification", recovery_id: repair, victim_id: victim, generation: 1, checkpoint_commit: null } });
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
    expect((await g.cmd({ kind: "inspect" }, "stopped-verifier", victim, r.session)).attempt.checkpoint).toBeNull();
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: repair });
    expect((await g.cmd({ kind: "schedule_status", refresh: true, host: g.host })).hosts[0]).toMatchObject({ active: 0, reserved: 1 });
  });
  it.each(["recovery-review", "pending-effect"])("does not interrupt protected verification: %s", async protection => {
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
    if (protection === "pending-effect") await g.cmd({ kind: "prepare", generation: 1, attempt_id: "protected", operation_id: "external", action: "publish", input_revision: "head", budget_ms: 60_000 }, "protected-effect", victim, r.session);
    await task(project, { machine_duty: { kind: "task-recovery", reason: "head_checks", subject: "candidate" } });
    expect((await reserve(g)).preemption).toBeUndefined();
    expect((await g.cmd({ kind: "inspect" }, "still-protected", victim, r.session)).messages).toHaveLength(0);
  });

  it("GH#455: a root-fix card preempts a running routine implementation at capacity, not just verification", async () => {
    const project = "root-fix-preemption", repo = "state-vector/root-preemption", actor = "gw-root-preemption", red = "d".repeat(40);
    expect((await post("train.lease", { repo, actor, action: "acquire", required_workflows: ["Test"] })).error).toBeUndefined();
    const g = await gateway(project);
    const victim = await task(project, { pr: { repo: "state-vector/bridge", number: 71, head_sha_at_acceptance: "c".repeat(40) } });
    const r = await reserve(g); if (r.kind !== "reserved") throw new Error("no routine reservation");
    await g.cmd({ kind: "begin", attempt_id: "routine", worker: g.auth.agent, action_budget_ms: 60_000 }, "routine-begin", victim, r.session);
    // a concrete task-recovery duty may not preempt routine implementation
    await task(project, { machine_duty: { kind: "task-recovery", reason: "head_checks", subject: "candidate" } });
    expect((await reserve(g, "recovery-keeps-review-scope")).preemption).toBeUndefined();
    // …but a root-fix card for a red main outranks every dispatchable work
    const rootFix = await post("create", {
      actor: "system:train", type: "task", project, qualified: true, roles: ["impl"],
      title: `ROOT-FIX (BR#5189 p0): fix main — ${repo} red at ${red.slice(0, 9)} (Test)`,
      body_md: "Main is RED — stop-the-line.",
      tags: ["root_blocker", "main-red", "p0"],
      meta: { root_fix: { repo, base: "main", head_sha: red, failing: ["Test"], lane: `${repo}@main` } },
    });
    expect(rootFix.error).toBeUndefined();
    expect((await post("train.queue_facts", { repo, actor, entries: [], base_state: { verdict: "red", tip_sha: red, red: [{ name: "Test" }] } })).error).toBeUndefined();
    const probe = await g.cmd({ kind: "schedule", mode: "request_capacity" }, "root-fix-capacity-probe");
    expect(probe).toMatchObject({ kind: "at_capacity", active: 1,
      preemption: { phase: "stopping_verification", recovery_id: rootFix.id, victim_id: victim, generation: 1, checkpoint_commit: null } });
    const stopped = await g.cmd({ kind: "poll", generation: 1, attempt_id: "routine" }, "routine-poll", victim, r.session);
    expect(stopped.attempt.phase).toBe("stopping");
    expect(stopped.messages).toHaveLength(1);
    const message = stopped.messages[0].id;
    await g.cmd({ kind: "ack", generation: 1, attempt_id: "routine", message_id: message, state: "acknowledged" }, "routine-ack", victim, r.session);
    await g.cmd({ kind: "ack", generation: 1, attempt_id: "routine", message_id: message, state: "acted" }, "routine-acted", victim, r.session);
    await g.cmd({ kind: "quiesce", generation: 1, attempt_id: "routine", writers: "process_group_empty" }, "routine-quiet", victim, r.session);
    await g.cmd({ kind: "yield", generation: 1, attempt_id: "routine" }, "routine-yield", victim, r.session);
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: rootFix.id });
  });

  it("GH#455: alarms an unclaimed root-fix resting in todo while a ready executor ticks, and throttles the repeat", async () => {
    const project = "root-fix-starve", g = await gateway(project);
    const rootFix = await post("create", {
      actor: "system:train", type: "task", project, qualified: true, roles: ["impl"],
      title: `ROOT-FIX (BR#5189 p0): fix main — state-vector/bridge red at ${"e".repeat(9)} (Test)`,
      tags: ["root_blocker", "main-red", "p0"],
      meta: { root_fix: { repo: "state-vector/bridge", base: "main", head_sha: "e".repeat(40), failing: ["Test"] } },
    });
    expect(rootFix.error).toBeUndefined();
    // young card: inside the dispatch grace — no alarm yet
    const young = await post("fixture/root-fix-starve", { id: rootFix.id, age_ms: 30_000 });
    expect(young.alarms).toEqual([]);
    // past the grace with a ready executor ticking: the invariant alarm fires
    const starved = await post("fixture/root-fix-starve", { id: rootFix.id, age_ms: 180_000 });
    expect(starved.alarms).toEqual([{ artefact_id: rootFix.id, action: "root_fix_dispatch_starved" }]);
    // throttle: the next sweep within 15m is silent, not a repeat
    const repeat = await post("fixture/root-fix-starve", { id: rootFix.id, age_ms: 300_000 });
    expect(repeat.alarms).toEqual([]);
  });

  it("GH#455: rebinding a root-fix clears a dead holder's stale host affinity so every ready executor can claim it", async () => {
    const project = "root-fix-rebind", repo = "state-vector/rebind", actor = "gw-rebind", head = "f".repeat(40);
    // the lease is taken BEFORE the gateway advertises — the lane card's
    // create-sweep must not see an executor inventory (fixture-order note,
    // not the subject of this test)
    expect((await post("train.lease", { repo, actor, action: "acquire", required_workflows: ["Test"] })).error).toBeUndefined();
    const g = await gateway(project);
    const stale = await post("create", {
      actor: "system:train", type: "task", project, qualified: true, roles: ["impl"],
      title: `ROOT-FIX (BR#5189 p0): fix main — ${repo} red at ${head.slice(0, 9)} (Test)`,
      tags: ["root_blocker", "main-red", "p0"],
      meta: {
        root_fix: { repo, base: "main", head_sha: head, failing: ["Test"] },
        // conservative affinity a dead holder left behind (an expired reservation)
        execution_requirements: { tier: "small", tools: ["git"], environment: [], host: "dead-holder-host" },
        dispatch_recovery: { kind: "reservation_expired", at: 1, host: "dead-holder-host" },
      },
    });
    expect(stale.error).toBeUndefined();
    // the stale pin does not merely filter eligibility — the capability sweep
    // parks the p0 card BLOCKED awaiting an executor_capability that will
    // never exist (the pinned host is dead)
    const parked = await post("get", { id: stale.id });
    expect(parked.status).toBe("blocked");
    expect(parked.meta.execution_wait).toMatchObject({ kind: "capability" });
    expect((await reserve(g)).kind).toBe("no_eligible_work");
    // a new red episode on the same head rebinds this exact card — the rebind
    // must clear the dead holder's dispatch pins (GH#455)
    const stopped = await post("train.event", {
      repo, actor, kind: "stopped", head_sha: head,
      failing: [{ name: "Test", url: "https://github.test/test" }], reason: "required workflows RED: Test",
    });
    expect(stopped.error).toBeUndefined();
    const card = await post("get", { id: stale.id });
    expect(card.meta.root_fix).toMatchObject({ repo, head_sha: head });
    expect(card.meta.execution_requirements).toBeUndefined();
    expect(card.meta.dispatch_recovery).toBeUndefined();
    // …and the card is claimable again: rank-0, first reserve wins it
    const claim = await reserve(g);
    expect(claim).toMatchObject({ kind: "reserved", task_id: stale.id });
  });
});
