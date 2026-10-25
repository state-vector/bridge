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
 *  - a REAL DO drill against the bundled worker: a named stub worker serves
 *    canned GitHub responses (function-form outboundService breaks workerd
 *    startup here — use a named worker + a /__scenario control fetch),
 *    asserting ONE time-sensitive ask per red episode, deduped per
 *    main-HEAD sha, and nothing filed on green — plus (BR#3284) the
 *    claimable half: ONE P0 episode task per red episode alongside the ask,
 *    deduped per sha, superseding the prior open episode task on a new red
 *    sha, body documenting the remediation-merge exception, boosted
 *    (priority 0) for the board's ranked queue.
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

// ---------- tier 2: the real DO drill (bundled worker, canned GitHub) ----------
// The stub is a REAL local HTTP server (not a function-form outboundService —
// that breaks workerd startup in this miniflare build — and not a named
// stub worker, whose config schema diverges). The sweep's GitHub base is a
// setting (`stop_line_gh_api_base`), so the drill points the DO at
// 127.0.0.1 and serves canned responses keyed by the requested sha:
//   ffff… = red (Test failure) · 222… = red (Test timed_out) · 111… = green
//   a base path of /rate-limited makes every call 403 (quota exhaustion).

let mf: Miniflare;
let ghServer: import("node:http").Server;
let ghOrigin = "";
let sinkId = ""; // the drill sink card (set in beforeAll)
let firstEpisodeTaskId = ""; // the f-episode task, superseded by the 2-episode task
// BR#3307 guilty-chain drill: the provenance sweep shares this DO, so the
// alarm-note chain can be proven end-to-end — PR 178 (the f-episode's
// landing PR, merge sha ffff…) indexes with a drill card + accepted verdict
// citing PROV_HEAD once provScenario.on flips.
const PROV_HEAD = "a".repeat(40);
const provScenario = { on: false, branch: "" };
let drillCardId = "";
let drillVerdictId = "";

function ghHandler(): (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void {
  const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  return (req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/rate-limited/")) return json(res, 403, { message: "rate limited" });
    const checkRuns = (sha: string) => {
      if (sha.startsWith("ff") || sha.startsWith("22")) {
        return [
          { id: 900, name: "Test", status: "completed", conclusion: sha.startsWith("ff") ? "failure" : "timed_out", html_url: "https://example/red/Test" },
          { id: 901, name: "CLI build (packages/cli)", status: "completed", conclusion: "success", html_url: "https://example/red/CLI" },
        ];
      }
      if (sha.startsWith("11")) {
        return [
          { id: 901, name: "Test", status: "completed", conclusion: "success", html_url: "https://example/green/Test" },
          { id: 902, name: "CLI build (packages/cli)", status: "completed", conclusion: "success", html_url: "https://example/green/CLI" },
        ];
      }
      if (sha.startsWith("00")) {
        return [
          { id: 903, name: "Test", status: "completed", conclusion: "success", html_url: "https://example/green/Test" },
        ];
      }
      return [];
    };
    // episode-attribution walk (BR#3284): recent-commits list (newest first)
    // + associated PRs, keyed by the same scenario encoding the /commits/main
    // mapping uses — f: [f(RED), 1(green)] · 2: [2(RED), 0(green)] — so the
    // f-episode's bisect names the head merge itself and the 2-episode's
    // names its own landing PR.
    if (/\/repos\/[^/]+\/[^/]+\/commits\?/.test(url)) {
      const shas = url.includes("scenario=f") ? ["f", "1", "0"]
        : url.includes("scenario=2") ? ["2", "0"]
        : ["1", "0"];
      return json(res, 200, shas.map((k) => ({ sha: k.repeat(40), parents: [] })));
    }
    const pulls = url.match(/\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]{40})\/pulls/);
    if (pulls) {
      if (pulls[1].startsWith("ff")) {
        return json(res, 200, [{ number: 178, title: "main-green gate + stopTheLineSweep (BR#3008)", html_url: "https://github.com/state-vector/bridge/pull/178", merged_at: "2026-10-24T16:12:03Z" }]);
      }
      if (pulls[1].startsWith("22")) {
        return json(res, 200, [{ number: 191, title: "verify is the merge authority (BR#3221)", html_url: "https://github.com/state-vector/bridge/pull/191", merged_at: "2026-10-25T19:41:12Z" }]);
      }
      return json(res, 200, []);
    }
    const m = url.match(/\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]{40})\/check-runs/);
    if (m) return json(res, 200, { total_count: checkRuns(m[1]).length, check_runs: checkRuns(m[1]) });
    if (/\/repos\/[^/]+\/[^/]+\/commits\/main/.test(url)) {
      // the sweep drives the scenario by requesting a sha first — the drill
      // sets stop_line_gh_api_base per case, so /commits/main resolves the
      // sha the CURRENT scenario wants; the server answers with the sha
      // embedded in a custom header set by setScenario (via base path).
      const want = url.includes("scenario=f") ? "f".repeat(40)
        : url.includes("scenario=2") ? "2".repeat(40)
        : url.includes("scenario=1") ? "1".repeat(40)
        : "e".repeat(40);
      return json(res, 200, { sha: want });
    }
    // provenance sweep routes (BR#3307 guilty-chain drill): one merged PR
    // (the f-episode's landing PR #178, merge sha ffff…) with a bridge-card
    // head branch — served only once provScenario.on flips, because the
    // sweep dedupes per (repo, pr) and an early no-card index would stick.
    // Gated on the bridge repo only so exactly one row indexes (the chain's
    // PR link must be deterministic).
    if (/\/repos\/state-vector\/bridge\/pulls\?state=closed/.test(url)) {
      if (!provScenario.on) return json(res, 200, []);
      return json(res, 200, [{ number: 178, title: "main-green gate + stopTheLineSweep (BR#3008)", state: "closed", merged_at: "2026-10-24T16:12:03Z", merge_commit_sha: "f".repeat(40) }]);
    }
    if (/\/repos\/state-vector\/bridge\/pulls\/178$/.test(url)) {
      return json(res, 200, {
        number: 178, title: "main-green gate + stopTheLineSweep (BR#3008)",
        head: { ref: provScenario.branch, sha: PROV_HEAD },
        merged_at: "2026-10-24T16:12:03Z", merge_commit_sha: "f".repeat(40),
      });
    }
    if (/\/repos\/state-vector\/bridge\/pulls\/178\/commits/.test(url)) {
      return json(res, 200, [{ sha: PROV_HEAD, commit: { verification: { verified: true }, committer: { email: "297316395+detached-cody@users.noreply.github.com" } } }]);
    }
    if (req.method === "POST" && /\/repos\/state-vector\/bridge\/issues\/178\/labels/.test(url)) return json(res, 200, { ok: true });
    json(res, 404, { message: `unexpected ${url}` });
  };
}

