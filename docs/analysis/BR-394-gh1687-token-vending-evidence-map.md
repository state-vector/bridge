# BR#394 — GH#1687 token vending error burst: evidence map and fix acceptance criteria

Task: BR#394 (BR#60 analysis child, role:analysis). Session `br394-token-vending-analysis`, 2026-10-20.
Parent: BR#60 "#qps GH#1687 — githubtokenvending error burst recurred" (in_review).
Prior sibling analysis: BR#462 (done) covered the same scope from the verifier-chain angle; this record adds the technical root-cause receipts and a fresh live-state check.

## 1. Confirmed root cause — GH#1687 with receipts

**Issue context.** `state-vector/superpositional#1687` — "integrations githubtokenvendingfunction: error burst RECURRED prod 2026-10-12 (32x, empty message payloads)". Labels: `gtm-blocker`, `issue:stability`, Track C (BR#60). Live receipt (this session, 2026-10-20, `gh issue view 1687 --repo state-vector/superpositional`): `state=OPEN`, `closedAt=null`, last thread update 2026-10-18T12:53:15Z.

**Technical root cause** (receipts: BR#171 X1-B exec progress 2026-10-16T07:45Z; BR#176 07:20Z; BR#177 final batch report; coordinator re-verification BR#180 2026-10-16):

- `providers/github/functions/token-vending/src/main.rs` — `handler()` returned `Err` on **every error path with zero handler-side emission**. The only failure record was the `lambda_runtime` unhandled-error line, whose text lands in a field the Datadog forwarder does **not** map to `message` — hence the observed "32x empty message payloads" burst.
- Burst trigger context (BR#176): the review-scope tenant lookups that triggered the recurrence were fixed superpositional-side previously; the observability gap in the vend handler itself remained.

**Fix as implemented** (receipts: BR#171, BR#176, live PR): structured ERROR emitted on every failure path (one per failure) with:

- `error_kind` — exhaustive match (new variants fail compile);
- `requires_engineering` — `true` only for config/internal/aws classes;
- `caller_action` — attributed guidance per failure class;
- `installation_status` — absent vs inactive, set at TenantNotFound's two origin sites;
- `request_id` — added to the span.

Explicit design constraint: **no vend semantics change**; **no config/env/SSM change required** (BR#171).

**Fix verification receipts** (BR#171; corroborated live by PR state):

- `cargo test -p github-token-vending`: **11 passed / 0 failed** (8 baseline + 3 new: `tenant_not_found_error_path_emits_structured_error`, `caller_errors_classified`, `engineering_errors_classified`).
- Clippy: only pre-existing `Span::record` borrow findings + one 8-arg count on a new helper — no new lint debt.
- PR CI check "Superpositional": SUCCESS, completed 2026-10-16T07:33:03Z (BR#632).
- Review: APPROVED (live receipt below).

**Implementation carrier.** PR `state-vector/integrations#2` — "fix(token-vending): structured ERROR on every vend failure path (superpositional#1687)", branch `x1b/1687-vend-structured-errors`, head `6e456bfbb441b6ddcefeeec4a20faf93db7b52b5`, base `main`. Built by the X1-B batch (owner `opencode-X1`, dispatch BR#142, human-approved 2026-10-16).

**Fresh live state — 2026-10-20 (this session, `gh pr view 2 --repo state-vector/integrations`):**

- `state=OPEN`, `mergedAt=null`, `mergeCommit=null`, `mergeStateStatus=CLEAN`, `reviewDecision=APPROVED`.
- Confirms the 2026-10-19 live receipts in BR#632 and the verifier-chain bounce findings (BR#397, BR#399): **no merged-PR receipt exists; the closure gate remains unmet.**

**Why it is not closed.** The technical failure is fixed in an approved, CI-green PR; the remaining blocker is a *closure-gate mismatch*, not an unresolved diagnosis. Prior verifier chain (BR#396 → BR#397 → BR#398 → BR#399 → BR#401 …, receipts in BR#462 §Root cause) consistently bounced for the same missing item: merged-PR state + observed-green prod deploy.

## 2. Coordination overlap — and whether implementation is in flight

**Implementation is already in flight elsewhere. It is done and waiting on a merge decision; do not fork it.**

- The fix lives in `state-vector/integrations#2` (X1-B batch, dispatch BR#142). It is APPROVED, CI green, merge-state CLEAN. Any new implementation would duplicate an approved PR — the open overlap is **merge + deploy ownership, not code**.
- Merge, dev→prod deploy, and observed-green confirmation are **coordinator-only (Ray's call)** per the issue thread's own terms (BR#632, BR#177: "merge+deploy is Ray's call"; BR#180: "#1687 open-pending-Ray").
- Verification duty is likewise owned elsewhere: BR#60's review child chain (BR#397, BR#863 — both done with bounce findings) and the deeper Verify wrappers (BR#396…BR#414, receipts in BR#462). BR#60 sits in_review awaiting its verdict; this analysis does not re-run that chain.
- Duplicate-analysis overlap: BR#462 (done) is the earlier analysis child for the same parent; BR#394 is its re-issue. Delta delivered here: (a) the concrete technical root cause from BR#171/BR#176 — BR#462 recorded only the process-level "closure-gate mismatch" framing; (b) live receipts refreshed to 2026-10-20.

**Rule-3 conclusion:** nothing to fork and nobody to displace — record the map, keep hands off integrations#2, route downstream effort at the coordinator gate.

## 3. Acceptance criteria for any fix/PR (and explicit out-of-scope)

From the BR#142 dispatch terms, the BR#171 fix design, BR#632, and BR#462 §Acceptance criteria:

**PR/fix criteria (already evidenced by integrations#2 — receipts above):**

1. Root cause recorded with log evidence; fix PR open against `state-vector/integrations` with deploy note in the PR body (BR#142 item 3) — met: PR #2.
2. Structured ERROR on **every** failure path, one per failure, with `error_kind` (exhaustive match), `requires_engineering`, `caller_action`, `installation_status`, `request_id` in span (BR#171).
3. **No vend semantics change**; no config/env/SSM change required (BR#171 deploy note).
4. Tests green including the three new failure-path tests (11/11 for `github-token-vending`); no new clippy debt; CI green; review APPROVED.
5. Branch identity preserved as cited in receipts: `x1b/1687-vend-structured-errors` on PR #2, head `6e456bf` (BR#462).
6. Any note claiming closure cites the **actual receipt source** (live PR/issue state, log lines), not a paraphrase (BR#462).

**Closure criteria (unmet — the remaining gate):**

7. Merged-PR receipt: `mergedAt`/`mergeCommit` non-null for integrations#2 (live 2026-10-20: still null).
8. Deploy sequence per PR body: **dev first**, verify `@error.kind` / `@caller_action` fields arrive in Datadog, then prod.
9. Observed green: no recurrence of the empty-message burst shape post-prod-deploy.
10. Issue closure by **coordinator only** (Ray), citing the live merged-state + observed-green receipts (BR#632: "PR state alone is NOT sufficient to close").

**Explicitly out of scope (per BR#60, BR#142, and this task):**

- No code changes in this analysis; no new fix PR/branch for #1687.
- No deploy actions, no prod config/env/SSM changes, no vend semantics changes.
- No issue closure by any agent other than the coordinator; no re-running of the existing verifier chain for BR#60 while it is in_review.

## Residuals

- **16-bit `newEntropy()` flake** (BR#171 side-finding from the batch, noted in BR#180 as "needs an issue") — still unfled at time of writing; belongs to the integrations repo, not this child.
- BR#60 must not be closed `done` until gate items 7–10 land; its in_review state is correct (BR#632 verdict: bounce was correct).

## Receipt index

| Artefact | Kind | Receipt content |
|---|---|---|
| BR#60 | task (in_review) | Parent issue context, decomposition, out-of-scope |
| BR#142 | task (in_review) | X1-B dispatch: acceptance terms for #1687 slice |
| BR#171 / BR#176 / BR#177 | progress | Root cause (file:level), fix design, test counts, PR link, deploy note |
| BR#180 | progress | Coordinator verification: X1-B judged GOOD; #1687 "open-pending-Ray" |
| BR#632 | progress | Live receipts 2026-10-19: PR OPEN/CLEAN/APPROVED, CI SUCCESS; issue OPEN; gate = merged PR + prod deploy + observed green |
| BR#462 | task (done) | Prior analysis child: verifier-chain evidence map + acceptance framing |
| BR#397 / BR#863 | task (done) | Fresh-session verify passes: bounce findings, mergedAt=null |
| This session, 2026-10-20 | live `gh` | PR #2 `OPEN/CLEAN/APPROVED`, mergeCommit=null; issue #1687 `OPEN`, closedAt=null |
