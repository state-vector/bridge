import { describe, expect, it } from "vitest";
import { decideTakeover, takeoverAuthority, type TakeoverAuthority, type TakeoverTarget } from "../src/kb/takeover.ts";
import { breachClass } from "../src/kb/machine.ts";

/**
 * BR#6135 — the pure decision law for interactive claim takeover.
 * do.ts owns storage/clock; these tests pin the law itself: authority
 * anchors (server-verified, never self-declared — BR#2673), the refusal
 * classes (each folded never-breach by RULE_BREACH_CLASSES, BR#3430), the
 * holder-class boundary (dispatch-spawned runner sessions only — design 2),
 * and idempotence.
 */

const runnerHeld = (over: Partial<TakeoverTarget> = {}): TakeoverTarget => ({
  id: "BR#1",
  type: "task",
  status: "in_progress",
  owner: "macbook-pro-local-2",
  roles: [],
  meta: { session: "dispatch-BR-1" },
  holderIsRunner: true,
  ...over,
});

const as = (over: Partial<TakeoverAuthority> = {}): TakeoverAuthority => ({
  actor: "opencode-ray",
  session: "ray-local-1",
  ...over,
});

describe("takeoverAuthority — the owner/web anchors (BR#2673)", () => {
  it("web/human/system actors pass (OWNER_RELEASE_EXEMPT plane)", () => {
    expect(takeoverAuthority(runnerHeld(), as({ actor: "web:rayh" }))).toBe(true);
    expect(takeoverAuthority(runnerHeld(), as({ actor: "web" }))).toBe(true);
    expect(takeoverAuthority(runnerHeld(), as({ actor: "human:ray" }))).toBe(true);
    expect(takeoverAuthority(runnerHeld(), as({ actor: "system:watchdog" }))).toBe(true);
  });

  it("the owner label passes; a non-owner agent label does not", () => {
    expect(takeoverAuthority(runnerHeld({ owner: "opencode-ray" }), as({ actor: "opencode-ray" }))).toBe(true);
    expect(takeoverAuthority(runnerHeld(), as({ actor: "opencode-ray" }))).toBe(false);
    expect(takeoverAuthority(runnerHeld(), as({ actor: "some-other-agent" }))).toBe(false);
  });

  it("the owner PRINCIPAL anchors (labels are display; principals are the anchor)", () => {
    expect(takeoverAuthority(runnerHeld(), as({ actor: "opencode-ray", actingPrincipal: "macbook-pro-local-2" }))).toBe(true);
    expect(takeoverAuthority(runnerHeld(), as({ actor: "opencode-ray", actingPrincipal: "other-principal" }))).toBe(false);
  });

  it("the gateway attribution pair anchors (same pair the release rule trusts, BR#3611)", () => {
    expect(takeoverAuthority(runnerHeld(), as({ actor: "macbook-pro-local-2", attributedAgent: "macbook-pro-local-2" }))).toBe(true);
    expect(takeoverAuthority(runnerHeld(), as({ actor: "other-gateway", attributedAgent: "macbook-pro-local-2" }))).toBe(true);
    // a DIFFERENT gateway's agent ≠ owner → not anchored
    expect(takeoverAuthority(runnerHeld(), as({ actor: "other-gateway", attributedAgent: "someone-else" }))).toBe(false);
    // the pair anchor: attributedAgent === owner passes even under a foreign actor label —
    // the caller (do.ts) only sets attributedAgent from a gateway-tagged token, so this
    // anchor is unreachable for a plain agent bearer (the pair cannot be forged).
    expect(takeoverAuthority(runnerHeld(), as({ actor: "opencode-ray", attributedAgent: "macbook-pro-local-2" }))).toBe(true);
  });

  it("no owner (pooled card) admits only the human/system plane", () => {
    const pooled = runnerHeld({ owner: "" });
    expect(takeoverAuthority(pooled, as({ actor: "web:rayh" }))).toBe(true);
    expect(takeoverAuthority(pooled, as({ actor: "opencode-ray" }))).toBe(false);
  });
});

