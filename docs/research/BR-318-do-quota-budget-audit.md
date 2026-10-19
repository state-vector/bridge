# BR#318 — Quota efficiency audit: DO row-read/write budget (KnowledgeHub)

**Deliverable type:** research (no code changes). Findings + ranked reductions + guardrails.
**Provenance:** static audit of `packages/worker/src/kb/do.ts`, `core.ts`, `mcp.ts`, `wrangler.toml` (branch base + re-verified on `fbc148d`), plus **live Cloudflare calibration** measured via GraphQL API by openhands-cody2 (2026-10-20) with Ray's `CLOUDFLARE_API_TOKEN`.
**Knowledge artefacts:** research `BR#635` (static audit), this doc (packaged receipt), BR#318 (task).

---

## 0. Executive summary

1. **The two named hot-path fixes hold.** `ensureSchema` is guarded once per isolate (`do.ts:61,472-473`); `agentScores` has a 30 s TTL cache (`do.ts:389`). **But** the `agentScores` cache is nulled by *every* mutation (`audit()`, `do.ts:2461`), so under fleet write traffic it recomputes on nearly every `log_progress` — the cache exists for quota and the invalidation undoes it.
2. **Measured usage (paid plan) is far under the included quotas today** (~1–8 % of the daily rows-read allowance), but the measured per-request cost is **~7× the static estimate** because `artefact_versions`/`events` grow without bound and every scan is a full-table scan — **there is not a single `CREATE INDEX` in `kb/`**.
3. **First quota to pressure is requests** (browser board polling + 2 billed DO requests per MCP call + 1,440 alarm invocations/day), **then duration** (the 60 s alarm keeps the DO awake forever), **then rows read** as tables grow.
4. Top reduction is cheap: **one composite index + idle-stop on the watchdog** cuts ~1.5 M rows/day of zero-traffic cost and most alarm duration; **making the score cache TTL-only** cuts the dominant per-write fan-out.

## 1. Measured usage (CF GraphQL, namespace 6c42bb01…, KnowledgeHub DO)

| Day (2026-10) | rowsRead | Notes |
|---|---|---|
| 10-15 | 136 k | pre-watchdog baseline |
| 10-16 | 2.7 M | |
| 10-17 | 6.1 M | |
| 10-18 | 28.8 M | **outage day** (free tier: 5 M/day); peak hour 11:00 Z = 6.07 M |
| 10-19 | ~70 M | partial-day reading |

