import { describe, expect, it } from "vitest";
import {
  deployedSatisfied,
  doneWhenSection,
  legLabel,
  isSelfAwait,
  parseCloseLegs,
  parseClosureReceipt,
  parseProxyCondition,
  validateAwaitEvent,
  awaitEventFromAtoms,
  awaitEventToAtom,
  describeAwaitEvent,
} from "../src/kb/closure.ts";

/**
 * The closure tier's text law (BR#3361) against the REAL corpus. Every
 * fixture below is copied VERBATIM from a live card (retrieved 2026-10-26),
 * because hand-retyped approximations go stale and the whole point of the
 * parsers is to read the board's actual language:
 *
 *  - BR#3129 unblock condition (meta.last_unblock_spawn.exit) — the ~20h
 *    proxy-flip evidence: "PR #2327 mergeCommit non-null" + duty clauses.
 *  - BR#3185 unblock condition (meta.blocked.unblock_condition) — the
 *    true-park shape: machine proxy + "Alternative proxy" tail.
 *  - BR#3331 unblock condition (meta.blocked.unblock_condition) — the
 *    br_pr_merged shape ("BR#3337's fix PR on <repo> is MERGED").
 *  - BR#3348 done note (version seq 123386, 2026-10-25T14:01Z) — the real
 *    closure receipts for GH #2274/#2261/#2337.
 *  - BR#3220's false claim shape ("GH#2337 fully closed") — the receipt gate
 *    must reject it, and "close-guard blocked" must not manufacture legs.
 */

// REAL BR#3129 unblock condition — verbatim
const BR3129_COND =
  "Machine proxy: PR https://github.com/state-vector/superpositional/pull/2327 mergeCommit non-null (state=MERGED). Then a fresh session: (1) confirm scenario 'manifest-rowcount-basename-collision' exists on main (fixtures/bug-corpus/defects.toml); (2) close GH #2274 with the closing comment carrying 'scenario: manifest-rowcount-basename-collision' (dogfood close-guard grammar); (3) exit: gh issue view 2274 --json state = CLOSED (not REOPENED) + scenario id in closing comment. If PR still OPEN+CONFLICTING on re-check: needs signed rebase by a session with a working sign env (proxy per BR#3042: signed scratch commit succeeds) — do NOT re-push unsigned (5c).";

// REAL BR#3185 unblock condition — verbatim
const BR3185_COND =
  "Machine proxy: PR https://github.com/state-vector/bridge/pull/179 mergeCommit non-null (state MERGED) — then a FRESH session closes BR#3185 done citing the merge commit. Alternative proxy: a re-review of head 8f92f09c flips reviewDecision to APPROVED — only AFTER the sync app's evidence layer carries the current code (do NOT trigger re-review while degraded; BR#2785 precedent: stale-evidence rounds burn triggers). Rebuttal receipt on the PR: issuecomment-6391088389.";

// REAL BR#3331 unblock condition — verbatim
const BR3331_COND =
  "Machine proxy: BR#3337's fix PR on https://github.com/state-vector/bridge is MERGED (mergeCommit non-null). Then a FRESH session: (1) verify no new transition_rejected events on BR#3298 after 2026-10-25T11:34:22.236Z (fresh breach recurrences would have coalesced onto this open card); (2) close BR#3331 done citing the merge commit + the on-card diagnosis. Alternative proxy: BR#3337 reaches done via its own verify chain with receipts.";

// REAL BR#3423 unblock condition — verbatim (the root-blocker card; retrieved
// 2026-10-26). The stale-ledger specimen: it sat blocked for DAYS with both
// legs holding (BR#3417 answered by web:rayh; PR #2387 merged 8adf1e85) while
// the sweep stamped "unparseable — never auto-flips".
const BR3423_COND =
  "Both legs, machine atoms: (1) BR#3417 answered (status ≠ todo) with GO — any of Option A / Option B / revert #2368 + gate waiver; (2) BR#3415's fix PR merges past the red stop-the-line gate. Then: `gh run list -R state-vector/superpositional --workflow 'Deploy Dev' --branch main` shows a run NEWER than 40205622594 with conclusion=success AND headSha at-or-descendant of the fix merge (decisive deploy on main GREEN) — after which PRs #2352 (BR#3186), #2381 (BR#3328), #2385 (BR#3400) are rebased + green onto that main and their machine proxies flip. A FRESH session then works the 3 queued cards' merge legs; this root card closes only WITH CI-run-URL receipts per its done-when (never auto-close).";

