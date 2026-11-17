import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CURRENT_REVIEW_SQL, REVIEW_LOOKUP_SCHEMA, REVIEW_RECONCILE_BATCH_SIZE, REVIEW_RECONCILE_BATCH_SQL, REVIEW_BACKFILL_BATCH_SQL, WATCHDOG_REVIEW_LOOKUP_SCHEMA, HELD_MERGE_ADMISSIONS_SQL, RETIRE_COORDINATION_SWEEP_SQL, RETIRE_COORDINATION_FOR_TASK_SQL } from "../src/kb/review-query";

let mf: Miniflare;
let stub: { fetch(url: string, init: RequestInit): Promise<Response> };
interface ReviewRow { id: string; status: string; meta: string; cursor: number }
async function query(sql: string, args: (string | number)[] = []) {
  const response = await stub.fetch("https://query/", { method: "POST", body: JSON.stringify({ sql, args }) });
  expect(response.status, await response.clone().text()).toBe(200);
  return await response.json() as { rows: ReviewRow[]; reads: number };
}
const current = (id = "parent") => query(CURRENT_REVIEW_SQL, [id, id]);
async function review(id: string, created: number, meta: object = {}, status = "done", type = "task", roles = '["review"]') {
  await query(`INSERT INTO artefacts(id,type,roles,status,meta,created_ts,status_ts) VALUES(?,?,?,?,?,?,?)`,
    [id, type, roles, status, JSON.stringify(meta), created, created]);
}
const child = (src: string, dst = "parent") => query(`INSERT INTO relations VALUES(?,'child_of',?)`, [src, dst]);
beforeAll(async () => {
  // Exact production SQL and indexes, executed by workerd's real SQLite. No
  // admin SQL route or test instrumentation is added to the deployed hub.
  mf = new Miniflare({ modules: true, compatibilityDate: "2025-09-06", durableObjects: { QUERY: { className: "QueryRig", useSQLite: true } },
    script: `export class QueryRig {
      constructor(state) { this.sql=state.storage.sql; }
      async fetch(request) {
        const {sql,args}=await request.json();
        const cursor=this.sql.exec(sql,...args), rows=cursor.toArray();
        return Response.json({rows,reads:cursor.rowsRead});
      }
    } export default { fetch() { return new Response('query rig'); } };` });
  const ns = await mf.getDurableObjectNamespace("QUERY");
  stub = await ns.get(ns.idFromName("retained-backlog")) as unknown as typeof stub;
  await query(`CREATE TABLE artefacts(id TEXT PRIMARY KEY,type TEXT,roles TEXT,status TEXT,meta TEXT,created_ts INTEGER,status_ts INTEGER);
    CREATE TABLE relations(src_id TEXT,relation TEXT,dst_id TEXT,PRIMARY KEY(src_id,relation,dst_id));
    CREATE TABLE delivery_admissions(review_id TEXT PRIMARY KEY,record TEXT);`);
  await query(REVIEW_LOOKUP_SCHEMA + WATCHDOG_REVIEW_LOOKUP_SCHEMA);
  await query(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<6000)
    INSERT INTO artefacts SELECT 'unrelated-'||i,'task','["review"]','done',json_object('execution_review_of','other-'||i),i,i FROM n`);
  await query(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<6000)
    INSERT INTO artefacts SELECT 'unrelated-legacy-'||i,'task','["review"]','done','{}',i,i FROM n;
    INSERT INTO relations SELECT id,'child_of','other' FROM artefacts WHERE id LIKE 'unrelated-legacy-%'`);
  await query(`INSERT INTO artefacts VALUES('parent','task','["impl"]','in_review','{}',0,0),('other','task','["impl"]','in_review','{}',0,0)`);
});
afterAll(async () => { await mf?.dispose(); });

