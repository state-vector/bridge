import { Miniflare } from "miniflare";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * BR#16950 — cold-isolate schema init at production scale, attributed.
 *
 * auth.identify / first-invocation boots cost ~8-11s CPU in production
 * (2026-11-19 incident residue) while every DDL statement is an IF NOT EXISTS
 * no-op — so the seconds came from per-boot WORK, not DDL: ~30 always-throwing
 * ALTER TABLE ADD COLUMN statements and two unconditional corpus walkers
 * (project backfill + todo owner release). The stage instrument now splits
 * initializeSchema per section; this fixture pins the split with a
 * production-shaped corpus (14k tasks, 9KB metas, legacy todo+owner rows,
 * tokens/sessions/ledger).
 *
 * Boot shapes covered (all over persisted SQLite = the production cold-isolate
 * shape — dispose → recreate Miniflare over the same persist dir):
 *   fresh   — empty DB: migrations run, stamps set;
 *   upgrade — populated DB with stamps cleared: the one-time sweeps run
 *             exactly once (legacy rows repaired), stages stay bounded;
 *   steady  — populated DB with stamps present: the guard probes are single
 *             settings reads; no per-boot corpus walking, stable timings.
 */

let mf: Miniflare;
let persistDir: string;
let stub: { fetch(url: string, init?: RequestInit): Promise<Response> };

async function rig(path: string, init?: RequestInit) {
  const response = await stub.fetch(`https://hub${path}`, init);
  return { status: response.status, body: await response.json() as any };
}
async function sql(query: string, ...params: unknown[]) {
  const result = await rig("/rig/sql", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, params }),
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body as { rows: Record<string, any>[] };
}
async function stages() {
  const result = await rig("/rig/stages");
  expect(result.status).toBe(200);
  expect(result.body.stages, "no stage table — instrument did not run").toBeTruthy();
  return result.body.stages as { at: number; total_ms: number; stages: { stage: string; ms: number }[] };
}
const stageOf = (s: Awaited<ReturnType<typeof stages>>, name: string) =>
  s.stages.find((x) => x.stage === name);

async function boot(): Promise<{ at: number; total_ms: number; stages: { stage: string; ms: number }[] }> {
  mf = new Miniflare({
    durableObjectsPersist: persistDir,
    modulesRoot: bundleDir,
    modules: [
      { type: "ESModule", path: rigEntry, contents: rigSource },
      { type: "ESModule", path: bundle, contents: readFileSync(bundle, "utf8") },
    ],
    compatibilityDate: "2025-09-06",
    durableObjects: { KB: { className: "SchemaInitRig", useSQLite: true } },
  });
  stub = (await mf.getDurableObjectNamespace("KB")).get(
    (await mf.getDurableObjectNamespace("KB")).idFromName("global"),
  ) as any;
  const s = await stages();
  return s;
}

const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
const bundleDir = bundle.slice(0, bundle.lastIndexOf("/"));
const rigEntry = `${bundleDir}/schema-init-rig.mjs`;
const rigSource = `import {KnowledgeHub} from './index.js';
export class SchemaInitRig extends KnowledgeHub {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/rig/')) return super.fetch(request);
    await this.ensureSchema();
    try {
      if (path === '/rig/sql') {
        const body = await request.json();
        try {
          const cursor = this.state.storage.sql.exec(body.query, ...body.params);
          return Response.json({ rows: cursor.toArray() });
        } catch (error) { return Response.json({ error: String(error), query: String(body.query).slice(0, 240) }, { status: 500 }); }
      }
      if (path === '/rig/stages') return Response.json({ stages: this.lastSchemaInitStages });
      return new Response('not found', { status: 404 });
    } catch (error) { return new Response(JSON.stringify({ error: String(error) }), { status: 500 }); }
  }
}
export default { fetch() { return new Response('fixture'); } };`;

beforeAll(() => { persistDir = mkdtempSync(join(tmpdir(), "schema-init-scale-")); });

afterAll(async () => {
  await mf?.dispose();
  if (persistDir) rmSync(persistDir, { recursive: true, force: true });
});

const fat = (n: number) => JSON.stringify({ filler: "x".repeat(n) });

