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
  "progress",
  "agent",
] as const;
export type ArtefactType = (typeof ARTEFACT_TYPES)[number];

export function isArtefactType(t: unknown): t is ArtefactType {
  return typeof t === "string" && (ARTEFACT_TYPES as readonly string[]).includes(t);
}

/** Task kinds — one task type, distinguished by meta.kind. */
export const TASK_KINDS = ["impl", "analysis", "review", "research", "question"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** A task's kind, defaulting to impl. Questions are the open, non-exclusive kind. */
export function taskKind(meta: any): TaskKind {
  const k = typeof meta?.kind === "string" ? meta.kind : undefined;
  return (TASK_KINDS as readonly string[]).includes(k ?? "") ? (k as TaskKind) : "impl";
}

/** Open tasks anyone may contribute to; never claimed, never swept by the watchdog. */
export function isQuestionTask(meta: any): boolean {
  return taskKind(meta) === "question";
}

/** Allowed status transitions per type. Absent type/keys = no transitions. */
export const LIFECYCLES: Record<ArtefactType, Record<string, string[]>> = {
  steering: { draft: ["active"], active: ["superseded"] },
  goal: { draft: ["active"], active: ["achieved", "dropped"] },
  decision: { proposed: ["accepted", "superseded"], accepted: ["superseded"] },
  task: { todo: ["in_progress", "blocked"], in_progress: ["in_review", "done", "blocked", "todo"], in_review: ["done", "in_progress", "blocked"], blocked: ["in_progress", "todo"] },
  progress: {},
  agent: {},
};

/** Initial status when an artefact of this type is created. */
export const INITIAL_STATUS: Record<ArtefactType, string> = {
  steering: "draft",
  goal: "draft",
  decision: "proposed",
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
  if (relation === "child_of" && !(srcType === "task" && dstType === "task"))
    return { ok: false, reason: "child_of: both source and target must be tasks (flat structure — the board never nests, relations do)" };
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

/**
 * Build marker — bump on every behavioural change. Agents verify what's live
 * via orient.build; provenance receipts use it as the recency cue for
 * server-default records (composed from this deploy, versioned with it).
 */
export const BUILD = "0.3.6";

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
    `5b. SEPARATION OF DUTIES: analysis, impl, and review happen in different sessions — every agent can do all three, never in one session. A session that completed the analysis on a task cannot claim it for impl (the gate also auto-releases the parent if you try); a session that implemented cannot produce the review. Verification is a double-check by a fresh session: check the actual state (GH merge status, PR, findings) and cite receipts in the note — a review without receipts is rejected. If a gate rejects you, end the session and start a new one.`,
    `6. Blocked on a decision → ask_agent immediately, bound to your task (artefact_id). The ask pauses the watchdog; the answer auto-resumes you.`,
    `6b. QUESTIONS are tasks tagged 'question' — answered, not claimed. Contribute via log_progress {id, did, will}; any number of agents, additive input. The author weighs contributions and closes it with an ADR (decision artefact, derived_from the task, contributors + receipts in the body). Answers thin? the author adds steering with specifics and re-issues the task in todo. Humans are the final escalation — consensus among agents escalates to them for the last say.`,
    `7. Findings belong in Knowledge, not session memory. Open questions become question tasks; conclusions become decisions.`,
    `7b. DOCS RIDE WITH THE CHANGE: if your work alters user-visible behaviour (UI, config, protocol, gates), update README.md and packages/site/content.md in the same branch — the docs are the interface, stale docs are a defect.`,
    `8. Accepted decisions are settled. Steering constrains you. Supersede, never contradict.`,
    `9. Real progress or let go: if you cannot advance a claimed task this run, transition it → todo (retry) — that releases the claim so any matching agent can pick it up fresh. Squatting on untouched work starves the pool.`,
    `DELEGATION: if you spawn subagents, copy the PROTOCOL CARD below verbatim to the top of each subagent's prompt.`,
    `PROTOCOL CARD: 1. START: orient (session: "<unique-name>"). 2. CLAIM: transition {id, to: "in_progress", session} before coding. 3. HEARTBEAT: log_progress {id, did, will, session} every ≤10 min. 4. LONG OP: declare silence — grace_minutes or subprocess-block with a budget. 5. UNCERTAIN: ask_agent first. 6. FINISH: PR, then transition {to: "in_review", note: "PR <link>"} — a Verify task auto-spawns into the pool; a fresh-session verifier closes or bounces. Verification is a double-check with receipts.`,
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
1. Answer your asks first (asks + answer_ask): an answer unblocks whoever is waiting, and open asks pause their watchdog.
2. If you own in_progress tasks: log_progress on each (one line + sentiment — the heartbeat), then resume the oldest one.
3. Otherwise claim ONE task from unclaimed_work that matches your role tags: transition it to in_progress. Claiming sets you as owner; you own it end-to-end.
4. Finish cleanly or hand back: in_review when complete (PR link in the note); blocked with BOTH a reason and an unblock condition, then ask_agent, when a decision is needed; transition to todo (retry) when you cannot make real progress this tick.
5. Nothing claimable this tick: exit quietly. No filler artefacts, no noise.`;

export const DEFAULT_ROLE_PLAYBOOKS: Record<string, string> = {
  analysis: `DECOMPOSE, DON'T BUILD: your job is to make work READY, not to do it.
- Unqualified todo is gated to you on purpose (the pickup gate routes it here). That gate is your job description.
- Analyse first: search_knowledge the topic, get_artefact the task and its see_also; coordinate via ask_agent instead of forking overlapping work.
- Decompose into child tasks (child_of the parent): one per coherent unit, each tagged with its role (role:impl / role:review), each carrying concrete checkable acceptance criteria in body_md ("done when X" plus what is OUT of scope). A vague child task is a defect you created; rewrite it before you finish.
- Qualify the parent by completing a role:analysis child that summarises the plan and open questions, then transition it to done. A done role:analysis child is what lifts the parent's pickup gate. If the publisher requested stacked bars (await), create the matching role:review child so the bar can be met.
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
  for (const k of ["progress_count", "gauge_count", "thin_notes", "abandoned", "reassigned", "asks_received", "asks_answered_on_time", "artefacts_created"])
    if (typeof s[k] !== "number" || Number.isNaN(s[k])) s[k] = 0;
  let score = 50;
  const hints: string[] = [];

  score += Math.min(20, s.gauge_count * 2);
  score -= Math.min(25, s.abandoned * 10);
  if (s.abandoned > 0)
    hints.push(`${s.abandoned} task(s) went silent and were watchdog-blocked — send log_progress every ≤10m`);
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
