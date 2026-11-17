import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ARTEFACT_SEARCH_SCHEMA, ARTEFACT_SEARCH_LEGACY_TRIGGER_SQL, ARTEFACT_SEARCH_MIGRATION_SQL } from "../src/kb/artefact-search-schema";
import { LEDGER_LOOKUP_SCHEMA, RECENT_TASK_MUTATIONS_SQL, TASK_HISTORY_SQL, LAST_ACTOR_SIGNAL_SQL, LAST_NUDGE_SQL, RECENT_PROGRESS_SQL, STALL_SWEEP_PAGE_SQL, STALL_SESSION_PINGS_SQL, STALL_SESSION_LOOKUP_SCHEMA, BREACH_EVENTS_SQL, BREACH_CARDS_SQL, BREACH_CARD_LOOKUP_SCHEMA } from "../src/kb/ledger-query";

let mf: Miniflare;
let stub: { fetch(url: string, init: RequestInit): Promise<Response> };
async function query(sql: string, args: (string | number)[] = []) {
  const response = await stub.fetch("https://query/", { method: "POST", body: JSON.stringify({ sql, args }) });
  expect(response.status, await response.clone().text()).toBe(200);
  return await response.json() as { rows: Record<string, unknown>[]; reads: number; writes: number };
}
const probes = [
  { sql: RECENT_TASK_MUTATIONS_SQL, args: ["absent"] },
  { sql: TASK_HISTORY_SQL, args: ["absent", 20] },
  { sql: LAST_ACTOR_SIGNAL_SQL, args: ["absent", "worker"] },
  { sql: LAST_NUDGE_SQL, args: ["absent"] },
  { sql: RECENT_PROGRESS_SQL, args: [200_000] },
];
const before: Awaited<ReturnType<typeof query>>[] = [];
beforeAll(async () => {
  // Production SQL and DDL, on workerd's SQLite. No SQL endpoint exists in the
  // application; this isolated fixture exposes cursor row-read accounting.
  mf = new Miniflare({ modules: true, compatibilityDate: "2025-09-06", durableObjects: { QUERY: { className: "QueryRig", useSQLite: true } },
    script: `export class QueryRig { constructor(state){this.sql=state.storage.sql;}
      async fetch(request){const {sql,args}=await request.json();const cursor=this.sql.exec(sql,...args);const rows=cursor.toArray();return Response.json({rows,reads:cursor.rowsRead,writes:cursor.rowsWritten});}
    } export default {fetch(){return new Response('query fixture');}};` });
  const ns = await mf.getDurableObjectNamespace("QUERY");
  stub = await ns.get(ns.idFromName("retained-ledger")) as unknown as typeof stub;
  await query(`CREATE TABLE ledger(seq INTEGER PRIMARY KEY AUTOINCREMENT,ts INTEGER NOT NULL,actor TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'signal',action TEXT NOT NULL,artefact_id TEXT,summary TEXT NOT NULL DEFAULT '',data TEXT NOT NULL DEFAULT '{}');
    CREATE VIEW events AS SELECT seq,ts,actor,action AS op,artefact_id,data AS detail FROM ledger WHERE kind='signal';
    CREATE VIEW artefact_versions AS SELECT seq,ts,actor,action,artefact_id,summary,data FROM ledger WHERE kind='mutation';
    WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<100000)
      INSERT INTO ledger(ts,actor,kind,action,artefact_id) SELECT i,'other',CASE WHEN i%2=0 THEN 'mutation' ELSE 'signal' END,CASE WHEN i%3=0 THEN 'progress' ELSE 'other' END,'unrelated-'||i FROM n`);
  for (const probe of probes) before.push(await query(probe.sql, probe.args));
  await query(LEDGER_LOOKUP_SCHEMA);
}, 20_000);
afterAll(async () => { await mf?.dispose(); });

