import { Miniflare } from "miniflare";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executorRequest } from "./executor-fixture";

/**
 * BR#474 (state-vector/bridge#474) — a pre-queue independent-review bounce
 * (in_review → in_progress with findings, NO merge_train stamp anywhere) used
 * to strand the implementation card: the bounce landed on a managed writer
 * that was already PHYSICALLY STOPPED (quiesced attempt + runner terminal
 * writers proof, zero unresolved operations), and neither the ghost-bounce
 * dead-owner check (the owner token looked alive) nor the train-bounce repair
 * (keyed on merge_train.state=bounced AND no durable attempt) ever released
 * the claim — the BR-18119/BR-18105 shape that held the whole release lane.
 *
 * The law under test (all decided from the runner's OWN durable record,
 * never a timestamp or a lease):
 *  1. pre-queue  — stopped writer + findings bounce → atomically back to the
 *     managed pool (todo) in the same tick, PR binding / receipts / findings
 *     retained, exactly one release, fresh claim consumes the repair request.
 *  2. train-bound — the same stopped writer behind merge_train bounced /
 *     awaiting / stopped demotes through the existing BR#4494/5750 carve-out;
 *     a LIVE queue slot (queued/awaiting-ci) is never released.
 *  3. live writer — a running attempt keeps the claim (resume law).
 *  4. unknown operation — prepared/outcome_unknown effects keep the claim
 *     for reconciliation; the release must never clear them.
 *  5. idempotent restart — a hub restart re-runs the sweeps and still finds
 *     exactly one release and one claimable card: no duplicate effects.
 */

let serial = 0;
const HEAD = "a".repeat(40);

let mf: Miniflare;
let kbFetch: (path: string, init?: RequestInit) => Promise<Response>;

async function bootKb(persist?: string) {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  if (!existsSync(bundle)) {
    throw new Error("bundle missing — run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle (the npm test script does this before vitest)");
  }
  const instance = new Miniflare({
    ...(persist ? { durableObjectsPersist: persist } : {}),
    workers: [{
      name: "main",
      scriptPath: bundle,
      modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")),
      modules: true,
      compatibilityDate: "2025-09-06",
      durableObjects: {
        HUB: { className: "FlowsHub", useSQLite: true },
        KB: { className: "KnowledgeHub", useSQLite: true },
      },
    }],
  });
  const ns = await instance.getDurableObjectNamespace("KB");
  const stub: any = await ns.get(ns.idFromName("global"));
  return { instance, kb: (path: string, init?: RequestInit) => stub.fetch(`https://kb${path}`, init) };
}

beforeAll(async () => {
  const booted = await bootKb(mkdtempSync(join(tmpdir(), "br474-review-bounce-")));
  mf = booted.instance;
  kbFetch = booted.kb;
  await kbFetch("/orient", { method: "POST", headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify({ actor: "test" }) });
});

afterAll(async () => {
  await mf?.dispose();
});

