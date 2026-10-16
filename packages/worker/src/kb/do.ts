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
  issueRef,
  scaffoldBody,
  EMBED_MODEL,
  TRIGRAM_DIM,
  cosine,
  trigramVec,
  embedText,
  hybridMerge,
  composeBootstrap,
  scoreAgent,
  AgentSignals,
  TRANSPORTS,
  ARTEFACT_TYPES,
  ArtefactType,
  DEFAULT_BOARD,
  DEFAULT_WS_SLUG,
  doWs,
  INITIAL_STATUS,
  LIMITS,
  SETTINGS_KEYS,
  ASK_ANSWERED,
  ASK_OPEN,
  checkLimits,
  ftsQuery,
  formatId,
  generateAuthToken,
  hashAuthToken,
  idSeq,
  isArtefactType,
  isRelation,
  isSentiment,
  isValidAskTarget,
  sanitizeTags,
  validateRelation,
  validateTransition,
} from "./core.ts";

export class KnowledgeHub {
  constructor(private state: DurableObjectState, private env: any) {}

  // ---------- realtime (hibernating websockets) ----------

  async handleWs(request: Request) {
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    const since = Number(new URL(request.url).searchParams.get("since") ?? 0);
    const recent = await this.eventsSince(since, 100);
    pair[1].send(JSON.stringify({ type: "kb.events", events: recent.events }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(_ws: WebSocket, message: string) {
    try {
      const m = JSON.parse(message);
      if (m?.type === "ping") _ws.send(JSON.stringify({ type: "pong" }));
    } catch { /* ignore */ }
  }

  webSocketClose() {}

  private broadcastEvent(ev: unknown) {
    const frame = JSON.stringify({ type: "kb.event", event: ev });
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(frame); } catch { /* hibernated client gone */ }
    }
  }

  // Watchdog: silence on in_progress means the agent is gone. Block it as
  // abandoned; the same agent re-claims it by logging progress again.
  async alarm() {
    await this.ensureSchema();
    const s = this.one(`SELECT value FROM settings WHERE key = 'stale_minutes'`);
    const staleMin = s ? Math.max(1, Math.min(120, parseInt(s.value, 10) || 10)) : 10;
    const staleMs = staleMin * 60_000;
    const now = Date.now();
    const rows = this.state.storage.sql.exec(
      `SELECT id, status, owner, meta, status_ts, updated_ts FROM artefacts
       WHERE type = 'task' AND status = 'in_progress'`,
    ).toArray();
    for (const r of rows as any[]) {
      const meta = JSON.parse(r.meta ?? "{}");
      if (meta.awaiting_ask) continue;
      const lastTs = Math.max(
        meta.last_progress?.ts ?? 0, r.status_ts ?? 0, r.updated_ts ?? 0,
      );
      if (now - lastTs <= staleMs) continue;
      const openAsk = this.one(
        `SELECT id FROM asks WHERE status = 'open' AND artefact_id = ?`, r.id,
      );
      if (openAsk) continue;
      await this.transition({
        id: r.id, to: "blocked",
        note: `abandoned — no update for >${staleMin}m; auto-blocked by watchdog`,
        unblock_condition: `log_progress to re-claim and resume (ownership stays with ${r.owner || "unknown"})`,
      }, "system:watchdog");
    }
    await this.state.storage.setAlarm(now + 60_000);
  }

  async eventsSince(since: number, limit: number) {
    // since=0 → the most recent window (newest first, returned oldest-first);
    // since>0 → incremental forward from the cursor.
    const rows = since > 0
      ? this.state.storage.sql.exec(
          `SELECT seq, ts, actor, op, artefact_id, detail FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
          since, limit,
        ).toArray()
      : this.state.storage.sql.exec(
          `SELECT seq, ts, actor, op, artefact_id, detail FROM events WHERE seq > 0 ORDER BY seq DESC LIMIT ?`,
          limit,
        ).toArray().reverse();
    const events = rows.map((e) => ({ ...e, detail: JSON.parse(e.detail ?? "{}") }));
    return { events, last_seq: events.length ? events[events.length - 1].seq : since };
  }

  async board() {
    const tasks = this.state.storage.sql.exec(
      `SELECT id, title, status, owner, tags, meta, body_md, status_ts, created_ts, updated_ts, project FROM artefacts
       WHERE type = 'task' ORDER BY updated_ts DESC LIMIT 200`,
    ).toArray().map((t) => ({ ...t, meta: JSON.parse(t.meta ?? "{}"), tags: t.tags ? JSON.parse(t.tags) : [] }));
    // flat structure, relations only: child tasks carry part_of, parents get a rollup
    const links = this.state.storage.sql.exec(
      `SELECT src_id, dst_id FROM relations WHERE relation = 'child_of'`,
    ).toArray();
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const parentOf = new Map(links.map((l: any) => [l.src_id, l.dst_id]));
    for (const t of tasks) {
      const parent = parentOf.get(t.id);
      if (parent) t.part_of = parent;
      t.children_open = 0;
      t.children_done = 0;
    }
    for (const l of links as any[]) {
      const parent = byId.get(l.dst_id);
      const child = byId.get(l.src_id);
      if (!parent || !child) continue;
      if (child.status === "done" || child.status === "superseded") parent.children_done++;
      else parent.children_open++;
    }
    // readiness projection (bulk): declared state + evidence maps + stacked bars
    const { analysisEv, reviewEv } = this.qualificationEvidence();
    for (const t of tasks) {
      const q = t.meta.qualification ?? {};
      const declared = q.state ?? (t.meta.qualified === true ? "qualified" : undefined);
      const bars: string[] = q.bars ?? [];
      const parent = t.part_of ? byId.get(t.part_of) : null;
      const pq = parent ? (parent.meta.qualification ?? {}) : {};
      const analysisOk = declared === "qualified"
        || analysisEv.has(t.id)
        || (parent && (pq.state === "qualified" || parent.meta.qualified === true || analysisEv.has(parent.id))) === true;
      const unmet = bars.filter((b) => !(/review/.test(b) ? reviewEv : analysisEv).has(t.id));
      t.qualification = { state: declared ?? (analysisOk ? "qualified" : "open"), how: q.how, by: q.by, bars, unmet_bars: unmet, ready: analysisOk && unmet.length === 0 };
    }
    const sessions = this.state.storage.sql.exec(
      `SELECT s.token_id, s.name, s.first_seen_ts, s.last_seen_ts, t.label
       FROM sessions s LEFT JOIN auth_tokens t ON t.id = s.token_id ORDER BY s.last_seen_ts DESC LIMIT 100`,
    ).toArray();
    const progress = this.state.storage.sql.exec(
      `SELECT seq, ts, actor, artefact_id, detail FROM events
       WHERE op = 'progress' ORDER BY seq DESC LIMIT 120`,
    ).toArray().map((e) => ({ ...e, detail: JSON.parse(e.detail ?? "{}") }));
    const series = this.state.storage.sql.exec(
      `SELECT artefact_id, ts, actor, data FROM artefact_versions
       WHERE action = 'progress' ORDER BY seq DESC LIMIT 400`,
    ).toArray().map((v: any) => {
      const d = JSON.parse(v.data ?? "{}");
      return { artefact_id: v.artefact_id, ts: v.ts, actor: v.actor, ...d };
    });
    return { tasks, sessions, progress, series, agents: this.agentScores() };
  }

  /** Behaviour signals per agent over the trailing 7-day window, scored via scoreAgent(). */
  private agentScores(): Array<{ label: string } & AgentSignals & ReturnType<typeof scoreAgent>> {
    const windowTs = Date.now() - 7 * 24 * 60 * 60_000;
    const tokens = this.state.storage.sql.exec(
      `SELECT label, tags FROM auth_tokens WHERE revoked_ts IS NULL`,
    ).toArray() as any[];
    const signals = new Map<string, AgentSignals>();
    const sig = (label: string): AgentSignals => {
      let s = signals.get(label);
      if (!s) {
        s = { progress_count: 0, gauge_count: 0, thin_notes: 0, abandoned: 0, reassigned: 0, asks_received: 0, asks_answered_on_time: 0, artefacts_created: 0 };
        signals.set(label, s);
      }
      return s;
    };
    for (const t of tokens) sig(t.label); // agents with no activity still get a row
    for (const p of this.state.storage.sql.exec(
      `SELECT actor, data FROM artefact_versions WHERE action = 'progress' AND ts >= ?`,
      windowTs,
    ).toArray() as any[]) {
      const s = sig(p.actor);
      const d = JSON.parse(p.data ?? "{}");
      s.progress_count++;
      if (d.completion_pct != null || d.confidence_pct != null || d.risk_pct != null) s.gauge_count++;
      if (String(d.note ?? "").trim().length < 10) s.thin_notes++;
    }
    for (const r of this.state.storage.sql.exec(
      `SELECT a.owner AS owner, COUNT(*) AS n FROM events e JOIN artefacts a ON a.id = e.artefact_id
       WHERE e.op = 'transition' AND e.actor = 'system:watchdog' AND e.ts >= ? GROUP BY a.owner`,
      windowTs,
    ).toArray() as any[]) sig(r.owner || "unknown").abandoned += r.n;
    for (const r of this.state.storage.sql.exec(
      `SELECT detail FROM events WHERE op = 'reassign' AND ts >= ?`, windowTs,
    ).toArray() as any[]) {
      const d = JSON.parse(r.detail ?? "{}");
      sig(d.prev_owner || "unknown").reassigned++;
    }
    for (const r of this.state.storage.sql.exec(
      `SELECT owner, COUNT(*) AS n FROM artefacts
       WHERE created_ts >= ? AND LENGTH(body_md) >= 200 AND owner != '' GROUP BY owner`,
      windowTs,
    ).toArray() as any[]) sig(r.owner).artefacts_created += r.n;
    for (const t of tokens) {
      const s = sig(t.label);
      const tags: string[] = JSON.parse(t.tags ?? "[]");
      const targets = ["any", t.label, ...tags.map((x: string) => `tag:${x}`)];
      const marks = targets.map(() => "?").join(",");
      s.asks_received = this.one(
        `SELECT COUNT(*) AS n FROM asks WHERE status IN ('open','answered') AND from_label != ?
         AND created_ts >= ? AND to_target IN (${marks})`, t.label, windowTs, ...targets,
      )?.n ?? 0;
      s.asks_answered_on_time = this.one(
        `SELECT COUNT(*) AS n FROM asks WHERE status = 'answered' AND answered_by = ? AND answered_ts IS NOT NULL
         AND answered_ts - created_ts <= ${30 * 60_000} AND created_ts >= ?`, t.label, windowTs,
      )?.n ?? 0;
    }
    return [...signals.entries()]
      .filter(([label]) => !/^(system:|web$)/.test(label))
      .map(([label, s]) => ({ label, ...s, ...scoreAgent(s) }))
      .sort((a, b) => b.score - a.score);
  }

  private async getWithRelations(id: string) {
    const a = await this.get(id);
    const rel = await this.relations(id);
    return { ...a, relations: rel.relations };
  }

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
      CREATE TABLE IF NOT EXISTS auth_tokens (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL UNIQUE,
        hash TEXT NOT NULL UNIQUE,
        tags TEXT NOT NULL DEFAULT '[]',
        transport TEXT NOT NULL DEFAULT 'mcp',
        created_ts INTEGER NOT NULL,
        last_seen_ts INTEGER,
        revoked_ts INTEGER
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_id TEXT NOT NULL,
        name TEXT NOT NULL,
        first_seen_ts INTEGER NOT NULL,
        last_seen_ts INTEGER NOT NULL,
        UNIQUE (token_id, name)
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        slug TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        personal INTEGER NOT NULL DEFAULT 0,
        created_ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_members (
        ws TEXT NOT NULL,
        login TEXT NOT NULL,
        UNIQUE (ws, login)
      );
      CREATE TABLE IF NOT EXISTS embeddings (
        artefact_id TEXT PRIMARY KEY,
        vec BLOB NOT NULL,
        dim INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS artefact_versions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        artefact_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        summary TEXT,
        data TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS asks (
        id TEXT PRIMARY KEY,
        from_label TEXT NOT NULL,
        to_target TEXT NOT NULL,
        question TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        answer TEXT,
        answered_by TEXT,
        created_ts INTEGER NOT NULL,
        answered_ts INTEGER
      );
    `);
    // additive columns for DBs created before these existed
    for (const ddl of [
      `ALTER TABLE decisions ADD COLUMN options TEXT`,
      `ALTER TABLE decisions ADD COLUMN urgency TEXT`,
      `ALTER TABLE decisions ADD COLUMN deadline_ts INTEGER`,
      `ALTER TABLE decisions ADD COLUMN asker TEXT`,
      `ALTER TABLE auth_tokens ADD COLUMN transport TEXT`,
      `ALTER TABLE artefacts ADD COLUMN status_ts INTEGER`,
      `ALTER TABLE artefacts ADD COLUMN tags TEXT`,
      `ALTER TABLE embeddings ADD COLUMN dim INTEGER DEFAULT 0`,
      `ALTER TABLE asks ADD COLUMN artefact_id TEXT`,
      `ALTER TABLE artefacts ADD COLUMN project TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE artefacts ADD COLUMN created_by TEXT NOT NULL DEFAULT ''`,
    ]) {
      try { this.state.storage.sql.exec(ddl); } catch { /* column exists */ }
    }
    // work enters as UNCLAIMED todo — release currently-todo tasks from their creators
    const projectName = this.settingsMap().project_name || "superpositional";
    this.state.storage.sql.exec(
      `UPDATE artefacts SET project = ? WHERE project = '' AND type = 'task'`, projectName,
    );
    this.state.storage.sql.exec(`UPDATE artefacts SET owner = '' WHERE type = 'task' AND status = 'todo' AND owner != ''`);
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureSchema();
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + 15_000);
    }
    const url = new URL(request.url);

