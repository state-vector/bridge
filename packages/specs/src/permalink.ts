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
 * Strict percent-decoder for one URL path segment — TOTAL, never throws.
 * `decodeURIComponent` was the wrong tool here: it throws on malformed input
 * (bad hex, truncated escapes, invalid UTF-8 continuations), which forced a
 * catch-and-degrade in the route parser. A decoder that returns `null` for
 * undecodable input has no error channel at all — malformed escapes are a
 * VALUE, and the "what do we do with garbage" decision stays with the caller
 * (show the board, not an error).
 *
 * Semantics mirror `decodeURIComponent` where it succeeds: `%XX` byte runs
 * are validated as UTF-8 (continuations, overlongs, surrogates, >U+10FFFF
 * all rejected → null) and decoded; raw characters — including raw `#` and
 * non-ASCII — pass through verbatim. `+` is NOT a space (this is a path
 * segment, not a query string).
 */
const HEX: Record<number, number> = {};
for (let i = 0; i < 16; i++) {
  HEX["0123456789abcdef".charCodeAt(i)] = i;
  HEX["0123456789ABCDEF".charCodeAt(i)] = i;
}

/** Decode a run of UTF-8 bytes, or null if the run is not valid UTF-8. */
function utf8Decode(bytes: number[]): string | null {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i++]!;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      continue;
    }
    const len = b0 < 0xe0 ? 2 : b0 < 0xf0 ? 3 : 4;
    if (i + len - 1 > bytes.length) return null;
    let cp = b0 & (len === 2 ? 0x1f : len === 3 ? 0x0f : 0x07);
    for (let k = 1; k < len; k++) {
      const b = bytes[i++]!;
      if ((b & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (b & 0x3f);
    }
    const minCp = len === 2 ? 0x80 : len === 3 ? 0x800 : 0x10000;
    if (cp < minCp) return null; // overlong
    if (cp >= 0xd800 && cp <= 0xdfff) return null; // surrogate half
    if (cp > 0x10ffff) return null;
    out += String.fromCodePoint(cp);
  }
  return out;
}

export function percentDecode(input: string): string | null {
  let out = "";
  let bytes: number[] | null = null; // pending %XX run, flushed at raw chars
  const flush = (): boolean => {
    if (bytes) {
      const decoded = utf8Decode(bytes);
      if (decoded === null) return false;
      out += decoded;
      bytes = null;
    }
    return true;
  };
  for (let i = 0; i < input.length; ) {
    if (input.charCodeAt(i) === 0x25 /* % */) {
      const hi = HEX[input.charCodeAt(i + 1)];
      const lo = HEX[input.charCodeAt(i + 2)];
      if (hi === undefined || lo === undefined) return null; // truncated / bad hex
      bytes ??= [];
      bytes.push((hi << 4) | lo);
      i += 3;
      continue;
    }
    if (!flush()) return null;
    out += input[i++]!;
  }
  return flush() ? out : null;
}

/**
 * Inverse of cardPath: resolve one `/card/<seg>` path segment to a card id.
 * Accepts the canonical dash form, a percent-encoded literal (`BR%233990`),
 * a raw `#` spelling, the bare number, and legacy dash ids. Anything else —
 * garbage, freeform ask ids, undecodable escapes — is null (caller shows the
 * board, not an error). Total: never throws, never logs.
 */
export function cardIdFromPathSegment(seg: string): string | null {
  const s = percentDecode(seg)?.trim();
  if (s === undefined || s === null) return null;
  if (s.includes("#")) return BR_HASH.test(s) ? s : null;
  const brDash = /^BR-(\d+)$/.exec(s);
  if (brDash) return `BR#${brDash[1]}`;
  if (/^\d+$/.test(s)) return `BR#${s}`;
  return LEGACY_DASH.test(s) ? s : null;
}
