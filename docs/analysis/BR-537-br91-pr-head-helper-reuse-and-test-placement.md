# BR#537 — BR#91 analysis child: helper reuse and test placement decision

Role: analysis (no code changed). Answers the two residuals BR#484 ("re-review re-index head_sha resolution plan") left open for the impl child **BR#485**:

1. Is there an existing PR-head lookup helper in the producer/discovery path to reuse verbatim?
2. Does the regression test belong beside the current PR re-index tests or in a lower-level producer unit test?

All citations verified read-only against `state-vector/superpositional` `origin/main` @ **64b54c9d132c993d516fac31d73ed7ea01f56145** (post PR #1948 commit-1 merge; commit-2 producer fix NOT present — consistent with the BR#956 receipt trail).

## Verdict (TL;DR)

- **Helper: reuse `resolve_current_pr_head` verbatim** — `packages/lambda-extractor/src/lib.rs:1638`. It is the GH#1517 extraction-side head oracle, lives in the same file as the defective pr-mode branch, its signature matches the call site's types, and it already carries transient-failure semantics + unit tests. Do NOT write a new lookup.
- **Test placement: the regression belongs beside the current PR re-index tests** — the `run_indexing` soak/harness pr-mode scenario (`packages/lambda-lodestar-writer/src/bin/run_indexing/soak.rs`) — because the pr-mode branch of `handle_sp_indexing_path` is not unit-invokable (ambient Dynamo/EventBridge/ExternalQueue side effects inline) and the harness is the only tier that executes the real branch against a git fixture through the real workflow. Add a **source-scan wiring guard** in `lambda-extractor`'s `mod tests` (established `fn_body`/`include_str!` pattern) as a cheap pin on the resolve-before-discovery ordering. The helper itself needs no new unit tests (already covered at lib.rs:6231–6290).

## Q1 — The PR head resolution path: identified (helper exists)

### The failure chain (re-verified on origin/main)

Re-review → `build_reindex_normalized_event` (`packages/functions/overseer/logic.ts:305`) deliberately emits `head_sha: ""` (GH#1517 contract, documented in its doc-comment) → sp-indexing SFN `CloneAndDiscover` → `handle_sp_indexing_path` (`packages/lambda-extractor/src/lib.rs:4073`), **pr-mode branch** (`lib.rs:4260`):

```rust
let head_sha = input.head_sha.as_deref().unwrap_or("HEAD");   // lib.rs:4273
```

`build_reindex_normalized_event` sends `head_sha: ""` — an **empty `Some`**, not `None` — so the `unwrap_or("HEAD")` fallback never fires and `head_sha` is the empty string. It then flows:

1. `adapter.get_file_content(..., head_sha, ...)` — file content fetched at the empty SHA (secondary defect: silently wrong content);
2. output JSON `"head_sha": head_sha` (`lib.rs:~4396`) — the discovery output's head;
3. ASL `FanOutExtraction.ItemSelector` maps `head_sha.$: "$.discover.head_sha"` onto every batch item (`infra/sp-indexing-workflow.asl.json`);
4. `SfnExtractBatchInput.head_sha: String` (`packages/lambda-extraction-worker/src/lib.rs:634`) → `WriteEntitiesInput.head_sha` (`lib.rs:1287`);
5. `write_entities` guard refuses (`packages/lodestar-api/src/write_client.rs:1539`): `write_entities: head_sha is required` → `Overseer.FlowFailed`. Matches the PR #1901 evidence exactly.

### The reusable helper

`resolve_current_pr_head` (`packages/lambda-extractor/src/lib.rs:1638`), introduced by GH#1517 (commit `c4551c272`, reconciled onto the #1536 gate in `5a7b42919`):

- Signature: `async fn resolve_current_pr_head(adapter: &dyn GitHostAdapter, repo_ref: &RepoRef, repo_name: &str, pr_number: u64, flow_id: &str, token: &str) -> Result<String>`.
- Semantics already correct for this call site: oracle read with **transient** failure semantics (propagates so redelivery re-runs resolution — never a refusal), rejects an empty commit list loudly, logs the resolved head.
- It is already wired into the legacy SQS pr path `run_pr_extraction` (`lib.rs:1818`) with the documented **resolve-first** invariant: resolution precedes `ensure_context_matches_head` and file fetching, proven by the source-scan test `head_resolution_is_wired_before_the_freshness_gate` (`lib.rs:6875`).
- Types line up at the pr-mode branch: `git.access(...)` yields `GitAccess { adapter: Box<dyn GitHostAdapter>, token, .. }` (`packages/lambda-extractor/src/git_access.rs:25–26`); the branch already holds `repo_ref`, `pr_number: u64`, `run.flow_id`, `token`. `repo_name` is `input.repo_id` (`"owner/repo"` — same value `run_pr_extraction` passes).
- Adapter method: `list_pr_commits` is on the `GitHostAdapter` trait (`packages/git-host/src/lib.rs:255`) with the GitHub implementation at `packages/git-host/src/github.rs:1091`.

### Where the resolution belongs (and where it does not)

**In the pr-mode branch of `handle_sp_indexing_path` (SpCloneDiscover), before `get_pr_files`.** One resolution per run, at discovery; the discovery output's `head_sha` is already threaded by the ASL ItemSelector, so no workflow change is needed.

**Not in SpExtractBatch** (`packages/lambda-extraction-worker`): the batch handler is mode-generic, and per-batch re-resolution could observe divergent heads across the 20 concurrent batch items of one run (a push landing mid-run would split attribution). Resolution is a run-scoped decision; the discovery step is its owner. This also matches the parent task's stated fix boundary ("SpCloneDiscover (pr-mode discovery) must resolve the PR's current head from the git host") and the contract comment in `build_reindex_normalized_event` ("the extraction resolves the PR's CURRENT head from the git host at extraction time").

### One extra hazard the impl child should fix in the same edit

`unwrap_or("HEAD")` also misroutes the genuine `None` case: a literal `"HEAD"` string is non-empty, so it would **pass** the `write_client.rs` attribution guard and fabricate commit attribution to a non-commit token — the same data-integrity violation class the parent's DSL investigation called out (sentinel SHA). The fix should route **both** `None` and empty-string to host resolution, e.g. match on `input.head_sha.as_deref()` with `Some(s) if !s.is_empty()` as the only pass-through arm.

## Q2 — Test placement: beside the current PR re-index tests (harness tier) + a wiring guard

### Decision

Primary regression: **the `run_indexing` soak/harness pr-mode scenario** — `packages/lambda-lodestar-writer/src/bin/run_indexing/soak.rs` (`pr_input` at :450, used by the overlay scenario at :1446) — extended with a **re-review-shaped variant: `head_sha: ""`** (the exact `build_reindex_normalized_event` shape), asserting the discovery output's `head_sha` equals the fixture's PR-branch head and that the downstream batch writes entities attributed to it. Secondary pin: a **source-scan wiring guard** in `packages/lambda-extractor/src/lib.rs` `mod tests` asserting the pr-mode branch calls `resolve_current_pr_head` before `get_pr_files`.

### Rationale

1. **The pr-mode branch is not unit-invokable.** Inside the branch it constructs ambient clients (`DynamoClient::from_conf(ambient_dynamo_config())`, EventBridge publish, ExternalQueue emit) — the same limitation that forced the GH#1517 fix into source-scan guards for `run_pr_extraction` (see the comment on `head_resolution_is_wired_before_the_freshness_gate`, lib.rs:6875: "run_pr_extraction is not unit-invokable"). A pure unit test would have to mock the world or test a refactored shadow of the branch, which proves nothing about the shipped path.
2. **The harness is the established tier for exactly this.** `run_indexing` registers the real `lambda_extractor::handle_sp_indexing_path` with the `LocalRunner` and executes the real `build_sp_indexing_workflow` against a git fixture (run_indexing.rs:2087–2101). The existing pr-overlay soak scenario (soak.rs:1446) already runs clone/discover → extract → write end-to-end on the mocked/MinIO tier.
3. **The parent's red-first assertion is end-to-end by nature**: "re-review-shaped input must produce entities attributed to the git-host-resolved head." Only the harness tier can observe entities attributed to a head that the *input did not carry* — a unit test of the helper cannot catch a regression where the branch simply never calls it.
4. **Helper semantics are already unit-covered**: `resolve_current_pr_head_returns_the_last_commit_sha` (:6231), `..._propagates_oracle_failure_as_transient` (:6250), `..._rejects_an_empty_commit_list_loudly` (:6272), each with a mock `GitHostAdapter` implementing `list_pr_commits` (:6216). No new unit tests for the helper are needed; what is uncovered is the *wiring*, which the source-scan guard pins.
5. **Ruled out — the TS-side test files.** `packages/functions/resolvers/__tests__/repo-index-input.test.ts` and `pr-comment-dispatch.test.ts` cover event shape and dispatch routing upstream of the producer; the defect is in the Rust discovery branch, so Rust producer tiers are the right home.

### Harness prerequisite the impl child must expect

The soak adapter stubs PR reads with `not_discovery!` — `list_pr_commits` bails (`soak.rs:354`). The re-review-shaped scenario needs that stub to become a real oracle over the fixture (the fixture knows the PR branch head it created at soak.rs:1410–1421; `packages/git-host/src/plain.rs` bails on PRs by design, so the soak's own adapter is the right place — one method, same file, beside the current PR re-index tests).

## Concrete files the impl child (BR#485) should touch

| File | Change |
|---|---|
| `packages/lambda-extractor/src/lib.rs` (pr-mode branch, ~:4260–4273) | Route `None`/empty `input.head_sha` through `resolve_current_pr_head(adapter.as_ref(), &repo_ref, &input.repo_id, pr_number, &run.flow_id, &token)` **before** `get_pr_files`; keep the output `"head_sha"` key unchanged so the ASL ItemSelector threads it. Drop the `"HEAD"` fallback (attribution hazard). |
| `packages/lambda-extractor/src/lib.rs` (`mod tests`) | New source-scan wiring guard (pattern: `fn_body`/`include_str!`, precedents :6875 `head_resolution_is_wired_before_the_freshness_gate` and :8848 `the_lock_handler_is_the_only_generation_claim_site`): pr-mode branch must resolve the head before `get_pr_files`. |
| `packages/lambda-lodestar-writer/src/bin/run_indexing/soak.rs` | Re-review-shaped pr scenario (`head_sha: ""`) asserting discovery output head = fixture PR-branch head and attributed entity writes; replace the `list_pr_commits` stub (:354) with a fixture-backed oracle. |
| `infra/sp-indexing-workflow.asl.json` | **No change** — ItemSelector already threads `$.discover.head_sha`. |
| `packages/lodestar-api/src/write_client.rs` | **No change** — the :1539 attribution guard stays exactly as is. |

## Receipts

- superpositional `origin/main` = `64b54c9d132c993d516fac31d73ed7ea01f56145` (fetched 2026-10-20); every file:line above was read from that tree via `git show origin/main:` — no working-tree reads (the local checkout is on an unrelated branch with local modifications).
- `resolve_current_pr_head` provenance: `git log -S` → `c4551c272` (GH#1517) / `5a7b42919` (reconcile onto #1536 gate). No commit since touches `lambda-extractor/src/lib.rs`, confirming BR#956/BR#631: the commit-2 producer fix is not on main and BR#485 is still open work.
- This session changed no code in `state-vector/superpositional` (task contract: analysis only; no impl, no guard changes). The deliverable is this document.