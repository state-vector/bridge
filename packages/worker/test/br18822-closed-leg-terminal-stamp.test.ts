import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { completePrReview } from "./completion-fixture";

/**
 * BR#18822 (specimen BR#17666) — the terminal merged-provenance stamp must
 * not resurrect a CLOSED-unmerged leg the queue path just filtered.
 *
 * The incident: a reconcile replacement-delivery card (superseded PR #3500
 * closed unmerged with a receipt; the work re-delivered on four merged PRs)
 * kept the dead leg in meta.prs (headless, no merge receipt — none is ever
 * possible). queueAcceptedPrLegs filters closed-receipt legs from its LOCAL
 * leg set, so the admission replay reached closeAdmittedMergedCard — whose
 * stamp seeds `known` from the card's own trainLegs(meta) and thereby wrote
 * the dead leg straight back into meta.prs on every pass. The
 * acceptance-qualify gate reads meta.prs too: trainLegs(meta).every(
 * trainLegLanded) stayed false forever, the accepted_pr branch never fired,
 * and the BR#9510 replay/sweep retried the refused terminal close every
 * sweep (~1 merged_admission_close_refused/min for hours; breach card
 * BR#18822 coalesced the fold).
 *
 * Pinned here:
 *   1. a card stamped [closed-unmerged leg (no head), merged leg (head)]
 *      with an accepted_pr verdict on the merged leg closes done;
 *   2. the closed leg is OUT of meta.prs afterwards (the stamp obeys the
 *      closure-receipt law);
 *   3. NO merged_admission_close_refused on the trail — the loop is dead.
 */

const NEW = "b".repeat(40);
const MERGE = "c".repeat(40);
const REPO = "state-vector/superpositional";
const DEAD = 33421;
const LIVE = 33422;

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

/** The incident shape: the superseded leg is stamped headless FIRST in
 *  meta.prs; only the replacement leg carries an acceptance head. */
const pickupCard = async (title: string) => {
  const created = await post("/create", {
    type: "task",
    title,
    meta: {
      pr: { repo: REPO, number: LIVE, head_sha_at_acceptance: NEW, base: "main" },
      prs: [
        { repo: REPO, number: DEAD },
        { repo: REPO, number: LIVE, head_sha_at_acceptance: NEW, base: "main" },
      ],
      merge_train: { state: "queued", pr: LIVE, repo: REPO, at: Date.now() },
    },
  });
  expect(created.status).toBe(200);
  const id = ((await created.json()) as any).id as string;
  expect((await post("/transition", { id, to: "in_progress", note: "replacement delivery pickup" })).status).toBe(200);
  const park = await post("/transition", {
    id, to: "blocked",
    note: `merge-train: queued — replacement delivery. Live leg ${REPO}#${LIVE} head ${NEW}; superseded ${REPO}#${DEAD} closed unmerged with a receipt.`,
    await_event: { event: "pr_merged", repo: REPO, n: LIVE },
  });
  expect(park.status).toBe(200);
  expect((await getOne(id)).status).toBe("blocked");
  return id;
};

/** The lane + live lease + the merged ledger row for the LIVE leg. */
const stampMergedRow = async (number: number, mergeSha: string, headSha: string) => {
  expect((await post("/train.lane", { repo: REPO, base: "main", actor: "fixture-gw", spec: { required_workflows: ["Test"] } })).status).toBe(200);
  expect((await post("/train.lease", { repo: REPO, base: "main", action: "acquire", actor: "fixture-gw" })).status).toBe(200);
  const r = await post("/train.event", { repo: REPO, base: "main", kind: "merged", actor: "fixture-gw", pr: number, merge_sha: mergeSha, head_sha: headSha });
  const body = (await r.json()) as any;
  expect(body.error ?? "", `train.event failed: ${JSON.stringify(body)}`).toBe("");
};

describe("BR#18822: a closed-unmerged leg never blocks the terminal close of its merged siblings", () => {
  it("stamps only receipt-carrying legs and closes done without a refusal storm", async () => {
    // The superseded leg's durable CLOSED observation (reconcile feed — the
    // same receipt closedPrReceipt reads when the queue path filters it).
    const rec = await post("/reconcile.report", {
      repo: REPO,
      prs: [{ number: DEAD, state: "CLOSED", title: "superseded — closed unmerged with receipt" }],
    });
    expect(rec.status, `reconcile.report: ${await rec.text()}`).toBe(200);

    const id = await pickupCard("BR#18822 closed-leg terminal stamp specimen");
    await stampMergedRow(LIVE, MERGE, NEW);
    await completePrReview(post, id, [{ repo: REPO, number: LIVE, head_sha_at_acceptance: NEW }]);

    const now = await getOne(id);
    expect(now.status, `card must close on the merged-provenance terminal; got meta: ${JSON.stringify(now.meta?.merge_train ?? {})}`).toBe("done");
    expect(now.meta?.merge_train?.state).toBe("landed");
    const stampedLegs = (now.meta?.prs ?? []).map((l: any) => Number(l?.number));
    expect(stampedLegs, "the closed-unmerged leg must be OUT of the terminal stamp").not.toContain(DEAD);
    expect(stampedLegs).toContain(LIVE);
    const versions = await getVersions(id);
    expect(versions.some((v) => v.action === "merged_admission_close_refused"),
      "the terminal close must pass the acceptance-qualify gate first try — no refusal storm")
      .toBe(false);
    expect(versions.some((v) => v.action === "merged_admission_closed"), "the terminal close is on the trail").toBe(true);
    expect(versions.some((v) => v.action === "train_queued"), "no re-queue after the terminal close").toBe(false);
  });
});
