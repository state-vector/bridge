import { Miniflare } from "miniflare";
import { readFileSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
const repo = "state-vector/canonical-lane";
async function lane() {
  const created = await post("train.lane", { repo, base: "main", actor: "fixture", spec: { required_workflows: ["Test"] } });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const acquired = await post("train.lease", { repo, base: "main", action: "acquire", actor: "gateway", holder: "gateway" });
  expect(acquired.status, JSON.stringify(acquired.body)).toBe(200);
  return String((await sql(`SELECT id FROM lane_cards WHERE json_extract(meta,'$.lane.repo')=?`, repo))[0].id);
}
beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  const entry = `${bundle.slice(0, bundle.lastIndexOf("/"))}/canonical-rig.mjs`;
  // Test-only subclass around the actual built hub. No diagnostic SQL or fault
  // injection endpoints are added to the production application.
  const rig = `import {KnowledgeHub} from './index.js';
    export class LaneRig extends KnowledgeHub {
      async fetch(request) {
        const path=new URL(request.url).pathname;
        if (!path.startsWith('/rig/')) return super.fetch(request);
        await this.ensureSchema(); const body=await request.json();
        try {
          if(path==='/rig/sql') {const cursor=this.state.storage.sql.exec(body.query,...body.params);const rows=cursor.toArray();return Response.json({rows,reads:cursor.rowsRead});}
          if(path==='/rig/revisions') {
            const first=JSON.parse(this.laneRow(body.key).meta), stale=JSON.parse(this.laneRow(body.key).meta);
            first.lane.now_action={note:'fresh',holder:'gateway',at:Date.now()}; this.saveLaneState(body.id,first,Date.now());
            stale.lane.now_action={note:'stale',holder:'gateway',at:Date.now()};
            try {this.saveLaneState(body.id,stale,Date.now()); return Response.json({overwritten:true});}
            catch(error) {return Response.json({error:String(error)});}
          }
          if(path==='/rig/mutate') {
            const meta=JSON.parse(this.laneRow(body.key).meta); meta.lane.probe=body.probe;
            this.atomicLaneMutation(()=>{this.audit('fixture','uncommitted_lane_probe',body.id,{});this.saveLaneState(body.id,meta,Date.now());});
            return Response.json({ok:true});
          }
          return new Response('not found',{status:404});
        } catch(error) {return Response.json({error:String(error)},{status:500});}
      }
    } export default {fetch(){return new Response('fixture');}};`;
  mf = new Miniflare({ modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")), modules: [
    { type: "ESModule", path: entry, contents: rig }, { type: "ESModule", path: bundle, contents: readFileSync(bundle, "utf8") },
  ], compatibilityDate: "2025-09-06", durableObjects: { KB: { className: "LaneRig", useSQLite: true } } });
});
beforeEach(async () => {
  const ns = await mf.getDurableObjectNamespace("KB"); stub = await ns.get(ns.idFromName(crypto.randomUUID())) as unknown as typeof stub;
});
afterAll(async () => { await mf?.dispose(); });