    // realtime: hibernating WS fanout of audit events
    if (url.pathname === "/ws") return this.handleWs(request);
    // human-plane GET mirror
    if (request.method === "GET") {
      switch (url.pathname) {
        case "/artefacts": return this.json(await this.list({ type: url.searchParams.get("type") ?? undefined, status: url.searchParams.get("status") ?? undefined, limit: url.searchParams.get("limit") ?? undefined }));
        case "/artefact": return this.json(await this.getWithRelations(String(url.searchParams.get("id"))));
        case "/search": return this.json(await this.search({ q: url.searchParams.get("q") ?? "", type: url.searchParams.get("type") ?? undefined, limit: url.searchParams.get("limit") ?? undefined }));
        case "/events": return this.json(await this.eventsSince(Number(url.searchParams.get("since") ?? 0), Math.min(Number(url.searchParams.get("limit") ?? 100), 500)));
        case "/board": return this.json(await this.board());
        case "/stats": return this.json(await this.stats());
        case "/history": return this.json(await this.getHistory(String(url.searchParams.get("id")), Math.min(Number(url.searchParams.get("limit") ?? 100), 200)));
      }
    }

    const op = url.pathname.slice(1);
    let body: any = {};
    if (request.method === "POST") body = await request.json();
    const isAdmin = request.headers.get("x-kb-admin") === "1";
    const actor = String(body.actor ?? "mcp");

