import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { useKb } from "../../ui-kit/src/server/kbStore";
import { ForMeView } from "../../ui-kit/src/views/ForMeView";
import { buildClaimLocallyPrompt } from "../../ui-kit/src/views/claimLocally";

// SSR normally reads Zustand's immutable startup snapshot. Render the actual
// components against the seeded snapshot, without a browser/network runtime.
vi.mock("../../ui-kit/src/server/kbStore", async (original) => {
  const actual = await original();
  const hook = (selector) => selector(actual.useKb.getState());
  Object.assign(hook, actual.useKb);
  return { ...actual, useKb: hook };
});

afterEach(() => useKb.setState({ tasks: [] }));
it("actual For Me markup shows the full human question and context, excludes peer mail and duplicate blanket approvals", () => {
  const human = { id: "BR#1", type: "question", status: "todo", title: `Should Bridge retain these records ${"with complete readable context ".repeat(6)}?`, body_md: "The product decision and all essential context are visible here.", created_ts: 1, updated_ts: 1, meta: { ask: { route: { kind: "human_decision" }, to: "human", from: "peer", reason: "Only you can set the retention policy.", options: ["Bridge retains the records", "Bridge deletes the records"] } } };
  const peer = { ...human, id: "BR#2", title: "Find a reviewer for the deployed change?", meta: { ask: { ...human.meta.ask, route: { kind: "agent_coordination" }, to: "macbook-pro-local-2" } } };
  useKb.setState({ tasks: [human, peer] });
  const html = renderToStaticMarkup(createElement(ForMeView, {}));
  expect(html).toContain(human.title);
  expect(html).toContain(human.body_md);
  expect(html).not.toContain(peer.title);
  expect(html).not.toContain("GO — approve &amp; resume");
  expect(html).toContain("Bridge retains the records");
});
it("a question's continuation prompt names the participants and cannot issue implementation protocol", () => {
  const prompt = buildClaimLocallyPrompt({ task: { id: "BR#6430", type: "question", status: "todo", title: "Can the reviewer assess the deployed fix?", meta: { ask: { from: "implementer", to: "reviewer" } } } });
  expect(prompt).toContain("Asked by implementer; addressed to reviewer");
  expect(prompt).not.toContain("TAKEOVER PROTOCOL");
  expect(prompt).not.toContain("git worktree add");
});

it("human decisions render essential context, named executors and consequences without diagnostic filler or human presence warnings", () => {
  const decision = { kind: "preference", task_id: "BR#1", context: "Choose how long customer records are retained.", why_human: "Only you can set the product retention policy.", choices: [{ label: "Keep records", executor: "bridge", consequence: "Bridge implements permanent retention.", action: "resume" }, { label: "Review policy first", executor: "human", consequence: "You supply a retention period; Bridge waits.", action: "hold" }] };
  useKb.setState({ tasks: [{ id: "BR#1", type: "question", status: "todo", title: "Should Bridge keep customer records?", body_md: "Commit details and check URLs are supporting evidence.", created_ts: 1, updated_ts: 1, ask_target: { online: false, source: "unknown", last_seen_ts: null }, meta: { ask: { route: { kind: "human_decision" }, to: "human", decision, options: decision.choices.map((c) => c.label) } } }] });
  const html = renderToStaticMarkup(createElement(ForMeView, {}));
  expect(html).toContain(decision.context);
  expect(html).toContain("<b>Bridge:</b>");
  expect(html).toContain("<b>You:</b>");
  expect(html).toContain("Evidence and technical details</summary>");
  expect(html).not.toContain("never seen");
  expect(html).not.toContain("Choose how Bridge should proceed");
});
