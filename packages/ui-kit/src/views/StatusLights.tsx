import { useMemo, useState } from "react";
import { useKb } from "../server/kbStore";
import { rel } from "../server/views";
import { ConnDot } from "../ConnDot";

/** Compact status lights for the title bar: hub, kb realtime, one light per
 *  gateway. Click → the detail popover (hub status, per-gateway liveness,
 *  in-flight counts) — the fleet's vitals live in the chrome, not the body. */
export function StatusLights({ bridgeConn, gatewaysFrom }: { bridgeConn?: "open" | "connecting" | "closed"; gatewaysFrom?: Array<{ label: string; online: boolean; lastSeen: number; tasksInFlight: number }> }) {
  const kbConn = useKb((s) => s.conn);
  const sessions = useKb((s) => s.sessions);
  const [open, setOpen] = useState(false);

  const derived = useMemo(() => {
    const now = Date.now();
    const FRESH = 3 * 60_000;
    // per-task dispatch: dispatch-BR-2466 (the runner sanitizes '#'); everything
    // else dispatch-* is a gateway identity session
    const isPerTask = (name: string) => /^dispatch-(BR[-#]|TASK[-#]|ASK[-#]|DECISION[-#])/i.test(name);
    const byLabel = new Map<string, { label: string; online: boolean; lastSeen: number; tasksInFlight: number }>();
    let inFlight = 0;
    for (const s of sessions) {
      const name = s.name ?? "";
      if (!name.startsWith("dispatch-")) continue;
      if (isPerTask(name)) { if (now - (s.last_seen_ts ?? 0) < FRESH * 2) inFlight++; continue; }
      const label = s.label ?? name;
      const cur = byLabel.get(label) ?? { label, online: false, lastSeen: 0, tasksInFlight: 0 };
      cur.lastSeen = Math.max(cur.lastSeen, s.last_seen_ts ?? 0);
      byLabel.set(label, cur);
    }
    return [...byLabel.values()].map((g) => ({ ...g, online: now - g.lastSeen < FRESH, tasksInFlight: inFlight }));
  }, [sessions]);
  const gateways: Array<{ label: string; online: boolean; lastSeen: number; tasksInFlight: number }> = gatewaysFrom ?? derived;

  const gwOnline = gateways.filter((g) => g.online).length;
  const kbState = kbConn === "open" ? "open" : "closed";

  return (
    <div className="status-lights">
      <button className="lights-btn" title="hub & gateway status" onClick={() => setOpen(!open)}>
        <ConnDot state={bridgeConn === "connecting" ? "connecting" : bridgeConn ?? kbState} className="conn" title={`hub: ${bridgeConn ?? kbState}`} />
        <ConnDot state={kbState} className="conn" title={`kb realtime: ${kbState}`} />
        <ConnDot state={gwOnline > 0 ? "open" : "closed"} className="conn" title={`gateways: ${gwOnline}/${gateways.length} online`} />
        {gateways.length > 0 && <span className="lights-count">{gwOnline}/{gateways.length}</span>}
      </button>
      {open && (
        <div className="lights-pop" onClick={() => setOpen(false)}>
          <div className="ask-chips"><b>status</b></div>
          <div className="light-row"><ConnDot state={bridgeConn ?? kbState} className="conn" /> hub {bridgeConn ? `(${bridgeConn})` : ""}</div>
          <div className="light-row"><ConnDot state={kbState} className="conn" /> knowledge realtime — {kbState}</div>
          {gateways.length === 0 && <div className="light-row muted">no gateways seen</div>}
          {gateways.map((g) => (
            <div key={g.label} className="light-row">
              <ConnDot state={g.online ? "open" : "closed"} className="conn" />
              {g.label}
              <span className="light-meta">
                {g.online ? "online" : `last seen ${rel(g.lastSeen)}`}
                {g.tasksInFlight > 0 ? ` · ${g.tasksInFlight} in flight` : " · idle"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
