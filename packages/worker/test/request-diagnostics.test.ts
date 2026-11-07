import { describe, expect, it } from "vitest";
import { HubDiagnosticsSchema } from "@bridge/contracts";
import { RequestDiagnostics } from "../src/kb/request-diagnostics";

describe("bounded request diagnostics", () => {
  it("shows the actual in-flight stage and separates overlapping requests", () => {
    let now = 1000;
    const metrics = new RequestDiagnostics(() => now);
    const a = metrics.begin("auth.identify");
    now += 10; a.stage("alarm");
    const b = metrics.begin("execution.advertise");
    now += 8000;
    expect(HubDiagnosticsSchema.parse(metrics.snapshot()).active).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "auth.identify", stage: "alarm", elapsed_ms: 8010 }),
      expect.objectContaining({ operation: "execution.advertise", stage: "schema", elapsed_ms: 8000 }),
    ]));
    a.finish(503); b.finish(200);
    const result = HubDiagnosticsSchema.parse(metrics.snapshot());
    expect(result.active).toHaveLength(0);
    expect(result.operations.find(o => o.operation === "auth.identify")).toMatchObject({ errors: 1, max_ms: 8010 });
  });
  it("bounds retained observations and excludes arbitrary names and payload fields", () => {
    const metrics = new RequestDiagnostics(() => 1000);
    for (let i = 0; i < 200; i++) metrics.begin("request/bkw_secret?token=secret").finish(200);
    const result = HubDiagnosticsSchema.parse(metrics.snapshot());
    expect(result.recent).toHaveLength(64);
    expect(result.operations).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/bkw_|token|secret/);
  });
});
