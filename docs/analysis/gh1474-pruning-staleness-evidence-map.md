# GH#1474 — OSI pruning-index staleness + vector_orphans: evidence map

**Provenance:** BR#418 — analysis child of BR#55 (`#qps GH#1474 — OSI pruning staleness + vector orphans`, labels `gtm-blocker`, `issue:stability`).
**Status:** POST-FIX. The fix landed upstream after this evidence map was first drafted; this document is the bounded reference for the failure surfaces and the disposition record of the acceptance criteria against the merged fix.
**Out of scope for this child:** code changes, deploys, or any fix attempt. This map bounds future implementation work only.

## Live receipts (verified 2026-10-20, session BR-418-evidence-map-gh1474)

| Receipt | State |
| --- | --- |
| PR [#2058](https://github.com/state-vector/superpositional/pull/2058) `fix/1474-osi-pruning-fresh` — "fix(lodestar-writer): refuse UNCLAIMED pruning-index publication (GH #1474)" | **MERGED** 2026-10-19T12:10:52Z, mergeCommit `b4f709f0dc0c2578a86099b56d2e6b52de5115dd` |
| Issue [#1474](https://github.com/state-vector/superpositional/issues/1474) — "OSI pruning-index staleness (523x/24h, both stages) + vector_orphans at [90-100]% (122x/24h) — #1238's loss class is live again post-closure" | **CLOSED** COMPLETED 2026-10-19T12:10:53Z |
| Files touched by the fix | `packages/lambda-lodestar-writer/src/sfn_write/optimize_osi.rs` (publish guard in `merge_osi_manifest_from_snapshot`), `packages/lambda-lodestar-writer/src/sfn_write_integration_test.rs` (red-first regression test) |

Closure proceeds through the children (impl BR#559→BR#560, review BR#417, verify BR#465); parent BR#55 forbids restarting implementation from this card.

## Failure surfaces

### Surface 1 — pruning-index staleness (root, confirmed by the merged diff)

**Symptom shape:** pruning decisions lag the current index state; a merge/publish path reads (and serves) an old or broken pruning index, so rows that should have been pruned survive.

**Confirmed mechanism (from PR #2058):** `merge_osi_manifest_from_snapshot` used to **log-and-publish** a manifest whose secondary index had built real segments (`secondary_deltas` non-empty) but whose assembled coverage claim came out empty — the "UNCLAIMED" shape (shape 2 of `pruning_is_silently_unusable`). The reader **honours the claim, not the bytes**, so every pruning predicate fell back to the glob. The broken manifest became the serving one and the dead pruning index lived until the next optimize rebuilt it — the 523x/24h stale-index read errors in the #1474 window.

### Surface 2 — vector_orphans accumulation after pruning

**Symptom shape:** stale or partially pruned rows remain addressable even after the pruning stage runs, inflating `vector_orphans` into the 90-100 range (122x/24h). This is downstream of surface 1: a pruning stage that runs against a dead/glob-fallback index does not actually remove what the manifest claims.

### Surface 3 — stage mismatch between pruning and vector cleanup

**Symptom shape:** the first stage prunes correctly but the second stage sees an older snapshot or stale cache, so the orphan count remains high even though pruning appears to run twice. The merged fix removes the dominant stale-snapshot channel (the broken manifest can no longer become the serving one); whether a residual stage-mismatch channel exists is a verification question, not an established fact.

## Observability signals to confirm each surface

1. **Publish-refusal telemetry (exists post-fix):** the refusal emits a structured `tracing::error` naming the UNCLAIMED defect class with `org_id`, `repo_id`, `collection`, `generation`, `entity_segments`, `secondary_segments`, `claimed_coverage`, `pruned_columns`, `requires_engineering = true`. A refused publish leaves the previous manifest serving its own segments — the last-good index keeps answering and the defect surfaces as a loud build failure instead of a silently dead pruning index.
2. **Watermark/version comparison:** compare the pruning-index version or watermark before/after each stage to detect whether the second stage is reading the same version it started with.
3. **Per-stage row counts:** inspect pruned vs retained items per stage; a stale index shows identical pre/post retained sets or repeated retention of rows that should have been removed.
4. **`vector_orphans` vs pruning watermark:** if the counter stays near 90-100 after a successful pruning pass, the bug is in cleanup propagation rather than the initial prune decision.
5. **Stage logs:** correlate with stage-specific logs showing whether the prune stage completed, retried, or read from cache versus a fresh snapshot.
6. **Orphan-vs-removed gap:** compare orphaned-vector count against rows removed by pruning; a large gap indicates a stale-index or propagation miss rather than a simple under-prune.

## Acceptance criteria for a future implementation child — post-fix disposition

| # | Criterion (as written) | Disposition |
| --- | --- | --- |
| 1 | A reproducible test/fixture shows the stale-pruning / orphan condition before the fix | **SATISFIED** — red-first integration test `an_unclaimed_pruning_index_is_never_published` reproduces the exact production shape (real secondary bytes, empty coverage claim) and asserts the merge refuses and the broken manifest never reaches the store |
| 2 | Fix causes pruning-index reads to use current state for both stages, or guarantees the second stage cannot observe a stale snapshot | **SATISFIED by mechanism substitution** — the merged fix guarantees it at publish time: an UNCLAIMED manifest is refused, so the broken manifest never becomes the serving one and the previous manifest keeps serving its own segments. The guarantee is equivalent for the proven failure mode, even though the mechanism differs from the originally worded "force re-read" |
| 3 | `vector_orphans` drops from the 90-100 range to the expected post-prune baseline in the same scenario | **RESIDUAL** — not yet proven in production; owned by impl child BR#560's declared subprocess (dev re-index verification, budget to ~1792478482240). Record as residual, not a bounce reason |
| 4 | Observability added or verified can distinguish "prune ran" from "prune acted on fresh state" | **PARTIALLY SATISFIED** — the refusal-side structured error names the defect class and carries `claimed_coverage` / `pruned_columns` / `generation`. Per-stage watermark logging (BR#553 plan item 3) did not land in the merged diff — residual if BR#560's verification needs it |
| 5 | Existing unrelated stability behavior unchanged; the child proves it only addresses the GH#1474 path | **SATISFIED** — bounded diff (one publish guard + one test); the EMPTY shape (secondary built nothing across every shard) is explicitly preserved as log-and-publish, a different defect class |

## Residuals (owned elsewhere — do not action from this child)

- **`vector_orphans` production normalization** after the dev re-index — owned by BR#560's declared subprocess.
- **Per-stage pruning watermark logging** — did not ship with PR #2058; BR#560 decides whether its verification needs it.
- **Residual stage-mismatch channel (surface 3)** — confirm or refute during BR#560's dev re-index observation.

## Out of scope (unchanged)

- Code changes, deploys, or any attempt to fix the issue in this analysis session.
- Broader indexing refactors, unrelated cleanup logic, or cross-issue stability work.
- Changes to issue classification, labels, or GTM tracking.
- Speculating about root cause beyond the evidence needed to bound a future implementation child.
- Restarting implementation of GH#1474 (fix already merged; parent BR#55 forbids it).

## References

- Parent: BR#55 (`#qps GH#1474 — OSI pruning staleness + vector orphans`)
- Sibling analysis child: BR#553 (implementation plan, done) — source of the plan items the impl children executed
- Impl children: BR#559 (superseded by) → BR#560 (in progress, dev re-index subprocess)
- Review child BR#417 (done); verify child BR#465 (judges this map against the post-fix world)
- Upstream: GH issue #1474, PR #2058