describe("decideTakeover — the one decision, total over (target, authority)", () => {
  it("accepts an owner/web-anchored takeover of a runner-held in_progress task", () => {
    const v = decideTakeover(runnerHeld(), as({ actor: "web:rayh" }));
    expect(v).toEqual({ ok: true, already: false, fromSession: "dispatch-BR-1", toSession: "ray-local-1" });
  });

  it("refuses a non-target: wrong type or not in_progress (claim via the normal edge)", () => {
    for (const over of [{ type: "question" }, { status: "todo" }, { status: "blocked" }, { status: "in_review" }]) {
      const v = decideTakeover(runnerHeld(over), as({ actor: "web:rayh" }));
      expect(v.ok).toBe(false);
      if (v.ok === false) expect(v.rule).toBe("takeover-target");
    }
  });

  it("refuses verdict-duty cards — SoD is not transferable (BR#2997/BR#3430)", () => {
    for (const roles of [["review"], ["unblock"]]) {
      const v = decideTakeover(runnerHeld({ roles }), as({ actor: "web:rayh" }));
      expect(v.ok).toBe(false);
      if (v.ok === false) expect(v.rule).toBe("takeover-verdict-duty");
    }
  });

  it("refuses a card holding a machine wait — the wait owns the exit, not the executor", () => {
    const queued = runnerHeld({ meta: { session: "dispatch-BR-1", merge_train: { state: "queued", repo: "state-vector/bridge", pr: 392 }, pr: { repo: "state-vector/bridge", number: 392 } } });
    const v = decideTakeover(queued, as({ actor: "web:rayh" }));
    expect(v.ok).toBe(false);
    if (v.ok === false) expect(v.rule).toBe("takeover-held");
    const ask = runnerHeld({ meta: { session: "dispatch-BR-1", awaiting_ask: { ask_id: "BR#999" } } });
    const v2 = decideTakeover(ask, as({ actor: "web:rayh" }));
    expect(v2.ok).toBe(false);
    if (v2.ok === false) expect(v2.rule).toBe("takeover-held");
  });

  it("refuses a non-owner agent — authority is server-verified, never self-declared", () => {
    const v = decideTakeover(runnerHeld(), as({ actor: "random-agent", session: "sneaky-1" }));
    expect(v.ok).toBe(false);
    if (v.ok === false) expect(v.rule).toBe("takeover-authority");
    expect((v as any).message).toMatch(/ask_agent|web plane/);
  });

  it("refuses a holder that is not a dispatch-spawned runner session (design 2)", () => {
    const peer = runnerHeld({ meta: { session: "topview-fix-1" }, holderIsRunner: false });
    const v = decideTakeover(peer, as({ actor: "web:rayh" }));
    expect(v.ok).toBe(false);
    if (v.ok === false) expect(v.rule).toBe("takeover-holder");
  });

  it("an unnamed holder stays eligible (session-less gateway claims are infrastructure)", () => {
    const v = decideTakeover(runnerHeld({ meta: {}, holderIsRunner: true }), as({ actor: "web:rayh" }));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.fromSession).toBeNull();
  });

  it("idempotent: the acting session already holds the claim → already, not a refusal", () => {
    const v = decideTakeover(runnerHeld({ meta: { session: "ray-local-1", taken_over: { by: "web:rayh" } } }), as({ actor: "web:rayh", session: "ray-local-1" }));
    expect(v).toEqual({ ok: true, already: true, fromSession: "ray-local-1", toSession: "ray-local-1" });
  });

  it("a takeover with no named session still applies (the human plane holds via its actor)", () => {
    const v = decideTakeover(runnerHeld(), as({ actor: "web:rayh", session: undefined }));
    expect(v).toEqual({ ok: true, already: false, fromSession: "dispatch-BR-1", toSession: null });
  });
});

describe("takeover refusals fold as never-breach classes (BR#3430)", () => {
  it("every [rule: takeover-*] rejection maps into a never-breach family", () => {
    expect(breachClass("claim takeover of BR#1 is owner/web/human-anchored [rule: takeover-authority]")).toBe("claim_race");
    expect(breachClass("claim takeover applies to an in_progress task [rule: takeover-target]")).toBe("claim_race");
    expect(breachClass("BR#1 is held by the train queue [rule: takeover-held]")).toBe("release_held");
    expect(breachClass("BR#1 is a verify/unblock duty card [rule: takeover-verdict-duty]")).toBe("gate:separation");
    expect(breachClass("holder is not a dispatch-spawned runner session [rule: takeover-holder]")).toBe("claim_race");
    expect(breachClass("the claim was taken over — you are the superseded holder [rule: takeover-stale-holder]")).toBe("claim_race");
  });
});
