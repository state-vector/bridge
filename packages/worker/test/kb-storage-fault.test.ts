import { Miniflare } from "miniflare";
import { createHmac } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeHub } from "../src/kb/do.ts";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import worker from "../src/index.js";

/**
 * BR#4212 — injected storage-fault tests for the KnowledgeHub DO fetch entry
 * and the worker's knowledge-channel arms (incident BR#4117: one storage
 * fault used to throw uncaught at the DO entry, the arms had no catch, and
 * the runtime served CF HTML 500 pages where JSON acks belong).
 *
 * Contract under test, three tiers:
 *  A. DO entry (fake state = precise fault injection): a storage fault at
 *     ensureSchema yields TYPED JSON 503 {result_class: "infra_storage_fault"}
 *     — never a throw, never HTML. An alarm-guard fault DEGRADES: the request
 *     still serves, the fault is counted in /stats.channel. A faulted alarm()
 *     re-arm never throws out of alarm() (a throwing alarm loses its
 *     schedule entirely).
 *  B. Worker arms (fake KB namespace whose stub rejects — the "DO reset"
 *     class): every knowledge-channel arm — /api/kb/*, /api/kb-machine/*,
 *     /mcp — answers typed JSON, and infrastructure faults are NEVER
 *     mislabeled "unauthorized" (the mcp.ts 401-storm mislabel).
 *  C. Real-SQLite rig (miniflare, BR#2841): the happy path still works with
 *     the counting wrapper in place, and /stats surfaces the channel block
 *     (write success rate + per-route counters) machine-readably.
 */

const HTML_NEVER = /<html|<!doctype/i;

/** workers-types narrows Body.json() to `unknown`; these tests assert fields
 *  on the parsed body, so every body parse goes through this one helper
 *  (BR#4237 bounce: 11x TS2339 "property does not exist on type unknown"). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonBody = async (r: Response): Promise<Record<string, any>> =>
  (await r.json()) as Record<string, any>;

// ---------- tier A: DO entry, fake-state fault injection ----------

interface Faults { sql?: boolean; getAlarm?: boolean; setAlarm?: boolean }

function fakeState(faults: Faults = {}): any {
  const boom = (m: string) => { throw new Error(m); };
  return {
    storage: {
      sql: {
        exec: (..._a: unknown[]) => {
          if (faults.sql) boom("SQLITE_FAULT: injected storage storm");
          return { toArray: () => [] };
        },
      },
      getAlarm: async () => { if (faults.getAlarm) boom("ALARM_FAULT: getAlarm injected"); return null; },
      setAlarm: async (_t: number) => { if (faults.setAlarm) boom("ALARM_FAULT: setAlarm injected"); },
    },
    getWebSockets: () => [],
    acceptWebSocket: (_ws: unknown) => {},
  };
}

const kbPost = (hub: KnowledgeHub, path: string, body = "{}") =>
  hub.fetch(new Request(`https://kb${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  }));

describe("DO fetch entry: injected storage faults (BR#4212)", () => {
  it("serves stateful build provenance independently of SQL readiness", async () => {
    const hub = new KnowledgeHub(fakeState({ sql: true }), {});
    const response = await hub.fetch(new Request("https://kb/version"));
    expect(response.status).toBe(200);
    expect((await jsonBody(response)).lifecycle_protocol).toBe(2);
  });
  it("ensureSchema fault → typed JSON 503, never a throw, never HTML", async () => {
    const hub = new KnowledgeHub(fakeState({ sql: true }), {});
    const res = await kbPost(hub, "/orient");
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await jsonBody(res);
    expect(body.result_class).toBe("infra_storage_fault");
    expect(body.stage).toBe("ensure_schema");
    expect(JSON.stringify(body)).not.toMatch(HTML_NEVER);
  });

  it("getAlarm/setAlarm fault degrades: the request still serves, fault counted", async () => {
    const hub = new KnowledgeHub(fakeState({ getAlarm: true, setAlarm: true }), {});
    const res = await kbPost(hub, "/stats");
    // the op itself ran (stats served) despite the faulted alarm guard
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.channel.entry_faults.alarm_rearm.n).toBeGreaterThanOrEqual(1);
  });

  it("dispatch-tier throw (malformed body) is JSON — 400 bad json, not HTML", async () => {
    const hub = new KnowledgeHub(fakeState(), {});
    const res = await kbPost(hub, "/orient", "{not json");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await jsonBody(res)).error).toBe("bad json");
  });

  it("alarm(): a faulted re-arm never throws out of the handler (schedule survives via the entry guard)", async () => {
    const hub = new KnowledgeHub(fakeState({ setAlarm: true }), {});
    // degrade + retry — a throwing alarm() would lose its schedule entirely
    await expect(hub.alarm()).resolves.toBeUndefined();
    // the fault is counted and visible to the watchdog's /stats probe
    const res = await kbPost(hub, "/stats");
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.channel.entry_faults.alarm_rearm.n).toBeGreaterThanOrEqual(1);
  });
});

// ---------- tier B: worker arms, rejecting KB stub ----------

const SECRET = "test-gh-secret";
function sessionCookie(login = "ray", ws = "global") {
  const exp = String(Date.now() + 60_000);
  const sig = createHmac("sha256", SECRET).update(`${exp}.${login}.${ws}`).digest("hex");
  return `bridge_session=${exp}.${login}.${ws}.${sig}`;
}

/** KB namespace whose DO stub rejects — the "Durable Object reset" class the
 *  DO-level wrapper cannot intercept at the caller side. */
