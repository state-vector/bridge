/** Durable executor protocol, v1. Transport activity is not action progress. */
import { z } from "zod";
import { StartupWaitSchema } from "./startup.ts";
import { ExecutorNotReadySchema } from "./executor-readiness.ts";

export const EXECUTION_POLICY_VERSION = 1;
export const EXECUTOR_READINESS_PROTOCOL = "worker-ready-v2";
export const EXECUTION_LEASE_MS = 120_000;
const text = z.string().min(1).max(4000);
const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
export const ReasoningTierSchema = z.enum(["small", "medium", "large"]);
export type ReasoningTier = z.infer<typeof ReasoningTierSchema>;
export const ExecutionRequirementsSchema = z.object({
  tier: ReasoningTierSchema.default("small"),
  tools: z.array(text).default([]),
  environment: z.array(text).default([]),
  host: text.optional(),
});
export type ExecutionRequirements = z.infer<typeof ExecutionRequirementsSchema>;
export const WorkerReadinessSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unprovisioned") }),
  z.object({ kind: z.literal("provisioned"), label: text }),
]);
export const ExecutorStartBarrierSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cooldown"), fingerprint: text, failures: z.number().int().min(1).max(2), until_ts: z.number().int(), reason: text }),
  z.object({ kind: z.literal("repair_required"), fingerprint: text, failures: z.number().int().positive(), reason: text }),
]);
export type ExecutorStartBarrier = z.infer<typeof ExecutorStartBarrierSchema>;
/** Compatibility boundary for old runners that wrapped ENOSPC in an identity
 * gate. Only the scratch-directory OS error is recoverable this way; missing
 * keys, failed signatures and arbitrary gate failures remain prerequisites. */
export function isSigningScratchResourceFailure(reason: string): boolean {
  return reason.includes("sign-check scratch dir: No space left on device (os error 28)");
}
export function recoverResourceStartBarrier(barrier: ExecutorStartBarrier | null, now: number): ExecutorStartBarrier | null {
  return barrier?.kind === "repair_required" && isSigningScratchResourceFailure(barrier.reason)
    ? nextExecutorStartBarrier(barrier, barrier.fingerprint, barrier.reason, now, "resource") : barrier;
}
export function nextExecutorStartBarrier(previous: ExecutorStartBarrier | null, fingerprint: string, reason: string, now: number, failureClass: "transport" | "prerequisite" | "resource" = "transport"): ExecutorStartBarrier {
  // Resource recovery changes neither credential nor configuration. Repeated
  // ENOSPC must back off, not permanently require a new identity fingerprint.
  if (failureClass === "resource" || isSigningScratchResourceFailure(reason)) return ExecutorStartBarrierSchema.parse({
    kind: "cooldown", fingerprint, failures: 1, until_ts: now + 60_000, reason,
  });
  const failures = previous?.fingerprint === fingerprint ? previous.failures + 1 : 1;
  return ExecutorStartBarrierSchema.parse(failureClass === "prerequisite" || failures >= 3
    ? { kind: "repair_required", fingerprint, failures, reason }
    : { kind: "cooldown", fingerprint, failures, until_ts: now + 60_000 * failures, reason });
}
/** Typed provider-cause wire shape — mirrors the Rust transport classifier
 * (opencode v2.2.5 ACP adapter: `provider.auth` serializes as ACP -32000
 * AuthRequiredError; other session failures as -32603 with OBJECT data
 * `{service:"session", errorName:"provider.*"}`). The class comes only from
 * the adapter's typed discriminators — prose never classifies (BR#8821:
 * a generic failure string is not a quota proof). */
export const ProviderCauseClassSchema = z.enum(["account_action", "rate_limit", "route_unavailable", "provider_internal", "diagnostic"]);
export type ProviderCauseClass = z.infer<typeof ProviderCauseClassSchema>;
export const ProviderCauseSchema = z.object({
  class: ProviderCauseClassSchema,
  backend: z.string().default("opencode"),
  model: z.string().nullable().default(null),
  /** ACP JSON-RPC error code (-32000/-32603), never a guessed HTTP status. */
  code: z.number().int().nullable().default(null),
  /** Exact allowlisted adapter errorName (provider.quota, provider.auth, …). */
  error_name: z.string().nullable().default(null),
  /** Redacted provider message. */
  message: text,
  /** Redacted structured provider error data, object-valued where the
   * adapter provides it — never flattened into a lossy string. */
  data: z.unknown().optional(),
  evidence_line: text.nullable().default(null),
  at_ms: z.number().int().nonnegative(),
});
export type ProviderCause = z.infer<typeof ProviderCauseSchema>;
/** Only `account_action` (quota/auth) demands a human account action; the
 * other classes are contained on the route without an owner ask (BR#8822:
 * reuse/dedupe the account action, never widen it). */
export function isAccountActionCause(cause: ProviderCause | null | undefined): boolean {
  return cause?.class === "account_action";
}
/** Dedupe scope of one incident: class + provider route + config/credential
 * generation. Old success receipts cannot clear a new configuration's
 * incident; two classes on one route are two incidents. */
