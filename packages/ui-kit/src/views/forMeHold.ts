/** For Me busy-hold (BR#3457): a decision being actioned must NOT vanish from
 *  the list mid-flight — the card jumps down to the bottom of its section with
 *  an "actioning…" chip and stays there until a refetch CONFIRMS the decision
 *  left `proposed`. Only then does it disappear. On error the hold drops and
 *  the card snaps back to its normal position with the error inline.
 *
 *  This module is deliberately dependency-free (no react, no zustand, and a
 *  structural artefact type instead of the ui-kit's KbArtefact) so the
 *  worker's vitest tier exercises the state machine directly — the same
 *  convention as the repo's other pure-function tests — without dragging the
 *  browser-typed ui-kit graph into the worker's type gate. */

export type DecisionAction = "accepted" | "superseded";

/** structural stand-in for KbArtefact — everything the hold needs (no index
 *  signature: callers pass their own richer artefact type through the generic) */
export interface HoldArtefact {
  id: string;
  created_ts: number;
  meta?: unknown;
}

export interface HeldDecision<T extends HoldArtefact = HoldArtefact> {
  d: T;
  action: DecisionAction;
  /** ms timestamp of the click — kept for debugging/ordering ties */
  since: number;
}

export type HeldMap<T extends HoldArtefact = HoldArtefact> = Map<string, HeldDecision<T>>;

/** Click → hold. The card leaves its list slot and renders from the held
 *  snapshot at the bottom of its section until confirmed or failed. */
export function beginHold<T extends HoldArtefact>(held: HeldMap, d: T, action: DecisionAction): HeldMap<T> {
  const next = new Map(held) as HeldMap<T>;
  next.set(d.id, { d, action, since: Date.now() });
  return next;
}

/** The transition call settled. ok (server accepted the transition) → the hold
 *  STAYS: the card is only removed once a refetch shows it gone from proposed.
 *  !ok → drop the hold: the card returns to its normal slot; the row renders
 *  the error it caught (row-local err state). */
export function settleHold<T extends HoldArtefact>(held: HeldMap<T>, id: string, ok: boolean): HeldMap<T> {
  if (ok && held.has(id)) return held; // keep holding — awaiting refetch confirm
  if (!held.has(id)) return held;
  const next = new Map(held);
  next.delete(id);
  return next;
}

/** After a refetch of proposed decisions: a held id still listed means the
 *  server has not flipped it yet (slow commit / a later round re-proposed) —
 *  keep holding at the bottom. A held id no longer listed is CONFIRMED gone:
 *  drop it and the row unmounts. Returns the confirmed ids. */
export function reconcileHold<T extends HoldArtefact>(held: HeldMap<T>, proposedIds: Set<string>): { held: HeldMap<T>; confirmed: string[] } {
  const confirmed: string[] = [];
  let changed = false;
  const next = new Map(held);
  for (const id of next.keys()) {
    if (!proposedIds.has(id)) {
      confirmed.push(id);
      next.delete(id);
      changed = true;
    }
  }
  return { held: changed ? next : held, confirmed };
}

/** Busy-hold ordering, the no-jump law: busy cards LAST (most recent click
 *  first among equals), everything else by created_ts descending. Stable —
 *  idle lists render in exactly the order they always did. */
export function holdOrder<T extends HoldArtefact>(items: T[], held: HeldMap): T[] {
  return items.slice().sort((a, b) => {
    const ab = held.has(a.id) ? 1 : 0;
    const bb = held.has(b.id) ? 1 : 0;
    if (ab !== bb) return ab - bb;
    return b.created_ts - a.created_ts;
  });
}

/** Held-only entries — cards the list no longer carries but we must keep
 *  rendering (in flight / awaiting confirm) — merged after the fetched list. */
export function mergeHeld<T extends HoldArtefact>(proposed: T[], held: HeldMap<T>): T[] {
  if (held.size === 0) return proposed;
  const seen = new Set(proposed.map((d) => d.id));
  const extra: T[] = [];
  for (const h of held.values()) if (!seen.has(h.d.id)) extra.push(h.d);
  return extra.length ? [...proposed, ...extra] : proposed;
}

/** For Me flood fix (BR#1782), BR#3457 ordering: verify-verdict decisions
 *  group by TARGET TASK — one actionable card per task (latest verdict +
 *  collapsed identical rounds). Generic decisions stay flat. */
export function groupDecisions<T extends HoldArtefact>(proposed: T[]): { verdictCards: Array<{ latest: T; prior: T[] }>; generic: T[] } {
  const verdicts = proposed.filter((d) => (d.meta as any)?.decision_class === "verify-verdict" && ((d.meta as any)?.task || (d.meta as any)?.verify_target));
  const generic = proposed.filter((d) => !verdicts.includes(d));
  const byTarget = new Map<string, T[]>();
  for (const d of verdicts) {
    const key = String((d.meta as any).task ?? (d.meta as any).verify_target);
    const arr = byTarget.get(key) ?? [];
    arr.push(d);
    byTarget.set(key, arr);
  }
  const verdictCards: Array<{ latest: T; prior: T[] }> = [];
  for (const [, arr] of byTarget) {
    arr.sort((a, b) => b.created_ts - a.created_ts);
    verdictCards.push({ latest: arr[0], prior: arr.slice(1) });
  }
  verdictCards.sort((a, b) => b.latest.created_ts - a.latest.created_ts);
  return { verdictCards, generic };
}

/** A verdict group is busy when ANY of its verdicts is held (the human acts on
 *  the group's latest; older rounds ride along at the bottom with it). */
export function groupBusy(g: { latest: HoldArtefact; prior: HoldArtefact[] }, held: HeldMap): boolean {
  return held.has(g.latest.id) || g.prior.some((d) => held.has(d.id));
}

/** holdOrder for verdict GROUP cards (the group is one card: busy last, then
 *  by the latest round's created_ts desc). */
export function holdOrderGroups<T extends HoldArtefact>(cards: Array<{ latest: T; prior: T[] }>, held: HeldMap): Array<{ latest: T; prior: T[] }> {
  return cards.slice().sort((a, b) =>
    (groupBusy(a, held) ? 1 : 0) - (groupBusy(b, held) ? 1 : 0)
    || b.latest.created_ts - a.latest.created_ts,
  );
}
