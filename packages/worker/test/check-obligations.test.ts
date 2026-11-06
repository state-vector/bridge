import { describe, expect, it } from "vitest";
import { classifyHeadChecks, classifyMainCheckRuns, type MainCheckRun } from "../src/kb/core";

describe("GitHub check obligations", () => {
  it("a republisher cannot erase an enforced failure in another suite; a new attempt in that suite can", () => {
    const failed: MainCheckRun = { id: 126988470498, name: "Deploy health (merge gate)", conclusion: "failure",
      source: { kind: "check_run", suite_id: 10, app_id: 1 } };
    const republished: MainCheckRun = { ...failed, id: 127642055356, conclusion: "success", source: { kind: "check_run", suite_id: 20, app_id: 1 } };
    for (const classify of [classifyHeadChecks, classifyMainCheckRuns]) {
      expect(classify([failed, republished]).verdict).toBe("red");
      expect(classify([failed, republished, { ...failed, id: 127653739994, conclusion: "success" }]).verdict).toBe("green");
      expect(classify([failed, republished, { ...failed, id: 127653739994, conclusion: null }]).verdict).toBe("unsettled");
    }
  });
});
