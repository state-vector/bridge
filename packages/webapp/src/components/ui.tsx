import type { Decision, Presence } from "@bridge/specs";
import { Chip, relTime } from "@bridge/ui-kit";
import { normTs, presenceLabel } from "../lib/views";

/** Thin webapp wrappers over the shared kit vocabulary. */

export function rel(ms: number): string {
  return relTime(normTs(ms));
}

export function BoardChip({ board }: { board?: string | null }) {
  if (!board) return null;
  return <Chip tone="scope">{board.toUpperCase()}</Chip>;
}

export function ActorChip({ kind }: { kind: Presence["kind"] }) {
  return <Chip className={`chip-kind kind-${kind}`}>{kind.toUpperCase()}</Chip>;
}

export function KindBadge({ kind }: { kind?: Decision["kind"] }) {
  if (kind === "needs_input")
    return <Chip tone="needs">NEEDS INPUT</Chip>;
  return <Chip tone="diag">DIAGNOSTIC</Chip>;
}

export function UrgencyBadge({ urgency }: { urgency?: Decision["urgency"] }) {
  return urgency === "time-sensitive" ? <Chip tone="urgent">NOW</Chip> : null;
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