async function post<T = Record<string, unknown>>(op: string, body: object): Promise<{ status: number; data: T & { error?: string } }> {
  const r = await kbFetch(`/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" },
    body: JSON.stringify(executorRequest(body)),
  });
  return { status: r.status, data: await r.json() as T & { error?: string } };
}
const taskById = async (id: string): Promise<{ status: string; owner?: string; meta?: any }> =>
  (await post("get", { id })).data as unknown as { status: string; owner?: string; meta?: any };
const historyOf = async (id: string) =>
  ((await post<{ versions?: Array<{ action: string; summary?: string }> }>("get_history", { id, limit: 200 })).data.versions ?? []);

/** Boot a gateway + worker, create a qualified impl task, take it through the
 *  real managed-writer lifecycle: claim → begin → [prepare op] → quiesce →
 *  stopped receipt → (progress) → in_review with the PR handoff note. */
async function managedWriter(name: string, opts: { ops?: "none" | "prepared" | "unknown"; stop?: boolean; progress?: boolean; train?: Record<string, unknown> } = {}) {
  const n = ++serial;
  const gw = `gw-br474-${name}`;
  const gateway = (await post<{ secret: string }>("admin.mint", { label: gw, tags: ["gateway"] })).data;
  const identity = (await post<{ token_id: string }>("auth.identify", { bearer: gateway.secret })).data;
  await post("agent.provision", { label: `${gw}/worker`, actor: gw });
  const base = { actor: gw, token_id: identity.token_id, gateway: true, agent: `${gw}/worker`, session: `dispatch-br474-${name}` };
  const adv = await post("execution", { ...base, id: "gateway", command_id: `adv-${name}`, command: { kind: "advertise", capabilities: { tier: "large", model: "test/fixture", tools: ["git"], environment: ["linux"], capacity: 4, worker: { kind: "provisioned", label: `${gw}/worker` } } } });
  expect(adv.data.error).toBeUndefined();
  const prNumber = 4200 + n;
  const { id } = (await post<{ id: string }>("create", { type: "task", title: `BR#474 ${name} specimen`, roles: ["impl"], qualified: true })).data;
  expect((await post("update", { id, actor: gw, meta: { pr: { repo: "state-vector/superpositional", number: prNumber, head_sha_at_acceptance: HEAD } } })).data.error).toBeUndefined();
  expect((await post("transition", { ...base, id, to: "in_progress", note: "impl" })).data.error).toBeUndefined();
  expect((await post("execution", { ...base, id, command_id: `begin-${name}`, command: { kind: "begin", attempt_id: `att-${name}`, worker: `${gw}/worker`, action_budget_ms: 3_600_000 } })).data.error).toBeUndefined();
  const fence = { generation: 1, attempt_id: `att-${name}` };
  const cmd = async (command_id: string, command: object) => {
    const r = await post("execution", { ...base, id, command_id, command: { ...fence, ...command } });
    expect(r.data.error, `${command_id}: ${JSON.stringify(r.data)}}`).toBeUndefined();
    return r.data;
  };
  if (opts.ops === "prepared" || opts.ops === "unknown") {
    await cmd(`prep-${name}`, { kind: "prepare", operation_id: `op-${name}`, action: "push-pr", input_revision: "rev-1", budget_ms: 60_000 });
    if (opts.ops === "unknown") await cmd(`res-${name}`, { kind: "result", operation_id: `op-${name}`, outcome: "outcome_unknown", receipts: [] });
  }
  if (opts.stop ?? true) {
    await cmd(`quiet-${name}`, { kind: "quiesce", writers: "process_group_empty" });
    await cmd(`stop-${name}`, { kind: "stopped", outcome: { kind: "interrupted", exit_code: null, stdout_tail: "PR submitted", stderr_tail: "" }, writers: "process_group_empty" });
  }
  if (opts.train) expect((await post("update", { id, actor: gw, meta: { merge_train: opts.train } })).data.error).toBeUndefined();
  if (opts.progress) expect((await post("progress.log", { ...base, id, note: "submitted the signed PR", completion_pct: 90 })).data.error).toBeUndefined();
  expect((await post("transition", { id, to: "in_review", actor: gw, note: `handoff — PR https://github.com/state-vector/superpositional/pull/${prNumber}` })).data.error).toBeUndefined();
  return { id, base, prNumber };
}

/** The independent findings handoff: a fresh reviewer bounces in_review →
 *  in_progress with findings. */
async function findingsBounce(id: string, reviewer = "reviewer-br474") {
  return post("transition", { id, to: "in_progress", actor: reviewer, note: "independent review findings: coverage bounce — the named gate is unmet; resolve and resubmit" });
}

describe("BR#474 — pre-queue review bounce with a physically stopped managed writer", () => {
  it("returns the bounced card to the managed pool atomically: todo, claimable, PR binding + repair request retained, exactly one release", async () => {
    const { id, prNumber } = await managedWriter("pre-queue", { progress: true });
    const bounce = await findingsBounce(id);
    expect(bounce.status, JSON.stringify(bounce.data)).toBeLessThan(400);
    const cur = await taskById(id);
    // the atomic release: the bounce landed the card back in the pool
    expect(cur.status).toBe("todo");
    expect(String(cur.owner ?? "")).toBe("");
    // the distinct typed repair request + the exact stopped fence are retained
    expect(cur.meta?.review_bounce_repair?.kind).toBe("pre_queue");
    expect(cur.meta?.review_bounce_repair?.writers).toBe("process_group_empty");
    expect(cur.meta?.review_bounce_repair?.pr?.number).toBe(prNumber);
    expect(cur.meta?.bounce_released?.writers).toBe("process_group_empty");
    // the finalize path's reconciliation primitive: the fresh session
    // reconciles the captured result instead of guessing completion
    expect(cur.meta?.execution_resume).toMatchObject({ kind: "terminal_result", generation: 1 });
    // PR binding and review receipts survive
    expect(cur.meta?.pr?.number).toBe(prNumber);
    const history = await historyOf(id);
    const releases = history.filter(v => v.action === "transition" && /review-bounce repair handoff/.test(String(v.summary)));
    expect(releases).toHaveLength(1);
    // idempotent: the sweeps re-run and find nothing to do — the card is
    // already claimable and exactly one release exists (real clock: the
    // fleet's gateway liveness is legitimately timestamp-based, so a wall
    // -clock jump would park ANY todo card behind an offline gateway — that
    // is scheduler law, not BR#474)
    await post("admin.stall_sweep", { now: Date.now() });
    await post("admin.execution_sweep", { now: Date.now() });
    const after = await taskById(id);
    expect(after.status).toBe("todo");
    expect((await historyOf(id)).filter(v => v.action === "transition" && /review-bounce repair handoff/.test(String(v.summary)))).toHaveLength(1);
    // exactly one fresh dispatch: the claim CONSUMES the repair request
    expect((await post("transition", { id, to: "in_progress", actor: "next-writer-br474", note: "fresh dispatch on the existing signed PR" })).data.error).toBeUndefined();
    const reclaimed = await taskById(id);
    expect(reclaimed.status).toBe("in_progress");
    expect(reclaimed.meta?.review_bounce_repair).toBeUndefined();
  });

  it("train-bound: the stopped writer behind a train bounce demotes through the BR#4494/5750 carve-out, queue meta preserved", async () => {
    const { id } = await managedWriter("train-bound", { progress: true, train: { state: "bounced", pr: 4311, repo: "state-vector/superpositional" } });
    const bounce = await findingsBounce(id);
    expect(bounce.status, JSON.stringify(bounce.data)).toBeLessThan(400);
    const cur = await taskById(id);
    expect(cur.status).toBe("todo");
    expect(String(cur.owner ?? "")).toBe("");
    expect(cur.meta?.review_bounce_repair?.kind).toBe("pre_queue");
    // the train state rides along verbatim — a fresh verify accept re-queues
    expect(cur.meta?.merge_train?.state).toBe("bounced");
    const releases = (await historyOf(id)).filter(v => v.action === "transition" && /review-bounce repair handoff/.test(String(v.summary)));
    expect(releases).toHaveLength(1);
  });

  it("control: a stopped writer behind a LIVE queue slot (queued) is not released — the train owns the slot", async () => {
    const { id, base } = await managedWriter("queue-slot", { progress: true, train: { state: "queued", pr: 4312, repo: "state-vector/superpositional" } });
    // production gateways ping constantly — give the owner a real session so
    // the timestamp-based legacy check sees a live owner exactly as it would
    await post("session.touch", { actor: base.actor, token_id: base.token_id, session: base.session });
    const bounce = await findingsBounce(id);
    expect(bounce.status, JSON.stringify(bounce.data)).toBeLessThan(400);
    const cur = await taskById(id);
    expect(cur.status).toBe("in_progress"); // bounced re-entry, untouched
    expect(cur.meta?.review_bounce_repair).toBeUndefined();
    expect(cur.meta?.bounce_released).toBeUndefined();
    // and the sweeps hold it too — never a machine silence-release of a slot
    await post("admin.stall_sweep", { now: Date.now() });
    expect((await taskById(id)).status).toBe("in_progress");
    expect((await taskById(id)).meta?.bounce_released).toBeUndefined();
  });
});

describe("BR#474 — the runner's own record outranks silence", () => {
  it("a LIVE writer keeps the claim at the findings handoff (resume law)", async () => {
    const { id } = await managedWriter("live-writer", { stop: false });
    const bounce = await findingsBounce(id);
    expect(bounce.status, JSON.stringify(bounce.data)).toBeLessThan(400);
    const cur = await taskById(id);
    expect(cur.status).toBe("in_progress");
    expect(cur.meta?.bounce_released).toBeUndefined();
    expect(cur.meta?.review_bounce_repair).toBeUndefined();
    expect(String(cur.owner ?? "")).not.toBe("");
  });

  it("unknown external operations keep the claim — the release never clears them", async () => {
    const { id } = await managedWriter("unknown-op", { ops: "unknown" });
    const bounce = await findingsBounce(id);
    expect(bounce.status, JSON.stringify(bounce.data)).toBeLessThan(400);
    const cur = await taskById(id);
    expect(cur.status).toBe("in_progress");
    expect(cur.meta?.bounce_released).toBeUndefined();
    expect(cur.meta?.review_bounce_repair).toBeUndefined();
    // the unresolved effect is intact for reconciliation
    const ops = cur.meta?.execution_state?.operations;
    expect(ops === undefined || ops.some((op: { state: string }) => op.state === "outcome_unknown")).toBe(true);
  });
});

describe("BR#474 — idempotent across a hub restart", () => {
  it("a restart re-runs the sweeps and still finds exactly one release and one claimable card", async () => {
    const dir = mkdtempSync(join(tmpdir(), "br474-restart-"));
    let boot = await bootKb(dir);
    const call = async (op: string, body: object) => {
      const r = await boot.kb(`/${op}`, { method: "POST", headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify(executorRequest(body)) });
      return { status: r.status, data: await r.json() as any };
    };
    try {
      await call("orient", { actor: "test" });
      const n = ++serial;
      const gw = `gw-br474-restart`;
      const gateway = (await call("admin.mint", { label: gw, tags: ["gateway"] })).data;
      const identity = (await call("auth.identify", { bearer: gateway.secret })).data;
      await call("agent.provision", { label: `${gw}/worker`, actor: gw });
      const base = { actor: gw, token_id: identity.token_id, gateway: true, agent: `${gw}/worker`, session: `dispatch-br474-restart` };
      expect((await call("execution", { ...base, id: "gateway", command_id: "adv-restart", command: { kind: "advertise", capabilities: { tier: "large", model: "test/fixture", tools: ["git"], environment: ["linux"], capacity: 4, worker: { kind: "provisioned", label: `${gw}/worker` } } } })).data.error).toBeUndefined();
      const prNumber = 4300 + n;
      const { id } = (await call("create", { type: "task", title: "BR#474 restart specimen", roles: ["impl"], qualified: true })).data;
      expect((await call("update", { id, actor: gw, meta: { pr: { repo: "state-vector/superpositional", number: prNumber, head_sha_at_acceptance: HEAD } } })).data.error).toBeUndefined();
      expect((await call("transition", { ...base, id, to: "in_progress", note: "impl" })).data.error).toBeUndefined();
      expect((await call("execution", { ...base, id, command_id: "begin-restart", command: { kind: "begin", attempt_id: "att-restart", worker: `${gw}/worker`, action_budget_ms: 3_600_000 } })).data.error).toBeUndefined();
      const fence = { generation: 1, attempt_id: "att-restart" };
      for (const [cid, command] of [
        ["quiet-restart", { kind: "quiesce", writers: "process_group_empty" }],
        ["stop-restart", { kind: "stopped", outcome: { kind: "interrupted", exit_code: null, stdout_tail: "PR submitted", stderr_tail: "" }, writers: "process_group_empty" }],
      ] as const) {
        expect((await call("execution", { ...base, id, command_id: cid, command: { ...fence, ...command } })).data.error).toBeUndefined();
      }
      expect((await call("progress.log", { ...base, id, note: "submitted the signed PR", completion_pct: 90 })).data.error).toBeUndefined();
      expect((await call("transition", { id, to: "in_review", actor: gw, note: `handoff — PR https://github.com/state-vector/superpositional/pull/${prNumber}` })).data.error).toBeUndefined();
      const bounce = await call("transition", { id, to: "in_progress", actor: "reviewer-restart", note: "independent review findings: bounce" });
      expect(bounce.status, JSON.stringify(bounce.data)).toBeLessThan(400);
      expect((await call("get", { id })).data.status).toBe("todo");
      const releasesBefore = (await call("get_history", { id, limit: 200 })).data.versions
        .filter((v: { action: string; summary?: string }) => v.action === "transition" && /review-bounce repair handoff/.test(String(v.summary)));
      expect(releasesBefore).toHaveLength(1);
      // the warm-isolate restart shape: a brand-new isolate over the SAME dir
      await boot.instance.dispose();
      boot = await bootKb(dir);
      // real-clock sweeps: idempotence needs no wall-clock jump (a jump would
      // park any todo card behind the legitimately-offline gateway)
      const now = Date.now();
      await call("admin.stall_sweep", { now });
      await call("admin.execution_sweep", { now });
      await call("admin.stall_sweep", { now: now + 1_000 });
      const after = (await call("get", { id })).data;
      expect(after.status).toBe("todo");
      const releasesAfter = (await call("get_history", { id, limit: 200 })).data.versions
        .filter((v: { action: string; summary?: string }) => v.action === "transition" && /review-bounce repair handoff/.test(String(v.summary)));
      expect(releasesAfter).toHaveLength(1); // no duplicate effects after the restart
      expect(after.meta?.review_bounce_repair?.kind).toBe("pre_queue");
      expect(after.meta?.pr?.number).toBe(prNumber);
    } finally {
      await boot.instance.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
