import { describe, expect, it } from "vitest";
import {
  composeBootstrap,
  generateAuthToken,
  hashAuthToken,
  isGatewayLabel,
  isWsSlug,
  isValidAskTarget,
  isValidAuthTokenShape,
  labelClassError,
  tagsSayGateway,
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

  it("tokens are opaque (no workspace leak); legacy embedded-slug tokens still parse", () => {
    const t = generateAuthToken();
    expect(t).toMatch(/^bkw_[0-9a-f]{48}$/);
    expect(isValidAuthTokenShape(t)).toBe(true);
    expect(tokenWorkspace(t)).toBeNull();
    // legacy compat: pre-registry tokens with an embedded slug still route
    const legacy = generateAuthToken("state-vector");
    expect(legacy).toMatch(/^bkw_state-vector_[0-9a-f]{48}$/);
    expect(tokenWorkspace(legacy)).toBe("state-vector");
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

describe("identity namespace law (BR#2455)", () => {
  it("gateway labels are gw-* (lowercase, hyphenated), nothing else", () => {
    expect(isGatewayLabel("gw-macbookpro")).toBe(true);
    expect(isGatewayLabel("gw-1")).toBe(true);
    expect(isGatewayLabel(`gw-${"a".repeat(38)}`)).toBe(true);
    expect(isGatewayLabel("macbookpro")).toBe(false);
    expect(isGatewayLabel("opencode-ray")).toBe(false);
    expect(isGatewayLabel("gw-")).toBe(false); // empty name
    expect(isGatewayLabel("gw-MacBookPro")).toBe(false); // lowercase only
    expect(isGatewayLabel("gw-mac_book")).toBe(false); // no underscores
    expect(isGatewayLabel("gw-mac.book")).toBe(false); // no dots
    expect(isGatewayLabel(`gw-${"a".repeat(39)}`)).toBe(false); // 43 chars > 40 cap
    expect(isGatewayLabel("gwx")).toBe(false);
    expect(isGatewayLabel("")).toBe(false);
    expect(isGatewayLabel(null)).toBe(false);
  });

  it("gateway-tagged tokens MUST be gw-*, agent labels MUST NOT be", () => {
    expect(labelClassError("gw-macbookpro", true)).toBeNull();
    expect(labelClassError("opencode-ray", false)).toBeNull();
    expect(labelClassError("macbookpro", true)).toMatch(/gw-/); // the live defect: hostname-named gateway
    expect(labelClassError("gw-x", false)).toMatch(/reserved/); // agent stealing the gateway prefix
    expect(labelClassError("GW-Big", true)).toMatch(/gw-/);
  });

  it("gateway classification is case-insensitive on the tag, shape-tolerant like parseTags", () => {
    expect(tagsSayGateway(["gateway"])).toBe(true);
    expect(tagsSayGateway(["Gateway"])).toBe(true);
    expect(tagsSayGateway(["role:impl", "gateway"])).toBe(true);
    expect(tagsSayGateway(["role:impl"])).toBe(false);
    expect(tagsSayGateway([])).toBe(false);
    expect(tagsSayGateway(null)).toBe(false);
    // JSON-encoded legacy rows parse like everywhere else
    expect(tagsSayGateway(JSON.stringify(["gateway"]))).toBe(true);
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
