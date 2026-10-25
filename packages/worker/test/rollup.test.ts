import { describe, it, expect } from "vitest";
import {
  ROOT_BLOCKER_MIN_CLUSTER,
  planRootBlockers,
  rootBlockerBody,
  rootBlockerKey,
  rootBlockerTitle,
  type RollupCard,
  type RollupRoot,
} from "../src/kb/rollup.ts";

const card = (id: string, blocked?: { reason?: string; unblock_condition?: string } | null, root_blocker?: string | null): RollupCard => ({
  id,
  blocked: blocked ?? null,
  root_blocker: root_blocker ?? null,
});

const pr98 = (extra?: string) => ({
  reason: "blocked on decision",
  unblock_condition: `merge https://github.com/state-vector/bridge/pull/98${extra ? ` ${extra}` : ""}`,
});

describe("rootBlockerKey — derivation", () => {
  it("pr URL in the unblock condition → pr:<owner/repo>#<n>", () => {
    expect(rootBlockerKey(pr98())).toBe("pr:state-vector/bridge#98");
  });

  it("pr URL in the reason when the condition has none", () => {
    expect(
      rootBlockerKey({
        reason: "waiting on https://github.com/state-vector/superpositional/pull/2187 to merge",
        unblock_condition: "PR merged",
      }),
    ).toBe("pr:state-vector/superpositional#2187");
  });

  it("owner/repo is normalised case-insensitively — same PR, same key", () => {
    expect(
      rootBlockerKey({ unblock_condition: "https://GitHub.com/State-Vector/Bridge/pull/98" }),
    ).toBe("pr:state-vector/bridge#98");
  });

  it("issue/run URLs are not pr keys", () => {
    expect(
      rootBlockerKey({ unblock_condition: "https://github.com/state-vector/bridge/issues/98 fixed; run https://github.com/state-vector/bridge/actions/runs/123" }),
    ).toBeNull();
  });

  it("red/broken/failing main language → main-red (BR#551 class)", () => {
    expect(rootBlockerKey({ reason: "main is red — never merge onto red main", unblock_condition: "main green again" })).toBe("main-red");
    expect(rootBlockerKey({ reason: "dev deploy broken: main broken by the deploy train", unblock_condition: "" })).toBe("main-red");
    expect(rootBlockerKey({ reason: "", unblock_condition: "main failing CI since 10-22" })).toBe("main-red");
    expect(rootBlockerKey({ reason: "red main blocks every rebase", unblock_condition: "" })).toBe("main-red");
  });

  it("a pr URL wins over ambient main-red language", () => {
    expect(
      rootBlockerKey({ reason: "main red, queueing behind the fix", unblock_condition: "merge https://github.com/state-vector/bridge/pull/98" }),
    ).toBe("pr:state-vector/bridge#98");
  });

  it("null for everything else — humans cluster un-machine-readable blockers", () => {
    expect(rootBlockerKey(undefined)).toBeNull();
    expect(rootBlockerKey(null)).toBeNull();
    expect(rootBlockerKey({})).toBeNull();
    expect(rootBlockerKey({ reason: "waiting on Ray's answer to ask ASK-x", unblock_condition: "answer to ask ASK-x" })).toBeNull();
    expect(rootBlockerKey({ reason: "credentials missing", unblock_condition: "operator runs billing-backfill" })).toBeNull();
    // "PR is red" without main is CI-on-branch noise, not the red-main class
    expect(rootBlockerKey({ reason: "PR is red on CI", unblock_condition: "fix the tests" })).toBeNull();
  });
});

