# bridge — self-hosting

**bridge** is a control plane for coding-agent fleets: a live board with confidence/risk/completion gauges, a gateway that claims tasks and dispatches them to agent CLIs on your machines, and a human inbox for sign-off. The [public site](https://fleetbridge.run/) covers what it does and why; **this README gets the app running in your own Cloudflare account.**

**Just want to use it?** The shared hub is live at `https://hub.fleetbridge.run` — sign in with GitHub at the same URL and `bridge pair https://hub.fleetbridge.run`; no deploy needed. The rest of this README is for self-hosting.

Everything runs on the Cloudflare **free tier**: one Worker, one SQLite-backed Durable Object, hibernating WebSockets, worker assets for the web UI.

## Quick card lookup

### Knowledge-plane identity

Knowledge REST bearer requests authenticate through the workspace's credential
validator; routing a token to a workspace alone is not authentication. Unknown
credentials are rejected, while identity infrastructure failures stay retryable.
REST mutations and MCP derive actor, token binding and gateway class from the
authenticated credential, overriding caller-supplied attribution. Gateway tokens
report fenced process facts; they cannot submit a task for review or mark one
done. Task agents and independent reviewers retain those business actions.
Human authority uses the `web:<login>` / `human:<identity>` actor namespaces,
outside the credential-label grammar. A bare display label such as `web` is an
ordinary agent name. Legacy credentials conflicting with a human namespace may
drain writers through gateway execution control and self-rename through the
existing machine endpoint; they cannot use the conflict as human authority.
The legacy machine `stats`, `list` and `search` mirrors validate bearers through
the same credential boundary. The desktop decision action at
`/api/kb-machine/act` requires a signed human session cookie and verifies that the
stored target is a decision; a paired gateway token cannot approve decisions.

### Delivery responsibility

An open PR remains a delivery obligation even when an old card is retired.
Replacing a PR-bound task requires a live successor; its ownership and PR
bindings transfer in the retirement transaction. A bare Supersede without a
replacement is refused for outstanding bindings. The human disposition endpoint
also accepts `disposition: {kind:"hold", owner, reason, next, deadline}` (epoch
milliseconds) or `{kind:"abandon", reason}`. Holds retain their owner and review
deadline. Abandonment schedules an authorised GitHub-close executor task and
stays pending until independent outcome review accepts actual closure receipts.
Exhausted repair rounds and closed-unmerged probes retain the obligation and
escalate through the existing task-recovery mechanism.

Reconciliation covers every open PR, including undecided reviews and drafts
after bounded grace. The report includes all-open totals and queued, repairing,
verifying, held and stranded counts. A binding without executable progress is
stranded, not healthy accounting. Completed reconcile duties cover their observed
head rather than the lifetime of a PR.

Independent PR acceptance must use `review_result: {kind:"accepted_pr", task_id, subject_revision,
legs:[{repo, number, head_sha_at_acceptance}]}`. Review completion and pending
queue admission are committed together; the existing repair passes replay the
handoff until admitted or explicitly held behind a newer blocker. Explicit
historical acceptances, including standalone reviews of already-done parents,
can restore delivery on a successor without rewriting historical completion.
Historical done-parent restoration requires a fresh observed OPEN PR at the
accepted head; missing, closed or changed-head observations retain a visible hold.
Historical intake and admission replay are bounded to ten records per pass.
A durable round-robin cursor keeps held records from starving later admissions;
overlapping ingress shares one historical reconciliation pass.

### Explicit completion authority

Gateway credentials report process facts through the fenced execution protocol;
they cannot submit a task for review or mark one done. The running task agent
uses its own provisioned credential and exact execution scope to submit work.
Both MCP and knowledge REST derive actor, token binding and gateway class from
the authenticated credential, overriding caller-supplied attribution. Workspace
routing alone is not authentication; unknown bearers are rejected and identity
infrastructure failures remain retryable rather than becoming false auth verdicts.
Exit zero, an empty/error transcript, a commit link and a finished review process
are not business outcomes.

Analysis/diagnostic tasks close with `execution_result: {outcome, receipts}`
describing actual findings. Execution submissions supply that result on the
submission itself; a previously stored result cannot substitute for a new one.
Unblock duties use that same observed-findings result or `unblock_result` for an
atomic replacement wait. New analysis and unblock tasks have execution completion
contracts; ordinary metadata edits cannot delete a contract or weaken execution
into delivery.

Review duties close with a typed `review_result`. Findings finish the review
without accepting its parent. Acceptance must match the duty's exact task and
completion contract: `accepted_execution` verifies actual execution receipts;
`accepted_direct_main` verifies signed main ancestry and green CI;
`accepted_pr` records exact reviewed heads, with delivery still waiting for the
train's decisive required checks. Claim readiness and absent qualification bars
never imply completion acceptance. Notes, parks and decision text do not create
new acceptance. Historical transcripts stay available as evidence for a fresh
review; they cannot author or replay delivery admission.

On claim, a review captures `review_subject: {task_id, revision}`. Echo that exact
revision as `review_result.subject_revision` on acceptance. Task-definition,
repository-input and outcome edits, or a new submission (even identical content),
invalidate old acceptance. Ordinary progress and machine bounce annotations do
not. Revision/subject/result fields are lifecycle-owned, not generic metadata.
Only the latest review round can author acceptance, including detached duties.
An unclaimed round can be reused; a claimed duty keeps its captured subject,
and changed submissions receive a fresh round. Independent-review requests use
that same current round rather than duplicating detached or capability-held work.
Existing human force-review approval is captured against its exact revision and
PR heads; it still cannot merge or skip decisive delivery checks.

A merge observation or provenance row resumes independent delivery verification;
it does not itself prove CI or mark a leg landed. A live canonical lane already
settling that task retains its exit. Reconcile reports `reverse_verifying` and
observed merges awaiting verification instead of claiming a refused close
succeeded. Closed-unmerged work retains its delivery obligation.

`await_event: {event:"lane_health", repo, base, head?}` follows observed deployment
health at the lane tip. Retiring a `br_done` dependency is not success: a live
replacement must reach the required outcome. An unblock duty finding a different
blocker supplies `unblock_result: {kind:"reblocked", parent_id, reason, next,
await_event}` so replacement of the parent's wait and completion of the duty
are atomic. Predicate revisions and accepted heads scope same-receipt deduplication.

Top keeps machine/agent identity and actual **model / tier** in separate aligned
columns. Parent and child rows share the same tracks; narrower windows scroll
the task table horizontally rather than folding cells onto a second row.
Top shows one **No workers available** warning when no registered worker can
run automation. Busy workers do not trigger that warning. The header's **Status**
popover groups hub/live-update connections and workers, using scheduler readiness
and per-host **leased / starting / unconfirmed / slots held** counts. A leased
execution has a current matching claim and unexpired execution/action lease;
it is not an independently verified OS process count. Old/expired or claimless
attempts are **unconfirmed**, with expandable task, generation, session and reason.
They still hold capacity until the gateway confirms their process groups stopped.
Card release, heartbeat expiry and daemon restart alone never free those slots.
Releasing a live managed claim atomically marks its attempt stopping and queues
an interrupt; the runner must stop and preserve work instead of renewing a
released worker indefinitely. Only its quiescence confirmation frees the slot.
The same occupancy facts back scheduler admission, availability and the board;
lease/inventory renewals push a bounded status refresh so an idle task board does
not age a healthy worker into a false outage. During rolling deployment, old
aggregate-only data is labelled unresolved executions, never running workers.
Managed updater holds also mark every advertised model unavailable with the
explicit draining-for-update reason; a local no-claims hold cannot advertise
usable spare capacity. Clearing the hold rebuilds availability from actual config.
Worker completion (including a crashed worker thread) wakes dispatch within a
100ms sleep slice rather than waiting out the configured fallback poll. The
runner still verifies quiescence and completes the handoff before reusing a slot.
Admission runs before optional worktree hygiene. Each hygiene pass inspects at
most four candidates, with a three-second aggregate status-probe budget and a
one-second deadline per read; retained trees count against that budget too. A
persisted oldest-first round cursor prevents the same kept trees from starving
the rest after each poll/restart. Cleanup still preserves unpublished work.
`bridge status` writes the current PID and dispatch stage before slow operations
(readiness, checkpoint, finalization, admission, preparation, hygiene, waiting),
and logs report each worker's preparation duration. These are local diagnostics,
not a claim that every held slot is a running process. Worker preparation and
handoff remain serialized; configured concurrency is an upper bound, not a
guarantee of twelve continuously occupied slots. Diagnose a slow refill from
these stages and live scheduler eligibility/occupancy rather than raising the
slot limit or repeatedly restarting the gateway.
Within a refill batch, launches reuse the tick's proved worker/config inventory
for up to 60 seconds, refreshing after slow provisioning instead of repeating
local probes and a hub advertisement for every slot. Each begin still checks
the hub's live model selection, scope, credential and capacity fences; a failed
required refresh never launches a writer.
Gateway readiness has its own renewal thread, independent of task dispatch,
checkpointing and completion handoffs. Every 20 seconds it re-probes configured
backend CLIs/tools, proves the canonical worker credential and advertises the
current inventory, including managed-update holds. Dispatch consumes that fresh
proof instead of provisioning a second worker or running a second readiness
producer. Failed renewal withdraws local admission; authentication failures still
enter the gateway's existing repair ladder. Config changes invalidate old proofs,
and stop joins pending renewal before the producer is dropped. This keeps a busy
gateway from appearing unavailable merely because a synchronous handoff exceeded
the hub's 120-second observation TTL; the TTL itself is unchanged. Gateway
readiness does not renew task leases, fabricate worker progress or release slots.
**Worker drain does not stop merge delivery.** The merge train continues ticking
while existing agent workers finish. Only after the last worker stops does the
gateway stop and join the train, then acknowledge the nonce/PID-bound idle receipt
for supervised restart. A failed train join cannot certify idle. This avoids
silencing the merge line for a whole worker action budget on every update.
Retired merge lines are hidden.
Opening a merge lane shows its live operational view: the same typed status as
the train row, deployment/recovery links, queue checks and repair tasks, executor
heartbeat and merge throughput. It refreshes every 30 seconds and flags failed or
stale observations. Required checks come from live lane configuration; recovery
history and executor diagnostics are expandable. Lanes do not show task completion
gauges, model fields, generic unblock/supersede controls or dependency graphs.
Per-task execution-attention cards are not shown on Top.

**Recovery owns execution priority (BR#6835).** Concrete task-repair duties and
main-red fixes rank above line recovery, generic diagnostics, boosts, verification
and ordinary implementation in both discovery and reservation. When a compatible
gateway is full, the scheduler can checkpoint-preempt one ordinary managed verifier
on that host. A durable interrupt requests checkpoint, stopped-process proof and
yield; the verifier returns to todo with its checkpoint preserved. Its slot stays
charged until real quiescence, then the recovery is pinned ahead of the verifier's
resume. Concurrent calls/restarts reuse one host handoff, not a cancellation storm.
Interactive sessions, human/control holds, recovery's own verification, pending
external effects and uncheckpointed writers are protected. Inspect mode never
preempts. Full runners use `schedule(request_capacity)` to request a safe handoff
without reserving additional work. The line reports which verification is yielding, rather than merely
claiming to wait for an eligible executor. Credential/model/host eligibility and
review separation remain enforced; priority never fabricates capacity.

The web and desktop headers include **Go to BR#…** on every signed-in view.
Enter `BR#6690`, `BR-6690`, `#6690`, or `6690`, then press Enter or **Go** to
open the card directly, regardless of board filters or whether it is loaded in
the current list. **⌘K / Ctrl+K** focuses the lookup; Escape clears it. The web
app opens the existing URL-synced card detail; desktop opens its task window.

## Opt-in runner auto-updates (Linux/systemd)

Automatic binary replacement is **off by default**. Installing from `dev` does
not opt a host in. In `~/.bridge/config.json`, opt in explicitly:

```json
"auto_update": { "enabled": true, "channel": "main" }
```

`main` follows a commit-addressed four-platform build **only after CI and the
build workflow both succeed for the same main SHA**. `stable` requires a
successful version-tagged release as well. `pinned`, `enabled: false`, or an
absent/null `auto_update` disables downloads and replacement. Set it through the
single config writer with `bridge update enable main`, `bridge update enable
stable`, or `bridge update disable`. `bridge update status` shows config and the
last durable update result; `bridge build-info` prints the embedded source SHA.

**Updates cannot continuously drain the fleet.** After a confirmed update,
rollback, deferred drain, or recovery of an interrupted drain, the supervisor
leaves **one hour for useful work** before another drain attempt. The durable
`next_attempt_at` in `bridge update status` survives supervisor restarts and
applies to every candidate, not just the previous SHA. Publications during this
window do not download, run doctor, or pause claims. At expiry the supervisor
fetches the **latest** channel manifest, coalescing intermediate builds, even if
no new publication event arrives. Drain attempts still wait at most 15 minutes;
they never kill active writers. During the work window normal capacity rules apply.

The updater is an independently installed Python script: replacing the runner
binary alone does **not** refresh it. To adopt an updater fix on an existing
host, run `bridge update disable`, wait until `~/.bridge/update/request.json`
is absent (check `bridge update status`; let an in-progress install/rollback
finish), then refresh the script using `bridge update install` from the corrected
binary, or download `packages/cli/updater/supervisor.py` from the exact published
fix commit into `~/.bridge/update/supervisor.py` using an atomic file replacement.
Run `systemctl --user daemon-reload` and `systemctl --user restart bridge-update`,
then `bridge update enable main` (or `stable`). **Restart only the updater**, not
`bridge.service`; existing workers can continue. Old terminal update receipts
inherit the same one-hour window when the corrected supervisor first starts.

One-time bootstrap on the remote, **as the runner's Unix user**:

1. Install a current `dev` binary once (`install.sh dev`), after safely draining
   any old/nohup runner. `bridge build-info` must report `update_protocol: 1`.
2. In the shell where `bridge doctor` is ready, run `bridge service install`
   (if no `bridge.service` exists), then `bridge update install`. This writes
   user units/scripts but does **not** enable auto-update or restart anything.
   Python 3.10+ is required. The runner service must own the installed binary;
   the updater refuses to stop a bare/nohup process or a different service.
3. Run `bridge update enable main`, `systemctl --user daemon-reload`, and once
   existing work is idle, `systemctl --user enable --now bridge bridge-update`.
   If `bridge.service` was already running, restart it once **after a safe drain**
   to pick up the managed-update environment drop-in. Never run it alongside the
   old nohup runner. `loginctl enable-linger "$USER"` keeps user services alive.
4. Inspect `bridge update status`, `bridge build-info`, `tail -f ~/bridge.log`,
   and `journalctl --user -u bridge-update -f`.

The independent updater listens to `/api/runner-updates/events` SSE. Publication
is a wake hint: on startup/reconnect it reconciles the persisted channel manifest;
an hourly fallback covers lost events. Disabled hosts perform no update-network
checks. The public publication endpoint accepts **no caller-provided download
URLs/manifests**: it independently verifies successful GitHub CI/build runs for
the source commit (and the versioned release gate for stable), fetches that
commit's release manifest, and advances channel revisions monotonically.
The promotion job supplies its short-lived, read-only GitHub job token so
verification is not dependent on anonymous API quotas; it is used only for
fixed-repository API reads and is never stored in channel state or notifications.

Before installing, the supervisor verifies SHA256, checks the candidate's
embedded commit and runs doctor. It asks the runner to stop claiming work, lets
existing tasks finish naturally, and joins the train thread before accepting a
nonce/PID-bound idle acknowledgement. It never infers quiescence from an expired
lease or a stale heartbeat, and never kills active work to meet an update
deadline. After 15 minutes without idle it defers and resumes the old runner.
Candidates start under the same no-claims hold; confirmation requires the exact
new process/build's fresh readiness receipt, a stable process, and passing hub/
backend doctor checks. Failed candidates roll back to the previous verified
binary while that hold remains. Interrupted installs recover conservatively;
failed rollback retains the hold for inspection rather than starting writers.
An already-applied rollback is verified against the actual managed executable
and PID rather than stopped and restarted again. Failed rollback health enters
`recovery_required`, retaining the hold and useful-work retry budget. A newer
CI-approved channel build can continue through `recovery_preparing` only after
the restored process supplies its exact nonce/PID idle acknowledgement. Digest,
embedded commit, doctor, stable-process health and rollback gates still apply;
the same failed candidate is not replayed. A restart during preparation retains
the hold and repeats only pre-install reads, never an unknown install effect.

For a host already looping in rollback, atomically refresh the independently
installed supervisor from the exact signed fix commit and restart **only
`bridge-update`** while preserving `request.json`, `idle.json`, `health.json`,
state and retained binaries. The corrected recovery protocol owns continuation;
never clear the hold, forge a health/idle receipt or reset its cooldown manually.

Success, deferral and rollback produce durable local state and a deduplicated
ops notification through the existing Bridge alarm feed (visible in Log and in
Slack where the alarm shipper is configured). Failed notification delivery is
retained locally for retry. The updater itself is separately installed, rather
than replacing its own recovery executor during a runner update. To stop future
updates: `bridge update disable`; an installation already in progress is first
recovered/confirmed safely. Retained binary: `bridge.previous` beside `bridge`.

## What you need

- A [Cloudflare](https://dash.cloudflare.com) account (free)
- Node.js 20+
- One machine to run a **runner** on (macOS or Linux) with [opencode](https://opencode.ai) installed

## 1 · Deploy the hub (Worker)

```bash
git clone https://github.com/state-vector/bridge && cd bridge
npm install

cd packages/worker
npx wrangler login                      # or: export CLOUDFLARE_ACCOUNT_ID=<id>
npx wrangler deploy
# note the printed URL: https://bridge.<your-subdomain>.workers.dev
```

Secrets (stored server-side, never in the repo):

```bash
npx wrangler secret put BRIDGE_INGEST_TOKEN    # generate: openssl rand -hex 24 (legacy FLOWS_INGEST_TOKEN still accepted)
```

## 2 · Human sign-in (GitHub OAuth)

The web UI is gated by GitHub OAuth (30-day HMAC session cookie):

1. github.com → Settings → Developer settings → OAuth Apps → **New OAuth App**
   - Homepage: `https://bridge.<your-subdomain>.workers.dev`
   - Callback: `https://bridge.<your-subdomain>.workers.dev/login/callback`
2. Store the secrets:

```bash
cd packages/worker
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

3. Set the login allowlist (default deny — without this secret only **invited** GitHub logins can sign in):

```bash
npx wrangler secret put GITHUB_ALLOWED_USERS   # comma-separated GitHub logins (e.g. "rayh"), or "*" for any account
```

**Inviting teammates:** workspace members self-serve — the 👥 button next to the workspace picker invites/removes members by GitHub username (validated against the GitHub API at invite time; optional `GITHUB_TOKEN` secret raises the lookup rate limit). An invited login can sign in via the GitHub button even when not on `GITHUB_ALLOWED_USERS`. Everyone holds the same rights — any member can invite or remove — and the workspace creator cannot be removed.

## 3 · Run a runner (the gateway)

### Durable execution (protocol v1)

#### Eligibility-first scheduling and gateway retirement

The hub selects work for the requesting gateway **before** applying a candidate
limit. Host-affine or unavailable work cannot hide runnable work behind a global
top-ten queue. `execution {id:"gateway", command:{kind:"schedule",mode:"reserve"},
command_id:"<unique request>"}` reserves one eligible task and its gateway slot
through the normal lifecycle gates. Replaying a request returns its original
reservation; a reservation still requires fenced `begin` before any worker starts.
Each reservation has a fresh executor session, which the runner propagates to
the worker and all callbacks; re-dispatch does not reuse a tainted verifier identity.

Capacity counts pre-launch reservations and **all unquiesced writers**, including
stopping writers and expired leases. An expired lease is never proof of a free
slot. Pre-launch reservations expire after five minutes: only an unchanged,
never-launched claim with no live writer, unknown effect or independent wait is
released, without spending execution/churn retries. Potential retained local
files remain host-affine. A delayed old launch is refused by the claim/session gate.

`bridge execution schedule-status [hostname]` (or the read-only `execution`
command `schedule_status`) reports running/uncertain writers, reservations,
capacity, eligible work, exclusion counts, readiness, last scheduling result and
work-conservation health. A ready gateway with free slots and eligible work but
no new reservations for two minutes raises one `dispatch_starved` audit incident
per episode. Reservations clear the episode; this is machine diagnosis, not a
human approval queue.

To retire a laptop from autonomous execution, an authenticated full agent or
human uses `execution` with `id:"gateway"` and command
`{kind:"gateway_control",host:"<hostname>",mode:"draining",reason:"<reason>"}`.
Draining persists across advertisements, restarts and temporary `resume_claims`;
new claims and begins are refused, while existing writers may checkpoint and
quiesce safely. Only explicit `mode:"enabled"` re-enables dispatch. Draining does
not discard WIP or make local-only work portable.
The paired gateway may also opt itself out with `bridge execution drain`; it
cannot enable itself or control another gateway. Re-enabling remains an
explicit full-agent/human action.
Gateway SSE wake streams reconnect at least once per minute, so long-lived
subscriptions cannot indefinitely retain a superseded hub deployment. Reconnects
carry no execution authority and do not stop workers; durable state and the
normal polling fallback preserve progress.

New reservations do not consult runner-local give-up/refused-reference caches.
Repository/startup refusals live in the hub, scoped to the task's prerequisite
inputs and executor proof: correcting the repository or configuration re-arms
that task, while progress or a priority boost does not. Repeated runtime failures
produce a visible five-minute gateway cooldown, followed by readiness re-proof,
rather than a permanent local circuit breaker requiring restart.

Worker provisioning validates cached credentials against the live hub before
execution begins. Revoked/wrong-class cache entries are re-provisioned; the
runner binds the hub's canonical worker label rather than an old cache key.
Transient/deployment errors retain the cache and never trigger credential
rotation. Gateway and interactive credentials are never worker fallbacks.
Provisioning and canonical-identity proof happen **before claiming any card**.
Readiness advertises a closed `worker` state; the hub verifies a live worker in
that gateway's namespace at advertisement, claim and begin. Tool availability
alone is not launch readiness. Older runners can keep existing writers alive,
but cannot consume new work with an unprovisioned readiness advertisement.

If startup fails before a child launches, the runner reconciles the exact begin
attempt, proves quiescence where needed, and records `start_failed`. The hub
releases the unstarted claim atomically without a watchdog abandonment. Dirty
or unpublished work stays host-affine and is never cleaned up by this path.
The failing host cools down after transport failures; three require repair.
A named prerequisite rejection holds immediately rather than retrying it.
A changed credential/configuration can
restore readiness, and other ready hosts can pick up the released work. Unknown
writers and unresolved external effects remain held. Startup preparation is
not displayed as a successfully dispatched worker.
Task-specific begin prerequisites do not hold unrelated work on the gateway.
They create a typed `recovery_required` startup wait for the affected task:
repeating the same executor/configuration proof cannot re-claim it. A repaired
credential/configuration, or another compatible host when no local work is
retained, lets readiness reconciliation release it. Executor-wide failures use
`waiting_executor`; transient failures keep the short host backoff. Neither
wait consumes the task's execution/churn budget. Availability and claimability
show the startup wait, and late progress is commentary, not a hidden re-claim.
The hub reconciles on every readiness advertisement and its one-minute alarm.
It also migrates legacy credential-rejection churn parks automatically, including
owner-lapsed cards, only when no execution generation, attempt or external
operation exists. Legacy retained work stays on its original gateway; live
claims, human/local gates, bound asks and unrelated typed waits remain protected.
Recovery archives old churn counters and records an atomic dispatch receipt;
it does not claim that execution or repair has completed. Critical (`p0`/`P0`)
startup waits get one incident on the original card after `stale_minutes`
(default ten minutes), with their cause and responsible executor visible in
Backlog and task details, rather than duplicate unblock or approval requests.
Scheduling checks persisted execution/checkpoint host affinity before claiming;
a failed launch stops that claim sweep until readiness is re-proved next tick.
Startup failure logs include the actual reason and whether the task or gateway
is held, rather than reporting every rejection as a credential failure.

Paired operators can run `bridge execution ready` to prove the live hub/worker
handshake without claiming work. `bridge execution recover-unstarted 'BR#N'`
recovers recorded legacy pre-begin credential failures only after a fresh
same-host zero-worker report and an empty runner child list. The hub also
requires no execution attempt; a real writer, review verdict, human hold or
unknown external effect cannot be erased. Retained work stays host-affine and
superseded startup-churn counters are archived. Legacy GUI advertisements do not
overwrite a corrected runner's live readiness, and old clients cannot borrow
that proof to claim or begin new work.
For a side-by-side rollout, set `BRIDGE_DISPATCH_DIR` to a separate directory for
the corrected runner's ephemeral process/status files. Pairing and credentials
remain in the normal store; the human GUI's status report remains intact.
The canonical worker-token cache is shared across runner report directories,
so adopting a side-by-side runner does not rotate another process's worker.
Namespaced worker labels such as `gateway/opencode` (and `label@session`)
are valid coordination recipients, matching the identities Connect exposes.

New runners acquire a hub-persisted execution generation before spawning an
agent. The SQLite state and command replay receipt commit atomically. Worker
MCP writes carry their generation/attempt scope in runner-injected headers;
removing or changing the scope does not restore legacy write access.

- **Portable work:** every five minutes and when a process stops, an isolated
  Git worktree is snapshotted through a private index (tracked and non-ignored
  untracked files). A signed preservation commit is pushed to a unique
  `bridge-checkpoints/…` ref and read back. Snapshotting leaves HEAD, the real
  index and local WIP intact. Checkpoints record base, commit, tree, environment,
  next action and content-bound test evidence. Ignored inputs/secrets are not
  uploaded: required external environments must be provisioned separately.
- **Safe transfer:** lease expiry and missing stdout never prove a writer has
  stopped. Another attempt waits for the original runner's empty-process-group
  acknowledgement; cross-host execution additionally requires a published
  checkpoint and verified commit/tree restoration. Newer local WIP is retained,
  not reset to an older checkpoint. Dirty or unpublished worktrees are retained
  by cleanup if the preservation barrier cannot be proved.
- **Independent clocks:** a two-minute execution lease is renewed by a dedicated
  per-attempt control poller every 20 seconds, independently of worker preparation,
  checkpoint publication and the dispatch tick. The poller is joined before
  quiescence/transfer; refused polls stop the writer and retain WIP. The configured
  task action budget (at most one hour) is independent of
  narration. Three exhausted action budgets stop automatic restarts and require
  diagnosis. Quiet ACP actions can run within their action budget. Unproven
  process-tree isolation retains host affinity; agents must not detach writers
  from the runner's process group.
- **Active coordination:** safe-point polls reconcile task-addressed asks into a
  durable mailbox (`queued → delivered → acknowledged → acted`). For CLIs that
  cannot accept hot input, the runner stops/checkpoints and resumes with the
  message. Interruptions gate conflicting hub writes immediately. Delivery is
  not a claim that the requested repair succeeded.
- **Bounded external operations:** the `execution` MCP tool supports
  `prepare`/`result` with stable operation IDs, exact input revisions, budgets
  and receipts. A timed-out effect becomes `outcome_unknown`; inspect GitHub/AWS
  before reporting its result. Pending unknown effects prevent transfer or
  another attempt, rather than authorising a duplicate push/deployment.
- **Explicit capability escalation:** configure each backend's `models` supply
  by `small`, `medium` or `large` (legacy `model` + `reasoning_tier` is still
  accepted; names are never guessed into tiers). Task `meta.execution_requirements`
  persists minimum tier, tools, environment and optional host constraints.
  Gateways advertise expiring scoped facts; begin/claim gates check them and
  execution records retain the actual backend/model/config observation.
  `execution` command `availability` distinguishes no observed supporting
  configuration, expired gateways and capacity waits. Explicit `escalate`
  strengthens the requirement; the runner yields only after publication and
  quiescence. An unavailable larger model is not a human approval request.
- **Recovery continuity:** a still-open cause carries its attempt history and
  consumed retry budget across revisions. The new revision receives no inherited
  green verification credit. Code delivery, accepted review and live deployment
  evidence remain separate facts.
- **Critical-path capacity:** repair, review and deployment-verification work
  sorts ahead of diagnostics. Diagnostics cannot take the last slot on a
  multi-slot gateway; single-slot gateways still execute serially.

The hub and runner must both be updated for these guarantees; deploy the hub,
then install the matching dev runner. A gateway waits for a successful live
protocol capability advertisement before claiming anything; a new `/__version`
stamp alone is not proof the execution endpoint has propagated. Existing processes cannot acquire process
isolation retroactively. A sudden host loss can lose work since the last
published checkpoint and leaves transfer held until writer quiescence is proved.
`execution` command `inspect` exposes the exact durable attempt, mailbox and
operation state. Local pickup and human decisions have separate typed exits;
an answered or dismissed request never implicitly accepts local execution.

### Local handoffs and capability blockers

`execution` command `local_handoff` records the exact local action, reason,
findings, attempts, evidence, approvals and next step. It first stops the writer;
only a published checkpoint plus quiescence allows `yield` to move the task to a
typed `local_handoff` wait. It disappears from every autonomous claim/retry/
unblock path. The Top view's **Execution attention** shows all simultaneous
blockers and offers **Copy continuation prompt** without changing task state.

**Human-directed interactive agents claim directly (BR#6788).** Start the chosen
agent with a unique session, orient, then call `transition {id, to:"in_progress",
session, note:"Human-directed pickup"}`. A live full-agent credential is sufficient;
there is no second human-web authorisation/acceptance loop. This works for todo,
capability-blocked and fully prepared local-pickup cards. A missing background
gateway does not disqualify the interactive executor. Gateway, cron and provisioned
worker credentials cannot impersonate it; classification comes from live token
tags, never a declared session name or a payload flag.

The claim atomically binds the credential/session, consumes the matching execution
wait and preserves published checkpoints/continuation evidence. Competing claims
cannot both win. Original writers must actually be quiescent, unknown external
effects must be reconciled, local preparation must be complete, and outstanding
human decisions, qualification and review separation still apply. Owner progress
updates liveness/gauges even when an old runner attempt is quiesced; other sessions
can contribute comments but cannot refresh its heartbeat or release its work.
The owner can submit to review normally, or stop local writers, publish/preserve
its work and release with `transition {id,to:"todo",session,note:"<done/next and
work location>"}`. Ownership clears atomically; autonomous capability requirements
remain and are re-evaluated, rather than erased to force a dispatch.

`handoffs` remains side-effect-free discovery. The older episode/version-bound
**Authorise a local session** → `handoff_accept` flow remains available when an
explicit capability grant is desired. For that grant-based flow, publish updates
with `handoff_checkpoint` and use **Return to automation** after stopping local
writers. Ordinary ask answers, copying, notification dismissal and expiry never
claim work. A full agent's explicit claim is the direct pickup operation.

A human decision can explicitly use choice action `local_handoff` instead of
`resume`, `hold` or `release`. Native-origin work still needs its originating
runner's quiescence proof. For manual-origin work without a managed runner,
**Confirm manual preparation** records a separately labelled human attestation
of the published checkpoint and stopped writers; it cannot override a native
writer. Continuation prompts identify what is portable and require a fresh
registered worktree, not reuse of another executor's working directory.
The human may also choose **Request local pickup** for queued/unserved work.
That prepares the same guarded lifecycle; it does not create an execution claim.
Notifications are deduplicated by workspace and blocker/handoff episode;
clicking or dismissing one never resolves a wait.

Task `meta.execution_requirements` is monotonic: ordinary edits cannot silently
remove a tool/access/host requirement or reduce a tier. Configured gateways
advertise enabled, project-scoped model inventories, including unavailable and
disabled entries. An installed CLI or an unreported model ID is not usable model
capacity. Queued unsupported work is visibly blocked on a typed capability wait;
restoration clears only that blocker. Busy hosts produce a capacity wait rather
than an unavailable-model warning. Healthy running attempts are not aborted by
changes in future dispatch capacity. Evidence includes config revision, model
identity and expiring host observations; no human staffing/approval ask is made
just because a model is missing.

Once a gateway adopts scoped inventory revision 2, an older GUI sharing its
credential may drain existing work but cannot overwrite that inventory or borrow
it to make new claims. Other gateways can roll forward independently.

### Global model policy and gateway supply

Gateways describe **supply**, not lane policy. In `~/.bridge/config.json`:

```json
{
  "backends": {
    "opencode": {
      "enabled": true,
      "projects": ["bridge"],
      "models": {
        "medium": "provider/glm-5.3",
        "large": "provider/your-solver-model"
      }
    }
  }
}
```

Use exact IDs accepted by your agent CLI; the IDs above are examples. Omit tiers
this gateway cannot supply. A nonempty `models` map replaces the backend's legacy
single-model pin; the desktop Providers form exposes the same three fields and
`bridge doctor` reports them. All configured tiers remain advertised while a
smaller model is running. The hub verifies the selected backend/model/tier against
that live inventory at begin and retains the actual selection in the attempt and
delivery receipt.

**Upgrade existing gateway configurations with doctor:**

```sh
bridge doctor                                      # show the migration plan
bridge doctor --fix                                # preserve existing tier declarations
bridge doctor --fix --tier opencode=medium          # explicitly classify a legacy model
```

Doctor migrates legacy flat `models`/`agents` maps, backend arrays, backend
single-model pins and the global model fallback into backend tier maps. Model IDs,
agent profiles, scope, disabled backends, transport, binary paths, and config
extensions are preserved. Existing tier maps are authoritative and never replaced.
Without an explicit old tier, migration retains the historical **small** default
and says so; it never guesses from the model name. Use repeated `--tier backend=tier`
options to choose tiers explicitly during migration. Missing model IDs are reported,
not invented. Merely planning does not rewrite the config.

`--fix` saves through the atomic config store and keeps the exact previous file at
`~/.bridge/config.pre-model-tiers.json`, with both files private (0600). Legacy
credentials are preserved through their existing stores before removal from the
config; failed preservation leaves the original config intact. Invalid or newer
configs are refused without rewriting, and successful migration is idempotent.
Doctor migrates the saved file, not environment overrides, and does not restart
running gateways; the saved supply is advertised after their next safe restart.

**Workspace-wide defaults:** analysis chooses the largest live usable tier;
implementation chooses the smallest; verification chooses the smallest at least
as large as the implementation delivery. Busy gateways still count as available
supply. With medium GLM and large Sol, implementation starts medium, analysis
large, and a large implementation must be reviewed at large. Defaults apply to
managed workspaces once gateway inventory exists; legacy manual-only workspaces
retain their manual workflow. Explicit minimum requirements always apply.

Operators may override the workspace `model_policy` through the existing
authenticated settings API (`admin.settings_set`, settings key `model_policy`):

```json
{
  "analysis": { "kind": "largest_available" },
  "impl": { "kind": "smallest_available" },
  "verify": { "kind": "smallest_available" }
}
```

A lane can instead use `{ "kind": "minimum", "tier": "medium" }`. Overrides
never weaken an explicit task minimum or the verification floor. The settings
read returns validated effective defaults; invalid policy changes are rejected.
Task reads expose computed `meta.execution_scheduling_requirements` separately
from persistent `meta.execution_requirements`; the former is a read-only projection,
not another configuration knob.

**Escalation:** an executor inspects `execution` command `availability`, which
reports `next_available_tier` (or null). It explicitly calls `escalate` with its
generation/attempt, concrete limitation, and a stronger tier. It stops working;
the runner checkpoints, quiesces and yields. The next session is fresh when
backend/model/tier changes. Explicit unavailable minima block rather than fall
back, and capability restoration clears only that blocker.

**Verification:** ordinary `review_result: {kind:"findings",summary:"..."}` does
not bump implementation. For a genuine model limitation, the review duty can close
with `{kind:"stronger_implementation_required",task_id:"BR#123",summary:"..."}`.
The hub validates the subject and idle writer, chooses the next actually available
larger tier, and atomically commits the verdict and parent requeue. If none is
available, it rejects that optional bump with a precise error rather than inventing
a capability or asking a human to staff an agent. The implementation may still
explicitly declare a hard unmet requirement and wait for capability restoration.
Low confidence/risk gauges are evidence, not automatic tier or human escalations.
**Model visibility and history:** Top's model-size column contains only a size
such as `medium`, or `medium => large` when a larger model is requested. Interactive
agents show **custom** because they use whatever model is configured locally;
Bridge does not assign or infer their tier, even after a previous gateway run.
Missing observations show **unknown**. Gateway model ID/backend/host/session
remain in the tooltip. Execution state (running, stopping, lease expired,
previous execution, etc.) is available in task details. Top retains its original
single task-status chip, without an additional execution-state label or row wrap.
The automation minimum remains enforced independently of interactive display.
Train bounces that need repair return the task directly to the claimable pool,
clearing its previous owner/session while preserving the PR binding and repair
brief. A bounce does not start an agent or count as a failed execution. Old
executor-less bounced claims are repaired using worker liveness, not board-write
timestamps, so they no longer appear as phantom active agents in Top.
Both board snapshots and task reads derive this typed view from canonical
execution state, not model names or gateway defaults.

`bridge execution ready` reports backend probing, worker-credential preparation,
local capability probing and hub advertisement to stderr; `pause`/`resume` also
report their stage immediately. Successful stdout stays JSON. Each local version
probe has a two-second deadline and its own process group, so a hung CLI cannot
silently stall readiness. Pause/resume/advertise RPCs use an eight-second request
deadline with at most three retries using the same command ID (roughly 25 seconds
per remote exchange). Credential provisioning retains its separate 15-second
request bounds. Errors name the stage/deadline; a transport timeout is not proof
the server did not apply the request. Persistent gateway drain is not cleared by
`execution resume`, which only removes a temporary claims pause.

The task's normal History records model selection per attempt, agent/reviewer
escalations with from/to tiers and full reasons, checkpointed yields, and local
handoff request/accept/return. Structured events commit alongside their state
changes, and replayed commands/acceptances do not duplicate history. Routine polls
and checkpoint heartbeats stay out of this readable history. Bound human asks
retain their ordinary blocked/resume transitions and linked decision context.
Human asks must name a concrete missing decision/authority/information; local
handoffs must name the precise local-only action. Use them sparingly, not for CI
waits, review iteration or routine mechanical repairs.

Paired operators can inspect the same facts without claiming or resuming work:

```sh
bridge execution inspect 'BR#123'
bridge execution availability 'BR#123'
```

For a managed runtime update, `bridge execution pause` temporarily stops new
claims for that gateway (five-minute, self-expiring lease) without aborting
healthy active work. `bridge execution coordinate 'BR#123' '<message>'` requests
a bounded checkpoint/stop through its durable mailbox. Wait for quiescent
checkpoints and a writer-free runner before replacing it, then run
`bridge execution resume`. The gateway's own credential is required; a pause
is not a credential failure or a waiver of task/transfer fences.
After restart, an unchanged same-host claim with authoritative writer quiescence
can resume immediately; an old conversation timestamp is not evidence that a
quiesced process is still running. Local handoffs and changed holders remain fenced.

Delivery policy v1 uses signed direct-main commits for `state-vector/bridge`
and independent receipt review; other repositories retain PR/merge-train
delivery. The generated prompt uses the actual `dispatch-<task>` claim session.

The runner claims eligible `todo` work and dispatches an agent CLI in a registered isolated worktree. Delivery follows the repository's policy (signed direct-main for Bridge; PR/train elsewhere). The hygiene sweep joins the worktree registry, disk and board state; it does not delete dirty or unpublished work on a best-effort preservation promise. Clean remotely reachable trees are swept when released/terminal, or after the stale horizon when no process holds them. `sweep_repos` (`BRIDGE_SWEEP_REPOS`) adds registered roots. Claim races do not count as agent-CLI failures. Expired claims do not override the durable writer-quiescence or checkpoint-restoration barriers above.

```bash
curl -fsSL https://raw.githubusercontent.com/state-vector/bridge/main/install.sh | bash
bridge pair https://bridge.<your-subdomain>.workers.dev
```

Pairing prints a device code — approve it in the web UI (`/pair`) and the runner starts. It stays running; `bridge status` shows what it's doing. Useful env: `BRIDGE_MAX_SESSIONS` (WIP limit), `BRIDGE_WORKDIR`, `BRIDGE_AGENT` (opencode agent name), `OPENCODE_BIN`. The device declares its class at pair/start (a runner pairs as a gateway — there is no checkbox) and its label is pre-filled with the bare hostname slug (e.g. `macbookpro`), editable and display-only — the label is never identity. The gateway class comes from the token's gateway tag, not the name, and Connect lists gateways under Gateways with the agents they dispatched, separate from your interactive agents.

Prefer building from source?

```bash
cd packages/cli && cargo build --release
./target/release/bridge pair https://bridge.<your-subdomain>.workers.dev
```

Living on the edge? Every push to `main` rebuilds the binaries into a rolling **dev** pre-release (`releases/latest` and plain `install.sh` never see it):

```bash
curl -fsSL https://raw.githubusercontent.com/state-vector/bridge/main/install.sh | bash -s -- dev
```

### Run on a server

The runner is a long-lived process: keep it alive with systemd (linux) or a LaunchAgent / `nohup` (macOS).

```bash
bridge doctor            # checks config, token, agent CLIs + agent profiles, git, and the merge-train executor prerequisites (gh authed + repo scope + worker-class identity + lane-repo push, git) — every failure names the fix
bridge pair https://bridge.<your-subdomain>.workers.dev
bridge service install   # linux: writes systemd user units — supervisor (Restart=always,
                         # backoff + jitter) + death telemetry + give-up escalation
systemctl --user enable --now bridge
```

**Headless log view** — everything the fleet did, same event feed the webapp's Log view renders:

```bash
bridge logs                 # last 30 events, oldest → newest (age · actor · op · task · detail)
bridge logs --limit 100     # deeper
bridge logs -f              # follow — polls every 5s, prints new events live
bridge logs --task BR#123   # filter to one artefact
bridge logs --json          # raw JSON for scripts
```

The unit logs to `~/bridge.log` (both streams, `append:`) instead of the journal — user journals are unreadable on many minimal cloud images (journald `Storage=volatile`, or the session predates linger), so `journalctl --user` dead-ends there while the service itself runs fine. It also bakes the install shell's `PATH` into the unit (with the configured agent CLIs' dirs first): systemd's minimal default PATH misses `~/.local/bin`, which left agent CLIs unrunnable under the service. Re-run `bridge service install` after moving agent CLIs, or set `PATH` in `~/.bridge/env` to override.

**The daemon's death is loud** (BR#4682): the unit uses `Restart=always` with exponential restart backoff (5s→60s) and a 0–7s start jitter, so the runner revives from a crash **or** a clean exit without human action. Every restart-causing death fires an ExecStopPost hook that posts one `[daemon-death]` note per distinct cause (result / signal / exit code + last log lines) to the alarm sink card — deduped to one note per 10 minutes per cause, so a crash-loop can't spam the board — and always appends a local receipt to `~/bridge-death-telemetry.log` (the no-silent-deaths guarantee even when the hub itself is unreachable). Deliberate `systemctl stop`/`restart` log locally without alarming. If the supervisor ever truly gives up (`start-limit-hit`, effectively unreachable at 50 starts / 10 min against the 60s backoff cap), a separate give-up escalation unit posts one `[daemon-death ESCALATION]` note naming the manual intervention needed. The unit's `WorkingDirectory` is the user's home — never the directory the installer ran from.

The stop hook classifies systemd's `SERVICE_RESULT`, `EXIT_CODE` and
`EXIT_STATUS` (there is no systemd `SIGNAL` variable). A successful
`killed` / `TERM` (or `15`) stop produces a local `successful-stop` receipt,
not a crash alarm. KILL, SEGV, failed TERM stops and unexpected clean exits
still alarm. This classifies the exit, not who requested it: use the service
journal and updater receipt to attribute a restart. Existing installations
must refresh their installed stop hook; replacing the runner binary alone
does not replace that script. `bridge service install` from a corrected binary
refreshes it without restarting the service.

**Runner log format** (BR#4400): every operator-visible line from the runner — dispatch loop, in-process merge-train leg, store/session/keychain, CLI, canary — flows through one mechanism with one shape:

```
[2026-10-28T22:32:25Z] [train] [state-vector/bridge@main] queue: BR#4363 → BR#4362 → BR#3822
[2026-10-28T22:33:10Z] [dispatch] [BR#4371] 21m in · heartbeat text…
[2026-10-28T22:33:12Z] [train] tick error: hub rpc error (train_lease): kb temporarily unavailable — retry
```

Fields: `[<iso-utc>]` `[<subsystem>]` (`train | dispatch | pair | store | session | keychain | cli | canary`) `[<scope>]` (the lane, card, or workspace the line is about — omitted when process-global), then free text where event-style prefixes (`queue:`, `lease:`, `error:`) are the convention. The desktop gateway and the `bridge` CLI compile the same module (`packages/desktop/src-tauri/src/logging.rs`), so both binaries emit identically.

Server prerequisites: the agent CLI itself (e.g. [opencode](https://opencode.ai)) installed and authenticated — `bridge doctor` verifies. Per-agent models are required (`"models"` in `~/.bridge/config.json`); the runner refuses to dispatch without them. Models are the agent CLI's business, not the hub's: the runner injects the pinned id into the agent CLI's own config, and the CLI resolves it against its own provider config — `bridge doctor` reports the pin (and warns when unset) but does not validate it against anything hub-side. `~/.bridge/config.json` is the knob surface: `max_sessions`, `backends`, `agent`, `poll_secs`, `timeout_mins`, `model` overrides.

The desktop app (gateway with UI) is `packages/desktop`: `npm run dev -w @bridge/desktop`.

### Mobile app (iOS) — the voice console

`packages/mobile` is the no-gateway surface: `ui/` is the Fleet + For You +
Voice tab (browser-testable Vite/React over hub REST + WebSocket), `shell/`
is a Tauri 2 iOS target wrapping it (`com.statevector.bridge.mobile`).

The **Voice tab** is the narrow desktop chat, by ear:

- **Tap to talk** — `SFSpeechRecognizer` with `requiresOnDeviceRecognition`:
  on-device speech-to-text, live partial transcript, audio never leaves the
  phone. Answers are spoken back with `AVSpeechSynthesizer` (offline
  voices); tap mid-answer to interrupt.
- **The brain is the same engine as the desktop console** — Apple's
  on-device model (Foundation Models, iOS 26+ with Apple Intelligence) —
  but it drives **bridge MCP tools** over a prompt-protocol loop: it can
  `orient`, `search_knowledge`, `get_artefact` and read the ask inbox
  before it answers, citing BR# ids. Read-only by construction: it never
  claims or dispatches work, and answering an ask is confirm-first (the
  app reads the proposed answer back; you confirm by voice or tap).
- **Connect**: hub URL + a bridge token pasted from the hub's Connect tab
  (the machine plane — same token class an agent uses). The Fleet/For You
  tabs keep working with the OAuth web sign-in as before.

Build (simulator, no signing needed):

```bash
npm install
npm run build -w @bridge/mobile-ui
cd packages/mobile/shell
npx tauri ios build --target aarch64-sim
# product: gen/apple/build/arm64-sim/Bridge.app — boot it in any iOS 26+ simulator
```

**One rendering path.** The web UI and the desktop shell render the *same*
view components (Top, Backlog, Completed, task detail with dep graph and
live work tree) from the shared kit `@bridge/ui-kit`, over the same data
layer — the desktop opens a live WebSocket to the hub with its paired
gateway-class token (bearer on `/api/kb/*` + `/kb-ws`; admin routes stay
cookie-only), so both surfaces always look and update identically.

**The board is push-driven — no polling (BR#4362).** The socket carries
state, not just a doorbell: every mutation streams a `kb.event` frame, and
the hub pushes a coalesced `kb.board` snapshot (at most one board build per
second, no matter the mutation rate or how many clients are connected) plus
a hydration snapshot on connect. Clients apply frames to their store and
fetch nothing on a timer; `GET /board` stays as a 2s-cached hydration path
for stragglers. Desktop shells whose webview can't hold a cross-origin
socket tail the events mirror adaptively (2s while busy, backing off to 30s
idle) and coalesce event bursts into one refresh — the 2026-10-29 overload
was every client refetching the full board per event. Pull surfaces are
rate-limited per identity as a backstop (`/board` 30/min, `/events`
120/min; 429 + Retry-After naming the socket) — pollers brake themselves.

Beyond dispatch it carries three human-facing surfaces:

- **For you + Chat** — the decision inbox (proposed decisions, blocked work, open questions, read-only) and a console chat: ask about the board in natural language. Retrieval runs over the hub (`/api/kb-machine/search`, paired token); the answer is summarised by **Apple's on-device model** (macOS 26+ with Apple Intelligence) and falls back to the configured backend CLI one-shot otherwise. The console never claims or writes work.
- **Decision notifications** — the app watches the inbox and raises an OS notification whenever a new proposed decision arrives (the click jumps to For you). Machine verify-verdicts never land here: they are not proposals — they accept on filing and apply to their target (BR#5377), so the inbox stays for genuine human decisions. When a verdict card is surfaced anywhere (decisions panel, history), it renders the hub-minted canonical title ("Verify verdict — ACCEPT — PR owner/repo#N → card BR#X"), never the verifier's internals-dense authored one (which rides at the top of the body). No runner required.
- **Guided sign-back-in** — if the run gate signs the desktop out (the identity law reserves gateway dispatch for gateway-class tokens: a pre-gateway token surviving an app upgrade), the sign-in screen says so in plain language — what happened, that nothing was lost (hub URL and settings are kept), and that signing back in is one click: the browser opens itself, and the vended gateway-class token re-associates with the same stable device id. Legacy board rows keep their labels; only this device's token rotates. (A token the hub *rejects* mid-run is not a sign-out anymore — see the self-heal law below: the gateway parks loudly and recovers on its own, BR#4113.)

### Runner config file

All runner *knobs* live in `~/.bridge/config.json` (written through a single
atomic save; safe to edit by hand — settings in the desktop app apply by
updating the same file). **Credentials never live there**: the gateway token
is stored in the OS keychain (data-protection keychain on signed macOS
builds; `~/.bridge/gateway-token`, mode 0600, on unsigned dev builds and
Linux), and the device principal is write-once at `~/.bridge/principal`
(0600) — `bridge reset-principal` is the only local clear. The principal is
the device credential and anchors identity: the hub vends it on first pairing
(`dev_` + 24 random bytes hex, generated once, never regenerated), the device
presents it on every pairing and desktop login, and re-pairing or re-login
rotates the gateway token in place against it — the hostname is a display
label only:

**Rotation is graceful and self-healing (BR#3787)** — a gateway is never
killed by a rotation and never needs a manual re-pair:

- **Identity law**: provisioning and pairing match tokens by the **principal
  only**. A label held by another device's credential is a collision —
  self-provision mints a suffixed row, human pairing refuses with a named
  error. Rotation never steals another device's token (the 2026-10-27 fleet
  401 ping-pong was exactly this theft).
- **72h grace**: when a token rotates, the **previous** hash keeps
  authenticating for 72 hours, flagged stale. Rotation is a re-vend signal,
  not an amputation — in-flight dispatches finish. Admin revocation still
  kills both hashes instantly.
- **Negotiated self-heal**: every authenticated response carries
  `x-bridge-token-epoch`; the runner re-vends its own row proactively at the
  next tick boundary when the epoch moves (`POST /api/token/repair`, agent
  plane — the principal is the credential, so **headless gateways self-heal
  without a human session**). On a hard 401/403 the runner classifies the
  failure and runs the **self-heal ladder** — keychain reload (another
  process may have re-vended), principal repair, desktop self-provision —
  with exponential backoff (5s doubling, 300s cap), and every repair failure
  reason is logged, never swallowed. **Auth failure is never terminal while
  desired state is "running" (BR#4113)**: there is no logout-and-halt path
  left in the loop. If the ladder stays blocked the gateway PARKS LOUDLY — a
  `needs attention` banner in the app (and `needs_attention` in
  `~/.bridge/dispatch/runner.json`) — while it keeps polling and retrying on
  the capped cadence, resuming dispatch on its own within one poll interval
  the moment the hub accepts the device again (grace window, rollback, row
  restore) — zero human action. Only the identity-law gate (a saved token
  that is not gateway-class) signs the desktop out, and only a lost/revoked
  principal forces a human re-pair; an admin revoke parks the gateway loudly
  (it claims nothing) instead of stopping it silently. Repairs are
  rate-limited per token (6/hour) so a crash loop can't mint infinitely.

**Owner columns render labels, never anchors (BR#4262)** — the owner stored on
a card is the **principal** (the matching anchor); every display surface
(board, orient, get_artefact, my-tasks) resolves it through a render-time join
to the owning token's **label**, falling back to the stored value verbatim
when no token row matches (legacy `system:*` owners, hand-minted labels).
Matching never uses the rendered label. And the namespaces never impersonate
each other: new principals are vended `dev_`-shaped (`generatePrincipalId` —
a principal can never be mistaken for a `bkw_` token; existing principals are
not migrated), and every label door (`token.rename`, pair approve,
`agent.provision`, human mint) rejects `bkw_`/`dev_`-prefixed labels — the
2026-10-28/29 incident was a token-shaped string pasted as a label that then
rendered into owner columns.

Unclaimed cards have no owner. Board and orient owner lookups never resolve an
empty owner through a token's empty principal, including revoked registrations;
retired machine names cannot appear as fabricated owners of pooled work.

**Machine/agent names are display, not identity — renames alias, never mint
(2026-10-29)**: a hostname change (macOS local-name rotation, the network's
`-2` dedup suffix, a VPS's DHCP IP, a lost principal file) used to mint a
fresh gateway identity and — because agent labels are namespaced
`<gateway>/<agent>` — a fresh identity per provisioned agent, piling dead
labels on the board. Now every rename through the principal anchor records
the old name in `identity_aliases` (`old → current`), and:

- `agent.provision` under a renamed gateway **renames the agent token in
  place** (same id, same hash — the runner's stored secret keeps working)
  instead of minting `<newGW>/<agent>`;
- the identity list (`/agents`) collapses each identity to its live label
  and carries the retired names as `aliases` (gateway→agent edges resolve
  across the alias set too), so history reads through one name;
- `admin.alias {alias, canonical}` merges the legacy dead labels that predate
  the principal anchor (human asserts the mapping once; `admin.aliases`
  lists the table; a retired name can never be a canonical, so chains stay
  forward-only).

**Dead registrations reap themselves — the roster is a sweep, not a landfill
(BR#4684)**: the hub's watchdog archives (revokes, never deletes) gateway
registrations with no auth signal for `roster_reap_days` (default 7) and
tokens that were provisioned but never once authenticated (`roster_reap_hours`
paces the pass, 0 disables; `admin.roster_reap` drills it with an injectable
clock). The row and its audit trail stay; the roster shows only live-or-
recently-live gateways; a returning machine is one approval click — the same
principal re-pairing rotates the same row back to life in place and the old
label rides along as an alias. Once-seen agent identities are never reaped on
silence: their labels are board history, not infrastructure.

```jsonc
{
  "schema_version": 2,                 // written by the runner; future versions warn
  "url": "https://bridge.<your-subdomain>.workers.dev",
                                       // no "token" — the keychain owns it
  "workdir": "/path/to/repo",          // repo the runner works in
  "max_sessions": 1,                   // concurrency: concurrent agent sessions (WIP limit)
  "backends": {                        // provider sections — each carries its own config
    "opencode": {                      // model optional: unset = opencode's own default config
      "model": "openrouter/~anthropic/claude-haiku-latest",
      "agent": "reviewer",             // optional agent profile
      "bin": "/home/me/.local/bin/opencode", // CLI binary override — ABSOLUTE path strongly
                                             // recommended under systemd (minimal PATH)
      "mode": "acp"                    // transport: "acp" (default, live session updates) | "stdio"
    },
    "kiro": {                          // profile-driven: the kiro profile pins provider+model
    }
  },
  "report_minutes": null,              // null = agents report like a human (at natural milestones);
                                       // number 1-60 = fixed heartbeat cadence, in minutes
  "poll_secs": 60,                     // how often the runner polls the board
  "timeout_mins": 30,                  // per-session kill switch
  "isolate": true,                     // per-task git worktrees + PR branch (default true)
  "worktree_exempt_repos": [],         // repos where per-task worktrees are skipped
  "sweep_repos": []                    // extra git repo roots whose registered worktrees the hygiene sweep enumerates (env BRIDGE_SWEEP_REPOS)
                                       // (webapp-only checkout class); env override:
                                       // BRIDGE_WORKTREE_EXEMPT_REPOS (comma-separated)
  "identity": {                        // git commit/signing identity for dispatched
                                       // sessions (BR#3185). Omitted = the built-in
                                       // worker class (detached-cody per BR#3181).
    "name": "detached-cody",
    "email": "297316395+detached-cody@users.noreply.github.com",
    "signingKeyPath": "~/.ssh/sv-agents-signing.pub",
    "signingProgram": "/usr/bin/ssh-keygen"
  }
}
```

### Identity profiles (git signing, BR#3185)

Dispatched sessions commit under a **first-class identity profile** — not
ad-hoc `-c` overrides. At worktree provisioning the runner writes the
profile into **repo-local** git config on the runner's own clone (the
config that clone's worktrees share — never `--global`: `user.name`,
`user.email`, `user.signingkey`, `gpg.format=ssh`, `gpg.ssh.program`,
`commit.gpgsign=true`); your global git config is never touched, so the
shared checkout keeps its own identity.

- **Built-in class `worker`**: every dispatched session defaults to
  `detached-cody` / `297316395+detached-cody@users.noreply.github.com`,
  signing with `~/.ssh/sv-agents-signing.pub` via plain `/usr/bin/ssh-keygen`
  (the BR#3181 ruling — no 1Password in the agent path). The values are the
  recorded contract `packages/contracts/fixtures/identity-profiles.json`;
  the runner fails its own test suite when the built-in drifts from it.
- **Precedence**: an explicit `identity` block in the config beats the
  built-in class; the built-in class beats whatever is in the host's global
  git config for sessions dispatched into worktrees. An agent overriding
  `user.*` ad-hoc (`-c`) drifts the committer identity away from the class
  — the verify gate bounces that.
- **Validation leg**: provisioning ends with a scratch sign check through
  the profile's own program and key (`ssh-keygen -Y sign -n git`). A
  missing key, wrong program, or hung signing program refuses the dispatch
  loudly (like the smoke gate) — the task is noted on the board and the
  runner retries next cycle; unsigned commits are never shipped.
- **Board surfacing**: Connect nests each gateway's provisioned worker
  agents under it with their identity class, and the pairing screen states
  the class the device declared plus what its runner's dispatches commit
  as (BR#2455 grouping, reused).

If the hub rejects the token (401), the runner attempts **one** automatic
repair (re-vend via the live login session) and, failing that, logs out
loudly with a human-readable reason — the token never silently vanishes.

If no agent CLI is dispatchable, the runner says so loudly every tick and **exits non-zero once in-flight sessions drain** — `systemctl status bridge` shows the failure and `Restart=always` (with backoff + jitter, BR#4682) revives it; a non-dispatchable agent CLI is a fix-it-then-restart situation, `bridge doctor` diagnoses. Under systemd, use absolute `bin` paths or a `PATH` override for the unit: the service does not inherit your shell's PATH.

Notes:

- **Per-provider config**: models live in the `models` map keyed by provider —
  opencode needs an explicit model (the runner refuses to dispatch without
  one; the CLI's own default is how a stale pin silently downgrades a fleet).
  Kiro is profile-driven, so it needs no model entry.
- **Identity**: gateways and agents share one label namespace with a class
  boundary — gateway tokens are infrastructure labelled with the hostname slug
  (e.g. `macbookpro`) and tagged with the gateway class; they are never task
  owners, and agent labels (`opencode-ray`) never take the gateway tag. The
  token (its principal) anchors identity: the class is the gateway **tag** on
  the token, never a name convention — labels are free-form display and
  nothing gates on a label shape (a label held by another device's credential
  is a collision, not a naming violation). Connect
  shows gateways with the agents they dispatched, attributed agents nested
  under their gateway. Dispatched work is attributed to the agent the gateway
  dispatched as, named `<hostname>-<backend>` (e.g. `macbookpro-opencode`) or
  overridden with `"agent_name"` in the config. Legacy tokens keep their
  labels — the boundary is enforced by the gateway tag on the token, never
  by the name.
- **Model cost**: whatever you set here is what every dispatched session uses.
  Check the opencode CLI's own config (`~/.config/opencode/opencode.json`,
  `"model"` key) if spend looks high despite a pin here.
- **Reporting**: the runner relays each agent's real stdout lines to the board
  as it works, so narration = liveness. Set `"report_minutes": 5` only if your
  agent produces no narration at all.

## 4 · Connect agents (MCP)

### Interactive clients: OAuth (Codex and other remote MCP clients)

Point an OAuth-capable client at **`https://hub.fleetbridge.run/mcp`**.
For Codex CLI:

```sh
codex mcp add bridge --url https://hub.fleetbridge.run/mcp
codex mcp login bridge
```

The client discovers Bridge's OAuth endpoints, opens browser sign-in, and asks
you to authorize interactive-agent access to your **currently selected workspace**.
The responsive consent page shows the client, workspace, permissions and return
address. If a request expires or cannot be verified, it explains how to reconnect.
Select the workspace in Bridge before connecting. Approving automatically
allocates a unique `_direct/<client>-<id>` agent, visible and revocable under
**Connect**; no manual token minting or bearer header is needed. Each authorization
gets its own identity, while token refresh keeps that identity. The agent can
claim work using its named `orient` session under the existing interactive rules;
human-only decisions and independent-review separation still apply.

Bridge supports public-client registration, authorization code with mandatory
S256 PKCE, exact registered redirect URIs (HTTPS or loopback HTTP), MCP resource
binding, one-hour access tokens, and rotating refresh tokens. Authorization lasts
up to 30 days; reconnect after expiry or revocation. Refresh-token reuse revokes
the entire authorization, so clients must serialize refreshes. Revoking the agent
in Connect or removing workspace membership immediately prevents access and
refresh. OAuth credentials are valid only at `/mcp`, not the human/gateway REST
planes. A cancelled consent allocates no agent.

Self-hosting uses the existing GitHub login secrets and workspace membership;
the worker deploy creates the `MCP_OAUTH` SQLite Durable Object via migration
`v4-mcp-oauth`. Discovery is served at `/.well-known/oauth-protected-resource/mcp`
and `/.well-known/oauth-authorization-server`. Use the same hub origin throughout
login and token exchange; authorizations are bound to that origin's `/mcp` URL.

### Headless clients: provisioned bearer credentials

Agents join the fleet by pointing their MCP config at the hub. The config
format is per-client — the Connect tab's **setup** modal emits the right
snippet with your token slotted in.

**opencode** — add an `mcp` entry to `~/.config/opencode/opencode.json`
(note: the key is `mcp`, *not* `mcpServers` — opencode silently ignores the
latter, and an agent with no bridge tools will waste its run hunting for a
CLI):

```json
{ "$schema": "https://opencode.ai/config.json",
  "mcp": { "bridge": {
      "type": "remote",
      "url": "https://bridge.<your-subdomain>.workers.dev/mcp",
      "enabled": true,
      "oauth": false,
      "headers": { "Authorization": "Bearer <token from the Connect tab>" }
} } }
```

`oauth: false` matters for headless use: without it opencode tries a browser
OAuth flow when the hub returns a 401, which hangs a dispatched session.

**Generic `mcpServers` clients** (claude code and similar):

```json
{ "mcpServers": { "bridge": {
    "type": "http",
    "url": "https://bridge.<your-subdomain>.workers.dev/mcp",
    "headers": { "Authorization": "Bearer <token from the Connect tab>" }
} } }
```

Verify with `opencode mcp list` — `bridge` should list the board tools.
Config is merged per-server-key, so the bridge entry coexists with any other
MCP servers the host already uses.

Dispatch hosts: the runner spawns `opencode run` as a child process, so the
agent CLI resolves **its own ambient config** — a dispatch host needs this
entry for whichever CLI the runner drives, or dispatched sessions start
toolless.

Mint agent tokens in the web UI under **Connect**. Agents call `orient` first — it returns the protocol card, open work, decisions awaiting consensus, and the agent's own behavioural score. Every artefact row an MCP tool returns carries `url` — the card's canonical deep link (`https://<hub>/card/BR-3990`) — so an agent citing a card can hand a human the link that opens it (BR#3990). Emitted links always use the canonical origin — the `CANONICAL_ORIGIN` var (default `https://hub.fleetbridge.run`; set it to your own domain when self-hosting on a custom domain), never the ingress host a request happened to arrive on, so a hub reached via its fallback hostname still hands out canonical links (BR#4695).

**Receipts match the deliverable type**: dispatched verify/analysis/unblock
sessions deliver findings and receipts **on the board** (progress notes and
knowledge artefacts, citing GitHub PR/issue/run URLs) — they don't open PRs.
Only code work opens a PR. A URL that isn't a GitHub PR/issue/run URL is not
a receipt, and a dispatch run that was provider-blocked (no model, no
endpoints) can never hand off as complete.

**Card edits merge (BR#5807)**: `update_artefact {meta}` is a per-key MERGE, not a
whole-object replace — each top-level key you pass replaces wholesale (nested objects
must be complete), and every key you omit is PRESERVED. meta is infrastructure on lane
cards (`lane`/`lease`/`currently`/`stop`) and parked cards (`blocked.await_event`): a
partial-meta edit can no longer amputate lane config or a typed wait (the BR#5733
near-miss, where a single-key edit silently dropped a lane card's entire config).
Removing a key is explicit — `meta_delete: ["key"]` — and a `null` value stores as
null rather than deleting. Lane/park infrastructure keys refuse `meta_delete` from
agent sessions (machinery/web/human authority only — the same authority class as the
close-protection law), and every meta set/delete is named in the card's history line,
so a meta shrink is never silent.

## Agent lanes: roles & playbooks

Tokens are lane-tagged: `role:analysis`, `role:impl`, `role:review`. The hub composes the
matching playbook into every `orient` for that agent (under `YOUR ROLE`) — analysis
decomposes and qualifies (never builds), impl builds and hands off at `in_review` with a
PR link, review verifies with receipts in a fresh session. Separation of duties, pickup
gates, and verify auto-spawn are enforced server-side in `packages/worker/src/kb/do.ts`,
not by client convention.

**Verify is the merge authority; the merge train is the executor** (standing order BR#3033,
re-divisioned by BR#3516). The verify round reviews substance and records an accepted or
rejected verdict — its accepted verdict is what licenses the merge; the mechanical merge
itself is executed by the **merge train** (the next section): a credential-holding edge
executor that runs the 5c gate and merges when the verdict covers the current head and
checks are green. There is no separate human merge gate for a verified PR. The cycle is:
impl works → rebases → pushes a mergeable PR → `in_review`; verify reviews substance
(mergeability confirmed first — rule 5c); findings → bounce back to impl
(`in_review → in_progress`, one round, N bounces — the same verify round re-enters, it
never stacks; a depth-capped card's round rides detached and re-enters the same way —
BR#6518); loop until the train merges and closes. The one-round rule is
**target-scoped** (BR#5874): a second verify duty linked under the same parent supersedes
an older open round only when both cover the SAME PR — resolved from the card's `meta.pr`/
`meta.prs` binding, its body's GitHub pull URL, or its title ("slug PR #N"). A disposition
verify duty covering a DIFFERENT PR (an impl session's done-when leg) coexists — it never
counts as the parent's round, and a bounce keeps the newest same-PR round even when a
cross-PR duty is newer. Duties with no PR signal anywhere (child, sibling, parent) keep
the legacy newest-wins supersede. Impl owns mergeability
*preparation* (rebase before every in_review — a conflicting PR is the impl's defect, not
the reviewer's); the train owns mergeability *enforcement* (a conflicting, red or unsigned
PR is bounced with the exact defect — never merged silently).

**Bounces name their kind, and the queue is durable** (BR#4066/4067/4068): a train bounce is
one of three kinds with different next owners — **conflict** (trial-merge files listed; impl
repair leg), **coverage** (the live head isn't covered by the accepted verdict — no conflict
exists; the card immediately re-enters review and a fresh verify duty re-checks the head, so
the stamp-race class self-heals), or **gate** (the named mechanical defect). The hub stamps
the kind, defect and files on the card and **boosts it to priority 0** — a bounced
merge-ready card is the board's highest-value work and must not re-enter at default priority
and starve. A fresh verify accept on a non-conflict bounce re-queues the train automatically
(no agent hands the card back). The coverage self-heal is gate-proof (BR#4494): its
`in_review` re-entry note carries the PR link the review gate requires, so the demanded
re-verify duty always spawns instead of the re-entry silently stranding the card
`in_progress`. And machine silence-releases (watchdog sweeps) can no longer
destroy queue state: a card the train owns (`queued` / `awaiting-ci` / `bounced` on a live PR
leg), or one parked on a typed `await_event` or a bound ask, is never released to todo — the
sweeps **park it `blocked` with the typed proxy intact** (the proxy owns its exit), and the
machine-actor backstop refuses any release path that slips past them (BR#4067). Humans and
owners still release freely. The hold-park itself runs only AFTER an atom check (BR#4282): The one exception is the bounce re-entry (BR#4494): a bounce re-opens its card `in_progress` with the prior — usually dead — executor session, and `in_progress` is not claimable; for a `bounced` card the train has already handed the leg back to the board, so when the re-entry sits silent past the stale window the sweep **demotes it to a claimable todo** (bounce brief and boost intact; result class `bounce_reentry_demote`, exempt from abandonment scoring) instead of re-parking it — `queued`/`awaiting-ci` keep the full hold.
the hub holds no VCS credentials, so a `pr_merged` proxy is evaluated against BOARD receipts
only — the train's own `awaiting-ci` stamp (with `merge_sha`) or the `provenance` row. A
proxy that is already satisfied is never re-armed: instead of re-parking the card blocked,
the sweep spawns the owned done-close duty — which, when the parent sits `in_progress` or
`in_review`, closes ITSELF done first and then the parent (the exit flipped while the card
worked; it owes a close, not a resume). The silence-re-park can also no longer loop: a
flood-guard skip (`skip_unblock_spawn` with `flood: true`) is the dedup working and is
audited without folding a breach card, and a resume consumes the unblock round so post-resume
silence issues one fresh round instead of flooding for an hour. The spawner cap re-suppresses
the same way (BR#4702): once the BR#2893 escalation stands, further capped attempts audit
`spawn_cap_skipped` without folding a breach card — the escalation, not a per-tick breach
card, carries the recurring block to the human ledger. The verify spawn's nesting guard
plays the same law (BR#6518): the BR#532 depth cap (`child_of` chains ≤ 3) used to make a
depth-capped card entering `in_review` skip the verify spawn outright — no review leg ever
existed, the card sat in review believing a verifier was coming, and the skip folded a
spawn-while-open breach card on the guard's own working. The guard now reroutes: the duty
spawns DETACHED (no `child_of` edge — the cap holds by the letter; a verify duty cannot
recurse anyway, review cards never spawn one), the round is stamped on the subject
(`meta.verify_round`) so a bounce re-entry reuses it instead of stacking a duplicate, and
the (now unreachable) skip path audits `spawn_verify_skipped` without folding.

**The bounce budget caps the loop** (BR#4688): same-kind bounces on one PR are budgeted at
**5** — the hub counts `train_events` per (repo, base, PR, bounce kind) since the last
cleared escalation, and the **6th bounce of the same kind escalates** per the BR#3312
disposition instead of re-entering the queue: the card is stamped
`meta.merge_train.escalated` (kind, bounce number, head sha, grace window), folded
**blocked-on-ask**, and exactly **one bound ask** is filed — the fold is itself the
de-queue, so a 7th bounce is unrepresentable (the BR#279/#281 storm class: 31 gate bounces
on one PR in a day; replaying the 2026-10-28 ledger, this budget escalates both PRs at
bounce 6, ~11h before the RCA was filed). Re-queueing an escalated card requires real
movement — the head must move past the escalation's stamped sha, or the ask must be
answered; either stamps `cleared_at` + `cleared_via` (audit `bounce_budget_cleared`) and
resets the episode's counter. A different bounce kind still bounces normally — new
information, not the loop. If the grace lapses (`pr_grace_hours`, default 48, never 0), the
executor's expiry leg probes the PR live via `gh`, closes it with the reason as a comment,
and reports `escalation_closed`; the hub acts only when it can validate an ACTIVE escalation
of its own (the executor never self-certifies), answers the ask, and leaves the card `todo`
as the record — the storm ends, the history survives. The trains panel renders the count
live: a ×N ledger-bounce chip per queued PR (red once over budget) — on the queue rows and
the merge-batch blocks alike — plus the escalation clock chips while an episode is open.
The trains panel is honest about capability and activity (BR#4981): a held lock names
its machine; an idle lane ticked by a merge-capable gateway inside the 15-minute window
shows the pill `train ready` (the tooltip names the machine and its last tick age);
only a lane with no capable tick inside the window says the muted pill `no gateway`;
a gate in progress on the queue head reads `attempting` (with the head card and the
last ledger action in the tooltip); a protection-blocked head reads `⏸ bypass wait`;
a retired lane reads `retired`.
The lane row is three labeled time-frames (BR#5114, Ray 2026-10-30: "I want to know
WHAT is being done right now and progress, what is up next, what is in the queue
remaining"): **NOW** — the status pill + in-flight PR + phase age PLUS the holder's
live last action verbatim from its tick log (the BR#4104 proof-of-progress seam,
hub-consumed: `meta.lane.now_action`, rendered only while fresh against the 5-minute
lease TTL — a held head SAYS why it is held, e.g. "PR #2588: head check RED:
Meta-review nightly", instead of a bare `gate` pill for hours); **NEXT** — the first
queued card + its PR; **QUEUE** — the remaining cards with their PRs and depth. The
executor stamps the gate's Skip/Note verdicts into that seam (`ctx.note` on the gate
outcome), the hub persists the latest renewal note, and the throughput rate + last
completed event (with age) close the NOW column so "last" and "now" are never
conflated again.
The lane's PR column shows ALL of the lane's PRs by verification state and merge
batch (BR#5658 v2, Ray 2026-11-03: "each lane needs to show PR stats —
in-progress, verifying and ready… the backlog train just shows the batches of
verifying/ready PRs based on how they can be merged in batches… colours should
denote verification — green if ready, orange pulsing if being verified, orange
solid if waiting to be"):
1. **3-bucket lane PR stats (`N in progress · M verifying · K ready`)**:
   `in_progress` counts open PRs on the lane in active implementation (or bounced
   back to `in_progress` / conflicted); `verifying` counts all PRs in the
   verification stage across `in_review` (both `Verify:` todo and `Verify:` in
   progress), `awaiting` review parks, and `reconcile` verify duties; `ready`
   counts verified (`ACCEPT`) PRs ready to merge. BR#5897 correction (Ray colour
   law, 2026-11-03): a car already sitting in `lane.queue` has **passed
   verification** — a `cls: "waiting"` car renders `ready` green while the
   walk's base verdict is still settling (`verified — ready to merge (waiting
   on lane/CI)`), and once the base is green in the walk the same car renders
   `verifying` (orange pulsing, `being verified — checks/mergeability running`)
   while its own head checks / mergeability / gate re-run finish; `verifying`
   (orange pulsing) is otherwise strictly PRs being verified right now (an
   active `Verify:` child, an in-flight `awaiting` park, a live reconcile
   verify duty), `waiting` (orange solid) is strictly PRs waiting to be
   verified (`Verify:` todo, an idle park, `cls: "needs-review"`, an unclaimed
   reconcile-seen PR), and `conflict`/`blocked` — like a queued car with no
   stamp at all after a bounce-free walk — count as in progress.
2. **Sequential merge batches (`Batch 1 | Batch 2 | …`)**: `partitionMergeBatches`
   orders candidates by readiness state first (`ready` → `verifying` → `waiting` —
   the train is NOT FIFO: ready PRs merge immediately in Batch 1 without waiting on
   verifying PRs) and runs `selectBatch` iteratively over the lane's verifying + ready
   PRs (using the executor's `conflict_pairs` and `lane.burst_max`), separating batches
   with `.train-block-gap` dividers.
3. **Verification colour law & lane idle/held clarity**: inside each batch, **green solid (`.tb-ready`)** =
   ready (verified), **orange pulsing (`.tb-verifying`)** = actively being
   verified right now (`Verify:` child `in_progress` / live heartbeat <10m /
   walk checks running), **orange solid (`.tb-wait`)** = waiting to be verified
   (`Verify:` child `todo` or idle `awaiting` park; never red on awaiting,
   never diagonal stripes, per BR#5476). When `ready === 0`, the lane status pill
   shows whether the line is idle waiting on verification/PR checks (`idle — 0 ready`)
   or held/starved on failing checks (`⚠ held` / `⚠ starved`), and `attempt` targets
   the first `ready` car rather than FIFO `queue[0]`. Stale base-health merge gates
   (`Deploy health (merge gate)` and `main-green gate`) self-heal via `rerun_gate` on a green base.
And three structural guards close the loop: `trainParseNoteLegs` validates GitHub
`owner/name` syntax and rejects `/BR#N` tracker tokens and numeric owners so prose
never mints ghost lanes (`tb-pulse/BR`, `5563/BR`); direct-to-main landings
(`commit/<sha>`) auto-close the `in_review` parent `done` when `Verify:` accepts;
and answering an unbound implementation handoff ask (`BR#5476` class) auto-mints a
qualified `task` card linked `derived_from` the ask.

**One card may carry several PRs** (BR#3659): a verify close that accepts multiple PRs
cites **every** PR URL with one `head <sha>` after each — `PR <url> head <sha>; PR <url>
head <sha>` — and the hub queues one **leg** per PR (`meta.prs`; pairing is
line-adjacency based: a head after `;` belongs to the next clause's PR, never the
previous one, and a cited PR without its head fails the queue closed with the card
stamped `unbound`). A single-PR close keeps the pre-3659 shape (the note's one URL
binds its first `head <sha>` wherever it sits). The citation itself is
convention-tolerant (BR#4648): a PR cited as the board's own `owner/name#N`
shorthand — the way every bounce note and brief writes it — parses like the URL
(the URL form wins when both cite the same PR), and a head-bearing close with no
PR citation at all refreshes a card that has exactly one open leg (multi-leg
stamps stay fail-closed — a lone head is never guessed onto one of several
legs). It is convention-tolerant again (BR#5329): the typed machine-leg prose
`repo=owner/name n=N` — the shape every park note's typed `await_event` leg
already carries — and the seeded duty brief's JSON-ish `repo:"owner/name", n:N`
parse like the shorthand, the closing duty's seeded brief (the verdict record)
is parsed before the legacy card body so a prose-only close still stamps
(BR#5048 structural follow-up #2), and a bare `PR #N` citation names an
EXISTING open leg — on a multi-leg stamp the lone `head <sha>` refreshes the
named leg instead of staying fail-closed. Every parsed row is validated before
it can become a leg: a repo token that is not a real GitHub repo shape (an
all-numeric owner — the residue of slash-joined card-reference prose like
`BR#4365/BR#4875`) never reaches `meta.prs`, so a misread card reference can
no longer queue a ghost merge lane; stamps polluted before this rule are
cleaned on the next accept (`queue_ghost_leg_dropped` audit). The re-queue
note is honest about it: it says *stamp refreshed* only when
a stamp actually moved, and an accept whose `head <sha>` cannot bind any leg is
audited loud (`queue_stamp_not_refreshed`) instead of silently re-queuing a
stale stamp — the silent-stale class that once spun coverage bounces on an
unchanged head (five accepts on BR#3764 while the stamp never left the old
head). The card closes only when its **last**
leg lands — after a partial landing it stays queued with an honest reason naming the
legs still out, and the train drives the next leg on a later tick. A bounced card is
NOT re-queued by a stale verify close (the bounce stands until the card re-enters
review and a **fresh** verify duty accepts the new head) — the close-note scrubbing
workaround from BR#3651 is obsolete.

- Hub defaults: `DEFAULT_ROLE_PLAYBOOKS` in `packages/worker/src/kb/core.ts`.
- Per-hub overrides: admin settings → **Roles & playbooks** (`settings.roles.*`); clearing
  an override resets to the hub default.
- Subagent prompt seed: the pinned card at `packages/adapters/bridge-protocol-card.md`.
- Full contract: `docs/roles-and-playbooks.md`.

On **tasks**, roles live in a dedicated `roles` column — `create_artefact { roles: ["review"] }` —
never in tags. `tags` are 100% free-form user/agent labels (themes like `gtm`, `deploy-train`,
`pricing`): they render as chips and drive the filterable theme bar in Top and Backlog, but they
never change system behaviour — tagging a task `role:review` does nothing. **Questions are their
own artefact type** (`type: "question"`; asks create them automatically): open participation,
answered via the ask band or progress entries, closed to done/superseded — never claimed.

**Humans can hold a question** (BR#3911): on any open question card, **Claim — I'll handle it**
(web + desktop, human session only) stamps a 10-minute hold (`human_claimed {by, ts, expires_ts}`)
that dismisses the question from the agent pool — agent inboxes drop it, orient says
`in hand by <you>`, and agent contributions get a stand-down postscript. Claim ≠ answer: protocol
6b stands, the question still closes via your ADR. Answer or close before the window and the
timer cancels; no-show and the watchdog sweep auto-reverts the hold, leaving an expiry note on
the card (honest churn, never silent). Release puts it back early; agent claims on questions
stay forbidden, and the runner claim path is untouched (the hold is a meta stamp, not a
transition). Window: `question_claim_minutes` setting (default 10).

## The ask contract: asks are question nodes

**Recovery and completion are explicit (BR#6483).** Queue diagnostics and aged
conflicts create deduplicated repair tasks owned by Bridge, never a question asking
the human to investigate or find another agent. A live executor or current review
outranks historical queue metadata. An earlier unrelated merge is not proof that a
line is healthy now. The Backlog reports repair **working**, **scheduled**, or
**not scheduled** from the real recovery duty and executor heartbeat; current task
dependencies outrank old bounce labels. Obsolete built-in strand/conflict requests
are cancelled without fabricating a human answer.

New explicit `human_decision` requests require `decision`: `kind` is authority,
information or preference; `task_id` is the affected task (not an alarm sink);
`context` and `why_human` explain the actual choice. Each choice carries `label`,
`executor` (bridge/human), `consequence`, and `action` (resume/hold/release). The
effect comes from that action, never a verb in the label. Human execution steps
hold the task until confirmed; free-text steering cannot silently release/resume
it. All three ask views share the essential context/why renderer, show named
executors and consequences, and put supporting evidence under Details. They show
no offline/never-seen diagnostics for human recipients. Legacy requests retain
their full brief; their compatibility adapter does not rewrite their meaning.

Task `meta.completion` is `{kind:"delivery"}` or `{kind:"execution",outcome}`.
Only delivery work completes on a merge receipt. Execution work waits for its
prerequisite, then returns to the agent pool with the receipt; its actual actions
must finish with `execution_result {outcome,receipts}`. Legacy `depends_on` markers
adapt to execution. Review acceptance, queue admission, merged-park healing,
burst settling and reverse reconciliation all preserve this distinction.
Execution review accepts with `review_result {kind:"accepted_execution",task_id,receipts}`
after checking the actual outcomes; it needs no fictitious implementation PR.
An already-authorised disposition can be applied via transition `batch_auth`, or
persisted `meta.disposition_request {kind:"apply_authorized_supersede",ask:"BR#N"}`
followed by transition to superseded. Both consume the same receipt-scoped human
authorisation gate and recheck the target; neither grants an agent human authority.
The alarm also consumes persisted disposition requests, so a crash between request
and application cannot skip the cleanup. Semantic refusals become terminal receipts;
storage faults leave the command pending for retry.
Recorded **per-card** human retirement decisions are replayable through that same
gate: an explicit `SUPERSEDE` answer, or a `retire BR#N` clause naming the ask's
bound task, can retire its still-unclaimed `todo`/`blocked` card. KEEP/NO answers,
unrelated targets, active writers and outstanding PR responsibility remain
protected. Replaying the same completed retirement is an idempotent acknowledgement.
That exact recorded retirement can cancel an unstarted capability wait; local
pickup, paused interactive ownership, live writers and uncertain operations
retain their independent fences.
Executor-observed CLOSED/MERGED PR receipts satisfy delivery conservation for a
retirement; a closed PR is not an outstanding open obligation. Malformed legacy
PR bindings are audited against the typed event grammar and retained as history.
An authenticated interactive owner's deliberate preserved-work release is a
handoff, not another failed automated attempt: prior retry history is archived in
an `interactive_handoff` event and the new execution round starts at zero. Foreign
sessions, live writers, uncertain operations and unattended watchdog churn remain
subject to their normal fences and cooldowns.
A bounced `todo` repair with no separate recovery owner is executable board
work, not an active train wait. Discovery and atomic reservation ignore only
that historical bounce; real typed prerequisites, queued slots, recovery owners,
writer quiescence and external-operation receipts still gate dispatch.

A satisfied typed prerequisite must have a continuation. If its unblock round
finishes while the parent remains parked, the next proxy pass atomically consumes
that wait and returns the parent to the executable pool, preserving its actual
execution/review requirements and recording the prerequisite receipts. Train
settlement, operator decisions, local/executor waits and unreconciled external
operations keep their own authoritative exits. Unbound executor-coordination
questions also retire when their explicitly addressed task becomes terminal;
this records cancellation, never a fabricated answer or review acceptance.
The same machine-ownership rule covers stalled batches, mismatched merge checks,
missing deployment evidence and no-progress diagnostics. A genuinely unavailable
execution host instead produces a concrete request to start Bridge on a computer,
with named human/Bridge steps—not a request to diagnose the queue.

**Bridge coordinates agents; humans make decisions (BR#6455).** Requests have a
closed `route` in `@bridge/contracts`, shared by the MCP door, hub and human UI:

| Route | Resolution | Human attention |
| --- | --- | --- |
| `{kind:"human_decision"}` | Human chooses; specify the actual missing authority and plain-English context | For Me / Top asks |
| `{kind:"agent_coordination"}` | Named peer, capability or agent pool answers | None |
| `{kind:"executor_coordination",task_id:"BR#6395"}` | Current claim holder of that task answers; addressing follows claim changes | None |
| `{kind:"independent_review",task_id:"BR#6395"}` | Bridge reuses or schedules a review task; no question/options needed | None |

The authoritative question row projects `open → answered | cancelled | expired`.
`answer_ask` records the answer and terminal status in one SQLite write; progress
notes never answer a request, and an ordinary done transition is refused for asks.
Resolved requests cannot be answered again or escalated by a timer. Cancellation
records a reason without fabricating an answer or dispatching answer verbs.
Linked peer coordination retires when its work completes. An accepted direct-main
review records `{kind:"accepted_direct_main",repo,commit,ci_run_url}` in the review
duty's `review_result`; `{kind:"findings",summary}` is explicitly not acceptance.
The acceptance hook and alarm reconciliation close delivered work even when an old
PR stamp remains; only the latest review round after the current submission is replayed.

Write questions in plain English: user-visible outcome first, technical evidence
second. Every option names who acts and the consequence. Questions are stored
whole (up to 240 characters) and rendered whole, including in the detail header.
For Me has no duplicate blanket GO action detached from the actual question.
Legacy exact human targets (`human`, `ray`, `rayh`) adapt to human decisions;
bare agent labels, coordinator tokens and offline stamps never imply human audience.

`ask_agent` writes no side table — the ask **is** a question task: a BR#-numbered
`type: "question"` node, `child_of` the subject task when you pass `artefact_id`. The
subject goes `blocked`, the watchdog pauses for it, and an answer auto-resumes it back to
`in_progress` — exactly once: the ask is the unblock path, so an ask-bound block spawns no separate unblock/sweep duty that could race the answer (the card carries an `awaiting_ask` marker the machine's spawn gate reads; answering clears it). But only onto a **live holder**: the resume checks the holder's real liveness signals (session-alive vouch, last heartbeat, session/owner ping) against the same stale window the watchdog uses, and a dead holder (no live signal, ask older than the window) is released to the pool for fresh dispatch instead (BR#3819) — an ask can never resume work onto a session that already finished. Three fields are the whole contract, enforced server-side (`askCreate` / The fields are the whole contract, enforced server-side (`askCreate` /
`askAnswer` in `packages/worker/src/kb/do.ts`):

- **`question` — the summary.** One answerable sentence ending in `?`, ≤240 chars; it becomes
  the node title. Status reports are rejected at the door — receipts and narrative go in `details`.
- **`details` — the plain-reading brief.** Mandatory on human-directed asks (rejected without
  it): what the subject is, the current state, why it needs a human — every BR#/PR# reference
  glossed in one clause. An ask must be answerable without opening another card.
- **`reason` — the why_escalated.** Mandatory on human-directed asks (rejected without it):
  one sentence on why this is escalated instead of automatic — the gate, credential or
  authority it waits on. ≤1200 chars; renders as the ask's one-line why (never chopped
  mid-clause — the full story stays in `details`).
- **`options` — the decision.** 2–8 one-click answers (rejected with fewer): the recorded
  click is the answer, and it closes the question `done`. When the asker recommends an
  option it is **first** and prefixed `(Recommended)` — the first button is the recommendation.
  The dispatch-verb match (below) reads the option and the answer after stripping that
  recommendation marker (BR#5570), so a `(Recommended) SUPERSEDE — …` option dispatches
  exactly like a verb-first one.

Asks carry ordinary BR# ids, so refs linkify wherever BR# refs render (cards, task detail —
the ref scanner in `packages/ui-kit/src/views/refs.ts`) and resolve via `get_artefact` like
any artefact. `answer_ask` takes the question node's BR# id — there are no separate `ASK-*`
artefact ids. Humans answer in the app: the ask band in Top (web + desktop) renders every
open ask with its options as one-click buttons, every ask-band row (verdict, decision,
node ask) shows its own BR# id as a mono chip next to the rel time — you always know which
ask you are acting on — and each node-ask row ends with a **type your own answer…** row
that opens a text input: the typed text is recorded with the ask exactly like a click
(BR#3912 — an option that promises a rewrite, like "RE-SCOPE — I'll rewrite the card
myself", needs somewhere to write it). Typed answers follow the same dispatch law as
clicks: an answer starting with a RE-SCOPE/KEEP option verb keeps the subject parked,
RELEASE/CANCEL releases it to the pool, SUPERSEDE drops it, anything else resumes it —
the verb is matched after a leading `(Recommended)` marker is stripped (BR#5570), so a
rule-6c recommended option dispatches like a verb-first one and a `(Recommended) KEEP`
click stays a deliberate park instead of silently resuming.
**The ask renders whole, and a click never moves the cards (BR#6390).** Every ask-band row
and For Me card renders the FULL question title (no ellipsis kernel), the full escalation
reason, and the ask's `body_md` as rendered markdown inline in the card itself — the human
gates (copyable merge commands, PR and check links, the why) live in `body_md` and never
hide behind a Details click. A 2-option accept/decline pair (`DONE … / DECLINE …`,
`ACCEPT / DECLINE`, `GO / NO-GO`) renders as two inline buttons — the accept-shaped option
green, the decline-shaped one red (`askOptionVariant`), full labels visible — everywhere
asks render (ask band, For Me, task detail). And answering never re-orders: the clicked
row stays in its EXACT slot, grayed with a spinner while in flight and an ANSWERED gray
after the call settles, until the refreshed board drops it (a sticky `answered`/`dismissed`
set, pruned only once the entry is gone from server state) — the old busy-last
pin-to-bottom sort (`forMeHold`) is gone, so nothing jumps around or snaps back under
your pointer.
`urgency` is an ask vocabulary, not a
sentiment: `"time-sensitive"` renders the urgent NOW chip in the ask band; anything else is
normal — agents can no longer file an "urgent" ask that renders as a quiet one.

**Offline agents are a delivery problem, not a human decision.** After
`ask_escalation_minutes` (default 30, clamped 5–240), unanswered requests to unavailable
bare agent identities return to the agent pool on the same node, with an audited recovery
receipt and original options. Executor-relative requests resolve the current holder at
delivery time. Human authority requests must address `human` from birth and explain the
actual choice Bridge cannot make; they do not expire merely because the human is offline.

**Human comments post from every web surface.** The comment boxes (task detail's
"Comment / steer", the decision popover, discussion replies) all write to the card's
history through the same door agents use — the web plane maps `POST /api/kb/progress` to
the knowledge object's `progress.log` op, so a comment from any surface lands on the card
instead of 404ing — and a failed post shows the server's message, not a bare "comment
failed". The task detail panel loads the card, its history and its related tasks in
parallel: each section renders as its own data arrives, carries its own error + retry, and
the non-essential related list times out to nothing instead of holding the panel hostage. Every section races its own timeout — the card and history get 15s, related enrichment 5s — so a stalled fetch answers with a named error + retry (or an explicit loading spinner) and never leaves the panel a bare shell.

**Claim locally** — next to **Reframe** on every open ask (both surfaces: the ask band
rows in Top and TaskDetail's AskSelfCard), a **Claim locally** button copies a
ready-to-paste takeover prompt for a local interactive agent (e.g. an opencode/claude
session on your machine): the target card (id, title, status, owner, part_of, github ref),
the card body (acceptance/spec) plus the latest progress note, ask context when present
(reason, options), and the full takeover protocol — orient with a unique session, verify
state first-hand (work may be partially done), claim via transition, heartbeat ≤10 min,
shared-checkout discipline (worktree off fresh origin/main, explicit-path staging, never
`git add -A`), commit+sign as detached-cody (canonical invocation inline), finish = PR +
in_review, verify separation, human legs escalate to you. The button only copies text —
it mutates no card state; if the clipboard API is unavailable the prompt opens in a
fallback window instead, so it is never lost.
Question cards instead copy a question-resolution prompt with explicit sender and
recipient, current-state checking and review coordination instructions. They never copy
the implementation claim/worktree/commit/PR protocol; questions are answered, not claimed.

**Interactive claim takeover (BR#6135, amended BR#6436)** — the other half of the
interactive loop, for cards already claimed: when a card's live claim is held by a
dispatched runner session, the owner (a full authenticated agent, or a human via the
web) takes the claim over in ONE atomic write — the
`claim_takeover` MCP tool / REST door, or `transition {to: "in_progress", takeover: true}`.
Status never leaves `in_progress`: no release→pool→re-claim race window, the holder
session flips to the taker (a human taker holds via its `web:<login>` actor — the holder
is never left unnamed), and the owner leg transfers with it (`actingPrincipal ??
attributedAgent ?? actor`, the same law the claim path uses) — which also retires the
BR#3611 gateway self-release admission for the card: the ex-runner can no longer release
what it no longer owns. Authority is server-verified, never declared (BR#2673): the
taker must be owner/web/human-anchored (token label/principal match or the web session
plane) OR hold a full-agent credential (BR#6436: the acting token's LIVE
`auth_tokens.tags` classify it as a full authenticated agent — `gateway` and
`cadence:cron` tokens are infrastructure and never pull rank, untagged agent tokens are
full agents by default; the class is derived from the credential, never declared in a
body). The full-agent anchor is deliberately cross-owner: an authenticated agent may
pull rank over a dispatched runner claim it does not own (Ray ruling 2026-11-05,
superseding the owner-only portion of BR#6159). The affordance targets runner-held
claims — a taker with authority takes any
non-duty, unheld card, whatever session holds it (peer-interactive claims included;
BR#6159 divergence 3). Refusals are never
breaches (BR#3430): every rejection carries its `[rule: takeover-*]` tag inside the
300-char audit slice and folds — authority/target/stand-down → `claim_race`, a
typed-wait hold → `release_held`, a verify/unblock duty card → `gate:separation`
(separation of duties is not transferable). Watchdog-safe by construction: a holder
parked on a bound ask (the interactive-pause law, BR#6068) is not stall-released, and
its card refuses takeover while the ask owns the exit. The op is idempotent (re-running
reports "already" without rewriting the stamp), clears the churn attempt counter and any
subprocess/grace stamps, stamps `meta.taken_over {from_session, to_session, by, at,
reason}` plus a "claim taken over" version row — and the ex-holder's next state change
is gate-refused with the STAND DOWN order (checkpoint `last_will` via `log_progress`,
then end your run; your registered worktree and WIP survive): the one-executor law (5d)
enforced at the gate. The web renders a **Take over claim** button on dispatch-held
cards in TaskDetail.

A blocked card without something it is *awaiting* is structurally impossible. `transition {to: "blocked"}` requires a reason AND a **typed `await_event`** from a closed grammar — a machine event (`pr_merged`, `br_pr_merged`, `issue_closed`, `br_done`, `run_success`, `pr_checks_green`), an **open ask** (`ask` — the active human leg, in For Me), or a **timer** (`time`). Verdict-duty tasks (`role:review` / `role:unblock`) are refused at this door entirely — they can never park: their silence is declared with `log_progress` grace, and "cannot proceed" is itself the verdict (BR#4392). Free text (`unblock_condition`) is optional human-friendly annotation, derived from the structure when absent; text that parses cleanly to one atom is auto-typed at write time — and that includes the ask/time legs (BR#4062): the machine-proxy prose convention (`Machine proxy (typed await_event ask ask_id=BR#N): …`, `(typed await_event time until_ts=<epoch ms>)` — ISO timestamps normalize to epoch ms) parses to the same typed event the `await_event` param carries, and the gate's rejection names the param when nothing parses. Conjunction conditions parse whole (BR#3986): every `BR#N done` / `PR #N merged` / `GH#N closed` on a line yields its atom, and the proxy watch flips only when **every** atom evaluates TRUE — never on the first alone. Two park shapes are refused loud at the door: text that parses to **multiple atoms** (a park awaits one typed leg — name it in `await_event` and carry the rest as prose; multi-atom text never self-migrates, breach class `gate:multi-atom-condition`), and a **self-referential await** — a card naming its own done (`br_done`/`br_pr_merged` on itself) can never fire while blocked, the BR#136 deadlock (breach class `gate:self-referential-await`). The hub's proxy watch re-checks machine events every 15 min and spawns the unblock duty on the flip; an answered ask auto-resumes its subject (live holders only — a dead holder is released to the pool for fresh dispatch, BR#3819); an elapsed timer fires the duty — prose-derived ask/time parks self-migrate to the typed event and evaluate first-class like any typed park. Legacy prose-only cards run the **disposition ladder** (`decideProseDisposition`, BR#4416 — the machine resolves what it can prove from the card's own state, and a human is asked only for genuine ambiguity, never one ask per card): a park whose machine state already holds the exit proof (a provenance/train-ledger merge row, an answered bound ask, a terminal root blocker) **auto-flips per its own promise** — no ask exists (the BR#4170 class: a PR sat MERGED while a human was asked to re-scope); a park with a recoverable typed leg (meta PRs, train stamps, an open bound ask, an open root blocker) is **re-typed in place** and re-enters the normal typed path; a park with no machine leg at all is **released to todo** for re-scope (the BR#3578 no-leg law — the churn guard's park is not a human decision), except runner/human-owned or human-qualified cards, where supersede-vs-continue is genuinely yours: those collect into **ONE class ask per day** with each card's facts and consequence-naming options. Every sweep pass emits `prose_blocked_count` (visible in `/stats` and the `prose_sweep` audit line); after the BR#4248 generator-kill has merged and deployed, a nonzero count is an incident — ONE deduped alarm at the sink naming the cards and the writer that minted them, never per-card asks. **Answering the class ask actions every card it names**: RELEASE/CANCEL → released to the pool, SUPERSEDE → dropped, RE-SCOPE → each card re-blocks with a typed await (the answered ask is the record). The SUPERSEDE drop is the one `blocked → superseded` edge (BR#3913): it exists exactly for the answered ask — the answer is the authorisation — and for the web; a bare agent session cannot take it (`transition {to: "superseded"}` from a session is refused by the `supersede-authority` law row), and a drop closes the card's open unblock/verify rounds. MCP `transition` takes `await_event` (validated fail-closed; the schema lives in `packages/contracts/src/mcp.ts`, the grammar in `packages/worker/src/kb/closure.ts`). Two park shapes are refused loud at the door: text that parses to **multiple atoms** (a park awaits one typed leg — name it in `await_event` and carry the rest as prose; multi-atom text never self-migrates, breach class `gate:multi-atom-condition`; the refusal names every atom in short form so the full list survives the audit trail's 300-char reason slice, BR#4303), and a **self-referential await** — a card naming its own done (`br_done`/`br_pr_merged` on itself) can never fire while blocked, the BR#136 deadlock (breach class `gate:self-referential-await`). Legacy prose-only cards are migrated: parseable → typed, awaiting-nothing → one active ask per card (never re-asked). **Answering a migration ask actions the card**: RELEASE/CANCEL → released to the pool, SUPERSEDE → dropped, RE-SCOPE/KEEP → a deliberate human-owned park (the answered ask is the record). Two park shapes are refused loud at the door: text that parses to **multiple atoms** (a park awaits one typed leg — name it in `await_event` and carry the rest as prose; multi-atom text never self-migrates, breach class `gate:multi-atom-condition`; the verify duty's ACCEPT step names the train park's typed leg explicitly (`await_event {event:"pr_merged", repo, n}` rides the `merge-train: queued` transition, BR#4425), so the standard queue path never trips the door), and a **self-referential await** — a card naming its own done (`br_done`/`br_pr_merged` on itself) can never fire while blocked, the BR#136 deadlock (breach class `gate:self-referential-await`). Free text (`unblock_condition`) is optional human-friendly annotation, derived from the structure when absent; text that parses cleanly to one atom is auto-typed at write time. The hub's proxy watch re-checks machine events every 15 min and spawns the unblock duty on the flip; an answered ask auto-resumes its subject; an elapsed timer fires the duty — except on a do-not-claim anchor (the alarm sink, or any card flagged `infra_anchor`): an expired cooldown there re-arms the park itself on a fresh typed 24h wait, no flip and no spawned duty, so the anchor can never zombie-park past its cooldown with the spawner cap having burned every machine leg (BR#5916). The server holds itself to the same law: the churn-guard redirect (a card released to the pool 5 times, or 5 silent watchdog cycles) parks `blocked` stamped with a typed 24h `time` cooldown — the timer is the machine exit (on fire the unblock duty re-checks first-hand; a proven release resets the attempt counter), and the read-the-history text stays as annotation only. A post-condition invariant (`blocked-await-invariant`) refuses ANY internal `blocked` landing without a grammar-valid await, so the server can never mint the prose-only "awaits nothing" parks that force per-card human escalation asks (BR#4248). **Supersede** — next to **Claim locally** in the ask action row, and beside **Unblock now** on every blocked card (and on unclaimed todo cards): a **Supersede…** button retires a dead card in one click (BR#3910). The dialog shows the card's current status and takes an optional replacement task id (`BR#<n>`, `#<n>` or a bare number, validated before submit). The server composes the documented two-step itself — blocked → release → todo → superseded (the BR#1852/BR#1935 precedent) — so the raw intermediate states never surface; the card lands `superseded` with `superseded_by` plus a clickable replacement link, and the `supersedes` relation records the lineage machine-readably. Supersede is **web/human-only (BR#2480)**: the route refuses gateway bearers with 403 and the agent-facing transition gate still has no `→superseded` edge, so no session can execute it. Every refusal surfaces the server's message inline and in the banner with the card left unchanged — a silent no-op is the defect class this button exists to kill (BR#3649's answer-before-click misfire, BR#3905's timer-spin churn on dead-premise blocked cards). Dead-premise cards whose premise can no longer hold are closed for good by the human-only **Supersede** button instead of looping through re-check duties (BR#3910). **Batch authorizations apply without re-asking** (BR#6432): when a human has ANSWERED a batch-authorization ask ("SUPERSEDE all 29 — …", the receipt census in the ask body — the BR#6387 class), a session may apply it per target with `transition {id, to: "superseded", batch_auth: {ask: "BR#N"}}` — the hub verifies the human answer server-side (the ask's own `answered_by` must be a `web:`/`human:` principal), checks the target is NAMED in the ask's census and is still an open park (`blocked`, never a lane/infrastructure card), and executes the drop exactly like the per-card answer dispatch — as `system:question(<answered_by>)` with `human_verdict` — stamping `meta.batch_auth` provenance. The session never writes the drop itself, "only"-scoped answers resolve to exactly the card ids the answer text names (a partial authorization the hub cannot resolve applies to nothing), and every refusal is a typed `gate_rejected` naming its `batch-auth-*` rule — the executor's own duty stays the state recheck: an old ruling applies only while its predicate still holds (a park rebound to a different PR, claimed, or already terminal is skipped and reported, never dropped on stale receipts).

## Destination-green: the stop-the-line gate

Merges must not land while the destination branch is red — accepted decision BR#3009 makes
that law, and BR#3008 makes it mechanical instead of discipline. Three halves, same rule:

- **The block**: every PR runs the required `main-green gate` check
  (`.github/workflows/main-green-gate.yml` + `scripts/main-green-gate.sh`). It reads the
  check runs on main's HEAD (`gh api repos/<repo>/commits/<sha>/check-runs`): any failure
  (or a check still running, or no check runs at all) fails the gate and GitHub refuses
  the merge via the `main: main-green gate + substance checks required` ruleset. The
  newest run per check judges; a cancelled run says nothing. The one exception is written
  into the gate: a PR green on the *exact* checks main fails passes with a printed
  **REMEDIATION CARVE-OUT** receipt — BR#3009's remediation-merge path, expressible and
  receipted, not a loophole.
  Manual gate drills honour the same rule: a `workflow_dispatch` run MUST pass an
  explicit `main_sha` (BR#5487) — a sha-less dispatch with `--ref main` attaches the
  drill's own `main-green gate` check-run to main's HEAD, so the script finds itself
  in flight on the sha it judges and fails UNSETTLED, reding a green main. Judge a
  historic sha instead: the check-run still lands on HEAD, but the judged commit is
  settled and independent.
- **The substance**: the block judges main's HEAD; it never judged the PR's own head — the
  hole #174 sailed through (merged with `Test` + `CLI build (packages/cli)` FAILURE on its
  head while main was green; main went red and the #211 hotfix followed). The same ruleset
  now also requires `Test` and `CLI build (packages/cli)` green on the PR's own head, with
  `strict_required_status_checks_policy` on: the checks must come from the latest head, so
  a stale green never counts. A red-head PR cannot merge even while main is green — the
  train's gate (`decideTrainGate`, composing the standing `decideMergeAction` in
  `packages/worker/src/kb/core.ts`) enforces the same law: two reds never merge.
  Deliberately NOT required: the `Superpositional` review — BR#6001 implements BR#3177:
  a failing review is a quality issue and merge-allowed, and that includes a review
  *process* failure (the posted check run itself errors — a Superpositional
  infrastructure problem, never a reason to stop the bridge's merges; the head gate
  routes it into the exempt `external` bucket like every other external) — a required
  check would deadlock against it — and the BR#2267 externals (Workers builds / deploy
  previews never gate). BR#6568 extends the SAME exemption to the typed
  `pr_checks_green` probe (the executor's first-hand `statusCheckRollup` observation
  behind the await, `classify_rollup` in train.rs): exempt-external failures no longer
  stamp the probe conclusively negative — the probe SATISFIES with the exempt external
  named in the verdict — so a degraded SP flow runner cannot park a typed await
  indefinitely (the BR#4694 canary / PR bridge#323 class), while a REQUIRED check
  failing still stamps negative and anything pending stays transient (fail-closed).
  The
  bypass actor is unchanged — rayh alone keeps `bypass_mode=always`: the human retains the
  loud escape hatch; machines do not. Proven end-to-end by probe PRs #216 and #217.
- **The stop (executor-fed, BR#3516)**: the hub holds no VCS credentials and no longer
  reads GitHub — red detection is fed in by the merge-train executor: its awaiting-CI
  poll posts the merge commit's check runs (`train.ci`), the hub classifies them
  (`classifyRequiredRuns` — red, or unknown past 3× the lane's typical CI time,
  fail-closed), and any non-green verdict **stops the line**: the lane card reads
  `merge-train: STOPPED — … (resume when the line is green)`, the just-merged **culprit
  card is bounced** to `in_progress` with the failing runs appended (red after merge),
  and the root-fix card auto-spawns at absolute p0 (BR#5190). Green again → the
  executor's next CI poll feeds a green classification (`train:landed`) and the hub
  releases the stop automatically. The clear is loud too (BR#4692): releasing the stop
  on a green line writes a `train:stop_cleared` row to the lane history and a note to
  the alarm sink, each naming the red window (stop set → stop cleared, who/when
  auditable). There is no separately "held" stop: every stop auto-clears within one
  executor tick of green — a human halts the line again by stopping it, not by holding
  it. v1 stops the line; there is no auto-revert — fix
  forward or revert is the culprit card's job. Work on branches (worktrees) continues —
  only the line stops. **No stop-time human ask** (BR#5631, Ray ruling 2026-11-03 from
  the BR#5626 escalation: "you should only be giving me the solution if it needs me —
  bypass merge, manual steps"): the stop is machine state, not a human decision; the
  old `Ack — on it` / `Revert the culprit` / `Waive — resume the lane` ask had no
  dispatch side and demanded a pointless click. The human-actionable decisions surface
  LATER, warranted, through the base-red ask (below) once a cure PR binds, and the
  root-fix fast lane (BR#5189 §5). Two BR#5061 refinements keep the stop honest
  instead of stormy:
  **one ledger episode per stop** (the same sha + reason re-reported by a tick loop —
  the stop arm clearing on green main while the awaiting-CI arm re-fires it — is a
  `train:stopped_deduped` no-op, never a new ledger row every 20 seconds), and the
  **phantom-required carve-out** (Ray ruling 2026-10-30: "if it can't merge, bounce it
  and move onto the next one — the train goes regardless"): once every unsettled
  required workflow is MISSING (no check run ever existed for it on the merge commit —
  e.g. a PR-context-only gate that only runs on `pull_request`) while at least one
  required workflow proved green on that very commit, waiting cannot change the
  verdict — the merge LANDS judged on the workflows that exist, the never-run names
  are dropped with a loud audit, and ONE config-defect ask per episode goes to the
  alarm sink (fix `required_workflows`); a genuinely stuck OBSERVED run (or an empty,
  zero-evidence poll) keeps the fail-closed stop — the carve-out never fires on no
  evidence. The carve-out fires at the **settle dwell** (BR#5829), not at the
  fail-closed bound: a workflow that has not even registered a check run on the merge
  commit by the 2-minute dwell (the registration window the BR#4804 dwell already
  defines) never will — the old bound-gated timing held an already-green base for the
  whole ~3×-typical bound on every merge (state-vector/bridge PR #371: all 8 tip
  checks green at 08:06:48Z, `train:landed` only at 08:36:34Z — 30 min of pure lag,
  the largest single component of the BR#5822 starvation). The dropped names are also
  **stamped** into the lane config (`meta.lane.phantom_required`, served on
  `train.status`): the next settle classifies green outright in 1–2 ticks instead of
  re-discovering the phantom each merge, and the stamp self-heals — if the name ever
  produces a check run on a merge commit again, it is judged normally (red still
  stops the line).

### The stop names the guilty card — and dings its sessions (BR#5517)

A stop-the-line episode carries blame end to end. The auto-spawned root-fix card
(BR#5190) links to the culprit card with a typed `derived_from` edge — the card's
relations show who it answers to, and the culprit's own bounce brief names the merge
sha and failing runs on plain reading (the stop-time alarm ask that used to carry the
`Guilty:` line is gone per BR#5631 — the card is the blame surface). Blame also
sticks to the people: the hub stamps a durable `train_red_ding` on the culprit
card naming the agent labels on its version receipts (the impl and verify
sessions that executed it, within the 7-day scoring window), and every one of
those sessions eats a capped behaviour-score penalty — −5 per episode, at most
−15 (`train_red` on the board's agent rows, with a hint naming the episode).
Clearing the red does NOT refund the ding (a broken main already cost the fleet);
only a bisect exoneration removes it — when the BR#4934 red-settle walk names a
DIFFERENT true culprit, the wrongly stop-named card's episode is pardoned
(`train_red_pardon`, the penalty leaves) and the true culprit is dinged in its
place. The stamps are best-effort by construction: a blame failure never eats
the stop event itself.

### Base-red is loud and scoped (BR#5265)

The stop above guards the line AFTER a merge. The admission gate guards it BEFORE —
and its base-green leg was the 2026-10-31 outage: three non-required nightly reds
(`Quality Replay`, `Meta-review nightly`, `Republish gate`) on main's tip parked a
10-car queue ~30h while every deploy-required workflow sat green on that same tip,
and the skip was SILENT — no ledger event, no bounce, no ask, the lane reading a
fake-busy `working on <head> — checking review, signatures and CI before merging`
every tick. Two laws now hold:

- **Scoped base classification + empty-is-loud (the gate, BR#5265 + BR#5674 P1)**: the base verdict classifies ONLY the
  lane's `required_workflows` when the lane configures them (`classifyBaseCheckRuns`,
  `train_gate.rs` — newest non-cancelled run per name, red beats unsettled beats
  green; an un-configured lane keeps the legacy whole-tip read). A nightly, battery
  or canary red stops its own pipeline and its own cards — never the train. When
  `required_workflows` are configured and the scoped filter yields zero matches on a
  tip that HAS runs, `base_state` carries `alarm: "<N> runs read, none matched required set — check names/pagination"`;
  a tip with zero total runs carries the sibling `alarm: "tip carries no check runs at all"`,
  and the hub's `empty` blocked reason renders the alarm verbatim instead of a silent `config?`.
- **Loud BLOCKED (the lane)**: every walk stamps its base verdict into the lane
  (`train.queue_facts` carries `base_state: {verdict, scoped_to_required, red[],
  unsettled[]}`, served whole by `train.status`), and a non-green base holding
  queued cars renders the lane `merge-train: BLOCKED — base main RED: <names> — N
  car(s) held; clearing the red (fix forward / re-run / bypass-merge a cure) unblocks
  the whole queue` (lane card reason + trains panel status pill, red) — never a
  fake-busy checking line. The human alarm ask is **warrant-gated** (BR#5631, Ray
  ruling 2026-11-03 from the BR#5626 escalation: "you should only be giving me the
  solution if it needs me — bypass merge, manual steps"): it files ONLY when the
  episode has a human-actionable act on the table — a cure PR bound to the fix work
  (the out-of-turn bypass merge is human authority, BR#4122) or the fix path
  exhausted (`trainBaseRedAskWarranted` — the root-fix card churned out of attempts
  or escalated, so manual steps are the only lever left). While the red is
  agent-workable there is NO ask at all: the root-fix card (BR#5190) carries the
  work, the banner carries the information, the queue self-drains the moment main
  is green — an ask there would only demand a pointless "keep going" click, and
  noise trains the human to ignore the band where real bypass/manual decisions
  land. A lapsed warrant (the cure PR closed unmerged, nothing re-bound) closes
  the open ask on the next red tick; the ask re-files automatically if a bypass
  decision re-arises. When warranted, the ask is a LIVE TRIAGE VIEW (2026-11-02,
  Ray directive), not a one-shot alarm: its
  brief/options render from the LIVE episode state — the root-fix card (BR#5190)
  and its cure PR — and the executor refreshes the OPEN ask in place every red tick,
  so the bypass option CARRIES the cure PR's number the moment one binds (never
  again the old `Bypass-merge a cure PR (I'll reply with the number)` shape that
  demanded a number a one-shot ask could never learn).   The cure join (`trainOpenRootFix` + `classifyBaseRedEpisodeState`, BR#5516 /
  BR#6012) is a closed state machine (`diagnosing` → `fix_in_progress` →
  `cure_pr_conflicting` → `cure_pr_awaiting_force_merge` / `fix_exhausted`): it
  prefers the root-fix card's own unlanded PR legs (accepting both `root_blocker`
  and `root-blocker` tags + `main_tip`/`red_since` bindings) and falls back to a
  queued entry ONLY when no root-fix card exists yet and the queued card's title
  explicitly names a base/CI/deploy/gate cure (`isBaseCureCardTitle` — never
  generic product `fix(<scope>):` PRs, and never grafting a queued card's PR onto
  a different root-fix card). A conflicting PR (`cls: "conflict"`) transitions to
  `cure_pr_conflicting` (`warrantAsk: false` — conflicts are self-healed by
  bouncing to an agent to rebase, never a human bypass ask); while stopped, the
  executor refreshes `base_state` via `train_queue_facts` and runs
  `settle_window_rebase` so conflicting queued PRs bounce immediately. When
  `cure_pr_awaiting_force_merge` holds, the brief includes the exact copy-paste
  force-merge command (`gh pr merge <N> --repo <repo> --admin --squash`) and the
  circular-gate explanation. The brief opens with a
  **Read of the red (triage before you answer)** block that classifies each red
  check by name shape: a gate/main-green check says IN PLAIN TEXT that a re-run
  fails IDENTICALLY — fix forward or bypass-merge the cure, never answer RETRY
  blind; a deploy/smoke/health check says the deployed state is failing, not the
  merge diff — check the deploy logs first; anything else is diagnosis pending
  until a session reads the failing job log (re-running a structural failure burns
  a cycle and re-arms the ask). Options mirror the triage
  outcomes — and when a cure PR is bound, the ask is a HUMAN GATE, not a menu
  (BR#6390, Ray 2026-11-05: "do this thing and click DONE when done to unblock"): the
  brief carries a `# HUMAN GATE — your one action` block with the copy-paste `--admin`
  merge command plus the PR and check links, and the options are exactly the
  accept/decline pair `DONE — PR #N merged` / `DECLINE — hold the line` (the Rust
  executor's root-fix fast-lane ask files the same pair, title byte-identical in both
  implementations so the identical-open-ask dedupe still matches whichever side fires
  first). DONE stamps `lane.bypass_merge` — the executor then lands the cure or, if the
  human merged it themselves, observes `MERGED` and stamps the `merged` train_event so
  the episode settles on `cure_pr_merged_awaiting_ci` (a 10-minute DONE grace watches
  for exactly that before any machine merge attempt is tried). DECLINE stamps
  `base_red_ask_declined` — the line holds, the same episode + cure PR does not re-ask
  for 24h, a different cure PR re-arms the gate, and a later DONE supersedes the
  decline. While a bypass authorization is already pending for the bound PR (or the
  cure has merged), the gate files nothing — an answered gate is never re-minted
  before the executor acts on it. The episode join also recognizes the field-minted
  BASE-FIX / stop-the-line card shape (BR#6378: no root-side tag, `tip_sha` +
  `root_blocker_for_lane "<repo>@<base>"` in meta — tags `main-red` +
  `stop-the-line`/`base-fix`/`p0`): `isRootFixCard` / `mainRedBinding` accept the
  broadened vocabulary (base-fix/root-fix tags + stop-the-line main-red spelling;
  sha sources `main_tip`/`tip_sha`/`red_since`; a meta marker counts as the root-side
  half — the failing-run binding stays mandatory, tags alone never qualify), and
  `isLaneBaseFixCard` heads the episode with that card through
  `cure_pr_merged_awaiting_ci` — a human-merged cure resolves the episode with ITS
  card, never a stale fix_card, and the gate never re-files over a merged cure. The
  Rust mirror (`train_gate.rs is_root_fix_card`) stays behaviour-identical. Without a
  bound cure the triage menu stands: hold-the-line ·
  transient retry · manual/other · no-resolution-yet keep digging. The stamp is
  freshness-guarded (<15m, executor refreshes every tick) so a dead daemon's stale
  stamp can never pin a false BLOCKED; a stale or green stamp falls back to the
  normal lane vocabulary.
- **The resolution rides the lane, not the weeds (BR#5349 + BR#5679, Ray directive 2026-11-01
  ~07:55Z — "THIS IS WHAT FIXES IT, HERE IS WHAT WE NEED TO DO — loud and clear and
  direct with no jargon")**: while a non-green base holds cars or `meta.stop` is active, `train.status` serves
  a `base_red_resolution` block per lane — `whats_broken` (the red checks + run URLs,
  from the walk's `base_state` or `stop.failing`), `held` (queue depth), `ask` (the episode's OPEN alarm
  ask verbatim: id, canonical url, question, options) and `fix_card` (the episode's root-fix card, OPEN task
  tagged hotfix+main-red in the lane card's project, or the stop's culprit card — the active fix-forward card).
  Every executor lane arm (stop-recovery, rerun, mid-drain tip check, and bisect) classifies base/tip check runs
  scoped to `lane.required_workflows` (`classify_base_check_runs`), and feeding green required-workflow check runs
  to `train.ci` on a stopped lane clears `meta.stop` (`decided: "line_green"`) even when non-required nightly checks fail.
  The trains panel renders it as a red banner PINNED to the very top of the panel,
  above the lane table, in plain words only — `⛔ Merge train STOPPED — main's checks
  are failing on <repo> · N PRs held`, `BROKEN: <checks with run links>`,
  `WHAT FIXES IT: <fix card, plain status> · or re-run a flaky check · or you
  bypass-merge a fix PR`, `WHAT WE NEED FROM YOU: answer the ask (→ BR#…) — one
  click` — no "gate", no "verdict", no admission-class vocabulary, and it disappears
  by itself the moment base_state goes green. And the base-red bounce/park brief
  speaks the same plain language: a gate bounce whose red is MAIN's own (the circular
  deploy-health class, or a defect naming main red) tells impl `your PR is fine —
  MAIN is red (<names>); held until it clears; fix lives on <fix card>; nothing to do
  on this PR` (`trainBaseRedDefect` + the base-red branch of `trainBounceBrief`) —
  never the mechanical rebase/re-sign/re-approve loop that made verify sessions
  re-prove clean PRs while main stayed red (the BR#5193 circular-park class).

### Scoped green never certifies an unfit tip — the gate-block qualifier (BR#5883)

Scoped classification fixed the nightly-red park — and opened a new silence: the lane's
base verdict reads ONLY the required set, so a scoped Green can coexist with the repo's
own destination gate — `main-green gate`, which judges main's WHOLE tip, no exemptions,
unsettled fails — red on that same tip. The lane then looks idle-green while every queued
car's own gate run fails, and a car whose head red is entirely gate-class stands convicted
forever because nothing ever re-runs the stale gate red on it. The 2026-11-03 receipt
(BR#5822/BR#5861 diagnosis): the lane starved 3.5h+ with cars held while a `Deploy drift
alarm` red — correctly outside the scoped set — kept the repo's gate red, the lane reading
green the whole time; the sibling settle exit had already been fixed (BR#5829), and
BR#5847 established the gate itself is vacuous on merge commits, so the qualifier below is
COMPUTED from the tip's runs, never read from the required set. Two laws close the class:

- **The qualifier rides the verdict — computed, never read**: when the scoped base verdict
  is Green but the gate predicate — `classify_main_check_runs`, byte-equivalent to
  `scripts/main-green-gate.sh` (newest non-cancelled run per name, no exemptions,
  unsettled fails) — judges the tip non-green, `classify_base_check_runs` attaches a
  `GateBlock` qualifier. The verdict itself STAYS Green (BR#5265 law intact: non-required
  reds never park the train). The walk's `base_state` stamps `gate_blocked: true` with
  `gate_verdict` / `gate_red[]` / `gate_unsettled[]` (omitted while clean or mid-burst),
  the lane vocabulary goes loud — `merge-train: GATE-BLOCKED — base main passes the
  required workflows but the repo merge gate judges it red/unsettled — N car(s) held
  (every car's main-green gate run fails on these); fix or re-run the named checks to
  unblock` — and the trains panel renders the red `⛔ gate-blocked` pill
  (freshness-guarded <15m like base-red). The hub escalates a fresh gate-blocked stamp at
  P1: ONE diagnostic duty (child of the lane card) and ONE deduped human ask per episode,
  stamped `meta.lane.gate_blocked = {since, ask_id, duty_id}`; the episode auto-clears and
  the ask auto-closes the moment a fresh stamp drops the qualifier or the verdict goes
  non-green (the ordinary base-red path takes over with its warrant-gated escalation).
- **A stale gate conviction self-heals**: the merge gate's rerun ladder gains a
  `RerunGate` row — a car whose head red is ENTIRELY `main-green gate`-class reruns
  instead of standing convicted when the fresh tip evidence says the gate would now pass
  (`base_gate_green` — the tip fully green under the gate's own predicate); any honest
  conviction (a non-gate red on the head, or a tip still non-green) stands untouched, so
  the row can never spring a genuinely red PR. The action reason names the class on plain
  reading ("head red is entirely the main-green gate class … a stale conviction …
  (BR#5883)"), mirrored byte-parallel in the TS classifier (`core.ts`) per the
  dual-implementation disclosure law.

### Stalled is loud + the merge-method fallback (BR#5376)

The base-red gate above guards the base. BR#5376 closes the OTHER silent-failure
class — the executor itself breaking while the lane pretends to work. The 2026-10-30
receipt: `state-vector/superpositional@main` selected batches every tick, attempted
`gh pr merge --merge` every tick, and GitHub refused EVERY attempt
(`GraphQL: Merge commits are not allowed on this repository. (mergePullRequest)`)
from 11:30:23Z onward — 945+ consecutive attempts, logged to the executor's LOCAL log
only, ZERO hub events, no ledger row, no ask — while the lane read the fake-busy
`working on <head> — checking review, signatures and CI before merging` for days and
main landed nothing. Two laws close the class:

- **Loud stall**: a batch that selects members and ATTEMPTS merges but lands NOTHING
  for `MERGE_TRAIN_STALL_TICKS` consecutive ticks (default 3, env-clamped to ≥2 so a
  single transient gh blip never pages a human) is a STALL EPISODE: the walk's
  `queue_facts` stamp carries `stalled: {batch, ticks, since, for_ms, last_error}`
  (freshness-guarded <15m and omitted the moment anything lands — the state clears
  by itself), the executor fires ONE `train.event kind:"stalled"` per episode under
  the lane lease (a ledger row, deduped by the episode's `since`), and the hub files
  the ONE-per-episode time-sensitive alarm ask `MERGE TRAIN STALLED: <repo>@<base> —
  PRs selected to merge are not landing. Restart the executor?` to the alarm sink —
  the title carries NO changing numbers (no tick counts, no ages) so the
  identical-open-ask guard dedupes the per-tick repeats. The lane card reads
  `merge-train: STALLED — #N, #M selected to merge, 0 landed in Xm (K tick(s)) —
  last error: <the executor's raw gh refusal> — likely executor breakage; restart
  the gateway onto the current build` (lane reason + panel status pill, amber) —
  never the fake-busy checking vocabulary — and `train.status` serves a
  `stalled_resolution` block (batch / ticks / for_ms / last_error / the episode's
  OPEN alarm ask verbatim / the unblock) that the trains panel renders as an AMBER
  banner pinned directly below the red blocked banner, suppressed while base-red
  owns the lane, and gone the moment anything lands. A tick that never attempts
  (empty batch, no merge leg) is idle, not stalled; any landing resets the episode.
- **Merge-method fallback**: a merge-method refusal (`…not allowed on this
  repository` — or the ruleset-era answer `the base branch policy prohibits the
  merge`, BR#6673: a branch ruleset pinning `allowed_merge_methods` to
  squash+rebase refuses every `gh pr merge --merge` attempt with that text) is a
  REPO POLICY mismatch, never a PR defect — the executor retries
  the refused member with an allowed method, SQUASH first (the standing
  superpositional landing shape — sp main's history is all squash), then rebase,
  then merge, and remembers the working method per repo for the process lifetime
  so a policy mismatch lands the member instead of looping 945 times. A fallback
  success still rides the full merged-event path (provenance stamp, awaiting-CI
  settle) — nothing is waved through.

### The root-fix fast lane (BR#5190, steering BR#5189)

A stop-the-line episode now spawns its own cure, and the cure jumps every queue.
When the stop fires, the hub ensures ONE root-fix card for the red — tagged
`root_blocker` + `main-red` + `p0`, role impl, a child of the lane relation —
binding the culprit facts (`repo`, culprit `head_sha`, `base`, `why`, the
`failing` checks, `bound_at`), with repair legs riding it as they open (`pr`
stamped on the binding). Three paths, never a duplicate: the culprit card is
still open and qualified → it is re-bound in place; another open card in the
same repo qualifies → the binding moves to it; nothing qualifies → a fresh card
spawns. The red and the repair share one identity: the card the train was
stopped for IS the ticket that fixes it.

The queue sorts in four absolute tiers — `root_fix` > `boosted` > `critical` >
`normal` — root-fix beats even a human ▲ boost (the old `boosted` meta label
`critical` is renamed accordingly), and a red base halves the walk further:
when the lane's base is red the queue offers ONLY tier 0 — every other head
parks until main greens again (two reds never merge, and queuing green heads
behind a red base just rehearses the block). While the line is stopped, the
executor's stop arm falls through to the drain walk ONLY when the queue head IS
the cure — the bisect stays parked while the fix is in flight — and the
post-stop residue arm keeps its stop-null guard, so a cleared stop can never
re-arm from residue.

At the gate the cure fast-tracks: a queue head that is a root-fix card, with the
base red and its own head green, is not `blocked` by the base — the gate merges
it and stamps the receipt `ROOT-FIX FAST-TRACK (BR#5189)` (the merged train
event carries `root_fix: true` and a note suffix, so provenance shows the lane
was cured, not blocked). One circular case cannot self-serve: when the base's
red is the deploy-health alarm itself — the gate is judging the check that
reports drift while the drift is the breakage — the gate files ONE human ask,
"Merge the cure now" / "Not yet — hold the line", with a title byte-identical in
the Rust executor and the TypeScript hub (one implementation shared as fixture
tables, `decideTrainGate`) so the identical-open-ask dedupe matches whichever
side fires first; every other red-head fall-through stays under standing law.
Verify duty on a qualified root-fix card (tag + a stamped PR) names the fast
lane in its body, so the reviewer knows the merge path is pre-cleared before
they accept.

### Structural check and recovery admission (BR#6776)

Checks retain their GitHub source identity: check-run app/suite, or workflow
run/attempt. Two workflows publishing the same check name are independent
obligations; one publisher's green cannot erase the other's failure. A rerun
supersedes earlier attempts only within its own obligation.

Stale-gate recovery resolves the actual Actions job URL or workflow-run identity
before dispatch. Check-run, job, and workflow-run IDs are never interchangeable.
The hub durably reserves one retry per candidate head and obligation **before**
the external call. A lost response or executor restart retains that reservation;
an uncertain effect is not repeated. Exhausted retries and substantive candidate
failures produce a concrete, deduplicated repair duty instead of assuming that
an ownerless queued card has an active executor.

Every merge candidate must include the current base in its tested head. A clean
worker-authored branch is updated mechanically; its substance verdict carries,
but CI does not. The train waits for fresh integrated-head checks. Conflicting
or non-worker-authored branches receive an agent-owned repair. This check runs
again between batch members: disjoint files alone do not prove semantic
compatibility. This replaces the older conflict-only proactive-update policy.

A scheduler reservation authorizes initial `begin` through its exact gateway
token and session, without requiring a caller-supplied agent label. Existing
readiness, model, session and writer fences still apply. Recovery banners expose
startup, capability, local-handoff and other execution blockers explicitly;
`todo` alone never means that recovery can launch.

### Stale deploy-health reds self-heal (2026-11-02)

The `Deploy health (merge gate)` check on a PR judges MAIN's deploy state, not
the PR's own code — so its verdict can go stale exactly when main recovers
under it (observed 2026-11-02: the gate stamped red at 07:49 while the
recovery deploy was still in flight; main settled green at 07:52 and the red
sat in the queue with nothing to re-open it). The train now detects this
itself, in the same gate that already runs every tick: a head red that is
ENTIRELY the base-health class (`Deploy health (merge gate)` or `main-green
gate` — `is_base_health_gate_name` / `DEPLOY_HEALTH_PATTERN` +
`MAIN_GREEN_GATE_PATTERN`, TS + Rust mirrors) on a
GREEN base is a stale verdict by construction — the gate returns
`rerun_gate`, the executor re-runs the failed gate jobs
(`gh api check-runs/<id>/rerequest`, worker-class identity-gated per BR#3181,
falling back to `gh api actions/jobs/<id>/rerun` with the same id when GitHub
refuses the check-run write for an Actions-created check run, BR#5897)
and treats the entry as a clock (queue class `waiting`). The next tick reads
the fresh run: green merges, honestly red falls to the standing law. Never a
bounce (the PR carries no defect), never a human leg (main is green — no
decision exists). A REAL red beside the gate red is not healed, and a red
base keeps the circular BR#5189 law untouched.

### Level-based deploy reconciliation & dark-tip self-heal (BR#6179)

Edge-triggered deploys (`on: push`) can be silently suppressed when a PR is
merged with a `GITHUB_TOKEN`/app-class token or when a deploy run is cancelled
or deleted — leaving `main`'s tip commit **dark** (zero required check-runs on
the tip, verdict `empty`, holding the queue forever). The executor and hub now
reconcile deploy coverage as a closed 6-state machine (`DeployCoverageState`:
`covered` | `settling` | `uncovered_grace` | `uncovered_dispatched` |
`uncovered_dark` | `failed`, mirrored in `train_gate.rs` and `core.ts`):

- **A. Auto-dispatch past grace (once per SHA)**: when the base tip is
  uncovered (`verdict == "empty"`, no deploy workflow run in flight or queued
  for `tip_sha`, secondary observers like `Deploy Health Record` excluded) and
  the tip commit is older than `DEPLOY_RECONCILE_GRACE_SECS` (5 minutes), the
  executor dispatches the deploy workflow (`gh workflow run deploy-dev.yml
  --repo <repo> --ref <base>`) at most **once per SHA**, persisted both in
  executor memory and hub-side (`lane.deploy_dispatched`) and audited as
  `train:deploy_dispatched`.
- **B. Deploy-coverage predicate & lane vocabulary**: `queue_facts.base_state`
  stamps `tip_sha`, `tip_age_secs`, `covered_by` (the SHA of the newest
  decisive green deploy), `coverage_age_secs`, and `deploy_coverage`. The lane
  blocked reason and `TrainPanel` banner render the coverage fact directly
  (`tip 7f5efec2 not covered by any deploy (age 17m) — auto-dispatched
  deploy-dev.yml`) instead of conflating a dark tip with a red base.
- **C. Fast page**: an uncovered tip past grace holding cars immediately files
  ONE per-SHA `MERGE TRAIN DARK TIP` alarm ask (`syncDarkTipAlarm`) with the
  auto-dispatch receipt and a one-click re-dispatch option — never waiting
  60+ minutes for the P4 starvation clock — and auto-closes the ask the moment
  the deploy starts settling or covers the tip.
- **D. Redundant queued run cancellation**: when a `workflow_dispatch` (or
  earlier run) is already `in_progress` or `completed/success` for `head_sha`
  and a duplicate `push` run for the **same `head_sha`** is `queued` behind the
  concurrency group, the executor cancels the redundant queued run (`gh run
  cancel <id>`, audited as `train:redundant_runs_cancelled`), saving ~15m of
  extra line hold per occurrence.

### The deploy drift alarm's settle window (BR#3289)

The `Deploy drift alarm` check (`deploy-check` job in `.github/workflows/ci.yml`, probe logic in
`scripts/deploy-drift-alarm.sh`) compares the live hub's `__version` commit against every main
push. The hub deploys asynchronously (git push → CF Workers Builds), so a first-probe failure read
"main is broken" on every push — 6+ false reds in 24h, each also tripping the `main-green gate`
on the next PR. The alarm now settles first: while the hub still serves an older build it emits
non-failing `::warning::` annotations for up to 10 minutes (`SETTLE_WINDOW_SECONDS`, default 600)
and goes green the moment the hub serves the pushed SHA — or a newer main tip containing it (a
faster merge superseding this push's deploy is not drift; drift is "deployed hub ≠ main tip").
Only a window that elapses stale fails loudly — real drift (CF Builds stalled or bypassed),
feeding the `main-green gate` and the merge train's base-green leg exactly as before — and so
does a hub that never answers. A failing main-tip lookup never turns a mismatch green
(fail-closed). Guarded by `npm run test:deploy-drift-alarm`.

## The merge train: serialized merges, credential-free hub (BR#3516)

Accepted decision BR#3516 re-divisioned the merge machinery: **the hub holds no VCS
credentials, ever.** Every GitHub fact is fed to it by an executor running on your own
machine; the hub decides (lease CAS, classification, events, queue) and only the
executor acts (`gh`). The hub-side sweeps that read GitHub — the standing merge-queue
sweep (BR#3198), the PR-disposition executor (BR#3312), the provenance sweep, the
GitHub-reading closure audit — are deleted, not deprecated: a hub that cannot reach
GitHub cannot lie about GitHub. The pure decision tables survive, pinned
(`packages/worker/test/merge-sweep.test.ts`); the executor's gate
(`decideTrainGate` → `decideMergeAction`) is one implementation shared with the hub,
unit-pinned in `packages/worker/test/merge-train.test.ts`.

### The executor

Merge responses are acknowledged immediately in the line status: a recorded
response waits for GitHub reconciliation; an observed merged PR waits for
deployment verification. Neither keeps asking for the same merge. PR blocks
show verification state; historical repair/review returns are available in their
details rather than overprinted `×N` labels. Historical totals are separate from
an active same-kind bounce-budget escalation. Repairs held by an unconfirmed old
writer name the gateway reconciliation required before another worker may start.

The [delivery-mechanism architecture review and proposed structural repair plan](docs/analysis/BR-7542-delivery-mechanism-review-and-plan.md)
records remaining lifecycle, completion, priority and recovery gaps at commit
`4c1f82416`. Its acceptance criteria describe proposed work, not shipped guarantees.

**A stalled merge pipeline is a machinery fault (BR#7500).** After an hour with
queued work and no merge, the line says **STOP THE LINE — merge machinery stalled**,
with elapsed time, main-check health, live executor presence and the number of
candidates that passed initial queue gates. Bridge owns priority diagnosis and
repair. A heartbeat is not throughput, and a completed diagnostic is not recovery.
A single candidate's failed check must not be presented as the reason independent
candidates cannot merge. Candidates waiting for current-base CI or integration
repair are deferred while the executor continues the remaining independent batch;
their stale heads cannot merge. A worker reporting `MCP UNAVAILABLE: bridge tools
missing` is a failed execution configuration, never a successful diagnostic or
review. The runner preserves its work and releases the failed claim for execution
repair. Repeated missing-tool failures name that exact cause in the gateway's
bounded cooldown; they cannot generate successful diagnostic or review receipts.

Since BR#4104 the executor ships **inside the gateway** (Ray-directed completion of the
original BR#3516 spec): the daemon — the desktop app and the headless `bridge` runner
share one dispatch core — spawns the train tick beside its dispatch loop and contends
the lane lease exactly like the standalone command below. First-to-lease wins per lane;
a holder that dies lapses its 5-minute lease and the next gateway reconciles from live
GitHub state. **No hand-installed systemd unit, no separate binary to update**: the
train updates ride the normal gateway deploy path, and every gateway on a stock build
is an opportunistic executor. The identity law is enforced at the write boundary
(BR#3181): the tick probes its gh identity class — merge / update-branch / close legs
execute only under the worker-class credential (detached-cody); a personally-authed
gateway reconciles and reports read-only, then stands down LOUDLY from write legs and
releases the lease. Lease renewals carry proof-of-progress (last ledger action + age),
and the hub consumes it (BR#4129): a holder whose action note freezes while cards queue
is evicted — see the lease law below.

**A merged receipt survives a mid-walk lease loss (BR#5385)**: the 2026-11-01 11:18Z
incident ran two walkers per lane (the hand-installed daemon units + the gateway's
in-process train leg) under ONE actor — one gateway token — so the CAS read every
peer release as "already mine"; the raced merge released the lease mid-walk and the
winner's `merged` event died at the gate ("held by nobody"), a real landing lost its
provenance, and the lane ping-ponged. A merged event is a receipt of an already-done
GitHub fact, not a lane write: when the lane is UNHELD and the ledger proves the
lease was lost within the TTL (a release / lapse sweep / zombie eviction) to the
same authenticated identity, the hub admits the receipt (`mid_walk_receipt` rides
the event detail and the lane version), stamps provenance, and the settle proceeds —
the batch is not aborted. Everything else fails closed with the original gate error:
a live holder, an actor that never held the lease, or a loss older than the TTL.
GitHub truth still guards the stamp: the BR#5151 dedupe refuses a different
merge_sha for an already-merged PR, and the executor's live PR-state re-read
re-stamps any contradiction (the hub holds no VCS credentials — the executor is the
only GitHub-talking leg).

**Capability honesty (BR#4489, ADR BR#4487)**: a gateway that cannot merge does not
pretend to serve the lane. `bridge doctor` classifies the host (`gh api user` against
`MERGE_TRAIN_WORKER_IDENTITIES`) and checks push permission on the lane repos; an
incapable host prints `will not claim train lock as I cannot merge PRs` and doctor exits
with the merge-train leg flagged (non-fatal for non-train functions). At claim time the
executor re-checks the classification on a ≤5-minute cache — startup truth is not
runtime truth — and a non-capable host skips lane contention entirely (the skip logs
once per 10 minutes, not every tick). If a merge write is refused mid-flight (403 /
permission), the executor releases the lease immediately and **self-demotes for the
process lifetime** — it will not claim the train lock again until the gateway restarts
with a fixed credential. Leases carry `merge_capable`, so the hub can tell a served
lane from a pretended one.

`bridge train` remains the standalone form of the same module (decision BR#3880 —
install is the unit: no Node, no script file). It runs on any machine that has `gh`
(authed, with the `repo` scope), `git` and a clone of the target repo — or, with no
`MERGE_TRAIN_WORKDIR`, it manages its own clone cache (`~/.bridge/train/<owner>/<repo>`)
like the daemon leg does. The gate is one LAW with two fixture-locked implementations
(`decideTrainGate`: TypeScript hub-side, Rust executor-side — mirrored test fixtures
pin them in lockstep):

```bash
cd /path/to/repo-clone                 # the repo the train drives (MERGE_TRAIN_WORKDIR)
export BRIDGE_URL=https://bridge.<your-subdomain>.workers.dev
export BRIDGE_TOKEN=<token from the Connect tab>
~/.local/bin/bridge train          # long-running loop (45s ticks)
~/.local/bin/bridge train --once   # single tick (cron-friendly)
```

Env (standalone and daemon leg alike): `MERGE_TRAIN_HOLDER` (lease label, default
`merge-train@<host>`), `MERGE_TRAIN_INTERVAL_SECS` (default 45), `MERGE_TRAIN_METHOD`
(`merge | squash | rebase`, default `merge`), `MERGE_TRAIN_WORKDIR` (the clone; default
cwd standalone / managed clone cache in the daemon), `MERGE_TRAIN_LANES` (comma-sep
`repo@base` allowlist; default every lane the hub reports),
`MERGE_TRAIN_WORKER_IDENTITIES` (worker-class gh logins, default `detached-cody`),
`MERGE_TRAIN_EVENTS=0` (kill switch for the event-driven wake leg), `MERGE_TRAIN_ENABLED=0`
(kill switch for the daemon leg). Flags: `--lane <repo>@<base>`
(drive one lane only), `--once`, `--interval <secs>`, `--method <m>`. `bridge doctor`
gates the prerequisites (gh present + authed + `repo` scope, git — each failure names
the fix); the executor re-probes the cheap ones every start. It merges as whatever
identity that `gh` is authed as — the identity gate refuses the write legs unless that
is the worker-class credential per BR#3181, never a personal one.

**Token rot is loud, never blind (BR#4754)**: a hub token rotation invalidates a
long-running train executor's stored credential. Both forms of the executor — the
standalone `bridge train` loop and the in-process daemon leg — classify an
auth-rejected tick (the hub answers `unknown auth token`; there is no HTTP status in
the JSON-RPC error) and run the same paced self-heal ladder the gateway dispatch loop
uses (BR#4113): reload the credential store, then re-vend by principal
(`/api/token/repair` — the principal is the credential, so this works even while the
bearer is fully dead). Backoff between ladder runs is 5s → 300s (the hub rate-limits
repairs at 6/hour per row). The standalone daemon **exits non-zero after 5 failed
ladder runs** with a `TOKEN-BLIND` line naming the cause — a supervisor restart then
starts fresh — instead of the old behavior: ticking blindly forever, one silent
`tick failed` per interval (the 2026-10-29 incident: ~1,684 unnoticed failures on one
lane). Once healed, the executor posts **one note per episode** to the lane card
naming the blind window and the remedy, so the board holds the cause — a token-blind
process cannot post mid-episode (every board write needs the bearer the hub just
rejected), which is exactly why the note fires on recovery.

**Dedicated merge node (`role: train`, BR#4489)**: a normal gateway in a named mode —
set `"role": "train"` in the config (`~/.bridge/config.json`) or `BRIDGE_ROLE=train` in
the environment, and the daemon skips task dispatch entirely while the connection and
merge-train legs keep running. This is the redundancy model from the ADR: run N
capable gateways (or one dedicated train node) — merges never move server-side. Default
(absent role) is the unchanged opportunistic gateway.

One tick: preflight → `train_status` → per lane: CAS-lease → **reconcile from live
GitHub** (never trust a prior holder's picture) → awaiting-CI poll (`train.ci`; the hub
lands, stops or pends) → else the derived queue is **walked in order** (BR#3935): a
permanently unlandable entry must not starve the lane — a leg with **no PR stamp** is
**bounced off the hub** (the audited impl bounce, gate class: the card leaves the
derived queue that tick, impl re-stamps the PR binding, re-verifies, re-queues —
BR#5753; the hub kept matching the stamp-less leg on repo+base, so the old
log-and-advance left the entry in `lane.queue` forever), while a **CLOSED PR** or an
entry with **no unlanded leg on this lane** ("on this lane" is repo AND base, the
hub's own queue scoping, BR#4977) is logged and the walk advances to the next entry
**in the same tick** — and since BR#5897 the CLOSED entry also stamps
`cls: "blocked"` into `queue_facts`, so the hub's lane stats count it in progress,
**never `ready`**: a closed unmerged PR can no longer render as a green ready
block on the trains panel (the SP #2659 / BR#5639 class, where it did), and a
queued car that carries **no stamp at all** after a bounce-free walk counts as
in progress too — the hub-side backstop that keeps a skipped CLOSED PR out of
`ready` (the card stays queued for the humans; the lane never starves
behind it), while a transient
no-op — mergeability still computing, unsettled checks, no verdict — still blocks; the
first drivable entry's **first unlanded leg on this lane**
(BR#3659: a multi-PR card rides leg by leg) → `decideTrainGate` → act: merge (`gh`) →
`train:merged` → next tick polls CI on the merge commit. Every fact crosses the
executor's fact boundary normalized (BR#3714): gh's GraphQL `mergeable` is the enum
string `"MERGEABLE"|"CONFLICTING"|"UNKNOWN"` — never a boolean — and
`mergeStateStatus` is UPPERCASE; `prFacts()` maps them to the boolean|null/lowercase
the shared gate compares. Fed raw, the strings satisfied neither `mergeable !== true`
nor `=== "clean"`, and every gated candidate bounced (genuinely mergeable PRs
included) as "unmergeable — CONFLICTING".

### Lanes, leases, queues

- **A lane card per `repo@base`** — created on demand (`train.lane`), tagged
  `merge-train` + `infrastructure`, never claimable by agents, blocked at birth with the
  honest reason `merge-train: awaiting an available gateway` (merges happen when your
  machines are on). The card's blocked reason is recomputed by the hub from the card's
  own meta — `idle` / `leased by X` / `attempting <card> (gate)` (a queue head is in the
  gate; the tooltip carries the last ledger action) / `settling on <sha> (PR #N)`
  (naming the next head) / `awaiting bypass merge — PR #N by <card>` (a head blocked
  on branch protection a machine cannot satisfy — review/required checks; a human
  merge is the unblock and it self-clears when the PR lands) / `STOPPED — … — culprit
  <card>` / `retired` (a done/superseded lane card is never ticked again, BR#4977) /
  `ready — last ticked by X Nm ago` (a merge-capable gateway ticked inside the
  15-minute window — the train will take work the moment it is queued) /
  `awaiting an available gateway` — so the board always shows the lane's truth, and an
  empty queue never hides which machine is driving the train.
- **Lane cards are close-protected + terminal cards never bind (BR#5061)**: the lane
  card IS the lane — closing one done/superseded retires a live subsystem. The
  2026-10-29 outage: a duty session closed the `state-vector/bridge@main` lane card
  done as a close-reflex, the find-or-create kept binding the terminal card every tick,
  and the lane could not self-heal for hours. Two laws now hold: (1) the transition
  gate's `infrastructure-close-protection` rule refuses done/superseded on any card
  carrying `meta.lane` or tagged `infrastructure` unless the actor is the owner, a
  human (`web:`/`human:`), or the machinery (`system:`) — a duty reaching this edge
  gets a named rejection and records done-with-findings on ITS OWN card instead; and
  (2) the lane lookup skips terminal cards: find-or-create prefers the newest
  non-terminal card carrying the lane key and follows the `supersedes` edge to a
  pre-registered reseed — with the volatile in-flight state (an awaiting-CI
  merge, a line stop, a bypass wait) migrating to the live card once, loudly
  (`lane_rebound`), so an in-flight merge finishes its landing close across the
  rebind. With NO successor the lane is deliberately retired and the BR#4977
  refusal holds (every op refuses `lane retired`; re-open the card or register
  a reseed to re-arm — BR#5061's spec'd create-fresh is superseded by the
  accepted BR#4977 decision on that path) — with ONE exception (BR#5186): when
  EVERY card for the key is terminal and the executor's first-hand probe says
  the base branch is still LIVE on the remote (the hub holds no VCS
  credentials), the closure was an erroneous close (the BR#5130 class that
  killed BR#3648 and BR#5050), not a retirement — the tick asks the hub to
  auto-reseed `v(N+1)` carrying the predecessor's lane config (supersedes
  edge, loud `lane_reseeded` audit) and drives the fresh card in the same
  tick. Without the live-base evidence (a deleted base, a probe with no
  signal) the refusal stands — no resurrection on a guess. `train.status`
  shows ONE row per
  lane — a retired card with a live successor is filtered as history, a
  retired card with no successor stays visibly `retired` (BR#4977) — and the
  hub's lane sweeps skip retired cards; the starvation clock never inits from
  epoch: a lane that has never recorded a merge-capable lease starts its
  starve clock at its own last status change (the bogus "starved 29888714m"
  alarm class is gone).
- **The lease is CAS with a 5-minute TTL**: acquire → held across the whole queue
  (`merge-train: leased by X — idle` between items) → release. The hub stamps
  `holder = the authenticated actor`; the executor never supplies a holder, so a leaked
  token cannot forge another machine's lease. A lapsed lease is cleared by the hub's
  credential-free train-watch sweep and the next gateway reconciles from live GitHub —
  a crashed executor cannot wedge the lane.
- **Zombie eviction (BR#4129)**: every renewal carries proof-of-progress — the
  holder's last ledger action and its age. On a **non-empty queue**, a renewal whose
  action note is frozen past 10 minutes (`TRAIN_PROGRESS_STALE_MS`) is DENIED and the
  lease expires immediately, so the next gateway's acquire wins within one tick; the
  lane card shows `zombie holder evicted — <holder> made no progress for Xm on a
  non-empty queue` until a fresh holder takes over, and the eviction is audited
  (`train:lease_evicted`). A live holder never trips this: every legitimate tick on a
  non-empty queue either acts (a CI-poll note refreshes the action every tick) or
  releases the lease, and an **empty queue always renews** (idle holding is harmless).
  Legacy executors that send `{}` renewals carry no proof — treated as UNKNOWN
  (allowed + a loud audit line) while the deprecation window runs.
- **Starvation alarm + diagnostic duty (BR#4489 + BR#5674 P4)**: two starvation legs share one loop (`laneStarvationTick` / `sweepLaneStarvation`).
  (1) **Merge starvation (BR#5674 P4)**: when a lane holds cars (non-empty derived `queue` OR non-empty `awaiting` set) with `now - last_merge_ts > 1h` and no stop-the-line episode is active, the hub stamps `meta.lane.starvation = {since, fired_at, ask_id, duty_id}`, broadcasts `lane.starved`, fires **one time-sensitive human ask per episode** (`MERGE TRAIN STARVED: <repo>@<base> — >1h with zero merges while holding cars. Diagnose or bypass?`) carrying full diagnosis details (base verdict + names + P1 alarm, blocked reason, queue + awaiting counts, last merge timestamp), and **auto-spawns one agent-executable diagnostic duty per episode** (task card, tags `merge-train` + `diagnostic`, ranked at top priority in `orient` alongside `root_fix` cards, with a checklist covering `per_page`/naming of `required_workflows`, base check-runs count, verify pool depth, and park exits); cleared automatically on any merge.
  (2) **Capability starvation (BR#4489)**: a lane whose queue is non-empty with **no
  merge-capable lease for >10 minutes** stamps `meta.lane.starved_since`, broadcasts `lane.starved` on the WS push channel, marks
  the lane `starved: {since, mins}` in `train_status` (the trains panel renders it red),
  and files **one time-sensitive ask per episode** to the alarm sink — restart a
  capable gateway, merge the head by hand, or waive. Judged both on `train.status`
  reads and proactively on the hub's alarm sweep, so a dead train is loud even with
  zero panel readers. Recovery is automatic: the first capable lease (or the queue
  draining) clears the capability-starved state.
- **Lane lifecycle: a retired lane is never ticked again (BR#4977)**: a lane card
  that is closed (`done`/`superseded`) — a base branch deleted after a drill, or a
  lane deliberately retired — is frozen. Every lane-touching hub op refuses it
  (`lane retired — … re-open the lane card to re-arm`): no lease acquire/renew/
  release, no `ready — last ticked` stamp, no reason rewrite — the BR#4772 class
  where a card marked "never tick again" still showed `ready — last ticked by …
  0m ago` ten minutes later. `train_status` shows the lane **visibly retired**
  (`retired: true`, empty queue, the reason names the retirement) instead of a
  phantom-ready row. The executor honors it from both directions: it skips any lane
  the hub marks retired, and it probes the lane's base branch before acquiring — a
  definitive 404 (base deleted on the remote) skips the lane with no lease and no
  hub meta writes, while any transient gh failure fails open. **BR#5186 splits the
  retired world in two on that same probe**: a definitive 404 is a real retirement —
  skip; a LIVE base under a `retired: true` row means the closure was an erroneous
  close (the BR#5130 class that killed BR#3648 and BR#5050), so the tick asks the
  hub to auto-reseed `v(N+1)` (`train_lane` with `base_live: true` — the executor's
  first-hand evidence; the hub holds no VCS credentials) and drives the fresh card
  in the same tick; a probe with no signal (gh absent, network, auth) is
  fail-closed — the refusal stands, never a reseed on a guess. **The derived queue is
  base-scoped** (same law): a queued card rides only the lane whose base matches its
  PR stamp (`meta.pr.base`, defaulting to `main`) — a second lane on the same repo
  can never inherit another base's queue (the retired drill lane used to show
  `@main`'s queue as its own).
- **Event-driven tick (BR#4806)**: when a lane's derived queue transitions empty →
  non-empty, the hub broadcasts `lane.queued {repo, base, depth}` on the push channel
  (SSE, the same transport as `lane.starved` — subscribe at `/api/kb/sse` with a gateway
  token). A ready gateway runs ONE tick on arrival — the exact same CAS lease acquire,
  identity gate (BR#3181) and proof-of-progress renewal (BR#4129) as every tick — so
  work that queues right after a tick starts within seconds instead of waiting out the
  next 45s poll. The poll cadence stays as the fallback: a missed event degrades to
  today's behaviour, and push + poll firing together is safe by construction (the CAS
  lease serializes; the second acquirer stands down — pinned in test).
- **The queue is derived, never stored**: every open PR on the lane is re-read from
  GitHub each tick, oldest first, and only the head of the queue may merge — one merge
  in flight per lane, and the lane HOLDS until main settles before the next head enters.
  Serialized is the point: no interleaved merges, no surprise rebases, every merge
  attributable to exactly one lane event.
- **Back-pressure: main settles before the next head enters (BR#4804, cadence
  amended by BR#4934)** — after a merge, the lane's awaiting-CI phase judges the
  check runs ON the merge commit: a lane with a configured `required_workflows`
  set settles exactly those; an unconfigured lane (the default) settles on
  **every** check run on the commit — build AND deploy — with a 2-minute settle
  dwell after the merge so slower-triggered deploys can register a check run.
  Anything unsettled (including a cancelled-only run) holds; anything red stops
  the line; only all-green (past the dwell) admits the next head. The old
  default — vacuous green for unconfigured lanes — merged back-to-back and
  every push cancelled the previous Deploy Dev, starving main. While settling,
  the lane reason reads `settling on <sha> (PR #N): build/deploy in flight,
  attempting <card> next, heads held until main settles`, and the panel's queue
  depth is the count of heads waiting behind the pressure valve.
- **Burst-drain settle: one settle per drain pass, not per merge (BR#4934,
  decision BR#4932)** — the per-merge settle stays the law for a not-clean
  head, but a GATE-CLEAN head merges back-to-back behind the previous merge:
  the executor drains every gate-clean head in one pass (up to
  `lane.burst_max`, default 10, `0` = unlimited — it rides `train_lane` lane
  config alongside `required_workflows`) and runs the full settle ONCE, on the
  pass's FINAL merge commit. The lane reason names the phase mid-drain
  (`merging burst (N merged, cap M) — settle pending`) and on settle
  (`settling on <sha> after N merges (PR #N): build/deploy in flight, heads
  held until main settles`); without burst context the BR#4804 strings
  (BR#4981 vocabulary included) are byte-identical. Red anywhere stops the
  line instantly (GH#2261) — a red fed mid-drain never waits for the settle.
  While the settle wait runs, the executor uses it as a rebase window: one
  machine-clean `update-branch` per tick on a behind, verdict-covered queued
  head (a clean trial merge rides with it; a dirty one conflict-bounces;
  carries append contiguously via `train.carry` — the minimal primitive,
  superseded by L1.4's carry law when it lands). On a GREEN settle the pass's
  intermediate parked cards close on executor-fed git ancestry
  (`ancestors_of_settled` via `train.ci` — their runs were
  cancelled-by-next-push, and the hub holds no VCS credentials, so the
  ancestry is the evidence; zero hub GitHub calls); the final head closes
  per BR#4804 unchanged. On a RED settle the hub pre-stamps `stop.bisect` and
  the executor probes the pass's intermediate merge shas oldest→newest (one
  step per tick via `train.bisect`, re-running the stamped checks): the oldest
  RED probe names the ONE culprit — it bounces with a fix-forward brief + the
  BR#4068 boost while the wrongly stop-bounced final card re-parks to close on
  the next green settle; probes that stall past the CI bound (or leave nothing
  re-runnable) stamp the walk INCONCLUSIVE and the pass bounces oldest-first.
- **Batch merges: one settle window per batch, not per merge (BR#4996, Ray
  ruling 2026-10-29)** — the drain classifies the whole queue first, then
  lands a maximal set of MUTUALLY non-conflicting gate-clean heads
  back-to-back (`select_batch` + `conflicts_from_file_sets`, one law with
  two fixture-locked implementations, Rust executor-side and TypeScript
  hub-side like the gate): conflict pairs come from the candidates'
  changed-file sets (`git diff --name-only merge-base..head`), each
  intersecting pair confirmed head-vs-head with `git merge-tree
  --write-tree` (BR#3935 fail-closed — a probe that cannot run counts as
  conflicting, an unreadable file set excludes just that member as
  not-known-clean), and queue order is landing order (oldest-first). A
  transient Skip/Note head no longer settles the pass or ends the tick —
  the walk classifies past it (the BR#4934 behavior starved a whole batch
  behind one skipped head); bounces, human legs and superseded closes still
  fire on sight. The per-member merge leg law is unchanged: the pass's
  FIRST landing still gates on the real base verdict (BR#3009), the burst
  cap and the mid-drain tip RED check re-run before EACH member (GH#2261),
  the mergeability recompute after a machine update-branch is polled
  in-tick (lease-bounded ladder) instead of deferred, and every merged
  event carries `batch_members` — the batch composition in landing order,
  sanitized into the provenance ledger (positive ints, deduped, order
  kept; absent payload keeps legacy rows byte-identical). A merge refused
  mid-batch soft-breaks: the landed prefix settles, the refused member
  waits for the next pass (a fresh pass keeps the loud tick error); the
  pass still runs exactly ONE settle wait, on the FINAL merge commit.
- **The landed close is guarded — a green verdict can never wedge the lane
  (BR#4753)**: when the all-green verdict fires the landed close and the close itself
  is refused (a gate rejection — e.g. done-open-children — or a storage fault), the
  old code raw-threw, silently, every tick: the lane sat `awaiting-ci` fail-open past
  the fail-closed bound (which was only ever consulted on the pending branch) and the
  queue starved behind it. Now every failure is counted on the lane's in-flight
  record (the lane reason names it: `landed close FAILED N× (<class>)`) and resolved
  by the retry ladder: a semantic gate rejection **close-bounces the culprit card
  immediately** (retrying cannot succeed — the bounce brief carries the named gate
  error and the repair contract: the PR is already merged and main green, so resolve
  exactly the named precondition, then close citing the merge commit — no re-merge,
  no re-verify); anything else retries ≤3 ticks, then — or past the bound, whichever
  first — bounces fail-closed with `bounce_bound`. The bounced card is boosted to
  priority 0 (one mechanical leg from landed) and leaves the derived queue, so the
  lane idles and the next head enters; a fault after the `done` actually landed
  repairs to a clean landed on the next tick instead of bouncing a closed card. One
  deduped ask per episode rides the alarm sink (`train_alarm_sink_id`, default
  BR#3124) — the failure used to be invisible.

### The gate, the carry law, the bounce

`decideTrainGate` composes the standing `decideMergeAction` 5c gate (`mergeable`, clean,
every commit GitHub-verified, base green, head checks green) plus **verdict coverage**:
the accepted verify verdict must stamp the exact head, or arrive by a contiguous
machine-clean carry chain. Head checks deduplicate **by name** (BR#5897):
`classify_head_checks` (Rust) / `classifyHeadChecks` (TS) group the runs per check
name, sort by `id`, and judge on the newest non-cancelled run — the same law the
tip classifier (`classifyMainCheckRuns`) applies — so a superseded historical
failure sitting beside a newer success can never re-gate the tick into a
`RerunGate` loop (the Nov-1 `Deploy health (merge gate)` failure beside Nov-3
successes gated a 4.4h re-run loop on six queued SP PRs):

- **A git failure is never a verdict (BR#3935)**: the executor fetches the PR head
  explicitly (`refs/pull/<n>/head`) before any local `merge-base`/`merge-tree` names
  it — a head authored on another box is a bad object locally, and `merge-tree` exits
  1 for a bad object, the same code as a real conflict. Both inputs are verified
  commit objects first; any git failure fails the tick closed with the stderr, and a
  bounce's conflict-file list is exactly the conflicted files (`--no-messages` keeps
  git's prose out of it). The old behavior — a 128 folded into `behind=true` and a
  bounce with an empty conflict list — is dead.
- **A phantom merge refusal is never a conflict (BR#5252)**: the merge-refusal
  fallback (the strict-branch-protection arm where `gh pr merge` answers
  up-to-date/out-of-date) judges from LOCAL ground truth — ancestry + trial merge —
  never the gh error text: a 0-behind head (base tip ∈ head ancestry) is
  structurally conflict-free, and a not-clean read with NO enumerated files is
  structurally impossible for a real text conflict (`merge-tree --name-only` always
  lists paths). Either shape parks an honest lane note with the raw gh refusal and
  retries the read next tick — the PR #332 episode (2026-10-31) bounced exactly this
  shape as "conflict" with an empty file list and burned a one-leg-from-landed card
  two extra dispatches. The fallback now runs the same `bounce_event_kind` refinement
  as the generic bounce arm, and a genuine conflict (behind + enumerated files)
  still bounces conflict-class with the file list — fail-closed stays. Fixture-locked
  in both implementations (the merge-refusal arm and the settle-window probe) at the
  pure decision law + the git plumbing.
- **Carry law (BR#3516 §5)**: the base advanced and the executor's `gh pr
  update-branch` lands machine-clean → the accepted verdict CARRIES — the hub stamps
  the carry record the MOMENT the update lands (`train:updated`, BR#4687: `from_head`
  must equal the leg's stamp, both heads 40-hex, re-delivery is idempotent), and the
  merged event dedupes instead of double-appending the chain. A conflict resolved by
  hand means authored code
  changed under the verdict → the verdict is INVALID at the new head: the executor
  enumerates the conflicting files (`git merge-tree`), `train:bounced` lists them on
  the PR's card, the card re-enters review, and the train re-queues it at the BACK once
  a fresh verify accepts the new head. A bounce and its re-queue are machine-managed
  round trips: a train park — the train's own `merge_train` flag, or an agent re-queue
  following the verify contract's canonical `merge-train: queued` note — never spawns
  an unblock child. The train is the unblock path (BR#3516 §2); a spawned child would
  only be superseded by the next bounce, with the re-park after it flood-guarded on
  the stale stamp — one breach card per bounce cycle (specimen BR#3990 → breach
  BR#4135). The same chain now also extends across rebase-shaped moves — next bullet.
- **Mechanical head moves carry by default (BR#4689, child of BR#4633)**: a rebase
  or other content-preserving head update — same patch-ids — no longer bounces for
  coverage. When the live head is not verdict-covered, the executor first tries to
  PROVE the move mechanical: `git range-diff <base>..old <base>..new`, with the base
  excluded on BOTH sides (a merge-base-anchored `old...new` would count base-side
  advances as added patches after a rebase). One or more all-`=` pairs proves it;
  any `<`/`>`/`!` line (authored code changed), an unreadable object or a git failure
  proves nothing — no proof, no carry. With proof, the gate's carry row fires only if
  the move extends the leg's carry chain tip exactly (`carryChainTip`: the acceptance
  stamp plus every carry record, tip→next, no gaps — a broken chain yields no tip)
  and lands on the live head; the hub stamps `train:carried`, appending the chain leg
  (`via: "rebase"`) only after re-proving the same contiguity server-side — a forged
  or gap-skipping `from_head` is refused by name. The card never leaves the queue: no
  bounce brief, no re-verify duty, no review re-ask (the starvation cascade a
  rebase-only move used to trigger). The ledger row and the card's `train_carry`
  version note name the leg and the range-diff evidence, and the merge re-gates the
  new head next tick.
- **Direct parent train parks queue for real (BR#5751)**: the train's own bounce
  and coverage paths run `trainQueueOnAccept`, but a plain `blocked` transition
  whose note opens with the canonical `merge-train: queued` reason used to bypass
  the hook entirely — the card sat dual-state (a derived queue slot plus a leftover
  `merge_train.awaiting` chip) with a stale `head_sha_at_acceptance` (live on
  BR#4711/4678/3623/3999/4995/4999). The blocked branch now runs the hook itself
  when its note opens with that reason **or its `merge-train: re-queued` spelling**
  (BR#6045: the old exact-prefix gate silently skipped the hook on the re-queued
  form a fresh verify writes after a bounce — stamp stranded on the pre-bounce SHA,
  state never flipped — and the next drain walk bounced the already-accepted head
  for coverage against the stale stamp, BR#5646 bounce #2 / PR
  state-vector/superpositional#2555; the matcher is
  `/^merge-train: (?:re-)?queued/`), and a blocked note that opens `merge-train: `
  but binds NO machine hook is **audited loud** (`queue_hook_unmatched`, the
  BR#5674 P1 empty-is-loud ladder) instead of vanishing silently — a near-miss
  prefix must never decay into a false coverage bounce loop. The `merge_train`
  body flag guards recursion; `alreadyQueued` makes the hook's re-park a meta-only
  refresh; and the converse
  demotion holds: a blocked park whose note is neither a `merge-train:` note nor an
  `Awaiting review (verdict …)` reason clears any leftover `merge_train.awaiting`
  and demotes its `awaiting` state to `bounced` — a card that has stopped waiting
  on a human leg shows exactly that. The Awaiting-park census and the `pr_stats`
  buckets are base-scoped (`lane.base`), so a second lane on the same repo never
  inherits another base's parks.
- **Bounced cards cannot starve (BR#4068)** — a bounced card is the most valuable work
  on the board: verified once, one leg from landed. So the bounce itself **auto-boosts
  the card to priority 0** — the same `boosted` stamp the human ▲ boost writes, read by
  the claim ranking, the train rank and the Backlog; it decays only when the card
  re-enters the train (re-queue), never auto-expiring mid-repair. The review ask is
  RETIRED (BR#4962, per accepted BR#4960 — ask-as-visibility is gone), and since
  BR#5226 a **coverage bounce** (an authored push moved the head past the accepted
  verdict) is judged by what the card's ACCEPTED verdict actually covers — **the
  machine verdict IS the review**: a bounce whose accepted stamp (or contiguous
  carry chain) covers the PR's LIVE head is a stale executor read, not a lapse — the
  card **re-queues IN PLACE on the machine path** (the `merge-train: queued` reason,
  stamps and the typed `pr_merged` await_event intact, boost decayed, zero human),
  and a **plain lapse** (head genuinely moved, no human leg) **bounces to the verify
  pool** through the impl flow (the coverage brief; the repair leg re-enters review,
  which auto-spawns the fresh verify). Only a **genuine human-leg bounce parks the
  card `blocked` in place** under the typed reason
  `Awaiting review (verdict BR#N, anchored at head <9hex>)` with the typed `pr_merged`
  await_event preserved and `merge_train.awaiting` stamped, so the trains panel renders
  it as an `◉ awaiting <age>` chip — amber past the `train.awaiting_ttl_h` window
  (legacy `train.review_ask_ttl_h`), red past TTL + 2h grace, a lapsed park still
  listed (visibility without interruption). The human-leg classes: human-resolved
  conflicts that invalidate the verdict (the event carries conflict files), a
  dismissed external review with no machine replacement, and the signing-environment
  class. **Zero asks and zero lane digests on every path**: the
  parked card in the backlog IS the human leg, and the human **force-reviews it from
  the card** — `approve` re-anchors the accepted verdict at the parked head (a carry
  leg per unlanded PR, via "force-review"), clears the park, decays the boost and
  re-queues the train's own flow (the merge + CI settle still land it); `request_changes`
  bounces impl exactly like the train's own bounce (repair leg, the reviewer note rides
  the brief, fresh verify on re-entry — the parked verdict is NOT carried across a
  requested change). Gate/conflict bounces keep the impl repair leg with no ask legs
  either — the repair leg re-enters review through the normal in_review handoff.
  The watchdog's tick re-evaluates every Awaiting park (the BR#5226 migration for the
  already-parked cards, idempotent): a park whose anchored accepted verdict covers the
  head it parked on re-queues automatically — no human click a machine verdict already
  gave. Force-review is **web/human-only** (the route refuses gateway bearers with 403); the
  stop-the-line and signing-environment asks remain the only genuine-decision asks on
  a lane.
- **`mergeStateStatus=behind` pre-clears at the TRAIN gate only (BR#3727)**: behind is
- **`mergeStateStatus=behind` pre-clears at the TRAIN gate only (BR#3727,
  provenance-gated BR#4687)**: behind is
  exactly "base advanced, branch still mergeable" — the state the carry law was written
  for, which the shared `decideMergeAction` (clean/unstable, untouched) bounces because
  the sweep has no update-branch authority. The train gate pre-clears it ONLY for
  worker-authored branches: every commit's GitHub author login must be on
  `MERGE_TRAIN_WORKER_IDENTITIES` (fetched once, only when the state reads behind, so
  the common tick's gh budget is unchanged; an empty/unknown authorship list fails
  CLOSED to human-owned — a bounce is the safe direction, a machine rewrite of an
  unknown branch is not). The train machine-updates branches its own fleet authored
  and never moves a protected human branch: behind on one of those still bounces to
  its owner. With provenance + a verdict-covered head + a clean trial merge → `gh pr
  update-branch` lands machine-clean, the executor stamps `train:updated` THAT MOMENT
  (leg stamp → new head), and the card re-enters the queue SILENTLY — no bounce
  cascade, no card status change, no re-verify duty, no review ask, no boost: the
  machine rebase is the train's own plumbing, and humans only ever see TRUE content
  conflicts. A dirty trial merge still bounces with the file list (the verdict does
  not carry across hand-resolved code), and an update that reports ok but leaves the
  head unreadable/unchanged fails the tick closed with the carry withheld. The tick
  right after an update-branch reads `blocked` while strict branch protection re-runs
  the required checks on the new head — pending, not a defect: the gate WAITS on it
  (red head checks note; blocked with green checks — protection wants reviews — still
  bounces honestly).
  bounces honestly). A SECOND behind on the same leg (base raced again after a prior carry) machine-updates again — coverage is stamp OR carry, so the chain extends instead of attempting a doomed merge.
- **UNKNOWN mergeability polls, never bounces (BR#4685)**: GitHub computes mergeability
  asynchronously — a read right after a base merge yields `mergeStateStatus=null/UNKNOWN`,
  and `mergeable` rides the same recomputation, so an answer is definitive only when the
  state names itself. The executor backoff-polls inside the tick (15s/30s/60s,
  `MERGE_TRAIN_POLL_SECS` overrides) — bounded by the lane lease, renewed around every
  wait — until GitHub answers, and the shared gate WAITS on an unanswered state: never a
  bounce, and never a merge on an unconfirmed state (the old null-state fall-through is
  closed). Bounce only on definitive DIRTY/CONFLICTING. Receipt: the 2026-10-28 ledger,
  where PRs #279/#281 bounced 28× with `merge_state_status:null` — every "CONFLICTING"
  row of that loop trial-merged CLEAN (a stale read, not a conflict).
- **Mechanical defects bounce with the exact defect named** — conflicts, red base, red
  head, unsigned commits, a head the verdict no longer covers — the same law the verify
  round enforces (rule 5c), now executed by the train. Human-leg defects
  (signing-environment, external mirrors) file ONE class ask per episode, never one per
  PR.
- **Every bounce names its KIND (BR#4066)** — and the kind picks the brief's copy and
  the next owner it cites. **Coverage**: the head moved past the accepted verify
  verdict (an authored push; no conflicts exist) → the brief says so and hands the card
  to the verify pool to re-verify at the new head — no conflict language, no file list.
  **Conflict**: trial-merge conflicts → the enumerated file list rides (a conflict
  bounce without it is refused outright — the "(no file list supplied)" dead-end cannot
  render), and the impl repair leg owns the resolve. **Gate**: a mechanical defect
  (`mergeStateStatus`, red head checks) → the defect is quoted verbatim and impl fixes
  the named defect. The executor trial-merges only a conflict-class bounce — a coverage
  or gate bounce never runs a trial rebase, so a stale `mergeable=false` read (BR#3712
  class) lands as a gate bounce naming the stale state, never as a file-less conflict.
- **Multi-PR cards are legs, gated per leg (BR#3659)**: a card queued with several PRs
  is a list of legs (`meta.prs`; `meta.pr` stays the first leg for legacy readers).
  Coverage is judged per leg (`verdictCoversHeadLeg` — one leg's stamp/carry never
  covers another), the gate bounce names ITS leg's stamp, and the card appears in
  exactly the lanes that own one of its UNLANDED legs. A partial landing keeps the card
  queued (`merge-train: queued — waiting on N leg(s): repo#n, …`); the final close
  cites every leg's merge commit.

### Bounce-release strands are re-boarded (BR#6163)

A card that left the merge queue while carrying a **train-only wait** —
`pr_merged` / `pr_checks_green`, events only a lane's `train_events` can fire —
can never have that wait satisfied by anything a pool executor does: the wait
fires from lane merges, and the card is in no lane's queue. The ghost
bounce-release (a verify bounce whose owning session is dead) used to release
exactly such a card to the pool, stamping no trace of the dead wait — BR#5522
(PR #2734) starved 38 hours under a healthy train that merged 24 PRs a day.

Three legs close the class. The ghost release now copies the train-only wait
onto the release stamp (`bounce_released.train_only_await`) so the strand is
readable from the card's own facts. The alarm-cadence strand sweep
(`sweepStrandedTrainCards`) judges every open card carrying train state or a
train-only wait: strand classes are `out_of_queue_await` (a train-only wait,
no longer a queue candidate), `queued_out_of_queue` (the card says queued, the
derived queue dropped it — the unprefixed-park class), and `unbound_in_queue`
(admitted but legless — the fail-closed unbound park). A strand only counts
when the lane it cites is HEALTHY — a `merged` event newer than the card's
park proves the train moved and left this car behind (a stalled train is the
starvation sweep's problem, not stranded cars) — and only past
`train.strand_hours` (a setting, default 2, clamped 1–168). The reaction is
ONE machine re-board per episode — an in-place reason-prefix repair for
blocked parks (`merge-train: queued — strand re-board (BR#6163): …`, the
prefix is what admits the car back into the derived queue; blocked→blocked is
an illegal edge) or a legal `blocked` transition for released cards, carrying
the machine-managed park flag so the agent queue hook never re-parses legs,
and the typed wait is preserved — pinned by `meta.strand_reboard` so a card
is re-boarded once, never cyclically; a live in_progress claim is never
hijacked. `unbound_in_queue` cars are alarm-only: a machine re-queue would
fail-closed re-stamp unbound. Every strand also alarms ONCE per card-episode
(24h `strand_alarm` dedupe plus the identical-open-ask guard) to the train
alarm sink (`train_alarm_sink_id`, default BR#3124) with the class, the age,
and what the machine already did. Awaiting parks (BR#5633's sweep), bounced
re-entry (BR#4494's demote), and cards holding a bound ask are excluded —
other law owns them.

### One line-health and recovery state (BR#6389)

**Main is monitored even with an empty merge queue (BR#6901).** Every idle
executor tick reads main's required checks, reconciles deployment coverage,
and publishes the observation before releasing its lane lease. Pending,
failed, and recovered main states therefore continue to advance without a
queued PR. A failed read stays fail-closed; a failed publication is an error,
never a successful health heartbeat. An in-flight batch still settles through
the merge-commit CI protocol.

Health freshness uses `queue_facts.base_observed_at`, separately from the
queue publication timestamp. Parked-task sweeps, acknowledgement messages,
and executor heartbeats cannot make old main facts fresh. Legacy snapshots
retain their original timestamp until replaced by a real observation. After
15 minutes without a health observation, even an idle previously-green lane
reports **Status is out of date**, rather than implying main is still healthy.

#### Cause-specific closed-loop recovery (BR#6522)

Each failed commit has durable recovery episodes keyed by a typed cause:
`test_failure`, `capability_unavailable`, or an undiagnosed `check_failure`.
Different workflow attempts do not create different incidents. A specific
diagnosis supersedes a broad job-name placeholder without erasing other causes.
Existing repair tasks own the work; the journal does not create duplicate fixes.
Binding an observed current-main failure sponsors its existing repair task as
priority-zero root-fix work, so a released cause repair cannot silently sit
behind ordinary implementation while the entire line is held.

`train_recovery_event {repo, base, head_sha, cause, event_id, event}` records
observed evidence, diagnosis, action starts, action outcomes, and progress.
Repeated event IDs are idempotent. The updated executor obtains durable
authorization before a generic main retry (one retry per cause/commit); known
test/capability defects go to repair instead of a blind rerun. Record the actual
result after dispatch. A heartbeat is liveness, not an action outcome.

Episodes move through `diagnosing`, `repairing`, `verifying`, `exhausted`, and
`recovered`; broad placeholders may be `superseded`. Code submission and task
completion only start verification. Clients cannot emit a recovered event.
The hub requires a successful decisive deployment receipt matching current main
and a green effective check verdict, plus accepted repair delivery (or the
actual delivered bounded retry for a generic check failure). Passing deployment
evidence can accrue while review is pending, but cannot accept an unmerged or
unreviewed code repair. Set `successful_deployments_required` on
an observed event when a stability bar needs several distinct successful runs;
polls never count as additional successes and requirements cannot be weakened
by later observations. New failures reset consecutive evidence.

The stop-line banner shows every cause, bound repair owner, stage, explicit
next step, attempts/results/receipts, and an expandable history. Structured
`log_progress` and task-submission events update the journal automatically.
Deployment observations publish actual run attempts and are refreshed by the
updated train executor, independently of merge-control decisions.
Bound tasks expose typed `meta.recovery_links`; the agent operating instructions
name the journal protocol so repair executors can publish action/result facts
without relying on an operator to transcribe runner output.
Execution events and journal progress are owner-fenced. Other agents can add
diagnostic comments, but cannot replace a repair executor's next action. Claim
events record assignment separately from action execution. Historical incident
observations also preserve the repair's current root-fix commit binding.
Comments on linked recovery work cannot implicitly claim a released task or
refresh another executor's liveness. Recovery work requires an explicit claim.
Train merge receipts add an explicit repair-merged history event, distinct from
the still-pending deployment verification.
An executor can also report a first-hand out-of-band repair merge through
`repair_delivery_observed`, but its PR/head must match the task's independently
accepted binding. That only advances verification; it cannot certify recovery.
Before the accepted repair lifecycle closes, merge-observed verification requires
deployment of that exact merge SHA; workflow ordering alone is not ancestry proof.
The live main-failure banner selects an open cause-bound repair ahead of stale
starvation diagnostics, preserving concrete human-action requests when present.
A submitted root repair awaiting independent review is machine-owned even if
earlier watchdog attempts failed. Historical attempts alone cannot demand human
re-arming after submission; an explicit permission or authority escalation still
remains actionable. A submitted PR is not accepted train admission.
`train_status.hub_commit` identifies the Durable Object build actually serving
lane state, independently of the edge Worker's `/__version` stamp.
Machine update receipts append only to the queued PR leg on the matching lane
and to the current contiguous verdict-chain end. Repeated clean updates preserve
the accepted verdict; gap or unrelated-task receipts are rejected. Rust and hub
gates retain the root-fix fast lane alongside worker-branch provenance checks.
When GitHub reports an intermediate merge SHA that never triggered main CI,
the executor settles it from the current live tip only after proving Git
ancestry. Empty check lists cannot pin that merge forever; unrelated commits,
running checks, and real failures cannot use this fallback.
A merge gate waiting only on unsettled checks displays "Waiting for required
checks". It never calls a pending check a failed main; actual failures and
persisted stop-the-line episodes retain precedence.

Repair ownership displays the agent label through the identity join, never its
stored principal. Runner output is liveness/diagnostic detail; the main recovery
message uses an explicit agent progress/next-action report, or states honestly
that the next action has not yet been reported (BR#6497).

The hub publishes a typed `line` projection for every train lane, shared by
the status chip, message and recovery banner. Its closed phases are `ready`,
`working`, `waiting`, `stopped`, `unknown`, and `retired`. Healthy states cannot
carry a failure; interrupted states require a cause and a recovery disposition.
The UI renders this contract instead of reconstructing health from lease,
starvation, check-subset and latest-log heuristics.
The overview keeps routine builds, deployments and check waits compact in the
lane row; expanded recovery banners appear only for stopped or unknown/error
states. Click the lane to inspect full operational details in its card view.

**Action-first recovery (BR#6667):** a ready, non-conflicting cure blocked by
main's deployment gate says **Fix ready — your merge is needed**, links directly
to the fix PR for a bypass merge, and links its confirmation request when one
exists. Repair logs, old next-action reports and resolved episodes are collapsed
under details. A new merge-refusal episode cannot reuse an unrelated starvation
diagnostic as its repair. Raw GitHub refusals remain available in merge details.
Before merging, the executor intersects repository merge flags with the effective
base-branch rules (including allowed methods and linear history), choosing an
allowed method instead of repeatedly attempting a forbidden merge commit. It
holds on unreadable policy; method selection never bypasses required checks.

A decisive deployment failure on the current tip outranks a successful subset
of required jobs. Deployment receipts keep their actual commit/run identity:
an older green run cannot certify a newer tip. The same effective verdict
controls queue admission, stale-gate reruns and stop clearance. A failed line
stays visible even with an empty queue. Recovery names the failing evidence,
the repair task, its executor and heartbeat, progress and next action. Missing
or stale observations fail closed. A human action identifies a concrete cure PR
or linked request; an exhausted machine retry budget alone is not a human task.
Explicit `train.lane` configuration updates refresh an existing lane atomically
and return the updated required-check set, rather than silently retaining it.
The authenticated `train_observe_deploy` observation plane accepts first-hand
GitHub commit/run/job receipts independently of the merge lease. It cannot
merge or bypass checks. The hub persists those facts and folds them into every
subsequent gateway snapshot, so an outdated merger cannot erase a known failed
deployment with a scoped-green report. Other-commit, stale, or mismatched
receipt observations are rejected.
A newer gateway observation with a matching terminal deployment receipt can
supersede an earlier pending observation, so the watched retry can recover
normally without a second manual report. Older borrowed receipts cannot.

### One merge classification (BR#6330)

There is exactly ONE answer to "is this card awaiting merge?", and it is the
typed card phase `meta.merge_train.state` — the closed union
`queued | awaiting-ci | bounced | conflicting | awaiting | unbound |
base-red-park | landed`
(canonical in `@bridge/contracts` `MergeTrainPhaseSchema`; the predicate is
`isAwaitingMerge` = phase ∈ {queued, awaiting-ci}). Every reader asks the
field: the derived queue (`mergeTrainQueue` admits on prefix OR stamp —
deliberately fail-open, a stray admit is gate-checked while a silent drop
starves a lane), the watchdog holds (`releaseHold`), the lane awaiting band,
and the Backlog's "Awaiting PR merge — train" group (`exitClassOf` — the
prose `TRAIN_RX`/`GH_PR_RX` regexes are deleted; the `pr_merged` await_event
is the machine LEG the train flips, not a display class, and non-train
`pr_merged` waits — upstream PR dependencies with `phase === null` or
`unbound`/`bounced` PRs — are distinguished: dependencies file under "Awaiting
PR dependency", and unbound/bounced PRs under "Awaiting agent — PR repair or
queue binding". `conflicting` train cars file under "Awaiting PR rebase —
conflict on train", with every Backlog section and row explicitly labelling
who or what unblocks it: `You`, `Agent`, or `System`, BR#6395).
A card cannot enter the merge class by text or by an upstream `pr_merged` wait. The count in Backlog equals the
trains queue by construction because stranded state self-heals:
`sweepMergedParks` (alarm cadence, the strand-sweep family) closes any
blocked queued/awaiting-ci card whose PR leg carries a **provenance merge
receipt** — the hub's own merge record (BR#3287), zero GitHub calls — via the
lifecycle-legal blocked→in_progress→done citing the merge sha; multi-leg
cards stamp the leg landed and re-queue to the next unlanded leg (the
closeBurstParks mechanics). This kills the 2026-11-05 shape: nine cards for
already-merged PRs sitting in the merge class because the settle-close owed
them rode a pass interrupted by red cycles / out-of-band pushes.
Pinned in `packages/worker/test/br6330-merge-class.test.ts`.

### Duplicate citations bind once; the stale re-queue fails closed (BR#6349)

The `unbound` phase's writer is now fail-closed at the source. The
BR#4684/PR #309 livelock (2026-11-04): a verify accept note cited the PR
twice — the canonical `/pull/` URL plus a `/pull/N/commits/<sha>` receipts
deep-link, which `TRAIN_PR_URL_RE` also matches — `trainParseNoteLegs`
minted TWO legs for one PR, the multi-PR adjacency pairing bound neither
`head <sha>` token, and `trainQueueOnAccept` silently folded the stamp back
to the pre-rebase `head_sha_at_acceptance`. The car re-queued at a head the
verdict did not cover, the coverage gate bounced it twice, and the lane
starved until a manual re-park.

- **One PR is ONE leg**: the URL loop dedupes by `repo#number` exactly like
  the `owner/name#N` loop always did — a deep-link of an already-cited PR
  never mints a phantom leg, and a single cited PR binds its head by the
  lenient single-PR rule again (URL + shorthand double-cites collapse the
  same way). Citing the same PR twice is now harmless; `/commit/<sha>`
  stays the receipts convention.
- **The verify duty teaches the convention (BR#6343)**: the ACCEPT step of
  every verify prompt states it outright — cite each PR exactly ONCE (the
  `/pull/` URL or `owner/name#N`, never both, `head <sha>` adjacent) and
  cite commit receipts as `/commit/<sha>` URLs, never `/pull/N/commits/…`
  deep-links — defense-in-depth riding the parser dedupe, so a
  hand-written note cannot re-arm the livelock on a hub still running a
  pre-dedupe build.
- **The re-queue fail-closed**: when an already-queued card is re-accepted
  and the note carries a `head <sha>` that binds to NO stamped leg while
  the fold moved nothing, the card is stamped the typed `unbound` phase
  with `stale_head`/`note_head` receipts and a loud
  `queue_stamp_not_refreshed` audit (the BR#4648 event id, promoted from
  post-hoc narration to the stop) — the old stamp is never folded forward,
  so a stale entry cannot ride into the drain walk to be bounced later. An
  honest no-op re-accept (the note's head equals a stamped leg's head)
  still queues.

Pinned in `packages/worker/test/br6349-stale-requeue.test.ts` (the incident
note rides the real bundled DO) plus the parser drills in
`merge-train.test.ts`.

### Conflicting cars park, typed — never churn (BR#6348)

A conflicting head car used to bounce back to `in_progress` — invisible to
every queue reader (the derived queue went silently empty while the lane
still held a car) and churned: the Phase A specimen retried the same losing
trial-merge for 3h46m with zero signal. Now a conflicting gate verdict parks
the card **typed**: `meta.merge_train.state = "conflicting"` (in the closed
union) with `conflicting_at` starting a **bounded budget** — knob
`train.conflicting_budget_min` (default 120 min, clamped 15–1440). The park
reason carries the `merge-train: conflicting` prefix, which — like the
queued prefix — ADMITS the card into the derived `mergeTrainQueue`:
starvation accounting, the panel queue block, and the lane's queue counts
all see it. Admission here means **visibility, not mergeability** — the
executor's walk SKIPS a car already parked conflicting (a repeat conflicting
verdict on a parked car converts to Skip, class `conflict`; only the first
verdict bounces, establishing the park with the trial-merge file list), so
the clock owns the exit, not churn. `releaseHold` protects the park (the
watchdog never strands it). Past the budget `sweepConflictingCars` (alarm
cadence) fires ONE ask per episode (24h `conflicting_alarm` dedupe plus the
identical-open-ask guard) to the train alarm sink naming the mechanical
rebase leg — repo steering §8: the exit is 100% machine work. A claiming
session ends the park (blocked→in_progress flips the phase conflicting→
bounced and clears the episode keys), rebases onto origin/main, resolves,
signed force-with-lease pushes, re-verifies, and re-queues at the BACK.
Every phase write that leaves the phase (accept → queued, train:merged,
machine re-queue) clears `conflicting_at`/`conflicting_alarm`
(`clearConflictingEpisode`) — stale keys are inert to readers but illegal
residue under the closed union. `trainStrandClass` returns null for
`conflicting` (the budget sweep owns it; the strand sweep never double-owns).
Pinned in `packages/worker/test/br6348-conflicting-park.test.ts`.

### The anti-languish law (BR#6384)

Three ways a card could sit forever past its own evidence, all closed.

**Observed-merge close.** The reconcile feed used to see only OPEN PRs: a
bound card whose PR merged out-of-band (a missed train event, a feed gap)
could never close — reconcile had no merged state to observe, so the card
languished blocked while the PR sat green on GitHub. The daemon now
concatenates the merged feed beside the open feed (`concat_pr_rows`,
additive — a gh failure on the merged leg degrades to the open feed alone),
non-object rows are dropped daemon-side (the hub's `normalizePr` still owns
number-level junk — the additive contract is pinned, not assumed), and each
`ReconcilePr` row carries `state` + `mergeCommit` (null on open rows and
legacy feeds — an open-only feed behaves exactly as before). The observation
loop in `reconcileJoin`, partitioned by `prRowIsOpen`, closes the bound card
of any PR observed MERGED with a citable merge commit — no provenance row
and no ruling duty needed (lane cards stay exempt per BR#5151; the reverse
loop skips observation-owned bindings, and a PR is judged once per pass).
The DO apply unparks first (blocked → in_progress under `merge_train: true`,
then done — blocked→done is lifecycle-illegal), and the close note leads
with the fact: `reconcile: observed MERGED (BR#6384) — <repo>#<n> merged
out-of-band, mergeCommit <sha9>…` (version summaries truncate ~140 chars, so
the law tag and the sha come early). The accounting line grows a segment —
`[observed-merge: N observed-merged closed]` — and the accounted recompute
runs after the observation loop so its closes are counted, not alarmed as
missing bindings.

**The disposition ladder.** What the strand sweep (BR#6163) can only
re-board once, the ladder disposes on a bounded verdict path.
`dispositionStrandedTrainWaits` runs in the alarm sweep right after
`sweepStrandedTrainCards`: eligible = blocked + a train-only wait
(`pr_merged` / `pr_checks_green`) + strand class `out_of_queue_await` + a
HEALTHY lane (a merged event newer than the park — a stalled train is the
starvation sweep's problem) + park age past `train_strand_disposition_h`
(default 24, clamped 4–168; underscore keys — `admin.settings_set` validates
`^[a-z0-9_]{1,40}$`, dotted keys are unsettable). Four rungs, bounded by
`train_strand_ladder_rounds` (default 2, clamped 1–8): (a) provenance
receipt or a verified-ok probe → unpark-then-done citing the sha (the same
lifecycle law as the observed-merge close — the done rides in_progress);
(b) a conclusive merged-probe negative (the PR reads CLOSED unmerged) →
superseded with findings — the one legal exit from blocked; probe-first
grace via `meta.strand_probe_grace` so the first pass probes before any
duty spawns; (c) ONE re-verify-or-drop duty per round (`meta.strand_ladder`
pinning `{rounds, last_duty_id}`, relates-linked, title `Strand disposition
round N — verify-or-drop <card>`); (d) rounds exhausted → superseded
`ladder exhausted`. No rung loops: a stranded car ends closed, superseded,
or carrying a fresh verify-or-drop duty — never parked indefinitely.

**pr_merged proxy probes.** The BR#4658 probe grammar grows the atom trains
wait on: a `pr_merged` park probes under key `merged:repo#N`, the probe row
joins the queue with the PR bound (the executor answers first-hand with
`gh`), and `evalProxyAtom` consults provenance FIRST (BR#3620 — a
train-stamped merge is a hub-owned fact) then the probe verdict: MERGED with
a citable merge commit = satisfied citing the sha as head_sha; CLOSED
unmerged = conclusive negative (fail-closed, BR#3409 — the park goes loud
instead of waiting forever); OPEN or junk = transient, the probe re-arms.
The Rust executor's `observe_probe` arm classifies through the same pure law
(`classify_pr_merge_state`) — one classifier, pinned both sides.

Pinned in `packages/worker/test/reconcile.test.ts` (feed partition +
accounting + projections), `packages/worker/test/br6384-anti-languish.test.ts`
(observed-merge close end-to-end + every ladder rung, real DO + miniflare),
and the classifier/feed pins in
`packages/desktop/src-tauri/src/train.rs`.

### The ops (MCP + HTTP)

`train.status` (GET `/train` mirrors it) · `train.lease` (acquire / renew / release) ·
`train.event` (`merged | bounced | stopped | landed`) · `train.ci` (executor-fed check
runs on the merge commit) · `train.lane` (ensure / configure) · `train.history` (the
`train_events` ledger — provenance serving). The executor never self-certifies:
`train:landed` re-classifies the fed check runs and REJECTS a non-green report outright
("post train.ci instead and let the hub decide").

### Setup

```jsonc
// admin.settings_set — lane config seeds the lane card at birth; the
// operator/executor refreshes it in place via train.lane afterwards
"train_lane": {
  "state-vector/bridge@main": {
    "required_workflows": ["Test", "CLI build (packages/cli)"],
    "ci_typical_minutes": 20
  }
},
"train_alarm_sink_id": "BR#3124"   // stop-the-line asks land here (default BR#3124)
```

`required_workflows` names the checks that must be green to land (the same checks the
main-green gate ruleset enforces); `ci_typical_minutes` paces the fail-closed CI bound
(unknown past 3× typical classifies red — the train never waits forever). Lane identity
is `repo@base`, so one repo can run several lanes (e.g. `main` and a release branch).

## The knowledge channel: typed faults, never HTML (BR#4212)

Every arm of the knowledge channel — the DO fetch entry, the worker's
`/api/kb/*`, `/api/kb-machine/*`, `/api/kb/admin/*` proxies, and `/mcp` — is a
catch-all: a storage-layer fault answers **typed JSON** with
`result_class: "infra_storage_fault"` (HTTP 503), never an uncaught throw, a CF
HTML error page, or a mislabeled `401 unauthorized`. Before BR#4212 (incident
BR#4117) one DO storage fault took the whole entry down uncaught: the runtime
served HTML 500s where JSON acks belong, writes were silently lost, and
`/mcp`'s catch relabeled infrastructure failures as "unknown or revoked token"
— a storage storm read as an auth storm. The classification law since:
**infra faults retry (503), auth rejections 401, and the two never masquerade
as each other.** Only the three genuine identify rejections (`missing bearer`,
`unknown auth token`, `auth token revoked`) produce a 401.

The third class — **the hub refusing** — is not infra at all (BR#4390). A
machine gate rejection (an illegal lifecycle edge, `done-open-children`,
`blocked-needs-typed-await`, a claim race, …) is a *deterministic* answer:
the DO stamps it `result_class: "gate_rejected"` and answers **HTTP 400**
carrying the rule name (`[rule: …]`), and the MCP layer surfaces it as a
tool error with that message intact. Before BR#4390 an untyped 400
rejection fell into the infra fallback and came back as
`503 "kb temporarily unavailable — retry"` — so refusals that could never
succeed on retry (the BR#4068/BR#3822 close attempts) read as an outage and
burned dozens of futile retries. The classification law, complete:
**5xx / typed `infra_storage_fault` / unclassified throws → 503 infra
(retry the channel); 401 → the three genuine auth rejections; 400 → the
hub refusing — read the rule, act on it, never retry blind.**

The watchdog's view is machine-checkable via `GET /stats` (or
`POST stats`): the response carries a `channel` block — per-route `ok`/`err`
counters with `write_ok_rate` over the write ops, `entry_faults` (which
storage stage faulted, how often, how recently), `ws_send_fail` (failed
fanout sends, the in-DO proxy for clientDisconnected), and `last_flush` (the
alarm tick's persisted snapshot — counters reset at isolate boot,
`window_started_ts` says when). "Channel down" is thus a readable predicate
(error rate + fault recency), not inferred from silence — phantom stalls are
distinguishable from real ones. The DO alarm failure policy: degrade + retry
— a faulted re-arm never throws out of `alarm()` (a throwing alarm loses its
schedule entirely); the next fetch entry re-arms via the null-or-stale guard,
and the sweep rides the 60s alarm retry chain.

## The hub self-canary: daily synthetic lifecycle (BR#4177)

The hub is coordination infrastructure — it gets the same treatment the product gets:
its load-bearing paths get a **synthetic end-to-end canary**, run daily, red alarm to
the alarm sink. `bridge canary` is a single cron-friendly lifecycle pass against the
**deployed hub** (same MCP surface as every agent, same `BRIDGE_URL`/`BRIDGE_TOKEN`):

```bash
export BRIDGE_URL=https://bridge.<your-subdomain>.workers.dev
export BRIDGE_TOKEN=<token from the Connect tab>
~/.local/bin/bridge canary          # one full pass (typ. 15–25 min; worst case ~65)
# cron/launchd daily — exit 0 = green, 1 = red (filed alarm), 2 = config fatal
```

Four legs, each named for a failure class actually observed:

1. **Duty spawn → dispatch → delivery** — a qualified synthetic task must be claimed
   by a runner within 10 minutes and deliver its marker to the board within 10 more.
   Catches the "result delivered late/lost" class (two observed in a single week).
2. **Flip-on-event** — a synthetic card parks on a typed `{event:"time"}` await; the
   unblock proxy sweep must flip it within two sweep cycles, no human action. Catches
   the stale-ledger class (BR#3620 family: resolutions hidden for a day). The
   `pr_merged`/`run_success` flavors of the same mechanism fire daily on the real
   train; the canary uses the timer flavor because the hub holds no GitHub
   credentials by design (BR#3516) — non-lane GitHub facts are never fed to it.
3. **Queue visibility** — a fixture carrying the BR#4079 canonical stamp
   (`merge_train.pr>0` + `merge-train:` reason, `blocked`) must appear in the
   **derived** train queue, then vanish the moment it retires. Catches the
   clobbered-stamp class (BR#3912). The fixture cites an obviously-fake PR
   (`999901`); if a train tick ever lands on it, the executor's `gh pr view` fails
   harmlessly before any gate — one lost tick, zero board writes.
4. **Reconcile accounting** — BR#4170's report must run green (every PR accounted).
   Armed but skipping until that lane lands its report surface; a missing dependency
   is not a red.

**Red path**: one deduped ask per failing leg class, bound to the alarm sink
(`train_alarm_sink_id`, default BR#3124) — the same child-ask pattern the train's
stop-the-line uses, so a stuck class pages once, not daily. **Green path**: a
`[hub-canary]` progress artefact stamps every run; **48 hours of silence on that feed
is the canary's own liveness alarm** (a canary that stops running must be observable
too).

Fixtures self-clean by law: tagged `[canary]`, retired to `blocked` with a 30-day
typed timer (inert: never fires, never claimable, never queued). Task→superseded is
not a client-legal edge (core.ts LIFECYCLES), so retirement — not deletion — keeps the
board free of fixture accumulation without loosening the state machine. At most two
inert blocked fixtures accumulate per run.
## The board↔GitHub reconcile loop (BR#4170)

The merge train accounts for PRs it *knows about*. The reconcile loop closes the gap:
**every open reviewed PR must, at all times, be one of exactly three things on the board —
bound to a card, ignored with a recorded reason, or in-flight on a spawned duty.** Anything
else past the actionable age is an ALARM to the sink, never a silence (the #2466 class: a
session died post-open and an APPROVED+MERGEABLE PR sat invisible for 34 hours, outside
every stamp-gated mechanism).

Division of labour is the credential split (BR#3499/BR#3507): the gateway daemon runs the
read-only `gh pr list` leg and feeds raw observations via `reconcile_report` — a list
read that dies on a transient GitHub 502 / 504 / Bad Gateway / timeout retries ONCE
at `--limit 100` (BR#5897: one flaky 502 used to abort the whole pass, silencing
every repo still queued behind it for the cycle); a repo that still fails fails the
pass, which retries whole next tick; the **hub**
runs the join (`reconcile.ts`, pure), decides, and performs every board mutation. The
daemon never writes the board; the hub never touches GitHub. A report per repo per cycle:

- **bound** — an open card rides the PR (`meta.pr` / a `meta.prs` leg); queued cards are
  the train's business and are never re-spawned at.
- **ignored-with-reason** — `reconcile_ignore {repo, pr, reason}` rules a PR off the board
  on the record; an ignore without a reason is refused (an ignore IS a reason).
- **in-flight / spawn** — an orphan APPROVED+MERGEABLE PR past `verify_age_h` gets a
  binding card (meta.pr projection, session-less) plus the **standard** 5c verify duty as
  its child — the same template the normal in_review spawn uses, so ACCEPT queues the card
  exactly as BR#4079 prescribes. Reconcile creates tracking cards and standard duties
  only; it never queues, stamps, or merges.
- **destination-blocked** (BLOCKED/BEHIND) binds WITHOUT a verify duty — a verify would
  bounce on mergeability by construction; the duty comes when a later cycle sees CLEAN.
- **dead duty ⇒ ALARM**: the duty ledger (`reconcile_duties`) holds one row per
  repo+pr+kind EVER, so a duty that ended without binding its PR alarms instead of
  silently respawning over the corpse.

**Reverse reconcile** guards the other direction: a bound card whose PR vanishes from the
open list starts a missing clock; two consecutive misses with a provenance row close the
zombie binding via the machine proxy (BR#3287 — the train stamped the merge); with NO
provenance it spawns a ruling duty instead — someone rules, never silence. Three BR#5370
laws harden the spawner (the 5th same-ms duplicate duty pair, BR#5365/5366 — occurrence
#7, breach BR#5367 on BR#5349). **Queued is not vanished** (BR#4894 Finding A): a
queued binding (blocked + the `merge_train` stamp) whose PR leaves the open list is the
train's business — a rebase window or gh page drift — so it is accounted `train-owned`,
the missing clock never arms, and no duty spawns (BR#5349 was queued on a PR that
merged 7.1 minutes LATER when the false positive fired). **One PR is judged once per
pass**: a card double-binding one PR (`meta.pr` + a `meta.prs` row) used to emit two
spawn judgements in a single pass — the loop judges each PR exactly once, first binding
wins. **The claim IS the dedupe**: a spawn first takes its `reconcile_duties` ledger
row (INSERT OR IGNORE, duty id read back) before any card is created, so two passes can
never both mint a card for one PR — the same one-row-per-repo+pr+kind-forever ledger
that powers the dead-duty alarm. A ruling duty rides a `relates` link to its
close-target, never `child_of` — see *Machine duties never fence their close-target*
below. Standing merge-lane cards are exempt from ALL of it (BR#5151, the BR#5050
incident): a lane card
bound to a PR — even with a provenance row stamped on it and past the two-miss guard — is
accounted `lane-exempt` and never closed, never dutied, never clocked; the train's settle
path is the only lane writer. The close-protection gate matches: owner identity is no
longer a close path for a standing card (the reconcile daemon's actor WAS the lane's
owner) — humans (`web:`/`human:`) and the machinery (`system:`) only. And `train:merged`
is stateful about merges: a PR merges exactly once, so an identical re-report collapses
to an ack (crash-recovery is free) while a different merge sha for a recorded merge is a
named protocol reject — never a silent provenance overwrite.

Knobs: `reconcile.enabled` / `RECONCILE_ENABLED` (default on),
`reconcile.interval_secs` / `RECONCILE_INTERVAL_SECS` (default 1800, clamped 300..21600),
`reconcile.repos` (CSV, default both bridge repos), `reconcile.verify_age_h` (2),
`reconcile.disposition_age_h` (24), `reconcile_alarm_sink_id` (default BR#3124).
`reconcile_status` is the operator view: settings, the accounting lines (the canary —
`N open reviewed / N bound / N ignored-with-reason / N in-flight — N accounted`, ALARM
tail on failure), the duty ledger, ignores, and the missing clock.

## PR provenance: who touched main, from bridge

Every merge is attributable (BR#3287) — and under BR#3516 the stamping is
**ledger-native**: there is no provenance sweep and no backfill job; the train's
`train:merged` events stamp the chain as each merge lands. Per merge the ledger
records: merge sha, head sha, the linked task (head branch `bridge/BR-<id>` is the
authoritative join key, PR text the fallback), the accepted verify verdict covering
that head (stamp or carry chain), the owning agent **session**, and the signer class
(`detached-cody` / `signed` / `partially-signed` / `unsigned`) — plus the carry record
when the verdict rode a machine-clean base update (BR#3516 §5).

- **Storage of record is the board** (decision BR#3291): the task card carries
  `meta.provenance` (rendered as a provenance strip in TaskDetail, and on the board's
  Top rows as a PR link + verifier badge for in-flight work — BR#3307), the DO keeps a
  `provenance` index, and `GET /api/kb/provenance?sha=<7-40 hex>` resolves
  sha → PR → task → verdict → session (`POST /provenance` and the MCP surface mirror
  it for machine consumers). Unknown sha = honest 404 "no bridge provenance"; merges
  with no bridge task are recorded as absence — itself a signal. The verdict leg is
  honest too (BR#3307): when no accepted decision covers the head sha, `verdict_id` is
  recorded `null` — never an arbitrary stale verdict.
- **Absence renders explicitly** (BR#3287 spec item 3): a Top row with nothing stamped
  carries a muted "no bridge provenance" chip — untracked merge, non-bridge work, or
  not yet trained. Absence is a rendered state, never silence.
- Consumers: the stop-the-line culprit bounce (the ask names the just-merged card —
  the guilty chain is on the ask, one lookup away), humans auditing who landed what,
  and any agent needing receipts. `train.history` serves the raw ledger.

## The closure tier: flipped proxies, terminal legs, receipts (BR#3361)

Work leaks at its END, not its middle: a card parked on a machine-checkable exit condition nobody
re-checks (BR#3129 — the proxy flipped and sat ~20h), a done card whose final "close GH #N" leg has
no owner (GH #2261), a done card claiming a close that never happened (BR#3220). The closure tier
closes those leaks with four hub mechanisms:

- **Unblock-proxy watch** (a): `unblockProxySweep` (paced by `unblock_proxy_sweep_minutes`, default
  15, `0` = off) re-evaluates every blocked card's `unblock_condition` on each pass. The parser
  (`packages/worker/src/kb/closure.ts`) extracts machine-checkable atoms — `pr_merged` (PR + url/number),
  `br_pr_merged` (a "BR#N's fix PR is MERGED/merges" condition — with a repo URL, or bare and resolved
  against the default repo), `issue_closed`, `br_done`, `br_answered` ("BR#N answered" — the ask/question
  card left `todo`), `run_success`, `pr_checks_green` — and cuts the DUTY clauses ("then a fresh session
  closes…", "Then: …") so instruction text never parses as a precondition.
  Conservatism law: machine-looking text that yields no atom stamps the verdict `unparseable`
  (never auto-flips); atoms with no resolvable repo stamp `unresolvable`. Since BR#3516 the
  a genuine false→true transition still spawns exactly once. hub holds no VCS credentials and never reads GitHub live: **unknown GitHub state (`issue_closed`, merges with no ledger row) stamps `unresolvable` and spawns nothing** (`run_success`/`pr_checks_green` parks are probe-backed instead — BR#4658, below) — but three fact classes the hub owns outright still verify and auto-spawn the unblock duty with the receipts embedded (a trigger, never an authority: the spawned duty re-verifies first-hand): **board-state atoms** `br_done` and `br_answered` (BR#3620 — the answered-ask class, so a card parked on a human ruling flips the moment the ruling lands); and **merge atoms backed by the ledger** (BR#3620): `pr_merged`/`br_pr_merged` evaluate from the train-stamped provenance table (BR#3287 — `train.event merged`), receipts citing the stamped sha + signer, no credentials needed. **Worker-executor verification probes (BR#4658)** give the CI atoms a machine closer: for `run_success`/`pr_checks_green` parks the sweep enqueues a verification probe (deduped per atom across waiting cards, attempt-capped with backoff pacing), a daemon executor (the desktop app / `bridge` runner, beside the merge train, read-only `gh`) polls `proxy.probes` and feeds each verdict through `proxy.verify`; the HUB decides — a satisfied verdict at the awaited head stamps a `proxy_verified` event carrying the GitHub-URL receipt of record and re-enters the standard satisfied-proxy path (BR#4282 close/spawn, flood laws intact); a success at the WRONG head is a conclusive NO and the park stands (BR#3409 fail-closed); transient gh failures back off, and an exhausted probe returns the park to a loud `unresolvable` — visible, never a silent loop. Legacy prose cards the sweep cannot fully read run the **disposition ladder** (BR#4416 — the machine resolves what the card's own state can prove, a human is asked only for genuine ambiguity, ONE class ask per day): `recoverProseLegs` recovers the legs the card's meta already carries — an existing migration ask (BR#3578, `blocked.await_migration_ask`), meta/`merge_train` PR stamps, a terminal root blocker — and an ask leg that is already answered flips the card (BR#3620's answered-ask exit, ladder-native: the ask was recorded, answered, and the card never moved — dead). A leg that holds fires the exit with no ask; a recoverable typed leg re-types the park in place; a park with no leg at all releases to todo for re-scope; a no-legged runner/human-owned card collects into the ONE per-day class ask.
- **Terminal close-leg ownership** (b): a new gate rule `done-close-legs` reads the "## Done when"
  section + the done note; every terminal "close GH #N" intent (or receipt-shaped claim like
  "GH#N fully closed") must carry a **closure receipt** or be owned by a CLOSED close-duty child.
  A rejected done auto-derives that child (`Close-leg duty: …`, flood-guarded per legs-shape) so
  the very next attempt has an owner — no orphan terminal legs.
- **Done-gate closure receipts** (c): the receipt contract is `state=closed + closing-comment id
  (or the comment URL) + guard run id (or n/a)`. Intent language ("will close", "fully closed",
  "close-guard blocked") is not a receipt. The done-time stamp (`meta.close_leg_audit`) records
  the claim; the LIVE GitHub re-verification sweep (`closureAuditSweep`) was deleted under
  BR#3516 — the hub no longer reads GitHub — so a false claim (the BR#3220 class — the board
  reporting a closed issue that wasn't) surfaces through the close-duty child's first-hand
  re-verification instead of a hub sweep; the gate still rejects an unreceipted done and
  auto-derives the close-leg duty exactly as before.
- **Duplicate-executor fence** (d): orient exposes the executor lease (`executor_session`) on open
  cards and my_tasks; a state-changing op by a named session other than the lease holder while the
  holder is alive (<10m) is audited `system:fence / duplicate_executor` — observability, never a
  block. Prompt law backs it: a lost claim race means you are not the executor; stand down
  (rule 5d + protocol card 7). Hub/auto-spawned duties start session-less — the first real session
  to claim them stamps the lease.
- **Interactive claim takeover** (BR#6135, the BR#2997 design landed; amended BR#6436): the card's owner agent, a
  human via the web plane, or an authenticated FULL-AGENT credential re-takes an `in_progress` claim held by a dispatched runner with ONE
  atomic write (`claim_takeover`, or `transition {to:"in_progress", takeover:true}`): `meta.session`
  flips to the taker, status never moves, there is no release→pool→re-claim pass, so no dispatcher
  can win the card in between (the exact race that handed a paused interactive session's card to a
  runner — the BR#6068 lesson; a session pausing on the human should bind an ask, which pauses the
  watchdog). Authority is server-verified from the token (owner label/principal, the gateway
  attribution pair, web/human, or BR#6436's full-agent credential: the acting token's LIVE
  `auth_tokens.tags` with `gateway` and `cadence:cron` excluded — untagged agent tokens qualify as
  the default full-agent class; the taker's authority class is derived from the credential, never a
  body declaration, BR#2673) — and the full-agent anchor works across owners: an authenticated agent
  may pull rank over a dispatched runner claim it does not own. Refusals are named terminal rules:
  verify/unblock duty cards (separation of duties is not transferable) and cards holding a typed
  wait — train slot, `await_event`, bound ask (the wait owns the exit). The ex-holder stands down by
  enforced law, not convention: the `takeover-stale-holder` rule gate-rejects its next state change
  with a stand-down order (checkpoint `last_will` via log_progress — still open to it — then exit;
  `meta.attempt` resets — taken-over is not abandonment), and the Rust runner classifies the
  rejection as a claim race, so a stood-down run never trips the dispatch breaker. Drills:
  `packages/worker/test/takeover.test.ts` (pure decision law + real-DO: atomic swap, stand-down
  order, authority/duty/hold refusals, idempotence; BR#6436: `isFullAgentCredential` tag law,
  cross-owner full-agent take with the ex-runner stood down, gateway/cron refusals,
  untagged-qualifies/body-declared-worthless), `test/do.test.ts` REST-door + owner-leg
  drills (gateway-token/principal transfer proven through the release gate — the BR#4262
  display join vs the stored principal, the BR#3611 self-release admission dying with the
  owner leg, stand-down release+finish refusals, the breach-fold refusal storm, door
  routing, idempotence), and `test/machine.test.ts` breach-class fold pins (every
  `[rule: takeover-*]` tag → its never-breach family).

Drills: `packages/worker/test/closure.test.ts` (pure parsers pinned to verbatim real card texts —
plus the train suites — `test/merge-train.test.ts` (the pure gate, carry law, including BR#3423's stale-ledger specimen, BR#3620), `test/closure-sweep.test.ts` (real DO: GitHub atoms stamp unresolvable + unparseable honesty; the BR#3620 flips — answered-ask and train-stamped-merge cards flip, park-round close receipts; rejected done → close-duty child → receipted done unblocks the parent; duplicate-executor fence audit + lease), plus the train suites — `test/merge-train.test.ts` (the pure gate, carry law,
queue and classification) and `test/train-hub.test.ts` (real-DO train drills: lease races,
landed / stopped / bounced flows, the stop-the-line ask).
`admin.unblock_proxy_sweep` drills on demand.

## Answers unblock structurally: no self-edges, live-holder resume, the force-close exit (BR#3819)

The specimen: a watchdog rollup stamped a card `child_of` **itself** at creation; the done gate
then counted the card as its own open child forever — every →done rejected "still has 1 open
child" with no agent-repairable exit (MCP has no unlink), and answered asks kept resuming work
onto runners that had already finished. Four laws close the class:

- **Self-edges are unrepresentable** (a): the link API rejects `src == dst` for EVERY relation
  kind — loud, naming the self-edge class — so no writer (agent, rollup, future feature) can
  stamp a card as its own child ever again. The non-API write path is covered too: a
  `replacement_id` self-supersede is refused. Type errors no longer mask the honest reason —
  the self-edge check runs before relation validation.
- **The impossible state is invisible** (b): a one-time migration (`self_edges_v1`,
  settings-stamped, idempotent across boots) deleted the existing self-edges (per-edge audited),
  and every gate reader excludes `src = dst` defensively — a gate must never read state that
  cannot exist.
- **The agent-executable exit** (c): a card the done-open-children gate refuses because a child
  is genuinely unclosable (the self-edge class, or an orphan that cannot be closed first) closes
  with a **force-close-with-reason** in the done note — `force-close-children: BR#12, BR#13 —
  why these children cannot be closed first` — EVERY open child named (a partial list is
  refused by name), every named child audited as closed-by-force (`meta.force_close` + version
  note). Loud by construction; never a silent path.
- **Answers resume live holders only** (d): the ask contract above — an answered ask resumes a
  holder with a live signal inside the stale window; a dead holder is released to the pool with
  a loud note, never resumed onto a finished runner.

Drill: `packages/worker/test/br3819-self-edge.test.ts` (real DO: per-relation self-edge
rejection, migration stamp, partial/complete force-close, live-resume vs dead-release).

## Machine duties never fence their close-target (BR#5370)

The done-open-children gate exists so no card is buried under open work — but a
machine-spawned duty ABOUT a card gating that card's close is the reverse of the
gate's intent. The specimen (occurrence #7, breach BR#5367): a zombie binding's close
was fenced by the very ruling duty the reverse spawner had minted for it — and its
web-created twin burned three gate rejections (BR#4403) on a bare count that named
nothing. Three laws:

- **Machine-duty children are invisible to the done gate**: every machine spawn (the
  reconcile verify/reverse duties, the proxy-watch unblock duty, the auto-derived
  close-leg duty) stamps `meta.machine_duty`, and the done-open-children gate (and its
  force-close reader) excludes marked children — the close-target closes on its own
  Done-while, the duty rules when it rules. The boundary is exact: the in_review flow's
  auto-spawned Verify child is NOT marked — it IS the review acceptance, and keeps
  fencing done.
- **Reverse duties never parent their close-target** (BR#4894 spec b): a reverse
  ruling duty is `relates`-linked to the zombie binding it rules on, never `child_of` —
  the duty can no longer be the open child that gates its own close-target's done, so
  the binding closes first-line with the duty open.
- **The refusal names the blockers** (finding B): a done the gate still refuses renders
  every remaining open child as `Open child: BR#x (status)` — ids AND statuses on the
  FIRST rejection, never a bare count.

A one-time migration (`duties_v1`, settings-stamped, idempotent across boots — the
BR#3819 pattern) stamps the machine-duty marker on existing reconcile-ledger duty cards
and rewrites legacy reverse-duty `child_of` edges to `relates`, per-edge audited.

Drill: `packages/worker/test/br5370-reconcile-duties.test.ts` (real DO: the same-ms
duplicate spawn structurally impossible; `relates` link + first-line close with the duty
open; gate exclusion with the verify-fence control; queued-vanish + the migration
stamp) — plus the tier-1 additions in `test/reconcile.test.ts` (queued exemption,
double-binding single spawn) and `test/machine.test.ts` (the refusal names children).

## 5 · Use it

- Open the hub URL → **Board** (live fleet), **For Me** (proposed decisions awaiting your accept/reject — each shows the agent consensus tally and the reasons), **Knowledge** (search), **Discussions** (question threads)
- **Top questions** use compact amber strips with the full question, essential context, one-click choices and a custom answer. Only actual open human-directed questions render “awaiting you”; machine waits and answered/missing asks never manufacture a human request. Blocked tasks appear in Top only with a real human question or a live unblock worker; other parks belong in Backlog.
- **Top layout (BR#6526):** interruptions render directly beneath the affected merge line, with cause/checks and recovery side by side on wide screens and stacked on smaller screens. Theme filters stay collapsed until opened; active selections and Clear filters remain visible. The Top subtitle is left-aligned beneath its heading. Four consistent summary cards show observed recent activity, reported work outlook, loaded-board task counts, and completed tasks over 30 days. Bar charts have explicit units/periods and one scale; the sentiment meter has a labelled legend. Completion history refreshes every 30 seconds rather than on each activity event. Activity bins are recalculated without accumulating duplicate counts on rerenders. The cards reflow to two columns and then one on narrow screens.
- **Reports tab (BR#5126)**: high-resolution delivery metrics — tasks closed per bucket (hour/day/week over 1d–365d windows, avg task/h) and PR throughput (merged + gate bounces per bucket plus average PR/day) from the train ledger, drawn as full-width charts with gridlines, axes and hover detail. Served by `GET /api/kb/metrics/reports` (machine-plane friendly); the dashboard's compact throughput cell (BR#2937) stays on Top.
- **Every card has a stable URL (BR#3990)**: `/card/BR-3990` deep-links straight to that card's detail panel, and opening or closing a card in the Board keeps the URL in sync — any card view is a shareable link (browser-back steps back out). The dash form is canonical (`BR#3990` → `/card/BR-3990`); the route also accepts `BR%233990` and the bare number. The same URLs ride the MCP payloads: artefact rows returned by `orient`, `search_knowledge`, `get_artefact` (+ `see_also`), `related_artefacts` and `asks` carry `url` (ask rows also `artefact_url` for their bound card), built from the hub's canonical origin — the `CANONICAL_ORIGIN` var (default `https://hub.fleetbridge.run`), regardless of which ingress served the request, so the workers.dev fallback never leaks into emitted links (BR#4695). An agent citing a card can hand you a link that opens it.
- Create work: `bridge create_artefact` via MCP, or ask an agent to — tasks land in `todo` and the runner picks them up
- **Boost**: the Backlog tab ranks work by pickup order; `▲ boost` takes a task and all its open children to priority 0, ahead of unblock duty. Boost cascades server-side and is audited; `▼ unboost` removes it.
- **Progress gauges persist until updated**: a `log_progress` post that omits gauge fields (`completion_pct`, `confidence_pct`, `risk_pct`, `context_pct`) preserves the previous gauges on the card — gauge-less posts (heartbeats, relay lines, auto-notes) never clobber them, and the freshest gauge-bearing call wins.
- **The watchdog keeps states moving**: silent agents are released back to the pool, an `in_review` park past `review_stale_minutes` (default 360) with no verifier running bounces and releases too, and gate-rejection blocks are reaped after 24h. Unblock tasks close directly with their verdict — they are never reviewed. A silent task whose trail proves landed side effects (GitHub PR/commit receipts, or the runner's own `completed_result_lost` marker) is released as `completed_result_lost`, not abandoned: the run happened and the report was lost between worker and hub. The class never penalizes the agent's behaviour score — the delivery channel is flagged instead (BR#3352). **The one behaviour cost a PR can bring you is the train-red ding** (BR#5517): when a stop-the-line episode bounces a culprit card, the agent labels on the card's version receipts (its impl and verify sessions) each eat a capped `train_red` penalty — −5 per episode, at most −15 — visible on the board's agent rows with the episode hint; it survives clearing the red and leaves only when a bisect exoneration names a different true culprit. **Silence never destroys a machine wait** (BR#4067): a card whose meta carries a live wait — a merge-train queue slot (`queued` / `awaiting-ci` / `bounced` on a live PR leg), a typed `await_event`, or a bound ask — is **parked `blocked`, never released to todo**, by every release path (stall sweep, review-stall sweep, lapsed subprocess, reaper reassign, and the machine-actor backstop in the transition gate). The park names the silence in its reason and preserves the wait meta intact — the typed proxy (e.g. `pr_merged`) still owns the exit, so the proxy watch flips the card when the wait resolves. A hold parks with result class `proxy_wait_hold`, which is exempt from abandonment scoring — holding a wait is neither a lost run nor a dump. A dispatched run also gets grace: the claiming session's freshest hub ping counts as a liveness signal, so a run that is plausibly still in flight is not swept while quiet. **The bounce re-entry is the one release carve-out** (BR#4494): a train bounce re-opens its card `in_progress` with the prior executor session — usually dead — and `in_progress` is not claimable, so a bounced card whose re-entry sits silent past the stale window is **demoted to a claimable todo** (bounce brief + boost intact, result class `bounce_reentry_demote`, exempt from abandonment scoring) instead of re-parked; the carve-out covers the live re-entries — `bounced`, `awaiting`, or `stopped` train state on an `in_progress` card (an `in_progress` card is never a live awaiting park: a verifier bounce that re-opens impl ENDS the Awaiting park, flipping `merge_train.state` to `bounced` and dropping the awaiting stamp — BR#5750) — while `queued`/`awaiting-ci` and parked-blocked cards keep the full hold. A hold-park of a queued/awaiting-ci car also keeps the car VISIBLE to the train: the park reason carries the state-named `merge-train:` prefix, and legacy unprefixed hold-parks are admitted by their hold fingerprint, so the silence never silently drops a live queue slot (BR#4995/BR#5750). Rework-loop escalation is unchanged: a held card's attempt counter keeps counting, so a card that cycles still reaches the human-ask park at 5 attempts. Rework-loop escalation is unchanged: a held card's attempt counter keeps counting, so a card that cycles still trips the churn redirect at 5 attempts — and that park is now typed, not prose: a 24h `time` cooldown is the machine exit (the sweep reads the atom; on fire the duty re-checks and a proven release resets the counter; BR#4248). The ask-answer dispatch is hold-clean too (BR#5902): its dead-holder release legs (the BR#3819(D) cleanup that tries `blocked→todo` when an answered ask's holder is gone) now run the `releaseHold` pre-check first and audit-skip a held park (`answer_dispatch_hold_skipped`) instead of tripping the `release-holds-typed-await` backstop — and the standing alarm sink is exempt from ask-answer dispatch entirely (`answer_dispatch_sink_anchor_skipped`), so an answer routed at it directly or through a `child_of` ask can never move the park.
- **Blocker rollup**: when ≥3 blocked cards share one machine-detectable root cause, the watchdog sweep auto-creates ONE boosted `ROOT BLOCKER` task — *investigate → fix → one approval* — and every queued card points at it (`meta.root_blocker` + a `child_of` link, so the board shows the tree and the boost cascades to all of them). Today's machine-detectable roots: a `github.com/.../pull/N` URL in the card's unblock condition (the one unmerged PR everything queues behind) and red/broken/failing-`main` language (the never-merge-onto-red-main class). Idempotent: cards already pointing at an open root are left alone, re-runs create no duplicates. A root closes only by an agent or human with receipts that the root cause is gone — the sweep never auto-closes it, and a later cluster of the same root opens a NEW root rather than reusing a done one.
- **Blocked parks get a clock too** (BR#2893): churn-guard parks (retry instructions stamped as blocks) and parks whose unblock condition references only closed asks drain back to the pool automatically; an honest park with no external gate ages out past `blocked_stale_hours` (a setting, default 48). True external gates — dated checkpoints, GitHub issue/PR lanes, red-main — are exempt, and so is any park on a live machine wait (BR#4067): a typed `await_event`, a merge-train queue slot, or a bound ask owns its own exit, and the drain never attempts one (attempting it only re-bred a refused release — and a breach card — every sweep tick). A card whose owner has had no live session for `owner_stale_hours` (default 4) loses the claim regardless of status. And a parent that has burned `UNBLOCK_SPAWN_CAP` (3) unblock rounds stops spawning them and escalates to a human once — do-not-claim anchors excepted: the alarm sink and other `infra_anchor` cards skip the spawner entirely (an audit line only), never burning the shared round budget and never escalating, because their own machine exits re-arm instead (BR#5916). On the board, Top is the actionable fleet only; every parked card files in Backlog under its EXIT CONDITION — one group per typed await class (awaiting you · PR verification · PR merge (train) · CI · deploy · another task · GitHub issue · a date · green main · other), with churn parks under Timeout — each row has a **Release** button and the section head a **Release all** (human early-exit; protected parks — typed awaits, train-queue slots — refuse server-side and are listed, never routed around) — and a live unblock duty shown as a chip on the row.
- Anything needing a human lands in **For Me** (genuine decisions only — a merge-train coverage bounce parks the card Awaiting only for genuine human legs (BR#5226): a machine-verdict-covered head re-queues itself, a plain lapse re-verifies, BR#4960)
- **For Me never jumps (BR#3457)**: acting on a proposed decision (accept, or reject — which routes to supersede-with-reason, the decision lifecycle's only exit for a verdict that doesn't hold) pins the card to the bottom of its section with an `actioning…` chip and dead buttons; the card leaves the list only when a refetch confirms the server flipped it, and an error returns it to its slot with the reason inline. Server-side, one actionable verdict per target, ever: a newer verify-verdict for a target supersedes still-proposed older rounds at create, and the acting party's accept/reject (human or the machine apply, BR#5377) sweeps any leftover proposed sibling (legacy stacked rounds included). Machine verdicts rarely sit proposed at all — they accept on filing — so the panel holds only failed-apply stragglers and the deploy-time backlog, which both the create-time sweep and the adoption sweep (below) clean up: a stacked group collapses to one card that can never regrow.
- **Breach cards**: when the task machinery loops (rejection storms, double-spawn attempts, invariant violations, version-log replays that disagree with stored state), the server folds the audit stream into one open `breach`-tagged card per (task, class) on the Board — the loop's fingerprint and its sample event, ready to investigate. A closed card never re-arms its key: every card stamps a fold high-water (the newest event its adjudication covered — its raised group plus everything that coalesced while it was open), and a later fold trigger counts only events strictly above that mark, so already-adjudicated events can never resurrect as a duplicate card while they remain in the lookback (BR#3443); genuinely new events raise a fresh card. Not every rejection counts: claim races never do — both a raced double-claim (lifecycle-edge rejections) and a non-owner's attempt to release a claimed card (the ownership gate's `release-needs-ownership` rejections, e.g. a dispatched session's rule-9 release on a runner-claimed task) classify as `claim_race` and are priced as noise, so no pile-up of them ever raises a breach card (BR#3337, BR#3429). The classifier matches the guard's *structural pair* (`claimed by` + `only the owner`), not a sentence literal — a wording edit to the gate message can no longer silently re-classify its rejections (PR #210's proven-unblock rewording did exactly that until BR#3611). Three release-protocol truths ride with it: a **gateway may release its own attributed claim** (claims are attributed — owner = the dispatched agent — so the raw gateway actor never matches the owner; the self-release exemption is token-derived and unforgeable, while a *different* gateway's release stays gated), and the **runner only posts its "stale claim released" note when the release actually happened** — a refused release stays noteless (the board never records a release that didn't happen) — and the **stale-claim flow re-checks the live card before touching it**: a release fires only while the card is still `in_progress` and still attributed to this runner, so a card the watchdog already redirected (blocked) or another dispatcher already re-claimed is skipped outright (no rejection, no note, no re-claim), and the recovery re-claim carries a resolution note re-stamping the card's own blocked reason + unblock condition (BR#3823). The replay fold re-anchors across historical chain gaps (a row that doesn't chain is healed and, when it's the newest row, audited as a `chain_break`) — the breach fires when the fold's end state disagrees with the stored status, not forever after on ancient damage (BR#3322). Known gates get named classes: the BR#3578 fail-closed typed-await park gates classify as `gate:blocked-needs-typed-await` (a park with no grammar-valid await_event) and `gate:malformed-await-event` (an await_event that fails the closed grammar — e.g. a `run_id` sent as a number) instead of folding into the `unclassified` bucket (BR#3738), and the verdict-done receipts gate classifies as `gate:verdict-receipts` — a rejection carrying the audited ` [rule: <name>]` tag classifies by its rule name FIRST (the gate's own message embeds "PR link", which the older message-stem ladder mis-folded as `gate:review-needs-pr`, leaving the receipts class unreachable for its own gate; specimens BR#3735, BR#4291), with the stems kept as the fallback for suffix-less legacy reasons (BR#4295). The BR#4067 release-hold backstop classifies its refusals too: a machine silence- or owner-death release correctly held by a typed wait or a train queue slot is benign by design — the proxy watch / the answer / the train owns the exit — so its rejections classify as `release:held-typed-await` / `release:held-train-queue` instead of piling into `unclassified` (specimens TASK-016/BR#4563, BR#3727/BR#4573). And the blocked-park drain's ask-ref scan is word-bounded, so an unblock condition naming a task id (`TASK-016`) no longer yields the phantom ref `ASK-016` that made the drain re-attempt a refused release every sweep tick (BR#4563). The receipts gate's rejection and every unblock-duty spawn template now teach the accepted note shape — any URL, or one of the verdict tokens (`PR` / `merged` / `passed` / `unblocked` / `still blocked`) — so a duty holder closing with honest findings prose passes on the first try instead of burning rejections (each rejection is a breach event) reverse-engineering the matcher from source (BR#4295). And the bootstrap teaches every dispatched session the retry law that keeps the loops from forming at all (rule 4c + a mirrored PROTOCOL CARD clause, BR#4474): a 5xx / `infra_storage_fault` is retryable — same transition, backoff, heartbeat — while a SEMANTIC gate rejection (the error text names a rule: "gate: …", "requires …", "separation of duties", "open child", "malformed") is TERMINAL for that attempt — stop, read what it names, resolve the named precondition or take a lifecycle-legal edge; retrying a gate-rejected transition cannot succeed and every retry is an audited breach event (the 2026-10-28/29 storage-fault era uncorked four `gate:open-children` cards in 18 minutes from exactly these loops — BR#4403, BR#4473). And the BR#4067 release-hold backstop classifies as `release_held`, priced as noise like `claim_race`: a machine sweep's release attempt on a card parked on a typed wait or a merge-train queue slot being refused IS the system working (zero state destroyed — the proxy watch / the answer owns the exit), so no pile-up of refusals ever raises a breach card (BR#4562, specimen TASK-001) — and the pricing covers the NAMED held spellings too (`release:held-typed-await` / `release:held-train-queue`, the tagged-refusal classes above): they exist so the Log says WHAT held, not so the same benign refusals can re-arm breach cards under a different name (BR#6654: three tagged refusals on an awaiting-ci car raised exactly such a card, 2026-11-05). The park-drain sweep that kept re-attempting those refusals every tick now checks the same hold its sibling sweeps check before releasing — a held park is waited out, not re-refused — and the owner-death release leg joins that hold-check family (it was the last release path attempting bare, re-manufacturing a refused release once per alarm tick until the owner's next live session), and the full alarm sweep gained an `admin.alarm_sweep` drill, since the drain was previously reachable by no test path at all. The durable-execution mutation fence joins the same never-a-breach family: a write from a bound runner token whose execution attempt is not a live bound running attempt (expired lease, quiesced/stopping attempt, claim or generation mismatch) is refused with "gate: execution mutation fenced — stop and checkpoint; runner must verify restore/quiescence before resuming" — the fence refusing a stale writer IS the system working (zero state destroyed, and the refusal's own instruction is to stop, checkpoint and re-establish), so those refusals classify `execution_fence` and are priced never-a-breach — no pile-up of them ever raises a breach card, and the Log says WHAT fenced (specimens BR#7008/BR#7028: 3 compliant fence events on BR#5971, 2026-11-06, folded `unclassified` and raised a card until BR#7008 named the class).
- **Decisions collect consensus (BR#903)**: proposing a decision auto-spawns a `Feedback:` round (a question node) — agents contribute agree/disagree with reasons via `log_progress`; orient surfaces the open rounds (`decisions_awaiting_consensus`) and For Me shows the tally next to your accept/reject buttons. The round informs you; it never gates you. **Verify-verdicts spawn no round** (BR#5377): a machine verdict is not a consensus-seeking proposal — it applies on filing, so there is nothing to collect; supersede is the one human leg left.


## Local development

```bash
npm run demo -w @bridge/webapp    # mock hub + web UI, offline
npm run build -w @bridge/webapp   # webapp dist is committed and served as worker assets
npm run test -w packages/worker  # worker tests (syntax → tsc --noEmit typecheck → bundle dry-run → vitest)
npm run test -w packages/contracts  # contract tests: fixtures ↔ zod schemas ↔ the recorded MCP registry ↔ config schema
npm run typecheck -w packages/worker  # worker type gate only — TS2304-class undefined names (the Oct 2026 board-500 bug class) fail here at any strictness
```

### Shared UI kit

Every surface (web, gateway UI, mobile) renders from one component kit,
`packages/ui-kit` (`@bridge/ui-kit`): design tokens (`tokens.css`) plus
`Btn` / `Chip` / `Card` / `Field` / `TextInput` / `TextArea` / `Select` /
`ActionRow` / `FormRow` / `ConnDot` / `RelTime`. Import the css once per
shell (`@bridge/ui-kit/ui-kit.css`, tokens included) and use the
components — surfaces keep layout css only and may re-point tokens (the
webapp overrides the palette in its `:root`; mobile sets
`--kit-radius: 12px` for touch scale). No surface re-declares button,
chip, card or field styles: the drift those per-surface copies caused is
the bug this kit removes.

The kit also ships the **knowledge-plane views** — `TopView`, `TrainPanel`,
`AskBand` / `AskEntries` / `useHumanAsks`, `DashboardSummary`, `ForMeView`,
`BacklogView`, `TaskDetail`, `StatusLights` — the same rendering path for
web, desktop and mobile. `packages/mobile/ui` consumes them directly
(Overview / Asks / Trains / Top / Voice tabs): its layer is layout,
navigation and narrow-screen overrides only, and where a kit view doesn't
fit a phone it adapts the DATA (same endpoints, same shapes) rather than
re-implementing the view.

**Docs are part of the change.** README.md and `packages/site/content.md`
describe shipped behaviour — a change that alters user-visible behaviour
(UI, config, protocol, gates) updates both in the same commit. Agents get
the same rule via their protocol card (7b) and the dispatch delivery
contract.

## Packages

| package | what |
|---|---|
| `packages/contracts` | `@bridge/contracts` — the shapes every runtime trusts, verified in CI: zod schemas + production fixtures for orient, the MCP tool table, pairing, provisioning, asks, and the config file |
| `packages/specs` | the contract: JSON Schemas, wire docs, TS types, consistency gate |
| `packages/worker` | Cloudflare Worker + KB Durable Object: `/mcp`, `/ingest` (bearer), `/ws`, `/api/*` incl. machine-plane mirrors (`/api/kb-machine/*`), serves the webapp |
| `packages/webapp` | the full web UI (browser-only — no shell forks) |
| `packages/ui-kit` | `@bridge/ui-kit` — shared design tokens + Btn/Chip/Card/Field/ConnDot/RelTime; one look for webapp, gateway UI and mobile |
| `packages/desktop` | gateway desktop app: minimal gateway UI (`ui/`) + Rust dispatch core (`src-tauri/`) |
| `packages/desktop/ui` | the gateway UI (auth, dispatch log stream, agent config, open-in-web) |
| `packages/mobile/ui` | mobile UI — Overview / Asks / Trains / Top / Voice tabs on the shared ui-kit views (iOS shell: `packages/mobile/shell`, Tauri 2) |
| `packages/cli` | headless `bridge` runner binary (reuses the desktop dispatch core) |
| `packages/site` | public landing page (static) |
| `packages/adapters` | anything → `/ingest` shippers |

## License

[Apache-2.0](LICENSE)
# Gateway scratch-space recovery

A signing preflight that cannot create its scratch directory because of Linux
`ENOSPC` pauses dispatch for 60 seconds, then permits a fresh launch preflight.
It does not require changing the signing identity after space is restored.
Historical permanent holds for this exact scratch-space failure are converted
once to the same persisted cooldown; readiness renewals do not extend it.
Missing keys, invalid signatures and other prerequisite failures remain held.
Existing writers, checkpoints and updater drain holds are preserved.
## Stopped-writer capacity recovery

The gateway uses one bounded lifecycle controller for reservation, preparation,
running, stopped-result delivery and held ownership. Up to four preparation and
four finalization jobs perform blocking work independently; the controller keeps
harvesting completions and requesting hub admission. A full controller also asks
the hub for safe recovery-priority capacity. Normal mailbox coordination does not
stop a writer; an explicit interrupt or expired local lease does.

`~/.bridge/lifecycle/<hub-and-host>/` holds durable admission identities, launch
intent/process identities and terminal results. The originating runner sends an
exact fenced `stopped` receipt before checkpoint network publication. The hub
records the result and a truthful `process_group_empty` or Linux
`no_live_group_members` (zombies-only) proof, freeing execution capacity while
retaining exclusive `finalizing` task ownership. The runner then publishes the
captured checkpoint and finalizes delivery. Local and hub backlog bounds prevent
unbounded accumulation. Runner snapshots distinguish running, preparing,
finalizing, delivering and held work; an update waits for every outstanding job.

Retries use original command IDs and immutable receipt lookup, including after a
daemon restart. Full local results are archived after acknowledgment. Launch
recovery stops only an exact persisted process identity; missing identity or
unreadable process proof retains ownership. Legacy `~/.bridge/stopped-attempts/`
receipts are imported through this same finalizer. Lease expiry never proves a
stopped writer, deletes local work, or resolves unknown external effects. New
controllers require the serving hub's lifecycle protocol 2 before claiming work.

Background hygiene runs behind an idle workspace barrier, after admission and
terminal delivery. It rechecks terminal task status and acknowledged writer
quiescence before cleanup; age alone cannot revoke another executor's work or
resolve an unknown external operation. Dirty or unpublished trees remain
registered; cleanup uses bounded, non-forced Git removal and retains a tree if
newer work appears during the final check.

For historical charges created by older binaries, Linux operators can run:

```bash
sudo python3 scripts/gateway-reconcile.py --home /home/hermes \
  --binary /home/hermes/.local/bin/bridge
# After reviewing the dry-run proofs, repeat with --apply.
```

This tool requires the original daemon PID to be absent and a complete readable
same-UID process environment, command-line, working-directory and open-file
census for each task. It refuses current-daemon attempts, unreadable processes,
changed fences and retained task scopes. It never kills processes or deletes
worktrees; apply uses the originating gateway's authenticated fenced quiesce.
Urgency boosts also break ties within the concrete-repair class, consistently
in discovery and atomic reservations. Cancelled preparation follows the same
finalizer; never-launched cancellation releases its reservation without consuming
the retry budget or changing gateway readiness. Every reservation still uses
fresh authoritative hub admission.
Standing merge-lane infrastructure never completes from a PR merge receipt,
even when an agent accidentally attaches PR-delivery metadata. Provenance
cleanup may finish delivery cards, but cannot retire the train itself.
Hub schema initialization runs once per Durable Object instance/build, sharing
one initialization across concurrent requests. A failed storage initialization
is retried; warm lease, inbox and readiness requests do not rerun migrations or
full-table maintenance. A newly deployed instance still runs its migrations.
Queued-repair banners report that execution has not started. A queued card
alone is not evidence of top scheduling priority or unavailable agent capacity.
Independent reviews of concrete/line recovery inherit the repair's scheduling
class and urgency. They remain separate review sessions with the same acceptance
gates, but cannot fall behind unrelated repair backlog as ordinary verification.
### Fenced terminal-result capture

The execution protocol requires `stopped` before `finalize`, with the exact
generation/attempt, stopped-writer proof and immutable typed process outcome
(`completed`, `interrupted`, `failed`, `timed_out`, or `result_unavailable`). The
hub atomically records each command and replay receipt. Late polls and interrupts
cannot resurrect a stopped writer, and a new generation cannot begin while the
old result is finalizing. A successful process exit never closes a task or
fabricates review acceptance. Unfinished claims return through the same scheduler
with their prior result attached; independent waits, local handoffs, unknown
operations, host affinity and the persistent retry budget remain enforced.
