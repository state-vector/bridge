import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RELATIONS } from "../src/kb/core.ts";

/**
 * BR#3819 — answers must structurally unblock: no self-edges, ever, anywhere.
 *
 * Specimen BR#3423 (4th occurrence of the answer-execution misfire class):
 * a rollup stamped a card child_of ITSELF at creation; the done-open-children
 * gate then counted the card as its own open child forever — every →done
 * rejected "still has 1 open child task(s)" with no agent-repairable exit
 * (MCP has no unlink), and ask answers resumed work onto runners that had
 * already finished (no liveness check at resume). This suite pins the four
 * fix legs on the real DO (same rig as do.test.ts):
 *
 *   A. the link API rejects src == dst for EVERY relation kind — loud;
 *   B. the one-time migration stamps its settings key (self_edges_v1) and
 *      the gate readers exclude self-edges (defense-in-depth);
 *   C. the force-close-with-reason grammar is the agent-executable exit for
 *      relation-gated cards — complete lists pass (and are stamped/audited
 *      loudly), partial lists are refused;
 *   D. an ask answer resumes onto a LIVE holder as today, but a DEAD holder
 *      (no live signal within the stale window, ask older than it) is
 *      released to the pool for fresh dispatch — never resumed onto a
 *      finished runner.
 */

let mf: Miniflare;
let kb: (path: string, init?: RequestInit) => Promise<Response>;

beforeAll(async () => {
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
  });
  const ns = await mf.getDurableObjectNamespace("KB");
  const stub = await ns.get(ns.idFromName("global"));
  kb = (path, init) => stub.fetch(`https://kb${path}`, init);
  // warm + cold ensureSchema paths both exercised (the migration runs here)
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(id: string): Promise<any> {
  const { body } = await kbJson("/get", { id });
  return body;
}

async function relationsOf(id: string): Promise<any[]> {
  const { body } = await kbJson("/relations", { id });
  return body.relations ?? body.artefacts ?? [];
}

async function history(id: string): Promise<any[]> {
  const { body } = await kbJson("/get_history", { id });
  return body.versions ?? [];
}

/** a claimed task held by `session`, parked on an ask (the rule-6 shape) */
async function parkedOnAsk(session: string): Promise<{ task: string; ask: string }> {
  const { body: t } = await kbJson("/create", {
    type: "task", title: `liveness drill ${session}`, session, qualified: true,
  });
  await kbJson("/transition", { id: t.id, to: "in_progress", note: "claim", session });
  const { body: a } = await kbJson("/ask.create", {
    to: "any",
    question: `Resume the liveness drill for ${session}?`,
    options: ["GO", "NO-GO"],
    artefact_id: t.id,
    reason: "BR#3819 drill: the answer must resume a live holder and release a dead one",
    session,
  });
  expect(a.id).toBeTruthy();
  const parked = await get(t.id);
  expect(parked.status).toBe("blocked");
  return { task: t.id, ask: a.id };
}

describe("BR#3819 A — the link API rejects self-edges for every relation kind", () => {
  it("src == dst is unrepresentable, and the rejection is loud", async () => {
    const { body: t } = await kbJson("/create", { type: "task", title: "self-edge specimen", qualified: true });
    for (const rel of RELATIONS) {
      const { status, body } = await kbJson("/link", { src: t.id, relation: rel, dst: t.id });
      expect(body.error, `${rel}: expected a loud rejection`).toBeTruthy();
      expect(String(body.error), `${rel}: must name the self-edge class`).toContain("self-edge");
      expect(String(body.error), `${rel}: must cite BR#3819`).toContain("BR#3819");
      expect(status).toBeGreaterThanOrEqual(400);
    }
    expect((await relationsOf(t.id)).length).toBe(0);
  });

  it("valid links between distinct cards still work (control)", async () => {
    const { body: p } = await kbJson("/create", { type: "task", title: "self-edge parent", qualified: true });
    const { body: c } = await kbJson("/create", { type: "task", title: "self-edge child", qualified: true });
    const { body } = await kbJson("/link", { src: c.id, relation: "child_of", dst: p.id });
    expect(body.error).toBeUndefined();
    expect((await relationsOf(c.id)).some((r) => r.relation === "child_of" && r.artefact_id === p.id && r.dir === "out")).toBe(true);
  });

  it("a card can never supersede itself via replacement_id (the non-API write path)", async () => {
    const { body: d1 } = await kbJson("/create", { type: "decision", title: "self-supersede probe" });
    const { body } = await kbJson("/transition", { id: d1.id, to: "superseded", note: "probe", replacement_id: d1.id });
    expect(body.error).toBeUndefined();
    expect((await relationsOf(d1.id)).some((r) => r.relation === "supersedes")).toBe(false);
    // control: a REAL replacement records the edge
    const { body: d2 } = await kbJson("/create", { type: "decision", title: "self-supersede replacement" });
    const { body: d3 } = await kbJson("/create", { type: "decision", title: "self-supersede victim" });
    await kbJson("/transition", { id: d3.id, to: "superseded", note: "probe", replacement_id: d2.id });
    expect((await relationsOf(d3.id)).some((r) => r.relation === "supersedes" && r.artefact_id === d2.id)).toBe(true);
  });
});

