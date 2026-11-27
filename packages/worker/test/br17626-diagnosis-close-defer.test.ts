import { Miniflare } from "miniflare";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reviewOutcome } from "./completion-fixture";

/**
 * BR#17626 — the recovery-disposition close gate's emitter half.
 *
 * The live defect (2026-11-20, specimen BR#17432): an accepted_execution
 * review duty (BR#17502) closed done bound to a task-recovery duty
 * (BR#17432, machine_duty subject BR#16941), and the hub's acceptance
 * machinery (applyCurrentReview — the review-duty close hook plus the
 * review-reconcile sweep) attempted the machine `done` close. The
 * diagnosis-continuation gate refused it — correctly: the subject sat in
 * todo under a matched execution_diagnosis, its bound continuation having
 * been consumed (ask answered) before the staged close leg executed — but
 * the emitter retried the impossible close on every review-reconcile pass:
 * 3 refusals in 14 minutes folded "unclassified" and raised breach card
 * BR#17626 (the second card for this gate — BR#17493 delivered the
 * classifier half, recovery:held-diagnosis, as PR #472).
 *
 * Law pinned here (the BR#15659 signoff law, same emitter, same cure):
 *   1. An accepted execution review on a task-recovery duty whose subject
 *      still needs a continuation does NOT machine-close it: the duty stays
 *      in_review, the acceptance stays bound, and exactly ONE
 *      diagnosis_close_deferred marker records "accepted verdict retained,
 *      waiting on the subject's continuation".
 *   2. The emitter stands down: subsequent sweep passes add no markers, no
 *      refusals, and never close the duty.
 *   3. No regression: once the gate disarms (the subject regains a bound
 *      open ask), the same sweep closes the duty done — no agent leg.
 */

let mf: Miniflare;
let kbNs: any;

const rig = `import { KnowledgeHub } from "./index.js";
  export class DiagnosisRig extends KnowledgeHub {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/fixture/budget-pile") {
        const { ids, age_ms = 60_000 } = await request.json();
        const now = Date.now();
        let stamped = 0;
        for (const id of ids) {
          const row = this.state.storage.sql.exec("SELECT state FROM execution_state WHERE task_id=?", id).toArray()[0];
          const state = row ? JSON.parse(row.state) : { policy_version: 1, revision: 0, generation: 0, attempt: null, requirements: {}, messages: [], operations: [] };
          state.budget_exhaustions = 3;
          state.budget_exhausted_at = now - age_ms;
          this.state.storage.sql.exec("INSERT INTO execution_state (task_id, state, worker_token_id) VALUES (?, ?, '') ON CONFLICT(task_id) DO UPDATE SET state=excluded.state", id, JSON.stringify(state));
          stamped++;
        }
        return Response.json({ ok: true, stamped });
      }
      if (path === "/fixture/attempt-diagnosis") {
        await this.scheduleAttemptDiagnosis();
        return Response.json({ ok: true });
      }
      return super.fetch(request);
    }
  }
  export default { fetch() { return new Response("fixture"); } };`;

