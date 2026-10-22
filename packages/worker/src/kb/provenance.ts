/**
 * Brief provenance — pure logic, no I/O. Unit-tested in test/kb-provenance.test.ts.
 *
 * Spec: BR#542 (TASK-016 analysis child, "briefs provenance and source receipts").
 * Provenance is display-only and derived at read time from the same records the
 * brief was composed from (settings, artefacts, asks, events). It rides in brief
 * responses as an additive optional `provenance` field — no tables, columns, or
 * persistence. Clients tolerate its absence.
 *
 * Every receipt entry: {record_type, record_id, label, updated_ts?, link?} with
 * record_type ∈ setting | server-default | artefact | ask | event | computed.
 * Failure isolation: a provenance lookup error degrades that section to
 * `source unknown` — the brief itself never fails to render or build.
 */

export type RecordType = "setting" | "server-default" | "artefact" | "ask" | "event" | "computed";

export interface ProvenanceReceipt {
  record_type: RecordType;
  record_id: string;
  label: string;
  /** recency cue: epoch ms for stored records, the build version for server-defaults */
  updated_ts?: number | string;
  link?: string;
  /** tombstone: the record no longer resolves (deleted/superseded beyond recovery) */
  unresolvable?: boolean;
}

export interface SectionProvenance {
  /** ok = fully resolved · partial = some receipts unresolved · unknown = lookup failed */
  state: "ok" | "partial" | "unknown";
  receipts: ProvenanceReceipt[];
  /** resolvable receipts were rendered but this many ids did not resolve */
  unresolved?: number;
}

export type BriefProvenance = Record<string, SectionProvenance>;

/** Minimal artefact row shape the builders need (DO rows are supersets). */
export interface ProvenanceArtefact {
  id: string;
  type?: string;
  title?: string;
  status?: string;
  updated_ts?: number;
}

/** Minimal ask row shape. */
export interface ProvenanceAsk {
  id: string;
  from_label?: string;
  to_target?: string;
  question?: string;
  created_ts?: number;
}

/** Minimal audit-event row shape. */
export interface ProvenanceEvent {
  seq?: number;
  ts: number;
  actor?: string;
  op?: string;
  artefact_id?: string | null;
}

/** superseded record id → superseding record id (resolved from supersedes relations) */
export type Supersessions = Record<string, string>;

const UNKNOWN_SECTION: SectionProvenance = { state: "unknown", receipts: [] };

/** source-unknown receipt: the explicit, never-silent marker for a failed lookup */
export function unknownReceipt(section: string): ProvenanceReceipt {
  return { record_type: "computed", record_id: `provenance:${section}`, label: "source unknown" };
}

/**
 * Run a section builder under failure isolation: a throw (or junk return)
 * degrades that section to `source unknown` — never poisons the whole brief.
 */
function safeSection(name: string, build: () => SectionProvenance): [string, SectionProvenance] {
  try {
    const s = build();
    if (!s || !Array.isArray(s.receipts)) return [name, { ...UNKNOWN_SECTION, receipts: [unknownReceipt(name)] }];
    if (s.receipts.length === 0 && s.state === "ok" && !s.unresolved) return [name, s]; // empty section: nothing to show
    return [name, s];
  } catch {
    return [name, { ...UNKNOWN_SECTION, receipts: [unknownReceipt(name)] }];
  }
}

function sections(list: Array<[string, SectionProvenance]>): BriefProvenance {
  const out: BriefProvenance = {};
  for (const [name, s] of list) out[name] = s;
  return out;
}

/** Best-effort row index: junk rows (or hostile getters) are skipped, never thrown. */
function indexRows(rowsById: Map<string, ProvenanceArtefact>, lists: Array<ProvenanceArtefact[] | undefined>) {
  try {
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const r of list) if (r && typeof r.id === "string") rowsById.set(r.id, r);
    }
  } catch { /* partial index — receipt builders stay isolated per section */ }
}

