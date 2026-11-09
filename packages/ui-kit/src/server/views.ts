import type { GatewayDispatch } from "@bridge/contracts";
import type { Decision, EventView, Presence } from "@bridge/specs";
import { mergeCompletesTask, StartupWaitSchema, startupWaitReason } from "@bridge/contracts";
import { relTime } from "../relTime";

/** The API doc says EventView.ts is ms epoch; tolerate seconds-valued ts from early adapters. */
export function normTs(ts: number): number {
  return ts > 0 && ts < 10_000_000_000 ? ts * 1000 : ts;
}

/** Relative time from possibly-seconds ts — the kit formatter + normTs. */
export function rel(ms: number): string {
  return relTime(normTs(ms));
}

export function clock(ms: number): string {
  return new Date(normTs(ms)).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * Client-side ranking (hub publishes open decisions unranked):
 * needs_input before diagnostic, then most recently updated first.
 */
export function rankDecisions(decisions: Decision[]): Decision[] {
  return [...decisions].sort((a, b) => {
    const k = (b.kind === "needs_input" ? 1 : 0) - (a.kind === "needs_input" ? 1 : 0);
    if (k) return k;
    return (b.updated_ts ?? 0) - (a.updated_ts ?? 0);
  });
}

export function actorEvents(events: EventView[], actorId: string, limit = 5): EventView[] {
  return events.filter((e) => e.actor === actorId).slice(0, limit);
}

export function latestTaskId(events: EventView[], actorId: string): string | null {
  return events.find((e) => e.actor === actorId && e.task_id)?.task_id ?? null;
}

export function boardsOf(decisions: Decision[], events: EventView[]): string[] {
  const set = new Set<string>();
  for (const d of decisions) if (d.board) set.add(d.board);
  for (const e of events) if (e.board) set.add(e.board);
  return [...set].sort();
}

export function myAnswers(events: EventView[], me: string): EventView[] {
  return events.filter((e) => e.actor === me && (e.kind === "unblocked" || e.kind === "completed"));
}

export function presenceLabel(p: Presence): string {
  return p.label && p.label !== p.id ? p.label : (p.id.split(":")[1] ?? p.id);
}

/** What the task IS: question / verify / analysis / research / impl.
 *  Structural: type + roles column (BR#2983) — tags are inert user labels
 *  and can no longer change the kind. */
export function kindOf(task: { type?: string; roles?: string[] | null; tags?: string[] | null; meta?: any }): string {
  const m = task.meta ?? {};
  if (task.type === "question" || m.kind === "question") return "question";
  const roles = (task.roles ?? []) as string[];
  if (roles.includes("review") || m.kind === "review") return "verify";
  if (roles.includes("analysis") || m.kind === "analysis") return "analysis";
  if ((task.tags ?? []).includes("research")) return "research";
  return "impl";
}

/** Task references (BR#12, TASK-007) inside arbitrary text — for hyperlinking. */
export const TASK_REF_RE = /\b(BR#\d+|TASK-\d+)\b/g;

/* ---- blocked-park classes shared by Top + Backlog (2026-10-24 spec, Ray) ---- */

/** Watchdog machine parks (churn guard / rework loop): nobody — human or
 *  agent — can action these right now; the owning agent resumes or the park
 *  lapses. Top excludes them; Backlog files them under TIMEOUT. */
export const TIMEOUT_BLOCK_RX = /rework loop|churn guard/i;

/* ---- BR#2893 churn-park pattern: the client mirror of the hub's
 * ---- blockedParkVerdict (worker kb/machine.ts). The hub drains dead parks
 * ---- automatically; the board files them under the Timeout exit class.
 * ---- Textual patterns MUST stay identical to the hub — change both
 * ---- together. */

/** Churn-guard stamp, either field: the reason ("churn guard: released N
 *  times…") or the boilerplate exit condition ("read the task history…").
 *  Superset of TIMEOUT_BLOCK_RX — legacy parks carried the boilerplate on the
 *  exit condition only. */
export const CHURN_PARK_RX = /read the task history \(get_history\) and the last gate error|rework loop|churn guard/i;

/** Churn-park test kept for Top's actionable admission filter. */
export function isTimeoutBlock(t: { status?: string; meta?: any }): boolean {
  return t.status === "blocked" && TIMEOUT_BLOCK_RX.test(String(t.meta?.blocked?.reason ?? ""));
}

/* ---- exit-condition classes (2026-10-29 spec, Ray): Top shows the
 * ---- actionable fleet only; every parked card files in Backlog under
 * ---- WHAT IT AWAITS. The class reads the card's TYPED await_event first
 * ---- (BR#3578 closed set — the machine leg the hub re-checks), then the
 * ---- prose unblock condition as fallback. */

export interface ExitClass {
  key: string;
  title: string;
  icon: string;
  /** Who or what unblocks cards in this section ("You (answer ask)", "System (merge train)", etc.). */
  unblockedBy: string;
  /** Visual tone for the unblocker chip: urgent = You, warn = Agent, scope = System event. */
  unblockedTone: "urgent" | "warn" | "scope";
  note: string;
}

const GH_ISSUE_RX = /github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+|\bGH#\d+\b/i;
const RED_MAIN_RX = /\bred\s+main\b|\bmain\s+is\s+red\b|stop-the-line|\buntil main (is )?green\b|\bline is green\b/i;
const DATE_RX = /\b(20\d{2})-(\d{2})-(\d{2})(?!\d)/;
/** BR#4962: the typed Awaiting review park a coverage bounce stamps
 *  (per accepted BR#4960 — no asks; the parked card IS the visibility). */
const AWAITING_RX = /^Awaiting review \(verdict /i;

/** BR#6330 / BR#6395 — ONE merge classification: the typed merge_train phase
 *  is the single source of "awaiting merge" (decision BR#6330). Pure local
 *  readers of the SAME field the hub owns (meta.merge_train.state — the closed
 *  set lives canonically in @bridge/contracts MergeTrainPhaseSchema; ui-kit
 *  does not depend on that package for bundle isolation, so this mirrors it
 *  and MUST stay in sync with contracts mergePhaseOf/isAwaitingMerge).
 *  Prose reasons and the pr_merged await_event NO LONGER classify a card
 *  into the merge group — a card cannot enter the class by text or by an
 *  upstream pr_merged wait with no train slot. */
const MERGE_TRAIN_PHASES = new Set(["queued", "awaiting-ci", "bounced", "conflicting", "awaiting", "unbound", "base-red-park", "landed"]);
export function mergePhaseOf(t: { meta?: any }): string | null {
  const st = String(t?.meta?.merge_train?.state ?? "");
  return st && MERGE_TRAIN_PHASES.has(st) ? st : null;
}
/** exported for the pinned test (BR#6330) — the one predicate. */
export function isAwaitingMerge(t: { meta?: any }): boolean {
  const p = mergePhaseOf(t);
  return p === "queued" || p === "awaiting-ci";
}

/** The exit-class table — single source; exitClassOf returns entries from it. */
export const EXIT_CLASSES: Record<string, ExitClass> = {
  coordination: {
    key: "coordination",
    title: "Waiting for another agent",
    icon: "◉",
    unblockedBy: "Bridge (agent coordination)",
    unblockedTone: "scope",
    note: "Bridge is coordinating with another agent. No action is needed from you.",
  },
  ask: {
    key: "ask",
    title: "Awaiting you — ask pending",
    icon: "⚑",
    unblockedBy: "You (answer ask in For Me)",
    unblockedTone: "urgent",
    note: "a human ask holds the card; answer it and the task auto-resumes.",
  },
  awaiting: {
    key: "awaiting",
    title: "Awaiting review — force-review",
    icon: "◉",
    unblockedBy: "You (force-review on card)",
    unblockedTone: "urgent",
    note: "coverage-bounced park (BR#4960: no asks): the accepted verdict lapsed at a new head — force-review from the card: approve re-anchors the verdict and re-queues the train, changes requested bounce impl.",
  },
  verify: {
    key: "verify",
    title: "Awaiting PR verification",
    icon: "✓",
    unblockedBy: "Agent (fresh verify session)",
    unblockedTone: "warn",
    note: "in review — a fresh verify session must rule before the train can queue it.",
  },
  merge: {
    key: "merge",
    title: "Awaiting PR merge — train",
    icon: "⇥",
    unblockedBy: "System (merge train)",
    unblockedTone: "scope",
    note: "impl & verification complete; holds a live merge-train slot (typed merge_train phase queued/awaiting-ci — BR#6330: the one classification). The train merges the PR, waits for main CI, and closes the card.",
  },
  conflict: {
    key: "conflict",
    title: "Awaiting PR rebase — conflict on train",
    icon: "⚡",
    unblockedBy: "Agent (mechanical rebase)",
    unblockedTone: "warn",
    note: "PR conflicts with main (typed phase conflicting — BR#6348); an agent claims the card, rebases onto origin/main, pushes signed, and re-verifies.",
  },
  repair: {
    key: "repair",
    title: "PR repair — Bridge owns recovery",
    icon: "↻",
    unblockedBy: "Bridge (schedule repair and verification)",
    unblockedTone: "warn",
    note: "the PR is unbound or bounced; an agent must resolve the recorded defect and obtain a fresh verify accept before it can enter the train.",
  },
  pr: {
    key: "pr",
    title: "Awaiting PR dependency",
    icon: "⇻",
    unblockedBy: "PR owner merges; system observes the receipt",
    unblockedTone: "scope",
    note: "waiting on the named PR, without a live train slot. Its owner must deliver it; the hub needs a merge receipt before it can schedule continuation. This does not mean the PR must merge outside a train.",
  },
  ci: {
    key: "ci",
    title: "Awaiting CI",
    icon: "◔",
    unblockedBy: "System (CI check probe)",
    unblockedTone: "scope",
    note: "waiting on check runs (pr_checks_green / run_success); daemon proxy probe flips the park when checks go green.",
  },
  deploy: {
    key: "deploy",
    title: "Awaiting deploy",
    icon: "▲",
    unblockedBy: "Deployment executor; hub observes commit",
    unblockedTone: "scope",
    note: "waiting on a hub deploy at the named commit.",
  },
  task: {
    key: "task",
    title: "Awaiting another task",
    icon: "◈",
    unblockedBy: "System (when target BR# completes)",
    unblockedTone: "scope",
    note: "waiting on another card's done/answer (br_done / br_answered); hub proxy watch flips it when that card finishes.",
  },
  issue: {
    key: "issue",
    title: "Awaiting GitHub issue",
    icon: "⊙",
    unblockedBy: "System / Agent (upstream issue close)",
    unblockedTone: "scope",
    note: "waiting on an upstream issue closing.",
  },
  time: {
    key: "time",
    title: "Awaiting a date / timer",
    icon: "◷",
    unblockedBy: "System (timer elapses)",
    unblockedTone: "scope",
    note: "time-gated — hub proxy watch flips it when the clock passes.",
  },
  main: {
    key: "main",
    title: "Awaiting green main",
    icon: "✖",
    unblockedBy: "System / Agent (main-red root fix)",
    unblockedTone: "scope",
    note: "red-main / stop-the-line hold — resumes when the root-blocker fix lands and main is green.",
  },
  other: {
    key: "other",
    title: "Blocked — other",
    icon: "▪",
    unblockedBy: "You or Agent (resolve on card)",
    unblockedTone: "warn",
    note: "no typed leg matched — open the card to resolve or re-scope.",
  },
  executor: {
    key: "executor",
    title: "Waiting for executor recovery",
    icon: "◷",
    unblockedBy: "System (verified executor readiness)",
    unblockedTone: "warn",
    note: "No worker has started. Readiness reconciliation owns the exit; this is not task churn.",
  },
  retry: {
    key: "retry", title: "Blocked — retry budget exhausted", icon: "↻",
    unblockedBy: "Verified recovery or a changed approach", unblockedTone: "warn",
    note: "A retry count does not establish the cause. An eligible recovery permit or a new, bounded strategy can make the task eligible.",
  },
  operations: {
    key: "operations", title: "Blocked — unresolved operations", icon: "▪",
    unblockedBy: "Reconcile the previous operation", unblockedTone: "warn",
    note: "A receipt must establish what the previous attempt did before Bridge can dispatch another.",
  },
  prerequisite: {
    key: "prerequisite", title: "Blocked — task prerequisites", icon: "▪",
    unblockedBy: "Resolve the prerequisite on the card", unblockedTone: "warn",
    note: "A review, prerequisite, or lifecycle condition must clear before dispatch.",
  },
  gateway: {
    key: "gateway", title: "Waiting for a gateway", icon: "◷",
    unblockedBy: "A ready, compatible gateway", unblockedTone: "scope",
    note: "The task has no other recorded admission hold. A compatible gateway must become ready.",
  },
  timeout: {
    key: "timeout",
    title: "Timeout — churn parks",
    icon: "⏱",
    unblockedBy: "System (recorded cooldown) or You (Release)",
    unblockedTone: "scope",
    note: "the watchdog drains these to the pool automatically (BR#2893); Release (or Release all) to put one back now — protected parks refuse and say why.",
  },
};

/** Render order for the Backlog exit-class groups: human levers first, then
 *  machine gates by blast radius, parks last. */
export const EXIT_CLASS_ORDER = ["ask", "awaiting", "verify", "coordination", "merge", "conflict", "repair", "pr", "ci", "deploy", "task", "issue", "executor", "time", "main", "retry", "operations", "prerequisite", "gateway", "other", "timeout"];

/** Blocked (or in_review) card → the exit class Backlog groups it under.
 *  First match wins; the typed phase and await_event outrank prose. */
export function dispatchExitClass(dispatch: GatewayDispatch): ExitClass {
  if (dispatch.kind === "gateway_unavailable") return EXIT_CLASSES.gateway;
  if (dispatch.kind !== "held") return EXIT_CLASSES.other;
  if (dispatch.reasons.includes("unknown_operations")) return EXIT_CLASSES.operations;
  if (dispatch.reasons.includes("retry_budget")) return EXIT_CLASSES.retry;
  return EXIT_CLASSES.prerequisite;
}

export function exitClassOf(t: { id?: string; status?: string; meta?: any }): ExitClass {
  const m = t.meta ?? {};
  if (StartupWaitSchema.safeParse(m.startup_wait).success) return EXIT_CLASSES.executor;
  const b = m.blocked ?? {};
  const reason = String(b.reason ?? "");
  const unblock = String(b.unblock_condition ?? "");
  const ev = b.await_event?.event as string | undefined;
  if (t.status === "in_review") return EXIT_CLASSES.verify;
  if (t.status !== "blocked") return EXIT_CLASSES.other;
  if (m.execution_wait?.kind === "capability" && m.blocked?.await_event?.event === "executor_capability"
    && m.blocked.await_event.id === t.id
    && Array.isArray(m.execution_blockers) && m.execution_blockers.length > 0
    && m.execution_blockers.every((blocker: { kind?: string }) => blocker.kind === "capability_unavailable" || blocker.kind === "executor_not_ready"))
    return EXIT_CLASSES.gateway;
  if (CHURN_PARK_RX.test(reason) || CHURN_PARK_RX.test(unblock)) return EXIT_CLASSES.timeout;
  // the Awaiting park outranks the typed leg it preserves (BR#4962): the
  // pr_merged await_event rides along on an Awaiting park, but the HUMAN
  // force-review owns the exit, not the proxy
  if (AWAITING_RX.test(reason)) return EXIT_CLASSES.awaiting;
  if (ev === "ask" || m.awaiting_ask?.ask_id) return ["agent_coordination", "executor_coordination"].includes(m.awaiting_ask?.route?.kind) ? EXIT_CLASSES.coordination : EXIT_CLASSES.ask;
  // Current dependencies outrank the historical bounce that led to this park.
  if (ev === "br_done" || ev === "br_answered") return EXIT_CLASSES.task;
  if (!mergeCompletesTask(m) && (ev === "pr_merged" || ev === "br_pr_merged")) return EXIT_CLASSES.pr;
  // BR#6330 / BR#6395 — ONE classification: ONLY the typed merge_train phase
  // (queued|awaiting-ci) enters EXIT_CLASSES.merge ("Awaiting PR merge — train").
  // Non-train pr_merged / br_pr_merged waits (upstream PR dependencies with
  // phase===null, or unbound/bounced PRs) classify under EXIT_CLASSES.pr so
  // the train section matches the live train queue by construction.
  const phase = mergePhaseOf(t);
  if (phase === "awaiting") return EXIT_CLASSES.awaiting;
  if (phase === "queued" || phase === "awaiting-ci") return EXIT_CLASSES.merge;
  if (phase === "conflicting") return EXIT_CLASSES.conflict;
  if (phase === "base-red-park") return EXIT_CLASSES.main;
  if (phase === "unbound" || phase === "bounced") return EXIT_CLASSES.repair;
  if (ev === "pr_merged" || ev === "br_pr_merged") return EXIT_CLASSES.pr;
  if (ev === "pr_checks_green" || ev === "run_success") return EXIT_CLASSES.ci;
  if (ev === "deployed") return EXIT_CLASSES.deploy;
  if (ev === "br_done" || ev === "br_answered") return EXIT_CLASSES.task;
  if (ev === "issue_closed") return EXIT_CLASSES.issue;
  if (ev === "time") return EXIT_CLASSES.time;
  // prose fallback — no typed leg on the card
  if (GH_ISSUE_RX.test(unblock)) return EXIT_CLASSES.issue;
  if (RED_MAIN_RX.test(unblock) || RED_MAIN_RX.test(reason)) return EXIT_CLASSES.main;
  if (DATE_RX.test(unblock)) return EXIT_CLASSES.time;
  return EXIT_CLASSES.other;
}

const MACHINE_PROXY_PREFIX_RX = /^Machine proxy(?:\s*\([^)]*\))?:\s*/i;
const STRAND_WRAPPER_RX = /^merge-train:\s*queued\s*—\s*strand re-board\s*\(BR#6163\):[^;]*;\s*prior park:\s*/i;

/** Clean human-readable summary of why a card is blocked and what specific
 *  actor/event unblocks it, for per-row rendering in BacklogView (BR#6395). */
export function blockedSummaryOf(t: { status?: string; meta?: any }): {
  whatUnblocks: string;
  unblockedTone: "urgent" | "warn" | "scope";
  whyBlocked: string;
} {
  const cls = exitClassOf(t);
  const m = t?.meta ?? {};
  const startup = StartupWaitSchema.safeParse(m.startup_wait);
  if (startup.success) return {
    whatUnblocks: startup.data.phase === "waiting_executor" ? "System: verified compatible executor readiness" : "Agent: repair startup prerequisite; system: verify changed readiness",
    unblockedTone: startup.data.attention_at !== null ? "urgent" : "warn",
    whyBlocked: startupWaitReason(startup.data),
  };
  const b = m.blocked ?? {};
  const evObj = b.await_event ?? {};
  const ev = evObj.event as string | undefined;
  const phase = mergePhaseOf(t);
  const rawReason = String(b.reason ?? "").replace(STRAND_WRAPPER_RX, "").trim();
  const rawUnblock = String(b.unblock_condition ?? "").replace(MACHINE_PROXY_PREFIX_RX, "").trim();

  const prNum = Number(evObj.n ?? m.merge_train?.pr ?? m.pr?.number ?? m.review_pr?.number ?? 0);
  const prRepo = String(evObj.repo ?? m.merge_train?.repo ?? m.pr?.repo ?? m.review_pr?.repo ?? "");
  const prShort = prNum > 0 ? (prRepo ? `${prRepo.split("/").pop()}#${prNum}` : `PR #${prNum}`) : "PR";

  let whatUnblocks = cls.unblockedBy;
  let unblockedTone = cls.unblockedTone;

  if (cls.key === "ask") {
    const askId = m.awaiting_ask?.ask_id ?? evObj.ask_id;
    whatUnblocks = askId ? `You: answer ${askId}` : "You: answer ask";
    unblockedTone = "urgent";
  } else if (cls.key === "awaiting") {
    whatUnblocks = `You: force-review ${prShort}`;
    unblockedTone = "urgent";
  } else if (cls.key === "verify") {
    whatUnblocks = `Agent: verify ${prShort}`;
    unblockedTone = "warn";
  } else if (cls.key === "merge") {
    whatUnblocks = phase === "awaiting-ci"
      ? `System (train): ${prShort} merged, settling CI`
      : `System (train): merges ${prShort} & closes card`;
    unblockedTone = "scope";
  } else if (cls.key === "conflict") {
    whatUnblocks = `Agent: rebase ${prShort} onto main`;
    unblockedTone = "warn";
  } else if (cls.key === "repair") {
    whatUnblocks = m.repair_status?.kind === "working"
      ? `Repair in progress — ${m.repair_status.owner}`
      : m.repair_status?.kind === "scheduled" ? `Repair scheduled — ${m.repair_status.task_id}` : "Repair not scheduled — Bridge must assign an agent";
    unblockedTone = "warn";
  } else if (cls.key === "pr") {
    if (!mergeCompletesTask(m)) {
      whatUnblocks = `Prerequisite: ${prShort} must merge; Bridge then schedules the remaining work`;
      unblockedTone = "scope";
    } else if (phase === "unbound") {
      whatUnblocks = `Agent / System: re-verify ${prShort} to queue (or closes on merge)`;
      unblockedTone = "warn";
    } else if (phase === "bounced") {
      whatUnblocks = `Agent: fix bounced ${prShort} & re-verify`;
      unblockedTone = "warn";
    } else if (ev === "br_pr_merged" && evObj.id) {
      whatUnblocks = `System (proxy): when ${evObj.id}'s PR merges`;
      unblockedTone = "scope";
    } else {
      whatUnblocks = `PR owner: deliver ${prShort}; system: observe merge receipt`;
      unblockedTone = "scope";
    }
  } else if (cls.key === "ci") {
    whatUnblocks = ev === "run_success"
      ? `System (CI probe): successful run${evObj.run_id ? ` ${evObj.run_id}` : " at the awaited head"}`
      : `System (CI probe): when ${prShort} checks pass`;
    unblockedTone = "scope";
  } else if (cls.key === "deploy") {
    const sha = String(evObj.commit ?? "").slice(0, 9);
    whatUnblocks = sha ? `System (deploy): hub @ ${sha}` : "System (deploy): hub deploy";
    unblockedTone = "scope";
  } else if (cls.key === "task") {
    const targetId = String(evObj.id ?? "");
    whatUnblocks = targetId
      ? `System (proxy): when ${targetId} is ${ev === "br_answered" ? "answered" : "done"}`
      : cls.unblockedBy;
    unblockedTone = "scope";
  } else if (cls.key === "issue") {
    const iss = evObj.n ? `${String(evObj.repo ?? "").split("/").pop() || "GH"}#${evObj.n}` : "issue";
    whatUnblocks = `System / Agent: when ${iss} closes`;
    unblockedTone = "scope";
  } else if (cls.key === "timeout") {
    const until = Number(evObj.until_ts ?? 0);
    whatUnblocks = until > Date.now()
      ? `System (cooldown ${rel(until)}) or You (Release)`
      : "System (watchdog drain) or You (Release)";
    unblockedTone = "scope";
  } else if (cls.key === "time") {
    const until = Number(evObj.until_ts ?? 0);
    whatUnblocks = until > 0 ? `System (timer): ${rel(until)}` : cls.unblockedBy;
    unblockedTone = "scope";
  }

  const whyBlocked = (rawUnblock || rawReason || "blocked — open card to inspect").slice(0, 110);
  return { whatUnblocks, unblockedTone, whyBlocked };
}

export interface UnblockTwinIndex {
  byPartOf: Map<string, any>;
  byTitle: Map<string, any>;
}

/** in_progress "Unblock: <parent title>" duty cards (roles: ["unblock"]),
 *  keyed by parent id (part_of) and by the watchdog's naming convention. */
export function unblockTwinIndex(tasks: any[]): UnblockTwinIndex {
  const byPartOf = new Map<string, any>();
  const byTitle = new Map<string, any>();
  for (const t of tasks ?? []) {
    if (t.status !== "in_progress" || !(t.roles ?? []).includes("unblock")) continue;
    if (t.part_of) byPartOf.set(t.part_of, t);
    if (String(t.title ?? "").startsWith("Unblock: ")) byTitle.set(t.title.slice("Unblock: ".length), t);
  }
  return { byPartOf, byTitle };
}

/** The live unblock duty working this blocked task, if any. */
export function activeUnblockTwinOf(t: any, idx: UnblockTwinIndex): any | undefined {
  return idx.byPartOf.get(t.id) ?? idx.byTitle.get(t.title);
}
