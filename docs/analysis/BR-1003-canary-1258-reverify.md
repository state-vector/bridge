# BR#1003 — Re-verify: #qps GH#1258 product-surface canary (BR#50) — verdict: BOUNCED

Session: ses_ea8a34e06ffeWUhla93Ky50cS5 (fresh verification session, no part in the void rounds).
Receipts checked live via `gh` (authenticated as rayh) on 2026-10-20 ~03:0xZ. Every receipt below is a
GitHub PR/issue/run URL per BR#877.

## Why re-verify

Both prior verify rounds on BR#50 are disqualified:

- BR#860 (done) cited https://openrouter.ai/workspaces/default/guardrails as the "PR" — that is the
  OpenRouter guardrail error page, not a receipt; the dispatch it verified performed no work
  (0/9 endpoints, model blocked by guardrails).
- BR#872 (done) was closed by the gateway's own dispatch (session `dispatch-BR-872`, the same gateway
  that dispatched the parent) — self-verified, no independent receipts.

A `done` here would paper over an unmet closure gate, so the live state was checked directly.

## Closure gate (from the issue)

7 consecutive green canary DAYS on full `canary`-trigger runs (nightly 06:15Z full suite C1–C6, and
post-deploy full-suite jobs inside Deploy Dev). Hourly `deploy-train` runs are C6-only and do NOT bank
the streak (rayh's 2026-10-16 issue comment; workflow `product-canary.yml` modes).

## Live receipts

| Receipt | What it shows |
|---|---|
| https://github.com/state-vector/superpositional/issues/1258 | Issue OPEN (canary tracker) |
| https://github.com/state-vector/superpositional/actions/runs/39342522950 | Most recent FULL-SUITE canary (post-deploy job of Deploy Dev 2026-10-19T23:35Z, job log 2026-10-20T00:04Z): `🚨 canary concern recorded (6 failing check(s), requires_engineering=true)` — job conclusion `success` because post-deploy is detects-does-not-gate |
| https://github.com/state-vector/superpositional/actions/runs/39212602522 | Nightly full suite 2026-10-19T06:54Z: FAILURE — `🚨 canary concern (4 failing)`: C2.orphan_sample, C2.orphan_log_events, C3.a_pr_review_requeue, C3.b_supersession_fence |
| https://github.com/state-vector/superpositional/actions/runs/39105709468 | Nightly full suite 2026-10-18T06:54Z: FAILURE — day before the streak's earliest possible start |
| https://github.com/state-vector/superpositional/actions/runs/39361155981 | Latest scheduled run 2026-10-20T02:51Z: job success but log shows `MODE: deploy-train` — C6-only (deploy_lag/engine_warmth/alias_routing PASS). Does not bank the streak |
| https://github.com/state-vector/superpositional/pull/1994 | MERGED 2026-10-16T13:27Z — C1.file_band fix; confirmed green live (C1 all-green in the 00:04Z post-deploy log) |
| https://github.com/state-vector/superpositional/pull/2014 | MERGED 2026-10-17T06:28Z — C3 sub-entity chunking (#1255); C3 still red post-deploy |
| https://github.com/state-vector/superpositional/issues/1980 | OPEN — owner of C2.orphan_* reds |
| https://github.com/state-vector/superpositional/issues/1255 | OPEN — owner of C3.a/b/c reds |

## Findings

1. **Streak is 0/7 days.** The two most recent nightly full-suite runs (10-18, 10-19) failed, and the
   most recent full-suite result of any kind (post-deploy, 2026-10-20T00:04Z) recorded 6 failing checks.
   The 10-20 nightly (06:15Z cron) has not run yet. The closure gate has not merely not been met — the
   streak has not started.
2. **Latest full-suite red set (6):** C2.orphan_sample, C2.orphan_log_events (→ #1980, OPEN);
   C3.a_pr_review_requeue, C3.b_supersession_fence, C3.c_indexability_rules_home,
   C3.fabricated_symbol_rate (→ #1255, OPEN). Improvement vs 10-19 state-of-play (BR#868): C4 went
   green (both C4 checks PASS at 00:04Z), and C1 remains green live.
3. **False-green hazard confirmed live:** all scheduled product-canary runs visible on the Actions list
   since 10-19T12:56Z conclude `success` — but they are `MODE: deploy-train` C6-only runs. Any verifier
   reading job conclusion off that list would wrongly bank green days (this is exactly the false
   positive BR#868 predicted).
4. **BR#50's in_review status is not supported by receipts.** The handoff came from
   `dispatch-BR-50`/`dispatch-BR-872` (runner/self), and both earlier verify rounds are void.

## Verdict

BOUNCE: BR#50 → in_progress (not done). The canary is real work in progress: C1 green live (credit
#1994), deploy train unstalled (credit BR#568 verification), C4 newly green and ownerless no longer —
but C2 (→ #1980) and C3 (→ #1255) remain red, and 0 of the required 7 green days exist.
