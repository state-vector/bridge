import { describe, it, expect } from "vitest";
import {
  RULES,
  check,
  churnRelease,
  decide,
  effectiveRole,
  invariants,
  detectBreaches,
  breachClass,
  silentCycles,
  replayStatus,
  CHURN_ESCALATE_ATTEMPTS,
  CHURN_REDIRECT_ATTEMPTS,
  SILENT_ESCALATE_CYCLES,
  SILENT_REDIRECT_CYCLES,
  type RuleCtx,
  type RuleInput,
  type Applied,
} from "../src/kb/machine.ts";
import { LIFECYCLES } from "../src/kb/core.ts";
import { AWAIT_GRAMMAR_DOC } from "../src/kb/closure.ts";

// ---- null-law context: every lazy lookup permissive/empty. Individual tests
// override only the accessor they exercise. ----
const baseCtx = (): RuleCtx => ({
  qualify: () => ({ ok: true }),
  unmetBars: () => [],
  session: () => "session-a",
  evidence: () => null,
  parent: () => null,
  openChildren: () => 0,
  spawnGuard: () => null,
  openVerifyChild: () => null,
  openUnblockChild: () => null,
  cardBody: () => "",
  closeLegChildClosed: () => false,
  recentEvents: () => [],
});

const input = (over: Partial<RuleInput>): RuleInput => ({
  id: "BR#1",
  type: "task",
  status: "todo",
  to: "in_progress",
  roles: [],
  tags: [],
  meta: {},
  actor: "agent-x",
  body: {},
  now: 1_000_000,
  ...over,
});

const ok = (v: Awaited<ReturnType<typeof decide>>): Applied => {
  expect(v.ok, `expected Applied, got Rejection: ${JSON.stringify(v)}`).toBe(true);
  return v as Applied;
};

// ---------- the matrix: every role × from × to, generated from LIFECYCLES ----------

const ROLES = ["plain", "impl", "analysis", "review", "unblock", "human"] as const;
const TASK_STATUSES = Object.keys(LIFECYCLES.task); // todo, in_progress, in_review, blocked, done...

describe("transition matrix (task: role × from × to)", () => {
  const cells: { role: string; from: string; to: string }[] = [];
  for (const r of ROLES) {
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        cells.push({ role: r, from, to });
      }
    }
  }

  it("every cell resolves to allow-or-reject, never a throw", async () => {
    for (const c of cells) {
      const i = input({ status: c.from, to: c.to, roles: c.role === "plain" ? [] : [c.role] });
      let msg: string | null = null;
      let threw: unknown;
      try {
        msg = await check(i, baseCtx());
      } catch (e) {
        threw = e;
      }
      expect(threw, `check() threw for ${c.role} ${c.from}→${c.to}: ${threw}`).toBeUndefined();
      expect(typeof msg === "string" || msg === null, `non-string verdict for ${c.role} ${c.from}→${c.to}`).toBe(true);
      // the typed executor agrees with the shim, cell by cell
      const v = await decide(i, baseCtx());
      expect(v.ok, `decide() disagrees with check() for ${c.role} ${c.from}→${c.to}`).toBe(msg === null);
    }
  });

  it("the typed executor always answers Applied | Rejection — never a throw, never a bare string", async () => {
    for (const c of cells) {
      const i = input({ status: c.from, to: c.to, roles: c.role === "plain" ? [] : [c.role] });
      const v = await decide(i, baseCtx());
      expect(["boolean", "object"]).toContain(typeof v.ok);
      if (v.ok === true) {
        expect(typeof v.status).toBe("string");
        expect(Array.isArray(v.effects)).toBe(true);
        expect(typeof v.owner_clear).toBe("boolean");
        expect(v.meta_patch).toBeTypeOf("object");
      } else {
        expect(["illegal-edge", "guard-failed"]).toContain(v.code);
        expect(typeof v.rule).toBe("string");
        expect(v.rule.length).toBeGreaterThan(0);
        expect(typeof v.message).toBe("string");
      }
    }
  });

  it("verdict duties cannot block or enter in_review from ANY open state (BR#2298/BR#909 loop killers)", async () => {
    for (const duty of ["review", "unblock"]) {
      for (const [to, fragment] of [["blocked", "cannot block"] as const, ["in_review", "terminal state"] as const]) {
        const i = input({ status: "in_progress", to, roles: [duty] });
        const msg = await check(i, baseCtx());
        expect(msg, `${duty} → ${to} must be refused`).toContain(fragment);
      }
    }
  });

  it("verdict duties may still close done with receipts, and only then", async () => {
    const ok = await check(input({ status: "in_progress", to: "done", roles: ["review"], body: { note: "receipts: https://github.com/x/y/pull/1 merged" } }), baseCtx());
    expect(ok).toBeNull();
    const noReceipts = await check(input({ status: "in_progress", to: "done", roles: ["review"], body: { note: "looks fine" } }), baseCtx());
    expect(noReceipts).toContain("cannot complete without receipts");
  });

  it("verdict-duty blocked survives only as an ask-gate", async () => {
    const ask = input({
      status: "in_progress",
      to: "blocked",
      roles: ["review"],
      body: { note: "blocked on decision", unblock_condition: "answer to ask ASK-1", awaiting_ask_id: "ASK-1" },
    });
    expect(await check(ask, baseCtx())).toBeNull();
  });

  it("impl blocked requires a reason AND a typed await (BR#3578); blocked release requires resolution", async () => {
    expect(await check(input({ status: "in_progress", to: "blocked", body: { note: "why" } }), baseCtx())).toContain("typed await_event");
    expect(
      await check(input({ status: "in_progress", to: "blocked", body: { note: "why", unblock_condition: "when X" } }), baseCtx()),
    ).toContain("typed await_event"); // free text alone is annotation, never an exit condition
    expect(
      await check(input({ status: "in_progress", to: "blocked", body: { note: "why", await_event: { event: "pr_merged", repo: "a/b", n: 9 } } }), baseCtx()),
    ).toBeNull();
    expect(await check(input({ status: "blocked", to: "in_progress", body: {} }), baseCtx())).toContain("requires a resolution");
  });

  it("in_review needs a PR link; bounce needs findings (impl only — verdict duties never get here)", async () => {
    expect(await check(input({ status: "in_progress", to: "in_review", body: { note: "no link" } }), baseCtx())).toContain("requires the PR link");
    expect(
      await check(input({ status: "in_progress", to: "in_review", body: { note: "PR https://github.com/x/y/pull/9" } }), baseCtx()),
    ).toBeNull();
    expect(await check(input({ status: "in_review", to: "in_progress", body: {} }), baseCtx())).toContain("findings");
  });

  it("done is gated for plain/impl work, not for analysis children", async () => {
    const gated = baseCtx();
    gated.qualify = () => ({ ok: false });
    expect(await check(input({ status: "in_review", to: "done" }), gated)).toContain("cannot be completed unreviewed");
    const ok = baseCtx();
    ok.qualify = () => ({ ok: true, via: "child:BR#2" });
    expect(await check(input({ status: "in_review", to: "done" }), ok)).toBeNull();
  });

  it("open children fence the parent's done", async () => {
    const c = baseCtx();
    c.openChildren = () => 2;
    const msg = await check(input({ status: "in_review", to: "done", roles: ["analysis"], body: { note: "x" } }), c);
    expect(msg).toContain("still has 2 open child task(s)");
  });

  it("questions are never claimable; operator gates hold; decisions need a human", async () => {
    // the question lifecycle has no in_progress edge at all — stricter than the rule
    expect(await check(input({ type: "question" }), baseCtx())).toMatch(/not allowed|answered, not claimed/);
    expect(await check(input({ meta: { operator_gated: "Ray go" } }), baseCtx())).toContain("operator-gated");
    expect(
      await check(input({ type: "decision", status: "proposed", to: "accepted" }), baseCtx()),
    ).toContain("human-authoritative");
    expect(
      await check(input({ type: "decision", status: "proposed", to: "accepted", actor: "web:ray" }), baseCtx()),
    ).toBeNull();
  });

  it("claim separation: the analysis session cannot implement the same task", async () => {
    const c = baseCtx();
    c.qualify = () => ({ ok: true, via: "BR#9" });
    c.evidence = (id) => ({ type: "task", roles: ["analysis"], meta: { session: "session-a" } });
    const msg = await check(input({}), c);
    expect(msg).toContain("separation of duties");
    // a different session passes
    const c2 = baseCtx();
    c2.qualify = () => ({ ok: true, via: "BR#9" });
    c2.evidence = (id) => ({ type: "task", roles: ["analysis"], meta: { session: "session-b" } });
    expect(await check(input({}), c2)).toBeNull();
  });

  it("review separation: the impl session cannot produce its own review", async () => {
    const c = baseCtx();
    c.parent = () => ({ id: "BR#0", meta: { session: "session-a" } });
    const msg = await check(
      input({ status: "in_progress", to: "done", roles: ["review"], meta: { session: "session-a" }, body: { note: "PR https://x/pull/1 merged" } }),
      c,
    );
    expect(msg).toContain("cannot also produce the review");
  });

  it("unmet claim bars refuse the pickup", async () => {
    const c = baseCtx();
    c.unmetBars = () => ["role:review"];
    expect(await check(input({}), c)).toContain("unmet bars: role:review");
  });

  it("human sign-off tasks are human-authoritative", async () => {
    expect(await check(input({ roles: ["human"], status: "in_review", to: "done" }), baseCtx())).toContain("human sign-off");
  });
});

