/**
 * Ask create/answer payload contract — BR#2844.
 *
 * The hub enforces the full rules (question ends with "?", reason required
 * for human-directed asks, options deduped); this schema is the payload
 * shape both sides share — the MCP tool schemas for ask_agent/answer_ask
 * are derived from the same rules.
 */
import { z } from "zod";

export const AskCreatePayloadSchema = z.looseObject({
  /** Agent label, label@session, tag:<capability>, "human", or "any". */
  to: z.string().optional(),
  /** THE ask itself — one answerable sentence, ≤240 chars. */
  question: z.string().min(1).max(240),
  /** WHY this is escalated instead of automatic (required for humans). */
  reason: z.string().optional(),
  details: z.string().optional(),
  /** 2–8 one-click answers — humans answer by clicking. */
  options: z.array(z.string()).min(2).max(8).optional(),
  /** Your blocked task — links the decision, pauses the watchdog. */
  artefact_id: z.string().optional(),
});
export type AskCreatePayload = z.infer<typeof AskCreatePayloadSchema>;

export const AskAnswerPayloadSchema = z.object({
  id: z.string(),
  answer: z.string().min(1),
});
export type AskAnswerPayload = z.infer<typeof AskAnswerPayloadSchema>;
