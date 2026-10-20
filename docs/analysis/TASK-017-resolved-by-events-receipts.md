# TASK-017 — resolved by events: guard + judge models already on main (receipts, 2026-10-20)

Task: "Not done: the guard model + judge model changes are on unmerged branches — main still has old models."

**Verdict: premise stale — nothing to implement.** A PR from the named branches would *regress* main. Every numbered item in the card is already landed. Fresh-session receipts below (all collected live this session, 2026-10-20, via `git fetch sp` + `gh api` against `state-vector/superpositional`).

## 1. Guard models on main — sweep-selected, no Nova Micro

`packages/agents/guards/<guard>/agent.toml` on `sp/main`:

| template | model on main | prices (in/out per M) |
|---|---|---|
| failure-handling | `eu.amazon.nova-lite-v1:0` | 0.06 / 0.24 |
| readability | `openai.gpt-oss-120b-1:0` | 0.14 / 0.56 |
| delivery | `zai.glm-4.7-flash` | 0.07 / 0.4 |

All `verdict_tool = true` (GH #1323 anti-fabrication tool intact). Carried by **merged** PRs:

- **#1913** — MERGED 2026-10-15T09:19:41Z (sweep apply, all three tomls)
- **#1943** — MERGED 2026-10-16T09:47:33Z (re-selection: failure-handling → nova-lite + variance-gate rework)

Matches accepted decision **BR#1092** (TASK-015 resolution) and the BR#572 analysis.

## 2. Judge model on main — Claude Sonnet 5.5

`packages/agents/meta_review/judge/agent.toml` and `meta_review/irr/agent.toml` on `sp/main`:

```
model = "eu.anthropic.claude-sonnet-5-5"
```

Carried by **merged** PR **#1863** — "fix(eval): the meta-review judge is Claude Sonnet 5.5 — anthropic free roster" — MERGED 2026-10-15T00:09:49Z. `nemotron` survives on main only as eval-roster candidates (`packages/eval/src/models.rs`, `eval-selection.json`) and a historical comment (`family.rs:106`: "GH #1602: nemotron replaced by claude-sonnet").

## 3. Stale branches — superseded, do NOT open PRs from them

- **`fix/judge-claude-anthropic-free-roster`** — no longer exists on the `sp` remote (`git fetch` → `couldn't find remote ref`).
- **`fix/guard-model-upgrade`** — exists but is a stale lineage: all three guard tomls on the branch pin `eu.amazon.nova-micro-v1:0` (the old models). No open PR uses it (checked `gh pr list --state open`); a PR from this branch would **revert main to Nova Micro**. Superseded by #1913/#1943.

## 4. Remaining card items — also landed

- **PR #1908** (trailing-30d trust rate) — MERGED 2026-10-15T07:34:50Z, not open.
- **PR #1896** (precision eval, clean-fixture FALSE-FLAG floor) — MERGED 2026-10-16T07:55:14Z (see TASK-012 verification).
- Trailing-30d rate at 16% ≈ cumulative is expected arithmetic: the 30-day window still includes the pre-fix period; it improves as the window slides. No action.

## 5. Residual (owned elsewhere — do not fork)

- **BR#847** (in_progress): `scripts/review-guards.ts` pins `MODEL_ID = "eu.amazon.nova-micro-v1:0"` — the nightly Guard Fixture Gate draws all guards on Nova Micro and cannot observe the upgrade. Owned task; not in TASK-017's slice.

## Disposition

TASK-017 → in_review on this receipts record. No code change, no behavioural change; docs/README untouched.