describe("authoritative transactional lane state on the actual SQLite hub", () => {
  it("keeps typed JSON/nulls, hides private revisions and reads canonical facts despite a damaged card mirror", async () => {
    const id = await lane();
    const record = JSON.parse(String((await sql(`SELECT snapshot_json FROM lane_state`))[0].snapshot_json));
    expect(record.schema_version).toBe(1); expect(record.revision).toBeGreaterThan(0);
    expect(record.facts.lease.holder).toBe("gateway");
    const probe = { enabled: false, paths: ["a", { nullable: null }] };
    expect((await post("rig/mutate", { id, key: `${repo}@main`, probe })).status).toBe(200);
    await sql(`UPDATE artefacts SET meta=json_object('ordinary','preserved','lane',json_object('key','forged'),'lease',json_object('holder','impostor')) WHERE id=?`, id);
    const read = await post("get", { id });
    expect(read.body.meta.lane.key).toBe(`${repo}@main`);
    expect(read.body.meta.lease.holder).toBe("gateway");
    expect(read.body.meta.ordinary).toBe("preserved");
    expect(read.body.meta.lane.probe).toEqual(probe);
    expect(read.body.meta.__lane_revision).toBeUndefined();
    const renewed = await post("train.lease", { repo, action: "renew", holder: "gateway", actor: "gateway" });
    expect(renewed.status, JSON.stringify(renewed.body)).toBe(200);
    const released = await post("train.lease", { repo, action: "release", holder: "gateway", actor: "gateway" });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    const after = await post("get", { id }); expect(after.body.meta.lease).toBeNull();
    expect(after.body.meta.ordinary).toBe("preserved");
  });

  it("rolls back both state and card when canonical persistence faults, without emitting an uncommitted receipt", async () => {
    const id = await lane();
    const before = (await sql(`SELECT snapshot_json FROM lane_state`))[0].snapshot_json;
    const mirror = (await sql(`SELECT meta FROM artefacts WHERE id=?`, id))[0].meta;
    const events = (await sql(`SELECT COUNT(*) AS n FROM ledger WHERE action='uncommitted_lane_probe'`))[0].n;
    await sql(`CREATE TRIGGER fail_lane BEFORE INSERT ON lane_state BEGIN SELECT RAISE(ABORT,'injected canonical storage fault'); END`);
    const failed = await post("rig/mutate", { id, key: `${repo}@main`, probe: "uncommitted" });
    expect(failed.status).toBe(500);
    expect((await sql(`SELECT snapshot_json FROM lane_state`))[0].snapshot_json).toBe(before);
    expect((await sql(`SELECT meta FROM artefacts WHERE id=?`, id))[0].meta).toBe(mirror);
    expect((await sql(`SELECT COUNT(*) AS n FROM ledger WHERE action='uncommitted_lane_probe'`))[0].n).toBe(events);
    await sql(`DROP TRIGGER fail_lane`);
    expect((await post("rig/mutate", { id, key: `${repo}@main`, probe: "committed" })).status).toBe(200);
    expect((await sql(`SELECT COUNT(*) AS n FROM ledger WHERE action='uncommitted_lane_probe'`))[0].n).toBe(events + 1);
  });

  it("rejects an interleaved stale lane write instead of overwriting new state", async () => {
    const id = await lane();
    const result = await post("rig/revisions", { id, key: `${repo}@main` });
    expect(result.body.error).toContain("lane revision changed");
    const read = await post("get", { id }); expect(read.body.meta.lane.now_action.note).toBe("fresh");
    expect((await post("update", { id, meta: { __lane_revision: 999 } })).status).toBe(400);
  });
  it("does not let a new card steal an active lane or leave a mirror after the rejected rebind", async () => {
    const id = await lane();
    const before = (await sql(`SELECT snapshot_json FROM lane_state`))[0].snapshot_json;
    const duplicate = await post("create", { type: "task", title: "Competing active lane" });
    const other = String(duplicate.body.id);
    const rejected = await post("update", { id: other, meta: { lane: { key: `${repo}@main`, repo, base: "main" } } });
    expect(rejected.status).toBeGreaterThanOrEqual(400);
    expect(rejected.body.error).toContain("active card");
    expect((await post("get", { id: other })).body.meta.lane).toBeUndefined();
    expect((await sql(`SELECT lane_id,snapshot_json FROM lane_state`))[0]).toEqual({ lane_id: id, snapshot_json: before });
  });
  it("keeps canonical identity reads bounded with a retained unrelated backlog", async () => {
    const id = await lane();
    await sql(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<6000)
      INSERT INTO artefacts(id,type,title,status,body_md,meta,owner,created_ts,updated_ts,status_ts,tags,roles,project,created_by)
      SELECT 'unrelated-'||i,'task','Retained card','done','','{}','',1,1,1,'[]','[]','bridge','fixture' FROM n`);
    const byId = await post("rig/sql", { query: `SELECT id,meta FROM lane_cards WHERE id=?`, params: [id] });
    expect(byId.body.rows).toHaveLength(1); expect(byId.body.reads).toBeLessThan(100);
    const byKey = await post("rig/sql", { query: `SELECT id,meta FROM lane_cards WHERE json_extract(meta,'$.lane.key')=?`, params: [`${repo}@main`] });
    expect(byKey.body.rows).toHaveLength(1); expect(byKey.body.reads).toBeLessThan(100);
  });
  it("does not fall back to a healthy-looking mirror when canonical data is unsupported", async () => {
    const id = await lane();
    await sql(`UPDATE lane_state SET snapshot_json=json_set(snapshot_json,'$.schema_version',99)`);
    const read = await post("get", { id }); expect(read.status).toBeGreaterThanOrEqual(400);
  });
  it("does not change operational revisions just because a status projection is read", async () => {
    await lane();
    await post("train.status", { repo });
    const before = (await sql(`SELECT revision FROM lane_state`))[0].revision;
    expect((await post("train.status", { repo })).status).toBe(200);
    expect((await sql(`SELECT revision FROM lane_state`))[0].revision).toBe(before);
  });
  it("rolls back recovery task binding and incident acceptance together, then accepts the same event exactly once", async () => {
    const recoveryRepo = "state-vector/canonical-recovery", sha = "a".repeat(40);
    expect((await post("train.lane", { repo: recoveryRepo, spec: { required_workflows: ["deploy / Deploy to dev"] } })).status).toBe(200);
    const observation = await post("train.observe_deploy", { repo: recoveryRepo, actor: "observer", observation: { tip_sha: sha, observed_at: Date.now(), runs: [{ id: 1, name: "Deploy Dev", path: ".github/workflows/deploy-dev.yml", head_sha: sha, status: "completed", conclusion: "failure", html_url: `https://github.com/${recoveryRepo}/actions/runs/1` }] } });
    expect(observation.status, JSON.stringify(observation.body)).toBe(200);
    const task = await post("create", { type: "task", title: "Atomic cause-specific repair", qualified: true, roles: ["impl"] });
    const id = String(task.body.id), before = (await sql(`SELECT meta,tags FROM artefacts WHERE id=?`, id))[0];
    const event = { repo: recoveryRepo, head_sha: sha, cause: { kind: "test_failure", check: "Deploy Dev", suite: "unit", test: "atomic binding" }, event_id: "atomic-cause-observed",
      event: { kind: "observed", task_id: id, source: { head_sha: sha, run_id: 1, run_attempt: 1, url: `https://github.com/${recoveryRepo}/actions/runs/1` }, next: "Repair the observed failure" } };
    await sql(`CREATE TRIGGER fail_lane BEFORE INSERT ON lane_state BEGIN SELECT RAISE(ABORT,'injected canonical storage fault'); END`);
    expect((await post("train.recovery_event", event)).status).toBeGreaterThanOrEqual(400);
    expect((await sql(`SELECT meta,tags FROM artefacts WHERE id=?`, id))[0]).toEqual(before);
    await sql(`DROP TRIGGER fail_lane`);
    const accepted = await post("train.recovery_event", event);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200); expect(accepted.body.accepted).toBe(true);
    const replayed = await post("train.recovery_event", event); expect(replayed.body.replayed).toBe(true); expect(replayed.body.accepted).toBe(false);
    expect(JSON.parse(String((await sql(`SELECT meta FROM artefacts WHERE id=?`, id))[0].meta)).recovery_links).toHaveLength(1);
  });
});
