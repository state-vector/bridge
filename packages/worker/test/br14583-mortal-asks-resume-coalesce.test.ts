import { Miniflare } from "miniflare";
import { readFileSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideAskReap, decideRecoveryCoalesce, ASK_TTL_HOURS_DEFAULT } from "../src/kb/core.ts";

/**
 * BR#14583 — mortal asks + machine resume edges + recovery-duty coalescing
 * (the 50-ask pile-up class). Machine coordination asks whose asker session
 * died used to sit open forever (no TTL, no dead-asker reaping) while the
 * cards they parked (blocked await_event {event:ask}) were skipped by every
 * sweep — the open ask paused the watchdog. Pinned here:
 *
 *   R. decideAskReap — the closed union (keep | reap) and its guard
 *      precedence: open/ttl/dead-asker reaps; human/inRecovery/young/live
 *      keep;
 *   C. decideRecoveryCoalesce — spawn | dedupe | coalesce per
 *      (subject, wait episode) high-water: a stable park (nothing moved
 *      under the last done duty) cites the last disposition, a moved park
 *      spawns fresh;
 *   A1. a card parked on await ask whose ask exceeds TTL with a dead asker
 *      self-unblocks (released to the dispatch pool) with no
 *      human/interactive intervention;
 *   A1b. the same shape whose park recorded an underlying typed wait
 *      re-parks on it instead of releasing;
 *   A2. answering a bound ask auto-resumes the card (BR#14544 regression —
 *      ALL wait shapes, not just consumed waits);
 *   A3. a stable satisfied-but-held park spawns ZERO new re-derivation
 *      duties per tick (coalesced: cite, don't re-derive);
 *   A4. human-targeted asks (to: human) NEVER expire mechanically.
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
/** recovery duties spawned for a subject (machine_duty.kind task-recovery) */
async function recoveryDuties(id: string) {
  return (await children(id)).filter((c: any) => c.meta?.machine_duty?.kind === "task-recovery");
}
/** back-date an ask past TTL via the rig fixture (created_ts rewrite) */
async function backdateAsk(askId: string) {
  const cur = await get(askId);
  const past = Number(cur.created_ts ?? Date.now()) - (ASK_TTL_HOURS_DEFAULT + 6) * 3_600_000;
  const r = await stub.fetch("https://kb/fixture/back-date", {
    method: "POST", headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify({ id: askId, created_ts: past }),
  });
  expect(r.status).toBe(200);
}
/** The tests share ONE Durable Object; the ask-escalation sweep paces itself
 *  on settings clocks. Every sweep call advances the injected clock a whole
 *  hour so later tests never fall inside an earlier test's window. */
let sweepHour = 0;
const nextSweepTs = () => Date.now() + (++sweepHour) * 60 * 60_000;

/** An unbound pool coordination ask from a peer agent (ask.create with no
 *  artefact_id → no subject dispatch). */
const poolAsk = async (question: string, from = "peer") => {
  const r = await call("ask.create", {
    to: "any", route: { kind: "agent_coordination" }, question, options: ["Yes", "No"], actor: from,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return String(r.body.id);
};

/** Park `id` blocked on a typed ask leg naming `askId` (the consumed-wait
 *  shape). */
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

beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  if (!readFileSync(bundle, "utf8")) throw new Error("bundle missing — run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle (before vitest)");
  const root = bundle.slice(0, bundle.lastIndexOf("/"));
  // rig subclass: /fixture/back-date rewrites an ask node's created_ts past
  // TTL (the reaper reads created_ts vs the injected sweep clock — no real
  // 48h waits in tests). Same pattern as test/scheduling-hub.test.ts.
  const rig = `import { KnowledgeHub } from "./index.js";
    export class ReapRig extends KnowledgeHub {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/fixture/back-date") {
          const { id, created_ts } = await request.json();
          this.state.storage.sql.exec("UPDATE artefacts SET created_ts=? WHERE id=?", Number(created_ts), String(id));
          return Response.json({ ok: true });
        }
        return super.fetch(request);
      }
    }
    export default {fetch(){return new Response("fixture");}};`;
  mf = new Miniflare({ modulesRoot: root, modules: [
    { type: "ESModule", path: root + "/br14583-rig.js", contents: rig },
    { type: "ESModule", path: bundle, contents: readFileSync(bundle, "utf8") },
  ], compatibilityDate: "2025-09-25", durableObjects: { KB: { className: "ReapRig", useSQLite: true } } });
  const ns = await mf.getDurableObjectNamespace("KB");
  stub = await ns.get(ns.idFromName("reaper")) as unknown as typeof stub;
  await call("orient", { actor: "test" });
  // default ask TTL for the rig
  await call("admin.settings_set", { settings: { ask_ttl_hours: String(ASK_TTL_HOURS_DEFAULT) } });
});

