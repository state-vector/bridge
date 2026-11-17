import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { scoreAgent, LAUNCH_FAILED_RESULT_CLASS } from "../src/kb/core.ts";
import { executorRequest, readyGateway } from "./executor-fixture";

/**
 * BR#14696 — gateway dispatch churn: launch-health fence, verifying-phase
 * acceptance-duty auto-spawn, and observability.
 *
 * W1: a claimed task whose run NEVER signals since claim (no alive stamp, no
 * post-claim ping, no matching progress) is dead-at-launch, not working
 * quietly — the watchdog fences it at launch_fence_minutes (default 2, clamped
 * 1–10) with the captured terminal stderr tail and the launch_failed
 * result_class (score-exempt). Three consecutive dead launches with no healthy
 * launch in between trip the circuit: the failing hosts' claim tokens pause,
 * ONE class alarm duty fires on the train alarm sink, and a young healthy
 * launch resets everything.
 *
 * W2: a recovery episode sitting in verifying with its deployment receipts MET
 * but its repair card unclaimed (todo/blocked) staffs its own acceptance
 * review — the same review-pool duty the in_review flow spawns, deduped by the
 * open-round guard — on the train read AND on an independent_review ask for a
 * card outside in_review. No SoD change: the duty spawns, the verdict stays
 * with a fresh-session reviewer.
 */

const MIN = 60_000;
const sha = (c: string) => c.repeat(40);

let mf: Miniflare;
let kbNs: any;
let scenario = 0;
let hubName = "bootstrap";

