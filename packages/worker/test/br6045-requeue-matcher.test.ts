import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * BR#6045 — the direct re-queue gate is prefix-brittle: accept notes opening
 * `merge-train: re-queued` (the semantically-equivalent re-queue spelling a
 * fresh verify writes after a bounce) failed the old
 * startsWith("merge-train: queued") gate, so trainQueueOnAccept silently
 * never fired — no stamp fold-forward, no state=queued — and the next drain
 * walk bounced the card for coverage against the STALE stamp (live receipt:
 * BR#5646 bounce #2 / PR superpositional#2555, the same verified head
 * e8120cf75 bounced twice, the only delta the one-word note prefix; the
 * canonical re-render at 03:44Z queued fine, proving grammar not substance).
 *
 * Fix (a): the gate matches /^merge-train: (?:re-)?queued/ (core.ts
 * MERGE_TRAIN_QUEUE_NOTE_RX). Fix (b, BR#5674 P1 empty-is-loud): a blocked
 * note that opens `merge-train: ` but matches NO machine hook is audited
 * loud (`queue_hook_unmatched`) instead of vanishing — the silent no-op is
 * what turned a one-word prefix miss into a bounce loop.
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

const getVersions = async (id: string) => {
  const r = await kb(`/history?id=${encodeURIComponent(id)}`);
  expect(r.status).toBe(200);
  return (((await r.json()) as any).versions ?? []) as Array<Record<string, any>>;
};

/** A task stamped with a single bound PR leg at `head` and left IN_PROGRESS
 *  (a fresh verify pickup over a stale stamp — the BR#5646 receipt shape). */
const pickupCard = async (title: string, number: number, head: string, trainState = "bounced") => {
  const created = await post("/create", {
    type: "task",
    title,
    meta: {
      pr: { repo: REPO, number, head_sha_at_acceptance: head, base: "main" },
      prs: [{ repo: REPO, number, head_sha_at_acceptance: head, base: "main" }],
      merge_train: { state: trainState, pr: number, repo: REPO, at: Date.now() },
    },
  });
  expect(created.status).toBe(200);
  const id = ((await created.json()) as any).id as string;
  expect((await post("/transition", { id, to: "in_progress", note: "fresh verify pickup over the stale stamp" })).status).toBe(200);
  return id;
};

describe("BR#6045: the re-queued spelling binds like the canonical one (fix a)", () => {
  it("the live receipt — a 'merge-train: re-queued — VERIFY ACCEPT … head <sha>' park refreshes the stamp, flips state to queued, and records the train_queued version", async () => {
    const id = await pickupCard("BR#6045 re-queued accept specimen", 25551, OLD);
    const park = await post("/transition", {
      id, to: "blocked",
      note: `merge-train: re-queued — VERIFY ACCEPT (duty BR#6045-t1, fresh session, live gh 2026-11-04). PR ${REPO}#25551 head ${NEW}. VERIFY GATE 5c PASS.`,
      await_event: { event: "pr_merged", repo: REPO, n: 25551 },
    });
    expect(park.status).toBe(200);
    const now = await getOne(id);
    expect(now.status).toBe("blocked");
    // the stamp folded forward to the note's live head — the drain walk's
    // coverage leg can no longer bounce the already-accepted head (the
    // BR#5646 bounce #2 class is dead)
    expect(now.meta?.pr?.head_sha_at_acceptance).toBe(NEW);
    expect(now.meta?.prs?.[0]?.head_sha_at_acceptance).toBe(NEW);
    // queued, bounce residue cleared
    expect(now.meta?.merge_train?.state).toBe("queued");
    expect(now.meta?.merge_train?.pr).toBe(25551);
    expect(now.meta?.merge_train?.repo).toBe(REPO);
    // the accept is audited on the card's version trail: train_queued with
    // the (re-queued, stamp refreshed) honesty suffix
    const queued = (await getVersions(id)).find((v) => v.action === "train_queued");
    expect(queued, "the train_queued version row").toBeTruthy();
    expect(String(queued?.summary ?? "")).toContain("re-queued");
    expect(String(queued?.summary ?? "")).toContain("stamp refreshed");
  });

  it("the canonical 'merge-train: queued' prefix keeps binding (no regression)", async () => {
    const id = await pickupCard("BR#6045 canonical accept specimen", 25552, OLD);
    const park = await post("/transition", {
      id, to: "blocked",
      note: `merge-train: queued — VERIFY ACCEPT (duty BR#6045-t2). PR ${REPO}#25552 head ${NEW}.`,
      await_event: { event: "pr_merged", repo: REPO, n: 25552 },
    });
    expect(park.status).toBe(200);
    const now = await getOne(id);
    expect(now.meta?.pr?.head_sha_at_acceptance).toBe(NEW);
    expect(now.meta?.merge_train?.state).toBe("queued");
  });
});

describe("BR#6045: empty-is-loud — a merge-train note matching no hook is audited, not silent (fix b, BR#5674 P1)", () => {
  it("a 'merge-train:' park note that no hook binds leaves the stamp alone AND writes queue_hook_unmatched", async () => {
    const id = await pickupCard("BR#6045 unmatched-note specimen", 25553, OLD);
    const park = await post("/transition", {
      id, to: "blocked",
      note: `merge-train: bounced — rig near-miss (queue_hook_unmatched specimen, BR#6045)`,
      await_event: { event: "pr_merged", repo: REPO, n: 25553 },
    });
    expect(park.status).toBe(200);
    const now = await getOne(id);
    expect(now.status).toBe("blocked");
    // the hook did NOT fire — the stamp and the train state stand untouched
    expect(now.meta?.pr?.head_sha_at_acceptance).toBe(OLD);
    expect(now.meta?.merge_train?.state).toBe("bounced");
    // and it is LOUD: the unmatched note is on the version trail
    const unmatched = (await getVersions(id)).find((v) => v.action === "queue_hook_unmatched");
    expect(unmatched, "the queue_hook_unmatched version row").toBeTruthy();
    expect(String(unmatched?.summary ?? "")).toContain("matched no machine queue hook");
  });

  it("a non-train park note writes no queue_hook_unmatched noise", async () => {
    const id = await pickupCard("BR#6045 quiet non-train park specimen", 25554, OLD);
    const park = await post("/transition", {
      id, to: "blocked",
      note: "CLOSE-PARK PENDING DISPOSITION — parked on ask BR#9999 (rig)",
      await_event: { event: "br_done", id: "BR#9999" },
    });
    expect(park.status).toBe(200);
    const now = await getOne(id);
    expect(now.meta?.pr?.head_sha_at_acceptance).toBe(OLD);
    expect((await getVersions(id)).some((v) => v.action === "queue_hook_unmatched")).toBe(false);
  });
});
