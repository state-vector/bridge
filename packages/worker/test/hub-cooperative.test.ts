import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeHub } from "../src/kb/do";
import { RequestDiagnostics } from "../src/kb/request-diagnostics";
import type { HubRequestStage } from "@bridge/contracts";

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
