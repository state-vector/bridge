import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ASK_REAP_TTL_HOURS_DEFAULT,
  decideAskReap,
  decideRecoveryCoalesce,
} from "../src/kb/core.ts";

/**
 * BR#14583 — mortal asks + machine resume edges + recovery-duty coalescing
 * (the 50-ask pile-up class). The 2026-11-14 sweep found ~35 open machine
 * asks whose asker or intended-answerer session had died days earlier, each
 * pinning a card in blocked with the watchdog paused. Three structural
 * causes, pinned here:
 *
 *   A. decideAskReap — the reaper decision table: human-targeted asks are
 *      never reaped (Ray's alone — the non-goal), a live asker keeps its
 *      ask served, under-TTL asks are young; a dead asker past the TTL
 *      reaps;
 *   B. the reaper end-to-end (real SQLite): a dead-asker over-TTL ask is
 *      expired as system:reaper, its bound card unbound and released to the
 *      dispatch pool (todo, owner='') — no duty child, no human ask;
 *   C. the reaper's guard path: a live-holder bound card is NOT blind-
 *      resumed — markers stripped, wait re-armed (machine re-park), never
 *      left holding a dead ask;
 *   D. decideRecoveryCoalesce — one duty per (subject, await_event) key:
 *      an open duty is cited (cite-don't-re-derive, BR#12180's contract),
 *      a closed/missing duty spawns exactly one fresh.
 *
 * Human-targeted asks never expire mechanically (pinned in A and the
 * live-asker keep: the reaper's dedup against the human inbox).
 */

// ---------- rig ----------

let mf: Miniflare;
let stub: any;
async function call(op: string, body: object = {}) {
  const response = await stub.fetch(`https://kb/${op}`, {
    method: "POST", headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}
const get = async (id: string) => (await call("get", { id })).body;
async function task(title: string, meta: object = {}, roles: string[] = []) {
  const result = await call("create", { type: "task", title, qualified: true, actor: "author", roles, meta });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return String(result.body.id);
}
async function children(id: string) {
  const relations = (await call("relations", { id })).body.relations;
  return Promise.all(relations.filter((r: any) => r.relation === "child_of" && r.dir === "in").map((r: any) => get(r.artefact_id)));
}
const TTL_MS = ASK_REAP_TTL_HOURS_DEFAULT * 3_600_000;

beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  if (!existsSync(bundle)) throw new Error("bundle missing — run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle (before vitest)");
  mf = new Miniflare({
    workers: [{
      name: "main",
      modules: true,
      compatibilityDate: "2025-09-25",
      scriptPath: bundle,
      modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")),
      durableObjects: { KB: { className: "KnowledgeHub", useSQLite: true } },
    }],
  });
  stub = (await mf.getDurableObjectNamespace("KB")).get((await mf.getDurableObjectNamespace("KB")).idFromName("global"));
  await call("orient", { actor: "test" });
});

afterAll(async () => {
  await mf?.dispose();
});

// ---------- A. the reaper decision table ----------

describe("decideAskReap (BR#14583 closed union)", () => {
  it("keeps human-targeted asks at any age — never expired mechanically", () => {
    const d = decideAskReap({ humanTargeted: true, askerAlive: false, ageMs: 100 * 24 * 3_600_000, ttlMs: TTL_MS });
    expect(d.action).toBe("keep");
    expect(d.reason).toContain("human-targeted");
  });

  it("keeps a live asker's ask at any age", () => {
    const d = decideAskReap({ humanTargeted: false, askerAlive: true, ageMs: 100 * 24 * 3_600_000, ttlMs: TTL_MS });
    expect(d.action).toBe("keep");
    expect(d.reason).toContain("live");
  });

  it("keeps a dead asker's ask under the TTL, reaps past it", () => {
    expect(decideAskReap({ humanTargeted: false, askerAlive: false, ageMs: TTL_MS - 1, ttlMs: TTL_MS }).action).toBe("keep");
    const d = decideAskReap({ humanTargeted: false, askerAlive: false, ageMs: TTL_MS + 1, ttlMs: TTL_MS });
    expect(d.action).toBe("reap");
    expect(d.reason).toContain("dead asker");
  });
});

// ---------- D. the coalesce decision table ----------

describe("decideRecoveryCoalesce (BR#14583 cite-don't-re-derive)", () => {
  const key = 'BR#9|{"event":"pr_merged","repo":"state-vector/bridge","n":323}';
  it("cites an open duty with the same (subject, await_event) key — never a second duty", () => {
    expect(decideRecoveryCoalesce({ subject: "BR#9", awaitEventKey: '{"event":"pr_merged","repo":"state-vector/bridge","n":323}', existing: { id: "BR#10" } }))
      .toEqual({ action: "cite", duty_id: "BR#10", key });
  });
  it("spawns exactly one fresh duty when none is open — the key is content-derived", () => {
    expect(decideRecoveryCoalesce({ subject: "BR#9", awaitEventKey: '{"event":"pr_merged","repo":"state-vector/bridge","n":323}', existing: null }))
      .toEqual({ action: "spawn", key });
  });
  it("different keys never coalesce", () => {
    expect(decideRecoveryCoalesce({ subject: "BR#9", awaitEventKey: '{"event":"time","until_ts":1}', existing: { id: "BR#10" } }).action).toBe("cite");
    expect(decideRecoveryCoalesce({ subject: "BR#8", awaitEventKey: '{"event":"time","until_ts":1}', existing: { id: "BR#10" } }).key).not.toBe(key);
  });
});

