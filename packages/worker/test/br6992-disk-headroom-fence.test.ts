import { Miniflare } from "miniflare";
import { readFileSync, realpathSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executorRequest } from "./executor-fixture";

/** BR#6992 — a full workspace volume must fence the gateway LOUDLY: the
 *  runner advertises `resource_hold` (plus masked model availability so
 *  older hubs fail closed), the hub answers readiness `resource_held` with
 *  the named reason, and the scheduling health for that host reads clear
 *  (a named hold) instead of "starved / eligible_work_not_reserved" — the
 *  2026-11-25 incident class, where a 100% volume presented as an
 *  unexplained starvation while the gateway kept answering pings. The
 *  stored row must persist the honest held state (keepReady exists to
 *  protect a corrected runner from an obsolete producer, not to bury the
 *  running runner's own fence), and a clean re-advertise resumes ready. */

let mf: Miniflare;
let stub: { fetch(url: string, init: RequestInit): Promise<Response> };
let serial = 0;
async function post(op: string, body: object = {}) {
  const response = await stub.fetch(`https://kb/${op}`, { method: "POST", headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify(executorRequest(body)) });
  return await response.json() as Record<string, any>;
}

beforeEach(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  const root = bundle.slice(0, bundle.lastIndexOf("/"));
  const rig = `import { KnowledgeHub } from "./index.js";
    export class DiskFenceRig extends KnowledgeHub {
      async fetch(request) {
        if (new URL(request.url).pathname === "/fixture/br6992-sweep") {
          await this.alarmSweep();
          return Response.json({ ok: true });
        }
        return super.fetch(request);
      }
    }
    export default {fetch(){return new Response("fixture");}};`;
  mf = new Miniflare({ modulesRoot: root, modules: [
    { type: "ESModule", path: root + "/disk-fence-rig.js", contents: rig },
    { type: "ESModule", path: bundle, contents: readFileSync(bundle, "utf8") },
  ], compatibilityDate: "2025-09-06", durableObjects: { KB: { className: "DiskFenceRig", useSQLite: true } } });
  const ns = await mf.getDurableObjectNamespace("KB");
  stub = await ns.get(ns.idFromName("scheduler")) as unknown as typeof stub;
});
afterEach(async () => { await mf?.dispose(); });

describe("BR#6992 disk-headroom resource fence", () => {
  it("names the hold, never reads as starved, and resumes when the volume recovers", async () => {
    const host = `gw-br6992-${++serial}`;
    const token = await post("admin.mint", { label: host, tags: ["gateway"] });
    const identity = await post("auth.identify", { bearer: token.secret });
    expect((await post("agent.provision", { label: `${host}/worker`, actor: host })).error).toBeUndefined();
    const auth = { actor: host, token_id: identity.token_id, gateway: true, agent: `${host}/worker`, session: `gw-${serial}` };
    const capabilities: Record<string, unknown> = { tier: "small", tools: ["git"], environment: ["linux"], backend: "opencode", model: "test/small", config_revision: "one", capacity: 4, projects: ["bridge"], worker: { kind: "provisioned", label: `${host}/worker` } };
    const cmd = (command: object, command_id = `cmd-${++serial}`) => post("execution", { ...auth, id: "gateway", session: auth.session, command_id, command });
    const hostsOf = async () => (await cmd({ kind: "schedule_status", refresh: true })).hosts as Array<Record<string, any>>;
    const mine = async () => (await hostsOf()).find(h => h.host === host) ?? expect.fail("schedule_status must list the advertising host");

    // Baseline: a clean advertise is ready.
    const clean = await cmd({ kind: "advertise", capabilities });
    expect(clean.error).toBeUndefined();
    expect(clean.ok).toBe(true);
    expect(clean.readiness).toMatchObject({ kind: "ready" });

    // The volume drops below its floor: the runner declares resource_hold
    // and masks availability (older hubs fail closed on the mask).
    const diskReason = "disk headroom: 0 bytes free on /bridge-work below the 5368709120-byte floor; workspace reclamation continues";
    const held = await cmd({ kind: "advertise", capabilities: { ...capabilities, availability: { kind: "unavailable", reason: diskReason }, resource_hold: { reason: diskReason } } });
    expect(held.error).toBeUndefined();
    expect(held.ok).toBe(false);
    expect(held.readiness).toEqual({ kind: "resource_held", reason: diskReason });

    // The stored row must carry the honest held state: keepReady must not
    // bury the running runner's own fence under a stale ready row.
    expect((await mine()).readiness).toEqual({ kind: "resource_held", reason: diskReason });
    expect((await mine()).live).toBe(true);

    // Eligible work exists while the host is resource-held: the scheduling
    // health reads CLEAR (a named hold), never "starved /
    // eligible_work_not_reserved" — the misread of the live incident.
    const task = await post("create", { actor: "author", type: "task", title: "BR#6992 fence specimen", body_md: "fixture", project: "bridge", qualified: true, roles: ["impl"] });
    expect(task.error).toBeUndefined();
    await stub.fetch("https://kb/fixture/br6992-sweep", { method: "POST" });
    expect((await mine()).health).toMatchObject({ kind: "clear" });

    // The volume recovers: the next clean advertise is ready again, and the
    // board follows without any operator action.
    const resumed = await cmd({ kind: "advertise", capabilities });
    expect(resumed.error).toBeUndefined();
    expect(resumed.ok).toBe(true);
    expect(resumed.readiness).toMatchObject({ kind: "ready" });
    expect((await mine()).readiness).toMatchObject({ kind: "ready" });
  });
});
