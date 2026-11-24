import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reviewOutcome } from "./completion-fixture";

/**
 * BR#20312 — the stale submitted-legs class: when a PR head changes after the
 * first in_review transition (a rebase onto a moved main), re-entering
 * in_review with transition {subject_revision: <new head>} captured the
 * revision but never refreshed (a) the parent's meta.review_target.legs nor
 * (b) the freshly seeded/reused verify duty's review_offer legs. The
 * review-acceptance gate then requires accepted_pr legs == submitted legs, so
 * a fully verified new head could structurally NEVER be accepted (specimen
 * BR#19573 / PR state-vector/superpositional#3837: legs frozen at 8a7115801
 * while the verified head was 7dac01ae4; both verifiers independently
 * diagnosed the repair as hub-side — the subject_revision transport must also
 * refresh the submitted legs).
 *
 * Fix: in the in_review binding block, a full 40-hex subject_revision pins the
 * submitted head into the bound legs. The seeded/reused verify duty derives
 * its review_offer from taskReviewTarget(meta), so the fresh round reviews the
 * head that was actually submitted. Precedence: a server-side train target
 * wins untouched; a note binding its own head wins; the pin replaces only a
 * stale binding that neither transport carried a head for.
 *
 * Pinned here:
 *   1. re-entry with subject_revision → parent legs AND the reused verify
 *      duty's review_offer carry the new head;
 *   2. no subject_revision transport → the bound target passes through
 *      unchanged (the stale guard keeps its existing shape);
 *   3. a note binding its own head wins over subject_revision;
 *   4. end-to-end: after the pin, an accepted_pr verdict on the NEW head
 *      closes the parent — the acceptance that was structurally impossible.
 */

const REPO = "state-vector/superpositional";
const PR = 7;
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const NOTE_HEAD = "c".repeat(40);
const prUrl = `https://github.com/${REPO}/pull/${PR}`;

let mf: Miniflare;
let kb: (path: string, init?: RequestInit) => Promise<Response>;

beforeAll(() => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  if (!existsSync(bundle)) {
    throw new Error("bundle missing — run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle (the npm test script does this before vitest)");
  }
  mf = new Miniflare({
    workers: [{
      name: "main",
      scriptPath: bundle,
      modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")),
      modules: true,
      compatibilityDate: "2025-09-06",
      durableObjects: { KB: { className: "KnowledgeHub", useSQLite: true } },
    }],
  });
  return (async () => {
    const ns = await mf.getDurableObjectNamespace("KB");
    const stub = (await ns.get(ns.idFromName("global"))) as unknown as {
      fetch: (url: string, init?: RequestInit) => Promise<Response>;
    };
    kb = (path, init) => stub.fetch(`https://kb${path}`, init);
    await kb("/orient", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor: "test" }) });
  })();
});

afterAll(async () => {
  await mf?.dispose();
});

const post = async (path: string, body: Record<string, unknown>) =>
  kb(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor: "test", ...body }) });

const getOne = async (id: string) => {
  const r = await post("/get", { id });
  expect(r.status).toBe(200);
  return (await r.json()) as Record<string, any>;
};

const legs0 = (card: Record<string, any>) =>
  ((card.meta?.review_target as any)?.legs ?? []) as Array<Record<string, any>>;

const reviewOfferLegs0 = async (dutyId: string) => {
  const duty = await getOne(dutyId);
  return (((duty.meta?.review_offer as any)?.target as any)?.legs ?? []) as Array<Record<string, any>>;
};

/** A delivery task submitted for PR review (the first in_review binds OLD). */
const submittedPrTask = async () => {
  const created = await post("/create", { type: "task", title: "BR#20312 specimen: PR review after a rebase" });
  expect(created.status).toBe(200);
  const id = ((await created.json()) as any).id as string;
  expect((await post("/transition", { id, to: "in_progress", actor: "impl", session: "impl-s" })).status).toBe(200);
  const submitted = await post("/transition", { id, to: "in_review", actor: "impl", session: "impl-s",
    note: `${prUrl} head ${OLD}`, execution_result: { outcome: "PR opened and CI green.", receipts: [prUrl] } });
  const submittedBody = (await submitted.json()) as any;
  expect(submitted.status, JSON.stringify(submittedBody)).toBe(200);
  const duty = String(submittedBody.verify_task);
  expect(legs0(await getOne(id))[0]).toMatchObject({ repo: REPO, number: PR, head_sha_at_acceptance: OLD });
  expect((await reviewOfferLegs0(duty))[0]).toMatchObject({ head_sha_at_acceptance: OLD });
  return { id, duty };
};

