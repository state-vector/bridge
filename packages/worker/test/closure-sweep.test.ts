import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Closure-tier duty scheduling (BR#3361) — real DO drill against the bundled
 * worker. DEGRADED under BR#3516: the hub holds no VCS credentials, ever, so
 * the machine-proxy watch can no longer read GitHub — GitHub-state atoms stamp
 * UNRESOLVABLE (never auto-flip; conservatism law) and only board-state atoms
 * (br_done) still evaluate. The closure-RECEIPT audit sweep is gone with it:
 * receipts' truth is owned by the verify session that cites them and by the
 * train's machine-proxy close (train:landed — pinned in train-hub.test.ts).
 *
 * Three mechanisms, one real DO:
 *  (a) unblock-proxy watch (degraded): board-state atoms evaluate; GitHub
 *      atoms stamp unresolvable citing BR#3516 and spawn nothing; unparseable
 *      stays honest; the park-time machine round is unaffected.
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
  it("GitHub-state atoms stamp UNRESOLVABLE (BR#3516 — the hub holds no VCS creds) and spawn nothing; unparseable stays honest", async () => {
    // P1 parks on BR#3129's REAL condition ("PR #2327 mergeCommit non-null" —
    // a pr_merged atom with a repo). The park-time machine round spawns as
    // always (transition law, unchanged); the SWEEP, though, can no longer
    // read the PR — unresolvable, never a flip, never a duty.
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

    // P1/P3: unresolvable with the BR#3516 receipt — stamped, never flipped,
    // nothing spawned from the sweep
    for (const id of [p1id, p3id]) {
      const now = await taskById(id);
      expect(now.meta?.proxy_check?.verdict, `${id}`).toBe("unresolvable");
      expect(String(now.meta?.proxy_check?.atoms?.[0]?.receipt)).toContain("BR#3516");
      expect(now.meta?.proxy_check?.spawned).toBeUndefined();
    }

    // P2: the typed await is stored (annotation rides along); the sweep
    // stamps it unresolvable like every other GitHub-state atom
    const p2Now = await taskById(p2id);
    expect(p2Now.meta?.blocked?.await_event).toEqual({ event: "pr_merged", repo: "state-vector/superpositional", n: 2400 });
    expect(p2Now.meta?.proxy_check?.verdict).toBe("unresolvable");
    expect(p2Now.meta?.proxy_check?.spawned).toBeUndefined();

    // a second sweep re-stamps the same verdicts (per-card pacing, no churn
    // audits, no duties of any kind from the sweep)
    const sweep2 = await kbJson("/admin.unblock_proxy_sweep", { now: t0 + 61 * 60_000 + 17 * 60_000 });
    expect(sweep2.body.error).toBeUndefined();
    const p1After = await taskById(p1id);
    expect(p1After.meta?.proxy_check?.verdict).toBe("unresolvable");
    expect(p1After.meta?.proxy_check?.spawned).toBeUndefined();
    const openDuties = (await unblockDuties()).filter((d: any) =>
      d.title.startsWith("Unblock: IMPL: re-close GH #2274") && ["todo", "in_progress", "blocked"].includes(d.status));
    expect(openDuties.length).toBe(0);
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
      const d = await kbJson("/transition", { id, to: "done", actor: session, session, note: "done — drill leg verified first-hand" });
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
    const s1 = await kbJson("/admin.unblock_proxy_sweep", { now: t0 + 200 * 60_000 });
    expect(s1.body.error).toBeUndefined();
    let now = await taskById(pid);
    expect(now.meta?.blocked?.await_event).toBeUndefined(); // N atoms never self-migrate
    expect(now.meta?.proxy_check?.verdict).toBe("false");
    expect(now.meta?.proxy_check?.atoms).toHaveLength(2);
    expect(now.meta?.proxy_check?.spawned).toBeUndefined();

    // leg B completes → the conjunction flips → the duty spawns
    await kbJson("/transition", { id: legB, to: "in_progress", actor: "drill-3986-b", session: "drill-3986-b" });
    const d = await kbJson("/transition", { id: legB, to: "done", actor: "drill-3986-b", session: "drill-3986-b", note: "done — drill leg verified first-hand" });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const s2 = await kbJson("/admin.unblock_proxy_sweep", { now: t0 + 260 * 60_000 });
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
    // three asks: one to the human, one to any agent, one to a capability tag
    const toHuman = await kbJson("/ask.create", {
      to: "ray", question: "Human ruling drill?",
      reason: "drill — human-directed ask must never land in an agent inbox",
      options: ["GO", "NO-GO"], artefact_id: null,
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
    const r = await kbJson("/create", { type: "task", title: "IMPL: 4062 time-prose drill", qualified: true, session: "drill-4062-time" });
    const pid = String(r.body.id);
    await kbJson("/transition", { id: pid, to: "in_progress", actor: "drill-4062-time", session: "drill-4062-time" });
    // THE regression: this exact park shape REJECTED from MCP on 2026-10-28
    const blk = await block(pid, "drill-4062-time",
      "Machine proxy (typed await_event time until_ts=1793673600000): the card re-enters at the timer → then a FRESH session closes it done.",
      "parked on a typed timer (BR#4062 repro)");
    expect(blk.status, JSON.stringify(blk.body)).toBe(200);
    const parked = await taskById(pid);
    expect(parked.status).toBe("blocked");
    // the typed event self-stamped at the door (not just text)
    expect(parked.meta?.blocked?.await_event).toEqual({ event: "time", until_ts: 1793673600000 });

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
      to: "ray", question: "4062 drill ruling?", reason: "drill",
      options: ["GO", "NO-GO"], artefact_id: null,
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
    expect(String(round.body_md)).toContain("close YOURSELF done");

    // 5. the contract executes: the duty closes ITSELF done first (receipts
    // cited — the done-open-children gate needs the child closed), then the
    // parent's done lands with the same receipts. Owned, terminal, no breach.
    await kbJson("/transition", { id: round.id, to: "in_progress", actor: "drill-exec-closer4282", session: "drill-exec-closer4282" });
    const roundDone = await kbJson("/transition", {
      id: round.id, to: "done", actor: "drill-exec-closer4282",
      note: "verified on the board receipts: PR 2400 merged as 4282feedf (train awaiting-ci stamp, BR#4282) — closing the parent done",
    });
    expect(roundDone.status, `duty done failed: ${JSON.stringify(roundDone.body)}`).toBe(200);
    const parentDone = await kbJson("/transition", {
      id, to: "done", actor: "drill-exec-closer4282",
      note: "closed via the unblock duty: PR https://github.com/state-vector/superpositional/pull/2400 merged as 4282feedf (board merge receipt)",
    });
    expect(parentDone.status, `parent done failed: ${JSON.stringify(parentDone.body)}`).toBe(200);
    expect((await taskById(id)).status).toBe("done");
  });
});

describe("BR#4494 — bounce re-entry demote on the stall sweep (real DO)", () => {
  it("a bounce re-entry stranded in_progress (dead executor) is DEMOTED to a claimable todo by the sweep — never re-parked blocked; train meta + boost survive", async () => {
    // The specimen shape (BR#4198): a train bounce re-opened its card
    // in_progress with the PRIOR session as executor; the session is gone and
    // nothing pings. The self-heal normally lands coverage bounces in_review
    // (train-hub.test.ts pins that) — this drill pins the FALLBACK for every
    // path that still strands the unclaimable in_progress: the sweep must
    // release it claimable, never re-park it blocked (the 4×-bounce loop).
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
    // the release names the law (BR#4494) — auditable, and the churn stamp
    // carries the reason
    expect(String(after.meta?.attempt?.last_reason ?? "")).toContain("BR#4494");
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
