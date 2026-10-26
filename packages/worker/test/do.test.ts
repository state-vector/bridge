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

  it("BR#3822: ask-bound auto-block stamps awaiting_ask before the fold — no unblock duty spawns, the answer resumes exactly once", async () => {
    const { body: t } = await kbJson("/create", { type: "task", title: "ask-gate suppression source", qualified: true });
    await kbJson("/transition", { id: t.id, to: "in_progress", note: "claim" });

    const ask = await kbJson("/ask.create", {
      question: "Keep the executor lease or release the card?",
      options: ["KEEP — stay parked", "RELEASE — back to the pool"],
      reason: "BR#3822 regression fixture",
      to: "human",
      artefact_id: t.id,
    });
    expect(ask.status).toBe(200);

    // the card auto-blocked, and the marker is ON THE CARD (the key the
    // machine's unblock-spawn gate reads; pre-fix this never existed here)
    const parked = await kbJson("/get", { id: t.id });
    expect(parked.body.status).toBe("blocked");
    expect(parked.body.meta.awaiting_ask?.ask_id).toBe(ask.body.id);
    expect(parked.body.meta.blocked?.await_event?.event).toBe("ask");

    // suppression: no unblock/sweep duty child spawned with the block
    const parkedRels = await kbJson("/relations", { id: t.id });
    const parkedChildren = (parkedRels.body.relations ?? []).filter((r: any) => r.dir === "in");
    const parkedDuties: any[] = [];
    for (const r of parkedChildren) {
      const c = await kbJson("/get", { id: r.artefact_id });
      if (c.body.type === "task" && c.body.roles.includes("unblock") && !["done", "superseded"].includes(c.body.status)) {
        parkedDuties.push(c.body.id);
      }
    }
    expect(parkedDuties).toEqual([]);

    // answering the ask resumes the card exactly once and clears the marker
    const ans = await kbJson("/ask.answer", { id: ask.body.id, answer: "KEEP — stay parked" });
    expect(ans.status).toBe(200);
    expect(ans.body.task_status).toBe("in_progress");

    const resumed = await kbJson("/get", { id: t.id });
    expect(resumed.body.status).toBe("in_progress");
    expect(resumed.body.meta.awaiting_ask).toBeUndefined();

    const hist = await kbJson("/get_history", { id: t.id });
    const resumes = (hist.body.versions ?? []).filter((v: any) => v.action === "transition" && /resumed/.test(String(v.summary ?? "")));
    expect(resumes).toHaveLength(1);

    // still no unblock duty anywhere on the card, before or after the answer
    const finalRels = await kbJson("/relations", { id: t.id });
    const finalChildren = (finalRels.body.relations ?? []).filter((r: any) => r.dir === "in");
    for (const r of finalChildren) {
      const c = await kbJson("/get", { id: r.artefact_id });
      if (c.body.type === "task") expect(c.body.roles.includes("unblock")).toBe(false);
    }
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

// ---------- BR#3463: gauge_debt is a REQUIRED orient contract key ----------

describe("orient always carries gauge_debt (BR#3463 — runner contract key)", () => {
  // The runner's Rust gate (dispatch.rs orient_contract_error) requires the
  // key; the conditional emit (`length ? gaugeDebt : undefined`) dropped it
  // exactly when the board was healthy, and the undefined key vanished from
  // the JSON — "missing gauge_debt" aborted every dispatch tick.

  it("(a) zero debt → the key is PRESENT as [] (the healthy board; absent key = contract breach)", async () => {
    const r = await kbJson("/orient", { label: "debt-zero-agent" });
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty("gauge_debt");
    expect(r.body.gauge_debt).toEqual([]);
  });

  it("(b) in-flight task with no reported gauges → listed as {id, title} in gauge_debt", async () => {
    const { body: t } = await kbJson("/create", { type: "task", title: "gauge debt surfacing BR#3463", qualified: true });
    const claim = await kbJson("/transition", { id: t.id, to: "in_progress", actor: "debt-agent", session: "debt-agent", note: "claim" });
    expect(claim.status).toBe(200);
    // gauge-less post: all four gauges absent → debt per the gauge-debt query
    await kbJson("/progress.log", { id: t.id, actor: "debt-agent", note: "working, no gauges yet" });
    const r = await kbJson("/orient", { label: "debt-agent" });
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty("gauge_debt");
    expect(r.body.gauge_debt).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: t.id, title: "gauge debt surfacing BR#3463" })]),
    );
  });
});

