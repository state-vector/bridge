import { describe, expect, it } from "vitest";
import {
  applySupersessions,
  artefactReceipt,
  askReceipt,
  buildSessionBriefProvenance,
  buildTaskBriefProvenance,
  computedReceipt,
  eventReceipt,
  resolveArtefactReceipts,
  serverDefaultReceipt,
  settingReceipt,
  type ProvenanceArtefact,
} from "../src/kb/provenance.ts";

const row = (id: string, title = `Task ${id}`, updated_ts = 1000): ProvenanceArtefact => ({
  id,
  type: "task",
  title,
  status: "in_progress",
  updated_ts,
});

describe("receipt builders (BR#542 record vocabulary)", () => {
  it("artefact receipt carries identity + recency; missing rows become tombstones", () => {
    expect(artefactReceipt(row("BR#1", "Ship it", 1234))).toEqual({
      record_type: "artefact", record_id: "BR#1", label: "Ship it", updated_ts: 1234,
    });
    const tomb = artefactReceipt(null);
    expect(tomb.unresolvable).toBe(true);
    expect(tomb.label).toBe("no longer resolvable");
  });

  it("ask, event, setting, server-default and computed receipts are all in the vocabulary", () => {
    expect(askReceipt({ id: "ask-1", from_label: "agent-x", question: "why?", created_ts: 5 })).toEqual({
      record_type: "ask", record_id: "ask-1", label: "why?", updated_ts: 5,
    });
    expect(eventReceipt({ seq: 7, ts: 9, actor: "system:reaper", op: "reassign", artefact_id: "BR#2" })).toEqual({
      record_type: "event", record_id: "seq:7", label: "system:reaper · reassign · BR#2", updated_ts: 9,
    });
    expect(settingReceipt("bootstrap_md")).toEqual({
      record_type: "setting", record_id: "bootstrap_md", label: "setting: bootstrap_md",
    });
    expect(serverDefaultReceipt("composeBootstrap", "operating rules", "0.3.4")).toEqual({
      record_type: "server-default", record_id: "composeBootstrap", label: "operating rules", updated_ts: "0.3.4",
    });
    expect(computedReceipt("scoreAgent", "computed: behaviour score")).toEqual({
      record_type: "computed", record_id: "scoreAgent", label: "computed: behaviour score",
    });
  });
});

describe("resolveArtefactReceipts (missing = tombstone + partial, never silent)", () => {
  it("maps ids to receipts", () => {
    const rows = new Map([["BR#1", row("BR#1")], ["BR#2", row("BR#2")]]);
    const s = resolveArtefactReceipts(["BR#1", "BR#2"], rows);
    expect(s.state).toBe("ok");
    expect(s.receipts.map((r) => r.record_id)).toEqual(["BR#1", "BR#2"]);
    expect(s.unresolved).toBeUndefined();
  });

  it("unresolvable ids render tombstones and flip the section partial with a gap count", () => {
    const rows = new Map([["BR#1", row("BR#1")]]);
    const s = resolveArtefactReceipts(["BR#1", "BR#404"], rows);
    expect(s.state).toBe("partial");
    expect(s.unresolved).toBe(1);
    expect(s.receipts[1]).toMatchObject({ record_id: "BR#404", unresolvable: true, label: "no longer resolvable" });
  });
});

