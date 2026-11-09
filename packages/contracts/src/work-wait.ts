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
  "provider_route" | "retry_budget" | "recovery_route" | "host_affinity" | "capability" | "startup_prerequisite">;
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
  | { kind: "prior_attempt_reconciliation"; exit: {
      event: "attempt_reconciled"; task_id: string; generation: number;
      writer_pending: boolean; operations: string[];
    } };
