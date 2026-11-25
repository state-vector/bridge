import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownLegsCoverAwait } from "../src/kb/core";
import { completePrReview } from "./completion-fixture";

/**
 * BR#22657 — merged-park heal latency (from the BR#22622 diagnosis).
 *
 * The live defect (2026-11-25, BR#21252 + BR#22593 specimens): PR #4045
 * merged 21:41:16Z yet its parks sat 4m15s+ past the merge while the hub's
 * own sweeps ran on every alarm tick:
 *
 *  - BR#21252 (review-archive epic, completion=delivery, NO own PR legs)
 *    parked `await_event pr_merged 4045` — resumeMergedPrerequisites (the
 *    60s alarm leg) SKIPPED it because `mergeCompletesTask(meta)` was true,
 *    and only the 15-min-cadence unblockProxySweep healed it (the earlier
 *    #4040 leg took 2h02m the same way).
 *  - sweepMergedParks `if (!prov.size) return 0` returned SILENTLY — an
 *    empty provenance table with eligible car rows was invisible.
 *  - BR#22593 closed `merge_train.state=landed` 7.5s AFTER a
 *    stopped(checks_unconfirmed) stop — landed without CI proven green, and
 *    the label overstated certainty.
 *
 * Laws pinned here (each describe runs an isolated DO — the provenance
 * table is global per DO, so the gap law needs a clean instance):
 *   1. The mergeCompletesTask skip in resumeMergedPrerequisites applies
 *      ONLY to a card whose own delivery bindings (trainLegs / meta.pr /
 *      meta.prs / meta.review_pr) cover the awaited repo#pr — or that still
 *      carries ANY own train leg (the BR#4067 release-holds-train-queue
 *      gate owns that car's exit). A leg-less merge-completing park is a
 *      PREREQUISITE park: it resumes on the provenance receipt in the same
 *      sweep call, never left to unblockProxySweep.
 *   2. An empty provenance table with eligible car rows emits a
 *      `merged_park_provenance_empty` audit row (with the row count) and
 *      the sweep still returns 0 without throwing.
 *   3. closeAdmittedMergedCard landing while a leg's lane sits on a
 *      checks_unconfirmed stop stamps `ci_unproven: true` on the landed
 *      state (+ the merged_park_close_ci_unproven audit); a close without
 *      such a stop stamps nothing.
 */

const bundle = () => realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);

const makeEnv = () => {
  let mf: Miniflare | null = null;
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
  const start = async () => {
    if (!existsSync(bundle())) throw new Error("bundle missing — run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle (before vitest)");
    mf = new Miniflare({
      workers: [{
        name: "main",
        scriptPath: bundle(),
        modulesRoot: bundle().slice(0, bundle().lastIndexOf("/")),
        modules: true,
        compatibilityDate: "2025-09-25",
        durableObjects: { KB: { className: "KnowledgeHub", useSQLite: true } },
      }],
    });
    kbNs = await mf.getDurableObjectNamespace("KB");
    await kbJson("/orient", {});
  };
  const stop = async () => { await mf?.dispose(); };
  return { kbJson, start, stop };
};

const env = makeEnv();

const task = async (kb: typeof env.kbJson, title: string, meta?: Record<string, unknown>) => {
  const r = await kb("/create", { type: "task", title, qualified: true, ...(meta ? { meta } : {}) });
  expect(r.status).toBe(200);
  return String(r.body.id);
};

const get = async (kb: typeof env.kbJson, id: string) => (await kb("/get", { id })).body;
const historyText = async (kb: typeof env.kbJson, id: string) => {
  const hist = (await kb(`/history?id=${encodeURIComponent(id)}`)).body;
  return (hist?.versions ?? []).map((v: any) => `${v?.summary ?? ""}\n${v?.action ?? ""}`).join("\n");
};
const events = async (kb: typeof env.kbJson) => (((await kb("/events?since=0&limit=500")).body ?? {}).events ?? []) as any[];

/** A parked queued car: claimed, verify-accepted onto the train (the
 *  canonical park stamps merge_train.state=queued + the pr leg). */
