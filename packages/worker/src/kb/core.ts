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
  "rfc",
  "decision",
  "discussion",
  "research",
  "task",
  "progress",
  "agent",
] as const;
export type ArtefactType = (typeof ARTEFACT_TYPES)[number];

export function isArtefactType(t: unknown): t is ArtefactType {
  return typeof t === "string" && (ARTEFACT_TYPES as readonly string[]).includes(t);
}

/** Allowed status transitions per type. Absent type/keys = no transitions. */
export const LIFECYCLES: Record<ArtefactType, Record<string, string[]>> = {
  steering: { draft: ["active"], active: ["superseded"] },
  goal: { draft: ["active"], active: ["achieved", "dropped"] },
  rfc: {
    draft: ["proposed"],
    proposed: ["accepted", "rejected"],
    accepted: ["implemented", "superseded"],
  },
  decision: { proposed: ["accepted"], accepted: ["superseded"] },
  discussion: { open: ["concluded"] },
  research: { draft: ["published"] },
  task: { todo: ["in_progress", "blocked"], in_progress: ["done", "blocked"], blocked: ["in_progress"] },
  progress: {},
  agent: {},
};

/** Initial status when an artefact of this type is created. */
export const INITIAL_STATUS: Record<ArtefactType, string> = {
  steering: "draft",
  goal: "draft",
  rfc: "draft",
  decision: "proposed",
  discussion: "open",
  research: "draft",
  task: "todo",
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
  if (relation === "implements" && !(srcType === "task" && (dstType === "rfc" || dstType === "goal")))
    return { ok: false, reason: "implements: source must be a task, target an rfc or goal" };
  if (relation === "constrains" && srcType !== "steering")
    return { ok: false, reason: "constrains: source must be steering" };
  return { ok: true };
}

// ---------- ids ----------

/** `RFC-007` style ids, per-type counters. */
export function formatId(type: ArtefactType, seq: number): string {
  return `${type.toUpperCase()}-${String(seq).padStart(3, "0")}`;
}

/** Extract the numeric suffix from a well-formed id; NaN otherwise. */
export function idSeq(id: string): number {
  const m = /^[A-Z]+-(\d+)$/.exec(id);
  return m ? parseInt(m[1], 10) : NaN;
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
 * Auth token = one agent client. Sessions self-name uniquely per token.
 * Secret shown once at mint; only the SHA-256 hash is stored.
 */
export function generateAuthToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return "bkw_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashAuthToken(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function isValidAuthTokenShape(secret: string): boolean {
  return /^bkw_[0-9a-f]{48}$/.test(secret);
}

// ---------- asks (agent-to-agent) ----------

/**
 * Ask addressing: `any` (open floor), an agent label (auth-token label),
 * `label@session`, or `tag:<capability>` (e.g. tag:datadog-access).
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
    `You are connected to Bridge — the work orchestration layer for "${projectName || DEFAULT_PROJECT}".`,
    `Start with orient: it returns active goals, open work, pending asks for you, and project flags.`,
    `Search (search_knowledge) and read (get_artefact) before assuming; record outcomes as artefacts.`,
    `Steering constrains you; accepted decisions are settled — supersede, don't contradict.`,
  ];
  if (board.mode === "external") {
    lines.push(
      `Work is tracked on the team's external board${board.kind ? ` (${board.kind})` : ""}${board.url ? `: ${board.url}` : "."} Follow it.`,
    );
    if (board.prompt) lines.push(board.prompt);
  }
  return lines.join("\n");
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

