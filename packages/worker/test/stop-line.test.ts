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
  *    and the HUB stops the line — machine state only (BR#5631, 2026-11-03:
  *    NO stop-time human ask; the root-fix card spawns at p0, the culprit
  *    card bounces with the failing runs, a line_green release re-opens the
  *    lane, and the human bypass/manual decision files LATER through the
  *    warranted base-red ask — queue_facts drills in train-hub), green
  *    landing only through the machine-proxy close, a lying train:landed
  *    rejected fail-closed, and every train op demanding the lane lease.
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
  it.each(["todo", "in_progress"])("BR#9233: a different failing head does not repurpose a %s repair", async (oldStatus) => {
    const repo = `state-vector/root-fix-identity-${oldStatus}`, actor = "gw-root-fix-identity";
    const oldHead = "1".repeat(40), head = "2".repeat(40);
    const oldFailure = "Cortex Quality Smoke", failure = "Lodestar Operational Health";
    await acquire(repo, actor, { required_workflows: [failure] });
    const laneId = (await laneSnap(repo)).card;
    const oldProgress = { note: "Keep previous incident work", completion_pct: 80, ts: Date.now() - 60_000 };
    const oldResume = { kind: "terminal_result", generation: 1, attempt_id: "earlier-attempt" };
    const old = await kbJson("/create", {
      type: "task", title: `Repair ${oldFailure} at ${oldHead.slice(0, 9)}`, body_md: "Prior investigation and WIP.",
      qualified: true, roles: ["impl"], tags: ["root_blocker", "main-red", "p0"],
      meta: { child_of_lane: laneId, root_fix: { repo, base: "main", head_sha: oldHead, failing: [oldFailure] },
        last_progress: oldProgress, execution_resume: oldResume },
    });
    expect(old.status).toBe(200);
    if (oldStatus === "in_progress") {
      expect((await kbJson("/transition", {
        id: old.body.id, to: oldStatus, actor: "previous-repair", session: "previous-repair-session",
      })).status).toBe(200);
    }
    const before = (await kbJson("/get", { id: old.body.id })).body;
    const stop = () => kbJson("/train.event", {
      repo, actor, kind: "stopped", merge_sha: head,
      failing: [{ name: failure, conclusion: "failure", url: "https://example/ci/lodestar" }],
    });
    expect((await stop()).status).toBe(200);
    const fresh = (await laneSnap(repo)).lane_state.fix_card;
    expect(fresh.id).not.toBe(old.body.id);
    expect(fresh).toMatchObject({ title: expect.stringContaining(`${head.slice(0, 9)} (${failure})`), status: "todo" });
    expect(fresh.last_progress).toBeUndefined();
    const freshTask = (await kbJson("/get", { id: fresh.id })).body;
    expect(freshTask.meta.root_fix).toMatchObject({ repo, base: "main", head_sha: head, failing: [failure] });
    expect(freshTask.meta.execution_resume).toBeUndefined();
    expect(freshTask.body_md).toContain("https://example/ci/lodestar");
    const after = (await kbJson("/get", { id: old.body.id })).body;
    expect(after).toMatchObject({ status: oldStatus, title: before.title, body_md: before.body_md,
      meta: { root_fix: before.meta.root_fix, last_progress: oldProgress, execution_resume: oldResume } });

    expect((await stop()).status).toBe(200);
    expect((await laneSnap(repo)).lane_state.fix_card.id).toBe(fresh.id);
    expect((await kbJson("/get", { id: fresh.id })).body.meta.root_fix.bound_at).toBe(freshTask.meta.root_fix.bound_at);
  });

  it("BR#9233: an already-rebound generated repair projects its exact identity without old progress", async () => {
    const repo = "state-vector/root-fix-identity-legacy", actor = "gw-root-fix-legacy";
    const head = "3".repeat(40), failure = "Lodestar Operational Health";
    await acquire(repo, actor, { required_workflows: [failure] });
    const laneId = (await laneSnap(repo)).card;
    const stale = await kbJson("/create", {
      type: "task", title: "Older generated repair for Cortex", body_md: "Do not overwrite old investigation.",
      qualified: true, roles: ["impl"], tags: ["root_blocker", "main-red", "p0"],
      meta: { child_of_lane: laneId, root_fix: { repo, base: "main", head_sha: head, failing: [failure], bound_at: Date.now() },
        last_progress: { note: "Previous failing head", completion_pct: 80, ts: Date.now() - 60_000 } },
    });
    expect(stale.status).toBe(200);
    const stop = () => kbJson("/train.event", {
      repo, actor, kind: "stopped", merge_sha: head, failing: [{ name: failure, conclusion: "failure" }],
    });
    expect((await stop()).status).toBe(200);
    const lane = await laneSnap(repo);
    const fix = lane.lane_state.fix_card;
    expect(fix).toMatchObject({ id: stale.body.id, title: expect.stringContaining(`${head.slice(0, 9)} (${failure})`) });
    expect(fix.last_progress).toBeUndefined();
    expect(lane.line.remediation.task.title).toBe(fix.title);
    const stored = (await kbJson("/get", { id: stale.body.id })).body;
    expect(stored).toMatchObject({ title: "Older generated repair for Cortex", body_md: "Do not overwrite old investigation.",
      meta: { last_progress: { note: "Previous failing head" } } });

    const executor = { actor: "exact-repair", session: "exact-repair-session" };
    expect((await kbJson("/transition", { id: fix.id, to: "in_progress", ...executor })).status).toBe(200);
    expect((await kbJson("/progress.log", { id: fix.id, did: "Investigating Lodestar", ...executor })).status).toBe(200);
    expect((await stop()).status).toBe(200);
    expect((await laneSnap(repo)).lane_state.fix_card).toMatchObject({
      id: fix.id, title: fix.title, active_agent: true, last_progress: { note: "Investigating Lodestar" },
    });
  });

  it("red required runs on the merged commit stop the line: NO stop-time human ask (BR#5631) — the root-fix card spawns at p0 with the blame edge, the culprit bounces with the failing runs", async () => {
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

    // 2026-11-03 (BR#5631, from the BR#5626 escalation): NO ask at stop time —
    // the stop is machine state, not a human decision. The culprit bounces
    // (below), the root-fix card spawns at absolute p0 (BR#5190), the lane
    // banner carries what's broken, and the line auto-resumes on green. The
    // human-actionable bypass decision surfaces LATER via the warranted
    // base-red ask once a cure PR binds (queue_facts drills in train-hub).
    expect((await stopAsks("fffffffff")).length).toBe(0);

    // the root-fix card spawned at absolute p0 and carries the blame edge to
    // the culprit (BR#5517 — the ask is gone, the card is the blame source)
    const rf = (await kbJson("/search", { q: "fffffffff", type: "task", limit: 20 })).body.artefacts
      .find((x: any) => String(x.title ?? "").startsWith("ROOT-FIX (BR#5189 p0):"));
    expect(rf, "expected the auto-spawned ROOT-FIX card").toBeTruthy();
    const rfRels = (await kbJson("/relations", { id: rf.id })).body.relations ?? [];
    const blameLink = (rfRels as any[]).find((r) => r.relation === "derived_from" && String(r.artefact_id) === culprit);
    expect(blameLink, `expected a derived_from blame link root-fix → ${culprit}, got ${JSON.stringify(rfRels)}`).toBeTruthy();

    // the culprit: bounced out of the queue with the failing runs in the brief
    const card = (await kbJson("/get", { id: culprit })).body;
    expect(card.status).toBe("in_progress");
    expect(String(card.body_md)).toContain("Merge-train STOP THE LINE");
    expect(String(card.body_md)).toContain("landed as fffffffff and broke main");
    expect(String(card.body_md)).toContain("Test: failure (https://example/ci/red-test)");
    expect(String(card.body_md)).toContain("no auto-revert");
    expect(card.meta?.merge_train?.state).toBe("stopped");

    // same red sha again: still no ask (the episode stays agent-workable),
    // the brief is not re-appended
    const again = await kbJson("/train.ci", {
      repo, base: "main", actor: "gw-red", sha: "f".repeat(40),
      checks: [check(2, "Test", "failure", "https://example/ci/red-test")],
    });
    expect(again.body.decided).toBe("stopped");
    expect((await stopAsks("fffffffff")).length).toBe(0);
    const card2 = (await kbJson("/get", { id: culprit })).body;
    expect(String(card2.body_md).split("Merge-train STOP THE LINE").length - 1).toBe(1);
  });

  it("BR#5517: the stop dings the culprit card's impl/verify sessions — capped train_red on the score board, bystanders untouched, no refund on line_green", async () => {
    const repo = "state-vector/ding-score";
    // a culprit card whose version receipts name its impl + verify legs
    const c = await kbJson("/create", { type: "task", title: "IMPL: ding drill — culprit", actor: "impl-ding-a" });
    expect(c.status).toBe(200);
    const culprit = String(c.body.id);
    const b = await kbJson("/transition", {
      id: culprit, to: "blocked", note: "merge-train: queued", merge_train: true,
      unblock_condition: "the merge train advances this card — no agent action needed until it bounces (then fix per the brief)",
      actor: "verify-ding-a",
    });
    expect(b.status, `park failed: ${JSON.stringify(b.body)}`).toBeLessThan(400);
    // a bystander session: activity on an unrelated card, never on the culprit
    const side = await kbJson("/create", { type: "task", title: "IMPL: ding drill — bystander card" });
    expect(side.status).toBe(200);
    // park the side card (the gate-free merge-train park) so the bystander's
    // progress lands — progress on an unclaimed todo early-returns unclaimed
    const parked = await kbJson("/transition", {
      id: String(side.body.id), to: "blocked", note: "merge-train: queued", merge_train: true,
      unblock_condition: "the merge train advances this card — bystander filler",
      actor: "bystander-ding",
    });
    expect(parked.status, `park failed: ${JSON.stringify(parked.body)}`).toBeLessThan(400);
    const prog = await kbJson("/progress.log", {
      id: String(side.body.id), actor: "bystander-ding",
      note: "unrelated bystander progress note, well past the thin-note bound",
      completion_pct: 40, confidence_pct: 80, risk_pct: 10,
    });
    expect(prog.status, `progress failed: ${JSON.stringify(prog.body)}`).toBeLessThan(400);
    expect(String(prog.body.note_postscript ?? ""), `progress must persist: ${JSON.stringify(prog.body)}`).not.toContain("PROGRESS LOGGED BUT TASK NOT CLAIMED");

    await acquire(repo, "gw-ding", { required_workflows: ["Test"] });
    await kbJson("/train.event", {
      repo, base: "main", kind: "merged", actor: "gw-ding",
      pr: 5517, merge_sha: "9".repeat(40), head_sha: "8".repeat(40), task_id: culprit,
    });
    const red = await kbJson("/train.ci", {
      repo, base: "main", actor: "gw-ding", sha: "9".repeat(40),
      checks: [check(9, "Test", "failure", "https://example/ci/ding-red")],
    });
    expect(red.body.decided).toBe("stopped");

    // the board's agent rows show the ding: every leg the culprit's receipts
    // name (impl + verify + the gateway that bounced it) eats ONE capped
    // train_red
    const agents = (await kbJson("/board")).body.agents as any[];
    const row = (label: string) => agents.find((a: any) => a.label === label);
    for (const label of ["impl-ding-a", "verify-ding-a", "gw-ding"]) {
      const r = row(label);
      expect(r?.train_red, `${label}: ${JSON.stringify(r)}`).toBe(1);
      expect(r.hints.join(" ")).toMatch(/stop-the-line episode/);
    }
    // card legs own nothing: 50 − min(15, 1×5) = 45; the gateway also owns
    // this lane card (+2 artefact bonus), so its ding lands on 47
    expect(row("impl-ding-a").score).toBe(45);
    expect(row("verify-ding-a").score).toBe(45);
    expect(row("gw-ding").score).toBe(47);
    // bystander sessions are untouched
    const by = row("bystander-ding");
    expect(by?.train_red, `bystander row: ${JSON.stringify(by)}`).toBe(0);
    expect(by.hints.join(" ")).not.toMatch(/stop-the-line episode/);
    expect(by.score).toBeGreaterThan(45);

    // clearing the red (line_green release) does NOT refund the ding
    const green = await kbJson("/train.lease", { repo, base: "main", action: "release", line_green: true, actor: "gw-ding" });
    expect(green.body.error ?? "").toBe("");
    const agents2 = (await kbJson("/board")).body.agents as any[];
    const after = agents2.find((a: any) => a.label === "impl-ding-a");
    expect(after?.train_red).toBe(1);
    expect(after?.score).toBe(45);
    expect(agents2.find((a: any) => a.label === "gw-ding")?.score).toBe(47);
  });

  it("only a line_green release re-opens a stopped lane (a plain release never clears the stop)", async () => {
    const repo = "state-vector/lane-green";
    await acquire(repo, "gw-green", { required_workflows: ["Test"] });
    // stopped at admission — red facts with no merge in flight, nothing bounces
    const stopped = await kbJson("/train.event", {
      repo, base: "main", kind: "stopped", actor: "gw-green",
      merge_sha: "e".repeat(40), failing: [{ name: "Test", conclusion: "failure", url: "https://example/ci/red" }],
    });
    expect(stopped.body.error ?? "").toBe("");
    expect((await laneSnap(repo)).stop?.sha).toBe("e".repeat(40));
    // BR#5631: no stop-time ask — the stop is machine state
    expect((await stopAsks("eeeeeeeee")).length).toBe(0);

    // a plain release drops the lease but the line stays stopped
    const plain = await kbJson("/train.lease", { repo, base: "main", action: "release", actor: "gw-green" });
    expect(plain.body.error ?? "").toBe("");
    expect((await laneSnap(repo)).stop?.sha).toBe("e".repeat(40));
    expect(String((await laneSnap(repo)).reason)).toContain("STOPPED");

    // the next gateway reconciles and acquires; a NEW red episode (new sha)
    // still files no ask — every episode is agent-workable until a cure binds
    const back = await acquire(repo, "gw-green");
    expect(back.body.error ?? "").toBe("");
    const again = await kbJson("/train.event", {
      repo, base: "main", kind: "stopped", actor: "gw-green",
      merge_sha: "d".repeat(40), failing: [{ name: "CLI build", conclusion: "timed_out", url: "https://example/ci/red2" }],
    });
    expect(again.body.error ?? "").toBe("");
    expect((await stopAsks("ddddddddd")).length).toBe(0);

    // line_green: the stop clears, the stopped-phase in-flight record drops,
    // and the lane shows the honest idle reason
    const green = await kbJson("/train.lease", { repo, base: "main", action: "release", line_green: true, actor: "gw-green" });
    expect(green.body.error ?? "").toBe("");
    expect(green.body.stop).toBeNull();
    expect(green.body.currently).toBeNull();
    expect(green.body.reason).toBe("merge-train: awaiting an available gateway");
    expect((await laneSnap(repo)).stop).toBeNull();

    // BR#4692: the clear is LOUD — the lane history carries ONE stop_cleared
    // row with the red window (who/when auditable; the plain release above
    // produced none), and the alarm sink gets the stop set → stop cleared note
    const laneCard = (await laneSnap(repo)).card as string;
    expect(laneCard).toBeTruthy();
    const laneHist = ((await kbJson("/get_history", { id: laneCard, limit: 15 })).body?.versions ?? []) as any[];
    const clearedRows = laneHist.filter((v) => v.action === "train:stop_cleared");
    expect(clearedRows.length, `stop_cleared rows: ${JSON.stringify(laneHist.map((v) => [v.action, v.summary]))}`).toBe(1);
    expect(String(clearedRows[0].summary)).toContain("stop auto-cleared on green line");
    expect(String(clearedRows[0].summary)).toContain("red window");
    expect(String(clearedRows[0].summary)).toContain("ddddddddd"); // the episode that was live at clear time
    expect(String(clearedRows[0].summary)).toContain("gw-green"); // who
    const sinkHist = ((await kbJson("/get_history", { id: sinkId, limit: 15 })).body?.versions ?? []) as any[];
    // the sink card is shared across test cases — count only the notes naming
    // THIS lane (exactly one per PR#4692: one note per stop set → cleared)
    const sinkNotes = sinkHist.filter((v) => v.action === "note" && String(v.summary).includes("stop-the-line auto-cleared") && String(v.summary).includes(`${repo}@main`));
    expect(sinkNotes.length, `sink notes: ${JSON.stringify(sinkHist.map((v) => [v.action, v.summary]))}`).toBe(1);
    expect(String(sinkNotes[0].summary)).toContain(`${repo}@main`);
    expect(String(sinkNotes[0].summary)).toContain("red window");
  });

  it("green required runs land through the machine proxy and close the card; the lane idles and the queue advances", async () => {
    const repo = "state-vector/lane-land";
    const card = await parkQueued("IMPL: stop-line drill — green landing");
    await completePrReview(kbJson, card, [{ repo, number: 2703, head_sha_at_acceptance: "b".repeat(40) }]);
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
    // BR#5631: no stop-time ask on the fail-closed class either — the
    // root-fix card owns the diagnosis (unknowns are agent-workable)
    expect((await stopAsks("888888888")).length).toBe(0);
    // the culprit bounced like any other stop
    expect((await kbJson("/get", { id: card })).body.status).toBe("in_progress");
  });

  it("every train op demands the lane lease (the lease holder IS the authenticated actor)", async () => {
    const repo = "state-vector/lane-lease";
    // the lane exists and is configured (BR#4691) — so a leaseless op fails
    // on the LEASE law, not on lane config
    await kbJson("/train.lane", { repo, base: "main", actor: "drill", spec: { required_workflows: ["Test"] } });
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

  it("BR#5679: a stopped lane serves base_red_resolution (BROKEN + WHAT FIXES IT), preserves queue_facts across rerun_consumed acks, and clears stop via train.ci when required workflows recover green despite a non-required nightly failure", async () => {
    const repo = "state-vector/lane-br5679";
    const card = await parkQueued("IMPL: br5679 culprit");
    const heldCard = await parkQueued("IMPL: br5679 queued behind stop");
    await acquire(repo, "gw-5679", { required_workflows: ["post-deploy / Post-Deploy Smoke"] });
    const M = "7".repeat(40);
    await kbJson("/train.event", {
      repo, base: "main", kind: "merged", actor: "gw-5679",
      pr: 2743, merge_sha: M, head_sha: "5".repeat(40), task_id: card,
    });

    // Required workflow fails -> stop-the-line
    const stopped = await kbJson("/train.ci", {
      repo, base: "main", actor: "gw-5679", sha: M,
      checks: [check(10, "post-deploy / Post-Deploy Smoke", "failure", "https://example/runs/41576347395/job/125726311965")],
    });
    expect(stopped.body.decided).toBe("stopped");

    // Stamp queue_facts, then send an ack-only rerun_consumed with entries:[] —
    // stored entries must NOT be clobbered, and rerun_failed is omitted when null.
    await kbJson("/train.queue_facts", {
      repo, base: "main", actor: "gw-5679",
      entries: [{ id: heldCard, pr: 2750, cls: "waiting" }],
    });
    await kbJson("/train.queue_facts", {
      repo, base: "main", actor: "gw-5679",
      entries: [],
      rerun_consumed: "nothing-red",
    });

    const snapStopped = await laneSnap(repo);
    expect("rerun_failed" in snapStopped).toBe(false);
    expect(snapStopped.queue_facts?.entries?.length).toBe(1);
    // Stop-mode resolution banner is populated even without queue_facts.base_state
    expect(snapStopped.base_red_resolution).toBeTruthy();
    expect(snapStopped.base_red_resolution.verdict).toBe("red");
    expect(snapStopped.base_red_resolution.whats_broken).toEqual([
      { name: "post-deploy / Post-Deploy Smoke", url: "https://example/runs/41576347395/job/125726311965" },
    ]);
    expect(snapStopped.base_red_resolution.fix_card).toBeTruthy();

    // Post-Deploy Smoke rerun succeeds while a non-required nightly check fails;
    // train.ci clears the stop even when called by a second actor while gw-5679 holds the lease.
    const recovered = await kbJson("/train.ci", {
      repo, base: "main", actor: "gw-reconcile", sha: M,
      checks: [
        check(10, "post-deploy / Post-Deploy Smoke", "failure", "https://example/runs/41576347395/job/125726311965"),
        check(20, "post-deploy / Post-Deploy Smoke", "success", "https://example/runs/41576347395/job/125733260105"),
        check(21, "Guard fixtures (3 draws, boundary-classified)", "failure", "https://example/runs/41579155833/job/125729626874"),
      ],
    });
    expect(recovered.status).toBe(200);
    expect(recovered.body.decided).toBe("line_green");
    expect(recovered.body.stop).toBeNull();

    const snapGreen = await laneSnap(repo);
    expect(snapGreen.stop).toBeNull();
    expect(snapGreen.currently).toBeNull();
    expect(snapGreen.base_red_resolution ?? null).toBeNull();
  });
});

