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
 *    main-HEAD sha, and nothing filed on green.
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
      return [];
    };
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
  const set = await kbJson("/admin.settings_set", { settings: { stop_line_artefact_id: sink.body.id } });
  if (set.body.error) throw new Error(`settings_set failed: ${set.body.error}`);
});

afterAll(async () => {
  await mf?.dispose();
  await new Promise<void>((resolve) => ghServer?.close(() => resolve()));
});

async function kbJson(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const kb = (globalThis as any).__kb as (p: string, i?: RequestInit) => Promise<Response>;
  const r = await kb(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" },
    body: JSON.stringify(body),
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

describe("stopTheLineSweep (real DO, canned GitHub)", () => {
  it("red main files ONE time-sensitive ask bound to the sink; a re-sweep on the same sha dedupes", async () => {
    await setScenario("f");
    const first = await kbJson("/admin.stop_line_sweep", { now: Date.now() + 600_000 });
    expect(first.status).toBeLessThan(500);
    expect(first.body.error).toBeUndefined();
    let mine = (await stopLineAsks()).filter((a) => a.title.includes("fffffffff"));
    expect(mine.length).toBe(1);
    expect(mine[0].meta?.ask?.urgency).toBe("time-sensitive");
    expect(mine[0].meta?.ask?.to).toBe("rayh");
    expect(mine[0].meta?.ask?.reason).toContain("destination-green");

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
