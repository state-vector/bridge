# BR#41 — GH#1305 verdict gate: night-2 RED, streak reset + A1 attribution of record

Parent: BR#41 (GH#1305 umbrella, Track A) — replaces the void run recorded by decision BR#990
(guardrail-failed dispatch: 0/9 endpoints, no PR, no findings). This session performs the
**A1 attribution** and the **A4-style close-gate audit** from the BR#594 child plan
(`docs/BR-594-verdict-gate-chronic-reds-and-residual-gaps.md`), with live `gh` receipts
collected 2026-10-20. No superpositional code was edited (code lives in
`state-vector/superpositional`; this worktree is the receipt vehicle).

---

## 1. Nightly verdict receipts (live)

| Night | Run | Result | Detail |
|---|---|---|---|
| #1 | 39192638477 (2026-10-19 03:00Z, `main @ 8862bcce5`) | success | 17/17 pass by majority; **2 flips** (`ghost_secret_logging`, `ghost_fire_and_forget`, both FPP); **3 guard-verdict parse failures** in the log |
| #2 | 39362021328 (2026-10-20 03:00Z, `main @ c0a2e958e`) | **failure** | **16/17 pass; `ghost_secret_logging` FF (both draws wrong)**; flips 0 |

`verdict-draws.json` from run 39362021328 (artifact `verdict-draws`, policy 2-of-3, expected 17):

```json
{"policy":"2-of-3","expected":17,"flips":0,"scenarios":[
 {"scenario":"cal_n_plus_one","draws":"PP","verdict":"pass"},
 {"scenario":"security_auth_bypass","draws":"PP","verdict":"pass"},
 {"scenario":"php_sql_injection","draws":"PP","verdict":"pass"},
 {"scenario":"php_session_fixation","draws":"PP","verdict":"pass"},
 {"scenario":"ghost_secret_logging","draws":"FF","verdict":"fail"},
 {"scenario":"swallowed_error","draws":"PP","verdict":"pass"},
 {"scenario":"ghost_fire_and_forget","draws":"PP","verdict":"pass"},
 {"scenario":"ghost_optimistic_catch_all","draws":"PP","verdict":"pass"},
 {"scenario":"cross_boundary_break","draws":"PP","verdict":"pass"},
 {"scenario":"review_cross_boundary_break_cites_seeded_direction","draws":"PP","verdict":"pass"},
 {"scenario":"phantom_parquet_stub","draws":"PP","verdict":"pass"},
 {"scenario":"hyperswitch_payment_state_bypass","draws":"PP","verdict":"pass"},
 {"scenario":"hyperswitch_race_condition","draws":"PP","verdict":"pass"},
 {"scenario":"hyperswitch_type_widening","draws":"PP","verdict":"pass"},
 {"scenario":"pydantic_silent_coercion","draws":"PP","verdict":"pass"},
 {"scenario":"review_plan_1261_destructive_reindex_never_approves","draws":"PP","verdict":"pass"},
 {"scenario":"review_plan_compliant_reindex_clears_the_standards","draws":"PP","verdict":"pass"}]}
```

Job summary line (10-20): `review_quality verdicts: 16 pass, 1 fail by majority of draws;
0/17 flipped between draws 1 and 2` → `❌ 1 verdict scenario(s) failed the majority of their draws.`

## 2. Deploy receipts (answers BR#594 Q2 for night #2)

- Run 39362021328 head: `main @ c0a2e958e7c83366438e3698fff8e61f91c3a433` (event `schedule`).
- Dev deployment **7190387232** created `2026-10-20T03:00:54Z` with sha `c0a2e958e` — the
  deployed reviewer SHA **equals the run head SHA** at run start.
- Fix-stack containment: #1922 (`0881fd7cd`), #1923 (`1dbaeb9b2`), #2005 (`f7992d670`),
  #2007 (`d3f312862`), #2015 (`3f0b8c59e`) all **MERGED** (2026-10-15/10-17), i.e. ancestors of
  `main @ c0a2e958e` by merge date (10-15/10-17 < 10-20 head). Live re-check 2026-10-20 via
  `gh pr view` — all five `MERGED`.
- Conclusion: **night #2 drew against the deployed fix stack.** The red night is real, not deploy lag.

## 3. A1 attribution (per-scenario classification)

| Scenario | 10-19 | 10-20 | Classification | Basis |
|---|---|---|---|---|
| `pydantic_silent_coercion` | PP | PP | **passing-unattributed; A2 = no-go** | 2/2 draws correct on two consecutive nights; per BR#594's gate, A2 spawns only if "still-open" — draw evidence does not meet that bar. Residual (single-draw production reviews) stays a variance watch; no named structural fix yet. |
| `ghost_secret_logging` | FPP | **FF** | **chronic — root cause pinned (below)** | Only failing scenario on night #2; failure evidence identical across nights. |
| `ghost_fire_and_forget` | FPP | PP | recovering — variance watch | Flip on night #1, clean on night #2. |
| `ghost_optimistic_catch_all` | PP | PP | clean — watch only | No named fix PR; holds 4/4 draws across both nights. |
| `hyperswitch_*`, `swallowed_error`, plan-1261, `cal_n_plus_one` | PP | PP | fix-attributed / stable | #2005, #1922, #863-lead all contained in both run SHAs. |

