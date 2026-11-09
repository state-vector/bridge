import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reviewOutcome } from "./completion-fixture";

/** BR#8824 — scoped stale deployment-gate retries. The closed retry
 *  purpose/evidence ledger: an `ordinary_head_check` keeps its permanent
 *  [task, head, obligation] budget (legacy rows preserved, never reset); a
 *  `stale_destination_gate` retry is licensed ONLY by the lane's current
 *  canonical GREEN deploy coverage, validated by the hub (never caller
 *  asserted, never a timestamp), and scoped to the successful coverage
 *  receipt — one retry per exact head/obligation/CHANGED successful
 *  coverage. A prior prepared/outcome_unknown dispatch of the same scope
 *  stays fenced until its receipts reconcile; a fresh green stamp never
 *  licenses repeating an unknown effect. */
let mf: Miniflare;
let stub: { fetch(url: string, init: RequestInit): Promise<Response> };

const kbJson = async (path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await stub.fetch(`https://kb${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

const acceptedPr = (task_id: string, repo: string, number: number, head: string) =>
  ({ kind: "accepted_pr" as const, task_id, legs: [{ repo, number, head_sha_at_acceptance: head }] });

// Each scenario owns its runtime and cached stub. A failed synchronous
// Miniflare proxy request must not poison every following scenario, and
// ordinary HTTP calls must not repeatedly cross the synchronous proxy.
beforeEach(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  if (!existsSync(bundle)) {
    throw new Error("bundle missing — run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle (before vitest)");
  }
  mf = new Miniflare({
    port: 0,
    workers: [{
      name: "main",
      scriptPath: bundle,
      modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")),
      modules: true,
      compatibilityDate: "2025-09-06",
      durableObjects: { KB: { className: "KnowledgeHub", useSQLite: true } },
    }],
  });
  const ns = await mf.getDurableObjectNamespace("KB");
  stub = await ns.get(ns.idFromName("stale-gate")) as unknown as typeof stub;
  await kbJson("/orient", {});
});

afterEach(async () => {
  await mf?.dispose();
});

const acquire = (repo: string, actor: string, extra: Record<string, unknown> = {}) =>
  kbJson("/train.lease", { repo, base: "main", action: "acquire", actor, ...extra });

async function queueViaAccept(opts: { repo: string; pr: number; head: string }): Promise<string> {
  const impl = await kbJson("/create", { type: "task", title: "IMPL: stale gate drill", session: "" });
  expect(impl.status).toBe(200);
  const implId = String(impl.body.id);
  const verify = await kbJson("/create", { type: "task", title: `VERIFY: stale gate drill ${implId}`, roles: ["review"], session: "br8824-verify" });
  const verifyId = String(verify.body.id);
  await kbJson("/link", { src: verifyId, relation: "child_of", dst: implId });
  await kbJson("/transition", { id: verifyId, to: "in_progress", actor: "drill-verifier", note: "drill: verifying" });
  const closed = await kbJson("/transition", { id: verifyId, to: "done", actor: "drill-verifier",
    note: `verified head ${opts.head} (drill) — PR https://github.com/${opts.repo}/pull/${opts.pr}`,
    review_result: await reviewOutcome(kbJson, verifyId, acceptedPr(implId, opts.repo, opts.pr, opts.head)) });
  expect(closed.status, `verify close failed: ${JSON.stringify(closed.body)}`).toBeLessThan(400);
  return implId;
}

