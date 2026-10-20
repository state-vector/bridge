# BR#554 — BR#552 analysis child: wave 4/5 runbook decomposition and residuals

**Kind:** analysis only (no runbook body edits, no merges, no deploys, no GitHub actions, no verification work).
**Target:** `BR#552` — Release-Cluster Runbook — Wave 4/5, **v2** (in_review).
**Governing inputs:** `BR#551` (accepted merge-policy ruling — binding), `BR#322` (accepted case-(c) precedent), `BR#24` (GTM epic #1930), `docs/repo-status-contract.md`, `docs/quality-testing.md` (as cited by the runbook).
**Supersedes for v2:** the sibling analysis `BR#555` (done) was written against runbook **v1**. It is stale on §3: it advises keeping a single "two-consecutive-green-nights" clock, but v2 replaced that with per-issue close gates (streaks survive only for #1258 — 7 green days — and #1305 — 2 consecutive nights; #1260/#1523/#1361/#747 are per-run threshold gates). Everything below is v2-aligned.

---

## 1. Implementation-ready outline (per runbook section, v2)

### §1 Merge-order plan (binding per BR#551)
- Keep the four policy bullets verbatim: never merge onto red main; #2025 hotfix restores green main and gates all merges; case (c) requires receipts (CI run links proving the reds predate the diff and are untouched by it — "looks unrelated" is not a receipt); PRs #1970/#1972/#1984 go green or attach case-(c) receipts, and reds caused by red main are never case-(c) material.
- Keep the sequence table as dependency-driven: (0) #2025 hotfix → main green **verified by ancestry, not the badge**; (1) release cluster #1470, #1904, #1270 (deploy-gated acceptance); (2) nightly-gated primary #1939 → #1361 (feed live is the precondition for the latency re-measure); (3) general queue #747, #1107, #1523, #1258, #1260, #1305 — each closes on its own gate, no shared nightly clock.
- Implementation steps for this subtree: (a) re-state the table with the ancestry-verification note attached to step 0; (b) align the "gates ALL merges — not just deploys" phrasing with BR#551's second gate (merge only when main **deploys green**) — see OQ-2 on the second hotfix lane; (c) keep the closing rule (no merge while the issue is actively failing unless §4 receipts exist).
- **In scope:** ordering, precondition wording, red-main prohibition. **Out of scope:** re-ranking issues, adding new issues, changing ownership.

### §2 Post-deploy verification (observable output)
- Keep the observable-only table: #1470 → routing key in Signal DB shows staleness at 0; #1904 → review verdicts align with expected quality axes (Tier B/C); #1270 → repo `status` transitions `PENDING`/`ERROR` during purge, row deleted only post-purge success, conditional on `status_flow_id`.
- Keep the invariants block: status is written only by FlowTracker (`docs/repo-status-contract.md`); `status_flow_id` respected on conditional writes.
- Implementation steps: attach each row to its merge-order step (§1) so the deploy gate and the observable check read as one sequence; for #1470, reference the existing evidence map (`docs/analysis/gh1474-pruning-staleness-evidence-map.md`, BR#55 family) instead of restating a new diagnostic path — see OQ-1 on the issue number and OQ-7 on the in-flight impl child.
- **In scope:** concrete observable targets, the FlowTracker/status invariant. **Out of scope:** implementation details, new debug workflows, executing verification.

### §3 Per-issue close gates (general queue + nightly primary)
- Keep the structure: no single nightly clock; one exact close condition + owning nightly per issue:
  - #1939 — feed refills on main; nightly meta-review appends fresh records to `.quality/review-latency/latency.jsonl`; `review:metrics` scores a live window; drain gate stays quiet (`checkLatencyFreshness` exit 2/1 not firing). One clean post-merge nightly on main proves it. Owner: `meta-review.yml` (~04:00Z).
  - #1361 — ≥95% of PRs get a verdict ≤5 min from push, re-measured on a LIVE-feed window; sub-conditions already met (no_verdict <5% via #1909/BR#81; base-invalidating concurrency capture via BR#86); closes only after #1939 green. Owner: `meta-review.yml` latency scoring.
  - #747 — `system_insight_primacy` for php-sql-injection holds ≥ floor (2) across nightly quality-daily runs (no draw variance below the ratchet). Owner: `cortex-quality-daily.yml` (~03:30Z).
  - #1107 — no new stale-evidence / wrong-diff-subject anchoring instances post-deploy; recurrence resets the wait. Owner: verdict gate + corpus draws.
  - #1523 — nightly bug-corpus reports `below_floor=FALSE` and the tracked miss (6faf19e2-run-view-additive-scope, plus any recur) is cleared; the `gate_met` 100% red belongs to #1260, not #1523. Owner: `cortex-bug-corpus.yml` (~02:30Z).
  - #1258 — 7 consecutive green days of the product-surface canary; any red resets the streak to zero; no code change owed once C1–C5 are healthy. Owner: `product-canary.yml` (~06:15Z + post-deploy).
  - #1260 — 100% caught + 100% clean (16/16 + 47/47 shape), `invalid=0`, floors held; expected red until the reviewer catches every entry; floors are the regression bar, 100% is the closure bar. Owner: `cortex-bug-corpus.yml`.
  - #1305 — verdict gate green on the deployed fix, 2 consecutive nights; a red night resets the count. Owner: `cortex-verdicts.yml` (~03:00Z).
- Keep the three clock rules (red on the owning nightly resets THAT issue's counter for streak gates; threshold gates re-met per run with regression re-opening the issue; closure comment carries the `scenario:` id or metric evidence) and the action-on-red path (read `diagnostic-trace.md` first; PR-owner flag if merged <24h; P1 halts merges per BR#551).
- Implementation steps: no wording changes needed beyond the consistency checks in OQ-3/OQ-5/OQ-6/OQ-8 — v2 already encodes the per-issue semantics correctly.
- **In scope:** gate relationships, exact close criteria, clock/reset semantics, red triage path. **Out of scope:** new nightly automation, new issue assignment, changing which issue gates which.

### §4 Case-(c) receipt template (per BR#551)
- Keep the template fields: PR → main with base verified from `origin/main` (fresh fetch, never a transient branch); main state GREEN verified by ancestry; receipts (1) pre-existing red CI links with ISO8601 timestamps predating the diff, plus reproduced-on-bare-main or a green-run-on-sibling-PR citation for the intermittent-infra class, (2) diff-untouched proof (`git diff --name-only origin/main...<branch>` + explicit statement that none of the red checks' subsystems are touched), (3) each red tracked as an existing open issue or filed in the same breath, (4) review verdict approved/non-blocking or a rebuttable SP-only refusal, (5) `<!-- review-judgement ... -->` block in the merge comment.
- Keep the exclusions: reds caused by red main wait for the hotfix; any check that might be caused by the diff → stop and ask.
- Implementation step: cite BR#322 (accepted — #2042 merged past two proven pre-existing/unrelated required-CI reds) as the worked example instead of introducing a second template format; keep BR#551 verbatim as the policy source.
- **In scope:** template completeness, the merge prohibition on unproven reds. **Out of scope:** relaxing the policy, inferring receipts, approving unproven reds.

### §5 Sweep checklist for wave 5 (nightly catches)
- Keep the five steps: identify scope (release-cluster vs nightly-gated) → check prior-nightly history → bisect if new → triage (new regression: alert PR owner, halt merges in the cluster per BR#551; pre-existing: confirm known, update the issue, reset that issue's streak/counter per §3) → log to the #2025 hotfix thread or `BR#262` (dispatch log).
- Implementation step: make the step-4 "reset per §3" pointer explicit per issue (streak gates #1258/#1305/#1107 vs threshold gates #1260/#1523/#1361/#747) so the sweep and §3 use the same reset vocabulary.
- **In scope:** triage steps, logging destination. **Out of scope:** fixing regressions, running bisects, recording live receipts here.

---

## 2. Open questions and coordination dependencies (with owners)

- **OQ-1 — issue-number ambiguity in §2 (owner: BR#552 author + coordinator).** The §2 row reads "#1470 — OSI pruning staleness". The tracked pruning-staleness evidence family is GH#1474 (`docs/analysis/gh1474-pruning-staleness-evidence-map.md`; BR#55), while BR#24 tracks a separate #1470 staleness-wiring item (`propagate_staleness` has zero production callers — wire the entity-regeneration call site). Confirm which issue the row denotes before the runbook is finalized; the observable (routing-key staleness at 0) must match the actual fix's acceptance.
- **OQ-2 — second hotfix lane missing from §1 (owner: coordinator Ray / BR#552 author).** BR#551 (accepted, updated 2026-10-19 after the v2 draft) names TWO hotfix gates: #2025 (PR #2030, canary) and #2045 (PR #2052, deploy green), and its second rule — merge only when main **deploys green** — is broader than the runbook's "main green verified by ancestry". Decide whether §1's prereq records both lanes (and the deploy-green gate) or cites BR#551 by reference. Accepted decisions are settled; the runbook must not contradict BR#551.
- **OQ-3 — #1939 feed still drained in production (owners: BR#918, BR#919 claimants; X1-B follow-through BR#142/BR#826).** The #1939 fix is merged (X1-B receipts: PR #1966 merged; BR#826 verify done), but BR#918 reports the review-latency feed drained with harvest not appending (156h stale) and BR#919 reports `REPOS_TABLE` secret unset (meta-review harvest down 4 nights, ledger starving). §3's #1939 close gate ("one clean post-merge nightly on main proves it") is not currently achievable until BR#918/BR#919 land. Sequence the gate verification after those two tasks; consider referencing them in the runbook's evidence trail.
- **OQ-4 — #1361 wording is BR#141-settled (no action; recorded for traceability).** BR#141 (done) established #1361's acceptance: live verification of the feed + heartbeat scoring the current window, else report BLOCKED on #1939 (its PRs #1970/#1972 merged). v2's #1361 row already matches that state — the runbook should cite BR#141's receipts rather than re-derive them. Owner of any residual wording: BR#552 author.
- **OQ-5 — #1523 tracked miss has live residual work (owner: BR#470 claimant).** The tracked miss 6faf19e2-run-view-additive-scope is an open analysis child (BR#470, todo), and the 2026-10-19 nightly receipt (BR#938) still shows the miss live (6faf19e2 MCP deadline; invalid=2). The #1523 gate must stay floor-based (`below_floor=FALSE`) — do not let the #1260 100% bar leak into #1523's close condition.
- **OQ-6 — #1305 chronic-red context is live (owners: BR#594 claimant; BR#260 in_review; BR#920 for the infra_failure class).** The 2-consecutive-nights streak for #1305 interacts with the dominant infra_failure review-defect class (BR#920) and the chronic verdict-gate reds under analysis in BR#594/BR#260. The runbook's reset rule is correct; the open risk is that infra reds keep resetting the streak for reasons outside the fix's control — the runbook may want a pointer to BR#920's classification so an infra red is triaged as systemic (P1) rather than charged to the fix.
- **OQ-7 — #1470/#1474 impl child is in flight (owner: BR#560, in_progress).** The §2 observable for the staleness row must stay consistent with the fresh TDD fix being built in BR#560 (unclaimed pruning-index publish + stale-manifest rebuild). No runbook edit needed now; the verify child of BR#560 will produce the receipts the §2 check will consume.
- **OQ-8 — nightly schedule-name/time drift (owner: BR#552 author).** §3 names `cortex-quality-daily.yml` (~03:30Z) for #747, while the QPS cron map (BR#67) lists bug corpus ~02:41Z, verdict ~03:00Z, meta-review ~04:06Z, canary ~06:00Z — no 03:30Z quality-daily slot. Re-verify the actual workflow names/times against `.github/workflows` before finalizing.
- **Process dependency:** parent `BR#552` is in_review (its verify child `BR#907` is done; the parent itself has not closed). This child makes no body edits — any edit the open questions motivate rides with the parent's review outcome. Note also that BR#554's first review round stalled (`BR#566` verify ended blocked on an unanswered ask, no receipts) and was watchdog-released; this document is the receipt trail for the re-run.

---

## 3. Exact acceptance criteria per subtree of the runbook update

**AC-1 Merge-order subtree.** Accepted when: (a) the sequence table encodes 0→3 in dependency order with #2025 as prereq; (b) main-green is required "by ancestry check, not the badge"; (c) the red-main prohibition and the hotfix-lane priority are stated; (d) no new issues are added and no ownership is reassigned; (e) BR#551 is cited as the binding source (and any BR#551-vs-draft divergence from OQ-2 is resolved in BR#551's favour). Out of scope: re-ranking, new issues, ownership changes.

**AC-2 Verification subtree.** Accepted when: (a) each of #1470, #1904, #1270 has one concrete observable target exactly as specified (routing-key staleness 0; verdict-axis alignment Tier B/C; `PENDING`/`ERROR` during purge + row deletion post-success conditional on `status_flow_id`); (b) the FlowTracker-only status-write invariant is stated; (c) the staleness row's issue number matches the tracker (OQ-1 resolved); (d) no implementation detail or new diagnostic path is introduced. Out of scope: executing verification, new debug workflows.

**AC-3 Nightly-gate subtree.** Accepted when: (a) each of the eight issues has its exact close condition and owning nightly as listed in §3 above; (b) the three clock rules are present and per-issue (no shared clock); (c) the #1939→#1361 precondition is explicit; (d) the action-on-red path names `diagnostic-trace.md` first, PR-owner flag <24h, and the BR#551 P1 halt; (e) the #1939 gate acknowledges the BR#918/BR#919 feed residuals (or the runbook's evidence trail links them). Out of scope: new automation, re-gating, changing gate ownership.

**AC-4 Case-(c) subtree.** Accepted when: (a) all five receipt fields are present (pre-existing red CI links with predating ISO8601 timestamps + bare-main reproduction or green-sibling citation; diff-untouched proof with `git diff --name-only` output and the explicit subsystem statement; tracked-issue citation; review verdict; review-judgement block); (b) the "not case-(c) material" exclusions (reds-from-red-main; any possibly-diff-caused red → stop and ask) are stated; (c) the base is verified from `origin/main` fresh fetch, never a transient branch; (d) BR#322 is cited as the worked precedent. Out of scope: relaxing the policy, inferring receipts.

**AC-5 Sweep subtree.** Accepted when: (a) all five triage steps are present in order (scope → history → bisect → classify → log); (b) the classify step distinguishes new regression (alert owner, halt merges in the cluster) from pre-existing (update issue, reset that issue's counter per §3); (c) the reset pointer matches §3's per-issue vocabulary (streak gates vs threshold gates); (d) the logging destination is the #2025 hotfix thread or `BR#262`. Out of scope: fixing regressions, running bisects, live receipt gathering.

---

## 4. Explicit non-goals of this child

No edits to the runbook body (`BR#552`); no merges, deploys, or GitHub actions; no verification work or live receipt gathering; no PR creation or status change on the parent; no claim on any referenced issue. This document and the `BR#554` task body are the entire deliverable.
