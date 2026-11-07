import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * BR#6349 — the deep-link double-citation must never re-stamp the STALE head.
 *
 * Live episode (BR#6340 Phase B, BR#4684 / PR #309, 2026-11-04): a verify
 * accept note cited the PR twice — the canonical `/pull/309` URL plus a
 * `/pull/309/commits/<sha>` receipts deep-link (TRAIN_PR_URL_RE matches
 * both). trainParseNoteLegs minted TWO legs for one PR, the adjacency
 * pairing bound neither `head <sha>` token, and trainQueueOnAccept's
 * withStampHeads fallback folded BOTH legs back to the stale
 * meta.pr.head_sha_at_acceptance — the car re-queued at a head the verdict
 * did not cover, the coverage gate bounced it twice (13:59:11Z, 14:02:59Z),
 * and the lane livelocked until a manual re-park.
 *
 * Fix legs pinned here:
 *   1. parser (merge-train.test.ts pins the unit): duplicate citations
 *      collapse to ONE leg, so the single-PR lenient head binding applies
 *      again — drill 1 rides the FULL incident note through the real DO and
 *      expects the stamp to MOVE to the note's head.
 *   2. fail-closed re-queue: when a re-park note names a `head <sha>` that
 *      binds to NO stamped leg and the fold moved nothing, the card is
 *      merge_train=unbound (the BR#6330 typed phase) instead of silently
 *      folding the old stamp forward — the stale entry never rides the
 *      drain walk (drill 2). An honest no-op re-accept (head === a stamp
 *      leg's head) still queues (drill 3).
 */

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const OLD_B = "c".repeat(40);
const REPO = "state-vector/bridge";
const prUrl = (n: number) => `https://github.com/${REPO}/pull/${n}`;

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

/** A card already parked on the train with a single bound leg at `head`
 *  (the shape BR#4684 rode when the incident re-park folded it stale). */
const queuedSingle = async (title: string, n: number, head: string) => {
  const created = await post("/create", {
    type: "task",
    title,
    meta: {
      pr: { repo: REPO, number: n, head_sha_at_acceptance: head, base: "main" },
      prs: [{ repo: REPO, number: n, head_sha_at_acceptance: head, base: "main" }],
      merge_train: { state: "queued", pr: n, repo: REPO },
      blocked: { reason: "merge-train: queued" },
    },
  });
  expect(created.status).toBe(200);
  const id = ((await created.json()) as any).id as string;
  expect((await post("/transition", { id, to: "in_progress", note: "re-verify pickup" })).status).toBe(200);
  return id;
};

/** A card parked with TWO unlanded bound legs (the multi-leg stamp whose
 *  lone-head re-accept must stay fail-closed — BR#3659 kept that strictness;
 *  BR#6349 adds the loud unbound arm behind it). */
const queuedMulti = async (title: string, n1: number, head1: string, n2: number, head2: string) => {
  const created = await post("/create", {
    type: "task",
    title,
    meta: {
      pr: { repo: REPO, number: n1, head_sha_at_acceptance: head1, base: "main" },
      prs: [
        { repo: REPO, number: n1, head_sha_at_acceptance: head1, base: "main" },
        { repo: REPO, number: n2, head_sha_at_acceptance: head2, base: "main" },
      ],
      merge_train: { state: "queued", pr: n1, repo: REPO },
      blocked: { reason: "merge-train: queued" },
    },
  });
  expect(created.status).toBe(200);
  const id = ((await created.json()) as any).id as string;
  expect((await post("/transition", { id, to: "in_progress", note: "re-verify pickup" })).status).toBe(200);
  return id;
};

describe("BR#6349: the double-cited deep-link re-park stamps the note's head, never the stale fold", () => {
  it("drill 1 — the exact incident note (canonical URL + /pull/N/commits deep-link + head before the citations) re-stamps to the note's head", async () => {
    const id = await queuedSingle("BR#6349 incident-shape specimen", 30911, OLD);
    const note = [
      `merge-train: queued — VERIFY ACCEPT (duty drill, re-verified at the live head). head ${NEW}.`,
      `PR ${prUrl(30911)}`,
      `receipts: ${prUrl(30911)}/commits/${NEW}`,
    ].join("\n");
    const park = await post("/transition", {
      id, to: "blocked",
      note,
      await_event: { event: "pr_merged", repo: REPO, n: 30911 },
    });
    expect(park.status, `park failed: ${JSON.stringify(park.body)}`).toBe(200);
    expect((await getOne(id)).meta.pr.head_sha_at_acceptance).toBe(OLD);
    await completePrReview(post, id, [{ repo: REPO, number: 30911, head_sha_at_acceptance: NEW }]);
    const now = await getOne(id);
    expect(now.status).toBe("blocked");
    // the stamp MOVED — one deduped leg, bound by the lenient single-PR rule;
    // pre-fix this folded back to OLD and the coverage gate bounced it
    expect(now.meta?.prs?.length).toBe(1);
    expect(now.meta?.pr?.head_sha_at_acceptance).toBe(NEW);
    expect(now.meta?.prs?.[0]?.head_sha_at_acceptance).toBe(NEW);
    expect(now.meta?.merge_train?.state).toBe("queued");
    expect(now.meta?.merge_train?.unbound).toBeUndefined();
  });

  it("drill 2 — ambiguous prose cannot mutate either accepted head or its queue binding", async () => {
    const id = await queuedMulti("BR#6349 fail-closed specimen", 30912, OLD, 30913, OLD_B);
    const park = await post("/transition", {
      id, to: "blocked",
      note: `merge-train: queued — VERIFY ACCEPT (duty drill). head ${NEW}.`,
      await_event: { event: "pr_merged", repo: REPO, n: 30912 },
    });
    expect(park.status, `park failed: ${JSON.stringify(park.body)}`).toBe(200);
    const now = await getOne(id);
    expect(now.status).toBe("blocked");
    expect(now.meta?.merge_train?.state).toBe("queued");
    expect(now.meta?.merge_train?.note_head).toBeUndefined();
    expect(now.meta?.merge_train?.unbound).toBeUndefined();
    // the stamps were NOT folded forward — they still name the old heads
    expect(now.meta?.pr?.head_sha_at_acceptance).toBe(OLD);
    expect(now.meta?.prs?.[0]?.head_sha_at_acceptance).toBe(OLD);
    expect(now.meta?.prs?.[1]?.head_sha_at_acceptance).toBe(OLD_B);
  });

  it("drill 3 — an honest no-op re-accept (head === a stamped leg's head) still queues", async () => {
    const id = await queuedMulti("BR#6349 no-op re-accept specimen", 30914, OLD, 30915, OLD_B);
    const park = await post("/transition", {
      id, to: "blocked",
      note: `merge-train: queued — VERIFY ACCEPT (duty drill, re-confirmed at the stamped head). head ${OLD}.`,
      await_event: { event: "pr_merged", repo: REPO, n: 30914 },
    });
    expect(park.status, `park failed: ${JSON.stringify(park.body)}`).toBe(200);
    const now = await getOne(id);
    expect(now.status).toBe("blocked");
    expect(now.meta?.merge_train?.state).toBe("queued");
    expect(now.meta?.merge_train?.unbound).toBeUndefined();
    expect(now.meta?.pr?.head_sha_at_acceptance).toBe(OLD);
  });
});
import { completePrReview } from "./completion-fixture";