const parkQueuedCar = async (kb: typeof env.kbJson, id: string, repo: string, n: number, actor: string, head: string) => {
  expect((await kb("/transition", { id, to: "in_progress", actor, note: "impl" })).status).toBe(200);
  const park = await kb("/transition", {
    id, to: "blocked", actor,
    note: `merge-train: queued — VERIFY ACCEPT (drill). PR ${repo}#${n} head ${head}.`,
    await_event: { event: "pr_merged", repo, n },
  });
  expect(park.status, `park failed: ${JSON.stringify(park.body)}`).toBe(200);
  await completePrReview(kb, id, [{ repo, number: n, head_sha_at_acceptance: head }]);
  const cur = await get(kb, id);
  expect(cur.meta?.merge_train?.state).toBe("queued");
  return cur;
};

/** A provenance merge receipt for (repo, n) via a train merged event. */
const stampProvenance = async (kb: typeof env.kbJson, repo: string, n: number, mergeSha: string, headSha: string, gw: string) => {
  await kb("/train.lane", { repo, base: "main", actor: "drill", spec: { required_workflows: ["Test"] } });
  const a = await kb("/train.lease", { repo, base: "main", action: "acquire", actor: gw });
  expect(a.body.error ?? "", `lease failed: ${JSON.stringify(a.body)}`).toBe("");
  const ev = await kb("/train.event", { repo, base: "main", kind: "merged", actor: gw, pr: n, merge_sha: mergeSha, head_sha: headSha });
  expect(ev.body.error ?? "", `train.event failed: ${JSON.stringify(ev.body)}`).toBe("");
};

/** A stopped(checks_unconfirmed) episode on the lane (lease still held by gw). */
const stopChecksUnconfirmed = async (kb: typeof env.kbJson, repo: string, sha: string, gw: string) => {
  const ev = await kb("/train.event", {
    repo, base: "main", kind: "stopped", actor: gw,
    head_sha: sha, stop_kind: "checks_unconfirmed",
    reason: "CI unknown past the fail-closed bound (~3× typical)",
  });
  expect(ev.body.error ?? "", `stopped event failed: ${JSON.stringify(ev.body)}`).toBe("");
};

const countReviewChildren = async (kb: typeof env.kbJson, id: string) => {
  const rel = (await kb("/relations", { id })).body.relations ?? [];
  const out: string[] = [];
  for (const r of rel) if (r.relation === "child_of" && r.dir === "in") out.push(String(r.artefact_id));
  let n = 0;
  for (const c of out) if (String((await get(kb, c))?.roles ?? "").includes("review")) n += 1;
  return n;
};

describe("BR#22657 leg 1 — own-leg binding: the pure predicate (core.ts)", () => {
  it("covers meta.prs, meta.pr and meta.review_pr for the awaited repo#pr", () => {
    expect(ownLegsCoverAwait({ prs: [{ repo: "o/r", number: 7 }] }, "o/r", 7)).toBe(true);
    expect(ownLegsCoverAwait({ pr: { repo: "o/r", number: 7 } }, "o/r", 7)).toBe(true);
    expect(ownLegsCoverAwait({ review_pr: { repo: "o/r", number: 7 } }, "o/r", 7)).toBe(true);
  });
  it("does NOT cover a foreign pr, other-repo legs, or a card with no own legs (the BR#21252 epic shape)", () => {
    expect(ownLegsCoverAwait({}, "o/r", 7)).toBe(false);
    expect(ownLegsCoverAwait({ completion: { kind: "delivery" } }, "o/r", 7)).toBe(false);
    expect(ownLegsCoverAwait({ prs: [{ repo: "o/r", number: 8 }] }, "o/r", 7)).toBe(false);
    expect(ownLegsCoverAwait({ prs: [{ repo: "other/r", number: 7 }] }, "o/r", 7)).toBe(false);
    expect(ownLegsCoverAwait({ review_pr: { repo: "o/r", number: 8 } }, "o/r", 7)).toBe(false);
  });
});

