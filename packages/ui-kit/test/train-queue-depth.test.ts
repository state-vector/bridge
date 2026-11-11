import { describe, expect, it } from "vitest";
import { trainQueueDepthLabel } from "../src/views/TrainPanel";
import type { KbTrainLane } from "../src/server/kb";

/**
 * BR#5106 depth-counter honesty: the lane row renders BOTH counters — the
 * derived queue (actionable subset) and the open-PR count from the last
 * reconcile — as `queue N · open M`, so the depth can never read as wrong
 * again (the "43 open PRs, queue EMPTY" class, BR#5022). The view calls this
 * pure fn for the row label; these tests pin its exact output shape.
 */

function lane(queue: KbTrainLane["queue"], open_prs: KbTrainLane["open_prs"]): Pick<KbTrainLane, "queue" | "open_prs"> {
  return { queue, open_prs };
}

describe("trainQueueDepthLabel — queue N · open M per lane row (BR#5106)", () => {
  it("renders both counters when reconcile data exists", () => {
    const l = lane(
      [
        { id: "BR#1", priority: "normal" },
        { id: "BR#2", priority: "critical" },
        { id: "BR#3", priority: "normal" },
      ],
      { count: 12, ts: Date.now() },
    );
    expect(trainQueueDepthLabel(l)).toBe("queue 3 · open 12");
  });

  it("renders the queue alone before the first reconcile lands (never a made-up zero)", () => {
    expect(trainQueueDepthLabel(lane([{ id: "BR#1", priority: "normal" }], null))).toBe("queue 1");
    expect(trainQueueDepthLabel(lane([], undefined))).toBe("queue 0");
  });

  it("renders an empty queue against a full pile — the honest contrast", () => {
    const l = lane([], { count: 43, ts: Date.now() });
    expect(trainQueueDepthLabel(l)).toBe("queue 0 · open 43");
  });
});
