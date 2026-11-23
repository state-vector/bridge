import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIMITS } from "../src/kb/core.ts";
import { executorRequest } from "./executor-fixture";

/**
 * BR#18608 — keep card edits available when lifecycle metadata exceeds the
 * meta key cap.
 *
 * The public update path ran `checkLimits(title, body, MERGED_meta)` on the
 * ENTIRE resulting meta object — so once a card's hub-owned lifecycle stamps
 * (session, completion, work_revision, blocked+typed await, last_progress,
 * execution_* receipts, recovery/proxy/escalation bookkeeping, …) pushed the
 * merged object past LIMITS.metaKeys (20), EVERY update_artefact on that card
 * failed atomically with "meta exceeds 20 keys" — including title/body/tags
 * edits that sent NO metadata at all. First-hand 2026-11-21: blocked BR#6073
 * (28 keys, 5,851B meta — far under the 40KB byte budget) rejected two
 * body-only edits; the typed wait and fenced executor state made the card
 * impossible to archive too, so it was simply stranded (BR#11554 fixed the
 * distinct BYTE-size lock, BR#5807 the replace-not-merge amputation — this is
 * the remaining KEY-COUNT leg of the same write-lock family).
 *
 * The lifecycle keys arrive through the hub's own machinery (transitions,
 * watchdog sweeps, dispatch receipts write meta directly, bypassing the
 * create/update checkLimits), so the cap can never hold them back — only the
 * public API's callers were punished for them.
 *
 * Fix contract pinned here:
 * 1. CALLER BUDGET — the key-count limit governs the caller-supplied PATCH
 *    (≤ LIMITS.metaKeys keys per write), never the merged whole. Hub-owned
 *    lifecycle keys are the hub's own bookkeeping and consume none of the
 *    caller's budget; legacy keys are grandfathered in place.
 * 2. ORDINARY EDITS — title-only, body-only and tags-only edits succeed on a
 *    card whose merged meta exceeds 20 keys, preserving the typed wait,
 *    owner and execution/delivery receipts byte-for-byte (except effects
 *    ordinary edits already define, e.g. work_revision on a content change).
 * 3. STILL ENFORCED — malformed patches (array/string/null) are rejected;
 *    excessive caller patches (>20 keys) are rejected; the BR#11554 byte
 *    budgets still gate the RESULTING row; BR#5807 infrastructure-key
 *    deletion and PR delivery-binding protections are untouched.
 */

// ---------- wiring (the do.test.ts / br11637 rig) ----------

let mf: Miniflare;
let kb: (path: string, init?: RequestInit) => Promise<Response>;

