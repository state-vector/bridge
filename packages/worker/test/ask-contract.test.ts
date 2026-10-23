import { describe, it, expect } from "vitest";
import { composeBlockedAskNote, composeAskUnblock, composeStructuredAnswer } from "../src/kb/core.ts";
import { KnowledgeHub } from "../src/kb/do.ts";

// Ask contract (steering BR#2643): a decision ask's blocked card must lead
// with WHAT HAPPENED, then DECISION, then WHY HUMAN — never the ask preamble.

describe("composeBlockedAskNote", () => {
  it("renders summary-first with decision and why-human segments in order", () => {
    const note = composeBlockedAskNote({
      id: "ASK-x-1", to: "RAY",
      question: "RAY — BR#552 (Release-Cluster Runbook Wave 4/5) is DONE in substance and needs one human decision. Deliverable: runbook …",
      summary: "runbook v2 done; PR #68 APPROVED, checks green; bridge main is RED (rolldown os error 20)",
      why_escalated: "merge is Ray-gated per accepted BR#1203; BR#551 forbids merging onto red main",
      decision: "(a) GO — land BR#2447 hotfix then rebase+merge #68 (b) NO-GO/redirect",
    });
    expect(note.startsWith("blocked on decision (ask ASK-x-1 → RAY) — runbook v2 done")).toBe(true);
    expect(note.indexOf("DECISION:")).toBeGreaterThan(note.indexOf("runbook v2"));
    expect(note.indexOf("WHY HUMAN:")).toBeGreaterThan(note.indexOf("DECISION:"));
    expect(note).not.toContain("Deliverable: runbook");
  });

  it("falls back to the (whitespace-collapsed) question when summary is absent", () => {
    const note = composeBlockedAskNote({
      id: "ASK-y-2", to: "any",
      question: "multi\nline   preamble here",
    });
    expect(note).toBe("blocked on decision (ask ASK-y-2 → any) — multi line preamble here");
  });

  it("omits missing optional segments", () => {
    const note = composeBlockedAskNote({
      id: "ASK-z-3", to: "RAY", question: "q",
      decision: "(a) yes (b) no",
    });
    expect(note).toBe("blocked on decision (ask ASK-z-3 → RAY) — q · DECISION: (a) yes (b) no");
    expect(note).not.toContain("WHY HUMAN");
  });
});

describe("composeAskUnblock", () => {
  it("carries the decision gist instead of a bare answer-to-ask placeholder", () => {
    expect(composeAskUnblock({ id: "ASK-x-1", decision: "(a) GO — merge PR #68  (b) NO-GO" }))
      .toBe("decision on ask ASK-x-1: (a) GO — merge PR #68 (b) NO-GO");
  });

  it("caps the gist at 160 chars and collapses whitespace", () => {
    const out = composeAskUnblock({ id: "ASK-l-4", decision: `word `.repeat(80) });
    expect(out.startsWith("decision on ask ASK-l-4: word word")).toBe(true);
    expect(out.length).toBeLessThanOrEqual("decision on ask ASK-l-4: ".length + 160);
    expect(out).not.toContain("  ");
  });

  it("keeps the legacy placeholder when no decision was stated", () => {
    expect(composeAskUnblock({ id: "ASK-m-5" })).toBe("answer to ask ASK-m-5");
  });
});

// ---- askCreate → ask.get round-trip (kb/do.ts): the F1 verify finding
// (BR#2655) — ask.get had no vitest coverage and the askCreate persistence
// wiring was untested. The SQL shim implements ONLY the statements these
// paths issue and throws on anything else, so impl drift fails loudly. ----

