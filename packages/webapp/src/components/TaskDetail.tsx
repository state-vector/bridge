import { useEffect, useState } from "react";
import { kbApi } from "../lib/kb";
import type { KbArtefact, KbVersion } from "../lib/kb";
import { kindOf, rel, TASK_REF_RE } from "../lib/views";

export const SENTIMENT_CHIP: Record<string, string> = {
  going_well: "chip-done",
  neutral: "",
  struggling: "chip-diag",
  converging: "chip-kind kind-agent",
  diverging: "chip-urgent",
};

/** Unified history: one log holds progress notes AND state changes, typed. */
export const HISTORY_CHIP: Record<string, string> = {
  progress: "chip-kind kind-agent",
  transition: "chip-kind kind-human",
  create: "chip-done",
  update: "chip-kind kind-system",
  reassign: "chip-urgent",
};
export const HISTORY_LABEL: Record<string, string> = {
  progress: "log",
  transition: "state",
  create: "created",
  update: "edited",
  reassign: "reaped",
};

export function SentimentBar({ tasks }: { tasks: KbArtefact[] }) {
  const inFlight = tasks.filter((t) => ["in_progress", "blocked", "todo"].includes(t.status));
  const sentiments = inFlight
    .map((t) => (t.meta as any)?.last_progress?.sentiment as string | undefined)
    .filter(Boolean) as string[];
  if (sentiments.length === 0) return null;
  const counts: Record<string, number> = {};
  for (const s of sentiments) counts[s] = (counts[s] ?? 0) + 1;
  const order = ["going_well", "converging", "neutral", "diverging", "struggling"];
  const total = sentiments.length;
  const dominant = order.find((s) => counts[s]) ?? "";
  return (
    <div className="sentiment-bar-box" title="aggregate sentiment across in-flight tasks">
      <div className="sentiment-bar">
        {order.map((s) =>
          counts[s] ? (
            <div
              key={s}
              className={`sb-seg sb-${s}`}
              style={{ width: `${(counts[s] / total) * 100}%` }}
              title={`${s}: ${counts[s]}`}
            />
          ) : null,
        )}
      </div>
      <span className="muted-note">
        {total} in flight · leaning <b>{dominant.replace("_", " ")}</b>
        {counts.struggling ? ` · ${counts.struggling} struggling` : ""}
      </span>
    </div>
  );
}

interface TaskMeta {
  session?: string;
  blocked?: { reason?: string; unblock_condition?: string; ts?: number };
  last_progress?: { note?: string; sentiment?: string; actor?: string; ts?: number; completion_pct?: number; confidence_pct?: number; risk_pct?: number; context_pct?: number };
  attempt?: { by?: string; attempts?: number; last_reason?: string };
  qualification?: { state?: string; how?: string; by?: string; bars?: string[] };
  subprocess?: { reason?: string; budget_minutes?: number; deadline_ts?: number };
  awaiting_ask?: { ask_id?: string };
  kind?: string;
  github?: string;
  [k: string]: unknown;
}

/** Full state of the item: identity, gauges, structured meta, facts. Read-only —
 *  the forms (progress / status) live further down; this is the display half.
 *  Shared with KnowledgeView (any artefact type gets the same treatment). */
