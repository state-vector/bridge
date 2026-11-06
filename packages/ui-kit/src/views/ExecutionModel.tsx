import { useEffect, useState } from "react";
import { ExecutionModelViewSchema, type ExecutionModelView } from "@bridge/contracts";

/** Never substitute a requested tier or gateway inventory for an actual receipt. */
export function ExecutionModel({ value, now }: { value: ExecutionModelView | undefined; now?: number }) {
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    if (now !== undefined) return;
    const timer = setInterval(() => setClock(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, [now]);
  const parsed = ExecutionModelViewSchema.safeParse(value);
  const view = parsed.success ? parsed.data : { minimum_tier: null, current: { kind: "unreported" as const } };
  const current = view.current;
  const time = now ?? clock;
  const phase = current.kind === "managed" && !["quiesced", "previous"].includes(current.phase) && current.lease_until <= time ? "expired"
    : current.kind !== "unreported" ? current.phase : "unreported";
  const live = phase === "running" || phase === "active";
  const label = current.kind === "unreported" ? "size unreported" : `${current.tier}${live ? "" : ` · ${phase === "quiesced" || phase === "previous" ? "last run" : phase}`}`;
  const title = current.kind === "unreported" ? "No actual model receipt was reported. Requirements are not evidence of model use."
    : `${live ? "Actual" : "Recorded"} ${current.tier} model: ${current.model ?? "ID unreported"}; ${current.backend}; host ${current.host}; session ${current.session}${current.kind === "managed" ? `; attempt ${current.generation}` : "; human-authorised local session"}`;
  const unmet = view.minimum_tier && (current.kind === "unreported" || ["small", "medium", "large"].indexOf(view.minimum_tier) > ["small", "medium", "large"].indexOf(current.tier));
  return <span className="execution-model" aria-label="Execution model">
    <span className={`execution-model-size ${live ? "model-live" : "model-recorded"}`} title={title}>{label}</span>
    {unmet && <span className="execution-model-request" title="Requested minimum — this is not the currently running model">→ {view.minimum_tier} requested</span>}
  </span>;
}
