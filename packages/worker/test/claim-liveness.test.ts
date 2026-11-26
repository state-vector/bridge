import { Miniflare } from "miniflare";
import { readFileSync, realpathSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executorRequest } from "./executor-fixture";

/**
 * Claim liveness (BR-flow-unblock) — real DO drills against the bundled
 * worker. The disease this pins: the in_progress stall sweep's guard skips
 * used to be SILENT — a zombie claim (a board row of an ended session) held
 * by a bound-ask marker, a typed execution wait, a handoff or an open ask
 * row was never re-judged and nothing counted the silence. The live
 * specimens: BR#9594 (19 days past its ask's own machine cancellation,
 * annotated "blocked 82h" against a resolved ask) and BR#6992 (an ended
 * interactive claim lingering with no named fence). Two mechanisms, one
 * real DO:
 *
 *  (a) the awaiting_ask skip now HEALS the provably dead shape — a marker
 *      whose ask is a cancelled/expired NON-human coordination request is
 *      stale metadata (the BR#18868 admission-side law, applied to the
 *      claim side); the marker clears and the card falls through to the
 *      ordinary silence classification. Human decisions and answered asks
 *      never qualify — their exits stay human-owned.
 *  (b) every remaining silent skip STAMPS honestly (meta.silence_hold) and
 *      lands in the stall census (watchdog.stale_claims) — and the
 *      scheduler's dispatch holds gain a per-class AGE (hold_oldest_ts) plus
 *      one throttled all-class pile alarm (dispatch_hold_pile), so
 *      "eligible: 1 with a full pool" can never again be silent starvation.
 */

let mf: Miniflare;
let stub: { fetch(url: string, init?: RequestInit): Promise<Response> };
let serial = 0;
const t0 = Date.now();
// the synthetic stall_sweep clock sits far past every real write, so drilled
// cards are silent by construction (10m default staleness)
const T1 = t0 + 125 * 60_000;

async function post(op: string, body: object = {}) {
  const response = await stub.fetch(`https://kb/${op}`, { method: "POST", headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify(executorRequest(body)) });
  return await response.json() as Record<string, any>; // JSON transport boundary, schemas validate outcomes
}
const get = async (id: string) => (await post("get", { id }));
const metaOf = async (id: string) => (await get(id)).meta ?? {};
/** /events is GET-only (query params) — never POST it. */
const eventsSince = async (): Promise<any[]> =>
  (await (await stub.fetch("https://kb/events?since=0&limit=500")).json() as { events?: any[] }).events ?? [];
const stallSweep = async (now: number) => post("admin.stall_sweep", { now });

beforeEach(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  const root = bundle.slice(0, bundle.lastIndexOf("/"));
  const rig = `import { KnowledgeHub } from "./index.js";
    export class ClaimLivenessRig extends KnowledgeHub {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        // Stamp the stranded-marker shape a pre-fix card could carry: an
        // awaiting_ask marker (plus the lying park-prose annotation) on an
        // in_progress card — the exact BR#9594 specimen shape, which the
        // cancel-time reconcile (a blocked-park reconcile) never touched.
        if (path === "/fixture/cl-stamp-marker") {
          const { id, ask_id, prose } = await request.json();
          const row = this.state.storage.sql.exec("SELECT meta FROM artefacts WHERE id=?", id).toArray()[0];
          const meta = JSON.parse(String(row?.meta ?? "{}"));
          meta.awaiting_ask = { ...(meta.awaiting_ask ?? {}), ask_id, to: "any", ts: Date.now() - 82 * 3_600_000, annotated_h: 82 };
          if (prose) meta.blocked = { ...(meta.blocked ?? {}), reason: prose };
          this.state.storage.sql.exec("UPDATE artefacts SET meta=? WHERE id=?", JSON.stringify(meta), id);
          return Response.json({ ok: true, ask_id });
        }
        if (path === "/fixture/cl-alarm") {
          await this.alarmSweep();
          return Response.json({ ok: true });
        }
        if (path === "/fixture/hold-pile-signals") {
          const rows = this.state.storage.sql.exec(
            "SELECT data FROM ledger WHERE kind='signal' AND action='dispatch_hold_pile' ORDER BY seq DESC LIMIT 1").toArray();
          return Response.json({ signal: rows[0] ? JSON.parse(rows[0].data) : null });
        }
        if (path === "/fixture/cl-backdate-status") {
          const { id, ts } = await request.json();
          this.state.storage.sql.exec("UPDATE artefacts SET status_ts=? WHERE id=?", ts, id);
          return Response.json({ ok: true });
        }
        return super.fetch(request);
      }
    }
    export default {fetch(){return new Response("fixture");}};`;
  mf = new Miniflare({ modulesRoot: root, modules: [
    { type: "ESModule", path: root + "/claim-liveness-rig.js", contents: rig },
    { type: "ESModule", path: bundle, contents: readFileSync(bundle, "utf8") },
  ], compatibilityDate: "2025-09-06", durableObjects: { KB: { className: "ClaimLivenessRig", useSQLite: true } } });
  const ns = await mf.getDurableObjectNamespace("KB");
  stub = await ns.get(ns.idFromName("scheduler")) as unknown as typeof stub;
});
afterEach(async () => { await mf?.dispose(); });

