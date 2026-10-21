# BR#60 / GH#1687 — token vending error burst: closure-gate receipts + acceptance criteria map (2026-10-21 refresh)

Task: BR#60 (`#qps GH#1687 — githubtokenvending error burst recurred`) · Issue: [state-vector/superpositional#1687](https://github.com/state-vector/superpositional/issues/1687) (gtm-blocker, issue:stability) · Session: `br60-gh1687-analysis-review`

Scope: analysis only. No implementation, no deploy, no closure action in this session (per task decomposition). The full root-cause evidence map is BR#394 (done, verified by accepted decision BR#994); this doc refreshes its receipts to 2026-10-21 and restates the acceptance criteria map.

## Verdict status: closure gate UNMET on all three legs (as of 2026-10-21)

Identical to the verdict-of-record BR#1023 (accepted BOUNCE) and BR#1046's 2026-10-20 live check. Nothing landed in the last ~24h.

## Fresh live receipts (this session, `gh` CLI, 2026-10-21)

| Leg | Receipt | State |
|---|---|---|
| Fix PR | [state-vector/integrations#2](https://github.com/state-vector/integrations/pull/2) (`x1b/1687-vend-structured-errors`) | `OPEN`, `mergedAt=null`, `mergeCommit=null`, `mergeStateStatus=CLEAN`, `reviewDecision=APPROVED`, updatedAt 2026-10-16T07:33:10Z |
| Issue | superpositional#1687 | `OPEN`, `closedAt=null`, updatedAt 2026-10-18T12:53:15Z |
| Production deploy (integrations) | latest production deployment | 2026-06-03T22:12:03Z, sha `55d3a6c`, id 4925665599 — predates both the 2026-10-12 recurrence and the fix PR head |

## Root cause (recorded; unchanged)

`providers/github/functions/token-vending/src/main.rs` `handler()` returned `Err` on every error path with zero handler-side emission; the only failure record was the `lambda_runtime` unhandled-error line, whose text lands in a field the Datadog forwarder does not map to `message` — hence the "32x empty message payloads" burst in prod 2026-10-12.

Fix (integrations#2, commit `6e456bf` on `55d3a6c`): structured ERROR on every failure path — `error_kind` (exhaustive match; new variants fail compile), `requires_engineering` (true only for config/internal/aws), `caller_action` (attributed guidance), `installation_status` (absent vs inactive at TenantNotFound's two origin sites), `request_id` in span. No vend semantics change. Receipts: cargo test -p github-token-vending 11 passed / 0 failed; clippy clean of new classes; CI SUCCESS; APPROVED review. Source: BR#171 (X1-B exec), corroborated BR#180/BR#632.

## Acceptance criteria map

**Fix/PR criteria — all MET (per BR#394/BR#994):**
1. Structured error emitted on every failure path — met (commit 6e456bf).
2. `error_kind` exhaustive over failure classes — met (compile-enforced).
3. `requires_engineering` true only for config/internal/aws — met.
4. `caller_action` attributed guidance per class — met.
5. `installation_status` distinguishes absent vs inactive at both TenantNotFound origin sites — met.
6. No vend semantics change; tests green — met (11/0, CI SUCCESS).

**Closure criteria — all UNMET (coordinator/Ray-gated, by design out of agent hands):**
1. integrations#2 MERGED — unmet (OPEN, CLEAN, approved; awaiting merge).
2. Dev-first deploy of the fix — unmet (no deployment newer than 2026-06-03).
3. Datadog verification of `@error.kind` / `@caller_action` fields on dev — unmet (blocked by 2).
4. Production deploy + observed-green receipt (no token-vending error-burst recurrence) posted on GH#1687 — unmet (blocked by 1–3).

## Coordination

- Merge + deploy are coordinator-only (Ray): recorded in BR#632, BR#180, BR#60 meta.
- Open ask ASK-mvg4y9fn-xiex is bound to BR#60; it auto-resumes when answered.
- Unblock condition (BR#60 meta): integrations#2 MERGED + production deploy carrying `x1b/1687-vend-structured-errors` (or newer) + observed-green receipt on GH#1687 — then a fresh verify round closes BR#60 done. Any leg landing re-enters the pool.

## Findings this round

1. Gate state unchanged vs 2026-10-20 (BR#1046): three independent sessions (BR#632 2026-10-19, BR#1046 2026-10-20, this session 2026-10-21) agree on all receipts — no contradictions.
2. bridge#38 — the record PR carrying BR#394's full evidence map — is CLOSED **unmerged**, so the base map lives only in knowledge records (BR#394 artefact + accepted decision BR#994), not on `main`. This doc is self-contained to cover the gap.
3. No agent-runnable work remains on the closure gate; it is operator-gated on all three legs. The correct terminal state for this round is in_review handoff (auto-spawns a fresh-session review child per separation of duties), not done.
