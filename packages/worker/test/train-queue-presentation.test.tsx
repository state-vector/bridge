import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TrainPanelView } from "../../ui-kit/src/views/TrainPanel";
import type { KbTrainLane } from "../../ui-kit/src/server/kb";

it("renders actual PR blocks without overlapping multiplication labels and explains historical returns", () => {
  const now = 1_800_000_000_000;
  const lane: KbTrainLane = { card: "BR#1", lane: "test/repo@main", lease: null, currently: null, stop: null,
    queue: [{ id: "BR#2", pr: 2, priority: "normal" }],
    line: { phase: "ready", label: "ready", reason: "Executor available", blocker: null, remediation: null, held: 1, observed_at: now, evidence: [] },
    pr_stats: { in_progress: 0, verifying: 0, ready: 1 },
    batches: [[{ id: "BR#2", pr: 2, state: "ready", bounces: 34, over_budget: false, detail: "Current queue gates passed" }]],
  };
  const html = renderToStaticMarkup(<TrainPanelView lanes={[lane]} error={null} now={now} />);
  expect(html).toContain("Each block is a PR");
  expect(html).toContain("Returned to repair/review 34 time(s) across tracked history");
  expect(html).not.toContain("×34");
  expect(html).not.toContain("train-bounce-chip");
  expect(html).not.toContain("de-queued");
  expect(html).toContain("Ready to merge: verified, no conflicts with base");
  expect(html).toContain(">1 ready</span>");
});
