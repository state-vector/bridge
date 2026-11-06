import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_POLICY, ExecutorCapabilitiesSchema, ExecutionRequirementsSchema, ModelPolicySchema, nextAvailableTier, selectModelTier, type CapabilityObservation, type ReasoningTier } from "../src/index.ts";

const now = 1_000_000;
const host = (tier: ReasoningTier, extra: Partial<CapabilityObservation> = {}): CapabilityObservation => ({
  host: `gateway-${tier}`, observed_at: now, active: 0,
  capabilities: ExecutorCapabilitiesSchema.parse({ tier, model: `test/${tier}`, tools: [], environment: [] }), ...extra,
});
const choose = (lane: "analysis" | "impl" | "verify", hosts: CapabilityObservation[], minimum: ReasoningTier = "small", verification_floor?: ReasoningTier) =>
  selectModelTier({ lane, hosts, project: "bridge", policy: DEFAULT_MODEL_POLICY, required: ExecutionRequirementsSchema.parse({ tier: minimum }), verification_floor, now });

describe("global lane policy", () => {
  it("uses the largest for analysis, smallest for implementation, and busy supply remains available", () => {
    const hosts = [host("medium"), host("large", { active: 64 })];
    expect(choose("analysis", hosts)).toEqual({ kind: "selected", tier: "large" });
    expect(choose("impl", hosts)).toEqual({ kind: "selected", tier: "medium" });
    expect(choose("impl", [host("small"), ...hosts])).toEqual({ kind: "selected", tier: "small" });
  });
  it("verification never runs below the actual implementation tier", () => {
    const hosts = [host("small"), host("medium"), host("large")];
    expect(choose("verify", hosts, "small", "medium")).toEqual({ kind: "selected", tier: "medium" });
    expect(choose("verify", hosts, "small", "large")).toEqual({ kind: "selected", tier: "large" });
    expect(choose("verify", [host("small")], "small", "large")).toEqual({ kind: "unavailable", minimum: "large" });
  });
  it("does not relax explicit requirements and ignores expired/unusable/out-of-scope inventory", () => {
    expect(choose("analysis", [host("medium"), host("large", { observed_at: now - 120_000 })])).toEqual({ kind: "selected", tier: "medium" });
    expect(choose("impl", [host("medium")], "large")).toEqual({ kind: "unavailable", minimum: "large" });
    const unusable = host("large"); unusable.capabilities.availability = { kind: "unavailable", reason: "provider unavailable" };
    const scoped = host("large"); scoped.capabilities.projects = ["other"];
    expect(choose("analysis", [host("medium"), unusable, scoped])).toEqual({ kind: "selected", tier: "medium" });
  });
  it("resolves alternative models, global overrides, and skips missing escalation rungs", () => {
    const gateway = host("small"); gateway.capabilities.alternatives = [host("large").capabilities];
    expect(choose("analysis", [gateway])).toEqual({ kind: "selected", tier: "large" });
    expect(nextAvailableTier("small", ["small", "large"])).toBe("large");
    expect(nextAvailableTier("large", ["small", "large"])).toBeNull();
    const policy = ModelPolicySchema.parse({ impl: { kind: "minimum", tier: "medium" } });
    expect(selectModelTier({ lane: "impl", policy, hosts: [host("small"), host("large")], required: ExecutionRequirementsSchema.parse({}), project: "bridge", now })).toEqual({ kind: "selected", tier: "large" });
    expect(ModelPolicySchema.safeParse({ analysis: { kind: "guess" } }).success).toBe(false);
  });
});