describe("BR#3819 B — the one-time self-edge migration ran and stamped its key", () => {
  it("self_edges_v1 is stamped exactly once (settings), idempotent across boots", async () => {
    const { body } = await kbJson("/admin.settings_get", {});
    const stamp = body.settings?.self_edges_v1 ?? body.self_edges_v1;
    expect(stamp, "the migration must stamp its settings key on boot").toBeTruthy();
    const parsed = typeof stamp === "string" ? JSON.parse(stamp) : stamp;
    expect(Number(parsed.deleted)).toBeGreaterThanOrEqual(0);
    // re-orient: ensureSchema runs again; the key holds (one-time, not per-boot)
    await kb("/orient", { actor: "test" });
    const { body: again } = await kbJson("/admin.settings_get", {});
    const stamp2 = again.settings?.self_edges_v1 ?? again.self_edges_v1;
    const parsed2 = typeof stamp2 === "string" ? JSON.parse(stamp2) : stamp2;
    expect(parsed2.deleted).toBe(parsed.deleted);
  });
});

describe("BR#3819 C — the done gate and the force-close exit (real-DO drill)", () => {
  it("an open child fences done; a complete force-close passes and is stamped LOUDLY", async () => {
    const { body: p } = await kbJson("/create", { type: "task", title: "fc parent", roles: ["analysis"], qualified: true });
    const { body: c } = await kbJson("/create", { type: "task", title: "fc child", qualified: true });
    await kbJson("/link", { src: c.id, relation: "child_of", dst: p.id });
    // the legal path to done: todo → in_progress → in_review (PR-linked) → done;
    // →in_review auto-spawns a Verify child — an open child the gate counts
    await kbJson("/transition", { id: p.id, to: "in_progress", note: "claim" });
    const review = await kbJson("/transition", { id: p.id, to: "in_review", note: "PR https://github.com/state-vector/bridge/pull/1" });
    const verifyId = review.body.verify_task;
    expect(verifyId, "in_review must auto-spawn its Verify child").toBeTruthy();

    const refused = await kbJson("/transition", { id: p.id, to: "done", note: "trying to close with an open child" });
    expect(String(refused.body.error)).toContain("open child");
    expect(String(refused.body.error)).toContain("force-close-children");

    // partial list → refused, naming the missing children. The →in_review
    // transition auto-spawns a Verify child — it is an open child too, so a
    // partial list missing either it or c2 must be refused by id.
    const { body: c2 } = await kbJson("/create", { type: "task", title: "fc child 2", qualified: true });
    await kbJson("/link", { src: c2.id, relation: "child_of", dst: p.id });
    const partial = await kbJson("/transition", {
      id: p.id, to: "done", note: `force-close-children: ${c.id} — partial lists must be refused`,
    });
    const missingList = /missing: (.*?)\. put/.exec(String(partial.body.error))?.[1] ?? "";
    const missing = missingList.split(",").map((s) => s.trim());
    expect(missing, "the refusal must name every uncovered open child").toEqual(expect.arrayContaining([c2.id, verifyId]));

    // complete + reasoned → passes; the repair is stamped on the card + ledger
    const done = await kbJson("/transition", {
      id: p.id, to: "done",
      note: `force-close-children: ${c.id}, ${c2.id}, ${verifyId} — children unclosable in this drill; repaired per BR#3819`,
    });
    expect(done.body.error).toBeUndefined();
    const card = await get(p.id);
    expect(card.status).toBe("done");
    expect(card.meta.force_close.children.sort()).toEqual([c.id, c2.id, verifyId].sort());
    expect(String(card.meta.force_close.reason)).toContain("BR#3819");
    const notes = (await history(p.id)).map((v) => `${String(v.summary ?? "")} ${String(v.data?.note ?? "")}`);
    expect(notes.some((n) => n.includes("force-closed with open child"))).toBe(true);
  });
});

describe("BR#3819 D — ask answers resume live holders and release dead ones", () => {
  it("a LIVE holder resumes as today (quick answer, fresh signals)", async () => {
    const { task, ask } = await parkedOnAsk(`live-holder-${Date.now()}`);
    const { body } = await kbJson("/ask.answer", { id: ask, answer: "GO" });
    expect(body.error).toBeUndefined();
    expect(body.task_status).toBe("in_progress");
    expect((await get(task)).status).toBe("in_progress");
  });

  it("a DEAD holder is released to the pool for fresh dispatch — never resumed onto a finished runner", async () => {
    const { task, ask } = await parkedOnAsk(`ghost-holder-${Date.now()}`);
    // shrink the stale window to its 1-minute floor, let the holder go quiet
    // past it, then answer: the ask is older than the window and no live
    // signal (vouch, heartbeat, session ping, owner poll) exists → dead.
    await kbJson("/admin.settings_set", { settings: { stale_minutes: 1 } });
    try {
      await sleep(61_000);
      const { body } = await kbJson("/ask.answer", { id: ask, answer: "GO" });
      expect(body.error).toBeUndefined();
      expect(body.task_status).toBe("todo");
      const card = await get(task);
      expect(card.status).toBe("todo");
      expect(card.owner).toBe(""); // released — the pool re-dispatches
      const notes = (await history(task)).map((v) => `${String(v.summary ?? "")} ${String(v.data?.note ?? "")}`);
      expect(notes.some((n) => n.includes("released to the pool for fresh dispatch"))).toBe(true);
      expect(notes.some((n) => n.includes("BR#3819"))).toBe(true);
    } finally {
      await kbJson("/admin.settings_set", { settings: { stale_minutes: 10 } });
    }
  }, 130_000);
});