export function TaskStateCard({ task }: { task: KbArtefact & { meta?: TaskMeta; status_ts?: number; project?: string; created_by?: string } }) {
  const m = (task.meta ?? {}) as TaskMeta;
  const lp = m.last_progress;
  const gauges: Array<[string, number | undefined]> = [
    ["done", lp?.completion_pct],
    ["conf", lp?.confidence_pct],
    ["risk", lp?.risk_pct],
    ["ctx", lp?.context_pct],
  ];
  const hasGauges = gauges.some(([, v]) => v !== undefined);
  const facts: Array<[string, string | undefined]> = [
    ["id", task.id],
    ["type", task.type !== "task" ? task.type : undefined],
    ["status", task.status],
    ["owner", task.owner || undefined],
    ["session", m.session],
    ["kind", m.kind],
    ["project", (task as any).project || undefined],
    ["created by", (task as any).created_by || undefined],
    ["created", rel(task.created_ts)],
    ["in lane", task.status_ts ? rel(task.status_ts) : undefined],
    ["updated", rel(task.updated_ts)],
  ];
  return (
    <div className="task-state-card">
      {hasGauges && (
        <div className="gauge-row">
          {gauges.filter(([, v]) => v !== undefined).map(([k, v]) => (
            <span key={k} className="chip chip-scope" title={`${k} gauge (last progress)`}>{k} {v}%</span>
          ))}
        </div>
      )}
      {m.blocked && (
        <div className="task-blocked-info">
          <div className="progress-note"><b>why blocked:</b> {m.blocked.reason ?? ""}</div>
          <div className="progress-note"><b>unblocks when:</b> {m.blocked.unblock_condition ?? ""}</div>
        </div>
      )}
      {m.subprocess && typeof m.subprocess.deadline_ts === "number" && (
        <div className="progress-note"><b>subprocess wait</b> until {rel(m.subprocess.deadline_ts)} ({m.subprocess.budget_minutes ?? "?"}m budget){m.subprocess.reason ? ` — ${m.subprocess.reason}` : ""}</div>
      )}
      {m.awaiting_ask?.ask_id && (
        <div className="progress-note"><b>awaiting answer:</b> {m.awaiting_ask.ask_id}</div>
      )}
      {m.attempt && (m.attempt.attempts ?? 0) > 0 && (
        <div className="progress-note"><b>attempted {m.attempt.attempts}x</b>{m.attempt.by ? ` (last: ${m.attempt.by})` : ""}{m.attempt.last_reason ? ` — ${m.attempt.last_reason}` : ""}</div>
      )}
      {m.qualification?.state && (
        <div className="progress-note"><b>qualification:</b> {m.qualification.state}{m.qualification.how ? ` (${m.qualification.how})` : ""}{(m.qualification.bars ?? []).length ? ` · bars: ${(m.qualification.bars ?? []).join(", ")}` : ""}</div>
      )}
      <dl className="audit task-facts">
        {facts.filter(([, v]) => v !== undefined).map(([k, v]) => (
          <span key={k} className="fact-row"><dt>{k}</dt><dd>{v}</dd></span>
        ))}
      </dl>
      {(task.tags ?? []).length > 0 && (
        <div className="task-tags">{(task.tags as string[]).map((t) => <span key={t} className="chip chip-scope">{t}</span>)}</div>
      )}
    </div>
  );
}