## 4. Root cause of the night-2 red (receipt-grade)

Draw 2 of `ghost_secret_logging`, run 39362021328, job "Review verdict scenarios (13)":

```
2026-10-20T03:12:40.592930Z  WARN lambda_cortex::guards: Failed to parse guard verdict JSON — returning error verdict guard_id=failure-handling error=missing field `principle_slug` at line 1 column 65 response_len=82
thread 'ghost_secret_logging' (6871) panicked at packages/lambda-cortex/tests/review_quality.rs:871:5
  🔗 Grounding: 0/1 claims grounded against 74 evidence nodes | verdict: Unverifiable | ungrounded: ["pre_operation"]
```

The **same** parse failure fired **3× on the 10-19 "green" run** (03:05:51Z `response_len=70`,
03:09:53Z and 03:14:48Z `response_len=82`, all `guard_id=failure-handling`,
`missing field 'principle_slug' at line 1 column 65`). Failure chain:

1. `failure-handling` guard returns a compact JSON verdict (~70–82 bytes) **without the required
   `principle_slug` field** (line 1 col 65).
2. Strict parse fails → guards layer emits an **error verdict** (`lambda_cortex::guards` WARN),
   so the guard contributes **no facet**.
3. With `failure-handling` silent, the draw's verdict collapses to `Unverifiable`
   (claim `pre_operation` ungrounded, 0/1 vs 74 nodes) — the wrong verdict for this scenario.
4. Night #1 survived via majority masking (FPP); night #2 the loss hit both draws (FF) → job red.

Corroborating structural signal from the same 10-20 build: `warning: function is_principle_slug
is never used` (`packages/lambda-cortex/...:1247`) — a slug-validation helper exists in the tree
but is **unwired**, consistent with the strict-parse path not attempting field recovery.

This confirms BR#594 **A3 branch 1** on live evidence (the plan allowed A3 to proceed on
existing evidence; the 10-20 run upgraded it from hypothesis to receipt).

## 5. Close-gate state (BR#552 §3, binding)

- Streak: night #1 (10-19) green → **night #2 (10-20) RED → streak RESET**. A red night resets;
  there is no 2-consecutive-green state today. Next candidate night #1 = the 10-21 ~03:00Z run.
- **Q3 remains open and material**: the 10-19 "green" carried 2 flipped draws and 3 silent
  guard-parse losses. Under a strict reading (any wrong draw or silent facet loss = not a clean
  night) even night #1 was not clean. This is a gate-definition decision owned by the
  user/coordinator per the #1252 triage note — A4 cannot certify a streak until answered.

## 6. Go/no-go + pinned impl spec for the follow-on child

- **A2 (silent type-coercion detector): NO-GO** — `pydantic_silent_coercion` PP/PP on both
  nights; not "still-open" per the BR#594 gate. Re-open only if a future night draws it wrong.
- **A3 (ghost-family draw robustness): GO — parse-repair branch, spec now fully pinned:**
  - Exact malformed payload class: guard response ~70–82 bytes, JSON valid, **missing required
    field `principle_slug`** (error at line 1 column 65), `guard_id=failure-handling`.
  - Fix shape (per BR#594 A3 AC): strict-then-lenient field recovery (derive/default the slug
    from the verdict title — the existing but unwired `is_principle_slug` helper at
    `guards.rs:1247` is the candidate) **or** fail-loud-and-retry at the structural layer;
    red-first test on the exact malformed payload from the run log.
  - Success measure: ≥6 consecutive clean draws per ghost scenario; no floor/threshold changes;
    majority gate untouched; no new fixtures beyond pinning the flip payload.
  - Venue: `state-vector/superpositional` (`packages/lambda-cortex/src/guards.rs` + test in
    `packages/lambda-cortex/tests/review_quality.rs`), fresh session/worktree — **not this one**.
- **A4 (close-gate audit): partially executed here** (10-20 night audited with deploy receipt);
  the 10-21+ streak audit remains for a fresh review session after Q3 is answered.

## 7. Exclusions / coordination (unchanged from BR#594 §3)

No new detection work for `cal_n_plus_one` (#863), no guard model roster changes (BR#847 /
TASK-008), no majority-gate redesign (#1252, user), no Quality Daily (#1253) work, no issue
closure from here (coordinator owns #1305 closure + `in-progress` label release).

---

*Session `ses_ea8b3e98bffehkqy39g9CEeBb2`, agent `opencode-ray`, 2026-10-20. All receipts
re-collected live this session via `gh` against `state-vector/superpositional`; scratch
artifacts (`verdict-draws.json` both nights) archived untracked and removed from the branch.*