function rejectingEnv(): any {
  return {
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: SECRET,
    KB: {
      idFromName: (n: string) => ({ name: n }),
      get: () => ({
        fetch: async () => { throw new Error("DO reset: injected storage storm"); },
      }),
    },
  };
}

/** KB stub that answers the registry lookup 200 then rejects the hub call —
 *  drives the auth.identify classification paths in handleMcp. */
function registryThenEnv(identify: () => Response): any {
  return {
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: SECRET,
    KB: {
      idFromName: (n: string) => ({ name: n }),
      get: () => ({
        fetch: async (_url: string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body ?? "{}"));
          if (init && "hash" in body) return new Response(JSON.stringify({ ws: "global" }), { status: 200 });
          return identify();
        },
      }),
    },
  };
}

describe("cached gateway readiness during a hub rollout", () => {
  it.each([404, 403])("uses the authenticated legacy route only for an unknown v2 operation (%i)", async (status) => {
    const bearer = "bkw_state-vector_" + "a".repeat(48);
    const called: string[] = [];
    const env = rejectingEnv();
    env.KB.get = () => ({
      fetch: async (url: string, init: RequestInit) => {
        const op = new URL(url).pathname;
        called.push(op);
        const body = JSON.parse(String(init.body));
        if (op === "/worker.resolve.v2") {
          expect(body).toEqual({ bearer, secret: "cached-worker" });
          return Response.json({ error: "proof not available" }, { status });
        }
        if (op === "/auth.identify") {
          expect(body).toEqual({ bearer });
          return Response.json({ label: "gateway", token_id: "gateway-id", tags: ["gateway"] });
        }
        expect(op).toBe("/worker.resolve");
        expect(body).toEqual({ actor: "gateway", token_id: "gateway-id", secret: "cached-worker" });
        return Response.json({ cached: true, label: "gateway/worker" });
      },
    });
    const response = await worker.fetch(new Request("https://hub/api/kb-machine/provision", {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ cached_secret: "cached-worker", actor: "spoofed" }),
    }), env);
    expect(response.status).toBe(status === 404 ? 200 : 403);
    expect(called).toEqual(status === 404 ? ["/worker.resolve.v2", "/auth.identify", "/worker.resolve"] : ["/worker.resolve.v2"]);
  });
});