const kbJson = async (path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const stub: any = await kbNs.get(kbNs.idFromName(hubName));
  const res = await stub.fetch(`https://kb${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" },
    body: body === undefined ? undefined : JSON.stringify(executorRequest(body)),
  });
  return { status: res.status, body: (await res.json()) as any };
};

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
});

// Every scenario owns its SQLite hub — fence counters, circuit state, settings
// and pause rows must never leak between tests regardless of CI speed.
beforeEach(async () => {
  hubName = `br14696-scenario-${++scenario}`;
  await kbJson("/orient", {});
});

afterAll(async () => { await mf?.dispose(); });

/** A gateway host with a provisioned worker and a live capability advertisement. */
async function gatewayHost(label: string, capacity = 4): Promise<{ label: string; tokenId: string }> {
  const mint = await kbJson("/admin.mint", { label, tags: ["gateway"] });
  expect(mint.status, JSON.stringify(mint.body)).toBe(200);
  const identity = await kbJson("/auth.identify", { bearer: mint.body.secret });
  const call = async (path: string, body: unknown) => {
    const r = await kbJson(path, body);
    return { status: r.status, body: r.body };
  };
  await readyGateway(call, identity.body.token_id, label, capacity);
  return { label, tokenId: identity.body.token_id };
}

type Host = Awaited<ReturnType<typeof gatewayHost>>;

const exec = (host: Host, id: string, command_id: string, command: object, session?: string) =>
  kbJson("/execution", {
    actor: host.label, token_id: host.tokenId, gateway: true, agent: `${host.label}/fixture-worker`,
    ...(session ? { session } : {}), id, command_id, command,
  });

/** Create a dispatchable specimen and get it claimed by the gateway's real
 *  reserve path (the dispatch churn this card tests). The reserve claims by
 *  queue order, so the claimed card may be an earlier released specimen —
 *  the fixture works with whatever the gateway actually claimed. Returns the
 *  claim time the fence reads (status_ts) and the reserved dispatch session. */
async function claimedCard(host: Host, n: number, title = `Dead-at-launch specimen ${n}`): Promise<{ id: string; session: string; status_ts: number }> {
  const created = await kbJson("/create", { type: "task", title, project: "bridge", qualified: true, roles: ["impl"] });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const reserve = await exec(host, "gateway", `reserve-${host.label}-${n}`, { kind: "schedule", mode: "reserve" });
  expect(reserve.body, JSON.stringify(reserve.body)).toMatchObject({ kind: "reserved" });
  const id = String(reserve.body.task_id);
  const card = await kbJson("/get", { id });
  return { id, session: String(reserve.body.session), status_ts: Number(card.body.status_ts) };
}

/** The audit-pairing optimization (a version row + audit of the same fact
 *  within 5s share one ledger row) swallows the release's signal row when the
 *  claim's own transition was the last mutation. A cheap unrelated write in
 *  between keeps the pairing key from matching, so the classifier's exact
 *  input (the watchdog transition signal) always exists under test speed. */
async function canary(n: number): Promise<void> {
  const r = await kbJson("/create", { type: "task", title: `Fence canary ${n} (never claimed)`, qualified: true });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** Claim an existing todo card directly with the host's gateway credential —
 *  the durable claim→gateway binding (executor_start_claims) is what the
 *  circuit pauses, so this path is equivalent for the breaker. */
async function claimDirectly(host: Host, id: string, n: number): Promise<void> {
  const claim = await kbJson("/transition", {
    id, to: "in_progress", actor: host.label, token_id: host.tokenId, gateway: true,
    agent: `${host.label}/fixture-worker`, session: `dispatch-direct-${n}`, note: "direct gateway claim (fixture)",
  });
  expect(claim.status, JSON.stringify(claim.body)).toBeLessThan(400);
}

const sweep = (now: number) => kbJson("/admin.stall_sweep", { now });

async function fenceReleaseNote(id: string): Promise<string> {
  const history = await kbJson("/get_history", { id });
  // versions are newest-first (seq DESC)
  const release = (history.body.versions as any[]).filter(v => v.action === "transition" && v.data?.to === "todo")[0];
  expect(release, JSON.stringify(history.body)).toBeTruthy();
  return String(release.data.note ?? "");
}

const releaseClass = async (id: string): Promise<string | undefined> => {
  const events = await kbJson("/events?since=0&limit=500");
  const watch = (events.body.events as any[]).filter(e => e.op === "transition" && e.actor === "system:watchdog" && e.artefact_id === id);
  return watch.at(-1)?.detail?.result_class;
};

async function stats(): Promise<any> {
  const r = await kbJson("/stats", {});
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}

/** A card no reserve can ever claim (an environment no host advertises), so
 *  it is safe to use as the alarm sink. BR#23279 law: executor readiness
 *  never blocks — unsatisfiable requirements birth a claimable `todo` card
 *  carrying inert `meta.execution_blockers` (the claim gate refuses at
 *  claim time), which serves the same anchor role. */
async function blockedSink(title: string): Promise<string> {
  const created = await kbJson("/create", {
    type: "task", title, project: "bridge", qualified: true, roles: ["impl"],
    meta: { execution_requirements: { tier: "large", environment: ["offline-only"] } },
  });
  expect(created.body.status, JSON.stringify(created.body)).toBe("todo");
  return String(created.body.id);
}

async function alarmDuties(sinkId: string): Promise<any[]> {
  const rel = await kbJson("/relations", { id: sinkId });
  const childIds = (rel.body.relations as any[]).filter(r => r.relation === "child_of" && r.dir === "in").map(r => String(r.artefact_id));
  const duties: any[] = [];
  for (const cid of childIds) {
    const c = await kbJson("/get", { id: cid });
    if (c.body.meta?.machine_duty?.kind === "task-recovery" && c.body.meta?.machine_duty?.subject === sinkId) duties.push(c.body);
  }
  return duties;
}

describe("BR#14696 W1: launch-health fence", () => {
  it("fences a never-signaled claim at the 2m fence with the terminal stderr tail and the launch_failed class", async () => {
    const host = await gatewayHost("fence-host");
    const card = await claimedCard(host, 1);
    // The run began, then died before its first signal: the full terminal
    // receipt the hub already stores must ride the release note.
    const begin = await exec(host, card.id, "begin-1", { kind: "begin", attempt_id: "one", worker: `${host.label}/fixture-worker`, action_budget_ms: 60_000 }, card.session);
    expect(begin.body.error).toBeUndefined();
    const stopped = await exec(host, card.id, "stop-1", {
      kind: "stopped", generation: 1, attempt_id: "one", writers: "process_group_empty",
      outcome: { kind: "failed", exit_code: 1, stdout_tail: "", stderr_tail: "MCP UNAVAILABLE: bridge tools missing — agent transport exited before first signal" },
    }, card.session);
    expect(stopped.body.error).toBeUndefined();
    expect((await kbJson("/get", { id: card.id })).body.status).toBe("in_progress");

    // begun host is visible on the occupancy surface
    const before = await stats();
    expect(before.occupancy).toEqual(expect.arrayContaining([expect.objectContaining({ host: host.label, n: 1 })]));

    await canary(1);
    await sweep(card.status_ts + 3 * MIN);
    expect((await kbJson("/get", { id: card.id })).body.status).toBe("todo");
    const note = await fenceReleaseNote(card.id);
    expect(note).toContain("launch_failed — no first signal");
    expect(note).toContain("at the 2m fence");
    expect(note).toContain("terminal stderr: MCP UNAVAILABLE: bridge tools missing — agent transport exited before first signal");
    // the classifier's exact input: the watchdog transition carries the class
    expect(await releaseClass(card.id)).toBe(LAUNCH_FAILED_RESULT_CLASS);
    expect((await stats()).launch_failed_1h).toBeGreaterThanOrEqual(1);
  });

  it("has no terminal stderr to name when the writer died before any receipt", async () => {
    const host = await gatewayHost("fence-quiet-host");
    const card = await claimedCard(host, 1);
    await canary(1);
    await sweep(card.status_ts + 3 * MIN);
    expect((await kbJson("/get", { id: card.id })).body.status).toBe("todo");
    const note = await fenceReleaseNote(card.id);
    expect(note).toContain("launch_failed — no first signal");
    expect(note).toContain("no terminal stderr captured — the writer died before recording an outcome");
    expect(await releaseClass(card.id)).toBe(LAUNCH_FAILED_RESULT_CLASS);
  });

  it("honours the launch_fence_minutes override and its clamp", async () => {
    const host = await gatewayHost("fence-window-host");
    expect((await kbJson("/admin.settings_set", { settings: { launch_fence_minutes: 5 } })).status).toBe(200);
    const card = await claimedCard(host, 1);
    await canary(1);
    await sweep(card.status_ts + 3 * MIN); // inside the widened fence: no release
    expect((await kbJson("/get", { id: card.id })).body.status).toBe("in_progress");
    await sweep(card.status_ts + 6 * MIN); // past the widened fence: released
    expect((await kbJson("/get", { id: card.id })).body.status).toBe("todo");
    expect(await fenceReleaseNote(card.id)).toContain("at the 5m fence");
    // the clamp keeps the fence inside 1–10 minutes — 99 behaves as 10
    expect((await kbJson("/admin.settings_set", { settings: { launch_fence_minutes: 99 } })).status).toBe(200);
    const card2 = await claimedCard(host, 2);
    await canary(2);
    await sweep(card2.status_ts + 11 * MIN);
    expect((await kbJson("/get", { id: card2.id })).body.status).toBe("todo");
    expect(await fenceReleaseNote(card2.id)).toContain("at the 10m fence");
  });

  it("does not fence a card under a machine hold — a live queue slot keeps its wait (BR#4067), never a launch_failed release", async () => {
    const host = await gatewayHost("fence-hold-host");
    const card = await claimedCard(host, 1, "Held specimen (merge-train queue slot)");
    await canary(1);
    // a live machine wait rides the claimed card: the train owns the exit,
    // the dispatched session's silence is not the card's blocker
    const stamp = await kbJson("/update", {
      id: card.id, actor: "drill-train-stamp",
      meta: { merge_train: { state: "queued", pr: 2400, repo: "state-vector/superpositional" } },
    });
    expect(stamp.status, JSON.stringify(stamp.body)).toBe(200);

    // well past the 2m fence, inside the 10m stall window: held, not fenced
    await sweep(card.status_ts + 3 * MIN);
    expect((await kbJson("/get", { id: card.id })).body.status).toBe("in_progress");

    // past the stall window too: the hold-park owns it (parks-not-releases,
    // BR#4067) — the release would sever the live queue slot (the PR #257
    // class); the park must keep the merge-train prefix (BR#5750/BR#4995)
    await sweep(card.status_ts + 11 * MIN);
    const after = (await kbJson("/get", { id: card.id })).body;
    expect(after.status, "a held card parks blocked, it is never fenced to todo").toBe("blocked");
    expect(String(after.meta?.blocked?.reason ?? "")).toContain("merge-train queued");
    expect(String(after.meta?.blocked?.reason ?? "")).toContain("parked on the typed proxy, not released");
    // and the release that never happened left no launch_failed signal
    const events = await kbJson("/events?since=0&limit=500");
    expect((events.body.events as any[]).some(e => e.op === "launch_failed" && e.artefact_id === card.id)).toBe(false);
  });
});

describe("BR#14696 W1: launch circuit breaker", () => {
  it("opens on the third dead launch with ONE class alarm, refuses claims, and a healthy launch resets it", async () => {
    const sink = await blockedSink("Launch-circuit alarm sink");
    expect((await kbJson("/admin.settings_set", { settings: { train_alarm_sink_id: sink } })).status).toBe(200);
    const a = await gatewayHost("circuit-host-a");
    const b = await gatewayHost("circuit-host-b");
    const c = await gatewayHost("circuit-host-c");

    // three dead launches in a row, no healthy launch between them
    const dead: string[] = [];
    for (let n = 1; n <= 3; n++) dead.push((await claimedCard(a, n)).id);
    await canary(1);
    await sweep(Date.now() + 3 * MIN);
    for (const id of dead) {
      expect((await kbJson("/get", { id })).body.status).toBe("todo");
      expect(await releaseClass(id)).toBe(LAUNCH_FAILED_RESULT_CLASS);
    }
    let board = await stats();
    expect(board.launch_circuit).toMatchObject({ consecutive: 3, tripped: true });
    expect(board.launch_failed_1h).toBeGreaterThanOrEqual(3);
    // ONE class alarm on the sink — the environment fault is one incident
    expect(await alarmDuties(sink)).toHaveLength(1);
    // the failing host's claims pause; the reason names the circuit
    const refused = await exec(a, "gateway", "reserve-refused-1", { kind: "schedule", mode: "reserve" });
    expect(refused.body).toMatchObject({ kind: "gateway_not_ready" });
    expect(String(refused.body.reason)).toContain("launch-fence:");

    // three more dead launches (host b is healthy so far) — the SAME alarm, still one duty
    for (let n = 1; n <= 3; n++) await claimDirectly(b, String((await kbJson("/create", { type: "task", title: `Second-strike specimen ${n}`, project: "bridge", qualified: true, roles: ["impl"] })).body.id), n);
    await canary(2);
    await sweep(Date.now() + 3 * MIN);
    board = await stats();
    expect(board.launch_circuit).toMatchObject({ consecutive: 6, tripped: true });
    expect(await alarmDuties(sink)).toHaveLength(1);
    expect(String((await exec(a, "gateway", "reserve-refused-2", { kind: "schedule", mode: "reserve" })).body.reason)).toContain("launch-fence:");

    // a young healthy launch resets the circuit and lifts the pauses. Host c
    // is unpaused, so ITS reserve wins a claim — whichever card it claims is
    // the healthy specimen; the signal is what the sweep reads.
    const healthy = await exec(c, "gateway", "reserve-healthy", { kind: "schedule", mode: "reserve" });
    expect(healthy.body, JSON.stringify(healthy.body)).toMatchObject({ kind: "reserved" });
    const healthyId = String(healthy.body.task_id);
    const healthyClaimedAt = Number((await kbJson("/get", { id: healthyId })).body.status_ts);
    await kbJson("/update", { id: healthyId, meta: { session_alive_ts: healthyClaimedAt + 61_000 } });
    await sweep(healthyClaimedAt + 3 * MIN);
    expect((await kbJson("/get", { id: healthyId })).body.status).toBe("in_progress"); // signalled work is not fenced
    board = await stats();
    expect(board.launch_circuit).toBeUndefined(); // consecutive 0, trip false — key omitted
    const resumed = await exec(a, "gateway", "reserve-after-reset", { kind: "schedule", mode: "reserve" });
    expect(resumed.body, JSON.stringify(resumed.body)).toMatchObject({ kind: "reserved" });
  });
});

/** The W2 episode: a red deploy observed on a registered lane, repaired by a
 *  claimed card (the recovery events are owner-gated), the card then released
 *  unclaimed, and — when `verify` — a successful deployment with coverage so
 *  the episode sits in verifying with its receipts met. */
async function unstaffedVerifyingEpisode(repo: string, verify: boolean): Promise<string> {
  const repair = String((await kbJson("/create", { type: "task", title: `Repair the red deploy on ${repo}`, qualified: true, roles: ["impl"] })).body.id);
  expect((await kbJson("/transition", { id: repair, to: "in_progress", actor: "repairer", session: "impl-w2", note: "claim repair" })).status).toBe(200);
  expect((await kbJson("/train.lease", { repo, base: "main", action: "acquire", actor: "merger-w2", required_workflows: ["Deploy Dev"] })).status).toBe(200);
  expect((await kbJson("/train.queue_facts", { repo, actor: "merger-w2", entries: [], base_state: { verdict: "green", tip_sha: sha("7"), red: [], unsettled: [] } })).status).toBe(200);
  const cause = { kind: "test_failure", check: "Deploy Dev", suite: "smoke", test: "br14696" };
  const observe = (id: number, conclusion: string) => kbJson("/train.observe_deploy", {
    repo, actor: "observer",
    observation: {
      tip_sha: sha("7"), observed_at: Date.now(),
      runs: [{ id, name: "Deploy Dev", head_sha: sha("7"), status: "completed", conclusion, html_url: `https://github.com/${repo}/actions/runs/${id}` }],
      ...(conclusion === "failure" ? { failures: [{ run_id: id, name: "Deploy Dev", url: `https://github.com/${repo}/actions/runs/${id}/job/1`, cause, repair_task_id: repair }] } : {}),
    },
  });
  const first = await observe(1, "failure");
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  const command = (event_id: string, event: Record<string, unknown>) =>
    kbJson("/train.recovery_event", { repo, head_sha: sha("7"), cause, event_id, event, actor: "repairer" });
  expect((await command("diag", { kind: "diagnosed", task_id: repair, diagnosis: "Deploy red on the BR#14696 surface", next: "Fix and redeploy" })).status).toBe(200);
  expect((await command("start", { kind: "attempt_started", task_id: repair, attempt_id: "r1", attempt_kind: "repair", action: "Fix the deploy", next: "Publish the repair" })).status).toBe(200);
  await command("done", { kind: "attempt_finished", task_id: repair, attempt_id: "r1", outcome: "delivered", summary: "Repair published", receipts: [`https://github.com/${repo}/commit/${sha("a")}`], next: "Verify deployment" });
  // release the card unclaimed — the W2 class: receipts accrue while nobody staffs acceptance
  expect((await kbJson("/transition", { id: repair, to: "todo", actor: "repairer", session: "impl-w2", note: "release claim; acceptance unstaffed" })).status).toBe(200);
  if (verify) {
    expect((await observe(2, "success")).status).toBe(200);
    expect((await kbJson("/train.queue_facts", {
      repo, actor: "merger-w2", entries: [],
      base_state: { verdict: "green", tip_sha: sha("7"), red: [], unsettled: [], deploy_coverage: { phase: "covered", tip_sha: sha("7"), tip_age_secs: 60, covered_by_sha: sha("7"), covered_by_run_id: 2 } },
    })).status).toBe(200);
  }
  const lane = (await kbJson("/train.status", { repo })).body.lanes[0];
  const episode = lane.line.recoveries[0].episode;
  expect(episode.stage.phase).toBe("verifying");
  expect(episode.verified_receipts).toHaveLength(verify ? 1 : 0);
  return repair;
}

