import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskStateCard } from "../../ui-kit/src/views/TaskDetail";
import type { KbArtefact } from "../../ui-kit/src/server/kb";

/**
 * BR#16195 — the human sign-off Done control. A role:human card resting in
 * in_review is the BR#15659 designed hold: machine closes are fence-refused
 * (machine.ts human-signoff-done) and the card waits for the logged-in
 * human's Done click in the webapp. The defect receipt (evidence ask
 * BR#15898) recorded that the in_review card surface rendered NO Done control
 * at all — the click was impossible in exactly the one state where it is a
 * legal edge. TaskStateCard now renders the sign-off row, and ONLY there:
 *
 *   (a) role:human + in_review  → the Done — sign off control renders;
 *   (b) anything else           → still no Done (no human role, other
 *                                 statuses — including the parked-blocked
 *                                 state whose clicks never took effect,
 *                                 BR#15898 body);
 *   (c) the fence itself is untouched — machine.ts is not modified by this
 *       change; the existing fence pins (machine.test.ts,
 *       br15659-signoff-defer.test.ts) stay the law.
 */

const now = 1_794_936_790_616;

function card(overrides: Partial<KbArtefact> = {}): KbArtefact {
  return {
    id: "BR#15616", type: "task", title: "sign-off specimen", status: "in_review",
    roles: ["human"], created_ts: now, updated_ts: now,
    meta: { work_revision: "468055d1-0ee7-44cf-bf98-49b1ff157de7" },
    ...overrides,
  };
}

const render = (t: KbArtefact) => renderToStaticMarkup(<TaskStateCard task={t} />);

it("(a) role:human in_review card renders the Done sign-off control", () => {
  const html = render(card());
  expect(html).toContain("Done — sign off");
  expect(html).toContain("human sign-off (BR#15659)");
  // the control is a real button on the card surface, not hidden text
  expect(html).toMatch(/<button[^>]*>Done — sign off<\/button>/);
});

it("(b) cards without the human role still show no Done", () => {
  expect(render(card({ roles: ["impl"] }))).not.toContain("Done — sign off");
  expect(render(card({ roles: [] }))).not.toContain("Done — sign off");
  expect(render(card({ roles: null }))).not.toContain("Done — sign off");
});

it("(b) the Done control is legal ONLY from in_review — never blocked/parked, never done", () => {
  // parked-blocked clicks never took effect (BR#15898 body): the hold state
  // renders its unblock row, never a Done
  const parked = render(card({ status: "blocked", meta: { blocked: { reason: "held for sign-off", unblock_condition: "human Done click" } } }));
  expect(parked).not.toContain("Done — sign off");
  expect(parked).toContain("Unblock now");
  expect(render(card({ status: "in_progress" }))).not.toContain("Done — sign off");
  expect(render(card({ status: "done" }))).not.toContain("Done — sign off");
  expect(render(card({ status: "todo" }))).not.toContain("Done — sign off");
});

it("(b) non-task artefacts never render the sign-off row", () => {
  expect(render(card({ type: "question" }))).not.toContain("Done — sign off");
});

it("(a) existing affordances are unchanged around the new row", () => {
  // runner-held in_progress dispatch card: takeover row still renders, and a
  // non-human card in the same state still shows no Done
  const held = render(card({ roles: ["impl"], status: "in_progress", meta: { session: "dispatch-BR-16195-3f045a87" } }));
  expect(held).toContain("Take over claim");
  expect(held).not.toContain("Done — sign off");
});