function makeHub() {
  const asks: any[] = [];
  const artefacts = new Map<string, { type: string; status: string; meta: string }>();
  let seq = 0;
  const sql = {
    exec(query: string, ...params: any[]) {
      const s = query.replace(/\s+/g, " ").trim();
      const rows = (rs: any[]) => ({ toArray: () => rs });
      if (s.startsWith("INSERT INTO asks")) {
        const cols = (s.match(/INSERT INTO asks \(([^)]+)\) VALUES/) ?? [])[1]
          ?.split(",")
          .map((c: string) => c.trim()) ?? [];
        const vals = (s.match(/VALUES \((.+)\)$/) ?? [])[1]
          ?.split(",")
          .map((v: string) => v.trim()) ?? [];
        const row: any = {};
        let pi = 0;
        cols.forEach((c: string, i: number) => {
          row[c] = vals[i] === "?" ? params[pi++] ?? null : vals[i].replace(/^'|'$/g, "");
        });
        asks.push(row);
        return rows([]);
      }
      if (s.startsWith("INSERT INTO events")) return rows([{ seq: ++seq }]); // audit() RETURNING seq
      if (s.startsWith("SELECT * FROM asks WHERE id =")) return rows(asks.filter((r) => r.id === params[0]));
      if (s.startsWith("SELECT status, artefact_id, options FROM asks WHERE id =")) return rows(asks.filter((r) => r.id === params[0]));
      if (s.startsWith("SELECT COUNT(*) AS n FROM asks WHERE artefact_id")) return rows([{ n: asks.filter((r) => r.artefact_id === params[0]).length || 1 }]);
      if (s.startsWith("UPDATE asks SET status = 'answered'")) {
        const a = asks.find((r) => r.id === params[5]);
        if (a) {
          a.status = "answered";
          a.answer = params[0];
          a.answered_by = params[1];
          a.answered_ts = params[2];
          a.answer_choice = params[3];
          a.answer_receipt = params[4];
        }
        return rows([]);
      }
      if (s.startsWith("SELECT type, status, meta FROM artefacts WHERE id =")) {
        const a = artefacts.get(params[0]);
        return rows(a ? [{ ...a }] : []);
      }
      if (s.startsWith("UPDATE artefacts SET meta")) {
        const a = artefacts.get(params[1]);
        if (a) a.meta = params[0];
        return rows([]);
      }
      throw new Error(`sql shim: unsupported statement: ${s.slice(0, 90)}`);
    },
  };
  const state: any = { storage: { sql }, getWebSockets: () => [], acceptWebSocket: () => {} };
  return { hub: new KnowledgeHub(state, {}), asks, artefacts };
}

describe("askCreate → ask.get round-trip", () => {
  it("persists the contract fields and askGet returns them on the artefact-like payload", async () => {
    const { hub } = makeHub();
    const created = await (hub as any).askCreate(
      {
        to: "RAY",
        question: "RAY — BR#9 needs one human call",
        summary: "impl done, PR open, sole unmet leg is the merge gate",
        why_escalated: "merge is Ray-gated per accepted BR#1203",
        decision: "(a) GO (b) NO-GO",
      },
      "agent-a",
    );
    expect(created.id).toMatch(/^ASK-[0-9a-z]+-[0-9a-z]{1,6}$/);
    const row = (hub as any).askGet({ id: created.id });
    expect(row.type).toBe("ask");
    expect(row.to_target).toBe("RAY");
    expect(row.from_label).toBe("agent-a");
    expect(row.question).toContain("one human call");
    expect(row.summary).toBe("impl done, PR open, sole unmet leg is the merge gate");
    expect(row.why_escalated).toBe("merge is Ray-gated per accepted BR#1203");
    expect(row.decision).toBe("(a) GO (b) NO-GO");
    expect(row.status).toBe("open");
    expect(row.answer ?? null).toBeNull();
  });

  it("truncates the contract fields to their bounds (summary 400 / why_escalated 300 / decision 400)", async () => {
    const { hub, asks } = makeHub();
    await (hub as any).askCreate(
      {
        question: "q",
        summary: "s".repeat(1000),
        why_escalated: "w".repeat(1000),
        decision: "d".repeat(1000),
      },
      "agent-a",
    );
    const row = (hub as any).askGet({ id: asks[0].id });
    expect(row.summary).toHaveLength(400);
    expect(row.why_escalated).toHaveLength(300);
    expect(row.decision).toHaveLength(400);
  });

  it("stores absent contract fields as null and omits them from the create result", async () => {
    const { hub } = makeHub();
    const created = await (hub as any).askCreate({ question: "bare ask" }, "agent-a");
    expect(created.summary).toBeUndefined();
    expect(created.why_escalated).toBeUndefined();
    expect(created.decision).toBeUndefined();
    const row = (hub as any).askGet({ id: created.id });
    expect(row.summary ?? null).toBeNull();
    expect(row.why_escalated ?? null).toBeNull();
    expect(row.decision ?? null).toBeNull();
  });

  it("stamps awaiting_ask on a bound blocked task and persists the binding", async () => {
    const { hub, artefacts } = makeHub();
    artefacts.set("BR#9", { type: "task", status: "blocked", meta: "{}" });
    const created = await (hub as any).askCreate(
      { to: "RAY", question: "decide", artefact_id: "BR#9", decision: "(a) GO" },
      "agent-a",
    );
    expect(created.task_status).toBe("blocked");
    expect(created.artefact_id).toBe("BR#9");
    const stamped = JSON.parse(artefacts.get("BR#9")!.meta).awaiting_ask;
    expect(stamped.ask_id).toBe(created.id);
    expect((hub as any).askGet({ id: created.id }).artefact_id).toBe("BR#9");
  });

  it("askGet throws on an unknown id; askCreate rejects empty questions and bad targets", async () => {
    const { hub } = makeHub();
    expect(() => (hub as any).askGet({ id: "ASK-nope" })).toThrow("no such ask");
    await expect((hub as any).askCreate({ to: "RAY" }, "agent-a")).rejects.toThrow("question is required");
    await expect(
      (hub as any).askCreate({ question: "x", to: "has spaces" }, "agent-a"),
    ).rejects.toThrow("invalid ask target");
    await expect(
      (hub as any).askCreate({ question: "x", artefact_id: "BR#404" }, "agent-a"),
    ).rejects.toThrow("no such artefact");
  });
});