export function providerIncidentRouteKey(cause: Pick<ProviderCause, "class" | "backend" | "model">, configRevision: string): string {
  return `${cause.class}|${cause.backend}|${cause.model ?? ""}|${configRevision}`;
}
export function providerIncidentText(cause: Pick<ProviderCause, "class" | "backend" | "model">): string {
  const route = `${cause.backend}${cause.model ? `/${cause.model}` : ""}`;
  switch (cause.class) {
    case "account_action": return `${route}: provider account action required (quota or authentication)`;
    case "rate_limit": return `${route}: provider rate limit reached`;
    case "route_unavailable": return `${route}: provider route unavailable`;
    case "provider_internal": return `${route}: provider internal error`;
    case "diagnostic": return `${route}: unclassified provider error — evidence preserved`;
  }
}
export const ModelCapabilitySchema = z.object({
  tier: ReasoningTierSchema,
  tools: z.array(text),
  environment: z.array(text),
  backend: z.enum(["opencode", "kiro", "interactive"]).default("opencode"),
  model: z.string().nullable().default(null),
  config_revision: text.default("legacy"),
  capacity: z.number().int().min(1).max(64).default(1),
  projects: z.array(text).default(["*"]),
  availability: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("usable") }),
    z.object({ kind: z.literal("unavailable"), reason: text }),
    z.object({ kind: z.literal("disabled") }),
  ]).default({ kind: "usable" }),

});
export const ExecutorCapabilitiesSchema = ModelCapabilitySchema.extend({ alternatives: z.array(ModelCapabilitySchema).max(20).default([]), worker: WorkerReadinessSchema.default({ kind: "unprovisioned" }), inventory_revision: z.union([z.literal(1), z.literal(2)]).optional(),
  admission_hold: z.object({ kind: z.literal("update_handoff"), reason: text }).optional() });
export type ExecutorCapabilities = z.infer<typeof ExecutorCapabilitiesSchema>;
export function capabilityBlockers(required: ExecutionRequirements, actual: Pick<ExecutorCapabilities, "tier" | "tools" | "environment">, host: string): string[] {
  const tiers: ReasoningTier[] = ["small", "medium", "large"];
  return [
    ...(tiers.indexOf(actual.tier) < tiers.indexOf(required.tier) ? [`reasoning:${required.tier}`] : []),
    ...required.tools.filter(x => !actual.tools.includes(x)).map(x => `tool:${x}`),
    ...required.environment.filter(x => !actual.environment.includes(x)).map(x => `environment:${x}`),
    ...(required.host && required.host !== host ? [`host:${required.host}`] : []),
  ];
}

