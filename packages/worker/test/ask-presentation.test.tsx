import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HumanDecisionSchema } from "@bridge/contracts";
import { AskContext } from "../../ui-kit/src/views/AskContext.tsx";
import { AskOptions } from "../../ui-kit/src/views/decide.tsx";
import { trainBaseRedAskBrief } from "../src/kb/core.ts";

const head = "065dabde3699a23ffa587a9d5d00879cbd6af619";
const decision = HumanDecisionSchema.parse({
  kind: "authority", task_id: "BR#8772", context: "The reviewed repair is blocked by main's failed deployment.",
  why_human: "Only your repository-owner account can bypass this gate.",
  choices: [
    { label: "(Recommended) Bypass-merge the verified Cortex repair", executor: "human", consequence: "Merge PR #3003 using your owner account.", action: "hold" },
    { label: "Keep the lane held", executor: "bridge", consequence: "Bridge keeps the changes queued.", action: "hold" },
  ],
});

it("shows the PR and exact instructions without expanding evidence, even for existing ambiguous asks", () => {
  const body = `Open [PR #3003](https://github.com/state-vector/superpositional/pull/3003).\n\n\`gh pr merge 3003 --admin --squash --match-head-commit ${head}\``;
  const html = renderToStaticMarkup(<><AskContext body={body} ask={{ decision }} /><AskOptions options={decision.choices.map(c => c.label)} choices={decision.choices} onPick={() => {}} /></>);
  expect(html).toContain('href="https://github.com/state-vector/superpositional/pull/3003"');
  expect(html).toContain(`--match-head-commit ${head}`);
  expect(html).not.toContain("<details");
  expect(html.indexOf("--match-head-commit")).toBeLessThan(html.indexOf("<button"));
  expect(html).toContain("Action owner: You.");
  expect(html).toContain("only sends your answer");
  expect(html).toContain("Action owner: Bridge.");
});

it("keeps Bridge-owned execution distinct from a human action", () => {
  const choices = [{ label: "Resume checks", executor: "bridge" as const, consequence: "Bridge resumes the checks after your answer.", action: "resume" as const }];
  const html = renderToStaticMarkup(<AskOptions options={["Resume checks"]} choices={choices} onPick={() => {}} />);
  expect(html).toContain("Action owner: Bridge.");
  expect(html).toContain("Bridge resumes the checks after your answer.");
  expect(html).not.toContain("You perform");
});

it("keeps the generated owner merge brief explicit and automatically observed", () => {
  const brief = trainBaseRedAskBrief({ repo: "state-vector/superpositional", base: "main" }, [{ name: "Deploy health (merge gate)" }], 3, {
    card: { id: "BR#8772", status: "blocked" }, curePr: { repo: "state-vector/superpositional", number: 3003, head_sha: head }, culpritPr: 3001,
  });
  expect(brief.details).toContain("**You must merge**");
  expect(brief.details).toContain(`--match-head-commit ${head}`);
  expect(brief.details).toContain("Bridge detects the merge automatically");
  expect(brief.details).not.toContain("When you click DONE");
  expect(brief.options[0]).toBe("DONE — PR #3003 merged");
});
