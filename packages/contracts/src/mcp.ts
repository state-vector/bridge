/**
 * The MCP tool contract — the 16 tools the hub serves, with their argument
 * schemas — BR#2844.
 *
 * The incident: the registry declared `ask_answer` while the dispatch
 * implemented `answer_ask`. The tool worked the whole time; the names just
 * diverged between two hand-maintained lists.
 *
 * This module ends the class: these schemas are THE single source. The
 * hub's tool table (`packages/worker/src/mcp-tools.ts`) takes its `schema`
 * column from here — the tools/list response is GENERATED from that table
 * (via `mcpToolsList`), and the dispatch switch IS the table. A tool
 * declared without a handler is now a TypeScript compile error (the table
 * type is total over ToolName), and this module's fixture test pins the
 * generated surface against `fixtures/mcp-tools.json`.
 */
import { z } from "zod";

/** Every tool name the hub has ever advertised, from the recorded fixture. */
export const TOOL_NAMES = [
  "answer_ask",
  "ask_agent",
  "asks",
  "create_artefact",
  "get_artefact",
  "get_history",
  "link_artefacts",
  "list_agents",
  "log_progress",
  "orient",
  "related_artefacts",
  "search_knowledge",
  "session_alive",
  "stats",
  "transition",
  "update_artefact",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * Per-tool argument schemas. Loose objects: the Durable Object stays the
 * authority for unknown-key rejection, and gateway/session plumbing rides
 * keys the schemas deliberately tolerate. `required` in the generated JSON
 * Schema is what the fixture pins.
 */
export const TOOL_ARG_SCHEMAS = {
  orient: z.looseObject({
    session: z
      .string()
      .optional()
      .describe("unique session name (per agent) — required-ish: omit and the hub nags you"),
  }),
  search_knowledge: z.looseObject({
    q: z.string(),
    type: z.string().optional(),
    limit: z.number().int().max(100).optional(),
  }),
  get_artefact: z.looseObject({ id: z.string() }),
  create_artefact: z.looseObject({
    type: z.string(),
    title: z.string().max(300),
    body_md: z.string().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
    owner: z.string().optional(),
    project: z.string().optional(),
    qualified: z.boolean().optional(),
    await: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    roles: z.array(z.string()).optional(),
    session: z.string().optional(),
  }),
  update_artefact: z.looseObject({
    id: z.string(),
    title: z.string().optional(),
    body_md: z.string().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
    tags: z.array(z.string()).optional(),
    roles: z.array(z.string()).optional(),
  }),
  transition: z.looseObject({
    id: z.string(),
    to: z.string(),
    note: z.string().optional(),
    unblock_condition: z.string().optional(),
    class: z.enum(["subprocess"]).optional(),
    budget_minutes: z.number().int().max(1440).optional(),
    replacement_id: z.string().optional(),
  }),
  link_artefacts: z.looseObject({
    src: z.string(),
    relation: z.string(),
    dst: z.string(),
  }),
  list_agents: z.looseObject({}),
  stats: z.looseObject({}),
  related_artefacts: z.looseObject({
    id: z.string(),
    limit: z.number().int().max(50).optional(),
  }),
  session_alive: z.looseObject({ id: z.string() }),
  log_progress: z.looseObject({
    id: z.string(),
    note: z.string(),
    will: z.string().optional(),
    grace_minutes: z.number().int().max(60).optional(),
    sentiment: z
      .enum(["going_well", "neutral", "struggling", "converging", "diverging"])
      .optional(),
    completion_pct: z.number().int().min(0).max(100).optional(),
    confidence_pct: z.number().int().min(0).max(100).optional(),
    risk_pct: z.number().int().min(0).max(100).optional(),
    context_pct: z.number().int().min(0).max(100).optional(),
  }),
  get_history: z.looseObject({
    id: z.string(),
    limit: z.number().int().max(200).optional(),
  }),
  ask_agent: z.looseObject({
    to: z.string().optional(),
    question: z.string().max(240),
    reason: z.string(),
    details: z.string().optional(),
    options: z.array(z.string()).min(2).max(8),
    artefact_id: z.string().optional(),
  }),
  asks: z.looseObject({}),
  answer_ask: z.looseObject({ id: z.string(), answer: z.string() }),
} as const satisfies Record<ToolName, z.ZodType>;
