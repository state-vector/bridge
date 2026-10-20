# BR#1005 — Re-verify receipts: BR#60 (#qps GH#1687 token vending)

**Verify target:** BR#60 — `#qps GH#1687 — githubtokenvending error burst recurred`
**Verify duty:** BR#1005 (re-verification; prior round BR#863 VOID)
**Session:** ses_ea8a2550affe3Q4Kaej4V2vEIB (opencode-ray, 2026-10-20)
**Verdict: BOUNCE — BR#60 bounced in_review → in_progress; closure gate NOT met.**

## Why this re-verification exists

Prior verify round BR#863 (done) is **void** (BR#877 rule): its own duty body cited
`https://openrouter.ai/workspaces/default/guardrails` — the guardrail error page — as the
"PR" receipt, and it closed done with zero live checks (runner self-close, 0 receipts,
pattern BR#859). The verified dispatch performed no work. BR#1005 re-verifies against
documented state: BR#632 (openhands-cody2, live receipts 2026-10-19) and BR#397's earlier
bounce verdict (PR open ≠ closed).

## Live receipts collected 2026-10-20 (gh CLI, session ses_ea8a2550affe3Q4Kaej4V2vEIB)

### 1. Fix PR — state-vector/integrations#2 — NOT MERGED

https://github.com/state-vector/integrations/pull/2

```
title:              fix(token-vending): structured ERROR on every vend failure path (superpositional#1687)
state:              OPEN
mergedAt:           null
mergeCommit:        null
mergeStateStatus:   CLEAN
headRefName:        x1b/1687-vend-structured-errors
baseRefName:        main
updatedAt:          2026-10-16T07:33:10Z
comments:           [] (zero comments)
```

### 2. Tracking issue — state-vector/superpositional#1687 — OPEN

https://github.com/state-vector/superpositional/issues/1687

```
state:      OPEN
closedAt:   null
updatedAt:  2026-10-18T12:53:15Z
```

Last substantive thread activity (2026-10-16T08:16:57Z, detached-cody):
"X1-B deliverable complete … PR state-vector/integrations#2 — structured ERROR on every
vend failure path … Compile + 11/11 tests green". Issue-claim complete note states:
"merge+deploy is Ray's call". **No coordinator closure comment, no merged-PR receipt,
no prod deploy receipt in the thread.**

### 3. Deploy evidence — NONE for the fix

`state-vector/integrations` production deployments (latest 5 via API):

```
2026-06-03T22:12:03Z  production  main  55d3a6c
2026-05-23T14:21:32Z  production  main  e48b95b
2026-05-22T07:01:28Z  production  main  1b577a5
2026-05-13T13:46:35Z  production  main  6a32817
2026-04-15T13:31:06Z  production  main  013ed5c
```

Latest production deployment is 2026-06-03 (`55d3a6c`) — four months old, predating both
the 2026-10-12 error recurrence and the fix PR. **The fix has never been deployed.**

## Verdict

The closure gate per the issue's own terms — **merged PR + prod deploy + observed green,
Ray's call** — is NOT met on every leg:

| Gate leg | Required | Live state 2026-10-20 |
|---|---|---|
| Merged PR | integrations#2 merged | OPEN, mergedAt=null, mergeCommit=null |
| Prod deploy | deploy of the fix | none; last prod deploy 2026-06-03 (55d3a6c) |
| Observed green | burst gone on prod | nothing recorded; no deploy → nothing to observe |

**What is still missing (bounce findings):**
1. Ray merging state-vector/integrations#2 (mergeStateStatus CLEAN — it is merge-ready).
2. A production deploy of integrations carrying the fix.
3. Observed-green receipt posted to the issue thread.

BR#397's bounce verdict holds; BR#632's receipts (2026-10-19) remain accurate as of
2026-10-20 — no world-change since. BR#60 is bounced to in_progress pending Ray's
merge+deploy; do not re-run verify until the gate legs are actually recorded on GitHub.

## Void citation (for the record)

- **BR#863** (verify duty, done, closed 2026-10-20T? — seq ~1792448188207): duty body
  itself embedded `https://openrouter.ai/workspaces/default/guardrails` as the "PR";
  closed done by runner handoff with no PR link, no live checks, no receipts → void
  (BR#877: no URL that is not a GitHub PR/issue/run URL; BR#859 pattern).
- **BR#60's in_review state** that this re-verify bounced was itself set by the same
  void round's runner handoff ("runner: handed off to in_review — complete").