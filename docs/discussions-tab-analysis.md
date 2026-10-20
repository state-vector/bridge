# TASK-016 analysis child — threaded Discussions tab + response aggregation

**Task:** BR#540 · **Parent:** TASK-016 (Board UX pass) · **Constraint:** accepted decision BR#550 — "discussion tab = threaded question tasks", built against existing kbApi REST + WS, no ACP dependency.

This document is the analysis deliverable. It specifies what the Discussions tab renders, where every byte comes from, how responses are grouped and ordered, and what a verification receipt looks like. No UI is implemented here.

## 1. What the tab renders

The Discussions tab is a **threaded aggregation of question-tagged tasks and their responses**. There are no separate discussion cards: the standalone `type: "discussion"` artefact view currently implemented in `packages/webapp/src/components/DiscussionsView.tsx` (loads `kbApi.artefacts({ type: "discussion" })`, renders each as its own card) is **out of scope and must not render any rows in the new tab**. Standalone discussion artefacts are not a data source, are not grouped, and do not appear as cards, headers, or rows — even when the store contains them.

A **thread** = one question-tagged task. A **response** = one entry in that thread's response stream.

## 2. Data sources (all existing — no new endpoints required, one optional)

Everything the tab needs is already served by the human-plane kbApi (`packages/webapp/src/lib/kb.ts`) backed by the DO routes in `packages/worker/src/kb/do.ts`:

| Source | Where it comes from | Shape |
|---|---|---|
| Thread identity + root body | `kbApi.artefacts({ type: "task" })` / `kbApi.artefact(id)` | `KbArtefact` — `is_question` trait (or `meta.kind === "question"` / legacy `question` tag — see §4), `body_md`, `title`, `status`, `updated_ts` |
| `log_progress` notes | `kbApi.history(taskId)` → versions with `action === "progress"` | `KbVersion { seq, ts, actor, action, summary, data }`; `data` carries note/sentiment/gauges |
| Ask entries | `kbApi.history(taskId)` → versions with `action === "ask"` | `data: { to, question, options, urgency, ask_id }` |
| Answer entries | `kbApi.history(taskId)` → versions with `action === "answer"` | `data: { ask_id, answer }` — **excerpt only, ≤200 chars** (full text lives in the `asks` table, machine-plane only; see §7) |
| Explicit links | `kbApi.artefact(id)` → `relations[]` | stored relations (`relates`, `discusses`, `derived_from`, …) used for membership of non-history responses |
| Live refresh | `connectKbWs` events (`KbEvent.artefact_id`) | invalidate/refetch the thread whose id changed |

The server already writes ask/answer/progress into `artefact_versions` with the task's id (do.ts `askAnswer()` → `audit(actor, "answer", row.artefact_id, …)`), so **`get_history` on the question task is the single authoritative response stream** — exactly as the accepted decision BR#550 states.

## 3. Grouping rule (minimum, deterministic)

1. **One thread per question-tagged task, keyed by that task's artefact id.** No threading by title, tag cluster, or similarity.
2. **A response belongs to a thread only if** (a) it is a version row of that task's history (`action ∈ {progress, ask, answer}`), or (b) it is explicitly attached to that task — an ask whose `asks.artefact_id` resolves to the task, or an artefact with a stored relation pointing at the task.
3. **Cross-task commentary must not be merged** unless the stored relation (or the ask binding) points back to the same question task. A `log_progress` on a sibling task, a reply on a child task, or a decision that merely *discusses* the task is not a response.
4. **What counts as a response** (exhaustive list): `log_progress` notes on the task; answers recorded against asks bound to the task; ask entries themselves (the question side of the exchange). **Not responses:** unrelated progress rows, sibling-task replies, `type: "discussion"` objects, transitions, edits, gate events.
5. **Ordering:** render the question task body first, then all response items ordered by `ts` ascending, ties broken by `seq` ascending (both fields already exist on every `KbVersion`; `seq` is monotonic, so the order is stable and reproducible across fetches).
6. **Empty threads are deterministic, never omitted:** a question task with zero responses still renders as one row anchored by the question body, with an explicit empty/zero-response state (not a blank gap).
7. **Qualification is idempotent:** a task qualifies once even if it matches both `meta.kind === "question"` and the legacy `question` tag; `is_question` on the server (do.ts) already ORs these — the client should reuse the server trait.

## 4. Which tasks are questions

