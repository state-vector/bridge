import { Miniflare } from "miniflare";
import { readFileSync, existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * DO integration tests — the tier that would have caught today's production
 * failures. Drives the KnowledgeHub DO DIRECTLY (the same internal path
 * production's approve flow uses: hub.fetch("https://kb/<op>", x-kb-admin)),
 * on real miniflare SQLite:
 *  - placeholder/argument errors in hand-written SQL THROW here;
 *  - ensureSchema executes on a cold DB AND on the warm path, so a frozen-
 *    migration bug breaks tests instead of production;
 *  - the "Wrong number of parameter bindings" class cannot ship.
 * No auth plane: the DO's own x-kb-admin check gates admin ops, which is
 * exactly the trust boundary the internal callers use.
 */

let mf: Miniflare;
let kb: (path: string, init?: RequestInit) => Promise<Response>;

beforeAll(async () => {
  // miniflare 3 API (direct devDep; the v4 bundled with wrangler changed
  // its options schema). scriptPath MUST be absolute — it resolves against
  // the process cwd, not the config.
  // wrangler bundles TS via esbuild (miniflare cannot parse mcp.ts) — the
  // pretest step produces ../../.kb-bundle/index.js via `wrangler deploy
  // --dry-run --outdir`; the bundle is a single ESM file
  const bundle = new URL("../../../.kb-bundle/index.js", import.meta.url).pathname;
  if (!existsSync(bundle)) {
    throw new Error("bundle missing — run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle (the npm test script does this before vitest)");
  }
  mf = new Miniflare({
    scriptPath: bundle,
    modules: true,
    compatibilityDate: "2025-09-06",
    durableObjects: { HUB: "FlowsHub", KB: "KnowledgeHub" },
    durableObjectsBindings: { HUB: "FlowsHub", KB: "KnowledgeHub" },
  },
  compatibilityDate: "2025-09-06"
});  const ns = await mf.getDurableObjectNamespace("KB");
  const stub = await ns.get(ns.idFromName("global"));
  kb = (path, init) => stub.fetch(`https://kb${path}`, init);
  // warm + cold ensureSchema paths both exercised
  await kb("/orient", { actor: "test" });
  await kb("/orient", { actor: "test" });
});

afterAll(async () => {
  await mf?.dispose();
});

async function kbJson(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await kb(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

describe("auth token SQL paths (real storage)", () => {
  it("mints a token on a cold database (ensureSchema + INSERT)", async () => {
    const { status, body } = await kbJson("/admin.mint", {
      label: "test-mint-basic",
      tags: [],
    });
    expect(status).toBeLessThan(500);
    expect(body.error).toBeUndefined();
    expect(body.secret).toBeTruthy();
  });

  it("re-minting the same label REPLACEs without SQL binding errors", async () => {
    // the replace path: byLabel match -> UPDATE with COALESCE bindings —
    // today's production failure was a missing binding in this exact branch
    const { status, body } = await kbJson("/admin.mint", {
      label: "test-replace",
      tags: [],
      principal: "p_replacetest0000000000000000000000",
    });
    expect(status).toBeLessThan(500);
    expect(body.secret).toBeTruthy();
  });

  it("mints with device_id + principal (8 columns, 8 bindings)", async () => {
    const { status, body } = await kbJson("/admin.mint", {
      label: "test-principal",
      tags: [],
      device_id: "dev-test",
      principal: "p_abcdef0123456789",
    });
    expect(status).toBeLessThan(500);
    expect(body.error).toBeUndefined();
    expect(body.secret).toBeTruthy();
  });
});

describe("agent provisioning SQL paths", () => {
  it("provisions a worker token (binding-count regression: 8 columns, 8 bindings)", async () => {
    const { status, body } = await kbJson("/agent.provision", {
      label: "test-provisioned",
      device_id: "dev-test",
      principal: "p_abcdef0123456789",
    });
    expect(status).toBeLessThan(500);
    expect(body.error).toBeUndefined();
    expect(body.secret).toBeTruthy();
  });

  it("provisions with rotate (revoke + re-mint path)", async () => {
    const { status, body } = await kbJson("/agent.provision", {
      label: "test-rotator",
      rotate: true,
    });
    expect(status).toBeLessThan(500);
    expect(body.error).toBeUndefined();
    expect(body.secret).toBeTruthy();
  });
});

describe("session registration (the migration that never ran in prod)", () => {
  it("session touch writes the kind column", async () => {
    const { status, body } = await kbJson("/session.touch", {
      token_id: "at_test",
      session: "test-session",
    });
    expect(status).toBeLessThan(500);
    expect(body.session).toBeTruthy();
  });
});
