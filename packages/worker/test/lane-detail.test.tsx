import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { isLaneCard, LaneDetailView } from "../../ui-kit/src/views/LaneDetail";
import type { KbArtefact, KbTrainLane, KbVersion } from "../../ui-kit/src/server/kb";

const now = 1_800_000_000_000;
const task: KbArtefact = {
  id: "BR#3637", type: "task", title: "Merge lane: test/repo@main", status: "blocked", created_ts: 1, updated_ts: now,
  meta: { lane: { repo: "test/repo", base: "main" }, session: "obsolete-session", last_progress: { completion_pct: 100, note: "Obsolete diagnosis" },
    blocked: { reason: "Old blocked reason", unblock_condition: "Run train on a gateway" }, attempt: { attempts: 13 } },
};
const lane: KbTrainLane = {
  card: task.id, lane: "test/repo@main", lease: { holder: "gateway", heartbeat_ts: now, expires_ts: now + 300_000 },
  currently: null, stop: null, queue: [{ id: "BR#100", pr: 42, priority: "normal" }, { id: "BR#101", pr: 43, priority: "normal" }],
  line: { phase: "waiting", label: "Build and deployment running", reason: "Changes resume automatically when required checks pass.",
    blocker: "checks_running", held: 2, observed_at: now, evidence: [],
    remediation: { kind: "machine", text: "Watching deployment #123.", url: "https://github.com/test/repo/actions/runs/123" } },
  required_workflows: ["deploy / Deploy to dev", "Cortex Quality Smoke"],
  queue_facts: { at: now, entries: [{ id: "BR#100", pr: 42, cls: "blocked", repair: { kind: "head_checks", checks: [{ name: "ci / Eval", url: "https://github.com/test/repo/actions/runs/456" }] }, repair_task: "BR#102" },
    { id: "BR#101", pr: 43, cls: "ready" }] },
};
const noop = () => {};
function render(overrides: Partial<Parameters<typeof LaneDetailView>[0]> = {}) {
  return renderToStaticMarkup(<LaneDetailView task={task} lane={lane} now={now} receivedAt={now} loaded error={null}
    versions={[]} historyError={null} onRetry={noop} onClose={noop} {...overrides} />);
}

it("recognizes lane metadata, not a title or merge-train tag on an ordinary task", () => {
  expect(isLaneCard(task)).toBe(true);
  expect(isLaneCard({ ...task, meta: {}, tags: ["merge-train"] })).toBe(false);
  expect(isLaneCard({ ...task, meta: { lane: null } })).toBe(false);
});
it("renders live deployment, queue blockers and repair links without ordinary task semantics", () => {
  const html = render();
  expect(html).toContain("Build and deployment running");
  expect(html).toContain('href="https://github.com/test/repo/actions/runs/123"');
  expect(html).toContain('href="https://github.com/test/repo/pull/42"');
  expect(html).toContain('href="/card/BR-102"');
  expect(html).toContain("ci / Eval");
  expect(html).toContain("Checks passed · waiting for lane");
  expect(html).toContain("Cortex Quality Smoke");
  expect(html).toContain("Executor online");
  expect(html).not.toMatch(/Unblock now|Supersede|done 100%|Model size|Execution state|attempted 13|obsolete-session|Obsolete diagnosis|Dependency graph|Old blocked reason/);
});
it("fails visibly and withdraws old ready / online claims when refresh fails", () => {
  const html = render({ error: "Hub offline" });
  expect(html).toContain("Lane refresh failed: Hub offline");
  expect(html).toContain("Status unavailable");
  expect(html).toContain("Last observed queue");
  expect(html).toContain("Readiness unconfirmed");
  expect(html).not.toContain("Checks passed");
  expect(html).not.toContain("Executor online");
});
it("ages out a healthy snapshot and candidate gate observations independently", () => {
  const html = render({ now: now + 16 * 60_000 });
  expect(html).toContain("Lane observations are out of date");
  expect(html).not.toContain("Checks passed");
  const oldFacts = render({ lane: { ...lane, queue_facts: { ...lane.queue_facts!, at: now - 16 * 60_000 } } });
  expect(oldFacts).toContain("readiness has not been confirmed");
  expect(oldFacts).not.toContain("Checks passed");
});
it("keeps lease chatter out of recent merge activity", () => {
  const versions: KbVersion[] = [
    { seq: 1, action: "train:lease_renew", actor: "gateway", ts: now, summary: "lease renewed" },
    { seq: 2, action: "train:landed", actor: "gateway", ts: now, summary: "PR #41 landed green" },
  ];
  const html = render({ versions });
  expect(html).toContain("PR #41 landed green");
  expect(html).not.toContain("lease renewed");
});
it("renders loading and unavailable lanes explicitly", () => {
  expect(render({ lane: null, loaded: false })).toContain("Loading lane…");
  expect(render({ lane: null })).toContain("This lane is not available");
});
