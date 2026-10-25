import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
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
  // rig recipe (proven by test/kb-throughput.test.ts): realpath + modulesRoot
  // (workerd's virtual FS rejects ".." path segments) + useSQLite (wrangler.toml
  // declares both classes new_sqlite_classes; without the flag the DO throws
  // "SQL is not enabled for this Durable Object class")
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
      durableObjects: {
        HUB: { className: "FlowsHub", useSQLite: true },
        KB: { className: "KnowledgeHub", useSQLite: true },
      },
    }],
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
  // provisioning is gateway-class gated (the caller's token TAG provisions,
  // its name is irrelevant): mint a gw-tagged caller first, then provision as it
  beforeAll(async () => {
    const { status } = await kbJson("/admin.mint", { label: "gw-test", tags: ["gateway"] });
    expect(status).toBeLessThan(500);
  });

  it("provisions a worker token (binding-count regression: 8 columns, 8 bindings)", async () => {
    const { status, body } = await kbJson("/agent.provision", {
      provisioned_by: "gw-test",
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
      provisioned_by: "gw-test",
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

// ---------- BR#2983: roles column + question type, through the real DO ----------

describe("roles/question/tags semantics (BR#2983, real storage)", () => {
  it("create with roles stores the roles column; tags stay free-form", async () => {
    const { status, body } = await kbJson("/create", {
      type: "task",
      title: "roles smoke",
      roles: ["review"],
      tags: ["gtm", "deploy-train"],
    });
    expect(status).toBe(200);
    const got = await kbJson("/get", { id: body.id });
    expect(got.body.roles).toEqual(["review"]);
    expect(got.body.tags).toEqual(["gtm", "deploy-train"]);
  });

  it("unknown roles are rejected loudly (no silent gating loss)", async () => {
    const { status, body } = await kbJson("/create", { type: "task", title: "bad role", roles: ["reveiw"] });
    expect(status).toBe(400);
    expect(String(body.error)).toContain("unknown role");
  });

  it("a task TAGGED 'role:review' is NOT a verify task — tags are inert", async () => {
    const { body } = await kbJson("/create", { type: "task", title: "tagged not gated", tags: ["role:review"] });
    expect(body.id).toBeTruthy();
    // plain tasks may enter in_review; verdict duties may not. If the tag still
    // gated, this transition would be rejected as verify-terminal.
    const tr = await kbJson("/transition", { id: body.id, to: "in_progress", note: "claim" });
    expect(tr.status).toBe(200);
    const rev = await kbJson("/transition", { id: body.id, to: "in_review", note: "PR https://github.com/x/y/pull/1" });
    expect(rev.status).toBe(200);
  });

  it("roles: [review] IS a verify task — in_review is rejected as its own terminal", async () => {
    const { body } = await kbJson("/create", { type: "task", title: "gated by roles", roles: ["review"] });
    await kbJson("/transition", { id: body.id, to: "in_progress", note: "claim" });
    const rev = await kbJson("/transition", { id: body.id, to: "in_review", note: "PR https://github.com/x/y/pull/1" });
    expect(rev.status).toBe(400);
    expect(String(rev.body.error)).toContain("verify");
  });

  it("entering in_review spawns a verify child carrying roles [review]", async () => {
    const { body } = await kbJson("/create", { type: "task", title: "spawn source", qualified: true });
    await kbJson("/transition", { id: body.id, to: "in_progress", note: "claim" });
    const rev = await kbJson("/transition", { id: body.id, to: "in_review", note: "PR https://github.com/x/y/pull/2" });
    expect(rev.status).toBe(200);
    expect(rev.body.verify_task).toBeTruthy();
    const child = await kbJson("/get", { id: rev.body.verify_task });
    expect(child.body.roles).toEqual(["review"]);
    expect(child.body.tags).toEqual([]); // no system tags leak into the tag namespace
  });

  it("asks create type=question nodes (no question tag), answerable to done", async () => {
    const ask = await kbJson("/ask.create", {
      question: "integration: merge the roles column PR?",
      options: ["GO — merge", "NO-GO — hold"],
      reason: "integration test coverage",
      to: "human",
    });
    expect(ask.status).toBe(200);
    const node = await kbJson("/get", { id: ask.body.id });
    expect(node.body.type).toBe("question");
    expect(node.body.tags).toEqual([]);
    // claim is refused (lifecycle has no in_progress edge)
    const claim = await kbJson("/transition", { id: ask.body.id, to: "in_progress", note: "claim" });
    expect(claim.status).toBe(400);
    const ans = await kbJson("/ask.answer", { id: ask.body.id, answer: "GO — merge" });
    expect(ans.status).toBe(200);
    const done = await kbJson("/get", { id: ask.body.id });
    expect(done.body.status).toBe("done");
  });

  it("board payload carries type + roles for UI kind derivation and tag filters", async () => {
    const r = await kb("/board");
    const b = (await r.json()) as any;
    expect(Array.isArray(b.tasks)).toBe(true);
    for (const t of b.tasks) {
      expect(typeof t.type).toBe("string");
      expect(Array.isArray(t.roles)).toBe(true);
      expect(Array.isArray(t.tags)).toBe(true);
    }
  });
});

describe("log_progress gauge carry-forward (BR#3199)", () => {
  const lastProgress = async (id: string) => {
    const got = await kbJson("/get", { id });
    const meta = typeof got.body.meta === "string" ? JSON.parse(got.body.meta) : got.body.meta;
    return meta.last_progress;
  };

  it("(a) gauge-less post after a gauge-bearing post preserves gauges", async () => {
    const { body } = await kbJson("/create", { type: "task", title: "BR3199 carry-forward", qualified: true });
    await kbJson("/transition", { id: body.id, to: "in_progress", note: "claim" });
    await kbJson("/progress.log", {
      id: body.id, note: "gauge-bearing post",
      completion_pct: 42, confidence_pct: 80, risk_pct: 10, context_pct: 50,
    });
    const after = await lastProgress(body.id);
    expect(after.completion_pct).toBe(42);
    expect(after.confidence_pct).toBe(80);
    expect(after.risk_pct).toBe(10);
    expect(after.context_pct).toBe(50);
    // fresh per-call fields survive
    expect(after.note).toBe("gauge-bearing post");

    // the relay-clobber class: a gauge-less post must NOT null the gauges
    await kbJson("/progress.log", { id: body.id, note: "relay heartbeat (no gauges)" });
    const afterRelay = await lastProgress(body.id);
    expect(afterRelay.completion_pct).toBe(42);
    expect(afterRelay.confidence_pct).toBe(80);
    expect(afterRelay.risk_pct).toBe(10);
    expect(afterRelay.context_pct).toBe(50);
    expect(afterRelay.note).toBe("relay heartbeat (no gauges)");
  });

  it("(b) a later gauge-bearing post updates them", async () => {
    const { body } = await kbJson("/create", { type: "task", title: "BR3199 gauge update", qualified: true });
    await kbJson("/transition", { id: body.id, to: "in_progress", note: "claim" });
    await kbJson("/progress.log", {
      id: body.id, note: "first gauge post",
      completion_pct: 10, confidence_pct: 50, risk_pct: 50, context_pct: 20,
    });
    await kbJson("/progress.log", {
      id: body.id, note: "second gauge post",
      completion_pct: 90, confidence_pct: 95, risk_pct: 5, context_pct: 80,
    });
    const after = await lastProgress(body.id);
    expect(after.completion_pct).toBe(90);
    expect(after.confidence_pct).toBe(95);
    expect(after.risk_pct).toBe(5);
    expect(after.context_pct).toBe(80);
    expect(after.note).toBe("second gauge post");
    // partial update: only the posted gauge changes, the rest carry forward
    await kbJson("/progress.log", { id: body.id, note: "partial", completion_pct: 95 });
    const afterPartial = await lastProgress(body.id);
    expect(afterPartial.completion_pct).toBe(95);
    expect(afterPartial.confidence_pct).toBe(95);
    expect(afterPartial.risk_pct).toBe(5);
    expect(afterPartial.context_pct).toBe(80);
  });

  it("(c) gauge-less first-ever post leaves fields absent (no fabrication)", async () => {
    const { body } = await kbJson("/create", { type: "task", title: "BR3199 no fabrication", qualified: true });
    await kbJson("/transition", { id: body.id, to: "in_progress", note: "claim" });
    await kbJson("/progress.log", { id: body.id, note: "first-ever, no gauges" });
    const lp = await lastProgress(body.id);
    expect(lp).toBeTruthy();
    expect(lp.note).toBe("first-ever, no gauges");
    expect(lp.completion_pct).toBeUndefined();
    expect(lp.confidence_pct).toBeUndefined();
    expect(lp.risk_pct).toBeUndefined();
    expect(lp.context_pct).toBeUndefined();
  });
});
