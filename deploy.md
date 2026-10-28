# Deploy runbook — bridge

Prereqs: your Cloudflare account, Zero Trust enabled,
Access application created for the workers.dev hostname (AUD from the Access app).

## 1. Worker

Deploys are **push-to-main** — Cloudflare's git integration builds and ships the worker on every push to `main`. Local `npx wrangler deploy` from the box still works for out-of-band fixes. Do NOT wire GitHub Actions deploys. CI, when added, is for tests only. **The hub needs no GitHub token** (BR#3516): every GitHub fact is fed to it by the merge-train executor running on your own machine (section 7) — a legacy `GH_TOKEN` secret on the worker is inert and can be deleted.

```bash
cd ~/bridge/packages/worker
export CLOUDFLARE_API_TOKEN=<token>
npx wrangler deploy
# note the printed URL: https://bridge.<your-subdomain>.workers.dev
```

Secrets (not in wrangler.toml):

```bash
npx wrangler secret put BRIDGE_INGEST_TOKEN   # generate: openssl rand -hex 24 (legacy FLOWS_INGEST_TOKEN still accepted)


```

**Model registry (`GET /v1/models`).** The hub serves its dispatchable model
ids at `/v1/models` in OpenAI shape (`{"object":"list","data":[{"id":...}]}`);
`bridge doctor` resolves every pinned backend model against it (a pinned id
the registry doesn't list would fail every dispatch, so it's a named FAIL).
The registry IS the `MODEL_IDS` var in `packages/worker/wrangler.toml`
`[vars]` — comma-separated, e.g. `MODEL_IDS = "sp-gateway/glm-5.3-flash,glm-4.7"`.
Set it in the file, not the dashboard: this file is the deploy truth and a
push clobbers dashboard-only vars. Empty/unset = an honest empty list (every
pinned model FAILs until you set it). The route is deliberately
unauthenticated machine-plane (like `/api/pair/*` — doctor runs when pairing
is broken) and MUST stay listed in `run_worker_first`: a route missing from
that list is silently eaten by the SPA assets layer (BR#3885 — third
incident of this class).

## 2. Human-plane auth (GitHub OAuth)

Sign-in is GitHub OAuth: `GET /login` → github.com → `GET /login/callback` →
HMAC session cookie (30d), signed with `GITHUB_CLIENT_SECRET`. Anyone with a
GitHub account can sign in (public app).

1. github.com → Settings → Developer settings → OAuth Apps → **New OAuth App**:
   - Homepage: `https://<your-subdomain>.workers.dev`
   - Callback: `https://<your-subdomain>.workers.dev/login/callback`
2. Store the secrets:

