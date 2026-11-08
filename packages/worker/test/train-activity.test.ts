import { expect, it } from "vitest";
import { trainCandidateActivity } from "@bridge/contracts";

it("only current candidate evidence can request a review; expired or malformed facts cannot", () => {
  const now = 2_000_000;
  const facts = { at: now, entries: [{ id: "BR#1", cls: "needs-review" }] };
  expect(trainCandidateActivity("BR#1", facts, now)?.class).toBe("awaiting-review");
  expect(trainCandidateActivity("BR#1", facts, now + 15 * 60_000)?.class).toBe("merge-checks");
  expect(trainCandidateActivity("BR#2", facts, now)?.class).toBe("merge-checks");
  expect(trainCandidateActivity("BR#1", { entries: facts.entries }, now)?.class).toBe("merge-checks");
  expect(trainCandidateActivity("BR#1", { ...facts, at: now + 1 }, now)?.class).toBe("merge-checks");
  expect(trainCandidateActivity(null, facts, now)).toBeNull();
});

it("reports a failed check observation without asserting that PR checks are running or review is missing", () => {
  const result = trainCandidateActivity("BR#1", { at: 1, entries: [{ id: "BR#1", cls: "waiting", error: "hub request timed out" }] }, 2);
  expect(result?.class).toBe("waiting-checks");
  expect(result?.note).toContain("could not check BR#1 — hub request timed out");
  expect(result?.note).not.toContain("review");
  expect(result?.note).not.toContain("still running");
});
