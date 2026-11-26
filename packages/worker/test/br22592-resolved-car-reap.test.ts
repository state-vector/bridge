import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRAIN_RECEIPT_SETTLE_WINDOW_MS, trainLegResolved, trainLegsUnresolved } from "../src/kb/core.ts";
import { completePrReview } from "./completion-fixture";

/**
 * BR#22592 — the reap: resolved cars never hold the line.
 *
 * The 2026-11-26 superpositional wedge: all four queued cars were RESOLVED
 * (one receipted-awaiting-ci since Nov 22 — merge stamped, the settle that
 * promotes it never came because an all-resolved line never lands again;
 * three live-closed PRs) and every layer deferred: the executor's parked
 * filter assumed "the pass settle owns it", the hub's lane filter kept the
 * cars queue-visible (the observed∧ledgered drop needed a delivery
 * observation the retained cards never produced), and the starvation alarm
 * had no pickup SLA for the duty it filed. Starved 144 minutes with a
 * 4-deep queue of dead weight.
 *
 * Legs pinned here (hub side; the executor walk legs are Rust-side):
 *   1. derived queue: a receipt-settled car (awaiting-ci + merge receipt
 *      past TRAIN_RECEIPT_SETTLE_WINDOW_MS) is REAPED — trainLegsUnresolved
 *      drops it, the lane advances to the live candidate;
 *   2. the walk's dead_leg bounce: a live CLOSED-unmerged leg is stamped
 *      terminal dead — an unprotected card flips to the repair pool (todo),
 *      a protected card (interactive execution) keeps its exit and its wait,
 *      and a re-report dedupes (the BR#4688 bounce budget never feeds on
 *      reap re-reports);
 *   3. merged dedupe promotes the orphaned awaiting-ci leg stamp to terminal
 *      landed — the receipt is FACT even when the card's close is retained;
 *   4. the starve pickup SLA exists in the alarm cadence's starvation tick
 *      (source pin — the real clock cannot age an episode inside a test).
 */

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

const laneQueueIds = async (repo: string, base = "main"): Promise<string[]> => {
  const st = await post("/train.status", { repo });
  expect(st.status).toBe(200);
  const lanes = ((await st.json()) as any).lanes as any[];
  const lane = lanes.find((l) => l.lane === `${repo}@${base}`);
  return (lane?.queue ?? []).map((q: any) => String(q.id));
};

/** A healthy lane with a live lease (the executor walk's preconditions). */
const healthyLane = async (repo: string, gw: string): Promise<void> => {
  const lane = await post("/train.lane", { repo, base: "main", actor: "drill", spec: { required_workflows: ["Test"] } });
  const laneBody = (await lane.json()) as any;
  expect(laneBody.error ?? "").toBe("");
  const a = await post("/train.lease", { repo, base: "main", action: "acquire", actor: gw });
  const aBody = (await a.json()) as any;
  expect(aBody.error ?? "", `lease failed: ${JSON.stringify(aBody)}`).toBe("");
};

/** The queued-car fixture: create → claim → park merge-train → accept review
 *  (the exact shape the executor walks — meta.merge_train.state "queued"). */
const queuedCar = async (title: string, repo: string, pr: number, extraMeta: Record<string, unknown> = {}): Promise<string> => {
  const created = await post("/create", {
    type: "task",
    title,
    meta: {
      pr: { repo, number: pr, head_sha_at_acceptance: NEW, base: "main" },
      merge_train: { state: "queued", pr, repo, at: Date.now() },
      ...extraMeta,
    },
  });
  expect(created.status).toBe(200);
  const id = ((await created.json()) as any).id as string;
  expect((await post("/transition", { id, to: "in_progress", note: "impl" })).status).toBe(200);
  const park = await post("/transition", {
    id, to: "blocked",
    note: `merge-train: queued — VERIFY ACCEPT (drill). PR ${repo}#${pr} head ${NEW}.`,
    await_event: { event: "pr_merged", repo, n: pr },
  });
  expect(park.status, `park failed: ${JSON.stringify(await park.json())}`).toBe(200);
  await completePrReview(post, id, [{ repo, number: pr, head_sha_at_acceptance: NEW }]);
  expect((await getOne(id)).meta?.merge_train?.state).toBe("queued");
  return id;
};