/** A task claimed in_progress by a session that then goes quiet. */
async function claimedTask(title: string, session: string): Promise<string> {
  const result = await post("create", { actor: "author", type: "task", title, body_md: "claim-liveness fixture", project: "bridge", qualified: true, roles: ["impl"] });
  expect(result.error, JSON.stringify(result)).toBeUndefined();
  const id = String(result.id);
  const claim = await post("transition", { id, to: "in_progress", actor: session, session, note: "claimed (claim-liveness drill)" });
  expect(claim.error, JSON.stringify(claim)).toBeUndefined();
  // backdate the card's trail so it is silent by any clock ≥ t0+10m
  await post("update", { id, actor: session, meta: { last_progress: { ts: t0 - 30 * 60_000, session, note: "working (claim-liveness drill)" } } });
  return id;
}

/** The real BR#9594 chain: bind a coordination ask to a consumer card, close
 *  the producer (machine-cancel of the ask, receipts preserved), then reduce
 *  the consumer to the stranded shape the cancel-time reconcile never
 *  touches — claimed in_progress with an orphan marker naming a dead ask. */
async function strandedMarkerCard(project: string, to: string, session: string): Promise<{ id: string; askId: string }> {
  const producerId = await (async () => {
    const result = await post("create", { actor: "author", type: "task", title: `claim-liveness producer ${++serial}`, body_md: "fixture producer", project, qualified: true, roles: ["analysis"], meta: { operator_gated: true } });
    expect(result.error, JSON.stringify(result)).toBeUndefined();
    return String(result.id);
  })();
  const consumer = await claimedTask(`IMPL: claim-liveness consumer ${serial}`, session);
  const ask = await post("ask.create", { to, actor: "author", question: `Any overlap before ${consumer} proceeds?`,
    ...(to === "human" ? {
      decision: {
        kind: "authority", task_id: consumer,
        context: "Fixture: the drill needs a live human decision holding a claimed card.",
        why_human: "only the human owns this exit (fixture)",
        choices: [
          { label: "Release the claim", executor: "human", consequence: "the card returns to the pool", action: "release" },
          { label: "Hold", executor: "human", consequence: "the card stays claimed", action: "hold" },
        ],
      },
    } : { route: { kind: "executor_coordination", task_id: producerId } }),
    artefact_id: consumer, ...(to === "human" ? { options: ["Release the claim", "Hold"] } : { options: ["Resume", "Hold"] }), reason: `${project}: producer coordination`, details: "Fixture coordination ask" });
  expect(ask.error, JSON.stringify(ask)).toBeUndefined();
  expect(ask.task_status).toBe("blocked"); // askCreate parks the consumer
  // close the producer → the machine cancels a COORDINATION ask ("Linked
  // work ... is done"); a human decision is never machine-cancelled
  const cleared = await post("update", { id: producerId, meta_delete: ["operator_gated"] });
  expect(cleared.error, JSON.stringify(cleared)).toBeUndefined();
  const claimP = await post("transition", { id: producerId, to: "in_progress", actor: "author", session, note: "claim" });
  expect(claimP.error, JSON.stringify(claimP)).toBeUndefined();
  const done = await post("transition", { id: producerId, to: "done", actor: "author", session,
    note: "delivered — fixture://producer", execution_result: { outcome: "delivered", receipts: ["fixture://producer"] } });
  expect(done.error, JSON.stringify(done)).toBeUndefined();
  const askRow = await get(String(ask.id));
  if (to !== "human") {
    expect(askRow.status).toBe("done");
    expect(askRow.meta.ask.resolution.kind).toBe("cancelled");
  } else {
    expect(["todo", "in_progress", "blocked"]).toContain(askRow.status); // the human leg stays open
  }
  // reduce to the stranded shape: the OWNER releases (release-needs-ownership),
  // re-claims, then the orphan marker is stamped — the shape the cancel-time
  // reconcile never touched
  const release = await post("transition", { id: consumer, to: "todo", actor: session, session, note: "release dead coordination wait (fixture)" });
  expect(release.error, JSON.stringify(release)).toBeUndefined();
  const reClaim = await post("transition", { id: consumer, to: "in_progress", actor: session, session, note: "re-claim (fixture)" });
  expect(reClaim.error, JSON.stringify(reClaim)).toBeUndefined();
  const stamped = await (await stub.fetch("https://kb/fixture/cl-stamp-marker", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: consumer, ask_id: String(ask.id), prose: `⏳ blocked 82h — awaiting ${to} on ask ${ask.id} · ` }) })).json();
  expect(stamped).toMatchObject({ ok: true });
  return { id: consumer, askId: String(ask.id) };
}

