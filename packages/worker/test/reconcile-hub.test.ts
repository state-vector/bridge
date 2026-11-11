import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Board↔GitHub reconciliation — the REAL DO drill (BR#4170).
 *
 * Tier 1 (test/reconcile.test.ts) pins the law; this file proves the
 * APPLICATION against the bundled worker: an orphan approved+mergeable PR
 * gets a binding card + the standard 5c verify duty (the #2466 class), the
 * duties ledger dedupes across reports, destination-blocked PRs bind WITHOUT
 * a verify duty until the base greens, a dead duty on an unbound actionable
 * PR fails the run AND alarms the sink, an ignore-with-reason accounts a PR,
 * and reverse reconcile closes the zombie binding via provenance (two
 * consecutive misses) or spawns a ruling duty (no provenance — never a
 * silent close). The daemon leg feeding these endpoints is pinned in
 * train.rs (packages/desktop).
 */

let mf: Miniflare;
let kbNs: any;
let sinkId = "";

const kbJson = async (path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const stub: any = await kbNs.get(kbNs.idFromName("global"));
  const res = await stub.fetch(`https://kb${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

const NOW = Date.now();
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const prRow = (number: number, over: Record<string, unknown> = {}) => ({
  number,
  title: `drill PR ${number}`,
  reviewDecision: "APPROVED",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  headRefOid: "a".repeat(40),
  headRefName: `feature/${number}`,
  updatedAt: iso(5),
  isDraft: false,
  ...over,
});
const report = (repo: string, prs: unknown[]) => kbJson("/reconcile.report", { repo, prs, actor: "system:reconcile" });
const dutiesOf = async (repo: string) => (await kbJson("/reconcile.status", { repo })).body.duties;

beforeAll(async () => {
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
  await kbJson("/orient", {});
  // drill-local alarm sink: the reconcile ALARM must bind HERE, not the real sink
  const sink = await kbJson("/create", { type: "task", title: "ALARM SINK — reconcile drill", body_md: "test-local ask sink", tags: ["alarm"] });
  expect(sink.status).toBe(200);
  sinkId = String(sink.body.id);
  const set = await kbJson("/admin.settings_set", { settings: { reconcile_alarm_sink_id: sinkId } });
  expect(set.body.error ?? "").toBe("");
});

afterAll(async () => {
  await mf?.dispose();
});

describe("reconcile DO drill (real bundled worker, BR#4170)", () => {
  it("an orphan approved+mergeable PR gets a binding card + the standard verify duty; the second report dedupes", async () => {
    const repo = "state-vector/reconcile-drill-a";
    const r1 = await report(repo, [prRow(2401)]);
    expect(r1.status).toBe(200);
    expect(r1.body.ok).toBe(true);
    expect(r1.body.accounting.open_reviewed).toBe(1);
    expect(r1.body.accounting.spawned).toBe(1);
    expect(r1.body.line).toContain("1 open reviewed");
    expect(r1.body.spawned[0].action).toBe("verify");
    const trackingId: string = r1.body.spawned[0].card;
    const dutyId: string | null = r1.body.spawned[0].duty;
    expect(dutyId).toBeTruthy();

    // the projection: meta.pr binds, session-less (machine-created), the
    // body explains the invariant
    const tracking = (await kbJson("/get", { id: trackingId })).body;
    expect(tracking.meta?.pr).toEqual({ repo, number: 2401 });
    expect(tracking.session ?? "").toBe("");
    expect(String(tracking.body_md)).toContain("BR#4170");
    expect(String(tracking.body_md)).toContain("#2466");
    // the duty: the SHARED 5c template, review-role, a child of the projection
    const duty = (await kbJson("/get", { id: dutyId })).body;
    expect(duty.title).toContain("Verify:");
    expect(duty.roles).toContain("review");
    expect(String(duty.body_md)).toContain("VERIFY GATE");
    expect(String(duty.body_md)).toContain(`pull/2401`);
    expect(String(duty.body_md)).toContain(trackingId);

    // the ledger holds ONE verify row
    expect((await dutiesOf(repo)).length).toBe(1);

    // identical re-report: the join dedupes — nothing spawns at all, the
    // open duty accounts the PR as in-flight
    const r2 = await report(repo, [prRow(2401)]);
    expect(r2.body.ok).toBe(true);
    expect(r2.body.accounting.inflight).toBe(1); // now accounted by the open duty
    expect(r2.body.accounting.spawned).toBe(0);
    expect(r2.body.spawned).toHaveLength(0);
    expect((await dutiesOf(repo)).length).toBe(1);
  });

  it("returns an independently verified repair to the train without a GitHub approval label", async () => {
    const repo = "state-vector/recovered-pr";
    expect((await kbJson("/train.lane", { repo, spec: { required_workflows: ["Test"] } })).status).toBe(200);
    const number = 2471;
    const initialHead = "a".repeat(40);
    const repairedHead = "b".repeat(40);
    const parent = (await kbJson("/create", {
      actor: "author", type: "task", title: "Restore delivery after conflict", qualified: true,
      meta: { pr: { repo, number, head_sha_at_acceptance: initialHead }, merge_train: { state: "bounced", repo, pr: number } },
    })).body.id;
    const conflicted = await report(repo, [prRow(number, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", updatedAt: iso(90) })]);
    const repair = conflicted.body.spawned.find((x: { card: string }) => x.card === parent)?.duty;
    expect(repair).toBeTruthy();
    const transition = (id: string, to: string, actor: string, fields: object = {}) => kbJson("/transition", { id, to, actor, session: actor, ...fields });
    expect((await transition(repair, "in_progress", "repairer")).status).toBe(200);
    const submitted = await transition(repair, "in_review", "repairer", { execution_result: { outcome: "Repaired and tested the PR", receipts: ["GitHub head readback"] } });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const repairReview = submitted.body.verify_task;
    expect(repairReview).toBeTruthy();
    const repairClaim = await transition(repairReview, "in_progress", "outcome-reviewer");
    const outcome = await transition(repairReview, "done", "outcome-reviewer", { review_result: {
      kind: "accepted_execution", task_id: repair, subject_revision: repairClaim.body.review_subject.revision, receipts: ["Verified GitHub repair outcome"],
    } });
    expect(outcome.status, JSON.stringify(outcome.body)).toBe(200);
    expect((await kbJson("/get", { id: repair })).body.status).toBe("done");

    // The production strand sweep runs between GitHub reports. It must
    // preserve the accepted recovery until the new head can enter review.
    const swept = await kbJson("/admin.strand_disposition_sweep", { now: NOW + 4 * 3_600_000 });
    expect(swept.status).toBe(200);
    expect((await kbJson("/get", { id: parent })).body.meta.recovery.task_id).toBe(repair);

    const observation = prRow(number, { headRefOid: repairedHead, reviewDecision: null, mergeStateStatus: "UNSTABLE", updatedAt: iso(90) });
    const inconclusive = { ...observation, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" };
    const reports = await Promise.all([report(repo, [inconclusive]), report(repo, [observation])]);
    const reviews = reports.flatMap(r => r.body.spawned.filter((x: { action: string; duty?: string }) => x.action === "verify" && x.duty));
    expect(reviews).toHaveLength(1);
    const review = reviews[0].duty;
    const claim = await transition(review, "in_progress", "pr-reviewer");
    expect(claim.body.review_subject.task_id).toBe(parent);
    const verdict = await transition(review, "done", "pr-reviewer", { review_result: {
      kind: "accepted_pr", task_id: parent, subject_revision: claim.body.review_subject.revision,
      legs: [{ repo, number, head_sha_at_acceptance: repairedHead }],
    } });
    expect(verdict.status, JSON.stringify(verdict.body)).toBe(200);
    const lane = (await kbJson("/train.status", { repo })).body.lanes.find((l: { lane: string }) => l.lane === repo + "@main");
    expect(lane.queue).toEqual(expect.arrayContaining([expect.objectContaining({ id: parent, pr: number })]));
    expect((await kbJson("/get", { id: parent })).body.meta.pr.head_sha_at_acceptance).toBe(repairedHead);
  });

  it("keeps merged delivery reviews out of the next-batch review count", async () => {
    const repo = "state-vector/terminal-review-drill";
    const number = 2472;
    expect((await kbJson("/train.lease", { repo, base: "main", action: "acquire", actor: "train", required_workflows: ["Test"] })).status).toBe(200);
    const parent = (await kbJson("/create", { actor: "author", type: "task", title: "Deliver and verify", qualified: true,
      meta: { pr: { repo, number } } })).body.id;
    const transition = (to: string, fields: object = {}) => kbJson("/transition", { id: parent, to, actor: "author", session: "author", ...fields });
    expect((await transition("in_progress")).status).toBe(200);
    expect((await transition("in_review", { note: `PR https://github.com/${repo}/pull/${number}` })).status).toBe(200);
    const lane = async () => (await kbJson("/train.status", { repo })).body.lanes.find((l: { lane: string }) => l.lane === repo + "@main");
    await report(repo, [prRow(number)]);
    expect((await lane()).pr_stats).toMatchObject({ verifying: 0, waiting: 1 });
    await report(repo, [prRow(number, { state: "MERGED", mergeCommit: "b".repeat(40) })]);
    expect((await lane()).pr_stats).toMatchObject({ verifying: 0, waiting: 0 });
    expect((await kbJson("/get", { id: parent })).body.status).toBe("in_review");
  });

  it("destination-blocked binds WITHOUT a verify duty; a later CLEAN cycle spawns the verify on the SAME card", async () => {
    const repo = "state-vector/reconcile-drill-b";
    const r1 = await report(repo, [prRow(2402, { mergeStateStatus: "BLOCKED" })]);
    expect(r1.body.ok).toBe(true);
    expect(r1.body.spawned[0].action).toBe("tracking");
    expect(r1.body.spawned[0].duty).toBeUndefined();
    const trackingId: string = r1.body.spawned[0].card;
    expect((await dutiesOf(repo)).length).toBe(0); // bind-only: no duty ledger row

    // the base greens — the next cycle duties the EXISTING projection
    const r2 = await report(repo, [prRow(2402)]);
    expect(r2.body.ok).toBe(true);
    expect(r2.body.spawned[0].action).toBe("verify");
    expect(r2.body.spawned[0].card).toBe(trackingId);
    expect(r2.body.spawned[0].duty).toBeTruthy();
    expect((await dutiesOf(repo)).map((d: any) => d.kind)).toEqual(["verify"]);
  });

  it("a dead duty on an unbound actionable PR fails the report and schedules one durable agent repair", async () => {
    const repo = "state-vector/reconcile-drill-c";
    // cycle 1: orphan → projection + verify duty
    const r1 = await report(repo, [prRow(2403)]);
    expect(r1.body.ok).toBe(true);
    // the projection and its duty both die WITHOUT the PR being resolved —
    // exactly the corpse a silent respawn would paper over. The DUTY dies
    // first: a parent cannot close while its review child is open.
    const dutyId: string = r1.body.spawned[0].duty;
    const trackingId: string = r1.body.spawned[0].card;
    for (const id of [dutyId, trackingId]) {
      await kbJson("/transition", { id, to: "in_progress", actor: "drill", note: "drill: cycling" });
      const isReview = (await kbJson("/get", { id })).body.roles.includes("review");
      // review-role closes need receipts — the drill cites the PR it (didn't) verify
      const c = await kbJson("/transition", {
        // Deliberately seed a historical human-closed binding; machine duties
        // themselves finish with findings, never a forged acceptance.
        id, to: "done", actor: isReview ? "drill" : "web:fixture",
        review_result: isReview ? { kind: "findings", summary: "Died unbound; no PR delivery is accepted." } : undefined,
        note: "drill: died unbound — PR https://github.com/state-vector/reconcile-drill-c/pull/2403 still open, nothing merged, no receipts filed",
      });
      expect(c.status, `kill close failed: ${JSON.stringify(c.body)}`).toBeLessThan(400);
    }
    // cycle 2: the PR is unbound, its duty is dead, it is past every grace —
    // the run FAILS and the alarm rides to the drill-local sink
    const r2 = await report(repo, [prRow(2403)]);
    expect(r2.body.ok).toBe(false);
    expect(r2.body.accounting.unaccounted).toBe(1);
    expect(r2.body.unaccounted[0].pr).toBe(2403);
    expect(r2.body.line).toContain("ALARM: 1 unaccounted");
    const found = await kbJson("/search", { q: "reconcile ALARM", limit: 50 });
    const asks = (found.body?.artefacts ?? []).filter((a: any) => a.type === "question" && String(a.title).includes(repo));
    expect(asks.length).toBe(0);
    const recovery = (await kbJson("/get", { id: r2.body.spawned[0].card })).body;
    expect(recovery.meta.machine_duty).toEqual({ kind: "reconcile-accounting", subject: repo });
    expect(recovery.body_md).toContain(`https://github.com/${repo}/pull/2403`);
    // The identical re-report reuses the repair rather than duplicating it.
    const r3 = await report(repo, [prRow(2403)]);
    expect(r3.body.ok).toBe(false);
    const again = await kbJson("/search", { q: "reconcile ALARM", limit: 50 });
    expect((again.body?.artefacts ?? []).filter((a: any) => a.type === "question" && String(a.title).includes(repo)).length).toBe(0);
    expect(r3.body.spawned).toHaveLength(0);
    // and the report history is the alarm's receipt
    const st = (await kbJson("/reconcile.status", { repo })).body;
    expect(st.reports.length).toBe(3);
    expect(st.last_report.ok).toBe(false);
  });

  it("an ignore-with-reason accounts the PR — on the record, not by silence", async () => {
    const repo = "state-vector/reconcile-drill-d";
    const ig = await kbJson("/reconcile.ignore", { repo, pr: 2404, reason: "docs-only roller, watched upstream", actor: "drill-human" });
    expect(ig.body.ok).toBe(true);
    // a reason IS the contract — junk is refused
    const bad = await kbJson("/reconcile.ignore", { repo, pr: 2405, reason: "", actor: "drill-human" });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const r = await report(repo, [prRow(2404)]);
    expect(r.body.ok).toBe(true);
    expect(r.body.accounting.ignored).toBe(1);
    const st = (await kbJson("/reconcile.status", { repo })).body;
    expect(st.ignores.length).toBe(1);
    expect(st.ignores[0].reason).toContain("roller");
  });

  it("reverse reconcile: two misses + provenance closes the zombie binding; no provenance spawns a ruling duty (once)", async () => {
    // -- the provenance half: a bound card whose PR merged (train-stamped) --
    const repoE = "state-vector/reconcile-drill-e";
    const binding = await kbJson("/create", {
      type: "task", title: "IMPL: reverse drill (merged)", session: "",
      meta: { pr: { repo: repoE, number: 2405 } },
    });
    const bindingId = String(binding.body.id);
    await kbJson("/train.lane", { repo: repoE, base: "main", actor: "drill-executor", spec: { required_workflows: ["Test"] } });
    const lease = await kbJson("/train.lease", { repo: repoE, base: "main", action: "acquire", actor: "drill-executor" });
    expect(lease.body.error ?? "").toBe("");
    const ev = await kbJson("/train.event", {
      repo: repoE, base: "main", kind: "merged", actor: "drill-executor",
      pr: 2405, merge_sha: "e".repeat(40), head_sha: "b".repeat(40),
      task_id: bindingId, signer: "merge-train-executor",
    });
    expect(ev.body.error ?? "").toBe("");
    await kbJson("/train.lease", { repo: repoE, base: "main", action: "release", actor: "drill-executor" });

    // first miss: the clock starts, nothing closes
    const m1 = await report(repoE, []);
    expect(m1.body.ok).toBe(true);
    expect(m1.body.accounting.reverse_missing).toBe(1);
    expect((await kbJson("/get", { id: bindingId })).body.status).not.toBe("done");
    // second miss: the provenance row is the machine proxy — the zombie closes
    const m2 = await report(repoE, []);
    expect(m2.body.accounting.reverse_closed).toBe(0);
    expect(m2.body.accounting.reverse_verifying).toBe(1);
    expect((await kbJson("/get", { id: bindingId })).body.status).toBe("in_review");

    // -- the no-provenance half: a PR vanishes with NO merge record --
    const repoF = "state-vector/reconcile-drill-f";
    const bindingF = await kbJson("/create", {
      type: "task", title: "IMPL: reverse drill (vanished)", session: "",
      meta: { pr: { repo: repoF, number: 2406 } },
    });
    const bindingFId = String(bindingF.body.id);
    await report(repoF, []); // first miss
    const mF2 = await report(repoF, []); // second miss, no provenance
    expect(mF2.body.accounting.reverse_dutied).toBe(1);
    const duties = await dutiesOf(repoF);
    expect(duties.map((d: any) => d.kind)).toEqual(["reverse"]);
    // the ruling duty is a real card, a child of the zombie binding, honest
    // about the never-silent-close contract
    const ruling = (await kbJson("/get", { id: duties[0].duty_id })).body;
    expect(ruling.title).toContain("Reverse-reconcile");
    expect(String(ruling.body_md)).toContain(bindingFId);
    expect(String(ruling.body_md)).toContain("Never close");
    expect((await kbJson("/get", { id: bindingFId })).body.status).not.toBe("done");
    // and a third miss does NOT mint a second ruling (one per PR ever)
    await report(repoF, []);
    expect((await dutiesOf(repoF)).length).toBe(1);
  });
});

