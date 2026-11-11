import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admissionMergedTerminal, admissionLandedCloseNote } from "../src/kb/core";
import { completePrReview, reviewOutcome } from "./completion-fixture";

/**
 * BR#9510 — hub delivery livelock: accepted_pr on an already-merged PR
 * re-queued forever.
 *
 * The live defect (2026-11-09/10, BR#9032 leg bridge#439): PR merged at
 * head 84210373 (merge 1a45bfd5, decisive CI green) yet 33 identical
 * accepted_pr admissions of the same leg never closed the parent — every
 * acceptance re-stamped merge_train.state=queued (no merged-provenance
 * check), the merged-park heal re-converted the park and spawned a FRESH
 * verify duty (~35 respawns, one small-tier executor every ~6 min; the
 * same class ran on the BR#3785 sibling chain).
 *
 * Law pinned here:
 *   1. queueAcceptedPrLegs: an admission whose EVERY leg already carries a
 *      hub merge receipt (leg stamp merge_sha, or a provenance row whose
 *      recorded head the acceptance covers) is TERMINAL — close on the
 *      machine proxy, never re-stamp queued. A second admission of the
 *      same task+head is a no-op carry.
 *   2. reviewObservedMerge (the heal): retains-and-carries an existing
 *      DONE admission for the same task + observed leg instead of
 *      spawning a fresh verify round.
 *   3. Unmerged-leg admissions still queue normally (fail-closed, no
 *      behavior regression); BR#4688 bounce-budget + BR#4648 stamp
 *      honesty guards still hold.
 *   4. Additive leg (BR#7642/BR#7644/BR#9655): an exact-subject
 *      accepted_direct_main round closes a todo-position parent (the
 *      close previously required in_review and stranded verified
 *      delivered work in the pool).
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

const task = async (title: string) => {
  const r = await kbJson("/create", { type: "task", title });
  expect(r.status).toBe(200);
  return String(r.body.id);
};

const get = async (id: string) => (await kbJson("/get", { id })).body;
const historyText = async (id: string) => {
  const hist = (await kbJson(`/history?id=${encodeURIComponent(id)}`)).body;
  return (hist?.versions ?? []).map((v: any) => `${v?.summary ?? ""}\n${v?.action ?? ""}`).join("\n");
};

/** A parked queued car: claimed, verify-accepted onto the train (the
 *  canonical park stamps merge_train.state=queued + the pr leg).
 *  `terminal` = the admission is expected to take the merged-provenance
 *  close instead of the queue (provenance pre-stamped). */
const parkQueuedCar = async (id: string, repo: string, n: number, actor: string, head: string, terminal = false) => {
  expect((await kbJson("/transition", { id, to: "in_progress", actor, note: "impl" })).status).toBe(200);
  const park = await kbJson("/transition", {
    id, to: "blocked", actor,
    note: `merge-train: queued — VERIFY ACCEPT (drill). PR ${repo}#${n} head ${head}.`,
    await_event: { event: "pr_merged", repo, n },
  });
  expect(park.status, `park failed: ${JSON.stringify(park.body)}`).toBe(200);
  await completePrReview(kbJson, id, [{ repo, number: n, head_sha_at_acceptance: head }]);
  const cur = await get(id);
  if (terminal) {
    expect(cur.status).toBe("done");
    expect(cur.meta?.merge_train?.state).toBe("landed");
  } else {
    expect(cur.meta?.merge_train?.state).toBe("queued");
  }
  return cur;
};

/** A provenance merge receipt for (repo, n) via a train merged event. */
const stampProvenance = async (repo: string, n: number, mergeSha: string, headSha: string, gw: string) => {
  await kbJson("/train.lane", { repo, base: "main", actor: "drill" });
  const a = await kbJson("/train.lease", { repo, base: "main", action: "acquire", actor: gw });
  expect(a.body.error ?? "", `lease failed: ${JSON.stringify(a.body)}`).toBe("");
  const ev = await kbJson("/train.event", { repo, base: "main", kind: "merged", actor: gw, pr: n, merge_sha: mergeSha, head_sha: headSha });
  expect(ev.body.error ?? "", `train.event failed: ${JSON.stringify(ev.body)}`).toBe("");
};

