import { HumanDecisionSchema } from "@bridge/contracts";
import { md } from "./decide";
import { isOneClickAsk } from "./askTemplate";

/** Essential context first; evidence is secondary. Shared by every ask surface.
 *  BR#21762: one-click asks (templated, or all human choices web-executable)
 *  render ONE line + the evidence behind a Details disclosure — the primary
 *  button performs the action, so the wall of prose is no longer the
 *  interface. Instructable asks keep the BR#8772 ruling: exact instructions
 *  stay expanded; only the narrative is line-clamped. */
export function AskContext({ body, ask }: { body?: string; ask: { reason?: string; decision?: unknown; template?: unknown } }) {
  const parsed = HumanDecisionSchema.safeParse(ask.decision);
  if (parsed.success) {
    const decision = parsed.data;
    if (isOneClickAsk(ask)) {
      return <>
        <p className="ask-reason ask-clamp" title={decision.why_human}><b>Why your decision is needed:</b> {decision.why_human}</p>
        {(decision.context.trim() || body?.trim()) && (
          <details className="ask-details">
            <summary>Details</summary>
            <div className="md-body" dangerouslySetInnerHTML={{ __html: md(decision.context) }} />
            {body?.trim() && body.trim() !== decision.context.trim() && (
              <div className="md-body" dangerouslySetInnerHTML={{ __html: md(body) }} />
            )}
          </details>
        )}
      </>;
    }
    return <>
      <p className="ask-reason ask-clamp" title={decision.context}>{decision.context}</p>
      <p className="ask-reason" ><b>Why your decision is needed:</b> {decision.why_human}</p>
      {body?.trim() && body.trim() !== decision.context.trim() && <div className="ask-instructions md-body" dangerouslySetInnerHTML={{ __html: md(body) }} />}
    </>;
  }
  // Legacy requests keep their full essential brief until their producer is
  // migrated; never hide the only context behind a details control.
  return <>
    {ask.reason && <p className="ask-reason"><b>Why your decision is needed:</b> {ask.reason}</p>}
    {body?.trim() && <div className="md-body" dangerouslySetInnerHTML={{ __html: md(body) }} />}
  </>;
}
