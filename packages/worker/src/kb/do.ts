/**
 * KnowledgeHub Durable Object — the coordination layer's storage + rules.
 *
 * One DO per project ("global" for now). SQLite: artefacts, typed relations,
 * audit events, FTS5 over title+body. Every mutation writes an audit event and
 * bumps updated_ts. Lifecycle transitions and relation rules are enforced HERE,
 * not in clients.
 *
 * Transport: the worker forwards JSON op requests via fetch("https://kb/<op>").
 * Ops: create | get | list | search | update | transition | link | stats
 */
import {
  ARTEFACT_TYPES,
  ArtefactType,
  INITIAL_STATUS,
  LIMITS,
  checkLimits,
  ftsQuery,
  formatId,
  idSeq,
  isArtefactType,
  isRelation,
  validateRelation,
  validateTransition,
} from "./core.ts";

export class KnowledgeHub {
  constructor(private state: DurableObjectState) {}

  async ensureSchema() {
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS artefacts (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        body_md TEXT NOT NULL DEFAULT '',
        meta TEXT NOT NULL DEFAULT '{}',
        owner TEXT NOT NULL DEFAULT '',
        created_ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relations (
        src_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        dst_id TEXT NOT NULL,
        created_ts INTEGER NOT NULL,
        PRIMARY KEY (src_id, relation, dst_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        actor TEXT NOT NULL,
        op TEXT NOT NULL,
        artefact_id TEXT,
        detail TEXT NOT NULL DEFAULT '{}'
      );
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
      CREATE TRIGGER IF NOT EXISTS artefacts_au AFTER UPDATE ON artefacts BEGIN
        INSERT INTO artefacts_fts(artefacts_fts, rowid, title, body_md)
          VALUES ('delete', old.rowid, old.title, old.body_md);
        INSERT INTO artefacts_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
      END;
    `);
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureSchema();
    const url = new URL(request.url);
    const op = url.pathname.slice(1);
    let body: any = {};
    if (request.method === "POST") body = await request.json();
    const actor = String(body.actor ?? "mcp");

    try {
      switch (op) {
        case "create": return this.json(await this.create(body, actor));
        case "get": return this.json(await this.get(String(body.id)));
        case "list": return this.json(await this.list(body));
        case "search": return this.json(await this.search(body));
        case "update": return this.json(await this.update(body, actor));
        case "transition": return this.json(await this.transition(body, actor));
        case "link": return this.json(await this.link(body, actor));
        case "relations": return this.json(await this.relations(String(body.id)));
        case "stats": return this.json(await this.stats());
        default: return this.json({ error: `unknown op ${op}` }, 404);
      }
    } catch (e) {
      return this.json({ error: String((e as Error).message ?? e) }, 400);
    }
  }

  // ---------- ops ----------

  private async create(body: any, actor: string) {
    const type = body.type as ArtefactType;
    if (!isArtefactType(type)) throw new Error(`unknown artefact type '${type}' (valid: ${ARTEFACT_TYPES.join(", ")})`);
    const title = String(body.title ?? "");
    const bodyMd = String(body.body_md ?? "");
    const limitErr = checkLimits(title, bodyMd, body.meta);
    if (limitErr) throw new Error(limitErr);

    const seq = (await this.nextSeq(type));
    const id = formatId(type, seq);
    const ts = Date.now();
    const status = INITIAL_STATUS[type];
    this.state.storage.sql.exec(
      `INSERT INTO artefacts (id, type, title, status, body_md, meta, owner, created_ts, updated_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, type, title, status, bodyMd, JSON.stringify(body.meta ?? {}), String(body.owner ?? actor), ts, ts,
    );
    this.audit(actor, "create", id, { type, title });
    return { id, type, status };
  }

  private async get(id: string) {
    const row = this.one(`SELECT * FROM artefacts WHERE id = ?`, id);
    if (!row) throw new Error(`no such artefact: ${id}`);
    return this.shape(row);
  }

  private async list(body: any) {
    const conds: string[] = [], params: any[] = [];
    if (body.type) { conds.push("type = ?"); params.push(String(body.type)); }
    if (body.status) { conds.push("status = ?"); params.push(String(body.status)); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const rows = this.state.storage.sql
      .exec(`SELECT * FROM artefacts ${where} ORDER BY updated_ts DESC LIMIT ?`, ...params, Math.min(Number(body.limit ?? 50), 200))
      .toArray();
    return { artefacts: rows.map((r) => this.shape(r)) };
  }

  private async search(body: any) {
    const q = ftsQuery(String(body.q ?? ""));
    if (!q) return { artefacts: [], note: "empty query" };
    const typeFilter = body.type ? `AND a.type = '${String(body.type).replace(/[^a-z_]/g, "")}'` : "";
    const rows = this.state.storage.sql
      .exec(
        `SELECT a.* FROM artefacts_fts f JOIN artefacts a ON a.rowid = f.rowid
         WHERE artefacts_fts MATCH ? ${typeFilter}
         ORDER BY rank LIMIT ?`,
        q, Math.min(Number(body.limit ?? 20), 100),
      )
      .toArray();
    return { artefacts: rows.map((r) => this.shape(r)) };
  }

  private async update(body: any, actor: string) {
    const id = String(body.id ?? "");
    const row = this.one(`SELECT * FROM artefacts WHERE id = ?`, id);
    if (!row) throw new Error(`no such artefact: ${id}`);
    const title = body.title !== undefined ? String(body.title) : row.title;
    const bodyMd = body.body_md !== undefined ? String(body.body_md) : row.body_md;
    const meta = body.meta !== undefined ? JSON.stringify(body.meta) : row.meta;
    const limitErr = checkLimits(title, bodyMd, JSON.parse(meta));
    if (limitErr) throw new Error(limitErr);
    // update does not touch status — transitions are the only status path
    this.state.storage.sql.exec(
      `UPDATE artefacts SET title = ?, body_md = ?, meta = ?, updated_ts = ? WHERE id = ?`,
      title, bodyMd, meta, Date.now(), id,
    );
    this.audit(actor, "update", id, {});
    return { id };
  }

  private async transition(body: any, actor: string) {
    const id = String(body.id ?? "");
    const to = String(body.to ?? "");
    const row = this.one(`SELECT * FROM artefacts WHERE id = ?`, id);
    if (!row) throw new Error(`no such artefact: ${id}`);
    const verdict = validateTransition(row.type as ArtefactType, row.status, to);
    if (!verdict.ok) throw new Error(verdict.reason);
    const ts = Date.now();
    this.state.storage.sql.exec(
      `UPDATE artefacts SET status = ?, updated_ts = ? WHERE id = ?`, to, ts, id,
    );
    if (to === "superseded" && body.replacement_id) {
      const rep = this.one(`SELECT id, type FROM artefacts WHERE id = ?`, String(body.replacement_id));
      if (rep && rep.type === row.type)
        this.state.storage.sql.exec(
          `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'supersedes', ?, ?)`,
          String(body.replacement_id), id, ts,
        );
    }
    this.audit(actor, "transition", id, { from: row.status, to, note: body.note ?? "" });
    return { id, status: to };
  }

  private async link(body: any, actor: string) {
    const srcId = String(body.src ?? ""), rel = String(body.relation ?? ""), dstId = String(body.dst ?? "");
    if (!isRelation(rel)) throw new Error(`unknown relation '${rel}'`);
    const src = this.one(`SELECT id, type FROM artefacts WHERE id = ?`, srcId);
    const dst = this.one(`SELECT id, type FROM artefacts WHERE id = ?`, dstId);
    if (!src || !dst) throw new Error("both src and dst must exist");
    const verdict = validateRelation(rel, src.type as ArtefactType, dst.type as ArtefactType);
    if (!verdict.ok) throw new Error(verdict.reason);
    const count = this.one(
      `SELECT COUNT(*) AS n FROM relations WHERE src_id = ?`, srcId,
    ) as any;
    if (Number(count.n) >= LIMITS.relationsPerArtefact)
      throw new Error(`artefact ${srcId} already has ${LIMITS.relationsPerArtefact} relations`);
    this.state.storage.sql.exec(
      `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, ?, ?, ?)`,
      srcId, rel, dstId, Date.now(),
    );
    this.audit(actor, "link", srcId, { relation: rel, dst: dstId });
    return { src: srcId, relation: rel, dst: dstId };
  }

  private async relations(id: string) {
    const out = this.state.storage.sql.exec(
      `SELECT relation, dst_id AS artefact_id, 'out' AS dir FROM relations WHERE src_id = ?
       UNION ALL
       SELECT relation, src_id AS artefact_id, 'in' AS dir FROM relations WHERE dst_id = ?`,
      id, id,
    ).toArray();
    return { id, relations: out };
  }

  private async stats() {
    const byType = this.state.storage.sql.exec(
      `SELECT type, status, COUNT(*) AS n FROM artefacts GROUP BY type, status ORDER BY type`,
    ).toArray();
    return { counts: byType };
  }

  // ---------- helpers ----------

  private audit(actor: string, op: string, artefactId: string | null, detail: object) {
    this.state.storage.sql.exec(
      `INSERT INTO events (ts, actor, op, artefact_id, detail) VALUES (?, ?, ?, ?, ?)`,
      Date.now(), actor, op, artefactId, JSON.stringify(detail),
    );
  }

  private async nextSeq(type: ArtefactType): Promise<number> {
    const prefix = type.toUpperCase() + "-";
    const row = this.one(
      `SELECT MAX(CAST(substr(id, ?) AS INTEGER)) AS m FROM artefacts WHERE id LIKE ?`,
      prefix.length + 1, `${prefix}%`,
    ) as any;
    return (Number(row?.m) || 0) + 1;
  }

  private one(query: string, ...params: any[]) {
    return this.state.storage.sql.exec(query, ...params).toArray()[0] ?? null;
  }

  private shape(row: any) {
    return { ...row, meta: JSON.parse(row.meta ?? "{}") };
  }

  private json(obj: unknown, status = 200) {
    return new Response(JSON.stringify(obj), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
}

// re-export for the worker entry's type-free JS import
export { idSeq };
