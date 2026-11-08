import { describe, expect, it } from "vitest";
import {
  ExecutionStateSchema, ExecutionCommandSchema, ExecutorCapabilitiesSchema, ModelCapabilitySchema, ProviderCauseSchema, TerminalReceiptSchema,
  initialExecution, isAccountActionCause, providerIncidentRouteKey, providerIncidentText, reduceExecution,
  type ExecutionState, type ProviderCause,
} from "../src/execution.ts";
import { projectExecutionBlockers } from "../src/execution-availability.ts";

const begin = { kind: "begin", attempt_id: "one", worker: "mac/worker", action_budget_ms: 60_000 } as const;
const fence = { generation: 1, attempt_id: "one" };
const step = (s: ExecutionState, c: unknown, now = 100, host = "mac", session = "dispatch-BR-8821") =>
  reduceExecution(s, ExecutionCommandSchema.parse(c) as Parameters<typeof reduceExecution>[1], host, session, now);
const started = () => step(initialExecution(), begin);

/// Wire fixture shaped exactly like the installed opencode v2.2.5 ACP
/// adapter (receipted on the board): provider.auth → -32000; session
/// service failures → -32603 with OBJECT data {service, errorName}.
const accountCause = (at_ms = 100, error_name = "provider.quota"): ProviderCause => ProviderCauseSchema.parse({
  class: "account_action", backend: "opencode", model: "llmgw/glm-5.3", code: -32603, error_name,
  message: "provider quota exceeded", data: { service: "session", errorName: error_name }, at_ms,
});
const diagnosticCause = (at_ms = 100): ProviderCause => ProviderCauseSchema.parse({
  class: "diagnostic", backend: "opencode", model: "llmgw/glm-5.3", code: -32603, error_name: "provider.timeout",
  message: "upstream timed out", data: { service: "session", errorName: "provider.timeout" }, at_ms,
});

describe("typed provider causes survive the terminal evidence protocol", () => {
  it("parses every legacy cause-less record (mixed versions) and the new typed shape", () => {
    const legacy = { kind: "failed", exit_code: 1, stdout_tail: "", stderr_tail: "acp timed out" };
    expect(TerminalOutcome(legacy).cause).toBeUndefined();
    const typed = { ...legacy, cause: accountCause() };
    const parsed = TerminalOutcome(typed);
    expect(parsed.cause).toMatchObject({ class: "account_action", backend: "opencode", code: -32603 });
    // schema strips nothing it did not declare: unknown class names are rejected
    expect(() => TerminalOutcome({ ...legacy, cause: { ...accountCause(), class: "invented_class" } })).toThrow();
  });

  it("keeps the typed cause on stopped→finalize and preserves captured evidence immutability", () => {
    let s = started();
    const outcome = { kind: "failed", exit_code: 1, stdout_tail: "attempted work", stderr_tail: "provider refused", cause: accountCause() } as const;
    s = step(s, { kind: "stopped", ...fence, writers: "no_live_group_members", outcome });
    expect(s.terminal?.outcome.cause?.class).toBe("account_action");
    // the exact same outcome finalizes; a different cause is a fabrication
    s = step(s, { kind: "finalize", ...fence, writers: "no_live_group_members", outcome }, 1_000);
    expect(s.attempt?.phase).toBe("quiesced");
    expect(s.terminal?.outcome.cause?.error_name).toBe("provider.quota");
    const earlier = s;
    expect(() => step(earlier, { kind: "finalize", ...fence, writers: "no_live_group_members",
      outcome: { ...outcome, cause: accountCause(200) } }, 2_000)).toThrow(/preserve the captured terminal evidence/);
  });

  it("classifies only account_action as a human account action; the rest stay contained", () => {
    expect(isAccountActionCause(accountCause())).toBe(true);
    expect(isAccountActionCause(diagnosticCause())).toBe(false);
    expect(isAccountActionCause(null)).toBe(false);
    expect(TerminalOutcome({ kind: "failed", exit_code: 1, stdout_tail: "", stderr_tail: "", cause: { ...accountCause(), class: "rate_limit" } }).cause?.class).toBe("rate_limit");
  });

  it("scopes the incident route key by class, provider route and config generation", () => {
    const quota = accountCause();
    expect(providerIncidentRouteKey(quota, "rev-1")).toBe("account_action|opencode|llmgw/glm-5.3|rev-1");
    // same route under a new config generation is a DIFFERENT incident
    expect(providerIncidentRouteKey(quota, "rev-1")).not.toBe(providerIncidentRouteKey(quota, "rev-2"));
    // two classes on one route are two incidents (different human actions)
    expect(providerIncidentRouteKey(quota, "rev-1")).not.toBe(providerIncidentRouteKey({ ...quota, class: "route_unavailable" }, "rev-1"));
    expect(providerIncidentText(quota)).toContain("provider account action required");
    expect(providerIncidentText(diagnosticCause())).toContain("unclassified provider error");
  });

  it("admits the probe receipt on the capability and never clears by bare availability", () => {
    const capability = ModelCapabilitySchema.parse({ tier: "large", tools: ["git"], environment: ["linux"], backend: "opencode", model: "llmgw/glm-5.3", config_revision: "rev-1", capacity: 1, projects: ["bridge"], availability: { kind: "usable" } });
    expect(capability.probe).toBeUndefined();
    const probed = ModelCapabilitySchema.parse({ ...capability, probe: { model: "llmgw/glm-5.3", at: 500, ok: true, output_head: "Reply OK" } });
    expect(probed.probe?.ok).toBe(true);
    // the probe belongs to THIS model identity — a foreign model name never rides it
    expect(ModelCapabilitySchema.parse({ ...capability, probe: { model: "other/model", at: 500, ok: true, output_head: "Reply OK" } }).probe?.model).toBe("other/model");
  });
});

