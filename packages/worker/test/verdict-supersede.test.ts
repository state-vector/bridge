import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * BR#3457 — one actionable verdict per target, ever.
 *
 * The For Me regrow bug: multiple verify rounds for the SAME target stack up
 * as separate proposed decisions; the UI groups them, but accepting the latest
 * leaves the older rounds still-proposed → the next refetch surfaces an older
 * verdict as the new "latest" → the card reappears as if the accept did
 * nothing. Fix: two sweeps —
 *  (a) create-time: a newer verify-verdict for target X supersedes every
 *      still-proposed older verdict for X (note: "superseded by <new id> —
 *      newer verdict for same target");
 *  (b) act-time: when the human acts on a verify-verdict (accept or reject),
 *      every OTHER still-proposed verdict for the same target is superseded
 *      too — covers legacy stacked state (created before the fix) and
 *      create-race stragglers.
 * Reject routes to `superseded` (LIFECYCLES.decision has no `rejected` edge —
 * core.ts: proposed → [accepted, superseded] only).
 *
 * DO integration tier: drives the bundled KnowledgeHub directly (same rig as
 * do.test.ts), so hand-written SQL and the real transition gates are
 * exercised, not mocked.
 */

let mf: Miniflare;
let kb: (path: string, init?: RequestInit) => Promise<Response>;

beforeAll(async () => {
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
      durableObjects: {
        HUB: { className: "FlowsHub", useSQLite: true },
        KB: { className: "KnowledgeHub", useSQLite: true },
      },
    }],
  });
  const ns = await mf.getDurableObjectNamespace("KB");
  const stub = await ns.get(ns.idFromName("global"));
  kb = (path, init) => stub.fetch(`https://kb${path}`, init);
  await kb("/orient", { actor: "test" });
});

afterAll(async () => {
  await mf?.dispose();
});

