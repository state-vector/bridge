import type { Decision, Presence } from "@flows/specs";
import { normTs, presenceLabel } from "../lib/views";

export function rel(ms: number): string {
  const d = Date.now() - normTs(ms);
  const a = Math.abs(d);
  const unit =
    a < 60_000 ? `${Math.max(1, Math.round(a / 1000))}s`
    : a < 3_600_000 ? `${Math.round(a / 60_000)}m`
    : `${Math.round(a / 3_600_000)}h`;
  return d >= 0 ? `${unit} ago` : `in ${unit}`;
}

export function BoardChip({ board }: { board?: string | null }) {
  if (!board) return null;
  return <span className="chip chip-scope">{board.toUpperCase()}</span>;
}

export function ActorChip({ kind }: { kind: Presence["kind"] }) {
  return <span className={`chip chip-kind kind-${kind}`}>{kind.toUpperCase()}</span>;
}

export function KindBadge({ kind }: { kind?: Decision["kind"] }) {
  if (kind === "needs_input")
    return <span className="chip chip-needs">NEEDS INPUT</span>;
  return <span className="chip chip-diag">DIAGNOSTIC</span>;
}

export function UrgencyBadge({ urgency }: { urgency?: Decision["urgency"] }) {
  return urgency === "time-sensitive" ? <span className="chip chip-urgent">NOW</span> : null;
}

export function StatusDot({ active }: { active: boolean }) {
  return <span className={`dot ${active ? "dot-working" : "dot-offline"}`} />;
}

export function Avatar({ p, active }: { p: Presence; active: boolean }) {
  return (
    <span className="avatar">
      {presenceLabel(p).slice(0, 1).toUpperCase()}
      <StatusDot active={active} />
    </span>
  );
}
