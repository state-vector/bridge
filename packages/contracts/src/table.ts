/**
 * The generated tool table — BR#2844 item 3.
 *
 * ONE table of { name, schema, description, handler } rows in the hub; the
 * tools/list response AND the dispatch are both derived from it. The
 * registry/dispatch divergence class (`ask_answer` declared, `answer_ask`
 * implemented) becomes unrepresentable: the table type is total over
 * ToolName, so a declared-but-unhandled tool (or a handler with no
 * declaration) is a compile error, and the fixture test pins the generated
 * tools/list against the recorded registry.
 */
import { z } from "zod";
import { TOOL_ARG_SCHEMAS, TOOL_NAMES, type ToolName } from "./mcp.ts";

/** The context every handler receives (structurally the hub's Ctx). */
export interface ToolCtx {
  call: (op: string, payload: object) => Promise<any>;
  identity: { token_id: string; label: string; tags: string[]; principal: string | null };
  sessionName: string;
}

export interface ToolDef {
  description: string;
  /** Argument schema — ALWAYS the contract copy from TOOL_ARG_SCHEMAS. */
  schema: z.ZodType;
  handler: (args: any, ctx: ToolCtx) => unknown | Promise<unknown>;
}

export type ToolTable = { [N in ToolName]: ToolDef };

/** Compile-time completeness is the whole point — never annotate the return. */
export function defineToolTable(table: {
  [N in keyof typeof TOOL_ARG_SCHEMAS]: ToolDef;
}): ToolTable {
  return table;
}

/**
 * The tools/list payload, generated from the table. `inputSchema` is the
 * contract schema projected to JSON Schema — this is what agents see, and
 * what the fixture test pins (name set + per-tool `required`).
 */
export function mcpToolsList(table: ToolTable): Array<{
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return TOOL_NAMES.map((name) => ({
    name,
    description: table[name].description,
    inputSchema: z.toJSONSchema(table[name].schema) as Record<string, unknown>,
  }));
}
