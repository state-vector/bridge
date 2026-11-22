import { Miniflare } from "miniflare";
import { readFileSync, realpathSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SchedulingOutcomeSchema } from "@bridge/contracts";
import { executorRequest } from "./executor-fixture";

/** BR#18868 — a CANCELLED non-human coordination ask must stop holding its
 *  affected task out of dispatch. Specimen BR#18852: the producer's close
 *  cancelled ask BR#18859 (route task_id = producer), the consumer parked on
 *  `awaiting_ask` + the typed ask await; the recovery duty's plain agent
 *  transition blocked→todo consumed the typed wait but preserved the marker,
 *  and the native scheduler held the claimable todo card as independent_wait
 *  forever. Fixes: the cancel reconciles the exact stale marker (A), and
 *  scheduler admission ignores a marker whose canonical exact ask is
 *  cancelled (B backstop). Still-open asks, ANSWERED asks (BR#3578
 *  keep-park), human decisions, replacement markers and unknown legacy ids
 *  must all keep holding. Producer fixtures are operator-gated
 *  (dispatch-ineligible — the consumer/fillers carry the reservation
 *  asserts) with the analysis role, so their close reaches done without
 *  review (the specimen's producer close is background, not the subject). */

let mf: Miniflare;
let stub: { fetch(url: string, init: RequestInit): Promise<Response> };
let serial = 0;
async function post(op: string, body: object = {}) {
  const response = await stub.fetch(`https://kb/${op}`, { method: "POST", headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify(executorRequest(body)) });
  return await response.json() as Record<string, any>; // JSON transport boundary, schemas validate outcomes
}
const get = async (id: string) => (await post("get", { id }));
const metaOf = (id: string) => (get(id)).then(n => n.meta ?? {});

beforeEach(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  const root = bundle.slice(0, bundle.lastIndexOf("/"));
  const rig = `import { KnowledgeHub } from "./index.js";
    export class CancelledAskRig extends KnowledgeHub {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        // Stamp the stranded-marker shape a pre-fix card could carry: an
        // awaiting_ask marker on a card the API paths no longer produce.
        if (path === "/fixture/br18868-stamp-marker") {
          const { id, ask_id } = await request.json();
          const row = this.state.storage.sql.exec("SELECT meta FROM artefacts WHERE id=?", id).toArray()[0];
          const meta = JSON.parse(String(row?.meta ?? "{}"));
          meta.awaiting_ask = { ...(meta.awaiting_ask ?? {}), ask_id, ts: Date.now() };
          this.state.storage.sql.exec("UPDATE artefacts SET meta=? WHERE id=?", JSON.stringify(meta), id);
          return Response.json({ ok: true, ask_id });
        }
        // A legacy asks-table row (pre-question-node shape, ASK-… ids) with a
        // chosen status — the admission provenance read hits this table when
        // the marker's ask_id is not a BR# node.
        if (path === "/fixture/br18868-legacy-ask") {
          const { ask_id, status, answer } = await request.json();
          this.state.storage.sql.exec(
            "INSERT INTO asks (id, from_label, to_target, question, status, answer, answered_by, created_ts, answered_ts) VALUES (?, 'fixture', 'fixture-agent', 'legacy coordination', ?, ?, 'fixture-peer', ?, ?)",
            ask_id, status, answer ?? null, Date.now() - 90_000, status === "answered" || status === "expired" ? Date.now() - 60_000 : null);
          return Response.json({ ok: true, ask_id, status });
        }
        // A live managed writer on a card that has never run: the exact
        // quiescence shape the cancel-time reconcile must defer to.
        if (path === "/fixture/br18868-synthetic-live") {
          const { id } = await request.json();
          const now = Date.now();
          const state = { policy_version: 1, revision: 0, generation: 1,
            attempt: { generation: 1, attempt_id: "att-live-" + id, host: "fixture-host", session: "fixture-live",
              lease_until: now + 60_000, action_deadline: now + 60_000, executor: null, phase: "running",
              checkpoint: null, restored_tree: null },
            requirements: {}, messages: [], operations: [] };
          this.state.storage.sql.exec("INSERT INTO execution_state (task_id, state, worker_token_id) VALUES (?, ?, '') ON CONFLICT(task_id) DO UPDATE SET state=excluded.state", id, JSON.stringify(state));
          return Response.json({ ok: true });
        }
        if (path === "/fixture/br18868-attempt-phase") {
          const { id, phase } = await request.json();
          const row = this.state.storage.sql.exec("SELECT state FROM execution_state WHERE task_id=?", id).toArray()[0];
          const state = JSON.parse(row.state);
          state.attempt.phase = phase;
          this.state.storage.sql.exec("UPDATE execution_state SET state=? WHERE task_id=?", JSON.stringify(state), id);
          return Response.json({ ok: true, phase });
        }
        return super.fetch(request);
      }
    }
    export default {fetch(){return new Response("fixture");}};`;
  mf = new Miniflare({ modulesRoot: root, modules: [
    { type: "ESModule", path: root + "/cancelled-ask-rig.js", contents: rig },
    { type: "ESModule", path: bundle, contents: readFileSync(bundle, "utf8") },
  ], compatibilityDate: "2025-09-06", durableObjects: { KB: { className: "CancelledAskRig", useSQLite: true } } });
  const ns = await mf.getDurableObjectNamespace("KB");
  stub = await ns.get(ns.idFromName("scheduler")) as unknown as typeof stub;
});
afterEach(async () => { await mf?.dispose(); });

