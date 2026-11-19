# Live hub performance incident — 2026-11-19

Tracking: https://github.com/state-vector/bridge/issues/471

These are sanitized captures from the previous investigation at c84a702eb. They contain no request headers, credentials, or bodies. The old runtime tail was filtered on CPU >100ms or HTTP >=500, omitted per-event timestamps and original exception text, and is not a complete traffic census. A coarse reset classification is not a root-cause determination. See the issue for the initial measurements.

The task probe logs show concurrent (task, diagnostics, edge version) tuples of (HTTP status, milliseconds). Status 0 means the client timed out or failed; it is not an HTTP status. Stage timings use the Worker clock and cannot measure synchronous CPU accurately.

New full-error captures and CPU profiles will be added with the actual diagnosis and verification.

## Sampled production CPU diagnosis

`before-hub-cpu.pprof.gz` targeted KnowledgeHub namespace `6c42bb0142c5412dbced50911bab0709`, actor `8175f3a6f149180752f88aae1cd19e369a5cbba9e707f65f65a88ca520803a05`, at c84a702eb. The request asked for 30 seconds; pprof reports 22.01 seconds and 19.397 seconds sampled CPU. It was captured during normal live traffic. Profiles were gzip-compressed for archival; they contain function stacks, not request arguments.

- `boardPayload` / `pushBoardSnapshot` / `board`: 14.672s, 75.64% cumulative CPU.
- `boardDetails`: 11.317s, 58.34%.
- `qualificationEvidence`: 4.480s, 23.10%.
- `dispatchCandidates`: 3.276s, 16.89% (overlaps board costs).
- Native `SqlStorage.exec`: 10.584s, 54.57%; `cursor.toArray`: 7.370s, 38.00%.
- Garbage collection: 0.381s, 1.96%.

The production indexes caused a scoped qualification join to start from historical `status=done` cards and then probe every selected parent. A workerd SQLite reproduction with 10,000 unrelated completed cards reads 20,011 rows; an explicit parent-driven incoming-relation seek reads 12 and preserves the same evidence. Dispatch's copied evidence queries had the same problem.

Board progress queries filtered the canonical ledger by kind/action, but the existing index ordered by timestamp rather than sequence. SQLite built a temporary B-tree and sorted retained progress history for every push. Adding `(kind,action,seq DESC)` permits bounded recency seeks for both compatibility views. Tests use 100,000 unrelated ledger receipts, verify sequence order, row reads and absence of temporary sorting.

`before-full-tail.jsonl` retains timestamps and all observed request statuses; unlike the older filtered captures, it can count observed requests. No request headers, bodies or credentials are included. Profile stacks report sampled CPU, not per-request exclusive duration.

Reproduce capture (refresh OAuth with `wrangler whoami`, or set `CLOUDFLARE_API_TOKEN`):

```sh
python3 scripts/profile-hub.py --account ACCOUNT_ID --worker bridge --namespace NAMESPACE_ID --actor ACTOR_ID --duration-ms 30000 --output /tmp/hub.pprof
go tool pprof -top -cum /tmp/hub.pprof
node scripts/diagnose-hub.mjs --seconds 180 --events > /tmp/hub-tail.jsonl
```

Full new reset exceptions are emitted as `bridge.infra_error` with message, stack, runtime flags and nested cause, with known credentials redacted. Final diagnosis and post-deployment verification will follow.

## First fix and full failure capture (3913105a1)

The full runtime error is **Durable Object is overloaded. Requests queued for too long.**, with `overloaded: true`. Its supplied stack is the same message, with no JavaScript frames or nested cause. See timestamped `rollout-full-tail.jsonl`. This proves queue starvation for these failures; it does not retroactively recover the old coarse-classified reset exception.

After the board query fix, sampled board CPU fell from 14.672s / 22.01s capture to 1.862s / 25.28s, an approximately 89% reduction in board CPU per second. However trainStatus now dominates (8.382s / 12.005s total sampled CPU, 69.82%). Concurrent probes still include multi-second stalls, so the incident is not resolved by that first fix.

A desktop SQLite plan suggested train child joins could scan history, but the workerd fixture did not reproduce that plan. That speculative change was discarded. Instead the six raw train SQL families are being named in the production CPU stack, with row-read counters for broad reads, to identify the actual remaining query. The full train suite (125 tests) passes with this behavior-preserving extraction.

## Remaining train root cause (0720149aa)

Production query-level counters identify `train.review_children`: 426 calls read **5,872,570 rows** to return 8,466 children. Empty results read 13,746 rows each; one-child results read 13,747. This is the historical-task-first join plan, repeated for each review parent in the train snapshot. See `train-query-row-reads.jsonl`. Other named PR-stat families did not report broad reads in this window.

The surviving authoritative lookup remains the incoming `child_of` relation. `TRAIN_REVIEW_CHILDREN_SQL` now explicitly starts with `relations INDEXED BY idx_relations_incoming`, then CROSS JOINs children by primary key. No child status, history, ordering or result limit changed. A workerd test emulates the observed historical-task-first plan: 10,008 reads versus 13 for the parent-driven lookup, same done/pending children and sequence; empty lookups read fewer than five rows. The full 125-test train lifecycle suite passes.

The first two attempts to capture a named CPU profile returned Cloudflare control-plane errors (no recent execution, then profiling could not start). These are profile-API failures, not hub request samples. The preceding native CPU profile and direct live row-read counters identify the train bottleneck independently. A post-fix native profile and latency verification are still required.

The subsequent script-scope native profile succeeded: `train-named-before-fix.pprof.gz` reports 30.06s duration and 20.939s sampled CPU. **trainReviewChildRows accounts for 7.826s CPU (37.38%)**, directly confirming the row-read diagnosis. The actor-specific profiling control-plane failures above did not prevent a sampled CPU attribution.

## Watchdog acceptance failure and category-level repair

382fc124a removed the broad train review-child scan. A five-minute acceptance capture observed 942 requests and no HTTP 5xx, but retained 3–6s stalls roughly once per minute, so it was **not** accepted as resolved. The diagnostics place those spikes in coordination maintenance.

The actor-targeted native profile (`after-train-hub-cpu.pprof.gz`, 49.63s, 18.671s sampled CPU) identifies `retireCompletedCoordination` at 2.617s cumulative CPU and `currentTaskReview` at 3.700s. The review-child query no longer appears among the expensive functions. A separate script-scope capture selected an edge isolate and was discarded for stateful CPU analysis.

The coordination query used a correlated `p.id IN (relation UNION route)` expression. Despite an outer CROSS JOIN, SQLite could choose the terminal-task status index for each open question. The repair expands relation and typed-route bindings as two equivalent UNION arms, then seeks each parent by its exact ID. Relation+route duplicates still collapse. With the production type/status indexes present, the workerd regression reproduces **144,123 old row reads versus 19 new**, with identical requests retired.

The same production indexes exposed two related traps: the board's existing recency index was ignored (24,037 row reads for 250 IDs), and current-review/legacy-parent lookups could start from historical task status/type ranges. The board recency query now pins its existing recency index; review lookup pins the declared-subject index and drives legacy children/parents from relations. The complete review-query fixture now includes those competing production indexes, rather than testing an unrealistically favorable fresh schema. All query tests and the 125 train lifecycle tests pass.

These are access-path repairs to existing authoritative data, with no retries, task caps, new state owners or lifecycle semantics. Final live verification follows after this repair deploys.
