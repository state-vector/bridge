# BR#594 — Verdict-gate chronic reds: umbrella state + residual detection gaps (GH#1305)

Parent: BR#41 (GH#1305). Track A. Analysis-only: no implementation, no code edits, no parent closure.
Evidence collected live 2026-10-20 ~02:30–03:00 UTC from `gh` against `state-vector/superpositional`, Bridge knowledge search, and the worktree.

---

## 1. Umbrella state (live receipts)

GH#1305 is OPEN: "Verdict-gate chronic reds are lens/guard detection misses". Owner lane: R3 (lens/guard detection); the verdict-*derivation* questions (whether ungrounded/NotYetIndexed facets move a verdict, the medium→verdict boundary) belong to the companion R1 issue, not here.

### Chronic reds named by the umbrella (at issue creation)

| Scenario | Failure rate then | Expected / got | Detection facet evidence |
|---|---|---|---|
| `pydantic_silent_coercion` | 29/30 VG nights, 9/10 Daily (chronic since ≥09-08) | reject / concerns | Nothing above medium on `pydantic-core/src/validators/int.rs:85`; lenses emit `<ungrounded>:0` facets |
| `ghost_optimistic_catch_all` | 6/8 VG, 6/10 Daily | concerns or reject with `failure-handling` ≥ high / approve | `failure-handling` emits **no facet at all** on `ghost/core/core/server/api/endpoints/members.js:89`; run carries `ungrounded` caveat |
| `cal_n_plus_one` | 5/8 VG, 8/10 Daily | reject / concerns | Single grounded `ai-completeness:high`; query-in-loop not seen as perf high → GH#783 single-signal design; tracked as **#863** |
| `dogfood_search_relevance_filter` (FP) | 10/10 Daily | approve / concerns | `code-quality:high` on a serde-default fn (`packages/contracts/src/query.rs:38`) — false positive |

### Landed wins (each verified MERGED via `gh pr view`, 2026-10-20)

