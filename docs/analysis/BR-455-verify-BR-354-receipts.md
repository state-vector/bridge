# Verify record BR-455: BR#354 evidence map — verdict BOUNCE (1 false receipt)

- Session: `verify-455-evidmap-20261020` (agent opencode-ray, fresh session — separation of duties held; BR#354 analysis was session `br-355-analysis`/`ses_ea98f4486ffeoULsCTDe2zQMmx`)
- Verify target: BR#354 "BR#54 analysis child: knowledge-edge write loss evidence map" (body refreshed 2026-10-20)
- Verify duty: BR#455
- Verdict: **BOUNCE — BR#354 → in_progress**. All 5 duty checks pass with live receipts; the map's central verdict and remaining-open-half stand. But receipt #2 of the map ("provenance-stamp residue FIXED") is contradicted by live state of `origin/main` (sp repo): the cited fix commits do not exist in the repo and the CortexInference/KnowledgeLink misroute persists on main. Narrow, actionable correction required.
- Date: 2026-10-20 · Repo receipts run live via `gh` + `git` against `state-vector/superpositional` (`sp/main`, fetched this session).

## Duty checks (all 5 PASS)

1. **PR #1516 — PASS.** `gh pr view 1516 --repo state-vector/superpositional`: `state=MERGED`, `mergedAt=2026-10-09T05:36:55Z`, `mergeCommit.oid=650a7c805d5e6167f39f57ced2773d0331585b37` — matches the map exactly. `packages/lambda-lodestar-writer/src/knowledge_edges_test.rs` present on `sp/main` (`git ls-tree`); same-tx staging corroborated on main: writer `lib.rs:1961` logs `KnowledgePut: item edges staged with the item (same tx)`; module included at `lib.rs:51-52`.
2. **PR #1555 — PASS.** `gh pr view 1555`: `state=MERGED`, `mergedAt=2026-10-11T04:43:09Z`, `mergeCommit.oid=30731c8b2000b46227f59db0f9442bf20ba07c79`, `reviewDecision=APPROVED` — matches the map exactly. Repo-containment filter corroborated on main (`packages/lodestar-api/src/staleness.rs` walk: `from_item.partitions.get("repo") == source_repo`).
3. **Gap-def claim — PASS.** `git grep -n propagate_staleness sp/main -- packages/` returns definition (`lodestar-api/src/staleness.rs:82`), re-export (`lib.rs:104`), and tests (`staleness_properties.rs`, `knowledge_edges_test.rs`) — **zero production callers** on main, exactly as the gap-def comment (GH#1470, 2026-10-19T23:32:22Z) states and as the map records. No wiring PR has landed (`gh pr list --state open --search "1470"` → empty), consistent with the map's "REMAINING open half".
4. **No forked lane — PASS.** GH issue-claim receipt verbatim on GH#1470: comment 2026-10-19T23:52:18Z by rayh — `<!-- issue-claim status: active agent: opencode-ray/fix-1470-wiring-1019 started: 2026-10-20T00:00:00Z branch: fix/1470-staleness-wiring -->`. Issue #1470 still OPEN, unassigned; no open PR for the wiring. Supersede links live on Bridge: BR#354 `supersedes` BR#355 (out-relation confirmed) and BR#456 `supersedes` BR#353 (out-relation confirmed); BR#456 remains the single canonical review lane (todo, unowned). The analysis child creates no competing lane.
5. **Separation held — PASS.** BR#6 (`embeddings`/`dim`) appears in the map only under "Distinct, do-not-conflate" as a separate KB maintenance defect; it is never cited as evidence of edge loss. Mirrored in BR#456 checklist item 5.

## FINDING (the bounce): map receipt #2 is false on main

Map claim (receipt 2): *"Provenance-stamp residue FIXED (2026-10-14, commits `a0fc8bd71`/`89b3f3928` per issue comments): inline edge path stamps `EdgeProvenance::KnowledgeLink` (lib.rs:1938), killing the CortexInference/KnowledgeLink misroute."*

Live receipts contradicting it:

- **`a0fc8bd71` and `89b3f3928` do not exist in the repo**: `gh api repos/state-vector/superpositional/commits/{89b3f3928,a0fc8bd71}` → HTTP 422 "No commit found for SHA" (GitHub resolves short SHAs; these resolve to nothing — they are not on any ref).
- **No remote branch carries them**: `git ls-remote sp 'fix/1470*'` → empty. The 2026-10-14 session committed in a local worktree on another host (`/home/hermes/wt/1470-staleness-wiring`, per GH#1470 comment 2026-10-14T06:34:15Z "Part A fix committed") and never pushed; the milestone's promised scoped green run / push never landed.
- **Main still stamps CortexInference on the inline KnowledgePut edge path**: `lib.rs:1942` `"provenance_type": overseer_types::EdgeProvenance::CortexInference.as_str()` (inside the joinable edge push that closes with the same-tx log line). `git grep -n "EdgeProvenance::Knowledge" sp/main -- packages/` → hits only in `parquet.rs:514/1693/1759` (batch path).
- **The standing test on main pins the wrong (current) behaviour**: `knowledge_edges_test.rs:117` asserts `provenance == "cortex_inference"` — the red test demanding `knowledge_link` (a0fc8bd71) was never merged.
- **History check**: recent commits touching writer lib.rs (via `gh api commits?path=...`) end at `7c4fdda84` 2026-10-19 — none corresponds to the cited fix SHAs.

Materiality: the misroute is **non-gating for staleness** (no provenance filter in the walk — GH#1470 comment) and does not touch the map's central verdict (write-half fixed via #1516/#1555; remaining open half = wiring, owned by fix-1470-wiring-1019). But the map is an evidence document for parent closure; it must not carry a false "FIXED" receipt. Required correction of receipt #2 (by the map author or a follow-up session): re-word to "provenance-stamp fix committed locally 2026-10-14 (`a0fc8bd71`/`89b3f3928`) but **never pushed/merged — not on main**; inline path still stamps CortexInference on main (`lib.rs:1942`), standing test asserts `cortex_inference` (test:117); misroute OPEN on main, non-gating for staleness, fold into the fix-1470-wiring-1019 lane's scope (part A)".

## Supporting receipt — the 2026-10-19 verification pass comment exists verbatim

GH#1470 comment 2026-10-19T23:32:22Z: "Verification pass (2026-10-19 ~23:30Z, deploy `5b11b1d50` green on dev 21:22Z + 21:55Z) … Staleness propagation — NOT live. The acceptance item 'staleness propagation live check' cannot be met because there is nothing in production to check … zero callers." — the map's claims 3/4 and the gap-def framing are faithful to this source. (Datadog figures not independently re-verified this session; receipt-of-record accepted as the issue comment.)

## Out of scope (held)

No code changes to superpositional, no re-opening of analysis, no wiring implementation. This record + the Bridge verdict are the deliverable (rule 7).
