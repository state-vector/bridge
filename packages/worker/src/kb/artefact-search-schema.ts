// The search index contains only title and body. Progress, claims, and other
// metadata updates must not delete and reinsert those tokens.
const updateTrigger = `
CREATE TRIGGER IF NOT EXISTS artefacts_au AFTER UPDATE OF title, body_md ON artefacts
  WHEN old.title IS NOT new.title OR old.body_md IS NOT new.body_md BEGIN
  INSERT INTO artefacts_fts(artefacts_fts, rowid, title, body_md)
    VALUES ('delete', old.rowid, old.title, old.body_md);
  INSERT INTO artefacts_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
END;
`;

export const ARTEFACT_SEARCH_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS artefacts_fts USING fts5(
  title, body_md, content='artefacts', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS artefacts_ai AFTER INSERT ON artefacts BEGIN
  INSERT INTO artefacts_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
END;
CREATE TRIGGER IF NOT EXISTS artefacts_ad AFTER DELETE ON artefacts BEGIN
  INSERT INTO artefacts_fts(artefacts_fts, rowid, title, body_md)
    VALUES ('delete', old.rowid, old.title, old.body_md);
END;
${updateTrigger}
`;

export const ARTEFACT_SEARCH_LEGACY_TRIGGER_SQL = `SELECT 1 FROM sqlite_master
  WHERE type='trigger' AND name='artefacts_au' AND instr(sql,'AFTER UPDATE ON artefacts')>0`;
export const ARTEFACT_SEARCH_MIGRATION_SQL = `DROP TRIGGER artefacts_au; ${updateTrigger}`;
