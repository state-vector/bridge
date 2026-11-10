import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LIMITS, checkStorageBudget, utf8Bytes } from "../src/kb/core.ts";
import { TOOL_TABLE } from "../src/mcp-tools.ts";

/**
 * BR#11554 — the meta/row storage budget.
 *
 * The hub capped body chars (100k) and meta KEY count (20) but never meta
 * VALUE bytes, so additive on-card receipt chains (refire_archive +
 * per-duty receipt keys) grew artefact rows until they crossed the DO
 * SQLite write budget. First-hand on BR#10150 (2026-11-10): a 100,584B meta
 * made EVERY subsequent write fail `SQLITE_TOOBIG` — payload-independent,
 * atomically rolled back — because every row write re-binds the row's full
 * stored content. Even a shrinking write (38KB bound bytes) is rejected, so
 * the card is permanently agent-side write-locked; 27 receipts landed before
 * the lock, then receipts silently degraded to the commentary path.
 *
 * Three legs pinned here / in do.ts:
 * 1. PREVENT (core.ts): byte budgets with named, actionable errors — an
 *    oversized write is refused BEFORE the statement, naming the cure.
 * 2. TRANSLATE (do.ts dispatcher): a raw SQLITE_TOOBIG from any op becomes
 *    `gate: storage ceiling (BR#11554) …` with result_class gate_rejected,
 *    so recovery duties branch (terminal, BR#4403) instead of retrying an
 *    atomically-rolled-back write as if it were a transient infra fault.
 * 3. UNLOCK (do.ts artefact_slim): DELETE + re-INSERT with the caller's
 *    stubbed meta — the only physically possible cure for an already-locked
 *    row, because DELETE binds only the id and the re-INSERT binds the stub.
 */

describe("BR#11554 leg 1 — the byte budgets exist and are enforced with named errors", () => {
  it("LIMITS gains metaBytes and rowBytes with headroom under the ~100KB platform budget", () => {
    expect(LIMITS.metaBytes).toBe(40_000);
    expect(LIMITS.rowBytes).toBe(60_000);
    // the combined budget must stay well under the empirical ~98KB safe bound
    expect(LIMITS.rowBytes).toBeLessThan(90_000);
  });

  it("utf8Bytes counts bytes, not chars (multi-byte content under budgeted)", () => {
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes("é".repeat(30_000))).toBe(60_000);
  });

  it("an in-budget write passes", () => {
    expect(checkStorageBudget("t", "body", JSON.stringify({ a: 1 }), null, '["impl"]')).toBeNull();
  });

  it("meta over the byte cap is refused naming the cure (stub + pointer keys)", () => {
    const bigMeta = JSON.stringify({ receipt: "x".repeat(41_000) });
    const err = checkStorageBudget("t", "body", bigMeta, null, null);
    expect(err).toMatch(/storage budget: meta is/);
    expect(err).toMatch(/LIMITS\.metaBytes/);
    expect(err).toMatch(/BR#11554/);
    expect(err).toMatch(/meta_delete/);
  });

  it("the combined row over the row cap is refused even when meta alone fits", () => {
    const err = checkStorageBudget("t", "b".repeat(60_500), JSON.stringify({ a: 1 }), null, null);
    expect(err).toMatch(/storage budget: row is/);
    expect(err).toMatch(/LIMITS\.rowBytes/);
    expect(err).toMatch(/permanently write-locked/);
  });

  it("multi-byte receipts count their real bytes (a 20k-char CJK receipt is ~60k bytes)", () => {
    const err = checkStorageBudget("t", "body", JSON.stringify({ r: "汉".repeat(20_001) }), null, null);
    expect(err).toMatch(/storage budget/);
  });
});

