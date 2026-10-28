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
    expect(String(mid.reason)).toContain("awaiting CI");

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

    // the executor's trial rebase hit conflicts → bounce with the file list
    const bounced = await kbJson("/train.event", {
      repo, base: "main", kind: "bounced", actor: "gw-b", pr: 2601, head_sha: "b".repeat(40),
      conflict_files: ["packages/worker/src/kb/do.ts", "packages/contracts/src/mcp.ts"],
    });
    expect(bounced.body.error ?? "", `train:bounced failed: ${JSON.stringify(bounced.body)}`).toBe("");
    expect(bounced.body.task).toBe(c1);

    const card1 = (await kbJson("/get", { id: c1 })).body;
    expect(card1.status).toBe("in_progress");
    expect(card1.meta?.merge_train?.state).toBe("bounced");
    expect(String(card1.body_md)).toContain("Merge-train bounce (CONFLICT): PR #2601");
    expect(String(card1.body_md)).toContain("- `packages/worker/src/kb/do.ts`");
    expect(String(card1.body_md)).toContain("- `packages/contracts/src/mcp.ts`");
    expect(String(card1.body_md)).toContain("INVALID at the new head");
    expect(String(card1.body_md)).toContain("machine-clean carries, human-resolved invalidates");
    expect(String(card1.body_md)).toContain("re-queues at the BACK");

    // the lane freed; the follower is now the whole queue
    const after = await laneSnap(repo);
    expect(after.currently).toBeNull();
    expect(after.queue.map((x: any) => x.id)).toEqual([c2]);
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
});