describe("BR#22592 leg 1 — the resolved-LEG law (units)", () => {
  it("trainLegResolved: landed | receipt-settled past the window | dead — never a fresh park", () => {
    const now = Date.now();
    const leg = { repo: REPO, number: 500, base: "main" };
    // fresh awaiting-ci park — the BR#4934 settle owns it, NOT resolved
    const fresh = { merge_train: { state: "awaiting-ci", pr: 500, legs: { "500": { state: "awaiting-ci", merge_sha: MERGE, merged_at: now - 60_000 } } } };
    expect(trainLegResolved(fresh, leg, now)).toBe(false);
    // orphaned receipt past the window — the merge is FACT, resolved
    const stale = { merge_train: { state: "awaiting-ci", pr: 500, legs: { "500": { state: "awaiting-ci", merge_sha: MERGE, merged_at: now - TRAIN_RECEIPT_SETTLE_WINDOW_MS - 1_000 } } } };
    expect(trainLegResolved(stale, leg, now)).toBe(true);
    // receipt younger than the window but at the CARD level (no leg map) resolves too
    const cardLevel = { merge_train: { state: "awaiting-ci", pr: 500, merge_sha: MERGE, merged_at: now - TRAIN_RECEIPT_SETTLE_WINDOW_MS - 60_000 } };
    expect(trainLegResolved(cardLevel, leg, now)).toBe(true);
    // terminal dead stamp (the walk's closed-unmerged report)
    const dead = { merge_train: { state: "queued", pr: 500, legs: { "500": { state: "dead", at: now } } } };
    expect(trainLegResolved(dead, leg, now)).toBe(true);
    // landed keeps its strict meaning
    const landed = { merge_train: { state: "landed", pr: 500 } };
    expect(trainLegResolved(landed, leg, now)).toBe(true);
    // queued without any receipt — never resolved
    const queued = { pr: { repo: REPO, number: 500, base: "main" }, merge_train: { state: "queued", pr: 500 } };
    expect(trainLegResolved(queued, leg, now)).toBe(false);
    expect(trainLegsUnresolved(stale, REPO, "main", now)).toEqual([]);
    expect(trainLegsUnresolved(queued, REPO, "main", now).map((l) => l.number)).toEqual([500]);
  });
});

