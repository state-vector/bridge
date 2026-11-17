export const GRAPH_PAGE_SIZE = 100;
export const OPEN_GRAPH_CARD = "type IN ('task','question') AND status NOT IN ('done','superseded')";

const open = (row: "old" | "new") =>
  `${row}.type IN ('task','question') AND ${row}.status NOT IN ('done','superseded')`;
const record = (query: string) => `INSERT INTO work_graph_changes(id) ${query}
  ON CONFLICT(id) DO UPDATE SET seq=excluded.seq;`;
const parent = (row: "old" | "new") => `SELECT dst_id FROM relations
  WHERE relation='child_of' AND src_id=${row}.id AND ${row}.type='question'`;
const graphMetaChanged = ["blocked", "startup_wait", "merge_train.state", "depends_on", "infra_anchor", "ask"]
  .map(key => `json_extract(old.meta,'$.${key}') IS NOT json_extract(new.meta,'$.${key}')`).join(" OR ");
const recordRelation = (row: "old" | "new") =>
  record(`SELECT id FROM artefacts WHERE id IN (${row}.src_id,${row}.dst_id) AND ${OPEN_GRAPH_CARD}`);
const execChanged = ["generation", "attempt.phase", "operations"]
  .map(key => `json_extract(old.state,'$.${key}') IS NOT json_extract(new.state,'$.${key}')`).join(" OR ");
const recordExecution = (row: "old" | "new") =>
  record(`SELECT id FROM artefacts WHERE id=${row}.task_id AND ${OPEN_GRAPH_CARD}`);

export function workGraphChangeSchema(defaultSink: string) {
  const sinkId = (value: string) => `CASE WHEN json_valid(${value}) THEN
    CASE WHEN json_type(${value}) IN ('text','integer','real') THEN CAST(json_extract(${value},'$') AS TEXT)
    ELSE ${value} END ELSE ${value} END`;
  return `
    CREATE TABLE IF NOT EXISTS work_graph_changes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS work_graph_card_insert AFTER INSERT ON artefacts WHEN ${open("new")} BEGIN
      ${record("VALUES(new.id)")}
      ${record(parent("new"))}
    END;
    CREATE TRIGGER IF NOT EXISTS work_graph_card_update AFTER UPDATE OF type,title,status,meta ON artefacts
      WHEN ((${open("old")}) OR (${open("new")})) AND
        (old.type IS NOT new.type OR old.title IS NOT new.title OR old.status IS NOT new.status OR ${graphMetaChanged}) BEGIN
      ${record("VALUES(new.id)")}
      ${record(`${parent("new")} AND (old.status IS NOT new.status OR old.type IS NOT new.type
        OR json_extract(old.meta,'$.ask') IS NOT json_extract(new.meta,'$.ask'))`)}
    END;
    CREATE TRIGGER IF NOT EXISTS work_graph_card_delete BEFORE DELETE ON artefacts WHEN ${open("old")} BEGIN
      ${record("VALUES(old.id)")}
      ${record(parent("old"))}
    END;
    CREATE TRIGGER IF NOT EXISTS work_graph_link_insert AFTER INSERT ON relations WHEN new.relation='child_of' BEGIN
      ${recordRelation("new")}
    END;
    CREATE TRIGGER IF NOT EXISTS work_graph_link_delete AFTER DELETE ON relations WHEN old.relation='child_of' BEGIN
      ${recordRelation("old")}
    END;
    CREATE TRIGGER IF NOT EXISTS work_graph_execution_insert AFTER INSERT ON execution_state BEGIN
      ${recordExecution("new")}
    END;
    CREATE TRIGGER IF NOT EXISTS work_graph_execution_update AFTER UPDATE OF state ON execution_state
      WHEN ${execChanged} BEGIN
      ${recordExecution("new")}
    END;
    CREATE TRIGGER IF NOT EXISTS work_graph_execution_delete AFTER DELETE ON execution_state BEGIN
      ${recordExecution("old")}
    END;
    -- settingsSet uses INSERT OR REPLACE. Read the prior value before replacement.
    CREATE TRIGGER IF NOT EXISTS work_graph_sink_insert BEFORE INSERT ON settings
      WHEN new.key IN ('train_alarm_sink_id','reconcile_alarm_sink_id') BEGIN
      ${record(`SELECT id FROM artefacts WHERE ${OPEN_GRAPH_CARD} AND id IN (
        ${sinkId("new.value")}, COALESCE((SELECT ${sinkId("value")} FROM settings WHERE key=new.key), '${defaultSink}')
      )`)}
    END;
  `;
}
