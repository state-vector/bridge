# State Machine, Single-Truth, and Diagnostic Discipline (BR#6012)

## Why This Exists (2026-11-04 Outage Postmortem)

A stopped merge-train episode required six sequential rounds of fixes because:
1. **Onion-peeling instead of end-to-end tracing:** The initial investigation read only the surface ask/banner helper (`trainBaseRedAskBrief`) instead of tracing the full pipeline (`GitHub live runs` → `train.rs` executor → `do.ts` SQLite persistence → `TrainPanel.tsx` UI) in one pass.
2. **Kludge of conditionals over untyped JSON (`artefacts.meta`):** Multi-phase lifecycles (`stop`, `currently`, `queue_facts`, `now_action`, `fix_card`, `ask`) lived as independent optional fields in `artefacts.meta`, stitched together by regexes (`/\bfix\b/` grafting unrelated `fix(chat):` PR `#2555` onto `BR#5968`) and conditional fallbacks (`stop.culprit_task` shown as `WHAT FIXES IT`).
3. **Split-brain & conditional saves:** `laneSyncReason` only persisted `meta` to SQLite when `meta.blocked.reason` changed — so while `meta.stop` held `reason` constant, every `trainLease` `acquire` and `trainWatchSweep` `lease_lapsed` mutated `meta` in memory and dropped the write on the floor.
4. **Circular gates & punting mechanical work to the human:** Making `main`'s deploy health a required PR check blocked the very PR that fixed `main`, and the stopped lane returned early before checking queued PRs for conflicts — resulting in a human being asked to run `gh pr update-branch` on a `CONFLICTING` PR.

---

## Invariants (In Force)

### 1. Trace End-to-End Before Proposing or Coding (Zero Onion-Peeling)
- When a UI banner, ask, or pipeline is wrong or stuck, trace **every** boundary in a single diagnostic pass before writing code:
  1. **Live external ground truth** (`gh run list`, `gh run view --log-failed`, `gh pr view`, CloudWatch / DynamoDB).
  2. **Producer / Executor** (`train.rs` / `train_gate.rs` — what it read and what RPC it sent).
  3. **Storage & State Machine** (`do.ts` / `core.ts` — what SQLite table/column was written or skipped).
  4. **Consumer / UI Projection** (`TrainPanel.tsx` — how the stored state renders).
- Never trust a cached banner or card note as ground truth when live GitHub/AWS state is one command away.

### 2. Closed State Machines Over Conditional Kludges (Make Illegal States Unrepresentable)
- Multi-phase lifecycles MUST be modelled as **explicit, exhaustive discriminated unions (sum types)** in `@bridge/contracts` / `core.ts` and Rust `enum`s in `train_gate.rs`:
  - **`LanePhase` (`LaneStateRecord`):** `idle` | `draining_batch` | `settling_ci` | `stopped_red`.
  - **`CandidateGatePhase`:** `card_superseded` | `card_done` | `head_uncovered` | `mergeability_computing` | `conflicting` | `unverified_commits` | `unhandled_merge_state` | `mechanically_sound`.
  - **`BaseRedEpisodeState`:** `diagnosing` | `fix_in_progress` | `cure_pr_conflicting` | `cure_pr_merged_awaiting_ci` | `cure_pr_awaiting_force_merge` | `fix_exhausted`.
- **No ad-hoc boolean combinations:**
  - A `conflicting` PR can never reach `RerunGate`, `Note`, `Merge`, or `HumanLeg`; it transitions unconditionally to `Bounce(Conflict)`.
  - A `cure_pr_conflicting` or `cure_pr_merged_awaiting_ci` episode has `warrantAsk: false` and `curePr: null` by type — it can never fire or display a human bypass-merge ask.
  - Never use `any` casts on state-machine outputs in UI components (`TrainPanel.tsx`) or DO handlers (`do.ts`).

### 3. Single Source of Truth & Unconditional Atomic Persistence (No Split-Brain)
- **Canonical `lane_state` table:** Lane operational state (`phase`, `lease`, `last_capable_ts`, `stop`, `currently`, `queue_facts`, `now_action`, `base_red_resolution`) is persisted atomically via `saveLaneState` into the `lane_state` SQLite table (and mirrored to the lane card) on **every** lease, event, CI, and queue-facts mutation.
- **Never gate persistence on derived-string diffs:** A function that mutates state (`trainLease`, `trainWatchSweep`, `trainQueueFacts`, `trainEvent`, `trainCi`) must **unconditionally** persist the updated state to SQLite. Never rely on `if (meta.blocked?.reason !== reason)` as a side-effecting save gate.
- **No heuristic regex scavenging:** A root-fix card's cure PR comes only from its own unlanded, non-merged PR legs (or a queued card that itself qualifies as a root/base-cure card). Never graft one card's PR onto another card.

### 4. Self-Heal Mechanical Work; Never Deadlock on Circular Gates
- **Conflicts are 100% agent work:** Even while a lane is stopped, every tick runs conflict/rebase self-healing (`settle_window_rebase`) so any `CONFLICTING` queued PR is immediately trial-merged and bounced to `in_progress` for an agent to rebase and resolve. Never tell a human to run `gh pr update-branch` on a conflicting PR.
- **Circular-gate repairs request the owner's bypass:** a current-episode repair whose exact reviewed head is mergeable, signed, and settled with only circular base-health failures records `RootFixBypass`. The hub persists that evidence and creates one owner request with the PR and exact-head command. Pending checks, signing defects, stale heads and historical cures cannot reach this state. Normal merges resume only after a decisive passing deployment.
