import type { ButtonHTMLAttributes } from "react";

export type BtnVariant = "ghost" | "primary" | "accept" | "reject" | "danger";

export interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** visual intent — default ghost (raised surface, hairline border) */
  variant?: BtnVariant;
  /** sm = gateway density; default md = webapp control scale */
  size?: "md" | "sm";
  /** de-emphasised ghost — cancel / tertiary actions */
  quiet?: boolean;
  /** toggle-on state (enabled backend, boosted) */
  on?: boolean;
}

/** The one button. A plain <button>: every prop passes through,
 *  className layers on top of the variant classes. */
export function Btn({ variant, size, quiet, on, className, ...rest }: BtnProps) {
  const cls = [
    "k-btn",
    variant && variant !== "ghost" ? `k-btn--${variant}` : "",
    size === "sm" ? "k-btn--sm" : "",
    quiet ? "k-btn--quiet" : "",
    on ? "k-btn--on" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return <button {...rest} className={cls} />;
}
