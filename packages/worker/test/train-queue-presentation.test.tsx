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
    batches: [[{ id: "BR#2", pr: 2, state: "ready", eligibility: "reviewed", bounces: 34, over_budget: false, detail: "Reviewed and conflict-free" }]],
  };
  const html = renderToStaticMarkup(<TrainPanelView lanes={[lane]} error={null} now={now} />);
  expect(html).toContain("Each block is a PR");
  expect(html).toContain("Returned to repair/review 34 time(s) across tracked history");
  expect(html).not.toContain("×34");
  expect(html).not.toContain("train-bounce-chip");
  expect(html).not.toContain("de-queued");
  expect(html).toContain(">1 reviewed &amp; clean</span>");
  expect(html).toContain(">0 eligible</span>");
  expect(html).toContain("train-block tb-reviewed");
  lane.batches![0][0].eligibility = "eligible";
  const eligible = renderToStaticMarkup(<TrainPanelView lanes={[lane]} error={null} now={now} />);
  expect(eligible).toContain(">1 eligible</span>");
  expect(eligible).toContain("train-block tb-ready");
});


it("uses the current typed line despite historical red-main records", () => {
  const now = 1_800_000_000_000;
  const lane: KbTrainLane = { card: "BR#1", lane: "test/repo@main", lease: null, currently: null, stop: null, queue: [],
    red_main: { task_id: "BR#9", title: "Old main repair", status: "todo", owner: "", executor_session: "", created_ts: now - 100000 },
    line: { phase: "working", label: "Checking queued changes", reason: "Current main is green", blocker: null, remediation: null, held: 1, observed_at: now, evidence: [] },
  };
  const render = () => renderToStaticMarkup(<TrainPanelView lanes={[lane]} error={null} now={now} />);
  expect(render()).toContain("Checking queued changes");
  expect(render()).not.toContain("main RED");
  expect(render()).not.toContain("STOP-THE-LINE");
  lane.line = { phase: "base_red", label: "STOP THE LINE — main is failing", reason: "Current required check failed", blocker: "main_failed",
    remediation: { kind: "attention", text: "Repair required" }, held: 1, observed_at: now, evidence: [] };
  expect(render()).toContain("STOP-THE-LINE");
  expect(render()).toContain("STOP THE LINE — main is failing");
  expect(render()).toContain("Current required check failed");
  expect(render()).not.toContain("Old main repair");
  expect(render()).not.toContain("nobody is fixing it");
  lane.line = { ...lane.line, phase: "error", blocker: "no_progress", label: "Merge machinery stalled" };
  expect(render()).not.toContain("main RED");
  expect(render()).toContain("Merge machinery stalled");
  expect(render()).not.toContain("STOP-THE-LINE");
  lane.line = undefined;
  expect(render()).toContain("Status unavailable");
  expect(render()).not.toContain("main RED");
});


it("shows an execution-owned PR alongside the idle train", () => {
  const lane: KbTrainLane = { card: "BR#1", lane: "test/repo@main", lease: null, currently: null, stop: null, queue: [],
    line: { phase: "idle", label: "idle", reason: "No queued changes.", blocker: null, remediation: null, held: 0, observed_at: 0, evidence: [] },
    execution_holds: [{ kind: "local_handoff", task_id: "BR#3", task_url: "https://hub.fleetbridge.run/card/BR-3", pr: 2479, reason: "Wait for exact IAM grant" }],
  };
  const html = renderToStaticMarkup(<TrainPanelView lanes={[lane]} error={null} now={1_800_000_000_000} />);
  expect(html).toContain("PR #2479 waiting for local handoff");
  expect(html).toContain('title="Wait for exact IAM grant"');
  expect(html).toContain('href="https://hub.fleetbridge.run/card/BR-3"');
  expect(html).toContain("0 changes queued");
  expect(html).not.toContain("Merge machinery stalled");
});
