import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * GH#489 — the operator exoneration route rides the human web plane.
 *
 * The DO op `train.pardon` is deliberately absent from the MCP tool surface
 * (agents exonerate nothing themselves), so the human route is the only
 * external door: POST /api/kb/train_pardon with a web session cookie,
 * forwarded with the admin-mint header (the DO re-verifies it server-side).
 * Contract under test (same trust family as BR#21657's release_claim):
 * - a gateway bearer is refused 403 — never agent-reachable;
 * - a web session reaches the DO op and its evidence-bar gates surface
 *   (here: no unpardoned train_red_ding for the named episode — the refusal
 *   proves the route, the auth shape AND the gate in one round trip).
 */

const SECRET = "test-gh-secret";

function sessionCookie(login = "ray", ws = "state-vector") {
  const exp = String(Date.now() + 60_000);
  const sig = createHmac("sha256", SECRET).update(`${exp}.${login}.${ws}`).digest("hex");
  return `bridge_session=${exp}.${login}.${ws}.${sig}`;
}

let mf: Miniflare;
let cookie: string;

beforeAll(() => {
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
      durableObjects: { KB: { className: "KnowledgeHub", useSQLite: true } },
      bindings: { GITHUB_CLIENT_ID: "test-client", GITHUB_CLIENT_SECRET: SECRET },
    }] as any,
  });
  cookie = sessionCookie();
});

afterAll(async () => {
  await mf.dispose();
});

const api = (path: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) =>
  mf.dispatchFetch(`https://main${path}`, {
    method: init?.method ?? "GET",
    headers: { cookie, "content-type": "application/json", ...(init?.headers ?? {}) },
    body: init?.body,
  });

const pardonBody = {
  sha: "74c6ddcd5aa",
  culprit: "BR#999999",
  reason: "GitHub-side transient, same run green on rerun",
  evidence: [{ kind: "rerun_green", repo: "state-vector/superpositional", run_id: "45646090850", receipt_url: "https://github.com/state-vector/superpositional/actions/runs/45646090850" }],
};

describe("GH#489 train.pardon — web-plane route", () => {
  it("refuses a gateway bearer — the exoneration override is never agent-reachable", async () => {
    // mint a real machine token through the human admin API, then use it
    const mint = await api("/api/kb/admin/tokens", { method: "POST", body: JSON.stringify({ label: "gh489-bearer", tags: ["gateway"] }) });
    expect(mint.status).toBe(200);
    const minted = await mint.json() as any;
    const secret = minted?.token?.secret ?? minted?.secret;
    expect(secret).toBeTruthy();
    const r = await api("/api/kb/train_pardon", {
      method: "POST",
      body: JSON.stringify(pardonBody),
      headers: { cookie: "", authorization: `Bearer ${secret}` },
    });
    expect(r.status).toBe(403);
    const b = await r.json() as any;
    expect(String(b.error)).toMatch(/web\/human-only/);
  });

  it("a web session reaches the DO op — the evidence-bar gate surfaces through the route", async () => {
    const r = await api("/api/kb/train_pardon", { method: "POST", body: JSON.stringify(pardonBody) });
    expect(r.status).toBeLessThan(500);
    const b = await r.json() as any;
    expect(String(b.error)).toMatch(/gate: no unpardoned train_red_ding/);
  });
});
