import { describe, expect, it } from "vitest";
import { SchemaInitialization } from "../src/kb/schema-init";

describe("hub schema initialization under concurrent executor traffic", () => {
  it("makes parallel lease/readiness requests wait on one initialization, then does no more schema work", async () => {
    const schema = new SchemaInitialization();
    let calls = 0, ready = false;
    let release!: () => void;
    const storage = new Promise<void>(resolve => { release = resolve; });
    const requests = Array.from({ length: 40 }, () => schema.run(async () => { calls++; await storage; ready = true; }));
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(ready).toBe(false);
    release();
    await Promise.all(requests);
    await schema.run(async () => { throw new Error("a warm request reran migrations"); });
    expect(ready).toBe(true);
    expect(calls).toBe(1);
  });
  it("retries partial storage failure, and a new instance runs the new build's migrations", async () => {
    const schema = new SchemaInitialization();
    let attempts = 0;
    const initialize = async () => { if (++attempts === 1) throw new Error("infra_storage_fault"); };
    const first = await Promise.allSettled([schema.run(initialize), schema.run(initialize)]);
    expect(first.map(result => result.status)).toEqual(["rejected", "rejected"]);
    await schema.run(initialize);
    await schema.run(initialize);
    expect(attempts).toBe(2);
    await new SchemaInitialization().run(initialize);
    expect(attempts).toBe(3);
  });
});
