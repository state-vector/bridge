import { Miniflare } from "miniflare";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Allowlist regression (372bbe973 class: a route off run_worker_first is
 * silently eaten by the SPA assets layer).
 *
 * BR#4252 removed the /v1/models route + MODEL_IDS registry entirely (the
 * hub is not a model gateway — models are the agent CLI's business; the
 * registry shipped empty and FAILed every valid doctor pin). This file
 * keeps ONLY the route-agnostic regression legs the incident class earned:
 *  - an unknown /api path is answered by the WORKER as json, never
 *    index.html — the code half of the probe;
 *  - wrangler.toml's run_worker_first still lists the known worker-handled
 *    paths — the config half (the assets layer is not part of the
 *    miniflare bundle, so the allowlist can only be asserted as config).
 */

let mf: Miniflare;

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
    }],
  });
});

afterAll(async () => {
  await mf?.dispose();
});

const ct = (r: Response) => r.headers.get("content-type") ?? "";

describe("allowlist regression (372bbe973 class: a route off run_worker_first is silently eaten)", () => {
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

  it("removed /v1/models is gone from the worker AND the allowlist (BR#4252)", async () => {
    // the worker no longer answers it as a json registry route
    const r = await mf.dispatchFetch("https://hub.test/v1/models");
    const text = await r.text();
    expect(text).not.toContain('"object":"list"', "the fabricated model registry must stay dead");

    // and the config no longer routes it to the worker (SPA territory again)
    const toml = readFileSync(realpathSync(new URL("../wrangler.toml", import.meta.url).pathname), "utf8");
    const m = toml.match(/run_worker_first\s*=\s*\[([^\]]*)\]/);
    expect(m, "run_worker_first array missing from wrangler.toml").toBeTruthy();
    const entries = m![1]
      .split(",")
      .map((s) => s.trim().replace(/^"+|"+$/g, ""))
      .filter(Boolean);
    expect(entries).not.toContain("/v1/models", "BR#4252: the model registry route is removed");
    expect(toml).not.toMatch(/^\s*MODEL_IDS\s*=/m, "BR#4252: the fabricated registry var is removed (tombstone comments may name it)");
    expect(entries).toContain("/api/token/repair", "372bbe973 stays pinned");
    expect(entries).toContain("/api/pair/*");
  });
});