// ---- ask kinds + persisted options + structured answers (ADR BR#2672):
// one ask entity, three kinds (ask/decision/action); options[] are PERSISTED
// (previously accepted then dropped) and render as buttons; answers are
// structured {choice, note, receipt}. ----

describe("ask kinds, options, done_when (ADR BR#2672)", () => {
  it("defaults kind to 'ask' and persists declared options + done_when (parsed, not the raw JSON)", async () => {
    const { hub } = makeHub();
    const bare = await (hub as any).askCreate({ question: "info please" }, "agent-a");
    expect(bare.kind).toBe("ask");
    const row = (hub as any).askGet({ id: bare.id });
    expect(row.kind).toBe("ask");
    expect(row.options).toEqual([]);

    const created = await (hub as any).askCreate(
      {
        question: "RAY — merge GO/NO-GO for PR #102",
        kind: "decision",
        options: ["(a) GO — review + merge PR #102", "(b) NO-GO — re-scope"],
        decision: "(a) GO (b) NO-GO",
      },
      "agent-a",
    );
    expect(created.kind).toBe("decision");
    expect(created.options).toHaveLength(2);
    const dRow = (hub as any).askGet({ id: created.id });
    expect(dRow.kind).toBe("decision");
    expect(dRow.options).toEqual(["(a) GO — review + merge PR #102", "(b) NO-GO — re-scope"]);
    expect(dRow.done_when ?? null).toBeNull();
  });

  it("rejects invalid kinds and action asks without done_when; accepts action with done_when", async () => {
    const { hub, asks } = makeHub();
    await expect((hub as any).askCreate({ question: "x", kind: "favour" }, "agent-a")).rejects.toThrow("invalid ask kind");
    await expect((hub as any).askCreate({ question: "x", kind: "verdict" }, "agent-a")).rejects.toThrow("invalid ask kind");
    await expect((hub as any).askCreate({ question: "x", kind: "action" }, "agent-a")).rejects.toThrow("requires done_when");
    const created = await (hub as any).askCreate(
      { question: "RAY — merge PR #102", kind: "action", done_when: "mergeCommit non-null + CI green on the merge" },
      "agent-a",
    );
    expect(created.kind).toBe("action");
    expect(created.done_when).toBe("mergeCommit non-null + CI green on the merge");
    expect((hub as any).askGet({ id: asks[asks.length - 1].id }).done_when).toBe("mergeCommit non-null + CI green on the merge");
  });

  it("caps options at 8 and slices each to 200 chars", async () => {
    const { hub } = makeHub();
    const created = await (hub as any).askCreate(
      { question: "pick", kind: "decision", options: Array.from({ length: 12 }, (_, i) => `opt-${i}-${"x".repeat(220)}`) },
      "agent-a",
    );
    expect(created.options).toHaveLength(8);
    for (const o of created.options) expect(o.length).toBeLessThanOrEqual(200);
  });
});

