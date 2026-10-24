import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Throughput endpoint integration (BR#2937): the real worker entry + the real
 * KnowledgeHub DO on real miniflare SQLite. Seeds done transitions through
 * the public REST plane (create → claim → done, receipted as a verdict duty
 * would close), then reads /api/kb/metrics/throughput. Multi-bucket math is
 * covered by test/throughput.test.ts; this proves the endpoint wiring, the
 * ledger aggregation SQL, and the auth plane end-to-end.
 */

const SECRET = "test-gh-secret";

let mf: Miniflare;
let cookie: string;

function sessionCookie(login = "ray", ws = "global") {
  const exp = String(Date.now() + 60_000);
  const sig = createHmac("sha256", SECRET).update(`${exp}.${login}.${ws}`).digest("hex");
  return `bridge_session=${exp}.${login}.${ws}.${sig}`;
}

beforeAll(() => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  if (!existsSync(bundle)) {
    throw new Error("bundle missing — run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle");
  }
  mf = new Miniflare({
    workers: [
      {
        name: "main",
        scriptPath: bundle,
        // realpath + modulesRoot: workerd's virtual FS rejects ".." segments
        modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")),
        modules: true,
        compatibilityDate: "2025-09-06",
        // same-worker DO binding: the bundle exports KnowledgeHub (useSQLite —
        // wrangler.toml declares it new_sqlite_classes; miniflare needs the flag)
        durableObjects: { KB: { className: "KnowledgeHub", useSQLite: true } },
        bindings: { GITHUB_CLIENT_ID: "test-client", GITHUB_CLIENT_SECRET: SECRET },
      },
    ],
  });
  cookie = sessionCookie();
});

afterAll(async () => {
  await mf.dispose();
});

const api = (path: string, init?: { method?: string; body?: string }) =>
  mf.dispatchFetch(`https://main${path}`, {
    method: init?.method ?? "GET",
    headers: { cookie, "content-type": "application/json" },
    body: init?.body,
  });

async function seedDone(title: string): Promise<string> {
  const create = await api("/api/kb/create", {
    method: "POST",
    body: JSON.stringify({ type: "task", title, tags: ["role:review"] }),
  }).then((r) => r.json() as any);
  expect(create.id).toMatch(/^BR#\d+$/);
  // verdict duties: claim → done with receipts (machine.ts verdict rules)
  let r = await api("/api/kb/transition", { method: "POST", body: JSON.stringify({ id: create.id, to: "in_progress", note: "claim" }) });
  expect(r.status).toBe(200);
  r = await api("/api/kb/transition", { method: "POST", body: JSON.stringify({ id: create.id, to: "done", note: "PR #991 merged — verified" }) });
  expect(r.status).toBe(200);
  return create.id;
}

describe("GET /api/kb/metrics/throughput", () => {
  it("aggregates seeded done transitions: today's bucket, cumulative, shape", async () => {
    const ids = [await seedDone("tp smoke 1"), await seedDone("tp smoke 2"), await seedDone("tp smoke 3")];
    const res = await api("/api/kb/metrics/throughput?bucket=day&range=30d");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.bucket).toBe("day");
    expect(body.range_days).toBe(30);
    expect(Array.isArray(body.buckets)).toBe(true);
    expect(body.buckets).toHaveLength(30);
    expect(body.total).toBeGreaterThanOrEqual(3);
    const last = body.buckets[body.buckets.length - 1];
    expect(last.n).toBeGreaterThanOrEqual(3); // all seeded now → today's bucket
    expect(last.cumulative).toBe(body.total); // cumulative ends at the range total
    // superseded/blocked never enter — the seeded ids are the only contributors
    void ids;
  });

  it("week toggle groups the same data", async () => {
    const res = await api("/api/kb/metrics/throughput?bucket=week&range=28d");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.bucket).toBe("week");
    expect(body.buckets).toHaveLength(4);
    expect(body.buckets[body.buckets.length - 1].n).toBeGreaterThanOrEqual(3);
  });

  it("bad params → 400 with the message, auth still gates", async () => {
    const bad = await api("/api/kb/metrics/throughput?bucket=hour");
    expect(bad.status).toBe(400);
    expect(String(((await bad.json()) as any).error)).toContain("bucket");
    const anon = await mf.dispatchFetch("https://main/api/kb/metrics/throughput", { headers: { accept: "application/json" } });
    expect(anon.status).toBe(401);
  });
});
