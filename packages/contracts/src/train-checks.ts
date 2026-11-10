import { z } from "zod";

/** BR#9268: GitHub's own Actions app id. Every check run GitHub Actions
 *  creates — a NATIVE job AND an API-published report created with
 *  GITHUB_TOKEN — carries this app id, so the app id can never separate a
 *  real job from a published gate report. */
export const GITHUB_ACTIONS_APP_ID = 15368;

/** BR#9268: the producer class of a check-run observation — derived from the
 *  provider payload itself (the check run's GitHub URL shape), never
 *  caller-asserted. GitHub files an API-created check run into the creating
 *  app's most recent check suite for the head SHA, so a published report can
 *  share name + app id + suite id with a native job while enforcing nothing
 *  on its own. The class is what keeps the two distinct obligations:
 *  - `actions_job`: a NATIVE Actions job (`…/actions/runs/{run}/job/{job}`) —
 *    the enforcing execution; a dispatch re-runs THIS.
 *  - `published`: an API-created check run (`…/runs/{check_run_id}`) — a
 *    report; a newer one supersedes only other published reports and can
 *    never mask (or be masked by) the native job's verdict.
 *  - `unclassified`: URL missing or an unrecognized shape — its own
 *    obligation (it never merges with a classified one), and never
 *    dispatchable (fail-closed). */
export const CheckRunProducerSchema = z.enum(["actions_job", "published", "unclassified"]);
export type CheckRunProducer = z.infer<typeof CheckRunProducerSchema>;

/** MUST stay behaviour-identical to train_gate.rs `check_run_producer`. */
export function checkRunProducer(url: string | null | undefined): CheckRunProducer {
  const u = typeof url === "string" ? url.trim() : "";
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/[1-9][0-9]*\/job\/[1-9][0-9]*$/.test(u)) return "actions_job";
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/runs\/[1-9][0-9]*$/.test(u)) return "published";
  return "unclassified";
}

/** GitHub identifiers live in different namespaces. Never infer a dispatch
 * endpoint from an unqualified numeric id or collapse two enforcing suites. */
export const CheckSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unknown") }),
  z.object({ kind: z.literal("check_run"), suite_id: z.number().int().positive(), app_id: z.number().int().nonnegative(), producer: CheckRunProducerSchema.optional() }),
  z.object({ kind: z.literal("workflow_run"), workflow_id: z.number().int().positive(), run_attempt: z.number().int().positive() }),
]);
export type CheckSource = z.infer<typeof CheckSourceSchema>;

export const CheckRetryTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("check_run"), id: z.number().int().positive() }),
  z.object({ kind: z.literal("actions_job"), id: z.number().int().positive() }),
  z.object({ kind: z.literal("workflow_run"), id: z.number().int().positive() }),
]);
/** BR#8824 closed retry purpose — WHY a dispatch re-requests a check. Never a
 *  free string: the two legal reasons have different evidence and different
 *  hold laws.
 *  - `ordinary_head_check`: the re-run judges THIS head (a bisect probe, a
 *    settle re-verification). The [task, head, obligation] budget is
 *    permanent — one dispatch ever, no recovery can re-open it.
 *  - `stale_destination_gate`: the re-run clears a deployment-gate verdict
 *    stamped against a destination (main) that was red at verdict time. The
 *    hub validates CURRENT canonical green deploy coverage and scopes the
 *    budget to the successful coverage receipt — one retry per exact
 *    head/obligation/changed successful coverage, never per tick.
 *  Omitted (legacy callers) reads as `ordinary_head_check`: the old rows and
 *  their receipts keep their permanent-hold meaning. */
export const CheckRetryPurposeSchema = z.enum(["ordinary_head_check", "stale_destination_gate"]);
export type CheckRetryPurpose = z.infer<typeof CheckRetryPurposeSchema>;

const retryReservation = {
  kind: z.literal("reserve"), task_id: z.string(), head_sha: z.string().regex(/^[0-9a-f]{40}$/),
  name: z.string().min(1), source: CheckSourceSchema, target: CheckRetryTargetSchema,
};
export const CheckRetryCommandSchema = z.union([
  z.object({ ...retryReservation, purpose: z.literal("ordinary_head_check").optional() }),
  z.object({ ...retryReservation, purpose: z.literal("stale_destination_gate"), pr: z.number().int().positive() }),
  z.object({ kind: z.literal("result"), key: z.string().min(1), outcome: z.enum(["dispatched", "failed", "outcome_unknown"]), receipt: z.string() }),
]);

