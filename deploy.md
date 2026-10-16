# Deploy runbook — flows POC

Prereqs: Cloudflare account `013b6a2b6f3dfb6c8d48657769681087`, Zero Trust enabled,
Access application created for the workers.dev hostname (AUD `02bf2012058821d837180e16d3146cc0`).

## 1. Worker

Deploys are **push-to-main** — Cloudflare's git integration builds and ships the worker on every push to `main`. Local `npx wrangler deploy` from the box still works for out-of-band fixes. Do NOT wire GitHub Actions deploys. CI, when added, is for tests only.

```bash
cd ~/flows/packages/worker
export CLOUDFLARE_API_TOKEN=<token>
npx wrangler deploy
# note the printed URL: https://flows.<subdomain>.workers.dev
```

Secrets (not in wrangler.toml):

```bash
npx wrangler secret put FLOWS_INGEST_TOKEN   # generate: openssl rand -hex 24


```

## 2. Human-plane auth (GitHub OAuth)

Sign-in is GitHub OAuth: `GET /login` → github.com → `GET /login/callback` →
HMAC session cookie (30d), signed with `GITHUB_CLIENT_SECRET`. Anyone with a
GitHub account can sign in (public app).

1. github.com → Settings → Developer settings → OAuth Apps → **New OAuth App**:
   - Homepage: `https://bridge.ray-013.workers.dev`
   - Callback: `https://bridge.ray-013.workers.dev/login/callback`
2. Store the secrets:

```bash
cd ~/flows/packages/worker
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
# rotate = re-put (also invalidates all session cookies — they're HMAC-signed with the secret)
npx wrangler secret delete BRIDGE_UI_PASSWORD   # if the old shared password was set
```

**Workspace scoping.** Every human session is scoped to one workspace slug —
its own DOs (`ws:<slug>`), so users only see content from their workspace:

- `WORKSPACE_MEMBERS` (optional secret): JSON map slug → GitHub logins, e.g.
  `{"state-vector":["rayh"],"client-x":["grace"]}`. A login in no list gets an
  isolated auto-workspace `gh-<login>` (empty, private).
- Legacy pre-workspaces session cookies map to the default workspace
  `state-vector` (re-login refreshes the cookie with the workspace segment).

(Optional later: set CF_ACCESS_TEAM + CF_ACCESS_AUD secrets and the same code
switches to Cloudflare Access JWT validation at the edge — both paths ship.)

## 3. Shipper on the EC2 box

```bash
# one-time env (in ~/.hermes/.env so the unit's EnvironmentFile picks it up):
#   FLOWS_INGEST_TOKEN=<same token as step 1>
sed -i "s/REPLACE-SUBDOMAIN/<subdomain>/" ~/flows/packages/adapters/flows-shipper.service
mkdir -p ~/.config/systemd/user && cp ~/flows/packages/adapters/flows-shipper.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now flows-shipper
journalctl --user -u flows-shipper -f        # expect "shipped N: {...}"
```

## 4. Verify end-to-end

```bash
curl -s $URL/api/state | python3 -m json.tool | head      # events present
curl -s -X POST $URL/ingest -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"events":[{"id":"probe:1","source":"probe","kind":"created","ts":'$(date +%s)',"title":"ingest probe"}]}'
# UI: open $URL in browser → GitHub login → decisions/feed/presence live
```

## 5. Webapp (served by the worker, same URL)

The React panel (`packages/webapp`) ships as worker assets — one deploy, one origin, no CORS.
**`packages/webapp/dist` is committed** so the git-integration deploy (plain `wrangler deploy`,
no build step) always has assets; after changing webapp code run:

```bash
npm run build -w @flows/webapp          # → packages/webapp/dist (commit the diff)
```

`wrangler.toml [assets]` serves the SPA at `/` with `run_worker_first` for
`/ingest`, `/api/state`, `/ws`, `/ui`, `/login`, `/logout`. Human auth is the
GitHub OAuth session (`GET /login` → github.com → HMAC cookie); the panel shows
a sign-in banner when unauthenticated, and the ingest token is set in the
panel's ⚙ settings.

## 6. Desktop app (Tauri menubar)

```bash
npm run build -w @flows/desktop         # → src-tauri/target/release/bundle/macos/Bridge.app
```

- Live mode (default): the panel loads the **deployed** URL same-origin; sign in
  with GitHub in the banner when prompted (cookie persists in the webview). Remote-URL IPC is allowed via
  `src-tauri/capabilities/remote-hub.json` (notifications + panel commands).
- Offline/demo: settings (⚙) → mode `mock` + `npm run hub -w @flows/webapp`.
- Notification buttons (Unblock / Done) answer decisions by POSTing to `/ingest`
  with the token stored in the app's settings. First launch of the .app: grant
  notification permission.


## Rollback / kill switch

- `wrangler delete` removes the worker + DO state.
- `systemctl --user disable --now flows-shipper` stops publishing.
- No DNS, no VPC, no inbound holes on the box at any point (outbound POSTs only).