// REAL BR#3348 done note (version seq 123386, 2026-10-25T14:01Z) — verbatim
const BR3348_DONE_NOTE = `VERIFY ACCEPTED (fresh-session verify duty BR#3360, session bridge-task-BR-3360, live 2026-10-25T14:01Z; verdict decision BR#3368) — all 4 legs first-hand. No PR exists: paperwork execution only, so nothing to merge; done-with-receipts = verified closes + corrected records. (1) GH #2274 CLOSED/COMPLETED 13:43:19Z, last comment carries 'scenario: manifest-rowcount-basename-collision', guard run https://github.com/state-vector/superpositional/actions/runs/40198911366 logged 'closure evidence present — allow', scenario confirmed first-hand at fixtures/bug-corpus/defects.toml:1225 on main (issue=2274), PR #2327 MERGED b4343e554 00:51:11Z; BR#3129 done with additive exit receipts. (2) GH #2261 CLOSED/COMPLETED 13:44:52Z, final-ledger comment corrects the stale 'Fix 2 READY, awaiting human merge' line — all 6 PR merge states re-verified first-hand, shas match the ledger verbatim (#2275 960a270b8 08:29:07Z, #2309 3c691ab7b 19:06:01Z, #2321 18933f066 19:16:41Z, #2299 af713a90a 22:53:07Z, #2302 87e835829 22:52:47Z, #2276 3cab1f9e 08:21:49Z), grammar 'scenario: none — owned by #2372', #2372 OPEN, guard run https://github.com/state-vector/superpositional/actions/runs/40199028430 allow. (3) GH #2337 CLOSED/COMPLETED 13:45:36Z, last comment 'scenario: none — owned by #2373' with the in-CI coverage justification, #2373 OPEN, PR #2340 MERGED 4beedf7f6 08:50:59Z, guard run https://github.com/state-vector/superpositional/actions/runs/40199089019 allow; BR#3220 correction-of-record appended 13:48:56Z + independent double-check note from this verify session. (4) Stability: all three still CLOSED/COMPLETED at 14:01:06Z (~16-18 min post-close, no reopen; guard read the LAST comment each time). Note: a parallel executor raced the same closes (shared rayh credential); surviving last comments are consistent and guard-allowed — no conflicting residue. Follow-ups per the task's pattern note filed by impl: BR#3358 + BR#3361 (closure-tier duty scheduling), BR#3359 (GH #2372 push-path fix).`;

