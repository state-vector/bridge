import { Miniflare } from "miniflare";
import { readFileSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * BR#16950 / GH#471 — bisect the ~8.4s-CPU trainStatus recompute at
 * production scale, locally. Cody's live pprof (docs/incidents/
 * 2026-11-19-hub-performance) names trainStatus as the remaining hog after
 * the board fix; this fixture seeds a production-shaped corpus and runs the
 * six named SQL families standalone, each with its native rowsRead, so the
 * dominating family is attributed by NUMBER before anyone touches code.
 */

let mf: Miniflare;
let stub: { fetch(url: string, init: RequestInit): Promise<Response> };
async function post(path: string, body: object = {}) {
  const response = await stub.fetch(`https://hub/${path}`, {
    method: "POST", headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}
async function sql(query: string, ...params: unknown[]) {
  const result = await post("rig/sql", { query, params });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body as { rows: Record<string, any>[]; reads: number };
}

const repo = "state-vector/scale-lane";
const fat = (n: number) => JSON.stringify({ filler: "x".repeat(n) });

beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  const entry = `${bundle.slice(0, bundle.lastIndexOf("/"))}/train-scale-rig.mjs`;
  const rig = `import {KnowledgeHub} from './index.js';
    export class TrainScaleRig extends KnowledgeHub {
      async fetch(request) {
        const path=new URL(request.url).pathname;
        if (!path.startsWith('/rig/')) return super.fetch(request);
        await this.ensureSchema(); const body=await request.json();
        try {
          if(path==='/rig/sql') {try {const cursor=this.state.storage.sql.exec(body.query,...body.params);const rows=cursor.toArray();return Response.json({rows,reads:cursor.rowsRead});} catch(error){return Response.json({error:String(error),query:String(body.query).slice(0,240)},{status:500});}}
          return new Response('not found',{status:404});
        } catch(error) {return new Response(JSON.stringify({error:String(error)}),{status:500});}
      }
    } export default {fetch(){return new Response('fixture');}};`;
  mf = new Miniflare({ modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")), modules: [
    { type: "ESModule", path: entry, contents: rig }, { type: "ESModule", path: bundle, contents: readFileSync(bundle, "utf8") },
  ], compatibilityDate: "2025-09-06", durableObjects: { KB: { className: "TrainScaleRig", useSQLite: true } } });
  stub = (await mf.getDurableObjectNamespace("KB")).get((await mf.getDurableObjectNamespace("KB")).idFromName("global")) as any;
  await post("orient", { actor: "seed" });
}, 180_000);

afterAll(async () => { await mf?.dispose(); });

