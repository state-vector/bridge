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

  it("a dead duty on an unbound actionable PR fails the run, alarms the drill sink, and dedupes the ask", async () => {
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
      // review-role closes need receipts — the drill cites the PR it (didn't) verify
      const c = await kbJson("/transition", {
        id, to: "done", actor: "drill",
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
    expect(asks.length).toBe(1);
    const ask = (await kbJson("/get", { id: asks[0].id })).body;
    expect(ask.meta?.ask?.artefact_id).toBe(sinkId);
    expect(ask.meta?.ask?.urgency).toBe("time-sensitive");
    expect(String(ask.title)).toContain("#2403");
    expect(String(ask.title).endsWith("?")).toBe(true);
    // the identical re-report dedupes the ask (one per class), still failing
    const r3 = await report(repo, [prRow(2403)]);
    expect(r3.body.ok).toBe(false);
    const again = await kbJson("/search", { q: "reconcile ALARM", limit: 50 });
    expect((again.body?.artefacts ?? []).filter((a: any) => a.type === "question" && String(a.title).includes(repo)).length).toBe(1);
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
    expect(m2.body.accounting.reverse_closed).toBe(1);
    expect((await kbJson("/get", { id: bindingId })).body.status).toBe("done");

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