describe("BR#22657 leg 1 — a leg-less merge-completing park is a PREREQUISITE park: resumed in the same sweep call", () => {
  beforeAll(() => env.start());
  afterAll(() => env.stop());
  const kb = env.kbJson;

  it("blocked card, completion=delivery, NO own legs, await pr_merged + provenance row → todo with the prerequisite receipt (not unblockProxySweep)", async () => {
    const REPO = "state-vector/br22657-prereq";
    const N = 22657;
    const HEAD = "1".repeat(40);
    const SHA = "2".repeat(40);
    const id = await task(kb, "BR#22657 prerequisite-park specimen (the BR#21252 epic shape)", { completion: { kind: "delivery" } });
    expect((await kb("/transition", { id, to: "in_progress", actor: "epic-owner", note: "epic coordination" })).status).toBe(200);
    const park = await kb("/transition", {
      id, to: "blocked", actor: "epic-owner",
      note: "Waiting on the carrying PR to merge before slice 5 can start.",
      await_event: { event: "pr_merged", repo: REPO, n: N },
    });
    expect(park.status, `park failed: ${JSON.stringify(park.body)}`).toBe(200);
    await stampProvenance(kb, REPO, N, SHA, HEAD, "gw-br22657-a");

    // ONE alarm-sweep call — the 60s alarm leg must heal it, not the 15-min proxy sweep
    const sweep = await kb("/admin.alarm_sweep");
    expect(sweep.body.error ?? "").toBe("");

    const cur = await get(kb, id);
    expect(cur.status).toBe("todo");
    expect(cur.meta?.prerequisite_receipt).toMatchObject({ repo: REPO, pr: N, merge_sha: SHA });
    expect(cur.meta?.blocked?.await_event).toBeUndefined();
    expect(cur.status).not.toBe("done");
    expect(await countReviewChildren(kb, id)).toBe(0); // no verify duty spawned
    expect(await historyText(kb, id)).toContain(`Prerequisite ${REPO}#${N} merged`);
  });

  it("a card whose OWN leg covers the awaited pr is NOT prerequisite-resumed — the merged-park close owns it (no regression)", async () => {
    const REPO = "state-vector/br22657-ownleg";
    const N = 22658;
    const HEAD = "3".repeat(40);
    const SHA = "4".repeat(40);
    const id = await task(kb, "BR#22657 own-leg control specimen");
    await parkQueuedCar(kb, id, REPO, N, "drill-owner-b", HEAD);
    await stampProvenance(kb, REPO, N, SHA, HEAD, "gw-br22657-b");
    const sweep = await kb("/admin.alarm_sweep");
    expect(sweep.body.error ?? "").toBe("");
    const cur = await get(kb, id);
    // the train close path (reviewObservedMerge → carried admission), NOT a prerequisite resume
    expect(cur.status).toBe("done");
    expect(cur.meta?.merge_train?.state).toBe("landed");
    expect(cur.meta?.prerequisite_receipt).toBeUndefined();
  });

  it("a merge-completing card with foreign train legs is NOT prerequisite-resumed — the train owns its delivery exit (BR#4067)", async () => {
    const REPO = "state-vector/br22657-multileg";
    const N = 22659; // the awaited FOREIGN prerequisite
    const OWN = 22660; // the card's own delivery leg
    const SHA = "5".repeat(40);
    const HEAD = "6".repeat(40);
    const id = await task(kb, "BR#22657 foreign-leg specimen", { completion: { kind: "delivery" } });
    expect((await kb("/transition", { id, to: "in_progress", actor: "multi-owner", note: "impl" })).status).toBe(200);
    const stamped = await kb("/update", { id, meta: {
      prs: [{ repo: REPO, number: OWN, head_sha_at_acceptance: HEAD }],
      pr: { repo: REPO, number: OWN, head_sha_at_acceptance: HEAD },
      merge_train: { state: "queued", repo: REPO, pr: OWN, legs: { [OWN]: { state: "queued" } } },
    } });
    expect(stamped.status, JSON.stringify(stamped.body)).toBe(200);
    const park = await kb("/transition", {
      id, to: "blocked", actor: "multi-owner",
      note: "Waiting on the upstream prerequisite PR to merge.",
      await_event: { event: "pr_merged", repo: REPO, n: N },
    });
    expect(park.status, `park failed: ${JSON.stringify(park.body)}`).toBe(200);
    await stampProvenance(kb, REPO, N, SHA, HEAD, "gw-br22657-c");
    expect((await kb("/admin.alarm_sweep")).body.error ?? "").toBe("");

    // the queued car keeps its park and every own stamp — no machine
    // todo-release may destroy the queue slot (BR#4067), and no
    // prerequisite receipt may claim the exit the train owns
    const cur = await get(kb, id);
    expect(cur.status).toBe("blocked");
    expect(cur.meta?.prerequisite_receipt).toBeUndefined();
    expect(cur.meta?.prs).toEqual([expect.objectContaining({ repo: REPO, number: OWN })]);
    expect(cur.meta?.pr).toMatchObject({ repo: REPO, number: OWN });
    expect(cur.meta?.merge_train?.state).toBe("queued");
    expect(cur.meta?.merge_train?.legs?.[String(OWN)]).toMatchObject({ state: "queued" });
  });
});