// ---------- regression cells: the exact loop shapes we killed ----------

describe("loop regressions", () => {
  it("BR#2298 shape: a verify task stalled into blocked by any actor is refused", async () => {
    const msg = await check(
      input({ id: "BR#2298", status: "in_progress", to: "blocked", roles: ["review"], actor: "system:watchdog", body: { note: "stalled", unblock_condition: "re-claim" } }),
      baseCtx(),
    );
    expect(msg).toContain("verdict duties cannot block");
  });

  it("BR#3578 shape: impl blocking WITH a typed await is legal; prose alone is refused at the door", async () => {
    expect(
      await check(input({ status: "in_progress", to: "blocked", body: { note: "needs direction", await_event: { event: "pr_merged", repo: "state-vector/bridge", n: 84 } } }), baseCtx()),
    ).toBeNull();
    // bound ask = the active human leg
    expect(
      await check(input({ status: "in_progress", to: "blocked", body: { note: "needs direction", awaiting_ask_id: "BR#3531" } }), baseCtx()),
    ).toBeNull();
    // machine-managed parks carry their own trip-wires
    expect(
      await check(input({ status: "in_progress", to: "blocked", body: { note: "train lease", merge_train: true } }), baseCtx()),
    ).toBeNull();
    // free text alone is annotation, never an exit condition — refused
    const prose = await check(input({ status: "in_progress", to: "blocked", body: { note: "needs direction", unblock_condition: "wire X per design" } }), baseCtx());
    expect(prose).toBeTruthy();
    // malformed typed event is refused too (closed set)
    const malformed = await check(input({ status: "in_progress", to: "blocked", body: { note: "needs direction", await_event: { event: "vibes" } } }), baseCtx());
    expect(malformed).toBeTruthy();
  });

  it("every rule has a name and the set is stable (table drift alarm)", () => {
    expect(RULES.map((r) => r.name).sort()).toEqual(
      [
        "bounce-needs-findings",
        "blocked-needs-typed-await",
        "claim-bars",
        "claim-separation-of-duties",
        "decision-acceptance-human",
        "done-close-legs",
        "done-open-children",
        "done-unreviewed",
        "human-signoff-done",
        "operator-gated",
        "question-not-claimable",
        "release-needs-ownership",
        "review-needs-pr",
        "review-separation-of-duties",
        "unblock-needs-resolution",
        "verdict-done-needs-receipts",
        "verdict-no-blocked",
        "verdict-no-in_review",
      ].sort(),
    );
    expect(CHURN_ESCALATE_ATTEMPTS).toBeLessThan(CHURN_REDIRECT_ATTEMPTS); // escalate before the redirect
    expect(SILENT_ESCALATE_CYCLES).toBeLessThanOrEqual(5); // server-side escalation at ≤5 cycles (BR#2419)
    expect(SILENT_REDIRECT_CYCLES).toBeLessThanOrEqual(5);
  });

  it("release ownership is a table row: agents can't dump each other's work", async () => {
    const v = await decide(input({ status: "in_progress", to: "todo", owner: "agent-y", actor: "agent-x" }), baseCtx());
    expect(v.ok).toBe(false);
    if (v.ok === false) {
      expect(v.code).toBe("guard-failed");
      expect(v.rule).toBe("release-needs-ownership");
    }
    // the owner, a human, or the machinery may release
    expect((await decide(input({ status: "in_progress", to: "todo", owner: "agent-x", actor: "agent-x" }), baseCtx())).ok).toBe(true);
    expect((await decide(input({ status: "in_progress", to: "todo", owner: "agent-x", actor: "web:ray" }), baseCtx())).ok).toBe(true);
    expect((await decide(input({ status: "in_progress", to: "todo", owner: "agent-x", actor: "system:watchdog" }), baseCtx())).ok).toBe(true);
  });

  // BR#3611: a gateway's claim is ATTRIBUTED — owner = attributedAgent
  // (do.ts claim path), so the gateway's raw actor never equals the owner and
  // the gate structurally refused every self-release (the stale-claim path in
  // dispatch.rs never succeeded live; the rejection churn re-armed breach
  // cards, specimen BR#3610).
  it("gateway self-release of its own attributed claim passes; cross-gateway stays gated (BR#3611)", async () => {
    // same gateway, body.agent === owner (the attributed agent) → allowed
    const selfRelease = input({
      status: "in_progress",
      to: "todo",
      owner: "mac-modem-opencode",
      actor: "mac-modem",
      body: { gateway: true, agent: "mac-modem-opencode" },
    });
    expect((await decide(selfRelease, baseCtx())).ok).toBe(true);
    // a DIFFERENT gateway's attributed agent ≠ owner — still a claim race
    const crossGateway = await decide(
      input({
        status: "in_progress",
        to: "todo",
        owner: "mac-modem-opencode",
        actor: "ip-172-31-1-230",
        body: { gateway: true, agent: "ip-172-31-1-230-opencode" },
      }),
      baseCtx(),
    );
    expect(crossGateway.ok).toBe(false);
    if (crossGateway.ok === false) {
      expect(crossGateway.code).toBe("guard-failed");
      expect(crossGateway.rule).toBe("release-needs-ownership");
    }
    // the exemption needs the gateway flag: a plain agent body naming the
    // owner's agent still refuses — mcp.ts strips gateway/agent from
    // non-gateway tokens, so this shape cannot occur live, and the rule does
    // not trust it if it did
    const forged = await decide(
      input({
        status: "in_progress",
        to: "todo",
        owner: "mac-modem-opencode",
        actor: "agent-x",
        body: { agent: "mac-modem-opencode" },
      }),
      baseCtx(),
    );
    expect(forged.ok).toBe(false);
    if (forged.ok === false) {
      expect(forged.rule).toBe("release-needs-ownership");
    }
  });
});

// ---------- BR#3361 (b)+(c): done-close-legs — terminal legs are owned ----------

