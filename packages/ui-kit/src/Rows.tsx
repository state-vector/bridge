import type { HTMLAttributes } from "react";

function cx(base: string, className?: string | undefined): string {
  return [base, className ?? ""].filter(Boolean).join(" ");
}

/** The one inline action row: buttons (+ optional inline status text),
 *  left-flowing and wrapping. */
export function ActionRow({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={cx("k-action-row", className)} />;
}

/** The one settings row: key + control + action on a single line. */
export function FormRow({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={cx("k-form-row", className)} />;
}