/** A remote ref alone is insufficient: the restoring runner verifies BOTH objects. */
export const CheckpointSchema = z.object({
  repo: text,
  remote_ref: z.string().regex(/^refs\/heads\/bridge-checkpoints\/[A-Za-z0-9/_-]+$/),
  commit: sha,
  tree: sha,
  base: sha,
  environment: z.array(text),
  next: text,
  tests: z.array(z.object({ tree: sha, command: text, outcome: z.enum(["passed", "failed", "inconclusive"]), receipt: text })),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;
const HandoffDetails = {
  id: text, version: z.number().int().positive(), requested_at: z.number(),
  reason: text, action: text, findings: text, tried: text, next: text,
  evidence: z.array(text), approvals: z.array(text), recipient: text.nullable(),
};
const QuiescenceProofSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("runner"), host: text, generation: z.number() }),
  z.object({ kind: z.literal("human_attested"), by: text, evidence: text }),
]);
export const LocalHandoffSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("none") }),
  z.object({ phase: z.literal("preparing"), ...HandoffDetails, quiescence: z.object({ kind: z.literal("pending") }) }),
  z.object({ phase: z.literal("waiting"), ...HandoffDetails, checkpoint: CheckpointSchema.nullable(), quiescence: QuiescenceProofSchema }),
  z.object({ phase: z.literal("accepted"), ...HandoffDetails, checkpoint: CheckpointSchema.nullable(),
    token_id: text, session: text, host: text, accepted_at: z.number(), grant_id: text, capabilities: ExecutorCapabilitiesSchema, quiescence: QuiescenceProofSchema }),
  z.object({ phase: z.literal("returned"), ...HandoffDetails, checkpoint: CheckpointSchema.nullable(), returned_at: z.number(), by: text, quiescence: QuiescenceProofSchema }),
]);
export type LocalHandoff = z.infer<typeof LocalHandoffSchema>;
export const LocalGrantSchema = z.object({
  id: text, task_id: text, handoff_id: text, version: z.number().int().positive(),
  token_id: text, session: text, host: text, by: text, expires_at: z.number(),
  source: z.literal("human_attested"), evidence: text, capabilities: ExecutorCapabilitiesSchema,
});
export type LocalGrant = z.infer<typeof LocalGrantSchema>;
/** Authenticated human-directed ownership; never a fabricated executor capability. */
export const InteractiveClaimSchema = z.object({
  kind: z.literal("interactive"), token_id: text, session: text, claimed_at: z.number(),
});
export type InteractiveClaim = z.infer<typeof InteractiveClaimSchema>;
export const ExecutionBlockerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("startup_wait"), episode_id: text, text, wait: StartupWaitSchema }),
  z.object({ kind: z.literal("capability_unavailable"), episode_id: text, reason: z.enum(["not_configured", "offline", "unavailable"]), text, evidence: z.array(text) }),
  z.object({ kind: z.literal("executor_not_ready"), episode_id: text, text, evidence: z.array(text), causes: z.array(z.object({ host: text, readiness: ExecutorNotReadySchema })).min(1) }),
  z.object({ kind: z.literal("capacity_wait"), episode_id: text, text }),
  z.object({ kind: z.literal("human_answer_required"), episode_id: text, ask_id: text, text }),
  z.object({ kind: z.literal("local_pickup_required"), episode_id: text, handoff_id: text, version: z.number(), text }),
  z.object({ kind: z.literal("writer_quiescence_required"), episode_id: text, text }),
]);
export type ExecutionBlocker = z.infer<typeof ExecutionBlockerSchema>;
export const HandoffReadSchema = z.looseObject({ project: text.optional(), recipient: text.optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() });
export const HandoffAcceptSchema = z.looseObject({ id: text, handoff_id: text, version: z.number().int().positive(), session: text });
export const HandoffControlSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("request_local"), id: text, reason: text, action: text }),
  z.object({ kind: z.literal("confirm_preparation"), id: text, handoff_id: text, version: z.number().int().positive(), checkpoint: CheckpointSchema.optional(), evidence: text, writers: z.literal("human_confirmed_quiescent") }),
  z.object({ kind: z.literal("authorize"), id: text, handoff_id: text, version: z.number().int().positive(), label: text, session: text, host: text, evidence: text, capabilities: ExecutorCapabilitiesSchema, ttl_ms: z.number().int().min(1).max(900_000).optional() }),
  z.object({ kind: z.literal("return_autonomous"), id: text, handoff_id: text, version: z.number().int().positive(), writers: z.literal("human_confirmed_quiescent") }),
]);
export type HandoffControl = z.infer<typeof HandoffControlSchema>;
export const HandoffCheckpointSchema = HandoffAcceptSchema.extend({ checkpoint: CheckpointSchema });
const FenceSchema = z.object({ generation: z.number().int().positive(), attempt_id: text });
const MessageSchema = z.object({
  id: text, text, priority: z.enum(["normal", "interrupt"]),
  state: z.enum(["queued", "delivered", "acknowledged", "acted"]),
});
const OperationSchema = z.object({
  id: text, action: text, input_revision: text, deadline: z.number().int(),
  state: z.enum(["prepared", "outcome_unknown", "succeeded", "failed"]),
  receipts: z.array(text),
});
const AttemptFields = {
  ...FenceSchema.shape,
  host: text, session: text,
  lease_until: z.number().int(),
  action_deadline: z.number().int(),
  executor: ExecutorCapabilitiesSchema.nullable().default(null),
};
export const WriterProofSchema = z.enum(["process_group_empty", "no_live_group_members"]);
export const WriterReceiptSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("writer_receipt_missing") }),
  z.object({ kind: z.literal("writer_receipt_held"), reason: text }),
  z.object({ kind: z.literal("writer_receipt_found"), task_id: text, command_id: text,
    source: z.enum(["quiesce", "stopped", "finalize"]),
    proof: FenceSchema.extend({ host: text, session: text, phase: z.literal("quiesced"), writers: WriterProofSchema }),
  }),
]);
export type WriterReceipt = z.infer<typeof WriterReceiptSchema>;
export const AttemptSchema = z.discriminatedUnion("phase", [
  z.object({ ...AttemptFields, phase: z.literal("restoring"), checkpoint: CheckpointSchema, restored_tree: z.null() }),
  z.object({ ...AttemptFields, phase: z.literal("running"), checkpoint: CheckpointSchema.nullable(), restored_tree: sha.nullable() }),
  z.object({ ...AttemptFields, phase: z.literal("stopping"), checkpoint: CheckpointSchema.nullable(), restored_tree: sha.nullable() }),
  z.object({ ...AttemptFields, phase: z.literal("finalizing"), checkpoint: CheckpointSchema.nullable(), restored_tree: sha.nullable(), writers: WriterProofSchema }),
  z.object({ ...AttemptFields, phase: z.literal("quiesced"), checkpoint: CheckpointSchema.nullable(), restored_tree: sha.nullable() }),
]);
export type ExecutionAttempt = z.infer<typeof AttemptSchema>;
/** Process outcome is evidence, never business acceptance. The agent/hub owns
 * task completion; exit 0 cannot manufacture a review or close a diagnostic. */
export const TerminalOutcomeSchema = z.object({
  kind: z.enum(["completed", "interrupted", "failed", "timed_out", "result_unavailable"]),
  exit_code: z.number().int().nullable(),
  stdout_tail: z.string().max(16_000),
  stderr_tail: z.string().max(8_000),
  /** Typed provider/account cause when the transport captured a structured
   * provider error. Absent on every older journal (mixed-version safe):
   * `default` keeps old records parseable, and the authenticated failure
   * provenance + raw sanitized evidence ride ONLY on this field (BR#8821). */
  cause: ProviderCauseSchema.optional(),
});
export const TerminalReceiptSchema = FenceSchema.extend({ outcome: TerminalOutcomeSchema, writers: WriterProofSchema.default("process_group_empty") });
/** A bounded, witnessed request on the configured route. A model catalog,
 * CLI version, answered billing question or timestamp alone is not evidence. */
