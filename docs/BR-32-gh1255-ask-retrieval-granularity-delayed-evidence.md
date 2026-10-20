# BR#32 — GH#1255 ask answered wrong on a healthy index: impl merged; delayed-evidence state of record (live 2026-10-20)

Parent: BR#32 (#qps GH#1255, Track A, gtm-blocker + issue:quality).
Failure mode of record: **retrieval granularity on long entities** — per the accepted analysis
child BR#584 (receipt-backed; superseded the earlier wrong-layer guesses). The ask-side
`ContentLiteralSearch` + focus-window + verbatim-symbol work (A1, 642228e1) and the
**sub-entity chunking impl (PR #2014 → main `e4502500e`, MERGED 2026-10-17T06:28Z)** are done.
This session re-verified the three delayed-evidence steps live (`gh`, 2026-10-20) and found the
acceptance state unchanged: **2 of 3 acceptance facts met**; the third (EventBridge rule in
`infra/hermes.ts:168-181`) is still unreachable because **the replacing re-index (#1980) has not
been re-attempted since the embed-barrier failure**. No superpositional code was edited (code
lives in `state-vector/superpositional`; this worktree is the receipt vehicle).

---

## 1. Delayed-evidence ledger (live receipts 2026-10-20)

| Step | State | Receipts |
|---|---|---|
| 1. Deploy picks up chunking | **DONE** | Deploy Dev green through 2026-10-19T23:35Z (runs 39326956236 `23279339`, 39331254505 `5b11b1d5`, 39342522950 `64b54c9d`); Product Surface Canary 2026-10-20T02:51Z run 39361155981: `C6.deploy_lag PASS — deployed 64b54c9d132c`, deploy train 4 pass / 0 fail. Chunking (e4502500e) + embed fix (#2059 `92f47fe48`) are all in dev. |
| 2. Replacing re-index re-chunks unchanged files (incl. `infra/hermes.ts`) | **NOT RE-RUN** | Last attempt FAILED 2026-10-17T12:33Z (embed barrier wrote 0/114744 slots → `IndexingFailed`, redrivable). Root cause #2031 = **operational** SQS→Lambda delivery stall, not a code defect; fix PR #2059 MERGED 2026-10-19T12:13:06Z (merge commit `92f47fe48`, full CI green incl. Rust Tests + Lodestar Integration); #2031 CLOSED. **No re-index re-attempt recorded on #1980 since** (last comment on the issue is still 2026-10-17T12:33:31Z). Owner-gated per the BR#255 operational runbook (Ray go before execution). |
| 3. Nightly records `c3a-ask-requeue-budget-recall` GREEN | **RUNNING / RECORDED, FLOOR PENDING** | Nightly Cortex Bug Corpus 2026-10-20T02:41Z (run 39360302092): `c3a-ask-requeue-budget-recall — verdict answered in 22824ms`, recording **kept** (keep list, 60 entries). Its `must_name` floor carries a pending-recording date of **2026-11-15** — enforcement begins on the first nightly after the re-index completes. Note: that run's `go-to-market gate not met: caught 13/21, clean 53/58 (below_floor=false)` is the GH#1260 **review** battery, not the ask path. |

Canary workflow conclusion is green on recent scheduled runs (39361155981 2026-10-20T02:51Z and
the ~hourly predecessors) — the run record shows the deploy-train battery (C5/C6) green; C3
ask-path acceptance for THIS issue remains measured by the `c3a` replay + the three-facts bar,
not by workflow colour.

## 2. Acceptance state

- **Fact 1 — re-dispatch event named** (`Overseer.PrReviewRequeued`): MET (live ask trace
  `27512736` 2026-10-19, wave3-stability-1026c).
- **Fact 2 — requeue budget named** (`RequeueBudgetChoice`, `requeue_count < 3`,
  `States.MathAdd` carry-over, FlowTracker non-ownership): MET (same trace).
- **Fact 3 — EventBridge rule in `infra/hermes.ts` named**: NOT MET. The follow-up ask was
  confidently wrong (claimed `LodestarFlowWatchdogSchedule` in `lodestar.ts` — fabricated;
  trace `6b6110d2`). Graph inspection: `infra/hermes.ts` has no adjacency coverage — unchanged
  files are only re-chunked by the replacing re-index.

## 3. What remains (all owner/CI-gated, none agent-runnable here)

1. **Owner GO for the replacing re-index** (#1980, runbook BR#255) — now unblocked at the code
   level: #2031 root-caused operational, #2059 merged, deploys green.
2. Nightly bug-corpus records `c3a-ask-requeue-budget-recall` with all three facts named
   (floor active 2026-11-15) and canary C3.a/b/c green (2-of-3 draws).
3. Then the parent closes **with those receipts** — not on a code-only verdict (BR#584 verifier
   recipe; BR#831's runner-self-closed verify is void per the BR#900 pattern and carries no
   verdict weight).

## 4. Residuals riding the same step

- Transient degraded caveat on ask #1 (graph enrichment timeout, 2 entities) — infra, recorded
  via review:judge; re-measure post-re-index.
- Misattribution class (fabricated `LodestarFlowWatchdogSchedule` ownership claim) rides the
  same missing chunk coverage for `hermes.ts`.

## 5. This session's disposition

BR#32 → **blocked-on-evidence**: the only remaining lever is the owner-gated re-index GO
(ask filed to the coordinator, bound to BR#32). Unblock condition: a successful replacing
re-index (#1980) post-#2059, after which the next nightly's `c3a` recording (or a live ask
naming all three facts) is the acceptance receipt that closes the parent with a fresh-session
verify.
