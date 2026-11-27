import { Miniflare } from "miniflare";
import { readFileSync, realpathSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executorRequest } from "./executor-fixture";

/**
 * BR#23279 — the exec-block law, end to end on a real SQLite hub.
 *
 * Ray's ruling: `blocked` is reserved for external typed events; executor
 * READINESS is scheduler state and never a block condition. The one narrow
 * first-class carve-out beside the external parks is `interrupted` — a lost
 * in-flight executor (an in_progress card whose owner has no live session)
 * parks there instead of releasing straight to the pool, preserving resume
 * state under a bounded budget, exempt from abandonment scoring, written
 * only by the watchdog.
 */

let mf: Miniflare;
let stub: { fetch(url: string, init?: RequestInit): Promise<Response> };
let serial = 0;
async function post<T = Record<string, any>>(op: string, body: object): Promise<T> {
  const response = await stub.fetch(`https://kb/${op}`, { method: "POST", headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify(executorRequest(body)) });
  return await response.json() as T;
}

beforeEach(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  const root = bundle.slice(0, bundle.lastIndexOf("/"));
  const rig = `import { KnowledgeHub } from "./index.js";
    export class ParkRig extends KnowledgeHub {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        // Backdate a card AND its claiming session's liveness past every bar
        // (owner_stale_hours, card touch) so the owner-death leg (E) sees
        // provable death — the only state that may write an interrupted park.
        if (path === "/fixture/kill-owner") {
          const { id, age_ms = 5 * 3_600_000 } = await request.json();
          const now = Date.now();
          this.state.storage.sql.exec(
            "UPDATE artefacts SET status_ts=?, updated_ts=?, meta=json_set(meta, '$.last_progress.ts', ?) WHERE id=?",
            now - age_ms, now - age_ms, now - age_ms, id);
          this.state.storage.sql.exec(
            "UPDATE sessions SET last_seen_ts=? WHERE name=(SELECT json_extract(meta,'$.session') FROM artefacts WHERE id=?)",
            now - age_ms, id);
          return Response.json({ ok: true });
        }
        // Force the interrupted park's budget to lapse (deadline in the past)
        // so the (B2) sweep releases the card without wall-clock waiting.
        if (path === "/fixture/lapse-park") {
          const { id } = await request.json();
          this.state.storage.sql.exec(
            "UPDATE artefacts SET meta=json_set(meta, '$.interrupted.deadline_ts', 1) WHERE id=?", id);
          return Response.json({ ok: true });
        }
        // Seed the RETIRED legacy capability park (agent-authored shape: a
        // typed executor_capability await_event with no execution_wait
        // marker) exactly as historical rows persist in production.
        if (path === "/fixture/seed-legacy-park") {
          const { id } = await request.json();
          this.state.storage.sql.exec(
            "UPDATE artefacts SET status='blocked', owner='', status_ts=1, meta=json_set(meta, '$.blocked', " +
            "json('{\\"reason\\":\\"legacy capability park\\",\\"unblock_condition\\":\\"A live eligible executor capability becomes usable\\",\\"ts\\":1,\\"await_event\\":{\\"event\\":\\"executor_capability\\",\\"id\\":\\"' || id || '\\"}}')) WHERE id=?", id);
          return Response.json({ ok: true });
        }
        // The ledger's watchdog transition rows for a card — the exact input
        // the abandonment counter reads (result_class + released_owner).
        if (path === "/fixture/transition-events") {
          const { id } = await request.json();
          const rows = this.state.storage.sql.exec(
            "SELECT actor, ts, data FROM ledger WHERE artefact_id=? AND kind='signal' AND action='transition' ORDER BY seq", id).toArray();
          return Response.json({ events: rows.map(r => ({ actor: String(r.actor), ts: Number(r.ts), ...(JSON.parse(String(r.data ?? "{}"))) })) });
        }
        return super.fetch(request);
      }
    }
    export default {fetch(){return new Response("fixture");}};`;
  mf = new Miniflare({ modulesRoot: root, modules: [
    { type: "ESModule", path: root + "/park-rig.js", contents: rig },
    { type: "ESModule", path: bundle, contents: readFileSync(bundle, "utf8") },
  ], compatibilityDate: "2025-09-06", durableObjects: { KB: { className: "ParkRig", useSQLite: true } } });
  const ns = await mf.getDurableObjectNamespace("KB");
  stub = await ns.get(ns.idFromName(`br23279-${++serial}`)) as unknown as typeof stub;
});
afterEach(async () => { await mf?.dispose(); });