describe("replay consistency (BR#3322, real storage)", () => {
  // /history is a GET-only route (the human-plane mirror); encodeURIComponent
  // because ids carry '#' (BR#123) — raw in a URL it parses as the fragment
  const hist = async (id: string) => {
    const r = await kb(`/history?id=${encodeURIComponent(id)}&limit=200`);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  it("a normal transition chain folds to the stored status — no replay mismatch note, zero chain breaks", async () => {
    const { body: t } = await kbJson("/create", { type: "task", title: "replay probe", qualified: true });
    const claim = await kbJson("/transition", { id: t.id, to: "in_progress", note: "claim" });
    expect(claim.status).toBe(200);
    const rev = await kbJson("/transition", { id: t.id, to: "in_review", note: "PR https://github.com/x/y/pull/9" });
    expect(rev.status).toBe(200);

    const h = await hist(t.id);
    expect(h.status).toBe(200);
    const rows: any[] = h.body.versions ?? [];
    // the replay check runs after every transition — a healthy chain must
    // never leave a mismatch note behind
    const mismatch = rows.filter((r) => String(r.summary ?? "").includes("REPLAY MISMATCH"));
    expect(mismatch).toEqual([]);

    // and the fold of the produced log equals the stored status — the API
    // returns rows newest-first; the fold walks chronologically (replayCheck
    // reverses the same way)
    const { replayStatus } = await import("../src/kb/machine.ts");
    const got = await kbJson("/get", { id: t.id });
    const fold = replayStatus("", rows.slice().reverse().map((v) => ({ action: String(v.action), data: v.data ?? {} })));
    expect(fold.status).toBe(got.body.status);
    expect(fold.breaks).toBe(0);
  });

  it("transition rows chain one-to-one with transitions — no duplicate stamps (BR#3322)", async () => {
    // the duplicate-stamp class (BR#3322): an effect row written AFTER the
    // applied transition row with the same stale from broke the chain on
    // every churn redirect. The invariant under test: one doTransition call
    // → exactly ONE transition row; the log chains with zero breaks.
    const { body: t } = await kbJson("/create", { type: "task", title: "effect stamp probe", qualified: true });
    await kbJson("/transition", { id: t.id, to: "in_progress", note: "claim" });
    await kbJson("/transition", { id: t.id, to: "in_review", note: "PR https://github.com/x/y/pull/10" });
    await kbJson("/transition", { id: t.id, to: "in_progress", note: "bounce" });
    const h = await hist(t.id);
    const rows: any[] = h.body.versions ?? [];
    const transitions = rows.filter((r) => r.action === "transition");
    // 3 transition calls → exactly 3 transition rows (create + progress rows excluded)
    expect(transitions.length).toBe(3);
    // each recorded to chains chronologically (the API returns newest-first):
    // todo → in_progress → in_review → in_progress
    expect(transitions.slice().reverse().map((r) => r.data?.to)).toEqual(["in_progress", "in_review", "in_progress"]);
    const { replayStatus } = await import("../src/kb/machine.ts");
    const fold = replayStatus("", rows.slice().reverse().map((v) => ({ action: String(v.action), data: v.data ?? {} })));
    expect(fold.ok).toBe(true);
    expect(fold.breaks).toBe(0);
  });
});

// ---------- BR#3337: claim races are retryable, never breach storms (real DO) ----------

describe("claim-race storms through the real gate + breach door (BR#3337)", () => {
  const breachCardsFor = async (taskId: string) => {
    const { body } = await kbJson("/list", { type: "task", tag: "breach", limit: 200 });
    return (body.artefacts ?? []).filter((a: any) => String(a.title).includes(taskId));
  };

  it("six rejected claim races on an in_progress card raise NO breach card", async () => {
    const { body: card } = await kbJson("/create", { type: "task", title: "claim-race storm" });
    const claim = await kbJson("/transition", { id: card.id, to: "in_progress", note: "claim", actor: "gateway-a-opencode" });
    expect(claim.status).toBe(200);
    // gateway-b races the claim six times — the lifecycle gate refuses
    // in_progress → in_progress every time (the 2026-10-25 breaker-trip shape)
    for (let i = 0; i < 6; i++) {
      const r = await kbJson("/transition", { id: card.id, to: "in_progress", note: "claim", actor: "gateway-b-opencode" });
      expect(r.status).toBe(400);
      expect(String(r.body.error)).toContain("not allowed");
    }
    const mine = await breachCardsFor(card.id);
    expect(mine).toHaveLength(0);
  });

  it("a genuine gate storm still raises exactly one breach card (control)", async () => {
    const { body: card } = await kbJson("/create", { type: "task", title: "genuine gate storm" });
    await kbJson("/transition", { id: card.id, to: "in_progress", note: "claim", actor: "gateway-a-opencode" });
    // review-needs-pr: three in_review attempts with no PR link in the note —
    // a real gate, a real protocol violation, one breach card at threshold
    for (let i = 0; i < 3; i++) {
      const r = await kbJson("/transition", { id: card.id, to: "in_review", note: "handoff attempt without any receipt", actor: "gateway-a-opencode" });
      expect(r.status).toBe(400);
      expect(String(r.body.error)).toContain("PR link");
    }
    const mine = await breachCardsFor(card.id);
    expect(mine).toHaveLength(1);
    expect(String(mine[0].title)).toContain("gate:review-needs-pr");
  });
});

// ---------- BR#3443: a closed breach card's events never re-fold ----------
// Specimen BR#3439: raised 17:03:22.861Z by a benign fold trigger on BR#3372,
// from 6 events that ALL predate the predecessor card BR#3427's close
// (16:30:45.674Z) — the fold suppressed per key ONLY while a card is open, so
// closing re-armed the key and the same adjudicated events re-qualified.
describe("breach fold high-water: closed cards never re-raise stale events (BR#3443)", () => {
  const breachCardsFor = async (taskId: string) => {
    const { body } = await kbJson("/list", { type: "task", tag: "breach", limit: 200 });
    return (body.artefacts ?? []).filter((a: any) => String(a.title).includes(taskId));
  };

  /** Close a breach card through the real gates: the done-unreviewed gate
   *  demands review evidence (a done review-role child first), the lifecycle
   *  demands a claim before done, and the close cites its investigation. */
  const closeBreachCard = async (cardId: string) => {
    const { body: child } = await kbJson("/create", { type: "task", title: `verify ${cardId}`, roles: ["review"] });
    const linked = await kbJson("/link", { src: child.id, relation: "child_of", dst: cardId });
    expect(linked.status).toBe(200);
    const claim = await kbJson("/transition", { id: child.id, to: "in_progress", note: "claim verify duty", actor: "verifier-opencode" });
    expect(claim.status).toBe(200);
    const done = await kbJson("/transition", { id: child.id, to: "done", note: "verified PR https://github.com/state-vector/bridge/pull/0 — no-refold control", actor: "verifier-opencode" });
    expect(done.status).toBe(200);
    const take = await kbJson("/transition", { id: cardId, to: "in_progress", note: "claim breach investigation", actor: "investigator-opencode" });
    expect(take.status).toBe(200);
    const close = await kbJson("/transition", { id: cardId, to: "done", note: "investigated and adjudicated", actor: "investigator-opencode" });
    expect(close.status).toBe(200);
  };

  const rejectOnce = async (id: string) => {
    const r = await kbJson("/transition", { id, to: "in_review", note: "handoff attempt without any receipt", actor: "gateway-a-opencode" });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain("PR link");
  };

  it("(a) closing the card does not re-arm its key: stale events stay folded", async () => {
    const { body: card } = await kbJson("/create", { type: "task", title: "high-water no-refold" });
    await kbJson("/transition", { id: card.id, to: "in_progress", note: "claim", actor: "gateway-a-opencode" });
    for (let i = 0; i < 3; i++) await rejectOnce(card.id); // raises the breach card at threshold
    let mine = await breachCardsFor(card.id);
    expect(mine).toHaveLength(1);
    const first = mine[0];
    await closeBreachCard(first.id);
    // one more rejection inside the lookback — a fold trigger on stale
    // evidence. Before the fix this re-raised the SAME group (specimen BR#3439).
    await rejectOnce(card.id);
    mine = await breachCardsFor(card.id);
    expect(mine).toHaveLength(1); // the closed card only — no duplicate
  });

  it("(b) genuinely new events above the closed card's high-water still raise", async () => {
    const { body: card } = await kbJson("/create", { type: "task", title: "high-water still raises fresh" });
    await kbJson("/transition", { id: card.id, to: "in_progress", note: "claim", actor: "gateway-a-opencode" });
    for (let i = 0; i < 3; i++) await rejectOnce(card.id);
    let mine = await breachCardsFor(card.id);
    expect(mine).toHaveLength(1);
    await closeBreachCard(mine[0].id);
    await rejectOnce(card.id); // fold trigger on stale evidence — stays folded
    mine = await breachCardsFor(card.id);
    expect(mine).toHaveLength(1);
    // two more rejections: three events strictly ABOVE the closed card's
    // high-water — a fresh pattern that must raise a new card
    await rejectOnce(card.id);
    await rejectOnce(card.id);
    mine = await breachCardsFor(card.id);
    expect(mine).toHaveLength(2);
  });

  it("(c) reoccurrences coalesce onto the OPEN card and stay folded after it closes", async () => {
    const { body: card } = await kbJson("/create", { type: "task", title: "high-water coalesce" });
    await kbJson("/transition", { id: card.id, to: "in_progress", note: "claim", actor: "gateway-a-opencode" });
    for (let i = 0; i < 3; i++) await rejectOnce(card.id); // raises the card
    // two reoccurrences coalesce onto the open card — never a second card
    await rejectOnce(card.id);
    await rejectOnce(card.id);
    let mine = await breachCardsFor(card.id);
    expect(mine).toHaveLength(1);
    // the open card's high-water advanced past its raise: the coalesced
    // reoccurrences are marked folded on the card itself
    const { body: refreshed } = await kbJson("/get", { id: mine[0].id });
    expect(Number(refreshed?.meta?.breach_high_water ?? 0)).toBeGreaterThan(Number(mine[0].created_ts ?? 0));
    await closeBreachCard(mine[0].id);
    // after close: the coalesced events are already folded; one more
    // rejection (fold trigger) must NOT resurrect the covered group
    await rejectOnce(card.id);
    mine = await breachCardsFor(card.id);
    expect(mine).toHaveLength(1); // the closed card only
  });
});
