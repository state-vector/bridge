/**
 * The orient response contract (hub → every runner/session) — BR#2844.
 *
 * The incident: a key rename in the hub's orient response silently zeroed
 * the runner's work list. Nothing parsed failed; the lists just came back
 * empty. This schema is the checked-in shape both sides build against:
 * the hub's serializer validates its response here in CI, and the runner's
 * Rust gate (dispatch.rs `orient_contract_error`) mirrors the same key set
 * from the SAME fixture (`fixtures/orient.json`) the schema is tested
 * against. Renaming a key without updating all three fails CI.
 *
 * Key law: EXACTLY the 14 required top-level keys below. The hub may add
 * extra keys (loose parse tolerates them — e.g. the guidance `note`), but a
 * required key missing or mistyped is a contract breach, never a silent zero.
 */
import { z } from "zod";

/** One {type, status, n} row of the board counts array. */
export const OrientCountSchema = z.object({
  type: z.string(),
  status: z.string(),
  n: z.number(),
});
export type OrientCount = z.infer<typeof OrientCountSchema>;

/**
 * An item of `my_tasks` — work owned by (or dispatched by) the calling
 * identity. `tags` rides along so the runner can see `role:*` dispatch
 * hints on resume (it read this key for months while the hub never sent
 * it — the silent-zero class in miniature; both sides were fixed in the
 * same PR as this schema).
 */
export const OrientTaskItemSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  tags: z.array(z.string()),
});
export type OrientTaskItem = z.infer<typeof OrientTaskItemSchema>;

/**
 * An item of `unclaimed_work` — the dispatch surface. The runner reads
 * id/title/status and the claimability verdicts (needs_qualification,
 * is_claimable); everything else is context for the agent.
 */
export const OrientCandidateItemSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  tags: z.array(z.string()),
  target_roles: z.array(z.string()),
  project: z.string().nullable(),
  updated_ts: z.number(),
  needs_qualification: z.boolean(),
  is_claimable: z.boolean(),
  is_question: z.boolean(),
  meta: z.unknown(),
  previously_attempted: z.unknown().optional(),
});
export type OrientCandidateItem = z.infer<typeof OrientCandidateItemSchema>;

/** THE orient response — exactly these 14 keys are required. */
export const OrientResponseSchema = z.looseObject({
  project: z.string(),
  instructions: z.string(),
  board: z.looseObject({ mode: z.string() }),
  counts: z.array(OrientCountSchema),
  open_artefacts: z.array(
    z.looseObject({
      id: z.string(),
      type: z.string(),
      title: z.string(),
      status: z.string(),
      owner: z.string().nullable(),
      updated_ts: z.number(),
    }),
  ),
  my_tasks: z.array(OrientTaskItemSchema),
  unclaimed_work: z.array(OrientCandidateItemSchema),
  steering: z.array(
    z.looseObject({
      id: z.string(),
      title: z.string(),
      tags: z.array(z.string()),
      body_md: z.string(),
    }),
  ),
  my_roles: z.array(z.unknown()),
  pending_asks: z.array(z.unknown()),
  gauge_debt: z.array(z.looseObject({ id: z.string(), title: z.string() })),
  my_score: z.looseObject({
    score: z.number(),
    label: z.string(),
    grade: z.string(),
    abandoned: z.number().optional(),
    artefacts_created: z.number().optional(),
    asks_answered_on_time: z.number().optional(),
    asks_received: z.number().optional(),
    gauge_count: z.number().optional(),
    hints: z.array(z.string()).optional(),
    progress_count: z.number().optional(),
    reassigned: z.number().optional(),
    thin_notes: z.number().optional(),
    verify_duty_backlog: z.number().optional(),
  }),
  build: z.string(),
  you: z.object({
    agent: z.string(),
    session: z.string(),
    tags: z.array(z.string()),
  }),
});
export type OrientResponse = z.infer<typeof OrientResponseSchema>;

/** The 14 keys every orient response must carry (fixture `keys_required`). */
export const ORIENT_REQUIRED_KEYS = Object.keys(OrientResponseSchema.shape);
