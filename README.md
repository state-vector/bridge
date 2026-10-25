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

Pairing prints a device code — approve it in the web UI (`/pair`) and the runner starts. It stays running; `bridge status` shows what it's doing. Useful env: `BRIDGE_MAX_SESSIONS` (WIP limit), `BRIDGE_WORKDIR`, `BRIDGE_AGENT` (opencode agent name), `OPENCODE_BIN`. When approving, tick **this device is a gateway** — the gateway identity is labelled with the hostname slug (e.g. `macbookpro`) and tagged with the gateway class, which Connect lists under Gateways with the agents it dispatched, separate from your interactive agents.

Prefer building from source?

```bash
cd packages/cli && cargo build --release
./target/release/bridge pair https://bridge.<your-subdomain>.workers.dev
```

Living on the edge? Every push to `main` rebuilds the binaries into a rolling **dev** pre-release (`releases/latest` and plain `install.sh` never see it):

```bash
curl -fsSL https://raw.githubusercontent.com/state-vector/bridge/main/install.sh | bash -s -- dev
```

### Run on a server

The runner is a long-lived process: keep it alive with systemd (linux) or a LaunchAgent / `nohup` (macOS).

```bash
bridge doctor            # checks config, per-agent models, agent CLIs, git — every failure names the fix
bridge pair https://bridge.<your-subdomain>.workers.dev
bridge service install   # linux: writes a systemd user unit
systemctl --user enable --now bridge
```

**Headless log view** — everything the fleet did, same event feed the webapp's Log view renders:

```bash
bridge logs                 # last 30 events, oldest → newest (age · actor · op · task · detail)
bridge logs --limit 100     # deeper
bridge logs -f              # follow — polls every 5s, prints new events live
bridge logs --task BR#123   # filter to one artefact
bridge logs --json          # raw JSON for scripts
```

The unit logs to `~/bridge.log` (both streams, `append:`) instead of the journal — user journals are unreadable on many minimal cloud images (journald `Storage=volatile`, or the session predates linger), so `journalctl --user` dead-ends there while the service itself runs fine. It also bakes the install shell's `PATH` into the unit (with the configured agent CLIs' dirs first): systemd's minimal default PATH misses `~/.local/bin`, which left agent CLIs unrunnable under the service. Re-run `bridge service install` after moving agent CLIs, or set `PATH` in `~/.bridge/env` to override.