describe("done-close-legs (terminal close legs need receipts or a closed child)", () => {
  const DONE_WHEN = [
    "## Done when",
    "- all review findings fixed and pushed",
    "- close GH #2261 (the incident issue)",
    "",
    "## Contract",
    "behave",
  ].join("\n");

  it("no close legs anywhere → the rule is silent (plain done unaffected)", async () => {
    const msg = await check(
      input({ status: "in_progress", to: "done", body: { note: "shipped", resolution: "all good" } }),
      { ...baseCtx(), cardBody: () => "no legs here" },
    );
    expect(msg).toBeNull();
  });

  it("a leg in the Done-when with NO receipt → rejected with the receipt contract", async () => {
    const msg = await check(
      input({ status: "in_progress", to: "done", body: { note: "work complete, ready to close" } }),
      { ...baseCtx(), cardBody: () => DONE_WHEN },
    );
    expect(msg).toContain("terminal close leg(s) not receipted");
    expect(msg).toContain("#2261");
    expect(msg).toContain("state=closed + closing-comment id");
  });

  it("a receipted done note passes (state=closed + comment id + guard run)", async () => {
    const note = [
      "done. Terminal legs executed:",
      "- GH #2261: state=closed, closing comment 17623388240 (https://github.com/state-vector/superpositional/issues/2261#issuecomment-17623388240), guard run 40198911366 guard=allow",
    ].join("\n");
    const msg = await check(
      input({ status: "in_progress", to: "done", body: { note } }),
      { ...baseCtx(), cardBody: () => DONE_WHEN },
    );
    expect(msg).toBeNull();
  });

  it("a bare-repo leg without repo slug takes a receipt too; intent-only language never counts", async () => {
    // "closes BR#3337 done" is a board-card reference, NOT a GH leg — no leg,
    // no rejection (the unblock-duty contract language must not manufacture legs)
    const noLeg = await check(
      input({ status: "in_progress", to: "done", body: { note: "fixes BR#3337 done — merges parent" } }),
      baseCtx(),
    );
    expect(noLeg).toBeNull();

    // "close-guard blocked GH#1" — mentions a close but state language absent
    const legNoReceipt = await check(
      input({ status: "in_progress", to: "done", body: { note: "closing the work now: close GH #50" } }),
      baseCtx(),
    );
    expect(legNoReceipt).toContain("terminal close leg(s) not receipted");
  });

  it("a CLOSED close-duty child owns the leg — the receipt path is not the only path", async () => {
    const ctx: RuleCtx = {
      ...baseCtx(),
      cardBody: () => DONE_WHEN,
      closeLegChildClosed: (leg) => leg.number === 2261,
    };
    const msg = await check(input({ status: "in_progress", to: "done", body: { note: "executed via close-leg duty" } }), ctx);
    expect(msg).toBeNull();
    // …but a closed child for a DIFFERENT leg doesn't cover this one
    const ctxWrongLeg: RuleCtx = {
      ...baseCtx(),
      cardBody: () => DONE_WHEN,
      closeLegChildClosed: (leg) => leg.number === 9999,
    };
    const msg2 = await check(input({ status: "in_progress", to: "done", body: { note: "executed via close-leg duty" } }), ctxWrongLeg);
    expect(msg2).toContain("terminal close leg(s) not receipted");
  });

  it("the executor's rejection message embeds legs as labels (the spawn path parses them back)", async () => {
    const i = input({ status: "in_progress", to: "done", body: { note: "no receipts yet" } });
    const v = await decide(i, { ...baseCtx(), cardBody: () => DONE_WHEN });
    expect(v.ok).toBe(false);
    if (v.ok === false) {
      expect(v.code).toBe("guard-failed");
      expect(v.rule).toBe("done-close-legs");
      // spawnCloseLegDuty re-parses `not receipted: <list> —` — keep the shape
      const listed = /not receipted: ([^—]+)—/.exec(v.message)?.[1] ?? "";
      expect(listed).toContain("#2261");
    }
    // URL-form legs carry the repo slug in the label (the spawn path reads it)
    const urlBody = [
      "## Done when",
      "- close https://github.com/state-vector/superpositional/issues/2261",
    ].join("\n");
    const v2 = await decide(i, { ...baseCtx(), cardBody: () => urlBody });
    expect(v2.ok).toBe(false);
    if (v2.ok === false) {
      const listed2 = /not receipted: ([^—]+)—/.exec(v2.message)?.[1] ?? "";
      expect(listed2).toContain("state-vector/superpositional#2261");
    }
  });
});

// ---------- the executor contract (BR#2419 item 2 / bounce finding F4) ----------

describe("executor contract: Applied(effects) | Rejection{code,rule,message}", () => {
  it("illegal edges are typed illegal-edge with rule 'lifecycle'", async () => {
    const v = await decide(input({ status: "todo", to: "done" }), baseCtx());
    expect(v.ok).toBe(false);
    if (v.ok === false) {
      expect(v.code).toBe("illegal-edge");
      expect(v.rule).toBe("lifecycle");
      expect(v.message).toContain("not allowed");
    }
  });

  it("guard failures are typed guard-failed and name the table row", async () => {
    const v = await decide(input({ status: "in_progress", to: "in_review", body: { note: "no link" } }), baseCtx());
    expect(v.ok).toBe(false);
    if (v.ok === false) {
      expect(v.code).toBe("guard-failed");
      expect(v.rule).toBe("review-needs-pr");
    }
  });

  it("guard order is table order — first failing rule wins deterministically", async () => {
    // a review task closing done with neither receipts nor a clean session:
    // verdict-done-needs-receipts sits before review-separation-of-duties
    const c = baseCtx();
    c.parent = () => ({ id: "BR#0", meta: { session: "session-a" } });
    const v = await decide(input({ status: "in_progress", to: "done", roles: ["review"], meta: { session: "session-a" }, body: { note: "vibes" } }), c);
    expect(v.ok).toBe(false);
    if (v.ok === false) expect(v.rule).toBe("verdict-done-needs-receipts");
    // a review task blocked without any note: verdict-no-blocked (the carve-out rule)
    // sits before blocked-needs-typed-await — the loop class dies at the FIRST gate
    const v2 = await decide(input({ status: "in_progress", to: "blocked", roles: ["review"], body: {} }), baseCtx());
    expect(v2.ok).toBe(false);
    if (v2.ok === false) expect(v2.rule).toBe("verdict-no-blocked");
    // an illegal edge on a verdict task reports the lifecycle, not the table
    const v3 = await decide(input({ status: "todo", to: "done", roles: ["review"] }), baseCtx());
    if (v3.ok === false) expect(v3.code).toBe("illegal-edge");
  });

  it("legal claims apply with the resume cascade (ephemeral unblock children die when the parent moves)", async () => {
    const v = ok(await decide(input({}), baseCtx()));
    expect(v.status).toBe("in_progress");
    expect(v.owner_clear).toBe(false);
    expect(v.tags_add).toEqual([]);
    expect(v.effects).toEqual([
      { kind: "supersede_children", parent: "BR#1", tag: "unblock", keep_newest: false, cause: expect.stringContaining("unblock round closed") },
    ]);
  });

  it("non-task artefacts carry no effects", async () => {
    const v = ok(await decide(input({ type: "decision", status: "proposed", to: "superseded", actor: "web:ray" }), baseCtx()));
    expect(v.effects).toEqual([]);
  });
});

// ---------- effects: decided by the executor, executed by do.ts ----------

