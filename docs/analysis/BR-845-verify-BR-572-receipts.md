# BR-845 — Verify: TASK-008 analysis child BR#572 (model scope, catalog source, validation plan)

- **Verify duty:** BR#845 (role:review, child of BR#572)
- **Target:** BR#572 "TASK-008 analysis child: confirm model/catalog scope and upgrade plan" (analysis session ses_ea9e129d7ffezOAWzjus3BCnQ9)
- **Session:** BR-845-verify-572 (2026-10-20)
- **Method:** double-check, not re-analysis — every receipt in the BR#572 body re-checked live via `gh api` / `gh pr` against state-vector/superpositional and cross-read against TASK-015 + TASK-017 recorded findings.
- **Verdict: VERIFIED — BR#572 closed done.** All four required elements present in the body; every live receipt corroborated. Three minor freshness nuances recorded below, none verdict-changing.

## 1. Required elements — present in BR#572 body

| Required element | In body? | Evidence |
|---|---|---|
| Three guard templates named (failure-handling, readability, delivery) | ✅ | "Scope — the three guard templates" section + per-template table |
| Pricing/catalog source of truth | ✅ | "conformance enforced by `cargo test -p agents` against `packages/agents/src/pricing.rs` (the catalog source of truth)" |
| `cargo test -p agents` + fixture-gate validation plan | ✅ | "Validation plan for the impl child" section (TS-only slice; one workflow_dispatch run with per-guard models) |
| Out-of-scope items marked explicitly | ✅ | "Out of scope" section: no agent.toml/pricing edits, no test execution, no sweep, no review-guards.ts changes in this child |

## 2. Live receipts — all corroborated (checked 2026-10-20)

