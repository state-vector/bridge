# Onboarding agents to a bridge runner

A bridge runner dispatches board tasks to **agent CLIs** installed on its machine
(`opencode`, `kiro`). This doc covers everything you configure per agent: the
backend, the required model, and the optional agent profile. For hub-side setup
(deploy, pair, run), see the [README](../README.md).

## The three configuration knobs

All live in `~/.bridge/config.json` on the runner's machine:

```json
{
  "backends": ["opencode", "kiro"],
  "models":   { "opencode": "openrouter/~z-ai/glm-latest",
                "kiro":     "anthropic.claude-sonnet-4-5" },
  "agents":   { "opencode": "bridge-worker" }
}
```

| knob | what it is | required? |
|---|---|---|
| `backends` | which agent CLIs the runner may dispatch to; tasks rotate across them (round-robin) | no — defaults to `["opencode"]` |
| `models` | **one model per backend, by ID the CLI itself accepts** | **yes — the runner refuses to dispatch without it** |
| `agents` | an *agent profile* name per backend (opencode's `--agent`), for a tuned persona/prompt/permissions | no — omit for the CLI's default agent |

Rule of thumb: **bridge always passes `--model`** (from `models`) and passes
`--agent` only if you configured one. The model you set in bridge **overrides**
any model pinned inside an agent profile — keep them consistent.

## The easy path: let onboarding do it

`bridge pair <hub-url>` walks the whole thing interactively: it detects which
agent CLIs are installed, offers to install opencode if none are found, prompts
for the model per selected backend (required — it loops until you give one),
asks for the workdir and WIP limit, saves the config, and only then starts the
runner. Bare `bridge` with no config runs the same wizard from scratch.

Not interactive (cron/pipes)? The wizard skips safely and `bridge doctor` lists
exactly what's missing, with the fix on each line.

## Backend: opencode

1. **Install + authenticate** — the CLI must work non-interactively; bridge
   runs it headless:
   ```bash
   curl -fsSL https://opencode.ai/install | bash
   opencode auth login
   ```
2. **Model ID** — must match opencode's own catalog. `opencode models` lists
   every valid ID (provider prefixes matter: `openrouter/~z-ai/...`,
   `zai-coding-plan/...`, `amazon-bedrock/...` are distinct). A typo'd ID fails
   every dispatch identically, so verify with a one-liner before wiring it:
   ```bash
   opencode run --model "<your-model-id>" "Reply OK"
   ```
3. **Agent profile (optional)** — the default agent (`build`) works out of the
   box. bridge ships its own fleet persona with the CLI — the recommended path:
   ```bash
   bridge agent install     # installs the persona into opencode's agent dir
   bridge agent check       # verify it matches the version you run
   ```
   Then set `"agents": {"opencode": "bridge"}` in `~/.bridge/config.json`
   (onboarding offers this automatically).

   For a custom persona, either `opencode agent create` (interactive; needs a
   working model) or hand-write the file (no auth needed):
   ```markdown
   <!-- ~/.config/opencode/agent/bridge.md -->
   ---
   description: Fleet worker — dispatches bridge board tasks
   mode: primary
   ---
   You are a fleet worker for the bridge board. Work each task in isolation:
   claim context from the prompt, implement exactly what is asked, commit,
   push a branch, and open a PR. Report honestly what is done and what is not.
   ```
   List what exists: `opencode agent list`. Then set `"agents": {"opencode": "<name>"}` in
   `~/.bridge/config.json`. No profile at all? Also fine — omit `agents` and the
   CLI's default agent is used.

The shipped persona carries bridge's standing behavioural directives (honest
reporting, delivery receipts, worktree discipline). The hub injects the dynamic
per-session protocol at dispatch time (orient), so the two never drift: persona
ships with the CLI, protocol ships with the hub.

## Backend: kiro

1. Install the kiro CLI and authenticate it (`kiro` must run non-interactively).
2. Model ID: kiro's own format (e.g. `anthropic.claude-sonnet-4-5`).
3. Agent profiles: kiro profiles are supported the same way
   (`"agents": {"kiro": "<profile>"}`).

## Verify: bridge doctor

```bash
bridge doctor
```

Checks, each with the fix on failure:

- config exists, hub url + token set
- `model[<backend>]` present for **every** enabled backend
- the agent CLI is runnable on PATH
- **the configured agent profile actually exists** in the CLI's own agent list
  (a stale profile name like `opencode-glm` fails every dispatch identically —
  doctor catches it before the runner churns a single task)
- workdir is a git repo

Exit code 1 on any hard failure, so scripts can gate on it.

## Multiple agents

`backends` is a list: `["opencode", "kiro"]` rotates tasks across both CLIs.
The runner checks dispatchability every tick — a backend whose CLI disappears
or loses its model is skipped automatically (and the runner says so once),
until it works again.

## Common mistakes

| Symptom | Cause | Fix |
|---|---|---|
| every dispatch fails `agent "X" not found` | `agents` names a profile that doesn't exist in the CLI's config | clear `agents` or create the profile |
| every dispatch fails `ProviderModelNotFoundError` | `models` ID isn't in the CLI's catalog | verify with `opencode models` / the CLI's list |
| runner idle, log says "no dispatchable agents" | CLI not installed/authed, or model missing | `bridge doctor` |
| task blocked "references no git repository" | the task carries no `meta.repo` and no repo URL in its body | add `meta.repo` (or a repo URL in the body); the runner clones it into the workdir on demand |
| sessions run a weaker model than intended | model pinned in a global CLI config or an agent profile overriding bridge's `models` | bridge's `--model` wins at dispatch; clean the pin if you want bridge's value |
