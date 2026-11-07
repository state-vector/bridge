import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TrainQueueScanSchema, TOOL_ARG_SCHEMAS } from "../src/index.ts";

describe("saved train checking position", () => {
  it("shares the exact runner shapes and publishes them through MCP", () => {
    const fixture: unknown[] = JSON.parse(readFileSync(new URL("../fixtures/train-scan.json", import.meta.url), "utf8"));
    for (const scan of fixture) {
      expect(TrainQueueScanSchema.parse(scan)).toEqual(scan);
      expect(TOOL_ARG_SCHEMAS.train_queue_facts.parse({ repo: "o/r", scan }).scan).toEqual(scan);
    }
  });
  it("rejects incomplete positions rather than inventing progress", () => {
    for (const scan of [{ phase: "checking" }, { phase: "checking", after_id: "" }, { phase: "unknown" }]) {
      expect(TrainQueueScanSchema.safeParse(scan).success).toBe(false);
    }
  });
});