/** BR#8824: the canonical identity of a successful deploy coverage — the
 *  covered base tip plus the decisive covering run AND its attempt. NEVER a
 *  timestamp (observed_at moves every read) and NEVER caller-asserted green
 *  (the hub derives the coverage from its own folded lane state; the caller
 *  only names the purpose). A new decisive run on the SAME sha is a changed
 *  receipt, and so is a same-run rerun (a new attempt of the same run id —
 *  GitHub reruns create one; it can recover the gate) — the attempt keeps
 *  same-run reruns from silently reusing a consumed budget. */
export function deployCoverageReceipt(coverage: { tip_sha: string; covered_by_run_id?: number | null; covered_by_run_attempt?: number | null }): string {
  return JSON.stringify([coverage.tip_sha, coverage.covered_by_run_id ?? null, coverage.covered_by_run_attempt ?? null]);
}

/** BR#8824: the ledger keys for one (task, head, obligation) pair.
 *  `scopeKey` is shared by the ordinary row and every scoped row (the fence
 *  surface); `scopedKey` additionally pins the purpose and the successful
 *  coverage receipt the hub validated for THIS attempt. */
export function checkRetryScopeKey(taskId: string, headSha: string, obligation: string): string {
  return JSON.stringify([taskId, headSha, obligation]);
}
export function checkRetryScopedKey(scopeKey: string, purpose: CheckRetryPurpose, coverageReceipt: string): string {
  return JSON.stringify([...JSON.parse(scopeKey) as unknown[], purpose, coverageReceipt]);
}
export const CandidateRepairSchema = z.object({ kind: z.literal("head_checks"), head_sha: z.string().regex(/^[0-9a-f]{40}$/),
  checks: z.array(z.object({ name: z.string().min(1), url: z.string() })).min(1) });

export const CandidateIntegrationSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("awaiting_ci"), base_sha: z.string(), head_sha: z.string() }),
  z.object({ phase: z.literal("current"), base_sha: z.string(), head_sha: z.string() }),
]);

/** BR#9268: the enforcing identity of one check obligation. A check run's
 *  producer class (native Actions job vs API-published report) rides the key
 *  when the observation carries it, so a newer published green can never
 *  supersede — mask — an older native red of the same name/app/suite (the
 *  live SP #3057 shape: GitHub keeps BLOCKED while the collapsed key read
 *  green). Supersession stays WITHIN one producer class: a newer native
 *  attempt supersedes an older native attempt, a fresher publication
 *  supersedes an older report.
 *  An observation WITHOUT a producer keeps the bare pre-split identity —
 *  legacy rows, legacy callers and their receipts keep their exact meaning. */
export function checkObligationKey(run: { name: string; source?: CheckSource }): string {
  const source = run.source;
  switch (source?.kind) {
    case "check_run":
      return source.producer
        ? JSON.stringify([source.kind, source.app_id, source.suite_id, run.name, source.producer])
        : JSON.stringify([source.kind, source.app_id, source.suite_id, run.name]);
    case "workflow_run": return JSON.stringify([source.kind, source.workflow_id, run.name]);
    default: return JSON.stringify(["unknown", run.name]); // legacy observations, never mixed with typed ones
  }
}

/** BR#9268: the PRE-split obligation identity (no producer class). The retry
 *  ledger wrote every BR#8824 row under this collapsed key; a producer-typed
 *  reservation must still see (fence on, and be fenced by) an unreconciled
 *  dispatch of that scope — the identity migration must never re-arm an
 *  unknown external effect. A TERMINAL collapsed row does NOT consume a
 *  producer-typed budget: it dispatched some check of the collapsed
 *  obligation, provably not the freshly-identified native job's own
 *  one-dispatch-ever budget. */
export function legacyCheckObligationKey(run: { name: string; source?: CheckSource }): string {
  const source = run.source;
  if (source?.kind === "check_run") {
    return JSON.stringify([source.kind, source.app_id, source.suite_id, run.name]);
  }
  return checkObligationKey(run);
}
