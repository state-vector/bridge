import type { HTMLAttributes } from "react";

export type CardProps = HTMLAttributes<HTMLDivElement>;

/** The one card: raised surface, hairline border, stacked content.
 *  Compose confirmations from Card + inputs + ActionRow. */
export function Card({ className, ...rest }: CardProps) {
  return <div {...rest} className={["k-card", className ?? ""].filter(Boolean).join(" ")} />;
}
