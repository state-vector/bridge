# BR#6663 — Independent audit: runner startup affinity, failure scope and shared credential rollout

Auditor: fresh session `dispatch-BR-6663` (opencode-ray agent `detached-cody` signer), 2026-11-06.
Scope: signed direct-main fixes **f2aae10ad**, **d6e75e6a6**, **c09bc8922**, **562f39436**, plus follow-up
**bb3293dbf** (found on main during the audit and included because it closes a gap between two of the audited commits).

**This is a scoped audit.** It does NOT accept or complete BR#6625 or umbrella BR#6584, does NOT mark the
worker-ready-v2 rollout adopted, and does NOT mark either merge line recovered. Worker BR#6633's scoped
outcome review (2026-11-05 21:06 UTC) is noted as a receipt but does not prove the merge line recovered —
concurred; nothing in this audit changes that.

## 1. Mechanical state of the audited commits

| Commit | Subject | Signature | On origin/main | CI (first-hand) |
|---|---|---|---|---|
| f2aae10ad | require worker readiness before claims and recover failed starts | Good `git` ED25519 `SHA256:ofD6MVXz…RUwc` | yes | CI 42001349294 SUCCESS; dev-build 42001349294 SUCCESS |
| d6e75e6a6 | isolate rollout runner status files | Good `git` ED25519 same key | yes | dev-build 42002623136 SUCCESS |
| c09bc8922 | scope startup barriers and check checkpoint affinity before claims | Good `git` ED25519 same key | yes | CI 42109645913 SUCCESS (receipt in task body, re-verified 2026-11-06) |
| 562f39436 | share worker credentials across isolated runner reports | Good `git` ED25519 same key | yes | CI 42110118740 **SUCCESS** (pending at task creation; re-verified first-hand 2026-11-06) |
| bb3293dbf | use one readiness revision at preflight and launch | on main tip | yes | CI 42111020858 SUCCESS |

`git log --show-signature --no-walk` on all four audited commits: every signature Good. `git merge-base
--is-ancestor` confirms all are ancestors of origin/main.

## 2. Live serving hub commit (edge version alone is insufficient — proven)

The orient build string (`0.8.0`) is an edge version and proves nothing about the serving code. Two
independent first-hand proofs:

