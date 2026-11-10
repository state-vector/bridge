import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { currentWorkerStatus, currentWorkerOccupancy, WorkerStatusSchema, type WorkerSlot } from "@bridge/contracts";
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
  expect(html).toContain("1 unresolved executions · 1 reserved · 4 slots");
  expect(html).toContain("3 unresolved executions · 0 reserved · 3 slots");
  expect(currentWorkerStatus(worker, worker.observed_at + 120_000).state).toBe("offline");
});

it("shows an upgrade separately from an operator drain and a stale heartbeat", () => {
  const updating = { ...worker, state: "draining", readiness: { kind: "updating", reason: "Managed update" } } as const;
  const render = (entry: typeof worker) => renderToStaticMarkup(
    <StatusDetails hub="open" realtime="open" lastError={null} workers={[entry]} />,
  );
  expect(render(updating)).toContain(">Upgrading</span>");
  expect(render({ ...updating, readiness: { kind: "draining", reason: "Operator drain" } })).toContain(">Draining</span>");
  expect(render(currentWorkerStatus(updating, updating.observed_at + 120_000))).toContain(">Offline</span>");
});

it("separates lease evidence, starts and old unconfirmed capacity without inventing process counts", () => {
  const now = Date.now();
  const leased: WorkerSlot = { kind: "leased", task_id: "BR#1", generation: 2, attempt_id: "old-daemon-attempt", session: "dispatch-one",
    phase: "running", lease_until: now + 1000, action_deadline: now + 5000, task_status: "in_progress" };
  const slots: WorkerSlot[] = [leased, { ...leased, kind: "unconfirmed", reason: "claim_changed", task_id: "BR#2", task_status: "todo" },
    { kind: "starting", task_id: "BR#3", session: "dispatch-three", expires_at: now + 2000 }];
  const occupancy = currentWorkerOccupancy(slots, now);
  expect(occupancy).toMatchObject({ leased: 1, unconfirmed: 1, starting: 1, held: 3 });
  const html = renderToStaticMarkup(<StatusDetails hub="open" realtime="open" lastError={null} workers={[{ ...worker, occupancy }]} />);
  expect(html).toContain("1 leased · 1 starting · 1 unconfirmed · 3/4 slots held");
  expect(html).toContain("Capacity held for unconfirmed executions");
  expect(html).toContain("BR#2"); expect(html).toContain("generation 2"); expect(html).toContain("claim changed");
  expect(html).not.toContain("3 running");
  const aged = currentWorkerStatus({ ...worker, observed_at: now, occupancy }, now + 1500);
  expect(aged.state).toBe("ready"); // heartbeat and execution lease are separate clocks
  expect(aged.occupancy).toMatchObject({ leased: 0, unconfirmed: 2, held: 3 });
});

it("hides retired lines by either lifecycle flag or typed projection, including the all-retired case", () => {
  const lane: KbTrainLane = { lane: "org/repo@main", card: "BR#1", queue: [], line: { phase: "ready", label: "Ready", reason: "Ready", held: 0, evidence: [], observed_at: 1 } };
  const retired = { ...lane, lane: "org/repo@old", retired: true };
  const projected: KbTrainLane = { ...lane, lane: "org/repo@drill", line: { ...lane.line!, phase: "retired", label: "Retired" } };
  const html = renderToStaticMarkup(<TrainPanelView lanes={[lane, retired, projected]} error={null} now={1} />);
  expect(html).toContain("org/repo@main"); expect(html).not.toContain("org/repo@old"); expect(html).not.toContain("org/repo@drill");
  expect(renderToStaticMarkup(<TrainPanelView lanes={[retired, projected]} error={null} now={1} />)).toContain("No active merge lines.");
});
