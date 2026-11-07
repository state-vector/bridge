import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isAwaitingMerge, mergePhaseOf } from "@bridge/contracts";
import {
  clampConflictingBudgetMin,
  mergeTrainHoldPrefix,
  mergeTrainQueue,
  releaseHold,
  trainConflictingParkReason,
  trainRequeueSwap,
  trainStrandClass,
  TRAIN_CONFLICTING_BUDGET_MIN_DEFAULT,
} from "../src/kb/core.ts";

/**
 * BR#6348 — conflicting train cars park TYPED, never churn in the pool.
 *
 * Phase A of the 2026-11-04 bridge@main starvation (BR#6340): the lane's only
 * car went CONFLICTING after main moved ~35 commits past its merge-base; the
 * conflict bounce sent the card to in_progress, the watchdog released it to
 * the pool, and it churned (attempt 9, churn-guard 8 releases, bounce re-entry
 * demotion) for 3h46m while the derived queue was EMPTY — `merge-train: ready`
 * + green base was truthful and no alarm could see a car to complain about.
 * The mechanical rebase (repo steering §8: 100% machine work) had no owner.
 *
 * Fix legs pinned here:
 *   1. contracts: `conflicting` joins the closed MergeTrainPhaseSchema union;
 *      isAwaitingMerge stays queued|awaiting-ci only (a conflicting car is
 *      NOT awaiting merge).
 *   2. the conflict bounce (train.event bounced, bounce_kind=conflict) parks
 *      the card blocked TYPED conflicting — `merge-train: conflicting` reason
 *      prefix + conflicting_at clock — IN the derived queue (mergeTrainQueue
 *      admits it; /train.status queue shows it), releaseHold keeps the
 *      watchdog from stranding it, and a re-assert refreshes the facts
 *      WITHOUT resetting the bounded clock.
 *   3. sweepConflictingCars (alarm cadence): past train.conflicting_budget_min
 *      the loud alarm fires ONCE per episode (24h conflicting_alarm dedupe +
 *      askCreate's identical-open-ask guard) to the train alarm sink.
 *   4. exits clear the episode: trainRequeueSwap / a claim (blocked →
 *      in_progress) flip the phase and delete the conflicting keys — no
 *      illegal residue under the closed union. trainStrandClass returns null
 *      for the park (the budget sweep owns it, not the strand sweep).
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

const task = async (title: string) => {
  const r = await kbJson("/create", { type: "task", title });
  expect(r.status).toBe(200);
  return String(r.body.id);
};

/** Lane + lease so /train.event is legal, and a merged event so the lane is
 *  healthy (the strand sweep's healthy-lane gate never hijacks this car). */
async function healthyLane(repo: string, gw: string): Promise<void> {
  const lane = await kbJson("/train.lane", { repo, base: "main", actor: "drill" });
  expect(lane.body.error ?? "").toBe("");
  const a = await kbJson("/train.lease", { repo, base: "main", action: "acquire", actor: gw });
  expect(a.body.error ?? "", `lease failed: ${JSON.stringify(a.body)}`).toBe("");
}

const sinkQuestions = async (names: string) =>
  ((await kbJson("/list", { type: "question", limit: 200 })).body?.artefacts ?? []).filter(
    (q: any) =>
      q.meta?.ask?.artefact_id === String((globalThis as any).__sinkId) &&
      String(q.title).includes(names),
  );

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
  const sinkId = await task("BR#6348 conflicting alarm sink drill");
  (globalThis as any).__sinkId = sinkId;
  const set = await kbJson("/admin.settings_set", { settings: { train_alarm_sink_id: sinkId } });
  expect(set.body.error ?? "").toBe("");
});

afterAll(async () => {
  await mf?.dispose();
});

