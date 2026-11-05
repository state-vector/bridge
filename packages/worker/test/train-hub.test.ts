import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Serialized merge train — DO-level guards (decision BR#3516, impl BR#3517).
 *
 * The lane primitive: ONE standing card per (repo, base), blocked from birth,
 * config riding settings + the executor's acquire (never hardcoded). The CAS
 * lease: a live holder rejects a second gateway; only the holder
 * renews/releases; a free lane re-grants (a crash's lease is reconciled —
 * lapse itself is pinned pure in test/merge-train.test.ts). The FULL delivery
 * lifecycle through the REAL accept hook (a review-role verify duty closing
 * done with a `head <sha>` stamp queues the impl card) → merged →
 * awaiting-CI → landed via the machine-proxy close. The conflict bounce:
 * the verdict is INVALID, the fix-up brief rides the card, the queue
 * advances. A verify close with no head stamp does NOT queue (unbound,
 * fail-closed). The pure decision layer is pinned in test/merge-train.test.ts.
 */

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

const check = (id: number, name: string, conclusion: string | null, url = `https://example/ci/${id}`) =>
  ({ id, name, status: conclusion == null ? "in_progress" : "completed", conclusion, html_url: url });

beforeAll(async () => {
  // same rig recipe as kb-throughput.test.ts: realpath + modulesRoot + useSQLite
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  if (!existsSync(bundle)) {
    throw new Error("bundle missing — run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle (before vitest)");
  }
  mf = new Miniflare({
    // HTTP server ON: the SSE test dials the real /api/kb/sse route through
    // it — the DO stub bridge cannot carry an open streaming Response — and
    // a single runtime keeps stub calls + SSE in the SAME durable object.
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
  kbNs = await mf.getDurableObjectNamespace("KB");
  await kbJson("/orient", {});
});

afterAll(async () => {
  await mf?.dispose();
});

const acquire = (repo: string, actor: string, extra: Record<string, unknown> = {}) =>
  kbJson("/train.lease", { repo, base: "main", action: "acquire", actor, ...extra });

async function laneSnap(repo: string): Promise<any> {
  const { body } = await kbJson("/train.status", { repo });
  expect(body.hub_commit).toMatch(/^[0-9a-f]{40}$/);
  return body.lanes[0];
}

/** The REAL accept chain: impl card + review-role verify duty closed done
 *  citing the head it verified + the PR — the hub stamps meta.pr and queues
 *  the impl card onto the train. Returns BOTH ids: the BR#5226 migration
 *  drill stamps the legacy Awaiting park with the SAME verdict id the park
 *  era's awaiting.verdict_id carried. Zero GitHub anywhere. */
async function queueViaAcceptBoth(opts: { repo: string; pr: number; head?: string | null; title?: string; session?: string }): Promise<{ implId: string; verifyId: string }> {
  // session: "" = explicitly anonymous (resolveSession's contract) — the impl
  // card must NOT inherit the token's last-seen session, or the separation
  // guard would see the drill verify session as the impl session
  const impl = await kbJson("/create", { type: "task", title: opts.title ?? "IMPL: train hub drill", session: "" });
  expect(impl.status).toBe(200);
  const implId = String(impl.body.id);
  const verify = await kbJson("/create", {
    type: "task", title: `VERIFY: train hub drill ${implId}`, roles: ["review"],
    session: opts.session ?? "bridge-task-BR-drill-verify",
  });
  expect(verify.status).toBe(200);
  const verifyId = String(verify.body.id);
  await kbJson("/link", { src: verifyId, relation: "child_of", dst: implId });
  const note = opts.head
    ? `verified head ${opts.head} (drill) — PR https://github.com/${opts.repo}/pull/${opts.pr}`
    : `verified (drill) — PR https://github.com/${opts.repo}/pull/${opts.pr}`;
  await kbJson("/transition", { id: verifyId, to: "in_progress", actor: "drill-verifier", note: "drill: verifying" });
  const closed = await kbJson("/transition", { id: verifyId, to: "done", actor: "drill-verifier", note });
  expect(closed.status, `verify close failed: ${JSON.stringify(closed.body)}`).toBeLessThan(400);
  return { implId, verifyId };
}

async function queueViaAccept(opts: { repo: string; pr: number; head?: string | null; title?: string; session?: string }): Promise<string> {
  return (await queueViaAcceptBoth(opts)).implId;
}

describe("merge train DO drill (real bundled worker)", () => {
  it("out-of-band repair merge observations require the accepted PR/head and do not certify live recovery", async () => {
    const repo = "state-vector/repair-delivery-6522", baseline = "7".repeat(40), acceptedHead = "9".repeat(40);
    const task = await queueViaAccept({ repo, pr: 991, head: acceptedHead });
    await acquire(repo, "delivery-merger", { required_workflows: ["deploy / Deploy to dev"] });
    await kbJson("/train.queue_facts", { repo, actor: "delivery-merger", entries: [], base_state: { verdict: "green", tip_sha: baseline, red: [], unsettled: [] } });
    const cause = { kind: "test_failure", check: "Cortex Quality Smoke", suite: "classifier", test: "honest_refusal" };
    await kbJson("/train.observe_deploy", { repo, observation: { tip_sha: baseline, observed_at: Date.now(), runs: [{ id: 100, name: "Deploy Dev", head_sha: baseline,
      status: "completed", conclusion: "failure", html_url: `https://github.com/${repo}/actions/runs/100` }],
      failures: [{ run_id: 100, name: "Cortex Quality Smoke", url: `https://github.com/${repo}/actions/runs/100/job/1`, cause, repair_task_id: task }] } });
    const args = { repo, head_sha: baseline, cause, event_id: "merge-observation", event: { kind: "repair_delivery_observed", task_id: task, pr: 991,
      head_sha: acceptedHead, merge_sha: "8".repeat(40), url: `https://github.com/${repo}/pull/991` }, actor: "observer" };
    const result = await kbJson("/train.recovery_event", args);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.episode.delivery.kind).toBe("observed_merge");
    expect(result.body.episode.stage.phase).toBe("verifying");
    expect(result.body.episode.verified_receipts).toHaveLength(0);
    const wrong = await kbJson("/train.recovery_event", { ...args, event_id: "wrong-head", event: { ...args.event, head_sha: "a".repeat(40) } });
    expect(wrong.status).toBe(400);
    const prove = async (tip: string, run: number) => {
      await kbJson("/train.queue_facts", { repo, actor: "delivery-merger", entries: [], base_state: { verdict: "green", tip_sha: tip, red: [], unsettled: [] } });
      await kbJson("/train.observe_deploy", { repo, observation: { tip_sha: tip, observed_at: Date.now(), runs: [{ id: run, name: "Deploy Dev", head_sha: tip,
        status: "completed", conclusion: "success", html_url: `https://github.com/${repo}/actions/runs/${run}` }] } });
      await kbJson("/train.queue_facts", { repo, actor: "delivery-merger", entries: [], base_state: { verdict: "green", tip_sha: tip, red: [], unsettled: [],
        deploy_coverage: { phase: "covered", tip_sha: tip, tip_age_secs: 60, covered_by_sha: tip, covered_by_run_id: run } } });
      return (await laneSnap(repo)).line.recoveries[0].episode;
    };
    expect((await prove(baseline, 101)).verified_receipts).toHaveLength(0);
    expect((await prove("8".repeat(40), 102)).stage.phase).toBe("recovered");
  });
  it("observations carrying an IN-FLIGHT deploy run (conclusion key absent) are accepted, not rejected wholesale (2026-11-05 incident)", async () => {
    const repo = "state-vector/observe-inflight-run", tip = "7".repeat(40);
    await acquire(repo, "observe-merger", { required_workflows: ["deploy / Deploy to dev"] });
    await kbJson("/train.queue_facts", { repo, actor: "observe-merger", entries: [], base_state: { verdict: "green", tip_sha: tip, red: [], unsettled: [] } });
    // The exact incident shape: the Rust runner's skip_serializing_if OMITS
    // conclusion for runs GitHub still reports as in_progress. Before the fix
    // the whole observation (settled runs included) died on a missing-key
    // invalid_value that read like an enum violation.
    const mixed = await kbJson("/train.observe_deploy", { repo, actor: "observer", observation: {
      tip_sha: tip, observed_at: Date.now(), runs: [
        { id: 200, name: "Deploy Dev", head_sha: tip, status: "in_progress", html_url: `https://github.com/${repo}/actions/runs/200` },
        { id: 199, name: "Deploy Dev", head_sha: tip, status: "completed", conclusion: "success", html_url: `https://github.com/${repo}/actions/runs/199` },
      ] } });
    expect(mixed.status, JSON.stringify(mixed.body)).toBe(200);
    // Explicit null (the hardened runner's shape) is accepted too.
    const explicitNull = await kbJson("/train.observe_deploy", { repo, actor: "observer", observation: {
      tip_sha: tip, observed_at: Date.now(), runs: [
        { id: 201, name: "Deploy Dev", head_sha: tip, status: "queued", conclusion: null, html_url: `https://github.com/${repo}/actions/runs/201` },
      ] } });
    expect(explicitNull.status, JSON.stringify(explicitNull.body)).toBe(200);
    // The enum itself stays closed.
    const bad = await kbJson("/train.observe_deploy", { repo, actor: "observer", observation: {
      tip_sha: tip, observed_at: Date.now(), runs: [
        { id: 202, name: "Deploy Dev", head_sha: tip, status: "completed", conclusion: "nope", html_url: `https://github.com/${repo}/actions/runs/202` },
      ] } });
    expect(bad.status).toBe(400);
  });
  it("recovery records survive retries and task delivery; only matched successful deployment proves recovery", async () => {
    const repo = "state-vector/recovery-loop-6522", head = "7".repeat(40);
    const repair = await kbJson("/create", { type: "task", title: "Repair callers availability", qualified: true, roles: ["impl"] });
    const task = String(repair.body.id);
    await kbJson("/transition", { id: task, to: "in_progress", actor: "repairer", session: "impl-6522", note: "claim repair" });
    await acquire(repo, "merger-6522", { required_workflows: ["deploy / Deploy to dev"] });
    await kbJson("/train.queue_facts", { repo, actor: "merger-6522", entries: [], base_state: { verdict: "green", tip_sha: head, red: [], unsettled: [] } });
    const cause = { kind: "capability_unavailable", check: "Cortex Quality Smoke", scenario: "php-sql-injection", capability: "callers", scope: "includes/User/User.php:2416" };
    const observe = (id: number, conclusion: string, attempt = 1) => kbJson("/train.observe_deploy", { repo, actor: "observer", observation: {
      tip_sha: head, observed_at: Date.now(), runs: [{ id, name: "Deploy Dev", path: ".github/workflows/deploy-dev.yml", head_sha: head, run_attempt: attempt,
        status: "completed", conclusion, html_url: `https://github.com/${repo}/actions/runs/${id}` }],
      failures: conclusion === "failure" ? [{ run_id: id, name: "Cortex Quality Smoke", url: `https://github.com/${repo}/actions/runs/${id}/job/456`, cause, repair_task_id: task }] : [],
    } });
    expect((await observe(123, "failure", 5)).body.error ?? "").toBe("");
    const sponsored = (await kbJson("/get", { id: task })).body;
    expect(sponsored.tags).toContain("root_blocker");
    expect(sponsored.meta.root_fix).toMatchObject({ repo, head_sha: head });
    const command = (event_id: string, event: Record<string, unknown>) => kbJson("/train.recovery_event", { repo, head_sha: head, cause, event_id, event, actor: "repairer" });
    const diagnosed = await command("diagnosis", { kind: "diagnosed", task_id: task, diagnosis: "Adjacency read exceeds callers deadline", next: "Implement pruning" });
    expect(diagnosed.body.episode.stage.phase).toBe("repairing");
    await kbJson("/progress.log", { id: task, actor: "observer", did: "Independent diagnostic comment", will: "Await impl claim" });
    expect((await laneSnap(repo)).line.recoveries[0].episode.stage.next).toBe("Implement pruning");
    expect((await kbJson("/get", { id: task })).body.meta.last_progress?.actor).not.toBe("observer");
    const wrongExecutor = await kbJson("/train.recovery_event", { repo, head_sha: head, cause, event_id: "not-owner",
      event: { kind: "diagnosed", task_id: task, diagnosis: "Different diagnosis", next: "Replace next step" }, actor: "observer" });
    expect(wrongExecutor.status).toBe(400);
    const started = { kind: "attempt_started", task_id: task, attempt_id: "repair-1", attempt_kind: "repair", action: "Implement pruning and regression", next: "Publish repair" };
    expect((await command("start", started)).body.authorized).toBe(true);
    expect((await command("start", started)).body.authorized).toBe(false);
    await command("delivered", { kind: "attempt_finished", task_id: task, attempt_id: "repair-1", outcome: "delivered", summary: "Repair published", receipts: [`https://github.com/${repo}/commit/123`], next: "Verify deployment" });
    let snap = await laneSnap(repo);
    expect(snap.line.recoveries[0].episode.stage.phase).toBe("verifying");
    expect((await observe(123, "failure", 6)).body.error ?? "").toBe("");
    snap = await laneSnap(repo);
    expect(snap.line.recoveries).toHaveLength(1);
    expect(snap.line.recoveries[0].episode.sources).toHaveLength(2);
    expect(snap.line.recoveries[0].episode.stage.phase).not.toBe("recovered");
    await observe(124, "success");
    await kbJson("/train.queue_facts", { repo, actor: "merger-6522", entries: [], base_state: { verdict: "green", tip_sha: head, red: [], unsettled: [],
      deploy_coverage: { phase: "covered", tip_sha: head, tip_age_secs: 60, covered_by_sha: head, covered_by_run_id: 124 } } });
    snap = await laneSnap(repo);
    expect(snap.line.recoveries[0].episode.stage.phase).toBe("verifying");
    expect(snap.line.recoveries[0].episode.verified_receipts).toHaveLength(1);
    // A passing live run does not accept a still-unreviewed code repair.
    const handoff = await kbJson("/transition", { id: task, to: "in_review", actor: "repairer", session: "impl-6522", note: `Direct main https://github.com/${repo}/commit/${head}` });
    expect(handoff.status, JSON.stringify(handoff.body)).toBe(200);
    const verifyId = handoff.body.verify_task;
    await kbJson("/transition", { id: verifyId, to: "in_progress", actor: "verifier-6522", session: "verify-6522", note: "checking repair" });
    const accepted = await kbJson("/transition", { id: verifyId, to: "done", actor: "verifier-6522", session: "verify-6522",
      note: `VERIFY ACCEPT commit ${head} https://github.com/${repo}/actions/runs/124`,
      review_result: { kind: "accepted_direct_main", repo, commit: head, ci_run_url: `https://github.com/${repo}/actions/runs/124` } });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((await kbJson("/get", { id: task })).body.status).toBe("done");
    snap = await laneSnap(repo);
    expect(snap.line.recoveries[0].episode.stage.phase).toBe("recovered");
    expect(snap.line.recoveries[0].episode.stage.receipt.run_id).toBe(124);
    const fake = await command("fake-recovery", { kind: "recovered", task_id: task });
    expect(fake.status).toBe(400);
  });
  it("deployment observations stop a failed line independently of the merge lease and survive stale green gateway snapshots", async () => {
    const repo = "state-vector/observe-deploy-6389";
    const tip = "7".repeat(40);
    await acquire(repo, "merger", { required_workflows: ["deploy / Deploy to dev"] });
    const green = { verdict: "green", tip_sha: tip, red: [], unsettled: [], green: 1 };
    await kbJson("/train.queue_facts", { repo, actor: "merger", entries: [], base_state: green });
    const observation = { tip_sha: tip, observed_at: Date.now(), runs: [{ id: 123, name: "Deploy Dev", path: ".github/workflows/deploy-dev.yml",
      head_sha: tip, status: "completed", conclusion: "failure", html_url: `https://github.com/${repo}/actions/runs/123` }],
      failures: [{ run_id: 123, name: "Cortex Quality Smoke", url: `https://github.com/${repo}/actions/runs/123/job/456` }] };
    const result = await kbJson("/train.observe_deploy", { repo, actor: "independent-observer", observation });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.lanes[0].line).toMatchObject({ phase: "stopped", blocker: "main_failed" });
    expect(result.body.lanes[0].line.evidence.some((e: { name: string }) => e.name === "Cortex Quality Smoke")).toBe(true);
    await kbJson("/train.queue_facts", { repo, actor: "merger", entries: [], base_state: green });
    const after = await laneSnap(repo);
    expect(after.queue_facts.base_state.verdict).toBe("red");
    expect(after.lane_state.phase).toBe("stopped_red");
    expect(after.base_red_resolution.fix_card).toBeTruthy();
    const bad = await kbJson("/train.observe_deploy", { repo, actor: "independent-observer", observation: { ...observation, tip_sha: "8".repeat(40) } });
    expect(bad.status).toBe(400);
  });
  it("an existing lane accepts explicit required-check configuration atomically and returns the refreshed row", async () => {
    const repo = "state-vector/lane-reconfigure-6389";
    const first = await kbJson("/train.lane", { repo, spec: { required_workflows: ["Deploy"] } });
    const changed = await kbJson("/train.lane", { repo, spec: { required_workflows: ["Deploy", "Cortex Quality Smoke"] } });
    expect(changed.body.id).toBe(first.body.id);
    expect(JSON.parse(changed.body.meta).lane.required_workflows).toEqual(["Deploy", "Cortex Quality Smoke"]);
    expect((await laneSnap(repo)).required_workflows).toEqual(["Deploy", "Cortex Quality Smoke"]);
  });
  it("one standing lane card per (repo, base) — created once, blocked from birth, config rides settings + acquire (never hardcoded)", async () => {
    // settings-seeded config for a repo nobody has touched yet
    const seed = await kbJson("/admin.settings_set", {
      settings: { train_lane: JSON.stringify({ "state-vector/lane-seed@main": { required_workflows: ["Rust Tests"], ci_typical_minutes: 30 } }) },
    });
    expect(seed.body.error ?? "").toBe("");
    const l1 = await kbJson("/train.lane", { repo: "state-vector/lane-seed", base: "main", actor: "drill" });
    expect(l1.body.error ?? "").toBe("");
    expect(l1.body.title).toBe("Merge lane: state-vector/lane-seed@main");
    expect(l1.body.status).toBe("blocked");
    const lane1 = JSON.parse(l1.body.meta ?? "{}");
    expect(lane1.lane.required_workflows).toEqual(["Rust Tests"]);
    expect(lane1.lane.ci_typical_minutes).toBe(30);
    expect(lane1.blocked.reason).toBe("merge-train: awaiting an available gateway");
    const laneTags = Array.isArray(l1.body.tags) ? l1.body.tags : JSON.parse(String(l1.body.tags ?? "[]"));
    expect(laneTags).toEqual(expect.arrayContaining(["merge-train", "infrastructure"]));
    expect(String(l1.body.body_md)).toContain("bridge train");
    expect(String(l1.body.body_md)).toContain("BR#3516");
    expect(String(l1.body.body_md)).toContain("Rust Tests");
    // find-or-create: the second call returns the SAME card, untouched
    const l2 = await kbJson("/train.lane", { repo: "state-vector/lane-seed", base: "main", actor: "drill" });
    expect(l2.body.id).toBe(l1.body.id);

    // the executor's acquire carries ITS lane config — the working copy
    // refreshes in place (config, never hardcoded)
    const repo = "state-vector/lane-config";
    await acquire(repo, "gw-cfg", { required_workflows: ["Test", "Deploy"], ci_typical_minutes: 25 });
    const snap = await laneSnap(repo);
    expect(snap.required_workflows).toEqual(["Test", "Deploy"]);
    const meta = (await kbJson("/get", { id: snap.card })).body.meta ?? {};
    expect(meta.lane.ci_typical_minutes).toBe(25);
    expect(meta.lane.key).toBe("state-vector/lane-config@main");
  });

  it("the lease is a CAS: a live holder rejects a second gateway; only the holder renews/releases; a freed lane re-grants", async () => {
    const repo = "state-vector/lane-cas";
    const a = await acquire(repo, "gw-1");
    expect(a.body.error ?? "").toBe("");
    expect(a.body.lease.holder).toBe("gw-1");
    expect(String(a.body.note)).toContain("lane was free");

    const b = await acquire(repo, "gw-2");
    expect(b.status).toBe(400);
    expect(String(b.body.error)).toContain("held live by gw-1");
    expect(String(b.body.error)).toContain("stand down this tick");
    const renewOther = await kbJson("/train.lease", { repo, base: "main", action: "renew", actor: "gw-2" });
    expect(renewOther.status).toBe(400);
    const relOther = await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-2" });
    expect(relOther.status).toBe(400);
    expect(String(relOther.body.error)).toContain("only the holder releases");

    const renewMine = await kbJson("/train.lease", { repo, base: "main", action: "renew", actor: "gw-1" });
    expect(renewMine.body.error ?? "").toBe("");
    expect(renewMine.body.lease.holder).toBe("gw-1");
    const rel = await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-1" });
    expect(rel.body.error ?? "").toBe("");
    expect(rel.body.lease).toBeNull();

    const again = await acquire(repo, "gw-2");
    expect(again.body.error ?? "").toBe("");
    expect(again.body.lease.holder).toBe("gw-2");
  });

  it("idle ≠ gateway-less: a recent merge-capable tick marks the lane READY with the machine named (Ray 2026-10-29 — readiness visible with no work queued)", async () => {
    const repo = "state-vector/lane-ready";
    // fresh lane: no capable tick ever — the honest awaiting reason
    await kbJson("/train.lane", { repo, base: "main", actor: "drill" });
    const fresh = await laneSnap(repo);
    expect(fresh.reason).toBe("merge-train: awaiting an available gateway");
    expect(fresh.capable).toBeNull();
    // a merge-capable acquire+release (the gateway's idle-tick shape) → READY
    const a = await acquire(repo, "gw-ready", { merge_capable: true });
    expect(a.body.error ?? "").toBe("");
    const rel = await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-ready" });
    expect(rel.body.error ?? "").toBe("");
    const snap = await laneSnap(repo);
    expect(snap.capable).toEqual(expect.objectContaining({ holder: "gw-ready", ready: true }));
    expect(snap.capable.age_ms).toBeLessThan(15 * 60_000);
    const cardMeta = (await kbJson("/get", { id: snap.card })).body.meta ?? {};
    expect(String(cardMeta.blocked?.reason ?? "")).toBe("merge-train: ready — last ticked by gw-ready 0m ago");
  });

  it("queued → merged → awaiting-CI → landed: the accept hook queues, the hub stamps provenance, and the card closes on the machine proxy", async () => {
    const repo = "state-vector/bridge";
    const HEAD = "a".repeat(40);
    const card = await queueViaAccept({ repo, pr: 2600, head: HEAD, title: "IMPL: train hub lifecycle drill" });

    // the accept hook queued it: blocked, merge-train stamp, head stamp
    let c = (await kbJson("/get", { id: card })).body;
    expect(c.status).toBe("blocked");
    expect(c.meta?.merge_train?.state).toBe("queued");
    expect(c.meta?.pr?.head_sha_at_acceptance).toBe(HEAD);
    expect(c.meta?.pr?.number).toBe(2600);
    expect(c.meta?.pr?.repo).toBe(repo);
    // the derived queue COMPUTES it (never a stored list)
    expect((await laneSnap(repo)).queue.map((x: any) => x.id)).toContain(card);

    await acquire(repo, "gw-1", { required_workflows: ["Test", "Deploy"] });
    const M = "c".repeat(40);
    const merged = await kbJson("/train.event", {
      repo, base: "main", kind: "merged", actor: "gw-1",
      pr: 2600, merge_sha: M, head_sha: HEAD, task_id: card,
      merged_at: Date.now() - 10 * 60_000, // past the settle dwell (BR#4804)
    });
    expect(merged.body.error ?? "", `train:merged failed: ${JSON.stringify(merged.body)}`).toBe("");
    expect(merged.body.task).toBe(card);

    // awaiting-CI: the card stays blocked (lifecycle forbids blocked→blocked)
    // with the state riding meta.merge_train; the lane shows the in-flight merge
    c = (await kbJson("/get", { id: card })).body;
    expect(c.status).toBe("blocked");
    expect(c.meta?.merge_train?.state).toBe("awaiting-ci");
    expect(c.meta?.provenance?.merge_sha).toBe(M);
    expect(c.meta?.provenance?.signer).toBeTruthy();
    const mid = await laneSnap(repo);
    expect(mid.currently.phase).toBe("awaiting-ci");
    expect(mid.currently.pr).toBe(2600);
    expect(String(mid.reason)).toContain("settling on");

    // pending required CI: the lane holds
    const pending = await kbJson("/train.ci", { repo, base: "main", actor: "gw-1", sha: M, checks: [check(3, "Test", null)] });
    expect(pending.body.decided).toBe("pending");
    expect((await kbJson("/get", { id: card })).body.status).toBe("blocked");

    // green required CI: landed through the machine proxy
    const landed = await kbJson("/train.ci", {
      repo, base: "main", actor: "gw-1", sha: M,
      checks: [check(4, "Test", "success", "https://example/ci/green-test"), check(5, "Deploy", "success", "https://example/ci/green-deploy")],
    });
    expect(landed.body.decided).toBe("landed");
    const done = (await kbJson("/get", { id: card })).body;
    expect(done.status).toBe("done");
    expect(done.meta?.merge_train?.state).toBe("landed");
    // the close note IS the machine proxy: mergeCommit non-null + main green
    const h = JSON.stringify(await (await kbJson("/get_history", { id: card, limit: 10 })).body);
    expect(h).toContain("landed via the serialized merge train (BR#3516)");
    expect(h).toContain("machine proxy held: mergeCommit non-null AND required main workflows green");
    expect(h).toContain(`merged as ${M.slice(0, 9)}`);
    expect(h).toContain(`github.com/${repo}/commit/${M}`);

    // the lane idles WITH the lease still held (the executor keeps the lease
    // across queue items — release is the executor's parting tick); the
    // landed card left the derived queue
    const snap = await laneSnap(repo);
    expect(snap.currently).toBeNull();
    expect(snap.reason).toBe("merge-train: leased by gw-1 — idle");
    expect(snap.queue.map((x: any) => x.id)).not.toContain(card);
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-1" });
    expect((await laneSnap(repo)).reason).toBe("merge-train: awaiting an available gateway");
    const hist = (await kbJson("/train.history", { repo })).body.events;
    expect(hist.map((e: any) => e.kind)).toEqual(expect.arrayContaining(["merged", "landed"]));
    expect(hist.find((e: any) => e.kind === "landed").gateway).toBe("gw-1");
    expect(hist.find((e: any) => e.kind === "merged").task_id).toBe(card);

    // the Top-view train panel's activity block: throughput over trailing
    // windows + the last ledger event with gateway attribution
    const act = (await laneSnap(repo)).activity;
    expect(act).toBeTruthy();
    expect(act.merged_1h).toBeGreaterThanOrEqual(1);
    expect(act.merged_24h).toBeGreaterThanOrEqual(1);
    expect(act.last_merge_ts).toBeGreaterThan(0);
    expect(act.last_event.kind).toBe("landed");
    expect(act.last_event.gateway).toBe("gw-1");
    expect(act.last_event.task_id).toBe(card);
  });

  it("BR#5385 mid-walk merged receipt: a same-actor peer release mid-walk no longer destroys the landing's provenance (the 2026-11-01 11:18Z incident)", async () => {
    const repo = "state-vector/midwalk";
    const HEAD = "a".repeat(40);
    const card = await queueViaAccept({ repo, pr: 5385, head: HEAD, title: "IMPL: mid-walk receipt drill" });
    await acquire(repo, "gw-walk");
    // THE INCIDENT: a peer walker under the SAME actor (one gateway token —
    // the CAS reads every op as "already mine") releases the lease mid-walk.
    const rel = await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-walk" });
    expect(rel.body.error ?? "").toBe("");
    // the winner's merged event arrives with the lane UNHELD — admitted, not
    // lost: provenance stamps, the lane settles, the batch is not aborted.
    const M = "d".repeat(40);
    const merged = await kbJson("/train.event", {
      repo, base: "main", kind: "merged", actor: "gw-walk",
      pr: 5385, merge_sha: M, head_sha: HEAD, task_id: card,
    });
    expect(merged.body.error ?? "", `mid-walk receipt refused: ${JSON.stringify(merged.body)}`).toBe("");
    expect(merged.body.merge_sha).toBe(M);
    const mid = await laneSnap(repo);
    expect(mid.currently.pr).toBe(5385);
    expect(mid.currently.phase).toBe("awaiting-ci");
    expect(mid.currently.merge_sha).toBe(M);
    const c = (await kbJson("/get", { id: card })).body;
    expect(c.meta?.provenance?.merge_sha).toBe(M);
    // the receipt is loud on the ledger: mid_walk_receipt rides the event detail
    const ev = (await kbJson("/train.history", { repo, kind: "merged", pr: 5385 })).body.events[0];
    expect(ev.detail.mid_walk_receipt).toEqual({ lost_via: "train:lease_release", lost_at: expect.any(String) });
    // and the fail-closed legs hold: a fresh lane (no lease loss on record)
    // still refuses; an actor that never held the lease still refuses.
    const fresh = await kbJson("/train.event", { repo: "state-vector/midwalk-fresh", base: "main", kind: "merged", actor: "gw-stranger", pr: 1, merge_sha: "e".repeat(40) });
    expect(fresh.status).toBe(400);
    expect(String(fresh.body.error)).toContain("train events require the lane lease");
    const rogue = await kbJson("/train.event", { repo, base: "main", kind: "merged", actor: "gw-rogue", pr: 5385, merge_sha: "f".repeat(40) });
    expect(rogue.status).toBe(400);
    expect(String(rogue.body.error)).toContain("held by gw-walk");
  });

  it("the batch composition rides the merged event: batch_members is sanitized into the ledger detail (BR#4996)", async () => {
    const repo = "state-vector/batch-ledger";
    const card = await queueViaAccept({ repo, pr: 2650, head: "d".repeat(40), title: "IMPL: batch ledger drill" });
    await acquire(repo, "gw-batch");
    const M = "e".repeat(40);
    const merged = await kbJson("/train.event", {
      repo, base: "main", kind: "merged", actor: "gw-batch",
      pr: 2650, merge_sha: M, head_sha: "d".repeat(40), task_id: card,
      burst_merged: 2, burst_cap: 10, burst_settling: false,
      batch_members: [2610, 0, -3, "x", 2611, 2610], // junk filtered, deduped, order kept
    });
    expect(merged.body.error ?? "", `train:merged failed: ${JSON.stringify(merged.body)}`).toBe("");
    const hist = (await kbJson("/train.history", { repo })).body.events;
    const row = hist.find((e: any) => e.kind === "merged" && e.pr === 2650 && e.merge_sha === M);
    expect(row).toBeTruthy();
    expect(row.detail.batch_members).toEqual([2610, 2611]);

    // absent payload → legacy byte-identical: no batch_members key at all.
    // BR#5151 (a PR merges exactly once) forbids a second merged event with a
    // different sha for the same PR — the legacy cadence rides a fresh PR.
    const legacyCard = await queueViaAccept({ repo, pr: 2651, head: "d".repeat(40), title: "IMPL: batch ledger drill (legacy cadence)" });
    const legacy = await kbJson("/train.event", {
      repo, base: "main", kind: "merged", actor: "gw-batch",
      pr: 2651, merge_sha: "f".repeat(40), head_sha: "d".repeat(40), task_id: legacyCard,
    });
    expect(legacy.body.error ?? "", `legacy train:merged failed: ${JSON.stringify(legacy.body)}`).toBe("");
    const hist2 = (await kbJson("/train.history", { repo })).body.events;
    const row2 = hist2.find((e: any) => e.kind === "merged" && e.pr === 2651 && e.merge_sha === "f".repeat(40));
    expect(row2).toBeTruthy();
    expect("batch_members" in row2.detail).toBe(false);
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-batch" });
  });

  it("a merge-tree conflict parks the head card TYPED conflicting (BR#6348) — queue-visible on a bounded budget, the follower queues behind", async () => {
    const repo = "state-vector/lane-bounce";
    const c1 = await queueViaAccept({ repo, pr: 2601, head: "b".repeat(40), title: "IMPL: bounce drill head" });
    const c2 = await queueViaAccept({ repo, pr: 2602, head: "d".repeat(40), title: "IMPL: bounce drill follower" });
    // FIFO — the head card first
    expect((await laneSnap(repo)).queue.map((x: any) => x.id)).toEqual([c1, c2]);

    await acquire(repo, "gw-b", { required_workflows: ["Test"] });
    const merged = await kbJson("/train.event", {
      repo, base: "main", kind: "merged", actor: "gw-b",
      pr: 2601, merge_sha: "7".repeat(40), head_sha: "b".repeat(40), task_id: c1,
    });
    expect(merged.body.error ?? "").toBe("");

    // the executor's trial rebase hit conflicts → the car parks TYPED
    // conflicting (BR#6348), NOT an impl bounce into pool churn — queue
    // visibility is the invariant the Phase A defect broke (3h46m silent
    // empty queue while a conflicting car churned invisible)
    const bounced = await kbJson("/train.event", {
      repo, base: "main", kind: "bounced", actor: "gw-b", pr: 2601, head_sha: "b".repeat(40),
      bounce_kind: "conflict", merge_state_status: "dirty",
      conflict_files: ["packages/worker/src/kb/do.ts", "packages/contracts/src/mcp.ts"],
    });
    expect(bounced.body.error ?? "", `train:bounced failed: ${JSON.stringify(bounced.body)}`).toBe("");
    expect(bounced.body.task).toBe(c1);
    expect(bounced.body.bounce_kind).toBe("conflict");
    expect(bounced.body.conflicting_park).toBe(true);

    const card1 = (await kbJson("/get", { id: c1 })).body;
    expect(card1.status).toBe("blocked");
    expect(card1.meta?.merge_train?.state).toBe("conflicting");
    expect(card1.meta?.merge_train?.bounce_kind).toBe("conflict");
    expect(card1.meta?.merge_train?.conflicting_at).toBeGreaterThan(0);
    expect(card1.meta?.merge_train?.conflict_files).toEqual(["packages/worker/src/kb/do.ts", "packages/contracts/src/mcp.ts"]);
    // the park reason IS the plain-reading brief: enumerated conflicts + the
    // demanded machine leg (the mechanical rebase owns the exit)
    expect(String(card1.meta?.blocked?.reason ?? "")).toMatch(/^merge-train: conflicting — PR state-vector\/lane-bounce#2601 conflicts with base \(2 file\(s\)\): /);
    expect(String(card1.meta?.blocked?.reason ?? "")).toContain("packages/worker/src/kb/do.ts");
    expect(String(card1.meta?.blocked?.reason ?? "")).toContain("packages/contracts/src/mcp.ts");
    expect(String(card1.meta?.blocked?.reason ?? "")).toContain("force-with-lease");
    expect(String(card1.meta?.blocked?.reason ?? "")).toContain("BR#6348");
    // the version log names the park — the machine action is on the record
    const bounceHist = (await kbJson("/get_history", { id: c1, limit: 5 })).body;
    expect(JSON.stringify(bounceHist)).toContain("parked TYPED conflicting (BR#6348)");

    // the lane freed (the bounced card WAS the in-flight merge) but the car
    // STAYS IN the derived queue — visible on its bounded budget, the
    // follower queues behind it (never a silently empty queue again)
    const after = await laneSnap(repo);
    expect(after.currently).toBeNull();
    expect(after.queue.map((x: any) => x.id)).toEqual([c1, c2]);
  });

  it("a PLAIN coverage lapse (head moved past the verdict, no human leg, BR#5226) bounces to the VERIFY POOL — coverage brief, NO Awaiting park, NO conflict language, ZERO duty spam", async () => {
    const repo = "state-vector/lane-coverage";
    const H = "e".repeat(40), H2 = "d".repeat(40);
    const c1 = await queueViaAccept({ repo, pr: 2611, head: H, title: "IMPL: coverage bounce drill" });
    await acquire(repo, "gw-c", { required_workflows: ["Test"] });
    // an authored push moved the head past the stamp: no conflicts exist, no
    // human leg — the machine verdict lapses and the verify pool re-verifies
    const bounced = await kbJson("/train.event", {
      repo, base: "main", kind: "bounced", actor: "gw-c", pr: 2611, head_sha: H2, task_id: c1,
      bounce_kind: "coverage", merge_state_status: "clean",
      reason: `PR #2611 live head ${H2} is not covered by the accepted verdict (leg 1 stamped ${H.slice(0, 9)}, no contiguous carry chain) — head moved past the verdict without a machine-clean update; re-verify at the new head`,
    });
    expect(bounced.body.error ?? "", `coverage bounce failed: ${JSON.stringify(bounced.body)}`).toBe("");
    expect(bounced.body.bounce_kind).toBe("coverage");
    // BR#5226: a plain lapse is NOT an Awaiting park and NOT a machine
    // re-queue — the impl-bounce flow hands the card to the verify pool
    expect(bounced.body.awaiting_park).toBeUndefined();
    expect(bounced.body.machine_requeue).toBeUndefined();
    const card1 = (await kbJson("/get", { id: c1 })).body;
    expect(card1.status).toBe("in_progress");
    expect(card1.meta?.merge_train?.state).toBe("bounced");
    expect(card1.meta?.merge_train?.bounce_kind).toBe("coverage");
    expect(card1.meta?.merge_train?.awaiting).toBeUndefined();
    expect(String(card1.meta?.blocked?.reason ?? "")).not.toMatch(/^Awaiting review/);
    // the coverage brief rides the card — the verify pool owns the re-verify
    expect(String(card1.body_md ?? "")).toContain("Merge-train bounce (coverage)");
    expect(String(card1.body_md ?? "")).toContain("**Next owner: the verify pool**");
    // the lie that sent impl hunting for nonexistent conflicts stays gone —
    // a lapsed verdict is not a conflict
    expect(String(card1.body_md ?? "")).not.toContain("conflicts with its base");
    expect(String(card1.body_md ?? "")).not.toContain("Conflicting files");
    expect(String(card1.body_md ?? "")).not.toContain("no file list supplied");
    // zero re-verify duty spam — the old self-heal spawned one per bounce;
    // the fresh verify spawns only on the repair leg's in_review handoff
    expect(((await kbJson("/list", { type: "task", limit: 200 })).body?.artefacts ?? [])
      .filter((a: any) => a.title === "Verify: IMPL: coverage bounce drill" && ["todo", "in_progress", "blocked"].includes(a.status))).toHaveLength(0);
    // zero asks (BR#4960): the bounce files nothing
    expect(((await kbJson("/artefacts?type=question&limit=200")).body?.artefacts ?? []).filter((a: any) => String(a.title).includes(`(${c1})`))).toHaveLength(0);
    // the bounce note names the kind — not a generic "conflicts with base"
    const hist = JSON.stringify(await (await kbJson("/get_history", { id: c1, limit: 8 })).body);
    expect(hist).toContain("merge-train bounce (coverage) — PR #2611 head moved past the accepted verdict");
    expect(hist).not.toContain("parked Awaiting review");
  });

  it("a GATE bounce (mechanical defect, BR#4066) renders the named defect + mergeStateStatus — impl owns the fix, no conflict language", async () => {
    const repo = "state-vector/lane-gate";
    const c1 = await queueViaAccept({ repo, pr: 2621, head: "f".repeat(40), title: "IMPL: gate bounce drill" });
    await acquire(repo, "gw-g", { required_workflows: ["Test"] });
    const defect = "PR #2621 head check RED: Test. Fix or bounce to impl";
    const bounced = await kbJson("/train.event", {
      repo, base: "main", kind: "bounced", actor: "gw-g", pr: 2621, head_sha: "f".repeat(40), task_id: c1,
      bounce_kind: "gate", merge_state_status: "blocked", reason: defect,
    });
    expect(bounced.body.error ?? "", `gate bounce failed: ${JSON.stringify(bounced.body)}`).toBe("");
    expect(bounced.body.bounce_kind).toBe("gate");
    const card1 = (await kbJson("/get", { id: c1 })).body;
    expect(card1.status).toBe("in_progress");
    const brief = String(card1.body_md);
    expect(brief).toContain("Merge-train bounce (gate): PR #2621");
    expect(brief).toContain("mergeStateStatus=BLOCKED");
    expect(brief).toContain(`**Defect:** ${defect}`);
    expect(brief).toContain("**Next owner: impl**");
    expect(brief).not.toContain("conflicts with its base");
    expect(brief).not.toContain("Conflicting files");
  });

  it("a conflict bounce WITHOUT the file list FAILS LOUD (BR#4066) — no brief, no transition, the lie cannot render", async () => {
    const repo = "state-vector/lane-nofiles";
    const c1 = await queueViaAccept({ repo, pr: 2631, head: "a".repeat(40), title: "IMPL: fileless conflict drill" });
    await acquire(repo, "gw-n", { required_workflows: ["Test"] });
    const bounced = await kbJson("/train.event", {
      repo, base: "main", kind: "bounced", actor: "gw-n", pr: 2631, head_sha: "a".repeat(40), task_id: c1,
      bounce_kind: "conflict", merge_state_status: "dirty",
      // NO conflict_files — the executor omitted the trial-merge enumeration
    });
    expect(bounced.body.error ?? "", "a file-less conflict bounce must fail loud").toContain("without conflict_files");
    // the card was NOT bounced: still queued/blocked, no brief appended
    const card1 = (await kbJson("/get", { id: c1 })).body;
    expect(card1.status).toBe("blocked");
    expect(String(card1.body_md)).not.toContain("Merge-train bounce");
    // and a garbage kind is rejected too
    const garbage = await kbJson("/train.event", {
      repo, base: "main", kind: "bounced", actor: "gw-n", pr: 2631, head_sha: "a".repeat(40),
      bounce_kind: "rebase-needed",
    });
    expect(garbage.body.error ?? "").toContain("bounce_kind must be coverage | conflict | gate");
    expect((await kbJson("/get", { id: c1 })).body.status).toBe("blocked");
  });

  it("a verify close with no `head <sha>` stamp does NOT queue — the card is stamped unbound, fail-closed", async () => {
    const repo = "state-vector/lane-unbound";
    const card = await queueViaAccept({ repo, pr: 2603, head: null, title: "IMPL: unbound drill" });
    const c = (await kbJson("/get", { id: card })).body;
    expect(c.meta?.merge_train?.state).toBe("unbound");
    // no head stamp ⇒ no head_sha_at_acceptance ⇒ the train's gate could
    // never pass — the card was NOT queued (still in its pre-hook status)
    expect(c.meta?.pr?.head_sha_at_acceptance).toBeUndefined();
    expect(c.status).not.toBe("blocked");
    // and no lane was even created for this repo — nothing was leased
    expect((await kbJson("/train.status", { repo })).body.lanes.length).toBe(0);
  });

  it("BR#3659 defect 1: a two-leg card closes only when the LAST leg lands — after leg 1 it stays queued naming the leg still out", async () => {
    const repo = "state-vector/lane-legs";
    const H1 = "1".repeat(40), H2 = "2".repeat(40), M1 = "3".repeat(40), M2 = "4".repeat(40);
    // the close cites BOTH PRs, one `head <sha>` after each (the multi-PR
    // convention — proximity-paired by the hub parser)
    const impl = await kbJson("/create", { type: "task", title: "IMPL: two-leg drill", session: "" });
    const implId = String(impl.body.id);
    const verify = await kbJson("/create", { type: "task", title: `VERIFY: two-leg ${implId}`, roles: ["review"], session: "bridge-task-BR-drill-verify" });
    const verifyId = String(verify.body.id);
    await kbJson("/link", { src: verifyId, relation: "child_of", dst: implId });
    await kbJson("/transition", { id: verifyId, to: "in_progress", actor: "drill-verifier", note: "verifying" });
    const closed = await kbJson("/transition", {
      id: verifyId, to: "done", actor: "drill-verifier",
      note: `accepted both legs — PR https://github.com/${repo}/pull/2701 head ${H1}; PR https://github.com/${repo}/pull/2702 head ${H2}`,
    });
    expect(closed.status, `verify close failed: ${JSON.stringify(closed.body)}`).toBeLessThan(400);
    let c = (await kbJson("/get", { id: implId })).body;
    // BOTH legs stamped; meta.pr stays the FIRST leg (legacy readers)
    expect(c.status).toBe("blocked");
    expect(c.meta?.merge_train?.state).toBe("queued");
    expect(c.meta?.merge_train?.legs_total).toBe(2);
    expect(c.meta?.prs?.map((l: any) => l.number)).toEqual([2701, 2702]);
    expect(c.meta?.prs?.map((l: any) => l.head_sha_at_acceptance)).toEqual([H1, H2]);
    expect(c.meta?.pr?.number).toBe(2701);

    await acquire(repo, "gw-legs", { required_workflows: ["Test"] });
    // leg 1 merges → awaiting-CI → green ⇒ landed, but the CARD stays queued
    const m1 = await kbJson("/train.event", { repo, base: "main", kind: "merged", actor: "gw-legs", pr: 2701, merge_sha: M1, head_sha: H1, task_id: implId });
    expect(m1.body.error ?? "", `train:merged leg 1 failed: ${JSON.stringify(m1.body)}`).toBe("");
    const landed1 = await kbJson("/train.ci", { repo, base: "main", actor: "gw-legs", sha: M1, checks: [check(31, "Test", "success")] });
    expect(landed1.body.decided).toBe("landed");
    expect(landed1.body.remaining).toEqual([2702]);
    c = (await kbJson("/get", { id: implId })).body;
    // NOT closed after leg 1 (the pre-3659 hub false-closed here — defect 1)
    expect(c.status).toBe("blocked");
    expect(c.meta?.merge_train?.legs?.["2701"]?.state).toBe("landed");
    // leg 2 has no map entry yet — it has not even merged (its awaiting-ci
    // stamp only arrives with train:merged)
    expect(c.meta?.merge_train?.legs?.["2702"]).toBeUndefined();
    expect(c.meta?.merge_train?.remaining).toBe(1);
    // the blocked reason honestly names the leg still out
    expect(String(c.meta?.blocked?.reason)).toContain("2702");
    // the lane went IDLE (currently cleared) — the train can pick leg 2 next tick
    expect((await laneSnap(repo)).currently).toBeNull();

    // leg 2 merges → green ⇒ the LAST leg lands → the card finally closes,
    // citing EVERY leg's merge commit (never a leg-1-only lie)
    const m2 = await kbJson("/train.event", { repo, base: "main", kind: "merged", actor: "gw-legs", pr: 2702, merge_sha: M2, head_sha: H2, task_id: implId });
    expect(m2.body.error ?? "", `train:merged leg 2 failed: ${JSON.stringify(m2.body)}`).toBe("");
    const landed2 = await kbJson("/train.ci", { repo, base: "main", actor: "gw-legs", sha: M2, checks: [check(32, "Test", "success")] });
    expect(landed2.body.decided).toBe("landed");
    c = (await kbJson("/get", { id: implId })).body;
    expect(c.status).toBe("done");
    expect(c.meta?.merge_train?.state).toBe("landed");
    expect(c.meta?.merge_train?.legs?.["2701"]?.state).toBe("landed");
    expect(c.meta?.merge_train?.legs?.["2702"]?.state).toBe("landed");
    const h = JSON.stringify(await (await kbJson("/get_history", { id: implId, limit: 10 })).body);
    expect(h).toContain("all 2 queued PRs merged");
    expect(h).toContain("#2701");
    expect(h).toContain("#2702");
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-legs" });
  });

  it("BR#3659 defect 2: a verify close on a BOUNCED card (in_progress) does NOT re-queue it — the bounce stands", async () => {
    const repo = "state-vector/lane-bounceguard";
    const impl = await kbJson("/create", { type: "task", title: "IMPL: bounce-guard drill", session: "" });
    const implId = String(impl.body.id);
    // bounced: in_progress (the state train:bounced lands the card in) —
    // session: "" = anonymous, so the gateway-action never attributes the
    // impl card to the verify session (review-separation would refuse the close)
    await kbJson("/transition", { id: implId, to: "in_progress", actor: "drill", session: "", note: "merge-train bounce — PR #2801 conflicts with base" });
    const verify = await kbJson("/create", { type: "task", title: `VERIFY: bounce-guard ${implId}`, roles: ["review"], session: "bridge-task-BR-drill-verify" });
    const verifyId = String(verify.body.id);
    await kbJson("/link", { src: verifyId, relation: "child_of", dst: implId });
    await kbJson("/transition", { id: verifyId, to: "in_progress", actor: "drill-verifier", note: "verifying" });
    // the verifier closes done citing the PR + head receipts — the pre-3659
    // hub re-queued the bounced parent on exactly this close (defect 2)
    const closed = await kbJson("/transition", { id: verifyId, to: "done", actor: "drill-verifier", note: `bounced PR https://github.com/${repo}/pull/2801 head ${"e".repeat(40)} — findings filed on the parent` });
    expect(closed.status).toBeLessThan(400);
    const c = (await kbJson("/get", { id: implId })).body;
    // the bounce SURVIVED: no hijack to blocked merge-train: queued
    expect(c.status).toBe("in_progress");
    expect(c.meta?.merge_train?.state).toBeUndefined();
    expect(c.meta?.pr).toBeUndefined();
    // and no lane was created — nothing was queued
    expect((await kbJson("/train.status", { repo })).body.lanes.length).toBe(0);
  });

  it("BR#3659: a multi-PR close with a missing head does NOT queue — every cited PR needs its head", async () => {
    const repo = "state-vector/lane-partial";
    const impl = await kbJson("/create", { type: "task", title: "IMPL: partial-bind drill", session: "" });
    const implId = String(impl.body.id);
    const verify = await kbJson("/create", { type: "task", title: `VERIFY: partial-bind ${implId}`, roles: ["review"], session: "bridge-task-BR-drill-verify" });
    const verifyId = String(verify.body.id);
    await kbJson("/link", { src: verifyId, relation: "child_of", dst: implId });
    await kbJson("/transition", { id: verifyId, to: "in_progress", actor: "drill-verifier", note: "verifying" });
    // PR 2902 cited without a head — the gate could never pass that leg
    await kbJson("/transition", { id: verifyId, to: "done", actor: "drill-verifier", note: `PR https://github.com/${repo}/pull/2901 head ${"f".repeat(40)}; PR https://github.com/${repo}/pull/2902` });
    const c = (await kbJson("/get", { id: implId })).body;
    expect(c.meta?.merge_train?.state).toBe("unbound");
    expect(c.meta?.merge_train?.unbound).toEqual([2902]);
    expect(c.status).not.toBe("blocked");
    expect((await kbJson("/train.status", { repo })).body.lanes.length).toBe(0);
  });

  it("BR#3659: a re-verify close folds onto the existing legs — the cited leg's head refreshes, the others survive", async () => {
    const repo = "state-vector/lane-refold";
    const H1 = "1".repeat(40), H2 = "2".repeat(40), H1b = "3".repeat(40);
    const impl = await kbJson("/create", { type: "task", title: "IMPL: refold drill", session: "" });
    const implId = String(impl.body.id);
    const verify = await kbJson("/create", { type: "task", title: `VERIFY: refold ${implId}`, roles: ["review"], session: "bridge-task-BR-drill-verify" });
    const verifyId = String(verify.body.id);
    await kbJson("/link", { src: verifyId, relation: "child_of", dst: implId });
    await kbJson("/transition", { id: verifyId, to: "in_progress", actor: "drill-verifier", note: "verifying" });
    await kbJson("/transition", { id: verifyId, to: "done", actor: "drill-verifier", note: `PR https://github.com/${repo}/pull/3001 head ${H1}; PR https://github.com/${repo}/pull/3002 head ${H2}` });
    let c = (await kbJson("/get", { id: implId })).body;
    expect(c.meta?.prs?.length).toBe(2);
    // bounce → fix → re-enter review → a FRESH verify duty accepts the new head
    // (impl-side actions are anonymous — never the verify session; the hub's
    // own queue/landed transitions are anonymous too, so meta.session stays
    // unset and the re-verify cannot be refused as self-review)
    await kbJson("/transition", { id: implId, to: "in_progress", actor: "drill", session: "", note: "merge-train bounce — conflict resolved" });
    await kbJson("/transition", { id: implId, to: "in_review", actor: "drill", session: "", note: `re-entered review — PR https://github.com/${repo}/pull/3001` });
    const verify2 = await kbJson("/create", { type: "task", title: `VERIFY: refold 2 ${implId}`, roles: ["review"], session: "bridge-task-BR-drill-verify" });
    const verify2Id = String(verify2.body.id);
    await kbJson("/link", { src: verify2Id, relation: "child_of", dst: implId });
    await kbJson("/transition", { id: verify2Id, to: "in_progress", actor: "drill-verifier", note: "re-verifying at the new head" });
    const closed2 = await kbJson("/transition", { id: verify2Id, to: "done", actor: "drill-verifier", note: `re-verified PR https://github.com/${repo}/pull/3001 head ${H1b}` });
    expect(closed2.status, `re-verify close failed: ${JSON.stringify(closed2.body)}`).toBeLessThan(400);
    c = (await kbJson("/get", { id: implId })).body;
    // leg 1's head refreshed; leg 2's stamp SURVIVED — the card still has both legs
    expect(c.status).toBe("blocked");
    expect(c.meta?.prs).toEqual([
      { repo, number: 3001, head_sha_at_acceptance: H1b },
      { repo, number: 3002, head_sha_at_acceptance: H2 },
    ]);
    expect(c.meta?.merge_train?.legs_total).toBe(2);
  });

  it("BR#4648: a re-verify accept citing the PR as `repo#N` shorthand still REFRESHES the stamp — the coverage-bounce spin class is dead", async () => {
    const repo = "state-vector/lane-shorthand";
    const H1 = "1".repeat(40), H2 = "2".repeat(40);
    // first accept cites the full URL; the stamp lands at H1
    const impl = await kbJson("/create", { type: "task", title: "IMPL: shorthand drill", session: "" });
    const implId = String(impl.body.id);
    const verify = await kbJson("/create", { type: "task", title: `VERIFY: shorthand ${implId}`, roles: ["review"], session: "bridge-task-BR-drill-verify" });
    const verifyId = String(verify.body.id);
    await kbJson("/link", { src: verifyId, relation: "child_of", dst: implId });
    await kbJson("/transition", { id: verifyId, to: "in_progress", actor: "drill-verifier", note: "verifying" });
    await kbJson("/transition", { id: verifyId, to: "done", actor: "drill-verifier", note: `verified — PR https://github.com/${repo}/pull/3100 head ${H1}` });
    let c = (await kbJson("/get", { id: implId })).body;
    expect(c.meta?.pr?.head_sha_at_acceptance).toBe(H1);
    // bounce → impl re-enters review → a FRESH verify duty accepts the NEW head,
    // citing the PR the way the board's own bounce notes do (`repo#N` — no /pull/
    // URL). Pre-4648 the parser read no legs here, the stamp stayed at H1, and
    // the train coverage-bounced the unchanged verdict every cycle (BR#3764 ×5).
    await kbJson("/transition", { id: implId, to: "in_progress", actor: "drill", session: "", note: "merge-train bounce — resolved" });
    await kbJson("/transition", { id: implId, to: "in_review", actor: "drill", session: "", note: `re-entered review — PR https://github.com/${repo}/pull/3100` });
    const verify2 = await kbJson("/create", { type: "task", title: `VERIFY: shorthand 2 ${implId}`, roles: ["review"], session: "bridge-task-BR-drill-verify" });
    const verify2Id = String(verify2.body.id);
    await kbJson("/link", { src: verify2Id, relation: "child_of", dst: implId });
    await kbJson("/transition", { id: verify2Id, to: "in_progress", actor: "drill-verifier", note: "re-verifying at the new head" });
    // the production order: the verifier parks the parent BEFORE closing the duty
    // (session: "" — never stamp the drill verifier onto the impl card, or the
    // second duty's close is refused as self-review)
    await kbJson("/transition", { id: implId, to: "blocked", actor: "drill-verifier", session: "", note: `merge-train: queued — verify verdict ACCEPT (drill), single typed leg, head ${H2}`, await_event: { event: "pr_merged", repo, n: 3100 } });
    const closed2 = await kbJson("/transition", { id: verify2Id, to: "done", actor: "drill-verifier", note: `re-verified — PR ${repo}#3100, head ${H2}` });
    expect(closed2.status, `re-verify close failed: ${JSON.stringify(closed2.body)}`).toBeLessThan(400);
    c = (await kbJson("/get", { id: implId })).body;
    expect(c.status).toBe("blocked");
    expect(c.meta?.pr).toMatchObject({ repo, number: 3100, head_sha_at_acceptance: H2 });
    expect(c.meta?.prs?.[0]).toMatchObject({ repo, number: 3100, head_sha_at_acceptance: H2 });
  });

  it("BR#4648: a head-bearing close with NO PR reference refreshes a single-leg stamp — and the re-queue note only claims 'stamp refreshed' when a stamp moved", async () => {
    const repo = "state-vector/lone-head";
    const H1 = "1".repeat(40), H2 = "2".repeat(40);
    const impl = await kbJson("/create", { type: "task", title: "IMPL: lone-head drill", session: "" });
    const implId = String(impl.body.id);
    const verify = await kbJson("/create", { type: "task", title: `VERIFY: lone-head ${implId}`, roles: ["review"], session: "bridge-task-BR-drill-verify" });
    const verifyId = String(verify.body.id);
    await kbJson("/link", { src: verifyId, relation: "child_of", dst: implId });
    await kbJson("/transition", { id: verifyId, to: "in_progress", actor: "drill-verifier", note: "verifying" });
    await kbJson("/transition", { id: verifyId, to: "done", actor: "drill-verifier", note: `verified — PR https://github.com/${repo}/pull/3200 head ${H1}` });
    // bounce → re-enter → fresh duty cites bare receipts (no URL, no shorthand),
    // head token only — the card's one open leg takes it
    await kbJson("/transition", { id: implId, to: "in_progress", actor: "drill", session: "", note: "merge-train bounce — resolved" });
    await kbJson("/transition", { id: implId, to: "in_review", actor: "drill", session: "", note: `re-entered review — PR https://github.com/${repo}/pull/3200` });
    const verify2 = await kbJson("/create", { type: "task", title: `VERIFY: lone-head 2 ${implId}`, roles: ["review"], session: "bridge-task-BR-drill-verify" });
    const verify2Id = String(verify2.body.id);
    await kbJson("/link", { src: verify2Id, relation: "child_of", dst: implId });
    await kbJson("/transition", { id: verify2Id, to: "in_progress", actor: "drill-verifier", note: "re-verifying" });
    // production order: park first (head in the park note too — it is the CLOSE
    // note the hook parses, which is exactly the BR#4648 lesson)
    await kbJson("/transition", { id: implId, to: "blocked", actor: "drill-verifier", session: "", note: `merge-train: queued — verify verdict ACCEPT (drill), single typed leg, head ${H2}`, await_event: { event: "pr_merged", repo, n: 3200 } });
    const closed2 = await kbJson("/transition", { id: verify2Id, to: "done", actor: "drill-verifier", note: `receipts first-hand this session, live gh+git; every check passed; head ${H2}` });
    expect(closed2.status, `re-verify close failed: ${JSON.stringify(closed2.body)}`).toBeLessThan(400);
    let c = (await kbJson("/get", { id: implId })).body;
    expect(c.status).toBe("blocked");
    expect(c.meta?.pr?.head_sha_at_acceptance).toBe(H2);
    // the re-queue note is honest: this cycle moved a stamp, so it says so.
    // BR#5751: the DIRECT PARK is itself a queue event now — its note carried
    // the live head, so the park moved the stamp and claims the refresh; the
    // duty close re-queues idempotently on the already-covered head and must
    // NOT claim a refresh.
    const hist = await kbJson(`/history?id=${encodeURIComponent(implId)}&limit=20`);
    const queuedNotes = (hist.body.versions as any[]).filter((v) => v.action === "train_queued").map((v) => String(v.summary));
    expect(queuedNotes.length).toBe(3);
    expect(queuedNotes[1]).toContain("(re-queued, stamp refreshed)");
    expect(queuedNotes[0]).toContain("(re-queued)");
    expect(queuedNotes[0]).not.toContain("stamp refreshed");
    // and a no-op re-accept at the SAME head must not claim a refresh
    await kbJson("/transition", { id: implId, to: "in_progress", actor: "drill", session: "", note: "gate bounce — nothing to fix" });
    await kbJson("/transition", { id: implId, to: "in_review", actor: "drill", session: "", note: `re-entered review — PR https://github.com/${repo}/pull/3200` });
    const verify3 = await kbJson("/create", { type: "task", title: `VERIFY: lone-head 3 ${implId}`, roles: ["review"], session: "bridge-task-BR-drill-verify" });
    const verify3Id = String(verify3.body.id);
    await kbJson("/link", { src: verify3Id, relation: "child_of", dst: implId });
    await kbJson("/transition", { id: verify3Id, to: "in_progress", actor: "drill-verifier", note: "re-verifying at the same head" });
    await kbJson("/transition", { id: implId, to: "blocked", actor: "drill-verifier", session: "", note: `merge-train: queued — verify verdict ACCEPT cycle 2 (drill), head ${H2}`, await_event: { event: "pr_merged", repo, n: 3200 } });
    const closed3 = await kbJson("/transition", { id: verify3Id, to: "done", actor: "drill-verifier", note: `re-verified at the unchanged head ${H2} — all checks passed` });
    expect(closed3.status, `re-verify close failed: ${JSON.stringify(closed3.body)}`).toBeLessThan(400);
    c = (await kbJson("/get", { id: implId })).body;
    expect(c.meta?.pr?.head_sha_at_acceptance).toBe(H2);
    const hist2 = await kbJson(`/history?id=${encodeURIComponent(implId)}&limit=20`);
    const lastQueued = (hist2.body.versions as any[]).find((v) => v.action === "train_queued");
    expect(String(lastQueued.summary)).toContain("queued on the merge train");
    expect(String(lastQueued.summary)).not.toContain("stamp refreshed");
  });

  it("BR#4129 zombie eviction: a renewal with a frozen progress note on a non-empty queue is denied and EXPIRES — the next gateway's acquire takes over within a tick; legacy `{}` renewals still pass", async () => {
    const repo = "state-vector/lane-zombie";
    // a verify-accepted card queues — the lane's derived queue is non-empty
    const cardId = await queueViaAccept({ repo, pr: 3101, head: "a".repeat(40), title: "IMPL: zombie eviction drill" });
    expect((await laneSnap(repo)).queue.map((x: any) => x.id)).toContain(cardId);

    // the zombie acquires, then renews carrying its FROZEN action note (hours old)
    const a = await acquire(repo, "gw-zombie");
    expect(a.body.error ?? "").toBe("");
    const denied = await kbJson("/train.lease", {
      repo, base: "main", action: "renew", actor: "gw-zombie",
      progress: { progress: "merged PR #3100", progress_age_ms: 3 * 60 * 60_000, holder: "gw-zombie" },
    });
    expect(denied.status).toBe(400);
    expect(String(denied.body.error)).toContain("zombie holder");
    expect(String(denied.body.error)).toContain("no progress for 180m");
    expect(String(denied.body.error)).toContain("non-empty queue (1 queued)");

    // the lease EXPIRED on denial and the lane card says why (board visibility)
    const snap = await laneSnap(repo);
    expect(snap.lease).toBeNull();
    expect(String(snap.reason)).toContain("zombie holder evicted");
    expect(String(snap.reason)).toContain("gw-zombie");
    // the eviction is on the lane's audit trail (the handover receipt)
    const hist = await kbJson(`/history?id=${encodeURIComponent(snap.card)}`);
    const notes = JSON.stringify(hist.body ?? {});
    expect(notes).toContain("train:lease_evicted");

    // takeover: the next gateway's acquire WINS the now-free lane
    const takeover = await acquire(repo, "gw-2");
    expect(takeover.body.error ?? "").toBe("");
    expect(takeover.body.lease.holder).toBe("gw-2");

    // a FRESH proof renews fine on the non-empty queue (awaiting-CI law —
    // the CI-poll note refreshes every tick, it never trips)
    const fresh = await kbJson("/train.lease", {
      repo, base: "main", action: "renew", actor: "gw-2",
      progress: { progress: "CI poll on abc123def: pending", progress_age_ms: 45_000, holder: "gw-2" },
    });
    expect(fresh.body.error ?? "").toBe("");
    // a legacy `{}` renewal (no proof) is UNKNOWN — allowed on the non-empty
    // queue while the deprecation window runs (BR#4104 retires the senders)
    const legacy = await kbJson("/train.lease", { repo, base: "main", action: "renew", actor: "gw-2", progress: {} });
    expect(legacy.body.error ?? "").toBe("");

    // empty queue ⇒ even a frozen note renews — idle holding is harmless
    const idleRepo = "state-vector/lane-zombie-idle";
    expect((await acquire(idleRepo, "gw-idle")).body.error ?? "").toBe("");
    const idleRenew = await kbJson("/train.lease", {
      repo: idleRepo, base: "main", action: "renew", actor: "gw-idle",
      progress: { progress: "merged PR #1", progress_age_ms: 3 * 60 * 60_000, holder: "gw-idle" },
    });
    expect(idleRenew.body.error ?? "").toBe("");
  });

  /** The open review-leg asks bound to a card (BR#4068 stamped them
   *  review_leg on meta.ask). KEPT FOR ZERO-ASK PINS: since BR#4962 (per
   *  accepted BR#4960) no train lane ever files one — the parked card IS
   *  the human leg. */
  async function reviewAsks(card: string): Promise<any[]> {
    const { body } = await kbJson("/artefacts?type=question&limit=200");
    return ((body.artefacts ?? []) as any[]).filter(
      (a) => a.meta?.ask?.review_leg === true && String(a.title).includes(`(${card})`),
    );
  }

  /** Every question row (asks + lane-day digests) — the zero-visibility-
   *  noise pins read this: a BR#4960 lane must file NONE of them. */
  async function allQuestions(): Promise<any[]> {
    return ((await kbJson("/artefacts?type=question&limit=200")).body.artefacts ?? []) as any[];
  }

  it("BR#4962 (per BR#4960), BR#5226: a HUMAN-LEG coverage bounce (human-resolved conflict files invalidate the verdict) parks the card Awaiting IN PLACE — typed reason + boost, the typed pr_merged leg survives, ZERO asks, the lane panel lists the park", async () => {
    const repo = "state-vector/lane-await-park";
    const HEAD = "b".repeat(40), H2 = "c".repeat(40);
    const card = await queueViaAccept({ repo, pr: 3101, head: HEAD, title: "IMPL: awaiting-park drill" });
    await acquire(repo, "gw-park", { required_workflows: ["Test"] });
    // the typed machine leg production stamps on the park (the verify session
    // passes await_event pr_merged on the queue transition) — the park must
    // carry it through its in-place meta write
    const c0 = (await kbJson("/get", { id: card })).body;
    await kbJson("/update", { id: card, meta: { ...c0.meta, blocked: { ...(c0.meta.blocked ?? {}), await_event: { event: "pr_merged", repo, n: 3101 } } } });

    // the head moved AND the resolution was human-authored (conflict files
    // ride the event): the verdict is INVALID at the new head — a genuine
    // human leg, the card parks blocked under the typed reason
    const bounced = await kbJson("/train.event", {
      repo, base: "main", kind: "bounced", actor: "gw-park", pr: 3101, task_id: card,
      head_sha: H2, bounce_kind: "coverage", merge_state_status: "behind",
      reason: "PR #3101 head moved past the accepted verdict",
      conflict_files: ["src/train/legs.ts"],
    });
    expect(bounced.body.error ?? "", `train:bounced failed: ${JSON.stringify(bounced.body)}`).toBe("");
    expect(bounced.body.awaiting_park).toBe(true);

    // refresh IN PLACE (blocked→blocked is an illegal edge — no transition):
    // still blocked, merge_train.state awaiting, the stamp names the verdict
    // + parked head, the BR#4068 boost intact
    const c = (await kbJson("/get", { id: card })).body;
    expect(c.status).toBe("blocked");
    expect(c.meta?.merge_train?.state).toBe("awaiting");
    expect(c.meta?.merge_train?.bounce_kind).toBe("coverage");
    expect(c.meta?.merge_train?.awaiting?.head_sha).toBe(H2);
    const verdictId = String(c.meta?.merge_train?.awaiting?.verdict_id ?? "");
    expect(verdictId).toMatch(/^BR#\d+$/);
    expect(c.meta?.boosted).toBeGreaterThan(0);
    // the typed park reason — verdict + anchored head inline, plain-readable
    expect(String(c.meta?.blocked?.reason)).toMatch(/^Awaiting review \(verdict BR#\d+, anchored at head [0-9a-f]{9}\)$/);
    // the typed pr_merged await_event SURVIVES the park (the proxy still owns
    // a legal exit if the PR merges while parked)
    expect(c.meta?.blocked?.await_event).toEqual({ event: "pr_merged", repo, n: 3101 });

    // ZERO asks, ZERO digests (BR#4960): the parked card IS the visibility
    expect((await reviewAsks(card)).length).toBe(0);
    const qs = await allQuestions();
    expect(qs.filter((a: any) => String(a.title).includes("Review requested")).length).toBe(0);
    expect(qs.filter((a: any) => String(a.title).startsWith("Merge-train digest")).length).toBe(0);

    // the park is loud on the audit chain: version message + train_events
    const h = JSON.stringify(await (await kbJson("/get_history", { id: card, limit: 10 })).body);
    expect(h).toContain("parked Awaiting review");
    expect(h).toContain("needs a human leg");
    const th = await kbJson("/train.history", { repo, base: "main", kind: "bounced", pr: 3101 });
    const parkEv = (th.body.events ?? []).find((e: any) => String(e.task_id ?? "") === card);
    expect(parkEv).toBeTruthy();
    expect(parkEv.detail.awaiting_park).toBe(true);

    // the lane panel lists the PARK (not an ask band): task, pr, verdict, age
    const lane = await laneSnap(repo);
    expect((lane.awaiting ?? []).length).toBe(1);
    expect(lane.awaiting[0].task).toBe(card);
    expect(lane.awaiting[0].pr).toBe(3101);
    expect(lane.awaiting[0].verdict).toBe(verdictId);
    expect(lane.awaiting[0].aging).toBe(false);
    expect(lane.awaiting[0].lapsed).toBe(false);

    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-park" });
  });

  it("BR#5226 MACHINE PATH: a coverage bounce whose accepted verdict covers the LIVE head is a stale executor read — the card re-queues IN PLACE (queued reason, no awaiting, stamps intact), zero human", async () => {
    const repo = "state-vector/lane-requeue";
    const H1 = "6".repeat(40), H2 = "7".repeat(40);
    const card = await queueViaAccept({ repo, pr: 3401, head: H1, title: "IMPL: machine-requeue drill" });
    await acquire(repo, "gw-rq", { required_workflows: ["Test"] });
    const c0 = (await kbJson("/get", { id: card })).body;
    await kbJson("/update", { id: card, meta: { ...c0.meta, blocked: { ...(c0.meta.blocked ?? {}), await_event: { event: "pr_merged", repo, n: 3401 } } } });

    // the executor's coverage read was stale (the parked-28 class): it
    // reports a coverage bounce at the VERY head the accepted verdict anchors
    const bounced = await kbJson("/train.event", {
      repo, base: "main", kind: "bounced", actor: "gw-rq", pr: 3401, task_id: card,
      head_sha: H1, bounce_kind: "coverage", merge_state_status: "clean",
      reason: "PR #3401 head moved past the accepted verdict",
    });
    expect(bounced.body.error ?? "", `bounce failed: ${JSON.stringify(bounced.body)}`).toBe("");
    expect(bounced.body.machine_requeue).toBe(true);
    expect(bounced.body.awaiting_park).toBeUndefined();

    // re-queued IN PLACE: still blocked, the queued reason, NO awaiting
    // stamp, no boost, the stamp + typed await_event untouched
    const c = (await kbJson("/get", { id: card })).body;
    expect(c.status).toBe("blocked");
    expect(c.meta?.merge_train?.state).toBe("queued");
    expect(c.meta?.blocked?.reason).toBe("merge-train: queued");
    expect(c.meta?.merge_train?.awaiting).toBeUndefined();
    expect(c.meta?.boosted).toBeUndefined();
    expect(c.meta?.pr?.head_sha_at_acceptance).toBe(H1);
    expect(c.meta?.blocked?.await_event).toEqual({ event: "pr_merged", repo, n: 3401 });
    // zero asks (BR#4960) and the card is back in the derived queue
    expect(((await kbJson("/artefacts?type=question&limit=200")).body?.artefacts ?? []).filter((a: any) => String(a.title).includes(`(${card})`))).toHaveLength(0);
    expect((await laneSnap(repo)).queue.map((x: any) => x.id)).toContain(card);
    // the re-queue is loud on both audit chains
    const h = JSON.stringify(await (await kbJson("/get_history", { id: card, limit: 8 })).body);
    expect(h).toContain("machine re-queue, no human leg");
    const th = await kbJson("/train.history", { repo, base: "main", kind: "bounced", pr: 3401 });
    const rq = (th.body.events ?? []).find((e: any) => String(e.task_id ?? "") === card);
    expect(rq).toBeTruthy();
    expect(rq.detail.machine_requeue).toBe(true);

    // the carry-covered variant: a machine-clean update-branch carry moves
    // the stamp H1→H2, and a coverage bounce AT the carried head is covered
    // by the contiguous chain — machine re-queue again, no park
    const carry = await kbJson("/train.carry", { repo, base: "main", pr: 3401, from_head: H1, to_head: H2, actor: "gw-rq" });
    expect(carry.body.error ?? "", `carry failed: ${JSON.stringify(carry.body)}`).toBe("");
    const bounced2 = await kbJson("/train.event", {
      repo, base: "main", kind: "bounced", actor: "gw-rq", pr: 3401, task_id: card,
      head_sha: H2, bounce_kind: "coverage", merge_state_status: "clean",
      reason: "PR #3401 head moved past the accepted verdict",
    });
    expect(bounced2.body.error ?? "").toBe("");
    expect(bounced2.body.machine_requeue).toBe(true);
    expect((await kbJson("/get", { id: card })).body.meta?.merge_train?.awaiting).toBeUndefined();

    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-rq" });
  });

  it("BR#5226 MIGRATION: the tick re-evaluation re-queues already-parked Awaiting cards whose anchored accepted verdict covers the parked head — genuine parks stay parked", async () => {
    const repo = "state-vector/lane-migrate";
    const H1 = "8".repeat(40), H2 = "9".repeat(40);
    // the legacy park of a VERDICT-COVERED card (the parked 28): queued at
    // H1, the pre-5226 code parked it Awaiting at H1 — the accepted verdict
    // anchors the very head it parked on
    const { implId: card, verifyId } = await queueViaAcceptBoth({ repo, pr: 3501, head: H1, title: "IMPL: migration drill" });
    await acquire(repo, "gw-mg", { required_workflows: ["Test"] });
    const c0 = (await kbJson("/get", { id: card })).body;
    await kbJson("/update", {
      id: card,
      meta: {
        ...c0.meta,
        merge_train: {
          ...(c0.meta.merge_train ?? {}),
          state: "awaiting",
          bounce_kind: "coverage",
          awaiting: { at: Date.now(), head_sha: H1, verdict_id: verifyId },
          pr: 3501,
          repo,
        },
        blocked: { ...(c0.meta.blocked ?? {}), reason: `Awaiting review (verdict ${verifyId}, anchored at head ${H1.slice(0, 9)})` },
      },
    });
    expect((await kbJson("/get", { id: card })).body.meta?.merge_train?.state).toBe("awaiting");

    // the tick flips it: machine re-queue, same stamps, the queued reason
    const swept = await kbJson("/admin.awaiting_requeue_sweep", {});
    expect(swept.body.error ?? "", `sweep failed: ${JSON.stringify(swept.body)}`).toBe("");
    expect(swept.body.flipped).toBeGreaterThanOrEqual(1);
    const c = (await kbJson("/get", { id: card })).body;
    expect(c.status).toBe("blocked");
    expect(c.meta?.merge_train?.state).toBe("queued");
    expect(c.meta?.blocked?.reason).toBe("merge-train: queued");
    expect(c.meta?.merge_train?.awaiting).toBeUndefined();
    expect(c.meta?.pr?.head_sha_at_acceptance).toBe(H1);
    // the flip is loud on the audit chain
    const h = JSON.stringify(await (await kbJson("/get_history", { id: card, limit: 8 })).body);
    expect(h).toContain("tick re-evaluation");
    // nothing is parked Awaiting on this lane anymore
    expect((await laneSnap(repo)).awaiting ?? []).toHaveLength(0);

    // NEGATIVE 1: a genuinely-LAPSED legacy park (stamp H1, parked at H2, no
    // carry) is NOT covered — the tick must leave it parked
    const { implId: card2, verifyId: v2 } = await queueViaAcceptBoth({ repo, pr: 3502, head: H1, title: "IMPL: migration-lapse drill" });
    const c0b = (await kbJson("/get", { id: card2 })).body;
    await kbJson("/update", {
      id: card2,
      meta: {
        ...c0b.meta,
        merge_train: {
          ...(c0b.meta.merge_train ?? {}),
          state: "awaiting",
          bounce_kind: "coverage",
          awaiting: { at: Date.now(), head_sha: H2, verdict_id: v2 },
          pr: 3502,
          repo,
        },
        blocked: { ...(c0b.meta.blocked ?? {}), reason: `Awaiting review (verdict ${v2}, anchored at head ${H2.slice(0, 9)})` },
      },
    });
    await kbJson("/admin.awaiting_requeue_sweep", {});
    const c2 = (await kbJson("/get", { id: card2 })).body;
    expect(c2.meta?.merge_train?.state).toBe("awaiting");
    expect(c2.meta?.merge_train?.awaiting?.head_sha).toBe(H2);

    // NEGATIVE 2: a human-leg park made through the REAL bounce path (human-
    // resolved conflicts invalidate the verdict at H2) survives the tick
    const card3 = await queueViaAccept({ repo, pr: 3503, head: H1, title: "IMPL: migration-human drill" });
    expect((await kbJson("/train.event", { repo, base: "main", kind: "bounced", actor: "gw-mg", pr: 3503, task_id: card3, head_sha: H2, bounce_kind: "coverage", conflict_files: ["src/a.ts"] })).body.error ?? "").toBe("");
    expect((await kbJson("/get", { id: card3 })).body.meta?.merge_train?.state).toBe("awaiting");
    await kbJson("/admin.awaiting_requeue_sweep", {});
    expect((await kbJson("/get", { id: card3 })).body.meta?.merge_train?.state).toBe("awaiting");

    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-mg" });
  });

  it("BR#5633 awaiting sweep, LAPSED park: the executor's re-assert (coverage bounce carrying the sweep marker + live head) hands the card to the verify pool — machine re-queue only when the verdict covers, never a strand", async () => {
    const repo = "state-vector/lane-sweep-lapse";
    const H1 = "4".repeat(40), H2 = "5".repeat(40);
    // the blackhole shape (bridge#364): queued at H1, parked Awaiting at H2
    // with a done verdict that does NOT cover H2 — the hub's own parked-head
    // sweep leaves it (correctly, BR#5226), so only the executor's live
    // re-assert can give it an exit
    const { implId: card, verifyId } = await queueViaAcceptBoth({ repo, pr: 3601, head: H1, title: "IMPL: sweep-lapse drill" });
    await acquire(repo, "gw-sw", { required_workflows: ["Test"] });
    const c0 = (await kbJson("/get", { id: card })).body;
    await kbJson("/update", {
      id: card,
      meta: {
        ...c0.meta,
        merge_train: {
          ...(c0.meta.merge_train ?? {}),
          state: "awaiting",
          bounce_kind: "coverage",
          defect: `PR #3601 live head ${H2} is not covered by the accepted verdict (leg 1 stamped ${H1.slice(0, 9)}, no contiguous carry chain) — head moved past the verdict without a machine-clean update; re-verify at the new head`,
          awaiting: { at: Date.now(), head_sha: H2, verdict_id: verifyId },
          pr: 3601,
          repo,
        },
        blocked: { ...(c0.meta.blocked ?? {}), reason: `Awaiting review (verdict ${verifyId}, anchored at head ${H2.slice(0, 9)})` },
      },
    });
    // the sweep fires: the executor re-asserts through the audited bounce
    // path with the LIVE head and a marker reason (NO conflict files, NO
    // human-leg vocabulary — exactly what train.rs emits)
    const reasserted = await kbJson("/train.event", {
      repo, base: "main", kind: "bounced", actor: "gw-sw", pr: 3601, task_id: card,
      head_sha: H2, bounce_kind: "coverage",
      reason: "awaiting sweep: re-assert parked card with live facts (BR#5633)",
    });
    expect(reasserted.body.error ?? "", `sweep re-assert failed: ${JSON.stringify(reasserted.body)}`).toBe("");
    // the verdict does not cover the live head and there is no human leg —
    // the plain machine-lapse fall-through: impl bounce, NO park, NO requeue
    expect(reasserted.body.machine_requeue).toBeUndefined();
    expect(reasserted.body.awaiting_park).toBeUndefined();
    const c = (await kbJson("/get", { id: card })).body;
    expect(c.status).toBe("in_progress");
    expect(c.meta?.merge_train?.state).toBe("bounced");
    expect(c.meta?.merge_train?.awaiting).toBeUndefined();
    // the STORED defect survives on the bounce record — the marker never
    // overwrites the card's own history
    expect(String(c.meta?.merge_train?.defect ?? "")).toContain("no contiguous carry chain");
    expect(String(c.meta?.merge_train?.defect ?? "")).not.toContain("awaiting sweep");
    expect(String(c.body_md ?? "")).toContain("Merge-train bounce (coverage)");
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-sw" });
  });

  it("BR#5633 awaiting sweep, HUMAN-LEG park: the re-assert classifies on the card's STORED park facts — the marker reason alone must not demote a genuine human leg to a machine lapse", async () => {
    const repo = "state-vector/lane-sweep-human";
    const H1 = "6".repeat(40), H2 = "7".repeat(40);
    // a REAL human-leg park (conflict files ride the first bounce)
    const card = await queueViaAccept({ repo, pr: 3602, head: H1, title: "IMPL: sweep-human drill" });
    await acquire(repo, "gw-sh", { required_workflows: ["Test"] });
    const parked = await kbJson("/train.event", {
      repo, base: "main", kind: "bounced", actor: "gw-sh", pr: 3602, task_id: card,
      head_sha: H2, bounce_kind: "coverage", merge_state_status: "dirty",
      reason: "PR #3602 head moved past the accepted verdict — human-resolved conflict",
      conflict_files: ["src/train/park.ts"],
    });
    expect(parked.body.error ?? "").toBe("");
    expect(parked.body.awaiting_park).toBe(true);
    // the sweep re-asserts at the SAME head with a clean marker reason and
    // NO conflict_files — the handler must still see the human leg
    const reasserted = await kbJson("/train.event", {
      repo, base: "main", kind: "bounced", actor: "gw-sh", pr: 3602, task_id: card,
      head_sha: H2, bounce_kind: "coverage",
      reason: "awaiting sweep: re-assert parked card with live facts (BR#5633)",
    });
    expect(reasserted.body.error ?? "", `sweep re-assert failed: ${JSON.stringify(reasserted.body)}`).toBe("");
    expect(reasserted.body.awaiting_park).toBe(true);
    expect(reasserted.body.machine_requeue).toBeUndefined();
    const c = (await kbJson("/get", { id: card })).body;
    expect(c.status).toBe("blocked");
    expect(c.meta?.merge_train?.state).toBe("awaiting");
    expect(c.meta?.merge_train?.awaiting?.head_sha).toBe(H2);
    // the park's OWN record survived the refresh: original defect text +
    // conflict files, never the marker
    expect(String(c.meta?.merge_train?.defect ?? "")).toContain("human-resolved conflict");
    expect(c.meta?.merge_train?.conflict_files).toEqual(["src/train/park.ts"]);
    expect(String(c.meta?.merge_train?.defect ?? "")).not.toContain("awaiting sweep");
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-sh" });
  });

  it("BR#5633 awaiting-sweep rate-limit stamp: train.queue_facts merges {task: {head, outcome, at}} without clobbering the walk's stored entries — absent entries PRESERVE, explicit [] still clears, train.status serves the stamps", async () => {
    const repo = "state-vector/lane-sweep-stamp";
    await queueViaAccept({ repo, pr: 3603, head: "8".repeat(40), title: "IMPL: sweep-stamp drill" });
    await acquire(repo, "gw-st", { required_workflows: ["Test"] });
    // the walk's own stamp: per-entry verdicts
    const walk = await kbJson("/train.queue_facts", {
      repo, base: "main", actor: "gw-st",
      entries: [{ id: "BR#W1", pr: 3603, cls: "ready" }],
      base_state: { verdict: "green", scoped_to_required: true, red: [], unsettled: [] },
    });
    expect(walk.body.error ?? "").toBe("");
    // the sweep's stamp: NO entries field — must preserve the walk's blocks
    const sweep = await kbJson("/train.queue_facts", {
      repo, base: "main", actor: "gw-st",
      awaiting_sweep: { "BR#W1": { head: "9".repeat(40), outcome: "impl_bounce", at: Date.now() } },
    });
    expect(sweep.body.error ?? "").toBe("");
    let lane = await laneSnap(repo);
    expect(lane.queue_facts.entries).toEqual([{ id: "BR#W1", pr: 3603, cls: "ready" }]);
    expect(lane.queue_facts.base_state?.verdict).toBe("green");
    expect(lane.awaiting_sweep?.["BR#W1"]?.outcome).toBe("impl_bounce");
    expect(lane.awaiting_sweep?.["BR#W1"]?.head).toBe("9".repeat(40));
    // a walk re-stamp (entries present) refreshes the blocks and leaves the
    // sweep ledger alone
    const walk2 = await kbJson("/train.queue_facts", {
      repo, base: "main", actor: "gw-st",
      entries: [{ id: "BR#W1", pr: 3603, cls: "waiting" }],
    });
    expect(walk2.body.error ?? "").toBe("");
    lane = await laneSnap(repo);
    expect(lane.queue_facts.entries).toEqual([{ id: "BR#W1", pr: 3603, cls: "waiting" }]);
    expect(lane.awaiting_sweep?.["BR#W1"]?.outcome).toBe("impl_bounce");
    // an EXPLICIT empty entries still clears (the bypass/rerun acks rely on it)
    const clear = await kbJson("/train.queue_facts", { repo, base: "main", actor: "gw-st", entries: [] });
    expect(clear.body.error ?? "").toBe("");
    lane = await laneSnap(repo);
    expect(lane.queue_facts.entries).toEqual([]);
    expect(lane.awaiting_sweep?.["BR#W1"]?.outcome).toBe("impl_bounce");
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-st" });
  });

  it("BR#4962: a second coverage bounce refreshes the SAME park (one row, newest anchor) and force-review approve re-anchors the verdict at the parked head — carry leg via force-review, queued in place, zero asks", async () => {
    const repo = "state-vector/lane-force";
    const H1 = "1".repeat(40), H2 = "2".repeat(40), H3 = "3".repeat(40);
    const card = await queueViaAccept({ repo, pr: 3201, head: H1, title: "IMPL: force-review drill" });
    await acquire(repo, "gw-force", { required_workflows: ["Test"] });

    // park #1 at H2 (the head moved once; the external review was dismissed
    // with no machine replacement — a genuine human leg, BR#5226)
    expect((await kbJson("/train.event", { repo, base: "main", kind: "bounced", actor: "gw-force", pr: 3201, task_id: card, head_sha: H2, bounce_kind: "coverage", reason: "external review dismissed on the head move — no machine replacement" })).body.error ?? "").toBe("");
    let lane = await laneSnap(repo);
    expect((lane.awaiting ?? []).length).toBe(1);
    expect(lane.awaiting[0].head_sha).toBe(H2);
    const at1 = Number((await kbJson("/get", { id: card })).body.meta?.merge_train?.awaiting?.at ?? 0);

    // park #2 at H3 (moved again): the SAME card refreshes IN PLACE — one
    // awaiting row, the anchor moves to H3, the park timestamp re-stamps
    expect((await kbJson("/train.event", { repo, base: "main", kind: "bounced", actor: "gw-force", pr: 3201, task_id: card, head_sha: H3, bounce_kind: "coverage", reason: "external review dismissed on the head move — no machine replacement" })).body.error ?? "").toBe("");
    lane = await laneSnap(repo);
    expect((lane.awaiting ?? []).length).toBe(1);
    expect(lane.awaiting[0].head_sha).toBe(H3);
    const parked = (await kbJson("/get", { id: card })).body;
    expect(Number(parked.meta?.merge_train?.awaiting?.at ?? 0)).toBeGreaterThanOrEqual(at1);
    const verdictId = String(parked.meta?.merge_train?.awaiting?.verdict_id ?? "");

    // the human force-reviews from the backlog: APPROVE re-anchors the
    // verdict at the parked head — a carry leg per unlanded PR, via
    // "force-review" — and re-queues the card IN PLACE (never a transition)
    const fr = await kbJson("/card.force_review", { id: card, decision: "approve", note: "rebase is clean — carry the verdict" });
    expect(fr.body.error ?? "", `force_review failed: ${JSON.stringify(fr.body)}`).toBe("");
    expect(fr.body.ok).toBe(true);
    expect(fr.body.decision).toBe("approve");
    expect(fr.body.legs_carried).toEqual([`${repo}#3201 ${H1.slice(0, 9)}→${H3.slice(0, 9)}`]);

    const c = (await kbJson("/get", { id: card })).body;
    // refresh, not transition: still blocked, the queued reason is back
    expect(c.status).toBe("blocked");
    expect(c.meta?.merge_train?.state).toBe("queued");
    expect(c.meta?.blocked?.reason).toBe("merge-train: queued");
    expect(c.meta?.merge_train?.awaiting).toBeUndefined(); // the stamp cleared
    expect(c.meta?.boosted).toBeUndefined(); // the park boost decayed — re-queue deletes it
    // the carry leg: stamped head → parked head, via force-review, the
    // parked verdict carried
    const carry = c.meta?.pr?.carry ?? [];
    expect(carry.length).toBe(1);
    expect(carry[0].via).toBe("force-review");
    expect(carry[0].from_head).toBe(H1);
    expect(carry[0].to_head).toBe(H3);
    expect(carry[0].prior_verdict_id).toBe(verdictId);
    // zero asks before, during, after
    expect((await reviewAsks(card)).length).toBe(0);
    // the approval is loud on the audit chain (the verdict receipt)
    const h = JSON.stringify(await (await kbJson("/get_history", { id: card, limit: 10 })).body);
    expect(h).toContain("force-review approved (human)");
    // and the train's queue picks the card back up
    expect((await laneSnap(repo)).queue.map((x: any) => x.id)).toContain(card);

    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-force" });
  });

  it("BR#4962: force-review request_changes bounces impl like the train's own bounce — repair leg in_progress with the reviewer brief, boost stamped, zero asks", async () => {
    const repo = "state-vector/lane-rc";
    const H = "4".repeat(40), H2 = "5".repeat(40);
    const card = await queueViaAccept({ repo, pr: 3301, head: H, title: "IMPL: request-changes drill" });
    await acquire(repo, "gw-rc", { required_workflows: ["Test"] });
    // a human-leg coverage park first (human-resolved conflicts invalidate
    // the verdict at H2 — BR#5226), then the human asks for changes
    expect((await kbJson("/train.event", { repo, base: "main", kind: "bounced", actor: "gw-rc", pr: 3301, task_id: card, head_sha: H2, bounce_kind: "coverage", conflict_files: ["fixtures/shard.ts"] })).body.error ?? "").toBe("");

    const note = "the fixture hardcodes the shard map";
    const fr = await kbJson("/card.force_review", { id: card, decision: "request_changes", note });
    expect(fr.body.error ?? "", `force_review failed: ${JSON.stringify(fr.body)}`).toBe("");
    expect(fr.body.ok).toBe(true);

    // impl repair leg: bounced like a train bounce, the note rides the brief
    const c = (await kbJson("/get", { id: card })).body;
    expect(c.status).toBe("in_progress");
    expect(c.meta?.merge_train?.state).toBe("bounced");
    expect(c.meta?.merge_train?.bounce_kind).toBe("coverage");
    expect(String(c.meta?.merge_train?.defect)).toContain(note);
    expect(c.meta?.boosted).toBeGreaterThan(0);
    expect(c.meta?.merge_train?.awaiting).toBeUndefined();
    expect(String(c.body_md)).toContain("Force-review changes requested");
    expect(String(c.body_md)).toContain("**Reviewer note:**");
    expect(String(c.body_md)).toContain(note);
    expect(String(c.body_md)).toContain("**Next owner: impl**");
    // the parked verdict is NOT carried across a requested change
    expect(c.meta?.pr?.carry ?? []).toHaveLength(0);
    expect((await reviewAsks(card)).length).toBe(0);

    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-rc" });
  });

  it("BR#4962: the lane's Awaiting band ages parks — amber at the TTL (24h default), red past TTL+grace, oldest park first; a lapsed park STILL lists (visibility without interruption)", async () => {
    const repo = "state-vector/lane-agechip";
    const H8 = "8".repeat(40), H9 = "9".repeat(40);
    const card = await queueViaAccept({ repo, pr: 3501, head: H8, title: "IMPL: awaiting-age drill" });
    await acquire(repo, "gw-chip", { required_workflows: ["Test"] });
    // a human-leg park (BR#5226): human-resolved conflicts invalidate the
    // verdict at the moved head — the card parks Awaiting
    expect((await kbJson("/train.event", { repo, base: "main", kind: "bounced", actor: "gw-chip", pr: 3501, task_id: card, head_sha: "a".repeat(40), bounce_kind: "coverage", conflict_files: ["src/x.ts"] })).body.error ?? "").toBe("");
    let lane = await laneSnap(repo);
    expect((lane.awaiting ?? []).length).toBe(1);
    expect(lane.awaiting[0].aging).toBe(false);
    expect(lane.awaiting[0].lapsed).toBe(false);

    // backdate the park stamp (the surface reads awaiting.at) — past the 24h
    // TTL: amber (aging), not red yet
    const backdate = async (hours: number) => {
      const c = (await kbJson("/get", { id: card })).body;
      const mt = c.meta.merge_train;
      await kbJson("/update", { id: card, meta: { ...c.meta, merge_train: { ...mt, awaiting: { ...mt.awaiting, at: Date.now() - hours * 60 * 60_000 } } } });
    };
    await backdate(25);
    lane = await laneSnap(repo);
    expect(lane.awaiting[0].aging).toBe(true);
    expect(lane.awaiting[0].lapsed).toBe(false);

    // past TTL + the 2h grace: red (lapsed) — still listed
    await backdate(27);
    lane = await laneSnap(repo);
    expect(lane.awaiting[0].lapsed).toBe(true);

    // a second card's FRESH park orders after the aged one (oldest first)
    const card2 = await queueViaAccept({ repo, pr: 3502, head: H9, title: "IMPL: awaiting-age drill 2" });
    expect((await kbJson("/train.event", { repo, base: "main", kind: "bounced", actor: "gw-chip", pr: 3502, task_id: card2, head_sha: "b".repeat(40), bounce_kind: "coverage", conflict_files: ["src/y.ts"] })).body.error ?? "").toBe("");
    lane = await laneSnap(repo);
    expect((lane.awaiting ?? []).length).toBe(2);
    expect(lane.awaiting[0].task).toBe(card);
    expect(lane.awaiting[1].task).toBe(card2);
    expect(lane.awaiting[0].age_ms).toBeGreaterThanOrEqual(lane.awaiting[1].age_ms);
    expect(lane.awaiting[1].aging).toBe(false);

    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-chip" });
  });

  it("BR#4962: the force-review-approved park lands through the train's own flow — approve re-queues, the machine merges + settles CI, the card closes done; zero asks end to end", async () => {
    const repo = "state-vector/lane-force-land";
    const H1 = "5".repeat(40), H2 = "6".repeat(40), M = "7".repeat(40);
    const card = await queueViaAccept({ repo, pr: 3601, head: H1, title: "IMPL: force-review landing drill" });
    await acquire(repo, "gw-land", { required_workflows: ["Test"] });

    // park (human-leg: human-resolved conflicts invalidate the verdict at
    // H2) → approve → the train's own queue derivation picks it up
    expect((await kbJson("/train.event", { repo, base: "main", kind: "bounced", actor: "gw-land", pr: 3601, task_id: card, head_sha: H2, bounce_kind: "coverage", conflict_files: ["src/z.ts"] })).body.error ?? "").toBe("");
    expect((await kbJson("/card.force_review", { id: card, decision: "approve" })).body.error ?? "").toBe("");
    expect((await laneSnap(repo)).queue.map((x: any) => x.id)).toContain(card);
    expect((await reviewAsks(card)).length).toBe(0);

    // merge + green CI ⇒ landed via the machine-proxy close
    const merged = await kbJson("/train.event", { repo, base: "main", kind: "merged", actor: "gw-land", pr: 3601, merge_sha: M, head_sha: H2, task_id: card });
    expect(merged.body.error ?? "", `train:merged failed: ${JSON.stringify(merged.body)}`).toBe("");
    const landed = await kbJson("/train.ci", { repo, base: "main", actor: "gw-land", sha: M, checks: [check(41, "Test", "success")] });
    expect(landed.body.decided).toBe("landed");

    const c = (await kbJson("/get", { id: card })).body;
    expect(c.status).toBe("done");
    expect(c.meta?.merge_train?.state).toBe("landed");
    // zero asks end to end — nothing to retire, nothing that fenced the close
    expect((await reviewAsks(card)).length).toBe(0);

    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-land" });
  });

  it("BR#4981/BR#4962: attempting + bypass-wait + stop-culprit lane vocabulary; gate bounces keep the honest lane states and file ZERO asks + ZERO digests (BR#4960 — the parked card IS the leg)", async () => {
    const repo = "state-vector/lane-vocab";
    const H1 = "5".repeat(40), H2 = "7".repeat(40), M1 = "6".repeat(40);
    const card1 = await queueViaAccept({ repo, pr: 3401, head: H1, title: "IMPL: vocab drill leg 1" });
    const card2 = await queueViaAccept({ repo, pr: 3402, head: H2, title: "IMPL: vocab drill leg 2" });
    await acquire(repo, "gw-vocab", { required_workflows: ["Test"] });

    // the head is being worked — the reason says it in plain words (Ray
    // 2026-10-30: "'gate' is meaningless — remove jargon"), and the
    // structured attempt field carries the same sentence for the panel
    const snap1 = await laneSnap(repo);
    expect(String(snap1.reason)).toContain(`working on ${card1} — checking review, signatures and CI before merging`);
    expect(snap1.attempt).toMatchObject({ card: card1, hold: "merge-checks" });
    expect(String(snap1.attempt.note)).toContain("checking review, signatures and CI");

    // gate bounce blocked on protection ⇒ the honest bypass-wait state —
    // and NO ask: not to the pool, not to the human (BR#4960)
    expect((await kbJson("/train.event", { repo, base: "main", kind: "bounced", actor: "gw-vocab", pr: 3401, task_id: card1, head_sha: H1, bounce_kind: "gate", merge_state_status: "blocked", reason: "review required by branch protection" })).body.error ?? "").toBe("");
    const snap2 = await laneSnap(repo);
    expect(String(snap2.reason)).toContain("awaiting bypass merge — PR #3401");
    expect(snap2.bypass_wait?.pr).toBe(3401);
    expect((await reviewAsks(card1)).length).toBe(0);
    expect(((await allQuestions()).filter((a: any) => String(a.title).startsWith(`Merge-train digest ${repo}@main`))).length).toBe(0);

    // second gate bounce moves the bypass-wait to the new head — still zero
    // ask/digest legs, nothing for a human to triage in an inbox
    expect((await kbJson("/train.event", { repo, base: "main", kind: "bounced", actor: "gw-vocab", pr: 3402, task_id: card2, head_sha: H2, bounce_kind: "gate", merge_state_status: "blocked", reason: "review required by branch protection" })).body.error ?? "").toBe("");
    expect((await laneSnap(repo)).bypass_wait?.pr).toBe(3402);
    expect((await reviewAsks(card2)).length).toBe(0);
    expect(((await allQuestions()).filter((a: any) => String(a.title).startsWith(`Merge-train digest ${repo}@main`))).length).toBe(0);

    // landing leg 1: bypass-wait is typed to ITS pr — leg 2's wait survives
    expect((await kbJson("/train.event", { repo, base: "main", kind: "merged", actor: "gw-vocab", pr: 3401, merge_sha: M1, head_sha: H1, task_id: card1 })).body.error ?? "").toBe("");
    const snap3 = await laneSnap(repo);
    expect(snap3.bypass_wait?.pr).toBe(3402);
    // the settle outranks the wait on the reason; the wait rides as a suffix
    expect(String(snap3.reason)).toContain("settling on");
    expect(String(snap3.reason)).toContain("bypass wait: PR #3402");

    // STOP THE LINE names the culprit card (state 6)
    expect((await kbJson("/train.event", { repo, base: "main", kind: "stopped", actor: "gw-vocab", merge_sha: M1, pr: 3401, culprit_task: card1, reason: "required workflows RED: Test" })).body.error ?? "").toBe("");
    const snap4 = await laneSnap(repo);
    expect(String(snap4.reason)).toContain("STOPPED");
    expect(String(snap4.reason)).toContain(`culprit ${card1}`);
    expect(snap4.stop?.culprit_task).toBe(card1);

    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-vocab", line_green: true });
  });

  // BR#4687 (L1.2): the executor machine-updated a behind worker-authored
  // branch — `updated` stamps the carry chain the moment the update lands,
  // and the card re-enters the queue SILENTLY: no bounce, no status change,
  // no review ask, no boost. The merge at the carried head must NOT
  // double-append the chain leg.
  it("BR#4687: train:updated carries the verdict across a machine update-branch — card re-enters silently, merged dedupes the chain", async () => {
    const repo = "state-vector/lane-updated";
    const A = "e".repeat(40), B = "f".repeat(40);
    const card = await queueViaAccept({ repo, pr: 4687, head: A, title: "IMPL: behind carry drill" });
    await acquire(repo, "gw-upd", { required_workflows: ["Test"] });

    const upd = await kbJson("/train.event", {
      repo, base: "main", kind: "updated", actor: "gw-upd",
      pr: 4687, task_id: card, from_head: A, head_sha: B,
    });
    expect(upd.body.error ?? "", `train:updated failed: ${JSON.stringify(upd.body)}`).toBe("");
    expect(upd.body.task).toBe(card);

    // the carry chain holds stamp→new head, and the card is EXACTLY where
    // it was — queued (blocked) with the queue's own stamp untouched (the
    // handler never writes meta.merge_train), unbounced, unboosted, no ask
    const c = (await kbJson("/get", { id: card })).body;
    expect(c.status).toBe("blocked");
    const legCarry = c.meta?.prs?.find((l: any) => l.number === 4687)?.carry;
    const legacyCarry = c.meta?.pr?.number === 4687 ? c.meta?.pr?.carry : undefined;
    const carry = legCarry ?? legacyCarry;
    expect(Array.isArray(carry)).toBe(true);
    expect(carry).toHaveLength(1);
    expect(String(carry[0].from_head).toLowerCase()).toBe(A);
    expect(String(carry[0].to_head).toLowerCase()).toBe(B);
    expect(carry[0].via).toBe("update-branch");
    expect(c.meta?.merge_train?.state).toBe("queued");
    expect(c.meta?.boosted).toBeUndefined();
    expect(await reviewAsks(card)).toHaveLength(0);
    const hist = (await kbJson("/train.history", { repo })).body.events;
    expect(hist.filter((e: any) => e.kind === "updated")).toHaveLength(1);
    expect(hist.filter((e: any) => e.kind === "bounced")).toHaveLength(0);

    // A second clean update extends the chain's current end, not its stamp.
    const C = "8".repeat(40);
    const secondArgs = { repo, base: "main", kind: "updated", actor: "gw-upd", pr: 4687, task_id: card, from_head: B, head_sha: C };
    expect((await kbJson("/train.event", secondArgs)).status).toBe(200);
    expect((await kbJson("/train.event", secondArgs)).status).toBe(200); // replay is not another append
    const gap = await kbJson("/train.event", { ...secondArgs, from_head: A, head_sha: "7".repeat(40) });
    expect(gap.status).toBe(400);
    // The merge lands at the carried head without appending a duplicate.
    const merged = await kbJson("/train.event", {
      repo, base: "main", kind: "merged", actor: "gw-upd",
      pr: 4687, merge_sha: "9".repeat(40), head_sha: C, task_id: card,
    });
    expect(merged.body.error ?? "", `train:merged failed: ${JSON.stringify(merged.body)}`).toBe("");
    const c2 = (await kbJson("/get", { id: card })).body;
    const carry2 = c2.meta?.prs?.find((l: any) => l.number === 4687)?.carry ?? (c2.meta?.pr?.number === 4687 ? c2.meta?.pr?.carry : undefined);
    expect(carry2).toHaveLength(2);
    expect(carry2[1]).toMatchObject({ from_head: B, to_head: C });

    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-upd" });
  });

  // BR#4687: the carry is only as good as its contiguity — a from_head that
  // is not THIS leg's stamp is refused loud (a broken chain can never be
  // extended), and garbage sha shapes never reach the meta write.
  it("BR#4687: train:updated fails loud off-contiguity — from_head must be the leg's stamp, heads must be 40-hex", async () => {
    const repo = "state-vector/lane-updated-guard";
    const A = "1".repeat(40);
    const card = await queueViaAccept({ repo, pr: 4688, head: A, title: "IMPL: behind carry guard" });
    await acquire(repo, "gw-upd2", { required_workflows: ["Test"] });
    const wrongBinding = await kbJson("/train.event", { repo, kind: "updated", actor: "gw-upd2", task_id: card,
      pr: 9999, from_head: A, head_sha: "4".repeat(40) });
    expect(wrongBinding.status).toBe(400);

    const offChain = await kbJson("/train.event", {
      repo, base: "main", kind: "updated", actor: "gw-upd2",
      pr: 4688, task_id: card, from_head: "2".repeat(40), head_sha: "3".repeat(40),
    });
    expect(String(offChain.body.error)).toContain("stamp");

    const badShape = await kbJson("/train.event", {
      repo, base: "main", kind: "updated", actor: "gw-upd2",
      pr: 4688, task_id: card, from_head: "not-a-sha", head_sha: "4".repeat(40),
    });
    expect(String(badShape.body.error)).toContain("40-hex");

    // nothing was written: the chain is untouched, the card still queued
    const c = (await kbJson("/get", { id: card })).body;
    const carry = c.meta?.prs?.find((l: any) => l.number === 4688)?.carry ?? (c.meta?.pr?.number === 4688 ? c.meta?.pr?.carry : undefined);
    expect(carry ?? []).toHaveLength(0);
    expect(c.status).toBe("blocked");

    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-upd2" });
  });
});

describe("BR#4489 starvation — capability-aware lane health", () => {
  it("merge_capable leases stamp the capable clock; a non-capable lease does not", async () => {
    const repo = "state-vector/starve-capable";
    const a = await acquire(repo, "gw-cody", { merge_capable: true });
    expect(a.body.error ?? "").toBe("");
    const lane0 = await laneSnap(repo);
    expect(lane0.last_capable_lease_ts).toBeGreaterThan(0);
    const stamped = lane0.last_capable_lease_ts;
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-cody" });

    // the stand-down class: a lease op WITHOUT merge_capable must leave the
    // capable clock alone (it proves liveness, not capability)
    const b = await acquire(repo, "gw-personal", {});
    expect(b.body.error ?? "").toBe("");
    const lane1 = await laneSnap(repo);
    expect(lane1.last_capable_lease_ts).toBe(stamped);
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-personal" });
  });

  it("non-empty queue + no capable lease >10min ⇒ starved — `lane.starved` broadcast + red ask ONCE per episode", async () => {
    const repo = "state-vector/starve-lane";
    const sink = (await kbJson("/create", { type: "task", title: "Starvation alarm sink", meta: { infra_anchor: true } })).body.id;
    await kbJson("/admin.settings_set", { settings: { train_alarm_sink_id: sink } });
    const a = await acquire(repo, "gw-cody", { merge_capable: true });
    expect(a.body.error ?? "").toBe("");
    const seeded = await laneSnap(repo);
    const laneCard: string = seeded.card;
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-cody" });

    // queue a card the REAL way (verify close citing head + PR — the accept hook)
    await queueViaAccept({ repo, pr: 44891, head: "b".repeat(40), title: "IMPL: starve drill" });
    const queued = await laneSnap(repo);
    expect(queued.queue.length).toBeGreaterThan(0);

    // backdate the capable clock deep past the 10-min starve window
    const before = (await kbJson("/events?limit=500")).body.events.filter(
      (e: any) => e.op === "lane.starved" && e.artefact_id === laneCard,
    );
    const lc = await kbJson("/get", { id: laneCard });
    const m = lc.body.meta;
    m.lane.last_capable_lease_ts = Date.now() - 25 * 60_000;
    await kbJson("/update", { id: laneCard, meta: m });

    const starvedEvents = async () =>
      (await kbJson("/events?limit=500")).body.events.filter(
        (e: any) => e.op === "lane.starved" && e.artefact_id === laneCard,
      );

    // a read judges starvation (trainStatus) — as does the alarm sweep, so
    // the FIRST episode entry may come from either caller; exactly one ask
    // and one broadcast per episode is the contract
    const st = await kbJson("/train.status", { repo });
    const lane = st.body.lanes.find((l: any) => l.lane === `${repo}@main`);
    expect(lane.starved).toBeTruthy();
    expect(lane.starved.mins).toBeGreaterThanOrEqual(10);
    expect(lane.last_capable_lease_ts).toBeGreaterThan(0);

    // …the episode stamps ONCE, broadcasts ONCE, and fires the red ask ONCE
    const after1 = await starvedEvents();
    expect(after1.length).toBeGreaterThanOrEqual(before.length + 1);
    const stamped1 = (await kbJson("/get", { id: laneCard })).body.meta.lane.starved_since;
    expect(stamped1).toBeGreaterThan(0);
    const asks1 = await kbJson("/search?q=starved&type=question&limit=50");
    // NB: /search's semantic branch ignores the type filter — re-apply it here
    const mine1 = asks1.body.artefacts.filter((x: any) => x.type === "question" && x.meta?.ask?.decision?.task_id === laneCard);
    expect(mine1.length).toBe(1);

    // a second read (and the alarm sweep riding the alarm tick) must NOT
    // re-broadcast, re-stamp, or re-ask: once per episode
    await kbJson("/train.status", { repo });
    const after2 = await starvedEvents();
    expect(after2.length).toBe(after1.length);
    expect((await kbJson("/get", { id: laneCard })).body.meta.lane.starved_since).toBe(stamped1);
    const asks2 = await kbJson("/search?q=starved&type=question&limit=50");
    expect(asks2.body.artefacts.filter((x: any) => x.type === "question" && x.meta?.ask?.decision?.task_id === laneCard).length).toBe(1);

    // recovery: a capable lease clears the episode (state + payload)
    await acquire(repo, "gw-cody", { merge_capable: true });
    const lane3 = await laneSnap(repo);
    expect(lane3.starved).toBeNull();
    expect((await kbJson("/get", { id: laneCard })).body.meta.lane.starved_since ?? null).toBeNull();
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-cody" });
  });
});

// ---------- BR#4753: landed-close recovery (the green-branch wedge) ----------
// The incident: bridge@main sat awaiting-ci 60+ min past the fail-closed
// bound because a gate-rejected landed close (done-open-children) threw raw
// EVERY tick — silently, and the bound was only consulted on the pending
// branch. These drills pin the resolution: every green-verdict tick resolves
// { landed, landed_retry, bounce_gate, bounce_bound } and the queue advances.

describe("BR#4753 landed-close recovery (real bundled worker)", () => {
  it("a gate-rejected landed close CLOSE-BOUNCES the culprit card, idles the lane, and files ONE alarm-sink ask — never a raw throw", async () => {
    const repo = "state-vector/lane-closebounce";
    // a reachable alarm sink for this episode (the setting overrides BR#3124)
    const sink = await kbJson("/create", { type: "task", title: "ALARM SINK drill — close-bounce", session: "" });
    const sinkId = String(sink.body.id);
    await kbJson("/admin.settings_set", { settings: { train_alarm_sink_id: sinkId } });

    const HEAD = "a".repeat(40);
    const card = await queueViaAccept({ repo, pr: 4753, head: HEAD, title: "IMPL: close-bounce drill" });
    // the wedge-maker: an OPEN child the done-open-children gate will fence on
    const child = await kbJson("/create", { type: "task", title: "open child of the close-bounce drill card", session: "" });
    await kbJson("/link", { src: String(child.body.id), relation: "child_of", dst: card });

    await acquire(repo, "gw-cb", { required_workflows: ["Test"] });
    const M = "c".repeat(40);
    const merged = await kbJson("/train.event", {
      repo, base: "main", kind: "merged", actor: "gw-cb",
      pr: 4753, merge_sha: M, head_sha: HEAD, task_id: card,
      merged_at: Date.now() - 10 * 60_000, // past the settle dwell (BR#4804)
    });
    expect(merged.body.error ?? "", `train:merged failed: ${JSON.stringify(merged.body)}`).toBe("");

    // green verdict, but the card cannot close (open child) — the OLD code
    // raw-threw here, every tick, silently
    const ci = await kbJson("/train.ci", { repo, base: "main", actor: "gw-cb", sha: M, checks: [check(1, "Test", "success")] });
    expect(ci.body.decided).toBe("bounce_gate");
    expect(ci.body.breach_class).toBe("gate:open-children");

    // the card: bounced to impl with the repair brief, priority 0 (the
    // half-closed shape: blocked→in_progress fired inside landedFlow, then
    // done was refused — the bounce must NOT attempt an illegal
    // in_progress→in_progress)
    const c = (await kbJson("/get", { id: card })).body;
    expect(c.status).toBe("in_progress");
    expect(c.meta?.merge_train?.state).toBe("bounced");
    expect(c.meta?.merge_train?.close_bounce).toBe(true);
    expect(c.meta?.merge_train?.breach_class).toBe("gate:open-children");
    expect(c.meta?.boosted).toBeGreaterThan(0);
    const brief = String(c.body_md);
    expect(brief).toContain("Merge-train close bounce (BR#4753)");
    expect(brief).toContain("IS MERGED");
    expect(brief).toContain("open child task(s)");
    expect(brief).toContain("Do NOT re-merge");

    // the lane IDLED and the queue advanced — the incident starved here
    const snap = await laneSnap(repo);
    expect(snap.currently).toBeNull();
    expect(snap.queue.map((x: any) => x.id)).not.toContain(card);

    // the ledger names the episode; exactly ONE ask rides the sink
    const hist = (await kbJson("/train.history", { repo })).body.events;
    const landedEv = hist.find((e: any) => e.kind === "landed");
    expect(JSON.stringify(landedEv)).toContain("close_bounced");
    const asks = await kbJson(`/search?q=${encodeURIComponent("landed close failed")}&type=question&limit=50`);
    const mine = asks.body.artefacts.filter((x: any) => x.type === "question" && String(x.title).includes(repo));
    expect(mine.length).toBe(1);
    const audits = (await kbJson("/events?limit=500")).body.events.filter((e: any) => e.op === "train:landed_close_bounced");
    expect(audits.length).toBeGreaterThanOrEqual(1);
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-cb" });
  });

  it("required=[] + ZERO checks + merge far past the settle dwell still RESOLVES (landed) — the vacuous-green lane can close, never wedge", async () => {
    const repo = "state-vector/lane-zeroruns";
    const HEAD = "b".repeat(40);
    const card = await queueViaAccept({ repo, pr: 4754, head: HEAD, title: "IMPL: zero-run settle drill" });
    await acquire(repo, "gw-z", {}); // NO lane config — the unconfigured lane
    const M = "d".repeat(40);
    const merged = await kbJson("/train.event", {
      repo, base: "main", kind: "merged", actor: "gw-z",
      pr: 4754, merge_sha: M, head_sha: HEAD, task_id: card,
      merged_at: Date.now() - 30 * 60_000, // dwell (2min) long passed
    });
    expect(merged.body.error ?? "", `train:merged failed: ${JSON.stringify(merged.body)}`).toBe("");
    // zero observed runs past the dwell → vacuous green (back-pressure judges
    // every OBSERVED check; zero observed = nothing to wait for) → the close
    // runs and RESOLVES — and when a close fails, the ladder bounces (the
    // bound is honored on the green branch too, pinned pure above)
    const ci = await kbJson("/train.ci", { repo, base: "main", actor: "gw-z", sha: M, checks: [] });
    expect(ci.body.decided).toBe("landed");
    expect((await kbJson("/get", { id: card })).body.status).toBe("done");
    expect((await laneSnap(repo)).currently).toBeNull();
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-z" });
  });

  // ---- BR#4806 event-driven tick: the lane.queued wake + the SSE channel ----

  /** Events strictly AFTER a seq — the exact delta, immune to the 500-row
   *  window sliding between reads. */
  const eventsAfter = async (seq: number) =>
    (await kbJson(`/events?since=${seq}&limit=500`)).body.events as any[];

  it("BR#4806 — a lane's queue empty→non-empty broadcasts `lane.queued` ONCE; non-transitions never re-broadcast", async () => {
    const repo = "state-vector/wake-lane";
    const cur = (await kbJson("/events?limit=1")).body.last_seq;

    // fresh entry on an idle lane → exactly one wake, shaped per the card
    await queueViaAccept({ repo, pr: 48100, head: "c".repeat(40), title: "IMPL: wake drill" });
    const wakes1 = (await eventsAfter(cur)).filter((e: any) => e.op === "lane.queued" && e.detail?.repo === repo);
    expect(wakes1.length).toBe(1);
    expect(wakes1[0].detail.base).toBe("main");
    expect(wakes1[0].detail.depth).toBeGreaterThanOrEqual(1);
    expect(wakes1[0].detail.head).toBeTruthy();
    expect(wakes1[0].actor).toBe("system:train");

    // a second card in the SAME lane (queue already non-empty) → NO wake:
    // the broadcast rides the empty→non-empty TRANSITION, not every entry
    const cur2 = (await kbJson("/events?limit=1")).body.last_seq;
    await queueViaAccept({ repo, pr: 48101, head: "d".repeat(40), title: "IMPL: wake drill 2" });
    const wakes2 = (await eventsAfter(cur2)).filter((e: any) => e.op === "lane.queued" && e.detail?.repo === repo);
    expect(wakes2.length).toBe(0);
  });

  it("BR#4806 — /sse streams the same kb.event frames the WS channel carries (the gateway wake channel)", { timeout: 40_000 }, async () => {
    // The miniflare DO stub bridge cannot carry an open streaming Response
    // (its value-stream closes immediately) — drive the REAL path instead:
    // this rig's OWN HTTP server → /api/kb/sse → authKb(?token=) → DO /sse,
    // exactly what the Rust wake leg dials. A second Miniflare would hold a
    // second DO with separate storage — the lane.queued broadcast would
    // never reach its sink, so the HTTP server rides the shared runtime.
    let res: Response | null = null;
    try {
      // a gateway-plane token for the kb plane (the same auth /kb-ws takes)
      const mint = await kbJson("/admin.mint", { label: "sse-wake-drill", tags: ["gateway"] });
      expect(mint.status, JSON.stringify(mint.body)).toBe(200);
      const token = String(mint.body.secret ?? "");
      expect(token).toBeTruthy();
      const served = await mf.ready; // resolves to the server URL (no getServerPort in miniflare 3.20250718.x)
      const port = Number(served.port);
      expect(port).toBeGreaterThan(0);

      const repo = "state-vector/sse-wake-lane";
      res = await fetch(`http://127.0.0.1:${port}/api/kb/sse?token=${encodeURIComponent(token)}`, {
        headers: { accept: "text/event-stream" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      let buf = "";
      let got: any = null;
      const scan = () => {
        for (const frame of buf.split("\n\n")) {
          if (!frame.startsWith("data: ")) continue;
          try {
            const j = JSON.parse(frame.slice(6));
            if (j?.type === "kb.event" && j?.event?.op === "lane.queued" && j?.event?.detail?.repo === repo) got = j;
          } catch { /* partial frame — more chunks coming */ }
        }
      };
      // consume the stream BEFORE triggering the queue entry — the
      // subscriber must already be registered when the broadcast fires
      const deadline = Date.now() + 25_000;
      const pump = (async () => {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        try {
          while (Date.now() < deadline && !got) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            scan();
          }
        } catch { /* stream torn down at test end */ }
      })();

      await queueViaAccept({ repo, pr: 48200, head: "e".repeat(40), title: "IMPL: sse wake drill" });
      const early = Date.now() + 25_000;
      while (!got && Date.now() < early) {
        await new Promise((r) => setTimeout(r, 100));
        scan();
      }
      await pump.catch(() => {});
      expect(got, "the lane.queued frame must arrive on the SSE stream within 25s").toBeTruthy();
      expect(got.event.detail.base).toBe("main");
      expect(got.event.detail.depth).toBeGreaterThanOrEqual(1);
    } finally {
      res?.body?.cancel?.().catch?.(() => {});
    }
  });

  // ---------- burst-drain settle (BR#4934, decision BR#4932 amends BR#4804) ----------

  it("BR#4934 burst config rides acquire; mid-drain + settle phase strings; a legacy merge keeps the BR#4804 strings byte-identical", async () => {
    const repo = "state-vector/lane-burst-cfg";
    await acquire(repo, "gw-bcfg", { required_workflows: ["Test"], burst_max: 3 });
    const snap = await laneSnap(repo);
    expect(snap.burst_max).toBe(3);
    const laneMeta = (await kbJson("/get", { id: snap.card })).body.meta ?? {};
    expect(laneMeta.lane.burst_max).toBe(3);

    // a legacy merged event (no burst payload) — the BR#4804 settle string, byte-identical
    const card = await queueViaAccept({ repo, pr: 5001, head: "1".repeat(40) });
    const M = "2".repeat(40);
    const merged = await kbJson("/train.event", { repo, base: "main", kind: "merged", actor: "gw-bcfg", pr: 5001, merge_sha: M, head_sha: "1".repeat(40), task_id: card });
    expect(merged.body.error ?? "", `train:merged failed: ${JSON.stringify(merged.body)}`).toBe("");
    // the merged card itself is the queue head (awaiting-ci cards are blocked
    // with a merge-train reason) → BR#4981's nextNote rides the settle string
    expect(merged.body.reason).toBe(`merge-train: leased by gw-bcfg — settling on ${M.slice(0, 9)} (PR #5001): build/deploy in flight, then ${card}, heads held until main settles`);
    expect((await laneSnap(repo)).currently.phase).toBe("awaiting-ci");

    // a burst merged event (mid-drain) flips the phase string to the drain view
    const card2 = await queueViaAccept({ repo, pr: 5002, head: "3".repeat(40) });
    const M2 = "4".repeat(40);
    const burst = await kbJson("/train.event", { repo, base: "main", kind: "merged", actor: "gw-bcfg", pr: 5002, merge_sha: M2, head_sha: "3".repeat(40), task_id: card2, burst_merged: 1, burst_cap: 3 });
    expect(burst.body.error ?? "").toBe("");
    expect(burst.body.reason).toBe("merge-train: leased by gw-bcfg — merging burst (1 merged, cap 3) — settle pending");
    expect((await laneSnap(repo)).currently.phase).toBe("bursting");

    // the settle feed (train.ci, pending) flips bursting → awaiting-ci with the burst settle string
    const ci = await kbJson("/train.ci", { repo, base: "main", actor: "gw-bcfg", sha: M2, checks: [check(61, "Test", null)] });
    expect(ci.body.decided).toBe("pending");
    // queue head = the older parked card (the legacy-merged card 5001) — nextNote names it (BR#4981)
    expect(ci.body.reason).toBe(`merge-train: leased by gw-bcfg — settling on ${M2.slice(0, 9)} after 1 merges (PR #5002): build/deploy in flight, then ${card}, heads held until main settles`);
    expect((await laneSnap(repo)).currently.phase).toBe("awaiting-ci");

    // cap 0 renders "unlimited" in the drain string
    const card3 = await queueViaAccept({ repo, pr: 5003, head: "5".repeat(40) });
    const M3 = "6".repeat(40);
    const unlimited = await kbJson("/train.event", { repo, base: "main", kind: "merged", actor: "gw-bcfg", pr: 5003, merge_sha: M3, head_sha: "5".repeat(40), task_id: card3, burst_merged: 2, burst_cap: 0 });
    expect(unlimited.body.reason).toContain("cap unlimited");
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-bcfg" });
  });

  it("BR#4934 burst pass: back-to-back merges park the intermediates; the GREEN settle closes them via fed ancestry (cancelled-by-next-push law) while the final card lands normally", async () => {
    const repo = "state-vector/lane-burst-pass";
    await acquire(repo, "gw-pass", { required_workflows: ["Test", "Deploy"], burst_max: 10 });
    const H1 = "a".repeat(40), H2 = "b".repeat(40);
    const c1 = await queueViaAccept({ repo, pr: 5101, head: H1, title: "IMPL: burst intermediate drill" });
    const c2 = await queueViaAccept({ repo, pr: 5102, head: H2, title: "IMPL: burst final drill" });
    const M1 = "c".repeat(40), M2 = "d".repeat(40);
    // merge 1 — mid-drain: the card parks awaiting-ci, the lane stays bursting
    const m1 = await kbJson("/train.event", { repo, base: "main", kind: "merged", actor: "gw-pass", pr: 5101, merge_sha: M1, head_sha: H1, task_id: c1, burst_merged: 1, burst_cap: 10 });
    expect(m1.body.error ?? "", `train:merged failed: ${JSON.stringify(m1.body)}`).toBe("");
    // the per-leg stamp rides meta.merge_train.legs keyed by PR NUMBER
    expect((await kbJson("/get", { id: c1 })).body.meta?.merge_train?.legs?.["5101"]?.state).toBe("awaiting-ci");
    expect((await laneSnap(repo)).currently.phase).toBe("bursting");
    // merge 2 — the pass's FINAL merge: the lane settles on it
    const m2 = await kbJson("/train.event", { repo, base: "main", kind: "merged", actor: "gw-pass", pr: 5102, merge_sha: M2, head_sha: H2, task_id: c2, burst_merged: 2, burst_cap: 10, burst_settling: true });
    expect(m2.body.error ?? "", `train:merged failed: ${JSON.stringify(m2.body)}`).toBe("");
    // settle feed: the executor-fed ancestry (M1 IS a git ancestor of M2 — the
    // hub holds no VCS creds, BR#3516) + green runs on the final sha only
    const ci = await kbJson("/train.ci", {
      repo, base: "main", actor: "gw-pass", sha: M2,
      ancestors_of_settled: [M1],
      checks: [check(71, "Test", "success"), check(72, "Deploy", "success")],
    });
    expect(ci.body.decided, JSON.stringify(ci.body)).toBe("landed");
    // the FINAL card closed through the normal machine-proxy landed close
    const done2 = (await kbJson("/get", { id: c2 })).body;
    expect(done2.status).toBe("done");
    expect(done2.meta?.merge_train?.state).toBe("landed");
    // the INTERMEDIATE park closed on the burst settle — zero hub GitHub calls,
    // the fed ancestry is the evidence, its cancelled runs say nothing (GH#2261)
    const done1 = (await kbJson("/get", { id: c1 })).body;
    expect(done1.status, JSON.stringify(done1.meta)).toBe("done");
    expect(done1.meta?.merge_train?.state).toBe("landed");
    expect(done1.meta?.merge_train?.burst_evidence).toBe(M2);
    expect(done1.meta?.merge_train?.legs?.["5101"]?.via).toBe("burst-settle");
    const h1 = JSON.stringify(await (await kbJson("/get_history", { id: c1, limit: 10 })).body);
    expect(h1).toContain("Burst-settle close (BR#4934)");
    expect(h1).toContain("cancelled-by-next-push");
    expect((await laneSnap(repo)).currently).toBeNull();
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-pass" });
  });

  it("BR#4934 red settle: the stop pre-stamps the bisect, the walk names ONE culprit (bounce + BR#4068 boost) and re-parks the wrongly stop-bounced final", async () => {
    const repo = "state-vector/lane-burst-red";
    await acquire(repo, "gw-red", { required_workflows: ["Test"], burst_max: 10 });
    const H1 = "e".repeat(40), H2 = "f".repeat(40);
    const c1 = await queueViaAccept({ repo, pr: 5201, head: H1, title: "IMPL: bisect culprit drill" });
    const c2 = await queueViaAccept({ repo, pr: 5202, head: H2, title: "IMPL: bisect final drill" });
    const M1 = "7".repeat(40), M2 = "8".repeat(40);
    await kbJson("/train.event", { repo, base: "main", kind: "merged", actor: "gw-red", pr: 5201, merge_sha: M1, head_sha: H1, task_id: c1, burst_merged: 1, burst_cap: 10 });
    await kbJson("/train.event", { repo, base: "main", kind: "merged", actor: "gw-red", pr: 5202, merge_sha: M2, head_sha: H2, task_id: c2, burst_merged: 2, burst_cap: 10, burst_settling: true });
    // the settle comes back RED on the final sha → the line stops, the FINAL
    // card bounces (the stop flow's default culprit), stop.bisect pre-stamps
    const ci = await kbJson("/train.ci", { repo, base: "main", actor: "gw-red", sha: M2, checks: [check(73, "Test", "failure")] });
    expect(ci.body.decided).toBe("stopped");
    const laneId = (await laneSnap(repo)).card;
    const stopMeta = (await kbJson("/get", { id: laneId })).body.meta;
    expect(stopMeta.stop?.bisect).toBeTruthy();
    expect(stopMeta.stop.bisect.pass).toEqual({ merged: 2, cap: 10 });
    expect(stopMeta.currently.phase).toBe("stopped");
    expect((await kbJson("/get", { id: c2 })).body.status).toBe("in_progress");
    // the executor's oldest→newest probe: M1 runs RED → c1 is THE culprit
    const bisect = await kbJson("/train.bisect", { repo, base: "main", actor: "gw-red", step: { sha: M1, verdict: "red" }, culprit_task: c1, culprit_sha: M1 });
    expect(bisect.body.error ?? "", JSON.stringify(bisect.body)).toBe("");
    expect(bisect.body.bounced).toBe(c1);
    expect(bisect.body.reparked).toBe(c2);
    // the TRUE culprit: bounced with the fix-forward brief + the starvation boost
    const culpritCard = (await kbJson("/get", { id: c1 })).body;
    expect(culpritCard.status).toBe("in_progress");
    expect(culpritCard.meta?.merge_train?.bisect_culprit).toBe(true);
    expect(culpritCard.meta?.merge_train?.culprit_sha).toBe(M1);
    expect(culpritCard.meta?.boosted).toBeTruthy();
    expect(String(culpritCard.body_md)).toContain("oldest RED");
    // the final card re-parked blocked, awaiting-ci restored — it closes on the
    // NEXT green settle via ancestor evidence
    const fin = (await kbJson("/get", { id: c2 })).body;
    expect(fin.status).toBe("blocked");
    expect(fin.meta?.merge_train?.state).toBe("awaiting-ci");
    expect(fin.meta?.merge_train?.reparked_by).toBe("bisect");
    // walk state lives hub-side (crash-safe): steps + culprit stamped
    const stop2 = (await kbJson("/get", { id: laneId })).body.meta.stop;
    expect(stop2.bisect.steps[M1]?.verdict).toBe("red");
    expect(stop2.bisect.culprit_task).toBe(c1);
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-red" });
  });

  it("BR#4934 inconclusive bisect: the stamp rides stop.bisect, nothing bounces — the executor sweeps the pass oldest-first next", async () => {
    const repo = "state-vector/lane-burst-inc";
    await acquire(repo, "gw-inc", { required_workflows: ["Test"], burst_max: 10 });
    const c1 = await queueViaAccept({ repo, pr: 5301, head: "1".repeat(40) });
    const c2 = await queueViaAccept({ repo, pr: 5302, head: "2".repeat(40) });
    const M1 = "3".repeat(40), M2 = "4".repeat(40);
    await kbJson("/train.event", { repo, base: "main", kind: "merged", actor: "gw-inc", pr: 5301, merge_sha: M1, head_sha: "1".repeat(40), task_id: c1, burst_merged: 1, burst_cap: 10 });
    await kbJson("/train.event", { repo, base: "main", kind: "merged", actor: "gw-inc", pr: 5302, merge_sha: M2, head_sha: "2".repeat(40), task_id: c2, burst_merged: 2, burst_cap: 10, burst_settling: true });
    const ci = await kbJson("/train.ci", { repo, base: "main", actor: "gw-inc", sha: M2, checks: [check(74, "Test", "failure")] });
    expect(ci.body.decided).toBe("stopped");
    // probes dispatched, stalled past the CI bound, re-runs inconclusive →
    // the executor stamps it; no culprit is named, nothing bounces
    const b = await kbJson("/train.bisect", { repo, base: "main", actor: "gw-inc", step: { sha: M1, verdict: "inconclusive" }, inconclusive: true });
    expect(b.body.error ?? "", JSON.stringify(b.body)).toBe("");
    expect(b.body.stop.bisect.inconclusive).toBe(true);
    expect(b.body.bounced).toBeNull();
    expect(b.body.reparked).toBeNull();
    expect((await kbJson("/get", { id: c1 })).body.status).toBe("blocked");
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-inc" });
  });

  it("BR#5517 bisect override: the walk's true culprit gets the ding, the wrongly stop-named card's episode is pardoned", async () => {
    const repo = "state-vector/lane-ding-pardon";
    await acquire(repo, "gw-pardon", { required_workflows: ["Test"], burst_max: 10 });
    const H1 = "5".repeat(40), H2 = "6".repeat(40);
    const c1 = await queueViaAccept({ repo, pr: 5401, head: H1, title: "IMPL: pardon drill — true culprit" });
    const c2 = await queueViaAccept({ repo, pr: 5402, head: H2, title: "IMPL: pardon drill — stop-named final" });
    // distinct impl legs on the two cards (version receipts = the blame source)
    await kbJson("/progress.log", {
      id: c1, actor: "impl-true-ding",
      note: "true culprit session — bisect drill progress note",
      completion_pct: 30, confidence_pct: 70, risk_pct: 20,
    });
    await kbJson("/progress.log", {
      id: c2, actor: "impl-stop-ding",
      note: "stop-named final session — bisect drill progress note",
      completion_pct: 30, confidence_pct: 70, risk_pct: 20,
    });
    const M1 = "a".repeat(40), M2 = "b".repeat(40);
    await kbJson("/train.event", { repo, base: "main", kind: "merged", actor: "gw-pardon", pr: 5401, merge_sha: M1, head_sha: H1, task_id: c1, burst_merged: 1, burst_cap: 10 });
    await kbJson("/train.event", { repo, base: "main", kind: "merged", actor: "gw-pardon", pr: 5402, merge_sha: M2, head_sha: H2, task_id: c2, burst_merged: 2, burst_cap: 10, burst_settling: true });
    // the settle comes back RED on the final sha → the stop blames the FINAL
    // card's sessions (the stop flow's default culprit)
    const ci = await kbJson("/train.ci", { repo, base: "main", actor: "gw-pardon", sha: M2, checks: [check(75, "Test", "failure")] });
    expect(ci.body.decided).toBe("stopped");
    const rowIn = (agents: any[], label: string) => agents.find((a: any) => a.label === label);
    const afterStop = (await kbJson("/board")).body.agents as any[];
    expect(rowIn(afterStop, "impl-stop-ding")?.train_red).toBe(1);
    expect(rowIn(afterStop, "impl-true-ding")?.train_red).toBe(0);

    // the walk probes M1 → RED → c1 is THE culprit: the final card's episode
    // is pardoned (its ding leaves the board) and c1's sessions are dinged
    const bisect = await kbJson("/train.bisect", {
      repo, base: "main", actor: "gw-pardon",
      step: { sha: M1, verdict: "red" }, culprit_task: c1, culprit_sha: M1,
    });
    expect(bisect.body.error ?? "", JSON.stringify(bisect.body)).toBe("");
    expect(bisect.body.bounced).toBe(c1);
    const afterWalk = (await kbJson("/board")).body.agents as any[];
    const stopRow = rowIn(afterWalk, "impl-stop-ding");
    expect(stopRow?.train_red).toBe(0);
    expect(stopRow.hints.join(" ")).not.toMatch(/stop-the-line episode/);
    const trueRow = rowIn(afterWalk, "impl-true-ding");
    expect(trueRow?.train_red).toBe(1);
    expect(trueRow.hints.join(" ")).toMatch(/stop-the-line episode/);
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-pardon" });
  });

  it("BR#4934 settle-window rebase: train.carry appends the verdict-carry chain (contiguity enforced, gaps fail loud)", async () => {
    const repo = "state-vector/lane-carry";
    await acquire(repo, "gw-carry", {});
    const H = "5".repeat(40);
    const card = await queueViaAccept({ repo, pr: 5401, head: H, title: "IMPL: settle-window carry drill" });
    const H2 = "6".repeat(40);
    // the executor ran gh pr update-branch during the settle wait — the carry
    // rides the leg so the accepted verdict covers the moved head (BR#3516 §5)
    const carry = await kbJson("/train.carry", { repo, base: "main", actor: "gw-carry", pr: 5401, from_head: H, to_head: H2 });
    expect(carry.body.error ?? "", JSON.stringify(carry.body)).toBe("");
    expect(carry.body.task).toBe(card);
    const cm = (await kbJson("/get", { id: card })).body.meta;
    const leg = cm.pr;
    expect(leg.carry?.[0]?.from_head).toBe(H);
    expect(leg.carry?.[0]?.to_head).toBe(H2);
    expect(leg.carry?.[0]?.via).toBe("update-branch");
    // a gap fails LOUD — carries append contiguously or not at all
    const gap = await kbJson("/train.carry", { repo, base: "main", actor: "gw-carry", pr: 5401, from_head: "7".repeat(40), to_head: "8".repeat(40) });
    expect(gap.status).toBeGreaterThanOrEqual(400);
    expect(String(gap.body.error)).toContain("contiguously");
    // a no-op carry (nothing moved) fails too
    const noop = await kbJson("/train.carry", { repo, base: "main", actor: "gw-carry", pr: 5401, from_head: H2, to_head: H2 });
    expect(noop.status).toBeGreaterThanOrEqual(400);
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-carry" });
  });
});

describe("BR#4977 lane lifecycle + queue base scoping", () => {
  it("a retired (done) lane card is frozen — the tick refuses it, its meta never moves, train_status shows it retired with an empty queue", async () => {
    const repo = "state-vector/retire-lane";
    // create + exercise the lane normally first (the card exists, blocked)
    const a = await acquire(repo, "gw-retire", { merge_capable: true });
    expect(a.body.error ?? "").toBe("");
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-retire" });
    const laneCard: string = (await laneSnap(repo)).card;
    const before = (await kbJson("/get", { id: laneCard })).body.meta;
    expect(before.lane.last_lease_ts).toBeGreaterThan(0);

    // retire it (the BR#4772 drill-residue shape: base deleted, card closed
    // — via the legal lifecycle edges, exactly how that card was retired)
    const t1 = await kbJson("/transition", { id: laneCard, to: "in_progress", actor: "drill", session: "drill", note: "retiring the drill lane" });
    expect(t1.status, `claim failed: ${JSON.stringify(t1.body)}`).toBeLessThan(400);
    // BR#5151: the close is web-authoritative now — a self-close by the
    // claiming session is exactly the BR#5050 shape and is refused
    const t = await kbJson("/transition", { id: laneCard, to: "done", actor: "web:drill", session: "drill", note: "DRILL RESIDUE — lane retired, will never tick again" });
    expect(t.status, `retire transition failed: ${JSON.stringify(t.body)}`).toBeLessThan(400);

    // the tick refuses — acquire/renew/release all bounce, and the lane's
    // meta is FROZEN (no lease/CPO writes on a "never tick again" card)
    const reArm = await acquire(repo, "gw-zombie", { merge_capable: true });
    expect(String(reArm.body.error ?? "")).toContain("lane retired");
    const after = (await kbJson("/get", { id: laneCard })).body.meta;
    expect(after.lane.last_lease_ts).toBe(before.lane.last_lease_ts);
    expect(after.lane.last_capable_lease_ts).toBe(before.lane.last_capable_lease_ts);
    const renewal = await kbJson("/train.lease", { repo, base: "main", action: "renew", actor: "gw-zombie" });
    expect(String(renewal.body.error ?? "")).toContain("lane retired");

    // the snapshot shows the lane VISIBLY retired — empty queue, retired
    // flag, the reason names it (never a phantom "ready" again)
    const snap = await laneSnap(repo);
    expect(snap.retired).toBe(true);
    expect(snap.queue).toEqual([]);
    expect(String(snap.reason)).toContain("retired");
  });

  it("the derived queue is base-scoped — a second lane on the same repo never inherits the other base's queue", async () => {
    const repo = "state-vector/base-split";
    const H1 = "1".repeat(40), H2 = "2".repeat(40);
    const mainCard = await queueViaAccept({ repo, pr: 49771, head: H1, title: "IMPL: main-base drill" });
    const releaseCard = await queueViaAccept({ repo, pr: 49772, head: H2, title: "IMPL: release-base drill" });

    // re-target the second card to a release base (the stamp carries base;
    // verify accepts on a non-main PR would stamp it the same way)
    const rc = (await kbJson("/get", { id: releaseCard })).body;
    const m = rc.meta;
    m.pr.base = "release/1";
    if (Array.isArray(m.prs)) m.prs = m.prs.map((l: any) => (Number(l.number) === 49772 ? { ...l, base: "release/1" } : l));
    expect((await kbJson("/update", { id: releaseCard, meta: m })).status).toBeLessThan(400);

    // a lane for the release base exists (created on demand like any lane)
    const rl = await kbJson("/train.lane", { repo, base: "release/1", actor: "drill" });
    expect(rl.body.error ?? "").toBe("");

    const st = await kbJson("/train.status", { repo });
    const mainLane = st.body.lanes.find((l: any) => l.lane === `${repo}@main`);
    const releaseLane = st.body.lanes.find((l: any) => l.lane === `${repo}@release/1`);
    expect(mainLane.queue.map((c: any) => c.id)).toEqual([mainCard]);
    expect(releaseLane.queue.map((c: any) => c.id)).toEqual([releaseCard]);
    // the retired-drill noise class: the main lane's queue is NOT inherited
    // by the second base (and vice versa) on the same repo
    expect(mainLane.queue.map((c: any) => c.id)).not.toContain(releaseCard);
    expect(releaseLane.queue.map((c: any) => c.id)).not.toContain(mainCard);
  });
});

// ---------- BR#5061: lane revival — the terminal-bind outage ----------
// The incident (2026-10-29): a duty session closed the state-vector/bridge@main
// lane card done as a close-reflex ⇒ the card retired (BR#4977) ⇒ the tick's
// find-or-create kept binding the TERMINAL card every cycle while the reseed
// card was never adopted; the awaiting-CI merge wedged on the dead card. These
// drills pin: terminal cards never bind (supersedes-edge rebind + create-fresh
// inheritance + volatile-state migration), one row per lane in train.status,
// close-protection on infra cards, the phantom-required landing (Ray ruling
// 2026-10-30: "the train goes regardless"), the stopped-storm dedupe, and the
// starved-since epoch fix.

describe("BR#5061 lane revival (real bundled worker)", () => {
  it("a terminal lane card never binds: rebind follows the supersedes edge, migrates awaiting-CI, and the merge LANDS on the live card", async () => {
    const repo = "state-vector/lane-revive";
    await acquire(repo, "gw-rv", { required_workflows: ["Test"] });
    const dead = await laneSnap(repo);
    const deadCard: string = dead.card;

    // in-flight merge on the soon-to-be-terminal card (the PR #328 shape)
    const HEAD = "1".repeat(40);
    const card = await queueViaAccept({ repo, pr: 50611, head: HEAD, title: "IMPL: revival drill" });
    const M = "2".repeat(40);
    const merged = await kbJson("/train.event", {
      repo, base: "main", kind: "merged", actor: "gw-rv",
      pr: 50611, merge_sha: M, head_sha: HEAD, task_id: card,
      merged_at: Date.now() - 10 * 60_000,
    });
    expect(merged.body.error ?? "").toBe("");

    // the incident: the lane card goes terminal WHILE holding awaiting-CI
    // (here via the legitimate retirement path — web/human, on the parked
    // card's one drop edge blocked→superseded; close-protection pins the
    // agent path separately below)
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-rv" });
    const closed = await kbJson("/transition", { id: deadCard, to: "superseded", actor: "web:drill", note: "drill: erroneous close of a live lane (the BR#5061 incident shape)" });
    expect(closed.status).toBeLessThan(400);

    // the reseed: a live card carrying the same lane key, supersedes-linked
    const reseed = await kbJson("/create", {
      type: "task",
      title: `Merge lane: ${repo}@main (v2 — reseed drill)`,
      meta: { lane: { repo, base: "main", required_workflows: ["Test"], key: `${repo}@main` }, lease: null, currently: null, stop: null },
      tags: ["merge-train", "infrastructure"],
      session: "",
    });
    const reseedId = String(reseed.body.id);
    await kbJson("/link", { src: reseedId, relation: "supersedes", dst: deadCard });
    await kbJson("/transition", { id: reseedId, to: "blocked", actor: "web:drill", note: "merge-train: awaiting an available gateway", unblock_condition: "the train advances this card — run bridge train on a gateway (doctor-gated)" });

    // the next executor op rebinds: acquire binds the RESEED, the volatile
    // awaiting-CI migrates off the terminal card, train.status shows ONE row
    const a = await acquire(repo, "gw-rv2", { merge_capable: true });
    expect(a.body.error ?? "").toBe("");
    const live = await laneSnap(repo);
    expect(live.card).toBe(reseedId);
    expect(live.currently?.pr).toBe(50611);
    expect(live.currently?.merge_sha).toBe(M);
    const rows = (await kbJson("/train.status", { repo })).body.lanes.filter((l: any) => l.lane === `${repo}@main`);
    expect(rows.length).toBe(1);
    // the terminal card's volatile state is GONE (migrated, not copied)
    const deadMeta = (await kbJson("/get", { id: deadCard })).body.meta;
    expect(deadMeta.currently ?? null).toBeNull();

    // and the wedge cures itself: green CI on the migrated merge lands it
    const ci = await kbJson("/train.ci", { repo, base: "main", actor: "gw-rv2", sha: M, checks: [check(1, "Test", "success")] });
    expect(ci.body.decided).toBe("landed");
    expect((await kbJson("/get", { id: card })).body.status).toBe("done");
    expect((await laneSnap(repo)).currently).toBeNull();
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-rv2" });
  });

  it("no successor registered: the BR#4977 retirement refusal holds — ops refuse 'lane retired', meta frozen (BR#5061's create-fresh clause is superseded by the accepted decision on this path)", async () => {
    const repo = "state-vector/lane-fresh";
    await acquire(repo, "gw-fr", { required_workflows: ["Test", "CLI build (packages/cli)"], ci_typical_minutes: 17 });
    const old = await laneSnap(repo);
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-fr" });
    await kbJson("/transition", { id: old.card, to: "in_progress", actor: "gw-fr", note: "drill: claiming to retire" });
    const closed = await kbJson("/transition", { id: old.card, to: "done", actor: "web:drill", note: "drill: deliberate retirement via web — no reseed registered (BR#5151: owner identity no longer closes standing cards)" });
    expect(closed.status).toBeLessThan(400);

    // every lane op refuses — the lane is deliberately retired, no
    // auto-resurrection, and the terminal card's meta never moves
    const refused = await acquire(repo, "gw-fr2", {});
    expect(String(refused.body.error ?? "")).toContain("lane retired");
    expect(String(refused.body.error ?? "")).toContain("reseed");
    // …and the panel still shows the lane, VISIBLY retired, one row
    const rows = (await kbJson("/train.status", { repo })).body.lanes.filter((l: any) => l.lane === `${repo}@main`);
    expect(rows.length).toBe(1);
    expect(rows[0].retired).toBe(true);
    expect(rows[0].queue).toEqual([]);
  });

  it("close-protection: an agent/duty cannot done or supersede a lane/infra card — NAMED rejection; web retires it fine", async () => {
    const repo = "state-vector/lane-guard";
    await acquire(repo, "gw-gd", {});
    const lane = await laneSnap(repo);
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-gd" });

    // the 2026-10-29 misfire class: a duty session closing the lane card.
    // Lifecycle-legal edge: claim (blocked→in_progress) then done — the
    // guard must catch the reflex regardless of which legal edge it takes.
    const claimed = await kbJson("/transition", { id: lane.card, to: "in_progress", actor: "gw-gd", note: "drill: gateway holds the lane" });
    expect(claimed.status).toBeLessThan(400);
    const refused = await kbJson("/transition", { id: lane.card, to: "done", actor: "duty-BR-drill", note: "subject landed — closing" });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(String(refused.body.error)).toContain("infrastructure/merge-train lane card");
    expect(String(refused.body.error)).toContain("BR#5061");
    expect((await kbJson("/get", { id: lane.card })).body.status).toBe("in_progress");

    // a bare infrastructure-tagged task (no meta.lane) is guarded the same way
    const infra = await kbJson("/create", { type: "task", title: "INFRA drill card — standing subsystem", tags: ["infrastructure"], session: "" });
    const claimed2 = await kbJson("/transition", { id: String(infra.body.id), to: "in_progress", actor: "duty-BR-drill", note: "drill: duty claims the infra card" });
    expect(claimed2.status).toBeLessThan(400);
    const refused2 = await kbJson("/transition", { id: String(infra.body.id), to: "done", actor: "another-duty-BR-drill", note: "closing infra by reflex" });
    expect(refused2.status).toBeGreaterThanOrEqual(400);
    expect(String(refused2.body.error)).toContain("infrastructure");

    // BR#5151: ownership is NO LONGER a close path for standing cards — the
    // BR#5050 incident was the owner-actor daemon closing its own lane via
    // the old owner-identity exemption. Same named rejection, no close.
    const okOwner = await kbJson("/transition", { id: String(infra.body.id), to: "done", actor: "duty-BR-drill", note: "owner closes own infra card — receipts: drill" });
    expect(okOwner.status).toBeGreaterThanOrEqual(400);
    expect(String(okOwner.body.error)).toContain("infrastructure/merge-train lane card");
    expect(String(okOwner.body.error)).toContain("BR#5151");

    // humans retire lanes fine (web/human actors are exempt — the recovery
    // lever this incident needed)
    const ok1 = await kbJson("/transition", { id: lane.card, to: "done", actor: "web:ray", note: "deliberate retirement — drill" });
    expect(ok1.status).toBeLessThan(400);
  });

  it("phantom-required past the bound LANDS on the workflows that exist + files the config-defect ask (Ray 2026-10-30); observed-stuck keeps the stop", async () => {
    const sink = await kbJson("/create", { type: "task", title: "ALARM SINK drill — phantom required", session: "" });
    await kbJson("/admin.settings_set", { settings: { train_alarm_sink_id: String(sink.body.id) } });

    // (a) the live-wedge shape: main-green gate is PR-context-only — it
    // NEVER produces a check run on the merge commit, so the verdict can
    // never go green and the old code stopped the line every tick
    const repo = "state-vector/lane-phantom";
    await acquire(repo, "gw-ph", { required_workflows: ["Test", "CLI build (packages/cli)", "main-green gate"] });
    const HEAD = "3".repeat(40);
    const card = await queueViaAccept({ repo, pr: 50612, head: HEAD, title: "IMPL: phantom drill" });
    const M = "4".repeat(40);
    await kbJson("/train.event", {
      repo, base: "main", kind: "merged", actor: "gw-ph",
      pr: 50612, merge_sha: M, head_sha: HEAD, task_id: card,
      merged_at: Date.now() - 90 * 60_000, // 90m — past the 3×20m bound
    });
    // commit-level checks: Test + CLI green, main-green gate ABSENT (it only
    // runs on pull_request) — exactly the b346e772d shape
    const ci = await kbJson("/train.ci", { repo, base: "main", actor: "gw-ph", sha: M, checks: [check(1, "Test", "success"), check(2, "CLI build (packages/cli)", "success")] });
    expect(ci.body.decided).toBe("landed_phantom_required");
    expect(ci.body.dropped_required).toEqual(["main-green gate"]);
    expect((await kbJson("/get", { id: card })).body.status).toBe("done");
    expect((await laneSnap(repo)).currently).toBeNull();
    const asks = await kbJson("/search?q=Lane config defect&limit=50");
    const mine = asks.body.artefacts.filter((x: any) => x.type === "question" && String(x.title).includes(`${repo}@main`));
    expect(mine.length).toBe(1);
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-ph" });

    // (b) a genuinely stuck OBSERVED run (check exists, never concluded)
    // keeps the fail-closed stop — the phantom carve-out does not swallow it
    const repo2 = "state-vector/lane-stuckrun";
    await acquire(repo2, "gw-st", { required_workflows: ["Test"] });
    const HEAD2 = "5".repeat(40);
    const card2 = await queueViaAccept({ repo: repo2, pr: 50613, head: HEAD2, title: "IMPL: stuck-run drill" });
    const M2 = "6".repeat(40);
    await kbJson("/train.event", {
      repo: repo2, base: "main", kind: "merged", actor: "gw-st",
      pr: 50613, merge_sha: M2, head_sha: HEAD2, task_id: card2,
      merged_at: Date.now() - 90 * 60_000,
    });
    const ci2 = await kbJson("/train.ci", { repo: repo2, base: "main", actor: "gw-st", sha: M2, checks: [check(3, "Test", null)] });
    expect(ci2.body.decided).toBe("stopped_bound");
    await kbJson("/train.lease", { repo: repo2, base: "main", action: "release", actor: "gw-st", line_green: true });
  });

  it("the SAME stop re-reported by a tick loop is ONE ledger episode (no stopped-storm)", async () => {
    const repo = "state-vector/lane-storm";
    await acquire(repo, "gw-sm", {});
    const HEAD = "7".repeat(40);
    await queueViaAccept({ repo, pr: 50614, head: HEAD, title: "IMPL: storm drill" });
    const M = "8".repeat(40);
    await kbJson("/train.event", {
      repo, base: "main", kind: "merged", actor: "gw-sm",
      pr: 50614, merge_sha: M, head_sha: HEAD,
      merged_at: Date.now() - 90 * 60_000,
    });
    const stop1 = await kbJson("/train.event", {
      repo, base: "main", kind: "stopped", actor: "gw-sm", pr: 50614, merge_sha: M,
      reason: "CI unknown past the fail-closed bound (~3× typical)",
    });
    expect(stop1.body.deduped ?? false).toBe(false);
    // the tick loop re-fires the identical stop (the storm shape: ~2/min)
    for (let i = 0; i < 5; i++) {
      const again = await kbJson("/train.event", {
        repo, base: "main", kind: "stopped", actor: "gw-sm", pr: 50614, merge_sha: M,
        reason: "CI unknown past the fail-closed bound (~3× typical)",
      });
      expect(again.body.deduped).toBe(true);
    }
    // NB: GET /train.history carries no body — the repo/kind filters are
    // request-body params — so filter client-side
    const hist = await kbJson(`/train.history`);
    const stops = hist.body.events.filter((e: any) => e.kind === "stopped" && e.repo === repo);
    if (stops.length !== 1) for (const e of stops) console.log("STORM-ROW", e.seq, e.gateway, e.pr, JSON.stringify(e.detail).slice(0, 120));
    expect(stops.length).toBe(1);
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-sm", line_green: true });
  });

  it("starved_since never inits from epoch — a never-capable lane with a queue reports NOT starved until its own clock ages", async () => {
    const repo = "state-vector/lane-epoch";
    // fresh lane card (blocked at birth — status_ts ≈ now), NO capable lease
    // ever recorded, then a queued card: the OLD code computed starve minutes
    // off epoch-zero (the "starved 29888714m" alarm class, BR#5063)
    await queueViaAccept({ repo, pr: 50615, head: "9".repeat(40), title: "IMPL: epoch drill" });
    const lane = await laneSnap(repo);
    expect(lane.queue.length).toBeGreaterThan(0);
    expect(lane.last_capable_lease_ts ?? null).toBeNull();
    expect(lane.starved).toBeNull();
  });
});

// ---------- BR#5114: NOW / NEXT / QUEUE — the progress seam + queue PRs ----------
// The panel restructure needs two hub facts: the lease holder's live last
// action (BR#4104 put it on every renewal; the hub discarded it — "consuming
// it is the filed follow-up") and the derived queue entries naming their PRs
// ("card · #pr", not a bare id). These drills pin both.

describe("BR#5114 NOW/NEXT/QUEUE — progress seam + queue PRs (real bundled worker)", () => {
  it("a renewal carrying proof-of-progress stamps meta.lane.now_action — train.status surfaces it and the queue entries name their PRs", async () => {
    const repo = "state-vector/lane-now";
    await acquire(repo, "gw-now", { merge_capable: true, required_workflows: ["Test"] });
    const card = await queueViaAccept({ repo, pr: 51141, head: "b".repeat(40), title: "IMPL: now-line drill" });

    // the executor gates the head, holds, and renews carrying its last
    // action (the exact BR#4104 wire shape train.rs sends every tick)
    const ren = await kbJson("/train.lease", {
      repo, base: "main", action: "renew", actor: "gw-now", merge_capable: true,
      progress: { progress: `PR #51141 (${card}): head checks unsettled (Test) — not yet, skip this tick`, progress_age_ms: 1_000, holder: "gw-now" },
    });
    expect(ren.body.error ?? "", `renew failed: ${JSON.stringify(ren.body)}`).toBe("");

    // the snapshot carries BOTH new facts for the panel
    const st = await kbJson("/train.status", { repo });
    const lane = st.body.lanes[0];
    expect(lane.now_action?.note).toContain("head checks unsettled");
    expect(lane.now_action?.holder).toBe("gw-now");
    expect(typeof lane.now_action?.at).toBe("number");
    expect(lane.queue.length).toBeGreaterThan(0);
    expect(lane.queue[0].id).toBe(card);
    expect(lane.queue[0].pr).toBe(51141);

    // persisted on the lane card (laneSyncReason only writes on reason
    // CHANGE — the stamp needs its own persist, the stale-snapshot trap)
    const meta = (await kbJson("/get", { id: lane.card })).body.meta;
    expect(meta.lane.now_action?.note).toContain("head checks unsettled");

    // a SECOND renewal with a different note refreshes the NOW line in place
    await kbJson("/train.lease", {
      repo, base: "main", action: "renew", actor: "gw-now", merge_capable: true,
      progress: { progress: "CI poll on ccccccccc: pending (Test)", progress_age_ms: 1_000, holder: "gw-now" },
    });
    const lane2 = (await kbJson("/train.status", { repo })).body.lanes[0];
    expect(lane2.now_action?.note).toContain("CI poll on ccccccccc");
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-now" });
  });

  it("a bounced head reads as awaiting-review in plain words, and the queue counts how many wait on reviews (the 0/h story)", async () => {
    const repo = "state-vector/lane-plain";
    await acquire(repo, "gw-plain", { merge_capable: true, required_workflows: ["Test"] });
    const H1 = "c".repeat(40), H2 = "d".repeat(40);
    const card1 = await queueViaAccept({ repo, pr: 51143, head: H1, title: "IMPL: plain drill 1" });
    const card2 = await queueViaAccept({ repo, pr: 51144, head: H2, title: "IMPL: plain drill 2" });

    // queued fresh: the head reads merge-checks, nothing awaits review
    let lane = (await kbJson("/train.status", { repo })).body.lanes[0];
    expect(lane.attempt).toMatchObject({ card: card1, hold: "merge-checks" });
    expect(lane.queue_awaiting_review).toBe(0);

    // the head bounces (a plain coverage lapse at an uncovered head — the
    // verdict no longer covers the moved head, no human leg): its hold flips
    // to awaiting-review and the reason speaks human: no "gate", no
    // "attempting", no jargon
    await kbJson("/train.event", {
      repo, base: "main", kind: "bounced", actor: "gw-plain", pr: 51143, task_id: card1,
      head_sha: "e".repeat(40), bounce_kind: "coverage",
      reason: "PR #51143 live head is not covered by the accepted verdict — re-verify at the new head",
    });
    // the bounced card LEAVES the queue for its review (in_progress) — the
    // next card becomes the head, and the bounced one counts as awaiting a
    // review OUTSIDE the queue: the "0/h with a full queue" story
    lane = (await kbJson("/train.status", { repo })).body.lanes[0];
    expect(lane.attempt.card).toBe(card2);
    expect(lane.attempt.hold).toBe("merge-checks");
    expect(String(lane.reason)).not.toContain("(gate)");
    expect(lane.queue.length).toBe(1);
    expect(lane.queue_awaiting_review).toBe(1);
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-plain" });
  });

  // BR#5677 (census BR#5634): the merge_train stamp is never cleaned on
  // close, so a done/superseded card on a merged PR keeps its stale
  // `bounced`/`awaiting` state forever — counting every stamp holder
  // inflated queue_awaiting_review with zombies (the census decode: 24
  // "awaiting review" against a handful of live parks).
  it("queue_awaiting_review counts LIVE cards only — a closed card's stale bounce stamp stays out of the count", async () => {
    const repo = "state-vector/lane-stale-stamp";
    const acq = await acquire(repo, "gw-stale", { merge_capable: true, required_workflows: ["Test"] });
    expect(acq.body.error ?? "", `acquire failed: ${JSON.stringify(acq.body)}`).toBe("");
    const card = await queueViaAccept({ repo, pr: 51147, head: "9".repeat(40), title: "IMPL: zombie-stamp drill" });

    // the head bounces (coverage lapse at an uncovered head) — the card
    // leaves the queue for its review (in_progress) and counts as awaiting
    const bounced = await kbJson("/train.event", {
      repo, base: "main", kind: "bounced", actor: "gw-stale", pr: 51147, task_id: card,
      head_sha: "8".repeat(40), bounce_kind: "coverage",
      reason: "PR #51147 live head is not covered by the accepted verdict — re-verify at the new head",
    });
    expect(bounced.body.error ?? "", `bounce failed: ${JSON.stringify(bounced.body)}`).toBe("");
    let lane = await laneSnap(repo);
    expect(lane.queue_awaiting_review).toBe(1);

    // the card finishes and closes done — the bounce stamp survives the
    // close (stamps are records, not liveness), but the zombie must not
    // keep counting
    const closed = await kbJson("/transition", { id: card, to: "done", actor: "drill", note: "drill: landed out-of-band — closing (BR#5677 zombie drill)" });
    expect(closed.status, `zombie close failed: ${JSON.stringify(closed.body)}`).toBeLessThan(400);
    const after = (await kbJson("/get", { id: card })).body;
    expect(after.status).toBe("done");
    expect(after.meta?.merge_train?.state).toBe("bounced"); // the stale stamp is still there
    lane = await laneSnap(repo);
    expect(lane.queue_awaiting_review).toBe(0); // …but it no longer counts
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-stale" });
  });

  it("train.queue_facts stamps the executor's per-entry walk verdicts — train.status serves them in walk order (the queue block row)", async () => {
    const repo = "state-vector/lane-qf";
    await acquire(repo, "gw-qf", { merge_capable: true, required_workflows: ["Test"] });
    const c1 = await queueViaAccept({ repo, pr: 51145, head: "e".repeat(40), title: "IMPL: qf drill 1" });
    const c2 = await queueViaAccept({ repo, pr: 51146, head: "f".repeat(40), title: "IMPL: qf drill 2" });

    // the lease-holder stamps what its walk decided, in rank order
    const r = await kbJson("/train.queue_facts", {
      repo, base: "main", actor: "gw-qf",
      entries: [
        { id: c1, pr: 51145, cls: "ready" },
        { id: c2, pr: 51146, cls: "waiting" },
      ],
    });
    expect(r.body.error ?? "").toBe("");
    const lane = (await kbJson("/train.status", { repo })).body.lanes[0];
    expect(lane.queue_facts.entries.map((e: any) => [e.id, e.cls])).toEqual([[c1, "ready"], [c2, "waiting"]]);
    // a NON-holder cannot stamp (executor-fed facts only)
    const no = await kbJson("/train.queue_facts", { repo, base: "main", actor: "gw-other", entries: [{ id: c1, cls: "ready" }] });
    expect(no.status).toBeGreaterThanOrEqual(400);
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-qf" });
  });

  it("BR#5265 Fix A+B (+ BR#5631 warrant gate): base_state rides the walk stamp — a RED base holding cars renders the lane BLOCKED (loud, red names) and files NO human ask while the episode is agent-workable (no cure PR, not exhausted); a GREEN base restores the normal vocabulary", async () => {
    const repo = "state-vector/lane-base-red";
    await acquire(repo, "gw-br", { merge_capable: true, required_workflows: ["Test"] });
    // NOTE (BR#5631 drill hygiene): the held cards' titles must stay OUT of
    // the fix-shape family (\bfix\b|main-green|gate|stop-the-line|\bred\b|ci|
    // deploy health) or the queue-entry fallback binds them as the cure and
    // the warrant gate (correctly) files the ask — "held drill" wording.
    const c1 = await queueViaAccept({ repo, pr: 52651, head: "a".repeat(40), title: "IMPL: held drill alpha" });
    const c2 = await queueViaAccept({ repo, pr: 52652, head: "b".repeat(40), title: "IMPL: held drill beta" });

    // RED base (scoped to the lane's required workflows, Fix B) holding 2
    // cars: stamped whole-of-row, the lane renders the loud BLOCKED line
    const r = await kbJson("/train.queue_facts", {
      repo, base: "main", actor: "gw-br",
      entries: [
        { id: c1, pr: 52651, cls: "waiting" },
        { id: c2, pr: 52652, cls: "waiting" },
      ],
      base_state: { verdict: "red", scoped_to_required: true, red: [{ name: "Test", url: "https://example.test/1" }], unsettled: [] },
    });
    expect(r.body.error ?? "").toBe("");
    const lane = (await kbJson("/train.status", { repo })).body.lanes[0];
    expect(lane.queue_facts.base_state.verdict).toBe("red");
    expect(lane.queue_facts.base_state.red[0].name).toBe("Test");
    expect(lane.reason).toContain("merge-train: BLOCKED — base main RED: Test");
    expect(lane.reason).toContain("2 car(s) held");

    // 2026-11-03 (BR#5631): NO ask on an agent-workable red — no cure PR is
    // bound and the fix path is not exhausted. The machinery carries the
    // episode (lane BLOCKED reason + banner); the human is not asked to
    // click "keep going". Per-tick repeats stay ask-free identically.
    const askCount = async () =>
      (await kbJson("/search?q=MERGE+TRAIN+BLOCKED&type=question&limit=50")).body.artefacts.filter(
        (x: any) => x.type === "question" && String(x.title).startsWith("MERGE TRAIN BLOCKED: base ") && String(x.title).includes(`${repo}@main`),
      ).length;
    expect(await askCount()).toBe(0);
    await kbJson("/train.queue_facts", {
      repo, base: "main", actor: "gw-br",
      entries: [{ id: c1, pr: 52651, cls: "waiting" }],
      base_state: { verdict: "red", red: [{ name: "Test" }] },
    });
    expect(await askCount()).toBe(0);

    // GREEN base: the normal lane vocabulary returns (no false BLOCKED) and
    // still no ask exists
    await kbJson("/train.queue_facts", {
      repo, base: "main", actor: "gw-br",
      entries: [
        { id: c1, pr: 52651, cls: "ready" },
        { id: c2, pr: 52652, cls: "ready" },
      ],
      base_state: { verdict: "green", scoped_to_required: true, red: [], unsettled: [] },
    });
    const lane2 = (await kbJson("/train.status", { repo })).body.lanes[0];
    expect(lane2.queue_facts.base_state.verdict).toBe("green");
    expect(lane2.reason).not.toContain("BLOCKED — base main RED");
    expect(await askCount()).toBe(0);
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-br" });
  });

  it("BR#5883: a scoped-GREEN base the repo gate judges red escalates at P1 — the lane reads GATE-BLOCKED (named checks), ONE diagnostic duty + ONE human ask file (per-tick repeats dedupe), and a fresh stamp without the qualifier clears the episode and closes the ask", async () => {
    const repo = "state-vector/lane-gate-blocked";
    // a reachable alarm sink for this episode (the setting overrides BR#3124)
    const sink = await kbJson("/create", { type: "task", title: "ALARM SINK drill — gate-blocked", session: "" });
    await kbJson("/admin.settings_set", { settings: { train_alarm_sink_id: String(sink.body.id) } });
    await acquire(repo, "gw-gb", { merge_capable: true, required_workflows: ["Test"] });
    const c1 = await queueViaAccept({ repo, pr: 58831, head: "e".repeat(40), title: "IMPL: gate-blocked drill alpha" });
    const c2 = await queueViaAccept({ repo, pr: 58832, head: "f".repeat(40), title: "IMPL: gate-blocked drill beta" });

    // the 2026-11-03 starve stamp: verdict GREEN (required set green — the
    // P1 base alarm reads none) + the gate-consumed qualifier naming what
    // main-green-gate.sh reports on the tip
    const stamp = () =>
      kbJson("/train.queue_facts", {
        repo, base: "main", actor: "gw-gb",
        entries: [{ id: c1, pr: 58831, cls: "waiting" }, { id: c2, pr: 58832, cls: "waiting" }],
        base_state: {
          verdict: "green", scoped_to_required: true, red: [], unsettled: [],
          gate_blocked: true, gate_verdict: "red",
          gate_red: [{ name: "Deploy drift alarm", url: "https://example.test/drift" }],
          gate_unsettled: [],
        },
      });
    expect((await stamp()).body.error ?? "").toBe("");

    const lane = (await kbJson("/train.status", { repo })).body.lanes[0];
    expect(lane.queue_facts.base_state.verdict).toBe("green");
    expect(lane.queue_facts.base_state.gate_blocked).toBe(true);
    expect(lane.reason).toContain("merge-train: GATE-BLOCKED");
    expect(lane.reason).toContain("Deploy drift alarm");
    expect(lane.reason).toContain("2 car(s) held");

    // repo-unique tokens: full-KB searches drown in lane-card noise
    const askHits = async () => {
      const all = (await kbJson("/search", { q: "lane-gate-blocked", type: "question", limit: 50 })).body.artefacts;
      return all.filter((x: any) => String(x.title).startsWith("MERGE TRAIN GATE-BLOCKED:") && String(x.title).includes(`${repo}@main`));
    };
    const dutyHits = async () => {
      const all = (await kbJson("/search", { q: "lane-gate-blocked", type: "task", limit: 50 })).body.artefacts;
      return all.filter((x: any) => x.type === "task" && String(x.title).includes("GATE-BLOCKED on ") && String(x.title).includes(`${repo}@main`));
    };
    expect(await askHits()).toHaveLength(0);
    expect((await dutyHits()).length).toBe(1);
    const duty = (await dutyHits())[0];
    expect(String(duty.body_md)).toContain("main-green gate");
    expect(String(duty.body_md)).toContain("Deploy drift alarm");

    // per-tick repeats dedupe — ONE ask, ONE duty
    expect((await stamp()).body.error ?? "").toBe("");
    expect(await askHits()).toHaveLength(0);
    expect((await dutyHits()).length).toBe(1);

    // fresh stamp WITHOUT the qualifier: episode clears, ask auto-closes,
    // the normal vocabulary returns
    await kbJson("/train.queue_facts", {
      repo, base: "main", actor: "gw-gb",
      entries: [{ id: c1, pr: 58831, cls: "ready" }, { id: c2, pr: 58832, cls: "ready" }],
      base_state: { verdict: "green", scoped_to_required: true, red: [], unsettled: [] },
    });
    const lane2 = (await kbJson("/train.status", { repo })).body.lanes[0];
    expect(lane2.reason).not.toContain("GATE-BLOCKED");
    const asksAfter = await askHits();
    expect(asksAfter.length).toBe(0);
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-gb" });
  });

  it("BR#5349 (+ BR#5631): a non-green base holding cars serves base_red_resolution on train.status — whats_broken + held + ask:null while agent-workable (no action demanded of the human) + the lane's OPEN hotfix+main-red fix card; green drops the block (the banner's own off-switch)", async () => {
    const repo = "state-vector/lane-brr";
    await acquire(repo, "gw-brr", { merge_capable: true, required_workflows: ["Test"] });
    const c1 = await queueViaAccept({ repo, pr: 53491, head: "c".repeat(40), title: "IMPL: brr drill 1" });
    const c2 = await queueViaAccept({ repo, pr: 53492, head: "d".repeat(40), title: "IMPL: brr drill 2" });

    // RED base holding 2 cars — the walk stamp (which also files the
    // ONE-per-episode alarm ask, BR#5265) is the resolution's data source
    const r = await kbJson("/train.queue_facts", {
      repo, base: "main", actor: "gw-brr",
      entries: [ { id: c1, pr: 53491, cls: "waiting" }, { id: c2, pr: 53492, cls: "waiting" } ],
      base_state: { verdict: "red", scoped_to_required: true, red: [{ name: "Test", url: "https://example.test/5349" }], unsettled: [] },
    });
    expect(r.body.error ?? "").toBe("");

    // the RESOLUTION rides the lane snapshot, plain and complete
    const lane = (await kbJson("/train.status", { repo })).body.lanes[0];
    const brr = lane.base_red_resolution;
    // 2026-11-03 (BR#5631): the episode is agent-workable (no cure PR, not
    // exhausted) → NO ask exists at all; the banner carries the information
    // (what's broken, PRs held, fix card) with ask:null — nothing demanded
    // of the human. The bypass ask files later, warranted, once a cure PR
    // binds (next drill).
    expect(brr).toBeTruthy();
    expect(brr.verdict).toBe("red");
    expect(brr.whats_broken).toEqual([{ name: "Test", url: "https://example.test/5349" }]);
    expect(brr.held).toBe(2);
    expect(brr.ask).toBeNull();
    const asks5349 = (await kbJson("/search", { q: "lane-brr", type: "question", limit: 50 })).body.artefacts
      .filter((x: any) => String(x.title).startsWith("MERGE TRAIN BLOCKED: base ") && String(x.title).includes(`${repo}@main`));
    expect(asks5349.length).toBe(0);
    // no fix card yet → null, never a lie
    expect(brr.fix_card).toBeNull();

    // an OPEN hotfix+main-red task in the LANE CARD's project becomes the fix card
    const laneProject = String((await kbJson("/get", { id: lane.card })).body.project ?? "");
    expect(laneProject).not.toBe("");
    const fix = await kbJson("/create", { type: "task", title: "HOTFIX P0: fix main red (brr drill)", tags: ["hotfix", "main-red", "p0"], project: laneProject, body_md: "drill fix card" });
    expect(fix.status).toBe(200);
    const lane2 = (await kbJson("/train.status", { repo })).body.lanes[0];
    expect(lane2.base_red_resolution.fix_card).toBeTruthy();
    expect(lane2.base_red_resolution.fix_card.id).toBe(fix.body.id);
    expect(lane2.base_red_resolution.fix_card.status).toBe("todo");
    expect(lane2.base_red_resolution.fix_card.url).toBe(`https://hub.fleetbridge.run/card/${String(fix.body.id).replace("#", "-")}`);

    // GREEN base: the block disappears by itself — the banner never lingers
    await kbJson("/train.queue_facts", {
      repo, base: "main", actor: "gw-brr",
      entries: [ { id: c1, pr: 53491, cls: "ready" }, { id: c2, pr: 53492, cls: "ready" } ],
      base_state: { verdict: "green", scoped_to_required: true, red: [], unsettled: [] },
    });
    const lane3 = (await kbJson("/train.status", { repo })).body.lanes[0];
    expect(lane3.base_red_resolution ?? null).toBeNull();
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-brr" });
  });

  it("2026-11-03 (BR#5631) + 2026-11-02: the base-red ask is WARRANT-GATED then a LIVE TRIAGE VIEW — no ask while the red is agent-workable; a bound cure PR files it (bypass-first, live-refreshed, still ONE); a lapsed warrant closes it; an EXHAUSTED fix path warrants it without a cure", async () => {
    const repo = "state-vector/lane-brr-live";
    // a reachable alarm sink for this episode (the setting overrides BR#3124)
    const sink = await kbJson("/create", { type: "task", title: "ALARM SINK drill — brr-live", session: "" });
    await kbJson("/admin.settings_set", { settings: { train_alarm_sink_id: String(sink.body.id) } });
    await acquire(repo, "gw-brrl", { merge_capable: true, required_workflows: ["Test"] });
    const c1 = await queueViaAccept({ repo, pr: 53495, head: "c".repeat(40), title: "IMPL: brr-live drill 1" });
    const stampRed = () =>
      kbJson("/train.queue_facts", {
        repo, base: "main", actor: "gw-brrl",
        entries: [{ id: c1, pr: 53495, cls: "waiting" }],
        base_state: { verdict: "red", scoped_to_required: true, red: [{ name: "Test", url: "https://example.test/live" }], unsettled: [] },
      });
    expect((await stampRed()).body.error ?? "").toBe("");

    // the ask lives under a repo-unique token — full-KB "MERGE TRAIN BLOCKED"
    // searches drown it in lane-card noise past the limit in a full-file run
    const askHits = async () => {
      const all = (await kbJson("/search", { q: "lane-brr-live", type: "question", limit: 50 })).body.artefacts;
      return all.filter((x: any) => String(x.title).startsWith("MERGE TRAIN BLOCKED: base ") && String(x.title).includes(`${repo}@main`));
    };
    const findAsk = async () => (await askHits()).find((x: any) => x.status === "todo") ?? null;

    // (1) BR#5631 warrant gate: agent-workable red (no fix card, no cure) —
    // NO ask. The machinery carries it; the human is not asked to "keep going"
    expect(await findAsk()).toBeNull();

    // the episode's root-fix card spawns (BR#5190 shape: tags + binding)…
    const fix = await kbJson("/create", {
      type: "task", title: "ROOT-FIX (BR#5189 p0): fix main — live drill", tags: ["root_blocker", "main-red", "p0"],
      project: "superpositional", body_md: "root-fix drill card",
      meta: { root_fix: { repo, head_sha: "a".repeat(40), base: "main", why: "drill", failing: ["Test"], bound_at: Date.now() } },
    });
    expect(fix.status).toBe(200);
    // fix card alone (not exhausted, no cure PR) STILL warrants no ask
    expect((await stampRed()).body.error ?? "").toBe("");
    expect(await findAsk()).toBeNull();

    // …and a cure PR binds to it (the queued leg stamp meta.prs carries) —
    // NOW the episode has a human-actionable act (the out-of-turn bypass
    // merge is human authority, BR#4122) and the ask FILES on the next tick
    await kbJson("/update", { id: fix.body.id, meta: { root_fix: { repo, head_sha: "a".repeat(40), base: "main", why: "drill", failing: ["Test"], bound_at: Date.now() }, prs: [{ repo, number: 53499, head_sha_at_acceptance: "d".repeat(40) }] } });
    expect((await stampRed()).body.error ?? "").toBe("");
    const askCount = async () => (await askHits()).length;
    expect(await askCount()).toBe(1);
    const ask2 = await findAsk();
    expect(ask2).toBeTruthy();
    expect(String(ask2.body_md)).toContain("https://github.com/" + repo + "/pull/53499");
    const askMetaM = typeof ask2.meta === "string" ? JSON.parse(ask2.meta) : ask2.meta ?? {};
    expect(askMetaM.ask.options[0]).toContain("DONE — PR #53499 merged");
    expect(String(askMetaM.ask.reason ?? "")).toContain("human gate");

    // fix_card prefers the root-fix card and carries the cure PR link
    const lane = (await kbJson("/train.status", { repo })).body.lanes[0];
    const fc = lane.base_red_resolution.fix_card;
    expect(fc.id).toBe(fix.body.id);
    expect(fc.pr).toBe(53499);
    expect(fc.pr_url).toBe(`https://github.com/${repo}/pull/53499`);

    // (2) warrant LAPSE: the cure PR unbinds (closed unmerged, nothing
    // re-bound) — the open ask no longer names a human act; the next red
    // tick closes it done, honestly, and it re-files if a cure re-binds
    // (BR#5807: update meta merges per key now — the unbind is an explicit
    // meta_delete, not an omitted-key replace)
    await kbJson("/update", { id: fix.body.id, meta: { root_fix: { repo, head_sha: "a".repeat(40), base: "main", why: "drill", failing: ["Test"], bound_at: Date.now() } }, meta_delete: ["prs"] });
    expect((await stampRed()).body.error ?? "").toBe("");
    const closedAsk = (await askHits()).find((x: any) => x.id === ask2.id);
    expect(closedAsk?.status).toBe("done");
    expect(await findAsk()).toBeNull();
    expect(await askCount()).toBe(1); // still exactly one artefact — closed, not duplicated

    // (3) EXHAUSTION warrant: no cure PR, but the fix card churned out of
    // attempts (attempt.attempts >= 3) — manual steps are the only lever
    // left, so the ask files WITHOUT a cure, manual-first options
    await kbJson("/update", { id: fix.body.id, meta: { root_fix: { repo, head_sha: "a".repeat(40), base: "main", why: "drill", failing: ["Test"], bound_at: Date.now() }, attempt: { by: "system:watchdog", at: Date.now(), attempts: 3, last_reason: "stalled" } } });
    expect((await stampRed()).body.error ?? "").toBe("");
    const ask3 = await findAsk();
    expect(ask3).toBeTruthy();
    const ask3Meta = typeof ask3.meta === "string" ? JSON.parse(ask3.meta) : ask3.meta ?? {};
    expect(ask3Meta.ask.options[0]).toContain("manual steps");
    expect(ask3Meta.ask.options.join(" ")).not.toContain("Bypass-merge");
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-brrl" });
  });

  it("2026-11-02: answering the base-red alarm ask DISPATCHES — a BYPASS answer stamps bypass_merge on the lane card (train.status serves it), the executor acks through queue_facts (bypass_consumed), and the stamp is spent; a RETRY answer stamps rerun_failed the same way", async () => {
    const repo = "state-vector/lane-dispatch";
    const sink = await kbJson("/create", { type: "task", title: "ALARM SINK drill — dispatch", session: "" });
    await kbJson("/admin.settings_set", { settings: { train_alarm_sink_id: String(sink.body.id) } });
    await acquire(repo, "gw-disp", { merge_capable: true, required_workflows: ["Test"] });
    const c1 = await queueViaAccept({ repo, pr: 53501, head: "c".repeat(40), title: "IMPL: dispatch drill 1" });
    // BR#5631: the ask needs a WARRANT — a fix-shaped cure queued on the lane
    // (the queue-entry fallback binds it, cure PR #53509)
    const cCure = await queueViaAccept({ repo, pr: 53509, head: "9".repeat(40), title: "fix(ci): dispatch drill cure — main red" });
    const r = await kbJson("/train.queue_facts", {
      repo, base: "main", actor: "gw-disp",
      entries: [ { id: cCure, pr: 53509, cls: "blocked" }, { id: c1, pr: 53501, cls: "waiting" } ],
      base_state: { verdict: "red", scoped_to: true, red: [{ name: "Test", url: "https://example.test/dispatch" }], unsettled: [] },
    });
    expect(r.body.error ?? "").toBe("");
    const ask = (await kbJson("/search", { q: "lane-dispatch", type: "question", limit: 50 })).body.artefacts
      .find((x: any) => String(x.title).startsWith("MERGE TRAIN BLOCKED: base ") && String(x.title).includes(`${repo}@main`));
    expect(ask).toBeTruthy();

    // the BYPASS answer (BR#6390: the HUMAN GATE's DONE — "I merged it") —
    // askAnswer records it AND stamps the merge authority on the LANE
    const a = await kbJson("/ask.answer", { id: ask.id, answer: "DONE — PR #53509 merged", actor: "web:ray" });
    expect(a.status).toBe(200);
    const lane = (await kbJson("/train.status", { repo })).body.lanes[0];
    expect(lane.bypass_merge).toBeTruthy();
    expect(lane.bypass_merge.pr).toBe(53509);
    expect(lane.bypass_merge.repo).toBe(repo);

    // the executor's next tick consumes + acks through queue_facts — spent
    const ack = await kbJson("/train.queue_facts", {
      repo, base: "main", actor: "gw-disp",
      entries: [ { id: cCure, pr: 53509, cls: "blocked" }, { id: c1, pr: 53501, cls: "waiting" } ],
      base_state: { verdict: "red", scoped_to: true, red: [{ name: "Test", url: "https://example.test/dispatch" }], unsettled: [] },
      bypass_consumed: "merged",
    });
    expect(ack.body.error ?? "").toBe("");
    const lane2 = (await kbJson("/train.status", { repo })).body.lanes[0];
    expect(lane2.bypass_merge ?? null).toBeNull();

    // a RETRY answer stamps rerun_failed — the executor re-runs the red checks
    await kbJson("/train.queue_facts", {
      repo, base: "main", actor: "gw-disp",
      entries: [ { id: cCure, pr: 53509, cls: "blocked" }, { id: c1, pr: 53501, cls: "waiting" } ],
      base_state: { verdict: "red", scoped_to: true, red: [{ name: "Test", url: "https://example.test/dispatch" }], unsettled: [] },
    });
    const ask2 = (await kbJson("/search", { q: "lane-dispatch", type: "question", limit: 50 })).body.artefacts
      .filter((x: any) => String(x.title).startsWith("MERGE TRAIN BLOCKED: base ") && String(x.title).includes(`${repo}@main`))
      .find((x: any) => x.status === "todo");
    expect(ask2).toBeTruthy();
    await kbJson("/ask.answer", { id: ask2.id, answer: "Transient — re-run the failing check", actor: "web:ray" });
    const lane3 = (await kbJson("/train.status", { repo })).body.lanes[0];
    expect(lane3.rerun_failed).toBeTruthy();
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-disp" });
  });

  it("BR#6390 human gate: DONE suppresses duplicate asks until the executor tick lands the merge; DECLINE holds the line and suppresses re-asks for the same episode+PR (a different cure re-arms); the BASE-FIX card shape (BR#6378) heads the episode through merged-awaiting-ci", async () => {
    const repo = "state-vector/lane-br6390";
    const sink = await kbJson("/create", { type: "task", title: "ALARM SINK drill — br6390", session: "" });
    await kbJson("/admin.settings_set", { settings: { train_alarm_sink_id: String(sink.body.id) } });
    await acquire(repo, "gw-6390", { merge_capable: true, required_workflows: ["Test"] });
    const c1 = await queueViaAccept({ repo, pr: 63901, head: "a".repeat(40), title: "IMPL: br6390 held feature" });
    const cCure = await queueViaAccept({ repo, pr: 63909, head: "9".repeat(40), title: "fix(ci): br6390 cure — main red" });
    const stampRed = () =>
      kbJson("/train.queue_facts", {
        repo, base: "main", actor: "gw-6390",
        entries: [ { id: cCure, pr: 63909, cls: "blocked" }, { id: c1, pr: 63901, cls: "waiting" } ],
        base_state: { verdict: "red", scoped_to: true, red: [{ name: "Test", url: "https://example.test/6390" }], unsettled: [] },
      });
    expect((await stampRed()).body.error ?? "").toBe("");
    const askHits = async () => {
      const all = (await kbJson("/search", { q: "lane-br6390", type: "question", limit: 50 })).body.artefacts;
      return all.filter((x: any) => String(x.title).startsWith("MERGE TRAIN BLOCKED: base ") && String(x.title).includes(`${repo}@main`));
    };
    const findOpenAsk = async () => (await askHits()).find((x: any) => x.status === "todo") ?? null;

    // the gate files with the DONE/DECLINE pair
    const ask = await findOpenAsk();
    expect(ask).toBeTruthy();
    const askMeta = typeof ask.meta === "string" ? JSON.parse(ask.meta) : ask.meta ?? {};
    expect(askMeta.ask.options).toEqual(["DONE — PR #63909 merged", "DECLINE — hold the line"]);
    expect(String(ask.body_md)).toContain("HUMAN GATE");
    expect(String(ask.body_md)).toContain("gh pr merge 63909");

    // (1) DONE: the merge authority is stamped and — the BR#6382→BR#6385 churn
    // fix — re-stamping red while the executor tick is outstanding files NO
    // duplicate ask (the pending authorization suppresses (re)filing)
    const a = await kbJson("/ask.answer", { id: ask.id, answer: "DONE — PR #63909 merged", actor: "web:ray" });
    expect(a.status).toBe(200);
    let lane = await laneSnap(repo);
    expect(lane.bypass_merge).toBeTruthy();
    expect(lane.bypass_merge.pr).toBe(63909);
    expect(await findOpenAsk()).toBeNull();
    expect((await stampRed()).body.error ?? "").toBe("");
    expect((await askHits()).length).toBe(1); // still exactly one — no duplicate
    expect(await findOpenAsk()).toBeNull();

    // the executor's tick acks + the merged event flips the episode to
    // merged-awaiting-ci (the executor's merged-elsewhere arm stamps this
    // same event shape for a human-landed merge)
    const mergedEv = await kbJson("/train.event", {
      repo, base: "main", actor: "gw-6390", kind: "merged", pr: 63909,
      merge_sha: "e".repeat(40), head_sha: "9".repeat(40), task_id: cCure,
    });
    expect(mergedEv.body.error ?? "").toBe("");
    expect((await kbJson("/train.queue_facts", {
      repo, base: "main", actor: "gw-6390",
      entries: [ { id: c1, pr: 63901, cls: "waiting" } ],
      base_state: { verdict: "red", scoped_to: true, red: [{ name: "Test", url: "https://example.test/6390" }], unsettled: [] },
      bypass_consumed: "merged",
    })).body.error ?? "").toBe("");
    lane = await laneSnap(repo);
    expect(lane.bypass_merge ?? null).toBeNull(); // spent
    expect((await askHits()).length).toBe(1); // still one — closed, never duplicated

    // (2) DECLINE on a fresh episode: the gate files, the human declines, and
    // the SAME episode+PR never re-asks; a DIFFERENT cure PR re-arms the gate
    const repo2 = "state-vector/lane-br6390-decline";
    await acquire(repo2, "gw-6390d", { merge_capable: true, required_workflows: ["Test"] });
    const cCure2 = await queueViaAccept({ repo: repo2, pr: 63919, head: "b".repeat(40), title: "fix(ci): br6390 decline cure — main red" });
    const stampRed2 = () =>
      kbJson("/train.queue_facts", {
        repo: repo2, base: "main", actor: "gw-6390d",
        entries: [ { id: cCure2, pr: 63919, cls: "blocked" } ],
        base_state: { verdict: "red", scoped_to: true, red: [{ name: "Test", url: "https://example.test/6390d" }], unsettled: [] },
      });
    expect((await stampRed2()).body.error ?? "").toBe("");
    const askHits2 = async () => {
      const all = (await kbJson("/search", { q: "lane-br6390-decline", type: "question", limit: 50 })).body.artefacts;
      return all.filter((x: any) => String(x.title).startsWith("MERGE TRAIN BLOCKED: base ") && String(x.title).includes(`${repo2}@main`));
    };
    const openAsk2 = async () => (await askHits2()).find((x: any) => x.status === "todo") ?? null;
    const ask2 = await openAsk2();
    expect(ask2).toBeTruthy();
    const d = await kbJson("/ask.answer", { id: ask2.id, answer: "DECLINE — hold the line", actor: "web:ray" });
    expect(d.status).toBe(200);
    let lane2 = await laneSnap(repo2);
    expect(lane2.base_red_ask_declined).toBeTruthy();
    expect(lane2.base_red_ask_declined.pr).toBe(63919);
    expect(lane2.bypass_merge ?? null).toBeNull(); // decline never stamps merge authority
    expect((await stampRed2()).body.error ?? "").toBe("");
    expect(await openAsk2()).toBeNull(); // suppressed
    expect((await askHits2()).length).toBe(1); // no duplicate
    // a different cure PR re-arms the gate for the same episode
    const cCure3 = await queueViaAccept({ repo: repo2, pr: 63929, head: "c".repeat(40), title: "fix(ci): br6390 second cure — main red" });
    expect((await kbJson("/train.queue_facts", {
      repo: repo2, base: "main", actor: "gw-6390d",
      entries: [ { id: cCure3, pr: 63929, cls: "blocked" } ],
      base_state: { verdict: "red", scoped_to: true, red: [{ name: "Test", url: "https://example.test/6390d" }], unsettled: [] },
    })).body.error ?? "").toBe("");
    const ask3 = await openAsk2();
    expect(ask3).toBeTruthy(); // re-armed: different PR
    expect(String(typeof ask3.meta === "string" ? JSON.parse(ask3.meta).ask.options[0] : ask3.meta.ask.options[0])).toContain("DONE — PR #63929 merged");

    // (3) the BASE-FIX card shape (BR#6378): agent-filed stop-the-line card,
    // NO root_blocker tag, tip_sha + root_blocker_for_lane binding — step 1
    // of the episode join must head the resolution with it (the 2026-11-04
    // episode showed a stale fix_card + flapping asks instead)
    const repo3 = "state-vector/lane-br6390-basefix";
    await acquire(repo3, "gw-6390b", { merge_capable: true, required_workflows: ["Test"] });
    const baseFix = await kbJson("/create", {
      type: "task",
      title: "BASE-FIX (stop-the-line, next stacked red): Deploy Dev 41886610540 (main tip 2c2a6ae5e) FAILED Cortex Quality Smoke",
      tags: ["main-red", "merge-train", "stop-the-line", "p0"],
      session: "",
      meta: {
        repo: repo3,
        tip_sha: "2c2a6ae5e217adc0fdc73de3774b46e7aa938879",
        root_blocker_for_lane: `${repo3}@main`,
        prs: [{ repo: repo3, number: 63939, head_sha_at_acceptance: "d".repeat(40) }],
        merge_train: { state: "queued", pr: 63939, at: Date.now() },
      },
    });
    expect(baseFix.status).toBe(200);
    // the field shape (BR#6378): the BASE-FIX card parks blocked WITH its typed
    // pr_merged await — the gate REJECTS a bare blocked transition (assert it,
    // a silently-rejected park here reads downstream as an empty queue)
    const parkBf = await kbJson("/transition", { id: String(baseFix.body.id), to: "blocked", actor: "drill", note: "merge-train: queued", await_event: { event: "pr_merged", repo: repo3, n: 63939 } });
    expect(parkBf.status).toBe(200);
    expect((await kbJson("/train.queue_facts", {
      repo: repo3, base: "main", actor: "gw-6390b",
      entries: [ { id: String(baseFix.body.id), pr: 63939, cls: "blocked" } ],
      base_state: { verdict: "red", scoped_to: true, red: [{ name: "Test", url: "https://example.test/6390b" }], unsettled: [] },
    })).body.error ?? "").toBe("");
    let lane3 = await laneSnap(repo3);
    expect(lane3.base_red_resolution.fix_card.id).toBe(String(baseFix.body.id));
    expect(lane3.base_red_resolution.fix_card.pr).toBe(63939);
    expect(lane3.base_red_resolution.phase).toBe("cure_pr_awaiting_force_merge");
    // the gate files for the BASE-FIX lane too — and a bare "DONE" (no PR
    // number typed) still resolves the cure through the episode join: the
    // dispatch falls back to the open cure on the lane's base-fix card
    // (BR#6390: the human may click/typed DONE without the option text)
    const askB = (await kbJson("/search", { q: "lane-br6390-basefix", type: "question", limit: 50 })).body.artefacts
      .find((x: any) => String(x.title).startsWith("MERGE TRAIN BLOCKED: base ") && String(x.title).includes(`${repo3}@main`) && x.status === "todo");
    expect(askB).toBeTruthy();
    const aB = await kbJson("/ask.answer", { id: askB.id, answer: "DONE", actor: "web:ray" });
    expect(aB.status).toBe(200);
    lane3 = await laneSnap(repo3);
    expect(lane3.bypass_merge).toBeTruthy();
    expect(lane3.bypass_merge.pr).toBe(63939);
    // the cure merges (human gate DONE -> executor merged event): the
    // episode settles on merged-awaiting-ci with THIS card — never a stale
    // fix_card, never a re-filed ask
    const merged3 = await kbJson("/train.event", {
      repo: repo3, base: "main", actor: "gw-6390b", kind: "merged", pr: 63939,
      merge_sha: "f".repeat(40), head_sha: "d".repeat(40), task_id: String(baseFix.body.id),
    });
    expect(merged3.body.error ?? "").toBe("");
    expect((await kbJson("/train.queue_facts", {
      repo: repo3, base: "main", actor: "gw-6390b",
      entries: [],
      base_state: { verdict: "red", scoped_to: true, red: [{ name: "Test", url: "https://example.test/6390b" }], unsettled: [] },
    })).body.error ?? "").toBe("");
    lane3 = await laneSnap(repo3);
    expect(lane3.base_red_resolution.phase).toBe("cure_pr_merged_awaiting_ci");
    expect(lane3.base_red_resolution.fix_card.id).toBe(String(baseFix.body.id));
    expect(lane3.base_red_resolution.fix_card.merged).toBe(true);

    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-6390" });
    await kbJson("/train.lease", { repo: repo2, base: "main", action: "release", actor: "gw-6390d" });
    await kbJson("/train.lease", { repo: repo3, base: "main", action: "release", actor: "gw-6390b" });
  });

  it("BR#5516: no root-fix card needed — a QUEUED fix-shaped cure PR renders bypass-first in the ask (the 2026-11-02 bridge episode: verified PR queued, ask said 'no fix PR'), the brief carries the Read-of-the-red triage lines, and a bypass answer dispatches the merge authority", async () => {
    const repo = "state-vector/lane-brr-queue";
    const sink = await kbJson("/create", { type: "task", title: "ALARM SINK drill — brr-queue", session: "" });
    await kbJson("/admin.settings_set", { settings: { train_alarm_sink_id: String(sink.body.id) } });
    await acquire(repo, "gw-brrq", { merge_capable: true, required_workflows: ["Test"] });
    const c1 = await queueViaAccept({ repo, pr: 55161, head: "e".repeat(40), title: "IMPL: brr-queue held feature" });
    // the episode's cure: an ORDINARY card (no root_fix meta) queued on the
    // lane, PR bound by the accept chain — the exact BR#5487/PR#357 shape
    const cFix = await queueViaAccept({ repo, pr: 55162, head: "f".repeat(40), title: "fix(ci): main-green gate structurally self-failing — drill cure" });
    const stampRed = () =>
      kbJson("/train.queue_facts", {
        repo, base: "main", actor: "gw-brrq",
        entries: [ { id: cFix, pr: 55162, cls: "blocked" }, { id: c1, pr: 55161, cls: "blocked" } ],
        base_state: { verdict: "red", scoped_to_required: true, red: [{ name: "main-green gate", url: "https://example.test/queue" }], unsettled: [] },
      });
    expect((await stampRed()).body.error ?? "").toBe("");

    const ask = (await kbJson("/search", { q: "lane-brr-queue", type: "question", limit: 50 })).body.artefacts
      .find((x: any) => String(x.title).startsWith("MERGE TRAIN BLOCKED: base ") && String(x.title).includes(`${repo}@main`));
    expect(ask).toBeTruthy();
    // the bypass option carries the QUEUED cure PR's number, first
    const askMetaM = typeof ask.meta === "string" ? JSON.parse(ask.meta) : ask.meta ?? {};
    expect(askMetaM.ask.options[0]).toContain("DONE — PR #55162 merged");
    expect(askMetaM.ask.options[1]).toContain("DECLINE");
    expect(String(ask.body_md)).toContain("https://github.com/" + repo + "/pull/55162");
    // triage-before-menu: the brief carries the Read-of-the-red lines — the
    // gate-self-failure shape says a re-run fails identically, in plain text
    expect(String(ask.body_md)).toContain("Read of the red");
    expect(String(ask.body_md)).toContain("re-run fails IDENTICALLY");
    // fix_card rides the resolution with the cure PR (status-side join)
    const lane = await laneSnap(repo);
    expect(lane.base_red_resolution.fix_card.pr).toBe(55162);

    // the DONE answer dispatches the merge authority on the lane card
    const a = await kbJson("/ask.answer", { id: ask.id, answer: "DONE — PR #55162 merged", actor: "web:ray" });
    expect(a.status).toBe(200);
    const lane2 = await laneSnap(repo);
    expect(lane2.bypass_merge).toBeTruthy();
    expect(lane2.bypass_merge.pr).toBe(55162);
    expect(lane2.bypass_merge.repo).toBe(repo);

    // a NON-fix-shaped queued PR never becomes the cure — no cure, not
    // exhausted → NO ask at all under the BR#5631 warrant gate (fresh lane,
    // only the IMPL card queued; the bypass must never offer an arbitrary
    // held PR, and an agent-workable red never asks the human)
    const repo2 = "state-vector/lane-brr-plain";
    await acquire(repo2, "gw-brrp", { merge_capable: true, required_workflows: ["Test"] });
    const c2 = await queueViaAccept({ repo: repo2, pr: 55163, head: "g".repeat(40), title: "IMPL: brr-plain held feature" });
    const r2 = await kbJson("/train.queue_facts", {
      repo: repo2, base: "main", actor: "gw-brrp",
      entries: [ { id: c2, pr: 55163, cls: "blocked" } ],
      base_state: { verdict: "red", scoped_to_required: true, red: [{ name: "Test", url: "https://example.test/plain" }], unsettled: [] },
    });
    expect(r2.body.error ?? "").toBe("");
    const ask2 = (await kbJson("/search", { q: "lane-brr-plain", type: "question", limit: 50 })).body.artefacts
      .find((x: any) => String(x.title).startsWith("MERGE TRAIN BLOCKED: base ") && String(x.title).includes(`${repo2}@main`));
    expect(ask2 ?? null).toBeNull();
    await kbJson("/train.lease", { repo: repo2, base: "main", action: "release", actor: "gw-brrp" });
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-brrq" });
  });

  it("BR#5376: a stalled batch rides the walk stamp — the lane renders the loud STALLED reason (batch, duration, WHY), train.status serves stalled_resolution (batch/ticks/for_ms/last_error/ask/unblock), the ONE-per-episode ask dedupes the per-tick repeats, base-red suppresses the stall banner, and the next stamp WITHOUT the episode clears everything by itself", async () => {
    const repo = "state-vector/lane-stall";
    await acquire(repo, "gw-stall", { merge_capable: true, required_workflows: ["Test"] });
    const c1 = await queueViaAccept({ repo, pr: 53761, head: "e".repeat(40), title: "IMPL: stall drill 1" });
    const c2 = await queueViaAccept({ repo, pr: 53762, head: "f".repeat(40), title: "IMPL: stall drill 2" });
    const initialLane = await laneSnap(repo);
    const staleDiagnostic = await kbJson("/create", { type: "task", title: "Yesterday's starvation diagnosis", qualified: true,
      meta: { machine_duty: { kind: "diagnostic", subject: initialLane.card } } });

    const stamp = (stalled: unknown) =>
      kbJson("/train.queue_facts", {
        repo, base: "main", actor: "gw-stall",
        entries: [ { id: c1, pr: 53761, cls: "ready" }, { id: c2, pr: 53762, cls: "ready" } ],
        ...(stalled ? { stalled } : {}),
      });

    const r = await stamp({ batch: [53761, 53762], ticks: 3, since: Date.now() - 4 * 60_000, for_ms: 4 * 60_000, last_error: "GraphQL: Merge commits are not allowed on this repository. (mergePullRequest)" });
    expect(r.body.error ?? "").toBe("");
    const lane = await laneSnap(repo);
    expect(lane.reason).toContain("merge-train: STALLED");
    expect(lane.reason).toContain("0 landed in 4m (3 tick(s))");
    expect(lane.reason).toContain("Merge commits are not allowed on this repository");
    expect(lane.reason).toContain("restart the gateway");
    const sr = lane.stalled_resolution;
    expect(sr).toBeTruthy();
    expect(sr.batch).toEqual([53761, 53762]);
    expect(sr.ticks).toBe(3);
    expect(sr.last_error).toContain("Merge commits are not allowed");
    expect(sr.unblock).toContain("restart");
    // the episode's OPEN alarm ask rides verbatim (one click to answer)
    const ask = (await kbJson("/search", { q: "MERGE TRAIN STALLED", type: "question", limit: 50 })).body.artefacts
      .find((x: any) => String(x.title).startsWith("MERGE TRAIN STALLED: ") && String(x.title).includes(`${repo}@main`));
    expect(ask).toBeUndefined();
    expect(sr.ask ?? null).toBeNull();
    expect(lane.line).toMatchObject({ blocker: "merge_failed", label: "Queued PRs cannot merge" });
    expect(lane.line.remediation.task.id).not.toBe(staleDiagnostic.body.id);
    const repair = lane.line.remediation.task.id;
    expect((await kbJson("/get", { id: repair })).body.meta.machine_duty).toMatchObject({
      kind: "line_recovery", subject: lane.card,
    });
    expect((await laneSnap(repo)).line.remediation.task.id).toBe(repair);

    // ONE ask per episode — the per-tick stamp repeats dedupe on the
    // numberless title (no tick counts, no ages)
    await stamp({ batch: [53761, 53762], ticks: 4, since: Date.now() - 5 * 60_000, for_ms: 5 * 60_000, last_error: "same refusal" });
    const askCount = async () =>
      (await kbJson("/search", { q: "MERGE TRAIN STALLED", type: "question", limit: 50 })).body.artefacts.filter(
        (x: any) => String(x.title).startsWith("MERGE TRAIN STALLED: ") && String(x.title).includes(`${repo}@main`),
      ).length;
    expect(await askCount()).toBe(0);

    // base-red owns the story when BOTH ride the same stamp — the STALLED
    // banner is suppressed while the lane reads BLOCKED
    await kbJson("/train.queue_facts", {
      repo, base: "main", actor: "gw-stall",
      entries: [ { id: c1, pr: 53761, cls: "waiting" }, { id: c2, pr: 53762, cls: "waiting" } ],
      base_state: { verdict: "red", scoped_to_required: true, red: [{ name: "Test", url: "https://example.test/5376" }], unsettled: [] },
      stalled: { batch: [53761, 53762], ticks: 5, since: Date.now() - 60_000, for_ms: 60_000, last_error: "refused" },
    });
    const laneBR = await laneSnap(repo);
    expect(laneBR.base_red_resolution).toBeTruthy();
    expect(laneBR.stalled_resolution ?? null).toBeNull();
    expect(laneBR.reason).toContain("BLOCKED — base main RED");

    // the next stamp WITHOUT the episode clears everything by itself — the
    // banner's own off-switch (no lingering state after a landing)
    await stamp(null);
    const lane2 = await laneSnap(repo);
    expect(lane2.reason).not.toContain("STALLED");
    expect(lane2.stalled_resolution ?? null).toBeNull();
    expect(await askCount()).toBe(0);
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-stall" });
  });

  it("BR#5376: train.event kind 'stalled' writes ONE ledger row per episode (dedupe by the episode's since) and files the numberless alarm ask; a re-fire of the SAME episode is an ack, a NEW since is a fresh row with still exactly one ask", async () => {
    const repo = "state-vector/lane-stall-ev";
    const T0 = Date.now() - 7 * 60_000; // fixed episode start for the dedupe key
    await acquire(repo, "gw-sev", { merge_capable: true, required_workflows: ["Test"] });

    const ev = (since: number, ticks: number) =>
      kbJson("/train.event", {
        repo, base: "main", actor: "gw-sev", kind: "stalled", pr: 0,
        batch_members: [53763], ticks, since,
        last_error: "GraphQL: Merge commits are not allowed on this repository. (mergePullRequest)",
        reason: "selected 1 PR(s) to merge, landed 0 across 3 tick(s) — likely executor breakage; restart the gateway onto the current build",
      });

    const r1 = await ev(T0, 3);
    expect(r1.body.error ?? "").toBe("");
    expect(r1.body.deduped ?? false).toBe(false);
    // a crash-recovery re-fire of the SAME episode dedupes to an ack
    const r2 = await ev(T0, 4);
    expect(r2.body.deduped).toBe(true);
    let hist = (await kbJson("/train.history", { repo, kind: "stalled" })).body.events;
    expect(hist.length).toBe(1);
    expect(hist[0].detail.since).toBe(T0);
    expect(hist[0].detail.batch_members).toEqual([53763]);
    expect(hist[0].detail.last_error).toContain("Merge commits are not allowed");
    // a NEW episode (new since) = a fresh ledger row, still exactly ONE ask
    const r3 = await ev(T0 + 10 * 60_000, 3);
    expect(r3.body.deduped ?? false).toBe(false);
    hist = (await kbJson("/train.history", { repo, kind: "stalled" })).body.events;
    expect(hist.length).toBe(2);
    const asks = (await kbJson("/search", { q: "MERGE TRAIN STALLED", type: "question", limit: 50 })).body.artefacts.filter(
      (x: any) => String(x.title).startsWith("MERGE TRAIN STALLED: ") && String(x.title).includes(`${repo}@main`),
    );
    expect(asks.length).toBe(0);
    // a non-holder cannot fire the alarm (the lane lease is required)
    const no = await kbJson("/train.event", { repo, base: "main", actor: "gw-other", kind: "stalled", pr: 0, batch_members: [1], ticks: 3, since: T0 + 60_000 });
    expect(no.status).toBeGreaterThanOrEqual(400);
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-sev" });
  });

  it("a legacy renewal with NO progress payload stamps nothing — the deprecation window stays silent", async () => {
    const repo = "state-vector/lane-legacy-renew";
    await acquire(repo, "gw-leg", { merge_capable: true });
    const ren = await kbJson("/train.lease", { repo, base: "main", action: "renew", actor: "gw-leg", merge_capable: true });
    expect(ren.body.error ?? "").toBe("");
    const lane = (await kbJson("/train.status", { repo })).body.lanes[0];
    expect(lane.now_action ?? null).toBeNull();
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-leg" });
  });
});

// ---------- BR#5151: train:merged is the only lane writer, and it dedupes ----------

describe("BR#5151: train:merged dedupe — a PR merges exactly once", () => {
  it("an identical re-report collapses to an ack; a different sha is a named reject; the ledger keeps ONE merged row", async () => {
    const repo = "state-vector/dedupe-drill";
    const HEAD = "b".repeat(40);
    const card = await queueViaAccept({ repo, pr: 5151, head: HEAD, title: "IMPL: train dedupe drill (BR#5151)" });
    await acquire(repo, "gw-dedup", { required_workflows: ["Test"] });
    const M = "d".repeat(40);
    const first = await kbJson("/train.event", {
      repo, base: "main", kind: "merged", actor: "gw-dedup",
      pr: 5151, merge_sha: M, head_sha: HEAD, task_id: card,
    });
    expect(first.body.error ?? "", `first merged failed: ${JSON.stringify(first.body)}`).toBe("");
    expect(first.body.task).toBe(card);

    // crash-recovery re-report: the SAME sha collapses to an ack — no error,
    // no second settle, no provenance overwrite
    const dup = await kbJson("/train.event", {
      repo, base: "main", kind: "merged", actor: "gw-dedup",
      pr: 5151, merge_sha: M, head_sha: HEAD, task_id: card,
    });
    expect(dup.status).toBe(200);
    expect(dup.body.ok).toBe(true);
    expect(dup.body.deduped).toBe(true);

    // a DIFFERENT merge_sha for a PR already recorded merged: a named
    // protocol reject (≥400), never a silent provenance overwrite
    const conflict = await kbJson("/train.event", {
      repo, base: "main", kind: "merged", actor: "gw-dedup",
      pr: 5151, merge_sha: "e".repeat(40), head_sha: HEAD, task_id: card,
    });
    expect(conflict.status).toBeGreaterThanOrEqual(400);
    expect(String(conflict.body.error)).toContain("already recorded merged");

    // the ledger holds exactly one merged row for the PR
    const hist = (await kbJson("/train.history", { repo })).body.events.filter(
      (e: any) => e.kind === "merged" && Number(e.pr) === 5151,
    );
    expect(hist).toHaveLength(1);
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-dedup" });
  });

  it("a merged event naming the standing LANE card is a named reject — nothing stamped, nothing settled", async () => {
    const repo = "state-vector/dedupe-lane-drill";
    const lane = await kbJson("/train.lane", { repo, base: "main", actor: "drill" });
    expect(lane.body.error ?? "").toBe("");
    const laneId = String(lane.body.id);
    await acquire(repo, "gw-lane", { required_workflows: ["Test"] });
    const M = "9e".repeat(20); // unique in this DO — nothing else stamps 9e9e…
    const reject = await kbJson("/train.event", {
      repo, base: "main", kind: "merged", actor: "gw-lane",
      pr: 5152, merge_sha: M, task_id: laneId, // the lane card itself — the BR#5050 foothold
    });
    expect(reject.status).toBeGreaterThanOrEqual(400);
    expect(String(reject.body.error)).toContain("standing lane card");
    // the rejected event left NO provenance row for that merge
    const prov = await kbJson(`/provenance?sha=${M}`);
    expect(prov.status).toBe(404);
    // the lane itself is untouched: still blocked, lease still held
    const after = (await kbJson("/get", { id: laneId })).body;
    expect(after.status).toBe("blocked");
    expect(after.meta?.lease?.holder).toBe("gw-lane");
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-lane" });
  });
});

// ---------- BR#5674 P1 + P4: empty-is-loud + 1h merge-starvation alarm & diagnostic duty ----------

describe("BR#5674 P1 + P4: empty-is-loud base alarm + 1h merge-starvation alarm & diagnostic duty (real DO)", () => {
  it("P1 empty-is-loud: base_state.alarm surfaces in the lane's blocked reason for both some-runs-none-matched and zero-total-runs (and falls back to config? when absent)", async () => {
    const repo = "state-vector/lane-p1-empty";
    await acquire(repo, "gw-p1", { merge_capable: true, required_workflows: ["deploy / Deploy to dev"] });
    const c1 = await queueViaAccept({ repo, pr: 56741, head: "a".repeat(40), title: "IMPL: p1 empty-is-loud drill" });

    // (1) N runs read, none matched required set
    const r1 = await kbJson("/train.queue_facts", {
      repo, base: "main", actor: "gw-p1",
      entries: [{ id: c1, pr: 56741, cls: "waiting" }],
      base_state: {
        verdict: "empty",
        scoped_to_required: true,
        red: [],
        unsettled: [],
        alarm: "49 runs read, none matched required set — check names/pagination",
      },
    });
    expect(r1.body.error ?? "").toBe("");
    const lane1 = await laneSnap(repo);
    expect(lane1.reason).toContain("merge-train: BLOCKED — base main carries none of the lane's required workflow runs (49 runs read, none matched required set — check names/pagination)");
    expect(lane1.reason).toContain("1 car(s) held");

    // (2) zero total runs on tip
    await kbJson("/train.queue_facts", {
      repo, base: "main", actor: "gw-p1",
      entries: [{ id: c1, pr: 56741, cls: "waiting" }],
      base_state: {
        verdict: "empty",
        scoped_to_required: true,
        red: [],
        unsettled: [],
        alarm: "tip carries no check runs at all",
      },
    });
    const lane2 = await laneSnap(repo);
    expect(lane2.reason).toContain("merge-train: BLOCKED — base main carries none of the lane's required workflow runs (tip carries no check runs at all)");

    // (3) legacy executor (no alarm field) keeps the fallback "(config?)"
    await kbJson("/train.queue_facts", {
      repo, base: "main", actor: "gw-p1",
      entries: [{ id: c1, pr: 56741, cls: "waiting" }],
      base_state: {
        verdict: "empty",
        scoped_to_required: true,
        red: [],
        unsettled: [],
      },
    });
    const lane3 = await laneSnap(repo);
    expect(lane3.reason).toContain("carries none of the lane's required workflow runs (config?)");
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-p1" });
  });

  it("P4 merge-starvation alarm: non-empty queue (or awaiting) + now-last_merge_ts > 1h + no stop-the-line fires ONE ask with full diagnosis (incl. P1 alarm) + spawns ONE diagnostic duty (tags merge-train/diagnostic, ranked #1 in orient), stamps starvation={since,fired_at,ask_id,duty_id}, and clears on any merge", async () => {
    const repo = "state-vector/lane-p4-starve";
    const sink = await kbJson("/create", { type: "task", title: "ALARM SINK drill — p4-starve", session: "" });
    await kbJson("/admin.settings_set", { settings: { train_alarm_sink_id: String(sink.body.id) } });
    await acquire(repo, "gw-p4", { merge_capable: true, required_workflows: ["deploy / Deploy to dev", "post-deploy / Post-Deploy Smoke"] });

    // Land a prior merge > 2 hours ago so last_merge_ts is > 1h in the past
    const priorCard = await queueViaAccept({ repo, pr: 56742, head: "1".repeat(40), title: "IMPL: p4 prior landed car" });
    const twoHoursAgo = Date.now() - 2 * 3_600_000;
    const M0 = "2".repeat(40);
    expect((await kbJson("/train.event", {
      repo, base: "main", kind: "merged", actor: "gw-p4",
      pr: 56742, merge_sha: M0, head_sha: "1".repeat(40), task_id: priorCard,
      merged_at: twoHoursAgo,
    })).body.error ?? "").toBe("");
    expect((await kbJson("/train.ci", {
      repo, base: "main", actor: "gw-p4", sha: M0,
      checks: [
        check(101, "deploy / Deploy to dev", "success"),
        check(102, "post-deploy / Post-Deploy Smoke", "success"),
      ],
    })).body.decided).toBe("landed");

    // Now queue a car and park a second car in Awaiting, while the gateway is
    // actively leasing (merge_capable: true) and base_state is P1 empty-with-alarm!
    const qCard = await queueViaAccept({ repo, pr: 56743, head: "3".repeat(40), title: "IMPL: p4 held queued car" });
    const awCard = await queueViaAccept({ repo, pr: 56744, head: "4".repeat(40), title: "IMPL: p4 held awaiting car" });
    expect((await kbJson("/train.event", {
      repo, base: "main", kind: "bounced", actor: "gw-p4", pr: 56744, task_id: awCard,
      head_sha: "5".repeat(40), bounce_kind: "coverage", conflict_files: ["src/conflict.ts"],
    })).body.awaiting_park).toBe(true);

    expect((await kbJson("/train.queue_facts", {
      repo, base: "main", actor: "gw-p4",
      entries: [{ id: qCard, pr: 56743, cls: "waiting" }],
      base_state: {
        verdict: "empty",
        scoped_to_required: true,
        red: [],
        unsettled: [],
        alarm: "49 runs read, none matched required set — check names/pagination",
      },
    })).body.error ?? "").toBe("");

    // First read after >1h without a merge: fires starvation!
    const snap1 = await laneSnap(repo);
    expect(snap1.starved).toBeTruthy();
    expect(snap1.starved.mins).toBeGreaterThanOrEqual(60);
    expect(snap1.starved.ask_id).toBeNull();
    expect(snap1.starved.duty_id).toBeTruthy();

    const laneCardObj = (await kbJson("/get", { id: snap1.card })).body;
    const starv = laneCardObj.meta?.lane?.starvation ?? laneCardObj.meta?.starvation;
    expect(starv).toBeTruthy();
    expect(starv.since).toBe(twoHoursAgo);
    expect(starv.fired_at).toBeGreaterThan(0);
    expect(starv.ask_id).toBe(snap1.starved.ask_id);
    expect(starv.duty_id).toBe(snap1.starved.duty_id);

    // Check the diagnostic duty card (tags merge-train + diagnostic, checklist items)
    const dutyArt = (await kbJson("/get", { id: starv.duty_id })).body;
    expect(dutyArt.type).toBe("task");
    expect(dutyArt.status).toBe("todo");
    expect(dutyArt.tags).toEqual(expect.arrayContaining(["merge-train", "diagnostic"]));
    expect(String(dutyArt.body_md)).toContain("per_page");
    expect(String(dutyArt.body_md)).toContain("required_workflows");
    expect(String(dutyArt.body_md)).toContain("Verify pool depth");
    expect(String(dutyArt.body_md)).toContain("Park exits");

    // Train-health priority: the diagnostic duty ranks at the top of orient's unclaimed_work
    const oriented = (await kbJson("/orient", { session: "p4-diag-probe" })).body;
    // The pool is limited to ten rows; automatic recovery of other blocked
    // lines may fill that page. Every returned task must still be train-health
    // priority rather than unrelated feature work.
    const top = oriented.unclaimed_work ?? [];
    expect(top.length).toBeGreaterThan(0);
    expect(top.every((w: any) => (w.tags ?? []).includes("diagnostic") || (w.tags ?? []).includes("root_blocker"))).toBe(true);

    // Second read + merge_capable lease renewal: does NOT duplicate the ask or duty, and does NOT clear starvation before a merge
    await kbJson("/train.lease", { repo, base: "main", action: "renew", actor: "gw-p4", merge_capable: true });
    const snap2 = await laneSnap(repo);
    expect(snap2.starved?.ask_id).toBe(starv.ask_id);
    expect(snap2.starved?.duty_id).toBe(starv.duty_id);
    const allStarveAsks = (await kbJson("/search", { q: "lane-p4-starve", type: "question", limit: 50 })).body.artefacts
      .filter((x: any) => x.type === "question" && String(x.title).startsWith(`MERGE TRAIN STARVED: ${repo}@main`));
    expect(allStarveAsks.length).toBe(0);

    // ANY merge on the lane clears starvation (meta.lane.starvation = null, lane.starved = null)
    const M1 = "6".repeat(40);
    expect((await kbJson("/train.event", {
      repo, base: "main", kind: "merged", actor: "gw-p4",
      pr: 56743, merge_sha: M1, head_sha: "3".repeat(40), task_id: qCard,
    })).body.error ?? "").toBe("");
    const laneCardAfterMerge = (await kbJson("/get", { id: snap1.card })).body;
    expect(laneCardAfterMerge.meta?.lane?.starvation ?? null).toBeNull();
    expect(laneCardAfterMerge.meta?.starvation ?? null).toBeNull();
    const snap3 = await laneSnap(repo);
    expect(snap3.starved).toBeNull();
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-p4" });
  });

  it("P4 awaiting-only starvation + stop-the-line suppression: an empty derived queue with an awaiting car >1h since last merge fires starvation; an active stop-the-line episode suppresses it", async () => {
    const repo = "state-vector/lane-p4-awaiting";
    const sink = await kbJson("/create", { type: "task", title: "ALARM SINK drill — p4-awaiting", session: "" });
    await kbJson("/admin.settings_set", { settings: { train_alarm_sink_id: String(sink.body.id) } });
    await acquire(repo, "gw-p4a", { merge_capable: true, required_workflows: ["Test"] });

    // Prior merge > 2h ago
    const prior = await queueViaAccept({ repo, pr: 56745, head: "7".repeat(40), title: "IMPL: p4a prior" });
    const M0 = "8".repeat(40);
    await kbJson("/train.event", {
      repo, base: "main", kind: "merged", actor: "gw-p4a",
      pr: 56745, merge_sha: M0, head_sha: "7".repeat(40), task_id: prior,
      merged_at: Date.now() - 2 * 3_600_000,
    });
    await kbJson("/train.ci", { repo, base: "main", actor: "gw-p4a", sha: M0, checks: [check(201, "Test", "success")] });

    // Park a card in Awaiting — derived queue is now EMPTY, awaiting has 1 car
    const awOnly = await queueViaAccept({ repo, pr: 56746, head: "9".repeat(40), title: "IMPL: p4a awaiting-only" });
    await kbJson("/train.event", {
      repo, base: "main", kind: "bounced", actor: "gw-p4a", pr: 56746, task_id: awOnly,
      head_sha: "a".repeat(40), bounce_kind: "coverage", conflict_files: ["src/a.ts"],
    });

    // While a stop-the-line episode is active, P4 starvation does NOT fire
    await kbJson("/train.event", {
      repo, base: "main", kind: "stopped", actor: "gw-p4a",
      merge_sha: "b".repeat(40), failing: [{ name: "Test", conclusion: "failure", url: "https://example/red" }],
    });
    const snapStopped = await laneSnap(repo);
    expect(snapStopped.queue.length).toBe(0);
    expect(snapStopped.awaiting.length).toBe(1);
    expect(snapStopped.starved).toBeNull();

    // Clear the stop → next status check fires starvation on the non-empty awaiting set!
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-p4a", line_green: true });
    await acquire(repo, "gw-p4a", { merge_capable: true, required_workflows: ["Test"] });
    const snapCleared = await laneSnap(repo);
    expect(snapCleared.queue.length).toBe(0);
    expect(snapCleared.awaiting.length).toBe(1);
    expect(snapCleared.starved).toBeTruthy();
    expect(snapCleared.starved.ask_id).toBeNull();
    expect(snapCleared.starved.duty_id).toBeTruthy();
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-p4a" });
  });

  it("BR#5658 v2: trainStatus serves 3-bucket pr_stats (in_progress, verifying, ready) across all card states + sequential batches, direct-to-main Verify ACCEPT auto-closes parent done, and unbound handoff asks mint a tracked task on answer", async () => {
    const repo = "state-vector/nextgen-lane";
    await kbJson("/train.lane", { repo, base: "main", actor: "gw-ng" });

    // 1. Direct-to-main card: in_review with commit URL receipt -> Verify closes done -> parent auto-closes done (never queued on a ghost lane)
    const directCard = (await kbJson("/create", {
      type: "task",
      title: "IMPL: direct-to-main feature with tb-pulse/BR#5658 prose",
      body_md: "Added @keyframes tb-pulse/BR#5658.",
      qualified: true,
      session: "sess-direct-impl",
      actor: "impl-agent",
    })).body;
    await kbJson("/transition", { id: directCard.id, to: "in_progress", session: "sess-direct-impl", actor: "impl-agent" });
    const rev = (await kbJson("/transition", {
      id: directCard.id,
      to: "in_review",
      session: "sess-direct-impl",
      note: "Landed direct to main — https://github.com/state-vector/bridge/commit/68ef20ed1e2797072411ac99bdfa832a39866b54",
      actor: "impl-agent",
    })).body;
    expect(rev.verify_task).toBeTruthy();
    await kbJson("/transition", { id: rev.verify_task, to: "in_progress", session: "sess-direct-verify", actor: "verifier-agent" });
    await kbJson("/transition", {
      id: rev.verify_task,
      to: "done",
      session: "sess-direct-verify",
      note: "VERIFY ACCEPT — commit 68ef20ed1e2797072411ac99bdfa832a39866b54 passed all checks on main https://github.com/state-vector/bridge/actions/runs/123",
      actor: "verifier-agent",
    });
    const directAfter = (await kbJson("/get", { id: directCard.id })).body;
    expect(directAfter.status).toBe("done");

    // 2. Unbound handoff ask (BR#5476 class) -> answering "apply ... WIP" auto-mints a qualified task card
    const handoffAsk = (await kbJson("/ask.create", {
      to: "macbook-pro-local-opencode",
      question: "Ray's colour spec hits your TrainPanel WIP: apply it in your WIP, or hand me the slice?",
      reason: "Live directive modifies your in-flight files",
      details: "Apply green ready, orange pulsing verifying, orange solid waiting.",
      options: [
        "(Recommended) I apply Ray's colour spec to my WIP now",
        "Stand down — opencode-ray takes the slice",
      ],
      actor: "opencode-ray",
    })).body;
    const ansRes = (await kbJson("/ask.answer", {
      id: handoffAsk.id,
      answer: "(Recommended) I apply Ray's colour spec to my WIP now",
      actor: "web:rayh",
    })).body;
    expect(ansRes.spawned_task).toMatch(/^BR#\d+$/);
    const spawnedTask = (await kbJson("/get", { id: ansRes.spawned_task })).body;
    expect(spawnedTask.status).toBe("todo");
    expect(spawnedTask.meta?.handoff_from_ask).toBe(handoffAsk.id);
    expect(spawnedTask.meta?.handoff_to).toBe("macbook-pro-local-opencode");

    // 3. Lane PR stats & sequential merge batches across in_progress, in_review (waiting + active), and queued (ready)
    const ipCard = (await kbJson("/create", {
      type: "task",
      title: "IMPL: in-progress PR",
      body_md: `Working on https://github.com/${repo}/pull/501`,
      qualified: true,
      session: "sess-ip",
      actor: "impl-1",
    })).body;
    await kbJson("/transition", { id: ipCard.id, to: "in_progress", session: "sess-ip", actor: "impl-1" });

    const revWaitingCard = (await kbJson("/create", {
      type: "task",
      title: "IMPL: waiting-for-verify PR",
      body_md: "Impl",
      qualified: true,
      session: "sess-rw",
      actor: "impl-2",
    })).body;
    await kbJson("/transition", { id: revWaitingCard.id, to: "in_progress", session: "sess-rw", actor: "impl-2" });
    await kbJson("/transition", {
      id: revWaitingCard.id,
      to: "in_review",
      session: "sess-rw",
      note: `PR https://github.com/${repo}/pull/502`,
      actor: "impl-2",
    });

    const revActiveCard = (await kbJson("/create", {
      type: "task",
      title: "IMPL: actively-verifying PR",
      body_md: "Impl",
      qualified: true,
      session: "sess-ra",
      actor: "impl-3",
    })).body;
    await kbJson("/transition", { id: revActiveCard.id, to: "in_progress", session: "sess-ra", actor: "impl-3" });
    const raRev = (await kbJson("/transition", {
      id: revActiveCard.id,
      to: "in_review",
      session: "sess-ra",
      note: `PR https://github.com/${repo}/pull/503`,
      actor: "impl-3",
    })).body;
    await kbJson("/transition", { id: raRev.verify_task, to: "in_progress", session: "sess-ra-v", actor: "verifier-3" });

    const readyCard = (await kbJson("/create", {
      type: "task",
      title: "IMPL: ready PR",
      body_md: "Impl",
      qualified: true,
      session: "sess-rdy",
      actor: "impl-4",
    })).body;
    await kbJson("/transition", { id: readyCard.id, to: "in_progress", session: "sess-rdy", actor: "impl-4" });
    const rdyRev = (await kbJson("/transition", {
      id: readyCard.id,
      to: "in_review",
      session: "sess-rdy",
      note: `PR https://github.com/${repo}/pull/504`,
      actor: "impl-4",
    })).body;
    await kbJson("/transition", { id: rdyRev.verify_task, to: "in_progress", session: "sess-rdy-v", actor: "verifier-4" });
    await kbJson("/transition", {
      id: rdyRev.verify_task,
      to: "done",
      session: "sess-rdy-v",
      note: `VERIFY ACCEPT — PR https://github.com/${repo}/pull/504 head ${"d".repeat(40)}`,
      actor: "verifier-4",
    });

    // Stamp conflict_pairs between PR 504 and PR 503 so they split into Batch 1 and Batch 2
    // Even if queue_facts stamps cls:"waiting" on the already verify-accepted PR 504 (e.g. waiting on base settle), it stays ready (green)
    await kbJson("/train.lease", { repo, base: "main", action: "acquire", actor: "gw-ng", merge_capable: true });
    await kbJson("/train.queue_facts", {
      repo,
      base: "main",
      entries: [{ id: readyCard.id, pr: 504, cls: "waiting" }],
      conflict_pairs: [[504, 503]],
      actor: "gw-ng",
    });
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-ng" });

    const st = (await kbJson("/train.status", { repo })).body;
    const laneSnap = st.lanes.find((l: any) => l.lane === `${repo}@main`);
    expect(laneSnap).toBeTruthy();
    expect(laneSnap.pr_stats).toEqual({
      in_progress: 1, // PR 501
      verifying: 2,   // PR 502 (waiting) + PR 503 (actively verifying)
      ready: 1,       // PR 504 (ready)
    });
    // Batch 1 contains [504 (ready), 502 (waiting)], Batch 2 contains [503 (verifying — conflicted with 504)]
    expect(laneSnap.batches.length).toBe(2);
    expect(laneSnap.batches[0].map((c: any) => ({ pr: c.pr, state: c.state }))).toEqual([
      { pr: 504, state: "ready" },
      { pr: 502, state: "waiting" },
    ]);
    expect(laneSnap.batches[1].map((c: any) => ({ pr: c.pr, state: c.state }))).toEqual([
      { pr: 503, state: "verifying" },
    ]);
  });

  it("BR#6012: BaseRedEpisodeState DO defense-in-depth — never grafts generic fix(chat): PRs onto root-fix cards, never warrants bypass on conflicting PRs, skips already-landed legs, and hands the human the exact --admin command + why", async () => {
    const repo = "state-vector/lane-br6012";
    const sink = await kbJson("/create", { type: "task", title: "ALARM SINK drill — br6012", session: "" });
    await kbJson("/admin.settings_set", { settings: { train_alarm_sink_id: String(sink.body.id) } });
    await acquire(repo, "gw-6012", { merge_capable: true, required_workflows: ["deploy / Deploy to dev"] });

    // Held product bugfix PR (`fix(chat): ...` — exact #2555 shape that previously matched /\bfix\b/)
    const cChat = await queueViaAccept({
      repo,
      pr: 2555,
      head: "1".repeat(40),
      title: "Trace: superpositional PR #2555 — fix(chat): classifier propagates total LLM failure (BR#2985)",
    });

    // Episode root-fix card (in_progress, no PR yet)
    const rootFix = await kbJson("/create", {
      type: "task",
      title: "ROOT-FIX (BR#5189 p0): fix main — deploy / Deploy to dev",
      tags: ["root_blocker", "main-red", "p0"],
      project: "superpositional",
      body_md: "root-fix drill",
      meta: { root_fix: { repo, head_sha: "d".repeat(40), base: "main", why: "deploy red", failing: ["deploy / Deploy to dev"], bound_at: Date.now() } },
    });
    expect(rootFix.status).toBe(200);

    const stamp = (entries: any[]) =>
      kbJson("/train.queue_facts", {
        repo,
        base: "main",
        actor: "gw-6012",
        entries,
        base_state: {
          verdict: "red",
          scoped_to_required: true,
          red: [{ name: "deploy / Deploy to dev", url: "https://example.test/deploy-red" }],
          unsettled: [],
        },
      });

    // (1) Generic `fix(chat):` PR in queue must NEVER graft onto rootFix (`fix_in_progress`, no ask)
    expect((await stamp([{ id: cChat, pr: 2555, cls: "waiting" }])).body.error ?? "").toBe("");
    const findOpenAsk = async () => {
      const all = (await kbJson("/search", { q: "lane-br6012", type: "question", limit: 50 })).body.artefacts;
      return all.find((x: any) => String(x.title).startsWith("MERGE TRAIN BLOCKED: base ") && String(x.title).includes(`${repo}@main`) && x.status === "todo") ?? null;
    };
    expect(await findOpenAsk()).toBeNull();
    const snap1 = await laneSnap(repo);
    expect(snap1.base_red_resolution.phase).toBe("fix_in_progress");
    expect(snap1.base_red_resolution.fix_card.id).toBe(rootFix.body.id);
    expect(snap1.base_red_resolution.fix_card.pr).toBeUndefined();

    // (2) Bind cure PR #2800 + an already-landed leg #2817 onto rootFix, but mark #2800 CONFLICTING in queue_facts:
    //     phase must be `cure_pr_conflicting`, `fix_card.conflict === true`, `pr === 2800` (never the landed #2817), and NO ask!
    await kbJson("/update", {
      id: rootFix.body.id,
      meta: {
        root_fix: { repo, head_sha: "d".repeat(40), base: "main", why: "deploy red", failing: ["deploy / Deploy to dev"], bound_at: Date.now() },
        prs: [
          { repo, number: 2800, head_sha_at_acceptance: "2".repeat(40) },
          { repo, number: 2817, head_sha_at_acceptance: "3".repeat(40) },
        ],
        merge_train: {
          legs: {
            "2817": { state: "landed", merge_sha: "9".repeat(40) },
          },
        },
      },
    });
    expect((await stamp([{ id: rootFix.body.id, pr: 2800, cls: "conflict" }, { id: cChat, pr: 2555, cls: "waiting" }])).body.error ?? "").toBe("");
    expect(await findOpenAsk()).toBeNull();
    const snap2 = await laneSnap(repo);
    expect(snap2.base_red_resolution.phase).toBe("cure_pr_conflicting");
    expect(snap2.base_red_resolution.fix_card.pr).toBe(2800);
    expect(snap2.base_red_resolution.fix_card.conflict).toBe(true);

    // (3) Agent finishes rebasing #2800 (`cls: "blocked"` — non-conflicting, held only by circular base gate):
    //     phase transitions to `cure_pr_awaiting_force_merge` and the human ask files with the exact `--admin` command + why
    expect((await stamp([{ id: rootFix.body.id, pr: 2800, cls: "blocked" }, { id: cChat, pr: 2555, cls: "waiting" }])).body.error ?? "").toBe("");
    const ask = await findOpenAsk();
    expect(ask).toBeTruthy();
    expect(String(ask.body_md)).toContain(`gh pr merge 2800 --repo ${repo} --admin --squash`);
    expect(String(ask.body_md)).toContain("HUMAN GATE");
    const snap3 = await laneSnap(repo);
    expect(snap3.base_red_resolution.phase).toBe("cure_pr_awaiting_force_merge");
    expect(snap3.base_red_resolution.fix_card.pr).toBe(2800);
    expect(snap3.base_red_resolution.fix_card.conflict).toBeUndefined();

    // (4) #2800 merges (`train.event` kind:"merged" -> awaiting-ci):
    //     phase transitions to `cure_pr_merged_awaiting_ci`, open ask auto-closes (warrantAsk: false),
    //     and `fix_card.merged === true` with `merge_sha` so the UI says MERGED, never "waiting on PR #2800"
    const mergedEv = await kbJson("/train.event", {
      repo,
      base: "main",
      actor: "gw-6012",
      kind: "merged",
      pr: 2800,
      merge_sha: "e96bc222aa349f395be9deb5f683c988043359a4",
      head_sha: "2".repeat(40),
      task_id: rootFix.body.id,
    });
    expect(mergedEv.body.error ?? "").toBe("");
    expect((await stamp([{ id: cChat, pr: 2555, cls: "waiting" }])).body.error ?? "").toBe("");
    expect(await findOpenAsk()).toBeNull();
    const snap4 = await laneSnap(repo);
    expect(snap4.base_red_resolution.phase).toBe("cure_pr_merged_awaiting_ci");
    expect(snap4.base_red_resolution.fix_card.pr).toBe(2800);
    expect(snap4.base_red_resolution.fix_card.merged).toBe(true);
    expect(snap4.base_red_resolution.fix_card.merge_sha).toBe("e96bc222aa349f395be9deb5f683c988043359a4");

    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-6012" });
  });

  it("BR#6179 synthetic dark-tip drill: stamps deploy_coverage into base_state + lane reason + base_red_resolution, fast-pages ONE dark-tip ask past grace, audits redundant run cancellation, and auto-closes the ask once deploy settles green", async () => {
    const repo = "state-vector/lane-br6179-dark-tip";
    const darkTip = "7f5efec26cc5b715ef0ff42eb8ebbf2da0fc1a6f";
    const prevGreen = "ebbe182633c5351f5bcbc9cd6d4924659bd604a2";
    const sink = await kbJson("/create", { type: "task", title: "ALARM SINK drill — br6179", session: "" });
    await kbJson("/admin.settings_set", { settings: { train_alarm_sink_id: String(sink.body.id) } });
    await acquire(repo, "gw-6179", {
      merge_capable: true,
      required_workflows: [
        "deploy / Deploy to dev",
        "post-deploy / Post-Deploy Smoke",
        "post-deploy / DNS chain",
        "post-deploy / Lodestar Storage Health",
      ],
    });
    const car = await queueViaAccept({ repo, pr: 2880, head: "9".repeat(40), title: "FIX: queued car held by dark tip" });

    // (1) Tick 1: Dark tip past grace (17m old), executor auto-dispatched deploy-dev.yml once per sha
    const qf1 = await kbJson("/train.queue_facts", {
      repo,
      base: "main",
      actor: "gw-6179",
      entries: [{ id: car, pr: 2880, cls: "waiting" }],
      base_state: {
        verdict: "empty",
        scoped_to_required: true,
        red: [],
        unsettled: [],
        alarm: "tip carries no check runs at all",
        tip_sha: darkTip,
        tip_age_secs: 1020,
        covered_by: prevGreen,
        coverage_age_secs: 1020,
        deploy_coverage: {
          phase: "uncovered_dispatched",
          tip_sha: darkTip,
          tip_age_secs: 1020,
          workflow: "deploy-dev.yml",
          dispatched_at: Date.now(),
          last_green_sha: prevGreen,
          last_green_run_id: 41780000001,
        },
        cancelled_redundant_runs: [41798949143],
      },
    });
    expect(qf1.body.error ?? "").toBe("");

    const snap1 = await laneSnap(repo);
    // (B) Lane reason + base_red_resolution expose the deploy-coverage summary
    expect(snap1.reason).toContain("unsettled");
    expect(snap1.line).toMatchObject({ phase: "waiting", label: "Deployment requested", remediation: { kind: "machine" } });
    expect(snap1.deploy_dispatched?.sha).toBe(darkTip);
    expect(snap1.deploy_dispatched?.workflow).toBe("deploy-dev.yml");
    expect(snap1.base_red_resolution).toBeTruthy();
    expect(snap1.base_red_resolution.verdict).toBe("unsettled");
    expect(snap1.base_red_resolution.deploy_coverage?.phase).toBe("uncovered_dispatched");
    expect(snap1.base_red_resolution.deploy_coverage?.tip_sha).toBe(darkTip);

    // A dispatched recovery is machine work, not a request for another
    // human decision. The typed line carries the actual next operation.
    expect(snap1.base_red_resolution.ask).toBeNull();

    // (2) Tick 2: Dispatched deploy settles GREEN on 7f5efec2 -> dark-tip episode clears & ask auto-closes!
    const qf2 = await kbJson("/train.queue_facts", {
      repo,
      base: "main",
      actor: "gw-6179",
      entries: [{ id: car, pr: 2880, cls: "ready" }],
      base_state: {
        verdict: "green",
        scoped_to_required: true,
        red: [],
        unsettled: [],
        tip_sha: darkTip,
        tip_age_secs: 1500,
        covered_by: darkTip,
        coverage_age_secs: 0,
        deploy_coverage: {
          phase: "covered",
          tip_sha: darkTip,
          tip_age_secs: 1500,
          covered_by_sha: darkTip,
          covered_by_run_id: 41798951196,
        },
      },
    });
    expect(qf2.body.error ?? "").toBe("");

    const snap2 = await laneSnap(repo);
    expect(snap2.base_red_resolution).toBeUndefined();

    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-6179" });
  });

  it("BR#6389: a red tip with an empty queue gets one repair, live progress, then a clear human escalation when exhausted", async () => {
    const repo = "state-vector/line-recovery-6389";
    const sink = await kbJson("/create", { type: "task", title: "Line recovery alarm sink" });
    await kbJson("/admin.settings_set", { settings: { train_alarm_sink_id: sink.body.id } });
    await acquire(repo, "gw-6389", { required_workflows: ["Deploy Dev"] });
    const stamp = () => kbJson("/train.queue_facts", {
      repo, actor: "gw-6389", entries: [], base_state: { verdict: "red", tip_sha: "6".repeat(40), red: [{ name: "Deploy Dev", url: "https://github.com/run/6389" }], unsettled: [] },
    });
    expect((await stamp()).body.error ?? "").toBe("");
    const first = await laneSnap(repo);
    expect(first.line).toMatchObject({ phase: "stopped", held: 0, remediation: { kind: "queued" } });
    const repair = first.base_red_resolution.fix_card.id;
    await stamp();
    expect((await laneSnap(repo)).base_red_resolution.fix_card.id).toBe(repair);
    const claim = await kbJson("/transition", { id: repair, to: "in_progress", actor: "repair-agent", session: "repair-6389" });
    expect(claim.body.error ?? "").toBe("");
    await kbJson("/progress.log", { id: repair, actor: "repair-agent", session: "repair-6389", did: "Found the missing deploy permission", will: "Restore deployment permission", completion_pct: 40 });
    expect((await laneSnap(repo)).line).toMatchObject({ remediation: { kind: "agent", task: { last_progress: { note: "Found the missing deploy permission", completion_pct: 40 } } } });
    await kbJson("/update", { id: repair, meta: { attempt: { attempts: 3 }, escalate: { reason: "No permission to restore deploy role" } } });
    await stamp();
    const exhausted = await laneSnap(repo);
    expect(exhausted.line.remediation.kind).toBe("human");
    expect(exhausted.line.remediation.action.url).toContain("/card/");
    // A subsequent real submission supersedes historical watchdog failures,
    // without making an unreviewed PR eligible for train admission.
    await kbJson("/update", { id: repair, meta_delete: ["escalate"] });
    const submitted = await kbJson("/transition", { id: repair, to: "in_review", actor: "repair-agent", session: "repair-6389",
      note: `PR https://github.com/${repo}/pull/6587 — delivered repair awaiting independent review` });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    await stamp();
    const reviewing = await laneSnap(repo);
    expect(reviewing.base_red_resolution.phase).toBe("fix_in_progress");
    expect(reviewing.base_red_resolution.ask).toBeNull();
    expect(reviewing.line.remediation.kind).toBe("queued");
    expect(reviewing.queue.some((q: { id: string }) => q.id === repair)).toBe(false);
    expect((await kbJson("/get", { id: exhausted.line.remediation.action.id })).body.status).toBe("done");
    // A concrete authority/permission escalation still warrants attention.
    await kbJson("/update", { id: repair, meta: { escalate: { reason: "Deployment credential still unavailable" } } });
    await stamp();
    expect((await laneSnap(repo)).line.remediation.kind).toBe("human");
    await kbJson("/train.queue_facts", { repo, actor: "gw-6389", entries: [], base_state: { verdict: "green", red: [], unsettled: [] } });
    expect((await laneSnap(repo)).line.blocker).toBeNull();
    await kbJson("/train.lease", { repo, action: "release", actor: "gw-6389" });
  });

  it("BR#6389: old gateways' empty plus settling is normalized without a false missing-deployment alarm", async () => {
    const repo = "state-vector/line-settling-6389";
    await acquire(repo, "gw-settling6389", { required_workflows: ["deploy / Deploy to dev"] });
    await kbJson("/train.queue_facts", { repo, actor: "gw-settling6389", entries: [], base_state: {
      verdict: "empty", tip_sha: "a".repeat(40), tip_age_secs: 1000, red: [], unsettled: [],
      deploy_coverage: { phase: "settling", tip_sha: "a".repeat(40), tip_age_secs: 1000, active_run_id: 123, active_run_url: "https://github.com/run/123" },
    } });
    const lane = await laneSnap(repo);
    expect(lane.queue_facts.base_state.verdict).toBe("unsettled");
    expect(lane.line).toMatchObject({ phase: "waiting", remediation: { kind: "machine", url: "https://github.com/run/123" } });
    await kbJson("/train.lease", { repo, action: "release", actor: "gw-settling6389" });
  });
});
