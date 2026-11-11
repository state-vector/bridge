import { Miniflare } from "miniflare";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkStorageBudget, parseTags, utf8Bytes } from "../src/kb/core.ts";
import { executorRequest } from "./executor-fixture";

/**
 * BR#11637 — the tags-column accretion disease behind BR#10150's 4.19MB row.
 *
 * update_artefact kept the RAW tags column string when the caller omitted
 * tags (every meta-only update — refire-receipt stamps), then bound
 * JSON.stringify(that string): JSON-on-JSON re-encoding, escaping roughly
 * doubling per write. ~35 refire updates turned BR#10150's tags column into
 * ~4.19MB — invisible (row_bytes counted meta+title+body only; defensive
 * parseTags renders the accreted column as [] on every surface) and
 * unhealable (artefact_slim re-INSERTed the raw columns verbatim and
 * budgeted them raw, so THE unlock op refused its own cure).
 *
 * Four legs pinned here:
 * 1. WRITER (do.ts update): the omitted-tags passthrough normalizes via
 *    parseTags before binding — accretion stops, the column heals on the
 *    next write. Integration: repeated meta-only updates keep the row flat.
 * 2. HEAL (core.ts parseTags): normalization collapses any wrap depth back
 *    to the canonical array, and stringify∘parseTags is a fixed point.
 * 3. UNLOCK (do.ts artefact_slim): tags+roles are normalized before the
 *    re-INSERT and the budget checks the NORMALIZED row — slim can unlock
 *    rows bloated outside meta; receipts carry old→new byte counts.
 * 4. HONEST READ (do.ts get): row_bytes includes the tags+roles column
 *    bytes, matching the gate's own definition, so headroom is real.
 */

// ---------- wiring (source pins, br11554 test style) ----------

describe("BR#11637 leg 1 — the update_artefact passthrough normalizes", () => {
  const src = readFileSync(new URL("../src/kb/do.ts", import.meta.url).pathname, "utf8");
  it("omitted tags normalize via parseTags — no raw column passthrough (mirrors the roles line)", () => {
    expect(src).toMatch(/const tags = body\.tags !== undefined \? sanitizeTags\(body\.tags\) : parseTags\(row\.tags\)/);
    expect(src).not.toMatch(/sanitizeTags\(body\.tags\) : row\.tags/);
  });
  it("both tags bind sites guard on length — a normalized-empty column binds NULL, not \"[]\"", () => {
    expect((src.match(/tags && tags\.length \? JSON\.stringify\(tags\) : null/g) ?? []).length).toBe(2);
  });
});

// ---------- pure core: the heal is canonical and idempotent ----------

/** Reproduce the ACCRETION writer: binding JSON.stringify(raw column string)
 *  wraps already-encoded JSON one layer per write. Returns the column after
 *  k such writes, starting from a canonical 2-tag row. */
function accreteLegacy(start: string, k: number): string {
  let col: unknown = start;
  for (let i = 0; i < k; i++) col = JSON.stringify(col); // the old bug: stringify of a STRING
  return String(col);
}

describe("BR#11637 leg 2 — parseTags canonicalizes any wrap depth (the heal)", () => {
  it("a deeply accreted column collapses back to the canonical array", () => {
    const canonical = JSON.stringify(["br11554", "p0"]);
    // 18 wraps ≈ the BR#10150 scale (~4.4MB from a 17B row — the 35-wrap real
    // case is exponential, so the rig stops where strings stay constructible)
    const accreted = accreteLegacy(canonical, 18);
    expect(utf8Bytes(accreted)).toBeGreaterThan(utf8Bytes(canonical) * 1000); // it really did balloon
    expect(parseTags(accreted)).toEqual(["br11554", "p0"]);
  });

  it("stringify∘parseTags is a fixed point — repeated meta-only writes cannot grow the column", () => {
    const canonical = JSON.stringify(["br11554", "p0"]);
    let col: string = canonical;
    const sizes: number[] = [];
    for (let i = 0; i < 12; i++) {
      col = JSON.stringify(parseTags(col)); // exactly what the fixed update path binds
      sizes.push(utf8Bytes(col));
    }
    expect(new Set(sizes).size).toBe(1);
    expect(sizes[0]).toBe(utf8Bytes(canonical));
  });

  it("the legacy writer demonstrably accretes (the contrast case, kept as a regression mirror)", () => {
    const canonical = JSON.stringify(["a", "b"]);
    const one = accreteLegacy(canonical, 1);
    const two = accreteLegacy(canonical, 2);
    expect(utf8Bytes(two)).toBeGreaterThan(utf8Bytes(one));
  });
});

// ---------- pure core: the budget gate unlocks the NORMALIZED row ----------

describe("BR#11637 leg 3a — the budget gate on normalized tags unlocks what the raw column locks", () => {
  it("checkStorageBudget refuses the accreted raw column (the slim lockout) but passes the normalized row", () => {
    const canonical = JSON.stringify(["br10150", "p0", "storage-ceiling"]);
    const raw = accreteLegacy(canonical, 20); // >60KB of escaping, same information
    expect(utf8Bytes(raw)).toBeGreaterThan(60_000);
    const locked = checkStorageBudget("t", "body", "{}", raw, null);
    expect(locked).toMatch(/storage budget: row is/);
    const normalized = JSON.stringify(parseTags(raw));
    expect(checkStorageBudget("t", "body", "{}", normalized, null)).toBeNull();
  });

  it("the gate error names per-component bytes — one readable error, no calibration probes", () => {
    const err = checkStorageBudget("t", "b".repeat(60_000), JSON.stringify({ a: 1 }), '["x"]', '["impl"]');
    expect(err).toMatch(/storage budget: row is/);
    expect(err).toMatch(/title=1B body=60000B meta=7B tags=5B roles=8B/);
    expect(err).toMatch(/LIMITS\.rowBytes/);
    expect(err).toMatch(/artefact_slim/); // the tags/roles cure is named
    expect(err).toMatch(/permanently write-locked/); // legacy actionable tail kept
  });
});

