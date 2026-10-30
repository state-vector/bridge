import { Miniflare } from "miniflare";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  classifyMainCheckRuns,
  stopLineAskTitle,
  MAIN_RED_CONCLUSIONS,
  type MainCheckRun,
} from "../src/kb/core.ts";

/**
 * Destination-green stop-the-line (BR#3008) guards.
 *
 * Two tiers, mirroring the gate's two halves:
 *  - the pure classifier (the same decision rule as
 *    scripts/main-green-gate.sh) pinned case by case;
 *  - the merge train's stop-the-line drills against the REAL bundled worker —
 *    no canned GitHub and no hub-side VCS credentials (BR#3516 §8 deleted the
 *    hub sweeps): the executor feeds CI facts through train.ci / train.event,
 *    and the HUB stops the line — ONE time-sensitive ask per red episode bound
 *    to the alarm sink (deduped per sha), the culprit card bounced with the
 *    failing runs, a line_green release re-opening the lane, green landing
 *    only through the machine-proxy close, a lying train:landed rejected
 *    fail-closed, and every train op demanding the lane lease.
 */

// ---------- tier 1: the decision rule (pure) ----------

const run = (id: number, name: string, conclusion: string | null, url = `https://example/run/${id}`): MainCheckRun => ({
  id, name, status: conclusion == null ? "in_progress" : "completed", conclusion, html_url: url,
});

describe("classifyMainCheckRuns (the stop-the-line decision rule)", () => {
  it("empty check-run list is empty, never green (vacuity guard)", () => {
    expect(classifyMainCheckRuns([]).verdict).toBe("empty");
    expect(classifyMainCheckRuns([run(1, "Test", null)]).verdict).toBe("unsettled");
  });

  it("all settled green is green", () => {
    const v = classifyMainCheckRuns([run(1, "Test", "success"), run(2, "CLI", "success"), run(3, "Drift", "skipped")]);
    expect(v.verdict).toBe("green");
    expect(v.green).toBe(3);
    expect(v.red).toEqual([]);
  });

  it("any failure is red and names the check with its run URL", () => {
    const v = classifyMainCheckRuns([run(1, "Test", "failure", "https://example/red/Test"), run(2, "CLI", "success")]);
    expect(v.verdict).toBe("red");
    expect(v.red).toEqual([{ name: "Test", conclusion: "failure", url: "https://example/red/Test" }]);
    expect(v.green).toBe(1);
  });

  it("every line-stopping conclusion is classified red", () => {
    for (const c of MAIN_RED_CONCLUSIONS) {
      expect(classifyMainCheckRuns([run(1, "X", c)]).verdict).toBe("red");
    }
  });

  it("the NEWEST run judges: an old failure superseded by a newer success is green", () => {
    expect(classifyMainCheckRuns([run(100, "Test", "failure"), run(900, "Test", "success")]).verdict).toBe("green");
  });

  it("a cancelled newest run says nothing — the older failure still judges", () => {
    const v = classifyMainCheckRuns([run(100, "Test", "failure"), run(900, "Test", "cancelled")]);
    expect(v.verdict).toBe("red");
    expect(v.red[0]?.url).toBe("https://example/run/100");
  });

  it("in-flight checks are unsettled (an unsettled main does not vouch)", () => {
    const v = classifyMainCheckRuns([run(1, "Test", "success"), run(2, "CLI", null)]);
    expect(v.verdict).toBe("unsettled");
    expect(v.unsettled).toContain("CLI");
  });

  it("only-cancelled runs are unsettled, not green", () => {
    expect(classifyMainCheckRuns([run(1, "Test", "cancelled")]).verdict).toBe("unsettled");
  });

  it("red wins over unsettled (a failure stops the line regardless of other noise)", () => {
    const v = classifyMainCheckRuns([run(1, "Test", "failure"), run(2, "CLI", null)]);
    expect(v.verdict).toBe("red");
  });

  it("unknown conclusions fail safe as unsettled", () => {
    expect(classifyMainCheckRuns([run(1, "Test", "weird_future_conclusion")]).verdict).toBe("unsettled");
  });
});

