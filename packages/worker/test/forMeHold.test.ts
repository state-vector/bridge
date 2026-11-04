import { describe, expect, it } from "vitest";

/**
 * BR#3457 — For Me busy-hold state machine (pure module, no react/zustand),
 * amended by BR#6390 (no-jump law).
 *
 * The jump bug (BR#3457): clicking accept called onDone → refetch, and the
 * card's fate depended entirely on refetch timing — it vanished, then (with
 * stacked verdicts) popped back. The hold law: on click the card STAYS in
 * the list, grayed with an actioning chip, and is removed only when a
 * refetch confirms the decision is no longer proposed. On error the hold
 * drops and the card shows the error inline.
 *
 * The BR#6390 amendment: a click must never REPOSITION a card either — the
 * old pin-to-bottom/busy-last sort is superseded. Ordering is stable
 * created_ts desc, always; busy/answered shows as a chip, not a jump.
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

describe("holdOrder — BR#6390: a click never reorders (stable created_ts desc)", () => {
  it("idle lists order purely by created_ts desc", () => {
    const items = [d("a", 100), d("b", 300), d("c", 200)];
    expect(holdOrder(items, new Map()).map((x) => x.id)).toEqual(["b", "c", "a"]);
  });

  it("a held card STAYS in its created_ts slot — no pin-to-bottom (supersedes BR#3457 ordering)", () => {
    const items = [d("a", 100), d("b", 300), d("c", 200)];
    expect(holdOrder(items, heldOf(d("b", 300))).map((x) => x.id)).toEqual(["b", "c", "a"]);
  });

  it("a busy NEWER card stays FIRST — acting on it must not sink it under older cards", () => {
    const items = [d("a", 100), d("b", 300)];
    expect(holdOrder(items, heldOf(d("b", 300))).map((x) => x.id)).toEqual(["b", "a"]);
  });

  it("multiple held cards: each stays in its own created_ts slot", () => {
    const items = [d("a", 100), d("b", 300), d("c", 200), d("e", 400)];
    expect(holdOrder(items, heldOf(d("b", 300), d("e", 400))).map((x) => x.id)).toEqual(["e", "b", "c", "a"]);
  });

  it("an error drop changes nothing — the card never moved in the first place", () => {
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

describe("groupDecisions × hold — stacked verdicts render as one group, held or not", () => {
  it("held verdicts integrate into their target group (the group stays visible)", () => {
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

  it("ordering is latest-round created_ts desc only — busy groups never sink (BR#6390)", () => {
    const v1 = d("v1", 100, { decision_class: "verify-verdict", task: "T1", verdict: "verified" });
    const v2 = d("v2", 200, { decision_class: "verify-verdict", task: "T1", verdict: "verified" });
    const v3 = d("v3", 300, { decision_class: "verify-verdict", task: "T2", verdict: "verified" });
    const g1 = d("g1", 150, {});
    const g2 = d("g2", 250, {});
    const held = heldOf(v2, g1); // T1's latest busy; g1 busy
    const { verdictCards, generic } = groupDecisions(mergeHeld([v1, v2, v3, g1, g2], held));
    expect(verdictCards).toHaveLength(2); // one group per target
    // plain created_ts desc: v3 (300) then v2 (200); g2 (250) then g1 (150)
    expect(holdOrderGroups(verdictCards, held).map((c) => c.latest.id)).toEqual(["v3", "v2"]);
    expect(holdOrder(generic, held).map((x) => x.id)).toEqual(["g2", "g1"]);
  });

  it("a busy NEWER group stays on top — acting on it must not reorder the section (BR#6390)", () => {
    const vOld = d("vOld", 100, { decision_class: "verify-verdict", task: "T1", verdict: "verified" });
    const vNew = d("vNew", 400, { decision_class: "verify-verdict", task: "T2", verdict: "verified" });
    const held = heldOf(vNew); // the human is acting on the newest group
    const { verdictCards } = groupDecisions(mergeHeld([vOld, vNew], held));
    // BR#3457 busy-last would sink vNew below vOld; BR#6390 keeps desc order
    expect(holdOrderGroups(verdictCards, held).map((c) => c.latest.id)).toEqual(["vNew", "vOld"]);
  });
});
