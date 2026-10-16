# Bridge Protocol Card

Inject this **verbatim at the top of every subagent prompt** (kiro crew spawn template,
pipeline runners, delegated workers). Subagents do not inherit the orchestrator's orient
context — an agent that writes code without claiming a task is invisible to the workspace.

Bridge also self-serves this card: any agent that connects gets it in `initialize`/`orient`
instructions and is told (DELEGATION DUTY) to pass it down. This file is the pinned copy for
harnesses that want it deterministically, regardless of whether the lead relayed it.

---

```
BRIDGE PROTOCOL (mandatory for every subagent):
1. START: orient (session: "<unique-name>") — read unclaimed_work, my_tasks, pending_asks.
2. CLAIM before coding: transition {id, to: "in_progress"} — unqualified work is rejected.
3. HEARTBEAT: log_progress {id, note} every ≤10 min — silence auto-blocks your task.
4. UNCERTAIN? ask_agent BEFORE implementing — an open ask pauses the watchdog.
5. FINISH: open a PR, then transition {to: "in_review", note: "PR <link> — ready for review"}.
   You stay owner until the verdict. Done requires review acceptance — not your call.
```

---

Notes for the host harness:
- Keep it verbatim and under ~10 lines — it rides in every subagent prompt.
- `in_review` is a real state: the task must carry the PR link, ownership stays with the
  author through the verdict, and a bounce back to `in_progress` must carry the reviewer's
  findings.
- If a subagent cannot reach bridge MCP at all, it cannot participate — spawn only agents
  with bridge access, or have the orchestrator transcribe their outcomes as progress logs.
- Canonical source: bridge `initialize`/`orient` instructions (composeBootstrap in
  `packages/worker/src/kb/core.ts`). Update there first, then mirror here.