/** Receipt for an artefact row; a missing row becomes a tombstone (id kept), not a silent drop. */
export function artefactReceipt(row: ProvenanceArtefact | null | undefined, fallbackId?: string): ProvenanceReceipt {
  if (!row || typeof row.id !== "string" || !row.id) {
    const id = typeof fallbackId === "string" && fallbackId ? fallbackId : String((row as any)?.id ?? "unknown");
    return { record_type: "artefact", record_id: id, label: "no longer resolvable", unresolvable: true };
  }
  return {
    record_type: "artefact",
    record_id: row.id,
    label: String(row.title ?? row.id).slice(0, 120),
    updated_ts: typeof row.updated_ts === "number" ? row.updated_ts : undefined,
  };
}

/**
 * Map ids → receipts against the resolved row index. Unresolvable ids produce
 * tombstone receipts and bump `unresolved` (state flips to partial).
 */
export function resolveArtefactReceipts(
  ids: readonly unknown[],
  rowsById: Map<string, ProvenanceArtefact>,
): SectionProvenance {
  const receipts: ProvenanceReceipt[] = [];
  let unresolved = 0;
  for (const id of ids) {
    if (typeof id !== "string" || !id) continue;
    const row = rowsById.get(id);
    if (row) receipts.push(artefactReceipt(row));
    else {
      receipts.push({ record_type: "artefact", record_id: id, label: "no longer resolvable", unresolvable: true });
      unresolved += 1;
    }
  }
  return {
    state: unresolved > 0 ? "partial" : "ok",
    receipts,
    ...(unresolved > 0 ? { unresolved } : {}),
  };
}

/** Receipt for an ask row (pending_asks). */
export function askReceipt(a: ProvenanceAsk): ProvenanceReceipt {
  const label = (a.question ?? a.from_label ?? a.id).slice(0, 120);
  return {
    record_type: "ask",
    record_id: a.id,
    label,
    updated_ts: typeof a.created_ts === "number" ? a.created_ts : undefined,
  };
}

/** Receipt for an audit event row (action_required backing: reaper/nudge ops). */
export function eventReceipt(e: ProvenanceEvent): ProvenanceReceipt {
  return {
    record_type: "event",
    record_id: e.seq !== undefined ? `seq:${e.seq}` : `ts:${e.ts}`,
    label: `${e.actor ?? "system"} · ${e.op ?? "event"}${e.artefact_id ? ` · ${e.artefact_id}` : ""}`.slice(0, 120),
    updated_ts: typeof e.ts === "number" ? e.ts : undefined,
  };
}

/** computed receipt: derivation name, no stored record — the entry says so. */
export function computedReceipt(recordId: string, label: string): ProvenanceReceipt {
  return { record_type: "computed", record_id: recordId, label };
}

/** setting receipt: key into the settings map. */
export function settingReceipt(key: string, updatedTs?: number): ProvenanceReceipt {
  return { record_type: "setting", record_id: key, label: `setting: ${key}`, updated_ts: updatedTs };
}

/** server-default receipt: composed server-side, versioned with the build. */
export function serverDefaultReceipt(recordId: string, label: string, version?: string): ProvenanceReceipt {
  return { record_type: "server-default", record_id: recordId, label, updated_ts: version };
}

/**
 * Rule 8: superseding artefacts replace superseded ones in receipt lists.
 * A receipt whose record_id is superseded is swapped for the superseding
 * artefact's receipt (tombstone if that too is gone); the superseding id
 * never appears twice (its own listing and the replacement collapse).
 */
export function applySupersessions(
  section: SectionProvenance,
  supersessions: Supersessions,
  rowsById: Map<string, ProvenanceArtefact>,
): SectionProvenance {
  if (!supersessions || typeof supersessions !== "object") return section;
  let unresolved = section.unresolved ?? 0;
  const out: ProvenanceReceipt[] = [];
  for (const r of section.receipts) {
    const replacementId = supersessions[r.record_id];
    if (!replacementId || typeof replacementId !== "string") {
      out.push(r);
      continue;
    }
    const replacement = artefactReceipt(rowsById.get(replacementId) ?? null, replacementId);
    if (replacement.unresolvable) unresolved += 1;
    if (r.unresolvable) unresolved = Math.max(0, unresolved - 1); // the replaced tombstone slot is gone
    out.push(replacement);
  }
  // collapse duplicate record_ids, preferring the resolvable receipt
  const byId = new Map<string, ProvenanceReceipt>();
  for (const r of out) {
    const prev = byId.get(r.record_id);
    if (!prev || (prev.unresolvable && !r.unresolvable)) byId.set(r.record_id, r);
  }
  const receipts = [...byId.values()];
  return { ...section, receipts, ...(unresolved > 0 ? { unresolved, state: "partial" } : {}) };
}