describe("parseProxyCondition (machine-checkable atoms from real conditions)", () => {
  it("BR#3129's real condition: one pr_merged atom; the duty clause's own close-GH text is cut, not parsed", () => {
    const { atoms, unparseable } = parseProxyCondition(BR3129_COND);
    expect(unparseable).toBe(false);
    expect(atoms).toHaveLength(1);
    expect(atoms[0]).toMatchObject({ kind: "pr_merged", repo: "state-vector/superpositional", number: 2327 });
    // the duty enumeration must not manufacture extra atoms
    expect(atoms.some((a) => a.kind === "issue_closed")).toBe(false);
  });

  it("BR#3185's real condition: pr_merged 179; the Alternative-proxy tail never parses", () => {
    const { atoms, unparseable } = parseProxyCondition(BR3185_COND);
    expect(unparseable).toBe(false);
    expect(atoms).toHaveLength(1);
    expect(atoms[0]).toMatchObject({ kind: "pr_merged", repo: "state-vector/bridge", number: 179 });
  });

  it("BR#3331's real condition: br_pr_merged (the PR is unnamed — resolved by head branch bridge/BR-3337)", () => {
    const { atoms, unparseable } = parseProxyCondition(BR3331_COND);
    expect(unparseable).toBe(false);
    expect(atoms).toHaveLength(1);
    expect(atoms[0]).toMatchObject({ kind: "br_pr_merged", repo: "state-vector/bridge", brId: "BR#3337" });
  });

  it("BR#3423's real condition: br_answered(3417) + bare br_pr_merged(3415); the 'Then:' duty tail no longer poisons the parse (BR#3620)", () => {
    const { atoms, unparseable } = parseProxyCondition(BR3423_COND);
    expect(unparseable).toBe(false);
    // (1) the answered-ask leg is a board-state atom; (2) the bare fix-PR leg
    // (no repo URL, present tense) parses; the gh-run duty tail is CUT.
    expect(atoms).toHaveLength(2);
    expect(atoms[0]).toMatchObject({ kind: "br_answered", repo: null, brId: "BR#3417" });
    expect(atoms[1]).toMatchObject({ kind: "br_pr_merged", repo: null, brId: "BR#3415" });
    // the duty tail's machine-looking text must not manufacture run/pr atoms
    expect(atoms.some((a) => a.kind === "run_success")).toBe(false);
    expect(atoms.some((a) => a.kind === "pr_merged")).toBe(false);
  });

  it("bare 'BR#N answered' phrasing parses wherever it appears (the ask-resolution class)", () => {
    for (const line of [
      "BR#3607 answered YES — superseded",
      "ask BR#3531 answered with GO",
      "(1) BR#3417 is answered (status ≠ todo) with GO",
      "BR#3417 now resolved — Option A",
    ]) {
      const { atoms, unparseable } = parseProxyCondition(line);
      expect(unparseable, line).toBe(false);
      expect(atoms[0]?.kind, line).toBe("br_answered");
    }
  });

  it("a repo-less machine predicate still parses (the sweep stamps it unresolvable, never flips)", () => {
    const { atoms, unparseable } = parseProxyCondition("PR #2275 mergeCommit non-null");
    expect(unparseable).toBe(false); // parsed, but with no repo
    expect(atoms[0]).toMatchObject({ kind: "pr_merged", repo: null, number: 2275 });
  });

  it("machine-looking text that yields NO atom is stamped unparseable (conservatism law)", () => {
    expect(parseProxyCondition("check run 12345 green on main").unparseable).toBe(true);
    expect(parseProxyCondition("GH#2274 pending re-close").unparseable).toBe(true);
  });

  it("human prose is honest no_atoms — machine-looking markers absent", () => {
    const { atoms, unparseable } = parseProxyCondition("waiting on Ray's merge decision, will resume after");
    expect(atoms).toHaveLength(0);
    expect(unparseable).toBe(false);
  });
});

describe("parseProxyCondition conjunctions — every match per line (BR#3986)", () => {
  it("BR#3557's swallowed conjunction: one line, TWO br_done atoms — pre-fix the parser returned the first only", () => {
    const { atoms, unparseable } = parseProxyCondition("BR#3945 done AND BR#3946 done");
    expect(unparseable).toBe(false);
    expect(atoms.map((a) => a.brId)).toEqual(["BR#3945", "BR#3946"]);
    for (const a of atoms) expect(a.kind).toBe("br_done");
  });

  it("multi-kind line: pr_merged AND br_done both parse (no cross-kind swallow)", () => {
    const { atoms } = parseProxyCondition(
      "PR https://github.com/state-vector/bridge/pull/253 mergeCommit non-null AND BR#3935 done",
    );
    expect(atoms).toHaveLength(2);
    expect(atoms[0]).toMatchObject({ kind: "pr_merged", repo: "state-vector/bridge", number: 253 });
    expect(atoms[1]).toMatchObject({ kind: "br_done", brId: "BR#3935" });
  });

  it("pr_merged conjunction: two PRs on one line", () => {
    const { atoms } = parseProxyCondition("PR #10 mergeCommit non-null AND PR #11 mergeCommit non-null");
    expect(atoms.map((a) => a.number)).toEqual([10, 11]);
  });

  it("issue_closed conjunction: two GH# on one line", () => {
    const { atoms } = parseProxyCondition("GH#1980 closed and GH#1255 closed");
    expect(atoms.map((a) => a.number)).toEqual([1980, 1255]);
    for (const a of atoms) expect(a.kind).toBe("issue_closed");
  });

  it("run_success conjunction: two runs on one line", () => {
    const { atoms } = parseProxyCondition("run 123456 SUCCESS and run 234567 green");
    expect(atoms.map((a) => a.runId)).toEqual(["123456", "234567"]);
    for (const a of atoms) expect(a.kind).toBe("run_success");
  });

  it("pr_checks_green conjunction: two green-check legs on one line", () => {
    const { atoms } = parseProxyCondition(
      "a fresh green check run on PR #12 (head), and a fresh green check run on PR #13 (head)",
    );
    expect(atoms.filter((a) => a.kind === "pr_checks_green").map((a) => a.number)).toEqual([12, 13]);
  });

  it("the same target twice on one line is ONE atom (kind+target dedupe)", () => {
    const { atoms } = parseProxyCondition("BR#3945 done (BR#3945 done confirmed)");
    expect(atoms).toHaveLength(1);
  });

  it("a repeated atom on a later line dedupes without falsely stamping unparseable", () => {
    const { atoms, unparseable } = parseProxyCondition("BR#3945 done;\nBR#3945 done again");
    expect(unparseable).toBe(false);
    expect(atoms).toHaveLength(1);
  });

  it("multi-atom conjunctions never self-migrate (awaitEventFromAtoms stays null — sweep evaluates every atom)", () => {
    expect(awaitEventFromAtoms(parseProxyCondition("BR#3945 done AND BR#3946 done").atoms)).toBeNull();
  });
});

