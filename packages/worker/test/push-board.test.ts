import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * BR#4362 push-driven board — the tier that would have caught the
 * 2026-10-29 DO overload (every client refetching the FULL board per event;
 * 11 board GETs/sec saturated the single SQLite DO):
 *  - WS accept hydrates: kb.events replay + a kb.board snapshot frame;
 *  - a mutation burst coalesces to ≤1 board push/second no matter the rate;
 *  - the HTTP board path is served from a short cache (pull stragglers).
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

async function stats(): Promise<any> {
  return (await kbJson("/stats", {})).body;
}

async function openWs(): Promise<{ frames: any[]; close: () => void }> {
  const r = await kb("/ws?since=0", { headers: { Upgrade: "websocket" } } as any);
  expect(r.status).toBe(101);
  const ws = (r as any).webSocket as WebSocket;
  const frames: any[] = [];
  (ws as any).addEventListener?.("message", (e: any) => {
    try { frames.push(JSON.parse(String(e.data))); } catch { /* ignore */ }
  });
  (ws as any).onmessage = (e: any) => {
    try { frames.push(JSON.parse(String(e.data))); } catch { /* ignore */ }
  };
  (ws as any).accept?.(); // workers-style client end: accept before frames flush
  // liveness probe: the server answers {"type":"ping"} with pong
  (ws as any).send?.(JSON.stringify({ type: "ping" }));
  await wait(150);
  return { frames, close: () => { try { ws.close(); } catch { /* already gone */ } } };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("BR#4362 push-driven board", () => {
  it("WS accept hydrates: events replay + a kb.board snapshot frame", async () => {
    const { frames, close } = await openWs();
    await wait(300);
    close();
    expect(frames.some((f) => f.type === "pong")).toBe(true); // channel is live
    expect(frames.some((f) => f.type === "kb.events")).toBe(true);
    const snap = frames.find((f) => f.type === "kb.board");
    expect(snap).toBeTruthy();
    expect(Array.isArray(snap.board.tasks)).toBe(true);
  });

  it("a mutation burst coalesces: 12 rapid mutations ⇒ ≤2 board pushes", async () => {
    const t = await kbJson("/create", { type: "task", title: "pushboard storm drill" });
    expect(t.body.id).toBeTruthy();
    await kbJson("/transition", { id: t.body.id, to: "in_progress", note: "claim" });
    const { frames, close } = await openWs();
    await wait(200);
    frames.length = 0;
    for (let i = 0; i < 12; i++) {
      await kbJson("/progress.log", { id: t.body.id, note: `burst ${i}`, did: `burst ${i}` });
    }
    await wait(1500);
    const pushes = frames.filter((f) => f.type === "kb.board").length;
    const events = frames.filter((f) => f.type === "kb.event").length;
    close();
    expect(events).toBeGreaterThanOrEqual(12); // events still stream per-mutation
    expect(pushes).toBeLessThanOrEqual(2); // state snapshots coalesce to ~1/s
  });

  it("HTTP board is cached: 3 rapid GETs ⇒ ≤1 fresh build", async () => {
    const before = (await stats()).channel?.board?.builds ?? 0;
    for (let i = 0; i < 3; i++) {
      const r = await kb("/board");
      expect(r.status).toBe(200);
    }
    const after = (await stats()).channel?.board?.builds ?? 0;
    expect(after - before).toBeLessThanOrEqual(1);
  });
});