describe("worker arms: DO faults surface typed JSON, never HTML, never a 401 mislabel", () => {
  it("GET /api/kb/stats with a rejecting DO → JSON 503 typed", async () => {
    const res = await worker.fetch(new Request("https://hub/api/kb/stats", {
      headers: { cookie: sessionCookie() },
    }), rejectingEnv());
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json()).result_class).toBe("infra_storage_fault");
  });

  it("POST /api/kb/transition with a rejecting DO → JSON 503 typed (no silent write loss signal)", async () => {
    const res = await worker.fetch(new Request("https://hub/api/kb/transition", {
      method: "POST",
      headers: { cookie: sessionCookie(), "content-type": "application/json" },
      body: JSON.stringify({ id: "BR#1", to: "done" }),
    }), rejectingEnv());
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await jsonBody(res);
    expect(body.result_class).toBe("infra_storage_fault");
    expect(JSON.stringify(body)).not.toMatch(HTML_NEVER);
  });

  it("GET /api/kb-machine/stats with a rejecting DO → JSON 503 typed (the watchdog's own probe)", async () => {
    const res = await worker.fetch(new Request("https://hub/api/kb-machine/stats", {
      headers: { authorization: "Bearer bkw_" + "a".repeat(40) },
    }), rejectingEnv());
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json()).result_class).toBe("infra_storage_fault");
  });

  it.each(["stats", "list", "search?q=authority"])("legacy machine %s keeps identify faults retryable and typed", async route => {
    const env = registryThenEnv(() => new Response("<!doctype html>runtime unavailable", { status: 503 }));
    const res = await worker.fetch(new Request(`https://hub/api/kb-machine/${route}`, {
      headers: { authorization: "Bearer bkw_" + "e".repeat(40) },
    }), env);
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await jsonBody(res);
    expect(body.result_class).toBe("infra_storage_fault");
    expect(JSON.stringify(body)).not.toMatch(HTML_NEVER);
  });

  it("awaits the legacy password-cookie signature before granting human decision authority", async () => {
    const password = "legacy-test-password";
    const exp = String(Date.now() + 60_000);
    const env = { BRIDGE_UI_PASSWORD: password, KB: rejectingEnv().KB };
    const denied = await worker.fetch(new Request("https://hub/api/kb-machine/act", {
      method: "POST", headers: { cookie: `bridge_session=${exp}.forged-signature`, "content-type": "application/json" },
      body: JSON.stringify({ op: "transition", id: "BR#1", to: "accepted" }),
    }), env);
    expect(denied.status).toBe(401);

    // A real signed legacy session still reaches the decision action as human.
    const sig = createHmac("sha256", password).update(exp).digest("hex");
    let transition: Record<string, unknown> | undefined;
    env.KB.get = () => ({ fetch: async (url: string, init?: RequestInit) => {
      if (url.includes("/artefact?")) return Response.json({ id: "BR#1", type: "decision" });
      transition = JSON.parse(String(init?.body));
      return Response.json({ id: "BR#1", status: "accepted" });
    } });
    const allowed = await worker.fetch(new Request("https://hub/api/kb-machine/act", {
      method: "POST", headers: { cookie: `bridge_session=${exp}.${sig}`, "content-type": "application/json" },
      body: JSON.stringify({ op: "transition", id: "BR#1", to: "accepted", actor: "web:forged", token_id: "forged", gateway: true }),
    }), env);
    expect(allowed.status).toBe(200);
    expect(transition).toMatchObject({ actor: "web:anon", gateway: false });
    expect(transition).not.toHaveProperty("token_id");
  });

  it("POST /mcp: registry infra fault → JSON-RPC 503 infra, NOT 'unauthorized' 401 (the BR#4117 mislabel)", async () => {
    const res = await worker.fetch(new Request("https://hub/mcp", {
      method: "POST",
      headers: { authorization: "Bearer bkw_" + "b".repeat(40), "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
    }), rejectingEnv());
    expect(res.status).toBe(503);
    const body = await jsonBody(res);
    expect(body.error.code).toBe(-32000);
    expect(body.error.data.result_class).toBe("infra_storage_fault");
    expect(JSON.stringify(body)).not.toMatch(/unauthorized/i);
    expect(JSON.stringify(body)).not.toMatch(HTML_NEVER);
  });

  it("POST /mcp: genuine unknown token still 401s (auth classification survives)", async () => {
    const env = registryThenEnv(() => new Response(JSON.stringify({ error: "unknown auth token" }), { status: 400 }));
    const res = await worker.fetch(new Request("https://hub/mcp", {
      method: "POST",
      headers: { authorization: "Bearer bkw_" + "c".repeat(40), "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" }),
    }), env);
    expect(res.status).toBe(401);
    const body = await jsonBody(res);
    expect(body.error.code).toBe(-32001);
  });

  it("POST /mcp: identify-level storage fault (503 from DO) → 503 infra, not 401", async () => {
    const env = registryThenEnv(() => new Response(
      JSON.stringify({ error: "kb storage fault at ensure_schema", result_class: "infra_storage_fault", stage: "ensure_schema" }),
      { status: 503, headers: { "content-type": "application/json" } },
    ));
    const res = await worker.fetch(new Request("https://hub/mcp", {
      method: "POST",
      headers: { authorization: "Bearer bkw_" + "d".repeat(40), "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    }), env);
    expect(res.status).toBe(503);
    const body = await jsonBody(res);
    expect(body.error.data.result_class).toBe("infra_storage_fault");
    expect(JSON.stringify(body)).not.toMatch(/unauthorized/i);
  });
});

// ---------- tier C: real-SQLite rig (miniflare) ----------

let mf: Miniflare;
let kb: (path: string, init?: RequestInit) => Promise<Response>;

beforeAll(() => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  if (!existsSync(bundle)) {
    throw new Error("bundle missing — run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle (the npm test script does this before vitest)");
  }
  mf = new Miniflare({
    workers: [{
      name: "main",
      scriptPath: bundle,
      modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")),
      modules: true,
      compatibilityDate: "2025-09-06",
      durableObjects: { KB: { className: "KnowledgeHub", useSQLite: true } },
    }],
  });
  return (async () => {
    const ns = await mf.getDurableObjectNamespace("KB");
    // miniflare's loose generic stub type carries no `fetch` — the rig calls
    // the DO directly, so pin the one signature the rig uses (BR#4237 bounce).
    const stub = (await ns.get(ns.idFromName("global"))) as unknown as {
      fetch: (url: string, init?: RequestInit) => Promise<Response>;
    };
    kb = (path, init) => stub.fetch(`https://kb${path}`, init);
    await kb("/orient", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor: "test" }) });
  })();
});

afterAll(async () => {
  await mf?.dispose();
});

describe("real-SQLite rig: channel counters surface in /stats (BR#4212 leg 3)", () => {
  it("stats serves through the counting wrapper and reports the route + write rate", async () => {
    // two calls: the counting wrapper's finally runs after the body snapshot,
    // so the SECOND response reports the FIRST request's counters
    const r1 = await kb("/stats", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r1.status).toBe(200);
    const res = await kb("/stats", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await jsonBody(res);
    expect(body.channel).toBeTruthy();
    expect(body.channel.routes["POST /stats"].ok).toBeGreaterThanOrEqual(1);
    expect(body.channel.write_ops.ok).toBeGreaterThanOrEqual(2);
    expect(typeof body.channel.window_started_ts).toBe("number");
    // machine-checkable "channel down" probe: no storage faults on the happy path
    expect(body.channel.entry_faults).toEqual({});
  });
});
