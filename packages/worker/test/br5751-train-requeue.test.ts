import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * BR#5751 — the direct parent re-queue park must go through trainQueueOnAccept.
 *
 * Defect (BR#5674 Mission 2+3 audit): verifier sessions re-verified a card and
 * transitioned the PARENT directly in_progress → blocked with the canonical
 * `merge-train: queued — VERIFY ACCEPT ... head <sha>` note. doTransition never
 * invoked trainQueueOnAccept on that path, so:
 *   1. meta.pr/meta.prs head_sha_at_acceptance stayed at the OLD pre-sync SHA
 *      (BR#4711: e4ecfd686... stamped while PR #2518 lived at ae806a2b4...,
 *      BR#4995: 9b7525b65... vs 083a74077...) — the first drain walk's
 *      verdictCoversHeadLeg bounces every one of them for coverage;
 *   2. meta.merge_train stayed `awaiting` with its awaiting stamp — the card
 *      sat in lane.queue AND lane.awaiting at once (BR#4711/4678/3623/3999/
 *      4995 ghost rows);
 *   3. a NON-train re-park (BR#4999: parked on an ask) left merge_train.state
 *      = `awaiting` behind — a ghost awaiting row for a card whose PR was
 *      closed and whose park was on a question;
 *   4. laneAwaitingRows/prStats matched cards on repo alone — another base's
 *      card leaked into this lane's awaiting/pr_stats counts (BR#4977's law
 *      applied to the awaiting leg).
 */

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
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

/** A task stamped with a single bound PR leg at `head` (the verify-accept
 *  stamp shape trainQueueOnAccept writes). */
const prCard = (repo: string, number: number, head: string, base = "main") => ({
  pr: { repo, number, head_sha_at_acceptance: head, base },
  prs: [{ repo, number, head_sha_at_acceptance: head, base }],
});

const awaitingCard = async (title: string, number: number, head: string, base = "main", repo = REPO) => {
  const created = await post("/create", {
    type: "task",
    title,
    meta: {
      ...prCard(repo, number, head, base),
      merge_train: { state: "awaiting", pr: number, repo, awaiting: { at: Date.now(), head_sha: head } },
    },
  });
  expect(created.status).toBe(200);
  const id = ((await created.json()) as any).id as string;
  expect((await post("/transition", { id, to: "in_progress", note: "re-verify pickup" })).status).toBe(200);
  return id;
};

describe("BR#5751: the direct 'merge-train: queued' parent park rides trainQueueOnAccept", () => {
  it("fix 1 — the park re-stamps the note's live head and clears the dual queue/awaiting ghost state", async () => {
    const id = await awaitingCard("BR#5751 direct re-queue specimen", 25181, OLD);
    const park = await post("/transition", {
      id, to: "blocked",
      note: `merge-train: queued — VERIFY ACCEPT (duty BR#5751-t1, live rig 2026-11-03). PR ${REPO}#25181 head ${NEW}. VERIFY GATE 5c PASS.`,
      await_event: { event: "pr_merged", repo: REPO, n: 25181 },
    });
    expect(park.status).toBe(200);
    const now = await getOne(id);
    expect(now.status).toBe("blocked");
    // the stamp moved to the note's live head — the drain walk's coverage leg
    // can no longer bounce the card for a verdict/cover mismatch (BR#4711/4995)
    expect(now.meta?.pr?.head_sha_at_acceptance).toBe(NEW);
    expect(now.meta?.prs?.[0]?.head_sha_at_acceptance).toBe(NEW);
    // the dual queue/awaiting ghost state is gone: queued, awaiting stamp cleared
    expect(now.meta?.merge_train?.state).toBe("queued");
    expect(now.meta?.merge_train?.awaiting).toBeUndefined();
    expect(now.meta?.merge_train?.pr).toBe(25181);
    expect(now.meta?.merge_train?.repo).toBe(REPO);
    // the park keeps the card's own typed await and the canonical reason
    expect(now.meta?.blocked?.reason ?? "").toContain("merge-train: queued");
  });

  it("recursion guard — a machine-managed park (body.merge_train) does not re-run the queue hook", async () => {
    const id = await awaitingCard("BR#5751 machine park specimen", 25182, OLD);
    const park = await post("/transition", {
      id, to: "blocked",
      note: "merge-train: queued — machine-managed re-park (rig)",
      merge_train: true,
    });
    expect(park.status).toBe(200);
    const now = await getOne(id);
    expect(now.status).toBe("blocked");
    // the hook skipped: the stamp and the awaiting state stand untouched
    // (the machine path pre-stamps its own meta before the park)
    expect(now.meta?.pr?.head_sha_at_acceptance).toBe(OLD);
    expect(now.meta?.merge_train?.state).toBe("awaiting");
  });

  it("fix 2 — a non-train park ends the awaiting ghost state (BR#4999)", async () => {
    const id = await awaitingCard("BR#5751 close-park specimen", 25901, OLD);
    const park = await post("/transition", {
      id, to: "blocked",
      note: "CLOSE-PARK PENDING DISPOSITION — parked on ask BR#5686 (rig)",
      await_event: { event: "br_done", id: "BR#5686" },
    });
    expect(park.status).toBe(200);
    const now = await getOne(id);
    expect(now.status).toBe("blocked");
    // demoted out of the awaiting lane; the awaiting stamp is gone
    expect(now.meta?.merge_train?.state).toBe("bounced");
    expect(now.meta?.merge_train?.awaiting).toBeUndefined();
    // the queue hook did NOT fire — the stamp is untouched
    expect(now.meta?.pr?.head_sha_at_acceptance).toBe(OLD);
  });

  it("fix 2 carve-out — a BR#4960 Awaiting-park reason keeps the awaiting park intact", async () => {
    const id = await awaitingCard("BR#5751 awaiting re-assert specimen", 25902, OLD);
    const park = await post("/transition", {
      id, to: "blocked",
      note: `Awaiting review (verdict BR#1234, anchored at head ${OLD.slice(0, 9)}) — re-asserted by the rig`,
      await_event: { event: "pr_merged", repo: REPO, n: 25902 },
    });
    expect(park.status).toBe(200);
    const now = await getOne(id);
    expect(now.status).toBe("blocked");
    // the coverage park stands: state + awaiting stamp preserved
    expect(now.meta?.merge_train?.state).toBe("awaiting");
    expect(now.meta?.merge_train?.awaiting?.head_sha).toBe(OLD);
    expect(now.meta?.pr?.head_sha_at_acceptance).toBe(OLD);
  });
});

describe("BR#5751: the awaiting lane is base-scoped (BR#4977 law on the awaiting leg)", () => {
  it("fix 3 — another base's awaiting card never lists on this lane; pr_stats excludes it too", async () => {
    const lane = await post("/train.lane", { repo: "o/r", base: "main", spec: { required_workflows: ["Test"] } });
    expect(lane.status).toBe(200);

    // awaiting card on THIS lane's base
    const aid = await awaitingCard("BR#5751 awaiting main-base leg", 11, OLD, "main", "o/r");
    await post("/transition", {
      id: aid, to: "blocked",
      note: `Awaiting review (verdict BR#1, anchored at head ${OLD.slice(0, 9)}) — rig park`,
      await_event: { event: "pr_merged", repo: "o/r", n: 11 },
    });
    // awaiting card on ANOTHER base of the same repo — the ghost row class
    const bid = await awaitingCard("BR#5751 awaiting release-base leg", 12, OLD, "release/1", "o/r");
    await post("/transition", {
      id: bid, to: "blocked",
      note: `Awaiting review (verdict BR#2, anchored at head ${OLD.slice(0, 9)}) — rig park`,
      await_event: { event: "pr_merged", repo: "o/r", n: 12 },
    });
    // an in_progress impl card riding the other base — not this lane's impl work
    const c = await post("/create", {
      type: "task",
      title: "BR#5751 release-base impl",
      meta: { ...prCard("o/r", 13, OLD, "release/1"), merge_train: { state: "queued", pr: 13, repo: "o/r" } },
    });
    const cid = ((await c.json()) as any).id as string;
    expect((await post("/transition", { id: cid, to: "in_progress", note: "impl on release/1" })).status).toBe(200);

    const st = await post("/train.status", { repo: "o/r" });
    expect(st.status).toBe(200);
    const lanes = ((await st.json()) as any).lanes as any[];
    const main = lanes.find((l) => l.lane === "o/r@main");
    expect(main, "the o/r@main lane row").toBeTruthy();
    const awaitingIds = (main.awaiting ?? []).map((r: any) => String(r.task));
    expect(awaitingIds).toContain(aid);
    expect(awaitingIds).not.toContain(bid);
    // pr_stats: the release-base impl card is not this lane's in-progress work
    expect(main.pr_stats?.in_progress ?? 0).toBe(0);
  });
});
