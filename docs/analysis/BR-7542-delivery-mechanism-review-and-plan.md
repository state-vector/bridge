# Delivery mechanism: architecture review and structural repair plan

Status: **review findings and proposed plan; not an implementation-complete claim**.

Requested by Ray, 2026-11-07. Review task: [BR#7542](https://hub.fleetbridge.run/card/BR-7542).
Source baseline: [`4c1f82416e3551ff1c1a7c0a0f30b453a159f2fd`](https://github.com/state-vector/bridge/commit/4c1f82416e3551ff1c1a7c0a0f30b453a159f2fd).
Paths and line numbers below refer to that baseline, not the human's older checkout.

## 1. Verdict

The recent fixes repair demonstrated defects, but the delivery mechanism is not
structurally complete. Its main weakness is **overlapping authorities and incomplete
integration**: fenced execution, task lifecycle, runner-local bookkeeping, recovery
sweeps, and presentation each retain ways to decide what work means.

This allows four recurring categories:

1. **Activity becomes success:** process exit, output, a URL, or a completed
   diagnostic is promoted into a stronger delivery/recovery claim.
2. **Local waiting becomes global starvation:** preparation, checkpointing,
   finalization, coordination or one candidate blocks unrelated runnable work.
3. **Evidence is lost between phases:** a safe writer-stop receipt survives, but
   the result, continuation or its delivery obligation does not survive equally well.
4. **Recovery describes itself instead of repairing the fault:** loosely bound
   duties, retry caps and stale projections can leave a fault without an executable
   continuation, while still displaying reassuring activity.

The correct repair is to finish one bounded controller and one durable completion
protocol, make hub lifecycle transitions authoritative, and remove their competing
legacy paths. Preserve the useful fencing, checkpoint and receipt machinery already
present. Do not replace it with another parallel scheduler or recovery pump.

### Scope and method

Reviewed: native dispatch, transport/control polling, the new lifecycle registry,
checkpoints and stopped-proof outbox; hub eligibility, reservations, readiness,
execution reduction/finalization, review admission and watchdogs; train candidate
admission, batching, effect boundaries, recovery and persistence; shared status
contracts/UI; managed runtime adoption and health verification.

This is a code-path and receipt audit, with two executable contract probes and the
existing lifecycle tests. It is not a production chaos test or an independent
acceptance of BR#7500, whose separate review is BR#7510. No production worker,
claim, process, merge gate or required check was altered by this review.

## 2. External ground truth and limits

- The public `https://hub.fleetbridge.run/__version` returned the baseline commit.
  The preceding stateful `train_status.hub_commit` observation also returned it.
  This proves hub adoption, not the running native executable's version.
- Before this review, the scheduler reported capacity 20, held 3, eligible 19,
  readiness ready, and `dispatch_starved`. Review BR#7510's first reservation
  expired without starting; a later reservation did launch a model. See
  [the incident evidence](https://hub.fleetbridge.run/card/BR-7524).
- Another observation had all three models usable but gateway readiness in
  cooldown following an eight-second `execution/advertise` timeout. The public
  blocker called this model/capability unavailability. The probe below reproduces
  that classification error without contacting a live service.
- [Diagnostic BR#7472](https://hub.fleetbridge.run/card/BR-7472), history sequence
  569382, was closed done after exit zero with `MCP UNAVAILABLE: bridge tools missing`.
  BR#7500 now catches that sentinel; the general completion policy remains relevant.
- Superpositional PR #2343 merged as `b38a81d56` before BR#7500 landed. Its
  [Deploy Dev run 42315370489](https://github.com/state-vector/superpositional/actions/runs/42315370489)
  subsequently failed, including
  [Cortex Quality Smoke](https://github.com/state-vector/superpositional/actions/runs/42315370489/job/128233702310).
  The current product-red stop is distinct from the earlier green-base throughput
  stall. This review does not blame the product failure on the Bridge patch or
  propose merging ordinary changes through it.
- The exact same-host CPU/I/O cause of each historic launch delay and the actual
  native adoption SHA were not independently measured here. Blocking source paths
  and matching starvation receipts are confirmed; a complete causal performance
  attribution still needs phase timing from the running controller.

Existing work: BR#7501 owns the bounded gateway refactor, BR#6992 its operational
recovery, BR#7500/7510 the recent merge repair/review, and BR#7495 backlog lifecycle
repair. At the review snapshot BR#7501 was todo after a watchdog release, with
published primitives but no completed runtime proof. Original worktrees/WIP must
be inspected before any implementation ownership transfer.

## 3. Mechanism and authority map

| Boundary | Existing mechanism worth retaining | Required authoritative fact |
|---|---|---|
| Discovery → reservation | Hub eligibility, atomic slot accounting, replayable reservations | One reservation for task/session; no launch permission yet |
| Reservation → worker | Credential/readiness checks, fenced `begin`, checkpoint restore | Exact host/boot/task/session/generation/attempt and proved prerequisites |
| Worker → result | Local process-group proof, checkpoint, hub execution state | Durable process outcome plus an independently identified task outcome |
| Result → review | Completion contract and typed review results | Submitted artifact/outcome, exact content revision and review subject |
| Review → admission | Durable `delivery_admissions`, head-scoped verdicts/carries | Accepted PR/head or delivered main commit, not text proximity |
| Admission → merge → deploy | Lane lease, candidate gate, head check, merge receipt, decisive deployment | Exact base/head/batch, observed effect and matching deployment result |
| Fault → repair → recovery | Cause-specific recovery journals, retry receipts | One fault episode, its continuation and a satisfied recovery predicate |
| State → UI | Shared typed projections | Same facts/revision, with readiness, progress and completion kept distinct |
| Published → installed | Managed updater, embedded SHA, nonce/PID acknowledgement | Running build/protocol plus an observed useful-work canary |

## 4. Findings

P0 means false completion/effect responsibility can be lost. P1 means delivery can
stall, become misleading or fail to recover. These are architectural priorities,
not assertions that every potential failure has occurred in production.

### F1 — P0: the runner can still manufacture business completion

`packages/desktop/src-tauri/src/dispatch.rs:4324-4335,4477-4507` derives success
from `outcome.ok` minus a string blacklist, identifies review/analysis by roles and
title heuristics, and synthesizes `verified against: ... exit 0` as evidence. Even
an empty successful result is annotated `completed_result_lost` and continues
through the success handoff path. Missing-tool sentinel detection narrows one hole;
it cannot enumerate every failed/no-op/incomplete agent reply.

Hub defence remains incomplete: `kb/do.ts:6304-6311` validates `review_result`
**when supplied**, rather than requiring a typed verdict for every review close.
`contracts/src/work.ts:10-14` defaults an unspecified completion contract to
delivery. `kb/do.ts:13405-13408` retains live prose-based direct-main acceptance.
The stronger typed PR admission path at `kb/do.ts:7846-7937` is useful and should
become the model, not be removed.

**Invariant:** a runner may report process facts; only the authorised task/review
protocol can submit or accept an outcome. Exit zero with no valid outcome means
`result_missing`, never success. Compatibility notes cannot originate new acceptance.

### F2 — P1: the bounded controller exists but is not the running controller

`dispatch.rs:4137-4146` publishes periodic checkpoints on the controller thread.
`4246-4283` serializes terminal checkpoint publication, proof delivery and cleanup
before admission. `4763-4944` retains a separate resume/reclaim route; `4967-5015`
serializes reservation and preparation for fresh work.

The new `lifecycle.rs` has a sensible typed registry, independent preparation and
finalization limits, exact-owner release and four adversarial tests. At this
baseline every `Pipeline::new` reference is inside its own test module. There is
no native production invocation of the new `finalize` command either.

The new registry bounds job counts, not job wall time: `Job::drop` joins its
thread unconditionally (`lifecycle.rs:172-176`), and its `Held` phase exposes a
reason but no recovery transition. A stuck closure can therefore prevent shutdown;
a panic is safely retained but not yet given an executable reconciliation path.
These are integration/design obligations before adopting the primitive.

**Invariant:** the production controller performs bounded local state reductions
only. Slow I/O belongs to bounded phase jobs. There is exactly one owner registry
and one hub-selected admission route, including resumption and result reconciliation.

### F3 — P0: durable stop proof is stronger than durable result delivery

Finished workers are removed from `in_flight` before finalization. The captured
result is written through `write_task_state` (`dispatch.rs:2053-2059`), which uses
best-effort direct `fs::write`, without atomic replacement or a checked durability
barrier. A checkpoint/proof failure then drops the finished object after `continue`
(`4280-4283`). `stopped_outbox.rs` durably preserves quiescence facts, but not the
terminal result or its business disposition. Retaining local work is necessary,
but not equivalent to a replayable result-delivery obligation.

The new hub `finalize` receipt is a good primitive (`execution.ts:291-298`,
`kb/do.ts:5446-5494`). It is unwired. Its reducer currently allows a new `begin`
while a prior terminal result has no recorded disposition. Every non-interrupted
finalization of a current claim also spends the shared action budget, including a
process described as completed. These semantics need an explicit reconciliation
phase, rather than another model run that repeats the original work.

**Invariant:** before a terminal outcome leaves memory, its exact fence, outcome,
stop proof, preservation status and next delivery obligation are durably recorded.
Stop proof can free execution capacity independently of slow result delivery;
cross-host transfer still needs portable preservation. Unknown external effects
remain fenced. Reconciliation itself must not silently rerun the completed action.

### F4 — P1: priority is not enforced through the production control path

`dispatch.rs:4724-4726` returns when `in_flight` is already full. Its later
`request_capacity` branch (`4961-4965`) is therefore skipped for the normal
already-full entry case; it is reached when the earlier resume loop fills capacity.
Hub preemption is triggered by a scheduling request (`kb/do.ts:5055-5057`), so
testing that hub primitive alone does not prove a full gateway requests recovery.

The resume loop precedes hub priority selection. Also,
`recovery-capacity.ts:30-36` propagates critical-path priority only for rank 0/1;
rank-2 train diagnostic reviews become ordinary reviews unless explicitly classified.

**Invariant:** one hub priority law governs fresh work, resumptions, reconciliation
and reviews. A full controller still observes urgent recovery and requests a safe
handoff. No slot is freed until real quiescence; no preemption bypasses unknown effects.

### F5 — P1: ordinary coordination is a hidden stop/resume operation

The shared reducer distinguishes normal messages from interrupts
(`execution.ts:265-275,307-314`). Native `RemoteMessage` discards priority and
`permits_renewal` rejects **any** delivered message (`dispatch.rs:635-655`), causing
the maintenance loop to set `control.stop` (`671-684`). Thus a normal evidence
request can stop an otherwise healthy reviewer and force checkpoint/yield/relaunch.
BR#7510's normal coordination request and subsequent safe-yield history exhibit
this path. The safety fence worked; the progress interruption was unnecessary.

**Invariant:** informational delivery cannot revoke execution authority. Normal
messages are surfaced at supported safe points; explicit interrupts stop before
conflicting effects. If hot delivery is unavailable, disclose queued information
instead of treating all messages as cancellation.

### F6 — P1: failure scope is lost between readiness and task availability

`execution-availability.ts:33-47` filters non-ready hosts out of usable capability
and reports `capability_unavailable`, losing cooldown/drain/credential/transport
causes. The executable probe in section 5 confirms this with a usable model and
zero active workers. `dispatch.rs:499-505` also projects managed drain into model
unavailability. These collapses affect routing and UI, not just wording.

The runtime configuration-error path releases to todo and stores a local `gave_up`
flag (`dispatch.rs:4590-4608`); fresh reservations explicitly clear that flag
(`4992-4993`). Therefore its claim to avoid unchanged-host retries is not a durable
guarantee. Startup prerequisite fingerprints are a useful existing pattern, but a
worker that actually ran cannot be falsely treated as an unstarted attempt.

**Invariant:** failure has a closed cause, scope, input revision, retry rule and
continuation. Model health, gateway control readiness, task prerequisites, capacity
and retained-writer uncertainty stay distinct. Configuration faults re-arm only
when their relevant input changes or an explicitly bounded repair succeeds.

### F7 — P1: merge work is still not generally bounded or work-conserving

BR#7500 correctly fixes phase-C integration deferrals. Phase-A `Carry`, `Bounce`
and several candidate-local actions still release/end the walk
(`train.rs:3206-3342`), including after earlier candidates were collected but before
their batch could land. Generic `sh` uses unbounded `Command::output`
(`train.rs:421-437`); some Git plumbing bypasses it too. A hung command can hold
the train thread and later lanes, not just its candidate.

Current-base checks are essential: non-overlapping files do not prove semantic
compatibility. But after each merge, repeatedly integrating and retesting every
remaining head can turn a nominal batch into one merge per CI cycle. Fixing this
requires a tested integration/batch identity, not weakening the check.

**Invariant:** candidate-local deferral continues independent work within a bounded
pass; lane-global safety stops are explicit. Every external process/effect has a
deadline and exact head/base/lease context. Batch CI covers the exact cumulative
content admitted, and a changed base/head invalidates uncovered work.

### F8 — P1: recovery is coupled to presentation and has competing episode keys

`ensureLineRecovery` takes a UI `TrainLineProjection`, runs only for remediation
`attention`, then selects tasks by several subject/kind/episode fallbacks and a
count-based exhaustion cap (`kb/do.ts:14780-14854`). A finished candidate repair
can still become a non-executable blocked remediation when there are no ready
entries. A displayed queued/blocked duty suppresses this backstop regardless of
whether the underlying fault is progressing.

Starvation and generic recovery use different identities: starvation is anchored
to the last merge; generic no-progress recovery includes the base SHA. A merge
clears starvation even if it merely moves the bottleneck. Conversely, an old last
merge can make newly arrived work look immediately starved. Stage eligibility and
expected wait are not represented in that clock (`14098-14120`). Existing watchdog,
strand, merged-park, proxy, admission replay and diagnostic sweeps add more writers.

**Invariant:** a durable cause/revision-bound incident owns detection, continuation,
retry accounting and recovery evidence. UI is a read-only projection. A closed
diagnostic with an unsatisfied predicate cannot terminate incident ownership; a
changed symptom must not create an unbounded recovery-of-recovery chain.

### F9 — P1: claimed single-truth storage is still a writable mirror

`saveLaneState` writes card JSON and then `lane_state` (`10949-10977`), without an
explicit transaction in the helper. A caller may supply one, but the invariant
is not enforced at this boundary. Production source has an insert into
`lane_state`, but no select/join reading it as the operational authority.
Starvation writes card JSON directly (`14120,14213`), bypassing the advertised
single persistence path. A later status read may repair a mirror; that is not
atomic canonical persistence under faults.

**Invariant:** one versioned state record is authoritative; every command commits
its state, receipt and required outbox effects atomically. Card/UI mirrors are
derived and repairable, never an alternative command input. Choose and enforce
the authority rather than keeping two writable copies named canonical.

### F10 — P1: artifact location and runtime adoption are inferred too early

`verifyDutyBody` treats a commit URL as a declaration that code is already on main
(`kb/do.ts:357-365`). BR#7510 initially received that false premise for a published
checkpoint branch. Its instructions still require ancestry verification, which
limits harm; the source declaration is nevertheless false.

The updater already verifies manifests, hashes, embedded commits, nonce/PID idle,
doctor and stable process health (`updater/supervisor.py:132-175,239-283`). Keep these.
They do not demonstrate production dispatch/refill/merge behaviour. Hub deployment
and native rollout are separate, but capability advertisements do not expose an
adopted native build/feature set as a delivery acceptance fact.

**Invariant:** candidate published, main landed, CI verified, hub served, native
installed and useful-work verified are distinct milestones. A code-delivery review
cannot close a runtime recovery outcome. Feature/protocol adoption is observed,
not inferred from a green release or a restarted process.

## 5. Verification performed for this review

1. Ran `cargo test --manifest-path packages/cli/Cargo.toml lifecycle::tests -- --test-threads=1`:
   **4 passed**. These prove useful properties of the new component only; source
   reference inspection proves it is not wired into the production controller.
2. Ran a local Node probe of the actual shared `projectExecutionBlockers` function
   with one fresh host, a usable large model, capacity 20, active 0, and readiness
   `{kind:"cooldown",reason:"hub advertisement timed out"}`. Output:

   ```json
   {"kind":"capability_unavailable","reason":"unavailable","text":"Supporting gateways report the required model/capability unavailable."}
   ```

3. Ran the actual `reduceExecution` sequence: begin generation 1, finalize a
   process outcome, then begin generation 2 without terminal disposition. Output:

   ```json
   {"attempt_generation":2,"terminal_generation":1,"phase":"running"}
   ```

   This is a reducer-level admitted sequence, not a claim to have bypassed live
   authentication. It identifies a missing reconciliation invariant before the
   new finalizer is connected.
4. Searched production references: `Pipeline::new` occurs only in its tests;
   no native caller uses the new `finalize`; `lane_state` has no production reader.
5. Checked current GitHub deployment conclusions and public hub build identity.

The previous repair's 281 native tests, 129 worker/SQLite checks and green CI are
useful receipts, not fresh full-suite results from this review and not evidence
that these integration gaps are absent.

## 6. Proposed architecture and mandatory invariants

Use **orthogonal closed state machines**, not one enormous cross-product enum:

```text
Task:       runnable → claimed → submitted → accepted | findings | disposed
Attempt:    reserved → preparing → restoring/running → stopping → quiesced
Outcome:    absent → captured → submitted → reconciled | faulted
Delivery:   candidate → landed → CI-verified → required-runtime-verified
Incident:   detected → diagnosing → repairing → verifying → recovered | held
Readiness:  ready | cooldown | prerequisite-fault | draining | offline
```

Transitions carry exact typed references, never just timestamps or text. The hub
owns task/attempt/effect/incident legality; the native registry owns real local
jobs/process groups; the transport reports facts; the agent submits work; a fresh
reviewer accepts the exact work; the updater proves adoption. Their identifiers
are linked, not conflated.

1. **No inferred acceptance.** Every task has an explicit completion contract at
   creation/migration. Review and diagnostic outcomes are mandatory typed commands.
   A diagnostic may finish with findings while its incident remains open.
2. **One writer, one fence.** Task/session/host/boot/generation/attempt identify
   authority; stale responses cannot free, finish or mutate another attempt.
3. **Capacity conservation.** Reservations and all unquiesced writers count once.
   Stopped-but-unpublished work retains affinity; delivery backlog has a separate
   bounded budget. Never free capacity from lease expiry.
4. **One admission path.** Fresh execution, safe resumption, terminal reconciliation
   and recovery all enter the same hub scheduler with the same priority policy.
5. **Bounded controller work.** No filesystem scan, Git command, network call,
   process wait, checkpoint or callback may run unbounded on the controller thread.
6. **At-least-once facts, one accepted effect.** Persist operation intent and stable
   identity before effects; replay the same receipt after response loss/restart;
   reconcile unknown effects instead of assuming exactly-once network execution.
7. **Typed fault scope.** A task defect holds that task. A gateway prerequisite
   fault holds affected launches. A lane safety failure holds ordinary merges.
   All require an explicit predicate and responsible continuation.
8. **Fault priority is not a merge prohibition.** A no-progress incident gives
   recovery precedence while permitting otherwise safe independent merges.
   Actual base-red checks still inhibit ordinary merges. The verified root-fix
   route follows the existing qualified cure policy.
9. **Evidence closes recovery.** Heartbeat, retry, PR merge and task closure are
   different facts. Recovery closes only on its specified observed predicate.
10. **One projection.** Status, error, next action, counts and history come from
    the same authoritative facts/revision. Unknown or stale evidence stays unknown.

### Outcome protocol

Extend existing contracts/reducers; do not add an output-text parser as authority.
An agent submits an artifact, diagnostic findings, execution evidence or review
verdict through authenticated structured commands, bound to task revision and
attempt. A process terminal receipt records exit/transport/stop facts separately.
The runner cannot manufacture either a review verdict or a successful task result.

Terminal reconciliation first consumes a specific receipt id and records a
disposition: outcome already submitted, resumable work, prerequisite failure,
missing/invalid result, or unknown effect requiring reconciliation. A new business
attempt cannot silently skip this phase. Give recovery/reconciliation its own
bounded accounting; don't spend failure budget merely for a healthy completed
process awaiting disposition.

Keep the hub credential-free. GitHub-reading executors provide scoped first-hand
receipts binding repo, head/base/merge SHA, check identity, run attempt, conclusion
and observation time. The hub validates their relationships and reviewer authority;
it does not validate delivery by checking only that a URL has the right prefix.

## 7. Sequenced implementation plan

These are proposed work packages, not newly dispatched duplicate implementations.
Sizes indicate engineering scope, not elapsed-time promises. BR#7501 remains the
existing implementation home for gateway lifecycle work after original-writer
reconciliation. A planning session must not also certify the resulting implementation.

| Order | Package / owner boundary | Required change | Exit gate |
|---|---|---|---|
| 1, P0, M | Completion authority; hub/contracts + native integration | Mandatory role-specific outcomes, explicit completion contracts, durable terminal-disposition state; reject runner-origin business acceptance | Unknown/empty/error exit-zero cases cannot close any task/review; accepted results bind exact subject/content |
| 2, P0, L | Finish BR#7501 | Wire the bounded registry into actual `run_loop`; offload preparation/checkpoint/finalization; persist terminal outbox; reconcile restart | Slow phase jobs cannot block eligible unrelated slots; no lost terminal result or duplicate writer |
| 3, P1, M | Scheduler/recovery-critical path, with BR#7501 | Remove local resume-first scheduler; request recovery while full; preserve review/reconciliation priority and safe preemption | Full real controller requests/executes a safe priority handoff; no overbooking or unsafe victim choice |
| 4, P1, M | Readiness/mailbox protocol | Retain typed failure causes; separate normal delivery/interrupt; durable input-scoped runtime prerequisite waits | Cooldown is shown/routed as cooldown; a normal message causes zero process restarts; unchanged prerequisite failure does not churn |
| 5, P1, L | Train executor/contracts | Candidate-local continuation throughout phase A/C; bounded Git/GitHub operations, fenced lane attempt and effect reconciliation; tested integration/batch manifest | Independent ready candidate progresses behind bounce/carry/wait; hung command does not block another lane; no untested cumulative tree merges |
| 6, P1, M | Hub incident/state consolidation; consume BR#7495 work | One canonical versioned persistence path and cause-bound incident reconciliation; migrate old recovery pointers/counters | Crash/replay keeps one incident/continuation; closed diagnostic cannot strand a fault; source/mirror disagreement cannot authorise effects |
| 7, P1, M | Rollout/operator evidence | Publish actual native build/boot/protocol/feature identity; truthful shared projections; canary useful-work acceptance | Running corrected controller is proven; old runner may drain but cannot accept incompatible new work; UI agrees with gates |

Packages 1 and 2 define their shared outcome protocol together. Package 3 depends
on the real controller from 2; 4 can proceed after protocol agreement. Package 5
can proceed independently with the same receipt conventions. Package 6 consumes
their typed facts. Package 7's observability starts early, but acceptance waits for
all relevant production paths. Each slice lands with tests/docs and independent
review; no new PR/approval ceremony is proposed for this repo's direct-main policy.

### Explicit removal and migration list

- Remove runner title-prefix role decisions, stdout PR/`BR-BLOCKED` control,
  synthesized verification receipts, exit-zero auto-`done`/`in_review`, and late
  completed-run re-claim as a delivery mechanism. Keep transcripts as diagnostics.
- Remove `my_tasks`/conversation timestamps as a second dispatch authority and
  local `gave_up`, `finished_no_pr`, failure counters as eligibility authority.
  Put scoped, bounded retry decisions in the hub; retain only local job handles.
- Consolidate periodic checkpoints, stop receipts and terminal result delivery into
  one phase registry/outbox protocol, preserving every existing WIP/unknown effect.
  A storage-full/outbox failure must visibly hold admission, not lose evidence.
- Quarantine legacy prose acceptance to a versioned, receipt-backed migration.
  Existing ambiguous records get reconciliation findings, not fabricated acceptance.
  Disable that adapter for all new protocol clients, then delete it after migration.
- Make one lane record authoritative. Either complete `lane_state` as the command
  source or explicitly demote it to a read-only projection; do not keep a writable
  card plus a nominally canonical table. Use one transactional reducer/outbox path.
- Map historical starvation, line-recovery, candidate-repair and retry records to
  cause/revision-bound incidents. Preserve evidence and authored decisions. Stop
  generators that merely create another generic recovery duty for the same fault.
- Add protocol capability negotiation before requiring new finalization semantics.
  Roll out a canary, verify useful work, enable new admissions, then retire old
  writers only after quiescence/preservation. Retain rollback compatibility and
  managed-update useful-work cooldowns.

## 8. Adversarial acceptance matrix

These tests must run through the **real production controller and hub**, with
controllable I/O/process transports, not only call the pure reducer/component.

| Injected condition | Required observable result |
|---|---|
| Exit zero, empty output, unrecognised error, truncated reply, tool bootstrap missing | Captured failed/missing result; zero manufactured task/review acceptance |
| Checkpoint or result publication stalls; response is lost; daemon restarts | Other slots progress; exact terminal receipt replays; WIP/unknown effects survive |
| One preparation hangs in a 20-slot gateway | Remaining 19 eligible jobs start within the deterministic harness deadline; controller stays responsive |
| All phase workers block, or the outbox fills | Explicit bounded backpressure and owned recovery; no unbounded thread growth or silent evidence loss |
| Fleet full of ordinary verification; urgent root repair becomes eligible | Safe checkpoint/preemption request occurs despite full local count; repair's review retains priority |
| Full fleet has only protected/unknown-effect writers | Honest non-preemptible hold; no invented capacity; recovery owner and next predicate visible |
| Normal message versus interrupt in every attempt phase | Normal message never kills/restarts the worker; interrupt stops safely before conflicting effects |
| Transport timeout versus model outage versus signing prerequisite | Different typed scope/retry/continuation; UI and scheduling gates agree |
| Reservation expires while preparation returns late; old/new responses reorder | Exact fence wins once; no double launch or foreign capacity release |
| Unreconciled terminal receipt followed by another begin | Original business action cannot restart until an explicit terminal disposition authorises it |
| Candidate A bounces/carries/waits, candidate B is current and accepted | B still progresses within the bounded pass; A cannot merge without covered CI/review |
| Base/head changes after planning; clean file merge but compile-breaking contract change | No stale admission; exact cumulative-tree CI remains required |
| Merge/update/rerun response lost, lease holder changes | Observe/reconcile the external effect; no blind repeat, false conflict or lost provenance |
| Diagnostic finishes without repairing incident; repair itself faults | Same incident retains a concrete continuation; no false recovered state or unbounded child chain |
| Crash between lane/task/state/receipt/outbox writes | Atomic state or replayable pending command; mirrors cannot become an alternate authority |
| Previously idle lane receives a new candidate; legitimate CI wait is long | No immediate starvation false alarm from ancient last-merge timestamp; stage deadline identifies the actual overdue transition |
| New binary is published but old binary remains running | Hub/runner/UI report the adoption gap; runtime recovery remains unaccepted |

Generate interleavings/property tests for one-writer fencing, nonnegative/exact
capacity, terminal receipt conservation, and eventual disposition under recoverable
faults. Keep safety tests proving that improved liveness never relaxes signatures,
required checks, review separation, checkpoint portability or effect reconciliation.

## 9. Proposed operational completion bar

These are proposed acceptance targets to make the implementation falsifiable;
measure and configure them during the canary rather than silently extending TTLs.

- Controller p99 local reduction/harvest time below 250 ms in the 20-slot test;
  no synchronous external I/O on that path.
- With healthy mocked prerequisites, reserve within 5 seconds and start within
  30 seconds when a compatible slot is free. A deliberately stuck phase reaches
  its typed deadline and does not delay independent work.
- Current, accepted, checked candidates are either merged within two bounded
  train passes or have an exact typed blocker. Progress evidence is a transition,
  not a repeated heartbeat/action string.
- Run a real gateway canary with sustained eligible supply, at least 100 worker
  lifecycle completions and 60 minutes including controlled transport failure,
  recovery and managed restart. Account for every result and charged slot.
- Observe a multi-candidate delivery through merge and decisive green deployment,
  with exact running build/protocol and no manual metadata/slot patching. Real
  product-red holds must be correctly diagnosed rather than bypassed for the test.
- Independent review confirms the production call graph uses the new controller
  and the removal list is complete. Component tests alone cannot meet this gate.

Track useful-work conservation (eligible + free → reserved/started), phase-age
histograms, result/outbox oldest age, unknown-effect count, preemption latency,
candidate eligibility age, merge throughput and incident recovery age. An unsafe
or unavailable prerequisite is an explicit exclusion, never a hidden denominator.

## 10. Decision and handoff

Recommend this plan as the completion contract for the existing refactor and its
dependent repairs. The desired outcome is fewer authorities and fewer recovery
paths, with stronger receipts and integrated proofs—not a larger catalogue of
strings, timers and special-case sweeps.

This review publishes no claim that the proposed fixes are implemented or that
the gateway is recovered. Independent critique should challenge the findings,
protocol boundaries, migration safety and acceptance matrix before implementation
is treated as complete. Preserve the original source/runtime owners and reconcile
their writer/WIP state before assigning any replacement executor.
