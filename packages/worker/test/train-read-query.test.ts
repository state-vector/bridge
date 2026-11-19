import { describe, expect, it } from "vitest";
import { broadRead } from "../src/kb/train-read-query.ts";

/**
 * BR#16950 / GH#471 — the broad-read signal must scale with the hub, not
 * with a recalibrated absolute threshold. The invariant: a bounded query
 * family reads proportionally to what it returns; violations are
 * pathological at every corpus size. Pinned here across four magnitudes —
 * the same broken plan (point query scanning the corpus) is caught at a
 * 2,000-card hub and at a 2,000,000-card hub, and the same healthy bulk
 * read stays silent at both.
 */
describe("broadRead — amplification, not absolute rows (BR#16950)", () => {
  it("healthy point lookups stay silent (below the noise floor)", () => {
    expect(broadRead(2, 1)).toBe(false);      // PK seek
    expect(broadRead(19, 1)).toBe(false);     // lane read post-fix
    expect(broadRead(150, 60)).toBe(false);   // indexed fan-out
  });

  it("healthy bulk reads stay silent at any magnitude — reads ≈ returns", () => {
    expect(broadRead(3_000, 3_000)).toBe(false);
    expect(broadRead(200_000, 198_000)).toBe(false);
    expect(broadRead(2_000_000, 1_900_000)).toBe(false);
  });

  it("a seek turned scan is caught at EVERY corpus size", () => {
    // the lane_cards and review_children specimens: point question, corpus answer
    expect(broadRead(2_000, 1)).toBe(true);
    expect(broadRead(13_746, 0)).toBe(true);
    expect(broadRead(14_098, 1)).toBe(true);
    expect(broadRead(200_000, 1)).toBe(true);
    expect(broadRead(2_000_000, 0)).toBe(true);
  });

  it("moderate legitimate overread has headroom — 10x before signalling", () => {
    expect(broadRead(600, 100)).toBe(false);   // 6x: index seek overhead
    expect(broadRead(1_000, 100)).toBe(false); // exactly 10x: at the boundary, strict >
    expect(broadRead(1_100, 100)).toBe(true);  // 11x: past the ratio
  });

  it("the floor keeps micro-reads out of ratio noise", () => {
    expect(broadRead(199, 0)).toBe(false); // 0 returned, tiny read — not a signal
    expect(broadRead(200, 0)).toBe(true);  // at floor, ratio holds
  });
});
