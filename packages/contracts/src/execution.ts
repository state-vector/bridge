/** Durable executor protocol, v1. Transport activity is not action progress. */
import { z } from "zod";
import { StartupWaitSchema } from "./startup.ts";

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
export function nextExecutorStartBarrier(previous: ExecutorStartBarrier | null, fingerprint: string, reason: string, now: number, failureClass: "transport" | "prerequisite" = "transport"): ExecutorStartBarrier {
  const failures = previous?.fingerprint === fingerprint ? previous.failures + 1 : 1;
  return ExecutorStartBarrierSchema.parse(failureClass === "prerequisite" || failures >= 3
    ? { kind: "repair_required", fingerprint, failures, reason }
    : { kind: "cooldown", fingerprint, failures, until_ts: now + 60_000 * failures, reason });
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
export const ExecutorCapabilitiesSchema = ModelCapabilitySchema.extend({ alternatives: z.array(ModelCapabilitySchema).max(20).default([]), worker: WorkerReadinessSchema.default({ kind: "unprovisioned" }) });
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
  z.object({ phase: z.literal("waiting"), ...HandoffDetails, checkpoint: CheckpointSchema, quiescence: QuiescenceProofSchema }),
  z.object({ phase: z.literal("accepted"), ...HandoffDetails, checkpoint: CheckpointSchema,
    token_id: text, session: text, host: text, accepted_at: z.number(), grant_id: text, capabilities: ExecutorCapabilitiesSchema, quiescence: QuiescenceProofSchema }),
  z.object({ phase: z.literal("returned"), ...HandoffDetails, checkpoint: CheckpointSchema, returned_at: z.number(), by: text, quiescence: QuiescenceProofSchema }),
]);
export type LocalHandoff = z.infer<typeof LocalHandoffSchema>;
export const LocalGrantSchema = z.object({
  id: text, task_id: text, handoff_id: text, version: z.number().int().positive(),
  token_id: text, session: text, host: text, by: text, expires_at: z.number(),
  source: z.literal("human_attested"), evidence: text, capabilities: ExecutorCapabilitiesSchema,
});
export type LocalGrant = z.infer<typeof LocalGrantSchema>;
export const ExecutionBlockerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("startup_wait"), episode_id: text, text, wait: StartupWaitSchema }),
  z.object({ kind: z.literal("capability_unavailable"), episode_id: text, reason: z.enum(["not_configured", "offline", "unavailable"]), text, evidence: z.array(text) }),
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
  z.object({ kind: z.literal("confirm_preparation"), id: text, handoff_id: text, version: z.number().int().positive(), checkpoint: CheckpointSchema, evidence: text, writers: z.literal("human_confirmed_quiescent") }),
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
export const AttemptSchema = z.discriminatedUnion("phase", [
  z.object({ ...AttemptFields, phase: z.literal("restoring"), checkpoint: CheckpointSchema, restored_tree: z.null() }),
  z.object({ ...AttemptFields, phase: z.literal("running"), checkpoint: CheckpointSchema.nullable(), restored_tree: sha.nullable() }),
  z.object({ ...AttemptFields, phase: z.literal("stopping"), checkpoint: CheckpointSchema.nullable(), restored_tree: sha.nullable() }),
  z.object({ ...AttemptFields, phase: z.literal("quiesced"), checkpoint: CheckpointSchema.nullable(), restored_tree: sha.nullable() }),
]);
export type ExecutionAttempt = z.infer<typeof AttemptSchema>;
export const ExecutionStateSchema = z.object({
  policy_version: z.literal(EXECUTION_POLICY_VERSION),
  revision: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative(),
  attempt: AttemptSchema.nullable(),
  requirements: ExecutionRequirementsSchema,
  messages: z.array(MessageSchema),
  operations: z.array(OperationSchema),
  budget_exhaustions: z.number().int().nonnegative().default(0),
  handoff: LocalHandoffSchema.default({ phase: "none" }),
});
export type ExecutionState = z.infer<typeof ExecutionStateSchema>;
export function initialExecution(requirements: ExecutionRequirements = ExecutionRequirementsSchema.parse({})): ExecutionState {
  return { policy_version: EXECUTION_POLICY_VERSION, revision: 0, generation: 0, attempt: null, requirements, messages: [], operations: [], budget_exhaustions: 0, handoff: { phase: "none" } };
}

