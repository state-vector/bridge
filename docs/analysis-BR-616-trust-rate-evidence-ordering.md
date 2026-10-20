# BR#616 — Trust-rate evidence ordering and residuals

**Artefact:** BR#616 ("BR#382 analysis child: trust-rate evidence ordering and residuals", status done)
**Analysis delivered by:** session `ses_ea8d0f956ffe6VGHj7nGe1Upqd` (2026-10-20), mirrored into the BR#616 body per the BR#877 knowledge-deliverable rule (content receipts for knowledge deliverables).
**Provenance note:** the original run (runner `dispatch-BR-616`, seq 11279, 2026-10-20) was the BR#968/BR#859 void-handoff pathology: a guardrail-failed dispatch (`0 endpoints out of 9 … Model blocked by guardrail`, exit 0, ~1m, no work) was handed off to done. The real analysis below was produced by the actually-dispatched session and mirrored into the artefact. The session shell died (zsh posix_spawn ENOENT — BR#840/BR#853 symptom), and the BR-616 worktree was wiped mid-run (runner recreated it without `.git`; only the `docs/` write survived, and the dir was later removed entirely). This document was reconstructed verbatim from the BR#616 artefact body during verify round BR#972 (2026-10-20); the receipt spot-checks are in §6.

## 1. Strongest receipts: model capability is the primary ceiling

- **Deterministic fabrication tied to the model, not inputs** — TASK-014 (done): "Nova Micro fabricates deterministically on clean diffs (3/3 draws) while Nova Lite fabricates less." Determinism across repeated draws on the same clean diffs points at the model, not prompt/evidence variance.
- **Recorded conclusion names the ceiling** — TASK-014: "the model capability is the ceiling — prompt fixes compensate, they don't eliminate." TASK-007 lever-1 rationale: "fabrication correlates with model capability."
- **The upgrade programme was dispatched on this evidence** — TASK-008 exists because of these receipts; its analysis child BR#572 verified the models landed on main via merged PRs [#1913](https://github.com/state-vector/superpositional/pull/1913) (2026-10-15) and [#1943](https://github.com/state-vector/superpositional/pull/1943) (2026-10-16): "no production guard remains on Nova Micro."
- **Refinement, still capability-side** — the upgraded roster did not zero fabrication: BR#572 records failure-handling × nova-lite still stable-fabricating on clean-feature-add; TASK-012 records `deleted_prelock_write_clean` × nova-lite stable FFF 7/7. Model choice is the largest lever, not a complete fix.

## 2. Prompting = secondary compensator

