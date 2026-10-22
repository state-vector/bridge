import type { HTMLAttributes } from "react";

export type ConnState = "open" | "connecting" | "closed";

export interface ConnDotProps extends HTMLAttributes<HTMLSpanElement> {
  state: ConnState;
  label?: string;
}

/** The one connection dot: ● colored by connection state, optional label. */
export function ConnDot({ state, label, className, ...rest }: ConnDotProps) {
  return (
    <span
      {...rest}
      className={["k-conn", `k-conn--${state}`, className ?? ""].filter(Boolean).join(" ")}
    >
      <span className="k-conn-dot" aria-hidden>
        ●
      </span>
      {label != null && <span className="k-conn-label">{label}</span>}
    </span>
  );
}
