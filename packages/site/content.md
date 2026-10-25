# bridge

**bridge nags your agents and humans, so you don't have to.**

Your agents run the inner loop: prompt, edit, test, repeat. bridge is the outer loop around them. It decides what work happens next, hands each unit to a fresh agent session, tracks live progress with completion, confidence, and risk, verifies results with an independent session, and routes sign-off to a human when it matters.

It is not a kanban tool and not an agent framework. It is the layer between them: a board where work becomes visible and dispatchable, whatever executes it.

![A ship's bridge at night: instruments glowing, radar sweeping, the fleet in view](./assets/hero.png)

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/state-vector/bridge/main/install.sh | bash
bridge pair https://your-hub.workers.dev
```

That is the whole runner. It pairs with your hub using a device code, then claims tasks and dispatches them to `opencode` sessions on your machine, in isolated git worktrees, one PR per task. Results come back to the board for review.

Every push to `main` also publishes a rolling **dev** pre-release of the binaries — `install.sh` with no arguments always resolves to the newest versioned release, never dev. Install the dev channel with `curl -fsSL https://raw.githubusercontent.com/state-vector/bridge/main/install.sh | bash -s -- dev`.

## Three surfaces, one hub

- **Web**: the full board: per-agent swimlanes with live completion, confidence, and risk gauges; knowledge search; threaded discussions; and *For Me*, the human inbox where proposed decisions are accepted or rejected with a reason. The dashboard carries a task-done throughput chart (done transitions per day or week + cumulative line, from `/api/kb/metrics/throughput`). A workspace selector in the top bar lists the workspaces you belong to, creates new ones (you become owner and first member), and switches between them — boards, tokens, and agents are scoped per workspace.
- **Gateway**: desktop app and the headless `bridge` CLI: auth, a live dispatch log, agent configuration, WIP limits. The gateway turns todo tasks into running agent sessions. Gateways are infrastructure with their own gateway-class identity (the class is a tag on the token) — the board shows each gateway with the agents it dispatched, never conflated with your interactive agents. The desktop shell renders the same board views as the web (one shared rendering path), live over the paired token. Credentials are owned by a single store: the token lives in the OS keychain (never in config.json, which is written atomically with a schema version), and the device principal is a write-once file a rejected token can never corrupt. If a desktop's saved token falls out of the gateway class (say, a pre-gateway token surviving an upgrade) or the hub rejects it, the run gate signs the desktop out — one self-repair attempt first — and the sign-in screen explains why (the identity law) and walks the one-click sign-back-in: hub URL and settings are kept, and the fresh gateway-class token re-associates with the same device.
- **Decision inbox**: the desktop app notifies you when a decision needs a human, and answers questions about the board in a console chat — retrieval over the hub, summarised by Apple's on-device model (falls back to your configured agent CLI). Read-only: the console never does the work.
- **Mobile** (coming soon): what your fleet is doing right now, and what needs you, from anywhere.

## How work flows

```
you / agents / MCP ── create ──►  BOARD (todo)  ── claim ──►  RUNNER (gateway/CLI)
                                      ▲                            │
                                      │   progress · gauges · PR   ▼
                                   review ◄────────────────  agent session
                                      │
                              needs a human? ──►  For Me inbox ── accept / reject ──►  agent resumes
```

- **The hub dispatches; agents poll and claim.** The dispatch loop has no LLM in it. A deterministic sweep on a Cloudflare Durable Object (free tier) assigns work, agents claim first-wins, and agents heartbeat while they work.
- **Honest silence.** An agent that goes silent is marked abandoned. The runner never writes heartbeat notes on the agent's behalf. Long operations declare a budget. Work blocked on children waits for its children — and nothing parks forever: stale reviews bounce back to the pool, gate-rejection blocks are reaped after 24h.
- **Verification is built in.** Finishing a task spawns a verifier in a fresh session. Work is not done until the receipts check out — and mergeability is a precondition, not a finding: a verifier that hits an unmergeable or unsigned PR bounces it straight back to impl with the mechanical defect (no human ask), and only a broken signing environment escalates, once per class. Decisions are human-authoritative: agents propose, you accept.
- **The destination must be green.** Merging onto a red main is mechanically blocked: a required `main-green gate` check fails every PR while main's HEAD has failing (or unsettled) checks, with one written exception — a PR green on the exact checks main fails passes as the receipted remediation merge. And the line is loud on its own: when main goes red, the hub files one urgent ask per red episode, deduped per commit, whether or not anyone opened a PR.
- **Merging is automated.** A deterministic merge-queue sweep runs the standing order every tick: superseded-check first, then the mechanical gate (mergeable, clean, signed, base green, head checks green) and an accepted verify verdict on the current head — merge when green, bounce mechanical defects with the exact defect named, and collect the human legs (signing environment, externals) into one class ask per repo. The sweep merges as the worker identity; human merge clicks are abolished, and everything it does is receipted on the card.
- **Everything is knowledge.** Tasks, progress, discussions, decisions, and the audit trail are one searchable record.
- **Small sessions, fresh context.** Each claim is one session with one job. Verification runs in a session that never saw the implementation. Analysis hands off to a fresh implementation session. Agents report context pressure (`context_pct`) so the board shows when a session should hand off.
- **Gauges stick until updated.** A progress post without gauge fields preserves the previous gauges on the card — gauges persist across gauge-less posts (heartbeats, relay lines, auto-notes) and only a gauge-bearing post overwrites them. The freshest gauge-bearing call wins; the board never shows dashes just because a relay logged a plain heartbeat.

## Agent integration: one MCP server

Agents talk to bridge over MCP: orient for the protocol and open work, claim tasks, log progress, ask questions, answer asks, and finish with a PR. No agent framework required. If it can call MCP tools, it can join the fleet.

## Task types and how they connect

One task type, five kinds. The status machine is shared. Each kind has its own flow, and the server enforces it.

```
              claim                finish (PR)          verify
  todo ───────────────► in_progress ─────────────► in_review ────────► done
   ▲ ▲                    │  │  ▲                  │
   │ └── blocked ◄────────┘  │  │                  └──► in_progress (bounced with findings)
   │        │                │  └── todo (released, owner/human only, stamps "attempted")
   │        └── in_progress | todo (unblocked / retry)
   └── expired or stale review (watchdog) ──► todo (attempt count++)
```

The watchdog never lets work park forever. Silent agents are released from `in_progress`. A task parked `in_review` past `review_stale_minutes` (a setting, default 360) with no verifier actively running is bounced and released to the pool too. And a gate-rejection block (a runner handoff a gate refused) is reaped after 24h of no movement — the rejection history stays on the card.

- **impl**, the work itself. Exclusive claim. Finish requires a PR, which auto-spawns a Verify task. done requires the verify child to complete, and the verifying session must not be the session that did the work (separation of duties is a server check). Pickup requires qualification: a done analysis child or an accepted decision.
- **analysis**, evidence before code. Exclusive claim; output is a breakdown or evidence map, not a PR. Its done releases the parent impl's claim, so implementation continues in a fresh session.
- **review**, verification. Verify tasks outrank everything in the pool. Done-only terminals: they cannot block or enter review — every exit is done with a verdict (accept, bounce-with-findings, or cannot-verify-with-findings); "cannot proceed" is itself a verdict, escalated via an ask, never a parked card. Cannot complete without receipts (PR link, merge state, the check that ran). A bounce returns the parent to in_progress with findings for its author. Verify-of-verify is structurally blocked. A bounce or done supersedes open verify rounds. Unclaimed verify tasks stall their parents, and are surfaced and nudged; a stalled round nobody picks up eventually bounces the parent back to the pool (watchdog, `review_stale_minutes` default 360).
- **research**, investigation. Exclusive claim; completes with a knowledge artefact link. Findings feed later impl and analysis tasks.
- **question**, fleet-wide discussion — its own **type** (`type: "question"`; `ask_agent` creates these automatically). Open: nobody claims it, many contribute. Contributions are progress entries with provenance. The watchdog never sweeps it. The author judges sufficiency and closes it by writing a decision. Accepted decisions unblock gates elsewhere.
- **tags**, user-defined themes. Tags are free-form labels (`gtm`, `deploy-train`, `pricing`) set by humans or agents. They render as chips and drive the filterable theme bar (with live counts) in Top and Backlog — and they never change system behaviour. Dispatch lanes live in the task's `roles` column (`roles: ["review"]`), questions in their type; a tag is just a label.

The pool ranks work in this order: verify duty and unblock tasks first (release-parked-work levers — an in_review task parks its owner until a fresh session rules), then blocked tasks with an unblock condition, then questions, then plain impl work. Verify and unblocking outrank implementation.

**Role playbooks set the lane.** Agent tokens carry `role:*` tags (analysis / impl / review), and the hub composes the matching playbook into every orient for that agent: analysis decomposes and qualifies, impl builds and hands off with a PR, review verifies with receipts in a fresh session. Hub defaults ship with the server; per-hub overrides live in the admin settings. On tasks, the lane is the `roles` column — the machine's verify and unblock children carry it automatically.

### Flows per kind: when they invoke other tasks

**impl** opens the only PR. It invokes *Unblock* when it gets stuck and *Verify* when it finishes:

```
todo ──claim──► in_progress ──blocked?──► [Unblock child auto-spawns]
                    │                      └─ checks the exit condition → unblocks, or reports findings
                    │                         the unblock child closes itself done with its verdict —
                    │                         it is never reviewed (a review of an unblock would deadlock it)
                    │
                    └──PR──► in_review ──► [Verify child auto-spawns]
                                               ├─ receipts hold ──► impl done ✔
                                               └─ receipts fail ──► impl bounced (in_progress, findings to author)
```

**analysis** opens no PR. Its completion releases the parent impl's claim, so implementation continues in a fresh session:

```
todo ──claim──► in_progress ──► done (evidence map / plan)
                     └── on done: parent impl claim released → fresh session picks up the impl with the analysis in hand
```

**review** is spawned by any `in_review`, and its verdict sets the parent's outcome:

```
[auto-spawned as "Verify: …"] ──► todo (top of pool) ──claim──► check receipts
                                                        ├─ hold ──► parent done ✔ (claim released)
                                                        └─ fail ──► parent bounced in_progress (findings to author)
                                                                    this verify round is superseded; the next in_review spawns a fresh one
```

**research** completes into knowledge and feeds later work:

```
todo ──claim──► in_progress ──► done + knowledge artefact link ──► findings feed future impl / analysis tasks
```

**question** is open participation. Its closure produces a decision:

```
opened (todo, never claimed) ──► contributions land as progress entries (any agent, any human)
      └── author judges sufficiency ──► decision written (derived_from the question) ──► question closed
                                          └─ accepted decisions unblock gates elsewhere (qualification, done-gates)
```

The pattern: exclusive kinds (impl, analysis, review, research) hold one claim each and finish with receipts. The open kind (question) holds no claim and produces durable decisions. Every automatic hand-off (Unblock on stuck, Verify on finish, decision on close) is spawned by the server, not by agent protocol.

Non-task artefacts: **steering** (draft → active → superseded; constrains downstream), **goals** (draft → active → achieved | dropped; tasks implement them), **decisions** (proposed → accepted → superseded; acceptance is human-authoritative), **progress** (append-only), **agents** (registry with behavioural scores).

Verify-verdict decisions always carry a plain-English ask at the top — **what accepting does** (PASS closes the target task done; BOUNCE bounces it back to in_progress), **why it lands on you** (agents propose, only a human accepts), and that you are not being asked to re-verify. Accepting a verdict is actionable: the click applies it to the target task.

### The ask contract: asks are question nodes

When an agent needs a human or a peer, `ask_agent` writes no side table — the ask **is** a question task: a BR#-numbered `type: "question"` node, `child_of` the subject task when one is given (`artefact_id`). The subject goes `blocked`, the watchdog pauses for it, and an answer auto-resumes it back to `in_progress`. Three fields are the whole contract, enforced server-side:

- **`question` — the summary.** One answerable sentence ending in `?`, ≤240 chars; it becomes the node title. Status reports are rejected at the door — receipts and narrative go in `details`.
- **`reason` — the why_escalated.** Mandatory on human-directed asks (rejected without it): one sentence on why this is escalated instead of automatic — the gate, credential or authority it waits on.
- **`options` — the decision.** 2–8 one-click answers (rejected with fewer): the recorded click is the answer, and it closes the question `done`.

Asks carry ordinary BR# ids, so refs linkify wherever BR# refs render (cards, task detail) and resolve via `get_artefact` like any artefact — `answer_ask` takes the question node's BR# id; there are no separate `ASK-*` artefact ids. Humans answer in the app: the ask band in Top (web + desktop) renders every open ask with its options as one-click buttons.

## Pricing

| | Self-hosted (OSS) | Hosted (coming soon) |
|---|---|---|
| Price | Free, Apache-2.0 | $5 / month |
| Hub | Your own Cloudflare account; free tier (~10-min setup) | We run it, zero infra |
| Runners & agents | Your machines, your agent CLIs | Your machines, your agent CLIs |
| Surfaces | Web, gateway CLI + desktop app | Web, gateway CLI + desktop app, mobile |
| Support | Community (GitHub) | Priority |

Join the hosted waitlist: open a discussion titled "waitlist" at github.com/state-vector/bridge/discussions.

## Principles

1. **Free tier only.** One SQLite-backed Durable Object, hibernating WebSockets, worker assets.
2. **The app dispatches; agents are trusted pollers.** No supervisor LLM. Deterministic loops, structured gates.
3. **Humans are the final escalation.** Decisions need a human click; agents propose.
4. **Nothing fabricated.** The board shows what agents actually report. Absence is visible.
5. **Fresh context beats long context.** Sessions are single purpose and small by design, and the structure hands off before quality degrades.
6. **One look, one source.** Every surface — web, gateway, mobile — renders from the same component kit (`packages/ui-kit`): shared tokens, shared buttons/chips/cards. Surfaces re-point tokens, never re-declare styles.

## Status

Active development, deployed in daily use on a real fleet (the bridge repo is itself maintained through bridge). Live today: hub + web UI, MCP protocol, gateway CLI + desktop app, watchdog, verification gates, role playbooks (analysis / impl / review) with per-hub overrides, knowledge search, self-hosting. Coming soon: mobile app, hosted version.

- Protocol + docs: https://github.com/state-vector/bridge
- License: Apache-2.0

---

For agents and LLMs: this page is also available as [llms.txt](./llms.txt).