describe("applySupersessions (Rule 8: superseding replaces superseded)", () => {
  it("swaps a superseded receipt for the superseding artefact's receipt", () => {
    const rows = new Map([["BR#9", row("BR#9", "The new spec")]]);
    const s = applySupersessions(
      { state: "ok", receipts: [artefactReceipt(row("BR#3", "The old spec")), artefactReceipt(row("BR#1"))] },
      { "BR#3": "BR#9" },
      rows,
    );
    expect(s.receipts.map((r) => r.record_id)).toEqual(["BR#9", "BR#1"]);
    expect(s.receipts[0].label).toBe("The new spec");
    expect(s.state).toBe("ok");
  });

  it("collapses duplicates when the superseding receipt is already listed", () => {
    const rows = new Map([["BR#9", row("BR#9")]]);
    const s = applySupersessions(
      { state: "ok", receipts: [artefactReceipt(row("BR#3")), artefactReceipt(row("BR#9"))] },
      { "BR#3": "BR#9" },
      rows,
    );
    expect(s.receipts.map((r) => r.record_id)).toEqual(["BR#9"]);
  });

  it("superseding record missing → tombstone + partial, not a silent drop", () => {
    const s = applySupersessions(
      { state: "ok", receipts: [artefactReceipt(row("BR#3"))] },
      { "BR#3": "BR#404" },
      new Map(),
    );
    expect(s.state).toBe("partial");
    expect(s.unresolved).toBe(1);
    expect(s.receipts[0]).toMatchObject({ record_id: "BR#404", unresolvable: true });
  });

  it("junk supersession maps and receipts outside the map pass through untouched", () => {
    const base = { state: "ok" as const, receipts: [artefactReceipt(row("BR#1"))] };
    expect(applySupersessions(base, null as any, new Map()).receipts).toEqual(base.receipts);
    expect(applySupersessions(base, { "BR#other": "BR#9" }, new Map()).receipts).toEqual(base.receipts);
  });
});

describe("buildSessionBriefProvenance (orient sections)", () => {
  const input = {
    settings: { project_name: "P", board: { mode: "external", prompt: "behave" }, bootstrap_md: "extra", roles: { impl: "pb" }, playbooks: {} },
    buildVersion: "0.3.4",
    hasBootstrapMd: true,
    kindPlaybook: { source: "server-default" as const, isCron: true },
    rolePlaybooks: [{ role: "impl", source: "setting" as const }],
    hasExternalBoard: true,
    openArtefacts: [row("BR#1"), row("BR#2")],
    myTasks: [row("BR#2")],
    unclaimedWork: [row("BR#3")],
    pendingAsks: [{ id: "ask-1", question: "hello?" }],
    actionEvents: [{ seq: 3, ts: 9, actor: "system:reaper", op: "reassign" }],
    actionTaskIds: ["BR#9"],
    hasGaugeDebt: true,
    hasScore: true,
  };

  it("every orient section gets provenance", () => {
    const p = buildSessionBriefProvenance(input);
    for (const section of ["project", "instructions", "board", "counts", "open_artefacts", "my_tasks", "unclaimed_work", "pending_asks", "action_required", "my_score"]) {
      expect(p[section], section).toBeTruthy();
    }
  });

  it("instructions receipts name the rules template + each composed source", () => {
    const receipts = buildSessionBriefProvenance(input).instructions.receipts;
    const ids = receipts.map((r) => r.record_id);
    expect(ids).toContain("composeBootstrap");
    expect(ids).toContain("bootstrap_md");
    expect(ids).toContain("DEFAULT_CRON_PLAYBOOK");
    expect(ids).toContain("roles.impl");
    expect(ids).toContain("board.prompt");
    expect(ids).toContain("gauge_debt");
    const rules = receipts.find((r) => r.record_id === "composeBootstrap");
    expect(rules?.record_type).toBe("server-default");
    expect(rules?.updated_ts).toBe("0.3.4"); // build version = recency cue
  });

  it("playbook sources resolve per entry: setting vs server-default", () => {
    const receipts = buildSessionBriefProvenance({
      ...input,
      kindPlaybook: { source: "setting", isCron: false },
    }).instructions.receipts;
    expect(receipts.find((r) => r.record_id === "playbooks.interactive")?.record_type).toBe("setting");
    expect(receipts.find((r) => r.record_id === "DEFAULT_CRON_PLAYBOOK")).toBeUndefined();
  });

  it("artefact sections carry their rows; pending_asks carry ask receipts", () => {
    const p = buildSessionBriefProvenance(input);
    expect(p.open_artefacts.receipts.map((r) => r.record_id)).toEqual(["BR#1", "BR#2"]);
    expect(p.my_tasks.receipts.map((r) => r.record_id)).toEqual(["BR#2"]);
    expect(p.pending_asks.receipts[0]).toMatchObject({ record_type: "ask", record_id: "ask-1" });
  });

  it("action_required receipts are events (reaper ops) + task ids", () => {
    const p = buildSessionBriefProvenance(input);
    const types = p.action_required.receipts.map((r) => r.record_type);
    expect(types).toContain("event");
    expect(types).toContain("artefact");
    expect(p.action_required.receipts.find((r) => r.record_id === "BR#9")).toBeTruthy();
  });

  it("counts and my_score are computed receipts with derivation names", () => {
    const p = buildSessionBriefProvenance(input);
    expect(p.counts.receipts[0]).toMatchObject({ record_type: "computed", record_id: "counts" });
    expect(p.my_score.receipts[0]).toMatchObject({ record_type: "computed", record_id: "scoreAgent" });
  });

  it("omitting optional sources drops their receipts without breaking sections", () => {
    const p = buildSessionBriefProvenance({
      settings: null,
      openArtefacts: undefined,
      pendingAsks: [{ id: "a", question: "q" }],
    });
    expect(p.instructions.receipts.map((r) => r.record_id)).toEqual(["composeBootstrap"]);
    expect(p.open_artefacts.state).toBe("ok");
    expect(p.my_score.receipts[0].label).toBe("source unknown"); // hasScore unset → explicit unknown, never silent
  });

  it("failure isolation: a junk row with a hostile getter degrades its section to source unknown, the brief still builds", () => {
    const bomb = { get id() { throw new Error("boom"); } } as any;
    const p = buildSessionBriefProvenance({
      settings: {},
      openArtefacts: [bomb],
      pendingAsks: [{ id: "a" }],
    });
    expect(p.open_artefacts.state).toBe("unknown");
    expect(p.open_artefacts.receipts[0].label).toBe("source unknown");
    expect(p.pending_asks.state).toBe("ok");
    expect(Object.keys(p).length).toBeGreaterThan(5); // other sections unaffected
  });
});

