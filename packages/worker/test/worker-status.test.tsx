import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { currentWorkerStatus, WorkerStatusSchema } from "@bridge/contracts";
import { useKb } from "../../ui-kit/src/server/kbStore";
import { WorkerAvailabilityBanner } from "../../ui-kit/src/views/WorkerAvailability";
import { StatusDetails } from "../../ui-kit/src/views/StatusLights";
import { TopView } from "../../ui-kit/src/views/TopView";
import { TrainPanelView } from "../../ui-kit/src/views/TrainPanel";
import type { KbTrainLane } from "../../ui-kit/src/server/kb";

vi.mock("../../ui-kit/src/server/kbStore", async importOriginal => {
  const original = await importOriginal<typeof import("../../ui-kit/src/server/kbStore")>();
  return { ...original, useKb: Object.assign(<T,>(select: (state: ReturnType<typeof original.useKb.getState>) => T) => select(original.useKb.getState()), original.useKb) };
});

const worker = WorkerStatusSchema.parse({ host: "gateway-one", observed_at: Date.now(), state: "ready", reason: "", active: 1, reserved: 1, capacity: 4 });
it("uses one no-worker warning, never per-task attention cards or a busy-worker outage", () => {
  const previous = useKb.getState();
  try {
    useKb.setState({ conn: "open", workers: [] });
    const html = renderToStaticMarkup(<TopView />);
    expect(html.match(/No workers available\./g)).toHaveLength(1);
    expect(html).not.toContain("Execution attention");
    expect(html).not.toContain("Request local pickup");
    for (const state of ["ready", "busy"] as const) {
      useKb.setState({ workers: [{ ...worker, state }] });
      expect(renderToStaticMarkup(<WorkerAvailabilityBanner />)).toBe("");
    }
    useKb.setState({ workers: [{ ...worker, state: "unavailable" }] });
    expect(renderToStaticMarkup(<WorkerAvailabilityBanner />)).toContain("No workers available.");
    useKb.setState({ workers: null });
    expect(renderToStaticMarkup(<WorkerAvailabilityBanner />)).toBe("");
    useKb.setState({ conn: "closed", workers: [] });
    expect(renderToStaticMarkup(<WorkerAvailabilityBanner />)).toBe("");
  } finally { useKb.setState(previous); }
});

it("shows grouped connection states and independent per-host occupancy", () => {
  const html = renderToStaticMarkup(<StatusDetails hub="open" realtime="closed" lastError={null} workers={[worker, { ...worker, host: "gateway-two", active: 3, reserved: 0, capacity: 3, state: "busy" }]} />);
  expect(html).toContain("Connections"); expect(html).toContain("Live updates");
  expect(html).toContain("Connected"); expect(html).toContain("Disconnected");
  expect(html).toContain("1 running · 1 reserved · 4 slots");
  expect(html).toContain("3 running · 0 reserved · 3 slots");
  expect(currentWorkerStatus(worker, worker.observed_at + 120_000).state).toBe("offline");
});

it("hides retired lines by either lifecycle flag or typed projection, including the all-retired case", () => {
  const lane: KbTrainLane = { lane: "org/repo@main", card: "BR#1", queue: [], line: { phase: "ready", label: "Ready", reason: "Ready", held: 0, evidence: [], observed_at: 1 } };
  const retired = { ...lane, lane: "org/repo@old", retired: true };
  const projected: KbTrainLane = { ...lane, lane: "org/repo@drill", line: { ...lane.line!, phase: "retired", label: "Retired" } };
  const html = renderToStaticMarkup(<TrainPanelView lanes={[lane, retired, projected]} error={null} now={1} />);
  expect(html).toContain("org/repo@main"); expect(html).not.toContain("org/repo@old"); expect(html).not.toContain("org/repo@drill");
  expect(renderToStaticMarkup(<TrainPanelView lanes={[retired, projected]} error={null} now={1} />)).toContain("No active merge lines.");
});
