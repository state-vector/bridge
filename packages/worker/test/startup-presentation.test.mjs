import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { useKb } from "../../ui-kit/src/server/kbStore";
import { BacklogView } from "../../ui-kit/src/views/BacklogView";
import { StartupWaitNotice } from "../../ui-kit/src/views/StartupWaitNotice";

vi.mock("../../ui-kit/src/server/kbStore", async (original) => {
  const actual = await original();
  const hook = (selector) => selector(actual.useKb.getState());
  Object.assign(hook, actual.useKb);
  return { ...actual, useKb: hook };
});
afterEach(() => useKb.setState({ tasks: [] }));

const wait = { phase: "waiting_executor", source: "legacy", host: "original-host", fingerprint: "legacy", since: 1, reason: "Worker identity was rejected", retained_work: true, attention_at: 10 };
it("actual Backlog markup explains startup recovery instead of offering a churn release", () => {
  useKb.setState({ tasks: [{ id: "BR#1", type: "task", status: "blocked", title: "Critical historical snapshot repair", is_claimable: false,
    created_ts: 1, updated_ts: 1, tags: ["p0"], meta: { startup_wait: wait, blocked: { reason: "churn guard: five failures", await_event: { event: "time", until_ts: 99 } } } }] });
  const html = renderToStaticMarkup(createElement(BacklogView));
  expect(html).toContain("Waiting for executor recovery");
  expect(html).toContain("verified compatible executor readiness");
  expect(html).toContain("no work has started");
  expect(html).not.toContain("Timeout — churn parks");
  expect(html).not.toContain("release-btn");
});
it("actual task notice preserves host affinity and distinguishes a task prerequisite repair", () => {
  const legacy = renderToStaticMarkup(createElement(StartupWaitNotice, { wait }));
  expect(legacy).toContain("Critical startup wait");
  expect(legacy).toContain("Retained work stays on this host");
  const repair = renderToStaticMarkup(createElement(StartupWaitNotice, { wait: { ...wait, phase: "recovery_required", source: "start_failed", retained_work: false, attention_at: null } }));
  expect(repair).toContain("will not be retried unchanged");
  expect(repair).toContain("Another compatible healthy executor");
});