// ---------- integration: the real DO on real SQLite (do.test.ts rig) ----------

let mf: Miniflare;
let kb: (path: string, init?: RequestInit) => Promise<Response>;

async function bootKb() {
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function kbJson(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await kb(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" },
    body: JSON.stringify(executorRequest(body)),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

beforeAll(async () => {
  const booted = await bootKb();
  mf = booted.instance;
  kb = booted.kb;
  await kbJson("/orient", { actor: "test" });
});

afterAll(async () => {
  await mf?.dispose();
});

describe("BR#11637 leg 1+4 integration — meta-only updates are byte-flat and row_bytes is honest", () => {
  it("repeated meta-only updates do NOT grow the row (tags column flat across writes)", async () => {
    const created = await kbJson("/create", {
      type: "task", title: "BR#11637 accretion regression", body_md: "seed",
      tags: ["br11637", "p0"], actor: "test",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const id = created.body.id;
    // baseline AFTER the first receipt stamp: that write legitimately adds the
    // meta key (one-time +20B); the accretion bug is about REPEATED writes
    const u1 = await kbJson("/update", { id, actor: "test", meta: { receipt: "stamp-0" } });
    expect(u1.status, JSON.stringify(u1.body)).toBe(200);
    const base = (await kbJson("/get", { id })).body.row_bytes;
    expect(base).toBeGreaterThan(0);
    // 5 more meta-only updates — the BR#10150 refire-receipt shape
    for (let i = 1; i < 6; i++) {
      const u = await kbJson("/update", { id, actor: "test", meta: { receipt: `stamp-${i}` } });
      expect(u.status, JSON.stringify(u.body)).toBe(200);
    }
    const r1 = await kbJson("/get", { id });
    // row_bytes includes tags+roles now — if the passthrough still accreted,
    // five writes would roughly double the tags column per write and blow this
    // away; flat across 5 writes pins the fix end-to-end.
    expect(r1.body.row_bytes).toBe(base);
    expect(r1.body.tags).toEqual(["br11637", "p0"]);
  });

  it("row_bytes includes the tags+roles column bytes exactly (headroom is honest)", async () => {
    const created = await kbJson("/create", {
      type: "task", title: "BR#11637 row_bytes honesty", body_md: "seed",
      tags: ["a"], roles: ["impl"], actor: "test",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const id = created.body.id;
    const before = (await kbJson("/get", { id })).body.row_bytes;
    // tags-only swap (a roles change would stamp meta.work_revision and move
    // meta_bytes too): '["a"]' (5B) → '["bb","cc"]' (11B). A row_bytes that
    // ignores the tags column reports NO change; the honest one reports +6B.
    const u = await kbJson("/update", { id, actor: "test", tags: ["bb", "cc"] });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    const after = (await kbJson("/get", { id })).body.row_bytes;
    expect(after - before).toBe(utf8Bytes('["bb","cc"]') - utf8Bytes('["a"]'));
  });
});

describe("BR#11637 leg 3 integration — artefact_slim normalizes tags/roles and stamps byte receipts", () => {
  it("slim succeeds on a tags-bearing row, returns + stamps old→new tag/role byte counts", async () => {
    const snap = await kbJson("/create", {
      type: "task", title: "BR#11637 slim snapshot archive", body_md: "verbatim pre-slim archive",
      actor: "test",
    });
    expect(snap.status, JSON.stringify(snap.body)).toBe(200);
    const snapshotId = snap.body.id;
    const created = await kbJson("/create", {
      type: "task", title: "BR#11637 slim heal", body_md: "body",
      tags: ["br11637", "unlock"], roles: ["impl"], meta: { receipt: "x".repeat(2000) },
      actor: "test",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const id = created.body.id;
    const slim = await kbJson("/slim", {
      id, meta: { receipt_ptr: "see snapshot" }, ack_snapshot: snapshotId, actor: "test",
    });
    expect(slim.status, JSON.stringify(slim.body)).toBe(200);
    expect(slim.body.old_tags_bytes).toBe(utf8Bytes('["br11637","unlock"]'));
    expect(slim.body.new_tags_bytes).toBe(utf8Bytes('["br11637","unlock"]'));
    expect(slim.body.old_roles_bytes).toBe(utf8Bytes('["impl"]'));
    expect(slim.body.new_roles_bytes).toBe(utf8Bytes('["impl"]'));
    const after = await kbJson("/get", { id });
    expect(after.body.tags).toEqual(["br11637", "unlock"]);
    expect(after.body.roles).toEqual(["impl"]);
    const rec = after.body.meta.slim_record;
    expect(rec.old_tags_bytes).toBe(utf8Bytes('["br11637","unlock"]'));
    expect(rec.new_tags_bytes).toBe(utf8Bytes('["br11637","unlock"]'));
    expect(rec.old_roles_bytes).toBe(utf8Bytes('["impl"]'));
    expect(rec.new_roles_bytes).toBe(utf8Bytes('["impl"]'));
  });
});
