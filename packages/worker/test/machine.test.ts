import { describe, it, expect } from "vitest";
import {
  RULES,
  check,
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
      const i = input({ status: c.from, to: c.to, tags: c.role === "plain" ? [] : [`role:${c.role}`] });
      const v = await decide(i, baseCtx());
      expect(["boolean", "object"]).toContain(typeof v.ok);
      if (v.ok) {
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

  it("impl blocked requires reason AND unblock condition; blocked release requires resolution", async () => {
    expect(await check(input({ status: "in_progress", to: "blocked", body: { note: "why" } }), baseCtx())).toContain("BOTH a reason");
    expect(
      await check(input({ status: "in_progress", to: "blocked", body: { note: "why", unblock_condition: "when X" } }), baseCtx()),
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

  it("BR#909 shape: impl blocking WITH direction is legal; unblock child on verdict duty is refused at link-time elsewhere", async () => {
    expect(
      await check(input({ status: "in_progress", to: "blocked", body: { note: "needs direction", unblock_condition: "wire X per design" } }), baseCtx()),
    ).toBeNull();
  });

  it("every rule has a name and the set is stable (table drift alarm)", () => {
    expect(RULES.map((r) => r.name).sort()).toEqual(
      [
        "bounce-needs-findings",
        "blocked-needs-path",
        "claim-bars",
        "claim-separation-of-duties",
        "decision-acceptance-human",
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
    if (!v.ok) {
      expect(v.code).toBe("guard-failed");
      expect(v.rule).toBe("release-needs-ownership");
    }
    // the owner, a human, or the machinery may release
    expect((await decide(input({ status: "in_progress", to: "todo", owner: "agent-x", actor: "agent-x" }), baseCtx())).ok).toBe(true);
    expect((await decide(input({ status: "in_progress", to: "todo", owner: "agent-x", actor: "web:ray" }), baseCtx())).ok).toBe(true);
    expect((await decide(input({ status: "in_progress", to: "todo", owner: "agent-x", actor: "system:watchdog" }), baseCtx())).ok).toBe(true);
  });
});

// ---------- the executor contract (BR#2419 item 2 / bounce finding F4) ----------

describe("executor contract: Applied(effects) | Rejection{code,rule,message}", () => {
  it("illegal edges are typed illegal-edge with rule 'lifecycle'", async () => {
    const v = await decide(input({ status: "todo", to: "done" }), baseCtx());
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe("illegal-edge");
      expect(v.rule).toBe("lifecycle");
      expect(v.message).toContain("not allowed");
    }
  });

  it("guard failures are typed guard-failed and name the table row", async () => {
    const v = await decide(input({ status: "in_progress", to: "in_review", body: { note: "no link" } }), baseCtx());
    expect(v.ok).toBe(false);
    if (!v.ok) {
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
    if (!v.ok) expect(v.rule).toBe("verdict-done-needs-receipts");
    // a review task blocked without any note: verdict-no-blocked (the carve-out rule)
    // sits before blocked-needs-path — the loop class dies at the FIRST gate
    const v2 = await decide(input({ status: "in_progress", to: "blocked", roles: ["review"], body: {} }), baseCtx());
    expect(v2.ok).toBe(false);
    if (!v2.ok) expect(v2.rule).toBe("verdict-no-blocked");
    // an illegal edge on a verdict task reports the lifecycle, not the table
    const v3 = await decide(input({ status: "todo", to: "done", roles: ["review"] }), baseCtx());
    if (!v3.ok) expect(v3.code).toBe("illegal-edge");
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
    const v = ok(
      await decide(input({ status: "in_progress", to: "blocked", body: { note: "why", unblock_condition: "when X lands" } }), baseCtx()),
    );
    expect(v.effects).toEqual([{ kind: "spawn_unblock", parent: "BR#1", reason: "why", exit_condition: "when X lands" }]);

    const capped = baseCtx();
    capped.openUnblockChild = () => ({ id: "BR#50" });
    const v2 = ok(
      await decide(input({ status: "in_progress", to: "blocked", body: { note: "why", unblock_condition: "when X lands" } }), capped),
    );
    expect(v2.effects).toEqual([{ kind: "skip_unblock_spawn", parent: "BR#1", reason: "existing unblock child BR#50 reused" }]);

    const flooded = input({
      status: "in_progress",
      to: "blocked",
      body: { note: "why", unblock_condition: "when X lands" },
      meta: { last_unblock_spawn: { at: 1_000_000 - 10 * 60_000, exit: "when X lands" } }, // 10m ago, same exit
    });
    const v3 = ok(await decide(flooded, baseCtx()));
    expect(v3.effects[0].kind).toBe("skip_unblock_spawn");
    expect((v3.effects[0] as any).reason).toContain("flood guard");

    // a DIFFERENT exit condition is a new round, not a flood repeat
    const freshExit = input({
      status: "in_progress",
      to: "blocked",
      body: { note: "why", unblock_condition: "when Y lands" },
      meta: { last_unblock_spawn: { at: 1_000_000 - 10 * 60_000, exit: "when X lands" } },
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
    if (!unblockDuty.ok) expect(unblockDuty.rule).toBe("verdict-no-blocked");
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

  it("plain releases clear the owner and stamp the attempt (roles_v1: no system tag writes)", async () => {
    const v = ok(await decide(input({ status: "in_progress", to: "todo", body: { note: "context switch" } }), baseCtx()));
    expect(v.owner_clear).toBe(true);
    expect(v.tags_add).toEqual([]);
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

  // ported from the BR#2404 churnRelease suite (the pure function is decide()'s
  // release branch now — same counter, one source):
  it("at the overlap a verdict duty escalates — escalate wins over redirect", async () => {
    const v = ok(await released(CHURN_REDIRECT_ATTEMPTS - 1, ["review"])); // +1 = 5: both bars met
    expect(v.effects[0].kind).toBe("escalate");
    expect(v.status).toBe("todo"); // NOT redirected into blocked
  });

  it("releasing an already-blocked task never re-redirects (deliberate unblock)", async () => {
    const v = ok(await decide(
      input({ status: "blocked", to: "todo", roles: [], meta: { attempt: { by: "agent-x", at: 1, attempts: CHURN_REDIRECT_ATTEMPTS }, blocked: { reason: "r", unblock_condition: "u", ts: 1 } }, actor: "system:watchdog" }),
      baseCtx(),
    ));
    expect(v.status).toBe("todo"); // pass-through: no redirect
    expect(v.effects.map((e) => e.kind)).not.toContain("release_redirect");
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
    expect(replayStatus("", log)).toEqual({ status: "done", ok: true });
    // a fold that disagrees with the stored state is the mismatch breach class
    const fold = replayStatus("", log);
    expect(fold.status !== "in_review" && fold.ok).toBe(true); // stored in_review would mismatch
  });

  it("flags a broken chain (forged / out-of-order history)", () => {
    const broken = [t("todo", "in_progress"), t("in_review", "done")]; // jump: in_progress ≠ in_review
    expect(replayStatus("", broken)).toEqual({ status: "in_progress", ok: false });
  });

  it("ignores non-transition events and tolerates subprocess self-loops", () => {
    const log = [
      { action: "create", data: {} },
      { action: "progress", data: {} },
      t("todo", "in_progress"),
      { action: "transition", data: { from: "in_progress", to: "in_progress", class: "subprocess" } }, // declared silence
      t("in_progress", "in_review"),
    ];
    expect(replayStatus("", log)).toEqual({ status: "in_review", ok: true });
  });

  it("an empty log folds to nothing — no false mismatch on fresh artefacts", () => {
    expect(replayStatus("", [])).toEqual({ status: "", ok: true });
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
    expect(breachClass("something novel")).toBe("other");
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
