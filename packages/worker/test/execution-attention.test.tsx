import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExecutionAttentionSchema } from "@bridge/contracts";
import { ExecutionAttentionCards } from "../../ui-kit/src/views/ExecutionAttention.tsx";

describe("actual execution attention markup", () => {
  it("shows simultaneous blockers and explicit pickup controls without generic claiming or implicit acceptance", () => {
    const data = ExecutionAttentionSchema.parse({ items: [{ id: "BR#1", title: "Repair dataset", project: "bridge", status: "blocked", url: "https://hub.fleetbridge.run/card/BR-1",
      handoff: { phase: "waiting", id: "local:1", version: 1, requested_at: 1, reason: "Local input needed", action: "Repair data", findings: "Remote input unavailable", tried: "Remote lookup", next: "Restore checkpoint", evidence: [], approvals: [], recipient: null, quiescence: { kind: "runner", host: "test", generation: 1 },
        checkpoint: { repo: "https://github.com/state-vector/bridge", remote_ref: "refs/heads/bridge-checkpoints/test/1", commit: "a".repeat(40), tree: "b".repeat(40), base: "c".repeat(40), environment: [], next: "Repair", tests: [] } },
      requirements: { tier: "large" }, continuation_prompt: "Verify exact checkpoint; explicitly call handoff_accept", can_accept: false, prerequisites: ["human_authorization"], accept_operation: "handoff_accept",
      blockers: [{ kind: "local_pickup_required", episode_id: "local:1", handoff_id: "local:1", version: 1, text: "Repair locally" },
        { kind: "human_answer_required", episode_id: "ask:2", ask_id: "BR#2", text: "Choose a dataset" },
        { kind: "capability_unavailable", episode_id: "cap:1", reason: "offline", text: "Last large-model gateway offline", evidence: ["host last seen 123"] }] }], next_cursor: null, interactive_agents: [{ label: "local-agent" }] });
    const html = renderToStaticMarkup(<ExecutionAttentionCards data={data} changed={() => {}} />);
    expect(html).toContain("Blocked — pick up locally");
    expect(html).toContain("Blocked — needs your decision");
    expect(html).toContain("Last large-model gateway offline");
    expect(html).toContain("Copy continuation prompt");
    expect(html).toContain("Authorise a local session");
    expect(html).not.toContain(">Claim locally<");
    expect(html).not.toContain(">Accept handoff<");
  });

  it("renders typed provider causes as account-action incidents with the exact-model probe bar (BR#8821)", () => {
    const data = ExecutionAttentionSchema.parse({ items: [{ id: "BR#9", title: "Provider-blocked repair", project: "bridge", status: "blocked", url: "https://hub.fleetbridge.run/card/BR-9",
      handoff: { phase: "none" },
      requirements: { tier: "large" }, continuation_prompt: null, can_accept: false, prerequisites: [], accept_operation: "handoff_accept",
      blockers: [{ kind: "capability_unavailable", episode_id: "cap:9", reason: "unavailable", text: "Supporting gateways report the required model/capability unavailable.", evidence: ["gw last seen"],
        causes: [
          { class: "account_action", backend: "opencode", model: "llmgw/glm-5.3", code: -32603, error_name: "provider.quota", message: "provider quota exceeded", data: { service: "session", errorName: "provider.quota" }, evidence_line: null, at_ms: 1000 },
          { class: "route_unavailable", backend: "opencode", model: "llmgw/glm-5.3", code: -32603, error_name: "provider.no-route", message: "no route", data: null, evidence_line: null, at_ms: 1001 },
        ] }] }], next_cursor: null, interactive_agents: [] });
    const html = renderToStaticMarkup(<ExecutionAttentionCards data={data} changed={() => {}} />);
    // the account-action incident names who acts and the exact-model probe bar
    expect(html).toContain("Provider account incident — you must act:");
    expect(html).toContain("top up the account quota/credits");
    expect(html).toContain("only a successful probe reopens admission");
    // sanitized provider evidence renders (the message), and the contained
    // non-account incident renders without demanding any account action
    expect(html).toContain("provider quota exceeded");
    expect(html).toContain("Provider incident:");
    expect(html).toContain("no account action needed");
    // no fabricated billing URL or credentials are implied anywhere
    expect(html).not.toMatch(/https?:\/\/[^"]*(billing|topup|top-up)/i);
  });
});
