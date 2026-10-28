/** Ref hyperlinks for rendered card text (BR#4015, Ray 2026-10-28 —
 *  "use hyperlinks for PRs, issues, BR# etc so that I don't have to copy-paste").
 *
 *  Pure string module (no react/zustand) so the worker vitest tier tests it
 *  directly (forMeHold precedent). One scanner, one pass:
 *
 *  - `BR#NNN` / `TASK-NNN`          → `/card/BR-NNN` anchors (dash-form
 *    canonical segment, BR#3990 grammar / PR #254). Real hrefs: copyable,
 *    cmd-clickable; views attach a delegated click for in-panel SPA nav.
 *  - bare `https://…` URLs          → target=_blank anchors (snarkdown does
 *    not auto-link — they used to render as dead text).
 *  - `owner/repo#N`                 → github issues anchor (unambiguous —
 *    always linked; GitHub redirects /issues/N ↔ /pull/N).
 *  - `PR #N` `issue #N` `GH#N` `#N` → github anchor ONLY when a repo slug is
 *    supplied (opts.repo, e.g. card meta.provenance.repo) — never guess.
 *
 *  Safety: runs on rendered HTML, so the scanner walks TEXT segments only —
 *  never tag bodies/attributes — and skips text inside <a>, <code>, <pre>
 *  (no double-linking markdown hrefs or code spans; re-running is a no-op,
 *  i.e. idempotent). All emitted attributes are escaped. */

const CODE_SKIP_RX = /^<\s*(a|code|pre)\b/i;
const CODE_CLOSE_RX = /^<\s*\/\s*(a|code|pre)\b/i;

/** Canonical permalink path for a card id. `BR#3822` → `/card/BR-3822`
 *  (`#` is fragment syntax in URLs — dash form is canonical, BR#3990);
 *  legacy `PREFIX-<n>` ids pass through. Non-card ids → null (never link). */
export function cardPath(id: string): string | null {
  const m = /^BR#(\d+)$/.exec(id);
  if (m) return `/card/BR-${m[1]}`;
  return /^[A-Z]+-\d+$/.test(id) ? `/card/${id}` : null;
}

/** Escape a string for safe embedding in HTML text or a double-quoted attribute. */
export function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Cheap pre-filter: does this text even contain anything linkable? */
export function mayContainRefs(text: string): boolean {
  return /https?:\/\/|#[0-9]|\bBR#\d|\bTASK-\d/.test(text);
}

