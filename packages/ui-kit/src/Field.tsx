import type { ReactNode } from "react";

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** The standard settings field: label + control + optional hint,
 *  stacked. The wrapping <label> gives native focus association. */
export function Field({ label, hint, children, className }: FieldProps) {
  return (
    <label className={["k-field", className ?? ""].filter(Boolean).join(" ")}>
      <span className="k-field-label">{label}</span>
      {children}
      {hint != null && <span className="k-field-hint">{hint}</span>}
    </label>
  );
}
