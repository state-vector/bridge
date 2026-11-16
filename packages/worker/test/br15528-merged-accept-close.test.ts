import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { completePrReview } from "./completion-fixture";

/**
 * BR#15528 — the merge-train wedge class: the reconcile walk never reached
 * its already-merged stamp for tail entries (burst cap / mid-drain tip-red /
 * the awaiting-CI arm consume whole ticks — 12 merged PRs rode the queue 13+
 * hours with ZERO train_events rows), so every accepted verify round
 * re-queued its card onto the unstamped train (BR#14683: 11 accepted
 * admissions, zero rows) and looped.
 *
 * Fix A (executor): a merged-car pre-pass at the TOP of the lane tick stamps
 * already-merged queued cars on sight, ungated by phase/cap/verdict (Rust
 * side, train.rs tests).
 *
 * Fix B (hub, this file): the accept→re-queue path (queueAcceptedPrLegs) must
 * not re-park a card whose every leg already carries a merged train_events
 * row — the accepted verdict closes the card (merged-provenance terminal,
 * same close the BR#9510 head-law replay uses) instead of re-queuing a merge
 * that already happened. A merged PR's head is immutable (GitHub closes
 * merged PRs), so the ledger row is conclusive delivery even when the
 * head-law terminal cannot fire (the acceptance names a head the recorded
 * merged head does not cover).
 *
 * Pinned here:
 *   1. every leg merged in the ledger → done + landed, NO train_queued
 *      version row, no blocked re-park;
 *   2. one unmerged leg → the normal re-queue is byte-for-byte unchanged
 *      (blocked + state queued + the train_queued version row).
 */

const OLD2 = "1".repeat(40);
const NEW = "b".repeat(40);
const MERGE = "c".repeat(40);
const REPO = "state-vector/superpositional";

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

const getVersions = async (id: string) => {
  const r = await kb(`/history?id=${encodeURIComponent(id)}`);
  expect(r.status).toBe(200);
  return (((await r.json()) as any).versions ?? []) as Array<Record<string, any>>;
};

/** A task stamped with the given PR legs, picked up, then parked on the train
 *  (the live accept shape: the admission replay only drives blocked/queued
 *  or bounce-fresh parents). */
const pickupCard = async (title: string, legs: { number: number; head: string }[]) => {
  const created = await post("/create", {
    type: "task",
    title,
    meta: {
      pr: { repo: REPO, number: legs[0].number, head_sha_at_acceptance: legs[0].head, base: "main" },
      prs: legs.map((l) => ({ repo: REPO, number: l.number, head_sha_at_acceptance: l.head, base: "main" })),
      merge_train: { state: "queued", pr: legs[0].number, repo: REPO, at: Date.now() },
    },
  });
  expect(created.status).toBe(200);
  const id = ((await created.json()) as any).id as string;
  expect((await post("/transition", { id, to: "in_progress", note: "fresh verify pickup over the stale stamp" })).status).toBe(200);
  const park = await post("/transition", {
    id, to: "blocked",
    note: `merge-train: queued — VERIFY ACCEPT (duty fixture, BR#15528 rig). PRs ${legs.map((l) => `${REPO}#${l.number} head ${l.head}`).join("; ")}.`,
    await_event: { event: "pr_merged", repo: REPO, n: legs[0].number },
  });
  expect(park.status).toBe(200);
  expect((await getOne(id)).status).toBe("blocked");
  return id;
};

/** The lane + live lease + one merged ledger row (the pre-pass's stamp). */
const stampMergedRow = async (number: number, mergeSha: string, headSha: string) => {
  expect((await post("/train.lane", { repo: REPO, base: "main", actor: "fixture-gw", spec: { required_workflows: ["Test"] } })).status).toBe(200);
  expect((await post("/train.lease", { repo: REPO, base: "main", action: "acquire", actor: "fixture-gw" })).status).toBe(200);
  const r = await post("/train.event", { repo: REPO, base: "main", kind: "merged", actor: "fixture-gw", pr: number, merge_sha: mergeSha, head_sha: headSha });
  const body = (await r.json()) as any;
  expect(body.error ?? "", `train.event failed: ${JSON.stringify(body)}`).toBe("");
};

describe("BR#15528: an accepted verdict on a fully-merged card closes it instead of re-queuing", () => {
  it("every leg merged in the ledger → terminal close (done + landed), no re-queue", async () => {
    const id = await pickupCard("BR#15528 fully-merged accept specimen", [{ number: 33401, head: NEW }]);
    // The ledger row's merged head is one the acceptance does NOT cover —
    // exactly the shape the BR#9510 head-law terminal must refuse (it stays
    // first), and exactly the shape the ledger row still settles: a merged
    // PR is closed on GitHub, nothing else can ever land there.
    await stampMergedRow(33401, MERGE, OLD2);
    await completePrReview(post, id, [{ repo: REPO, number: 33401, head_sha_at_acceptance: NEW }]);
    const now = await getOne(id);
    expect(now.status).toBe("done");
    expect(now.meta?.merge_train?.state).toBe("landed");
    const versions = await getVersions(id);
    expect(versions.some((v) => v.action === "train_queued"), "no re-queue after the terminal close").toBe(false);
    expect(versions.some((v) => v.action === "merged_admission_closed"), "the terminal close is on the trail").toBe(true);
  });

  it("one unmerged leg → the normal re-queue is unchanged", async () => {
    const id = await pickupCard("BR#15528 half-merged accept specimen", [
      { number: 33402, head: NEW },
      { number: 33403, head: NEW },
    ]);
    await stampMergedRow(33402, MERGE, NEW);
    await completePrReview(post, id, [
      { repo: REPO, number: 33402, head_sha_at_acceptance: NEW },
      { repo: REPO, number: 33403, head_sha_at_acceptance: NEW },
    ]);
    const now = await getOne(id);
    expect(now.status).toBe("blocked");
    expect(now.meta?.merge_train?.state).toBe("queued");
    expect(now.meta?.pr?.head_sha_at_acceptance).toBe(NEW);
    const versions = await getVersions(id);
    expect(versions.some((v) => v.action === "train_queued"), "the normal re-queue still fires").toBe(true);
    expect(versions.some((v) => v.action === "merged_admission_closed")).toBe(false);
  });
});