beforeAll(async () => {
  const step = async (n: string, fn: () => Promise<any>) => { try { const r = await fn(); console.log(`[seed] ${n} ok`); return r; } catch (e) { console.log(`[seed] ${n} FAILED: ${String(e).slice(0,200)}`); throw e; } };
  // one live lane (real lane card through the real ops)
  const created = await step("train.lane", () => post("train.lane", { repo, base: "main", actor: "fixture", spec: { required_workflows: ["Test"] } }))
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const laneCard = (await sql(`SELECT id FROM artefacts WHERE type='task' AND json_extract(meta,'$.lane.repo')=?`, repo)).rows[0].id;

  // production-shaped corpus (single CTE inserts — fast)
  await sql(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<14000)
    INSERT INTO artefacts(id,type,title,status,body_md,meta,owner,created_ts,updated_ts,status_ts,tags,roles,project,created_by)
    SELECT 'BR#'||(900000+i),'task','corpus done card '||i,'done','',:meta,'seed',1,1,1,'[]','[]','scale','seed' FROM n`
    .replace(":meta", "?"), fat(4000));
  // 5 queued train cars with fat metas
  for (let i = 1; i <= 5; i++) {
    await sql(`INSERT INTO artefacts(id,type,title,status,body_md,meta,owner,created_ts,updated_ts,status_ts,tags,roles,project,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      `BR#99000${i}`, "task", `queued car ${i}`, "blocked", "",
      JSON.stringify({ merge_train: { pr: 4000 + i, state: "queued", legs: {} }, blocked: { reason: "merge-train: queued", await_event: { event: "time", until_ts: 1 } }, filler: "x".repeat(28000) }),
      "seed", 1, 1, 1, "[]", "[]", "scale", "seed");
    await sql(`INSERT INTO relations(src_id,relation,dst_id,created_ts) VALUES(?,?,?,1)`, `BR#99000${i}`, "child_of", laneCard);
  }
  // 30 in_review with review children; 14 in_progress
  for (let i = 1; i <= 30; i++) {
    await sql(`INSERT INTO artefacts(id,type,title,status,body_md,meta,owner,created_ts,updated_ts,status_ts,tags,roles,project,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      `BR#92000${i}`, "task", `in review ${i}`, "in_review", "body ".repeat(400),
      JSON.stringify({ review_pr: { repo, number: 5000 + i, base: "main" }, filler: "x".repeat(9000) }),
      "seed", 1, 1, 1, "[]", "[]", "scale", "seed");
    await sql(`INSERT INTO artefacts(id,type,title,status,body_md,meta,owner,created_ts,updated_ts,status_ts,tags,roles,project,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      `BR#92500${i}`, "task", `Verify: in review ${i}`, "todo", "verify body ".repeat(100),
      JSON.stringify({ filler: "x".repeat(2000) }), "", 1, 1, 1, "[]", "[\"review\"]", "scale", "seed");
    await sql(`INSERT INTO relations(src_id,relation,dst_id,created_ts) VALUES(?,?,?,1)`, `BR#92500${i}`, "child_of", `BR#92000${i}`);
  }
  for (let i = 1; i <= 14; i++) {
    await sql(`INSERT INTO artefacts(id,type,title,status,body_md,meta,owner,created_ts,updated_ts,status_ts,tags,roles,project,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      `BR#93000${i}`, "task", `in progress ${i}`, "in_progress", "body ".repeat(300),
      JSON.stringify({ review_note: `closes #${6000 + i}`, filler: "x".repeat(8000), session: `sess-${i}` }),
      "seed", 1, 1, 1, "[]", "[]", "scale", "seed");
  }
  // per-lane tables at production volume
  await sql(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1500)
    INSERT INTO provenance(repo,pr,merge_sha,head_sha,task_id,verdict_id,session,signer,merged_at,stamped_at)
    SELECT ?,7000+i,lower(hex(randomblob(20))),lower(hex(randomblob(20))),NULL,NULL,'s','g',?+i,?+i FROM n`, repo, 1, 1);
  await sql(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<800)
    INSERT INTO train_events(repo,base,pr,task_id,kind,gateway,detail,ts)
    SELECT ?,'main',4000+(i%20),NULL, CASE WHEN i%3=0 THEN 'bounced' ELSE 'merged' END,'gw','{}',?+i*1000 FROM n`, repo, 1);
  await sql(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<2500)
    INSERT INTO proxy_probes(key,repo,kind,pr,card_id,state,updated_ts,created_ts,expected_head,ok)
    SELECT 'probe:'||?||'#'||i,?, CASE WHEN i%5=0 THEN 'pr_merged' ELSE 'run_success' END,i%700,'BR#1',
      CASE WHEN i%2=0 THEN 'verified' ELSE 'pending' END,?+i,?+i,NULL,1 FROM n`, repo, repo, 1, 1);
  await sql(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1200)
    INSERT INTO delivery_pr_outcomes(repo,pr,state,receipt,observed_at)
    SELECT ?,8000+i, CASE WHEN i%2=0 THEN 'MERGED' ELSE 'CLOSED' END,'r',?+i FROM n`, repo, 1);
  await sql(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<3000)
    INSERT INTO reconcile_seen(repo,pr,card,missing,updated_ts)
    SELECT ?,9000+i,'BR#1',0,?+i FROM n`, repo, 1);
  await sql(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<50)
    INSERT INTO reconcile_ignores(repo,pr,reason,by,created_ts) SELECT ?,9500+i,'scale','seed',1 FROM n`, repo);
  // realistic lane meta: queue_facts entries for ~10 PRs + base_state
  await sql(`UPDATE artefacts SET meta=json_set(meta,'$.lane.queue_facts', json(?)) WHERE id=?`,
    JSON.stringify({ at: Date.now() - 60_000, entries: Array.from({ length: 10 }, (_, i) => ({ id: `BR#99000${i + 1}`, pr: 4000 + i + 1, cls: "ready" })), base_state: { verdict: "green", tip_sha: "a".repeat(40), observed_at: Date.now() - 60_000 }, conflict_pairs: [] }),
    laneCard);
}, 300_000);