describe("effects decided executor-side (F4)", () => {
  it("in_review spawns a verify child — pr extracted from the note", async () => {
    const v = ok(await decide(input({ status: "in_progress", to: "in_review", body: { note: "PR https://github.com/x/y/pull/7" } }), baseCtx()));
    expect(v.effects).toEqual([{ kind: "spawn_verify", parent: "BR#1", pr: "https://github.com/x/y/pull/7" }]);
  });

  it("the pr scrape rejoins the runner's mid-word line wrap (BR#3845)", async () => {
    // the runner captures agent output at terminal width and hard-wraps
    // mid-word; the old bare `https?://\S+` scrape stamped the truncated
    // first line (github.com/state-vector/super) into the verify body and
    // the runner cloned the ghost repo — dispatch skipped, task churned ×11
    const wrapped = "PR [#2343](https://github.com/state-vector/super\npositional/pull/2343) is merge-ready";
    const v = ok(await decide(input({ status: "in_progress", to: "in_review", body: { note: wrapped } }), baseCtx()));
    expect(v.effects).toEqual([
      { kind: "spawn_verify", parent: "BR#1", pr: "https://github.com/state-vector/superpositional/pull/2343" },
    ]);
  });

  it("the pr scrape refuses unclonable fragments — null, the body renders 'see note'", async () => {
    const v = ok(await decide(input({ status: "in_progress", to: "in_review", body: { note: "receipts: https://example.com/whatever, prose only" } }), baseCtx()));
    expect(v.effects).toEqual([{ kind: "spawn_verify", parent: "BR#1", pr: null }]);
  });

  it("an open verify round is REUSED, not stacked (the churn that drowned the pool)", async () => {
    const c = baseCtx();
    c.openVerifyChild = () => ({ id: "BR#99" });
    const v = ok(await decide(input({ status: "in_progress", to: "in_review", body: { note: "PR https://x/pull/1" } }), c));
    expect(v.effects).toEqual([{ kind: "reuse_verify", parent: "BR#1", verify: "BR#99" }]);
  });

  it("verify-of-verify / nesting guards SKIP the spawn — and the skip becomes a breach event", async () => {
    const c = baseCtx();
    c.spawnGuard = () => "ancestor BR#5 is a review task — verify-of-verify is blocked";
    const v = ok(await decide(input({ status: "in_progress", to: "in_review", body: { note: "PR https://x/pull/1" } }), c));
    expect(v.effects).toEqual([{ kind: "skip_verify_spawn", parent: "BR#1", reason: "ancestor BR#5 is a review task — verify-of-verify is blocked" }]);
  });

  it("blocked spawns an unblock child with the exit condition; cap and flood guard skip it", async () => {
    const typedBlock = (extra: Record<string, unknown> = {}) => ({
      status: "in_progress", to: "blocked",
      body: { note: "why", unblock_condition: "PR https://github.com/a/b/pull/9 merged", ...extra },
    });
    const v = ok(await decide(input(typedBlock()), baseCtx()));
    expect(v.effects).toEqual([{ kind: "spawn_unblock", parent: "BR#1", reason: "why", exit_condition: "PR https://github.com/a/b/pull/9 merged" }]);

    const capped = baseCtx();
    capped.openUnblockChild = () => ({ id: "BR#50" });
    const v2 = ok(await decide(input(typedBlock()), capped));
    expect(v2.effects).toEqual([{ kind: "skip_unblock_spawn", parent: "BR#1", reason: "existing unblock child BR#50 reused" }]);

    const flooded = input(typedBlock({
      unblock_condition: "PR https://github.com/a/b/pull/9 merged",
    }));
    flooded.meta = { last_unblock_spawn: { at: 1_000_000 - 10 * 60_000, exit: "PR https://github.com/a/b/pull/9 merged" } }; // 10m ago, same exit
    const v3 = ok(await decide(flooded, baseCtx()));
    expect(v3.effects[0].kind).toBe("skip_unblock_spawn");
    expect((v3.effects[0] as any).reason).toContain("flood guard");

    // a DIFFERENT exit condition is a new round, not a flood repeat
    const freshExit = input({
      status: "in_progress",
      to: "blocked",
      body: { note: "why", unblock_condition: "PR https://github.com/a/b/pull/10 merged" },
      meta: { last_unblock_spawn: { at: 1_000_000 - 10 * 60_000, exit: "PR https://github.com/a/b/pull/9 merged" } },
    });
    expect(ok(await decide(freshExit, baseCtx())).effects[0].kind).toBe("spawn_unblock");
  });

  it("ask-gates and subprocess declarations never spawn unblock children; unblock duties cannot even block", async () => {
    const askGate = ok(
      await decide(input({ status: "in_progress", to: "blocked", body: { note: "n", unblock_condition: "u", awaiting_ask_id: "ASK-1" } }), baseCtx()),
    );
    expect(askGate.effects).toEqual([]);
    const subproc = ok(
      await decide(input({ status: "in_progress", to: "blocked", body: { note: "n", unblock_condition: "u", class: "subprocess" } }), baseCtx()),
    );
    expect(subproc.effects).toEqual([]);
    // stronger than a spawn-suppression: an unblock task entering blocked is
    // refused outright (verdict duties are done-only terminals)
    const unblockDuty = await decide(input({ status: "in_progress", to: "blocked", roles: ["unblock"], body: { note: "n", unblock_condition: "u" } }), baseCtx());
    expect(unblockDuty.ok).toBe(false);
    if (unblockDuty.ok === false) expect(unblockDuty.rule).toBe("verdict-no-blocked");
  });

  it("parent movement supersedes ephemeral children; a bounce keeps the newest verify round", async () => {
    const done = ok(await decide(input({ status: "in_review", to: "done", roles: ["analysis"], body: { note: "x" } }), baseCtx()));
    expect(done.effects).toContainEqual({ kind: "supersede_children", parent: "BR#1", tag: "unblock", keep_newest: false, cause: "BR#1 → done — unblock round closed" });
    expect(done.effects).toContainEqual({ kind: "supersede_children", parent: "BR#1", tag: "review", keep_newest: false, cause: "BR#1 done — verification round closed" });

    const bounce = ok(await decide(input({ status: "in_review", to: "in_progress", body: { note: "findings: flaky CI" } }), baseCtx()));
    expect(bounce.effects).toContainEqual({ kind: "supersede_children", parent: "BR#1", tag: "review", keep_newest: true, cause: expect.stringContaining("newest kept for re-entry") });

    const resume = ok(await decide(input({ status: "blocked", to: "in_progress", body: { note: "resolved: X landed" } }), baseCtx()));
    expect(resume.effects).toContainEqual({ kind: "supersede_children", parent: "BR#1", tag: "unblock", keep_newest: false, cause: expect.stringContaining("resumed from blocked") });
  });

  it("plain releases clear the owner, stamp the attempt, add the attempted tag", async () => {
    const v = ok(await decide(input({ status: "in_progress", to: "todo", body: { note: "context switch" } }), baseCtx()));
    expect(v.owner_clear).toBe(true);
    expect(v.tags_add).toEqual(["attempted"]);
    expect(v.meta_patch.attempt).toMatchObject({ by: "agent-x", attempts: 1, last_reason: "context switch" });
    expect(v.effects.map((e) => e.kind)).toEqual(["supersede_children"]);
  });

  it("completion resets the churn counter but keeps the last-attempt display", async () => {
    const v = ok(
      await decide(
        input({ status: "in_review", to: "done", roles: ["analysis"], meta: { attempt: { by: "agent-x", at: 5, attempts: 4, last_reason: "r" } } }),
        baseCtx(),
      ),
    );
    expect(v.meta_patch.attempt).toMatchObject({ attempts: 0, last_reason: "r" });
  });
});

// ---------- churn: attempts + silent cycles, server-side ----------

