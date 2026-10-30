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
  return body.lanes[0];
}

/** The REAL accept chain: impl card + review-role verify duty closed done
 *  citing the head it verified + the PR — the hub stamps meta.pr and queues
 *  the card onto the train. Exactly what a verify convention close looks
 *  like; zero GitHub anywhere. */
async function queueViaAccept(opts: { repo: string; pr: number; head?: string | null; title?: string; session?: string }): Promise<string> {
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
  return implId;
}

describe("merge train DO drill (real bundled worker)", () => {
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

  it("a merge-tree conflict bounces the head card with the fix-up brief (verdict INVALID) and the queue advances", async () => {
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

    // the executor's trial rebase hit conflicts → bounce with the file list,
    // NAMING THE KIND (BR#4066: every bounce carries coverage|conflict|gate)
    const bounced = await kbJson("/train.event", {
      repo, base: "main", kind: "bounced", actor: "gw-b", pr: 2601, head_sha: "b".repeat(40),
      bounce_kind: "conflict", merge_state_status: "dirty",
      conflict_files: ["packages/worker/src/kb/do.ts", "packages/contracts/src/mcp.ts"],
    });
    expect(bounced.body.error ?? "", `train:bounced failed: ${JSON.stringify(bounced.body)}`).toBe("");
    expect(bounced.body.task).toBe(c1);
    expect(bounced.body.bounce_kind).toBe("conflict");

    const card1 = (await kbJson("/get", { id: c1 })).body;
    expect(card1.status).toBe("in_progress");
    expect(card1.meta?.merge_train?.state).toBe("bounced");
    expect(String(card1.body_md)).toContain("Merge-train bounce (conflict): PR #2601");
    expect(String(card1.body_md)).toContain("- `packages/worker/src/kb/do.ts`");
    expect(String(card1.body_md)).toContain("- `packages/contracts/src/mcp.ts`");
    expect(String(card1.body_md)).toContain("INVALID at the new head");
    expect(String(card1.body_md)).toContain("the impl repair leg");
    expect(String(card1.body_md)).toContain("machine-clean carries, human-resolved invalidates");
    expect(String(card1.body_md)).toContain("re-queues at the BACK");
    // the transition note names the kind too — not a generic "conflicts with base"
    const bounceHist = (await kbJson("/get_history", { id: c1, limit: 5 })).body;
    expect(JSON.stringify(bounceHist)).toContain("merge-train bounce (conflict) — PR #2601 conflicts with base (2 file(s))");

    // the lane freed; the follower is now the whole queue
    const after = await laneSnap(repo);
    expect(after.currently).toBeNull();
    expect(after.queue.map((x: any) => x.id)).toEqual([c2]);
  });

  it("a COVERAGE bounce (head moved past the accepted verdict, BR#4066) parks the card Awaiting — NO conflict language, NO self-heal re-entry, ZERO duty spam (BR#4962 retires the BR#4428/BR#4494 self-heal)", async () => {
    const repo = "state-vector/lane-coverage";
    const H = "e".repeat(40);
    const c1 = await queueViaAccept({ repo, pr: 2611, head: H, title: "IMPL: coverage bounce drill" });
    await acquire(repo, "gw-c", { required_workflows: ["Test"] });
    // an authored push moved the head past the stamp: no conflicts exist
    const bounced = await kbJson("/train.event", {
      repo, base: "main", kind: "bounced", actor: "gw-c", pr: 2611, head_sha: H, task_id: c1,
      bounce_kind: "coverage", merge_state_status: "clean",
      reason: `PR #2611 live head ${H} is not covered by the accepted verdict (leg 1 stamped ${H.slice(0, 9)}, no contiguous carry chain) — head moved past the verdict without a machine-clean update; re-verify at the new head`,
    });
    expect(bounced.body.error ?? "", `coverage bounce failed: ${JSON.stringify(bounced.body)}`).toBe("");
    expect(bounced.body.bounce_kind).toBe("coverage");
    expect(bounced.body.awaiting_park).toBe(true);
    const card1 = (await kbJson("/get", { id: c1 })).body;
    // the park refreshes IN PLACE: blocked under the typed Awaiting reason —
    // the BR#4428/BR#4494 self-heal (in_review re-entry + spawned re-verify
    // duty per bounce) is RETIRED: the parked card IS the human leg (BR#4960)
    expect(card1.status).toBe("blocked");
    expect(card1.meta?.merge_train?.state).toBe("awaiting");
    expect(card1.meta?.merge_train?.awaiting?.head_sha).toBe(H);
    expect(String(card1.meta?.blocked?.reason)).toMatch(/^Awaiting review \(verdict BR#\d+, anchored at head [0-9a-f]{9}\)$/);
    // the lie that sent impl hunting for nonexistent conflicts stays gone —
    // a lapsed verdict is not a conflict, and no bounce brief rides the card
    expect(String(card1.body_md ?? "")).not.toContain("conflicts with its base");
    expect(String(card1.body_md ?? "")).not.toContain("Conflicting files");
    expect(String(card1.body_md ?? "")).not.toContain("no file list supplied");
    // zero re-verify duty spam — the old self-heal spawned one per bounce
    expect(((await kbJson("/list", { type: "task", limit: 200 })).body?.artefacts ?? [])
      .filter((a: any) => a.title === "Verify: IMPL: coverage bounce drill" && ["todo", "in_progress", "blocked"].includes(a.status))).toHaveLength(0);
    // the park is loud on the audit chain; the old bounce note is gone
    const hist = JSON.stringify(await (await kbJson("/get_history", { id: c1, limit: 8 })).body);
    expect(hist).toContain("parked Awaiting review");
    expect(hist).toContain("no ask filed (BR#4960)");
    expect(hist).not.toContain("merge-train bounce (coverage) — PR #2611 head moved past the accepted verdict");
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
    // the re-queue note is honest: this cycle moved a stamp, so it says so
    const hist = await kbJson(`/history?id=${encodeURIComponent(implId)}&limit=20`);
    const queuedNotes = (hist.body.versions as any[]).filter((v) => v.action === "train_queued").map((v) => String(v.summary));
    expect(queuedNotes.length).toBe(2);
    expect(queuedNotes[0]).toContain("(re-queued, stamp refreshed)");
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

  it("BR#4962 (per BR#4960): a coverage bounce parks the card Awaiting IN PLACE — typed reason + boost, the typed pr_merged leg survives, ZERO asks, the lane panel lists the park", async () => {
    const repo = "state-vector/lane-await-park";
    const HEAD = "b".repeat(40);
    const card = await queueViaAccept({ repo, pr: 3101, head: HEAD, title: "IMPL: awaiting-park drill" });
    await acquire(repo, "gw-park", { required_workflows: ["Test"] });
    // the typed machine leg production stamps on the park (the verify session
    // passes await_event pr_merged on the queue transition) — the park must
    // carry it through its in-place meta write
    const c0 = (await kbJson("/get", { id: card })).body;
    await kbJson("/update", { id: card, meta: { ...c0.meta, blocked: { ...(c0.meta.blocked ?? {}), await_event: { event: "pr_merged", repo, n: 3101 } } } });

    // the head moved past the accepted verdict → COVERAGE bounce: a lapsed
    // verdict, NOT a defect — the card parks blocked under the typed reason
    const bounced = await kbJson("/train.event", {
      repo, base: "main", kind: "bounced", actor: "gw-park", pr: 3101, task_id: card,
      head_sha: HEAD, bounce_kind: "coverage", merge_state_status: "behind",
      reason: "PR #3101 head moved past the accepted verdict",
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
    expect(c.meta?.merge_train?.awaiting?.head_sha).toBe(HEAD);
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
    expect(h).toContain("no ask filed (BR#4960)");
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

  it("BR#4962: a second coverage bounce refreshes the SAME park (one row, newest anchor) and force-review approve re-anchors the verdict at the parked head — carry leg via force-review, queued in place, zero asks", async () => {
    const repo = "state-vector/lane-force";
    const H1 = "1".repeat(40), H2 = "2".repeat(40), H3 = "3".repeat(40);
    const card = await queueViaAccept({ repo, pr: 3201, head: H1, title: "IMPL: force-review drill" });
    await acquire(repo, "gw-force", { required_workflows: ["Test"] });

    // park #1 at H2 (the head moved once)
    expect((await kbJson("/train.event", { repo, base: "main", kind: "bounced", actor: "gw-force", pr: 3201, task_id: card, head_sha: H2, bounce_kind: "coverage" })).body.error ?? "").toBe("");
    let lane = await laneSnap(repo);
    expect((lane.awaiting ?? []).length).toBe(1);
    expect(lane.awaiting[0].head_sha).toBe(H2);
    const at1 = Number((await kbJson("/get", { id: card })).body.meta?.merge_train?.awaiting?.at ?? 0);

    // park #2 at H3 (moved again): the SAME card refreshes IN PLACE — one
    // awaiting row, the anchor moves to H3, the park timestamp re-stamps
    expect((await kbJson("/train.event", { repo, base: "main", kind: "bounced", actor: "gw-force", pr: 3201, task_id: card, head_sha: H3, bounce_kind: "coverage" })).body.error ?? "").toBe("");
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
    const H = "4".repeat(40);
    const card = await queueViaAccept({ repo, pr: 3301, head: H, title: "IMPL: request-changes drill" });
    await acquire(repo, "gw-rc", { required_workflows: ["Test"] });
    expect((await kbJson("/train.event", { repo, base: "main", kind: "bounced", actor: "gw-rc", pr: 3301, task_id: card, head_sha: H, bounce_kind: "coverage" })).body.error ?? "").toBe("");

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
    expect((await kbJson("/train.event", { repo, base: "main", kind: "bounced", actor: "gw-chip", pr: 3501, task_id: card, head_sha: H8, bounce_kind: "coverage" })).body.error ?? "").toBe("");
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
    expect((await kbJson("/train.event", { repo, base: "main", kind: "bounced", actor: "gw-chip", pr: 3502, task_id: card2, head_sha: H9, bounce_kind: "coverage" })).body.error ?? "").toBe("");
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

    // park → approve → the train's own queue derivation picks it up
    expect((await kbJson("/train.event", { repo, base: "main", kind: "bounced", actor: "gw-land", pr: 3601, task_id: card, head_sha: H2, bounce_kind: "coverage" })).body.error ?? "").toBe("");
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

    // the merge lands at the carried head — one chain leg, never two
    const merged = await kbJson("/train.event", {
      repo, base: "main", kind: "merged", actor: "gw-upd",
      pr: 4687, merge_sha: "9".repeat(40), head_sha: B, task_id: card,
    });
    expect(merged.body.error ?? "", `train:merged failed: ${JSON.stringify(merged.body)}`).toBe("");
    const c2 = (await kbJson("/get", { id: card })).body;
    const carry2 = c2.meta?.prs?.find((l: any) => l.number === 4687)?.carry ?? (c2.meta?.pr?.number === 4687 ? c2.meta?.pr?.carry : undefined);
    expect(carry2).toHaveLength(1);

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
    const mine1 = asks1.body.artefacts.filter((x: any) => x.type === "question" && String(x.title).includes(`${repo}@main`));
    expect(mine1.length).toBe(1);

    // a second read (and the alarm sweep riding the alarm tick) must NOT
    // re-broadcast, re-stamp, or re-ask: once per episode
    await kbJson("/train.status", { repo });
    const after2 = await starvedEvents();
    expect(after2.length).toBe(after1.length);
    expect((await kbJson("/get", { id: laneCard })).body.meta.lane.starved_since).toBe(stamped1);
    const asks2 = await kbJson("/search?q=starved&type=question&limit=50");
    expect(asks2.body.artefacts.filter((x: any) => x.type === "question" && String(x.title).includes(`${repo}@main`)).length).toBe(1);

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
    const t = await kbJson("/transition", { id: laneCard, to: "done", actor: "drill", session: "drill", note: "DRILL RESIDUE — lane retired, will never tick again" });
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
    const closed = await kbJson("/transition", { id: old.card, to: "done", actor: "gw-fr", note: "drill: retire with no reseed registered (owner close)" });
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

    // the OWNER may close their own claimed infra card (ownership is the
    // other legal path — the guard never fences the owner out)
    const okOwner = await kbJson("/transition", { id: String(infra.body.id), to: "done", actor: "duty-BR-drill", note: "owner closes own infra card — receipts: drill" });
    expect(okOwner.status).toBeLessThan(400);

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

    // the head bounces (coverage) — its hold flips to awaiting-review and
    // the reason speaks human: no "gate", no "attempting", no jargon
    await kbJson("/train.event", {
      repo, base: "main", kind: "bounced", actor: "gw-plain", pr: 51143, task_id: card1,
      head_sha: H1, bounce_kind: "coverage",
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