beforeAll(async () => {
  // same rig recipe as do.test.ts (proven by test/kb-throughput.test.ts):
  // realpath + modulesRoot (workerd's virtual FS rejects ".." path segments)
  // + useSQLite (wrangler.toml declares both classes new_sqlite_classes)
  const { realpathSync } = await import("node:fs");
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  if (!existsSync(bundle)) {
    throw new Error("bundle missing — run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle (before vitest)");
  }
  const { createServer } = await import("node:http");
  ghServer = createServer(ghHandler());
  await new Promise<void>((resolve) => ghServer.listen(0, "127.0.0.1", resolve));
  ghOrigin = `http://127.0.0.1:${(ghServer.address() as any).port}`;
  mf = new Miniflare({
    workers: [{
      name: "main",
      scriptPath: bundle,
      modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")),
      modules: true,
      compatibilityDate: "2025-09-06",
      bindings: { GH_TOKEN: "test-token" }, // the provenance sweep leg (BR#3307) reads it
      durableObjects: {
        HUB: { className: "FlowsHub", useSQLite: true },
        KB: { className: "KnowledgeHub", useSQLite: true },
      },
    }],
  });
  const ns = await mf.getDurableObjectNamespace("KB");
  const stub: any = await ns.get(ns.idFromName("global"));
  (globalThis as any).__kb = (path: string, init?: RequestInit) => stub.fetch(`https://kb${path}`, init);
  await kbJson("/orient", {});
  // the drill DB is fresh: create the local sink card and point the sweep at it
  const sink = await kbJson("/create", {
    type: "task",
    title: "ALARM SINK — drill",
    body_md: "test-local ask sink",
    tags: ["alarm"],
  });
  if (sink.body.error) throw new Error(`sink create failed: ${sink.body.error}`);
  sinkId = sink.body.id;
  const set = await kbJson("/admin.settings_set", { settings: { stop_line_artefact_id: sink.body.id } });
  if (set.body.error) throw new Error(`settings_set failed: ${set.body.error}`);
});

