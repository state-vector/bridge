import { Miniflare } from "miniflare";
import { realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isChurnPark, blockedParkVerdict } from "../src/kb/machine";

/**
 * BR#22008 — typed core workflows: free text never drives dispatch.
 *
 * The law under test (steering BR#22007): an ask's answer resolves a
 * Decision ONLY by exact choice-label match; the matched choice's typed
 * `action` is the sole dispatch key. Prose answers are commentary —
 * recorded, rendered, never executed. The deleted machinery: the
 * BR#3912/BR#5570/BR#17095 verb-token matcher (answer text parsed for
 * RELEASE/KEEP/SUPERSEDE verbs, "(Recommended)" stripping, SUPERSEDE
 * self-naming regexes).
 *
 * Also pins:
 * - The BR#21657 wedge cure: a todo-parked card's close_card ask answers
 *   in ONE typed click — the composed-edge close leg claims through
 *   in_progress (the only legal door) then applies the disposition. The
 *   op-first client ordering that 400'd (`todo → done not allowed`) before
 *   the answer recorded is gone: the ANSWER is the authority, the hub is
 *   the pen.
 * - Typed gate rejections: 400 bodies carry result_class + rule (struct,
 *   not prose) so clients route without parsing error text.
 * - The typed churn flag: a churn-guard park is recognised by its typed
 *   await_event (recovery_required), not by prose reason prefix.
 */

