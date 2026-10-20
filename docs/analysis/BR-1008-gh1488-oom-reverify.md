# BR#1008 — Re-verify BR#46 (#qps GH#1488 BuildOsiShard OOM) — VERDICT: VERIFIED (non-void)

- Session: `ses_ea8a158b1ffenfFnjmY8K5sih5` (fresh verify session; prior round BR#866 VOID — it cited the OpenRouter guardrails error page as the "PR" and performed no work)
- Date: 2026-10-20
- Method: live GitHub receipts + independent local `git merge-base` ancestry against `state-vector/superpositional` `main` (fetched fresh this session), not PR badges.

## 1. Fix lineage (merged PRs, full-SHA ancestry — verified independently this session)

| Part | PR | Merge commit (40-char) | Merged at | Ancestor of `main`? |
|---|---|---|---|---|
| Part B — byte-bounded dedup compaction (`CollectionPlan::DedupSharded`, `TARGET_DEDUP_ROWS_PER_BUCKET=250_000`, barrier shared-source delete) | [#1953](https://github.com/state-vector/superpositional/pull/1953) | `ce26bd89760e2c85da7a1d6c65da9e999c63143e` | 2026-10-16T06:08:34Z | **TRUE** (`git merge-base --is-ancestor` → true) |
| Part A — streaming OSI adjacency OOM bound (`ADJACENCY_STREAM_WINDOW_ROWS=50_000`, peak in-flight rows ≤ 2×window independent of \|E\|) | [#1996](https://github.com/state-vector/superpositional/pull/1996) | `4580ea2d596b22f396818fe9a73351bdc4b1b759` | 2026-10-16T13:13:08Z | **TRUE** (`git merge-base --is-ancestor` → true) |

Code markers confirmed on `main` this session via `git show`:
- `packages/lodestar-compact/src/index_builder.rs:1383` — `pub(crate) const ADJACENCY_STREAM_WINDOW_ROWS: usize = 50_000;`
- `packages/lambda-lodestar-writer/src/sfn_write/compact_shards.rs:447` — `CollectionPlan::DedupSharded { buckets, keys }` dispatch.

Brief correction: the re-verify brief named "PR #1948/#1953 lineage". Live, #1948 is the workflow-DSL test PR (`test(workflow): JSONPath-validate…`, merge commit `e868a9fa`, merged 2026-10-16T02:39:41Z) — adjacent to the head_sha producer chain, **not** the OOM fix. The real Part A recovery is **PR #1996**.

## 2. Live large re-index post-merge, no OOM (issue receipts)

[Issue #1488](https://github.com/state-vector/superpositional/issues/1488) — rayh, 2026-10-16T10:43:01Z ("Live dev verification — OOM is gone at the reproducing scale"):

- Deployed commit `3dcf68acf` ⊇ `ce26bd897` (both drivers live on dev).
- The **exact 2026-10-08 OOM shape** on the dogfood repo: **51,603 entities / 63,556,207 aligned `_edges` / shard_count K=64 (clamped at MAX_SHARDS) → BuildOsiShard ran, no OOM**. (The 2026-10-08 OOM was K=3 at 51,819 entities; the fixed budget plans ~1M aligned rows/shard → K=64.)
- **`OutOfMemory` count in the write Lambda across ~3h of large dev re-index activity: 0**; repos serve from the OSI index.
- Full report cited on the issue: `.agents/tasks/review-1488-oom/dev-reindex-verification.md`.

## 3. t+24h canary — recurrence watch elapsed clean

- Issue #1488 **CLOSED 2026-10-16T13:14:30Z** by the owner ([closure comment](https://github.com/state-vector/superpositional/issues/1488#issuecomment-), on-main ancestry evidence + CI soak gate), `gtm-blocker` removed.
- As of 2026-10-20 (t+4 days): no reopen, no post-close recurrence comments.
- Live issue search this session: no new OOM/`MarkIndexDegraded` issues filed post-fix. The 2026-10-14 56k-entity compaction-OOM recurrence [#1866](https://github.com/state-vector/superpositional/issues/1866) is CLOSED. The only open adjacent item is [#1979](https://github.com/state-vector/superpositional/issues/1979) — WaitForEmbeddings barrier (1800s) timeout, explicitly filed and distinguished as **not an OOM, not a #1488 blocker**.

## 4. CI soak gate (closure comment's gate, live check)

- `ci / Lodestar Integration` **PASS** — run [38901879192](https://github.com/state-vector/superpositional/actions/runs/38901879192/job/116975853235) (job 116975853235), on PR #1996.
- `ci / Rust Tests` **PASS** — [job 116975853211](https://github.com/state-vector/superpositional/actions/runs/38901879192/job/116975853211).

## Honest caveats (recorded on the issue; non-negating)

1. Primary trigger inconclusive: the dedicated 88,184-entity `demo-hyperswitch` canary failed **upstream of the fix** at the WaitForEmbeddings barrier (`States.Timeout` at 1800s; embedding succeeded ~5 min late) — filed as #1979. The #1488 proof is therefore **corroborative** (dogfood + e2e runs on the same deployed code at the exact OOM shape), not from a single clean isolated trigger.
2. Part B's dedup K>1 path was not exercised live at this scale (dedup K=1 at ~56k entities); its correctness rests on the merged unit/integration tests (T-eq red-then-green, T-del on MinIO).
3. No single-run `Max Memory Used` figure isolated (concurrent interleaved invocations); zero-OOM-across-the-window is the recorded signal.

## Verdict

The recorded closure conditions are genuinely met live: merged fix PRs with full-SHA ancestry (independently re-verified), a live re-index at the reproducing scale with zero OOM post-merge, and the t+24h recurrence watch elapsed clean (no recurrence in 4 days, issue stays closed, no new OOM filings). **BR#46 → done.** The void round BR#866 is superseded by this verification.