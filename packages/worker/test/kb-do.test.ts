import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { KnowledgeHub, verifyStallMinutes } from "../src/kb/do.ts";

type Row = Record<string, any>;

const MIN = 60_000;

/** DO-level harness: real SQL (node:sqlite), fake runtime shell. The DO's rules
 *  live in SQL-heavy private methods — testing them through a real engine
 *  catches query drift that pure-function tests can't. */
async function makeHub() {
  const db = new DatabaseSync(":memory:");
  const state = {
    storage: {
      sql: {
        exec(sql: string, ...args: any[]) {
          // workers' sql.exec flattens a single array argument into positional
          // params — emulate that, node:sqlite would treat it as named params
          const params = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
          const isRead = /^\s*(SELECT|WITH)/i.test(sql) || /\bRETURNING\b/i.test(sql);
          if (isRead) return { toArray: () => db.prepare(sql).all(...params) as Row[] };
          if (params.length) db.prepare(sql).run(...params);
          else db.exec(sql);
          return { toArray: () => [] as Row[] };
        },
      },
      setAlarm: async () => {},
      getAlarm: async () => null,
    },
    getWebSockets: () => [] as any[],
  };
  const hub = new KnowledgeHub(state as any, {}) as any;
  await hub.ensureSchema();
  return { hub, db };
}

async function seedAgent(db: DatabaseSync, label: string, tags: string[], onlineMinutesAgo = 0) {
  db.prepare(
    `INSERT INTO auth_tokens (id, label, hash, tags, transport, created_ts, last_seen_ts) VALUES (?, ?, ?, ?, 'mcp', ?, ?)`,
  ).run(`tok-${label}`, label, `hash-${label}`, JSON.stringify(tags), Date.now(), Date.now() - onlineMinutesAgo * MIN);
}

async function createTask(hub: any, title: string, opts: Record<string, any> = {}, actor = "impl-agent") {
  const r = await hub.create({ type: "task", title, body_md: `test body for ${title}`, ...opts }, actor);
  return r.id as string;
}

/** parent taken to in_review — auto-spawns its unclaimed verify child; returns both ids */
async function parentInReview(hub: any, title: string, actor = "impl-agent") {
  const parent = await createTask(hub, title, { qualified: true }, actor);
  await hub.transition({ id: parent, to: "in_progress" }, actor);
  await hub.transition({ id: parent, to: "in_review", note: "PR https://example.test/pr/1" }, actor);
  const child = (hub.one(`SELECT src_id AS id FROM relations WHERE relation = 'child_of' AND dst_id = ?`, parent) as Row).id;
  return { parent, verify: child };
}

function ageTask(db: DatabaseSync, id: string, minutesAgo: number) {
  db.prepare(`UPDATE artefacts SET updated_ts = ? WHERE id = ?`).run(Date.now() - minutesAgo * MIN, id);
}

function nudgeRows(hub: any, verifyId: string) {
  return (hub.state.storage.sql.exec(
    `SELECT detail FROM events WHERE op = 'nudge' AND artefact_id = ? ORDER BY seq`, verifyId,
  ).toArray() as Row[]).map((r) => JSON.parse(r.detail));
}

describe("verifyStallMinutes", () => {
  it("derives from review_stale_minutes: capped at 60m, floored at 10m, always under the bounce", () => {
    expect(verifyStallMinutes(null)).toBe(60); // default 360m / 6
    expect(verifyStallMinutes("360")).toBe(60);
    expect(verifyStallMinutes("junk")).toBe(60); // unparsable → default 360 / 6
    expect(verifyStallMinutes("90")).toBe(15);
    expect(verifyStallMinutes("30")).toBe(10); // floor
    expect(verifyStallMinutes("2880")).toBe(60); // cap
  });
});

describe("watchdog nudge (verify tasks are never reaped — they are nudged)", () => {
  it("nudges an aged unclaimed verify child to online role:review agents, hourly at most, and never reaps it", async () => {
    const { hub, db } = await makeHub();
    await seedAgent(db, "impl-agent", ["role:impl"]);
    await seedAgent(db, "reviewer", ["role:review"]);
    const { parent, verify } = await parentInReview(hub, "impl thing");
    ageTask(db, verify, 90);

    await hub.alarmSweep();
    const nudges = nudgeRows(hub, verify);
    expect(nudges).toHaveLength(1);
    expect(nudges[0].audience).toEqual(["reviewer"]);
    expect(nudges[0].parent).toBe(parent);
    expect(nudges[0].note).toContain("blocks");

    // rate limit: an immediate re-sweep does not spam
    await hub.alarmSweep();
    expect(nudgeRows(hub, verify)).toHaveLength(1);

    // never reaped: the verify child still sits unclaimed in the pool
    expect((hub.one(`SELECT status, owner FROM artefacts WHERE id = ?`, verify) as Row).status).toBe("todo");

    // once claimed, the nudges stop (the pickup problem is solved)
    await hub.transition({ id: verify, to: "in_progress" }, "reviewer");
    await hub.transition({ id: verify, to: "done", note: "PR https://example.test/pr/1 merged, receipts checked" }, "reviewer");
    await db.prepare(`UPDATE artefacts SET updated_ts = ? WHERE id = ?`).run(Date.now() - 90 * MIN, verify);
    // V is done now — but a fresh verify child on a new round would be the pattern; here just assert no crash
    await hub.alarmSweep();
  });

  it("falls back to nudging everyone when no role:review agent is online", async () => {
    const { hub, db } = await makeHub();
    await seedAgent(db, "impl-agent", ["role:impl"]);
    const { verify } = await parentInReview(hub, "impl thing two");
    ageTask(db, verify, 120);

    await hub.alarmSweep();
    const nudges = nudgeRows(hub, verify);
    expect(nudges).toHaveLength(1);
    expect(nudges[0].audience).toEqual(["everyone"]);
  });

  it("does not nudge a fresh verify child (below the stall threshold)", async () => {
    const { hub, db } = await makeHub();
    await seedAgent(db, "reviewer", ["role:review"]);
    const { verify } = await parentInReview(hub, "impl thing three");
    ageTask(db, verify, 5); // minutes old — nudges are 60m away

    await hub.alarmSweep();
    expect(nudgeRows(hub, verify)).toHaveLength(0);
  });
});

