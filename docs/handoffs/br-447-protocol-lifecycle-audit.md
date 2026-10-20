# BR#447 — BR#260 analysis child: protocol and lifecycle audit

**Parent:** BR#260 (batch E). **Session:** `BR-447-protocol-lifecycle-audit`. **Analysis-only:** no code changes, no impl/review children created (boundary pending coordination — see Overlap record).

Evidence base: this worktree (branch `bridge/BR-447`, cut at `456306b`) plus `origin/main` where noted. The live worker's orient text was captured this session and matches `origin/main` canonical — the deployed worker is not behind main.

## Findings

### F1 — Pinned protocol card is behind the canonical bootstrap (HIGH)
- Canonical: `packages/worker/src/kb/core.ts` `composeBootstrap` (PROTOCOL CARD line ~250 on main; line 250 at this base) — **6 steps**, including `4. LONG OP: declare silence — grace_minutes or subprocess-block with a budget` and `6. FINISH: ... a Verify task auto-spawns into the pool; a fresh-session verifier closes or bounces`.
- Mirror: `packages/adapters/bridge-protocol-card.md:13-21` — **5 steps**: no silence-declaration step, no Verify auto-spawn, no session-passing discipline, no scoring line.
- The mirror's own instruction (`bridge-protocol-card.md:32-33`) is "Update there first, then mirror here" — violated on every branch including `origin/main`.
- Impact: harness-spawned subagents that never call orient get the weaker card. The missing silence declaration is precisely the abandonment failure mode the watchdog counters (orient `my_score` this session: 87 watchdog-blocked tasks, 13 reassigned).

### F2 — Scoring line counts the wrong rule range (LOW)
`core.ts` Scoring line says "Raise it by following rules 1–8" but there are **9** rules (rule 9 = real progress or let go). Present at this base and on `origin/main`.

### F3 — Question-task encodings are split-brain on `origin/main` (HIGH)
Main introduced the kind model (`core.ts`: `TASK_KINDS = ["impl","analysis","review","research","question"]`, `taskKind()`, `isQuestionTask()`), but the gates still key on the legacy **tag**:
- Pool/orient side (`do.ts` ~line 1921 on main): `t.is_question = isQuestionTask(m) || t.tags?.includes("question")` — kind **OR** tag.
- Claim gate (`do.ts:1144` on main): `tTags.includes("question")` — **tag only**. A task with `meta.kind = "question"` and no tag is surfaced as non-claimable in the pool but its claim is not mechanically blocked.
- Watchdog auto-start (`do.ts:814` on main): `if (q.ok && !tTags.includes("question"))` — **tag only**. Logging progress on a kind-only question task auto-transitions it `todo → in_progress`, i.e. the sweep claims a task rule 6b says is never claimed.
- Live rule 6b text says "tasks tagged 'question'" — text and implementation disagree with the new kind model.
- Note: this branch's base predates the kind model; finding recorded against `origin/main` where the divergence lives.

### F4 — Lifecycle semantics: live rules ↔ code enforcement verified (OK)
Every live rule has mechanical enforcement (`packages/worker/src/kb/do.ts`, this base; main line numbers in parens where shifted):

| Live rule | Enforcement |
|---|---|
| claim → in_progress | claim semantics `do.ts:998-1010`; question gate `do.ts:946-948` (main:1144); operator gate `do.ts:951-955` |
| in_review carries PR link | `do.ts:962-966` (main:1163) |
| bounce in_review→in_progress requires findings | `do.ts:968-972` |
| blocked requires note + unblock_condition | `do.ts:973-978`; subprocess budget clamp 1–1440 `do.ts:988-994` |
| done requires review acceptance (role:review child or accepted decision) | `do.ts:938-942`; verify-parent lookup `do.ts:1040-1048` |
| review receipts required | `do.ts:1034-1038` (main:1272 — extended to role:unblock) |
| separation of duties (reviewer ≠ implementer session; analysis child done auto-releases parent) | `do.ts:1040-1048`, `do.ts:1053-1066`, claim-side `do.ts:930-934` |
| Verify task auto-spawns on in_review; stale round superseded on done/bounce | `do.ts:1097-1115`, `do.ts:1118-1131` |
| parent blocked by open children | `do.ts:1068-1075` |
| todo release owner/human/system only, stamps `attempted` | `do.ts:1015-1029` |
| transition map | `core.ts:39` `LIFECYCLES` |

