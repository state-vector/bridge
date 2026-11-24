import { Miniflare } from "miniflare";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Owner web-plane overrides (BR#21657) — claim release + wedged-hold clear/park.
 *
 * The motivating wedge (BR#3625, Ray 2026-11-25: "there is no mechanism to
 * manually release a claim - perhaps we need to add that to bridge,
 * admin/overrides menu for tasks?"): a delivered, review-admitted card claimed
 * by a dead interactive credential was humanly unreachable — claim release
 * didn't exist for interactive credentials, takeover was refused
 * `takeover-held` behind a stale typed wait (the train's `bounced` state while
 * the pr_merged leg had already landed), and close was gate-refused.
 *
 * Contract under test:
 * - POST /api/kb/release_claim (cookie/human session) releases ANY claim
 *   class to the pool, composed through the normal transition executor: the
 *   card lands todo, owner cleared, meta.session/interactive stamps die.
 * - POST /api/kb/clear_hold clears a WEDGED hold whose defect no longer
 *   matches live state (stale train bounce → unbound, typed await_event /
 *   bound ask → deleted, meta.hold_cleared provenance stamped) or PARKS the
 *   card blocked over it (grammar-valid typed time re-check).
 * - A live train slot (queued) is NOT clearable — clearing would strand the
 *   serialized queue (BR#4067); park is the override for that class.
 * - A typed reason is mandatory; refusals are 400/403 with the card
 *   byte-for-byte unchanged (no silent no-ops — the supersede error law).
 * - Web/human-only: a gateway bearer is refused 403 — never agent-reachable.
 * - End-to-end BR#3625 shape: takeover refused takeover-held behind the stale
 *   bounce → clear_hold frees the exit → release_claim → todo (wedge broken).
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

async function createTask(title: string): Promise<string> {
  const r = await api("/api/kb/create", { method: "POST", body: JSON.stringify({ type: "task", title }) });
  expect(r.status).toBe(200);
  const b = await r.json() as any;
  expect(b.id).toMatch(/^BR#\d+$/);
  return b.id;
}

async function claimTask(id: string): Promise<void> {
  const r = await api("/api/kb/transition", { method: "POST", body: JSON.stringify({ id, to: "in_progress", note: "claimed" }) });
  expect(r.status).toBe(200);
}

async function patchMeta(id: string, meta: Record<string, unknown>): Promise<void> {
  const r = await api("/api/kb/update", { method: "POST", body: JSON.stringify({ id, meta }) });
  expect(r.status).toBe(200);
}

async function statusOf(id: string): Promise<{ status: string; owner: string; meta: any }> {
  const r = await api(`/api/kb/artefact?id=${encodeURIComponent(id)}`);
  expect(r.status).toBe(200);
  const b = await r.json() as any;
  return { status: b.status, owner: b.owner ?? "", meta: b.meta ?? {} };
}

const releaseClaim = (id: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  api("/api/kb/release_claim", { method: "POST", body: JSON.stringify({ id, ...body }), headers });

const clearHold = (id: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  api("/api/kb/clear_hold", { method: "POST", body: JSON.stringify({ id, ...body }), headers });

describe("POST /api/kb/release_claim — owner claim release (BR#21657)", () => {
  it("releases a claimed card to the pool in ONE call — owner cleared, session stamps die", async () => {
    const card = await createTask("owner overrides: release a live claim");
    await claimTask(card);
    expect((await statusOf(card)).status).toBe("in_progress");

    const r = await releaseClaim(card, { reason: "holder session is dead since Nov 17 — wedged card" });
    expect(r.status).toBe(200);
    const b = await r.json() as any;
    expect(b.ok).toBe(true);
    expect(b.status).toBe("todo");

    const { status, owner, meta } = await statusOf(card);
    expect(status).toBe("todo");
    expect(owner).toBe(""); // owner_clear — a released card carries no stale claim
    expect(meta.session).toBeUndefined();
    expect(meta.interactive_execution).toBeUndefined();
    // the override is audited with actor + reason on the card's history
    const h = await api(`/api/kb/history?id=${encodeURIComponent(card)}`).then((x) => x.json() as any);
    const notes = (h.versions ?? []).map((v: any) => v.summary ?? "");
    expect(notes.some((s: string) => s.includes("owner override: claim released"))).toBe(true);
    expect(notes.some((s: string) => s.includes("holder session is dead"))).toBe(true);
  });

  it("releases a blocked card with a stale claim too", async () => {
    const card = await createTask("owner overrides: release a blocked claim");
    await claimTask(card);
    const park = await api("/api/kb/transition", {
      method: "POST",
      body: JSON.stringify({ id: card, to: "blocked", note: "waiting", await_event: { event: "time", until_ts: Date.now() + 3600_000 } }),
    });
    expect(park.status).toBe(200);
    const r = await releaseClaim(card, { reason: "owner parked and left — release the claim" });
    expect(r.status).toBe(200);
    expect((await r.json() as any).status).toBe("todo");
    const { status, owner } = await statusOf(card);
    expect(status).toBe("todo");
    expect(owner).toBe("");
  });

  it("refuses a missing reason — the override is audited with a typed reason", async () => {
    const card = await createTask("owner overrides: release without reason refuses");
    await claimTask(card);
    const r = await releaseClaim(card, {});
    expect(r.status).toBe(400);
    expect(String((await r.json() as any).error)).toMatch(/reason/);
    expect((await statusOf(card)).status).toBe("in_progress"); // unchanged
  });

  it("refuses a todo card (nothing claimed)", async () => {
    const todo = await createTask("owner overrides: release a todo card refuses");
    const r = await releaseClaim(todo, { reason: "nothing to release" });
    expect(r.status).toBe(400);
    expect(String((await r.json() as any).error)).toMatch(/in_progress\|blocked/);
    expect((await statusOf(todo)).status).toBe("todo"); // unchanged
  });

  it("refuses a gateway bearer 403 — never agent-reachable", async () => {
    const mint = await api("/api/kb/admin/tokens", { method: "POST", body: JSON.stringify({ label: "overrides-agent-test", tags: ["gateway"] }) });
    expect(mint.status).toBe(200);
    const { secret } = await mint.json() as any;
    expect(secret).toBeTruthy();

    const card = await createTask("owner overrides: agent bearer refuses release");
    await claimTask(card);
    const r = await releaseClaim(card, { reason: "agents cannot do this" }, { cookie: "", authorization: `Bearer ${secret}` });
    expect(r.status).toBe(403);
    expect(String((await r.json() as any).error)).toMatch(/BR#21657/);
    expect((await statusOf(card)).status).toBe("in_progress");

    const rc = await clearHold(card, { hold: "merge_train", action: "clear", reason: "agents cannot do this either" }, { cookie: "", authorization: `Bearer ${secret}` });
    expect(rc.status).toBe(403);
  });
});

describe("POST /api/kb/clear_hold — wedged hold clear/park (BR#21657)", () => {
  it("clears a stale train bounce → unbound, with provenance; card keeps its status", async () => {
    const card = await createTask("owner overrides: clear a stale train bounce");
    await claimTask(card);
    // the BR#3625 shape: train state bounced while the defect no longer matches live state
    await patchMeta(card, { merge_train: { state: "bounced", repo: "state-vector/superpositional", pr: 2456 } });

    const r = await clearHold(card, { hold: "merge_train", action: "clear", reason: "the pr_merged leg already landed — the bounce defect is stale" });
    expect(r.status).toBe(200);
    const b = await r.json() as any;
    expect(b.status).toBe("in_progress"); // the card keeps its status
    expect(b.hold).toBe("merge_train");

    const { meta } = await statusOf(card);
    expect(String(meta.merge_train?.state)).toBe("unbound"); // BR#6330: holds nothing
    expect(meta.hold_cleared?.hold).toBe("merge_train");
    expect(meta.hold_cleared?.reason).toContain("stale");
  });

  it("clears a typed await_event marker; the park prose stays", async () => {
    const card = await createTask("owner overrides: clear a typed await_event");
    const park = await api("/api/kb/transition", {
      method: "POST",
      body: JSON.stringify({ id: card, to: "blocked", note: "waiting on a stale probe", await_event: { event: "time", until_ts: Date.now() + 3600_000 } }),
    });
    expect(park.status).toBe(200);
    const r = await clearHold(card, { hold: "await_event", action: "clear", reason: "the probe condition is already satisfied" });
    expect(r.status).toBe(200);
    const { status, meta } = await statusOf(card);
    expect(status).toBe("blocked"); // status unchanged — unblock now works
    expect(meta.blocked?.await_event).toBeUndefined();
    expect(meta.blocked?.reason).toContain("stale probe"); // the park prose box stays
    expect(meta.hold_cleared?.hold).toBe("await_event");
  });

  it("refuses to clear a LIVE train slot — the serialized queue owns it (BR#4067); park instead", async () => {
    const card = await createTask("owner overrides: live slot is not clearable");
    await claimTask(card);
    await patchMeta(card, { merge_train: { state: "queued", repo: "state-vector/superpositional", pr: 2457 } });
    const r = await clearHold(card, { hold: "merge_train", action: "clear", reason: "trying to strand the queue" });
    expect(r.status).toBe(400);
    expect(String((await r.json() as any).error)).toMatch(/live train slot/);
    expect(String((await statusOf(card)).meta.merge_train?.state)).toBe("queued"); // unchanged
  });

  it("parks a wedged card blocked with a grammar-valid typed re-check timer", async () => {
    const card = await createTask("owner overrides: park over a wedged bound ask");
    await claimTask(card);
    await patchMeta(card, { awaiting_ask: { ask_id: "BR#9999", reason: "human decision" } });

    const r = await clearHold(card, { hold: "bound_ask", action: "park", reason: "the bound ask is wedged — freeze for inspection" });
    expect(r.status).toBe(200);
    const b = await r.json() as any;
    expect(b.status).toBe("blocked");
    const { status, meta } = await statusOf(card);
    expect(status).toBe("blocked");
    // the park is grammar-valid: a typed time await, not prose-only
    expect(meta.blocked?.await_event?.event).toBe("time");
    expect(Number(meta.blocked?.await_event?.until_ts)).toBeGreaterThan(Date.now());
    expect(meta.blocked?.reason).toContain("owner override park");
  });

  it("refuses park on an already-blocked card and clear of an absent hold — card unchanged", async () => {
    const card = await createTask("owner overrides: park/absent refusals");
    const park = await api("/api/kb/transition", {
      method: "POST",
      body: JSON.stringify({ id: card, to: "blocked", note: "already parked", await_event: { event: "time", until_ts: Date.now() + 3600_000 } }),
    });
    expect(park.status).toBe(200);
    const r = await clearHold(card, { hold: "merge_train", action: "park", reason: "already parked" });
    expect(r.status).toBe(400);
    expect(String((await r.json() as any).error)).toMatch(/already parked/);
    const c = await clearHold(card, { hold: "merge_train", action: "clear", reason: "no train state here" });
    expect(c.status).toBe(400);
    expect(String((await c.json() as any).error)).toMatch(/no clearable train state/);
    expect((await statusOf(card)).status).toBe("blocked");
  });
});

describe("BR#3625 end-to-end — the interactive-claim wedge is humanly breakable", () => {
  it("takeover refused behind the stale bounce → clear_hold frees the exit → release_claim → todo", async () => {
    const card = await createTask("BR#3625 shape: delivered card wedged behind a stale bounce");
    await claimTask(card);
    await patchMeta(card, {
      merge_train: { state: "bounced", repo: "state-vector/superpositional", pr: 2456 },
      pr: { repo: "state-vector/superpositional", n: 2456 },
    });

    // 1. takeover is refused while the (stale) hold owns the exit
    const tk = await api("/api/kb/transition", {
      method: "POST",
      body: JSON.stringify({ id: card, to: "in_progress", takeover: true, note: "human takeover attempt" }),
    });
    expect(tk.status).toBe(400);
    expect(String((await tk.json() as any).error)).toMatch(/takeover-held/);

    // 2. the owner override clears the stale bounce whose defect no longer matches live state
    const ch = await clearHold(card, { hold: "merge_train", action: "clear", reason: "PR #2456 merged as 566e5da4c — the bounce defect is stale" });
    expect(ch.status).toBe(200);

    // 3. the release the wedge made impossible
    const rc = await releaseClaim(card, { reason: "holder credential dead — release to the pool" });
    expect(rc.status).toBe(200);
    const { status, owner } = await statusOf(card);
    expect(status).toBe("todo");
    expect(owner).toBe("");
  });
});