afterAll(async () => {
  await mf?.dispose();
});

// ---------- R. decideAskReap (pure) ----------

describe("decideAskReap (BR#14583 closed union)", () => {
  const base = { askId: "BR#9001", open: true, ageMs: 72 * 3_600_000, ttlMs: 48 * 3_600_000, humanTargeted: false, inRecovery: false, askerLive: false };

  it("reaps an open machine ask past TTL whose asker is dead", () => {
    expect(decideAskReap({ ...base })).toMatchObject({ kind: "reap" });
  });
  it("keeps a closed ask", () => {
    expect(decideAskReap({ ...base, open: false })).toEqual({ kind: "keep" });
  });
  it("keeps a human-targeted ask even past TTL with a dead asker (A4)", () => {
    expect(decideAskReap({ ...base, humanTargeted: true })).toEqual({ kind: "keep" });
  });
  it("keeps a young ask even with a dead asker", () => {
    expect(decideAskReap({ ...base, ageMs: base.ttlMs - 1 })).toEqual({ kind: "keep" });
  });
  it("keeps a rerouted ask (in recovery) and a live-asker ask", () => {
    expect(decideAskReap({ ...base, inRecovery: true })).toEqual({ kind: "keep" });
    expect(decideAskReap({ ...base, askerLive: true })).toEqual({ kind: "keep" });
  });
});

// ---------- C. decideRecoveryCoalesce (pure) ----------

describe("decideRecoveryCoalesce (BR#14583 cite-don't-re-derive)", () => {
  const subject = "BR#9100";
  const episode = JSON.stringify([{ event: "ask", ask_id: "BR#9101" }, 1790000000000]);
  const park = { awaitEvent: { event: "ask", ask_id: "BR#9101" }, blockedTs: 1790000000000 };

  it("spawns when no prior duty exists", () => {
    expect(decideRecoveryCoalesce({ subjectId: subject, waitEpisode: episode, lastDuty: null, park }))
      .toEqual({ kind: "spawn" });
  });
  it("dedupes a LIVE prior duty (today's law survives)", () => {
    expect(decideRecoveryCoalesce({
      subjectId: subject, waitEpisode: episode,
      lastDuty: { id: "BR#9102", status: "in_progress", created_ts: 1790000000100, disposition: null }, park,
    })).toMatchObject({ kind: "dedupe", duty: "BR#9102" });
  });
  it("coalesces a done duty whose park predates it (stable park → cite)", () => {
    const out = decideRecoveryCoalesce({
      subjectId: subject, waitEpisode: episode,
      lastDuty: { id: "BR#9103", status: "done", created_ts: 1790000100000, disposition: "Recovery delivered; the park is stable" }, park,
    });
    expect(out.kind).toBe("coalesce");
    expect(out).toMatchObject({ duty: "BR#9103", disposition: "Recovery delivered; the park is stable" });
  });
  it("spawns fresh when the park MOVED under the done duty (new blocked.ts)", () => {
    expect(decideRecoveryCoalesce({
      subjectId: subject, waitEpisode: episode,
      lastDuty: { id: "BR#9103", status: "done", created_ts: 1790000100000, disposition: null },
      park: { ...park, blockedTs: 1790000200000 },
    })).toEqual({ kind: "spawn" });
  });
});

// ---------- A. hub end-to-end (real SQLite) ----------