describe("planRootBlockers — clusters, idempotency, root reuse", () => {
  const threeQueued = (): RollupCard[] => [
    card("BR#1", pr98()),
    card("BR#2", pr98()),
    card("BR#3", { reason: "rebase after https://github.com/state-vector/bridge/pull/98 merges" }),
  ];

  it("a cluster at the threshold creates ONE root and stamps every member", () => {
    const plan = planRootBlockers(threeQueued(), []);
    expect(plan.creates).toEqual([{ key: "pr:state-vector/bridge#98", members: ["BR#1", "BR#2", "BR#3"] }]);
    expect(plan.stamps.map((s) => s.id)).toEqual(["BR#1", "BR#2", "BR#3"]);
    for (const s of plan.stamps) {
      expect(s.root).toBeNull(); // executor resolves the freshly created root
      expect(s.root_key).toBe("pr:state-vector/bridge#98");
    }
  });

  it("clusters below the threshold are left alone", () => {
    const plan = planRootBlockers(threeQueued().slice(0, ROOT_BLOCKER_MIN_CLUSTER - 1), []);
    expect(plan.creates).toEqual([]);
    expect(plan.stamps).toEqual([]);
  });

  it("cards without a machine root key never cluster", () => {
    const cards = [
      ...threeQueued(),
      card("BR#4", { reason: "on ask ASK-1", unblock_condition: "answer to ask ASK-1" }),
      card("BR#5", { reason: "main is red" }), // lone main-red — under threshold
    ];
    const plan = planRootBlockers(cards, []);
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0].key).toBe("pr:state-vector/bridge#98");
  });

  it("separate keys form separate clusters", () => {
    const cards = [
      card("BR#1", pr98()),
      card("BR#2", pr98()),
      card("BR#3", pr98()),
      card("BR#4", { reason: "main is red" }),
      card("BR#5", { unblock_condition: "main failing since the deploy train" }),
      card("BR#6", { reason: "blocked: main red (BR#551)" }),
    ];
    const plan = planRootBlockers(cards, []);
    expect(plan.creates.map((c) => c.key)).toEqual(["main-red", "pr:state-vector/bridge#98"]);
  });

  it("a cluster with an OPEN root reuses it — no second create; unstamped members point at it", () => {
    const roots: RollupRoot[] = [{ id: "BR#10", status: "todo", root_key: "pr:state-vector/bridge#98" }];
    const plan = planRootBlockers(threeQueued(), roots);
    expect(plan.creates).toEqual([]);
    expect(plan.stamps).toHaveLength(3);
    for (const s of plan.stamps) expect(s.root).toBe("BR#10");
  });

  it("idempotent re-run: cards already pointing at the open root are skipped — no duplicates, no stamps", () => {
    const roots: RollupRoot[] = [{ id: "BR#10", status: "in_progress", root_key: "pr:state-vector/bridge#98" }];
    const stamped: RollupCard[] = threeQueued().map((c) => ({ ...c, root_blocker: "BR#10" }));
    const plan = planRootBlockers(stamped, roots);
    expect(plan.creates).toEqual([]);
    expect(plan.stamps).toEqual([]);
  });

  it("a DONE root is never reused — a later cluster opens a NEW root", () => {
    const roots: RollupRoot[] = [{ id: "BR#10", status: "done", root_key: "pr:state-vector/bridge#98" }];
    const plan = planRootBlockers(threeQueued(), roots);
    expect(plan.creates).toHaveLength(1);
    expect(plan.stamps).toHaveLength(3);
    for (const s of plan.stamps) expect(s.root).toBeNull();
  });

  it("cards pointing at a done root are re-stamped to the new root; open-rooted cards in the same cluster stay put", () => {
    const roots: RollupRoot[] = [
      { id: "BR#10", status: "done", root_key: "pr:state-vector/bridge#98" },
    ];
    const cards = [
      card("BR#1", pr98(), "BR#10"), // stale pointer at a closed root
      card("BR#2", pr98()),
      card("BR#3", pr98()),
    ];
    const plan = planRootBlockers(cards, roots);
    expect(plan.creates).toHaveLength(1);
    expect(plan.stamps).toEqual([
      { id: "BR#1", root_key: "pr:state-vector/bridge#98", root: null },
      { id: "BR#2", root_key: "pr:state-vector/bridge#98", root: null },
      { id: "BR#3", root_key: "pr:state-vector/bridge#98", root: null },
    ]);
  });

  it("a card pointing at an open root of a DIFFERENT key is still left alone", () => {
    const roots: RollupRoot[] = [{ id: "BR#20", status: "todo", root_key: "main-red" }];
    const cards = [
      card("BR#1", pr98(), "BR#20"),
      card("BR#2", pr98()),
      card("BR#3", pr98()),
    ];
    const plan = planRootBlockers(cards, roots);
    expect(plan.creates).toHaveLength(1);
    expect(plan.stamps.map((s) => s.id)).toEqual(["BR#2", "BR#3"]);
  });

  it("a stale pointer at a root that no longer exists is repaired", () => {
    const roots: RollupRoot[] = [];
    const plan = planRootBlockers(threeQueued().map((c) => ({ ...c, root_blocker: "BR#GONE" })), roots);
    expect(plan.stamps).toHaveLength(3);
  });
});

describe("root task shape", () => {
  it("title carries key, count and the contract", () => {
    expect(rootBlockerTitle("pr:state-vector/bridge#98", 7)).toBe(
      "ROOT BLOCKER (pr:state-vector/bridge#98) — 7 tasks queued (investigate → fix → one approval)",
    );
  });

  it("body: pr key done-when names the merged PR; main-red done-when names ancestry-green main", () => {
    const prBody = rootBlockerBody("pr:state-vector/bridge#98", [
      { id: "BR#1", title: "one" },
      { id: "BR#2" },
    ]);
    expect(prBody).toContain("- BR#1 — one");
    expect(prBody).toContain("- BR#2");
    expect(prBody).toContain("state-vector/bridge#98) is merged");
    expect(prBody).not.toContain("ancestry-green");

    const redBody = rootBlockerBody("main-red", [{ id: "BR#4" }]);
    expect(redBody).toContain("main is ancestry-green");
    expect(redBody).toContain("BR#551");
  });

  it("body names the ask contract and the no-auto-close / no-reuse rules", () => {
    const body = rootBlockerBody("main-red", [{ id: "BR#4" }]);
    expect(body).toContain("Investigate → fix → ONE approval");
    expect(body).toContain("why_escalated");
    expect(body).toContain("never auto-closes");
    expect(body).toContain("NEW root");
  });
});
