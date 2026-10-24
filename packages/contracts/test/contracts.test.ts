import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONFIG_FORBIDDEN_KEYS,
  ORIENT_REQUIRED_KEYS,
  TOOL_ARG_SCHEMAS,
  TOOL_NAMES,
  configJsonSchema,
} from "../src/index.ts";
import { AgentProvisionResponseSchema } from "../src/provision.ts";
import {
  PairPollResponseSchema,
  PairStartResponseSchema,
} from "../src/pairing.ts";
import { AskAnswerPayloadSchema, AskCreatePayloadSchema } from "../src/ask.ts";
import { OrientResponseSchema } from "../src/orient.ts";
import { z } from "zod";

const FIX = (p: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${p}`, import.meta.url), "utf8"));

const orientFixture = FIX("orient.json");
const toolsFixture = FIX("mcp-tools.json");
const pairingFixture = FIX("pairing-poll.json");
const configSchemaCheckedIn = JSON.parse(
  readFileSync(new URL("../config.schema.json", import.meta.url), "utf8"),
);

const sorted = (a: string[]) => [...a].sort();

describe("orient contract", () => {
  it("the schema's top-level key set is exactly the fixture's keys_required", () => {
    // Renaming a key in EITHER the schema or the recorded production shape
    // without the other breaks here — before it breaks a runner silently.
    expect(sorted(ORIENT_REQUIRED_KEYS)).toEqual(sorted(orientFixture.keys_required));
    expect(ORIENT_REQUIRED_KEYS).toHaveLength(14);
  });

  it("every recorded collection key exists in the schema's item shape", () => {
    const collections: Array<[string, z.ZodObject<any>]> = [
      ["counts", OrientResponseSchema.shape.counts.element],
      ["open_artefacts", OrientResponseSchema.shape.open_artefacts.element],
      ["my_tasks", OrientResponseSchema.shape.my_tasks.element],
      ["unclaimed_work", OrientResponseSchema.shape.unclaimed_work.element],
      ["steering", OrientResponseSchema.shape.steering.element],
      ["gauge_debt", OrientResponseSchema.shape.gauge_debt.element],
    ];
    for (const [key, itemSchema] of collections) {
      const recorded: string[] | "empty" = orientFixture.shape[key].item_keys;
      if (recorded === "empty") continue;
      const shapeKeys = Object.keys(itemSchema.shape);
      const missing = recorded.filter((k) => !shapeKeys.includes(k));
      expect(missing, `${key}: keys recorded from production but absent from the schema`).toEqual([]);
    }
  });

  it("every schema-required item key was recorded from production", () => {
    const collections: Array<[string, z.ZodObject<any>]> = [
      ["open_artefacts", OrientResponseSchema.shape.open_artefacts.element],
      ["my_tasks", OrientResponseSchema.shape.my_tasks.element],
      ["unclaimed_work", OrientResponseSchema.shape.unclaimed_work.element],
      ["steering", OrientResponseSchema.shape.steering.element],
    ];
    for (const [key, itemSchema] of collections) {
      const recorded: string[] = orientFixture.shape[key].item_keys;
      const required = Object.entries(itemSchema.shape)
        .filter(([, s]) => !(s as z.ZodType).isOptional())
        .map(([k]) => k);
      const unrecorded = required.filter((k) => !recorded.includes(k));
      expect(unrecorded, `${key}: schema requires keys production never emitted`).toEqual([]);
    }
  });

  it("recorded my_tasks items carry tags (the runner reads role:* from them)", () => {
    // BR#2844 finding: the runner read `tags` off my_tasks items while the
    // hub never sent them — the role-aware resume silently never fired.
    // Both sides fixed together; the fixture records the fixed shape.
    expect(orientFixture.shape.my_tasks.item_keys).toContain("tags");
  });

  it("a live-shaped orient response parses (serializer gate)", () => {
    const live = {
      project: "Superpositional",
      instructions: "BRIDGE OPERATING RULES",
      board: { mode: "none" },
      counts: [{ type: "task", status: "todo", n: 3 }],
      open_artefacts: [
        { id: "BR#1", type: "task", title: "t", status: "todo", owner: "", updated_ts: 1 },
      ],
      my_tasks: [{ id: "BR#1", title: "t", status: "in_progress", tags: ["impl"] }],
      unclaimed_work: [
        {
          id: "BR#2",
          title: "u",
          status: "todo",
          tags: [],
          target_roles: [],
          project: null,
          updated_ts: 2,
          needs_qualification: false,
          is_claimable: true,
          is_question: false,
          meta: {},
        },
      ],
      steering: [{ id: "BR#3", title: "s", tags: ["steering"], body_md: "x" }],
      my_roles: [],
      pending_asks: [],
      gauge_debt: [{ id: "BR#4", title: "g" }],
      my_score: { score: 30, label: "poor", grade: "C" },
      build: "0.3.5",
      you: { agent: "mac-modem-opencode", session: "bridge-task-BR-2844", tags: [] },
      // hub extras are tolerated — the 14 required keys are the contract
      note: "you did not name this session",
    };
    const parsed = OrientResponseSchema.parse(live);
    expect(parsed.my_tasks[0].tags).toEqual(["impl"]);
    expect((parsed as any).note).toBe("you did not name this session");
  });

  it("a renamed key (the incident) fails the parse — loud, not silent", () => {
    const drifted = { build: "0.3.5", you: { agent: "a", session: "s", tags: [] } };
    const result = OrientResponseSchema.safeParse(drifted);
    expect(result.success).toBe(false);
    if (!result.success) {
      const names = result.error.issues.map((i) => String(i.path[0]));
      expect(names).toContain("my_tasks");
      expect(names).toContain("unclaimed_work");
    }
  });
});

describe("MCP tool registry contract", () => {
  it("the contract's tool name set is exactly the recorded registry", () => {
    expect(sorted([...TOOL_NAMES])).toEqual(sorted(toolsFixture.tools.map((t: any) => t.name)));
  });

  it("each tool's generated `required` matches the recorded registry", () => {
    for (const entry of toolsFixture.tools) {
      const generated = z.toJSONSchema(TOOL_ARG_SCHEMAS[entry.name as keyof typeof TOOL_ARG_SCHEMAS]);
      expect(
        sorted((generated as any).required ?? []),
        `tool ${entry.name}: required args diverge from the recorded registry`,
      ).toEqual(sorted(entry.required));
    }
  });
});

describe("pairing contract", () => {
  it("the recorded-good start response parses", () => {
    expect(PairStartResponseSchema.parse(pairingFixture.start_response)).toBeTruthy();
  });

  it("every recorded poll status parses against the union", () => {
    for (const [name, resp] of Object.entries(pairingFixture.poll_responses)) {
      const parsed = PairPollResponseSchema.parse(resp);
      expect(parsed.status, `${name} exemplar`).toBe((resp as any).status);
    }
  });

  it("authorized poll always carries the vended credential fields", () => {
    const bad = { status: "authorized", ws: "default", label: "gw-x", tags: [] };
    expect(PairPollResponseSchema.safeParse(bad).success).toBe(false);
  });
});

describe("provision contract", () => {
  it("exists-without-secret and vended are distinct, both parse", () => {
    // BR#2878: the runner must discriminate these — exists w/o secret is
    // ONLY recoverable by rotate.
    const exists = AgentProvisionResponseSchema.parse({ exists: true, id: "at_x", label: "a" });
    expect("secret" in exists).toBe(false);
    const vended = AgentProvisionResponseSchema.parse({
      id: "at_x",
      label: "a",
      secret: "bkw_abc",
      provisioned_by: "gw-host",
    });
    expect("secret" in vended && vended.secret).toBe("bkw_abc");
    expect(AgentProvisionResponseSchema.safeParse({ exists: true, id: "at_x" }).success).toBe(false);
  });
});

describe("ask contract", () => {
  it("create payload: the ask itself + required options bound", () => {
    expect(AskCreatePayloadSchema.safeParse({ question: "" }).success).toBe(false);
    expect(
      AskCreatePayloadSchema.safeParse({ question: "Merge PR #1?", options: ["only one"] })
        .success,
    ).toBe(false);
    expect(
      AskCreatePayloadSchema.safeParse({
        to: "human",
        question: "Merge PR #1?",
        reason: "checks green but merge is human-gated",
        options: ["GO", "NO-GO"],
        artefact_id: "BR#1",
      }).success,
    ).toBe(true);
  });

  it("answer payload requires id + non-empty answer", () => {
    expect(AskAnswerPayloadSchema.safeParse({ id: "BR#1", answer: "" }).success).toBe(false);
    expect(AskAnswerPayloadSchema.safeParse({ answer: "x" }).success).toBe(false);
  });
});

describe("config file contract", () => {
  it("the checked-in JSON Schema projection matches the regenerated one", () => {
    // Drift alarm: edit the zod schema without regenerating config.schema.json → red.
    expect(configJsonSchema()).toEqual(configSchemaCheckedIn);
  });

  it("the config never has a token or principal key — by construction", () => {
    const props = Object.keys((configSchemaCheckedIn as any).properties);
    for (const forbidden of CONFIG_FORBIDDEN_KEYS) {
      expect(props, `${forbidden} must never be part of the config schema`).not.toContain(forbidden);
    }
  });
});