describe("isSelfAwait — the self-referential park deadlock guard (BR#3986/BR#136; br_pr_merged exempt per BR#3620)", () => {
  it("br_done naming the parked card is self", () => {
    expect(isSelfAwait("BR#136", { event: "br_done", id: "BR#136" })).toBe(true);
  });
  it("a self br_pr_merged is NOT self — the train stamps its provenance row while the card is blocked (BR#3620's merge-train flip)", () => {
    expect(isSelfAwait("BR#136", { event: "br_pr_merged", id: "BR#136" })).toBe(false);
  });
  it("other cards' br_done and every other event kind is not", () => {
    expect(isSelfAwait("BR#136", { event: "br_done", id: "BR#135" })).toBe(false);
    expect(isSelfAwait("BR#136", { event: "pr_merged", repo: "o/r", n: 1 })).toBe(false);
    expect(isSelfAwait("BR#136", { event: "ask", ask_id: "ASK-x" })).toBe(false);
  });
});
// ---------- BR#3668: the human-gate law + parenthetical strip ----------
// REAL BR#3358 park (live meta.blocked, 2026-10-26) — the stale-true
// specimen. The sweep mis-parsed the verify-provenance aside "(BR#3361 done,
// decision BR#3409)" inside this text into a br_done atom, stamped it as the
// park's await_event, and re-fired it every cycle (8 dispatch duties on the
// same non-flip). Both fields verbatim.
const BR3358_COND =
  "Human-only: Ray supersedes BR#3358 into BR#3361 via web/admin (BR#2480; ask BR#3374 on record with the 4 one-click options). No machine atom can flip this — unblockProxySweep conservatism law (BR#3409) must treat it as unparseable/unresolvable and never auto-flip. Until the supersede lands this card is agent-terminal: a future claimant verifies first (BR#3361 done, decision BR#3409), stands down (no impl, no fork), re-parks blocked-on-owner — never in_progress, never todo (BR#3390), never answers any bound ask agent-side (BR#3384 rule 2: auto-resume re-arms dispatch).";
const BR3358_REASON =
  "STAND-DOWN re-park (dispatch #3 of this released duplicate; bridge-task-BR-3358, 2026-10-25 ~16:0xZ). Verify-first executed per the owner duty's additive note (hist seq 124960): canonical BR#3361 is DONE — verify verdict decision BR#3409 (VERIFY MERGED): PR https://github.com/state-vector/bridge/pull/207 MERGED 2dd0b42053ad32e7fc431f05a405ea022d004c46, 2/2 signatures valid, checks green (runs 40206526647/40206526651), all four closure-tier mechanisms live (unblockProxySweep / done-close-legs + close-duty auto-derivation / closureAuditSweep correction duties / duplicate_executor fence + 5d stand-down law). Fresh receipts this session: bridge main tip now d77f94f6cbca (PR #205 per BR#3414) with 2dd0b42053ad an ancestor (compare behind_by=0) — the fix of record is on main. Nothing of this card's three leak shapes remains unimplemented; BR#3409: 'No residuals; nothing agent-advanceable remains.' Zero files touched, no fork, no PR — re-parked per the card banner + family law (BR#3384, BR#3390, BR#2480, accepted BR#2508). Sole outstanding leg = owner's web/admin supersede.";

