import { afterEach, expect, it, vi } from "vitest";
// UI-runtime test: keep the browser type graph separate from worker-only TS.
import { ExecutionAttentionSchema } from "@bridge/contracts";
import { notifyExecutionAttention } from "../../ui-kit/src/server/executionNotifications.ts";

afterEach(() => vi.unstubAllGlobals());
it("deduplicates a blocker episode and notification dismissal performs no lifecycle or network action", () => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  const window = Object.assign(new EventTarget(), { location: { origin: "https://hub.test", assign: vi.fn() }, focus: vi.fn() });
  vi.stubGlobal("window", window);
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const delivered: FakeNotification[] = [];
  class FakeNotification {
    static permission = "granted";
    onclick: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(public title: string) { delivered.push(this); }
  }
  vi.stubGlobal("Notification", FakeNotification);
  const data = ExecutionAttentionSchema.parse({ items: [{ id: "BR#1", title: "Repair", project: "bridge", status: "blocked", url: "https://hub.test/card/BR-1", handoff: { phase: "none" }, requirements: {},
    blockers: [{ kind: "capability_unavailable", episode_id: "capability:1", reason: "offline", text: "Supporting gateway offline", evidence: [] }],
    continuation_prompt: null, can_accept: false, prerequisites: ["human_authorization"], accept_operation: "handoff_accept" }], next_cursor: null, interactive_agents: [] });
  notifyExecutionAttention(data); notifyExecutionAttention(data);
  expect(delivered).toHaveLength(1);
  delivered[0].onclose?.(); // no dismissal handler: no status/claim operation
  notifyExecutionAttention(data);
  expect(delivered).toHaveLength(1); expect(fetch).not.toHaveBeenCalled();
  expect(data.items[0].status).toBe("blocked"); expect(data.items[0].can_accept).toBe(false);
});
