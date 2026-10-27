import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Workspace membership integration tests — invite/remove by GitHub username
 * through the same internal path production's wsCall uses (registry ops on
 * the default KB DO, no admin header — caller identity rides body.login):
 *  - any member can invite or remove (everyone holds the same rights);
 *  - non-members can do neither;
 *  - the workspace creator cannot be removed, not even by themselves;
 *  - invitees are normalized to lowercase and format-checked.
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

async function wsJson(op: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await kb(`/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const WS = "wsinv-test";

describe("workspace membership (invite/remove by github username)", () => {
  it("create: the creator becomes owner + first member", async () => {
    const { status, body } = await wsJson("ws.create", { slug: WS, login: "alice" });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const members = await wsJson("ws.members", { ws: WS, login: "alice" });
    expect(members.body.members).toEqual(["alice"]);
    expect(members.body.owner).toBe("alice");
  });

  it("invite: a NON-member cannot add members", async () => {
    const { status, body } = await wsJson("ws.join", { ws: WS, login: "mallory", member: "bob" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/only workspace members can add members/);
  });

  it("invite: a member adds a member — normalized to lowercase", async () => {
    const { status, body } = await wsJson("ws.join", { ws: WS, login: "alice", member: "Bob" });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.login).toBe("bob");
    const members = await wsJson("ws.members", { ws: WS, login: "alice" });
    expect(members.body.members.sort()).toEqual(["alice", "bob"]);
  });

  it("invite: bad github login is rejected", async () => {
    const { status, body } = await wsJson("ws.join", { ws: WS, login: "alice", member: "has_underscore" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/bad github login/);
  });

  it("remove: the creator cannot be removed — by another member or by themselves", async () => {
    const byOther = await wsJson("ws.remove", { ws: WS, login: "bob", member: "alice" });
    expect(byOther.status).toBe(400);
    expect(byOther.body.error).toMatch(/creator cannot be removed/);
    const bySelf = await wsJson("ws.remove", { ws: WS, login: "alice", member: "alice" });
    expect(bySelf.status).toBe(400);
    expect(bySelf.body.error).toMatch(/creator cannot be removed/);
  });

  it("remove: a NON-member cannot remove members", async () => {
    const { status, body } = await wsJson("ws.remove", { ws: WS, login: "mallory", member: "bob" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/only workspace members can remove members/);
  });

  it("remove: any member can remove any other member", async () => {
    const { status, body } = await wsJson("ws.remove", { ws: WS, login: "alice", member: "bob" });
    expect(status).toBe(200);
    expect(body.removed).toBe(true);
    const members = await wsJson("ws.members", { ws: WS, login: "alice" });
    expect(members.body.members).toEqual(["alice"]);
  });

  it("the removed member no longer sees the workspace as theirs", async () => {
    const { body } = await wsJson("ws.list", { login: "bob" });
    const ws = body.workspaces.find((w: any) => w.slug === WS);
    expect(ws).toBeTruthy();
    expect(ws.member).toBe(false);
  });
});