/** A ready gateway (label + token + provisioned worker) that can claim work. */
async function gateway() {
  const host = `park-host-${++serial}`;
  const token = await post("admin.mint", { label: host, tags: ["gateway"] });
  const identity = await post<{ token_id: string }>("auth.identify", { bearer: token.secret });
  await post("agent.provision", { label: `${host}/worker`, actor: host });
  const auth = { actor: host, token_id: identity.token_id, gateway: true, agent: `${host}/worker`, session: `session-${serial}` };
  const advertise = await post("execution", { ...auth, id: "gateway", command_id: `ready-${serial}`, command: { kind: "advertise", capabilities: { tier: "small", model: "test/small", tools: ["git"], environment: ["linux"], backend: "opencode", capacity: 2, projects: ["bridge"], worker: { kind: "provisioned", label: `${host}/worker` } } } });
  expect(advertise.ok).toBe(true);
  return { host, auth };
}

async function claimTask(auth: { actor: string; token_id: string; gateway: boolean; agent: string; session: string }) {
  const task = await post<{ id?: string; error?: string }>("create", { actor: "author", type: "task", title: `In-flight repair ${serial}`, project: "bridge", qualified: true, roles: ["impl"] });
  expect(task.error).toBeUndefined();
  const claim = await post("transition", { ...auth, id: task.id, to: "in_progress" });
  expect(claim.error).toBeUndefined();
  return task.id as string;
}

