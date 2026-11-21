import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executorRequest } from "./executor-fixture";
import { parseExternalChecksProbeKey } from "../src/kb/do.ts";

/**
 * BR#4658 — the worker-executor verification leg for non-train typed-await
 * parks (real DO drill against the bundled worker, closure-sweep rig).
 *
 * The hub holds no VCS credentials (BR#3516): the proxy sweep could never
 * VERIFY run_success / pr_checks_green atoms machine-side, so those parks
 * had NO closer once their gate fired (specimen BR#3621 — exit met 60h,
 * still parked, the drain re-poking a refused release every tick). The law
 * under test here:
 *  - the sweep ENQUEUES a probe (deduped by atom) and stamps probe_pending;
 *  - the executor feeds a gh verdict through proxy.verify; the HUB decides
 *    (executor-fed facts, hub-decided — BR#4489): the head law compares
 *    headSha vs the awaited head, mismatch = conclusive NO (BR#3409
 *    fail-closed — the park never flips on a wrong-head success);
 *  - a satisfied verdict stamps a proxy_verified event carrying the GitHub
 *    URL receipt, and the standard satisfied-proxy path takes over
 *    (BR#4282: the unblock duty auto-spawns, no human/agent first-hand leg);
 *  - transient gh failures back off (attempt-capped); an exhausted probe
 *    returns the park to a LOUD unresolvable — never a silent infinite loop;
 *  - receipts must land as GitHub URLs or the verdict is refused.
 *
 * Duty coverage is the assertion, not raw deltas: parking a machine-checkable
 * card already spawns its park-time round (machine.ts), and the flood law
 * REUSES that round on a flip (BR#3129) — a fresh duty spawns only when no
 * round is on the case. What BR#4658 adds is the flip itself: verdict true
 * with zero first-hand verification.
 */

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

/** Unblock-duty children of one card (the park-time round included). */
async function dutyChildrenOf(id: string): Promise<string[]> {
  const rel = (await kbJson("/relations", { id })).body;
  // children of the card: child_of rows whose dst IS the card → dir "in"
  const out = ((rel.relations ?? []) as any[]).filter((r) => r.relation === "child_of" && r.dir === "in");
  const duties: string[] = [];
  for (const r of out) {
    const a = await taskById(r.artefact_id);
    if (a && typeof a.title === "string" && a.title.startsWith("Unblock: ")) duties.push(a.id);
  }
  return duties;
}

/** A fresh blocked card with a typed await_event; returns its id. */
async function parkedCard(title: string, awaitEvent: unknown, condition: string): Promise<string> {
  const created = await kbJson("/create", {
    type: "task",
    title,
    body_md: `BR#4658 rig: ${title}`,
    actor: "probe-rig",
  });
  const id = created.body.id as string;
  expect(id, `create failed: ${JSON.stringify(created.body)}`).toBeTruthy();
  const blocked = await kbJson("/transition", {
    id,
    to: "blocked",
    actor: "probe-rig",
    session: "probe-rig",
    note: "parked on the run gate (probe rig)",
    unblock_condition: condition,
    await_event: awaitEvent,
  });
  expect(blocked.body.error ?? null, `block failed: ${JSON.stringify(blocked.body)}`).toBeNull();
  return id;
}

/** One proxy-watch drill at a fresh injected clock (pacing is clock-driven). */
async function sweep(): Promise<any> {
  tick += 1;
  const now = t0 + tick * 20 * 60_000; // 20 min per drill — past every pacing window
  return (await kbJson("/admin.unblock_proxy_sweep", { now })).body;
}

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
});

afterAll(async () => {
  await mf?.dispose();
});

