import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * BR#6384 — the anti-languish law (real DO drills against the bundled worker).
 *
 * One predicate, no exceptions: a card whose work has landed, or whose wait
 * can provably never fire, cannot sit parked past one sweep cycle + bound.
 * Three legs, each pinned here end-to-end:
 *
 *   Leg 1 — observed-merge close (reconcile): the feed itself observing a
 *     bound PR MERGED closes the card citing the live mergeCommit — the
 *     human/out-of-band merge path needs NO provenance row and NO ruling
 *     duty (extends BR#6330's provenance close to every merge path).
 *
 *   Leg 2 — the bounded disposition ladder (alarm cadence): a train-only
 *     wait stranded out of the derived queue on a healthy lane past
 *     train.strand_disposition_h walks a machine-executed ladder —
 *     (a) merge evidence closes it, (b) closed-unmerged evidence supersedes
 *     it, (c) ONE re-verify-or-drop duty per round, (d) rounds exhausted →
 *     superseded with findings. No unbounded parks (the BR#6163 alarm
 *     becomes the heads-up, not the terminal state).
 *
 *   Leg 3 — pr_merged proxy probes (extends BR#4658): the sweep enqueues a
 *     `merged:repo#N` probe; a daemon executor's gh verdict (mergeCommit as
 *     the head receipt) flips the park through the standard satisfied-proxy
 *     path — "unresolvable from the hub" stops being a terminal parking
 *     reason for the most common atom class.
 */

const HOUR = 3_600_000;

let mf: Miniflare;
const t0 = Date.now();
let tick = 0;

async function kbJson(path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const kb = (globalThis as any).__kb as (p: string, i?: RequestInit) => Promise<Response>;
  const r = await kb(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const taskById = async (id: string) => (await kbJson("/get", { id })).body;

const task = async (title: string) => {
  const r = await kbJson("/create", { type: "task", title });
  expect(r.status).toBe(200);
  return String(r.body.id);
};

/** A fresh blocked card with a typed await_event (the parked rig shape). */
async function parkedCard(title: string, awaitEvent: unknown, condition: string): Promise<string> {
  const created = await kbJson("/create", { type: "task", title, body_md: `BR#6384 rig: ${title}`, actor: "rig" });
  const id = created.body.id as string;
  expect(id, `create failed: ${JSON.stringify(created.body)}`).toBeTruthy();
  const blocked = await kbJson("/transition", {
    id, to: "blocked", actor: "rig", session: "rig",
    note: "parked on the train gate (BR#6384 rig)",
    unblock_condition: condition,
    await_event: awaitEvent,
  });
  expect(blocked.body.error ?? null, `block failed: ${JSON.stringify(blocked.body)}`).toBeNull();
  return id;
}

/** A real former train car, not a task awaiting somebody else's upstream PR.
 * BR#6395 deliberately excludes dependency-only parks from destructive ladders. */
async function strandedCard(title: string, awaitEvent: unknown, condition: string): Promise<string> {
  const id = await parkedCard(title, awaitEvent, condition);
  const result = await kbJson("/update", { id, meta: { bounce_released: { at: Date.now(), train_only_await: awaitEvent } } });
  expect(result.body.error).toBeUndefined();
  return id;
}

/** Backdate a parked card's blocked.ts — real clock, like the strand rigs. */
const backdatePark = async (id: string, hoursAgo: number) => {
  const cur = await taskById(id);
  const upd = await kbJson("/update", {
    id,
    meta: { blocked: { ...(cur.meta?.blocked ?? {}), ts: Date.now() - hoursAgo * HOUR } },
  });
  expect(upd.status).toBeLessThan(400);
};

/** Unblock-duty children of one card (child_of rows). */
async function dutyChildrenOf(id: string): Promise<string[]> {
  const rel = (await kbJson("/relations", { id })).body;
  const out = ((rel.relations ?? []) as any[]).filter((r) => r.relation === "child_of" && r.dir === "in");
  const duties: string[] = [];
  for (const r of out) {
    const a = await taskById(r.artefact_id);
    if (a && typeof a.title === "string" && a.title.startsWith("Unblock: ")) duties.push(a.id);
  }
  return duties;
}

/** Strand-disposition duties RELATED to a card (relates rows — never child_of). */
async function strandDutiesOf(id: string): Promise<string[]> {
  const rel = (await kbJson("/relations", { id })).body;
  const out = ((rel.relations ?? []) as any[]).filter((r) => r.relation === "relates" && r.dir === "in");
  const duties: string[] = [];
  for (const r of out) {
    const a = await taskById(r.artefact_id);
    if (a && typeof a.title === "string" && a.title.startsWith("Strand disposition round")) duties.push(a.id);
  }
  return duties;
}

/** A lane card for the repo + a LIVE lease + one merged event NOW — the
 *  healthy-lane proof (the train moved after any backdated park). */
async function healthyLane(repo: string, gw: string): Promise<void> {
  const lane = await kbJson("/train.lane", { repo, base: "main", actor: "rig", spec: { required_workflows: ["Test"] } });
  expect(lane.body.error ?? "").toBe("");
  const a = await kbJson("/train.lease", { repo, base: "main", action: "acquire", actor: gw });
  expect(a.body.error ?? "").toBe("");
  const ev = await kbJson("/train.event", {
    repo, base: "main", kind: "merged", actor: gw, pr: 1, merge_sha: "d".repeat(40),
  });
  expect(ev.body.error ?? "", `train.event failed: ${JSON.stringify(ev.body)}`).toBe("");
}

/** One proxy-watch drill at a fresh injected clock (pacing is clock-driven). */
async function sweep(): Promise<any> {
  tick += 1;
  const now = t0 + tick * 20 * 60_000; // 20 min per drill — past every pacing window
  return (await kbJson("/admin.unblock_proxy_sweep", { now })).body;
}

/** The actual production strand→ladder phases. alarmSweep() itself does not
 * include these outer alarm() phases; the previous drill never executed them. */
const alarm = async () => {
  const result = await kbJson("/admin.strand_disposition_sweep", {});
  expect(result.body.error, JSON.stringify(result.body)).toBeUndefined();
  return result.body;
};

const proxyCheck = async (id: string) => (await taskById(id))?.meta?.proxy_check ?? {};

beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  if (!existsSync(bundle)) {
    throw new Error("bundle missing — run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle (before vitest)");
  }
  mf = new Miniflare({
    workers: [
      {
        name: "main",
        scriptPath: bundle,
        modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")),
        modules: true,
        compatibilityDate: "2025-09-06",
        durableObjects: {
          HUB: { className: "FlowsHub", useSQLite: true },
          KB: { className: "KnowledgeHub", useSQLite: true },
        },
      },
    ],
  });
  const ns = await mf.getDurableObjectNamespace("KB");
  const stub: any = await ns.get(ns.idFromName("global"));
  (globalThis as any).__kb = (path: string, init?: RequestInit) => stub.fetch(`https://kb${path}`, init);
  await kbJson("/orient", {});
  // the standing alarm sink (train_alarm_sink_id → a real task, BR#5916 shape)
  const sinkId = await task("BR#6384 strand alarm sink drill");
  (globalThis as any).__sinkId = sinkId;
  const set = await kbJson("/admin.settings_set", { settings: { train_alarm_sink_id: sinkId } });
  expect(set.body.error ?? "").toBe("");
});

afterAll(async () => {
  await mf?.dispose();
});

// ---------- Leg 1: the observed-merge close (reconcile apply) ----------

describe("BR#6384 Leg 1 — observed-merge close (real DO)", () => {
  it("a parked card whose PR merged out-of-band closes citing the live mergeCommit — no provenance row, no ruling duty", async () => {
    const REPO = "state-vector/br6384-l1";
    const SHA = "f".repeat(40);
    const id = await parkedCard(
      "BR#6384 L1: bound card whose PR merged out-of-band",
      { event: "pr_merged", repo: REPO, n: 6120 },
      `PR ${REPO}#6120 merged (mergeCommit non-null)`,
    );
    // bind the card to the PR (meta.pr — the reconcile binding leg)
    const upd = await kbJson("/update", { id, meta: { pr: { repo: REPO, number: 6120, head_sha_at_acceptance: "a".repeat(40), base: "main" } } });
    expect(upd.status).toBeLessThan(400);
    // NO provenance row exists for (REPO, 6120) — the merge happened outside
    // the train. The feed's MERGED row is the only receipt.
    const beforeChildren = await dutyChildrenOf(id);
    const rep = await kbJson("/reconcile.report", {
      repo: REPO,
      prs: [
        { number: 6120, title: "out-of-band merge", state: "MERGED", mergeCommit: SHA, reviewDecision: null, mergeable: null, mergeStateStatus: null, headRefOid: SHA, headRefName: "feature/x", updatedAt: new Date().toISOString(), isDraft: false },
      ],
    });
    expect(rep.status).toBe(200);
    expect(rep.body.ok).toBe(true);
    expect(rep.body.accounting.observed_merged).toBe(1);
    expect(rep.body.line).toContain("1 awaiting delivery verification");
    expect(rep.body.spawned).toHaveLength(1); // one actual delivery review
    const cur = await taskById(id);
    expect(cur.status).toBe("in_review");
    const hist = (await kbJson("/get_history", { id })).body;
    const close = (hist.versions ?? []).find((v: any) => String(v.summary ?? "").includes("Observed MERGED"));
    expect(close, "the close note must cite the observation").toBeTruthy();
    expect(String(close.data.note)).toContain(SHA);
    expect(String(close.data.note)).toContain("decisive required CI");
    // Existing unblock duties do not multiply. The separately reported new
    // child is an actual delivery review, not another unblock round.
    expect(await dutyChildrenOf(id)).toHaveLength(beforeChildren.length);
    expect((await taskById(rep.body.spawned[0].card)).roles).toContain("review");
  });
});

// ---------- Leg 2: the bounded disposition ladder ----------

describe("BR#6384 Leg 2 — the disposition ladder (real DO)", () => {
  it("(a) provenance evidence closes the stranded car citing the merge sha", async () => {
    const REPO = "state-vector/br6384-l2-close";
    await healthyLane(REPO, "gw-br6384-2a");
    const id = await strandedCard(
      "BR#6384 L2a: stranded car whose merge landed",
      { event: "pr_merged", repo: REPO, n: 6110 },
      `PR ${REPO}#6110 merged (mergeCommit non-null)`,
    );
    await backdatePark(id, 30);
    // the train stamps the merge receipt for the car's own PR
    const ev = await kbJson("/train.event", {
      repo: REPO, base: "main", kind: "merged", actor: "gw-br6384-2a", pr: 6110, merge_sha: "e".repeat(40),
    });
    expect(ev.body.error ?? "").toBe("");
    await alarm();
    const cur = await taskById(id);
    expect(cur.status).toBe("in_review");
    const hist = (await kbJson("/get_history", { id })).body;
    const close = (hist.versions ?? []).find((v: any) => String(v.summary ?? "").includes("Observed MERGED"));
    expect(close, "the close must ride the strand-disposition receipt").toBeTruthy();
    expect(String(close.data.note)).toContain("decisive required CI");
    expect(String(close.summary)).toContain("e".repeat(40).slice(0, 9));
  });

  it("(b) a closed-unmerged probe retains responsibility and schedules recovery, not abandonment", async () => {
    const REPO = "state-vector/br6384-l2-closed";
    await healthyLane(REPO, "gw-br6384-2b");
    const id = await strandedCard(
      "BR#6384 L2b: stranded car whose PR closed unmerged",
      { event: "pr_merged", repo: REPO, n: 6111 },
      `PR ${REPO}#6111 merged (mergeCommit non-null)`,
    );
    await backdatePark(id, 30);
    // pass 1: the ladder machine-first enqueues the merged probe (one pass of grace)
    await alarm();
    expect((await taskById(id)).meta?.strand_ladder).toBeUndefined();
    const queue = (await kbJson("/proxy.probes", {})).body;
    expect(queue.probes.some((p: any) => p.key === `merged:${REPO}#6111`)).toBe(true);
    // the executor rules: the PR is CLOSED unmerged — the wait can never fire
    const rep = await kbJson("/proxy.verify", {
      key: `merged:${REPO}#6111`,
      ok: false,
      conclusive: true,
      error: "PR state CLOSED — unmerged",
      receipt: `https://github.com/${REPO}/pull/6111`,
    });
    expect(rep.body.error ?? null).toBeNull();
    expect(rep.body.verdict).toBe("negative");
    // pass 2: leg (b) — supersede with findings
    await alarm();
    const cur = await taskById(id);
    expect(cur.status).toBe("blocked");
    expect(cur.meta.recovery.reason).toBe("queue_binding");
    expect(cur.meta.recovery.task_id).toBeTruthy();
  });

  it("(c)/(d) bounded rounds escalate exhausted repair without retiring the delivery obligation", async () => {
    const REPO = "state-vector/br6384-l2-ladder";
    await healthyLane(REPO, "gw-br6384-2c");
    const id = await strandedCard(
      "BR#6384 L2c: stranded car on a checks wait",
      { event: "pr_checks_green", repo: REPO, n: 6112 },
      `all checks green on PR ${REPO}#6112`,
    );
    await backdatePark(id, 30);
    // pass 1: fresh probe enqueue — the executor gets one pass of grace
    await alarm();
    expect((await taskById(id)).meta?.strand_ladder).toBeUndefined();
    expect(await strandDutiesOf(id)).toHaveLength(0);
    // the executor leg keeps failing (transient — gh broken, not conclusive)
    const rep = await kbJson("/proxy.verify", {
      key: `checks:${REPO}#6112`,
      ok: false,
      error: "gh not authed (rig)",
    });
    expect(rep.body.verdict).toBe("retry");
    // pass 2: no evidence, no fresh grace — the ladder spawns round 1's duty
    await alarm();
    const cur = await taskById(id);
    expect(cur.meta?.strand_ladder?.rounds).toBe(1);
    let duties = await strandDutiesOf(id);
    expect(duties).toHaveLength(1);
    const duty = duties[0];
    const dutyCard = await taskById(duty);
    expect(String(dutyCard.title)).toContain("verify-or-drop");
    expect(String(dutyCard.title)).toContain(id);
    // the duty is RELATED, never a child (it must never gate the car's close)
    const rel = (await kbJson("/relations", { id })).body;
    expect(((rel.relations ?? []) as any[]).some((r) => r.relation === "child_of" && String(r.artefact_id) === duty)).toBe(false);
    // pass 3: the open duty holds the ladder — no second duty while it lives
    await alarm();
    expect((await taskById(id)).meta?.strand_ladder?.rounds).toBe(1);
    expect(await strandDutiesOf(id)).toHaveLength(1);
    // cap the ladder at ONE round, then rule the duty (terminal on a receipt)
    const cap = await kbJson("/admin.settings_set", { settings: { "train_strand_ladder_rounds": 1 } });
    expect(cap.body.error ?? "").toBe("");
    expect((await kbJson("/transition", { id: duty, to: "in_progress", actor: "rig", note: "ruling the round" })).status).toBeLessThan(400);
    expect((await kbJson("/transition", {
      id: duty, to: "done", actor: "rig",
      review_result: { kind: "findings", summary: "PR remains open and advancing; no delivery accepted." },
      note: "re-verified first-hand: PR still OPEN and advancing — re-queued the car (https://github.com/x/pull/6112)",
    })).status).toBeLessThan(400);
    // pass 4: rounds 1 >= cap 1 — the ladder exhausts, superseded with findings
    await alarm();
    const done = await taskById(id);
    expect(done.status).toBe("blocked");
    expect(done.meta.recovery.reason).toBe("queue_binding");
    const recovery = done.meta.recovery.task_id;
    expect(recovery).toBeTruthy();
    await alarm();
    expect((await taskById(id)).meta.recovery.task_id).toBe(recovery);
  });

  it("guards — a stalled lane and a young park are untouched: no ladder, no re-board, no supersede", async () => {
    // stalled lane: live lane, but it never merged after the park — the
    // starvation law owns that lane, not the ladder.
    const STALL = "state-vector/br6384-l2-stalled";
    const lane = await kbJson("/train.lane", { repo: STALL, base: "main", actor: "rig", spec: { required_workflows: ["Test"] } });
    expect(lane.body.error ?? "").toBe("");
    const stalledId = await strandedCard(
      "BR#6384 guard: stalled-lane car",
      { event: "pr_merged", repo: STALL, n: 6113 },
      `PR ${STALL}#6113 merged (mergeCommit non-null)`,
    );
    await backdatePark(stalledId, 30);
    // young car on a healthy lane: inside train.strand_disposition_h
    const YOUNG = "state-vector/br6384-l2-young";
    await healthyLane(YOUNG, "gw-br6384-2g");
    const youngId = await strandedCard(
      "BR#6384 guard: young parked car",
      { event: "pr_merged", repo: YOUNG, n: 6114 },
      `PR ${YOUNG}#6114 merged (mergeCommit non-null)`,
    );
    await backdatePark(youngId, 1);
    await alarm();
    for (const [label, gid] of [["stalled", stalledId], ["young", youngId]] as const) {
      const cur = await taskById(gid);
      expect(cur.status, `${label} car must stay parked`).toBe("blocked");
      expect(cur.meta?.strand_ladder, `${label} car must carry no ladder ledger`).toBeUndefined();
      expect(cur.meta?.strand_reboard, `${label} car must not be re-boarded`).toBeUndefined();
      expect(await strandDutiesOf(gid)).toHaveLength(0);
    }
  });
});

// ---------- Leg 3: pr_merged proxy probes (extends BR#4658) ----------

describe("BR#6384 Leg 3 — pr_merged proxy probes (real DO)", () => {
  it("the sweep enqueues a pr_merged probe (merged: key, pr column) and stamps probe_pending", async () => {
    const id = await parkedCard(
      "BR#6384 L3a: pr_merged park awaits its probe",
      { event: "pr_merged", repo: "state-vector/br6384-l3", n: 6130 },
      "PR state-vector/br6384-l3#6130 merged (mergeCommit non-null)",
    );
    const before = await dutyChildrenOf(id);
    await sweep();
    const check = await proxyCheck(id);
    expect(check.verdict).toBe("probe_pending");
    const queue = (await kbJson("/proxy.probes", {})).body;
    expect(queue.ok).toBe(true);
    const mine = queue.probes.find((p: any) => p.key === "merged:state-vector/br6384-l3#6130");
    expect(mine, "the pr_merged probe must be in the queue").toBeTruthy();
    expect(mine.kind).toBe("pr_merged");
    expect(mine.repo).toBe("state-vector/br6384-l3");
    expect(Number(mine.pr)).toBe(6130);
    // no closer fired — the gate is unverified, so the sweep spawns nothing
    expect(await dutyChildrenOf(id)).toHaveLength(before.length);
    expect((await taskById(id)).status).toBe("blocked");
  });

  it("a satisfied executor verdict (mergeCommit as head receipt) flips: proxy_verified event + the unblock duty spawns", async () => {
    const id = await parkedCard(
      "BR#6384 L3b: satisfied pr_merged resolves itself",
      { event: "pr_merged", repo: "state-vector/br6384-l3", n: 6131 },
      "PR state-vector/br6384-l3#6131 merged (mergeCommit non-null)",
    );
    await sweep();
    expect((await proxyCheck(id)).verdict).toBe("probe_pending");
    const SHA = "abc123def4560000000000000000000000000000";
    const rep = await kbJson("/proxy.verify", {
      key: "merged:state-vector/br6384-l3#6131",
      ok: true,
      receipt: "https://github.com/state-vector/br6384-l3/pull/6131",
      head_sha: SHA, // the mergeCommit rides head_sha
      conclusion: "merged",
    });
    expect(rep.body.error ?? null).toBeNull();
    expect(rep.body.verdict).toBe("satisfied");
    const hist = (await kbJson("/get_history", { id })).body;
    const verified = (hist.versions ?? []).find((v: any) => v.action === "proxy_verified");
    expect(verified, "a proxy_verified event must be stamped on the parked card").toBeTruthy();
    expect(String(verified.summary ?? "")).toContain("https://github.com/state-vector/br6384-l3/pull/6131");
    // the standard satisfied-proxy path takes over on the next pass (BR#4282)
    await sweep();
    expect((await proxyCheck(id)).verdict).toBe("true");
    expect((await dutyChildrenOf(id)).length).toBeGreaterThanOrEqual(1);
  });

  it("a closed-unmerged upstream prerequisite is replaced by a repair duty", async () => {
    const id = await parkedCard(
      "BR#6384 L3c: closed-unmerged must not flip",
      { event: "pr_merged", repo: "state-vector/br6384-l3", n: 6132 },
      "PR state-vector/br6384-l3#6132 merged (mergeCommit non-null)",
    );
    await sweep();
    const rep = await kbJson("/proxy.verify", {
      key: "merged:state-vector/br6384-l3#6132",
      ok: false,
      conclusive: true,
      error: "PR state CLOSED — unmerged",
      receipt: "https://github.com/state-vector/br6384-l3/pull/6132",
    });
    expect(rep.body.verdict).toBe("negative");
    await sweep();
    const card = await taskById(id);
    expect(card.status).toBe("blocked");
    expect(card.meta.blocked.reason).toContain("CLOSED");
    expect(card.meta.blocked.await_event).toEqual({ event: "br_done", id: card.meta.recovery.task_id });
  });
});
