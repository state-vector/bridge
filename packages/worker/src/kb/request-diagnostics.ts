import type { HubDiagnostics, HubRequestStage, HubRequestTiming } from "@bridge/contracts";

/** Bounded isolate-local diagnostics. Never stores bodies, URLs, tokens or headers;
 * no SQL, audit events, board builds or scheduler work on the observation path. */
export class RequestDiagnostics {
  private readonly instance = crypto.randomUUID();
  private readonly started: number;
  private active = new Map<string, HubRequestTiming>();
  private recent: HubRequestTiming[] = [];
  private operations = new Map<string, HubDiagnostics["operations"][number]>();
  constructor(private clock: () => number = Date.now) { this.started = clock(); }
  begin(operation: string, sentAt = 0) {
    const id = crypto.randomUUID(), at = this.clock();
    const timing: HubRequestTiming = { id, operation: this.name(operation), phase: "active", started_at: at, elapsed_ms: 0,
      ingress_ms: sentAt > 0 && Number.isFinite(sentAt) ? Math.max(0, at - sentAt) : 0, stage: "schema", stages: [] };
    if (this.active.size < 128) this.active.set(id, timing);
    let stageAt = at;
    const stage = (next: HubRequestStage) => {
      timing.stages.push({ stage: timing.stage, elapsed_ms: Math.max(0, this.clock() - stageAt) });
      timing.stage = next; stageAt = this.clock();
    };
    return {
      stage,
      operation: (name: string) => { timing.operation = this.name(name); },
      finish: (status: number) => {
        stage(timing.stage);
        const result: HubRequestTiming = { ...timing, phase: "completed", elapsed_ms: Math.max(0, this.clock() - at), status };
        this.active.delete(id); this.recent.push(result);
        if (this.recent.length > 64) this.recent.shift();
        if (!this.operations.has(result.operation) && this.operations.size >= 64) this.operations.delete(this.operations.keys().next().value!);
        const aggregate = this.operations.get(result.operation) ?? { operation: result.operation, count: 0, errors: 0, max_ms: 0, total_ms: 0 };
        aggregate.count++; aggregate.errors += Number(status >= 500); aggregate.max_ms = Math.max(aggregate.max_ms, result.elapsed_ms); aggregate.total_ms += result.elapsed_ms;
        this.operations.set(result.operation, aggregate);
        return result;
      },
    };
  }
  private name(name: string) { return /^[a-z][a-z.]{0,63}$/.test(name) ? name : "unknown"; }
  snapshot(): HubDiagnostics {
    const now = this.clock();
    return { observed_at: now, instance_id: this.instance, started_at: this.started,
      active: [...this.active.values()].map(t => ({ ...t, stages: [...t.stages], elapsed_ms: Math.max(0, now - t.started_at) })),
      recent: this.recent.map(t => ({ ...t, stages: [...t.stages] })), operations: [...this.operations.values()].map(t => ({ ...t })) };
  }
}
export type RequestTrace = ReturnType<RequestDiagnostics["begin"]>;
