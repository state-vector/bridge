/**
 * Ask create/answer payload contract — BR#2844.
 *
 * The hub enforces the full rules (question ends with "?", reason required
 * for human-directed asks, options deduped); this schema is the payload
 * shape both sides share — the MCP tool schemas for ask_agent/answer_ask
 * are derived from the same rules.
 */
import { z } from "zod";

/** Typed effects a choice can name. The WEB-EXECUTABLE set (release,
 * clear_hold, supersede, close) is performed BY THE CLICK: the ask surfaces
 * render such choices as direct action buttons running the owner web
 * plane's audited ops (BR#21657 overrides / transitions) and then record
 * the answer with a receipt — never a confirmation the human must then
 * hunt for (BR#21762). `local_handoff` keeps its old meaning: the human
 * genuinely performs the step outside Bridge. */
export const ASK_CHOICE_ACTIONS = ["resume", "hold", "release", "local_handoff", "clear_hold", "supersede", "close"] as const;
export type AskChoiceAction = (typeof ASK_CHOICE_ACTIONS)[number];
export const WEB_EXECUTABLE_ACTIONS: ReadonlySet<string> = new Set(["release", "clear_hold", "supersede", "close"]);

/** BR#22008 — typed-answer law. The answer that resolves a Decision must
 *  reference a choice EXACTLY (buttons submit the full label; MCP callers
 *  echo it verbatim). Free text is commentary: recorded on the ask, rendered
 *  for humans, never dispatched — the BR#5570 ("(Recommended)" prefix broke
 *  the verb matcher) / BR#17095 (SUPERSEDE click silently downgraded to a
 *  pool release) matcher class is deleted by law, not patched. Matching is
 *  exact-equality against the closed choice set; the returned choice's
 *  typed `action` is the sole dispatch key. */
export function resolveChoice(decision: HumanDecision, answer: string): HumanDecision["choices"][number] | null {
  const a = answer.trim();
  return decision.choices.find((c) => c.label === a) ?? null;
}

/** BR#22008 — the closed legacy option-intent registry. A NON-decision ask
 *  (the pre-BR#21762 shape: options, no `decision` struct) has no typed
 *  choice actions, yet its option clicks still carry the documented laws —
 *  BR#3913 (the answered ask's SUPERSEDE option authorises the drop),
 *  BR#18868 (a KEEP click is the deliberate park), BR#5570 (the option may
 *  carry the "(Recommended) " display prefix). The registry resolves the
 *  intent of an EXACTLY-MATCHED OPTION LABEL — the ask's own authored
 *  closed set, never the free-text answer (an answer that matches no option
 *  dispatches nothing; prose is commentary). Prefixes are the closed
 *  vocabulary the hub's ask producers have filed for years — adding an
 *  intent means adding a registry row, never parsing answer text. */
export const LEGACY_OPTION_ACTIONS: ReadonlyArray<{ prefix: string; action: "supersede" | "release" | "hold" }> = [
  { prefix: "SUPERSEDE", action: "supersede" },
  { prefix: "RELEASE", action: "release" },
  { prefix: "KEEP", action: "hold" },
  { prefix: "RE-SCOPE", action: "hold" },
];

export function legacyOptionAction(option: string): "supersede" | "release" | "hold" | undefined {
  const clean = option.trim().replace(/^\(recommended\)\s*/i, "");
  for (const e of LEGACY_OPTION_ACTIONS) if (clean.startsWith(e.prefix)) return e.action;
  return undefined;
}

/** The choice and its effect are separate from display prose. A location used
 * for notifications is never the action target. Diagnostic uncertainty has no
 * human-decision category: Bridge must investigate it first. */
