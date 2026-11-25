import { useState } from "react";
import { AskTemplateSchema, HumanDecisionSchema, WEB_EXECUTABLE_ACTIONS } from "@bridge/contracts";
import { kbApi } from "../server/kb";
import { useKb } from "../server/kbStore";
import { Btn } from "./index-kit";

/** BR#21762 — typed ask templates + direct one-click actions.
 *
 *  Common asks compose from a closed registry (hub-side, fixed concise
 *  copy), and their primary choice names a typed WEB-EXECUTABLE action.
 *  The ask surfaces render that choice as a direct primary button which
 *  PERFORMS the action through the owner web plane's audited ops
 *  (BR#21657 release/clear + supersede/transition) and then records the
 *  answer with a receipt — never "confirm you will do it, then hunt for
 *  how". The same derivation also upgrades existing stock asks whose
 *  decision already carries an executable action.
 *
 *  Error law (the ownerOverrides precedent): a refused op surfaces the
 *  server's message inline and the ask stays open — no optimistic
 *  mutation anywhere. */

export type AskActionOp = "release_claim" | "clear_hold" | "supersede" | "close_card";

export interface AskActionPlan {
  op: AskActionOp;
  taskId: string;
  /** specific hold for clear_hold; resolved live from the target card when absent */
  hold?: "merge_train" | "await_event" | "bound_ask";
  /** close_card target status */
  to?: "done" | "in_review";
  /** button text (recommended-prefix stripped — position IS the recommendation) */
  label: string;
  /** the choice label recorded as the ask answer */
  answer: string;
  /** audit reason sent with the op */
  reason: string;
  /** one-line caption under the button */
  hint: string;
}

function firstSentence(s: string): string {
  const m = s.match(/^[^.!?\n]+[.!?]?/);
  return (m ? m[0] : s).trim();
}

/** The recommended executable choice of an ask, as a client op plan —
 *  null when nothing on this ask is web-executable (answer-only). Pure:
 *  derivable both from composed template asks and from existing stock
 *  asks whose decision carries an executable action. */
export function askActionPlan(ask: { decision?: unknown; template?: unknown }, askId: string): AskActionPlan | null {
  const parsed = HumanDecisionSchema.safeParse(ask.decision);
  if (!parsed.success) return null;
  const d = parsed.data;
  const template = AskTemplateSchema.safeParse(ask.template);
  const tt = template.success ? template.data : undefined;
  for (const c of d.choices) {
    if (c.executor !== "human" || !WEB_EXECUTABLE_ACTIONS.has(c.action)) continue;
    const label = c.label.replace(/^\(Recommended\)\s*/i, "").trim();
    const reason = `ask ${askId}${tt ? ` (template ${tt.kind})` : ""}: ${firstSentence(d.why_human).slice(0, 180)}`;
    if (c.action === "release")
      return { op: "release_claim", taskId: d.task_id, label, answer: c.label, reason, hint: `One click answers the ask; the hub releases the claim on ${d.task_id} (audited, server-side).` };
    if (c.action === "clear_hold")
      return { op: "clear_hold", taskId: d.task_id, hold: tt?.kind === "clear_hold" ? tt.hold : undefined, label, answer: c.label, reason, hint: `One click answers the ask; the hub clears the stale hold on ${d.task_id} (audited, server-side).` };
    if (c.action === "supersede")
      return { op: "supersede", taskId: d.task_id, label, answer: c.label, reason, hint: `One click answers the ask; the hub supersedes ${d.task_id} (audited, server-side).` };
    return { op: "close_card", taskId: d.task_id, to: tt?.kind === "close_card" ? tt.disposition : "done", label, answer: c.label, reason, hint: `One click answers the ask; the hub closes ${d.task_id} through the legal edges — gates validate server-side, and it works from any park status.` };
  }
  return null;
}

/** Compact rendering applies to templated asks and to asks whose human
 *  choices are ALL one-click — there are no manual instructions that must
 *  stay visible, so the narrative collapses behind Details. Instructable
 *  asks (gh commands, dashboard steps) keep the BR#8772 ruling: exact
 *  instructions stay expanded. */
export function isOneClickAsk(ask: { decision?: unknown; template?: unknown }): boolean {
  if (ask.template !== undefined && AskTemplateSchema.safeParse(ask.template).success) return true;
  const parsed = HumanDecisionSchema.safeParse(ask.decision);
  if (!parsed.success) return false;
  const human = parsed.data.choices.filter((c) => c.executor === "human");
  return human.length > 0 && human.every((c) => WEB_EXECUTABLE_ACTIONS.has(c.action));
}

/** The direct primary button for an ask's executable choice. BR#22008:
 *  the button ONLY submits the typed choice — kbApi.askAnswer with the
 *  exact choice label. The server's answer dispatch applies the action
 *  through the composed legal edges (system:question pen, human_verdict,
 *  every gate validated server-side, refusals surfaced on the ask). The
 *  op-first client ordering is gone by law: it 400'd on todo-parked cards
 *  before the answer recorded (the BR#21657 wedge) and duplicated the
 *  dispatch authority the server already owns. On refusal: inline error,
 *  ask unchanged. */
export function AskActionBtn({ askId, ask, disabled, onDone, onPending, size = "md" }: {
  askId: string;
  ask: { decision?: unknown; template?: unknown };
  disabled?: boolean;
  onDone: () => void;
  onPending?: (on: boolean) => void;
  size?: "sm" | "md";
}) {
  const plan = askActionPlan(ask, askId);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!plan) return null;
  const run = async () => {
    if (busy || disabled) return;
    setErr("");
    setBusy(true);
    onPending?.(true);
    try {
      // BR#22008 answer-first: submit the exact choice label; the hub
      // dispatches the typed action (never the client). The response's
      // task_status is the receipt.
      await kbApi.askAnswer(askId, plan.answer);
      await useKb.getState().refresh();
      onDone();
      // BR#6390 no-jump: stay pending until the refreshed board drops the row
      window.setTimeout(() => onPending?.(false), 20_000);
    } catch (e) {
      setErr((e as Error).message || "action failed");
      useKb.getState().reportError("ask action", e);
      onPending?.(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ask-exec-row">
      <Btn size={size} variant="accept" disabled={busy || disabled} title={plan.hint} onClick={() => void run()}>
        {busy ? "working…" : plan.label}
      </Btn>
      <span className="ask-opt-text">{plan.hint}</span>
      {err && <span className="k-err" role="alert">{err}</span>}
    </div>
  );
}
