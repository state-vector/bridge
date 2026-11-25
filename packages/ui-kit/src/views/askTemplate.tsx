import { useState } from "react";
import { AskTemplateSchema, HumanDecisionSchema, WEB_EXECUTABLE_ACTIONS } from "@bridge/contracts";
import { kbApi } from "../server/kb";
import type { KbArtefact } from "../server/kb";
import { useKb } from "../server/kbStore";
import { Btn } from "./index-kit";
import { detectHolds } from "./ownerOverrides";

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
      return { op: "release_claim", taskId: d.task_id, label, answer: c.label, reason, hint: `One click releases the claim on ${d.task_id} (audited owner override), then records your answer.` };
    if (c.action === "clear_hold")
      return { op: "clear_hold", taskId: d.task_id, hold: tt?.kind === "clear_hold" ? tt.hold : undefined, label, answer: c.label, reason, hint: `One click clears the stale hold on ${d.task_id} (audited), then records your answer.` };
    if (c.action === "supersede")
      return { op: "supersede", taskId: d.task_id, label, answer: c.label, reason, hint: `One click supersedes ${d.task_id} (audited), then records your answer.` };
    return { op: "close_card", taskId: d.task_id, to: tt?.kind === "close_card" ? tt.disposition : "done", label, answer: c.label, reason, hint: `One click applies the disposition on ${d.task_id}; the hub's gates still validate server-side.` };
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

/** The direct primary button for an ask's executable choice. Executes the
 *  typed op in the owner's authenticated web session (server re-verifies
 *  authority on every op), records the answer with the receipt, then
 *  refreshes. On refusal: inline error, ask unchanged. */
export function AskActionBtn({ askId, ask, target, disabled, onDone, onPending, size = "md" }: {
  askId: string;
  ask: { decision?: unknown; template?: unknown };
  /** the affected card, from the live board — used to resolve clear_hold targets */
  target?: (KbArtefact & { meta?: any }) | null;
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
      let receipt = "";
      if (plan.op === "release_claim") {
        const r = await kbApi.releaseClaim(plan.taskId, plan.reason);
        receipt = `claim released to pool (holder ${r.holder_session ?? "—"})`;
      } else if (plan.op === "clear_hold") {
        const hold = plan.hold ?? detectHolds(target ?? ({} as KbArtefact)).find((h) => h.clearable)?.kind;
        if (!hold) throw new Error("no clearable hold on the target card — open the card and use Owner overrides");
        await kbApi.clearHold(plan.taskId, hold, "clear", plan.reason);
        receipt = `${hold} hold cleared`;
      } else if (plan.op === "supersede") {
        await kbApi.supersede(plan.taskId, undefined, plan.reason);
        receipt = "card superseded";
      } else {
        const r = await kbApi.transition(plan.taskId, plan.to ?? "done", { note: plan.reason });
        receipt = `card now ${r.status}`;
      }
      await kbApi.askAnswer(askId, `${plan.answer} — executed from this ask: ${receipt}`);
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
