import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LEDGER_LOOKUP_SCHEMA, RECENT_TASK_MUTATIONS_SQL, TASK_HISTORY_SQL, LAST_ACTOR_SIGNAL_SQL, LAST_NUDGE_SQL, RECENT_PROGRESS_SQL } from "../src/kb/ledger-query";

let mf: Miniflare;
let stub: { fetch(url: string, init: RequestInit): Promise<Response> };
async function query(sql: string, args: (string | number)[] = []) {
  const response = await stub.fetch("https://query/", { method: "POST", body: JSON.stringify({ sql, args }) });
  expect(response.status, await response.clone().text()).toBe(200);
  return await response.json() as { rows: Record<string, unknown>[]; reads: number };
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
      async fetch(request){const {sql,args}=await request.json();const cursor=this.sql.exec(sql,...args);const rows=cursor.toArray();return Response.json({rows,reads:cursor.rowsRead});}
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