// ---------- BR#5151: standing lane cards survive reconcile ----------

describe("BR#5151 lane survival (real bundled worker)", () => {
  it("a lane card with a stamped provenance row and a vanished bootstrap PR is never closed, never dutied — lease intact", async () => {
    const repo = "state-vector/lane-survival";
    // the standing lane card + a live lease: the state under protection
    const lane = await kbJson("/train.lane", { repo, base: "main", actor: "drill", spec: { required_workflows: ["Test"] } });
    expect(lane.body.error ?? "").toBe("");
    const laneId = String(lane.body.id);
    await kbJson("/train.lease", { repo, base: "main", action: "acquire", actor: "gw-keep", required_workflows: ["Test"] });
    // the incident's foothold: a PR leg on the lane + a provenance row for it
    const cur = (await kbJson("/get", { id: laneId })).body;
    const upd = await kbJson("/update", { id: laneId, meta: { ...cur.meta, pr: { repo, number: 5153 } }, actor: "drill" });
    expect(upd.status, `lane meta.pr update failed: ${JSON.stringify(upd.body)}`).toBeLessThan(400);
    const merged = await kbJson("/train.event", { repo, base: "main", kind: "merged", actor: "gw-keep", pr: 5153, merge_sha: "2".repeat(40) });
    expect(merged.body.error ?? "", `stamp merged failed: ${JSON.stringify(merged.body)}`).toBe("");

    // reconcile: the PR is NOT in the open list — reported twice (past the
    // two-consecutive guard). The provenance row is exactly what retired the
    // BR#5050 lane; the lane flag must make both runs account-and-move-on.
    const r1 = await report(repo, []);
    expect(r1.status).toBe(200);
    expect(r1.body.ok).toBe(true);
    expect(r1.body.accounting.reverse_lane_exempt).toBe(1);
    expect(r1.body.accounting.reverse_closed).toBe(0);
    const r2 = await report(repo, []);
    expect(r2.body.ok).toBe(true);
    expect(r2.body.accounting.reverse_closed).toBe(0);
    expect(r2.body.accounting.reverse_dutied).toBe(0);

    // the lane card survived: non-terminal, meta.lane intact, LEASE INTACT
    const after = (await kbJson("/get", { id: laneId })).body;
    expect(["todo", "in_progress", "in_review", "blocked"]).toContain(after.status);
    expect(after.meta?.lane?.key).toBe(`${repo}@main`);
    expect(after.meta?.lease?.holder).toBe("gw-keep");
    // and no ruling duty was spawned at it
    expect(((await dutiesOf(repo)) as any[]).filter((d) => d.kind === "reverse")).toHaveLength(0);
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-keep" });
  });

  it("a lane card bound to an OPEN actionable PR is accounted bound — reconcile never spawns a verify duty at it", async () => {
    const repo = "state-vector/lane-forward";
    const lane = await kbJson("/train.lane", { repo, base: "main", actor: "drill", spec: { required_workflows: ["Test"] } });
    const laneId = String(lane.body.id);
    const cur = (await kbJson("/get", { id: laneId })).body;
    const upd = await kbJson("/update", { id: laneId, meta: { ...cur.meta, pr: { repo, number: 5154 } }, actor: "drill" });
    expect(upd.status).toBeLessThan(400);
    // approved + mergeable + 72h old: on ANY normal bound card this spawns
    // the standard verify duty; on a lane card it must not
    const r = await report(repo, [prRow(5154, { updatedAt: iso(72) })]);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.accounting.bound).toBe(1);
    expect(r.body.accounting.spawned).toBe(0);
    expect((await dutiesOf(repo) as any[]).length).toBe(0);
    const after = (await kbJson("/get", { id: laneId })).body;
    expect(after.status).toBe("blocked");
  });
});

