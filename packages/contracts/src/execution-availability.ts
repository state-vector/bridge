import { z } from "zod";
import type { WorkerOccupancy } from "./worker-status.ts";
import { capabilityBlockers, ExecutionBlockerSchema, ExecutionRequirementsSchema, LocalHandoffSchema, type ExecutionBlocker, type ExecutionRequirements, type ExecutorCapabilities, type LocalHandoff } from "./execution.ts";
import type { ExecutorReadiness } from "./executor-readiness.ts";
export type { ExecutorReadiness } from "./executor-readiness.ts";

export const ExecutionAttentionSchema = z.object({
  workspace: z.string().default("state-vector"),
  items: z.array(z.object({ id: z.string(), title: z.string(), project: z.string(), status: z.string(), url: z.string(),
    handoff: LocalHandoffSchema, requirements: ExecutionRequirementsSchema, blockers: z.array(ExecutionBlockerSchema), continuation_prompt: z.string().nullable(),
    can_accept: z.boolean(), prerequisites: z.array(z.string()), accept_operation: z.literal("handoff_accept") })),
  next_cursor: z.string().nullable(), interactive_agents: z.array(z.object({ label: z.string() })),
});
export type ExecutionAttention = z.infer<typeof ExecutionAttentionSchema>;
export type ExecutionAttentionItem = ExecutionAttention["items"][number];

export function isExecutorAvailabilityBlocker(blocker: ExecutionBlocker): blocker is Extract<ExecutionBlocker, { kind: "capability_unavailable" | "executor_not_ready" }> {
  return blocker.kind === "capability_unavailable" || blocker.kind === "executor_not_ready";
}
export interface CapabilityObservation { host: string; capabilities: ExecutorCapabilities; observed_at: number; active: number; readiness?: ExecutorReadiness; occupancy?: WorkerOccupancy }
export function usableFor(required: ExecutionRequirements, capability: ExecutorCapabilities | ExecutorCapabilities["alternatives"][number], host: string, project: string): boolean {
  return capability.availability.kind === "usable" && capability.model !== null && capability.projects.some(p => p === "*" || p === project)
    && capabilityBlockers(required, capability, host).length === 0;
}
export function strengthensRequirements(before: ExecutionRequirements, after: ExecutionRequirements): boolean {
  const tiers = ["small", "medium", "large"];
  return tiers.indexOf(after.tier) >= tiers.indexOf(before.tier) && before.tools.every(t => after.tools.includes(t))
    && before.environment.every(e => after.environment.includes(e)) && (!before.host || before.host === after.host);
}
export function projectExecutionBlockers(input: {
  id: string; project: string; requirements: ExecutionRequirements; handoff: LocalHandoff;
  hosts: CapabilityObservation[]; asks: { id: string; question: string }[]; now: number;
  local?: { host: string; capabilities: ExecutorCapabilities };
}): ExecutionBlocker[] {
  const { id, project, requirements, handoff, now } = input;
  const key = `capability:${id}:${JSON.stringify(requirements)}`;
  const configured = input.hosts.flatMap(h => [h.capabilities, ...h.capabilities.alternatives].map(c => ({ ...h, capabilities: c })))
    .filter(h => h.capabilities.availability.kind !== "disabled" && h.capabilities.projects.some(p => p === "*" || p === project)
      && capabilityBlockers(requirements, h.capabilities, h.host).length === 0);
  const live = configured.filter(h => now - h.observed_at < 120_000);
  const usable = live.filter(h => h.capabilities.availability.kind === "usable" && h.capabilities.model !== null && (!h.readiness || h.readiness.kind === "ready"));
  const localReady = input.local && !capabilityBlockers(requirements, input.local.capabilities, input.local.host).length
    && input.local.capabilities.model !== null && input.local.capabilities.availability.kind === "usable"
    && input.local.capabilities.projects.some(p => p === "*" || p === project);
  const blockers: ExecutionBlocker[] = [];
  if (!localReady && !usable.length) {
    const causes = live.flatMap(h => h.readiness && h.readiness.kind !== "ready" ? [{ host: h.host, readiness: h.readiness }] : []);
    if (causes.length) blockers.push({ kind: "executor_not_ready", episode_id: `readiness:${id}:${JSON.stringify(requirements)}`,
      text: [...new Set(causes.map(c => `${c.host}: ${c.readiness.reason}`))].join(" "), causes,
      evidence: [...new Set(live.map(h => `${h.host}: last seen ${h.observed_at}; config ${h.capabilities.config_revision}`))] });
    const reason = !configured.length ? "not_configured" : !live.length ? "offline" : "unavailable";
    const modelCauses = [...new Set(live.filter(h => !h.readiness || h.readiness.kind === "ready").flatMap(h => h.capabilities.availability.kind === "unavailable" ? [h.capabilities.availability.reason] : []))];
    if (!causes.length || modelCauses.length) {
    blockers.push({ kind: "capability_unavailable", episode_id: key, reason,
      text: reason === "not_configured" ? `No gateway configured for ${requirements.tier} reasoning and the required scope.`
        : reason === "offline" ? `The last supporting gateway for ${requirements.tier} reasoning is offline.`
        : modelCauses.length ? modelCauses.join(" ") : `Supporting gateways report the required model/capability unavailable.`,
      evidence: configured.map(h => `${h.host}: last seen ${h.observed_at}; config ${h.capabilities.config_revision}; model ${h.capabilities.model ?? "unreported"}${h.capabilities.availability.kind === "unavailable" ? `; ${h.capabilities.availability.reason}` : ""}`) });
    }
  } else if (!localReady && usable.every(h => h.active >= h.capabilities.capacity)) {
    blockers.push({ kind: "capacity_wait", episode_id: `capacity:${id}`, text: usable.some(h => (h.occupancy?.unconfirmed ?? 0) > 0)
      ? "Capacity held for unconfirmed executions; the gateway must reconcile stopped process groups."
      : "Capable gateways are busy; waiting for capacity." });
  }
  for (const ask of input.asks) blockers.push({ kind: "human_answer_required", episode_id: `ask:${ask.id}`, ask_id: ask.id, text: ask.question });
  if (handoff.phase === "preparing") blockers.push({ kind: "writer_quiescence_required", episode_id: handoff.id, text: "Waiting for the old writer to stop before local pickup." });
  if (handoff.phase === "waiting") blockers.push({ kind: "local_pickup_required", episode_id: handoff.id, handoff_id: handoff.id, version: handoff.version, text: `Pick up locally: ${handoff.action}` });
  return blockers;
}

