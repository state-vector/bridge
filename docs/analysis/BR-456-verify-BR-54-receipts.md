# BR-456 — verify BR#54 receipts (GH#1470 knowledge-edge grounding fix)

Verify duty for **BR#456** (canonical review child of **BR#54**, supersedes BR#353; refreshed 2026-10-20 against the 2026-10-19 gap-def).
Session: `BR-456-review-verify-1020` (fresh session — no analysis/impl on this task in this session).
Date of checks: **2026-10-20**. All receipts below were collected live (`gh`, `git` against `sp/main` = `state-vector/superpositional` origin/main, local FS).

## VERDICT: BOUNCE — parent BR#54 must NOT close

Receipts #4 (write half) and #5 (separation) hold. Receipts #1 (wiring merged), #2 (live observation), #3 (t+24h canary) are **unmet**. The scope guard is explicit: search-only or function-level receipts do not close the parent — the issue acceptance demands the wired trigger observed live.

## Checklist

### 1. Wiring half merged — **FAIL**

- `git grep -rn propagate_staleness -- packages/` on `sp/main` (fetched 2026-10-20): exactly 3 hits, all inside `packages/lodestar-api` — `lib.rs:104` (pub-use re-export), `staleness.rs:51` (comment), `staleness.rs:82` (definition). **Zero production callers outside lodestar-api + tests.**
- Wider grep (no path filter): every other hit on main is a test (`packages/lambda-lodestar-writer/src/knowledge_edges_test.rs:191,238,394` — calls the function directly), a review-judgement metadata record (`.quality/review-judgements/records/2026-10-10T11-47-57Z-judge-pr-1555-7f9d.jsonl` — which itself records *"propagate_staleness has no production caller"*), or a bug-corpus fixture replay.
- **No wiring PR exists**: `gh pr list --state all --search staleness` returns only MERGED #1516/#1555; `--state open` shows no 1470 PR; `--state closed --search "1470 in:title"` → only the two merged PRs.
- **The branch was never pushed**: `git ls-remote sp refs/heads/fix/1470-staleness-wiring` → `couldn't find remote ref`.
- **CI**: not applicable — nothing was opened to run.

### 1b. Immaterial-to-verdict finding: the impl exists locally, unpushed (actionable)

- Local worktree `/Users/rayhilton/Projects/state-vector/superpositional/.worktrees/fix-1470-staleness-wiring` holds branch `fix/1470-staleness-wiring` at **`176f193e0`** — *"writ(lodestar): wire the propagate_staleness call site at entity regeneration (GH #1470)"*, author detached-cody, clean tree, **ahead 1 / behind 1** vs origin/main (based on `64b54c9d1`, the currently deployed dev SHA — a current baseline, needs rebase before PR).
- Content verified: production call `lodestar_api::propagate_staleness(...)` at `sfn_write/knowledge_staleness.rs:228`, driven from `sfn_write/supersede_files.rs` (new `superseded_entity_ids_vec` reading the durable supersede plan) via `sfn_write/mod.rs:94` dispatcher arm; new module `knowledge_staleness.rs` (+615); infra/lodestar.ts +12; red-first test **`the_staleness_trigger_is_wired_into_the_dispatcher`** in `harness_step_coverage_test.rs` (source-scan pin: dispatcher must call `knowledge_staleness::propagate_for_changed_entities` at the supersede arm); docs updated.
- This satisfies *nothing* in checklist item 1 (not pushed, no PR, no red-first naming in a PR, not on main) — but the work is real and should be pushed + PR'd rather than redone. The `fix-1470-wiring-1019` lane (issue #1470 claim 2026-10-19T23:52Z, session `bridge-mac-ray-cli` per BR#54 last progress ~2026-10-20 13:25Z "await integration suite, then docs + commit + PR") evidently died before push — same ENOENT-mid-run pattern as other 2026-10-20 sessions.