async function acceptanceDuties(repairId: string): Promise<any[]> {
  const rel = await kbJson("/relations", { id: repairId });
  const childIds = (rel.body.relations as any[]).filter(r => r.relation === "child_of" && r.dir === "in").map(r => String(r.artefact_id));
  const duties: any[] = [];
  for (const cid of childIds) {
    const c = await kbJson("/get", { id: cid });
    const roles = Array.isArray(c.body.roles) ? c.body.roles : [];
    if (roles.includes("review") && c.body.meta?.execution_review_of === repairId) duties.push(c.body);
  }
  return duties;
}

describe("BR#14696 W2: verifying-phase acceptance-duty auto-spawn", () => {
  it("staffs ONE acceptance review duty on the lane read, deduped, and the widened ask binds it", async () => {
    const repair = await unstaffedVerifyingEpisode("state-vector/br14696-w2-spawn", true);
    // the read itself staffs the duty — same review pool as in_review
    expect(await acceptanceDuties(repair)).toHaveLength(1);
    const duty = (await acceptanceDuties(repair))[0];
    expect(duty.status).toBe("todo");
    expect(duty.title).toContain("Verify:");
    // never a duplicate: a second read reuses the open round
    await kbJson("/train.status", { repo: "state-vector/br14696-w2-spawn" });
    expect(await acceptanceDuties(repair)).toHaveLength(1);
    // the widened independent_review ask resolves to the same duty
    const ask = await kbJson("/ask.create", { route: { kind: "independent_review", task_id: repair } });
    expect(ask.status, JSON.stringify(ask.body)).toBe(200);
    expect(ask.body).toMatchObject({ kind: "independent_review", status: "pending", id: duty.id });
    const again = await kbJson("/ask.create", { route: { kind: "independent_review", task_id: repair } });
    expect(again.body.id).toBe(duty.id);
  });

  it("spawns nothing while receipts are unmet and keeps the plain-task refusal", async () => {
    const repair = await unstaffedVerifyingEpisode("state-vector/br14696-w2-unmet", false);
    await kbJson("/train.status", { repo: "state-vector/br14696-w2-unmet" });
    await kbJson("/train.status", { repo: "state-vector/br14696-w2-unmet" });
    expect(await acceptanceDuties(repair)).toHaveLength(0); // receipts 0/1: no duty, no line hold relieved by a ghost review
    const unmet = await kbJson("/ask.create", { route: { kind: "independent_review", task_id: repair } });
    expect(unmet.body.error).toContain("submit the implementation to in_review");
    const plain = String((await kbJson("/create", { type: "task", title: "Plain task outside in_review", qualified: true })).body.id);
    const refused = await kbJson("/ask.create", { route: { kind: "independent_review", task_id: plain } });
    expect(refused.body.error).toContain("submit the implementation to in_review");
  });
});

