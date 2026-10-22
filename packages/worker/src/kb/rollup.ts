/**
 * Blocker rollup — cluster blocked cards that share one machine-detectable
 * root cause and plan ONE boosted ROOT BLOCKER task for them (BR#2645,
 * steering BR#2643). Pure functions: no storage, no I/O — the watchdog sweep
 * in do.ts executes the plan, and rollup.test.ts exercises the law directly.
 *
 * Root keys (derived from meta.blocked, unblock_condition first — it is the
 * machine-checkable exit condition — then the reason):
 *   pr:<owner/repo>#<n>   a github.com pull/NNN URL — the one unmerged PR
 *                         every queued card waits on;
 *   main-red              red/broken/failing main language — the
 *                         never-merge-onto-red-main class (BR#551).
 * Anything else is not machine-detectable → null (humans cluster those).
 */

export const ROOT_BLOCKER_TAG = "blocker";
/** Fewer than this many queued cards and the noise of a root task outweighs the signal. */
export const ROOT_BLOCKER_MIN_CLUSTER = 3;

export interface BlockedMeta {
  reason?: string;
  unblock_condition?: string;
}

export interface RollupCard {
  id: string;
  title?: string;
  blocked?: BlockedMeta | null;
  /** the card's current root pointer (meta.root_blocker), if any */
  root_blocker?: string | null;
}

export interface RollupRoot {
  id: string;
  status: string;
  /** meta.root_key — the cluster key this root was created for */
  root_key?: string | null;
}

export interface RootBlockerPlan {
  /** new roots to create: one per key, with the queued member ids */
  creates: Array<{ key: string; members: string[] }>;
  /** cards to point at a root; root === null means "the newly created root for root_key" */
  stamps: Array<{ id: string; root_key: string; root: string | null }>;
}

const PR_URL =
  /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/i;
// "red/broken/failing main" (either order, nearby, same sentence-ish stretch)
const MAIN_RED =
  /\bmain\b[^.;]{0,60}?\b(?:reds?|broken|failing)\b|\b(?:reds?|broken|failing)\b[^.;]{0,60}?\bmain\b/;

const OPEN_STATUSES = new Set(["todo", "in_progress", "in_review", "blocked"]);

/** Machine root key for a blocked card's meta.blocked — or null when the
 *  blocker doesn't name a machine-detectable root. A PR URL wins over
 *  main-red language (the specific root beats the ambient one). */
export function rootBlockerKey(b: BlockedMeta | null | undefined): string | null {
  if (!b) return null;
  const cond = String(b.unblock_condition ?? "");
  const reason = String(b.reason ?? "");
  const m = PR_URL.exec(cond) ?? PR_URL.exec(reason);
  if (m) {
    // GitHub owner/repo is case-insensitive — normalise so the same PR
    // spelled two ways still clusters together.
    const repo = `${m[1]}/${m[2]}`.toLowerCase();
    return `pr:${repo}#${m[3]}`;
  }
  if (MAIN_RED.test(`${cond} ${reason}`.toLowerCase())) return "main-red";
  return null;
}

export function rootBlockerTitle(key: string, n: number): string {
  return `ROOT BLOCKER (${key}) — ${n} tasks queued (investigate → fix → one approval)`;
}

/** The root task's body: what is queued, the ask contract, and the done-when. */
export function rootBlockerBody(
  key: string,
  cards: Array<{ id: string; title?: string }>,
): string {
  const isMainRed = key === "main-red";
  const doneWhen = isMainRed
    ? "main is ancestry-green again (CI green on main and every open PR rebased onto it)"
    : `the blocking PR (${key.slice(3)}) is merged`;
  const list = cards
    .map((c) => `- ${c.id}${c.title ? ` — ${c.title}` : ""}`)
    .join("\n");
  return [
    `Auto-created by the watchdog sweep: ${cards.length} blocked cards share one machine-detectable root cause (\`${key}\`).`,
    isMainRed
      ? "Root cause class: never-merge-onto-red-main (BR#551) — main is red/broken/failing, so every fix PR queues behind restoring main."
      : "Root cause class: one unmerged PR that every queued card names as its unblock condition.",
    "",
    "## Queued cards",
    list,
    "",
    "## Ask contract",
    "Investigate → fix → ONE approval. Work the root cause here (not on the queued cards); when the fix needs a human sign-off, file a single ask that leads with the decision — summary (what happened), why_escalated (which gate/authority), decision (the choice, each option with its receipt condition). One approval unblocks every queued card; do not ask each card separately.",
    "",
    "## Done when",
    `Root cause gone, with receipts: ${doneWhen}. Closing requires evidence (CI run URLs / merged-PR state) — the sweep never auto-closes this task, and a later cluster of the same root opens a NEW root instead of reusing this one.`,
  ].join("\n");
}

/** Plan the rollup for one sweep pass. Deterministic, side-effect free:
 *  - only blocked cards with a machine root key participate;
 *  - clusters below the threshold are left alone;
 *  - a cluster with an OPEN root for its key reuses that root (creates: none);
 *  - DONE/SUPERSEDED roots are never reused — a later cluster opens a new one;
 *  - cards already pointing at an open root are skipped, never re-stamped —
 *    which is what makes re-running the sweep idempotent. */
export function planRootBlockers(
  cards: RollupCard[],
  roots: RollupRoot[],
  minCluster: number = ROOT_BLOCKER_MIN_CLUSTER,
): RootBlockerPlan {
  const statusById = new Map(roots.map((r) => [r.id, r.status]));
  const isOpenRoot = (id: string | null | undefined) =>
    !!id && statusById.has(id) && OPEN_STATUSES.has(statusById.get(id) as string);

  const openRootByKey = new Map<string, string>();
  for (const r of roots) {
    if (!isOpenRoot(r.id) || !r.root_key) continue;
    if (!openRootByKey.has(r.root_key)) openRootByKey.set(r.root_key, r.id);
  }

  const clusters = new Map<string, string[]>();
  const byId = new Map<string, RollupCard>();
  for (const c of cards) {
    byId.set(c.id, c);
    const key = rootBlockerKey(c.blocked);
    if (!key) continue;
    let list = clusters.get(key);
    if (!list) clusters.set(key, (list = []));
    list.push(c.id);
  }

  const plan: RootBlockerPlan = { creates: [], stamps: [] };
  for (const key of [...clusters.keys()].sort()) {
    const members = clusters.get(key) as string[];
    if (members.length < minCluster) continue;
    const openRoot = openRootByKey.get(key) ?? null;
    if (!openRoot) plan.creates.push({ key, members });
    for (const id of members) {
      if (isOpenRoot(byId.get(id)?.root_blocker)) continue; // already queued — leave it alone
      plan.stamps.push({ id, root_key: key, root: openRoot });
    }
  }
  return plan;
}
