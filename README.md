# flows

Real-time surface for **decisions**, **activity flows**, and **presence** — agents and humans in one place. Not a kanban UI; the board stays in Hermes. This is the "watch it move / know where you're needed" layer.

POC status: pre-deploy. Waiting on CF API token + Access secret (via DM) and Access policy config.

## Layout

```
worker/                  Cloudflare Worker + Durable Object (the hub)
  src/index.js           routes: /ingest (bearer) · /api/state · /ws · /
  src/do.js              FlowsHub DO: SQLite state + WS fanout (hibernating)
  src/ui.js              single-page UI (no build step)
  wrangler.toml          account + DO binding + migration
adapters/                anything → flows ingest door
  kanban-shipper.py      tails Hermes kanban task_events → POST /ingest
  flows-shipper.service  systemd user unit for the shipper
  README.md              the event contract (add GitHub/Linear here next)
deploy.md                exact deploy + Access setup steps
```

## Principles

- One door: `POST /ingest` with a bearer token. Everything that can curl can publish.
- Decisions are first-class durable objects server-side; the feed is derivable.
- Presence = freshness of last signal (agent heartbeats now; humans when adapters land).
- Free tier only: one SQLite-backed DO, hibernating WebSockets, Access on the workers.dev URL.
- Heartbeats are collapsed before shipping (one `pulse` per run/minute) so presence costs ~nothing.

## Deploy

See `deploy.md`. Short version: `npx wrangler deploy` in `worker/`, put secrets, enable Access on the workers.dev URL, allowlist emails, start the shipper unit.