// ---------- session brief (the orient response) ----------

export interface SessionBriefProvenanceInput {
  /** the settings map the brief was composed from */
  settings: Record<string, any> | null | undefined;
  /** composeBootstrap source + build marker (recency cue) */
  buildVersion?: string;
  /** extra guidance setting was actually injected */
  hasBootstrapMd?: boolean;
  /** kind playbook source: injected from a setting override or the server default */
  kindPlaybook?: { source: "setting" | "server-default"; isCron: boolean } | null;
  /** role playbook sources, in composition order */
  rolePlaybooks?: Array<{ role: string; source: "setting" | "server-default" }>;
  /** board block present (external board composed into instructions) */
  hasExternalBoard?: boolean;
  openArtefacts?: ProvenanceArtefact[];
  myTasks?: ProvenanceArtefact[];
  unclaimedWork?: ProvenanceArtefact[];
  pendingAsks?: ProvenanceAsk[];
  /** audit events backing action_required (reaper/nudge class) */
  actionEvents?: ProvenanceEvent[];
  /** task ids named by action_required notices */
  actionTaskIds?: string[];
  /** gauge-debt note was appended to instructions */
  hasGaugeDebt?: boolean;
  /** my_score was present */
  hasScore?: boolean;
}

/**
 * Provenance for the session brief (orient response), one section per brief
 * section. Section names match the orient payload keys so the webapp can
 * align receipts with rendered content without knowing composition details.
 */
export function buildSessionBriefProvenance(input: SessionBriefProvenanceInput): BriefProvenance {
  const settings = input.settings && typeof input.settings === "object" ? input.settings : {};
  const rowsById = new Map<string, ProvenanceArtefact>();
  indexRows(rowsById, [input.openArtefacts, input.myTasks, input.unclaimedWork]);

  // instructions receipts: rules block + every setting/default actually composed in
  const instr: ProvenanceReceipt[] = [
    serverDefaultReceipt("composeBootstrap", "operating rules (server template)", input.buildVersion),
  ];
  if (input.hasBootstrapMd) instr.push(settingReceipt("bootstrap_md"));
  if (input.kindPlaybook) {
    instr.push(
      input.kindPlaybook.source === "setting"
        ? settingReceipt(`playbooks.${input.kindPlaybook.isCron ? "cron" : "interactive"}`)
        : serverDefaultReceipt("DEFAULT_CRON_PLAYBOOK", "kind playbook (server default)"),
    );
  }
  for (const p of Array.isArray(input.rolePlaybooks) ? input.rolePlaybooks : []) {
    if (!p || typeof p.role !== "string") continue;
    instr.push(
      p.source === "setting"
        ? settingReceipt(`roles.${p.role}`)
        : serverDefaultReceipt(`DEFAULT_ROLE_PLAYBOOKS.${p.role}`, `role playbook: ${p.role} (server default)`),
    );
  }
  if (input.hasExternalBoard) instr.push(settingReceipt("board.prompt"));
  if (input.hasGaugeDebt) instr.push(computedReceipt("gauge_debt", "computed: owned in-flight tasks without reported gauges"));

  const actionEvents = Array.isArray(input.actionEvents) ? input.actionEvents.filter((e) => e && typeof e.ts === "number") : [];
  const actionSection = resolveArtefactReceipts(
    (Array.isArray(input.actionTaskIds) ? input.actionTaskIds : []).filter((id) => typeof id === "string"),
    rowsById,
  );
  const actionRequired: SectionProvenance = {
    state: actionSection.state,
    receipts: [...actionEvents.map(eventReceipt), ...actionSection.receipts],
    ...(actionSection.unresolved ? { unresolved: actionSection.unresolved } : {}),
  };

  return sections([
    safeSection("project", () => ({
      state: "ok" as const,
      receipts: [settingReceipt("project_name")],
    })),
    safeSection("instructions", () => ({
      state: "ok" as const,
      receipts: instr,
    })),
    safeSection("board", () => ({
      state: "ok" as const,
      receipts: [settingReceipt("board")],
    })),
    safeSection("counts", () => ({
      state: "ok" as const,
      receipts: [computedReceipt("counts", "computed: COUNT(artefacts) GROUP BY type, status")],
    })),
    safeSection("open_artefacts", () =>
      resolveArtefactReceipts((Array.isArray(input.openArtefacts) ? input.openArtefacts : []).map((r) => r?.id), rowsById),
    ),
    safeSection("my_tasks", () =>
      resolveArtefactReceipts((Array.isArray(input.myTasks) ? input.myTasks : []).map((r) => r?.id), rowsById),
    ),
    safeSection("unclaimed_work", () =>
      resolveArtefactReceipts((Array.isArray(input.unclaimedWork) ? input.unclaimedWork : []).map((r) => r?.id), rowsById),
    ),
    safeSection("pending_asks", () => ({
      state: "ok" as const,
      receipts: (Array.isArray(input.pendingAsks) ? input.pendingAsks : []).filter((a) => a && typeof a.id === "string").map(askReceipt),
    })),
    safeSection("action_required", () => actionRequired),
    safeSection("my_score", () => ({
      state: "ok" as const,
      receipts: input.hasScore
        ? [computedReceipt("scoreAgent", "computed: behaviour score over progress/gauge/ask/abandonment signals")]
        : [unknownReceipt("my_score")],
    })),
  ]);
}