describe("BR#22592 legs 1-3 — the reap (integration)", () => {
  it("the derived queue REAPS a receipt-settled car — the line advances to the live candidate", async () => {
    const REPO_A = "state-vector/reap-receipt";
    await healthyLane(REPO_A, "fixture-gw");
    // the wedge car: queued, merged event stamped awaiting-ci, receipt now
    // orphaned 20 min (past the 15-min settle window) — the BR#18567 shape
    const wedged = await queuedCar("BR#22592 receipt-settled wedge car", REPO_A, 500);
    const merged = await post("/train.event", { repo: REPO_A, base: "main", kind: "merged", actor: "fixture-gw", pr: 500, merge_sha: MERGE, head_sha: NEW, task_id: wedged });
    expect(((await merged.json()) as any).error ?? "").toBe("");
    const backdated = Date.now() - TRAIN_RECEIPT_SETTLE_WINDOW_MS - 60_000;
    const card = await getOne(wedged);
    const mt = card.meta.merge_train;
    expect(mt.legs?.["500"]?.state).toBe("awaiting-ci");
    const up = await post("/update", { id: wedged, meta: { merge_train: { ...mt, at: backdated, merged_at: backdated, legs: { "500": { ...mt.legs["500"], merged_at: backdated } } } } });
    expect(up.status).toBe(200);
    // a receipt-settled car must be reaped from the derived queue — holding
    // it queue-visible IS the wedge
    expect((await laneQueueIds(REPO_A)).filter((id) => id === wedged)).toEqual([]);
    // and the line still admits a live candidate behind it
    const live = await queuedCar("BR#22592 live candidate behind the wedge", REPO_A, 501);
    expect((await laneQueueIds(REPO_A))).toContain(live);
  });

  it("a dead_leg bounce stamps the leg terminal dead and flips the unprotected card to the repair pool", async () => {
    const REPO_B = "state-vector/reap-dead";
    await healthyLane(REPO_B, "fixture-gw");
    const car = await queuedCar("BR#22592 dead-leg car (unprotected)", REPO_B, 600);
    expect((await laneQueueIds(REPO_B))).toContain(car);
    const ev = await post("/train.event", {
      repo: REPO_B, base: "main", kind: "bounced", actor: "fixture-gw", pr: 600, task_id: car,
      bounce_kind: "gate", dead_leg: true, live_state: "CLOSED",
      reason: `PR #600 is CLOSED without merging (live GitHub state) — the leg can never land on this lane (BR#22592); re-deliver: reopen the PR or open a fresh one, re-verify, re-queue`,
    });
    const body = (await ev.json()) as any;
    expect(body.error ?? "", `dead-leg bounce failed: ${JSON.stringify(body)}`).toBe("");
    expect(body.bounce_kind).toBe("gate");
    const after = await getOne(car);
    expect(after.meta?.merge_train?.legs?.["600"]?.state).toBe("dead");
    expect(String(after.status)).toBe("todo");
    expect((await laneQueueIds(REPO_B)).filter((id) => id === car)).toEqual([]);
    // the re-report dedupes: an ack, never a second flip or a fresh bounce row
    const again = await post("/train.event", {
      repo: REPO_B, base: "main", kind: "bounced", actor: "fixture-gw", pr: 600, task_id: car,
      bounce_kind: "gate", dead_leg: true, live_state: "CLOSED", reason: "re-report",
    });
    expect(((await again.json()) as any).deduped).toBe(true);
  });

  it("a dead_leg bounce on a PROTECTED card stamps dead and retains the exit — the bound wait is never yanked", async () => {
    const REPO_C = "state-vector/reap-dead-held";
    await healthyLane(REPO_C, "fixture-gw");
    const car = await queuedCar("BR#22592 dead-leg car (foreign wait)", REPO_C, 700);
    // the foreign typed wait arrives after the park (the BR#22079 shape: a
    // run_success bound wait with a named unblock condition owns the exit)
    expect((await post("/transition", { id: car, to: "in_progress", note: "resume for the re-bind" })).status).toBe(200);
    const repark = await post("/transition", {
      id: car, to: "blocked",
      note: `merge-train: queued — bound to the decisive deploy run; PR ${REPO_C}#700 head ${NEW}.`,
      await_event: { event: "run_success", repo: REPO_C, run_id: "45603249558", head: NEW },
    });
    expect(repark.status, `re-park failed: ${JSON.stringify(await repark.json())}`).toBe(200);
    const ev = await post("/train.event", {
      repo: REPO_C, base: "main", kind: "bounced", actor: "fixture-gw", pr: 700, task_id: car,
      bounce_kind: "gate", dead_leg: true, live_state: "CLOSED", reason: "PR #700 CLOSED unmerged (BR#22592)",
    });
    const body = (await ev.json()) as any;
    expect(body.error ?? "").toBe("");
    expect(body.retained).toBe(true);
    const after = await getOne(car);
    expect(after.meta?.merge_train?.legs?.["700"]?.state).toBe("dead");
    expect(String(after.status)).toBe("blocked");
    expect(after.meta?.blocked?.await_event?.event).toBe("run_success");
    // reaped from the queue even though the card keeps its owner
    expect((await laneQueueIds(REPO_C)).filter((id) => id === car)).toEqual([]);
  });

  it("a dead_leg report for a PR that is not the card's leg is refused, never stamped", async () => {
    const REPO_D = "state-vector/reap-dead-foreign";
    await healthyLane(REPO_D, "fixture-gw");
    const car = await queuedCar("BR#22592 foreign dead-leg probe", REPO_D, 800);
    const ev = await post("/train.event", {
      repo: REPO_D, base: "main", kind: "bounced", actor: "fixture-gw", pr: 999, task_id: car,
      bounce_kind: "gate", dead_leg: true, live_state: "CLOSED", reason: "not this card's leg",
    });
    const body = (await ev.json()) as any;
    expect(body.refused).toBe(true);
    const after = await getOne(car);
    expect(after.meta?.merge_train?.legs?.["999"] ?? {}).toEqual({});
    expect(String(after.status)).toBe("blocked");
  });

  it("the derived queue reaps a CLOSED-observed leg from the board's own reconcile feed — queue correctness never waits for an executor binary", async () => {
    const REPO_F = "state-vector/reap-closed-observed";
    await healthyLane(REPO_F, "fixture-gw");
    // two queued cars: one whose PR the board observed CLOSED-unmerged (the
    // 2026-11-26 live shape: 4019/3939 closed on GitHub, invisible to the
    // open+merged feeds, no dead-leg stamp because the walk binary predates
    // BR#22592), one whose PR is observed OPEN (the live control)
    const deadCar = await queuedCar("BR#22592 closed-observed car", REPO_F, 610);
    const liveCar = await queuedCar("BR#22592 open control car", REPO_F, 611);
    expect((await laneQueueIds(REPO_F)).join(",")).toBe(`${deadCar},${liveCar}`);
    // one daemon observation cycle carrying the CLOSED-unmerged receipt
    // (reconcile.report validates CLOSED rows: no mergeCommit, gh receipts)
    const rep = await post("/reconcile.report", {
      repo: REPO_F, actor: "fixture-gw",
      prs: [
        { number: 610, state: "CLOSED", title: "closed unmerged", updatedAt: new Date().toISOString() },
        { number: 611, state: "OPEN", title: "still live", updatedAt: new Date().toISOString() },
      ],
    });
    expect(rep.status, `reconcile.report failed: ${JSON.stringify(await rep.json()).slice(0, 300)}`).toBe(200);
    const queueIds = await laneQueueIds(REPO_F);
    // the card's own disposition stays with the probe/walk paths — the QUEUE
    // is what reaps: a closed leg cannot drive a merge. A CLOSED-observed
    // unmerged leg must be reaped from the derived queue — the line must not
    // wait for an executor binary to learn a PR the board itself observed
    // closed.
    expect(queueIds).toEqual([liveCar]);
  });

  it("merged dedupe promotes the orphaned awaiting-ci leg to terminal landed — the receipt is FACT", async () => {
    const REPO_E = "state-vector/reap-promote";
    await healthyLane(REPO_E, "fixture-gw");
    const car = await queuedCar("BR#22592 promotion car", REPO_E, 900);
    const first = await post("/train.event", { repo: REPO_E, base: "main", kind: "merged", actor: "fixture-gw", pr: 900, merge_sha: MERGE, head_sha: NEW, task_id: car });
    expect(((await first.json()) as any).error ?? "").toBe("");
    expect((await getOne(car)).meta?.merge_train?.legs?.["900"]?.state).toBe("awaiting-ci");
    // the executor walk's receipt reconcile re-fires the identical event
    const replay = await post("/train.event", { repo: REPO_E, base: "main", kind: "merged", actor: "fixture-gw", pr: 900, merge_sha: MERGE, head_sha: NEW, task_id: car });
    const rb = (await replay.json()) as any;
    expect(rb.deduped).toBe(true);
    // the dedupe must promote the leg stamp to terminal landed — the settle
    // that should have done it never came
    expect((await getOne(car)).meta?.merge_train?.legs?.["900"]?.state).toBe("landed");
    expect((await laneQueueIds(REPO_E)).filter((id) => id === car)).toEqual([]);
  });
});

