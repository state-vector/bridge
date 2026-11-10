import { createElement as h } from "react";
import { renderToStaticMarkup as render } from "react-dom/server";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { activityBuckets, DashboardSummary, ThroughputSummary } from "../../ui-kit/src/views/Dashboard";
import { TrainPanelView } from "../../ui-kit/src/views/TrainPanel";
import { TopSectionHeader, TrainMachineRows } from "../../ui-kit/src/views/TopView";

const now = Date.now();
const recovery = { kind: "agent", text: "An agent is fixing the failed check.", task: { id: "BR#1", url: "https://hub.fleetbridge.run/card/BR-1", title: "Restore the required service check", owner: "test-agent", status: "in_progress", last_progress: { note: "Checked the failing service.", will: "Verify the repair and rerun the service check.", ts: now - 40_000, completion_pct: 45 } } };
const ready = { lane: "state-vector/bridge@main", card: "BR#2", line: { phase: "ready", label: "ready", reason: "An executor is available.", blocker: null, evidence: [], held: 0, observed_at: now, remediation: null }, activity: { merged_1h: 3, merged_24h: 13 } };
const stopped = { ...ready, lane: "state-vector/superpositional@main", card: "BR#3", line: { phase: "base_red", label: "STOP THE LINE — main is failing", reason: "New changes wait until the required service check passes.", blocker: "main_failed", evidence: [{ name: "Cortex Quality Smoke", url: "https://example.test/check" }], held: 6, observed_at: now - 120_000, remediation: recovery }, pr_stats: { in_progress: 21, verifying: 0, ready: 6 } };
const theme = { cloud: [["attempted", 69], ["cortex", 20], ["merge-train", 15]], selected: [], toggle() {}, clear() {}, passes: () => true };
const tp = { total: 67, range_days: 30, bucket: "day", buckets: Array.from({ length: 30 }, (_, i) => ({ t: now - (29 - i) * 86_400_000, n: i % 7, cumulative: i })) };
const tasks = Array.from({ length: 12 }, (_, i) => ({ id: `BR#${i}`, status: i < 4 ? "in_progress" : i < 8 ? "blocked" : "done", meta: { last_progress: { sentiment: i % 3 ? "neutral" : "going_well" } } }));
const events = Array.from({ length: 120 }, (_, i) => ({ ts: now - i * 23_000, actor: `agent-${i % 3}` }));

it("activity excludes old/future events and never accumulates counts on another render", () => {
  const input = [{ ts: now }, { ts: now - 60_000 }, { ts: now - 3_600_000 }, { ts: now + 1 }];
  const first = activityBuckets(input, now);
  expect(first.reduce((sum, b) => sum + b.n, 0)).toBe(2);
  expect(activityBuckets(input, now)).toEqual(first);
  render(h(DashboardSummary, { tasks, events: input }));
  expect(activityBuckets(input, now)).toEqual(first);
});

it("the alert is inside the affected lane group after its row, never above an unrelated line", () => {
  const html = render(h(TrainPanelView, { lanes: [ready, stopped], now, error: null }));
  const healthyGroup = html.slice(html.indexOf('aria-label="state-vector/bridge@main"'), html.indexOf('</section>'));
  expect(healthyGroup).not.toContain('role="alert"');
  const failedGroup = html.slice(html.indexOf('aria-label="state-vector/superpositional@main"'));
  expect(failedGroup).toContain('role="alert"');
  expect(failedGroup.indexOf('class="ktable-row train-row"')).toBeLessThan(failedGroup.indexOf('role="alert"'));
  expect(failedGroup).toContain(recovery.task.last_progress.will);
});

it("shows the affected PR, check failure and repair owner before expanding details", () => {
  const prUrl = "https://github.com/state-vector/superpositional/pull/2479";
  const line = { ...stopped.line, phase: "error", blocker: "no_progress", label: "Merge machinery stalled",
    remediation: { ...recovery, text: "PR #2479 fails ci / Chat Integration. Repair is running.",
      task: { ...recovery.task, pr: 2479, pr_url: prUrl } } };
  const html = render(h(TrainPanelView, { lanes: [{ ...stopped, line }], now, error: null }));
  const banner = html.slice(html.indexOf('role="alert"'));
  const details = banner.indexOf("<details");
  expect(details).toBeGreaterThan(0);
  expect(banner.slice(0, details)).toContain(prUrl);
  expect(banner.slice(0, details)).toContain("ci / Chat Integration");
  expect(banner.slice(0, details)).toContain("test-agent");
});

