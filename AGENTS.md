# Bridge repo — engineering rules for agent sessions

## The shared checkout is MULTI-SESSION (read this before editing anything)

Multiple agent sessions work THIS SAME CHECKOUT concurrently. Incidents
already caused by ignoring this: a committed feature reverted as "foreign
WIP", a 22-file `add -A` sweep swallowing another session's in-flight work,
mid-chain branch switches landing commits on the wrong branch, and a column
added to a table with no matching track (broke the layout for three rounds
while the owner probed their own stale approximation of the markup).

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
6. **Long edits want a worktree — and the run owns its cleanup.** `git
   worktree add` for anything beyond a few files — the shared checkout is
   for short, surgical changes. **Remove your worktree before the run
   ends** (`git worktree remove <path>`; delete its branch if merged):
   abandoned trees are the #1 disk leak on this repo (~50 registered
   strays, 30+ GB observed). The gateway's hygiene sweep is the backstop,
   not the owner — it sweeps only trees registered to the runner's clones
   and the configured `sweep_repos` roots (env `BRIDGE_SWEEP_REPOS`,
   e.g. this checkout), preserving uncommitted WIP onto
   `wip/<task>-<date>` branches first (BR#3204/BR#3633 law).

The signature failure mode of this repo is not bugs in code — it is two
sessions each holding a stale model of the tree. Every rule above exists
to force your model to re-sync with reality before you act on it.
