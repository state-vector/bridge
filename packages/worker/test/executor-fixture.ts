import { expect } from "vitest";
import { EXECUTOR_READINESS_PROTOCOL } from "@bridge/contracts";

export function executorRequest(body: unknown): unknown {
  return body && typeof body === "object" && !Array.isArray(body) ? { runner_protocol: EXECUTOR_READINESS_PROTOCOL, ...body } : body;
}

type Call = (path: string, body: unknown) => Promise<{ status: number; body: unknown }>;

/** Real provisioning/readiness prerequisite for tests of downstream claim law. */
export async function readyGateway(call: Call, tokenId: string, label: string): Promise<void> {
  const worker = `${label}/fixture-worker`;
  expect((await call("/agent.provision", { label: worker, actor: label })).status).toBe(200);
  const ready = await call("/execution", { id: "gateway", actor: label, token_id: tokenId, session: "fixture-readiness",
    command_id: `fixture:${label}`, command: { kind: "advertise", capabilities: {
      tier: "large", model: "test/fixture", tools: ["git"], environment: ["test"], worker: { kind: "provisioned", label: worker },
    } } });
  expect(ready.body).toMatchObject({ ok: true });
}
