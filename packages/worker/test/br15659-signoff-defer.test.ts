import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { completeExecutionReview, reviewOutcome } from "./completion-fixture";

/**
 * BR#15659 — the human sign-off completion fence's emitter half.
 *
 * The live defect (2026-11-16, specimen BR#15615): an accepted_execution
 * review duty (BR#15644) closed done bound to a role:["human"] subject, and
 * the hub's acceptance machinery (applyCurrentReview — the review-duty close
 * hook plus the review-reconcile sweep) attempted the machine `done` close.
 * The human-signoff-done fence refused it (completion is human-authoritative;
 * a human marks it done in the webapp) — correctly — but the emitter retried
 * the impossible close on every ~5-min watchdog pass: 3 refusals in 11
 * minutes folded "unclassified" and raised breach card BR#15659, and the
 * sweep would have retried forever.
 *
 * Law pinned here:
 *   1. An accepted execution review on a role:["human"] subject does NOT
 *      machine-close it: the subject stays in_review, the acceptance stays
 *      bound, and exactly ONE signoff_close_deferred marker records "accepted
 *      verdict retained, awaiting the human".
 *   2. The emitter stands down: subsequent sweep passes add no markers, no
 *      refusals, and never close the subject.
 *   3. No regression: the same acceptance flow on a non-human subject still
 *      closes it done via applyCurrentReview.
 */

let mf: Miniflare;
let kbNs: any;

const kbJson = async (path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const stub: any = await kbNs.get(kbNs.idFromName("global"));
  const res = await stub.fetch(`https://kb${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

const task = async (title: string, roles?: string[]) => {
  // execution completion contract (the BR#15615 shape): the confirmation's
  // outcome is rendered work with receipts — never a PR merge
  const r = await kbJson("/create", {
    type: "task", title,
    ...(roles ? { roles } : {}),
    meta: { completion: { kind: "execution", outcome: "Independent confirmation with explicit gaps." } },
  });
  expect(r.status).toBe(200);
  return String(r.body.id);
};

const get = async (id: string) => (await kbJson("/get", { id })).body;
const historyText = async (id: string) => {
  const hist = (await kbJson(`/history?id=${encodeURIComponent(id)}`)).body;
  return (hist?.versions ?? []).map((v: any) => `${v?.summary ?? ""}\n${v?.action ?? ""}`).join("\n");
};
const countMarkers = (text: string) => text.split("signoff_close_deferred").length - 1;

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
  mf = new Miniflare({
    workers: [{
      name: "main",
      scriptPath: bundle,
      modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")),
      modules: true,
      compatibilityDate: "2025-09-25",
      durableObjects: { KB: { className: "KnowledgeHub", useSQLite: true } },
    }],
  });
  kbNs = await mf.getDurableObjectNamespace("KB");
  await kbJson("/orient", {});
});

afterAll(async () => { await mf?.dispose(); });

describe("BR#15659 — an accepted execution review defers the close on a human sign-off subject", () => {
  it("the subject stays in_review, the verdict stays bound, exactly one marker, and the sweep never retries the refused close", async () => {
    const id = await task("BR#15659 specimen: human sign-off confirmation (role: human)", ["human"]);
    expect((await kbJson("/transition", { id, to: "in_progress", actor: "drill-owner", note: "independent confirmation" })).status).toBe(200);
    const submission = await kbJson("/transition", { id, to: "in_review", actor: "drill-owner",
      execution_result: { outcome: "Independent confirmation rendered; every gap explicit, none synthesized.", receipts: ["receipt-1"] } });
    expect(submission.status, JSON.stringify(submission.body)).toBe(200);
    const duty = String(submission.body.verify_task);
    expect(duty).toBeTruthy();

    await acceptSpawnedExecutionReview(duty, id, ["receipt-1"]);

    // the fence holds: the machine never completes a human sign-off task
    const cur = await get(id);
    expect(cur.status).toBe("in_review");
    // the acceptance machinery never emitted the machine-close note
    expect(await historyText(id)).not.toContain("Independent execution acceptance");
    // exactly ONE deferral marker — the visible "accepted, awaiting the human" receipt
    expect(countMarkers(await historyText(id))).toBe(1);

    // the emitter stands down: sweep passes (the live storm's driver) add
    // nothing — no retry, no second marker, no refusal, no close
    const sweep = await kbJson("/admin.alarm_sweep");
    expect(sweep.body.error ?? "").toBe("");
    await kbJson("/admin.alarm_sweep");
    await kbJson("/admin.alarm_sweep");
    expect((await get(id)).status).toBe("in_review");
    expect(countMarkers(await historyText(id))).toBe(1);
  });

  it("no regression: the same acceptance flow on a non-human subject still closes it done", async () => {
    const id = await task("BR#15659 control: machine-closable execution card (no human role)");
    expect((await kbJson("/transition", { id, to: "in_progress", actor: "drill-owner-2", note: "impl" })).status).toBe(200);
    await completeExecutionReview(kbJson, id, { outcome: "delivered", receipts: ["receipt-2"] });
    expect((await get(id)).status).toBe("done");
    expect(await historyText(id)).toContain("Independent execution acceptance");
    expect(await historyText(id)).not.toContain("signoff_close_deferred");
  });
});
