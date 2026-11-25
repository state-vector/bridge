import { describe, expect, it } from "vitest";
import {
  composeBootstrap,
  DEFAULT_CRON_PLAYBOOK,
  DEFAULT_ROLE_PLAYBOOKS,
  resolveRolePlaybook,
} from "../src/kb/core.ts";

/** BR#21859 — role critique discipline: self- and system-critique must be
 *  instructed EARLY (heartbeat risk line, analysis trace-before-decompose,
 *  impl repo-steering-first) and OFTEN (every note, every handover, every
 *  verdict), not only at review time. These pins keep the directives in the
 *  server-composed text every role actually receives via orient. */
const bootstrap = composeBootstrap("Test", { mode: "none" } as any);

describe("role critique discipline (BR#21859)", () => {
  it("rule 4 requires the one-line risk statement — distinct from the numeric gauge", () => {
    expect(bootstrap).toMatch(/4\. HEARTBEAT:.*\+ risk \(one line in the note: the single biggest thing that could be wrong right now/);
    expect(bootstrap).toMatch(/the numeric risk_pct gauge is not a substitute/);
    expect(bootstrap).toMatch(/"none identified" is a claim you must be able to defend/);
  });

  it("the PROTOCOL CARD heartbeat point carries the risk duty into subagent seeds", () => {
    expect(bootstrap).toMatch(/PROTOCOL CARD:.*3\. HEARTBEAT: log_progress \{id, did, will, session\} every ≤10 min — every note carries risk/s);
  });

  it("the cron playbook heartbeat demands the risk line too", () => {
    expect(DEFAULT_CRON_PLAYBOOK).toContain("AND the one-line risk (the single biggest thing that could be wrong right now");
  });

  it("impl: repo steering first + self-critique before handover", () => {
    const p = DEFAULT_ROLE_PLAYBOOKS.impl;
    expect(p).toContain("REPO STEERING FIRST (BR#21859)");
    expect(p).toMatch(/AGENTS\.md at the root and any \.kiro\/steering\/\*\.md/);
    expect(p).toContain("SELF-CRITIQUE BEFORE HANDOVER (BR#21859)");
    expect(p).toContain("what you did NOT verify");
    expect(p).toContain("the one finding a reviewer should probe first");
  });

  it("analysis: critique early (end-to-end trace) and at finish (fresh-session checkability)", () => {
    const p = DEFAULT_ROLE_PLAYBOOKS.analysis;
    expect(p).toContain("CRITIQUE EARLY (BR#21859)");
    expect(p).toMatch(/live ground truth → producer\/executor → storage\/state → consumer\/UI/);
    expect(p).toContain("CRITIQUE AT FINISH (BR#21859)");
    expect(p).toContain("without asking you anything");
    expect(p).toContain("what you did NOT verify");
    expect(p).toContain("REPO STEERING FIRST (BR#21859)");
    expect(p).toMatch(/AGENTS\.md at the root and any \.kiro\/steering\/\*\.md/);
  });

  it("review: disprove-your-acceptance before filing the verdict", () => {
    const p = DEFAULT_ROLE_PLAYBOOKS.review;
    expect(p).toContain("CRITIQUE YOUR OWN VERDICT (BR#21859)");
    expect(p).toContain("attempt to DISPROVE your acceptance");
    expect(p).toContain("If you cannot name a counter-check you performed, you are not ready to accept");
    expect(p).toContain("REPO STEERING FIRST (BR#21859)");
    expect(p).toMatch(/AGENTS\.md at the root and any \.kiro\/steering\/\*\.md/);
  });

  it("the repo-steering directive is inherited by EVERY role — not just impl (verify bounce, BR#21859)", () => {
    for (const role of ["analysis", "impl", "review"] as const) {
      expect(DEFAULT_ROLE_PLAYBOOKS[role]).toContain("REPO STEERING FIRST (BR#21859)");
    }
    // The bounce mechanism: resolveRolePlaybook resolves strictly per-role, so a
    // directive only in one role's playbook mechanically never reaches the others.
    expect(resolveRolePlaybook(undefined, "analysis")).toContain("REPO STEERING FIRST");
    expect(resolveRolePlaybook(undefined, "review")).toContain("REPO STEERING FIRST");
    expect(resolveRolePlaybook(undefined, "impl")).toContain("REPO STEERING FIRST");
  });

  it("overrides keep winning; blank still resets to the (hardened) default", () => {
    expect(resolveRolePlaybook({ impl: " custom " }, "impl")).toBe("custom");
    expect(resolveRolePlaybook({ impl: "   " }, "impl")).toBe(DEFAULT_ROLE_PLAYBOOKS.impl);
    expect(resolveRolePlaybook(undefined, "review")).toContain("DISPROVE");
  });
});
