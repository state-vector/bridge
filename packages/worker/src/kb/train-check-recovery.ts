import { CheckRetryCommandSchema, checkObligationKey, checkRetryScopeKey, checkRetryScopedKey, legacyCheckObligationKey, type CheckRetryPurpose } from "@bridge/contracts";

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
 *    repeated on the strength of a new green stamp alone.
 *  BR#9268: the obligation identity now carries the check-run producer class
 *  (native Actions job vs published report) when the observation carries it.
 *  The migration is fenced BOTH ways: a producer-typed reservation sees the
 *  pre-split collapsed scope's rows too, so an unreconciled dispatch of the
 *  legacy identity stays fenced (an unknown effect is never re-armed by an
 *  identity split), while a TERMINAL collapsed row does not consume the
 *  freshly-identified native job's own one-dispatch-ever budget (its target
 *  was some other check of the collapsed obligation — rerequesting the
 *  published report shell is exactly what it must not be counted against). */
export class TrainCheckRecovery {
  constructor(private storage: DurableObjectStorage) {}

  /** Rows for one (task, head, obligation) scope across BOTH identities of
   *  BR#9268's producer split: the producer-typed key plus the pre-split
   *  collapsed key (scope_key '' predates the column; legacy rows are keyed
   *  by their bare retry key). For a legacy caller the two keys coincide, so
   *  the query is behaviour-identical to the pre-split one-identity shape. */
  private scopeRows(lane: string, scopeKey: string, legacyKey: string): Array<{ retry_key: string; state: string; receipt: string }> {
    return this.storage.sql.exec(
      `SELECT retry_key,state,receipt FROM train_check_retries WHERE lane_id=? AND (retry_key=? OR scope_key=? OR retry_key=? OR scope_key=?)`,
      lane, scopeKey, scopeKey, legacyKey, legacyKey,
    ).toArray().map((r: any) => ({ retry_key: String(r.retry_key), state: String(r.state), receipt: String(r.receipt) }));
  }

  command(lane: string, raw: unknown, now: number, scope?: { purpose: CheckRetryPurpose; coverageReceipt: string }) {
    const command = CheckRetryCommandSchema.parse(raw);
    return this.storage.transactionSync(() => {
      if (command.kind === "reserve") {
        if (command.source.kind === "unknown") throw new Error("gate: check retry requires a typed GitHub source");
        const obligation = checkObligationKey(command);
        const legacyObligation = legacyCheckObligationKey(command);
        const scopeKey = checkRetryScopeKey(command.task_id, command.head_sha, obligation);
        const legacyKey = obligation === legacyObligation ? scopeKey : checkRetryScopeKey(command.task_id, command.head_sha, legacyObligation);
        // Unknown prior effect fence — SCOPE-WIDE and BEFORE both purpose
        // branches (independent review P1): any prepared/outcome_unknown
        // dispatch of this [task, head, obligation] scope — bare-key or
        // coverage-scoped, pre-split or producer-typed, whatever purpose
        // issued it — stays fenced until its receipts reconcile. NO purpose
        // (stale_destination_gate, ordinary_head_check, or a legacy scope-less
        // caller) may grant a retry past an unreconciled external effect;
        // repeating one is the one unrecoverable move, and a new successful
        // coverage never licenses it. BR#9268: the producer split must never
        // re-arm an unknown effect of the collapsed pre-split identity.
        const rows = this.scopeRows(lane, scopeKey, legacyKey);
        const fenced = rows.find((r) => r.state === "prepared" || r.state === "outcome_unknown");
        if (fenced) return { kind: "held" as const, key: fenced.retry_key, state: fenced.state, receipt: fenced.receipt };
        if (scope?.purpose === "stale_destination_gate") {
          const scopedKey = checkRetryScopedKey(scopeKey, scope.purpose, scope.coverageReceipt);
          // The scoped budget binds THIS identity only (BR#9268): the key is
          // built on the producer-typed scope key, so a terminal row of the
          // collapsed pre-split identity can never satisfy or consume it.
          const old = rows.find((r) => r.retry_key === scopedKey);
          if (old) return { kind: "held" as const, key: scopedKey, state: old.state, receipt: old.receipt };
          this.storage.sql.exec(
            `INSERT INTO train_check_retries(lane_id,retry_key,state,receipt,updated_ts,scope_key) VALUES(?,?,'prepared',?,?,?)`,
            lane, scopedKey, JSON.stringify(command.target), now, scopeKey);
          return { kind: "reserved" as const, key: scopedKey };
        }
        // ordinary_head_check (and legacy callers): the bare scope key is the
        // permanent budget — any prior row of it holds, unchanged. Only a
        // terminal row can reach here (the fence above holds every
        // prepared/outcome_unknown row of the scope). BR#9268: for a
        // producer-typed command the hold matches only rows of THIS
        // identity — a terminal row of the collapsed pre-split key dispatched
        // some other check (never the native job) and does not consume this
        // budget; for a legacy caller the two identities coincide and the
        // hold is byte-compatible with the pre-split law.
        const old = rows.find((r) => r.retry_key === scopeKey);
        if (old) return { kind: "held" as const, key: scopeKey, state: old.state, receipt: old.receipt };
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