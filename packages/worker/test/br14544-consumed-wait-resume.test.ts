import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideConsumedWaitResume } from "../src/kb/core.ts";

/**
 * BR#14544 — consumed-wait auto-resume. When a blocked card's typed wait
 * fires machine-verified (the ask is answered, the timer elapsed, the atom
 * is TRUE), the hub itself applies the mechanical resume (consume the wait,
 * return the card to the dispatch pool todo, receipted note,
 * meta.provenance system_auto_resume) instead of spawning an unblock duty
 * whose dispatched credential is then gate-refused on the parent's resume —
 * the satisfied-park → pool-ask → gate-refused loop that accumulated
 * days-old satisfied parks. The resume target is todo: the
 * dispatchCandidates pool query only ever sees status='todo' AND owner='',
 * and in_progress has no self-edge — an ownerless in_progress card would be
 * unclaimable and invisible to the scheduler.
 *
 * Pinned here:
 *   A. decideConsumedWaitResume — the closed union (auto_resume |
 *      duty_fallback{live_executor|verdict_duty|human_bound|
 *      unverified_predicate}) and its guard precedence;
 *   B. the happy path — verified consumed ask + no live holder → hub
 *      consumes the wait to todo with provenance, NO duty child;
 *   C. duty_fallback for each guard: human-bound resolved ask, verdict-duty
 *      card, live holder session — each keeps today's duty path, with the
 *      fallback reason + loud-urgency instruction carried on the duty;
 *   D. the legacy completed-round invariant survives: a duty spawned under a
 *      live-holder fallback consumes the verified prerequisite via
 *      continueBlockedWork (blocked → todo) once the holder is stale.
 *
 * The credential gate itself is NOT touched: the hub acts as system actor
 * (no credential needed); the gate's law stays for sessions.
 */

// ---------- rig ----------

