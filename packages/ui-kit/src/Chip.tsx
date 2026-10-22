import type { HTMLAttributes } from "react";

export type ChipTone =
  | "neutral"
  | "urgent"
  | "needs"
  | "diag"
  | "done"
  | "scope"
  | "ok"
  | "live"
  | "warn"
  | "err"
  | "muted";

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
  /** pill shape for status/age chips — default square label chip */
  pill?: boolean;
}

/** The one chip. `tone` covers the shared vocabulary (urgent / needs /
 *  diag / done / scope) and the status pills (ok / live / warn / err /
 *  muted); `pill` switches to the round status shape. */
export function Chip({ tone = "neutral", pill, className, ...rest }: ChipProps) {
  const cls = [
    "k-chip",
    tone !== "neutral" ? `k-chip--${tone}` : "",
    pill ? "k-chip--pill" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return <span {...rest} className={cls} />;
}