describe("stopLineAskTitle (one ask per red episode)", () => {
  it("embeds the sha so each episode has a distinct, dedupeable title", () => {
    const t = stopLineAskTitle("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ["Test"]);
    expect(t).toContain("aaaaaaaaa");
    expect(t.endsWith("?")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(240);
  });

  it("same sha + same names -> byte-identical title (the dedupe key); names differ -> different episode", () => {
    expect(stopLineAskTitle("a".repeat(40), ["Test"])).toBe(stopLineAskTitle("a".repeat(40), ["Test"]));
    expect(stopLineAskTitle("a".repeat(40), ["Test"])).not.toBe(stopLineAskTitle("b".repeat(40), ["Test"]));
    expect(stopLineAskTitle("a".repeat(40), ["Test"])).not.toBe(stopLineAskTitle("a".repeat(40), ["Test", "CLI"]));
  });

  it("long matrix job names never break the 240-char ask contract", () => {
    const t = stopLineAskTitle("c".repeat(40), [
      "build (ubuntu-24.04-arm, aarch64-unknown-linux-gnu)",
      "build (macos-latest, aarch64-apple-darwin)",
      "build (ubuntu-latest, x86_64-unknown-linux-gnu)",
      "build (macos-latest, x86_64-apple-darwin)",
    ]);
    expect(t.length).toBeLessThanOrEqual(240);
    expect(t.endsWith("?")).toBe(true);
  });
});

// ---------- tier 2: the train's stop-the-line drills (real DO, no GitHub) ----------
// The hub holds no VCS credentials (BR#3516 §8 — the canned-GitHub sweeps are
// deleted), so the drill FEEDS red/green facts through the train ops exactly
// as the former Node executor did, and asserts the hub's decisions. Each test
// works its own lane (distinct repo) so episodes never cross-talk; the alarm
// ask is bound to a drill-local sink via the `train_alarm_sink_id` setting
// (production default BR#3124).

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

const check = (id: number, name: string, conclusion: string | null, url = `https://example/ci/${id}`): MainCheckRun =>
  ({ id, name, status: conclusion == null ? "in_progress" : "completed", conclusion, html_url: url });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  // same rig recipe as kb-throughput.test.ts: realpath + modulesRoot + useSQLite
  const { realpathSync } = await import("node:fs");
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
  // the drill DB is fresh: create the local sink card and point the stop ask at it
  const sink = await kbJson("/create", { type: "task", title: "ALARM SINK — train drill", body_md: "test-local ask sink", tags: ["alarm"] });
  expect(sink.status).toBe(200);
  sinkId = String(sink.body.id);
  const set = await kbJson("/admin.settings_set", { settings: { train_alarm_sink_id: sinkId } });
  expect(set.body.error ?? "").toBe("");
});

afterAll(async () => {
  await mf?.dispose();
});

/** Park an impl card as train-queued (blocked, merge-train reason) — the
 *  state a card sits in while its PR waits at the head of the queue. The
 *  culprit bounce at stop requires blocked (the bounce transition is
 *  blocked → in_progress). */
async function parkQueued(title: string): Promise<string> {
  const c = await kbJson("/create", { type: "task", title });
  expect(c.status).toBe(200);
  const id = String(c.body.id);
  const b = await kbJson("/transition", {
    id, to: "blocked", note: "merge-train: queued", merge_train: true,
    unblock_condition: "the merge train advances this card — no agent action needed until it bounces (then fix per the brief)",
    actor: "drill",
  });
  expect(b.status, `park failed: ${JSON.stringify(b.body)}`).toBeLessThan(400);
  return id;
}

const acquire = (repo: string, actor: string, extra: Record<string, unknown> = {}) =>
  kbJson("/train.lease", { repo, base: "main", action: "acquire", actor, ...extra });

async function laneSnap(repo: string): Promise<any> {
  const { body } = await kbJson("/train.status", { repo });
  return body.lanes[0];
}

async function stopAsks(sha9: string): Promise<any[]> {
  const { body } = await kbJson("/search", { q: "MERGE TRAIN STOP THE LINE", limit: 50 });
  return (body?.artefacts ?? []).filter((a: any) => a.type === "question" && String(a.title).includes(sha9));
}

