import { HumanDecisionSchema } from "@bridge/contracts";
import { md } from "./decide";

/** Essential context first; evidence is secondary. Shared by every ask surface. */
export function AskContext({ body, ask }: { body?: string; ask: { reason?: string; decision?: unknown } }) {
  const parsed = HumanDecisionSchema.safeParse(ask.decision);
  if (parsed.success) {
    const decision = parsed.data;
    return <>
      <p className="ask-reason">{decision.context}</p>
      <p className="ask-reason"><b>Why your decision is needed:</b> {decision.why_human}</p>
      {body?.trim() && body.trim() !== decision.context.trim() && <details><summary>Evidence and technical details</summary><div className="md-body" dangerouslySetInnerHTML={{ __html: md(body) }} /></details>}
    </>;
  }
  // Legacy requests keep their full essential brief until their producer is
  // migrated; never hide the only context behind a details control.
  return <>
    {ask.reason && <p className="ask-reason"><b>Why your decision is needed:</b> {ask.reason}</p>}
    {body?.trim() && <div className="md-body" dangerouslySetInnerHTML={{ __html: md(body) }} />}
  </>;
}