async function gateway(project: string, capacity = 1) {
  const host = `scheduler-${++serial}`;
  const token = await post("admin.mint", { label: host, tags: ["gateway"] });
  const identity = await post("auth.identify", { bearer: token.secret });
  const provisioned = await post("agent.provision", { label: `${host}/worker`, actor: host });
  const auth = { actor: host, token_id: identity.token_id, gateway: true, agent: `${host}/worker`, session: `gateway-${serial}` };
  const capabilities = { tier: "small", tools: ["git"], environment: ["linux"], backend: "opencode", model: "test/small", config_revision: "one", capacity, projects: [project], worker: { kind: "provisioned", label: `${host}/worker` } };
  const cmd = (command: object, command_id = `command-${++serial}`, id = "gateway", session = auth.session) => post("execution", { ...auth, id, session, command_id, command });
  expect((await cmd({ kind: "advertise", capabilities })).ok).toBe(true);
  return { auth, capabilities, cmd, host };
}
async function task(project: string, opts: { roles?: string[]; meta?: object } = {}) {
  const result = await post("create", { actor: "author", type: "task", title: `Cancelled-ask fixture ${++serial}`, body_md: "Coordination fixture", project, qualified: true, ...(opts.roles ? { roles: opts.roles } : {}), meta: { ...(opts.meta ?? {}) } });
  expect(result.error).toBeUndefined();
  return result.id as string;
}
/** A producer card: operator-gated (dispatch-ineligible — the consumers and
 *  fillers carry every reservation assert) with the analysis role, so its
 *  close reaches done without review. operator_gated also exempts it from
 *  the capability sweep's park (the sweep never parks a gated card), and the
 *  gate's own sanctioned exit is the update endpoint's meta_delete — which
 *  closeProducer uses, mirroring "a human clears this by updating the task". */
const producer = (project: string) => task(project, { roles: ["analysis"], meta: { operator_gated: true } });
async function reserve(g: Awaited<ReturnType<typeof gateway>>) {
  return SchedulingOutcomeSchema.parse(await g.cmd({ kind: "schedule", mode: "reserve" }));
}

/** The ask-bound park: claim the consumer, then bind a coordination ask whose
 *  route targets the PRODUCER while the marker lands on the CONSUMER — the
 *  BR#18852 shape (askCreate stamps awaiting_ask + parks the card blocked). */
async function coordinationAsk(project: string, producer: string, consumer: string, question: string, options = ["Resume", "Hold"]) {
  const before = await get(consumer);
  if (before.status === "todo") {
    const claim = await post("transition", { id: consumer, to: "in_progress", actor: "author", session: "setup", note: "claim" });
    expect(claim.error, JSON.stringify(claim)).toBeUndefined();
  }
  const ask = await post("ask.create", { to: "peer-agent", actor: "author", question,
    route: { kind: "executor_coordination", task_id: producer }, artefact_id: consumer,
    options, reason: `${project}: producer coordination`, details: "Fixture coordination ask" });
  expect(ask.error, JSON.stringify(ask)).toBeUndefined();
  expect(ask.task_status).toBe("blocked");
  return String(ask.id);
}
/** The producer's close: the completion hook retires its coordination
 *  obligations immediately (machine cancel of every open ask bound to it).
 *  The operator gate clears through the normal update endpoint first —
 *  meta_delete is that gate's own sanctioned human exit. */
