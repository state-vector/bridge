/** Startup is not execution: these waits never consume the task churn budget. */
import { z } from "zod";

const fields = {
  host: z.string().min(1),
  fingerprint: z.string().min(1),
  reason: z.string().min(1),
  since: z.number().int(),
  retained_work: z.boolean(),
  attention_at: z.number().int().nullable().default(null),
};
export const StartupWaitSchema = z.discriminatedUnion("phase", [
  z.object({ ...fields, phase: z.literal("waiting_executor"), source: z.enum(["legacy", "start_failed"]) }),
  z.object({ ...fields, phase: z.literal("recovery_required"), source: z.literal("start_failed") }),
]);
export type StartupWait = z.infer<typeof StartupWaitSchema>;

export function startupWaitReason(wait: StartupWait): string {
  return wait.phase === "waiting_executor"
    ? `Waiting for a healthy executor — no work has started. ${wait.reason}. Recovery is automatic when compatible readiness is verified.`
    : `Startup prerequisite requires repair — no work has started. ${wait.reason}. The failed executor/configuration will not be retried unchanged.`;
}

/** A task-specific rejection must not be cleared by repeating the same proof.
 * Other hosts may help only when there is no retained local work/host affinity. */
export function startupProofChanged(wait: StartupWait, host: string, fingerprint: string): boolean {
  if (wait.retained_work && host !== wait.host) return false;
  return wait.phase === "waiting_executor" || host !== wait.host || fingerprint !== wait.fingerprint;
}

/** Stable prerequisite identity excludes progress, priority and retry counters.
 * Fixing repository/task inputs re-arms only that task, not the whole host. */
export function startupPrerequisiteFingerprint(proof: string, task: { body_md: string; project: string; meta: Record<string, unknown> }): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
  return JSON.stringify([proof, task.body_md, task.project, canonical({ repo: task.meta.repo, execution_requirements: task.meta.execution_requirements, qualification: task.meta.qualification })]);
}