export const ProviderRecoveryProofSchema = z.object({
  id: text, host: text, backend: text, model: text, config_revision: text,
  result: z.object({ kind: z.literal("succeeded"), response_receipt: text }),
  observed_at: z.number().int().positive(),
  request: z.object({ kind: z.literal("configured_model_request"), max_output_tokens: z.number().int().positive(), tools: z.literal("none") }),
  actual_model: text, configuration_receipt: text, receipts: z.array(text).min(1),
  witness: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("configured_route_observed"), configured_model: text,
      allowed_actual_models: z.array(text).min(1), configured_max_output_tokens: z.number().int().positive(),
      observed_max_output_tokens: z.number().int().positive(), configuration_receipt: text }),
    z.object({ kind: z.literal("configured_proxy_request"), configured_model: text,
      allowed_actual_models: z.array(text).min(1), observed_max_output_tokens: z.number().int().positive(),
      configuration_receipt: text }),
  ]),
});
export function validRecoveryRequestProof(
  proof: z.infer<typeof ProviderRecoveryProofSchema>,
  diagnosis: "provider_authentication" | "provider_quota" | "provider_route_unavailable",
): boolean {
  const witness = proof.witness;
  return witness.configured_model === proof.model
    && witness.allowed_actual_models.includes(proof.actual_model)
    && witness.configuration_receipt === proof.configuration_receipt
    && witness.observed_max_output_tokens === proof.request.max_output_tokens
    && (witness.kind === "configured_proxy_request"
      ? diagnosis === "provider_route_unavailable"
      : witness.configured_max_output_tokens === proof.request.max_output_tokens);
}
const recoveryPermitFields = {
  id: text, generation: z.number().int().nonnegative(), attempt_id: text,
  task_revision: text, checkpoint_commit: sha.nullable(),
  terminal: TerminalReceiptSchema, proof: ProviderRecoveryProofSchema,
  diagnosis: z.enum(["provider_authentication", "provider_quota", "provider_route_unavailable"]),
  continuation: text, evidence: z.array(text).min(1), authorized_by: text,
};
export const ExecutionRecoveryPermitSchema = z.discriminatedUnion("phase", [
  z.object({ ...recoveryPermitFields, phase: z.literal("available") }),
  z.object({ ...recoveryPermitFields, phase: z.literal("consumed"), consumed_generation: z.number().int().positive(), consumed_attempt_id: text }),
]);
export type ExecutionRecoveryPermit = z.infer<typeof ExecutionRecoveryPermitSchema>;

export const ExecutionRetryStrategySchema = z.object({
  kind: z.literal("larger_model"), epoch: z.number().int().positive(),
  task_revision: text, minimum_tier: ReasoningTierSchema,
  first_generation: z.number().int().positive(), failures: z.number().int().nonnegative(),
  reason: text, source: z.enum(["executor", "independent_review"]),
});

export const ExecutionStateSchema = z.object({
  policy_version: z.literal(EXECUTION_POLICY_VERSION),
  revision: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative(),
  attempt: AttemptSchema.nullable(),
  requirements: ExecutionRequirementsSchema,
  messages: z.array(MessageSchema),
  operations: z.array(OperationSchema),
  budget_exhaustions: z.number().int().nonnegative().default(0),
  failure_charged_generation: z.number().int().nonnegative().nullable().default(null),
  retry_strategy: ExecutionRetryStrategySchema.nullable().default(null),
  recovery_permit: ExecutionRecoveryPermitSchema.nullable().default(null),
  delivery: ModelCapabilitySchema.nullable().default(null),
  handoff: LocalHandoffSchema.default({ phase: "none" }),
  terminal: TerminalReceiptSchema.nullable().default(null),
});
export type ExecutionState = z.infer<typeof ExecutionStateSchema>;
export function initialExecution(requirements: ExecutionRequirements = ExecutionRequirementsSchema.parse({})): ExecutionState {
  return { policy_version: EXECUTION_POLICY_VERSION, revision: 0, generation: 0, attempt: null, requirements, messages: [], operations: [], budget_exhaustions: 0, failure_charged_generation: 0, retry_strategy: null, recovery_permit: null, delivery: null, handoff: { phase: "none" }, terminal: null };
}

