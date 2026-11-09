/** Index the canonical append-only ledger, including queries through its two
 * compatibility views. Retained unrelated receipts must not tax every card. */
export const LEDGER_LOOKUP_SCHEMA = `
  CREATE INDEX IF NOT EXISTS idx_ledger_card_kind_seq ON ledger(artefact_id,kind,seq);
  CREATE INDEX IF NOT EXISTS idx_ledger_card_actor_time ON ledger(artefact_id,kind,actor,ts);
  CREATE INDEX IF NOT EXISTS idx_ledger_card_action_time ON ledger(artefact_id,kind,action,ts);
  CREATE INDEX IF NOT EXISTS idx_ledger_action_time ON ledger(kind,action,ts);
`;
export const RECENT_TASK_MUTATIONS_SQL = `SELECT ts, actor, action, summary FROM artefact_versions WHERE artefact_id = ? ORDER BY seq DESC LIMIT 50`;
export const TASK_HISTORY_SQL = `SELECT seq, ts, actor, action, summary, data FROM artefact_versions
  WHERE artefact_id = ? ORDER BY seq DESC LIMIT ?`;
export const LAST_ACTOR_SIGNAL_SQL = `SELECT MAX(ts) AS ts FROM events WHERE artefact_id = ? AND actor = ?`;
export const LAST_NUDGE_SQL = `SELECT ts FROM events WHERE artefact_id = ? AND op = 'nudge' ORDER BY ts DESC LIMIT 1`;
export const RECENT_PROGRESS_SQL = `SELECT actor, data FROM artefact_versions WHERE action = 'progress' AND ts >= ?`;
