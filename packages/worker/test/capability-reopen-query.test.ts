import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPABILITY_WAIT_INDEX_SCHEMA, CAPABILITY_WAIT_REOPEN_PAGE, CAPABILITY_WAIT_REOPEN_SQL } from "../src/kb/execution-work";

let mf: Miniflare;
let stub: { fetch(url: string, init: RequestInit): Promise<Response> };
interface ReopenRow { id: string; sweep_cursor: number }
async function query(sql: string, args: (string | number)[] = []) {
  const response = await stub.fetch("https://query/", { method: "POST", body: JSON.stringify({ sql, args }) });
  expect(response.status, await response.clone().text()).toBe(200);
  return await response.json() as { rows: ReopenRow[]; reads: number };
}
const wait = (id: string, created: number, owner = "") => query(
  `INSERT INTO artefacts(id,type,title,body_md,project,roles,status,owner,meta,updated_ts) VALUES(?,'task',?,'body','bridge','[]','blocked',?,json_object('execution_wait',json_object('kind','capability'),'blocked',json_object('await_event',json_object('event','executor_capability'),'id',?),'execution_requirements',json_object('tier','small','tools',json_array('aws'),'environment',json_array())),?)`,
  [id, `wait ${id}`, owner, id, created]);
/** BR#23279 — the SECOND historical park shape: a typed executor_capability
 *  await_event with NO execution_wait marker (the legacy agent-authored park
 *  the old grammar accepted). The reopen drain must page BOTH shapes, and
 *  the await_event-keyed index must serve them without a board scan. */
const legacy = (id: string, created: number, owner = "") => query(
  `INSERT INTO artefacts(id,type,title,body_md,project,roles,status,owner,meta,updated_ts) VALUES(?,'task',?,'body','bridge','[]','blocked',?,json_object('blocked',json_object('await_event',json_object('event','executor_capability'),'id',?),'execution_requirements',json_object('tier','small','tools',json_array('aws'),'environment',json_array())),?)`,
  [id, `legacy ${id}`, owner, id, created]);

beforeAll(async () => {
  // Exact production reopen SQL and the narrow partial index, executed by
  // workerd's real SQLite over a retained-scale backlog. No admin SQL route
  // or test instrumentation is added to the deployed hub.
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
  stub = await ns.get(ns.idFromName("reopen-backlog")) as unknown as typeof stub;
  await query(`CREATE TABLE artefacts(id TEXT PRIMARY KEY,type TEXT,title TEXT,body_md TEXT,project TEXT,roles TEXT,status TEXT,owner TEXT,meta TEXT,updated_ts INTEGER);
    CREATE TABLE execution_hosts(token_id TEXT PRIMARY KEY);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);`);
  await query(CAPABILITY_WAIT_INDEX_SCHEMA);
  // 12,000 retained rows that must never be touched by the reopen seek:
  // unowned todo work with requirements (the board's plausible bulk), done
  // history, and blocked rows held by an owner.
  await query(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<6000)
    INSERT INTO artefacts SELECT 'todo-'||i,'task','t'||i,'body','bridge','[]','todo','',json_object('execution_requirements',json_object('tier','small','tools',json_array('git'),'environment',json_array())),i FROM n`);
  await query(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<6000)
    INSERT INTO artefacts SELECT 'done-'||i,'task','t'||i,'body','bridge','[]','done','',json_object('execution_requirements',json_object('tier','small','tools',json_array('git'),'environment',json_array())),i FROM n`);
  await query(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<200)
    INSERT INTO artefacts SELECT 'owned-'||i,'task','t'||i,'body','bridge','[]','blocked','someone',json_object('execution_wait',json_object('kind','capability'),'blocked',json_object('await_event',json_object('event','executor_capability'),'id','owned-'||i),'execution_requirements',json_object('tier','small','tools',json_array('aws'),'environment',json_array())),i FROM n`);
  for (let i = 0; i < 30; i++) await wait(`wait-${i}`, 1000 + i);
  // Legacy-shape parks sit AFTER the marker-pair rows in rowid order, so the
  // paged cursor must cross from one shape into the other seamlessly.
  for (let i = 0; i < 5; i++) await legacy(`legacy-${i}`, 2000 + i);
});

afterAll(async () => { await mf?.dispose(); });

describe("bounded capability-wait reopen on a retained SQLite backlog", () => {
  it("seeks only matching capability waits over 12,000 retained rows", async () => {
    const page = await query(CAPABILITY_WAIT_REOPEN_SQL, [0]);
    expect(page.rows).toHaveLength(CAPABILITY_WAIT_REOPEN_PAGE);
    expect(page.rows.map(r => r.id)).toEqual(Array.from({ length: CAPABILITY_WAIT_REOPEN_PAGE }, (_, i) => `wait-${i}`));
    expect(page.reads).toBeLessThan(100);
    const next = await query(CAPABILITY_WAIT_REOPEN_SQL, [page.rows.at(-1)!.sweep_cursor]);
    // The cursor crosses from the marker-pair shape into the legacy
    // no-execution_wait shape — both drain through the same page.
    expect(next.rows.map(r => r.id)).toEqual([
      ...Array.from({ length: 5 }, (_, i) => `wait-${25 + i}`),
      ...Array.from({ length: 5 }, (_, i) => `legacy-${i}`),
    ]);
    expect(next.reads).toBeLessThan(100);
  });
  it("pays nothing beyond the seek when the cursor sits past every matching row", async () => {
    const past = await query(`SELECT rowid AS sweep_cursor,id FROM artefacts WHERE id='legacy-4'`);
    const empty = await query(CAPABILITY_WAIT_REOPEN_SQL, [past.rows[0].sweep_cursor]);
    expect(empty.rows).toEqual([]);
    expect(empty.reads).toBeLessThan(100);
  });
});