Use the server-computed `is_question` trait (`isQuestionTask(meta) || tags.includes("question")`, do.ts). Do not re-derive from title text or heuristics. Non-question tasks never spawn threads, even if they have heavy progress traffic.

## 5. Response rendering contract

Each response row shows: actor label, timestamp (`ts`), kind badge (`progress` / `ask` / `answer` / `linked`), and content:

- `progress` → the note text (`data.note`), sentiment chip if present.
- `ask` → the question text (`data.question`), addressed-to (`data.to`), linked to its paired answer by `data.ask_id`.
- `answer` → the answer text (`data.answer` excerpt) with the same `ask_id`.
- `linked` → artefact title + link for anything included via relation only.

A **flattened chronological stream** is sufficient for the first slice (see open question Q3 on nesting).

## 6. Receipts (concrete, for implementation verification)

1. **Aggregation fixture test (primary):** a pure aggregator module (e.g. `packages/webapp/src/lib/discussions.aggregate.ts`, unit-tested alongside a checked-in fixture of `KbVersion[]` + `KbArtefact[]`) given: one question task, two `progress` rows, one `ask` row, one `answer` row (answer `ts` *before* its ask's `ts` is not possible — audit order proves chronology), plus one unrelated `transition` row → renders exactly one thread; question body first; the four responses in `ts`→`seq` order; the transition excluded. A snapshot of the rendered row order is the receipt.
2. **Negative fixture:** the same store also contains a standalone `type: "discussion"` artefact → the aggregator emits zero rows for it; it appears nowhere in the tab.
3. **Empty-thread fixture:** a question task with zero response versions → emits exactly one collapsed/empty thread row anchored by the body.
4. **Cross-task fixture:** a `progress` row belonging to a sibling task id and an ask with `artefact_id` = sibling id → neither is merged into the question's thread.

The webapp has no test runner today; the mock hub (`packages/webapp/mock-hub.mjs`) can additionally serve a seeded scenario for a manual smoke pass. Whether the receipts land as vitest-in-webapp or worker-side tests is an implementation-slice decision — the receipt is the fixture + rendered-order snapshot, not the runner.

## 7. Edge cases and gaps found in the data (must be decided in the impl slice)

- **Answer truncation (known gap):** the human plane sees answers only as ≤200-char excerpts in the audit stream; full answer text is in the `asks` table, exposed only via machine-plane `ask.answer`/`ask.inbox` (label-scoped, not task-scoped). Options: render the excerpt, or add a small task-scoped human-plane asks read route (reads the existing table — **not** a schema migration).
- **History pagination:** `history()` caps at 200 versions per call. Long-running question tasks (question tasks accumulate hundreds of progress heartbeats) will exceed one page; the impl needs an initial-limit + lazy-load or explicit "older responses" affordance. The aggregation rule (§3.5) is unaffected — it orders whatever range is fetched.
- **System actors:** answers auto-resume blocked tasks and emit `system:decision(<actor>)` transition rows; these are transitions, not responses, and are excluded — but the ask/answer pair around them is not.

## 8. Open questions

1. **Cross-task responses that mention the question but lack an explicit relation** — excluded per §3.3 for v1. Should they be surfaced elsewhere as related-but-unthreaded items (e.g. via the existing `related` endpoint), or not surfaced at all? Recommend: not surfaced in v1; revisit with data.
2. **Empty-thread default state** — expanded (question body visible, "no responses yet") or collapsed placeholder? Recommend expanded for empty threads (the question is the only content; hiding it makes the tab look broken), collapsed for non-empty threads ≥ N responses.
3. **Nested ask depth** — is a flattened chronological view sufficient for the first implementation slice (recommended), or must ask/answer pairs render nested (answer indented under its ask, linked by `ask_id`)? The fixture in §6.1 should be chosen to work under either rendering decision.
4. **Answer-truncation gap (§7.1)** — excerpt-only v1, or add the small task-scoped asks read route? Recommend: excerpt-only for v1 (zero server change), read route as a fast-follow.

## 9. Boundary for the follow-on implementation task

In scope: replace `DiscussionsView.tsx` card list with the thread view per §§1–6; pure aggregation module + fixtures as receipts; reuse `kbApi` + `connectKbWs` only. Out of scope (per parent task): UI chrome beyond the tab, any schema migration, any new discussion-card model, ACP anything. Docs (README.md / packages/site/content.md) ride with the impl PR, since the tab's user-visible behaviour changes there — not with this analysis.
