# opencode → bridge /ingest contract (A2A adapter spec)

Status: PROPOSED v1 — for Ray's review before implementation.
Author: coder (Hermes), 2026-10-13. Follows the Oct 13 A2A direction: every agent
POSTs to the same /ingest door with `actor: agent:<name>`. No tunnels, one shared bearer.

## Goal

desktop opencode-local gets an ingest identity on bridge: it posts presence, its own
blocked/decision cards, and completions to the same door Hermes and the shippers use.
The FlowsHub DO is the shared meeting point.

## Transport & auth (identical to every other client)

- `POST https://bridge.ray-013.workers.dev/ingest`
- `Authorization: Bearer $FLOWS_INGEST_TOKEN` (the one shared machine-plane bearer —
  opencode gets the same token value Ray puts in the worker secret; nothing else)
- Body: a single event object, or `{"events": [...]}` (max 1000 per POST).
- Idempotent: server dedupes on `id`; safe to retry the whole batch.

No new secrets, no new endpoints, no tunnel.

## Event shape (flows/event.schema.json — no schema changes needed)

```json
{
  "id": "opencode:<sessionID>:<seq|slug>",
  "source": "opencode",
  "kind": "heartbeat | started | completed | blocked | unblocked",
  "ts": 1791900000,
  "board": "opencode-local",
  "task_id": "<opencode sessionID>",
  "title": "human summary of what the session is doing",
  "actor": "agent:opencode-local",
  "payload": { ... per kind below ... }
}
```

Conventions (matching how github-shipper and the DO already behave):

- `id` — `opencode:<sessionID>:<n>` with a monotonically increasing n, or a stable
  slug per logical event. Re-sends are no-ops (DO dedupes on INSERT).
- `task_id` — the opencode sessionID, verbatim. This is what groups heartbeats
  (collapsed per task_id) and what keys decision open/close.
- `board` — fixed string `opencode-local`. Keeps opencode events visually grouped
  and makes decision ids `dec:opencode-local:<sessionID>`.
- `actor` — always `agent:opencode-local`. The DO's touchActor() turns any posted
  event into presence automatically (10-minute active window); heartbeats set
  status `working`, everything else `active`.

## Kinds (the only five opencode emits)

| kind | when | payload |
|---|---|---|
| `started` | session begins work | `{"summary": "<one line>", "model": "<id>"}` |
| `heartbeat` | every 60s while actively working | `{}` (DO collapses old ones per task_id) |
| `blocked` | opencode needs the human (question, approval, missing credential) — opens a decision card | `{"reason": "<the ask>", "kind": "needs_input"\|"diagnostic", "options": [{"id","label","hint"?}] (≤6, for answerable asks), "urgency": "normal"\|"time-sensitive", "deadline_ts"?: ms}` |
| `unblocked` | the ask was answered / condition cleared — resolves the card | `{"choice": "<options[].id>", "by": "human:ray"}` |
| `completed` | session finished — resolves any open card for the task | `{"summary": "<what happened>", "result": "ok"\|"failed"\|"aborted"}` |

Notes:
- `blocked` + `unblocked`/`completed` is exactly the DO's decision open/close pair.
  `options` rides the answerable-decisions path added in d50aa95.
- No `assigned`, no `pr_checks`, no comment kinds — those are GitHub-adapter concerns.
  opencode events stay minimal: presence + decisions + completions.
- Heartbeats only fire while the session is actively processing (not while idle at a
  prompt) — presence going stale after 10 min IS the signal that opencode is free.

## Session ↔ task mapping

- 1 opencode session = 1 `task_id` = at most 1 open decision card at a time.
- A new session that needs the same human ask re-POSTs `blocked` with its own
  task_id — that's correct: it's a separate card, keyed per session.
- If opencode resumes a session, it keeps the same task_id (cursor: none needed;
  the DO is the state — opencode should GET nothing, just POST).

## Read path (v1) — the one gap

v1 is write-only: opencode posts `blocked` and learns the answer out-of-band (the
human answers in the next chat turn; the #cody-decisions nag points at the board).
It does NOT poll `/api/state` — that's the human plane (password cookie).

If we later want opencode to self-serve the answer (agent waits on the decision),
the natural move is: allow the machine bearer a read-only `GET /api/state`.
That is a worker change + a security-posture decision — Ray's call, tracked below.

## Implementation sketch (opencode side)

A tiny plugin/hook in opencode-local (~60 LOC): on session events, POST to /ingest.
Env: `FLOWS_INGEST_URL`, `FLOWS_INGEST_TOKEN` (same values Hermes uses, from
~/.hermes/.env or the desktop env). Fire-and-forget with retry-once; a down bridge
never blocks the agent.

## Open decision for Ray

1. Read path: keep v1 write-only (recommended for now), or add bearer GET /api/state
   so agents can watch their own decision cards? (worker change; bearer would see
   everything on the board, not just its own events).
