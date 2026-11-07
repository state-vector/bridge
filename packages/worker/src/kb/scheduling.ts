import { AttemptSchema, currentWorkerOccupancy, type WorkerSlot, type ExecutorCapabilities } from "@bridge/contracts";

/** Expired leases are NOT stopped writers. Count every unquiesced attempt,
 * plus pre-begin claims, once each. The same query backs gates and telemetry. */
export function gatewayOccupancy(sql: DurableObjectStorage["sql"], tokenId: string, host: string, exclude = "", now = Date.now()) {
  const active = sql.exec(`SELECT e.task_id,e.state,a.status,a.meta FROM execution_state e LEFT JOIN artefacts a ON a.id=e.task_id WHERE e.task_id != ?
    AND json_extract(e.state,'$.attempt.host')=?
    AND json_extract(e.state,'$.attempt.phase') IN ('running','restoring','stopping')`, exclude, host).toArray();
  const reserved = sql.exec(`SELECT c.task_id,c.session,r.expires_at FROM executor_start_claims c JOIN artefacts a ON a.id=c.task_id
    LEFT JOIN execution_state e ON e.task_id=c.task_id
    LEFT JOIN dispatch_reservations r ON r.task_id=c.task_id
    WHERE c.token_id=? AND c.task_id!=? AND a.status='in_progress'
    AND json_extract(a.meta,'$.session')=c.session
    AND (r.task_id IS NOT NULL OR json_extract(e.state,'$.attempt') IS NULL)
    AND (json_extract(e.state,'$.attempt.phase') IS NULL OR json_extract(e.state,'$.attempt.phase')='quiesced')`, tokenId, exclude).toArray();
  const slots: WorkerSlot[] = active.map(row => {
    const a = AttemptSchema.parse(JSON.parse(String(row.state)).attempt);
    if (a.phase === "quiesced" || a.phase === "finalizing") throw new Error("stopped attempt cannot occupy a writer slot");
    const fields = { task_id: String(row.task_id), generation: a.generation, attempt_id: a.attempt_id, session: a.session,
      phase: a.phase, lease_until: a.lease_until, action_deadline: a.action_deadline, task_status: String(row.status ?? "missing") };
    const claim = JSON.parse(String(row.meta ?? "{}"));
    return row.status !== "in_progress" || claim.session !== a.session
      ? { ...fields, kind: "unconfirmed", reason: "claim_changed" } : { ...fields, kind: "leased" };
  });
  slots.push(...reserved.map(row => ({ kind: "starting" as const, task_id: String(row.task_id), session: String(row.session), expires_at: row.expires_at == null ? null : Number(row.expires_at) })));
  // Keep legacy active/reserved charges exact. Presentation splits uncertainty;
  // expiry/card release never frees an unquiesced writer behind the scheduler.
  const finalizing = Number(sql.exec(`SELECT COUNT(*) AS n FROM execution_state WHERE task_id!=? AND json_extract(state,'$.attempt.host')=? AND json_extract(state,'$.attempt.phase')='finalizing'`, exclude, host).one().n);
  return { active: active.length, reserved: reserved.length, finalizing, occupancy: currentWorkerOccupancy(slots, now) };
}

export function gatewayCapacity(capabilities: ExecutorCapabilities): number {
  // Models share one physical gateway. Alternatives never multiply its slots.
  return capabilities.capacity;
}