describe("churn escalate/redirect (attempts + version-log silent cycles)", () => {
  const released = (attempts: number, roles: string[] = [], events: Parameters<typeof silentCycles>[0] = []) =>
    decide(
      input({
        status: "in_progress",
        to: "todo",
        roles,
        meta: { attempt: { by: "agent-x", at: 1, attempts } },
        actor: "system:watchdog",
      }),
      { ...baseCtx(), recentEvents: () => events },
    );

  it("verdict duties escalate to a human at CHURN_ESCALATE_ATTEMPTS — they never redirect into blocked", async () => {
    const v = ok(await released(CHURN_ESCALATE_ATTEMPTS - 1, ["review"])); // +1 in the executor = 3
    expect(v.status).toBe("todo"); // NOT blocked
    expect(v.owner_clear).toBe(true);
    expect(v.meta_patch.escalate).toMatchObject({ attempts: CHURN_ESCALATE_ATTEMPTS });
    expect(v.effects[0].kind).toBe("escalate");
    const ub = ok(await released(CHURN_ESCALATE_ATTEMPTS - 1, ["unblock"]));
    expect(ub.effects[0].kind).toBe("escalate");
  });

  it("impl/analysis redirect to blocked at CHURN_REDIRECT_ATTEMPTS — status override decided by the executor", async () => {
    const v = ok(await released(CHURN_REDIRECT_ATTEMPTS - 1)); // +1 in the executor = 5
    expect(v.status).toBe("blocked");
    expect(v.meta_patch.blocked).toMatchObject({ unblock_condition: expect.stringContaining("re-claim") });
    expect(v.effects[0]).toMatchObject({ kind: "release_redirect", attempts: CHURN_REDIRECT_ATTEMPTS });
  });

  it("silent cycles escalate server-side from the version log (3–5 zero-output watchdog stalls)", () => {
    const stall = (n: number): Parameters<typeof silentCycles>[0][number] => ({ ts: n, actor: "system:watchdog", action: "transition", summary: "stalled — no update for >10m; released to the pool by watchdog" });
    const agent = (n: number): Parameters<typeof silentCycles>[0][number] => ({ ts: n, actor: "agent-x", action: "progress", summary: "working" });
    expect(silentCycles([])).toBe(0);
    expect(silentCycles([stall(1), stall(2), stall(3)])).toBe(3);
    // interleaved agent output resets the run — churn with a heartbeat is not silent
    expect(silentCycles([stall(1), stall(2), agent(3), stall(4), stall(5), stall(6)])).toBe(3);
    expect(silentCycles([agent(1)])).toBe(0);
  });

  it("3 silent cycles escalate a verdict duty before the attempt counter trips", async () => {
    const events = [1, 2, 3].map((n) => ({ ts: n, actor: "system:watchdog", action: "transition", summary: "stalled — released to the pool by watchdog" }));
    const v = ok(await released(1, ["review"], events));
    expect(v.effects[0].kind).toBe("escalate");
    expect((v.effects[0] as any).silent_cycles).toBe(SILENT_ESCALATE_CYCLES);
  });

  it("5 silent cycles redirect impl work — escalation always lands at ≤5 cycles", async () => {
    const events = [1, 2, 3, 4, 5].map((n) => ({ ts: n, actor: "system:watchdog", action: "transition", summary: "stalled — released to the pool by watchdog" }));
    const v = ok(await released(1, [], events));
    expect(v.status).toBe("blocked");
    expect(v.meta_patch.blocked).toMatchObject({ reason: expect.stringContaining("silent churn") });
  });
});

// ---------- churn release policy (BR#2404 — the silent-dispatch loop bound) ----------

describe("churnRelease", () => {
  it("verdict duties escalate to a human at 3 releases — they may not block", () => {
    expect(churnRelease(1, true, "in_progress")).toBe("pass");
    expect(churnRelease(2, true, "in_progress")).toBe("pass");
    expect(churnRelease(CHURN_ESCALATE_ATTEMPTS, true, "in_progress")).toBe("escalate");
    expect(churnRelease(9, true, "in_progress")).toBe("escalate");
  });

  it("impl/analysis keep re-entering below 5 releases, then the release redirects to blocked", () => {
    expect(churnRelease(CHURN_REDIRECT_ATTEMPTS - 1, false, "in_progress")).toBe("pass");
    expect(churnRelease(CHURN_REDIRECT_ATTEMPTS, false, "in_progress")).toBe("redirect");
    expect(churnRelease(CHURN_REDIRECT_ATTEMPTS + 3, false, "in_progress")).toBe("redirect");
  });

  it("at the overlap a verdict duty escalates — escalate wins over redirect", () => {
    expect(churnRelease(CHURN_REDIRECT_ATTEMPTS, true, "in_progress")).toBe("escalate");
  });

  it("releasing an already-blocked task never re-redirects (deliberate unblock)", () => {
    expect(churnRelease(CHURN_REDIRECT_ATTEMPTS + 1, false, "blocked")).toBe("pass");
    expect(churnRelease(CHURN_ESCALATE_ATTEMPTS, true, "blocked")).toBe("escalate");
  });
});

// ---------- invariants ----------

describe("invariants (post-conditions)", () => {
  it("flag every illegal stored state the loops produced", () => {
    expect(invariants({ type: "task", status: "blocked", roles: ["review"], meta: { blocked: {} } }).length).toBeGreaterThan(0);
    expect(invariants({ type: "task", status: "in_review", roles: ["unblock"], meta: {} }).length).toBeGreaterThan(0);
    expect(invariants({ type: "question", status: "in_progress", meta: {} }).length).toBeGreaterThan(0);
    expect(invariants({ type: "task", status: "blocked", tags: [], meta: {} }).length).toBeGreaterThan(0); // blocked w/o record
    expect(invariants({ type: "task", status: "todo", tags: [], meta: { blocked: { reason: "x" } } }).length).toBeGreaterThan(0); // stale record
  });

  it("pass clean legal states", () => {
    expect(invariants({ type: "task", status: "blocked", tags: [], meta: { blocked: { reason: "r", unblock_condition: "u" } } })).toEqual([]);
    expect(invariants({ type: "task", status: "in_progress", roles: ["review"], meta: {} })).toEqual([]);
    expect(invariants({ type: "task", status: "done", roles: ["impl"], meta: {} })).toEqual([]);
  });
});

// ---------- replay consistency: fold(events) == stored_state (F2) ----------

describe("replay fold (BR#2419 item 6)", () => {
  const t = (from: string, to: string): { action: string; data: any } => ({ action: "transition", data: { from, to } });

  it("folds a consistent log forward to the stored status", () => {
    const log = [t("todo", "in_progress"), t("in_progress", "in_review"), t("in_review", "done")];
    expect(replayStatus("", log)).toEqual({ status: "done", ok: true, breaks: 0, tailBreak: false });
    // a fold that disagrees with the stored state is the mismatch breach class
    const fold = replayStatus("", log);
    expect(fold.status !== "in_review" && fold.ok).toBe(true); // stored in_review would mismatch
  });

  it("a gap re-anchors and the fold heals forward — the breach lives in fold-vs-stored, not in an abort", () => {
    // (BR#3322) the early-return contract made ONE historical gap break the
    // fold forever: every later transition re-fired the replay breach on a
    // log that could never verify again. The fold now re-anchors at each gap
    // (the log's own chain continues from the row's `to`) and reports the
    // damage; the replay LAW (fold(events) == stored_state) is enforced by
    // the caller comparing the healed fold with the stored status.
    const broken = [t("todo", "in_progress"), t("in_review", "done")]; // jump: in_progress ≠ in_review
    const fold = replayStatus("", broken);
    expect(fold.status).toBe("done"); // healed past the gap
    expect(fold.ok).toBe(false); // chain integrity: the caller sees the gap
    expect(fold.breaks).toBe(1);
    expect(fold.tailBreak).toBe(true); // the gap is at the tail — fresh damage, audited
  });

  it("ignores non-transition events and tolerates subprocess self-loops", () => {
    const log = [
      { action: "create", data: {} },
      { action: "progress", data: {} },
      t("todo", "in_progress"),
      { action: "transition", data: { from: "in_progress", to: "in_progress", class: "subprocess" } }, // declared silence
      t("in_progress", "in_review"),
    ];
    expect(replayStatus("", log)).toEqual({ status: "in_review", ok: true, breaks: 0, tailBreak: false });
  });

  it("an empty log folds to nothing — no false mismatch on fresh artefacts", () => {
    expect(replayStatus("", [])).toEqual({ status: "", ok: true, breaks: 0, tailBreak: false });
  });

  it("BR#3322 regression: a legacy silent mutation must not re-fire the breach on every later transition", () => {
    // BR#903's Oct-20 shape: a verify round bounced in_review → in_progress
    // without stamping a transition row; the next stamped row claims
    // from=in_progress. The old fold aborted there forever (folded "in_review",
    // ok:false on EVERY later transition — the breach card re-fired all day).
    const log = [
      t("todo", "in_progress"),
      t("in_progress", "in_review"),
      t("in_progress", "todo"), // from lies: the stored was in_review (silent bounce)
      t("todo", "in_progress"), // later rows chain cleanly again
      t("in_progress", "blocked"),
    ];
    const fold = replayStatus("", log);
    expect(fold.status).toBe("blocked"); // heals to the log's own end state
    expect(fold.ok).toBe(false);
    expect(fold.breaks).toBe(1);
    expect(fold.tailBreak).toBe(false); // damage is historical — no per-transition audit spam
  });

  it("BR#3322 regression: the churn-guard duplicate stamp (applied row + effect row) is one audible tail break", () => {
    // do.ts release_redirect/escalate used to stamp a SECOND transition row
    // with the stale pre-applied from, right after the applied row had
    // already moved the chain — one guaranteed gap per churn redirect.
    const log = [
      t("todo", "in_progress"),
      t("in_progress", "blocked"), // the applied transition (watchdog redirect)
      t("in_progress", "blocked"), // the duplicate effect stamp with the stale from
    ];
    const fold = replayStatus("", log);
    expect(fold.status).toBe("blocked");
    expect(fold.breaks).toBe(1);
    expect(fold.ok).toBe(false);
    expect(fold.tailBreak).toBe(true); // fresh damage — audited the moment it lands
  });

  it("a later clean row clears the provisional tailBreak — only the newest row counts (BR#3322)", () => {
    const log = [
      t("todo", "in_progress"),
      t("in_progress", "blocked"),
      t("in_progress", "blocked"), // stale duplicate stamp at the tail
    ];
    expect(replayStatus("", log).tailBreak).toBe(true);
    // the next clean write chains from the healed state — the fresh damage
    // ages into the historical noise floor after one good stamp
    const healed = replayStatus("", [...log, t("blocked", "todo")]);
    expect(healed.tailBreak).toBe(false);
    expect(healed.status).toBe("todo");
    expect(healed.breaks).toBe(1);
  });
});