describe("BR#22592 leg 4 — the starve pickup SLA (source pin; the real clock cannot age an episode in-test)", () => {
  it("the starvation tick carries the pickup SLA: budget setting, re-boost, one-per-episode sink alarm", async () => {
    const { readFileSync } = await import("node:fs");
    // cwd-relative (vitest runs from packages/worker) — new URL's type here
    // collides with miniflare's bundled undici URL under tsc
    const src = readFileSync("src/kb/do.ts", "utf8");
    // the SLA lives in the starvation tick's EXISTING-episode path (the
    // init path just filed the duty; the tick that finds it unclaimed owns
    // the bound) — not in the init arm, which has no age to judge
    const tickAt = src.indexOf("private async laneStarvationTick(");
    expect(tickAt).toBeGreaterThan(-1);
    const nextFn = src.indexOf("\n  private async ", tickAt + 10);
    const tick = src.slice(tickAt, nextFn === -1 ? undefined : nextFn);
    expect(tick).toContain("train.starve_pickup_budget_min");
    expect(tick).toContain("train:starve_pickup_alarm");
    expect(tick).toContain("pickup_alarm");
    // the alarm names the duty for dispatch (executor coordination, not a
    // human decision — the duty is agent-executable work)
    expect(tick).toContain("executor_coordination");
    expect(tick).toContain("train_alarm_sink_id");
    // the duty is re-boosted before the alarm (BR#4068: one mechanical leg
    // from un-wedging the lane is the board's hottest work)
    expect(tick).toContain("via: \"train:starve_pickup_sla\"");
    // and the default budget constant exists with the clamp bounds
    expect(src).toContain("TRAIN_STARVE_PICKUP_BUDGET_MIN_DEFAULT = 20");
  });
});
