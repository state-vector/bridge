// THE task lifecycle law — one table, one total executor. Every transition
// rule lives here as a declarative row; do.ts persists and executes the
// effects but never invents legality. Adding a rule = adding a row (+ its
// guard test); the matrix suite then covers it mechanically.
//
// Layering: core.ts LIFECYCLES owns the per-type edge shape (which statuses
// may follow which); this module owns the ROLE + INTENT law layered on top —
// who may move what, carrying what evidence. Verdict duties (role:review,
// role:unblock) are done-only terminals: blocked/in_review are not in their
// alphabet (the only carve-out is an ask-gate, which auto-resumes on answer).
//
// Contract (BR#2419 item 2): decide() is TOTAL and PURE — it returns
// Applied(effects) | Rejection{code, rule, message}. Effects (spawn, escalate,
// supersede cascades) are DECIDED here and EXECUTED by do.ts. No legality and
// no spawn/escalate decision lives outside this file.
import { parseTags, validateTransition, releaseHold, trainPrLeg } from "./core";
import { parseCloseLegs, parseClosureReceipt, doneWhenSection, legLabel, RECEIPT_CONTRACT, parseForceClose, FORCE_CLOSE_DOC, validateAwaitEvent, parseProxyCondition, awaitEventFromAtoms, describeAwaitEvent, isSelfAwait, AWAIT_GRAMMAR_DOC, type CloseLeg } from "./closure";

export type Role = "impl" | "analysis" | "review" | "unblock" | "human" | "plain";

/** A task's lane from its roles column (bare names, JSON array). Tags never
 *  carry roles — they are inert user labels (decision BR#2983). */
export function effectiveRole(roles: string[]): Role {
  if (roles.includes("review")) return "review";
  if (roles.includes("unblock")) return "unblock";
  if (roles.includes("analysis")) return "analysis";
  if (roles.includes("impl")) return "impl";
  if (roles.includes("human")) return "human";
  return "plain";
}

export const VERDICT_ROLES: Role[] = ["review", "unblock"];

const HUMAN_ACTOR = /^web(:|$)|^human:/;
// system actors (watchdog, churn-guard, separation) act ON claims — releases
// they perform are the machinery working, not agents dumping each other's work
const OWNER_RELEASE_EXEMPT = /^(web(:|$)|human:|system:)/;

export interface RuleInput {
  id: string;
  type: string;
  status: string;
  to: string;
  roles: string[];
  tags: string[];
  meta: any;
  actor: string;
  body: any;
  owner?: string; // current claim holder — release-ownership rule reads it
  now?: number; // executor clock (injected; keeps decide() pure/testable)
}

/** Lazy, memoization-friendly accessors — do.ts backs these with SQL; guards
 *  only touch what they need so cheap transitions stay cheap. */
export interface RuleCtx {
  qualify(kind: "analysis" | "review"): { ok: boolean; via?: string } | Promise<{ ok: boolean; via?: string }>;
  unmetBars(): string[] | Promise<string[]>;
  session(): string | null | Promise<string | null>;
  evidence(id: string): { type: string; roles?: string[]; tags?: string[]; meta: any } | null | Promise<{ type: string; roles?: string[]; tags?: string[]; meta: any } | null>;
  parent(): { id: string; status?: string; meta: any } | null | Promise<{ id: string; status?: string; meta: any } | null>;
  openChildren(): number | Promise<number>;
  /** every OPEN child id (self-edges excluded — BR#3819: state that cannot
   *  exist is never read); the force-close grammar validates against it */
  openChildIds(): string[] | Promise<string[]>;
  /** verify-of-verify / nesting-cap guard: the spawn-blocker reason or null */
  spawnGuard(): string | null | Promise<string | null>;
  /** newest OPEN role:review child (reuse candidate), or null */
  openVerifyChild(): { id: string } | null | Promise<{ id: string } | null>;
  /** newest OPEN role:unblock child (cap ≤1 per parent), or null */
  openUnblockChild(): { id: string } | null | Promise<{ id: string } | null>;
  /** the task's own body_md (the Done-when section lives there) */
  cardBody(): string | Promise<string>;
  /** a CLOSED child task of this task that owns the given close leg (its
   *  title/body names the close and the issue) — BR#3361 terminal-leg ownership */
  closeLegChildClosed(leg: CloseLeg): boolean | Promise<boolean>;
  /** recent version-log rows (newest first) for the silent-churn fold */
  recentEvents(): { ts: number; actor: string; action: string; summary: string }[] | Promise<{ ts: number; actor: string; action: string; summary: string }[]>;
}

export type Guard = (i: RuleInput, c: RuleCtx) => string | null | Promise<string | null>;

export interface Rule {
  name: string;
  when: (i: RuleInput) => boolean;
  guard: Guard;
}

const role = (i: RuleInput) => effectiveRole(i.roles ?? []);
const isTask = (i: RuleInput) => i.type === "task";
const noteOf = (i: RuleInput) => String(i.body?.note ?? i.body?.resolution ?? i.body?.reason ?? "").trim();
const hasEvidenceLink = (s: string) => /https?:\/\/\S+|(^|\s)PR[\s#:]/i.test(s);
const hasReceipts = (s: string) => /https?:\/\/\S+|(^|\s)(PR|merged|passed|unblocked|still blocked)\b/i.test(s);
/** BR#4295: the receipts shape hasReceipts accepts — one source of truth for
 *  the guard's rejection text (so an agent obeying it verbatim passes on the
 *  retry, never flails: each rejection is a breach event) and for every
 *  unblock-duty spawn template (do.ts), so future duties close first-try.
 *  Specimen BR#3735/BR#4291: the old message invited "the check you ran" and
 *  "the unblock verdict" — prose the matcher can never accept. */
export const RECEIPTS_DOC = "any URL, or one of the verdict tokens (PR / merged / passed / unblocked / still blocked)";

/** SQL rows carry meta as a JSON string; tests and callers may pass objects.
 *  Parse tolerantly either way — garbage parses as empty, never throws. */
export function metaOf(m: unknown): any {
  if (typeof m === "string") {
    try {
      return JSON.parse(m || "{}");
    } catch {
      return {};
    }
  }
  return m ?? {};
}

// Churn policy (server-side single source): a task released to the pool this
// many times without completing stops re-entering silently.
export const CHURN_REDIRECT_ATTEMPTS = 5; // impl/analysis: release redirects to blocked
export const CHURN_ESCALATE_ATTEMPTS = 3; // verdict roles: escalate to human (they may not block)

/** What the release path does with a task re-entering the pool. */
export type ChurnOutcome = "pass" | "escalate" | "redirect";

/**
 * The churn decision for one release, as a pure function so every host obeys
 * the same counter (BR#2404/BR#2420 — the silent-dispatch loop class: claim →
 * stall → watchdog release → re-claim, forever). Verdict duties
 * (role:review/role:unblock) may not block, so at CHURN_ESCALATE_ATTEMPTS they
 * escalate to a human instead of redirecting; everything else stops silently
 * re-entering at CHURN_REDIRECT_ATTEMPTS — the release becomes an honest
 * blocked record. Releasing an already-blocked task is a deliberate act and
 * never re-redirects.
 */
export function churnRelease(nextAttempts: number, verdictDuty: boolean, fromStatus: string): ChurnOutcome {
  if (verdictDuty && nextAttempts >= CHURN_ESCALATE_ATTEMPTS) return "escalate";
  if (nextAttempts >= CHURN_REDIRECT_ATTEMPTS && fromStatus !== "blocked") return "redirect";
  return "pass";
}

// Silent-churn policy: zero-output watchdog stall cycles, folded server-side
// from the version log (a stall with NO interleaved agent output is one
// cycle). Escalation must trip at ≤5 cycles per BR#2419 — no runner counter,
// no cross-host signature.
export const SILENT_ESCALATE_CYCLES = 3; // verdict duties
export const SILENT_REDIRECT_CYCLES = 5; // impl/analysis

/** BR#4248: the churn redirect parks on a typed COOLDOWN TIMER, not prose.
 *  The park's await_event ({event:"time"}) is the machine-readable exit the
 *  proxy sweep evaluates; on fire the unblock duty re-checks and releases
 *  (a proven-unblock release resets the attempt counter). 24h matches the
 *  gate-rejection reaper fuse (do.ts reapAbandoned idleLimit): both
 *  mechanisms promise the same thing — nobody will look at this for a day,
 *  then it comes back on its own. */
export const CHURN_COOLDOWN_MS = 24 * 60 * 60_000;

// Flood guard: a superseded unblock round still counts while fresh (<60m) and
// the exit condition is unchanged — the BR#909 class spawned one child per
// churn cycle (17 cards) because each cycle superseded the last.
export const UNBLOCK_FLOOD_MS = 60 * 60_000;

// ---------- effects: decided here, executed by do.ts ----------

/** Whether url parses as a shape the runner's scm registry can clone: a GitHub
 *  repo or PR reference, or a full .git clone URL. Anything else (truncated
 *  fragments, runs/issues pages of unknown repos, prose) is not a receipt the
 *  runner should clone. */
export function isClonableRepoRef(url: string): boolean {
  return /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\/pull\/\d+)?\/?$/.test(url)
    || /^https?:\/\/\S+\.git$/.test(url);
}

