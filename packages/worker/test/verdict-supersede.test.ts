import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * BR#5377 — verify verdicts are MACHINE verdicts (Ray directive 2026-11-01).
 *
 * A verify-verdict decision ACCEPTS at create (actor system:verifier — the
 * narrow machine-gate exemption in machine.ts decision-acceptance-human) and
 * the accept-side hook applies it to its target: bounce → in_progress with
 * the findings, verify duty → done (the "verify passed" note token satisfies
 * verdict-done-needs-receipts), impl card → the merge-train queue (BR#3516 —
 * the train owns delivery). No proposal phase, no human GO/NO-GO leg, no
 * consensus round (BR#903 rounds are for proposals; a machine verdict has
 * nothing to collect consensus on). The one human leg left is SUPERSEDE.
 * BR#5377 F4: the adoption sweep (alarmSweep A2, age-gated) machine-applies
 * legacy proposed verdicts + failed-apply stragglers; admin.verify_verdict_sweep
 * drills it in isolation (minAgeMs 0). The accept effect supersedes the
 * decision's orphan Feedback round (machine.ts supersede_children).
 *
 * BR#3457 — one actionable verdict per target, ever — is re-tested in the
 * machine world: fresh verdicts never sit proposed (they apply), so the
 * create-time sweep now catches failed-apply stragglers, and the act-time
 * prong fires on the machine apply itself.
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

