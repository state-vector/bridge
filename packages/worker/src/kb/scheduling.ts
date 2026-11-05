import type { ExecutorCapabilities } from "@bridge/contracts";

/** Expired leases are NOT stopped writers. Count every unquiesced attempt,
 * plus pre-begin claims, once each. The same query backs gates and telemetry. */
export function gatewayOccupancy(sql: DurableObjectStorage["sql"], tokenId: string, host: string, exclude = "") {
  const active = sql.exec(`SELECT task_id FROM execution_state WHERE task_id != ?
    AND json_extract(state,'$.attempt.host')=?
    AND json_extract(state,'$.attempt.phase') IN ('running','restoring','stopping')`, exclude, host).toArray();
  const reserved = sql.exec(`SELECT c.task_id FROM executor_start_claims c JOIN artefacts a ON a.id=c.task_id
    LEFT JOIN execution_state e ON e.task_id=c.task_id
    LEFT JOIN dispatch_reservations r ON r.task_id=c.task_id
    WHERE c.token_id=? AND c.task_id!=? AND a.status='in_progress'
    AND json_extract(a.meta,'$.session')=c.session
    AND (r.task_id IS NOT NULL OR json_extract(e.state,'$.attempt') IS NULL)
    AND (json_extract(e.state,'$.attempt.phase') IS NULL OR json_extract(e.state,'$.attempt.phase')='quiesced')`, tokenId, exclude).toArray();
  return { active: active.length, reserved: reserved.length };
}

export function gatewayCapacity(capabilities: ExecutorCapabilities): number {
  // Models share one physical gateway. Alternatives never multiply its slots.
  return capabilities.capacity;
}
