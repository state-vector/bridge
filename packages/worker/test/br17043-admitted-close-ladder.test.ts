import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMITTED_CLOSE_REFUSAL_BOUND,
  CHILD_OF_FANOUT_AUDIT,
  LIMITS,
  admittedCloseParkBrief,
  admittedCloseRefusalLadder,
  parseOpenChildrenFromRefusal,
} from "../src/kb/core";

/**
 * BR#17043 — the carry/sweep terminal-admission close is BOUNDED, and rollup
 * membership never regenerates child_of onto a (cured) root blocker.
 *
 * The live defect (breach BR#16873, key BR#4728|gate:open-children): the
 * merged-provenance carry retried the terminal admission close every ~60s
 * for 7h+ against a SEMANTIC gate refusal (done-open-children) — 197 of the
 * card's last 200 history versions were merged_admission_close_refused.
 * Sibling specimens: BR#15597, BR#15638, BR#6073 (per-minute refusals naming
 * a stale verification while a fresh exact-head acceptance was already done).
 *
 * Law pinned here:
 *   1. admittedCloseRefusalLadder (BR#4403 law applied to the carry): a
 *      semantic gate refusal is TERMINAL for the attempt — ADMITTED_CLOSE_
 *      REFUSAL_BOUND audited refusals, then the admission PARKS as a typed
 *      wait on the first named child's terminal event (children-terminal) or
 *      a bounded time re-arm (gate-cleared) with ONE close-bounce brief
 *      (BR#8071 pattern) naming the exact child + owner. Infra/5xx-shaped
 *      errors stay retryable-audited and never advance the bound.
 *   2. The live carry folds SILENTLY while the parked children are open —
 *      no per-tick audited events — and re-arms a fresh bounded ladder once
 *      every parked child is terminal (drill: close the child → sweep → the
 *      parent closes done on the already-landed stamp; nothing re-queues).
 *   3. Rollup membership (BR#4894 spec b): members ride 'relates' + the
 *      meta.root_blocker pointer, NEVER child_of — the rollup can no longer
 *      regenerate the edges BR#5841 ordered detached (BR#4728), and the
 *      boost cascade still reaches members through the pointer.
 *   4. Hygiene: child_of fan-out past LIMITS.childOfFanoutAudit audits
 *      (`child_of_fanout_high`) — loud, never a refusal.
 *
 * The audited exact-edge unlink for the remaining historical links is
 * BR#15717's admin.child_link_inspect/admin.child_link_remove (already on
 * main) — this card's scope is the ladder, the spawn matrix and the
 * root_edges_v1 membership backfill only.
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

const versions = async (id: string) =>
  ((await kbJson(`/history?id=${encodeURIComponent(id)}`)).body?.versions ?? []) as Array<{ action: string; summary: string }>;

const countVersions = async (id: string, action: string) =>
  (await versions(id)).filter((v) => v.action === action).length;

/** A provenance merge receipt for (repo, n) via a train merged event. */
const stampProvenance = async (repo: string, n: number, mergeSha: string, headSha: string, gw: string) => {
  await kbJson("/train.lane", { repo, base: "main", actor: "drill", spec: { required_workflows: ["Test"] } });
  const a = await kbJson("/train.lease", { repo, base: "main", action: "acquire", actor: gw });
  expect(a.body.error ?? "", `lease failed: ${JSON.stringify(a.body)}`).toBe("");
  const ev = await kbJson("/train.event", { repo, base: "main", kind: "merged", actor: gw, pr: n, merge_sha: mergeSha, head_sha: headSha });
  expect(ev.body.error ?? "", `train.event failed: ${JSON.stringify(ev.body)}`).toBe("");
};

