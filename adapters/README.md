# Adapters — the one door

Everything publishes to the same endpoint:

```
POST https://flows.<subdomain>.workers.dev/ingest
Authorization: Bearer <FLOWS_INGEST_TOKEN>
Content-Type: application/json

{ "events": [ {...}, ... ] }        # or a single event object
```

## Event shape

```json
{
  "id":      "kanban-unique-id",     // REQUIRED for dedupe: same id = ignored on replay
  "source":  "kanban",               // kanban | github | linear | slack | cron | ...
  "board":   "superpositional",      // optional grouping
  "kind":    "claimed",              // see kinds below
  "ts":      1791523525,             // unix seconds (int)
  "task_id": "t_ab12",               // optional stable work ref
  "title":   "Fix rule-compiler",   // human-readable what
  "actor":   "agent:coder",          // "agent:*" | "human:*" | "system:*"
  "payload": { }                     // source-specific, kept small
}
```

Kinds with special meaning (everything else renders as generic activity):

| kind | effect |
|---|---|
| `blocked` | opens/updates a **decision card**; `payload.kind` = `needs_input` (amber) or `diagnostic` (red); `payload.reason` shown |
| `unblocked`, `completed` | resolves that work's open decision cards |
| `heartbeat` | presence only — collapsed server-side (60s window per task) |
| `pulse` | (reserved) actor-level presence without a task |

Actor convention: `agent:<profile>`, `human:<email-prefix>`, `system:<name>`.

## Adapter list

- `kanban-shipper.py` — Hermes kanban `task_events` → here (running on the EC2 box as a systemd user unit). Read-only SQLite tail, cursor-resumable, replays on failed POST.
- *next:* `github.js` — issues/PRs/reviews via GitHub webhooks (needs a public Worker route + secret; issue opened = flow event, assigned-to-human = decision candidate)
- *next:* `linear.js` — Linear webhooks (same shape)

## Field limits

Worker enforces: id ≤200 chars, kind ≤40, source ≤40, board ≤60, actor ≤80, title ≤300; batch ≤1000 events. Oversized payloads are rejected — keep payload small (reasons, not logs).
