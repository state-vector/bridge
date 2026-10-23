import { useEffect, useMemo, useState } from "react";
import { useKb } from "../store/kb";
import { kbApi, type KbBrief, type KbBriefEntry, type KbBriefProvenance, type KbProvenanceReceipt, type KbSectionProvenance, type KbWarning } from "../lib/kb";
import { rel } from "../lib/views";

/** Briefs tab (TASK-016 #4, spec BR#542): session + task-scoped briefs with
 *  per-section provenance receipts. Inline = compact chips per section
 *  (type · id · recency); the side panel is the expanded drill-in. Content
 *  renders independently of provenance — a section without receipts shows an
 *  explicit source-unknown badge, never silent absence, and a provenance
 *  failure never takes the brief down (failure isolation both sides). */

const TASK_SECTIONS: Array<[string, string]> = [
  ["task", "Task"], ["goal", "Goal"], ["steering", "Steering"], ["decisions", "Accepted decisions"],
  ["research", "Supporting research"], ["discussions", "Open discussions"], ["warnings", "Warnings"],
];
const SESSION_SECTIONS: Array<[string, string]> = [
  ["project", "Project"], ["instructions", "Instructions"], ["board", "Board"], ["counts", "Counts"],
  ["open_artefacts", "Open artefacts"], ["my_tasks", "My tasks"], ["unclaimed_work", "Unclaimed work"],
  ["pending_asks", "Pending asks"], ["action_required", "Action required"], ["my_score", "My score"],
];
const INLINE_MAX = 4;

function recency(ts?: number | string): string | null {
  if (typeof ts === "number") return rel(ts);
  if (typeof ts === "string") return `build ${ts}`;
  return null;
}

function receiptTitle(r: KbProvenanceReceipt): string {
  const when = recency(r.updated_ts);
  return `${r.record_type} · ${r.record_id}${when ? ` · ${when}` : ""}${r.unresolvable ? " · no longer resolvable" : ""}`;
}

function ReceiptChip({ r }: { r: KbProvenanceReceipt }) {
  const when = recency(r.updated_ts);
  return (
    <span
      className={`chip chip-prov${r.unresolvable ? " chip-prov-dead" : ""}`}
      title={receiptTitle(r)}
    >
      {r.record_type} · {r.record_id}{when ? ` · ${when}` : ""}
    </span>
  );
}