describe("canonical ledger lookups with retained unrelated receipts", () => {
  it("reproduces the old full scans and bounds empty card/window results without changing them", async () => {
    for (const [index, probe] of probes.entries()) {
      const after = await query(probe.sql, probe.args);
      expect(before[index].reads).toBeGreaterThanOrEqual(100_000);
      expect(after.rows).toEqual(before[index].rows);
      expect(after.reads).toBeLessThan(20);
    }
    console.log(JSON.stringify({ retained: 100_000, unindexed_reads: before.map(result => result.reads) }));
  });
  it("keeps history in sequence order, excludes signals and respects its exact limit", async () => {
    await query(`INSERT INTO ledger(ts,actor,kind,action,artefact_id,summary) VALUES
      (300,'worker','mutation','transition','history','first'),
      (100,'worker','mutation','progress','history','second'),
      (999,'worker','signal','transition','history','not a mutation'),
      (100,'other','mutation','transition','history','third')`);
    const recent = await query(RECENT_TASK_MUTATIONS_SQL, ["history"]);
    expect(recent.rows.map(row => row.summary)).toEqual(["third", "second", "first"]);
    expect(recent.reads).toBeLessThan(20);
    const history = await query(TASK_HISTORY_SQL, ["history", 2]);
    expect(history.rows.map(row => row.summary)).toEqual(["third", "second"]);
    expect(history.reads).toBeLessThan(20);
  });
  it("retains exact actor, signal-kind, nudge and timestamp predicates", async () => {
    await query(`INSERT INTO ledger(ts,actor,kind,action,artefact_id) VALUES
      (300,'worker','signal','progress','signals'),(900,'other','signal','progress','signals'),
      (999,'worker','mutation','progress','signals'),(400,'worker','signal','nudge','signals'),
      (200,'other','signal','nudge','signals'),(9999,'worker','signal','nudge','different')`);
    expect((await query(LAST_ACTOR_SIGNAL_SQL, ["signals", "worker"])).rows).toEqual([{ ts: 400 }]);
    expect((await query(LAST_ACTOR_SIGNAL_SQL, ["signals", "missing"])).rows).toEqual([{ ts: null }]);
    expect((await query(LAST_NUDGE_SQL, ["signals"])).rows).toEqual([{ ts: 400 }]);
  });
  it("preserves the inclusive progress window and index migration is idempotent without dropping receipts", async () => {
    await query(`INSERT INTO ledger(ts,actor,kind,action,artefact_id,data) VALUES
      (200000,'worker','mutation','progress','window','{"note":"at boundary"}'),
      (200001,'worker','mutation','progress','window','{"note":"newer"}'),
      (200002,'worker','signal','progress','window','{}'),
      (199999,'worker','mutation','progress','window','{}')`);
    const recent = await query(RECENT_PROGRESS_SQL, [200_000]);
    expect(recent.rows.map(row => JSON.parse(String(row.data)).note)).toEqual(["at boundary", "newer"]);
    expect(recent.reads).toBeLessThan(20);
    const count = await query(`SELECT COUNT(*) AS n FROM ledger`);
    await query(LEDGER_LOOKUP_SCHEMA);
    expect((await query(`SELECT COUNT(*) AS n FROM ledger`)).rows).toEqual(count.rows);
  });
});


it("reads only the named session and preserves all-session and worker-only signals", async () => {
  await query(`CREATE TABLE artefacts(id TEXT,type TEXT,status TEXT,owner TEXT,title TEXT,meta TEXT,status_ts INTEGER,created_ts INTEGER,updated_ts INTEGER);
    CREATE TABLE sessions(token_id TEXT,name TEXT,last_seen_ts INTEGER,kind TEXT,UNIQUE(token_id,name));
    WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<12000)
    INSERT INTO sessions SELECT 'token','unrelated-'||i,i,'worker' FROM n;
    INSERT INTO sessions VALUES
      ('agent','active',100,'agent'),('gateway','active',300,'gateway'),('legacy','active',200,NULL);`);
  const before = await query(STALL_SESSION_PINGS_SQL, ["active"]);
  await query(STALL_SESSION_LOOKUP_SCHEMA);
  const after = await query(STALL_SESSION_PINGS_SQL, ["active"]);
  expect(before.reads).toBeGreaterThan(12000);
  expect(after.rows).toEqual([{ seen: 300, worker_seen: 200 }]);
  expect(after.reads).toBeLessThan(10);
  expect((await query(STALL_SESSION_PINGS_SQL, ["missing"])).rows).toEqual([{ seen: null, worker_seen: null }]);
});

