import type { StartupWait } from "./startup.ts";
import type { MergeTrainPhase } from "./train.ts";
import type { SchedulingReason } from "./scheduling.ts";

export type AwaitEvent =
  | { event: "lane_health"; repo: string; base: string; head?: string }
  | { event: "local_handoff"; handoff_id: string; version: number }
  | { event: "executor_capability"; id: string }
  | { event: "recovery_required"; cause: "repeated_failure" }
  | { event: "pr_merged"; repo: string; n: number }
  | { event: "br_pr_merged"; id: string }
  | { event: "issue_closed"; repo: string; n: number }
  | { event: "br_done"; id: string }
  | { event: "br_answered"; id: string }
  | { event: "run_success"; repo: string; run_id?: string; newer_than?: string; head?: string }
  | { event: "pr_checks_green"; repo: string; n: number }
  | { event: "deployed"; commit: string }
  | { event: "ask"; ask_id: string }
  | { event: "time"; until_ts: number };

type ExecutionRecoveryReason = Extract<SchedulingReason,
  "provider_route" | "retry_budget" | "recovery_route" | "host_affinity" | "capability" | "startup_prerequisite" | "startup_interrupt">;
type PrerequisiteReason = Extract<SchedulingReason,
  "qualification" | "operator_gate" | "question" | "independent_wait" | "lifecycle_gate">;

/** A read-only view of the same facts that gate scheduling and transitions.
 * An unmatched historical park is outside this contract and requires repair. */
export type WorkWait =
  | { kind: "human_decision"; exit: { event: "ask_answered"; ask_id: string } }
  | { kind: "prerequisite"; exit:
      | Exclude<AwaitEvent, { event: "executor_capability" | "recovery_required" }>
      | { event: "reviewed_wait_replacement"; duty_id: string }
      | { event: "review_recorded"; task_id: string }
      | { event: "train_advanced"; task_id: string; phase: MergeTrainPhase }
      | { event: "admission_satisfied"; task_id: string; reason: PrerequisiteReason } }
  | { kind: "execution_recovery"; exit:
      | { event: "startup_ready"; previous: StartupWait }
      | { event: "reviewed_execution_repair"; task_id: string; duty_id?: string }
      | { event: "compatible_executor_ready"; task_id: string }
      | { event: "execution_admitted"; task_id: string; reason: ExecutionRecoveryReason } }
  | { kind: "prior_attempt_reconciliation"; exit:
      | { event: "writer_reconciled"; task_id: string; generation: number }
      | { event: "operations_reconciled"; task_id: string; generation: number; operations: string[] } };

/** BR#23275 — the machine-checked single vocabulary (Ray: a hold class
 *  without an idle-safe exit "must be systematically impossible"): every
 *  SchedulingReason declares, in exactly ONE hand-written place, the
 *  WorkWait kind whose exit carries its release. Record<SchedulingReason, …>
 *  is exhaustive by construction — a reason added to SchedulingReasonSchema
 *  without an entry here FAILS TYPECHECK — and the wait-graph builder
 *  (boardWorkWaits in the worker) derives its arms from this map instead of
 *  a parallel hand-written switch, so a bare `break` (a reason with no
 *  declared exit) is unrepresentable.
 *
 *  The two reconciliation classes route to prior_attempt_reconciliation,
 *  whose exit is declared by the execution-state block in boardWorkWaits —
 *  execution state is the single source of truth for both the hold and its
 *  exit, so they cannot drift apart. */
export type SchedulingReasonWaitPlan =
  | { wait: "prerequisite"; reason: PrerequisiteReason }
  | { wait: "execution_recovery"; reason: ExecutionRecoveryReason }
  | { wait: "prior_attempt_reconciliation" };

export const SCHEDULING_REASON_WAIT_PLAN: Record<SchedulingReason, SchedulingReasonWaitPlan> = {
  qualification: { wait: "prerequisite", reason: "qualification" },
  operator_gate: { wait: "prerequisite", reason: "operator_gate" },
  question: { wait: "prerequisite", reason: "question" },
  independent_wait: { wait: "prerequisite", reason: "independent_wait" },
  lifecycle_gate: { wait: "prerequisite", reason: "lifecycle_gate" },
  writer_not_quiescent: { wait: "prior_attempt_reconciliation" },
  unknown_operations: { wait: "prior_attempt_reconciliation" },
  retry_budget: { wait: "execution_recovery", reason: "retry_budget" },
  provider_route: { wait: "execution_recovery", reason: "provider_route" },
  recovery_route: { wait: "execution_recovery", reason: "recovery_route" },
  host_affinity: { wait: "execution_recovery", reason: "host_affinity" },
  capability: { wait: "execution_recovery", reason: "capability" },
  startup_prerequisite: { wait: "execution_recovery", reason: "startup_prerequisite" },
  startup_interrupt: { wait: "execution_recovery", reason: "startup_interrupt" },
};