describe("parseProxyCondition human-gate law (BR#3668, real corpus)", () => {
  it("BR#3358's REAL unblock_condition parses to ZERO atoms — human-gated by design, even though the prose carries '(BR#3361 done, …)'", () => {
    const { atoms, unparseable, humanGated, humanGate } = parseProxyCondition(BR3358_COND);
    expect(atoms).toHaveLength(0);
    expect(unparseable).toBe(true);
    expect(humanGated).toBe(true);
    expect(humanGate).toBeTruthy();
  });

  it("BR#3358's REAL blocked_reason prose parses to ZERO atoms too — park-note prose is never atomized", () => {
    const { atoms, unparseable, humanGated } = parseProxyCondition(BR3358_REASON);
    expect(atoms).toHaveLength(0);
    expect(unparseable).toBe(true);
    expect(humanGated).toBe(true);
  });

  it("each closed-set marker classifies on its own; a plain machine condition does not", () => {
    for (const t of [
      "Human-only: Ray clicks the release",
      "no machine atom can flip this card",
      "the owner supersedes via web/admin",
      "owner/web-only release",
    ]) {
      const p = parseProxyCondition(t);
      expect(p.humanGated, t).toBe(true);
      expect(p.atoms, t).toHaveLength(0);
      expect(p.unparseable, t).toBe(true);
    }
    expect(parseProxyCondition("Machine proxy: BR#3337 done with receipts").humanGated).toBeFalsy();
  });

  it("a parenthetical '(BR#N done, …)' never yields br_done — provenance asides are annotation", () => {
    const withPr = parseProxyCondition(
      "Machine proxy: PR https://github.com/state-vector/bridge/pull/207 merged (BR#3361 done, decision BR#3409)",
    );
    expect(withPr.atoms.map((a) => a.kind)).toEqual(["pr_merged"]);
    const proseOnly = parseProxyCondition(
      "verify-first executed per the owner duty (BR#3361 done, decision BR#3409) before acting",
    );
    expect(proseOnly.atoms).toHaveLength(0);
    expect(proseOnly.unparseable).toBe(false); // honest prose once the aside is stripped
  });

  it("preconditions OUTSIDE parentheses still parse — stripping never suppresses real atoms", () => {
    const p = parseProxyCondition("Machine proxy: BR#3337 done with receipts (decision BR#3409)");
    expect(p.atoms).toHaveLength(1);
    expect(p.atoms[0]).toMatchObject({ kind: "br_done", brId: "BR#3337" });
    expect(p.unparseable).toBe(false);
  });
});

describe("parseCloseLegs (terminal legs from real text)", () => {
  it("BR#3348's real done note: exactly the 3 executed legs, bare form (repo resolved at live-check time)", () => {
    const legs = parseCloseLegs(BR3348_DONE_NOTE);
    expect(legs.map((l) => l.number).sort((a, b) => a - b)).toEqual([2261, 2274, 2337]);
    for (const l of legs) expect(l.repo).toBeNull();
  });

  it("intent form and URL form both parse; the URL form carries the repo", () => {
    expect(parseCloseLegs("close GH #2274 with the gate grammar").map((l) => legLabel(l))).toEqual(["GH#2274"]);
    const url = parseCloseLegs("close https://github.com/state-vector/superpositional/issues/2261");
    expect(url).toHaveLength(1);
    expect(url[0]).toMatchObject({ repo: "state-vector/superpositional", number: 2261 });
  });

  it("BR#3220's false claim shape ('GH#2337 fully closed') IS a leg — the gate must demand its receipt", () => {
    const legs = parseCloseLegs("RESIDUE CLEARED — GH#2337 fully closed");
    expect(legs.map((l) => l.number)).toEqual([2337]);
  });

  it("board-card references and guard-system language never manufacture legs", () => {
    expect(parseCloseLegs("closes BR#3337 done — merges parent")).toHaveLength(0);
    expect(parseCloseLegs("close-guard blocked the earlier close for a missing scenario id")).toHaveLength(0);
    expect(parseCloseLegs("BR#3129 done with additive exit receipts")).toHaveLength(0);
  });
});

