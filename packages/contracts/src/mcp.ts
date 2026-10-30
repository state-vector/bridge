/**
 * The MCP tool contract — the 16 tools the hub serves, with their argument
 * schemas — BR#2844.
 *
 * The incident: the registry declared `ask_answer` while the dispatch
 * implemented `answer_ask`. The tool worked the whole time; the names just
 * diverged between two hand-maintained lists.
 *
 * This module ends the class: these schemas are THE single source. The
 * hub's tool table (`packages/worker/src/mcp-tools.ts`) takes its `schema`
 * column from here — the tools/list response is GENERATED from that table
 * (via `mcpToolsList`), and the dispatch switch IS the table. A tool
 * declared without a handler is now a TypeScript compile error (the table
 * type is total over ToolName), and this module's fixture test pins the
 * generated surface against `fixtures/mcp-tools.json`.
 */
import { z } from "zod";

/** Every tool name the hub has ever advertised, from the recorded fixture. */
export const TOOL_NAMES = [
  "answer_ask",
  "ask_agent",
  "asks",
  "create_artefact",
  "get_artefact",
  "get_history",
  "link_artefacts",
  "list_agents",
  "log_progress",
  "orient",
  "proxy_probes",
  "proxy_verify",
  "reconcile_ignore",
  "reconcile_report",
  "reconcile_schedule",
  "reconcile_status",
  "related_artefacts",
  "search_knowledge",
  "session_alive",
  "stats",
  "train_bisect",
  "train_carry",
  "train_ci",
  "train_event",
  "train_history",
  "train_lane",
  "train_lease",
  "train_status",
  "transition",
  "update_artefact",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * Per-tool argument schemas. Loose objects: the Durable Object stays the
 * authority for unknown-key rejection, and gateway/session plumbing rides
 * keys the schemas deliberately tolerate. `required` in the generated JSON
 * Schema is what the fixture pins.
 */
export const TOOL_ARG_SCHEMAS = {
  orient: z.looseObject({
    session: z
      .string()
      .optional()
      .describe("unique session name (per agent) — required-ish: omit and the hub nags you"),
  }),
  search_knowledge: z.looseObject({
    q: z.string(),
    type: z.string().optional(),
    limit: z.number().int().max(100).optional(),
  }),
  get_artefact: z.looseObject({ id: z.string() }),
  create_artefact: z.looseObject({
    type: z.string(),
    title: z.string().max(300),
    body_md: z.string().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
    owner: z.string().optional(),
    project: z.string().optional(),
    qualified: z.boolean().optional(),
    await: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    roles: z.array(z.string()).optional(),
    session: z.string().optional(),
  }),
  update_artefact: z.looseObject({
    id: z.string(),
    title: z.string().optional(),
    body_md: z.string().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
    tags: z.array(z.string()).optional(),
    roles: z.array(z.string()).optional(),
  }),
  transition: z.looseObject({
    id: z.string(),
    to: z.string(),
    note: z.string().optional(),
    unblock_condition: z.string().optional(),
    /** BR#3578 typed await — closed grammar validated in worker closure.ts;
     *  machine event | open ask | timer. Free text (unblock_condition) is
     *  optional human annotation derived from this when absent. */
    await_event: z.record(z.string(), z.unknown()).optional(),
    class: z.enum(["subprocess"]).optional(),
    budget_minutes: z.number().int().max(1440).optional(),
    replacement_id: z.string().optional(),
  }),
  link_artefacts: z.looseObject({
    src: z.string(),
    relation: z.string(),
    dst: z.string(),
  }),
  list_agents: z.looseObject({}),
  stats: z.looseObject({}),
  related_artefacts: z.looseObject({
    id: z.string(),
    limit: z.number().int().max(50).optional(),
  }),
  session_alive: z.looseObject({ id: z.string() }),
  log_progress: z.looseObject({
    id: z.string(),
    note: z.string(),
    will: z.string().optional(),
    grace_minutes: z.number().int().max(60).optional(),
    sentiment: z
      .enum(["going_well", "neutral", "struggling", "converging", "diverging"])
      .optional(),
    completion_pct: z.number().int().min(0).max(100).optional(),
    confidence_pct: z.number().int().min(0).max(100).optional(),
    risk_pct: z.number().int().min(0).max(100).optional(),
    context_pct: z.number().int().min(0).max(100).optional(),
  }),
  get_history: z.looseObject({
    id: z.string(),
    limit: z.number().int().max(200).optional(),
  }),
  ask_agent: z.looseObject({
    to: z.string().optional(),
    question: z.string().max(240),
    // one-line WHY escalated (≤1200); the narrative goes in details
    reason: z.string(),
    // self-contained plain-reading brief — REQUIRED by the hub for
    // human-directed asks (what/why/current state; gloss BR#/PR# refs)
    details: z.string().optional(),
    // 2–8 one-click answers; recommended option FIRST, prefixed "(Recommended)"
    options: z.array(z.string()).min(2).max(8),
    artefact_id: z.string().optional(),
  }),
  asks: z.looseObject({}),
  answer_ask: z.looseObject({ id: z.string(), answer: z.string() }),
  // ---- merge train (BR#3516/BR#3517): executor-fed GitHub facts, hub-decided.
  // The lease is the CAS gate — every mutating train op requires it.
  train_lease: z.looseObject({
    repo: z.string(),
    base: z.string().optional(),
    action: z.enum(["acquire", "renew", "release"]),
    holder: z.string().optional(),
    required_workflows: z.array(z.string()).optional(),
    ci_typical_minutes: z.number().optional(),
    line_green: z.boolean().optional(),
    // proof-of-progress (BR#4104 wire, BR#4129 hub consumption): the renewing
    // holder's last ledger action + its age. Absent on legacy renewals — the
    // hub treats that as UNKNOWN (allow + audit) while the deprecation
    // window runs; on a non-empty queue a STALE note denies the renewal.
    progress: z
      .looseObject({
        progress: z.string().optional(),
        progress_age_ms: z.number().optional(),
        holder: z.string().optional(),
      })
      .optional(),
  }),
  train_event: z.looseObject({
    repo: z.string(),
    kind: z.enum(["merged", "bounced", "stopped", "landed"]),
    base: z.string().optional(),
    pr: z.number().int().optional(),
    head_sha: z.string().optional(),
    merge_sha: z.string().optional(),
    task_id: z.string().optional(),
    signer: z.string().optional(),
    run_url: z.string().optional(),
    carry_from: z.string().optional(),
    reason: z.string().optional(),
    conflict_files: z.array(z.string()).optional(),
    failing: z
      .array(
        z.looseObject({
          name: z.string().optional(),
          conclusion: z.string().nullish(),
          url: z.string().nullish(),
        }),
      )
      .optional(),
    culprit_task: z.string().optional(),
    checks: z.array(z.looseObject({ name: z.string().optional(), conclusion: z.string().nullish(), html_url: z.string().nullish() })).optional(),
  }),
  train_ci: z.looseObject({
    repo: z.string(),
    base: z.string().optional(),
    sha: z.string().optional(),
    checks: z
      .array(
        z.looseObject({
          name: z.string().optional(),
          conclusion: z.string().nullish(),
          status: z.string().nullish(),
          html_url: z.string().nullish(),
        }),
      )
      .optional(),
    run_url: z.string().optional(),
  }),
  train_status: z.looseObject({ repo: z.string().optional() }),
  // ---- burst-drain settle (BR#4934): the red-settle bisect + the
  // settle-window machine-rebase carry. Same executor-fed / hub-decided
  // split; both require the lane lease (hub-side check). ----
  train_bisect: z.looseObject({
    repo: z.string(),
    base: z.string().optional(),
    /** one bisect step: sha of the probed intermediate merge + its verdict */
    step: z
      .looseObject({
        sha: z.string(),
        verdict: z.enum(["green", "red", "dispatched", "inconclusive"]),
      })
      .optional(),
    /** a RED step names the ONE culprit card (provenance ledger task_id) */
    culprit_task: z.string().optional(),
    culprit_sha: z.string().optional(),
    /** the walk could not name one culprit — the pass bounces oldest-first */
    inconclusive: z.boolean().optional(),
  }),
  train_carry: z.looseObject({
    repo: z.string(),
    base: z.string().optional(),
    pr: z.number().int(),
    /** the verdict-covered head before the machine-clean update-branch */
    from_head: z.string(),
    /** the head after it — coverage extends here via the appended record */
    to_head: z.string(),
  }),
  // ---- proxy verification probes (BR#4658): the sweep enqueues probes for
  // run_success / pr_checks_green parks it cannot verify itself (the hub
  // holds no VCS credentials — BR#3516); a worker-executor daemon leg polls
  // the queue, runs gh first-hand (read-only), and feeds the verdict back.
  // Executor-fed facts, hub-decided — the head law and the flip stay with
  // the hub (BR#3409 fail-closed).
  proxy_probes: z.looseObject({ limit: z.number().int().optional() }),
  proxy_verify: z.looseObject({
    key: z.string(),
    ok: z.boolean(),
    receipt: z.string().optional(),
    head_sha: z.string().optional(),
    conclusion: z.string().optional(),
    error: z.string().optional(),
    /** true = the executor saw the gate conclusively FAIL (run failed /
     *  cancelled, checks red) — as opposed to a transient gh error. */
    conclusive: z.boolean().optional(),
  }),
  train_history: z.looseObject({
    repo: z.string().optional(),
    base: z.string().optional(),
    kind: z.string().optional(),
    pr: z.number().int().optional(),
    limit: z.number().int().max(200).optional(),
  }),
  train_lane: z.looseObject({
    repo: z.string(),
    base: z.string().optional(),
    // BR#5186: the executor's reseed ask — its first-hand probe says the
    // base branch is LIVE on the remote while every lane card for the key is
    // terminal. Omitted/false keeps the BR#4977 retirement refusal.
    base_live: z.boolean().optional(),
    spec: z
      .looseObject({
        required_workflows: z.array(z.string()).optional(),
        ci_typical_minutes: z.number().optional(),
      })
      .optional(),
  }),
  // ---- board↔GitHub reconciliation (BR#4170). The gateway daemon feeds
  // OBSERVED open-PR facts (read-only `gh pr list`; the hub holds NO VCS
  // credentials — accepted BR#3507); the hub joins them against card
  // bindings, accounts every reviewed PR as bound / ignored-with-reason /
  // in-flight, and alarms on drift. The report never merges, never queues
  // by itself — verify acceptance stamps the queue (BR#4079 contract).
  reconcile_schedule: z.looseObject({}),
  reconcile_report: z.looseObject({
    repo: z.string(),
    gateway: z.string().optional(),
    observed_at: z.number().int().optional(),
    prs: z.array(
      z.looseObject({
        number: z.number().int(),
        title: z.string().nullish(),
        reviewDecision: z.string().nullish(),
        mergeable: z.string().nullish(),
        mergeStateStatus: z.string().nullish(),
        headRefOid: z.string().nullish(),
        headRefName: z.string().nullish(),
        updatedAt: z.string().nullish(),
        isDraft: z.boolean().nullish(),
      }),
    ),
  }),
  reconcile_status: z.looseObject({
    repo: z.string().optional(),
    limit: z.number().int().max(50).optional(),
  }),
  reconcile_ignore: z.looseObject({
    repo: z.string(),
    pr: z.number().int(),
    reason: z.string().min(1),
  }),
} as const satisfies Record<ToolName, z.ZodType>;
