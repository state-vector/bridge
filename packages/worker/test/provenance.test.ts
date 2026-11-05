import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseProvenanceSha, prCardRef, signerFromCommits, withinBackfillWindow } from "../src/kb/provenance.ts";

/**
 * PR provenance (BR#3287) guards.
 *
 * Tier 1: the pure helpers — card linkage (branch name first, body fallback),
 * signer classification (BR#3181 classes), sha param validation, backfill
 * window.
 *
 * Tier 2: the real DO drill (bundled worker): the stamp rides the TRAIN now
 * (BR#3516 — the executor's train:merged event is the only provenance writer;
 * the hub holds no VCS credentials, so there is no canned-GitHub leg here):
 * chain on the endpoint + the card · upsert per (repo, pr) · class-only rows
 * for card-less merges · verdict-honesty (no closed verify duty ⇒ null).
 */

// ---------- tier 1: pure helpers ----------

describe("prCardRef (branch name is the authoritative join key)", () => {
  it("resolves from the head branch", () => {
    expect(prCardRef("bridge/BR-3218", "some body")).toBe("BR#3218");
    expect(prCardRef("bridge/BR-903-rebase", "body without refs")).toBe("BR#903");
  });

  it("falls back to the PR text when the branch carries no id", () => {
    expect(prCardRef("chore/random-thing", "Residue leg of BR#2851 (verify round)")).toBe("BR#2851");
  });

  it("null when nothing references a card (the no-provenance signal)", () => {
    expect(prCardRef("chore/random-thing", "no refs here")).toBeNull();
    expect(prCardRef(null, null)).toBeNull();
  });

  it("does not confuse plain numbers or other tokens for cards", () => {
    expect(prCardRef("fix/1234-thing", "issue #1234 and GH #12")).toBeNull();
    expect(prCardRef("bridge/BR-7", "small ids are real ids")).toBe("BR#7");
  });
});

describe("signerFromCommits (BR#3181 classes)", () => {
  const c = (verified: boolean, email = "ray@wirestorm.net") => ({ verified, committer_email: email });

  it("detached-cody wins — the worker class identity", () => {
    expect(signerFromCommits([
      c(true, "297316395+detached-cody@users.noreply.github.com"),
      c(true, "ray@wirestorm.net"),
    ])).toBe("detached-cody");
  });

  it("all signed by rayh -> signed", () => {
    expect(signerFromCommits([c(true), c(true)])).toBe("signed");
  });

  it("mixed -> partially-signed (honest)", () => {
    expect(signerFromCommits([c(true), c(false)])).toBe("partially-signed");
  });

  it("unsigned -> unsigned (the 5c violation class, recorded if it ever merges)", () => {
    expect(signerFromCommits([c(false)])).toBe("unsigned");
  });

  it("empty -> unknown, never a guess", () => {
    expect(signerFromCommits([])).toBe("unknown");
  });
});

describe("parseProvenanceSha (the lookup contract)", () => {
  it("accepts 7-40 hex, lowercases", () => {
    expect(parseProvenanceSha(new URLSearchParams("sha=C28DBD607"))).toBe("c28dbd607");
    expect(parseProvenanceSha(new URLSearchParams(`sha=${"a".repeat(40)}`))).toBe("a".repeat(40));
  });
  it("rejects short/garbage with a user-facing message", () => {
    expect(() => parseProvenanceSha(new URLSearchParams("sha=abc12"))).toThrow(/7-40 hex/);
    expect(() => parseProvenanceSha(new URLSearchParams("sha=zzzzzzz"))).toThrow(/7-40 hex/);
    expect(() => parseProvenanceSha(new URLSearchParams(""))).toThrow(/7-40 hex/);
  });
});

describe("withinBackfillWindow", () => {
  it("accepts recent merges, rejects old/unparseable/missing", () => {
    const now = Date.parse("2026-10-25T00:00:00Z");
    expect(withinBackfillWindow("2026-10-24T12:00:00Z", now, 30)).toBe(Date.parse("2026-10-24T12:00:00Z"));
    expect(withinBackfillWindow("2026-09-01T00:00:00Z", now, 30)).toBeNull();
    expect(withinBackfillWindow("not-a-date", now, 30)).toBeNull();
    expect(withinBackfillWindow(null, now, 30)).toBeNull();
  });
});

// ---------- tier 2: the real DO drill (bundled worker; the stamp rides the
// TRAIN now — BR#3516: the executor's train:merged event is the only provenance
// writer, the hub holds no VCS credentials) ----------

let mf: Miniflare;

