import { Miniflare } from "miniflare";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isAwaitingMerge, mergePhaseOf } from "@bridge/contracts";

/**
 * BR#6330 / BR#6332 — ONE merge classification (decision BR#6330).
 *
 * The live defect (2026-11-05): Backlog's "Awaiting PR merge — train" group
 * counted 49 cards while the trains held 3–4 — two classifications (UI
 * prose/regex + await_event census vs the executor's derived queue), and the
 * delta was stranded state: nine cards for ALREADY-MERGED PRs still parked
 * "awaiting-ci" because the settle-close owed them rode a pass interrupted
 * by red cycles / out-of-band pushes.
 *
 * Fix legs pinned here:
 *   1. exitClassOf (ui-kit views.ts) classifies the merge group from the
 *      typed merge_train phase ONLY (queued|awaiting-ci) — the TRAIN_RX /
 *      GH_PR_RX prose regexes are deleted, and per BR#6395 the pr_merged
 *      await_event legacy bridge is DELETED too: a pr_merged wait with no
 *      live train phase files under the "not on train" class, never the
 *      train class (source assertions below).
 *   2. The canonical closed phase + predicate live in @bridge/contracts
 *      (unit-pinned below; ui-kit mirrors it with a MUST-STAY-IN-SYNC note).
 *   3. sweepMergedParks (alarm cadence) closes a blocked queued/awaiting-ci
 *      card whose PR leg carries a provenance merge receipt — the hub's own
 *      merge record, zero GitHub calls. Multi-leg cards re-queue to the
 *      next unlanded leg instead of closing. Cards without a receipt are
 *      untouched (live queue slots are never guess-closed).
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

/** A parked queued car: claimed, verify-accepted onto the train (the
 *  canonical park stamps merge_train.state=queued + the pr leg). */
const parkQueuedCar = async (id: string, repo: string, n: number, actor: string, head: string) => {
  expect((await kbJson("/transition", { id, to: "in_progress", actor, note: "impl" })).status).toBe(200);
  const park = await kbJson("/transition", {
    id, to: "blocked", actor,
    note: `merge-train: queued — VERIFY ACCEPT (drill). PR ${repo}#${n} head ${head}.`,
    await_event: { event: "pr_merged", repo, n },
  });
  expect(park.status, `park failed: ${JSON.stringify(park.body)}`).toBe(200);
  const cur = (await kbJson("/get", { id })).body;
  expect(cur.meta?.merge_train?.state).toBe("queued");
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

describe("BR#6330 leg 1 — contracts: the closed phase + the one predicate", () => {
  it("mergePhaseOf normalises the closed set; isAwaitingMerge is queued|awaiting-ci only", () => {
    expect(mergePhaseOf({ merge_train: { state: "queued" } })).toBe("queued");
    expect(mergePhaseOf({ merge_train: { state: "awaiting-ci" } })).toBe("awaiting-ci");
    expect(mergePhaseOf({ merge_train: { state: "bounced" } })).toBe("bounced");
    expect(mergePhaseOf({ merge_train: { state: "awaiting" } })).toBe("awaiting");
    expect(mergePhaseOf({ merge_train: { state: "unbound" } })).toBe("unbound");
    expect(mergePhaseOf({ merge_train: { state: "base-red-park" } })).toBe("base-red-park");
    expect(mergePhaseOf({ merge_train: { state: "landed" } })).toBe("landed");
    expect(mergePhaseOf({ merge_train: { state: "garbage" } })).toBeNull();
    expect(mergePhaseOf({})).toBeNull();
    expect(mergePhaseOf(undefined)).toBeNull();
    expect(isAwaitingMerge({ merge_train: { state: "queued" } })).toBe(true);
    expect(isAwaitingMerge({ merge_train: { state: "awaiting-ci" } })).toBe(true);
    // NOT awaiting merge: the review park, the bounce, the unbind, the close
    expect(isAwaitingMerge({ merge_train: { state: "awaiting" } })).toBe(false);
    expect(isAwaitingMerge({ merge_train: { state: "bounced" } })).toBe(false);
    expect(isAwaitingMerge({ merge_train: { state: "unbound" } })).toBe(false);
    expect(isAwaitingMerge({ merge_train: { state: "landed" } })).toBe(false);
    // prose never classifies — the field is the single source
    expect(isAwaitingMerge({ merge_train: { state: "bounced" }, blocked: { reason: "merge-train: queued — prose lie" } })).toBe(false);
  });
});

describe("BR#6330 leg 2 — exitClassOf: one classification, no prose path (source assertions)", () => {
  const viewsSrc = readFileSync(new URL("../../ui-kit/src/server/views.ts", import.meta.url).pathname, "utf8");
  it("the merge class reads the typed phase; the prose TRAIN/PR regexes are deleted", () => {
    expect(viewsSrc).not.toMatch(/TRAIN_RX/);
    expect(viewsSrc).not.toMatch(/GH_PR_RX/);
    expect(viewsSrc).toMatch(/phase === "queued" \|\| phase === "awaiting-ci"/);
    expect(viewsSrc).toMatch(/phase === "awaiting"\) return EXIT_CLASSES\.awaiting/);
  });
  it("BR#6395: the pr_merged legacy bridge is DELETED — phase-only admission, non-train PR waits file under the pr class", () => {
    expect(viewsSrc).not.toMatch(/phase === null && \(ev === "pr_merged" \|\| ev === "br_pr_merged"\)/);
    expect(viewsSrc).toMatch(/phase === "conflicting"\) return EXIT_CLASSES\.conflict/);
    expect(viewsSrc).toMatch(/EXIT_CLASSES\.pr/);
  });
});

