/**
 * The config file contract (`~/.bridge/config.json`) — BR#2844, and the
 * "one schema" leg of the done-bar: the single-writer module (BR#2840,
 * `packages/desktop/src-tauri/src/store.rs`) serializes the versioned
 * DispatchConfig through this shape, and a checked-in JSON Schema
 * projection (`config.schema.json`) is drift-alarmed against it from both
 * sides: the TS test regenerates the projection and diffs it; the Rust
 * store test asserts the serialized key set matches it.
 *
 * Laws mirrored from store.rs:
 * - `schema_version` rides every file (CONFIG_SCHEMA_VERSION = 2 today);
 *   loaders warn loudly on files from the future.
 * - NEVER the token: it lives in the OS keychain. `principal` is its own
 *   write-once file since BR#2840 — neither key may appear in a written
 *   config (the Rust test fails the build if either reappears).
 * - Legacy fields (`models`, `agents` maps, array `backends`) are accepted
 *   on LOAD and folded in; the WRITTEN shape is the dict form below.
 */
import { z } from "zod";

/** Keys that must never appear in a serialized config file. */
export const CONFIG_FORBIDDEN_KEYS = ["token", "principal"] as const;

export const BackendConfigSchema = z.looseObject({
  bin: z.string().optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  /** Transport: "acp" (default for opencode) | "stdio". */
  mode: z.string().optional(),
});
export type BackendConfig = z.infer<typeof BackendConfigSchema>;

/** The serialized config shape — what save_config writes, what load_config reads. */
export const BridgeConfigSchema = z.looseObject({
  schema_version: z.number().int(),
  url: z.string(),
  workdir: z.string(),
  agent: z.string().nullable(),
  model: z.string().nullable(),
  backend: z.string().nullable(),
  poll_secs: z.number().int(),
  timeout_mins: z.number().int(),
  opencode_bin: z.string(),
  label: z.string().nullable(),
  agent_name: z.string().nullable(),
  ws: z.string().nullable(),
  gateway: z.boolean().nullable(),
  max_sessions: z.number().int(),
  report_minutes: z.number().int().nullable(),
  isolate: z.boolean(),
  backends: z.record(z.string(), BackendConfigSchema),
  // legacy (accepted on load, folded into backends, never written once empty)
  models: z.record(z.string(), z.string()).optional(),
  agents: z.record(z.string(), z.string()).optional(),
});
export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

/** The always-present keys of a saved config (the `required` set). */
export const CONFIG_REQUIRED_KEYS = (
  Object.keys(BridgeConfigSchema.shape) as Array<keyof typeof BridgeConfigSchema.shape & string>
).filter((k) => BridgeConfigSchema.shape[k].isOptional() !== true);

/** JSON Schema projection of the config — regenerate `config.schema.json`
 *  whenever this output changes (the test diffs it; stale = red). */
export function configJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(BridgeConfigSchema, { io: "input" }) as Record<string, unknown>;
}