describe("claim liveness — stale bound-ask markers (real DO)", () => {
  it("(1) a marker naming a machine-cancelled coordination ask clears and the silent card releases to the pool", async () => {
    const { id, askId } = await strandedMarkerCard("cl-healed", "peer-agent", "drill-claim-a");
    const before = await metaOf(id);
    expect(before.awaiting_ask?.ask_id).toBe(askId); // the stranded shape is in place

    const swept = await stallSweep(T1);
    expect(swept.error, JSON.stringify(swept)).toBeUndefined();
    const after = await get(id);
    expect(after.status).toBe("todo");
    expect(after.meta?.awaiting_ask).toBeUndefined();
    expect(after.meta?.blocked).toBeUndefined();
    expect(after.meta?.silence_hold).toBeUndefined();
    const events = await eventsSince();
    expect(events.some(e => e.op === "stale_ask_marker_cleared" && e.artefact_id === id),
      "the heal must receipt its audit event").toBe(true);
  });

  it("(2) a marker naming an open HUMAN decision keeps holding — human exits are never machine-healed", async () => {
    const { id, askId } = await strandedMarkerCard("cl-human", "human", "drill-claim-b");

    const swept = await stallSweep(T1);
    expect(swept.error, JSON.stringify(swept)).toBeUndefined();
    const after = await get(id);
    expect(after.status).toBe("in_progress");
    expect(after.meta?.awaiting_ask?.ask_id).toBe(askId);
    const events = await eventsSince();
    expect(events.some(e => e.op === "stale_ask_marker_cleared" && e.artefact_id === id)).toBe(false);
  });

  it("(3) a protected fence (typed execution wait) is NAMED on the card and counted in the stall census", async () => {
    const id = await claimedTask(`IMPL: claim-liveness protected fence ${serial}`, "drill-claim-c");
    await post("update", { id, actor: "drill-claim-c", meta: { execution_wait: { kind: "external_checks", repo: "state-vector/superpositional", head_sha: "a".repeat(40), checks: ["ci"] } } });

    const swept = await stallSweep(T1);
    expect(swept.error, JSON.stringify(swept)).toBeUndefined();
    const after = await get(id);
    expect(after.status).toBe("in_progress"); // the fence's own owner keeps the card
    expect(after.meta?.silence_hold?.reason).toBe("execution_wait");
    expect(Number(after.meta?.silence_hold?.since)).toBeGreaterThan(0);
    // the census settings row counts it
    const settings = await post("admin.settings_get");
    const raw = settings.settings?.["watchdog.stale_claims"];
    const census = typeof raw === "string" ? JSON.parse(raw) : raw;
    expect(census?.claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "execution_wait", cards: expect.any(Number) }),
    ]));
  });
});

