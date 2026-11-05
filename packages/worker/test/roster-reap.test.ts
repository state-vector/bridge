import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rosterReapPace, rosterReapVerdict } from "../src/kb/core.ts";

/**
 * BR#4684 roster hygiene on real miniflare SQLite — the reap is an ARCHIVE
 * (revoke), never a delete, and its blast radius is exactly the dead-
 * registration class:
 *  - gateway-class rows quiet past `roster_reap_days` (default 7) → revoked,
 *    hidden from the roster, row + audit kept (a returning machine re-pairs
 *    and rotates the same row back to life — BR#3787 replace semantics);
 *  - never-seen provisioning debris (created past the threshold, zero auths)
 *    → revoked regardless of class;
 *  - once-seen agent identities survive silence (board history is not
 *    debris); fresh rows survive; `_`-prefixed system namespaces are exempt;
 *  - `roster_reap_hours=0` disables the paced alarm leg (the admin drill
 *    still forces), and an explicit 0 never folds into the 6h fallback.
 */

let mf: Miniflare;
let kb: (path: string, init?: RequestInit) => Promise<Response>;

beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  if (!existsSync(bundle)) {
    throw new Error("bundle missing — run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle (the npm test script does this before vitest)");
  }
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
  const stub = await ns.get(ns.idFromName("global"));
  kb = (path, init) => stub.fetch(`https://kb${path}`, init);
  await kb("/orient", { actor: "test" });
});

afterAll(async () => {
  await mf?.dispose();
});