it("folds only this card's breach signals and finds closed and legacy breach cards by key", async () => {
  await query(`INSERT INTO ledger(ts,actor,kind,action,artefact_id) VALUES
    (300,'hub','signal','transition_rejected','BR#42'),(200,'hub','signal','replay_mismatch','BR#42'),
    (900,'hub','mutation','transition_rejected','BR#42'),(100,'hub','signal','transition_rejected','BR#42'),
    (900,'hub','signal','transition_rejected','BR#420');`);
  const events = await query(BREACH_EVENTS_SQL, ["BR#42", 100]);
  expect(events.rows.map(row => row.ts)).toEqual([300, 200]);
  expect(events.reads).toBeLessThan(20);
  await query(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<12000)
    INSERT INTO artefacts(id,type,status,meta,status_ts,created_ts)
      SELECT 'unrelated-'||i,'task','done',json_object('breach_key','other|'||i),0,0 FROM n;
    INSERT INTO artefacts(id,type,status,meta,status_ts,created_ts) VALUES ('legacy','task','done','{"breach_key":"BR#42|scope"}',0,0),
      ('open','task','todo','{"breach_key":"BR#42|state"}',0,0),('wrong','task','todo','{"breach_key":"BR#420|state"}',0,0);`);
  await query(BREACH_CARD_LOOKUP_SCHEMA);
  const cards = await query(BREACH_CARDS_SQL, ["BR#42|", "BR#42}"]);
  expect(cards.rows.map(row => row.id).sort()).toEqual(["legacy", "open"]);
  expect(cards.reads).toBeLessThan(10);
});


it("seeks only active rows, with a stable cursor and bounded pages", async () => {
  await query(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<12)
    INSERT INTO artefacts(id,type,status) SELECT 'running-'||i,'task','in_progress' FROM n`);
  const end = await query("SELECT MAX(rowid) AS cursor FROM artefacts");
  const limit = Number(end.rows[0].cursor);
  const first = await query(STALL_SWEEP_PAGE_SQL, [0, limit]);
  expect(first.rows.map(row => row.id)).toEqual(["running-1", "running-2", "running-3", "running-4"]);
  expect(first.reads).toBeLessThan(12);
  await query("UPDATE artefacts SET status='done' WHERE id='running-5'");
  const second = await query(STALL_SWEEP_PAGE_SQL, [Number(first.rows.at(-1)!.cursor), limit]);
  expect(second.rows.map(row => row.id)).toEqual(["running-6", "running-7", "running-8", "running-9"]);
  expect(second.reads).toBeLessThan(12);
});


it("migrates the old FTS trigger and indexes only effective title or body changes", async () => {
  await query(`ALTER TABLE artefacts ADD COLUMN body_md TEXT DEFAULT '';`);
  await query(ARTEFACT_SEARCH_SCHEMA);
  await query(`DROP TRIGGER artefacts_au; CREATE TRIGGER artefacts_au AFTER UPDATE ON artefacts BEGIN
    INSERT INTO artefacts_fts(artefacts_fts,rowid,title,body_md) VALUES('delete',old.rowid,old.title,old.body_md);
    INSERT INTO artefacts_fts(rowid,title,body_md) VALUES(new.rowid,new.title,new.body_md);
  END;
  INSERT INTO artefacts(id,type,status,title,body_md,meta) VALUES
    ('fts-fixture','task','todo','original title','original body','{}');`);
  const old = await query(`UPDATE artefacts SET meta='{"heartbeat":1}' WHERE id='fts-fixture'`);
  expect((await query(ARTEFACT_SEARCH_LEGACY_TRIGGER_SQL)).rows).toHaveLength(1);
  await query(ARTEFACT_SEARCH_MIGRATION_SQL);
  await query(ARTEFACT_SEARCH_SCHEMA);
  expect((await query(ARTEFACT_SEARCH_LEGACY_TRIGGER_SQL)).rows).toHaveLength(0);
  expect((await query(`UPDATE artefacts SET meta='{"heartbeat":2}' WHERE id='fts-fixture'`)).writes).toBe(1);
  expect(old.writes).toBeGreaterThan(1);
  expect((await query(`UPDATE artefacts SET title=title,body_md=body_md WHERE id='fts-fixture'`)).writes).toBe(1);
  const search = (term: string) => query("SELECT rowid FROM artefacts_fts WHERE artefacts_fts MATCH ?", [term]);
  expect((await search("original")).rows).toHaveLength(1);
  await query(`UPDATE artefacts SET title='replacement',body_md='new passage' WHERE id='fts-fixture'`);
  expect((await search("original")).rows).toEqual([]);
  expect((await search("replacement")).rows).toHaveLength(1);
  expect((await search("passage")).rows).toHaveLength(1);
  await query(`DELETE FROM artefacts WHERE id='fts-fixture'`);
  expect((await search("replacement")).rows).toEqual([]);
});
