import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertHumanLabel, generatePrincipalId } from "../src/kb/core.ts";

/**
 * BR#4262 identity rendering law on real miniflare SQLite — the tier that
 * would have caught the 2026-10-28/29 incident (a raw bkw_ token rendered
 * into owner columns):
 *  - namespace separation: every label door (token.rename, ws.pair.approve,
 *    agent.provision, admin.mint) rejects bkw_/dev_-prefixed labels;
 *  - principal shape: hub-vended principals are dev_<48hex>, never
 *    bkw_-shaped; presented principals are kept (no migration);
 *  - render-time join: board / get / orient display the owning token's LABEL
 *    for principal-owned rows, the stored owner verbatim for legacy/system
 *    rows with no token row;
 *  - my-tasks matching still keys on the STORED owner (label glob +
 *    principal) — the display never leaks into matching.
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

async function boardJson(): Promise<any> {
  const r = await kb("/board");
  return r.json();
}

const TOKEN_LABEL = "bkw_9938c864d100eeb19bd31a0b40fbbcf71d7a722860713a82";
const PRINCIPAL_LABEL = "dev_abcdef0123456789abcdef0123456789abcdef0123456789";

describe("generatePrincipalId + assertHumanLabel (pure, core.ts)", () => {
  it("vends dev_ + 24 CSPRNG bytes hex — never bkw_-shaped, unique across draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const p = generatePrincipalId();
      expect(p).toMatch(/^dev_[0-9a-f]{48}$/);
      expect(p.startsWith("bkw_")).toBe(false);
      seen.add(p);
    }
    expect(seen.size).toBe(50);
  });

  it("guard rejects credential/principal-shaped labels; human labels pass", () => {
    expect(() => assertHumanLabel(TOKEN_LABEL)).toThrow(/reserved namespaces/);
    expect(() => assertHumanLabel(PRINCIPAL_LABEL)).toThrow(/reserved namespaces/);
    expect(() => assertHumanLabel("macbook-pro-local-2")).not.toThrow();
    expect(() => assertHumanLabel("gateway/worker-1")).not.toThrow();
    // prefix-exact: plausible human names that merely CONTAIN the shapes stay legal
    expect(() => assertHumanLabel("dev-team")).not.toThrow();
    expect(() => assertHumanLabel("bkwsocks")).not.toThrow();
  });
});

describe("label guard at the four doors (real DO)", () => {
  it("door 1 — admin.mint (tokenMint) rejects token-shaped labels", async () => {
    for (const label of [TOKEN_LABEL, PRINCIPAL_LABEL]) {
      const { status, body } = await kbJson("/admin.mint", { label, tags: [] });
      expect(status).toBeLessThan(500);
      expect(body.error).toMatch(/reserved namespaces/);
      expect(body.secret).toBeUndefined();
    }
    // charset still enforced first, guard second — a guard pass mints normally
    const ok = await kbJson("/admin.mint", { label: "guard-mint-ok", tags: [] });
    expect(ok.body.error).toBeUndefined();
    expect(ok.body.secret).toBeTruthy();
  });

  it("door 2 — token.rename rejects token-shaped labels; a human label still renames", async () => {
    const t = await kbJson("/admin.mint", { label: "guard-rename-dev", tags: [] });
    expect(t.body.secret).toBeTruthy();
    for (const label of [TOKEN_LABEL, PRINCIPAL_LABEL]) {
      // the rename door sits before the POST op-switch (no op-level catch),
      // so it answers TYPED 400 with the message itself (BR#4212 boundary:
      // a guard rejection must never render as the generic infra 503) —
      // same assertion shape as the sibling doors
      const { status, body } = await kbJson("/token.rename", { bearer: t.body.secret, label });
      expect(status).toBeLessThan(500);
      expect(body.error).toMatch(/reserved namespaces/);
    }
    const ok = await kbJson("/token.rename", { bearer: t.body.secret, label: "guard-rename-dev-2" });
    expect(ok.body.error).toBeUndefined();
    expect(ok.body.to).toBe("guard-rename-dev-2");
  });

  it("door 3 — agent.provision rejects token-shaped labels", async () => {
    const gw = await kbJson("/admin.mint", { label: "guard-gw", tags: ["gateway"] });
    expect(gw.body.secret).toBeTruthy();
    for (const label of [TOKEN_LABEL, PRINCIPAL_LABEL]) {
      const { status, body } = await kbJson("/agent.provision", { provisioned_by: "guard-gw", label });
      expect(status).toBeLessThan(500);
      expect(body.error).toMatch(/reserved namespaces/);
      expect(body.secret).toBeUndefined();
    }
    const ok = await kbJson("/agent.provision", { provisioned_by: "guard-gw", label: "guard-gw/worker-1" });
    expect(ok.body.error).toBeUndefined();
    expect(ok.body.secret).toBeTruthy();
  });

  it("door 4 — ws.pair.approve rejects token-shaped labels", async () => {
    await kbJson("/ws.seed", { logins: ["ray"] });
    const start = await kbJson("/ws.pair.start", { host: "guard-pair-box", type: "agent" });
    expect(start.body.code).toBeTruthy();
    const wsList = await kbJson("/ws.list", { login: "ray" });
    const ws = wsList.body.workspaces[0].slug;
    const { status, body } = await kbJson("/ws.pair.approve", {
      code: start.body.code, ws, login: "ray", label: TOKEN_LABEL,
    });
    expect(status).toBeLessThan(500);
    expect(body.error).toMatch(/reserved namespaces/);
    // the pairing was NOT authorized under the stolen name — a clean approve works
    const start2 = await kbJson("/ws.pair.start", { host: "guard-pair-box", type: "agent" });
    const ok = await kbJson("/ws.pair.approve", { code: start2.body.code, ws, login: "ray", label: "guard-pair-ok" });
    expect(ok.body.error).toBeUndefined();
    expect(ok.body.ok).toBe(true);
  });
});

describe("principal vend shape (real DO)", () => {
  it("first self-provision vends a dev_-shaped principal", async () => {
    const v = await kbJson("/self.provision", { actor: "web:rayh", login: "rayh", host: "vend-shape-box" });
    expect(v.status).toBeLessThan(500);
    expect(v.body.error).toBeUndefined();
    expect(v.body.principal).toMatch(/^dev_[0-9a-f]{48}$/);
  });

  it("a presented principal is kept verbatim — no migration of existing anchors", async () => {
    const v = await kbJson("/self.provision", {
      actor: "web:rayh", login: "rayh",
      principal: "p_keep_me_0000000000000000000000",
      host: "vend-keep-box",
    });
    expect(v.body.error).toBeUndefined();
    expect(v.body.principal).toBe("p_keep_me_0000000000000000000000");
  });
});

describe("render-time join (real DO)", () => {
  it("board + get render the LABEL for a principal-owned row; legacy/system rows render verbatim", async () => {
    // hand-set (legacy-shape) principal on a real row: the join is shape-agnostic
    const dev = await kbJson("/admin.mint", { label: "render-host", tags: [], principal: "p_render_test_00000000000000000" });
    expect(dev.body.id).toBeTruthy();
    const t = await kbJson("/create", { type: "task", title: "render join — principal row", actor: "test" });
    expect(t.body.error).toBeUndefined();
    const claim = await kbJson("/transition", { id: t.body.id, to: "in_progress", actor: "render-host", token_id: dev.body.id });
    expect(claim.body.error).toBeUndefined();

    // owner AT REST is the principal — matching reads prove it (orient by principal)
    const o = await kbJson("/orient", { label: "render-host", principal: "p_render_test_00000000000000000", tags: [] });
    const mine = (o.body.my_tasks ?? []).filter((x: any) => x.id === t.body.id);
    expect(mine.length).toBe(1);

    // ...while every DISPLAY surface renders the label, never the anchor
    const board = await boardJson();
    const brow = board.tasks.find((x: any) => x.id === t.body.id);
    expect(brow.owner).toBe("render-host");
    expect(brow.owner).not.toMatch(/^p_/);
    const got = await kbJson("/get", { id: t.body.id });
    expect(got.body.owner).toBe("render-host");
    const openRow = (o.body.open_artefacts ?? []).find((x: any) => x.id === t.body.id);
    expect(openRow.owner).toBe("render-host");

    // legacy label owner with NO token row renders verbatim (hand-minted row)
    const t2 = await kbJson("/create", { type: "task", title: "render join — legacy verbatim", actor: "test" });
    await kbJson("/transition", { id: t2.body.id, to: "in_progress", actor: "legacy-hand-label" });
    const board2 = await boardJson();
    expect(board2.tasks.find((x: any) => x.id === t2.body.id).owner).toBe("legacy-hand-label");
    // and get() renders it verbatim too — the same no-token-row branch a
    // `system:*` owner takes (todo cards are unowned by design: ensureSchema
    // sweeps owner off todo rows, so a persisted system:* owner exercises the
    // identical fallback path through displayOwner/OWNER_DISPLAY_SQL)
    const got2 = await kbJson("/get", { id: t2.body.id });
    expect(got2.body.owner).toBe("legacy-hand-label");
  });

  it("my-tasks matching is unaffected by the display change (stored owner still keys)", async () => {
    // principal arm: a worker token provisioned with its own principal —
    // owner at rest is that principal; orienting by it must still match, and
    // the payload renders the worker's label
    const agent = await kbJson("/agent.provision", { provisioned_by: "guard-gw", label: "guard-gw/worker-9", principal: "p_worker9_000000000000000000000" });
    expect(agent.body.error).toBeUndefined();
    const t = await kbJson("/create", { type: "task", title: "render join — principal match", actor: "test" });
    await kbJson("/transition", { id: t.body.id, to: "in_progress", actor: "guard-gw/worker-9", token_id: agent.body.id });
    const o = await kbJson("/orient", { label: "guard-gw/worker-9", principal: "p_worker9_000000000000000000000", tags: [] });
    const mine = (o.body.my_tasks ?? []).filter((x: any) => x.id === t.body.id);
    expect(mine.length).toBe(1);
    expect(mine[0].owner).toBe("guard-gw/worker-9");
    expect((o.body.open_artefacts ?? []).find((x: any) => x.id === t.body.id).owner).toBe("guard-gw/worker-9");

    // label-glob arm: a label-owned row (hand-claimed, no principal) still
    // reaches the provisioning gateway via the <gateway>/ prefix glob
    const t2 = await kbJson("/create", { type: "task", title: "render join — glob match", actor: "test" });
    await kbJson("/transition", { id: t2.body.id, to: "in_progress", actor: "guard-gw/worker-7" });
    const o2 = await kbJson("/orient", { label: "guard-gw", principal: null, tags: ["gateway"] });
    const mine2 = (o2.body.my_tasks ?? []).filter((x: any) => x.id === t2.body.id);
    expect(mine2.length).toBe(1);
    expect(mine2[0].owner).toBe("guard-gw/worker-7");
  });
});
