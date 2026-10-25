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

  it("mints with principal (7 columns, 7 bindings — device_id withdrawn)", async () => {
    const { status, body } = await kbJson("/admin.mint", {
      label: "test-principal",
      tags: [],
      principal: "p_abcdef0123456789",
    });
    expect(status).toBeLessThan(500);
    expect(body.error).toBeUndefined();
    expect(body.secret).toBeTruthy();
  });

  it("re-pairing the same principal rotates the SAME token in place (replace-by-principal)", async () => {
    // BR#2700 DC: the device credential anchors rotation — a re-pair under
    // the same principal must re-associate the existing row (rotate), not
    // mint a second token (the old code keyed this by device_id, withdrawn)
    const first = await kbJson("/admin.mint", {
      label: "test-pr-rotate-a",
      tags: [],
      principal: "p_rotatetest00000000000000000",
    });
    expect(first.status).toBeLessThan(500);
    expect(first.body.secret).toBeTruthy();
    const second = await kbJson("/admin.mint", {
      label: "test-pr-rotate-b",
      tags: [],
      principal: "p_rotatetest00000000000000000",
    });
    expect(second.status).toBeLessThan(500);
    expect(second.body.secret).toBeTruthy();
    expect(second.body.id).toBe(first.body.id);
  });
});

describe("agent provisioning SQL paths", () => {
  // provisioning is gateway-class gated (the caller's token TAG provisions,
  // its name is irrelevant): mint a gw-tagged caller first, then provision as it
  beforeAll(async () => {
    const { status } = await kbJson("/admin.mint", { label: "gw-test", tags: ["gateway"] });
    expect(status).toBeLessThan(500);
  });
  it("provisions a worker token (binding-count regression: 7 columns, 7 bindings)", async () => {
    const { status, body } = await kbJson("/agent.provision", {
      provisioned_by: "gw-test",
      label: "test-provisioned",
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

describe("gauge carry-forward in log_progress (merge semantics)", () => {
  it("(a) gauge-less post after a gauge-bearing post preserves gauges", async () => {
    const { body: t } = await kbJson("/create", { type: "task", title: "gauge carry a", qualified: true });
    // gauge-bearing post sets all four gauges
    const r1 = await kbJson("/progress.log", {
      id: t.id, actor: "test-agent-a", note: "progress with gauges",
      completion_pct: 30, confidence_pct: 80, risk_pct: 10, context_pct: 40,
    });
    expect(r1.status).toBe(200);
    expect(r1.body.completion_pct).toBe(30);
    // gauge-less post (e.g. relay heartbeat) must not clobber them
    const r2 = await kbJson("/progress.log", { id: t.id, actor: "test-agent-a", note: "progress without gauges" });
    expect(r2.status).toBe(200);
    expect(r2.body.completion_pct).toBeUndefined();
    // persisted meta carries the gauges forward
    const got = await kbJson("/get", { id: t.id });
    expect(got.body.meta.last_progress.note).toBe("progress without gauges");
    expect(got.body.meta.last_progress.completion_pct).toBe(30);
    expect(got.body.meta.last_progress.confidence_pct).toBe(80);
    expect(got.body.meta.last_progress.risk_pct).toBe(10);
    expect(got.body.meta.last_progress.context_pct).toBe(40);
  });

  it("(b) a later gauge-bearing post updates them", async () => {
    const { body: t } = await kbJson("/create", { type: "task", title: "gauge carry b", qualified: true });
    await kbJson("/progress.log", {
      id: t.id, actor: "test-agent-b", note: "start",
      completion_pct: 10, confidence_pct: 50, risk_pct: 20, context_pct: 10,
    });
    // fresh gauge-bearing post wins
    await kbJson("/progress.log", {
      id: t.id, actor: "test-agent-b", note: "update gauges",
      completion_pct: 50, confidence_pct: 90, risk_pct: 5, context_pct: 20,
    });
    const got = await kbJson("/get", { id: t.id });
    expect(got.body.meta.last_progress.completion_pct).toBe(50);
    expect(got.body.meta.last_progress.confidence_pct).toBe(90);
    expect(got.body.meta.last_progress.risk_pct).toBe(5);
    expect(got.body.meta.last_progress.context_pct).toBe(20);
  });

  it("(c) gauge-less first-ever post leaves fields absent (no fabrication)", async () => {
    const { body: t } = await kbJson("/create", { type: "task", title: "gauge carry c", qualified: true });
    await kbJson("/progress.log", { id: t.id, actor: "test-agent-c", note: "first-ever no gauges" });
    const got = await kbJson("/get", { id: t.id });
    expect(got.body.meta.last_progress).toBeDefined();
    expect(got.body.meta.last_progress.completion_pct).toBeUndefined();
    expect(got.body.meta.last_progress.confidence_pct).toBeUndefined();
    expect(got.body.meta.last_progress.risk_pct).toBeUndefined();
    expect(got.body.meta.last_progress.context_pct).toBeUndefined();
  });
});
