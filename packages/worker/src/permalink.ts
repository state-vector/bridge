/**
 * Permalink stamping for MCP payloads (BR#3990) — "give me the stable URL"
 * answered without a second call. Every artefact row the hub returns through
 * /mcp gains a `url` field: `${origin}/card/BR-3990` — the canonical deep
 * link a human can paste into a browser (the SPA route opens the card's
 * detail panel).
 *
 * Stamping happens at the ONE call boundary (mcp.ts wraps ctx.call), so every
 * tool benefits uniformly — orient's open_artefacts/my_tasks/unclaimed_work,
 * search results, get_artefact (+ its see_also rows, which are built from the
 * same stamped calls), related_artefacts, ask inboxes — and every handler
 * that spreads a DO result inherits the fields for free.
 *
 * The walk is deliberately conservative: only objects/arrays are traversed,
 * free-text containers (meta, payload, body_md, …) are skipped, existing
 * url/artefact_url fields are never overwritten, and only the card id grammar
 * (@bridge/specs isCardId — BR#<n> / legacy <PREFIX>-<n>) is stamped, so
 * freeform ask ids and event ids stay untouched.
 */
import { cardPath, isCardId } from "@bridge/specs";

/** Subtrees that are free text / opaque data, never permalink candidates. */
const SKIP_KEYS = new Set([
  "meta", "payload", "data",
  "body_md", "instructions", "bootstrap_md",
  "text", "description", "reason", "details", "note", "answer", "question",
]);

const MAX_DEPTH = 6;

export function stampPermalinks<T>(value: T, origin: string | undefined): T {
  if (!origin || typeof origin !== "string") return value;
  const base = origin.endsWith("/") ? origin.slice(0, -1) : origin;
  walk(value, base, 0);
  return value;
}

function walk(node: unknown, base: string, depth: number): void {
  if (!node || typeof node !== "object" || depth > MAX_DEPTH) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, base, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const [key, child] of Object.entries(obj)) {
    if (SKIP_KEYS.has(key) || child === null || typeof child !== "object") continue;
    walk(child, base, depth + 1);
  }
  // stamp the object itself AFTER descending — order is irrelevant; the
  // guards below are what keep the output honest.
  if (
    typeof obj.id === "string" && isCardId(obj.id) && obj.url === undefined &&
    (typeof obj.title === "string" || typeof obj.status === "string" ||
      typeof obj.type === "string" || typeof obj.question === "string")
  ) {
    const path = cardPath(obj.id);
    if (path) obj.url = base + path;
  }
  if (
    typeof obj.artefact_id === "string" && isCardId(obj.artefact_id) &&
    obj.artefact_url === undefined
  ) {
    const path = cardPath(obj.artefact_id);
    if (path) obj.artefact_url = base + path;
  }
}
