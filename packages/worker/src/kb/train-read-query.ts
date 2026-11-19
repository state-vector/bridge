/** A read is BROAD when it reads disproportionately to what it returns —
 *  the size-independent signal of a seek turned scan. A healthy bounded
 *  family reads proportional to its result (3,000 read / 3,000 returned is
 *  bulk, not waste); a broken plan reads the corpus to answer a point
 *  question (14,098 read / 1 returned, or 200,000/1 after growth). The
 *  floor keeps micro-reads out of ratio noise; the ratio carries all the
 *  scaling — no absolute row threshold to recalibrate as the hub grows. */
export function broadRead(rowsRead: number, rowsReturned: number): boolean {
  return rowsRead >= 200 && rowsRead > 10 * Math.max(rowsReturned, 1);
}

/** Named SQL boundaries make native production CPU samples attributable to a
 * query family. Log row counts only; never SQL arguments or returned work. */
function rows(sql: SqlStorage, operation: string, query: string, ...args: SqlStorageValue[]) {
  const cursor=sql.exec(query,...args), result=cursor.toArray();
  if (broadRead(cursor.rowsRead, result.length)) console.log(JSON.stringify({type:"bridge.sql",operation,rows_read:cursor.rowsRead,rows_returned:result.length,amplification:Number((cursor.rowsRead/Math.max(result.length,1)).toFixed(1))}));
  return result;
}
export function trainProvenanceRows(sql:SqlStorage,repo:string) {
  return rows(sql,"train.provenance",`SELECT pr FROM provenance WHERE repo=?`,repo);
}
export function trainMergedProbeRows(sql:SqlStorage,repo:string) {
  return rows(sql,"train.merged_probes",`SELECT pr FROM proxy_probes WHERE repo=? AND kind='pr_merged' AND state='verified' AND ok=1`,repo);
}
export function trainTerminalOutcomeRows(sql:SqlStorage,repo:string) {
  return rows(sql,"train.terminal_outcomes",`SELECT pr FROM delivery_pr_outcomes WHERE repo=? AND state IN ('MERGED','CLOSED')`,repo);
}
export function trainIgnoredPrRows(sql:SqlStorage,repo:string) {
  return rows(sql,"train.ignored_prs",`SELECT pr FROM reconcile_ignores WHERE repo=?`,repo);
}
// Production chose the task-type index first: ~13,750 historical rows per
// parent, even for an empty result. Pin the authoritative relation seek first.
export const TRAIN_REVIEW_CHILDREN_SQL = `SELECT a.id AS id,a.status AS status,a.body_md AS body_md,a.meta AS meta,a.updated_ts AS updated_ts
    FROM relations rel INDEXED BY idx_relations_incoming
    CROSS JOIN artefacts a ON a.id=rel.src_id
    WHERE rel.relation='child_of' AND rel.dst_id=? AND a.type='task' AND a.roles LIKE '%"review"%'
    ORDER BY a.created_ts DESC`;
export function trainReviewChildRows(sql:SqlStorage,id:string) {
  return rows(sql,"train.review_children",TRAIN_REVIEW_CHILDREN_SQL,id);
}
export function trainSeenPrRows(sql:SqlStorage,repo:string) {
  return rows(sql,"train.seen_prs",`SELECT pr,card FROM reconcile_seen WHERE repo=? AND missing=0 ORDER BY pr ASC`,repo);
}
