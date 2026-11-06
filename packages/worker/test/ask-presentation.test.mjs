import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { useKb } from "../../ui-kit/src/server/kbStore";
import { ForMeView } from "../../ui-kit/src/views/ForMeView";
import { buildClaimLocallyPrompt } from "../../ui-kit/src/views/claimLocally";
import { AskEntries, humanAskSubject, isOpenHumanAsk } from "../../ui-kit/src/views/AskBand";
import { TopView } from "../../ui-kit/src/views/TopView";

// SSR normally reads Zustand's immutable startup snapshot. Render the actual
// components against the seeded snapshot, without a browser/network runtime.
vi.mock("../../ui-kit/src/server/kbStore", async (original) => {
  const actual = await original();
  const hook = (selector) => selector(actual.useKb.getState());
  Object.assign(hook, actual.useKb);
  return { ...actual, useKb: hook };
});

afterEach(() => useKb.setState({ tasks: [] }));
it("Top excludes phantom asks and machine waits but admits a task with a real human question", () => {
  const task = (id, title) => ({ id, type: "task", status: "blocked", title, created_ts: 1, updated_ts: 1, meta: { awaiting_ask: { ask_id: "BR#missing" }, blocked: { unblock_condition: "An eligible executor becomes usable" } } });
  const human = { id: "BR#ask", type: "question", status: "todo", title: "Should we retain the records?", part_of: "BR#human", meta: { ask: { route: { kind: "human_decision" }, to: "human" } } };
  const peer = { ...human, id: "BR#peer", part_of: "BR#machine", meta: { ask: { route: { kind: "agent_coordination" }, to: "worker" } } };
  useKb.setState({ tasks: [task("BR#machine", "Machine wait must not appear"), task("BR#human", "Real human decision subject"), human, peer] });
  const html = renderToStaticMarkup(createElement(TopView, {}));
  expect(html).toContain("Real human decision subject");
  expect(html).not.toContain("Machine wait must not appear");
  expect(html).not.toContain("top-await-note");
  expect(html).not.toContain("human input required — open the card");
  expect(isOpenHumanAsk({ ...human, status: "done" })).toBe(false);
  expect(isOpenHumanAsk(peer)).toBe(false);
  expect(humanAskSubject({ ...human, part_of: undefined, meta: { ask: { artefact_id: "BR#human" } } })).toBe("BR#human");
});

it("real ask strips retain complete questions, context, choices and custom-answer controls", () => {
  const question = { id: "BR#ask", type: "question", status: "todo", title: "Should Bridge retain customer records?", body_md: "The complete essential brief remains readable.", created_ts: 1, meta: { ask: { route: { kind: "human_decision" }, to: "human", options: ["Bridge retains records", "Bridge removes records"] } } };
  const html = renderToStaticMarkup(createElement(AskEntries, { entries: [{ kind: "nodeAsk", nodeAsk: question }], onDone() {}, nested: true }));
  expect(html).toContain("ab-question-head");
  expect(html).toContain("awaiting you");
  expect(html).toContain(question.title);
  expect(html).toContain(question.body_md);
  expect(html).toContain("Bridge retains records");
  expect(html).toContain("Bridge removes records");
  expect(html).toContain("type your own answer");
  expect(html).toContain("Reframe");
});
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