| BR#572 claim | Live check | Result |
|---|---|---|
| failure-handling = `eu.amazon.nova-lite-v1:0` (0.06/0.24) | `gh api contents packages/agents/guards/failure-handling/agent.toml?ref=main` | ✅ exact match (model + both price lines) |
| readability = `openai.gpt-oss-120b-1:0` (0.14/0.56) | same, readability/agent.toml | ✅ exact match |
| delivery = `zai.glm-4.7-flash` (0.07/0.4) | same, delivery/agent.toml | ✅ exact match |
| No production guard on Nova Micro on main | the three tomls above | ✅ confirmed — all three on sweep-selected models |
| #1913 merged 2026-10-15T09:19Z, sweep apply touching all three agent.tomls | `gh pr view 1913` → MERGED 2026-10-15T09:19:41Z; files list | ✅ merged; files include all three `guards/*/agent.toml` + `packages/eval/eval-selection.json` (nuance 3 below on the PR title) |
| #1943 merged 2026-10-16T09:47Z, re-selection failure-handling → nova-lite + variance-gate rework (GH #1002) | `gh pr view 1943` → MERGED 2026-10-16T09:47:33Z, title "fix(eval): rework variance gate…(GH #1002)"; files | ✅ merged; re-touches `guards/failure-handling/agent.toml` + `model-selection.md` + wide agent.toml sweep |
| Sweep record: failure-handling sole passer nova-lite; readability passers incl. gpt-oss-120b; delivery passers glm-4.7-flash et al. | `packages/eval/eval-selection.json?ref=main` (written_at ≈2026-10-16, the re-selection) | ✅ per-template passer lists match the tomls exactly; nova-lite ∉ delivery passers (nuance 2 below) |
| Fixture gate tests the WRONG model: `scripts/review-guards.ts:86` pins `MODEL_ID = "eu.amazon.nova-micro-v1:0"`, never reads agent.toml on this path | `gh api contents scripts/review-guards.ts?ref=main` | ✅ line 86 exactly as cited; `MODEL_ID` used at line 368 (`modelId: MODEL_ID`); **zero** `agent.toml` references anywhere in the script — severed wire confirmed |
| Nightly Guard Fixture Gate red: Oct-19 run 3/6 fixtures FAILED, classified `precision_regression` | run 39201290904 (2026-10-19T04:48Z), job "Guard fixtures (3 draws, boundary-classified)" | ✅ log tail: "3 passed, 3 failed (6 total, 3 draw(s))"; verbatim findings: clean-feature-add ❌ failure-handling "Removed `await` from async function calls in catch block"; clean-infra-only ❌ infrastructure "Added DynamoDB table NotificationPrefsTable without corresponding IaC definition"; clean-refactor ❌ observability "execute_search is unobservable" |
| clean-docs-only PASSES stable-clean | same run log | ✅ "clean-docs-only… ✅ (0 findings)" |
| Bug fixtures still fire (recall intact, AC5 MET) | same run log | ✅ bug-missing-infra ✅ (4 findings), bug-silent-error ✅ (8 findings) |
| Nightly red streak "8 consecutive runs (Oct-14 → Oct-19)" | `actions/workflows/guard-fixture-gate.yml/runs?per_page=12` | ⚠️ live shows **10 consecutive** failures in that window (38511833788 Oct-14T04:31 → 39201290904 Oct-19T04:48, every run red) — BR#572 understates; direction unchanged (nuance 1) |
| `cargo test -p agents` green at merge; only reds = ci/Eval (known #1929) + Superpositional review check | `gh pr checks 1943` | ✅ `ci / Rust Tests` **pass**; reds exactly `ci / Eval` + `Superpositional` as stated |
| Catalog source of truth + family-independence tests exist | `gh api contents packages/agents/src?ref=main` | ✅ `pricing.rs` and `registry_coverage_tests.rs` both present on main |

## 3. Cross-check against recorded findings

- **TASK-015** (conformance-gate blocker, in_review): body records nova-micro as only verdict-tool passer for failure-handling/readability, nova-lite FAILING delivery's sweep, hand-edit forbidden by model-selection policy, and the fixture-gate `MODEL_ID = nova-micro` severed wire. BR#572 is consistent with all of it and correctly frames TASK-015 as resolved-by-events (Option A — the targeted sweep — ran and applied via #1913/#1943). No contradiction.
- **TASK-017** ("changes on unmerged branches — main still has old models", in_review): its body is a dated 2026-10-15 snapshot (pre-#1913/#1943 merge). BR#572 explicitly supersedes it with live main state ("resolved — the sweep-selected models ARE on main") — the correct posture under rule 8 (supersede, never contradict). Live toml check above adjudicates in BR#572's favour: main has the new models.
- **TASK-008 parent**: parent's in_review receipts (models on origin/main = nova-lite / gpt-oss-120b / glm-4.7-flash via #1913 + #1943) match BR#572 verbatim. The impl child BR#847 ("wire guard fixture gate to per-guard agent.toml models") is filed and in_review — the "Remaining decomposition" claim holds.

## 4. Nuances recorded (non-blocking)

1. **Streak length understated**: 10 consecutive red Guard Fixture Gate runs Oct-14→Oct-19 live vs "8 consecutive" in the body. Does not change AC4's disposition (gate unmeasurable until the wire fix lands — BR#847).
2. **eval-selection.json freshness**: the file on main today is the 2026-10-16 re-selection; it lists nova-lite in **neither** passers nor failing_models for guard/delivery (nova-micro also absent). The "nova-lite FAILING delivery's sweep entirely" record BR#572 cites is the earlier sweep snapshot quoted in TASK-015's body. The policy conclusion only requires nova-lite ∉ delivery's passing_models — live-true regardless — so AC1-literal remains unsatisfiable under the conformance gate. Citations accurate to their cited source; drift noted for the ledger.
3. **#1913 is a mixed-content PR**: title is a CRM/Novu region fix, but its file list includes all three guard agent.tomls + eval-selection.json — BR#572's "sweep apply touching all three agent.toml files" is accurate at file level.

## 5. Disposition

- BR#572 → **done** (satisfies the parent TASK-008's role:review bar).
- No code changes made; no agent.toml touched (per duty). This record doc is the only artefact.
- Residues already owned elsewhere: BR#847 (wire fix, in_review), TASK-012 / GH #1305 family (AC4 re-scope coordination), #1929 (known eval red).