// ---------- breach detection fold ----------

describe("breach fold (dedupe by task+class)", () => {
  const ev = (n: number, task: string, reason: string, op = "transition_rejected") => ({
    ts: 1_000_000 + n * 60_000,
    task,
    op,
    reason,
  });

  it("one breach per (task, class) at threshold; repeats inside the window coalesce", () => {
    const events = [0, 1, 2, 3].map((n) => ev(n, "BR#1", "moving to in_review requires the PR link in the note"));
    const breaches = detectBreaches(events, new Set());
    expect(breaches.length).toBe(1);
    expect(breaches[0].count).toBe(4);
    expect(breaches[0].klass).toBe("gate:review-needs-pr");
  });

  it("an open breach key is never re-raised", () => {
    const events = [0, 1, 2].map((n) => ev(n, "BR#1", "task BR#1 cannot be completed unreviewed"));
    expect(detectBreaches(events, new Set(["BR#1|gate:done-unreviewed"]))).toHaveLength(0);
    expect(detectBreaches(events, new Set())).toHaveLength(1);
  });

  it("events outside the window do not accumulate; different tasks never merge", () => {
    const spread = [0, 60, 120].map((n) => ev(n, "BR#1", "moving to in_review requires the PR link in the note"));
    expect(detectBreaches(spread, new Set())).toHaveLength(0); // 1h apart, window 30m
    const twoTasks = [...[0, 1, 2].map((n) => ev(n, "BR#1", "task cannot be completed unreviewed")), ...[0, 1, 2].map((n) => ev(n, "BR#2", "task cannot be completed unreviewed"))];
    expect(detectBreaches(twoTasks, new Set()).length).toBe(2);
  });

  it("gate storms keep the repetition threshold — three rejections raise one card", () => {
    const events = [0, 1, 2].map((n) => ev(n, "BR#4", "moving to in_review requires the PR link in the note"));
    expect(detectBreaches(events.slice(0, 2), new Set())).toHaveLength(0); // below threshold
    expect(detectBreaches(events, new Set())).toHaveLength(1);
  });

  it("spawn_skipped folds into the spawn-while-open class on the FIRST event (F3)", () => {
    const events = [ev(0, "BR#5", "existing unblock child BR#9 reused", "spawn_skipped")];
    const breaches = detectBreaches(events, new Set());
    expect(breaches.length).toBe(1);
    expect(breaches[0].klass).toBe("spawn-while-open");
    expect(breaches[0].key).toBe("BR#5|spawn-while-open");
    // the BR#909 shape: a second spawn attempt while one is open = exactly one card
    const storm = [0, 1, 2, 3].map((n) => ev(n, "BR#5", "existing unblock child BR#9 reused", "spawn_skipped"));
    expect(detectBreaches(storm, new Set())).toHaveLength(1);
  });

  it("replay mismatches breach immediately — one corrupted fold is never noise", () => {
    const breaches = detectBreaches([ev(0, "BR#6", "stored done, log folds to in_review", "replay_mismatch")], new Set());
    expect(breaches).toHaveLength(1);
    expect(breaches[0].klass).toBe("replay");
  });

  it("invariant violations breach on the first event under their own class", () => {
    const breaches = detectBreaches([ev(0, "BR#3", "verdict role review is blocked", "invariant_violation")], new Set());
    expect(breaches.length).toBe(1);
    expect(breaches[0].klass).toBe("invariant");
  });

  it("classifies the known gate families", () => {
    expect(breachClass("moving to in_review requires the PR link")).toBe("gate:review-needs-pr");
    expect(breachClass("runner: task references no git repository")).toBe("gate:no-repo");
    expect(breachClass("something novel")).toBe("unclassified");
  });

  // ---------- BR#3443: a closed card's events never re-fold (high-water) ----------
  // Specimen BR#3439: raised 17:03:22.861Z from 6 events that ALL predate its
  // predecessor BR#3427's close (16:30:45.674Z) — the fold had no memory of
  // what it already folded, so closing a card re-armed its key.
  it("BR#3443: events at or below a key's high-water never re-fold after the card closes", () => {
    const reason = "moving to in_review requires the PR link in the note";
    const events = [0, 1, 2].map((n) => ev(n, "BR#7", reason));
    const raised = detectBreaches(events, new Set());
    expect(raised).toHaveLength(1);
    const highWater = new Map([[raised[0].key, raised[0].last_ts]]);
    // the card closes; the next fold trigger re-scans the same lookback. The
    // stale group must stay folded — one fresh event alone is below threshold.
    const refold = detectBreaches([...events, ev(4, "BR#7", reason)], new Set(), { highWater });
    expect(refold).toHaveLength(0);
    // the boundary is inclusive: an event exactly AT the high-water is already folded
    expect(detectBreaches([ev(2, "BR#7", reason)], new Set(), { highWater })).toHaveLength(0);
  });

  it("BR#3443: genuinely new events above the high-water still raise", () => {
    const reason = "moving to in_review requires the PR link in the note";
    const events = [0, 1, 2].map((n) => ev(n, "BR#8", reason));
    const raised = detectBreaches(events, new Set());
    expect(raised).toHaveLength(1);
    const highWater = new Map([[raised[0].key, raised[0].last_ts]]);
    // three events strictly after the closed card's high-water — a fresh
    // pattern, not stale evidence — raises a new card
    const fresh = [5, 6, 7].map((n) => ev(n, "BR#8", reason));
    expect(detectBreaches([...events, ...fresh], new Set(), { highWater })).toHaveLength(1);
  });

  it("BR#3443: an open card still coalesces reoccurrences — the high-water never defeats the open-key rule", () => {
    const reason = "moving to in_review requires the PR link in the note";
    const events = [0, 1, 2].map((n) => ev(n, "BR#9", reason));
    const raised = detectBreaches(events, new Set());
    expect(raised).toHaveLength(1);
    const key = raised[0].key;
    const highWater = new Map([[key, raised[0].last_ts]]);
    const openKeys = new Set([key]);
    // reoccurrences above the open card's stamp coalesce onto it: one card,
    // never a second, with or without the high-water in play
    expect(detectBreaches([...events, ev(3, "BR#9", reason)], openKeys, { highWater })).toHaveLength(0);
    expect(detectBreaches(events, openKeys)).toHaveLength(0);
  });
});