/** Close the hub-SPAWNED verify duty with a typed accepted_pr. */
const acceptSpawnedReview = async (dutyId: string, task_id: string, legs: { repo: string; number: number; head_sha_at_acceptance: string }[]) => {
  const session = `fixture-review-${crypto.randomUUID()}`;
  expect((await kbJson("/transition", { id: dutyId, to: "in_progress", actor: "fixture-reviewer", session })).status).toBe(200);
  const closed = await kbJson("/transition", { id: dutyId, to: "done", actor: "fixture-reviewer", session,
    note: legs.map(l => `https://github.com/${l.repo}/pull/${l.number} head ${l.head_sha_at_acceptance}`).join("; "),
    review_result: { kind: "accepted_pr", task_id, legs, subject_revision: (await get(dutyId))?.meta?.review_subject?.revision } });
  expect(closed.status, `spawned duty close failed: ${JSON.stringify(closed.body)}`).toBe(200);
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

// ---------- tier 1: the bounded ladder (pure, core.ts) ----------

const OPEN_CHILDREN_ERROR =
  "parent BR#4728 still has 2 open child task(s) — finish or close them first (decomposition owns its children). " +
  "Open child: BR#5185 (blocked), BR#8726 (in_progress). If a child is genuinely unclosable, force-close with reasons";

describe("parseOpenChildrenFromRefusal (the gate's named-children half, BR#5370 finding B)", () => {
  it("parses the done-open-children refusal text into ids + statuses", () => {
    expect(parseOpenChildrenFromRefusal(OPEN_CHILDREN_ERROR)).toEqual([
      { id: "BR#5185", status: "blocked" },
      { id: "BR#8726", status: "in_progress" },
    ]);
  });
  it("tolerates the plural header and bare ids", () => {
    expect(parseOpenChildrenFromRefusal("still has 2 open child task(s). Open children: BR#12 (todo), BR#13.")).toEqual([
      { id: "BR#12", status: "todo" },
      { id: "BR#13", status: "unknown" },
    ]);
  });
  it("returns [] when the refusal names no child (different gate)", () => {
    expect(parseOpenChildrenFromRefusal("gate: done-unreviewed — the delivery has never been reviewed")).toEqual([]);
  });
});

describe("admittedCloseRefusalLadder (BR#4403 law applied to the carry)", () => {
  it("audits semantic gate refusals 1..bound, then parks on the next one", () => {
    let refusals = 0;
    for (let i = 1; i <= ADMITTED_CLOSE_REFUSAL_BOUND; i++) {
      const v = admittedCloseRefusalLadder(refusals, OPEN_CHILDREN_ERROR);
      expect(v.action).toBe("audit");
      refusals = v.refusal;
      expect(refusals).toBe(i);
    }
    const park = admittedCloseRefusalLadder(refusals, OPEN_CHILDREN_ERROR);
    if (park.action !== "park") throw new Error(`expected park, got action=${park.action}`);
    expect(park.children).toEqual([
      { id: "BR#5185", status: "blocked" },
      { id: "BR#8726", status: "in_progress" },
    ]);
  });
  it("infra-shaped errors stay retryable-audited and never advance the bound", () => {
    const v1 = admittedCloseRefusalLadder(0, "internal_error: Durable Object reset (5xx)");
    expect(v1).toEqual({ action: "audit", refusal: 0 });
    const v2 = admittedCloseRefusalLadder(3, "storage-shard timeout");
    expect(v2).toEqual({ action: "audit", refusal: 3 });
  });
  it("parks even when the gate names no child (gate-cleared shape)", () => {
    const v = admittedCloseRefusalLadder(ADMITTED_CLOSE_REFUSAL_BOUND, "gate: done-unreviewed — the delivery has never been reviewed");
    if (v.action !== "park") throw new Error(`expected park, got action=${v.action}`);
    expect(v.children).toEqual([]);
  });
});

describe("admittedCloseParkBrief (the single close-bounce, BR#8071 pattern + BR#6073 feedback)", () => {
  it("names the bound, the landed legs, every child with its owner, and the next action", () => {
    const brief = admittedCloseParkBrief({
      parentId: "BR#4728", via: "admission-replay",
      legs: [{ repo: "state-vector/superpositional", number: 2868, mergeSha: "a153174447a2abcdef0123456789abcdef01234567" }],
      children: [{ id: "BR#5185", status: "blocked", owner: "ip-172-31-1-230/opencode" }, { id: "BR#8726", status: "in_progress" }],
      bound: ADMITTED_CLOSE_REFUSAL_BOUND,
    });
    expect(brief).toContain("after 3 gate refusals");
    expect(brief).toContain("superpositional#2868 merged as a1531744");
    expect(brief).toContain("BR#5185 (blocked, owner ip-172-31-1-230/opencode)");
    expect(brief).toContain("BR#8726 (in_progress, ownerless)");
    expect(brief).toContain("Next action: finish or close BR#5185");
    expect(brief).toContain("fold silently");
  });
  it("stays honest when the gate named no child", () => {
    const brief = admittedCloseParkBrief({ parentId: "BR#1", via: "observed-merge-carry", legs: [], children: [], bound: 3 });
    expect(brief).toContain("named no specific child");
    expect(brief).toContain("clear the gate the refusal names");
  });
});

it("the fan-out audit threshold is a LIMITS constant (audit-only, never a refusal)", () => {
  expect(LIMITS.childOfFanoutAudit).toBe(CHILD_OF_FANOUT_AUDIT);
  expect(LIMITS.childOfFanoutAudit).toBeGreaterThan(0);
});

// ---------- tier 2: the real carry, against the bundled worker ----------

describe("BR#17043 leg 1 — the carry's close ladder: bounded refusals → typed park → silent fold → resume", () => {
  it("refuses 3 times, parks on the 4th, folds silently, and closes when the child goes terminal", async () => {
    const REPO = "state-vector/br17043-ladder";
    const N = 17043;
    const HEAD = "1".repeat(40);
    const SHA = "2".repeat(40);
    await stampProvenance(REPO, N, SHA, HEAD, "gw-br17043-a");

    const parent = await task("BR#17043 bounded-ladder specimen (root blocker)");
    const child = await task("BR#17043 blocking child specimen");
    expect((await kbJson("/link", { src: child, relation: "child_of", dst: parent })).status).toBe(200);

    // The live BR#16873 shape: the parent sits IN_REVIEW with an accepted
    // admission pending. The replay's hold fence skips in_review parents,
    // so every alarm tick re-drives the terminal admission close against
    // the done-open-children gate refusal — the ~60s livelock cadence.
    expect((await kbJson("/transition", { id: parent, to: "in_progress", actor: "drill-owner-a", note: "impl" })).status).toBe(200);
    const review = await kbJson("/transition", {
      id: parent, to: "in_review", actor: "drill-owner-a",
      note: `delivered https://github.com/${REPO}/pull/${N} head ${HEAD}`,
    });
    expect(review.status, `in_review failed: ${JSON.stringify(review.body)}`).toBe(200);
    // the in_review spawn owns the verdict: accept via the SPAWNED verify
    // duty (the canonical flow — the spawned round must be consumed, or it
    // counts as a second open child at the gate)
    const spawnedDuty = String((review.body as any).verify_task ?? "");
    expect(spawnedDuty, `no verify duty spawned on in_review: ${JSON.stringify(review.body)}`).toMatch(/^BR#\d+$/);
    await acceptSpawnedReview(spawnedDuty, parent, [{ repo: REPO, number: N, head_sha_at_acceptance: HEAD }]);

    // refusal 1: the landed stamp stands, the card is mid-ladder (not done)
    expect((await get(parent)).status).toBe("in_review");
    expect(await countVersions(parent, "merged_admission_close_refused")).toBe(1);
    expect(await countVersions(parent, "merged_admission_close_parked")).toBe(0);

    // refusals 2 and 3 — the alarm cadence re-drives the carried admission
    // (the live ~60s tick: the admission row stays PENDING after a refused
    // close, and an in_review parent never trips the replay's hold fence):
    // still inside the bound, still audited, still no park
    expect((await kbJson("/admin.alarm_sweep")).body.error ?? "").toBe("");
    expect((await kbJson("/admin.alarm_sweep")).body.error ?? "").toBe("");
    expect((await get(parent)).status).toBe("in_review");
    expect(await countVersions(parent, "merged_admission_close_refused")).toBe(3);
    expect(await countVersions(parent, "merged_admission_close_parked")).toBe(0);

    // refusal 4 — past the bound: ONE typed park with the bounce brief
    await kbJson("/admin.alarm_sweep");
    const parkedRow = await get(parent);
    expect(parkedRow.status).toBe("blocked");
    expect(parkedRow.meta?.merge_train?.close_parked?.reason).toBe("open-children");
    expect(parkedRow.meta?.merge_train?.close_parked?.children?.map((c: any) => c.id)).toEqual([child]);
    expect(parkedRow.meta?.blocked?.await_event).toEqual({ event: "br_done", id: child });
    // no live-writer marker may survive the park — it would fence the resume
    expect(parkedRow.meta?.interactive_execution).toBeUndefined();
    expect(await countVersions(parent, "merged_admission_close_parked")).toBe(1);
    const brief = (await versions(parent)).find((v) => v.action === "merged_admission_close_parked")?.summary ?? "";
    expect(brief).toContain(`finish or close ${child}`);
    expect(await countVersions(parent, "merged_admission_close_refused")).toBe(3);

    // further ticks fold SILENTLY — no per-tick audited events (BR#16873 law)
    await kbJson("/admin.alarm_sweep");
    await kbJson("/admin.alarm_sweep");
    expect(await countVersions(parent, "merged_admission_close_refused")).toBe(3);
    expect(await countVersions(parent, "merged_admission_close_parked")).toBe(1);
    expect((await get(parent)).status).toBe("blocked");

    // the child goes terminal → the merged-park sweep resumes the carry on a
    // fresh ladder and closes on the already-landed stamp (no re-queue, no
    // fresh duty). The cure itself rides the same machinery the board uses:
    // the child's own PR lands, its spawned verify duty accepts, and the
    // merged-provenance carry closes the child done.
    const CREPO = "state-vector/br17043-child";
    const CN = 101;
    const CHEAD = "9".repeat(40);
    const CSHA = "8".repeat(40);
    await stampProvenance(CREPO, CN, CSHA, CHEAD, "gw-br17043-a");
    expect((await kbJson("/transition", { id: child, to: "in_progress", actor: "drill-owner-a", note: "child work" })).status).toBe(200);
    const childReview = await kbJson("/transition", {
      id: child, to: "in_review", actor: "drill-owner-a",
      note: `child delivered https://github.com/${CREPO}/pull/${CN} head ${CHEAD}`,
    });
    expect(childReview.status, `child in_review failed: ${JSON.stringify(childReview.body)}`).toBe(200);
    await acceptSpawnedReview(String((childReview.body as any).verify_task ?? ""), child,
      [{ repo: CREPO, number: CN, head_sha_at_acceptance: CHEAD }]);
    expect((await get(child)).status, "the child's own carried admission did not close it").toBe("done");
    const sweep = await kbJson("/admin.alarm_sweep");
    expect(sweep.body.error ?? "").toBe("");
    const cur = await get(parent);
    expect(cur.status).toBe("done");
    expect(cur.meta?.merge_train?.state).toBe("landed");
    expect(cur.meta?.merge_train?.legs?.[String(N)]).toMatchObject({ state: "landed", merge_sha: SHA });
    expect(cur.meta?.merge_train?.close_parked).toBeUndefined();
    // hygiene: the ladder is per-admission state — a closed card carries no
    // refusal counter or park marker forward
    expect(cur.meta?.merge_train?.close_refusals).toBeUndefined();
    // the ladder never minted past its bound, and the park cleared exactly once
    expect(await countVersions(parent, "merged_admission_close_refused")).toBe(3);
    expect(await countVersions(parent, "merged_admission_close_parked")).toBe(1);
    expect(await countVersions(parent, "merged_admission_park_cleared")).toBe(1);

    // steady state: more ticks mint NOTHING — the livelock is dead
    await kbJson("/admin.alarm_sweep");
    await kbJson("/admin.alarm_sweep");
    expect((await get(parent)).status).toBe("done");
    expect(await countVersions(parent, "merged_admission_close_refused")).toBe(3);
    expect(await countVersions(parent, "merged_admission_close_parked")).toBe(1);
    expect(await countVersions(parent, "merged_admission_park_cleared")).toBe(1);
  });
});

describe("BR#17043 leg 2 — rollup membership rides 'relates' and never regenerates child_of (BR#4894 spec b)", () => {
  it("stamps members relates + root_blocker, boosts through the pointer, and never links child_of", async () => {
    const REPO = "state-vector/br17043-rollup";
    const N = 4242;
    const member = async (label: string) => {
      const id = await task(`BR#17043 rollup member ${label}`);
      expect((await kbJson("/transition", { id, to: "in_progress", actor: "drill-owner-b", note: "impl" })).status).toBe(200);
      const blocked = await kbJson("/transition", {
        id, to: "blocked", actor: "drill-owner-b",
        note: `merge https://github.com/${REPO}/pull/${N} to unblock`,
        await_event: { event: "pr_merged", repo: REPO, n: N },
      });
      expect(blocked.status, `member park failed: ${JSON.stringify(blocked.body)}`).toBe(200);
      return id;
    };
    const m1 = await member("one");
    const m2 = await member("two");
    const m3 = await member("three");

    const sweep = await kbJson("/admin.alarm_sweep");
    expect(sweep.body.error ?? "").toBe("");

    const roots = new Set<string>();
    for (const m of [m1, m2, m3]) {
      const row = await get(m);
      const rootId = row.meta?.root_blocker;
      expect(rootId, `member ${m} was not stamped with a root blocker`).toMatch(/^BR#\d+$/);
      roots.add(String(rootId));
      const rel = (await kbJson("/relations", { id: m })).body.relations ?? [];
      const edges = rel.filter((r: any) => r.dir === "out" && r.artefact_id === String(rootId));
      expect(edges.length).toBeGreaterThanOrEqual(1);
      for (const e of edges) expect(e.relation).toBe("relates");
      expect(rel.some((r: any) => r.dir === "out" && r.relation === "child_of" && r.artefact_id === String(rootId))).toBe(false);
    }
    expect(roots.size).toBe(1); // ONE root per cluster
    const rootId = [...roots][0];
    const root = await get(rootId);
    expect(root.status).not.toBe("done");
    // the boost cascade still reaches members through the root_blocker pointer
    expect(root.meta?.boosted).toBeTruthy();
    for (const m of [m1, m2, m3]) expect((await get(m)).meta?.boosted).toBeTruthy();
  });
});

describe("BR#17043 leg 3 — child_of fan-out audit (hygiene, audit-only)", () => {
  it("still links past the audit threshold — loud visibility, never a refusal", async () => {
    const parent = await task("BR#17043 fan-out specimen parent");
    for (let i = 0; i <= LIMITS.childOfFanoutAudit; i++) {
      const c = await task(`BR#17043 fan-out child ${i}`);
      const r = await kbJson("/link", { src: c, relation: "child_of", dst: parent });
      expect(r.status, `link ${i} failed: ${JSON.stringify(r.body)}`).toBe(200);
    }
    expect((await kbJson("/relations", { id: parent })).body.relations.filter((r: any) => r.dir === "in").length)
      .toBe(LIMITS.childOfFanoutAudit + 1);
  });
});
