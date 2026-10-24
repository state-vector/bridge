/**
 * BR#2844 — the generated tool table contract.
 *
 * The tools/list response and the dispatch both derive from ONE table
 * (src/mcp-tools.ts). These tests pin that generated surface against the
 * recorded production registry (packages/contracts/fixtures/mcp-tools.json)
 * and prove the orient serializer's output satisfies the orient contract.
 * The ask_answer/answer_ask divergence class is unrepresentable by
 * construction (the table type is total over ToolName) — these tests keep
 * it that way even if someone bypasses the types.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OrientResponseSchema } from "@bridge/contracts";
import { BUILD, TOOL_TABLE, toolsList } from "../src/mcp-tools.ts";

const fixture = JSON.parse(
  readFileSync(new URL("../../contracts/fixtures/mcp-tools.json", import.meta.url).pathname, "utf8"),
);

const sorted = (a: string[]) => [...a].sort();

describe("generated tools/list vs recorded registry", () => {
  it("generates exactly the recorded tool names", () => {
    const generated = toolsList(TOOL_TABLE).map((t) => t.name);
    expect(sorted(generated)).toEqual(sorted(fixture.tools.map((t: any) => t.name)));
  });

  it("generates exactly the recorded required args per tool", () => {
    for (const entry of toolsList(TOOL_TABLE)) {
      const recorded = fixture.tools.find((t: any) => t.name === entry.name);
      expect(recorded, `fixture is missing tool ${entry.name}`).toBeTruthy();
      expect(sorted((entry.inputSchema.required as string[]) ?? []), `tool ${entry.name}`).toEqual(
        sorted(recorded.required ?? []),
      );
    }
  });

  it("the dispatch handles every declared tool — and nothing else", () => {
    // forward: declared ⇒ handled (the ask_answer incident)
    for (const t of fixture.tools) {
      expect(typeof TOOL_TABLE[t.name as keyof typeof TOOL_TABLE]?.handler, t.name).toBe("function");
    }
    // inverse: handled ⇒ declared (the answer_ask twin)
    const declared = new Set(fixture.tools.map((t: any) => t.name));
    for (const name of Object.keys(TOOL_TABLE)) {
      expect(declared.has(name), `handler without a registry entry: ${name}`).toBe(true);
    }
  });
});

describe("orient serializer satisfies the orient contract", () => {
  const identity = { token_id: "at_x", label: "mac-modem-opencode", tags: [], principal: null };
  const ctx = {
    call: async (op: string, _payload: object) => {
      if (op === "orient") return orientPayload();
      if (op === "session.touch") return { session: "bridge-task-BR-2844" };
      throw new Error(`unexpected op ${op}`);
    },
    identity,
    sessionName: "bridge-task-BR-2844",
  };

  it("the orient handler's response validates against @bridge/contracts", async () => {
    const out = (await TOOL_TABLE.orient.handler({}, ctx as any)) as {
      content: Array<{ text: string }>;
    };
    const payload = JSON.parse(out.content[0].text);
    const parsed = OrientResponseSchema.parse(payload);
    expect(parsed.build).toBe(BUILD);
    expect(parsed.you.agent).toBe("mac-modem-opencode");
    expect(parsed.my_tasks[0].tags).toContain("impl");
  });

  it("a drifted DO payload (renamed my_tasks) fails the serializer loudly", async () => {
    const bad = orientPayload();
    delete (bad as any).my_tasks;
    (bad as any).myTasks = [{ id: "BR#1", title: "t", status: "todo", tags: [] }]; // the incident shape
    const drifting = {
      ...ctx,
      call: async (op: string) => (op === "orient" ? bad : { session: "s" }),
    };
    const out = (await TOOL_TABLE.orient.handler({}, drifting as any)) as {
      content: Array<{ text: string }>;
    };
    expect(() => OrientResponseSchema.parse(JSON.parse(out.content[0].text))).toThrow(/my_tasks|required/i);
  });
});

/** A realistic Durable-Object orient payload (the handler's `...o` input). */
function orientPayload() {
  return {
    project: "Superpositional",
    instructions: "BRIDGE OPERATING RULES — follow them.",
    board: { mode: "none" },
    counts: [{ type: "task", status: "todo", n: 2 }],
    open_artefacts: [
      { id: "BR#2", type: "task", title: "u", status: "todo", owner: "", updated_ts: 2 },
    ],
    my_tasks: [{ id: "BR#1", title: "t", status: "in_progress", tags: ["impl"] }],
    unclaimed_work: [
      {
        id: "BR#2",
        title: "u",
        status: "todo",
        tags: [],
        target_roles: [],
        project: "superpositional",
        updated_ts: 2,
        needs_qualification: false,
        is_claimable: true,
        is_question: false,
        meta: {},
      },
    ],
    steering: [],
    my_roles: [],
    pending_asks: [],
    gauge_debt: [],
    my_score: { score: 30, label: "poor", grade: "C" },
    action_required: [],
  };
}
