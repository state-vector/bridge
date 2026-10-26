# bridge — self-hosting

**bridge** is a control plane for coding-agent fleets: a live board with confidence/risk/completion gauges, a gateway that claims tasks and dispatches them to agent CLIs on your machines, and a human inbox for sign-off. The [public site](https://fleetbridge.run/) covers what it does and why; **this README gets the app running in your own Cloudflare account.**

**Just want to use it?** The shared hub is live at `https://hub.fleetbridge.run` — sign in with GitHub at the same URL and `bridge pair https://hub.fleetbridge.run`; no deploy needed. The rest of this README is for self-hosting.

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
npx wrangler secret put BRIDGE_INGEST_TOKEN    # generate: openssl rand -hex 24 (legacy FLOWS_INGEST_TOKEN still accepted)
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

3. Set the login allowlist (default deny — without this secret **no** GitHub login can sign in):

```bash
npx wrangler secret put GITHUB_ALLOWED_USERS   # comma-separated GitHub logins (e.g. "rayh"), or "*" for any account
```

Optional workspace scoping via `WORKSPACE_MEMBERS` (JSON map slug → GitHub logins); logins not in any list get an isolated auto-workspace. See `deploy.md` for the full runbook.

## 3 · Run a runner (the gateway)

The runner claims `todo` tasks from the board and dispatches each to an agent CLI (opencode) in an isolated git worktree — one PR per task, progress reported back to the board. Claim races are noise, not failures: before claiming, the runner re-reads the card and skips silently when another dispatcher won; a card still `in_progress` whose dispatched session died (no fresh session stamp or hub heartbeat for 10 minutes — the same bar the watchdog uses) has its stale claim released and is re-claimed fresh; and the dispatch circuit breaker counts only genuine agent-CLI failures (spawn, auth, guardrails, provisioning) — lifecycle rejections from races never count toward it.

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
bridge doctor            # checks config, per-agent models (each pinned id must resolve via the hub's /v1/models proxy), agent CLIs, git, and the merge-train executor prerequisites (gh authed + repo scope, git, node ≥23, scripts/merge-train.mjs) — every failure names the fix
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

Server prerequisites: the agent CLI itself (e.g. [opencode](https://opencode.ai)) installed and authenticated — `bridge doctor` verifies. Per-agent models are required (`"models"` in `~/.bridge/config.json`); the runner refuses to dispatch without them. When a model is pinned, `bridge doctor` also fetches the hub's `/v1/models` proxy (same Bearer token as its other probes): a pinned id the proxy doesn't serve is a named FAIL (it would fail every dispatch), while a hub that doesn't serve the route yet only warns. The hub serves that route from its model registry — the `MODEL_IDS` var in `packages/worker/wrangler.toml` `[vars]` (comma-separated, e.g. `"sp-gateway/glm-5.3-flash,glm-4.7"`); an empty registry is an honest named FAIL for every pinned model until you set it. `~/.bridge/config.json` is the knob surface: `max_sessions`, `backends`, `agent`, `poll_secs`, `timeout_mins`, `model` overrides.

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

**Rotation is graceful and self-healing (BR#3787)** — a gateway is never
killed by a rotation and never needs a manual re-pair:

- **Identity law**: provisioning and pairing match tokens by the **principal
  only**. A label held by another device's credential is a collision —
  self-provision mints a suffixed row, human pairing refuses with a named
  error. Rotation never steals another device's token (the 2026-10-27 fleet
  401 ping-pong was exactly this theft).
- **72h grace**: when a token rotates, the **previous** hash keeps
  authenticating for 72 hours, flagged stale. Rotation is a re-vend signal,
  not an amputation — in-flight dispatches finish. Admin revocation still
  kills both hashes instantly.
- **Negotiated self-heal**: every authenticated response carries
  `x-bridge-token-epoch`; the runner re-vends its own row proactively at the
  next tick boundary when the epoch moves (`POST /api/token/repair`, agent
  plane — the principal is the credential, so **headless gateways self-heal
  without a human session**). On a hard 401 the same repair runs first, the
  desktop self-provision second, loud logout last — and every repair failure
  reason is logged, never swallowed. Only a lost/revoked principal (or an
  admin revoke) forces a human re-pair. Repairs are rate-limited per token
  (6/hour) so a crash loop can't mint infinitely.

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
  "identity": {                        // git commit/signing identity for dispatched
                                       // sessions (BR#3185). Omitted = the built-in
                                       // worker class (detached-cody per BR#3181).
    "name": "detached-cody",
    "email": "297316395+detached-cody@users.noreply.github.com",
    "signingKeyPath": "~/.ssh/sv-agents-signing.pub",
    "signingProgram": "/usr/bin/ssh-keygen"
  }
}
```

### Identity profiles (git signing, BR#3185)

Dispatched sessions commit under a **first-class identity profile** — not
ad-hoc `-c` overrides. At worktree provisioning the runner writes the
profile into **repo-local** git config on the runner's own clone (the
config that clone's worktrees share — never `--global`: `user.name`,
`user.email`, `user.signingkey`, `gpg.format=ssh`, `gpg.ssh.program`,
`commit.gpgsign=true`); your global git config is never touched, so the
shared checkout keeps its own identity.

- **Built-in class `worker`**: every dispatched session defaults to
  `detached-cody` / `297316395+detached-cody@users.noreply.github.com`,
  signing with `~/.ssh/sv-agents-signing.pub` via plain `/usr/bin/ssh-keygen`
  (the BR#3181 ruling — no 1Password in the agent path). The values are the
  recorded contract `packages/contracts/fixtures/identity-profiles.json`;
  the runner fails its own test suite when the built-in drifts from it.
- **Precedence**: an explicit `identity` block in the config beats the
  built-in class; the built-in class beats whatever is in the host's global
  git config for sessions dispatched into worktrees. An agent overriding
  `user.*` ad-hoc (`-c`) drifts the committer identity away from the class
  — the verify gate bounces that.
- **Validation leg**: provisioning ends with a scratch sign check through
  the profile's own program and key (`ssh-keygen -Y sign -n git`). A
  missing key, wrong program, or hung signing program refuses the dispatch
  loudly (like the smoke gate) — the task is noted on the board and the
  runner retries next cycle; unsigned commits are never shipped.
- **Board surfacing**: Connect nests each gateway's provisioned worker
  agents under it with their identity class, and the pairing screen states
  the class the device declared plus what its runner's dispatches commit
  as (BR#2455 grouping, reused).

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

**Verify is the merge authority; the merge train is the executor** (standing order BR#3033,
re-divisioned by BR#3516). The verify round reviews substance and records an accepted or
rejected verdict — its accepted verdict is what licenses the merge; the mechanical merge
itself is executed by the **merge train** (the next section): a credential-holding edge
executor that runs the 5c gate and merges when the verdict covers the current head and
checks are green. There is no separate human merge gate for a verified PR. The cycle is:
impl works → rebases → pushes a mergeable PR → `in_review`; verify reviews substance
(mergeability confirmed first — rule 5c); findings → bounce back to impl
(`in_review → in_progress`, one round, N bounces — the same verify round re-enters, it
never stacks); loop until the train merges and closes. Impl owns mergeability
*preparation* (rebase before every in_review — a conflicting PR is the impl's defect, not
the reviewer's); the train owns mergeability *enforcement* (a conflicting, red or unsigned
PR is bounced with the exact defect — never merged silently).

**One card may carry several PRs** (BR#3659): a verify close that accepts multiple PRs
cites **every** PR URL with one `head <sha>` after each — `PR <url> head <sha>; PR <url>
head <sha>` — and the hub queues one **leg** per PR (`meta.prs`; pairing is
line-adjacency based: a head after `;` belongs to the next clause's PR, never the
previous one, and a cited PR without its head fails the queue closed with the card
stamped `unbound`). A single-PR close keeps the pre-3659 shape (the note's one URL
binds its first `head <sha>` wherever it sits). The card closes only when its **last**
leg lands — after a partial landing it stays queued with an honest reason naming the
legs still out, and the train drives the next leg on a later tick. A bounced card is
NOT re-queued by a stale verify close (the bounce stands until the card re-enters
review and a **fresh** verify duty accepts the new head) — the close-note scrubbing
workaround from BR#3651 is obsolete.

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
open ask with its options as one-click buttons, and every ask-band row (verdict, decision,
node ask) shows its own BR# id as a mono chip next to the rel time — you always know which
ask you are acting on. `urgency` is an ask vocabulary, not a
sentiment: `"time-sensitive"` renders the urgent NOW chip in the ask band; anything else is
normal — agents can no longer file an "urgent" ask that renders as a quiet one.

**Human comments post from every web surface.** The comment boxes (task detail's
"Comment / steer", the decision popover, discussion replies) all write to the card's
history through the same door agents use — the web plane maps `POST /api/kb/progress` to
the knowledge object's `progress.log` op, so a comment from any surface lands on the card
instead of 404ing — and a failed post shows the server's message, not a bare "comment
failed". The task detail panel loads the card, its history and its related tasks in
parallel: each section renders as its own data arrives, carries its own error + retry, and
the non-essential related list times out to nothing instead of holding the panel hostage. Every section races its own timeout — the card and history get 15s, related enrichment 5s — so a stalled fetch answers with a named error + retry (or an explicit loading spinner) and never leaves the panel a bare shell.

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

## Blocked cards await something typed (BR#3578)

A blocked card without something it is *awaiting* is structurally impossible. `transition {to: "blocked"}` requires a reason AND a **typed `await_event`** from a closed grammar — a machine event (`pr_merged`, `br_pr_merged`, `issue_closed`, `br_done`, `run_success`, `pr_checks_green`), an **open ask** (`ask` — the active human leg, in For Me), or a **timer** (`time`). Free text (`unblock_condition`) is optional human-friendly annotation, derived from the structure when absent; text that parses cleanly to one atom is auto-typed at write time. The hub's proxy watch re-checks machine events every 15 min and spawns the unblock duty on the flip; an answered ask auto-resumes its subject; an elapsed timer fires the duty. Legacy prose-only cards are migrated: parseable → typed, awaiting-nothing → one active ask per card (never re-asked). **Answering a migration ask actions the card**: RELEASE/CANCEL → released to the pool, SUPERSEDE → dropped, RE-SCOPE/KEEP → a deliberate human-owned park (the answered ask is the record). MCP `transition` takes `await_event` (validated fail-closed; the schema lives in `packages/contracts/src/mcp.ts`, the grammar in `packages/worker/src/kb/closure.ts`).

## Destination-green: the stop-the-line gate

Merges must not land while the destination branch is red — accepted decision BR#3009 makes
that law, and BR#3008 makes it mechanical instead of discipline. Three halves, same rule:

- **The block**: every PR runs the required `main-green gate` check
  (`.github/workflows/main-green-gate.yml` + `scripts/main-green-gate.sh`). It reads the
  check runs on main's HEAD (`gh api repos/<repo>/commits/<sha>/check-runs`): any failure
  (or a check still running, or no check runs at all) fails the gate and GitHub refuses
  the merge via the `main: main-green gate + substance checks required` ruleset. The
  newest run per check judges; a cancelled run says nothing. The one exception is written
  into the gate: a PR green on the *exact* checks main fails passes with a printed
  **REMEDIATION CARVE-OUT** receipt — BR#3009's remediation-merge path, expressible and
  receipted, not a loophole.
- **The substance**: the block judges main's HEAD; it never judged the PR's own head — the
  hole #174 sailed through (merged with `Test` + `CLI build (packages/cli)` FAILURE on its
  head while main was green; main went red and the #211 hotfix followed). The same ruleset
  now also requires `Test` and `CLI build (packages/cli)` green on the PR's own head, with
  `strict_required_status_checks_policy` on: the checks must come from the latest head, so
  a stale green never counts. A red-head PR cannot merge even while main is green — the
  train's gate (`decideTrainGate`, composing the standing `decideMergeAction` in
  `packages/worker/src/kb/core.ts`) enforces the same law: two reds never merge.
  Deliberately NOT required: the `Superpositional` review
  (a failing review is a quality issue and merge-allowed — a required check would deadlock
  against it) and the BR#2267 externals (Workers builds / deploy previews never gate). The
  bypass actor is unchanged — rayh alone keeps `bypass_mode=always`: the human retains the
  loud escape hatch; machines do not. Proven end-to-end by probe PRs #216 and #217.
- **The stop (executor-fed, BR#3516)**: the hub holds no VCS credentials and no longer
  reads GitHub — red detection is fed in by the merge-train executor: its awaiting-CI
  poll posts the merge commit's check runs (`train.ci`), the hub classifies them
  (`classifyRequiredRuns` — red, or unknown past 3× the lane's typical CI time,
  fail-closed), and any non-green verdict **stops the line**: the lane card reads
  `merge-train: STOPPED — … (resume when the line is green)`, the just-merged **culprit
  card is bounced** to `in_progress` with the failing runs appended (red after merge), and
  ONE time-sensitive ask is filed per red episode to the `ALARM SINK` card
  (`train_alarm_sink_id` setting, default BR#3124) — deduped per sha by the
  identical-open-ask guard, so ten red runs are one ask, not ten. Options ride the ask:
  `Ack — on it` / `Revert the culprit` / `Waive — resume the lane`. Green again → the
  executor's next CI poll feeds a green classification (`train:landed`) and the hub
  releases the stop automatically. v1 stops the line; there is no auto-revert — fix
  forward or revert is the culprit card's job. Work on branches (worktrees) continues —
  only the line stops.

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
feeding the `main-green gate` and the merge train's base-green leg exactly as before — and so
does a hub that never answers. A failing main-tip lookup never turns a mismatch green
(fail-closed). Guarded by `npm run test:deploy-drift-alarm`.

## The merge train: serialized merges, credential-free hub (BR#3516)

Accepted decision BR#3516 re-divisioned the merge machinery: **the hub holds no VCS
credentials, ever.** Every GitHub fact is fed to it by an executor running on your own
machine; the hub decides (lease CAS, classification, events, queue) and only the
executor acts (`gh`). The hub-side sweeps that read GitHub — the standing merge-queue
sweep (BR#3198), the PR-disposition executor (BR#3312), the provenance sweep, the
GitHub-reading closure audit — are deleted, not deprecated: a hub that cannot reach
GitHub cannot lie about GitHub. The pure decision tables survive, pinned
(`packages/worker/test/merge-sweep.test.ts`); the executor's gate
(`decideTrainGate` → `decideMergeAction`) is one implementation shared with the hub,
unit-pinned in `packages/worker/test/merge-train.test.ts`.

### The executor

`scripts/merge-train.mjs` runs on any machine that has `gh` (authed, with the `repo`
scope), `git`, **Node ≥ 23** (native type stripping — it imports the hub's own gate
helpers from `packages/worker/src/kb/core.ts`) and a clone of the target repo:

```bash
cd /path/to/repo-clone                 # the repo the train drives (MERGE_TRAIN_WORKDIR)
export BRIDGE_URL=https://bridge.<your-subdomain>.workers.dev
export BRIDGE_TOKEN=<token from the Connect tab>
node /path/to/bridge/scripts/merge-train.mjs          # long-running loop (45s ticks)
node /path/to/bridge/scripts/merge-train.mjs --once   # single tick (cron-friendly)
```

Env: `MERGE_TRAIN_HOLDER` (lease label, default `merge-train@<host>`),
`MERGE_TRAIN_INTERVAL_SECS` (default 45), `MERGE_TRAIN_METHOD` (`merge | squash |
rebase`, default `merge`), `MERGE_TRAIN_WORKDIR` (the clone, default cwd). Flags:
`--lane <repo>@<base>` (drive one lane only), `--once`, `--interval <secs>`,
`--method <m>`. `bridge doctor` gates the prerequisites (gh present + authed + `repo`
scope, git, node ≥ 23, the executor script in the checkout — each failure names the
fix); the script re-probes the cheap ones every start. Keep it alive like the runner
(systemd / launchd / `nohup`) or run `--once` from cron. It merges as whatever identity
that `gh` is authed as — use the detached-cody credential per BR#3181, never a personal
one.

One tick: preflight → `train_status` → per lane: CAS-lease → **reconcile from live
GitHub** (never trust a prior holder's picture) → awaiting-CI poll (`train.ci`; the hub
lands, stops or pends) → else the queue head's **first unlanded leg on this lane**
(BR#3659: a multi-PR card rides leg by leg) → `decideTrainGate` → act: merge (`gh`) →
`train:merged` → next tick polls CI on the merge commit. Every fact crosses the
executor's fact boundary normalized (BR#3714): gh's GraphQL `mergeable` is the enum
string `"MERGEABLE"|"CONFLICTING"|"UNKNOWN"` — never a boolean — and
`mergeStateStatus` is UPPERCASE; `prFacts()` maps them to the boolean|null/lowercase
the shared gate compares. Fed raw, the strings satisfied neither `mergeable !== true`
nor `=== "clean"`, and every gated candidate bounced (genuinely mergeable PRs
included) as "unmergeable — CONFLICTING".

### Lanes, leases, queues

- **A lane card per `repo@base`** — created on demand (`train.lane`), tagged
  `merge-train` + `infrastructure`, never claimable by agents, blocked at birth with the
  honest reason `merge-train: awaiting an available gateway` (merges happen when your
  machines are on). The card's blocked reason is recomputed by the hub from the card's
  own meta — `idle` / `leased by X` / `awaiting CI on <sha> (PR #N)` / `STOPPED` /
  `awaiting an available gateway` — so the board always shows the lane's truth.
- **The lease is CAS with a 5-minute TTL**: acquire → held across the whole queue
  (`merge-train: leased by X — idle` between items) → release. The hub stamps
  `holder = the authenticated actor`; the executor never supplies a holder, so a leaked
  token cannot forge another machine's lease. A lapsed lease is cleared by the hub's
  credential-free train-watch sweep and the next gateway reconciles from live GitHub —
  a crashed executor cannot wedge the lane.
- **The queue is derived, never stored**: every open PR on the lane is re-read from
  GitHub each tick, oldest first, and only the head of the queue may merge — one merge
  in flight per lane, CI settling on the merge commit before the next head enters.
  Serialized is the point: no interleaved merges, no surprise rebases, every merge
  attributable to exactly one lane event.

### The gate, the carry law, the bounce

`decideTrainGate` composes the standing `decideMergeAction` 5c gate (`mergeable`, clean,
every commit GitHub-verified, base green, head checks green) plus **verdict coverage**:
the accepted verify verdict must stamp the exact head, or arrive by a contiguous
machine-clean carry chain:

- **Carry law (BR#3516 §5)**: the base advanced and the executor's `gh pr
  update-branch` lands machine-clean → the accepted verdict CARRIES (the hub appends
  the carry record on `train:merged`). A conflict resolved by hand means authored code
  changed under the verdict → the verdict is INVALID at the new head: the executor
  enumerates the conflicting files (`git merge-tree`), `train:bounced` lists them on
  the PR's card, the card re-enters review, and the train re-queues it at the BACK once
  a fresh verify accepts the new head.
- **Mechanical defects bounce with the exact defect named** — conflicts, red base, red
  head, unsigned commits, a head the verdict no longer covers — the same law the verify
  round enforces (rule 5c), now executed by the train. Human-leg defects
  (signing-environment, external mirrors) file ONE class ask per episode, never one per
  PR.
- **Multi-PR cards are legs, gated per leg (BR#3659)**: a card queued with several PRs
  is a list of legs (`meta.prs`; `meta.pr` stays the first leg for legacy readers).
  Coverage is judged per leg (`verdictCoversHeadLeg` — one leg's stamp/carry never
  covers another), the gate bounce names ITS leg's stamp, and the card appears in
  exactly the lanes that own one of its UNLANDED legs. A partial landing keeps the card
  queued (`merge-train: queued — waiting on N leg(s): repo#n, …`); the final close
  cites every leg's merge commit.

### The ops (MCP + HTTP)

`train.status` (GET `/train` mirrors it) · `train.lease` (acquire / renew / release) ·
`train.event` (`merged | bounced | stopped | landed`) · `train.ci` (executor-fed check
runs on the merge commit) · `train.lane` (ensure / configure) · `train.history` (the
`train_events` ledger — provenance serving). The executor never self-certifies:
`train:landed` re-classifies the fed check runs and REJECTS a non-green report outright
("post train.ci instead and let the hub decide").

### Setup

```jsonc
// admin.settings_set — lane config seeds the lane card at birth; the
// operator/executor refreshes it in place via train.lane afterwards
"train_lane": {
  "state-vector/bridge@main": {
    "required_workflows": ["Test", "CLI build (packages/cli)"],
    "ci_typical_minutes": 20
  }
},
"train_alarm_sink_id": "BR#3124"   // stop-the-line asks land here (default BR#3124)
```

`required_workflows` names the checks that must be green to land (the same checks the
main-green gate ruleset enforces); `ci_typical_minutes` paces the fail-closed CI bound
(unknown past 3× typical classifies red — the train never waits forever). Lane identity
is `repo@base`, so one repo can run several lanes (e.g. `main` and a release branch).

## PR provenance: who touched main, from bridge

Every merge is attributable (BR#3287) — and under BR#3516 the stamping is
**ledger-native**: there is no provenance sweep and no backfill job; the train's
`train:merged` events stamp the chain as each merge lands. Per merge the ledger
records: merge sha, head sha, the linked task (head branch `bridge/BR-<id>` is the
authoritative join key, PR text the fallback), the accepted verify verdict covering
that head (stamp or carry chain), the owning agent **session**, and the signer class
(`detached-cody` / `signed` / `partially-signed` / `unsigned`) — plus the carry record
when the verdict rode a machine-clean base update (BR#3516 §5).

- **Storage of record is the board** (decision BR#3291): the task card carries
  `meta.provenance` (rendered as a provenance strip in TaskDetail, and on the board's
  Top rows as a PR link + verifier badge for in-flight work — BR#3307), the DO keeps a
  `provenance` index, and `GET /api/kb/provenance?sha=<7-40 hex>` resolves
  sha → PR → task → verdict → session (`POST /provenance` and the MCP surface mirror
  it for machine consumers). Unknown sha = honest 404 "no bridge provenance"; merges
  with no bridge task are recorded as absence — itself a signal. The verdict leg is
  honest too (BR#3307): when no accepted decision covers the head sha, `verdict_id` is
  recorded `null` — never an arbitrary stale verdict.
- **Absence renders explicitly** (BR#3287 spec item 3): a Top row with nothing stamped
  carries a muted "no bridge provenance" chip — untracked merge, non-bridge work, or
  not yet trained. Absence is a rendered state, never silence.
- Consumers: the stop-the-line culprit bounce (the ask names the just-merged card —
  the guilty chain is on the ask, one lookup away), humans auditing who landed what,
  and any agent needing receipts. `train.history` serves the raw ledger.

## The closure tier: flipped proxies, terminal legs, receipts (BR#3361)

Work leaks at its END, not its middle: a card parked on a machine-checkable exit condition nobody
re-checks (BR#3129 — the proxy flipped and sat ~20h), a done card whose final "close GH #N" leg has
no owner (GH #2261), a done card claiming a close that never happened (BR#3220). The closure tier
closes those leaks with four hub mechanisms:

- **Unblock-proxy watch** (a): `unblockProxySweep` (paced by `unblock_proxy_sweep_minutes`, default
  15, `0` = off) re-evaluates every blocked card's `unblock_condition` on each pass. The parser
  (`packages/worker/src/kb/closure.ts`) extracts machine-checkable atoms — `pr_merged` (PR + url/number),
  `br_pr_merged` (a "BR#N's fix PR on <repo> is MERGED" condition, resolved by head branch
  `bridge/BR-<N>`), `issue_closed`, `br_done`, `run_success`, `pr_checks_green` — and cuts the
  DUTY clauses ("then a fresh session closes…") so instruction text never parses as a precondition.
  Conservatism law: machine-looking text that yields no atom stamps the verdict `unparseable`
  (never auto-flips); atoms with no resolvable repo stamp `unresolvable`. Since BR#3516 the
  hub holds no VCS credentials: **GitHub-state atoms (`pr_merged`, `br_pr_merged`,
  `issue_closed`, `run_success`, `pr_checks_green`) now classify `unresolvable` and spawn
  nothing** — only board-state atoms (e.g. `br_done`) still verify TRUE live and auto-spawn
  the unblock duty with the receipts embedded (a trigger, never an authority: the spawned
  duty re-verifies first-hand; GitHub-state conditions flip when an acting session or the
  executor operator checks them first-hand). The machine's caps still apply (≤1 open
  unblock child, flood guard on the same exit condition). Stamp lives on `meta.proxy_check`.
- **Terminal close-leg ownership** (b): a new gate rule `done-close-legs` reads the "## Done when"
  section + the done note; every terminal "close GH #N" intent (or receipt-shaped claim like
  "GH#N fully closed") must carry a **closure receipt** or be owned by a CLOSED close-duty child.
  A rejected done auto-derives that child (`Close-leg duty: …`, flood-guarded per legs-shape) so
  the very next attempt has an owner — no orphan terminal legs.
- **Done-gate closure receipts** (c): the receipt contract is `state=closed + closing-comment id
  (or the comment URL) + guard run id (or n/a)`. Intent language ("will close", "fully closed",
  "close-guard blocked") is not a receipt. The done-time stamp (`meta.close_leg_audit`) records
  the claim; the LIVE GitHub re-verification sweep (`closureAuditSweep`) was deleted under
  BR#3516 — the hub no longer reads GitHub — so a false claim (the BR#3220 class — the board
  reporting a closed issue that wasn't) surfaces through the close-duty child's first-hand
  re-verification instead of a hub sweep; the gate still rejects an unreceipted done and
  auto-derives the close-leg duty exactly as before.
- **Duplicate-executor fence** (d): orient exposes the executor lease (`executor_session`) on open
  cards and my_tasks; a state-changing op by a named session other than the lease holder while the
  holder is alive (<10m) is audited `system:fence / duplicate_executor` — observability, never a
  block. Prompt law backs it: a lost claim race means you are not the executor; stand down
  (rule 5d + protocol card 7). Hub/auto-spawned duties start session-less — the first real session
  to claim them stamps the lease.

Drills: `packages/worker/test/closure.test.ts` (pure parsers pinned to verbatim real card texts),
`test/closure-sweep.test.ts` (real DO: GitHub atoms stamp unresolvable + unparseable honesty;
rejected done → close-duty child → receipted done unblocks the parent; duplicate-executor fence
audit + lease), plus the train suites — `test/merge-train.test.ts` (the pure gate, carry law,
queue and classification) and `test/train-hub.test.ts` (real-DO train drills: lease races,
landed / stopped / bounced flows, the stop-the-line ask).
`admin.unblock_proxy_sweep` drills on demand.

## 5 · Use it

- Open the hub URL → **Board** (live fleet), **For Me** (proposed decisions awaiting your accept/reject), **Knowledge** (search), **Discussions** (question threads)
- Create work: `bridge create_artefact` via MCP, or ask an agent to — tasks land in `todo` and the runner picks them up
- **Boost**: the Backlog tab ranks work by pickup order; `▲ boost` takes a task and all its open children to priority 0, ahead of unblock duty. Boost cascades server-side and is audited; `▼ unboost` removes it.
- **Progress gauges persist until updated**: a `log_progress` post that omits gauge fields (`completion_pct`, `confidence_pct`, `risk_pct`, `context_pct`) preserves the previous gauges on the card — gauge-less posts (heartbeats, relay lines, auto-notes) never clobber them, and the freshest gauge-bearing call wins.
- **The watchdog keeps states moving**: silent agents are released back to the pool, an `in_review` park past `review_stale_minutes` (default 360) with no verifier running bounces and releases too, and gate-rejection blocks are reaped after 24h. Unblock tasks close directly with their verdict — they are never reviewed. A silent task whose trail proves landed side effects (GitHub PR/commit receipts, or the runner's own `completed_result_lost` marker) is released as `completed_result_lost`, not abandoned: the run happened and the report was lost between worker and hub. The class never penalizes the agent's behaviour score — the delivery channel is flagged instead (BR#3352).
- **Blocker rollup**: when ≥3 blocked cards share one machine-detectable root cause, the watchdog sweep auto-creates ONE boosted `ROOT BLOCKER` task — *investigate → fix → one approval* — and every queued card points at it (`meta.root_blocker` + a `child_of` link, so the board shows the tree and the boost cascades to all of them). Today's machine-detectable roots: a `github.com/.../pull/N` URL in the card's unblock condition (the one unmerged PR everything queues behind) and red/broken/failing-`main` language (the never-merge-onto-red-main class). Idempotent: cards already pointing at an open root are left alone, re-runs create no duplicates. A root closes only by an agent or human with receipts that the root cause is gone — the sweep never auto-closes it, and a later cluster of the same root opens a NEW root rather than reusing a done one.
- Anything needing a human lands in **For Me**
- **For Me never jumps (BR#3457)**: acting on a proposed decision (accept, or reject — which routes to supersede-with-reason, the decision lifecycle's only exit for a verdict that doesn't hold) pins the card to the bottom of its section with an `actioning…` chip and dead buttons; the card leaves the list only when a refetch confirms the server flipped it, and an error returns it to its slot with the reason inline. Server-side, one actionable verdict per target, ever: a newer verify-verdict for a target supersedes still-proposed older rounds at create, and the human's accept/reject sweeps any leftover proposed sibling (legacy stacked rounds included) — accepting a stacked group removes exactly one verdict and the card can never regrow.
- **Breach cards**: when the task machinery loops (rejection storms, double-spawn attempts, invariant violations, version-log replays that disagree with stored state), the server folds the audit stream into one open `breach`-tagged card per (task, class) on the Board — the loop's fingerprint and its sample event, ready to investigate. A closed card never re-arms its key: every card stamps a fold high-water (the newest event its adjudication covered — its raised group plus everything that coalesced while it was open), and a later fold trigger counts only events strictly above that mark, so already-adjudicated events can never resurrect as a duplicate card while they remain in the lookback (BR#3443); genuinely new events raise a fresh card. Not every rejection counts: claim races never do — both a raced double-claim (lifecycle-edge rejections) and a non-owner's attempt to release a claimed card (the ownership gate's `release-needs-ownership` rejections, e.g. a dispatched session's rule-9 release on a runner-claimed task) classify as `claim_race` and are priced as noise, so no pile-up of them ever raises a breach card (BR#3337, BR#3429). The classifier matches the guard's *structural pair* (`claimed by` + `only the owner`), not a sentence literal — a wording edit to the gate message can no longer silently re-classify its rejections (PR #210's proven-unblock rewording did exactly that until BR#3611). Three release-protocol truths ride with it: a **gateway may release its own attributed claim** (claims are attributed — owner = the dispatched agent — so the raw gateway actor never matches the owner; the self-release exemption is token-derived and unforgeable, while a *different* gateway's release stays gated), and the **runner only posts its "stale claim released" note when the release actually happened** — a refused release stays noteless (the board never records a release that didn't happen) — and the **stale-claim flow re-checks the live card before touching it**: a release fires only while the card is still `in_progress` and still attributed to this runner, so a card the watchdog already redirected (blocked) or another dispatcher already re-claimed is skipped outright (no rejection, no note, no re-claim), and the recovery re-claim carries a resolution note re-stamping the card's own blocked reason + unblock condition (BR#3823). The replay fold re-anchors across historical chain gaps (a row that doesn't chain is healed and, when it's the newest row, audited as a `chain_break`) — the breach fires when the fold's end state disagrees with the stored status, not forever after on ancient damage (BR#3322).

## Local development

```bash
npm run demo -w @bridge/webapp    # mock hub + web UI, offline
npm run build -w @bridge/webapp   # webapp dist is committed and served as worker assets
npm run test -w packages/worker  # worker tests (syntax → tsc --noEmit typecheck → bundle dry-run → vitest)
npm run test -w packages/contracts  # contract tests: fixtures ↔ zod schemas ↔ the recorded MCP registry ↔ config schema
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
| `packages/contracts` | `@bridge/contracts` — the shapes every runtime trusts, verified in CI: zod schemas + production fixtures for orient, the MCP tool table, pairing, provisioning, asks, and the config file |
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
