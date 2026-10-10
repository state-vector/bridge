# flows — API & WebSocket schema

Two auth planes, deliberately split:

| plane | who | mechanism |
|---|---|---|
| **machine** | agents, cron, GitHub/Linear webhooks | `Authorization: Bearer $FLOWS_INGEST_TOKEN` on `POST /ingest` only — webhooks can't do browser SSO, so ingest is *not* behind Access |
| **human** | browsers (UI, state, WS) | Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`, verified by the Worker against `$CF_ACCESS_TEAM` JWKS, audience `$CF_ACCESS_AUD`); enforced before any human route runs |

Base URL after deploy: `https://flows.<subdomain>.workers.dev`

---

## REST

### `POST /ingest`  *(machine plane)*

Publish events. Idempotent per event `id` — replays are safe.

- Body: `{"events": [Event, ...]}` or a single bare `Event` object
- Max 1000 events/batch; field limits in [Limits](#limits)

**Responses**

| code | when | body |
|---|---|---|
| 200 | batch stored (deduped) | `{"ok": true, "accepted": <n>}` — `accepted` = *new* events stored |
| 400 | malformed JSON | `{"error": "bad json"}` |
| 401 | missing/wrong bearer | `{"error": "unauthorized"}` |
| 405 | not POST | `{"error": "POST only"}` |
| 413 | > 1000 events | `{"error": "batch too large"}` |
| 503 | Access vars unset (misconfig, human routes only) | `{"error": "access not configured"}` |

Invalid events *inside* a 200 batch are dropped silently (no `kind`, wrong types) — check `accepted` < sent count.

### `GET /api/state`  *(human plane)*

Snapshot for cold start / debugging.

```json
{
  "now": 1791523525000,
  "events":   [ EventView, ... ],     // newest first, ≤ 200
  "decisions": [ Decision, ... ],     // status = "open" only, ≤ 100, newest first
  "presence":  [ Presence, ... ]      // ≤ 200, most-recent-signal first
}
```

### `GET /`  *(human plane)* — the UI (single HTML page, no build step).

---

## WebSocket — `GET /ws`  *(human plane, standard browser upgrade)*

Server-push only; the client never sends frames. Auto-reconnect with backoff is the client's job (the bundled UI does: snapshot on connect, apply patches after).

**Frames (server → client):**

```jsonc
{ "type": "snapshot",
  "state": { "events": [...], "decisions": [...], "presence": [...], "now": 0 } }

{ "type": "event",     "event":     EventView }        // one per newly-stored event
{ "type": "decisions", "decisions": [Decision, ...] } // full open-list replace, sent after every ingest
{ "type": "presence",  "presence":  [Presence, ...] } // full list replace, sent after every ingest
```

---

## Object schemas

### Event (what adapters POST — canonical wire form)

```jsonc
{
  "id":      "superpositional:117",  // REQUIRED. globally unique; same id = deduped no-op
  "source":  "kanban",               // REQUIRED ≤40ch. kanban | github | linear | slack | cron | ...
  "kind":    "claimed",              // REQUIRED ≤40ch. see semantics table in adapters/README.md
  "ts":      1791523525,             // unix SECONDS (int); defaults to arrival time
  "board":   "superpositional",      // optional ≤60ch, groups events
  "task_id": "t_ab12",               // optional ≤100ch, stable work ref; drives decision open/close
  "title":   "Fix rule-compiler",    // optional ≤300ch, human-readable what
  "actor":   "agent:coder",          // optional ≤80ch. "agent:*" | "human:*" | "system:*"
  "actor_kind": "agent",             // optional; inferred from prefix if absent
  "actor_label": "coder",            // optional display name
  "payload": { "reason": "..." }     // optional object, kept small (reasons, not logs)
}
```

Unknown fields are **ignored, not rejected** (forward-compatible adapters). Fields the hub currently drops: `run_id` (kanban adapter sends it; planned for per-run presence later).

### EventView (as returned/rendered)

= Event plus: `decision: bool` (true for `blocked`), `payload` parsed, `ts` normalized to ms epoch, server-assigned defaults filled.

### Decision (derived, not posted — never send these)

```jsonc
{
  "id": "dec:superpositional:t_ab12",  // dec:<board|source>:<task_id>
  "status": "open",                    // open | resolved (only open is published)
  "title": "Fix rule-compiler",
  "reason": "waiting on scope call",   // from blocked payload.reason
  "kind": "needs_input",               // needs_input (amber) | diagnostic (red)
  "task_id": "t_ab12", "board": "superpositional",
  "opened_ts": 0, "updated_ts": 0, "resolved_ts": null,
  // --- rich asks (all optional, from the blocked event's payload) ---
  "options": [ { "id": "flag", "label": "Ship behind flag", "hint": "reversible" } ],
  "urgency": "time-sensitive",         // normal | time-sensitive (may interrupt)
  "deadline_ts": 1791526000000,        // ms epoch
  "asker": "agent:coder"               // actor that raised it
}
```

**Ask conventions (no new endpoints — everything rides `/ingest`):**

- **Ask richly:** `blocked` event payload may carry `options` (≤6 `{id,label,hint?}`),
  `urgency` (`"time-sensitive"` tiers the notification), `deadline_ts` (ms), and
  `kind: "needs_input"`. The hub copies them onto the derived decision.
- **Answer:** ingest `unblocked` (work resumes) or `completed` on the same `task_id`
  with `payload: { "choice": "<options[].id>", "note": "...", "decision_id": "dec:..." }`.
  The hub resolves the decision; the answer lands in the feed with your actor id
  (that's the audit trail).
- **Askers without a choice list** just omit `options` — answerers use plain
  unblock/done.

Lifecycle: `blocked` event → upsert open decision (same id updates reason/ts).
`unblocked` **or** `completed` on the same `task_id` → resolves all open decisions for it.

### Presence

```jsonc
{ "id": "agent:coder", "kind": "agent", "label": "coder",
  "last_ts": 0, "status": "working", "active": true }   // active = signal ≤ 10 min ago
```

Actors upsert from any event with an `actor`; `heartbeat`/`pulse` keep them fresh without polluting the feed.

---

## Limits & retention (free-tier POC)

| thing | value |
|---|---|
| events retained in hub | rolling 5000 (newest kept) |
| heartbeat retention | 60 s per task (older deleted on each heartbeat) |
| batch size | ≤ 1000 events |
| field caps | id 200 · source/kind 40 · board 60 · actor 80 · title 300 |
| presence "active" window | 10 min |
| state/feed sizes | 200 events · 100 decisions · 200 actors |

Machine-readable copies: `schemas/event.schema.json`,
`schemas/ws-frames.schema.json` (+ `state`, `eventview`, `decision`, `presence`,
`ingest-request`). All validated against 116 real shipper events; refs resolve
via `$id` registry (`flows/…`).