describe("BR#22657 leg 2 — the provenance-gap no-op is audited, never silent (isolated DO: empty provenance)", () => {
  const env2 = makeEnv();
  beforeAll(() => env2.start());
  afterAll(() => env2.stop());
  const kb = env2.kbJson;

  it("eligible car row + empty provenance → merged_park_provenance_empty audit with the row count, sweep returns 0, no throw", async () => {
    const REPO = "state-vector/br22657-gap";
    const N = 22661;
    const HEAD = "7".repeat(40);
    const id = await task(kb, "BR#22657 provenance-gap specimen");
    await parkQueuedCar(kb, id, REPO, N, "gap-owner", HEAD); // eligible car row, NO provenance stamp

    // the sweep must name the gap, not return silently
    const sweep = await kb("/admin.alarm_sweep");
    expect(sweep.status).toBe(200); // no throw
    expect(sweep.body.error ?? "").toBe("");

    const gap = (await events(kb)).filter((e: any) => e.op === "merged_park_provenance_empty");
    expect(gap.length).toBeGreaterThanOrEqual(1);
    expect(gap[0].detail?.rows).toBeGreaterThanOrEqual(1);

    // no healing without receipts: the honest no-op stands
    const cur = await get(kb, id);
    expect(cur.status).toBe("blocked");
    expect(cur.meta?.merge_train?.state).toBe("queued");
  });
});

describe("BR#22657 leg 3 — landed after a checks_unconfirmed stop stamps ci_unproven", () => {
  const env3 = makeEnv();
  beforeAll(() => env3.start());
  afterAll(() => env3.stop());
  const kb = env3.kbJson;

  it("closeAdmittedMergedCard from a checks_unconfirmed-stop release stamps merge_train.ci_unproven + the audit", async () => {
    const REPO = "state-vector/br22657-unconfirmed";
    const N = 22662;
    const HEAD = "8".repeat(40);
    const SHA = "9".repeat(40);
    const id = await task(kb, "BR#22657 landed-after-unconfirmed specimen");
    await parkQueuedCar(kb, id, REPO, N, "uc-owner", HEAD);
    await stampProvenance(kb, REPO, N, SHA, HEAD, "gw-br22657-f");
    await stopChecksUnconfirmed(kb, REPO, HEAD, "gw-br22657-f"); // CI never proven green
    expect((await kb("/admin.alarm_sweep")).body.error ?? "").toBe("");

    const cur = await get(kb, id);
    expect(cur.status).toBe("done");
    expect(cur.meta?.merge_train?.state).toBe("landed");
    expect(cur.meta?.merge_train?.ci_unproven).toBe(true);
    expect((await events(kb)).some((e: any) => e.op === "merged_park_close_ci_unproven" && e.artefact_id === id)).toBe(true);
  });

  it("a merged-provenance close WITHOUT a checks_unconfirmed stop stamps nothing (no overlabel)", async () => {
    const REPO = "state-vector/br22657-confirmed";
    const N = 22663;
    const HEAD = "a".repeat(40);
    const SHA = "b".repeat(40);
    const id = await task(kb, "BR#22657 plain-landed control specimen");
    await parkQueuedCar(kb, id, REPO, N, "pl-owner", HEAD);
    await stampProvenance(kb, REPO, N, SHA, HEAD, "gw-br22657-g");
    expect((await kb("/admin.alarm_sweep")).body.error ?? "").toBe("");

    const cur = await get(kb, id);
    expect(cur.status).toBe("done");
    expect(cur.meta?.merge_train?.state).toBe("landed");
    expect(cur.meta?.merge_train?.ci_unproven).toBeUndefined();
    expect((await events(kb)).some((e: any) => e.op === "merged_park_close_ci_unproven" && e.artefact_id === id)).toBe(false);
  });
});
