import { useKb } from "../store/kb";
import { rel } from "../lib/views";
import { Chip, ConnDot } from "@bridge/ui-kit";

export function LogView() {
  const events = useKb((s) => s.events);
  const conn = useKb((s) => s.conn);

  return (
    <div className="log-wrap">
      <div className="view-head">
        <h2>Activity log</h2>
        <ConnDot state={conn === "open" ? "open" : "closed"} className="conn" />
        <span className="muted-note">{events.length} events · live</span>
      </div>
      <table className="log-table">
        <thead>
          <tr>
            <th>when</th>
            <th>who</th>
            <th>op</th>
            <th>artefact</th>
            <th>detail</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.seq}>
              <td className="log-ts">{rel(e.ts)}</td>
              <td>{e.actor}</td>
              <td>
                <Chip className={`op-${e.op}`}>{e.op}</Chip>
              </td>
              <td>{e.artefact_id ?? "—"}</td>
              <td className="log-detail">{JSON.stringify(e.detail)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {events.length === 0 && <p className="empty">No activity yet.</p>}
    </div>
  );
}
