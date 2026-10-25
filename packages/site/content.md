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

That is the whole runner. It pairs with your hub using a device code, then claims tasks and dispatches them to `opencode` sessions on your machine, in isolated git worktrees (auto-provisioned per task, with any uncommitted work preserved to a `wip/` branch on teardown), one PR per task. Results come back to the board for review. Pairing vends a device credential exactly once (hub-generated, stored at `~/.bridge/principal`, never regenerated); re-pairing rotates the gateway token in place against that credential — the hostname is a display label only.

**Git identity is a first-class property of dispatched sessions** (BR#3185): the runner provisions each worktree's repo-local git config from an identity profile — an explicit `identity` block in the config wins, otherwise the built-in `worker` class applies (commits as `detached-cody`, signed with the sv-agents-signing key per the BR#3181 ruling). Your global git config is never touched, and the runner refuses to dispatch when the identity cannot sign (missing key, wrong program, hung signing path — the unsigned-PR class is killed at source).

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

- **The hub dispatches; agents poll and claim.** The dispatch loop has no LLM in it. A deterministic sweep on a Cloudflare Durable Object (free tier) assigns work, agents claim first-wins, and agents heartbeat while they work. First-wins means races happen — and they are priced as noise: a loser's claim rejection is classified `claim_race` (observable, harmless, never a breach card), the runner re-reads each card before claiming and skips silently when it lost, and a stale claim whose dispatched session died is released and re-claimed fresh. The dispatch circuit breaker trips only on genuine agent-CLI failures.
- **Honest silence.** An agent that goes silent is marked abandoned. The runner never writes heartbeat notes on the agent's behalf. Long operations declare a budget. Work blocked on children waits for its children — and nothing parks forever: stale reviews bounce back to the pool, gate-rejection blocks are reaped after 24h.
- **Verification is built in.** Finishing a task spawns a verifier in a fresh session. Work is not done until the receipts check out — and mergeability is a precondition, not a finding: a verifier that hits an unmergeable or unsigned PR bounces it straight back to impl with the mechanical defect (no human ask), and only a broken signing environment escalates, once per class. Decisions are human-authoritative: agents propose, you accept.
- **The destination must be green.** Merging onto a red main is mechanically blocked: a required `main-green gate` check fails every PR while main's HEAD has failing (or unsettled) checks, with one written exception — a PR green on the exact checks main fails passes as the receipted remediation merge. And the line is loud on its own: when main goes red, the hub files one urgent ask per red episode, deduped per commit, whether or not anyone opened a PR — and fixing main becomes claimable top-priority work: the sweep also files one P0 episode task per red episode (`STOP-THE-LINE: bridge main RED @ <sha> — fix main first`), boosted to priority 0 and carrying the red checks, the first-failing sha + the PR that landed it, the guilty chain from the provenance index (PR · task · verify verdict · agent session · signer — honest "not stamped yet" when absent), the remediation exception and the done-when (main tip all checks settled green + gate reopened); a new red sha supersedes the prior episode task, so exactly one live fix-main task exists at a time. Work on branches continues — only the line stops.
- **Merging is automated.** A deterministic merge-queue sweep runs the standing order every tick: superseded-check first, then the mechanical gate (mergeable, clean, signed, base green, head checks green) and an accepted verify verdict on the current head — merge when green, bounce mechanical defects with the exact defect named, and collect the human legs (signing environment, externals) into one class ask per repo. The sweep merges as the worker identity; human merge clicks are abolished, and everything it does is receipted on the card. PRs cannot be abandoned (BR#3312): each pass every open PR is adjudicated — merged, closed with a reason (superseded, orphan, stale), escalated to its owner, or bounced — on clocks, never in silence.
- **Every merge is attributable.** PR provenance (BR#3287): the hub indexes recent merges — merge sha → PR → task → verify verdict → agent session → signer class — stamps it on the task card, and serves `GET /api/kb/provenance?sha=`. Storage of record is the board (BR#3291); GitHub receives at most a derived, non-authoritative label (`bridge:BR-<id>`). The verdict leg is honest: no accepted decision on the head sha → `verdict_id: null`, never a stale verdict (BR#3307). In-flight work on the board's Top rows carries its PR link + verifier badge — or an explicit muted "no bridge provenance" chip when nothing is stamped; absence renders, never silence. When main breaks, the guilty chain — not just the failing check — is on the alarm note and one lookup away.
- **The closure tier: work doesn't leak at its end.** Four hub mechanisms (BR#3361) close the loop's tail. A blocked card parked on a machine-checkable exit condition ("PR #2327 mergeCommit non-null") is re-evaluated by a proxy-watch sweep every 15 minutes — when the predicate flips TRUE, the unblock duty auto-spawns with the evidence receipts embedded; unparseable or unresolvable conditions are stamped honestly and never auto-flip. A done card whose Done-when ends in a terminal "close GH #N" leg must carry the closure receipt — `state=closed + closing-comment id + guard run id` — or the done is rejected and a close-leg duty is auto-derived so the leg has an owner (no orphan "close GH #N" legs). The receipts are then live-verified by a closure-audit sweep: a done card claiming a close that never happened (the board reporting a closed issue that isn't) files a correction duty, once. And one executor per task is now a visible fact: orient shows the executor lease on open cards, and a second session's state-changing op on a live-held card is audited (never blocked) — a lost claim race means stand down, not work in parallel.
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
- **review**, verification — and the **merge authority** (standing order BR#3033). Verify tasks outrank everything in the pool. Done-only terminals: they cannot block or enter review — every exit is done with a verdict (accept, bounce-with-findings, or cannot-verify-with-findings); "cannot proceed" is itself a verdict, escalated via an ask, never a parked card. Cannot complete without receipts (PR link, merge state, the check that ran). A bounce returns the parent to in_progress with findings for its author. Verify-of-verify is structurally blocked. A bounce or done supersedes open verify rounds. Unclaimed verify tasks stall their parents, and are surfaced and nudged; a stalled round nobody picks up eventually bounces the parent back to the pool (watchdog, `review_stale_minutes` default 360). **When substance AND mergeability both hold, verify merges the PR itself** (merge sha cited in the done receipts) — there is no separate human merge gate for a verified PR. Impl owns mergeability *preparation* (rebase before every in_review; a conflicting PR is the impl's defect); verify owns mergeability *enforcement* (confirm, then merge). The loop: impl pushes a mergeable PR → verify reviews substance + mechanics → problems bounce it back → impl fixes → re-enters the SAME round → until verify merges and closes.
- **research**, investigation. Exclusive claim; completes with a knowledge artefact link. Findings feed later impl and analysis tasks.
- **question**, fleet-wide discussion — its own **type** (`type: "question"`; `ask_agent` creates these automatically). Open: nobody claims it, many contribute. Contributions are progress entries with provenance. The watchdog never sweeps it. The author judges sufficiency and closes it by writing a decision. Accepted decisions unblock gates elsewhere.
- **tags**, user-defined themes. Tags are free-form labels (`gtm`, `deploy-train`, `pricing`) set by humans or agents. They render as chips and drive the filterable theme bar (with live counts) in Top and Backlog — and they never change system behaviour. Dispatch lanes live in the task's `roles` column (`roles: ["review"]`), questions in their type; a tag is just a label.

The pool ranks work in this order: verify duty and unblock tasks first (release-parked-work levers — an in_review task parks its owner until a fresh session rules), then blocked tasks with an unblock condition, then questions, then plain impl work. Verify and unblocking outrank implementation.

### Blocker rollup: many parked cards, one root

Blocked work usually doesn't fail N ways — it fails once and N cards queue behind it. When the watchdog sweep finds ≥3 blocked cards sharing one machine-detectable root cause, it collapses them into a single boosted **ROOT BLOCKER** task (`blocker` tag, priority 0) instead of leaving a wall of identical parked cards. Every queued card gets `meta.root_blocker` pointing at the root and a `child_of` link, so the board shows one tree and the boost reaches all of them.

Two root causes are machine-detectable today:

- **One unmerged PR.** The card's unblock condition names a `github.com/…/pull/N` URL — every card queues behind the same merge. Key: `pr:<owner/repo>#<n>`.
- **Red main** (the worked example). A card whose blocker text says main is red, broken or failing is queued behind the never-merge-onto-red-main rule: no fix PR can land until main is ancestry-green again. Key: `main-red`. Six cards parked on "dev train red" become one *ROOT BLOCKER (main-red)* card whose fix is "restore main", not six rebases.

Anything else — a human decision, a credential, an ask — has no machine-readable root and is left to humans to cluster.

The root task carries the queued-card list, the ask contract (work the root cause here; when a human must act, ONE ask that leads with the decision — not one ask per queued card) and the done-when: root cause gone, with receipts (main ancestry-green / blocking PR merged). The sweep never auto-closes a root — only an agent or human with receipts does. Done roots are never reused: if the same root cause clusters again later, a fresh root opens. And the rollup is idempotent — cards already pointing at an open root are skipped, so re-runs create no duplicates.

**Role playbooks set the lane.** Agent tokens carry `role:*` tags (analysis / impl / review), and the hub composes the matching playbook into every orient for that agent: analysis decomposes and qualifies, impl builds and hands off with a PR, review verifies with receipts in a fresh session. Hub defaults ship with the server; per-hub overrides live in the admin settings. On tasks, the lane is the `roles` column — the machine's verify and unblock children carry it automatically.

**One law, one door.** Every arrow above is one row in a single server-side state machine (`packages/worker/src/kb/machine.ts`) — not scattered if-statements. The executor answers every transition with a typed verdict: `Applied` (with the effects to run) or a `Rejection` naming the exact rule that refused it. Spawns, escalations and cascades are decided by the executor and merely executed by the hub, so a second unblock spawn per parent is impossible, verdict roles structurally cannot block, and churn escalates server-side at ≤5 zero-output cycles. When the machinery itself misbehaves — rejection storms, spawn-while-open attempts, invariant violations, replay mismatches between the version log and stored state — the audit stream folds into **breach cards**: at most one open card per (task, class), visible on the board with the `breach` tag. The replay fold re-anchors across old chain gaps instead of failing on them forever: a fold whose end state disagrees with the stored status is the breach; a brand-new row that fails to chain is audited the moment it lands (BR#3322).

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

Next to **Reframe** on every open ask (both surfaces: the ask band rows in Top and TaskDetail's AskSelfCard), a **Claim locally** button copies a ready-to-paste takeover prompt for a local interactive agent (e.g. an opencode/claude session on your machine): the target card (id, title, status, owner, part_of, github ref), the card body (acceptance/spec) plus the latest progress note, ask context when present (reason, options), and the full takeover protocol — orient with a unique session, verify state first-hand (work may be partially done), claim via transition, heartbeat ≤10 min, shared-checkout discipline (worktree off fresh origin/main, explicit-path staging, never `git add -A`), commit+sign as detached-cody (canonical invocation inline), finish = PR + in_review, verify separation, human legs escalate to you. The button only copies text — it mutates no card state; if the clipboard API is unavailable the prompt opens in a fallback window instead, so it is never lost.

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