/** The PR/repo receipt a spawned verify body may cite, extracted from the
 *  handoff note. The runner captures agent output at terminal width and
 *  hard-wraps mid-word, so the first URL in a note is routinely split across
 *  lines ("…/state-vector/super\npositional/pull/2343"); the old bare
 *  `https?://\S+` scrape stamped the truncated prefix
 *  (https://github.com/state-vector/super) into verify bodies and the runner
 *  cloned the ghost repo — dispatch skipped, task churned (BR#3845 ×11).
 *  Unwrap line breaks first, then accept only a clonable reference — else
 *  null (the verify body renders "see note": a repo-less dispatch, never a
 *  ghost clone). */
export function prFromNote(note: string): string | null {
  const flat = note.replace(/\r?\n/g, "");
  for (const m of flat.matchAll(/https?:\/\/\S+/g)) {
    const url = m[0].replace(/[.,;:!?)\]>'"]+$/, "");
    if (isClonableRepoRef(url)) return url;
  }
  return null;
}

export type Effect =
  | { kind: "spawn_verify"; parent: string; pr: string | null }
  | { kind: "reuse_verify"; parent: string; verify: string }
  | { kind: "skip_verify_spawn"; parent: string; reason: string }
  | { kind: "spawn_unblock"; parent: string; reason: string; exit_condition: string }
  | { kind: "skip_unblock_spawn"; parent: string; reason: string; flood?: boolean }
  | { kind: "supersede_children"; parent: string; tag: "review" | "unblock" | "question"; keep_newest: boolean; cause: string }
  | { kind: "escalate"; attempts: number; silent_cycles: number; reason: string }
  | { kind: "release_redirect"; attempts: number; silent_cycles: number };

/** meta_patch: entries with value `undefined` DELETE the key (typed stamping). */
export interface Applied {
  ok: true;
  status: string; // final status to write — the churn redirect may override the requested edge
  owner_clear: boolean; // release semantics: drop the claim
  tags_add: string[];
  meta_patch: Record<string, unknown | undefined>;
  effects: Effect[];
}

export type RejectionCode = "illegal-edge" | "guard-failed";

export interface Rejection {
  ok: false;
  code: RejectionCode; // illegal-edge = not a lifecycle edge; guard-failed = a table row refused it
  rule: string; // "lifecycle" for illegal edges, else the table row's name
  message: string;
}

export type Verdict = Applied | Rejection;

// ---------- blocked-park law (BR#2893): the parking lot gets a clock ----------
//
// Blocked cards had no clock: the watchdog swept in_progress (silence) and
// in_review (stalled rounds) but blocked rows were swept by NOTHING, and the
// only legal releasers are the card's owner or a human — so a park whose
// owner is a dead runner label stayed parked forever. This classifier names
// each park: the two DEAD shapes (churn-guard boilerplate — a retry
// instruction stamped as a block; unresolvable ASK- refs — a wait that can
// never fire) drain automatically; true external gates (dated checkpoint,
// GitHub lane, red-main) are exempt and render under "awaiting external
// input"; everything else ages out past the blocked-staleness bar.

/** The churn guard's own unblock boilerplate (do.ts release_redirect path) —
 *  a retry instruction, not a blocker. Textually identical to the client
 *  mirror in ui-kit server/views.ts; change both together. */
export const CHURN_UNBLOCK_RX = /read the task history \(get_history\) and the last gate error/i;
export const CHURN_REASON_RX = /^churn guard:/i;

/** ASK- references inside unblock conditions ("Ray answers ASK-xyz-abc"). */
// BR#4563: left word-boundary. Without it, a prose unblock_condition naming a
// task id ("…a FRESH verify session closes TASK-016 done…") yields the phantom
// ref "ASK-016" — the substring inside the id — every ask-liveness lookup
// misses, blockedParkVerdict misclassifies the park dead-ask, and the
// blocked-staleness drain re-attempts a machine release every sweep tick; the
// BR#4067 backstop refuses each attempt and the rejection stream piles up as
// breach cards (specimen TASK-016 / BR#4563). \b fails inside "TASK" (T|A are
// both word chars) and still matches real refs after whitespace, string start,
// "(" or "#".
export const ASK_REF_RX = /\bASK-[a-zA-Z0-9._-]+/g;

const PARK_DATE_RX = /\b(20\d{2})-(\d{2})-(\d{2})(?!\d)/g;
const PARK_GH_LANE_RX = /github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/\d+|\bGH#\d+\b/i;
const PARK_RED_MAIN_RX = /\bred\s+main\b|\bmain\s+is\s+red\b|\bstop-the-line\b|\buntil main (is )?green\b/i;

export type BlockedParkClass = "churn-park" | "dead-ask" | "external" | "plain";

/** Classify one parked blocked card. Pure — do.ts supplies the ask-liveness
 *  lookup, tests supply fixtures. Order matters: dead shapes win over
 *  external markers (a churn park that name-drops a date is still a churn
 *  park), and ask refs are judged only when EVERY referenced ask is closed. */