const HEAD_SHA = "c61b4869aad07eccdc738200f004d2dbe0a2bf66";
const MERGE_SHA = "c28dbd60764a05eae8bccf4b40d9afed2e425ea7";
const NOCARD_MERGE = "b".repeat(40);
// the verdict-honesty drill: a card whose verify duty never closed — the chain
// must record verdict_id/session null (honest unverified), never a guess
const HEAD2 = "d".repeat(40);
const MERGE2 = "9".repeat(40);

const REPO = "state-vector/bridge";

beforeAll(async () => {
  // same rig recipe as kb-throughput.test.ts: realpath + modulesRoot + useSQLite
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
      compatibilityDate: "2025-09-06",
      durableObjects: { KB: { className: "KnowledgeHub", useSQLite: true } },
    }],
  });
  kbNs = await mf.getDurableObjectNamespace("KB");
});

afterAll(async () => {
  await mf.dispose();
});

let kbNs: any;
const kbJson = async (path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const stub: any = await kbNs.get(kbNs.idFromName("global"));
  const res = await stub.fetch(`https://kb${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
};

/** The drill's delivery chain: impl card (+ optional CLOSED verify duty child
 *  carrying the session), lease acquired, train:merged posted — exactly what
 *  the executor does after `gh pr merge`. */
async function stampViaTrain(opts: {
  pr: number;
  mergeSha: string;
  headSha?: string;
  taskId?: string | null;
  makeChain?: boolean;
  session?: string;
  signer?: string;
}): Promise<{ taskId: string | null; verifyId: string | null }> {
  let taskId = opts.taskId ?? null;
  let verifyId: string | null = null;
  if (opts.makeChain && !taskId) {
    const task = await kbJson("/create", { type: "task", title: "IMPL: train provenance drill", session: "" });
    expect(task.status).toBe(200);
    taskId = String(task.body.id);
  }
  if (opts.makeChain && taskId) {
    // the verify convention (BR#3516 §1): a review-role duty closes done,
    // citing the head it verified + the PR (the receipt the receipts rule
    // demands — and the PR ref the accept hook parses), its session riding
    // meta.session
    const verify = await kbJson("/create", {
      type: "task", title: `VERIFY: provenance drill ${taskId}`, roles: ["review"],
      session: opts.session ?? "bridge-task-BR-drill-verify",
    });
    expect(verify.status).toBe(200);
    verifyId = String(verify.body.id);
    await kbJson("/link", { src: verifyId, relation: "child_of", dst: taskId });
    await kbJson("/transition", { id: verifyId, to: "in_progress", actor: "drill-verifier", note: "drill: verifying" });
    const closed = await kbJson("/transition", {
      id: verifyId, to: "done", actor: "drill-verifier",
      note: `verified head ${opts.headSha ?? HEAD_SHA} (drill) — PR https://github.com/${REPO}/pull/${opts.pr}`,
    });
    expect(closed.status, `verify close failed: ${JSON.stringify(closed.body)}`).toBeLessThan(400);
  }
  // BR#4691: the lane exists and is configured before anything leases/events
  // — the operator's train_lane call (find-or-create, idempotent)
  await kbJson("/train.lane", { repo: REPO, base: "main", actor: "drill", spec: { required_workflows: ["Test"] } });
  const lease = await kbJson("/train.lease", { repo: REPO, base: "main", action: "acquire", actor: "drill-executor" });
  expect(lease.body.error ?? "").toBe("");
  const ev = await kbJson("/train.event", {
    repo: REPO, base: "main", kind: "merged", actor: "drill-executor",
    pr: opts.pr, merge_sha: opts.mergeSha, head_sha: opts.headSha,
    task_id: taskId ?? undefined, signer: opts.signer ?? "merge-train-executor",
  });
  expect(ev.body.error ?? "", `train:merged failed: ${JSON.stringify(ev.body)}`).toBe("");
  await kbJson("/train.lease", { repo: REPO, base: "main", action: "release", actor: "drill-executor" });
  return { taskId, verifyId };
}