async function bootKb() {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  if (!existsSync(bundle)) {
    throw new Error("bundle missing — run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle (the npm test script does this before vitest)");
  }
  const instance = new Miniflare({
    workers: [{
      name: "main",
      scriptPath: bundle,
      modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")),
      modules: true,
      compatibilityDate: "2025-09-06",
      durableObjects: {
        HUB: { className: "FlowsHub", useSQLite: true },
        KB: { className: "KnowledgeHub", useSQLite: true },
      },
    }],
  });
  const ns = await instance.getDurableObjectNamespace("KB");
  const objectId = ns.idFromName("global");
  const stub = await ns.get(objectId);
  return { instance, kb: (path: string, init?: RequestInit) => stub.fetch(`https://kb${path}`, init) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function kbJson(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await kb(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" },
    body: JSON.stringify(executorRequest(body)),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

beforeAll(async () => {
  const booted = await bootKb();
  mf = booted.instance;
  kb = booted.kb;
  await kbJson("/orient", { actor: "test" });
});

afterAll(async () => {
  await mf?.dispose();
});

// ---------- the fixture: a BR#6073-class card ----------

/**
 * Verbatim hub-stamp shapes (the key set a real multi-leg task carries after
 * months of lifecycle machinery: execution receipts, watchdog/release stamps,
 * recovery duties, escalation bookkeeping, PR provenance). Supplied at
 * create (≤ LIMITS.metaKeys caller keys — the API contract holds) so the
 * card STARTS lifecycle-heavy the way real cards do; the hub then adds its
 * own live-leg stamps on top (session/completion/work_revision at create,
 * last_progress via a real progress heartbeat, blocked+typed await via a
 * real park).
 */
const LIFECYCLE_STAMPS = {
  pr: { repo: "state-vector/bridge", number: 447, head_sha_at_acceptance: "a".repeat(40) },
  recovery: { kind: "duty", task_id: "BR#17819", reason: "execution_environment" },
  recovery_links: [{ repo: "state-vector/bridge", base: "main", head_sha: "d".repeat(40), cause: { kind: "check_failure", check: "Deploy Dev" } }],
  execution_last_model: { model: "llmgw/glm-5.3-flash", tier: "small", backend: "opencode" },
  execution_diagnosis: { generation: 1, hold: "retry_budget", duty: "BR#17819" },
  execution_resume: { kind: "terminal_result", generation: 1, attempt_id: "330472-1795260307575" },
  proxy_check: { at: 1795447002721, verdict: "waiting", detail: "awaiting ask BR#17869" },
  attempt: { by: "system:watchdog", at: 1795191194369, attempts: 1, last_reason: "stalled — no update for >10m" },
  escalate: { at: 1795178737469, attempts: 3, reason: "3 unblock rounds spawned" },
  unblock_escalated: { at: 1795178737469, rounds: 3 },
  last_unblock_spawn: { at: 1795230698682, exit: "PR merged through the normal train", receipts: ["PR #447 merged (mergeCommit non-null)"] },
  provenance: { repo: "state-vector/bridge", pr: 447, head_sha: "b".repeat(40), merge_sha: "c".repeat(40), task_id: "BR#18608", verdict_id: "BR#5824" },
  machine_duty: { by: "BR#11535", kind: "close_leg", subject: "BR#10150" },
  disposition_receipt: { disposition: "reconciled_no_repair_needed", receipts: ["receipt-1"] },
  taken_over: { from_session: "dispatch-br6073-runner", to_session: "codex-gate-01a1", by: "_direct/coordinator", at: 1794196483477, reason: "delegated repair" },
  grace_until: 1795405856411,
  session_alive_ts: 1793743382773,
};

/** Build the BR#6073-class card entirely through real ops, and prove the
 *  pre-fix lock: the body-only update dies with the key-cap error. */
async function seedLegacyHeavyCard(): Promise<{ id: string; preKeys: number; preMeta: Record<string, unknown> }> {
  const created = await kbJson("/create", {
    type: "task",
    title: "BR#18608 legacy-heavy fixture (BR#6073 shape)",
    body_md: "seed body",
    session: "codex-br6073-resume-here-20261120",
    qualified: true,
    meta: LIFECYCLE_STAMPS,
    actor: "test",
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const id = created.body.id;

  // Real hub heartbeat: a progress artefact stamps last_progress on the task.
  const hb = await kbJson("/progress.log", { id, actor: "test", session: "codex-br6073-resume-here-20261120", note: "heartbeat", will: "continue" });
  expect(hb.status, JSON.stringify(hb.body)).toBe(200);

  // Real park with a typed wait — the exact BR#6073 shape.
  const park = await kbJson("/transition", {
    id, to: "blocked", actor: "test", session: "codex-br6073-resume-here-20261120",
    note: "Wait for prerequisite support code", await_event: { event: "pr_merged", repo: "state-vector/superpositional", n: 3622 },
  });
  expect(park.status, JSON.stringify(park.body)).toBe(200);

  const got = await kbJson("/get", { id });
  expect(got.status).toBe(200);
  const preMeta = got.body.meta as Record<string, unknown>;
  const preKeys = Object.keys(preMeta).length;
  // the card is lifecycle-heavy: >20 keys, the typed wait is live, and the
  // bytes are far under the BR#11554 budgets (the byte lock is NOT in play)
  expect(preKeys).toBeGreaterThan(LIMITS.metaKeys);
  expect(preMeta.blocked).toMatchObject({ await_event: { event: "pr_merged" } });
  expect(got.body.meta_bytes).toBeLessThan(LIMITS.metaBytes);
  expect(got.body.row_bytes).toBeLessThan(LIMITS.rowBytes);
  expect(got.body.status).toBe("blocked");
  return { id, preKeys, preMeta };
}

describe("BR#18608 — ordinary edits stay available when merged lifecycle meta exceeds the key cap", () => {
  it("a body-only edit succeeds and preserves the typed wait, owner and receipts byte-for-byte", async () => {
    const { id, preKeys, preMeta } = await seedLegacyHeavyCard();

    const edited = await kbJson("/update", { id, actor: "test", session: "codex-br6073-resume-here-20261120", body_md: "seed body — ordinary edit with zero metadata sent" });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);

    const after = await kbJson("/get", { id });
    expect(after.status).toBe(200);
    const postMeta = after.body.meta as Record<string, unknown>;
    // key count is unchanged — the edit added nothing
    expect(Object.keys(postMeta).length).toBe(preKeys);
    // the typed wait survived byte-for-byte
    expect(JSON.stringify(postMeta.blocked)).toBe(JSON.stringify(preMeta.blocked));
    // owner and status untouched
    expect(after.body.owner).toBe("");
    expect(after.body.status).toBe("blocked");
    // every lifecycle receipt is preserved byte-for-byte EXCEPT the one key
    // ordinary edits are defined to revise (work_revision)
    const diffs = Object.keys(preMeta).filter((k) => JSON.stringify(preMeta[k]) !== JSON.stringify(postMeta[k]));
    expect(diffs).toEqual(["work_revision"]);
    expect(postMeta.work_revision).not.toBe(preMeta.work_revision);
    // and the body actually changed
    expect(after.body.body_md).toBe("seed body — ordinary edit with zero metadata sent");
  });

  it("a second ordinary edit on the same card still succeeds (the unlock is durable, not one-shot)", async () => {
    const { id } = await seedLegacyHeavyCard();
    const e1 = await kbJson("/update", { id, actor: "test", body_md: "edit one" });
    expect(e1.status, JSON.stringify(e1.body)).toBe(200);
    const e2 = await kbJson("/update", { id, actor: "test", title: "BR#18608 legacy-heavy fixture (edited)" });
    expect(e2.status, JSON.stringify(e2.body)).toBe(200);
    const after = await kbJson("/get", { id });
    expect(after.body.title).toBe("BR#18608 legacy-heavy fixture (edited)");
  });

  it("a tags-only edit succeeds and does not touch meta at all", async () => {
    const { id, preMeta } = await seedLegacyHeavyCard();
    const edited = await kbJson("/update", { id, actor: "test", tags: ["br18608", "structural"] });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const after = await kbJson("/get", { id });
    expect(after.body.tags).toEqual(["br18608", "structural"]);
    // tags are not work content: no work_revision revision, meta identical
    expect(JSON.stringify(after.body.meta)).toBe(JSON.stringify(preMeta));
  });

  it("a growing patch (new caller key) succeeds — legacy keys are grandfathered, the caller budget is not", async () => {
    const { id, preKeys, preMeta } = await seedLegacyHeavyCard();
    const stamp = { recorded_by: "BR#18608 regression", at: 1795448000000, outcome: "probe" };
    const edited = await kbJson("/update", { id, actor: "test", meta: { post_slim_write_probe: stamp } });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const after = await kbJson("/get", { id });
    expect(Object.keys(after.body.meta).length).toBe(preKeys + 1);
    expect(after.body.meta.post_slim_write_probe).toEqual(stamp);
    // every pre-existing key is byte-identical (except the defined revision effect)
    for (const k of Object.keys(preMeta)) {
      if (k === "work_revision") continue;
      expect(JSON.stringify(after.body.meta[k]), `key ${k}`).toBe(JSON.stringify(preMeta[k]));
    }
  });

  it("the typed wait still releases through its real lifecycle after ordinary edits", async () => {
    const { id } = await seedLegacyHeavyCard();
    const e = await kbJson("/update", { id, actor: "test", body_md: "edited while parked" });
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    const unpark = await kbJson("/transition", { id, to: "in_progress", actor: "test", session: "codex-br6073-resume-here-20261120", note: "wait fired — resume" });
    expect(unpark.status, JSON.stringify(unpark.body)).toBe(200);
    const after = await kbJson("/get", { id });
    expect(after.body.status).toBe("in_progress");
    expect(after.body.meta.blocked).toBeUndefined();
  });
});

describe("BR#18608 — caller-supplied metadata is still fully policed", () => {
  it("an excessive caller patch (>20 keys) is rejected with the caller-budget error", async () => {
    const { id } = await seedLegacyHeavyCard();
    const fatPatch: Record<string, unknown> = {};
    for (let i = 0; i <= LIMITS.metaKeys; i++) fatPatch[`caller_key_${i}`] = { v: i };
    expect(Object.keys(fatPatch).length).toBe(LIMITS.metaKeys + 1);
    const rejected = await kbJson("/update", { id, actor: "test", meta: fatPatch });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatch(new RegExp(`meta exceeds ${LIMITS.metaKeys} keys`));
  });

  it("malformed patches are rejected: array, string and null are not meta objects", async () => {
    const { id } = await seedLegacyHeavyCard();
    for (const malformed of [[], "not-an-object", null]) {
      const rejected = await kbJson("/update", { id, actor: "test", meta: malformed });
      expect(rejected.status, JSON.stringify(malformed)).toBe(400);
      expect(rejected.body.error).toMatch(/meta must be an object/);
    }
    // the card is untouched by every rejected write
    const after = await kbJson("/get", { id });
    expect(Object.keys(after.body.meta).length).toBeGreaterThan(LIMITS.metaKeys);
  });

  it("the BR#11554 byte budgets still gate the resulting row (a huge value is refused)", async () => {
    const { id } = await seedLegacyHeavyCard();
    const rejected = await kbJson("/update", { id, actor: "test", meta: { big_receipt: "x".repeat(LIMITS.metaBytes + 1000) } });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatch(/storage budget: meta is/);
    expect(rejected.body.error).toMatch(/LIMITS\.metaBytes/);
  });

  it("BR#5807 infrastructure protections are intact on the legacy-heavy card", async () => {
    const { id } = await seedLegacyHeavyCard();
    // a parked card's typed wait refuses meta_delete from agent sessions
    const delWait = await kbJson("/update", { id, actor: "test", meta_delete: ["blocked"] });
    expect(delWait.status).toBe(400);
    expect(delWait.body.error).toMatch(/BR#5807 lane\/park meta-integrity guard/);
    // PR delivery bindings refuse removal
    const delPr = await kbJson("/update", { id, actor: "test", meta_delete: ["pr"] });
    expect(delPr.status).toBe(400);
    expect(delPr.body.error).toMatch(/gate: PR delivery bindings cannot be removed/);
    // execution requirements refuse deletion (capability-eligibility bypass)
    // — exercised on a card that carries them
    const reqCard = await kbJson("/create", {
      type: "task", title: "BR#18608 requirements fence fixture", body_md: "seed", actor: "test",
      meta: { execution_requirements: { tier: "small", tools: [], environment: [] } },
    });
    expect(reqCard.status, JSON.stringify(reqCard.body)).toBe(200);
    const delReq = await kbJson("/update", { id: reqCard.body.id, actor: "test", meta_delete: ["execution_requirements"] });
    expect(delReq.status).toBe(400);
    expect(delReq.body.error).toMatch(/execution requirements cannot be deleted/);
    // coordination checkpoints are lifecycle-owned — they cannot be written
    // or rewritten through metadata edits (the card holds a terminal_result
    // execution_resume; converting it to a checkpoint must refuse)
    const cp = await kbJson("/update", {
      id, actor: "test",
      meta: { execution_resume: { kind: "coordination_checkpoint", note: "hijack" } },
    });
    expect(cp.status).toBe(400);
    expect(cp.body.error).toMatch(/coordination checkpoints are lifecycle-owned/);
  });
});

describe("BR#18608 — the fix's shape (source pins, br11554 style)", () => {
  // The pins are read by vitest as plain text; no DO needed, but they run in
  // the same file for convenience.
  it("the update path checks title/body limits and validates the caller patch — never the merged meta key count", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/kb/do.ts", import.meta.url).pathname, "utf8");
    const updateIdx = src.indexOf("private async update(body: any, actor: string)");
    const updateSrc = src.slice(updateIdx, src.indexOf("\n  /**\n   * BR#11554 — the unlock path", updateIdx));
    // no whole-object key-count check survives on the merged meta
    expect(updateSrc).not.toMatch(/checkLimits\(title, bodyMd, JSON\.parse\(meta\)\)/);
    // title/body limits still apply
    expect(updateSrc).toMatch(/checkLimits\(title, bodyMd\)/);
    // the caller patch is validated before merge: shape + caller key budget
    expect(updateSrc).toMatch(/meta must be an object/);
    expect(updateSrc).toMatch(new RegExp(`meta exceeds \\$\\{LIMITS\\.metaKeys\\} keys`));
    // and the validation runs BEFORE the patch is merged into the stored meta
    const validateIdx = updateSrc.indexOf("meta must be an object");
    const mergeIdx = updateSrc.indexOf("Object.assign(metaObj");
    expect(validateIdx).toBeGreaterThan(-1);
    expect(mergeIdx).toBeGreaterThan(validateIdx);
  });

  it("create keeps its whole-object key-count check (fresh objects have no legacy to grandfather)", async () => {
    const { readFileSync } = await import("node:fs");
    const coreSrc = readFileSync(new URL("../src/kb/core.ts", import.meta.url).pathname, "utf8");
    expect(coreSrc).toMatch(/if \(meta && Object\.keys\(meta as object\)\.length > LIMITS\.metaKeys\)/);
  });
});