No contradictions found between the live operating rules and the enforcement code on either base.

### F5 — Test coverage gap for the gates (HIGH for any lifecycle change)
- Tested: the pure transition map (`packages/worker/test/kb-core.test.ts:33-69`), bootstrap composition shape (`packages/worker/test/kb-auth.test.ts:60-68`), scoring helper (`kb-core.test.ts:157-178`).
- **Not tested**: every DO-level gate in F4 (PR-link, bounce-findings, blocked reason+unblock, subprocess budget, receipt regex, both separation-of-duties directions, verify auto-spawn + stale-verify supersede, open-children parent gate, todo-release ownership). The bootstrap test does not pin rule text, so nothing catches F1/F2-style protocol drift.
- Expectation for lifecycle/protocol changes (this is the gap an impl child must close): DO-level vitest cases pinning each gate's error message; mirror card updated in the same PR; a text-pin test on `composeBootstrap` so the mirror and canonical cannot silently diverge again.

### F6 — The audit plan's own doc list is stale for this repo
- `.kiro/steering/*.md` (six files named in the task body) **do not exist in state-vector/bridge** — they belong to the superpositional repo's steering set and are unreachable from this worktree.
- The authoritative bridge-repo protocol/lifecycle set is: `packages/adapters/bridge-protocol-card.md` (mirror), `packages/worker/src/kb/core.ts` (canonical bootstrap, `LIFECYCLES`, role playbooks), `packages/worker/src/kb/do.ts` (transition gates, verify spawn), `packages/worker/test/kb-core.test.ts`, `packages/worker/test/kb-auth.test.ts`.
- `packages/site/content.md` (the delivery contract's docs-ride target) does not exist at this base; it exists on `origin/main` (packages/site). In this repo the docs-ride target is `README.md` + the mirror card.
- Analysis-child deliverable convention here: `docs/handoffs/br-<task>-<slug>.md` via PR — precedent PR #17 (BR#435: `docs/handoffs/br-435-batch-e-handoff.md`, open, unmerged).

### F7 — Overlap check (batch-E verdict/report area)
- BR#257 (E: REPORT): `todo`, **unowned** — report DONE, PRs #2005/#2007/#2015 merged per receipts (BR#258 progress, BR#435 handoff).
- BR#260 (parent): `in_review`, owner MacBook-Pro; its verify child BR#901 is done. BR#435 (BR#257 analysis child): `in_review`.
- No open implementation work in batch-E verdict/report semantics was found. This audit's scope (bridge-repo protocol/lifecycle docs) is disjoint from verdict/report semantics by construction — no fork.
- Coordination ask filed: **ASK-mvg1jb99-bo82** → bridge-mac-ray (open artefact census + objection check before any impl child is created). Not blocked on it for this analysis.

## Open questions from the task body — answered

1. **Authoritative lifecycle semantics?** Code, not prose: `LIFECYCLES` + `composeBootstrap` + `DEFAULT_ROLE_PLAYBOOKS` in `core.ts`; enforcement in `do.ts` `transition()`. The mirror card is the only protocol prose and it is stale (F1).
2. **Repo tests covering state transitions / verification receipts?** Transition map only (`kb-core.test.ts:33-69`). Zero coverage of receipts/gates/verify-spawn (F5).
3. **Does BR#260 need precedent beyond the overlap check?** No — PR #17 (`docs/handoffs/`) is the established analysis-child convention; the code receipts above are sufficient.
4. **Additional open batch-E artefacts?** None found (F7 census); final confirmation pending on ASK-mvg1jb99-bo82.

## Recommended implementation children (NOT created — boundary pending ask)

- **IC1 — protocol-card sync:** update the mirror to the canonical 6-step card, fix "rules 1–8" → "1–9", add the bootstrap text-pin test (F1, F2, F5). Docs + test only.
- **IC2 — unify question encodings:** route claim gate + watchdog auto-start through `isQuestionTask()` (kind OR tag), reconcile rule 6b wording (F3). Tests for both encodings.
- **IC3 — gate-level test coverage:** DO-level tests for the F4 table's gates (F5).

## Out of scope here

Code changes; impl/review child creation (awaiting ASK-mvg1jb99-bo82 boundary confirmation); parent BR#260 lifecycle changes; verdict/report semantics (BR#257/BR#435 territory).
