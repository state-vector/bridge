/** "Copy prompt context" builder (BR#4015, Ray 2026-10-28 — "add, generically,
 *  a Copy Prompt Context button which copies relevant details for an agent to
 *  look at").
 *
 *  Pure module (no react/zustand) — vitest tier tests it directly (forMeHold
 *  precedent). The block is built from LIVE artefact data, never hand-typed,
 *  and ends with the live-state warning: the paste is a summary, the card is
 *  the truth. A prompt producer only — copying mutates nothing. */

import { cardPath } from "./refs";

/** Structural minimums (forMeHold precedent — this module must stay
 *  import-free of the DOM-bound server layer so the worker tsc project, which
 *  has no DOM lib, still compiles it). The kit's KbArtefact/KbVersion satisfy
 *  these by structure at every call site. */
export interface PromptContextTask {
  id: string;
  type?: string;
  title?: string;
  status?: string;
  owner?: string | null;
  tags?: string[] | null;
  updated_ts?: number;
  body_md?: string | null;
  meta?: any;
  project?: string;
}

export interface PromptContextVersion {
  seq?: number;
  ts?: number;
  actor?: string;
  action?: string;
  summary?: string;
  data?: Record<string, unknown>;
}

/** Same runner-noise filter the detail panel's history uses — the paste is
 *  for an agent to look at, so dispatch/heartbeat chatter is dropped too.
 *  (Kept in step with TaskDetail's filter; a comment there names this one.) */
const NOISE_RX = /^(runner:|opencode finished in ~|grace declared|watchdog\.)/i;

/** Resume contracts enumerate their conditions "(1) … (2) …" — same split the
 *  detail panel renders (TaskDetail.splitConditions; duplicated here to keep
 *  this module import-free of the react views). */
export function splitConditionsText(s: string | undefined): string[] {
  const t = (s ?? "").trim();
  if (!t) return [];
  const marks = t.match(/\(\d\)/g);
  if (!marks || marks.length < 2) return [t];
  const parts = t.split(/\(\d\)\s*/).map((x) => x.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [t];
}

function rel(ts: number | undefined): string {
  if (!ts) return "?";
  const s = Math.max(0, Date.now() - ts) / 1000;
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export interface PromptContextOpts {
  /** history (kb versions) — recent entries ride along, newest first */
  versions?: PromptContextVersion[];
  /** how many history entries to include (default 8) */
  historyLimit?: number;
  /** origin for the absolute permalink (window.location.origin at the call site) */
  origin?: string;
  /** hub-stamped absolute permalink — canonical origin regardless of ingress
   *  (BR#4695); preferred over origin+path when present. */
  permalink?: string;
}

/** One pasteable context block for `task`. Generic: any artefact type
 *  (task/question/decision/steering/…) gets the same treatment. */
export function buildPromptContext(
  task: PromptContextTask,
  opts: PromptContextOpts = {},
): string {
  const m = task.meta ?? {};
  const lines: string[] = [];

  lines.push(`Bridge card ${task.id}${task.title ? ` — "${task.title}"` : ""}`);
  const path = cardPath(task.id);
  if (path && opts.permalink) lines.push(opts.permalink);
  else if (path && opts.origin) lines.push(`${opts.origin}${path}`);
  else if (path) lines.push(`(permalink: ${path})`);

  const bits = [
    task.type !== "task" ? task.type : "task",
    `status ${task.status}`,
    task.owner ? `owner ${task.owner}` : "unclaimed",
    m.session ? `session ${m.session}` : undefined,
    (task as any).project ? `project ${(task as any).project}` : undefined,
    `updated ${rel(task.updated_ts)}`,
  ].filter(Boolean);
  lines.push(bits.join(" · "));
  if ((task.tags ?? []).length) lines.push(`Tags: ${(task.tags as string[]).join(", ")}`);

  if (m.blocked?.reason) {
    lines.push("");
    lines.push(`Why blocked: ${String(m.blocked.reason).trim()}`);
    const conds = splitConditionsText(m.blocked.unblock_condition);
    if (conds.length) lines.push(`Resumes when:\n${conds.map((c) => `- ${c}`).join("\n")}`);
  }

  const lp = m.last_progress;
  if (lp?.note) {
    lines.push("");
    lines.push(`Last progress (${lp.actor ?? "?"} · ${rel(lp.ts)}): ${String(lp.note).trim()}`);
    const gauges = [
      lp.completion_pct != null ? `done ${lp.completion_pct}%` : undefined,
      lp.confidence_pct != null ? `conf ${lp.confidence_pct}%` : undefined,
      lp.risk_pct != null ? `risk ${lp.risk_pct}%` : undefined,
      lp.context_pct != null ? `ctx ${lp.context_pct}%` : undefined,
    ].filter(Boolean);
    if (gauges.length) lines.push(`Gauges: ${gauges.join(" · ")}`);
  }

  if (m.provenance?.repo && m.provenance?.pr) {
    lines.push("");
    lines.push(
      `Provenance: https://github.com/${m.provenance.repo}/pull/${m.provenance.pr}` +
      `${m.provenance.merge_sha ? ` (merged ${m.provenance.merge_sha})` : ""}` +
      `${m.provenance.signer ? ` · signer ${m.provenance.signer}` : ""}`,
    );
  }

  const body = (task.body_md ?? "").trim();
  if (body && body !== task.title) {
    lines.push("");
    lines.push("Description:");
    lines.push(body);
  }

  const history = (opts.versions ?? []).filter((v) => !NOISE_RX.test(v.summary ?? ""));
  if (history.length) {
    lines.push("");
    lines.push(`Recent history (newest first):`);
    for (const v of history.slice(0, opts.historyLimit ?? 8)) {
      lines.push(`- [${v.action}] ${v.actor ?? "?"} · ${rel(v.ts)} — ${(v.summary ?? "").trim()}`);
    }
  }

  lines.push("");
  lines.push(
    `This summary may be stale — check the card live before acting (get_artefact "${task.id}").`,
  );
  return lines.join("\n");
}
