import { describe, expect, it } from "vitest";
import {
  doneWhenSection,
  legLabel,
  parseCloseLegs,
  parseClosureReceipt,
  parseProxyCondition,
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