// ---------- task-scoped brief (assembled from a task's typed relations) ----------

export interface TaskBriefProvenanceInput {
  task: ProvenanceArtefact | null | undefined;
  goal: ProvenanceArtefact[];
  steering: ProvenanceArtefact[];
  decisions: ProvenanceArtefact[];
  research: ProvenanceArtefact[];
  discussions: ProvenanceArtefact[];
  /** warning-class events on the task (reassign / transition_rejected / blocked transitions) */
  warnings: ProvenanceEvent[];
  /** superseded_id → superseding_id among the assembled rows (Rule 8) */
  supersessions?: Supersessions;
}

/**
 * Provenance for the task-scoped brief: assembled goal + constraining steering
 * + accepted decisions + supporting research + open discussions + warnings.
 * Every section's receipts point at the exact records the section was
 * assembled from; superseding rows replace superseded ones (Rule 8).
 */
export function buildTaskBriefProvenance(input: TaskBriefProvenanceInput): BriefProvenance {
  const rowsById = new Map<string, ProvenanceArtefact>();
  if (input.task && typeof input.task.id === "string") rowsById.set(input.task.id, input.task);
  indexRows(rowsById, [input.goal, input.steering, input.decisions, input.research, input.discussions]);
  const supersessions = input.supersessions && typeof input.supersessions === "object" ? input.supersessions : {};
  const idsOf = (list?: ProvenanceArtefact[]) => (Array.isArray(list) ? list.map((r) => r?.id) : []);

  const taskSelf: [string, SectionProvenance] = safeSection("task", () =>
    input.task
      ? { state: "ok" as const, receipts: [artefactReceipt(input.task)] }
      : { state: "unknown" as const, receipts: [unknownReceipt("task")] },
  );

  const related = (name: string, list: ProvenanceArtefact[] | undefined): [string, SectionProvenance] =>
    safeSection(name, () => {
      const s = resolveArtefactReceipts(idsOf(list), rowsById);
      return applySupersessions(s, supersessions, rowsById);
    });

  const warningsList = Array.isArray(input.warnings) ? input.warnings.filter((e) => e && typeof e.ts === "number") : [];
  const warnings: [string, SectionProvenance] = safeSection("warnings", () => ({
    state: "ok" as const,
    receipts: warningsList.map(eventReceipt),
  }));

  return sections([
    taskSelf,
    related("goal", input.goal),
    related("steering", input.steering),
    related("decisions", input.decisions),
    related("research", input.research),
    related("discussions", input.discussions),
    warnings,
  ]);
}