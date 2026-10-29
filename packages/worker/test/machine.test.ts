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
  CHURN_COOLDOWN_MS,
  CHURN_ESCALATE_ATTEMPTS,
  CHURN_REDIRECT_ATTEMPTS,
  SILENT_ESCALATE_CYCLES,
  SILENT_REDIRECT_CYCLES,
  blockedParkVerdict,
  UNBLOCK_SPAWN_CAP,
  type RuleCtx,
  type RuleInput,
  type Applied,
} from "../src/kb/machine.ts";
import {
  decideProseDisposition,
  proseAlarmAskTitle,
  proseClassAskTitle,
  proseLegAwaitEvent,
  PROSE_CLASS_QUIET_MS,
  type ProseDispositionInput,
  type ProseLegVerdict,
} from "../src/kb/core.ts";
import { AWAIT_GRAMMAR_DOC, validateAwaitEvent } from "../src/kb/closure.ts";
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
  openChildIds: () => [],
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

  it("BR#3819: force-close passes only when EVERY open child is named, with a reason", async () => {
    const c = baseCtx();
    c.openChildren = () => 2;
    c.openChildIds = () => ["BR#12", "BR#13"];
    // complete + reasoned → the gate passes (do.ts logs the repair)
    expect(
      await check(input({ status: "in_review", to: "done", roles: ["analysis"], body: { note: "force-close-children: BR#12, BR#13 — self-edge made these unclosable; repaired per BR#3819" } }), c),
    ).toBeNull();
    // partial list → refused, naming the missing child
    const partial = await check(input({ status: "in_review", to: "done", roles: ["analysis"], body: { note: "force-close-children: BR#12 — some reason" } }), c);
    expect(partial).toContain("missing: BR#13");
    // no reason → refused with the grammar
    const noReason = await check(input({ status: "in_review", to: "done", roles: ["analysis"], body: { note: "force-close-children: BR#12, BR#13" } }), c);
    expect(noReason).toContain("force-close-children");
    // no marker at all → the ordinary open-children refusal, teaching the grammar
    const plain = await check(input({ status: "in_review", to: "done", roles: ["analysis"], body: { note: "done" } }), c);
    expect(plain).toContain("force-close-children");
    // zero open children → passes without any marker (self-edge-only state reads as clean)
    const clean = baseCtx();
    clean.openChildren = () => 0;
    expect(
      await check(input({ status: "in_review", to: "done", roles: ["analysis"], body: { note: "done" } }), clean),
    ).toBeNull();
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

  it("BR#3986: a multi-atom conjunction text park is refused loud, naming every atom", async () => {
    const rej = await check(
      input({ status: "in_progress", to: "blocked", body: { note: "waiting", unblock_condition: "BR#3945 done AND BR#3946 done" } }),
      baseCtx(),
    );
    expect(rej).toBeTruthy();
    expect(String(rej)).toContain("2 machine atoms");
    expect(String(rej)).toContain("BR#3945");
    expect(String(rej)).toContain("BR#3946");
    expect(breachClass(String(rej))).toBe("gate:multi-atom-condition");
  });

  it("BR#4303: the multi-atom refusal names every atom in SHORT form inside the 300-char audit budget", async () => {
    // Two atoms on DIFFERENT long lines. With raw (line-slice) formatting the
    // message spent the do.ts .slice(0, 300) audit budget on atom 1's line —
    // the audit trail and the breach fold never showed the second leg to
    // drop, and the rejected author blind-retries the same park (the
    // BR#4301 verifier loop). Short descriptors keep every atom inside the
    // slice.
    const line1 =
      "Machine proxy (typed await_event br_done id=BR#4291): BR#4291 done — the unblock duty lands its receipts-shaped →done close (drop-in note already on the card,";
    const line2 =
      "Machine proxy (typed await_event pr_merged repo=state-vector/bridge n=282): PR state-vector/bridge#282 merges (mergeCommit non-null) AND main CI green after the train lands it.";
    expect(line1.length).toBeGreaterThan(120);
    expect(line2.length).toBeGreaterThan(120);
    const rej = await check(
      input({ status: "in_progress", to: "blocked", body: { note: "waiting", unblock_condition: `${line1}\n${line2}` } }),
      baseCtx(),
    );
    expect(rej).toBeTruthy();
    const reason = String(rej).slice(0, 300); // the do.ts audit budget
    expect(reason).toContain("2 machine atoms");
    expect(reason).toContain("BR#4291 done");
    expect(reason).toContain("PR state-vector/bridge#282 merged");
    expect(breachClass(String(rej))).toBe("gate:multi-atom-condition");
  });

  it("BR#3986: a park awaiting its own done is refused — explicit AND text-derived (the BR#136 deadlock)", async () => {
    const explicit = await check(
      input({ id: "BR#136", status: "in_progress", to: "blocked", body: { note: "x", await_event: { event: "br_done", id: "BR#136" } } }),
      baseCtx(),
    );
    expect(explicit).toBeTruthy();
    expect(String(explicit)).toContain("self-referential");
    expect(breachClass(String(explicit))).toBe("gate:self-referential-await");
    // the text shim derives {br_done, BR#136} from prose — same refusal
    const derived = await check(
      input({ id: "BR#136", status: "in_progress", to: "blocked", body: { note: "x", unblock_condition: "then the sweep transitions BR#136 done" } }),
      baseCtx(),
    );
    expect(derived).toBeTruthy();
    expect(String(derived)).toContain("self-referential");
    // another card's br_done still passes the single-atom text shim
    expect(
      await check(input({ id: "BR#3557", status: "in_progress", to: "blocked", body: { note: "x", unblock_condition: "BR#3945 done" } }), baseCtx()),
    ).toBeNull();
  });

  it("BR#4062: EVERY closed-set atom parks through the gate — typed param AND machine-proxy prose", async () => {
    const cases: { label: string; ev: Record<string, unknown>; prose: string }[] = [
      {
        label: "pr_merged", ev: { event: "pr_merged", repo: "state-vector/bridge", n: 253 },
        prose: "Machine proxy (typed await_event pr_merged repo=state-vector/bridge n=253): PR https://github.com/state-vector/bridge/pull/253 merges (mergeCommit non-null) AND main CI green after.",
      },
      {
        label: "br_pr_merged", ev: { event: "br_pr_merged", id: "BR#4015" },
        prose: "Machine proxy (typed await_event br_pr_merged id=BR#4015): the card's fix PR lands on the train.",
      },
      {
        label: "issue_closed", ev: { event: "issue_closed", repo: "state-vector/superpositional", n: 1258 },
        prose: "Machine proxy (typed await_event issue_closed repo=state-vector/superpositional n=1258): the upstream report closes after the operator purge.",
      },
      {
        label: "br_done", ev: { event: "br_done", id: "BR#3819" },
        prose: "Machine proxy (typed await_event br_done id=BR#3819): BR#3819 done.",
      },
      {
        label: "run_success", ev: { event: "run_success", repo: "state-vector/bridge", run_id: "403581" },
        prose: "Machine proxy (typed await_event run_success repo=state-vector/bridge run_id=40358175346): the nightly completes green after the deploy.",
      },
      {
        label: "pr_checks_green", ev: { event: "pr_checks_green", repo: "state-vector/bridge", n: 257 },
        prose: "Machine proxy (typed await_event pr_checks_green repo=state-vector/bridge n=257): every check settles on the head.",
      },
      {
        label: "deployed", ev: { event: "deployed", commit: "5d53c1e" },
        prose: "Machine proxy (typed await_event deployed commit=5d53c1e): the hub serves this commit.",
      },
      {
        label: "ask", ev: { event: "ask", ask_id: "BR#4061" },
        prose: "Machine proxy (typed await_event ask ask_id=BR#4061): re-entry waits on the ruling.",
      },
      {
        label: "time", ev: { event: "time", until_ts: 1793673600000 },
        prose: "Machine proxy (typed await_event time until_ts=1793673600000): the card re-enters at the timer.",
      },
    ];
    for (const c of cases) {
      expect(
        await check(input({ status: "in_progress", to: "blocked", body: { note: "parked", await_event: c.ev } }), baseCtx()),
        `typed param: ${c.label}`,
      ).toBeNull();
      expect(
        await check(input({ status: "in_progress", to: "blocked", body: { note: "parked", unblock_condition: c.prose } }), baseCtx()),
        `prose shim: ${c.label}`,
      ).toBeNull();
    }
  });

  it("BR#4062 repro: the takeover session's verbatim rejected parks now pass", async () => {
    // {event:"time"} epoch-ms — REJECTED from MCP on 2026-10-28, must pass
    expect(
      await check(input({ id: "BR#2637", status: "in_progress", to: "blocked", body: {
        note: "parked on a typed timer for the fresh-verify render",
        unblock_condition: "Machine proxy (typed await_event time until_ts=1793673600000): Machine proxy (typed await_event time until_ts=1793673600000): the fresh-verify render gate re-parks the card → then a FRESH session closes BR#2637 done citing the render.",
      } }), baseCtx()),
    ).toBeNull();
    // ISO variant — the prose shim normalizes ISO until_ts to epoch ms
    expect(
      await check(input({ id: "BR#2637", status: "in_progress", to: "blocked", body: {
        note: "parked on a typed timer",
        unblock_condition: "Machine proxy (typed await_event time until_ts=2026-11-04T00:00:00Z): re-entry at the render slot.",
      } }), baseCtx()),
    ).toBeNull();
    // {event:"ask"} bound to an OPEN ask — REJECTED from MCP on 2026-10-28, must pass
    expect(
      await check(input({ id: "BR#2637", status: "in_progress", to: "blocked", body: {
        note: "parked on the ruling",
        unblock_condition: "Machine proxy (typed await_event ask ask_id=BR#4061): Machine proxy (typed await_event ask ask_id=BR#4061): Ask BR#4061 answered → the board task re-enters the pool when unblocked.",
      } }), baseCtx()),
    ).toBeNull();
    // the pr_merged control that already passed stays passing (no multi-atom regression)
    expect(
      await check(input({ id: "BR#3935", status: "in_progress", to: "blocked", body: {
        note: "parked on the merge",
        unblock_condition: "Machine proxy (typed await_event pr_merged repo=state-vector/bridge n=253): PR https://github.com/state-vector/bridge/pull/253 merges (mergeCommit non-null) AND main CI green after. Serialized merge train merges #253 at head.",
      } }), baseCtx()),
    ).toBeNull();
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
        "supersede-authority",
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

  it("BR#3913 shape: blocked → superseded exists, but only an answered ask (the dispatch actor) or a human may drop a card", async () => {
    // the edge is real: the askAnswer SUPERSEDE dispatch acts as system:question(<answerer>)
    const v = ok(
      await decide(input({ status: "blocked", to: "superseded", actor: "system:question(web:rayh)", body: { note: "ask BR#3909 answered — dropped" } }), baseCtx()),
    );
    expect(v.status).toBe("superseded");
    // a dropped parent's ephemeral rounds close with it
    expect(v.effects).toContainEqual({ kind: "supersede_children", parent: "BR#1", tag: "unblock", keep_newest: false, cause: "BR#1 → superseded — unblock round closed" });
    expect(v.effects).toContainEqual({ kind: "supersede_children", parent: "BR#1", tag: "review", keep_newest: false, cause: "BR#1 superseded — verification round closed" });
    // web and human actors pass (the same exemption release-ownership uses)
    expect((await decide(input({ status: "blocked", to: "superseded", actor: "web:rayh" }), baseCtx())).ok).toBe(true);
    expect((await decide(input({ status: "blocked", to: "superseded", actor: "human:rayh" }), baseCtx())).ok).toBe(true);
    // a bare agent session is refused — dropping work is a human-authority act (BR#2480)
    const v2 = await decide(input({ status: "blocked", to: "superseded", actor: "agent-x" }), baseCtx());
    expect(v2.ok).toBe(false);
    if (v2.ok === false) {
      expect(v2.code).toBe("guard-failed");
      expect(v2.rule).toBe("supersede-authority");
      expect(v2.message).toContain("human-authority act");
    }
    // BR#2508 held the line elsewhere: todo/in_review/done stay closed to superseded
    expect(await check(input({ status: "todo", to: "superseded", actor: "web:rayh" }), baseCtx())).toContain("not allowed");
    expect(await check(input({ status: "in_review", to: "superseded", actor: "web:rayh" }), baseCtx())).toContain("not allowed");
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

  it("non-task artefacts carry no effects — except a decision's consensus-round close (BR#903)", async () => {
    // a decision resolving (superseded here) closes its auto-spawned feedback
    // round: exactly one supersede_children effect, tag "question" — the round
    // informed the human, it never gated them
    const v = ok(await decide(input({ type: "decision", status: "proposed", to: "superseded", actor: "web:ray" }), baseCtx()));
    expect(v.effects).toEqual([
      { kind: "supersede_children", parent: "BR#1", tag: "question", keep_newest: false, cause: "BR#1 superseded — consensus round closed (the human decided; the round informed, it never gated)" },
    ]);
    // every other non-task type stays effect-free
    const steering = ok(await decide(input({ type: "steering", status: "draft", to: "active", actor: "web:ray" }), baseCtx()));
    expect(steering.effects).toEqual([]);
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
    // BR#4282: a flood skip is the dedup WORKING, not a spawn attempt — the
    // flag lets the executor audit it without folding a breach card.
    expect((v3.effects[0] as any).flood).toBe(true);
    // the CAP skip is a different beast — a live child owns the round
    expect((v2.effects[0] as any).flood).toBeUndefined();

    // a DIFFERENT exit condition is a new round, not a flood repeat
    const freshExit = input({
      status: "in_progress",
      to: "blocked",
      body: { note: "why", unblock_condition: "PR https://github.com/a/b/pull/10 merged" },
      meta: { last_unblock_spawn: { at: 1_000_000 - 10 * 60_000, exit: "PR https://github.com/a/b/pull/9 merged" } },
    });
    expect(ok(await decide(freshExit, baseCtx())).effects[0].kind).toBe("spawn_unblock");
  });

  it("a resume CONSUMES the unblock round — the stamp clears so post-resume silence issues a fresh round (BR#4282)", async () => {
    const stamp = { at: 1_000_000 - 10 * 60_000, exit: "PR https://github.com/a/b/pull/9 merged" };
    // blocked → in_progress: the duty verified the exit and moved the card —
    // the round is spent; a stale stamp would flood-guard the OWNED done-close
    // round the card now owes for the next 60m.
    const resumed = ok(await decide(
      input({ status: "blocked", to: "in_progress", body: { note: "exit condition verified — resuming" }, meta: { last_unblock_spawn: stamp } }),
      baseCtx(),
    ));
    expect(resumed.meta_patch.last_unblock_spawn).toBeUndefined();
    // any other edge leaves the stamp alone — the patch is the only channel
    // that deletes it, so a park patch must not mention the key: an
    // UNCONSUMED round still dedups.
    const parked = ok(await decide(
      input({ status: "in_progress", to: "blocked", body: { note: "why", unblock_condition: "PR https://github.com/a/b/pull/10 merged" }, meta: { last_unblock_spawn: stamp } }),
      baseCtx(),
    ));
    expect("last_unblock_spawn" in parked.meta_patch).toBe(false);
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

  it("merge-train parks never spawn unblock children — the train's flag OR the agent re-queue's canonical note (BR#4135)", async () => {
    // BR#3516 §2: the train itself is the unblock path; a spawned child
    // would race the executor's CAS lease. The train's own park carries the
    // typed flag —
    const trainPark = ok(
      await decide(
        input({
          status: "in_progress",
          to: "blocked",
          body: { note: "queued on the merge train", merge_train: true, unblock_condition: "PR https://github.com/a/b/pull/9 merged" },
        }),
        baseCtx(),
      ),
    );
    expect(trainPark.effects).toEqual([]);
    // — while agent re-parks follow the verify-duty contract, which marks the
    // park in the note. Specimen BR#3990 rounds 4→6: the note flavor was
    // missed, so every re-queue spawned an unblock child the next bounce
    // superseded and the re-park after it flood-guarded — one breach card
    // (BR#4135) per bounce cycle.
    const agentRequeue = ok(
      await decide(
        input({
          status: "in_review",
          to: "blocked",
          body: { note: "merge-train: queued — verify RE-ACCEPT at the unchanged live head", unblock_condition: "PR https://github.com/a/b/pull/9 merged" },
        }),
        baseCtx(),
      ),
    );
    expect(agentRequeue.effects).toEqual([]);
    // any merge-train note flavor counts on a blocked park (bounce KINDs, BR#4066)
    const stopped = ok(
      await decide(
        input({
          status: "in_progress",
          to: "blocked",
          body: { note: "merge-train: stopped — lane halted", unblock_condition: "PR https://github.com/a/b/pull/11 merged" },
        }),
        baseCtx(),
      ),
    );
    expect(stopped.effects).toEqual([]);
    // the suppression is SCOPED to the spawn gate: a plain park with the same
    // exit condition still spawns its unblock round
    const plain = ok(
      await decide(
        input({
          status: "in_progress",
          to: "blocked",
          body: { note: "why", unblock_condition: "PR https://github.com/a/b/pull/9 merged" },
        }),
        baseCtx(),
      ),
    );
    expect(plain.effects[0].kind).toBe("spawn_unblock");
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

  it("BR#4248: the redirect park carries a grammar-valid typed time atom (24h cooldown) — prose is annotation only", async () => {
    const v = ok(await released(CHURN_REDIRECT_ATTEMPTS - 1));
    const aw = (v.meta_patch.blocked as any)?.await_event;
    expect(aw).toEqual({ event: "time", until_ts: 1_000_000 + CHURN_COOLDOWN_MS }); // input() pins now = 1_000_000
    expect(validateAwaitEvent(aw)?.event).toBe("time"); // the door grammar accepts it — sweep-consumable
    // the prose stays as the human-readable annotation, never the exit condition
    expect((v.meta_patch.blocked as any).unblock_condition).toContain("re-claim");
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
    // BR#4248: the silent-cycle redirect parks typed too — no prose path
    expect(validateAwaitEvent((v.meta_patch.blocked as any)?.await_event)?.event).toBe("time");
  });

  it("BR#4248: a proven-unblock release after the timer fires resets the counter — the fresh start never re-trips the guard", async () => {
    const v = ok(
      await decide(
        input({
          status: "blocked",
          to: "todo",
          roles: ["unblock"],
          owner: "someone-else", // the parked card's claim is not the duty's — the proven-unblock exemption covers it
          meta: { attempt: { by: "system:watchdog", at: 1, attempts: CHURN_REDIRECT_ATTEMPTS, last_reason: "churn guard: released to the pool 5 times without completing" } },
          actor: "unblock-duty",
          body: { note: "cooldown timer elapsed — live re-check first-hand: the exit condition holds (probe receipt). Releasing." },
        }),
        { ...baseCtx(), recentEvents: () => [] },
      ),
    );
    expect(v.status).toBe("todo"); // released — not re-parked, not escalated
    expect(v.owner_clear).toBe(true);
    expect(v.meta_patch.attempt).toBeUndefined(); // fresh start: the counter is deleted, not incremented
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
  const BLOCKED_NEEDS_TYPED_AWAIT = `moving to blocked requires a typed await_event — ${AWAIT_GRAMMAR_DOC}. Pass it as the transition's await_event param (bridge_transition takes it directly; until_ts is epoch ms), or cite it in prose as "typed await_event <event> key=value" (BR#4062), or bind an ask via ask_agent — the human leg. Free text alone is annotation, never an exit condition (BR#3578) [rule: blocked-needs-typed-await]`;
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

// ---------- BR#4295: the verdict-done receipts gate — its own class, an honest message ----------

describe("verdict-receipts gate classification + note shape (BR#4295)", () => {
  // Specimen BR#4291 (breach card BR#4294, sample verbatim): the rejection as
  // the audit stores it — the guard's message plus the " [rule: …]" suffix
  // do.ts appends to every gate rejection, well under the 300-char slice.
  // The holder's closing note was honest findings prose (quoted
  // still 'blocked', "NO_UNBLOCK", no URL) → zero hasReceipts matches →
  // 3 rejections in 18s, every one folded as gate:review-needs-pr because
  // the gate's OWN message embeds "PR link" and breachClass tested that
  // stem first — the dedicated class was unreachable for its own gate.
  const VERDICT_RECEIPTS_REJECTION =
    "unblock BR#4291 cannot complete without receipts — cite what you verified in the note (PR link, merge state, the check you ran, or the unblock verdict). [rule: verdict-done-needs-receipts]";

  it("classifies receipts rejections under their OWN class — the audited rule tag wins over the message's 'pr link' stem", () => {
    expect(breachClass(VERDICT_RECEIPTS_REJECTION)).toBe("gate:verdict-receipts");
    expect(breachClass(VERDICT_RECEIPTS_REJECTION.slice(0, 300))).toBe("gate:verdict-receipts"); // survives the audit slice
  });

  it("maps the tagged gates suffix-first; the message ladder stays the fallback for suffix-less legacy reasons", () => {
    expect(
      breachClass("moving to in_review requires the PR link in the note (you stay owner until the verdict — done requires review acceptance, not your call) [rule: review-needs-pr]"),
    ).toBe("gate:review-needs-pr");
    expect(
      breachClass("task BR#3372 is claimed by mac-modem-opencode — only the owner, a human, or an unblock duty holding proof of the met exit condition can release it. [rule: release-needs-ownership]"),
    ).toBe("claim_race");
    // suffix-less legacy reason → message stem, unchanged
    expect(breachClass("review BR#1 cannot complete without receipts")).toBe("gate:verdict-receipts");
  });

  it("BR#4563: BR#4067 release-hold refusals classify as the held-flow family, not unclassified", () => {
    // the exact audited reason shape on specimen TASK-016 (breach card BR#4563)
    const typedAwaitHold =
      "card parks on a typed await_event (pr_merged) — the proxy watch / the answer owns the exit; a machine release must not destroy the wait (BR#4067). Wait it out or let a human/owner release. [rule: release-holds-typed-await]";
    expect(breachClass(typedAwaitHold)).toBe("release:held-typed-await");
    // the tag sliced off by the audit trail's 300-char reason slice still
    // classifies — the rule identifier rides inside the message body too
    expect(breachClass(typedAwaitHold.slice(0, 300))).toBe("release:held-typed-await");
    // the train-queue sibling (specimens BR#3727/BR#4068, cards BR#4573/BR#4578)
    const trainQueueHold =
      "card is merge-train bounced (typed await pr_merged state-vector/bridge#227) — the train owns delivery; a machine silence-release must not destroy the queue slot. Wait out the proxy (pr_merged flip closes it) or re-queue explicitly; do not release to the pool. [rule: release-holds-train-queue]";
    expect(breachClass(trainQueueHold)).toBe("release:held-train-queue");
    expect(breachClass(trainQueueHold.slice(0, 300))).toBe("release:held-train-queue");
  });

  it("the guard's rejection teaches the shape hasReceipts actually accepts", async () => {
    const msg = await check(input({ status: "in_progress", to: "done", roles: ["unblock"], body: { note: "verdict NO_UNBLOCK, still 'blocked'" } }), baseCtx());
    expect(msg).toContain("cannot complete without receipts");
    expect(msg).toContain("URL"); // a bare URL suffices
    expect(msg).toContain("still blocked"); // the exact token — quoted 'blocked' or "unblock verdict" never match
  });

  it("hasReceipts accepts a URL and the bare verdict tokens; near-miss prose still rejects", async () => {
    for (const note of [
      "verified: https://github.com/x/y/pull/1 merged", // any URL
      "BR#3311 still blocked — the hub proxy TRUE was the timer atom only", // bare token, exactly what BR#4291 needed
      "PR merged",
      "passed",
      "unblocked",
    ]) {
      expect(await check(input({ status: "in_progress", to: "done", roles: ["unblock"], body: { note } }), baseCtx()), `must pass: ${note}`).toBeNull();
    }
    for (const note of [
      "still 'blocked'", // quoted — not the token (the BR#4291 specimen)
      "unblock verdict: NO_UNBLOCK", // no -ed, preceded by non-space
      "the check I ran looks clean", // honest prose, zero tokens
    ]) {
      expect(await check(input({ status: "in_progress", to: "done", roles: ["unblock"], body: { note } }), baseCtx()), `must reject: ${note}`).toContain("cannot complete without receipts");
    }
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

  // BR#4494 — the bounce re-entry demote: bounced is the ONE train state the
  // train does NOT own anymore (it handed the leg back; re-entry is a fresh
  // verify/impl round), so the stall sweep may demote the STRANDED re-entry
  // (in_progress, dead executor) to a claimable todo.
  it("BR#4494 carve-out: the sweep's demote of a stranded in_progress bounced re-entry passes — flag + in_progress + bounced", async () => {
    const bounced = {
      merge_train: { state: "bounced", pr: 259, repo: "state-vector/bridge", bounce_kind: "coverage", bounced_at: 1 },
      pr: { repo: "state-vector/bridge", number: 259 },
    };
    const msg = await check(input({
      status: "in_progress", to: "todo", actor: "system:watchdog", meta: bounced as any,
      body: { note: "bounce re-entry demoted (watchdog, BR#4494)", demote_bounced_reentry: true },
    }), baseCtx());
    expect(typeof msg === "string" ? msg : "").not.toMatch(/release-holds/);
  });

  it("BR#4494 carve-out stays narrow: the flag cannot free a PARKED blocked bounced card or a queued/awaiting-ci card", async () => {
    const bounced = {
      merge_train: { state: "bounced", pr: 259, repo: "state-vector/bridge", bounce_kind: "conflict" },
      pr: { repo: "state-vector/bridge", number: 259 },
    };
    // blocked park + flag → still held (only the live re-entry demotes)
    const parked = await check(input({
      status: "blocked", to: "todo", actor: "system:watchdog", meta: bounced as any,
      body: { note: "forged flag", demote_bounced_reentry: true },
    }), baseCtx());
    expect(parked).toMatch(/merge-train bounced/);
    // queued + flag → still held (live queue slot, the PR #257 class)
    const queued = await check(input({
      status: "in_progress", to: "todo", actor: "system:watchdog",
      meta: { ...bounced, merge_train: { state: "queued", pr: 259, repo: "state-vector/bridge" } } as any,
      body: { note: "forged flag", demote_bounced_reentry: true },
    }), baseCtx());
    expect(queued).toMatch(/merge-train queued/);
    // awaiting-ci + flag → still held
    const awaiting = await check(input({
      status: "in_progress", to: "todo", actor: "system:watchdog",
      meta: { ...bounced, merge_train: { state: "awaiting-ci", pr: 259, repo: "state-vector/bridge" } } as any,
      body: { note: "forged flag", demote_bounced_reentry: true },
    }), baseCtx());
    expect(awaiting).toMatch(/merge-train awaiting-ci/);
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

  it("a human's answered-ask verdict rides the system pen freely (BR#3912 typed RELEASE)", async () => {
    const msg = await check(input({
      status: "blocked", to: "todo", actor: "system:question(ray)",
      body: { human_verdict: true },
      meta: { blocked: { reason: "parked", await_event: { event: "ask", ask_id: "ASK-1" } }, awaiting_ask: { ask_id: "ASK-1" } },
    } as any), baseCtx());
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

// ---------------------------------------------------------------------------
// BR#4562 — the BR#4067 release-hold refusals classify `release_held` and
// never raise a breach. Specimen: TASK-001 parked blocked on a typed
// await_event pr_merged(state-vector/superpositional#2117); the owner-death /
// park-drain sweeps attempted the release once per tick, the guard refused,
// and the refusals folded into "unclassified" breach cards (16 cards,
// 2026-10-29). The guard succeeding is not a breach — same never-a-breach
// family as claim_race (BR#3430) — and the refusal storm itself is fixed at
// the emitter (the park-drain sweep now checks releaseHold before attempting).
// ---------------------------------------------------------------------------
describe("breachClass: release_held (BR#4562)", () => {
  const awaitHoldMeta = {
    blocked: { reason: "parked", await_event: { event: "pr_merged", repo: "state-vector/bridge", n: 257 } },
  };

  it("the typed-await hold refusal classifies from its rule tag", async () => {
    const msg = await check(input({ status: "blocked", to: "todo", actor: "system:watchdog", meta: awaitHoldMeta as any }), baseCtx());
    // do.ts audits `${verdict.message} [rule: ${verdict.rule}]` — build the
    // audited reason exactly that way (the tag survives: ~222 < 300)
    const audited = `${String(msg)} [rule: release-holds-typed-await]`;
    expect(audited.length).toBeLessThanOrEqual(300);
    // tags classify FIRST into the specific held-flow class (BR#4563); the
    // release_held umbrella is the fallback for the sliced-tag ladder
    expect(breachClass(audited)).toBe("release:held-typed-await");
  });

  it("the train-queue hold refusal classifies from its rule tag", async () => {
    const msg = await check(input({
      status: "blocked", to: "todo", actor: "system:watchdog",
      meta: {
        merge_train: { state: "queued", pr: 257, repo: "state-vector/bridge" },
        pr: { repo: "state-vector/bridge", number: 257 },
      } as any,
    }), baseCtx());
    const audited = `${String(msg)} [rule: release-holds-train-queue]`;
    expect(audited.length).toBeLessThanOrEqual(300); // short repo name — tag survives
    expect(breachClass(audited)).toBe("release:held-train-queue");
    // the raw verdict message (no tag) still classifies — the ladder stem
    expect(breachClass(String(msg))).toBe("release_held");
  });

  it("classifies even when the 300-char audit slice cuts the tag (long repo name — the live specimen shape)", () => {
    // state-vector/superpositional pushes the train-queue message to 302
    // chars: the audited reason IS the slice, tag severed mid-way (BR#3738's
    // AWAIT_GRAMMAR_DOC case, one guard over).
    const full = "card is merge-train queued (typed await pr_merged state-vector/superpositional#2117) — the train owns delivery; a machine silence-release must not destroy the queue slot. Wait out the proxy (pr_merged flip closes it) or re-queue explicitly; do not release to the pool. [rule: release-holds-train-queue]";
    expect(full.length).toBeGreaterThan(300);
    const sliced = full.slice(0, 300);
    expect(sliced).not.toMatch(/\[rule: [a-z0-9-]+\]$/);
    expect(breachClass(sliced)).toBe("release_held");
  });

  it("the typed-await hold classifies from the message stem with no tag at all", () => {
    expect(breachClass("card parks on a typed await_event (run_success) — the proxy watch / the answer owns the exit; a machine release must not destroy the wait (BR#4067). Wait it out or let a human/owner release.")).toBe("release_held");
  });

  it("release_held never raises a breach, however many refusals pile up", () => {
    const reason = "card parks on a typed await_event (pr_merged) — the proxy watch / the answer owns the exit; a machine release must not destroy the wait (BR#4067). Wait it out or let a human/owner release. [rule: release-holds-typed-await]";
    const events = Array.from({ length: 6 }, (_, i) => ({
      op: "transition_rejected", task: "TASK-001", ts: 1000 + i * 60_000, reason,
    }));
    const out = detectBreaches(events as any, new Set());
    expect(out.map((b) => b.klass)).not.toContain("release_held");
  });

  it("the contrast holds: an equally persistent unknown refusal still folds unclassified and raises at the threshold", () => {
    const events = Array.from({ length: 3 }, (_, i) => ({
      op: "transition_rejected", task: "BR#1", ts: 1000 + i * 60_000, reason: "something novel",
    }));
    expect(detectBreaches(events as any, new Set()).map((b) => b.klass)).toEqual(["unclassified"]);
  });
});

// ---------------------------------------------------------------------------
// BR#4416 — the prose-card disposition ladder (closure tier): the decision
// table that replaced the per-card "awaits nothing" ask factory. Same shape
// as the PR disposition law (decidePrDisposition, BR#3315): a pure table,
// pinned row by row. The sweep (kb/do.ts proseLadder) supplies board-local
// inputs and acts on the verdict; these pins are the law.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

const proseInput = (over: Partial<ProseDispositionInput>): ProseDispositionInput => ({
  cardId: "BR#4170",
  title: "a specimen prose card",
  now: 10 * DAY,
  legs: [],
  releaseRestricted: false,
  lastClassAskTs: null,
  classAskQuietMs: PROSE_CLASS_QUIET_MS,
  ...over,
});

const legOk = (leg: ProseLegVerdict["leg"], receipt = "board-local proof"): ProseLegVerdict => ({ leg, ok: true, receipt });
const legPending = (leg: ProseLegVerdict["leg"], receipt = "not yet"): ProseLegVerdict => ({ leg, ok: false, receipt });

describe("decideProseDisposition (BR#4416) — rung 1: provably true → flip, zero asks", () => {
  it("the BR#4170 regression: a merged-PR prose card flips per its own promise — no ask exists", () => {
    const d = decideProseDisposition(proseInput({
      legs: [legOk({ kind: "pr_merged", repo: "state-vector/bridge", n: 272 }, "provenance ledger: merged as d22cf6fc0")],
    }));
    expect(d.kind).toBe("flip");
    if (d.kind === "flip") {
      expect(d.leg).toEqual({ kind: "pr_merged", repo: "state-vector/bridge", n: 272 });
      expect(d.receipt).toMatch(/provenance ledger/);
    }
  });

  it("an answered bound ask is proof — the answer is the flip", () => {
    const d = decideProseDisposition(proseInput({
      legs: [legOk({ kind: "ask", ask_id: "ASK-1" }, "ask ASK-1 done — the answer is in")],
    }));
    expect(d.kind).toBe("flip");
  });

  it("a terminal root blocker is proof", () => {
    const d = decideProseDisposition(proseInput({
      legs: [legOk({ kind: "br_done", id: "BR#42" }, "BR#42 status=done")],
    }));
    expect(d.kind).toBe("flip");
  });

  it("the conjunction law: one true leg among many does NOT flip — the park stands until ALL hold", () => {
    const d = decideProseDisposition(proseInput({
      legs: [
        legOk({ kind: "pr_merged", repo: "r/a", n: 1 }),
        legPending({ kind: "br_done", id: "BR#7" }, "BR#7 status=in_progress"),
      ],
    }));
    expect(d.kind).toBe("restore"); // rung 2 re-types the pending leg, never a partial flip
  });

  it("vacuity guard: zero legs never flips", () => {
    expect(decideProseDisposition(proseInput({ legs: [] })).kind).not.toBe("flip");
  });
});

describe("decideProseDisposition (BR#4416) — rung 2: recoverable leg → typed await restored, zero asks", () => {
  it("the-five regression: a PR leg in card meta restores as a grammar-valid typed await", () => {
    const d = decideProseDisposition(proseInput({
      cardId: "BR#3990",
      legs: [legPending({ kind: "pr_merged", repo: "state-vector/bridge", n: 254 }, "no provenance merge row yet")],
    }));
    expect(d.kind).toBe("restore");
    if (d.kind === "restore") {
      // the restored await must pass the ONE grammar authority, not just typecheck
      expect(validateAwaitEvent(d.await_event)).toEqual({ event: "pr_merged", repo: "state-vector/bridge", n: 254 });
    }
  });

  it("an OPEN bound ask restores as a typed ask leg (the park becomes watchdog-safe)", () => {
    const d = decideProseDisposition(proseInput({
      legs: [legPending({ kind: "ask", ask_id: "ASK-9" }, "ask ASK-9 still done? no — open")],
    }));
    expect(d.kind).toBe("restore");
    if (d.kind === "restore") expect(validateAwaitEvent(d.await_event)).toEqual({ event: "ask", ask_id: "ASK-9" });
  });

  it("an open root blocker restores as br_done — the root owns the exit, no ask", () => {
    const d = decideProseDisposition(proseInput({
      legs: [legPending({ kind: "br_done", id: "BR#3816" }, "BR#3816 status=blocked")],
    }));
    expect(d.kind).toBe("restore");
    if (d.kind === "restore") expect(validateAwaitEvent(d.await_event)).toEqual({ event: "br_done", id: "BR#3816" });
  });

  it("precedence: the first pending leg in the sweep's order is the one restored", () => {
    const d = decideProseDisposition(proseInput({
      legs: [
        legPending({ kind: "ask", ask_id: "ASK-1" }),
        legPending({ kind: "pr_merged", repo: "r/b", n: 2 }),
      ],
    }));
    expect(d.kind).toBe("restore");
    if (d.kind === "restore") expect(d.leg.kind).toBe("ask");
  });

  it("proseLegAwaitEvent is total and grammar-valid over the leg set", () => {
    expect(validateAwaitEvent(proseLegAwaitEvent({ kind: "pr_merged", repo: "o/r", n: 3 }))).toEqual({ event: "pr_merged", repo: "o/r", n: 3 });
    expect(validateAwaitEvent(proseLegAwaitEvent({ kind: "ask", ask_id: "ASK-2" }))).toEqual({ event: "ask", ask_id: "ASK-2" });
    expect(validateAwaitEvent(proseLegAwaitEvent({ kind: "br_done", id: "BR#5" }))).toEqual({ event: "br_done", id: "BR#5" });
    expect(validateAwaitEvent(proseLegAwaitEvent({ kind: "time", until_ts: 123 })).event).toBe("time");
  });
});

describe("decideProseDisposition (BR#4416) — rung 3: no machine state → todo with context, zero asks", () => {
  it("a churn-guard park with no leg anywhere releases to the pool — the guard's park is not a human decision", () => {
    const d = decideProseDisposition(proseInput({ legs: [], releaseRestricted: false }));
    expect(d.kind).toBe("release");
    if (d.kind === "release") expect(d.reason).toMatch(/BR#3578 no-leg law/);
  });
});

describe("decideProseDisposition (BR#4416) — rung 4: genuine ambiguity → ONE class ask per day, deduped", () => {
  it("a protected card with no machine state escalates — once", () => {
    const d = decideProseDisposition(proseInput({ legs: [], releaseRestricted: true }));
    expect(d.kind).toBe("escalate_class");
    if (d.kind === "escalate_class") expect(d.askClass).toBe("ambiguous_re_scope");
  });

  it("the second ambiguous card the SAME DAY files NO second ask (quiet window)", () => {
    const now = 50 * DAY;
    const d = decideProseDisposition(proseInput({
      now,
      cardId: "BR#second",
      legs: [],
      releaseRestricted: true,
      lastClassAskTs: now - 1_000, // filed a minute ago
    }));
    expect(d.kind).toBe("waiting");
    if (d.kind === "waiting") expect(d.receipt).toMatch(/quiet window/);
  });

  it("the quiet window EXPIRES: the class ask re-files the next day", () => {
    const now = 50 * DAY;
    const d = decideProseDisposition(proseInput({
      now,
      legs: [],
      releaseRestricted: true,
      lastClassAskTs: now - PROSE_CLASS_QUIET_MS - 1,
    }));
    expect(d.kind).toBe("escalate_class");
  });

  it("the class ask title: deterministic, ≤240 chars, ends in ?", () => {
    const t = proseClassAskTitle(["BR#1", "BR#2", "BR#3"]);
    expect(t).toBe(proseClassAskTitle(["BR#1", "BR#2", "BR#3"]));
    expect(t.length).toBeLessThanOrEqual(240);
    expect(t.endsWith("?")).toBe(true);
    expect(t).toMatch(/BR#1/);
  });

  it("the class ask title truncates a huge class without losing the question mark", () => {
    const ids = Array.from({ length: 60 }, (_, i) => `BR#${1000 + i}`);
    const t = proseClassAskTitle(ids);
    expect(t.length).toBeLessThanOrEqual(240);
    expect(t.endsWith("?")).toBe(true);
  });

  it("the population-alarm title carries the canary framing and obeys the ask contract", () => {
    const t = proseAlarmAskTitle(['BR#9 "mystery card" (writer: some-session)']);
    expect(t.length).toBeLessThanOrEqual(240);
    expect(t.endsWith("?")).toBe(true);
    expect(t).toMatch(/BR#4248/);
    expect(t).toMatch(/BR#9/);
  });
});

// ---------- blocked-park law (BR#2893): the parking lot gets a clock ----------

const NOW = Date.parse("2026-10-25T12:00:00Z");
const STALE_48H = 48 * 3_600_000;
const park = (over: Partial<Parameters<typeof blockedParkVerdict>[0]>) =>
  blockedParkVerdict({
    reason: "",
    unblockCondition: "",
    now: NOW,
    staleMs: STALE_48H,
    ...over,
  });

describe("blockedParkVerdict (BR#2893)", () => {
  it("churn-guard parks are dead at any age, whichever field carries the stamp", () => {
    const reasonShaped = park({
      reason: "churn guard: released to the pool 12 times without completing",
      unblockCondition: "read the task history (get_history) and the last gate error, resolve what it names, then re-claim or re-issue the task",
    });
    expect(reasonShaped.klass).toBe("churn-park");
    // legacy variant: only the boilerplate exit condition, generic reason
    const unblockShaped = park({ reason: "some old gate", unblockCondition: "READ THE TASK HISTORY (get_history) and the last gate error" });
    expect(unblockShaped.klass).toBe("churn-park");
    // even a future date in the text does not resurrect a churn park
    const withDate = park({ reason: "churn guard: released 8 times", unblockCondition: "retry after 2027-01-01" });
    expect(withDate.klass).toBe("churn-park");
  });

  it("unresolvable ASK- refs are dead only when EVERY referenced ask is closed", () => {
    const oneClosed = park({
      unblockCondition: "Ray answers ASK-dead-01",
      askIsOpen: () => false,
    });
    expect(oneClosed.klass).toBe("dead-ask");
    const mixed = park({
      unblockCondition: "ASK-dead-01 answered, or ASK-live-02",
      askIsOpen: (id) => id === "ASK-live-02",
    });
    expect(mixed.klass).toBe("plain"); // a live ask keeps the park honest
    const deduped = park({
      unblockCondition: "ASK-x or ASK-x",
      askIsOpen: () => false,
    });
    expect(deduped.klass).toBe("dead-ask");
  });

  it("BR#4563: a task id inside the unblock condition is not a phantom ask ref", () => {
    // "TASK-016" contains the substring "ASK-016" — the unbounded regex
    // extracted it, the ask-liveness lookup missed, and the blocked-staleness
    // drain re-attempted a machine release every sweep tick while the BR#4067
    // backstop kept refusing it (specimen TASK-016, breach card BR#4563)
    const withTaskId = park({
      unblockCondition:
        "Machine-checkable: mergeCommit non-null on PR https://github.com/state-vector/bridge/pull/99 AND PR https://github.com/state-vector/bridge/pull/67, OR an explicit Ray NO-GO. On merge receipts: a FRESH verify session closes TASK-016 done citing the mergeCommit receipts",
      askIsOpen: () => false,
      blockedTs: NOW - 100 * 3_600_000,
    });
    expect(withTaskId.klass).toBe("external"); // GitHub PR lane — exempt from the drain
    expect(withTaskId.why).toBe("GitHub issue/PR lane");
    // a real ask ref still parses and still gates the verdict
    const realAsk = park({ unblockCondition: "Ray answers ASK-dead-01", askIsOpen: () => false });
    expect(realAsk.klass).toBe("dead-ask");
  });

  it("true external gates are exempt from the age drain", () => {
    const checkpoint = park({
      unblockCondition: "now >= 2026-11-05T08:11:00Z -> run the AC3 measurement",
      blockedTs: NOW - 100 * 3_600_000,
    });
    expect(checkpoint.klass).toBe("external");
    expect(checkpoint.why).toContain("2026-11-05");
    const ghLane = park({ unblockCondition: "GH#1980 closes — operator orphan purge (https://github.com/state-vector/superpositional/issues/1980)", blockedTs: NOW - 100 * 3_600_000 });
    expect(ghLane.klass).toBe("external");
    const redMain = park({ unblockCondition: "resume merging once main is green again (stop-the-line)", blockedTs: NOW - 100 * 3_600_000 });
    expect(redMain.klass).toBe("external");
  });

  it("a past checkpoint date is not a live gate — it ages out", () => {
    const past = park({
      unblockCondition: "checkpoint was 2026-10-01 — re-measure",
      blockedTs: NOW - 100 * 3_600_000,
    });
    expect(past.klass).toBe("plain");
    expect(past.why).toContain("100h");
  });

  it("honest parks age out past the bar; fresh ones stay", () => {
    const aged = park({ reason: "waiting on capacity", unblockCondition: "capacity frees up", blockedTs: NOW - 72 * 3_600_000 });
    expect(aged.klass).toBe("plain");
    expect(aged.why).toContain("72h");
    const fresh = park({ reason: "waiting on capacity", unblockCondition: "capacity frees up", blockedTs: NOW - 2 * 3_600_000 });
    expect(fresh.klass).toBe("plain");
    expect(fresh.why).toBe("parked");
    const noTs = park({ reason: "x", unblockCondition: "y" }); // no blockedTs — never aged, never drained on age
    expect(noTs.klass).toBe("plain");
  });

  it("missing ask lookup defaults to OPEN (never drains on a guess)", () => {
    const v = park({ unblockCondition: "Ray answers ASK-xyz" });
    expect(v.klass).toBe("plain");
  });

  it("the spawner cap is a real, exported constant", () => {
    expect(UNBLOCK_SPAWN_CAP).toBeGreaterThanOrEqual(2);
    expect(Number.isInteger(UNBLOCK_SPAWN_CAP)).toBe(true);
  });
});