export function blockedParkVerdict(input: {
  reason: string;
  unblockCondition: string;
  now: number;
  staleMs: number;
  blockedTs?: number;
  askIsOpen?: (id: string) => boolean;
}): { klass: BlockedParkClass; why: string } {
  const reason = String(input.reason ?? "");
  const unblock = String(input.unblockCondition ?? "");
  // 1. churn parks: the guard's own boilerplate — dead at any age
  if (CHURN_REASON_RX.test(reason) || CHURN_UNBLOCK_RX.test(unblock))
    return { klass: "churn-park", why: "churn-guard park — a retry instruction stamped as a block" };
  // 2. ask-ref parks: every referenced ask is gone/expired/answered — the
  //    wait can never fire (an OPEN ask keeps the card ask-gated upstream)
  const refs = [...new Set(unblock.match(ASK_REF_RX) ?? [])];
  if (refs.length) {
    const dead = refs.filter((r) => !(input.askIsOpen ? input.askIsOpen(r) : true));
    if (dead.length === refs.length)
      return { klass: "dead-ask", why: `unresolvable ask ref(s) ${dead.join(", ")} — none is open` };
  }
  // 3. true external gates: future-dated checkpoint, a GitHub lane, red-main
  for (const m of unblock.matchAll(PARK_DATE_RX)) {
    const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    if (!Number.isNaN(t) && t >= input.now - 24 * 3_600_000)
      return { klass: "external", why: `dated checkpoint ${m[0]}` };
  }
  if (PARK_GH_LANE_RX.test(unblock)) return { klass: "external", why: "GitHub issue/PR lane" };
  if (PARK_RED_MAIN_RX.test(unblock)) return { klass: "external", why: "destination-main health gate" };
  // 4. an honest park that still ages out
  const age = input.now - (input.blockedTs ?? 0);
  if (input.blockedTs && age > input.staleMs)
    return { klass: "plain", why: `parked ${Math.round(age / 3_600_000)}h with no external gate (bar: ${Math.round(input.staleMs / 3_600_000)}h)` };
  return { klass: "plain", why: "parked" };
}

/** Unblock-spawner cap (BR#2893): a blocked parent spawns at most this many
 *  unblock duties EVER. Each failed round is one more card manufacturing
 *  work about work; at the cap the spawner stops and escalates once. */
export const UNBLOCK_SPAWN_CAP = 3;