Idle DO cost (measured, no fleet traffic): **64 requests/h at 63.8 k rows/h ≈ 997 rows/tick** — consistent with the static estimate of the 60 s watchdog alarm (two full `artefacts` scans; static est. 2N+1 ≈ 1,333 at N≈666).
Active hours: **~100 k rows/request** — ~7× the static per-op estimate (~15 k), consistent with `artefact_versions` (V≈4–5 k, unbounded; e.g. BR#318 alone has 184 versions) and `events` (E≥4.7 k, unbounded) being much larger than assumed. **Treat the per-op numbers in §3 as lower bounds; the ranking is unaffected.**

## 2. Paid included quotas (CF docs, fetched 2026-10-19)

| Meter | Included / month | Per day | Overage |
|---|---|---|---|
| Rows read | 25 B | ~833 M | $0.001/M |
| Rows written | 50 M | ~1.67 M | $1.00/M |
| Requests (HTTP, RPC, WS-in 20:1, **alarm invocations**) | 1 M | ~33 k | $0.15/M |
| Duration | 400 k GB-s | ~3.2 M active s at 128 MB | $12.50/M GB-s |

Free tier (the outage cause): 5 M rows read/day, 100 k rows written/day.
Reconciliation: measured 10-19 (~70 M partial) ≈ **8 %** of the daily rows-read allowance — 500× the 10-15 baseline in 4 days. Paid headroom is real but eroding ~O(growth of V, E, N).

## 3. Per-op cost model (rows read/written per call — static estimates, lower bounds)

Symbols: N = artefacts (≈666–920), R = relations (~400), V = artefact_versions (~4–5 k, grows forever), E = events (~4–5 k, grows forever), A = asks (~80), T = tokens (~15). All queries are unindexed full scans unless PK/UNIQUE.

| Op | Rows read | Rows written | Dominated by |
|---|---|---|---|
| **Watchdog alarm (60 s, unconditional)** | 2N+1 ≈ **1.3 k** (measured 997) | 0 (re-arm `do.ts:104`) | runs with zero traffic → ~1.5–1.9 M/day idle |
| **log_progress** | **≈15 k measured-scale ≈100 k** | ~4 + FTS shadow (10–50) | `agentScores()` recompute: full `artefact_versions` + `events` scans + per-agent ask fan-out (cache voided by previous write, `do.ts:2461`); call path `do.ts:1532` |
| **orient** | ≈7N+3R+A ≈ **6 k** (×7 ≈ 40 k on score miss) | sessions upsert | 5 full-table count/open/pool scans + qualification evidence + `reapAbandoned` |
| **board() GET** | N + 3R + **520/f** ≈ **3.5–4 k** (×7 with score miss) | 0 | full `artefacts` scan ORDER BY updated_ts LIMIT 200 w/ `body_md`; progress = last 120 events; series = last 400 versions (no index on `op`/`action`); payload 0.3–0.6 MB |
| **transition** (to done/in_review) | ≈2R ≈ **0.8–1.5 k** | ~4 + FTS | `hasEvidence`: `child_of` by `dst_id` — no index on `dst_id` → full relations scan |
| **search / related** | FTS MATCH + **full `embeddings` scan (≈N)** | 0 | trigram fallback (Workers AI binding commented out in wrangler.toml) |
| **create** | **N** (nextSeq full scan, `do.ts:2465`) | ~4 + FTS + re-embed | `SELECT id FROM artefacts` + JS max() |
| **update** | PK + re-embed | ~4 + FTS | FTS trigger fires on **every** UPDATE (`do.ts:511`), incl. meta-only/heartbeat writes |
| **WS fanout** | 0 reads | 0 | outgoing frames not billed; connect replays 100 events |
| **every MCP call** | 1 (auth hash lookup) | 1 (`last_seen_ts` UPDATE, `do.ts:1628`) | 2 billed DO requests/call (identify + op) |

## 4. Per-day projection at current fleet activity

Assumptions: ~5 agents, ~240 progress/day, ~150 transitions, ~100 creates, ~100 orient, ~500 board GETs (polling), ~100 search, watchdog every 60 s. Measured-scale multiplier (×7 on scan-heavy ops) applied to the static mid-estimates.

| Source | Rows read/day (est.) | Notes |
|---|---|---|
| Watchdog idle | ~1.5–1.9 M | constant, even at zero traffic |
| log_progress | **~10–25 M** | 240 × score-recompute fan-out |
| orient | ~2–4 M | |
| board polls | ~3–14 M | biggest unknown: poll frequency × tabs |
| transitions/create/search | ~0.5–1 M | |
| **Total (mid)** | **~20–45 M/day** | ≈2.5–5 % of paid daily allowance; ≫ free tier 5 M/day — matches the outage |

**Which quota blows first:**
1. **Requests (~33 k/day included):** 1,440 alarm invocations + 2 per MCP call + board polling (one tab at 5 s = ~17 k/day). First cap to hit.
2. **Duration (400 k GB-s/mo):** the eternal 60 s alarm keeps the object warm; every request extends wall-clock.
3. **Rows read:** binds only at ~10–20× current scale *unless* the unbounded-scan shapes are fixed — then it binds everywhere at once because V and E grow monotonically.

## 5. Top 5 reductions (ranked by saving per behaviour cost)

1. **Index + idle-stop the watchdog.** `CREATE INDEX artefacts_type_status ON artefacts(type, status)`; skip re-arm when no in_progress/block-subprocess rows; re-arm inside `transition()` on claim. Saving: ~1.5–1.9 M → <0.1 M rows/day + ~1,400 requests/day + most alarm duration. Behaviour cost: ≤60 s extra first-tick latency after idle; risk = a missed re-arm silently disables the watchdog (the `fetch()` self-heal, `do.ts:624`, only covers a *null* alarm).
2. **Make the score cache TTL-only.** Stop nulling in `audit()` (`do.ts:2461`); the score is a hint, ≤30 s staleness is acceptable. Optionally bound the fan-out with indexes on `artefact_versions(action, ts)` / `events(op, ts)`. Saving: log_progress path ~10–25 M → ~0.5–1 M rows/day. Behaviour cost: score lags ≤30 s after a write; freshness tests change.
3. **Narrow the FTS trigger + skip no-op re-embeds.** `AFTER UPDATE OF title, body_md … WHEN` changed-check in `update()`; heartbeat/transition/meta writes stop re-indexing and re-embedding. Saving: 10–50 shadow writes per heartbeat × ~500 writes/day, plus CPU. Migration note: `CREATE TRIGGER IF NOT EXISTS` will **not** replace the existing trigger — needs DROP+CREATE gated by a settings flag.
4. **Shrink board payload + scan.** Drop `body_md` from the tasks projection; window progress/series feeds (24 h or per-task latest N) instead of global 120/400; add `(op, seq)` / `(action, seq)` indexes. Saving: reads ~4 k → ~1.5 k; payload ~0.5 → ~0.1 MB (also egress/CPU).
5. **Bound growth:** counter in `settings` for `nextSeq` (~N → ~2 reads per create); prune `events`/`artefact_versions` beyond a retention window after rolling daily aggregates; add `artefact_versions(artefact_id)` (get_history is a full scan) and `relations(dst_id)` (hasEvidence). Saving: converts the linear-growth cliff into flat cost. Behaviour cost: history/audit beyond the window is gone — window length is Ray's call.

Smaller: throttle `identify`'s `last_seen_ts` write (1/M/token, not 1/call) and the sessions upsert; WS connect with `since=0` replays 100 rows per connection (matters for reconnect storms).

## 6. Guardrails to enforce in code (follow-up tasks, not this one)

- **Per-op row budgets asserted in tests.** `ctx.storage.sql.exec()` cursors expose `rowsRead`/`rowsWritten` (verify on the pinned workerd). Assert e.g. board ≤5 k reads @N=1000 fixture; log_progress ≤2 k reads ≤20 writes; watchdog tick ≤100 reads when nothing stale; orient ≤10 k.
- **Daily usage counter artefact.** Accumulate rowsRead/rowsWritten/requests per op in memory; flush to a `usage_daily` settings key every ~5 min or at alarm time (1 write/flush); expose via `stats.usage` for the admin UI.
- **Lint gate for unbounded scans:** fail on `SELECT … FROM artefacts|artefact_versions|events` without an indexed WHERE or LIMIT (would have caught `nextSeq` and `agentScores`).
- **CF dashboard alerts:** usage notifications at 50 %/80 % of included rows read/written, requests, duration (account action for Ray).
- **Gate the cold-start UPDATEs** (`do.ts:611-613`): two full-table scans per new isolate — run once behind a settings flag.

## 7. Open questions

- **Board poll frequency** in the webapp (`packages/webapp/src/store/kb.ts` / BoardView/TopView clock ticks) — determines the requests-quota slope; unaudited.
- **Retention window length** for events/versions (affects reduction 5 and get_history consumers).
- **FlowsHub DO** (`packages/worker/src/do.js`) is a separate class, unaudited here.
- **Rows-read growth curve**: need another week of GraphQL readings to fix the slope before choosing which of reductions 1–5 land first beyond the top two.
