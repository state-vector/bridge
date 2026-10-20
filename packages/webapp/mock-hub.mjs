/**
 * Contract-faithful mock of the bridge hub DO for offline dev/demo.
 * Implements the same wire contract as @bridge/specs:
 *   WS   /ws         snapshot | event | decisions | presence  (server-push only)
 *   GET  /api/state  { events, decisions, presence, now }
 *   POST /ingest     bearer "x" (any token accepted in mock) → dedupe, decision lifecycle
 *
 * Demo beats (auto-start on first client):
 *   t+4s   agent:atlas + agent:nova work tasks (claimed/working/heartbeat)
 *   t+16s  atlas hits blocked → decision (needs_input); answering unblocked/completed
 *          via /ingest resolves it, and atlas visibly proceeds (loop-closure in feed)
 *   t+36s  human:mom blocked (home board) → decision
 *   t+55s  system:cron blocked (diagnostic) → decision
 *   any    steer events land in the feed and echo back as agent "pivoting" steps
 */
import { WebSocketServer } from "ws";
import http from "node:http";
import crypto from "node:crypto";

const PORT = 7788;
const now = () => Date.now();
const rid = () => Math.random().toString(36).slice(2, 10);

// ---------- hub state (mirrors do.js) ----------

const events = new Map(); // id -> EventView
const actors = new Map(); // id -> presence
const decisions = new Map(); // id -> Decision
const clients = new Set();

function classify(actor) {
  if (actor.startsWith("human:")) return "human";
  if (actor.startsWith("agent:")) return "agent";
  return "system";
}

function normalize(e) {
  if (!e || typeof e !== "object") return null;
  const kind = String(e.kind || "").slice(0, 40);
  if (!kind) return null;
  const source = String(e.source || e.board || "kanban").slice(0, 40);
  const ts = Number.isFinite(e.ts) ? e.ts : now();
  return {
    id: String(e.id || `${source}:${ts}:${rid()}`).slice(0, 200),
    kind,
    source,
    board: e.board ? String(e.board).slice(0, 60) : null,
    ts: ts > 0 && ts < 10_000_000_000 ? ts * 1000 : ts,
    actor: e.actor ? String(e.actor).slice(0, 80) : null,
    actor_kind: e.actor_kind ?? (e.actor ? classify(String(e.actor)) : undefined),
    actor_label: e.actor_label ?? undefined,
    task_id: e.task_id ? String(e.task_id).slice(0, 100) : null,
    title: e.title ? String(e.title).slice(0, 300) : null,
    decision: kind === "blocked",
    payload: e.payload && typeof e.payload === "object" ? e.payload : {},
  };
}

function state() {
  return {
    events: [...events.values()].sort((a, b) => b.ts - a.ts).slice(0, 200),
    decisions: [...decisions.values()].filter((d) => d.status === "open").slice(0, 100),
    presence: [...actors.values()].sort((a, b) => b.last_ts - a.last_ts).slice(0, 200),
    now: now(),
  };
}

const send = (ws, obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));
const fanout = (frame) => { for (const ws of clients) send(ws, frame); };
const pushDerived = () => {
  fanout({ type: "decisions", decisions: state().decisions });
  fanout({ type: "presence", presence: state().presence });
};

function ingest(eventsIn) {
  let accepted = 0;
  for (const raw of eventsIn) {
    const ev = normalize(raw);
    if (!ev || events.has(ev.id)) continue;
    events.set(ev.id, ev);
    if (events.size > 2000) events.delete(events.keys().next().value);
    accepted++;

    if (ev.actor) {
      actors.set(ev.actor, {
        id: ev.actor,
        kind: ev.actor_kind ?? classify(ev.actor),
        label: ev.actor_label ?? ev.actor.split(":")[1] ?? ev.actor,
        last_ts: ev.ts,
        status: ev.kind === "heartbeat" ? "working" : "active",
        active: true,
      });
    }
    if (ev.kind === "blocked") {
      const id = `dec:${ev.board ?? ev.source}:${ev.task_id ?? ev.id}`;
      decisions.set(id, {
        id, status: "open",
        title: ev.title || "Untitled task",
        reason: ev.payload?.reason || "",
        kind: ev.payload?.kind || "diagnostic",
        task_id: ev.task_id, board: ev.board,
        opened_ts: ev.ts, updated_ts: ev.ts, resolved_ts: null,
      });
    }
    if (ev.kind === "unblocked" || ev.kind === "completed") {
      for (const d of decisions.values()) {
        if (d.status === "open" && d.task_id && d.task_id === ev.task_id) {
          d.status = "resolved";
          d.resolved_ts = ev.ts;
          d.updated_ts = ev.ts;
        }
      }
    }
    fanout({ type: "event", event: ev });
  }
  pushDerived();
  return accepted;
}

// ---------- scenario ----------

const timers = new Set();
const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };

let atlasUnblocked = null; // set by /ingest when the human answers

function ev(fields) { return { source: "mock", ...fields }; }