export function continuationPrompt(task: { id: string; title: string; url: string }, handoff: Exclude<LocalHandoff, { phase: "none" }>, requirements: ExecutionRequirements): string {
  const pickup = handoff.phase === "preparing"
    ? "Wait for confirmation that the previous writer stopped before starting work."
    : "Start fresh from the repository and task history. Create and register a fresh isolated worktree.";
  return `${task.id}: ${task.title}\n${task.url}\n\nLocal handoff ${handoff.id}, version ${handoff.version}\nReason: ${handoff.reason}\nRequested action: ${handoff.action}\nFindings: ${handoff.findings}\nTried: ${handoff.tried}\nEvidence:\n${handoff.evidence.join("\n")}\nApprovals/unresolved decisions:\n${handoff.approvals.join("\n")}\n\n${pickup}\nRequired capabilities: ${JSON.stringify(requirements)}\nRemaining work / next: ${handoff.next}\n\nName a unique interactive session and orient. Human-directed agents with a live full-agent credential claim directly: transition {id:"${task.id}",to:"in_progress",session:"<your session>",note:"Human-directed local pickup"}. No additional human-web grant is required. The hub checks original-writer quiescence, completed preparation and outstanding human decisions atomically; satisfy any named prerequisite before executing. Listing, copying, or answering an ask never claims the task. Record findings and stop local writers before releasing with transition {id:"${task.id}",to:"todo",session:"<your session>",note:"<done/next and work location>"}. The separate capability-grant handoff_accept / human-authorised return flow remains available when explicitly chosen.`;
}
