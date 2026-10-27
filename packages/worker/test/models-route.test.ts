import { Miniflare } from "miniflare";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * BR#3885 — GET /v1/models, the hub's model registry probe.
 *
 * The CLI doctor (BR#3055/BR#2843 spec item 3) checks every pinned backend
 * model against this route. The route never existed hub-side and the SPA
 * assets layer ate the path (200 text/html — the 372bbe973 class, third
 * incident). Pinned here, production-shaped (real workerd, real bundle):
 *  - the route answers OpenAI shape `{object:"list",data:[{id}...]}` from the
 *    MODEL_IDS var — trimmed, empties dropped, deduped — with a string `id`
 *    per entry (exactly what the doctor's extract_model_ids reads);
 *  - it answers WITHOUT any credential (doctor runs when pairing is broken;
 *    checkAuth reads cookies only, so it must sit before that gate);
 *  - an unknown /api path is answered by the WORKER as json, never
 *    index.html — the code half of the allowlist regression probe;
 *  - wrangler.toml's run_worker_first lists /v1/models (and still lists
 *    /api/token/repair) — the config half. The assets layer is not part of
 *    the miniflare bundle, so the allowlist can only be asserted as config;
 *    this is the guard that would have caught all three incidents.
 */

let mf: Miniflare;
let mfNoRegistry: Miniflare | null = null;

function bundlePath(): string {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  if (!existsSync(bundle)) {
    throw new Error("bundle missing — run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle (the npm test script does this before vitest)");
  }
  return bundle;
}

beforeAll(async () => {
  mf = new Miniflare({
    workers: [{
      name: "main",
      scriptPath: bundlePath(),
      modulesRoot: bundlePath().slice(0, bundlePath().lastIndexOf("/")),
      modules: true,
      compatibilityDate: "2025-09-06",
      // deliberately messy: spaces, empties, a duplicate — the route must
      // normalize before serving (the doctor string-matches against these)
      bindings: { MODEL_IDS: "sp-gateway/glm-5.3-flash, glm-4.7 ,,  sp-gateway/glm-5.3-flash,glm-4.7-air" },
    }],
  });
});

afterAll(async () => {
  await mf?.dispose();
  await mfNoRegistry?.dispose();
});

const ct = (r: Response) => r.headers.get("content-type") ?? "";

describe("BR#3885 — GET /v1/models (model registry probe)", () => {
  it("serves MODEL_IDS in OpenAI shape — trimmed, empties dropped, deduped", async () => {
    const r = await mf.dispatchFetch("https://hub.test/v1/models");
    expect(r.status).toBe(200);
    expect(ct(r)).toContain("application/json");
    const body: any = await r.json();
    expect(body.object).toBe("list");
    expect(body.data.map((m: any) => m.id)).toEqual([
      "sp-gateway/glm-5.3-flash",
      "glm-4.7",
      "glm-4.7-air",
    ]);
    for (const m of body.data) {
      expect(typeof m.id).toBe("string", "the doctor reads exactly data[].id");
      expect(m.object).toBe("model");
    }
  });

  it("answers with NO credential — doctor runs when pairing is broken (sits before checkAuth)", async () => {
    // no cookie, no bearer, no auth env configured: checkAuth would 503/401,
    // so a 200 proves the route lives before the human-plane auth gate
    const r = await mf.dispatchFetch("https://hub.test/v1/models", { headers: { Accept: "application/json" } });
    expect(r.status).toBe(200);
  });

  it("tolerates the doctor's Bearer header", async () => {
    const r = await mf.dispatchFetch("https://hub.test/v1/models", {
      headers: { Authorization: "Bearer some-bridge-token" },
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).object).toBe("list");
  });

  it("non-GET is a 405 json, not a page", async () => {
    const r = await mf.dispatchFetch("https://hub.test/v1/models", { method: "POST" });
    expect(r.status).toBe(405);
    expect(ct(r)).toContain("application/json");
  });

  it("unset MODEL_IDS = an honest empty list (200 json, zero ids)", async () => {
    mfNoRegistry = new Miniflare({
      workers: [{
        name: "main",
        scriptPath: bundlePath(),
        modulesRoot: bundlePath().slice(0, bundlePath().lastIndexOf("/")),
        modules: true,
        compatibilityDate: "2025-09-06",
      }],
    });
    const r = await mfNoRegistry.dispatchFetch("https://hub.test/v1/models");
    expect(r.status).toBe(200);
    expect(ct(r)).toContain("application/json");
    expect(await r.json()).toEqual({ object: "list", data: [] });
  });
});

describe("BR#3885 — allowlist regression (372bbe973 class: a route off run_worker_first is silently eaten)", () => {
  it("unknown /api path is answered by the worker as json — never index.html", async () => {
    for (const method of ["GET", "POST"]) {
      const r = await mf.dispatchFetch("https://hub.test/api/definitely-not-a-route", { method: method as "GET" | "POST" });
      expect(r.status).toBe(503, "checkAuth: no auth env in the test rig — json, not the SPA");
      expect(ct(r)).toContain("application/json");
      const text = await r.text();
      expect(text).not.toContain("<!DOCTYPE");
      expect(text).not.toContain("<html");
    }
  });

  it("wrangler.toml run_worker_first lists /v1/models (config guard — assets live outside the bundle)", async () => {
    const toml = readFileSync(realpathSync(new URL("../wrangler.toml", import.meta.url).pathname), "utf8");
    const m = toml.match(/run_worker_first\s*=\s*\[([^\]]*)\]/);
    expect(m, "run_worker_first array missing from wrangler.toml").toBeTruthy();
    const entries = m![1]
      .split(",")
      .map((s) => s.trim().replace(/^"+|"+$/g, ""))
      .filter(Boolean);
    expect(entries).toContain("/v1/models");
    expect(entries).toContain("/api/token/repair", "372bbe973 stays pinned");
    expect(entries).toContain("/api/pair/*");
  });
});
