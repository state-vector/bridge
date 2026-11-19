import { TRAIN_REVIEW_CHILDREN_SQL } from "../src/kb/train-read-query";
import { Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";
import { SCOPED_ROLE_EVIDENCE_SQL, SCOPED_DECISION_EVIDENCE_SQL, SCOPED_OPEN_ASKS_SQL } from "../src/kb/qualification-query";

describe("qualification joins with retained historical work", () => {
  it("seeks only selected parents even when a status index tempts a historical-card join", async () => {
    const mf = new Miniflare({ modules: true, compatibilityDate: "2025-09-06", durableObjects: { Q: { className: "Rig", useSQLite: true } },
      script: `export class Rig { constructor(state){this.sql=state.storage.sql;} async fetch(request){const {sql,args}=await request.json();const c=this.sql.exec(sql,...(args||[]));const rows=c.toArray();return Response.json({rows,reads:c.rowsRead});}} export default {fetch(){return new Response('rig')}}` });
    try {
      const ns=await mf.getDurableObjectNamespace("Q"), stub=await ns.get(ns.idFromName("history")) as unknown as {fetch(url:string,init:RequestInit):Promise<Response>};
      const query=async (sql:string,args:string[]=[])=>{
        const r=await stub.fetch("https://rig/",{method:"POST",body:JSON.stringify({sql,args})});
        expect(r.status,await r.clone().text()).toBe(200);
        return await r.json() as {rows:Record<string,unknown>[];reads:number};
      };
      await query(`CREATE TABLE artefacts(id TEXT PRIMARY KEY,type TEXT,status TEXT,roles TEXT,meta TEXT);
        CREATE TABLE relations(src_id TEXT,relation TEXT,dst_id TEXT,PRIMARY KEY(src_id,relation,dst_id));
        CREATE INDEX idx_relations_incoming ON relations(dst_id,relation,src_id);
        CREATE INDEX idx_status ON artefacts(status);
        CREATE INDEX idx_type_status ON artefacts(type,status);
        WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<10000)
          INSERT INTO artefacts SELECT 'old-'||i,'task','done','["review"]','{}' FROM n;
        INSERT INTO relations SELECT id,'child_of','unrelated' FROM artefacts;
        INSERT INTO artefacts VALUES ('review','task','done','["review"]','{}'),('analysis','task','done','["analysis"]','{}'),
          ('pending','task','in_progress','["review"]','{}'),('decision','decision','accepted','[]','{}'),
          ('ask','question','todo','[]','{"ask":{"to":"human"}}'),('closed-ask','question','done','[]','{"ask":{}}');
        INSERT INTO relations VALUES('review','child_of','selected'),('analysis','child_of','selected'),('pending','child_of','selected'),
          ('decision','supports','selected'),('ask','child_of','selected'),('closed-ask','child_of','selected');`);
      const args=[JSON.stringify(["selected"])];
      const original=await query(`SELECT r.dst_id AS pid,c.roles FROM relations r JOIN artefacts c ON c.id=r.src_id
        WHERE r.relation='child_of' AND c.status='done' AND r.dst_id IN (SELECT value FROM json_each(?))`,args);
      const roles=await query(SCOPED_ROLE_EVIDENCE_SQL,args);
      expect(roles.rows.map(r=>String(r.roles)).sort()).toEqual(original.rows.map(r=>String(r.roles)).sort());
      expect(original.reads).toBeGreaterThan(10000);
      expect(roles.reads).toBeLessThan(40);
      expect((await query(SCOPED_DECISION_EVIDENCE_SQL,args)).rows).toEqual([{tid:"selected"}]);
      expect((await query(SCOPED_OPEN_ASKS_SQL,args)).rows).toEqual([{pid:"selected"}]);
      expect((await query(SCOPED_ROLE_EVIDENCE_SQL,['[]'])).reads).toBeLessThan(5);
      await query(`ALTER TABLE artefacts ADD COLUMN body_md TEXT DEFAULT ''; ALTER TABLE artefacts ADD COLUMN updated_ts INTEGER DEFAULT 0;
        ALTER TABLE artefacts ADD COLUMN created_ts INTEGER DEFAULT 0; UPDATE artefacts SET created_ts=10 WHERE id='pending';`);
      // Emulate the historical-task-first plan observed on production, whose
      // statistics differ from this freshly created fixture's defaults.
      const historicalFirst=await query(`SELECT a.id FROM artefacts a INDEXED BY idx_type_status
        CROSS JOIN relations rel ON a.id=rel.src_id WHERE rel.relation='child_of' AND rel.dst_id=?
        AND a.type='task' AND a.roles LIKE '%"review"%' ORDER BY a.created_ts DESC`,["selected"]);
      const train=await query(TRAIN_REVIEW_CHILDREN_SQL,["selected"]);
      expect(train.rows.map(r=>r.id)).toEqual(historicalFirst.rows.map(r=>r.id));
      expect(train.rows.map(r=>r.id)).toEqual(["pending","review"]);
      expect(historicalFirst.reads).toBeGreaterThan(10000);
      expect(train.reads).toBeLessThan(40);
      const empty=await query(TRAIN_REVIEW_CHILDREN_SQL,["absent"]);
      expect(empty.rows).toEqual([]);expect(empty.reads).toBeLessThan(5);
      const plan=await query("EXPLAIN QUERY PLAN "+TRAIN_REVIEW_CHILDREN_SQL,["selected"]);
      expect(String(plan.rows[0].detail)).toContain("idx_relations_incoming");
      console.log(JSON.stringify({retained:10000,old_reads:original.reads,new_reads:roles.reads,old_train_reads:historicalFirst.reads,new_train_reads:train.reads}));
    } finally {await mf.dispose();}
  });
});
