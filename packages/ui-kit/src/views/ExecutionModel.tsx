import { useEffect, useState } from "react";
import { ExecutionModelViewSchema, executionPresentation, type ExecutionModelView } from "@bridge/contracts";

/** Never substitute a requested tier or gateway inventory for an actual receipt. */
function useExecutionView(value: ExecutionModelView | undefined, now?: number) {
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    if (now !== undefined) return;
    const timer = setInterval(() => setClock(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, [now]);
  const parsed = ExecutionModelViewSchema.safeParse(value);
  const view = parsed.success ? parsed.data : { minimum_tier: null, current: { kind: "unreported" as const } };
  return { view, presentation: executionPresentation(view, now ?? clock) };
}

export function ExecutionModel({ value, now }: { value: ExecutionModelView | undefined; now?: number }) {
  const { view, presentation } = useExecutionView(value, now);
  const current = view.current;
  const label = presentation.requested ? `${presentation.size} => ${presentation.requested}` : presentation.size;
  const title = current.kind === "unreported" ? "No actual model receipt was reported. Requirements are not evidence of model use."
    : current.kind === "managed" ? `Recorded ${current.tier} model: ${current.model ?? "ID unreported"}; ${current.backend}; host ${current.host}; session ${current.session}; attempt ${current.generation}`
    : `Interactive session ${current.session}: uses its locally configured model; Bridge does not assign a model tier.`;
  return <span className="execution-model" aria-label="Execution model">
    <span className="execution-model-size" title={`${title}${presentation.requested ? `; upgrade requested to ${presentation.requested}, not yet observed` : ""}`}>{label}</span>
  </span>;
}

export function ExecutionStatus({ value, now }: { value: ExecutionModelView | undefined; now?: number }) {
  const { presentation } = useExecutionView(value, now);
  return <span className="execution-state" aria-label="Execution state" title="Execution observation state — independent of model size and task lifecycle">{presentation.state}</span>;
}
