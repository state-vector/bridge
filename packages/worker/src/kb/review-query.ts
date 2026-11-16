const subjectExpression = `COALESCE(json_extract(meta,'$.review_subject.task_id'),json_extract(meta,'$.execution_review_of'),json_extract(meta,'$.review_result.task_id'))`;
const subject = `COALESCE(json_extract(c.meta,'$.review_subject.task_id'),json_extract(c.meta,'$.execution_review_of'),json_extract(c.meta,'$.review_result.task_id'))`;

export const REVIEW_LOOKUP_SCHEMA = `
  CREATE INDEX IF NOT EXISTS idx_task_review_subject ON artefacts(${subjectExpression},created_ts DESC) WHERE type='task';
  CREATE INDEX IF NOT EXISTS idx_relations_incoming ON relations(dst_id,relation,src_id);
  CREATE INDEX IF NOT EXISTS idx_open_review_reconcile ON artefacts(status)
    WHERE type='task' AND status IN ('in_review','todo');
`;

/** Background repair rotates across a bounded page, not every open card on
 * every alarm. The authoritative current-review lookup still runs immediately
 * before applying each verdict; this query grants no acceptance authority. */
export const REVIEW_RECONCILE_BATCH_SIZE = 25;
export const REVIEW_RECONCILE_BATCH_SQL = `SELECT rowid AS cursor,id FROM artefacts
  WHERE type='task' AND status IN ('in_review','todo') AND rowid>?
  ORDER BY rowid LIMIT ?`;

export const REVIEW_BACKFILL_BATCH_SQL = `SELECT rowid AS cursor,id,meta,status_ts FROM artefacts
  WHERE type='task' AND status='done' AND roles LIKE '%review%' AND rowid>?
  ORDER BY rowid LIMIT ?`;

// Separate indexed declared subjects from the legacy child lookup. An OR with
// a correlated relation subquery scanned every retained review for EACH task
// in train/watchdog projections. Both branches keep exactly the same authority
// predicates; newest round (including pending/findings) wins, never a cache.
export const CURRENT_REVIEW_SQL = `
  SELECT c.id,c.status,c.meta,c.created_ts,c.status_ts,c.rowid AS review_order
  FROM artefacts c
  WHERE c.type='task' AND c.roles LIKE '%"review"%' AND c.status!='superseded' AND ${subject}=?
  UNION ALL
  SELECT c.id,c.status,c.meta,c.created_ts,c.status_ts,c.rowid AS review_order
  FROM relations r JOIN artefacts c ON c.id=r.src_id
  WHERE r.dst_id=? AND r.relation='child_of'
    AND c.type='task' AND c.roles LIKE '%"review"%' AND c.status!='superseded'
    AND ${subject} IS NULL
    AND (SELECT COUNT(*) FROM relations parents JOIN artefacts p ON p.id=parents.dst_id
      WHERE parents.src_id=c.id AND parents.relation='child_of' AND p.type='task')=1
  ORDER BY created_ts DESC,review_order DESC LIMIT 1
`;
