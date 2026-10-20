# Release-Cluster Runbook (Wave 4/5) — v2

**Status:** DRAFT (PREP-ONLY — no deploys, no merges)
**Context:** Ray's 35→0 issue countdown. Covers post-hotfix (#2025) merge sequencing, post-deploy verification, per-issue close gates, case-(c) merge receipts, and Wave 5 sweep triage.
**Authoritative Sources:** `BR#24` (Epic #1930 Taxonomy), `BR#262` (Dispatch Log / Gate Types), `BR#551` (Merge Policy Ruling — BINDING), `docs/repo-status-contract.md` (Status invariants), `docs/quality-testing.md` (Tier cadence).

---

## 1. Merge-Order Plan — BINDING POLICY (BR#551)

**Policy (Ray, 2026-10-19 — evidence-gated, no exceptions):**

1. **Never merge onto red main. Full stop.** When main is red, the train stops: the hotfix lane gets priority and everything else queues.
2. **#2025 (fixture drift) is the hotfix restoring green main and gates ALL merges** — not just deploys.
3. **Case (c) requires receipts.** The remaining reds must be PROVEN pre-existing AND unrelated to the diff — CI run links showing the failures predate the diff and are untouched by it. **"Looks unrelated" is not a receipt.**
4. PR nudges (#1970, #1972, #1984) either go green or attach case-(c) receipts; **reds caused by red main wait for the hotfix** — they are not case-(c) material.

**Sequence (Dependency-driven, once main is green):**

| Order | Issues | Rationale |
|---|---|---|
| 0 (Prereq) | #2025 | Hotfix lands. Main green verified (ancestry check, not the badge). |
| 1 (Release Cluster) | #1470, #1904, #1270 | Core stability + data-integrity fixes. Deploy-gated acceptance. |
| 2 (Nightly-Gated Primary) | #1939 → #1361 | #1939's gate is the precondition for #1361's gate (feed live before latency re-measure). |
| 3 (General Queue) | #747, #1107, #1523, #1258, #1260, #1305 | Each closes on its OWN gate (§3) — there is no single nightly clock. |

**Rule:** No issue merges if the issue is currently marked as *actively failing* (not pre-existing) unless the receipt requirements in §4 are met.

---

## 2. Post-Deploy Verification (Observable Output)

**Constraint:** "Pipeline ran" is not verification. Verification requires observable state changes in the deployment target or data layer.

| Issue | Verification Check | Target Observable |
|---|---|---|
| **#1470** | OSI pruning staleness | Routing key in Signal DB shows staleness at 0. |
| **#1904** | Quality fix | Review verdicts align with expected quality axes (Tier B/C). |
| **#1270** | removeRepo purge | Repo `status` transitions to `PENDING`/`ERROR` during purge; row deleted post-purge success (conditional on `status_flow_id`). |

**Invariants:**
- Status is written ONLY by FlowTracker (from `docs/repo-status-contract.md`).
- Ensure `status_flow_id` is respected during conditional writes.

---

## 3. Per-Issue Close Gates (General Queue + Nightly Primary)

**No single nightly clock.** Each issue closes on its own stated condition, verified against the nightly that owns it:

| Issue | Close Gate (exact) | Owning nightly / evidence |
|---|---|---|
| **#1939** | Feed refills on main: the nightly meta-review appends fresh records to `.quality/review-latency/latency.jsonl` and `review:metrics` scores a live window. One clean post-merge nightly on main proves it. Drain gate stays quiet (`checkLatencyFreshness` exit 2/1 not firing). | `meta-review.yml` (~04:00Z) |
| **#1361** | ≥95% of PRs get a verdict ≤5 min from push, re-measured on a LIVE-feed window; gated on #1939 green (feed live). Sub-conditions already met: no_verdict <5% (#1909, cleared BR#81) and base-invalidating concurrency capture (BR#86). Close ONLY after #1939 green + aggregate on-time ≥95%. | `meta-review.yml` latency scoring |
| **#747** | Insight floor holds deterministically: the php-sql-injection scenario's `system_insight_primacy` scores ≥ its floor (2) consistently across nightly quality-daily runs — no draw variance below the ratchet floor. Closes on fix merged + deployed + floor held on the nightly battery. | `cortex-quality-daily.yml` (~03:30Z) |
| **#1107** | Stale-evidence mis-anchoring family goes quiet: no new stale-evidence / wrong-diff-subject anchoring instances on nightly runs post-deploy. Closes on fix merged + deployed + nightly clean (recurrence resets the wait). | Verdict gate + corpus draws |
| **#1523** | Ratchet floors held: nightly bug-corpus runs report `below_floor=FALSE` and the tracked miss (6faf19e2-run-view-additive-scope, plus any recur) is cleared. The `gate_met` 100% red is #1260's bar, NOT #1523's — #1523 closes on floors, not on the full gate. | `cortex-bug-corpus.yml` (~02:30Z) |
| **#1258** | **7 consecutive green days** of the product-surface canary (product.md GTM gate item 2). ANY red run resets the streak to zero — including one blip. Streak-building only; no code change owed once C1–C5 are healthy. | `product-canary.yml` (~06:15Z + post-deploy) |
| **#1260** | Bug-corpus gate: **100% caught + 100% clean** (must_flag all caught, must_not_flag all clean — 16/16 + 47/47 shape), `invalid=0`, ratchet floors held. Expected red until the reviewer catches every entry; floors are the regression bar, the 100% gate is the closure bar. | `cortex-bug-corpus.yml` |
| **#1305** | Verdict gate green on the DEPLOYED fix: **2 consecutive nights** per the GTM gate. Counts the deployed reviewer, not local draws; a red night resets the count. | `cortex-verdicts.yml` (~03:00Z) |

**Clock rules (per issue, not shared):**
1. A red on the owning nightly resets THAT issue's counter to zero (for streak-based gates: #1258, #1305, #1107).
2. Threshold-based gates (#1260, #1523, #1361, #747) are met/re-met per run — no streak, but a regression (floor breach, gate drop) re-opens the issue.
3. Clock reaches the stated bar → issue is verified for closure; closure comment carries the `scenario:` id or metric evidence.

**Action on Red (any nightly):**
- Identify failing scenario/axis (read the recorded trace first — `diagnostic-trace.md`).
- If caused by a PR merged in the last 24h: flag the PR owner for priority fix.
- If systemic: open a P1 blocking further merges until resolved (BR#551 — main red = train stopped).

---

## 4. Case-(c) Receipt Template (per BR#551)

**Policy:** Never merge onto red main. Case (c) allows a merge with pre-existing, unrelated reds — but ONLY with receipts: CI run links showing the failures predate the diff and are untouched by it.

**Template:**
```markdown
### [Case-(c) Merge Request]
**PR:** <PR_ID> -> main (base verified origin/main, fresh fetch — never a transient branch)
**Main state at merge:** GREEN (verified by ancestry, not the badge)

#### Receipts (Required — BR#551):
1. **Pre-existing Red CI Links:** <Link(s) to failing CI run(s) on base main>
   - *Timestamp of Red:* <ISO8601> (must PREDATE the diff)
   - *Reproduced on bare main:* <run link with none of the diff applied> OR cited green-run-on-sibling-PR for the intermittent-infra class
2. **Diff-Untouched Proof:**
   - `git diff --name-only origin/main...<branch>` output
   - Explicit statement: the diff touches NONE of the subsystems the red checks exercise
3. **Tracked:** each pre-existing red is an existing open issue (cite it) or filed/receipted in the same breath
4. **Review verdict:** approved / non-blocking (or a rebuttable SP-only refusal with recorded judgement)
5. **Judgement record:** `<!-- review-judgement ... -->` block in the merge comment

#### Not case-(c) material (BR#551):
- Reds caused by red main → wait for the #2025 hotfix.
- Any failing check that is (or might be) caused by the diff → stop and ask.
```

**Worked precedent:** BR#322 (accepted) — PR #2042 merged past two proven pre-existing/unrelated required-CI reds (#1523 corpus + Lodestar infra) with receipts and a recorded review-judgement.

---

## 5. Sweep Checklist for Wave 5 (Nightly Catches)

**When a nightly catches a red past its wave:**

- [ ] **1. Identify Scope:** Determine if the failing test belongs to the Release Cluster or Nightly-Gated cluster.
- [ ] **2. Check History:** Was this test green in the previous nightly?
- [ ] **3. Bisect:** If new, identify the PR that caused the regression (via git bisect or merge history).
- [ ] **4. Triage:**
    - *New Regression:* Alert the PR owner. Halt merges in that cluster (BR#551: red main = train stopped).
    - *Pre-existing:* Confirm it's a known issue and update the existing issue with the new evidence (resetting that issue's streak/counter per §3 — streak reset for #1258/#1305/#1107, re-open-on-regression for threshold gates #1260/#1523/#1361/#747).
- [ ] **5. Log:** Record the outcome in the `#2025` hotfix thread or `BR#262` (Dispatch Log).

---

## Annex A — Known Open Questions (from analysis child BR#554)

Carried verbatim-in-substance from BR#554 (analysis, in_review; PR state-vector/bridge#25, `docs/analysis/BR-554-wave45-runbook-decomposition.md`). These are recorded for the runbook owner + coordinator to resolve; resolving them does NOT alter the binding §1/§4 policy text above. The v1-analysis sibling BR#555 is stale on §3 (it predates the v2 per-issue close gates).

| # | Open question | Owner / dependency |
|---|---|---|
| OQ-1 | §2 row "#1470 — OSI pruning staleness" vs the tracked GH#1474 evidence family (BR#55) and BR#24's #1470 staleness-wiring item — confirm the issue number before finalizing. | BR#552 author + coordinator |
| OQ-2 | BR#551 (accepted, post-draft) names a SECOND hotfix lane — #2045 (PR #2052) gates deploy green — broader than "main green by ancestry" in §1. Runbook must not contradict the accepted decision; cite BR#551 or encode both lanes. | Coordinator Ray / BR#552 author |
| OQ-3 | #1939 fix merged (X1-B, PR #1966; BR#826 verify done) but feed STILL drained — BR#918 (156h stale, harvest not appending) + BR#919 (REPOS_TABLE secret unset) own the residual; §3's #1939 close gate is unreachable until they land. Sequence gate verification after them. | BR#918 / BR#919 |
| OQ-4 | BR#141 (done) settled #1361's acceptance (PRs #1970/#1972; live-feed verification or BLOCKED on #1939) — cite its receipts, do not re-derive. | No open action |
| OQ-5 | #1523 tracked miss 6faf19e2 is live residual work (BR#470 todo; BR#938 nightly receipt still shows the miss, invalid=2). Keep #1523 floor-based — #1260's 100% bar must not leak into it. | BR#470 |
| OQ-6 | #1305's 2-night streak interacts with the dominant infra_failure class (BR#920) and chronic verdict-gate reds (BR#594 todo / BR#260 in_review) — infra reds should triage as systemic P1, not charge the fix. | BR#41 umbrella |
| OQ-7 | Staleness impl child BR#560 (in_progress) builds the fix whose receipts §2's check will consume — keep the observable consistent. | BR#560 owner |
| OQ-8 | Schedule drift — §3 names cortex-quality-daily ~03:30Z for #747, but the QPS cron map (BR#67) lists corpus ~02:41Z / verdict ~03:00Z / meta-review ~04:06Z / canary ~06:00Z. Re-verify workflow names/times before relying on them. | BR#552 author + coordinator |

---

## Change Log

- **v2 (this update):** §3 rewritten from a single "2-green-nights" clock to per-issue close gates encoded from each issue's own stated condition (BR#50, BR#40, BR#29, BR#47, BR#42, BR#41, BR#45, BR#81/86); §1 and §4 aligned to the binding BR#551 ruling verbatim (never merge onto red main; case (c) receipts = predate-diff + diff-untouched CI links; reds-from-red-main wait for the hotfix). §4 gains the BR#322 worked precedent; §5 step 4 aligned to §3's streak-vs-threshold vocabulary (BR#554 analysis); Annex A carries BR#554's open questions.
- **v1:** initial draft.