export const HumanDecisionSchema = z.object({
  kind: z.enum(["authority", "information", "preference"]),
  task_id: z.string().regex(/^BR#\d+$/),
  context: z.string().trim().min(1).max(2000),
  why_human: z.string().trim().min(1).max(1200),
  choices: z.array(z.object({
    label: z.string().trim().min(1).max(200),
    executor: z.enum(["bridge", "human"]),
    consequence: z.string().trim().min(1).max(500),
    action: z.enum(ASK_CHOICE_ACTIONS),
  })).min(2).max(8),
}).superRefine((d, ctx) => {
  if (new Set(d.choices.map((c) => c.label)).size !== d.choices.length) ctx.addIssue({ code: "custom", message: "decision choice labels must be unique" });
  for (const c of d.choices) if (c.executor === "human" && c.action !== "hold" && c.action !== "local_handoff" && !WEB_EXECUTABLE_ACTIONS.has(c.action)) ctx.addIssue({ code: "custom", message: "a human execution step must hold the task, enter explicit local handoff, or name a web-executable action (release, clear_hold, supersede, close) the ask button performs itself" });
  if (d.choices.some((c, i) => i > 0 && /^\(recommended\)/i.test(c.label))) ctx.addIssue({ code: "custom", message: "put the recommended choice first" });
});
export type HumanDecision = z.infer<typeof HumanDecisionSchema>;

/** One admission rule for inferred audiences, direct artefact writes and MCP.
 * Legacy stored requests remain readable/answerable; new human requests must
 * explain a real choice and bind its effect independently of the button text. */
export function requireHumanDecision(ask: { route?: unknown; to?: unknown; decision?: unknown; artefact_id?: unknown; options?: unknown }): HumanDecision | undefined {
  if (!isHumanDecisionAsk(ask)) {
    if (ask.decision !== undefined) throw new Error("decision is only valid for human_decision requests");
    return undefined;
  }
  if (!ask.decision) throw new Error("human_decision requires decision: affected task, plain-language context, why only the human can decide, and choices naming executor, consequence and action; diagnostics belong to agent recovery");
  const decision = HumanDecisionSchema.parse(ask.decision);
  if (ask.artefact_id && ask.artefact_id !== decision.task_id) throw new Error("the decision's affected task must match artefact_id; notification sinks are not action targets");
  if (ask.options !== undefined && JSON.stringify(ask.options) !== JSON.stringify(decision.choices.map(c => c.label))) throw new Error("human ask options must match the decision choices exactly");
  return decision;
}

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

export const CoordinationRequestIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const CoordinationWaitSchema = z.strictObject({
  request_id: CoordinationRequestIdSchema.describe("Caller-generated unique ID. Retry with the same ID and question, even if you never received a response."),
  wait_ms: z.number().int().min(0).max(15_000).optional().describe("Default 5000; use 0 to check without waiting."),
});
export type CoordinationResult = { id: string } & (
  | { state: "pending"; wait_skipped?: "caller_session_unknown" | "same_executor" | "no_live_executor" }
  | Exclude<AskLifecycle, { state: "open" }>
);
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

/* ------------------------------------------------------------------ */
/* Well-known ask templates (BR#21762). Common asks compose from a     */
/* closed registry — the hub writes the copy, so there is no random    */
/* variation and length content, and every template's primary choice   */
/* carries a typed web-executable action the ask button performs on    */
/* click (audited owner override / transition), not a confirmation     */
/* the human must then hunt for. Producers pass template + structured  */
/* fields; NEVER question/options/decision alongside it.               */

const T_TASK = z.string().regex(/^BR#\d+$/);
const T_SUBJECT = z.string().trim().min(1).max(140);
const T_WHY_NOW = z.string().trim().max(280).optional();

export const AskTemplateSchema = z.discriminatedUnion("kind", [
  /** Release a stale/wedged claim to the pool (holder gone, machine exits gate-refused). */
  z.object({ kind: z.literal("release_hold"), task_id: T_TASK, subject: T_SUBJECT, why_now: T_WHY_NOW }),
  /** Clear a stale hold marker whose defect no longer matches live state. */
  z.object({ kind: z.literal("clear_hold"), task_id: T_TASK, subject: T_SUBJECT, hold: z.enum(["merge_train", "await_event", "bound_ask"]), why_now: T_WHY_NOW }),
  /** Apply the resume leg on a card whose typed wait already fired (answer auto-resumes the bound card). */
  z.object({ kind: z.literal("resume_card"), task_id: T_TASK, subject: T_SUBJECT, why_now: T_WHY_NOW }),
  /** Apply the credential-gated completion disposition on an evidence-complete card. */
  z.object({ kind: z.literal("close_card"), task_id: T_TASK, subject: T_SUBJECT, disposition: z.enum(["done", "in_review"]), receipts: z.string().trim().min(1).max(600), why_now: T_WHY_NOW }),
  /** Rework loop (system:reaper class): release, supersede or re-scope. */
  z.object({ kind: z.literal("churn_loop"), task_id: T_TASK, subject: T_SUBJECT, attempts: z.number().int().min(2).max(999), last_reason: z.string().trim().max(200).optional(), why_now: T_WHY_NOW }),
  /** Human-gated merge: the asker executes the merge on GO. */
  z.object({ kind: z.literal("merge_now"), task_id: T_TASK, subject: T_SUBJECT, repo: z.string().trim().min(3).max(100), pr: z.number().int().positive(), why_now: T_WHY_NOW }),
]);
export type AskTemplate = z.infer<typeof AskTemplateSchema>;

const HOLD_WORD: Record<Extract<AskTemplate, { kind: "clear_hold" }>["hold"], string> = {
  merge_train: "merge-train bounce",
  await_event: "typed wait",
  bound_ask: "bound ask",
};

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
  /** BR#21762: well-known ask kind — the hub composes question/reason/
   *  details/decision/options from the closed registry (fixed concise
   *  copy, typed one-click actions). Mutually exclusive with the fields
   *  it composes. */
  template: AskTemplateSchema.optional(),
});
export type AskCreatePayload = z.infer<typeof AskCreatePayloadSchema>;