describe("train stop-the-line (real DO — executor-fed red, hub decides)", () => {
  it("red required runs on the merged commit stop the line: ONE time-sensitive ask to the sink (deduped per episode) + the culprit bounced with the failing runs", async () => {
    const repo = "state-vector/superpositional";
    const culprit = await parkQueued("IMPL: stop-line drill — culprit");
    const got = await acquire(repo, "gw-red", { required_workflows: ["Test"] });
    expect(got.body.error ?? "").toBe("");
    const merged = await kbJson("/train.event", {
      repo, base: "main", kind: "merged", actor: "gw-red",
      pr: 2701, merge_sha: "f".repeat(40), head_sha: "a".repeat(40), task_id: culprit,
    });
    expect(merged.body.error ?? "", `train:merged failed: ${JSON.stringify(merged.body)}`).toBe("");

    const red = await kbJson("/train.ci", {
      repo, base: "main", actor: "gw-red", sha: "f".repeat(40),
      checks: [check(2, "Test", "failure", "https://example/ci/red-test")],
    });
    expect(red.status, `train.ci failed: ${JSON.stringify(red.body)}`).toBeLessThan(400);
    expect(red.body.decided).toBe("stopped");

    // the lane shows the stop
    const snap = await laneSnap(repo);
    expect(snap.stop.sha).toBe("f".repeat(40));
    expect(String(snap.reason)).toContain("STOPPED");
    expect(snap.currently.phase).toBe("stopped");

    // ONE ask, bound to the drill sink, time-sensitive, honest about the culprit
    const asks = await stopAsks("fffffffff");
    expect(asks.length).toBe(1);
    const ask = (await kbJson("/get", { id: asks[0].id })).body;
    expect(ask.meta?.ask?.urgency).toBe("time-sensitive");
    expect(ask.meta?.ask?.to).toBe("human");
    expect(ask.meta?.ask?.artefact_id).toBe(sinkId);
    expect(String(ask.title)).toContain("superpositional@main");
    expect(String(ask.title)).toContain("fffffffff");
    expect(String(ask.title)).toContain("Test");
    expect(String(ask.title).endsWith("?")).toBe(true);
    expect(String(ask.meta?.ask?.reason)).toContain("merges halt");
    expect(String(ask.body_md ?? ask.meta?.ask?.details ?? "")).toContain("Culprit card");

    // the culprit: bounced out of the queue with the failing runs in the brief
    const card = (await kbJson("/get", { id: culprit })).body;
    expect(card.status).toBe("in_progress");
    expect(String(card.body_md)).toContain("Merge-train STOP THE LINE");
    expect(String(card.body_md)).toContain("landed as fffffffff and broke main");
    expect(String(card.body_md)).toContain("Test: failure (https://example/ci/red-test)");
    expect(String(card.body_md)).toContain("no auto-revert");
    expect(card.meta?.merge_train?.state).toBe("stopped");

    // same red sha again: the ask dedupes, the brief is not re-appended
    const again = await kbJson("/train.ci", {
      repo, base: "main", actor: "gw-red", sha: "f".repeat(40),
      checks: [check(2, "Test", "failure", "https://example/ci/red-test")],
    });
    expect(again.body.decided).toBe("stopped");
    expect((await stopAsks("fffffffff")).length).toBe(1);
    const card2 = (await kbJson("/get", { id: culprit })).body;
    expect(String(card2.body_md).split("Merge-train STOP THE LINE").length - 1).toBe(1);
  });

  it("only a line_green release re-opens a stopped lane (a plain release never clears the stop)", async () => {
    const repo = "state-vector/lane-green";
    await acquire(repo, "gw-green");
    // stopped at admission — red facts with no merge in flight, nothing bounces
    const stopped = await kbJson("/train.event", {
      repo, base: "main", kind: "stopped", actor: "gw-green",
      merge_sha: "e".repeat(40), failing: [{ name: "Test", conclusion: "failure", url: "https://example/ci/red" }],
    });
    expect(stopped.body.error ?? "").toBe("");
    expect((await laneSnap(repo)).stop?.sha).toBe("e".repeat(40));
    expect((await stopAsks("eeeeeeeee")).length).toBe(1);

    // a plain release drops the lease but the line stays stopped
    const plain = await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-green" });
    expect(plain.body.error ?? "").toBe("");
    expect((await laneSnap(repo)).stop?.sha).toBe("e".repeat(40));
    expect(String((await laneSnap(repo)).reason)).toContain("STOPPED");

    // the next gateway reconciles and acquires; a NEW red episode (new sha)
    // files its own ask — per-episode dedupe
    const back = await acquire(repo, "gw-green");
    expect(back.body.error ?? "").toBe("");
    const again = await kbJson("/train.event", {
      repo, base: "main", kind: "stopped", actor: "gw-green",
      merge_sha: "d".repeat(40), failing: [{ name: "CLI build", conclusion: "timed_out", url: "https://example/ci/red2" }],
    });
    expect(again.body.error ?? "").toBe("");
    expect((await stopAsks("ddddddddd")).length).toBe(1);

    // line_green: the stop clears, the stopped-phase in-flight record drops,
    // and the lane shows the honest idle reason
    const green = await kbJson("/train.lease", { repo, base: "main", action: "release", line_green: true, actor: "gw-green" });
    expect(green.body.error ?? "").toBe("");
    expect(green.body.stop).toBeNull();
    expect(green.body.currently).toBeNull();
    expect(green.body.reason).toBe("merge-train: awaiting an available gateway");
    expect((await laneSnap(repo)).stop).toBeNull();
  });

  it("green required runs land through the machine proxy and close the card; the lane idles and the queue advances", async () => {
    const repo = "state-vector/lane-land";
    const card = await parkQueued("IMPL: stop-line drill — green landing");
    await acquire(repo, "gw-mint", { required_workflows: ["Test", "Deploy"] });
    const M = "c".repeat(40);
    const merged = await kbJson("/train.event", {
      repo, base: "main", kind: "merged", actor: "gw-mint",
      pr: 2703, merge_sha: M, head_sha: "b".repeat(40), task_id: card,
    });
    expect(merged.body.error ?? "").toBe("");

    // pending required CI: the lane holds (never merges on unknown)
    const pending = await kbJson("/train.ci", {
      repo, base: "main", actor: "gw-mint", sha: M, checks: [check(3, "Test", null)],
    });
    expect(pending.body.decided).toBe("pending");
    expect(String((await laneSnap(repo)).reason)).toContain("settling on");

    const landed = await kbJson("/train.ci", {
      repo, base: "main", actor: "gw-mint", sha: M,
      checks: [check(4, "Test", "success", "https://example/ci/green-test"), check(5, "Deploy", "success", "https://example/ci/green-deploy")],
    });
    expect(landed.status, `train.ci failed: ${JSON.stringify(landed.body)}`).toBeLessThan(400);
    expect(landed.body.decided).toBe("landed");

    // the machine-proxy close: the card is done, its close note cites the
    // mergeCommit + main green — the done-when's proxy, never prose
    const done = (await kbJson("/get", { id: card })).body;
    expect(done.status).toBe("done");
    expect(done.meta?.merge_train?.state).toBe("landed");
    const h = JSON.stringify(await (await kbJson("/get_history", { id: card, limit: 10 })).body);
    expect(h).toContain("landed via the serialized merge train (BR#3516)");
    expect(h).toContain("machine proxy held: mergeCommit non-null AND required main workflows green");
    expect(h).toContain(`merged as ${M.slice(0, 9)}`);
    expect(h).toContain(`github.com/${repo}/commit/${M}`);
    expect(h).toContain("https://example/ci/green-test");

    // the lane idles WITH the lease still held; the landed card left the queue
    const snap = await laneSnap(repo);
    expect(snap.currently).toBeNull();
    expect(snap.reason).toBe("merge-train: leased by gw-mint — idle");
    expect(snap.queue.map((x: any) => x.id)).not.toContain(card);
    await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-mint" });
    expect((await laneSnap(repo)).reason).toBe("merge-train: awaiting an available gateway");
    // the ledger recorded both legs with the gateway for attribution
    const hist = (await kbJson("/train.history", { repo })).body.events;
    expect(hist.map((e: any) => e.kind)).toEqual(expect.arrayContaining(["merged", "landed"]));
    expect(hist.find((e: any) => e.kind === "landed").gateway).toBe("gw-mint");
  });

  it("a lying train:landed is rejected fail-closed (the hub decides; the executor never self-certifies)", async () => {
    const repo = "state-vector/lane-liar";
    const card = await parkQueued("IMPL: stop-line drill — landed rejection");
    await acquire(repo, "gw-liar", { required_workflows: ["Test"] });
    const M = "9".repeat(40);
    const merged = await kbJson("/train.event", {
      repo, base: "main", kind: "merged", actor: "gw-liar",
      pr: 2704, merge_sha: M, head_sha: "b".repeat(40), task_id: card,
    });
    expect(merged.body.error ?? "").toBe("");

    // red checks cited as landed → rejected, lane holds, card NOT closed
    const lie = await kbJson("/train.event", {
      repo, base: "main", kind: "landed", actor: "gw-liar", pr: 2704, merge_sha: M,
      checks: [check(6, "Test", "failure", "https://example/ci/red")],
    });
    expect(lie.status).toBe(400);
    expect(String(lie.body.error)).toContain("train:landed rejected");
    expect(String(lie.body.error)).toContain("classify red");
    expect(String(lie.body.error)).toContain("post train.ci instead");
    expect((await kbJson("/get", { id: card })).body.status).toBe("blocked");
    expect((await laneSnap(repo)).currently.phase).toBe("awaiting-ci");

    // pending checks cited as landed → rejected too
    const wishful = await kbJson("/train.event", {
      repo, base: "main", kind: "landed", actor: "gw-liar", pr: 2704, merge_sha: M,
      checks: [check(7, "Test", null)],
    });
    expect(wishful.status).toBe(400);
    expect(String(wishful.body.error)).toContain("classify pending");

    // a landed citing some OTHER PR → rejected (must match the in-flight merge)
    const wrong = await kbJson("/train.event", {
      repo, base: "main", kind: "landed", actor: "gw-liar", pr: 9999, merge_sha: M,
      checks: [check(8, "Test", "success")],
    });
    expect(wrong.status).toBe(400);
    expect(String(wrong.body.error)).toContain("must cite the lane's in-flight merge");
    expect((await kbJson("/get", { id: card })).body.status).toBe("blocked");
  });

  it("CI unknown past the fail-closed bound (~3× typical) stops the line without a verdict", async () => {
    const repo = "state-vector/lane-bound";
    const card = await parkQueued("IMPL: stop-line drill — CI bound");
    // typical 0.001 min ⇒ bound = 3 × 60 ms; the next tick is past it
    await acquire(repo, "gw-slow", { required_workflows: ["Test"], ci_typical_minutes: 0.001 });
    const merged = await kbJson("/train.event", {
      repo, base: "main", kind: "merged", actor: "gw-slow",
      pr: 2705, merge_sha: "8".repeat(40), head_sha: "b".repeat(40), task_id: card,
    });
    expect(merged.body.error ?? "").toBe("");
    await sleep(250);

    const stopped = await kbJson("/train.ci", { repo, base: "main", actor: "gw-slow", sha: "8".repeat(40), checks: [] });
    expect(stopped.body.decided).toBe("stopped_bound");
    const snap = await laneSnap(repo);
    expect(snap.stop.reason).toContain("fail-closed bound");
    expect((await stopAsks("888888888")).length).toBe(1);
    // the culprit bounced like any other stop
    expect((await kbJson("/get", { id: card })).body.status).toBe("in_progress");
  });

  it("every train op demands the lane lease (the lease holder IS the authenticated actor)", async () => {
    const repo = "state-vector/lane-lease";
    // no lease at all → both facts ops reject
    const noLease = await kbJson("/train.event", { repo, base: "main", kind: "merged", pr: 1, merge_sha: "a".repeat(40) });
    expect(noLease.status).toBe(400);
    expect(String(noLease.body.error)).toContain("train events require the lane lease");
    const noLeaseCi = await kbJson("/train.ci", { repo, base: "main", sha: "a".repeat(40) });
    expect(noLeaseCi.status).toBe(400);
    expect(String(noLeaseCi.body.error)).toContain("train.ci requires the lane lease");

    // held live by gw-1: a second gateway is rejected everywhere
    const got = await acquire(repo, "gw-1");
    expect(got.body.error ?? "").toBe("");
    const otherEvent = await kbJson("/train.event", { repo, base: "main", kind: "merged", actor: "gw-2", pr: 1, merge_sha: "a".repeat(40) });
    expect(otherEvent.status).toBe(400);
    expect(String(otherEvent.body.error)).toContain("held by gw-1");
    const otherCi = await kbJson("/train.ci", { repo, base: "main", actor: "gw-2", sha: "a".repeat(40) });
    expect(otherCi.status).toBe(400);
    const steal = await acquire(repo, "gw-2");
    expect(steal.status).toBe(400);
    expect(String(steal.body.error)).toContain("stand down this tick");
    const kick = await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-2" });
    expect(kick.status).toBe(400);
    expect(String(kick.body.error)).toContain("only the holder releases");
    // the holder renews and releases freely
    const renew = await kbJson("/train.lease", { repo, base: "main", action: "renew", actor: "gw-1" });
    expect(renew.body.error ?? "").toBe("");
    const rel = await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-1" });
    expect(rel.body.error ?? "").toBe("");
    expect(rel.body.lease).toBeNull();
  });
});

