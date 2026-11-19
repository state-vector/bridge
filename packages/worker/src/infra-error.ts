/** Retain operational failures without losing the reset reason or publishing
 * request credentials. Only Error fields and runtime flags are serialized. */
export function redactInfraText(value: string, secrets: readonly string[] = []): string {
  let text = value;
  for (const secret of secrets) if (secret) text = text.split(secret).join("[redacted]");
  return text.replace(/bkw_[\w-]+/g, "[redacted-token]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/(bridge_session=)[^\s;"']+/gi, "$1[redacted]")
    .replace(/([?&](?:token|secret|password|code)=)[^\s&#"']+/gi, "$1[redacted]");
}
export function infraError(error: unknown, secrets: readonly string[] = [], seen = new Set<unknown>()): Record<string, unknown> {
  if (seen.has(error)) return { message: "[circular cause]" };
  if (!(error instanceof Error)) return { message: redactInfraText(String(error), secrets) };
  seen.add(error);
  const flags = error as Error & { overloaded?: boolean; retryable?: boolean; status?: number };
  return { name: error.name, message: redactInfraText(error.message, secrets),
    stack: error.stack ? redactInfraText(error.stack, secrets) : undefined,
    overloaded: flags.overloaded, retryable: flags.retryable, status: flags.status,
    ...(error.cause === undefined ? {} : { cause: infraError(error.cause, secrets, seen) }) };
}
export function logInfraError(stage: string, error: unknown, secrets: readonly string[] = []): void {
  console.error(JSON.stringify({ type: "bridge.infra_error", stage, error: infraError(error, secrets) }));
}
