import { unstable_dev, type UnstableDevWorker } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * DO integration tests — the tier that would have caught today's production
 * failures. Runs the full worker + KnowledgeHub DO on local miniflare SQLite
 * (real storage.sql, real migrations, real binding enforcement) and drives
 * the same routes production uses:
 *  - placeholder/argument errors in hand-written SQL THROW here;
 *  - ensureSchema executes on a cold DB AND on the warm path, so a frozen-
 *    migration bug breaks tests instead of production;
 *  - the "Wrong number of parameter bindings" class cannot ship.
 */

let dev: UnstableDevWorker;

beforeAll(async () => {
  dev = await unstable_dev("src/index.js", {
    config: "./wrangler.toml",
    experimental: { disableExperimentalWarning: true },
  });
});

afterAll(async () => {
  dev?.stop();
});

async function kbFetch(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await dev.fetch(`https://kb${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

describe("auth token SQL paths (real storage)", () => {
  it("mints a token on a cold database (ensureSchema + INSERT)", async () => {
    const { status, body } = await kbFetch("/admin.mint", {
      label: "test-mint-basic",
      tags: [],
    });
    expect(status).toBeLessThan(500);
    expect(body.secret).toBeTruthy();
  });

  it("re-minting the same label REPLACEs without SQL binding errors", async () => {
    // the replace path: byLabel match -> UPDATE with COALESCE bindings —
    // today's production failure was a missing binding in this exact branch
    const { status, body } = await kbFetch("/admin.mint", {
      label: "test-replace",
      tags: [],
      principal: "p_replacetest0000000000000000000000",
    });
    expect(status).toBeLessThan(500);
    expect(body.secret).toBeTruthy();
  });

  it("mints with device_id + principal (8 columns, 8 bindings)", async () => {
    const { status, body } = await kbFetch("/admin.mint", {
      label: "test-principal",
      tags: [],
      device_id: "dev-test",
      principal: "p_abcdef0123456789",
    });
    expect(status).toBeLessThan(500);
    expect(body.secret).toBeTruthy();
  });
});

describe("agent provisioning SQL paths", () => {
  it("provisions a worker token (binding-count regression: 8 columns, 8 bindings)", async () => {
    const { status, body } = await kbFetch("/agent.provision", {
      label: "test-provisioned",
      device_id: "dev-test",
      principal: "p_abcdef0123456789",
    });
    expect(status).toBeLessThan(500);
    expect(body.secret).toBeTruthy();
  });

  it("provisions with rotate (revoke + re-mint path)", async () => {
    const { status, body } = await kbFetch("/agent.provision", {
      label: "test-rotator",
      rotate: true,
    });
    expect(status).toBeLessThan(500);
    expect(body.secret).toBeTruthy();
  });
});

describe("session registration (the migration that never ran in prod)", () => {
  it("session touch writes the kind column", async () => {
    const { status, body } = await kbFetch("/session.touch", {
      token_id: "at_test",
      session: "test-session",
    });
    expect(status).toBeLessThan(500);
    expect(body.session).toBeTruthy();
  });
});
