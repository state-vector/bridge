# bridge

Real-time surface for **decisions**, **activity flows**, and **presence** — agents and humans, one place. Not a kanban UI; the board stays in Hermes. One ingest door (`POST /ingest`, bearer); humans get a Cloudflare Access–gated UI today, Tauri desktop later.

**GitHub:** https://github.com/state-vector/bridge (private). Deploys to Cloudflare are done from the box / Cloudflare dashboard — **not** GitHub CI (CI may be used later for tests only).

## Packages (npm workspaces)

| package | what |
|---|---|
| **`packages/specs`** | the contract: JSON Schemas (`schemas/`), wire docs (`docs/api.md`), TS types (`src/types.ts` + `src/index.ts` constants), consistency gate (`scripts/gen_types.py`). Every other package codes against this. |
| **`packages/worker`** | Cloudflare Worker + FlowsHub Durable Object: `/ingest` (bearer), `/ws` fanout (hibernating), `/api/state`, `/` UI. Deploy via `deploy.md`. |
| **`packages/adapters`** | anything → `/ingest`: `kanban-shipper.py` (tails the Hermes kanban SQLite on EC2; read-only, cursor-resumable) + its systemd unit + smoke tests. GitHub/Linear webhooks land here next. |
| **`packages/desktop`** | placeholder for the Tauri (TS) app — ws client, actionable notifications, offline cache. Consumes `@flows/specs`. |

## Workflow

```bash
npm install                      # workspace bootstrap (worker deps incl. wrangler, jose)
npm run test -w packages/specs   # schema/type consistency gate
npm run test                     # everything
cd packages/worker && npx wrangler deploy
```

Contract change → edit `packages/specs/schemas/*.json` → `npm run generate -w packages/specs` (validates refs + types mirror) → worker and desktop both consume the same types.

## Principles

- One door: `POST /ingest` with a bearer token. Everything that can curl can publish.
- Decisions are first-class durable objects server-side; the feed is derivable.
- Presence = freshness of last signal (agent heartbeats now; humans when adapters land).
- Free tier only: one SQLite-backed DO, hibernating WebSockets, Access on the workers.dev URL.
- Heartbeats collapsed (60 s window per task) so presence costs ~nothing.

## Deploy

See `deploy.md`. Short version: `npx wrangler deploy` in `packages/worker/`, put secrets, enable Access on the workers.dev URL, allowlist emails, start the shipper unit.
