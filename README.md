# bridge

Real-time surface for **decisions**, **activity flows**, and **presence** — agents and humans, one place. Not a kanban UI; the board stays in Hermes. One ingest door (`POST /ingest`, bearer); humans get a Cloudflare Access–gated **webapp** (served by the worker) plus a **Tauri menubar app** with actionable notifications.

**GitHub:** https://github.com/state-vector/bridge (private). Deploys to Cloudflare are done from the box / Cloudflare dashboard — **not** GitHub CI (CI may be used later for tests only).

## Packages (npm workspaces)

| package | what |
|---|---|
| **`packages/specs`** | the contract: JSON Schemas (`schemas/`), wire docs (`docs/api.md`), TS types (`src/types.ts` + `src/index.ts` constants), consistency gate (`scripts/gen_types.py`). Every other package codes against this. |
| **`packages/worker`** | Cloudflare Worker + FlowsHub Durable Object: `/ingest` (bearer), `/ws` fanout (hibernating), `/api/state`, `/` → **the webapp** (worker assets, SPA), `/ui` legacy page. Deploy via `deploy.md`. |
| **`packages/webapp`** | the web app: **Board** (tasks by status, per-agent swimlanes, live progress + sentiment, activity chart), **Log** (audit stream), **Knowledge** (hybrid search, artefact browser), **Discussions**, **Connect** (auth tokens + agent setup), **Decisions** (legacy plane). `npm run demo -w @flows/webapp` runs a contract-faithful mock hub for offline dev. |
| **`packages/desktop`** | **parked** — sits in the repo, excluded from workspaces/builds; restore the workspace entry to revive the Tauri menubar shell (auth-token + MCP flows already designed). |
| **`packages/adapters`** | anything → `/ingest`: `kanban-shipper.py` (tails the Hermes kanban SQLite on EC2; read-only, cursor-resumable) + its systemd unit + smoke tests. GitHub/Linear webhooks land here next. |

## Workflow

```bash
npm install                      # workspace bootstrap (worker deps incl. wrangler, jose)
npm run test -w packages/specs   # schema/type consistency gate
npm run build -w @flows/webapp   # build the panel (worker assets + tauri both consume dist)
cd packages/worker && npx wrangler deploy   # ships worker + webapp together
```

Contract change → edit `packages/specs/schemas/*.json` → `npm run generate -w packages/specs` (validates refs + types mirror) → worker, webapp and desktop all consume the same types.

## Principles

- One door: `POST /ingest` with a bearer token. Everything that can curl can publish — including the webapp's answers (unblock/done) and steering (`kind: "steer"` events).
- Decisions are first-class durable objects server-side; the feed is derivable.
- Presence = freshness of last signal (agent heartbeats now; humans when adapters land).
- Free tier only: one SQLite-backed DO, hibernating WebSockets, worker assets for the webapp, Access on the workers.dev URL.
- Heartbeats collapsed (60 s window per task) so presence costs ~nothing.

## Deploy

See `deploy.md`. Short version: `npm run build -w @flows/webapp && npx wrangler deploy` in `packages/worker/`, put secrets, enable Access on the workers.dev URL, allowlist emails, start the shipper unit.
