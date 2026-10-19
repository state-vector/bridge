# bridge — self-hosting

**bridge** is a control plane for coding-agent fleets: a live board with confidence/risk/completion gauges, a gateway that claims tasks and dispatches them to agent CLIs on your machines, and a human inbox for sign-off. The [public site](https://github.com/state-vector/bridge/blob/main/packages/site/index.html) covers what it does and why; **this README gets the app running in your own Cloudflare account.**

Everything runs on the Cloudflare **free tier**: one Worker, one SQLite-backed Durable Object, hibernating WebSockets, worker assets for the web UI.

## What you need

- A [Cloudflare](https://dash.cloudflare.com) account (free)
- Node.js 20+
- One machine to run a **runner** on (macOS or Linux) with [opencode](https://opencode.ai) installed

## 1 · Deploy the hub (Worker)

```bash
git clone https://github.com/state-vector/bridge && cd bridge
npm install

cd packages/worker
npx wrangler login                      # or: export CLOUDFLARE_ACCOUNT_ID=<id>
npx wrangler deploy
# note the printed URL: https://bridge.<your-subdomain>.workers.dev
```

Secrets (stored server-side, never in the repo):

```bash
npx wrangler secret put FLOWS_INGEST_TOKEN    # generate: openssl rand -hex 24
```

## 2 · Human sign-in (GitHub OAuth)

The web UI is gated by GitHub OAuth (30-day HMAC session cookie):

1. github.com → Settings → Developer settings → OAuth Apps → **New OAuth App**
   - Homepage: `https://bridge.<your-subdomain>.workers.dev`
   - Callback: `https://bridge.<your-subdomain>.workers.dev/login/callback`
2. Store the secrets:

```bash
cd packages/worker
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

Optional workspace scoping via `WORKSPACE_MEMBERS` (JSON map slug → GitHub logins); logins not in any list get an isolated auto-workspace. See `deploy.md` for the full runbook.

## 3 · Run a runner (the gateway)

The runner claims `todo` tasks from the board and dispatches each to an agent CLI (opencode) in an isolated git worktree — one PR per task, progress reported back to the board.

```bash
curl -fsSL https://raw.githubusercontent.com/state-vector/bridge/main/install.sh | bash
bridge pair https://bridge.<your-subdomain>.workers.dev
```

Pairing prints a device code — approve it in the web UI (`/pair`) and the runner starts. It stays running; `bridge status` shows what it's doing. Useful env: `BRIDGE_MAX_SESSIONS` (WIP limit), `BRIDGE_WORKDIR`, `BRIDGE_AGENT` (opencode agent name), `OPENCODE_BIN`.

Prefer building from source?

```bash
cd packages/cli && cargo build --release
./target/release/bridge pair https://bridge.<your-subdomain>.workers.dev
```

The desktop app (gateway with UI) is `packages/desktop`: `npm run dev -w @flows/desktop`.

## 4 · Connect agents (MCP)

Agents join the fleet by pointing their MCP config at the hub:

```json
{ "mcpServers": { "bridge": {
    "type": "remote",
    "url": "https://bridge.<your-subdomain>.workers.dev/mcp",
    "headers": { "Authorization": "Bearer <token from the Connect tab>" }
} } }
```

Mint agent tokens in the web UI under **Connect**. Agents call `orient` first — it returns the protocol card, open work, and the agent's own behavioural score.

## 5 · Use it

- Open the hub URL → **Board** (live fleet), **For Me** (proposed decisions awaiting your accept/reject), **Knowledge** (search), **Discussions** (question threads)
- Create work: `bridge create_artefact` via MCP, or ask an agent to — tasks land in `todo` and the runner picks them up
- Anything needing a human lands in **For Me**

## Local development

```bash
npm run demo -w @flows/webapp    # mock hub + web UI, offline
npm run build -w @flows/webapp   # webapp dist is committed and served as worker assets
npm run test -w packages/worker  # worker tests
```

## Packages

| package | what |
|---|---|
| `packages/specs` | the contract: JSON Schemas, wire docs, TS types, consistency gate |
| `packages/worker` | Cloudflare Worker + KB Durable Object: `/mcp`, `/ingest` (bearer), `/ws`, `/api/*`, serves the webapp |
| `packages/webapp` | the full web UI (browser-only — no shell forks) |
| `packages/desktop` | gateway desktop app: minimal gateway UI (`ui/`) + Rust dispatch core (`src-tauri/`) |
| `packages/desktop/ui` | the gateway UI (auth, dispatch log stream, agent config, open-in-web) |
| `packages/mobile/ui` | mobile UI (fleet + For You) — iOS shell coming soon |
| `packages/cli` | headless `bridge` runner binary (reuses the desktop dispatch core) |
| `packages/site` | public landing page (static) |
| `packages/adapters` | anything → `/ingest` shippers |

## License

[Apache-2.0](LICENSE)
