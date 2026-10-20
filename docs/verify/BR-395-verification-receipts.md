# BR#395 verification receipts — BR#60 review child (GH#1687 token vending)

Task: BR#395 (role:review, review-gate companion for BR#60). Scope: verify the cited PR and root-cause receipts for GH#1687 against the knowledge record; confirm the deploy note requirement is present and closure is still gated on live prod verification by the coordinator; record any mismatch. No implementation, no code review judgment beyond receipt verification, no deploy action.

## Verdict

Receipts confirmed — the PR and root-cause receipts cited in the knowledge record are accurate against live state; the deploy note is present in the PR body; closure remains correctly gated on the coordinator's live prod deploy + observed green. One mismatch found: the prior verifier of this task (BR#463) was closed done with no receipts — void-done.

## Receipts checked (fresh session BR-395-verify-token-vending-receipts, 2026-10-20)

1. **PR `state-vector/integrations#2`** — live via `gh pr view 2 --repo state-vector/integrations`:
   - `state=OPEN`, `mergedAt=null`, `mergeCommit=null`, `mergeStateStatus=CLEAN`.
   - head `x1b/1687-vend-structured-errors` → `main`; title "fix(token-vending): structured ERROR on every vend failure path (superpositional#1687)".
   - Single commit `6e456bf` "fix(token-vending): log structured errors on every vend failure path" — matches the knowledge record (BR#171: branch `x1b/1687-vend-structured-errors`, commit `6e456bf` on `55d3a6c`).
   - Review: APPROVED (`superpositional-sync`); check "Superpositional" pass (2m10s).
2. **Deploy note present in the PR body** (the "for Ray" section): deploy to dev first, verify the ERROR fields land in Datadog (`@error.kind`, `@caller_action`), then prod; no config/env/SSM change required — logging only; "superpositional issue #1687 closure is gated on Ray's prod deploy + observed green." Matches the BR#171 knowledge record verbatim in substance. ✓
3. **Root-cause receipt vs knowledge record (BR#171)** — PR body matches: `handler()` returned `Err` on every error path with zero handler-side emission; the only failure record is the `lambda_runtime` unhandled-error line whose text lands in a field the Datadog forwarder does not map to `message` (the "32x empty message payloads" burst). Fix shape matches: structured ERROR per failure with `error_kind` (exhaustive match), `requires_engineering`, `caller_action`, `installation_status` (TenantNotFound's two origin sites), `request_id` in span; no vend semantics change. Test receipt matches: `cargo test -p github-token-vending` 11 passed / 0 failed (8 baseline + 3 new). ✓
4. **Issue `state-vector/superpositional#1687`** — live via `gh issue view 1687`: `state=OPEN`, `closedAt=null`, labels `integrations`, `gtm-blocker`, `worker:opencode-ray`, `issue:stability`; title "integrations githubtokenvendingfunction: error burst RECURRED prod 2026-10-12 (32x, empty message payloads)".
5. **Closure gate**: NOT met and correctly still held — PR unmerged, no deploy receipt, issue open. Consistent with BR#397's bounce findings (checked 2026-10-19: `mergedAt=null`), BR#632's verified-live receipt (PR still OPEN, no merge/deploy receipt; answered ASK-mvez0dw3-ztn8), and BR#687's unblock verdict.

## Mismatches recorded

1. **BR#463 void-done**: the auto-spawned verifier of BR#395 ("Verify: BR#60 review child: verify token vending receipts and deploy note") was transitioned done (2026-10-20, ts 1792462493325) with no receipt-bearing note — its last progress note is a runner dispatch fragment ("Grep tool is also failing — delegating the file scan to an explore agent"). A review without receipts is rejected (BR#877 void-done rule). This pass re-performs the verification with receipts; BR#463 should be treated as void under the BR#877 remediation pattern.
2. **PR #2 stalled open**: PR open since 2026-10-16 (last update 2026-10-16T07:33:10Z); no movement toward merge. The closure chain (merge → dev deploy → Datadog field check → prod → observed green → close #1687) is entirely pending the coordinator. Not a defect of the analysed work — consistent with every receipted round.
3. **Gate state note**: the earlier rejection of BR#395 ("parent BR#395 still has 1 open child task(s)") bound while BR#463 was open; BR#463 is now done, so that gate no longer binds. Relation graph quirk: BR#395 is recorded `child_of` its own verifier wrapper BR#463 — a graph artefact, not a content mismatch.

## Conclusion

- BR#395 Done-when items all hold: cited PR and root-cause receipts verified against the knowledge record; deploy note present; closure still gated on live prod verification by the coordinator; mismatch (BR#463 void-done) recorded.
- Parent BR#60 stays in_review awaiting its verdict; GH#1687 stays open pending merge + coordinator prod deploy + observed green.
