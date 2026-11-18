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

export const STALL_SESSION_LOOKUP_SCHEMA = `
  CREATE INDEX IF NOT EXISTS idx_session_name_ping ON sessions(name,last_seen_ts DESC,kind);
  CREATE INDEX IF NOT EXISTS idx_stall_sweep_active ON artefacts(type)
    WHERE type='task' AND status='in_progress';
`;
export const STALL_SESSION_PINGS_SQL = `SELECT MAX(last_seen_ts) AS seen,
  MAX(CASE WHEN COALESCE(kind,'') <> 'gateway' THEN last_seen_ts END) AS worker_seen
  FROM sessions WHERE name=?`;

export const STALL_SWEEP_PAGE_SIZE = 4;
export const STALL_SWEEP_PAGE_SQL = `SELECT rowid AS cursor,id,status,owner,title,meta,status_ts,updated_ts
  FROM artefacts INDEXED BY idx_stall_sweep_active
  WHERE type='task' AND status='in_progress' AND rowid>? AND rowid<=? ORDER BY rowid LIMIT ${STALL_SWEEP_PAGE_SIZE}`;

export const BREACH_CARD_LOOKUP_SCHEMA = `
  CREATE INDEX IF NOT EXISTS idx_breach_card_key ON artefacts(json_extract(meta,'$.breach_key'))
  WHERE type='task' AND json_extract(meta,'$.breach_key') IS NOT NULL;
`;
export const BREACH_CARDS_SQL = `SELECT id,status,meta,status_ts,created_ts FROM artefacts
  WHERE type='task' AND json_extract(meta,'$.breach_key')>=? AND json_extract(meta,'$.breach_key')<?`;

export const BREACH_EVENTS_SQL = `SELECT ts,action AS op,data AS detail
  FROM ledger INDEXED BY idx_ledger_card_action_time WHERE artefact_id=? AND kind='signal'
    AND action IN ('transition_rejected','invariant_violation','spawn_skipped','replay_mismatch') AND ts>?
  ORDER BY seq ASC LIMIT 200`;
