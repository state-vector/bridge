const boardKind = "type IN ('task','question')";
const terminalRank = "CASE WHEN status IN ('done','superseded') THEN 1 ELSE 0 END";

export const BOARD_INDEX_SCHEMA = `
  CREATE INDEX IF NOT EXISTS idx_board_recent_cards
    ON artefacts(${terminalRank}, updated_ts DESC) WHERE ${boardKind};
`;

export const BOARD_RECENT_IDS_SQL = `SELECT id FROM artefacts INDEXED BY idx_board_recent_cards
  WHERE ${boardKind} ORDER BY ${terminalRank}, updated_ts DESC LIMIT 250`;
