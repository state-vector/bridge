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


// /get returns meta as a parsed object on recent rows and as a JSON string on
// legacy shapes — tests read it both ways.
function metaOf(b: any): Record<string, any> {
  if (!b?.meta) return {};
  return typeof b.meta === "string" ? JSON.parse(b.meta) : b.meta;
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
      details: "Adds a roles column to tasks so review-gated cards dispatch only to review-role agents. PR is green; this ask covers the go/no-go on merging it.",
      to: "human",
    });
    expect(ask.status).toBe(200);
    // human-directed asks require the plain-reading brief (details) — bare
    // reference soup is rejected at the door
    const bare = await kbJson("/ask.create", {
      question: "integration: merge the roles column PR without a brief?",
      options: ["GO — merge", "NO-GO — hold"],
      reason: "integration test coverage",
      to: "human",
    });
    expect(bare.status).toBe(400);
    expect(String(bare.body.error)).toContain("details");
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
      details: "drill brief: fixture ask exercising the ask lifecycle end-to-end — no live decision rides on it.",

    });
    expect(ask.status).toBe(200);

    // the card auto-blocked, and the marker is ON THE CARD — the key the
    // machine's unblock-spawn gate reads at fold time; pre-fix this never
    // existed here, so every ask-bound block leaked a racing sweep duty
    // (BR#3798 → 3799+3800, BR#3505 → 3506)
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

    // answering the ask resumes the card exactly once and clears the marker.
    // Rebase conflict vs BR#3578/BR#3912 answer dispatch (landed while this
    // PR was queued): an option-verb answer ("KEEP …") now actions the card —
    // KEEPs it parked, the human owns the rewrite — so the generic resume
    // under test here is the TYPED non-option answer ("a typed answer
    // matching no option verb is still the generic resume").
    const ans = await kbJson("/ask.answer", { id: ask.body.id, answer: "GO — lease looks sound, carry on" });
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

  it("BR#3822: a rejected ask-bound park PROPAGATES the failure and rolls the marker back (PR #229 review finding)", async () => {
    // verdict duties (roles [review]) cannot enter blocked — the fold rejects
    // the park, and askCreate must surface that rejection to the caller, not
    // convert it into a success-shaped ask with no park and a leaked marker
    // (the failure-handling finding that sank PR #229).
    const { body: t } = await kbJson("/create", { type: "task", title: "ask-gate failure path", roles: ["review"], qualified: true });
    await kbJson("/transition", { id: t.id, to: "in_progress", note: "claim" });

    const ask = await kbJson("/ask.create", {
      question: "Should the verifier park this card?",
      options: ["PARK", "GO"],
      reason: "BR#3822 failure-path fixture",
      to: "human",
      artefact_id: t.id,
      details: "drill brief: fixture ask exercising the ask lifecycle end-to-end — no live decision rides on it.",

    });
    expect(ask.status).toBe(400);
    expect(String(ask.body.error)).toContain("verdict-no-blocked");

    // the marker rolled back — a live card carries no awaiting_ask residue
    const card = await kbJson("/get", { id: t.id });
    expect(card.body.status).toBe("in_progress");
    expect(card.body.meta.awaiting_ask).toBeUndefined();

    // and the failed attempt spawned no unblock duty
    const rels = await kbJson("/relations", { id: t.id });
    for (const r of (rels.body.relations ?? []).filter((x: any) => x.dir === "in")) {
      const c = await kbJson("/get", { id: r.artefact_id });
      if (c.body.type === "task") expect(c.body.roles.includes("unblock")).toBe(false);
    }
  });

  it("SUPERSEDE answer on a parked subject DROPS it (BR#3913 — the dispatch leg was a 500: no lifecycle edge to superseded)", async () => {
    const { body: t } = await kbJson("/create", { type: "task", title: "BR#3913 supersede dispatch target" });
    await kbJson("/transition", { id: t.id, to: "in_progress", note: "claim" });
    const ask = await kbJson("/ask.create", {
      artefact_id: t.id,
      question: "Rework loop on the card — drop it?",
      options: ["RE-SCOPE — I'll rewrite the card myself", "RELEASE — back to the pool anyway", "SUPERSEDE — drop it"],
      reason: "churn guard rework loop",
      to: "human",
      details: "drill brief: fixture ask exercising the ask lifecycle end-to-end — no live decision rides on it.",
    });
    expect(ask.status).toBe(200);
    // ask.create parked the subject blocked-on-ask (typed await on the ask node)
    const parked = await kbJson("/get", { id: t.id });
    expect(parked.body.status).toBe("blocked");
    // the answer actions the card: SUPERSEDE drops it. Before BR#3913 the
    // answer + question-done committed, then the transition threw
    // `task: 'blocked' → 'superseded' not allowed` — a 500 with the subject stuck.
    const ans = await kbJson("/ask.answer", { id: ask.body.id, answer: "SUPERSEDE — drop it", actor: "web:rayh" });
    expect(ans.status).toBe(200);
    expect(ans.body.error).toBeUndefined();
    expect(ans.body.task_status).toBe("superseded");
    const after = await kbJson("/get", { id: t.id });
    expect(after.body.status).toBe("superseded");
  });

  it("a rule-6c '(Recommended) SUPERSEDE — …' option still dispatches when the click echoes the prefix (BR#5570 — specimen ask BR#5531 → lane BR#5497 unretired)", async () => {
    // the exact live shape: recommended option FIRST with the "(Recommended)"
    // prefix; the web button click echoes the full option text as the answer.
    // Before BR#5570 the answer started with "(recommended)", startsWith
    // failed, optHit was false, and the ask fell through to the generic
    // rule-6 resume — the recorded GO never executed.
    const { body: t } = await kbJson("/create", { type: "task", title: "BR#5570 rule-6c supersede dispatch target" });
    await kbJson("/transition", { id: t.id, to: "in_progress", note: "claim" });
    const ask = await kbJson("/ask.create", {
      artefact_id: t.id,
      question: "Execute the recorded retire-GO: drop this card?",
      options: ["(Recommended) SUPERSEDE — drop it now", "KEEP — stay parked", "RE-SCOPE — I'll rewrite it myself"],
      reason: "BR#5570 regression fixture",
      to: "human",
      details: "drill brief: fixture ask exercising the ask lifecycle end-to-end — no live decision rides on it.",
    });
    expect(ask.status).toBe(200);
    const parked = await kbJson("/get", { id: t.id });
    expect(parked.body.status).toBe("blocked");
    const ans = await kbJson("/ask.answer", { id: ask.body.id, answer: "(Recommended) SUPERSEDE — drop it now", actor: "web:rayh" });
    expect(ans.status).toBe(200);
    expect(ans.body.error).toBeUndefined();
    expect(ans.body.task_status).toBe("superseded");
    expect((await kbJson("/get", { id: t.id })).body.status).toBe("superseded");
  });

  it("a rule-6c '(Recommended) KEEP — …' click stays a deliberate park — no silent resume (BR#5570)", async () => {
    const { body: t } = await kbJson("/create", { type: "task", title: "BR#5570 rule-6c keep-park target" });
    await kbJson("/transition", { id: t.id, to: "in_progress", note: "claim" });
    const ask = await kbJson("/ask.create", {
      artefact_id: t.id,
      question: "Keep parked while the base is red?",
      options: ["(Recommended) KEEP — stay parked", "RELEASE — back to the pool"],
      reason: "BR#5570 regression fixture",
      to: "human",
      details: "drill brief: fixture ask exercising the ask lifecycle end-to-end — no live decision rides on it.",
    });
    expect(ask.status).toBe(200);
    const ans = await kbJson("/ask.answer", { id: ask.body.id, answer: "(Recommended) KEEP — stay parked", actor: "web:rayh" });
    expect(ans.status).toBe(200);
    // optHit must be TRUE so the KEEP leg keeps the card parked; before the
    // fix the prefix broke the match and the ask resumed the card instead.
    expect(ans.body.task_status).toBe("blocked");
    expect((await kbJson("/get", { id: t.id })).body.status).toBe("blocked");
  });

  it("a plain non-dispatch '(Recommended) …' answer still falls through to the resume legs (BR#5570 — no over-broad dispatch)", async () => {
    const { body: t } = await kbJson("/create", { type: "task", title: "BR#5570 non-dispatch resume target" });
    await kbJson("/transition", { id: t.id, to: "in_progress", note: "claim" });
    const ask = await kbJson("/ask.create", {
      artefact_id: t.id,
      question: "Proceed with the ordinary plan?",
      options: ["(Recommended) Yes — proceed", "No — rethink"],
      reason: "BR#5570 regression fixture",
      to: "human",
      details: "drill brief: fixture ask exercising the ask lifecycle end-to-end — no live decision rides on it.",
    });
    expect(ask.status).toBe(200);
    const ans = await kbJson("/ask.answer", { id: ask.body.id, answer: "(Recommended) Yes — proceed", actor: "web:rayh" });
    expect(ans.status).toBe(200);
    // no dispatch verb anywhere → the generic rule-6 resume still runs
    expect(ans.body.task_status).toBe("in_progress");
    expect((await kbJson("/get", { id: t.id })).body.status).toBe("in_progress");
  });

  it("a bare agent session cannot supersede a parked card via transition (BR#3913 authority guard)", async () => {
    const { body: t } = await kbJson("/create", { type: "task", title: "BR#3913 agent-supersede refused" });
    await kbJson("/transition", { id: t.id, to: "in_progress", note: "claim" });
    const blocked = await kbJson("/transition", {
      id: t.id, to: "blocked",
      note: "awaiting direction",
      await_event: { event: "pr_merged", repo: "state-vector/bridge", n: 1 },
    });
    expect(blocked.status).toBe(200);
    const sup = await kbJson("/transition", { id: t.id, to: "superseded", note: "dropping this", actor: "some-agent-session" });
    expect(sup.status).toBe(400);
    expect(String(sup.body.error)).toContain("supersede-authority");
    expect((await kbJson("/get", { id: t.id })).body.status).toBe("blocked"); // unchanged
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

// ---------- BR#3611: gateway-attributed claims — self-release allowed, cross-gateway gated, wording-proof fold ----------

describe("gateway-attributed claims through the real gate + breach door (BR#3611)", () => {
  const breachCardsFor = async (taskId: string) => {
    const { body } = await kbJson("/list", { type: "task", tag: "breach", limit: 200 });
    return (body.artefacts ?? []).filter((a: any) => String(a.title).includes(taskId));
  };

  it("a gateway releases its OWN attributed claim; a cross-gateway release is refused and folds as claim_race", async () => {
    const { body: card } = await kbJson("/create", { type: "task", title: "gateway attributed claim br3611" });
    // claim attributed: the gateway's raw actor claims, owner = attributedAgent
    // (do.ts claim path: owner = attributedAgent ?? actor)
    const claim = await kbJson("/transition", {
      id: card.id, to: "in_progress", note: "claim",
      actor: "gateway-h", gateway: true, agent: "gateway-h-opencode",
    });
    expect(claim.status).toBe(200);
    const held = await kbJson("/get", { id: card.id });
    expect(held.body.owner).toBe("gateway-h-opencode"); // attribution, not the raw actor

    // self-release: same gateway, same attributed agent — before BR#3611 the
    // gate structurally refused this (owner ≠ raw actor by construction) and
    // the runner's stale-claim path never succeeded live
    const self = await kbJson("/transition", {
      id: card.id, to: "todo", note: "rule-9: my own attributed claim, session died",
      actor: "gateway-h", gateway: true, agent: "gateway-h-opencode",
    });
    expect(self.status).toBe(200);

    // re-claim, then a CROSS-gateway release: the gate refuses it (claim-race
    // semantics — the exact BR#3610 trigger shape, ip-172 vs a mac-modem-held
    // claim) with the PR #210 proven-unblock wording, and the fold classifies
    // it claim_race → NO breach card at the default threshold
    await kbJson("/transition", { id: card.id, to: "in_progress", note: "re-claim", actor: "gateway-h", gateway: true, agent: "gateway-h-opencode" });
    for (let i = 0; i < 4; i++) {
      const r = await kbJson("/transition", {
        id: card.id, to: "todo", note: "not mine, releasing",
        actor: "other-gw", gateway: true, agent: "other-gw-opencode",
      });
      expect(r.status).toBe(400);
      expect(String(r.body.error)).toContain("is claimed by");
      expect(String(r.body.error)).toContain("only the owner");
    }
    const mine = await breachCardsFor(card.id);
    expect(mine).toHaveLength(0);
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

describe("typed answers dispatch like the option click (BR#3912 type-your-own)", () => {
  // A rework-loop ask (reaper shape): a blocked subject + an ask whose options
  // carry action verbs. The typed path must read the same dispatch law as the
  // click path: verb-matched answers action the subject, everything else is
  // the generic rule-6 resume. Before the verb-match fix, "RE-SCOPE: <scope>"
  // missed the 12-char prefix of "RE-SCOPE — I'll rewrite…" and generic-resumed
  // the parked card — silently restarting the loop the reaper had stopped.
  const OPTIONS = ["RE-SCOPE — I'll rewrite the card myself", "RELEASE — back to the pool anyway", "SUPERSEDE — drop it"];

  async function parkedSubjectWithAsk(title: string) {
    const { body: subject } = await kbJson("/create", { type: "task", title });
    // rule-6 parking: askCreate flips an IN_PROGRESS subject to blocked-on-ask
    await kbJson("/transition", { id: subject.id, to: "in_progress", note: "claim" });
    const { body: ask } = await kbJson("/ask.create", {
      to: "ray",
      question: `Rework loop on ${subject.id} "${title}" — the release→claim→stall cycle is now invalid (it failed 20 times). What do you want to do with it?`,
      reason: "20 dispatch attempts without completion — re-running repeats the claim→stall cycle",
      details: "drill brief: fixture ask exercising the ask lifecycle end-to-end — no live decision rides on it.",
      options: OPTIONS,
      artefact_id: subject.id,
    });
    expect(ask.id).toMatch(/^BR#\d+$/);
    const got = await kbJson("/get", { id: subject.id });
    expect(got.body.status).toBe("blocked"); // askCreate parked the subject
    return { subject, ask };
  }

  it("typed 'RE-SCOPE: …' keeps the subject parked (human owns the rewrite)", async () => {
    const { subject, ask } = await parkedSubjectWithAsk("rework re-scope typed");
    const { body } = await kbJson("/ask.answer", { id: ask.id, answer: "RE-SCOPE: hunt the churn guard instead — new scope below" });
    expect(body.task_status).toBe("blocked");
    const got = await kbJson("/get", { id: subject.id });
    expect(got.body.status).toBe("blocked");
    // the typed text is recorded with the ASK node, exactly like a click
    const askNode = await kbJson("/get", { id: ask.id });
    expect(String(askNode.body.meta?.ask?.answer ?? "")).toContain("hunt the churn guard");
  });

  it("typed 'RELEASE …' pools the parked subject (blocked → todo is a legal edge)", async () => {
    const b = await parkedSubjectWithAsk("rework release typed");
    const { body: bodyB } = await kbJson("/ask.answer", { id: b.ask.id, answer: "RELEASE — retry on a fresh worker" });
    expect(bodyB.task_status).toBe("todo");
    const got = await kbJson("/get", { id: b.subject.id });
    expect(got.body.status).toBe("todo");
  });

  it("a typed answer matching no option verb is still the generic resume", async () => {
    const { subject, ask } = await parkedSubjectWithAsk("rework free-form typed");
    const { body } = await kbJson("/ask.answer", { id: ask.id, answer: "the gate is gone, retry as-is" });
    expect(body.task_status).toBe("in_progress");
    const got = await kbJson("/get", { id: subject.id });
    expect(got.body.status).toBe("in_progress");
  });

  it("the reaper's rework-loop ask names the invalid cycle and the card (BR#3912 wording)", async () => {
    const { ask } = await parkedSubjectWithAsk("rework ask wording");
    const got = await kbJson("/get", { id: ask.id });
    expect(String(got.body.title)).toContain("now invalid");
    expect(String(got.body.title)).toContain("What do you want to do with it?");
  });
  // NOTE (BR#3912, filed separately): the SUPERSEDE dispatch leg is structurally
  // dead — core.ts LIFECYCLES gives tasks NO edge to 'superseded' from any
  // status, so askAnswer's `transition(to: "superseded")` on a parked subject
  // always throws AFTER the answer is recorded (ask closed done, subject stuck
  // blocked, caller sees a 500). Fixing it means a lifecycle-law change
  // (who may drop parked cards) — owned by the typed-ask-options lane
  // (BR#3848), not smuggled into this UI fix.
});
// ---------- BR#3911: human-claim hold on questions ----------

describe("question human-claim hold (BR#3911, real storage)", () => {
  it("a human claim stamps human_claimed with a 10-minute window; the question stays todo", async () => {
    const { body: q } = await kbJson("/create", { type: "question", title: "hold drill: who owns the reindex?", actor: "web:rayh" });
    const r = await kbJson("/question.claim", { id: q.id, actor: "web:rayh" });
    expect(r.status).toBe(200);
    const c = r.body.human_claimed;
    expect(c.by).toBe("web:rayh");
    expect(c.expires_ts - c.ts).toBe(10 * 60_000);
    const got = await kbJson("/get", { id: q.id });
    expect(got.body.status).toBe("todo"); // the hold is meta, never a status change
    expect(got.body.meta.human_claimed.by).toBe("web:rayh");
  });

  it("agent and gateway actors are rejected — the hold is human-only", async () => {
    const { body: q } = await kbJson("/create", { type: "question", title: "hold drill: agent rejection?", actor: "web:rayh" });
    const agent = await kbJson("/question.claim", { id: q.id, actor: "some-agent-opencode" });
    expect(agent.status).toBe(400);
    expect(String(agent.body.error)).toContain("human");
    const gw = await kbJson("/question.claim", { id: q.id, actor: "gateway" });
    expect(gw.status).toBe(400);
    const rel = await kbJson("/question.release", { id: q.id, actor: "some-agent-opencode" });
    expect(rel.status).toBe(400);
  });

  it("claims on non-questions and answered questions are rejected", async () => {
    const { body: t } = await kbJson("/create", { type: "task", title: "not a question" });
    const wrong = await kbJson("/question.claim", { id: t.id, actor: "web:rayh" });
    expect(wrong.status).toBe(400);
    expect(String(wrong.body.error)).toContain("only on question");
    const ask = await kbJson("/ask.create", { question: "already answered drill?", to: "human", reason: "drill", details: "drill brief: fixture ask for the human-claim hold lifecycle.", options: ["GO", "NO-GO"] });
    expect(ask.status).toBe(200);
    await kbJson("/ask.answer", { id: ask.body.id, answer: "GO" });
    const ans = await kbJson("/question.claim", { id: ask.body.id, actor: "web:rayh" });
    expect(ans.status).toBe(400);
  });

  it("agent claims on questions stay forbidden (transition law unchanged)", async () => {
    const { body: q } = await kbJson("/create", { type: "question", title: "law unchanged drill?", actor: "web:rayh" });
    const claim = await kbJson("/transition", { id: q.id, to: "in_progress", note: "claim", actor: "some-agent-opencode" });
    expect(claim.status).toBe(400);
    // rejected either by the lifecycle edge (questions never leave todo) or by
    // the question-not-claimable law — both are the claim staying forbidden
    expect(String(claim.body.error)).toMatch(/answered, not claimed|not allowed/);
  });

  it("contributions keep logging on a held question with a stand-down postscript (6b intact)", async () => {
    const { body: q } = await kbJson("/create", { type: "question", title: "contribution drill?", actor: "web:rayh" });
    await kbJson("/question.claim", { id: q.id, actor: "web:rayh" });
    const p = await kbJson("/progress.log", { id: q.id, actor: "drone-1", note: "found prior art in KB", did: "found prior art", will: "none" });
    expect(p.status).toBe(200);
    expect(String(p.body.note_postscript)).toContain("in hand");
    // unheld questions keep the plain 6b postscript
    const { body: q2 } = await kbJson("/create", { type: "question", title: "plain contribution drill?", actor: "web:rayh" });
    const p2 = await kbJson("/progress.log", { id: q2.id, actor: "drone-1", note: "another data point" });
    expect(p2.status).toBe(200);
    expect(String(p2.body.note_postscript)).toContain("answered, not claimed");
  });

  it("an answer resolves the hold — the timer is cancelled and the stamp clears", async () => {
    const ask = await kbJson("/ask.create", { question: "answer resolves the hold drill?", to: "human", reason: "drill", details: "drill brief: fixture ask for answer-resolves-hold behavior.", options: ["GO", "NO-GO"] });
    await kbJson("/question.claim", { id: ask.body.id, actor: "web:rayh" });
    const ans = await kbJson("/ask.answer", { id: ask.body.id, answer: "GO", actor: "web:rayh" });
    expect(ans.status).toBe(200);
    const got = await kbJson("/get", { id: ask.body.id });
    expect(got.body.status).toBe("done");
    expect(got.body.meta.human_claimed).toBeUndefined();
  });

  it("a close (done) cancels the hold too", async () => {
    const { body: q } = await kbJson("/create", { type: "question", title: "close cancels hold drill?", actor: "web:rayh" });
    await kbJson("/question.claim", { id: q.id, actor: "web:rayh" });
    const done = await kbJson("/transition", { id: q.id, to: "done", note: "author closed with an ADR", actor: "web:rayh" });
    expect(done.status).toBe(200);
    const got = await kbJson("/get", { id: q.id });
    expect(got.body.meta.human_claimed).toBeUndefined();
  });

  it("release puts the question back before the window lapses; releasing again errors", async () => {
    const { body: q } = await kbJson("/create", { type: "question", title: "early release drill?", actor: "web:rayh" });
    await kbJson("/question.claim", { id: q.id, actor: "web:rayh" });
    const rel = await kbJson("/question.release", { id: q.id, actor: "web:rayh" });
    expect(rel.status).toBe(200);
    const got = await kbJson("/get", { id: q.id });
    expect(got.body.meta.human_claimed).toBeUndefined();
    const again = await kbJson("/question.release", { id: q.id, actor: "web:rayh" });
    expect(again.status).toBe(400);
  });

  it("the timeout sweep auto-reverts an expired hold loudly (version note), and only then", async () => {
    const { body: q } = await kbJson("/create", { type: "question", title: "expiry sweep drill?", actor: "web:rayh" });
    const claim = await kbJson("/question.claim", { id: q.id, actor: "web:rayh", minutes: 1 });
    expect(claim.status).toBe(200);
    const c = claim.body.human_claimed;
    // before expiry: nothing happens
    const early = await kbJson("/admin.question_claim_sweep", { now: c.ts + 30_000 });
    expect(early.status).toBe(200);
    expect(early.body.expired).toBe(0);
    const still = await kbJson("/get", { id: q.id });
    expect(still.body.meta.human_claimed).toBeTruthy();
    // past expiry: the stamp clears and the expiry is on the record
    const sweep = await kbJson("/admin.question_claim_sweep", { now: c.expires_ts + 1000 });
    expect(sweep.body.expired).toBe(1);
    const got = await kbJson("/get", { id: q.id });
    expect(got.body.status).toBe("todo");
    expect(got.body.meta.human_claimed).toBeUndefined();
    const h = await kbJson("/get_history", { id: q.id, limit: 10 });
    const notes = JSON.stringify(h.body.versions ?? []);
    expect(notes).toContain("human claim expired");
    // idempotent: a second sweep reaps nothing
    const again = await kbJson("/admin.question_claim_sweep", { now: c.expires_ts + 2000 });
    expect(again.body.expired).toBe(0);
  });

  it("a held question leaves the agent inbox and returns after expiry/release", async () => {
    const ask = await kbJson("/ask.create", { question: "inbox dismissal drill?", to: "hold-drill-agent", reason: "drill", options: ["GO", "NO-GO"] });
    expect(ask.status).toBe(200);
    const before = await kbJson("/ask.inbox", { label: "hold-drill-agent" });
    expect(JSON.stringify(before.body)).toContain(ask.body.id);
    await kbJson("/question.claim", { id: ask.body.id, actor: "web:rayh" });
    const during = await kbJson("/ask.inbox", { label: "hold-drill-agent" });
    expect(JSON.stringify(during.body)).not.toContain(ask.body.id);
    // orient says "in hand" instead of shipping answer prompts
    const ori = await kbJson("/orient", { label: "hold-drill-agent" });
    const row = (ori.body.open_artefacts ?? []).find((x: any) => x.id === ask.body.id);
    expect(row?.human_claimed?.by).toBe("web:rayh");
    await kbJson("/question.release", { id: ask.body.id, actor: "web:rayh" });
    const after = await kbJson("/ask.inbox", { label: "hold-drill-agent" });
    expect(JSON.stringify(after.body)).toContain(ask.body.id);
  });
});

describe("update_artefact meta merge semantics (BR#5807 — the BR#5733 lane-clobber class)", () => {
  const laneConfig = {
    lane: {
      repo: "state-vector/bridge", base: "main",
      required_workflows: ["Test", "CLI build (packages/cli)"],
      ci_typical_minutes: 10, key: "state-vector/bridge@main", starved_since: null,
    },
    lease: { holder: "gw-1", heartbeat_ts: 1, expires_ts: 2 },
    currently: { pr: 371, phase: "awaiting-ci" },
    stop: null,
    session: "lane-tick-session",
  };
  const seedLaneCard = async (title: string) => {
    const { body: t } = await kbJson("/create", { type: "task", title });
    await kbJson("/transition", { id: t.id, to: "in_progress", note: "claim" });
    await kbJson("/update", { id: t.id, meta: laneConfig, actor: "gw-1" });
    return t.id;
  };

  it("THE regression: a single-key meta edit on a lane card preserves lane/lease/stop/currently (BR#5733 — the edit that clobbered tb-pulse/BR@main)", async () => {
    const id = await seedLaneCard("BR#5807 lane-clobber regression lane");
    // the exact near-miss shape: the executor passes ONLY {blocked, await_event}
    const r = await kbJson("/update", {
      id, actor: "bridge-task-BR-5733",
      meta: { blocked: { reason: "merge-train: awaiting an available gateway", ts: 3 }, await_event: { event: "time", until_ts: 4 } },
    });
    expect(r.status).toBe(200);
    expect(r.body.error).toBeUndefined();
    const after = await kbJson("/get", { id });
    const m = after.body.meta;
    // lane config intact — every infrastructure key the old replace semantics amputated
    expect(m.lane).toEqual(laneConfig.lane);
    expect(m.lane.key).toBe("state-vector/bridge@main");
    expect(m.lane.required_workflows).toEqual(laneConfig.lane.required_workflows);
    expect(m.lease).toEqual(laneConfig.lease);
    expect(m.currently).toEqual(laneConfig.currently);
    expect(m.stop).toBeNull();
    expect(m.session).toBe("lane-tick-session");
    // and the key the caller DID pass landed
    expect(m.blocked.reason).toBe("merge-train: awaiting an available gateway");
    expect(m.await_event).toEqual({ event: "time", until_ts: 4 });
  });

  it("a present top-level key replaces WHOLESALE — nested objects are never Frankenstein-merged", async () => {
    const id = await seedLaneCard("BR#5807 wholesale-replace regression lane");
    const newLane = { repo: "state-vector/bridge", base: "main", key: "state-vector/bridge@main", ci_typical_minutes: 12 };
    const r = await kbJson("/update", { id, actor: "gw-1", meta: { lane: newLane } });
    expect(r.status).toBe(200);
    const m = (await kbJson("/get", { id })).body.meta;
    // the new object is the whole lane value — the old nested keys (required_workflows,
    // starved_since) do NOT survive as stale residue beside the partial replacement
    expect(m.lane).toEqual(newLane);
    expect(m.lane.required_workflows).toBeUndefined();
    expect(m.lane.ci_typical_minutes).toBe(12);
    // untouched sibling keys still preserved
    expect(m.lease).toEqual(laneConfig.lease);
  });

  it("a null VALUE stores as null — only meta_delete removes keys", async () => {
    const id = await seedLaneCard("BR#5807 null-value regression lane");
    const r = await kbJson("/update", { id, actor: "gw-1", meta: { stop: null, lease: null } });
    expect(r.status).toBe(200);
    const m = (await kbJson("/get", { id })).body.meta;
    expect("stop" in m).toBe(true);
    expect(m.stop).toBeNull();
    expect("lease" in m).toBe(true);
    expect(m.lease).toBeNull();
    expect(m.lane).toEqual(laneConfig.lane);
  });

  it("meta_delete removes a non-infrastructure key explicitly", async () => {
    const id = await seedLaneCard("BR#5807 meta-delete regression lane");
    const r = await kbJson("/update", { id, actor: "some-agent", meta_delete: ["session"] });
    expect(r.status).toBe(200);
    const m = (await kbJson("/get", { id })).body.meta;
    expect("session" in m).toBe(false);
    expect(m.lane).toEqual(laneConfig.lane);
  });

  it("meta_delete on lane-config keys is refused for agent sessions, allowed for machinery (BR#5807 fail-closed guard)", async () => {
    const id = await seedLaneCard("BR#5807 lane-guard regression lane");
    const refused = await kbJson("/update", { id, actor: "rogue-session", meta_delete: ["lane", "lease"] });
    expect(refused.status).toBe(400);
    expect(String(refused.body.error)).toContain("BR#5807");
    expect(String(refused.body.error)).toContain("lane, lease");
    // the card is untouched by the refused edit
    const m1 = (await kbJson("/get", { id })).body.meta;
    expect(m1.lane).toEqual(laneConfig.lane);
    expect(m1.lease).toEqual(laneConfig.lease);
    // machinery authority passes (the close-protection OWNER_RELEASE_EXEMPT class)
    const allowed = await kbJson("/update", { id, actor: "system:watchdog", meta_delete: ["lease", "currently"] });
    expect(allowed.status).toBe(200);
    const m2 = (await kbJson("/get", { id })).body.meta;
    expect("lease" in m2).toBe(false);
    expect("currently" in m2).toBe(false);
    expect(m2.lane).toEqual(laneConfig.lane);
  });

  it("meta_delete of a parked card's blocked (carrying a typed await) is refused for agent sessions — the watchdog-leg-drop class", async () => {
    const { body: t } = await kbJson("/create", { type: "task", title: "BR#5807 await-guard regression" });
    await kbJson("/transition", { id: t.id, to: "in_progress", note: "claim" });
    await kbJson("/transition", {
      id: t.id, to: "blocked", actor: "some-agent",
      note: "merge-train: awaiting gateway",
      await_event: { event: "time", until_ts: Date.now() + 60_000 },
    });
    const refused = await kbJson("/update", { id: t.id, actor: "rogue-session", meta_delete: ["blocked"] });
    expect(refused.status).toBe(400);
    expect(String(refused.body.error)).toContain("BR#5807");
    // parked reason + typed await intact
    const m = (await kbJson("/get", { id: t.id })).body.meta;
    expect(m.blocked.await_event).toBeTruthy();
  });

  it("an update on an abandoned-blocked card re-claims AND does not resurrect the cleared parked reason (stale-snapshot guard)", async () => {
    const { body: t } = await kbJson("/create", { type: "task", title: "BR#5807 reclaim regression" });
    await kbJson("/transition", { id: t.id, to: "in_progress", note: "claim" });
    await kbJson("/transition", {
      id: t.id, to: "blocked", actor: "system:watchdog",
      note: "abandoned — silence >10m; released to the pool by watchdog",
      await_event: { event: "time", until_ts: Date.now() + 60_000 },
    });
    const r = await kbJson("/update", { id: t.id, actor: "resuming-agent", meta: { fresh: "edit" } });
    expect(r.status).toBe(200);
    const after = await kbJson("/get", { id: t.id });
    // the update heartbeat re-claimed the abandoned card...
    expect(after.body.status).toBe("in_progress");
    const m = after.body.meta;
    // ...the dead-end blocked record did not resurrect (the transition cleared it
    // post-snapshot; the merge base is the POST-transition row)...
    expect(m.blocked).toBeUndefined();
    // ...and the new payload key survived the merge.
    expect(m.fresh).toBe("edit");
  });

  it("the history line names meta set/deleted keys — a meta shrink is never silent (BR#5807 audit leg)", async () => {
    const id = await seedLaneCard("BR#5807 audit-line regression lane");
    await kbJson("/update", { id, actor: "auditor-agent", meta: { blocked: { reason: "x" } }, meta_delete: ["session"] });
    const h = await kbJson("/get_history", { id });
    const line = (h.body.versions ?? []).find((v: any) => v.action === "update" && /meta/.test(v.summary ?? ""));
    expect(line).toBeTruthy();
    expect(line.summary).toContain("set: blocked");
    expect(line.summary).toContain("deleted: session");
  });
});

// ---- BR#5874: the verify-round supersede must kill only same-PR duties ----
// Production incident (BR#4678): the parent's verify round BR#5735 (PR #2573)
// was superseded by the LINK of BR#5746 — a disposition duty for a DIFFERENT
// PR (#2329). The round went ownerless; the watchdog stalled the boosted card
// ~6h ("no verifier picked up the verification round").
describe("BR#5874 — verify-round supersede is target-aware", () => {
  it("a cross-PR disposition child does NOT supersede the parent's own round; a same-PR round does (keep-newest)", async () => {
    // the BR#4678 shape: parent bound to its deliverable PR via meta.pr; the
    // round carries the PR only in its body URL (auto-spawn duties have no
    // meta.pr); the disposition duty carries its PR only in the title.
    const parent = await kbJson("/create", {
      type: "task",
      title: "Backlog disposition: 44 open PRs vs board",
      meta: { pr: { repo: "state-vector/superpositional", number: 2573 } },
    });
    expect(parent.status).toBe(200);
    const round = await kbJson("/create", {
      type: "task",
      title: "Verify: Backlog disposition: 44 open PRs vs board",
      roles: ["review"],
      body_md: "Verification duty for the deliverable.\nPR: https://github.com/state-vector/superpositional/pull/2573",
    });
    expect(round.status).toBe(200);
    const linked = await kbJson("/link", { src: round.body.id, relation: "child_of", dst: parent.body.id });
    expect(linked.status).toBe(200);

    const disposition = await kbJson("/create", {
      type: "task",
      title: "Verify: superpositional PR #2329 — canary: judge chat CONVERSATION answer shape",
      roles: ["review"],
      body_md: "Verify duty for the done-when disposition leg — different PR, no body URL.",
    });
    expect(disposition.status).toBe(200);
    const linkedDisp = await kbJson("/link", { src: disposition.body.id, relation: "child_of", dst: parent.body.id });
    expect(linkedDisp.status).toBe(200);

    // THE INCIDENT: the disposition link must leave the round open.
    const roundAfter = await kbJson("/get", { id: round.body.id });
    expect(roundAfter.body.status).not.toBe("superseded");
    const dispAfter = await kbJson("/get", { id: disposition.body.id });
    expect(dispAfter.body.status).not.toBe("superseded");

    // a NEW round for the SAME deliverable supersedes the older same-PR round
    // (the invariant's original purpose) and STILL leaves the disposition alone.
    const round2 = await kbJson("/create", {
      type: "task",
      title: "Verify: Backlog disposition: 44 open PRs vs board (fresh handoff)",
      roles: ["review"],
      body_md: "Re-anchor receipt duty.\nPR: https://github.com/state-vector/superpositional/pull/2573",
    });
    expect(round2.status).toBe(200);
    const linked2 = await kbJson("/link", { src: round2.body.id, relation: "child_of", dst: parent.body.id });
    expect(linked2.status).toBe(200);
    const round1Final = await kbJson("/get", { id: round.body.id });
    expect(round1Final.body.status).toBe("superseded");
    expect(String(round1Final.body.meta?.superseded_reason)).toContain("same deliverable");
    const round2Final = await kbJson("/get", { id: round2.body.id });
    expect(round2Final.body.status).not.toBe("superseded");
    const dispFinal = await kbJson("/get", { id: disposition.body.id });
    expect(dispFinal.body.status).not.toBe("superseded");
  });

  it("legacy keep-newest survives in the no-signal world (parent, rounds — nothing PR-bound)", async () => {
    const parent = await kbJson("/create", { type: "task", title: "Docs pass — no deliverable PR bound" });
    const u1 = await kbJson("/create", { type: "task", title: "Verify: Docs pass", roles: ["review"], body_md: "no PR signal anywhere" });
    await kbJson("/link", { src: u1.body.id, relation: "child_of", dst: parent.body.id });
    const u2 = await kbJson("/create", { type: "task", title: "Verify: Docs pass (re-round)", roles: ["review"], body_md: "also no signal" });
    await kbJson("/link", { src: u2.body.id, relation: "child_of", dst: parent.body.id });
    const u1Final = await kbJson("/get", { id: u1.body.id });
    expect(u1Final.body.status).toBe("superseded"); // legacy keep-newest preserved
    const u2Final = await kbJson("/get", { id: u2.body.id });
    expect(u2Final.body.status).not.toBe("superseded");
  });

  it("a bounce keeps the ROUND child even when a cross-PR disposition child is newer (supersede_children keep_newest)", async () => {
    const parent = await kbJson("/create", {
      type: "task",
      title: "Impl card with deliverable PR #777",
      meta: { pr: { repo: "state-vector/superpositional", number: 777 } },
    });
    const round = await kbJson("/create", {
      type: "task",
      title: "Verify: Impl card with deliverable PR #777",
      roles: ["review"],
      body_md: "Duty body.\nPR: https://github.com/state-vector/superpositional/pull/777",
    });
    await kbJson("/link", { src: round.body.id, relation: "child_of", dst: parent.body.id });
    await kbJson("/transition", { id: parent.body.id, to: "in_progress", note: "claim" });
    // handoff: in_review reuses the open round (no fresh spawn)
    const rev = await kbJson("/transition", { id: parent.body.id, to: "in_review", note: "PR https://github.com/state-vector/superpositional/pull/777" });
    expect(rev.status).toBe(200);
    // the impl session then spawns a disposition duty for ANOTHER PR (newer child)
    const disp = await kbJson("/create", {
      type: "task",
      title: "Verify: superpositional PR #2329 — disposition leg",
      roles: ["review"],
      body_md: "Different PR, title carries the number.",
    });
    await kbJson("/link", { src: disp.body.id, relation: "child_of", dst: parent.body.id });
    // bounce: the round must survive (old code kept the NEWEST child — the disposition — and killed the round)
    const bounce = await kbJson("/transition", { id: parent.body.id, to: "in_progress", note: "bounce — findings on the round" });
    expect(bounce.status).toBe(200);
    const roundAfter = await kbJson("/get", { id: round.body.id });
    expect(roundAfter.body.status).not.toBe("superseded");
    const dispAfter = await kbJson("/get", { id: disp.body.id });
    expect(dispAfter.body.status).not.toBe("superseded"); // cross-PR duty coexists untouched
  });
});

// ---------- BR#6135: interactive claim takeover — atomic owner/web-anchored claim transfer off runner sessions ----------
// The op: one write flips meta.session + the owner leg; status stays
// in_progress (no release→pool→re-claim race); the ex-holder's next state
// change is gate-refused with the stand-down order (its log_progress stays
// open); refusals fold never-breach (BR#3430). Ray live ruling 2026-11-04.
describe("interactive claim takeover (BR#6135)", () => {
  it("happy path: a web taker takes a runner-held claim atomically; the ex-holder is stood down", async () => {
    // the runner: a gateway token with a principal, its dispatch session
    const gw = await kbJson("/admin.mint", { label: "br6135-gw", tags: ["gateway"], principal: "p_br6135_box" });
    expect(gw.status).toBe(200);
    const { body: card } = await kbJson("/create", { type: "task", title: "takeover happy path br6135" });
    const claim = await kbJson("/transition", {
      id: card.id, to: "in_progress", note: "claim",
      actor: "br6135-gw", gateway: true, agent: "br6135-agent", token_id: gw.body.id, session: "dispatch-BR-6135T",
    });
    expect(claim.status).toBe(200);
    let held = await kbJson("/get", { id: card.id });
    expect(metaOf(held.body).session).toBe("dispatch-BR-6135T");
    // claim ownership anchors the PRINCIPAL (do.ts claim law). /get renders the
    // BR#4262 display join — the principal reads as its token label — so the
    // discriminating observable is the release gate below: the machine sees the
    // RAW stored owner, and a label-stored owner would have been ADMITTED by
    // the BR#3611 gateway self-release admission instead of refused.
    expect(held.body.owner).toBe("br6135-gw");
    const sweepPre = await kbJson("/transition", {
      id: card.id, to: "todo", note: "runner: sweep-shaped release",
      actor: "br6135-gw", gateway: true, agent: "br6135-agent", token_id: gw.body.id,
    });
    expect(sweepPre.status).toBe(400);
    expect(String(sweepPre.body.error)).toContain("is claimed by p_br6135_box"); // stored owner = principal

    // THE takeover — web actor (human plane, BR#2673 anchor). The web plane
    // stamps the taker's holder session as its web:<login> actor (the
    // index.js takeover leg), so the holder flip — and with it the
    // ex-holder stand-down and the idempotent re-click — is observable.
    // First: the runner declares silence (grace window + subprocess budget)
    // and carries churn — the takeover must strip all three (BR#6159
    // bookkeeping): declared silence dies with the claim, counters start clean.
    const silence = await kbJson("/update", {
      id: card.id,
      meta: {
        grace_until: Date.now() + 600_000,
        subprocess: { reason: "re-index", budget_minutes: 30, deadline_ts: Date.now() + 1_800_000, ts: Date.now() },
        attempt: 2,
      },
    });
    expect(silence.status).toBe(200);
    const take = await kbJson("/transition", { id: card.id, to: "in_progress", takeover: true, note: "interactive takeover", actor: "web:rayh", session: "web:rayh" });
    expect(take.status).toBe(200);
    expect(take.body.status).toBe("in_progress"); // status untouched — no pool pass
    expect(take.body.taken_over).toBe(true);
    held = await kbJson("/get", { id: card.id });
    const meta = metaOf(held.body);
    expect(meta.session).toBe("web:rayh"); // holder is never left unnamed
    expect(meta.taken_over.from_session).toBe("dispatch-BR-6135T");
    expect(meta.taken_over.by).toBe("web:rayh");
    expect(held.body.owner).toBe("web:rayh"); // claim transfer: owner follows the taker
    expect(held.body.status).toBe("in_progress");
    expect(meta.grace_until).toBeUndefined(); // the ex-holder's declared silence died with its claim (BR#6159)
    expect(meta.subprocess).toBeUndefined();
    expect(meta.attempt).toBeUndefined(); // churn counters start clean — taken-over ≠ abandonment

    // the version row is on the card's history
    const hist = await kbJson("/get_history", { id: card.id });
    const rows = hist.body.versions ?? [];
    expect(rows.some((r: any) => String(r.summary).includes("claim taken over"))).toBe(true);

    // EX-HOLDER STAND-DOWN: the superseded runner session's release is
    // refused with the named order — the BR#3348 two-writers class, enforced
    const rel = await kbJson("/transition", {
      id: card.id, to: "todo", note: "runner: stale claim released",
      actor: "br6135-gw", gateway: true, agent: "br6135-agent", token_id: gw.body.id, session: "dispatch-BR-6135T",
    });
    expect(rel.status).toBe(400);
    expect(String(rel.body.error)).toContain("STAND DOWN");
    // …and so is its finish
    const fin = await kbJson("/transition", {
      id: card.id, to: "in_review", note: "PR https://github.com/state-vector/bridge/pull/1",
      actor: "br6135-gw", gateway: true, agent: "br6135-agent", token_id: gw.body.id, session: "dispatch-BR-6135T",
    });
    expect(fin.status).toBe(400);
    expect(String(fin.body.error)).toContain("STAND DOWN");

    // the BR#3611 gateway self-release admission DIED with the owner leg: the
    // runner releasing without its session (liveness-sweep shape) still hits
    // release-needs-ownership — owner web:rayh matches neither its actor nor
    // its attributed agent
    const sweep = await kbJson("/transition", {
      id: card.id, to: "todo", note: "runner: stale claim released",
      actor: "br6135-gw", gateway: true, agent: "br6135-agent", token_id: gw.body.id,
    });
    expect(sweep.status).toBe(400);
    expect(String(sweep.body.error)).toContain("is claimed by web:rayh");
  });

  it("a non-owner agent bearer is refused [rule: takeover-authority] — and the refusals fold never-breach (BR#3430)", async () => {
    const gw = await kbJson("/admin.mint", { label: "br6135-gw2", tags: ["gateway"], principal: "p_br6135_box2" });
    const { body: card } = await kbJson("/create", { type: "task", title: "takeover authority br6135" });
    await kbJson("/transition", {
      id: card.id, to: "in_progress", note: "claim",
      actor: "br6135-gw2", gateway: true, agent: "br6135-agent2", token_id: gw.body.id, session: "dispatch-BR-6135B",
    });
    const breachCardsFor = async () => {
      const { body } = await kbJson("/list", { type: "task", tag: "breach", limit: 200 });
      return (body.artefacts ?? []).filter((a: any) => String(a.title).includes(card.id));
    };
    for (let i = 0; i < 4; i++) {
      const r = await kbJson("/transition", {
        id: card.id, to: "in_progress", takeover: true, actor: "random-agent", session: "sneaky-1",
      });
      expect(r.status).toBe(400);
      expect(String(r.body.error)).toContain("[rule: takeover-authority]");
    }
    // BR#3430: an ownership rejection is the system working — no breach card
    expect(await breachCardsFor()).toHaveLength(0);
  });

  it("a peer-interactive-held claim is takeable by an authority-anchored taker, and the ex-holder stands down (BR#6159 landed law: no holder-class refusal)", async () => {
    const agent = await kbJson("/admin.mint", { label: "br6135-peer", tags: [] });
    const { body: card } = await kbJson("/create", { type: "task", title: "takeover peer holder br6135" });
    const claim = await kbJson("/transition", {
      id: card.id, to: "in_progress", note: "claim", actor: "br6135-peer", token_id: agent.body.id, session: "peer-interactive-1",
    });
    expect(claim.status).toBe(200);
    // The landed law refuses on authority / verdict-duty / typed-wait only —
    // the holder class is not a refusal leg (BR#6159 divergence 3), so the
    // owner/web taker takes ANY claim it has authority over:
    const r = await kbJson("/transition", { id: card.id, to: "in_progress", takeover: true, actor: "web:rayh", session: "web:rayh" });
    expect(r.status).toBe(200);
    expect(r.body.taken_over).toBe(true);
    const held = await kbJson("/get", { id: card.id });
    const meta = metaOf(held.body);
    expect(meta.session).toBe("web:rayh");
    expect(meta.taken_over.from_session).toBe("peer-interactive-1");
    expect(held.body.owner).toBe("web:rayh");
    // …and the superseded peer is stood down exactly like a runner holder
    const rel = await kbJson("/transition", {
      id: card.id, to: "todo", note: "stale release",
      actor: "br6135-peer", token_id: agent.body.id, session: "peer-interactive-1",
    });
    expect(rel.status).toBe(400);
    expect(String(rel.body.error)).toContain("STAND DOWN");
  });

  it("verify duty cards refuse (SoD is not transferable) and typed-wait holds refuse", async () => {
    const gw = await kbJson("/admin.mint", { label: "br6135-gw3", tags: ["gateway"] });
    // verdict duty
    const { body: duty } = await kbJson("/create", { type: "task", title: "Verify: takeover duty br6135", roles: ["review"] });
    const dc = await kbJson("/transition", {
      id: duty.id, to: "in_progress", note: "claim", actor: "br6135-gw3", gateway: true, agent: "br6135-agent3", token_id: gw.body.id, session: "dispatch-BR-6135C",
    });
    expect(dc.status).toBe(200);
    const dr = await kbJson("/transition", { id: duty.id, to: "in_progress", takeover: true, actor: "web:rayh" });
    expect(dr.status).toBe(400);
    expect(String(dr.body.error)).toContain("[rule: takeover-verdict-duty]");
    // typed wait: an in_progress card holding awaiting_ask is held by the ask
    const { body: card } = await kbJson("/create", { type: "task", title: "takeover held br6135" });
    await kbJson("/transition", {
      id: card.id, to: "in_progress", note: "claim", actor: "br6135-gw3", gateway: true, agent: "br6135-agent3", token_id: gw.body.id, session: "dispatch-BR-6135D",
    });
    const upd = await kbJson("/update", { id: card.id, meta: { awaiting_ask: { ask_id: "BR#999" } } });
    expect(upd.status).toBe(200);
    const hr = await kbJson("/transition", { id: card.id, to: "in_progress", takeover: true, actor: "web:rayh" });
    expect(hr.status).toBe(400);
    expect(String(hr.body.error)).toContain("[rule: takeover-held]");
  });

  it("idempotent: the holder re-running the takeover reports already, without rewriting the stamp", async () => {
    const ownerTok = await kbJson("/admin.mint", { label: "br6135-owner", tags: [], principal: "p_br6135_box4" });
    const gw = await kbJson("/admin.mint", { label: "br6135-gw4", tags: ["gateway"], principal: "p_br6135_box4" });
    const { body: card } = await kbJson("/create", { type: "task", title: "takeover idempotent br6135" });
    await kbJson("/transition", {
      id: card.id, to: "in_progress", note: "claim", actor: "br6135-gw4", gateway: true, agent: "br6135-agent4", token_id: gw.body.id, session: "dispatch-BR-6135E",
    });
    const t1 = await kbJson("/transition", {
      id: card.id, to: "in_progress", takeover: true, actor: "br6135-owner", token_id: ownerTok.body.id, session: "ray-local-1",
    });
    expect(t1.status).toBe(200);
    expect(t1.body.taken_over).toBe(true);
    expect(t1.body.session).toBe("ray-local-1");
    const t2 = await kbJson("/transition", {
      id: card.id, to: "in_progress", takeover: true, actor: "br6135-owner", token_id: ownerTok.body.id, session: "ray-local-1",
    });
    expect(t2.status).toBe(200);
    expect(t2.body.taken_over).toBe(false); // reports "already", takes nothing
    expect(String(t2.body.note)).toContain("already held by your session");
    const held = await kbJson("/get", { id: card.id });
    const stamp = metaOf(held.body).taken_over;
    expect(stamp.from_session).toBe("dispatch-BR-6135E"); // the FIRST stamp survived
  });

  it("the REST door claim_takeover routes through the same op; the lifecycle edge stays illegal without the flag", async () => {
    const gw = await kbJson("/admin.mint", { label: "br6135-gw5", tags: ["gateway"] });
    const { body: card } = await kbJson("/create", { type: "task", title: "takeover doors br6135" });
    await kbJson("/transition", {
      id: card.id, to: "in_progress", note: "claim", actor: "br6135-gw5", gateway: true, agent: "br6135-agent5", token_id: gw.body.id, session: "dispatch-BR-6135F",
    });
    // plain in_progress → in_progress is NOT a lifecycle edge
    const plain = await kbJson("/transition", { id: card.id, to: "in_progress", note: "double claim", actor: "web:rayh" });
    expect(plain.status).toBe(400);
    // the takeover flag hijacks no other edge: takeover:true with a non-
    // in_progress target falls through to the ordinary release law (here a
    // non-owner probe is refused by release-needs-ownership, not a takeover rule)
    const wrong = await kbJson("/transition", { id: card.id, to: "todo", takeover: true, actor: "random-agent", session: "sneaky-2" });
    expect(wrong.status).toBe(400);
    expect(String(wrong.body.error)).toContain("claimed by");
    expect(String(wrong.body.error)).not.toContain("[rule: takeover-");
    // the dedicated REST door — do.ts op `claim.takeover` (the MCP tool
    // `claim_takeover` rides the same op)
    const door = await kbJson("/claim.takeover", { id: card.id, note: "via the REST door", actor: "web:rayh", session: "web:rayh" });
    expect(door.status).toBe(200);
    expect(door.body.taken_over).toBe(true);
  });
});