describe("structured answers (ADR BR#2672)", () => {
  it("persists a choice-only answer (button click), composes the readable blob, and returns the machine fields", async () => {
    const { hub } = makeHub();
    const created = await (hub as any).askCreate(
      { question: "GO/NO-GO", kind: "decision", options: ["(a) GO", "(b) NO-GO"] },
      "agent-a",
    );
    const ans = await (hub as any).askAnswer({ id: created.id, choice: "(a) GO" }, "RAY");
    expect(ans.status).toBe("answered");
    expect(ans.choice).toBe("(a) GO");
    expect(ans.answer).toBe("CHOICE: (a) GO");
    const row = (hub as any).askGet({ id: created.id });
    expect(row.status).toBe("answered");
    expect(row.answer).toBe("CHOICE: (a) GO");
    expect(row.answer_choice).toBe("(a) GO");
    expect(row.answer_receipt ?? null).toBeNull();
  });

  it("validates the choice against the ask's declared options", async () => {
    const { hub } = makeHub();
    const created = await (hub as any).askCreate(
      { question: "GO/NO-GO", kind: "decision", options: ["(a) GO", "(b) NO-GO"] },
      "agent-a",
    );
    await expect((hub as any).askAnswer({ id: created.id, choice: "(c) maybe" }, "RAY"))
      .rejects.toThrow("not one of this ask's options");
  });

  it("composes choice + note + receipt and persists the receipt; a bare note still works", async () => {
    const { hub, asks } = makeHub();
    const a = await (hub as any).askCreate({ question: "deploy the fix", kind: "action", done_when: "deployment status success" }, "agent-a");
    const ans = await (hub as any).askAnswer(
      { id: a.id, answer: "shipped on the re-run", receipt: "https://github.com/state-vector/bridge/actions/runs/39869479980" },
      "RAY",
    );
    expect(ans.answer).toBe(
      "shipped on the re-run · RECEIPT: https://github.com/state-vector/bridge/actions/runs/39869479980",
    );
    expect(ans.receipt).toContain("/actions/runs/39869479980");
    const row = (hub as any).askGet({ id: asks[asks.length - 1].id });
    expect(row.answer_choice ?? null).toBeNull();
    expect(row.answer_receipt).toContain("/actions/runs/39869479980");

    const b = await (hub as any).askCreate({ question: "plain ask" }, "agent-a");
    const legacy = await (hub as any).askAnswer({ id: b.id, answer: "because the gate says so" }, "RAY");
    expect(legacy.answer).toBe("because the gate says so");
    expect((hub as any).askGet({ id: b.id }).answer_choice ?? null).toBeNull();
  });

  it("rejects a fully empty answer (no choice, note, or receipt)", async () => {
    const { hub } = makeHub();
    const created = await (hub as any).askCreate({ question: "q" }, "agent-a");
    await expect((hub as any).askAnswer({ id: created.id }, "RAY")).rejects.toThrow("answer is required");
  });
});

describe("composeStructuredAnswer", () => {
  it("orders CHOICE · note · RECEIPT and omits empty segments", () => {
    expect(composeStructuredAnswer({ choice: "(a) GO" })).toBe("CHOICE: (a) GO");
    expect(composeStructuredAnswer({ answer: "note only" })).toBe("note only");
    expect(composeStructuredAnswer({ choice: "(a) GO", answer: " with context ", receipt: "run-1" }))
      .toBe("CHOICE: (a) GO · with context · RECEIPT: run-1");
    expect(composeStructuredAnswer({})).toBe("");
  });
});
