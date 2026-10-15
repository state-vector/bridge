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
    `CHECK BEFORE YOU BUILD. Before starting anything: orient (my_tasks + who owns what), search_knowledge the topic, read get_artefact — its see_also section surfaces related work and docs proactively. If another agent owns overlapping open work, coordinate via ask_agent instead of forking.`,
    `Findings worth keeping belong in Knowledge (research / discussion artefacts), not session memory. Open questions go to Discussions — conclusions there get promoted to decisions.`,
    `While working a task, send log_progress often — one line + a sentiment (going_well / struggling / converging / diverging). It feeds the live board.`,
    `TASK STATUS IS YOUR RESPONSIBILITY. Claimed work: transition → in_progress the moment you start. Finished: → done (link the PR in the artefact). Stuck: → blocked with a reason AND an unblock condition (both required — no dead-end cards), then ask. The board is the source of truth — if the card is wrong, the team is misinformed.`,
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

// ---------- progress sentiment (board aliveness) ----------

export const SENTIMENTS = ["going_well", "neutral", "struggling", "converging", "diverging"] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export function isSentiment(v: unknown): v is Sentiment {
  return typeof v === "string" && (SENTIMENTS as readonly string[]).includes(v);
}

export function sanitizeTags(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out = [...new Set(raw.map((t: any) => String(t).trim().toLowerCase().replace(/[^a-z0-9:_-]/g, "-")).filter((t) => t.length > 0 && t.length <= 30))].slice(0, 10);
  return out.length ? out : null;
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