export const ExecutionCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pause_claims"), reason: text, budget_ms: z.number().int().min(10_000).max(300_000) }),
  z.object({ kind: z.literal("resume_claims") }),
  z.object({ kind: z.literal("inspect") }),
  z.object({ kind: z.literal("availability") }),
  z.object({ kind: z.literal("advertise"), capabilities: ExecutorCapabilitiesSchema }),
  z.object({ kind: z.literal("begin"), attempt_id: text, worker: text, action_budget_ms: z.number().int().min(10_000).max(3_600_000) }),
  z.object({ kind: z.literal("start_failed"), stage: z.enum(["inspect", "begin"]), reason: text, retained_work: z.boolean(), failure_class: z.enum(["transport", "prerequisite"]).default("prerequisite") }),
  z.object({ kind: z.literal("recover_unstarted"), writers: z.literal("not_launched"), retained_work: z.literal(true) }),
  z.object({ kind: z.literal("poll"), ...FenceSchema.shape }),
  z.object({ kind: z.literal("restore"), ...FenceSchema.shape, tree: sha, commit: sha }),
  z.object({ kind: z.literal("checkpoint"), ...FenceSchema.shape, checkpoint: CheckpointSchema }),
  z.object({ kind: z.literal("quiesce"), ...FenceSchema.shape, writers: z.literal("process_group_empty") }),
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
export function reduceExecution(previous: ExecutionState, command: ExecutionCommand, host: string, session: string, now: number): ExecutionState {
  const s = structuredClone(previous);
  const a = s.attempt;
  const requireAttempt = (allowExpired = false): ExecutionAttempt => {
    if (!("generation" in command) || !a || command.generation !== a.generation || command.attempt_id !== a.attempt_id || a.host !== host || a.session !== session) {
      throw new Error("gate: execution attempt fenced — stop, preserve local work, do not push");
    }
    if (!allowExpired && (a.lease_until <= now || a.phase === "quiesced")) throw new Error("gate: execution lease expired or quiesced");
    return a;
  };
  switch (command.kind) {
    case "inspect": case "availability": case "advertise": case "pause_claims": case "resume_claims": return s;
    case "start_failed": {
      if (a && a.phase !== "quiesced") throw new Error("gate: failed start cannot release an unquiesced writer");
      return s; // the authenticated coordinator owns the atomic task release
    }
    case "recover_unstarted": {
      if (a) throw new Error("gate: legacy unstarted recovery cannot erase an execution attempt");
      return s;
    }
    case "begin": {
      if (!["none", "returned"].includes(s.handoff.phase)) throw new Error("gate: local handoff owns execution; autonomous dispatch is forbidden");
      if (s.budget_exhaustions >= 3) throw new Error("gate: action retry budget exhausted; diagnose/reconcile instead of restarting again");
      if (a && a.phase !== "quiesced") throw new Error("gate: previous writer requires quiescence acknowledgement; retain host affinity");
      if (s.operations.some(x => x.state === "prepared" || x.state === "outcome_unknown")) throw new Error("gate: reconcile unknown external operations before another attempt");
      if (a && a.host !== host && !a.checkpoint) throw new Error("gate: cross-host transfer requires a published checkpoint");
      s.generation += 1;
      const common = {
        generation: s.generation, attempt_id: command.attempt_id, host, session,
        lease_until: now + EXECUTION_LEASE_MS,
        action_deadline: now + command.action_budget_ms,
        executor: null,
      };
      const checkpoint = a?.checkpoint ?? (s.handoff.phase === "returned" ? s.handoff.checkpoint : null);
      s.attempt = checkpoint
        ? { ...common, phase: "restoring", checkpoint, restored_tree: null }
        : { ...common, phase: "running", checkpoint: null, restored_tree: null };
      break;
    }
    case "poll": {
      const current = requireAttempt();
      if (current.action_deadline <= now && current.phase !== "stopping") {
        s.budget_exhaustions += 1;
        // The budget belongs to the task, not a session/host/model. Exhaustion
        // demands diagnosis; only an explicit escalate command selects a tier.
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
    case "yield": {
      const current = requireAttempt(true);
      if (current.phase !== "quiesced" || !current.checkpoint) throw new Error("gate: yield requires a published checkpoint and quiescent writer");
      if (s.operations.some(x => x.state === "prepared" || x.state === "outcome_unknown")) throw new Error("gate: reconcile pending external operations before yielding");
      if (s.handoff.phase === "preparing") s.handoff = { ...s.handoff, phase: "waiting", checkpoint: current.checkpoint, quiescence: { kind: "runner", host, generation: current.generation } };
      break;
    }
    case "message": {
      if (!s.messages.some(x => x.id === command.message_id)) {
        if (s.messages.filter(x => x.state !== "acted").length >= 100) throw new Error("gate: execution mailbox full");
        if (s.messages.length >= 1000) throw new Error("gate: mailbox history budget exhausted; reconcile before adding messages");
        s.messages.push({ id: command.message_id, text: command.text, priority: command.priority, state: "queued" });
      }
      if (a && a.phase !== "quiesced" && command.priority === "interrupt") a.phase = "stopping";
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
      if (tiers.indexOf(command.tier) <= tiers.indexOf(s.requirements.tier)) throw new Error("gate: escalation must increase the persistent minimum reasoning tier");
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
      if (current.phase !== "running" || s.messages.some(x => x.priority === "interrupt" && x.state !== "acted")) throw new Error("gate: pending interruption prevents external mutations");
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