export const ExecutionCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("schedule"), mode: z.enum(["inspect", "reserve", "request_capacity"]) }),
  z.object({ kind: z.literal("schedule_status"), host: text.optional() }),
  z.object({ kind: z.literal("provider_route_verified"), proof: ProviderRecoveryProofSchema, limit: z.number().int().min(1).max(4).default(4) }),
  z.object({ kind: z.literal("recover_provider_failure"), terminal: TerminalReceiptSchema,
    proof: ProviderRecoveryProofSchema, diagnosis: recoveryPermitFields.diagnosis,
    continuation: text, evidence: z.array(text).min(1) }),
  z.object({ kind: z.literal("gateway_control"), host: text, mode: z.enum(["enabled", "draining"]), reason: text }),
  z.object({ kind: z.literal("gateway_failure"), reason: text, cooldown_ms: z.number().int().min(10_000).max(300_000) }),
  z.object({ kind: z.literal("pause_claims"), reason: text, budget_ms: z.number().int().min(10_000).max(300_000) }),
  z.object({ kind: z.literal("resume_claims") }),
  z.object({ kind: z.literal("inspect") }),
  z.object({ kind: z.literal("receipt"), target_command_id: text }),
  z.object({ kind: z.literal("writer_receipt"), ...FenceSchema.shape }),
  z.object({ kind: z.literal("availability") }),
  z.object({ kind: z.literal("advertise"), capabilities: ExecutorCapabilitiesSchema }),
  z.object({ kind: z.literal("begin"), attempt_id: text, worker: text, action_budget_ms: z.number().int().min(10_000).max(3_600_000),
    selection: z.object({ backend: z.enum(["opencode", "kiro"]), model: text, tier: ReasoningTierSchema }).optional() }),
  z.object({ kind: z.literal("start_failed"), stage: z.enum(["inspect", "begin"]), reason: text, retained_work: z.boolean(), failure_class: z.enum(["transport", "prerequisite", "resource"]).default("prerequisite") }),
  z.object({ kind: z.literal("recover_unstarted"), writers: z.literal("not_launched"), retained_work: z.literal(true) }),
  z.object({ kind: z.literal("cancel_start"), writers: z.literal("not_launched"), retained_work: z.literal(true) }),
  z.object({ kind: z.literal("poll"), ...FenceSchema.shape }),
  z.object({ kind: z.literal("restore"), ...FenceSchema.shape, tree: sha, commit: sha }),
  z.object({ kind: z.literal("checkpoint"), ...FenceSchema.shape, checkpoint: CheckpointSchema }),
  z.object({ kind: z.literal("quiesce"), ...FenceSchema.shape, writers: z.literal("process_group_empty") }),
  z.object({ kind: z.literal("stopped"), ...FenceSchema.shape, writers: WriterProofSchema, outcome: TerminalOutcomeSchema }),
  z.object({ kind: z.literal("finalize"), ...FenceSchema.shape, writers: WriterProofSchema, outcome: TerminalOutcomeSchema }),
  z.object({ kind: z.literal("yield"), ...FenceSchema.shape }),
  z.object({ kind: z.literal("message"), message_id: text, text, priority: z.enum(["normal", "interrupt"]) }),
  z.object({ kind: z.literal("ack"), ...FenceSchema.shape, message_id: text, state: z.enum(["acknowledged", "acted"]) }),
  z.object({ kind: z.literal("escalate"), ...FenceSchema.shape, tier: ReasoningTierSchema, reason: text }),
  z.object({ kind: z.literal("local_handoff"), ...FenceSchema.shape, reason: text, action: text, findings: text, tried: text, next: text,
    evidence: z.array(text), approvals: z.array(text), recipient: text.nullable().default(null) }),
  z.object({ kind: z.literal("prepare"), ...FenceSchema.shape, operation_id: text, action: text, input_revision: text, budget_ms: z.number().int().min(1000).max(3_600_000) }),
  z.object({ kind: z.literal("result"), ...FenceSchema.shape, operation_id: text, outcome: z.enum(["succeeded", "failed", "outcome_unknown"]), receipts: z.array(text) }),
]);
export type ExecutionCommand = z.infer<typeof ExecutionCommandSchema>;
export const ExecutionRequestSchema = z.looseObject({
  id: text,
  command_id: text,
  command: ExecutionCommandSchema,
  session: text.optional(),
});

/** Pure reducer: caller authenticates host/session; one SQLite transaction commits
 * this state AND the command receipt. An expired writer is NEVER automatically
 * declared quiescent, even after host death. */