| PR | Merged | Covers |
|---|---|---|
| #1922 | 2026-10-15 | plan-1261 ceiling pins the dogfood org's real constraints (GH#1311) |
| #1923 | 2026-10-15 | log-presence anchoring + enrichment identity for called-mention entities → `ghost_secret_logging` + `ghost_fire_and_forget` |
| #2005 | 2026-10-17 | deterministic FACT detectors `detect_if_let_err_swallows` (Rust `if let Err` log-and-continue) + `detect_removed_lock_serialisation` (removed-lock) → `swallowed_error` + `hyperswitch_race_condition` |
| #2007 | 2026-10-17 | claim-verification refutations for the 5 fabricated clean-diff claims (catch-premise, `await?`-log, serde-default "backward compat", IaC-definition) — covers the `dogfood_search_relevance_filter` serde-default FP class |
| #2015 | 2026-10-17 | synthesis-degraded draw recorded-not-judged; text floors suspend on the degraded caveat (GH#2011) |
| (GH#863 lead) | landed earlier | `cal_n_plus_one` moved from ignored-false-negative to enforced nightly: "the query-in-loop structural LEAD gives the guards a deterministic handle on the N+1 pattern" (`packages/lambda-cortex/tests/review_quality.rs`, `cal_n_plus_one` decl comment) |

### Gate state right now

- Nightly `cortex-verdicts` run **39192638477 (2026-10-19 03:00Z) = FIRST GREEN** after failures on 10-14…10-18: **17/17 scenarios pass by majority of draws (2-of-3); 2/17 flipped between draws** — the flips are exactly `ghost_secret_logging` and `ghost_fire_and_forget` (FPP each: one draw gave the wrong verdict, majority recovered).
- On the green run, `pydantic_silent_coercion`, `ghost_optimistic_catch_all`, `cal_n_plus_one`, `hyperswitch_race_condition`, `swallowed_error`, `review_plan_1261_*` all drew PP (both draws correct).
- **Close gate (BR#552 runbook §3, binding):** #1305 closes when the verdict gate is green on the DEPLOYED fix for **2 consecutive nights**; a red night resets. Night #1 = 10-19. Night #2 = the 10-20 run (fires ~03:00Z; outcome unknown at analysis time).
- **Adjacent, do not conflate:** Quality Daily (`cortex-quality-daily`, run 39195985587, 10-19) is still red, but on a different family — `ask_golden_questions`, `diagnose_from_stack_trace`, `review_narrative_concern_promoted`, `review_spec_flawed_design_concerns`, `spec_direction_violated_*` (#1253 text-floor/narrative axis). None of the #1305 verdict scenarios appear there. Fixing #1305 residues will not turn Daily green and vice versa.

---

## 2. Residual detection gaps for Track A

**G1 — `pydantic_silent_coercion` pass is UNATTRIBUTED (top gap).**
No fix PR names it. The umbrella's detection-gap description (nothing above medium on the silent-coercion hunk; `<ungrounded>:0` lens facets) has no landed counter-fix in the artefacts. Yet it drew PP on 10-19. Candidate causes: guard model roster upgrade (#1913/#1943 family) raising facet quality, #1923's enrichment identity indirectly grounding the validators file, or plain draw variance after 29/30 chronic reds. Until attributed, we do not know whether the lens/guard gap is fixed or whether single-draw production reviews still miss the shape. There is still **no FACT-strength structural detector for silent type coercion/widening** analogous to the #2005 detectors.

**G2 — Ghost-family draw variance persists; `ghost_optimistic_catch_all` has no named fix.**
#1923 fixed `ghost_secret_logging` + `ghost_fire_and_forget`, yet both flipped (FPP) on the green 10-19 run — the only 2/17 flips. `ghost_optimistic_catch_all` (failure-handling emits no facet on members.js:89) has **no fix PR at all** and passed PP — variance risk. Two live fragilities observed on the same run amplify this: guard verdict JSON parse failures (`missing field 'principle_slug'` → error verdict → **no facet contribution** from `failure-handling`), and `GatherOperator zero_index_hits` warnings on ghost draws (retrieval miss surface). Note the gate is now majority-based, so a flipped draw is masked from the job conclusion even though production reviews are single-draw.

**G3 — hyperswitch-like shapes beyond the two landed detectors.**
#2005 covers exactly two shapes (Rust log-and-continue swallow; removed-lock serialisation). Sibling safety-guard-removal shapes — removed validation, removed feature-flag gating, retry-eats-error variants — have no detector. `hyperswitch_type_widening` and `hyperswitch_payment_state_bypass` pass today; "hyperswitch-like" residual risk is the *class*, not those two fixtures.

**G4 — `cal_n_plus_one`: covered by #863's structural lead; residual is a variance watch.**
The lead is landed (enforced nightly test) and it passed PP on 10-19. Do not fork new detection work here; #863 owns the pattern. Residual = confirm the lead holds post-deploy on consecutive nights.

**G5 — Raw guard tier fabrication is a measurement artifact (model-selection lever).**
Per BR#847 (receipts: `scripts/review-guards.ts:86` pins `MODEL_ID = "eu.amazon.nova-micro-v1:0"`, ignoring per-guard `agent.toml`), the Guard Fixture Gate drew all guards on Nova Micro; its 8 consecutive clean-fixture reds (Oct-14→19) are unrepresentative and "overlap GH#1305 family". The lever is the model upgrade (TASK-008 / BR#847 impl, in review), **not** new detectors in this umbrella.

---

## 3. Overlap map — existing open work implementation must not fork

| Artefact | Owner / status | Relation to #1305 | Constraint for impl children |
|---|---|---|---|
| BR#260 (Batch E) | MacBook-Pro, in_review | Delivered #2005/#2007/#2015 (all merged 10-17) | Do NOT re-touch `swallowed_error`, `hyperswitch_race_condition`, fixture-precision refutations, or synthesis-degraded suspension. Verify/close is in flight. |
| BR#598 (GH#1311 scenario-close path) | MacBook-Pro, in_progress | Owns verification of plan-1261 (#1922) closure | Children must not close or re-verify #1311; coordinate only. |
| BR#847 / TASK-008 / BR#572 | BR#847 in_review (verify bounced once: BR#848 found a guardrail-failed void run; BR#853 re-verified); TASK-008 todo | Guard-fixture MODEL_ID severance; model upgrade | Any child drawing guards via `scripts/review-guards.ts` must either wait for the severance fix or cite the unmerged state; no agent.toml edits, no re-selection from this umbrella. |
| GH#863 | tracked issue | `cal_n_plus_one` owner | Attach/watch there; no new N+1 detection work. |
| BR#552 (Release-Cluster Runbook) | MacBook-Pro, in_review | Authoritative #1305 close gate (2 green nights on deployed fix; red night resets) | Reference, don't re-spec; closure is coordinator's. |
| BR#67 (trust-metrics sanity agent) | active | Deploy-lag watch: merged fix stack may trail the deployed reviewer | Children must cite a deploy receipt, not merge state alone, when claiming "deployed". |
| TASK-007 (reviewer-trust ratchet) | MacBook-Pro, in_review | Model-upgrade levers overlap G5 | Model roster changes belong there. |
| BR#257 / BR#901 (batch E report + verify) | todo / done | Batch E reporting chain | #1305 `in-progress` label release on merge/close is the coordinator's move. |

---

## 4. Proposed children (checkable plan)

**A1 — Analysis child: attribute the 10-19 passes (pydantic + ghost) before any new detection impl.**
Done when:
- Downloads `verdict-draws.json` from run 39192638477 (artifact `verdict-draws`) and, for `pydantic_silent_coercion`, `ghost_secret_logging`, `ghost_fire_and_forget`, `ghost_optimistic_catch_all`, classifies each as **fix-attributed / draw-variance / still-open**, citing the causal mechanism at file:line (candidates: guard model roster, #1923 enrichment identity, #2005 detector side effects, JSON-parse error verdicts, `zero_index_hits`).
- Verifies whether the 10-19 run drew against the deployed fix stack (deploy receipt between the 10-17 merges and the 10-19 run); states which nightly is the true "night #1".
- Emits a go/no-go per child below.
Out of scope: no code changes, no gate changes, no issue closure.

**A2 — Impl child (gated on A1): silent type-coercion detector — only if pydantic classifies still-open.**
Acceptance criteria:
- New FACT-strength detector for silent coercion/widening shapes + `FACT_SIGNAL_KINDS` entry, mirroring the #2005 pattern (deterministic, structural, no threshold tuning, no floor changes).
- Red-first: fixture-shaped unit test fails before the detector exists; over-correction negative tests (legit narrowing, explicit validation, fix replays stay silent) green throughout.
- `cargo test -p lambda-cortex` lib suite green; live dev draw of `pydantic_silent_coercion` green; doc section (`cortex-pipeline.md` structural signals) updated in the same change.
- Explicit exclusions: no new fixtures for #863, no prompt rewrites, no guard tier changes (BR#847/TASK-008 own those).

**A3 — Impl child (gated on A1, but may proceed on existing evidence): ghost-family draw robustness.**
The 10-19 FPP flips are already evidence of instability; A1 only refines the fix layer. Acceptance criteria:
- If A1 blames the guard-JSON parse path (`missing field 'principle_slug'` → error verdict → silent `failure-handling`): make parse failures either repair (strict-then-lenient field recovery) or fail-loud-and-retry at the structural layer, with a red-first test on the exact malformed payload from the run log.
- If A1 blames retrieval (`zero_index_hits` on ghost draws): add the retrieval-guard handling per the existing operator-recoverable contract, red-first.
- Success measure: ≥6 consecutive live dev draws per ghost scenario (`ghost_secret_logging`, `ghost_fire_and_forget`, `ghost_optimistic_catch_all`) with zero wrong-verdict draws; no floor/threshold changes; nightly majority gate untouched.
- Exclusions: no new ghost fixtures beyond pinning the exact flip draw; no majority-gate redesign (that decision sits with the user per the #1252 triage note).

**A4 — Review child: #1305 close-gate audit (fresh session, receipts).**
Acceptance criteria:
- Fetch the 10-20 (and any later) nightly run(s): state, per-scenario lines, flips; verify the streak arithmetic against BR#552 §3 (red night resets).
- Cite the deploy receipt for the merged fix stack (#1922/#1923/#2005/#2007/#2015) before accepting "green on the DEPLOYED fix".
- Report only: does not close #1305 (coordinator), does not release the `in-progress` label, does not bounce merged work.
- If red: attach per-scenario receipts and the failing trace id so the next impl slice can start cold.

**Sequencing:** A1 → (A2 iff still-open) ∥ A3 → A4 last (it audits whatever is deployed by then).

---

## 5. Open questions blocking clean decomposition

- **Q1 — Attribution (G1).** Is pydantic's 10-19 2/2 pass a real fix effect or variance? Must A1 land before A2 spawns (recommended: yes — otherwise we risk "fixing" a non-defect or shipping a detector for a shape the model already covers).
- **Q2 — Deploy receipt.** Did the deployed reviewer include the 10-17 merge stack for the 10-19 run? If deploy lagged, tonight (10-20) is the true first close-gate night and the streak arithmetic shifts.
- **Q3 — Majority-gate semantics for closure.** The job now passes on 2-of-3 majority with flips masked (FPP). Does a green-with-flips night count as a green night for the #1305 close gate, or do flips reset it? This is a gate-definition decision (owner: user/coordinator per the #1252 triage); A4 cannot audit the streak until answered.
- **Q4 — #863 ownership state.** Is #863's structural lead merged and deployed? `cal_n_plus_one` passed on 10-19, but this session did not verify #863's merge/deploy state. A4 should pick this up incidentally.
- **Q5 — Tonight's run.** The 10-20 ~03:00Z run was outstanding at analysis time; every child must fetch fresh run state before acting on streak assumptions.

## Out of scope (restated)

No implementation, no PRs of code, no code edits, no closure of BR#41/GH#1305, no changes to the majority gate, no guard model roster changes, no Quality Daily (#1253) work.