/** Compose the full ask payload from a template. Pure: the worker's
 *  askCreate runs the result through the SAME admission rules as a
 *  hand-written ask (requireHumanDecision validates it like any other). */
export function composeTemplateAsk(t: AskTemplate): { question: string; reason: string; details: string; decision: HumanDecision; options: string[] } {
  const why = t.why_now ? `\n\nWhy now: ${t.why_now}` : "";
  switch (t.kind) {
    case "release_hold":
      return {
        question: `Release the stale claim on ${t.task_id} — ${t.subject}?`,
        reason: "Only your owner web credential can release this claim; every machine exit is gate-refused or the holder is gone.",
        details: `**Release ${t.task_id}** (${t.subject}). One click runs the audited owner override: the claim releases to the pool, hold state is untouched, and nothing on GitHub or in any repo changes.${why}`,
        decision: {
          kind: "authority", task_id: t.task_id,
          context: `**Release ${t.task_id}** (${t.subject}). One click runs the audited owner override: the claim releases to the pool, hold state is untouched, and nothing on GitHub or in any repo changes.${why}`,
          why_human: "Only your owner web credential can release this claim; every machine exit is gate-refused or the holder is gone.",
          choices: [
            { label: "Release", executor: "human", action: "release", consequence: "One click releases the claim to the pool (audited). You do nothing else." },
            { label: "Keep held", executor: "bridge", action: "hold", consequence: "The claim stays; recovery duties keep re-verifying the unchanged state." },
          ],
        },
        options: ["Release", "Keep held"],
      };
    case "clear_hold":
      return {
        question: `Clear the stale ${HOLD_WORD[t.hold]} hold on ${t.task_id} — ${t.subject}?`,
        reason: "The hold's defect no longer matches live state; only your owner web credential can clear it.",
        details: `**Clear the ${HOLD_WORD[t.hold]} hold on ${t.task_id}** (${t.subject}). One click runs the audited owner override: the stale marker is removed and the card keeps its status. Live train slots cannot be cleared — the button refuses loudly if the slot went live again.${why}`,
        decision: {
          kind: "authority", task_id: t.task_id,
          context: `**Clear the ${HOLD_WORD[t.hold]} hold on ${t.task_id}** (${t.subject}). One click runs the audited owner override: the stale marker is removed and the card keeps its status. Live train slots cannot be cleared — the button refuses loudly if the slot went live again.${why}`,
          why_human: "The hold's defect no longer matches live state; only your owner web credential can clear it.",
          choices: [
            { label: "Clear hold", executor: "human", action: "clear_hold", consequence: "One click clears the stale marker (audited); the card keeps its status." },
            { label: "Keep parked", executor: "bridge", action: "hold", consequence: "The hold stays; the sweep keeps re-firing its predicate." },
          ],
        },
        options: ["Clear hold", "Keep parked"],
      };
    case "resume_card":
      return {
        question: `Resume ${t.task_id} — its wait already fired (${t.subject})?`,
        reason: "The machine resume is credential-gated for dispatched sessions; your answer authorizes and triggers the resume leg.",
        details: `**Resume ${t.task_id}** (${t.subject}). Its typed wait fired and is verified; only the resume leg is missing. Your click records GO and the hub applies the resume on the bound card immediately — no hunting, no manual transitions.${why}`,
        decision: {
          kind: "authority", task_id: t.task_id,
          context: `**Resume ${t.task_id}** (${t.subject}). Its typed wait fired and is verified; only the resume leg is missing. Your click records GO and the hub applies the resume on the bound card immediately — no hunting, no manual transitions.${why}`,
          why_human: "The machine resume is credential-gated for dispatched sessions; your answer authorizes and triggers the resume leg.",
          choices: [
            { label: "Resume now", executor: "bridge", action: "resume", consequence: "The hub applies the resume leg on the bound card the moment you click." },
            { label: "Keep parked", executor: "bridge", action: "hold", consequence: "The card stays parked on the fired wait." },
          ],
        },
        options: ["Resume now", "Keep parked"],
      };
    case "close_card": {
      const word = t.disposition === "done" ? "delivered" : "in review";
      return {
        question: `Close ${t.task_id} as ${word} — ${t.subject}?`,
        reason: "The completion leg is credential-gated: only your live web credential can apply the disposition.",
        details: `**Close ${t.task_id} as ${word}** (${t.subject}). One click applies the disposition; the hub's gates still validate and refuse loudly if the receipts are stale.\n\nReceipts: ${t.receipts}${why}`,
        decision: {
          kind: "authority", task_id: t.task_id,
          context: `**Close ${t.task_id} as ${word}** (${t.subject}). One click applies the disposition; the hub's gates still validate and refuse loudly if the receipts are stale.\n\nReceipts: ${t.receipts}${why}`,
          why_human: "The completion leg is credential-gated: only your live web credential can apply the disposition.",
          choices: [
            { label: `Close as ${word}`, executor: "human", action: "close", consequence: "One click applies the disposition with the cited receipts; gates still validate server-side." },
            { label: "Keep open", executor: "bridge", action: "hold", consequence: "The card stays open; recovery keeps re-verifying." },
          ],
        },
        options: [`Close as ${word}`, "Keep open"],
      };
    }
    case "churn_loop":
      return {
        question: `${t.task_id} is stuck in a rework loop (${t.attempts} attempts) — release, drop, or re-scope?`,
        reason: "Re-releasing unchanged repeats the same claim→stall cycle; the disposition is a human call.",
        details: `**${t.task_id}** (${t.subject}) has failed ${t.attempts} dispatch attempts.${t.last_reason ? ` Last release reason: ${t.last_reason}.` : ""} Re-releasing unchanged just repeats the cycle — pick the disposition. Release and Supersede are one-click owner overrides; Re-scope waits for your rewrite of the brief (use the detail view).`,
        decision: {
          kind: "authority", task_id: t.task_id,
          context: `**${t.task_id}** (${t.subject}) has failed ${t.attempts} dispatch attempts.${t.last_reason ? ` Last release reason: ${t.last_reason}.` : ""} Re-releasing unchanged just repeats the cycle — pick the disposition. Release and Supersede are one-click owner overrides; Re-scope waits for your rewrite of the brief (use the detail view).`,
          why_human: "Re-releasing unchanged repeats the same claim→stall cycle; the disposition is a human call.",
          choices: [
            { label: "Release to pool", executor: "human", action: "release", consequence: "One click releases the claim (audited); reasonable only if the failures were environmental." },
            { label: "Supersede — drop it", executor: "human", action: "supersede", consequence: "One click supersedes the card (audited); the work is moot, done elsewhere, or not worth the loop." },
            { label: "Re-scope it", executor: "human", action: "local_handoff", consequence: "You rewrite the card's brief (title/body/exit condition); the card waits for your edit." },
          ],
        },
        options: ["Release to pool", "Supersede — drop it", "Re-scope it"],
      };
    case "merge_now":
      return {
        question: `Merge ${t.repo}#${t.pr} into main now — ${t.subject}?`,
        reason: "The merge is human-gated; your GO executes it through the asker's merge lane.",
        details: `**Merge ${t.repo}#${t.pr}** (${t.subject}). Your GO executes the merge through the asker's merge lane and the receipts land on ${t.task_id}.${why}`,
        decision: {
          kind: "authority", task_id: t.task_id,
          context: `**Merge ${t.repo}#${t.pr}** (${t.subject}). Your GO executes the merge through the asker's merge lane and the receipts land on ${t.task_id}.${why}`,
          why_human: "The merge is human-gated; your GO executes it through the asker's merge lane.",
          choices: [
            { label: "Merge now", executor: "bridge", action: "resume", consequence: "The asker merges on your GO and posts the receipts on the card." },
            { label: "Hold", executor: "bridge", action: "hold", consequence: "The merge waits; nothing changes." },
          ],
        },
        options: ["Merge now", "Hold"],
      };
  }
}

export const AskAnswerPayloadSchema = z.object({
  id: z.string(),
  answer: z.string().min(1),
});
export type AskAnswerPayload = z.infer<typeof AskAnswerPayloadSchema>;
