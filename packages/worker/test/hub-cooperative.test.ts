import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeHub } from "../src/kb/do";
import { RequestDiagnostics } from "../src/kb/request-diagnostics";
import type { HubRequestStage } from "@bridge/contracts";
import { REVIEW_RECONCILE_BATCH_SQL } from "../src/kb/review-query";

interface BoardHarness {
  broadcastEvent(event: unknown): void;
  board(): Promise<unknown>;
  boardPayload(force?: boolean): Promise<unknown>;
  scheduleBoardSnapshot(): void;
  boardDirty: boolean;
  maintenanceCheckpoint(trace: ReturnType<RequestDiagnostics["begin"]>, stage: HubRequestStage): Promise<void>;
}
function rig() {
  const frames: string[] = [], pending: Promise<unknown>[] = [];
  const state = {
    getWebSockets: () => [{ send: (frame: string) => frames.push(frame) }],
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  } as unknown as DurableObjectState;
  const hub = new KnowledgeHub(state, {}) as unknown as BoardHarness;
  const build = vi.spyOn(hub, "board").mockResolvedValue({ tasks: [] });
  return { hub, frames, pending, build };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("foreground control and cooperative hub maintenance", () => {
  it("delivers mutation events without synchronously aggregating the board; concurrent schedules coalesce", async () => {
    vi.useFakeTimers();
    const { hub, frames, pending, build } = rig();
    hub.broadcastEvent({ action: "execution_stopped" });
    hub.scheduleBoardSnapshot();
    expect(frames.map(frame => JSON.parse(frame).type)).toEqual(["kb.event"]);
    expect(build).not.toHaveBeenCalled();
    expect(pending).toHaveLength(1);
    await vi.runAllTimersAsync();
    await Promise.all(pending);
    expect(build).toHaveBeenCalledTimes(1);
    expect(frames.map(frame => JSON.parse(frame).type)).toEqual(["kb.event", "kb.board"]);
  });

  it("retains the burst tail and cannot resurrect a stale HTTP cache after an interleaved mutation", async () => {
    vi.useFakeTimers();
    const { hub, pending, build } = rig();
    const first = deferred<unknown>();
    build.mockReturnValueOnce(first.promise).mockResolvedValue({ tasks: ["new"] });
    hub.broadcastEvent({ action: "before" });
    await vi.runAllTimersAsync();
    expect(build).toHaveBeenCalledTimes(1);
    hub.broadcastEvent({ action: "after" });
    first.resolve({ tasks: ["old"] });
    await Promise.all(pending);
    expect(hub.boardDirty).toBe(true);
    expect(await hub.boardPayload()).toEqual({ tasks: ["new"] });
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed background build dirty so the alarm can retry without failing the mutation", async () => {
    vi.useFakeTimers();
    const { hub, pending, build } = rig();
    build.mockRejectedValueOnce(new Error("storage temporarily unavailable"));
    expect(() => hub.broadcastEvent({ action: "committed" })).not.toThrow();
    await vi.runAllTimersAsync();
    await expect(Promise.all(pending)).resolves.toBeDefined();
    expect(hub.boardDirty).toBe(true);
    hub.scheduleBoardSnapshot();
    await vi.runAllTimersAsync();
    await Promise.all(pending);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("admits foreground work between committed maintenance phases and records the advanced event clock", async () => {
    vi.useFakeTimers();
    const { hub } = rig();
    const diagnostics = new RequestDiagnostics();
    const trace = diagnostics.begin("watchdog.alarm");
    trace.stage("task.maintenance");
    const phases: string[] = [];
    const maintenance = hub.maintenanceCheckpoint(trace, "train.maintenance").then(() => phases.push("next phase"));
    await Promise.resolve().then(() => phases.push("foreground request"));
    expect(phases).toEqual(["foreground request"]);
    vi.setSystemTime(Date.now() + 5);
    await vi.runAllTimersAsync();
    await maintenance;
    expect(phases).toEqual(["foreground request", "next phase"]);
    expect(trace.finish(200).stages.some(stage => stage.stage === "task.maintenance" && stage.elapsed_ms > 0)).toBe(true);
  });
});

interface ReviewMaintenanceHarness {
  reconcileCompletedReviews(): Promise<void>;
  reconcileDeliveryClosures(): Promise<void>;
  replayDeliveryAdmissions(): Promise<void>;
  currentTaskReview(id: string): { phase: "none" };
  settingValue(key: string, fallback: string): string;
}

describe("bounded review maintenance", () => {
  it("lets foreground work run within a page, then rotates past an unchanged backlog and survives restart", async () => {
    vi.useFakeTimers();
    const settings = new Map<string, string>();
    const visited: string[] = [];
    const sql = { exec: vi.fn((query: string, ...args: unknown[]) => {
      if (query === REVIEW_RECONCILE_BATCH_SQL) {
        const after = Number(args[0]), limit = Number(args[1]);
        return { toArray: () => Array.from({ length: 60 }, (_, i) => ({ cursor: i + 1, id: `task-${i + 1}` }))
          .filter(row => row.cursor > after).slice(0, limit) };
      }
      if (query.startsWith("INSERT OR REPLACE INTO settings")) settings.set(String(args[0]), String(args[1]));
      return { toArray: () => [] };
    }) };
    const makeHub = () => {
      const hub = new KnowledgeHub({ storage: { sql } } as unknown as DurableObjectState, {}) as unknown as ReviewMaintenanceHarness;
      vi.spyOn(hub, "reconcileDeliveryClosures").mockResolvedValue();
      vi.spyOn(hub, "replayDeliveryAdmissions").mockResolvedValue();
      vi.spyOn(hub, "settingValue").mockImplementation((key, fallback) => settings.get(key) ?? fallback);
      vi.spyOn(hub, "currentTaskReview").mockImplementation(id => { visited.push(id); return { phase: "none" }; });
      return hub;
    };
    const hub = makeHub();
    const first = hub.reconcileCompletedReviews();
    await vi.advanceTimersByTimeAsync(1);
    expect(visited.length).toBeLessThan(25); // foreground request admitted before the page completes
    await vi.runAllTimersAsync(); await first;
    expect(visited).toHaveLength(25);
    expect(settings.get("review_reconcile_cursor")).toBe("25");
    // A new isolate picks up the persistent cursor, not the first page again.
    for (const expected of [50, 60, 85]) {
      const pass = makeHub().reconcileCompletedReviews();
      await vi.runAllTimersAsync(); await pass;
      expect(visited).toHaveLength(expected);
    }
    expect(new Set(visited.slice(0, 60)).size).toBe(60);
    expect(visited[60]).toBe("task-1");
  });
});
