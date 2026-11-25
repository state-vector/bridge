import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HumanDecisionSchema, AskTemplateSchema, composeTemplateAsk } from "@bridge/contracts";
import { AskContext } from "../../ui-kit/src/views/AskContext.tsx";
import { AskOptions } from "../../ui-kit/src/views/decide.tsx";
import { askActionPlan, isOneClickAsk } from "../../ui-kit/src/views/askTemplate.tsx";
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

/* ---- BR#21762: typed ask templates — concise rendering + direct action ---- */

const releaseTemplate = AskTemplateSchema.parse({
  kind: "release_hold", task_id: "BR#16389",
  subject: "PR #3392 projection — holder offline, resumes gate-refused",
  why_now: "the typed wait fired and is verified",
});
const releaseComposed = composeTemplateAsk(releaseTemplate);

it("BR#21762: a templated one-click ask renders one line with the evidence collapsed", () => {
  const html = renderToStaticMarkup(
    <AskContext body={releaseComposed.details} ask={{ decision: releaseComposed.decision, template: releaseTemplate }} />,
  );
  expect(html).toContain("Why your decision is needed");
  expect(html).toContain("<details");
  expect(html).toContain("<summary");
  expect(html).toContain("audited owner override");
});

it("BR#21762: the executable choice derives a direct action plan — templated AND legacy stock", () => {
  const plan = askActionPlan({ decision: releaseComposed.decision, template: releaseTemplate }, "BR#21686");
  expect(plan).toMatchObject({ op: "release_claim", taskId: "BR#16389", label: "Release" });
  expect(plan?.answer).toBe("Release");
  expect(plan?.reason).toContain("BR#21686");
  // an existing ask with no template but a typed release action gets the same button
  expect(askActionPlan({ decision: releaseComposed.decision }, "BR#1")?.op).toBe("release_claim");
  // the legacy local_handoff specimen class stays answer-only — hunting is a producer bug, not a UI guess
  const manual = HumanDecisionSchema.parse({
    kind: "authority", task_id: "BR#16389", context: "c", why_human: "w",
    choices: [
      { label: "Apply the close leg from your live session", executor: "human", consequence: "You hold the completion leg locally.", action: "local_handoff" },
      { label: "Keep parked", executor: "bridge", consequence: "stays", action: "hold" },
    ],
  });
  expect(askActionPlan({ decision: manual }, "BR#2")).toBeNull();
  expect(isOneClickAsk({ decision: manual })).toBe(false);
  expect(isOneClickAsk({ decision: releaseComposed.decision, template: releaseTemplate })).toBe(true);
});

it("BR#21762: AskOptions skips the choice promoted to the direct primary button", () => {
  const html = renderToStaticMarkup(
    <AskOptions options={releaseComposed.options} choices={releaseComposed.decision.choices} skip="Release" onPick={() => {}} />,
  );
  expect(html).not.toContain("One click releases the claim");
  expect(html).toContain("Keep held");
});

it("BR#21762: churn templates expose supersede as a direct action too", () => {
  const churn = composeTemplateAsk(AskTemplateSchema.parse({
    kind: "churn_loop", task_id: "BR#5976", subject: "obligation minting brief", attempts: 7,
  }));
  const plan = askActionPlan({ decision: churn.decision }, "BR#6570");
  expect(plan).toMatchObject({ op: "release_claim", taskId: "BR#5976", label: "Release to pool" });
  const supersedePlan = askActionPlan({
    decision: HumanDecisionSchema.parse({
      kind: "authority", task_id: "BR#5976", context: "c", why_human: "w",
      choices: [
        { label: "Supersede — drop it", executor: "human", consequence: "One click supersedes the card.", action: "supersede" },
        { label: "Keep", executor: "bridge", consequence: "stays", action: "hold" },
      ],
    }),
  }, "BR#3");
  expect(supersedePlan).toMatchObject({ op: "supersede", taskId: "BR#5976" });
});
