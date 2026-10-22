# BR-43 verify receipts — GH#1311 plan-1261 scenario org drift (verify round BR-43-verify-1311, 2026-10-20)

Task: bridge BR#43 — "#qps GH#1311 — plan-1261 scenario org drift (fix merged #1922, verify+close)".
Session: `BR-43-verify-1311` (fresh session; prior substantive round seq 7193, void in_review handoffs released by watchdog).
Closure rule applied: BR#274 — no closure without the scenario id on-thread and every merge verified on origin/main (never the MERGED badge alone).

## Verdict

**Issue #1311 NOT closed this round — the fix is half-landed.**

- Ceiling scenario `plan-1261-destructive-reindex`: **VERIFIED fixed** on tonight's gate.
- Floor scenario `plan-reindex-excludes-durable`: **residual confirmed live** — org-less fixture, seeding still pinned to the E2E org, probe still red naming it.
- Receipts comment posted on-thread: https://github.com/state-vector/superpositional/issues/1311#issuecomment-6284028283

## Receipts (all live 2026-10-20 via gh CLI / GitHub API, state-vector/superpositional)

| Check | Receipt |
|---|---|
| Issue #1311 state | OPEN (`closedAt: null`); covers BOTH scenarios per OP fix plan (declare org in both fixtures; SeededDirective → `effective_org`; remove guard exemption) |
| Fix PR #1922 | MERGED 2026-10-15T21:41:46Z, merge commit `0881fd7cd8f75aa51730e93a34da1a8130abea09`, base main, head `vg2/1311-plan-1261` |
| Merge on main | GitHub compare `main...0881fd7cd` → `ahead_by 0` (behind_by 148) — contained in origin/main |
| Ceiling fixture on main | `fixtures/mcp-eval/scenarios/plan-1261-destructive-reindex/scenario.toml` declares `org = "c2979766-32d2-43ef-9d19-134150f8156a"` (dogfood org, GH#848); constraints pinned by id (`review_plan_1261_destructive_reindex_never_approves`), nothing seeded |
| Floor fixture on main | `fixtures/mcp-eval/scenarios/plan-reindex-excludes-durable/scenario.toml` declares **no `org`** → runs under E2E org |
| Exemption entry | `ORG_RESOLUTION_EXEMPT` still names `run_plan_review_with_destructive_standards` in `packages/lambda-cortex/tests/review_quality.rs` — reason cites GH#1311, "remove this entry when seeding follows effective_org" → OP fix steps 2+3 outstanding |
| Verdict Gate (tonight) | Cortex Verdict Gate run **39362021328** (2026-10-20T03:00Z, head `c0a2e958e`): `review_plan_1261_destructive_reindex_never_approves` **PP pass 2/2 draws**; `review_plan_compliant_reindex_clears_the_standards` **PP pass 2/2 draws**; `plan-1261-destructive-reindex` drew `reject` (expected), `plan-reindex-excludes-durable` drew `approve` (expected); 0/17 verdict flips between draws |
| Gate red tonight | `ghost_secret_logging` FF 2/2 (16 passed / 1 failed) — the #1305 chronic umbrella (bridge BR#41), unrelated to #1311 |
| Quality Daily (tonight) | Cortex Quality Daily run **39365479684** (2026-10-20T03:39Z, head `c0a2e958e`): probe `fixture_repo_has_data_in_its_org` **RED** — `plan-reindex-excludes-durable: repo state-vector/superpositional has no entities under org c3a86adb-207d-4485-89fb-8e6dcaf778ff`; same battery: floor drew `concerns` vs expected exactly `approve`; insight floor suspended on enrichment-degraded caveat |
| Oct 19 nightly (prior round corroboration) | Run 39195985587: `plan-1261-destructive-reindex` drew expected `reject` over real dogfood-org evidence |
| Open PRs in family | `gh pr list` search 1311/1261/reindex/durable → zero open PRs (no fork risk) |

## Why not close

The floor's gate `approve` is drawn against **empty retrieval** in the E2E org — the exact vacuous-pass class #1311 exists to prevent ("pass vacuously on the ceiling", OP). Closing now would close an issue whose own nightly probe is red naming one of its two scenarios. BR#274 requires the closure thread to carry the scenario id AND the verified state; the verified state today is half.

## Closure path (what unblocks)

1. PR declaring `org = "c2979766-32d2-43ef-9d19-134150f8156a"` in `plan-reindex-excludes-durable/scenario.toml` **and** making `SeededDirective` seed into `effective_org(scenario.org)` **and** removing the `ORG_RESOLUTION_EXEMPT` entry for `run_plan_review_with_destructive_standards` (the remaining 2/3 of the OP fix plan).
2. A nightly shows the probe green + the floor approving under the dogfood org.
3. Close #1311 citing both scenario ids (`plan-1261-destructive-reindex`, `plan-reindex-excludes-durable`).

## Bridge bookkeeping this round

- On-thread receipts comment (above).
- This receipts doc via bridge PR (branch `bridge/BR-43`).
- BR#43 → blocked (reason: residual floor fix outstanding; unblock condition: the PR above merges + probe green on a nightly) after decision ask filed — implementing the floor fix from this session would breach separation of duties (5b): this session produced the verification.