describe("BR#6330 leg 3 — sweepMergedParks heals stranded merged parks on the provenance receipt", () => {
  it("closes a queued car whose PR has a provenance merge receipt (lifecycle-legal, receipt cited)", async () => {
    const REPO = "state-vector/br6330-heal";
    const N = 6330;
    const HEAD = "1".repeat(40);
    const SHA = "2".repeat(40);
    await stampProvenance(REPO, N, SHA, HEAD, "gw-br6330-a");
    const id = await task("BR#6330 merged-park heal specimen");
    await parkQueuedCar(id, REPO, N, "drill-owner-a", HEAD);
    const sweep = await kbJson("/admin.alarm_sweep");
    expect(sweep.body.error ?? "").toBe("");
    const cur = (await kbJson("/get", { id })).body;
    expect(cur.status, `card should be done, got ${cur.status}`).toBe("done");
    expect(cur.meta?.merge_train?.state).toBe("landed");
    expect(cur.meta?.merge_train?.via).toBe("merged-park-heal");
    expect(String(cur.meta?.merge_train?.merge_sha ?? "")).toBe(SHA);
    const hist = (await kbJson(`/history?id=${encodeURIComponent(id)}`)).body;
    const notes = (hist?.versions ?? []).map((v: any) => `${v?.summary ?? ""}\n${v?.action ?? ""}`).join("\n");
    expect(notes).toMatch(/merged-park heal/);
  });

  it("multi-leg card: the merged leg stamps landed, the card re-queues to the remaining leg (no close)", async () => {
    const REPO = "state-vector/br6330-multi";
    const N1 = 6331, N2 = 6332;
    const HEAD = "3".repeat(40);
    const SHA = "4".repeat(40);
    await stampProvenance(REPO, N1, SHA, HEAD, "gw-br6330-b");
    const id = await task("BR#6330 multi-leg specimen");
    expect((await kbJson("/transition", { id, to: "in_progress", actor: "drill-owner-b", note: "impl" })).status).toBe(200);
    const park = await kbJson("/transition", {
      id, to: "blocked", actor: "drill-owner-b",
      note: `merge-train: queued — VERIFY ACCEPT (drill). PR ${REPO}#${N1} head ${HEAD}, PR ${REPO}#${N2} head ${"5".repeat(40)}.`,
      await_event: { event: "pr_merged", repo: REPO, n: N1 },
    });
    expect(park.status, `park failed: ${JSON.stringify(park.body)}`).toBe(200);
    // force the multi-leg shape: both legs stamped
    const upd = await kbJson("/update", { id, meta: {
      prs: [
        { repo: REPO, number: N1, head_sha_at_acceptance: HEAD, base: "main" },
        { repo: REPO, number: N2, head_sha_at_acceptance: "5".repeat(40), base: "main" },
      ],
    } });
    expect(upd.status).toBeLessThan(400);
    const sweep = await kbJson("/admin.alarm_sweep");
    expect(sweep.body.error ?? "").toBe("");
    const cur = (await kbJson("/get", { id })).body;
    expect(cur.status).toBe("blocked");
    expect(cur.meta?.merge_train?.state).toBe("queued");
    expect(cur.meta?.merge_train?.legs?.[String(N1)]?.state).toBe("landed");
    expect(cur.meta?.merge_train?.legs?.[String(N1)]?.via).toBe("merged-park-heal");
    expect(Number(cur.meta?.merge_train?.remaining ?? 0)).toBe(1);
  });

  it("a queued car WITHOUT a merge receipt is untouched (live queue slots are never guess-closed)", async () => {
    const REPO = "state-vector/br6330-live";
    const N = 6333;
    const id = await task("BR#6330 live-slot specimen");
    await parkQueuedCar(id, REPO, N, "drill-owner-c", "6".repeat(40));
    const sweep = await kbJson("/admin.alarm_sweep");
    expect(sweep.body.error ?? "").toBe("");
    const cur = (await kbJson("/get", { id })).body;
    expect(cur.status).toBe("blocked");
    expect(cur.meta?.merge_train?.state).toBe("queued");
    expect(cur.meta?.blocked?.await_event).toEqual({ event: "pr_merged", repo: REPO, n: N });
  });
});