describe("provenance DO drill (BR#3287 via the train, BR#3516)", () => {
  it("train:merged stamps the chain; the endpoint returns task · verdict · session · signer", async () => {
    const { taskId, verifyId } = await stampViaTrain({ pr: 185, mergeSha: MERGE_SHA, headSha: HEAD_SHA, makeChain: true, session: "bridge-task-BR-drill-verify" });

    // endpoint: by merge sha → full chain
    const byMerge = await kbJson(`/provenance?sha=${MERGE_SHA.slice(0, 12)}`);
    expect(byMerge.status).toBe(200);
    expect(byMerge.body.error ?? "").toBe("");
    expect(byMerge.body.pr).toBe(185);
    expect(byMerge.body.task.id).toBe(taskId);
    expect(byMerge.body.verdict_id).toBe(verifyId);
    expect(byMerge.body.session).toBe("bridge-task-BR-drill-verify");
    expect(byMerge.body.signer).toBe("merge-train-executor");

    // by head sha → same record
    const byHead = await kbJson(`/provenance?sha=${HEAD_SHA.slice(0, 9)}`);
    expect(byHead.status).toBe(200);
    expect(byHead.body.pr).toBe(185);

    // the card carries its own provenance (board-side storage of record)
    const card = await kbJson(`/artefact?id=${encodeURIComponent(String(taskId))}`);
    expect(card.body.meta.provenance.pr).toBe(185);
    expect(card.body.meta.provenance.signer).toBe("merge-train-executor");
    expect(card.body.meta.provenance.verdict_id).toBe(verifyId);
  });

  it("restamps per (repo, pr) immutably and records class-only provenance for card-less merges", async () => {
    // re-post the same (repo, pr): the row upserts, never duplicates
    const before = await kbJson(`/provenance?sha=${MERGE_SHA.slice(0, 12)}`);
    await stampViaTrain({ pr: 185, mergeSha: MERGE_SHA, headSha: HEAD_SHA, taskId: String(before.body.task.id) });
    const after = await kbJson(`/provenance?sha=${MERGE_SHA.slice(0, 12)}`);
    expect(after.status).toBe(200);
    expect(after.body.task.id).toBe(before.body.task.id);
    expect(after.body.pr).toBe(185);

    // card-less merge (executor crashed the chain, or a drive-by PR): the
    // row still lands — class-only provenance, task null, honest signer
    const noCard = await stampViaTrain({ pr: 186, mergeSha: NOCARD_MERGE, signer: "signed" });
    expect(noCard.taskId).toBeNull();
    const row = await kbJson(`/provenance?sha=${NOCARD_MERGE.slice(0, 12)}`);
    expect(row.status).toBe(200);
    expect(row.body.task).toBeNull();
    expect(row.body.signer).toBe("signed");
  });

  it("machine-plane op + MCP parity: POST /provenance returns the chain; errors contract", async () => {
    const op = await kbJson("/provenance", { sha: MERGE_SHA.slice(0, 12) });
    expect(op.status).toBe(200);
    expect(op.body.pr).toBe(185);
    expect(op.body.task).toBeTruthy();
    const missing = await kbJson("/provenance", { sha: "f".repeat(40) });
    expect(missing.status).toBe(404);
    expect(String(missing.body.error)).toContain("no bridge provenance");
    const bad = await kbJson("/provenance", { sha: "nope" });
    expect(bad.status).toBe(400);
  });

  it("BR#3307 residue: a card whose verify duty never closed → verdict_id null (never a guess)", async () => {
    // the card exists but NO closed review child — the chain has no verdict
    // leg, and the train records exactly that (honest unverified)
    const card2 = await kbJson("/create", { type: "task", title: "IMPL: verdict-honesty drill (BR#3307)" });
    expect(card2.status).toBe(200);
    const { taskId } = await stampViaTrain({ pr: 188, mergeSha: MERGE2, headSha: HEAD2, taskId: String(card2.body.id) });
    const rec = await kbJson(`/provenance?sha=${MERGE2}`);
    expect(rec.status).toBe(200);
    expect(rec.body.task.id).toBe(taskId);
    expect(rec.body.verdict_id).toBeNull();
    expect(rec.body.session).toBeNull();
    // by head sha → the same honest record
    const byHead = await kbJson(`/provenance?sha=${HEAD2.slice(0, 9)}`);
    expect(byHead.status).toBe(200);
    expect(byHead.body.verdict_id).toBeNull();
    // the card stamp is honest too (no verdict leg on the chain)
    const card = await kbJson(`/artefact?id=${encodeURIComponent(String(card2.body.id))}`);
    expect(card.body.meta.provenance.verdict_id).toBeNull();
    expect(card.body.meta.provenance.session).toBeNull();
  });

  it("lookup contract: bad sha → 400, unknown sha → 404", async () => {
    const bad = await kbJson("/provenance?sha=zzz");
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toContain("7-40 hex");
    const unknown = await kbJson(`/provenance?sha=${"e".repeat(40)}`);
    expect(unknown.status).toBe(404);
    expect(String(unknown.body.error)).toContain("no bridge provenance");
  });
});
