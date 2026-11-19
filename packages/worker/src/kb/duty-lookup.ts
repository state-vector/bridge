/** A small, durable secondary lookup. Building a JSON expression index over
 * historical artefact metadata synchronously can reset the DO. Backfill this
 * mirror in committed pages, yielding between them; triggers cover new writes.
 */
export const DUTY_LOOKUP_SCHEMA = `
  CREATE TABLE IF NOT EXISTS machine_duty_subjects (
    task_id TEXT PRIMARY KEY, subject TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS machine_duty_subject_lookup ON machine_duty_subjects(subject);
  CREATE TRIGGER IF NOT EXISTS machine_duty_subject_insert AFTER INSERT ON artefacts
  WHEN new.type='task' AND json_type(new.meta,'$.machine_duty.subject')='text' BEGIN
    INSERT OR REPLACE INTO machine_duty_subjects VALUES(new.id,json_extract(new.meta,'$.machine_duty.subject'));
  END;
  CREATE TRIGGER IF NOT EXISTS machine_duty_subject_update AFTER UPDATE OF meta,type ON artefacts BEGIN
    DELETE FROM machine_duty_subjects WHERE task_id=new.id;
    INSERT INTO machine_duty_subjects SELECT new.id,json_extract(new.meta,'$.machine_duty.subject')
      WHERE new.type='task' AND json_type(new.meta,'$.machine_duty.subject')='text';
  END;
  CREATE TRIGGER IF NOT EXISTS machine_duty_subject_delete AFTER DELETE ON artefacts BEGIN
    DELETE FROM machine_duty_subjects WHERE task_id=old.id;
  END;
`;

export async function backfillDutyLookup(sql: SqlStorage): Promise<void> {
  const key = 'machine_duty_subject_cursor_v1';
  const saved = sql.exec<{value: string}>(`SELECT value FROM settings WHERE key=?`, key).toArray()[0];
  const previous: string = saved ? JSON.parse(saved.value) : '';
  if (previous === 'done') return;
  let cursor = previous;
  while (true) {
    // Select primary keys first; only these rows' JSON is read this turn.
    const page = sql.exec<{id: string}>(`SELECT id FROM artefacts WHERE id>? ORDER BY id LIMIT 32`, cursor).toArray();
    if (!page.length) {
      sql.exec(`INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`, key, JSON.stringify('done'));
      return;
    }
    const end = page[page.length - 1].id;
    sql.exec(`INSERT OR IGNORE INTO machine_duty_subjects(task_id,subject)
      SELECT id,json_extract(meta,'$.machine_duty.subject') FROM artefacts
      WHERE id>? AND id<=? AND type='task' AND json_type(meta,'$.machine_duty.subject')='text'`, cursor, end);
    sql.exec(`INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`, key, JSON.stringify(end));
    cursor = end;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}
