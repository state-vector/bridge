/**
 * Ask create/answer payload contract — BR#2844.
 *
 * The hub enforces the full rules (question ends with "?", reason required
 * for human-directed asks, options deduped); this schema is the payload
 * shape both sides share — the MCP tool schemas for ask_agent/answer_ask
 * are derived from the same rules.
 */
import { z } from "zod";

/** The choice and its effect are separate from display prose. A location used
 * for notifications is never the action target. Diagnostic uncertainty has no
 * human-decision category: Bridge must investigate it first. */
export const HumanDecisionSchema = z.object({
  kind: z.enum(["authority", "information", "preference"]),
  task_id: z.string().regex(/^BR#\d+$/),
  context: z.string().min(1).max(2000),
  why_human: z.string().min(1).max(1200),
  choices: z.array(z.object({
    label: z.string().min(1).max(200),
    executor: z.enum(["bridge", "human"]),
    consequence: z.string().min(1).max(500),
    action: z.enum(["resume", "hold", "release", "local_handoff"]),
  })).min(2).max(8),
}).superRefine((d, ctx) => {
  if (new Set(d.choices.map((c) => c.label)).size !== d.choices.length) ctx.addIssue({ code: "custom", message: "decision choice labels must be unique" });
  for (const c of d.choices) if (c.executor === "human" && c.action !== "hold") ctx.addIssue({ code: "custom", message: "a human execution step must hold the task until completion is confirmed" });
});
export type HumanDecision = z.infer<typeof HumanDecisionSchema>;

/** Audience and lifecycle are explicit. Review is executable work, never a
 * human decision disguised as an ask. Missing routes are legacy input only. */
export const AskRouteSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human_decision") }),
  z.object({ kind: z.literal("agent_coordination") }),
  z.object({ kind: z.literal("executor_coordination"), task_id: z.string().min(1) }),
  z.object({ kind: z.literal("independent_review"), task_id: z.string().min(1) }),
]);
export type AskRoute = z.infer<typeof AskRouteSchema>;

/** The artefact row is authoritative: progress is never an answer and
 * terminal requests cannot be reopened by an escalation/presence timer. */
export type AskLifecycle =
  | { state: "open" }
  | { state: "answered"; answer: string; by: string }
  | { state: "cancelled"; reason: string }
  | { state: "expired"; reason: string };
export function askLifecycle(node: { status: string; meta?: { ask?: { answer?: string; answered_by?: string; resolution?: { kind?: string; reason?: string } } } }): AskLifecycle {
  const ask = node.meta?.ask;
  if (ask?.answer) return { state: "answered", answer: ask.answer, by: ask.answered_by ?? "unknown" };
  if (node.status === "done" || node.status === "superseded") return { state: ask?.resolution?.kind === "expired" ? "expired" : "cancelled", reason: ask?.resolution?.reason ?? "The coordination request is no longer needed." };
  return { state: "open" };
}

const HUMAN_TARGETS = new Set(["human", "ray", "rayh"]);
export function askRoute(ask: { route?: unknown; to?: unknown }): AskRoute {
  if (ask.route !== undefined) return AskRouteSchema.parse(ask.route);
  // A coordinator's agent token is still an agent. Neither bare labels nor
  // offline/escalated stamps confer human audience or authority.
  return { kind: HUMAN_TARGETS.has(String(ask.to ?? "")) ? "human_decision" : "agent_coordination" };
}
export function isHumanDecisionAsk(ask: { route?: unknown; to?: unknown }): boolean {
  return askRoute(ask).kind === "human_decision";
}

export const AskCreatePayloadSchema = z.looseObject({
  route: AskRouteSchema.optional(),
  decision: HumanDecisionSchema.optional(),
  /** Agent label, label@session, tag:<capability>, "human", or "any". */
  to: z.string().optional(),
  /** THE ask itself — one answerable sentence, ≤240 chars. */
  question: z.string().min(1).max(240).optional(),
  /** WHY this is escalated instead of automatic (required for humans). */
  reason: z.string().optional(),
  /**
   * Self-contained plain-reading brief — REQUIRED for human-directed asks
   * (the hub rejects human asks without it): what this is about, current
   * state, why it needs a human. Gloss every BR#/PR# reference in one
   * clause; never rely on the reader knowing other cards.
   */
  details: z.string().optional(),
  /**
   * 2–8 one-click answers — humans answer by clicking. If you recommend
   * one, make it options[0] and prefix it "(Recommended)" — the first
   * button IS the recommendation.
   */
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
