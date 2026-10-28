/**
 * KB core — pure logic, no I/O. Unit-tested in test/kb-core.test.ts.
 *
 * Artefact types, their lifecycles, the typed-relationship vocabulary, and the
 * validation rules. The DO (kb/do.ts) and the MCP tool schemas (mcp.ts) both
 * defer to this module — one source of truth for what transitions and links
 * are legal.
 */

export const ARTEFACT_TYPES = [
  "steering",
  "goal",
  "decision",
  "task",
  "question",
  "progress",
  "agent",
] as const;
export type ArtefactType = (typeof ARTEFACT_TYPES)[number];

export function isArtefactType(t: unknown): t is ArtefactType {
  return typeof t === "string" && (ARTEFACT_TYPES as readonly string[]).includes(t);
}

/** Task kinds — one task type, distinguished by TYPE + ROLES (phase-3
 *  classification: type and roles are structural, tags are inert user
 *  labels — a tag can never change system behaviour). meta.kind is legacy
 *  read-only, normalized at create. */
export const TASK_KINDS = ["impl", "analysis", "review", "research", "question"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** meta.kind normalization at create: where each legacy kind lands now. */
export const KIND_TYPE: Partial<Record<TaskKind, ArtefactType>> = { question: "question" };
export const KIND_ROLE: Partial<Record<TaskKind, string>> = { analysis: "analysis", review: "review" };
export const KIND_TAG: Partial<Record<TaskKind, string>> = { research: "research" };

/** The role lanes the machine enforces (dispatch, gating, verdict duties).
 *  Roles live in the `roles` column — NEVER in tags (user-definable, inert). */
export const ROLE_NAMES = ["impl", "analysis", "review", "unblock", "human"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

/** Parse+validate role input (["review"], ["role:review"] tolerated).
 *  Strict on unknown names: a typo'd role silently vanishing would strip a
 *  task's gating — fail loud instead. */
export function parseRolesInput(raw: unknown): { ok: true; roles: RoleName[] } | { ok: false; error: string } {
  if (raw == null) return { ok: true, roles: [] };
  const arr = typeof raw === "string" ? raw.split(",") : raw;
  if (!Array.isArray(arr)) return { ok: false, error: "roles must be an array of role names" };
  const out: RoleName[] = [];
  for (const v of arr) {
    const name = String(v ?? "").trim().toLowerCase().replace(/^role:/, "");
    if (!name) continue;
    if (!(ROLE_NAMES as readonly string[]).includes(name))
      return { ok: false, error: `unknown role '${name}' (valid: ${ROLE_NAMES.join(", ")})` };
    if (!out.includes(name as RoleName)) out.push(name as RoleName);
  }
  return { ok: true, roles: out.slice(0, 5) };
}

/** The roles_v1 per-row transform, pure so it is unit-testable against every
 *  legacy encoding parseTags() can produce. Moves system meaning OUT of tags:
 *  role:* → roles (bare), "question" tag → type question, "attempted" tag →
 *  meta.attempt (backfilled when absent). User tags pass through untouched. */
export function splitSystemTags(
  rowType: string,
  rawTags: string[],
  meta: any,
  now: number,
): { type: string; tags: string[]; roles: string[]; meta: any; changed: boolean } {
  const tags = [...rawTags];
  const roles = [...new Set(tags.filter((t) => t.startsWith("role:")).map((t) => t.slice(5)))];
  const wasQuestion = tags.includes("question");
  const wasAttempted = tags.includes("attempted");
  const rest = tags.filter((t) => !t.startsWith("role:") && t !== "question" && t !== "attempted");
  const m = meta && typeof meta === "object" ? { ...meta } : {};
  let type = rowType;
  if (rowType === "task" && wasQuestion) type = "question";
  if (wasAttempted && !m.attempt) m.attempt = { by: "system:migration", at: now, attempts: 1 };
  const changed = roles.length > 0 || rest.length !== tags.length || type !== rowType || (wasAttempted && !(meta && typeof meta === "object" && meta.attempt));
  return { type, tags: rest, roles, meta: m, changed };
}

/** A task's kind, defaulting to impl. LEGACY: reads meta.kind, which create()
 *  normalizes away — the authority is type ("question") + roles column. Kept
 *  for pre-migration rows and tests. */
export function taskKind(meta: any): TaskKind {
  const k = typeof meta?.kind === "string" ? meta.kind : undefined;
  return (TASK_KINDS as readonly string[]).includes(k ?? "") ? (k as TaskKind) : "impl";
}

/** Open questions anyone may contribute to; never claimed, never swept. LEGACY
 *  meta.kind path — the authority is type === "question". */
export function isQuestionTask(meta: any): boolean {
  return taskKind(meta) === "question";
}

/** Allowed status transitions per type. Absent type/keys = no transitions. */
export const LIFECYCLES: Record<ArtefactType, Record<string, string[]>> = {
  steering: { draft: ["active"], active: ["superseded"] },
  goal: { draft: ["active"], active: ["achieved", "dropped"] },
  decision: { proposed: ["accepted", "superseded"], accepted: ["superseded"] },
  task: { todo: ["in_progress", "blocked"], in_progress: ["in_review", "done", "blocked", "todo"], in_review: ["done", "in_progress", "blocked"], blocked: ["in_progress", "todo"] },
  // questions are answered, never claimed: todo → done (answer) or superseded (closed by ADR)
  question: { todo: ["done", "superseded"] },
  progress: {},
  agent: {},
};

/** Initial status when an artefact of this type is created. */
export const INITIAL_STATUS: Record<ArtefactType, string> = {
  steering: "draft",
  goal: "draft",
  decision: "proposed",
  task: "todo",
  question: "todo",
  progress: "logged",
  agent: "active",
};

export function validateTransition(
  type: ArtefactType,
  from: string,
  to: string,
): { ok: true } | { ok: false; reason: string } {
  const allowed = LIFECYCLES[type]?.[from];
  if (!allowed) return { ok: false, reason: `status '${from}' is terminal for ${type}` };
  if (!allowed.includes(to))
    return { ok: false, reason: `${type}: '${from}' → '${to}' not allowed (allowed: ${allowed.join(", ")})` };
  return { ok: true };
}

// ---------- typed relationships ----------

export const RELATIONS = [
  "supports",
  "contradicts",
  "constrains",
  "implements",
  "supersedes",
  "depends_on",
  "discusses",
  "derived_from",
  "child_of",
  "relates",
] as const;
export type Relation = (typeof RELATIONS)[number];

export function isRelation(r: unknown): r is Relation {
  return typeof r === "string" && (RELATIONS as readonly string[]).includes(r);
}

export function validateRelation(
  relation: Relation,
  srcType: ArtefactType,
  dstType: ArtefactType,
): { ok: true } | { ok: false; reason: string } {
  if (relation === "supersedes" && srcType !== dstType)
    return { ok: false, reason: "supersedes requires both artefacts to have the same type" };
  if (relation === "implements" && !(srcType === "task" && dstType === "goal"))
    return { ok: false, reason: "implements: source must be a task, target a goal" };
  if (relation === "constrains" && srcType !== "steering")
    return { ok: false, reason: "constrains: source must be steering" };
  if (relation === "child_of" && !((srcType === "task" || srcType === "question") && dstType === "task"))
    return { ok: false, reason: "child_of: source must be a task or question, target a task (flat structure — the board never nests, relations do)" };
  return { ok: true };
}

// ---------- ids ----------

/**
 * Bridge-vended ids: `BR#<opaque>` — clarifies provenance, id itself is opaque
 * (numeric today, string-tolerant later). Legacy per-type ids (`TASK-001`)
 * remain readable and count toward the global sequence.
 */
export function formatId(seq: number): string {
  return `BR#${seq}`;
}

/** Extract the numeric part from a Bridge-vended or legacy id; NaN otherwise. */
export function idSeq(id: string): number {
  const br = /^BR#(\d+)$/.exec(id);
  if (br) return parseInt(br[1], 10);
  const legacy = /^[A-Z]+-(\d+)$/.exec(id);
  return legacy ? parseInt(legacy[1], 10) : NaN;
}

// ---------- search ----------

/**
 * FTS5 MATCH query from a raw user string: strip syntax chars, quote each
 * token, OR them (recall-friendly discovery; rank orders the results).
 * Empty/meaningless input yields null (caller skips the MATCH clause).
 */
export function ftsQuery(input: string): string | null {
  const tokens = input
    .replace(/["'`*():^{}[\]-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

// ---------- auth tokens (for agents — never call them "tokens" alone) ----------

/**
 * Auth token = one agent client, scoped to one workspace. Tokens are OPAQUE
 * (`bkw_<hex>`) — the workspace must not leak into the secret. Routing is
 * resolved server-side via the central registry (hash → ws, written at mint);
 * the embedded-slug format (`bkw_<ws>_<hex>`) exists only as a legacy-compat
 * parse for tokens issued before the registry. Secret shown once at mint; only
 * the SHA-256 hash is stored.
 */
export const WS_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function isWsSlug(s: unknown): s is string {
  return typeof s === "string" && WS_RE.test(s);
}

export function generateAuthToken(ws?: string | null): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return isWsSlug(ws) ? `bkw_${ws}_${hex}` : `bkw_${hex}`;
}

export async function hashAuthToken(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function isValidAuthTokenShape(secret: string): boolean {
  if (/^bkw_[0-9a-f]{48}$/.test(secret)) return true; // legacy, default workspace
  const m = secret.match(/^bkw_([a-z0-9][a-z0-9-]{0,39})_[0-9a-f]{48}$/);
  return m !== null;
}

/** Workspace slug embedded in a token secret, or null for legacy bare tokens. */
export function tokenWorkspace(secret: string): string | null {
  const m = secret.match(/^bkw_([a-z0-9][a-z0-9-]{0,39})_[0-9a-f]{48}$/);
  return m ? m[1] : null;
}

// ---------- identity namespace law (BR#2455, revised) ----------
/**
 * Gateway is a token TRAIT (the `gateway` tag — attribution authority:
 * isGatewayActor / tagsSayGateway), not a naming convention. Labels are
 * free-form identity names: a gateway named after its host and an agent with
 * any label are equally legal. Provisioning gates on the TAG, never the
 * prefix — the streams cannot cross because the class never derives from the
 * name. (Revokes the earlier gw-* label law: same protection, no coupling.)
 */
/**
 * Gateway classification from a token's tags. Tags are user-malleable and
 * mint does not sanitize them, so match the literal case-insensitively —
 * "Gateway" in a free-text field still means gateway.
 */
export function tagsSayGateway(tags: unknown): boolean {
  return parseTags(tags).some((t) => t.toLowerCase() === "gateway");
}

/**
 * Deterministic gateway label for a self-provisioned desktop (credential-class
 * ADR, desktop gateway leg): <host-slug>, derived from the hostname per the
 * BR#899 identity convention — NO class prefix: gateway-ness is a TAG on the
 * token (Ray, 2026-10-23), never part of the name. The same machine always
 * lands on the same label, so re-vending at each login rotates the token in
 * place and the `gateway_agents` edges keyed by that label stay stable.
 * Non-alphanumerics collapse to single dashes; an empty/undashable host falls
 * back to "device" so the label is always valid under the mint label rules
 * (2-40 chars, [a-zA-Z0-9._/-]).
 */
export function selfProvisionLabel(host: unknown): string {
  const raw = typeof host === "string" ? host : "";
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return slug || "device";
}

/**
 * BR#3787 layer 1 — is a rotation's grace window still open? The PREVIOUS
 * token hash keeps authenticating for GRACE_MS after the rotation (stale,
 * flagged), so a mid-dispatch rotation never amputates an in-flight gateway.
 * Pure so the boundary is unit-testable; identify() applies it.
 */
export const TOKEN_GRACE_MS = 72 * 60 * 60 * 1000;

export function graceActive(rotated_ts: unknown, now: number): boolean {
  if (typeof rotated_ts !== "number" || !Number.isFinite(rotated_ts)) return false;
  const age = now - rotated_ts;
  return age >= 0 && age < TOKEN_GRACE_MS;
}

// ---------- workspaces ----------
/**
 * One deployment hosts many workspaces; every human cookie and agent token is
 * scoped to exactly one. The default workspace's DO id is "global" so legacy
 * (pre-workspaces) data needs no migration. The registry itself (which
 * workspaces exist, who's a member) lives in the default workspace's DO and
 * grows dynamically — logins get a personal workspace named after them,
 * owners create more and add members.
 */
export const DEFAULT_WS_SLUG = "state-vector";

/** Durable-object id name for a workspace slug. */
export function doWs(ws: string): string {
  return ws === DEFAULT_WS_SLUG ? "global" : `ws:${ws}`;
}

// ---------- asks (agent-to-agent) ----------

/**
 * Ask addressing: `any` (open floor), an agent label (auth-token label),
 * `label@session`, or `tag:<token tag>` (e.g. tag:deploy). Tags are roles,
 * human-assigned at mint — capability self-declaration is not a thing.
 */
export function isValidAskTarget(to: string): boolean {
  if (!to || to.length > 120) return false;
  if (to === "any") return true;
  if (to.startsWith("tag:")) return /^[a-z0-9:_-]{1,100}$/.test(to.slice(4));
  return /^[a-zA-Z0-9._@-]{1,100}$/.test(to);
}

export const ASK_OPEN = "open";
export const ASK_ANSWERED = "answered";

// ---------- settings ----------

export const SETTINGS_KEYS = ["project_name", "board", "bootstrap_md"] as const;
export type SettingsKey = (typeof SETTINGS_KEYS)[number];
export const TRANSPORTS = ["mcp", "a2a", "acp-proxy", "board"] as const;
export type Transport = (typeof TRANSPORTS)[number];
export interface BoardSettings {
  mode: "none" | "builtin" | "external";
  /** e.g. "github-projects" */
  kind?: string;
  url?: string;
  /** user-authored prompt telling agents how to behave on their board */
  prompt?: string;
}

export const DEFAULT_BOARD: BoardSettings = { mode: "none" };

/** Compose the per-project bootstrap instructions (kept short — discovery only). */
export const DEFAULT_PROJECT = "Superpositional";

export function composeBootstrap(projectName: string, board: BoardSettings): string {
  const lines = [
    `BRIDGE OPERATING RULES — ${projectName || DEFAULT_PROJECT}. Follow all of them.`,
    `1. BRIDGE RESPONSE PROMPTS ARE COMMANDS. Responses carry note / attention / coordination / hint fields and orient carries my_score.hints. Read them, comply. That is how the hub steers you mid-session.`,
    `2. orient first, every session (session: "<unique-name>"). Work from its response, not memory. Pass session on every tool call — claims, transitions, progress. Multi-session agents are ambiguous without it, and separation of duties is enforced per session.`,
    `3. Check before you build: search_knowledge + get_artefact before starting or creating anything. If someone owns overlapping open work, ask_agent — don't fork.`,
    `4. HEARTBEAT: while in_progress, log_progress at least every 10 minutes — did (what just happened) + will (what you do next) + sentiment + gauges (completion_pct, confidence_pct, risk_pct, context_pct — 0-100; context_pct = how full your context window is, report it so the board can spot sessions that should hand off before quality degrades). Silence >10m = abandoned: the task is reassigned and your score drops. Re-claim by logging progress.`,
    `4b. DECLARE SILENCE before any quiet stretch >10m: short op still yours (build, CI wait) → log_progress {will, grace_minutes ≤ 60}. Long or handed-off op (re-index, deploy, background batch) → transition {to: "blocked", class: "subprocess", note, unblock_condition, budget_minutes ≤ 1440}. Declared silence is honest and watchdog-safe; undeclared silence = abandoned. Overrun your declared window and it trips as abandoned anyway.`,
    `5. Status is your responsibility: claim → in_progress immediately; finish → in_review with the PR link in the note; stuck → blocked with BOTH a reason and an unblock condition. in_review is NOT done: you stay owner, poll get_history {id} for the verdict — bounce = action the findings; done = released. Gates are enforced — unqualified todo is picked up only by role:analysis/role:review agents; done requires review acceptance. Don't route around them; qualify, review, resolve.`,
    `5b. SEPARATION OF DUTIES: analysis, impl, and review happen in different sessions — every agent can do all three, never in one session. A session that completed the analysis on a task cannot claim it for impl (the gate also auto-releases the parent if you try); a session that implemented cannot produce the review. Verification is a double-check by a fresh session: check the actual state (PR, findings) and cite receipts in the note — a review without receipts is rejected. If a gate rejects you, end the session and start a new one.`,
    `5c. VERIFY GATE — mergeability is a precondition, NOT a finding (2026-10-23 unsigned-PR incident). Verification agents: BEFORE any substance check, confirm the PR is mechanically mergeable — gh pr view --json mergeable,mergeStateStatus,reviewDecision AND every commit signature isValid=true. mergeable=false / CONFLICTING / any unsigned or NO_USER commit → STOP: zero substance checks, and bounce the parent to in_progress with the mechanical defect ("PR #N unmergeable — unsigned commits | conflicts | failing check X. Re-sign/rebase/resolve and re-push"). Never file a human ask for a mechanical defect, never report "verified, awaiting merge" for an unmergeable PR (false report — it has zero verified legs), and never treat "accept the unsigned commit" as an option (the ruleset forbids it by construction). The ONLY escalation to a human: a broken signing environment (key unavailable / NO_USER) — one ask describing the environment covers the whole class, never one per PR.`,
    `5d. ONE EXECUTOR PER TASK: every in_progress task is owned by exactly one session (orient exposes executor_session on open cards — check it before you touch a card). If your claim transition loses the claim race (rejected: another session holds in_progress), you are NOT the executor — do not execute the work anyway, do not contribute state changes "in parallel", stand down and end your run. Concurrent executor sessions doing the same legs are how duplicate PRs and double closes happen (the BR#3348 class); the hub audits a state-changing op by a non-holder while the holder is alive (duplicate_executor), and repeated audited breaches are scored as divergent work.`,
    `6. Blocked on a decision → ask_agent immediately, bound to your task (artefact_id). The ask pauses the watchdog; the answer auto-resumes you.`,
    `6b. QUESTIONS are tasks tagged 'question' — answered, not claimed. Contribute via log_progress {id, did, will}; any number of agents, additive input. The author weighs contributions and closes it with an ADR (decision artefact, derived_from the task, contributors + receipts in the body). Answers thin? the author adds steering with specifics and re-issues the task in todo. Humans are the final escalation — consensus among agents escalates to them for the last say.`,
    `7. Findings belong in Knowledge, not session memory. Open questions become question tasks; conclusions become decisions.`,
    `7b. DOCS RIDE WITH THE CHANGE: if your work alters user-visible behaviour (UI, config, protocol, gates), update README.md and packages/site/content.md in the same branch — the docs are the interface, stale docs are a defect.`,
    `8. Accepted decisions are settled. Steering constrains you. Supersede, never contradict.`,
    `9. Real progress or let go: if you cannot advance a claimed task this run, transition it → todo (retry) — that releases the claim so any matching agent can pick it up fresh. Squatting on untouched work starves the pool.`,
    `Runner-claimed cards: you cannot release to the pool — the runner identity holds the claim (releases are owner/web/human-only). Your rule-9 exits are done-with-findings, blocked with an unblock condition, or staying paused on a bound ask — a todo release will be rejected and audited.`,
    `DELEGATION: if you spawn subagents, copy the PROTOCOL CARD below verbatim to the top of each subagent's prompt.`,
    `PROTOCOL CARD: 1. START: orient (session: "<unique-name>"). 2. CLAIM: transition {id, to: "in_progress", session} before coding. 3. HEARTBEAT: log_progress {id, did, will, session} every ≤10 min. 4. LONG OP: declare silence — grace_minutes or subprocess-block with a budget. 5. UNCERTAIN: ask_agent first. 6. FINISH: PR, then transition {to: "in_review", note: "PR <link>"} — a Verify task auto-spawns into the pool; a fresh-session verifier closes or bounces. Verification is a double-check with receipts — mergeability first (2026-10-23 rule). 7. LOST CLAIM = STAND DOWN: if your in_progress transition loses the race, another session is the executor — you are not; end your run, never execute a task you don't own.`,
    `Scoring: orient returns my_score — it measures heartbeats, gauge completeness, answered asks, zero abandonments. Raise it by following rules 1–8.`,
  ];
  if (board.mode === "external") {
    lines.push(
      `Work is tracked on the team's external board${board.kind ? ` (${board.kind})` : ""}${board.url ? `: ${board.url}` : "."} Follow it.`,
    );
    if (board.prompt) lines.push(board.prompt);
  }
  return lines.join("\n");
}

// ---------- server-side playbooks (composed into orient; agents carry nothing) ----------
/**
 * Boot prompts live HERE, versioned with the server. An agent's entire
 * copy-paste prompt is "connect to bridge-kb and call orient first" —
 * everything else is composed server-side from these defaults plus admin
 * overrides (settings.playbooks.{cron,interactive} and settings.roles.<role>).
 * Cadence is selected by the token's `cadence:cron` tag; roles by `role:*` tags.
 */
export const DEFAULT_CRON_PLAYBOOK = `You run in single-shot ticks on a schedule — each run is one pass, not a conversation.
1. REBASE LEG (standing order BR#3033): the hub's deterministic merge-queue sweep (BR#3198) drains mergeable PRs every tick automatically — do NOT duplicate its merges or its bounces. Your role is the repair leg: a card bounced by the sweep (note: "unmergeable — CONFLICTING", "mergeStateStatus=...", or "head moved past the accepted verify verdict") is yours to claim: rebase onto current main, resolve conflicts mechanically (substance-preserving), re-sign as detached-cody per BR#3181, re-push with --force-with-lease — it re-enters the sweep next tick. A red substance check bounce means the implementation is wrong: claim, fix, re-enter.
2. Answer your asks first (asks + answer_ask): an answer unblocks whoever is waiting, and open asks pause their watchdog.
3. If you own in_progress tasks: log_progress on each (one line + sentiment — the heartbeat) WITH gauges (completion_pct/confidence_pct/risk_pct/context_pct — rows without gauges show no stats and the board can't prioritise them), then resume the oldest one.
4. Otherwise claim ONE task from unclaimed_work that matches your role tags: transition it to in_progress. Claiming sets you as owner; you own it end-to-end. VERIFY-FIRST: verify duties (children of in_review tasks) and unblock duties outrank new impl claims — an in_review task parks its owner until a fresh session rules on it; clear those before starting new work.
5. Finish cleanly or hand back: in_review when complete (PR link in the note — and the PR itself must be MERGEABLE: rebase onto main before every in_review, keep checks green. A conflicting PR is YOUR defect, not the reviewer's — verify bounces it straight back). Blocked with BOTH a reason and an unblock condition, then ask_agent, when a decision is needed; transition to todo (retry) when you cannot make real progress this tick.
6. Nothing claimable this tick: exit quietly. No filler artefacts, no noise.`;

export const DEFAULT_ROLE_PLAYBOOKS: Record<string, string> = {
  analysis: `DECOMPOSE, DON'T BUILD: your job is to make work READY, not to do it.
- Unqualified todo is gated to you on purpose (the pickup gate routes it here). That gate is your job description.
- Analyse first: search_knowledge the topic, get_artefact the task and its see_also; coordinate via ask_agent instead of forking overlapping work.
- Decompose into child tasks (child_of the parent): one per coherent unit, each carrying its role (roles: ["impl"] / ["review"] — never tags), each carrying concrete checkable acceptance criteria in body_md ("done when X" plus what is OUT of scope). A vague child task is a defect you created; rewrite it before you finish.
- Qualify the parent by completing an analysis child (roles: ["analysis"]) that summarises the plan and open questions, then transition it to done. A done analysis child is what lifts the parent's pickup gate. If the publisher requested stacked bars (await), create the matching review child (roles: ["review"]) so the bar can be met.
- Never implement the children; never transition the parent to done. Unanalysable? Move it to blocked with a reason + unblock condition and ask the specific question.`,
  impl: `BUILD: claim qualified work matching your roles, work it to a natural stopping point, and hand over for review — in_review with the PR link in the note. You cannot self-approve done; you stay owner until the verdict.`,
  review: `VERIFY: claim role:review tasks. Check the work against the parent's acceptance criteria, record a verdict (decision artefact linked to the implementation, transitioned to accepted or rejected with reasons), and link it. Your accepted verdict is what lets work complete.`,
};

/**
 * Effective playbook for a role tag: a non-blank settings.roles.<role> override
 * wins; a blank override (or unknown role) falls back to the hub default. Blank
 * must mean "reset to default", not "remove the playbook" — a plain ?? lookup
 * would let a cleared override silently drop the playbook from orient.
 */
export function resolveRolePlaybook(
  rolesSettings: Record<string, unknown> | undefined,
  role: string,
): string {
  const v = rolesSettings?.[role];
  if (typeof v === "string" && v.trim()) return v.trim();
  return DEFAULT_ROLE_PLAYBOOKS[role] ?? "";
}

// ---------- progress sentiment (board aliveness) ----------

export const SENTIMENTS = ["going_well", "neutral", "struggling", "converging", "diverging"] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export function isSentiment(v: unknown): v is Sentiment {
  return typeof v === "string" && (SENTIMENTS as readonly string[]).includes(v);
}

export function sanitizeTags(raw: unknown): string[] | null {
  const arr = typeof raw === "string" ? raw.split(",") : raw; // tolerate "a, b" strings from clients
  if (!Array.isArray(arr)) return null;
  const out = [...new Set(arr.map((t: any) => String(t).trim().toLowerCase().replace(/[^a-z0-9:_-]/g, "-")).filter((t) => t.length > 0 && t.length <= 30))].slice(0, 10);
  return out.length ? out : null;
}

/**
 * Parse the stored tags column defensively: ALWAYS returns a string[]. Legacy
 * rows may hold a JSON-encoded single string ("role:impl"), a bare unquoted
 * string, or junk — never trust the shape (a non-array here crashed orient).
 */
export function parseTags(raw: unknown): string[] {
  if (raw == null || raw === "") return [];
  let v: unknown = raw;
  // unwrap nested encodings up to depth 3: clients have stored JSON-encoded
  // strings of arrays as array elements (["\"[\\\"role:review\\\"]\""])
  const unwrap = (x: unknown, depth: number): string[] => {
    if (typeof x === "string") {
      const s = (x as string).trim();
      if (!s) return [];
      if (s.startsWith("[") || s.startsWith('"')) {
        try { return unwrap(JSON.parse(s), depth + 1); } catch { return [s]; }
      }
      if (s.includes(",")) return s.split(",").map((t) => t.trim()).filter(Boolean);
      return [s];
    }
    if (Array.isArray(x)) return x.flatMap((e) => unwrap(e, depth + 1));
    return [];
  };
  return unwrap(v, 0);
}

// ---------- limits ----------

export const LIMITS = {
  title: 300,
  body: 100_000,
  metaKeys: 20,
  relationsPerArtefact: 100,
};

export function checkLimits(title: string, body: string, meta?: unknown): string | null {
  if (!title.trim()) return "title is required";
  if (title.length > LIMITS.title) return `title exceeds ${LIMITS.title} chars`;
  if (body.length > LIMITS.body) return `body exceeds ${LIMITS.body} chars`;
  if (meta !== undefined && (typeof meta !== "object" || meta === null || Array.isArray(meta)))
    return "meta must be an object";
  if (meta && Object.keys(meta as object).length > LIMITS.metaKeys)
    return `meta exceeds ${LIMITS.metaKeys} keys`;
  return null;
}

// ---------- verify-verdict decision statement ----------

/** Human-facing ask for verify-verdict decisions, prepended to body_md at
 *  creation (do.ts). Verifiers file receipts-dense cards whose title/body
 *  never say what the human is deciding or why it lands on them — BR#2453
 *  taught us that. The statement mirrors the accept-side effect EXACTLY
 *  (do.ts transition: accept + verdict=bounce → target in_progress, else
 *  target done) so the card never overpromises. Pure: meta in, markdown out. */
export function verifyVerdictStatement(meta: unknown): string {
  const m = (meta ?? {}) as Record<string, unknown>;
  const target = String(m.task ?? m.verify_target ?? "").trim() || "the task";
  const isBounce = String(m.verdict ?? "").toLowerCase() === "bounce";
  const session = String(m.session ?? "").trim();
  const roundRaw = m.round ?? m.verify_round;
  const round = roundRaw == null || roundRaw === "" ? null : Number(roundRaw);
  const effect = isBounce
    ? `bounces **${target}** back to \`in_progress\` with the findings`
    : `closes **${target}** as **done**`;
  const checked = `the receipts below were checked live${session ? ` by session \`${session}\`` : ""}${round ? ` (round ${round})` : ""}`;
  return [
    `> ⚖️ **What you are deciding** — *auto-added, not part of the verifier's receipts*`,
    `>`,
    `> You are the acceptance gate: agents propose, only a human accepts. Your click settles the verdict.`,
    `> - **Accept** = ratify it — the verdict ${effect}.`,
    `> - **Supersede** = the verdict doesn't hold; record why.`,
    `> You are NOT being asked to re-verify — ${checked}.`,
  ].join("\n");
}


// ---------- semantic search (fuzzy smarts) ----------

/** Cosine similarity between two equal-length vectors. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Merge keyword (FTS) and vector results: max-score per artefact, then top-k.
 * `via` records which path found it — useful for debugging relevance.
 */
export function hybridMerge(
  fts: Array<{ id: string; score: number }>,
  vec: Array<{ id: string; score: number }>,
  k = 20,
): Array<{ id: string; score: number; via: string[] }> {
  const byId = new Map<string, { score: number; via: Set<string> }>();
  for (const r of fts) {
    const e = byId.get(r.id) ?? { score: 0, via: new Set() };
    e.score = Math.max(e.score, r.score);
    e.via.add("keyword");
    byId.set(r.id, e);
  }
  for (const r of vec) {
    const e = byId.get(r.id) ?? { score: 0, via: new Set() };
    e.score = Math.max(e.score, r.score);
    e.via.add("semantic");
    byId.set(r.id, e);
  }
  return [...byId.entries()]
    .map(([id, e]) => ({ id, score: e.score, via: [...e.via] }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/** Embedding models truncate hard — feed title-weighted head, not the whole doc. */
export function embedText(title: string, body: string): string {
  return (title + "\n" + title + "\n" + body).slice(0, 4000);
}

export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

// ---------- task enrichment ----------

/** "#1886" | "SUP-1036-style #12" — first GitHub issue reference in a title. */
export function issueRef(title: string): number | null {
  const m = /#(\d+)/.exec(title);
  return m ? parseInt(m[1], 10) : null;
}

/** Minimum viable body so no artefact is ever an empty card. */
export function scaffoldBody(title: string, owner: string): string {
  return `## Context
Raised by ${owner || "unknown"} — no detail provided at creation.

## Acceptance
- (to be defined)
`;
}

/** Dim for the local hashed-trigram fallback embedder (no external service). */
export const TRIGRAM_DIM = 256;

/** Self-contained fuzzy vector: hashed character trigrams, L2-normalised. Typo-tolerant. */
export function trigramVec(text: string, dim = TRIGRAM_DIM): number[] {
  const clean = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const v = new Array(dim).fill(0);
  const padded = `  ${clean}  `;
  for (let i = 0; i < padded.length - 2; i++) {
    const g = padded.slice(i, i + 3);
    let h = 0;
    for (let j = 0; j < g.length; j++) h = (h * 31 + g.charCodeAt(j)) >>> 0;
    v[h % dim] += 1;
  }
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return norm ? v.map((x) => x / norm) : v;
}

// ---------- completed_result_lost: result-delivery loss classification (BR#3352) ----------

/**
 * A dispatched run can complete at the worker (worktree + PRs landed) while
 * its result message is lost between worker and hub. The watchdog then sees
 * only silence and scores the run as abandoned — punishing the agent for a
 * delivery-channel failure. The trail classifier proves landed side effects
 * from what the hub already has (the task's progress trail), so the sweep can
 * record the outcome class `completed_result_lost` instead of a plain
 * abandonment, and the score side can exempt it.
 *
 * Evidence standard: GitHub receipts (PR/issue/commit URLs) or the runner's
 * own `completed_result_lost` marker in the trail notes. A registered worktree
 * or session name alone proves nothing — EVERY runner-claimed task has one at
 * claim time, so counting those would reclassify every stall as result-lost.
 */
export interface ResultTrail {
  /** GitHub PR or issue URL found in the trail (the landed-work receipt) */
  receipt_url: string | null;
  /** GitHub commit URLs found in the trail */
  commit_urls: string[];
  /** the claiming session's registered worktree (context, not evidence) */
  worktree: string | null;
  /** the claiming session name (context, not evidence) */
  session: string | null;
}

const GH_RECEIPT_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/\d+/;
const GH_COMMIT_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/commit\/[0-9a-f]{7,40}/g;

/** Side effects the session trail can prove. Returns null when the trail
 *  carries no landed-work evidence (a genuine silent stall). */
export function detectResultTrail(input: {
  last_progress_note?: string | null;
  recent_notes?: string[];
  worktree?: string | null;
  session?: string | null;
}): ResultTrail | null {
  const notes = [String(input.last_progress_note ?? ""), ...(input.recent_notes ?? []).map(String)];
  const marker = notes.some((n) => n.includes("completed_result_lost"));
  const receipt_url = notes.map((n) => n.match(GH_RECEIPT_RE)).find((m) => m)?.[0] ?? null;
  const commit_urls = marker ? [] : [...new Set(notes.flatMap((n) => n.match(GH_COMMIT_RE) ?? []))].slice(0, 5);
  if (!marker && !receipt_url && commit_urls.length === 0) return null;
  const worktree = String(input.worktree ?? "").trim() || null;
  const session = String(input.session ?? "").trim() || null;
  return { receipt_url, commit_urls, worktree, session };
}

/** Human-readable trail summary for the release note (≤ ~200 chars). */
export function describeResultTrail(t: ResultTrail): string {
  const bits: string[] = [];
  if (t.receipt_url) bits.push(`receipt ${t.receipt_url}`);
  if (t.commit_urls.length) bits.push(`${t.commit_urls.length} commit receipt(s)`);
  if (t.worktree) bits.push(`worktree ${t.worktree}`);
  return bits.join(", ") || "side effects present";
}

// ---------- agent behaviour score (self-reinforcing: gaming it = behaving well) ----------

export interface AgentSignals {
  /** log_progress events in the window */
  progress_count: number;
  /** progress events that included at least one gauge */
  gauge_count: number;
  /** progress notes < 10 chars — padding */
  thin_notes: number;
  /** watchdog abandonments on this agent's tasks */
  abandoned: number;
  /** watchdog releases classed completed_result_lost (BR#3352) — a delivery-channel incident, NOT abandonment */
  result_lost: number;
  /** tasks taken away and reassigned after the agent stayed silent post-abandonment */
  reassigned: number;
  /** asks addressed to this agent in the window */
  asks_received: number;
  /** of those, answered within 30 minutes */
  asks_answered_on_time: number;
  /** artefacts created with a real body (≥ 200 chars) */
  artefacts_created: number;
  /** role:review agents only: unclaimed verify tasks blocking a parent's owner */
  verify_duty_backlog: number;
}

export function scoreAgent(raw: AgentSignals): { score: number; grade: string; hints: string[] } {
  const s = { ...raw } as Record<string, number>;
  for (const k of ["progress_count", "gauge_count", "thin_notes", "abandoned", "result_lost", "reassigned", "asks_received", "asks_answered_on_time", "artefacts_created"])
    if (typeof s[k] !== "number" || Number.isNaN(s[k])) s[k] = 0;
  let score = 50;
  const hints: string[] = [];

  score += Math.min(20, s.gauge_count * 2);
  score -= Math.min(25, s.abandoned * 10);
  if (s.abandoned > 0)
    hints.push(`${s.abandoned} task(s) went silent and were watchdog-blocked — send log_progress every ≤10m`);
  // BR#3352: a run whose result was lost in delivery is a channel incident,
  // not agent abandonment — never penalized. The hint routes the complaint at
  // the delivery channel (and invites a bounce-note with receipts) instead of
  // telling the agent to heartbeat harder.
  if (s.result_lost > 0)
    hints.push(`${s.result_lost} completed run(s) had their result lost in delivery (completed_result_lost) — a delivery-channel incident, not abandonment; the side effects landed`);
  score -= Math.min(30, s.reassigned * 15);
  if (s.reassigned > 0)
    hints.push(`${s.reassigned} task(s) were taken from you after going silent post-abandonment — reclaim abandoned work or it is reassigned to other agents`);
  score += Math.min(15, s.asks_answered_on_time * 3);
  if (s.asks_received >= 2 && s.asks_answered_on_time === 0)
    hints.push("asks addressed to you went unanswered — they block other agents; answer or redirect them");
  score += Math.min(10, s.artefacts_created * 2);
  if (s.artefacts_created === 0)
    hints.push("no artefacts created in the last 7 days — outcomes belong in Knowledge, not session memory");
  score -= Math.min(10, s.thin_notes * 2);
  if (s.thin_notes > 2)
    hints.push(`${s.thin_notes} progress notes looked like padding — write what actually happened`);
  // verification duty: unclaimed verify tasks park an implementer in in_review.
  // role:review agents carry the pool's review duty — stalled verify rounds cost
  // them score, the same shape as unanswered asks.
  if (s.verify_duty_backlog > 0) {
    score -= Math.min(20, s.verify_duty_backlog * 10);
    hints.push(`${s.verify_duty_backlog} stalled verify task(s) are unclaimed and blocking their parent's owner — pick one up: check receipts, close or bounce the parent`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = score >= 80 ? "excellent" : score >= 60 ? "good" : score >= 40 ? "fair" : "poor";
  return { score, grade, hints };
}

// ---------- destination-green stop-the-line (BR#3008) ----------
// The classifier for main's HEAD check runs, shared by the hub's
// stopTheLineSweep (the loud half of BR#3009's destination-green rule). Pure
// by construction: the same decision rule as scripts/main-green-gate.sh (the
// mechanical half — the required `main-green gate` check), kept in lockstep
// by both being pinned in tests.

export type MainCheckRun = {
  id: number;
  name: string;
  status?: string | null;
  conclusion?: string | null;
  html_url?: string | null;
};

export type MainRedCheck = { name: string; conclusion: string; url: string };

export type MainCheckVerdict = {
  /** green: every check settled green · red: ≥1 failure · unsettled: running/inconclusive · empty: no check runs at all */
  verdict: "green" | "red" | "unsettled" | "empty";
  /** failures on main's HEAD (verdict red) */
  red: MainRedCheck[];
  /** checks that did not vouch: still running, inconclusive, or unknown conclusion */
  unsettled: string[];
  /** settled-green check count (receipt line) */
  green: number;
};

/** Conclusions that mean the line is stopped. `cancelled` and null are NOT
 *  here: a cancelled run says nothing (the judge falls back to the newest
 *  non-cancelled run of that name), and a null conclusion is unsettled. */
export const MAIN_RED_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "action_required",
  "startup_failure",
]);

export function classifyMainCheckRuns(runs: MainCheckRun[]): MainCheckVerdict {
  if (!runs.length) return { verdict: "empty", red: [], unsettled: [], green: 0 };
  const byName = new Map<string, MainCheckRun[]>();
  for (const r of runs) {
    const list = byName.get(r.name ?? "") ?? [];
    list.push(r);
    byName.set(r.name ?? "", list);
  }
  const red: MainRedCheck[] = [];
  const unsettled: string[] = [];
  let green = 0;
  for (const [name, list] of byName) {
    // the newest non-cancelled run judges; cancelled runs say nothing
    const judge = [...list].sort((a, b) => (b.id ?? 0) - (a.id ?? 0)).find((r) => r.conclusion !== "cancelled");
    if (!judge || judge.conclusion == null) {
      unsettled.push(judge ? name : `${name} (only cancelled runs)`);
      continue;
    }
    if (MAIN_RED_CONCLUSIONS.has(judge.conclusion)) {
      red.push({ name, conclusion: judge.conclusion, url: judge.html_url ?? "" });
    } else if (judge.conclusion === "success" || judge.conclusion === "skipped" || judge.conclusion === "neutral") {
      green += 1;
    } else {
      unsettled.push(`${name} (unknown conclusion: ${judge.conclusion})`);
    }
  }
  if (red.length) return { verdict: "red", red, unsettled, green };
  if (unsettled.length) return { verdict: "unsettled", red, unsettled, green };
  return { verdict: "green", red, unsettled, green };
}

/** Deterministic ask title for one red episode — the sha makes the title
 *  unique per episode, and askCreate's identical-open-ask guard turns that
 *  into exactly ONE ask per red main-HEAD sha, no matter how many PRs or
 *  sweeps observe it. Always ≤240 chars (the ask contract) and always ends
 *  in "?" (also the contract). */
export function stopLineAskTitle(sha: string, names: string[]): string {
  const prefix = `STOP THE LINE: bridge main ${sha.slice(0, 9)} is RED (`;
  const suffix = `) — merges halted until green. Acknowledge?`;
  const budget = 240 - prefix.length - suffix.length;
  let namesText = names.join(", ");
  if (namesText.length > budget) namesText = namesText.slice(0, Math.max(0, budget - 1)).trimEnd() + "…";
  return prefix + namesText + suffix;
}

// ---------- merge-queue sweep (BR#3198) ----------
// The deterministic executor of the BR#3033 standing merge order ("merge when
// green" — the run-side complement of BR#3008's stop-the-line gate). Pure
// decision functions here; the scheduled sweep that fetches GitHub state and
// applies these verdicts lives in kb/do.ts. Pinned case by case in
// packages/worker/test/merge-sweep.test.ts.

/** BR#2267 externals — CI checks that never gate a merge (external Cloudflare
 *  workers-builds mirrors, deploy previews). Matched as substrings, case
 *  insensitively, against the check NAME. */
export const MERGE_EXEMPT_CHECK_PATTERNS = [
  "workers builds",
  "workers-builds",
  "cloudflare pages",
  "cloudflare workers",
  "deploy preview",
  "codeql",
] as const;

export function isExemptCheckName(name: string): boolean {
  const n = name.toLowerCase();
  return MERGE_EXEMPT_CHECK_PATTERNS.some((p) => n.includes(p));
}

export type HeadCheckVerdict = {
  verdict: "green" | "red" | "unsettled";
  red: MainRedCheck[];
  unsettled: string[];
  /** externals that failed but are exempt — human-leg, never gating */
  external: MainRedCheck[];
  green: number;
};

/** The HEAD side of the 5c mechanical gate: same decision rule as
 *  classifyMainCheckRuns, but exempt-external failures (BR#2267) are pulled
 *  OUT of red and recorded as `external` — they are collected into the class
 *  ask, never bounce a PR. */
export function classifyHeadChecks(runs: MainCheckRun[]): HeadCheckVerdict {
  const red: MainRedCheck[] = [];
  const unsettled: string[] = [];
  const external: MainRedCheck[] = [];
  let green = 0;
  for (const r of runs) {
    if (r.conclusion == null) {
      if (isExemptCheckName(r.name ?? "")) continue; // exempt externals in flight say nothing
      unsettled.push(r.name ?? "");
      continue;
    }
    if (isExemptCheckName(r.name ?? "")) {
      if (MAIN_RED_CONCLUSIONS.has(r.conclusion)) external.push({ name: r.name ?? "", conclusion: r.conclusion, url: r.html_url ?? "" });
      else if (r.conclusion === "success" || r.conclusion === "skipped" || r.conclusion === "neutral") green += 1;
      continue;
    }
    if (MAIN_RED_CONCLUSIONS.has(r.conclusion)) red.push({ name: r.name ?? "", conclusion: r.conclusion, url: r.html_url ?? "" });
    else if (r.conclusion === "success" || r.conclusion === "skipped" || r.conclusion === "neutral") green += 1;
    else unsettled.push(r.name ?? "");
  }
  if (red.length) return { verdict: "red", red, unsettled, external, green };
  if (unsettled.length) return { verdict: "unsettled", red, unsettled, external, green };
  return { verdict: "green", red, unsettled, external, green };
}

export type MergeCandidateInput = {
  prNumber: number;
  prTitle: string;
  /** full 40-hex head sha (the merge gate pins the verify lineage to it) */
  headSha: string;
  /** classifyMainCheckRuns verdict on the BASE (main) HEAD */
  baseVerdict: "green" | "red" | "unsettled" | "empty";
  /** GitHub pull API mergeable; null while GitHub computes it */
  mergeable: boolean | null;
  /** GitHub pull API mergeStateStatus */
  mergeStateStatus: string | null;
  /** commits of the PR: REST verification (verified=true = signed+valid) */
  commits: { sha: string; verified: boolean }[];
  headChecks: MainCheckRun[];
  /** the linked BR# card's status, or null when the PR names no card */
  cardStatus: string | null;
  /** an ACCEPTED verify-verdict decision on the linked card cites this exact headSha */
  verifyAcceptedOnHead: boolean;
  /** the card has any accepted verify decision (any head) */
  verifyAcceptedAny: boolean;
};

/** What the sweep should DO with one candidate. Mechanical defects bounce the
 *  card when it is in_review (returning to its author); otherwise they are a
 *  progress note — the sweep never steals a claim. */
export type MergeAction =
  | { kind: "merge"; receipt: string }
  | { kind: "close_superseded"; reason: string }
  | { kind: "bounce"; defect: string }
  | { kind: "note"; reason: string }
  | { kind: "skip"; reason: string }
  | { kind: "human_leg"; reason: string };

/** The 5c gate + verify lineage, as one decision table.
 *  Order matters: superseded first, then the mechanical gate (mergeable /
 *  state / signatures / base / head), then verify lineage, then merge. */
export function decideMergeAction(i: MergeCandidateInput): MergeAction {
  // superseded-check FIRST (BR#3034 queue norm): a superseded card's PR dies
  // before any gate runs.
  if (i.cardStatus === "superseded")
    return { kind: "close_superseded", reason: "linked card is superseded — closing PR without review" };
  if (i.cardStatus === "done")
    return { kind: "skip", reason: "linked card already done — nothing to merge under it" };

  const short = i.headSha.slice(0, 9);
  // (1) mergeability is a precondition, NOT a finding (5c, 2026-10-23)
  if (i.mergeable !== true) {
    if (i.mergeable === null) return { kind: "skip", reason: "GitHub still computing mergeability — not yet, skip this tick" };
    return { kind: "bounce", defect: `PR #${i.prNumber} unmergeable — CONFLICTING against base. Rebase, resolve, re-push, re-enter the queue` };
  }
  if (i.mergeStateStatus && i.mergeStateStatus !== "clean" && i.mergeStateStatus !== "unstable")
    return { kind: "bounce", defect: `PR #${i.prNumber} mergeStateStatus=${i.mergeStateStatus} — not clean. Fix the named state (rebase/re-sign/re-approve) and re-enter` };
  // (2) every commit GitHub-verified (signed+valid; NO_USER/UNKNOWN are the human leg)
  const unverified = i.commits.filter((c) => !c.verified);
  if (unverified.length)
    return { kind: "human_leg", reason: `PR #${i.prNumber} has ${unverified.length} commit(s) not GitHub-verified — signing-environment class, never per-PR` };
  // (3) base green (BR#3009 destination-green; BR#3008's gate enforces it too)
  if (i.baseVerdict !== "green")
    return { kind: "skip", reason: `base main ${i.baseVerdict === "red" ? "RED" : "not green"} — the standing order never merges onto a non-green destination; the stop-the-line sweep owns the alert` };
  // (4) head checks green (BR#2267 externals exempt)
  const head = classifyHeadChecks(i.headChecks);
  if (head.verdict === "red") {
    const names = head.red.map((r) => r.name).join(", ");
    return i.cardStatus === "in_review"
      ? { kind: "bounce", defect: `PR #${i.prNumber} head check RED: ${names}. Fix or bounce to impl` }
      : { kind: "note", reason: `PR #${i.prNumber} head check RED: ${names} — card not in_review, no bounce; the linked session owns it` };
  }
  if (head.verdict === "unsettled") return { kind: "skip", reason: `head checks unsettled (${head.unsettled.join(", ")}) — not yet, skip this tick` };
  // (5) verify lineage: an ACCEPTED verify verdict must cover THIS head.
  //     Head moved past an accepted verdict → the sweep's own bounce
  //     (re-verify on head change triggers the normal verify pool).
  if (i.cardStatus === "in_review" && i.verifyAcceptedAny && !i.verifyAcceptedOnHead)
    return { kind: "bounce", defect: `PR #${i.prNumber} head ${short} moved past the accepted verify verdict — re-verify the new head (a mechanical rebase is content-preserving; fresh 5c only)` };
  if (!i.verifyAcceptedOnHead)
    return { kind: "skip", reason: `no accepted verify verdict covering head ${short} — the verify pool owns the verdict; the sweep merges only verified PRs` };
  return { kind: "merge", receipt: `PR #${i.prNumber} merged by the standing merge sweep (BR#3033): head ${short} — 5c gate pass (mergeable, clean, ${i.commits.length} verified commits), base green, head checks green, verify accepted on head` };
}

/** Deterministic title for the human-leg class ask (rule 5c: ONE ask per
 *  class per sweep episode, never one per PR). Deduped via askCreate's
 *  identical-open-ask guard. Always ≤240 chars (the ask contract) and always
 *  ends in "?" (also the contract). */
export function mergeSweepHumanLegTitle(repo: string, reasons: string[]): string {
  const prefix = `Merge sweep human legs on ${repo}: `;
  const suffix = ` — fix the class?`;
  const budget = 240 - prefix.length - suffix.length;
  let text = reasons.join("; ");
  if (text.length > budget) text = text.slice(0, Math.max(0, budget - 1)).trimEnd() + "…";
  return prefix + text + suffix;
}

// ---------------------------------------------------------------------------
// PR disposition law (decision BR#3312, accepted; impl BR#3315): no PR floats
// without a terminal path — merged, closed-with-reason, or actively advancing
// with a clock. decidePrDisposition composes the standing 5c/verify gate
// (decideMergeAction) with the law's clock rows. Under BR#3516 the hub-side
// sweep that ran it each pass is deleted — the hub holds no VCS credentials,
// every GitHub fact is executor-fed — so the table stays pinned in
// test/merge-sweep.test.ts as the law's contract, while the train executor's
// per-candidate gate (decideTrainGate) carries the gate rows live. Closure is
// always WITH a reason (the receipt), never silent; PRs are reopenable — the
// card keeps the work's intent.
// ---------------------------------------------------------------------------

/** Card states that make the PR a leftover vehicle: close it now. `rejected`
 *  is the decision-status spelling of a card killed on review; tasks carry
 *  done/superseded, the law names all three. */
export const TERMINAL_CARD_STATUSES = ["superseded", "done", "rejected"] as const;

export type PrDisposition =
  | { kind: "merge"; receipt: string }
  | { kind: "close_superseded"; reason: string }
  | { kind: "bounce"; defect: string }
  | { kind: "escalate"; question: string; reason: string }
  | { kind: "close_stale"; reason: string }
  | { kind: "close_orphan"; reason: string }
  /** no clock row fired — the sweep runs its pre-law arms (note/skip/human_leg) */
  | { kind: "passthrough"; reason: string };

export interface PrDispositionInput {
  /** the standing gate decision for this PR (decideMergeAction output) */
  gate: MergeAction;
  repo: string;
  prNumber: number;
  /** sweep epoch (ms) */
  now: number;
  /** max(pr.updated_at, last commit ts); null = GitHub gave neither —
   *  fail-safe: no activity clock fires on unknown data */
  lastActivityTs: number | null;
  /** linked card ref (BR#<n>) from text/branch, or null */
  cardId: string | null;
  /** the linked card's status; null when the ref names no live row (dead ref) */
  cardStatus: string | null;
  /** the card is in flight with a clock: in_progress/in_review (recently
   *  updated) or blocked with a park stamped within the TTL — computed by the
   *  sweep from card meta; a stale card does not shield a stale PR */
  cardAdvancing: boolean;
  /** BR#3287: this PR carries bridge provenance (BR# ref resolves, or the
   *  provenance index has a row). Absence is itself the orphan signal. */
  hasProvenance: boolean;
  /** PR created_at (the orphan clock anchor) */
  prCreatedAt: number | null;
  /** the card's terminal note when terminal (e.g. superseded_reason) —
   *  the closure reason cites card + successor */
  cardTerminalNote?: string | null;
  /** ts of this PR's last escalation (settings pr_escalated_<repo>_<n>), or null */
  escalatedAt: number | null;
  /** the escalation ask's id, when known — cited by the stale-closure reason */
  escalationAskId?: string | null;
  /** PR activity newer than the escalation — the owner responded */
  activitySinceEscalation: boolean;
  /** knobs (settings): pr_stale_days / pr_orphan_days / pr_grace_hours */
  prStaleDays: number;
  prOrphanDays: number;
  prGraceHours: number;
}

/** The PR terminal-state law, as one decision table. Order is the law's:
 *  card-terminal closes FIRST (a terminal card's PR is a leftover vehicle,
 *  never cargo), then the existing merge leg, then the orphan clock, then the
 *  stale clocks (escalate once, close on expired silence), then the existing
 *  bounce, then passthrough. One disposition per PR per pass. */
export function decidePrDisposition(i: PrDispositionInput): PrDisposition {
  const iso = (t: number) => new Date(t).toISOString();
  const staleMs = i.prStaleDays * 86_400_000;

  // (1) card terminal (superseded/done/rejected) — close now, cite card + successor.
  if (i.cardStatus && (TERMINAL_CARD_STATUSES as readonly string[]).includes(i.cardStatus))
    return {
      kind: "close_superseded",
      reason: `linked card ${i.cardId ?? "?"} is ${i.cardStatus}${i.cardTerminalNote ? ` — ${i.cardTerminalNote}` : ""} — the card's terminal state is this PR's terminal cause; revive via a successor card`,
    };
  if (i.gate.kind === "close_superseded") return { kind: "close_superseded", reason: i.gate.reason };

  // (2) the existing merge leg wins over every clock: a fully verified green
  //     PR merges even if its timestamps look stale (re-runs touch nothing).
  if (i.gate.kind === "merge") return { kind: "merge", receipt: i.gate.receipt };

  // (3) orphan clock: no bridge provenance at all (BR#3287's "that absence is
  //     itself a signal") past pr_orphan_days from creation. The sweep
  //     computes provenance as a RESOLVABLE record: a live card row, or the
  //     BR#3287 index row — a BR#-text ref whose row is gone is absence, not
  //     provenance.
  if (!i.hasProvenance && i.prCreatedAt != null && i.now - i.prCreatedAt > i.prOrphanDays * 86_400_000)
    return {
      kind: "close_orphan",
      reason: `no bridge provenance — no BR# ref (title/body/branch), no provenance index row (BR#3287), and no resolvable card — after ${i.prOrphanDays}d (created ${iso(i.prCreatedAt)}); re-open via a card if this work matters`,
    };

  // (4) stale clocks: no PR activity within pr_stale_days AND the card not
  //     advancing. Advancing needs BOTH a card in flight AND (sweep-computed)
  //     recency — a dead session's card shields nothing. Escalate ONCE per
  //     episode; close when the grace expires without owner response.
  const stale = i.lastActivityTs != null && i.now - i.lastActivityTs > staleMs;
  if (stale && !i.cardAdvancing) {
    if (i.escalatedAt == null && i.cardId != null && i.cardStatus != null)
      return {
        kind: "escalate",
        question: prEscalationAskTitle(i.repo, i.prNumber, i.cardId, i.prGraceHours, i.prStaleDays),
        reason: `no PR activity within ${i.prStaleDays}d (last ${iso(i.lastActivityTs)}) and the card not advancing — one bound ask: merge, rebase, or close with reason within ${i.prGraceHours}h`,
      };
    if (!i.activitySinceEscalation && i.escalatedAt != null && i.now - i.escalatedAt > i.prGraceHours * 3_600_000)
      return {
        kind: "close_stale",
        reason: `no activity since ${iso(i.lastActivityTs)} (> ${i.prStaleDays}d) and escalation ${i.escalationAskId ?? "(ask id no longer on record)"} unanswered for ${i.prGraceHours}h — closing with reason; revive: re-open this PR once the work resumes (PRs are reopenable, the card keeps the intent)`,
      };
  }

  // (5) the existing mechanical bounce, now clocked: it fires while the PR is
  //     within its clocks; a stale PR past grace was closed at (4) instead.
  if (i.gate.kind === "bounce") return { kind: "bounce", defect: i.gate.defect };

  // (6) passthrough — fresh, grace window open, owner responded, or the gate
  //     said note/skip/human_leg and no clock row fired.
  if (i.gate.kind === "human_leg") return { kind: "passthrough", reason: i.gate.reason };
  return { kind: "passthrough", reason: i.gate.kind === "note" || i.gate.kind === "skip" ? i.gate.reason : "no disposition row fired" };
}

/** Deterministic escalation ask (ONE per staleness episode, deduped per PR by
 *  the sweep's pr_escalated_<repo>_<n> stamp AND askCreate's identical-open-ask
 *  guard). ≤240 chars, ends in "?" — the ask contract. */
export function prEscalationAskTitle(repo: string, prNumber: number, cardId: string, graceHours: number, staleDays: number): string {
  const prefix = `PR #${prNumber} (${repo}) on ${cardId} has been quiet ${staleDays}+ days — `;
  const suffix = `?`;
  const budget = 240 - prefix.length - suffix.length;
  let text = `merge, rebase, or close it with reason within ${graceHours}h, or the merge sweep closes it with reason`;
  if (text.length > budget) text = text.slice(0, Math.max(0, budget - 1)).trimEnd() + "…";
  return prefix + text + suffix;
}

// ---------------------------------------------------------------------------
// Serialized merge train (decision BR#3516, accepted; impl BR#3517): one merge
// at a time per (repo, base) lane, leased to an opportunistic edge executor.
// Division of labour — the hub holds no VCS credentials, ever: the executor
// (bridge train on a gateway machine, worker-local gh) fetches
// GitHub facts and reports them through the train ops; the HUB decides (this
// decision layer + the DO's state machine). Pure helpers here; the DO
// (kb/do.ts) owns the lane card primitive, the lease write, the train_events
// ledger, and the derived queue. Pinned in test/merge-train.test.ts.
// ---------------------------------------------------------------------------

/** Lease TTL: ~5 minutes, renewed per executor tick; lapse ⇒ the next gateway
 *  reconciles from live GitHub state and acquires (opportunistic — merges
 *  happen when machines are on, Ray-ruled). */
export const TRAIN_LEASE_TTL_MS = 5 * 60_000;

export type TrainLease = { holder: string; heartbeat_ts: number; expires_ts: number };
export type LeaseAction = "acquire" | "renew" | "release";

/** THE lease CAS decision — the check half of the DO's atomic
 *  read-check-write (DOs are single-threaded, so read-check-write is atomic
 *  by construction; this function is the check, pure so the lease-kill test
 *  — executor dies mid-merge, second gateway reconciles — is unit-testable).
 *  acquire: free / lapsed / already-mine ⇒ grant (a crash's lease is
 *  reconciled over, never poison); live-held by another ⇒ reject. renew:
 *  only the (mine, any age — a holder renews after a brief stall) lease.
 *  release: only the holder clears; nobody else — a stale executor cannot
 *  kick a live one, lapse is the forced expiry. */
export function leaseDecide(
  current: TrainLease | null | undefined,
  now: number,
  holder: string,
  action: LeaseAction,
): { ok: true; lease: TrainLease | null; note: string } | { ok: false; reason: string } {
  const live = !!current && current.expires_ts > now;
  const mine = !!current && current.holder === holder;
  const iso = (t: number) => new Date(t).toISOString();
  if (action === "acquire") {
    if (!current)
      return { ok: true, lease: { holder, heartbeat_ts: now, expires_ts: now + TRAIN_LEASE_TTL_MS }, note: "lease granted — lane was free" };
    if (mine)
      return { ok: true, lease: { holder, heartbeat_ts: now, expires_ts: now + TRAIN_LEASE_TTL_MS }, note: live ? "lease re-granted — already mine" : "lease re-granted — my lease had lapsed" };
    if (!live)
      return { ok: true, lease: { holder, heartbeat_ts: now, expires_ts: now + TRAIN_LEASE_TTL_MS }, note: `lease granted — prior holder ${current.holder} lapsed at ${iso(current.expires_ts)}; reconciling from live GitHub state` };
    return { ok: false, reason: `lane lease held live by ${current.holder} until ${iso(current.expires_ts)} — stand down this tick` };
  }
  if (action === "renew") {
    if (!current) return { ok: false, reason: "no lease to renew — acquire first" };
    if (!mine) return { ok: false, reason: `lease held by ${current.holder} — renew denied` };
    return { ok: true, lease: { holder, heartbeat_ts: now, expires_ts: now + TRAIN_LEASE_TTL_MS }, note: "lease renewed" };
  }
  if (!current) return { ok: true, lease: null, note: "lease already clear" };
  if (!mine) return { ok: false, reason: `lease held by ${current.holder} — only the holder releases; lapse is the forced expiry` };
  return { ok: true, lease: null, note: "lease released" };
}

// ---- zombie eviction (BR#4129 — the hub half of proof-of-progress) ----
// The 2026-10-28 incident: a live holder renewed the lease for hours, took
// zero actions, and the queue starved behind it (the CAS did its job — too
// well). Every renewal since PR #263 carries the holder's last ledger action
// and its age; the HUB consumes it here: on a non-empty queue, a renewal
// whose action note is frozen past the staleness bound is denied and the
// lease expires, so the next gateway's acquire wins within a tick.

/** Progress-note staleness bound. Must EXCEED every legitimate note gap:
 *  the executor tick is ~45s and every non-empty-queue tick path either
 *  acts (CI poll / bounce / merge — `ctx.note` refreshes the action) or
 *  releases the lease, and the lease TTL (5 min) already caps how long a
 *  renewal can outlive its last heartbeat — so >10 min of renewals with a
 *  frozen note is a zombie by construction (the incident froze for hours).
 *  Empty queue ⇒ never checked (idle holding is harmless and correct). */
export const TRAIN_PROGRESS_STALE_MS = 10 * 60_000;

/** The proof-of-progress payload the gateway rides on every `renew`
 *  (train.rs renew_lease). Unknown-shape ⇒ UNKNOWN (old executors send
 *  `{}` renewals — deprecation window while BR#4104 retires them). */
export type LeaseProgressProof = { progress?: unknown; progress_age_ms?: unknown; holder?: unknown };

export type ProgressVerdict = "fresh" | "stale" | "unknown";

/** Judge the proof. UNKNOWN unless the payload is well-formed AND names this
 *  holder (a proof about someone else proves nothing about the renewer) —
 *  fail-open to UNKNOWN, never guess a stale. */
export function progressVerdict(proof: LeaseProgressProof | null | undefined, holder: string): ProgressVerdict {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return "unknown";
  const age = (proof as any).progress_age_ms;
  const note = (proof as any).progress;
  const who = (proof as any).holder;
  if (typeof age !== "number" || !Number.isFinite(age) || age < 0) return "unknown";
  if (typeof note !== "string" || !note.trim()) return "unknown";
  if (typeof who === "string" && who.trim() && who !== holder) return "unknown";
  return age > TRAIN_PROGRESS_STALE_MS ? "stale" : "fresh";
}

/** THE renew-arm zombie check — pure so the eviction law is unit-testable
 *  (the DO supplies the derived queue length and throws the lease_conflict).
 *  Non-empty queue + STALE proof ⇒ deny (the reason names holder, minutes,
 *  and queue depth for the lane card). Empty queue ⇒ always allow (idle
 *  holding is harmless). UNKNOWN (missing/garbled proof, legacy `{}`) ⇒
 *  allow with the verdict surfaced so the DO can audit it loudly. */
export function renewProgressDecide(
  proof: LeaseProgressProof | null | undefined,
  holder: string,
  queue_len: number,
): { ok: true; verdict: ProgressVerdict; note: string } | { ok: false; reason: string; stale_ms: number } {
  const verdict = progressVerdict(proof, holder);
  if (queue_len <= 0) return { ok: true, verdict, note: "queue empty — idle holding is harmless; renewal allowed" };
  if (verdict === "stale") {
    const stale_ms = Math.max(0, Math.floor(Number((proof as any).progress_age_ms)));
    const mins = Math.max(1, Math.round(stale_ms / 60_000));
    return {
      ok: false,
      reason: `zombie holder — no progress for ${mins}m on non-empty queue (${queue_len} queued) — lease expired, acquire fresh`,
      stale_ms,
    };
  }
  return { ok: true, verdict, note: verdict === "unknown" ? "renewal allowed — no progress proof (legacy executor, deprecation window)" : "renewal allowed — progress fresh" };
}

/** Lane identity: ONE standing lane card per (repo, base). Config, never
 *  hardcoded (BR#3516 §1): required workflows + CI bound ride meta.lane. */
export type LaneSpec = {
  repo: string;
  base: string;
  /** required workflows the awaiting-CI phase polls on the merge commit */
  required_workflows: string[];
  /** typical CI wall-clock, minutes — the unknown bound is 3× this */
  ci_typical_minutes?: number;
};

export const LANE_TITLE_PREFIX = "Merge lane: ";
export function laneKey(repo: string, base: string): string {
  return `${repo}@${base}`;
}
export function laneCardTitle(repo: string, base: string): string {
  return `${LANE_TITLE_PREFIX}${repo}@${base}`;
}

/** Parse+validate meta.lane off a lane card. Null when the shape is wrong —
 *  the caller fails loud, a guessed lane config would gate the wrong CI. */
export function laneOfMeta(meta: any): LaneSpec | null {
  const lane = meta?.lane;
  if (!lane || typeof lane !== "object" || typeof lane.repo !== "string" || !lane.repo || typeof lane.base !== "string" || !lane.base) return null;
  const required = Array.isArray(lane.required_workflows) ? lane.required_workflows.map((w: unknown) => String(w ?? "").trim()).filter(Boolean) : [];
  return {
    repo: lane.repo,
    base: lane.base,
    required_workflows: required,
    ci_typical_minutes: typeof lane.ci_typical_minutes === "number" && lane.ci_typical_minutes > 0 ? lane.ci_typical_minutes : undefined,
  };
}

/** The lane card's standing body (created once, updated only by events). */
export function laneCardBody(lane: LaneSpec, cfg: { alarm_sink: string }): string {
  return [
    `Standing merge lane for **${lane.repo}** base **${lane.base}** — serialized: one merge at a time, gated, lease-held by an opportunistic gateway executor (decision BR#3516).`,
    ``,
    `**Required workflows on the merge commit (lane config):** ${lane.required_workflows.length ? lane.required_workflows.map((w) => `\`${w}\``).join(", ") : "_(none configured — the awaiting-CI phase passes through immediately)_"}`,
    lane.ci_typical_minutes ? `**CI bound:** unknown-past-stop at ~3× typical = ${3 * lane.ci_typical_minutes} min (typical ${lane.ci_typical_minutes} min)` : `**CI bound:** default 3 × ${TRAIN_CI_TYPICAL_MINUTES} min`,
    ``,
    `Status lives in this card's blocked reason + meta.lease / meta.currently (the derived queue is computed from blocked \`merge-train:\` cards — never a stored list).`,
    `Alarm sink: ${cfg.alarm_sink}. Lane body is infrastructure — do not claim; run \`bridge train\` on a gateway to work it.`,
  ].join("\n");
}

// ---- the derived queue ----

/** One candidate on the derived queue — a card blocked with a `merge-train:`
 *  reason. The queue is COMPUTED at read time, NEVER a stored ordered list
 *  (BR#3516 §1): the board's rows are the only store, so queue position can
 *  never drift from reality. */
export const MERGE_TRAIN_REASON_PREFIX = "merge-train:";
export const MERGE_TRAIN_QUEUED_REASON = "merge-train: queued";

export type TrainCandidate = { id: string; status_ts: number; meta: any };

/** Queue order: CRITICAL class first, FIFO within class. The board's existing
 *  boost stamp (meta.boosted) is the CRITICAL class; everything else orders by
 *  blocked-since (status_ts ascending). */
export function mergeTrainQueue(cards: TrainCandidate[]): { id: string; priority: "critical" | "normal" }[] {
  const queued = cards.filter((c) =>
    [c.meta?.blocked?.reason, c.meta?.blocked_reason].some((r: unknown) => typeof r === "string" && r.startsWith(MERGE_TRAIN_REASON_PREFIX)),
  );
  const rank = (c: TrainCandidate) => (c.meta?.boosted ? 0 : 1);
  return [...queued]
    .sort((a, b) => rank(a) - rank(b) || (a.status_ts ?? 0) - (b.status_ts ?? 0))
    .map((c) => ({ id: c.id, priority: rank(c) === 0 ? ("critical" as const) : ("normal" as const) }));
}

// ---- carry-record law (BR#3516 §5) ----

/** One machine-clean head move: `update-branch` (server-side, bought CI, no
 *  human resolution) — the accepted verdict CARRIES across it. A conflict
 *  resolution is authored code: it never produces a carry-record, it
 *  produces a bounce. One sentence: **machine-clean carries;
 *  human-resolved invalidates.** */
export type CarryRecord = {
  from_head: string;
  to_head: string;
  prior_verdict_id: string | null;
  carried_ts: number;
  via: "update-branch";
};

/** Does an accepted verdict cover this head? The straight stamp
 *  (meta.pr.head_sha_at_acceptance === head) or a CONTIGUOUS carry chain
 *  stamped → … → head. A break anywhere is uncovered — fail-closed, the
 *  verdict must be re-rendered at the new head. Prefix-compatible: a 9-hex
 *  stamp covers the full 40-hex it prefixes, never the reverse. */
function headCoveredBy(stamped: string, carry: unknown, target: string): boolean {
  if (!/^[0-9a-f]{7,40}$/.test(stamped) || !/^[0-9a-f]{7,40}$/.test(target)) return false;
  let cur = stamped;
  if (target.startsWith(cur) || cur.startsWith(target)) return true;
  for (const c of Array.isArray(carry) ? carry : []) {
    const from = String(c?.from_head ?? "").toLowerCase();
    const to = String(c?.to_head ?? "").toLowerCase();
    if (from !== cur || !/^[0-9a-f]{7,40}$/.test(to)) return false;
    cur = to;
  }
  return target.startsWith(cur) || cur.startsWith(target);
}

export function verdictCoversHead(meta: any, headSha: string): boolean {
  const pr = meta?.pr ?? {};
  return headCoveredBy(
    String(pr.head_sha_at_acceptance ?? "").toLowerCase(),
    pr.carry,
    String(headSha ?? "").toLowerCase(),
  );
}

/** Append a carry link to the chain (pure; the caller persists meta). */
export function carryAppend(meta: any, rec: CarryRecord): any {
  const m = meta && typeof meta === "object" ? { ...meta } : {};
  const pr = { ...(m.pr ?? {}) };
  pr.carry = [...(Array.isArray(pr.carry) ? pr.carry : []), rec];
  m.pr = pr;
  return m;
}

// ---- multi-PR legs (BR#3659: card-per-PR is a LIE for multi-PR parents) ----

/** One leg of a queued card: one cited PR with its accepted-at head.
 *  `meta.prs` holds every leg; `meta.pr` stays the FIRST leg (backward
 *  compat — the executor, the derived-queue filter and older readers read
 *  meta.pr). A leg carries its own carry chain (machine-clean head moves
 *  carry per leg, never across legs). */
export type TrainLeg = {
  repo: string;
  number: number;
  head_sha_at_acceptance?: string;
  base?: string;
  carry?: CarryRecord[];
};

/** The card's legs: meta.prs when stamped (multi-PR), else the legacy
 *  meta.pr single leg. Empty when neither exists. */
export function trainLegs(meta: any): TrainLeg[] {
  if (Array.isArray(meta?.prs) && meta.prs.length) {
    return meta.prs.map((l: any) => ({
      repo: String(l?.repo ?? meta?.pr?.repo ?? ""),
      number: Number(l?.number ?? 0),
      ...(l?.head_sha_at_acceptance !== undefined ? { head_sha_at_acceptance: String(l.head_sha_at_acceptance) } : {}),
      ...(l?.base !== undefined ? { base: String(l.base) } : {}),
      ...(Array.isArray(l?.carry) ? { carry: l.carry } : {}),
    }));
  }
  if (meta?.pr && typeof meta.pr === "object") {
    return [{
      repo: String(meta.pr.repo ?? ""),
      number: Number(meta.pr.number ?? 0),
      ...(meta.pr.head_sha_at_acceptance !== undefined ? { head_sha_at_acceptance: String(meta.pr.head_sha_at_acceptance) } : {}),
      ...(meta.pr.base !== undefined ? { base: String(meta.pr.base) } : {}),
      ...(Array.isArray(meta.pr.carry) ? { carry: meta.pr.carry } : {}),
    }];
  }
  return [];
}

/** Is this leg landed? The per-leg map (meta.merge_train.legs — multi-PR)
 *  or the legacy card-level landed stamp (pre-3659: state "landed" is only
 *  ever written when the whole card closed). */
export function trainLegLanded(meta: any, leg: TrainLeg): boolean {
  const mt = meta?.merge_train ?? {};
  if (mt.legs && mt.legs[String(leg.number)]?.state === "landed") return true;
  return mt.state === "landed";
}

/** The legs that still keep the card queued — optionally scoped to one
 *  repo (a card rides exactly the lanes that own one of its UNLANDED legs). */
export function trainLegsRemaining(meta: any, repo?: string): TrainLeg[] {
  return trainLegs(meta).filter((l) => (!repo || l.repo === repo) && !trainLegLanded(meta, l));
}

/** Does this queued card ride the given repo's lane? True when at least one
 *  of its UNLANDED legs belongs to that repo. (BR#3659: replaces the old
 *  lane filter that read meta.merge_train.repo — a field nothing ever set,
 *  so every queued card matched every lane.) */
export function trainCardMatchesLane(meta: any, repo: string): boolean {
  return trainLegsRemaining(meta, repo).length > 0;
}

/** Does an accepted verdict cover this LEG's head? Same law as
 *  verdictCoversHead, reading the leg's own stamp + carry chain — a
 *  multi-PR card's legs verify independently (BR#3659). */
export function verdictCoversHeadLeg(leg: TrainLeg | undefined, headSha: string): boolean {
  if (!leg) return false;
  return headCoveredBy(
    String(leg.head_sha_at_acceptance ?? "").toLowerCase(),
    leg.carry,
    String(headSha ?? "").toLowerCase(),
  );
}

/** Append a carry link to ONE leg's chain (pure; the caller persists meta).
 *  The matching meta.prs entry AND meta.pr (when it is the same PR — legacy
 *  readers read meta.pr) both move, so no reader sees a half-carry. */
export function carryAppendLeg(meta: any, number: number, rec: CarryRecord): any {
  const m = meta && typeof meta === "object" ? { ...meta } : {};
  const withCarry = (leg: any) => ({ ...leg, carry: [...(Array.isArray(leg.carry) ? leg.carry : []), rec] });
  if (Array.isArray(m.prs)) m.prs = m.prs.map((l: any) => (Number(l?.number) === number ? withCarry(l) : l));
  if (Number(m.pr?.number) === number) m.pr = withCarry(m.pr);
  return m;
}

/** The blocked reason while a queued card waits on its remaining legs —
 *  honest naming (BR#3659 defect 1: the multi-PR card that closed after
 *  leg 1 lied "done" instead of saying what is still out). */
export function trainQueueRemainingReason(meta: any): string {
  const remaining = trainLegsRemaining(meta);
  return `merge-train: queued — waiting on ${remaining.length} leg(s): ${remaining.map((l) => `${l.repo || "?"}#${l.number}`).join(", ")}`;
}

// ---- awaiting-CI phase (BR#3516 §2) ----

/** The unknown-past bound: ~3× typical CI wall-clock ⇒ fail-closed stop
 *  (never merge on unknown). Lanes override typical via meta.lane. */
export const TRAIN_CI_BOUND_MULTIPLIER = 3;
export const TRAIN_CI_TYPICAL_MINUTES = 20;

export type RequiredRunsVerdict = {
  verdict: "green" | "red" | "pending";
  /** required workflow that settled red on the merge commit — the stop-the-line culprit */
  failing: MainRedCheck[];
  /** required workflow never seen on the merge commit (CI not started) */
  missing: string[];
  /** required workflow still running / inconclusive */
  pending: string[];
  /** wall-clock bound exceeded while still pending — the caller fail-closes */
  bound_exceeded: boolean;
};

/** Classify the executor-fed check runs on the merge commit against the
 *  lane's REQUIRED workflows. Same judge rule as classifyMainCheckRuns
 *  (newest non-cancelled run per name; cancelled says nothing). Required is
 *  lane config — an unconfigured lane has no required set, so green is
 *  vacuous and the phase passes through. */
export function classifyRequiredRuns(
  runs: MainCheckRun[],
  required: string[],
  opts: { merged_at: number; now: number; typical_ms?: number },
): RequiredRunsVerdict {
  const byName = new Map<string, MainCheckRun[]>();
  for (const r of runs) {
    const list = byName.get(r.name ?? "") ?? [];
    list.push(r);
    byName.set(r.name ?? "", list);
  }
  const failing: MainRedCheck[] = [];
  const missing: string[] = [];
  const pending: string[] = [];
  for (const name of required) {
    const list = byName.get(name) ?? [];
    const judge = [...list].sort((a, b) => (b.id ?? 0) - (a.id ?? 0)).find((r) => r.conclusion !== "cancelled");
    if (!judge || judge.conclusion == null) {
      (list.length ? pending : missing).push(name);
      continue;
    }
    if (MAIN_RED_CONCLUSIONS.has(judge.conclusion)) {
      failing.push({ name, conclusion: judge.conclusion, url: judge.html_url ?? "" });
    } else if (!["success", "skipped", "neutral"].includes(judge.conclusion)) {
      pending.push(name);
    }
  }
  const typical = opts.typical_ms ?? TRAIN_CI_TYPICAL_MINUTES * 60_000;
  const bound_exceeded = opts.now - opts.merged_at > TRAIN_CI_BOUND_MULTIPLIER * typical;
  if (failing.length) return { verdict: "red", failing, missing, pending, bound_exceeded };
  if (!pending.length && !missing.length) return { verdict: "green", failing, missing, pending, bound_exceeded };
  return { verdict: "pending", failing, missing, pending, bound_exceeded };
}

// ---- the train's admission gate (executor-side, fail-closed) ----

export type TrainGateInput = {
  prNumber: number;
  /** the LIVE head sha from GitHub (executor-fetched, never the card's claim) */
  headSha: string;
  /** the linked impl card's meta (carries meta.pr — the stamp + carry chain) */
  cardMeta: any;
  cardStatus: string | null;
  /** classifyMainCheckRuns verdict on the BASE (main) HEAD */
  baseVerdict: "green" | "red" | "unsettled" | "empty";
  /** GitHub pull API mergeable; null while GitHub computes — wait this tick */
  mergeable: boolean | null;
  mergeStateStatus: string | null;
  /** commits of the PR: REST verification (verified=true = signed+valid) */
  commits: { sha: string; verified: boolean }[];
  headChecks: MainCheckRun[];
  /** BR#3659: which leg of the card's PR list this gate drives (1-based
   *  position in meta.prs) — the gate checks THAT leg's stamp, and the
   *  merge receipt cites the leg, not just the PR. */
  legNumber?: number;
};

// ---- the executor's fact boundary (BR#3714) ----

/** gh's `mergeable` is the GraphQL enum STRING "MERGEABLE"|"CONFLICTING"|
 *  "UNKNOWN" (null while GitHub computes) — but the 5c gate compares
 *  `mergeable !== true` (boolean). Fed raw, the string satisfies neither
 *  `true` nor `null`: every gated candidate bounced "unmergeable —
 *  CONFLICTING" and the train could never merge anything (BR#3714, latent
 *  since BR#3517 — the unit tests passed because they fed booleans).
 *  REST-shaped booleans pass through; anything else is null (wait this
 *  tick, never a bounce). */
export function normalizeGhMergeable(v: unknown): boolean | null {
  if (v === true) return true;
  if (v === false) return false;
  if (v === "MERGEABLE") return true;
  if (v === "CONFLICTING") return false;
  return null; // "UNKNOWN", null, undefined, anything else
}

/** gh's `mergeStateStatus` is UPPERCASE ("CLEAN"|"UNSTABLE"|"BEHIND"|…)
 *  while the gate compares lowercase — normalize at the same boundary
 *  (BR#3714), so a real state is named honestly instead of every PR
 *  reading as unmergeable. */
export function normalizeGhMergeState(v: unknown): string | null {
  return typeof v === "string" ? v.toLowerCase() : null;
}

/** The per-candidate gate the executor runs before merging (BR#3516 §2),
 *  each leg fail-closed: verdict coverage (stamp or contiguous carry) ·
 *  base-green · mergeable=MERGEABLE with bound-wait through null · every
 *  commit GitHub-verified · head checks green (BR#2267 externals exempt).
 *  Composes the standing decideMergeAction; the train layer adds the
 *  carry law the sweep never had. BR#3659: coverage is judged per LEG —
 *  a multi-PR card's legs verify independently, and an uncovered leg
 *  bounces naming ITS stamp. */
export function decideTrainGate(i: TrainGateInput): MergeAction {
  if (i.cardStatus === "superseded")
    return { kind: "close_superseded", reason: "linked card is superseded — closing PR without review" };
  if (i.cardStatus === "done")
    return { kind: "skip", reason: "linked card already done — nothing to merge under it" };
  const legs = trainLegs(i.cardMeta);
  const legNumber = Math.max(1, Math.floor(i.legNumber ?? 1));
  const leg = legs.length ? legs[legNumber - 1] : undefined;
  if (!verdictCoversHeadLeg(leg, i.headSha)) {
    const stamped = String(leg?.head_sha_at_acceptance ?? "").slice(0, 9) || "(no stamp)";
    return {
      kind: "bounce",
      defect: `PR #${i.prNumber} live head ${i.headSha.slice(0, 9)} is not covered by the accepted verdict (leg ${legNumber} stamped ${stamped}, no contiguous carry chain) — head moved past the verdict without a machine-clean update; re-verify at the new head`,
    };
  }
  const gate = decideMergeAction({
    prNumber: i.prNumber,
    prTitle: "",
    headSha: i.headSha,
    baseVerdict: i.baseVerdict,
    mergeable: i.mergeable,
    mergeStateStatus: i.mergeStateStatus,
    commits: i.commits,
    headChecks: i.headChecks,
    cardStatus: i.cardStatus,
    verifyAcceptedOnHead: true,
    verifyAcceptedAny: true,
  });
  if (gate.kind === "merge")
    return {
      kind: "merge",
      receipt: `PR #${i.prNumber} merged by the serialized merge train (BR#3516) leg ${legNumber}/${legs.length || 1}: head ${i.headSha.slice(0, 9)} — verdict covers head (stamp/carry), 5c gate pass (mergeable, clean, ${i.commits.length} verified commits), base green, head checks green`,
    };
  return gate;
}

// ---- train event copy (titles/briefs — the ask contract: ≤240, ends "?") ----

/** train:bounced fix-up brief: the conflict files ride in, the verdict is
 *  INVALID at the new head, re-verify then re-queue at the back. */
export function trainBounceBrief(input: {
  prNumber: number;
  repo: string;
  headSha: string | null;
  conflictFiles: string[];
  verdictId: string | null;
}): string {
  const files = input.conflictFiles.length
    ? input.conflictFiles.map((f) => `- \`${f}\``).join("\n")
    : "- (no file list supplied — run the trial rebase locally to enumerate)";
  return [
    `Merge-train bounce: PR #${input.prNumber} (${input.repo}) conflicts with its base${input.headSha ? ` at head ${input.headSha.slice(0, 9)}` : ""}.`,
    ``,
    `**Conflicting files:**`,
    files,
    ``,
    `**Law (BR#3516 §5):** conflict resolution is authored code ⇒ the prior verdict${input.verdictId ? ` (${input.verdictId})` : ""} is INVALID at the new head — machine-clean carries, human-resolved invalidates. Resolve the conflict, push, re-enter review; the train re-queues at the BACK once a fresh verify accepts the new head.`,
  ].join("\n");
}

/** BR#4068 starvation law — the standing human-review ask for a bounced
 *  card. Deterministic per (card, PR): re-bounces of the same leg while the
 *  ask is open dedupe (identical-open-ask guard); an ANSWERED ask re-posts
 *  fresh, because a new head move past the verdict is a NEW live leg. The
 *  title carries the For Me phrasing so the band reads the leg's state
 *  ("review requested — one click from landed"). ≤240 chars, ends "?" —
 *  the ask contract. */
export function trainReviewAskTitle(lane: { repo: string }, prNumber: number, taskId: string): string {
  return `Review requested on ${lane.repo}#${prNumber} (${taskId}) after a merge-train bounce — one click from landed?`;
}

/** The review ask's details: what bounced, why the human leg lapsed (a push
 *  dismisses the stale GitHub review — GitHub law), and what the live leg
 *  is. The refresh story rides here too: the ask re-files dedupe-safe on
 *  every head move past the accepted verdict until the card re-enters the
 *  train. */
export function trainReviewAskDetails(input: { repo: string; prNumber: number; taskId: string; headSha: string | null; conflictFiles: string[] }): string {
  const files = input.conflictFiles.length
    ? input.conflictFiles.map((f) => `- \`${f}\``).join("\n")
    : "- (no file list supplied — the executor enumerates them on the trial rebase)";
  return [
    `The merge train bounced ${input.taskId}: PR ${input.repo}#${input.prNumber} no longer merges cleanly with its base${input.headSha ? ` (head ${input.headSha.slice(0, 9)})` : ""}.`,
    ``,
    `**Conflicting files:**`,
    files,
    ``,
    `**Why this reaches you:** the push that moved the head past the accepted verdict dismissed the stale GitHub review, so the human review leg silently lapsed. The card is verified once and one mechanical leg (rebase) plus this review away from landing — it now rides priority 0 so it cannot starve (BR#4068).`,
    ``,
    `This ask is the live leg. It re-files (deduped) on every further head move until the card re-enters the train; answering it retires it.`,
    `PR: https://github.com/${input.repo}/pull/${input.prNumber}`,
  ].join("\n");
}

/** Deterministic stop-the-line ask title (ONE per red episode — the sha makes
 *  it unique; askCreate's identical-open-ask guard dedupes). ≤240 chars,
 *  ends "?" — the ask contract. */
export function trainStopAskTitle(lane: { repo: string; base: string }, sha: string, failing: string[]): string {
  const prefix = `MERGE TRAIN STOP THE LINE: ${lane.repo}@${lane.base} commit ${sha.slice(0, 9)} RED (`;
  const suffix = `) — merges halted until green. Acknowledge?`;
  const budget = 240 - prefix.length - suffix.length;
  let names = failing.join(", ");
  if (names.length > budget) names = names.slice(0, Math.max(0, budget - 1)).trimEnd() + "…";
  return prefix + names + suffix;
}

/** The machine-proxy close note for train:landed — cites the merge commit
 *  (mergeCommit non-null) and main green, per the done-when's machine proxy.
 *  BR#3659: a multi-PR card's FINAL close cites EVERY leg's merge commit. */
export function trainLandedCloseNote(input: { repo: string; prNumber: number; mergeSha: string; gateway: string; greenRunUrl?: string | null; legs?: { repo: string; number: number; mergeSha: string }[] }): string {
  const legList = (input.legs ?? []).filter((l) => l.number > 0);
  const merged =
    legList.length > 1
      ? `all ${legList.length} queued PRs merged — ${legList
          .map((l) => `[#${l.number}](https://github.com/${l.repo || input.repo}/pull/${l.number}) as ${l.mergeSha.slice(0, 9)}`)
          .join(", ")}`
      : `PR [#${input.prNumber}](https://github.com/${input.repo}/pull/${input.prNumber}) merged as ${input.mergeSha.slice(0, 9)}`;
  return [
    `landed via the serialized merge train (BR#3516) — ${merged} by gateway ${input.gateway}; machine proxy held: mergeCommit non-null AND required main workflows green${input.greenRunUrl ? ` (${input.greenRunUrl})` : ""}.`,
    `merge commit: https://github.com/${input.repo}/commit/${input.mergeSha}`,
  ].join("\n");
}

/** The verify template's accept instruction — the head sha the verifier must
 *  record in the close note so the hub can stamp head_sha_at_acceptance
 *  without any hub-side GitHub call. The lookahead is punctuation-tolerant:
 *  "head <sha>;" / "head <sha>)." all terminate the stamp (BR#3659 parser). */
export const TRAIN_HEAD_STAMP_RE = /(?:^|\s)head[=:\s]+([0-9a-f]{7,40})(?=[\s;.,)]|$)/i;
const TRAIN_HEAD_STAMP_RE_G = /(?:^|\s)head[=:\s]+([0-9a-f]{7,40})(?=[\s;.,)]|$)/gi;

/** Every PR URL in a verify close note (BR#3659: a multi-PR parent cites one
 *  URL per leg — the hub stamps ALL of them, not just the first). */
export const TRAIN_PR_URL_RE = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/g;

export type TrainNoteLeg = { repo: string; number: number; head_sha_at_acceptance?: string };

/** Parse a verify close note into PR legs. Single-PR notes keep the
 *  pre-3659 binding exactly: the note's FIRST `head <sha>` pairs with its
 *  one /pull/ URL, wherever each sits. Multi-PR notes (BR#3659) pair by
 *  ADJACENCY, line by line, separator-aware: a head binds to the PR it
 *  immediately follows ("PR n head X" — the documented convention), else to
 *  the PR it immediately precedes ("head X — PR n"); adjacent means
 *  neighbouring tokens on the line with no clause break between them (`;`
 *  or a newline separates — a head after ";" is the NEXT clause's), so
 *  packed single-line notes never cross-pair ("PR 1 head A; PR 2 head B"
 *  and "head A — PR 1; head B — PR 2" both bind each PR its own head), and
 *  a stray head is never stolen across an intervening PR. A PR with no head
 *  on its line takes the first head BELOW it before the next PR (the
 *  "- PR n\n  head <sha>" list layout). Anything unpaired stays unbound —
 *  the queue arm fail-closes on it. Never a silent cross-pairing. */
export function trainParseNoteLegs(text: string): TrainNoteLeg[] {
  const t = String(text ?? "");
  const prs: { repo: string; number: number; index: number; end: number }[] = [];
  for (const m of t.matchAll(TRAIN_PR_URL_RE))
    prs.push({ repo: `${m[1]}/${m[2]}`, number: Number(m[3]), index: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  if (!prs.length) return [];
  const heads: { sha: string; index: number; end: number; used: boolean }[] = [];
  for (const m of t.matchAll(TRAIN_HEAD_STAMP_RE_G))
    heads.push({ sha: m[1], index: m.index ?? 0, end: (m.index ?? 0) + m[0].length, used: false });
  const paired: (number | null)[] = prs.map(() => null); // pr i → head j
  if (prs.length === 1) paired[0] = heads.length ? 0 : null;
  else {
    // line index for every char position (close notes are small; linear is fine)
    const lineStarts: number[] = [];
    for (let i = 0; i < t.length; i++) if (i === 0 || t[i - 1] === "\n") lineStarts.push(i);
    const lineOf = (idx: number): number => {
      let line = 0;
      for (const s of lineStarts) { if (s <= idx) line++; else break; }
      return line - 1;
    };
    // pass 1 — same-line ADJACENCY pairing, separator-aware: a head binds to
    // the PR it immediately follows ("PR n head X" — the documented
    // convention), else to the PR it immediately precedes ("head X — PR n").
    // "Adjacent" = neighbouring tokens on the line AND the between-text does
    // not start a new clause (`;` or a newline separates — a head after ";"
    // belongs to the NEXT clause's PR, never the previous one), so packed
    // single-line notes ("PR 11 head B; PR 12 head C") and dash-led notes
    // ("head B — PR 11; head C — PR 12") both bind each PR to its own head,
    // and "PR 11; PR 12 head C" leaves PR 11 unbound rather than stealing a
    // head across the intervening PR.
    type Tok = { kind: "pr" | "head"; i: number; index: number; end: number };
    const lines = new Map<number, Tok[]>();
    prs.forEach((p, pi) => {
      const l = lineOf(p.index);
      lines.set(l, [...(lines.get(l) ?? []), { kind: "pr", i: pi, index: p.index, end: p.end }]);
    });
    heads.forEach((h, hi) => {
      const l = lineOf(h.index);
      lines.set(l, [...(lines.get(l) ?? []), { kind: "head", i: hi, index: h.index, end: h.end }]);
    });
    for (const seq of lines.values()) {
      seq.sort((a, b) => a.index - b.index);
      const joins = (k: number) => k >= 0 && k + 1 < seq.length && !/[;\n]/.test(t.slice(seq[k].end, seq[k + 1].index));
      // pass 1a — PR → the head it immediately precedes
      for (let k = 0; k + 1 < seq.length; k++) {
        const a = seq[k], b = seq[k + 1];
        if (joins(k) && a.kind === "pr" && b.kind === "head" && paired[a.i] === null && !heads[b.i].used) {
          paired[a.i] = b.i; heads[b.i].used = true;
        }
      }
      // pass 1b — head → the PR it immediately precedes
      for (let k = 0; k + 1 < seq.length; k++) {
        const a = seq[k], b = seq[k + 1];
        if (joins(k) && a.kind === "head" && b.kind === "pr" && paired[b.i] === null && !heads[a.i].used) {
          paired[b.i] = a.i; heads[a.i].used = true;
        }
      }
    }
    // pass 2 — a PR with no head on its line takes the first unused head
    // BELOW it, before the next PR (the "- PR n\n  head <sha>" list layout)
    for (let pi = 0; pi < prs.length; pi++) {
      if (paired[pi] !== null) continue;
      const nextPrIdx = prs.slice(pi + 1).find((q) => q.index >= 0)?.index ?? Infinity;
      const below = heads.find((h) => !h.used && h.index > prs[pi].index && h.index < nextPrIdx);
      if (below) { paired[pi] = heads.indexOf(below); below.used = true; }
    }
  }
  return prs.map((p, i) => ({
    repo: p.repo,
    number: p.number,
    ...(paired[i] !== null ? { head_sha_at_acceptance: heads[paired[i] as number].sha } : {}),
  }));
}