describe("trainStatus at production scale (BR#16950 / GH#471)", () => {
  it("recompute wall time is sane", async () => {
    const t0 = Date.now();
    const r = await post("train.status", { actor: "probe" });
    const ms = Date.now() - t0;
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    console.log(`[scale] trainStatus recompute: ${ms}ms`);
    expect(ms).toBeLessThan(4000); // production measured ~8.4s CPU; local is a lower bound
  });

  it("the six named SQL families — rowsRead attribution", async () => {    const families: Record<string, [string, unknown[]]> = {
      provenance: [`SELECT pr FROM provenance WHERE repo=?`, [repo]],
      merged_probes: [`SELECT pr FROM proxy_probes WHERE repo=? AND kind='pr_merged' AND state='verified' AND ok=1`, [repo]],
      terminal_outcomes: [`SELECT pr FROM delivery_pr_outcomes WHERE repo=? AND state IN ('MERGED','CLOSED')`, [repo]],
      ignored_prs: [`SELECT pr FROM reconcile_ignores WHERE repo=?`, [repo]],
      seen_prs: [`SELECT pr FROM reconcile_seen WHERE repo=? AND missing=0 ORDER BY pr ASC`, [repo]],
      review_children: [`SELECT a.id,a.status,a.body_md,a.meta,a.updated_ts FROM relations rel JOIN artefacts a ON a.id=rel.src_id WHERE rel.relation='child_of' AND rel.dst_id=? AND a.type='task' AND a.roles LIKE '%"review"%' ORDER BY a.created_ts DESC`, ["BR#920001"]],
      lane_cards: [`SELECT id,title,status,meta,status_ts,updated_ts,project FROM lane_cards WHERE json_extract(meta,'$.lane.key') IS NOT NULL ORDER BY title`, []],
      lane_cards_typed: [`SELECT id,title,status,meta,status_ts,updated_ts,project FROM lane_cards WHERE type='task' AND json_extract(meta,'$.lane.key') IS NOT NULL ORDER BY title`, []],
      queue_cars: [`SELECT id,status_ts,meta,tags FROM artefacts WHERE type='task' AND status='blocked' AND CAST(json_extract(meta,'$.merge_train.pr') AS INTEGER) > 0`, []],
      awaiting_census: [`SELECT id,meta FROM artefacts WHERE type='task' AND status IN ('todo','in_progress','in_review','blocked') AND json_extract(meta,'$.merge_train.state') IN ('bounced','awaiting')`, []],
      review_census: [`SELECT id,title,body_md,meta,roles,tags,status_ts FROM artefacts WHERE type='task' AND status='in_review' ORDER BY status_ts ASC`, []],
      progress_census: [`SELECT id,title,body_md,meta,roles,tags FROM artefacts WHERE type='task' AND status='in_progress'`, []],
      train_events_merge_stats: [`SELECT SUM(CASE WHEN ts > 1 THEN 1 ELSE 0 END) AS h1, MAX(ts) AS last FROM train_events WHERE kind='merged' AND repo=? AND base='main' AND COALESCE(json_extract(detail,'$.canary'),0)=0`, [repo]],
    };
    const lines: string[] = [];
    for (const [name, [q, p]] of Object.entries(families)) {
      const r = await sql(q, ...(p as unknown[]));
      lines.push(`[scale] ${name.padEnd(22)} rowsRead=${String(r.reads).padStart(7)} returned=${r.rows.length}`);
    }
    // attribute the lane_cards scan: plan + per-arm rowsRead
    const laneQ = families.lane_cards[0] as string;
    const plan = await sql(`EXPLAIN QUERY PLAN ${laneQ}`);
    lines.push(`[scale] lane_cards plan: ${plan.rows.map((r: any) => String(r.detail)).join(" | ")}`);
    const arm1 = await sql(`SELECT id FROM lane_state s JOIN artefacts a ON a.id=s.lane_id WHERE s.snapshot_json IS NOT NULL`);
    lines.push(`[scale] lane arm1 (state join) rowsRead=${arm1.reads} returned=${arm1.rows.length}`);
    const arm2 = await sql(`SELECT id FROM artefacts a INDEXED BY idx_artefacts_lane_key WHERE a.type='task' AND json_extract(a.meta,'$.lane.key') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM lane_state s WHERE s.lane_id=a.id AND s.snapshot_json IS NOT NULL)`);
    lines.push(`[scale] lane arm2 (pinned) rowsRead=${arm2.reads} returned=${arm2.rows.length}`);
    console.log(lines.join("\n"));
    // GH#471 pin: a lane read must never scan the corpus — the outer
    // type='task' predicate (dropped in code) pushed the view's first arm
    // into a (type=?) index walk of every task card: 14,098 rowsRead for
    // ONE lane at this fixture's scale, multiples of that in production.
    const laneReads = Number((lines.find((l) => l.includes("lane_cards ")) ?? "").match(/rowsRead=\s*(\d+)/)?.[1] ?? 0);
    expect(laneReads).toBeLessThan(100);
    expect(true).toBe(true);
  });
});
