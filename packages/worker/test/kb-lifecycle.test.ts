import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { KnowledgeHub } from "../src/kb/do.ts";

// ---- harness: a real in-memory SQLite backs the DO's storage.sql surface.
// node:sqlite ships FTS5 + external-content tables, so ensureSchema runs
// unmodified; env = {} keeps embeddings on the trigram fallback and GitHub
// enrichment off. This is the whole hub — create/transition/orient/list under
// their real gates, not stubs. ----

type Hub = {
  // the tests exercise private ops directly (the same JSON ops the worker
  // routes expose) — casts keep the suite honest about that; the instance is
  // built via `as unknown as Hub` below (main's KnowledgeHub made create
  // private, so an intersection type here would collapse to never)
  ensureSchema(): Promise<void>;
  create(body: any, actor: string): Promise<{ id: string; status: string }>;
  transition(body: any, actor: string): Promise<any>;
  link(body: any, actor: string): Promise<any>;
  orient(body: any): Promise<any>;
  list(body: any): Promise<any>;
  getHistory(id: string, limit?: number): Promise<{ versions: any[] }>;
  one(q: string, ...p: any[]): any;
};

function makeHub(): { hub: Hub; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  // split on top-level ';' (outside quotes), reassembling CREATE TRIGGER …
  // BEGIN … END bodies — the body's ';' must not split (node:sqlite's prepare
  // compiles only the FIRST statement of a multi-statement string silently)
  const splitStatements = (src: string): string[] => {
    const raw: string[] = [];
    let cur = "", inS: string | null = null;
    for (const ch of src) {
      if (inS) { cur += ch; if (ch === inS) inS = null; continue; }
      if (ch === "'" || ch === '"') { inS = ch; cur += ch; continue; }
      if (ch === ";") { raw.push(cur); cur = ""; continue; }
      cur += ch;
    }
    if (cur.trim()) raw.push(cur);
    const out: string[] = [];
    for (let i = 0; i < raw.length; i++) {
      const t = raw[i].trim();
      // a CREATE TRIGGER chunk that doesn't end with END owns following chunks
      // until one does — its body's ';' already split it apart
      if (/create\s+trigger\b/i.test(t) && !/\bend\s*$/i.test(t)) {
        let body = t;
        while (i + 1 < raw.length && !/\bend\s*$/i.test(body.trim())) {
          i++;
          body += ";" + raw[i];
        }
        out.push(body);
      } else out.push(t);
    }
    return out.filter((s) => s.trim());
  };
  const exec = (sql: string, ...params: unknown[]) => {
    // DO sqlite accepts a single array param as the value list; node:sqlite
    // would read it as named args — flatten that one case
    const args = (params.length === 1 && Array.isArray(params[0]) ? params[0] : params) as any[];
    if (args.length > 0) {
      const rows = db.prepare(sql).all(...args) as any;
      return { toArray: () => rows };
    }
    const stmts = splitStatements(sql);
    if (stmts.length > 1) {
      for (const s of stmts) db.exec(s); // DDL batch — errors propagate loudly
      return { toArray: () => [] };
    }
    let rows: Record<string, unknown>[] = [];
    try {
      rows = db.prepare(sql).all() as any;
    } catch {
      db.exec(sql); // single non-SELECT statement (or a real error — surfaces)
      rows = [];
    }
    return { toArray: () => rows };
  };
  const state = {
    storage: { sql: { exec }, getAlarm: async () => null, setAlarm: async () => {} },
    acceptWebSocket() {},
    getWebSockets: () => [],
  };
  return { hub: new KnowledgeHub(state as any, {}) as unknown as Hub, db };
}

async function question(hub: Hub, title: string): Promise<string> {
  const r = await hub.create(
    { type: "task", title, body_md: "the question context", tags: ["question"], meta: { kind: "question" } },
    "opencode-ray",
  );
  return r.id;
}

const metaOf = (hub: Hub, id: string) => JSON.parse(hub.one(`SELECT meta FROM artefacts WHERE id = ?`, id).meta ?? "{}");
const statusOf = (hub: Hub, id: string) => hub.one(`SELECT status FROM artefacts WHERE id = ?`, id).status;