1. **Deploy drift alarm (the repo's own live-vs-push mechanism, `scripts/deploy-drift-alarm.sh`).** The hub
   deploys main via CF Workers Builds; on every main push CI probes the live hub's `__version` commit
   against the pushed SHA. CI run **42111020858** (push of bb3293dbf), job "Deploy drift alarm", printed at
   2026-11-05T21:19:00Z: `live hub matches the pushed SHA bb3293dbf ✓` — and bb3293dbf contains all four
   audited commits. The same job passed on the c09bc8922 (42109645913) and 562f39436 (42110118740) pushes.
2. **Live behavioural probe** (through the MCP execution protocol, `command_id: audit-availability-br6663-2`,
   2026-11-06): `availability` on BR#6663 returned the **new** response shape — per-host `readiness` objects
   (`{kind:"ready",worker_id,fingerprint}` / `{kind:"unprovisioned",reason}`) that only exist in f2aae10ad+ code.
   The `unprovisioned` reason string returned live for host `ip-172-31-1-230` — "Provision the gateway's
   canonical worker credential before claiming work" — exists only in the new `executorReadiness()`.
   Host `macbook-pro-local-2` returned `readiness.kind: "ready"`, worker `at_08184d7f`, label
   `macbook-pro-local-2/opencode` — a provisioned, gateway-owned, non-revoked, non-gateway-class worker
   credential is serving readiness **live**.

**Conclusion: the live hub serves bb3293dbf (main tip), which includes all four audited fixes, and the new
claim/readiness gates are demonstrably active — not merely published.**

## 3. Behaviour-by-behaviour findings

### 3.1 Canonical worker readiness enforced before claims — VERIFIED
- Hub: `executorReadiness()` (do.ts) requires `capabilities.worker.kind === "provisioned"`, label prefixed
  with the authenticated gateway's own label, a live non-revoked `auth_tokens` row for that label whose
  class is NOT gateway, and no matching `executor_start_barriers` block. The claim mutation gate rejects
  any gateway claim without `runner_protocol: "worker-ready-v2"`, a live (≤120 s) capability observation,
  and `readiness.kind === "ready"`. `begin` additionally requires the begin's `worker` to equal the
  advertised proven worker and clears the token's barrier only on success.
- Tests (real SQLite, `execution-hub.test.ts`): unprovisioned advertise → `ok:false`, availability
  `unavailable`, claim rejected `/worker|readiness/`; obsolete (protocol-less) GUI advertise cannot
  overwrite a corrected runner's readiness and cannot borrow it to claim.
- Live: readiness objects returned in the availability probe (§2).

### 3.2 Persisted prior-host/checkpoint affinity enforced BEFORE claim — VERIFIED
- c09bc8922 adds `executionSchedulingRequirements()`: claim-time and availability blockers derive from the
  **durable** execution state (not task metadata, which can predate the last execution), and an attempt
  without a checkpoint projects `host = attempt.host` into requirements. `capabilityBlockers` emits
  `host:<host>` and the claim gate rejects before any claim write. A quiescent-but-uncheckpointed prior
  writer also blocks reclaim directly ("previous executor writer not quiescent — preserve host affinity").
- The runner side (c09bc8922) additionally calls `availability` per candidate before claiming and skips
  unless its own host entry has empty blockers AND readiness ready — "never claim first".
- Test: after a quiesced un-checkpointed attempt on `affinity-original`, wiping `execution_requirements`
  metadata does not help a foreign host — availability reports `host:affinity-original` blocker and the
  foreign claim transition is rejected `/host:affinity-original/`, task stays todo.

### 3.3 Never-launched atomic release / replay / authority — VERIFIED
- **Authority:** `executor_start_claims(task_id, token_id, session)` is inserted in the SAME
  `transactionSync` as the claim transition. `start_failed`/`recover_unstarted` are accepted only from the
  gateway holding that row with the matching session (or the task's principal-owner); a forged foreign
  gateway call is rejected on authority (test: `spoof` → `/authority|authenticated runner/`).
- **Replay:** exact authenticated replay survives owner clear — the stored command result is returned only
  for a byte-identical `{command, session, actor}`; `command_id` reuse with different input is a gate error
  (test: second identical `safe-release` returns `released` again without re-executing).
- **Never-launched discipline:** the runner sends `start_failed` only from paths where no child was ever
  spawned (inspect/begin/malformed/pre-spawn renew), and only quiesces an attempt it can prove is its own
  (expected `attempt_id` + host + session all match; otherwise "prior writer is not this never-launched
  attempt; retain claim/WIP"). The hub holds release while the attempt is unquiesced or while any external
  operation is `prepared`/`outcome_unknown`. Release is one atomic transaction (barrier upsert + task →
  todo + execution state + claim-row delete + command receipt) with an audit entry and a transition note
  that is NOT watchdog abandonment; `retained_work` sets durable `host` affinity so unpublished work stays
  host-affine.
- `recover_unstarted` (legacy pre-begin credential failures only) additionally requires the recorded
  pre-begin rejection note, no execution attempt, a fresh same-host runner report with zero in-flight
  workers, and `pgrep -P` proving the runner has no children — and readiness re-proved before release
  (tests: `/recorded pre-begin/`, `/no execution attempt/`).

### 3.4 TASK-specific begin prerequisite does not poison unrelated gateway readiness — VERIFIED
- f2aae10ad initially stored a barrier for every prerequisite-classified start failure. c09bc8922 fixes the
  poisoning: a `begin`-stage, prerequisite-class `start_failed` while readiness is still `ready` stores **no
  barrier** (`taskPrerequisite` → `barrier: null`); the released task keeps its task-specific affinity, and
  the gateway's readiness for unrelated work is unaffected. Real credential failures (readiness not ready)
  still produce `repair_required`/cooldown barriers keyed by `[worker token id, config_revision]`, escaped
  only by a changed credential identity or config revision, and cleared by a successful begin.
- Tests: task-prerequisite release → `{kind:"released", barrier:null}` and the next advertise is `ok:true`;
  meanwhile a transport failure still cooldowns (`ok:false`) until `config_revision: "repaired"` re-readies.
  Reducer test bounds the ladder: 2 cooldowns then `repair_required` at 3 same-fingerprint failures.

### 3.5 Failed launch stops the claim sweep — VERIFIED
- c09bc8922: after a claim whose launch did not grow in-flight, the tick loop `break`s
  ("re-prove gateway readiness next tick before another claim") and logs
  `{tid}: startup did not launch a worker; claim reconciliation recorded`. Per-candidate availability
  preflight failures `continue` without claiming. The dispatched-claim message is only emitted when a
  worker actually launched.

### 3.6 Credentials remain shared across `BRIDGE_DISPATCH_DIR` — VERIFIED (one minor finding)
- d6e75e6a6: `dispatch_dir()` honours `BRIDGE_DISPATCH_DIR`, isolating ephemeral status files
  (`runner.json`, per-task state, sessions sidecar, refused-repo cache) so a side-by-side rollout does not
  overwrite the human GUI's report.
- 562f39436: `provision_agent_token` reads/writes `agent-tokens.json` at the FIXED path
  `$HOME/.bridge/dispatch/agent-tokens.json` regardless of `BRIDGE_DISPATCH_DIR` — side-by-side runners
  reuse the same canonical worker credential instead of minting/rotating each other's active workers on
  every tick. The hub-side provisioning API proves a cached secret (`cached_secret`) before reuse and
  never rotates on infra errors — only a 401/403 drops the cache entry.
- **Finding F1 (minor, follow-up recommended):** `logout_core`'s credential-clear still removes
  `agent-tokens.json` via `dispatch_dir()` (dispatch.rs, `logout_core`) — under `BRIDGE_DISPATCH_DIR` it
  deletes from the isolated dir while the real shared cache survives. Impact is bounded: every cached
  secret is proof-validated server-side before use, so a stale cache cannot authorize anything after a
  real revocation — but the clear-on-logout behaviour is incomplete for rollout runners. Pre-existing line
  (introduced before this stack) that 562f394's migration did not move; one-line fix candidate.

### 3.7 Human GUI and foreign WIP preservation — VERIFIED (and exercised live during this audit)
- Nothing in the four commits kills processes: the only process inspection added is `pgrep -P` (read-only,
  proves children absent before legacy recovery). Quiescence is attested, never forced.
- `failed_start` computes `retained_work` (dirty worktree OR HEAD on a remote branch) and, when true,
  persists `host` affinity — foreign/human WIP is retained and sticky, never discarded.
- The recover path refuses without: fresh same-label runner report, zero `in_flight`, child-free process
  proof. GUI (`~/.bridge/dispatch/runner.json`) and an isolated rollout runner's report never cross.
- **Live exercise (unplanned, first-hand):** the opencode server restarted mid-audit. The runner quiesced
  this writer, published a checkpoint to
  `refs/heads/bridge-checkpoints/BR-6663/1/1793913470348875000` = commit `6b48e15ee9bb89a0daed0ada73f81fe519435754`
  (verified live on the remote via `git ls-remote`), marked the attempt quiesced with
  `next: continue the remaining action, preserving any newer local WIP`, and the run resumed from verified
  content — the exact stop/checkpoint/resume machinery these fixes harden, working under a real interrupt
  with zero work lost.

## 4. Rollout observations (scoped; no adoption claim)

- **Live hub:** serving bb3293dbf with the new gates active (§2).
- **Live runner binary on `macbook-pro-local-2`:** its live advertisement carries
  `config_revision: "worker-ready-v2:{…}"` — WITHOUT the `task-affinity-v1:` segment c09bc8922 introduced.
  The running corrected runner is therefore an f2aae10/d6e75e6-era build that has not yet adopted
  c09bc8922/562f39436/bb3293dbf. Hub-side gates make the task-prerequisite exemption and affinity checks
  effective regardless, but the runner-side availability preflight and claim-sweep break of §3.5 only
  take effect when the rollout runner adopts a bb3293dbf-era binary. **Publication is not adoption;**
  the managed rollout (`run.fleetbridge.worker-ready-v2`, reports `.bridge/dispatch-ready-v2`) must
  sequence the replacement itself — per the standing constraint, the old service (pid 10723) drains its
  current review (BR#6660) before replacement and GUI/worker children are never killed. This audit made
  no process changes and touched no runtime state.
- **bb3293dbf closes a real skew:** between c09bc8922 and bb3293dbf, `prepare_worker` advertised
  `worker-ready-v2:task-affinity-v1:{…}` while `spawn_opencode`'s begin-time advertise still used the old
  revision — one readiness revision at preflight and launch is required for barrier fingerprints to be
  coherent; bb3293dbf unifies both onto `worker_config_revision()`. Already on main and live.

## 5. Verdict

All eight audited behaviours are implemented, gated server-side, covered by real-SQLite tests, and active
on the live hub (bb3293dbf). Findings: F1 (minor logout-path cache miss, bounded impact) and the rollout-lag
observation in §4. No blocking defect found in the audited scope. This audit does not, and cannot,
constitute rollout acceptance, BR#6625 completion, or merge-line recovery.

## Receipts

- CI: 42109645913 (c09bc8922) SUCCESS · 42110118740 (562f39436) SUCCESS (was pending at request) · 42111020858 (bb3293dbf) SUCCESS, incl. "Deploy drift alarm: success" with log line `live hub matches the pushed SHA bb3293dbf ✓` (2026-11-05T21:19:00Z)
- dev-build: 42001349294 (f2aae10ad) · 42002623136 (d6e75e6a6) · 42110118626 (562f39436) · 42111020784 (bb3293dbf) — all SUCCESS
- Live availability probe (audit-availability-br6663-2): per-host `readiness`; `macbook-pro-local-2` ready (`at_08184d7f`), `ip-172-31-1-230` unprovisioned with the new-gate reason string
- Live execution inspect (audit-inspect-br6663-3): attempt `10239-1793913283626` quiesced with checkpoint `6b48e15` on `bridge-checkpoints/BR-6663/1/1793913470348875000` (confirmed via `git ls-remote`)
- Worker BR#6633 scoped outcome review: https://hub.fleetbridge.run/card/BR-6633 (noted, not extended)
- Signatures: `git log --show-signature` — all four commits Good ED25519 `SHA256:ofD6MVXzKh/VZ9GNAqH6FLs5fDGnAFpbFyWF+Y0RUwc`
