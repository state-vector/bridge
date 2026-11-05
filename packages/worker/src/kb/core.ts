/**
 * KB core — pure logic, no I/O. Unit-tested in test/kb-core.test.ts.
 *
 * Artefact types, their lifecycles, the typed-relationship vocabulary, and the
 * validation rules. The DO (kb/do.ts) and the MCP tool schemas (mcp.ts) both
 * defer to this module — one source of truth for what transitions and links
 * are legal.
 */

import type { AwaitEvent } from "./closure";
import { DeployCoverageStateSchema, isAwaitingMerge, mergePhaseOf, mergeCompletesTask } from "@bridge/contracts";
import type {
  BaseRedPhase,
  BaseRedResolution,
  DeployCoveragePhase,
  DeployCoverageState,
  DeployObservation,
  LaneOperationalState,
  TrainEntryClass,
  TrainFixCard,
} from "@bridge/contracts";

export type {
  BaseRedPhase,
  BaseRedResolution,
  DeployCoveragePhase,
  DeployCoverageState,
  LaneOperationalState,
  TrainEntryClass,
  TrainFixCard,
};

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

/** Standing merge-lane card (BR#5151): a meta.lane card or anything tagged
 *  "infrastructure" IS a live subsystem. Reconcile never closes one, verify
 *  duties never parent onto one, and the settle path (train:merged) is the
 *  only writer that may touch it. Pure — callers parse tags defensively via
 *  parseTags before handing them here. */
export function isStandingCard(meta: unknown, tags: unknown): boolean {
  const m = (meta ?? {}) as Record<string, unknown>;
  if (m.lane) return true;
  if (m.pr || (Array.isArray(m.prs) && m.prs.length > 0) || m.merge_train) return false;
  const t = Array.isArray(tags) ? tags.map(String) : [];
  return t.includes("infrastructure");
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
  // blocked → superseded (BR#3913, per accepted BR#2508(a)): a parked card's
  // one drop edge. Guarded at the law table (machine.ts supersede-authority):
  // an answered ask offering SUPERSEDE (the answer is the authorisation,
  // BR#3578 dispatch) or a web/human action may take it — a bare agent
  // session never can. todo/done stay closed (BR#2508: done is a reviewed
  // terminal; a drop never rides the churn-counted release path).
  task: { todo: ["in_progress", "blocked"], in_progress: ["in_review", "done", "blocked", "todo"], in_review: ["done", "in_progress", "blocked"], blocked: ["in_progress", "todo", "superseded"] },
  // questions are answered, never claimed: todo → done (answer) or superseded (closed by ADR)
  question: { todo: ["done", "superseded"] },
  progress: {},
  agent: {},
};

// ---------- question human-claim hold (BR#3911) ----------

/** A named human's transient hold on an open question: "I am picking this up —
 *  stop nudging/spawning." Claim ≠ answer (protocol 6b stands: the question
 *  still closes via the author's ADR); the hold just dismisses the question
 *  from the agent surfaces for a short window and self-heals on a no-show. */
export interface HumanClaim {
  by: string;
  ts: number;
  expires_ts: number;
}

/** Default hold window (minutes) — the BR#3911 spec value. The hub reads the
 *  `question_claim_minutes` setting (1-60) and falls back to this. */
export const QUESTION_CLAIM_MINUTES = 10;

/** The live claim on an open question, or null — pure so every surface (sweep,
 *  inbox, orient, UI) agrees on what "in hand" means. An expired stamp reads as
 *  no claim: the sweep clears it for the record, but nobody waits on it. */
export function humanClaimLive(meta: any, now: number): HumanClaim | null {
  const c = meta?.human_claimed;
  if (!c || typeof c.expires_ts !== "number" || c.expires_ts <= now) return null;
  return { by: String(c.by ?? ""), ts: Number(c.ts ?? now), expires_ts: c.expires_ts };
}

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

/**
 * BR#4262 identity rendering law — the PRINCIPAL is an anchor, never a
 * credential: it vends with its own `dev_` namespace so it can never be
 * mistaken for a `bkw_` auth token (the 2026-10-28/29 incident was a
 * token-shaped principal rendered into an owner column). Same entropy as
 * generateAuthToken (24 CSPRNG bytes hex); the prefix is the namespace, not
 * a workspace. generateAuthToken stays secrets-only; existing principals are
 * NOT migrated (re-shaping anchors breaks matching).
 */
export function generatePrincipalId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `dev_${hex}`;
}

/**
 * BR#4262 namespace separation — labels must never impersonate the credential
 * (`bkw_…`) or principal (`dev_…`) namespaces. A token-shaped label rendered
 * in an owner column is indistinguishable from a leaked secret; the incident
 * row (`bkw_9938…` as a LABEL) existed only because the 64-char cap first
 * admitted the paste. Enforced at every label door (token.rename, pair
 * approve, agentProvision, tokenMint).
 */
