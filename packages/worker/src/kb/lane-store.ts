import { LaneSnapshotSchema, type LaneOperationalState, type LaneSnapshot } from "@bridge/contracts";

/** These are machinery state; all other card metadata is ordinary card data. */
export const LANE_RUNTIME_KEYS = ["lane", "lease", "currently", "stop", "bypass_wait", "zombie", "blocked"] as const;
export const LANE_REVISION = "__lane_revision";
type Meta = Record<string, unknown>;
type CanonicalRow = { lane_key: string; lane_id: string | null; revision: number; snapshot_json: string | null };
const paths = [...LANE_RUNTIME_KEYS, LANE_REVISION].map(key => `'$.${key}'`).join(",");
const columns = (meta: string, updated: string) => `a.rowid AS rowid,a.id,a.type,a.title,a.status,a.body_md,${meta} AS meta,a.owner,a.created_ts,${updated} AS updated_ts,a.status_ts,a.tags,a.roles,a.project,a.created_by`;
// json_each loses JSON subtypes across UNION; explicitly re-tag values so
// objects, arrays, booleans AND nulls survive the authoritative overlay.
const overlay = `(SELECT json_group_object(key,json(CASE type
  WHEN 'object' THEN value WHEN 'array' THEN value WHEN 'text' THEN json_quote(value)
  WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'null' THEN 'null' ELSE CAST(value AS TEXT) END))
  FROM (SELECT key,value,type FROM json_each(json_remove(a.meta,${paths}))
    UNION ALL SELECT key,value,type FROM json_each(s.snapshot_json,'$.facts')))`;
const canonicalMeta = `CASE WHEN json_extract(s.snapshot_json,'$.schema_version')=1
  AND json_extract(s.snapshot_json,'$.lane_id')=a.id AND json_extract(s.snapshot_json,'$.revision')=s.revision
  AND json_extract(s.snapshot_json,'$.facts.lane.key')=s.lane_key
  AND json_extract(s.snapshot_json,'$.facts.lane.repo')=s.repo AND json_extract(s.snapshot_json,'$.facts.lane.base')=s.base
  THEN json_set(${overlay},'$.${LANE_REVISION}',s.revision)
  ELSE json('invalid canonical lane snapshot') END`;
export const LANE_VIEW_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_lane_state_card ON lane_state(lane_id) WHERE lane_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_artefacts_lane_key ON artefacts(json_extract(meta,'$.lane.key'))
    WHERE type='task' AND json_extract(meta,'$.lane.key') IS NOT NULL;
  CREATE VIEW IF NOT EXISTS lane_cards AS
    SELECT ${columns(canonicalMeta, "MAX(a.updated_ts,s.updated_ts)")}
    FROM lane_state s JOIN artefacts a ON a.id=s.lane_id WHERE s.snapshot_json IS NOT NULL
    UNION ALL
    SELECT ${columns(`json_set(a.meta,'$.${LANE_REVISION}',0)`, "a.updated_ts")}
    FROM artefacts a WHERE a.type='task' AND json_extract(a.meta,'$.lane.key') IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM lane_state s WHERE s.lane_id=a.id AND s.snapshot_json IS NOT NULL);
