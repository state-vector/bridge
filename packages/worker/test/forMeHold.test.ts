import { describe, expect, it } from "vitest";

/**
 * BR#3457 — For Me busy-hold state machine (pure module, no react/zustand).
 *
 * The jump bug: clicking accept called onDone → refetch, and the card's fate
 * depended entirely on refetch timing — it vanished, then (with stacked
 * verdicts) popped back. The hold law: on click the card STAYS in the list,
 * moves to the bottom of its section with an actioning chip, and is removed
 * only when a refetch confirms the decision is no longer proposed. On error
 * the hold drops and the card returns to its slot with the error inline.
 */

import {
  beginHold,
  groupBusy,
  groupDecisions,
  holdOrder,
  holdOrderGroups,
  mergeHeld,
  reconcileHold,
  settleHold,
  type HeldMap,
} from "../../ui-kit/src/views/forMeHold.ts";

const d = (id: string, created_ts: number, meta: Record<string, unknown> = {}): any => ({
  id,
  type: "decision",
  status: "proposed",
  created_ts,
  meta,
  title: `decision ${id}`,
});

const heldOf = (...cards: any[]): HeldMap => {
  const m: HeldMap = new Map();
  for (const c of cards) m.set(c.id, { d: c, action: "accepted", since: 0 });
  return m;
};

describe("holdOrder — busy last, then created_ts desc (stable, no jump)", () => {
  it("idle lists order purely by created_ts desc — holdOrder changes nothing when nothing is busy", () => {
    const items = [d("a", 100), d("b", 300), d("c", 200)];
    expect(holdOrder(items, new Map()).map((x) => x.id)).toEqual(["b", "c", "a"]);
  });

  it("a busy card moves to the bottom of its section; the rest keep their order", () => {
    const items = [d("a", 100), d("b", 300), d("c", 200)];
    expect(holdOrder(items, heldOf(d("b", 300))).map((x) => x.id)).toEqual(["c", "a", "b"]);
  });

  it("multiple busy cards: newest click first, still after every non-busy card", () => {
    const items = [d("a", 100), d("b", 300), d("c", 200), d("e", 400)];
    // non-busy block by created_ts desc (c, a), then the busy block (e, b)
    expect(holdOrder(items, heldOf(d("b", 300), d("e", 400))).map((x) => x.id)).toEqual(["c", "a", "e", "b"]);
  });

  it("an error drop returns the card to its created_ts slot (no pinned-bottom residue)", () => {
    const items = [d("a", 100), d("b", 300), d("c", 200)];
    const held = settleHold(heldOf(d("b", 300)), "b", false); // act failed
    expect(holdOrder(items, held).map((x) => x.id)).toEqual(["b", "c", "a"]);
  });
});

describe("begin/settle/reconcile — the card leaves only when the refetch confirms", () => {
  it("click holds; success keeps the hold (awaiting refetch); failure drops it", () => {
    let held = beginHold(new Map(), d("a", 1), "accepted");
    expect(held.has("a")).toBe(true);
    held = settleHold(held, "a", true);
    expect(held.has("a")).toBe(true); // still held until the refetch confirms
    held = settleHold(held, "a", false);
    expect(held.has("a")).toBe(false); // error → un-busy, back in place
  });

  it("reconcile: listed → still held (server has not flipped yet); gone → confirmed removed", () => {
    const held = beginHold(new Map(), d("a", 1), "accepted");
    const still = reconcileHold(held, new Set(["a", "b"]));
    expect(still.held.has("a")).toBe(true);
    expect(still.confirmed).toEqual([]);
    const gone = reconcileHold(still.held, new Set(["b"]));
    expect(gone.held.has("a")).toBe(false);
    expect(gone.confirmed).toEqual(["a"]);
  });

  it("mergeHeld renders held-only cards the fetched list no longer carries", () => {
    const card = d("a", 1);
    const held = beginHold(new Map(), card, "superseded");
    expect(mergeHeld([d("b", 2)], held).map((x) => x.id)).toEqual(["b", "a"]);
    // no hold → the fetched list passes through untouched
    expect(mergeHeld([d("b", 2)], new Map()).map((x) => x.id)).toEqual(["b"]);
  });
});

describe("groupDecisions × hold — stacked verdicts render as one busy group at the bottom", () => {
  it("held verdicts integrate into their target group and the group sorts last", () => {
    const v1 = d("v1", 100, { decision_class: "verify-verdict", task: "T1", verdict: "verified" });
    const v2 = d("v2", 300, { decision_class: "verify-verdict", task: "T1", verdict: "verified" });
    const g1 = d("g1", 200, {}); // generic
    const fetched = [v1, g1]; // refetch dropped v2 (acted on) but it is held
    const held = heldOf(v2);
    const merged = mergeHeld(fetched, held);
    const { verdictCards, generic } = groupDecisions(merged);

    expect(verdictCards).toHaveLength(1);
    expect(verdictCards[0].latest.id).toBe("v2"); // newest of the target wins
    expect(verdictCards[0].prior.map((p) => p.id)).toEqual(["v1"]);
    expect(groupBusy(verdictCards[0], held)).toBe(true);
    expect(generic.map((x) => x.id)).toEqual(["g1"]);
    expect(groupBusy({ latest: generic[0], prior: [] }, held)).toBe(false);
  });

  it("busy group + busy generic land at the bottom of their own sections", () => {
    const v1 = d("v1", 100, { decision_class: "verify-verdict", task: "T1", verdict: "verified" });
    const v2 = d("v2", 200, { decision_class: "verify-verdict", task: "T1", verdict: "verified" });
    const v3 = d("v3", 300, { decision_class: "verify-verdict", task: "T2", verdict: "verified" });
    const g1 = d("g1", 150, {});
    const g2 = d("g2", 250, {});
    const held = heldOf(v2, g1); // T1's latest busy; g1 busy
    const { verdictCards, generic } = groupDecisions(mergeHeld([v1, v2, v3, g1, g2], held));
    expect(verdictCards).toHaveLength(2); // one group per target
    // idle T2 group first, busy T1 group last; idle g2 first, busy g1 last
    expect(holdOrderGroups(verdictCards, held).map((c) => c.latest.id)).toEqual(["v3", "v2"]);
    expect(holdOrder(generic, held).map((x) => x.id)).toEqual(["g2", "g1"]);
  });
});
