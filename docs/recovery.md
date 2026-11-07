# One owner for server recovery

The independent supervisor owns the server recovery sequence. The hub owns task
claims and accepted outcomes. Native workers own their transport and durable
result. These are distinct responsibilities; none is a second update coordinator.

The supervisor has one closed, versioned journal and one dispatcher:

`idle → preparing → handoff → reconciling (when needed) → installing → verifying → finished`

Failures retain a typed wait and its exact continuation. An unsuccessful candidate
uses the same dispatcher to restore and verify the previous build. No separate
startup recovery, rollback or already-running-candidate ladder runs beside it.

## Ownership and removals

| Previous decision path | Surviving path |
| --- | --- |
| `recover`, `rollback`, `accept_running_candidate`, exception-driven retries | Supervisor `step` over its saved phase |
| Separate reservation and stopped-writer cleanup commands | Native `reconcile_record`, called by the live finalizer and supervised adapter |
| Separate reservation/writer observation branches | One native observation branch using the same reconciler |
| Manual repeated updater-script refresh | Confirmed native build exports its shipped supervisor, which resumes the same journal |
| Restart interpreted as a new failed drain | Same-build process reconnect, with fresh acknowledgement and unchanged operation deadline |

The old journal is a read-only migration input, not an active parallel mechanism.
Unknown versions and malformed recovery requests retain their holds.

## Safety and progress

- A publication is a hint. The selected artifact still needs the exact published
  digest, embedded commit and prerequisite checks.
- Every service effect has a saved preceding phase. A lost stop, rename or start
  acknowledgement is reconciled against actual state rather than blindly repeated.
- A compatible older controller can hand off through a frozen kernel boundary.
  Only the controller service is frozen; its descendants must contain no other
  processes. Any visibility gap or busy boundary prevents the stop.
- Native reconciliation requires the same controller lock. Real result delivery
  continues through its original stopped/checkpoint/finalize protocol.
- Missing result recovery needs the exact original stopping fence, no uncertain
  outside actions, the immutable worker manifest, a held original-worker lock and
  complete empty-unit kernel evidence. It records `result_unavailable`, preserves
  the original work and never reports business success.
- Missing evidence produces one observed wait, not repeated controller restarts.
- Failed rollback health leaves the restored process running. A genuinely newer
  verified candidate can continue after the original retry budget, under the same
  admission hold; the known failed candidate is not retried.
- Process identity, hold nonce, health and current build are rechecked. Neither
  restarting a participant nor publishing a new commit resets its budget.

## Verification

The workflow tests restart after every saved phase and after stop/start/rename
effects with a lost acknowledgement. They cover busy/unknown boundaries, failed
preflight and rollback, exact nonce and process changes, migration, useful-work
windows and supervisor self-update. A real-subprocess/archive test restarts the
coordinator during installation while an independent worker keeps its same PID
and continues producing output. Native tests exercise the kernel census, worker
locks, immutable original scope and evidence preservation.

Publication and these tests do not certify production recovery. Acceptance also
requires actual running adoption, useful worker progress and successful delivery.
