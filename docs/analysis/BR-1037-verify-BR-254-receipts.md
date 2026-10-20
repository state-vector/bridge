# BR#1037 — Verify receipts for BR#254 (GH#1976 + GH#1977 eval infra batch)

Verify round: decision **BR#1081** (derived_from duty BR#1037), session `br-1037-verify-eval-batch`, 2026-10-20.
Verdict: **BOUNCE** (BR#254 → in_progress with findings).

## Why bounce (two independent grounds)

1. **Void handoff receipt.** BR#254's in_review handoff (bridge history seq 12652) cites
   `PR: https://openrouter.ai/workspaces/default/guardrails` — the OpenRouter guardrail settings URL,
   not a PR (BR#859/BR#900 void signature). The prior verify round **BR#851 is also void**:
   it was closed `done` (seq 9715) on a runner run that failed with
   `0 endpoints out of 9 requested are available … Model blocked by guardrail: 9 endpoints excluded`
   (exit 0, ~1m) — no verification occurred before this round. Child verify BR#1045 likewise
   "verified" BR#911 with the same guardrails-URL receipt while the code was uncommitted.

2. **Slice 1 (GH#1976) is not complete on main.** See below.

## Slice 2 — GH#1977: VERIFIED DONE (live `gh` receipts, 2026-10-20)

| Receipt | Value |
|---|---|
| PR | https://github.com/state-vector/superpositional/pull/2077 |
| State | **MERGED** — mergeCommit `5b11b1d50807b1525210630390609fb3b7f59f95`, mergedAt `2026-10-19T21:55:40Z`, base `main` |
| Review | APPROVED |
| Checks | 15 SUCCESS / 2 SKIPPED |
| Files | `packages/eval/fixtures/guard_planted_regression_silent_write_failure.toml` + `packages/eval/src/runner.rs` |
| Issue | #1977 **CLOSED** `2026-10-19T21:55:42Z` |

Work matches slice acceptance: planted real regression (PutVectors silent-swallow signature,
2026-07-25→08-07) classifies **systematic → exit 1**; boundary-variance case still degrades
(flood → DegradedVariance, exit 0); red-first observed (tests RED pre-fixture → GREEN 2/2 →
mutation kill proved the assertion live — impl session receipts, BR#254 history seq 9698/9558).
Zero open PRs referencing 1977.

## Slice 1 — GH#1976: NOT complete (live receipts, 2026-10-20)

- Issue #1976 **OPEN** (`closedAt: null`).
- 4 partial PRs, all **MERGED**:
  - #1985 — transport failures classify retryable; sweep concurrency (2026-10-16T12:31:48Z)
  - #1998 — infra-throttled outcome degrades instead of red-gating (2026-10-17T03:27:16Z)
  - #2071 — screening fixtures ordered by discriminating power (2026-10-19T21:22:02Z)
  - #2075 — judge output tokens bounded (2026-10-19T21:22:18Z)
- **Remaining acceptance lever has NO PR**: zero open PRs mentioning 1976 (live `gh pr list`).
  Branch `fix/1976-skip-unchanged-sweep` (skip-unchanged input-hash skip + vacuous-pass guard,
  impl child **BR#911**) sits at main HEAD `64b54c9d` with:
  - modified (uncommitted): `.github/workflows/ci.yml`, `.gitignore`, `packages/eval/src/main.rs`, `packages/eval/src/runner.rs`
  - untracked: `packages/eval/fixtures-smoke/`, `packages/eval/fixtures/eval_smoke_local.toml`
- Impl session `ses_ea872c509ffefmb5VzmhV5mn2p` is actively working it (claimed post-void-bounce, 75%).
- Therefore unevidenced on main: measured sweep-duration reduction, clean-main Eval green-or-caveat
  under induced throttling, vacuous-pass guard proof.

## Unblock condition (recorded on BR#254 + BR#1081)

BR#911 impl opens the real PR (red-first tests, measured duration delta, vacuous-pass guard evidence);
PR merges; a fresh verify round then judges Slice 1 acceptance live and closes BR#254.
