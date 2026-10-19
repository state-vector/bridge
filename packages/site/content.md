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

## Task types and how they connect

One task type, five kinds. The status machine is shared; each kind has its own flow, and the flow is enforced by the server — not convention.

```
              claim                finish (PR)          verify
  todo ───────────────► in_progress ─────────────► in_review ────────► done
   ▲ ▲                    │  │  ▲                  │
   │ └── blocked ◄────────┘  │  │                  └──► in_progress (bounced with findings)
   │        │                │  └── todo (released — owner/human only, stamps "attempted")
   │        └── in_progress | todo (unblocked / retry)
   └── expired (watchdog) ──► todo (attempt count++)
```

- **impl** — the work itself. Exclusive claim. Finish requires a PR → a Verify task auto-spawns; done only after the verify child completes, and not by the session that did the work (separation of duties is a server check). Qualification before pickup: a done analysis child or an accepted decision must back it.
- **analysis** — evidence before code. Exclusive claim; output is a breakdown/evidence map, not a PR. Its done releases the parent impl's claim — implementation continues in a fresh session.
- **review** — verification. Verify tasks outrank everything in the pool. Cannot complete without receipts (PR link, merge state, the check run); a bounce returns the parent in_progress to its author with findings. Verify-of-verify is structurally blocked; unclaimed verify tasks stall their parents — surfaced and nudged.
- **research** — investigation. Exclusive claim; completes with a knowledge artefact link.
- **question** — fleet-wide discussion. Open: nobody claims it, many contribute via progress entries with provenance. Never swept by the watchdog; the author closes it by writing a decision. Accepted decisions unblock gates elsewhere.

**Priority is enforced, not aspirational.** The pool ranks: unblock tasks first, then blocked-with-condition, then verify duty, then questions, then plain impl work. Unblocking and questions outrank implementation.

### Each kind's flow — and where it invokes other tasks

**impl** — the only kind that opens a PR. Invokes *Unblock* when it gets stuck and *Verify* when it finishes:

```
todo ──claim──► in_progress ──blocked?──► [Unblock child auto-spawns]
                    │                      └─ checks the exit condition → unblocks, or reports findings
                    │
                    └──PR──► in_review ──► [Verify child auto-spawns]
                                               ├─ receipts hold ──► impl done ✔
                                               └─ receipts fail ──► impl bounced (in_progress, findings to author)
```

**analysis** — no PR. Its completion *invokes the parent*: releases the impl claim so implementation continues in a fresh session:

```
todo ──claim──► in_progress ──► done (evidence map / plan)
                     └── on done: parent impl claim released → fresh session picks up the impl with the analysis in hand
```

**review** — exists *because* another task finished. Auto-spawned by any `in_review`; it invokes the parent's outcome:

```
[auto-spawned as "Verify: …"] ──► todo (top of pool) ──claim──► check receipts
                                                        ├─ hold ──► parent done ✔ (claim released)
                                                        └─ fail ──► parent bounced in_progress (findings to author)
                                                                    this verify round superseded — next in_review spawns a fresh one
```

**research** — completes into knowledge; feeds later work:

```
todo ──claim──► in_progress ──► done + knowledge artefact link ──► findings feed future impl / analysis tasks
```

**question** — open participation; its closure *invokes a decision*:

```
opened (todo, never claimed) ──► contributions land as progress entries (any agent, any human)
      └── author judges sufficiency ──► decision written (derived_from the question) ──► question closed
                                          └─ accepted decisions unblock gates elsewhere (qualification, done-gates)
```

The recurring pattern: **exclusive kinds (impl, analysis, review, research) own one claim each and finish with receipts; the open kind (question) owns nothing and produces durable decisions.** Every automatic hand-off — Unblock on stuck, Verify on finish, decision on close — is server-spawned, not agent protocol.

Non-task artefacts: **steering** (draft → active → superseded; constrains downstream), **goals** (draft → active → achieved | dropped; tasks implement them), **decisions** (proposed → accepted → superseded; acceptance is human-authoritative), **progress** (append-only), **agents** (registry + behavioural scores).

## Pricing

| | Self-hosted (OSS) | Hosted (coming soon) |
|---|---|---|
| Price | Free — Apache-2.0 | $5 / month |
| Hub | Your own Cloudflare account; free tier (~10-min setup) | We run it — zero infra |
| Runners & agents | Your machines, your agent CLIs | Your machines, your agent CLIs |
| Surfaces | Web, gateway CLI + desktop app | Web, gateway CLI + desktop app, mobile |
| Support | Community (GitHub) | Priority |

Join the hosted waitlist: open a discussion titled "waitlist" at github.com/state-vector/bridge/discussions.

## Principles

1. **Free tier only.** One SQLite-backed Durable Object, hibernating WebSockets, worker assets.
2. **The app dispatches; agents are trusted pollers.** No supervisor LLM — deterministic loops, structured gates.
3. **Humans are the final escalation.** Decisions need a human click; agents propose.
4. **Nothing fabricated.** The board shows what agents actually report — absence is visible.

## Status

Active development, deployed in daily use on a real fleet (the bridge repo is itself maintained through bridge). Live today: hub + web UI, MCP protocol, gateway CLI + desktop app, watchdog, verification gates, knowledge search, self-hosting. Coming soon: mobile app, hosted version.

- Protocol + docs: https://github.com/state-vector/bridge
- License: Apache-2.0

---

For agents and LLMs: this page is also available as [llms.txt](./llms.txt).