let mf: Miniflare;
let stub: any;
async function call(op: string, body: object = {}) {
  const response = await stub.fetch(`https://kb/${op}`, { method: "POST", headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  mf = new Miniflare({ workers: [{ name: "main", scriptPath: bundle, modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")), modules: true, compatibilityDate: "2025-09-06", durableObjects: { KB: { className: "KnowledgeHub", useSQLite: true } } }] });
  const ns = await mf.getDurableObjectNamespace("KB");
  stub = await ns.get(ns.idFromName("br22008-typed-dispatch"));
  await call("orient", { actor: "test" });
});
afterAll(async () => { await mf?.dispose(); });

describe("typed answer dispatch (BR#22008)", () => {
  it("a todo-parked card's close_card ask closes in ONE typed answer — the BR#21657 wedge cure (composed edge, no op-first 400)", async () => {
    // the wedge shape: a delivered card demoted to todo (watchdog) with an
    // open human_decision close ask — the state where the op-first button
    // 400'd (todo→done has no edge) BEFORE recording the answer
    const task = (await call("create", { type: "task", title: "Delivered then demoted — BR#22008 drill", qualified: true })).body.id;
    await call("transition", { id: task, to: "in_progress", actor: "owner", session: "holder-22008" });
    await call("transition", { id: task, to: "todo", actor: "owner", note: "watchdog demote drill" });
    const parked = (await call("get", { id: task })).body;
    expect(parked.status).toBe("todo");

    const ask = await call("ask.create", { template: { kind: "close_card", task_id: task, subject: "delivered direct-to-main; demoted by the watchdog", disposition: "done", receipts: "commit dfc9d1a142 direct-main; review BR#21692 accepted_pr", why_now: "the human confirmed delivery" } });
    expect(ask.status, JSON.stringify(ask.body)).toBe(200);
    const node = (await call("get", { id: ask.body.id })).body;
    expect(node.meta.ask.decision.choices[0]).toMatchObject({ executor: "human", action: "close" });
    expect(node.meta.ask.to).toBe("human");

    // the ONE typed click: the exact choice label. The hub composes
    // todo → in_progress → done (the only legal doors), validates every
    // gate server-side, and records the answer — no client op runs first.
    const label = String(node.meta.ask.decision.choices[0].label);
    const answered = await call("ask.answer", { id: ask.body.id, answer: label, actor: "web:rayh" });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(answered.body.task_status).toBe("done");
    const closed = (await call("get", { id: task })).body;
    expect(closed.status).toBe("done");
    // the ask resolved with the answer recorded
    const askAfter = (await call("get", { id: ask.body.id })).body;
    expect(askAfter.status).toBe("done");
    expect(String(askAfter.meta.ask.answer ?? "")).toContain(label);
  });

  it("free text is commentary: a prose answer records on the ask and dispatches NOTHING", async () => {
    const task = (await call("create", { type: "task", title: "Prose answer drill — BR#22008", qualified: true })).body.id;
    await call("transition", { id: task, to: "in_progress", actor: "owner", session: "holder-22008b" });
    const ask = await call("ask.create", { template: { kind: "close_card", task_id: task, subject: "delivered direct-to-main", disposition: "done", receipts: "commit a1b2c3d direct-main", why_now: "the human confirmed delivery" } });
    expect(ask.status, JSON.stringify(ask.body)).toBe(200);

    // the old matcher executed this ("close it please" carried no verb, but
    // "RELEASE it please" / "SUPERSEDE: whatever" DID dispatch). Now: the
    // answer records, the card is untouched, no verb ever executes.
    const answered = await call("ask.answer", { id: ask.body.id, answer: "RELEASE it please — actually just close it", actor: "web:rayh" });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    const taskAfter = (await call("get", { id: task })).body;
    expect(taskAfter.status).toBe("blocked"); // the ask still binds it; NO release, NO supersede fired
    const askAfter = (await call("get", { id: ask.body.id })).body;
    expect(askAfter.status).toBe("done"); // the commentary answer resolved the ask
    expect(String(askAfter.meta.ask.answer ?? "")).toContain("RELEASE it please");
  });

  it("an exact choice label is the ONLY free-text shape that dispatches — near-miss labels are commentary", async () => {
    const task = (await call("create", { type: "task", title: "Exact-match drill — BR#22008", qualified: true })).body.id;
    await call("transition", { id: task, to: "in_progress", actor: "owner", session: "holder-22008c" });
    const ask = await call("ask.create", { template: { kind: "release_hold", task_id: task, subject: "holder gone" } });
    expect(ask.status, JSON.stringify(ask.body)).toBe(200);
    const node = (await call("get", { id: ask.body.id })).body;
    const label = String(node.meta.ask.decision.choices[0].label); // "Release"

    // near-miss: a label with decoration (the BR#5570 shape — the web button
    // used to echo "(Recommended) Release — …") must still match ONLY if it
    // equals a choice label exactly; decoration makes it commentary.
    const decorated = await call("ask.answer", { id: ask.body.id, answer: `(Recommended) ${label} — executed from this ask`, actor: "web:rayh" });
    expect(decorated.status, JSON.stringify(decorated.body)).toBe(200);
    const taskAfter = (await call("get", { id: task })).body;
    // no dispatch from the decorated near-miss: the subject keeps its
    // held state (blocked on the now-answered ask's fold)
    expect(taskAfter.status).toBe("blocked");
  });

  it("typed gate rejections: 400 bodies carry result_class and rule — clients route on the struct", async () => {
    const task = (await call("create", { type: "task", title: "Rejection envelope drill — BR#22008", qualified: true })).body.id;
    // the exact 400 Ray kept hitting — now a STRUCT: result_class + rule
    const r = await call("transition", { id: task, to: "done", actor: "web:rayh", note: "close drill" });
    expect(r.status).toBe(400);
    expect(r.body.result_class).toBe("gate_rejected");
    expect(r.body.rule).toBe("lifecycle");
    expect(String(r.body.error)).toContain("todo");
    // the card is untouched — a refusal never mutates
    expect((await call("get", { id: task })).body.status).toBe("todo");
  });

  it("the churn flag is typed and forge-proof: recovery_required is scheduler-authority-only; classification reads the typed event (prose prefix = legacy adapter)", async () => {
    // (a) the typed event has CLOSED creation authority — a free transition
    // cannot stamp a churn flag; only the scheduler (the machine's churn
    // guard / recovery paths) may. Typed events are never client-forged.
    const task = (await call("create", { type: "task", title: "Typed churn drill — BR#22008", qualified: true })).body.id;
    await call("transition", { id: task, to: "in_progress", actor: "owner", session: "holder-22008d" });
    const forged = await call("transition", { id: task, to: "blocked", actor: "owner", note: "churn guard: released to the pool 3 times without completing", unblock_condition: "Bridge diagnoses the repeated failure and establishes a reviewed recovery condition.", await_event: { event: "recovery_required", cause: "repeated_failure" } });
    expect(forged.status).toBe(400);
    expect(forged.body.result_class).toBe("gate_rejected");
    expect(forged.body.rule).toBe("blocked-needs-typed-await");
    expect((await call("get", { id: task })).body.status).toBe("in_progress"); // refusal never mutates
  });

  it("isChurnPark + blockedParkVerdict classify typed-first (unit)", async () => {
    // the typed birth stamp classifies WITHOUT any prose
    expect(isChurnPark({ blocked: { await_event: { event: "recovery_required" }, reason: "anything" } })).toBe(true);
    // legacy shape B (the intermediate time-event era) still classifies
    expect(isChurnPark({ blocked: { await_event: { event: "time" }, reason: "churn guard: released 3 times" } })).toBe(true);
    // legacy shape A (pre-typed, event-less) still classifies
    expect(isChurnPark({ blocked: { reason: "churn guard: silent churn" } })).toBe(true);
    // a human park is NOT a churn park — even with similar prose
    expect(isChurnPark({ blocked: { await_event: { event: "ask", ask_id: "BR#1" }, reason: "awaiting the human" } })).toBe(false);
    expect(isChurnPark({})).toBe(false);
    // the drain classifier is typed-first: recovery_required → churn-park
    expect(blockedParkVerdict({ reason: "unrelated prose", unblockCondition: "", now: 0, staleMs: 1000, awaitEvent: { event: "recovery_required" } }).klass).toBe("churn-park");
    // a typed non-churn wait with churn-sounding prose is NOT a churn park:
    // the typed event wins — the wait's own exit (here the ask) owns the park
    expect(blockedParkVerdict({ reason: "churn guard: (legacy label)", unblockCondition: "", now: 0, staleMs: 1000, awaitEvent: { event: "ask", ask_id: "BR#9" }, askIsOpen: () => true }).klass).toBe("external");
    // prose adapter still classifies unlabeled legacy rows
    expect(blockedParkVerdict({ reason: "churn guard: released 3 times", unblockCondition: "", now: 0, staleMs: 1000 }).klass).toBe("churn-park");
  });
});
