import type { HumanDecision } from "@bridge/contracts";

/** Existing lifecycle drills declare their human choice explicitly. Legacy
 * verb-dispatch drills instead use agent requests, retaining that compatibility
 * without creating new unstructured human requests. */
export function decisionFixture(taskId: string, labels: string[], action: "resume" | "hold" = "resume"): HumanDecision {
  return { kind: "preference", task_id: taskId,
    context: "The prepared task is waiting for the operator to choose its policy.",
    why_human: "The operator owns this policy choice; the agent must not choose it implicitly.",
    choices: labels.map(label => ({ label, executor: "bridge", consequence: `Bridge records the selected policy: ${label}. Existing execution and review requirements still apply.`, action })),
  };
}
