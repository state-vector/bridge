import { Miniflare } from "miniflare";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executorRequest } from "./executor-fixture";

/**
 * BR#14413 — hub read-path performance: conditional GET on the DO data plane.
 *
 * GET /artefacts is the board's hottest route (30s polls per open tab re-ran
 * the full list() query + JSON serialize on every call, no-store, no ETag /
 * If-None-Match / 304 anywhere). On a single-threaded Durable Object every
 * poll queued behind writes — read amplification on the exact object serving
 * all agent traffic.
 *
 * The fix: weak ETags derived from trigger-maintained content revision
 * counters (artefact_rev). The DATABASE maintains the counter — artefact
 * writes are scattered across dozens of call sites, so the invalidation lives
 * where no writer can forget it. Legs pinned here:
 *
 * 1. COUNTER WIRING (source pins): artefact_rev table + triggers on every
 *    table the board read paths project; 'board' scope for /artefacts, 'wide'
 *    adds execution_state + delivery_admissions for /get.
 * 2. POLL LOOP (integration): poll → 200 + ETag; revalidate → 304 empty body;
 *    mutate → same If-None-Match → 200 + NEW ETag + updated content.
 * 3. TAG SPECIFICITY: the query string is folded into the /artefacts tag and
 *    the id into the /artefact tag — a validator can never cross-match between
 *    filters or resources (a false 304 serves stale/foreign bytes).
 * 4. PROXY PLANE: the bearer list mirror forwards if-none-match; kbCors
 *    exposes etag and allows if-none-match so browser/desktop clients can
 *    actually run the revalidation loop.
 */

// ---------- leg 1: source pins ----------