describe("proxy verification probes (BR#4658) — real DO", () => {
  it("the sweep enqueues a probe for an unverified run_success park and stamps probe_pending (never unresolvable)", async () => {
    const id = await parkedCard(
      "probe rig A: run_success park awaits its closer",
      { event: "run_success", repo: "state-vector/superpositional", run_id: "40350887296" },
      "GitHub run state-vector/superpositional/40350887296 conclusion=success",
    );
    const before = await dutyChildrenOf(id);
    await sweep();
    const check = await proxyCheck(id);
    expect(check.verdict).toBe("probe_pending");
    const queue = (await kbJson("/proxy.probes", {})).body;
    expect(queue.ok).toBe(true);
    const mine = queue.probes.find((p: any) => p.run_id === "40350887296");
    expect(mine, "the probe must be in the queue").toBeTruthy();
    expect(mine.repo).toBe("state-vector/superpositional");
    // no closer fired — the gate is unverified, so the sweep spawns nothing
    expect(await dutyChildrenOf(id)).toHaveLength(before.length);
    expect((await taskById(id)).status).toBe("blocked");
  });

  it("a satisfied executor verdict stamps a proxy_verified event with the GitHub URL and flips: the unblock duty spawns (no first-hand human/agent leg)", async () => {
    const id = await parkedCard(
      "probe rig B: satisfied run_success resolves itself",
      { event: "run_success", repo: "state-vector/superpositional", run_id: "40350887297" },
      "GitHub run state-vector/superpositional/40350887297 conclusion=success",
    );
    await sweep();
    expect((await proxyCheck(id)).verdict).toBe("probe_pending");
    const rep = await kbJson("/proxy.verify", {
      key: "run:state-vector/superpositional:40350887297",
      ok: true,
      receipt: "https://github.com/state-vector/superpositional/actions/runs/40350887297",
      head_sha: "ca18675f0f000000000000000000000000000000",
      conclusion: "success",
    });
    expect(rep.body.error ?? null).toBeNull();
    expect(rep.body.verdict).toBe("satisfied");
    // the receipt of record rides the card's event log
    const hist = (await kbJson("/get_history", { id })).body;
    const verified = (hist.versions ?? []).find((v: any) => v.action === "proxy_verified");
    expect(verified, "a proxy_verified event must be stamped on the parked card").toBeTruthy();
    expect(String(verified.summary ?? "")).toContain("https://github.com/state-vector/superpositional/actions/runs/40350887297");
    // the standard satisfied-proxy path takes over on the next pass (BR#4282):
    // the verdict flips machine-side (no first-hand human/agent leg) and a
    // live unblock duty covers the card — the park-time round while it is open
    // (the flood law reuses it, BR#3129), a fresh spawn otherwise.
    await sweep();
    expect((await proxyCheck(id)).verdict).toBe("true");
    expect((await dutyChildrenOf(id)).length).toBeGreaterThanOrEqual(1);
  });

  it("the head law fails closed: a success at the WRONG head is a conclusive negative — the park stands, never flips (BR#3409)", async () => {
    const id = await parkedCard(
      "probe rig C: wrong-head success must not flip",
      { event: "run_success", repo: "state-vector/superpositional", run_id: "40350887298", head: "ca18675f0f" },
      "GitHub run state-vector/superpositional/40350887298 conclusion=success at head ca18675f0f",
    );
    await sweep();
    const rep = await kbJson("/proxy.verify", {
      key: "run:state-vector/superpositional:40350887298",
      ok: true, // the executor saw SUCCESS…
      receipt: "https://github.com/state-vector/superpositional/actions/runs/40350887298",
      head_sha: "deadbeef90000000000000000000000000000000", // …at the wrong head
      conclusion: "success",
    });
    expect(rep.body.verdict).toBe("negative");
    await sweep();
    const card = (await kbJson("/get", { id })).body;
    expect(card.status).toBe("blocked");
    expect(card.meta.blocked.reason).toContain("head mismatch");
    expect(card.meta.blocked.await_event).toEqual({ event: "br_done", id: card.meta.recovery.task_id });
  });

  it("receipts must be GitHub URLs — an URL-less satisfaction is refused and the probe stays pending", async () => {
    const id = await parkedCard(
      "probe rig D: receipt contract",
      { event: "run_success", repo: "state-vector/superpositional", run_id: "40350887299" },
      "GitHub run state-vector/superpositional/40350887299 conclusion=success",
    );
    const before = await dutyChildrenOf(id);
    await sweep();
    const rep = await kbJson("/proxy.verify", {
      key: "run:state-vector/superpositional:40350887299",
      ok: true,
      receipt: "trust me, it is green",
      head_sha: "ca18675f0f",
      conclusion: "success",
    });
    expect(rep.body.ok).toBe(false);
    expect(String(rep.body.error)).toContain("GitHub URL");
    expect((await proxyCheck(id)).verdict).toBe("probe_pending");
    expect(await dutyChildrenOf(id)).toHaveLength(before.length);
  });

  it("rechecks a failed PR head and releases the wait only on fresh green evidence", async () => {
    const repo = "state-vector/bridge", pr = 323;
    const key = `checks:${repo}#${pr}`, receipt = `https://github.com/${repo}/pull/${pr}`;
    const id = await parkedCard("repair leaves the old PR head red", { event: "pr_checks_green", repo, n: pr },
      `all checks green on PR ${repo}#${pr}`);
    await sweep();
    const before = await dutyChildrenOf(id);
    expect((await kbJson("/proxy.verify", { key, receipt, head_sha: "a".repeat(40), ok: false,
      conclusive: true, error: "checks failing: Test=FAILURE" })).body.verdict).toBe("negative");
    await sweep();
    expect((await taskById(id)).meta.blocked.await_event).toEqual({ event: "pr_checks_green", repo, n: pr });
    expect((await proxyCheck(id)).verdict).toBe("false");
    expect(await dutyChildrenOf(id)).toEqual(before);
    const reopened = (await kbJson("/proxy.probes", {})).body.probes.find((p: { key: string }) => p.key.startsWith(`${key}@`));
    expect(reopened).toBeDefined();
    expect((await kbJson("/proxy.verify", { key, receipt, head_sha: "a".repeat(40), ok: true })).body.error).toContain("previous probe");
    const current = { key: reopened.key, receipt, ok: true };
    expect((await kbJson("/proxy.verify", current)).body.error).toContain("exact GitHub head SHA");
    expect((await kbJson("/proxy.verify", { ...current, receipt: `${receipt}1`, head_sha: "b".repeat(40) })).body.error).toContain("PR URL");
    expect((await kbJson("/proxy.verify", { ...current, head_sha: "b".repeat(40) })).body.verdict).toBe("satisfied");
    await sweep();
    const check = await proxyCheck(id);
    expect(check.verdict).toBe("true");
    expect(before).toContain(check.spawned);
    expect(await dutyChildrenOf(id)).toEqual(before);
  });

  it("transient gh failures are bounded and exhausted probes schedule a reassessment", async () => {
    const id = await parkedCard(
      "probe rig E: gh keeps failing",
      { event: "pr_checks_green", repo: "state-vector/superpositional", n: 2504 },
      "all checks green on PR state-vector/superpositional#2504",
    );
    await sweep();
    expect((await proxyCheck(id)).verdict).toBe("probe_pending");
    for (let i = 0; i < 12; i++) {
      const rep = await kbJson("/proxy.verify", {
        key: "checks:state-vector/superpositional#2504",
        ok: false,
        error: "gh not authed (rig)",
      });
      expect(rep.body.error ?? null).toBeNull();
    }
    await sweep();
    const card = (await kbJson("/get", { id })).body;
    expect(card.status).toBe("blocked");
    expect(card.meta.blocked.reason).toContain("probe exhausted");
    expect(card.meta.blocked.await_event).toEqual({ event: "br_done", id: card.meta.recovery.task_id });
  });

  it("one probe per atom across cards: a second park on the same run shares the queue row (dedupe)", async () => {
    const aw = { event: "run_success", repo: "state-vector/superpositional", run_id: "40350887300" };
    const cond = "GitHub run state-vector/superpositional/40350887300 conclusion=success";
    await parkedCard("probe rig F: shared run (card A)", aw, cond);
    await parkedCard("probe rig F: shared run (card B)", aw, cond);
    await sweep();
    const queue = (await kbJson("/proxy.probes", {})).body;
    const rows = queue.probes.filter((p: any) => p.run_id === "40350887300");
    expect(rows).toHaveLength(1);
  });

  it("the newer_than form probes too: run list resolution via the executor, flip on a newer success", async () => {
    const id = await parkedCard(
      "probe rig G: newer_than park",
      { event: "run_success", repo: "state-vector/superpositional", newer_than: "40405248594" },
      "a GitHub Actions run on state-vector/superpositional newer than 40405248594 with conclusion=success",
    );
    await sweep();
    expect((await proxyCheck(id)).verdict).toBe("probe_pending");
    const rep = await kbJson("/proxy.verify", {
      key: "newer:state-vector/superpositional:40405248594",
      ok: true,
      receipt: "https://github.com/state-vector/superpositional/actions/runs/40405300000",
      head_sha: "563ebf9a00000000000000000000000000000000",
      conclusion: "success",
    });
    expect(rep.body.verdict).toBe("satisfied");
    await sweep();
    expect((await proxyCheck(id)).verdict).toBe("true");
    expect((await dutyChildrenOf(id)).length).toBeGreaterThanOrEqual(1);
  });
});

