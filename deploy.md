# Deploy runbook — flows POC

Prereqs: Cloudflare account `013b6a2b6f3dfb6c8d48657769681087`, Zero Trust enabled,
Access application created for the workers.dev hostname (AUD `02bf2012058821d837180e16d3146cc0`).

## 1. Worker

Two paths — CI is the default:

- **Push to `main`** touching `packages/worker/**` or `packages/specs/schemas/**` →
  GitHub Actions runs the specs gate then `wrangler deploy` (uses the
  `CF_API_TOKEN` repo secret). Watch: `gh run watch` or the Actions tab.
- **Manual, from the box:**

```bash
cd ~/flows/packages/worker
export CLOUDFLARE_API_TOKEN=<token>   # already in GH secrets for CI
npx wrangler deploy
# note the printed URL: https://flows.<subdomain>.workers.dev
```

Secrets (not in wrangler.toml):

```bash
npx wrangler secret put FLOWS_INGEST_TOKEN   # generate: openssl rand -hex 24
npx wrangler secret put CF_ACCESS_TEAM       # https://<team>.cloudflareaccess.com
npx wrangler secret put CF_ACCESS_AUD        # 02bf2012058821d837180e16d3146cc0
```

## 2. Cloudflare Access (dashboard, one-time)

- Zero Trust → Access → Applications → self-hosted →
  domain: `flows.<subdomain>.workers.dev` (or one-click: Workers → flows →
  Settings → Domains → Enable Cloudflare Access)
- Policy: Include → Emails → ray@…, grace@… (Google or GitHub login)
- Save. Test: incognito window → URL → should bounce to IdP.

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
# UI: open $URL in browser → Access login → decisions/feed/presence live
```

## Rollback / kill switch

- `wrangler delete` removes the worker + DO state.
- `systemctl --user disable --now flows-shipper` stops publishing.
- No DNS, no VPC, no inbound holes on the box at any point (outbound POSTs only).