export function TaskDetail({ taskId, openBlocked, onClose, onOpen }: {
  taskId: string; openBlocked?: boolean; onClose: () => void; onOpen?: (id: string) => void;
}) {
  const [task, setTask] = useState<(KbArtefact & { meta?: TaskMeta; status_ts?: number }) | null>(null);
  const [relations, setRelations] = useState<Array<{ relation: string; artefact_id: string; dir: string }>>([]);
  const [related, setRelated] = useState<KbArtefact[]>([]);
  const [note, setNote] = useState("");
  const [sentiment, setSentiment] = useState("neutral");
  const [body, setBody] = useState<string | null>(null);
  const [showBody, setShowBody] = useState(false);
  const [msg, setMsg] = useState("");
  const [blockedIntent, setBlockedIntent] = useState(!!openBlocked);
  const [blockedReason, setBlockedReason] = useState("");
  const [unblockCondition, setUnblockCondition] = useState("");
  const [completion, setCompletion] = useState("");
  const [confidence, setConfidence] = useState("");
  const [risk, setRisk] = useState("");
  const [versions, setVersions] = useState<KbVersion[]>([]);

  const transition = useKb((s) => s.transition);

  useEffect(() => {
    let on = true;
    void (async () => {
      try {
        const a = await kbApi.artefact(taskId);
        if (on) {
          setTask(a as KbArtefact & { meta?: TaskMeta });
          setBody(a.body_md ?? "");
          setRelations(((a as any).relations ?? []) as Array<{ relation: string; artefact_id: string; dir: string }>);
        }
      } catch { /* stale */ }
      try {
        const r = await kbApi.related(taskId);
        if (on) setRelated(r.artefacts ?? []);
      } catch { /* offline */ }
      try {
        const h = await kbApi.history(taskId);
        if (on) setVersions(h.versions ?? []);
      } catch { /* offline */ }
    })();
    return () => { on = false; };
  }, [taskId]);

  const clampPct = (v: string) => (v === "" ? undefined : Math.max(0, Math.min(100, Math.round(Number(v)))));
  // navigate to another task inside the same panel (task refs / dep graph)
  const nav = (id: string) => {
    if (!onOpen) return;
    onOpen(id);
  };
  const logProgress = async () => {
    if (!note.trim()) return;
    try {
      await fetch(`${getConfigUrl()}/api/kb/progress`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: taskId, note: note.trim(), sentiment,
          completion_pct: clampPct(completion), confidence_pct: clampPct(confidence), risk_pct: clampPct(risk),
        }),
      });
      setNote("");
      const h = await kbApi.history(taskId);
      setVersions(h.versions ?? []);
    } catch { /* offline */ }
  };

  return (
    <>
      <div className="panel-backdrop" onClick={onClose} />
      <aside className="detail-panel">
        <header className="detail-head">
          <div className="ask-chips">
            <span className="chip chip-scope">{task?.type ?? "task"}</span>
            <span className={`chip chip-kind kind-pill kp-${kindOf((task ?? {}) as any)}`}>{kindOf((task ?? {}) as any)}</span>
            <span className="chip">{task?.status ?? "…"}</span>
          </div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </header>

        <h2 className="detail-question"><RefText text={task?.title ?? taskId} onOpen={nav} /></h2>

        {task && <TaskStateCard task={task as any} />}

        {task?.meta?.last_progress?.note && (
          <p className="task-progress-line">
            <span className={`chip ${SENTIMENT_CHIP[task.meta.last_progress.sentiment ?? ""] ?? ""}`}>
              {task.meta.last_progress.sentiment ?? "progress"}
            </span>
            <span>{task.meta.last_progress.note}</span>
          </p>
        )}

        {body !== null && (
          <div className="detail-block">
            <label>
              Description{" "}
              <button className="icon-btn" onClick={() => setShowBody(!showBody)}>{showBody ? "▾ edit" : "▸"}</button>
              {msg && <span className="ok"> {msg}</span>}
            </label>
            {showBody ? (
              <>
                <textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
                <button
                  className="opt-btn"
                  onClick={async () => { await kbApi.update(taskId, { body_md: body }); setMsg("saved"); setTimeout(() => setMsg(""), 1500); }}
                >
                  Save description
                </button>
              </>
            ) : (
              <pre className="know-body">{body || "—"}</pre>
            )}
          </div>
        )}

        <div className="detail-block history-block">
          <label>History</label>
          <div className="version-history">
            {versions.length === 0 && <span className="muted-note">no history yet</span>}
            {versions
              // drop machine announcements: dispatch/heartbeat/relay noise the
              // board already shows — history is for humans reading what happened
              .filter((v) => !/^(runner:|opencode finished in ~|grace declared|watchdog\.)/i.test(v.summary ?? ""))
              .map((v) => (
                <div key={v.seq} className="progress-line">
                  <span className={`chip chip-kind ${HISTORY_CHIP[v.action] ?? "kind-system"}`} title={HISTORY_LABEL[v.action] ?? v.action}>
                    {HISTORY_LABEL[v.action] ?? v.action}
                  </span>
                  <span className="progress-note"><RefText text={v.summary} onOpen={nav} /></span>
                  <span className="step-ts">{v.actor} · {rel(v.ts)}</span>
                </div>
              ))}
          </div>
        </div>

        {relations.length > 0 && (
          <div className="detail-block">
            <label>Dependency graph</label>
            <DepGraph selfId={taskId} selfTitle={task?.title ?? ""} relations={relations} related={related} onOpen={nav} />
          </div>
        )}

        {relations.filter((r) => r.dir === "in").length > 0 && (
          <div className="detail-block">
            <label>Child tasks — verify / unblock / decomposition rounds (running or not)</label>
            {relations.filter((r) => r.dir === "in").map((r) => {
              const child = related.find((a) => a.id === r.artefact_id);
              if (!child) return null;
              return (
                <div key={r.artefact_id} className="progress-line" onClick={() => nav(r.artefact_id)} style={{ cursor: "pointer" }}>
                  <span className="chip chip-scope">{r.relation}</span>
                  <span className={`chip ${child.status === "done" ? "st-ok" : child.status === "blocked" ? "st-err" : "st-amber"}`}>{child.status.replace("_", " ")}</span>
                  <span className="progress-note"><RefText text={child.title} onOpen={nav} /></span>
                </div>
              );
            })}
          </div>
        )}

        <div className="detail-block form-block">
          <label>Log progress</label>
          <div className="row">
            <select value={sentiment} onChange={(e) => setSentiment(e.target.value)}>
              <option value="going_well">going well</option>
              <option value="converging">converging</option>
              <option value="neutral">neutral</option>
              <option value="diverging">diverging</option>
              <option value="struggling">struggling</option>
            </select>
          </div>
          <textarea rows={2} value={note} placeholder="One line — what just happened?" onChange={(e) => setNote(e.target.value)} />
          <div className="pct-inputs">
            <input type="number" min={0} max={100} value={completion} placeholder="% done" onChange={(e) => setCompletion(e.target.value)} />
            <input type="number" min={0} max={100} value={confidence} placeholder="% conf" onChange={(e) => setConfidence(e.target.value)} />
            <input type="number" min={0} max={100} value={risk} placeholder="% risk" onChange={(e) => setRisk(e.target.value)} />
          </div>
          <button className="opt-btn" disabled={!note.trim()} onClick={() => void logProgress()}>Log progress</button>
        </div>

        <div className="detail-block form-block">
          <label>Change status</label>
          {blockedIntent ? (
            <>
              <textarea rows={2} placeholder="Why is it blocked? (required)" value={blockedReason} onChange={(e) => setBlockedReason(e.target.value)} />
              <input placeholder="What unblocks it? (required)" value={unblockCondition} onChange={(e) => setUnblockCondition(e.target.value)} />
              <button
                className="opt-btn"
                disabled={!blockedReason.trim() || !unblockCondition.trim()}
                onClick={async () => {
                  await transition(taskId, "blocked", { note: blockedReason.trim(), unblock_condition: unblockCondition.trim() });
                  setBlockedReason(""); setUnblockCondition(""); onClose();
                }}
              >
                Mark blocked
              </button>
              <button className="opt-btn opt-ghost" onClick={onClose}>Cancel</button>
            </>
          ) : (
            <div className="ask-actions">
              {["todo", "in_progress", "blocked", "done"]
                .filter((s) => s !== task?.status)
                .map((s) => (
                  <button key={s} className="opt-btn" onClick={() => s === "blocked" ? setBlockedIntent(true) : void transition(taskId, s)}>{s}</button>
                ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

/** Render text with task references (BR#12, TASK-007) as clickable links. */
export function RefText({ text, onOpen }: { text: string; onOpen: (id: string) => void }) {
  const parts = text.split(TASK_REF_RE);
  return (
    <>
      {parts.map((p, i) =>
        /^(BR#\d+|TASK-\d+)$/.test(p) ? (
          <span key={i} className="task-ref" title={`open ${p}`} onClick={(e) => { e.stopPropagation(); onOpen(p); }}>{p}</span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/** Dependency graph: upstream (this task depends on / belongs to) on the left,
 *  downstream (children / dependents) on the right. Click a node to open it. */
function DepGraph({ selfId, selfTitle, relations, related, onOpen }: {
  selfId: string; selfTitle: string;
  relations: Array<{ relation: string; artefact_id: string; dir: string }>;
  related: KbArtefact[]; onOpen: (id: string) => void;
}) {
  const titleOf = (id: string): { id: string; title: string } => {
    const r = related.find((a) => a.id === id);
    return { id, title: r?.title ?? id };
  };
  const up = relations.filter((r) => r.dir === "out");
  const down = relations.filter((r) => r.dir === "in");
  const upNodes = up.map((r) => ({ ...titleOf(r.artefact_id), relation: r.relation }));
  const downNodes = down.map((r) => ({ ...titleOf(r.artefact_id), relation: r.relation }));
  const rows = Math.max(1, upNodes.length, downNodes.length);
  const NODE_H = 30, GAP = 8, MID_W = 130, SIDE = 180;
  const width = SIDE + MID_W + SIDE + 40;
  const height = rows * (NODE_H + GAP) + 34;
  const midY = height / 2 - NODE_H / 2;
  const trunc = (s: string, n = 26) => (s.length > n ? s.slice(0, n) + "…" : s);
  return (
    <div className="dep-graph">
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height}>
        <text x={width / 2 - MID_W / 2} y={midY + NODE_H + 14} textAnchor="middle" className="dep-label">this task</text>
        {upNodes.map((n, i) => {
          const y = (i * (NODE_H + GAP)) + 6;
          return (
            <g key={`u${i}`} className="dep-node dep-parent" onClick={() => onOpen(n.id)}>
              <rect x={0} y={y} width={SIDE} height={NODE_H} rx={5} />
              <text x={8} y={y + 13} className="dep-title">{trunc(`${n.id} ${trunc(n.title, 18)}`)}</text>
              <text x={8} y={y + 24} className="dep-label">{n.relation}</text>
              <path className="dep-edge" d={`M ${SIDE} ${y + NODE_H / 2} C ${SIDE + 40} ${y + NODE_H / 2}, ${width / 2 - MID_W / 2 - 40} ${midY + NODE_H / 2}, ${width / 2 - MID_W / 2} ${midY + NODE_H / 2}`} />
            </g>
          );
        })}
        {downNodes.map((n, i) => {
          const y = (i * (NODE_H + GAP)) + 6;
          return (
            <g key={`d${i}`} className="dep-node dep-child" onClick={() => onOpen(n.id)}>
              <rect x={width - SIDE} y={y} width={SIDE} height={NODE_H} rx={5} />
              <text x={width - SIDE + 8} y={y + 13} className="dep-title">{trunc(`${n.id} ${trunc(n.title, 18)}`)}</text>
              <text x={width - SIDE + 8} y={y + 24} className="dep-label">{n.relation}</text>
              <path className="dep-edge" d={`M ${width - SIDE} ${y + NODE_H / 2} C ${width - SIDE - 40} ${y + NODE_H / 2}, ${width / 2 + MID_W / 2 + 40} ${midY + NODE_H / 2}, ${width / 2 + MID_W / 2} ${midY + NODE_H / 2}`} />
            </g>
          );
        })}
        <g className="dep-node" onClick={() => onOpen(selfId)}>
          <rect x={width / 2 - MID_W / 2} y={midY} width={MID_W} height={NODE_H} rx={5} style={{ fill: "color-mix(in srgb, var(--accent) 10%, var(--bg-raised))", stroke: "var(--accent)" }} />
          <text x={width / 2} y={midY + 19} textAnchor="middle" className="dep-title" style={{ fontWeight: 700 }}>{trunc(selfId + " " + trunc(selfTitle, 14), 20)}</text>
        </g>
      </svg>
    </div>
  );
}

// — small local hooks/imports kept at bottom to keep the panel readable —
import { useKb } from "../store/kb";
import { getConfig } from "../lib/config";

function getConfigUrl(): string {
  return getConfig().url;
}
