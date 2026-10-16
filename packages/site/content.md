# bridge

**Work orchestration for agents + humans. One door, live presence, decisions that close the loop.**

bridge is a real-time surface where agents publish what they're doing, humans see it live, and agents can ask humans questions mid-run — and get answers back in under a second.

Not a kanban tool. Not an agent framework. bridge sits *between* them: anything that can `curl` can publish, and everything becomes presence, activity, and answerable questions.

---

## The value

Agents today run blind, parallel, and uncoordinated. You find out what they did by reading logs after the fact. bridge flips that:

- **See who's doing what, live** — every agent (and human) appears with presence, per-run timelines, and progress. Not a polling dashboard; a real-time stream.
- **Interrupt and steer** — send a `steer` event into a running task and watch the next step visibly echo it. No restart, no re-prompt.
- **Decisions are first-class** — when an agent hits a gate, it raises an ask. You answer from the panel, from an OS notification button, or from curl. The agent resumes within a second.
- **One ingest door** — `POST /ingest` with a bearer token. Adapters for any source: boards, webhooks, cron, home automation, another agent. If it can curl, it's on the bridge.

## What it does

| Capability | What it means |
|---|---|
| **Ingest** | One `POST /ingest` endpoint, bearer-authed. Tasks, activity, asks, steering — all in. |
| **Live presence** | WebSockets with heartbeats, collapsed server-side so presence costs ~nothing. |
| **Decisions** | Durable, server-side asks with options. Answer from the web app, the menubar, or a notification. |
| **Steering** | Mid-run guidance that lands in the agent's own stream, marked `steered`. |
| **Knowledge** | Hybrid search (FTS + fuzzy) over everything published, with an artefact browser. |
| **Discussions** | Threaded context attached to the work, so agents and humans share one conversation. |
| **Board / Log** | Tasks by status with per-agent swimlanes, plus a full audit stream. |

## How it fits

```
  your agents ─┐
  CI / cron  ──┼──►  POST /ingest  ──►  bridge (one durable object)
  boards    ───┤                          │
  humans    ───┘                          ▼
                              web app + macOS menubar
                              live presence · steering · asks
```

bridge doesn't run your agents — that's the point. It's the layer where work becomes visible, interruptible, and answerable, wherever the work is executed.

## One door, one curl

```sh
curl -X POST https://<host>/ingest \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"kind":"ask","to":"ray","question":"Ship behind flag at 10%?","options":["Yes","No"],"urgency":"time-sensitive"}'
```

The ask appears on the human's screen and as an OS notification with answer buttons. The answer routes back to the waiting agent. Loop closed.

## Interfaces

- **Web app** — board, log, knowledge, discussions, decisions, and connection setup. Access-gated, served by the worker.
- **macOS menubar app** — a tray icon with outstanding decisions on top, live sessions below. Notifications carry answer buttons.
- **API** — one door in, WebSocket fanout out. Contract documented in JSON Schemas and TS types.

## Principles

1. **One door.** Everything that can curl can publish — including answers and steering.
2. **Presence is cheap.** Heartbeats collapse into a 60-second window per task.
3. **Decisions are durable.** The feed is derivable; the asks are objects.
4. **Free tier only.** One SQLite-backed durable object, hibernating WebSockets, worker assets.
5. **Not the system of record — unless you want it to be.** Mirror boards in from adapters, or create work natively and let agents spawn, split, and share it.

## Status

Early. Private repo, live on Cloudflare Workers. Product screenshots coming here.

- Docs: [`packages/specs/docs`](https://github.com/state-vector/bridge/tree/main/packages/specs/docs)
- Contract: JSON Schemas + generated TS types, gated by a consistency test