// ---------- B/C. the reaper end-to-end ----------

describe("the ask reaper (BR#14583, real SQLite)", () => {
  /** A machine ask to a pool (`to: any`) — the pile-up's shape. */
  const poolAsk = async (question: string) => {
    const r = await call("ask.create", {
      to: "any", route: { kind: "agent_coordination" }, question, options: ["Yes", "No"], actor: "long-dead-asker",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return String(r.body.id);
  };
  const parkOnAsk = async (id: string, askId: string) => {
    const p = await call("transition", {
      id, to: "blocked", actor: "author", session: "",
      note: `Waiting on ${askId}`,
      await_event: { event: "ask", ask_id: askId },
    });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
  };

  it("reaps a dead-asker over-TTL ask and releases its bound card to the dispatch pool — no duty child", async () => {
    const parent = await task("Card pinned by a dead asker past the TTL");
    const askId = await poolAsk("Will the dead asker's pool answer this?");
    await parkOnAsk(parent, askId);
    // the park-time unblock round predates the sweep — the invariant is that
    // the REAPER spawns no new round (its unbind is not a delegation).
    const preSweepUnblock = (await children(parent)).filter((c: any) => c.roles.includes("unblock"));
    // asker "long-dead-asker" never connected → askTargetPresence offline;
    // created_ts is fresh — force the age with a back-dated clock.
    const backdated = Date.now() + (ASK_REAP_TTL_HOURS_DEFAULT + 2) * 3_600_000;
    const swept = await call("admin.ask_escalation_sweep", { now: backdated });
    expect(swept.status, JSON.stringify(swept.body)).toBe(200);
    expect(swept.body.escalated).toContain(askId);

    const ask = await get(askId);
    expect(ask.status).toBe("done");
    expect(ask.meta.ask.resolution).toMatchObject({ kind: "reaped", by: "system:reaper" });

    const resumed = await get(parent);
    expect(resumed.status).toBe("todo");
    expect(resumed.owner).toBe("");
    expect(resumed.meta.blocked).toBeUndefined();
    expect(resumed.meta.awaiting_ask).toBeUndefined();
    // consumed by the CAS'd mechanical resume — the provenance stamp rides it
    expect(resumed.meta.provenance).toBeUndefined(); // expired_coordination leg: no auto_resume stamp
    // no NEW duty child was spawned by the sweep — the reaper unbinds, it does not delegate
    const postSweepUnblock = (await children(parent)).filter((c: any) => c.roles.includes("unblock"));
    expect(postSweepUnblock.filter((c: any) => !preSweepUnblock.some((p: any) => p.id === c.id))).toHaveLength(0);
  });

  it("keeps a human-targeted ask open at any age — Ray's alone", async () => {
    const subject = await task("Human-ask subject card");
    const h = await call("ask.create", {
      to: "human", route: { kind: "human_decision" }, actor: "asker",
      question: "Do you approve retiring the ghost lane?",
      options: ["GO", "NO-GO"],
      reason: "Retirement authority is Ray's alone",
      details: "A human-owned disposition choice on a parked lane card.",
      artefact_id: subject,
      decision: { kind: "authority", task_id: subject, context: "Ghost lane retirement", why_human: "Retirement authority is human-only", choices: [{ label: "GO", executor: "human", consequence: "Retire it", action: "hold" }, { label: "NO-GO", executor: "human", consequence: "Keep it", action: "hold" }] },
    });
    expect(h.status, JSON.stringify(h.body)).toBe(200);
    const id = String(h.body.id);
    const backdated = Date.now() + 400 * 24 * 3_600_000;
    const swept = await call("admin.ask_escalation_sweep", { now: backdated });
    expect(swept.body.escalated).not.toContain(id);
    expect((await get(id)).status).not.toBe("done");
  });

  it("re-parks a guarded bound card (live holder) on a fresh time wait — never a dead-ask hold", async () => {
    const parent = await task("Guarded card held by a dead asker over-TTL");
    const askId = await poolAsk("Another dead-asker question for the same sweep?");
    await parkOnAsk(parent, askId);
    // live holder signal → the CAS'd mechanical resume trips its liveExecutor
    // guard → the reaper strips the ask markers and re-arms a time wait.
    const u = await call("update", { id: parent, actor: "author", meta: { session: "br14583-live-runner", last_progress: { ts: Date.now(), note: "holder alive" } } });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    const backdated = Date.now() + (ASK_REAP_TTL_HOURS_DEFAULT + 3) * 3_600_000;
    await call("admin.ask_escalation_sweep", { now: backdated });
    const ask = await get(askId);
    expect(ask.meta.ask.resolution).toMatchObject({ kind: "reaped" });
    const card = await get(parent);
    // guarded: stays blocked, on a machine-checkable re-armed wait, ask unbound
    expect(card.status).toBe("blocked");
    expect(card.meta.awaiting_ask).toBeUndefined();
    expect(card.meta.blocked?.await_event?.event).toBe("time");
    expect(card.meta.blocked?.reason).toContain(askId);
  });
});