- TASK-014: existence checks "reduced fabrication on 2 of 3 fixtures after the model upgrade" — real, partial, fixture-dependent.
- Deployed + measurable: TASK-007 records PR [#1875](https://github.com/state-vector/superpositional/pull/1875) (existence checks on all 9 remaining guards, verified MERGED 2026-10-15 per BR#922's duty) and [#1912](https://github.com/state-vector/superpositional/pull/1912) prompt fixes clearing data-lifecycle FPR 2/11 → 1/11 = 9.1% < the 10% floor (TASK-009 verification BR#926).
- Recorded limit: suppression, not elimination — prompting operates after model selection; BR#948's proposed ruling orders prompt work first only for residual stable-FFF pairs with the roster held.

## 3. Evidence assembly = tertiary delivery issue

- TASK-014: "Some cases do not reliably deliver entity-bearing nodes to the enrich operator, so downstream trust signal can be starved." Delivery problem — suppresses/dilutes the trust signal; it does not manufacture false findings.
- Landing state unverified at mirror time: BR#922's duty recorded the contradiction that TASK-011 status=done while its body said "QUOTA-BLOCKED 2026-10-15, slice never ran". (Verify-round update, 2026-10-20: BR#937 has since resolved the contradiction — TASK-011 landed on main at merge commit 64b54c9 via the PR #1875 chain, with the `enrichment_unavailable_caveat` implementation and tests live in `packages/lambda-cortex/src/operators/mod.rs:937`. The assembly-side lever IS landed; its standalone effect on the trust rate remains unmeasured — see §5.2.)
- Third because the recorded fabrication driver sits in the model layer first, prompt layer second; assembly affects what reaches the evaluator and its standalone effect was never measured.

## 4. Expected-impact ordering (follows TASK-014's recorded lever order)

1. Guard model choice — only recorded receipt where one change flips deterministic fabrication; the TASK-008 family was built to pull it.
2. Guard prompt anti-fabrication — measured partial suppression (2/3 fixtures; #1912 2/11→1/11) that cannot remove the ceiling per the recorded conclusion.
3. Evidence assembly — delivery-side starvation fix, no recorded measurement of standalone effect.

(Measurement levers — clean-fixture precision evals [#1896](https://github.com/state-vector/superpositional/pull/1896), re-draw policy [#1816](https://github.com/state-vector/superpositional/pull/1816) merged, trailing-30d trust view — sit behind these in the same recorded ordering.)

## 5. Residual unknowns blocking stronger certainty

1. **Missing fresh rerun** — no post-upgrade per-guard-model fixture draws exist in the record: BR#847 confirms `scripts/review-guards.ts:86` pins `MODEL_ID = "eu.amazon.nova-micro-v1:0"` for ALL guards (severed wire), so the 8 consecutive nightly reds (Oct-14→19) are Nova-Micro draws; BR#572 marks the gate UNMEASURABLE until wired. Capability-first ordering rests on pre-upgrade draws + the upgrade's recorded rationale.
2. **Unknown marginal contribution of evidence assembly** — never quantified against model/prompt effects (flagged in BR#382, still unmeasured).
3. **Cohort-dilution uncertainty** — 230 pre-fix opinions (13%/36% fabricated) dominate the 279-record denominator; the 47-record post-fix cohort (fabricated halved 36%→16%) cannot move the cumulative aggregate (PROGRESS-006; TASK-007: 16%→17%→16% flat). Near-term movement from any single lever is not observable in the recorded rate until the post-fix cohort outgrows the pre-fix mass or the trailing-30d view ships.
4. **Post-upgrade stable fabrication persists on named pairs** (TASK-012, BR#572) — a fresh rerun would need to confirm/size it.

**Explicit open questions (per AC):** missing fresh rerun; unknown marginal contribution of evidence assembly; cohort-dilution uncertainty — all three stated above.

## 6. Verification receipts (BR#972 round, 2026-10-20 — session `ses_verify_br972_20261020`)

Fresh-session role:review re-gate of the mirrored analysis, per the BR#877 rule. Receipts checked live via `gh api` against state-vector/superpositional and against knowledge artefacts.

| Claim in the mirror | Receipt | Result |
|---|---|---|
| #1875 existence checks on 9 remaining guards, MERGED 2026-10-15 | `gh api pulls/1875` → merged 2026-10-15T05:01:48Z, "fix(agents): the EXISTENCE CHECK anti-fabrication section on the nine remaining guards (GH #1768)" | CONFIRMED |
| #1912 prompt fixes clearing data-lifecycle FPR 2/11→1/11 | `gh api pulls/1912` → merged 2026-10-15T13:28:29Z (claim-verification hardening); FPR figures recorded in TASK-012 body ("#1912 prompt fixes", 1/11 = 9.1% < 10%) and BR#926 (TASK-009 verification, done) | CONFIRMED (attribution nuance: the FPR receipts live in TASK-012/BR#926 rather than TASK-007's body — substance intact, no fabrication) |
| Models landed on main via merged #1913 + #1943; "no production guard remains on Nova Micro" | `gh api pulls/1943` → merged 2026-10-16T09:47:33Z (variance-gate rework, GH #1002); #1913 merged 2026-10-15T09:19:41Z (title is the Novu fix — content corroborated by prior verify round BR#1017, proposed decision) | CONFIRMED (merge states live; #1913 title mismatch noted, already adjudicated by BR#1017) |
| `scripts/review-guards.ts:86` pins Nova Micro for all guards | BR#847 body (impl child, live-confirmed on main 2026-10-20); BR#572 "UNMEASURABLE until wired" | CONFIRMED |
| `deleted_prelock_write_clean` × nova-lite stable FFF 7/7 | TASK-012 body: "7/7 draws FFF (stable fabrication)" | CONFIRMED |
| 230 pre-fix / 279-record / 47-record post-fix dilution; 16%→17%→16% flat | PROGRESS-006 and TASK-007 body verbatim | CONFIRMED |
| TASK-014 quotes (deterministic 3/3; ceiling; 2/3 fixtures; entity-bearing starvation) | TASK-014 body verbatim | CONFIRMED |
| TASK-011 "QUOTA-BLOCKED … slice never ran" contradiction | Recorded in BR#922 (superseded → re-issued BR#937, done); since resolved: TASK-011 landed at 64b54c9 | CONFIRMED (mirror statement stale-but-conservative; corrected in §3 above) |

**Gate verdict:** the mirrored analysis is complete against BR#616's AC — all three explicit open questions (missing fresh rerun; unknown marginal contribution of evidence assembly; cohort-dilution uncertainty) are stated in §5. No fabricated receipts found; two cosmetic drifts noted (FPR-receipt attribution; TASK-011 landing resolved by BR#937 after mirror time). The remediated done is ACCEPTED.