describe("BR#14413 leg 1 — trigger-maintained content revisions (source pins)", () => {
  const src = readFileSync(new URL("../src/kb/do.ts", import.meta.url).pathname, "utf8");

  it("artefact_rev table exists with board + wide scopes seeded", () => {
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS artefact_rev/);
    expect(src).toMatch(/VALUES \('board', 0\), \('wide', 0\)/);
  });

  it("every artefact write arm bumps board (insert / update / delete)", () => {
    expect(src).toMatch(/CREATE TRIGGER IF NOT EXISTS artefacts_rev_insert AFTER INSERT ON artefacts/);
    expect(src).toMatch(/CREATE TRIGGER IF NOT EXISTS artefacts_rev_update AFTER UPDATE ON artefacts/);
    expect(src).toMatch(/CREATE TRIGGER IF NOT EXISTS artefacts_rev_delete AFTER DELETE ON artefacts/);
  });

  it("relations + lane overlay + ledger mutations + owner labels bump board", () => {
    expect(src).toMatch(/CREATE TRIGGER IF NOT EXISTS relations_rev_insert AFTER INSERT ON relations/);
    expect(src).toMatch(/CREATE TRIGGER IF NOT EXISTS relations_rev_delete AFTER DELETE ON relations/);
    // lane_cards is a VIEW over lane_state x artefacts — the overlay moves when lane_state moves
    expect(src).toMatch(/CREATE TRIGGER IF NOT EXISTS lane_state_rev_insert AFTER INSERT ON lane_state/);
    expect(src).toMatch(/CREATE TRIGGER IF NOT EXISTS lane_state_rev_update AFTER UPDATE ON lane_state/);
    // consensus reads the ledger directly — a progress write touching no artefact row still changes list output
    expect(src).toMatch(/AFTER INSERT ON ledger WHEN new\.kind = 'mutation'/);
    // displayOwner resolves labels from auth_tokens — last_seen churn must NOT bump
    expect(src).toMatch(/AFTER UPDATE OF label, principal, revoked_ts ON auth_tokens/);
  });

  it("wide scope covers exactly the /get-only projections", () => {
    expect(src).toMatch(/CREATE TRIGGER IF NOT EXISTS execution_state_rev_insert AFTER INSERT ON execution_state/);
    expect(src).toMatch(/AFTER UPDATE OF state, worker_token_id ON execution_state/);
    expect(src).toMatch(/CREATE TRIGGER IF NOT EXISTS delivery_admissions_rev_insert AFTER INSERT ON delivery_admissions/);
    expect(src).toMatch(/CREATE TRIGGER IF NOT EXISTS delivery_admissions_rev_update AFTER UPDATE ON delivery_admissions/);
  });

  it("GET /artefacts folds query params into the tag and short-circuits before list()", () => {
    expect(src).toMatch(/case "\/artefacts": \{[\s\S]*?ifNoneMatchHit\(request\.headers\.get\("if-none-match"\), etag\)\) return this\.notModified\(etag\);[\s\S]*?await this\.list\(/);
  });

  it("GET /artefact folds board+wide revisions AND the id into the tag", () => {
    expect(src).toMatch(/one\$\{this\.contentRev\("board"\)\}\.\$\{this\.contentRev\("wide"\)\}/);
  });

  it("the proxy plane carries the validator (worker index.js)", () => {
    const idx = readFileSync(new URL("../src/index.js", import.meta.url).pathname, "utf8");
    expect(idx).toMatch(/kb-machine\/list[\s\S]*?if-none-match/);
    expect(idx).toMatch(/Access-Control-Expose-Headers", "etag"/);
    expect(idx).toMatch(/Access-Control-Allow-Headers", "authorization, content-type, if-none-match"/);
  });

  it("the ui-kit client revalidates with the cached etag and serves 304s from cache", () => {
    const kb = readFileSync(new URL("../../ui-kit/src/server/kb.ts", import.meta.url).pathname, "utf8");
    expect(kb).toMatch(/headers\.set\("if-none-match", cached\.etag\)/);
    expect(kb).toMatch(/r\.status === 304 && cached\) return cached\.body as T/);
  });
});

// ---------- legs 2-3: integration on real miniflare SQLite ----------

let mf: Miniflare;
let kb: (path: string, init?: RequestInit) => Promise<Response>;

async function bootKb() {
  // Same rig as do.test.ts: the wrangler bundle on real workerd SQLite.
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  if (!existsSync(bundle)) {
    throw new Error("bundle missing — run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle (the npm test script does this before vitest)");
  }
  const instance = new Miniflare({
    workers: [{
      name: "main",
      scriptPath: bundle,
      modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")),
      modules: true,
      compatibilityDate: "2025-09-06",
      durableObjects: {
        HUB: { className: "FlowsHub", useSQLite: true },
        KB: { className: "KnowledgeHub", useSQLite: true },
      },
    }],
  });
  const ns = await instance.getDurableObjectNamespace("KB");
  const stub = await ns.get(ns.idFromName("global"));
  return { instance, kb: (path: string, init?: RequestInit) => stub.fetch(`https://kb${path}`, init) };
}

beforeAll(async () => {
  const booted = await bootKb();
  mf = booted.instance;
  kb = booted.kb;
  await kb("/orient", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor: "br14413" }) });
});

afterAll(async () => {
  await mf?.dispose();
});

async function kbJson(path: string, body: unknown): Promise<{ status: number; body: any; headers: Headers }> {
  const r = await kb(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" },
    body: JSON.stringify(executorRequest(body)),
  });
  return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
}