describe("BR#20312: subject_revision on an in_review re-entry refreshes the submitted legs", () => {
  it("pins the new head into the parent legs AND the fresh verify duty's review_offer", async () => {
    const { id } = await submittedPrTask();
    expect((await post("/transition", { id, to: "in_progress", actor: "impl", session: "impl-s", note: "bounce: rebased onto a moved main — the round must review the new head" })).status).toBe(200);
    const re = await post("/transition", { id, to: "in_review", actor: "impl", session: "impl-s",
      note: `rebased onto moved main; re-entering review for ${prUrl}`, subject_revision: NEW });
    const reBody = (await re.json()) as any;
    expect(re.status, JSON.stringify(reBody)).toBe(200);
    // BR#19866 shape: the re-entry seeds a FRESH verify duty; its review_offer
    // must carry the submitted head, not the stale first-round binding.
    const fresh = String(reBody.verify_task);
    expect(fresh).not.toBe("");
    expect(legs0(await getOne(id))[0]).toMatchObject({ repo: REPO, number: PR, head_sha_at_acceptance: NEW });
    expect((await reviewOfferLegs0(fresh))[0]).toMatchObject({ repo: REPO, number: PR, head_sha_at_acceptance: NEW });
  });

  it("without subject_revision the re-entry keeps the pre-existing shape (headless PR note binds no head)", async () => {
    const { id } = await submittedPrTask();
    expect((await post("/transition", { id, to: "in_progress", actor: "impl", session: "impl-s", note: "bounce: rebased onto a moved main — the round must review the new head" })).status).toBe(200);
    const re = await post("/transition", { id, to: "in_review", actor: "impl", session: "impl-s",
      note: `re-entering review for ${prUrl}` });
    const reBody = (await re.json()) as any;
    expect(re.status, JSON.stringify(reBody)).toBe(200);
    // No subject_revision transport: the pin never fires — the pre-existing
    // behavior stands (a headless PR citation leaves the legs headless; the
    // gate stays lenient on heads for that legacy shape).
    const leg = legs0(await getOne(id))[0];
    expect(leg).toMatchObject({ repo: REPO, number: PR });
    expect(leg.head_sha_at_acceptance).toBeUndefined();
    expect((await reviewOfferLegs0(String(reBody.verify_task)))[0].head_sha_at_acceptance).toBeUndefined();
  });

  it("a note binding its own head wins over subject_revision", async () => {
    const { id } = await submittedPrTask();
    expect((await post("/transition", { id, to: "in_progress", actor: "impl", session: "impl-s", note: "bounce: rebased onto a moved main — the round must review the new head" })).status).toBe(200);
    const re = await post("/transition", { id, to: "in_review", actor: "impl", session: "impl-s",
      note: `${prUrl} head ${NOTE_HEAD}`, subject_revision: NEW });
    expect(re.status, JSON.stringify(await re.json())).toBe(200);
    expect(legs0(await getOne(id))[0]).toMatchObject({ head_sha_at_acceptance: NOTE_HEAD });
  });

  it("an accepted_pr verdict on the pinned head closes the parent — acceptance no longer structurally impossible", async () => {
    const { id } = await submittedPrTask();
    expect((await post("/transition", { id, to: "in_progress", actor: "impl", session: "impl-s", note: "bounce: rebased onto a moved main — the round must review the new head" })).status).toBe(200);
    const re = await post("/transition", { id, to: "in_review", actor: "impl", session: "impl-s",
      note: `rebased; re-entering review for ${prUrl}`, subject_revision: NEW });
    const reBody = (await re.json()) as any;
    expect(re.status).toBe(200);
    expect(legs0(await getOne(id))[0]).toMatchObject({ head_sha_at_acceptance: NEW });
    // The fresh round's offer carries the submitted head (the BR#19866 cure),
    // so the verifier reviews the head that was actually submitted.
    const fresh = String(reBody.verify_task);
    expect((await reviewOfferLegs0(fresh))[0]).toMatchObject({ head_sha_at_acceptance: NEW });
    const session = `fixture-reviewer-${crypto.randomUUID()}`;
    expect((await post("/transition", { id: fresh, to: "in_progress", actor: "verifier", session })).status).toBe(200);
    const close = await post("/transition", { id: fresh, to: "done", actor: "verifier", session,
      note: `${prUrl} head ${NEW} — zero substance findings`,
      review_result: await reviewOutcome(async (p, b) => post(p, b), fresh,
        { kind: "accepted_pr", task_id: id, legs: [{ repo: REPO, number: PR, head_sha_at_acceptance: NEW }] }) });
    expect(close.status, JSON.stringify(await close.json())).toBe(200);
    // The acceptance that was structurally impossible now applies: the hub
    // queues the accepted PR legs onto the merge train (plain-accept shape —
    // no train lane in this rig, so the queued car is the terminal state).
    const parent = await getOne(id);
    expect(parent.status).toBe("blocked");
    expect(String((parent.meta?.blocked as any)?.reason ?? "")).toContain("merge-train");
  });
});
