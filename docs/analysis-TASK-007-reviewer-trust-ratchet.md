# TASK-007 analysis — Reviewer-trust ratchet: decomposition, coverage map, open questions

Session: `TASK-007-analysis-reviewer-trust` (role: analysis — decompose, don't build).
Date: 2026-10-20. Live GH-API checks cited below were run in this session.

## Premise corrections (live receipts, checked 2026-10-20)

The parent task body still frames two levers as open; they are landed:

| Lever (as written in TASK-007) | Live state | Receipt |
|---|---|---|
| 2. Guard prompt anti-fabrication, existence checks on all 9 remaining guards | **MERGED 2026-10-15** | PR #1875 "the EXISTENCE CHECK anti-fabrication section on the nine remaining guards (GH #1768)" |
| 4. Precision eval scenarios (PR #1896) | **MERGED 2026-10-16** | PR #1896 "clean-fixture FALSE-FLAG scenarios + precision floor (GH #1768)" |
| 5. Re-draw policy | MERGED ✓ (as stated) | PR #1816 |
| #1788 | **OPEN** | Issue #1788 "eval gate red on 2 confirmed systematic auto_fix fixture failures — blocks unrelated PRs (nova-micro, 0-flip)" |

Consequence: the remaining work on TASK-007 is **verification and receipt-collection**, not new implementation — plus two contested/contradicted landings that must be settled with code-level receipts.

## Coverage map of the six levers

1. **Guard model upgrade** — covered by TASK-008 (back in todo after a void-receipt bounce; BR#878 re-verify done) with analysis child BR#572 and impl child BR#847 (in_review: `review-guards.ts:86` pins `MODEL_ID = nova-micro` for every guard, so the nightly Guard Fixture Gate cannot observe the upgraded roster). **Contest to settle:** TASK-017 (in_review) says "main still has old models"; TASK-008's last note says failure-handling/readability/delivery landed on main via merged PRs #1913 + #1943. TASK-017 is the verification of record — do not fork.
2. **Guard prompt anti-fabrication** — landed (PR #1875 merged). Residual: no review child ever verified the section is present in all 9 guards on main → BR#922.
3. **Evidence assembly (enrich Exhausted degradation)** — TASK-011 marked done, but its body says "QUOTA-BLOCKED 2026-10-15, slice never ran" (quota reset 2026-10-20 08:38Z). Status/body contradiction; landing unproven → BR#922 item 2.
4. **Precision eval scenarios** — PR #1896 merged. TASK-009 `meta.remaining` carries the real residue: 3 confirmed Eval pairs outside the PR's diff-block merge, incl. a **roster decision** (data-lifecycle × nova-lite passes clean but misses janitor_unfenced recall; claude-haiku-4-5 passes all but is off-roster since #1863's anthropic bar). TASK-012's premise ("rebase PR #1896") is **stale** — see open questions.
5. **Re-draw policy** — done (PR #1816 merged).
6. **Trailing-30d trust view** — TASK-010 done (PRs #1908 + #1907, merged 2026-10-15). Measured honestly: trailing-30d == cumulative (16%) because the whole ~22-day ledger history fits inside the 30d window; the 230-record pre-fix cohort cannot age out before ~2026-10-23.

## Decomposition (children created, all `child_of` TASK-007, role:review, qualified)

- **BR#922 — Fix-stack landing receipts sweep.** (a) existence-check section present in all 9 guard prompts on origin/main; (b) TASK-011's enrichment-degraded caveat on main (resolve the done-vs-quota-blocked contradiction; if absent, bounce TASK-011); (c) first credentialed Guard Fixture Gate run post-OIDC fix, citing run id + which model actually drew.
- **BR#923 — Nightly corpus receipt.** 010b9703 / 5c68129a / 9940d21c each CLEAN (010b9703 needs a VALID draw — an MCP-deadline INVALID is not clean; redraw per merged #1816 policy); GH #1788 gate green on a clean redraw with per-fixture model attribution. Reds are legitimate results — record and bounce, never re-record to force green.
- **BR#924 — Trailing-30d > cumulative, dated checkpoint ~2026-10-23+.** PASS proves the fix stack works (parent AC); FAIL after the window can exclude the pre-fix cohort is an efficacy miss to bounce with both numbers.

No new impl child was created deliberately: lever 2 is merged, lever 1 is owned by TASK-008/BR#847/TASK-017, lever 4's residue is owned by TASK-009/TASK-012. Inventing an impl child here would fork live work.

## Open questions (for the owner / next sessions)

1. **Roster decision (blocks the "precision eval floor" AC).** data-lifecycle guard: nova-lite stable FALSE-FLAG 7/7 vs claude-haiku-4-5 clean-but-off-roster (anthropic barred from guard runtime, #1863) vs glm-4.7-flash (passes clean, misses janitor_unfenced recall). Recorded in TASK-009 `meta.remaining`; Ray's call. Not duplicated as an ask — it is already the publisher's open decision.
2. **TASK-009 / TASK-012 overlap.** TASK-012 ("rebase PR #1896 and fix the data-lifecycle model") — the rebase half is moot (#1896 merged 2026-10-16); its real residue is the data-lifecycle model/roster slice of TASK-009's `remaining`. Consolidation candidate: fold TASK-012 into TASK-009's remaining or retitle TASK-012 to "data-lifecycle roster fix" — owner's call.
3. **Model-landing contest.** TASK-017 (in_review) vs TASK-008's receipts — must be settled by live file inspection (`packages/agents/guards/*/agent.toml` on origin/main) before any fixture-gate receipt is interpreted. BR#847's merge unblocks interpretable gate runs.
4. **TASK-011 status integrity.** done + "slice never ran" in the same artefact — if BR#922 finds the caveat absent, TASK-011 must be bounced (reopen), not re-marked done.
5. **Dilution-curve framing.** The 16%→17%→16% plateau is arithmetic, not regression (post-fix cohort: fabricated halved 36%→16%; infra spiked to 41% in the deploy window). The ratchet proof is BR#924's dated checkpoint, not the nightly aggregate.

## What lifts the parent's gate

This document + the qualifying analysis child (role:analysis, transitioned done) record the plan and open questions. The parent's acceptance criteria map to children: AC1 + AC5 → BR#923; AC2 → BR#922 (c); AC3 → BR#924; AC4 → TASK-009/TASK-012 residue (roster decision).

## Verification round 1 (BR#927, 2026-10-20) — verdict BOUNCE, actioned

Independent verifier (session BR-927-verify-1) re-checked all receipts via GH API: decomposition **confirmed** (children exist, premise corrections re-verified live, PR contents match BR#925), but the parent was bounced to in_progress — **0/5 acceptance criteria met**, and closing now would mark the dilution-curve thesis "verified" without BR#924's dated measurement. Remaining path per the verdict: BR#922 + BR#923 receipts → AC4 roster decision → BR#924 checkpoint (~Oct 23+) → re-handoff.

### Actioned on this round

1. **PR #15 workers-build residual (verifier finding 6) — diagnosed as systemic, not ours.** `Workers Builds: bridge` FAILS on PR branches systemically: PR #11 and PR #14 (unrelated) show the identical rollup — `Test` SUCCESS + `Workers Builds: bridge` FAILURE — while `main`'s workers build is SUCCESS (sha 2323efd7). Docs-only PR; CI `Test` green. Merge decision unaffected by the check; coordinator may merge with this receipt.
2. **Children superseded by the bounce — re-issued.** The verify round's close auto-superseded BR#922, BR#923, BR#924 ("TASK-007 bounced — verification round closed"), killing receipt work in flight (BR#922 claimed-only; BR#924 mid-exploration). Re-issued as fresh children with the round-1 lesson baked into each body: **verify-class tasks close directly via done with receipts — an in_review transition is rejected by the gate** (BR#923's round-1 session died on exactly that rejection, BR#936 carries the unblock record).
3. **AC4 state tightened:** TASK-009 closed done with fresh verification (BR#926) — floor HOLDS: FPR 1/11 = 9.1% < 10% (gate slice 27 draws + full-matrix CI Eval); the "data-lifecycle model fix" premise was stale (already nova-lite at the PR base; the 2/11→1/11 gain came from #1912 prompt fixes). Residue: 3 confirmed Eval pairs outside the PR's diff-block merge, parked as Ray's roster/model decision. Decision ask filed (bound to TASK-007): which governs AC4's final disposition — the floor-holds verification, or the parked roster residue (which includes `deleted_prelock_write_clean × nova-lite` stable FFF 7/7, in tension with the 1/11 floor measurement).
4. **Nightly-corpus receipts in flight:** BR#936's session (mac-modem-opencode) was reading the Oct-19 nightly recordings for 010b9703 / 5c68129a / 9940d21c when the round closed; the fresh BR#923 re-issue is the receipt home for that evidence.
