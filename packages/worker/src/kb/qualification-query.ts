/** Drive scoped evidence from the selected parent IDs. Otherwise SQLite starts
 * with every historical done card using its status index, then probes relations
 * for each parent ID — a historical-card × selected-parent scan on every push. */
export const SCOPED_ROLE_EVIDENCE_SQL = `SELECT r.dst_id AS pid, c.roles AS roles
  FROM json_each(?) selected
  CROSS JOIN relations r INDEXED BY idx_relations_incoming
  CROSS JOIN artefacts c ON c.id=r.src_id
  WHERE r.dst_id=selected.value AND r.relation='child_of' AND c.status='done'`;
export const SCOPED_DECISION_EVIDENCE_SQL = `SELECT r.dst_id AS tid
  FROM json_each(?) selected
  CROSS JOIN relations r INDEXED BY idx_relations_incoming
  CROSS JOIN artefacts d ON d.id=r.src_id
  WHERE r.dst_id=selected.value AND r.relation='supports' AND d.type='decision' AND d.status='accepted'`;
export const SCOPED_OPEN_ASKS_SQL = `SELECT r.dst_id AS pid
  FROM json_each(?) selected
  CROSS JOIN relations r INDEXED BY idx_relations_incoming
  CROSS JOIN artefacts c ON c.id=r.src_id
  WHERE r.dst_id=selected.value AND r.relation='child_of' AND c.type='question'
    AND c.status IN ('todo','in_progress','blocked') AND json_extract(c.meta,'$.ask') IS NOT NULL`;
