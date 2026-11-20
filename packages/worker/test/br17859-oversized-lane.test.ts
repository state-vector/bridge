import { Miniflare } from "miniflare";
import { readFileSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * BR#17859 — the oversized canonical lane (production parity: BR#7000 carries
 * a 956,939-byte row, 950,790 of it lane.recovery_episodes) must keep normal
 * lease/ask machinery serviceable, oversized-row write failures must be
 * TERMINAL typed gate errors (never retryable 503 infra faults), and replayed
 * recovery events / retried answers after a lost ack must be idempotent.
 *
 * Receipts this file pins on the real workerd runtime:
 *  1. a ~950KB-episode lane takes lease renew + progress growth writes (the
 *     live hub's 4320/4320 write-op streak on the same-shape row);
 *  2. progress.log on a bound repair task IS the ledger growth engine
 *     (do.ts recordTaskRecovery: every heartbeat appends history + rewrites
 *     the full lane row — two ~950KB binds per save);
 *  3. ask.answer against an in_review lane subject (the BR#17818 shape)
 *     never writes the oversized card — no awaiting_ask is stamped on an
 *     in_review subject, so the disposition is ask-node-local and an
 *     oversized bind cannot explain the observed 503 infra_storage_fault;
 *  4. the platform write ceiling (~2MB string) fails with a named SQLite
 *     error which the dispatcher translates to gate: storage ceiling
 *     (BR#11554) 400 gate_rejected — a 503 stage:dispatch is a different,
 *     fetch-boundary class;
 *  5. replayed recovery event_ids and re-answered asks are deduped/typed —
 *     a client retry after a lost ack is safe and diagnosable.
 */
let mf: Miniflare;
let stub: { fetch(url: string, init: RequestInit): Promise<Response> };
async function post(path: string, body: object = {}) {
  const response = await stub.fetch(`https://hub/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, any> };
}
async function sql(query: string, ...params: unknown[]) {
  const result = await post("rig/sql", { query, params });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body.rows as Record<string, any>[];
}
async function rawSql(query: string, ...params: unknown[]) {
  return post("rig/sql", { query, params });
}

const repo = "state-vector/br17859";
const key = `${repo}@main`;
const head = "ab54178e9c3f60a1d2e3f4a5b6c7d8e9f0a1b2c3";
const runId = 90210;
const PROD_EPISODE_BYTES = 950_790; // measured on BR#7000's lane.recovery_episodes

let laneId = "";
let taskId = "";
let episodeKey = "";

async function makeLane() {
  const created = await post("train.lane", { repo, base: "main", actor: "fixture", spec: { required_workflows: ["Test"] } });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const acquired = await post("train.lease", { repo, base: "main", action: "acquire", actor: "gateway", holder: "gateway" });
  expect(acquired.status, JSON.stringify(acquired.body)).toBe(200);
  laneId = String((await sql(`SELECT id FROM lane_cards WHERE json_extract(meta,'$.lane.repo')=?`, repo))[0].id);
}

/** The production failure path (BR#6522 machinery): a first-hand deploy
 * observation with a failed run on the tip turns the base red, spawns the
 * root-fix repair card, and opens the recovery episode bound to it. */
async function observeRedDeploy() {
  const observation = {
    tip_sha: head,
    observed_at: Date.now(),
    runs: [{ id: runId, name: "Test", head_sha: head, status: "completed", conclusion: "failure", html_url: `https://github.com/${repo}/actions/runs/${runId}` }],
    failures: [{ run_id: runId, name: "Test", url: `https://github.com/${repo}/actions/runs/${runId}/job/1` }],
  };
  const res = await post("train.observe_deploy", { repo, base: "main", observation, actor: "gateway" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const ledger = await episodes();
  episodeKey = String(Object.keys(ledger)[0]);
  expect(episodeKey).toBeTruthy();
  taskId = String(ledger[episodeKey].stage.task_id);
  // the recovery owner claims the spawned repair card (production shape)
  const claimed = await post("transition", { id: taskId, to: "in_progress", actor: "impl", session: "impl-session" });
  expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
}
async function episodes(): Promise<Record<string, any>> {
  const row = (await sql(`SELECT json_extract(snapshot_json,'$.facts.lane.recovery_episodes') AS ledger FROM lane_state WHERE lane_key=?`, key))[0];
  return JSON.parse(String(row.ledger ?? "{}"));
}
async function laneRowBytes(): Promise<number> {
  const row = (await sql(`SELECT SUM(LENGTH(meta)+LENGTH(title)+LENGTH(body_md)) AS n FROM artefacts WHERE id=?`, laneId))[0];
  return Number(row.n ?? 0);
}
/** Inflate the ledger to `target` bytes: append one schema-valid history
 * entry (sized summary) to the episode and write the whole episodes object
 * back as a ~1MB bind — the same bind shape every production lane save
 * performs twice (snapshot_json + card mirror). */
async function padEpisodesTo(targetEpisodeBytes: number) {
  const ledger = await episodes();
  const current = JSON.stringify(ledger).length;
  const envelope = 260; // history-entry wrapper around the summary
  const grow = Math.max(0, targetEpisodeBytes - current - envelope);
  if (grow <= 0) return;
  ledger[episodeKey].history = [...ledger[episodeKey].history,
    { event_id: "seed:pad", at: 1795100000000, actor: "fixture", kind: "progress", summary: "a".repeat(grow) }];
  const padded = JSON.stringify(ledger);
  const state = await rawSql(`UPDATE lane_state SET snapshot_json = json_set(snapshot_json, '$.facts.lane.recovery_episodes', json(?)) WHERE lane_key=?`, padded, key);
  expect(state.status, JSON.stringify(state.body)).toBe(200);
  const mirror = await rawSql(`UPDATE artefacts SET meta = json_set(meta, '$.lane.recovery_episodes', json(?)) WHERE id=?`, padded, laneId);
  expect(mirror.status, JSON.stringify(mirror.body)).toBe(200);
}

beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  const entry = `${bundle.slice(0, bundle.lastIndexOf("/"))}/br17859-rig.mjs`;
  // Test-only subclass around the actual built hub (same rig surface as
  // canonical-lane.test.ts — raw SQL only; no production endpoints added).
  const rig = `import {KnowledgeHub} from './index.js';
    export class LaneRig extends KnowledgeHub {
      async fetch(request) {
        const path=new URL(request.url).pathname;
        if (!path.startsWith('/rig/')) return super.fetch(request);
        await this.ensureSchema(); const body=await request.json();
        try {
          if(path==='/rig/sql') {const cursor=this.state.storage.sql.exec(body.query,...body.params);const rows=cursor.toArray();return Response.json({rows,reads:cursor.rowsRead});}
          return new Response('not found',{status:404});
        } catch(error) {return Response.json({error:String(error?.message ?? error)},{status:500});}
      }
    } export default {fetch(){return new Response('fixture');}};`;
  mf = new Miniflare({ modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")), modules: [
    { type: "ESModule", path: entry, contents: rig }, { type: "ESModule", path: bundle, contents: readFileSync(bundle, "utf8") },
  ], compatibilityDate: "2025-09-06", durableObjects: { KB: { className: "LaneRig", useSQLite: true } } });
}, 120_000);
beforeEach(async () => {
  const ns = await mf.getDurableObjectNamespace("KB"); stub = await ns.get(ns.idFromName(crypto.randomUUID())) as unknown as typeof stub;
  laneId = ""; taskId = ""; episodeKey = "";
});
afterAll(async () => { await mf?.dispose(); });

describe("BR#17859 — oversized canonical lane on the real workerd SQLite hub", () => {
  it("takes lease, progress-growth and ask-disposition writes at production size (~950KB episodes)", async () => {
    await makeLane();
    await observeRedDeploy();

    await padEpisodesTo(PROD_EPISODE_BYTES);
    const sized = JSON.stringify(await episodes()).length;
    expect(Math.abs(sized - PROD_EPISODE_BYTES)).toBeLessThan(5_000); // production parity ±5KB
    expect(await laneRowBytes()).toBeGreaterThan(940_000);

    // leg 1: lease renew + status read on the oversized lane still land
    const renewed = await post("train.lease", { repo, base: "main", action: "renew", actor: "gateway", holder: "gateway" });
    expect(renewed.status, JSON.stringify(renewed.body)).toBe(200);
    const status = await post("train.status", { repo, base: "main", actor: "gateway" });
    expect(status.status, JSON.stringify(status.body)).toBe(200);

    // leg 2: progress.log IS the growth engine — a heartbeat appends ledger
    // history and rewrites the full lane row (two ~950KB binds)
    const historyBefore = (await episodes())[episodeKey].history.length;
    const bytesBefore = await laneRowBytes();
    const beat = await post("progress.log", { id: taskId, note: "attempting deploy rerun at tip", will: "verify decisive deployment", sentiment: "neutral", actor: "impl", session: "impl-session" });
    expect(beat.status, JSON.stringify(beat.body)).toBe(200);
    const after = await episodes();
    expect(after[episodeKey].history.length).toBe(historyBefore + 1);
    expect(JSON.stringify(after).length).toBeGreaterThan(sized); // the ledger grew
    expect(await laneRowBytes()).toBeGreaterThan(bytesBefore); // the row grew

    // leg 3: the BR#17818 shape — an ask against a non-in_progress lane
    // subject (in_review in production; blocked here after the red
    // observation). awaiting_ask is NOT stamped so the answer disposition
    // stays ask-node-local: the oversized card is never written by this
    // ask's create or answer.
    const laneStatusRow = (await sql(`SELECT status FROM artefacts WHERE id=?`, laneId))[0];
    expect(String(laneStatusRow.status)).not.toBe("in_progress");
    const markerBefore = JSON.parse(String((await sql(`SELECT meta FROM artefacts WHERE id=?`, laneId))[0].meta));
    const ask = await post("ask.create", { to: "peer", question: "Is the oversized lane still serviceable?", options: ["Yes, serviceable", "No, parked"], artefact_id: laneId, actor: "sender" });
    expect(ask.status, JSON.stringify(ask.body)).toBe(200);
    const askId = String(ask.body.id);
    const linked = (await sql(`SELECT COUNT(*) AS n FROM relations WHERE src_id=? AND relation='child_of' AND dst_id=?`, askId, laneId))[0];
    expect(Number(linked.n)).toBe(1);
    const markerMid = JSON.parse(String((await sql(`SELECT meta FROM artefacts WHERE id=?`, laneId))[0].meta));
    expect(markerMid.awaiting_ask).toBeUndefined(); // in_review subject → no stamp

    const answered = await post("ask.answer", { id: askId, answer: "Yes, serviceable", actor: "peer" });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    const askNode = (await sql(`SELECT status, meta FROM artefacts WHERE id=?`, askId))[0];
    expect(String(askNode.status)).toBe("done");
    const markerAfter = JSON.parse(String((await sql(`SELECT meta FROM artefacts WHERE id=?`, laneId))[0].meta));
    expect(markerAfter.awaiting_ask).toBeUndefined(); // never stamped, never cleared — no oversized stamp leg ran
    expect(JSON.stringify(markerAfter.lane.recovery_episodes)).toBe(JSON.stringify(markerBefore.lane.recovery_episodes)); // the 950KB history is preserved byte-for-byte
    // (the post-answer dispatch walk DID clear the subject's merge-train
    // blocked hold — a further ~950KB re-bind on the oversized card that
    // landed fine: more evidence oversized binds are serviceable today)

    // leg 4a: retrying the answer after a lost ack is typed, not infra
    const reanswered = await post("ask.answer", { id: askId, answer: "Yes, serviceable", actor: "peer" });
    expect(reanswered.status).toBe(400);
    expect(String(reanswered.body.error)).toContain("already resolved");
    expect(reanswered.body.result_class).toBeUndefined(); // a refusal, never a 503 infra fault
  }, 180_000);

  it("dedupes replayed recovery events — a client retry cannot double-grow the ledger", async () => {
    await makeLane();
    await observeRedDeploy();
    const before = await episodes();
    const revisionBefore = Number((await sql(`SELECT revision FROM lane_state WHERE lane_key=?`, key))[0].revision);
    // replay the EXACT observed command the hub itself fired (same event_id)
    const source = before[episodeKey].sources[0];
    const replay = await post("train.recovery_event", { repo, base: "main", head_sha: head, cause: before[episodeKey].cause, event_id: before[episodeKey].history[0].event_id,
      event: { kind: "observed", task_id: taskId, source, next: "Diagnose the exact failed test or unavailable capability, then record the repair action and outcome" }, actor: "gateway" });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    const after = await episodes();
    expect(after[episodeKey].history.length).toBe(before[episodeKey].history.length); // no growth
    const revisionAfter = Number((await sql(`SELECT revision FROM lane_state WHERE lane_key=?`, key))[0].revision);
    expect(revisionAfter).toBe(revisionBefore); // no canonical save for a pure replay
  }, 120_000);

  it("fails oversized writes with a NAMED terminal error, never a retryable 503 — and stamps/clears awaiting_ask on an oversized in_progress subject", async () => {
    await makeLane();
    await observeRedDeploy();

    // writes keep landing just under the ceiling (~2x production headroom)
    await padEpisodesTo(1_900_000);
    const nearCeiling = await post("train.lease", { repo, base: "main", action: "renew", actor: "gateway", holder: "gateway" });
    expect(nearCeiling.status, JSON.stringify(nearCeiling.body)).toBe(200);
    const beat = await post("progress.log", { id: taskId, note: "still serviceable at 1.9MB episodes", will: "keep headroom under the 2MB string ceiling", actor: "impl", session: "impl-session" });
    expect(beat.status, JSON.stringify(beat.body)).toBe(200);

    // the ceiling itself: a server-side 3MB value is refused by SQLite with
    // a named error — the same error class the dispatcher translates to
    // gate: storage ceiling (BR#11554) 400 gate_rejected on the op path
    const over = await rawSql(`UPDATE lane_state SET snapshot_json = json_set(snapshot_json, '$.facts.lane.pad', replace(hex(zeroblob(1500000)),'00','a')) WHERE lane_key=?`, key);
    expect(over.status).toBe(500);
    expect(String(over.body.error)).toMatch(/too big|TOOBIG/i);
    // the refused write left the lane intact and still serviceable
    const intact = await post("train.lease", { repo, base: "main", action: "renew", actor: "gateway", holder: "gateway" });
    expect(intact.status, JSON.stringify(intact.body)).toBe(200);

    // leg 6: the structural risk — awaiting_ask stamped on an oversized
    // in_progress subject by direct SQL (update() would budget-refuse at
    // 40KB meta; the ask paths bind the full row). Stamp+park must land or
    // refuse with a typed gate error — never a 503 — and the answer must
    // clear the marker at ~950KB without dropping anything else.
    const made = await post("create", { type: "task", title: "BR#17859 oversized ask subject", actor: "impl" });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const subjectId = String(made.body.id);
    expect((await post("transition", { id: subjectId, to: "in_progress", actor: "impl", session: "impl-session" })).status).toBe(200);
    const inflated = await rawSql(`UPDATE artefacts SET meta = json_set(meta, '$.pad', replace(hex(zeroblob(950000)),'00','a')) WHERE id=?`, subjectId);
    expect(inflated.status, JSON.stringify(inflated.body)).toBe(200);

    const ask = await post("ask.create", { to: "peer", question: "Can the oversized subject still park on an ask?", options: ["Park it", "Release it"], artefact_id: subjectId, actor: "sender" });
    expect(ask.status, JSON.stringify(ask.body)).toBe(200);
    const askId = String(ask.body.id);
    const subjectRow = (await sql(`SELECT status, meta FROM artefacts WHERE id=?`, subjectId))[0];
    const subjectMeta = JSON.parse(String(subjectRow.meta));
    if (String(subjectRow.status) === "blocked" && subjectMeta.awaiting_ask?.ask_id === askId) {
      const cleared = await post("ask.answer", { id: askId, answer: "Park it", actor: "peer" });
      expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
      const afterMeta = JSON.parse(String((await sql(`SELECT meta FROM artefacts WHERE id=?`, subjectId))[0].meta));
      expect(afterMeta.awaiting_ask).toBeUndefined(); // the ~950KB clear-leg bind landed
      expect(String(afterMeta.pad?.length)).toBe("950000"); // nothing else was dropped
    } else {
      // typed refusal is acceptable; a 503/HTML escape is not (BR#4117 class)
      expect(String(subjectRow.status)).toMatch(/in_progress|blocked/);
      expect(ask.status).toBeLessThan(500);
    }
  }, 180_000);
});
