# BR#568 — Deploy-train stall on GH#1258 canary: unstick owner + blast radius

Finding under review (from BR#567 / BR#606): scheduled Product Surface Canary run
39177616992 (2026-10-18T23:42Z) was RED solely on `C6.deploy_lag` — the dev deploy
train was stalled with a 15-commit backlog (oldest `af90ea68f5ed`, 2026-10-17T06:16Z,
waited 41.4h; deployed dev SHA `528f837bcfeb`).

## Verdict (live verification, 2026-10-20, session BR-568-deploy-stall-confirm-1)

1. **The stall self-resolved on 2026-10-19; no dedicated "unstick owner" was appointed
   and none was needed.** Recovery happened through the coordinator's merge policy, not
   through a named owner lane.
2. **Blast radius was real and wider than #1258** — at least four other gates were
   deploy-gated by the same train in the stall window (2026-10-17T06:16Z → 2026-10-19T05:53Z).
3. **Current state: train healthy.** Latest scheduled canary run 39361155981
   (2026-10-20T02:51Z): `DEPLOY TRAIN — GREEN (4 pass · 0 fail · 0 unknown)`,
   `C6.deploy_lag PASS` (deployed `64b54c9d132c`); main (`c0a2e958e7`) is **1 commit**
   ahead of deployed dev. 10 consecutive scheduled canary runs are success
   (2026-10-19T17:44Z → 2026-10-20T02:51Z).

## Who owned the unstick

- **No agent or lane owns "unstick the deploy train"** — no Bridge artefact or issue
  appoints one, and the failing step (Deploy Dev runs) is human-coordinator territory.
- Ownership sat with the **human coordinator (Ray) via accepted decision BR#551**
  ("Merge policy: never merge onto red main", 2026-10-19): main's Deploy Dev for
  `e8d8661b` was red on **GH#2045** (lifecycle-soak I2, duplicated `_edges` ×2→×8 —
  regression from PR #1984's supersede deferral); the policy froze all other merges and
  designated the hotfix lane as the only path to a green deploy.
- **Recovery was operational, not manual:** every Deploy Dev run in the window is
  `push`-triggered — **zero `workflow_dispatch` runs** (receipt: run list 2026-10-18 →
  2026-10-20). The unstick was a hotfix chain under the BR#551 policy:
  - PR #2052 (the #2045 fix, "retire superseded sources so re-index equals from-scratch")
    merged 2026-10-19T01:11:36Z (`7c4fdda84c`);
  - follow-on fixes `d77a7cad2c` (narrative fixture re-grounding), `8862bcce5a`
    (dogfood org declaration), `9f466b469c` (GH#1870 structured defects), `2af45e110a`
    (GH#1976 known-issue skip) each cleared the next failing check;
  - **first green end-to-end Deploy Dev: run 39206837283, 2026-10-19T05:53Z**
    (`2af45e110`) — receipts BR#560, BR#868.
- Sustained green followed: 12:15Z (`d1a743e2`), 13:04Z (`d4fe6514`), 15:45Z
  (`8784f040`), 21:22Z (`23279339`), 21:55Z (`5b11b1d508`), 23:35Z (`64b54c9d13`).

## Blast radius (other GTM gates blocked by the same train in the window)

| Gate | Blocked by | Receipt |
|---|---|---|
| GH#1258 itself | PRs #1994 (C1) + #2014 (C3) merged but undeployable → 7-day streak could not start (0/7) | BR#567, BR#868 |
| GH#1255 (C3 chunking) | chunking re-index is deploy-gated; dogfood re-index ran on pre-chunking `528f837bc` | BR#299, BR#301 |
| GH#1474 | dev re-index verification deploy-gated; card records "deploy-train unblock 2026-10-19" | BR#560 |
| OSS-eval oracle | fix `dbd3c6ad6` on main awaited any completed deploy to reach dev | BR#126 |
| Whole merge pipeline | BR#551 froze all pending merges until main deployed green | BR#551 |

Adjacent-but-separate (do NOT attribute to this train): **prod-behind-main GH#1116**
— that is the human-gated prod tag train (last tag `r2026-10-15`, ahead_by 175),
a different lane from the dev deploy train (BR#448, BR#531).

## Consequence for GH#1258 now

The deploy-train blocker is gone: #1994/#2014 fixes are live and credited (C1
all-green ×9 per BR#868). Remaining reds on the canary are owned elsewhere — C2 →
#1980, C3 ask-draws → #1255 (with an open re-index question), C4 checks → unmapped /
candidate GH#1850 (BR#868). The 7-day green-streak close condition is now running on
the full `canary`-triggered nightly ledger.

## Out of scope (respected)

No deploys, no code changes, no issue closures. Analysis receipts only.