export function reduceExecution(previous: ExecutionState, command: ExecutionCommand, host: string, session: string, now: number, taskRevision = "legacy"): ExecutionState {
  const s = structuredClone(previous);
  const a = s.attempt;
  const requireAttempt = (allowExpired = false): ExecutionAttempt => {
    if (!("generation" in command) || !a || command.generation !== a.generation || command.attempt_id !== a.attempt_id || a.host !== host || a.session !== session) {
      throw new Error("gate: execution attempt fenced — stop, preserve local work, do not push");
    }
    if (!allowExpired && (a.lease_until <= now || a.phase === "quiesced" || a.phase === "finalizing")) throw new Error("gate: execution lease expired or writer stopped");
    return a;
  };
  switch (command.kind) {
    case "schedule": case "schedule_status": case "recover_provider_failure": case "provider_route_verified": case "gateway_control": case "gateway_failure": case "inspect": case "receipt": case "writer_receipt": case "availability": case "advertise": case "pause_claims": case "resume_claims": return s;
    case "start_failed": {
      if (a && a.phase !== "quiesced") throw new Error("gate: failed start cannot release an unquiesced writer");
      return s; // the authenticated coordinator owns the atomic task release
    }
    case "cancel_start": {
      if (a && a.phase !== "quiesced") throw new Error("gate: startup cancellation cannot discard an unquiesced writer");
      return s;
    }
    case "recover_unstarted": {
      if (a) throw new Error("gate: legacy unstarted recovery cannot erase an execution attempt");
      return s;
    }
    case "begin": {
      const needsRecoveryPermit = executionNeedsRecoveryPermit(s, taskRevision);
      if (!["none", "returned"].includes(s.handoff.phase)) throw new Error("gate: local handoff owns execution; autonomous dispatch is forbidden");
      if (needsRecoveryPermit && !(s.recovery_permit?.task_revision === taskRevision && recoveryPermitCoversAttempt(s, now))) throw new Error("gate: retry budget or provider route requires a current recovery permit");
      if (a && a.phase !== "quiesced") throw new Error("gate: previous writer requires quiescence acknowledgement; retain host affinity");
      if (s.operations.some(x => x.state === "prepared" || x.state === "outcome_unknown")) throw new Error("gate: reconcile unknown external operations before another attempt");
      s.generation += 1;
      if (needsRecoveryPermit && s.recovery_permit?.phase === "available") s.recovery_permit = { ...s.recovery_permit, phase: "consumed", consumed_generation: s.generation, consumed_attempt_id: command.attempt_id };
      const common = {
        generation: s.generation, attempt_id: command.attempt_id, host, session,
        lease_until: now + EXECUTION_LEASE_MS,
        action_deadline: now + command.action_budget_ms,
        executor: null,
      };
      s.attempt = { ...common, phase: "running", checkpoint: null, restored_tree: null };
      break;
    }
    case "poll": {
      const current = requireAttempt(true);
      if (current.phase === "finalizing") return s; // stopped writers cannot renew or become running again
      if (current.phase === "quiesced" || current.lease_until <= now) throw new Error("gate: execution lease expired or quiesced");
      if (current.action_deadline <= now && current.phase !== "stopping") {
        chargeExecutionFailure(s, current.generation);
        // One generation is charged once, even if finalize arrives later.
      }
      if (current.action_deadline <= now || s.messages.some(x => x.priority === "interrupt" && (x.state === "queued" || x.state === "delivered"))) current.phase = "stopping";
      current.lease_until = now + EXECUTION_LEASE_MS;
      for (const op of s.operations) if (op.state === "prepared" && op.deadline <= now) { op.state = "outcome_unknown"; current.phase = "stopping"; }
      for (const m of s.messages) if (m.state === "queued") m.state = "delivered";
      break;
    }
    case "restore": {
      const current = requireAttempt();
      if (current.phase !== "restoring" || !current.checkpoint || current.checkpoint.tree !== command.tree || current.checkpoint.commit !== command.commit) throw new Error("gate: checkpoint restoration must verify exact commit and tree");
      s.attempt = { ...current, phase: "running", restored_tree: command.tree };
      break;
    }
    case "checkpoint": {
      const current = requireAttempt(true);
      if (current.phase === "quiesced") throw new Error("gate: quiesced writer cannot publish new checkpoints");
      if (command.checkpoint.tests.some(t => t.tree !== command.checkpoint.tree)) throw new Error("gate: test evidence does not cover checkpoint content");
      current.checkpoint = command.checkpoint;
      break;
    }
    case "quiesce": requireAttempt(true).phase = "quiesced"; break;
    case "stopped": {
      const current = requireAttempt(true);
      if (s.terminal?.generation === command.generation && s.terminal.attempt_id === command.attempt_id
        && (JSON.stringify(s.terminal.outcome) !== JSON.stringify(command.outcome) || s.terminal.writers !== command.writers)) throw new Error("gate: captured terminal evidence is immutable");
      if (current.phase !== "quiesced") s.attempt = { ...current, phase: "finalizing", writers: command.writers };
      s.terminal = { generation: command.generation, attempt_id: command.attempt_id, outcome: command.outcome, writers: command.writers };
      break;
    }
    case "finalize": {
      const current = requireAttempt(true);
      if (!["finalizing", "quiesced"].includes(current.phase)) throw new Error("gate: finalization requires an acknowledged stopped-writer receipt");
      if (!s.terminal || s.terminal.generation !== command.generation || s.terminal.attempt_id !== command.attempt_id
        || JSON.stringify(s.terminal.outcome) !== JSON.stringify(command.outcome) || s.terminal.writers !== command.writers) throw new Error("gate: finalization must preserve the captured terminal evidence");
      current.phase = "quiesced";
      s.terminal = { generation: command.generation, attempt_id: command.attempt_id, outcome: command.outcome, writers: command.writers };
      // Receipt of stop/interrupt does not mean its requested business action
      // was completed. Keep it acknowledged for the next executor to reconcile.
      for (const message of s.messages) if (message.state === "delivered") message.state = "acknowledged";
      if (s.handoff.phase === "preparing" && !s.operations.some(op => op.state === "prepared" || op.state === "outcome_unknown")) {
        s.handoff = { ...s.handoff, phase: "waiting", checkpoint: null, quiescence: { kind: "runner", host, generation: current.generation } };
      }
      break;
    }
    case "yield": {
      const current = requireAttempt(true);
      if (current.phase !== "quiesced") throw new Error("gate: yield requires a quiescent writer");
      if (s.operations.some(x => x.state === "prepared" || x.state === "outcome_unknown")) throw new Error("gate: reconcile pending external operations before yielding");
      if (s.handoff.phase === "preparing") s.handoff = { ...s.handoff, phase: "waiting", checkpoint: null, quiescence: { kind: "runner", host, generation: current.generation } };
      break;
    }
    case "message": {
      if (!s.messages.some(x => x.id === command.message_id)) {
        if (s.messages.filter(x => x.state !== "acted").length >= 100) throw new Error("gate: execution mailbox full");
        if (s.messages.length >= 1000) throw new Error("gate: mailbox history budget exhausted; reconcile before adding messages");
        s.messages.push({ id: command.message_id, text: command.text, priority: command.priority, state: "queued" });
      }
      if (a && a.phase !== "quiesced" && a.phase !== "finalizing" && command.priority === "interrupt") a.phase = "stopping";
      break;
    }
    case "ack": {
      requireAttempt(true);
      const m = s.messages.find(x => x.id === command.message_id);
      if (!m || m.state === "queued" || (command.state === "acted" && m.state === "delivered")) throw new Error("gate: mailbox delivery and acknowledgement precede action");
      if (m.state !== "acted") m.state = command.state;
      break;
    }
    case "escalate": {
      const current = requireAttempt();
      const tiers: ReasoningTier[] = ["small", "medium", "large"];
      const actualTier = current.executor?.tier ?? s.requirements.tier;
      if (tiers.indexOf(command.tier) <= Math.max(tiers.indexOf(s.requirements.tier), tiers.indexOf(actualTier))) throw new Error("gate: escalation must increase the persistent minimum reasoning tier and actual execution tier");
      openLargerModelStrategy(s, command.tier, command.reason, "executor", taskRevision);
      s.requirements.tier = command.tier;
      current.phase = "stopping";
      break;
    }
    case "local_handoff": {
      const current = requireAttempt();
      if (!["none", "returned"].includes(s.handoff.phase)) throw new Error("gate: a local handoff already owns this episode");
      s.handoff = { phase: "preparing", id: `local:${s.generation}:${s.revision + 1}`, version: 1, requested_at: now,
        reason: command.reason, action: command.action, findings: command.findings, tried: command.tried, next: command.next,
        evidence: command.evidence, approvals: command.approvals, recipient: command.recipient, quiescence: { kind: "pending" } };
      current.phase = "stopping";
      break;
    }
    case "prepare": {
      const current = requireAttempt();
      // Name the real cause: a non-running phase (e.g. restoring) is not a pending interruption.
      if (current.phase !== "running" || s.messages.some(x => x.priority === "interrupt" && x.state !== "acted")) {
        const why = current.phase !== "running" ? `current phase is ${current.phase}` : "a pending interruption is unacknowledged";
        throw new Error(`gate: external mutations require a running attempt with acknowledged coordination — ${why}`);
      }
      if (s.operations.some(x => x.id === command.operation_id)) throw new Error("gate: operation already exists — inspect/reconcile it, do not repeat the effect");
      s.operations.push({ id: command.operation_id, action: command.action, input_revision: command.input_revision, deadline: now + command.budget_ms, state: "prepared", receipts: [] });
      break;
    }
    case "result": {
      requireAttempt(true);
      const op = s.operations.find(x => x.id === command.operation_id);
      if (!op || (op.state !== "prepared" && op.state !== "outcome_unknown")) throw new Error("gate: operation missing or already resolved");
      if (command.outcome !== "outcome_unknown" && command.receipts.length === 0) throw new Error("gate: reconciled external result requires receipts");
      op.state = command.outcome;
      op.receipts = command.receipts;
      break;
    }
  }
  s.revision += 1;
  return ExecutionStateSchema.parse(s);
}

