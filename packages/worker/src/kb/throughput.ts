/**
 * Task-done throughput aggregation (BR#2937) — pure math, no storage.
 *
 * Numerator: task artefacts TRANSITIONED to done (true transition events
 * from the ledger, immune to later status flips — a done task that was
 * later re-opened still counts on the day it completed). Fallback:
 * currently-done tasks whose ledger history has compacted contribute their
 * status_ts, deduped against the transition set. Superseded/blocked never
 * enter: superseded tasks never reached done, and blocked is not done.
 */

export interface DoneEvent {
  ts: number;
  artefact_id: string;
}

export interface FallbackDone {
  id: string;
  status_ts: number;
}

export interface ThroughputBucket {
  /** bucket start, epoch ms (UTC hour/day/week alignment) */
  t: number;
  /** done transitions in this bucket */
  n: number;
  /** cumulative total through this bucket (within the range) */
  cumulative: number;
}

export interface ThroughputOptions {
  /** "hour" | "day" | "week" */
  bucket: string;
  /** range length in days, 1-365 (1-30 for hour buckets) */
  rangeDays: number;
  now: number;
}

export const BUCKET_MS: Record<string, number> = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 };

/** Finest-bucket response-size cap, in range days (BR#5126: hour × 365d would
 *  be 8,760 buckets — the Reports view wants dense but not unbounded grids). */
const MAX_RANGE_DAYS: Record<string, number> = { hour: 30, day: 365, week: 365 };

export function parseThroughputParams(bucket: unknown, range: unknown): { bucket: string; rangeDays: number } | { error: string } {
  const b = String(bucket ?? "day");
  if (!(b in BUCKET_MS)) return { error: `bucket must be one of ${Object.keys(BUCKET_MS).join(", ")} (got '${b}')` };
  const m = /^(\d{1,3})d?$/.exec(String(range ?? "30d"));
  if (!m) return { error: `range must look like '30d' or '30' (got '${String(range)}')` };
  const days = parseInt(m[1], 10);
  const max = MAX_RANGE_DAYS[b];
  if (days < 1 || days > max) return { error: `range must be 1-${max} days for ${b} buckets (got ${days})` };
  return { bucket: b, rangeDays: days };
}

/** Aggregate done events (+compaction fallback) into even buckets.
 *  Events before the range start are ignored (cumulative is range-local,
 *  matching the chart's x-axis, not a global all-time count). */
export function aggregateThroughput(events: DoneEvent[], fallback: FallbackDone[], opts: ThroughputOptions): ThroughputBucket[] {
  const bucketMs = BUCKET_MS[opts.bucket];
  const to = opts.now;
  const from = to - opts.rangeDays * 86_400_000;
  // align the last bucket edge to now's bucket so the final bucket is partial-but-visible
  const lastStart = Math.floor(to / bucketMs) * bucketMs;
  const firstStart = lastStart - (Math.ceil(opts.rangeDays * 86_400_000 / bucketMs) - 1) * bucketMs;
  const nBuckets = Math.round((lastStart - firstStart) / bucketMs) + 1;
  const buckets: ThroughputBucket[] = Array.from({ length: nBuckets }, (_, i) => ({ t: firstStart + i * bucketMs, n: 0, cumulative: 0 }));

  const seenViaEvent = new Set<string>();
  let running = 0;
  const idxOf = (ts: number) => (ts < from ? -1 : Math.floor(ts / bucketMs) - Math.floor(firstStart / bucketMs));

  for (const e of events) {
    seenViaEvent.add(e.artefact_id);
    const idx = idxOf(e.ts);
    if (idx >= 0 && idx < nBuckets) buckets[idx].n++;
  }
  for (const f of fallback) {
    if (seenViaEvent.has(f.id)) continue; // history covers it — the event ts is the truth
    const idx = idxOf(f.status_ts);
    if (idx >= 0 && idx < nBuckets) buckets[idx].n++;
  }
  for (const b of buckets) {
    running += b.n;
    b.cumulative = running;
  }
  return buckets;
}