/** Close the hub-SPAWNED verify duty (not a fixture duty) with a typed
 *  accepted_pr — the exact live cycle's admission event. */
const acceptSpawnedReview = async (dutyId: string, task_id: string, legs: { repo: string; number: number; head_sha_at_acceptance: string }[]) => {
  const session = `fixture-review-${crypto.randomUUID()}`;
  expect((await kbJson("/transition", { id: dutyId, to: "in_progress", actor: "fixture-reviewer", session })).status).toBe(200);
  const closed = await kbJson("/transition", { id: dutyId, to: "done", actor: "fixture-reviewer", session,
    note: legs.map(l => `https://github.com/${l.repo}/pull/${l.number} head ${l.head_sha_at_acceptance}`).join("; "),
    review_result: await reviewOutcome(kbJson, dutyId, { kind: "accepted_pr", task_id, legs }) });
  expect(closed.status, `spawned duty close failed: ${JSON.stringify(closed.body)}`).toBe(200);
};

const countReviewChildren = async (id: string) => {
  const rel = (await kbJson("/relations", { id })).body.relations ?? [];
  const out: string[] = [];
  for (const r of rel) if (r.relation === "child_of" && r.dir === "in") out.push(String(r.artefact_id));
  let n = 0;
  for (const c of out) if (String((await get(c))?.roles ?? "").includes("review")) n += 1;
  return n;
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

describe("BR#9510 leg 0 — the pure merged-provenance terminal law (core.ts)", () => {
  const H = (c: string) => c.repeat(40);
  it("empty legs are never terminal; an all-merged admission is", () => {
    expect(admissionMergedTerminal([], new Map(), {})).toBeNull();
    const prov = new Map([["o/r#7", { merge_sha: H("a"), head_sha: H("1") }]]);
    const out = admissionMergedTerminal([{ repo: "o/r", number: 7, accepted_head: H("1") }], prov, {});
    expect(out).toEqual([{ repo: "o/r", number: 7, head: H("1"), mergeSha: H("a"), via: "provenance" }]);
  });
  it("a provenance head the acceptance does not cover is NOT terminal (head law, BR#3516 §5)", () => {
    const prov = new Map([["o/r#7", { merge_sha: H("a"), head_sha: H("9") }]]);
    expect(admissionMergedTerminal([{ repo: "o/r", number: 7, accepted_head: H("1") }], prov, {})).toBeNull();
  });
  it("a contiguous carry chain covers the provenance head; a broken one does not", () => {
    const prov = new Map([["o/r#7", { merge_sha: H("a"), head_sha: H("2") }]]);
    const carry = [{ from_head: H("1"), to_head: H("2"), prior_verdict_id: null, carried_ts: 1, via: "rebase" as const }];
    expect(admissionMergedTerminal([{ repo: "o/r", number: 7, stamped_head: H("1"), carry }], prov, {})).toBeTruthy();
    const broken = [{ from_head: H("8"), to_head: H("2"), prior_verdict_id: null, carried_ts: 1, via: "rebase" as const }];
    expect(admissionMergedTerminal([{ repo: "o/r", number: 7, stamped_head: H("1"), carry: broken }], prov, {})).toBeNull();
  });
  it("the train's own leg stamp is a receipt (the stranded awaiting-ci shape); one unmerged leg fails the whole admission closed", () => {
    expect(admissionMergedTerminal([{ repo: "o/r", number: 7, accepted_head: H("1") }], new Map(), { "7": { merge_sha: H("a") } }))
      .toEqual([{ repo: "o/r", number: 7, head: H("1"), mergeSha: H("a"), via: "leg-stamp" }]);
    const prov = new Map([["o/r#7", { merge_sha: H("a"), head_sha: "" }]]);
    expect(admissionMergedTerminal([
      { repo: "o/r", number: 7, accepted_head: H("1") },
      { repo: "o/r", number: 8, accepted_head: H("2") },
    ], prov, {})).toBeNull();
  });
  it("the close note cites the acceptance and merge commits, never a hub-observed main-green", () => {
    const note = admissionLandedCloseNote({ gateway: "gw", reviewId: "BR#91", legs: [{ repo: "o/r", number: 7, head: H("1"), mergeSha: H("a") }] });
    expect(note).toContain("BR#91");
    expect(note).toContain(`https://github.com/o/r/commit/${H("a")}`);
    expect(note).not.toMatch(/main workflows green/i);
  });
});

describe("BR#9510 leg 1 — a fully-merged admission is terminal: close, never re-queue", () => {
  it("an accepted_pr on an in_review parent whose sole leg has provenance merge_sha closes the parent (the live BR#9032 shape)", async () => {
    const REPO = "state-vector/br9510-terminal";
    const N = 9510;
    const HEAD = "1".repeat(40);
    const SHA = "2".repeat(40);
    await stampProvenance(REPO, N, SHA, HEAD, "gw-br9510-a");
    const id = await task("BR#9510 terminal admission specimen (in_review)");
    expect((await kbJson("/transition", { id, to: "in_progress", actor: "drill-owner-a", note: "impl" })).status).toBe(200);
    const submitted = await kbJson("/transition", { id, to: "in_review", actor: "drill-owner-a", note: `PR https://github.com/${REPO}/pull/${N} head ${HEAD}` });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const duty = String(submitted.body.verify_task);
    expect(duty).toBeTruthy();
    await acceptSpawnedReview(duty, id, [{ repo: REPO, number: N, head_sha_at_acceptance: HEAD }]);
    const cur = await get(id);
    expect(cur.status).toBe("done");
    expect(cur.meta?.merge_train?.state).toBe("landed");
    expect(cur.meta?.merge_train?.legs?.[String(N)]).toMatchObject({ state: "landed", merge_sha: SHA });
    expect(cur.delivery_admissions ?? []).toEqual(expect.arrayContaining([expect.objectContaining({ state: expect.objectContaining({ phase: "admitted" }) })]));
    expect(await historyText(id)).toContain("merged-provenance");
    // the spawned duty is closed, not respawned
    expect(await countReviewChildren(id)).toBe(1);
    expect((await get(duty)).status).toBe("done");
  });

  it("the SECOND admission of the same task+head is a no-op carry: no re-stamp, no fresh duty, parent stays closed", async () => {
    const REPO = "state-vector/br9510-idem";
    const N = 9511;
    const HEAD = "3".repeat(40);
    const SHA = "4".repeat(40);
    await stampProvenance(REPO, N, SHA, HEAD, "gw-br9510-b");
    const id = await task("BR#9510 idempotency specimen");
    await parkQueuedCar(id, REPO, N, "drill-owner-b", HEAD, true);
    const first = await get(id);
    expect(first.status).toBe("done");
    expect(first.meta?.merge_train?.state).toBe("landed");
    const relationsBefore = await countReviewChildren(id);
    // a stray duplicate admission — the exact livelock input
    await completePrReview(kbJson, id, [{ repo: REPO, number: N, head_sha_at_acceptance: HEAD }]);
    const cur = await get(id);
    expect(cur.status).toBe("done");
    expect(cur.meta?.merge_train?.state).toBe("landed");
    expect(cur.meta?.merge_train?.state).not.toBe("queued");
    expect(await countReviewChildren(id)).toBe(relationsBefore + 1); // only the fixture's own duty
    const admissions = (cur.delivery_admissions ?? []).filter((a: any) => a.state?.phase === "admitted");
    expect(admissions.length).toBeGreaterThanOrEqual(2);
    const text = await historyText(id);
    expect(text).not.toContain("Observed MERGED");
  });
});

describe("BR#9510 leg 2 — the heal retains-and-carries an existing done admission (no fresh verify duty)", () => {
  it("sweepMergedParks on a merged queued car with an admitted acceptance carries it to done instead of submitting a fresh round", async () => {
    const REPO = "state-vector/br9510-carry";
    const N = 9512;
    const HEAD = "5".repeat(40);
    const SHA = "6".repeat(40);
    const id = await task("BR#9510 carry specimen");
    await parkQueuedCar(id, REPO, N, "drill-owner-c", HEAD);
    // the train merges the PR AFTER the acceptance parked the card
    await stampProvenance(REPO, N, SHA, HEAD, "gw-br9510-c");
    const relationsBefore = await countReviewChildren(id);
    const sweep = await kbJson("/admin.alarm_sweep");
    expect(sweep.body.error ?? "").toBe("");
    const cur = await get(id);
    expect(cur.status).toBe("done");
    expect(cur.meta?.merge_train?.state).toBe("landed");
    expect(cur.meta?.merge_train?.legs?.[String(N)]).toMatchObject({ state: "landed", merge_sha: SHA });
    expect(await countReviewChildren(id)).toBe(relationsBefore); // NO fresh verify duty
    const text = await historyText(id);
    expect(text).toContain("merged-provenance");
    expect(text).not.toContain("Observed MERGED");
    // idempotent sweep: a second pass changes nothing
    await kbJson("/admin.alarm_sweep");
    expect((await get(id)).status).toBe("done");
    expect(await countReviewChildren(id)).toBe(relationsBefore);
  });
});

describe("BR#9510 leg 3 — unmerged-leg admissions still queue normally (no regression)", () => {
  it("a single unmerged leg queues on the train, honestly re-queued (BR#4648)", async () => {
    const REPO = "state-vector/br9510-live";
    const N = 9513;
    const HEAD = "7".repeat(40);
    const id = await task("BR#9510 live-slot specimen");
    await parkQueuedCar(id, REPO, N, "drill-owner-d", HEAD);
    const cur = await get(id);
    expect(cur.status).toBe("blocked");
    expect(cur.meta?.merge_train?.state).toBe("queued");
    const text = await historyText(id);
    expect(text).toContain("(re-queued");
  });

  it("a multi-leg admission with one merged and one open leg is NOT terminal — the card stays queued on the remaining leg", async () => {
    const REPO = "state-vector/br9510-multi";
    const N1 = 9514, N2 = 9515;
    const HEAD = "8".repeat(40);
    const SHA = "9".repeat(40);
    await stampProvenance(REPO, N1, SHA, HEAD, "gw-br9510-d");
    const id = await task("BR#9510 multi-leg specimen");
    expect((await kbJson("/transition", { id, to: "in_progress", actor: "drill-owner-e", note: "impl" })).status).toBe(200);
    const park = await kbJson("/transition", {
      id, to: "blocked", actor: "drill-owner-e",
      note: `merge-train: queued — VERIFY ACCEPT (drill). PR ${REPO}#${N1} head ${HEAD}, PR ${REPO}#${N2} head ${"a".repeat(40)}.`,
      await_event: { event: "pr_merged", repo: REPO, n: N1 },
    });
    expect(park.status, `park failed: ${JSON.stringify(park.body)}`).toBe(200);
    await completePrReview(kbJson, id, [
      { repo: REPO, number: N1, head_sha_at_acceptance: HEAD },
      { repo: REPO, number: N2, head_sha_at_acceptance: "a".repeat(40) },
    ]);
    const cur = await get(id);
    expect(cur.status).toBe("blocked");
    expect(cur.meta?.merge_train?.state).toBe("queued");
    expect(cur.meta?.merge_train?.legs?.[String(N1)]?.state).not.toBe("landed");
  });
});

describe("BR#9510 leg 4 — bounce-budget (BR#4688) and merged-escalation interplay", () => {
  it("an ACTIVE escalation with no merge receipt still stops the re-queue", async () => {
    const REPO = "state-vector/br9510-budget";
    const N = 9516;
    const HEAD = "b".repeat(40);
    const id = await task("BR#9510 bounce-budget specimen");
    await parkQueuedCar(id, REPO, N, "drill-owner-f", HEAD);
    const cur0 = await get(id);
    const upd = await kbJson("/update", { id, meta: { merge_train: { ...cur0.meta.merge_train, escalated: { pr: N, head_sha: HEAD, bounce_kind: "gate", bounce_no: 2, at: Date.now() } } } });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    await completePrReview(kbJson, id, [{ repo: REPO, number: N, head_sha_at_acceptance: HEAD }]);
    const cur = await get(id);
    expect(cur.status).toBe("blocked");
    expect(cur.meta?.merge_train?.state).toBe("queued");
    const text = await historyText(id);
    expect(text).toContain("queue_refused_bounce_budget");
  });

  it("an escalated card whose leg IS merge-receipted closes terminally — a merged PR is beyond the bounce clock", async () => {
    const REPO = "state-vector/br9510-budget-merged";
    const N = 9517;
    const HEAD = "c".repeat(40);
    const SHA = "d".repeat(40);
    await stampProvenance(REPO, N, SHA, HEAD, "gw-br9510-e");
    const id = await task("BR#9510 escalated-merged specimen");
    expect((await kbJson("/transition", { id, to: "in_progress", actor: "drill-owner-g", note: "impl" })).status).toBe(200);
    const park = await kbJson("/transition", {
      id, to: "blocked", actor: "drill-owner-g",
      note: `merge-train: queued — VERIFY ACCEPT (drill). PR ${REPO}#${N} head ${HEAD}.`,
      await_event: { event: "pr_merged", repo: REPO, n: N },
    });
    expect(park.status, `park failed: ${JSON.stringify(park.body)}`).toBe(200);
    const parked = await get(id);
    const upd = await kbJson("/update", { id, meta: { merge_train: { ...parked.meta.merge_train, escalated: { pr: N, head_sha: HEAD, bounce_kind: "gate", bounce_no: 2, at: Date.now() } } } });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    await completePrReview(kbJson, id, [{ repo: REPO, number: N, head_sha_at_acceptance: HEAD }]);
    const cur = await get(id);
    expect(cur.status).toBe("done");
    expect(cur.meta?.merge_train?.state).toBe("landed");
  });
});

describe("BR#9510 leg 5 — accepted_direct_main closes a todo-position parent (BR#7642 additive leg)", () => {
  it("an exact-subject direct-main acceptance on a todo parent ladders to done instead of stranding", async () => {
    const REPO = "state-vector/br9510-direct";
    const COMMIT = "e".repeat(40);
    const id = await task("BR#9510 direct-main todo specimen");
    expect((await kbJson("/transition", { id, to: "in_progress", actor: "drill-owner-h", note: "impl" })).status).toBe(200);
    // the stalled round was watchdog-released: in_progress → todo (system actor)
    const released = await kbJson("/transition", { id, to: "todo", actor: "system:watchdog", note: "stalled — no update for >10m; released to the pool by watchdog" });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect((await get(id)).status).toBe("todo");
    // the verifier's exact-subject acceptance lands while the parent sits in todo
    const session = `fixture-review-${crypto.randomUUID()}`;
    const duty = (await kbJson("/create", { type: "task", title: "Independent direct-main review", roles: ["review"], session })).body.id;
    expect((await kbJson("/link", { src: duty, relation: "child_of", dst: id })).status).toBe(200);
    expect((await kbJson("/transition", { id: duty, to: "in_progress", actor: "fixture-reviewer", session })).status).toBe(200);
    const closed = await kbJson("/transition", { id: duty, to: "done", actor: "fixture-reviewer", session,
      note: `Verified https://github.com/${REPO}/commit/${COMMIT}`,
      review_result: await reviewOutcome(kbJson, duty, { kind: "accepted_direct_main", repo: REPO, commit: COMMIT, ci_run_url: `https://github.com/${REPO}/actions/runs/1` }) });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const cur = await get(id);
    expect(cur.status).toBe("done");
    expect(cur.meta?.delivery).toMatchObject({ kind: "direct_main", sha: COMMIT, repo: REPO });
  });
});

describe("BR#9510 leg 6 — the strand sweep carries a fully-merged stranded car instead of re-dispatching queue_binding (BR#11981 class)", () => {
  /** The BR#11981 shape: a queued car whose acceptance ADMITTED (pre-cure
   *  stamp) is then resumed blocked→in_progress by an answered ask, and the
   *  PR merges — leaving an in_progress card with a stale queued stamp, an
   *  admitted acceptance that never replays, and no live writer. */
  const strandResumedCar = async (repo: string, n: number, actor: string, head: string) => {
    const id = await task(`BR#9510 strand specimen ${repo}#${n}`);
    await parkQueuedCar(id, repo, n, actor, head); // queued + admitted (delivery_admissions)
    const resumed = await kbJson("/transition", { id, to: "in_progress", actor, note: "ask answered — resumed" });
    expect(resumed.status, `resume failed: ${JSON.stringify(resumed.body)}`).toBe(200);
    // age the park past the strand horizon (train.strand_hours default 2h)
    const cur0 = await get(id);
    const upd = await kbJson("/update", { id, meta: {
      ...cur0.meta,
      merge_train: { ...cur0.meta?.merge_train, at: Date.now() - 3 * 3_600_000 },
      ...(cur0.meta?.blocked ? { blocked: { ...cur0.meta.blocked, ts: Date.now() - 3 * 3_600_000 } } : {}),
    } });
    expect(upd.status, `age update failed: ${JSON.stringify(upd.body)}`).toBe(200);
    return id;
  };

  const countRecoveryDuties = async (id: string) => {
    const rel = (await kbJson("/relations", { id })).body.relations ?? [];
    const out: string[] = [];
    for (const r of rel) if (r.relation === "child_of" && r.dir === "in") out.push(String(r.artefact_id));
    let n = 0;
    for (const c of out) {
      const child = await get(c);
      if (String(child?.meta?.machine_duty?.kind ?? "") === "task-recovery") n += 1;
    }
    return n;
  };

  it("a resumed in_progress queued car whose leg carries provenance is terminally closed by the strand sweep — no queue_binding duty dispatched", async () => {
    const REPO = "state-vector/br9510-strand-carry";
    const N = 9518;
    const HEAD = "f".repeat(40);
    const SHA = "1".repeat(40);
    const id = await strandResumedCar(REPO, N, "drill-owner-strand-a", HEAD);
    const before = await get(id);
    expect(before.status).toBe("in_progress");
    expect(before.meta?.merge_train?.state).toBe("queued");
    // the PR merges AFTER the acceptance parked the card (provenance receipt)
    await stampProvenance(REPO, N, SHA, HEAD, "gw-br9510-strand-a");
    const recoveriesBefore = await countRecoveryDuties(id);
    const sweep = await kbJson("/admin.strand_disposition_sweep", {});
    expect(sweep.body.error, JSON.stringify(sweep.body)).toBeUndefined();
    const cur = await get(id);
    expect(cur.status).toBe("done");
    expect(cur.meta?.merge_train?.state).toBe("landed");
    expect(cur.meta?.merge_train?.legs?.[String(N)]).toMatchObject({ state: "landed", merge_sha: SHA, via: "merged-provenance" });
    expect(await countRecoveryDuties(id)).toBe(recoveriesBefore); // NO queue_binding duty
    expect(await historyText(id)).toContain("merged-provenance");
    // idempotent: a second strand pass on the done card changes nothing
    const sweep2 = await kbJson("/admin.strand_disposition_sweep", {});
    expect(sweep2.body.error, JSON.stringify(sweep2.body)).toBeUndefined();
    expect((await get(id)).status).toBe("done");
  });

  it("the SAME stranded car WITHOUT merged provenance still dispatches the recovery duty (fail-closed guard)", async () => {
    const REPO = "state-vector/br9510-strand-live";
    const N = 9519;
    const HEAD = "2".repeat(40);
    const id = await strandResumedCar(REPO, N, "drill-owner-strand-b", HEAD);
    const recoveriesBefore = await countRecoveryDuties(id);
    const sweep = await kbJson("/admin.strand_disposition_sweep", {});
    expect(sweep.body.error, JSON.stringify(sweep.body)).toBeUndefined();
    const cur = await get(id);
    expect(cur.status).not.toBe("done"); // the merge is still owed — the card stays open
    expect(cur.meta?.merge_train?.state).toBe("queued");
    expect(await countRecoveryDuties(id)).toBe(recoveriesBefore + 1); // exactly ONE inspection duty
  });
});
