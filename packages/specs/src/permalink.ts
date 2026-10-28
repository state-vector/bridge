/**
 * Card permalinks (BR#3990) — the ONE id⇄URL mapping every surface shares.
 *
 * A card's canonical URL is `/card/<id>` with the id in its URL-safe dash
 * form: `BR#3990` → `/card/BR-3990`. The `#` character is fragment syntax in
 * a URL, so the path form replaces it with `-`; legacy ids (`TASK-007`) are
 * already URL-safe and pass through unchanged.
 *
 * Parsers accept every reasonable human spelling: `BR-3990`, `BR#3990`
 * (percent-encoded as `BR%233990` in a path), and the bare number `3990`.
 * Pure and dependency-free — the hub stamps `url` fields into MCP payloads,
 * the webapp parses deep-link routes, and both import THIS file so the two
 * ends can never drift.
 */

/** Bridge-vended card id: `BR#<n>` (modern) or `<PREFIX>-<n>` (legacy, e.g. TASK-007). */
export type CardId = string;

const BR_HASH = /^BR#(\d+)$/;
/** Legacy per-type ids are `[A-Z]+-<digits>` (core.ts idSeq) — TASK-007, not ASK-random. */
const LEGACY_DASH = /^([A-Z]+)-(\d+)$/;

export function isCardId(id: unknown): id is CardId {
  return typeof id === "string" && (BR_HASH.test(id) || LEGACY_DASH.test(id));
}

/**
 * The canonical URL path for a card id, or null for a non-card id
 * (freeform ask ids, event ids — they have no card route).
 */
export function cardPath(id: string): string | null {
  if (!isCardId(id)) return null;
  return `/card/${id.replace("#", "-")}`;
}

/**
 * Inverse of cardPath: resolve one `/card/<seg>` path segment to a card id.
 * Accepts the canonical dash form, a percent-encoded literal (`BR%233990`),
 * a raw `#` spelling, the bare number, and legacy dash ids. Anything else —
 * garbage, freeform ask ids — is null (caller shows the board, not an error).
 */
export function cardIdFromPathSegment(seg: string): string | null {
  let s: string;
  try {
    s = decodeURIComponent(seg).trim();
  } catch (err) {
    // Malformed escapes are ordinary input (address-bar typos, scrapers), so
    // the documented contract stays `null` — but the failure is surfaced, not
    // swallowed: every mis-parse leaves a diagnosable log line.
    console.warn(
      `[bridge/specs] cardIdFromPathSegment: unparseable segment ${JSON.stringify(seg)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
  if (s.includes("#")) return BR_HASH.test(s) ? s : null;
  const brDash = /^BR-(\d+)$/.exec(s);
  if (brDash) return `BR#${brDash[1]}`;
  if (/^\d+$/.test(s)) return `BR#${s}`;
  return LEGACY_DASH.test(s) ? s : null;
}
