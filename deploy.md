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

**Model registry — REMOVED (BR#4252).** There is no hub-side model list and
no model gateway: the hub never proxies inference — each agent CLI resolves
its pinned model id against its own provider config. The former `/v1/models`
route and its `MODEL_IDS` var are deleted; `bridge doctor` reports model
pins as configuration only and does not validate them against the hub. Do
not re-add either (the route shipped with an empty registry and FAILed every
valid pin fleet-wide).

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

Without this secret, only allowlisted + **invited** GitHub logins can sign in (default deny).
Set a comma-separated allowlist to limit access, or `*` to leave the hub open to any GitHub
account. Beyond the allowlist, invitations are the self-serve second door: any workspace
member invites/removes members by GitHub username (👥 in the web top bar), and an invited
login can sign in even when not allowlisted. Everyone holds the same rights; the workspace
creator cannot be removed.

```# rotate = re-put (also invalidates all session cookies — they're HMAC-signed with the secret)
npx wrangler secret delete BRIDGE_UI_PASSWORD   # if the old shared password was set
```

**Workspace scoping.** Every human session is scoped to one workspace slug —
its own DOs (`ws:<slug>`), so users only see content from their workspace:

- Membership is registry-backed (SQLite in the DO): members are invited or
  removed at runtime by GitHub username from the web UI — no secret edits,
  no redeploys. An invited login gets an isolated personal workspace plus the
  workspaces they were invited to.
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
ledger action + age) — the hub distinguishes a live holder from a zombie and enforces
it (BR#4129): on a non-empty queue a note frozen past 10 minutes denies the renewal and
expires the lease for the next gateway.

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

## 8 · Hub self-canary (BR#4177) — daily, red alarm to the sink

The deployed hub gets a synthetic end-to-end canary: duty spawn→delivery,
flip-on-event, train-queue visibility (BR#4079 contract), reconcile accounting
(BR#4170). One command, cron-friendly, red files a deduped ask to the alarm sink
(`train_alarm_sink_id`, default BR#3124):

```bash
export BRIDGE_URL=https://bridge.<your-subdomain>.workers.dev
export BRIDGE_TOKEN=<token from the Connect tab>
~/.local/bin/bridge canary        # one pass: exit 0 green · 1 red (alarm filed) · 2 config
```

Daily schedule — launchd on macOS (`~/Library/LaunchAgents/bridge.canary.plist`,
`StartCalendarInterval` hour 6) or cron anywhere
(`0 6 * * * ~/.local/bin/bridge canary >> ~/.bridge/canary.log 2>&1`).
Reds page the bridge lane via the sink ask; **greens matter too** — every run stamps
a `[hub-canary]` progress artefact, and 48h of silence on that feed means the canary
itself is dead. Fixtures self-clean (tagged `[canary]`, retired to `blocked` with an
inert 30-day timer; at most two inert fixtures accumulate per run). See README
("The hub self-canary") for the four legs and what each one catches.

## Rollback / kill switch

- `wrangler delete` removes the worker + DO state.
- `systemctl --user disable --now flows-shipper` stops publishing.
- No DNS, no VPC, no inbound holes on the box at any point (outbound POSTs only).