// ---------- BR#3337: claim races are retryable, never breaches ----------

describe("claim-race classification (BR#3337)", () => {
  // the exact rejection shape the lifecycle gate emits for a raced claim:
  // a gateway attempted in_progress → in_progress on a card another session owns
  const raceEvents = (n: number, task = "BR#3337A") =>
    Array.from({ length: n }, (_, i) => ({
      ts: 1_000_000 + i * 60_000,
      task,
      op: "transition_rejected",
      reason: "task: 'in_progress' → 'in_progress' not allowed (allowed: in_review, done, blocked, todo)",
    }));

  it("lifecycle-edge rejections classify as claim_race", () => {
    expect(breachClass("task: 'in_progress' → 'in_progress' not allowed (allowed: in_review, done, blocked, todo)")).toBe("claim_race");
    expect(breachClass("status 'in_review' is terminal for task")).toBe("claim_race");
    // BR#3429: ownership-gate rejections on a raced release are the same
    // benign class — a non-owner tried to release a claimed card, the gate
    // refused, the loser skips (specimen BR#3427: 3 rule-9 release attempts
    // on a runner-claimed card raised a breach card before this fix)
    expect(breachClass("task BR#1 is claimed by other-gw — only the owner or a human can release it to the pool")).toBe("claim_race");
    // BR#3611: PR #210's proven-unblock wording (8a1acbd) broke the sentence
    // literal — the structural pair must receive it too (specimen BR#3610:
    // this exact wording regressed to class 'other' and re-armed breach cards
    // on the ownership key)
    expect(breachClass("task BR#3372 is claimed by mac-modem-opencode — only the owner, a human, or an unblock duty holding proof of the met exit condition can release it. If the work overlaps yours, coordinate via ask_agent instead. [rule: release-needs-ownership]")).toBe("claim_race");
  });

  it("a claim-race storm never raises a breach card (the breaker does not count it)", () => {
    expect(detectBreaches(raceEvents(9), new Set())).toHaveLength(0);
  });

  // BR#3429: the ownership-gate shape (release-needs-ownership) folds as
  // claim_race too — the exact rejection the BR#3427 specimen shows (3 rule-9
  // release attempts on a runner-claimed card in 18 s raised a breach card).
  const ownershipEvents = (n: number, task = "BR#3429A") =>
    Array.from({ length: n }, (_, i) => ({
      ts: 1_000_000 + i * 60_000,
      task,
      op: "transition_rejected",
      reason:
        "task BR#3372 is claimed by mac-modem-opencode — only the owner or a human can release it to the pool. If the work overlaps yours, coordinate via ask_agent instead. [rule: release-needs-ownership]",
    }));

  it("ownership-gate rejections never raise a breach card either (BR#3429)", () => {
    expect(detectBreaches(ownershipEvents(9), new Set())).toHaveLength(0);
  });

  // BR#3611: PR #210's proven-unblock wording (8a1acbd) broke the sentence
  // literal — the structural pair must classify the new wording the same way
  // (specimen BR#3610: 3 rejections in this wording raised a breach card at
  // the default threshold 3).
  const ownershipEventsNewWording = (n: number, task = "BR#3611A") =>
    Array.from({ length: n }, (_, i) => ({
      ts: 1_000_000 + i * 60_000,
      task,
      op: "transition_rejected",
      reason:
        "task BR#3372 is claimed by mac-modem-opencode — only the owner, a human, or an unblock duty holding proof of the met exit condition can release it. If the work overlaps yours, coordinate via ask_agent instead. [rule: release-needs-ownership]",
    }));

  it("proven-unblock wording (PR #210) folds as claim_race too (BR#3611)", () => {
    expect(detectBreaches(ownershipEventsNewWording(9), new Set())).toHaveLength(0);
    // the wording variant contaminates no genuine class either
    const genuine = [0, 1, 2].map((n) => ({
      ts: 1_000_000 + n * 60_000,
      task: "BR#3611B",
      op: "transition_rejected",
      reason: "task BR#3611B cannot be completed unreviewed — complete a verify (review-role) child task first",
    }));
    const mixed = [...ownershipEventsNewWording(5, "BR#3611B"), ...genuine];
    expect(detectBreaches(mixed, new Set())).toMatchObject([
      { klass: "gate:done-unreviewed", count: 3 },
    ]);
  });

  it("genuine gate storms still raise exactly one breach; races never contaminate the count", () => {
    const genuine = [0, 1, 2].map((n) => ({
      ts: 1_000_000 + n * 60_000,
      task: "BR#3337B",
      op: "transition_rejected",
      reason: "task BR#3337B cannot be completed unreviewed — complete a verify (review-role) child task first",
    }));
    const breaches = detectBreaches(genuine, new Set());
    expect(breaches).toHaveLength(1);
    expect(breaches[0].klass).toBe("gate:done-unreviewed");
    // a mixed storm: 5 races + 3 genuine rejections → exactly one breach, for
    // the genuine class, with the race count untouched
    const mixed = [...raceEvents(5, "BR#3337B"), ...genuine];
    const mixedBreaches = detectBreaches(mixed, new Set());
    expect(mixedBreaches).toHaveLength(1);
    expect(mixedBreaches[0].klass).toBe("gate:done-unreviewed");
    expect(mixedBreaches[0].count).toBe(3);
    // ownership-gate races contaminate no more than lifecycle-edge ones
    const mixedOwnership = [...ownershipEvents(5, "BR#3337B"), ...genuine];
    expect(detectBreaches(mixedOwnership, new Set())).toMatchObject([
      { klass: "gate:done-unreviewed", count: 3 },
    ]);
  });
});

// ---------- BR#3738: the BR#3578 fail-closed typed-await park gates ----------

describe("typed-await gate classification (BR#3738)", () => {
  // The two BR#3578 rejections a mis-parked card can raise, built from the
  // live grammar doc exactly as the guards emit them (machine.ts, rule
  // blocked-needs-typed-await) plus the " [rule: …]" suffix do.ts appends to
  // every guard rejection. Specimen BR#3731 event 1 (2026-10-26T16:27:45Z):
  // a verify duty parked BR#3576 with {event:"run_success", run_id: 40358175346
  // as a NUMBER} → gate refused; the corrected string retry succeeded 32s
  // later — the gate, not the park, was rejected. Both fold as 'other' here
  // until this fix.
  const BLOCKED_NEEDS_TYPED_AWAIT = `moving to blocked requires a typed await_event — ${AWAIT_GRAMMAR_DOC}; a bound ask (ask_agent) is the human leg. Free text alone is annotation, never an exit condition (BR#3578) [rule: blocked-needs-typed-await]`;
  const MALFORMED_AWAIT_EVENT = `malformed await_event — the grammar is a closed set: ${AWAIT_GRAMMAR_DOC} [rule: blocked-needs-typed-await]`;

  it("classifies the two fail-closed typed-await park gates", () => {
    expect(breachClass(BLOCKED_NEEDS_TYPED_AWAIT)).toBe("gate:blocked-needs-typed-await");
    expect(breachClass(MALFORMED_AWAIT_EVENT)).toBe("gate:malformed-await-event");
  });

  it("classifies through the 300-char audit slice — the [rule: …] tag never survives it", () => {
    // do.ts audits reason = e.message.slice(0, 300); both gate messages embed
    // AWAIT_GRAMMAR_DOC (~290 chars), so the tag is cut off in the stored
    // event. The stems must live inside the slice — that is why these two
    // gates match message stems rather than the rule tag.
    expect(breachClass(BLOCKED_NEEDS_TYPED_AWAIT.slice(0, 300))).toBe("gate:blocked-needs-typed-await");
    expect(breachClass(MALFORMED_AWAIT_EVENT.slice(0, 300))).toBe("gate:malformed-await-event");
  });

  it("a typed-await gate storm raises ONE breach card under its own class", () => {
    const storm = (reason: string, task: string) =>
      [0, 1, 2].map((n) => ({ ts: 2_000_000 + n * 60_000, task, op: "transition_rejected", reason }));
    const malformed = detectBreaches(storm(MALFORMED_AWAIT_EVENT, "BR#3738A"), new Set());
    expect(malformed).toHaveLength(1);
    expect(malformed[0].klass).toBe("gate:malformed-await-event");
    const blockedNeeds = detectBreaches(storm(BLOCKED_NEEDS_TYPED_AWAIT, "BR#3738B"), new Set());
    expect(blockedNeeds).toHaveLength(1);
    expect(blockedNeeds[0].klass).toBe("gate:blocked-needs-typed-await");
  });
});

