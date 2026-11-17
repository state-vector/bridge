import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { completePrReview } from "./completion-fixture";

/**
 * BR#15722 — the merge train's own close emitters meet the human sign-off
 * fence.
 *
 * The live defect (2026-11-17, specimen BR#15616, roles:["human"] sign-off
 * card whose GH3351 delivery PR merged green): the fence (machine.ts
 * human-signoff-done) correctly refuses every machine `done` — completion is
 * human-authoritative — but TWO train-path emitters kept retrying the
 * impossible close:
 *   1. the landedFlow final-leg machine close: the refusal laddered the
 *      BR#4753 close-bounce (breach_class "unclassified" stamped at
 *      1794878008941 — the same millisecond breach card BR#15722 was raised);
 *   2. the BR#9510 merged-provenance carry (closeAdmittedMergedCard, reached
 *      from the admission replay and the merged-park sweep): each pass
 *      re-stamped the landed legs and refused the done again — 7
 *      merged_admission_close_refused events, 00:47–01:30Z.
 * PR #462 classifies the refusal never-a-breach and stands down the
 * review-acceptance emitter (applyCurrentReview) — it does not touch these
 * two. This file pins their cure:
 *   1. a role:["human"] subject at the train's final leg (landed close,
 *      burst-settle close) or under a merged-provenance carry is NEVER
 *      machine-closed: exactly ONE signoff_close_deferred marker per merge,
 *      the landed bookkeeping stamps close_held "human-signoff", the lane
 *      idles, and the card keeps its own lifecycle — status untouched, so a
 *      typed wait keeps its wait;
 *   2. the emitter stands down: repeated sweeps/replays add no markers, no
 *      refusals, and never close the subject — and the hold is HONEST
 *      bookkeeping everywhere else too: the BR#14544 consumed-wait
 *      auto-resume never machine-resumes a held sign-off card (the exit is
 *      human-owned, not the satisfied merge wait's), and the admission
 *      replay marks the carried admission admitted instead of re-driving it
 *      forever;
 *   3. no regression: the same flows on a non-human subject still close it
 *      done (BR#4753 green landing / BR#15528 merged-accept semantics).
 */

const REPO = "state-vector/signoff-hold";
const OLD = "1".repeat(40);
const HEAD = "a".repeat(40);
const MERGE = "c".repeat(40);

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

const check = (id: number, name: string, conclusion: string | null, url = `https://example/ci/${id}`): Record<string, unknown> =>
  ({ id, name, status: conclusion == null ? "in_progress" : "completed", conclusion, html_url: url });

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

const get = async (id: string) => (await kbJson("/get", { id })).body;
const versions = async (id: string) => (((await kbJson(`/history?id=${encodeURIComponent(id)}`)).body?.versions ?? []) as any[]);
const mergeKeyedMarkers = async (id: string, mergeSha: string) =>
  (await versions(id)).filter((v) => v.action === "signoff_close_deferred" && String((v?.data ?? v)?.merge_sha ?? "") === mergeSha).length;
const countMarkers = async (id: string) => (await versions(id)).filter((v) => v.action === "signoff_close_deferred").length;

/** A role:["human"] delivery card parked on the train with a typed
 *  pr_merged wait — the exact BR#15616 specimen shape (the sign-off ask may
 *  own the exit while the delivery PR is already merged). */
const parkHumanCard = async (title: string, pr: number, human = true) => {
  const created = await kbJson("/create", {
    type: "task", title,
    ...(human ? { roles: ["human"] } : {}),
    meta: {
      pr: { repo: REPO, number: pr, head_sha_at_acceptance: HEAD, base: "main" },
      prs: [{ repo: REPO, number: pr, head_sha_at_acceptance: HEAD, base: "main" }],
      merge_train: { state: "queued", pr, repo: REPO, at: Date.now() },
    },
  });
  expect(created.status).toBe(200);
  const id = String(created.body.id);
  const park = await kbJson("/transition", {
    id, to: "blocked",
    note: `merge-train: queued — delivery ${REPO}#${pr} (BR#15722 rig).`,
    await_event: { event: "pr_merged", repo: REPO, n: pr },
    actor: "fixture-owner",
  });
  expect(park.status, `park failed: ${JSON.stringify(park.body)}`).toBeLessThan(400);
  expect((await get(id)).status).toBe("blocked");
  return id;
};

const stampMergedRow = async (pr: number, mergeSha: string, headSha: string, taskId?: string) => {
  expect((await kbJson("/train.lane", { repo: REPO, base: "main", actor: "fixture-gw", spec: { required_workflows: ["Test"] } })).status).toBe(200);
  expect((await kbJson("/train.lease", { repo: REPO, base: "main", action: "acquire", actor: "fixture-gw" })).status).toBe(200);
  const r = await kbJson("/train.event", { repo: REPO, base: "main", kind: "merged", actor: "fixture-gw", pr, merge_sha: mergeSha, head_sha: headSha, ...(taskId ? { task_id: taskId } : {}) });
  expect(r.body.error ?? "", `train.event failed: ${JSON.stringify(r.body)}`).toBe("");
  if (taskId) expect(r.body.task, "the merged event must bind the riding car to its task").toBe(taskId);
};