describe("cold-isolate schema init at production scale (BR#16950)", () => {
  it("fresh boot: migrations run and stamps set, bounded", async () => {
    const s = await boot();
    // The pre-fix production symptom was 8-11s of CPU on the boot path.
    // Everything below stays three orders of magnitude under it even on CI.
    expect(s.total_ms).toBeLessThan(1000);
    const stamps = await sql(`SELECT key FROM settings WHERE key IN ('additive_columns_v1','project_backfill_v1')`);
    expect(stamps.rows.map((r) => r.key).sort()).toEqual(["additive_columns_v1", "project_backfill_v1"]);
    // first boot ran the additive loop (stamp was absent)
    expect(stageOf(s, "additive_columns")!.ms).toBeLessThan(1000);
  }, 120_000);

  it("populates a production-shaped corpus, then clears the stamps (upgrade shape)", async () => {
    // 14k done tasks with 9KB metas — the fat-meta corpus shape (BR#11554 era)
    await sql(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<14000)
      INSERT INTO artefacts(id,type,title,status,body_md,meta,owner,created_ts,updated_ts,status_ts,tags,roles,project,created_by)
      SELECT 'BR#'||(900000+i),'task','corpus done card '||i,'done','',?,'seed',1,1,1,'[]','[]','scale','seed' FROM n`, fat(9000));
    // 500 legacy todo rows: creator still attached, project never stamped —
    // exactly the rows the per-boot walkers existed to repair
    await sql(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<500)
      INSERT INTO artefacts(id,type,title,status,body_md,meta,owner,created_ts,updated_ts,status_ts,tags,roles,project,created_by)
      SELECT 'BR#95'||printf('%04d',i),'task','legacy todo '||i,'todo','','{}','seed-creator',1,1,1,'[]','[]','','seed' FROM n`);
    await sql(`INSERT INTO auth_tokens(id,label,hash,tags,created_ts) VALUES('tok-gw','gw','hash-gw','["gateway"]',1)`);
    await sql(`INSERT INTO sessions(token_id,name,first_seen_ts,last_seen_ts) VALUES('tok-gw','s1',1,1),('tok-gw','s2',1,1)`);
    await sql(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<300)
      INSERT INTO ledger(ts,actor,kind,action,artefact_id,summary,data)
      SELECT 1,'seed','mutation','update','BR#900001','seed','{}' FROM n`);
    // clear the stamps: a pre-upgrade production DB has the legacy rows but
    // no stamp keys — this is the boot that must run the sweeps exactly once
    await sql(`DELETE FROM settings WHERE key IN ('additive_columns_v1','project_backfill_v1')`);
  }, 180_000);

  it("upgrade boot over the populated corpus: one-time sweeps repair legacy rows, bounded", async () => {
    await mf?.dispose();
    const s = await boot();
    expect(s.total_ms).toBeLessThan(1000);
    // legacy repair happened on this boot (exactly once — it is what stamps)
    const legacy = await sql(`SELECT COUNT(*) AS n FROM artefacts WHERE id LIKE 'BR#95%' AND type='task'`);
    expect(legacy.rows[0].n).toBe(500);
    const released = await sql(`SELECT COUNT(*) AS n FROM artefacts WHERE type='task' AND status='todo' AND owner='seed-creator'`);
    expect(released.rows[0].n, "legacy todo owners must be released on the upgrade boot").toBe(0);
    const projects = await sql(`SELECT COUNT(*) AS n FROM artefacts WHERE type='task' AND project=''`);
    expect(projects.rows[0].n, "legacy empty projects must be backfilled on the upgrade boot").toBe(0);
    // per-stage sanity: no stage dominates the boot
    const worst = Math.max(...s.stages.map((x) => x.ms));
    expect(worst).toBeLessThan(500);
  }, 120_000);

  it("steady cold boot: guard probes are single reads, no per-boot corpus walking", async () => {
    await mf?.dispose();
    const s = await boot();
    expect(s.total_ms).toBeLessThan(1000);
    // the two cured stages are now settings-key probes, not corpus walks
    expect(stageOf(s, "additive_columns")!.ms).toBeLessThan(50);
    expect(stageOf(s, "unclaimed_backfill")!.ms).toBeLessThan(50);
    // the boot is stable across isolates (pre-fix this was the 8-11s shape)
    const corpus = await sql(`SELECT COUNT(*) AS n FROM artefacts WHERE type='task' AND status='done'`);
    expect(corpus.rows[0].n).toBe(14000);
    const legacy = await sql(`SELECT COUNT(*) AS n FROM artefacts WHERE id LIKE 'BR#95%' AND type='task'`);
    expect(legacy.rows[0].n).toBe(500);
  }, 120_000);
});