describe("BR#6348 leg 1 — contracts + queue law (units)", () => {
  it("conflicting joins the closed phase; isAwaitingMerge stays queued|awaiting-ci only", () => {
    expect(mergePhaseOf({ merge_train: { state: "conflicting" } })).toBe("conflicting");
    expect(isAwaitingMerge({ merge_train: { state: "conflicting" } })).toBe(false);
    // legacy unknown spellings still normalise to null (surfaced, not papered over)
    expect(mergePhaseOf({ merge_train: { state: "conflicted" } })).toBe(null);
  });

  it("releaseHold HOLDS a conflicting park on a live PR leg — the watchdog cannot strand it into pool churn", () => {
    const meta = {
      merge_train: { state: "conflicting", pr: 309, repo: "state-vector/bridge" },
      pr: { repo: "state-vector/bridge", number: 309 },
    };
    const hold = releaseHold(meta);
    expect(hold).toContain("conflicting");
    expect(hold).toContain("state-vector/bridge#309");
    // no live leg → no hold (the train does not own that exit)
    expect(releaseHold({ merge_train: { state: "conflicting" } })).toBe(null);
  });

  it("mergeTrainHoldPrefix names the conflicting prefix — a watchdog hold-park of a conflicting car stays queue-admitted", () => {
    expect(mergeTrainHoldPrefix({ merge_train: { state: "conflicting" } })).toBe("merge-train: conflicting — ");
    expect(mergeTrainHoldPrefix({ merge_train: { state: "queued" } })).toBe("merge-train: queued — ");
    expect(mergeTrainHoldPrefix({ merge_train: { state: "bounced" } })).toBe(null);
  });

  it("mergeTrainQueue ADMITS a typed conflicting car (prefix or typed phase) — the queue never goes silently empty", () => {
    const head = "c".repeat(40);
    const cards = [
      // the parked conflicting car: blocked, merge-train: conflicting prefix
      {
        id: "BR#1",
        status_ts: 1,
        meta: {
          merge_train: { state: "conflicting", pr: 309, repo: "state-vector/bridge", conflicting_at: Date.now() },
          blocked: { reason: trainConflictingParkReason(309, "state-vector/bridge", ["a.ts", "b.ts"]), ts: Date.now() },
          pr: { repo: "state-vector/bridge", number: 309, head_sha_at_acceptance: head, base: "main" },
        },
      },
    ];
    const q = mergeTrainQueue(cards as any);
    expect(q.map((c) => c.id)).toContain("BR#1");
    // typed admission alone (prefix lost, e.g. a hold-park residue) still admits
    const q2 = mergeTrainQueue([{ id: "BR#2", status_ts: 2, meta: { merge_train: { state: "conflicting", pr: 310, repo: "state-vector/bridge" } } } as any]);
    expect(q2.map((c) => c.id)).toContain("BR#2");
  });

  it("trainStrandClass is null for a conflicting park — the BR#6348 budget sweep owns it", () => {
    const meta = { merge_train: { state: "conflicting", pr: 1, repo: "r/r" } };
    expect(trainStrandClass(meta, true)).toBe(null);
    expect(trainStrandClass(meta, false)).toBe(null);
  });

  it("trainRequeueSwap clears the conflicting episode keys — no illegal residue under the closed union", () => {
    const m2 = trainRequeueSwap({
      merge_train: { state: "conflicting", pr: 1, repo: "r/r", conflicting_at: 123, conflicting_alarm: { at: 456 } },
      blocked: { reason: "merge-train: conflicting — …" },
    });
    expect(m2.merge_train.state).toBe("queued");
    expect(m2.merge_train.conflicting_at).toBeUndefined();
    expect(m2.merge_train.conflicting_alarm).toBeUndefined();
  });

  it("the budget knob clamps 15..1440 with default 120; the park reason carries prefix + files + exit", () => {
    expect(TRAIN_CONFLICTING_BUDGET_MIN_DEFAULT).toBe(120);
    expect(clampConflictingBudgetMin(NaN)).toBe(120);
    expect(clampConflictingBudgetMin(5)).toBe(15);
    expect(clampConflictingBudgetMin(5000)).toBe(1440);
    expect(clampConflictingBudgetMin(30)).toBe(30);
    const reason = trainConflictingParkReason(309, "state-vector/bridge", ["packages/worker/src/kb/do.ts", "packages/desktop/src-tauri/src/train.rs"], "trial-merge failed");
    expect(reason).toMatch(/^merge-train: conflicting — PR state-vector\/bridge#309 conflicts with base \(2 file\(s\)\): /);
    expect(reason).toContain("force-with-lease");
    expect(reason).toContain("BR#6348");
  });
});

describe("BR#6348 legs 2-4 — the bounce park, the clock, the alarm (integration)", () => {
  it("leg 2 — a conflict bounce parks the card blocked TYPED conflicting, IN the derived queue", async () => {
    const REPO = "state-vector/conflict-park";
    await healthyLane(REPO, "gw-conflict-2");
    const id = await task("BR#6348 conflicting car specimen");
    const head = "d".repeat(40);
    // claim + verify-accept park (the queued shape the executor walks)
    expect((await kbJson("/transition", { id, to: "in_progress", actor: "impl-br6348", note: "impl" })).status).toBe(200);
    const park = await kbJson("/transition", {
      id, to: "blocked", actor: "impl-br6348",
      note: `merge-train: queued — VERIFY ACCEPT (drill). PR ${REPO}#309 head ${head}.`,
      await_event: { event: "pr_merged", repo: REPO, n: 309 },
    });
    expect(park.status, `park failed: ${JSON.stringify(park.body)}`).toBe(200);
    await completePrReview(kbJson, id, [{ repo: REPO, number: 309, head_sha_at_acceptance: head }]);
    expect((await kbJson("/get", { id })).body.meta?.merge_train?.state).toBe("queued");

    // the executor's conflict bounce: trial-merge enumerated the files
    const bounced = await kbJson("/train.event", {
      repo: REPO, base: "main", kind: "bounced", actor: "gw-conflict-2",
      pr: 309, task_id: id, head_sha: head,
      bounce_kind: "conflict",
      conflict_files: ["packages/worker/src/kb/do.ts", "packages/desktop/src-tauri/src/train.rs"],
      reason: "PR #309 unmergeable — CONFLICTING against base. Rebase, resolve, re-push, re-enter the queue",
    });
    expect(bounced.body.error ?? "", `bounce failed: ${JSON.stringify(bounced.body)}`).toBe("");
    expect(bounced.body.conflicting_park).toBe(true);

    const cur = (await kbJson("/get", { id })).body;
    // TYPED park — blocked (NOT the in_progress churn), the closed-union phase
    expect(cur.status).toBe("blocked");
    expect(cur.meta?.merge_train?.state).toBe("conflicting");
    expect(cur.meta?.merge_train?.bounce_kind).toBe("conflict");
    expect(cur.meta?.merge_train?.conflicting_at).toBeGreaterThan(0);
    expect(cur.meta?.merge_train?.conflict_files).toEqual(["packages/worker/src/kb/do.ts", "packages/desktop/src-tauri/src/train.rs"]);
    // the park reason carries the queue-admitting prefix + the exit
    expect(String(cur.meta?.blocked?.reason ?? "")).toMatch(/^merge-train: conflicting — PR state-vector\/conflict-park#309/);
    expect(String(cur.meta?.blocked?.reason ?? "")).toContain("force-with-lease");
    // the episode keys
    expect(cur.meta?.merge_train?.awaiting).toBeUndefined();

    // THE PHASE A INVARIANT: the car is IN the lane's derived queue — the
    // starvation sweep and the trains panel can see it
    const snap = (await kbJson("/train.status", { repo: REPO })).body.lanes[0];
    expect((snap.queue ?? []).map((x: any) => x.id)).toContain(id);
  });

  it("leg 3 — a re-assert while parked refreshes the facts but NEVER resets the bounded clock", async () => {
    const REPO = "state-vector/conflict-reassert";
    await healthyLane(REPO, "gw-conflict-3");
    const id = await task("BR#6348 conflicting re-assert specimen");
    const head = "e".repeat(40);
    expect((await kbJson("/transition", { id, to: "in_progress", actor: "impl-br6348b", note: "impl" })).status).toBe(200);
    expect((await kbJson("/transition", {
      id, to: "blocked", actor: "impl-br6348b",
      note: `merge-train: queued — VERIFY ACCEPT (drill). PR ${REPO}#310 head ${head}.`,
      await_event: { event: "pr_merged", repo: REPO, n: 310 },
    })).status).toBe(200);
    const ev1 = await kbJson("/train.event", {
      repo: REPO, base: "main", kind: "bounced", actor: "gw-conflict-3",
      pr: 310, task_id: id, head_sha: head, bounce_kind: "conflict",
      conflict_files: ["a.ts"], reason: "PR #310 unmergeable — CONFLICTING against base",
    });
    expect(ev1.body.error ?? "").toBe("");
    const parked = (await kbJson("/get", { id })).body;
    const clockAt = parked.meta.merge_train.conflicting_at;
    expect(clockAt).toBeGreaterThan(0);

    // main moved; the re-verdict names a DIFFERENT file set — facts refresh,
    // the clock does not
    const ev2 = await kbJson("/train.event", {
      repo: REPO, base: "main", kind: "bounced", actor: "gw-conflict-3",
      pr: 310, task_id: id, head_sha: head, bounce_kind: "conflict",
      conflict_files: ["b.ts", "c.ts"], reason: "PR #310 unmergeable — CONFLICTING against base (moved main)",
    });
    expect(ev2.body.error ?? "").toBe("");
    const cur = (await kbJson("/get", { id })).body;
    expect(cur.status).toBe("blocked"); // in place — no pool churn
    expect(cur.meta.merge_train.conflicting_at).toBe(clockAt);
    expect(cur.meta.merge_train.conflict_files).toEqual(["b.ts", "c.ts"]);
    expect(String(cur.meta.blocked?.reason ?? "").match(/BR#6348/g)?.length).toBe(1);
  });

  it("leg 4 — past the budget Bridge schedules one conflict repair duty and no human ask", async () => {
    const REPO = "state-vector/conflict-budget";
    await healthyLane(REPO, "gw-conflict-4");
    const id = await task("BR#6348 conflicting budget specimen");
    const head = "f".repeat(40);
    expect((await kbJson("/transition", { id, to: "in_progress", actor: "impl-br6348c", note: "impl" })).status).toBe(200);
    expect((await kbJson("/transition", {
      id, to: "blocked", actor: "impl-br6348c",
      note: `merge-train: queued — VERIFY ACCEPT (drill). PR ${REPO}#311 head ${head}.`,
      await_event: { event: "pr_merged", repo: REPO, n: 311 },
    })).status).toBe(200);
    const ev1 = await kbJson("/train.event", {
      repo: REPO, base: "main", kind: "bounced", actor: "gw-conflict-4",
      pr: 311, task_id: id, head_sha: head, bounce_kind: "conflict",
      conflict_files: ["train.rs"], reason: "PR #311 unmergeable — CONFLICTING against base",
    });
    expect(ev1.body.error ?? "").toBe("");

    // inside the budget: no alarm
    await kbJson("/admin.alarm_sweep");
    expect(await sinkQuestions(id)).toHaveLength(0);

    // backdate past the default 120m budget
    const cur = (await kbJson("/get", { id })).body;
    const upd = await kbJson("/update", {
      id,
      meta: { merge_train: { ...cur.meta.merge_train, conflicting_at: Date.now() - 3 * HOUR } },
    });
    expect(upd.status).toBeLessThan(400);
    const sweep = await kbJson("/admin.alarm_sweep");
    expect(sweep.body.error ?? "").toBe("");
    let asks = await sinkQuestions(id);
    expect(asks.length).toBe(0);
    const recoveryId = (await kbJson("/get", { id })).body.meta.recovery.task_id;
    const recovery = (await kbJson("/get", { id: recoveryId })).body;
    expect(recovery.meta.machine_duty).toMatchObject({ kind: "task-recovery", reason: "conflict", subject: id });
    expect((await kbJson("/get", { id })).body.meta?.merge_train?.conflicting_alarm?.at).toBeGreaterThan(0);

    // second sweep: deduped (24h) — still exactly one ask
    await kbJson("/admin.alarm_sweep");
    expect(await sinkQuestions(id)).toHaveLength(0);
    expect((await kbJson("/get", { id })).body.meta.recovery.task_id).toBe(recoveryId);
  });

  it("leg 5 — claiming the rebase leg (blocked → in_progress) ends the park: conflicting → bounced, keys cleared", async () => {
    const REPO = "state-vector/conflict-claim";
    await healthyLane(REPO, "gw-conflict-5");
    const id = await task("BR#6348 conflicting claim specimen");
    const head = "1".repeat(40);
    expect((await kbJson("/transition", { id, to: "in_progress", actor: "impl-br6348d", note: "impl" })).status).toBe(200);
    expect((await kbJson("/transition", {
      id, to: "blocked", actor: "impl-br6348d",
      note: `merge-train: queued — VERIFY ACCEPT (drill). PR ${REPO}#312 head ${head}.`,
      await_event: { event: "pr_merged", repo: REPO, n: 312 },
    })).status).toBe(200);
    const ev1 = await kbJson("/train.event", {
      repo: REPO, base: "main", kind: "bounced", actor: "gw-conflict-5",
      pr: 312, task_id: id, head_sha: head, bounce_kind: "conflict",
      conflict_files: ["do.ts"], reason: "PR #312 unmergeable — CONFLICTING against base",
    });
    expect(ev1.body.error ?? "").toBe("");
    expect((await kbJson("/get", { id })).body.meta?.merge_train?.state).toBe("conflicting");

    // a live session takes the mechanical rebase leg — the BR#5750 unpark law
    expect((await kbJson("/transition", { id, to: "in_progress", actor: "rebase-br6348", note: "mechanical rebase leg (BR#6348)" })).status).toBe(200);
    const cur = (await kbJson("/get", { id })).body;
    expect(cur.status).toBe("in_progress");
    expect(cur.meta.merge_train.state).toBe("bounced");
    expect(cur.meta.merge_train.conflicting_at).toBeUndefined();
    expect(cur.meta.merge_train.conflicting_alarm).toBeUndefined();
  });
});
import { completePrReview } from "./completion-fixture";
