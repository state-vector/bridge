# BR#602 analysis — GH#1523-specific corpus residue and escalation criteria

- **Task:** BR#602 (`role:analysis`, child of BR#47 — "#qps GH#1523 — bug-corpus ratchet regression (dev train red)")
- **Session:** `BR-602-analysis-1523-residue` (opencode-ray), 2026-10-20
- **Scope:** analysis-only. No code changes, no impl, no PRs to the product repo, no issue filing (trigger not met — see escalation rule). This record is the deliverable.
- **Evidence base:** Bridge knowledge/artefacts (BR#47, BR#470, BR#431, BR#827, BR#256, BR#69, BR#198, BR#262, BR#263, BR#968, BR#976) + live GitHub receipts pulled this session (issues #1523, #1981, #1260; run ids as cited).

## Residue in one sentence

**The current GH#1523 residue is exactly one item: the persistent bug-corpus miss `6faf19e2-run-view-additive-scope` (run-view-mode-discarded-by-scope-parser — findings fire but none names the defect), which is covered-but-unfixed (capability impl BR#256 slice 1 still unmerged) and whose escalation trigger (dedicated issue on post-landing recurrence) has not fired.**

## Current #1523 state (knowledge + Bridge artefacts + live receipts)

GH#1523 was filed 2026-10-09 after two consecutive red deploys + two red nightlies post-#1507 (issue body, live). It reported **two failure faces**:

1. **Bug-corpus ratchet (the face BR#47 tracks):** filing-time `BUG_CORPUS_RESULT caught=8 must_flag=11 clean=30 must_not_flag=30 below_floor=true` — caught 8/11 vs floor 9, i.e. a real floor breach, with 3 misses (`39efcc10`, `50e2f2c6`, `6faf19e2`).
2. **Product-surface canary, 6 FAILs at once** (C1.file_band, C2 orphan probes, C3 draws) — tracked under the **#1258 canary family** (C1 band fix merged PR #1994; C2 via #1980-B; C3 via #2014 + re-index), not here.

State at the task's cited receipts (BR#47 body, run 38672339217, 2026-10-15): **caught 13/15, precision 36/42, invalid 0, below_floor=FALSE** — floors met (≥9 caught, ≥26 clean), GTM gate not (15/15, 42/42); misses narrowed to the chronic pair `77ffa0a4-optimize-severed-wire` (#1792 Optimize JSONPath family, covered by BR#600) and `6faf19e2-run-view-additive-scope`.

Newer receipts (BR#968 / BR#976, proposed decisions, 2026-10-19/20): run 38841675704 = 9/16 + 44/47, invalid 1; **run 39191396217 (2026-10-19) = caught 14/19, precision 53/56, invalid 2, below_floor=false**, run ends "go-to-market gate not met". **Floors held on every receipt since filing — the ratchet breach itself recovered; the standing red is the designed `gate_met` 100% close-bar assertion (bug_corpus.rs:2314), not a floor regression.** Per BR#976: **no fix PR exists for GH#1523's ratchet regression**; the red remains red by design until the reviewer catches every entry (BR#42/#1260 continue).

Parent BR#47 recon (2026-10-20, session ses_ea8c83edfffenEd50ABusfw5Bt): the second #1523 face — the **Oct-17 corpus-integrity red from a missing recording** (`0f57330dc-supersede-key-set-boundary` referenced but never committed; 6 structural corpus tests red on main, reproduced on base) — **is repaired**: the recording now exists on main (56 recordings). Nightly still red Oct 16–19; run 39360302092 in progress at recon time; the parent owns classifying the latest run's misses/floors.

## Coverage of the shared miss family (the `6faf19e2` question)

**`6faf19e2` is ALREADY COVERED — no new child task, no issue filing from this task.** The trail:

- **Sibling analysis child BR#470** (BR#42's child, "residual coverage for 6faf19e2-run-view-additive-scope") concluded 2026-10-20: ALREADY COVERED, no new child, no issue filing — verified live in that session (BR#256 todo, impl-ready, human-accepted 2026-10-16). BR#470's analysis is complete in its body; it awaits its formal `role:review` round (todo).
- **The covering artefact is BR#256 slice 1** (#1981 non-diff callee tracing — reviewer capability gap: the severed-wire defect lives in code the diff doesn't touch; red-first corpus replay must go MISSED→CAUGHT, nightly toward the 100% close-bar, precision floor holds). BR#256 is the Bridge-side impl vehicle.
- **Shared-gap mapping receipts:** BR#431 (done — bug-corpus gap map: census of 6 misses + 3 false-flags + 1 invalid at the 10-17 nightly) and BR#827 (done — unblock audit recording both named misses' coverage with receipts).
- **GitHub side (live, this session):** the dedicated capability issue **#1981** — "Reviewer must trace non-diff callees to catch severed-wire defects (bug-corpus 6faf19e2/77ffa0a4 misses; #1260 capability work)" — was opened by rayh 2026-10-16T10:51Z and **closed by rayh as COMPLETED 2026-10-18T06:34Z**, with a Linear linkback (**SUP-1150**). Notably it was closed **while its impl (BR#256 slice 1) is still unmerged** and `6faf19e2` still appears in the 10-19 miss census — the issue closure tracks the Linear consolidation, not a landed capability.
- **Therefore `6faf19e2` remains tracked after BR#256 lands only through:** BR#256's own acceptance (MISSED→CAUGHT replay), the #1260 census, and this task's escalation rule. It is not "untracked", but its GH issue is closed — see OQ-1.

## Escalation rule (explicit + checkable)

Per rayh's on-thread commitment on #1523 (2026-10-15 comment: "`6faf19e2` still has no dedicated issue. If it misses again tomorrow I'll file it with the emitted-findings table") — that first escalation already fired once and was satisfied by filing #1981 (10-16). The rule going forward:

- **Trigger:** `6faf19e2` appears as a miss in a `BUG_CORPUS_RESULT` nightly run **after BR#256 slice 1's fix is merged, deployed to dev, and scored by that nightly** (i.e. the covering capability had its chance and the miss repeated).
- **Action on trigger:** file a dedicated issue **with the emitted-findings table** (per rayh's stated format), or **reopen #1981** — one artefact, not both (reopen preferred if SUP-1150 remains the canonical tracker; otherwise a new issue). Do not create a duplicate Bridge task; the miss family is already mapped here and in BR#470/BR#431.
- **No-trigger path:** if BR#256 slice 1 lands and `6faf19e2` goes MISSED→CAUGHT, the residue closes — no issue, no task.
- **Before landing:** a miss in any run prior to BR#256's merge+deploy does **not** fire the trigger (expected state, already tracked on BR#256/#1260/BR#470).
- **This task files nothing today** — the miss is pre-landing; coverage exists. (AC: "if it is already covered, no duplicate issue/task is created here" — met.)

## Relationship to the existing shared corpus-gap work (explicit)

- **#1260 overlap:** #1523's corpus face and #1260's battery are the same corpus and the same gate (`bug_corpus.rs`); #1523 is the dev-train-red/ratchet face, #1260 the GTM-gate close-bar push. Escalation ownership for `6faf19e2` lives here (BR#47 child) + the #1260 census; BR#42's family (BR#431 done, BR#470 pending review) owns the shared gap map. No duplication.
- **#1981 overlap:** direct — #1981 is the (now-closed) GH capability issue; BR#256 slice 1 is its impl. Closed-issue-vs-unmerged-impl is flagged as OQ-1, not fixed here (analysis-only).
- **#1870-family overlap:** adjacent, same corpus, different mechanism — #1870's recall-gap synthesis fix merged as PR #1946 (squash b5db6e6c, 2026-10-16, decision BR#181 accepted; #1870 CLOSED). The three recall flappers (`39efcc10`, `06c3ad92c`, `50e2f2c6`) were its designed beneficiaries; `6faf19e2`/`77ffa0a4` were explicitly NOT in its scope (capability gap, #1981). #1850 remains open under the #1580 family.

## Open questions

- **OQ-1 — #1981 closure validity:** #1981 was closed COMPLETED by rayh (2026-10-18) with Linear SUP-1150 linkback while BR#256 slice 1 is unmerged and `6faf19e2` still misses (10-19 census). Was this a deliberate tracker consolidation (GH → Linear) or a premature close? Determines whether the post-landing escalation reopens #1981 or files new.
- **OQ-2 — invalid-count trend:** invalid rose 0 → 1 → 2 across runs 38672339217 → 38841675704 → 39191396217. Is that #1523-ratchet residue or recording/infra noise? Parent BR#47's nightly classification (runs 39191396217 / 39360302092) owns it.
- **OQ-3 — canary half:** is any #1523-specific tracking needed for the issue's original canary half (6 FAILs post-#1507), or is it fully owned by the #1258 family (C1 via merged #1994; C2 via #1980-B; C3 via #2014 + re-index)? Current reading: fully owned by #1258-family work.
- **OQ-4 — stale BR#47 body:** BR#47's body still says "`6faf19e2` ... has no dedicated issue yet" — true at write time, superseded by #1981's filing+closure. Should the parent body be re-pointed to #1981/Linear SUP-1150 + this task's escalation rule?
- **OQ-5 — BR#470 formal close:** BR#470's verdict (ALREADY COVERED, next step none) is complete in-body but awaits its `role:review` round; when it closes, does it stand as the final coverage word for the whole 6faf19e2/77ffa0a4 family (this task assumes yes).

## Receipts

- Live GH (this session): issue #1523 OPEN (title/body/canary half; rayh 10-15 and 10-17 comments); issue #1981 (opened rayh 2026-10-16T10:51Z, closed rayh COMPLETED 2026-10-18T06:34Z, Linear SUP-1150 linkback); #1981 close event via GH API; issue search confirming no other dedicated `6faf19e2` issue exists (only #1523/#1981/#1260 mention it).
- Bridge artefacts: BR#47 (parent, live recon), BR#470 (sibling coverage verdict), BR#431 + BR#827 (gap map + coverage receipts), BR#256 (covering impl, todo/impl-ready), BR#600 (77ffa0a4 JSONPath coverage), BR#69/BR#198/BR#262/BR#263 (P2/P3 gates, #1981 filing, close conditions), BR#968/BR#976 (newest nightly receipts + BR#47 verdict-void process state).
- Run ids cited from artefacts: 37892449287/37893871480 (filing-time nightlies), 38672339217 (10-15), 38841675704 (10-17), 39191396217 (10-19), 39074339934 (missing-recording red, repaired), 39360302092 (in progress at parent recon).