describe("canonical review lookup with a retained SQLite backlog", () => {
  it("bounds background repair independently of 12,000 retained completed reviews", async () => {
    const page = await query(REVIEW_RECONCILE_BATCH_SQL, [0, REVIEW_RECONCILE_BATCH_SIZE]);
    expect(page.rows.map(r => r.id)).toEqual(["parent", "other"]);
    expect(page.reads).toBeLessThan(100);
    const historical = await query(REVIEW_BACKFILL_BATCH_SQL, [0, REVIEW_RECONCILE_BATCH_SIZE]);
    expect(historical.rows).toHaveLength(REVIEW_RECONCILE_BATCH_SIZE);
    expect(historical.reads).toBeLessThan(150);
    const next = await query(REVIEW_BACKFILL_BATCH_SQL, [historical.rows.at(-1)!.cursor, REVIEW_RECONCILE_BATCH_SIZE]);
    expect(next.rows).toHaveLength(REVIEW_RECONCILE_BATCH_SIZE);
    expect(next.rows.every(row => row.cursor > historical.rows.at(-1)!.cursor)).toBe(true);
    expect(next.reads).toBeLessThan(150);
  });
  it("does not scan unrelated review history to find no current round", async () => {
    const result = await current();
    expect(result.rows).toEqual([]);
    expect(result.reads).toBeLessThan(40);
  });
  it("finds a detached declared review without scanning the retained backlog", async () => {
    await review("declared", 10, { review_subject: { task_id: "parent", revision: "one" } });
    const result = await current();
    expect(result.rows[0].id).toBe("declared");
    expect(result.reads).toBeLessThan(40);
  });
  it("keeps newer pending and findings rounds ahead of old acceptance, with rowid tie-breaking", async () => {
    await review("pending", 11, { execution_review_of: "parent" }, "todo");
    expect((await current()).rows[0]).toMatchObject({ id: "pending", status: "todo" });
    await review("findings", 11, { review_result: { kind: "findings", task_id: "parent" } });
    expect((await current()).rows[0].id).toBe("findings");
  });
  it("keeps legacy single-task-parent reviews but never borrows an explicitly different or ambiguous subject", async () => {
    await review("legacy", 12);
    await child("legacy");
    expect((await current()).rows[0].id).toBe("legacy");
    await review("explicit-other", 13, { review_subject: { task_id: "other", revision: "one" }, execution_review_of: "parent" });
    await child("explicit-other");
    await review("ambiguous", 14);
    await child("ambiguous"); await child("ambiguous", "other");
    await review("superseded", 15, { execution_review_of: "parent" }, "superseded");
    await review("non-task", 16, { execution_review_of: "parent" }, "done", "decision");
    await review("non-review", 17, { execution_review_of: "parent" }, "done", "task", '["impl"]');
    const result = await current();
    expect(result.rows[0].id).toBe("legacy");
    expect(result.reads).toBeLessThan(100);
  });
  it("observes subject edits, relation deletion, and new rounds immediately rather than caching authority", async () => {
    await query(`UPDATE artefacts SET meta='{"execution_review_of":"other"}' WHERE id='legacy'`);
    expect((await current()).rows[0].id).toBe("findings");
    await query(`DELETE FROM relations WHERE src_id='ambiguous' AND dst_id='other'`);
    expect((await current()).rows[0].id).toBe("ambiguous");
    await review("newest", 18, { review_subject: { task_id: "parent", revision: "two" } }, "in_progress");
    expect((await current()).rows[0]).toMatchObject({ id: "newest", status: "in_progress" });
  });
});


describe("watchdog work with retained history", () => {
  it("finds only held admissions for matching active merge waits", async () => {
    await query(`INSERT INTO delivery_admissions
      SELECT id,json_object('task_id',id,'state',json_object('phase','held')) FROM artefacts WHERE id LIKE 'unrelated-%'`);
    await review("waiting", 30, { blocked: { await_event: { event: "pr_merged", repo: "owner/repo", n: 7 } } }, "blocked");
    for (const [id, phase, repo, number] of [
      ["matching", "held", "owner/repo", 7],
      ["wrong-phase", "pending", "owner/repo", 7],
      ["wrong-repo", "held", "other/repo", 7],
      ["wrong-number", "held", "owner/repo", 8],
    ]) await query("INSERT INTO delivery_admissions VALUES(?,?)", [id, JSON.stringify({
      task_id: "waiting", state: { phase }, legs: [{ repo, number }],
    })]);
    const result = await query(HELD_MERGE_ADMISSIONS_SQL);
    expect(result.rows).toEqual([{ cursor: null, review_id: "matching" }]);
    expect(result.reads).toBeLessThan(50);
  });

  it("targets a terminal task without scanning unrelated coordination", async () => {
    await review("finished-task", 31);
    await review("other-finished-task", 32, {}, "superseded");
    await review("linked-question", 33, {}, "todo", "question");
    await child("linked-question", "finished-task");
    await review("routed-question", 34, { ask: { route: { kind: "executor_coordination", task_id: "finished-task" } } }, "todo", "question");
    await review("other-question", 35, {}, "todo", "question");
    await child("other-question", "other-finished-task");
    const targeted = await query(RETIRE_COORDINATION_FOR_TASK_SQL, ["finished-task"]);
    expect(targeted.rows.map(row => row.id).sort()).toEqual(["linked-question", "routed-question"]);
    expect(targeted.reads).toBeLessThan(50);
    const sweep = await query(RETIRE_COORDINATION_SWEEP_SQL);
    expect(sweep.rows.map(row => row.id).sort()).toEqual(["linked-question", "other-question", "routed-question"]);
    expect(sweep.reads).toBeLessThan(50);
  });
});
