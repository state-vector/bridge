# Verification record for BR#432

Verify-only receipt: final state of GH#1260 checked against knowledge and Bridge artefacts; gate condition stated; GitHub-vs-Bridge mismatches called out. No implementation, no repo edits beyond this record, no merge/close action. Session: `br432-verify-gh1260-receipts`, 2026-10-20.

## 1. Final state of GH#1260 (live, checked 2026-10-20)

- Issue state: **OPEN**, `stateReason: REOPENED`, `closedAt: null`, labels CRITICAL / gtm-blocker / worker:opencode-ray / issue:quality. Timeline: **closed 2026-10-14T07:56:56Z, reopened 2026-10-14T09:32:14Z** (both by detached-cody). Last issue activity: coordinator comment 2026-10-17T03:22:15Z — no comments since.
- Newest nightly battery: **Cortex Bug Corpus run 39191396217 (2026-10-19T02:44Z, failure)**: `caught-before-merge: 14/19 · precision: 53/56 · invalid: 2 · infra_error 0 · below_floor=false` — `BUG_CORPUS_RESULT caught=14 must_flag=19 clean=53 must_not_flag=56 invalid=2 below_floor=false`; run ends `❌ go-to-market gate not met: caught 14/19, clean 53/56 (GH #1260)`. Invalids: `6faf19e2-run-view-additive-scope` (MCP-deadline partial response) and `issue-1869-no-base-index` (credit-balance-exhausted infra error).
- Merged receipts confirmed live: **PR #1910 MERGED 2026-10-15T13:34:20Z** (`.keep` harness fix — matches BR#69/BR#42 knowledge); **PR #2076 MERGED 2026-10-19T15:45:08Z** (#1963/#1969 corpus entries — matches BR#781). Corollary: the newest nightly **predates** #2076 and the deploy-train unstall (Deploy Dev green 2026-10-19T21:22Z), so no nightly has yet scored the post-#2076 corpus.

## 2. Gate condition for closing or continuing (citations)

- Two deliberately distinct bars per the coordinator comment on GH#1260 (2026-10-17T03:22:15Z): **floors** = regression ratchet (caught ≥9, clean ≥26-ish, `below_floor=false`) — currently **held** (14 caught, 53 clean); **GTM gate** = this issue's close bar, **100% of the corpus caught with zero false flags**, asserted by the designed `gate_met` check (bug_corpus.rs:2314; also run 38672339217's 2026-10-15 red, per the PR #1910 claim comment).
- Gate is corpus-relative: the bar quoted as 16/16 + 47/47 on 2026-10-17 is now 19/19 + 56/56 (entries added via merged PRs #1946/#2076), and stays open-ended until `gate_met` passes on a then-current nightly.
- Close condition: a nightly run where `gate_met` passes (all must_flag CAUGHT, all must_not_flag CLEAN, no invalid blocking draws) with every new miss filed to the stage the run names. Until then: **continue** — the correct Bridge state is open/in-review, never closed.
- Continue condition is active today: newest nightly says "gate not met" verbatim; floors held.

## 3. GitHub vs Bridge mismatches (called out)

1. **BR#42's in_review verdict is void (rule 5b).** Its in_progress → in_review handoff (history seq 9792) was produced by a **failed dispatch**: "Error: 0 endpoints out of 9 requested … Model blocked by guardrail" — yet recorded as "exit 0, ~1m". Its verify child **BR#859 was closed done 64 seconds after spawn** with the guardrails URL as the PR receipt and no receipts in the note. This is the exact void-verification pattern voided for BR#855 in the BR#44 chain (decision BR#867) and tracked as a runner defect in BR#900. → **BR#42 has no valid review acceptance**; it must be re-verified by a real fresh session before any done.
2. **Verify-of-verify churn on BR#432's own chain:** verify children BR#471 and BR#472 are `done` with receipt-less notes ("runner: handed off to done — complete") while BR#432 itself went in_review → blocked → todo and was re-dispatched (its earlier done-handoff was gate-rejected: "parent BR#432 still has 1 open child task(s)"). The done verify children do not match the open parent state.
3. **Cited diagnosis file is not on main:** BR#42's qualified_note cites `.agents/tasks/corpus-gap-1260-diagnosis.md` — confirmed **404 on main** (GH contents API). The diagnosis lives in Bridge knowledge only, as BR#42's last progress note already suspected.
4. **Consistent (no action):** GH#1260 OPEN vs BR#42 in_review agree in direction — both stay open while the gate is unmet; the last real verification round on BR#432 (history seq 1473–1475: "battery still intentionally gate-held, PR #1910 merged, continue not close") remains correct and is strengthened by the newer 14/19 + 53/56 nightly.

## Verdict

**Continue, not close.** GH#1260 stays OPEN and BR#42 stays un-accepted (in_review with a void verify verdict) until a nightly `gate_met` pass; receipt quality on the verify chain (BR#859/BR#471/BR#472) is the process gap to fix (BR#900).