```bash
cd ~/bridge/packages/worker
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

Access gate (default deny):

```bash
npx wrangler secret put GITHUB_ALLOWED_USERS   # e.g. "rayh" or "*" for any GitHub account
```

Without this secret, NO GitHub login can sign in (default deny). Set a comma-separated
allowlist to limit access, or `*` to leave the hub open to any GitHub account. Workspace
scoping (WORKSPACE_MEMBERS) is a second, finer gate on top.

```# rotate = re-put (also invalidates all session cookies — they're HMAC-signed with the secret)
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
#   BRIDGE_INGEST_TOKEN=<same token as step 1>
sed -i "s/REPLACE-SUBDOMAIN/<subdomain>/" ~/bridge/packages/adapters/flows-shipper.service
mkdir -p ~/.config/systemd/user && cp ~/bridge/packages/adapters/flows-shipper.service ~/.config/systemd/user/
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
npm run build -w @bridge/webapp          # → packages/webapp/dist (commit the diff)
```

`wrangler.toml [assets]` serves the SPA at `/` with `run_worker_first` for
`/ingest`, `/api/state`, `/ws`, `/ui`, `/login`, `/logout`. Human auth is the
GitHub OAuth session (`GET /login` → github.com → HMAC cookie); the panel shows
a sign-in banner when unauthenticated, and the ingest token is set in the
panel's ⚙ settings.

## 6. Desktop app (Tauri menubar)

```bash
npm run build -w @bridge/desktop         # → src-tauri/target/release/bundle/macos/Bridge.app
```

- Live mode (default): the panel loads the **deployed** URL same-origin; sign in
  with GitHub in the banner when prompted (cookie persists in the webview). Remote-URL IPC is allowed via
  `src-tauri/capabilities/remote-hub.json` (notifications + panel commands).
- Offline/demo: settings (⚙) → mode `mock` + `npm run hub -w @bridge/webapp`.
- Notification buttons (Unblock / Done) answer decisions by POSTing to `/ingest`
  with the token stored in the app's settings. First launch of the .app: grant
  notification permission.


## 7 · Merge-train executor (BR#3516, gateway-native since BR#4104)

The hub holds **no VCS credentials** — every GitHub fact is fed to it by the merge-train
executor running on your own machines. Since BR#4104 the executor is **part of the
gateway**: the desktop app and the headless `bridge` runner both spawn the train tick
beside their dispatch loop (own thread, 45s default cadence). Any gateway on a stock
build is an opportunistic executor — the per-lane CAS lease (5-minute TTL) picks the
holder; a crashed or sleeping gateway's lease lapses and the next gateway reconciles
from live GitHub state. There is **nothing to hand-install**: no systemd unit, no
`~/.local/train-bin` — the train updates ride the normal gateway deploy path. (Retired
2026-10-28: cody's hand-installed `merge-train-bridge` / `merge-train-super` units on
ip-172-31-1-230 — disable them with
`systemctl --user disable --now merge-train-bridge merge-train-super` if still present.)

```bash
# prerequisites — `bridge doctor` checks each and names the fix:
#   gh authed WITH the `repo` scope   (fix: gh auth refresh -h github.com -s repo)
#   git (the executor is native — ships inside the gateway binary; no Node)
# that's it: the running gateway IS the train.
```

Identity law (BR#3181, enforced in-process): the tick probes its gh identity class
before any GitHub write — merge / update-branch / close legs execute only under the
worker-class credential (default `detached-cody`). A personally-authed gateway (e.g.
rayh's keyring gh) still reconciles and reports, then refuses the write legs LOUDLY and
releases the lease for a worker gateway. Lease renewals carry proof-of-progress (last
ledger action + age) — the hub can distinguish a live holder from a zombie.

Standalone mode (headless boxes without the runner, cron): the same module runs as
`bridge train [--once]` — see README ("The merge train") for the full env/flag table.

Optional env (both modes): `MERGE_TRAIN_ENABLED=0` (kill switch for the daemon leg),
`MERGE_TRAIN_INTERVAL_SECS` (default 45), `MERGE_TRAIN_HOLDER` (lease label, default
`merge-train@<gateway-label|host>`), `MERGE_TRAIN_LANES` (comma-sep `repo@base`
allowlist; default every lane the hub reports), `MERGE_TRAIN_WORKDIR` (fixed clone;
default managed clone cache `~/.bridge/train/<owner>/<repo>`), `MERGE_TRAIN_METHOD`
(`merge | squash | rebase`, default `merge`), `MERGE_TRAIN_WORKER_IDENTITIES`
(worker-class gh logins, default `detached-cody`).

Lane config (required workflows + typical CI minutes) lives in admin settings
(`train_lane`, a JSON map keyed `"repo@base"`; the executor/operator refreshes it in
place via `train.lane`); stop-the-line asks land on the card in `train_alarm_sink_id`
(default BR#3124). The lease / carry / bounce / stop-the-line contract is in README
("The merge train").

## Rollback / kill switch

- `wrangler delete` removes the worker + DO state.
- `systemctl --user disable --now flows-shipper` stops publishing.
- No DNS, no VPC, no inbound holes on the box at any point (outbound POSTs only).