// ---------- the scheduler's hold ages + the all-class pile alarm ----------

it("(4) a retry_budget hold carries its AGE on schedule_status and the pile alarm names the class", async () => {
  const host = `cl-gw-${++serial}`;
  const token = await post("admin.mint", { label: host, tags: ["gateway"] });
  const identity = await post("auth.identify", { bearer: token.secret });
  expect((await post("agent.provision", { label: `${host}/worker`, actor: host })).error).toBeUndefined();
  const auth = { actor: host, token_id: identity.token_id, gateway: true, agent: `${host}/worker`, session: `gw-${serial}` };
  const capabilities: Record<string, unknown> = { tier: "small", tools: ["git"], environment: ["linux"], backend: "opencode", model: "test/small", config_revision: "one", capacity: 4, projects: ["bridge"], worker: { kind: "provisioned", label: `${host}/worker` } };
  const cmd = (command: object, command_id = `cmd-${++serial}`, id = "gateway", session = auth.session) => post("execution", { ...auth, id, session, command_id, command });
  const reserve = async () => cmd({ kind: "schedule", mode: "reserve" });
  expect((await cmd({ kind: "advertise", capabilities })).ok).toBe(true);

  const created = await post("create", { actor: "author", type: "task", title: `claim-liveness budget specimen ${serial}`, body_md: "fixture", project: "bridge", qualified: true, roles: ["impl"] });
  expect(created.error, JSON.stringify(created)).toBeUndefined();
  const id = String(created.id);

  // charge the retry budget to exhaustion: three real failed attempts
  const outcome = { kind: "failed", exit_code: 1, stdout_tail: "partial", stderr_tail: "acp session/prompt failed: Authentication required: provider authentication required " };
  for (let generation = 1; generation <= 3; generation++) {
    const claim = await reserve();
    if (claim.kind !== "reserved") throw new Error(JSON.stringify(claim));
    const attempt_id = `failed-${generation}`, fence = { generation, attempt_id };
    expect((await cmd({ kind: "begin", attempt_id, worker: auth.agent, action_budget_ms: 60_000, selection: { backend: capabilities.backend, model: capabilities.model, tier: "small" } }, `begin-${generation}`, id, claim.session)).error).toBeUndefined();
    const stopped = { ...fence, writers: "process_group_empty", outcome };
    expect((await cmd({ kind: "stopped", ...stopped }, `stop-${generation}`, id, claim.session)).error).toBeUndefined();
    const final = await cmd({ kind: "finalize", ...stopped }, `final-${generation}`, id, claim.session);
    expect(final.error, JSON.stringify(final)).toBeUndefined();
    expect(final.budget_exhaustions).toBe(generation);
  }

  // the hold is real: no eligible work, one retry_budget-held card — and it
  // now carries its AGE
  const status = await cmd({ kind: "schedule_status", refresh: true, host });
  const mine = (status.hosts as Array<Record<string, any>>).find(h => h.host === host) ?? expect.fail("schedule_status must list the advertising host");
  expect(mine.reasons).toMatchObject({ retry_budget: 1 });
  expect(Number(mine.hold_oldest_ts?.retry_budget)).toBeGreaterThan(0);

  // backdate the hold past the stale-age knob (48h default) — the alarm must
  // fire on AGE alone (a hold with no age bound is silent starvation)
  await stub.fetch("https://kb/fixture/cl-backdate-status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, ts: Date.now() - 72 * 3_600_000 }) });
  await stub.fetch("https://kb/fixture/cl-alarm", { method: "POST" });
  const pile = await (await stub.fetch("https://kb/fixture/hold-pile-signals", { method: "POST" })).json() as { signal: Record<string, any> | null };
  expect(pile.signal, "the all-class hold-pile alarm must fire for a hold aged past the stale knob").toBeTruthy();
  const firedClass = (pile.signal.classes as Array<Record<string, any>>).find(c => c.reason === "retry_budget");
  expect(firedClass).toBeTruthy();
  expect(firedClass!.count).toBeGreaterThanOrEqual(1);
  expect(Number(firedClass!.oldest_hours)).toBeGreaterThanOrEqual(48);
  expect((firedClass!.sample as string[])).toContain(id);
});
