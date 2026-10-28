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
  kind:
    | "pr_merged"
    | "br_pr_merged"
    | "issue_closed"
    | "br_done"
    | "run_success"
    | "pr_checks_green"
    | "deployed";
  /** repo slug "owner/name"; null = no repo resolvable from the text (the
   *  atom is then unresolvable — the condition can never auto-flip) */
  repo: string | null;
  number?: number;
  brId?: string;
  runId?: string;
  /** deployed: the hub-worker commit prefix the card waits for (7-40 hex).
   *  The ONLY credential-free external-state atom: the hub evaluates it
   *  against its OWN baked version stamp — no GitHub creds, no guesswork. */
  commit?: string;
  raw: string;
}

export interface ParsedCondition {
  atoms: ProxyAtom[];
  /** machine-predicate-looking text that produced NO atom — the sweep must
   *  never auto-flip such a card (it cannot fully read the condition) */
  unparseable: boolean;
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

function repoFromLine(line: string): string | null {
  const m = /github\.com\/([\w.-]+)\/([\w.-]+)/.exec(line);
  return m ? `${m[1]}/${m[2].replace(/\.git$/, "")}` : null;
}

/** ALL pull-URL numbers on the line — a conjunction may merge several PRs
 *  (BR#3986: first-match exec silently swallowed every condition after the
 *  first, so the sweep gated on the wrong atom). */
function numbersFromPullUrls(line: string): number[] {
  return [...String(line ?? "").matchAll(/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/g)].map((m) => Number(m[1]));
}

/** Dedupe key for atoms of the same kind pointing at the same target — the
 *  same BR#/PR#/run mentioned twice on one line is ONE condition, not two. */
function atomKey(a: ProxyAtom): string {
  const target = a.brId ?? (a.number !== undefined ? String(a.number) : a.runId ?? a.commit ?? "");
  return `${a.kind}|${a.repo ?? ""}|${target}`;
}

/**
 * Extract machine-checkable atoms from an unblock condition. One line may
 * yield several atoms (a conjunction); the sweep flips only when EVERY atom
 * evaluates TRUE and nothing is unparseable.
 */
export function parseProxyCondition(text: string): ParsedCondition {
  const atoms: ProxyAtom[] = [];
  const seen = new Set<string>();
  let unparseable = false;
  // Cut the DUTY clauses over the WHOLE text before splitting: real conditions
  // enumerate the duty steps with semicolons ("then a fresh session: (1) …;
  // (2) close GH #N …; (3) exit …") — splitting first would orphan each step
  // from its duty marker and the step's own machine-looking text ("close GH
  // #N") would mark the condition unparseable (BR#3129's real condition).
  const duty = cutDutyClauses(String(text ?? ""));
  for (const rawLine of duty.split(/\r?\n|(?<=;)\s*/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const repo = repoFromLine(line);
    const raw = line.slice(0, 200);
    let lineYielded = false;
    const push = (a: Omit<ProxyAtom, "raw">) => {
      const atom = { ...a, raw } as ProxyAtom;
      const key = atomKey(atom);
      if (seen.has(key)) {
        lineYielded = true; // a dup of an earlier line's atom still parsed
        return;
      }
      seen.add(key);
      atoms.push(atom);
      lineYielded = true;
    };

    // pr_merged: "PR <url|#N> … mergeCommit non-null / state MERGED / merged"
    // ALL PR numbers on the line (BR#3986: first-match exec truncated
    // conjunctions — "PR #1 merged AND PR #2 merged" gated on #1 only).
    let prMerged = false;
    if (/\b(?:is\s+)?(?:mergeCommit\s+non-null|state[:\s]+MERGED\b|MERGED\b|merged\b)/i.test(line)) {
      const nums = new Set<number>(numbersFromPullUrls(line));
      for (const m of line.matchAll(/PR\s+#?(\d+)\b/g)) nums.add(Number(m[1]));
      for (const n of nums) push({ kind: "pr_merged", repo, number: n });
      prMerged = nums.size > 0;
    }

    // br_pr_merged: "BR#N's fix PR on <repo> is MERGED" — the PR itself is
    // unnamed; the sweep resolves it by head branch bridge/BR-<N>. Only when
    // the line didn't already name a concrete PR; every BR# on the line.
    if (!prMerged && repo && /(?:fix\s+)?PR\b/.test(line) && /\b(?:mergeCommit\s+non-null|state[:\s]+MERGED\b|MERGED\b|merged\b)/i.test(line)) {
      for (const m of line.matchAll(/\bBR#(\d+)\b/g)) push({ kind: "br_pr_merged", repo, brId: `BR#${m[1]}` });
    }

    // issue_closed: "GH#N closed" / "issue #N is CLOSED" / URL + closed —
    // every GH# on the line.
    for (const m of line.matchAll(/(?:GH\s?#|GH#|issue\s+#|issues\/)(\d+)\s*(?:is\s+)?(?:CLOSED|closed)\b/gi)) {
      push({ kind: "issue_closed", repo, number: Number(m[1]) });
    }

    // br_done: "BR#N done" / "BR#N is done" — EVERY "BR#N done" on the line.
    // The headline BR#3986 defect: non-global exec yielded the FIRST match
    // only, so "BR#3945 done AND BR#3946 done" gated on BR#3945 alone while
    // BR#3946 vanished from the machine gate entirely.
    for (const m of line.matchAll(/\bBR#(\d+)\s+(?:is\s+)?done\b/gi)) {
      push({ kind: "br_done", repo: null, brId: `BR#${m[1]}` });
    }

    // run_success: "run <id> … SUCCESS / green" — every run on the line.
    if (/\b(?:SUCCESS|success|green)\b/.test(line)) {
      for (const m of line.matchAll(/\brun\s+(\d{6,})\b/g)) push({ kind: "run_success", repo, runId: m[1] });
    }

    // pr_checks_green: "a fresh green check run … on PR #N (head)" — every
    // PR the green-check sentence names.
    for (const m of line.matchAll(/green\s+check\s+run\b[^.]{0,100}?\bPR\s+#?(\d+)\b/gi)) {
      push({ kind: "pr_checks_green", repo, number: Number(m[1]) });
    }

    if (!lineYielded && LOOKS_MACHINE.test(line)) unparseable = true;
  }
  return { atoms, unparseable };
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
  | { event: "deployed"; commit: string }
  | { event: "ask"; ask_id: string }
  | { event: "time"; until_ts: number };

export const AWAIT_EVENT_KINDS = [
  "pr_merged", "br_pr_merged", "issue_closed", "br_done",
  "run_success", "pr_checks_green", "deployed", "ask", "time",
] as const;

export const AWAIT_GRAMMAR_DOC =
  'typed await_event (closed set): {event:"pr_merged",repo,n} | {event:"br_pr_merged",id} | {event:"issue_closed",repo,n} | {event:"br_done",id} | {event:"run_success",repo,run_id?,newer_than?} | {event:"pr_checks_green",repo,n} | {event:"deployed",commit} (the HUB worker deployed at that commit, 7-40 hex prefix) | {event:"ask",ask_id} (an OPEN ask) | {event:"time",until_ts}';

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
    case "deployed":
      return typeof e.commit === "string" && /^[0-9a-f]{7,40}$/i.test(e.commit)
        ? { event: "deployed", commit: e.commit.toLowerCase() }
        : null;
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
    case "deployed": return { kind: "deployed", repo: null, commit: e.commit, raw: describeAwaitEvent(e) };
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
    case "deployed": return `the hub worker is deployed at commit ${e.commit} (prefix match against its own version stamp)`;
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
    case "deployed": return a.commit ? { event: "deployed", commit: a.commit } : null;
  }
}

/** Self-referential await (BR#3986 / the BR#136 deadlock): a card awaiting
 *  its own done can never fire — the typed event's subject only reaches that
 *  state AFTER the card unblocks, so the park deadlocks silently. Pure +
 *  exported for the park gate and the regression tests. */
export function isSelfAwait(cardId: string, e: AwaitEvent): boolean {
  return (e.event === "br_done" || e.event === "br_pr_merged") && e.id === cardId;
}

/** Whether the hub's OWN deployed commit satisfies a `deployed` atom: prefix
 *  match both ways (the card may pin 7-hex, the stamp is 40-hex, and future
 *  deploys only ADD commits — a newer stamp still satisfies an older pin).
 *  Pure + exported for the regression test. */
export function deployedSatisfied(hubCommit: string | null, wanted: string): boolean {
  if (!hubCommit || hubCommit === "unknown") return false;
  const h = hubCommit.toLowerCase();
  const w = wanted.toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(w)) return false;
  return h.startsWith(w) || w.startsWith(h);
}
