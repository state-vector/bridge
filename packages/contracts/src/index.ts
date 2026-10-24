/**
 * @bridge/contracts — the single source for every cross-runtime shape.
 *
 * One package, zod-only, imported by the hub worker, tested against
 * checked-in production fixtures, and mirrored by the Rust runner through
 * those fixtures (BR#2844). Change a shape here, update the fixture AND
 * every consumer in the same PR — CI enforces it.
 */
export * from "./orient.ts";
export * from "./mcp.ts";
export * from "./table.ts";
export * from "./pairing.ts";
export * from "./provision.ts";
export * from "./ask.ts";
export * from "./config.ts";
