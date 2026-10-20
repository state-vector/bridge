# BR#430 — TASK-001 analysis child: OSS-eval open-world plan and residuals (analysis of record, 2026-10-20)

Session lineage: `TASK-001-analysis` (original 2026-10-15) → `TASK-001-oss-eval-analysis` (refresh + receipts re-verification, 2026-10-20) → `BR-430-analysis-refresh` (this session: live board deltas re-verified, record committed). Role: analysis throughout; verification duty is BR#469 (fresh role:review session).

This document is the repo-side record of the refreshed analysis. The live version of record is the BR#430 artefact body; this file exists so the verifier has repo-side receipts (the prior verify round BR#469 bounced for want of repo-side evidence).

## Deltas verified live on the board this session (2026-10-20, after the morning refresh)

| Artefact | Refresh body said | Live state this session |
|---|---|---|
| BR#932 (cron re-arm, AC3) | open impl child, todo | **in_review** — impl handed off, PR [superpositional#2082](https://github.com/state-vector/superpositional/pull/2082) open |
| BR#933 (Datadog heartbeat + OssEvalStateTable) | open impl child, todo | **in_review** — impl handed off complete |
| BR#136 (#1958 oracle + real source:oss judgement) | open blocker, owned | **in_review** — but its verify child BR#913 is a void runner self-close (see integrity findings); fix remains real open work |
| BR#247 (#2010 base index) | open blocker, owned | **in_review** — acceptance 3+4 open per its own resolution note; verify child BR#906 void (same class) |

Net: every downstream slice now exists as concrete work parked in review. No plan gap remains; the path to parent closure is unchanged in order, only advanced in status.

## Current state of the parent TASK-001 (receipts re-verified 2026-10-20)

**Done and receipted — no action needed:**
- Harness merged (PR #1787); machinery proven live: oss-eval-dev SFN SUCCEEDED through all 9 states with overlay + blind review_diff live (BR#132).
- Launch-critical findings fixed+deployed: **#1868 CLOSED** (requeue_count + burned-name fa0dcac60, full base-index input shape 38fc2ce10, DescribeExecution grant, IAM grant — BR#140/BR#179/BR#185), #1869 (infra-refusal degradation), **#1870 CLOSED** (PR #1946 merged b5db6e6c, decision BR#181 accepted).
- **#1905 (dev deploy break) CLOSED** — deploys green.
- **BR#304 stand-down: all four re-arm conditions verified HOLDING** (BR#247 pre-flight 2026-10-20): PR #2027 (back-off + Checks-capable pr-flow probe) MERGED 2026-10-19; completion queues sharded 0-9; embedding queues drained 0/0; dev smoke green on the post-BR#232 build 5b11b1d50 (#2016 heartbeat + #2031 per-slot fallback).
- Cron stack merged (d687ed237); EventBridge rule `OssEvalSchedule-3d304cb` still operationally DISABLED (deliberate — re-arm is decomposed to BR#932, now in review as PR #2082).
- Harness registered as quality-mechanism #10 in docs/quality-mechanisms.md (BR#110, commit 71890c956).

**Open blockers (owned — do NOT fork):**
1. **#1958 (oracle judges-0)** — owned by BR#136 (in_review, void verify). Temperature fix pushed (fa0dcac60); remaining: parseJudgeResponse vs real sonnet output, judged/skipped-reason accounting in run output, readable Oracle logs.
2. **#2010 (eval base index)** — root cause SETTLED as the embedding-barrier class (BR#247 resolution note; BR#232 fix verified via BR#705; re-diagnosed from "zero entities" to #1078/#1979 — BR#248). Remaining is OPERATIONAL: wikimedia base-index re-run LAUNCHED 2026-10-20 on the post-BR#232 build (execution `oss-base-85e7460a-wikimedia-apps-android-wikipedia-1a1567a4d2a`, 10:23 local, exact reconcile input shape); **serde-rs/serde base index already SUCCEEDED** (BR#264) as fallback corpus.
3. **Real source:oss judgement** (BR#136 AC4 = parent AC1/AC2/AC4): serde-scoped demo was RUNNING (BR#264); re-run outcome not yet on the board. When the ledger row + Datadog series land, AC1/AC2/AC4 are receipt-satisfied.

## Integrity findings for the verifier (BR#877 void-receipt / BR#900 runner-integrity class; cf. BR#875 + BR#852 meta-findings)

- **BR#136's in_review handoff is a runner artifact**: its dispatch run ERRORED ("Error: 0 endpoints out of 9 requested… Model blocked by guardrail" — zero model calls executed) and its verify child BR#913 was created + closed done by the same runner within 7 seconds with NO receipts. BR#136 must NOT be treated as verified; the #1958 fix remains real open work.
- Same artifact on BR#247's verify child BR#906 (7-second runner self-close, no receipts). BR#247's real state: acceptance 3+4 OPEN per its own resolution note.
- Corollary for BR#469 and the parent's next verify round: check actual GH/ledger/Datadog state and cite receipts; runner self-closes and exit-0-with-error dispatches are non-evidence.

## Remaining path to parent closure (ordered)

1. **BR#247**: base index SUCCEEDED for an eval repo (wikimedia re-run polling; serde fallback) — operational, no code. *Now in_review.*
2. **BR#136**: #1958 oracle fix + real source:oss ledger row + Datadog series → AC1/AC2/AC4 receipts. *Now in_review (void verify; work not done).*
3. **BR#932**: deploy-safe re-arm + one scheduled run SUCCEEDED with all five invariants → AC3 receipt. *Now in_review as PR #2082.*
4. **BR#933**: heartbeat monitor + state-table hygiene → AC2/AC3 durability. *Now in_review.*
5. Fresh verification with REAL receipts: BR#469 (this child's verify) + a new auto-spawned Verify at the parent's in_review. The BR#737 parent-verify round was superseded (bounce) — the next one must check actual GH/ledger/Datadog state, not runner self-closes.

## Open questions

- **Re-arm timing** (owner decision, BR#304 directive): conditions hold, but re-arm only AFTER the real judgement exists — else the cron burns daily judged:0 runs. Flagged in BR#932's coordination section.
- If the wikimedia re-run dies at WaitForEmbeddings again → escalate on BR#232's verified fix (re-open #1979), do not fork a second barrier fix; if it yields a REAL zero-entity failure (Kotlin coverage), BR#247's resolution note prescribes the fallback (covered TS/Rust repo + coverage-gap follow-on).
- Heartbeat monitor threshold (26–48h window) — BR#933 picks the nominal value in its PR.

## Readiness

- **Parent is ready for impl pickup** on the operational path: both blocker tasks are actively owned and receipt-tracked, and every previously-uncovered slice is now a concrete child (BR#932, BR#933 — both now in review). No plan gap remains; the only unknowns are live-run outcomes (BR#247/BR#136 receipts pending).
- This child (role:analysis) qualifies the parent when done; verification via BR#469.

## Ownership map (do NOT fork)

- #1958 fix → BR#136; base-index drive + first judgement → BR#247/BR#136; eval-precision follow-ups (#1976/#1977) → BR#254; judge-latency → #2066 (done, PR #2075).
- Deferred v1.1 (separate backlog, NOT children here): convergence-as-a-metric; OpenHands + git-connector three-layer refactor.

## Out of scope (unchanged from the original contract)

No code changes; no oracle/base-index/cron fixes; no parent closure. The only repo-side artifact is this analysis record document (the delivery contract requires a commit + PR so the verifier has repo-side evidence).
