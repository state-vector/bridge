# Bridge repo — engineering rules for agent sessions

## The working dir is the HUMAN'S — agent sessions work in registered worktrees (read this before editing anything)

Multiple agent sessions work THIS REPO concurrently — each in its own
registered worktree (rule 6). The checked-out working dir is the human's
local run space. Incidents already caused by ignoring this: a committed
feature reverted as "foreign WIP", a 22-file `add -A` sweep swallowing
another session's in-flight work, mid-chain branch switches landing commits
on the wrong branch, a column added to a table with no matching track (broke
the layout for three rounds while the owner probed their own stale
approximation of the markup), and a merged branch left checked out and
reused as a rolling base by three later tasks — the pile-up of foreign WIP
made the human's own `git checkout main` fail (2026-11-02).

Rules, in force:

1. **Verify by content, not by command success.** A green build/deploy
   proves nothing if another session mutated files mid-chain. After every
   build: grep the BUILT artifact for your change. After every deploy:
   grep the LIVE asset (curl the deployed bundle). Pipes mask exit codes —
   `cmd | grep foo` returns grep's status; check outputs explicitly.
2. **Stage explicit paths.** Never `git add -A` / `git add -u` in this
   checkout — you will commit someone else's half-finished work under your
   message. `git status` before every commit; if files you didn't touch
   appeared, leave them.
3. **Re-read before you build.** If your change is missing from the
   bundle, the source changed under you (it happened; the fix was present
   in source and absent from the deployed build). Re-read the file, rebuild,
   re-verify.
4. **Probe REAL markup, not your memory of it.** UI probes/DOM tests must
   be generated from the current component source (extract the actual
   JSX classes/structure), never hand-retyped approximations — they go
   stale the moment another session edits the component.
5. **The branch may not be what you left it.** Check `git branch
   --show-current` before committing; if your commit landed on a foreign
   branch, cherry-pick it to main via a throwaway worktree instead of
   switching the shared checkout.
 6. **All agent work happens in a registered worktree — never the shared
    working dir.** The checkout itself is the HUMAN's local run space: the
    human runs/reads code there (Ray directive 2026-11-02: "use worktrees
    for work, never the normal working dir; clean up worktrees after;
    leave working dir on main"). Agent sessions must not edit, build into,
    commit in, or branch-switch the shared checkout — not even "just a
    small change"; read-only probing (status/grep/gh) stays fine. Start
    every session's work by cutting a worktree off origin/main:

        git worktree add <abs sibling path> -b bridge/BR-<task> origin/main

    **Register it at creation** (this is the mechanical contract — the
    sweep enumerates REGISTERED trees only, an unregistered tree is never
    swept):

        mkdir -p ~/.bridge && printf '%s\n' \
          '{"path":"<ABS worktree path>","repo":"<owner/name>","task":"<BR#N>","ts":<epoch-ms>}' \
          >> ~/.bridge/worktree-registry.jsonl

    **Clean up before the run ends**: `git worktree remove <path>`; delete
    its branch if merged — the registry line prunes itself once the path
    is gone. **Leave the shared checkout on main and clean.** If it is off
    main or dirty when you arrive, do not work there and do not discard
    what you found: park the residue on a `wip/<task>-<date>` branch
    (BR#3204/BR#3633 law — never another session's discard), restore main,
    work in your tree. Abandoned trees are the #1 disk leak on this repo
    (185 strays / 471 GB observed on 2026-11-02; three stray trees plus a
    stale merged branch found the same day). The native gateway's workspace
    owner adopts registered interactive trees and owns dispatched allocations
    from creation through reclamation. It requires stopped-writer authority,
    verified source checkpoints and current-input/reader checks before removal;
    review status and age alone are never deletion authority. Retained work has
    an explicit reason and retry in `bridge workspaces status`.
 7. **Land direct to main.** Commit in your worktree, push straight to
    main — no PR round-trip, no merge-train wait (Ray directive
    2026-11-02: "EVERYTHING DIRECT TO MAIN"). The PR/verify ceremony is
    gone for this repo's day-to-day changes; main's mechanical gates still
    apply (signed commits, CI on the push). If main is red, land the fix
    first or hold — never stack work on a red main silently. Bigger or
    riskier changes still get a second pair of eyes — ask, don't assume.
 8. **Closed state machines, single source of truth, and end-to-end tracing
    (`.kiro/steering/state-machine-and-train-discipline.md`).**
    - **Trace end-to-end on turn 1:** Before proposing a fix for a stuck
      lane, banner, or ask, trace live GitHub/AWS state → executor
      (`train.rs`) → hub SQLite (`do.ts`/`core.ts`) → UI (`TrainPanel.tsx`)
      in one pass. Never peel the onion one symptom at a time.
    - **Make illegal states unrepresentable:** Model multi-phase lifecycles
      as closed discriminated unions in `@bridge/contracts` / `core.ts` and
      Rust `enum`s (`LanePhase`, `CandidateGatePhase`, `BaseRedEpisodeState`)
      with strong types — never bags of optional booleans, `any` casts, or
      title-scavenging regexes.
    - **Atomic persistence, no split-brain:** Every lane state mutation must
      persist unconditionally via `saveLaneState` (`lane_state` table + card
      mirror) — never skip SQLite writes based on whether a derived `reason`
      string changed.
    - **Self-heal mechanical work:** Conflicts, rebases, stale gate re-runs,
      and landing a verified root-fix PR through a circular base-red gate
      are 100% machine work — never punt them to the human.
 9. **Architecture-first repair is the default, not something the human must
    request.** Before adding a retry, recovery branch, watchdog or state store:
    identify the existing authoritative owner and trace its whole production
    path. Multiple competing owners or parallel recovery paths are a design
    defect to consolidate, not a reason to add another exception. State the
    surviving owner and the code being replaced; delete the superseded decision
    paths in the same change. Keep only evidence-preserving migration adapters,
    never two active authorities. Prove the complete workflow, including crash,
    restart and lost acknowledgements, rather than stopping at green component
    tests. Repeated incidents require a category-level repair before another
    symptom patch. Ask the human only for genuinely missing authority or a user
    preference, not whether to perform this engineering discipline.

The signature failure mode of this repo is not bugs in code — it is two
sessions each holding a stale model of the tree. Every rule above exists
to force your model to re-sync with reality before you act on it.