describe("BR#23279 — the interrupted park (lost in-flight executor)", () => {
  it("parks a lost in-flight executor interrupted with resume state, and the dead owner is not abandoned", async () => {
    const g = await gateway();
    const id = await claimTask({ ...g.auth, session: "lost-exec-1" });
    await post("session.touch", { token_id: g.auth.token_id, session: "lost-exec-1", worktree: "/tmp/bridge-worktrees/br23279-wip" });
    const progress = await post("progress.log", { ...g.auth, id, note: "did: traced the owner-death leg; will: write the park", will: "write the interrupted park write", sentiment: "converging", completion_pct: 60, confidence_pct: 80, risk_pct: 20, context_pct: 50 });
    expect(progress.error).toBeUndefined();
    await post("fixture/kill-owner", { id, age_ms: 5 * 3_600_000 });
    await post("admin.alarm_sweep", {});

    const parked = await post<{ status: string; owner: string; meta: { interrupted?: { owner: string; session: string; worktree: string | null; resume: { did: string | null; will: string | null }; budget_minutes: number; deadline_ts: number } } }>("get", { id });
    expect(parked.status).toBe("interrupted");
    expect(parked.owner).toBe("");
    expect(parked.meta.interrupted).toMatchObject({
      owner: `${g.host}/worker`,
      session: "lost-exec-1",
      worktree: "/tmp/bridge-worktrees/br23279-wip",
      resume: { did: expect.stringContaining("owner-death leg"), will: expect.stringContaining("park") },
      budget_minutes: 240,
    });
    expect(Number(parked.meta.interrupted?.deadline_ts)).toBeGreaterThan(Date.now());

    // The park event carries result_class interrupted_park + the released
    // owner — the exact inputs the abandonment counter exempts.
    const events = await post<{ events: { actor: string; result_class?: string; released_owner?: string; to?: string }[] }>("fixture/transition-events", { id });
    const parkEvent = events.events.find(e => e.to === "interrupted");
    expect(parkEvent).toMatchObject({ actor: "system:watchdog", result_class: "interrupted_park", released_owner: `${g.host}/worker` });

    // The dead owner's label is NOT dinged: my_score.abandoned stays 0.
    const orient = await post<{ my_score?: { abandoned?: number } }>("orient", { actor: g.host, token_id: g.auth.token_id, session: `post-park-${serial}` });
    expect(orient.my_score?.abandoned ?? 0).toBe(0);

    // The board carries the resume story: the exit class is interrupted and
    // the work wait names the claimable resume.
    const board = await (await stub.fetch("https://kb/board", { method: "GET" })).json() as { tasks: { id: string; status: string; work_waits?: { kind: string; exit: { event: string } }[] }[] };
    const boarded = board.tasks.find(t => t.id === id);
    expect(boarded?.status).toBe("interrupted");
    expect(boarded?.work_waits?.find(w => w.kind === "execution_recovery" && w.exit.event === "compatible_executor_ready")).toBeTruthy();
  });

  it("resumes an interrupted park through a normal claim, consuming the park record", async () => {
    const g = await gateway();
    const id = await claimTask({ ...g.auth, session: "lost-exec-2" });
    await post("progress.log", { ...g.auth, id, note: "did: mid-implementation; will: resume after the interruption", will: "resume" });
    await post("fixture/kill-owner", { id });
    await post("admin.alarm_sweep", {});
    expect((await post<{ status: string }>("get", { id })).status).toBe("interrupted");

    // A second live executor claims the park: interrupted → in_progress
    // through the same claim bars (readiness, separation of duties).
    const g2 = await gateway();
    const resume = await post("transition", { ...g2.auth, id, to: "in_progress" });
    expect(resume.error).toBeUndefined();
    const resumed = await post<{ status: string; owner: string; meta: { interrupted?: unknown } }>("get", { id });
    expect(resumed.status).toBe("in_progress");
    expect(resumed.owner).toBe(`${g2.host}/worker`);
    // A consumed park leaves no live budget record behind.
    expect(resumed.meta.interrupted).toBeUndefined();
  });

  it("laps the park to a pool release when the bounded budget expires — still not an abandonment", async () => {
    const g = await gateway();
    const id = await claimTask({ ...g.auth, session: "lost-exec-3" });
    await post("fixture/kill-owner", { id });
    await post("admin.alarm_sweep", {});
    expect((await post<{ status: string }>("get", { id })).status).toBe("interrupted");

    await post("fixture/lapse-park", { id });
    await post("admin.alarm_sweep", {});
    const lapsed = await post<{ status: string; owner: string; meta: { interrupted?: { owner?: string; worktree?: string | null } } }>("get", { id });
    expect(lapsed.status).toBe("todo");
    expect(lapsed.owner).toBe("");
    // The resume record survives the lapse for the next claimant.
    expect(lapsed.meta.interrupted?.owner).toBe(`${g.host}/worker`);

    const events = await post<{ events: { actor: string; result_class?: string; to?: string }[] }>("fixture/transition-events", { id });
    const lapseEvent = events.events.find(e => e.to === "todo" && e.actor === "system:watchdog");
    expect(lapseEvent).toMatchObject({ result_class: "interrupted_lapse" });
    const orient = await post<{ my_score?: { abandoned?: number } }>("orient", { actor: g.host, token_id: g.auth.token_id, session: `post-lapse-${serial}` });
    expect(orient.my_score?.abandoned ?? 0).toBe(0);
  });

  it("refuses agent-authored interrupted parks — the watchdog is the only writer", async () => {
    const g = await gateway();
    const id = await claimTask({ ...g.auth, session: "live-exec" });
    const refusal = await post("transition", { ...g.auth, id, to: "interrupted" });
    expect(refusal.error).toMatch(/cannot be parked interrupted|interrupted-park-authority/i);
    expect((await post<{ status: string }>("get", { id })).status).toBe("in_progress");
  });

  it("refuses the retired executor_capability block grammar at the machine gate", async () => {
    const g = await gateway();
    const task = await post<{ id: string }>("create", { actor: "author", type: "task", title: "Would-be capability park", project: "bridge", qualified: true });
    const refusal = await post("transition", { ...g.auth, id: task.id, to: "blocked", note: "waiting for an executor", await_event: { event: "executor_capability", id: task.id } });
    expect(refusal.error).toMatch(/execution-owned waits|executor capability/i);
    expect((await post<{ status: string }>("get", { id: task.id })).status).toBe("todo");
  });

  it("drains a legacy agent-authored capability park to todo through the reconcile pen", async () => {
    const g = await gateway();
    const task = await post<{ id: string }>("create", { actor: "author", type: "task", title: "Legacy park row", project: "bridge", qualified: true, meta: { execution_requirements: { tier: "small", tools: ["git"], environment: [] } } });
    await post("fixture/seed-legacy-park", { id: task.id });
    expect((await post<{ status: string }>("get", { id: task.id })).status).toBe("blocked");

    await post("admin.execution_sweep", {});
    const drained = await post<{ status: string; owner: string; meta: { blocked?: unknown; execution_wait?: unknown; execution_blockers?: { kind: string }[] } }>("get", { id: task.id });
    expect(drained.status).toBe("todo");
    expect(drained.owner).toBe("");
    expect(drained.meta.blocked).toBeUndefined();
    expect(drained.meta.execution_wait).toBeUndefined();
  });

  it("keeps holding a typed-wait card whose owner died — the hold owns the exit, not the park", async () => {
    const g = await gateway();
    const id = await claimTask({ ...g.auth, session: "lost-exec-4" });
    // The BR#4687 shape: an awaiting-ci merge train leg on an in_progress card.
    await post("update", { id, meta: {
      merge_train: { state: "awaiting-ci", at: Date.now(), pr: 322, repo: "state-vector/bridge", legs: { 322: { state: "awaiting-ci", merge_sha: "a".repeat(40) } }, merge_sha: "a".repeat(40) },
      pr: { repo: "state-vector/bridge", number: 322, head_sha_at_acceptance: "b".repeat(40) },
    } });
    await post("fixture/kill-owner", { id });
    await post("admin.alarm_sweep", {});
    // Held, not parked: the train owns the exit; the owner-death leg waits
    // it out rather than re-refusing or stealing the train's card.
    expect((await post<{ status: string }>("get", { id })).status).toBe("in_progress");
  });
});