describe("train.status red-main episode — who broke it / who is fixing it (BR#4849)", () => {
  it("shows only the exact main-red recovery, stamps the stop's culprit, and clears both on green", async () => {
    const repo = "state-vector/red-banner";
    const head = "c".repeat(40);
    await acquire(repo, "gw-banner", { required_workflows: ["Deploy Dev"] });

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

    // Project and tags alone cannot associate an open task with the failure.
    const ep = await kbJson("/create", {
      type: "task",
      title: "ROOT BLOCKER (main-red): banner drill — Deploy Dev red on main",
      tags: ["root-blocker", "main-red"],
      project: "red-banner",
      meta: { completion: { kind: "execution", outcome: "The main-red episode is resolved on verified live evidence" } },
    });
    expect(ep.status, `create failed: ${JSON.stringify(ep.body)}`).toBeLessThan(400);
    const epId = String(ep.body.id);
    expect((await laneSnap(repo)).red_main).toBeNull();

    // a fed stop stamps the machine culprit on the stop record itself — the
    // banner's "who broke it" then points at the card, not a guess
    const stopped = await kbJson("/train.event", {
      repo, base: "main", kind: "stopped", actor: "gw-banner",
      merge_sha: head, culprit_task: anchor,
      failing: [{ name: "Deploy Dev", conclusion: "failure", url: "https://example/ci/deploy-red" }],
    });
    expect(stopped.body.error ?? "", `train:stopped failed: ${JSON.stringify(stopped.body)}`).toBe("");
    snap = await laneSnap(repo);
    expect(snap.stop?.culprit_task).toBe(anchor);
    expect(snap.red_main?.task_id).not.toBe(epId);

    const otherBase = await kbJson("/update", {
      id: epId, meta: { root_fix: { repo, base: "release", head_sha: head, failing: ["Deploy Dev"] } },
    });
    expect(otherBase.status, `other base binding failed: ${JSON.stringify(otherBase.body)}`).toBeLessThan(400);
    expect((await laneSnap(repo)).red_main?.task_id).not.toBe(epId);

    const bind = await kbJson("/update", {
      id: epId, meta: { root_fix: { repo, base: "main", head_sha: head, failing: ["Deploy Dev"] } },
    });
    expect(bind.status, `binding failed: ${JSON.stringify(bind.body)}`).toBeLessThan(400);
    snap = await laneSnap(repo);
    expect(snap.red_main?.task_id).toBe(epId);
    expect(snap.red_main?.status).toBe("todo");
    expect(snap.red_main?.owner).toBe("");
    expect(snap.red_main?.executor_session).toBe("");

    // "who is fixing it" going from UNOWNED to named is board fact
    const claim = await kbJson("/transition", {
      id: epId, to: "in_progress", session: "banner-drill-fixer", note: "diagnosing the query-engine invoke failure",
    });
    expect(claim.status, `claim failed: ${JSON.stringify(claim.body)}`).toBeLessThan(400);
    const heartbeat = await kbJson("/progress.log", {
      id: epId, session: "banner-drill-fixer", did: "Confirmed the failure", will: "Verify the retry",
    });
    expect(heartbeat.status, `heartbeat failed: ${JSON.stringify(heartbeat.body)}`).toBeLessThan(400);
    snap = await laneSnap(repo);
    expect(snap.red_main?.task_id).toBe(epId);
    expect(snap.red_main?.status).toBe("in_progress");
    expect(snap.red_main?.executor_session).toBe("banner-drill-fixer");

    // A live passing result clears the stop. The owner can then close with
    // that receipt through the independent execution review gate (BR#7564).
    const green = await kbJson("/train.ci", {
      repo, base: "main", actor: "gw-banner", sha: head,
      checks: [check(2, "Deploy Dev", "success")],
    });
    expect(green.body.decided).toBe("line_green");
    await completeExecutionReview(kbJson, epId, {
      outcome: "drill: main settled green — Deploy Dev SUCCESS at tip, merge gate cleared",
      receipts: ["drill: Deploy Dev SUCCESS at tip, merge gate cleared"],
    });
    snap = await laneSnap(repo);
    expect(snap.stop).toBeNull();
    expect(snap.red_main).toBeNull();
    expect(snap.last_merge?.pr).toBe(2710);
  });
});
import { completeExecutionReview, completePrReview } from "./completion-fixture";
