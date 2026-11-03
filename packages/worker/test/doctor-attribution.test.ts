import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Executor-attribution law (2026-11-03 "doctor" incident):
 *
 * `bridge doctor` probed token validity by orienting with a hardcoded
 * session "doctor" — orient registers the session on the gateway token's
 * registry — and the hub's last-session fallback then resolved that throwaway
 * probe session as the EXECUTOR of live impl cards (first-wins froze the
 * mislabel for the card's whole life).
 *
 * The laws under test:
 *  1. a session-less write from a GATEWAY-tagged token stays anonymous — the
 *     token's last-session fallback never forges executor attribution for
 *     infrastructure;
 *  2. an explicit session on a gateway token is still honored (train lease,
 *     canary, alarm all pass one);
 *  3. the agent-token fallback is untouched (agents may still omit session
 *     after orient);
 *  4. a FRESH claim (todo → in_progress) RE-stamps the executor session, so
 *     a released claim never inherits the previous holder's label — poisoned
 *     cards self-heal on their next claim cycle.
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

async function mintToken(label: string, tags: string[]): Promise<string> {
  const { status, body } = await kbJson("/admin.mint", { label, tags });
  expect(status).toBeLessThan(500);
  expect(body.error).toBeUndefined();
  expect(body.id).toBeTruthy();
  return body.id as string;
}

async function createTask(tokenId: string, title: string): Promise<string> {
  const { body } = await kbJson("/create", {
    type: "task",
    title,
    body_md: "attribution-law regression fixture",
    actor: "test",
    token_id: tokenId,
  });
  expect(body.error).toBeUndefined();
  return body.id as string;
}

async function metaOf(id: string): Promise<any> {
  const { body } = await kbJson("/get", { id });
  expect(body.error).toBeUndefined();
  return typeof body.meta === "string" ? JSON.parse(body.meta) : (body.meta ?? {});
}

describe("executor attribution (doctor-probe incident laws)", () => {
  it("a session-less gateway write stays anonymous even with a probe session registered", async () => {
    const gw = await mintToken("attr-gateway", ["gateway"]);
    await kbJson("/session.touch", { token_id: gw, session: "doctor" });
    const id = await createTask(gw, "attr: gateway session-less claim stays anonymous");
    const { body } = await kbJson("/transition", { id, to: "in_progress", actor: "test", token_id: gw });
    expect(body.error).toBeUndefined();
    const meta = await metaOf(id);
    expect(meta.session).toBeUndefined();
  });

  it("an explicit session on a gateway token is still honored", async () => {
    const gw = await mintToken("attr-gateway-2", ["gateway"]);
    await kbJson("/session.touch", { token_id: gw, session: "doctor" });
    const id = await createTask(gw, "attr: gateway explicit session honored");
    const { body } = await kbJson("/transition", {
      id, to: "in_progress", actor: "test", token_id: gw, session: "bridge-task-attr",
    });
    expect(body.error).toBeUndefined();
    const meta = await metaOf(id);
    expect(meta.session).toBe("bridge-task-attr");
  });

  it("the agent-token last-session fallback still attributes after orient", async () => {
    const agent = await mintToken("attr-agent", []);
    await kbJson("/session.touch", { token_id: agent, session: "legacy-agent" });
    const id = await createTask(agent, "attr: agent-token fallback intact");
    const { body } = await kbJson("/transition", { id, to: "in_progress", actor: "test", token_id: agent });
    expect(body.error).toBeUndefined();
    const meta = await metaOf(id);
    expect(meta.session).toBe("legacy-agent");
  });

  it("a fresh claim re-stamps the executor session (poisoned labels self-heal)", async () => {
    const agent = await mintToken("attr-agent-2", []);
    await kbJson("/session.touch", { token_id: agent, session: "old-holder" });
    const id = await createTask(agent, "attr: fresh claim re-stamps executor");
    await kbJson("/transition", { id, to: "in_progress", actor: "test", token_id: agent });
    expect((await metaOf(id)).session).toBe("old-holder");
    await kbJson("/transition", { id, to: "todo", actor: "test", token_id: agent });
    const { body } = await kbJson("/transition", {
      id, to: "in_progress", actor: "test", token_id: agent, session: "new-executor",
    });
    expect(body.error).toBeUndefined();
    expect((await metaOf(id)).session).toBe("new-executor");
  });
});