function startScenario() {
  for (const t of timers) clearTimeout(t);
  timers.clear();

  const task = (who, task_id, board, seq) => {
    const [kind, title] = seq;
    ingest([ev({ id: `mock:${task_id}:${rid()}`, kind, title, actor: who, task_id, board })]);
  };

  later(() => task("agent:atlas", "t_auth", "superpositional", ["claimed", "migrate auth tests"]), 4000);
  later(() => task("agent:atlas", "t_auth", "superpositional", ["working", "reading auth middleware"]), 7000);
  later(() => task("agent:nova", "t_pricing", "superpositional", ["claimed", "scrape competitor pricing"]), 9000);
  later(() => task("agent:atlas", "t_auth", "superpositional", ["heartbeat", "still working"]), 11000);
  later(() => task("agent:nova", "t_pricing", "superpositional", ["working", "3 pricing pages found"]), 13000);

  // Beat 2: the gate — rich ask (options, urgency, deadline) via blocked payload
  later(() => ingest([ev({
    id: `mock:t_auth:blocked:${rid()}`, kind: "blocked", title: "Auth migration ready to merge",
    actor: "agent:atlas", task_id: "t_auth", board: "superpositional",
    payload: {
      reason: "rollout strategy needs a call", kind: "needs_input",
      urgency: "time-sensitive", deadline_ts: now() + 15 * 60_000,
      options: [
        { id: "flag", label: "Ship behind flag (10%)", hint: "reversible, data today" },
        { id: "hold", label: "Hold for QA sign-off", hint: "safer, slips ~1 day" },
      ],
    },
  })]), 16000);

  later(() => task("agent:nova", "t_pricing", "superpositional", ["working", "competitor B 403 — trying render fallback"]), 24000);

  // Beat 3: human decision (home board)
  later(() => ingest([ev({
    id: `mock:t_carpool:blocked:${rid()}`, kind: "blocked", title: "Carpool overlaps Thursday 1:1",
    actor: "human:mom", actor_kind: "human", task_id: "t_carpool", board: "home",
    payload: {
      reason: "move the 1:1 to 3:30?", kind: "needs_input",
      options: [
        { id: "yes", label: "Yes, move it" },
        { id: "no", label: "No, keep 1:1" },
      ],
    },
  })]), 36000);

  // Beat 4: system diagnostic
  later(() => ingest([ev({
    id: `mock:t_flaky:blocked:${rid()}`, kind: "blocked", title: "3 flaky tests in payments",
    actor: "system:cron", task_id: "t_flaky", board: "superpositional",
    payload: { reason: "failed 4 of last 7 nights", kind: null },
  })]), 55000);

  // loop-closure: when the human answers the atlas gate, atlas visibly proceeds
  atlasUnblocked = (answerKind, note, choice) => {
    const labels = { flag: "ship behind flag", hold: "hold for QA", yes: "move it", no: "keep it" };
    const echo = choice ? labels[choice] ?? choice : note ?? answerKind;
    later(() => task("agent:atlas", "t_auth", "superpositional", [
      "working",
      `Gate closed (${echo}) — proceeding`,
    ]), 1200);
    later(() => task("agent:atlas", "t_auth", "superpositional", ["heartbeat", "rolling out behind flag"]), 4200);
  };
}

// ---------- server ----------

const httpServer = http.createServer((req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization",
  };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = (code, obj) => { res.writeHead(code, { ...cors, "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/state") return json(200, state());
    if (url.pathname === "/ingest" && req.method === "POST") {
      try {
        const b = JSON.parse(body || "{}");
        const list = Array.isArray(b.events) ? b.events : [b];
        const atlas = list.find((e) => (e?.kind === "unblocked" || e?.kind === "completed") && e?.task_id === "t_auth");
        const accepted = ingest(list);
        if (atlas) atlasUnblocked?.(atlas.kind, atlas.payload?.note, atlas.payload?.choice);
        return json(200, { ok: true, accepted });
      } catch (e) { return json(400, { error: String(e) }); }
    }
    json(200, { ok: true, try: [
      `curl -X POST localhost:${PORT}/ingest -H 'authorization: Bearer x' -H 'content-type: application/json' -d '{"events":[{"id":"c1","source":"curl","kind":"blocked","title":"Manual decision","task_id":"t_manual","actor":"human:ray","payload":{"reason":"from curl"}}]}'`,
      `curl -X POST localhost:${PORT}/ingest -H 'authorization: Bearer x' -H 'content-type: application/json' -d '{"events":[{"id":"c2","source":"curl","kind":"unblocked","task_id":"t_auth","actor":"human:ray"}]}'`,
      `curl -X POST localhost:${PORT}/trigger/reset`,
    ] });
  });
});

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
wss.on("connection", (ws) => {
  clients.add(ws);
  send(ws, { type: "snapshot", state: state() });
  ws.on("close", () => clients.delete(ws));
});

let started = false;
const kick = setInterval(() => {
  if (clients.size > 0 && !started) { started = true; startScenario(); clearInterval(kick); }
}, 500);

httpServer.listen(PORT, () => console.log(`bridge contract mock hub: http://127.0.0.1:${PORT}  (ws /ws, POST /ingest, GET /api/state)`));
