# BR#1012 — Verify duty for BR#41 (GH#1305 verdict-gate chronic reds umbrella): receipts live-corroborated, verdict BOUNCE

Session `br1012-verify-gh1305` (fresh session, separation of duties — the audited impl round ran in
`ses_ea8b3e98bffehkqy39g9CEeBb2`), 2026-10-20. Duty: double-check — not reimplement — the receipts of
the post-void deliverable round on BR#41 (PR state-vector/bridge#42) and close BR#41 done or bounce it
with findings.

## Verdict

**BOUNCE: BR#41 → in_progress with findings.** The round's deliverable is real and every receipt claim
survives independent live re-check (details below) — this is **not** a void round (BR#990/BR#996
precedents do not apply). But BR#41's umbrella acceptance is not met: the chronic red
`ghost_secret_logging` is **not fixed** (A3 impl child BR#1004 still todo in the pool), the close-gate
streak is **RESET** (BR#552 §3), streak certification is blocked on Q3 (coordinator, #1252), and the
10-21 nightly is expected red until the parse repair lands and deploys. Precedent: BR#1018 (BR#50
bounced while its gate signal was red). GH#1305 itself remains open (live-checked this session).

## Receipts checked (all re-collected live via `gh`, 2026-10-20)

### PR bridge#42 — deliverable vehicle
- `gh pr view 42 --repo state-vector/bridge`: **OPEN, unmerged** (`mergedAt: null`), author `rayh`,
  head `bridge/BR-41`, base `main`, single file `docs/BR-41-verdict-gate-night2-red-attribution.md`
  (+132/−0). Body matches the delivered doc. PR's own `Test` check **pass** (run 39364558617);
  `Workers Builds: bridge` **fail** is systemic repo-infra (also fails on open PR #43 — run
  39364940697 — not introduced by this PR).

### Nightly run receipts
- Run **39362021328** (10-20 03:00Z, `schedule`, `main @ c0a2e958e`): `conclusion: failure` — matches.
  Log evidence verbatim:
  - `ghost_secret_logging` panicked/FAILED both draws (03:06:40, 03:11:33) → **FF fail**;
    verdict `Unverifiable`, `ungrounded: ["pre_operation"]` (0/1 vs 74 nodes).
  - Guard parse WARN at **03:12:40.592930Z**: `Failed to parse guard verdict JSON — returning error
    verdict guard_id=failure-handling error=missing field 'principle_slug' at line 1 column 65
    response_len=82`.
  - Dead-code warning: `function is_principle_slug is never used` at `1247 | fn is_principle_slug(...)`
    — the unwired helper, exactly as claimed.
  - Summary line verbatim: `review_quality verdicts: 16 pass, 1 fail by majority of draws; 0/17
    flipped between draws 1 and 2`.
- Run **39192638477** (10-19 03:00Z, `main @ 8862bcce`): `conclusion: success`. Same parse WARN fired
  **3×** at exactly 03:05:51 (response_len=70), 03:09:53 and 03:14:48 (response_len=82) — the
  "majority-masked" claim holds. Summary line verbatim: `17 pass, 0 fail; 2/17 flipped`; the flipped
  scenarios confirmed by name: `ghost_secret_logging FPP`, `ghost_fire_and_forget FPP`.

### Deploy receipt (Q2)
- Dev deployment **7190387232** (state-vector/superpositional): `environment: dev`, sha `c0a2e958e`,
  created 2026-10-20T03:00:54Z — **equals the red run's head SHA** → the red drew against the deployed
  fix stack; red is real, not deploy lag.

### Fix-stack containment
- All five fix PRs re-checked via `gh pr view`: #1922 MERGED 2026-10-15T21:41Z, #1923 MERGED
  2026-10-15T21:42Z, #2005 MERGED 2026-10-17T04:50Z, #2007 MERGED 2026-10-17T04:44Z, #2015 MERGED
  2026-10-17T05:20Z — all ancestors of the 10-20 head by merge date (22 commits between the two run
  heads via compare API).

### Public trace
- GH#1305 comment **6282661533** (by `rayh`, 2026-10-20T03:29:44Z) exists and carries the audit
  headline. GH#1305 itself: **open**, title matches the umbrella scope (pydantic_silent_coercion,
  ghost family, hyperswitch).

## Does the work match the task?

Yes for the round as scoped: BR#41's post-void deliverable was the **A1 attribution of record** (per
the BR#594 child plan, `docs/BR-594-verdict-gate-chronic-reds-and-residual-gaps.md`), and PR #42's doc
is exactly that — night-2 red audited, root cause pinned receipt-grade, A2 no-go (pydantic PP/PP both
nights), A3 GO with a pinned impl spec (canonical child **BR#1004**, pool), A4 partial. The doc's
conclusions match my independent re-check line-for-line; no overclaim found. Decision BR#1010
(proposed, with duplicate BR#1011) records it.

## Why bounce, not done

1. **The chronic red persists.** `ghost_secret_logging` failed both 10-20 draws; the fix (A3
   parse-repair) is an unstarted impl child (BR#1004; duplicates BR#1006/1007/1009 marked do-not-claim,
   superseded housekeeping). Until it lands + deploys, the next close-gate night (10-21) is expected
   red — BR#41's umbrella purpose (chronic verdict-gate reds resolved) is unmet.
2. **Streak state is reset and uncertifiable.** BR#552 §3: red night resets the 2-green-nights close
   gate. Q3 (green-with-flips semantics, coordinator #1252) blocks streak certification even for a
   future green — the doc itself says the 10-21+ audit waits for a fresh review session after Q3.
3. **PR #42 is open-unmerged.** Acceptable for a record PR at verdict time (precedent bridge#43/#40),
   but the umbrella state is unsettled on top of it.
4. **Issue closure is coordinator-owned** — GH#1305 stays open; the doc explicitly defers closure.

## What continues (owned, do not fork)

- **BR#1004** (canonical A3 impl child, pinned spec: strict-then-lenient `principle_slug` recovery via
  the unwired `is_principle_slug` helper at guards.rs:1247, or fail-loud-and-retry; red-first test on
  the exact 70–82-byte malformed payload class; `cargo test -p lambda-cortex` green; ≥6 clean live
  draws per ghost scenario). Duplicates BR#1006/1007/1009 superseded by this verdict (BR#875
  housekeeping precedent).
- After fix + deploy: fresh A4 streak audit (10-21+ nights), Q3 answer via coordinator (#1252),
  then GH#1305 closure by the coordinator.

*Bounce transition note carries the receipts summary; this file is the full record.*