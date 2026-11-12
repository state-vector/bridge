import { describe, expect, it } from "vitest";
import { isRootFixCard } from "../src/kb/core.ts";
import { schedulingRank } from "../src/kb/recovery-capacity.ts";

/**
 * BR#14075 — auto-stamp recognized root-fix markers on spawn so main-red
 * cards rank top-tier regardless of the authoring vocabulary (the BR#13684
 * lesson: an interactive session's diagnosis card carrying ad-hoc tags sat
 * unpicked in the pool while the scheduler's root-fix tier read only the
 * canonical shapes, and parallel human effort duplicated what the pool
 * owned).
 *
 * Three laws pinned here:
 * 1. SPAWN STAMP IS THE RECOGNIZED SHAPE — every hub bind/spawn of root-fix
 *    work carries the exact tag/meta shape isRootFixCard checks
 *    (root_blocker + main-red tags + a meta.root_fix binding), whatever the
 *    authoring session called things (do.ts ensureRootFixCard now stamps
 *    the tag pair on the current-scope repair bind, not just the binding).
 * 2. SYNONYMS RANK — a spawned red card carrying only the documented
 *    main-red synonyms (deploy-red / deploy_red) with a meta root-side
 *    marker and a bound failing run ranks 0, the root-fix tier.
 * 3. NO GAMING — a non-red card wearing fake tags (root_blocker +
 *    main-red + deploy-red) but binding NO failing run stays ordinary
 *    work (rank 5): tags alone never qualify, the binding does.
 */
describe("BR#14075 — root-fix marker recognition", () => {
  const binding = {
    root_fix: { repo: "state-vector/superpositional", head_sha: "16462d866abd", base: "main", why: "required workflows RED: deploy / Deploy to dev" },
  };

  it("a synonym-tagged red card with a binding ranks in the root-fix tier", () => {
    // deploy-red only — no root-side tag; the marker rides meta
    const meta = { ...binding, root_blocker_for_lane: "state-vector/superpositional@main" };
    expect(isRootFixCard({ tags: ["deploy-red"], meta })).toBe(true);
    expect(schedulingRank(meta, ["deploy-red"], [])).toBe(0);
    // underscore spelling and the meta root_blocker id-string marker
    const idMarker = { ...binding, root_blocker: "BR#13684" };
    expect(isRootFixCard({ tags: ["deploy_red"], meta: idMarker })).toBe(true);
    expect(schedulingRank(idMarker, ["deploy_red"], [])).toBe(0);
    // main-red (the canonical MAIN_RED_TAG spelling the interactive
    // session used) beside a meta root-side marker ranks 0 too
    expect(schedulingRank(meta, ["main-red"], [])).toBe(0);
  });

  it("the canonical hub-stamp shape still qualifies (spawn-shape pin)", () => {
    expect(isRootFixCard({ tags: ["root_blocker", "main-red", "p0"], meta: binding })).toBe(true);
    expect(schedulingRank(binding, ["root_blocker", "main-red", "p0"], [])).toBe(0);
  });

  it("a non-red card with fake tags does NOT rank up (no gaming)", () => {
    // every recognized tag, no failing-run binding — recognition refuses
    const fake = ["root_blocker", "main-red", "deploy-red"];
    expect(isRootFixCard({ tags: fake, meta: {} })).toBe(false);
    expect(schedulingRank({}, fake, [])).toBe(5);
    // an incomplete binding (repo without head_sha) is equally refused
    expect(isRootFixCard({ tags: fake, meta: { root_fix: { repo: "state-vector/superpositional" } } })).toBe(false);
    // a synonym tag alone, even beside a real red tip, names no root-side
    // marker — not a root card
    expect(isRootFixCard({ tags: ["deploy-red"], meta: { repo: "state-vector/superpositional", tip_sha: "16462d866abd" } })).toBe(false);
    // a bound card still needs the main-red side — root marker alone is not enough
    expect(isRootFixCard({ tags: ["root_blocker"], meta: binding })).toBe(false);
  });
});