function Section({ name, title, prov, entries, onDetails }: {
  name: string;
  title: string;
  prov: KbBriefProvenance | undefined;
  entries: unknown;
  onDetails: (section: string) => void;
}) {
  const s: KbSectionProvenance | undefined = prov?.[name];
  // section shape is keyed by name, not duck-typed: only `warnings` holds events
  const warns = name === "warnings" && Array.isArray(entries) && entries.length > 0 ? (entries as KbWarning[]) : null;
  const rows = !warns && Array.isArray(entries) && entries.length > 0 ? (entries as KbBriefEntry[]) : null;
  const n = s?.receipts.length ?? 0;
  return (
    <section className="card brief-section">
      <div className="brief-sec-head">
        <h3>{title}</h3>
        <div className="brief-sec-badges">
          {s?.state === "unknown" && <span className="chip chip-prov chip-prov-unknown">source unknown</span>}
          {s?.state === "partial" && <span className="chip chip-prov chip-prov-gap">+{s.unresolved ?? 0} unresolved</span>}
          {n > 0 && (
            <button className="opt-btn opt-ghost prov-details" onClick={() => onDetails(name)} title="full receipt drill-in">
              receipts {n}
            </button>
          )}
        </div>
      </div>
      {rows && (
        <div className="brief-entries">
          {rows.map((e) => (
            <div key={e.id} className="brief-entry">
              <div className="brief-entry-line">
                <span className="chip chip-scope">{e.id}</span>
                <span className="brief-entry-title">{e.title}</span>
                {e.status && <span className="why-line">{e.status}</span>}
                {e.updated_ts ? <span className="why-line">{rel(e.updated_ts)}</span> : null}
              </div>
              {e.excerpt && <p className="brief-excerpt">{e.excerpt}</p>}
            </div>
          ))}
        </div>
      )}
      {warns && (
        <div className="brief-entries">
          {warns.map((w, i) => (
            <div key={w.seq ?? i} className="brief-entry">
              <div className="brief-entry-line">
                <span className="chip chip-urgent">{w.op ?? "event"}</span>
                <span className="brief-entry-title">{w.actor ?? "system"}</span>
                <span className="why-line">{rel(w.ts)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {!rows && !warns && s?.state === "ok" && n === 0 && <p className="empty">No entries.</p>}
      {s && n > 0 && (
        <div className="prov-inline">
          {s.receipts.slice(0, INLINE_MAX).map((r, i) => (
            <ReceiptChip key={`${r.record_type}:${r.record_id}:${i}`} r={r} />
          ))}
          {n > INLINE_MAX && <span className="chip chip-prov chip-prov-more" title={`${n - INLINE_MAX} more receipts in the panel`}>+{n - INLINE_MAX}</span>}
        </div>
      )}
    </section>
  );
}

function ProvenancePanel({ title, s, onClose }: { title: string; s: KbSectionProvenance; onClose: () => void }) {
  return (
    <div className="prov-panel-backdrop" onClick={onClose}>
      <aside className="prov-panel" onClick={(e) => e.stopPropagation()}>
        <div className="prov-panel-head">
          <h3>{title} — provenance</h3>
          <button className="opt-btn opt-ghost" onClick={onClose}>×</button>
        </div>
        <div className="ask-chips">
          {s.state === "unknown" && <span className="chip chip-prov chip-prov-unknown">source unknown</span>}
          {s.state === "partial" && <span className="chip chip-prov chip-prov-gap">+{s.unresolved ?? 0} unresolved</span>}
          <span className="why-line">{s.receipts.length} receipt{s.receipts.length === 1 ? "" : "s"}</span>
        </div>
        <div className="prov-list">
          {s.receipts.map((r, i) => (
            <div key={i} className={`prov-row${r.unresolvable ? " prov-row-dead" : ""}`}>
              <span className={`chip chip-prov${r.unresolvable ? " chip-prov-dead" : ""}`}>{r.record_type}</span>
              <div className="prov-row-body">
                <div className="prov-row-label">{r.label}</div>
                <div className="why-line">{receiptTitle(r)}</div>
              </div>
              {r.link && <a className="prov-link" href={r.link} target="_blank" rel="noreferrer">open</a>}
            </div>
          ))}
          {s.receipts.length === 0 && <p className="empty">No receipts for this section.</p>}
        </div>
      </aside>
    </div>
  );
}

export function BriefsView() {
  const tasks = useKb((s) => s.tasks);
  const sessions = useKb((s) => s.sessions);
  const [flavour, setFlavour] = useState<"task" | "session">("task");
  const [taskId, setTaskId] = useState("");
  const [label, setLabel] = useState("");
  const [brief, setBrief] = useState<KbBrief | null>(null);
  const [err, setErr] = useState("");
  const [panel, setPanel] = useState<string | null>(null);

  const sortedTasks = useMemo(
    () => tasks.slice().sort((a, b) => b.updated_ts - a.updated_ts),
    [tasks],
  );
  const labels = useMemo(
    () => [...new Set(sessions.map((s) => s.label).filter((x): x is string => !!x))].sort(),
    [sessions],
  );

  useEffect(() => {
    let dead = false;
    setBrief(null);
    setErr("");
    setPanel(null);
    const target = flavour === "task" ? taskId : label;
    if (!target) return;
    kbApi.brief(flavour === "task" ? { id: target } : { label: target })
      .then((b) => { if (!dead) setBrief(b); })
      .catch((e) => { if (!dead) setErr((e as Error).message); });
    return () => { dead = true; };
  }, [flavour, taskId, label]);

  const sections = flavour === "task" ? TASK_SECTIONS : SESSION_SECTIONS;
  const prov = brief?.provenance;
  const extraSections = prov
    ? Object.keys(prov).filter((k) => !sections.some(([key]) => key === k))
    : [];

  const sectionEntries = (name: string): unknown => {
    if (flavour === "task") return (brief?.brief as Record<string, unknown> | undefined)?.[name];
    // session flavour: the orient payload is spread at the top level
    const v = (brief as Record<string, unknown> | undefined)?.[name];
    if (Array.isArray(v)) {
      return v
        .filter((x) => x && typeof x === "object" && typeof (x as any).id === "string")
        .map((x) => ({ id: (x as any).id, title: (x as any).title ?? (x as any).question ?? (x as any).id, status: (x as any).status, updated_ts: (x as any).updated_ts ?? (x as any).created_ts }));
    }
    return null;
  };

  const sectionTitle = (name: string) => sections.find(([k]) => k === name)?.[1] ?? name;

  return (
    <div className="disc-wrap">
      <div className="view-head">
        <h2>Briefs</h2>
        <span className="muted-note">what the hub composed — every section traced to its source records</span>
      </div>

      <div className="card brief-controls">
        <div className="brief-flavour">
          <button className={`opt-btn ${flavour === "task" ? "" : "opt-ghost"}`} onClick={() => setFlavour("task")}>Task brief</button>
          <button className={`opt-btn ${flavour === "session" ? "" : "opt-ghost"}`} onClick={() => setFlavour("session")}>Session brief</button>
        </div>
        {flavour === "task" ? (
          <select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
            <option value="">— pick a task —</option>
            {sortedTasks.map((t) => (
              <option key={t.id} value={t.id}>{t.id} — {t.title.slice(0, 70)}</option>
            ))}
          </select>
        ) : (
          <select value={label} onChange={(e) => setLabel(e.target.value)}>
            <option value="">— pick a session (agent) —</option>
            {labels.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        )}
        {brief?.generated_ts ? <span className="why-line">composed {rel(brief.generated_ts)}</span> : null}
      </div>

      {err && <p className="empty">Failed to load brief: {err}</p>}
      {!err && !brief && (flavour === "task" ? !!taskId : !!label) && <p className="empty">loading brief…</p>}
      {!taskId && flavour === "task" && <p className="empty">Pick a task to see its brief with provenance.</p>}
      {!label && flavour === "session" && <p className="empty">Pick a session to see what that agent orient-ed into.</p>}

      {brief && (
        <div className="brief-list">
          {[...sections.map(([k, t]) => [k, t] as [string, string]), ...extraSections.map((k) => [k, k] as [string, string])].map(([name, title]) => (
            <Section
              key={name}
              name={name}
              title={title}
              prov={prov}
              entries={sectionEntries(name)}
              onDetails={(section) => setPanel(section)}
            />
          ))}
        </div>
      )}

      {panel && brief?.provenance?.[panel] && (
        <ProvenancePanel title={sectionTitle(panel)} s={brief.provenance[panel]} onClose={() => setPanel(null)} />
      )}
    </div>
  );
}