async function closeProducer(id: string) {
  const cleared = await post("update", { id, meta_delete: ["operator_gated"] });
  expect(cleared.error, JSON.stringify(cleared)).toBeUndefined();
  const before = await get(id);
  if (before.status === "todo") {
    const claim = await post("transition", { id, to: "in_progress", actor: "author", session: "setup", note: "claim" });
    expect(claim.error, JSON.stringify(claim)).toBeUndefined();
  }
  const done = await post("transition", { id, to: "done", actor: "author", session: "setup",
    note: "delivered — fixture://producer", execution_result: { outcome: "delivered", receipts: ["fixture://producer"] } });
  expect(done.error, JSON.stringify(done)).toBeUndefined();
}
/** The recovery duty's mechanical resume (BR#18861): a plain agent transition
 *  blocked→todo. The OWNER releases (release-needs-ownership: only the owner,
 *  a human, or an unblock duty with proof may release a claim); the
 *  transition consumes the dead-end record — the typed ask await goes with
 *  the blocked box, while whatever meta the park left behind survives. */
async function resumeToTodo(id: string) {
  const moved = await post("transition", { id, to: "todo", actor: "author", session: "setup",
    note: "release dead coordination wait — bound ask cancelled, never answerable" });
  expect(moved.error, JSON.stringify(moved)).toBeUndefined();
}

