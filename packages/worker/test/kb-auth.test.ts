import { describe, expect, it } from "vitest";
import {
  composeBootstrap,
  generateAuthToken,
  hashAuthToken,
  isWsSlug,
  isValidAskTarget,
  isValidAuthTokenShape,
  tokenWorkspace,
  DEFAULT_BOARD,
  DEFAULT_WS_SLUG,
  doWs,
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

  it("embeds workspace slugs in agent tokens; legacy bare tokens = default ws", () => {
    const scoped = generateAuthToken("state-vector");
    expect(scoped).toMatch(/^bkw_state-vector_[0-9a-f]{48}$/);
    expect(isValidAuthTokenShape(scoped)).toBe(true);
    expect(tokenWorkspace(scoped)).toBe("state-vector");
    expect(tokenWorkspace(generateAuthToken())).toBeNull();
    // a ws-scoped secret must not parse as a bare one and vice versa
    expect(tokenWorkspace("bkw_state-vector_short")).toBeNull();
    expect(isWsSlug("state-vector")).toBe(true);
    expect(isWsSlug("State Vector")).toBe(false);
  });

  it("maps the default workspace to the legacy global DO id", () => {
    expect(DEFAULT_WS_SLUG).toBe("state-vector");
    expect(doWs("state-vector")).toBe("global");
    expect(doWs("rayh")).toBe("ws:rayh");
    expect(doWs("state-vector-2")).toBe("ws:state-vector-2");
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