    try {
      switch (op) {
        case "create": return this.json(await this.create(body, actor));
        case "get": return this.json(await this.get(String(body.id)));
        case "list": return this.json(await this.list(body));
        case "search": return this.json(await this.search(body));
        case "related": return this.json(await this.related(String(body.id), Number(body.limit ?? 10)));
        case "enrich": return this.json(await this.enrich(body, actor));
        case "update": return this.json(await this.update(body, actor));
        case "transition": return this.json(await this.transition(body, actor));
        case "link": return this.json(await this.link(body, actor));
        case "relations": return this.json(await this.relations(String(body.id)));
        case "stats": return this.json(await this.stats());
        case "get_history": return this.json(await this.getHistory(String(body.id ?? ""), Number(body.limit ?? 100)));
        // ---- machine-plane identity + sessions + asks ----
        case "auth.identify": return this.json(await this.identify(String(body.bearer ?? "")));
        case "agents.list": return this.json(await this.listAgents());
        case "session.touch": return this.json(await this.sessionTouch(body));
        case "ask.create": return this.json(await this.askCreate(body, actor));
        case "ask.inbox": return this.json(await this.askInbox(body));
        case "ask.answer": return this.json(await this.askAnswer(body, actor));
        case "orient": return this.json(await this.orient(body));
        case "progress.log": return this.json(await this.progressLog(body, actor));
        case "settings.public": return this.json({ settings: this.publicSettings() });
        case "bootstrap": {
          const m = this.settingsMap();
          return this.json({
            project_name: m.project_name || "Superpositional",
            instructions: composeBootstrap(m.project_name || "Superpositional", m.board ?? DEFAULT_BOARD),
          });
        }
        // ---- workspace registry (global DO; human plane, owner-checked) ----
        case "ws.seed": return this.json(await this.wsSeed(body.logins ?? []));
        case "ws.list": return this.json(await this.wsList(String(body.login)));
        case "ws.create": return this.json(await this.wsCreate(body, String(body.login)));
        case "ws.join": return this.json(await this.wsJoin(body, String(body.login)));
        case "ws.members": return this.json(await this.wsMembers(body, String(body.login)));
        // ---- admin (human plane only; worker sets x-kb-admin after session auth) ----
        case "admin.mint":
        case "admin.list_tokens":
        case "admin.revoke":
        case "admin.settings_get":
        case "admin.settings_set":
          if (!isAdmin) return this.json({ error: "admin only" }, 403);
          if (op === "admin.mint") return this.json(await this.tokenMint(body));
          if (op === "admin.list_tokens") return this.json(await this.tokenList());
          if (op === "admin.revoke") return this.json(await this.tokenRevoke(body));
          if (op === "admin.settings_get") return this.json(await this.settingsGet());
          return this.json(await this.settingsSet(body));
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
    let bodyMd = String(body.body_md ?? "");
    const limitErr = checkLimits(title, bodyMd, body.meta);
    if (limitErr) throw new Error(limitErr);

    const seq = (await this.nextSeq(type));
    const id = formatId(seq);
    const ts = Date.now();
    const status = INITIAL_STATUS[type];
    const tags = sanitizeTags(body.tags);
    const session = await this.resolveSession(body, String(body.token_id ?? ""));
    // project: explicit override or the deployment's project; tasks enter UNCLAIMED (owner = pool)
    const project = String(body.project ?? "").trim() || this.settingsMap().project_name || "superpositional";
    const owner = type === "task" ? String(body.owner ?? "").trim() : String(body.owner ?? actor);
    // qualifications stack: a publisher may declare self-analyzed readiness AND request
    // further confirmation bars (await: ["role:review"]) before the task goes ready
    const createMeta: any = { ...(body.meta ?? {}) };
    if (type === "task" && (body.qualified === true || (Array.isArray(body.await) && body.await.length))) {
      createMeta.qualification = {
        state: body.qualified === true ? "qualified" : "open",
        how: body.qualified === true ? "self-analyzed" : "open",
        by: actor, ts,
        bars: Array.isArray(body.await) ? body.await.map(String) : [],
      };
    }
    this.state.storage.sql.exec(
      `INSERT INTO artefacts (id, type, title, status, body_md, meta, owner, created_ts, updated_ts, tags, status_ts, project, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, type, title, status, bodyMd, JSON.stringify({ ...createMeta, session }), owner, ts, ts,
      tags ? JSON.stringify(tags) : null, ts, project, actor,
    );
    if (!bodyMd.trim() && (type === "task" || type === "rfc" || type === "goal")) {
      bodyMd = scaffoldBody(title, owner || actor);
    }
    this.audit(actor, "create", id, { type, title });
    this.version(id, actor, "create", title, { type, title, body_md: bodyMd, tags: tags ?? [] });
    await this.embedArtefact(id, title, bodyMd);
    // GitHub auto-enrichment: "#1886" in the title pulls issue body/labels
    if (this.env.GH_TOKEN) {
      const ref = issueRef(title);
      if (ref) { try { await this.enrichFromGitHub(id, ref); } catch { /* GH unavailable — stay bare */ } }
    }
    if (type === "progress") await this.progressHeartbeat(body.meta, title, actor);
    return { id, type, status };
  }

  /** A progress artefact (meta.task → task id) doubles as a heartbeat on that task:
   *  auto-starts todo tasks, re-claims watchdog-abandoned ones, and bumps last_progress.
   *  Agents post updates as progress logs instead of calling log_progress on the task —
   *  without this, the task card never moves. */
  private async progressHeartbeat(metaObj: any, title: string, actor: string) {
    const raw = String(metaObj?.task ?? "").trim();
    if (!raw) return;
    const candidates = [raw, raw.replace(/^#/, "BR#"), `BR#${raw.replace(/^#/, "")}`];
    const t = candidates
      .map((c) => this.one(`SELECT id, status, meta, tags FROM artefacts WHERE id = ? AND type = 'task'`, c))
      .find(Boolean);
    if (!t) return;
    const tmeta = JSON.parse(t.meta ?? "{}");
    const tTags: string[] = t.tags ? JSON.parse(t.tags) : [];
    const isQualifier = tTags.includes("role:analysis") || tTags.includes("role:review");
    if (t.status === "blocked" && (tmeta.blocked?.reason ?? "").startsWith("abandoned")) {
      await this.transition({ id: t.id, to: "in_progress", note: "re-claimed — progress artefact logged" }, actor);
      delete tmeta.blocked;
    } else if (t.status === "todo") {
      // pickup gate applies: only qualified work (or qualifier roles) auto-starts
      const q = isQualifier ? { ok: true } : this.qualifyCheck(t, "analysis");
      if (q.ok) await this.transition({ id: t.id, to: "in_progress", note: "started — progress artefact logged" }, actor);
    }
    tmeta.last_progress = { note: title.slice(0, 200), sentiment: "neutral", actor, ts: Date.now(), session: tmeta.session };
    this.state.storage.sql.exec(
      `UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`,
      JSON.stringify(tmeta), Date.now(), t.id,
    );
    this.version(t.id, actor, "progress", title.slice(0, 500), { note: title.slice(0, 200) });
    this.audit(actor, "progress", t.id, { note: title.slice(0, 200), via: "progress_artefact" });
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
    if (body.tag) { conds.push("tags LIKE ?"); params.push(`%"${String(body.tag).replace(/[^a-z0-9:_-]/g, "")}"%`); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const rows = this.state.storage.sql
      .exec(`SELECT * FROM artefacts ${where} ORDER BY updated_ts DESC LIMIT ?`, ...params, Math.min(Number(body.limit ?? 50), 200))
      .toArray();
    return { artefacts: rows.map((r) => this.shape(r)) };
  }

  /** Hybrid: FTS5 keyword + embedding cosine, merged. Falls back to FTS-only when AI is unavailable. */
  private async search(body: any) {
    const rawQ = String(body.q ?? "");
    const limit = Math.min(Number(body.limit ?? 20), 100);
    const q = ftsQuery(rawQ);
    if (!q) return { artefacts: [], note: "empty query" };
    const typeFilter = body.type ? `AND a.type = '${String(body.type).replace(/[^a-z_]/g, "")}'` : "";

    const ftsRows = this.state.storage.sql
      .exec(
        `SELECT a.id FROM artefacts_fts f JOIN artefacts a ON a.rowid = f.rowid
         WHERE artefacts_fts MATCH ? ${typeFilter} ORDER BY rank LIMIT ?`,
        q, limit,
      )
      .toArray()
      .map((r: any, i: number) => ({ id: r.id, score: 1 / (1 + i) }));

    let vecRows: Array<{ id: string; score: number }> = [];
    let qvec: Float32Array | null = null;
    let qdim = 0;
    try {
      if (this.env?.AI) {
        const out: any = await this.env.AI.run(EMBED_MODEL, { text: [embedText(rawQ, "")] });
        if (Array.isArray(out?.data?.[0])) { qvec = Float32Array.from(out.data[0]); qdim = qvec.length; }
      }
    } catch { /* AI unavailable */ }
    if (!qvec) { qvec = Float32Array.from(trigramVec(embedText(rawQ, ""), TRIGRAM_DIM)); qdim = TRIGRAM_DIM; }
    {
      const rows = this.state.storage.sql.exec(`SELECT artefact_id, vec FROM embeddings WHERE dim = ?`, qdim).toArray();
      const scored = rows.map((r: any) => {
        const v = new Float32Array(r.vec.buffer ?? r.vec);
        return { id: r.artefact_id, score: cosine(qvec as Float32Array, v) };
      }).filter((r) => r.score > 0.3);
      scored.sort((a, b) => b.score - a.score);
      vecRows = scored.slice(0, limit);
    }

    const merged = hybridMerge(ftsRows, vecRows, limit);
    if (merged.length === 0) return { artefacts: [], note: "no matches (keyword + semantic)" };
    const ids = merged.map((m) => m.id);
    const marks = ids.map(() => "?").join(",");
    const rows = this.state.storage.sql.exec(
      `SELECT * FROM artefacts WHERE id IN (${marks})`, ...ids,
    ).toArray().map((r: any) => this.shape(r));
    const byId = new Map(rows.map((r: any) => [r.id, r]));
    const scored = merged
      .map((m) => {
        const r: any = byId.get(m.id);
        return r ? { ...r, _score: m.score, _via: m.via } : null;
      })
      .filter((r): r is any => !!r);
    return { artefacts: scored, hybrid: { keyword: ftsRows.length, semantic: vecRows.length } };
  }

  /** "What relates to X?" — nearest artefacts by embedding. */
  private async related(id: string, limit: number) {
    const row = this.one(`SELECT vec, dim FROM embeddings WHERE artefact_id = ?`, id);
    if (!row) return { artefacts: [], note: "no embedding for artefact" };
    const qvec = new Float32Array(row.vec.buffer ?? row.vec);
    const rows = this.state.storage.sql.exec(`SELECT artefact_id, vec FROM embeddings WHERE artefact_id != ? AND dim = ?`, id, row.dim).toArray();
    const scored = rows.map((r: any) => {
      const v = new Float32Array(r.vec.buffer ?? r.vec);
      return { id: r.artefact_id, score: cosine(qvec, v) };
    }).filter((r) => r.score > 0.3);
    scored.sort((a, b) => b.score - a.score);
    const ids = scored.slice(0, limit).map((r) => r.id);
    if (ids.length === 0) return { artefacts: [] };
    const marks = ids.map(() => "?").join(",");
    const arts = this.state.storage.sql.exec(`SELECT * FROM artefacts WHERE id IN (${marks})`, ...ids).toArray().map((r: any) => this.shape(r));
    const byId = new Map(arts.map((a: any) => [a.id, a]));
    return { artefacts: ids.map((i) => byId.get(i)).filter((a): a is any => !!a) };
  }

  /**
   * Embed title-weighted text; store as float32 BLOB with the vector dim.
   * Two spaces: Workers AI (prod, 768d) when bound; local hashed-trigram (256d) fallback.
   * Best-effort — never fails the write.
   */
  private async embedArtefact(id: string, title: string, body: string) {
    let vec: number[] | null = null;
    let dim = 0;
    try {
      if (this.env?.AI) {
        const out: any = await this.env.AI.run(EMBED_MODEL, { text: [embedText(title, body)] });
        if (Array.isArray(out?.data?.[0])) { vec = out.data[0]; dim = vec.length; }
      }
    } catch { /* AI unavailable */ }
    if (!vec) {
      vec = trigramVec(embedText(title, body), TRIGRAM_DIM);
      dim = TRIGRAM_DIM;
    }
    const f32 = Float32Array.from(vec);
    this.state.storage.sql.exec(
      `INSERT INTO embeddings (artefact_id, vec, dim) VALUES (?, ?, ?)
       ON CONFLICT(artefact_id) DO UPDATE SET vec = excluded.vec, dim = excluded.dim`,
      id, new Uint8Array(f32.buffer), dim,
    );
  }

  private async update(body: any, actor: string) {
    const id = String(body.id ?? "");
    const row = this.one(`SELECT * FROM artefacts WHERE id = ?`, id);
    if (!row) throw new Error(`no such artefact: ${id}`);
    // any mutation is a heartbeat: abandoned tasks re-claim on first contact
    const preMeta = JSON.parse(row.meta ?? "{}");
    const reclaimed =
      row.status === "blocked" && (preMeta.blocked?.reason ?? "").startsWith("abandoned");
    if (reclaimed) {
      await this.transition({ id, to: "in_progress", note: "re-claimed — agent resumed (heartbeat)" }, actor);
    }
    const title = body.title !== undefined ? String(body.title) : row.title;
    const bodyMd = body.body_md !== undefined ? String(body.body_md) : row.body_md;
    // row.meta predates the re-claim transition — strip the stale blocked record so we don't resurrect it
    const metaObj = body.meta !== undefined ? JSON.parse(JSON.stringify(body.meta)) : JSON.parse(row.meta ?? "{}");
    if (reclaimed) delete metaObj.blocked;
    const meta = JSON.stringify(metaObj);
    if (row.type === "progress") await this.progressHeartbeat(metaObj, title, actor);
    const tags = body.tags !== undefined ? sanitizeTags(body.tags) : row.tags;
    const limitErr = checkLimits(title, bodyMd, JSON.parse(meta));
    if (limitErr) throw new Error(limitErr);
    // update does not touch status — transitions are the only status path
    this.state.storage.sql.exec(
      `UPDATE artefacts SET title = ?, body_md = ?, meta = ?, tags = ?, updated_ts = ? WHERE id = ?`,
      title, bodyMd, meta, tags ? JSON.stringify(tags) : null, Date.now(), id,
    );
    this.audit(actor, "update", id, {});
    const changed = [
      body.title !== undefined && "title", body.body_md !== undefined && "body",
      body.meta !== undefined && "meta", body.tags !== undefined && "tags",
    ].filter(Boolean);
    this.version(id, actor, "update", `updated ${changed.join(", ") || "fields"}`, { title, body_md: bodyMd });
    await this.embedArtefact(id, title, bodyMd);
    return { id };
  }

  /** Pure evidence for a qualification kind: a done analysis/review child, or an accepted
   *  decision linked either way. Declarations (meta.qualified / meta.qualification) don't count. */
  private hasEvidence(row: any, kind: "analysis" | "review"): { ok: boolean; via?: string } {
    const roleFilter = kind === "analysis"
      ? `(c.tags LIKE '%"role:analysis"%' OR c.tags LIKE '%"role:review"%')`
      : `c.tags LIKE '%"role:review"%'`;
    const child = this.one(
      `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status = 'done' AND ${roleFilter} LIMIT 1`,
      row.id,
    );
    if (child) return { ok: true, via: child.id };
    const dec = this.one(
      `SELECT d.id AS id FROM relations r JOIN artefacts d ON d.id = r.src_id
       WHERE r.relation = 'supports' AND r.dst_id = ? AND d.type = 'decision' AND d.status = 'accepted' LIMIT 1`,
      row.id,
    );
    if (dec) return { ok: true, via: dec.id };
    return { ok: false };
  }

  /** Swimlane qualification: declared (self-analyzed at intake / preset), pure evidence,
   *  or inherited from the parent's decomposition (the pass that qualified the parent
   *  covered its children). */
  private qualifyCheck(row: any, kind: "analysis" | "review"): { ok: boolean; via?: string } {
    const meta = JSON.parse(row.meta ?? "{}");
    const q = meta.qualification ?? {};
    if (kind === "analysis" && (meta.qualified === true || q.state === "qualified")) return { ok: true, via: "declared" };
    const ev = this.hasEvidence(row, kind);
    if (ev.ok) return ev;
    const parent = this.one(
      `SELECT p.id AS id, p.meta AS meta FROM relations r JOIN artefacts p ON p.id = r.dst_id
       WHERE r.relation = 'child_of' AND r.src_id = ? LIMIT 1`,
      row.id,
    );
    if (parent) {
      const pm = JSON.parse(parent.meta ?? "{}");
      if (kind === "analysis" && (pm.qualified === true || (pm.qualification ?? {}).state === "qualified"))
        return { ok: true, via: `parent:${parent.id}` };
      const sib = this.one(
        `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
         WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status = 'done' AND ${kind === "analysis"
           ? `(c.tags LIKE '%"role:analysis"%' OR c.tags LIKE '%"role:review"%')`
           : `c.tags LIKE '%"role:review"%'`} LIMIT 1`,
        parent.id,
      );
      if (sib) return { ok: true, via: `sibling:${sib.id}` };
    }
    return { ok: false };
  }

  /** Requested-but-unmet qualification bars (qualifications stack: a publisher may
   *  self-qualify AND ask for further confirmation before the task goes ready). */
  private unmetBars(row: any): string[] {
    const meta = JSON.parse(row.meta ?? "{}");
    const bars: string[] = (meta.qualification ?? {}).bars ?? [];
    return bars.filter((b) => !this.hasEvidence(row, /review/.test(b) ? "review" : "analysis").ok);
  }

  /** Bulk evidence for readiness projections: done role-tagged children per parent +
   *  accepted decisions per task. Review evidence also satisfies the analysis kind. */
  private qualificationEvidence(): { analysisEv: Set<string>; reviewEv: Set<string> } {
    const analysisEv = new Set<string>(), reviewEv = new Set<string>();
    for (const k of this.state.storage.sql.exec(
      `SELECT r.dst_id AS pid, c.tags AS tags FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND c.status = 'done'`,
    ).toArray() as any[]) {
      const tags: string[] = k.tags ? JSON.parse(k.tags) : [];
      if (tags.includes("role:review")) { reviewEv.add(k.pid); analysisEv.add(k.pid); }
      else if (tags.includes("role:analysis")) analysisEv.add(k.pid);
    }
    for (const d of this.state.storage.sql.exec(
      `SELECT r.dst_id AS tid FROM relations r JOIN artefacts d ON d.id = r.src_id
       WHERE r.relation = 'supports' AND d.type = 'decision' AND d.status = 'accepted'`,
    ).toArray() as any[]) { analysisEv.add(d.tid); reviewEv.add(d.tid); }
    return { analysisEv, reviewEv };
  }

  /** Agent roles for an actor label (empty for humans "web" and system actors). */
  private actorTagsFor(label: string): string[] {
    if (!label || /^(web|system:)/.test(label)) return [];
    const row = this.one(`SELECT tags FROM auth_tokens WHERE label = ?`, label);
    try { return JSON.parse(row?.tags ?? "[]"); } catch { return []; }
  }

  private async transition(body: any, actor: string) {
    const id = String(body.id ?? "");
    const to = String(body.to ?? "");
    const row = this.one(`SELECT * FROM artefacts WHERE id = ?`, id);
    if (!row) throw new Error(`no such artefact: ${id}`);
    const verdict = validateTransition(row.type as ArtefactType, row.status, to);
    if (!verdict.ok) throw new Error(verdict.reason);
    // ---- swimlane gates: minimal, enforced state-machine barriers ----
    const tTags: string[] = row.tags ? JSON.parse(row.tags) : [];
    const isQualifier = tTags.includes("role:analysis") || tTags.includes("role:review");
    if (row.type === "task" && row.status === "todo" && to === "in_progress" && !isQualifier) {
      const aTags = this.actorTagsFor(actor);
      const actorIsQualifier = aTags.includes("role:analysis") || aTags.includes("role:review");
      const needRoles = tTags.filter((x) => x.startsWith("role:"));
      if (needRoles.length && actor !== "web" && !needRoles.some((r) => aTags.includes(r)))
        throw new Error(`task ${id} is gated to ${needRoles.join(", ")} — your agent roles (${aTags.map((r) => r.replace("role:", "")).join(", ") || "none"}) don't match; agents only see and claim work matching their roles`);
      if (!actorIsQualifier) {
        const q = this.qualifyCheck(row, "analysis");
        if (!q.ok)
          throw new Error(`task ${id} is not qualified — work cannot be picked up until analysed/reviewed. Qualify it by completing a role:analysis child task, linking an accepted decision, or declaring it at create (qualified: true). (role:analysis / role:review agents may pick up unqualified work — that is their job.)`);
        const bars = this.unmetBars(row);
        if (bars.length)
          throw new Error(`task ${id} is qualified but its publisher requested further confirmation before it goes ready — unmet bars: ${bars.join(", ")}. Satisfy them with a done child task of that role or an accepted decision.`);
      }
    }
    if (row.type === "task" && to === "done" && !isQualifier) {
      const r = this.qualifyCheck(row, "review");
      if (!r.ok)
        throw new Error(`task ${id} cannot be completed unreviewed — complete a role:review child task or link an accepted decision (e.g. a Superpositional verdict) first`);
    }
    if (row.status === "blocked" && to === "in_progress") {
      const resolution = String(body.note ?? body.resolution ?? "").trim();
      if (!resolution)
        throw new Error(`moving out of blocked requires a resolution (note) — the card promised an unblock condition; cite how it resolved`);
    }
    // handoff gate: "ready for review" must carry the PR — reviewers need something to review
    if (row.type === "task" && to === "in_review") {
      const note = String(body.note ?? "").trim();
      if (!/https?:\/\/\S+|(^|\s)PR[\s#:]/i.test(note))
        throw new Error(`moving to in_review requires the PR link in the note (you stay owner until the verdict — done requires review acceptance, not your call)`);
    }
    // bounce back from review: the reviewer's findings ARE the resolution
    if (row.status === "in_review" && to === "in_progress") {
      const findings = String(body.note ?? body.resolution ?? "").trim();
      if (!findings)
        throw new Error(`bouncing back from review requires the reviewer's findings (note) — "no" without reasons is not an answer`);
    }
    if (to === "blocked") {
      const reason = String(body.note ?? body.reason ?? "").trim();
      const unblock = String(body.unblock_condition ?? "").trim();
      if (!reason || !unblock)
        throw new Error("moving to blocked requires BOTH a reason (note) and an unblock condition — a blocked card without an unblock path is a dead end");
    }
    const sentiment = isSentiment(body.sentiment) ? body.sentiment : undefined;
    const ts = Date.now();
    const meta = JSON.parse(row.meta ?? "{}");
    if (to === "blocked") {
      meta.blocked = { reason: String(body.note ?? body.reason ?? "").trim(), unblock_condition: String(body.unblock_condition ?? "").trim(), ts };
    } else if (meta.blocked) {
      delete meta.blocked; // unblocking clears the dead-end record
    }
    // claim semantics: in_progress on a task claims it for the actor (system actors don't steal claims)
    let owner = row.owner;
    // claim only on fresh pickup or abandoned re-claim — a review bounce returns to the AUTHOR
    const bounceFromReview = row.status === "in_review";
    if (row.type === "task" && to === "in_progress" && !bounceFromReview && !/^system:/.test(actor) && owner !== actor) {
      owner = actor;
    }
    // a parent isn't completable while children are open
    if (row.type === "task" && to === "done") {
      const open = this.one(
        `SELECT COUNT(*) AS n FROM relations r JOIN artefacts c ON c.id = r.src_id
         WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status NOT IN ('done', 'superseded')`,
        id,
      )?.n ?? 0;
      if (open > 0) throw new Error(`parent ${id} still has ${open} open child task(s) — finish or close them first (decomposition owns its children)`);
    }
    this.state.storage.sql.exec(
      `UPDATE artefacts SET status = ?, status_ts = ?, meta = ?, updated_ts = ?, owner = ? WHERE id = ?`, to, ts, JSON.stringify(meta), ts, owner, id,
    );
    if (to === "superseded" && body.replacement_id) {
      const rep = this.one(`SELECT id, type FROM artefacts WHERE id = ?`, String(body.replacement_id));
      if (rep && rep.type === row.type)
        this.state.storage.sql.exec(
          `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'supersedes', ?, ?)`,
          String(body.replacement_id), id, ts,
        );
    }
    this.audit(actor, "transition", id, { from: row.status, to, note: body.note ?? "", sentiment });
    this.version(id, actor, "transition", `${row.status} → ${to}${body.note ? ` — ${String(body.note).slice(0, 120)}` : ""}`, { from: row.status, to, note: body.note ?? "" });
    return { id, status: to, ...(sentiment ? { sentiment } : {}) };
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

  /**
   * Fine-grained progress from a working agent: note + sentiment, shown live on the board.
   * Optional self-reported gauge fields: completion_pct, confidence_pct, risk_pct (0–100).
   * completion = how far along; confidence = belief the result is right; risk = chance of
   * failure/drift. Correlated, not the same — charted as separate series.
   */
  private async progressLog(body: any, actor: string) {
    const id = String(body.id ?? "");
    const note = String(body.note ?? "").trim().slice(0, 500);
    const sentiment = isSentiment(body.sentiment) ? body.sentiment : "neutral";
    const pct = (v: any) => (Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : undefined);
    const completion_pct = pct(body.completion_pct);
    const confidence_pct = pct(body.confidence_pct);
    const risk_pct = pct(body.risk_pct);
    const row = this.one(`SELECT id, status, meta, tags FROM artefacts WHERE id = ?`, id);
    if (!row) throw new Error(`no such artefact: ${id}`);
    const meta = JSON.parse(row.meta ?? "{}");
    const m = this.settingsMap();
    const myScore = this.agentScores().find((a) => a.label === actor);
    const scoreLine = myScore
      ? `\n\nYour behaviour score: ${myScore.score}/100 (${myScore.grade}).` + (myScore.hints.length ? ` ${myScore.hints.join(" ")}` : "")
      : "";
    const instructions = composeBootstrap(m.project_name || "Superpositional", m.board ?? DEFAULT_BOARD) + (m.bootstrap_md ? `\n${m.bootstrap_md}` : "") + scoreLine;
    // Re-claim: logging progress on a watchdog-abandoned task flips it back to
    // in_progress (the unblock condition the watchdog promised). Legitimately
    // blocked tasks (human reasons) keep their status until explicitly resumed.
    if (row.status === "blocked" && (meta.blocked?.reason ?? "").startsWith("abandoned")) {
      await this.transition({ id, to: "in_progress", note: "re-claimed — agent resumed (heartbeat)" }, actor);
      delete meta.blocked; // transition cleared it in DB — don't resurrect it here
    } else if (row.status === "todo") {
      // progress on an unclaimed task = intent to work it. Claim if allowed;
      // otherwise say WHY instead of silently logging into a card that never moves.
      const tTags: string[] = JSON.parse(row.tags ?? "[]");
      const isQualifier = tTags.includes("role:analysis") || tTags.includes("role:review");
      const q = isQualifier ? { ok: true } : this.qualifyCheck(row, "analysis");
      if (!q.ok) {
        return {
          id, note, sentiment, completion_pct, confidence_pct, risk_pct, instructions,
          note_postscript: `PROGRESS LOGGED BUT TASK NOT CLAIMED — ${id} is unclaimed todo and not qualified for you (label ${actor}). transition {to: "in_progress"} will be rejected until it is qualified: complete a role:analysis child task, link an accepted decision, or pick qualified work. role:analysis/role:review agents may claim unqualified work.`,
        };
      }
      await this.transition({ id, to: "in_progress", note: "started — progress logged" }, actor);
    }
    meta.last_progress = { note, sentiment, actor, ts: Date.now(), session: body.session ?? meta.session, completion_pct, confidence_pct, risk_pct };
    if (body.session && !meta.session) meta.session = body.session;
    this.state.storage.sql.exec(
      `UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`,
      JSON.stringify(meta), Date.now(), id,
    );
    this.audit(actor, "progress", id, { note, sentiment });
    this.version(id, actor, "progress", note, { note, sentiment, completion_pct, confidence_pct, risk_pct });
    return {
      id, note, sentiment, completion_pct, confidence_pct, risk_pct, instructions,
    };
  }

  /** Append-only history: every mutation of every artefact gets a version row. */
  private version(artefactId: string, actor: string, action: string, summary: string, data: object = {}) {
    const ts = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO artefact_versions (artefact_id, ts, actor, action, summary, data) VALUES (?, ?, ?, ?, ?, ?)`,
      artefactId, ts, actor, action, summary.slice(0, 500), JSON.stringify(data),
    );
  }

  private async getHistory(artefactId: string, limit = 100) {
    const rows = this.state.storage.sql.exec(
      `SELECT seq, ts, actor, action, summary, data FROM artefact_versions
       WHERE artefact_id = ? ORDER BY seq DESC LIMIT ?`,
      artefactId, Math.min(limit, 200),
    ).toArray().map((r: any) => ({ ...r, data: JSON.parse(r.data ?? "{}") }));
    return { artefact_id: artefactId, versions: rows };
  }

  // ---------- identity, sessions, asks, settings, orient ----------

  /** Resolve a bearer secret to an agent identity; touches last_seen. */
  private async identify(bearer: string) {
    if (!bearer) throw new Error("missing bearer");
    const hash = await hashAuthToken(bearer);
    let row = this.one(`SELECT id, label, tags, revoked_ts FROM auth_tokens WHERE hash = ?`, hash);
    if (!row) {
      // absorb dev-mode write-visibility hiccups right after mint
      await new Promise((r) => setTimeout(r, 250));
      row = this.one(`SELECT id, label, tags, revoked_ts FROM auth_tokens WHERE hash = ?`, hash);
    }
    if (!row) throw new Error("unknown auth token");
    if (row.revoked_ts) throw new Error("auth token revoked");
    this.state.storage.sql.exec(`UPDATE auth_tokens SET last_seen_ts = ? WHERE id = ?`, Date.now(), row.id);
    return { token_id: row.id, label: row.label, tags: JSON.parse(row.tags ?? "[]") };
  }

  /** Active agents (for ask addressing). Labels + capability tags only. */
  private async listAgents() {
    const cutoff = Date.now() - 10 * 60_000;
    const agents = this.state.storage.sql.exec(
      `SELECT label, tags, transport, last_seen_ts, revoked_ts FROM auth_tokens ORDER BY last_seen_ts DESC LIMIT 100`,
    ).toArray()
      .filter((a) => !a.revoked_ts)
      .map((a) => ({
        label: a.label,
        tags: JSON.parse(a.tags ?? "[]"),
        transport: a.transport ?? "mcp",
        online: a.last_seen_ts >= cutoff,
        last_seen_ts: a.last_seen_ts,
      }));
    return { agents, note: "bridge routes between agents — transport shows how each is reachable today (mcp) or next (a2a, acp-proxy, board)" };
  }

  /** The session a write belongs to: explicit, else the token's most recent session. */
  private async resolveSession(body: any, tokenId: string): Promise<string | undefined> {
    if (body.session) {
      await this.sessionTouch({ token_id: tokenId, session: body.session }).catch(() => {});
      return String(body.session);
    }
    const row = this.one(
      `SELECT name FROM sessions WHERE token_id = ? ORDER BY last_seen_ts DESC LIMIT 1`, tokenId,
    ) as any;
    return row?.name ?? undefined;
  }

  /** Register/refresh a session. Names are unique per auth token. */
  private async sessionTouch(body: any) {
    const token_id = String(body.token_id ?? "");
    const name = String(body.session ?? "").trim().slice(0, 80) || `session-${Math.random().toString(36).slice(2, 6)}`;
    const ts = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO sessions (token_id, name, first_seen_ts, last_seen_ts) VALUES (?, ?, ?, ?)
       ON CONFLICT(token_id, name) DO UPDATE SET last_seen_ts = excluded.last_seen_ts`,
      token_id, name, ts, ts,
    );
    return { session: name };
  }

  private async askCreate(body: any, actor: string) {
    const to = String(body.to ?? "any");
    const question = String(body.question ?? "").trim();
    if (!question) throw new Error("question is required");
    if (question.length > 2000) throw new Error("question exceeds 2000 chars");
    if (!isValidAskTarget(to)) throw new Error(`invalid ask target '${to}'`);
    const artefactId = body.artefact_id ? String(body.artefact_id).trim() : "";
    const options = Array.isArray(body.options) ? body.options.map((o: any) => String(o).slice(0, 200)).filter(Boolean).slice(0, 8) : [];
    const urgency = isSentiment(body.urgency) ? String(body.urgency) : "normal";
    const id = `ASK-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    let taskStatus: string | undefined;
    if (artefactId) {
      const row = this.one(`SELECT type, status, meta FROM artefacts WHERE id = ?`, artefactId);
      if (!row) throw new Error(`no such artefact: ${artefactId}`);
      if (row.type === "task" && (row.status === "in_progress" || row.status === "blocked")) {
        const meta = JSON.parse(row.meta ?? "{}");
        meta.awaiting_ask = { ask_id: id, ts: Date.now() };
        this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), artefactId);
        if (row.status === "in_progress") {
          await this.transition({
            id: artefactId, to: "blocked",
            note: `blocked on decision — ${id}: ${question.slice(0, 120)}`,
            unblock_condition: `answer to ask ${id}`,
          }, actor);
          taskStatus = "blocked";
        } else {
          taskStatus = "blocked";
        }
      }
    }
    this.state.storage.sql.exec(
      `INSERT INTO asks (id, from_label, to_target, question, status, created_ts, artefact_id) VALUES (?, ?, ?, ?, 'open', ?, ?)`,
      id, actor, to, question, Date.now(), artefactId || null,
    );
    this.audit(actor, "ask", artefactId || null, { to, question, options, urgency, ask_id: id });
    return { id, to, question, artefact_id: artefactId || undefined, options, urgency, task_status: taskStatus };
  }

  private async askInbox(body: any) {
    const label = String(body.label ?? "");
    const tags: string[] = Array.isArray(body.tags) ? body.tags.map(String) : [];
    const placeholders = ["any", label, ...tags.map((t) => `tag:${t}`)];
    const marks = placeholders.map(() => "?").join(",");
    const open = this.state.storage.sql.exec(
      `SELECT id, from_label, to_target, question, created_ts FROM asks
       WHERE status = 'open' AND from_label != ? AND to_target IN (${marks})
       ORDER BY created_ts DESC LIMIT 50`,
      label, ...placeholders,
    ).toArray();
    const sent = this.state.storage.sql.exec(
      `SELECT id, to_target, question, status, answer, answered_by, created_ts FROM asks
       WHERE from_label = ? ORDER BY created_ts DESC LIMIT 50`,
      label,
    ).toArray();
    return { inbox: open, sent };
  }

  private async askAnswer(body: any, actor: string) {
    const id = String(body.id ?? "");
    const answer = String(body.answer ?? "").trim();
    if (!answer) throw new Error("answer is required");
    const row = this.one(`SELECT status, artefact_id FROM asks WHERE id = ?`, id);
    if (!row) throw new Error(`no such ask: ${id}`);
    if (row.status !== ASK_OPEN) throw new Error(`ask ${id} already ${row.status}`);
    this.state.storage.sql.exec(
      `UPDATE asks SET status = 'answered', answer = ?, answered_by = ?, answered_ts = ? WHERE id = ?`,
      answer.slice(0, 4000), actor, Date.now(), id,
    );
    let taskStatus: string | undefined;
    if (row.artefact_id) {
      const t = this.one(`SELECT status, meta FROM artefacts WHERE id = ?`, String(row.artefact_id));
      if (t) {
        const meta = JSON.parse(t.meta ?? "{}");
        if (meta.awaiting_ask?.ask_id === id) {
          delete meta.awaiting_ask;
          this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), String(row.artefact_id));
        }
        if (t.status === "blocked") {
          await this.transition({
            id: String(row.artefact_id), to: "in_progress",
            note: `decision ${id} answered — resumed: ${answer.slice(0, 100)}`,
          }, `system:decision(${actor})`);
          taskStatus = "in_progress";
        }
      }
    }
    this.audit(actor, "answer", row.artefact_id ?? null, { ask_id: id, answer: answer.slice(0, 200) });
    return { id, status: ASK_ANSWERED, artefact_id: row.artefact_id ?? undefined, task_status: taskStatus };
  }

  private async orient(body: any) {
    const label = String(body.label ?? "");
    const tags: string[] = Array.isArray(body.tags) ? body.tags.map(String) : [];
    const counts = this.state.storage.sql.exec(
      `SELECT type, status, COUNT(*) AS n FROM artefacts GROUP BY type, status ORDER BY type`,
    ).toArray();
    const openStatuses = ["draft", "proposed", "active", "open", "todo", "in_progress", "blocked"];
    const marks = openStatuses.map(() => "?").join(",");
    const open = this.state.storage.sql.exec(
      `SELECT id, type, title, status, owner, updated_ts FROM artefacts
       WHERE status IN (${marks}) ORDER BY updated_ts DESC LIMIT 30`,
      ...openStatuses,
    ).toArray();
    const askPlaceholders = ["any", label, ...tags.map((t) => `tag:${t}`)];
    const askMarks = askPlaceholders.map(() => "?").join(",");
    const pendingAsks = this.state.storage.sql.exec(
      `SELECT id, from_label, to_target, question, created_ts FROM asks
       WHERE status = 'open' AND from_label != ? AND to_target IN (${askMarks})
       ORDER BY created_ts DESC LIMIT 10`,
      label, ...askPlaceholders,
    ).toArray();
    const settings = this.settingsMap();
    const projectName = settings.project_name || "Superpositional";
    const myTasks = this.state.storage.sql.exec(
      `SELECT id, title, status FROM artefacts WHERE type = 'task' AND owner = ? AND status IN ('todo','in_progress','blocked') ORDER BY updated_ts DESC LIMIT 10`,
      label,
    ).toArray();
    // dispatch surface: unclaimed todo tasks this agent's roles may pick up.
    // Work that can't be claimed by this agent is INVISIBLE — no temptation, no noise.
    const myRoles = new Set(tags.filter((t) => t.startsWith("role:")));
    const isQualifierAgent = tags.includes("role:analysis") || tags.includes("role:review");
    const pool = this.state.storage.sql.exec(
      `SELECT id, title, tags, meta, project, updated_ts FROM artefacts
       WHERE type = 'task' AND status = 'todo' AND owner = '' ORDER BY updated_ts DESC LIMIT 30`,
    ).toArray().map((t: any) => ({ ...t, tags: t.tags ? JSON.parse(t.tags) : [] }));
    const { analysisEv, reviewEv } = this.qualificationEvidence();
    const qualIds = new Set(
      (this.state.storage.sql.exec(
        `SELECT id FROM artefacts WHERE type = 'task'
         AND (json_extract(meta, '$.qualification.state') = 'qualified' OR json_extract(meta, '$.qualified') = 1)`,
      ).toArray() as any[]).map((r) => r.id),
    );
    const parentQualified = new Set<string>();
    for (const l of this.state.storage.sql.exec(
      `SELECT src_id, dst_id FROM relations WHERE relation = 'child_of'`,
    ).toArray() as any[]) {
      if (qualIds.has(l.dst_id) || analysisEv.has(l.dst_id)) parentQualified.add(l.src_id);
    }
    const unclaimedWork = pool.filter((t: any) => {
      const need = t.tags.filter((x: string) => x.startsWith("role:"));
      if (need.length && !need.some((r: string) => myRoles.has(r))) return false;
      const m = JSON.parse(t.meta ?? "{}");
      const declared = m.qualification?.state ?? (m.qualified === true ? "qualified" : undefined);
      if (declared !== "qualified" && !analysisEv.has(t.id) && !parentQualified.has(t.id)) return isQualifierAgent;
      const bars: string[] = m.qualification?.bars ?? [];
      const unmet = bars.filter((b) => !(/review/.test(b) ? reviewEv : analysisEv).has(t.id));
      if (unmet.length) return isQualifierAgent;
      return true;
    }).slice(0, 10);
    // role playbooks (settings.roles.{analysis,impl,...}) composed for this agent's tags
    const rolesSettings = typeof settings.roles === "object" && settings.roles ? settings.roles : {};
    const playbooks = tags
      .filter((t) => t.startsWith("role:"))
      .map((t) => ({ role: t.slice(5), playbook: rolesSettings[t.slice(5)] }))
      .filter((p) => typeof p.playbook === "string" && p.playbook.trim());
    // reaper: sort out my abandoned work at check-in (see reapAbandoned)
    const staleMinS = this.one(`SELECT value FROM settings WHERE key = 'stale_minutes'`);
    const staleMin = staleMinS ? Math.max(1, Math.min(120, parseInt(staleMinS.value, 10) || 10)) : 10;
    const actionRequired = this.reapAbandoned(label, staleMin);
    const my_score = this.agentScores().find((a) => a.label === label)
      ?? { label, ...scoreAgent({ progress_count: 0, gauge_count: 0, thin_notes: 0, abandoned: 0, reassigned: 0, asks_received: 0, asks_answered_on_time: 0, artefacts_created: 0 }) };
    return {
      project: projectName,
      instructions: composeBootstrap(projectName, settings.board ?? DEFAULT_BOARD)
        + (settings.bootstrap_md ? `\n${settings.bootstrap_md}` : "")
        + playbooks.map((p) => `\n\nYOUR ROLE: ${p.role}\n${p.playbook}`).join(""),
      board: settings.board ?? DEFAULT_BOARD,
      counts,
      open_artefacts: open,
      my_tasks: myTasks,
      unclaimed_work: unclaimedWork,
      my_roles: tags.filter((t) => t.startsWith("role:")),
      pending_asks: pendingAsks,
      action_required: actionRequired.length ? actionRequired : undefined,
      my_score,
    };
  }

  /**
   * Reaper: runs at orient (check-in). Blocked-abandoned tasks owned by the
   * checking-in agent:
   *  - activity by the agent within the stale window → prompt it to check in
   *    (log_progress re-claims).
   *  - no activity → penalty (score counts the reaper event) and the task is
   *    reassigned: back to unclaimed todo, tagged "attempted", meta.attempt
   *    records who/when/how many times — the next agent must expect partial work.
   */
  private reapAbandoned(label: string, staleMin: number): string[] {
    const out: string[] = [];
    const now = Date.now();
    const staleMs = staleMin * 60_000;
    for (const t of this.state.storage.sql.exec(
      `SELECT id, title, meta, tags, status_ts, updated_ts FROM artefacts
       WHERE type = 'task' AND status = 'blocked' AND owner = ?`, label,
    ).toArray() as any[]) {
      const meta = JSON.parse(t.meta ?? "{}");
      if (!(meta.blocked?.reason ?? "").startsWith("abandoned")) continue;
      const lastOwn = this.one(
        `SELECT MAX(ts) AS ts FROM events WHERE artefact_id = ? AND actor = ?`, t.id, label,
      )?.ts ?? 0;
      const idleFor = now - Math.max(lastOwn, t.updated_ts ?? 0);
      if (idleFor < staleMs) {
        out.push(
          `${t.id} "${t.title}" is marked abandoned but you were active on it recently. log_progress on it NOW to re-claim, then keep the ≤${staleMin}m heartbeat.`,
        );
        continue;
      }
      const tags: string[] = JSON.parse(t.tags ?? "[]");
      if (!tags.includes("attempted")) tags.push("attempted");
      const attempts = ((meta.attempt?.attempts as number) ?? 0) + 1;
      meta.attempt = { by: label, at: now, attempts };
      delete meta.blocked;
      this.state.storage.sql.exec(
        `UPDATE artefacts SET status = 'todo', owner = '', tags = ?, meta = ?, status_ts = ?, updated_ts = ? WHERE id = ?`,
        JSON.stringify(tags), JSON.stringify(meta), now, now, t.id,
      );
      this.audit("system:reaper", "reassign", t.id, { prev_owner: label, attempts, idle_ms: idleFor });
      this.version(t.id, "system:reaper", "transition", `reassigned — ${label} silent >${staleMin}m after abandonment (attempt ${attempts})`, { prev_owner: label });
      out.push(
        `${t.id} "${t.title}" was REASSIGNED: you went silent >${staleMin}m after the watchdog blocked it. Your score is penalised. It is now unclaimed todo, tagged "attempted" (attempt ${attempts}) — partial work may exist. Do not blindly restart it: search_knowledge + get_artefact first.`,
      );
    }
    return out;
  }

  /** Project-facing settings only (safe for any authenticated agent). */
  private publicSettings() {
    const m = this.settingsMap();
    return { project_name: m.project_name, board: m.board ?? DEFAULT_BOARD, bootstrap_md: m.bootstrap_md };
  }

  private settingsMap(): Record<string, any> {
    const rows = this.state.storage.sql.exec(`SELECT key, value FROM settings`).toArray();
    const map: Record<string, any> = {};
    for (const r of rows) map[r.key] = JSON.parse(r.value);
    return map;
  }

  // ---------- admin ops (human plane) ----------

  /** stable DO slug for this instance's workspace (set by the registry at creation) */
  private wsSlug(): string {
    const m = this.settingsMap() as Record<string, any>;
    return typeof m.ws_slug === "string" ? m.ws_slug : "";
  }

  // ---- workspace registry (lives in the "global" KB DO; owner-checked, no admin flag) ----

  /** one-time import of the legacy hard-coded membership list */
  private async wsSeed(logins: string[]) {
    const now = Date.now();
    const slug = DEFAULT_WS_SLUG;
    // this DO *is* the default workspace — stamp it so tokens minted here embed the slug
    this.state.storage.sql.exec(
      `INSERT INTO settings (key, value) VALUES ('ws_slug', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      JSON.stringify(slug),
    );
    this.state.storage.sql.exec(
      `INSERT OR IGNORE INTO workspaces (slug, owner, personal, created_ts) VALUES (?, ?, 1, ?)`,
      slug, logins[0] ?? "legacy", now,
    );
    for (const login of logins) {
      this.state.storage.sql.exec(
        `INSERT OR IGNORE INTO workspace_members (ws, login) VALUES (?, ?)`, slug, login,
      );
    }
    return { ok: true, seeded: logins };
  }

  private async wsList(login: string) {
    const rows = this.state.storage.sql.exec(
      `SELECT w.slug, w.owner, w.personal, w.created_ts,
              EXISTS(SELECT 1 FROM workspace_members m WHERE m.ws = w.slug AND m.login = ?) AS member
         FROM workspaces w ORDER BY w.created_ts ASC`,
      login,
    ).toArray();
    return {
      workspaces: rows.map((r) => ({
        slug: r.slug, owner: r.owner, personal: !!r.personal,
        created_ts: r.created_ts, member: !!r.member,
      })),
    };
  }

  /** create: owner = caller; they become the first member; personal workspaces are <login> */
  private async wsCreate(body: any, login: string) {
    const slug = String(body.slug ?? "").trim();
    if (slug === "global" || slug === "legacy") throw new Error("reserved workspace name");
    if (slug !== login && !/^[a-z0-9][a-z0-9-]{1,39}$/.test(slug)) {
      throw new Error("slug must be 2-40 chars [a-z0-9-] (or your username for a personal ws)");
    }
    if (this.one(`SELECT slug FROM workspaces WHERE slug = ?`, slug)) {
      throw new Error(`workspace '${slug}' already exists`);
    }
    const now = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO workspaces (slug, owner, personal, created_ts) VALUES (?, ?, ?, ?)`,
      slug, login, slug === login ? 1 : 0, now,
    );
    this.state.storage.sql.exec(
      `INSERT INTO workspace_members (ws, login) VALUES (?, ?)`, slug, login,
    );
    // provision the KB DO for this workspace immediately: schema init + ws_slug
    // stamp so tokens minted there embed this workspace's slug
    const stub = (this.env as any).KB.get((this.env as any).KB.idFromName(doWs(slug)));
    await stub.fetch("https://kb/bootstrap", { method: "POST", body: "{}" }).catch(() => {});
    await stub.fetch("https://kb/admin.settings_set", {
      method: "POST",
      headers: { "content-type": "application/json", "x-kb-admin": "1" },
      body: JSON.stringify({ settings: { ws_slug: slug } }),
    }).catch(() => {});
    return { ok: true, slug };
  }

  /** join: only the owner of an existing workspace can add members */
  private async wsJoin(body: any, login: string) {
    const slug = String(body.ws ?? "").trim();
    const w = this.one(`SELECT slug, owner FROM workspaces WHERE slug = ?`, slug);
    if (!w) throw new Error(`no such workspace: ${slug}`);
    if (w.owner !== login) throw new Error("only the workspace owner can add members");
    const who = String(body.login ?? "").trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/.test(who)) throw new Error("bad github login");
    this.state.storage.sql.exec(
      `INSERT OR IGNORE INTO workspace_members (ws, login) VALUES (?, ?)`, slug, who,
    );
    return { ok: true, ws: slug, login: who };
  }

  private async wsMembers(body: any, login: string) {
    const slug = String(body.ws ?? "").trim();
    const w = this.one(`SELECT slug, owner FROM workspaces WHERE slug = ?`, slug);
    if (!w) throw new Error(`no such workspace: ${slug}`);
    const member = this.one(`SELECT 1 FROM workspace_members WHERE ws = ? AND login = ?`, slug, login);
    if (w.owner !== login && !member) throw new Error("not a member of this workspace");
    const rows = this.state.storage.sql.exec(
      `SELECT login FROM workspace_members WHERE ws = ? ORDER BY login`, slug,
    ).toArray();
    return { ws: slug, owner: w.owner, members: rows.map((r) => r.login) };
  }

  private async tokenMint(body: any) {
    const label = String(body.label ?? "").trim();
    if (!/^[a-zA-Z0-9._-]{2,40}$/.test(label)) throw new Error("label must be 2-40 chars [a-zA-Z0-9._-]");
    if (this.one(`SELECT id FROM auth_tokens WHERE label = ?`, label)) throw new Error(`label '${label}' already exists`);
    const tags = Array.isArray(body.tags) ? body.tags.map((t: any) => String(t).slice(0, 40)).slice(0, 10) : [];
    const transport = (TRANSPORTS as readonly string[]).includes(body.transport) ? body.transport : "mcp";
    const secret = generateAuthToken(this.wsSlug());
    const hash = await hashAuthToken(secret);
    const id = `at_${crypto.randomUUID().slice(0, 8)}`;
    const ts = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO auth_tokens (id, label, hash, tags, transport, created_ts) VALUES (?, ?, ?, ?, ?, ?)`,
      id, label, hash, JSON.stringify(tags), transport, ts,
    );
    this.audit("admin", "mint", id, { label, transport });
    return { id, label, tags, transport, secret }; // secret shown exactly once
  }

  private async tokenList() {
    const rows = this.state.storage.sql.exec(
      `SELECT id, label, tags, transport, created_ts, last_seen_ts, revoked_ts FROM auth_tokens ORDER BY created_ts DESC`,
    ).toArray();
    const sessions = this.state.storage.sql.exec(
      `SELECT token_id, name, first_seen_ts, last_seen_ts FROM sessions ORDER BY last_seen_ts DESC`,
    ).toArray();
    return { tokens: rows.map((r) => ({ ...r, tags: JSON.parse(r.tags ?? "[]") })), sessions };
  }

  private async tokenRevoke(body: any) {
    const id = String(body.id ?? "");
    const row = this.one(`SELECT id, label FROM auth_tokens WHERE id = ?`, id);
    if (!row) throw new Error(`no such auth token: ${id}`);
    this.state.storage.sql.exec(`UPDATE auth_tokens SET revoked_ts = ? WHERE id = ?`, Date.now(), id);
    this.audit("admin", "revoke", id, { label: row.label });
    return { id, revoked: true };
  }

  private async settingsGet() {
    return { settings: this.settingsMap() };
  }

  private async settingsSet(body: any) {
    const entries = Object.entries(body.settings ?? {}).filter(([k]) => /^[a-z0-9_]{1,40}$/.test(k));
    if (entries.length === 0) throw new Error("no valid settings keys (lowercase [a-z0-9_])");
    for (const [k, v] of entries) {
      this.state.storage.sql.exec(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        k, JSON.stringify(v),
      );
      this.audit("admin", "settings", k, {});
    }
    return { settings: this.settingsMap() };
  }

  // ---------- GitHub enrichment ----------

  private ghCache = new Map<string, { ts: number; data: any }>();

  private async ghIssue(num: number): Promise<any | null> {
    if (!this.env.GH_TOKEN) return null;
    const repo = this.settingsMap().github_repo ?? "state-vector/superpositional";
    const key = `${repo}#${num}`;
    const hit = this.ghCache.get(key);
    if (hit && Date.now() - hit.ts < 600_000) return hit.data;
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/issues/${num}`, {
        headers: {
          authorization: `Bearer ${this.env.GH_TOKEN}`,
          accept: "application/vnd.github+json",
          "user-agent": "bridge-kb",
        },
      });
      if (!r.ok) return null;
      const data = await r.json();
      this.ghCache.set(key, { ts: Date.now(), data });
      return data;
    } catch { return null; }
  }

  /** Pull issue body/labels into a bare artefact. Idempotent via the "## From GitHub" marker. */
  private async enrichFromGitHub(id: string, num: number) {
    const row = this.one(`SELECT title, body_md, tags, updated_ts FROM artefacts WHERE id = ?`, id);
    if (!row || (row.body_md ?? "").includes("## From GitHub")) return null;
    const issue = await this.ghIssue(num);
    if (!issue) return null;
    const labels: string[] = (issue.labels ?? []).map((l: any) => String(l.name ?? l));
    const body = `${row.body_md ?? ""}\n## From GitHub — #${num}\n**${issue.title}** · state: ${issue.state}${labels.length ? ` · labels: ${labels.join(", ")}` : ""}\n\n${String(issue.body ?? "").slice(0, 2000)}\n`;
    const existing = JSON.parse(row.tags ?? "[]");
    const merged = [...new Set([...existing, ...labels.map((l) => l.toLowerCase().replace(/[^a-z0-9:_-]/g, "-"))])].slice(0, 10);
    this.state.storage.sql.exec(
      `UPDATE artefacts SET body_md = ?, tags = ?, updated_ts = ? WHERE id = ?`,
      body, JSON.stringify(merged), Date.now(), id,
    );
    await this.embedArtefact(id, row.title, body);
    this.audit("system", "enrich", id, { issue: num });
    return id;
  }

  /** Enrich one or all bare, issue-referencing tasks. */
  private async enrich(body: any, actor: string) {
    if (!this.env.GH_TOKEN) throw new Error("GH_TOKEN not configured — GitHub enrichment unavailable");
    const targets = body.id
      ? [String(body.id)]
      : this.state.storage.sql.exec(
          `SELECT id, title, body_md FROM artefacts
           WHERE type = 'task' AND status = 'open' OR (type = 'task' AND status IN ('todo','in_progress','blocked'))
           ORDER BY updated_ts DESC LIMIT 50`,
        ).toArray()
          .filter((r: any) => !(r.body_md ?? "").includes("## From GitHub"))
          .map((r: any) => r.id);
    const done: string[] = [];
    for (const id of targets) {
      const row = this.one(`SELECT title, body_md FROM artefacts WHERE id = ?`, id);
      if (!row) continue;
      const num = issueRef(row.title);
      if (num && !(row.body_md ?? "").includes("## From GitHub")) {
        const r = await this.enrichFromGitHub(id, num);
        if (r) done.push(id);
      }
    }
    this.audit(actor, "enrich", null, { count: done.length });
    return { enriched: done };
  }

  // ---------- helpers ----------

  private audit(actor: string, op: string, artefactId: string | null, detail: object) {
    const ts = Date.now();
    const r = this.state.storage.sql.exec(
      `INSERT INTO events (ts, actor, op, artefact_id, detail) VALUES (?, ?, ?, ?, ?) RETURNING seq`,
      ts, actor, op, artefactId, JSON.stringify(detail),
    ).toArray()[0] as any;
    this.broadcastEvent({ seq: Number(r?.seq ?? 0), ts, actor, op, artefact_id: artefactId, detail });
  }

  private async nextSeq(_type: ArtefactType): Promise<number> {
    const rows = this.state.storage.sql.exec(`SELECT id FROM artefacts`).toArray();
    let max = 0;
    for (const r of rows as any[]) {
      const m = /^BR#(\d+)$/.exec(String(r.id));
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return max + 1;
  }

  private one(query: string, ...params: any[]) {
    return this.state.storage.sql.exec(query, ...params).toArray()[0] ?? null;
  }

  private shape(row: any) {
    return { ...row, meta: JSON.parse(row.meta ?? "{}"), tags: row.tags ? JSON.parse(row.tags) : [] };
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
