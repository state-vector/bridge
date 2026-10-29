import { describe, expect, it } from "vitest";
import {
  composeBootstrap,
  generateAuthToken,
  hashAuthToken,
  isWsSlug,
  isValidAskTarget,
  isValidAuthTokenShape,
  tagsSayGateway,
  selfProvisionLabel,
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

describe("identity namespace law (BR#2455, revised: class is a trait)", () => {
  it("labels are free-form — the gateway TAG is the class, never the name", () => {
    // a gateway named after its host and an agent with any label are legal;
    // there is no reserved namespace, so nothing can be asserted on labels
    expect(tagsSayGateway(["gateway"])).toBe(true);
    expect(tagsSayGateway(["role:impl", "gateway"])).toBe(true);
    expect(tagsSayGateway(["role:impl"])).toBe(false);
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

describe("self-provision label law (desktop gateway leg, credential-class ADR)", () => {
  it("deterministic per device: same host, same label forever", () => {
    const a = selfProvisionLabel("uuid-1234ABCD-5678");
    const b = selfProvisionLabel("uuid-1234ABCD-5678");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-z0-9-]+$/);
    expect(a).not.toMatch(/^gw-/); // NO class prefix — gateway is a tag (Ray, 2026-10-23)
    expect(selfProvisionLabel("uuid-1234ABCD-5678".toUpperCase())).toBe(a); // case-stable
  });

  it("slug-safe under the mint label rules; never empty, never reserved", () => {
    // non-alphanumerics collapse to single dashes; result always valid
    expect(selfProvisionLabel("MacBook Pro (local)")).toMatch(/^[a-z0-9-]{2,40}$/);
    expect(selfProvisionLabel("MacBook Pro (local)")).toBe("macbook-pro-local");
    expect(selfProvisionLabel("!!!")).toBe("device"); // undashable → fallback
    expect(selfProvisionLabel("")).toBe("device");
    expect(selfProvisionLabel(null)).toBe("device");
    expect(selfProvisionLabel(42)).toBe("device");
    // never a reserved _ root, always mint-legal shape
    const long = selfProvisionLabel("x".repeat(100));
    expect(long.length).toBeLessThanOrEqual(30); // 30-slug cap
    expect(/^[a-zA-Z0-9._/-]{2,40}$/.test(long)).toBe(true);
    expect(long.startsWith("_")).toBe(false);
  });

  it("self-provisioned tokens are gateway-class by TAG (the trait, not the name)", () => {
    // the op mints tags ["gateway"] — exactly what the class gate reads
    expect(tagsSayGateway(["gateway"])).toBe(true);
    expect(selfProvisionLabel("host-mybox")).toBe("host-mybox"); // bare hostname slug (BR#899 identity convention)
  });
});

describe("bootstrap composition", () => {
  it("teaches discovery only when board is none", () => {
    const b = composeBootstrap("My Project", DEFAULT_BOARD);
    expect(b).toContain("orient");
    expect(b).toContain("My Project");
    expect(b).not.toContain("external board");
  });

  it("rule 4b + PROTOCOL CARD carry the verdict-duty carve-out — the protocol never steers a verify/unblock duty into blocked (BR#4392)", () => {
    const b = composeBootstrap("My Project", DEFAULT_BOARD);
    expect(b).toContain("can NEVER take the blocked leg");
    expect(b).toContain("they cannot block");
    expect(b).toContain('"cannot proceed" is itself the verdict');
  });

  it("appends the user board prompt when board is external", () => {
    const b = composeBootstrap("P", { mode: "external", kind: "github-projects", url: "https://x/p/1", prompt: "Move tasks to In Progress." });
    expect(b).toContain("github-projects");
    expect(b).toContain("https://x/p/1");
    expect(b).toContain("Move tasks to In Progress.");
  });
});