describe("BR#14413 legs 2-3 — the poll loop on the live DO", () => {
  it("poll → 200 + etag → revalidate → 304 → mutate → 200 + new etag", async () => {
    const created = await kbJson("/create", { type: "steering", title: "BR#14413 poll fixture", body_md: "v1", actor: "br14413" });
    expect(created.status).toBe(200);
    const id = String(created.body.id);

    const first = await kb(`/artefacts?limit=50`, { method: "GET" });
    expect(first.status).toBe(200);
    const etag1 = first.headers.get("etag");
    expect(etag1).toMatch(/^W\//);
    const body1: any = await first.json();
    expect(body1.artefacts.some((a: any) => a.id === id)).toBe(true);
    expect(first.headers.get("cache-control")).toContain("no-store");

    // the unchanged re-poll: 304, empty body, same tag echoed
    const revalidate = await kb(`/artefacts?limit=50`, { method: "GET", headers: { "if-none-match": etag1! } });
    expect(revalidate.status).toBe(304);
    expect(await revalidate.text()).toBe("");
    expect(revalidate.headers.get("etag")).toBe(etag1);

    // mutation: the SAME validator must now miss
    const updated = await kbJson("/update", { id, title: "BR#14413 poll fixture v2", actor: "br14413" });
    expect(updated.status).toBe(200);
    const after = await kb(`/artefacts?limit=50`, { method: "GET", headers: { "if-none-match": etag1! } });
    expect(after.status).toBe(200);
    const etag2 = after.headers.get("etag");
    expect(etag2).toBeTruthy();
    expect(etag2).not.toBe(etag1);
    const body2: any = await after.json();
    expect(body2.artefacts.find((a: any) => a.id === id)?.title).toBe("BR#14413 poll fixture v2");

    // and the new tag revalidates clean
    const revalidate2 = await kb(`/artefacts?limit=50`, { method: "GET", headers: { "if-none-match": etag2! } });
    expect(revalidate2.status).toBe(304);
  });

  it("an etag for one filter never validates a different filter", async () => {
    const unfiltered = await kb(`/artefacts`, { method: "GET" });
    expect(unfiltered.status).toBe(200);
    const etag = unfiltered.headers.get("etag")!;
    const taskOnly = await kb(`/artefacts?type=task`, { method: "GET", headers: { "if-none-match": etag } });
    expect(taskOnly.status).toBe(200);
    expect(taskOnly.headers.get("etag")).not.toBe(etag);
  });

  it("/get: revalidates per id — same id 304s until a write, other ids never match", async () => {
    const a = await kbJson("/create", { type: "steering", title: "BR#14413 get A", body_md: "a", actor: "br14413" });
    const b = await kbJson("/create", { type: "steering", title: "BR#14413 get B", body_md: "b", actor: "br14413" });
    const idA = String(a.body.id);
    const idB = String(b.body.id);

    const first = await kb(`/artefact?id=${encodeURIComponent(idA)}`, { method: "GET" });
    expect(first.status).toBe(200);
    const etagA = first.headers.get("etag");
    expect(etagA).toMatch(/^W\//);

    // unchanged single-card re-read → 304
    const revalidate = await kb(`/artefact?id=${encodeURIComponent(idA)}`, { method: "GET", headers: { "if-none-match": etagA! } });
    expect(revalidate.status).toBe(304);
    expect(await revalidate.text()).toBe("");

    // the SAME validator against card B must NOT 304 (id is folded into the tag)
    const cross = await kb(`/artefact?id=${encodeURIComponent(idB)}`, { method: "GET", headers: { "if-none-match": etagA! } });
    expect(cross.status).toBe(200);

    // a write to the card (meta-only) flips the tag
    await kbJson("/update", { id: idA, meta: { br14413_probe: 1 }, actor: "br14413" });
    const after = await kb(`/artefact?id=${encodeURIComponent(idA)}`, { method: "GET", headers: { "if-none-match": etagA! } });
    expect(after.status).toBe(200);
    const fresh: any = await after.json();
    expect((typeof fresh.meta === "string" ? JSON.parse(fresh.meta) : fresh.meta).br14413_probe).toBe(1);
    expect(after.headers.get("etag")).not.toBe(etagA);
  });

  it("a progress-only write (ledger mutation row) invalidates the list tag", async () => {
    const created = await kbJson("/create", { type: "steering", title: "BR#14413 ledger leg", body_md: "x", actor: "br14413" });
    const id = String(created.body.id);
    const first = await kb(`/artefacts?limit=50`, { method: "GET" });
    const etag = first.headers.get("etag")!;
    const logged = await kbJson("/progress.log", { id, note: "ledger-bump probe", did: "probe", actor: "br14413" });
    expect(logged.status).toBe(200);
    const after = await kb(`/artefacts?limit=50`, { method: "GET", headers: { "if-none-match": etag } });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
  });
});