async function kbJson(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await kb(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function mint(label: string, tags: string[]): Promise<{ id: string; secret: string }> {
  const r = await kbJson("/admin.mint", { label, tags });
  expect(r.status).toBe(200);
  return { id: String(r.body.id), secret: String(r.body.secret) };
}

const DAY = 86_400_000;

describe("BR#4684 pure matrix — rosterReapVerdict", () => {
  const cutoff = 1_000_000_000_000;

  it("gateway-class quiet past the cutoff → gateway_stale", () => {
    expect(rosterReapVerdict(
      { label: "mac-modem", tags: ["gateway"], created_ts: cutoff - 30 * DAY, last_seen_ts: cutoff - 8 * DAY },
      cutoff,
    )).toBe("gateway_stale");
  });

  it("gateway tag is matched case-insensitively (mint does not sanitize tags)", () => {
    expect(rosterReapVerdict(
      { label: "Gateway-Weird-Case", tags: ["Gateway"], created_ts: cutoff - DAY, last_seen_ts: cutoff - 9 * DAY },
      cutoff,
    )).toBe("gateway_stale");
  });

  it("gateway-class seen inside the window → keep", () => {
    // cutoff = now - 7d; "inside the window" = seen AFTER the cutoff
    expect(rosterReapVerdict(
      { label: "live-gw", tags: ["gateway"], created_ts: cutoff - 30 * DAY, last_seen_ts: cutoff + 6 * DAY },
      cutoff,
    )).toBe("keep");
  });

  it("once-seen agent identity past the cutoff → keep — board history is not debris", () => {
    expect(rosterReapVerdict(
      { label: "quiet-agent", tags: [], created_ts: cutoff - 90 * DAY, last_seen_ts: cutoff - 60 * DAY },
      cutoff,
    )).toBe("keep");
  });

  it("never-seen past the cutoff → never_seen, any class", () => {
    expect(rosterReapVerdict(
      { label: "Mac.variant.debris", tags: [], created_ts: cutoff - 8 * DAY, last_seen_ts: null },
      cutoff,
    )).toBe("never_seen");
    expect(rosterReapVerdict(
      { label: "never-paired-gw", tags: ["gateway"], created_ts: cutoff - 8 * DAY, last_seen_ts: null },
      cutoff,
    )).toBe("never_seen");
  });

  it("never-seen but fresh → keep", () => {
    // created AFTER the cutoff — a pre-minted token inside the grace week
    expect(rosterReapVerdict(
      { label: "pre-minted", tags: [], created_ts: cutoff + DAY, last_seen_ts: null },
      cutoff,
    )).toBe("keep");
  });

  it("never-seen of unknown provenance → keep — the reap archives, it never guesses", () => {
    expect(rosterReapVerdict({ label: "no-provenance", tags: [], created_ts: null, last_seen_ts: null }, cutoff)).toBe("keep");
    expect(rosterReapVerdict({ label: "no-provenance", tags: [], last_seen_ts: null }, cutoff)).toBe("keep");
  });

  it("`_`-prefixed system namespaces are plumbing, not roster → keep", () => {
    expect(rosterReapVerdict(
      { label: "_direct/cody", tags: [], created_ts: cutoff - 400 * DAY, last_seen_ts: null },
      cutoff,
    )).toBe("keep");
  });
});

describe("BR#4684 pure pacing — rosterReapPace", () => {
  const now = 10_000_000_000_000;

  it("an explicit 0 disables and never folds into the fallback (parseInt(x)||6 would)", () => {
    expect(rosterReapPace("0", 0, now)).toBe("disabled");
    expect(rosterReapPace("0", now - 100 * 3_600_000, now)).toBe("disabled");
  });

  it("garbage and blank fall back to the 6h default", () => {
    expect(rosterReapPace("abc", 0, now)).toBe("run");
    expect(rosterReapPace("", 0, now)).toBe("run");
    expect(rosterReapPace(undefined, 0, now)).toBe("run");
  });

  it("inside the window → skip, past it → run", () => {
    expect(rosterReapPace("6", now - 3_600_000, now)).toBe("skip");
    expect(rosterReapPace("6", now - 7 * 3_600_000, now)).toBe("run");
    expect(rosterReapPace("6", 0, now)).toBe("run");
  });

  it("the window clamps to a week", () => {
    expect(rosterReapPace("100000", 0, now)).toBe("run");
    expect(rosterReapPace("100000", now - 167 * 3_600_000, now)).toBe("skip");
    expect(rosterReapPace("100000", now - 169 * 3_600_000, now)).toBe("run");
  });
});

describe("BR#4684 integration — the reap archives on real storage", () => {
  it("reaps stale gateways + never-seen debris past the threshold; once-seen agent history survives", async () => {
    const now = Date.now();
    const gwStale = await mint("roster-gw-stale", ["gateway"]);
    await mint("roster-gw-also-stale", ["gateway"]);
    const agentOld = await mint("roster-agent-old", []);
    await mint("roster-never-gw", ["gateway"]);
    await mint("Mac.variant.debris", []);
    // touch last_seen on three of the five (the other two stay never-seen).
    // identify() stamps the REAL clock — at a now+8d drill both seen gateways
    // are legitimately past the 7d bar; the +1d drill below proves the
    // recently-live survivor.
    for (const secret of [gwStale.secret, agentOld.secret]) {
      const id = await kbJson("/auth.identify", { bearer: secret });
      expect(id.status).toBe(200);
    }
    const res = await kbJson("/admin.roster_reap", { now: now + 8 * DAY });
    expect(res.status).toBe(200);
    expect([...res.body.roster.labels].sort()).toEqual([
      "Mac.variant.debris",
      "roster-gw-also-stale",
      "roster-gw-stale",
      "roster-never-gw",
    ]);
    const toks = (await kbJson("/admin.list_tokens", {})).body.tokens as any[];
    const byLabel = new Map(toks.map((t: any) => [t.label, t]));
    for (const label of ["roster-gw-stale", "roster-gw-also-stale", "roster-never-gw", "Mac.variant.debris"]) {
      expect(Number(byLabel.get(label).revoked_ts ?? 0)).toBeGreaterThan(0);
      // archive, not delete — the row is still on the ledger
      expect(byLabel.has(label)).toBe(true);
    }
    expect(Number(byLabel.get("roster-agent-old").revoked_ts ?? 0)).toBe(0);
  });

  it("recently-live gateways survive: at a +1d clock the seen gateway is inside the window", async () => {
    const now = Date.now();
    const gwFresh = await mint("roster-gw-fresh", ["gateway"]);
    const id = await kbJson("/auth.identify", { bearer: gwFresh.secret });
    expect(id.status).toBe(200);
    await mint("roster-never-fresh", ["gateway"]); // never seen, created now
    const res = await kbJson("/admin.roster_reap", { now: now + DAY });
    expect(res.status).toBe(200);
    expect(res.body.roster.reaped).toBe(0);
    const toks = (await kbJson("/admin.list_tokens", {})).body.tokens as any[];
    const byLabel = new Map(toks.map((t: any) => [t.label, t]));
    expect(Number(byLabel.get("roster-gw-fresh").revoked_ts ?? 0)).toBe(0);
    expect(Number(byLabel.get("roster-never-fresh").revoked_ts ?? 0)).toBe(0);
  });

  it("roster_reap_days moves the threshold (3d setting reaps a 4d-stale gateway)", async () => {
    const now = Date.now();
    await mint("roster-days-gw", ["gateway"]);
    await kbJson("/admin.settings_set", { settings: { roster_reap_days: 3 } });
    const res = await kbJson("/admin.roster_reap", { now: now + 4 * DAY });
    expect(res.status).toBe(200);
    expect(res.body.roster.labels ?? []).toContain("roster-days-gw");
    await kbJson("/admin.settings_set", { settings: { roster_reap_days: 7 } });
  });

  it("a revoked token stops authenticating — the archive holds the door", async () => {
    const now = Date.now();
    const dead = await mint("roster-reauth-gw", ["gateway"]);
    await kbJson("/admin.roster_reap", { now: now + 8 * DAY }); // never-seen → reaped
    const reauth = await kb("/auth.identify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bearer: dead.secret }),
    });
    expect(reauth.status).toBeGreaterThanOrEqual(400);
  });
});