const kbJson = async (path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const stub: any = await kbNs.get(kbNs.idFromName("global"));
  const res = await stub.fetch(`https://kb${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

const get = async (id: string) => (await kbJson("/get", { id })).body;
const historyText = async (id: string) => {
  const hist = (await kbJson(`/history?id=${encodeURIComponent(id)}`)).body;
  return (hist?.versions ?? []).map((v: any) => `${v?.summary ?? ""}\n${v?.action ?? ""}`).join("\n");
};
const countMarkers = (text: string) => text.split("diagnosis_close_deferred").length - 1;

/** Accept the subject's exact submission via the hub-SPAWNED verify duty —
 *  the acceptance event that drives applyCurrentReview. */
const acceptSpawnedExecutionReview = async (dutyId: string, task_id: string, receipts: string[]) => {
  const session = `fixture-review-${crypto.randomUUID()}`;
  expect((await kbJson("/transition", { id: dutyId, to: "in_progress", actor: "fixture-reviewer", session })).status).toBe(200);
  const closed = await kbJson("/transition", { id: dutyId, to: "done", actor: "fixture-reviewer", session,
    review_result: await reviewOutcome(kbJson, dutyId, { kind: "accepted_execution", task_id, receipts }) });
  expect(closed.status, `spawned duty close failed: ${JSON.stringify(closed.body)}`).toBe(200);
};

beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  if (!existsSync(bundle)) throw new Error("bundle missing — run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle (before vitest)");
  const root = bundle.slice(0, bundle.lastIndexOf("/"));
  mf = new Miniflare({
    modulesRoot: root,
    modules: [
      { type: "ESModule", path: root + "/diagnosis-rig.js", contents: rig },
      { type: "ESModule", path: bundle, contents: readFileSync(bundle, "utf8") },
    ],
    compatibilityDate: "2025-09-06",
    durableObjects: { KB: { className: "DiagnosisRig", useSQLite: true } },
  });
  kbNs = await mf.getDurableObjectNamespace("KB");
  await kbJson("/orient", {});
});

afterAll(async () => { await mf?.dispose(); });

describe("BR#17626 — an accepted execution review defers the close on a diagnosis that still needs a continuation", () => {
  it("the duty stays in_review, the verdict stays bound, exactly one marker, and the sweep never retries the refused close", async () => {
    // The subject: an unclaimed todo task that exhausted its budget, so the
    // hub schedules a diagnosis duty over it (the BR#17432 shape).
    const created = await kbJson("/create", { type: "task", title: "BR#17626 specimen: starved root-fix subject",
      meta: { completion: { kind: "execution", outcome: "The bound red check is cured; only the mechanical close leg remains." } } });
    expect(created.status).toBe(200);
    const subject = String(created.body.id);
    expect((await kbJson("/fixture/budget-pile", { ids: [subject], age_ms: 60_000 })).body).toEqual({ ok: true, stamped: 1 });
    expect((await kbJson("/fixture/attempt-diagnosis", {})).body).toEqual({ ok: true });
    const diagnosis = (await get(subject)).meta.execution_diagnosis;
    expect(diagnosis).toMatchObject({ hold: "retry_budget" });
    const duty = String(diagnosis.duty);
    expect(duty).toBeTruthy();
    const dutyMeta = (await get(duty)).meta;
    expect(dutyMeta.machine_duty).toMatchObject({ kind: "task-recovery", reason: "execution_environment", subject });

    // Bind a live coordination ask to the subject so the gate lets the duty's
    // own in_review submission through (startupHasAsk disarms it), exactly the
    // BR#17432 close path ("continuation BOUND ... typed ask").
    const ask = await kbJson("/ask.create", { artefact_id: subject, to: "any",
      question: "Claim the subject, re-probe the staged receipts, and land the reconciled-delivered close. Who takes this?",
      details: "Fixture of BR#17498 — the typed continuation bound to the affected task.",
      options: ["Taken", "No overlap"] });
    expect(ask.status, JSON.stringify(ask.body)).toBe(200);
    const askId = String(ask.body.id ?? ask.body.ask);

    const session = `fixture-recovery-${crypto.randomUUID()}`;
    expect((await kbJson("/transition", { id: duty, to: "in_progress", actor: "fixture-recovery", session })).status).toBe(200);
    const submission = await kbJson("/transition", { id: duty, to: "in_review", actor: "fixture-recovery", session,
      execution_result: { outcome: "Reconciled-delivered path restored; continuation bound to the subject.",
        receipts: ["fixture://subject-ledger"] } });
    expect(submission.status, `submission failed: ${JSON.stringify(submission.body)}`).toBe(200);
    const verify = String(submission.body.verify_task);
    expect(verify).toBeTruthy();

    // Consume the ask before the acceptance lands — the production sequence:
    // BR#17498 was answered at 00:36Z, the acceptance arrived at 00:42Z, and
    // the gate re-armed over the todo subject.
    expect((await kbJson("/ask.answer", { id: askId, answer: "Taken", actor: "fixture-fixer" })).status).toBe(200);
    expect((await get(subject)).status).toBe("todo");

    await acceptSpawnedExecutionReview(verify, duty, ["fixture://subject-ledger"]);

    // the gate holds: the machine never completes a diagnosis without a live
    // continuation on its subject
    expect((await get(duty)).status).toBe("in_review");
    // the acceptance machinery never emitted the machine-close note
    expect(await historyText(duty)).not.toContain("Independent execution acceptance");
    // exactly ONE deferral marker — the visible "accepted, awaiting the continuation" receipt
    expect(countMarkers(await historyText(duty))).toBe(1);

    // the emitter stands down: sweep passes (the live storm's driver) add
    // nothing — no retry, no second marker, no refusal, no close
    const sweep = await kbJson("/admin.alarm_sweep");
    expect(sweep.body.error ?? "").toBe("");
    await kbJson("/admin.alarm_sweep");
    await kbJson("/admin.alarm_sweep");
    expect((await get(duty)).status).toBe("in_review");
    expect(countMarkers(await historyText(duty))).toBe(1);
    expect(await historyText(duty)).not.toContain("Independent execution acceptance");
  });

  it("no regression: once the gate disarms, the same sweep applies the retained acceptance and closes the duty done", async () => {
    const created = await kbJson("/create", { type: "task", title: "BR#17626 control: starved subject regains a bound ask",
      meta: { completion: { kind: "execution", outcome: "The bound red check is cured; only the mechanical close leg remains." } } });
    expect(created.status).toBe(200);
    const subject = String(created.body.id);
    expect((await kbJson("/fixture/budget-pile", { ids: [subject] })).body).toEqual({ ok: true, stamped: 1 });
    expect((await kbJson("/fixture/attempt-diagnosis", {})).body).toEqual({ ok: true });
    const duty = String((await get(subject)).meta.execution_diagnosis.duty);

    // the ask stays OPEN through the acceptance, so the gate never arms and
    // the close lands immediately — the compliant BR#17428 shape. It must
    // exist BEFORE the submission: the gate reads startupHasAsk at the
    // in_review write boundary.
    const ask = await kbJson("/ask.create", { artefact_id: subject, to: "any",
      question: "Control: the subject holds an open coordination ask across the acceptance. Bound?",
      details: "Keeps startupHasAsk true so the recovery-disposition gate passes.",
      options: ["Bound", "Not bound"] });
    const session = `fixture-recovery-${crypto.randomUUID()}`;
    expect((await kbJson("/transition", { id: duty, to: "in_progress", actor: "fixture-recovery", session })).status).toBe(200);
    const submission = await kbJson("/transition", { id: duty, to: "in_review", actor: "fixture-recovery", session,
      execution_result: { outcome: "Reconciled-delivered path restored; continuation bound to the subject.",
        receipts: ["fixture://control-ledger"] } });
    expect(submission.status, `submission failed: ${JSON.stringify(submission.body)}`).toBe(200);
    const verify = String(submission.body.verify_task);
    expect(ask.status, JSON.stringify(ask.body)).toBe(200);

    await acceptSpawnedExecutionReview(verify, duty, ["fixture://control-ledger"]);
    expect((await get(duty)).status).toBe("done");
    expect(await historyText(duty)).toContain("Independent execution acceptance");
    expect(await historyText(duty)).not.toContain("diagnosis_close_deferred");

    // the sweep revisits the closed duty and must not resurrect anything
    await kbJson("/admin.alarm_sweep");
    expect((await get(duty)).status).toBe("done");
  });

  it("auto-completion: a retained acceptance applies on the first sweep after the hold clears", async () => {
    const created = await kbJson("/create", { type: "task", title: "BR#17626 deferred acceptance completes when the continuation re-binds",
      meta: { completion: { kind: "execution", outcome: "The bound red check is cured; only the mechanical close leg remains." } } });
    expect(created.status).toBe(200);
    const subject = String(created.body.id);
    expect((await kbJson("/fixture/budget-pile", { ids: [subject] })).body).toEqual({ ok: true, stamped: 1 });
    expect((await kbJson("/fixture/attempt-diagnosis", {})).body).toEqual({ ok: true });
    const duty = String((await get(subject)).meta.execution_diagnosis.duty);

    // the ask disarms the gate for the submission, then is answered BEFORE the
    // acceptance — re-arming the gate over the todo subject (production order)
    const ask = await kbJson("/ask.create", { artefact_id: subject, to: "any",
      question: "Claim the subject and land the staged close. Who takes this?", details: "Disarms the gate for the submission.",
      options: ["Taken", "No overlap"] });
    const session = `fixture-recovery-${crypto.randomUUID()}`;
    expect((await kbJson("/transition", { id: duty, to: "in_progress", actor: "fixture-recovery", session })).status).toBe(200);
    const submission = await kbJson("/transition", { id: duty, to: "in_review", actor: "fixture-recovery", session,
      execution_result: { outcome: "Reconciled-delivered path restored; continuation bound to the subject.",
        receipts: ["fixture://deferred-ledger"] } });
    expect(submission.status, `submission failed: ${JSON.stringify(submission.body)}`).toBe(200);
    const verify = String(submission.body.verify_task);
    expect(ask.status, JSON.stringify(ask.body)).toBe(200);
    expect((await kbJson("/ask.answer", { id: String(ask.body.id ?? ask.body.ask), answer: "Taken", actor: "fixture-fixer" })).status).toBe(200);

    await acceptSpawnedExecutionReview(verify, duty, ["fixture://deferred-ledger"]);
    expect((await get(duty)).status).toBe("in_review");
    expect(countMarkers(await historyText(duty))).toBe(1);

    // the continuation re-binds: a fresh open ask on the subject disarms the
    // gate, and the sweep applies the retained acceptance — no agent leg
    const rebind = await kbJson("/ask.create", { artefact_id: subject, to: "any",
      question: "Re-bound continuation: the staged close leg is ready. Take it?", details: "Re-arms startupHasAsk.",
      options: ["Taken", "No overlap"] });
    expect(rebind.status, JSON.stringify(rebind.body)).toBe(200);
    const swept = await kbJson("/admin.alarm_sweep");
    expect(swept.body.error ?? "").toBe("");
    expect((await get(duty)).status).toBe("done");
    expect(await historyText(duty)).toContain("Independent execution acceptance");
    // the stand-down receipt stays exactly once — history, not noise
    expect(countMarkers(await historyText(duty))).toBe(1);
  });
});
