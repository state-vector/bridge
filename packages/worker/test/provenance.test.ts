import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseProvenanceSha, prCardRef, signerFromCommits, withinBackfillWindow } from "../src/kb/provenance.ts";

/**
 * PR provenance (BR#3287) guards.
 *
 * Tier 1: the pure helpers — card linkage (branch name first, body fallback),
 * signer classification (BR#3181 classes), sha param validation, backfill
 * window.
 *
 * Tier 2: the real DO drill (bundled worker, canned GitHub, same rig recipe
 * as stop-line.test.ts): stamp → provenance table + task meta.provenance +
 * endpoint chain; dedupe per (repo, pr); class-only record for merges with
 * no bridge card.
 */

// ---------- tier 1: pure helpers ----------

describe("prCardRef (branch name is the authoritative join key)", () => {
  it("resolves from the head branch", () => {
    expect(prCardRef("bridge/BR-3218", "some body")).toBe("BR#3218");
    expect(prCardRef("bridge/BR-903-rebase", "body without refs")).toBe("BR#903");
  });

  it("falls back to the PR text when the branch carries no id", () => {
    expect(prCardRef("chore/random-thing", "Residue leg of BR#2851 (verify round)")).toBe("BR#2851");
  });

  it("null when nothing references a card (the no-provenance signal)", () => {
    expect(prCardRef("chore/random-thing", "no refs here")).toBeNull();
    expect(prCardRef(null, null)).toBeNull();
  });

  it("does not confuse plain numbers or other tokens for cards", () => {
    expect(prCardRef("fix/1234-thing", "issue #1234 and GH #12")).toBeNull();
    expect(prCardRef("bridge/BR-7", "small ids are real ids")).toBe("BR#7");
  });
});

describe("signerFromCommits (BR#3181 classes)", () => {
  const c = (verified: boolean, email = "ray@wirestorm.net") => ({ verified, committer_email: email });

  it("detached-cody wins — the worker class identity", () => {
    expect(signerFromCommits([
      c(true, "297316395+detached-cody@users.noreply.github.com"),
      c(true, "ray@wirestorm.net"),
    ])).toBe("detached-cody");
  });

  it("all signed by rayh -> signed", () => {
    expect(signerFromCommits([c(true), c(true)])).toBe("signed");
  });

  it("mixed -> partially-signed (honest)", () => {
    expect(signerFromCommits([c(true), c(false)])).toBe("partially-signed");
  });

  it("unsigned -> unsigned (the 5c violation class, recorded if it ever merges)", () => {
    expect(signerFromCommits([c(false)])).toBe("unsigned");
  });

  it("empty -> unknown, never a guess", () => {
    expect(signerFromCommits([])).toBe("unknown");
  });
});

describe("parseProvenanceSha (the lookup contract)", () => {
  it("accepts 7-40 hex, lowercases", () => {
    expect(parseProvenanceSha(new URLSearchParams("sha=C28DBD607"))).toBe("c28dbd607");
    expect(parseProvenanceSha(new URLSearchParams(`sha=${"a".repeat(40)}`))).toBe("a".repeat(40));
  });
  it("rejects short/garbage with a user-facing message", () => {
    expect(() => parseProvenanceSha(new URLSearchParams("sha=abc12"))).toThrow(/7-40 hex/);
    expect(() => parseProvenanceSha(new URLSearchParams("sha=zzzzzzz"))).toThrow(/7-40 hex/);
    expect(() => parseProvenanceSha(new URLSearchParams(""))).toThrow(/7-40 hex/);
  });
});

describe("withinBackfillWindow", () => {
  it("accepts recent merges, rejects old/unparseable/missing", () => {
    const now = Date.parse("2026-10-25T00:00:00Z");
    expect(withinBackfillWindow("2026-10-24T12:00:00Z", now, 30)).toBe(Date.parse("2026-10-24T12:00:00Z"));
    expect(withinBackfillWindow("2026-09-01T00:00:00Z", now, 30)).toBeNull();
    expect(withinBackfillWindow("not-a-date", now, 30)).toBeNull();
    expect(withinBackfillWindow(null, now, 30)).toBeNull();
  });
});

// ---------- tier 2: the real DO drill (bundled worker, canned GitHub) ----------

let mf: Miniflare;
let ghServer: import("node:http").Server;
let ghOrigin = "";

const HEAD_SHA = "c61b4869aad07eccdc738200f004d2dbe0a2bf66";
const MERGE_SHA = "c28dbd60764a05eae8bccf4b40d9afed2e425ea7";
const NOCARD_MERGE = "b".repeat(40);
// the drill card's real id is assigned at create-time; the stub serves the
// branch/title from this scenario so the join key (BR-<id>) is honest.
const scenario = { branch: "bridge/BR-3218", refText: "BR#3218" };