describe("the reaper + coalescer (BR#14583, real SQLite)", () => {
  it("A1: a card parked on await ask whose ask exceeds TTL with a dead asker self-unblocks to the dispatch pool", async () => {
    const parent = await task("Ask-bound park, dead asker past TTL");
    const askId = await poolAsk("Did the dead peer deliver the prerequisite?");
    await parkOnAsk(parent, askId);
    await backdateAsk(askId);
    const sweep = await call("admin.ask_escalation_sweep", { now: nextSweepTs() });
    expect(sweep.status, JSON.stringify(sweep.body)).toBe(200);
    expect(sweep.body.escalated).toContain(askId);
    const ask = await get(askId);
    expect(ask.status).toBe("done");
    expect(ask.meta.ask.resolution).toMatchObject({ kind: "expired", by: "system:reaper" });
    const card = await get(parent);
    expect(card.status).toBe("todo");
    expect(card.owner).toBe("");
    expect(card.meta.blocked).toBeUndefined();
    const askHistory = (await call("get_history", { id: askId })).body.versions;
    expect(askHistory.some((v: any) => v.action === "transition" && /ask expired/.test(String(v.summary)))).toBe(true);
    const parentHistory = (await call("get_history", { id: parent })).body.versions;
    expect(parentHistory.some((v: any) => v.action === "transition" && /expired/.test(String(v.summary)))).toBe(true);
  });

  it("A4: human-targeted asks never expire mechanically", async () => {
    const witness = await task("Human-decision witness (reaper A4)");
    const ask = await call("ask.create", {
      to: "human", route: { kind: "human_decision" }, artefact_id: witness,
      question: "Should the human-only operation proceed?",
      reason: "Only the human owns this choice.",
      details: "A human-inbox ask; the reaper must never touch it.",
      decision: {
        kind: "preference", task_id: witness, context: "The pilot is complete.",
        why_human: "The owner sets the policy.",
        choices: [
          { label: "GO", executor: "bridge", consequence: "Bridge proceeds.", action: "resume" },
          { label: "KEEP", executor: "bridge", consequence: "Bridge holds.", action: "hold" },
        ],
      },
      actor: "author",
    });
    expect(ask.status, JSON.stringify(ask.body)).toBe(200);
    const id = String(ask.body.id);
    await backdateAsk(id);
    const sweep = await call("admin.ask_escalation_sweep", { now: nextSweepTs() });
    expect(sweep.status).toBe(200);
    expect(sweep.body.escalated).not.toContain(id);
    const survived = await get(id);
    expect(survived.status).toBe("todo");
  });

  it("A2: answering a bound ask auto-resumes the parked card (askAnswer's resume leg)", async () => {
    const parent = await task("Ask-bound park, answered by a live peer");
    await call("transition", { id: parent, to: "in_progress", actor: "author", session: "" });
    const ask = await call("ask.create", {
      to: "any", route: { kind: "agent_coordination" }, artefact_id: parent,
      question: "Should the parked card resume?", options: ["Yes", "No"], actor: "peer",
    });
    expect(ask.status, JSON.stringify(ask.body)).toBe(200);
    expect(ask.body.task_status).toBe("blocked");
    const askId = String(ask.body.id);
    const answered = await call("ask.answer", { id: askId, answer: "Yes — resume with receipts", actor: "peer-2" });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    // the answer itself resumed the park (holder-less, young ask → direct leg)
    const card = await get(parent);
    expect(card.status).toBe("in_progress");
    expect(card.meta.blocked?.await_event).toBeUndefined();
    expect(card.meta.awaiting_ask).toBeUndefined();
  });

  it("A2b: an answered typed ask leg auto-resumes via the sweep (BR#14544 consumed-wait regression, all wait shapes)", async () => {
    const parent = await task("Typed ask-leg park, answered out-of-band");
    const askId = await poolAsk("Should the parked card resume via the sweep?");
    await parkOnAsk(parent, askId);
    const answered = await call("ask.answer", { id: askId, answer: "Yes — resume with receipts", actor: "peer-2" });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    await call("admin.unblock_proxy_sweep", { now: nextSweepTs() });
    const card = await get(parent);
    expect(card.status).toBe("todo");
    expect(card.owner).toBe("");
    expect(card.meta.provenance).toMatchObject({ kind: "system_auto_resume", via: "consumed_wait", ask_id: askId });
  });

  it("A3: a stable satisfied-but-held strand park spawns ZERO new re-derivation duties per tick (cite, don't re-derive)", async () => {
    // the strand-disposition family (BR#6163 leg-3 shape): an out-of-queue
    // unbound car parked on a train-only wait gets a queue_binding recovery
    // duty EVERY alarm pass. With the duty CLOSED and the park stable
    // (nothing moved under the duty), the coalescer cites the last
    // disposition instead of re-spawning — the BR#4709 12+-duty pile-up class.
    const REPO = "state-vector/br14583-strand";
    const lane = await call("train.lane", { repo: REPO, base: "main", actor: "drill", spec: { required_workflows: ["Test"] } });
    expect(lane.status, JSON.stringify(lane.body)).toBe(200);
    const lease = await call("train.lease", { repo: REPO, base: "main", action: "acquire", actor: "gw-a3" });
    expect(lease.status, JSON.stringify(lease.body)).toBe(200);
    const ev = await call("train.event", { repo: REPO, base: "main", kind: "merged", actor: "gw-a3", pr: 1, merge_sha: "d".repeat(40) });
    expect(ev.status, JSON.stringify(ev.body)).toBe(200);
    const car = await task("BR#14583 coalescing specimen (unbound strand car)");
    const park = await call("transition", {
      id: car, to: "blocked", actor: "drill", session: "",
      note: `merge-train: queued — VERIFY ACCEPT. PR ${REPO}#3002.`,
      await_event: { event: "pr_merged", repo: REPO, n: 3002 },
    });
    expect(park.status, JSON.stringify(park.body)).toBe(200);
    const old = Date.now() - 3 * 3_600_000;
    const cur = await get(car);
    const upd = await call("update", {
      id: car, actor: "drill",
      meta: {
        merge_train: { ...(cur.meta.merge_train ?? {}), state: "unbound", pr: 3002, repo: REPO, at: old },
        blocked: { ...(cur.meta.blocked ?? {}), ts: old },
      },
    });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    // pass 1: one queue_binding duty
    const s1 = await call("admin.alarm_sweep", {});
    expect(s1.status, JSON.stringify(s1.body)).toBe(200);
    const carAfter1 = await get(car);
    const duty1 = String(carAfter1.meta.recovery?.task_id ?? "");
    expect(duty1).toMatch(/^BR#\d+$/);
    // pass 2 while LIVE: deduped (today's law survives)
    await call("admin.alarm_sweep", {});
    expect(String((await get(car)).meta.recovery?.task_id)).toBe(duty1);
    // close the duty done via the typed acceptance transport (BR#7721 fence:
    // in_review spawns the verify card; the verify's accepted_execution verdict
    // accepts the duty; then the duty closes done citing the acceptance)
    await call("transition", { id: duty1, to: "in_progress", actor: "recovery-exec", session: "recovery-exec" });
    const submitted = await call("transition", {
      id: duty1, to: "in_review", actor: "recovery-exec", session: "recovery-exec",
      note: "Recovery delivered; the strand car's disposition is recorded on the card.",
      execution_result: { outcome: "Recovery delivered; the strand car's disposition is recorded", receipts: [`https://hub.fleetbridge.run/card/${duty1.replace("#", "-")}`] },
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const verify = (await children(duty1)).find((c: any) => c.roles.includes("review"));
    expect(verify).toBeTruthy();
    await call("transition", { id: verify.id, to: "in_progress", actor: "independent", session: "independent" });
    const subject = (await get(verify.id)).meta.review_subject;
    const accepted = await call("transition", {
      id: verify.id, to: "done", actor: "independent", session: "independent",
      review_result: { kind: "accepted_execution", task_id: duty1, subject_revision: subject.revision, receipts: [`https://hub.fleetbridge.run/card/${duty1.replace("#", "-")}`] },
      note: "Verified the recorded disposition; accepted.",
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    // the acceptance itself closed the duty (status done) — the typed transport
    expect((await get(duty1)).status).toBe("done");
    // passes 3+4 with the duty DONE and the park stable: ZERO new duties —
    // the coalescer cites duty1's disposition (recovery_coalesce on the car)
    await call("admin.alarm_sweep", {});
    await call("admin.alarm_sweep", {});
    const carFinal = await get(car);
    const duties = await recoveryDuties(car);
    expect(duties.map((d: any) => d.id)).toEqual([duty1]);
    expect(carFinal.meta.recovery_coalesce).toMatchObject({ duty: duty1 });
    expect(String(carFinal.meta.recovery?.task_id)).toBe(duty1);
    const hist = (await call("get_history", { id: car })).body.versions;
    expect(hist.some((v: any) => v.action === "recovery_coalesced")).toBe(true);
  });
});