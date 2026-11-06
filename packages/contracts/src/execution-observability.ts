import { z } from "zod";
import { ExecutionRequirementsSchema, ModelCapabilitySchema, ReasoningTierSchema, type ExecutionCommand, type ExecutionState } from "./execution.ts";

export const ExecutionModelIdentitySchema = ModelCapabilitySchema.pick({ tier: true, model: true, backend: true });
const identity = ExecutionModelIdentitySchema.shape;
const InteractiveExecutionMarkerSchema = z.object({ kind: z.literal("interactive"), session: z.string().min(1) });
export const ExecutionModelViewSchema = z.object({
  minimum_tier: ReasoningTierSchema.nullable(),
  current: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("unreported") }),
    z.object({ kind: z.literal("managed"), ...identity, host: z.string(), session: z.string(), generation: z.number(), lease_until: z.number(),
      phase: z.enum(["running", "restoring", "stopping", "quiesced", "expired", "previous", "paused"]) }),
    z.object({ kind: z.literal("local"), ...identity, host: z.string(), session: z.string(), phase: z.enum(["active", "paused", "previous"]) }),
    z.object({ kind: z.literal("interactive"), session: z.string(), phase: z.enum(["active", "paused", "previous"]) }),
  ]),
});
export type ExecutionModelView = z.infer<typeof ExecutionModelViewSchema>;

/** Only a recorded executor proves actual model size. Requirements/config do not. */
export function projectExecutionModel(state: ExecutionState | null, task: { status: string; session?: string; requirements?: unknown; interactive_execution?: unknown }, now: number): ExecutionModelView {
  const required = ExecutionRequirementsSchema.safeParse(task.requirements ?? state?.requirements);
  const minimum_tier = required.success ? required.data.tier : null;
  const interactive = InteractiveExecutionMarkerSchema.safeParse(task.interactive_execution);
  if (interactive.success && interactive.data.session === task.session) {
    return { minimum_tier, current: { kind: "interactive", session: interactive.data.session,
      phase: ["done", "superseded", "in_review"].includes(task.status) ? "previous" : task.status === "in_progress" ? "active" : "paused" } };
  }
  if (state?.handoff.phase === "accepted") {
    const h = state.handoff;
    return { minimum_tier, current: { kind: "interactive", session: h.session,
      phase: task.session !== h.session || ["done", "superseded", "in_review"].includes(task.status) ? "previous" : task.status === "in_progress" ? "active" : "paused" } };
  }
  const a = state?.attempt;
  if (!a?.executor) return { minimum_tier, current: { kind: "unreported" } };
  const phase = a.phase === "quiesced" ? "quiesced" : a.lease_until <= now ? "expired" : task.session !== a.session ? "previous" : task.status !== "in_progress" ? "paused" : a.phase;
  return { minimum_tier, current: { kind: "managed", ...ExecutionModelIdentitySchema.parse(a.executor), host: a.host, session: a.session, generation: a.generation, lease_until: a.lease_until, phase } };
}

export type DisplayModelSize = "small" | "medium" | "large" | "custom" | "unknown";
export function executionPresentation(view: ExecutionModelView, now: number) {
  const current = view.current;
  const size: DisplayModelSize = current.kind === "unreported" ? "unknown" : current.kind === "managed" ? current.tier : "custom";
  const phase = current.kind === "managed" && !["quiesced", "previous"].includes(current.phase) && current.lease_until <= now ? "expired"
    : current.kind === "unreported" ? "unreported" : current.phase;
  const requested = current.kind === "managed" && view.minimum_tier && ["small", "medium", "large"].indexOf(view.minimum_tier) > ["small", "medium", "large"].indexOf(current.tier) ? view.minimum_tier : null;
  const state = phase === "expired" ? "lease expired" : phase === "quiesced" ? "quiescent" : phase === "previous" ? "previous execution" : phase === "active" ? "interactive" : phase;
  return { size, requested, state, phase };
}

export const ExecutionHistoryEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("model_started"), ...identity, generation: z.number(), host: z.string(), session: z.string() }),
  z.object({ kind: z.literal("model_escalated"), from_tier: ReasoningTierSchema, to_tier: ReasoningTierSchema, reason: z.string(),
    source: z.enum(["agent", "review"]), review_id: z.string().nullable(), generation: z.number() }),
  z.object({ kind: z.literal("execution_yielded"), generation: z.number(), destination: z.enum(["agent_pool", "local"]), minimum_tier: ReasoningTierSchema, checkpoint_commit: z.string() }),
  z.object({ kind: z.literal("local_handoff_requested"), handoff_id: z.string(), reason: z.string(), action: z.string(), next: z.string() }),
  z.object({ kind: z.literal("local_handoff_accepted"), handoff_id: z.string(), ...identity, host: z.string(), session: z.string() }),
  z.object({ kind: z.literal("local_handoff_returned"), handoff_id: z.string(), checkpoint_commit: z.string() }),
]);
export type ExecutionHistoryEvent = z.infer<typeof ExecutionHistoryEventSchema>;

export function executionCommandHistory(before: ExecutionState, after: ExecutionState, command: ExecutionCommand): ExecutionHistoryEvent | null {
  const a = after.attempt;
  switch (command.kind) {
    case "begin": return a?.executor ? { kind: "model_started", ...ExecutionModelIdentitySchema.parse(a.executor), generation: a.generation, host: a.host, session: a.session } : null;
    case "escalate": return { kind: "model_escalated", from_tier: before.attempt?.executor?.tier ?? before.requirements.tier,
      to_tier: command.tier, reason: command.reason, source: "agent", review_id: null, generation: before.generation };
    case "yield": return a?.checkpoint ? { kind: "execution_yielded", generation: a.generation, destination: after.handoff.phase === "waiting" ? "local" : "agent_pool", minimum_tier: after.requirements.tier, checkpoint_commit: a.checkpoint.commit } : null;
    case "local_handoff": return after.handoff.phase === "preparing" ? { kind: "local_handoff_requested", handoff_id: after.handoff.id,
      reason: command.reason, action: command.action, next: command.next } : null;
    default: return null; // polls/heartbeats/checkpoints are not user-facing history noise
  }
}

export function executionHistorySummary(event: ExecutionHistoryEvent): string {
  switch (event.kind) {
    case "model_started": return `Started ${event.tier} model ${event.model ?? "(ID unreported)"} via ${event.backend} on ${event.host} · session ${event.session} · attempt ${event.generation}`;
    case "model_escalated": return `Escalated ${event.from_tier} → ${event.to_tier} (${event.source === "review" ? `review ${event.review_id}` : "agent requested"}): ${event.reason}`;
    case "execution_yielded": return `Yielded to ${event.destination === "local" ? "local pickup" : "the agent pool"}; requires ${event.minimum_tier}; checkpoint ${event.checkpoint_commit}`;
    case "local_handoff_requested": return `Local pickup required: ${event.action}. Why: ${event.reason}. Next: ${event.next}`;
    case "local_handoff_accepted": return `Local pickup accepted by ${event.session} on ${event.host}; model configured locally (${event.model ?? "ID unreported"})`;
    case "local_handoff_returned": return `Returned to autonomous execution; checkpoint ${event.checkpoint_commit}`;
  }
}