/** Accept structured adapter evidence, including an ACP retry notification
 * still pending when the prompt ended. A notification has no JSON-RPC code. */
export function typedProviderFailure(outcome: z.infer<typeof TerminalOutcomeSchema>): boolean {
  const cause = outcome.cause;
  if (!cause) return false;
  if ((outcome.kind === "failed" || outcome.kind === "timed_out") && cause.backend === "opencode"
    && cause.code === null && cause.evidence_line === "ACP opencode/retry was pending when the prompt stopped") {
    const data = cause.data as { error?: { type?: unknown } } | undefined;
    if (data?.error?.type !== cause.error_name) return false;
    switch (cause.error_name) {
      case "provider.auth": case "provider.quota": return cause.class === "account_action";
      case "provider.rate-limit": return cause.class === "rate_limit";
      case "provider.no-route": case "provider.transport": return cause.class === "route_unavailable";
      case "provider.internal": return cause.class === "provider_internal";
      default: return false;
    }
  }
  if (outcome.kind !== "failed") return false;
  if (cause.code === -32000 && cause.error_name === "provider.auth" && cause.class === "account_action") return true;
  const data = cause.data as { service?: unknown; errorName?: unknown } | undefined;
  return cause.code === -32603 && data?.service === "session" && data.errorName === cause.error_name
    && ["provider.quota", "provider.rate-limit", "provider.no-route", "provider.transport", "provider.internal"].includes(cause.error_name ?? "")
    && cause.class !== "diagnostic";
}

/** Recognize exact archived ACP failure envelopes, not empty stdout or prose
 * anywhere in a task result. Ambiguous legacy failures remain held for diagnosis. */
export function providerRecoveryDiagnosis(outcome: z.infer<typeof TerminalOutcomeSchema>): z.infer<typeof recoveryPermitFields.diagnosis> | null {
  if (typedProviderFailure(outcome)) {
    const name = outcome.cause?.error_name;
    return name === "provider.auth" ? "provider_authentication" : name === "provider.quota" ? "provider_quota" : "provider_route_unavailable";
  }
  if (outcome.kind === "failed" && /^acp session\/(?:prompt|new|set_model) failed: Authentication required[:.] provider authentication required\s*$/i.test(outcome.stderr_tail.trim())) return "provider_authentication";
  // Archived LiteLLM routing failures identify an unavailable route, not a
  // quota or authentication cause. The recovery command still needs a fresh
  // request receipt and the original attempt's lifecycle fences.
  if (outcome.kind === "failed" && /^acp session\/prompt failed: Internal error: No deployments available for selected model, Try again in \d+ seconds\. Passed model=[\w./:-]+\. pre-call-checks=(?:True|False), cooldown_list=\[(?:'[a-f0-9]{64}'(?:, '[a-f0-9]{64}')*)?\]$/.test(outcome.stderr_tail.trim())) {
    return "provider_route_unavailable";
  }
  return null;
}

