import { describe, expect, it } from "vitest";
import { boundedWakeStream } from "../src/kb/sse";

describe("bounded gateway wake streams", () => {
  it("delivers wake frames then ends the stream and releases its slot on expiry", async () => {
    const clients = new Set<WritableStreamDefaultWriter>();
    const response = boundedWakeStream(new Request("https://kb/sse"), clients, "retry: 5000\n\ndata: hello\n\n", 15);
    expect(clients.size).toBe(1);
    expect(await response.text()).toBe("retry: 5000\n\ndata: hello\n\n");
    expect(clients.size).toBe(0);
  });
  it("closes promptly on disconnect rather than retaining a client until the timer", async () => {
    const controller = new AbortController(), clients = new Set<WritableStreamDefaultWriter>();
    const response = boundedWakeStream(new Request("https://kb/sse", { signal: controller.signal }), clients, "data: hello\n\n", 60_000);
    const read = response.text();
    controller.abort();
    expect(await read).toBe("data: hello\n\n");
    expect(clients.size).toBe(0);
  });
});