async function kbJson(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await kb(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const verdictMeta = (task: string, verdict: string, pr: string) => ({
  decision_class: "verify-verdict",
  task,
  verdict,
  pr,
  pr_state: "MERGED",
  merge_commit: `sha-${pr}`,
});

async function decision(id: string): Promise<any> {
  const { body } = await kbJson("/get", { id });
  return body;
}

async function history(id: string): Promise<any[]> {
  const { body } = await kbJson("/get_history", { id });
  return body.versions ?? [];
}

/** every still-proposed verify-verdict for a target (the regrow detector) */
async function proposedVerdictsFor(target: string): Promise<string[]> {
  const { body } = await kbJson("/list", { type: "decision", status: "proposed", limit: 200 });
  return (body.artefacts ?? [])
    .filter((d: any) => d.meta?.decision_class === "verify-verdict" && (d.meta?.task === target || d.meta?.verify_target === target))
    .map((d: any) => d.id);
}

describe("BR#3457 — verdict stacks never regrow (one actionable verdict per target)", () => {
  it("a newer verdict for the same target supersedes older proposed rounds at create time", async () => {
    const { body: t } = await kbJson("/create", { type: "task", title: "supersede target A", qualified: true });
    const target = t.id;

    const { body: v1 } = await kbJson("/create", {
      type: "decision", title: `verdict round 1 for ${target}`,
      meta: verdictMeta(target, "verified", "9001"),
    });
    expect((await decision(v1.id)).status).toBe("proposed");

    // different receipts → not the identical-repeat dedup; a genuine new round
    const { body: v2 } = await kbJson("/create", {
      type: "decision", title: `verdict round 2 for ${target}`,
      meta: verdictMeta(target, "verified", "9002"),
    });

    const d1 = await decision(v1.id);
    expect(d1.status).toBe("superseded");
    expect(await proposedVerdictsFor(target)).toEqual([v2.id]);

    const note = (await history(v1.id)).map((v: any) => `${v.summary ?? ""} ${v.data?.note ?? ""}`).join("\n");
    expect(note).toContain(`superseded by ${v2.id}`);
    expect(note).toContain("newer verdict for same target");

    // the supersede relation records the lineage (replacement → superseded)
    const { body: rel } = await kbJson("/relations", { id: v1.id });
    const sup = (rel.relations ?? rel.artefacts ?? []).find((r: any) => r.relation === "supersedes");
    expect(sup).toBeTruthy();
  });

  it("accepting the latest verdict leaves ZERO proposed verdicts for the target — no regrow", async () => {
    const { body: t } = await kbJson("/create", { type: "task", title: "supersede target B", qualified: true });
    const target = t.id;
    // the verdict applies by QUEUEING the task for the merge train (BR#3516:
    // the train owns delivery — the accept no longer closes; train:landed's
    // machine proxy closes later). The card needs its PR and the covered head.
    await kbJson("/transition", { id: target, to: "in_progress", note: "claim" });
    const HEAD = "e".repeat(40);
    const v2Body = `verified head ${HEAD} — https://github.com/state-vector/bridge/pull/9102`;

    const { body: v1 } = await kbJson("/create", {
      type: "decision", title: `stacked round 1 for ${target}`,
      meta: verdictMeta(target, "verified", "9101"),
    });
    const { body: v2 } = await kbJson("/create", {
      type: "decision", title: `stacked round 2 for ${target}`,
      meta: verdictMeta(target, "verified", "9102"),
      body_md: v2Body,
    });
    // v1 was swept at v2's create (leg above); give v2 its evidence link so the
    // human accept applies end-to-end
    await kbJson("/link", { src: v2.id, relation: "supports", dst: target });

    const acc = await kbJson("/transition", { id: v2.id, to: "accepted", note: "accepted by human (For Me)", actor: "web" });
    expect(acc.status).toBeLessThan(400);
    expect((await decision(v2.id)).status).toBe("accepted");

    // THE REGROW: before the act-time sweep, an older still-proposed verdict
    // for the same target resurfaces as the new latest. After both prongs:
    // nothing proposed for the target, ever.
    expect(await proposedVerdictsFor(target)).toEqual([]);
    // and the task is QUEUED on the accepted verdict (side effect confirmed) —
    // blocked on the train, stamped with the PR + the covered head
    const { body: tNow } = await kbJson("/get", { id: target });
    expect(tNow.status).toBe("blocked");
    expect(tNow.meta?.merge_train?.state).toBe("queued");
    expect(tNow.meta?.pr?.number).toBe(9102);
    expect(tNow.meta?.pr?.head_sha_at_acceptance).toBe(HEAD);
  });

  it("act-time sweep: legacy stacked verdicts (pre-fix data) collapse when the human acts on one", async () => {
    const { body: t } = await kbJson("/create", { type: "task", title: "supersede target C", qualified: true });
    const target = t.id;

    // manufacture the deployed-world stacked shape: two rounds proposed, both
    // created BEFORE the fix (no decision_class at create; the class arrives
    // via a later meta update — update never runs the create-time sweep)
    const plainMeta = (pr: string) => ({ task: target, verdict: "verified", pr, pr_state: "MERGED" });
    const { body: v3 } = await kbJson("/create", { type: "decision", title: `legacy round 1 for ${target}`, meta: plainMeta("9201") });
    const { body: v4 } = await kbJson("/create", { type: "decision", title: `legacy round 2 for ${target}`, meta: plainMeta("9202") });
    await kbJson("/update", { id: v3.id, meta: verdictMeta(target, "verified", "9201") });
    await kbJson("/update", { id: v4.id, meta: verdictMeta(target, "verified", "9202") });
    expect(await proposedVerdictsFor(target).then((a) => a.sort())).toEqual([v3.id, v4.id].sort());

    await kbJson("/link", { src: v4.id, relation: "supports", dst: target });
    const acc = await kbJson("/transition", { id: v4.id, to: "accepted", note: "accepted by human (For Me)", actor: "web" });
    expect(acc.status).toBeLessThan(400);

    // the accept swept its still-proposed sibling — the group cannot regrow
    expect(await proposedVerdictsFor(target)).toEqual([]);
    expect((await decision(v3.id)).status).toBe("superseded");
    const note = (await history(v3.id)).map((v: any) => `${v.summary ?? ""} ${v.data?.note ?? ""}`).join("\n");
    expect(note).toContain("one actionable verdict per target");
    expect(note).toContain(v4.id);
  });

  it("human reject routes to superseded (the rejected edge does not exist) and still sweeps siblings", async () => {
    const { body: t } = await kbJson("/create", { type: "task", title: "supersede target D", qualified: true });
    const target = t.id;

    const { body: v5 } = await kbJson("/create", {
      type: "decision", title: `reject-target round 1 for ${target}`,
      meta: verdictMeta(target, "bounce", "9301"),
    });
    const { body: v6 } = await kbJson("/create", {
      type: "decision", title: `reject-target round 2 for ${target}`,
      meta: verdictMeta(target, "bounce", "9302"),
    });
    await kbJson("/link", { src: v6.id, relation: "supports", dst: target });

    const sup = await kbJson("/transition", {
      id: v6.id, to: "superseded",
      note: "superseded by human (For Me): the verdict doesn't hold — receipts stale",
      actor: "web",
    });
    expect(sup.status).toBeLessThan(400);
    expect((await decision(v6.id)).status).toBe("superseded");
    expect((await decision(v5.id)).status).toBe("superseded"); // act-time sweep
    expect(await proposedVerdictsFor(target)).toEqual([]);
  });

  it("identical-repeat dedup (BR#1782) still applies — the sweeps did not break the flood fix", async () => {
    // analysis-role target: done-unreviewed skips it and the receipts gate
    // (review/unblock only) doesn't fire — the dedup's canned auto-apply note
    // carries no PR receipts, so this is the lane its done can actually pass
    const { body: t } = await kbJson("/create", { type: "task", title: "supersede target E", roles: ["analysis"], qualified: true });
    const target = t.id;
    await kbJson("/transition", { id: target, to: "in_progress", note: "claim" });
    const { body: v7 } = await kbJson("/create", {
      type: "decision", title: `dedup round 1 for ${target}`,
      meta: verdictMeta(target, "verified", "9401"),
    });
    expect((await decision(v7.id)).status).toBe("proposed");
    // identical verdict + identical receipts → auto-applied, no new card
    const dup = await kbJson("/create", {
      type: "decision", title: `dedup round 2 for ${target}`,
      meta: verdictMeta(target, "verified", "9401"),
    });
    expect(dup.body.deduped, JSON.stringify(dup.body)).toBe(true);
    expect(await proposedVerdictsFor(target)).toEqual([v7.id]);
  });
});
