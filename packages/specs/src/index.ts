// @bridge/specs — the contract every package codes against. Source of truth for
// the wire protocol; TS types mirror schemas/*.json (generated, see types.ts).
export * from "./types.js";
export * from "./permalink.js";

/** Kinds with hub semantics — everything else renders as generic activity. */
export const SPECIAL_KINDS = [
  "blocked",        // opens/updates a decision card
  "unblocked",      // resolves open decisions for task_id
  "completed",      // resolves open decisions for task_id
  "heartbeat",      // presence only, collapsed (60s window per task)
  "pulse",          // reserved: actor-level presence without a task
] as const;
export type SpecialKind = (typeof SPECIAL_KINDS)[number];

/** Actor namespace convention. */
export type ActorKind = "agent" | "human" | "system";
export const actorKind = (actor: string): ActorKind =>
  actor.startsWith("agent:") ? "agent"
  : actor.startsWith("human:") ? "human"
  : actor.startsWith("system:") ? "system"
  : "system";

/** Hub-enforced limits (mirror of packages/worker/src/do.js normalize()). */
export const LIMITS = {
  id: 200,
  source: 40,
  kind: 40,
  board: 60,
  task_id: 100,
  actor: 80,
  actor_label: 80,
  title: 300,
  batch: 1000,
  heartbeatWindowMs: 60_000,
  presenceActiveWindowMs: 10 * 60_000,
  eventRetention: 5000,
  stateEvents: 200,
  stateDecisions: 100,
  statePresence: 200,
} as const;