describe("parseClosureReceipt (receipts from the real done note)", () => {
  it("BR#3348's real receipts: closed + guard-run URL id extracted per leg; comment id stays null (no id in text)", () => {
    for (const [n, guard] of [[2274, "40198911366"], [2261, "40199028430"], [2337, "40199089019"]] as const) {
      const r = parseClosureReceipt(BR3348_DONE_NOTE, { repo: null, number: n, raw: `#${n}` });
      expect(r, `leg ${n} must receipt`).not.toBeNull();
      expect(r!.closed).toBe(true);
      expect(r!.guardRun).toBe(guard);
      expect(r!.commentId).toBeNull();
    }
  });

  it("the full receipt contract parses: state=closed + comment id (bare and URL forms) + guard run id", () => {
    const note = [
      "Terminal legs executed:",
      "- GH #2261: state=closed, closing comment 17623388240, guard run 40198911366 guard=allow",
      "- GH #2274: state=closed (https://github.com/state-vector/superpositional/issues/2274#issuecomment-17623388240), guard=allow",
    ].join("\n");
    const r = parseClosureReceipt(note, { repo: null, number: 2261, raw: "#2261" });
    expect(r).toMatchObject({ closed: true, commentId: "17623388240", guardRun: "40198911366" });
    const r2 = parseClosureReceipt(note, { repo: "state-vector/superpositional", number: 2274, raw: "state-vector/superpositional#2274" });
    expect(r2).toMatchObject({ closed: true, commentId: "17623388240", guardRun: "allow" });
  });

  it("BR#3220's false claim ('fully closed', lowercase, no ids) is NOT a receipt — null, the gate rejects", () => {
    expect(parseClosureReceipt("RESIDUE CLEARED — GH#2337 fully closed", { repo: null, number: 2337, raw: "GH#2337" })).toBeNull();
  });

  it("intent-only and open-state language never receipt", () => {
    expect(parseClosureReceipt("will close GH #2337 next, grammar chosen", { repo: null, number: 2337, raw: "#2337" })).toBeNull();
    expect(parseClosureReceipt("GH #2337 is still OPEN — close-guard blocked the earlier close", { repo: null, number: 2337, raw: "#2337" })).toBeNull();
  });
});

describe("doneWhenSection (the Done-when contract the gate reads)", () => {
  it("returns only the Done-when section, stopping at the next heading", () => {
    const body = [
      "work description",
      "## Done when",
      "- close GH #2261 (the incident issue)",
      "- PR merged",
      "## Contract",
      "behave",
    ].join("\n");
    expect(doneWhenSection(body)).toBe("\n- close GH #2261 (the incident issue)\n- PR merged");
  });

  it("no Done-when section → empty (a card that declares no terminal legs is not gate-enforced)", () => {
    expect(doneWhenSection("## Why this task exists\n\npaperwork execution only")).toBe("");
  });
});