// ---------- seeded random walk: legal sequences preserve invariants ----------

describe("random walk (seeded)", () => {
  it("decide() total over 500 arbitrary inputs; legal walks stay invariant-clean", async () => {
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T,>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)];
    const TAG_POOL = [[], ["gtm"], ["role:review"], ["question"], ["deploy-train"]];
    const STATUSES = Object.keys(LIFECYCLES.task);
    for (let n = 0; n < 500; n++) {
      const i = input({
        tags: pick(TAG_POOL),
        status: pick(STATUSES),
        to: pick(STATUSES),
        actor: pick(["agent-x", "system:watchdog", "web:ray"]),
        body: rand() > 0.5 ? { note: "PR https://x/pull/1", unblock_condition: "u", awaiting_ask_id: "ASK-1" } : {},
        meta: rand() > 0.5 ? { session: "session-a", blocked: { reason: "r", unblock_condition: "u" } } : {},
      });
      let v: Awaited<ReturnType<typeof decide>> | null = null;
      try {
        v = await decide(i, baseCtx());
      } catch (e) {
        expect.fail(`decide() threw on ${JSON.stringify(i)}: ${e}`);
      }
      if (v && v.ok && i.type === "task" && !i.body?.awaiting_ask_id) {
        // an allowed transition must land the artefact in an invariant-clean state
        const meta = { ...(i.meta ?? {}), blocked: v.status === "blocked" ? { reason: "r", unblock_condition: "u" } : undefined };
        const violations = invariants({ type: "task", status: v.status, roles: i.roles, tags: i.tags, meta });
        if (v.status !== "in_review" || !["review", "unblock"].includes(effectiveRole(i.roles))) {
          expect(violations, `legal move ${(i.roles ?? []).join(",") || "plain"} ${i.status}→${i.to} broke invariants: ${violations.join("; ")}`).toEqual([]);
        }
      }
    }
  });
});

// ---------- BR#2983: tags are inert; roles + type carry the system meaning ----------

describe("tag inertness (BR#2983)", () => {
  it("a task TAGGED 'role:review' with no roles is plain — tags cannot gate", async () => {
    const i = input({ tags: ["role:review"], roles: [] });
    expect(effectiveRole(i.roles)).toBe("plain");
    // plain tasks MAY enter in_review (verify tasks may not)
    expect(await check(input({ tags: ["role:review"], roles: [], status: "in_progress", to: "in_review", body: { note: "PR https://x/1" } }), baseCtx())).toBeNull();
  });

  it("roles: [review] makes a verify task — in_review is its own terminal", async () => {
    const msg = await check(input({ roles: ["review"], status: "in_progress", to: "in_review", body: { note: "PR https://x/1" } }), baseCtx());
    expect(msg).toContain("verify");
  });

  it("question is a TYPE, not a tag — tagged-but-typed-task is claimable", async () => {
    expect(await check(input({ type: "task", tags: ["question"], to: "in_progress" }), baseCtx())).toBeNull();
    const msg = await check(input({ type: "question", to: "in_progress" }), baseCtx());
    expect(msg).toMatch(/answered, not claimed|not allowed/);
  });

  it("question invariants: in_progress on a question is a breach", () => {
    expect(invariants({ type: "question", status: "in_progress", meta: {} }).length).toBeGreaterThan(0);
    expect(invariants({ type: "question", status: "todo", meta: {} })).toEqual([]);
  });
});

// BR#4067 — queue-slot durability: a machine silence-release must never
// destroy merge-train state (the PR #257 class: verify accepted, watchdog
// released the queued card to todo, nothing re-queued it).
describe("release-holds-train-queue (BR#4067)", () => {
  const queuedMeta = {
    merge_train: { state: "queued", pr: 257, repo: "state-vector/bridge" },
    pr: { repo: "state-vector/bridge", number: 257, head_sha_at_acceptance: "a".repeat(40) },
  };

  it("system actor releasing a queued card is refused with the proxy named", async () => {
    const msg = await check(input({ status: "blocked", to: "todo", actor: "system:watchdog", meta: queuedMeta as any }), baseCtx());
    expect(msg).toMatch(/merge-train queued.*pr_merged/s);
  });

  it("awaiting-ci holds too", async () => {
    const msg = await check(input({ status: "blocked", to: "todo", actor: "hub:proxy-watch", meta: { ...queuedMeta, merge_train: { state: "awaiting-ci" } } as any }), baseCtx());
    expect(msg).toMatch(/merge-train awaiting-ci/);
  });

  it("bounced holds too — the release that destroyed BR#4067 itself (in_progress, train-bounced, silent)", async () => {
    const bounced = {
      merge_train: { state: "bounced", pr: 259, repo: "state-vector/bridge", bounce_kind: "conflict" },
      pr: { repo: "state-vector/bridge", number: 259 },
    };
    const msg = await check(input({ status: "in_progress", to: "todo", actor: "system:watchdog", meta: bounced as any }), baseCtx());
    expect(msg).toMatch(/merge-train bounced \(typed await pr_merged state-vector\/bridge#259\)/);
  });

  it("a typed await_event holds — the proxy watch owns the exit, not the sweep", async () => {
    const msg = await check(input({
      status: "blocked", to: "todo", actor: "system:watchdog",
      meta: { blocked: { reason: "parked", await_event: { event: "pr_merged", repo: "state-vector/bridge", n: 257 } } },
    } as any), baseCtx());
    expect(String(msg)).toMatch(/typed await_event \(pr_merged\).*machine release must not destroy the wait/s);
  });

  it("a bound ask holds — the answer owns the exit", async () => {
    const msg = await check(input({
      status: "blocked", to: "todo", actor: "system:reaper",
      meta: { blocked: { reason: "parked" }, awaiting_ask: { ask_id: "ASK-1" } },
    } as any), baseCtx());
    expect(String(msg)).toMatch(/bound ask \(ASK-1\).*machine release must not destroy the wait/s);
  });

  it("humans and owners release freely — the guard is machine-actor only", async () => {
    const msg = await check(input({ status: "blocked", to: "todo", actor: "web:rayh", owner: "web:rayh", meta: queuedMeta as any }), baseCtx());
    expect(typeof msg === "string" ? msg : "").not.toMatch(/release-holds-train-queue|merge-train queued/);
  });

  it("humans also release silent in_progress train cards freely (rule-9)", async () => {
    const msg = await check(input({ status: "in_progress", to: "todo", actor: "some-agent", meta: queuedMeta as any }), baseCtx());
    expect(typeof msg === "string" ? msg : "").not.toMatch(/release-holds/);
  });

  it("a blocked card with NO train state releases as before", async () => {
    const msg = await check(input({ status: "blocked", to: "todo", actor: "system:watchdog", meta: { blocked: { reason: "parked" } } as any }), baseCtx());
    expect(typeof msg === "string" ? msg : "").not.toMatch(/merge-train/);
  });

  it("a silent in_progress card with no machine wait releases as before (the sweeps own the todo path)", async () => {
    const msg = await check(input({ status: "in_progress", to: "todo", actor: "system:watchdog", meta: { last_progress: { ts: 1 } } as any }), baseCtx());
    expect(typeof msg === "string" ? msg : "").not.toMatch(/release-holds/);
  });
});