describe("BR#11554 leg 2 — the dispatcher translates raw SQLITE_TOOBIG into the named terminal error", () => {
  const src = readFileSync(new URL("../src/kb/do.ts", import.meta.url).pathname, "utf8");

  it("the op dispatch catch detects SQLITE_TOOBIG / string or blob too big", () => {
    expect(src).toMatch(/SQLITE_TOOBIG\|string or blob too big/i);
  });

  it("the translation stamps result_class gate_rejected — semantic, terminal per BR#4403", () => {
    const catchIdx = src.indexOf('gate: storage ceiling (BR#11554)');
    expect(catchIdx).toBeGreaterThan(-1);
    const window = src.slice(catchIdx, catchIdx + 600);
    expect(window).toMatch(/result_class: "gate_rejected"/);
    expect(window).toMatch(/artefact_slim/); // the cure is named in the error
    expect(window).toMatch(/retries cannot succeed/);
  });
});

describe("BR#11554 leg 3 — artefact_slim is the unlock path for already-locked rows", () => {
  const src = readFileSync(new URL("../src/kb/do.ts", import.meta.url).pathname, "utf8");

  it("the op is dispatched as `slim` → artefactSlim", () => {
    expect(src).toMatch(/case "slim": return this\.json\(await this\.artefactSlim\(body, actor\)\)/);
  });

  it("slim is DELETE + re-INSERT inside atomicLaneMutation (small binds only — in-place writes cannot work)", () => {
    const fnIdx = src.indexOf("private async artefactSlim(");
    expect(fnIdx).toBeGreaterThan(-1);
    const body = src.slice(fnIdx, src.indexOf("/** Pure evidence for a qualification kind", fnIdx));
    expect(body).toMatch(/DELETE FROM artefacts WHERE id = \?/);
    expect(body).toMatch(/INSERT INTO artefacts \(/);
    // inside the transaction: the DELETE lands before the stub re-INSERT executes
    const txIdx = body.indexOf("this.atomicLaneMutation(() => {");
    const tx = body.slice(txIdx);
    expect(tx.indexOf("DELETE FROM artefacts WHERE id = ?")).toBeGreaterThan(-1);
    expect(tx.indexOf(".exec(insert")).toBeGreaterThan(tx.indexOf("DELETE FROM artefacts WHERE id = ?"));
  });

  it("slim is shrink-only and refuses to grow", () => {
    const body = src.slice(src.indexOf("private async artefactSlim("));
    expect(body).toMatch(/artefact_slim must shrink meta/);
  });

  it("slim requires a verbatim snapshot artefact (the ledger keeps names, never dropped values)", () => {
    const body = src.slice(src.indexOf("private async artefactSlim("));
    expect(body).toMatch(/ack_snapshot/);
    expect(body).toMatch(/requires ack_snapshot/);
  });

  it("slim auto-preserves hub infra keys (lane/lease/currently/stop/blocked) — the BR#5807 class", () => {
    const body = src.slice(src.indexOf("private async artefactSlim("));
    expect(body).toMatch(/\["lane", "lease", "currently", "stop", "blocked"\]/);
  });

  it("lane cards refuse slim (canonical persistence owns their meta)", () => {
    const body = src.slice(src.indexOf("private async artefactSlim("));
    expect(body).toMatch(/isCanonicalCard/);
  });

  it("slim stamps an on-card slim_record provenance key", () => {
    const body = src.slice(src.indexOf("private async artefactSlim("));
    expect(body).toMatch(/slim_record/);
  });

  it("the row budget is enforced inside slim too (the re-INSERT must not re-brick the card)", () => {
    const body = src.slice(src.indexOf("private async artefactSlim("));
    expect(body).toMatch(/checkStorageBudget/);
  });
});

describe("BR#11554 — the MCP surface declares artefact_slim", () => {
  it("the tool table dispatches artefact_slim to the `slim` op", async () => {
    const calls: Array<{ op: string; args: unknown }> = [];
    const ctx = {
      call: async (op: string, args: object) => { calls.push({ op, args }); return { id: "BR#1" }; },
      identity: { token_id: "at_x", label: "l", tags: [], principal: null },
      sessionName: "bridge-task-BR-11554",
    };
    await TOOL_TABLE.artefact_slim.handler({ id: "BR#1", ack_snapshot: "BR#11566" }, ctx as any);
    expect(calls[0].op).toBe("slim");
  });
});