describe("question→decision lifecycle (BR#909)", () => {
  it("create with derived_from stamps each question awaiting_decision; orient surfaces it", async () => {
    const { hub } = makeHub();
    await hub.ensureSchema();
    const qid = await question(hub, "QUESTION — how should cron dispatch work without per-tick LLM cost?");
    const d = await hub.create(
      { type: "decision", title: "ADR: 3-tier cron dispatch", body_md: "hub cron → task factory; gateway jobs; user crons", derived_from: qid },
      "opencode-ray",
    );
    expect(metaOf(hub, qid).awaiting_decision).toBe(d.id);
    // the card + orient carry the stamp — agents see the escalation is filed
    const o = await hub.orient({ label: "opencode-ray" });
    const card = (o.open_artefacts as any[]).find((t) => t.id === qid);
    expect(card?.awaiting_decision).toBe(d.id);
    // For Me context: the proposed decision carries the question's title
    const l = await hub.list({ type: "decision", status: "proposed" });
    const dec = (l.artefacts as any[]).find((a) => a.id === d.id);
    expect(dec?.request_from).toContain("cron dispatch");
  });

  it("decision acceptance auto-closes the linked question (receipt = the decision)", async () => {
    const { hub } = makeHub();
    await hub.ensureSchema();
    const qid = await question(hub, "QUESTION — retry backoff strategy?");
    const d = await hub.create({ type: "decision", title: "ADR: exponential backoff", body_md: "2^n with jitter", derived_from: qid }, "opencode-ray");
    // human-authoritative: an agent cannot accept
    await expect(hub.transition({ id: d.id, to: "accepted", note: "self-accept" }, "opencode-agent")).rejects.toThrow(/human-authoritative/);
    await hub.transition({ id: d.id, to: "accepted", note: "accepted by human (For Me)" }, "web");
    expect(statusOf(hub, qid)).toBe("done");
    // the close note carries the receipt — the decision id
    const h = await hub.getHistory(qid);
    const close = (h.versions as any[]).find((v) => v.action === "transition" && String(v.summary).includes("→ done"));
    expect(String(close?.summary)).toContain(`closed by ${d.id} acceptance`);
    // a second accept of a re-proposed decision is a clean no-op, not an error
    await expect(hub.transition({ id: d.id, to: "accepted", note: "ratify" }, "web")).rejects.toThrow(); // accepted → accepted is not a legal edge
  });

  it("decision rejection reopens the loop: stamp cleared, question stays open, reason on record", async () => {
    const { hub } = makeHub();
    await hub.ensureSchema();
    const qid = await question(hub, "QUESTION — where do gateway tokens live?");
    const d = await hub.create({ type: "decision", title: "ADR: tokens in the registry", body_md: "…", derived_from: qid }, "opencode-ray");
    await hub.transition({ id: d.id, to: "rejected", note: "wrong axis — vended tokens must stay opaque, revising" }, "web");
    // the question was open (questions live in todo) — it stays open, but the
    // loop is released: awaiting_decision cleared, ready for a revised proposal
    expect(statusOf(hub, qid)).toBe("todo");
    expect(metaOf(hub, qid).awaiting_decision).toBeUndefined();
    const d2 = await hub.create({ type: "decision", title: "ADR: opaque vended tokens", body_md: "…", derived_from: qid }, "opencode-ray");
    expect(metaOf(hub, qid).awaiting_decision).toBe(d2.id);
  });

  it("superseded RULING reopens its closed question (accepted → superseded); linked rounds close", async () => {
    const { hub, db } = makeHub();
    await hub.ensureSchema();
    const qid = await question(hub, "QUESTION — board UX pass scope?");
    const d = await hub.create({ type: "decision", title: "ADR: rich cards first", body_md: "…", derived_from: qid }, "opencode-ray");
    // a BR#903-style consensus round: question-kind child_of the decision
    const round = await hub.create(
      { type: "task", title: "Feedback round: rich cards first", body_md: "contribute", tags: ["question"], meta: { kind: "question", feedback_for: d.id } },
      "opencode-ray",
    );
    db.prepare(`INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`).run(round.id, d.id, Date.now());
    // the human rules: accept (question closes, round closes)
    await hub.transition({ id: d.id, to: "accepted", note: "ok" }, "web");
    expect(statusOf(hub, qid)).toBe("done");
    expect(statusOf(hub, round.id)).toBe("superseded");
    // the ruling is overturned/revised: supersede the ACCEPTED decision —
    // the question reopens through the gated done → todo edge
    const d2 = await hub.create({ type: "decision", title: "ADR: rich cards first (revised)", body_md: "…", meta: { feedback_round: true } }, "opencode-ray");
    await hub.transition({ id: d.id, to: "superseded", replacement_id: d2.id, note: "revised after production feedback" }, "opencode-ray");
    expect(statusOf(hub, qid)).toBe("todo");
    expect(metaOf(hub, qid).awaiting_decision).toBeUndefined();
    const h = await hub.getHistory(qid);
    const reopen = (h.versions as any[]).find((v) => v.action === "transition" && String(v.summary).includes("→ todo"));
    expect(String(reopen?.summary)).toContain("reopened");
    expect(String(reopen?.summary)).toContain("revised after production feedback");
    // a superseded PROPOSAL also reopens its still-open question's loop (stamp clear)
    const q3 = await question(hub, "QUESTION — another proposal, withdrawn");
    const d3 = await hub.create({ type: "decision", title: "ADR: withdrawn proposal", body_md: "…", derived_from: q3 }, "opencode-ray");
    await hub.transition({ id: d3.id, to: "superseded", note: "author withdrew" }, "opencode-ray");
    expect(statusOf(hub, q3)).toBe("todo");
    expect(metaOf(hub, q3).awaiting_decision).toBeUndefined();
  });

  it("accept closes via the derived_from relation even when the stamp was never written (legacy links)", async () => {
    const { hub, db } = makeHub();
    await hub.ensureSchema();
    const qid = await question(hub, "QUESTION — pre-lifecycle escalation");
    const d = await hub.create({ type: "decision", title: "ADR: legacy link", body_md: "…", derived_from: qid }, "opencode-ray");
    // simulate a pre-BR#909 row: the link exists, the stamp never landed
    db.prepare(`UPDATE artefacts SET meta = '{}' WHERE id = ?`).run(qid);
    await hub.transition({ id: d.id, to: "accepted", note: "accepted by human (For Me)" }, "web");
    expect(statusOf(hub, qid)).toBe("done");
  });

  it("the decision-first path stamps via link (create the proposal, then derive it)", async () => {
    const { hub } = makeHub();
    await hub.ensureSchema();
    const qid = await question(hub, "QUESTION — already converged (BR#899 pattern)");
    const d = await hub.create({ type: "decision", title: "ADR: decision-first", body_md: "…", meta: { feedback_round: true } }, "opencode-ray");
    await hub.link({ src: d.id, relation: "derived_from", dst: qid }, "opencode-ray");
    expect(metaOf(hub, qid).awaiting_decision).toBe(d.id);
  });

  it("done is terminal for everything but a decision-driven reopen", async () => {
    const { hub } = makeHub();
    await hub.ensureSchema();
    const qid = await question(hub, "QUESTION — reopen gate");
    const d = await hub.create({ type: "decision", title: "ADR: reopen gate", body_md: "…", derived_from: qid }, "opencode-ray");
    await hub.transition({ id: d.id, to: "accepted", note: "ok" }, "web");
    expect(statusOf(hub, qid)).toBe("done");
    // a bare done → todo (no reopen_for) is refused — done tasks don't walk out
    await expect(hub.transition({ id: qid, to: "todo", note: "changed my mind" }, "web")).rejects.toThrow(/terminal/);
    // reopen_for must name a rejected/superseded decision, not a live one
    await expect(hub.transition({ id: qid, to: "todo", reopen_for: d.id, note: "nope" }, "web")).rejects.toThrow(/not a rejected\/superseded decision/);
    // unknown reopen_for is refused too
    await expect(hub.transition({ id: qid, to: "todo", reopen_for: "BR#999999", note: "nope" }, "web")).rejects.toThrow(/not a rejected\/superseded decision/);
  });

  it("create validates derived_from before inserting (a typo must not half-create)", async () => {
    const { hub } = makeHub();
    await hub.ensureSchema();
    await expect(
      hub.create({ type: "decision", title: "ADR: bad ref", body_md: "…", derived_from: ["BR#999999"] }, "opencode-ray"),
    ).rejects.toThrow(/no such artefact/);
    // non-task derived_from is refused (escalations derive from question tasks)
    const g = await hub.create({ type: "goal", title: "A goal", body_md: "…" }, "opencode-ray");
    await expect(
      hub.create({ type: "decision", title: "ADR: goal-derived", body_md: "…", derived_from: [g.id] }, "opencode-ray"),
    ).rejects.toThrow(/question TASKS/);
  });
});
