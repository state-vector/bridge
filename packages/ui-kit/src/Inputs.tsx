import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

function cx(base: string, className?: string | undefined): string {
  return [base, className ?? ""].filter(Boolean).join(" ");
}

/** The one text input. */
export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx("k-input", className)} />;
}

/** The one multiline input. */
export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cx("k-input k-input--area", className)} />;
}

/** The one select. */
export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...rest} className={cx("k-input k-input--select", className)} />;
}