### 2. Live half observed — **FAIL (structurally unmet)**

- Latest dev deploy: `gh run list --workflow=deploy-dev.yml` → run 39342522950, head **`64b54c9d`**, success, 2026-10-19T23:35:31Z (prev: `5b11b1d50` 21:55Z, `23279339c` 21:22Z). All from main — code with zero `propagate_staleness` callers.
- On main every producer writes staleness fields empty (`contracts/src/lodestar_message.rs:1271,1736` → `stale_since: None`; `functions/resolvers/issue.ts:523`, `workspace-memory.ts:150` → `""` — per the 2026-10-19 verification comment on #1470). Nothing sets them on entity change.
- No Datadog or `scripts/lodestar-repl` receipt of a knowledge item's `stale_since`/`stale_reason` being set exists anywhere (issue #1470 has no comment after 2026-10-19T23:52Z). A positive live receipt is **impossible** while the wiring is unmerged — the deployed stack runs the unwired-handler shape (`.kiro/steering/wiring-verification.md`).

### 3. Canary t+24h — **FAIL (not reached)**

- The 2026-10-16 coordinator plan on #1470 orders: deploy green → staleness propagation live check → **then** t+24h canary. The live check (item 2) is unmet, so the plan's canary leg has not started.
- The "product-surface canary green twice today" note in the 2026-10-19 comment is the generic product-surface canary (BR#50 lane), **not** the #1470 t+24h canary — do not conflate.

### 4. Write-half receipts still hold — **HOLD**

- **PR #1516** state MERGED 2026-10-09, mergeCommit `650a7c805d5e6167f39f57ced2773d0331585b37` — edges staged atomically with the item. https://github.com/state-vector/superpositional/pull/1516
- **PR #1555** state MERGED 2026-10-11, mergeCommit `30731c8b2000b46227f59db0f9442bf20ba07c79` — repo-contained staleness boundary. https://github.com/state-vector/superpositional/pull/1555
- Standing test on sp/main: `an_entity_change_finds_the_grounding_edge_through_the_engine_and_marks_the_knowledge_stale` at `packages/lambda-lodestar-writer/src/knowledge_edges_test.rs:265` (doc-ref at :159). Present.
- Live write-half Datadog receipts (issue #1470 comment 2026-10-19T23:32Z, rayh): 56× `KnowledgePut: item edges staged with the item (same tx)` in 48h on deployed writer `5b11b1d50…`, plus the designed WARN path for non-entity edge targets.

### 5. Separation held — **HOLD**

- BR#6 (`embeddings`/`dim`) appears nowhere in the receipt trail as evidence for edge loss. The 2026-10-19 comment explicitly separates mechanisms ("the writer's *generation* staleness gate … is a different mechanism — scope-level row retirement, not derivation-lineage knowledge staleness marking"). BR#353's ACCEPT (2026-10-20) checked the same. Held.

## Scope-guard compliance

- Not closing the parent on search-only receipts — this record **bounces**.
- Not merging or closing past a red pipeline — no pipeline exists for the wiring half.
- Out of scope respected: wiring implementation stays with `fix-1470-wiring-1019` (branch pointer in §1b); analysis stays with BR#354.

## What closes the parent (unchanged, per the 2026-10-19 gap-def)

1. Push `fix/1470-staleness-wiring` (commit `176f193e0` exists locally, §1b), rebase on current main, open the PR naming the red-first test, CI green.
2. Merge → `git grep -rn propagate_staleness -- packages/` on origin/main shows ≥1 production caller outside `lodestar-api` + tests.
3. Deploy → live receipt (Datadog or `scripts/lodestar-repl --org superpositional --tier remote --stage dev`) of a knowledge item's `stale_since`/`stale_reason` set after a change to its grounding entity.
4. t+24h canary green per the 2026-10-16 coordinator plan.
5. Re-verify this checklist (fresh session) → close BR#54.