describe("BR#15722 — the train's landed close defers on a human sign-off subject", () => {
  it("green landing on a role:human card: the pass settles, the typed wait survives, exactly one marker, and no close is retried", async () => {
    const pr = 33770;
    const id = await parkHumanCard("BR#15722 specimen: train landed close held for the human sign-off (role: human)", pr);
    // the train reports the riding car's task binding with the merge (the
    // production walk passes task_id on every merged event) — this is what
    // binds the landed close to the card
    await stampMergedRow(pr, MERGE, HEAD, id);

    const green = await kbJson("/train.ci", {
      repo: REPO, base: "main", actor: "fixture-gw", sha: MERGE,
      checks: [check(1, "Test", "success", "https://example/ci/signoff-green")],
    });
    expect(green.status, `train.ci failed: ${JSON.stringify(green.body)}`).toBeLessThan(400);
    expect(green.body.decided).toBe("landed");

    // the fence holds: the machine never completes a human sign-off task
    const card = await get(id);
    expect(card.status).toBe("blocked");
    // the landed bookkeeping is honest: legs landed, the close HELD
    expect(card.meta?.merge_train?.state).toBe("landed");
    expect(card.meta?.merge_train?.close_held).toBe("human-signoff");
    expect(card.meta?.merge_train?.merge_sha).toBe(MERGE);
    // a card holding a typed wait keeps its wait — the walk never flips status
    expect(card.meta?.blocked?.await_event).toMatchObject({ event: "pr_merged", repo: REPO, n: pr });

    // exactly ONE deferral marker — the visible "landed, awaiting the human" receipt
    expect(await mergeKeyedMarkers(id, MERGE)).toBe(1);

    // no machine close note, no close-bounce
    const hist = JSON.stringify(await versions(id));
    expect(hist).not.toContain("closing on the machine proxy");
    expect(hist).not.toContain("Merge-train close bounce");

    // the lane idles and the ledger recorded the landed leg (held)
    const snap = (await kbJson("/train.status", { repo: REPO })).body.lanes[0];
    expect(snap.currently).toBeNull();
    const ledger = (await kbJson("/train.history", { repo: REPO })).body.events;
    const landedRow = ledger.filter((e: any) => e.kind === "landed" && e.task_id === id);
    expect(landedRow.length).toBe(1);
    expect(JSON.stringify(landedRow[0].detail)).toContain("close_held");

    // the emitter stands down: sweep passes add nothing
    const sweep = await kbJson("/admin.alarm_sweep");
    expect(sweep.body.error ?? "").toBe("");
    await kbJson("/admin.alarm_sweep");
    const after = await get(id);
    expect(after.status).toBe("blocked");
    expect(after.meta?.merge_train?.state).toBe("landed");
    expect(await mergeKeyedMarkers(id, MERGE)).toBe(1);
  });

  it("the merged-provenance carry on a role:human card is terminal: one marker per merge, sweeps never retry, the acceptance stays carried", async () => {
    const pr = 33771;
    const id = await parkHumanCard("BR#15722 specimen: admission carry held for the human sign-off (role: human)", pr);
    // the ledger row's merged head is one the acceptance does NOT cover —
    // the BR#9510 head-law terminal stays first and refuses; the BR#15528
    // ledger terminal still settles (a merged PR's head is immutable).
    await stampMergedRow(pr, MERGE, OLD);
    await completePrReview(kbJson, id, [{ repo: REPO, number: pr, head_sha_at_acceptance: HEAD }]);

    // the review-acceptance emitter (#462) already deferred the close; the
    // card is untouched — the durable admission replay drives the carry
    expect((await get(id)).status).toBe("blocked");

    const sweep = await kbJson("/admin.alarm_sweep");
    expect(sweep.body.error ?? "").toBe("");

    const card = await get(id);
    expect(card.status).toBe("blocked");
    expect(card.meta?.merge_train?.state).toBe("landed");
    expect(card.meta?.merge_train?.close_held).toBe("human-signoff");
    expect(card.meta?.blocked?.await_event).toMatchObject({ event: "pr_merged", repo: REPO, n: pr });
    expect(await mergeKeyedMarkers(id, MERGE)).toBe(1);

    const hist = JSON.stringify(await versions(id));
    expect(hist).not.toContain("merged_admission_close_refused");
    expect(hist).not.toContain("merged_admission_closed");
    expect(hist).not.toContain("closing on the merged-provenance receipt");

    // the emitter stands down: repeated replays add nothing, close nothing
    const markersBefore = await countMarkers(id);
    await kbJson("/admin.alarm_sweep");
    await kbJson("/admin.alarm_sweep");
    const after = await get(id);
    expect(after.status).toBe("blocked");
    expect(after.meta?.merge_train?.state).toBe("landed");
    expect(await countMarkers(id)).toBe(markersBefore);
    expect(await mergeKeyedMarkers(id, MERGE)).toBe(1);
    expect(JSON.stringify(await versions(id))).not.toContain("merged_admission_close_refused");
  });

  it("no regression: the same carry flow on a non-human subject still closes it done (BR#15528 semantics)", async () => {
    const pr = 33772;
    const id = await parkHumanCard("BR#15722 control: machine-closable delivery card (no human role)", pr, false);
    await stampMergedRow(pr, MERGE, OLD);
    await completePrReview(kbJson, id, [{ repo: REPO, number: pr, head_sha_at_acceptance: HEAD }]);

    const done = await get(id);
    expect(done.status).toBe("done");
    expect(done.meta?.merge_train?.state).toBe("landed");
    const hist = JSON.stringify(await versions(id));
    expect(hist).toContain("merged_admission_closed");
    expect(hist).not.toContain("signoff_close_deferred");
  });
});