export function recoveryPermitCoversAttempt(state: ExecutionState, now: number): boolean {
  const p = state.recovery_permit, a = state.attempt;
  return !!p && validRecoveryRequestProof(p.proof, p.diagnosis) && p.phase === "available" && !!a && a.phase === "quiesced"
    && p.generation === a.generation && p.attempt_id === a.attempt_id
    && p.checkpoint_commit === (a.checkpoint?.commit ?? null)
    && JSON.stringify(p.terminal) === JSON.stringify(state.terminal)
    && p.proof.observed_at <= now && now - p.proof.observed_at <= 300_000
    && !state.operations.some(op => op.state === "prepared" || op.state === "outcome_unknown");
}

export function recoveryPermitMatches(state: ExecutionState, capability: Pick<ExecutorCapabilities,"backend"|"model"|"config_revision">, host: string, revision: string, now: number): boolean {
  const p = state.recovery_permit;
  return recoveryPermitCoversAttempt(state, now) && !!p && p.task_revision === revision
    && p.proof.host === host && p.proof.backend === capability.backend
    && p.proof.model === capability.model && p.proof.config_revision === capability.config_revision;
}

/** Cumulative history is immutable; admission is bounded within an explicit
 * changed strategy. Time, aliases, sessions and arbitrary edits grant nothing. */
export function executionAttemptBudgetExhausted(state: ExecutionState, taskRevision = "legacy"): boolean {
  const strategy = state.retry_strategy;
  if (!strategy) return state.budget_exhaustions >= 3;
  return strategy.task_revision !== taskRevision || strategy.failures >= 3;
}
export function openLargerModelStrategy(state: ExecutionState, tier: ReasoningTier, reason: string,
  source: "executor" | "independent_review", taskRevision: string): void {
  const tiers: ReasoningTier[] = ["small","medium","large"];
  const floor = Math.max(tiers.indexOf(state.delivery?.tier ?? "small"), tiers.indexOf(state.attempt?.executor?.tier ?? "small"),
    tiers.indexOf(state.retry_strategy?.minimum_tier ?? "small"));
  if (tiers.indexOf(tier) < tiers.indexOf(state.requirements.tier) || tiers.indexOf(tier) <= floor) throw new Error("gate: new retry strategy must strictly increase the diagnosed reasoning tier");
  state.retry_strategy = {kind:"larger_model",epoch:(state.retry_strategy?.epoch ?? 0)+1,task_revision:taskRevision,
    minimum_tier:tier,first_generation:state.generation+1,failures:0,reason,source};
}
export function executionNeedsRecoveryPermit(state: ExecutionState, revision: string): boolean {
  const hold = executionAdmissionHold(state, revision);
  return hold === "provider_route" || hold === "retry_budget";
}

/** Intrinsic attempt fences precede gateway availability. A compatible
 * gateway alone cannot clear any of these conditions. */
export function executionAdmissionHold(state: ExecutionState | undefined, revision: string):
  "writer_not_quiescent" | "unknown_operations" | "provider_route" | "retry_budget" | null {
  if (!state) return null;
  if (state.attempt && state.attempt.phase !== "quiesced") return "writer_not_quiescent";
  if (state.operations.some(op => op.state === "prepared" || op.state === "outcome_unknown")) return "unknown_operations";
  const { attempt, terminal } = state;
  if (attempt && terminal && terminal.generation === attempt.generation && terminal.attempt_id === attempt.attempt_id
    && !(state.retry_strategy?.task_revision === revision && attempt.generation < state.retry_strategy.first_generation)
    && providerRecoveryDiagnosis(terminal.outcome) === "provider_route_unavailable") return "provider_route";
  if (executionAttemptBudgetExhausted(state, revision)) return "retry_budget";
  return null;
}

export function chargeExecutionFailure(state: ExecutionState, generation: number): void {
  if (state.failure_charged_generation !== null && state.failure_charged_generation >= generation) return;
  state.failure_charged_generation = generation;
  state.budget_exhaustions += 1;
  if (state.retry_strategy && generation >= state.retry_strategy.first_generation) state.retry_strategy.failures += 1;
}

/** Stored command results prove a prior timeout charge; merely being stopping
 * never does (it may be an interrupt or an unresolved external operation). */
export function legacyTimeoutChargeGeneration(state: ExecutionState, begun: ExecutionState | null, polls: ExecutionState[]): number | null {
  const a=state.attempt;
  if (state.failure_charged_generation !== null || !a || !begun?.attempt || begun.attempt.generation !== a.generation || begun.attempt.attempt_id !== a.attempt_id) return null;
  return polls.some(p => p.attempt?.generation === a.generation && p.attempt.attempt_id === a.attempt_id
    && p.attempt.phase === "stopping" && p.budget_exhaustions > begun.budget_exhaustions) ? a.generation : null;
}
