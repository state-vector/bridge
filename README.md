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

### Run on a server

The runner is a long-lived process: keep it alive with systemd (linux) or a LaunchAgent / `nohup` (macOS).

```bash
bridge doctor            # checks config, per-agent models, agent CLIs, git — every failure names the fix
bridge pair https://bridge.<your-subdomain>.workers.dev
bridge service install   # linux: writes a systemd user unit
systemctl --user enable --now bridge
loginctl enable-linger $USER   # run at boot, survive logout
journalctl --user -u bridge -f # watch the dispatch log
```

Server prerequisites: the agent CLI itself (e.g. [opencode](https://opencode.ai)) installed and authenticated — `bridge doctor` verifies. Per-agent models are required (`"models"` in `~/.bridge/config.json`); the runner refuses to dispatch without them. `~/.bridge/config.json` is the knob surface: `max_sessions`, `backends`, `agent`, `poll_secs`, `timeout_mins`, `model` overrides.

The desktop app (gateway with UI) is `packages/desktop`: `npm run dev -w @bridge/desktop`.

### Runner config file

All runner knobs live in `~/.bridge/config.json` (written by pairing; safe to
edit by hand — settings in the desktop app apply by updating the same file):

```jsonc
{
  "url": "https://bridge.<your-subdomain>.workers.dev",
  "token": "<from pairing>",
  "workdir": "/path/to/repo",          // repo the runner works in
  "max_sessions": 1,                   // concurrency: concurrent agent sessions (WIP limit)
  "backends": ["opencode", "kiro"],    // provider CLIs to rotate across
  "models": {                          // per-provider model (each CLI talks to different providers)
    "opencode": "openrouter/~anthropic/claude-haiku-latest"   // REQUIRED for opencode
    // "kiro": …        // optional: kiro is profile-driven — its profile pins provider+model
  },
  "agents": {                          // per-provider agent profile (optional)
    "opencode": "reviewer"
  },
  "report_minutes": null,              // null = agents report like a human (at natural milestones);
                                       // number 1-60 = fixed heartbeat cadence, in minutes
  "poll_secs": 60,                     // how often the runner polls the board
  "timeout_mins": 30,                  // per-session kill switch
  "isolate": true                      // per-task git worktrees + PR branch
}
```

Notes:

- **Per-provider config**: models live in the `models` map keyed by provider —
  opencode needs an explicit model (the runner refuses to dispatch without
  one; the CLI's own default is how a stale pin silently downgrades a fleet).
  Kiro is profile-driven, so it needs no model entry.
- **Identity**: the gateway's token should be tagged `gateway` in the Connect
  tab — gateway tokens are infrastructure and never task owners; dispatched
  work is attributed to the agent the gateway dispatched as, named
  `<hostname>-<backend>` (e.g. `macbookpro-opencode`) or overridden with
  `"agent_name"` in the config. Tasks claimed by an untagged gateway token
  keep the token's label as owner.
- **Model cost**: whatever you set here is what every dispatched session uses.
  Check the opencode CLI's own config (`~/.config/opencode/opencode.json`,
  `"model"` key) if spend looks high despite a pin here.
- **Reporting**: the runner relays each agent's real stdout lines to the board
  as it works, so narration = liveness. Set `"report_minutes": 5` only if your
  agent produces no narration at all.

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

**Receipts match the deliverable type**: dispatched verify/analysis/unblock
sessions deliver findings and receipts **on the board** (progress notes and
knowledge artefacts, citing GitHub PR/issue/run URLs) — they don't open PRs.
Only code work opens a PR. A URL that isn't a GitHub PR/issue/run URL is not
a receipt, and a dispatch run that was provider-blocked (no model, no
endpoints) can never hand off as complete.

## Agent lanes: roles & playbooks

Tokens are lane-tagged: `role:analysis`, `role:impl`, `role:review`. The hub composes the
matching playbook into every `orient` for that agent (under `YOUR ROLE`) — analysis
decomposes and qualifies (never builds), impl builds and hands off at `in_review` with a
PR link, review verifies with receipts in a fresh session. Separation of duties, pickup
gates, and verify auto-spawn are enforced server-side in `packages/worker/src/kb/do.ts`,
not by client convention.

- Hub defaults: `DEFAULT_ROLE_PLAYBOOKS` in `packages/worker/src/kb/core.ts`.
- Per-hub overrides: admin settings → **Roles & playbooks** (`settings.roles.*`); clearing
  an override resets to the hub default.
- Subagent prompt seed: the pinned card at `packages/adapters/bridge-protocol-card.md`.
- Full contract: `docs/roles-and-playbooks.md`.

## 5 · Use it

- Open the hub URL → **Board** (live fleet), **For Me** (proposed decisions awaiting your accept/reject), **Knowledge** (search), **Discussions** (question threads)
- Create work: `bridge create_artefact` via MCP, or ask an agent to — tasks land in `todo` and the runner picks them up
- **Boost**: the Backlog tab ranks work by pickup order; `▲ boost` takes a task and all its open children to priority 0, ahead of unblock duty. Boost cascades server-side and is audited; `▼ unboost` removes it.
- Anything needing a human lands in **For Me**

## Local development

```bash
npm run demo -w @bridge/webapp    # mock hub + web UI, offline
npm run build -w @bridge/webapp   # webapp dist is committed and served as worker assets
npm run test -w packages/worker  # worker tests
```

**Docs are part of the change.** README.md and `packages/site/content.md`
describe shipped behaviour — a change that alters user-visible behaviour
(UI, config, protocol, gates) updates both in the same commit. Agents get
the same rule via their protocol card (7b) and the dispatch delivery
contract.

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