const verdictMeta = (task: string, verdict: string, pr: string, repo?: string) => ({
  decision_class: "verify-verdict",
  task,
  verdict,
  pr,
  ...(repo ? { repo } : {}),
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

const noteOf = async (id: string) =>
  (await history(id)).map((v: any) => `${v.summary ?? ""} ${v.data?.note ?? ""}`).join("\n");

/** every still-proposed verify-verdict for a target (the regrow detector) */
async function proposedVerdictsFor(target: string): Promise<string[]> {
  const { body } = await kbJson("/list", { type: "decision", status: "proposed", limit: 200 });
  return (body.artefacts ?? [])
    .filter((d: any) => d.meta?.decision_class === "verify-verdict" && (d.meta?.task === target || d.meta?.verify_target === target))
    .map((d: any) => d.id);
}

/** open Feedback: rounds spawned for a decision (the F2/F4 collapse detector) */
async function feedbackRoundsFor(decisionId: string): Promise<string[]> {
  const { body } = await kbJson("/list", { type: "task", status: "todo", limit: 200 });
  return (body.artefacts ?? [])
    .filter((t: any) => t.meta?.feedback_for === decisionId)
    .map((t: any) => t.id);
}

/**
 * Legacy-world fixture: a PROPOSED verify-verdict straggler. Under F1 a fresh
 * verdict machine-applies at create, so the only proposed verdicts in the new
 * world are (a) the deploy-time backlog and (b) stragglers whose auto-apply
 * was refused. Both arrive via a plain decision (create never triggers the
 * verify machinery for a non-verify decision — it even spawns a Feedback
 * round) whose meta is updated to the verify class afterwards; /update
 * replaces meta wholesale and never runs the create-time sweep/apply.
 */
async function proposedStraggler(target: string, verdict: string, pr: string): Promise<{ id: string; round: string | undefined }> {
  const { body: plain } = await kbJson("/create", {
    type: "decision",
    title: `legacy verdict for ${target}`,
    meta: { task: target, verdict, pr },
  });
  const round = plain.feedback_round as string | undefined;
  await kbJson("/update", { id: plain.id, meta: verdictMeta(target, verdict, pr) });
  return { id: plain.id, round };
}

describe("BR#5377 F1 — machine verdicts apply on filing (no human GO/NO-GO)", () => {
  it("records an ACCEPT decision without manufacturing a typed review or queue admission", async () => {
    const { body: t } = await kbJson("/create", { type: "task", title: "F1 accept target", qualified: true });
    const target = t.id;
    await kbJson("/transition", { id: target, to: "in_progress", note: "claim" });
    const HEAD = "e".repeat(40);
    const { body: v, status } = await kbJson("/create", {
      type: "decision",
      title: `BR#5377 verify verdict (2026-11-01): SUBSTANCE_VERIFIED — sound receipts`,
      meta: verdictMeta(target, "verified", "9102", "state-vector/bridge"),
      body_md: `verified head ${HEAD} — https://github.com/state-vector/bridge/pull/9102`,
    });
    expect(status).toBeLessThan(400);

    // the verdict itself: ACCEPTED on filing, machine-applied, NO round
    expect(v.status).toBe("accepted");
    expect(v.machine_applied).toBeUndefined();
    expect(v.outcome_required).toBe(true);
    expect(v.feedback_round, "a machine verdict is not a proposal — it spawns no consensus round").toBeUndefined();
    expect(await decision(v.id).then((d) => d.status)).toBe("accepted");
    expect(await feedbackRoundsFor(v.id)).toEqual([]);

    // F3: the hub minted the canonical plain-language title; the verifier's
    // authored title rides at the top of the body instead
    expect((await decision(v.id)).title).toBe(`Verify verdict — ACCEPT — PR state-vector/bridge#9102 → ${target}`);
    const body = (await decision(v.id)).body_md ?? "";
    expect(body).toContain("> **Verifier's title:** BR#5377 verify verdict");
    expect(body).toContain("recorded decision");

    // the verdict IS the acceptance evidence: the supports link was auto-laid
    const { body: rel } = await kbJson("/relations", { id: v.id });
    const sup = (rel.relations ?? []).find((r: any) => r.relation === "supports" && r.dir === "out" && r.artefact_id === target);
    expect(sup, "the machine apply links the verdict to its target before applying").toBeTruthy();

    // THE EFFECT: the impl card queued on the train (BR#3516 — the train owns
    // delivery), stamped with the PR + the covered head parsed from the
    // verdict body — no human click happened anywhere in this test
    const { body: tNow } = await kbJson("/get", { id: target });
    expect(tNow.status).toBe("in_progress");
    expect(tNow.meta?.merge_train).toBeUndefined();
    expect(tNow.meta?.pr).toBeUndefined();
  });

  it("a BOUNCE verdict machine-applies: the target re-enters work with the findings", async () => {
    const { body: t } = await kbJson("/create", { type: "task", title: "F1 bounce target", qualified: true });
    const target = t.id;
    const { body: v } = await kbJson("/create", {
      type: "decision",
      title: `bounce verdict for ${target}`,
      meta: verdictMeta(target, "bounce", "9201"),
      body_md: "PR #9201 unmergeable — unsigned commits. Re-sign and re-push.",
    });
    expect(v.status).toBe("accepted");
    expect(v.machine_applied).toBe(true);

    const tNow = await decision(target);
    expect(tNow.status).toBe("in_progress");
    const note = await noteOf(target);
    expect(note).toContain("machine-applied (system:verifier)");
    expect(note).toContain("bounced with the verifier's findings");
    // the F3 title routes the effect honestly: BOUNCE, not ACCEPT
    expect((await decision(v.id)).title).toBe(`Verify verdict — BOUNCE — PR #9201 → ${target}`);
  });

  it("a legacy decision cannot close a review duty using a synthesised receipts token", async () => {
    // analysis/impl close gates differ for review-role cards: the closing note
    // must carry a receipts token ("verify passed") or the done is refused
    const { body: duty } = await kbJson("/create", { type: "task", title: "F1 verify duty", roles: ["review"], qualified: true });
    const target = duty.id;
    await kbJson("/transition", { id: target, to: "in_progress", note: "verify picked up" });
    const HEAD = "f".repeat(40);
    const { body: v } = await kbJson("/create", {
      type: "decision",
      title: `duty verdict for ${target}`,
      meta: verdictMeta(target, "verified", "9301", "state-vector/bridge"),
      body_md: `verified head ${HEAD} — https://github.com/state-vector/bridge/pull/9301`,
    });
    expect(v.status).toBe("accepted");
    expect(v.machine_applied).toBeUndefined();
    expect(v.outcome_required).toBe(true);

    const dNow = await decision(target);
    expect(dNow.status).toBe("in_progress");
    expect(await noteOf(v.id)).toContain("No task was closed or queued");
  });
});

describe("BR#5377 F2 — machine verdicts spawn no consensus round (plain decisions still do)", () => {
  it("a plain proposed decision still spawns its Feedback: round (BR#903 regression guard)", async () => {
    const { body: d } = await kbJson("/create", {
      type: "decision",
      title: "plain decision — still consensus-seeking",
      meta: { rationale: "not a verify verdict" },
    });
    expect(d.feedback_round).toBeTruthy();
    const { body: round } = await kbJson("/get", { id: d.feedback_round });
    expect(round.status).toBe("todo");
    expect(round.meta?.feedback_for).toBe(d.id);
    expect(round.title.startsWith("Feedback: ")).toBe(true);
  });
});

describe("BR#5377 F3 — the hub mints the canonical verdict title", () => {
  it("authored titles are demoted into the body on every DO-level create", async () => {
    const { body: t } = await kbJson("/create", { type: "task", title: "F3 title target", qualified: true });
    const target = t.id;
    const dense = `BR#5371 verify verdict (2026-11-01): SUBSTANCE_VERIFIED — ACCEPT — BOUNCE_NARROW:unsigned — mergeCommit 28cc78501ca357ae38a88998e1d5a1fb4195106e prose prose`;
    const { body: v } = await kbJson("/create", {
      type: "decision",
      title: dense,
      meta: { ...verdictMeta(target, "verified", "9401"), pr: { repo: "state-vector/bridge", number: 9401 } },
      body_md: "receipts",
    });
    expect((await decision(v.id)).title).toBe(`Verify verdict — ACCEPT — PR state-vector/bridge#9401 → ${target}`);
    expect((await decision(v.id)).body_md).toContain(`> **Verifier's title:** ${dense}`);
    // digits-only pr + explicit repo meta resolves to the same owner/repo#N form
    const { body: v2 } = await kbJson("/create", {
      type: "decision",
      title: "dense 2",
      meta: { ...verdictMeta(target, "verified", "9402", "state-vector/bridge") },
      body_md: "receipts 2",
    });
    expect((await decision(v2.id)).title).toBe(`Verify verdict — ACCEPT — PR state-vector/bridge#9402 → ${target}`);
  });
});

describe("BR#5377 F4 — the adoption sweep machine-applies legacy verdicts", () => {
  it("admin.verify_verdict_sweep adopts a proposed straggler: verdict accepted, impl card queued, orphan round collapsed", async () => {
    const { body: t } = await kbJson("/create", { type: "task", title: "F4 adoption target", qualified: true });
    const target = t.id;
    // claimed: the machine apply QUEUES an in_progress impl card (BR#3516 —
    // the train owns delivery; todo → done is not a lifecycle edge)
    await kbJson("/transition", { id: target, to: "in_progress", note: "claim" });
    const { id: straggler, round } = await proposedStraggler(target, "verified", "9501");
    // the legacy verdict carries its receipts: the PR + the covered head
    await kbJson("/update", {
      id: straggler,
      body_md: `verified head ${"9".repeat(40)} — https://github.com/state-vector/bridge/pull/9501`,
    });
    expect((await decision(straggler)).status).toBe("proposed");
    expect(round, "the fixture was a PLAIN decision — it spawned a round").toBeTruthy();

    const drill = await kbJson("/admin.verify_verdict_sweep", {});
    expect(drill.status).toBeLessThan(400);
    expect(drill.body.applied).toBeGreaterThanOrEqual(1);

    expect(await decision(straggler).then((d) => d.status)).toBe("accepted");
    const note = await noteOf(straggler);
    expect(note).toContain("retroactive machine-apply (BR#5377 F4 sweep)");
    // THE EFFECT: the impl card queued on the train, stamped from the
    // verdict's receipts — no human click anywhere in this test
    const { body: tNow } = await kbJson("/get", { id: target });
    expect(tNow.status).toBe("in_progress");
    expect(tNow.meta?.merge_train).toBeUndefined();
    expect(tNow.meta?.pr).toBeUndefined();
    // the plain decision's orphan Feedback: round collapsed with the adoption
    expect(await decision(round!).then((r) => r.status)).toBe("superseded");
    expect(await proposedVerdictsFor(target)).toEqual([]);
  });

  it("the age gate holds: a FRESH straggler is not adopted by the alarm tick (it shows proposed first)", async () => {
    const { body: t } = await kbJson("/create", { type: "task", title: "F4 age-gate target", qualified: true });
    const target = t.id;
    const { id: straggler } = await proposedStraggler(target, "verified", "9601");

    // the FULL alarm sweep runs the adoption pass at its REAL age window
    // (VERDICT_ADOPTION_MIN_AGE_MS = 10min) — the seconds-old straggler stays
    const alarm = await kbJson("/admin.alarm_sweep", {});
    expect(alarm.status).toBeLessThan(400);
    expect(await decision(straggler).then((d) => d.status)).toBe("proposed");
    expect(await proposedVerdictsFor(target)).toEqual([straggler]);
  });
});

describe("BR#3457 — verdict stacks never regrow (one actionable verdict per target), machine world", () => {
  it("a fresh verdict sweeps a proposed straggler at create time (failed-apply legacy data)", async () => {
    const { body: t } = await kbJson("/create", { type: "task", title: "sweep target A", qualified: true });
    const target = t.id;
    await kbJson("/transition", { id: target, to: "in_progress", note: "claim" });
    const { id: straggler } = await proposedStraggler(target, "verified", "9701");
    expect(await proposedVerdictsFor(target)).toEqual([straggler]);

    const HEAD = "a".repeat(40);
    const { body: v2 } = await kbJson("/create", {
      type: "decision",
      title: `fresh verdict for ${target}`,
      meta: verdictMeta(target, "verified", "9702", "state-vector/bridge"),
      body_md: `verified head ${HEAD} — https://github.com/state-vector/bridge/pull/9702`,
    });
    // the fresh verdict machine-applied (queued the impl card) AND swept the
    // straggler in the same create — the panel cannot regrow the older round
    expect(v2.status).toBe("accepted");
    expect(await decision(straggler).then((d) => d.status)).toBe("superseded");
    const note = await noteOf(straggler);
    expect(note).toContain(`superseded by ${v2.id}`);
    expect(note).toContain("newer verdict for same target");
    const { body: rel } = await kbJson("/relations", { id: straggler });
    const sup = (rel.relations ?? []).find((r: any) => r.relation === "supersedes" && r.dir === "in" && r.artefact_id === v2.id);
    expect(sup).toBeTruthy();
    expect(await proposedVerdictsFor(target)).toEqual([]);
    const { body: tNow } = await kbJson("/get", { id: target });
    expect(tNow.meta?.merge_train).toBeUndefined();
  });

  it("a human SUPERSEDE of a machine-applied verdict routes to superseded; sibling accepted verdicts stay", async () => {
    const { body: t } = await kbJson("/create", { type: "task", title: "sweep target B", qualified: true });
    const target = t.id;
    await kbJson("/transition", { id: target, to: "in_progress", note: "claim" });
    const { body: v1 } = await kbJson("/create", {
      type: "decision",
      title: `machine verdict 1 for ${target}`,
      meta: verdictMeta(target, "verified", "9801", "state-vector/bridge"),
      body_md: `verified head ${"b".repeat(40)} — https://github.com/state-vector/bridge/pull/9801`,
    });
    expect(v1.status).toBe("accepted");
    // a second (changed-receipts) verdict for the same target also applied
    const { body: v2 } = await kbJson("/create", {
      type: "decision",
      title: `machine verdict 2 for ${target}`,
      meta: verdictMeta(target, "verified", "9802", "state-vector/bridge"),
      body_md: `verified head ${"c".repeat(40)} — https://github.com/state-vector/bridge/pull/9802`,
    });
    expect(v2.status).toBe("accepted");
    expect(await proposedVerdictsFor(target)).toEqual([]);

    // the human leg: supersede the verdict that doesn't hold (accepted →
    // superseded is a legal decision edge) — the OTHER accepted verdicts for
    // the target are untouched (they are the standing receipts, not stragglers)
    const sup = await kbJson("/transition", {
      id: v1.id, to: "superseded",
      note: "superseded by human: the verdict doesn't hold — receipts stale",
      actor: "web",
    });
    expect(sup.status).toBeLessThan(400);
    expect(await decision(v1.id).then((d) => d.status)).toBe("superseded");
    expect(await decision(v2.id).then((d) => d.status)).toBe("accepted");
  });

  it("BR#1782 dedup, new world: an identical fresh repeat machine-applies as an accepted no-op — the panel still never regrows", async () => {
    // F1 changed the dedup's world: the previous verdict is ACCEPTED by the
    // time the repeat arrives (it applied at create), so the proposed-only
    // dedup never fires for fresh verdicts — the repeat mints its own accepted
    // card whose apply is a ratifying no-op (`already`). The flood is still
    // dead: nothing lands in the proposed panel, ever.
    const { body: t } = await kbJson("/create", { type: "task", title: "dedup target A", qualified: true });
    const target = t.id;
    await kbJson("/transition", { id: target, to: "in_progress", note: "claim" });
    const { body: v1 } = await kbJson("/create", {
      type: "decision",
      title: `dedup round 1 for ${target}`,
      meta: verdictMeta(target, "verified", "9901", "state-vector/bridge"),
      body_md: `verified head ${"d".repeat(40)} — https://github.com/state-vector/bridge/pull/9901`,
    });
    expect(v1.status).toBe("accepted");
    expect(v1.machine_applied).toBeUndefined();
    expect(v1.outcome_required).toBe(true);
    const queued = await decision(target);
    expect(queued.status).toBe("in_progress");
    expect(queued.meta?.merge_train).toBeUndefined();

    const dup = await kbJson("/create", {
      type: "decision",
      title: `dedup round 2 for ${target}`,
      meta: verdictMeta(target, "verified", "9901", "state-vector/bridge"),
      body_md: `verified head ${"d".repeat(40)} — https://github.com/state-vector/bridge/pull/9901`,
    });
    expect(dup.body.deduped, "the proposed-only dedup does not fire against an ACCEPTED prev (F1 world)").toBeUndefined();
    expect(dup.body.status).toBe("accepted");
    expect(dup.body.machine_applied).toBeUndefined();
    expect(dup.body.outcome_required).toBe(true);
    expect(await proposedVerdictsFor(target)).toEqual([]);
    // the repeat's apply was a ratifying no-op: the train state did not churn
    const again = await decision(target);
    expect(again.status).toBe("in_progress");
    expect(again.meta?.merge_train).toBeUndefined();
  });

  it("BR#1782 dedup, legacy lane: an identical repeat against a PROPOSED straggler is still deduped (no card, auto-applied)", async () => {
    // analysis-role target: done-unreviewed skips it and the receipts gate
    // (review/unblock only) doesn't fire — the flood fix's canned auto-apply
    // note carries no PR receipts, so this is the lane its done can pass
    const { body: t } = await kbJson("/create", { type: "task", title: "dedup target B", roles: ["analysis"], qualified: true });
    const target = t.id;
    await kbJson("/transition", { id: target, to: "in_progress", note: "claim" });
    const { id: straggler } = await proposedStraggler(target, "verified", "9911");
    expect(await proposedVerdictsFor(target)).toEqual([straggler]);

    // identical verdict + identical receipts → auto-applied, no new card
    const dup = await kbJson("/create", {
      type: "decision",
      title: `dedup round 2 for ${target}`,
      meta: verdictMeta(target, "verified", "9911"),
    });
    expect(dup.body.deduped, JSON.stringify(dup.body)).toBe(true);
    expect(await proposedVerdictsFor(target)).toEqual([straggler]);
    expect(dup.body.applied).toBe(false);
    expect(dup.body.outcome_required).toBe(true);
    expect(await decision(target).then((d) => d.status)).toBe("in_progress");
  });
});
