# Bridge task model — authoritative

One task type, five kinds. Tasks are ephemeral work; knowledge artefacts are durable output; questions bridge the two.

## Task kinds

| kind | mode | pickup | output | completion gate |
|---|---|---|---|---|
| `impl` | exclusive | claim + session | PR | verify child done (receipts + separation of duties) |
| `analysis` | exclusive | claim + session | breakdown / notes | done; releases parent claim if same session |
| `review` | exclusive | claim (role:review) | verdict + receipts | receipts in note + SoD gate |
| `research` | exclusive | claim | knowledge artefact | done with artefact link |
| `question` | **open** | nobody claims — many contribute | decision / knowledge artefact | author judges sufficiency, writes decision |

`kind` lives in task `meta`. Computed traits: `is_claimable` (false for `question` and operator-gated tasks), `previously_attempted`, `verification_stalled`. Watchdog never sweeps non-claimable tasks.

## Task state machine

```
todo ──claim──▶ in_progress ──PR──▶ in_review ──verify done──▶ done
  ▲                 │  │               │                            (impl released)
  │                 │  │               └──bounce (findings)──▶ in_progress
  │                 │  └──blocked──▶ blocked ──unblock──▶ in_progress | todo
  │                 └──release (owner/human)──▶ todo (stamps attempted)
  └──expiry/abandonment (watchdog)──▶ back to todo (attempt count++)
```

Every arrow above is enforced, not convention — and all of it is ONE
executor: `machine.ts` holds a declarative rule table plus a total
`decide()` that returns `Applied(effects) | Rejection{code, rule, message}`.
`do.ts` persists the applied status, stamps `meta_patch`, and executes the
returned effects (spawn verify/unblock children, supersede rounds, escalate
to human, redirect releases). It never invents legality or a spawn decision.

- **in_review** requires a PR link in the note (BR#4494: the coverage-bounce self-heal's machine re-entry carries the PR link for exactly this gate — a link-less re-entry was rejected and stranded the card in the unclaimable `in_progress` stop-gap). The executor returns a `spawn_verify` effect (skipped when an ancestor is a review task or nesting would exceed the cap; reusing the open round instead of stacking when one exists). No spawn if the task itself is a review task — reviews never spawn verify-of-verify.
- **done (review)** requires receipts (PR link / merged / passed) in the note, and separation of duties: the session that implemented the parent cannot complete its review.
- **done (analysis)** releases the parent's claim if the same session holds it — impl needs a fresh session.
- **done (any parent)** blocked while open children exist.
- **todo (release)** only owner/human/system (`release-needs-ownership` table row); agents can't dump each other's work. Stamps `attempted` + attempt count. The executor decides churn: verdict duties escalate to a human at 3 releases (or 3 zero-output watchdog cycles folded from the version log); impl/analysis releases redirect to `blocked` at 5 (or 5 silent cycles). Completion resets the counter.
- **blocked** requires reason + unblock_condition. `subprocess` class requires `budget_minutes` (1–1440) and auto-reclaims on expiry. Blocked spawns an unblock child — capped at ONE open per parent (reuse over respawn, plus a 60m same-exit flood guard), decided by the executor. Merge-train parks spawn nothing: the train is the unblock path (BR#3516 §2) — both the train's own `merge_train` flag and an agent re-queue's canonical `merge-train:` note suppress the spawn (BR#4135: the missed note flavor made every re-queue spawn a child the next bounce superseded, and the re-park after it flood-guard on the stale stamp — a breach card per bounce cycle). BR#4282 sharpens both ends of that loop: a flood-guard skip carries `flood: true` — the dedup WORKING, audited observably, never folded into a breach card — and a resume (blocked → in_progress) CONSUMES the round by clearing `last_unblock_spawn`, so post-resume silence issues a fresh owned round instead of flood-guarding against a stamp whose duty no longer exists. The spawner-cap re-suppression is the same law (BR#4702): past UNBLOCK_SPAWN_CAP rounds the standing escalation owns the block, so every tick that re-suppresses under it audits `spawn_cap_skipped` — observable, never folded (specimen BR#3633: a steady-true atom raised one breach card on top of the escalation it already filed). The silence hold (BR#4067) has ONE carve-out (BR#4494): a train-bounce re-entry stranded `in_progress` (the prior executor dead, `in_progress` unclaimable) with `merge_train.state = bounced` is DEMOTED to claimable todo by the stall sweep instead of re-parked — bounced is the one train state whose next leg the train no longer owns; `queued`/`awaiting-ci` and parked-blocked cards keep the full hold (the carve-out keys on the sweep's `demote_bounced_reentry` flag + `in_progress`, stamped `bounce_reentry_demote` so scoring exempts it).
- **claim** stamps session attribution (first-wins); system actors can't steal claims; review bounces return to the author, not the pool.

## Breach door + replay

Post-write invariants run on the single write path. Every
`transition_rejected`, `invariant_violation`, `spawn_skipped` and
`replay_mismatch` event folds through `foldBreaches()` — one OPEN breach
card per `(task, class)` key (classes: same-gate rejection storms at 3
events; spawn-while-open, invariant violation and replay mismatch on the
first event). `replayStatus()` folds the version log's transition chain
forward and compares with stored state; a disagreement (or a broken chain)
is itself a breach. Breach cards are tasks tagged `breach:<class>`.

## Verification duty

`in_review` is a blocked-until-verdict state. The implementer holds the claim and polls; a fresh `role:review` agent picks the verify child, checks receipts, then closes the parent (`done`) or bounces it (`in_progress` with findings). A bounce or done supersedes any open verify children — the next `in_review` spawns a fresh round. Unclaimed verify children stall their parents: they outrank everything in the unclaimed pool, surface a `verification_stalled` signal to both owner and reviewers, and score-penalize idle reviewers.

## Knowledge artefacts

- **decision** — durable consensus record: contributors, reasoning, receipts/provenance. Produced by a question task's close-out, or written directly by an agent/human with authority.
- **steering** — doc influencing agent behaviour; injected into briefings. Not a task, never claimed, not on the board.
- **goal** — same; a doc, not work.
- **progress** — receipts/events; also the contribution unit on question tasks.
- **agent** — presence/identity record.

Removed: `rfc` (question + author intent covers it), `discussion` (question tasks absorbed it — contributions are progress entries with provenance). Existing rows migrate to `task` (kind `question`) or `decision`.
