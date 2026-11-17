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

export const WATCHDOG_REVIEW_LOOKUP_SCHEMA = `
  CREATE INDEX IF NOT EXISTS idx_delivery_admission_phase
    ON delivery_admissions(json_extract(record,'$.state.phase'));
  CREATE INDEX IF NOT EXISTS idx_train_events_pr_kind_ts
    ON train_events(repo,pr,kind,ts DESC) WHERE pr IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_held_admission_task
    ON delivery_admissions(json_extract(record,'$.task_id'))
    WHERE json_extract(record,'$.state.phase')='held';
  CREATE INDEX IF NOT EXISTS idx_blocked_pr_merge_wait
    ON artefacts(id)
    WHERE status='blocked' AND json_extract(meta,'$.blocked.await_event.event')='pr_merged';
  CREATE INDEX IF NOT EXISTS idx_open_coordination_target
    ON artefacts(json_extract(meta,'$.ask.route.task_id'))
    WHERE type='question' AND status IN ('todo','in_progress','blocked')
      AND json_extract(meta,'$.ask.route.kind')='executor_coordination';
  CREATE INDEX IF NOT EXISTS idx_open_question_id
    ON artefacts(id) WHERE type='question' AND status IN ('todo','in_progress','blocked');
`;

// Lead with the active wait set. Driving the join from admission history to
// match ORDER BY can visit every retained admission when no current wait matches.
// Unary + removes the card column affinity so SQLite can seek the JSON index.
export const HELD_MERGE_ADMISSIONS_SQL = `SELECT NULL AS cursor, a.review_id
  FROM artefacts t INDEXED BY idx_blocked_pr_merge_wait
  CROSS JOIN delivery_admissions a INDEXED BY idx_held_admission_task
    ON json_extract(a.record,'$.task_id')=+t.id
  WHERE t.status='blocked' AND json_extract(t.meta,'$.blocked.await_event.event')='pr_merged'
    AND json_extract(a.record,'$.state.phase')='held'
    AND EXISTS (SELECT 1 FROM json_each(a.record,'$.legs') leg
      WHERE json_extract(leg.value,'$.repo')=json_extract(t.meta,'$.blocked.await_event.repo')
        AND json_extract(leg.value,'$.number')=json_extract(t.meta,'$.blocked.await_event.n'))
  ORDER BY a.rowid DESC LIMIT 4`;

export const RETIRE_COORDINATION_SWEEP_SQL = `
  SELECT q.id, q.meta, p.id AS parent_id, p.status AS parent_status
  FROM artefacts q INDEXED BY idx_open_question_id
  CROSS JOIN artefacts p ON p.id IN (
    SELECT dst_id FROM relations WHERE src_id=q.id AND relation='child_of'
    UNION SELECT json_extract(q.meta,'$.ask.route.task_id')
      WHERE json_extract(q.meta,'$.ask.route.kind')='executor_coordination'
  )
  WHERE q.type='question' AND q.status IN ('todo','in_progress','blocked')
    AND p.type='task' AND p.status IN ('done','superseded')`;

// A foreground close only retires requests bound to that task. The watchdog
// still repairs any earlier interrupted or historical close.
export const RETIRE_COORDINATION_FOR_TASK_SQL = `WITH candidates(id) AS (
    SELECT src_id FROM relations WHERE dst_id=?1 AND relation='child_of'
    UNION
    SELECT id FROM artefacts WHERE type='question' AND status IN ('todo','in_progress','blocked')
      AND json_extract(meta,'$.ask.route.kind')='executor_coordination'
      AND json_extract(meta,'$.ask.route.task_id')=?1
  )
  SELECT q.id,q.meta,p.id AS parent_id,p.status AS parent_status
  FROM candidates c JOIN artefacts q ON q.id=c.id JOIN artefacts p ON p.id=?1
  WHERE q.type='question' AND q.status IN ('todo','in_progress','blocked')
    AND p.type='task' AND p.status IN ('done','superseded')`;


// Both arms can seek (phase, rowid), including at the end of retained
// history when there are no replay candidates. Merge the bounded results in
// the same rowid order as the durable replay cursor.
export const DELIVERY_ADMISSION_REPLAY_SQL = `SELECT cursor,review_id FROM (
  SELECT rowid AS cursor,review_id FROM delivery_admissions INDEXED BY idx_delivery_admission_phase
  WHERE json_extract(record,'$.state.phase')='pending' AND rowid>?1 ORDER BY rowid LIMIT 10
) UNION ALL SELECT cursor,review_id FROM (
  SELECT rowid AS cursor,review_id FROM delivery_admissions INDEXED BY idx_delivery_admission_phase
  WHERE json_extract(record,'$.state.phase')='held' AND rowid>?1 ORDER BY rowid LIMIT 10
) ORDER BY cursor LIMIT 10`;

export const LATEST_PR_MERGE_SQL = `SELECT merge_sha FROM train_events
  WHERE repo=? AND pr=? AND kind='merged' ORDER BY ts DESC LIMIT 1`;
