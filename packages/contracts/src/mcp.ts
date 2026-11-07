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
import { AskRouteSchema, HumanDecisionSchema } from "./ask.ts";
import { ExecutionResultSchema, UnblockResultSchema } from "./work.ts";
import { ReviewResultSchema } from "./review.ts";
import { DeployObservationSchema } from "./train.ts";
import { TrainQueueScanSchema } from "./train-scan.ts";
import { RecoveryCommandSchema } from "./train-recovery.ts";
import { CheckRetryCommandSchema, CandidateRepairSchema, CandidateIntegrationSchema } from "./train-checks.ts";
import { ExecutionRequestSchema, HandoffReadSchema, HandoffAcceptSchema, HandoffCheckpointSchema } from "./execution.ts";

/** Every tool name the hub has ever advertised, from the recorded fixture. */
export const TOOL_NAMES = [
  "handoffs",
  "handoff_accept",
  "handoff_checkpoint",
  "execution",
  "answer_ask",
  "ask_agent",
  "asks",
  "claim_takeover",
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
  "train_queue_facts",
  "train_lease",
  "train_status",
  "train_observe_deploy",
  "train_recovery_event",
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
  handoffs: HandoffReadSchema,
  handoff_accept: HandoffAcceptSchema,
  handoff_checkpoint: HandoffCheckpointSchema,
  execution: ExecutionRequestSchema,
  train_observe_deploy: z.looseObject({ repo: z.string(), base: z.string().optional(), observation: DeployObservationSchema }),
  train_recovery_event: RecoveryCommandSchema,
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
  claim_takeover: z.looseObject({
    id: z.string(),
    note: z.string().optional(),
    session: z.string().optional(),
  }).describe(
    "Interactive claim takeover (BR#2997/BR#6135, amended BR#6436): the card's OWNER agent, a human via web, or an authenticated FULL-AGENT credential (your token's LIVE tags say full agent — gateway/cron credentials excluded; never body-declared) atomically re-takes an in_progress task claim held by a dispatched runner session — across owners. No release→pool→re-claim race. Status stays in_progress; meta.session flips to you; the ex-holder's next state-change is gate-rejected with a stand-down order (checkpoint last_will, exit). Refused on verify/unblock duty cards and cards holding a typed wait (train slot / await_event / bound ask). Credentials with no authority anchor: ask the human or coordinate via ask_agent.",
  ),
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
    /** BR#5807: per-key MERGE against the stored meta (omitted keys preserved,
     *  present top-level keys replace wholesale) — not a whole-object replace. */
    meta: z.record(z.string(), z.unknown()).optional(),
    /** Explicit key removal (the only way to drop a meta key now). Lane-card
     *  infrastructure keys (lane/lease/currently/stop) and a parked card's
     *  blocked (when it carries a typed await) refuse meta_delete from agent
     *  sessions — machinery/human authority only, BR#5807. */
    meta_delete: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    roles: z.array(z.string()).optional(),
  }),
  transition: z.looseObject({
    execution_result: ExecutionResultSchema.optional().describe("Required for analysis/diagnostic completion and execution outcomes: actual outcome plus per-action receipts. Process exit or a prerequisite PR merge is not completion. An unblock duty may use this for its observed findings instead of a reblocked result."),
    review_result: ReviewResultSchema.optional().describe("Required when a review duty closes done. Acceptance must echo subject_revision from this duty's captured review_subject (claim response or metadata), fencing the exact task submission. accepted_pr binds task_id plus exact repo/PR/head legs; accepted_direct_main carries verified commit and CI; findings is not acceptance. A runner cannot author a verdict."),
    unblock_result: UnblockResultSchema.optional().describe("An unblock duty finding a different blocker atomically replaces the parent's wait before closing. Supply this or an execution_result with observed findings."),
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
    session: z.string().optional(),
    /** BR#6135 interactive claim takeover, amended BR#6436: with
     *  to:"in_progress" and takeover:true the transition becomes a claim
     *  re-take (owner/web-anchored, or a full-agent credential across
     *  owners — same op as claim_takeover) instead of the (illegal)
     *  in_progress→in_progress edge. */
    takeover: z.boolean().optional(),
    /** BR#6432 executor-applied batch SUPERSEDE authorization: with
     *  to:"superseded" on a blocked task, carries the answered
     *  authorization ask (batch_auth.ask, "BR#N"). The hub verifies the
     *  human answer server-side, scopes the drop to the card ids the ask
     *  names, rechecks the target's current state, and executes the drop
     *  as system:question(<answered_by>) — the agent never writes it. */
    batch_auth: z.object({ ask: z.string() }).loose().optional(),
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
  session_alive: z.looseObject({
    id: z.string(),
    session: z.string().optional(),
  }),
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
    session: z.string().optional(),
  }),
  get_history: z.looseObject({
    id: z.string(),
    limit: z.number().int().max(200).optional(),
  }),
  ask_agent: z.looseObject({
    decision: HumanDecisionSchema.optional().describe("For a human decision: the affected task, concise context, the actual missing authority/information/preference, and choices with named executor, consequence and typed action. Machine investigation is not a human decision."),
    route: AskRouteSchema.optional().describe("human_decision: a choice only the human can make; agent_coordination: peer assistance; independent_review with task_id: Bridge schedules/reuses a fresh review automatically, without asking the human"),
    to: z.string().optional(),
    question: z.string().max(240).optional().describe("Required for decisions and coordination; plain English, one complete question. Omit for independent_review work."),
    // one-line WHY escalated (≤1200); the narrative goes in details
    reason: z.string().optional(),
    // self-contained plain-reading brief — REQUIRED by the hub for
    // human-directed asks (what/why/current state; gloss BR#/PR# refs)
    details: z.string().optional(),
    // 2–8 one-click answers; recommended option FIRST, prefixed "(Recommended)"
    options: z.array(z.string()).min(2).max(8).optional(),
    artefact_id: z.string().optional(),
    session: z.string().optional(),
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
    // BR#5376 "stalled": the executor's one-per-episode batch-stall alarm —
    // a batch was selected, merges were attempted, and NOTHING landed for
    // STALL_ALARM_TICKS consecutive ticks (default 3, env
    // MERGE_TRAIN_STALL_TICKS). The hub renders the STALLED lane/banner and
    // files the one-per-episode alarm ask.
    // BR#4687 "updated": the executor's silent machine-rebase carry — the
    // train updates its OWN behind worker-authored branch and stamps the
    // carry the moment the update lands (no bounce, no status change).
    // BR#4688 "escalation_closed": the executor's expiry leg closed an escalated PR
    // after the grace lapsed (hub-validated; the card survives as the record).
    // BR#4689 L1.4 "carried": the executor's PROVEN mechanical head move —
    // a rebase-only move (same patch-ids, range-diff all-'=') extends the
    // verdict's carry chain instead of bouncing.
    kind: z.enum(["merged", "bounced", "stopped", "landed", "stalled", "updated", "escalation_closed", "carried"]),
    base: z.string().optional(),
    pr: z.number().int().optional(),
    head_sha: z.string().optional(),
    merge_sha: z.string().optional(),
    task_id: z.string().optional(),
    signer: z.string().optional(),
    run_url: z.string().optional(),
    carry_from: z.string().optional(),
    /** BR#4687 "updated": the head the machine rebase moved from.
     *  BR#4689 L1.4 (kind=carried): the chain tip the mechanical move extends */
    from_head: z.string().optional(),
    /** BR#4689 L1.4 (kind=carried): the git range-diff proof receipt */
    evidence: z.string().optional(),
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
    // BR#5376 stalled-episode facts (pr is 0 — the alarm names the BATCH, not
    // one PR; the members ride here).
    batch_members: z.array(z.number().int()).optional(),
    ticks: z.number().int().optional(),
    since: z.number().optional(),
    last_error: z.string().optional(),
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
  // BR#5114: the executor's per-tick per-entry gate verdicts for the WHOLE
  // derived queue, in walk (rank) order — the truth behind the panel's
  // queue blocks. Executor-fed facts (it gates every entry it walks);
  // hub stores + serves them; classes: ready (merges this pass) |
  // waiting (checks/mergeability pending) | conflict | needs-review |
  // blocked (protection/other).
  train_queue_facts: z.looseObject({
    repo: z.string(),
    base: z.string().optional(),
    scan: TrainQueueScanSchema.optional(),
    entries: z.array(z.looseObject({
      id: z.string(),
      pr: z.number().int().optional(),
      cls: z.enum(["ready", "waiting", "conflict", "needs-review", "blocked"]),
      repair: CandidateRepairSchema.optional(),
      integration: CandidateIntegrationSchema.optional(),
    })).optional(),
    check_retry: CheckRetryCommandSchema.optional(),
    // BR#5376: the ACTIVE batch-stall episode, executor-fed (freshness law:
    // the next stamp after a landing omits it, which clears the state by
    // itself). batch = the members in landing order; ticks = consecutive
    // land-0 ticks; since = episode start (ms epoch); for_ms = episode age;
    // last_error = WHY (the executor's truncated merge refusal).
    stalled: z
      .looseObject({
        batch: z.array(z.number().int()),
        ticks: z.number().int(),
        since: z.number(),
        for_ms: z.number().optional(),
        last_error: z.string().optional(),
      })
      .optional(),
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
        // BR#6384: the merged feed — MERGED rows ride beside the open feed
        // with their mergeCommit; null state = the legacy open feed.
        state: z.string().nullish(),
        mergeCommit: z.string().nullish(),
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

/** The executor-proved mechanical head move (BR#4689 L1.4): the live head is
 *  the stamped head REBASED — `git range-diff old...new` came back all-'='
 *  pairs (same patch-ids, same order, no content delta). Executor-fed fact
 *  like mergeable/commits: the gate reasons over it, it never self-certifies.
 *  Single TS source — the `train_event` schema above carries its wire form
 *  (kind "carried": from_head + evidence) and core.ts decideTrainGate consumes
 *  this type; the Rust gate keeps a field-for-field mirror in train_gate.rs
 *  (cross-language: one literal type cannot serve both). */
export type MechanicalMove = {
  /** the chain tip the move extends (must equal carryChainTip of the leg) */
  fromHead: string;
  /** the live head the move lands on (must equal headSha) */
  toHead: string;
  /** the proof receipt — the range-diff summary riding the carry record */
  evidence: string;
};