describe("buildTaskBriefProvenance (task-scoped sections)", () => {
  const input = {
    task: row("BR#1", "The task"),
    goal: [row("BR#2", "The goal")],
    steering: [row("BR#3", "The steering")],
    decisions: [row("BR#4", "The superseded decision"), row("BR#40", "The newer decision")],
    research: [row("BR#5", "The research")],
    discussions: [row("BR#6", "The question")],
    warnings: [{ seq: 8, ts: 12, actor: "system:reaper", op: "reassign", artefact_id: "BR#1" }],
    supersessions: { "BR#4": "BR#40" },
  };

  it("sections mirror the assembled brief; receipts point at exact records", () => {
    const p = buildTaskBriefProvenance(input);
    for (const section of ["task", "goal", "steering", "decisions", "research", "discussions", "warnings"]) {
      expect(p[section], section).toBeTruthy();
      expect(p[section].state).toBe("ok");
    }
    expect(p.goal.receipts[0]).toMatchObject({ record_type: "artefact", record_id: "BR#2", label: "The goal" });
    expect(p.warnings.receipts[0]).toMatchObject({ record_type: "event", record_id: "seq:8" });
  });

  it("Rule 8: a superseded decision's receipt is replaced by the superseding one (no duplicate slot)", () => {
    const p = buildTaskBriefProvenance(input);
    expect(p.decisions.state).toBe("ok");
    expect(p.decisions.receipts.map((r) => r.record_id)).toEqual(["BR#40"]);
    expect(p.decisions.receipts[0].label).toBe("The newer decision");
  });

  it("missing task → explicit source unknown (never a silent section)", () => {
    const p = buildTaskBriefProvenance({ ...input, task: null, goal: [], warnings: [] });
    expect(p.task.state).toBe("unknown");
    expect(p.task.receipts[0].label).toBe("source unknown");
  });

  it("failure isolation: junk arrays and hostile rows never break the brief", () => {
    const bomb = { get id() { throw new Error("boom"); } } as any;
    const p = buildTaskBriefProvenance({ task: row("BR#1"), goal: [bomb], steering: undefined as any, decisions: undefined as any, research: undefined as any, discussions: undefined as any, warnings: undefined as any });
    expect(p.task.state).toBe("ok");
    expect(p.goal.state).toBe("unknown");
    expect(p.steering.state).toBe("ok"); // undefined list → empty ok section, renders "no entries"
  });
});