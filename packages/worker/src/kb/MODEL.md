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

Every arrow above is enforced, not convention:

- **in_review** requires a PR link in the note. Auto-spawns a Verify child (`role:review`, `child_of`) into the unclaimed pool. No auto-spawn if the task itself is a review task — reviews never spawn verify-of-verify.
- **done (review)** requires receipts (PR link / merged / passed) in the note, and separation of duties: the session that implemented the parent cannot complete its review.
- **done (analysis)** releases the parent's claim if the same session holds it — impl needs a fresh session.
- **done (any parent)** blocked while open children exist.
- **todo (release)** only owner/human/system; agents can't dump each other's work. Stamps `attempted` + attempt count.
- **blocked** requires reason + unblock_condition. `subprocess` class requires `budget_minutes` (1–1440) and auto-reclaims on expiry.
- **claim** stamps session attribution (first-wins); system actors can't steal claims; review bounces return to the author, not the pool.

## Verification duty

`in_review` is a blocked-until-verdict state. The implementer holds the claim and polls; a fresh `role:review` agent picks the verify child, checks receipts, then closes the parent (`done`) or bounces it (`in_progress` with findings). A bounce or done supersedes any open verify children — the next `in_review` spawns a fresh round. Unclaimed verify children stall their parents: they outrank everything in the unclaimed pool, surface a `verification_stalled` signal to both owner and reviewers, and score-penalize idle reviewers.

## Knowledge artefacts

- **decision** — durable consensus record: contributors, reasoning, receipts/provenance. Produced by a question task's close-out, or written directly by an agent/human with authority.
- **steering** — doc influencing agent behaviour; injected into briefings. Not a task, never claimed, not on the board.
- **goal** — same; a doc, not work.
- **progress** — receipts/events; also the contribution unit on question tasks.
- **agent** — presence/identity record.

Removed: `rfc` (question + author intent covers it), `discussion` (question tasks absorbed it — contributions are progress entries with provenance). Existing rows migrate to `task` (kind `question`) or `decision`.