it("routine deployment waits stay compact while stopped and unknown lines retain their alerts", () => {
  const waiting = { ...ready, line: { ...ready.line, phase: "waiting", label: "Build and deployment running", blocker: "checks_running", held: 2, remediation: { kind: "machine", text: "Watching deployment.", url: null } } };
  const html = render(h(TrainPanelView, { lanes: [waiting], now, error: null }));
  expect(html).toContain("Build and deployment running");
  expect(html).not.toContain('role="alert"');
  expect(html).not.toContain("train-lane-interrupted");
  expect(html).not.toContain("Main last checked");
  const unknown = { ...stopped, line: { ...stopped.line, phase: "unknown", blocker: "stale_observation", label: "Status is out of date" } };
  for (const lane of [stopped, unknown, { ...ready, line: undefined }]) {
    const alert = render(h(TrainPanelView, { lanes: [lane], now, error: null }));
    expect(alert).toContain('role="alert"');
    expect(alert).toContain("train-lane-interrupted");
  }
});

it("renders active train work as a Top machine row with an exact PR link", () => {
  const waiting = {
    ...ready,
    currently: { pr: 325, task_id: "BR#7818", merged_at: now - 30_000 },
    line: { ...ready.line, phase: "waiting", label: "Build and deployment running",
      blocker: "checks_running", remediation: { kind: "machine", text: "Watching deployment.", url: null } },
  };
  const html = render(h(TrainMachineRows, { lanes: [waiting, ready, { ...waiting, retired: true }], now }));
  expect(html.match(/class="ktable-row top-row/g)).toHaveLength(1);
  expect(html).toContain("BR#7818");
  expect(html).toContain("https://github.com/state-vector/bridge/pull/325");
  expect(html).toContain(">machine<");
  expect(html).toContain("Build and deployment running");
  expect(html).toContain("Watching deployment.");
  expect([...html.matchAll(/class="topc-(?:task|agent|model|session|goal|status|score|gauge|bar|age)(?: [^"]*)?"/g)]).toHaveLength(13);
});

it("theme filters start closed; the subtitle sits in the title block; chart units and periods are explicit", () => {
  const head = render(h(TopSectionHeader, { theme }));
  expect(head).toContain('<details class="tag-theme-panel">');
  expect(head).not.toContain('<details class="tag-theme-panel" open');
  expect(head).toContain('aria-pressed="false"');
  const completion = render(h(ThroughputSummary, { tp, bucket: "day", onBucket() {} }));
  expect(completion).toContain("tasks/day");
  expect(completion).toContain("last 30 days");
  expect(completion).not.toContain("polyline");
  expect(render(h(ThroughputSummary, { tp: null, failed: true, bucket: "day", onBucket() {} }))).toContain("Completion history unavailable");
});

// Optional browser artefact uses the REAL component render and built stylesheet,
// never a hand-retyped approximation of the JSX/CSS under test.
if (process.env.BRIDGE_LAYOUT_PROBE) {
  const dist = new URL("../../webapp/dist/assets/", import.meta.url);
  const css = readdirSync(dist).find((name) => name.endsWith(".css"));
  const style = readFileSync(new URL(css, dist), "utf8");
  const markup = render(h("main", { className: "top-wrap" },
    h(TrainPanelView, { lanes: [ready, stopped], now, error: null }),
    h(DashboardSummary, { tasks, events }, h(ThroughputSummary, { tp, bucket: "day", onBucket() {} })),
    h(TopSectionHeader, { theme })));
  writeFileSync(process.env.BRIDGE_LAYOUT_PROBE, `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>${style}body{background:var(--bg);color:var(--text);padding:14px}</style>${markup}`);
}
