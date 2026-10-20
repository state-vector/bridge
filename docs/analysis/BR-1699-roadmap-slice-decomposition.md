# BR#1699 — Roadmap slice decomposition record (mobile app + hosted version)

Session: `BR-1699-decomp-session-1` · 2026-10-20 · task BR#1699 (child_of BR#139, leg (a) impl slice).

## Source

`packages/site/content.md:138` — "Coming soon: mobile app, hosted version." The published hosted promise
is the pricing table at `packages/site/content.md:116-126` ($5/month, "We run it, zero infra", runners
stay on customer machines, surfaces incl. mobile, waitlist via a "waitlist" discussion).

## Decomposition (4 child cards, all `child_of:br-139`, project: bridge)

| Card | Roadmap item | Role | Unit |
|---|---|---|---|
| BR#1766 | mobile app | role:analysis | iOS-shell readiness constraints map (distribution, signing, notifications, connect flow, copy plan) |
| BR#1767 | mobile app | role:impl | Native iOS shell (Tauri 2 iOS target) wrapping `packages/mobile/ui` |
| BR#1768 | hosted version | role:analysis | Hosted-offering gap map, reconciled with the TASK-004 billing lane |
| BR#1769 | hosted version | role:impl | Hosted pilot slice 1 per the gap map (billing substrate consumed, not rebuilt) |

Relations: BR#1767 depends_on BR#1766; BR#1769 depends_on BR#1768 and depends_on TASK-004;
BR#1768 relates TASK-004; BR#1766/BR#1767 derive from accepted ADR BR#998.

## Why this shape

**Mobile** — architecture is already settled: accepted ADR BR#998 (separate minimal dists per surface,
no isTauri forks, mobile-ui stays hub-REST-only) and BR#630 delivered the browser-first mobile UI
(`packages/mobile/ui`: Fleet + For You tabs, hub-URL connect; PR
https://github.com/state-vector/bridge/pull/40 removed the last isTauri fork). The ADR explicitly stages
the native iOS shell (Tauri 2 iOS target, Rust dispatch/notification core carry-over) as the remaining
"coming soon" unit. So: one analysis child for the human-gated/unknown execution constraints (signing,
TestFlight, notifications), one impl child bound by the ADR. Re-opening the reuse strategy is out of scope.

**Hosted** — no settled design exists (unlike mobile), so the slice leads with an analysis child producing
a gap map: tenancy model vs the single-DO free-tier principle, onboarding, billing surfaces, ops runbook,
copy plan. The impl child consumes slice 1 of that map.

## TASK-004 billing reconciliation (routed, not forked)

TASK-004 (billing-ledger refactor) is code-complete and merged: one `BillingLedgerTable`, balance
folded-on-write (one writer), Stripe demoted to grant-event authority, reconciliation detection-only,
Copenhagen repointed to ledger reads. The hosted slice CONSUMES this substrate. TASK-004's outstanding
legs — operator parity-verify (`billing-backfill --apply` then `--verify` per stage) and the SFN
severed-wire build-time guard — remain TASK-004-owned. BR#1768 records the reconciliation as an analysis
input (relates TASK-004); BR#1769 depends_on TASK-004 for billing-touching legs and forbids ledger
schema/behaviour changes in its diff.

## Overlap dispositions (no forking)

- **TASK-016** (board UX pass — rich cards, side panel, hybrid search; PR https://github.com/state-vector/bridge/pull/16): webapp board UX. All four children exclude webapp/desktop shell changes.
- **BR#900 family** (runner pipeline integrity): unrelated to both roadmap items; excluded.
- **TASK-004**: billing lane — dependency, never re-implementation (see above).
- **BR#559/560/561**: taken by unrelated tasks (BR#55 GH#1474 impl children; BR#52 GH#1777 analysis child) — fresh IDs used, per the BR#139 re-issue note.

Verification of this slice set routes through BR#1700 ("BR#139 verify child: roadmap slice set + roles/playbooks PR receipts", role:review) — no additional verify children were created, to avoid duplicating owned review work.