afterAll(async () => {
  await mf?.dispose();
  await new Promise<void>((resolve) => ghServer?.close(() => resolve()));
});

async function kbJson(path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const kb = (globalThis as any).__kb as (p: string, i?: RequestInit) => Promise<Response>;
  const r = await kb(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// setScenario aims the DO at the stub with a base that encodes the wanted
// episode: <origin>/scenario=f/repos/... → /commits/main answers sha ffff…
async function setScenario(shaKind: "f" | "1" | "2" | "rate") {
  const base = shaKind === "rate" ? `${ghOrigin}/rate-limited` : `${ghOrigin}/scenario=${shaKind}`;
  const { body } = await kbJson("/admin.settings_set", { settings: { stop_line_gh_api_base: base } });
  if (body.error) throw new Error(`base setting failed: ${body.error}`);
}

async function stopLineAsks(): Promise<any[]> {
  const { body } = await kbJson("/search", { q: "STOP THE LINE", limit: 50 });
  // questions are a TYPE in the ask contract (the legacy `question` tag is
  // stripped on write) — filter on type, not tags
  return (body?.artefacts ?? []).filter((a: any) => a.type === "question");
}

// the claimable half (BR#3284): open episode tasks, newest first
async function stopLineEpisodeTasks(): Promise<any[]> {
  const { body } = await kbJson("/list", { type: "task", limit: 200 });
  return (body?.artefacts ?? []).filter((a: any) =>
    a.title?.startsWith("STOP-THE-LINE: bridge main RED @ ")
    && !["done", "superseded"].includes(a.status));
}

describe("stopTheLineSweep (real DO, canned GitHub)", () => {
  it("red main files ONE time-sensitive ask bound to the sink; a re-sweep on the same sha dedupes", async () => {
    await setScenario("f");
    // BR#3307 guilty-chain seed: a drill card + an accepted verdict citing
    // the provenance head, so PR 178 (the f-episode's landing PR, merge sha
    // ffff…) indexes with the FULL chain before the alarm sweep runs
    const card = await kbJson("/create", { type: "task", title: "IMPL: guilty-chain drill card" });
    expect(card.status).toBe(200);
    drillCardId = String(card.body.id);
    provScenario.branch = `bridge/${drillCardId.replace("#", "-")}`;
    const verdict = await kbJson("/create", {
      type: "decision",
      title: `verify verdict (guilty-chain drill) — head ${PROV_HEAD.slice(0, 9)} verified`,
      body_md: `verified head ${PROV_HEAD} (drill)`,
      // sessions stamp meta.session at create (resolveSession) — the same
      // channel real verify verdicts carry their session on
      session: "bridge-task-BR-3307-drill",
    });
    expect(verdict.status).toBe(200);
    drillVerdictId = String(verdict.body.id);
    await kbJson("/link", { src: drillVerdictId, relation: "derived_from", dst: drillCardId });
    await kbJson("/transition", { id: drillVerdictId, to: "accepted", actor: "web:ray", note: `drill accept; head ${PROV_HEAD}` });
    provScenario.on = true;
    await kbJson("/admin.settings_set", { settings: { provenance_gh_api_base: ghOrigin } });
    const provSweep = await kbJson("/admin.provenance_sweep", { now: Date.now() + 30_000 });
    expect(provSweep.body.error).toBeUndefined();
    const chain = await kbJson(`/provenance?sha=${"f".repeat(40)}`);
    expect(chain.status).toBe(200);
    expect(chain.body.task.id).toBe(drillCardId);
    expect(chain.body.verdict_id).toBe(drillVerdictId);
    expect(chain.body.session).toBe("bridge-task-BR-3307-drill");
    expect(chain.body.signer).toBe("detached-cody");

    const first = await kbJson("/admin.stop_line_sweep", { now: Date.now() + 600_000 });
    expect(first.status).toBeLessThan(500);
    expect(first.body.error).toBeUndefined();
    let mine = (await stopLineAsks()).filter((a) => a.title.includes("fffffffff"));
    expect(mine.length).toBe(1);
    expect(mine[0].meta?.ask?.urgency).toBe("time-sensitive");
    expect(mine[0].meta?.ask?.to).toBe("rayh");
    expect(mine[0].meta?.ask?.reason).toContain("destination-green");
    // the guilty chain rides the page (BR#3307): PR · task · verdict ·
    // session · signer, resolved from the provenance index above
    const ask = (await kbJson("/get", { id: mine[0].id })).body;
    expect(String(ask.body_md)).toContain("**Guilty chain:**");
    expect(String(ask.body_md)).toContain(`task ${drillCardId}`);
    expect(String(ask.body_md)).toContain(`verdict ${drillVerdictId}`);
    expect(String(ask.body_md)).toContain("signer detached-cody");

    // same red sha again (ten PRs, two sweeps): still exactly one ask
    const second = await kbJson("/admin.stop_line_sweep", { now: Date.now() + 1_200_000 });
    expect(second.body.error).toBeUndefined();
    mine = (await stopLineAsks()).filter((a) => a.title.includes("fffffffff"));
    expect(mine.length).toBe(1);
  });

  it("green main files nothing; a new red sha files a NEW ask (per-episode dedupe)", async () => {
    await setScenario("1");
    const green = await kbJson("/admin.stop_line_sweep", { now: Date.now() + 1_800_000 });
    expect(green.body.error).toBeUndefined();
    expect((await stopLineAsks()).filter((a) => a.title.includes("111111111")).length).toBe(0);

    await setScenario("2");
    await kbJson("/admin.stop_line_sweep", { now: Date.now() + 2_400_000 });
    const asks = await stopLineAsks();
    expect(asks.filter((a) => a.title.includes("222222222")).length).toBe(1);
    expect(asks.length).toBeGreaterThanOrEqual(2); // both episodes exist side by side
  });

  it("rate-limited GitHub fails LOUD (error to the caller), backs off, and files nothing", async () => {
    await setScenario("rate");
    const before = Date.now();
    const r = await kbJson("/admin.stop_line_sweep", { now: Date.now() + 3_000_000 });
    expect(r.status).toBe(400); // the throw propagates — never a silent skip, never a false green
    const { body } = await kbJson("/admin.settings_get", {});
    const last = Number(JSON.parse(body?.settings?.stop_line_last_sweep_ts ?? "0"));
    expect(last).toBeGreaterThanOrEqual(before); // backoff stamped into the future
    expect((await stopLineAsks()).filter((a) => a.title.includes("333333333")).length).toBe(0);
  });
});

// ---------- tier 2b: the episode task drill (BR#3284 — the claimable half) ----------
// The ask is ATTENTION; the episode task is the WORK. Same drill, same stub —
// the walk routes serve f: [f(RED), 1(green), 0(green)] · 2: [2(RED), 0(green)],
// so the f-episode's bisect names the head merge (PR #178) and the 2-episode's
// names its own landing PR (PR #191).
describe("stopTheLineSweep episode tasks (real DO, canned GitHub — BR#3284)", () => {
  // the rate-limit leg above stamped a +60m backoff at ~+3.0M ms; these
  // sweeps start past it and keep climbing so every call passes the cadence.
  it("red main files ONE P0 episode task alongside the ask — boosted, child of the sink, deduped per sha", async () => {
    await setScenario("f");
    const first = await kbJson("/admin.stop_line_sweep", { now: Date.now() + 7_200_000 });
    expect(first.body.error).toBeUndefined();
    const open = await stopLineEpisodeTasks();
    expect(open.length).toBe(1);
    const t = open[0];
    firstEpisodeTaskId = t.id;
    expect(t.title).toBe("STOP-THE-LINE: bridge main RED @ fffffffff — fix main first");
    expect(t.status).toBe("todo");
    // tags: the spec's set (sanitizeTags lowercases — the chip renders "p0")
    expect(t.tags).toEqual(expect.arrayContaining(["stop-the-line", "p0", "gtm-blocker", "role:impl"]));
    // priority is structural: meta.boosted = priority 0 in the pickup
    // ranking + first on the board's ranked queue (existing urgent handling)
    expect(t.meta?.boosted).toBeTruthy();
    expect(t.meta?.stop_line?.short_sha).toBe("fffffffff");
    expect(t.meta?.stop_line?.sink_id).toBe(sinkId);
    // child_of the sink (BR#3124) — the episode family under one anchor
    const rels = (await kbJson("/relations", { id: t.id })).body?.relations ?? [];
    expect(rels).toContainEqual(expect.objectContaining({ relation: "child_of", artefact_id: sinkId, dir: "out" }));
    // body: red checks with run links, the remediation-merge exception
    // (BR#3009/BR#3010), and the done-when
    expect(t.body_md).toContain("Test (failure) — https://example/red/Test");
    expect(t.body_md).toContain("green on the exact failing checks");
    expect(t.body_md).toContain("BR#3010");
    expect(t.body_md).toContain("ALL check-runs settled green (0 red, 0 unsettled)");
    // bisect: parent 1… settles green → the head merge itself broke the line;
    // the landing PR is named with its link
    expect(t.meta?.stop_line?.first_failing_sha).toBe("f".repeat(40));
    expect(t.body_md).toContain("**First failing sha:** fffffffff");
    expect(t.body_md).toContain("pull/178");
    // the guilty chain (BR#3307): the provenance index seeded in the tier-2a
    // ask leg resolves the breaking merge to PR · task · verdict · session ·
    // signer — recorded on the body AND in meta.stop_line.guilty_chain
    expect(t.body_md).toContain("**Guilty chain:** PR [#178](https://github.com/state-vector/bridge/pull/178)");
    expect(t.body_md).toContain(`task ${drillCardId}`);
    expect(t.body_md).toContain(`verdict ${drillVerdictId}`);
    expect(t.body_md).toContain("session bridge-task-BR-3307-drill");
    expect(t.body_md).toContain("signer detached-cody");
    expect(t.meta?.stop_line?.guilty_chain?.task_id).toBe(drillCardId);
    expect(t.meta?.stop_line?.guilty_chain?.verdict_id).toBe(drillVerdictId);
    expect(t.meta?.stop_line?.guilty_chain?.signer).toBe("detached-cody");

    // same red sha again (two sweeps, one episode): still exactly ONE live task
    const second = await kbJson("/admin.stop_line_sweep", { now: Date.now() + 7_800_000 });
    expect(second.body.error).toBeUndefined();
    expect((await stopLineEpisodeTasks()).length).toBe(1);
  });

  it("a NEW red sha supersedes the prior episode task — one live episode task at a time", async () => {
    await setScenario("2");
    const r = await kbJson("/admin.stop_line_sweep", { now: Date.now() + 8_400_000 });
    expect(r.body.error).toBeUndefined();
    const live = await stopLineEpisodeTasks();
    expect(live.length).toBe(1);
    const t2 = live[0];
    expect(t2.title).toBe("STOP-THE-LINE: bridge main RED @ 222222222 — fix main first");
    // the f-episode task is superseded and points its readers at the replacement
    const old = (await kbJson("/get", { id: firstEpisodeTaskId })).body;
    expect(old.status).toBe("superseded");
    expect(old.meta?.superseded_by).toBe(t2.id);
    expect(String(old.meta?.superseded_reason)).toContain("one live episode task at a time");
    const rels = (await kbJson("/relations", { id: t2.id })).body?.relations ?? [];
    expect(rels).toContainEqual(expect.objectContaining({ relation: "supersedes", artefact_id: firstEpisodeTaskId, dir: "out" }));
    // bisect: 0… settles green immediately → the NEW merge itself broke the
    // line; its landing PR (#191) is named
    expect(t2.meta?.stop_line?.first_failing_sha).toBe("2".repeat(40));
    expect(t2.body_md).toContain("**First failing sha:** 222222222");
    expect(t2.body_md).toContain("pull/191");
    // the guilty chain is HONEST when unstamped (BR#3307): no provenance row
    // for 222… — the fallback line, never a guessed attribution
    expect(t2.body_md).toContain("**Guilty chain:** _no bridge provenance for 222222222 yet");
    expect(t2.meta?.stop_line?.guilty_chain).toBeNull();
    // the remediation exception + done-when ride on every episode task
    expect(t2.body_md).toContain("green on the exact failing checks");
    expect(t2.body_md).toContain("ALL check-runs settled green (0 red, 0 unsettled)");
  });

  it("green main files no episode task (the line is up — nothing to fix)", async () => {
    await setScenario("1");
    const r = await kbJson("/admin.stop_line_sweep", { now: Date.now() + 9_000_000 });
    expect(r.body.error).toBeUndefined();
    const live = await stopLineEpisodeTasks();
    expect(live.length).toBe(1); // unchanged — only the 2-episode task
    expect(live[0].title).toContain("222222222");
  });
});
