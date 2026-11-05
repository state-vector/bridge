/** Durable executor protocol, v1. Transport activity is not action progress. */
import { z } from "zod";

export const EXECUTION_POLICY_VERSION = 1;
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
export const ExecutorCapabilitiesSchema = z.object({
  tier: ReasoningTierSchema,
  tools: z.array(text),
  environment: z.array(text),
  backend: z.enum(["opencode", "kiro"]).default("opencode"),
  model: z.string().nullable().default(null),
  config_revision: text.default("legacy"),
  capacity: z.number().int().min(1).max(64).default(1),
});
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
});
export type ExecutionState = z.infer<typeof ExecutionStateSchema>;
export function initialExecution(requirements: ExecutionRequirements = ExecutionRequirementsSchema.parse({})): ExecutionState {
  return { policy_version: EXECUTION_POLICY_VERSION, revision: 0, generation: 0, attempt: null, requirements, messages: [], operations: [], budget_exhaustions: 0 };
}

export const ExecutionCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inspect") }),
  z.object({ kind: z.literal("availability") }),
  z.object({ kind: z.literal("advertise"), capabilities: ExecutorCapabilitiesSchema }),
  z.object({ kind: z.literal("begin"), attempt_id: text, worker: text, action_budget_ms: z.number().int().min(10_000).max(3_600_000) }),
  z.object({ kind: z.literal("poll"), ...FenceSchema.shape }),
  z.object({ kind: z.literal("restore"), ...FenceSchema.shape, tree: sha, commit: sha }),
  z.object({ kind: z.literal("checkpoint"), ...FenceSchema.shape, checkpoint: CheckpointSchema }),
  z.object({ kind: z.literal("quiesce"), ...FenceSchema.shape, writers: z.literal("process_group_empty") }),
  z.object({ kind: z.literal("yield"), ...FenceSchema.shape }),
  z.object({ kind: z.literal("message"), message_id: text, text, priority: z.enum(["normal", "interrupt"]) }),
  z.object({ kind: z.literal("ack"), ...FenceSchema.shape, message_id: text, state: z.enum(["acknowledged", "acted"]) }),
  z.object({ kind: z.literal("escalate"), ...FenceSchema.shape, tier: ReasoningTierSchema, reason: text }),
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
    case "inspect": case "availability": case "advertise": return s;
    case "begin": {
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
      s.attempt = a?.checkpoint
        ? { ...common, phase: "restoring", checkpoint: a.checkpoint, restored_tree: null }
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