describe("BR#14696 F1: score-side launch_failed exemption", () => {
  const zero = { progress_count: 0, gauge_count: 0, thin_notes: 0, abandoned: 0, result_lost: 0, launch_failed: 0, reassigned: 0, asks_received: 0, asks_answered_on_time: 0, artefacts_created: 0, verify_duty_backlog: 0, train_red: 0 };

  it("never scores a dead-at-launch fence release as abandonment", () => {
    expect(LAUNCH_FAILED_RESULT_CLASS).toBe("launch_failed");
    expect(scoreAgent({ ...zero })).toMatchObject({ score: 50, grade: "fair" });
    // a pure churn storm: many fenced launches, zero score impact, class named
    const churn = scoreAgent({ ...zero, launch_failed: 7 });
    expect(churn.score).toBe(50);
    expect(churn.hints.join(" ")).toContain("fenced dead-at-launch (launch_failed)");
    // the contrast: real abandonment still bites
    expect(scoreAgent({ ...zero, abandoned: 2 }).score).toBe(30);
    // mixed: the fence releases ride along without dragging the score down
    const mixed = scoreAgent({ ...zero, launch_failed: 5, gauge_count: 3, artefacts_created: 2 });
    expect(mixed.score).toBe(60);
    expect(scoreAgent({ ...zero, result_lost: 3 }).score).toBe(50); // the sibling exemption keeps its shape
  });
});
