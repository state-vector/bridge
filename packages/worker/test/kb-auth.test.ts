import { describe, expect, it } from "vitest";
import {
  composeBootstrap,
  generateAuthToken,
  hashAuthToken,
  isValidAskTarget,
  isValidAuthTokenShape,
  DEFAULT_BOARD,
} from "../src/kb/core.ts";

describe("auth tokens", () => {
  it("generates bkw_-shaped secrets with matching hashes", async () => {
    const a = generateAuthToken();
    expect(isValidAuthTokenShape(a)).toBe(true);
    expect(a).not.toBe(generateAuthToken());
    const h = await hashAuthToken(a);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashAuthToken(a)).toBe(h);
    expect(isValidAuthTokenShape("bkw_short")).toBe(false);
  });
});

describe("ask targets", () => {
  it("accepts any, labels, label@session, tag:capability", () => {
    expect(isValidAskTarget("any")).toBe(true);
    expect(isValidAskTarget("opencode-ray")).toBe(true);
    expect(isValidAskTarget("opencode-ray@fix-auth-2")).toBe(true);
    expect(isValidAskTarget("tag:datadog-access")).toBe(true);
    expect(isValidAskTarget("has spaces")).toBe(false);
    expect(isValidAskTarget("tag:BAD TAG")).toBe(false);
    expect(isValidAskTarget("")).toBe(false);
  });
});

describe("bootstrap composition", () => {
  it("teaches discovery only when board is none", () => {
    const b = composeBootstrap("My Project", DEFAULT_BOARD);
    expect(b).toContain("orient");
    expect(b).toContain("My Project");
    expect(b).not.toContain("external board");
  });

  it("appends the user board prompt when board is external", () => {
    const b = composeBootstrap("P", { mode: "external", kind: "github-projects", url: "https://x/p/1", prompt: "Move tasks to In Progress." });
    expect(b).toContain("github-projects");
    expect(b).toContain("https://x/p/1");
    expect(b).toContain("Move tasks to In Progress.");
  });
});
