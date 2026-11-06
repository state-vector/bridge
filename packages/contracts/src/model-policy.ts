import { z } from "zod";
import { ReasoningTierSchema, type ReasoningTier, type ExecutionRequirements } from "./execution.ts";
import { usableFor, type CapabilityObservation } from "./execution-availability.ts";

export const MODEL_TIERS: readonly ReasoningTier[] = ["small", "medium", "large"];
export function maxTier(a: ReasoningTier, b: ReasoningTier): ReasoningTier {
  return MODEL_TIERS.indexOf(a) >= MODEL_TIERS.indexOf(b) ? a : b;
}
const SelectionPolicySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("smallest_available") }),
  z.strictObject({ kind: z.literal("largest_available") }),
  z.strictObject({ kind: z.literal("minimum"), tier: ReasoningTierSchema }),
]);
/** Workspace-wide policy, never gateway configuration. Busy hosts still count. */
export const ModelPolicySchema = z.strictObject({
  analysis: SelectionPolicySchema.default({ kind: "largest_available" }),
  impl: SelectionPolicySchema.default({ kind: "smallest_available" }),
  verify: SelectionPolicySchema.default({ kind: "smallest_available" }),
});
export type ModelPolicy = z.infer<typeof ModelPolicySchema>;
export const DEFAULT_MODEL_POLICY = ModelPolicySchema.parse({});
export const TierSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("selected"), tier: ReasoningTierSchema }),
  z.object({ kind: z.literal("unavailable"), minimum: ReasoningTierSchema }),
]);
export type TierSelection = z.infer<typeof TierSelectionSchema>;

export function availableModelTiers(hosts: CapabilityObservation[], required: ExecutionRequirements, project: string, now: number): ReasoningTier[] {
  return MODEL_TIERS.filter(tier => hosts.some(h => now - h.observed_at < 120_000
    && (!h.readiness || h.readiness.kind === "ready")
    && [h.capabilities, ...h.capabilities.alternatives].some(c => c.tier === tier && usableFor(required, c, h.host, project))));
}

export function selectModelTier(input: {
  lane: "analysis" | "impl" | "verify"; policy: ModelPolicy; required: ExecutionRequirements;
  verification_floor?: ReasoningTier; hosts: CapabilityObservation[]; project: string; now: number;
}): TierSelection {
  const policy = input.policy[input.lane];
  const floor = maxTier(input.required.tier, input.verification_floor ?? "small");
  const minimum = policy.kind === "minimum" ? maxTier(floor, policy.tier) : floor;
  const tiers = availableModelTiers(input.hosts, { ...input.required, tier: minimum }, input.project, input.now);
  const tier = policy.kind === "largest_available" ? tiers[tiers.length - 1] : tiers[0];
  return tier ? { kind: "selected", tier } : { kind: "unavailable", minimum };
}

/** Optional escalation chooses a real larger tier, not an imaginary next rung. */
export function nextAvailableTier(current: ReasoningTier, available: ReasoningTier[]): ReasoningTier | null {
  return MODEL_TIERS.find(t => MODEL_TIERS.indexOf(t) > MODEL_TIERS.indexOf(current) && available.includes(t)) ?? null;
}
