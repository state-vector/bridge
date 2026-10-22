import { relTime } from "./relTime";

/** Live relative time. Pass `now` to own the clock; default ticks at render. */
export function RelTime({ ts, now, className }: { ts: number; now?: number; className?: string }) {
  return (
    <span className={["k-reltime", className ?? ""].filter(Boolean).join(" ")}>
      {relTime(ts, now)}
    </span>
  );
}
