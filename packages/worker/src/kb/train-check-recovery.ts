import { CheckRetryCommandSchema, checkObligationKey, checkRetryScopeKey, checkRetryScopedKey, type CheckRetryPurpose } from "@bridge/contracts";

/** Durable, one-attempt ledger. Two closed budgets (BR#8824):
 *  - `ordinary_head_check` (and every legacy row): the base key
 *    [task, head, obligation] holds PERMANENTLY — one dispatch ever, across
 *    restarts and lease takeovers. Old rows/receipts are never reset.
 *  - `stale_destination_gate`: the hub (do.ts) validates the lane's CURRENT
 *    canonical green deploy coverage and the exact task/head binding, then
 *    scopes the budget to the successful coverage receipt it derived — one
 *    retry per exact head/obligation/CHANGED successful coverage. A prior
 *    `prepared`/`outcome_unknown` dispatch of the same scope stays fenced
 *    until its receipts reconcile (a terminal result row); it can never be
 *    repeated on the strength of a new green stamp alone. */
export class TrainCheckRecovery {
  constructor(private storage: DurableObjectStorage) {}

  /** Rows for one (task, head, obligation) scope: the legacy/base row keyed
   *  by the bare scope key (scope_key '' predates the column) plus every
   *  purpose/coverage-scoped row stamped with that scope key. */
  private scopeRows(lane: string, scopeKey: string): Array<{ retry_key: string; state: string; receipt: string }> {
    return this.storage.sql.exec(
      `SELECT retry_key,state,receipt FROM train_check_retries WHERE lane_id=? AND (retry_key=? OR scope_key=?)`,
      lane, scopeKey, scopeKey,
    ).toArray().map((r: any) => ({ retry_key: String(r.retry_key), state: String(r.state), receipt: String(r.receipt) }));
  }

  command(lane: string, raw: unknown, now: number, scope?: { purpose: CheckRetryPurpose; coverageReceipt: string }) {
    const command = CheckRetryCommandSchema.parse(raw);
    return this.storage.transactionSync(() => {
      if (command.kind === "reserve") {
        if (command.source.kind === "unknown") throw new Error("gate: check retry requires a typed GitHub source");
        const scopeKey = checkRetryScopeKey(command.task_id, command.head_sha, checkObligationKey(command));
        if (scope?.purpose === "stale_destination_gate") {
          // Unknown prior effect fence: any prepared/outcome_unknown dispatch
          // of this scope stays fenced until its receipts reconcile — a new
          // successful coverage never licenses repeating an unknown effect.
          const fenced = this.scopeRows(lane, scopeKey).find((r) => r.state === "prepared" || r.state === "outcome_unknown");
          if (fenced) return { kind: "held" as const, key: fenced.retry_key, state: fenced.state, receipt: fenced.receipt };
          const scopedKey = checkRetryScopedKey(scopeKey, scope.purpose, scope.coverageReceipt);
          const old = this.scopeRows(lane, scopeKey).find((r) => r.retry_key === scopedKey);
          if (old) return { kind: "held" as const, key: scopedKey, state: old.state, receipt: old.receipt };
          this.storage.sql.exec(
            `INSERT INTO train_check_retries(lane_id,retry_key,state,receipt,updated_ts,scope_key) VALUES(?,?,'prepared',?,?,?)`,
            lane, scopedKey, JSON.stringify(command.target), now, scopeKey);
          return { kind: "reserved" as const, key: scopedKey };
        }
        // ordinary_head_check (and legacy callers): the bare scope key is the
        // permanent budget — any prior row of it holds, unchanged.
        const old = this.storage.sql.exec(
          `SELECT state,receipt FROM train_check_retries WHERE lane_id=? AND retry_key=?`, lane, scopeKey).toArray()[0];
        if (old) return { kind: "held" as const, key: scopeKey, state: String(old.state), receipt: String(old.receipt) };
        this.storage.sql.exec(
          `INSERT INTO train_check_retries(lane_id,retry_key,state,receipt,updated_ts,scope_key) VALUES(?,?,'prepared',?,?,?)`,
          lane, scopeKey, JSON.stringify(command.target), now, scopeKey);
        return { kind: "reserved" as const, key: scopeKey };
      }
      const row = this.storage.sql.exec(`SELECT state,receipt FROM train_check_retries WHERE lane_id=? AND retry_key=?`, lane, command.key).toArray()[0];
      if (!row) throw new Error("gate: check retry result requires a reserved operation");
      if (row.state !== "prepared") {
        if (row.state !== command.outcome || row.receipt !== command.receipt) throw new Error("gate: check retry result contradicts its recorded outcome");
        return { kind: "recorded" as const, key: command.key };
      }
      this.storage.sql.exec(`UPDATE train_check_retries SET state=?,receipt=?,updated_ts=? WHERE lane_id=? AND retry_key=?`, command.outcome, command.receipt, now, lane, command.key);
      return { kind: "recorded" as const, key: command.key };
    });
  }
  candidateDuty(task: string, head: string): string | null {
    const row = this.storage.sql.exec(`SELECT duty_id FROM train_candidate_repairs WHERE task_id=? AND head_sha=?`, task, head).toArray()[0];
    return row ? String(row.duty_id) : null;
  }
  bindCandidate(task: string, head: string, duty: string) {
    this.storage.sql.exec(`INSERT OR IGNORE INTO train_candidate_repairs(task_id,head_sha,duty_id) VALUES(?,?,?)`, task, head, duty);
  }
}