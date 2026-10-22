/** "12s ago" / "in 3m" — the one relative-time formatter.
 *  `now` is injectable so callers own the clock (testable, SSR-safe). */
export function relTime(ms: number, now: number = Date.now()): string {
  const d = now - ms;
  const a = Math.abs(d);
  const unit =
    a < 60_000 ? `${Math.max(1, Math.round(a / 1000))}s`
    : a < 3_600_000 ? `${Math.round(a / 60_000)}m`
    : a < 86_400_000 ? `${Math.round(a / 3_600_000)}h`
    : `${Math.round(a / 86_400_000)}d`;
  return d >= 0 ? `${unit} ago` : `in ${unit}`;
}