Server prerequisites: the agent CLI itself (e.g. [opencode](https://opencode.ai)) installed and authenticated — `bridge doctor` verifies. Per-agent models are required (`"models"` in `~/.bridge/config.json`); the runner refuses to dispatch without them. `~/.bridge/config.json` is the knob surface: `max_sessions`, `backends`, `agent`, `poll_secs`, `timeout_mins`, `model` overrides.

The desktop app (gateway with UI) is `packages/desktop`: `npm run dev -w @bridge/desktop`.

**One rendering path.** The web UI and the desktop shell render the *same*
view components (Top, Backlog, Completed, task detail with dep graph and
live work tree) from the shared kit `@bridge/ui-kit`, over the same data
layer — the desktop opens a live WebSocket to the hub with its paired
gateway-class token (bearer on `/api/kb/*` + `/kb-ws`; admin routes stay
cookie-only), so both surfaces always look and update identically.

Beyond dispatch it carries three human-facing surfaces:

- **For you + Chat** — the decision inbox (proposed decisions, blocked work, open questions, read-only) and a console chat: ask about the board in natural language. Retrieval runs over the hub (`/api/kb-machine/search`, paired token); the answer is summarised by **Apple's on-device model** (macOS 26+ with Apple Intelligence) and falls back to the configured backend CLI one-shot otherwise. The console never claims or writes work.
- **Decision notifications** — the app watches the inbox and raises an OS notification whenever a new proposed decision arrives (the click jumps to For you). Verify-verdict notifications state the ask ("Accept verification of BR#X? — verdict PASS"), not the raw receipts title. No runner required.
- **Guided sign-back-in** — if the run gate signs the desktop out (the identity law reserves gateway dispatch for gateway-class tokens: a pre-gateway token surviving an app upgrade, or a token the hub rejects), the sign-in screen says so in plain language — what happened, that nothing was lost (hub URL and settings are kept), and that signing back in is one click: the browser opens itself, and the vended gateway-class token re-associates with the same stable device id. Legacy board rows keep their labels; only this device's token rotates.

### Runner config file

All runner *knobs* live in `~/.bridge/config.json` (written through a single
atomic save; safe to edit by hand — settings in the desktop app apply by
updating the same file). **Credentials never live there**: the gateway token
is stored in the OS keychain (data-protection keychain on signed macOS
builds; `~/.bridge/gateway-token`, mode 0600, on unsigned dev builds and
Linux), and the device principal is write-once at `~/.bridge/principal`
(0600) — `bridge reset-principal` is the only local clear. The principal is
the device credential and anchors identity: the hub vends it on first pairing
(24 random bytes, generated once, never regenerated), the device presents it
on every pairing and desktop login, and re-pairing or re-login rotates the
gateway token in place against it — the hostname is a display label only:

```jsonc
{
  "schema_version": 2,                 // written by the runner; future versions warn
  "url": "https://bridge.<your-subdomain>.workers.dev",
                                       // no "token" — the keychain owns it
  "workdir": "/path/to/repo",          // repo the runner works in
  "max_sessions": 1,                   // concurrency: concurrent agent sessions (WIP limit)
  "backends": {                        // provider sections — each carries its own config
    "opencode": {                      // model optional: unset = opencode's own default config
      "model": "openrouter/~anthropic/claude-haiku-latest",
      "agent": "reviewer",             // optional agent profile
      "bin": "/home/me/.local/bin/opencode", // CLI binary override — ABSOLUTE path strongly
                                             // recommended under systemd (minimal PATH)
      "mode": "acp"                    // transport: "acp" (default, live session updates) | "stdio"
    },
    "kiro": {                          // profile-driven: the kiro profile pins provider+model
    }
  },
  "report_minutes": null,              // null = agents report like a human (at natural milestones);
                                       // number 1-60 = fixed heartbeat cadence, in minutes
  "poll_secs": 60,                     // how often the runner polls the board
  "timeout_mins": 30,                  // per-session kill switch
  "isolate": true,                     // per-task git worktrees + PR branch (default true)
  "worktree_exempt_repos": []          // repos where per-task worktrees are skipped
                                       // (webapp-only checkout class); env override:
                                       // BRIDGE_WORKTREE_EXEMPT_REPOS (comma-separated)
}
```

If the hub rejects the token (401), the runner attempts **one** automatic
repair (re-vend via the live login session) and, failing that, logs out
loudly with a human-readable reason — the token never silently vanishes.

If no agent CLI is dispatchable, the runner says so loudly every tick and **exits non-zero once in-flight sessions drain** — `systemctl status bridge` shows the failure and `Restart=on-failure` retries every 10s until you fix it (`bridge doctor` diagnoses). Under systemd, use absolute `bin` paths or a `PATH` override for the unit: the service does not inherit your shell's PATH.

Notes:

- **Per-provider config**: models live in the `models` map keyed by provider —
  opencode needs an explicit model (the runner refuses to dispatch without
  one; the CLI's own default is how a stale pin silently downgrades a fleet).
  Kiro is profile-driven, so it needs no model entry.
- **Identity**: gateways and agents share one label namespace with a class
  boundary — gateway tokens are infrastructure labelled with the hostname slug
  (e.g. `macbookpro`) and tagged with the gateway class; they are never task
  owners, and agent labels (`opencode-ray`) never take the gateway tag. The
  boundary is enforced at mint, pairing, rename and
  tag-edit time: a mis-named token is rejected, not rendered wrong. Connect
  shows gateways with the agents they dispatched, attributed agents nested
  under their gateway. Dispatched work is attributed to the agent the gateway
  dispatched as, named `<hostname>-<backend>` (e.g. `macbookpro-opencode`) or
  overridden with `"agent_name"` in the config. Legacy tokens keep their
  labels — the boundary is enforced by the gateway tag on the token, never
  by the name.
- **Model cost**: whatever you set here is what every dispatched session uses.
  Check the opencode CLI's own config (`~/.config/opencode/opencode.json`,
  `"model"` key) if spend looks high despite a pin here.
- **Reporting**: the runner relays each agent's real stdout lines to the board
  as it works, so narration = liveness. Set `"report_minutes": 5` only if your
  agent produces no narration at all.

## 4 · Connect agents (MCP)

Agents join the fleet by pointing their MCP config at the hub. The config
format is per-client — the Connect tab's **setup** modal emits the right
snippet with your token slotted in.

**opencode** — add an `mcp` entry to `~/.config/opencode/opencode.json`
(note: the key is `mcp`, *not* `mcpServers` — opencode silently ignores the
latter, and an agent with no bridge tools will waste its run hunting for a
CLI):

```json
{ "$schema": "https://opencode.ai/config.json",
  "mcp": { "bridge": {
      "type": "remote",
      "url": "https://bridge.<your-subdomain>.workers.dev/mcp",
      "enabled": true,
      "oauth": false,
      "headers": { "Authorization": "Bearer <token from the Connect tab>" }
} } }
```

`oauth: false` matters for headless use: without it opencode tries a browser
OAuth flow when the hub returns a 401, which hangs a dispatched session.

**Generic `mcpServers` clients** (claude code and similar):

```json
{ "mcpServers": { "bridge": {
    "type": "http",
    "url": "https://bridge.<your-subdomain>.workers.dev/mcp",
    "headers": { "Authorization": "Bearer <token from the Connect tab>" }
} } }
```

Verify with `opencode mcp list` — `bridge` should list the board tools.
Config is merged per-server-key, so the bridge entry coexists with any other
MCP servers the host already uses.

Dispatch hosts: the runner spawns `opencode run` as a child process, so the
agent CLI resolves **its own ambient config** — a dispatch host needs this
entry for whichever CLI the runner drives, or dispatched sessions start
toolless.

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

**Verify is the merge authority** (standing order BR#3033). The verify round enforces
mergeability (main-green gate, checks green, GitHub-verified signatures), reviews substance,
and — when both hold — **merges the PR itself**, citing the merge sha in its done receipts.
There is no separate human merge gate for a verified PR. The cycle is: impl works → rebases
→ pushes a mergeable PR → `in_review`; verify picks it up (rank 0), reviews substance AND
mechanics; problems found → bounce back to impl with findings (`in_review → in_progress`,
one round, N bounces — the same verify round re-enters, it never stacks); loop until verify
merges and closes. Impl owns mergeability *preparation* (rebase before every in_review — a
conflicting PR is the impl's defect, not the reviewer's); verify owns mergeability
*enforcement* (confirm, then merge).

- Hub defaults: `DEFAULT_ROLE_PLAYBOOKS` in `packages/worker/src/kb/core.ts`.
- Per-hub overrides: admin settings → **Roles & playbooks** (`settings.roles.*`); clearing
  an override resets to the hub default.
- Subagent prompt seed: the pinned card at `packages/adapters/bridge-protocol-card.md`.
- Full contract: `docs/roles-and-playbooks.md`.

On **tasks**, roles live in a dedicated `roles` column — `create_artefact { roles: ["review"] }` —
never in tags. `tags` are 100% free-form user/agent labels (themes like `gtm`, `deploy-train`,
`pricing`): they render as chips and drive the filterable theme bar in Top and Backlog, but they
never change system behaviour — tagging a task `role:review` does nothing. **Questions are their
own artefact type** (`type: "question"`; asks create them automatically): open participation,
answered via the ask band or progress entries, closed to done/superseded — never claimed.

## The ask contract: asks are question nodes

`ask_agent` writes no side table — the ask **is** a question task: a BR#-numbered
`type: "question"` node, `child_of` the subject task when you pass `artefact_id`. The
subject goes `blocked`, the watchdog pauses for it, and an answer auto-resumes it back to
`in_progress`. Three fields are the whole contract, enforced server-side (`askCreate` /
`askAnswer` in `packages/worker/src/kb/do.ts`):

- **`question` — the summary.** One answerable sentence ending in `?`, ≤240 chars; it becomes
  the node title. Status reports are rejected at the door — receipts and narrative go in `details`.
- **`reason` — the why_escalated.** Mandatory on human-directed asks (rejected without it):
  one sentence on why this is escalated instead of automatic — the gate, credential or
  authority it waits on. ≤400 chars.
- **`options` — the decision.** 2–8 one-click answers (rejected with fewer): the recorded
  click is the answer, and it closes the question `done`.

Asks carry ordinary BR# ids, so refs linkify wherever BR# refs render (cards, task detail —
`TASK_REF_RE` in `packages/ui-kit/src/server/views.ts`) and resolve via `get_artefact` like
any artefact. `answer_ask` takes the question node's BR# id — there are no separate `ASK-*`
artefact ids. Humans answer in the app: the ask band in Top (web + desktop) renders every
open ask with its options as one-click buttons. `urgency` is an ask vocabulary, not a
sentiment: `"time-sensitive"` renders the urgent NOW chip in the ask band; anything else is
normal — agents can no longer file an "urgent" ask that renders as a quiet one.

**Claim locally** — next to **Reframe** on every open ask (both surfaces: the ask band
rows in Top and TaskDetail's AskSelfCard), a **Claim locally** button copies a
ready-to-paste takeover prompt for a local interactive agent (e.g. an opencode/claude
session on your machine): the target card (id, title, status, owner, part_of, github ref),
the card body (acceptance/spec) plus the latest progress note, ask context when present
(reason, options), and the full takeover protocol — orient with a unique session, verify
state first-hand (work may be partially done), claim via transition, heartbeat ≤10 min,
shared-checkout discipline (worktree off fresh origin/main, explicit-path staging, never
`git add -A`), commit+sign as detached-cody (canonical invocation inline), finish = PR +
in_review, verify separation, human legs escalate to you. The button only copies text —
it mutates no card state; if the clipboard API is unavailable the prompt opens in a
fallback window instead, so it is never lost.

## Destination-green: the stop-the-line gate

Merges must not land while the destination branch is red — accepted decision BR#3009 makes
that law, and BR#3008 makes it mechanical instead of discipline. Two halves, same rule:

- **The block**: every PR runs the required `main-green gate` check
  (`.github/workflows/main-green-gate.yml` + `scripts/main-green-gate.sh`). It reads the
  check runs on main's HEAD (`gh api repos/<repo>/commits/<sha>/check-runs`): any failure
  (or a check still running, or no check runs at all) fails the gate and GitHub refuses
  the merge via the `main: main-green gate required` ruleset. The newest run per check
  judges; a cancelled run says nothing. The one exception is written into the gate: a PR
  green on the *exact* checks main fails passes with a printed **REMEDIATION CARVE-OUT**
  receipt — BR#3009's remediation-merge path, expressible and receipted, not a loophole.
- **The alert**: the hub watchdog sweep (`stopTheLineSweep` in
  `packages/worker/src/kb/do.ts`, paced by the `stop_line_sweep_minutes` setting, default
  5 min, `0` = off) reads the same public API and, when main is RED, files ONE
  time-sensitive ask to you per red episode — deduped per main-HEAD sha under the
  `ALARM SINK` board card, so ten PRs seeing one red main produce one ask, not ten. A red
  main pages the board even when nobody opens a PR. The ask carries the **guilty chain**
  (BR#3307): PR · task · verify verdict · agent session · signer class, resolved from the
  provenance index — or an honest "no bridge provenance yet" when the sweep has not stamped
  the merge. `admin.stop_line_sweep` drills it on demand.
- **The work**: the ask is attention; the episode task is the claimable item (BR#3284).
  On RED the sweep also files ONE P0 task per red episode —
  `STOP-THE-LINE: bridge main RED @ <short-sha> — fix main first` — child of the
  `ALARM SINK` card, deduped per main-HEAD sha, and superseding the prior open episode
  task when a new red sha lands (one live episode task at a time). Its body carries the
  red checks with run links, the **first failing sha** and the PR that landed it (a
  bounded bisect walk over recent main history; a failed walk degrades to "bisect
  unavailable" on the card and never blocks the filing), the **guilty chain** from the
  provenance index (BR#3307: PR · task · verdict · session · signer, with an honest
  "no bridge provenance yet" fallback), the remediation carve-out
  (BR#3010 precedent), and the done-when: *main tip all check-runs settled green (0 red,
  0 unsettled) + gate reopened*. The task is boosted — priority 0 in the pickup ranking,
  top of the board's ranked queue, ahead of unblock duty — and tagged
  `p0` / `stop-the-line` / `gtm-blocker`. Fixing main is top-priority work the moment the
  line stops; work on branches (worktrees) continues — only the line stops.

### The deploy drift alarm's settle window (BR#3289)

The `Deploy drift alarm` check (`deploy-check` job in `.github/workflows/ci.yml`, probe logic in
`scripts/deploy-drift-alarm.sh`) compares the live hub's `__version` commit against every main
push. The hub deploys asynchronously (git push → CF Workers Builds), so a first-probe failure read
"main is broken" on every push — 6+ false reds in 24h, each also tripping the `main-green gate`
on the next PR. The alarm now settles first: while the hub still serves an older build it emits
non-failing `::warning::` annotations for up to 10 minutes (`SETTLE_WINDOW_SECONDS`, default 600)
and goes green the moment the hub serves the pushed SHA — or a newer main tip containing it (a
faster merge superseding this push's deploy is not drift; drift is "deployed hub ≠ main tip").
Only a window that elapses stale fails loudly — real drift (CF Builds stalled or bypassed),
feeding the `main-green gate` and `stopTheLineSweep` exactly as before — and so does a hub that
never answers. A failing main-tip lookup never turns a mismatch green (fail-closed). Guarded by
`npm run test:deploy-drift-alarm`.

## The standing merge-queue sweep

The gate blocks bad merges; the sweep executes good ones. Accepted decision BR#3033 made
"merge when green" standing law, and BR#3198 made it deterministic: the hub watchdog runs
`mergeQueueSweep` (`packages/worker/src/kb/do.ts`) FIRST on every tick, paced by the
`merge_sweep_minutes` setting (default 15, `0` = off), and for each open PR on both repos,
oldest first:

1. **Superseded-check first** — a PR whose linked card is superseded closes without review
   (the BR#3034 queue norm).
2. **The 5c mechanical gate** — `mergeable=true`, `mergeStateStatus` clean (or `unstable`
   with only BR#2267 externals failing), every commit GitHub-verified, base (main) green,
   head checks green. Mergeability is a precondition, not a finding.
3. **All green + an accepted verify verdict on the current head** → merge (squash per repo
   norm), merge receipt on the linked card. No human click.
4. **Mechanical defect** (conflicts / red check / base red) → the linked card bounces to
   `in_progress` with the exact defect named — one line per PR, never silent.
5. **Human-leg defects only** (signing-environment / external-mirror failures) → collected
   into ONE class ask per repo per episode, never one per PR (rule 5c).

Identity: the sweep merges as **detached-cody** per BR#3181 — deploy `GH_TOKEN` must be the
detached-cody credential, never rayh's personal credentials. Without it the sweep audits
`no_identity` and merges nothing. `admin.merge_queue_sweep` drills it on demand; the pure
decision rules are pinned in `packages/worker/test/merge-sweep.test.ts`.

## PR provenance: who touched main, from bridge

Every merge is attributable (BR#3287): the hub runs `provenanceSweep` (`packages/worker/src/kb/do.ts`,
paced by `provenance_sweep_minutes`, default 15, `0` = off) over recent merged PRs on both repos
(backfill window `provenance_backfill_days`, default 30) and records, per PR: merge sha, head sha,
the linked task (head branch `bridge/BR-<id>` is the authoritative join key, PR text the fallback),
the accepted verify verdict citing that head, the owning agent **session**, and the signer class
(`detached-cody` / `signed` / `partially-signed` / `unsigned`).

- **Storage of record is the board** (decision BR#3291): the task card carries `meta.provenance`
  (rendered as a provenance strip in TaskDetail, and on the board's Top rows as a PR link +
  verifier badge for in-flight work — BR#3307), the DO keeps a `provenance` index table, and
  `GET /api/kb/provenance?sha=<7-40 hex>` resolves sha → PR → task → verdict → session. Unknown sha
  = honest 404 "no bridge provenance"; merges with no bridge task are recorded as absence — itself a signal.
  The verdict leg is honest too (BR#3307): when no accepted decision cites the head sha (human merges,
  older merges), `verdict_id` is recorded `null` — never an arbitrary stale verdict.
- **Absence renders explicitly** (BR#3287 spec item 3): a Top row with nothing stamped carries a
  muted "no bridge provenance" chip — untracked merge, non-bridge work, or not yet swept. Absence
  is a rendered state, never silence.
- **GitHub mirror is derived and non-authoritative**: the sweep best-effort adds a `bridge:BR-<id>`
  label; nothing machine-facing reads it back.
- Consumers: the red-main guilty-agent attribution loop (BR#3284), humans auditing who landed what,
  and any agent needing receipts. `admin.provenance_sweep` drills/backfills on demand.

## 5 · Use it

- Open the hub URL → **Board** (live fleet), **For Me** (proposed decisions awaiting your accept/reject), **Knowledge** (search), **Discussions** (question threads)
- Create work: `bridge create_artefact` via MCP, or ask an agent to — tasks land in `todo` and the runner picks them up
- **Boost**: the Backlog tab ranks work by pickup order; `▲ boost` takes a task and all its open children to priority 0, ahead of unblock duty. Boost cascades server-side and is audited; `▼ unboost` removes it.
- **Progress gauges persist until updated**: a `log_progress` post that omits gauge fields (`completion_pct`, `confidence_pct`, `risk_pct`, `context_pct`) preserves the previous gauges on the card — gauge-less posts (heartbeats, relay lines, auto-notes) never clobber them, and the freshest gauge-bearing call wins.
- **The watchdog keeps states moving**: silent agents are released back to the pool, an `in_review` park past `review_stale_minutes` (default 360) with no verifier running bounces and releases too, and gate-rejection blocks are reaped after 24h. Unblock tasks close directly with their verdict — they are never reviewed.
- Anything needing a human lands in **For Me**
- **Breach cards**: when the task machinery loops (rejection storms, double-spawn attempts, invariant violations, version-log replays that disagree with stored state), the server folds the audit stream into one open `breach`-tagged card per (task, class) on the Board — the loop's fingerprint and its sample event, ready to investigate.

## Local development

```bash
npm run demo -w @bridge/webapp    # mock hub + web UI, offline
npm run build -w @bridge/webapp   # webapp dist is committed and served as worker assets
npm run test -w packages/worker  # worker tests (syntax → tsc --noEmit typecheck → bundle dry-run → vitest)
npm run typecheck -w packages/worker  # worker type gate only — TS2304-class undefined names (the Oct 2026 board-500 bug class) fail here at any strictness
```

### Shared UI kit

Every surface (web, gateway UI, mobile) renders from one component kit,
`packages/ui-kit` (`@bridge/ui-kit`): design tokens (`tokens.css`) plus
`Btn` / `Chip` / `Card` / `Field` / `TextInput` / `TextArea` / `Select` /
`ActionRow` / `FormRow` / `ConnDot` / `RelTime`. Import the css once per
shell (`@bridge/ui-kit/ui-kit.css`, tokens included) and use the
components — surfaces keep layout css only and may re-point tokens (the
webapp overrides the palette in its `:root`; mobile sets
`--kit-radius: 12px` for touch scale). No surface re-declares button,
chip, card or field styles: the drift those per-surface copies caused is
the bug this kit removes.

**Docs are part of the change.** README.md and `packages/site/content.md`
describe shipped behaviour — a change that alters user-visible behaviour
(UI, config, protocol, gates) updates both in the same commit. Agents get
the same rule via their protocol card (7b) and the dispatch delivery
contract.

## Packages

| package | what |
|---|---|
| `packages/specs` | the contract: JSON Schemas, wire docs, TS types, consistency gate |
| `packages/worker` | Cloudflare Worker + KB Durable Object: `/mcp`, `/ingest` (bearer), `/ws`, `/api/*` incl. machine-plane mirrors (`/api/kb-machine/*`), serves the webapp |
| `packages/webapp` | the full web UI (browser-only — no shell forks) |
| `packages/ui-kit` | `@bridge/ui-kit` — shared design tokens + Btn/Chip/Card/Field/ConnDot/RelTime; one look for webapp, gateway UI and mobile |
| `packages/desktop` | gateway desktop app: minimal gateway UI (`ui/`) + Rust dispatch core (`src-tauri/`) |
| `packages/desktop/ui` | the gateway UI (auth, dispatch log stream, agent config, open-in-web) |
| `packages/mobile/ui` | mobile UI (fleet + For You) — iOS shell coming soon |
| `packages/cli` | headless `bridge` runner binary (reuses the desktop dispatch core) |
| `packages/site` | public landing page (static) |
| `packages/adapters` | anything → `/ingest` shippers |

## License

[Apache-2.0](LICENSE)