/** BR#18328 — durable external-CI waits, end-to-end on the real hub: the
 *  await_external park releases the worker slot charge-free, the head-bound
 *  probe settles through the ordinary executor probe queue, and exactly one
 *  fresh verifier generation wakes. The wake is evidence, never acceptance. */
describe("durable external-CI waits (BR#18328) — real DO", () => {
  const REPO = "state-vector/superpositional", PR = 3644;
  const sha = (c: string) => c.repeat(40);
  let execSerial = 0;

  /** Park a live review duty through the REAL flow: advertise → create →
   *  claim → begin → await_external (writer-proof fenced). */
  async function parkedReviewDuty(title: string, wait: { type: "pr_required_checks"; repo: string; pr: number; head_sha: string; contexts: string[] }) {
    const host = `extwait-${++execSerial}`;
    const gateway = (await kbJson("/admin.mint", { label: host, tags: ["gateway"] })).body;
    const identity = (await kbJson("/auth.identify", { bearer: gateway.secret })).body;
    const worker = (await kbJson("/agent.provision", { label: `${host}/worker`, actor: host })).body;
    const base = { actor: host, token_id: identity.token_id, gateway: true, agent: `${host}/worker`, session: `extwait-${execSerial}` };
    const advertise = (await kbJson("/execution", executorRequest({ ...base, id: "gateway", command_id: `adv-${execSerial}`, command: { kind: "advertise", capabilities: {
      tier: "small", backend: "opencode", model: "test/small", tools: ["git"], environment: ["linux"], capacity: 1, projects: ["bridge"], worker: { kind: "provisioned", label: `${host}/worker` },
    } } }))).body;
    expect(advertise.error ?? null).toBeNull();
    const id = (await kbJson("/create", executorRequest({ actor: host, type: "task", title, body_md: `BR#18328 rig: ${title}`, project: "bridge", roles: ["impl"], qualified: true }))).body.id as string;
    expect(id, "create failed").toBeTruthy();
    expect((await kbJson("/transition", executorRequest({ ...base, id, to: "in_progress" }))).body.error ?? null).toBeNull();
    const exec = (command_id: string, command: object) => kbJson("/execution", executorRequest({ ...base, id, command_id, command }));
    expect((await exec("begin", { kind: "begin", attempt_id: "one", worker: `${host}/worker`, action_budget_ms: 60_000 })).body.error ?? null).toBeNull();
    const fence = { generation: 1, attempt_id: "one" };
    expect((await exec("park", { kind: "await_external", ...fence, writers: "process_group_empty", wait })).body.error ?? null).toBeNull();
    const key = `extchecks:${wait.repo}#${wait.pr}@${wait.head_sha}`;
    return { id, base, exec, fence, key, wait };
  }

  const verify = async (payload: object) => (await kbJson("/proxy.verify", payload)).body;
  const drill = async (now?: number) => {
    const kb = (globalThis as any).__kb as (p: string, i?: RequestInit) => Promise<Response>;
    const r = await kb("/admin.external_waits_sweep", { method: "POST", headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify(now === undefined ? {} : { now }) });
    const text = await r.text();
    let body: any;
    try { body = JSON.parse(text); } catch { body = { unparsed: text.slice(0, 300) }; }
    return { status: r.status, ...body };
  };
  const card = async (id: string) => taskById(id);

  it("parks charge-free: slot released, the wait is durable in todo, the exact-head probe is enqueued", async () => {
    const r = await parkedReviewDuty("extwait rig A: verifier parks on pending hosted CI", { type: "pr_required_checks", repo: REPO, pr: PR, head_sha: sha("3"), contexts: ["ci / Build", "ci / Lodestar Scenarios"] });
    const c = await card(r.id);
    expect(c.status).toBe("todo");
    expect(c.owner).toBe("");
    expect(c.meta.session).toBeUndefined(); // the worker slot is released
    expect(c.meta.execution_wait).toMatchObject({ kind: "external_checks", await: { repo: REPO, pr: PR, head_sha: sha("3") }, generation: 1, attempt_id: "one" });
    // no failure charge, no terminal evidence, attempt quiesced
    const state = (await r.exec("inspect-state", { kind: "inspect" })).body;
    expect(state).toMatchObject({ budget_exhaustions: 0, terminal: null, external_wait: { pr: PR, attempt_id: "one" }, attempt: { phase: "quiesced" } });
    // the stopped-writer receipt of record is the park itself
    expect((await r.exec("wr", { kind: "writer_receipt", ...r.fence })).body).toMatchObject({ kind: "writer_receipt_found", source: "await_external" });
    // the head-bound probe is in the queue for the executor probe pass
    const probe = (await kbJson("/proxy.probes", {})).body.probes.find((p: { key: string }) => p.key === r.key);
    expect(probe).toMatchObject({ repo: REPO, pr: PR, kind: "pr_checks_green", expected_head: sha("3") });
    expect(parseExternalChecksProbeKey(r.key)).toEqual({ repo: REPO, pr: PR, head_sha: sha("3") });
  });

  it("green checks wake exactly one verifier: duplicate check events cannot double-wake, and waiting avoids the retry charge", async () => {
    const r = await parkedReviewDuty("extwait rig B: green CI wakes one verifier", { type: "pr_required_checks", repo: REPO, pr: PR, head_sha: sha("3"), contexts: ["ci / Build", "ci / Lodestar Scenarios"] });
    expect((await verify({ key: r.key, ok: true, receipt: `https://github.com/${REPO}/pull/${PR}`, head_sha: sha("3"), conclusion: "checks green", contexts: ["ci / Build=SUCCESS", "ci / Lodestar Scenarios=SUCCESS"] })).verdict).toBe("satisfied");
    // a duplicate check event hits the verdict of record, not a second wake
    expect((await verify({ key: r.key, ok: true, receipt: `https://github.com/${REPO}/pull/${PR}`, head_sha: sha("3"), conclusion: "checks green", contexts: ["ci / Build=SUCCESS", "ci / Lodestar Scenarios=SUCCESS"] })).error).toContain("verdict of record stands");
    expect((await drill()).ok).toBe(true);
    const c = await card(r.id);
    expect(c.meta.execution_wait).toBeUndefined();
    expect(c.meta.execution_external_checks).toMatchObject({ outcome: "checks_green", head_sha: sha("3") });
    expect(c.status).toBe("todo");
    const settled = async () => (await kbJson("/get_history", { id: r.id })).body.versions.filter((v: { action: string }) => v.action === "external_wait_settled");
    expect(await settled()).toHaveLength(1);
    expect(String((await settled())[0].summary)).toContain("GREEN");
    // a second sweep (another duplicate event) wakes nobody
    expect((await drill()).ok).toBe(true);
    expect(await settled()).toHaveLength(1);
    expect((await card(r.id)).meta.execution_wait).toBeUndefined();
    // waiting never consumed the repair budget: the fresh verifier begins clean
    expect((await kbJson("/transition", executorRequest({ ...r.base, id: r.id, to: "in_progress" }))).body.error ?? null).toBeNull();
    expect((await r.exec("begin-two", { kind: "begin", generation: 2, attempt_id: "two", worker: `${r.base.actor}/worker`, action_budget_ms: 60_000 })).body.error ?? null).toBeNull();
    const state = (await r.exec("inspect-state", { kind: "inspect" })).body;
    expect(state).toMatchObject({ generation: 2, budget_exhaustions: 0, failure_charged_generation: 0 });
  });

  it("conclusively failed checks still reach a verifier, carrying the failing context names", async () => {
    const r = await parkedReviewDuty("extwait rig C: red CI wakes the verifier against reality", { type: "pr_required_checks", repo: REPO, pr: PR, head_sha: sha("4"), contexts: ["ci / Test"] });
    expect((await verify({ key: r.key, ok: false, conclusive: true, error: "checks failing: ci / Test=FAILURE", head_sha: sha("4"), conclusion: "failing" })).verdict).toBe("negative");
    expect((await drill()).ok).toBe(true);
    const c = await card(r.id);
    expect(c.meta.execution_wait).toBeUndefined();
    expect(c.meta.execution_external_checks).toMatchObject({ outcome: "checks_failed", error: "checks failing: ci / Test=FAILURE" });
    expect(c.status).toBe("todo"); // the verifier records the verdict, the wait did not fail the attempt
    const settled = (await kbJson("/get_history", { id: r.id })).body.versions.filter((v: { action: string }) => v.action === "external_wait_settled");
    expect(String(settled[0].summary)).toContain("ci / Test=FAILURE");
  });

  it("an amended head invalidates the old wait — even a green at the wrong head cannot wake it (BR#3409)", async () => {
    const r = await parkedReviewDuty("extwait rig D: amended head invalidates the stale wait", { type: "pr_required_checks", repo: REPO, pr: PR, head_sha: sha("5"), contexts: ["ci / Build"] });
    expect((await verify({ key: r.key, ok: true, receipt: `https://github.com/${REPO}/pull/${PR}`, head_sha: sha("6"), conclusion: "checks green", contexts: ["ci / Build=SUCCESS"] })).verdict).toBe("negative");
    expect((await drill()).ok).toBe(true);
    const c = await card(r.id);
    expect(c.meta.execution_wait).toBeUndefined();
    expect(c.meta.execution_external_checks).toMatchObject({ outcome: "head_moved", head_sha: sha("6") });
    const settled = (await kbJson("/get_history", { id: r.id })).body.versions.filter((v: { action: string }) => v.action === "external_wait_settled");
    expect(String(settled[0].summary)).toContain("INVALIDATED");
    // a fresh verifier re-binds at the current head; the old signature wakes nothing
    expect((await verify({ key: `extchecks:${REPO}#${PR}@${sha("6")}`, ok: true, receipt: `https://github.com/${REPO}/pull/${PR}`, head_sha: sha("6"), conclusion: "checks green" })).error).toContain("no such probe");
  });

  it("a satisfied verdict missing a declared required context is NOT coverage — the probe re-arms until the set is whole", async () => {
    const r = await parkedReviewDuty("extwait rig E: partial check coverage keeps waiting", { type: "pr_required_checks", repo: REPO, pr: PR, head_sha: sha("7"), contexts: ["ci / Build", "ci / Lodestar Scenarios"] });
    expect((await verify({ key: r.key, ok: true, receipt: `https://github.com/${REPO}/pull/${PR}`, head_sha: sha("7"), conclusion: "checks green", contexts: ["ci / Build=SUCCESS"] })).verdict).toBe("satisfied");
    expect((await drill()).ok).toBe(true);
    let c = await card(r.id);
    expect(c.meta.execution_wait).toMatchObject({ kind: "external_checks" }); // still held
    const queued = (await kbJson("/proxy.probes", {})).body.probes.map((p: { key: string }) => p.key);
    expect(queued).toContain(r.key); // re-armed, still in the queue
    expect((await verify({ key: r.key, ok: true, receipt: `https://github.com/${REPO}/pull/${PR}`, head_sha: sha("7"), conclusion: "checks green", contexts: ["ci / Build=SUCCESS", "ci / Lodestar Scenarios=SUCCESS"] })).verdict).toBe("satisfied");
    expect((await drill()).ok).toBe(true);
    c = await card(r.id);
    expect(c.meta.execution_wait).toBeUndefined();
    expect(c.meta.execution_external_checks).toMatchObject({ outcome: "checks_green" });
  });

  it("a CI settle bound past every typical run releases the wait — a verifier decides on what CI never settled", async () => {
    const r = await parkedReviewDuty("extwait rig F: unsettled CI past the bound releases the verifier", { type: "pr_required_checks", repo: REPO, pr: PR, head_sha: sha("8"), contexts: ["ci / Build"] });
    const declared = (await card(r.id)).meta.execution_wait.declared_at as number;
    expect((await drill(declared + 61 * 60_000)).ok).toBe(true);
    const c = await card(r.id);
    expect(c.meta.execution_wait).toBeUndefined();
    expect(c.meta.execution_external_checks).toMatchObject({ released: "bound_exceeded" });
    expect(c.status).toBe("todo");
  });

  it("ordinary accounting is untouched: a completed exit without a durable verdict still charges the budget", async () => {
    const host = `extwait-${++execSerial}`;
    const gateway = (await kbJson("/admin.mint", { label: host, tags: ["gateway"] })).body;
    const identity = (await kbJson("/auth.identify", { bearer: gateway.secret })).body;
    expect((await kbJson("/agent.provision", { label: `${host}/worker`, actor: host })).body.id ?? null).toBeTruthy();
    const base = { actor: host, token_id: identity.token_id, gateway: true, agent: `${host}/worker`, session: `extwait-${execSerial}` };
    expect((await kbJson("/execution", executorRequest({ ...base, id: "gateway", command_id: `adv-${execSerial}`, command: { kind: "advertise", capabilities: {
      tier: "small", backend: "opencode", model: "test/small", tools: ["git"], environment: ["linux"], capacity: 1, projects: ["bridge"], worker: { kind: "provisioned", label: `${host}/worker` },
    } } }))).body.error ?? null).toBeNull();
    const id = (await kbJson("/create", executorRequest({ actor: host, type: "task", title: "extwait rig G: the BR#18314 shape stays charged", body_md: "returned after local tests, no publication, no durable continuation", project: "bridge", roles: ["impl"], qualified: true }))).body.id as string;
    expect((await kbJson("/transition", executorRequest({ ...base, id, to: "in_progress" }))).body.error ?? null).toBeNull();
    const exec = (command_id: string, command: object) => kbJson("/execution", executorRequest({ ...base, id, command_id, command }));
    expect((await exec("begin", { kind: "begin", attempt_id: "one", worker: `${host}/worker`, action_budget_ms: 60_000 })).body.error ?? null).toBeNull();
    const completed = { generation: 1, attempt_id: "one", writers: "process_group_empty", outcome: { kind: "completed", exit_code: 0, stdout_tail: "watch died with me", stderr_tail: "" } };
    expect((await exec("stop", { kind: "stopped", ...completed })).body.error ?? null).toBeNull();
    expect((await exec("finalize", { kind: "finalize", ...completed })).body.error ?? null).toBeNull();
    const c = await card(id);
    expect(c.status).toBe("todo");
    expect(c.meta.execution_resume).toMatchObject({ kind: "terminal_result", generation: 1 });
    const state = (await exec("inspect-state", { kind: "inspect" })).body;
    expect(state.budget_exhaustions).toBe(1); // charged — unlike an await_external park
    expect(state.failure_charged_generation).toBe(1);
  });
});