describe("BR#18868 — a cancelled coordination ask stops holding its affected task", () => {
  it("cancel reconciles the stale marker; the resumed card dispatches (the BR#18852 chain)", async () => {
    const project = "br18868-chain", g = await gateway(project);
    const producerId = await producer(project), consumer = await task(project);
    const askId = await coordinationAsk(project, producerId, consumer, `Any overlap before ${consumer} proceeds?`);

    const parked = await metaOf(consumer);
    expect(parked.awaiting_ask.ask_id).toBe(askId);
    expect(parked.blocked.await_event).toMatchObject({ event: "ask", ask_id: askId });

    // The machine cancel: the producer's close retires its coordination ask
    // ("Linked work ... is done") — no sweep needed for the immediate leg.
    await closeProducer(producerId);
    const ask = await get(askId);
    expect(ask.status).toBe("done");
    expect(ask.meta.ask.resolution.kind).toBe("cancelled"); // machine record preserved, never fabricated

    // (A) the cancel reconciled ONLY the stale marker — the typed ask await
    // still owns the parked card's exit until a resume consumes it.
    const reconciled = await metaOf(consumer);
    expect(reconciled.awaiting_ask).toBeUndefined();
    expect(reconciled.blocked.await_event).toMatchObject({ event: "ask", ask_id: askId });

    await resumeToTodo(consumer); // the recovery duty's mechanical resume
    const outcome = await reserve(g);
    expect(outcome).toMatchObject({ kind: "reserved", task_id: consumer });

    // Idempotent: a repeat sweep after the cancel must not resurrect,
    // double-reconcile, or disturb the claimed card.
    await post("admin.alarm_sweep");
    const askAfter = await get(askId);
    expect(askAfter.status).toBe("done");
    expect(askAfter.meta.ask.resolution.kind).toBe("cancelled");
    const claimed = await get(consumer);
    expect(claimed.status).toBe("in_progress");
    expect(claimed.meta.awaiting_ask).toBeUndefined();
  });

  it("a still-open coordination ask keeps holding its resumed card; the answer still resumes it", async () => {
    const project = "br18868-open", g = await gateway(project, 2); // two reserves: the filler, then the consumer after the answer
    const producerId = await producer(project), consumer = await task(project);
    const askId = await coordinationAsk(project, producerId, consumer, `Need producer input for ${consumer}?`);
    await resumeToTodo(consumer); // the stranded shape, but the ask is OPEN

    const first = await task(project);
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: first });
    expect(await metaOf(consumer).then(m => m.awaiting_ask?.ask_id)).toBe(askId);

    const answered = await post("ask.answer", { id: askId, answer: "Resume — no overlap", actor: "peer-agent" });
    expect(answered.error, JSON.stringify(answered)).toBeUndefined();
    expect((await metaOf(consumer)).awaiting_ask).toBeUndefined(); // the answer's cleanup
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: consumer });
  });

  it("a newer replacement ask keeps the hold when an older bound ask is cancelled", async () => {
    const project = "br18868-replacement", g = await gateway(project, 2); // two reserves: the filler, then the consumer after the replacement cancels
    const older = await producer(project), newer = await producer(project), consumer = await task(project);
    const firstAsk = await coordinationAsk(project, older, consumer, `First question for ${consumer}?`);
    // re-ask: resume, then bind the replacement — the marker's ask_id moves
    const resume = await post("transition", { id: consumer, to: "in_progress", actor: "author", session: "setup", note: "resume for re-ask" });
    expect(resume.error, JSON.stringify(resume)).toBeUndefined();
    const secondAsk = await coordinationAsk(project, newer, consumer, `Refined question for ${consumer}?`);
    expect(secondAsk).not.toBe(firstAsk);
    expect(await metaOf(consumer).then(m => m.awaiting_ask?.ask_id)).toBe(secondAsk);

    await closeProducer(older); // cancels the FIRST ask only
    expect((await get(firstAsk)).meta.ask.resolution.kind).toBe("cancelled");
    expect(await metaOf(consumer).then(m => m.awaiting_ask?.ask_id)).toBe(secondAsk); // exact match protects the newer marker

    const other = await task(project);
    await resumeToTodo(consumer);
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: other }); // the open replacement still holds

    await closeProducer(newer); // now the replacement is cancelled too
    expect((await get(secondAsk)).meta.ask.resolution.kind).toBe("cancelled");
    expect((await metaOf(consumer)).awaiting_ask).toBeUndefined();
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: consumer });
  });

  it("reconcile defers under a live writer, and admission still dispatches once the writer stops", async () => {
    const project = "br18868-defer", g = await gateway(project);
    const producerId = await producer(project), consumer = await task(project);
    const askId = await coordinationAsk(project, producerId, consumer, `Coordination for ${consumer}?`);
    await resumeToTodo(consumer); // ask open → card held, but the writer state is what matters below
    expect((await post("fixture/br18868-synthetic-live", { id: consumer })).ok).toBe(true);

    // A live writer at cancel time: the reconcile must NOT strip the marker
    // (the writer may re-stamp); it defers and the marker survives.
    await closeProducer(producerId);
    expect((await get(askId)).meta.ask.resolution.kind).toBe("cancelled");
    expect(await metaOf(consumer).then(m => m.awaiting_ask?.ask_id)).toBe(askId);

    // The writer stops — the marker is now stale metadata the writer can no
    // longer race, yet no cancel will run again. Admission (B) backstops.
    expect((await post("fixture/br18868-attempt-phase", { id: consumer, phase: "quiesced" })).ok).toBe(true);
    await post("admin.alarm_sweep"); // cancel early-returns on the done ask — no second reconcile
    expect(await metaOf(consumer).then(m => m.awaiting_ask?.ask_id)).toBe(askId);
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: consumer });
  });

  it("an ANSWERED ask keeps its keep-park record and holds a stamped marker (BR#3578); legacy ids hold only when alive or unknown", async () => {
    const project = "br18868-answered", g = await gateway(project, 4); // four reserves: the three hold fillers, then the expired-legacy carrier
    const producerId = await producer(project), parkedCard = await task(project);
    const askId = await coordinationAsk(project, producerId, parkedCard, `Answer me for ${parkedCard}?`, ["KEEP — stay parked", "RELEASE to the pool"]);
    // A KEEP answer is the deliberate park: the card stays blocked and the
    // answered ask node is the record (BR#3578 — no re-ask spam, no resume).
    const answered = await post("ask.answer", { id: askId, answer: "KEEP — stay parked", actor: "peer-agent" });
    expect(answered.error, JSON.stringify(answered)).toBeUndefined();
    expect((await get(parkedCard)).status).toBe("blocked");

    const carrier = await task(project);
    expect((await post("fixture/br18868-stamp-marker", { id: carrier, ask_id: askId })).ok).toBe(true);
    const other = await task(project);
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: other }); // the answered-ask marker still holds

    const legacy = await task(project);
    expect((await post("fixture/br18868-stamp-marker", { id: legacy, ask_id: "ASK-legacy-1" })).ok).toBe(true);
    const another = await task(project);
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: another }); // unknown legacy id: NOT provably dead

    // The ANSWERED legacy row keeps holding too — the answer owns the exit,
    // whatever shape the row takes.
    expect((await post("fixture/br18868-legacy-ask", { ask_id: "ASK-legacy-answered", status: "answered", answer: "keep parked" })).ok).toBe(true);
    const carrierAnswered = await task(project);
    expect((await post("fixture/br18868-stamp-marker", { id: carrierAnswered, ask_id: "ASK-legacy-answered" })).ok).toBe(true);
    const holdFiller = await task(project);
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: holdFiller }); // answered legacy: still a live hold

    // The EXPIRED legacy row is dead — the watchdog TTL proved nobody will
    // ever answer — so its carrier dispatches.
    expect((await post("fixture/br18868-legacy-ask", { ask_id: "ASK-legacy-expired", status: "expired" })).ok).toBe(true);
    const carrierExpired = await task(project);
    expect((await post("fixture/br18868-stamp-marker", { id: carrierExpired, ask_id: "ASK-legacy-expired" })).ok).toBe(true);
    expect(await reserve(g)).toMatchObject({ kind: "reserved", task_id: carrierExpired }); // expired legacy: provably dead
  });
});
