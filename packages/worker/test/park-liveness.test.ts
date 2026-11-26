import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Park liveness backstop (BR-park-hygiene) — real DO drill against the
 * bundled worker. The disease this pins: the unblock-proxy sweep's guard
 * skips (startup waits, execution waits/handoffs) used to be SILENT — a
 * card's proxy_check kept its old timestamp forever while the world moved
 * (the live specimen: a pr_merged park whose PR merged the day after its
 * last check; nothing re-evaluated it, no census counted the silence, and
 * the park sat for days). Three mechanisms, one real DO:
 *
 *  (a) the guard skip now STAMPS honestly (verdict "protected") — the
 *      silence is named on the card, machine-readable;
 *  (b) parkLivenessSweep audits every typed park's check AGE: a silenced
 *      card's predicate is re-evaluated from LEDGER/BOARD state only (zero
 *      GitHub calls, zero agents) — satisfied → the BR#14544 consumed-wait
 *      resume; conclusively dead → a dead-leg release to the pool;
 *      indeterminate → the starvation becomes a visible census + stamp;
 *  (c) every exit rides continueBlockedWork's own guard set (protected
 *      execution, train states, live executors, human bounds, CAS) — a
 *      card the train owns is census-refused, never ripped from its owner.
 *
 * Ledger truth sources exercised: provenance (train-stamped) and
 * delivery_pr_outcomes (reconcile.report's hub-owned observations).
 */

let mf: Miniflare;
const t0 = Date.now();
// rising clock offsets (minutes past t0) — one shared DO: later drills need
// later clocks (the sweep paces itself per period and per last-tick stamp)
const T1 = t0 + 125 * 60_000;
const T2 = t0 + 160 * 60_000;
const T3 = t0 + 195 * 60_000;
const T4 = t0 + 230 * 60_000;
const T5 = t0 + 266 * 60_000;
const T6 = t0 + 300 * 60_000;

async function kbJson(path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const kb = (globalThis as any).__kb as (p: string, i?: RequestInit) => Promise<Response>;
  const r = await kb(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const taskById = async (id: string) => (await kbJson("/get", { id })).body;

/** /events is GET-only (query params) — never POST it. */
const eventsSince = async (since: number, limit = 500): Promise<any[]> =>
  (await kbJson(`/events?since=${since}&limit=${limit}`)).body?.events ?? [];

/** Park a task on a typed await_event (the machine's own door — straight
 *  from todo: no claim, so no live execution attempt fences the resume). */
async function park(id: string, session: string, n: number, event: Record<string, unknown> = { event: "pr_merged", repo: "state-vector/superpositional", n }) {
  const blk = await kbJson("/transition", {
    id, to: "blocked", actor: session, session,
    note: "parked on the merge gate (park-liveness drill)",
    unblock_condition: `Machine proxy: PR https://github.com/state-vector/superpositional/pull/${n} mergeCommit non-null (state=MERGED).`,
    await_event: event,
  });
  expect(blk.status, `park failed: ${JSON.stringify(blk.body)}`).toBe(200);
}

/** Backdate a card's proxy_check past the silence window (default 60m). */
async function silence(id: string, session: string, minutesAgo = 180) {
  const meta = (await taskById(id)).meta ?? {};
  const upd = await kbJson("/update", {
    id, actor: session,
    meta: { ...meta, proxy_check: { at: t0 - minutesAgo * 60_000, verdict: "probe_pending" } },
  });
  expect(upd.status, `silence failed: ${JSON.stringify(upd.body)}`).toBe(200);
}

const livenessSweep = async (now: number) => kbJson("/admin.park_liveness_sweep", { now });

beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  if (!existsSync(bundle)) {
    throw new Error("bundle missing — run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle (before vitest)");
  }
  mf = new Miniflare({
    workers: [{
      name: "main",
      scriptPath: bundle,
      modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")),
      modules: true,
      compatibilityDate: "2025-09-06",
      bindings: { GH_TOKEN: "test-token" },
      durableObjects: {
        HUB: { className: "FlowsHub", useSQLite: true },
        KB: { className: "KnowledgeHub", useSQLite: true },
      },
    }],
  });
  const ns = await mf.getDurableObjectNamespace("KB");
  const stub: any = await ns.get(ns.idFromName("global"));
  (globalThis as any).__kb = (path: string, init?: RequestInit) => stub.fetch(`https://kb${path}`, init);
  await kbJson("/orient", {});
});

afterAll(async () => {
  await mf?.dispose();
});

describe("park liveness backstop — silenced parks (real DO)", () => {
  it("(1) a silenced pr_merged park whose merge is a hub-owned reconcile observation resumes — no agent, no credential", async () => {
    // session-less park: no live holder exists, so the BR#3819-D fence is
    // quiet and the mechanical resume is the hub's to take
    const c = await kbJson("/create", { type: "task", title: "IMPL: park-liveness merged-drill", qualified: true });
    expect(c.status).toBe(200);
    const id = String(c.body.id);
    const blk = await kbJson("/transition", {
      id, to: "blocked", actor: "drill-liveness-a", session: "",
      note: "parked on the merge gate (park-liveness drill)",
      unblock_condition: "Machine proxy: PR https://github.com/state-vector/superpositional/pull/2470 mergeCommit non-null (state=MERGED).",
      await_event: { event: "pr_merged", repo: "state-vector/superpositional", n: 2470 },
    });
    expect(blk.status, `park failed: ${JSON.stringify(blk.body)}`).toBe(200);
    // the reconcile daemon observed the merge (its own ledger write — the
    // hub OWNS this fact; provenance was never stamped for this PR)
    const rep = await kbJson("/reconcile.report", {
      repo: "state-vector/superpositional",
      prs: [{ number: 2470, state: "MERGED", mergeCommit: "a".repeat(40), headRefOid: "b".repeat(40), title: "drill" }],
    });
    expect(rep.status, `reconcile.report failed: ${JSON.stringify(rep.body)}`).toBeLessThan(500);
    await silence(id, "drill-liveness-a");
    const sweep = await livenessSweep(T1);
    expect(sweep.status, JSON.stringify(sweep.body)).toBeLessThan(500);
    expect(sweep.body.census?.resumed ?? 0, `census: ${JSON.stringify(sweep.body.census)}`).toBeGreaterThanOrEqual(1);

    const after = await taskById(id);
    expect(after.status, "a ledger-true silenced park resumes to the pool").toBe("todo");
    expect(after.meta?.proxy_check?.verdict).toBe("true");
    expect((after.meta?.proxy_check?.receipts ?? []).join(" ")).toContain("reconcile observation (ledger-native)");
    expect(after.meta?.blocked, "the consumed wait must not outlive its consumption").toBeUndefined();

    // the park-time machine round did not survive the resume (BR#14544 law)
    const rounds = ((await kbJson("/list", { type: "task", limit: 200 })).body?.artefacts ?? [])
      .filter((a: any) => a.title.startsWith("Unblock: IMPL: park-liveness merged-drill"));
    expect(rounds.length, "one park-time round").toBe(1);
    expect(rounds[0].status).toBe("superseded");
    expect(String(rounds[0].meta?.superseded_reason ?? "")).toContain("resumed from blocked");

    // pacing: an immediate re-run at the same clock does nothing
    const paced = await livenessSweep(T1);
    expect(paced.body.census?.paced).toBe(true);
  });

  it("(2) a silenced br_done park whose prerequisite retired without a replacement releases as a DEAD leg", async () => {
    const dep = await kbJson("/create", { type: "task", title: "IMPL: park-liveness dep (dies)", qualified: true, session: "drill-liveness-b" });
    const depId = String(dep.body.id);
    const c = await kbJson("/create", { type: "task", title: "IMPL: park-liveness parked-on-dep", qualified: true });
    const id = String(c.body.id);
    // session-less like test 1 — no live holder to fence the dead-leg release
    const blk = await kbJson("/transition", {
      id, to: "blocked", actor: "drill-liveness-b", session: "",
      note: "parked on the dependency gate (park-liveness drill)",
      unblock_condition: `Machine proxy: ${depId} done.`,
      await_event: { event: "br_done", id: depId },
    });
    expect(blk.status, `park failed: ${JSON.stringify(blk.body)}`).toBe(200);
    // legal at park time (dep todo); then the dependency retires with no
    // successor — the wait can never fire: the conclusive-negative class.
    // The dep itself parks first (blocked → superseded is a parked card's
    // one drop edge, BR#3913) and drops by web authority.
    const dblk = await kbJson("/transition", {
      id: depId, to: "blocked", actor: "drill-liveness-b", session: "drill-liveness-b",
      note: "parked on a far-future timer (drill)",
      unblock_condition: "timer elapsed (until_ts far future)",
      await_event: { event: "time", until_ts: t0 + 365 * 24 * 3_600_000 },
    });
    expect(dblk.status, `dep park failed: ${JSON.stringify(dblk.body)}`).toBe(200);
    await silence(id, "drill-liveness-b");
    const sup = await kbJson("/transition", {
      id: depId, to: "superseded", actor: "web:rayh", session: "web",
      note: "drill: retired without a replacement",
    });
    expect(sup.status, `supersede failed: ${JSON.stringify(sup.body)}`).toBe(200);

    const sweep = await livenessSweep(T2);
    expect(sweep.body.census?.dead_released ?? 0, `census: ${JSON.stringify(sweep.body.census)}`).toBeGreaterThanOrEqual(1);

    const after = await taskById(id);
    expect(after.status, "a conclusively dead wait releases to the pool for re-delivery/repair").toBe("todo");
    expect(after.meta?.proxy_check?.verdict).toBe("dead_leg");
    expect(after.meta?.blocked_drained?.klass).toBe("dead-atom");
    expect((after.meta?.proxy_check?.receipts ?? []).join(" ")).toContain("retired without a replacement outcome");
  });

  it("(3) a satisfied park the TRAIN owns (awaiting-ci) is census-refused — never ripped from its owner", async () => {
    const c = await kbJson("/create", { type: "task", title: "IMPL: park-liveness train-owned-drill", qualified: true, session: "drill-liveness-c" });
    const id = String(c.body.id);
    await park(id, "drill-liveness-c", 2471);
    // the train stamps provenance for 2471 (the ledger-native merge) and the
    // card rides the train awaiting-ci — the TRAIN owns this card's exit
    await kbJson("/train.lane", { repo: "state-vector/superpositional", base: "main", actor: "drill-liveness", spec: { required_workflows: ["Test"] } });
    const lease = await kbJson("/train.lease", { repo: "state-vector/superpositional", base: "main", action: "acquire" });
    expect(lease.status, JSON.stringify(lease.body)).toBe(200);
    const ev = await kbJson("/train.event", {
      repo: "state-vector/superpositional", base: "main", kind: "merged",
      pr: 2471, merge_sha: "c".repeat(40), head_sha: "d".repeat(40),
      task_id: id, signer: "drill-liveness-signer",
    });
    expect(ev.status, `train.event failed: ${JSON.stringify(ev.body)}`).toBe(200);
    await kbJson("/train.lease", { repo: "state-vector/superpositional", base: "main", action: "release" });
    const meta = (await taskById(id)).meta ?? {};
    const upd = await kbJson("/update", {
      id, actor: "drill-liveness-c",
      meta: { ...meta, merge_train: { ...(meta.merge_train ?? {}), state: "awaiting-ci", repo: "state-vector/superpositional", pr: 2471 } },
    });
    expect(upd.status).toBe(200);
    await silence(id, "drill-liveness-c");

    const sweep = await livenessSweep(T3);
    const census = sweep.body.census ?? {};
    expect(census.resume_refused ?? 0, `census: ${JSON.stringify(census)}`).toBeGreaterThanOrEqual(1);
    expect((census.refused_ids ?? []).some((x: any) => x.id === id), "the refusal names the card and the guard").toBeTruthy();

    const after = await taskById(id);
    expect(after.status, "the train-owned card STAYS parked — the backstop never takes a live owner's exit").toBe("blocked");
    expect(after.meta?.blocked?.await_event).toEqual({ event: "pr_merged", repo: "state-vector/superpositional", n: 2471 });
    expect(Number(after.meta?.proxy_check?.at ?? 0), "no stamp churn on a refused card — the owning layer keeps the verdict vocabulary").toBe(t0 - 180 * 60_000);
  });

  it("(4) an indeterminate gate starves LOUD: probe_starved stamp, census, one episode alarm", async () => {
    const set = await kbJson("/admin.settings_set", { settings: { park_probe_stale_hours: "1" } });
    expect(set.body.error).toBeUndefined();
    const c = await kbJson("/create", { type: "task", title: "IMPL: park-liveness starved-drill", qualified: true, session: "drill-liveness-e" });
    const id = String(c.body.id);
    await park(id, "drill-liveness-e", 2472); // no ledger row anywhere — needs a credential the hub does not hold
    const cursor = Number((await kbJson(`/events?since=0&limit=1`)).body?.last_seq ?? 0);
    await silence(id, "drill-liveness-e");

    const sweep = await livenessSweep(T4);
    const census = sweep.body.census ?? {};
    expect(census.probe_starved ?? 0, `census: ${JSON.stringify(census)}`).toBeGreaterThanOrEqual(1);
    expect((census.starved_ids ?? []).includes(id)).toBeTruthy();

    const after = await taskById(id);
    expect(after.status).toBe("blocked");
    expect(after.meta?.proxy_check?.verdict).toBe("probe_starved");
    expect(String(after.meta?.proxy_check?.detail ?? "")).toContain("verification pool is empty");

    // the population alarm fired for the episode (test 3's census-refusal
    // legitimately consumed the once-per-day budget — exactly one exists)
    const evs = await eventsSince(0);
    const alarms = evs.filter((e: any) => e.op === "park_liveness_alarm");
    expect(alarms.length, `expected one episode alarm, got ${JSON.stringify(alarms)}`).toBe(1);
    expect(alarms[0].detail?.silenced ?? 0).toBeGreaterThanOrEqual(1);

    const reset = await kbJson("/admin.settings_set", { settings: { park_probe_stale_hours: "24" } });
    expect(reset.body.error).toBeUndefined();
  });

  it("(5) a guard-skipped park is stamped 'protected' — the silence is NAMED, then liveness-counted", async () => {
    const c = await kbJson("/create", { type: "task", title: "IMPL: park-liveness guarded-drill", qualified: true, session: "drill-liveness-f" });
    const id = String(c.body.id);
    await park(id, "drill-liveness-f", 2473);
    // an execution wait the scheduler owns: the proxy sweep's guard skips it
    const meta = (await taskById(id)).meta ?? {};
    const upd = await kbJson("/update", {
      id, actor: "drill-liveness-f",
      meta: { ...meta, execution_wait: { kind: "external_checks" } },
    });
    expect(upd.status).toBe(200);

    const ps = await kbJson("/admin.unblock_proxy_sweep", { now: T5 });
    expect(ps.status, JSON.stringify(ps.body)).toBeLessThan(500);
    const after = await taskById(id);
    expect(after.status).toBe("blocked");
    expect(after.meta?.proxy_check?.verdict, "the guard skip stamps honestly instead of silently continuing").toBe("protected");
    expect(String(after.meta?.proxy_check?.detail ?? "")).toContain("park liveness backstop");

    // and the fresh protected stamp is liveness-counted as its own class
    const sweep = await livenessSweep(T5);
    const census = sweep.body.census ?? {};
    expect(census.protected_execution ?? 0, `census: ${JSON.stringify(census)}`).toBeGreaterThanOrEqual(1);
    expect((census.silenced_ids ?? []).includes(id), "a fresh protected card is not 'silenced' — its guard speaks").toBeFalsy();
  });

  it("(6) standing infrastructure (lane cards) is exempt — never touched, census-visible", async () => {
    const c = await kbJson("/create", { type: "task", title: "LANE: park-liveness infra-drill", qualified: true, session: "drill-liveness-g" });
    const id = String(c.body.id);
    await park(id, "drill-liveness-g", 2474);
    const meta = (await taskById(id)).meta ?? {};
    const upd = await kbJson("/update", {
      id, actor: "drill-liveness-g",
      meta: { ...meta, lane: { repo: "state-vector/liveness-drill-lane", base: "main" } },
    });
    expect(upd.status, `lane meta failed: ${JSON.stringify(upd.body)}`).toBe(200);
    await silence(id, "drill-liveness-g");

    const sweep = await livenessSweep(T6);
    const census = sweep.body.census ?? {};
    expect(census.protected_infra ?? 0, `census: ${JSON.stringify(census)}`).toBeGreaterThanOrEqual(1);
    expect((census.silenced_ids ?? []).includes(id), "infra is exempt from the liveness backstop").toBeFalsy();
    const after = await taskById(id);
    expect(after.status).toBe("blocked");
    expect(Number(after.meta?.proxy_check?.at ?? 0)).toBe(t0 - 180 * 60_000); // untouched
  });
});
