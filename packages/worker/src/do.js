import { UI_HTML } from "./ui.js";

const MAX_EVENTS = 5000;      // rolling event log in DO SQLite
const HEARTBEAT_WINDOW_MS = 60_000;

/**
 * FlowsHub — one durable object: state, dedupe, presence, fanout.
 * SQLite-backed (per wrangler.toml migration), WebSocket hibernation on.
 */
export class FlowsHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.connections = new Set(); // hibernating websockets (by serialization row)
  }

  async ensureSchema() {
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        board TEXT, source TEXT, kind TEXT NOT NULL,
        actor TEXT, task_id TEXT, title TEXT,
        decision INTEGER NOT NULL DEFAULT 0,
        payload TEXT
      );
      CREATE TABLE IF NOT EXISTS actors (
        id TEXT PRIMARY KEY,           -- e.g. "agent:coder", "human:ray"
        kind TEXT NOT NULL,            -- agent | human | system
        label TEXT, last_ts INTEGER, status TEXT
      );
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,           -- stable per decision (task + seq)
        opened_ts INTEGER, updated_ts INTEGER,
        status TEXT NOT NULL DEFAULT 'open',   -- open | resolved
        title TEXT, reason TEXT, kind TEXT,    -- needs_input | diagnostic
        task_id TEXT, board TEXT, resolved_ts INTEGER
      );
    `);
  }

  async fetch(request) {
    const url = new URL(request.url);
    await this.ensureSchema();

    if (url.pathname === "/ingest") return this.handleIngest(request);
    if (url.pathname === "/state") return this.handleState();
    if (url.pathname === "/ui") return new Response(UI_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
    if (url.pathname === "/ws") return this.handleWs(request);
    return new Response("hub: not found", { status: 404 });
  }

  // ---- ingest ----
  async handleIngest(request) {
    const { events } = request.json;
    const inserted = [], wsPairs = [];
    const now = Date.now();

    for (const e of events) {
      const ev = normalize(e, now);
      if (!ev) continue;
      try {
        this.state.storage.sql.exec(
          `INSERT INTO events (id, ts, board, source, kind, actor, task_id, title, decision, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ev.id, ev.ts, ev.board, ev.source, ev.kind, ev.actor, ev.task_id, ev.title,
          ev.decision ? 1 : 0, JSON.stringify(ev.payload ?? {}));
      } catch {
        continue; // duplicate id → already stored; idempotent replay
      }
      inserted.push(ev);
      this.touchActor(ev);
      if (ev.kind === "blocked") this.openDecision(ev);
      if (ev.kind === "unblocked" || ev.kind === "completed") this.closeDecisions(ev);
      if (ev.kind === "heartbeat") this.collapseHeartbeat(ev);
    }
    this.trimEvents();

    for (const ev of inserted) wsPairs.push([JSON.stringify({ type: "event", event: ev }), null]);
    // decisions may have changed even for deduped events (e.g. resolved elsewhere)
    wsPairs.push([JSON.stringify({ type: "decisions", decisions: this.listDecisions() }), null]);
    wsPairs.push([JSON.stringify({ type: "presence", presence: this.listPresence() }), null]);
    for (const ws of this.listWebSockets()) {
      for (const [msg] of wsPairs) {
        try { ws.send(msg); } catch { /* hibernated client gone */ }
      }
    }
    return Response.json({ ok: true, accepted: inserted.length });
  }

  touchActor(ev) {
    if (!ev.actor) return;
    this.state.storage.sql.exec(
      `INSERT INTO actors (id, kind, label, last_ts, status) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_ts=excluded.last_ts, status=excluded.status`,
      ev.actor, ev.actor_kind || classifyActor(ev.actor), ev.actor_label || ev.actor,
      ev.ts, ev.kind === "heartbeat" ? "working" : "active");
  }

  collapseHeartbeat(ev) {
    // Keep event log small: delete heartbeats for same task older than the window.
    this.state.storage.sql.exec(
      `DELETE FROM events WHERE kind='heartbeat' AND task_id=? AND ts < ?`,
      ev.task_id ?? "", ev.ts - HEARTBEAT_WINDOW_MS);
  }

  openDecision(ev) {
    const id = `dec:${ev.board ?? ev.source}:${ev.task_id ?? ev.id}`;
    const kind = ev.payload?.kind || "diagnostic";
    this.state.storage.sql.exec(
      `INSERT INTO decisions (id, opened_ts, updated_ts, status, title, reason, kind, task_id, board)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_ts=excluded.updated_ts, reason=excluded.reason`,
      id, ev.ts, ev.ts, ev.title || "Untitled task", ev.payload?.reason || "", kind,
      ev.task_id, ev.board);
  }

  closeDecisions(ev) {
    this.state.storage.sql.exec(
      `UPDATE decisions SET status='resolved', resolved_ts=?, updated_ts=?
       WHERE status='open' AND task_id=?`,
      ev.ts, ev.ts, ev.task_id ?? "");
  }

  listDecisions() {
    return this.state.storage.sql.exec(
      `SELECT * FROM decisions WHERE status='open' ORDER BY opened_ts DESC LIMIT 100`).toArray();
  }

  listPresence() {
    const cutoff = Date.now() - 10 * 60_000; // "active" = signal in last 10 min
    return this.state.storage.sql.exec(
      `SELECT id, kind, label, last_ts, status FROM actors
       ORDER BY last_ts DESC LIMIT 200`).toArray()
      .map(a => ({ ...a, active: a.last_ts >= cutoff }));
  }

  trimEvents() {
    this.state.storage.sql.exec(
      `DELETE FROM events WHERE id NOT IN
       (SELECT id FROM events ORDER BY ts DESC, id DESC LIMIT ?)`, MAX_EVENTS);
  }

  // ---- reads ----
  async handleState() {
    const events = this.state.storage.sql.exec(
      `SELECT * FROM events ORDER BY ts DESC, id DESC LIMIT 200`).toArray()
      .map(e => ({ ...e, payload: safeParse(e.payload), decision: !!e.decision }));
    return Response.json({
      events,
      decisions: this.listDecisions(),
      presence: this.listPresence(),
      now: Date.now(),
    });
  }

  // ---- websockets (hibernating) ----
  async handleWs(request) {
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    // initial snapshot
    const st = await this.handleState();
    const text = await st.text();
    pair[1].send(JSON.stringify({ type: "snapshot", state: JSON.parse(text) }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  listWebSockets() {
    return this.state.getWebSockets();
  }
}

function normalize(e, now) {
  if (!e || typeof e !== "object") return null;
  const kind = String(e.kind || "").slice(0, 40);
  if (!kind) return null;
  const source = String(e.source || e.board || "kanban").slice(0, 40);
  const id = String(e.id || `${source}:${now}:${Math.random().toString(36).slice(2, 8)}`).slice(0, 200);
  return {
    id, kind, source,
    board: e.board ? String(e.board).slice(0, 60) : null,
    ts: Number.isFinite(e.ts) ? e.ts : now,
    actor: e.actor ? String(e.actor).slice(0, 80) : null,
    actor_kind: e.actor_kind ? String(e.actor_kind).slice(0, 10) : undefined,
    actor_label: e.actor_label ? String(e.actor_label).slice(0, 80) : undefined,
    task_id: e.task_id ? String(e.task_id).slice(0, 100) : null,
    title: e.title ? String(e.title).slice(0, 300) : null,
    decision: kind === "blocked" || e.decision === true,
    payload: e.payload && typeof e.payload === "object" ? e.payload : {},
  };
}

function classifyActor(actor) {
  if (actor.startsWith("human:")) return "human";
  if (actor.startsWith("agent:")) return "agent";
  return "system";
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
