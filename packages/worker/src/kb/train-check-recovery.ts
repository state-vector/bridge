import { CheckRetryCommandSchema, checkObligationKey } from "@bridge/contracts";

/** Durable, one-attempt-per-head/obligation ledger. A crash after reservation
 * leaves an unknown effect fenced; a restarted executor cannot repeat it. */
export class TrainCheckRecovery {
  constructor(private storage: DurableObjectStorage) {}
  command(lane: string, raw: unknown, now: number) {
    const command = CheckRetryCommandSchema.parse(raw);
    return this.storage.transactionSync(() => {
      if (command.kind === "reserve") {
        if (command.source.kind === "unknown") throw new Error("gate: check retry requires a typed GitHub source");
        const key = JSON.stringify([command.task_id, command.head_sha, checkObligationKey(command)]);
        const old = this.storage.sql.exec(`SELECT state,receipt FROM train_check_retries WHERE lane_id=? AND retry_key=?`, lane, key).toArray()[0];
        if (old) return { kind: "held" as const, key, state: String(old.state), receipt: String(old.receipt) };
        this.storage.sql.exec(`INSERT INTO train_check_retries(lane_id,retry_key,state,receipt,updated_ts) VALUES(?,?,'prepared',?,?)`, lane, key, JSON.stringify(command.target), now);
        return { kind: "reserved" as const, key };
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