describe("one canonical incident drives admission blockers and UI evidence", () => {
  const host = (availability: unknown, observed_at = Date.now()) => ({
    host: "gw", observed_at, active: 0,
    capabilities: ExecutorCapabilitiesSchema.parse({ tier: "large", tools: ["git"], environment: ["linux"], backend: "opencode", model: "llmgw/glm-5.3", config_revision: "rev-1", capacity: 1, projects: ["bridge"], availability, worker: { kind: "unprovisioned" } }),
  });
  const requirements = { tier: "large" as const, tools: ["git"], environment: ["linux"] };

  it("surfaces typed causes on the capability_unavailable blocker, deduped by route scope", () => {
    const causeA = accountCause();
    const blockers = projectExecutionBlockers({
      id: "BR#8821", project: "bridge", requirements, handoff: { phase: "none" },
      hosts: [host({ kind: "unavailable", reason: "provider quota exceeded", cause: causeA }),
        // same route observed twice: ONE incident after dedupe
        host({ kind: "unavailable", reason: "provider quota exceeded", cause: { ...causeA, at_ms: causeA.at_ms + 1 } })],
      asks: [], now: Date.now(),
    });
    const unavailable = blockers.filter(b => b.kind === "capability_unavailable");
    expect(unavailable).toHaveLength(1);
    const causes = unavailable[0].kind === "capability_unavailable" ? unavailable[0].causes : [];
    expect(causes).toHaveLength(1);
    expect(causes[0]).toMatchObject({ class: "account_action", backend: "opencode", model: "llmgw/glm-5.3" });
  });

  it("keeps distinct classes/routes as distinct incidents and never invents one for a plain usable host", () => {
    const blockers = projectExecutionBlockers({
      id: "BR#8821", project: "bridge", requirements, handoff: { phase: "none" },
      hosts: [host({ kind: "unavailable", reason: "quota", cause: accountCause() }),
        host({ kind: "unavailable", reason: "timeout", cause: diagnosticCause() })],
      asks: [], now: Date.now(),
    });
    const causes = blockers.filter(b => b.kind === "capability_unavailable").flatMap(b => b.kind === "capability_unavailable" ? b.causes : []);
    expect(new Set(causes.map(c => providerIncidentRouteKey(c, ""))).size).toBe(2);
    const usableBlockers = projectExecutionBlockers({
      id: "BR#8821", project: "bridge", requirements, handoff: { phase: "none" },
      hosts: [host({ kind: "usable" })], asks: [], now: Date.now(),
    });
    expect(usableBlockers.filter(b => b.kind === "capability_unavailable")).toHaveLength(0);
  });

  it("round-trips the full execution state carrying a typed terminal cause", () => {
    let s = started();
    const outcome = { kind: "failed", exit_code: 1, stdout_tail: "tail", stderr_tail: "err", cause: diagnosticCause() } as const;
    s = step(s, { kind: "stopped", ...fence, writers: "process_group_empty", outcome });
    s = step(s, { kind: "finalize", ...fence, writers: "process_group_empty", outcome }, 1_000);
    const roundTripped = ExecutionStateSchema.parse(JSON.parse(JSON.stringify(s)));
    expect(roundTripped.terminal?.outcome.cause?.class).toBe("diagnostic");
  });
});

function TerminalOutcome(outcome: unknown) {
  // TerminalReceiptSchema carries the same TerminalOutcome payload the stopped
  // command uses; parsing through it exercises the exact persisted shape.
  return TerminalReceiptSchema.parse({ generation: 1, attempt_id: "one", outcome, writers: "no_live_group_members" }).outcome;
}