function ghHandler(): (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void {
  const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const detail = (n: number, ref: string, title: string, body: string) => ({
    number: n, title, body,
    head: { ref, sha: HEAD_SHA },
    merged_at: "2026-10-25T00:35:00Z",
    merge_commit_sha: n === 185 ? MERGE_SHA : NOCARD_MERGE,
  });
  const commits = (cody: boolean) => [
    { sha: HEAD_SHA, commit: { verification: { verified: true }, committer: { email: cody ? "297316395+detached-cody@users.noreply.github.com" : "ray@wirestorm.net" } } },
  ];
  return (req, res) => {
    const url = req.url ?? "/";
    if (req.method === "POST" && /\/issues\/\d+\/labels/.test(url)) return json(res, 200, { ok: true });
    if (/\/pulls\?state=closed/.test(url)) {
      return json(res, 200, [
        { number: 185, title: `board: drill (${scenario.refText})`, state: "closed", merged_at: "2026-10-25T00:35:00Z", merge_commit_sha: MERGE_SHA },
        { number: 186, title: "chore: no card here", state: "closed", merged_at: "2026-10-25T00:40:00Z", merge_commit_sha: NOCARD_MERGE },
        { number: 187, title: "closed without merging", state: "closed", merged_at: null, merge_commit_sha: null },
      ]);
    }
    let m = url.match(/\/pulls\/(\d+)$/);
    if (m) {
      const n = Number(m[1]);
      return json(res, 200, n === 185 ? detail(185, scenario.branch, `board: drill (${scenario.refText})`, scenario.refText)
        : detail(186, "chore/random", "chore: no card here", "nothing"));
    }
    m = url.match(/\/pulls\/(\d+)\/commits/);
    if (m) return json(res, 200, commits(Number(m[1]) === 185));
    json(res, 404, { message: `unexpected ${url}` });
  };
}

beforeAll(async () => {
  // same rig recipe as kb-throughput.test.ts: realpath + modulesRoot + useSQLite
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
      durableObjects: { KB: { className: "KnowledgeHub", useSQLite: true } },
      bindings: { GH_TOKEN: "test-token" },
    }],
  });
  kbNs = await mf.getDurableObjectNamespace("KB");
});

afterAll(async () => {
  await mf.dispose();
  await new Promise<void>((resolve) => ghServer.close(() => resolve()));
});

let kbNs: any;
const kbJson = async (path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const stub: any = await kbNs.get(kbNs.idFromName("global"));
  const res = await stub.fetch(`https://kb${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
};

describe("provenance DO drill (BR#3287)", () => {
  it("indexes merged PRs, stamps the card, and the endpoint returns the chain", async () => {
    // the producing card + an accepted verify verdict citing the head sha
    const task = await kbJson("/create", { type: "task", title: "IMPL: Claim locally (drill)" });
    expect(task.status).toBe(200);
    const taskId = task.body.id;
    scenario.branch = `bridge/${taskId.replace("#", "-")}`;
    scenario.refText = taskId;
    const verdict = await kbJson("/create", { type: "decision", title: `verify verdict (drill) — head ${HEAD_SHA.slice(0, 9)} verified` });
    expect(verdict.status).toBe(200);
    await kbJson("/link", { src: verdict.body.id, relation: "derived_from", dst: taskId });
    await kbJson("/transition", { id: verdict.body.id, to: "accepted", actor: "web:ray", note: `drill accept (human actor per the acceptance gate); head ${HEAD_SHA}` });
    await kbJson("/admin.settings_set", { settings: { provenance_gh_api_base: ghOrigin } });

    const sweep = await kbJson("/admin.provenance_sweep", { now: Date.now() + 600_000 });
    expect(sweep.status).toBe(200);
    expect(sweep.body.ok).toBe(true);

    // endpoint: by merge sha → full chain
    const byMerge = await kbJson(`/provenance?sha=${MERGE_SHA.slice(0, 12)}`);
    expect(byMerge.status).toBe(200);
expect(byMerge.body.error ?? "").toBe("");
    expect(byMerge.body.pr).toBe(185);
    expect(byMerge.body.task.id).toBe(taskId);
    expect(byMerge.body.verdict_id).toBe(verdict.body.id);
    expect(byMerge.body.signer).toBe("detached-cody");

    // by head sha → same record
    const byHead = await kbJson(`/provenance?sha=${HEAD_SHA.slice(0, 9)}`);
    expect(byHead.status).toBe(200);
    expect(byHead.body.pr).toBe(185);

    // the card carries its own provenance (board-side storage of record)
    const card = await kbJson(`/artefact?id=${encodeURIComponent(taskId)}`);
    expect(card.body.meta.provenance.pr).toBe(185);
    expect(card.body.meta.provenance.signer).toBe("detached-cody");
    void card;
  });

  it("dedupes per (repo, pr) and records class-only provenance for card-less merges", async () => {
    const before = await kbJson("/admin.provenance_sweep", { now: Date.now() + 1_200_000 });
    expect(before.status).toBe(200);
    const count = Number(before.body.indexed);
    // second sweep of the same data: nothing new (immutable once stamped)
    const after = await kbJson("/admin.provenance_sweep", { now: Date.now() + 1_800_000 });
    expect(Number(after.body.indexed)).toBe(count);
    expect(count).toBeGreaterThanOrEqual(1); // PR 186 (no card) still indexed
    const noCard = await kbJson(`/provenance?sha=${"b".repeat(40)}`);
    expect(noCard.status).toBe(200);
    expect(noCard.body.task).toBeNull();
    expect(noCard.body.signer).toBe("signed");
  });

  it("lookup contract: bad sha → 400, unknown sha → 404", async () => {
    const bad = await kbJson("/provenance?sha=zzz");
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toContain("7-40 hex");
    const unknown = await kbJson(`/provenance?sha=${"e".repeat(40)}`);
    expect(unknown.status).toBe(404);
    expect(String(unknown.body.error)).toContain("no bridge provenance");
  });
});
