import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
    const before = await dutyChildrenOf(id);
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
    const check = await proxyCheck(id);
    expect(check.verdict).toBe("false"); // the gate has NOT fired — honest false, never a flip
    expect(await dutyChildrenOf(id)).toHaveLength(before.length);
    expect(String(JSON.stringify(check.atoms ?? []))).toContain("head mismatch");
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

  it("transient gh failures back off; an exhausted probe returns the park to a LOUD unresolvable (never a silent loop)", async () => {
    const id = await parkedCard(
      "probe rig E: gh keeps failing",
      { event: "pr_checks_green", repo: "state-vector/superpositional", n: 2504 },
      "all checks green on PR state-vector/superpositional#2504",
    );
    const before = await dutyChildrenOf(id);
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
    const check = await proxyCheck(id);
    expect(check.verdict).toBe("unresolvable"); // loud again — visible, not invisible
    expect(String(check.detail ?? "")).toContain("probe exhausted");
    expect(await dutyChildrenOf(id)).toHaveLength(before.length);
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
