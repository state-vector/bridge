# BR#50 — GH#1258 product-surface canary: state of play

Issue: https://github.com/state-vector/superpositional/issues/1258 (OPEN)
Task: BR#50 · Epic: BR#24 (#qps GTM) · Analysis child: BR#433 (done)
Labels: CRITICAL, gtm-blocker, issue:quality, issue:stability — Track B

Durable record of the canary's live state and the path to its close condition.
This note was first drafted 2026-10-19 (BR#868) but its commit was blocked by an
SSH-signing outage (BR#869); the staging worktree was reset before it landed.
Recovered and re-verified live 2026-10-20T13:2xZ (session br50-canary-impl).

## Canary design as shipped (receipts: product-canary.yml @ superpositional main)

Two triggers (quality-assurance.md #2 — an assertion nothing triggers is not a check):

- **nightly** cron `15 6 * * *` (06:15 UTC) — full suite (C1–C6), ledger trigger
  `nightly`; a quiet week of no deploys still measures the stack.
- **post-deploy** job inside every Deploy Dev run (`needs: [deploy]`,
  `mode: post-deploy`) — full suite; **detects-does-not-gate**: a product red is
  recorded to the ledger + `product_surface_canary` reliability signal but does
  not fail the deploy run (an expected-red canary would drown real deploy
  failures). A canary that could not run (exit 2) always fails, in every mode.
- **hourly** cron `40 * * * *` — **deploy-train mode, C6 alone** (GH#1416): is dev
  running main? Separate ledger trigger `deploy-train`. These runs do NOT bank
  the 7-day streak; a red C6 job IS the stalled train.

## Live status — 2026-10-20T13:16Z (freshest full suite)

Freshest full-suite run: post-deploy canary inside Deploy Dev
https://github.com/state-vector/superpositional/actions/runs/39424469279
(job 118644352584, executed 13:07–13:16Z on head ee1edbb9e).

**RED — 13 pass · 6 fail · 0 unknown** — concern recorded
(`requires_engineering=true`):

| Check | State | Note |
| --- | --- | --- |
| C1 ×9 (file_band, entity_density, entity_ratchet, index_health, durable.events/work_orders/knowledge, repo_status, indexing_liveness) | ✅ green | file_band now uses the ingestable-tracked formula (floor 0.9 × 1878 ingestable-tracked, ceiling 1 × 4537 raw tracked) — **PR #1994 fix confirmed live**; ratchet ≥ 45362 |
| C2.search_hydration | ✅ green | |
| C2.orphan_sample | ❌ red | sampled orphan ratio > 0.1 → **GH#1980** |
| C2.orphan_log_events | ❌ red | > 0 matching log events in 26h → **GH#1980** |
| C3.a_pr_review_requeue | ❌ red | 0/3 draws; answers ground to real sources (sp_indexing.rs, dispatch.ts, repo resolvers) but none surface the required requeue-budget evidence token → **GH#1255** |
| C3.b_supersession_fence | ❌ red | 0/3; missing supersession symbol evidence; one draw fabricated `build_build` (rate 0.024) → **GH#1255** |
| C3.c_indexability_rules_home | ❌ red | 1/3; one draw fabricated `/.yarn/releases/yarn-4.12.0.cjs` (rate 0.026) → **GH#1255** (flappy — passed on the 06:41Z nightly) |
| C3.fabricated_symbol_rate | ❌ red | 2 fabricated of 374 checked (rate 0.005) → **GH#1255** |
| C4.80ea2e3e_rubric_wording | ✅ green | verdict=concerns, diff_content_grounding caveat, no problems (was unowned/red on 10-19) |
| C4.fa0c6e4f_tests_only | ✅ green | |
| C5.ledger_publish | ✅ green | |

Nightly full suite 2026-10-20T06:41Z
(https://github.com/state-vector/superpositional/actions/runs/39381877508):
**failure** — 5 fails (C2×2, C3.a, C3.b, C3.fabricated_symbol_rate). Hourly
deploy-train runs: green through 12:55Z (run 39426048585) — deploy train
**unstalled** (was the sole red on 10-18, per BR#567/BR#568).

## Streak accounting (close condition: 7 consecutive green DAYS on full-suite runs)

2026-10-18 all-red; 2026-10-19 nightly RED; 2026-10-20 nightly + post-deploy RED.
**Days banked: 0/7 — the streak has not started.** Any run reading green off the
hourly Actions list (C6-only) is a false positive; the gate is the ledger
`nightly`/`post-deploy` trigger records.

## Why the streak cannot start yet — residual reds and their owner lanes

- **C2.orphan_\*** → **GH#1980** (OPEN, 10-17): purge of the #1250-tail
  unattributable dev vectors. Root cause family: GH#1474 / BR#55 / BR#560.
  Execution gated on operator GO (runbook BR#255). Owner lane owns it.
- **C3.\*** (4 checks) → **GH#1255** (OPEN, touched 10-20): ask-path quality on
  healthy index; fix lane BR#32 (#qps GH#1255) in progress. PR #2014 (sub-entity
  chunking) is merged AND deployed, yet C3.a/b are red on every post-fix deploy
  — the red is not absence-of-deploy.

Open question recorded for the C3 lane (BR#868, still open): does the dogfood
index need a re-index for re-chunked entities to reflect before judging the
#2014 fix insufficient? Coordination ask filed to the BR#32 owner session.

C4 ownership is resolved live (both goldens green — no follow-up needed).

## Task mechanics (for the verifier reading this)

BR#50's close condition (7-day green streak) is time-gated and cannot be met in
any single session while #1980 and #1255 are open. Session deliverables are:
live-verified state-of-play (this note, on a merged PR) + accurate streak
accounting. The honest task status between streak days is **blocked** with the
unblock condition below — not repeated in_review rounds that a verifier must
bounce on the streak gate.

Unblock condition (BR#50): GH#1980 and GH#1255 both CLOSED with their fixes
deployed to dev, then the next full-suite `nightly`/`post-deploy` canary run
green → the 7-day ledger streak starts; a fresh role:review session closes
BR#50 done citing the 7 green ledger records.

## Overlap map (updated 10-20)

- C2.orphan_\* ↔ GH#1980 (purge, operator-gated) / GH#1474 (root cause) / BR#55, BR#560.
- C3.\* ↔ GH#1255 / BR#32 (impl lane).
- C4 ↔ GH#1850 / BR#26 family — now green live.
- BR#24 (#qps epic): #1258's remaining gates = #1980 (C2), #1255 (C3), then the clean 7-day ledger streak.
