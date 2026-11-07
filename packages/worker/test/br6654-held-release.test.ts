import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { releaseHold } from "../src/kb/core.ts";

/**
 * BR#6654 — release:held-train-queue on BR#4687 (3 events, 2026-11-05
 * 14:09–14:11Z, one per alarm tick).
 *
 * Two coupled legs, both pinned here / in machine.test.ts:
 *
 * 1. PRICING (machine.test.ts): the BR#4563 NAMED held classes
 *    (release:held-typed-await / release:held-train-queue) classified the
 *    same benign BR#4067 refusals the BR#4562 law priced never-a-breach —
 *    but only the umbrella release_held had the ∞ threshold, so the tagged
 *    spellings fell to the default threshold of 3 and three refusals raised
 *    a breach card on exactly the events the law ruled benign. The specimen
 *    card's sample is the guard's OWN refusal message — zero state was
 *    destroyed (BR#4687 has no card-history entries in the window).
 *
 * 2. EMITTER (this file): the owner-death release leg (alarmSweep phase E,
 *    BR#2893) was the one machine release path that attempted bare — no
 *    releaseHold pre-check. Its exemptions covered asks/grace/subprocess but
 *    not train queue slots or typed waits, so for ~7h (owner last_seen + 4h
 *    staleness bar → next live session) every alarm tick attempted
 *    in_progress → todo on an awaiting-ci car, the BR#4067 backstop refused,
 *    and each refusal re-manufactured an audited transition_rejected.
 *    Every sibling release path already holds first (stall sweep, review
 *    sweep, park drain — BR#4562/4563, ask-answer dispatch — BR#5902); this
 *    pin keeps the owner-death leg in that family at the source level, so
 *    prod cannot drift from the law.
 */

describe("BR#6654 leg 1 — releaseHold holds the BR#4687 shape (unit)", () => {
  it("an awaiting-ci car with a live PR leg holds — the exact meta the owner-death leg must check", () => {
    // BR#4687's meta at 2026-11-05 14:09Z (get_artefact, first-hand)
    const meta = {
      merge_train: {
        state: "awaiting-ci",
        at: 1793855846621,
        pr: 322,
        repo: "state-vector/bridge",
        legs: { 322: { state: "awaiting-ci", merge_sha: "581afab2c67105bfe95e583bab9c9c9e7f0c3da1" } },
        merge_sha: "581afab2c67105bfe95e583bab9c9c9e7f0c3da1",
      },
      pr: { repo: "state-vector/bridge", number: 322, head_sha_at_acceptance: "1a8cd89fffbfa50faa6ee68a08b28b538d1d4fc2" },
    };
    const hold = releaseHold(meta);
    expect(hold).toContain("awaiting-ci");
    expect(hold).toContain("state-vector/bridge#322");
  });
});

describe("BR#6654 leg 2 — the owner-death release holds BEFORE attempting (source-level, so prod can't drift)", () => {
  const src = readFileSync(new URL("../src/kb/do.ts", import.meta.url).pathname, "utf8");

  /** index of the `}` matching the `{` at openIdx (balanced-text match —
   *  the alarmSweep region holds no unbalanced braces in strings/comments) */
  const matchBrace = (s: string, openIdx: number): number => {
    let depth = 0;
    for (let i = openIdx; i < s.length; i++) {
      if (s[i] === "{") depth++;
      else if (s[i] === "}") { depth--; if (depth === 0) return i; }
    }
    return -1;
  };

  it("the in_progress owner-death branch runs releaseHold(meta) before its →todo transition", () => {
    const sweepOpen = src.indexOf("{", src.indexOf("private async alarmSweep("));
    expect(sweepOpen).toBeGreaterThan(-1);
    const body = src.slice(sweepOpen + 1, matchBrace(src, sweepOpen));

    // phase (E) — the owner-death release walk
    const ownerDeath = body.indexOf("(E) owner-death release");
    expect(ownerDeath).toBeGreaterThan(-1);

    // the in_progress release branch and its transition
    const branchOpen = body.indexOf('if (r.status === "in_progress") {', ownerDeath);
    expect(branchOpen).toBeGreaterThan(-1);
    const branch = body.slice(branchOpen, matchBrace(body, body.indexOf("{", branchOpen)));

    // the hold check is IN the branch, before the release attempt — a held
    // card is waited out (the train / proxy watch / answer owns the exit),
    // never re-refused once per tick
    expect(branch).toContain("releaseHold(meta)");
    const holdIdx = branch.indexOf("releaseHold(meta)");
    const txIdx = branch.indexOf('to: "todo"');
    expect(txIdx).toBeGreaterThan(holdIdx);
    // the check refuses the whole leg (continue), not just annotates
    expect(branch.slice(holdIdx, holdIdx + 40)).toMatch(/releaseHold\(meta\)\)?\s*continue/);
  });

  it("the blocked/in_review ownership-lapse branch stays transition-free (notes only — no refusal storm surface)", () => {
    const sweepOpen = src.indexOf("{", src.indexOf("private async alarmSweep("));
    const body = src.slice(sweepOpen + 1, matchBrace(src, sweepOpen));
    const ownerDeath = body.indexOf("(E) owner-death release");
    const elseOpen = body.indexOf("} else {", body.indexOf('if (r.status === "in_progress") {', ownerDeath));
    expect(elseOpen).toBeGreaterThan(-1);
    const elseBranch = body.slice(elseOpen, matchBrace(body, body.indexOf("{", elseOpen)));
    expect(elseBranch).not.toContain('to: "todo"');
    expect(elseBranch).toContain("ownership lapsed");
  });
});