// ---------- BR#5677: binding outranks the review gate + stamp legs ----------
// Census BR#5634: branch protection dismisses the bot's approval on every
// rebase, so every train-owned PR reads reviewDecision="" — the join gated
// the binding lookup on a review decision, so "0 bound / 54 unreviewed" read
// green while the train held 37 cars. Two fixes pinned here: the join's
// binding-before-review-gate order (reconcile.test.ts tier 1) and the DO's
// binding PROJECTION treating a meta.merge_train stamp (pr + repo) as
// binding evidence when no meta.pr/meta.prs leg was ever written.

describe("BR#5677 binding-before-review-gate + merge_train stamp legs (real bundled worker, census BR#5634)", () => {
  it("train-owned PRs (reviewDecision='') bind via meta.pr AND via the stamp alone — unreviewed counts only the genuinely unbound", async () => {
    const repo = "state-vector/reconcile-drill-5677";

    // card A: bound the classic way — a meta.pr leg on an open card
    const a = await kbJson("/create", {
      type: "task", title: "IMPL: 5677 meta.pr-bound drill", session: "",
      meta: { pr: { repo, number: 2440 } },
    });
    expect(a.status).toBe(200);

    // card B: NO meta.pr/meta.prs leg — only the train's own stamp (the
    // exact shape the bounce/awaiting/queue paths write: state + pr + repo)
    const b = await kbJson("/create", { type: "task", title: "IMPL: 5677 stamp-bound drill", session: "" });
    expect(b.status).toBe(200);
    const bUpd = await kbJson("/update", {
      id: String(b.body.id), actor: "drill",
      meta: { merge_train: { state: "awaiting", pr: 2441, repo } },
    });
    expect(bUpd.status, `stamp meta update failed: ${JSON.stringify(bUpd.body)}`).toBeLessThan(400);

    // three train-owned PRs, ALL with the dismissed-bot reviewDecision=""
    const r = await report(repo, [
      prRow(2440, { reviewDecision: null }),
      prRow(2441, { reviewDecision: null }),
      prRow(2442, { reviewDecision: null }), // genuinely unbound
    ]);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.accounting.bound).toBe(2); // 2440 via meta.pr, 2441 via the stamp
    expect(r.body.accounting.unreviewed).toBe(1); // 2442 only
    expect(r.body.accounting.spawned).toBe(0); // unreviewed PRs never spawn
    expect(r.body.spawned).toHaveLength(0);
    expect(r.body.line).toContain("2 bound");
    expect(r.body.line).toContain("+1 unreviewed");

    // a stamp WITHOUT a repo binds nothing — PR numbers are per-repo
    // namespaces and a bare stamp pr must not cross-bind another repo's PR
    const repo2 = "state-vector/reconcile-drill-5677b";
    const c = await kbJson("/create", { type: "task", title: "IMPL: 5677 bare-stamp drill", session: "" });
    await kbJson("/update", {
      id: String(c.body.id), actor: "drill",
      meta: { merge_train: { state: "queued", pr: 2443 } }, // no repo
    });
    const r2 = await report(repo2, [prRow(2443, { reviewDecision: null })]);
    expect(r2.body.accounting.bound).toBe(0);
    expect(r2.body.accounting.unreviewed).toBe(1);
  });
});
