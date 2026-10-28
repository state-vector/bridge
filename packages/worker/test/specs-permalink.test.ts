/**
 * BR#3990 — behavioural contract of the @bridge/specs permalink dependency,
 * pinned from the consumer side: these tests import ONLY the dependency's
 * public surface (no worker modules), so a grammar or parse-contract drift
 * in @bridge/specs fails here before it can reach the hub's payload stamping
 * or the webapp's deep-link routes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cardIdFromPathSegment, cardPath, isCardId } from "@bridge/specs";

afterEach(() => vi.restoreAllMocks());

describe("card id grammar (isCardId)", () => {
  it("accepts bridge-vended and legacy ids", () => {
    expect(isCardId("BR#3990")).toBe(true);
    expect(isCardId("BR#1")).toBe(true);
    expect(isCardId("TASK-007")).toBe(true);
  });

  it("rejects freeform ask ids, event ids, and non-ids", () => {
    expect(isCardId("ASK-mvg1jb99-bo82")).toBe(false);
    expect(isCardId("bridge-ui:1729:abc")).toBe(false);
    expect(isCardId("bkw_deadbeef")).toBe(false);
    expect(isCardId("BR#abc")).toBe(false);
    expect(isCardId("br#3990")).toBe(false); // ids are uppercase — case is identity
    expect(isCardId(3990)).toBe(false);
    expect(isCardId(null)).toBe(false);
    expect(isCardId(undefined)).toBe(false);
  });
});

describe("cardPath", () => {
  it("maps the dash form (# is fragment syntax in a URL)", () => {
    expect(cardPath("BR#3990")).toBe("/card/BR-3990");
    expect(cardPath("TASK-007")).toBe("/card/TASK-007"); // already URL-safe
  });

  it("returns null for non-card ids — no route, no stamp", () => {
    expect(cardPath("ASK-mvg1jb99-bo82")).toBe(null);
    expect(cardPath("")).toBe(null);
  });
});

describe("cardIdFromPathSegment (the route parser)", () => {
  it("accepts every reasonable human spelling", () => {
    expect(cardIdFromPathSegment("BR-3990")).toBe("BR#3990");
    expect(cardIdFromPathSegment("BR%233990")).toBe("BR#3990"); // encoded literal
    expect(cardIdFromPathSegment("BR#3990")).toBe("BR#3990");
    expect(cardIdFromPathSegment("3990")).toBe("BR#3990"); // bare number
    expect(cardIdFromPathSegment("TASK-007")).toBe("TASK-007");
    expect(cardIdFromPathSegment("BR-3990/extra")).toBe(null); // no slashes in a segment
  });

  it("returns null for garbage — caller shows the board, not an error", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(cardIdFromPathSegment("weird")).toBe(null);
    expect(cardIdFromPathSegment("TASK-latest")).toBe(null);
    expect(cardIdFromPathSegment("BR-")).toBe(null);
    expect(warn).not.toHaveBeenCalled(); // ordinary non-matches stay quiet
  });

  it("surfaces a malformed escape — null per contract, but logged, never silent", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(cardIdFromPathSegment("%zz")).toBe(null);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain("unparseable segment");
    expect(String(warn.mock.calls[0]?.[0])).toContain("%zz");
  });

  it("surfaces a well-formed-looking but undecodable escape (lone surrogate)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(cardIdFromPathSegment("%ED%A0%80")).toBe(null);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does not log for well-formed segments", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(cardIdFromPathSegment("BR-3990")).toBe("BR#3990");
    expect(cardIdFromPathSegment("BR%233990")).toBe("BR#3990");
    expect(warn).not.toHaveBeenCalled();
  });

  it("round-trips through cardPath", () => {
    for (const id of ["BR#3990", "BR#1", "TASK-007"]) {
      const path = cardPath(id);
      expect(path).toBeTruthy();
      expect(cardIdFromPathSegment(path!.split("/")[2]!)).toBe(id);
    }
  });
});
