import { describe, expect, it } from "vitest";
import { aggregateThroughput, parseThroughputParams } from "../src/kb/throughput";

const DAY = 86_400_000;
// fixed "now" so bucket math is deterministic: 2026-10-24T12:00:00Z
const NOW = Date.UTC(2026, 9, 24, 12);

describe("parseThroughputParams", () => {
  it("defaults: day / 30d", () => {
    expect(parseThroughputParams(null, null)).toEqual({ bucket: "day", rangeDays: 30 });
  });
  it("accepts week + bare number + Nd", () => {
    expect(parseThroughputParams("week", "90d")).toEqual({ bucket: "week", rangeDays: 90 });
    expect(parseThroughputParams("day", "14")).toEqual({ bucket: "day", rangeDays: 14 });
  });
  it("rejects unknown bucket, malformed and out-of-bounds range", () => {
    expect(parseThroughputParams("hour", "30d")).toMatchObject({ error: expect.stringContaining("bucket") });
    expect(parseThroughputParams("day", "abc")).toMatchObject({ error: expect.stringContaining("range") });
    expect(parseThroughputParams("day", "400d")).toMatchObject({ error: expect.stringContaining("1-365") });
    expect(parseThroughputParams("day", "0d")).toMatchObject({ error: expect.stringContaining("1-365") });
  });
});

describe("aggregateThroughput", () => {
  it("counts done transitions into day buckets, cumulative within range", () => {
    const events = [
      { ts: NOW - 2.2 * DAY, artefact_id: "BR#1" },
      { ts: NOW - 2.1 * DAY, artefact_id: "BR#2" },
      { ts: NOW - 0.5 * DAY, artefact_id: "BR#3" },
      { ts: NOW - 10 * DAY, artefact_id: "BR#0" }, // before range: ignored
    ];
    const out = aggregateThroughput(events, [], { bucket: "day", rangeDays: 7, now: NOW });
    expect(out).toHaveLength(7);
    const counts = out.map((b) => b.n);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(3);
    // the two old-day events share a bucket
    expect(Math.max(...counts)).toBe(2);
    // cumulative is monotone and ends at the in-range total
    for (let i = 1; i < out.length; i++) expect(out[i].cumulative).toBeGreaterThanOrEqual(out[i - 1].cumulative);
    expect(out[out.length - 1].cumulative).toBe(3);
  });

  it("groups into week buckets", () => {
    // epoch weeks start Thursday: NOW-1d lands in the final bucket;
    // NOW-6d and NOW-8d share the previous one
    const events = [
      { ts: NOW - 1 * DAY, artefact_id: "BR#1" },
      { ts: NOW - 6 * DAY, artefact_id: "BR#2" },
      { ts: NOW - 8 * DAY, artefact_id: "BR#3" },
    ];
    const out = aggregateThroughput(events, [], { bucket: "week", rangeDays: 28, now: NOW });
    expect(out).toHaveLength(4);
    expect(out[out.length - 1].n).toBe(1);
    expect(out[out.length - 2].n).toBe(2);
    expect(out[out.length - 1].cumulative).toBe(3);
  });

  it("fallback: currently-done rows without history count at status_ts; event-covered ids never double-count", () => {
    const events = [{ ts: NOW - 1 * DAY, artefact_id: "BR#1" }];
    const fallback = [
      { id: "BR#1", status_ts: NOW - 1 * DAY }, // covered by the event — skipped
      { id: "BR#2", status_ts: NOW - 2 * DAY }, // compacted history — counted
      { id: "BR#3", status_ts: NOW - 40 * DAY }, // out of range — skipped
    ];
    const out = aggregateThroughput(events, fallback, { bucket: "day", rangeDays: 7, now: NOW });
    expect(out.reduce((n, b) => n + b.n, 0)).toBe(2);
  });

  it("a task re-completed twice counts twice (true transition events)", () => {
    const events = [
      { ts: NOW - 3 * DAY, artefact_id: "BR#1" },
      { ts: NOW - 1 * DAY, artefact_id: "BR#1" },
    ];
    const out = aggregateThroughput(events, [], { bucket: "day", rangeDays: 7, now: NOW });
    expect(out.reduce((n, b) => n + b.n, 0)).toBe(2);
  });

  it("empty input yields zero buckets array with correct length", () => {
    const out = aggregateThroughput([], [], { bucket: "day", rangeDays: 30, now: NOW });
    expect(out).toHaveLength(30);
    expect(out.every((b) => b.n === 0 && b.cumulative === 0)).toBe(true);
  });
});
