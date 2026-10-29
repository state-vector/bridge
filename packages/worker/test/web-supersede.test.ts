import { Miniflare } from "miniflare";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Web supersede plane (BR#3910) — the one-click human supersede.
 *
 * Kills two incident classes: the answer-before-click misfire (BR#3649 — the
 * only supersede affordance was buried, so GO answers landed but the click had
 * nowhere to land) and the timer-spin churn (BR#3905 — dead-premise blocked
 * cards nobody could discoverably kill, so proxy-watch respawned re-check
 * duties forever).
 *
 * Contract under test:
 * - POST /api/kb/supersede (cookie/human session) composes the documented
 *   two-step server-side (blocked → release → todo → superseded, the
 *   BR#1852/BR#1935 precedent) in ONE call — the card lands superseded with
 *   the supersedes relation to its replacement.
 * - BR#2480 gate: a gateway bearer (an agent identity) is refused 403 — no
 *   agent may supersede. The MCP/agent transition surface still has no
 *   →superseded edge; only this human-plane route composes it.
 * - Error law (the defect class being fixed — silent no-ops): every refused
 *   supersede (in_progress card, unknown replacement, self-replacement)
 *   returns 400 with the reason and leaves the card byte-for-byte unchanged.
 */

const SECRET = "test-gh-secret";

function sessionCookie(login = "ray", ws = "global") {
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

async function createTask(title: string): Promise<string> {
  const r = await api("/api/kb/create", { method: "POST", body: JSON.stringify({ type: "task", title }) });
  expect(r.status).toBe(200);
  const b = await r.json() as any;
  expect(b.id).toMatch(/^BR#\d+$/);
  return b.id;
}

async function blockTask(id: string): Promise<void> {
  const r = await api("/api/kb/transition", {
    method: "POST",
    body: JSON.stringify({
      id, to: "blocked",
      note: "test park",
      unblock_condition: "test — never resumes",
      await_event: { event: "time", until_ts: Date.now() + 3600_000 },
    }),
  });
  expect(r.status).toBe(200);
}

async function statusOf(id: string): Promise<{ status: string; meta: any; relations: any[] }> {
  const r = await api(`/api/kb/artefact?id=${encodeURIComponent(id)}`);
  expect(r.status).toBe(200);
  const b = await r.json() as any;
  return { status: b.status, meta: b.meta ?? {}, relations: b.relations ?? [] };
}

const supersede = (id: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  api("/api/kb/supersede", { method: "POST", body: JSON.stringify({ id, ...body }), headers });

describe("POST /api/kb/supersede — the one-click human supersede (BR#3910)", () => {
  it("composes blocked → todo → superseded in ONE call, with the replacement lineage", async () => {
    const card = await createTask("web supersede: blocked card two-step");
    const replacement = await createTask("web supersede: the replacement card");
    await blockTask(card);

    const r = await supersede(card, { replacement_id: replacement });
    expect(r.status).toBe(200);
    const b = await r.json() as any;
    expect(b.status).toBe("superseded");
    expect(b.replacement_id).toBe(replacement);

    const { status, meta, relations } = await statusOf(card);
    expect(status).toBe("superseded");
    expect(meta.superseded_by).toBe(replacement);
    expect(String(meta.superseded_reason)).toContain(replacement);
    // terminal card: no stale claim, no resurrectable park
    expect(meta.blocked).toBeUndefined();
    // machine-readable lineage: replacement —supersedes→ superseded card
    expect(relations.some((x) => x.relation === "supersedes" && x.artefact_id === replacement)).toBe(true);

    // the documented two-step is visible in history (blocked → todo → superseded)
    const h = await api(`/api/kb/history?id=${encodeURIComponent(card)}`).then((x) => x.json() as any);
    const transitions = (h.versions ?? []).filter((v: any) => v.action === "transition").map((v: any) => v.summary);
    expect(transitions.some((s: string) => s.includes("blocked → todo"))).toBe(true);
    expect(transitions.some((s: string) => s.includes("→ superseded"))).toBe(true);
  });

  it("supersedes a todo card directly (no release leg needed)", async () => {
    const card = await createTask("web supersede: todo card direct");
    const r = await supersede(card, {});
    expect(r.status).toBe(200);
    expect((await r.json() as any).status).toBe("superseded");
    expect((await statusOf(card)).status).toBe("superseded");
  });

  it("normalizes a bare-number replacement to the board id shape", async () => {
    const card = await createTask("web supersede: bare-number replacement");
    const replacement = await createTask("web supersede: numbered successor");
    const bare = replacement.replace(/^BR#/, "");
    const r = await supersede(card, { replacement_id: bare });
    expect(r.status).toBe(200);
    expect((await r.json() as any).replacement_id).toBe(replacement);
    expect((await statusOf(card)).meta.superseded_by).toBe(replacement);
  });

  it("refuses an in_progress card — error surfaces, card unchanged (no silent no-op)", async () => {
    const card = await createTask("web supersede: live claim refuses");
    const claim = await api("/api/kb/transition", { method: "POST", body: JSON.stringify({ id: card, to: "in_progress", note: "claimed" }) });
    expect(claim.status).toBe(200);

    const r = await supersede(card, {});
    expect(r.status).toBe(400);
    const err = await r.json() as any;
    expect(String(err.error)).toMatch(/blocked\|todo/);
    expect((await statusOf(card)).status).toBe("in_progress");
  });

  it("refuses an unknown replacement — card unchanged", async () => {
    const card = await createTask("web supersede: unknown replacement refuses");
    await blockTask(card);
    const r = await supersede(card, { replacement_id: "BR#999999" });
    expect(r.status).toBe(400);
    expect(String((await r.json() as any).error)).toMatch(/not found/);
    expect((await statusOf(card)).status).toBe("blocked");
  });

  it("refuses self-replacement — a card cannot supersede into itself", async () => {
    const card = await createTask("web supersede: self-replacement refuses");
    await blockTask(card);
    const r = await supersede(card, { replacement_id: card });
    expect(r.status).toBe(400);
    expect((await statusOf(card)).status).toBe("blocked");
  });

  it("refuses a gateway bearer 403 — agents cannot supersede (BR#2480), card unchanged", async () => {
    const mint = await api("/api/kb/admin/tokens", { method: "POST", body: JSON.stringify({ label: "supersede-agent-test", tags: [] }) });
    expect(mint.status).toBe(200);
    const { secret } = await mint.json() as any;
    expect(secret).toBeTruthy();

    const card = await createTask("web supersede: agent bearer refuses");
    await blockTask(card);
    const r = await supersede(card, { replacement_id: "" }, { cookie: "", authorization: `Bearer ${secret}` });
    expect(r.status).toBe(403);
    expect(String((await r.json() as any).error)).toMatch(/BR#2480/);
    expect((await statusOf(card)).status).toBe("blocked");
  });
});
