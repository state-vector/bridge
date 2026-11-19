/** Named SQL boundaries make native production CPU samples attributable to a
 * query family. Log row counts only; never SQL arguments or returned work. */
function rows(sql: SqlStorage, operation: string, query: string, ...args: SqlStorageValue[]) {
  const cursor=sql.exec(query,...args), result=cursor.toArray();
  if (cursor.rowsRead>10000) console.log(JSON.stringify({type:"bridge.sql",operation,rows_read:cursor.rowsRead,rows_returned:result.length}));
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
export function trainReviewChildRows(sql:SqlStorage,id:string) {
  return rows(sql,"train.review_children",`SELECT a.id AS id,a.status AS status,a.body_md AS body_md,a.meta AS meta,a.updated_ts AS updated_ts
    FROM relations rel JOIN artefacts a ON a.id=rel.src_id
    WHERE rel.relation='child_of' AND rel.dst_id=? AND a.type='task' AND a.roles LIKE '%"review"%'
    ORDER BY a.created_ts DESC`,id);
}
export function trainSeenPrRows(sql:SqlStorage,repo:string) {
  return rows(sql,"train.seen_prs",`SELECT pr,card FROM reconcile_seen WHERE repo=? AND missing=0 ORDER BY pr ASC`,repo);
}
