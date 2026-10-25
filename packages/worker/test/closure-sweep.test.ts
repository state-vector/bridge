import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Closure-tier duty scheduling (BR#3361) — real DO drill against the bundled
 * worker, canned GitHub served by a local HTTP server (the stop-line rig
 * recipe: function-form outboundService breaks workerd startup here).
 *
 * Four mechanisms, one canned server each way:
 *  (a) unblock-proxy watch: a blocked card parked on BR#3129's REAL exit
 *      condition ("PR #2327 mergeCommit non-null") auto-spawns the unblock
 *      duty when the proxy flips TRUE (canned merged), stamps honest
 *      verdicts otherwise (PR 2400 canned open → "false"; machine-looking
 *      text that yields no atom → "unparseable", never flips), and dedupes.
 *  (b) terminal close-leg ownership: a done rejected by done-close-legs
 *      auto-derives the close-duty child; the child's receipted done
 *      unblocks the parent's done.
 *  (c) closure-receipt audit: a done card's receipts are live-verified
 *      (issue state + closing comment + guard run); a false claim (the
 *      BR#3220 class — done card says closed, GitHub says open) files a
 *      correction duty.
 *  (d) duplicate-executor fence: orient exposes the executor lease; a
 *      state-changing op by a non-holder while the holder is alive is
 *      audited (system:fence / duplicate_executor), never blocked.
 */

// REAL BR#3129 unblock condition (verbatim, see closure.test.ts provenance)
const BR3129_COND =
  "Machine proxy: PR https://github.com/state-vector/superpositional/pull/2327 mergeCommit non-null (state=MERGED). Then a fresh session: (1) confirm scenario 'manifest-rowcount-basename-collision' exists on main (fixtures/bug-corpus/defects.toml); (2) close GH #2274 with the closing comment carrying 'scenario: manifest-rowcount-basename-collision' (dogfood close-guard grammar); (3) exit: gh issue view 2274 --json state = CLOSED (not REOPENED) + scenario id in closing comment. If PR still OPEN+CONFLICTING on re-check: needs signed rebase by a session with a working sign env (proxy per BR#3042: signed scratch commit succeeds) — do NOT re-push unsigned (5c).";

// Canned GitHub: PR 2327 MERGED (the BR#3129 leg), PR 2400 open (false
// verdict), issue 2261 CLOSED with its closing comment + guard run (audit
// ok), issue 2337 still OPEN (the BR#3220 class — audit false).
function ghHandler() {
  const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  return (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    const url = req.url ?? "/";
    if (/\/pulls\/2327$/.test(url)) return json(res, 200, { number: 2327, state: "closed", merged_at: "2026-10-25T00:51:11Z" });
    if (/\/pulls\/2400$/.test(url)) return json(res, 200, { number: 2400, state: "open", merged_at: null });
    if (/\/issues\/2261$/.test(url)) return json(res, 200, { number: 2261, state: "closed" });
    if (/\/issues\/2261\/comments\/17623388240$/.test(url)) return json(res, 200, { id: 17623388240 });
    if (/\/issues\/2337$/.test(url)) return json(res, 200, { number: 2337, state: "open" });
    if (/\/actions\/runs\/40198911366$/.test(url)) return json(res, 200, { status: "completed", conclusion: "success" });
    return json(res, 404, { message: `unexpected ${url}` });
  };
}

let mf: Miniflare;
let ghServer: import("node:http").Server;
const t0 = Date.now();

async function kbJson(path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const kb = (globalThis as any).__kb as (p: string, i?: RequestInit) => Promise<Response>;
  const r = await kb(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const taskById = async (id: string) => (await kbJson("/get", { id })).body;

const unblockDuties = async () =>
  ((await kbJson("/list", { type: "task", limit: 200 })).body?.artefacts ?? []).filter((a: any) =>
    typeof a.title === "string" && (a.title.startsWith("Unblock: ") || a.title.startsWith("Close-leg duty: ") || a.title.startsWith("Correction: ")));

async function block(id: string, actor: string, condition: string, reason: string) {
  return kbJson("/transition", { id, to: "blocked", actor, session: actor, note: reason, unblock_condition: condition });
}

beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  if (!existsSync(bundle)) {
    throw new Error("bundle missing — run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle (before vitest)");
  }
  const { createServer } = await import("node:http");
  ghServer = createServer(ghHandler());
  await new Promise<void>((resolve) => ghServer.listen(0, "127.0.0.1", resolve));
  const ghOrigin = `http://127.0.0.1:${(ghServer.address() as any).port}`;
  mf = new Miniflare({
    workers: [{
      name: "main",
      scriptPath: bundle,
      modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")),
      modules: true,
      compatibilityDate: "2025-09-06",
      bindings: { GH_TOKEN: "test-token" },
      durableObjects: {
        HUB: { className: "FlowsHub", useSQLite: true },
        KB: { className: "KnowledgeHub", useSQLite: true },
      },
    }],
  });
  const ns = await mf.getDurableObjectNamespace("KB");
  const stub: any = await ns.get(ns.idFromName("global"));
  (globalThis as any).__kb = (path: string, init?: RequestInit) => stub.fetch(`https://kb${path}`, init);
  await kbJson("/orient", {});
  const set = await kbJson("/admin.settings_set", {
    settings: { unblock_proxy_gh_api_base: ghOrigin, closure_audit_gh_api_base: ghOrigin },
  });
  if (set.body.error) throw new Error(`settings_set failed: ${set.body.error}`);
});

afterAll(async () => {
  await mf?.dispose();
  await new Promise<void>((resolve) => ghServer?.close(() => resolve()));
});

// ---------- (a) the unblock-proxy watch ----------

describe("unblockProxySweep (real DO, canned GitHub)", () => {
  it("flipped machine proxy auto-spawns the unblock duty with receipts; false and unparseable never flip; dedupe holds", async () => {
    // P1 parks on BR#3129's REAL condition — canned PR 2327 says MERGED.
    // Entering blocked auto-spawns the park-time unblock round (the machine's
    // standing law); it runs, finds the proxy still false, and closes with
    // findings — exactly BR#3129's story before the flip nobody noticed.
    const p1 = await kbJson("/create", { type: "task", title: "IMPL: re-close GH #2274 (drill)", qualified: true, session: "drill-exec-p1" });
    expect(p1.status).toBe(200);
    const p1id = String(p1.body.id);
    await kbJson("/transition", { id: p1id, to: "in_progress", actor: "drill-exec-p1", session: "drill-exec-p1" });
    const blk = await block(p1id, "drill-exec-p1", BR3129_COND, "parked on the human merge gate");
    expect(blk.status).toBe(200);
    const parkRound = (await unblockDuties()).find((x: any) =>
      x.title.startsWith("Unblock: IMPL: re-close GH #2274") && ["todo", "in_progress", "blocked"].includes(x.status));
    expect(parkRound, "the park-time unblock round must exist").toBeTruthy();
    await kbJson("/transition", { id: parkRound.id, to: "in_progress", actor: "drill-exec-u1", session: "drill-exec-u1" });
    const parkDone = await kbJson("/transition", {
      id: parkRound.id, to: "done", actor: "drill-exec-u1",
      note: "checked live via https://github.com/state-vector/superpositional/pull/2327 — still OPEN, not merged (findings); proxy false at check time",
    });
    expect(parkDone.status, `park round done failed: ${JSON.stringify(parkDone.body)}`).toBe(200);

    // P2: machine-looking text that yields NO atom — never flips
    const p2 = await kbJson("/create", { type: "task", title: "IMPL: unparseable drill", qualified: true, session: "drill-exec-p2" });
    const p2id = String(p2.body.id);
    await block(p2id, "drill-exec-p2", "GH#2274 pending re-close", "parked");

    // P3: well-formed atom, canned PR 2400 says OPEN → verdict false, no spawn
    const p3 = await kbJson("/create", { type: "task", title: "IMPL: false-proxy drill", qualified: true, session: "drill-exec-p3" });
    const p3id = String(p3.body.id);
    await block(p3id, "drill-exec-p3",
      "Machine proxy: PR https://github.com/state-vector/superpositional/pull/2400 mergeCommit non-null (state=MERGED). Then a fresh session closes the leg.",
      "parked");

    // sweep past the park-time flood window (the park rounds stamped
    // last_unblock_spawn ~t0 with the same exit text)
    const sweep1 = await kbJson("/admin.unblock_proxy_sweep", { now: t0 + 61 * 60_000 });
    expect(sweep1.status, `sweep1 failed: ${JSON.stringify(sweep1.body)}`).toBeLessThan(500);
    expect(sweep1.body.error).toBeUndefined();

    // P1 flipped: the unblock duty exists, owns the receipts, is a child
    const p1Now = await taskById(p1id);
    expect(p1Now.meta?.proxy_check?.verdict).toBe("true");
    const spawnedId = p1Now.meta?.proxy_check?.spawned;
    expect(spawnedId).toBeTruthy();
    const duty = await taskById(spawnedId);
    expect(duty.title).toBe(`Unblock: IMPL: re-close GH #2274 (drill)`);
    expect(duty.status).toBe("todo");
    expect(duty.roles).toContain("unblock");
    expect(String(duty.body_md)).toContain("MACHINE PROXY");
    expect(String(duty.body_md)).toContain("MERGED at 2026-10-25T00:51:11Z");
    expect(String(duty.body_md)).toContain("live re-verify first");
    const p1Rels = (await kbJson("/relations", { id: p1id })).body?.relations ?? [];
    expect(p1Rels).toContainEqual(expect.objectContaining({ relation: "child_of", artefact_id: spawnedId, dir: "in" }));

    // P2 stamped honestly unparseable — stamped, never flipped, no duty
    const p2Now = await taskById(p2id);
    expect(p2Now.meta?.proxy_check?.verdict).toBe("unparseable");
    expect(p2Now.meta?.proxy_check?.detail).toContain("never auto-flips");

    // P3 read false — stamped, no duty
    const p3Now = await taskById(p3id);
    expect(p3Now.meta?.proxy_check?.verdict).toBe("false");
    expect(p3Now.meta?.proxy_check?.atoms?.[0]?.receipt).toContain("state=open, not merged");

    // dedupe: a second sweep (past cadence + card pacing) must NOT spawn again
    const sweep2 = await kbJson("/admin.unblock_proxy_sweep", { now: t0 + 61 * 60_000 + 17 * 60_000 });
    expect(sweep2.body.error).toBeUndefined();
    const p1After = await taskById(p1id);
    expect(p1After.meta?.proxy_check?.spawn_skipped).toContain("existing unblock child");
    const duties = (await unblockDuties()).filter((d: any) =>
      d.title.startsWith("Unblock: IMPL: re-close GH #2274") && ["todo", "in_progress", "blocked"].includes(d.status));
    expect(duties.length).toBe(1);
    expect(duties[0].id).toBe(String(spawnedId));
  });
});

// ---------- (b) terminal close-leg ownership ----------

describe("done-close-legs auto-derivation (real DO)", () => {
  it("unreceipted done is rejected, derives the close-duty child once, and the child's receipted done unblocks the parent", async () => {
    const d = await kbJson("/create", {
      type: "task", title: "IMPL: close-leg drill", qualified: true, session: "drill-exec-parent",
      body_md: "work\n\n## Done when\n- close GH #2261 (the incident issue)\n",
    });
    expect(d.status).toBe(200);
    const dId = String(d.body.id);
    await kbJson("/transition", { id: dId, to: "in_progress", actor: "drill-exec-parent", session: "drill-exec-parent" });

    // done without a receipt → gate rejects, error names the rule
    const rej = await kbJson("/transition", { id: dId, to: "done", actor: "drill-exec-parent", note: "work complete" });
    expect(rej.status).toBe(400);
    expect(String(rej.body.error)).toContain("terminal close leg(s) not receipted");
    expect(String(rej.body.error)).toContain("[rule: done-close-legs]");

    // the rejection auto-derived the close-duty child (leg has an owner)
    const duties1 = (await unblockDuties()).filter((x: any) => x.title.startsWith("Close-leg duty: IMPL: close-leg drill"));
    expect(duties1.length).toBe(1);
    const childId = duties1[0].id;
    expect(duties1[0].roles).toContain("unblock");
    expect(String(duties1[0].body_md)).toContain("close GH#2261");
    expect(String(duties1[0].body_md)).toContain("state=closed + closing-comment id");
    const dRels = (await kbJson("/relations", { id: dId })).body?.relations ?? [];
    expect(dRels).toContainEqual(expect.objectContaining({ relation: "child_of", artefact_id: childId, dir: "in" }));
    expect((await taskById(dId)).meta?.last_close_leg_spawn?.child).toBe(childId);

    // retry while the child is open → still rejected, no SECOND child (flood+cap)
    const rej2 = await kbJson("/transition", { id: dId, to: "done", actor: "drill-exec-parent", note: "work complete (retry)" });
    expect(rej2.status).toBe(400);
    const duties2 = (await unblockDuties()).filter((x: any) => x.title.startsWith("Close-leg duty: IMPL: close-leg drill"));
    expect(duties2.length).toBe(1);

    // the closer executes the leg: receipted done on the child (a different
    // session — separation of duties bars the parent's session)
    await kbJson("/transition", { id: childId, to: "in_progress", actor: "drill-exec-closer", session: "drill-exec-closer" });
    const childDone = await kbJson("/transition", {
      id: childId, to: "done", actor: "drill-exec-closer",
      note: "close executed: GH #2261 state=closed, closing comment 17623388240 (https://github.com/state-vector/superpositional/issues/2261#issuecomment-17623388240), guard run 40198911366 guard=allow",
    });
    expect(childDone.status, `child done failed: ${JSON.stringify(childDone.body)}`).toBe(200);

    // now the parent's done passes — the closed close-duty child owns the leg
    const parentDone = await kbJson("/transition", { id: dId, to: "done", actor: "drill-exec-parent", note: "executed via the close-leg duty child" });
    expect(parentDone.status, `parent done failed: ${JSON.stringify(parentDone.body)}`).toBe(200);
  });
});

// ---------- (c) the closure-receipt audit ----------

describe("closureAuditSweep (real DO, canned GitHub)", () => {
  it("true receipts verify ok; a false 'closed' claim (BR#3220 class) files the correction duty exactly once", async () => {
    // card A: receipted done for leg 2261 — canned GitHub confirms CLOSED
    const a = await kbJson("/create", {
      type: "task", title: "IMPL: audit-ok drill", qualified: true, session: "drill-exec-audit-a",
      body_md: "work\n\n## Done when\n- close GH #2261 (the incident issue)\n",
    });
    const aId = String(a.body.id);
    await kbJson("/transition", { id: aId, to: "in_progress", actor: "drill-exec-audit-a", session: "drill-exec-audit-a" });
    const aDone = await kbJson("/transition", {
      id: aId, to: "done", actor: "drill-exec-audit-a",
      note: "GH #2261 state=closed, closing comment 17623388240 (https://github.com/state-vector/superpositional/issues/2261#issuecomment-17623388240), guard run 40198911366 guard=allow",
    });
    expect(aDone.status).toBe(200); // receipt present at the gate → done passes
    expect((await taskById(aId)).meta?.close_leg_audit?.checked_ts ?? null).toBeNull(); // armed for the audit

    // card B: receipt-shaped claim for leg 2337 — canned GitHub says OPEN
    // (the BR#3220 class: the board reports a closed issue that isn't)
    const b = await kbJson("/create", {
      type: "task", title: "IMPL: audit-false drill", qualified: true, session: "drill-exec-audit-b",
      body_md: "work\n\n## Done when\n- close GH #2337 (the ref-blind leak issue)\n",
    });
    const bId = String(b.body.id);
    await kbJson("/transition", { id: bId, to: "in_progress", actor: "drill-exec-audit-b", session: "drill-exec-audit-b" });
    const bDone = await kbJson("/transition", {
      id: bId, to: "done", actor: "drill-exec-audit-b",
      note: "RESIDUE CLEARED: GH #2337 state=closed, closing comment 17629999999, guard run 40199999999",
    });
    expect(bDone.status).toBe(200); // the gate checks the receipt SHAPE; the audit checks the TRUTH

    const sweep = await kbJson("/admin.closure_audit_sweep", { now: t0 + 120_000 });
    expect(sweep.status, `audit sweep failed: ${JSON.stringify(sweep.body)}`).toBeLessThan(500);
    expect(sweep.body.error).toBeUndefined();

    const aNow = await taskById(aId);
    expect(aNow.meta?.close_leg_audit?.verdict).toBe("ok");
    expect(aNow.meta?.close_leg_audit?.checked_ts).toBeTruthy();
    expect(aNow.meta?.close_leg_audit?.checks?.[0]?.issue).toContain("state=closed");
    expect(aNow.meta?.close_leg_audit?.checks?.[0]?.comment).toContain("comment 17623388240 exists");

    const bNow = await taskById(bId);
    expect(bNow.meta?.close_leg_audit?.verdict).toBe("false");
    expect(bNow.meta?.close_leg_audit?.checks?.[0]?.issue).toContain("state=open");

    // one correction duty, bound to the false card, child_of it
    const corrections = (await unblockDuties()).filter((x: any) => x.title.startsWith("Correction: false closure receipt"));
    expect(corrections.length).toBe(1);
    expect(String(corrections[0].title)).toContain(bId);
    expect(corrections[0].roles).toContain("unblock");
    expect(String(corrections[0].body_md)).toContain("verify the live state of each leg first-hand");
    const bRels = (await kbJson("/relations", { id: bId })).body?.relations ?? [];
    expect(bRels).toContainEqual(expect.objectContaining({ relation: "child_of", artefact_id: corrections[0].id, dir: "in" }));

    // a re-sweep re-audits nothing (checked_ts set) — no second correction
    const sweep2 = await kbJson("/admin.closure_audit_sweep", { now: t0 + 120_000 + 31 * 60_000 });
    expect(sweep2.body.error).toBeUndefined();
    const corrections2 = (await unblockDuties()).filter((x: any) => x.title.startsWith("Correction: false closure receipt"));
    expect(corrections2.length).toBe(1);
  });
});

// ---------- (d) the duplicate-executor fence ----------

describe("duplicate-executor fence (real DO)", () => {
  it("orient exposes the executor lease; a non-holder's state-changing op is audited, never blocked", async () => {
    const e = await kbJson("/create", { type: "task", title: "IMPL: fence drill", qualified: true, session: "drill-exec-a" });
    const eId = String(e.body.id);
    await kbJson("/transition", { id: eId, to: "in_progress", actor: "drill-exec-a", session: "drill-exec-a" });

    // the lease is visible BEFORE acting: another session's orient shows the holder
    const other = await kbJson("/orient", { session: "drill-exec-b" });
    expect(other.body.error).toBeUndefined();
    const row = (other.body?.open_artefacts ?? []).find((t: any) => t.id === eId);
    expect(row?.executor_session).toBe("drill-exec-a");

    // the non-holder transitions the card anyway → it SUCCEEDS (advisory)…
    const moved = await kbJson("/transition", {
      id: eId, to: "blocked", actor: "drill-exec-b", session: "drill-exec-b",
      note: "awaiting direction", unblock_condition: "direction from the parent",
    });
    expect(moved.status).toBe(200);

    // …and the fence audited it (holder alive, actor differs)
    const { body } = await kbJson("/events?since=0&limit=500");
    const fence = (body?.events ?? []).filter((ev: any) => ev.op === "duplicate_executor" && ev.artefact_id === eId);
    expect(fence.length).toBe(1);
    expect(fence[0].actor).toBe("system:fence");
    expect(fence[0].detail).toMatchObject({ holder: "drill-exec-a", actor: "drill-exec-b", from: "in_progress", to: "blocked" });
  });
});
