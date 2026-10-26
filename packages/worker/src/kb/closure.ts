// The closure tier's text law (BR#3361) — pure parsing, no I/O. Three jobs:
//
// 1. parseProxyCondition: extract machine-checkable atoms from a blocked
//    card's unblock_condition so the hub's proxy-watch sweep can re-evaluate
//    the predicate periodically and auto-spawn the unblock duty when it
//    flips TRUE (the BR#3129 class: proxy flipped, nobody noticed for ~20h).
// 2. parseCloseLegs: extract terminal "close GH #N" intents from a card's
//    Done-when and done note, so a done card cannot orphan the final close
//    leg (the GH #2261 class: all fixes merged, nobody owned the close).
// 3. parseClosureReceipt: extract the closure receipt (state=closed +
//    closing-comment id + guard run id) a done card must carry for every
//    close leg it claims, so "GH #N closed" claims are mechanically
//    checkable (the BR#3220 class: done card claimed a close that never
//    happened).
//
// Conservatism law: the parsers prefer false negatives over false
// positives. Text that looks machine-checkable but yields no atom marks the
// condition UNPARSEABLE — the proxy-watch stamps the verdict and never
// auto-flips a card it cannot fully read. Every auto-spawned duty still
// verifies live state first-hand; the sweep is a trigger, not an authority.
//
// ---------- 1. unblock-proxy atoms ----------

export interface ProxyAtom {
  kind: "pr_merged" | "br_pr_merged" | "issue_closed" | "br_done" | "run_success" | "pr_checks_green";
  /** repo slug "owner/name"; null = no repo resolvable from the text (the
   *  atom is then unresolvable — the condition can never auto-flip) */
  repo: string | null;
  number?: number;
  brId?: string;
  runId?: string;
  raw: string;
}

export interface ParsedCondition {
  atoms: ProxyAtom[];
  /** machine-predicate-looking text that produced NO atom — the sweep must
   *  never auto-flip such a card (it cannot fully read the condition) */
  unparseable: boolean;
  /** BR#3668: the text itself declares a HUMAN-only exit (explicit human-gate
   *  markers). The condition is unparseable BY DESIGN — never atomized, never
   *  flipped, never re-fired; a machine-shaped await_event stamped onto such
   *  a park (e.g. derived from prose before this law) contradicts the card's
   *  own markers and is ignored for flip purposes. */
  humanGated?: boolean;
  /** the exact marker that classified the condition (for stamps and tests) */
  humanGate?: string;
}

/** Machine-predicate-looking text: if this matches and no atom parsed, the
 *  condition is marked unparseable instead of silently ignored. */
