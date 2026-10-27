import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { graceActive, TOKEN_GRACE_MS } from "../src/kb/core.ts";

/**
 * BR#3787 rotation semantics on real miniflare SQLite — the tier that would
 * have caught the fleet 401 storm of 2026-10-27:
 *  - layer 0 (identity law): provisioning NEVER rotates another device's row
 *    (principal-only matching; label collisions mint suffixed rows / error);
 *  - layer 1 (grace): the previous hash keeps authenticating for the window,
 *    flagged stale — rotation is a re-vend signal, not an amputation;
 *  - layer 2 (negotiated self-heal): agent-plane repair by principal,
 *    rate-limited per row; unknown principal → named "re-pair required".
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

describe("BR#3787 layer 1 — grace window (pure boundary)", () => {
  it("graceActive: open within the window, closed at/past it, never on garbage", () => {
    const now = 1_000_000_000_000;
    expect(graceActive(now - 1000, now)).toBe(true);
    expect(graceActive(now - TOKEN_GRACE_MS + 1, now)).toBe(true);
    expect(graceActive(now - TOKEN_GRACE_MS, now)).toBe(false);
    expect(graceActive(now - TOKEN_GRACE_MS - 1000, now)).toBe(false);
    expect(graceActive(now + 1000, now)).toBe(false, "future rotated_ts is garbage, not eternal grace");
    expect(graceActive(null, now)).toBe(false);
    expect(graceActive(undefined, now)).toBe(false);
  });
});

describe("BR#3787 layer 0 — identity law (principal-only provisioning)", () => {
  it("self-provision onto ANOTHER device's label mints a suffixed row — never rotates theirs", async () => {
    const other = await kbJson("/admin.mint", { label: "shared-box", tags: ["gateway"], principal: "p_owner_aaaaaaaaaaaaaaaaaaaa" });
    expect(other.status).toBeLessThan(500);
    const ownerHashBefore = other.body.secret;
    const mine = await kbJson("/self.provision", {
      actor: "web:rayh",
      login: "rayh",
      principal: "p_mine_bbbbbbbbbbbbbbbbbbbbbbbb",
      host: "shared-box",
    });
    expect(mine.status).toBeLessThan(500);
    expect(mine.body.error).toBeUndefined();
    expect(mine.body.label).toBe("shared-box-2", "collision mints a suffixed row");
    // the owner's credential is UNTOUCHED — its hash did not rotate
    const ownerIdent = await kbJson("/auth.identify", { bearer: ownerHashBefore });
    expect(ownerIdent.status).toBeLessThan(500);
    expect(ownerIdent.body.error).toBeUndefined();
    expect(ownerIdent.body.token_epoch).toBe(1, "the other device's row never rotated");
  });

  it("human mint onto ANOTHER device's label is rejected with a named error", async () => {
    const { status, body } = await kbJson("/admin.mint", {
      label: "shared-box",
      tags: ["gateway"],
      principal: "p_mine_cccccccccccccccccccccccc",
    });
    expect(status).toBeLessThan(500);
    expect(body.error).toMatch(/another device's credential/);
  });

  it("legacy NULL-principal row is adoptable by label (migration path)", async () => {
    const legacy = await kbJson("/admin.mint", { label: "legacy-box", tags: ["gateway"] });
    expect(legacy.body.secret).toBeTruthy();
    const adopt = await kbJson("/self.provision", {
      actor: "web:rayh",
      login: "rayh",
      principal: "p_adopter_dddddddddddddddddddddd",
      host: "legacy-box",
    });
    expect(adopt.status).toBeLessThan(500);
    expect(adopt.body.error).toBeUndefined();
    expect(adopt.body.label).toBe("legacy-box", "legacy row adopted, not suffixed");
    expect(adopt.body.id).toBe(legacy.body.id);
    // the adoption ROTATED: old secret is stale-but-in-grace, new one is live
    const oldIdent = await kbJson("/auth.identify", { bearer: legacy.body.secret });
    expect(oldIdent.body.error).toBeUndefined();
    expect(oldIdent.body.token_stale).toBe(true);
    expect(oldIdent.body.token_epoch).toBe(2);
  });

  it("re-provision whose host slug ANOTHER row holds keeps the row's own label — never UNIQUE-fails (2026-10-27 dev-startup incident)", async () => {
    // another live device already holds the slug the device is about to report
    const holder = await kbJson("/admin.mint", { label: "contested", tags: ["gateway"], principal: "p_holder_11111111111111111111" });
    expect(holder.status).toBeLessThan(500);
    // our row was minted earlier under a different host label
    const first = await kbJson("/self.provision", {
      actor: "web:rayh", login: "rayh",
      principal: "p_rename_22222222222222222222",
      host: "renamed-box",
    });
    expect(first.body.secret).toBeTruthy();
    // the device now reports host "contested" (hostname rename, dev/prod
    // split, fleet suffix history). The old code re-stamped the row's label
    // to the requested slug and died on auth_tokens.label UNIQUE — the
    // desktop startup looped on "self-provision failed: UNIQUE constraint
    // failed: auth_tokens.label".
    const re = await kbJson("/self.provision", {
      actor: "web:rayh", login: "rayh",
      principal: "p_rename_22222222222222222222",
      host: "contested",
    });
    expect(re.status).toBeLessThan(500);
    expect(re.body.error).toBeUndefined();
    expect(re.body.secret).toBeTruthy();
    expect(re.body.epoch).toBe(2, "replace-by-principal rotated our row in place");
    expect(re.body.label).toBe("renamed-box", "the row keeps its stable label — the slug holder is untouched");
    // the holder's credential is UNTOUCHED
    const holderIdent = await kbJson("/auth.identify", { bearer: holder.body.secret });
    expect(holderIdent.body.error).toBeUndefined();
    expect(holderIdent.body.token_epoch).toBe(1);
  });
});

describe("BR#3787 layer 1 — rotation keeps the previous hash alive (stale)", () => {
  it("same principal re-provision rotates in place; old hash works flagged stale", async () => {
    const first = await kbJson("/self.provision", {
      actor: "web:rayh",
      login: "rayh",
      principal: "p_grace_eeeeeeeeeeeeeeeeeeeeeeee",
      host: "grace-box",
    });
    expect(first.body.secret).toBeTruthy();
    const second = await kbJson("/self.provision", {
      actor: "web:rayh",
      login: "rayh",
      principal: "p_grace_eeeeeeeeeeeeeeeeeeeeeeee",
      host: "grace-box",
    });
    expect(second.body.secret).toBeTruthy();
    expect(second.body.secret).not.toBe(first.body.secret);
    expect(second.body.epoch).toBe(2);
    const stale = await kbJson("/auth.identify", { bearer: first.body.secret });
    expect(stale.status).toBeLessThan(500);
    expect(stale.body.error).toBeUndefined();
    expect(stale.body.token_stale).toBe(true, "previous hash: in grace, flagged");
    const fresh = await kbJson("/auth.identify", { bearer: second.body.secret });
    expect(fresh.body.error).toBeUndefined();
    expect(fresh.body.token_stale).toBe(false);
    expect(fresh.body.token_epoch).toBe(2);
  });
});

describe("BR#3787 layer 2 — agent-plane repair by principal", () => {
  it("repairs the principal's OWN row: new secret, epoch bumps, old hash in grace", async () => {
    const prov = await kbJson("/self.provision", {
      actor: "web:rayh",
      login: "rayh",
      principal: "p_repair_ffffffffffffffffffffffff",
      host: "repair-box",
    });
    expect(prov.body.secret).toBeTruthy();
    const rep = await kbJson("/token.repair", { principal: "p_repair_ffffffffffffffffffffffff" });
    expect(rep.status).toBeLessThan(500);
    expect(rep.body.error).toBeUndefined();
    expect(rep.body.secret).toBeTruthy();
    expect(rep.body.secret).not.toBe(prov.body.secret);
    expect(rep.body.label).toBe("repair-box");
    expect(rep.body.epoch).toBe(2);
    const ident = await kbJson("/auth.identify", { bearer: rep.body.secret });
    expect(ident.body.error).toBeUndefined();
    expect(ident.body.token_epoch).toBe(2);
  });

  it("unknown principal → named 're-pair required' error (the runner's logout cue)", async () => {
    const { status, body } = await kbJson("/token.repair", { principal: "p_unknown_ggggggggggggggggggggggg" });
    expect(status).toBeLessThan(500);
    expect(body.error).toMatch(/re-pair required/);
  });

  it("rate-limited: past the per-row limit the repair refuses until the window passes", async () => {
    const principal = "p_ratelimit_hhhhhhhhhhhhhhhhhhhhhhh";
    const prov = await kbJson("/self.provision", { actor: "web:rayh", login: "rayh", principal, host: "rate-box" });
    expect(prov.body.secret).toBeTruthy();
    let lastGood = prov.body.secret as string;
    let last = { status: 0, body: {} as any };
    for (let i = 0; i <= 6; i++) {
      last = await kbJson("/token.repair", { principal });
      if (last.body.secret) lastGood = last.body.secret;
    }
    // 1 (provision) + 6 repairs in-window: the 7th repair must refuse
    expect(last.status).toBeLessThan(500);
    expect(last.body.error).toMatch(/rate limit/);
    // the last successful repair's secret is still the live credential
    const ident = await kbJson("/auth.identify", { bearer: lastGood });
    expect(ident.body.error).toBeUndefined();
  });

  it("repair requires the principal", async () => {
    const { status, body } = await kbJson("/token.repair", { principal: "" });
    expect(status).toBeLessThan(500);
    expect(body.error).toMatch(/requires the device principal/);
  });
});

describe("BR#3787 — pairing stores the device's host + principal (the forwarding bug)", () => {
  it("ws.pair.start records host and principal (was: everything became 'device'/null)", async () => {
    const start = await kbJson("/ws.pair.start", { host: "ip-172-31-1-230", type: "gateway", principal: "p_pair_jjjjjjjjjjjjjjjjjjjjjjjjj" });
    expect(start.body.code).toBeTruthy();
    const get = await kbJson("/ws.pair.get", { code: start.body.code });
    expect(get.body.device).toBe("ip-172-31-1-230", "the device's hostname survives to the approve screen");
  });
});
