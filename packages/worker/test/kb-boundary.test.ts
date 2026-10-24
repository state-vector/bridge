import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Loud-failure boundary (2026-10-24 naked-500 incident): a transient DO
 * fault on the worker→KnowledgeHub subrequest (observed live on
 * /api/kb/ask_answer — an answer 500'd once, the identical retry succeeded)
 * must surface as an ATTRIBUTED 502 naming the fault, never an uncaught
 * naked 500. Drives the real worker entry (bundled) with its KB binding
 * pointed at a FaultyKB DO whose fetch always throws — the transport-fault
 * shape, exercised through the real DO RPC path.
 */

const SECRET = "test-gh-secret";

let mf: Miniflare;

/** Mint a github-mode session cookie the same way index.js does:
 *  bridge_session=<exp>.<login>.<ws>.<hmac(exp.login.ws, GITHUB_CLIENT_SECRET)> */
function sessionCookie(login = "ray", ws = "global") {
  const exp = String(Date.now() + 60_000);
  const sig = createHmac("sha256", SECRET).update(`${exp}.${login}.${ws}`).digest("hex");
  return `bridge_session=${exp}.${login}.${ws}.${sig}`;
}

beforeAll(() => {
  // realpath: workerd's virtual FS rejects ".." path segments (multi-worker mode)
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  if (!existsSync(bundle)) {
    throw new Error("bundle missing — run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle (the npm test script does this before vitest)");
  }
  mf = new Miniflare({
    workers: [
      {
        name: "main",
        scriptPath: bundle,
        modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")),
        modules: true,
        compatibilityDate: "2025-09-06",
        durableObjects: { KB: { scriptName: "mock-kb", className: "FaultyKB" } },
        bindings: { GITHUB_CLIENT_ID: "test-client", GITHUB_CLIENT_SECRET: SECRET },
      },
      {
        name: "mock-kb",
        script: `export class FaultyKB {
          async fetch() {
            throw new Error("Durable Object reset while handling request");
          }
        }`,
        modules: true,
        compatibilityDate: "2025-09-06",
      },
    ],
  });
});

afterAll(async () => {
  await mf.dispose();
});

describe("kb REST mirror boundary: DO transport faults are attributed, not naked 500s", () => {
  it("GET /api/kb/board → 502 naming the fault, retryable", async () => {
    const res = await mf.dispatchFetch("https://main/api/kb/board", {
      headers: { cookie: sessionCookie() },
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as any;
    expect(String(body.error)).toContain("knowledge hub unreachable");
    expect(String(body.error)).toContain("Durable Object reset");
    expect(body.retryable).toBe(true);
  });

  it("POST /api/kb/ask_answer → 502 naming the fault (the incident path)", async () => {
    const res = await mf.dispatchFetch("https://main/api/kb/ask_answer", {
      method: "POST",
      headers: { cookie: sessionCookie(), "content-type": "application/json" },
      body: JSON.stringify({ id: "BR#1", answer: "NO-GO/redirect — re-sign" }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as any;
    expect(String(body.error)).toContain("Durable Object reset");
  });

  it("POST /api/kb/ask_reframe → 502 (same boundary)", async () => {
    const res = await mf.dispatchFetch("https://main/api/kb/ask_reframe", {
      method: "POST",
      headers: { cookie: sessionCookie(), "content-type": "application/json" },
      body: JSON.stringify({ id: "BR#2", feedback: "restructure" }),
    });
    expect(res.status).toBe(502);
  });

  it("auth still gates: no cookie → 401, no DO call", async () => {
    const res = await mf.dispatchFetch("https://main/api/kb/board", {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(401);
  });
});
