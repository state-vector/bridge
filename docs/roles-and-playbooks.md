# Roles & playbooks — the agent-lane contract

The contract for the three agent lanes (`role:analysis`, `role:impl`, `role:review`): what
each lane does, what it must not do, where the text lives, and how it is set and changed.

Settled 2026-10-20 in the BR#139 dogfood lane (analysis children BR#556 + BR#557; this file
is the implementation receipt). This doc is a **mirror** — on any drift, the code wins the
way the protocol card's own rule works: *update there first, then mirror here*.

## Source of truth (settled)

| Layer | What | Where |
|---|---|---|
| Hub defaults | The three role playbooks, versioned with the server | `packages/worker/src/kb/core.ts` → `DEFAULT_ROLE_PLAYBOOKS` |
| Per-hub overrides | `settings.roles.{analysis,impl,review}` — editable in the admin settings page | KnowledgeHub DO settings store (`admin.settings_set`); blank value = reset to hub default (`resolveRolePlaybook`) |
| Enforcement | Pickup gates, qualification, separation of duties, verify auto-spawn | `packages/worker/src/kb/do.ts` (transition guards; the server, not client protocol) |
| Subagent prompt seed | The pinned protocol card, copied verbatim into subagent prompts | `packages/adapters/bridge-protocol-card.md` (mirror; canonical text composes from `composeBootstrap` in core.ts) |

The settings-only question (BR#556, open question 1) is settled as **defaults + override
surface + mirrored doc**: defaults ship with the server so every hub behaves sanely out of
the box; overrides let a hub tighten a lane without a code change; this page mirrors the
contract for repo-local visibility. The protocol card keeps its job (deterministic
subagent seed) and is not replaced by the playbooks.

A review lane as a dedicated child task **every time** (BR#556, open question 3): yes —
and the server already does it automatically. Any `task → in_review` transition spawns a
`Verify: <task>` child tagged `role:review`; a fresh session must verify with receipts
before the parent can be done. Publishers can stack extra bars with `await: ["role:review"]`.

## The lanes (checkable terms — mirrors `DEFAULT_ROLE_PLAYBOOKS`)

### `role:analysis` — decompose, don't build
- Starts: orient, read the parent + related knowledge; coordinate via ask_agent instead of
  forking overlapping work.
- Does: unqualified todo is gated to this lane on purpose; analyse, then decompose into
  child tasks (`child_of` the parent), one per coherent unit, each tagged with the role
  that should pick it up and carrying concrete checkable acceptance criteria in its body
  ("done when X" plus what is OUT of scope). A vague child task is a defect — rewrite it
  before finishing.
- Qualifies the parent by completing a `role:analysis` child; honours requested bars by
  creating the matching `role:review` child.
- Must not: implement the children; transition the parent to done.
- Closes: when the analysis child is done and the parent is ready for a fresh impl session.

### `role:impl` — build
- Starts: orient, claim the qualified child, read the analysis receipt and any linked
  review constraints.
- Does: the scoped work only; hands over at a natural stopping point.
- Must not: self-approve done; perform the review verdict on its own work; leave the
  parent's state machine to chance (hand off properly).
- Closes: `in_review` with the PR link in the note; stays owner until the verdict.

### `role:review` — verify
- Starts: orient, read the PR receipt and task history, check the actual state (merge
  status, PR, findings) before judging.
- Does: record a verdict against the existing receipts — decision artefact linked to the
  implementation, accepted or rejected with reasons; accepted verdict is what lets work
  complete.
- Must not: implement the fix; re-plan the work as a fresh analysis pass; verify without
  receipts (a review without receipts is rejected).
- Closes: parent done, or bounce `in_progress` with concrete findings for the author.

### Pickup and hand-off (all lanes)
- No lane does analysis, implementation, and review in one session — separation of duties
  is a server check, and a gate that rejects you means end the session, start a new one.
- No lane claims work already owned by another active session; coordinate first.
- If you cannot advance a claimed task this run, release it (`todo`, retry) — squatting
  starves the pool.

## Changing the contract

1. Edit `DEFAULT_ROLE_PLAYBOOKS` in `packages/worker/src/kb/core.ts` (or override per hub
   in admin settings → Roles & playbooks). Blank override = hub default.
2. Update the pinned card mirror if the shared protocol text changed
   (`packages/adapters/bridge-protocol-card.md`).
3. Update this page in the same PR. Tests: `resolveRolePlaybook` is covered in
   `packages/worker/test/kb-core.test.ts`.

## Roadmap decomposition receipt (BR#139)

The bridge roadmap, decomposed into bridgeable units (child_of BR#139, role-tagged,
acceptance criteria in each card body). Units that already have live cards are routed to,
not duplicated:

| Roadmap unit | Card | Role | State |
|---|---|---|---|
| Roles/playbooks contract: settings surface + this doc | child of BR#139 (impl slice) | `role:impl` | in_review — this PR |
| Mobile app (site "Coming soon") — decompose into impl slices | child of BR#139 | `role:analysis` | todo |
| Hosted version (site "Coming soon") — decompose into units, reconciled with the billing lane (TASK-004) | child of BR#139 | `role:analysis` | todo |
| Verify the roadmap slice set (pickable, non-overlapping, linked) | child of BR#139 | `role:review` | todo |
| Runner pipeline integrity (void receipts, self-verify) | BR#900 | role:review-qualified | existing card — do not fork |
| Proposed-decision consensus round | BR#903 | review-qualified | existing card — do not fork |
| Question → decision lifecycle wiring | BR#909 | review-qualified | existing card — do not fork |
| Verify-priority pool ordering | BR#337 | existing card | in flight |
| Board UX completion (in-board create/edit) | TASK-016 | existing card | existing card — do not fork |
| Protocol-card mirror sync + text-pin test (audit finding F1/F5) | pending boundary confirmation under BR#447 | `role:impl` | NOT carded here — boundary ask open; carding it would fork that lane |
