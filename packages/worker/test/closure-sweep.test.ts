import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decisionFixture } from "./ask-fixture";

/**
 * Closure-tier duty scheduling (BR#3361) — real DO drill against the bundled
 * worker. DEGRADED under BR#3516: the hub holds no VCS credentials, ever, so
 * the machine-proxy watch cannot READ GitHub live — GitHub-state atoms stamp
 * UNRESOLVABLE (never auto-flip; conservatism law) UNLESS the ledger itself
 * knows the fact: board-state atoms (br_done, br_answered — BR#3620) evaluate
 * always, and pr_merged/br_pr_merged evaluate from the train-stamped
 * provenance table (BR#3620). The closure-RECEIPT audit sweep is gone with
 * BR#3516: receipts' truth is owned by the verify session that cites them and
 * by the train's machine-proxy close (train:landed — pinned in train-hub.test.ts).
 *
 * Four mechanisms, one real DO:
 *  (a) unblock-proxy watch (degraded): board-state atoms evaluate; provenance-
 *      backed merge atoms evaluate; unknown GitHub state stamps unresolvable
 *      citing BR#3516 and spawns nothing; unparseable stays honest; the
 *      park-time machine round is unaffected.
 *      BR#3620 flips: answered-ask cards (br_answered) and train-stamped
 *      merges flip for real — the stale-ledger class.
 *  (b) terminal close-leg ownership: a done rejected by done-close-legs
 *      auto-derives the close-duty child; the child's receipted done
 *      unblocks the parent's done.
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

describe("unblockProxySweep — degraded, board-state only (real DO)", () => {
  it("PR merge atoms enqueue executor verification without hub VCS reads or premature closure", async () => {
    // P1 parks on BR#3129's REAL condition ("PR #2327 mergeCommit non-null" —
    // a pr_merged atom with a repo). The park-time machine round spawns as
    // always (transition law, unchanged); the SWEEP, though, can no longer
    // read the PR — queue an executor probe, never a flip or a duty.
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
      execution_result: { outcome: "Condition remains blocked at check time.", receipts: [p1id] },
      note: "checked the condition first-hand — still blocked at check time (findings); the executor's gh and a train event are the credentialed readers now",
    });
    expect(parkDone.status, `park round done failed: ${JSON.stringify(parkDone.body)}`).toBe(200);

    // P2 (BR#3578): machine-looking text that yields NO atom can no longer
    // PARK — the door refuses free text alone; a typed await_event is
    // required, and it is stored on the card. Text may ride as annotation.
    const p2 = await kbJson("/create", { type: "task", title: "IMPL: unparseable drill", qualified: true, session: "drill-exec-p2" });
    const p2id = String(p2.body.id);
    const p2Reject = await block(p2id, "drill-exec-p2", "GH#2274 pending re-close", "parked");
    expect(p2Reject.status, `text-only park must be refused: ${JSON.stringify(p2Reject.body)}`).toBe(400);
    expect(String(p2Reject.body.error)).toContain("blocked-needs-typed-await");
    const p2Park = await kbJson("/transition", {
      id: p2id, to: "blocked", actor: "drill-exec-p2", session: "drill-exec-p2", note: "parked",
      unblock_condition: "GH#2274 pending re-close",
      await_event: { event: "pr_merged", repo: "state-vector/superpositional", n: 2400 },
    });
    expect(p2Park.status, `typed park failed: ${JSON.stringify(p2Park.body)}`).toBe(200);

    // P3: well-formed pr_merged atom — the hub cannot read it either
    const p3 = await kbJson("/create", { type: "task", title: "IMPL: gh-atom drill", qualified: true, session: "drill-exec-p3" });
    const p3id = String(p3.body.id);
    await block(p3id, "drill-exec-p3",
      "Machine proxy: PR https://github.com/state-vector/superpositional/pull/2400 mergeCommit non-null (state=MERGED). Then a fresh session closes the leg.",
      "parked");

    // sweep past the park-time flood window (the park rounds stamped
    // last_unblock_spawn ~t0 with the same exit text)
    const sweep1 = await kbJson("/admin.unblock_proxy_sweep", { now: t0 + 61 * 60_000 });
    expect(sweep1.status, `sweep1 failed: ${JSON.stringify(sweep1.body)}`).toBeLessThan(500);
    expect(sweep1.body.error).toBeUndefined();

    // P1/P3: executor probes pending — stamped, never flipped,
    // nothing spawned from the sweep
    for (const id of [p1id, p3id]) {
      const now = await taskById(id);
      expect(now.meta?.proxy_check?.verdict, `${id}`).toBe("probe_pending");
      expect(now.status).toBe("blocked");
      expect(now.meta?.proxy_check?.spawned).toBeUndefined();
    }

    // P2: the typed await is stored (annotation rides along); the sweep
    // queues the same executor probe as a prose PR-merge atom
    const p2Now = await taskById(p2id);
    expect(p2Now.meta?.blocked?.await_event).toEqual({ event: "pr_merged", repo: "state-vector/superpositional", n: 2400 });
    expect(p2Now.meta?.proxy_check?.verdict).toBe("probe_pending");
    expect(p2Now.meta?.proxy_check?.spawned).toBeUndefined();
    const probes = (await kbJson("/proxy.probes", {})).body.probes;
    expect(probes).toEqual(expect.arrayContaining([expect.objectContaining({ key: "merged:state-vector/superpositional#2400" })]));

    // a second sweep re-stamps the same verdicts (per-card pacing, no churn
    // audits, no duties of any kind from the sweep)
    const sweep2 = await kbJson("/admin.unblock_proxy_sweep", { now: t0 + 61 * 60_000 + 17 * 60_000 });
    expect(sweep2.body.error).toBeUndefined();
    const p1After = await taskById(p1id);
    expect(p1After.meta?.proxy_check?.verdict).toBe("probe_pending");
    expect(p1After.meta?.proxy_check?.spawned).toBeUndefined();
    const openDuties = (await unblockDuties()).filter((d: any) =>
      d.title.startsWith("Unblock: IMPL: re-close GH #2274") && ["todo", "in_progress", "blocked"].includes(d.status));
    expect(openDuties.length).toBe(0);
  });

  // ---------- BR#3668: stale-true dedup + the human-gate law (real DO) ----------

  it("completed rounds continue born-true and false→true waits without repeat duty churn", async () => {
    const sweepDutiesFor = (titlePrefix: string) =>
      (async () => (await unblockDuties()).filter((x: any) =>
        x.title.startsWith(titlePrefix) && String(x.body_md).includes("MACHINE PROXY")))();

    // S1 — the stale-true specimen: the target card is ALREADY done at park
    // time (the BR#3358 shape — the atom is born true and can never flip).
    const t1 = await kbJson("/create", { type: "task", title: "Canonical: stale-true target", roles: ["analysis"], qualified: true, session: "drill-exec-s1t" });
    const t1id = String(t1.body.id);
    await kbJson("/transition", { id: t1id, to: "in_progress", actor: "drill-exec-s1t", session: "drill-exec-s1t" });
    const t1done = await kbJson("/transition", { id: t1id, to: "done", actor: "drill-exec-s1t", execution_result: { outcome: "Analysis observation precedes the park", receipts: [t1id] }, note: "done BEFORE the park — the stale-true specimen" });
    expect(t1done.status, JSON.stringify(t1done.body)).toBe(200);

    const s1 = await kbJson("/create", { type: "task", title: "IMPL: stale-true dedup drill", qualified: true, session: "drill-exec-s1" });
    const s1id = String(s1.body.id);
    await kbJson("/transition", { id: s1id, to: "in_progress", actor: "drill-exec-s1", session: "drill-exec-s1" });
    const park1 = await block(s1id, "drill-exec-s1", `Machine proxy: ${t1id} done. Then a fresh session closes the leg.`, "parked on a born-true atom");
    expect(park1.status, JSON.stringify(park1.body)).toBe(200);

    // close the park-time round so the ≤1-open-child cap cannot mask the sweep
    const round1 = (await unblockDuties()).find((x: any) =>
      x.title.startsWith("Unblock: IMPL: stale-true dedup drill") && ["todo", "in_progress", "blocked"].includes(x.status));
    expect(round1, "the park-time unblock round must exist").toBeTruthy();
    await kbJson("/transition", { id: round1.id, to: "in_progress", actor: "drill-exec-u1", session: "drill-exec-u1" });
    const rd1 = await kbJson("/transition", {
      id: round1.id, to: "done", actor: "drill-exec-u1",
      execution_result: { outcome: "Target was already done at park time; no new flip.", receipts: [t1id] },
      note: "checked first-hand — the target was already done at park time; the card is still blocked at check time (findings)",
    });
    expect(rd1.status, JSON.stringify(rd1.body)).toBe(200);

    // The first round is already complete: consume the known prerequisite
    // and continue the actual task instead of generating another close round.
    const sweep1 = await kbJson("/admin.unblock_proxy_sweep", { now: t0 + 95 * 60_000 });
    expect(sweep1.body.error).toBeUndefined();
    const s1duties = await sweepDutiesFor("Unblock: IMPL: stale-true dedup drill");
    expect(s1duties.length).toBe(0);
    expect((await taskById(s1id)).status).toBe("todo");
    expect((await taskById(s1id)).meta.proxy_check.receipts.join(" ")).toContain(`${t1id} status=done`);

    // sweep again: identical receipt → dedup, NO second duty (the churn dies here)
    const sweep2 = await kbJson("/admin.unblock_proxy_sweep", { now: t0 + 125 * 60_000 });
    expect(sweep2.body.error).toBeUndefined();
    expect((await sweepDutiesFor("Unblock: IMPL: stale-true dedup drill")).length).toBe(0);
    const s1meta = (await taskById(s1id)).meta;
    expect(s1meta?.proxy_check?.verdict).toBe("true");
    expect(s1meta.blocked).toBeUndefined();

    // S2 — a GENUINE false→true transition: the changed receipt spawns, once.
    const t2 = await kbJson("/create", { type: "task", title: "Canonical: late-flip target", roles: ["analysis"], qualified: true, session: "drill-exec-s2t" });
    const t2id = String(t2.body.id);
    await kbJson("/transition", { id: t2id, to: "in_progress", actor: "drill-exec-s2t", session: "drill-exec-s2t" });
    const s2 = await kbJson("/create", { type: "task", title: "IMPL: late-flip drill", qualified: true, session: "drill-exec-s2" });
    const s2id = String(s2.body.id);
    await kbJson("/transition", { id: s2id, to: "in_progress", actor: "drill-exec-s2", session: "drill-exec-s2" });
    const park2 = await block(s2id, "drill-exec-s2", `Machine proxy: ${t2id} done. Then a fresh session closes the leg.`, "parked while the target still runs");
    expect(park2.status, JSON.stringify(park2.body)).toBe(200);
    const round2 = (await unblockDuties()).find((x: any) =>
      x.title.startsWith("Unblock: IMPL: late-flip drill") && ["todo", "in_progress", "blocked"].includes(x.status));
    expect(round2, "the park-time unblock round must exist").toBeTruthy();
    await kbJson("/transition", { id: round2.id, to: "in_progress", actor: "drill-exec-u2", session: "drill-exec-u2" });
    const rd2 = await kbJson("/transition", {
      id: round2.id, to: "done", actor: "drill-exec-u2",
      execution_result: { outcome: "Target still runs; condition does not hold.", receipts: [t2id] },
      note: "checked first-hand — the target still runs, so the card is still blocked at check time; the condition does NOT hold yet (findings)",
    });
    expect(rd2.status, JSON.stringify(rd2.body)).toBe(200);

    // sweep while false → honest false stamp, no duty
    const fsweep = await kbJson("/admin.unblock_proxy_sweep", { now: t0 + 155 * 60_000 });
    expect(fsweep.body.error).toBeUndefined();
    expect((await taskById(s2id)).meta?.proxy_check?.verdict).toBe("false");
    expect((await sweepDutiesFor("Unblock: IMPL: late-flip drill")).length).toBe(0);

    // the flip: the target actually completes
    const t2done = await kbJson("/transition", { id: t2id, to: "done", actor: "drill-exec-s2t", execution_result: { outcome: "Late analysis observation recorded", receipts: [t2id] }, note: "real completion — the false→true transition" });
    expect(t2done.status, JSON.stringify(t2done.body)).toBe(200);

    // sweep on the flip: the CHANGED receipt spawns exactly once
    const fsweep2 = await kbJson("/admin.unblock_proxy_sweep", { now: t0 + 185 * 60_000 });
    expect(fsweep2.body.error).toBeUndefined();
    const s2duties = await sweepDutiesFor("Unblock: IMPL: late-flip drill");
    expect(s2duties.length).toBe(0);
    expect((await taskById(s2id)).status).toBe("todo");
    expect((await taskById(s2id)).meta.proxy_check.receipts.join(" ")).toContain(`${t2id} status=done`);

    // and a further sweep with the same receipt spawns nothing more
    const fsweep3 = await kbJson("/admin.unblock_proxy_sweep", { now: t0 + 215 * 60_000 });
    expect(fsweep3.body.error).toBeUndefined();
    expect((await sweepDutiesFor("Unblock: IMPL: late-flip drill")).length).toBe(0);
  });

  it("BR#3668: a human-gated park never flips — a machine-shaped await_event contradicting the markers is ignored, no spawn, no migration ask", async () => {
    const t3 = await kbJson("/create", { type: "task", title: "Canonical: human-gated target", roles: ["analysis"], qualified: true, session: "drill-exec-s3t" });
    const t3id = String(t3.body.id);
    await kbJson("/transition", { id: t3id, to: "in_progress", actor: "drill-exec-s3t", session: "drill-exec-s3t" });
    const t3done = await kbJson("/transition", { id: t3id, to: "done", actor: "drill-exec-s3t", execution_result: { outcome: "Board analysis observation recorded", receipts: [t3id] }, note: "done — the machine leg reads true, the exit is still human-only" });
    expect(t3done.status, JSON.stringify(t3done.body)).toBe(200);

    const s3 = await kbJson("/create", { type: "task", title: "IMPL: human-gated park drill", qualified: true, session: "drill-exec-s3" });
    const s3id = String(s3.body.id);
    await kbJson("/transition", { id: s3id, to: "in_progress", actor: "drill-exec-s3", session: "drill-exec-s3" });
    // the BR#3358 shape: human-only text of record + a machine-shaped await
    // (the poison the pre-BR#3668 sweep derived from the prose) whose target
    // IS done — the flip must still never fire.
    const park3 = await kbJson("/transition", {
      id: s3id, to: "blocked", actor: "drill-exec-s3", session: "drill-exec-s3",
      note: "STAND-DOWN park — the only exit is a human supersede",
      unblock_condition: `Human-only: the owner supersedes via web/admin. No machine atom can flip this — a future claimant verifies first (${t3id} done, decision BR#3409), stands down and re-parks.`,
      await_event: { event: "br_done", id: t3id },
    });
    expect(park3.status, JSON.stringify(park3.body)).toBe(200);

    const hsweep = await kbJson("/admin.unblock_proxy_sweep", { now: t0 + 245 * 60_000 });
    expect(hsweep.body.error).toBeUndefined();
    const s3meta = (await taskById(s3id)).meta;
    expect(s3meta?.proxy_check?.verdict).toBe("unparseable");
    expect(String(s3meta?.proxy_check?.detail ?? "")).toContain("human-gated by design");
    expect(s3meta?.proxy_check?.spawned).toBeUndefined();
    // the marker names the human leg already engaged — no migration ask, and
    // the sweep spawned nothing (only the park-time machine round exists, and
    // it carries no MACHINE PROXY receipts block)
    expect(s3meta?.blocked?.await_migration_ask).toBeUndefined();
    expect((await unblockDuties()).filter((x: any) =>
      x.title.startsWith("Unblock: IMPL: human-gated park drill") && String(x.body_md).includes("MACHINE PROXY")).length).toBe(0);
  });
});

// ---------- (a2) BR#3986: multi-atom conjunctions + the self-await fence ----------

describe("BR#3986 — multi-atom conjunctions + self-await migration fence (real DO)", () => {
  const mkLeg = async (title: string, session: string, done: boolean) => {
    // analysis-role leg: done skips the review gate for analysis children and
    // never passes through in_review (in_review auto-spawns a verify child,
    // which would trip done-open-children) — the drill flips board state only
    const r = await kbJson("/create", { type: "task", title, qualified: true, roles: ["analysis"], session });
    const id = String(r.body.id);
    await kbJson("/transition", { id, to: "in_progress", actor: session, session });
    if (done) {
      const d = await kbJson("/transition", { id, to: "done", actor: session, session, execution_result: { outcome: "Drill leg verified first-hand", receipts: [id] }, note: "done — drill leg verified first-hand" });
      expect(d.status, JSON.stringify(d.body)).toBe(200);
    }
    return id;
  };

  it("a legacy conjunction park evaluates EVERY atom — the flip waits for BOTH legs; nothing self-migrates", async () => {
    const legA = await mkLeg("DRILL 3986 leg A", "drill-3986-a", true);
    const legB = await mkLeg("DRILL 3986 leg B", "drill-3986-b", false);
    // the parked card parks LEGALLY on a placeholder atom (the conjunction
    // text is refused at the door post-fix), the park-time round is closed,
    // then the blocked record's text is swapped to the legacy conjunction —
    // exactly the pre-fix card state the BR#3557 park is in today
    const r = await kbJson("/create", { type: "task", title: "IMPL: 3986 conjunction drill", qualified: true, session: "drill-3986-exec" });
    const pid = String(r.body.id);
    await kbJson("/transition", { id: pid, to: "in_progress", actor: "drill-3986-exec", session: "drill-3986-exec" });
    const blk = await block(pid, "drill-3986-exec", "BR#999995 done", "parked on the conjunction (placeholder leg)");
    expect(blk.status, JSON.stringify(blk.body)).toBe(200);
    const round = (await unblockDuties()).find((x: any) => x.title === "Unblock: IMPL: 3986 conjunction drill");
    expect(round, "the park-time round must spawn").toBeTruthy();
    await kbJson("/transition", { id: round.id, to: "in_progress", actor: "drill-3986-u", session: "drill-3986-u" });
    const rd = await kbJson("/transition", {
      id: round.id, to: "done", actor: "drill-3986-u",
      execution_result: { outcome: "Placeholder leg does not exist; condition remains blocked.", receipts: [pid] },
      note: "checked the condition first-hand — still blocked at check time (findings); placeholder leg does not exist",
    });
    expect(rd.status, JSON.stringify(rd.body)).toBe(200);
    const row0 = await taskById(pid);
    expect(row0.status).toBe("blocked");
    const cond = `${legA} done AND ${legB} done`;
    const up = await kbJson("/update", {
      id: pid, session: "drill-3986-exec",
      // legacy shape: pre-BR#3578 cards carry NO typed await — clear the
      // placeholder's self-migrated event so the sweep reads the text
      meta: { ...row0.meta, blocked: { ...row0.meta.blocked, unblock_condition: cond, await_event: undefined } },
    });
    expect(up.status, JSON.stringify(up.body)).toBe(200);

    // sweep 1: only legA is done — the conjunction must NOT flip (pre-fix it
    // gated on the first atom alone and would have flipped HERE). Timestamps
    // ride past the earlier suites' sweeps (the global pacer drops calls
    // older than the last sweep).
    const s1 = await kbJson("/admin.unblock_proxy_sweep", { now: t0 + 290 * 60_000 });
    expect(s1.body.error).toBeUndefined();
    let now = await taskById(pid);
    expect(now.meta?.blocked?.await_event).toBeUndefined(); // N atoms never self-migrate
    expect(now.meta?.proxy_check?.verdict).toBe("false");
    expect(now.meta?.proxy_check?.atoms).toHaveLength(2);
    expect(now.meta?.proxy_check?.spawned).toBeUndefined();

    // leg B completes → the conjunction flips → the duty spawns
    await kbJson("/transition", { id: legB, to: "in_progress", actor: "drill-3986-b", session: "drill-3986-b" });
    const d = await kbJson("/transition", { id: legB, to: "done", actor: "drill-3986-b", session: "drill-3986-b", execution_result: { outcome: "Drill leg B verified first-hand", receipts: [legB] }, note: "done — drill leg verified first-hand" });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const s2 = await kbJson("/admin.unblock_proxy_sweep", { now: t0 + 305 * 60_000 });
    expect(s2.body.error).toBeUndefined();
    now = await taskById(pid);
    expect(now.meta?.proxy_check?.verdict).toBe("true");
    const duty = (await unblockDuties()).find((x: any) => x.title === "Unblock: IMPL: 3986 conjunction drill");
    expect(duty, "the conjunction-flip duty must spawn once both atoms hold").toBeTruthy();
    expect(duty.status).toBe("todo");
  });

  it("a legacy self-referential park never self-migrates the deadlock await (the BR#136 class)", async () => {
    const r = await kbJson("/create", { type: "task", title: "IMPL: 3986 self-await drill", qualified: true, session: "drill-3986-self" });
    const pid = String(r.body.id);
    await kbJson("/transition", { id: pid, to: "in_progress", actor: "drill-3986-self", session: "drill-3986-self" });
    // bound-ask park (the ask is the human leg) whose free text names the
    // card's own done — the BR#136 park shape. The writer must NOT stamp the
    // derived self-await.
    const blk = await kbJson("/transition", {
      id: pid, to: "blocked", actor: "drill-3986-self", session: "drill-3986-self",
      note: "parked on a human ruling", awaiting_ask_id: "ASK-drill-3986",
      unblock_condition: `transitions ${pid} done`,
    });
    expect(blk.status, JSON.stringify(blk.body)).toBe(200);
    const s = await kbJson("/admin.unblock_proxy_sweep", { now: t0 + 320 * 60_000 });
    expect(s.body.error).toBeUndefined();
    const now = await taskById(pid);
    // pre-fix, the single self-naming atom self-migrated into
    // await_event {br_done, <the card>} — a park that can never fire
    expect(now.meta?.blocked?.await_event).toBeUndefined();
    expect(now.meta?.proxy_check?.verdict).toBe("false"); // still blocked on itself
  });
});

// ---------- (b) terminal close-leg ownership ----------

describe("done-close-legs auto-derivation (real DO)", () => {
  it("unreceipted done is rejected, derives the close-duty child once, and the child's receipted done unblocks the parent", async () => {
    const d = await kbJson("/create", {
      type: "task", title: "IMPL: close-leg drill", qualified: true, session: "drill-exec-parent",
      meta: { completion: { kind: "execution", outcome: "Close the issue and verify the actual closure receipt" } },
      body_md: "work\n\n## Done when\n- close GH #2261 (the incident issue)\n",
    });
    expect(d.status).toBe(200);
    const dId = String(d.body.id);
    await kbJson("/transition", { id: dId, to: "in_progress", actor: "drill-exec-parent", session: "drill-exec-parent" });

    // done without a receipt → gate rejects, error names the rule
    const execution_result = { outcome: "Closure leg inspected", receipts: [dId] };
    const rej = await kbJson("/transition", { id: dId, to: "done", actor: "drill-exec-parent", execution_result, note: "work complete" });
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
    const rej2 = await kbJson("/transition", { id: dId, to: "done", actor: "drill-exec-parent", execution_result, note: "work complete (retry)" });
    expect(rej2.status).toBe(400);
    const duties2 = (await unblockDuties()).filter((x: any) => x.title.startsWith("Close-leg duty: IMPL: close-leg drill"));
    expect(duties2.length).toBe(1);

    // the closer executes the leg: receipted done on the child (a different
    // session — separation of duties bars the parent's session)
    await kbJson("/transition", { id: childId, to: "in_progress", actor: "drill-exec-closer", session: "drill-exec-closer" });
    const childDone = await kbJson("/transition", {
      id: childId, to: "done", actor: "drill-exec-closer",
      execution_result: { outcome: "Issue closed and closing comment observed", receipts: ["https://github.com/state-vector/superpositional/issues/2261#issuecomment-17623388240"] },
      note: "close executed: GH #2261 state=closed, closing comment 17623388240 (https://github.com/state-vector/superpositional/issues/2261#issuecomment-17623388240), guard run 40198911366 guard=allow",
    });
    expect(childDone.status, `child done failed: ${JSON.stringify(childDone.body)}`).toBe(200);

    // now the parent's done passes — the closed close-duty child owns the leg
    await completeExecutionReview(kbJson, dId, { outcome: "Issue closure and its closing comment verified", receipts: ["https://github.com/state-vector/superpositional/issues/2261#issuecomment-17623388240"] });
    expect((await taskById(dId)).status).toBe("done");
  });
});

// ---------- (c) the closure-receipt audit — GONE with BR#3516 ----------
// The audit sweep class is deleted: receipts' truth is owned by the verify
// session that cites them (head-stamped close notes) and by the train's
// machine-proxy close (train:landed — mergeCommit non-null + main green),
// pinned in train-hub.test.ts. The hub never re-reads GitHub to check a
// receipt — it has no credentials to do so.

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
      await_event: { event: "pr_merged", repo: "state-vector/superpositional", n: 2400 },
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

// ---------- ask inbox routing (the cody inbox dump) ----------

describe("askInbox addressee routing (real DO)", () => {
  it("an agent's inbox carries only asks addressed to it: any | label | label@session | tag:<capability> — never human-directed asks", async () => {
    const subject = (await kbJson("/create", { type: "task", title: "Human routing policy" })).body.id;
    // three asks: one to the human, one to any agent, one to a capability tag
    const toHuman = await kbJson("/ask.create", {
      to: "ray", question: "Human ruling drill?",
      reason: "drill — human-directed ask must never land in an agent inbox",
      details: "Inbox-routing drill: a ray-directed ask must surface on the human planes only, never in agent inboxes.",
      options: ["(Recommended) GO", "NO-GO"], artefact_id: null,
      decision: decisionFixture(subject, ["(Recommended) GO", "NO-GO"]),
    });
    expect(toHuman.status, JSON.stringify(toHuman.body)).toBe(200);
    const toAny = await kbJson("/ask.create", {
      to: "any", question: "Any agent drill?",
      reason: "drill", options: ["GO", "NO-GO"], artefact_id: null,
    });
    expect(toAny.status).toBe(200);
    const toTag = await kbJson("/ask.create", {
      to: "tag:datadog-access", question: "Capability tag drill?",
      reason: "drill", options: ["GO", "NO-GO"], artefact_id: null,
    });
    expect(toTag.status).toBe(200);

    // a fresh token's inbox (the cody class: label only, no matching tags)
    const mine = await kbJson("/ask.inbox", { label: "_direct/cody" });
    expect(mine.status).toBe(200);
    const ids = (mine.body?.inbox ?? []).map((x: any) => x.id);
    expect(ids).toContain(String(toAny.body.id)); // any = everyone's
    expect(ids).not.toContain(String(toHuman.body.id)); // human-directed — never an agent's
    expect(ids).not.toContain(String(toTag.body.id)); // tag not mine

    // tag routing: an agent carrying the tag sees the tagged ask
    const tagged = await kbJson("/ask.inbox", { label: "drill-dd-agent", tags: ["datadog-access"] });
    expect((tagged.body?.inbox ?? []).map((x: any) => x.id)).toContain(String(toTag.body.id));

    // label@session routing: session-scoped ask reaches the label
    const toSession = await kbJson("/ask.create", {
      to: "drill-dd-agent@dispatch-42", question: "Session-scoped drill?",
      reason: "drill", options: ["GO", "NO-GO"], artefact_id: null,
    });
    expect(toSession.status).toBe(200);
    const mine2 = await kbJson("/ask.inbox", { label: "drill-dd-agent" });
    expect((mine2.body?.inbox ?? []).map((x: any) => x.id)).toContain(String(toSession.body.id));
  });
});

// ---------- (BR#4062) ask/time prose parks type at the door, sweep first-class ----------

describe("BR#4062 — ask/time prose parks type at the door and sweep first-class (real DO)", () => {
  it("a timer prose park (the takeover repro) types at the door and the sweep WAITS, honest", async () => {
    // BR#5623: until_ts must be derived from t0, never a hardcoded wall-clock
    // instant. The frozen 1793673600000 (= 2026-11-03T02:40Z) made the sweep's
    // synthetic clock (t0 + 400min) overtake the timer for every run after
    // 2026-11-02T20:00Z — a calendar time-bomb that turned this test red on
    // the first CI run to cross it, blocking an unrelated PR.
    const untilTs = t0 + 800 * 60_000;
    const r = await kbJson("/create", { type: "task", title: "IMPL: 4062 time-prose drill", qualified: true, session: "drill-4062-time" });
    const pid = String(r.body.id);
    await kbJson("/transition", { id: pid, to: "in_progress", actor: "drill-4062-time", session: "drill-4062-time" });
    // THE regression: this exact park shape REJECTED from MCP on 2026-10-28
    const blk = await block(pid, "drill-4062-time",
      `Machine proxy (typed await_event time until_ts=${untilTs}): the card re-enters at the timer → then a FRESH session closes it done.`,
      "parked on a typed timer (BR#4062 repro)");
    expect(blk.status, JSON.stringify(blk.body)).toBe(200);
    const parked = await taskById(pid);
    expect(parked.status).toBe("blocked");
    // the typed event self-stamped at the door (not just text)
    expect(parked.meta?.blocked?.await_event).toEqual({ event: "time", until_ts: untilTs });

    const s = await kbJson("/admin.unblock_proxy_sweep", { now: t0 + 400 * 60_000 });
    expect(s.body.error).toBeUndefined();
    const after = await taskById(pid);
    expect(after.meta?.proxy_check?.verdict).toBe("waiting"); // first-class timer leg — not "unparseable"
    expect(String(after.meta?.proxy_check?.detail)).toContain("timer until");
  });

  it("an ask prose park types to {event:ask}; the sweep waits while the ask is OPEN", async () => {
    const r = await kbJson("/create", { type: "task", title: "IMPL: 4062 ask-prose drill", qualified: true, session: "drill-4062-ask" });
    const pid = String(r.body.id);
    await kbJson("/transition", { id: pid, to: "in_progress", actor: "drill-4062-ask", session: "drill-4062-ask" });
    const ask = await kbJson("/ask.create", {
      to: "legacy-peer", question: "4062 drill ruling?", reason: "drill",
      options: ["GO", "NO-GO"], artefact_id: null,
      details: "drill brief: fixture ask for the BR#4062 ask-leg sweep-waits-while-open behavior.",
    });
    expect(ask.status).toBe(200);
    const askId = String(ask.body.id);
    const blk = await block(pid, "drill-4062-ask",
      `Machine proxy (typed await_event ask ask_id=${askId}): the ruling gates re-entry.`,
      "parked on the ruling (BR#4062 repro)");
    expect(blk.status, JSON.stringify(blk.body)).toBe(200);
    const parked = await taskById(pid);
    expect(parked.meta?.blocked?.await_event).toEqual({ event: "ask", ask_id: askId });

    const s = await kbJson("/admin.unblock_proxy_sweep", { now: t0 + 460 * 60_000 });
    expect(s.body.error).toBeUndefined();
    const after = await taskById(pid);
    expect(after.meta?.proxy_check?.verdict).toBe("waiting");
    expect(String(after.meta?.proxy_check?.detail)).toContain(`awaiting ask ${askId}`);
  });
});

// ---------- (f) BR#4282 — the silence-release loop ----------

describe("BR#4282 — satisfied-atom route-to-exit on the stall sweep (real DO)", () => {
  it("a silent in_progress card whose pr leg ALREADY merged is never re-parked blocked: resume consumed the old round, the sweep spawns the OWNED done-close duty, and the duty's close order lands the parent done", async () => {
    // 1. the specimen: an impl card parked on a typed pr_merged proxy. The
    // park-time machine round spawns (transition law, unchanged) and stamps
    // its exit condition.
    const c = await kbJson("/create", { type: "task", title: "IMPL: br4282 drill", qualified: true, session: "drill-exec-br4282" });
    expect(c.status).toBe(200);
    const id = String(c.body.id);
    await kbJson("/transition", { id, to: "in_progress", actor: "drill-exec-br4282", session: "drill-exec-br4282" });
    const park = await kbJson("/transition", {
      id, to: "blocked", actor: "drill-exec-br4282", session: "drill-exec-br4282",
      note: "parked on the merge gate",
      unblock_condition: "PR https://github.com/state-vector/superpositional/pull/2400 merged",
      await_event: { event: "pr_merged", repo: "state-vector/superpositional", n: 2400 },
    });
    expect(park.status, `park failed: ${JSON.stringify(park.body)}`).toBe(200);
    const parked = await taskById(id);
    expect(String(parked.meta?.last_unblock_spawn?.exit)).toContain("pull/2400 merged");
    const parkRound = (await unblockDuties()).find((x: any) =>
      x.title.startsWith("Unblock: IMPL: br4282 drill") && ["todo", "in_progress", "blocked"].includes(x.status));
    expect(parkRound, "the park-time unblock round must exist").toBeTruthy();

    // 2. the duty verifies the exit from the BOARD — the train merged the leg —
    // and resumes the parent (blocked → in_progress). PR 2400 is open in the
    // canned GitHub on purpose: the hub must NOT be able to lean on GitHub
    // state here (BR#3516) — only board receipts count.
    const resumed = await kbJson("/transition", {
      id, to: "in_progress", actor: "drill-exec-u4282", session: "drill-exec-u4282",
      note: "exit condition verified on the train — leg merged, resuming",
    });
    expect(resumed.status, `resume failed: ${JSON.stringify(resumed.body)}`).toBe(200);

    // the resume CONSUMED the round: the stamp cleared, the park round closed.
    // This is the anti-flood half of the fix: post-resume silence must issue a
    // FRESH (owned) round, not flood-guard against a stamp whose round is gone.
    const live = await taskById(id);
    expect(live.status).toBe("in_progress");
    expect(live.meta?.last_unblock_spawn).toBeUndefined();

    // 3. the train's own receipt, exactly what train:merged stamps (do.ts):
    // awaiting-ci + merge sha. The hub holds no VCS credentials — this is the
    // only merge proof it can read.
    const sha = "4282feedface4282feedface4282feedface4282";
    const withReceipt = await kbJson("/update", {
      id, actor: "drill-exec-br4282",
      meta: {
        ...(live.meta ?? {}),
        merge_train: { state: "awaiting-ci", pr: 2400, repo: "state-vector/superpositional", merge_sha: sha, merged_at: t0 + 60_000 },
      },
    });
    expect(withReceipt.status, `receipt stamp failed: ${JSON.stringify(withReceipt.body)}`).toBe(200);

    // 4. the card goes silent past the stale window. The OLD code re-parked it
    // blocked on the ALREADY-SATISFIED proxy (re-deriving the await from
    // trainProxyEvent, never evaluating the atom) and re-issued an identical
    // round → flood-skip → threshold-1 spawn-while-open breach.
    const sweep = await kbJson("/admin.stall_sweep", { now: t0 + 11 * 60_000 });
    expect(sweep.status, `stall sweep failed: ${JSON.stringify(sweep.body)}`).toBeLessThan(500);
    expect(sweep.body.error).toBeUndefined();

    // NEVER blocked: the satisfied atom routed to the exit instead
    const after = await taskById(id);
    expect(after.status, "the satisfied card must never re-park blocked").toBe("in_progress");
    expect(after.meta?.blocked).toBeUndefined();
    expect(after.meta?.proxy_check?.verdict).toBe("true");
    expect(after.meta?.proxy_check?.spawn_skipped).toBeUndefined();

    // the OWNED done-close round: a fresh Unblock duty carrying the machine
    // proxy receipt and the BR#4282 close-order contract (parent in_progress →
    // it owes a done-close, NOT a resume)
    const rounds = (await unblockDuties()).filter((x: any) =>
      x.title.startsWith("Unblock: IMPL: br4282 drill") && ["todo", "in_progress", "blocked"].includes(x.status));
    expect(rounds.length, `expected exactly 1 open round, got ${JSON.stringify(rounds.map((r: any) => [r.id, r.status]))}`).toBe(1);
    const round = rounds[0];
    expect(round.roles).toContain("unblock");
    expect(String(round.body_md)).toContain("MACHINE PROXY");
    expect(String(round.body_md)).toContain(sha.slice(0, 9));
    expect(String(round.body_md)).toContain("BR#4282");
    expect(String(round.body_md)).toContain("Close YOURSELF done with execution_result");

    // 5. the contract executes: the duty closes ITSELF done first (receipts
    // cited — the done-open-children gate needs the child closed), then the
    // parent's done lands with the same receipts. Owned, terminal, no breach.
    await kbJson("/transition", { id: round.id, to: "in_progress", actor: "drill-exec-closer4282", session: "drill-exec-closer4282" });
    const roundDone = await kbJson("/transition", {
      id: round.id, to: "done", actor: "drill-exec-closer4282",
      execution_result: { outcome: "Merge observed; awaiting-CI is not decisive deployment success.", receipts: ["https://github.com/state-vector/superpositional/pull/2400"] },
      note: "verified on the board receipts: PR 2400 merged as 4282feedf (train awaiting-ci stamp, BR#4282) — closing the parent done",
    });
    expect(roundDone.status, `duty done failed: ${JSON.stringify(roundDone.body)}`).toBe(200);
    const parentDone = await kbJson("/transition", {
      id, to: "done", actor: "drill-exec-closer4282",
      note: "closed via the unblock duty: PR https://github.com/state-vector/superpositional/pull/2400 merged as 4282feedf (board merge receipt)",
    });
    expect(parentDone.status).toBe(400);
    expect((await taskById(id)).status).toBe("in_progress");
  });
});

describe("BR#4494 — bounce re-entry demote on the stall sweep (real DO)", () => {
  it("BR#6839: a fresh gateway session ping cannot revive an executor-less bounce; an actual worker ping can", async () => {
    for (const gateway of [true, false]) {
      const session = `br6839-${gateway ? "gateway" : "worker"}`;
      const token = await kbJson("/admin.mint", { label: session, tags: gateway ? ["gateway"] : ["impl"] });
      expect(token.body.error).toBeUndefined();
      const created = await kbJson("/create", { type: "task", title: session, qualified: true });
      const id = created.body.id;
      await kbJson("/transition", { id, to: "in_progress", actor: session, session: `${session}-old` });
      const updated = await kbJson("/update", { id, meta: { session,
        merge_train: { state: "bounced", pr: 6839, repo: "state-vector/bridge" },
        last_progress: { session: "another-duty", ts: Date.now(), note: "unrelated task update" } } });
      expect(updated.body.error).toBeUndefined();
      const touched = await kbJson("/session.touch", { token_id: token.body.id, session });
      expect(touched.body.error).toBeUndefined();
      await kbJson("/admin.stall_sweep", { now: Date.now() + 1_000 });
      expect((await taskById(id)).status).toBe(gateway ? "todo" : "in_progress");
    }
  });
  it("a bounce re-entry stranded in_progress (dead executor) is DEMOTED to a claimable todo by the sweep — never re-parked blocked; train meta + boost survive", async () => {
    // The specimen shape (BR#4198): a train bounce re-opened its card
    // in_progress with the PRIOR session as executor; the session is gone and
    // nothing pings. Since BR#4962 a coverage bounce parks the card blocked
    // Awaiting (zero asks) and the old self-heal re-entry is retired — this
    // drill pins the FALLBACK for every path that still strands the
    // unclaimable in_progress: the sweep must release it claimable, never
    // re-park it blocked (the 4×-bounce loop).
    const c = await kbJson("/create", { type: "task", title: "IMPL: br4494 demote drill", qualified: true, session: "drill-exec-br4494" });
    expect(c.status).toBe(200);
    const id = String(c.body.id);
    const claim = await kbJson("/transition", { id, to: "in_progress", actor: "drill-exec-br4494", session: "drill-exec-br4494" });
    expect(claim.status, `claim failed: ${JSON.stringify(claim.body)}`).toBe(200);
    // the bounce's stamps, exactly what train:bounced writes (do.ts): state
    // bounced on a live PR leg + the starvation-law boost. The executor then
    // dies — no progress, no ping, past the stale window.
    const stamp = await kbJson("/update", {
      id, actor: "drill-exec-br4494",
      meta: {
        merge_train: { state: "bounced", bounce_kind: "coverage", pr: 2401, repo: "state-vector/superpositional", bounced_at: t0 + 30_000 },
        boosted: t0 + 30_000,
        // A recent recovery duty update must not revive the old worker.
        last_progress: { session: "different-recovery-duty", ts: t0 + 10 * 60_000, note: "repair still needs a worker" },
      },
    });
    expect(stamp.status, `stamp failed: ${JSON.stringify(stamp.body)}`).toBe(200);

    const sweep = await kbJson("/admin.stall_sweep", { now: t0 + 11 * 60_000 });
    expect(sweep.status, `stall sweep failed: ${JSON.stringify(sweep.body)}`).toBeLessThan(500);
    expect(sweep.body.error).toBeUndefined();

    const after = await taskById(id);
    expect(after.status, "the stranded re-entry must be DEMOTED to claimable todo, not re-parked blocked").toBe("todo");
    expect(after.meta?.blocked).toBeUndefined();
    // the re-queue seam + the starvation law survive the release
    expect(after.meta?.merge_train?.state).toBe("bounced");
    expect(after.meta?.boosted).toBeTruthy();
    // Releasing a machine-created phantom is not an agent failure.
    expect(after.owner).toBe("");
    expect(after.meta?.session).toBeUndefined();
    expect(after.meta?.attempt).toBeUndefined();
  });

  it("the hold is NOT loosened: a queued card (flag or not) and a parked blocked bounced card stay held — only the live in_progress re-entry demotes", async () => {
    // queued + live in_progress: the train owns the leg — the sweep must
    // re-park blocked even though a forged flag rides the transition shape
    // (the sweep itself would never pass one for queued; this pins the gate).
    const q = await kbJson("/create", { type: "task", title: "IMPL: br4494 queued hold drill", qualified: true, session: "drill-exec-br4494q" });
    expect(q.status).toBe(200);
    const qid = String(q.body.id);
    await kbJson("/transition", { id: qid, to: "in_progress", actor: "drill-exec-br4494q", session: "drill-exec-br4494q" });
    await kbJson("/update", {
      id: qid, actor: "drill-exec-br4494q",
      meta: { merge_train: { state: "queued", pr: 2402, repo: "state-vector/superpositional" } },
    });
    const sweep = await kbJson("/admin.stall_sweep", { now: t0 + 12 * 60_000 });
    expect(sweep.body.error).toBeUndefined();
    const qAfter = await taskById(qid);
    expect(qAfter.status, "queued keeps parks-not-releases (BR#4067 — live queue slot)").toBe("blocked");
    expect(String(qAfter.meta?.blocked?.reason ?? "")).toContain("queued");

    // a parked BLOCKED bounced card: the demote carve-out is scoped to the
    // in_progress re-entry — a park stays parked (the flag alone must not
    // release it; the sweep's hold-park passes no flag, and the gate would
    // refuse one from blocked).
    const b = await kbJson("/create", { type: "task", title: "IMPL: br4494 parked bounce drill", qualified: true, session: "drill-exec-br4494b" });
    expect(b.status).toBe(200);
    const bid = String(b.body.id);
    await kbJson("/transition", { id: bid, to: "in_progress", actor: "drill-exec-br4494b", session: "drill-exec-br4494b" });
    await kbJson("/transition", {
      id: bid, to: "blocked", actor: "drill-exec-br4494b", session: "drill-exec-br4494b",
      note: "parked on the merge gate",
      unblock_condition: "PR https://github.com/state-vector/superpositional/pull/2403 merged",
      await_event: { event: "pr_merged", repo: "state-vector/superpositional", n: 2403 },
    });
    await kbJson("/update", {
      id: bid, actor: "drill-exec-br4494b",
      meta: {
        ...(  (await taskById(bid)).meta ?? {}),
        merge_train: { state: "bounced", bounce_kind: "gate", pr: 2403, repo: "state-vector/superpositional", bounced_at: t0 + 40_000 },
      },
    });
    const sweep2 = await kbJson("/admin.stall_sweep", { now: t0 + 13 * 60_000 });
    expect(sweep2.body.error).toBeUndefined();
    const bAfter = await taskById(bid);
    expect(bAfter.status, "a parked blocked bounced card stays parked — the carve-out is in_progress-only").toBe("blocked");
  });
});

describe("BR#5750 — awaiting re-park loop + hold-park queue prefix (real DO)", () => {
  it("the livelock chain is dead end-to-end: a verifier bounce of an Awaiting park flips it to bounced (leaving the park ends it), and the stalled re-entry DEMOTES to claimable todo — never re-parked blocked (the BR#3853/3937/5139 loop)", async () => {
    const c = await kbJson("/create", { type: "task", title: "IMPL: br5750 awaiting unpark drill", qualified: true, session: "drill-exec-br5750" });
    expect(c.status).toBe(200);
    const id = String(c.body.id);
    // The specimen shape, exactly what train:bounce_awaiting_park writes: an
    // Awaiting human-leg park — blocked on the typed pr_merged proxy,
    // merge_train.state = awaiting on the live leg.
    const park = await kbJson("/transition", {
      id, to: "blocked", actor: "drill-exec-br5750", session: "drill-exec-br5750",
      note: "coverage bounce needs a human leg",
      unblock_condition: "PR https://github.com/state-vector/superpositional/pull/2404 merged",
      await_event: { event: "pr_merged", repo: "state-vector/superpositional", n: 2404 },
    });
    expect(park.status, `park failed: ${JSON.stringify(park.body)}`).toBe(200);
    // /update meta REPLACES wholesale — spread the live meta so the park's
    // blocked record (the typed pr_merged await) survives the stamp, exactly
    // what train:bounce_awaiting_park writes in place.
    const stamp = await kbJson("/update", {
      id, actor: "drill-exec-br5750",
      meta: {
        ...((await taskById(id)).meta ?? {}),
        merge_train: { state: "awaiting", bounce_kind: "coverage", pr: 2404, repo: "state-vector/superpositional", awaiting: { at: t0 + 1000 } },
      },
    });
    expect(stamp.status, `stamp failed: ${JSON.stringify(stamp.body)}`).toBe(200);
    // The verifier bounce — the exact edge that used to leave `awaiting`
    // live on an in_progress card (the loop's first half).
    const bounce = await kbJson("/transition", { id, to: "in_progress", actor: "drill-verify-br5750", session: "drill-verify-br5750", note: "PR CONFLICTING/DIRTY — fix forward" });
    expect(bounce.status, `bounce failed: ${JSON.stringify(bounce.body)}`).toBe(200);
    const afterBounce = await taskById(id);
    expect(afterBounce.status).toBe("in_progress");
    expect(afterBounce.meta?.merge_train?.state, "leaving the Awaiting park ENDS it — awaiting flips to bounced (BR#5750)").toBe("bounced");
    expect(afterBounce.meta?.merge_train?.awaiting).toBeUndefined();
    // The executor then dies — the stalled re-entry must DEMOTE (the loop's
    // second half), never hold-park straight back into blocked.
    const sweep = await kbJson("/admin.stall_sweep", { now: t0 + 11 * 60_000 });
    expect(sweep.status, `stall sweep failed: ${JSON.stringify(sweep.body)}`).toBeLessThan(500);
    expect(sweep.body.error).toBeUndefined();
    const after = await taskById(id);
    expect(after.status, "the stalled awaiting re-entry demotes to claimable todo (BR#4494/BR#5750), not blocked").toBe("todo");
    expect(after.meta?.blocked).toBeUndefined();
    expect(after.meta?.merge_train?.state).toBe("bounced");
    expect(after.meta?.attempt).toBeUndefined(); // a phantom claim is not a failed agent run
  });

  it("a watchdog hold-park of a queued car keeps its queue slot: the blocked reason carries the merge-train prefix, so mergeTrainQueue still sees the car (the BR#4995 drop)", async () => {
    const q = await kbJson("/create", { type: "task", title: "IMPL: br5750 queued hold-park prefix drill", qualified: true, session: "drill-exec-br5750q" });
    expect(q.status).toBe(200);
    const qid = String(q.body.id);
    const claim = await kbJson("/transition", { id: qid, to: "in_progress", actor: "drill-exec-br5750q", session: "drill-exec-br5750q" });
    expect(claim.status, `claim failed: ${JSON.stringify(claim.body)}`).toBe(200);
    await kbJson("/update", { id: qid, actor: "drill-exec-br5750q", meta: { merge_train: { state: "queued", pr: 2405, repo: "state-vector/superpositional" } } });
    const sweep = await kbJson("/admin.stall_sweep", { now: t0 + 12 * 60_000 });
    expect(sweep.body.error).toBeUndefined();
    const qAfter = await taskById(qid);
    expect(qAfter.status, "queued keeps parks-not-releases (BR#4067 — live queue slot)").toBe("blocked");
    const reason = String(qAfter.meta?.blocked?.reason ?? "");
    expect(reason.startsWith("merge-train: queued — "), `the hold-park must keep the queue prefix, got: ${reason}`).toBe(true);
    expect(reason).toContain("silence-release held (watchdog)");
  });
});
// ---------- BR#3620: the stale-ledger flips ----------
// The BR#3423/BR#3415 class: cards sat blocked for days with legs holding —
// (a) "BR#N answered" had NO atom kind (whole condition stamped unparseable),
// (b) GitHub-state atoms never consulted the ledger's own provenance table
// (stamped by train events, zero hub GitHub calls). Both flip now; everything
// else stays conservative (unparseable/unresolvable still never lie).

describe("unblockProxySweep — BR#3620 flips (real DO)", () => {
  it("br_answered: a card parked on a human ruling flips when the ruling lands (board-state, no creds)", async () => {
    const q = await kbJson("/create", { type: "task", title: "Ruling drill: fix direction GO?", qualified: true, session: "drill-ruling-q" });
    expect(q.status).toBe(200);
    const qid = String(q.body.id);
    const a = await kbJson("/create", { type: "task", title: "IMPL: parked on the ruling (BR#3620)", qualified: true, session: "drill-exec-a3620" });
    const aid = String(a.body.id);
    const park = await block(aid, "drill-exec-a3620",
      `Both legs, machine atoms: (1) BR#${qid.slice(3)} answered (status ≠ todo) with GO — any of Option A / Option B / gate waiver; (2) proceed.`,
      "parked on the ruling");
    expect(park.status, `park failed: ${JSON.stringify(park.body)}`).toBe(200);
    // the park-time round spawned (parseable condition) — close it so the
    // flip can spawn a FRESH duty (≤1 open unblock child per parent)
    const parkRound = (await unblockDuties()).find((x: any) =>
      x.title.startsWith("Unblock: IMPL: parked on the ruling (BR#3620)") && ["todo", "in_progress", "blocked"].includes(x.status));
    expect(parkRound, "the park-time round must exist").toBeTruthy();
    const c1 = await kbJson("/transition", { id: parkRound.id, to: "in_progress", actor: "drill-u1", session: "drill-u1" });
    expect(c1.status, `park-round claim failed: ${JSON.stringify(c1.body)}`).toBe(200);
    const c2 = await kbJson("/transition", { id: parkRound.id, to: "done", actor: "drill-u1", execution_result: { outcome: "Ruling remains open", receipts: [qid] }, note: "checked first-hand: the ruling is still open at check time — condition still blocked (findings)" });
    expect(c2.status, `park-round close failed: ${JSON.stringify(c2.body)}`).toBe(200);

    // sweep 1: the ruling card is still todo → verdict false, nothing spawns
    // (times sit AFTER the BR#4062 drills' sweeps below — one shared DO, the
    // sweep's last-tick pacing means later-running drills need later clocks)
    const sweep1 = await kbJson("/admin.unblock_proxy_sweep", { now: t0 + 501 * 60_000 });
    expect(sweep1.status, JSON.stringify(sweep1.body)).toBeLessThan(500);
    expect(sweep1.body.error).toBeUndefined();
    expect((await taskById(aid)).meta?.proxy_check?.verdict).toBe("false");

    // the ruling lands: the ask/question card resolves (board-state event)
    await kbJson("/transition", { id: qid, to: "in_progress", actor: "web:rayh", session: "web" });
    await kbJson("/transition", { id: qid, to: "done", actor: "web:rayh", session: "web", note: "GO — Option A" });

    // The original round is complete: continue with the verified receipt.
    const sweep2 = await kbJson("/admin.unblock_proxy_sweep", { now: t0 + 517 * 60_000 });
    expect(sweep2.body.error).toBeUndefined();
    const aNow = await taskById(aid);
    expect(aNow.meta?.proxy_check?.verdict).toBe("true");
    expect(aNow.status).toBe("todo");
    const flip = (await unblockDuties()).find((x: any) =>
      x.title.startsWith("Unblock: IMPL: parked on the ruling (BR#3620)") && ["todo", "in_progress", "blocked"].includes(x.status));
    expect(flip, "the consumed prerequisite must not spawn another round").toBeUndefined();
    expect(aNow.meta.proxy_check.receipts.join(" ")).toContain(`${qid} status=done (answered)`);
  });

  it("pr_merged + bare br_pr_merged flip from the train-stamped provenance ledger (no creds)", async () => {
    const p1 = await kbJson("/create", { type: "task", title: "IMPL: parked on the train (BR#3620 url form)", qualified: true, session: "drill-exec-p3620a" });
    const p1id = String(p1.body.id);
    const p2 = await kbJson("/create", { type: "task", title: "IMPL: parked on the train (BR#3620 bare form)", qualified: true, session: "drill-exec-p3620b" });
    const p2id = String(p2.body.id);
    // the train stamps the ledger (BR#3287): lease → merged event — zero
    // GitHub calls; the hub owns this fact
    const lease = await kbJson("/train.lease", { repo: "state-vector/superpositional", base: "main", action: "acquire" });
    expect(lease.status, JSON.stringify(lease.body)).toBe(200);
    const ev = await kbJson("/train.event", {
      repo: "state-vector/superpositional", base: "main", kind: "merged",
      pr: 2440, merge_sha: "8adf1e85cfb0ee853682ff0e5b9e361c0ce7edd5", head_sha: "f180fc0f7aa8",
      task_id: p2id, signer: "drill-signer",
    });
    expect(ev.status, `train.event failed: ${JSON.stringify(ev.body)}`).toBe(200);
    await kbJson("/train.lease", { repo: "state-vector/superpositional", base: "main", action: "release" });

    const park1 = await block(p1id, "drill-exec-p3620a",
      "Machine proxy: PR https://github.com/state-vector/superpositional/pull/2440 mergeCommit non-null (state=MERGED). Then a fresh session closes it done.", "parked");
    const park2 = await block(p2id, "drill-exec-p3620b",
      `Machine proxy: BR#${p2id.slice(3)}'s fix PR merges past the red stop-the-line gate. Then a fresh session closes it done.`, "parked");
    expect(park1.status, JSON.stringify(park1.body)).toBe(200);
    expect(park2.status, JSON.stringify(park2.body)).toBe(200);
    // close the park-time rounds so the flips spawn fresh duties
    for (const prefix of ["Unblock: IMPL: parked on the train (BR#3620 url form)", "Unblock: IMPL: parked on the train (BR#3620 bare form)"]) {
      const round = (await unblockDuties()).find((x: any) =>
        x.title.startsWith(prefix) && ["todo", "in_progress", "blocked"].includes(x.status));
      expect(round, prefix).toBeTruthy();
      const c3 = await kbJson("/transition", { id: round.id, to: "in_progress", actor: "drill-u2", session: "drill-u2" });
      expect(c3.status, `park-round claim failed (${prefix}): ${JSON.stringify(c3.body)}`).toBe(200);
      const c4 = await kbJson("/transition", { id: round.id, to: "done", actor: "drill-u2", execution_result: { outcome: "No qualifying provenance row at check time", receipts: [round.id] }, note: "checked first-hand: no provenance row at check time — condition still blocked (findings)" });
      expect(c4.status, `park-round close failed (${prefix}): ${JSON.stringify(c4.body)}`).toBe(200);
    }

    const sweep = await kbJson("/admin.unblock_proxy_sweep", { now: t0 + 533 * 60_000 });
    expect(sweep.body.error).toBeUndefined();
    for (const id of [p1id, p2id]) {
      const now = await taskById(id);
      expect(now.meta?.proxy_check?.verdict, id).toBe("true");
      if (id === p1id) expect(now.status).toBe("todo");
      else expect(now.meta?.proxy_check?.spawned, id).toBeTruthy();
    }
    // the spawn receipts cite the LEDGER (sha + signer), never a GitHub read
    const duties = (await unblockDuties()).filter((d: any) =>
      d.title.startsWith("Unblock: IMPL: parked on the train (BR#3620") && ["todo", "in_progress", "blocked"].includes(d.status));
    const bodies = [...duties.map((d: any) => String(d.body_md)), ...((await taskById(p1id)).meta.proxy_check.receipts ?? [])].join("\n");
    expect(bodies).toContain("provenance: state-vector/superpositional#2440 merged (sha 8adf1e85c, signer drill-signer)");
    expect(bodies).toContain("provenance: BR#");
  });
});
// ---------- (h) BR#4562 — the park drain must not attempt a held release ----------

describe("BR#4562 — the blocked-park drain checks the release-hold before attempting (real DO)", () => {
  it("a dead-ask park on a typed await_event is NEVER drained: no attempt, no blocked_drained stamp, no refusal storm", async () => {
    // TASK-001's exact shape: parked blocked on a typed pr_merged proxy whose
    // park prose references a long-gone ask (dead-ask verdict at any age).
    // The drain used to stamp blocked_drained + attempt the todo release EVERY
    // tick; the BR#4067 guard refused every attempt, and the refusals folded
    // into the 2026-10-29 "unclassified" breach pile (16 cards in one sweep
    // window). The hold is now checked BEFORE the annotation: the sweep waits
    // it out — the proxy watch / the answer owns the exit.
    const c = await kbJson("/create", { type: "task", title: "IMPL: br4562 held-park drill", qualified: true, session: "drill-exec-br4562" });
    expect(c.status).toBe(200);
    const id = String(c.body.id);
    const claim = await kbJson("/transition", { id, to: "in_progress", actor: "drill-exec-br4562", session: "drill-exec-br4562" });
    expect(claim.status, `claim failed: ${JSON.stringify(claim.body)}`).toBe(200);
    const blk = await kbJson("/transition", {
      id, to: "blocked", actor: "drill-exec-br4562", session: "drill-exec-br4562",
      note: "parked on the merge gate",
      unblock_condition: "owner GO recorded on ask ASK-lapsed-4562 (historical ref) — the typed proxy owns the exit",
      await_event: { event: "pr_merged", repo: "state-vector/superpositional", n: 2404 },
    });
    expect(blk.status, `park failed: ${JSON.stringify(blk.body)}`).toBe(200);

    const before = ((await kbJson("/events", { since: 0, limit: 1 })).body ?? {}) as any;
    const cursor = Number(before[0]?.seq ?? 0);
    // the park drain lives in the FULL alarm sweep (admin.stall_sweep runs
    // only the stall/hold/route phase and never reaches it)
    const sweep = await kbJson("/admin.alarm_sweep");
    expect(sweep.status, `alarm sweep failed: ${JSON.stringify(sweep.body)}`).toBeLessThan(500);
    expect(sweep.body.error).toBeUndefined();

    const after = await taskById(id);
    expect(after.status, "a held park stays parked — the proxy watch owns the exit (BR#4067)").toBe("blocked");
    expect(after.meta?.blocked_drained, "the drain annotation must not fire for a held park (it only survives on a REAL drain)").toBeUndefined();
    expect(after.meta?.blocked?.await_event).toEqual({ event: "pr_merged", repo: "state-vector/superpositional", n: 2404 });

    // zero refusal events: the drain never attempts the release the guard
    // would refuse — that is the loop fix, not just the label fix.
    const evs = (((await kbJson("/events", { since: cursor, limit: 500 })).body ?? {}) as any).events ?? [];
    const refusals = evs.filter((e: any) => e.op === "transition_rejected" && e.artefact_id === id);
    expect(refusals, `expected no transition_rejected for the held park, got ${JSON.stringify(refusals.map((e: any) => String(e.detail?.reason ?? "").slice(0, 90)))}`).toEqual([]);
  });

  it("the drain still drains what it should: a dead park with NO typed wait releases to todo with the stamp", async () => {
    // The churn-stamp population: a blocked park carrying guard boilerplate
    // and NO typed event (the shape blockedParkVerdict was written for). The
    // hold check must gate ONLY the held shape — everything else drains.
    const c = await kbJson("/create", { type: "task", title: "IMPL: br4562 drainable-park drill", qualified: true, session: "drill-exec-br4562d" });
    expect(c.status).toBe(200);
    const id = String(c.body.id);
    await kbJson("/transition", { id, to: "in_progress", actor: "drill-exec-br4562d", session: "drill-exec-br4562d" });
    const blk = await kbJson("/transition", {
      id, to: "blocked", actor: "drill-exec-br4562d", session: "drill-exec-br4562d",
      note: "parked on the merge gate",
      unblock_condition: "PR https://github.com/state-vector/superpositional/pull/2405 merged",
      await_event: { event: "pr_merged", repo: "state-vector/superpositional", n: 2405 },
    });
    expect(blk.status, `park failed: ${JSON.stringify(blk.body)}`).toBe(200);
    // strip the typed wait: the churn-stamp shape (guard boilerplate, no
    // machine leg) + a dead-park reason the drain exists for
    const parkedMeta = (await taskById(id)).meta ?? {};
    const stripped = await kbJson("/update", {
      id, actor: "drill-exec-br4562d",
      meta: {
        ...parkedMeta,
        blocked: { ...parkedMeta.blocked, await_event: undefined, reason: "churn guard: released to the pool 3 times without completing — retry" },
      },
    });
    expect(stripped.status, `strip failed: ${JSON.stringify(stripped.body)}`).toBe(200);

    const sweep = await kbJson("/admin.alarm_sweep");
    expect(sweep.body.error).toBeUndefined();
    const after = await taskById(id);
    expect(after.status, "a dead park with no machine wait is the drain's legitimate work").toBe("todo");
    expect(after.meta?.blocked_drained?.klass).toBe("churn-park");
  });
});

// ---------- (g) BR#4702 — the spawner-cap re-suppression never folds a breach card ----------

describe("BR#4702 — capped re-attempts under a standing escalation are observable-only", () => {
  it("the 4th park escalates ONCE and spawns nothing; a 5th capped park audits spawn_cap_skipped and raises NO spawn-while-open card (specimen BR#3633)", async () => {
    // 1. the parent: a qualified impl card that will cycle parks (each park
    // spawns a real round via the park-time machine law).
    const c = await kbJson("/create", { type: "task", title: "IMPL: br4702 drill", qualified: true, session: "drill-exec-br4702" });
    expect(c.status).toBe(200);
    const id = String(c.body.id);
    await kbJson("/transition", { id, to: "in_progress", actor: "drill-exec-br4702", session: "drill-exec-br4702" });

    // 2. three rounds EVER (the BR#2893 cap): park on a distinct exit, the
    // duty runs and closes with its findings, the resume consumes the stamp.
    for (let n = 1; n <= 3; n++) {
      const parked = await block(id, "drill-exec-br4702", `Exit ${n}: PR https://github.com/a/b/pull/${n} merged`, `parked on exit ${n}`);
      expect(parked.status, `park ${n} failed: ${JSON.stringify(parked.body)}`).toBe(200);
      const round = (await unblockDuties()).find((x: any) =>
        x.title.startsWith("Unblock: IMPL: br4702 drill") && ["todo", "in_progress", "blocked"].includes(x.status));
      expect(round, `round ${n} must exist`).toBeTruthy();
      await kbJson("/transition", { id: round.id, to: "in_progress", actor: `duty-br4702-${n}`, session: `duty-br4702-${n}` });
      const done = await kbJson("/transition", {
        id: round.id, to: "done", actor: `duty-br4702-${n}`,
        execution_result: { outcome: "PR remains open; exit not satisfied", receipts: [`https://github.com/a/b/pull/${n}`] },
        note: `receipts: exit ${n} re-verified on the board — PR https://github.com/a/b/pull/${n} still OPEN, exit not held; findings recorded per the unblock contract`,
      });
      expect(done.status, `round ${n} done failed: ${JSON.stringify(done.body)}`).toBe(200);
      const resumed = await kbJson("/transition", { id, to: "in_progress", actor: "drill-exec-br4702", session: "drill-exec-br4702", note: `exit ${n} not held — re-scoping` });
      expect(resumed.status, `resume ${n} failed: ${JSON.stringify(resumed.body)}`).toBe(200);
    }
    expect((await unblockDuties()).filter((x: any) => x.title.startsWith("Unblock: IMPL: br4702 drill")).length).toBe(3);

    // 3. the 4th park hits the cap: the spawner escalates ONCE, spawns nothing.
    const park4 = await block(id, "drill-exec-br4702", "Exit 4: PR https://github.com/a/b/pull/4 merged", "parked on exit 4");
    expect(park4.status, `park 4 failed: ${JSON.stringify(park4.body)}`).toBe(200);
    const escalated = await taskById(id);
    expect(escalated.meta?.unblock_escalated?.rounds).toBe(3);
    expect(String(escalated.meta?.escalate?.reason)).toContain("spawner stopped");
    expect((await unblockDuties()).filter((x: any) => x.title.startsWith("Unblock: IMPL: br4702 drill")).length).toBe(3);

    // 4. the 5th park re-hits the cap with the escalation standing — the
    // guard re-suppresses. This is the tick class that folded the breach card
    // on BR#3633: the parent re-evaluates every park/sweep tick while the
    // block stays un-cleared, and pre-BR#4702 each tick audited foldable
    // spawn_skipped ("unblock spawner cap (N rounds, cap 3) — escalation
    // already filed").
    const resume4 = await kbJson("/transition", { id, to: "in_progress", actor: "drill-exec-br4702", session: "drill-exec-br4702", note: "re-scoping under the standing escalation" });
    expect(resume4.status, `resume 4 failed: ${JSON.stringify(resume4.body)}`).toBe(200);
    const park5 = await block(id, "drill-exec-br4702", "Exit 5: PR https://github.com/a/b/pull/5 merged", "parked on exit 5");
    expect(park5.status, `park 5 failed: ${JSON.stringify(park5.body)}`).toBe(200);
    expect((await taskById(id)).status).toBe("blocked");
    expect((await unblockDuties()).filter((x: any) => x.title.startsWith("Unblock: IMPL: br4702 drill")).length).toBe(3);

    // 5. run the fold over the audit stream (a rejected transition folds its
    // subject; blocked → done is an illegal edge, so this rejection is safe):
    // NO spawn-while-open card may rise — the guard's own suppression is the
    // system working, never a breach (the BR#4282 law, cap half).
    const rejected = await kbJson("/transition", { id, to: "done", actor: "drill-exec-br4702", note: "no receipts — must be rejected to trigger the fold" });
    expect(rejected.status, "blocked → done must be rejected").toBeGreaterThanOrEqual(400);
    const breaches = ((await kbJson("/list", { type: "task", tag: "breach", limit: 200 })).body?.artefacts ?? [])
      .filter((a: any) => String(a.meta?.breach_task ?? "") === id);
    expect(breaches, `breach cards leaked: ${JSON.stringify(breaches.map((b: any) => [b.id, b.meta?.breach_key]))}`).toHaveLength(0);
  });
});

// ---------- (h) BR#6518 — a depth-capped card entering in_review gets a DETACHED verify duty, not a stranded review leg ----------

describe("BR#6518 — the depth guard reroutes the verify round instead of dropping it", () => {
  it("a 3-deep card entering in_review spawns a DETACHED verify duty (no depth-4 child_of edge), stamps the round, folds NO breach card, and a bounce re-entry REUSES the same round", async () => {
    // 1. build a depth-3 chain: A → B → C → D (D carries 3 child_of ancestors,
    //    the exact BR#6500 shape: recovery card under a fix under an umbrella)
    const a = await kbJson("/create", { type: "task", title: "ROOT: br6518 chain A", qualified: true, session: "drill-a" });
    expect(a.status).toBe(200);
    const b = await kbJson("/create", { type: "task", title: "IMPL: br6518 chain B", qualified: true, session: "drill-b" });
    const c3 = await kbJson("/create", { type: "task", title: "IMPL: br6518 chain C", qualified: true, session: "drill-c" });
    const d = await kbJson("/create", { type: "task", title: "IMPL: br6518 depth-capped D", qualified: true, session: "drill-d" });
    for (const [src, dst] of [[b.body.id, a.body.id], [c3.body.id, b.body.id], [d.body.id, c3.body.id]]) {
      const l = await kbJson("/link", { src, relation: "child_of", dst });
      expect(l.status, `link ${src} → ${dst} failed: ${JSON.stringify(l.body)}`).toBe(200);
    }
    // the BR#532 cap holds at the relation layer: a 5th node under D is refused
    const e = await kbJson("/create", { type: "task", title: "IMPL: br6518 would-be depth-4", qualified: true, session: "drill-e" });
    expect((await kbJson("/link", { src: e.body.id, relation: "child_of", dst: d.body.id })).status).toBeGreaterThanOrEqual(400);

    // 2. D enters review — pre-BR#6518 this spawned NOTHING (no review leg,
    //    card stranded believing a verifier existed) and folded a
    //    spawn-while-open breach card on the guard's own suppression
    expect((await kbJson("/transition", { id: d.body.id, to: "in_progress", actor: "drill-d", session: "drill-d" })).status).toBe(200);
    const rv = await kbJson("/transition", { id: d.body.id, to: "in_review", actor: "drill-d", session: "drill-d", note: "execution receipts: https://example.com/br6518-run" });
    expect(rv.status, `in_review failed: ${JSON.stringify(rv.body)}`).toBe(200);

    // 3. the duty exists, DETACHED: no child_of edge anywhere, the SUBJECT
    //    binding rides the duty body, the round is stamped on D
    const verifyDuties = async () => ((await kbJson("/list", { type: "task", limit: 500 })).body?.artefacts ?? [])
      .filter((x: any) => x.title.startsWith("Verify: IMPL: br6518 depth-capped D"));
    const duties = await verifyDuties();
    expect(duties.length, `expected 1 detached duty, got ${JSON.stringify(duties.map((x: any) => x.id))}`).toBe(1);
    expect(duties[0].roles).toContain("review");
    expect(String(duties[0].body_md)).toContain(String(d.body.id));
    const rels = (await kbJson("/relations", { id: duties[0].id })).body?.relations ?? [];
    expect(rels.filter((r: any) => r.relation === "child_of")).toHaveLength(0);
    expect((await taskById(d.body.id)).meta?.verify_round?.duty).toBe(duties[0].id);

    // 4. the fold over the audit stream raises NO spawn-while-open card for D
    const breaches = ((await kbJson("/list", { type: "task", tag: "breach", limit: 200 })).body?.artefacts ?? [])
      .filter((x: any) => String(x.meta?.breach_task ?? "") === String(d.body.id));
    expect(breaches, `breach cards leaked: ${JSON.stringify(breaches.map((x: any) => [x.id, x.meta?.breach_key]))}`).toHaveLength(0);

    // 5. bounce → re-enter review: the SAME round is reused, no duplicate duty
    expect((await kbJson("/transition", { id: d.body.id, to: "in_progress", actor: "verifier-6518", session: "verifier-6518", note: "bounced — findings: receipt chain incomplete" })).status).toBe(200);
    const rv2 = await kbJson("/transition", { id: d.body.id, to: "in_review", actor: "drill-d", session: "drill-d", note: "execution receipts re-recorded: https://example.com/br6518-run-2" });
    expect(rv2.status, `re-entry failed: ${JSON.stringify(rv2.body)}`).toBe(200);
    expect((await verifyDuties()).length, "bounce re-entry must reuse the stamped round, never stack a second duty").toBe(1);  });
});

// ---------- (i) BR#5916 — the zombie-park re-arm: unclaimable infra anchors ----------

describe("BR#5916 — expired time awaits on unclaimable infra anchors re-arm (machine, no breach)", () => {
  // 24h — mirrors the churn-guard cooldown (BR#5842) that parked the real
  // BR#3124 sink on a timer in the first place.
  const REARM_MS = 24 * 60 * 60_000;
  // the sweep clocks ride past the file's largest existing sweep (t0+533m)
  const anchorSweepNow = t0 + 560 * 60_000;

  it("an anchor's expired timer re-parks on a fresh typed wait — no flip, no spawn, no escalation, no drift", async () => {
    // 1. the anchor: meta.infra_anchor = true (do-not-claim/do-not-close),
    //    parked on a typed time await that has ALREADY expired relative to
    //    the sweep clock — the BR#3124 zombie shape (expired wait + capped
    //    spawner + do-not-touch guards = no legal leg left).
    const c = await kbJson("/create", {
      type: "task", title: "IMPL: br5916 anchor drill", qualified: true, session: "drill-exec-br5916",
      meta: { infra_anchor: true },
    });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const id = String(c.body.id);
    await kbJson("/transition", { id, to: "in_progress", actor: "drill-exec-br5916", session: "drill-exec-br5916" });
    const expiredUntil = t0 - 5 * 60_000; // already expired (derived from t0, BR#5623 law)
    const park = await kbJson("/transition", {
      id, to: "blocked", actor: "drill-exec-br5916", session: "drill-exec-br5916",
      note: "cooldown park (BR#5842 mechanism)",
      await_event: { event: "time", until_ts: expiredUntil },
    });
    expect(park.status, `park failed: ${JSON.stringify(park.body)}`).toBe(200);
    expect((await taskById(id)).status).toBe("blocked");
    // the carve-out suppresses even the PARK-TIME machine round for the anchor
    expect((await unblockDuties()).filter((x: any) => String(x.title).startsWith("Unblock: IMPL: br5916 anchor drill"))).toHaveLength(0);

    // 2. sweep past the flood window: the expired timer fires — the machine
    //    re-arms the park itself (no agent action, no breach event).
    const sweep = await kbJson("/admin.unblock_proxy_sweep", { now: anchorSweepNow });
    expect(sweep.body.error).toBeUndefined();
    const after = await taskById(id);
    expect(after.status, "the anchor stays parked — the timer owns the exit; the sweep re-arms it").toBe("blocked");
    const rearm = after.meta?.blocked?.await_event;
    expect(rearm?.event).toBe("time");
    expect(rearm?.until_ts, "the expired atom is replaced by a fresh wait stamped from the sweep clock").toBe(anchorSweepNow + REARM_MS);
    expect(after.meta?.proxy_check?.verdict).toBe("waiting");
    expect(String(after.meta?.proxy_check?.detail)).toContain("BR#5916");
    // NO unblock duty, NO escalation stamp — the do-not-claim anchor never
    // burns the shared spawner budget (BR#5916 scope 2)
    expect((await unblockDuties()).filter((x: any) => String(x.title).startsWith("Unblock: IMPL: br5916 anchor drill"))).toHaveLength(0);
    expect(after.meta?.unblock_escalated).toBeUndefined();
    expect(after.meta?.escalate).toBeUndefined();

    // 3. idempotent: a second sweep inside the fresh window re-stamps
    //    waiting and does NOT drift the timer.
    const sweep2 = await kbJson("/admin.unblock_proxy_sweep", { now: anchorSweepNow + 30 * 60_000 });
    expect(sweep2.body.error).toBeUndefined();
    const after2 = await taskById(id);
    expect(after2.status).toBe("blocked");
    expect(after2.meta?.blocked?.await_event?.until_ts).toBe(rearm.until_ts);
    expect(after2.meta?.proxy_check?.verdict).toBe("waiting");
  });

  it("the sink route: the configured alarm sink (train_alarm_sink_id) re-arms without any meta flag", async () => {
    const c = await kbJson("/create", { type: "task", title: "IMPL: br5916 sink-route drill", qualified: true, session: "drill-exec-br5916s" });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const id = String(c.body.id);
    await kbJson("/transition", { id, to: "in_progress", actor: "drill-exec-br5916s", session: "drill-exec-br5916s" });
    // point the sink setting at the drill card, park it expired, sweep
    const set = await kbJson("/admin.settings_set", { settings: { train_alarm_sink_id: id } });
    expect(set.status, `settings_set failed: ${JSON.stringify(set.body)}`).toBeLessThan(500);
    const expiredUntil = t0 - 3 * 60_000;
    const park = await kbJson("/transition", {
      id, to: "blocked", actor: "drill-exec-br5916s", session: "drill-exec-br5916s",
      note: "sink cooldown park", await_event: { event: "time", until_ts: expiredUntil },
    });
    expect(park.status, `park failed: ${JSON.stringify(park.body)}`).toBe(200);
    const sweep = await kbJson("/admin.unblock_proxy_sweep", { now: t0 + 610 * 60_000 });
    expect(sweep.body.error).toBeUndefined();
    const after = await taskById(id);
    expect(after.status).toBe("blocked");
    expect(after.meta?.blocked?.await_event).toEqual({ event: "time", until_ts: (t0 + 610 * 60_000) + REARM_MS });
    expect(String(after.meta?.proxy_check?.detail)).toContain("BR#5916");
    // restore the setting so later tests see the default sink
    await kbJson("/admin.settings_set", { settings: { train_alarm_sink_id: "BR#3124" } });
  });

  it("the cap carve-out: a capped ANCHOR stamps no escalation and burns no budget; a capped non-anchor still escalates (behavior preserved)", async () => {
    // a closed unblock child linked to the parent — the cap counts rounds
    // EVER regardless of status, and closing keeps openChild null so the
    // sweep actually reaches the cap branch
    const mkChild = async (parent: string, tag: string) => {
      const cc = await kbJson("/create", { type: "task", title: `Unblock: br5916-cap ${tag}`, qualified: true, session: `duty-${tag}`, roles: ["unblock"] });
      expect(cc.status, `child create failed: ${JSON.stringify(cc.body)}`).toBe(200);
      const cid = String(cc.body.id);
      const lnk = await kbJson("/link", { src: cid, relation: "child_of", dst: parent });
      expect(lnk.status, `link failed: ${JSON.stringify(lnk.body)}`).toBe(200);
      await kbJson("/transition", { id: cid, to: "in_progress", actor: `duty-${tag}`, session: `duty-${tag}` });
      const done = await kbJson("/transition", { id: cid, to: "done", actor: `duty-${tag}`, session: `duty-${tag}`, execution_result: { outcome: "Exit not satisfied; findings recorded", receipts: ["https://github.com/a/b/pull/1"] }, note: "receipts: https://github.com/a/b/pull/1 re-verified — exit not held; findings recorded" });
      expect(done.status, `child done failed: ${JSON.stringify(done.body)}`).toBe(200);
    };

    // --- the non-anchor CONTROL: existing BR#2893 cap behavior intact ---
    const nc = await kbJson("/create", { type: "task", title: "IMPL: br5916 cap control", qualified: true, session: "drill-exec-br5916c" });
    expect(nc.status).toBe(200);
    const nid = String(nc.body.id);
    await kbJson("/transition", { id: nid, to: "in_progress", actor: "drill-exec-br5916c", session: "drill-exec-br5916c" });
    for (const tag of ["c1", "c2", "c3"]) await mkChild(nid, tag);
    const npark = await kbJson("/transition", {
      id: nid, to: "blocked", actor: "drill-exec-br5916c", session: "drill-exec-br5916c",
      note: "capped park", await_event: { event: "time", until_ts: t0 - 2 * 60_000 },
    });
    expect(npark.status, `control park failed: ${JSON.stringify(npark.body)}`).toBe(200);
    // the cap fires at PARK time on the normal path: escalation stamped once
    const nNow = await taskById(nid);
    expect(nNow.meta?.unblock_escalated?.rounds).toBe(3);
    expect(String(nNow.meta?.escalate?.reason)).toContain("spawner stopped");

    // --- the ANCHOR: same 3 done children, same expired timer — carve-out ---
    const ac = await kbJson("/create", {
      type: "task", title: "IMPL: br5916 cap anchor", qualified: true, session: "drill-exec-br5916a",
      meta: { infra_anchor: true },
    });
    expect(ac.status).toBe(200);
    const aid = String(ac.body.id);
    await kbJson("/transition", { id: aid, to: "in_progress", actor: "drill-exec-br5916a", session: "drill-exec-br5916a" });
    for (const tag of ["a1", "a2", "a3"]) await mkChild(aid, tag);
    const apark = await kbJson("/transition", {
      id: aid, to: "blocked", actor: "drill-exec-br5916a", session: "drill-exec-br5916a",
      note: "capped anchor park", await_event: { event: "time", until_ts: t0 - 2 * 60_000 },
    });
    expect(apark.status, `anchor park failed: ${JSON.stringify(apark.body)}`).toBe(200);
    const aNow = await taskById(aid);
    // the carve-out: 3 children ever and STILL no escalation stamp, no budget burn
    expect(aNow.meta?.unblock_escalated).toBeUndefined();
    expect(aNow.meta?.escalate).toBeUndefined();

    // the sweep: the anchor's expired timer RE-ARMS (never escalates), and
    // the control's capped park stays honestly suppressed (spawn_skipped)
    const sweep = await kbJson("/admin.unblock_proxy_sweep", { now: t0 + 640 * 60_000 });
    expect(sweep.body.error).toBeUndefined();
    const aAfter = await taskById(aid);
    expect(aAfter.status).toBe("blocked");
    expect(aAfter.meta?.blocked?.await_event).toEqual({ event: "time", until_ts: (t0 + 640 * 60_000) + REARM_MS });
    expect(aAfter.meta?.unblock_escalated).toBeUndefined();
    const nAfter = await taskById(nid);
    expect(nAfter.status).toBe("todo");
    expect(nAfter.meta?.unblock_escalated?.rounds).toBe(3);
    expect(nAfter.meta?.blocked).toBeUndefined();
    expect(nAfter.meta?.proxy_check?.receipts.join(" ")).toContain("timer elapsed");
  });
});
import { completeExecutionReview } from "./completion-fixture";
