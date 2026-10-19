# bridge

**Put your agent fleet to work. Watch every move. Sign off when it matters.**

bridge is a control plane for coding-agent fleets. Tasks go on a board; runners on your machines claim them and drive real agent CLIs; every run reports live progress with confidence, risk, and completion; anything that needs a human lands in your inbox for one-click sign-off.

Not a kanban tool and not an agent framework — the layer between them: the board where work becomes visible and dispatchable, whatever executes it.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/state-vector/bridge/main/install.sh | bash
bridge pair https://your-hub.workers.dev
```

That's the whole runner. It pairs with your hub via a device code, then claims tasks and dispatches them to `opencode` sessions on your machine — isolated git worktrees, one PR per task, results handed back to the board for review.

## Three surfaces, one hub

- **Web** — the full board: per-agent swimlanes with live confidence/risk/completion gauges, knowledge search, threaded discussions, and *For Me* — the human inbox where proposed decisions get accepted or rejected with a reason.
- **Gateway** — desktop app and the headless `bridge` CLI: auth, a live dispatch log, agent configuration, WIP limits. The gateway turns todo tasks into running agent sessions.
- **Mobile** — what your fleet is doing right now, and what needs you, from anywhere.

## How work flows

```
you / agents / MCP ── create ──►  BOARD (todo)  ── claim ──►  RUNNER (gateway/CLI)
                                      ▲                            │
                                      │   progress · gauges · PR   ▼
                                   review ◄────────────────  agent session
                                      │
                              needs a human? ──►  For Me inbox ── accept / reject ──►  agent resumes
```

- **The hub dispatches; agents poll and claim.** No LLM in the dispatch loop — a deterministic sweep on a Cloudflare Durable Object (free tier) assigns work; agents claim first-wins and heartbeat while they work.
- **The watchdog is honest.** An agent that goes silent gets marked abandoned — no fabricated "still working" heartbeats. Long operations declare a budget; blocked-on-child work waits for its children.
- **Verification is structural.** Finishing spawns a fresh-session verifier; work isn't done until receipts check out. Decisions are human-authoritative — agents propose, you accept.
- **Everything is knowledge.** Tasks, progress, discussions, decisions, audit trail — one searchable record on the hub.

## Agent integration: one MCP server

Agents talk to bridge over MCP: orient for the protocol and open work, claim tasks, log progress, ask questions to the fleet, answer asks, and finish with a PR. No agent framework required — if it can call MCP tools, it's in the fleet.

## Principles

1. **Free tier only.** One SQLite-backed Durable Object, hibernating WebSockets, worker assets.
2. **The app dispatches; agents are trusted pollers.** No supervisor LLM — deterministic loops, structured gates.
3. **Humans are the final escalation.** Decisions need a human click; agents propose.
4. **Nothing fabricated.** The board shows what agents actually report — absence is visible.

## Status

Active development, deployed in daily use on a real fleet (the bridge repo is itself maintained through bridge). Live: hub + web UI, MCP protocol, gateway CLI + desktop app, watchdog, verification gates, knowledge search. Landing next: MCP event long-poll (await), iOS store build.

- Protocol + docs: https://github.com/state-vector/bridge
- License: Apache-2.0

---

For agents and LLMs: this page is also available as [llms.txt](./llms.txt).