describe("verification_stalled trait (orient attention)", () => {
  it("surfaces to the waiting owner as a pickup problem, and to role:review agents as pickup duty", async () => {
    const { hub, db } = await makeHub();
    await seedAgent(db, "impl-agent", ["role:impl"]);
    await seedAgent(db, "reviewer", ["role:review"]);
    const { parent, verify } = await parentInReview(hub, "parked impl work");

    // fresh verify child: nothing stalled yet
    const fresh = await hub.orient({ label: "impl-agent", tags: ["role:impl"] });
    expect((fresh.action_required ?? []).filter((n: Row) => n.kind === "verification_stalled")).toHaveLength(0);

    ageTask(db, verify, 90);
    const ownerView = await hub.orient({ label: "impl-agent", tags: ["role:impl"] });
    const ownerNotice = (ownerView.action_required ?? []).find((n: Row) => n.kind === "verification_stalled");
    expect(ownerNotice).toBeTruthy();
    expect(ownerNotice.required_action).toBe("CLAIM_VERIFY_TASK");
    expect(ownerNotice.task_id).toBe(verify);
    expect(ownerNotice.parent_id).toBe(parent);
    expect(ownerNotice.message).toContain("pickup problem");

    const reviewView = await hub.orient({ label: "reviewer", tags: ["role:review"] });
    const dutyNotice = (reviewView.action_required ?? []).find((n: Row) => n.kind === "verification_stalled");
    expect(dutyNotice).toBeTruthy();
    expect(dutyNotice.required_action).toBe("PICKUP_REVIEW");
    expect(dutyNotice.task_id).toBe(verify);

    const plainView = await hub.orient({ label: "bystander", tags: [] });
    expect((plainView.action_required ?? []).filter((n: Row) => n.kind === "verification_stalled")).toHaveLength(0);
  });
});

describe("score signal (nudged-but-ignored verify rounds cost role:review agents)", () => {
  it("counts only verify rounds past the stall threshold, and only for role:review agents", async () => {
    const { hub, db } = await makeHub();
    await seedAgent(db, "impl-agent", ["role:impl"]);
    await seedAgent(db, "reviewer", ["role:review"]);
    const { verify } = await parentInReview(hub, "impl thing scored");

    // fresh round: no backlog yet
    let reviewer = hub.computeAgentScores().find((a: Row) => a.label === "reviewer");
    expect(reviewer.verify_duty_backlog ?? 0).toBe(0);

    ageTask(db, verify, 90);
    reviewer = hub.computeAgentScores().find((a: Row) => a.label === "reviewer");
    expect(reviewer.verify_duty_backlog).toBe(1);
    expect(reviewer.hints.some((h: string) => /stalled verify/.test(h))).toBe(true);
    expect(reviewer.score).toBeLessThan(50);

    const bystander = hub.computeAgentScores().find((a: Row) => a.label === "impl-agent");
    expect(bystander.verify_duty_backlog ?? 0).toBe(0);
  });
});

describe("pool ordering (unclaimed verify first, oldest first; questions second; rest after)", () => {
  it("ranks unclaimed role:review children of in_review parents ahead of questions and plain work", async () => {
    const { hub, db } = await makeHub();
    await seedAgent(db, "impl-agent", ["role:impl"]);

    const { parent, verify } = await parentInReview(hub, "first impl");
    ageTask(db, verify, 90);
    const { verify: verify2 } = await parentInReview(hub, "second impl");
    ageTask(db, verify2, 30);

    const question = await createTask(hub, "open question for the fleet", { tags: ["question"] }, "someone");
    ageTask(db, question, 20);
    // an unclaimed ANALYSIS child of an in_review parent is NOT verify duty
    const analysisChild = await createTask(hub, "analysis child of an in_review parent", { tags: ["role:analysis"] }, "someone");
    await hub.link({ src: analysisChild, relation: "child_of", dst: parent }, "someone");
    ageTask(db, analysisChild, 15);
    const plain = await createTask(hub, "plain impl task", {}, "someone");
    ageTask(db, plain, 10);

    const view = await hub.orient({ label: "impl-agent", tags: ["role:impl"] });
    const ids = view.unclaimed_work.map((t: Row) => t.id);
    expect(ids).toContain(verify);
    expect(ids).toContain(verify2);
    expect(ids).toContain(question);
    expect(ids).toContain(analysisChild);
    expect(ids).toContain(plain);

    const order = ids.indexOf(verify) < ids.indexOf(verify2); // oldest verify first
    expect(order).toBe(true);
    expect(Math.min(ids.indexOf(verify), ids.indexOf(verify2))).toBeLessThan(ids.indexOf(question)); // verify before questions
    expect(ids.indexOf(question)).toBeLessThan(ids.indexOf(analysisChild)); // questions before the rest
    expect(ids.indexOf(question)).toBeLessThan(ids.indexOf(plain));
    // the tag refinement: an analysis child of an in_review parent ranks as plain work
    expect(ids.indexOf(analysisChild)).toBeGreaterThan(ids.indexOf(question));
  });
});