const URL_RX = /\bhttps?:\/\/[^\s<>"'`)\]}]+/g;

/** Combined scan, group map (first alternative that matches wins, so a full
 *  URL containing `#123` links once, as a URL):
 *   1  url
 *   2  card ref (BR#NNN / TASK-NNN)
 *   3,4,5  owner/repo#N
 *   6,7    prefixed ref (PR #N / issue #N / GH#N) — needs opts.repo
 *   8,9    bare #N (leading char captured, re-emitted) — needs opts.repo
 *  Case-insensitive so prose like "see pr #12" links; cardPath stays strict
 *  (lowercase id text that fails cardPath falls through as plain text). */
const SCAN_RX = new RegExp(
  [
    `(${URL_RX.source})`,
    `\\b(BR#\\d+|TASK-\\d+)\\b`,
    `([A-Za-z0-9][\\w.-]*)/([A-Za-z0-9][\\w.-]*)#(\\d+)\\b`,
    `\\b(PRs?|pull|pull request|issues?|GH)\\s?#(\\d+)\\b`,
    `(^|[^A-Za-z0-9_&;])#(\\d+)\\b`,
  ].join("|"),
  "gi",
);

/** Trailing punctuation a URL match tends to swallow from a sentence — kept
 *  as text, dropped from the href. */
function trimUrlTail(url: string): { href: string; tail: string } {
  const m = /[.,;:!?]+$/.exec(url);
  return m ? { href: url.slice(0, -m[0].length), tail: m[0] } : { href: url, tail: "" };
}

function githubHref(repo: string, n: string, pr: boolean): string {
  return `https://github.com/${repo}/${pr ? "pull" : "issues"}/${n}`;
}

function extAnchor(href: string, text: string): string {
  return `<a href="${escHtml(href)}" target="_blank" rel="noreferrer noopener" class="ref-link">${text}</a>`;
}

export interface LinkifyOpts {
  /** repo slug ("state-vector/bridge") that prefixed / bare `#N` refs resolve
   *  against — from the card's own context (meta.provenance.repo). */
  repo?: string;
}

/* ---- card-link shell seam (BR#4015 follow-up, Ray: "open in webapp for
 *   BR-links, in windows in desktop app, in browser when opening from external")
 *
 *   A card ref's href is always the webapp permalink (/card/BR-N, #254) — the
 *   browser target. Views with a local handler (detail panel) delegate plain
 *   clicks to it (SPA nav). Where NO local handler exists (decision popover
 *   bodies, comments) a plain click follows the href by default — right in a
 *   browser, wrong inside the Tauri shell, which doesn't serve /card/*.
 *   The desktop registers an opener here at boot so those clicks open the
 *   card in its own OS window instead. */

let cardLinkOpener: ((id: string) => void) | null = null;

export function setCardLinkOpener(fn: ((id: string) => void) | null): void {
  cardLinkOpener = fn;
}

export function getCardLinkOpener(): ((id: string) => void) | null {
  return cardLinkOpener;
}

/** Linkify refs in a rendered-HTML string. Text-level, segment-scoped,
 *  idempotent. Returns HTML — render with dangerouslySetInnerHTML. */
export function linkifyHtml(html: string, opts: LinkifyOpts = {}): string {
  if (!html || !mayContainRefs(html)) return html;
  const parts = html.split(/(<[^>]*>)/);
  let skipDepth = 0; // inside <a>/<code>/<pre>: hands off
  const out: string[] = [];
  for (const part of parts) {
    if (part.startsWith("<")) {
      if (CODE_SKIP_RX.test(part) && !/\/\s*>$/.test(part)) skipDepth++;
      else if (CODE_CLOSE_RX.test(part) && skipDepth > 0) skipDepth--;
      out.push(part);
    } else if (skipDepth > 0 || !mayContainRefs(part)) {
      out.push(part);
    } else {
      out.push(linkifySegment(part, opts));
    }
  }
  return out.join("");
}

function linkifySegment(text: string, opts: LinkifyOpts): string {
  let result = "";
  let last = 0;
  for (const m of text.matchAll(SCAN_RX)) {
    const i = m.index;
    result += text.slice(last, i);
    last = i + m[0].length;
    if (m[1]) {
      // bare URL — trailing sentence punctuation stays outside the href
      const { href, tail } = trimUrlTail(m[1]);
      result += extAnchor(href, escHtml(href)) + escHtml(tail);
      last = i + href.length + tail.length;
    } else if (m[2]) {
      // card ref → in-board permalink (delegated SPA nav lives on the view)
      const p = cardPath(m[2]);
      result += p
        ? `<a href="${escHtml(p)}" class="task-ref" data-task-ref="${escHtml(m[2])}">${escHtml(m[2])}</a>`
        : escHtml(m[0]);
    } else if (m[3] && m[4] && m[5]) {
      // owner/repo#N — unambiguous, always links (GitHub redirects pull↔issues)
      const repo = `${m[3]}/${m[4]}`;
      result += extAnchor(githubHref(repo, m[5], false), escHtml(`${repo}#${m[5]}`));
    } else if (m[6] && m[7]) {
      // PR #N / issue #N / GH#N — only with a repo to resolve against
      if (!opts.repo) { result += escHtml(m[0]); continue; }
      const pr = /^(pr|pull)/i.test(m[6]);
      result += escHtml(m[6]) + extAnchor(githubHref(opts.repo, m[7], pr), `#${m[7]}`);
    } else if (m[8] !== undefined && m[9] !== undefined) {
      // bare #N — only with a repo; leading char (space, "(", …) re-emitted
      if (!opts.repo) { result += escHtml(m[0]); continue; }
      result += escHtml(m[8]) + extAnchor(githubHref(opts.repo, m[9], false), `#${m[9]}`);
    }
  }
  result += text.slice(last);
  return result;
}