describe("train.status red-main episode — who broke it / who is fixing it (BR#4849)", () => {
  it("derives red_main from the lane project's open root-blocker/main-red task (UNOWNED until claimed), stamps the stop's culprit_task, and drops it when the episode closes", async () => {
    const repo = "state-vector/red-banner";
    await acquire(repo, "gw-banner");

    // a landing first: the ledger's newest merged event anchors "who broke it"
    const anchorCard = await kbJson("/create", { type: "task", title: "IMPL: banner drill — last landed" });
    expect(anchorCard.status).toBe(200);
    const anchor = String(anchorCard.body.id);
    const merged = await kbJson("/train.event", {
      repo, base: "main", kind: "merged", actor: "gw-banner",
      pr: 2710, merge_sha: "b".repeat(40), head_sha: "a".repeat(40), task_id: anchor,
    });
    expect(merged.body.error ?? "", `train:merged failed: ${JSON.stringify(merged.body)}`).toBe("");

    // no episode task yet → red_main null, but the landing anchor is served
    let snap = await laneSnap(repo);
    expect(snap.red_main).toBeNull();
    expect(snap.last_merge?.pr).toBe(2710);
    expect(snap.last_merge?.gateway).toBe("gw-banner");
    expect(snap.last_merge?.task_id).toBe(anchor);

    // the episode record: an open root-blocker/main-red task in the lane's
    // project, unowned — exactly how a real main-red lives on the board
    // (BR#4724/BR#4728 class: filed by a session, nobody owns it)
    const ep = await kbJson("/create", {
      type: "task",
      title: "ROOT BLOCKER (main-red): banner drill — Deploy Dev red on main tip deadbeef",
      tags: ["root-blocker", "main-red"],
      project: "red-banner",
    });
    expect(ep.status, `create failed: ${JSON.stringify(ep.body)}`).toBeLessThan(400);
    const epId = String(ep.body.id);

    snap = await laneSnap(repo);
    expect(snap.red_main?.task_id).toBe(epId);
    expect(snap.red_main?.status).toBe("todo");
    expect(snap.red_main?.owner).toBe("");
    expect(snap.red_main?.executor_session).toBe("");

    // a fed stop stamps the machine culprit on the stop record itself — the
    // banner's "who broke it" then points at the card, not a guess
    const stopped = await kbJson("/train.event", {
      repo, base: "main", kind: "stopped", actor: "gw-banner",
      merge_sha: "c".repeat(40), culprit_task: epId,
      failing: [{ name: "Deploy Dev", conclusion: "failure", url: "https://example/ci/deploy-red" }],
    });
    expect(stopped.body.error ?? "", `train:stopped failed: ${JSON.stringify(stopped.body)}`).toBe("");
    expect((await laneSnap(repo)).stop?.culprit_task).toBe(epId);

    // "who is fixing it" going from UNOWNED to named is board fact
    const claim = await kbJson("/transition", {
      id: epId, to: "in_progress", session: "banner-drill-fixer", note: "diagnosing the query-engine invoke failure",
    });
    expect(claim.status, `claim failed: ${JSON.stringify(claim.body)}`).toBeLessThan(400);
    snap = await laneSnap(repo);
    expect(snap.red_main?.status).toBe("in_progress");
    expect(snap.red_main?.executor_session).toBe("banner-drill-fixer");

    // the line recovers → the episode task leaves the open set → banner gone
    const out = await kbJson("/transition", { id: epId, to: "done", session: "banner-drill-fixer", note: "drill: main settled green — Deploy Dev SUCCESS at tip, merge gate cleared" });
    expect(out.status, `close failed: ${JSON.stringify(out.body)}`).toBeLessThan(400);
    snap = await laneSnap(repo);
    expect(snap.red_main).toBeNull();
    expect(snap.last_merge?.pr).toBe(2710);
  });
});