let mf: Miniflare;
let stub: any;
async function call(op: string, body: object = {}) {
  const response = await stub.fetch(`https://kb/${op}`, {
    method: "POST", headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}
const get = async (id: string) => (await call("get", { id })).body;
async function task(title: string, meta: object = {}, roles: string[] = []) {
  const result = await call("create", { type: "task", title, qualified: true, actor: "author", roles, meta });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return String(result.body.id);
}
async function children(id: string) {
  const relations = (await call("relations", { id })).body.relations;
  return Promise.all(relations.filter((r: any) => r.relation === "child_of" && r.dir === "in").map((r: any) => get(r.artefact_id)));
}
/** Park `id` blocked on a typed ask leg naming `askId` — the consumed-wait
 *  shape from the incident class (the ask itself is unbound to this card,
 *  like the pool asks expired duties leave behind). `patch` stamps extra
 *  holder meta (session/last_progress) AFTER the park, for live-holder
 *  fixtures. */
const parkOnAsk = async (id: string, askId: string, patch: Record<string, unknown> = {}) => {
  const p = await call("transition", {
    id, to: "blocked", actor: "author", session: "",
    note: `Waiting on ${askId}`,
    await_event: { event: "ask", ask_id: askId },
  });
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  if (Object.keys(patch).length) {
    const u = await call("update", { id, meta: patch, actor: "author" });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
  }
};
/** An unbound pool coordination ask (no artefact_id → no subject dispatch). */
/** The tests share ONE Durable Object; the proxy sweep paces itself on
 *  unblock_proxy_last_ts (15m default). Every sweep call advances the
 *  injected clock by a whole hour so later tests never fall inside an
 *  earlier test's pacing window. */
let sweepHour = 0;
const nextSweepTs = () => Date.now() + (++sweepHour) * 60 * 60_000;

const poolAsk = async (question: string) => {
  const r = await call("ask.create", {
    to: "any", route: { kind: "agent_coordination" }, question, options: ["Yes", "No"], actor: "peer",
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return String(r.body.id);
};

beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  if (!existsSync(bundle)) throw new Error("bundle missing — run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle (before vitest)");
  mf = new Miniflare({
    workers: [{
      name: "main",
      modules: true,
      compatibilityDate: "2025-09-25",
      scriptPath: bundle,
      modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")),
      durableObjects: { KB: { className: "KnowledgeHub", useSQLite: true } },
    }],
  });
  stub = (await mf.getDurableObjectNamespace("KB")).get((await mf.getDurableObjectNamespace("KB")).idFromName("global"));
  await call("orient", { actor: "test" });
});

afterAll(async () => {
  await mf?.dispose();
});

// ---------- A. the closed union ----------

describe("decideConsumedWaitResume (BR#14544 closed union)", () => {
  const base = { cardId: "BR#1", verificationReceipt: "ask BR#9 answered/closed" };

  it("auto-resumes when the fire is verified and every guard is clear", () => {
    expect(decideConsumedWaitResume({ ...base, verified: true, liveExecutor: false, verdictDuty: false, humanBound: false }))
      .toEqual({ kind: "auto_resume", receipt: base.verificationReceipt });
  });

  it("falls back per guard, in the card's precedence order", () => {
    expect(decideConsumedWaitResume({ ...base, verified: false, liveExecutor: true, verdictDuty: true, humanBound: true }))
      .toMatchObject({ kind: "duty_fallback", reason: "unverified_predicate" });
    expect(decideConsumedWaitResume({ ...base, verified: true, liveExecutor: true, verdictDuty: true, humanBound: true }))
      .toMatchObject({ kind: "duty_fallback", reason: "live_executor" });
    expect(decideConsumedWaitResume({ ...base, verified: true, liveExecutor: false, verdictDuty: true, humanBound: true }))
      .toMatchObject({ kind: "duty_fallback", reason: "verdict_duty" });
    expect(decideConsumedWaitResume({ ...base, verified: true, liveExecutor: false, verdictDuty: false, humanBound: true }))
      .toMatchObject({ kind: "duty_fallback", reason: "human_bound" });
  });
});

// ---------- B/C. hub end-to-end ----------

describe("consumed-wait parks resume (BR#14544, real SQLite)", () => {
  it("a verified consumed ask with no live holder auto-resumes to the dispatch pool (todo) with provenance — no duty child", async () => {
    const parent = await task("Satisfied park: delivered work, consumed ask");
    const askId = await poolAsk("Is the delivered prerequisite accepted?");
    await parkOnAsk(parent, askId);
    const answered = await call("ask.answer", { id: askId, answer: "Yes — accepted with receipts on the card", actor: "peer-2" });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect((await get(askId)).status).toBe("done");

    await call("admin.unblock_proxy_sweep", { now: nextSweepTs() });

    const resumed = await get(parent);
    expect(resumed.status).toBe("todo");
    expect(resumed.owner).toBe("");
    expect(resumed.meta.blocked).toBeUndefined();
    expect(resumed.meta.provenance).toMatchObject({ kind: "system_auto_resume", via: "consumed_wait", ask_id: askId });
    expect(resumed.meta.proxy_check).toMatchObject({ verdict: "true" });
    // no OPEN unblock round — the park-time spawn was superseded by the resume
    expect((await children(parent)).filter((c: any) => c.roles.includes("unblock") && ["todo", "in_progress", "blocked"].includes(String(c.status)))).toHaveLength(0);
    const history = (await call("get_history", { id: parent })).body.versions;
    expect(history.some((v: any) => v.action === "transition" && String(v.summary).includes("consumed-wait auto-resume"))).toBe(true);
    expect(history.some((v: any) => v.action === "wait_continued" && String(v.summary).includes("system auto-resume"))).toBe(true);
  });

  it("a resolved ask that was a human decision stays held — duty fallback with the loud-urgency brief", async () => {
    const witness = await task("Decision witness card (the ask's recorded subject)");
    const parent = await task("Human-decision-held park");
    const ask = await call("ask.create", {
      to: "human", route: { kind: "human_decision" }, artefact_id: witness,
      question: "Keep the witness card's operation after the pilot?",
      reason: "Only the operator chooses whether the operation is retained.",
      details: `The pilot ended; witness ${witness} holds the operation record.`,
      decision: {
        kind: "preference", task_id: witness, context: "The pilot is complete.",
        why_human: "The owner sets the retention policy.",
        choices: [
          { label: "KEEP the operation", executor: "bridge", consequence: "Bridge retains the record.", action: "hold" },
          { label: "Discard the record", executor: "bridge", consequence: "Bridge drops the record.", action: "release" },
        ],
      },
      actor: "author",
    });
    expect(ask.status, JSON.stringify(ask.body)).toBe(200);
    await parkOnAsk(parent, String(ask.body.id));
    const answered = await call("ask.answer", { id: ask.body.id, answer: "KEEP the operation", actor: "web:rayh" });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);

    await call("admin.unblock_proxy_sweep", { now: nextSweepTs() });

    const held = await get(parent);
    expect(held.status).toBe("blocked");
    const duty = (await children(parent)).find((c: any) => c.roles.includes("unblock"));
    expect(duty).toBeTruthy();
    expect(duty.meta.consumed_wait_fallback).toMatchObject({ reason: "human_bound" });
    expect(String(duty.body_md)).toContain('urgency "time-sensitive"');
  });

  it("a verdict-duty card cannot even park on a typed ask — the machine law the resume guard backs (separation of duties)", async () => {
    // verdict duties (role:review / role:unblock) are refused the blocked leg
    // outright (machine.ts verdict-no-blocked) — the sweep can never see a
    // legally-parked verdict duty on a typed wait, so the guard's
    // integration proof is the law itself; the decision-table unit test
    // above pins the verdict_duty fallback for the entry points that can
    // still reach a verdict-duty row (e.g. routeSatisfiedProxy's stall rows).
    const parent = await task("Verify duty with a consumed wait", {}, ["review"]);
    const askId = await poolAsk("Is the review evidence complete?");
    const p = await call("transition", {
      id: parent, to: "blocked", actor: "author", session: "",
      note: `Waiting on ${askId}`,
      await_event: { event: "ask", ask_id: askId },
    });
    expect(p.status).toBe(400);
    expect(JSON.stringify(p.body)).toContain("verdict-no-blocked");
  });

  it("a live holder session blocks the blind resume — duty fallback until its signal goes stale", async () => {
    const parent = await task("Park with a live holder session");
    const askId = await poolAsk("Should the holder continue the work?");
    await parkOnAsk(parent, askId, { session: "br14544-live-runner", last_progress: { ts: Date.now(), note: "holder alive" } });
    await call("ask.answer", { id: askId, answer: "Yes — continue", actor: "peer-2" });

    await call("admin.unblock_proxy_sweep", { now: nextSweepTs() });

    const held = await get(parent);
    expect(held.status).toBe("blocked");
    const duty = (await children(parent)).find((c: any) => c.roles.includes("unblock"));
    expect(duty).toBeTruthy();
    expect(duty.meta.consumed_wait_fallback).toMatchObject({ reason: "live_executor" });
  });

  it("the legacy completed-round invariant survives: a fallback duty's done-close consumes the prerequisite to the pool", async () => {
    const dependency = await task("Delivered prerequisite", {}, ["analysis"]);
    await call("transition", { id: dependency, to: "in_progress", actor: "dependency", session: "dependency" });
    const dependencyDone = await call("transition", {
      id: dependency, to: "done", actor: "dependency", session: "dependency",
      execution_result: { outcome: "Prerequisite analysis delivered", receipts: [dependency] }, note: "Analysis delivered",
    });
    expect(dependencyDone.status, JSON.stringify(dependencyDone.body)).toBe(200);

    const parent = await task("Actual execution still required, live holder at fire time", { completion: { kind: "execution", outcome: "Run the post-delivery action" } });
    const p = await call("transition", {
      id: parent, to: "blocked", actor: "author", session: "",
      note: "Waiting on prerequisite", await_event: { event: "br_done", id: dependency },
    });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    // live holder at fire time → first fire falls back to the duty path
    await call("update", { id: parent, meta: { session: "br14544-legacy-runner", last_progress: { ts: Date.now(), note: "holder alive" } }, actor: "author" });

    const now = nextSweepTs();
    await call("admin.unblock_proxy_sweep", { now });
    const duty = (await children(parent)).find((c: any) => c.roles.includes("unblock"));
    expect(duty).toBeTruthy();

    await call("transition", { id: duty.id, to: "in_progress", actor: "unblocker", session: "unblocker" });
    const finished = await call("transition", {
      id: duty.id, to: "done", actor: "unblocker", session: "unblocker",
      execution_result: { outcome: "Prerequisite verified; parent execution remains outstanding", receipts: [dependency] },
      note: `Prerequisite verified at https://hub.fleetbridge.run/card/${dependency.replace("#", "-")}; actual parent execution still required.`,
    });
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);

    // holder stale + completed round → the verified prerequisite is consumed
    await call("admin.unblock_proxy_sweep", { now: now + 60 * 60_000 });
    const resumed = await get(parent);
    expect(resumed.status).toBe("todo");
    expect(resumed.owner).toBe("");
    expect(resumed.meta.blocked).toBeUndefined();
    expect(resumed.meta.consumed_wait_fallback).toBeUndefined();
    const history = (await call("get_history", { id: parent })).body.versions;
    expect(history.some((v: any) => v.action === "wait_continued")).toBe(true);
    // no re-spawn: the consumed wait stays consumed
    await call("admin.unblock_proxy_sweep", { now: now + 120 * 60_000 });
    expect((await children(parent)).filter((c: any) => c.roles.includes("unblock"))).toHaveLength(1);
  });
});
