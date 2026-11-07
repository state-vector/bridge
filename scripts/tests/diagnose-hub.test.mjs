import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonEvents, observation, summarize } from "../diagnose-hub.mjs";

test("parses fragmented pretty tail events with quoted braces and multiple records", () => {
  const events = [], parser = new JsonEvents(event => events.push(event));
  const input = `connecting\n${JSON.stringify({ logs: [{ message: ['a } \\" { value'] }] }, null, 2)}\n${JSON.stringify({ outcome: "ok" })}`;
  for (const c of input) parser.push(c);
  assert.equal(events.length, 2);
  assert.equal(events[1].outcome, "ok");
});
test("drops secrets and arbitrary payloads while retaining latency and approved stage fields", () => {
  const result = observation({ outcome: "ok", wallTime: 8001, cpuTime: 2, event: { request: { method: "POST", url: "https://hub/mcp?token=bkw_hidden", headers: { authorization: "Bearer secret" }, body: "private" }, response: { status: 503 } },
    logs: [{ message: [JSON.stringify({ type: "bridge.request", operation: "execution.advertise", elapsed_ms: 7000, status: 503, bearer: "secret", stages: [{ stage: "alarm", elapsed_ms: 6900 }] }), "private raw message"] }], exceptions: [{ message: "secret" }] });
  assert.equal(result.route, "POST /mcp");
  assert.equal(result.stages[0].operation, "execution.advertise");
  assert.doesNotMatch(JSON.stringify(result), /hidden|secret|private|authorization|bearer/);
  const report = summarize([result], 1, 2);
  assert.equal(report.routes[0].failed, 1);
  assert.equal(report.routes[0].p95_ms, 8001);
});
