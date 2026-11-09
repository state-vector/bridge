import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { WorkerStatus } from "@bridge/contracts";
import { useKb } from "../server/kbStore";
import { rel } from "../server/views";
import { ConnDot, type ConnState } from "../ConnDot";
import { useWorkerStatus } from "./WorkerAvailability";

const connectionLabel = (state: ConnState) => state === "open" ? "Connected" : state === "connecting" ? "Connecting…" : "Disconnected";

export function StatusDetails({ hub, realtime, workers, lastError }: {
  hub: ConnState; realtime: ConnState; workers: WorkerStatus[] | null;
  lastError: { context: string; message: string; ts: number } | null;
}) {
  return <>
    <h3>Connections</h3>
    <div className="light-row"><span>Hub</span><span className="light-meta"><ConnDot state={hub} />{connectionLabel(hub)}</span></div>
    <div className="light-row"><span>Live updates</span><span className="light-meta"><ConnDot state={realtime} />{connectionLabel(realtime)}</span></div>
    <h3>Workers</h3>
    {workers === null && <p className="muted-note">Waiting for worker status…</p>}
    {workers?.length === 0 && <p className="muted-note">No workers registered.</p>}
    {workers?.map(worker => <div key={worker.host} className="light-worker">
      <div className="light-row"><span className="light-worker-name" title={worker.host}>{worker.host}</span>
        <span className={`light-worker-state worker-${worker.state}`} title={worker.reason}>
          {({ ready: "Ready", busy: "Busy", offline: "Offline",
            draining: worker.readiness?.kind === "updating" ? "Upgrading" : "Draining",
            unavailable: "Unavailable" })[worker.state]}
        </span>
      </div>
      <div className="light-worker-detail">{worker.occupancy
        ? `${worker.occupancy.leased} leased · ${worker.occupancy.starting} starting · ${worker.occupancy.unconfirmed} unconfirmed · ${worker.occupancy.held}/${worker.capacity} slots held`
        : `${worker.active} unresolved executions · ${worker.reserved} reserved · ${worker.capacity} slots`}</div>
      {!!worker.occupancy?.unconfirmed && <details className="light-worker-detail"><summary>Capacity held for unconfirmed executions</summary>
        <p>These are not confirmed running workers. The gateway must confirm old process groups stopped before their slots can be released.</p>
        <ul>{worker.occupancy.slots.filter(slot => slot.kind === "unconfirmed").map(slot => slot.kind === "unconfirmed" && <li key={`${slot.task_id}:${slot.generation}`}>
          {slot.task_id} · generation {slot.generation} · {slot.session} · {slot.phase} · {slot.reason.replaceAll("_", " ")}
        </li>)}</ul>
      </details>}
      {worker.reason && <div className="light-worker-detail">{worker.reason}</div>}
    </div>)}
    {lastError && <div className="light-error"><strong>Last error · {rel(lastError.ts)} ago</strong><span>{lastError.context}: {lastError.message}</span></div>}
  </>;
}

/** One fleet status surface, using the scheduler's per-host readiness/counts. */
export function StatusLights({ bridgeConn }: { bridgeConn?: ConnState }) {
  const kbConn = useKb(s => s.conn);
  const awaitingHuman = useKb(s => s.awaitingHuman);
  const lastError = useKb(s => s.lastError);
  const workers = useWorkerStatus();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const [position, setPosition] = useState({ left: 12, top: 40 });
  const hub = bridgeConn ?? (kbConn === "open" ? "open" : "closed");
  const realtime = kbConn === "open" ? "open" : "closed";
  const available = workers?.filter(worker => worker.state === "ready" || worker.state === "busy").length ?? 0;

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect) setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - Math.min(340, window.innerWidth - 32) - 12)), top: rect.bottom + 8 });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); buttonRef.current?.focus(); } };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape); };
  }, [open]);

  return <div className="status-lights" ref={rootRef}>
    <button ref={buttonRef} className="lights-btn" title="Connection and worker status" aria-expanded={open} aria-controls={popoverId} onClick={() => setOpen(value => !value)}>
      <ConnDot state={hub !== "open" ? hub : realtime !== "open" || workers !== null && available === 0 ? "closed" : "open"} />
      <span>Status</span>
      {workers !== null && <span className="lights-count">{available}/{workers.length} workers</span>}
      {awaitingHuman > 0 && <span className="lights-awaiting" title={`${awaitingHuman} questions awaiting you`}>{awaitingHuman}⚑</span>}
      {lastError && <span className="lights-error" title={`Last error: ${lastError.message}`}>⚠</span>}
    </button>
    {open && <div id={popoverId} className="lights-pop" style={position} role="region" aria-label="Connection and worker status">
      <StatusDetails hub={hub} realtime={realtime} workers={workers} lastError={lastError} />
    </div>}
  </div>;
}
