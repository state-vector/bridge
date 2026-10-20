# BR#1079 — verify receipts: BR#58 (#qps GH#1270 — removeRepo leaves repo data behind)

Session: `BR-1079-verify` (fresh-session verify; no impl/analysis on this task in this session).
Verdict: **VERIFIED (non-void)** — BR#58 closes done.

## Live receipts (collected this session, 2026-10-20)

1. **PR #1554 MERGED** — `gh pr view 1554 --repo state-vector/superpositional`
   - state `MERGED`, mergedAt `2026-10-10T10:46:41Z`, mergeCommit `35573331a139fa26653ac864ad9724eac626a917`
   - head `r5s8-repo-purge-removal` → base `main`; title "removeRepo purges the repo — row deleted only after the purge succeeds (GH #1270)"
   - CI: Typecheck, Web Unit Tests, Proving Gate, Rust Tests, TypeScript Tests, ASL validation (AWS), Monitor Liveness, UI Smoke, Stripe Mirror Conformance, str-slice ratchet, Rust Release Build, Lodestar Integration all SUCCESS; Chat Integration / Next.js Build / Eval SKIPPED. One FAILURE is the external `Superpositional` deploy monitor (detailsUrl superpositional.io), not repo CI. Admin-merge per standing authorization (gtm-blocker) per the merge commit message.
2. **Merge commit on main** — `gh api repos/state-vector/superpositional/compare/main...35573331` → `ahead_by 0, behind_by 456` (merge commit contained in main). Local `git merge-base --is-ancestor` returns false only because this worktree clone is SHALLOW; GitHub compare is authoritative.
3. **GH issue #1270 CLOSED / COMPLETED** — `gh issue view 1270` → `state CLOSED`, `stateReason COMPLETED`.
4. **Fix content on main** (spot-checked at sp/main `207fd0d20`, 2026-10-20):
   - `packages/functions/resolvers/repo.ts` — `removeRepo` (line ~664) no longer row-only: fenced org check, sets `removal.state = "purging"`, enqueues to `RepoPurgeQueue` (`REPO_PURGE_QUEUE_URL`); `listRepos` hides `purging` rows.
   - `packages/functions/lodestar/repo-purge-worker.ts` — purge flow: delete-collection workflow with `purpose: "purge"`, then durable rows work orders → knowledge → **repo row LAST**; failure leaves row + data with `removal.state = "purge_failed"` (visible/retryable — never orphaned-data-no-row); idempotent for SQS redelivery; cross-tenant abort; re-added-repo skip.
   - `infra/delete-collection-workflow.asl.json` states include `SnapshotDurable` / `VerifyDurableRetained` / `FanOutDelete` / `DeleteVectors` / `DeleteOsi` — durable ledger retention enforced inside the workflow.
   - Tests on main: `repo-purge-worker.test.ts`, `collection-deleted.test.ts`, `packages/functions/tests/resolvers/repos.test.ts`, `packages/workflow/tests/durable_retention_wiring.rs`.

## Handoff gate

- BR#58 seq 12634: in_review with the required PR link (`https://github.com/state-vector/superpositional/pull/1554`). The earlier handoff (seq 9833) was the guardrail-blocked void round (0/9 endpoints) — superseded by the resubmission.

## Prior rounds (consistency)

- BR#359 (real verify round, done 2026-10-19): same verdict, same receipts; named non-blocking residue — post-deploy synthetic-repo purge smoke marked PENDING (no run id). Unchanged by this round; still named, still non-blocking.
- BR#862: VOID round (body cites the OpenRouter guardrails URL as the "PR" — BR#859/BR#900 pattern); runner auto-closed. Not a verdict of record; this round supersedes it.

## Verdict

BR#58 → done. Verify duty BR#1079 → in_review with PR link to this receipts doc.
