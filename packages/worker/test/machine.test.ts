import { describe, it, expect } from "vitest";
import {
  RULES,
  check,
  churnRelease,
  effectiveRole,
  invariants,
  detectBreaches,
  breachClass,
  CHURN_ESCALATE_ATTEMPTS,
  CHURN_REDIRECT_ATTEMPTS,
  type RuleCtx,
  type RuleInput,
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
});

const input = (over: Partial<RuleInput>): RuleInput => ({
  id: "BR#1",
  type: "task",
  status: "todo",
  to: "in_progress",
  tags: [],
  meta: {},
  actor: "agent-x",
  body: {},
  ...over,
});

// ---------- the matrix: every role × from × to, generated from LIFECYCLES ----------

const ROLES = ["plain", "impl", "analysis", "review", "unblock", "human"] as const;
const TASK_STATUSES = Object.keys(LIFECYCLES.task); // todo, in_progress, in_review, blocked, done...

describe("transition matrix (task: role × from × to)", () => {
  const cells: { role: string; from: string; to: string; msg: string | null }[] = [];
  for (const r of ROLES) {
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        cells.push({ role: r, from, to, msg: null });
      }
    }
  }

  it("every cell resolves to allow-or-reject, never a throw", async () => {
    for (const c of cells) {
      const i = input({ status: c.from, to: c.to, tags: c.role === "plain" ? [] : [`role:${c.role}`] });
      let msg: string | null = null;
      let threw: unknown;
      try {
        msg = await check(i, baseCtx());
      } catch (e) {
        threw = e;
      }
      expect(threw, `check() threw for ${c.role} ${c.from}→${c.to}: ${threw}`).toBeUndefined();
      expect(typeof msg === "string" || msg === null, `non-string verdict for ${c.role} ${c.from}→${c.to}`).toBe(true);
    }
  });

  it("verdict duties cannot block or enter in_review from ANY open state (BR#2298/BR#909 loop killers)", async () => {
    for (const duty of ["review", "unblock"]) {
      for (const [to, fragment] of [["blocked", "cannot block"] as const, ["in_review", "terminal state"] as const]) {
        const i = input({ status: "in_progress", to, tags: [`role:${duty}`] });
        const msg = await check(i, baseCtx());
        expect(msg, `${duty} → ${to} must be refused`).toContain(fragment);
      }
    }
  });

  it("verdict duties may still close done with receipts, and only then", async () => {
    const ok = await check(input({ status: "in_progress", to: "done", tags: ["role:review"], body: { note: "receipts: https://github.com/x/y/pull/1 merged" } }), baseCtx());
    expect(ok).toBeNull();
    const noReceipts = await check(input({ status: "in_progress", to: "done", tags: ["role:review"], body: { note: "looks fine" } }), baseCtx());
    expect(noReceipts).toContain("cannot complete without receipts");
  });

  it("verdict-duty blocked survives only as an ask-gate", async () => {
    const ask = input({
      status: "in_progress",
      to: "blocked",
      tags: ["role:review"],
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
    const msg = await check(input({ status: "in_review", to: "done", tags: ["role:analysis"], body: { note: "x" } }), c);
    expect(msg).toContain("still has 2 open child task(s)");
  });

  it("questions are never claimable; operator gates hold; decisions need a human", async () => {
    expect(await check(input({ tags: ["question"] }), baseCtx())).toContain("questions are answered, not claimed");
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
    c.evidence = (id) => ({ type: "task", tags: ["role:analysis"], meta: { session: "session-a" } });
    const msg = await check(input({}), c);
    expect(msg).toContain("separation of duties");
    // a different session passes
    const c2 = baseCtx();
    c2.qualify = () => ({ ok: true, via: "BR#9" });
    c2.evidence = (id) => ({ type: "task", tags: ["role:analysis"], meta: { session: "session-b" } });
    expect(await check(input({}), c2)).toBeNull();
  });

  it("review separation: the impl session cannot produce its own review", async () => {
    const c = baseCtx();
    c.parent = () => ({ id: "BR#0", meta: { session: "session-a" } });
    const msg = await check(
      input({ status: "in_progress", to: "done", tags: ["role:review"], meta: { session: "session-a" }, body: { note: "PR https://x/pull/1 merged" } }),
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
    expect(await check(input({ tags: ["role:human"], status: "in_review", to: "done" }), baseCtx())).toContain("human sign-off");
  });
});

// ---------- regression cells: the exact loop shapes we killed ----------

describe("loop regressions", () => {
  it("BR#2298 shape: a verify task stalled into blocked by any actor is refused", async () => {
    const msg = await check(
      input({ id: "BR#2298", status: "in_progress", to: "blocked", tags: ["role:review"], actor: "system:watchdog", body: { note: "stalled", unblock_condition: "re-claim" } }),
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
        "review-needs-pr",
        "review-separation-of-duties",
        "unblock-needs-resolution",
        "verdict-done-needs-receipts",
        "verdict-no-blocked",
        "verdict-no-in_review",
      ].sort(),
    );
    expect(CHURN_ESCALATE_ATTEMPTS).toBeLessThan(5); // escalate before the old 5-redirect
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
    expect(invariants({ type: "task", status: "blocked", tags: ["role:review"], meta: { blocked: {} } }).length).toBeGreaterThan(0);
    expect(invariants({ type: "task", status: "in_review", tags: ["role:unblock"], meta: {} }).length).toBeGreaterThan(0);
    expect(invariants({ type: "task", status: "in_progress", tags: ["question"], meta: {} }).length).toBeGreaterThan(0);
    expect(invariants({ type: "task", status: "blocked", tags: [], meta: {} }).length).toBeGreaterThan(0); // blocked w/o record
    expect(invariants({ type: "task", status: "todo", tags: [], meta: { blocked: { reason: "x" } } }).length).toBeGreaterThan(0); // stale record
  });

  it("pass clean legal states", () => {
    expect(invariants({ type: "task", status: "blocked", tags: [], meta: { blocked: { reason: "r", unblock_condition: "u" } } })).toEqual([]);
    expect(invariants({ type: "task", status: "in_progress", tags: ["role:review"], meta: {} })).toEqual([]);
    expect(invariants({ type: "task", status: "done", tags: ["role:impl"], meta: {} })).toEqual([]);
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

  it("invariant violations escalate at threshold under their own class", () => {
    const events = [0, 1, 2].map((n) => ev(n, "BR#3", "verdict role review is blocked", "invariant_violation"));
    const breaches = detectBreaches(events, new Set());
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
  it("check() total over 500 arbitrary inputs; legal walks stay invariant-clean", async () => {
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T,>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)];
    const TAG_POOL = [[], ["role:impl"], ["role:review"], ["role:unblock"], ["role:analysis"], ["role:human"], ["question"]];
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
      let msg: string | null = null;
      try {
        msg = await check(i, baseCtx());
      } catch (e) {
        expect.fail(`check() threw on ${JSON.stringify(i)}: ${e}`);
      }
      if (msg === null && i.type === "task" && !i.body?.awaiting_ask_id) {
        // an allowed transition must land the artefact in an invariant-clean state
        const meta = { ...(i.meta ?? {}), blocked: i.to === "blocked" ? { reason: "r", unblock_condition: "u" } : undefined };
        const v = invariants({ type: "task", status: i.to, tags: i.tags, meta });
        if (i.to !== "in_review" || !["review", "unblock"].includes(effectiveRole(i.tags))) {
          expect(v, `legal move ${i.tags.join(",") || "plain"} ${i.status}→${i.to} broke invariants: ${v.join("; ")}`).toEqual([]);
        }
      }
    }
  });
});
