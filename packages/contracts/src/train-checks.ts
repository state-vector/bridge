import { z } from "zod";

/** GitHub identifiers live in different namespaces. Never infer a dispatch
 * endpoint from an unqualified numeric id or collapse two enforcing suites. */
export const CheckSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unknown") }),
  z.object({ kind: z.literal("check_run"), suite_id: z.number().int().positive(), app_id: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("workflow_run"), workflow_id: z.number().int().positive(), run_attempt: z.number().int().positive() }),
]);
export type CheckSource = z.infer<typeof CheckSourceSchema>;

export const CheckRetryTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("check_run"), id: z.number().int().positive() }),
  z.object({ kind: z.literal("actions_job"), id: z.number().int().positive() }),
  z.object({ kind: z.literal("workflow_run"), id: z.number().int().positive() }),
]);
export const CheckRetryCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reserve"), task_id: z.string(), head_sha: z.string().regex(/^[0-9a-f]{40}$/),
    name: z.string().min(1), source: CheckSourceSchema, target: CheckRetryTargetSchema }),
  z.object({ kind: z.literal("result"), key: z.string().min(1), outcome: z.enum(["dispatched", "failed", "outcome_unknown"]), receipt: z.string() }),
]);
export const CandidateRepairSchema = z.object({ kind: z.literal("head_checks"), head_sha: z.string().regex(/^[0-9a-f]{40}$/),
  checks: z.array(z.object({ name: z.string().min(1), url: z.string() })).min(1) });

export const CandidateIntegrationSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("awaiting_ci"), base_sha: z.string(), head_sha: z.string() }),
  z.object({ phase: z.literal("current"), base_sha: z.string(), head_sha: z.string() }),
]);

export function checkObligationKey(run: { name: string; source?: CheckSource }): string {
  const source = run.source;
  switch (source?.kind) {
    case "check_run": return JSON.stringify([source.kind, source.app_id, source.suite_id, run.name]);
    case "workflow_run": return JSON.stringify([source.kind, source.workflow_id, run.name]);
    default: return JSON.stringify(["unknown", run.name]); // legacy observations, never mixed with typed ones
  }
}
