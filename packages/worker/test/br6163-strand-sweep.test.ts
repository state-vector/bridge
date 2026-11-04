import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * BR#6163 — bounce-release strands train-parked cards.
 *
 * Defect: a card that left the merge queue while carrying a train-only wait
 * (pr_merged / pr_checks_green) can never have that wait satisfied by
 * anything a pool executor does — the wait fires from lane train_events and
 * the card is in no lane's queue. BR#5522 (PR #2734) starved 38h under a
 * healthy train (24 merges/24h) in exactly this shape: a verify bounce of a
 * dead-owner card released it to the pool with the train park still on it.
 *
 * Fix, three legs (all pinned here):
 *   1. the ghost bounce-release stamps bounce_released.train_only_await
 *      evidence (read from the card's stored park pre-write);
 *   2. sweepStrandedTrainCards (alarm cadence) RE-BOARDS an out-of-queue
 *      train-only-await car ONCE per episode — in-place reason-prefix repair
 *      for blocked parks, a legal blocked transition (machine-managed park
 *      flag keeps the queue hook off) for released cards — pinned by
 *      meta.strand_reboard;
 *   3. unbound_in_queue cars (fail-closed legless parks) are ALARM-only —
 *      a machine re-queue would re-stamp unbound — one ask per card-episode
 *      (24h strand_alarm dedupe + askCreate's identical-open-ask guard) to
 *      the train alarm sink.
 * Excluded from the strand class: Awaiting parks (BR#5633's sweep), bounced
 * re-entry (BR#4494's demote), and cards holding a bound ask.
 */

const HOUR = 3_600_000;

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

const acquire = (repo: string, actor: string, extra: Record<string, unknown> = {}) =>
  kbJson("/train.lease", { repo, base: "main", action: "acquire", actor, ...extra });

/** A lane card for the repo + a LIVE lease + one merged event NOW — the
 *  healthy-lane proof (the train moved after any 3h-ago park). */
async function healthyLane(repo: string, gw: string): Promise<void> {
  const lane = await kbJson("/train.lane", { repo, base: "main", actor: "drill" });
  expect(lane.body.error ?? "").toBe("");
  const a = await acquire(repo, gw);
  expect(a.body.error ?? "").toBe("");
  const ev = await kbJson("/train.event", {
    repo, base: "main", kind: "merged", actor: gw, pr: 1, merge_sha: "d".repeat(40),
  });
  expect(ev.body.error ?? "", `train.event failed: ${JSON.stringify(ev.body)}`).toBe("");
}

/** Asks bound to the drill sink whose question names `names` (per-card). */
const sinkQuestions = async (names: string) =>
  ((await kbJson("/list", { type: "question", limit: 200 })).body?.artefacts ?? []).filter(
    (q: any) =>
      q.meta?.ask?.artefact_id === String((globalThis as any).__sinkId) &&
      String(q.title).includes(names),
  );

const task = async (title: string) => {
  const r = await kbJson("/create", { type: "task", title });
  expect(r.status).toBe(200);
  return String(r.body.id);
};

beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  if (!existsSync(bundle)) {
    throw new Error("bundle missing — run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle (before vitest)");
  }
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
  // the standing alarm sink (train_alarm_sink_id → a real task, BR#5916 shape)
  const sinkId = await task("BR#6163 strand alarm sink drill");
  (globalThis as any).__sinkId = sinkId;
  const set = await kbJson("/admin.settings_set", { settings: { train_alarm_sink_id: sinkId } });
  expect(set.body.error ?? "").toBe("");
});

afterAll(async () => {
  await mf?.dispose();
});

describe("BR#6163: bounce-release strand — evidence, re-board, alarm, exclusion", () => {
  it("leg 1 — the ghost bounce-release of a dead-owner card stamps train_only_await evidence from its stored park", async () => {
    const REPO = "state-vector/strand-release";
    const HEAD = "a".repeat(40);
    const id = await task("BR#6163 ghost strand specimen");
    // claim as a dead owner (a label with no auth_token — dead by construction)
    expect((await kbJson("/transition", { id, to: "in_progress", actor: "ghost-owner-br6163", note: "impl" })).status).toBe(200);
    // park on the queue with a typed train-only wait (the accept-park shape)
    const park = await kbJson("/transition", {
      id, to: "blocked", actor: "ghost-owner-br6163",
      note: `merge-train: queued — VERIFY ACCEPT. PR ${REPO}#2734 head ${HEAD}.`,
      await_event: { event: "pr_merged", repo: REPO, n: 2734 },
    });
    expect(park.status, `park failed: ${JSON.stringify(park.body)}`).toBe(200);
    // hand to review through the legal edges, as the owner (a handoff to
    // another actor would re-claim the card). The unblock leg drops the park
    // record (production shape: the stored meta NO LONGER carries the wait by
    // the time the card sits in review).
    expect((await kbJson("/transition", { id, to: "in_progress", actor: "ghost-owner-br6163", note: "rework" })).status).toBe(200);
    expect((await kbJson("/transition", { id, to: "in_review", actor: "ghost-owner-br6163", note: `handoff — PR https://github.com/${REPO}/pull/2734` })).status).toBe(200);
    // backdate: restore the stale train park layer on the review card (the
    // strand's real shape — the wait outlives the park it rode)
    const upd = await kbJson("/update", {
      id,
      meta: { blocked: { reason: "merge-train: queued — VERIFY ACCEPT", ts: Date.now() - 3 * HOUR, await_event: { event: "pr_merged", repo: REPO, n: 2734 } } },
    });
    expect(upd.status, `backdate failed: ${JSON.stringify(upd.body)}`).toBeLessThan(400);
    // the bounce: another actor bounces the stalled review — the owner is
    // dead, so the ghost conversion releases the claim and stamps evidence
    const bounce = await kbJson("/transition", { id, to: "in_progress", actor: "drill-bouncer", note: "watchdog: review stalled — bounce" });
    expect(bounce.status, `bounce failed: ${JSON.stringify(bounce.body)}`).toBe(200);
    let cur = (await kbJson("/get", { id })).body;
    expect(String(cur.owner ?? "")).toBe("");
    expect(cur.meta?.bounce_released?.reason ?? "").toContain("dead");
    expect(cur.meta?.bounce_released?.train_only_await).toEqual({ event: "pr_merged", repo: REPO, n: 2734 });
    // the release completes to the pool — the strand shape on the board.
    // (A system actor CANNOT release a queued train car to todo — machine.ts
    // refuses exactly that; the release rides the plain bouncer identity.)
    expect((await kbJson("/transition", { id, to: "todo", actor: "drill-bouncer", note: "released to the pool after a stalled review round" })).status).toBe(200);
    cur = (await kbJson("/get", { id })).body;
    expect(cur.status).toBe("todo");
    expect(cur.meta?.bounce_released?.train_only_await).toEqual({ event: "pr_merged", repo: REPO, n: 2734 });
  });

  it("leg 2 — the sweep RE-BOARDS an out-of-queue train-only-await car once: legal blocked transition, queue membership, strand_reboard pin", async () => {
    const REPO = "state-vector/strand-reboard";
    await healthyLane(REPO, "gw-strand-2");
    const id = await task("BR#6163 reboard specimen");
    const old = Date.now() - 3 * HOUR;
    // a released (todo) card still carrying the train stamp + the release
    // evidence, 3h stale — the production bounce-release shape: NO blocked
    // record (the release transitions deleted it), the wait rides the stamp
    const upd = await kbJson("/update", {
      id,
      meta: {
        pr: { repo: REPO, number: 2735, head_sha_at_acceptance: "b".repeat(40), base: "main" },
        prs: [{ repo: REPO, number: 2735, head_sha_at_acceptance: "b".repeat(40), base: "main" }],
        merge_train: { state: "queued", pr: 2735, repo: REPO, at: old },
        bounce_released: { reason: "owning session dead at bounce — released to pool", at: old, train_only_await: { event: "pr_merged", repo: REPO, n: 2735 } },
      },
    });
    expect(upd.status).toBeLessThan(400);
    // the sweep: strand class out_of_queue_await, healthy lane (merged after
    // the park), 3h > the 2h strand window → ONE machine re-board
    const sweep = await kbJson("/admin.alarm_sweep");
    expect(sweep.body.error ?? "").toBe("");
    let cur = (await kbJson("/get", { id })).body;
    expect(cur.status).toBe("blocked");
    expect(String(cur.meta?.blocked?.reason ?? "")).toContain("strand re-board (BR#6163)");
    expect(String(cur.meta?.blocked?.reason ?? "")).toMatch(/^merge-train: queued/);
    // the typed train wait is PRESERVED by the re-board
    expect(cur.meta?.blocked?.await_event).toEqual({ event: "pr_merged", repo: REPO, n: 2735 });
    expect(cur.meta?.merge_train?.state).toBe("queued");
    // the one-attempt pin
    expect(cur.meta?.strand_reboard?.class).toBe("out_of_queue_await");
    const pinAt = cur.meta.strand_reboard.at;
    // the car is back IN the lane's derived queue — the train can gate it again
    const snap = (await kbJson("/train.status", { repo: REPO })).body.lanes[0];
    expect((snap.queue ?? []).map((x: any) => x.id)).toContain(id);
    // second sweep: the pin holds — no second re-board (at unchanged)
    await kbJson("/admin.alarm_sweep");
    cur = (await kbJson("/get", { id })).body;
    expect(cur.meta?.strand_reboard?.at).toBe(pinAt);
    expect((cur.meta?.blocked?.reason ?? "").match(/strand re-board \(BR#6163\)/g)?.length).toBe(1);
  });

  it("leg 3 — an unbound-in-queue car is ALARM-only (no machine re-board) and the alarm dedupes", async () => {
    const REPO = "state-vector/strand-unbound";
    await healthyLane(REPO, "gw-strand-3");
    const id = await task("BR#6163 unbound strand specimen");
    // park citing a PR WITHOUT a head token — trainQueueOnAccept fail-closes:
    // merge_train stamped unbound, the card never queues (BR#3659 law)
    const park = await kbJson("/transition", {
      id, to: "blocked", actor: "drill",
      note: `merge-train: queued — VERIFY ACCEPT. PR ${REPO}#3001.`,
      await_event: { event: "pr_merged", repo: REPO, n: 3001 },
    });
    expect(park.status).toBe(200);
    let cur = (await kbJson("/get", { id })).body;
    expect(cur.meta?.merge_train?.state).toBe("unbound");
    // backdate the park past the strand window
    const upd = await kbJson("/update", {
      id,
      meta: {
        merge_train: { ...cur.meta.merge_train, at: Date.now() - 3 * HOUR },
        blocked: { ...cur.meta.blocked, ts: Date.now() - 3 * HOUR },
      },
    });
    expect(upd.status).toBeLessThan(400);
    const sweep = await kbJson("/admin.alarm_sweep");
    expect(sweep.body.error ?? "").toBe("");
    cur = (await kbJson("/get", { id })).body;
    // NO machine re-board for an unbound car — a re-queue would re-stamp unbound
    expect(cur.status).toBe("blocked");
    expect(cur.meta?.strand_reboard).toBeUndefined();
    expect(cur.meta?.merge_train?.state).toBe("unbound");
    // the alarm fired ONCE to the sink
    let asks = await sinkQuestions(id);
    expect(asks.length).toBe(1);
    expect(String(asks[0].title)).toContain(id);
    expect(String(asks[0].title)).toMatch(/\?$/);
    expect(asks[0].meta?.ask?.to).toBe("human");
    // second sweep: deduped — no second re-board, no second ask
    await kbJson("/admin.alarm_sweep");
    cur = (await kbJson("/get", { id })).body;
    expect(cur.meta?.strand_reboard).toBeUndefined();
    asks = await sinkQuestions(id);
    expect(asks.length).toBe(1);
  });

  it("leg 4 — a HEALTHY awaiting park is excluded: the strand sweep never touches BR#5633's class", async () => {
    const REPO = "state-vector/strand-healthy";
    await healthyLane(REPO, "gw-strand-4");
    const id = await task("BR#6163 awaiting exclusion specimen");
    // the Awaiting park shape (do.ts train bounce human-leg park): claim,
    // park blocked on a train reason with the typed pr_merged wait, then
    // stamp the awaiting state + backdate the park past the strand window
    expect((await kbJson("/transition", { id, to: "in_progress", actor: "drill", note: "impl" })).status).toBe(200);
    const park = await kbJson("/transition", {
      id, to: "blocked", actor: "drill",
      note: "merge-train: awaiting review — coverage bounce needs a human leg",
      await_event: { event: "pr_merged", repo: REPO, n: 2736 },
      merge_train: {},
    });
    expect(park.status, `park failed: ${JSON.stringify(park.body)}`).toBe(200);
    const old = Date.now() - 5 * HOUR;
    const upd = await kbJson("/update", {
      id,
      meta: {
        pr: { repo: REPO, number: 2736, head_sha_at_acceptance: "c".repeat(40), base: "main" },
        prs: [{ repo: REPO, number: 2736, head_sha_at_acceptance: "c".repeat(40), base: "main" }],
        merge_train: { state: "awaiting", pr: 2736, repo: REPO, awaiting: { at: old }, at: old },
        blocked: { reason: "merge-train: awaiting review — coverage bounce needs a human leg", ts: old, await_event: { event: "pr_merged", repo: REPO, n: 2736 } },
      },
    });
    expect(upd.status).toBeLessThan(400);
    const sweep = await kbJson("/admin.alarm_sweep");
    expect(sweep.body.error ?? "").toBe("");
    const cur = (await kbJson("/get", { id })).body;
    expect(cur.status).toBe("blocked");
    expect(cur.meta?.strand_reboard).toBeUndefined();
    expect(cur.meta?.strand_alarm).toBeUndefined();
    // no ask names this card
    const asks = await sinkQuestions(id);
    expect(asks.length).toBe(0);
  });
});