export const RULES: Rule[] = [
  {
    name: "verdict-no-in_review",
    when: (i) => isTask(i) && i.to === "in_review" && VERDICT_ROLES.includes(role(i)),
    guard: (i) =>
      `${i.id} is a ${role(i) === "review" ? "verify" : "unblock"} task — verification is its own terminal state. ${role(i) === "review" ? "Verify" : "Unblock"} tasks close directly via done with receipts; they are never reviewed again.`,
  },
  {
    name: "verdict-no-blocked",
    when: (i) =>
      isTask(i) &&
      i.to === "blocked" &&
      VERDICT_ROLES.includes(role(i)) &&
      !i.body?.awaiting_ask_id, // an ask-gate pauses the duty; it auto-resumes on the answer
    guard: (i) =>
      `${i.id} is a ${role(i) === "review" ? "verify" : "unblock"} task — verdict duties cannot block. They either render the verdict (done with receipts) or record findings and close done; "cannot proceed" is itself a verdict. Escalate via ask_agent instead.`,
  },
  {
    name: "release-needs-ownership",
    when: (i) =>
      isTask(i) &&
      i.to === "todo" &&
      !!i.owner &&
      i.owner !== i.actor &&
      !OWNER_RELEASE_EXEMPT.test(i.actor) &&
      // BR#3611: gateway SELF-release of its own attributed claim. A
      // gateway's claim is attributed — owner = attributedAgent
      // (`owner = attributedAgent ?? actor`, do.ts claim path) — so the
      // gateway's raw actor differs from the owner by construction and the
      // gate above structurally refuses every self-release (the stale-claim
      // path in dispatch.rs never succeeded live). `body.gateway` is derived
      // from the token's gateway tag (mcp.ts, never client args) and
      // `body.agent` is the attributed agent — a plain agent token cannot
      // forge the pair. A DIFFERENT gateway's agent ≠ owner → still gated
      // (claim-race semantics preserved).
      !(i.body?.gateway === true && !!i.body?.agent && i.body.agent === i.owner) &&
      // PROVEN-UNBLOCK RELEASE (2026-10-25, Ray GO): a role:unblock duty that
      // VERIFIED the card's exit condition met may release a PARKED card —
      // scope: from-status blocked (a park, not a live claim) + the release
      // note cites the proof. Live claims stay owner/human-only.
      !(i.status === "blocked" && role(i) === "unblock" && !!noteOf(i)),
    guard: (i) =>
      `task ${i.id} is claimed by ${i.owner} — only the owner, a human, or an unblock duty holding proof of the met exit condition can release it. If the work overlaps yours, coordinate via ask_agent instead.`,
  },
  {
    name: "decision-acceptance-human",
    when: (i) => i.type === "decision" && i.to === "accepted" && !HUMAN_ACTOR.test(i.actor),
    guard: (i) =>
      `decision ${i.id} acceptance is human-authoritative — agents propose, a human accepts in the webapp. Route it to a human for the final say (an ask, or the decisions panel).`,
  },
  {
    // BR#3913 / BR#2508(a): blocked → superseded is a parked card's one drop
    // edge, and it is not agent-executable — dropping work is a
    // human-authority act (BR#2480). It arrives as an ANSWERED ask whose
    // options offer SUPERSEDE (the answer is the authorisation; the askAnswer
    // dispatch leg acts as system:question(<answerer>)) or as a web/admin
    // action. A bare agent session is refused; the machinery (system:) and
    // humans (web:/human:) pass — the same exemption the release-ownership
    // rule uses ("releases are the machinery working, not agents dumping
    // each other's work").
    name: "supersede-authority",
    when: (i) => isTask(i) && i.to === "superseded" && !OWNER_RELEASE_EXEMPT.test(i.actor),
    guard: (i) =>
      `task ${i.id} cannot be superseded by an agent session — dropping a card is a human-authority act (BR#2480). Route it through an answered ask whose options offer SUPERSEDE (the answer is the authorisation) or the web.`,
  },
  {
    name: "human-signoff-done",
    when: (i) => isTask(i) && i.to === "done" && role(i) === "human" && !HUMAN_ACTOR.test(i.actor),
    guard: (i) =>
      `task ${i.id} is a human sign-off task (role: human) — completion is human-authoritative; a human marks it done in the webapp.`,
  },
  {
    name: "claim-bars",
    when: (i) => isTask(i) && i.status === "todo" && i.to === "in_progress",
    guard: async (i, c) => {
      const bars = await c.unmetBars();
      if (!bars.length) return null;
      return `task ${i.id} is qualified but its publisher requested further confirmation before it goes ready — unmet bars: ${bars.join(", ")}. Satisfy them with a done child task of that role or an accepted decision.`;
    },
  },
  {
    name: "claim-separation-of-duties",
    when: (i) => isTask(i) && i.status === "todo" && i.to === "in_progress",
    guard: async (i, c) => {
      const q = await c.qualify("analysis");
      if (!q.ok || !q.via || q.via === "declared" || String(q.via).startsWith("parent:")) return null;
      const ev = await c.evidence(String(q.via));
      if (!ev || ev.type !== "task" || !(ev.roles ?? []).includes("analysis")) return null;
      const evSession = metaOf(ev.meta).session;
      const sess = await c.session();
      if (evSession && sess && evSession === sess)
        return `separation of duties: session "${sess}" completed the analysis on ${i.id} — analysis and impl are separate sessions. End this session, start a new one, then claim ${i.id} for implementation.`;
      return null;
    },
  },
  {
    name: "done-unreviewed",
    when: (i) =>
      isTask(i) &&
      i.to === "done" &&
      !["analysis", "review", "unblock"].includes(role(i)),
    guard: async (i, c) => {
      const r = await c.qualify("review");
      if (r.ok) return null;
      return `task ${i.id} cannot be completed unreviewed — complete a verify (review-role) child task or link an accepted decision (e.g. a Superpositional verdict) first`;
    },
  },
  {
    name: "question-not-claimable",
    when: (i) => i.type === "question" && i.to === "in_progress",
    guard: (i) =>
      `task ${i.id} is a question — questions are answered, not claimed. Contribute via log_progress {id, did, will}; the author closes it with an ADR (decision artefact, derived_from this task).`,
  },
  {
    name: "operator-gated",
    when: (i) => isTask(i) && i.to === "in_progress" && i.meta?.operator_gated,
    guard: (i) =>
      `task ${i.id} is operator-gated (${i.meta.operator_gated}) — a human clears this by updating the task (remove operator_gated from meta) before it can be claimed.`,
  },
  {
    name: "unblock-needs-resolution",
    when: (i) => i.status === "blocked" && i.to === "in_progress",
    guard: (i) =>
      noteOf(i)
        ? null
        : `moving out of blocked requires a resolution (note) — the card promised an unblock condition; cite how it resolved`,
  },
  {
    name: "review-needs-pr",
    when: (i) => isTask(i) && i.to === "in_review",
    guard: (i) =>
      hasEvidenceLink(noteOf(i))
        ? null
        : `moving to in_review requires the PR link in the note (you stay owner until the verdict — done requires review acceptance, not your call)`,
  },
  {
    name: "bounce-needs-findings",
    when: (i) => i.status === "in_review" && i.to === "in_progress",
    guard: (i) =>
      noteOf(i)
        ? null
        : `bouncing back from review requires the reviewer's findings (note) — "no" without reasons is not an answer`,
  },
  {
    // BR#3578: a blocked card must AWAIT something typed — a machine event,
    // an open ask, or a timer. Machine-managed parks (subprocess budgets,
    // merge-train leases) carry their own trip-wires. Free text alone is
    // optional annotation, never the exit condition.
    name: "blocked-needs-typed-await",
    when: (i) => i.to === "blocked",
    guard: (i) => {
      const reason = String(i.body?.note ?? i.body?.reason ?? "").trim();
      if (!reason) return "moving to blocked requires a reason (note)";
      if (i.body?.awaiting_ask_id) return null; // bound open ask — the active human leg
      if (i.body?.merge_train || i.body?.class === "subprocess") return null; // machine-managed park, own trip-wires
      const selfMsg = `self-referential await — ${i.id} cannot await its own done: a br_done event naming the parked card can never fire while the card is blocked (the BR#136 deadlock, BR#3986). A br_pr_merged naming the card is legal — the train stamps its provenance row while the card is blocked (BR#3620). Await the real upstream leg.`;
      if (i.body?.await_event !== undefined) {
        const ev = validateAwaitEvent(i.body.await_event);
        if (!ev) return `malformed await_event — the grammar is a closed set: ${AWAIT_GRAMMAR_DOC}`;
        if (isSelfAwait(String(i.id), ev)) return selfMsg;
        return null;
      }
      // compat shim: legacy text conditions that parse cleanly to ONE atom
      // are derived typed events at write time; unparseable/no-atom text is
      // exactly the "blocked forever" class the law kills.
      const text = String(i.body?.unblock_condition ?? "").trim();
      if (text) {
        const { atoms, unparseable } = parseProxyCondition(text);
        if (!unparseable && atoms.length > 1) {
          // BR#3986: the extractors now collect EVERY match, so a conjunction
          // parses to N atoms — but a park awaits ONE typed event. Reject
          // loud naming the atoms instead of letting the sweep gate on the
          // first one while the rest vanish from the machine gate.
          // BR#4303: name each atom in SHORT form. `raw` is the whole
          // 200-char line slice, so raw-based formatting spent the do.ts
          // 300-char audit budget on atom 1's line alone — the audit trail
          // (and the breach fold that samples it) could never show the leg
          // to drop, and the rejected author blind-retries the same park
          // (the BR#4301 verifier loop).
          const shortAtom = (a: (typeof atoms)[number]) => {
            const ev = awaitEventFromAtoms([a]);
            return ev ? describeAwaitEvent(ev) : a.raw.slice(0, 80);
          };
          return `condition text parses to ${atoms.length} machine atoms (${atoms.map(shortAtom).join(" | ")}). A park awaits ONE typed event — ${AWAIT_GRAMMAR_DOC}. Name a single machine leg in await_event, or carry the rest as prose: multi-atom conjunctions never self-migrate (BR#3986).`;
        }
        if (!unparseable && atoms.length === 1) {
          const single = awaitEventFromAtoms(atoms);
          if (single && isSelfAwait(String(i.id), single)) return selfMsg;
          if (single) return null;
        }
      }
      return `moving to blocked requires a typed await_event — ${AWAIT_GRAMMAR_DOC}. Pass it as the transition's await_event param (bridge_transition takes it directly; until_ts is epoch ms), or cite it in prose as "typed await_event <event> key=value" (BR#4062), or bind an ask via ask_agent — the human leg. Free text alone is annotation, never an exit condition (BR#3578)`;
    },
  },
  {
    name: "verdict-done-needs-receipts",
    when: (i) => isTask(i) && i.to === "done" && (role(i) === "review" || role(i) === "unblock"),
    guard: (i) =>
      hasReceipts(noteOf(i))
        ? null
        : `${role(i) === "unblock" ? "unblock" : "review"} ${i.id} cannot complete without receipts — the note must cite receipts: ${RECEIPTS_DOC}.`,
  },
  {
    name: "review-separation-of-duties",
    when: (i) => isTask(i) && i.to === "done" && (role(i) === "review" || role(i) === "unblock"),
    guard: async (i, c) => {
      const parent = await c.parent();
      const implSession = parent ? metaOf(parent.meta).session : undefined;
      const reviewSession = metaOf(i.meta).session;
      if (implSession && reviewSession && implSession === reviewSession)
        return `separation of duties: session "${reviewSession}" implemented ${parent?.id} — it cannot also produce the review. Review from a different session.`;
      return null;
    },
  },
  {
    // BR#3819 (B+C): a gate must never read state that cannot exist. A
    // self-edge (child_of src == dst) counted the parent as its own open
    // child forever — every →done rejected "still has 1 open child" with no
    // agent-repairable exit (BR#3423 specimen). Two layers here:
    //   (B) openChildren() excludes self-edges — the impossible state is
    //       invisible to the gate (defense-in-depth; the write path now
    //       rejects self-edges and the migration deleted the existing ones).
    //   (C) the explicit force-close-with-reason: the agent-executable exit
    //       for relation-gated cards. It must name EVERY open child and say
    //       why — do.ts stamps + audits each forced close (loud, never
    //       silent). A partial list is refused.
    name: "done-open-children",
    when: (i) => isTask(i) && i.to === "done",
    guard: async (i, c) => {
      const open = await c.openChildren();
      if (open <= 0) return null;
      const fc = parseForceClose(noteOf(i));
      if (fc) {
        const openIds = (await c.openChildIds()).map((x) => String(x).toUpperCase());
        const missing = openIds.filter((x) => !fc.ids.map((y) => y.toUpperCase()).includes(x));
        if (missing.length)
          return `force-close must name EVERY open child task — missing: ${missing.join(", ")}. ${FORCE_CLOSE_DOC}`;
        return null; // deliberate, complete, reasoned — do.ts logs the repair
      }
      return `parent ${i.id} still has ${open} open child task(s) — finish or close them first (decomposition owns its children). If a child is genuinely unclosable, ${FORCE_CLOSE_DOC}`;
    },
  },
  {
    // BR#3361 (b)+(c): terminal close-leg ownership + the closure receipt.
    // A done card whose Done-when (or done note) ends in "close GH #N" must
    // either carry the receipt for every leg it claims, or own the leg with
    // a CLOSED close-duty child. Retrying the done auto-derives the child
    // (do.ts executes that on this rejection) — no orphan terminal legs.
    name: "done-close-legs",
    when: (i) => isTask(i) && i.to === "done",
    guard: async (i, c) => {
      const note = noteOf(i);
      const legs = parseCloseLegs(`${doneWhenSection(await c.cardBody())}\n${note}`);
      if (!legs.length) return null;
      const unowned: CloseLeg[] = [];
      for (const leg of legs) {
        if (parseClosureReceipt(note, leg)?.closed) continue;
        if (await c.closeLegChildClosed(leg)) continue;
        unowned.push(leg);
      }
      if (!unowned.length) return null;
      const labeled = unowned.map((l) => `${l.repo ? `${l.repo}#` : "#"}${l.number}`).join(", ");
      return `terminal close leg(s) not receipted: ${labeled} — a done card claiming a GH close must carry the closure receipt (${RECEIPT_CONTRACT}) in the done note, or own the leg with a closed close-duty child. Retrying this done auto-derives the close-duty child (BR#3361).`;
    },
  },
];

/** Total executor (BR#2419): base lifecycle + every role/intent rule, first
 *  failing rule wins, then effects are decided. Never throws. do.ts
 *  persists Applied and executes its effects; Rejection is surfaced as-is. */
export async function decide(i: RuleInput, c: RuleCtx): Promise<Verdict> {
  // ---- the law: edge shape first, then the table, first fail wins ----
  const base = validateTransition(i.type as any, i.status, i.to);
  if (base.ok === false) return { ok: false, code: "illegal-edge", rule: "lifecycle", message: base.reason };
  // BR#4067 — queue-slot durability: a MACHINE silence-release (watchdog /
  // system sweeps) must never destroy merge-train state or a typed wait. A
  // card the train owns (meta.merge_train queued/awaiting-ci/bounced with a
  // live PR leg) is parked on the typed pr_merged proxy; a card with a typed
  // await_event or a bound ask parks on that wait — the proxy watch / the
  // answer owns the exit, not the staleness sweep. Humans and owners still
  // release freely (rule-9 / web). The sweeps hold BEFORE attempting a todo
  // release (they park blocked); this backstop catches any machine-actor
  // path that slips past them. A human_verdict body flag (the answered-ask
  // dispatch — the human's typed/clicked RELEASE riding a system actor as
  // its pen) is exempt: the human decided, the machine only typed.
  if (i.type === "task" && i.to === "todo" && (i.status === "blocked" || i.status === "in_progress") && /^(system:|hub:|watchdog)/i.test(String(i.actor ?? "")) && !i.body?.human_verdict) {
    const m = metaOf(i.meta);
    const mtq = ((m.merge_train ?? {}) as Record<string, unknown>);
    const st = String(mtq.state ?? "");
    const pr = trainPrLeg(m);
    // BR#4494 carve-out: the stall sweep's bounce re-entry demote. Bounced is
    // the ONE train state whose next leg the train does NOT own — it handed
    // the leg back to the board (re-entry is a fresh verify/impl round), so
    // the demote to a claimable todo destroys no queue slot; the train meta
    // rides along and the fresh accept re-queues. Keyed on the explicit body
    // flag the sweep sets + in_progress (a live re-entry, never a park) +
    // state bounced — queued/awaiting-ci stay protected even with a forged
    // flag, and so does a bounced card parked BLOCKED.
    const demoteReentry =
      st === "bounced" && i.status === "in_progress" && i.body?.demote_bounced_reentry === true;
    if ((st === "queued" || st === "awaiting-ci" || st === "bounced") && pr && !demoteReentry) {
      const repo = String((m.pr as any)?.repo ?? mtq.repo ?? "repo");
      return {
        ok: false,
        code: "guard-failed",
        rule: "release-holds-train-queue",
        message: `card is merge-train ${st} (typed await pr_merged ${repo}#${pr}) — the train owns delivery; a machine silence-release must not destroy the queue slot. Wait out the proxy (pr_merged flip closes it) or re-queue explicitly; do not release to the pool.`,
      };
    }
    const hold = releaseHold(m);
    if (hold && !demoteReentry) {
      const aw = m.blocked?.await_event
        ? `typed await_event (${String((m.blocked.await_event as any).event ?? "unknown")})`
        : `bound ask (${String(m.awaiting_ask?.ask_id ?? "")})`;
      return {
        ok: false,
        code: "guard-failed",
        rule: "release-holds-typed-await",
        message: `card parks on a ${aw} — the proxy watch / the answer owns the exit; a machine release must not destroy the wait (BR#4067). Wait it out or let a human/owner release.`,
      };
    }
  }
  for (const r of RULES) {
    if (!r.when(i)) continue;
    const err = await r.guard(i, c);
    if (err) return { ok: false, code: "guard-failed", rule: r.name, message: err };
  }
  if (i.type !== "task") {
    // decisions: the auto-spawned consensus round (BR#903) is ephemeral the
    // same way verify/unblock rounds are — when the decision resolves
    // (accepted, or superseded: the human decided), the round closes. The
    // tally + reasons stay in the round's history; the decision's acceptance
    // is never gated by the round.
    const fx: Effect[] =
      i.type === "decision" && (i.to === "accepted" || i.to === "superseded")
        ? [{ kind: "supersede_children", parent: i.id, tag: "question", keep_newest: false, cause: `${i.id} ${i.to} — consensus round closed (the human decided; the round informed, it never gated)` }]
        : [];
    return { ok: true, status: i.to, owner_clear: false, tags_add: [], meta_patch: {}, effects: fx };
  }

  // ---- effects: every spawn/escalate/stamp/supersede decision lives here ----
  const now = i.now ?? Date.now();
  const meta = metaOf(i.meta);
  const r = role(i);
  const patch: Record<string, unknown | undefined> = {};
  const tagsAdd: string[] = [];
  const effects: Effect[] = [];
  let status = i.to;
  let ownerClear = false;

  // release to the pool: attempt stamp, churn escalate/redirect — decided, not improvised
  if (i.to === "todo") {
    // PROVEN-UNBLOCK RELEASE: an unblock duty releasing a parked card with
    // proof is a FRESH START, not a churn attempt — the attempts counter
    // resets so the release never trips escalate/redirect (the card is
    // unblocking, not failing).
    const provenUnblock = i.status === "blocked" && r === "unblock" && !!noteOf(i);
    const nextAttempts = provenUnblock ? 0 : ((meta.attempt?.attempts as number) ?? 0) + 1;
    const silent = silentCycles(await c.recentEvents());
    const verdictDuty = r === "review" || r === "unblock";
    const lastReason = String(i.body?.note ?? "").trim() || meta.attempt?.last_reason;
    const attempt = provenUnblock
      ? undefined
      : { by: i.actor, at: now, attempts: nextAttempts, last_reason: lastReason, last_will: meta.last_progress?.will };
    if (verdictDuty && (nextAttempts >= CHURN_ESCALATE_ATTEMPTS || silent >= SILENT_ESCALATE_CYCLES)) {
      // verdict duties may not block (the table refuses it) — repeated gate
      // rejections or silent churn escalate to a human instead
      const reason =
        silent >= SILENT_ESCALATE_CYCLES && nextAttempts < CHURN_ESCALATE_ATTEMPTS
          ? `verdict duty went silent ${silent} watchdog cycles with no agent output — server-side churn escalation (last: ${String(lastReason ?? "").slice(0, 200)}). Human: review get_history, fix the recurring failure, or re-scope`
          : `verdict duty released ${nextAttempts} times without completing — the same gate keeps rejecting the handoff (last: ${String(lastReason ?? "").slice(0, 200)}). Human: review get_history, fix the recurring failure, or re-scope`;
      patch.escalate = { at: now, attempts: nextAttempts, silent_cycles: silent, reason };
      patch.attempt = attempt;
      ownerClear = true;
      effects.push({ kind: "escalate", attempts: nextAttempts, silent_cycles: silent, reason });
    } else if (!verdictDuty && i.status !== "blocked" && (nextAttempts >= CHURN_REDIRECT_ATTEMPTS || silent >= SILENT_REDIRECT_CYCLES)) {
      // churn guard: the pool has re-run this task N times (or N silent
      // cycles) and a gate keeps rejecting the completion. Re-releasing loops
      // claim → dispatch → reject forever — redirect the release into an
      // honest block: reason and exit are on the card.
      const blockReason =
        silent >= SILENT_REDIRECT_CYCLES && nextAttempts < CHURN_REDIRECT_ATTEMPTS
          ? `churn guard: ${silent} consecutive zero-output watchdog cycles — silent churn, server-side escalated`
          : `churn guard: released to the pool ${nextAttempts} times without completing — the same gate keeps rejecting the handoff (last: ${String(lastReason ?? "").slice(0, 200)})`;
      status = "blocked";
      patch.blocked = {
        reason: blockReason,
        // BR#4248: the park awaits a typed cooldown timer — grammar-valid,
        // machine-readable, sweep-consumed. The prose unblock condition is
        // annotation for the human who eventually reads the card; it is NOT
        // the exit condition (BR#3578). The server must not mint the very
        // "awaits nothing" parks that law kills — the invariant at the end
        // of decide() refuses a redirect that lands without the typed atom.
        unblock_condition: "read the task history (get_history) and the last gate error, resolve what it names, then re-claim or re-issue the task",
        await_event: { event: "time", until_ts: now + CHURN_COOLDOWN_MS },
        ts: now,
      };
      patch.attempt = attempt;
      effects.push({ kind: "release_redirect", attempts: nextAttempts, silent_cycles: silent });
    } else {
      ownerClear = true;
      if (!provenUnblock) {
        patch.attempt = {
          by: i.actor,
          at: now,
          attempts: nextAttempts,
          last_reason: meta.blocked?.reason ?? (String(i.body?.note ?? "").trim() || undefined),
          last_will: meta.last_progress?.will,
        };
        if (!i.tags.includes("attempted")) tagsAdd.push("attempted");
      } else {
        patch.attempt = undefined; // proven-unblock: fresh start, no attempt stamp
      }
    }
  }

  // completion resets the churn counter (BR#2503 residual: the lifetime
  // counter tripped churn on the FIRST release of an old, completed task).
  // Shape kept for display: the last attempt is still visible, count zeroed.
  if ((i.to === "done" || i.to === "superseded") && meta.attempt && typeof meta.attempt === "object")
    patch.attempt = { ...meta.attempt, attempts: 0 };

  // entering review: the verification duty. Recursion-guarded; reuse over spawn.
  if (i.to === "in_review" && r !== "review") {
    const guard = await c.spawnGuard();
    if (guard) {
      effects.push({ kind: "skip_verify_spawn", parent: i.id, reason: guard });
    } else {
      const open = await c.openVerifyChild();
      if (open) effects.push({ kind: "reuse_verify", parent: i.id, verify: open.id });
      else
        effects.push({
          kind: "spawn_verify",
          parent: i.id,
          pr: prFromNote(String(i.body?.note ?? "")),
        });
    }
  }

  // supersede cascades: children are ephemeral — when the parent moves on,
  // their round closes (review rounds keep their newest child alive across a
  // bounce so the same round re-enters). superseded counts: a dropped parent's
  // rounds are dead by definition (BR#3913 — the SUPERSEDE answer dispatch
  // lands here; done/verify rounds of a dropped card must not linger open).
  if (["in_progress", "todo", "done", "superseded"].includes(i.to)) {
    const cause =
      i.to === "in_progress" && i.status === "blocked"
        ? `${i.id} resumed from blocked — unblock confirmed, child superseded`
        : i.to === "in_progress" && i.status === "in_review"
          ? `${i.id} bounced — unblock round closed`
          : `${i.id} → ${i.to} — unblock round closed`;
    effects.push({ kind: "supersede_children", parent: i.id, tag: "unblock", keep_newest: false, cause });
    // BR#4282: a resume CONSUMES the round — the exit condition was verified
    // and the card moved. Clear the stamp so a post-resume silence issues a
    // FRESH round (the owned done-close) instead of flooding against a stamp
    // whose round no longer exists. Dedup keeps suppressing duplicates of an
    // UNCONSUMED round; a consumed one is not a duplicate.
    if (i.to === "in_progress" && i.status === "blocked") patch.last_unblock_spawn = undefined;
  }
  if (i.to === "done" || i.to === "superseded" || (i.status === "in_review" && i.to === "in_progress")) {
    const isBounce = i.status === "in_review" && i.to === "in_progress";
    effects.push({
      kind: "supersede_children",
      parent: i.id,
      tag: "review",
      keep_newest: isBounce,
      cause: isBounce
        ? `${i.id} bounced — older verification rounds superseded (newest kept for re-entry)`
        : i.to === "superseded"
          ? `${i.id} superseded — verification round closed`
          : `${i.id} done — verification round closed`,
    });
  }

  // entering blocked: at most ONE live unblock child per parent, ever. Ask
  // gates auto-resume (a spawned child would race the answer); subprocess
  // declarations are silence-on-a-working-task, not a block; unblock duties
  // don't spawn their own kind. Merge-train parks (BR#3516 §2) are
  // machine-managed: the train itself is the unblock path, and a spawned
  // child would race the executor's CAS lease. The train's OWN transitions
  // mark the park with body.merge_train; agent re-parks follow the
  // verify-duty contract instead, which marks it in the NOTE ("merge-train:
  // queued — …" — the canonical prefix the verify template in do.ts
  // instructs). Missing the agent flavor made every re-queue spawn an
  // unblock child that the next bounce superseded (keep_newest: false) and
  // the re-park after it flood-guarded on the stale stamp — spawn →
  // supersede → flood-skip → threshold-1 breach card, one loop per train
  // bounce (specimen BR#3990 rounds 4→6, breach BR#4135). Scope: the SPAWN
  // gate only — the typed-await exemption (blocked-needs-typed-await) stays
  // keyed on body.merge_train so prose cannot dodge the grammar by
  // prefixing a note (BR#3578 fail-closed).
  const mergeTrainPark =
    Boolean(i.body?.merge_train) || /^merge-train:/i.test(String(i.body?.note ?? "").trimStart());
  if (
    i.to === "blocked" &&
    r !== "unblock" &&
    !meta.awaiting_ask &&
    !i.body?.awaiting_ask_id &&
    i.body?.class !== "subprocess" &&
    !mergeTrainPark
  ) {
    const open = await c.openUnblockChild();
    if (open) {
      effects.push({ kind: "skip_unblock_spawn", parent: i.id, reason: `existing unblock child ${open.id} reused` });
    } else {
      const exit = String(i.body?.unblock_condition ?? "").trim();
      const last = meta.last_unblock_spawn;
      if (last && typeof last.at === "number" && now - last.at < UNBLOCK_FLOOD_MS && String(last.exit ?? "") === exit) {
        effects.push({
          kind: "skip_unblock_spawn",
          parent: i.id,
          reason: `unblock round issued ${Math.round((now - last.at) / 60_000)}m ago with the same exit condition — flood guard`,
          // BR#4282: a flood skip is the dedup WORKING (the round for this
          // exact exit is already on the case), not a double-spawn attempt —
          // the executor audits it observably and never folds a breach card.
          flood: true,
        });
      } else {
        effects.push({
          kind: "spawn_unblock",
          parent: i.id,
          reason: String(i.body?.note ?? i.body?.reason ?? "").trim(),
          exit_condition: exit,
        });
      }
    }
  }

  // BR#4248 — structural invariant, not a point-fix: ANY internal patch that
  // lands status = blocked (entered the pipeline as ≠ blocked) must carry a
  // grammar-valid typed await. The churn redirect enters as → todo, so the
  // door gate (blocked-needs-typed-await) never evaluates it — that bypass is
  // how prose-only parks (the BR#4235 "awaits nothing" ask factory) were
  // minted. Actor transitions to blocked are already gated at the door; this
  // post-condition closes the internal path, for every flip site, forever.
  // A rejection here means a generator regressed to prose-only parks.
  if (i.to !== "blocked" && status === "blocked" && !validateAwaitEvent((patch.blocked as any)?.await_event))
    return {
      ok: false,
      code: "guard-failed",
      rule: "blocked-await-invariant",
      message: `internal redirect to blocked without a grammar-valid await_event — prose-only parks are structurally impossible (BR#3578/BR#4248): stamp a typed await (${AWAIT_GRAMMAR_DOC})`,
    };

  return { ok: true, status, owner_clear: ownerClear, tags_add: tagsAdd, meta_patch: patch, effects };
}

/** Compatibility shim over decide(): the rejection message or null. (The
 *  matrix suite asserts on messages; do.ts consumes the typed Verdict.) */
export async function check(i: RuleInput, c: RuleCtx): Promise<string | null> {
  const v = await decide(i, c);
  if (v.ok === false) return v.message;
  return null;
}

// ---------- invariants: post-conditions on the single write path ----------

/** Structural facts that must hold for any stored artefact. Violations are
 *  breaches (loud trail + quarantine), never silently repaired. */
export function invariants(a: { type: string; status: string; roles?: string[]; tags?: string[]; meta: any }): string[] {
  const v: string[] = [];
  const r = effectiveRole(a.roles ?? []);
  if (a.type === "task") {
    if (VERDICT_ROLES.includes(r) && a.status === "blocked")
      v.push(`verdict role ${r} is blocked — verdict duties are done-only terminals`);
    if (VERDICT_ROLES.includes(r) && a.status === "in_review")
      v.push(`verdict role ${r} is in_review — verdict duties are never reviewed`);
    if (!a.meta?.blocked && a.status === "blocked")
      v.push("status is blocked with no meta.blocked record (reason + unblock condition missing)");
    if (a.meta?.blocked && a.status !== "blocked")
      v.push("meta.blocked record on a non-blocked task (stale dead-end record)");
  }
  if (a.type === "question" && a.status === "in_progress")
    v.push("question is in_progress — questions are answered, not claimed");
  return v;
}

// ---------- silent-churn fold: zero-output watchdog cycles from the version log ----------

export interface CycleEvent {
  ts: number;
  actor: string;
  action: string;
  summary: string;
}

const isAgentOutput = (e: CycleEvent) => !/^system:/.test(e.actor);
const isWatchdogStall = (e: CycleEvent) => /^system:/.test(e.actor) && /stall|releas|redirect/i.test(e.summary);

/** Count consecutive zero-output watchdog stall cycles (server-side, from
 *  the version log — no runner counter, no cross-host signature). A stall
 *  with interleaved agent output resets the run. */
export function silentCycles(events: CycleEvent[]): number {
  const asc = [...events].sort((a, b) => a.ts - b.ts);
  let run = 0;
  for (const e of asc) {
    if (isAgentOutput(e)) run = 0;
    else if (isWatchdogStall(e)) run++;
  }
  return run;
}

// ---------- replay consistency: fold the version log, compare to stored state ----------

export interface ReplayEvent {
  action: string;
  data: any;
}

/** Fold transition events forward from the log. The fold RE-ANCHORS at every
 *  chain gap (a row whose `from` doesn't match the folded state — a silent
 *  status write, a stale/duplicate stamp, out-of-order history): the log's
 *  own chain continues from the row's `to`, so one historical gap cannot
 *  poison every future fold (BR#3322: the early-return contract made the
 *  BR#903 pre-gate rows re-fire the replay breach on every transition,
 *  forever). The gap count is the integrity signal; the replay LAW —
 *  fold(events) == stored_state (BR#2419 item 6) — is enforced by the
 *  caller comparing `status` with the stored status.
 *  - `ok`: the log chained without any gap.
 *  - `breaks`: how many gaps were re-anchored across.
 *  - `tailBreak`: the LAST transition row is itself a gap — fresh damage,
 *    worth an audit line the moment it lands. */
export function replayStatus(from: string, versions: ReplayEvent[]): { status: string; ok: boolean; breaks: number; tailBreak: boolean } {
  let expected = from;
  let anchored = false;
  let breaks = 0;
  let tailBreak = false;
  for (const v of versions) {
    if (v.action !== "transition") continue;
    const to = v.data?.to;
    if (typeof to !== "string") continue;
    if (anchored && v.data?.from !== expected) {
      breaks++;
      tailBreak = true; // provisional — a later row that chains clears it
    } else {
      tailBreak = false;
    }
    expected = to; // re-anchor: the log's own chain continues from here
    anchored = true;
  }
  return { status: expected, ok: breaks === 0, breaks, tailBreak };
}

// ---------- breach detection: fold over the audit stream, deduped ----------

export interface BreachEvent {
  ts: number;
  task: string;
  op: string; // transition_rejected | invariant_violation | spawn_skipped | replay_mismatch
  reason: string;
}

export interface Breach {
  key: string; // (task, class) — one OPEN breach per key, reoccurrences coalesce
  task: string;
  klass: string;
  count: number;
  first_ts: number;
  last_ts: number;
  sample: string;
}

export const BREACH_WINDOW_MS = 30 * 60_000;
export const BREACH_THRESHOLD = 3;

/** Per-class thresholds: storms (same-gate rejections) need repetition;
 *  the other classes are breaches on the FIRST event — a double-spawn
 *  attempt, an invariant violation, or a replay mismatch is never noise.
 *  BR#3337: claim races (lifecycle-edge rejections) are retryable by
 *  definition — they must never raise a breach card, no matter how many
 *  pile up in a dispatch storm. */
export const BREACH_THRESHOLDS: Record<string, number> = {
  invariant: 1,
  replay: 1,
  "spawn-while-open": 1,
  claim_race: Number.POSITIVE_INFINITY,
  default: BREACH_THRESHOLD,
};

/** Classify an audit event into a stable breach class. Known gates get named
 *  classes; unknown reasons fall into `unclassified` — an HONEST catch-all
 *  (Ray, 2026-10-27: "we shouldn't have 'other' — be clearer about the
 *  categories"): it reads as what it is, a classifier GAP, not a mystery
 *  defect. The fold's card states the action for it (add a pattern or fix
 *  the flow), so an unclassified pile points at breachClass itself. */
/** BR#4295: rule name → breach class for rejections that carry the audited
 *  " [rule: <name>]" tag (do.ts appends it to every guard rejection; it
 *  survives the 300-char audit slice for short messages). Only the gates
 *  whose message-ladder classification was wrong or unreachable need an
 *  entry — everything else keeps classifying through the stems below. */
const RULE_BREACH_CLASSES: Record<string, string> = {
  // the receipts gate's own message embeds "PR link", so the ladder's
  // earlier "pr link" test folded EVERY verdict-done-needs-receipts
  // rejection as gate:review-needs-pr — the dedicated class was unreachable
  // for its own gate (specimens BR#3735, BR#4291/BR#4294).
  "verdict-done-needs-receipts": "gate:verdict-receipts",
  "review-needs-pr": "gate:review-needs-pr",
  // accepted classification ruling BR#3430: ownership-gate rejections are
  // the claim_race family — observable, never a breach.
  "release-needs-ownership": "claim_race",
};

export function breachClass(reason: string): string {
  const r = reason.toLowerCase();
  // BR#4295: the audited rule tag classifies FIRST. Anchored at the end —
  // a tag cut mid-way by the 300-char slice fails this match and falls
  // through to the message ladder, exactly like a suffix-less legacy reason.
  const ruleTag = r.match(/\[rule: ([a-z0-9-]+)\]$/);
  if (ruleTag && RULE_BREACH_CLASSES[ruleTag[1]]) return RULE_BREACH_CLASSES[ruleTag[1]];
  // BR#3337: lifecycle-edge rejections are claim races — two dispatchers
  // raced for one card and the lifecycle table refused the double-claim
  // (`task: 'in_progress' → 'in_progress' not allowed (allowed: …)` /
  // `status 'x' is terminal for task`). Benign and self-healing: the loser
  // skips and the winner proceeds. Observable as claim_race, never a breach.
  if (r.includes("not allowed (allowed:") || r.includes("is terminal for")) return "claim_race";
  // BR#3429: ownership-gate rejections are claim races too — a non-owner
  // (dispatched session vs runner-held claim) tried to release a claimed
  // card. The gate refuses, the loser skips, the owner/human decides.
  // Symmetric with the runner (dispatch.rs is_claim_race_error). Specimen: BR#3427.
  // BR#3611: match the STRUCTURAL pair, not a sentence literal — the runner
  // already does (`is_claim_race_error`: "claimed by" + "only the owner").
  // PR #210 (8a1acbd) edited the guard's wording ("a human" → "a human, or
  // an unblock duty holding proof of the met exit condition") and the old
  // literal stopped matching, silently re-arming breach cards on the
  // ownership key (specimen BR#3610). Both wordings contain
  // `is claimed by <owner> — only the owner`; future wording edits stop
  // re-breaking this classifier.
  if (r.includes("claimed by") && r.includes("only the owner")) return "claim_race";
  if (r.includes("pr link")) return "gate:review-needs-pr";
  if (r.includes("unreviewed")) return "gate:done-unreviewed";
  if (r.includes("references no git repository")) return "gate:no-repo";
  if (r.includes("without receipts")) return "gate:verdict-receipts";
  if (r.includes("separation of duties")) return "gate:separation";
  if (r.includes("open child")) return "gate:open-children";
  if (r.includes("cannot block")) return "gate:verdict-no-blocked";
  if (r.includes("never reviewed")) return "gate:verdict-no-in_review";
  // BR#3738: the BR#3578 fail-closed typed-await park gates. Both rejections
  // come from one rule (blocked-needs-typed-await), but the causes differ: a
  // park with no grammar-valid await_event at all vs a park whose await_event
  // fails the closed grammar (specimen BR#3731 event 1, 2026-10-26: a
  // run_success await with run_id as a NUMBER — validateAwaitEvent refuses,
  // the corrected string retry 32s later succeeded, proving the gate not the
  // park was rejected). The audited reason is the thrown message sliced to
  // 300 chars (do.ts) and both messages embed AWAIT_GRAMMAR_DOC (~290 chars),
  // so the "[rule: …]" tag never survives the slice — these matches key on
  // the message stems, which live inside it. Structural fragments, not
  // sentence literals (BR#3612's wording-drift lesson).
  if (r.includes("malformed await_event")) return "gate:malformed-await-event";
  if (r.includes("requires a typed await_event")) return "gate:blocked-needs-typed-await";
  // BR#3986: the multi-atom + self-referential park rejections (same rule,
  // distinct causes — a conjunction the sweep could only partially gate vs a
  // park deadlocked on its own done).
  if (r.includes("self-referential await")) return "gate:self-referential-await";
  if (r.includes("machine atoms (")) return "gate:multi-atom-condition";
  // BR#4563: the BR#4067 release-hold backstop (decide()) refusing a MACHINE
  // silence/owner-death release — benign by design: the typed wait / the
  // train queue owns the exit, the sweep holds ("wait it out or let a
  // human/owner release"). Match the rule identifiers — code names, stable
  // under message wording drift (BR#3611/BR#3612 lesson), and present in the
  // audited reason whether or not the " [rule: …]" tag survived the 300-char
  // slice. Specimens: TASK-016 (typed pr_merged park, BR#4563),
  // BR#3727/BR#4068 (merge-train bounced, BR#4573/BR#4578).
  if (r.includes("release-holds-typed-await")) return "release:held-typed-await";
  if (r.includes("release-holds-train-queue")) return "release:held-train-queue";
  return "unclassified";
}

/** Per-event breach class: the four op shapes are their own classes; a
 *  transition_rejected is classified by its rejection reason (breachClass).
 *  Exported for the fold (BR#3443) — the caller needs the same per-key
 *  classification to advance open cards' high-water marks. */
export function classOf(e: BreachEvent): string {
  if (e.op === "invariant_violation") return "invariant";
  if (e.op === "spawn_skipped") return "spawn-while-open";
  if (e.op === "replay_mismatch") return "replay";
  return breachClass(e.reason);
}

/** Fold events into breaches: same (task, class) within the window is ONE
 *  breach once its threshold is crossed, and never re-raised while its key
 *  is open. Raising is the caller's guarded effect. BR#3443: the caller can
 *  also pass a per-key fold high-water — events at or below it were already
 *  folded into a prior breach card (open coalescing + closed adjudication),
 *  so a closed card's close never re-arms its key. */
export function detectBreaches(
  events: BreachEvent[],
  openKeys: Set<string>,
  opts?: { windowMs?: number; highWater?: Map<string, number> },
): Breach[] {
  const windowMs = opts?.windowMs ?? BREACH_WINDOW_MS;
  const highWater = opts?.highWater;
  const relevant = events.filter((e) =>
    ["transition_rejected", "invariant_violation", "spawn_skipped", "replay_mismatch"].includes(e.op),
  );
  relevant.sort((a, b) => a.ts - b.ts);
  const groups = new Map<string, Breach>();
  for (const e of relevant) {
    const klass = classOf(e);
    const key = `${e.task}|${klass}`;
    // BR#3443: events at or below the key's high-water were already folded
    // into a prior breach card — they never re-qualify on a later trigger.
    const hw = highWater?.get(key);
    if (hw !== undefined && e.ts <= hw) continue;
    const g = groups.get(key);
    if (g) {
      if (e.ts - g.first_ts <= windowMs) {
        g.count++;
        g.last_ts = e.ts;
      }
    } else {
      groups.set(key, { key, task: e.task, klass, count: 1, first_ts: e.ts, last_ts: e.ts, sample: e.reason.slice(0, 200) });
    }
  }
  return [...groups.values()].filter((b) => b.count >= (BREACH_THRESHOLDS[b.klass] ?? BREACH_THRESHOLDS.default) && !openKeys.has(b.key));
}
