import { useEffect, useState } from "react";
import { TaskDetail, DecisionPopover, kbApi, type KbArtefact } from "@bridge/ui-kit";

/** Full-window detail shell: main.tsx routes ?task= / ?decision= here when a
 *  row asks for its own OS window. The overlay components render full-bleed
 *  via .task-window (backdrop hidden, panel static). */
export function TaskWindow() {
  const params = new URLSearchParams(window.location.search);
  const taskId = params.get("task");
  const decisionId = params.get("decision");
  const [decision, setDecision] = useState<KbArtefact | null>(null);
  const [decErr, setDecErr] = useState("");

  useEffect(() => {
    if (!decisionId) return;
    let on = true;
    const to = setTimeout(() => { if (on) setDecErr("no answer in 15s — reopen the window"); }, 15000);
    kbApi.artefact(decisionId)
      .then((a) => { clearTimeout(to); if (on) { setDecision(a as KbArtefact); setDecErr(""); } })
      .catch((e) => { clearTimeout(to); if (on) setDecErr(String((e as Error).message ?? e)); });
    return () => { on = false; clearTimeout(to); };
  }, [decisionId]);

  if (taskId) {
    return (
      <div className="task-window">
        <TaskDetail taskId={taskId} onClose={() => window.close()} onOpen={(id) => openOther(id)} />
      </div>
    );
  }
  if (decisionId && decision) {
    return (
      <div className="task-window">
        <DecisionPopover d={decision} onClose={() => window.close()} onChanged={() => {}} />
      </div>
    );
  }
  return <div className="task-window task-window-empty">{decisionId ? (decErr ? `load decision failed: ${decErr}` : "loading decision…") : "nothing to show"}</div>;
}

/** refs inside a detail window open ANOTHER window (never navigate this one) */
function openOther(id: string) {
  void import("./detailWindow").then((m) => m.openDetailWindow(/^ASK-|^DECISION-/.test(id) ? "decision" : "task", id));
}
