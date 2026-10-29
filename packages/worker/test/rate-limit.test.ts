import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * BR#4397 pull-surface rate limits — a brake against pollers (the 2026-10-29
 * overload class), never against push clients:
 *  - GET /board 30/min per identity (x-kb-rate-key) ⇒ 429 + Retry-After,
 *    body names the push channel;
 *  - GET /events 120/min;
 *  - no key header (agent/admin plane) ⇒ unlimited;
 *  - distinct identities don't share a bucket;
 *  - the WS push plane is unaffected by pull exhaustion.
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("BR#4397 pull-surface rate limits", () => {
  it("GET /board: 35 rapid pulls under one identity ⇒ 429s naming the push channel", async () => {
    let limited = 0;
    let retryAfter = 0;
    let body = "";
    for (let i = 0; i < 35; i++) {
      const r = await kb("/board", { headers: { "x-kb-rate-key": "web:poller" } });
      if (r.status === 429) {
        limited++;
        retryAfter = Number(r.headers.get("retry-after") ?? 0);
        if (!body) body = await r.text();
      }
    }
    expect(limited).toBeGreaterThanOrEqual(5); // 30/min window ⇒ ≥5 of 35 refused
    expect(retryAfter).toBeGreaterThan(0);
    expect(body).toContain("/kb-ws");
  });

  it("no rate-key header (agent/admin plane) ⇒ unlimited", async () => {
    for (let i = 0; i < 40; i++) {
      const r = await kb("/board");
      expect(r.status).toBe(200);
    }
  });

  it("distinct identities don't share a bucket", async () => {
    for (const key of ["web:a", "web:b", "web:c"]) {
      for (let i = 0; i < 20; i++) {
        const r = await kb("/board", { headers: { "x-kb-rate-key": key } });
        expect(r.status).toBe(200); // 20 each < 30/min — none refused
      }
    }
  });

  it("WS push plane unaffected by pull exhaustion", async () => {
    for (let i = 0; i < 35; i++) await kb("/events", { headers: { "x-kb-rate-key": "web:poller2" } });
    const r = await kb("/ws?since=0", { headers: { Upgrade: "websocket" } } as any);
    expect(r.status).toBe(101);
    const ws = (r as any).webSocket as WebSocket;
    const frames: any[] = [];
    (ws as any).addEventListener?.("message", (e: any) => {
      try { frames.push(JSON.parse(String(e.data))); } catch { /* ignore */ }
    });
    (ws as any).accept?.();
    await wait(300);
    try { ws.close(); } catch { /* already gone */ }
    expect(frames.some((f) => f.type === "kb.board")).toBe(true);
  });
});