describe("BR#8824 scoped stale deployment-gate retries", () => {
  const rig = async (suffix: string) => {
    const repo = `state-vector/stale-gate-8824-${suffix}`;
    const actor = `gw-8824-${suffix}`;
    const head = "a".repeat(40); // the candidate PR head (PR #1)
    const tip = "b".repeat(40);  // the destination (main) tip
    const task = await queueViaAccept({ repo, pr: 1, head });
    expect((await acquire(repo, actor, { required_workflows: ["Deploy Dev"] })).status).toBe(200);
    // The reconcile daemon's open-PR observation — the hub-observed current
    // head the stale-destination binding requires (fail-closed without one).
    const report = await kbJson("/reconcile.report", { repo, prs: [{ number: 1, state: "OPEN", headRefOid: head, updatedAt: new Date().toISOString() }], actor: "system:reconcile" });
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    return { repo, actor, head, tip, task };
  };
  /** Stamp the lane's base state (the executor's per-tick observation). */
  const stampBase = (rigged: Awaited<ReturnType<typeof rig>>, base_state: object, who?: string) =>
    kbJson("/train.queue_facts", { repo: rigged.repo, actor: who ?? rigged.actor, entries: [], base_state });
  const greenCoverage = (tip: string, runId: number) => ({
    verdict: "green", tip_sha: tip, red: [], unsettled: [],
    deploy_coverage: { phase: "covered", tip_sha: tip, tip_age_secs: 60, covered_by_sha: tip, covered_by_run_id: runId },
  });
  const reserve = (rigged: Awaited<ReturnType<typeof rig>>, purpose?: string, who?: string) => {
    const o = rigged;
    return kbJson("/train.queue_facts", { repo: o.repo, actor: who ?? o.actor, check_retry: {
      kind: "reserve", pr: 1, task_id: o.task, head_sha: o.head, name: "Deploy health (merge gate)",
      source: { kind: "workflow_run", workflow_id: 99, run_attempt: 1 }, target: { kind: "workflow_run", id: 41734497120 },
      ...(purpose ? { purpose } : {}),
    } });
  };
  const result = (rigged: Awaited<ReturnType<typeof rig>>, key: string, outcome: string, receipt: string, who?: string) => {
    const o = rigged;
    return kbJson("/train.queue_facts", { repo: o.repo, actor: who ?? o.actor, check_retry: {
      kind: "result", key, outcome, receipt } });
  };

  it("permits exactly one scoped retry after a red-base dispatch once a new decisive green coverage arrives", async () => {
    const r = await rig("red-then-green");
    // The red-base era: the ordinary (legacy) first dispatch consumed the
    // permanent [task, head, obligation] budget while main was red.
    await stampBase(r, { verdict: "red", tip_sha: r.tip, red: [{ name: "Deploy Dev" }], unsettled: [] });
    const first = await reserve(r);
    expect(first.body.kind).toBe("reserved");
    expect((await result(r, first.body.key, "dispatched", "repos/o/r/actions/runs/1/rerun")).body.kind).toBe("recorded");
    expect((await reserve(r)).body).toMatchObject({ kind: "held", state: "dispatched" });
    // Destination recovers: a new decisive green coverage on the same tip.
    await stampBase(r, greenCoverage(r.tip, 500));
    const scoped = await reserve(r, "stale_destination_gate");
    expect(scoped.status, JSON.stringify(scoped.body)).toBe(200);
    expect(scoped.body.kind).toBe("reserved");
    expect(scoped.body.key).not.toBe(first.body.key); // the scoped key carries purpose + coverage receipt
    // exactly one: the same successful coverage never re-opens the budget.
    expect((await reserve(r, "stale_destination_gate")).body).toMatchObject({ kind: "held", state: "prepared" });
    expect((await result(r, scoped.body.key, "dispatched", "repos/o/r/actions/runs/41734497120/rerun")).body.kind).toBe("recorded");
    expect((await reserve(r, "stale_destination_gate")).body).toMatchObject({ kind: "held", state: "dispatched" });
    await kbJson("/train.lease", { repo: r.repo, actor: r.actor, action: "release" });
  });

  it("keeps one scoped budget across restart-shaped replays and lease takeover by a second holder", async () => {
    const r = await rig("two-holders");
    await stampBase(r, greenCoverage(r.tip, 500));
    const scoped = await reserve(r, "stale_destination_gate");
    expect(scoped.body.kind).toBe("reserved");
    // a lost POST response: the dispatch effect is unknown, recorded as such.
    expect((await result(r, scoped.body.key, "outcome_unknown", "Response lost after POST")).body.kind).toBe("recorded");
    // the same proof replayed by the same holder (a restart re-running the tick) holds.
    expect((await reserve(r, "stale_destination_gate")).body).toMatchObject({ kind: "held", state: "outcome_unknown" });
    // a second lease holder inherits the same fence — no duplicate dispatch.
    await kbJson("/train.lease", { repo: r.repo, actor: r.actor, action: "release" });
    const second = `gw-8824-two-holders-b`;
    expect((await acquire(r.repo, second)).status).toBe(200);
    expect((await reserve(r, "stale_destination_gate", second)).body).toMatchObject({ kind: "held", state: "outcome_unknown" });
    // BR#8824 (independent review P1): the unknown-effect fence is
    // SCOPE-WIDE — the scoped outcome_unknown fences the ORDINARY purpose too
    // (legacy scope-less and explicit alike): no purpose re-dispatches past
    // an unreconciled external effect of the same [task, head, obligation].
    expect((await reserve(r, undefined, second)).body).toMatchObject({ kind: "held", state: "outcome_unknown" });
    expect((await reserve(r, "ordinary_head_check", second)).body).toMatchObject({ kind: "held", state: "outcome_unknown" });
    await kbJson("/train.lease", { repo: r.repo, actor: second, action: "release" });
  });

  it("fences BOTH purpose directions behind an unreconciled unknown dispatch of the same scope", async () => {
    // direction 1: a SCOPED unknown fences the ORDINARY branch (the P1 —
    // the pre-fix ordinary branch read the bare key only and let a scoped
    // unknown effect through).
    const a = await rig("fence-dir1-scoped-unknown");
    await stampBase(a, greenCoverage(a.tip, 500));
    const scoped = await reserve(a, "stale_destination_gate");
    expect(scoped.body.kind).toBe("reserved");
    expect((await result(a, scoped.body.key, "outcome_unknown", "Response lost after POST")).body.kind).toBe("recorded");
    expect((await reserve(a)).body).toMatchObject({ kind: "held", state: "outcome_unknown" });
    expect((await reserve(a, "ordinary_head_check")).body).toMatchObject({ kind: "held", state: "outcome_unknown" });
    await kbJson("/train.lease", { repo: a.repo, actor: a.actor, action: "release" });
    // direction 2: an ORDINARY unknown fences the STALE branch — even under
    // fresh green coverage (the changed receipt grants nothing past it).
    const b = await rig("fence-dir2-ordinary-unknown");
    await stampBase(b, greenCoverage(b.tip, 500));
    const ord = await reserve(b); // legacy scope-less ordinary dispatch
    expect(ord.body.kind).toBe("reserved");
    expect((await result(b, ord.body.key, "outcome_unknown", "Response lost after POST")).body.kind).toBe("recorded");
    await stampBase(b, greenCoverage(b.tip, 900));
    expect((await reserve(b, "stale_destination_gate")).body).toMatchObject({ kind: "held", state: "outcome_unknown" });
    await kbJson("/train.lease", { repo: b.repo, actor: b.actor, action: "release" });
  });

  it("counts a new successful run on the same base SHA as a changed coverage — a new budget", async () => {
    const r = await rig("same-sha-new-run");
    await stampBase(r, greenCoverage(r.tip, 500));
    const first = await reserve(r, "stale_destination_gate");
    expect(first.body.kind).toBe("reserved");
    expect((await result(r, first.body.key, "dispatched", "run/500/rerun")).body.kind).toBe("recorded");
    // a NEW decisive successful run on the SAME tip sha is a changed receipt.
    await stampBase(r, greenCoverage(r.tip, 501));
    const second = await reserve(r, "stale_destination_gate");
    expect(second.body.kind).toBe("reserved");
    expect(second.body.key).not.toBe(first.body.key);
    expect((await reserve(r, "stale_destination_gate")).body).toMatchObject({ kind: "held", state: "prepared" });
    await kbJson("/train.lease", { repo: r.repo, actor: r.actor, action: "release" });
  });

  it("counts a same-run rerun (new attempt of the same run id and SHA) as a changed coverage — a new budget", async () => {
    // (independent review P1) the receipt must carry the canonical
    // run_attempt: a GitHub rerun of run 500 on the same tip creates attempt
    // 2 — a CHANGED receipt that can recover the gate. The pre-fix receipt
    // [tip, run_id] would hold it as the same budget and lose the recovery.
    const r = await rig("same-run-new-attempt");
    const attempt = (n: number) => ({ ...greenCoverage(r.tip, 500), deploy_coverage: { ...greenCoverage(r.tip, 500).deploy_coverage, covered_by_run_attempt: n } });
    await stampBase(r, attempt(1));
    const first = await reserve(r, "stale_destination_gate");
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.kind).toBe("reserved");
    expect((await result(r, first.body.key, "dispatched", "run/500/rerun")).body.kind).toBe("recorded");
    // the SAME run id on the SAME tip sha, rerun to attempt 2 — changed receipt.
    await stampBase(r, attempt(2));
    const second = await reserve(r, "stale_destination_gate");
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.kind).toBe("reserved");
    expect(second.body.key).not.toBe(first.body.key);
    expect((await reserve(r, "stale_destination_gate")).body).toMatchObject({ kind: "held", state: "prepared" });
    await kbJson("/train.lease", { repo: r.repo, actor: r.actor, action: "release" });
  });

  it.each(["failure", null])("denies a newer same-run rerun (%s) despite a later stale-green stamp", async conclusion => {
    const r = await rig(`same-run-${conclusion}`);
    const green = { ...greenCoverage(r.tip, 500), deploy_coverage: {
      ...greenCoverage(r.tip, 500).deploy_coverage, covered_by_run_attempt: 1 } };
    await stampBase(r, green);
    expect((await kbJson("/train.observe_deploy", { repo: r.repo, observation: {
      tip_sha: r.tip, observed_at: Date.now(), runs: [{ id: 500, run_attempt: 2, name: "Deploy Dev", head_sha: r.tip,
        status: conclusion ? "completed" : "in_progress", conclusion,
        html_url: `https://github.com/${r.repo}/actions/runs/500` }] } })).status).toBe(200);
    await stampBase(r, green);
    expect((await reserve(r, "stale_destination_gate")).status).toBe(400);
    await kbJson("/train.lease", { repo: r.repo, actor: r.actor, action: "release" });
  });

  it("denies stale, forged and failed destination coverage — only current canonical green licenses a scoped retry", async () => {
    const r = await rig("denied-coverage");
    // stale: an executor's older green stamp cannot override a NEWER durable
    // deploy observation showing a decisive failure on the tip (the fold).
    await stampBase(r, greenCoverage(r.tip, 500));
    const observed = await kbJson("/train.observe_deploy", { repo: r.repo, observation: {
      tip_sha: r.tip, observed_at: Date.now(), runs: [{ id: 501, name: "Deploy Dev", head_sha: r.tip,
        status: "completed", conclusion: "failure", html_url: `https://github.com/${r.repo}/actions/runs/501` }] } });
    expect(observed.status, JSON.stringify(observed.body)).toBe(200);
    const stale = await reserve(r, "stale_destination_gate");
    expect(stale.status).toBe(400);
    expect(stale.body.error).toMatch(/gate: stale-destination retry requires current canonical GREEN deploy coverage/);
    // forged: a caller asserting the purpose with NO canonical green on the
    // lane (unsettled base, no coverage at all) is denied — the hub derives
    // the coverage itself and never trusts a caller's green.
    await stampBase(r, { verdict: "unsettled", tip_sha: r.tip, red: [], unsettled: ["Deploy Dev"] });
    expect((await reserve(r, "stale_destination_gate")).status).toBe(400);
    // failed: an explicitly failed coverage phase on the lane is denied.
    await stampBase(r, { verdict: "red", tip_sha: r.tip, red: [{ name: "Deploy Dev" }], unsettled: [],
      deploy_coverage: { phase: "failed", tip_sha: r.tip, tip_age_secs: 60, failing_run_id: 501 } });
    expect((await reserve(r, "stale_destination_gate")).status).toBe(400);
    // the ordinary purpose never needed destination evidence — unchanged law.
    await stampBase(r, { verdict: "red", tip_sha: r.tip, red: [{ name: "Deploy Dev" }], unsettled: [] });
    expect((await reserve(r, "ordinary_head_check")).body.kind).toBe("reserved");
    await kbJson("/train.lease", { repo: r.repo, actor: r.actor, action: "release" });
  });

  it("blocks a scoped attempt behind an unreconciled unknown prior effect, even under fresh green coverage", async () => {
    const r = await rig("unknown-effect");
    await stampBase(r, greenCoverage(r.tip, 500));
    const scoped = await reserve(r, "stale_destination_gate");
    expect(scoped.body.kind).toBe("reserved");
    expect((await result(r, scoped.body.key, "outcome_unknown", "Response lost after POST")).body.kind).toBe("recorded");
    // destination recovers further (a changed receipt) — the unknown effect
    // of the prior dispatch still fences the new scoped attempt.
    await stampBase(r, greenCoverage(r.tip, 900));
    const fenced = await reserve(r, "stale_destination_gate");
    expect(fenced.status, JSON.stringify(fenced.body)).toBe(200);
    expect(fenced.body).toMatchObject({ kind: "held", state: "outcome_unknown" });
    // reconciled receipts (a terminal result replay) leave the fence as it
    // was recorded: the fence is the outcome_unknown row itself, never reset.
    expect((await result(r, scoped.body.key, "outcome_unknown", "Response lost after POST")).body.kind).toBe("recorded");
    expect((await reserve(r, "stale_destination_gate")).body).toMatchObject({ kind: "held", state: "outcome_unknown" });
    await kbJson("/train.lease", { repo: r.repo, actor: r.actor, action: "release" });
  });

  it("keeps each suite's obligation budget separate — another suite's success cannot erase this one", async () => {
    const r = await rig("suite-obligations");
    await stampBase(r, greenCoverage(r.tip, 500));
    const suiteA = { kind: "check_run", suite_id: 10, app_id: 1 };
    const suiteB = { kind: "check_run", suite_id: 20, app_id: 15368 };
    const reserveSuite = (source: object, purpose?: string) => kbJson("/train.queue_facts", { repo: r.repo, actor: r.actor,
      check_retry: { kind: "reserve", pr: 1, task_id: r.task, head_sha: r.head, name: "Deploy health (merge gate)",
        source, target: { kind: "check_run", id: 41734497120 }, ...(purpose ? { purpose } : {}) } });
    const a = await reserveSuite(suiteA, "stale_destination_gate");
    expect(a.body.kind).toBe("reserved");
    expect((await result(r, a.body.key, "dispatched", "check-runs/41734497120/rerequest")).body.kind).toBe("recorded");
    // suite B publishes a fresh success (other app) — suite A's obligation
    // budget stays consumed; the classification law keeps A's failure alive
    // (check-obligations), and the ledger never resets either.
    expect((await reserveSuite(suiteA, "stale_destination_gate")).body).toMatchObject({ kind: "held", state: "dispatched" });
    // the other suite is its OWN obligation with its own budget under the
    // same successful coverage.
    const b = await reserveSuite(suiteB, "stale_destination_gate");
    expect(b.body.kind).toBe("reserved");
    expect(b.body.key).not.toBe(a.body.key);
    await kbJson("/train.lease", { repo: r.repo, actor: r.actor, action: "release" });
  });

  it("enforces the current-head binding: a moved PR head never re-opens a scoped budget", async () => {
    const r = await rig("head-binding");
    await stampBase(r, greenCoverage(r.tip, 500));
    const moved = "c".repeat(40);
    // the reconcile daemon's open-PR observation: PR #1 now sits on a new head.
    const report = await kbJson("/reconcile.report", { repo: r.repo, prs: [{ number: 1, state: "OPEN", headRefOid: moved, updatedAt: new Date().toISOString() }], actor: "system:reconcile" });
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    const staleHead = await reserve(r, "stale_destination_gate");
    expect(staleHead.status).toBe(400);
    expect(staleHead.body.error).toMatch(/gate: stale-destination retry head \w{8} is not the current head of PR #1/);
    // the CURRENT head reserves fine; the moved head's budget is its own.
    const current = { ...r, head: moved };
    expect((await reserve(current, "stale_destination_gate")).body.kind).toBe("reserved");
    await kbJson("/train.lease", { repo: r.repo, actor: r.actor, action: "release" });
  });

  it("fails closed with no observed head and binds one PR among same-repo legs", async () => {
    // (independent review P1) the pre-fix binding skipped the check when the
    // hub had NO delivery_pr_outcomes row (fail-open), and compared every
    // leg's PR number against the LANE repo's rows (unrelated legs).
    const repo = `state-vector/stale-gate-8824-failclosed`;
    const actor = "gw-8824-failclosed";
    const head = "a".repeat(40);
    const tip = "b".repeat(40);
    const impl = await kbJson("/create", { type: "task", title: "IMPL: fail-closed drill", session: "" });
    expect(impl.status).toBe(200);
    const implId = String(impl.body.id);
    const verify = await kbJson("/create", { type: "task", title: `VERIFY: fail-closed drill ${implId}`, roles: ["review"], session: "br8824-verify" });
    const verifyId = String(verify.body.id);
    await kbJson("/link", { src: verifyId, relation: "child_of", dst: implId });
    await kbJson("/transition", { id: verifyId, to: "in_progress", actor: "drill-verifier", note: "drill: verifying" });
    // Two legs in the same repo with different heads: bind only requested PR.
    const closed = await kbJson("/transition", { id: verifyId, to: "done", actor: "drill-verifier",
      note: `verified head ${head} (drill)`,
      review_result: await reviewOutcome(kbJson, verifyId, { kind: "accepted_pr", task_id: implId, legs: [
        { repo, number: 1, head_sha_at_acceptance: head },
        { repo, number: 99, head_sha_at_acceptance: "d".repeat(40) },
      ] }) });
    expect(closed.status, `verify close failed: ${JSON.stringify(closed.body)}`).toBeLessThan(400);
    expect((await acquire(repo, actor, { required_workflows: ["Deploy Dev"] })).status).toBe(200);
    const reserveOn = (h: string, pr: number | undefined = 1) => kbJson("/train.queue_facts", { repo, actor, check_retry: {
      kind: "reserve", pr, task_id: implId, head_sha: h, name: "Deploy health (merge gate)",
      source: { kind: "workflow_run", workflow_id: 99, run_attempt: 1 }, target: { kind: "workflow_run", id: 41734497120 },
      purpose: "stale_destination_gate" } });
    await kbJson("/train.queue_facts", { repo, actor, entries: [], base_state: greenCoverage(tip, 500) });
    // NO reconcile observation for repo#1 — the hub has no observed current
    // head, so the stale-destination reserve DENIES (fail-closed).
    const denied = await reserveOn(head);
    expect(denied.status, JSON.stringify(denied.body)).toBe(400);
    expect(denied.body.error).toMatch(/requires the hub-observed current head of .*#1 — none recorded, re-dispatch denied/);
    // observe only the LANE repo's leg: the unrelated repo's leg (#99) is
    // never compared against this repo's rows — the current head reserves.
    const report = await kbJson("/reconcile.report", { repo, prs: [{ number: 1, state: "OPEN", headRefOid: head, updatedAt: new Date().toISOString() }], actor: "system:reconcile" });
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect((await reserveOn(head, 2)).status).toBe(400);
    expect((await reserveOn(head, 99)).status).toBe(400);
    const ok = await reserveOn(head);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.kind).toBe("reserved");
    await kbJson("/train.lease", { repo, actor, action: "release" });
  });
});