const LOOKS_MACHINE =
  /\b(?:PR\s?#|pull\/\d+|mergeCommit|MERGED|GH\s?#|GH#\d|issue\s?#?\d|BR#\d|run\s+\d{6,}|check\s+run|actions\/runs\/\d)/i;

/** Duty clauses are the instruction half of an unblock condition ("then a
 *  FRESH session closes BR#N done citing…") — not preconditions. Cut them
 *  before atom-scanning so the duty's own "close BR#N done" never parses as
 *  a pending precondition. */
const DUTY_MARKERS = [
  /\bthen\s+an?\s+\S+\s+session\b/i,
  /\bthen\s+an?\s+agent\b/i,
  /\bthen\s+transition\b/i,
  /\bciting\b/i,
  /\balternative\s+proxy\b/i,
  /\bexit\s+condition\s+of\s+record\b/i,
];

function cutDutyClauses(line: string): string {
  let cut = line;
  for (const m of DUTY_MARKERS) {
    const hit = m.exec(cut);
    if (hit) cut = cut.slice(0, hit.index);
  }
  return cut;
}

/** BR#3668: explicit human-gate markers — the closed set. A condition whose
 *  TEXT declares a human-only exit is unparseable by design: the sweep never
 *  atomizes it, never flips it, and never re-fires it, no matter what
 *  machine-looking fragments the surrounding prose contains. Deliberately a
 *  closed list (conservatism: unparseable is the safe direction) — extend it
 *  only when a real specimen demands it. */
const HUMAN_GATE_MARKERS: RegExp[] = [
  /\bhuman[- ]only\b/i,
  /\bno machine atom can flip\b/i,
  /\bweb\s*\/\s*admin\b/i,
  /\bowner\s*\/\s*web[- ]only\b/i,
];

/** The first human-gate marker found in the text, or null. */
export function humanGateMarker(text: string): string | null {
  for (const m of HUMAN_GATE_MARKERS) {
    const hit = m.exec(String(text ?? ""));
    if (hit) return hit[0];
  }
  return null;
}

/** BR#3668: parentheticals are annotation, never preconditions. The live
 *  specimen: BR#3358's condition carries the verify-provenance aside
 *  "(BR#3361 done, decision BR#3409)" inside agent-terminal guidance — the
 *  sweep mis-parsed it into a br_done atom and stamped it as the park's
 *  await_event, contradicting the condition's own human-only marker.
 *  Stripping happens BEFORE atom-scanning so prose asides can never yield
 *  atoms (and never suppress them: a precondition's trigger words live
 *  outside its parentheses). */
function stripParentheticals(line: string): string {
  return line.replace(/\([^()]*\)/g, " ");
}

function repoFromLine(line: string): string | null {
  const m = /github\.com\/([\w.-]+)\/([\w.-]+)/.exec(line);
  return m ? `${m[1]}/${m[2].replace(/\.git$/, "")}` : null;
}

function numberFromPullUrl(line: string): number | null {
  const m = /github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/.exec(line);
  return m ? Number(m[1]) : null;
}

/**
 * Extract machine-checkable atoms from an unblock condition. One line may
 * yield several atoms (a conjunction); the sweep flips only when EVERY atom
 * evaluates TRUE and nothing is unparseable.
 */
export function parseProxyCondition(text: string): ParsedCondition {
  const src = String(text ?? "");
  // BR#3668: human-gate markers classify the condition BEFORE any atom scan —
  // zero atoms, unparseable by design. The marker check must precede the
  // parenthetical strip: the mis-parse of record hid inside a parenthetical
  // of a human-gated condition, and either guard alone would have let the
  // other layer down on differently-shaped prose.
  const gate = humanGateMarker(src);
  if (gate) return { atoms: [], unparseable: true, humanGated: true, humanGate: gate };
  const atoms: ProxyAtom[] = [];
  let unparseable = false;
  // Cut the DUTY clauses over the WHOLE text before splitting: real conditions
  // enumerate the duty steps with semicolons ("then a fresh session: (1) …;
  // (2) close GH #N …; (3) exit …") — splitting first would orphan each step
  // from its duty marker and the step's own machine-looking text ("close GH
  // #N") would mark the condition unparseable (BR#3129's real condition).
  const duty = cutDutyClauses(String(text ?? ""));
  for (const rawLine of duty.split(/\r?\n|(?<=;)\s*/)) {
    const line = stripParentheticals(rawLine.trim());
    if (!line) continue;
    const repo = repoFromLine(line);
    let lineYielded = false;

    // pr_merged: "PR <url|#N> … mergeCommit non-null / state MERGED / merged"
    if (/\b(?:is\s+)?(?:mergeCommit\s+non-null|state[:\s]+MERGED\b|MERGED\b|merged\b)/i.test(line)) {
      const urlN = numberFromPullUrl(line);
      const bare = /PR\s+#?(\d+)\b/.exec(line);
      const prNumber = urlN ?? (bare ? Number(bare[1]) : null);
      if (prNumber) {
        atoms.push({ kind: "pr_merged", repo, number: prNumber, raw: line.trim().slice(0, 200) });
        lineYielded = true;
      }
    }

    // br_pr_merged: "BR#N's fix PR on <repo> is MERGED" — the PR itself is
    // unnamed; the sweep resolves it by head branch bridge/BR-<N>.
    if (!lineYielded) {
      const br = /\bBR#(\d+)\b/.exec(line);
      if (br && repo && /(?:fix\s+)?PR\b/.test(line) && /\b(?:mergeCommit\s+non-null|state[:\s]+MERGED\b|MERGED\b|merged\b)/i.test(line)) {
        atoms.push({ kind: "br_pr_merged", repo, brId: `BR#${br[1]}`, raw: line.trim().slice(0, 200) });
        lineYielded = true;
      }
    }

    // issue_closed: "GH#N closed" / "issue #N is CLOSED" / URL + closed
    const issueClosed = /(?:GH\s?#|GH#|issue\s+#|issues\/)(\d+)\s*(?:is\s+)?(?:CLOSED|closed)\b/i.exec(line);
    if (issueClosed) {
      const n = Number(issueClosed[1]);
      atoms.push({ kind: "issue_closed", repo, number: n, raw: line.trim().slice(0, 200) });
      lineYielded = true;
    }

    // br_done: "BR#N done" / "BR#N is done"
    const brDone = /\bBR#(\d+)\s+(?:is\s+)?done\b/i.exec(line);
    if (brDone) {
      atoms.push({ kind: "br_done", repo: null, brId: `BR#${brDone[1]}`, raw: line.trim().slice(0, 200) });
      lineYielded = true;
    }

    // run_success: "run <id> … SUCCESS / green"
    const runOk = /\brun\s+(\d{6,})\b/.exec(line);
    if (runOk && /\b(?:SUCCESS|success|green)\b/.test(line)) {
      atoms.push({ kind: "run_success", repo, runId: runOk[1], raw: line.trim().slice(0, 200) });
      lineYielded = true;
    }

    // pr_checks_green: "a fresh green check run … on PR #N (head)"
    const checks = /green\s+check\s+run\b[^.]{0,100}?\bPR\s+#?(\d+)\b/i.exec(line);
    if (checks) {
      atoms.push({ kind: "pr_checks_green", repo, number: Number(checks[1]), raw: line.trim().slice(0, 200) });
      lineYielded = true;
    }

    if (!lineYielded && LOOKS_MACHINE.test(line)) unparseable = true;
  }
  return { atoms, unparseable };
}

// ---------- 1b. sweep spawn receipts (the stale-true dedup, BR#3668) ----------

/**
 * Extract the receipt lines a sweep spawn was fired ON, from the spawned
 * duty body's "MACHINE PROXY … (receipts):" block (its `- "raw" → receipt`
 * lines). Empty for duty bodies without the block — park-time machine
 * rounds, close-leg duties, correction duties — so the dedup never
 * suppresses a spawn on their account (their receipts live in the note, not
 * the template).
 */
export function proxySpawnReceipts(dutyBodyMd: string): string[] {
  const body = String(dutyBodyMd ?? "");
  const at = body.indexOf("MACHINE PROXY");
  if (at < 0) return [];
  const out: string[] = [];
  for (const line of body.slice(at).split(/\r?\n/)) {
    if (/^\s*-\s+/.test(line)) out.push(line.replace(/^\s*-\s+/, "").trim());
    else if (out.length) break; // the block ends at the first non-item line
  }
  return out;
}

/** Receipt-set identity: same lines, same order. Order is the parse order —
 *  deterministic for the same condition text and board state, so line-wise
 *  equality is the honest "did the evaluated receipt change" test. */
export function sameProxyReceipts(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// ---------- 2. terminal close legs ----------

export interface CloseLeg {
  /** repo slug; null = bare "#N" with no repo in the text (the gate still
   *  enforces the receipt; live checks need the default repo setting) */
  repo: string | null;
  number: number;
  raw: string;
}

const CLOSE_PATTERNS: RegExp[] = [
  /\bclose(?:s|d)?\s+(?:the\s+)?(?:GH\s?#|GH#|issue\s+#)(\d+)/gi,
  /\bclose(?:s|d)?\s+(?:the\s+)?#(\d+)\b/gi,
  /\bclose(?:s|d)?\s+(?:the\s+)?(?:issue\s+)?https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/gi,
  // Receipt-shaped claims ARE close claims: "GH #2274 CLOSED/COMPLETED",
  // "GH#2337 fully closed" (BR#3220's false note — lowercase, sloppy shape).
  // Triggering the leg demand is the safe direction; the receipt parser above
  // stays strict about what satisfies it.
  /\b(?:GH\s?#|GH#|issue\s+#)(\d+)\s*(?:is\s+)?(?:now\s+)?(?:CLOSED|COMPLETED)\b/g,
  /\b(?:GH\s?#|GH#|issue\s+#)(\d+)[^.\n]{0,24}?\bclosed\b/gi,
];

/**
 * Terminal close-leg intents AND receipt-shaped claims: "close GH #2274",
 * "close the issue #2261", "close https://github.com/owner/repo/issues/2261",
 * "GH #2274 CLOSED/COMPLETED", "GH#2337 fully closed". Board-card references
 * ("closes BR#3337 done") deliberately do NOT parse — a BR# is not a GitHub
 * issue, and the unblock-duty contract language must not manufacture legs.
 */
export function parseCloseLegs(text: string): CloseLeg[] {
  const byRepo = new Map<number, CloseLeg>(); // URL-form legs (repo known)
  const bare = new Map<number, CloseLeg>(); // bare "#N" legs (repo unknown)
  for (const re of CLOSE_PATTERNS) {
    re.lastIndex = 0;
    for (const m of String(text ?? "").matchAll(re)) {
      if (m[3] !== undefined) byRepo.set(Number(m[3]), { repo: `${m[1]}/${m[2]}`, number: Number(m[3]), raw: m[0] });
      else bare.set(Number(m[1]), { repo: null, number: Number(m[1]), raw: m[0] });
    }
  }
  // URL-form and bare-form legs for the same number are the same leg
  for (const [n, leg] of bare) if (!byRepo.has(n)) byRepo.set(n, leg);
  return [...byRepo.values()];
}

/** The "## Done when" section of a card body — the contract the done gate
 *  reads terminal legs from. Empty when the card carries no such section. */
export function doneWhenSection(bodyMd: string): string {
  const body = String(bodyMd ?? "");
  const m = /^##\s*done\s*when\b.*$/im.exec(body);
  if (!m) return "";
  const rest = body.slice(m.index + m[0].length);
  const next = /\n##\s/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

// ---------- 3. closure receipts ----------

export interface ClosureReceipt {
  /** an explicit closedness statement was found ("state=closed", "CLOSED",
   *  "closedAt") — intent language ("close GH #N") does not count */
  closed: boolean;
  /** closing-comment id: "closing comment 123", "comment 123", or an
   *  issues/#N#issuecomment-123 URL */
  commentId: string | null;
  /** guard-run id: "guard run 123" / "guard=allow" / literal n/a */
  guardRun: string | null;
}

/** The receipt format the done gate demands, for messages and docs. */
export const RECEIPT_CONTRACT =
  "state=closed + closing-comment id (or the comment URL) + guard run id (or n/a)";

function receiptWindow(note: string, leg: CloseLeg): { w: string; post: string }[] {
  const windows: { w: string; post: string }[] = [];
  const needle = String(leg.number);
  for (const m of note.matchAll(new RegExp(`(?:issues/${needle}\\b|#\\s*${needle}\\b)`, "g"))) {
    const at = m.index!;
    const post = note.slice(at, at + 600); // receipts follow the leg mention
    windows.push({ w: note.slice(Math.max(0, at - 120), at + 600), post });
  }
  if (!windows.length) windows.push({ w: note, post: note });
  return windows;
}

function extractCommentId(w: string): string | null {
  return (
    /issuecomment-(\d{6,})/.exec(w)?.[1] ??
    /closing[- ](?:comment|id)\s*[:#]?\s*(\d{6,})/i.exec(w)?.[1] ??
    /comment\s+(?:id\s*)?[:#]?\s*(\d{6,})/i.exec(w)?.[1] ??
    null
  );
}

function extractGuardRun(w: string): string | null {
  return (
    /guard\s*run\s*[:#]?\s*(\d{6,})/i.exec(w)?.[1] ??
    /actions\/runs\/(\d{6,})/.exec(w)?.[1] ??
    (/guard\s*=\s*allow|guard\s+run\s+[^.\n]{0,80}\ballow\b/i.test(w) ? "allow" : null) ??
    (/guard\s*run\s*[:#]?\s*n\/a/i.test(w) ? "n/a" : null)
  );
}

/**
 * Find the closure receipt for one close leg in a done note. Returns null
 * when no closedness statement is present at all (the note mentions the
 * issue but claims nothing about its state) — the gate then rejects the
 * done with the receipt contract.
 */
export function parseClosureReceipt(note: string, leg: CloseLeg): ClosureReceipt | null {
  for (const { w, post } of receiptWindow(String(note ?? ""), leg)) {
    const closed =
      /state\s*[=:]\s*["']?closed/i.test(w) ||
      /closedAt\b/i.test(w) ||
      /(?:^|[^a-z-])CLOSED\b/.test(w) ||
      /issues\/\d+[#\s][^]{0,200}?\bstate\b[^\n]{0,24}closed/i.test(w);
    if (!closed) continue;
    // ids prefer the post-mention text — real notes pack receipts leg beside
    // leg, and the pre-context of leg N+1 contains leg N's ids
    return {
      closed: true,
      commentId: extractCommentId(post) ?? extractCommentId(w),
      guardRun: extractGuardRun(post) ?? extractGuardRun(w),
    };
  }
  return null;
}

/** Human label for a leg in gate messages and audit lines. */
export function legLabel(leg: CloseLeg): string {
  return `${leg.repo ?? "GH"}#${leg.number}`;
}

// ---------- 4. typed await events (BR#3578) ----------
//
// A blocked card MUST await something. The free-text unblock_condition was
// the "blocked forever" hole: prose stamps unparseable and never auto-flips.
// The law: every blocked transition carries a TYPED await event from a
// closed grammar — a machine-checkable upstream event, an open ask (the
// human leg, active in For Me), or a timer. Free text stays as optional
// human-friendly annotation, DERIVED from the structured event when absent.

export type AwaitEvent =
  | { event: "pr_merged"; repo: string; n: number }
  | { event: "br_pr_merged"; id: string }
  | { event: "issue_closed"; repo: string; n: number }
  | { event: "br_done"; id: string }
  | { event: "run_success"; repo: string; run_id?: string; newer_than?: string }
  | { event: "pr_checks_green"; repo: string; n: number }
  | { event: "ask"; ask_id: string }
  | { event: "time"; until_ts: number };

export const AWAIT_EVENT_KINDS = [
  "pr_merged", "br_pr_merged", "issue_closed", "br_done",
  "run_success", "pr_checks_green", "ask", "time",
] as const;

export const AWAIT_GRAMMAR_DOC =
  'typed await_event (closed set): {event:"pr_merged",repo,n} | {event:"br_pr_merged",id} | {event:"issue_closed",repo,n} | {event:"br_done",id} | {event:"run_success",repo,run_id?,newer_than?} | {event:"pr_checks_green",repo,n} | {event:"ask",ask_id} (an OPEN ask) | {event:"time",until_ts}';

/** Closed-set validation. Returns the normalised event or null (fail-closed). */
export function validateAwaitEvent(v: unknown): AwaitEvent | null {
  if (typeof v !== "object" || v === null) return null;
  const e = v as Record<string, unknown>;
  const kind = String(e.event ?? "");
  const repo = typeof e.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(e.repo) ? e.repo : null;
  const num = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x > 0;
  const id = (x: unknown) => typeof x === "string" && /^BR#\d+$/.test(x) ? x : null;
  switch (kind) {
    case "pr_merged":
    case "issue_closed":
    case "pr_checks_green":
      return repo && num(e.n)
        ? ({ event: kind, repo, n: e.n } as AwaitEvent)
        : null;
    case "br_pr_merged":
    case "br_done":
      return id(e.id) ? ({ event: kind, id: e.id } as AwaitEvent) : null;
    case "run_success": {
      if (!repo) return null;
      const rid = typeof e.run_id === "string" && /^\d{6,}$/.test(e.run_id) ? e.run_id : undefined;
      const nt = typeof e.newer_than === "string" && /^\d{6,}$/.test(e.newer_than) ? e.newer_than : undefined;
      return rid || nt ? { event: "run_success", repo, run_id: rid, newer_than: nt } : null;
    }
    case "ask":
      return typeof e.ask_id === "string" && e.ask_id.trim() ? { event: "ask", ask_id: e.ask_id.trim() } : null;
    case "time":
      return typeof e.until_ts === "number" && Number.isFinite(e.until_ts) && e.until_ts > 0
        ? { event: "time", until_ts: e.until_ts }
        : null;
    default:
      return null;
  }
}

/** Typed event → the sweep's ProxyAtom (ask/time evaluate on their own). */
export function awaitEventToAtom(e: AwaitEvent): ProxyAtom | null {
  switch (e.event) {
    case "pr_merged": return { kind: "pr_merged", repo: e.repo, number: e.n, raw: describeAwaitEvent(e) };
    case "br_pr_merged": return { kind: "br_pr_merged", repo: null, brId: e.id, raw: describeAwaitEvent(e) };
    case "issue_closed": return { kind: "issue_closed", repo: e.repo, number: e.n, raw: describeAwaitEvent(e) };
    case "br_done": return { kind: "br_done", repo: null, brId: e.id, raw: describeAwaitEvent(e) };
    case "run_success": return { kind: "run_success", repo: e.repo, runId: e.run_id ?? e.newer_than, raw: describeAwaitEvent(e) };
    case "pr_checks_green": return { kind: "pr_checks_green", repo: e.repo, number: e.n, raw: describeAwaitEvent(e) };
    case "ask": case "time": return null;
  }
}

/** Human-friendly condition text, derived from the structured event. */
export function describeAwaitEvent(e: AwaitEvent): string {
  switch (e.event) {
    case "pr_merged": return `PR ${e.repo}#${e.n} merged (mergeCommit non-null)`;
    case "br_pr_merged": return `${e.id}'s fix PR (head branch bridge/${e.id.slice(3)}) merged`;
    case "issue_closed": return `GH issue ${e.repo}#${e.n} closed`;
    case "br_done": return `${e.id} done`;
    case "run_success":
      return e.run_id
        ? `GitHub run ${e.repo}/${e.run_id} conclusion=success`
        : `a GitHub Actions run on ${e.repo} newer than ${e.newer_than} with conclusion=success`;
    case "pr_checks_green": return `all checks green on PR ${e.repo}#${e.n}`;
    case "ask": return `ask ${e.ask_id} answered`;
    case "time": return `timer elapsed (until_ts ${e.until_ts})`;
  }
}

/** Migration shim: a legacy text condition that parses cleanly to exactly
 *  one machine atom becomes the typed event for it. Multiple atoms or
 *  unparseable text stays text (the sweep's ask-migration handles the rest). */
export function awaitEventFromAtoms(atoms: ProxyAtom[]): AwaitEvent | null {
  if (atoms.length !== 1) return null;
  const a = atoms[0];
  switch (a.kind) {
    case "pr_merged": return a.repo && a.number ? { event: "pr_merged", repo: a.repo, n: a.number } : null;
    case "br_pr_merged": return a.brId ? { event: "br_pr_merged", id: a.brId } : null;
    case "issue_closed": return a.repo && a.number ? { event: "issue_closed", repo: a.repo, n: a.number } : null;
    case "br_done": return a.brId ? { event: "br_done", id: a.brId } : null;
    case "run_success": return a.repo && a.runId ? { event: "run_success", repo: a.repo, run_id: a.runId } : null;
    case "pr_checks_green": return a.repo && a.number ? { event: "pr_checks_green", repo: a.repo, n: a.number } : null;
  }
}