// ---------- BR#3578: the typed await grammar ----------
describe("validateAwaitEvent (BR#3578 closed grammar)", () => {
  it("accepts every registered event shape", () => {
    expect(validateAwaitEvent({ event: "pr_merged", repo: "state-vector/bridge", n: 12 })).toEqual({ event: "pr_merged", repo: "state-vector/bridge", n: 12 });
    expect(validateAwaitEvent({ event: "br_pr_merged", id: "BR#2327" })).toEqual({ event: "br_pr_merged", id: "BR#2327" });
    expect(validateAwaitEvent({ event: "issue_closed", repo: "state-vector/bridge", n: 2261 })).toEqual({ event: "issue_closed", repo: "state-vector/bridge", n: 2261 });
    expect(validateAwaitEvent({ event: "br_done", id: "BR#3372" })).toEqual({ event: "br_done", id: "BR#3372" });
    expect(validateAwaitEvent({ event: "br_answered", id: "BR#3417" })).toEqual({ event: "br_answered", id: "BR#3417" });
    expect(validateAwaitEvent({ event: "run_success", repo: "state-vector/superpositional", newer_than: "40254898149" })).toEqual({ event: "run_success", repo: "state-vector/superpositional", run_id: undefined, newer_than: "40254898149" });
    expect(validateAwaitEvent({ event: "pr_checks_green", repo: "state-vector/bridge", n: 218 })).toEqual({ event: "pr_checks_green", repo: "state-vector/bridge", n: 218 });
    expect(validateAwaitEvent({ event: "ask", ask_id: "BR#3531" })).toEqual({ event: "ask", ask_id: "BR#3531" });
    expect(validateAwaitEvent({ event: "time", until_ts: 1793000000000 })).toEqual({ event: "time", until_ts: 1793000000000 });
  });

  it("fail-closed: unknown kinds, bad shapes and free text never pass", () => {
    expect(validateAwaitEvent(null)).toBeNull();
    expect(validateAwaitEvent("PR #84 merged")).toBeNull(); // free text is NOT an event
    expect(validateAwaitEvent({ event: "custom_thing", x: 1 })).toBeNull(); // closed set
    expect(validateAwaitEvent({ event: "pr_merged", repo: "no-slash", n: 1 })).toBeNull(); // repo must be a slug
    expect(validateAwaitEvent({ event: "br_done", id: "2327" })).toBeNull(); // ids are BR#-prefixed
    expect(validateAwaitEvent({ event: "time", until_ts: "tomorrow" })).toBeNull();
  });

  it("awaitEventFromAtoms migrates exactly ONE clean atom (the sweep's self-migration shim)", () => {
    const a = parseProxyCondition("Machine proxy: PR https://github.com/state-vector/superpositional/pull/2327 mergeCommit non-null");
    expect(awaitEventFromAtoms(a.atoms)).toEqual({ event: "pr_merged", repo: "state-vector/superpositional", n: 2327 });
    expect(awaitEventFromAtoms(parseProxyCondition("BR#3372 done").atoms)).toEqual({ event: "br_done", id: "BR#3372" });
    expect(awaitEventFromAtoms(parseProxyCondition("BR#3417 answered (status ≠ todo) with GO").atoms)).toEqual({ event: "br_answered", id: "BR#3417" });
    expect(awaitEventFromAtoms(parseProxyCondition("PR #2327 mergeCommit non-null").atoms)).toBeNull(); // no repo slug → unresolvable, stays text → ask migration
    expect(awaitEventFromAtoms([])).toBeNull(); // nothing machine-checkable → stays text → ask migration
    // multi-atom conjunctions are NOT single events — no silent partial reads
    const two = parseProxyCondition("PR #2327 merged; BR#3372 done");
    expect(awaitEventFromAtoms(two.atoms)).toBeNull();
  });

  it("describeAwaitEvent renders human-friendly annotation from the structure", () => {
    expect(describeAwaitEvent({ event: "pr_merged", repo: "state-vector/bridge", n: 84 })).toBe("PR state-vector/bridge#84 merged (mergeCommit non-null)");
    expect(describeAwaitEvent({ event: "br_answered", id: "BR#3417" })).toBe("BR#3417 answered (no longer open)");
    expect(describeAwaitEvent({ event: "ask", ask_id: "BR#3531" })).toBe("ask BR#3531 answered");
    expect(describeAwaitEvent({ event: "time", until_ts: 123 })).toBe("timer elapsed (until_ts 123)");
  });

  it("ask/time events map to no atom (they evaluate on their own, first-class)", () => {
    expect(awaitEventToAtom({ event: "ask", ask_id: "BR#1" })).toBeNull();
    expect(awaitEventToAtom({ event: "time", until_ts: 1 })).toBeNull();
    expect(awaitEventToAtom({ event: "pr_merged", repo: "a/b", n: 2 })?.kind).toBe("pr_merged");
    expect(awaitEventToAtom({ event: "br_answered", id: "BR#3417" })).toMatchObject({ kind: "br_answered", brId: "BR#3417" });
  });

  it("deployed: the one credential-free external atom — the hub against its own version stamp", () => {
    expect(validateAwaitEvent({ event: "deployed", commit: "34416e2" })).toEqual({ event: "deployed", commit: "34416e2" });
    expect(validateAwaitEvent({ event: "deployed", commit: "34416E2F0225AC1199191D07FB14D8D659290ABF" })).toEqual({ event: "deployed", commit: "34416e2f0225ac1199191d07fb14d8d659290abf" }); // normalized lowercase
    expect(validateAwaitEvent({ event: "deployed", commit: "nothex" })).toBeNull();
    expect(validateAwaitEvent({ event: "deployed", commit: "12345" })).toBeNull(); // < 7 hex
    expect(awaitEventToAtom({ event: "deployed", commit: "34416e2" })?.kind).toBe("deployed");
    expect(describeAwaitEvent({ event: "deployed", commit: "34416e2" })).toContain("hub worker is deployed at commit 34416e2");
    expect(awaitEventFromAtoms(awaitEventToAtom({ event: "deployed", commit: "34416e2" }) ? [{ kind: "deployed", repo: null, commit: "34416e2", raw: "x" }] : [])).toEqual({ event: "deployed", commit: "34416e2" });
  });

  it("deployedSatisfied: prefix match both ways, newer stamp satisfies an older pin, garbage never flips", () => {
    const full = "34416e2f0225ac1199191d07fb14d8d659290abf";
    expect(deployedSatisfied(full, "34416e2")).toBe(true); // pin prefix of stamp
    expect(deployedSatisfied("34416e2", full)).toBe(true); // wanted longer than known — still a match
    expect(deployedSatisfied(full, full)).toBe(true);
    expect(deployedSatisfied(full, "deadbee")).toBe(false);
    expect(deployedSatisfied("unknown", "34416e2")).toBe(false); // pre-build-hook stamp
    expect(deployedSatisfied(null, "34416e2")).toBe(false);
    expect(deployedSatisfied(full, "zzzzzzz")).toBe(false); // not hex → can never flip
  });
});