export function assertHumanLabel(label: string): void {
  if (/^(bkw|dev)_/.test(label))
    throw new Error(`label '${label}' is rejected: the 'bkw_' / 'dev_' prefixes are reserved namespaces (auth tokens / principals) — labels must never impersonate credentials (BR#4262)`);
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
 * The reap decision for one auth_tokens row — roster hygiene (BR#4684,
 * train-defence L0.5). Pure and fixture-testable like graceActive: the
 * alarm sweep pre-filters candidates in SQL and re-judges each row here.
 *   - "never_seen": provisioned past the cutoff with zero authentications —
 *     registration debris of any class (pairing churn minted
 *     `<hostname>/<variant>` labels nobody ever authenticated as);
 *   - "gateway_stale": gateway-class infrastructure with no auth signal
 *     past the cutoff — the roster's dead-machine half;
 *   - "keep": everything else — once-seen agent identities keep their board
 *     history regardless of silence, fresh rows are not yet the sweep's
 *     business, and `_`-prefixed system namespaces are plumbing, not roster.
 * A row of unknown provenance (never seen, no created_ts) keeps — the reap
 * archives, it never guesses.
 */
export function rosterReapVerdict(
  row: { label: unknown; tags: unknown; created_ts?: number | null; last_seen_ts?: number | null },
  cutoff: number,
): "never_seen" | "gateway_stale" | "keep" {
  if (String(row.label ?? "").startsWith("_")) return "keep";
  const seen = Number(row.last_seen_ts ?? 0);
  const created = Number(row.created_ts ?? 0);
  if (seen) return seen < cutoff && tagsSayGateway(row.tags) ? "gateway_stale" : "keep";
  return created > 0 && created < cutoff ? "never_seen" : "keep";
}

/**
 * The roster reap's pacing decision (BR#4684): `roster_reap_hours` gates the
 * sweep leg off the 60s alarm tick — 0 explicitly disables, garbage falls
 * back to the 6h default (an explicit 0 must never fold into the fallback:
 * `parseInt(x) || 6` would), the window clamps to a week. Pure like the
 * verdict so the disable knob is fixture-locked.
 */
export function rosterReapPace(hoursRaw: unknown, lastTs: unknown, now: number): "disabled" | "skip" | "run" {
  const n = parseInt(String(hoursRaw ?? "").trim(), 10);
  const hours = Math.max(0, Math.min(168, Number.isFinite(n) ? n : 6));
  if (hours === 0) return "disabled";
  if (now - (Number(lastTs) || 0) < hours * 3_600_000) return "skip";
  return "run";
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
    `4b. DECLARE SILENCE before any quiet stretch >10m: short op still yours (build, CI wait) → log_progress {will, grace_minutes ≤ 60}. Long or handed-off op (re-index, deploy, background batch) → transition {to: "blocked", class: "subprocess", note, unblock_condition, budget_minutes ≤ 1440}. Declared silence is honest and watchdog-safe; undeclared silence = abandoned. Overrun your declared window and it trips as abandoned anyway. Verdict-duty cards (role:review / role:unblock) can NEVER take the blocked leg — declare their silence with log_progress {will, grace_minutes} only; if the duty cannot proceed, "cannot proceed" is itself the verdict: render it and close done (BR#4392).`,
    `4b. DECLARE SILENCE before any quiet stretch >10m: short op still yours (build, CI wait) → log_progress {will, grace_minutes ≤ 60}. Long or handed-off op (re-index, deploy, background batch) → transition {to: "blocked", class: "subprocess", note, unblock_condition, budget_minutes ≤ 1440}. Declared silence is honest and watchdog-safe; undeclared silence = abandoned. Overrun your declared window and it trips as abandoned anyway.`,
    `4c. RETRY LAW (BR#4403): a 5xx / infra_storage_fault is RETRYABLE — same transition, backoff, heartbeat while retrying. A SEMANTIC gate rejection (the error text names a rule: "gate: …", "requires …", "separation of duties", "open child", "malformed") is TERMINAL for that attempt — stop retrying immediately, read what it names, and either resolve the named precondition or take a lifecycle-legal edge. Retrying a gate-rejected transition cannot succeed, and every retry is an audited breach event.`,
    `5. Status is your responsibility: claim → in_progress immediately; finish → in_review with the PR link in the note; stuck → blocked with BOTH a reason and an unblock condition. in_review is NOT done: you stay owner, poll get_history {id} for the verdict — bounce = action the findings; done = released. Gates are enforced — unqualified todo is picked up only by role:analysis/role:review agents; done requires review acceptance. Don't route around them; qualify, review, resolve.`,
    `5b. SEPARATION OF DUTIES: analysis, impl, and review happen in different sessions — every agent can do all three, never in one session. A session that completed the analysis on a task cannot claim it for impl (the gate also auto-releases the parent if you try); a session that implemented cannot produce the review. Verification is a double-check by a fresh session: check the actual state (PR, findings) and cite receipts in the note — a review without receipts is rejected. If a gate rejects you, end the session and start a new one.`,
    `5c. VERIFY GATE — mergeability is a precondition, NOT a finding (2026-10-23 unsigned-PR incident). Verification agents: BEFORE any substance check, confirm the PR is mechanically mergeable — gh pr view --json mergeable,mergeStateStatus,reviewDecision AND every commit signature isValid=true. mergeable=false / CONFLICTING / any unsigned or NO_USER commit → STOP: zero substance checks, and bounce the parent to in_progress with the mechanical defect ("PR #N unmergeable — unsigned commits | conflicts | failing check X. Re-sign/rebase/resolve and re-push"). Never file a human ask for a mechanical defect, never report "verified, awaiting merge" for an unmergeable PR (false report — it has zero verified legs), and never treat "accept the unsigned commit" as an option (the ruleset forbids it by construction). The ONLY escalation to a human: a broken signing environment (key unavailable / NO_USER) — one ask describing the environment covers the whole class, never one per PR.`,
    `5d. ONE EXECUTOR PER TASK: every in_progress task is owned by exactly one session (orient exposes executor_session on open cards — check it before you touch a card). If your claim transition loses the claim race (rejected: another session holds in_progress), you are NOT the executor — do not execute the work anyway, do not contribute state changes "in parallel", stand down and end your run. Concurrent executor sessions doing the same legs are how duplicate PRs and double closes happen (the BR#3348 class); the hub audits a state-changing op by a non-holder while the holder is alive (duplicate_executor), and repeated audited breaches are scored as divergent work.`,
    `5e. INTERACTIVE CLAIM TAKEOVER (BR#6135): the card's owner agent, a human via the web, or an authenticated FULL-AGENT credential (BR#6436: your token's LIVE tags say full agent — gateway and cron credentials are excluded, and the class is never body-declared) may claim_takeover (or transition {to:"in_progress", takeover:true}) an in_progress task whose claim a dispatched runner holds — across owners, no ownership anchor required for a full-agent token: ONE atomic write flips the holder session to the taker, no pool pass, no race window. Authority is server-verified from your token (owner label/principal, the web plane, or full-agent credential tags) — never declared. Refused on verify/unblock duty cards (separation of duties is not transferable) and on cards holding a typed wait (train slot / await_event / bound ask). If your session WAS taken over: your next state change is gate-rejected with a stand-down order — checkpoint last_will via log_progress (still open to you: worktree, branch, done/next), push nothing, end your run; your WIP survives in your registered worktree. INTERACTIVE PAUSE LAW (the BR#6068 lesson): a session about to wait on the human must BIND AN ASK to the task (ask_agent, artefact_id) — an open ask pauses the watchdog; a bare silent pause is fair abandonment and the claim is fairly lost to the pool.`,
    `6. Blocked on a decision → ask_agent immediately, bound to your task (artefact_id). The ask pauses the watchdog; the answer auto-resumes you.`,
    `6b. QUESTIONS are tasks tagged 'question' — answered, not claimed. Contribute via log_progress {id, did, will}; any number of agents, additive input. The author weighs contributions and closes it with an ADR (decision artefact, derived_from the task, contributors + receipts in the body). Answers thin? the author adds steering with specifics and re-issues the task in todo. Humans are the final escalation — consensus among agents escalates to them for the last say.`,
    `6c. ASK QUALITY BAR — an ask must be answerable on plain reading. (a) If you recommend an option, put it FIRST in options and prefix it "(Recommended)" — the first button IS the recommendation. (b) Human-directed asks REQUIRE details: a self-contained brief (what this is about, current state, why it needs a human) that glosses every BR#/PR# reference in one clause — bare reference soup is rejected by the hub. (c) Split the fields: question ≤240 chars, details carries the full story, reason is the one-line WHY escalated. Never cram the narrative into reason or reference cards the reader hasn't read.`,
    `6d. REQUEST ROUTING: use route {kind:"executor_coordination",task_id:"BR#N"} to ask the current executor of work — the recipient follows claim changes. Use route {kind:"independent_review",task_id:"BR#N"} for review: Bridge schedules/reuses a fresh review agent, no human staffing question. Agent delivery failures return to the agent pool, never become human decisions merely because a recipient is offline. Human decisions use route {kind:"human_decision"}, to:"human", only for a specific choice/authority Bridge lacks. Write the complete question in plain English: explain the user-visible issue before task/commit evidence; each option names who acts and what happens. Answer coordination via answer_ask (even "No overlap"), never log_progress: progress is commentary, not an answer.`,
    `6e. EXPLICIT EFFECTS: human_decision requests require decision {kind:authority|information|preference,task_id,context,why_human,choices:[{label,executor:bridge|human,consequence,action:resume|hold|release}]}. Diagnostics are machine recovery work, not a human choice. Operational/post-deploy tasks declare meta.completion {kind:"execution",outcome}; prerequisite delivery only resumes them. Record actual execution_result {outcome,receipts}, submit to independent outcome review, and accept with review_result {kind:"accepted_execution",task_id,receipts}. Never mark prerequisite arrival as completed execution.`,
    `6f. RECOVERY EXECUTION: a task's meta.recovery_links identifies its cause-specific recovery journals. Use train_recovery_event with that repo/base/head_sha/cause, a unique event_id, and event {kind:"diagnosed",task_id,diagnosis,next}, then {kind:"attempt_started",task_id,attempt_id,attempt_kind:"repair"|"retry"|"verification",action,next} before the action and {kind:"attempt_finished",task_id,attempt_id,outcome:"failed"|"delivered"|"inconclusive",summary,receipts,next} after the real result. A denied/replayed retry is not authorization to execute again. Report structured did/next via log_progress; a heartbeat or stdout fragment is not a repair result. Code delivery only starts verification; never claim live recovery without the matched deployment evidence and acceptance bar.`,
    `7. Findings belong in Knowledge, not session memory. Open questions become question tasks; conclusions become decisions.`,
    `7b. DOCS RIDE WITH THE CHANGE: if your work alters user-visible behaviour (UI, config, protocol, gates), update README.md and packages/site/content.md in the same branch — the docs are the interface, stale docs are a defect.`,
    `8. Accepted decisions are settled. Steering constrains you. Supersede, never contradict.`,
    `9. Real progress or let go: if you cannot advance a claimed task this run, transition it → todo (retry) — that releases the claim so any matching agent can pick it up fresh. Squatting on untouched work starves the pool.`,
    `Runner-claimed cards: you cannot release to the pool — the runner identity holds the claim (releases are owner/web/human-only). Your rule-9 exits are done-with-findings, blocked with an unblock condition, or staying paused on a bound ask — a todo release will be rejected and audited. The owner may instead claim_takeover the card (rule 5e) — if that happens your next transition is refused with a stand-down order: checkpoint and exit.`,
    `DELEGATION: if you spawn subagents, copy the PROTOCOL CARD below verbatim to the top of each subagent's prompt.`,
`PROTOCOL CARD: 1. START: orient (session: "<unique-name>"). 2. CLAIM: transition {id, to: "in_progress", session} before coding. 3. HEARTBEAT: log_progress {id, did, will, session} every ≤10 min. 4. LONG OP: declare silence — grace_minutes, or subprocess-block with a budget (never on verify/unblock duties: they cannot block — grace_minutes only, and "cannot proceed" is itself the verdict: render it and close done). 5. UNCERTAIN: ask_agent first — recommended option first ("(Recommended)" prefix), details self-contained (rule 6c). Verdict duties ask the authority, not the identity — if the authority may be human, ask "human" at file time (BR#3942). 6. FINISH: PR, then transition {to: "in_review", note: "PR <link>"} — a Verify task auto-spawns into the pool; a fresh-session verifier closes or bounces. Verification is a double-check with receipts — mergeability first (2026-10-23 rule). 7. LOST CLAIM = STAND DOWN: if your in_progress transition loses the race, another session is the executor — you are not; end your run, never execute a task you don't own. 8. DECISIONS: a proposed decision collects agent feedback via its auto-spawned consensus round (orient: decisions_awaiting_consensus) — read it and contribute agree/disagree with reasons via log_progress on the round before the human decides. Contribution is expected, not exceptional; the round informs the human, it does not gate them. 9. RETRY LAW: only a 5xx / infra_storage_fault is retryable (same transition, backoff, heartbeat). A SEMANTIC gate rejection (the error text names a rule: "gate: …", "requires …", "separation of duties", "open child") is TERMINAL — never retry it; read what it names, resolve the named precondition or take a lifecycle-legal edge. Every retry of a gate-rejected transition is an audited breach event.`,
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

// ---------- decision consensus rounds ----------

/** Title prefix of the auto-spawned feedback round for a proposed decision. */
export const FEEDBACK_TITLE_PREFIX = "Feedback:";

export interface ConsensusTally {
  agree: number;
  disagree: number;
  /** contributions carrying neither a verdict (questions, context, caveats) */
  other: number;
  /** distinct contributors across all contributions */
  contributors: string[];
}

/**
 * Tally a decision's feedback round from its contributions (log_progress notes
 * on the round task). The convention the round invites: begin the note with
 * "agree" or "disagree" + reasons. Parsing is tolerant: any "disagree" wins
 * (dissent must always surface to the human), a negated agree ("don't agree")
 * counts as disagree too, an affirmative (agree/concur/endorse/support) counts
 * as agree, anything else is a neutral contribution. Contributors = distinct
 * actors. This is a signal for the human, not the truth — the reasons are
 * always readable on the round itself.
 */
export function tallyConsensus(entries: Array<{ actor?: unknown; note?: unknown }> | null | undefined): ConsensusTally {
  const tally: ConsensusTally = { agree: 0, disagree: 0, other: 0, contributors: [] };
  const people = new Set<string>();
  for (const e of entries ?? []) {
    const note = String(e?.note ?? "");
    if (!note.trim()) continue;
    const negated = /\b(?:not|no|can't|cannot|won't|don't|doesn't|didn't|never)\b[\w\s,'’-]{0,40}?\bagree/i.test(note);
    if (/\bdisagree/i.test(note) || negated) tally.disagree++;
    else if (/\b(?:agree|concur|endorse|support)/i.test(note)) tally.agree++;
    else tally.other++;
    if (e?.actor) people.add(String(e.actor));
  }
  tally.contributors = [...people];
  return tally;
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

/** BR#5377 F3 — the canonical human-readable verify-verdict title, minted by
 *  the hub from meta at create (do.ts). Verifier-authored titles are
 *  internals-dense (BOUNCE_NARROW classes, head SHAs, mergeCommit prose) and
 *  render as the card title on EVERY surface; the canonical form is plain
 *  language and says what the verdict does: "Verify verdict — ACCEPT — PR
 *  owner/repo#N → card BR#X". The authored title rides at the top of the
 *  body instead (nothing is lost). Tolerant: meta.pr arrives as a number, a
 *  /pull/ URL, or {repo, number}; meta.repo + numeric meta.pr also resolves.
 *  Returns null when neither a PR nor a target resolves — the authored title
 *  stands (a title that says nothing is worse than the jargon). Pure. */
export function canonicalVerdictTitle(meta: unknown): string | null {
  const m = (meta ?? {}) as Record<string, unknown>;
  const target = String(m.task ?? m.verify_target ?? "").trim();
  const rawVerdict = String(m.verdict ?? "").trim();
  if (!rawVerdict && !target) return null;
  // Same strict test the accept-side hook (do.ts) uses to route the effect —
  // the title describes what WILL happen to the target, never the jargon.
  const head = rawVerdict.toLowerCase() === "bounce" ? "BOUNCE" : "ACCEPT";
  let pr = "";
  const prv = m.pr;
  const repo = typeof m.repo === "string" ? m.repo.trim() : "";
  if (typeof prv === "number" && Number.isInteger(prv) && prv > 0) {
    pr = repo ? `${repo}#${prv}` : `#${prv}`;
  } else if (typeof prv === "string" && prv.trim()) {
    const u = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(prv.trim());
    if (u) pr = `${u[1]}/${u[2]}#${u[3]}`;
    else if (/^\d+$/.test(prv.trim())) pr = repo ? `${repo}#${prv.trim()}` : `#${prv.trim()}`;
  } else if (prv && typeof prv === "object") {
    const o = prv as { repo?: unknown; number?: unknown };
    if (typeof o.repo === "string" && o.repo.trim() && Number(o.number) > 0) pr = `${o.repo.trim()}#${Number(o.number)}`;
  }
  let title = `Verify verdict — ${head}`;
  if (pr) title += ` — PR ${pr}`;
  else if (target) title += ` — ${target}`;
  else return null;
  if (pr && target) title += ` → ${target}`;
  return title;
}

/** Human-facing banner for verify-verdict decisions, prepended to body_md at
 *  creation (do.ts). Verifiers file receipts-dense cards whose body never
 *  says what the verdict does or who applied it — BR#2453 taught us that.
 *  BR#5377 F4: verdicts are MACHINE verdicts now — they accept on filing
 *  (actor system:verifier) and the accept-side hook applies them to their
 *  target; the human is not a per-merge GO/NO-GO gate. The statement states
 *  machine-application reality (and the one remaining human leg: supersede).
 *  Pure: meta in, markdown out. */
export function verifyVerdictStatement(meta: unknown): string {
  const m = (meta ?? {}) as Record<string, unknown>;
  const target = String(m.task ?? m.verify_target ?? "").trim() || "the task";
  // Same strict test the accept-side hook (do.ts) uses to route the effect.
  const isBounce = String(m.verdict ?? "").toLowerCase() === "bounce";
  const session = String(m.session ?? "").trim();
  const effect = isBounce
    ? `bounced **${target}** back to \`in_progress\` with the findings`
    : `accepted **${target}** — impl work queues on the merge train (the train owns delivery); verify duties close done`;
  const checked = `the receipts below were checked live${session ? ` by session \`${session}\`` : ""}`;
  return [
    `> ⚖️ **Verify verdict — machine-applied** — *auto-added, not part of the verifier's receipts*`,
    `>`,
    `> This is a machine verdict (BR#5377): it accepted on filing (actor \`system:verifier\`) — no human GO/NO-GO step. The verdict ${effect}.`,
    `> - Doesn't hold? **Supersede** it (decisions panel) — superseding records why; the target re-enters the normal flow.`,
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
  /** BR#5517: stop-the-line episodes blamed on this agent's cards — the impl
   *  and verify sessions that executed the culprit card each eat one
   *  train_red incident per episode (dedupe by stop sha, capped in scoreAgent). */
  train_red: number;
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
  // BR#5517 train-red blame: a stop-the-line episode whose culprit card this
  // agent's sessions executed (impl or verify leg) costs each of those
  // sessions a penalty — the signal is computed hub-side with the receipts
  // already on the card, capped so one bad night cannot zero an agent.
  if (s.train_red > 0) {
    score -= Math.min(15, s.train_red * 5);
    hints.push(`${s.train_red} stop-the-line episode(s) were blamed on a card your sessions executed (impl/verify) — a train_red ding: fix the culprit card and the train_red signal stays until the episode is exonerated`);
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
  /** BR#5674 P1 (empty-is-loud): explains why verdict === "empty" */
  alarm?: string;
  /** BR#5883 (gate-consumed qualifier): set ONLY when the lane-scoped
   *  verdict is Green while the repo's own merge gate (`main-green gate`,
   *  scripts/main-green-gate.sh — it judges main's WHOLE tip, the exact
   *  classifyMainCheckRuns predicate) would judge that same tip non-green.
   *  The verdict stays Green (BR#5265's law: non-required reds never park
   *  the train); the qualifier is what the hub escalates at P1. Mirror of
   *  train_gate.rs CheckVerdict.gate. */
  gate?: { verdict: MainCheckVerdict["verdict"]; red: MainRedCheck[]; unsettled: string[] };
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
  if (!runs.length) return { verdict: "empty", red: [], unsettled: [], green: 0, alarm: "tip carries no check runs at all" };
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

/** BR#5265 Fix B + BR#5674 P1 (empty-is-loud) + BR#5883 (gate-consumed
 *  qualifier): TypeScript mirror of train_gate.rs classify_base_check_runs. */
export function classifyBaseCheckRuns(runs: MainCheckRun[], required: string[]): MainCheckVerdict {
  if (!runs.length) {
    return { verdict: "empty", red: [], unsettled: [], green: 0, alarm: "tip carries no check runs at all" };
  }
  if (!required.length) {
    return classifyMainCheckRuns(runs);
  }
  // BR#6142: a workflow-level `startup_failure` (e.g. "Deploy Dev") creates 0
  // job check-runs, so its name is the workflow name rather than the job names
  // in `required`. Include any non-exempt workflow whose newest non-cancelled
  // run is `startup_failure` in `scoped` so the base verdict immediately speaks
  // RED instead of Empty.
  const byNameAll = new Map<string, MainCheckRun[]>();
  for (const r of runs) {
    const n = r.name ?? "";
    const list = byNameAll.get(n) ?? [];
    list.push(r);
    byNameAll.set(n, list);
  }
  const startupFailedNames = new Set<string>();
  for (const [name, list] of byNameAll) {
    if (!name || isExemptCheckName(name)) continue;
    const judge = [...list].sort((a, b) => (b.id ?? 0) - (a.id ?? 0)).find((r) => r.conclusion !== "cancelled");
    if (judge?.conclusion === "startup_failure") {
      startupFailedNames.add(name);
    }
  }
  const scoped = runs.filter((r) => required.includes(r.name ?? "") || startupFailedNames.has(r.name ?? ""));
  const gateRuns = runs.filter((r) => !required.includes(r.name ?? "") && isBaseHealthGateName(r.name ?? ""));
  const gateVerdict = gateRuns.length ? classifyMainCheckRuns(gateRuns) : null;
  if (!scoped.length) {
    if (gateVerdict && gateVerdict.verdict === "red") {
      return gateVerdict;
    }
    return {
      verdict: "empty",
      red: [],
      unsettled: [],
      green: 0,
      alarm: `${runs.length} runs read, none matched required set — check names/pagination`,
    };
  }
  // Never mask a red base_state mid-burst: when the required-set read is not
  // itself fully green, a red base-health gate folds in — the verdict speaks
  // red instead of a mid-burst green.
  const res = classifyMainCheckRuns(scoped);
  if (gateVerdict && gateVerdict.verdict === "red" && !(res.verdict === "green" && res.green >= required.length)) {
    return {
      ...res,
      verdict: "red",
      red: [...res.red, ...gateVerdict.red],
    };
  }
  // BR#5883: a required-set GREEN no longer certifies a plain green when the
  // repo's own merge gate would judge the same tip non-green (the 2026-11-03
  // starve: `Deploy drift alarm` red on a merge-commit tip — the required
  // `main-green gate` run is vacuous there, BR#5847 — certified green while
  // every car's gate failed). Mirror of the train_gate.rs composition. The
  // two arms compose: the fold above speaks for mid-burst states; this
  // qualifier speaks for the fully-green lane read the fold deliberately
  // leaves untouched.
  if (res.verdict === "green") {
    const gate = classifyMainCheckRuns(runs);
    if (gate.verdict !== "green") {
      return { ...res, gate: { verdict: gate.verdict, red: gate.red, unsettled: gate.unsettled } };
    }
  }
  return res;
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
 *  insensitively, against the check NAME.
 *  BR#6001 (implements accepted BR#3177): 'superpositional' joins the list —
 *  the 'Superpositional' external check is posted by the superpositional-sync
 *  GitHub App, NOT a repo workflow, and a failing SP review pipeline (process
 *  error — e.g. the IndexingFailed/States.Timeout that held PRs #387/#390 out
 *  of the lane >60m) is a Superpositional quality issue, never a merge gate. */
export const MERGE_EXEMPT_CHECK_PATTERNS = [
  "workers builds",
  "workers-builds",
  "cloudflare pages",
  "cloudflare workers",
  "deploy preview",
  "codeql",
  "superpositional",
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
 *  classifyMainCheckRuns (newest non-cancelled run per check name wins, by
 *  highest id — so a re-run that succeeded supersedes an earlier failure of
 *  the same check), with exempt-external failures (BR#2267) pulled OUT of red
 *  and recorded as `external` — they are collected into the class ask, never
 *  bounce a PR. */
export function classifyHeadChecks(runs: MainCheckRun[]): HeadCheckVerdict {
  const byName = new Map<string, MainCheckRun[]>();
  for (const r of runs) {
    const name = r.name ?? "";
    const list = byName.get(name) ?? [];
    list.push(r);
    byName.set(name, list);
  }
  const red: MainRedCheck[] = [];
  const unsettled: string[] = [];
  const external: MainRedCheck[] = [];
  let green = 0;
  for (const [name, list] of byName) {
    const judge = [...list].sort((a, b) => (b.id ?? 0) - (a.id ?? 0)).find((r) => r.conclusion !== "cancelled");
    if (!judge) {
      if (!isExemptCheckName(name)) unsettled.push(`${name} (only cancelled runs)`);
      continue;
    }
    if (judge.conclusion == null) {
      if (isExemptCheckName(name)) continue; // exempt externals in flight say nothing
      unsettled.push(name);
      continue;
    }
    if (isExemptCheckName(name)) {
      if (MAIN_RED_CONCLUSIONS.has(judge.conclusion)) external.push({ name, conclusion: judge.conclusion, url: judge.html_url ?? "" });
      else if (judge.conclusion === "success" || judge.conclusion === "skipped" || judge.conclusion === "neutral") green += 1;
      continue;
    }
    if (MAIN_RED_CONCLUSIONS.has(judge.conclusion)) red.push({ name, conclusion: judge.conclusion, url: judge.html_url ?? "" });
    else if (judge.conclusion === "success" || judge.conclusion === "skipped" || judge.conclusion === "neutral") green += 1;
    else unsettled.push(name);
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

/** WHY a train bounce happened (BR#4066): the bounce brief's copy — and the
 *  next owner it names — follow the kind. Every bounce names its KIND; a
 *  brief that renders every bounce as "conflicts with its base" lies on a
 *  coverage bounce (no conflicts exist) and buries a gate defect. */
export type TrainBounceKind = "coverage" | "conflict" | "gate";

/** What the sweep should DO with one candidate. Mechanical defects bounce the
 *  card when it is in_review (returning to its author); otherwise they are a
 *  progress note — the sweep never steals a claim. */
export type MergeAction =
  | { kind: "merge"; receipt: string }
  | { kind: "close_superseded"; reason: string }
  | { kind: "bounce"; defect: string; bounceKind: TrainBounceKind }
  | { kind: "note"; reason: string }
  | { kind: "rerun_gate"; reason: string }
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
  // (1) mergeability is a precondition, NOT a finding (5c, 2026-10-23).
  //     BR#4685: GitHub computes mergeability ASYNC — an unanswered
  //     mergeStateStatus (null/UNKNOWN; typical right after a base merge)
  //     means no answer yet, and the `mergeable` field rides the same
  //     recomputation, so a false read beside an unanswered state is a stale
  //     read. Wait (the executor backoff-polls before this gate) — never a
  //     bounce, and never a merge on an unconfirmed state (the old
  //     null-state fall-through). The 2026-10-28 ledger is the receipt:
  //     PRs #279/#281 bounced 28× with merge_state_status:null.
  const state = typeof i.mergeStateStatus === "string" ? i.mergeStateStatus.trim().toLowerCase() : "";
  if (!state || state === "unknown")
    return { kind: "skip", reason: `PR #${i.prNumber} mergeStateStatus not yet computed (null/UNKNOWN) — GitHub is computing mergeability; poll, never a defect (BR#4685)` };
  if (i.mergeable !== true) {
    if (i.mergeable === null) return { kind: "skip", reason: "GitHub still computing mergeability — not yet, skip this tick" };
    return { kind: "bounce", defect: `PR #${i.prNumber} unmergeable — CONFLICTING against base. Rebase, resolve, re-push, re-enter the queue`, bounceKind: "conflict" };
  }
  if (state !== "clean" && state !== "unstable")
    return { kind: "bounce", defect: `PR #${i.prNumber} mergeStateStatus=${state} — not clean. Fix the named state (rebase/re-sign) and re-enter — the accepted BR verify verdict is the approval of record (BR#4633 L4.2); there is no GitHub re-approve leg`, bounceKind: "gate" };
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
      ? { kind: "bounce", defect: `PR #${i.prNumber} head check RED: ${names}. Fix or bounce to impl`, bounceKind: "gate" }
      : { kind: "note", reason: `PR #${i.prNumber} head check RED: ${names} — card not in_review, no bounce; the linked session owns it` };
  }
  if (head.verdict === "unsettled") return { kind: "skip", reason: `head checks unsettled (${head.unsettled.join(", ")}) — not yet, skip this tick` };
  // (5) verify lineage: an ACCEPTED verify verdict must cover THIS head.
  //     Head moved past an accepted verdict → coverage BOUNCE — for ANY card
  //     status (BR#5114 round 2, Ray ruling 2026-10-30: "if it can't merge,
  //     bounce it and move onto the next one"). The old in_review-only
  //     condition made a QUEUED card with a stale stamp Skip silently every
  //     tick — no event, no bounce, the lane frozen behind an invisible head
  //     (observed: superpositional@main, 64 minutes of ledger silence with a
  //     12-deep queue). Bouncing puts the card into the review pipeline and
  //     the lane moves on; a fresh verify re-queues it at the back.
  if (i.verifyAcceptedAny && !i.verifyAcceptedOnHead)
    return { kind: "bounce", defect: `PR #${i.prNumber} head ${short} moved past the accepted verify verdict — re-verify the new head (a mechanical rebase is content-preserving; fresh 5c only)`, bounceKind: "coverage" };
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
// Prose-card disposition ladder (BR#4416): when the proxy sweep finds a
// blocked card whose resume condition parses to no atoms (proxy_check
// no_atoms), the machine resolves what it can prove from the card's OWN
// machine state and asks a human ONLY for genuine ambiguity — never one ask
// per card. Mirrors the PR disposition law (decidePrDisposition, BR#3315)
// for the prose-park class. BR#4248 killed the generator (the churn-guard
// redirect now stamps typed time atoms); this ladder drains the legacy
// backlog and arms the population canary: after that deploy, prose parks
// are incidents, not inbox items.
//
// The legs come from CARD META (stamped by the machine at block/queue time:
// meta.pr / meta.prs / merge_train stamps / a bound ask / an open
// root_blocker), never from parsing the prose again — the prose already
// failed to parse (that is why we are here). Evaluations are board-local
// with ZERO GitHub calls (BR#3287: the provenance/train ledger is the merge
// proof; asks and card statuses are SQL reads).
// ---------------------------------------------------------------------------

/** A typed leg recovered from the card's machine state. */
export type ProseLeg =
  | { kind: "pr_merged"; repo: string; n: number }
  | { kind: "ask"; ask_id: string }
  | { kind: "br_done"; id: string }
  | { kind: "time"; until_ts: number };

/** Board-local verdict for one recovered leg — the receipt cites WHERE the
 *  fact came from (provenance row / artefact status / clock), never GitHub. */
export interface ProseLegVerdict {
  leg: ProseLeg;
  ok: boolean;
  receipt: string;
}

export type ProseDisposition =
  /** rung 1: the recovered leg already holds → auto-flip per the card's own
   *  promised exit (spawn the unblock duty with the receipt); NO ask. */
  | { kind: "flip"; leg: ProseLeg; receipt: string }
  /** rung 2: a typed leg is recoverable but not yet true → restore the typed
   *  await_event into meta.blocked; the normal typed-leg path owns the exit;
   *  NO ask. */
  | { kind: "restore"; leg: ProseLeg; await_event: AwaitEvent; receipt: string }
  /** rung 3: no machine state at all → release to todo with the churn
   *  context (the pool re-scopes, BR#3578 §3's own no-leg law); NO ask. */
  | { kind: "release"; reason: string }
  /** rung 4: genuine human ambiguity only → ONE ask per class per day. */
  | { kind: "escalate_class"; askClass: string; question: string; reason: string }
  /** already parked on a live bound ask (or today's class ask) — the answer
   *  owns the exit; not prose, not an ask. */
  | { kind: "waiting"; receipt: string };

export interface ProseDispositionInput {
  cardId: string;
  title: string;
  /** sweep epoch (ms) */
  now: number;
  /** recovered legs with their board-local verdicts, in the sweep's
   *  precedence order (ask > pr_merged > br_done > time). A bound ask IS a
   *  leg: open → not yet true (rung 2 restores it as typed {event:"ask"});
   *  answered → true (rung 1 flips). */
  legs: ProseLegVerdict[];
  /** the sweep may not release this card (runner/human-owned, or
   *  human-qualified scope): supersede-vs-continue is genuinely theirs */
  releaseRestricted: boolean;
  /** ts of the last class ask (settings prose_migration_<class>), or null */
  lastClassAskTs: number | null;
  /** the class-ask quiet window (ms; 24h = one ask per class per day) */
  classAskQuietMs: number;
}

/** The one rung-4 class today: a protected card with no machine state, where
 *  re-scoping overrides a human's earlier ruling. Key for the settings
 *  dedupe stamp: `prose_migration_<class>`. */
export const PROSE_CLASS_AMBIGUOUS = "ambiguous_re_scope";

/** The class-ask quiet window: ONE ask per class per day (the 5c one-per-
 *  class law at daily granularity). Also the population-alarm's dedupe
 *  window (one canary alarm per episode per day, never per card). */
export const PROSE_CLASS_QUIET_MS = 24 * 3_600_000;

/** ProseLeg → its grammar-valid AwaitEvent (total over the leg set — every
 *  variant maps into the closed AWAIT_GRAMMAR_DOC set by construction). */
export function proseLegAwaitEvent(leg: ProseLeg): AwaitEvent {
  switch (leg.kind) {
    case "pr_merged": return { event: "pr_merged", repo: leg.repo, n: leg.n };
    case "ask": return { event: "ask", ask_id: leg.ask_id };
    case "br_done": return { event: "br_done", id: leg.id };
    case "time": return { event: "time", until_ts: leg.until_ts };
  }
}

/** The prose-park decision table. Order is the law's: the conjunction of
 *  recovered legs (ALL must hold before any flip — the same conjunction law
 *  the atom path obeys) → restore the first not-true leg → release → the
 *  once-per-day class ask. Exactly one disposition per card per pass; every
 *  ask-shaped row is deduped. */
export function decideProseDisposition(i: ProseDispositionInput): ProseDisposition {
  // (1) condition provably true: every machine-stamped leg holds (zero legs
  //     never flips — vacuity guard). The exit fires per the card's own
  //     promise; the ask in the old factory never exists (the BR#4170 case:
  //     the PR sat MERGED while a human was asked to re-scope). An answered
  //     bound ask lands here too — the answer is the proof.
  if (i.legs.length > 0 && i.legs.every((l) => l.ok)) {
    const won = i.legs[0];
    return { kind: "flip", leg: won.leg, receipt: won.receipt };
  }

  // (2) a typed leg is recoverable but not (all) true: restore the first
  //     not-true leg in precedence order — the sweep re-types the park and
  //     the normal typed-leg path owns the exit from here. NO ask.
  const pending = i.legs.find((l) => !l.ok);
  if (pending)
    return { kind: "restore", leg: pending.leg, await_event: proseLegAwaitEvent(pending.leg), receipt: pending.receipt };

  // (3) no machine state at all: the churn guard's park is not a human
  //     decision — release to todo for re-scope (BR#3578 §3's no-leg law).
  //     NO ask. Restricted cards fall through to (4).
  if (!i.releaseRestricted)
    return {
      kind: "release",
      reason: "no machine leg anywhere in card state (no PR, no bound ask, no timer, no open root blocker) — released to the pool for re-scope per the BR#3578 no-leg law",
    };

  // (4) genuine human ambiguity (protected owner / human-qualified scope,
  //     no machine state): ONE ask per class per day — never one per card
  //     (the 5c one-per-class law). Within the quiet window: waiting.
  if (i.lastClassAskTs != null && i.now - i.lastClassAskTs < i.classAskQuietMs)
    return { kind: "waiting", receipt: "class ask already filed inside the quiet window — the answer owns the class" };
  return {
    kind: "escalate_class",
    askClass: PROSE_CLASS_AMBIGUOUS,
    question: proseClassAskTitle([i.cardId]),
    reason: `protected card (${i.cardId}) parked on pure prose with no machine leg — supersede-vs-continue is a human ruling; one class ask per day carries it`,
  };
}

/** Deterministic rung-4 class ask title: ≤240 chars, ends in "?" (the ask
 *  contract). The sweep files it for the WHOLE class found this pass and
 *  dedupes via askCreate's identical-open-ask guard + the
 *  prose_migration_<class> settings stamp. */
export function proseClassAskTitle(cardIds: string[]): string {
  const prefix = `Prose-parked cards need a human ruling (one ask for the whole class, at most daily): `;
  const suffix = ` — re-scope, release, or drop?`;
  const budget = 240 - prefix.length - suffix.length;
  let ids = cardIds.join(", ");
  if (ids.length > budget) ids = ids.slice(0, Math.max(0, budget - 1)).replace(/,?\s*\S*$/, "") + "…";
  return prefix + ids + suffix;
}

/** Deterministic population-alarm title (the canary, not an inbox): fires
 *  ONCE per episode at the alarm sink when prose parks exist after the
 *  BR#4248 deploy. ≤240 chars, ends in "?". */
export function proseAlarmAskTitle(cardSummaries: string[]): string {
  const prefix = `Prose-parked cards exist after the BR#4248 deploy (population canary): `;
  const suffix = ` — which writer minted them?`;
  const budget = 240 - prefix.length - suffix.length;
  let text = cardSummaries.join("; ");
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

// ---- BR#5385 mid-walk merged receipt ----
// The 2026-11-01 11:18Z incident: a lane ran TWO walkers (the hand-installed
// daemon units + the runner gateway's in-process train leg) under ONE actor
// (one gateway token), so the CAS read every peer release as "already mine".
// The peer released the lease MID-WALK and the winner's `merged` event died
// at the gate — a real landing lost its provenance, the batch aborted, and
// the lane ping-ponged (meta.currently null ⇒ release_if_idle legitimately
// releases). A merged event is a receipt of an already-done GitHub fact, not
// a lane write: the hub re-admits it from the LOST holder when the ledger
// proves the lease was lost mid-walk (within the TTL) to the same
// authenticated identity — "the signer is the recorded holder". Fail-closed
// everywhere else: a live holder on the lane, an actor that never held the
// lease, or a loss older than the TTL ⇒ the original gate error stands.

/** One lease-LOSS transition as the DO reads it from the ledger (BR#5385).
 *  `holder` is resolved per row shape: `train:lease_release` rows carry the
 *  releaser in `actor` (leaseDecide: only the holder releases);
 *  `lease_lapsed` / `train:lease_evicted` rows carry it in the data payload
 *  (the watch sweep / zombie eviction stamps). */
export type LeaseLossTransition = { ts: number; action: string; actor: string; holder: string | null };

export function leaseLossHolder(t: LeaseLossTransition): string | null {
  if (t.action === "train:lease_release") return t.actor || null; // only the holder releases (leaseDecide)
  if (t.action === "train:lease_evicted") return t.holder || null; // the zombie stamp carries the evicted holder
  if (t.action === "lease_lapsed") return t.holder || null; // the watch sweep carries the lapsed holder
  return null;
}

/** THE mid-walk receipt decision (BR#5385) — pure so the incident replay is
 *  unit-testable: the lane's last lease-loss transition + the presenting
 *  actor ⇒ admit the merged receipt or name the refusal. The window is the
 *  lease TTL itself: the holder renewed within it throughout the walk, so a
 *  loss younger than the TTL is by construction "mid-walk", not history. */
export function midWalkReceiptDecide(
  loss: LeaseLossTransition | null | undefined,
  actor: string,
  now: number,
): { ok: true } | { ok: false; reason: string } {
  const holder = loss ? leaseLossHolder(loss) : null;
  if (!loss || !holder)
    return { ok: false, reason: "the ledger shows no lease loss on this lane — nothing anchors a mid-walk receipt" };
  if (holder !== actor)
    return { ok: false, reason: `the lane's last lease was held by ${holder}, not by you — only the recorded holder may report a mid-walk merge` };
  const age = now - loss.ts;
  if (age > TRAIN_LEASE_TTL_MS)
    return { ok: false, reason: `the lane's lease was lost ${Math.round(age / 1000)}s ago — past the lease TTL (${TRAIN_LEASE_TTL_MS / 60_000}m); too stale to be mid-walk` };
  return { ok: true };
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
 *  hardcoded (BR#3516 §1): required workflows + CI bound ride meta.lane.
 *  BR#4934: burst_max rides too — the back-to-back merge cap per settle
 *  pass (0 = unlimited), default DEFAULT_BURST_MAX. */
export type LaneSpec = {
  repo: string;
  base: string;
  /** required workflows the awaiting-CI phase polls on the merge commit */
  required_workflows: string[];
  /** typical CI wall-clock, minutes — the unknown bound is 3× this */
  ci_typical_minutes?: number;
  /** burst-drain cap per settle pass (BR#4934); 0 = unlimited */
  burst_max: number;
};

export const LANE_TITLE_PREFIX = "Merge lane: ";
export function laneKey(repo: string, base: string): string {
  return `${repo}@${base}`;
}
export function laneCardTitle(repo: string, base: string): string {
  return `${LANE_TITLE_PREFIX}${repo}@${base}`;
}

// ---- burst-drain settle law (BR#4934, decision BR#4932 amends BR#4804) ----

/** lane.burst_max default (BR#4934): back-to-back merges per settle pass. */
export const DEFAULT_BURST_MAX = 10;

/** Parse lane.burst_max (BR#4934): 0 = unlimited; absent or junk → default. */
export function parseBurstMax(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : DEFAULT_BURST_MAX;
}

/** WHY this tick's drain pass ended (the executor acts per arm):
 *  "drain" — more gate-clean heads to merge back-to-back; "settle" — the
 *  pass's ONE settle wait on the final merge commit; "stop" — a pass sha's
 *  fed checks went RED mid-drain (the line stops immediately, GH#2261). */
export type DrainDecision = "drain" | "settle" | "stop";

/** The burst-drain law (BR#4934): after a merge, keep draining gate-clean
 *  heads back-to-back — ONE settle per drain pass, on the final merge
 *  commit; rebase work rides the settle wait. Red at any point stops the
 *  line immediately (GH#2261); it never waits for the settle. */
export function drainBurstDecision(merged: number, cap: number, hasNext: boolean, redSeen: boolean): DrainDecision {
  if (redSeen) return "stop";
  if (hasNext && (cap === 0 || merged < cap)) return "drain";
  return "settle";
}

/** The red-settle bisect walk order (BR#4934): the pass's stamped merge
 *  shas, oldest first — the first RED one names the ONE culprit merge. */
export function firstRedIndex(reds: boolean[]): number | null {
  const i = reds.indexOf(true);
  return i === -1 ? null : i;
}

/** BR#4996 batch inputs: one candidate head's changed-file set (`git diff
 *  --name-only merge-base(origin/base, head)..head`), keyed by file path. */
export type FileSet = Set<string>;

/** BR#4996: conflict pairs among batch candidates, from their changed-file
 *  sets — two heads are pair-candidates when their sets INTERSECT. A pure
 *  set law, testable without git; the executor's plumbing that PRODUCES the
 *  sets fails closed per BR#3935 (train.rs), and each intersecting pair is
 *  merge-tree-confirmed before it gates a landing. Mirror of train_gate.rs
 *  conflicts_from_file_sets — one law, two implementations, fixture-locked. */
export function conflictsFromFileSets(fileSets: FileSet[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < fileSets.length; i++) {
    for (let j = i + 1; j < fileSets.length; j++) {
      for (const f of fileSets[i]) {
        if (fileSets[j].has(f)) {
          out.push([i, j]);
          break;
        }
      }
    }
  }
  return out;
}

/** The batch-merge law (BR#4996, Ray ruling 2026-10-29, amending the
 *  BR#4934 burst-drain): select the maximal set of MUTUALLY non-conflicting
 *  heads from the gate-clean queue, in queue order — which is landing order
 *  (oldest-first). Greedy: a head joins the batch unless it conflicts
 *  (either pair orientation) with an already-selected head; clean[i] ===
 *  false excludes just that member (fail-closed: only KNOWN-clean heads are
 *  eligible — an exclusion never poisons its neighbours, so a chain A↔B↔C
 *  lands [A, C] and skips only B); cap > 0 binds when the batch reaches it,
 *  cap === 0 is unlimited. Mirror of train_gate.rs select_batch. */
export function selectBatch(clean: boolean[], conflictPairs: [number, number][], cap: number): number[] {
  const selected: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    if (!clean[i]) continue;
    if (cap > 0 && selected.length >= cap) break;
    const clashing = selected.some((s) => conflictPairs.some(([a, b]) => (a === i && b === s) || (a === s && b === i)));
    if (!clashing) selected.push(i);
  }
  return selected;
}

/** BR#5658 (Ray 2026-11-03): one verifying or ready PR car in a merge batch.
 *  `state` drives the verification colour law:
 *  - "ready"     → green solid (.tb-ready): verified & ready to merge
 *  - "verifying" → orange pulsing (.tb-verifying): actively being verified now
 *  - "waiting"   → orange solid (.tb-wait): waiting to be verified */
export interface TrainBatchCar {
  id: string;
  pr?: number;
  state: "ready" | "verifying" | "waiting";
  detail?: string;
}

/** BR#5658 (Ray 2026-11-03): partition all verifying + ready PRs on a lane into
 *  sequential merge batches (`Batch 1 | Batch 2 | …`) by running `selectBatch`
 *  iteratively until every car is assigned to a pass.
 *  `conflictPairsByPr` are pairs of PR numbers `[prA, prB]` whose changed-file
 *  sets conflict (executor-stamped on `queue_facts.conflict_pairs`); `cap` is
 *  `lane.burst_max` (0 = unlimited). Cars that conflict with an earlier member
 *  in Batch k or exceed `cap` defer to Batch k+1 while non-conflicting later
 *  cars still join Batch k (the greedy A↔B↔C → [A, C] then [B] law). */
export function partitionMergeBatches<T extends { id: string; pr?: number; state?: string }>(
  cars: T[],
  conflictPairsByPr: [number, number][] = [],
  cap: number = DEFAULT_BURST_MAX,
): T[][] {
  if (!cars.length) return [];
  const stateRank = (s: string | undefined): number => (s === "ready" ? 0 : s === "verifying" ? 1 : 2);
  const ordered = cars
    .map((c, idx) => ({ c, idx }))
    .sort((a, b) => stateRank(a.c.state) - stateRank(b.c.state) || a.idx - b.idx)
    .map((x) => x.c);
  const remaining: number[] = ordered.map((_, i) => i);
  const batches: T[][] = [];
  const prConflict = (i: number, j: number): boolean => {
    const pa = Number(ordered[i]?.pr ?? 0);
    const pb = Number(ordered[j]?.pr ?? 0);
    if (!pa || !pb) return false;
    if (pa === pb && ordered[i].id !== ordered[j].id) return true;
    return conflictPairsByPr.some(([a, b]) => (a === pa && b === pb) || (a === pb && b === pa));
  };
  while (remaining.length > 0) {
    const clean = remaining.map(() => true);
    const subPairs: [number, number][] = [];
    for (let a = 0; a < remaining.length; a++) {
      for (let b = a + 1; b < remaining.length; b++) {
        if (prConflict(remaining[a], remaining[b])) subPairs.push([a, b]);
      }
    }
    const chosenSub = selectBatch(clean, subPairs, cap);
    if (!chosenSub.length) {
      // safety fallback (clean is all-true so selectBatch always picks >=1)
      batches.push([ordered[remaining.shift()!]]);
      continue;
    }
    batches.push(chosenSub.map((si) => ordered[remaining[si]]));
    const chosenSet = new Set(chosenSub);
    const nextRemaining = remaining.filter((_, idx) => !chosenSet.has(idx));
    remaining.length = 0;
    remaining.push(...nextRemaining);
  }
  return batches;
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
    burst_max: parseBurstMax(lane.burst_max),
  };
}

/** The lane card's standing body (created once, updated only by events). */
export function laneCardBody(lane: LaneSpec, cfg: { alarm_sink: string }): string {
  return [
    `Standing merge lane for **${lane.repo}** base **${lane.base}** — serialized: one merge at a time, gated, lease-held by an opportunistic gateway executor (decision BR#3516).`,
    ``,
    `**Required workflows on the merge commit (lane config):** ${lane.required_workflows.length ? lane.required_workflows.map((w) => `\`${w}\``).join(", ") : "_(none configured — BACK-PRESSURE default: every check run on the merge commit (build + deploy) must settle green before the next head enters)_"}`,
    lane.ci_typical_minutes ? `**CI bound:** unknown-past-stop at ~3× typical = ${3 * lane.ci_typical_minutes} min (typical ${lane.ci_typical_minutes} min)` : `**CI bound:** default 3 × ${TRAIN_CI_TYPICAL_MINUTES} min`,
    `**Burst drain (BR#4934):** up to ${lane.burst_max === 0 ? "unlimited" : lane.burst_max} gate-clean heads merge back-to-back per pass, then ONE settle wait on the final merge commit; red anywhere stops the line instantly; a red settle bisects the pass to ONE culprit. Rebase work rides the settle wait.`,
    `**Batch merges (BR#4996):** each pass lands a maximal set of MUTUALLY non-conflicting gate-clean heads back-to-back (conflict-checked via changed-file sets + merge-tree, fail-closed) and settles ONCE; a head conflicting with a selected member waits for the next pass.`,
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
/** BR#6348 — the conflicting car's park reason prefix. Like the queued
 *  prefix it ADMITS the car into mergeTrainQueue (the derived queue must
 *  never go silently empty while its head car is conflicting — the Phase A
 *  defect), but the executor's walk skips a car already parked conflicting
 *  (the typed clock + budget alarm own the exit), so admission here means
 *  VISIBILITY (starvation accounting, panel queue block), not mergeability. */
export const MERGE_TRAIN_CONFLICTING_REASON = "merge-train: conflicting";
/** BR#6348 — the bounded budget for a typed conflicting park, knob
 *  `train.conflicting_budget_min`, clamped 15..1440. Default 120 min: the
 *  Phase A episode churned 3h46m invisible; the alarm must fire well inside
 *  that. Past the budget the conflicting sweep alarms ONCE per episode to
 *  the train alarm sink naming the mechanical rebase leg. */
export const TRAIN_CONFLICTING_BUDGET_MIN_DEFAULT = 120;

export function clampConflictingBudgetMin(...candidates: unknown[]): number {
  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return Math.min(1440, Math.max(15, n));
  }
  return TRAIN_CONFLICTING_BUDGET_MIN_DEFAULT;
}

/** The conflicting park's blocked.reason — carries MERGE_TRAIN_CONFLICTING_
 *  REASON (queue admission) + the enumerated conflicts + the demanded
 *  machine leg, so plain reading names the exit. */
export function trainConflictingParkReason(
  pr: number,
  repo: string,
  conflictFiles: readonly string[],
  defect?: string | null,
): string {
  const files = conflictFiles.length
    ? conflictFiles.slice(0, 5).join(", ") + (conflictFiles.length > 5 ? ", …" : "")
    : "trial-merge failed to enumerate (fail-closed)";
  const head = `${MERGE_TRAIN_CONFLICTING_REASON} — PR ${repo ? `${repo}#` : "#"}${pr} conflicts with base (${conflictFiles.length} file(s)): ${files}`;
  return `${head} — the mechanical rebase leg owns the exit: rebase onto origin/main, resolve, signed force-with-lease push, fresh verify, re-queue at the BACK (BR#6348; bounded budget + loud alarm at expiry)${defect ? ` — ${String(defect).slice(0, 160)}` : ""}`;
}

/** BR#6348 — the conflicting-episode keys a phase write must clear when the
 *  card LEAVES the conflicting phase (accept → queued, merged → awaiting-ci,
 *  machine re-queue). Stale keys are inert to readers (every reader gates on
 *  state === "conflicting") but they are illegal residue under the closed
 *  union — one helper, called at the phase-write sites. */
export function clearConflictingEpisode(mt: Record<string, unknown> | undefined): void {
  if (!mt) return;
  delete mt.conflicting_at;
  delete mt.conflicting_alarm;
}
// BR#6045: the queue-note matcher binds BOTH the canonical `merge-train:
// queued` prefix AND the semantically-equivalent re-queue spelling
// `merge-train: re-queued` (a fresh verify accept after a bounce). The direct
// re-queue hook used to gate on startsWith(MERGE_TRAIN_QUEUED_REASON) alone,
// so a re-queued accept note silently skipped trainQueueOnAccept — no stamp
// fold-forward, no state=queued — and the next drain walk bounced the card
// for coverage against the STALE stamp (BR#5646 bounce #2, PR
// superpositional#2555: the same verified head bounced twice, the only delta
// being the note prefix).
export const MERGE_TRAIN_QUEUE_NOTE_RX = /^merge-train: (?:re-)?queued/;

export type TrainCandidate = { id: string; status_ts: number; meta: any; tags?: string[] };

// ---- BR#5190 root-fix fast lane: the board half of the main-breakage law ----

/** The root-fix tags — a card is THE main-breakage fix iff it carries both
 *  AND is bound to a failing main-HEAD run (meta.root_fix, BR#5189 §1). */
export const ROOT_FIX_TAG = "root_blocker";
export const MAIN_RED_TAG = "main-red";

/** The deploy-health gate check — matched as a lowercase substring against
 *  the check NAME ("Deploy health (merge gate)" matches). A head red of this
 *  class is exactly main's own deploy red: the circular class no machine leg
 *  can pass — the one-click human merge ask is the fast lane (BR#5189 §5,
 *  SP #2617 precedent). MUST stay byte-identical to train_gate.rs. */
export const DEPLOY_HEALTH_PATTERN = "deploy health";

/** BR#5883: the destination-green gate check (BR#3008/BR#3009) — matched as a
 *  lowercase substring against the check NAME ("main-green gate" matches). A
 *  head red of this class judges MAIN's tip, not the PR's own code; when the
 *  tip now classifies fully green under the gate's own predicate the
 *  conviction is stale by construction and the self-heal re-runs it. MUST
 *  stay byte-identical to train_gate.rs MAIN_GREEN_GATE_PATTERN. */
export const MAIN_GREEN_GATE_PATTERN = "main-green gate";

export function isBaseHealthGateName(name: string): boolean {
  const lower = String(name ?? "").toLowerCase();
  return lower.includes(DEPLOY_HEALTH_PATTERN) || lower.includes(MAIN_GREEN_GATE_PATTERN);
}

/** The failing-main binding a root-fix card must carry: the repo + the exact
 *  failing main-HEAD run sha it cures. */
export type RootFixBinding = { repo: string; head_sha: string };

/** meta.root_fix read off a card — null unless it names repo + head_sha (or
 *  an agent-filed root-blocker card carrying main_tip/red_since + a bound PR
 *  repo, BR#6012; or a BASE-FIX / stop-the-line card stamped `tip_sha` +
 *  `root_blocker_for_lane` ("<repo>@<base>") by the field — BR#6390, the
 *  2026-11-04 BR#6378 shape, which hub code never mints but must still
 *  recognize). */
export function mainRedBinding(meta: any): RootFixBinding | null {
  const b = meta?.root_fix;
  if (b && typeof b === "object") {
    const repo = typeof b.repo === "string" ? b.repo : "";
    const sha = typeof b.head_sha === "string" ? b.head_sha : "";
    if (repo && sha) return { repo, head_sha: sha };
  }
  const fallbackSha =
    typeof meta?.main_tip === "string" && meta.main_tip
      ? meta.main_tip
      : typeof meta?.tip_sha === "string" && meta.tip_sha
        ? meta.tip_sha
        : typeof meta?.red_since === "string" && meta.red_since
          ? meta.red_since
          : "";
  const fallbackRepo = String(
    meta?.root_fix?.repo ??
      meta?.repo ??
      meta?.pr?.repo ??
      (Array.isArray(meta?.prs) && meta.prs[0]?.repo ? meta.prs[0].repo : "") ??
      meta?.merge_train?.repo ??
      // BR#6390: the field-minted BASE-FIX shape names the lane, not a PR
      // ("repo@base") — split the repo half out as the binding's repo.
      (typeof meta?.root_blocker_for_lane === "string" && meta.root_blocker_for_lane.includes("@")
        ? meta.root_blocker_for_lane.split("@")[0]
        : "") ??
      "",
  ).trim();
  return fallbackRepo && fallbackSha ? { repo: fallbackRepo, head_sha: fallbackSha } : null;
}

/** The qualification (Rust is_root_fix_card mirror): tags root_blocker (or
 *  root-blocker / root-fix / base-fix) + main-red (or main_red /
 *  stop-the-line) AND a bound failing main-HEAD run. Tags alone never
 *  qualify — the binding does. BR#6390: a field-minted BASE-FIX card can
 *  carry NO root-side tag at all — the marker then lives in meta
 *  (`root_blocker_for_lane` "<repo>@<base>" or a `root_blocker` id string —
 *  the BR#6378 exemplar), so a meta marker qualifies as the root-side half.
 *  Neither tags nor meta markers qualify ALONE: the failing-run binding below
 *  is still required. */
export function isRootFixCard(card: { tags?: unknown; meta?: any }): boolean {
  const tags = Array.isArray(card?.tags) ? card.tags.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase()) : [];
  const hasRoot =
    tags.includes(ROOT_FIX_TAG) ||
    tags.includes("root-blocker") ||
    tags.includes("root-fix") ||
    tags.includes("base-fix") ||
    // BR#6390: meta-borne root-side markers (the BR#6378 exemplar carries no
    // root-side tag — recognition must not hinge on which tag vocabulary the
    // field used).
    (typeof card?.meta?.root_blocker_for_lane === "string" && card.meta.root_blocker_for_lane.includes("@")) ||
    typeof card?.meta?.root_blocker === "string";
  const hasMainRed = tags.includes(MAIN_RED_TAG) || tags.includes("main_red") || tags.includes("stop-the-line");
  if (!hasRoot || !hasMainRed) return false;
  return mainRedBinding(card?.meta) !== null;
}

/** BR#6390: the LANE BASE-FIX card shape — an agent-filed stop-the-line fix
 *  card that never carries the root_blocker tag pair (the 2026-11-04 BR#6378
 *  episode: tags [main-red, merge-train, stop-the-line, cortex, p0], meta
 *  {repo, tip_sha, root_blocker_for_lane}) and so was invisible to step 1 of
 *  trainOpenRootFix — the episode resolution fell back to a stale fix_card
 *  and the human gate flapped. A card is the lane's base-fix iff it names
 *  this lane's repo in meta.root_blocker_for_lane, is main-red-tagged, and
 *  reads as a base/CI fix (stop-the-line | base-fix | p0 tags). */
export function isLaneBaseFixCard(card: { tags?: unknown; meta?: any }, repo: string): boolean {
  if (!repo) return false;
  const tags = Array.isArray(card?.tags) ? card.tags.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase()) : [];
  if (!tags.includes(MAIN_RED_TAG) && !tags.includes("main_red")) return false;
  if (!(tags.includes("stop-the-line") || tags.includes("base-fix") || tags.includes("base_fix") || tags.includes("p0"))) return false;
  const lane = String(card?.meta?.root_blocker_for_lane ?? "");
  return lane.split("@")[0] === repo && mainRedBinding(card?.meta)?.repo === repo;
}

/** BR#6012: true iff a queued card's title explicitly names a base-red /
 *  CI / deploy-health / merge-gate / stop-the-line fix — NEVER a generic
 *  product bugfix (`fix(chat): ...`, `fix(web): ...`), which previously
 *  matched bare `/\bfix\b/` and grafted unrelated product PRs (#2555) onto
 *  the root-fix card as a fake bypass-merge cure. */
export function isBaseCureCardTitle(title: string): boolean {
  const t = String(title ?? "");
  return /\bfix\s*\(\s*(?:ci|deploy|gate|train|build|infra|runner|smoke|actions)\s*\)|main[- ]green|main[- ]red|stop[- ]the[- ]line|deploy[- ]health|root[-_ ]blocker|root[-_ ]fix/i.test(t);
}

/** The deterministic one-click human merge ask title for the circular
 *  deploy-health class. BYTE-IDENTICAL to root_fix_fast_lane_title in
 *  train_gate.rs (ask-dedupe keys on exact wording; hub + executor must
 *  produce the same string). ≤240 chars, ends "?" per the ask contract. */
export function rootFixFastLaneTitle(repo: string, pr: number | string): string {
  return `Root-fix fast lane (BR#5189): merge ${repo} PR #${pr} now? Main is red on the exact red this PR cures — the train cannot merge it while the line it fixes is stopped; one click merges the cure?`;
}

/** The auto-spawned root-fix card title (BR#5189 §3): deterministic per red
 *  episode — the failing checks name the red, the sha pins the run. ≤240
 *  chars so ask/title guards never trip on it. */
export function rootFixCardTitle(repo: string, sha: string, failing: string[]): string {
  const prefix = `ROOT-FIX (BR#5189 p0): fix main — ${repo} red at ${sha.slice(0, 9)} (`;
  const suffix = `)`;
  let text = failing.join(", ");
  if (prefix.length + text.length + suffix.length > 240) text = text.slice(0, Math.max(0, 240 - prefix.length - suffix.length - 1)).trimEnd() + "…";
  return prefix + text + suffix;
}

/** The auto-spawned root-fix card body: what is red, the exact failing
 *  main-HEAD checks, and the fast-lane law the card rides (BR#5189). */
export function rootFixCardBody(repo: string, sha: string, failing: { name: string; conclusion?: string | null; url?: string | null }[]): string {
  const lines = [
    `Main is RED — stop-the-line (BR#5189). This card is THE main-breakage fix.`,
    ``,
    `Failing main-HEAD checks at \`${sha.slice(0, 9)}\`:`,
    ...failing.map((f) => `- ${f.name}${f.conclusion ? ` (${f.conclusion})` : ""}${f.url ? ` — ${f.url}` : ""}`),
    ``,
    `Bound to the failing main-HEAD run (meta.root_fix: repo ${repo}, head_sha ${sha.slice(0, 9)}), tags \`root_blocker\` + \`main-red\`.`,
    ``,
    `While the line is stopped, the merge train parks every other head for ${repo} — this card gets the first gate slot and its PR fast-tracks: base red + head green merges onto the red base (receipt stamps \`root_fix_fast_tracked\`); if the base red is the circular deploy-health class (the gate red because main itself is red), the one-click human merge ask is the fast lane.`,
    ``,
    `Deliver the fix PR through the normal train (verify → queue). Tags and the binding ride the card — they are the qualification, don't strip them.`,
  ];
  return lines.join("\n");
}

/** Queue order: a FOUR-tier priority ladder (BR#5189 §2):
 *  tier 0 "root_fix" — THE bound main-breakage fix (isRootFixCard), above
 *      every other card including boosts;
 *  tier 1 "boosted" — the human/starvation boost stamp (meta.boosted), the
 *      old CRITICAL class under its own honest label;
 *  tier 2 "critical" — cards explicitly marked critical (meta.priority ===
 *      "critical"), the manual rung;
 *  tier 3 "normal" — everything else.
 *  FIFO within tier by blocked-since (status_ts ascending). NO stop/base-red
 *  filter (BR#5753): the hub's derived queue keeps EVERY held car visible —
 *  root_fix still sorts to rank 0 unconditionally — because the stop-arm
 *  consumers (base_red_resolution.held, the alarm ask's cure-PR fallback,
 *  trainOpenRootFix) read this list and would go blind mid-episode if
 *  non-root_fix cars were filtered out. The stopped-lane fast lane (only the
 *  bound root-fix card merges; BR#5190) is the WALK's law — train.rs
 *  is_root_fix_card + the merge gate — enforced where merges happen, not a
 *  hub-side queue filter. (The pre-5753 opts.baseRed option was dead in
 *  production: its one caller looked the stop facts up with
 *  `WHERE id = laneKey(repo, base)`, and a lane key is never an
 *  artefacts.id, so the filter never fired once.) */
export function mergeTrainQueue(cards: TrainCandidate[]): { id: string; priority: "root_fix" | "boosted" | "critical" | "normal"; root_fix?: true }[] {
  const queued = cards.filter((c) => mergeCompletesTask(c.meta ?? {}) && (
    [c.meta?.blocked?.reason, c.meta?.blocked_reason].some((r: unknown) => typeof r === "string" && r.startsWith(MERGE_TRAIN_REASON_PREFIX))
    // BR#5750 — legacy watchdog hold-parks predate the prefix; a queued car
    // the silence-release parked unprefixed must not stay invisible to the
    // train (the BR#4995 silent drop)
    || isWatchdogTrainHoldPark(c.meta)
    // BR#6330 — typed-phase admission: the closed merge_train phase is the
    // single classification; a car stamped queued/awaiting-ci is a queue
    // candidate even if its prose reason lost the prefix. Admission is
    // deliberately FAIL-OPEN (prefix OR stamp — a stray admit gets gate-
    // checked by the executor; a silent drop starves a lane).
    || isAwaitingMerge(c.meta)
    // BR#6348 — a typed conflicting park is a queue VISIBILITY slot, not a
    // merge candidate: the walk skips it (the typed clock + budget alarm own
    // the exit), but it must never silently leave the derived queue — the
    // Phase A empty-queue starvation happened precisely because a conflicting
    // car was invisible to every alarm.
    || mergePhaseOf(c.meta) === "conflicting"),
  );
  const rank = (c: TrainCandidate) => (isRootFixCard(c) ? 0 : c.meta?.boosted ? 1 : c.meta?.priority === "critical" ? 2 : 3);
  return [...queued]
    .sort((a, b) => rank(a) - rank(b) || (a.status_ts ?? 0) - (b.status_ts ?? 0))
    .map((c) => {
      const r = rank(c);
      const e: { id: string; priority: "root_fix" | "boosted" | "critical" | "normal"; root_fix?: true } = {
        id: c.id,
        priority: r === 0 ? "root_fix" : r === 1 ? "boosted" : r === 2 ? "critical" : "normal",
      };
      if (r === 0) e.root_fix = true;
      return e;
    });
}

// ---- typed-proxy preservation (BR#4067) ----

/** result_class stamped on a watchdog hold-park (a silence that would have
 *  released a card carrying a machine wait). The score side exempts it — a
 *  hold preserves state, it is neither an abandonment nor a lost run. */
export const PROXY_WAIT_HOLD_RESULT_CLASS = "proxy_wait_hold";

/** result_class stamped on the watchdog's bounce re-entry demote (BR#4494): a
 *  train bounce re-opened a card in_progress with no live executor, and the
 *  demanded re-verify/repair leg had no machine starter — the sweep releases
 *  it claimable instead of re-parking. The score side exempts it: a machine
 *  bounce + machine demote is nobody's abandonment. */
export const BOUNCE_REENTRY_DEMOTE_RESULT_CLASS = "bounce_reentry_demote";

/** The PR leg a card's merge-train state points at, from any of the shapes
 *  the hub stamps (meta.pr.number, meta.prs[0].number, meta.merge_train.pr).
 *  0 when none resolves. */
export function trainPrLeg(meta: any): number {
  const m = meta ?? {};
  const mt = (m.merge_train ?? {}) as Record<string, unknown>;
  const fromPr = (m.pr as any)?.number;
  const fromPrs = Array.isArray(m.prs) && m.prs.length ? (m.prs[0] as any)?.number : undefined;
  return Number(fromPr ?? fromPrs ?? mt.pr ?? 0) || 0;
}

/** The typed await a train-owned card parks on — the pr_merged proxy derived
 *  from its live PR leg. Null when the leg lacks a well-formed repo/number
 *  (callers then fall back to the machine-managed park flag). */
export function trainProxyEvent(meta: any): AwaitEvent | null {
  const m = meta ?? {};
  const mt = (m.merge_train ?? {}) as Record<string, unknown>;
  const repo = String((m.pr as any)?.repo ?? mt.repo ?? "");
  const n = trainPrLeg(meta);
  return isValidGitHubRepo(repo) && n > 0 ? { event: "pr_merged", repo, n } : null;
}

/** BR#4282 — the card's OWN merge-train stamp proving its pr_merged leg has
 *  ALREADY merged: `merge_train.state = "awaiting-ci"` (or a per-leg entry)
 *  with a non-null merge_sha, exactly what train:merged writes (do.ts). The
 *  hub holds no VCS credentials (BR#3516 §8) — this board stamp (plus the
 *  provenance row, which needs the DB) is the only hub-readable receipt that
 *  the atom is satisfied, so a hold-park must consult it BEFORE re-arming the
 *  proxy. Null when the card carries no merge receipt for (repo, n). */
export function trainMergeReceipt(
  meta: any,
  repo: string,
  n: number,
): { merge_sha: string; merged_at: number } | null {
  const m = meta ?? {};
  const mt = (m.merge_train ?? {}) as Record<string, unknown>;
  const leg = (mt.legs as Record<string, { merge_sha?: unknown; merged_at?: unknown }> | undefined)?.[String(n)];
  const fromLeg =
    leg && typeof leg.merge_sha === "string" && leg.merge_sha
      ? { merge_sha: leg.merge_sha, merged_at: Number(leg.merged_at ?? 0) || 0 }
      : null;
  const fromState =
    String(mt.state ?? "") === "awaiting-ci" &&
    Number(mt.pr ?? 0) === Number(n) &&
    typeof mt.merge_sha === "string" &&
    mt.merge_sha
      ? { merge_sha: mt.merge_sha, merged_at: Number(mt.merged_at ?? 0) || 0 }
      : null;
  const hit = fromLeg ?? fromState;
  if (!hit) return null;
  // the receipt must be for the leg the proxy actually names
  const legRepo = String((m.pr as any)?.repo ?? mt.repo ?? "");
  return legRepo === repo ? hit : null;
}

/** BR#6432 — card-id references in prose: the receipt scope of a batch
 *  SUPERSEDE authorization. Parses the board's card-id grammar out of an
 *  artefact body: `BR#1234` / `BR-1234` (case-insensitive), slash chains
 *  (`BR#4689/#4834/#4692` — the census style the authorization asks use),
 *  and legacy `TASK-001` ids. Bare `#1234` / `repo#1234` PR references and
 *  PR URLs are NEVER card ids and never match — the scope stays exactly the
 *  cards the authorizer named, deduplicated in first-appearance order. */
export function parseCardIdRefs(text: string): string[] {
  const hits: Array<{ at: number; id: string }> = [];
  for (const m of text.matchAll(/\bBR[#-](\d+(?:\/#\d+)*)/gi)) {
    // slash chains: the first number carries the match position, the
    // continuations follow in order after it
    let at = m.index + m[0].length - m[1].length;
    for (const part of m[1].split("/")) {
      hits.push({ at, id: `BR#${part.replace(/^#/, "")}` });
      at += part.length + 1;
    }
  }
  for (const m of text.matchAll(/\b(TASK-\d+)\b/gi)) {
    hits.push({ at: m.index, id: m[1].toUpperCase() });
  }
  hits.sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const { id } of hits) {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/** BR#4067 — does a release path need to HOLD? Returns the hold description
 *  when the card carries machine-wait state — a merge-train queue slot
 *  (queued/awaiting-ci/bounced/awaiting on a live PR leg), a typed
 *  await_event, or a bound ask — and null when a release may proceed. Every
 *  watchdog release
 *  path (stall sweep, review sweep, lapsed subprocess, reaper reassign) and
 *  the machine's machine-actor backstop consult this one predicate: the
 *  PR #257 class is a card released to todo while its wait state (queue
 *  slot, proxy, ask) was still live. */
export function releaseHold(meta: any): string | null {
  const m = meta ?? {};
  const mt = (m.merge_train ?? {}) as Record<string, unknown>;
  const st = String(mt.state ?? "");
  // BR#6330 — the phase set is closed (contracts MergeTrainPhaseSchema);
  // unbound/landed/base-red-park hold nothing: the train no longer owns the
  // exit. Semantics unchanged from the pre-6330 literal set.
  if (st === "queued" || st === "awaiting-ci" || st === "bounced" || st === "conflicting" || st === "awaiting") {
    const pr = trainPrLeg(meta);
    if (pr) {
      const repo = String((m.pr as any)?.repo ?? mt.repo ?? "repo");
      return `merge-train ${st} on PR ${repo}#${pr} — the typed pr_merged proxy owns the exit`;
    }
  }
  if (m.blocked?.await_event && typeof m.blocked.await_event === "object")
    return `a typed await_event (${String((m.blocked.await_event as any).event ?? "unknown")}) — the proxy watch owns the exit`;
  if (m.awaiting_ask)
    return `a bound ask (${String(m.awaiting_ask.ask_id ?? "")}) — the answer owns the exit`;
  return null;
}

/** BR#5750 — the blocked.reason prefix that keeps a hold-parked card INSIDE
 *  mergeTrainQueue. The queue derives candidates from the `merge-train:`
 *  reason prefix alone, so a watchdog hold-park whose note lacks the prefix
 *  silently drops a live queued/awaiting-ci car out of the train queue
 *  forever — the BR#4995 class, root-caused from the BR#5674 Mission 2
 *  audit. The live-slot states ride the state-named prefix (queued /
 *  awaiting-ci / conflicting — BR#6348: a conflicting car must stay in the
 *  derived queue, the silent-empty-queue state is the Phase A defect); every
 *  other hold (bounced/awaiting/typed waits) is NOT a queue slot and must
 *  stay unprefixed — those legs re-enter through the board, never the queue. */
export function mergeTrainHoldPrefix(meta: any): string | null {
  const mt = ((meta ?? {}).merge_train ?? {}) as Record<string, unknown>;
  const st = String(mt.state ?? "");
  if (st === "queued") return `${MERGE_TRAIN_REASON_PREFIX} queued — `;
  if (st === "awaiting-ci") return `${MERGE_TRAIN_REASON_PREFIX} awaiting-ci — `;
  if (st === "conflicting") return `${MERGE_TRAIN_CONFLICTING_REASON} — `;
  return null;
}

/** The park-note fingerprints a watchdog releaseHold hold-park writes (the
 *  holdParkBody silence note and the lapsed-subprocess hold note, BR#4067). */
export const WATCHDOG_HOLD_PARK_REASON_RE =
  /silence-release held \(watchdog\)|release held \(BR#4067\)/i;

/** BR#5750 — a blocked card that a watchdog releaseHold hold-park created
 *  BEFORE the merge-train prefix existed (the already-dropped BR#4995 cars
 *  still sitting unprefixed on the board). Read from the park's own facts:
 *  the reason matches the hold-park fingerprint AND the card still carries a
 *  live `queued` slot. `queued` only — awaiting-ci parks advance via train
 *  events (train:merged → awaiting-ci), not queue admission, and
 *  bounced/awaiting re-enter through the board, never the queue. */
export function isWatchdogTrainHoldPark(meta: any): boolean {
  const m = meta ?? {};
  const mt = ((m.merge_train ?? {}) as Record<string, unknown>);
  if (String(mt.state ?? "") !== "queued") return false;
  return [m.blocked?.reason, m.blocked_reason].some(
    (r: unknown) => typeof r === "string" && WATCHDOG_HOLD_PARK_REASON_RE.test(r),
  );
}

// ---- strand law (BR#6163: bounce-release strands train-parked cars) ----

/** The await events ONLY the merge train can fire: `pr_merged` and
 *  `pr_checks_green` are satisfied by lane train_events (merged / settle),
 *  never by anything a pool executor can do. A card out of the queue while
 *  carrying one of these waits for a merge event no queue will ever deliver
 *  — the strand the BR#6163 sweep re-boards or alarms on. */
export const TRAIN_ONLY_AWAIT_EVENTS = ["pr_merged", "pr_checks_green"] as const;

/** The card's live train-only await. Reads meta.blocked.await_event (the
 *  typed-wait park shape, closure.ts's closed grammar) and falls back to the
 *  bounce-release evidence stamp (meta.bounce_released.train_only_await —
 *  the release transitions delete meta.blocked, so the evidence must ride
 *  the release stamp). Normalised {event, repo, n}; null otherwise. */
export function trainOnlyAwait(
  meta: any,
): { event: string; repo: string; n: number } | null {
  const m = meta ?? {};
  const candidates = [m.blocked?.await_event, m.bounce_released?.train_only_await];
  for (const ev of candidates) {
    if (!ev || typeof ev !== "object") continue;
    const event = String((ev as any).event ?? "");
    const repo = (ev as any).repo;
    const n = Number((ev as any).n ?? (ev as any).number ?? 0);
    if (
      (TRAIN_ONLY_AWAIT_EVENTS as readonly string[]).includes(event) &&
      typeof repo === "string" && repo.includes("/") &&
      Number.isFinite(n) && n > 0
    ) {
      return { event, repo: repo.trim(), n };
    }
  }
  return null;
}

export type TrainStrandClass =
  | "out_of_queue_await"  // train-only await, card no longer a queue candidate
  | "queued_out_of_queue" // card SAYS merge-train queued, queue dropped it
  | "unbound_in_queue";   // admitted queue park whose legs never bound (alarm only)

/** Which strand class (if any) is this card in? `admitted` = the card is a
 *  queue candidate (blocked + merge_train.pr>0 + the merge-train prefix or a
 *  watchdog hold-park — mergeTrainQueue's admit test, regardless of legs).
 *  Excludes the states other law owns: Awaiting parks (the BR#5633 sweep),
 *  bounced re-entry (the BR#4494 demote), and cards holding a bound ask
 *  (awaiting_ask — the ask pause is deliberate, not a strand). */
export function trainStrandClass(meta: any, admitted: boolean): TrainStrandClass | null {
  const m = meta ?? {};
  const mt = ((m.merge_train ?? {}) as Record<string, unknown>);
  if (m.awaiting_ask) return null;
  const state = String(mt.state ?? "");
  if (state === "awaiting") return null; // BR#5633 sweep owns Awaiting parks
  if (state === "bounced") return null;  // BR#4494 demote owns bounce re-entry
  if (state === "conflicting") return null; // BR#6348 budget sweep owns conflicting parks
  if (state === "unbound" && admitted) return "unbound_in_queue";
  // BR#6395: only a card that actually bears train-car provenance (a merge_train
  // stamp, a bounce_released.train_only_await stamp, or a bound review/impl PR
  // stamp) can be a stranded train car. A card with NO train provenance that
  // awaits pr_merged / pr_checks_green is waiting on an UPSTREAM PR dependency
  // (e.g. an epic parent or post-merge follow-up) and must never be overwritten
  // with "merge-train: queued — strand re-board".
  // A review_pr only proves a PR was submitted, not that it was accepted
  // onto the train. In particular it may differ from the upstream await.
  const hasTrainCarEvidence =
    state === "queued" || state === "awaiting-ci" ||
    Boolean(m.bounce_released?.train_only_await);
  if (trainOnlyAwait(m) && !admitted && hasTrainCarEvidence) return "out_of_queue_await";
  if (state === "queued" && !admitted) return "queued_out_of_queue";
  return null;
}

// ---- carry-record law (BR#3516 §5) ----

/** One head move the delivery chain ACCEPTED: `update-branch` (server-side,
 *  bought CI, no human resolution) or `force-review` (BR#4962 — a human's
 *  force-review approval re-anchors the verdict at the parked head; the one
 *  human-authored move that carries, because it IS the human leg). A conflict
 *  resolution is authored code: it never produces a carry-record, it
 *  produces a bounce. One sentence: **machine-clean carries;
 *  human-resolved invalidates.** */
export type CarryRecord = {
  from_head: string;
  to_head: string;
  prior_verdict_id: string | null;
  carried_ts: number;
  via: "update-branch" | "force-review";
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

/** The only valid append point for a machine-clean carry. */
export function trainCarryChainEnd(leg: Pick<TrainLeg, "head_sha_at_acceptance" | "carry">): string {
  let end = String(leg.head_sha_at_acceptance ?? "").toLowerCase();
  for (const link of Array.isArray(leg.carry) ? leg.carry : []) {
    const from = String(link.from_head ?? "").toLowerCase();
    const to = String(link.to_head ?? "").toLowerCase();
    if (from !== end || !/^[0-9a-f]{7,40}$/.test(to)) break;
    end = to;
  }
  return end;
}

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
 *  repo (a card rides exactly the lanes that own one of its UNLANDED legs)
 *  and, with `base`, to that repo's ONE base (BR#4977: a leg without a base
 *  stamp defaults to "main" — the card-stamp convention — so a lane on a
 *  second base never inherits another base's queue). */
export function trainLegsRemaining(meta: any, repo?: string, base?: string): TrainLeg[] {
  return trainLegs(meta).filter((l) => (!repo || l.repo === repo) && (!base || String(l.base ?? "main") === base) && !trainLegLanded(meta, l));
}

/** Does this queued card ride the given repo's lane? True when at least one
 *  of its UNLANDED legs belongs to that repo — and, when `base` is given,
 *  to that lane's base (BR#4977). (BR#3659: replaces the old lane filter
 *  that read meta.merge_train.repo — a field nothing ever set, so every
 *  queued card matched every lane.) */
export function trainCardMatchesLane(meta: any, repo: string, base?: string): boolean {
  return trainLegsRemaining(meta, repo, base).length > 0;
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
 *  lane config.
 *  BACK-PRESSURE (Ray, 2026-10-29): an unconfigured lane no longer passes
 *  through vacuously — that pass-through merged back-to-back and every push
 *  cancelled the previous Deploy Dev, starving main (the base-red pile).
 *  Default now: settle on EVERY check run on the merge commit (build +
 *  deploy) before the next head enters, with a short dwell after the merge
 *  so slower-triggered workflows (deploys) have registered a check run. */
export const TRAIN_SETTLE_DWELL_MS = 2 * 60_000;

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
  // back-pressure default: judge every observed check on the merge commit
  const judgeNames = required.length ? required : [...byName.keys()];
  const failing: MainRedCheck[] = [];
  const missing: string[] = [];
  const pending: string[] = [];
  for (const name of judgeNames) {
    const list = byName.get(name) ?? [];
    const judge = [...list].sort((a, b) => (b.id ?? 0) - (a.id ?? 0)).find((r) => r.conclusion !== "cancelled");
    if (!judge || judge.conclusion == null) {
      // unconfigured mode: a cancelled-only run (or in-flight with no
      // conclusion) is UNSETTLED — the commit has not finished proving itself
      (list.length || !required.length ? pending : missing).push(name);
      continue;
    }
    if (MAIN_RED_CONCLUSIONS.has(judge.conclusion)) {
      failing.push({ name, conclusion: judge.conclusion, url: judge.html_url ?? "" });
    } else if (!["success", "skipped", "neutral"].includes(judge.conclusion)) {
      pending.push(name);
    }
  }
  if (required.length) {
    // BR#6142: when a workflow fails at startup (`conclusion: "startup_failure"`),
    // GitHub creates 0 job check-runs, so none of the job names in `required`
    // ever appear. Fold any non-exempt workflow-level `startup_failure` into
    // `failing` immediately instead of waiting 60m on missing required jobs.
    for (const [name, list] of byName) {
      if (!name || required.includes(name) || isExemptCheckName(name)) continue;
      const judge = [...list].sort((a, b) => (b.id ?? 0) - (a.id ?? 0)).find((r) => r.conclusion !== "cancelled");
      if (judge?.conclusion === "startup_failure") {
        failing.push({ name, conclusion: judge.conclusion, url: judge.html_url ?? "" });
      }
    }
  }
  if (!required.length) {
    // the settle dwell: a green verdict may not land before slower-triggered
    // workflows (deploys) have even registered a check run on the commit
    if (opts.now - opts.merged_at < TRAIN_SETTLE_DWELL_MS) pending.push("settle-dwell");
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
  /** BR#4687 (L1.2): the branch is worker-authored — every commit's GitHub
   *  author login sits on the worker allowlist. The behind pre-clear below
   *  is provenance-gated on this: the train machine-updates its OWN
   *  branches; a protected human branch still bounces to its owner. */
  trainOwnedBranch?: boolean;
  headChecks: MainCheckRun[];
  /** BR#3659: which leg of the card's PR list this gate drives (1-based
   *  position in meta.prs) — the gate checks THAT leg's stamp, and the
   *  merge receipt cites the leg, not just the PR. */
  legNumber?: number;
  /** BR#5883: main's tip judges fully green under the gate's own predicate
   *  (classifyMainCheckRuns over the WHOLE tip — the exact main-green-gate
   *  script rule), i.e. the walk-start scoped verdict is Green with no gate
   *  qualifier attached. Gates the stale main-green-gate self-heal. Mirror
   *  of train_gate.rs TrainGateInput.base_gate_green. */
  baseGateGreen?: boolean;
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
 *  bounces naming ITS stamp. BR#3727: the train layer also pre-clears
 *  mergeStateStatus=behind (the §5 carry's own state — base advanced,
 *  branch still mergeable; the merge leg owns the machine-clean
 *  update-branch) and WAITS on blocked-with-pending-head-checks (strict
 *  branch protection re-runs the required checks on the head after every
 *  carry). decideMergeAction, the shared law, stays clean/unstable.
 *  BR#4685: an unanswered mergeStateStatus (null/UNKNOWN) means GitHub is
 *  still computing — the executor backoff-polls (15/30/60s, lease-bounded)
 *  before this gate and the shared law waits on it: never a bounce, never
 *  a merge on an unconfirmed state. */
export type CandidateHeadCheckState =
  | { kind: "green" }
  | { kind: "pending"; unsettled: string[] }
  | { kind: "red_circular_deploy_gate"; names: string[] }
  | { kind: "red_circular_main_green_gate"; names: string[] }
  | { kind: "red_circular_mixed_gates"; names: string[] }
  | { kind: "red_substantive"; names: string[] };

export type CandidateGatePhase =
  | { phase: "card_superseded" }
  | { phase: "card_done" }
  | { phase: "head_uncovered"; legNumber: number; stamped: string }
  | { phase: "mergeability_computing"; reason: string }
  | { phase: "conflicting" }
  | { phase: "unverified_commits"; count: number }
  | { phase: "unhandled_merge_state"; state: string }
  | {
      phase: "mechanically_sound";
      legNumber: number;
      legsTotal: number;
      mergeState: "clean" | "unstable" | "behind" | "blocked";
      headState: CandidateHeadCheckState;
    };

/** BR#6012 defense-in-depth state machine: classifies a train candidate into an
 *  exhaustive, mutually-exclusive phase BEFORE any transition rule runs, so
 *  impossible states (e.g. a conflicting PR reaching `rerun_gate` or `blocked`
 *  pre-clear, or an unverified-commit PR fast-tracking) are unrepresentable. */
export function classifyCandidateGatePhase(i: TrainGateInput): CandidateGatePhase {
  if (i.cardStatus === "superseded") return { phase: "card_superseded" };
  if (i.cardStatus === "done") return { phase: "card_done" };
  const legs = trainLegs(i.cardMeta);
  const legNumber = Math.max(1, Math.floor(i.legNumber ?? 1));
  const leg = legs.length ? legs[legNumber - 1] : undefined;
  if (!verdictCoversHeadLeg(leg, i.headSha)) {
    const stamped = String(leg?.head_sha_at_acceptance ?? "").slice(0, 9) || "(no stamp)";
    return { phase: "head_uncovered", legNumber, stamped };
  }
  const rawState = typeof i.mergeStateStatus === "string" ? i.mergeStateStatus.trim().toLowerCase() : "";
  if (!rawState || rawState === "unknown") {
    return {
      phase: "mergeability_computing",
      reason: `PR #${i.prNumber} mergeStateStatus not yet computed (null/UNKNOWN) — GitHub is computing mergeability; poll, never a defect (BR#4685)`,
    };
  }
  if (i.mergeable !== true) {
    if (i.mergeable === null) {
      return {
        phase: "mergeability_computing",
        reason: "GitHub still computing mergeability — not yet, skip this tick",
      };
    }
    return { phase: "conflicting" };
  }
  if (rawState !== "clean" && rawState !== "unstable" && rawState !== "behind" && rawState !== "blocked") {
    return { phase: "unhandled_merge_state", state: rawState };
  }
  const unverified = i.commits.filter((c) => !c.verified).length;
  if (unverified > 0) {
    return { phase: "unverified_commits", count: unverified };
  }
  const head = classifyHeadChecks(i.headChecks);
  let headState: CandidateHeadCheckState;
  if (head.verdict === "green") {
    headState = { kind: "green" };
  } else if (head.verdict === "unsettled") {
    headState = { kind: "pending", unsettled: head.unsettled };
  } else {
    const names = head.red.map((r) => r.name);
    const allBaseHealth = names.length > 0 && names.every((n) => isBaseHealthGateName(n));
    const allMainGreen = names.length > 0 && names.every((n) => n.toLowerCase().includes(MAIN_GREEN_GATE_PATTERN));
    const noneMainGreen = names.every((n) => !n.toLowerCase().includes(MAIN_GREEN_GATE_PATTERN));
    if (allBaseHealth && noneMainGreen) {
      headState = { kind: "red_circular_deploy_gate", names };
    } else if (allMainGreen) {
      headState = { kind: "red_circular_main_green_gate", names };
    } else if (allBaseHealth) {
      headState = { kind: "red_circular_mixed_gates", names };
    } else {
      headState = { kind: "red_substantive", names };
    }
  }
  return {
    phase: "mechanically_sound",
    legNumber,
    legsTotal: legs.length || 1,
    mergeState: rawState,
    headState,
  };
}

export function decideTrainGate(i: TrainGateInput): MergeAction {
  const phase = classifyCandidateGatePhase(i);
  switch (phase.phase) {
    case "card_superseded":
      return { kind: "close_superseded", reason: "linked card is superseded — closing PR without review" };
    case "card_done":
      return { kind: "skip", reason: "linked card already done — nothing to merge under it" };
    case "head_uncovered":
      return {
        kind: "bounce",
        defect: `PR #${i.prNumber} live head ${i.headSha.slice(0, 9)} is not covered by the accepted verdict (leg ${phase.legNumber} stamped ${phase.stamped}, no contiguous carry chain) — head moved past the verdict without a machine-clean update; re-verify at the new head`,
        bounceKind: "coverage",
      };
    case "mergeability_computing":
      return { kind: "skip", reason: phase.reason };
    case "conflicting":
      return {
        kind: "bounce",
        defect: `PR #${i.prNumber} unmergeable — CONFLICTING against base. Rebase, resolve, re-push, re-enter the queue`,
        bounceKind: "conflict",
      };
    case "unhandled_merge_state":
      return {
        kind: "bounce",
        defect: `PR #${i.prNumber} mergeStateStatus=${phase.state} — not clean. Fix the named state (rebase/re-sign) and re-enter — the accepted BR verify verdict is the approval of record (BR#4633 L4.2); there is no GitHub re-approve leg`,
        bounceKind: "gate",
      };
    case "unverified_commits":
      return {
        kind: "human_leg",
        reason: `PR #${i.prNumber} has ${phase.count} commit(s) not GitHub-verified — signing-environment class, never per-PR`,
      };
    case "mechanically_sound": {
      const { legNumber, legsTotal, mergeState, headState } = phase;
      const behind = mergeState === "behind";
      const blocked = mergeState === "blocked";
      // (1) Stale base-health gate self-heal on a GREEN base
      if (i.baseVerdict === "green") {
        if (headState.kind === "red_circular_deploy_gate") {
          return {
            kind: "rerun_gate",
            reason: `PR #${i.prNumber} head red is entirely the deploy-health class (${headState.names.join(", ")}) while the base is GREEN — a stale verdict stamped against a superseded main deploy; re-running the failed gate jobs, the red clears or re-convicts on the fresh run`,
          };
        }
        if (i.baseGateGreen !== false && headState.kind === "red_circular_main_green_gate") {
          return {
            kind: "rerun_gate",
            reason: `PR #${i.prNumber} head red is entirely the main-green gate class (${headState.names.join(", ")}) while main's tip now judges fully green under the gate's own predicate — a stale conviction stamped against a transiently-unsettled or since-settled tip (BR#5883); re-running the gate job, the red clears or re-convicts on the fresh run`,
          };
        }
      }
      // (2) Blocked with pending or red head checks
      if (blocked) {
        if (headState.kind === "pending") {
          return {
            kind: "skip",
            reason: `PR #${i.prNumber} mergeStateStatus=blocked — required checks re-running on head ${i.headSha.slice(0, 9)} (${headState.unsettled.join(", ")}) — pending, not a defect; next tick`,
          };
        }
        // BR#6012: when the base is non-green and the PR's ONLY failing head
        // check is a circular base-health gate (`Deploy health (merge gate)` /
        // `main-green gate`), the PR is held on the base, not broken on its own
        // code — fall through to (3) so it returns `skip` ("base main RED / not
        // green") and classifies as `waiting`/`ready` instead of `blocked`.
        const onlyCircularBaseGate =
          i.baseVerdict !== "green" &&
          (headState.kind === "red_circular_deploy_gate" ||
            headState.kind === "red_circular_main_green_gate" ||
            headState.kind === "red_circular_mixed_gates");
        if (headState.kind !== "green" && !onlyCircularBaseGate) {
          return {
            kind: "note",
            reason: `PR #${i.prNumber} head check RED: ${headState.names.join(", ")} — card queued (not in_review), no bounce; the linked session owns it`,
          };
        }
      }
      // (3) Non-green base
      if (i.baseVerdict !== "green") {
        const w = i.baseVerdict === "red" ? "RED" : "not green";
        return {
          kind: "skip",
          reason: `base main ${w} — the standing order never merges onto a non-green destination; the stop-the-line sweep owns the alert`,
        };
      }
      // (4) Green base, non-blocked head check states
      if (headState.kind === "pending") {
        return {
          kind: "skip",
          reason: `head checks unsettled (${headState.unsettled.join(", ")}) — not yet, skip this tick`,
        };
      }
      if (headState.kind !== "green") {
        const names = headState.names.join(", ");
        return i.cardStatus === "in_review"
          ? { kind: "bounce", defect: `PR #${i.prNumber} head check RED: ${names}. Fix or bounce to impl`, bounceKind: "gate" }
          : { kind: "note", reason: `PR #${i.prNumber} head check RED: ${names} — card not in_review, no bounce; the linked session owns it` };
      }
      // (5) Mechanically sound + base green + head green -> Merge.
      // BR#4687 (L1.2): the behind pre-clear is PROVENANCE-GATED. The train
      // machine-updates branches its own fleet authored (every commit's
      // GitHub author on the worker allowlist); a protected human branch is
      // not the train's to move — it still bounces to its owner with the
      // named state. Fail-closed: an input that does not say
      // worker-authored is human-treated.
      const behindPrecleared = behind && i.trainOwnedBranch === true;
      if (behind && !behindPrecleared) {
        return {
          kind: "bounce",
          defect: `PR #${i.prNumber} mergeStateStatus=behind against base on a protected (non-worker-authored) branch — the train does not move human branches. Rebase, re-sign, re-push and re-enter the queue`,
          bounceKind: "gate",
        };
      }
      return {
        kind: "merge",
        receipt: `PR #${i.prNumber} merged by the serialized merge train (BR#3516) leg ${legNumber}/${legsTotal}: head ${i.headSha.slice(0, 9)} — verdict covers head (stamp/carry), 5c gate pass (mergeable, ${behindPrecleared ? "behind pre-cleared — worker-authored branch, the merge leg's machine-clean update-branch carries the verdict (BR#3516 §5, BR#4687)" : blocked ? "blocked pre-cleared — the BR verify verdict is the approval of record (BR#4633 L4.2)" : "clean"}, ${i.commits.length} verified commits), base green, head checks green`,
      };
    }
  }
}

// ---- train event copy (titles/briefs — the ask contract: ≤240, ends "?") ----

/** Legacy-executor shim (BR#4066): executors predating the bounce_kind field
 *  still name coverage in their defect text — these phrases only ever appear
 *  on a coverage bounce (the verdict-coverage rows of decideMergeAction /
 *  decideTrainGate). Matched case-insensitively against the defect. */
export const TRAIN_COVERAGE_DEFECT_RE =
  /moved past the (accepted )?(verify )?verdict|not covered by the accepted verdict|re-verify (at )?the new head/i;

/** The ONE place a train bounce's kind is decided (BR#4066): an explicit
 *  bounce_kind from the executor wins; otherwise infer from what the legacy
 *  event carries — conflict files mean conflict, coverage defect text means
 *  coverage, anything else is a gate defect. The inference never MANUFACTURES
 *  conflict language: a kindless file-less event renders as the honest gate
 *  copy, never as "conflicts with its base". */
export function resolveTrainBounceKind(input: {
  bounceKind?: string | null;
  conflictFiles?: string[];
  defect?: string | null;
}): TrainBounceKind {
  const k = String(input.bounceKind ?? "").trim().toLowerCase();
  if (k === "coverage" || k === "conflict" || k === "gate") return k;
  if ((input.conflictFiles ?? []).length) return "conflict";
  if (input.defect && TRAIN_COVERAGE_DEFECT_RE.test(input.defect)) return "coverage";
  return "gate";
}

/** train:bounced fix-up brief — per bounce KIND (BR#4066). A coverage bounce
 *  names the authored head-move and hands the card to the verify pool (no
 *  conflict language, no file list — none exist). A conflict bounce lists the
 *  files and names the impl repair leg. A gate bounce quotes the named
 *  defect. The prior brief rendered EVERY bounce as "conflicts with its base
 *  … (no file list supplied)", which sent impl hunting for conflicts that
 *  were never there. */
/** BR#5349 (Ray directive 2026-11-01): the base-red gate-bounce class — the
 *  PR is mechanically clean (mergeable, signed) and its RED is MAIN's own,
 *  not the PR's. Two shapes name it: the executor's head-check defect where
 *  a red name is the circular deploy-health gate (DEPLOY_HEALTH_PATTERN —
 *  the check exists to judge main), and any defect that names main red
 *  directly. Telling impl "rebase / re-sign / re-approve" for this class is
 *  the BR#5193 circular-park waste (verify sessions re-prove clean PRs while
 *  main stays red). Returns the red check names the defect carries (possibly
 *  empty), or null when the bounce is genuinely the PR's to fix. */
export function trainBaseRedDefect(defect: string | null | undefined): string[] | null {
  const d = String(defect ?? "");
  if (!d) return null;
  const names = (d.match(/head check RED: ([^.;]+)/i)?.[1] ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (names.some((n) => n.toLowerCase().includes(DEPLOY_HEALTH_PATTERN))) return names;
  if (/\bmain\b[^.;]{0,60}\bRED\b/i.test(d) || /\bbase[-_ ]?red\b/i.test(d)) return names;
  return null;
}

export function trainBounceBrief(input: {
  prNumber: number;
  repo: string;
  headSha: string | null;
  conflictFiles: string[];
  verdictId: string | null;
  /** explicit kind from the executor; absent → resolved from the event
   *  (resolveTrainBounceKind) so legacy executors still render honestly */
  bounceKind?: TrainBounceKind | string | null;
  mergeStateStatus?: string | null;
  /** the gate's defect text (the train_event's reason) */
  defect?: string | null;
  /** BR#5349: the lane's active fix-forward card (OPEN task tagged
   *  hotfix+main-red in the lane's project) — named by the base-red plain
   *  brief so impl knows WHERE the cure lives instead of re-proving a clean
   *  PR. Absent → the brief says so honestly. */
  fixCard?: { id: string; url?: string; title?: string; status?: string } | null;
}): string {
  const kind = resolveTrainBounceKind(input);
  const at = input.headSha ? ` at head ${input.headSha.slice(0, 9)}` : "";
  const verdict = input.verdictId ? ` (${input.verdictId})` : "";
  if (kind === "coverage") {
    return [
      `Merge-train bounce (coverage): PR #${input.prNumber} (${input.repo}) head moved past the accepted verify verdict${at} — the push was authored; this is NOT a merge conflict (no conflicting files exist).`,
      ``,
      `**Next owner: the verify pool** — re-verify at the new head.`,
      ``,
      `**Law (BR#3516 §5):** an authored push invalidates the prior verdict${verdict} at the new head — machine-clean carries, human-resolved invalidates. Once a fresh verify accepts the new head, the train re-queues the card at the BACK.`,
    ].join("\n");
  }
  if (kind === "gate") {
    const defect = (input.defect ?? "").trim();
    // BR#5349: base-red class — the PR is fine, MAIN is red. Plain words,
    // zero jargon (Ray: "loud and clear and direct with no jargon") — never
    // the mechanical rebase/re-sign loop on a clean PR.
    const baseRed = trainBaseRedDefect(defect);
    if (baseRed) {
      const names = baseRed.join(", ") || "the required checks";
      const fix = input.fixCard
        ? `${input.fixCard.id}${input.fixCard.status === "in_progress" ? " (in progress)" : input.fixCard.status === "in_review" ? " (in review)" : input.fixCard.status === "todo" ? " (not started)" : input.fixCard.status === "blocked" ? " (parked)" : ""}`
        : "the base-fix card (none open yet — the episode's MERGE TRAIN BLOCKED ask names the cure)";
      return [
        `Merge-train bounce (base-red): PR #${input.prNumber} (${input.repo}) is mechanically clean${at} — MAIN is red (${names}), and this PR's merge-gate red inherits it.`,
        ``,
        `**Your PR is fine — nothing to do on this PR.** It is held until main clears: the fix lives on ${fix} · or re-run the flaky check · or bypass-merge a cure PR.`,
        ``,
        `Once main is green the train re-queues this PR at the back${verdict} and a fresh verify accepts it (BR#3516 §5).`,
      ].join("\n");
    }
    return [
      `Merge-train bounce (gate): PR #${input.prNumber} (${input.repo}) failed the mechanical merge gate${at}.${input.mergeStateStatus ? ` mergeStateStatus=${String(input.mergeStateStatus).toUpperCase()}.` : ""}`,
      ``,
      `**Defect:** ${defect || "(executor reported no defect text)"}`,
      ``,
      `**Next owner: impl** — fix the named defect (rebase / re-sign / re-approve as it names), re-enter review; the train re-queues at the BACK once a fresh verify accepts the new head (BR#3516 §5).`,
    ].join("\n");
  }
  const files = input.conflictFiles.length
    ? input.conflictFiles.map((f) => `- \`${f}\``).join("\n")
    : `- **(CONFLICT BOUNCE WITHOUT A FILE LIST — executor defect: the trial merge must supply the files; report this)**`;
  return [
    `Merge-train bounce (conflict): PR #${input.prNumber} (${input.repo}) conflicts with its base${at}.`,
    ``,
    `**Conflicting files:**`,
    files,
    ``,
    `**Next owner: the impl repair leg** — resolve the conflict, push, re-enter review.`,
    ``,
    `**Law (BR#3516 §5):** conflict resolution is authored code ⇒ the prior verdict${verdict} is INVALID at the new head — machine-clean carries, human-resolved invalidates. The train re-queues at the BACK once a fresh verify accepts the new head.`,
  ].join("\n");
}

// ---- Awaiting review park (BR#4962, per accepted BR#4960) ----

/** The blocked reason a coverage-bounced card parks under. Per BR#4960 there
 *  is NO ask: the card IS the visibility — it parks `blocked` under this
 *  typed reason (verdict + anchored head inline, plain reading) and the
 *  human force-reviews it from the backlog. The merge-train queue
 *  derivation filters on `merge-train:` reasons, so an Awaiting card drops
 *  out of the queue naturally; the backlog's Awaiting filter is how it is
 *  seen and acted on. */
export const TRAIN_AWAITING_REASON_PREFIX = "Awaiting review (verdict ";

export function trainAwaitingReason(verdictId: string | null, headSha: string | null): string {
  return `Awaiting review (verdict ${verdictId ?? "unrecorded"}, anchored at head ${String(headSha ?? "").slice(0, 9) || "unknown"})`;
}

/** BR#5226: the coverage-bounce classes that genuinely need a HUMAN leg — the
 *  only Awaiting parks (BR#4960: a human is involved only where a machine
 *  verdict cannot be). A machine-clean lapse (the head moved, no files, the
 *  verdict merely lapsed) is the verify pool's business and bounces to impl
 *  instead. These classes invalidated the verdict by HUMAN action or name a
 *  human-only environment defect:
 *  - human-resolved conflicts (the event carries conflict files — resolution
 *    is authored code, the verdict is dead at the new head);
 *  - a dismissed external review with no machine replacement;
 *  - the signing-environment class (key unavailable / NO_USER — the verify
 *    gate's only human escalation). */
export const TRAIN_HUMAN_LEG_DISMISS_RE =
  /\bdismiss\w*[\s\S]{0,60}\b(?:review|approval)s?\b|\b(?:review|approval)s?\b[\s\S]{0,60}\bdismiss\w*\b/i;
export const TRAIN_HUMAN_LEG_SIGNING_RE = /\bsigning environment\b|\bkey unavailable\b|\bNO_USER\b/i;

export function trainAwaitingHumanLeg(defect: string | null | undefined, conflictFiles: readonly string[]): boolean {
  if (conflictFiles.length) return true;
  const d = String(defect ?? "");
  return TRAIN_HUMAN_LEG_DISMISS_RE.test(d) || TRAIN_HUMAN_LEG_SIGNING_RE.test(d);
}

/** BR#5226: the in-place re-queue swap every machine re-entry shares —
 *  blocked→blocked is an illegal edge, so the parked reason refreshes under
 *  the card: merge_train back to `queued`, the awaiting stamp cleared, the
 *  BR#4068 boost decayed (re-entry rejoins the normal ranks), the typed
 *  pr_merged await_event and every stamp untouched. */
export function trainRequeueSwap(meta: any): any {
  const m = meta && typeof meta === "object" ? { ...meta } : {};
  m.merge_train = { ...(m.merge_train ?? {}), state: "queued" };
  delete m.merge_train.awaiting;
  clearConflictingEpisode(m.merge_train); // BR#6348: re-queue ends the conflicting episode
  delete m.boosted;
  m.blocked = { ...(m.blocked ?? {}), reason: MERGE_TRAIN_QUEUED_REASON };
  return m;
}

/** The Awaiting park's visible-age window — knob `train.awaiting_ttl_h`
 *  (legacy `train.review_ask_ttl_h` falls back), clamped 1..720, default 24.
 *  The park NEVER expires itself (BR#4960: visibility without interruption —
 *  a lapsed Awaiting card still reads in the backlog filter); the knob feeds
 *  the train panel's aging chip only. */
export const TRAIN_AWAITING_TTL_H_DEFAULT = 24;

/** The visible-age grace past the TTL before an Awaiting chip reads LAPSED
 *  (red) on the train panel — `aging` (amber) starts AT the TTL. */
export const TRAIN_AWAITING_GRACE_MS = 2 * 60 * 60_000;

export function clampAwaitingTtlHours(...candidates: unknown[]): number {
  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return Math.min(720, Math.max(1, n));
  }
  return TRAIN_AWAITING_TTL_H_DEFAULT;
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

/** Deterministic base-red alarm ask title (BR#5265 Fix A — ONE per red
 *  episode; the red-name set makes it unique per episode, askCreate's
 *  identical-open-ask guard dedupes the per-tick repeats). ≤240 chars,
 *  ends "?" — the ask contract. */
export function trainBaseRedAskTitle(lane: { repo: string; base: string }, reds: string[]): string {
  const prefix = `MERGE TRAIN BLOCKED: base ${lane.repo}@${lane.base} RED (`;
  const suffix = `) — the queue is held until it clears. Fix it?`;
  const budget = 240 - prefix.length - suffix.length;
  let names = reds.join(", ") || "unknown check";
  if (names.length > budget) names = names.slice(0, Math.max(0, budget - 1)).trimEnd() + "…";
  return prefix + names + suffix;
}

/** Deterministic gate-blocked alarm ask title (BR#5883 — ONE per gate-blocked
 *  episode; the gate-red-name set makes it unique per episode, askCreate's
 *  identical-open-ask guard dedupes the per-tick repeats). ≤240 chars, ends
 *  "?" — the ask contract. */
export function trainGateBlockedAskTitle(lane: { repo: string; base: string }, gateReds: string[]): string {
  const prefix = `MERGE TRAIN GATE-BLOCKED: ${lane.repo}@${lane.base} passes its required workflows but the repo merge gate judges main RED (`;
  const suffix = `) — merges fail until it clears. Fix it?`;
  const budget = 240 - prefix.length - suffix.length;
  let names = gateReds.join(", ") || "unknown check";
  if (names.length > budget) names = names.slice(0, Math.max(0, budget - 1)).trimEnd() + "…";
  return prefix + names + suffix;
}

/** The gate-blocked ask's live brief (BR#5883): the lane's required
 *  workflows are green — the P1 base alarm reads NONE — while the repo's own
 *  merge gate (`main-green gate`, which judges main's WHOLE tip) fails every
 *  open PR. This is the exact 2026-11-03 starve shape that stayed silent for
 *  3.5h+ because the required-scoped verdict certified green. The brief is
 *  self-contained: what the gate sees, what is held, and the ways it clears. */
export function trainGateBlockedAskBrief(
  lane: { repo: string; base: string },
  gateReds: { name: string; url?: string }[],
  gateUnsettled: string[],
  held: number,
): { details: string; options: string[] } {
  const broken = gateReds.length
    ? gateReds.map((r) => `- ${r.name}${r.url ? ` — ${r.url}` : ""}`).join("\n")
    : "- (no failing checks — the gate is waiting on checks that have not finished)";
  const unsettled = gateUnsettled.length ? gateUnsettled.map((n) => `- ${n}`).join("\n") : "";
  const details = [
    `The merge train on **${lane.repo}** (${lane.base}) is gate-blocked: the lane's required workflows are ALL green — the usual red alarm reads none — but the repo's own merge gate check (\`main-green gate\`, which judges the WHOLE tip of ${lane.base}, not just the required list) is failing on these checks:`,
    broken,
    ...(unsettled ? [``, `Still running / inconclusive (the gate refuses these too):`, unsettled] : []),
    ``,
    `Every open PR's \`main-green gate\` run re-judges main's tip and fails while these are red, so ${held} queued change(s) cannot merge — the train looks idle-but-green while it is actually stopped. This exact shape starved the 2026-11-03 queue for 3.5h+ with no alarm (the required-scoped verdict certified green).`,
    ``,
    `Ways it clears: fix forward (land the cure for the named check), re-run a transient failure once its premise settled, or the check self-heals on the next tip it judges green. A stale \`main-green gate\` red on a PR re-runs automatically now (BR#5883 self-heal) when main's tip judges fully green.`,
  ].join("\n");
  return {
    details,
    options: ["(Recommended) Investigate the named checks now", "Re-run the named checks (if transient)", "Hold — I'll handle it myself"],
  };
}

/** Plain status words for a human ask/banner (BR#5349: no jargon) — the
 *  hub-side mirror of TrainPanel's plainStatus. */
export function trainPlainStatus(s: string | undefined): string {
  return s === "in_progress" ? "in progress"
    : s === "in_review" ? "in review"
    : s === "todo" ? "not started"
    : s === "blocked" ? "parked"
    : s ?? "";
}

/** The base-red alarm ask's LIVE brief (2026-11-02 Ray directive): the ask
 *  is a triage view, not a one-shot alarm. What is broken (links), what is
 *  held, where the fix work lives (the episode's root-fix card BR#5190 +
 *  its cure PR once one binds), the PR that broke main, and the four ways
 *  the red clears — transient/retry, bypass-merge the cure, manual steps,
 *  no-resolution-yet (keep digging). Plain words only (BR#5349): no "car",
 *  no "lane", no "verdict", no "episode". The options carry the cure PR's
 *  NUMBER when one exists — never again "Bypass-merge a cure PR (I'll
 *  reply with the number)", an option that demanded a number the one-shot
 *  ask could never learn: the executor refreshes the open ask in place
 *  every tick while the base is red, so the number surfaces the moment it
 *  binds to the fix card. */
export function trainBaseRedAskBrief(
  lane: { repo: string; base: string },
  reds: { name: string; url?: string }[],
  held: number,
  fix: {
    card: { id: string; title?: string; status?: string; exhausted?: boolean; blocked_reason?: string } | null;
    curePr: { repo: string; number: number } | null;
    culpritPr: number | null;
  },
): { details: string; options: string[] } {
  const broken = reds.length
    ? reds.map((r) => `- ${r.name}${r.url ? ` — ${r.url}` : ""}`).join("\n")
    : "- (the failing check names were not available this tick)";
  // BR#5516: triage-before-menu — the ask carries a first-hand READ of each
  // red check (name-shape classification; the hub has no logs, so this is
  // honest about what is knowable hub-side) so the human never answers the
  // template default blind. The 2026-11-02 episode: "Transient — re-run" was
  // answered on a structurally self-failing gate run, burning a cycle and
  // re-arming the ask.
  const readOf = reds.map((r) => {
    const n = r.name.toLowerCase();
    if (/\bgate\b|main[- ]green/.test(n))
      return `- ${r.name}: the gate itself is the failing check — almost always self-referential or destination-state, and a re-run fails IDENTICALLY. Read the gate log, then fix forward or bypass-merge the cure. Do not answer RETRY blind.`;
    if (/deploy|smoke|health/.test(n))
      return `- ${r.name}: a deploy-side check — the deployed state is failing, not the merge diff. Check the deploy logs before re-running anything.`;
    return `- ${r.name}: diagnosis pending — a session must read the failing job log before RETRY is safe; re-running a structural failure burns a cycle and re-arms this ask.`;
  });
  const details = [
    `Main on **${lane.repo}** is broken: these required checks are failing on its latest commit (${lane.base}):`,
    broken,
    ``,
    `**Read of the red (triage before you answer):**`,
    ...(readOf.length ? readOf : ["- (no check names this tick — hold the line)"]),
    ``,
    `**${held} PR${held === 1 ? "" : "s"} held.** Nothing merges until main is green again — that is deliberate: no change lands on top of a broken main. The queue drains by itself the moment main recovers; nothing further is needed from you then.`,
    ``,
    `**Where the fix work lives:**`,
    fix.card
      ? `- Fix card ${fix.card.id}${fix.card.status ? ` (${trainPlainStatus(fix.card.status)})` : ""}${fix.card.title ? ` — ${fix.card.title}` : ""}`
      : `- No fix card is open yet — the red has not been diagnosed; the next agent session picks it up from the queue.`,
    fix.curePr
      ? `- A fix PR is open: ${fix.curePr.repo}#${fix.curePr.number} — https://github.com/${fix.curePr.repo}/pull/${fix.curePr.number}`
      : `- No fix PR is open yet — it appears here automatically the moment one binds to the fix card.`,
    fix.culpritPr ? `- The PR that broke main: #${fix.culpritPr}` : ``,
    // BR#6390 (Ray 2026-11-05): a bound cure PR turns the ask into a HUMAN
    // GATE — "do this thing and click DONE when done to unblock". The act is
    // YOURS (out-of-turn bypass merge is human authority, BR#4122/BR#5450:
    // "I am the bypass actor — do not try and automate bypass merges, you
    // MUST escalate to me"); the options say whether it is done, nothing else.
    ...(fix.curePr
      ? [
          ``,
          `# HUMAN GATE — your one action`,
          `Merge fix PR **${fix.curePr.repo}#${fix.curePr.number}** yourself, then click **DONE** below:`,
          ``,
          `1. Open the PR: https://github.com/${fix.curePr.repo}/pull/${fix.curePr.number}`,
          `2. Merge it (Squash and merge — you hold the bypass) or run:`,
          `   \`\`\``,
          `   gh pr merge ${fix.curePr.number} --repo ${fix.curePr.repo} --admin --squash`,
          `   \`\`\``,
          `3. Come back here and click **DONE — PR #${fix.curePr.number} merged**.`,
          ``,
          `Why you: main is red on the check(s) above, so the required branch gate fails on every PR — including this fix PR itself — until the fix lands on \`${lane.base}\`. Bridge's gateway cannot bypass branch protection (no admin). When you click DONE, the train picks up the merge, waits out main's deploy, and the ${held} held PR${held === 1 ? "" : "s"} drain automatically.`,
          ``,
          `If you **DECLINE**: the line holds — nothing merges until main is green again, and agent sessions keep fixing on ${fix.card ? fix.card.id : "the fix card"}. The queue drains by itself the moment main recovers.`,
        ]
      : fix.card?.exhausted
        ? [
            ``,
            `**Why this needs you (automatic fix work is stuck):**`,
            `- Fix card **${fix.card.id}** stopped progressing after repeated attempts${fix.card.blocked_reason ? ` (${fix.card.blocked_reason})` : ""} without producing a mergeable fix PR, and no agent is currently working on it.`,
            `- Choose **Re-arm** to reset and re-queue ${fix.card.id} at top priority for a fresh agent session, **Transient** to re-run the failing check on GitHub, or **Other** to describe manual steps.`,
          ]
        : []),
    ``,
    fix.curePr
      ? `**Other ways this clears:** the fix lands through the line itself once main recovers (no action from you), a transient check clears on re-run, or you answer in your own words with manual steps.`
      : `**The four ways this clears:** (1) transient — internet weather or a flaky check: answer RETRY and the check re-runs; (2) manual steps on your side: answer OTHER and describe them; (3) no resolution found yet: the fix card stays open and agent sessions keep digging — the queue still drains itself once main is green; (4) if a fix PR binds later, this ask becomes a HUMAN GATE (you merge it, click DONE).`,
  ].filter((l) => l !== undefined).join("\n");
  // BR#6390 (Ray 2026-11-05): the cure-bound ask is ACCEPT/DECLINE shape —
  // "just to say if it is done or not". DONE records the human's merge
  // (trainAlarmAnswerDispatch stamps lane.bypass_merge so the executor's next
  // tick observes/lands it); DECLINE holds the line and suppresses re-asks
  // for this episode+PR. Free text remains available for anything else.
  const options = fix.curePr
    ? [
        `DONE — PR #${fix.curePr.number} merged`,
        `DECLINE — hold the line`,
      ]
    : fix.card?.exhausted
      ? [
          `Other — manual steps (I'll reply)`,
          `Re-arm — re-issue the fix card with fresh direction`,
          `Hold the line — the queue drains itself once main is green`,
        ]
      : [
          `Hold the line — the fix work continues${fix.card ? ` on ${fix.card.id}` : ""}`,
          `Transient — re-run the failing check`,
          `Other — manual steps (I'll reply)`,
          `No resolution yet — keep digging on the fix card`,
        ];
  return { details, options };
}

/** 2026-11-03 Ray ruling (BR#5631, from the BR#5626 escalation): the
 *  base-red alarm asks the human ONLY when the episode has a
 *  human-actionable act on the table —
 *  - a cure PR is bound to the fix work (the out-of-turn bypass merge is
 *    human authority, BR#4122: "Give me the PR url and ask to bypass"), or
 *  - the fix path is EXHAUSTED (the fix card churned out of attempts or is
 *    escalated — manual steps / a fresh human direction are the only
 *    levers left).
 *  Everything else is agent-workable and fully automatic: root-fix card at
 *  absolute p0 (BR#5190), lane BLOCKED reason + banner (what's broken, PRs
 *  held, fix card link — informational, ask:null), queue self-drains the
 *  moment main is green (BR#4692). An ask there would only demand a
 *  pointless "keep going" click. */
/** BR#6012 closed state machine for a base-red episode's resolution phase.
 *  Makes illegal states unrepresentable:
 *  - `diagnosing` / `fix_in_progress` / `cure_pr_conflicting` NEVER warrant a
 *    human ask (`warrantAsk: false`) and NEVER carry a `curePr`.
 *  - `cure_pr_awaiting_force_merge` ALWAYS carries a non-conflicting `curePr`
 *    owned by `card` and the exact `--admin` command.
 *  - `fix_exhausted` warrants a manual-intervention ask with `curePr: null`. */
export type BaseRedEpisodeState =
  | {
      phase: "diagnosing";
      warrantAsk: false;
      card: null;
      curePr: null;
      conflictPr: null;
      mergedPr: null;
      culpritPr: number | null;
    }
  | {
      phase: "fix_in_progress";
      warrantAsk: false;
      card: { id: string; title: string; status: string; exhausted: false };
      curePr: null;
      conflictPr: null;
      mergedPr: null;
      culpritPr: number | null;
    }
  | {
      phase: "cure_pr_conflicting";
      warrantAsk: false;
      card: { id: string; title: string; status: string; exhausted?: boolean };
      curePr: null;
      conflictPr: { repo: string; number: number };
      mergedPr: null;
      culpritPr: number | null;
    }
  | {
      phase: "cure_pr_merged_awaiting_ci";
      warrantAsk: false;
      card: { id: string; title: string; status: string; exhausted?: boolean };
      curePr: null;
      conflictPr: null;
      mergedPr: { repo: string; number: number; merge_sha: string };
      culpritPr: number | null;
    }
  | {
      phase: "cure_pr_awaiting_force_merge";
      warrantAsk: true;
      card: { id: string; title: string; status: string; exhausted?: boolean };
      curePr: { repo: string; number: number };
      conflictPr: null;
      mergedPr: null;
      culpritPr: number | null;
      command: string;
    }
  | {
      phase: "fix_exhausted";
      warrantAsk: true;
      card: { id: string; title: string; status: string; exhausted: true };
      curePr: null;
      conflictPr: null;
      mergedPr: null;
      culpritPr: number | null;
    };

export function classifyBaseRedEpisodeState(fix: {
  card?: { id?: string; title?: string; status?: string; exhausted?: boolean } | null;
  curePr?: { repo: string; number: number } | null;
  conflictPr?: { repo: string; number: number } | null;
  mergedPr?: { repo: string; number: number; merge_sha: string } | null;
  culpritPr?: number | null;
}): BaseRedEpisodeState {
  const culpritPr = fix?.culpritPr ?? null;
  const rawCard = fix?.card && fix.card.id
    ? {
        id: String(fix.card.id),
        title: String(fix.card.title ?? ""),
        status: String(fix.card.status ?? ""),
        exhausted: !!fix.card.exhausted,
      }
    : null;
  if (fix?.curePr && Number.isInteger(fix.curePr.number) && fix.curePr.number > 0 && !fix.conflictPr && !fix.mergedPr) {
    const card = rawCard ?? {
      id: `PR#${fix.curePr.number}`,
      title: "",
      status: "blocked",
      exhausted: false,
    };
    return {
      phase: "cure_pr_awaiting_force_merge",
      warrantAsk: true,
      card,
      curePr: { repo: fix.curePr.repo, number: fix.curePr.number },
      conflictPr: null,
      mergedPr: null,
      culpritPr,
      command: `gh pr merge ${fix.curePr.number} --repo ${fix.curePr.repo} --admin --squash`,
    };
  }
  if (fix?.mergedPr && Number.isInteger(fix.mergedPr.number) && fix.mergedPr.number > 0) {
    const card = rawCard ?? {
      id: `PR#${fix.mergedPr.number}`,
      title: "",
      status: "in_progress",
      exhausted: false,
    };
    return {
      phase: "cure_pr_merged_awaiting_ci",
      warrantAsk: false,
      card,
      curePr: null,
      conflictPr: null,
      mergedPr: { repo: fix.mergedPr.repo, number: fix.mergedPr.number, merge_sha: String(fix.mergedPr.merge_sha ?? "") },
      culpritPr,
    };
  }
  if (fix?.conflictPr && Number.isInteger(fix.conflictPr.number) && fix.conflictPr.number > 0 && rawCard) {
    return {
      phase: "cure_pr_conflicting",
      warrantAsk: false,
      card: rawCard,
      curePr: null,
      conflictPr: { repo: fix.conflictPr.repo, number: fix.conflictPr.number },
      mergedPr: null,
      culpritPr,
    };
  }
  if (!rawCard) {
    return { phase: "diagnosing", warrantAsk: false, card: null, curePr: null, conflictPr: null, mergedPr: null, culpritPr };
  }
  if (rawCard.exhausted) {
    return {
      phase: "fix_exhausted",
      warrantAsk: true,
      card: { ...rawCard, exhausted: true },
      curePr: null,
      conflictPr: null,
      mergedPr: null,
      culpritPr,
    };
  }
  return {
    phase: "fix_in_progress",
    warrantAsk: false,
    card: { ...rawCard, exhausted: false },
    curePr: null,
    conflictPr: null,
    mergedPr: null,
    culpritPr,
  };
}

export function trainBaseRedAskWarranted(fix: {
  card?: { id?: string; title?: string; status?: string; exhausted?: boolean } | null;
  curePr?: unknown;
  conflictPr?: unknown;
  mergedPr?: unknown;
}): boolean {
  const curePr =
    fix?.curePr && typeof fix.curePr === "object" && Number.isInteger((fix.curePr as any).number) && (fix.curePr as any).number > 0
      ? { repo: String((fix.curePr as any).repo ?? ""), number: Number((fix.curePr as any).number) }
      : fix?.curePr != null
        ? { repo: "repo", number: 1 }
        : null;
  const conflictPr =
    fix?.conflictPr && typeof fix.conflictPr === "object" && Number.isInteger((fix.conflictPr as any).number) && (fix.conflictPr as any).number > 0
      ? { repo: String((fix.conflictPr as any).repo ?? ""), number: Number((fix.conflictPr as any).number) }
      : null;
  const mergedPr =
    fix?.mergedPr && typeof fix.mergedPr === "object" && Number.isInteger((fix.mergedPr as any).number) && (fix.mergedPr as any).number > 0
      ? { repo: String((fix.mergedPr as any).repo ?? ""), number: Number((fix.mergedPr as any).number), merge_sha: String((fix.mergedPr as any).merge_sha ?? "") }
      : null;
  const card = fix?.card
    ? { id: String(fix.card.id ?? "BR#0"), title: fix.card.title, status: fix.card.status, exhausted: !!fix.card.exhausted }
    : null;
  return classifyBaseRedEpisodeState({ card, curePr, conflictPr, mergedPr }).warrantAsk;
}

/** BR#6012 canonical 4-state operational state machine for a merge lane.
 *  Resolves `stop`, `currently`, and `base_red_resolution` into a single
 *  mutually-exclusive `LaneOperationalState` (`idle` | `draining_batch` |
 *  `settling_ci` | `stopped_red`), persisted atomically in the `lane_state`
 *  SQLite table so the hub and UI never reconstruct state from contradictory
 *  fragments. */
export function resolveLaneOperationalState(input: {
  baseState?: { verdict?: string; tip_sha?: string; red?: { name: string; url?: string }[] } | null;
  stop?: {
    sha?: string;
    reason?: string;
    failing?: { name: string; url?: string }[];
    culprit_task?: string;
  } | null;
  currently?: {
    phase?: string;
    pr?: number;
    merge_sha?: string;
    task_id?: string;
    merged_at?: number;
    burst_merged?: number;
    burst_cap?: number;
  } | null;
  episodeState?: BaseRedEpisodeState | null;
  fixCard?: TrainFixCard | null;
  now: number;
}): LaneOperationalState {
  const { currently, episodeState, fixCard, now } = input;
  const stop = input.baseState?.verdict === "red" && input.baseState.tip_sha
    ? { sha: input.baseState.tip_sha, failing: input.baseState.red ?? [], culprit_task: input.stop?.culprit_task }
    : input.stop;
  if (stop && stop.sha) {
    const failingChecks = Array.isArray(stop.failing)
      ? stop.failing.map((f) => ({ name: String(f.name ?? ""), ...(f.url ? { url: String(f.url) } : {}) })).filter((f) => f.name)
      : [];
    return {
      phase: "stopped_red",
      failing_sha: String(stop.sha),
      failing_checks: failingChecks,
      culprit_task: stop.culprit_task ? String(stop.culprit_task) : null,
      episode_phase: episodeState?.phase ?? "diagnosing",
      fix_card: fixCard ?? null,
      updated_ts: now,
    };
  }
  if (currently && Number(currently.pr) > 0 && currently.merge_sha) {
    if (currently.phase === "bursting") {
      return {
        phase: "draining_batch",
        pr: Number(currently.pr),
        merge_sha: String(currently.merge_sha),
        task_id: currently.task_id ? String(currently.task_id) : null,
        burst_merged: Math.max(0, Math.floor(Number(currently.burst_merged ?? 1))),
        burst_cap: Math.max(0, Math.floor(Number(currently.burst_cap ?? DEFAULT_BURST_MAX))),
        updated_ts: now,
      };
    }
    if (currently.phase === "awaiting-ci") {
      return {
        phase: "settling_ci",
        pr: Number(currently.pr),
        merge_sha: String(currently.merge_sha),
        task_id: currently.task_id ? String(currently.task_id) : null,
        merged_at: Number(currently.merged_at ?? now),
        updated_ts: now,
      };
    }
  }
  return {
    phase: "idle",
    updated_ts: now,
  };
}

/** BR#5376: the deterministic batch-stall alarm ask title — ONE per stall
 *  episode. Unlike the base-red title it carries NO varying names (the
 *  episode's identity IS the lane): askCreate's identical-open-ask guard
 *  dedupes the per-tick repeats on the exact string, so the title must
 *  contain no tick counts, no ages, no PR lists. ≤240 chars, ends "?" —
 *  the ask contract. */
export function trainStallAskTitle(lane: { repo: string; base: string }): string {
  return `MERGE TRAIN STALLED: ${lane.repo}@${lane.base} — PRs selected to merge are not landing. Restart the executor?`;
}

/** BR#5674 P4: merge-starvation threshold — when a lane holds cars (derived
 *  queue OR awaiting set) with zero merges for >1h and no stop-the-line
 *  episode is active, the hub fires ONE human ask + spawns ONE diagnostic
 *  duty per episode. */
export const TRAIN_MERGE_STARVE_MS = 60 * 60_000;

/** Deterministic merge-starvation ask title (BR#5674 P4 — ONE per starvation
 *  episode; askCreate's identical-open-ask guard dedupes on exact title, so
 *  the title carries no changing minute/car counts). ≤240 chars, ends "?". */
export function trainStarvationAskTitle(lane: { repo: string; base: string }): string {
  const prefix = `MERGE TRAIN STARVED: ${lane.repo}@${lane.base} — `;
  const suffix = `>1h with zero merges while holding cars. Diagnose or bypass?`;
  const budget = 240 - prefix.length;
  return prefix + (suffix.length > budget ? suffix.slice(0, Math.max(0, budget - 1)).trimEnd() + "?" : suffix);
}

export type TrainStarvationDiagnosisInput = {
  lane: { repo: string; base: string };
  laneId: string;
  blockedReason: string;
  baseVerdict: string;
  requiredWorkflows: string[];
  redNames: string[];
  unsettledNames: string[];
  baseAlarm: string | null;
  /** BR#5883: the gate-consumed qualifier's names — what the repo's own
   *  merge gate judges red/unsettled on the tip while the scoped verdict
   *  reads green (empty when no qualifier rode the stamp). */
  gateRedNames?: string[];
  gateUnsettledNames?: string[];
  queue: { id: string; pr?: number }[];
  awaiting: { task: string; pr?: number }[];
  lastMergeTs: number | null;
  mins: number;
  dutyId?: string | null;
};

export function trainStarvationAskDetails(i: TrainStarvationDiagnosisInput): string {
  const qList = i.queue.length
    ? i.queue.map((q) => `${q.id}${q.pr ? ` (PR #${q.pr} on ${i.lane.repo})` : ""}`).join(", ")
    : "none";
  const aList = i.awaiting.length
    ? i.awaiting.map((a) => `${a.task}${a.pr ? ` (PR #${a.pr} on ${i.lane.repo})` : ""}`).join(", ")
    : "none";
  const lastMergeLine = i.lastMergeTs
    ? `${new Date(i.lastMergeTs).toISOString()} (epoch ${i.lastMergeTs} — ${i.mins}m ago)`
    : `none recorded (${i.mins}m without a merge)`;
  const namesLine = i.redNames.length
    ? `red: ${i.redNames.join(", ")}`
    : i.unsettledNames.length
      ? `unsettled: ${i.unsettledNames.join(", ")}`
      : i.requiredWorkflows.length
        ? `required: ${i.requiredWorkflows.join(", ")}`
        : "none";
  return [
    `Merge lane **${i.lane.repo}@${i.lane.base}** (standing lane card ${i.laneId}) has held cars for **${i.mins}m (>1h)** with **zero merges** and no active stop-the-line episode.`,
    ``,
    `**Full diagnosis snapshot:**`,
    `- **Blocked reason:** ${i.blockedReason || "(none)"}`,
    `- **Base verdict:** \`${i.baseVerdict}\` (${namesLine})`,
    ...(i.baseAlarm ? [`- **Base alarm (P1 empty-is-loud):** ${i.baseAlarm}`] : []),
    `- **Queue + awaiting counts:** ${i.queue.length} queued (${qList}) · ${i.awaiting.length} awaiting (${aList})`,
    `- **Last merge timestamp:** ${lastMergeLine}`,
    ...(i.dutyId ? [`- **Auto-spawned diagnostic duty:** ${i.dutyId} (agent-executable task card, tags \`merge-train\`, \`diagnostic\`)`] : []),
    ``,
    `**Why this needs attention:** the lane is holding cars without merging and without a stop-the-line halt (the 2026-11-02/03 10.6h silent-outage class). An agent diagnostic duty has been spawned automatically at top priority to inspect pagination/naming of required workflows, base check-run counts, verify pool depth, and parked card exits. Any merge on this lane clears the episode automatically.`,
  ].join("\n");
}

export function trainStarvationDutyTitle(lane: { repo: string; base: string }, queueCount: number, awaitingCount: number): string {
  const prefix = `Diagnose starved merge train: ${lane.repo}@${lane.base} — `;
  const suffix = `>1h with 0 merges (${queueCount} queued, ${awaitingCount} awaiting)`;
  const budget = 240 - prefix.length;
  return prefix + (suffix.length > budget ? suffix.slice(0, Math.max(0, budget - 1)).trimEnd() + "…" : suffix);
}

export function trainStarvationDutyBody(i: TrainStarvationDiagnosisInput): string {
  return [
    `# Merge-train starvation diagnostic duty — ${i.lane.repo}@${i.lane.base}`,
    ``,
    `Auto-spawned by the P4 starvation alarm (decision BR#5674) because lane **${i.lane.repo}@${i.lane.base}** (card ${i.laneId}) has held cars with **0 merges for ${i.mins}m (>1h)** while no stop-the-line episode is active.`,
    ``,
    `## Diagnosis snapshot at alarm time`,
    `- **Lane:** \`${i.lane.repo}@${i.lane.base}\` (${i.laneId})`,
    `- **Blocked reason:** ${i.blockedReason || "(none)"}`,
    `- **Base verdict:** \`${i.baseVerdict}\``,
    `- **Required workflows:** ${i.requiredWorkflows.length ? i.requiredWorkflows.map((w) => `\`${w}\``).join(", ") : "(unconfigured — whole tip)"}`,
    `- **Failing base checks:** ${i.redNames.length ? i.redNames.join(", ") : "none"}`,
    `- **Unsettled base checks:** ${i.unsettledNames.length ? i.unsettledNames.join(", ") : "none"}`,
    `- **Base alarm (P1):** ${i.baseAlarm ?? "none"}`,
    ...(i.gateRedNames?.length || i.gateUnsettledNames?.length
      ? [
          `- **Gate-blocked (BR#5883):** the scoped verdict reads \`${i.baseVerdict}\` but the repo's own merge gate judges the tip ${i.gateRedNames?.length ? `RED on: ${i.gateRedNames.join(", ")}` : ""}${i.gateUnsettledNames?.length ? `${i.gateRedNames?.length ? "; " : ""}unsettled: ${i.gateUnsettledNames.join(", ")}` : ""} — every queued PR's \`main-green gate\` run fails on these until they settle`,
        ]
      : []),
    `- **Queue count:** ${i.queue.length} (${i.queue.map((q) => `${q.id}${q.pr ? `#${q.pr}` : ""}`).join(", ") || "none"})`,
    `- **Awaiting count:** ${i.awaiting.length} (${i.awaiting.map((a) => `${a.task}${a.pr ? `#${a.pr}` : ""}`).join(", ") || "none"})`,
    `- **Last merge ts:** ${i.lastMergeTs ? `${new Date(i.lastMergeTs).toISOString()} (${i.lastMergeTs}, ${i.mins}m ago)` : `none (${i.mins}m starved)`}`,
    ``,
    `## What to check (agent checklist)`,
    `1. **\`per_page\` / pagination and naming of \`required_workflows\`**: run \`gh api "repos/${i.lane.repo}/commits/${i.lane.base}/check-runs?per_page=100"\` and compare actual check-run names against \`required_workflows\`. Did required runs fall past page 1 or change workflow/job names?`,
    `2. **Base runs count on tip**: verify total check-runs count on \`${i.lane.base}\` tip vs matched required runs (\`base_state.alarm\`). If a required check failed transiently, re-run it (\`gh run rerun\`) or open/bind the root-fix cure PR.`,
    `3. **Verify pool depth**: check \`queue_awaiting_review\` and open \`Verify:\` tasks — are verify duties backed up or bouncing in a coverage loop?`,
    `4. **Park exits (\`awaiting\` / \`blocked\` cards)**: inspect every card in \`awaiting\` and \`queue\` — confirm each has a valid \`head_sha_at_acceptance\` covering its live PR head and a live machine exit (\`awaiting_sweep\` / \`pr_merged\` proxy).`,
  ].join("\n");
}

// ---------- BR#6179 level-based deploy reconciliation (dark-tip self-heal) ----------

/** Default grace window (5 minutes) before an uncovered tip triggers automatic
 *  `workflow_dispatch` and fast-page escalation (BR#6179). */
export const DEPLOY_RECONCILE_GRACE_SECS = 300;

export type DeployWorkflowRun = {
  id: number;
  name: string;
  path?: string | null;
  head_sha: string;
  event?: string | null;
  status?: string | null;
  conclusion?: string | null;
  html_url?: string | null;
};

export type DeployReconcilePlan = {
  coverage: DeployCoverageState;
  /** Workflow filename (e.g. `deploy-dev.yml`) to dispatch via `gh workflow run`
   *  when the tip is uncovered past the grace window and not yet dispatched. */
  dispatch_workflow: string | null;
  /** Redundant queued/waiting/pending workflow run IDs to cancel via `gh run cancel`
   *  because the same `head_sha` is already covered by an `in_progress` or
   *  `completed/success` deploy run (or a newer duplicate queued run). */
  cancel_run_ids: number[];
  /** SHA covered by the newest decisive green deploy run on the branch (if any). */
  covered_by_sha: string | null;
  /** Age of the uncovered tip in seconds (0 when `coverage.phase === "covered"`). */
  coverage_age_secs: number;
};

/** Parse an ISO-8601 timestamp (e.g. `"2026-11-04T08:01:57Z"`) to epoch ms, or null. */
export function parseIso8601EpochMs(s: string | null | undefined): number | null {
  if (!s || typeof s !== "string") return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** True when a workflow run represents the lane's primary deploy workflow
 *  (e.g. `Deploy Dev` / `.github/workflows/deploy-dev.yml`) rather than a
 *  secondary observer/gate (`Deploy Health Record`, `Deploy drift alarm`,
 *  `Deploy health (merge gate)`). Mirrored in `train_gate.rs` `is_deploy_workflow_run`. */
export function isDeployWorkflowRun(r: DeployWorkflowRun, required: string[]): boolean {
  const nameLower = (r.name ?? "").trim().toLowerCase();
  const pathLower = (r.path ?? "").trim().toLowerCase();
  if (
    nameLower.includes("health record") ||
    nameLower.includes("drift alarm") ||
    nameLower.includes("merge gate") ||
    pathLower.endsWith("deploy-health.yml") ||
    pathLower.endsWith("deploy-drift.yml")
  ) {
    return false;
  }
  if (pathLower.endsWith("/deploy-dev.yml") || pathLower === "deploy-dev.yml" || pathLower.endsWith("/deploy.yml") || pathLower === "deploy.yml") {
    return true;
  }
  if (nameLower === "deploy dev" || nameLower === "deploy" || nameLower.startsWith("deploy to ")) {
    return true;
  }
  for (const req of required) {
    const reqLower = req.trim().toLowerCase();
    const slashIdx = reqLower.indexOf(" / ");
    const prefix = slashIdx >= 0 ? reqLower.slice(0, slashIdx).trim() : reqLower;
    if (prefix && (nameLower === prefix || nameLower === `${prefix} dev`)) {
      return true;
    }
  }
  return false;
}

/** Infer the dispatchable workflow filename (e.g. `"deploy-dev.yml"`) from
 *  observed workflow runs and the lane's `required_workflows`. Mirrored in
 *  `train_gate.rs` `infer_deploy_workflow`. */
export function inferDeployWorkflow(required: string[], workflowRuns: DeployWorkflowRun[]): string | null {
  const sorted = [...workflowRuns].sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
  for (const r of sorted) {
    if (!isDeployWorkflowRun(r, required)) continue;
    const rawPath = (r.path ?? "").trim();
    if (rawPath) {
      const file = rawPath.split("/").pop() ?? "";
      if ((file.endsWith(".yml") || file.endsWith(".yaml")) && file !== "deploy.yml") {
        return file;
      }
    }
  }
  for (const r of sorted) {
    if (!isDeployWorkflowRun(r, required)) continue;
    const rawPath = (r.path ?? "").trim();
    if (rawPath) {
      const file = rawPath.split("/").pop() ?? "";
      if (file.endsWith(".yml") || file.endsWith(".yaml")) {
        return file;
      }
    }
    if ((r.name ?? "").trim().toLowerCase() === "deploy dev") {
      return "deploy-dev.yml";
    }
  }
  const hasDeployReq = required.some((w) => {
    const lw = w.trim().toLowerCase();
    return lw.startsWith("deploy /") || lw.startsWith("post-deploy /") || lw === "deploy dev";
  });
  if (hasDeployReq) return "deploy-dev.yml";
  return null;
}

function isQueuedWorkflowStatus(status: string | null | undefined): boolean {
  const s = (status ?? "").trim().toLowerCase();
  return s === "queued" || s === "waiting" || s === "pending" || s === "requested";
}

function isInProgressWorkflowStatus(status: string | null | undefined): boolean {
  return (status ?? "").trim().toLowerCase() === "in_progress";
}

/** Pure level-based deploy coverage & reconciliation state machine (BR#6179):
 *  - Computes `DeployCoverageState` (closed 6-state union on `phase`).
 *  - Decides whether to dispatch `workflow_dispatch` (`dispatch_workflow`) once
 *    per `tipSha` when the tip is uncovered past `graceSecs` with no active run.
 *  - Identifies redundant queued deploy runs (`cancel_run_ids`) when the same
 *    `head_sha` already has an `in_progress` or `completed/success` deploy run
 *    (or duplicate queued runs for the same `head_sha`).
 *  Mirrored in `train_gate.rs` `reconcile_deploy_coverage`. */
export function reconcileDeployCoverage(input: {
  tipSha: string;
  tipAgeSecs: number;
  graceSecs?: number;
  baseVerdict: MainCheckVerdict;
  required: string[];
  workflowRuns: DeployWorkflowRun[];
  alreadyDispatchedAt?: number | null;
}): DeployReconcilePlan {
  const tipSha = (input.tipSha ?? "").trim();
  const tipAgeSecs = Math.max(0, Math.floor(Number(input.tipAgeSecs ?? 0) || 0));
  const graceSecs = Math.max(1, Math.floor(Number(input.graceSecs ?? DEPLOY_RECONCILE_GRACE_SECS) || DEPLOY_RECONCILE_GRACE_SECS));
  const deployRuns = input.workflowRuns
    .filter((r) => isDeployWorkflowRun(r, input.required))
    .sort((a, b) => (b.id ?? 0) - (a.id ?? 0));

  const newestGreen = deployRuns.find(
    (r) => (r.status ?? "").toLowerCase() === "completed" && (r.conclusion ?? "").toLowerCase() === "success",
  );
  const lastGreenSha = newestGreen?.head_sha ? newestGreen.head_sha : null;
  const lastGreenRunId = newestGreen?.id ?? null;

  // (D) Redundant queued runs per head_sha:
  // If a head_sha already has an in_progress or completed/success deploy run,
  // any queued/waiting/pending/requested deploy run for that same head_sha is redundant.
  // If a head_sha has multiple queued runs, all but the newest queued run are redundant.
  const bySha = new Map<string, DeployWorkflowRun[]>();
  for (const r of deployRuns) {
    const sha = (r.head_sha ?? "").trim();
    if (!sha) continue;
    const list = bySha.get(sha) ?? [];
    list.push(r);
    bySha.set(sha, list);
  }
  const cancelRunIds: number[] = [];
  for (const [, list] of bySha) {
    const hasActiveOrGreen = list.some(
      (r) =>
        isInProgressWorkflowStatus(r.status) ||
        ((r.status ?? "").toLowerCase() === "completed" && (r.conclusion ?? "").toLowerCase() === "success"),
    );
    const queued = list.filter((r) => isQueuedWorkflowStatus(r.status));
    if (hasActiveOrGreen) {
      for (const q of queued) {
        if (q.id > 0 && !cancelRunIds.includes(q.id)) cancelRunIds.push(q.id);
      }
    } else if (queued.length > 1) {
      for (const q of queued.slice(1)) {
        if (q.id > 0 && !cancelRunIds.includes(q.id)) cancelRunIds.push(q.id);
      }
    }
  }

  const tipRuns = deployRuns.filter((r) => r.head_sha === tipSha);
  const tipActive = tipRuns.find(
    (r) => (isInProgressWorkflowStatus(r.status) || isQueuedWorkflowStatus(r.status)) && !cancelRunIds.includes(r.id),
  );
  const tipGreen = tipRuns.find(
    (r) => (r.status ?? "").toLowerCase() === "completed" && (r.conclusion ?? "").toLowerCase() === "success",
  );
  const tipRed = tipRuns.find(
    (r) =>
      (r.status ?? "").toLowerCase() === "completed" &&
      r.conclusion != null &&
      r.conclusion !== "cancelled" &&
      MAIN_RED_CONCLUSIONS.has(r.conclusion),
  );

  const newestTip = tipRuns.find((r) => !["cancelled", "skipped"].includes(r.conclusion ?? ""));
  const decisiveFailure = newestTip?.status === "completed" && MAIN_RED_CONCLUSIONS.has(newestTip.conclusion ?? "");
  if (input.baseVerdict.verdict === "green" && !decisiveFailure && !tipActive &&
      (tipGreen || !inferDeployWorkflow(input.required, input.workflowRuns))) {
    return {
      coverage: {
        phase: "covered",
        tip_sha: tipSha,
        tip_age_secs: tipAgeSecs,
        covered_by_sha: tipSha,
        covered_by_run_id: tipGreen?.id ?? null,
        covered_by_url: tipGreen?.html_url ?? null,
      },
      dispatch_workflow: null,
      cancel_run_ids: cancelRunIds,
      covered_by_sha: tipSha,
      coverage_age_secs: 0,
    };
  }

  if (input.baseVerdict.verdict === "red" || decisiveFailure) {
    return {
      coverage: {
        phase: "failed",
        tip_sha: tipSha,
        tip_age_secs: tipAgeSecs,
        failing_run_id: tipRed?.id ?? null,
        failing_run_url: tipRed?.html_url ?? null,
        last_green_sha: lastGreenSha,
        last_green_run_id: lastGreenRunId,
      },
      dispatch_workflow: null,
      cancel_run_ids: cancelRunIds,
      covered_by_sha: lastGreenSha,
      coverage_age_secs: tipAgeSecs,
    };
  }

  if (input.baseVerdict.verdict === "unsettled" || tipActive) {
    return {
      coverage: {
        phase: "settling",
        tip_sha: tipSha,
        tip_age_secs: tipAgeSecs,
        active_run_id: tipActive?.id ?? null,
        active_run_url: tipActive?.html_url ?? null,
        last_green_sha: lastGreenSha,
        last_green_run_id: lastGreenRunId,
      },
      dispatch_workflow: null,
      cancel_run_ids: cancelRunIds,
      covered_by_sha: lastGreenSha,
      coverage_age_secs: tipAgeSecs,
    };
  }

  // Uncovered tip (`baseVerdict.verdict === "empty"` and no active deploy workflow run on `tipSha`)
  const workflow = inferDeployWorkflow(input.required, input.workflowRuns);
  if (input.alreadyDispatchedAt != null && input.alreadyDispatchedAt > 0) {
    return {
      coverage: {
        phase: "uncovered_dispatched",
        tip_sha: tipSha,
        tip_age_secs: tipAgeSecs,
        workflow: workflow ?? "deploy-dev.yml",
        dispatched_at: Math.floor(input.alreadyDispatchedAt),
        last_green_sha: lastGreenSha,
        last_green_run_id: lastGreenRunId,
      },
      dispatch_workflow: null,
      cancel_run_ids: cancelRunIds,
      covered_by_sha: lastGreenSha,
      coverage_age_secs: tipAgeSecs,
    };
  }

  if (tipAgeSecs < graceSecs) {
    return {
      coverage: {
        phase: "uncovered_grace",
        tip_sha: tipSha,
        tip_age_secs: tipAgeSecs,
        grace_secs: graceSecs,
        workflow,
        last_green_sha: lastGreenSha,
        last_green_run_id: lastGreenRunId,
      },
      dispatch_workflow: null,
      cancel_run_ids: cancelRunIds,
      covered_by_sha: lastGreenSha,
      coverage_age_secs: tipAgeSecs,
    };
  }

  const onlyCancelledOrSkipped =
    tipRuns.length > 0 &&
    tipRuns.every((r) => {
      const c = (r.conclusion ?? "").toLowerCase();
      return c === "cancelled" || c === "skipped";
    });
  const reason = onlyCancelledOrSkipped
    ? "all deploy runs on tip were cancelled/skipped"
    : "no deploy workflow run fired on tip (push trigger suppressed or run deleted)";

  return {
    coverage: {
      phase: "uncovered_dark",
      tip_sha: tipSha,
      tip_age_secs: tipAgeSecs,
      grace_secs: graceSecs,
      workflow,
      last_green_sha: lastGreenSha,
      last_green_run_id: lastGreenRunId,
      reason,
    },
    dispatch_workflow: tipSha ? workflow : null,
    cancel_run_ids: cancelRunIds,
    covered_by_sha: lastGreenSha,
    coverage_age_secs: tipAgeSecs,
  };
}

function formatCoverageAgeShort(secs: number): string {
  const s = Math.max(0, Math.floor(Number(secs) || 0));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m`;
}

/** Human-readable single-line deploy coverage summary for lane reasons and
 *  TrainPanel banners (BR#6179 B). Mirrored in `train_gate.rs` `format_deploy_coverage_summary`. */
export function formatDeployCoverageSummary(cov: DeployCoverageState): string {
  const shortTip = (cov.tip_sha ?? "").slice(0, 8) || "unknown";
  const ageStr = formatCoverageAgeShort(cov.tip_age_secs);
  switch (cov.phase) {
    case "covered":
      return `tip ${shortTip} covered by deploy${cov.covered_by_run_id ? ` (run #${cov.covered_by_run_id})` : ""}`;
    case "settling":
      return `tip ${shortTip} deploy in flight (age ${ageStr}${cov.active_run_id ? `, run #${cov.active_run_id}` : ""})`;
    case "uncovered_grace":
      return `tip ${shortTip} not covered by any deploy (age ${ageStr}, grace ${Math.max(1, Math.floor(cov.grace_secs / 60))}m)`;
    case "uncovered_dispatched":
      return `tip ${shortTip} not covered by any deploy (age ${ageStr}) — auto-dispatched ${cov.workflow}`;
    case "uncovered_dark": {
      const prev = cov.last_green_sha ? ` — last green deploy ${cov.last_green_sha.slice(0, 8)}` : "";
      return `tip ${shortTip} not covered by any deploy (age ${ageStr})${prev}`;
    }
    case "failed":
      return `tip ${shortTip} deploy failed (age ${ageStr})`;
  }
}

/** Reconciles `MainCheckVerdict` (computed from commit check-runs) with
 *  `DeployCoverageState` (computed from deploy workflow runs) into a single
 *  cohesive base verdict (BR#6389):
 *  - When `baseVerdict.verdict === "empty"` because a multi-stage deploy
 *    workflow (e.g. `Deploy Dev` in `Prepare deploy to dev (build on spot)`)
 *    has not created downstream `required_workflows` check-runs yet, but
 *    `coverage.phase === "settling"`, the effective verdict is `"unsettled"`
 *    (with `alarm` cleared), NEVER `"empty"` ("dark tip").
 *  - When `baseVerdict.verdict === "empty"` and `coverage.phase === "failed"`,
 *    the effective verdict is `"red"` naming `Deploy Dev`.
 *  - When `baseVerdict.verdict === "empty"` and `coverage.phase === "covered"`,
 *    keep waiting for required check evidence; coverage alone cannot prove green.
 *  Mirrored in `train_gate.rs` `reconcile_base_verdict_with_deploy_coverage`. */
export function reconcileBaseVerdictWithDeployCoverage(
  baseVerdict: MainCheckVerdict,
  coverage: DeployCoverageState,
): MainCheckVerdict {
  if (baseVerdict.verdict === "red") return baseVerdict;
  if (coverage.phase === "settling") {
    const label = coverage.active_run_id
      ? `Deploy Dev (run #${coverage.active_run_id} in flight)`
      : "Deploy Dev (in flight)";
    const { alarm: _alarm, ...rest } = baseVerdict;
    return {
      ...rest,
      verdict: "unsettled",
      unsettled: baseVerdict.unsettled.length > 0 ? baseVerdict.unsettled : [label],
    };
  }
  if (coverage.phase === "failed") {
    const name = coverage.failing_run_id
      ? `Deploy Dev (run #${coverage.failing_run_id})`
      : "Deploy Dev";
    const { alarm: _alarm, ...rest } = baseVerdict;
    return {
      ...rest,
      verdict: "red",
      red:
        baseVerdict.red.length > 0
          ? baseVerdict.red
          : [
              {
                name,
                conclusion: "failure",
                url: coverage.failing_run_url ?? "",
              },
            ],
    };
  }
  if (coverage.phase === "covered") {
    if (baseVerdict.verdict !== "empty") return baseVerdict;
    const { alarm: _alarm, ...rest } = baseVerdict;
    return {
      ...rest,
      verdict: "unsettled",
      unsettled: ["Deployment finished; waiting for required checks"],
    };
  }
  if (coverage.phase === "uncovered_grace" || coverage.phase === "uncovered_dispatched") {
    return { ...baseVerdict, verdict: "unsettled", unsettled: ["Waiting for a covering deployment to start"] };
  }
  if (coverage.phase === "uncovered_dark") {
    return { ...baseVerdict, verdict: "empty", alarm: coverage.reason };
  }
  return baseVerdict;
}

/** Normalizes a raw `queue_facts.base_state` object on the hub (BR#6389) so
 *  even if a gateway binary stamps `verdict: "empty"` alongside
 *  `deploy_coverage: { phase: "settling" | "covered" | "failed" }`, the hub
 *  immediately reconciles `verdict`, `red`, `unsettled`, and `alarm` into one
 *  consistent state. */
export function normalizeBaseStateWithCoverage(baseState: Record<string, unknown> | null | undefined): Record<string, unknown> | null | undefined {
  if (!baseState || typeof baseState !== "object") return baseState;
  if (!baseState.deploy_coverage) return baseState;
  const parsed = DeployCoverageStateSchema.safeParse(baseState.deploy_coverage);
  if (!parsed.success) return baseState;
  const effective = reconcileBaseVerdictWithDeployCoverage({
    verdict: baseState.verdict === "green" ? "green" : baseState.verdict === "red" ? "red" : baseState.verdict === "unsettled" ? "unsettled" : "empty",
    red: Array.isArray(baseState.red) ? baseState.red : [], green: Number(baseState.green ?? 0),
    unsettled: Array.isArray(baseState.unsettled) ? baseState.unsettled.map(String) : [],
  }, parsed.data);
  if (effective.verdict === "empty") return baseState;
  const next: Record<string, unknown> = { ...baseState, verdict: effective.verdict, unsettled: effective.unsettled,
    ...(effective.red.length ? { red: effective.red } : {}) };
  delete next.alarm;
  return next;
}

/** Durable deployment observations are folded on EVERY ingress/read. A
 * lease-holder's older scoped-green snapshot cannot overwrite known failed
 * deployment evidence. Facts for another commit never apply to this tip. */
export function applyDeployObservation(
  baseState: Record<string, unknown> | null | undefined,
  observation: DeployObservation | undefined,
  required: string[],
  checksObservedAt?: number,
): Record<string, unknown> | null | undefined {
  if (!observation || (baseState?.tip_sha && baseState.tip_sha !== observation.tip_sha)) return normalizeBaseStateWithCoverage(baseState);
  const raw: Record<string, unknown> & { check_observed_at: number } = { ...(baseState ?? { verdict: "empty", red: [], unsettled: [] }),
    check_observed_at: checksObservedAt ?? Number(baseState?.check_observed_at ?? 0) };
  const knownRun = Math.max(...observation.runs.filter((r) => r.head_sha === observation.tip_sha).map((r) => r.id));
  const newerCoverage = DeployCoverageStateSchema.safeParse(raw.deploy_coverage);
  if (raw.check_observed_at > observation.observed_at && newerCoverage.success && newerCoverage.data.tip_sha === observation.tip_sha) {
    const cov = newerCoverage.data;
    const receipt = cov.phase === "covered" ? cov.covered_by_run_id : cov.phase === "failed" ? cov.failing_run_id : null;
    // A newer, matching terminal receipt supersedes an older observation.
    // This lets an ordinary gateway publish recovery after a watched rerun;
    // a borrowed older green run cannot clear the failure or pending state.
    if (receipt != null && receipt >= knownRun) return normalizeBaseStateWithCoverage(raw);
  }
  const verdict: MainCheckVerdict = {
    verdict: raw.verdict === "green" ? "green" : raw.verdict === "red" ? "red" : raw.verdict === "unsettled" ? "unsettled" : "empty",
    red: Array.isArray(raw.red) ? raw.red : [], unsettled: Array.isArray(raw.unsettled) ? raw.unsettled.map(String) : [], green: Number(raw.green ?? 0),
  };
  const plan = reconcileDeployCoverage({ tipSha: observation.tip_sha, tipAgeSecs: Number(raw.tip_age_secs ?? 0),
    baseVerdict: verdict, required, workflowRuns: observation.runs });
  const normalized = normalizeBaseStateWithCoverage({ ...raw, tip_sha: observation.tip_sha,
    deploy_coverage: plan.coverage, covered_by: plan.covered_by_sha, coverage_age_secs: plan.coverage_age_secs });
  if (plan.coverage.phase === "failed") {
    const failedRunId = plan.coverage.failing_run_id;
    const failures = (observation.failures ?? []).filter((f) => f.run_id === failedRunId)
      .map((f) => ({ name: f.name, url: f.url, conclusion: "failure" }));
    if (failures.length) return { ...normalized, red: failures };
  }
  return normalized;
}

/** BR#6179 (C) Fast-page deterministic ask title for a dark/uncovered tip past
 *  the grace window — keyed on `(repo, base, tipSha.slice(0, 8))` so at most
 *  ONE ask fires per dark tip SHA. ≤240 chars, ends in "?". */
export function trainDarkTipAskTitle(lane: { repo: string; base: string }, tipSha: string): string {
  const shortTip = (tipSha ?? "").slice(0, 8) || "unknown";
  const prefix = `MERGE TRAIN DARK TIP: ${lane.repo}@${lane.base} — `;
  const suffix = `tip ${shortTip} not covered by any deploy run. Remedy?`;
  const budget = 240 - prefix.length;
  return prefix + (suffix.length > budget ? suffix.slice(0, Math.max(0, budget - 1)).trimEnd() + "?" : suffix);
}

/** BR#6179 (C) Self-contained plain-reading brief + one-click options for a
 *  dark-tip alarm ask (satisfies Rule 6c ask quality bar). */
export function trainDarkTipAskBrief(input: {
  lane: { repo: string; base: string };
  held: number;
  alarm?: string | null;
  coverage: DeployCoverageState;
}): { details: string; options: string[] } {
  const { lane, held, alarm, coverage } = input;
  const shortTip = (coverage.tip_sha ?? "").slice(0, 8) || "unknown";
  const ageStr = formatCoverageAgeShort(coverage.tip_age_secs);
  const wf =
    coverage.phase === "uncovered_dispatched"
      ? coverage.workflow
      : coverage.phase === "uncovered_dark" || coverage.phase === "uncovered_grace"
        ? coverage.workflow ?? "deploy-dev.yml"
        : "deploy-dev.yml";
  const lastGreen =
    "last_green_sha" in coverage && coverage.last_green_sha
      ? `${coverage.last_green_sha.slice(0, 8)}${coverage.last_green_run_id ? ` (run #${coverage.last_green_run_id})` : ""}`
      : "none recorded in recent workflow history";
  const dispatched = coverage.phase === "uncovered_dispatched";
  const details = [
    `What this is: merge lane ${lane.repo}@${lane.base} is holding ${held} verified change(s) because the current ${lane.base} tip commit (${shortTip}, age ${ageStr}) is not covered by any decisive deploy workflow run (${alarm || "tip carries no check runs at all"}).`,
    `Current state: ${formatDeployCoverageSummary(coverage)}. Last decisive green deploy covered: ${lastGreen}. This happens when a merge push event is suppressed (for example by an app/bot token class) or when the deploy workflow run was cancelled or deleted before creating required check runs.`,
    dispatched
      ? `Automatic remedy already taken: the merge-train executor automatically dispatched ${wf} on ${lane.base} for tip ${shortTip} (once per SHA). The lane will resume merging queued changes automatically as soon as that deploy run settles green; human action is only needed if the dispatched run fails to start.`
      : `Why it needs you: tip ${shortTip} is past the grace window with no deploy run in flight. Choose option 1 to authorize an immediate ${wf} workflow dispatch on ${lane.base}, or run \`gh workflow run ${wf} --repo ${lane.repo} --ref ${lane.base}\`.`,
  ].join("\n\n");
  const options = dispatched
    ? [
        `(Recommended) Acknowledge — auto-dispatched ${wf} is in flight; hold until it settles`,
        `Re-dispatch ${wf} on ${lane.base} now`,
      ]
    : [
        `(Recommended) Dispatch ${wf} on ${lane.base} now`,
        `Acknowledge — investigating workflow trigger suppression`,
      ];
  return { details, options };
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

// ---- landed-close recovery (BR#4753) ----

/** The landed close (landedFlow) runs inside train.ci's GREEN verdict — a
 *  gate-rejected close (done-open-children, receipts, any lifecycle gate)
 *  used to throw raw EVERY tick: the lane sat in awaiting-ci fail-open past
 *  the fail-closed bound and the stop arm was structurally unreachable,
 *  because bound_exceeded is only consulted on the pending branch
 *  (BR#4753 — observed on state-vector/bridge@main: 60+ min past bound,
 *  ~65 silent tick failures, queue starved). The green branch must
 *  therefore ALWAYS resolve: landed | red-stop | bound-stop | bounce. */

/** Transient (potentially self-healing) close failures are retried this many
 *  consecutive ticks before the fail-closed bounce fires — a lane far past
 *  the fail-closed bound fires sooner (trainLandedCloseEdge). */
export const TRAIN_LANDED_CLOSE_MAX_RETRIES = 3;

export type LandedCloseEdge = { edge: "retry" | "bounce"; bound_fired: boolean };

/** The recovery ladder for ONE failed landed close (pure; the DO applies it).
 *  RETRY-LAW shape (BR#4403): a SEMANTIC gate rejection — breachClass names
 *  a rule ("gate:open-children", "gate:separation", …) — can NEVER succeed
 *  on retry, so it bounces the culprit card immediately (the BR#3516 §6
 *  lifecycle-legal edge) citing the gate error. Anything else could be a
 *  storage fault or a race: retry ≤ TRAIN_LANDED_CLOSE_MAX_RETRIES
 *  consecutive ticks; past that — or past the fail-closed bound
 *  (~TRAIN_CI_BOUND_MULTIPLIER × typical, BR#3516 §2), whichever comes
 *  first — bounce fail-closed. A green-verdict tick never raw-throws. */
export function trainLandedCloseEdge(input: { breach_class: string; failures: number; bound_exceeded: boolean }): LandedCloseEdge {
  if (input.breach_class.startsWith("gate:")) return { edge: "bounce", bound_fired: false };
  if (input.failures >= TRAIN_LANDED_CLOSE_MAX_RETRIES || input.bound_exceeded)
    return { edge: "bounce", bound_fired: input.bound_exceeded };
  return { edge: "retry", bound_fired: false };
}

/** The fix-up brief for a close-bounced card. NOT the conflict/gate merge
 *  brief: the PR is ALREADY MERGED and main is GREEN (the machine proxy
 *  held) — only the BOARD close was refused. Re-merging or re-verifying is
 *  wrong; the repair leg is exactly the gate's named precondition. */
export function trainCloseBounceBrief(input: { repo: string; prNumber: number; mergeSha: string; gateway: string; error: string; breachClass: string; boundFired: boolean; failures: number }): string {
  const err = (input.error ?? "").trim().slice(0, 400) || "(no error text)";
  return [
    `Merge-train close bounce (BR#4753): PR #${input.prNumber} (${input.repo}) IS MERGED as ${input.mergeSha.slice(0, 9)} and main is GREEN — but the board close (blocked→in_progress→done on the machine proxy, BR#3516) failed ${input.failures} time(s).`,
    ``,
    `**Gate rejection (${input.breachClass}):** ${err}`,
    input.boundFired
      ? `**Fail-closed bound fired:** the lane blew past ~${TRAIN_CI_BOUND_MULTIPLIER}× typical CI wall-clock retrying this close — bounced so the queue cannot starve (BR#3516 §2).`
      : `**Why bounced:** a gate rejection cannot succeed on retry (BR#4403 retry law) — retrying every tick wedged the whole lane.`,
    ``,
    `**Next owner: impl** — resolve EXACTLY the named precondition (e.g. finish/close the open child task(s), attach the receipts the gate names), then close this card done citing the merge commit. Do NOT re-merge (the PR is landed), do NOT re-verify (main green is already proven):`,
    `merge commit: https://github.com/${input.repo}/commit/${input.mergeSha}`,
  ].join("\n");
}

/** Deterministic close-failure alarm title — ONE per episode (the sha makes
 *  it unique; askCreate's identical-open-ask guard dedupes). ≤240 chars,
 *  ends "?" — the ask contract. */
export function trainCloseFailAskTitle(lane: { repo: string; base: string }, sha: string, prNumber: number, breachClass: string, boundFired: boolean): string {
  const suffix = " — intervene?";
  const prefix = `MERGE TRAIN landed close failed (${breachClass}${boundFired ? ", bound fired" : ""}): ${lane.repo}@${lane.base} PR #${prNumber} merged as ${sha.slice(0, 9)} — card close keeps failing`;
  const budget = 240 - suffix.length;
  return prefix.slice(0, budget) + suffix;
}

/** The close-failure ask's details: the episode's facts and why it reached
 *  the alarm sink (the failure used to be silent per tick). */
export function trainCloseFailAskDetails(input: { repo: string; base: string; prNumber: number; mergeSha: string; taskId: string | null; error: string; breachClass: string; boundFired: boolean; failures: number; gateway: string }): string {
  return [
    `The merge train's landed close failed on ${input.repo}@${input.base}.`,
    ``,
    `- PR: https://github.com/${input.repo}/pull/${input.prNumber} (merged as ${input.mergeSha.slice(0, 9)} — main GREEN, the merge itself is fine)`,
    `- Card: ${input.taskId ?? "(none)"}`,
    `- Gate rejection (${input.breachClass}): ${(input.error ?? "").slice(0, 400) || "(no error text)"}`,
    `- Attempts: ${input.failures}${input.boundFired ? `, fail-closed bound fired (~${TRAIN_CI_BOUND_MULTIPLIER}× typical CI wall-clock past the merge)` : ""} — gateway ${input.gateway}`,
    ``,
    `The culprit card has been close-bounced to impl with the repair brief (resolve the named precondition, then close citing the merge commit — no re-merge, no re-verify); the lane idled and the queue advances. This ask exists because the failure used to be SILENT per tick (BR#4753: ~65 unseen failures over an hour starved the queue past the fail-closed bound). One ask per episode.`,
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

/** The board's own cross-reference shorthand — `owner/name#N` (BR#4648): a
 *  verifier citing the PR the way every bounce note and brief already does
 *  (`repo#N`) still counts as a PR reference. A full /pull/ URL wins when
 *  both cite the same PR (dedupe keeps the earliest mention); plain `#N`
 *  without an owner/name prefix never matches, so card ids and "unrelated
 *  #2534 merge" prose stay inert. */
export const TRAIN_PR_SHORT_RE = /([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)(?!\d)/g;

/** BR#5658 / BR#5324 / BR#5805: validate that `owner/name` is a plausible
 *  GitHub repository rather than a Bridge/tracker cross-reference token or
 *  numeric fragment. Prose notes like `BR#5563/BR#5635`, `#1768/BR#4993`, or
 *  CSS/identifier tokens adjacent to a card ref (`tb-pulse/BR#5658`) previously
 *  matched `TRAIN_PR_SHORT_RE` with `m[2] === "BR"`, minting ghost merge lanes
 *  (`4365/BR`, `4728/BR`, `5022/BR`, `5299/BR`, `5563/BR`, `1768/BR`,
 *  `tb-pulse/BR`) and poisoning cards' `pr_merged` proxies.
 *  - `owner` must not be all-digits (`5563`, `1768`) and must follow GitHub's
 *    username/org syntax (`[A-Za-z0-9]` endpoints, `[A-Za-z0-9-]` interior).
 *  - `name` must not be a reserved tracker/card prefix (`BR`, `GH`, `PR`,
 *    `TASK`, `ASK`, `ISSUE`, `PULL`, `ISSUES`, `PULLS`). */
export function isValidGitHubRepo(repo: string): boolean {
  const parts = String(repo ?? "").trim().split("/");
  if (parts.length !== 2) return false;
  const [owner, name] = parts;
  if (!owner || !name) return false;
  if (/^\d+$/.test(owner)) return false;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) return false;
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") return false;
  if (/^(?:br|gh|pr|issue|issues|pull|pulls|task|ask)$/i.test(name)) return false;
  return true;
}

/** BR#5658 / AGENTS.md Rule 7: extract a direct-to-main landing commit receipt
 *  from a review/verify note when no PR exists (`https://github.com/o/r/commit/<sha>`
 *  or `commit <sha>` / `landed on main as <sha>`). Returns null when the text
 *  cites any PR leg (PR legs ride the merge train, never direct-close). */
export function parseDirectCommitReceipt(text: string): { repo?: string; sha: string } | null {
  const t = String(text ?? "");
  if (trainParseNoteLegs(t).length > 0) return null;
  const urlMatch = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/commit\/([0-9a-f]{7,40})\b/i.exec(t);
  if (urlMatch && isValidGitHubRepo(urlMatch[1])) {
    return { repo: urlMatch[1], sha: urlMatch[2].toLowerCase() };
  }
  const tokenMatch = /(?:^|[\s(—–-])(?:commit|landed(?:\s+direct(?:ly)?\s+to\s+main)?(?:\s+on\s+main)?(?:\s+as)?|main\s+commit)[\s#:@=/]+([0-9a-f]{7,40})(?=[\s;.,)]|$)/i.exec(t);
  if (tokenMatch) {
    return { sha: tokenMatch[1].toLowerCase() };
  }
  return null;
}

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
 *  the queue arm fail-closes on it. Never a silent cross-pairing. A PR may
 *  be cited as the full /pull/ URL or the board's `owner/name#N` shorthand
 *  (BR#4648) — the URL form wins when both cite the same PR. Duplicate
 *  citations of the SAME PR (a commits deep-link after the canonical URL,
 *  URL + shorthand) collapse to one leg (BR#6349): a single cited PR then
 *  binds its head by the lenient single-PR rule again, instead of degrading
 *  to strict adjacency pairing across a phantom second leg. */
export function trainParseNoteLegs(text: string): TrainNoteLeg[] {
  const t = String(text ?? "");
  const prs: { repo: string; number: number; index: number; end: number }[] = [];
  const seen = new Set<string>();
  for (const m of t.matchAll(TRAIN_PR_URL_RE)) {
    const repo = `${m[1]}/${m[2]}`;
    if (!isValidGitHubRepo(repo)) continue;
    const key = `${repo}#${m[3]}`;
    // BR#6349: the receipts deep-link (`/pull/N/commits/<sha>`) matches this
    // regex too — a second citation of an already-cited PR must never mint
    // a second leg. One PR is ONE leg: the duplicate broke the adjacency
    // pairing (neither token bound), and the queue arm silently folded the
    // stamp back to the stale head on re-queue (the BR#4684/PR#309 livelock).
    if (seen.has(key)) continue;
    seen.add(key);
    prs.push({ repo, number: Number(m[3]), index: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  for (const m of t.matchAll(TRAIN_PR_SHORT_RE)) {
    const idx = m.index ?? 0;
    const before = idx > 0 ? t[idx - 1] : "";
    // Reject if preceded by `#` or `/` (e.g. `BR#5563/BR#5635` or URL path tails)
    if (before === "#" || before === "/") continue;
    const repo = `${m[1]}/${m[2]}`;
    if (!isValidGitHubRepo(repo)) continue;
    const key = `${repo}#${m[3]}`;
    if (seen.has(key)) continue; // the same PR already cited by its URL
    seen.add(key);
    prs.push({ repo, number: Number(m[3]), index: idx, end: idx + m[0].length });
  }
  prs.sort((a, b) => a.index - b.index);
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