`;

/** One durable authority, with an atomic compatibility mirror for old builds.
 * Revision travels only inside hub reads; callers cannot author it. */
export class LaneStore {
  private ids: Set<string> | null = null;
  constructor(private storage: DurableObjectStorage, private atomic: <T>(action: () => T) => T) {}
  private row(key: string): CanonicalRow | null {
    return this.storage.sql.exec<CanonicalRow>(`SELECT lane_key,lane_id,revision,snapshot_json FROM lane_state WHERE lane_key=?`, key).toArray()[0] ?? null;
  }
  isCanonicalCard(id: string): boolean {
    this.ids ??= new Set(this.storage.sql.exec(`SELECT lane_id FROM lane_state WHERE snapshot_json IS NOT NULL`).toArray().map(row => String(row.lane_id)));
    return this.ids.has(id);
  }
  publicMeta(id: string, raw: string): Meta {
    let meta: Meta = JSON.parse(raw);
    if (meta.lane || this.isCanonicalCard(id)) {
      const row = this.storage.sql.exec(`SELECT meta FROM lane_cards WHERE id=?`, id).toArray()[0];
      if (row) meta = JSON.parse(String(row.meta));
    }
    delete meta[LANE_REVISION];
    return meta;
  }
  operational(id: string): LaneOperationalState | null {
    const row = this.storage.sql.exec(`SELECT snapshot_json FROM lane_state WHERE lane_id=?`, id).toArray()[0];
    return row?.snapshot_json ? LaneSnapshotSchema.parse(JSON.parse(String(row.snapshot_json))).operational : null;
  }
  save(id: string, key: string, repo: string, base: string, meta: Meta, operational: LaneOperationalState, now: number): LaneSnapshot {
    const saved = this.atomic(() => {
      const current = this.row(key);
      const expected = meta[LANE_REVISION] ?? 0;
      const rebinding = !!current?.lane_id && current.lane_id !== id;
      if (rebinding) {
        const prior = this.storage.sql.exec(`SELECT status FROM artefacts WHERE id=?`, current.lane_id).toArray()[0];
        if (!prior || !["done", "superseded"].includes(String(prior.status))) throw new Error("gate: canonical lane still belongs to its active card");
      }
      if (!Number.isInteger(expected) || (!rebinding && expected !== (current?.revision ?? 0))) throw new Error("gate: lane revision changed; reread canonical state before applying the mutation");
      const facts: Meta = {};
      for (const field of LANE_RUNTIME_KEYS) if (Object.hasOwn(meta, field)) facts[field] = meta[field];
      // Status text is a projection, not an input to operational authority.
      const laneFacts: Meta = { ...(facts.lane as Meta), key, repo, base }; delete laneFacts.line; facts.lane = laneFacts;
      const snapshot = LaneSnapshotSchema.parse({ schema_version: 1, lane_id: id, revision: (current?.revision ?? 0) + 1, operational, facts });
      const card = this.storage.sql.exec(`SELECT meta FROM artefacts WHERE id=?`, id).toArray()[0];
      if (!card) throw new Error("gate: canonical lane card is missing");
      const mirror: Meta = JSON.parse(String(card.meta));
      for (const field of [...LANE_RUNTIME_KEYS, LANE_REVISION]) delete mirror[field];
      Object.assign(mirror, snapshot.facts);
      if (current?.snapshot_json && !rebinding) {
        const prior = LaneSnapshotSchema.parse(JSON.parse(current.snapshot_json));
        if (JSON.stringify(prior.facts) === JSON.stringify(snapshot.facts)
            && JSON.stringify({ ...prior.operational, updated_ts: 0 }) === JSON.stringify({ ...operational, updated_ts: 0 })) {
          if (JSON.stringify(mirror) !== card.meta) this.storage.sql.exec(`UPDATE artefacts SET meta=? WHERE id=?`, JSON.stringify(mirror), id);
          return prior;
        }
      }
      const lane = snapshot.facts.lane as { last_capable_lease_ts?: number; last_capable_holder?: string };
      const lease = snapshot.facts.lease as { holder: string; heartbeat_ts: number; expires_ts: number } | null | undefined;
      this.storage.sql.exec(`UPDATE artefacts SET meta=?,updated_ts=? WHERE id=?`, JSON.stringify(mirror), now, id);
      this.storage.sql.exec(`INSERT OR REPLACE INTO lane_state
        (lane_key,repo,base,phase,lease_holder,lease_heartbeat_ts,lease_expires_ts,last_capable_ts,last_capable_holder,state_json,updated_ts,lane_id,revision,snapshot_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, key, repo, base, operational.phase, lease?.holder ?? null, lease?.heartbeat_ts ?? null,
        lease?.expires_ts ?? null, lane.last_capable_lease_ts ?? null, lane.last_capable_holder ?? null, JSON.stringify(operational), now, id, snapshot.revision, JSON.stringify(snapshot));
      return snapshot;
    });
    this.ids?.add(id);
    meta[LANE_REVISION] = saved.revision;
    return saved;
  }
}