describe("parseProxyCondition ask/time atoms (BR#4062)", () => {
  it("the typed-await prose convention parses ask and time atoms", () => {
    const ask = parseProxyCondition("Machine proxy (typed await_event ask ask_id=BR#4061): the ruling gates re-entry.");
    expect(ask.unparseable).toBe(false);
    expect(ask.atoms).toEqual([expect.objectContaining({ kind: "ask", askId: "BR#4061" })]);

    const time = parseProxyCondition("Machine proxy (typed await_event time until_ts=1793673600000): re-entry at the timer.");
    expect(time.unparseable).toBe(false);
    expect(time.atoms).toEqual([expect.objectContaining({ kind: "time", untilTs: 1793673600000 })]);
  });

  it("typed-await prose naming a machine kind yields the SAME atom as the English phrase (one condition, deduped)", () => {
    const { atoms, unparseable } = parseProxyCondition(
      "Machine proxy (typed await_event pr_merged repo=state-vector/bridge n=253): PR https://github.com/state-vector/bridge/pull/253 merges (mergeCommit non-null) AND main CI green after.",
    );
    expect(unparseable).toBe(false);
    expect(atoms).toHaveLength(1);
    expect(atoms[0]).toMatchObject({ kind: "pr_merged", repo: "state-vector/bridge", number: 253 });
  });

  it("ISO until_ts normalizes to epoch ms (BR#3796's tripping hazard, prose leg)", () => {
    const { atoms, unparseable } = parseProxyCondition(
      "Machine proxy (typed await_event time until_ts=2026-11-04T00:00:00Z): re-entry at the render slot.",
    );
    expect(unparseable).toBe(false);
    expect(atoms).toEqual([expect.objectContaining({ kind: "time", untilTs: Date.parse("2026-11-04T00:00:00Z") })]);
  });

  it("grammar-naming prose that parses to nothing stamps UNPARSEABLE (never silently ignored)", () => {
    const bad = parseProxyCondition("Machine proxy (typed await_event vibes mood=good): not a closed-set atom.");
    expect(bad.unparseable).toBe(true);
    expect(bad.atoms).toHaveLength(0);
  });

  it("derived-annotation shapes re-derive: 'timer elapsed (until_ts N)' and 'ask BR#N answered'", () => {
    const t = parseProxyCondition("timer elapsed (until_ts 1793673600000)");
    expect(t.unparseable).toBe(false);
    expect(t.atoms).toEqual([expect.objectContaining({ kind: "time", untilTs: 1793673600000 })]);

    const a = parseProxyCondition("Ask BR#4061 answered");
    expect(a.unparseable).toBe(false);
    expect(a.atoms).toEqual([expect.objectContaining({ kind: "ask", askId: "BR#4061" })]);
  });

  it("awaitEventFromAtoms maps ask/time atoms to the typed events", () => {
    expect(awaitEventFromAtoms(parseProxyCondition("Machine proxy (typed await_event ask ask_id=BR#4061): x").atoms))
      .toEqual({ event: "ask", ask_id: "BR#4061" });
    expect(awaitEventFromAtoms(parseProxyCondition("Machine proxy (typed await_event time until_ts=1793673600000): x").atoms))
      .toEqual({ event: "time", until_ts: 1793673600000 });
  });
});
