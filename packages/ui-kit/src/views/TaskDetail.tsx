import { useEffect, useMemo, useState } from "react";
import { ActionRow, Btn, Chip, type ChipTone, Select, TextArea, TextInput } from "./index-kit";
import { kbApi } from "../server/kb";
import type { KbAsk } from "../server/kb";
import type { KbArtefact, KbVersion } from "../server/kb";
import { kindOf, rel, TASK_REF_RE } from "../server/views";
import { useKb } from "../server/kbStore";

export const SENTIMENT_CHIP: Record<string, ChipTone> = {
  going_well: "done",
  neutral: "neutral",
  struggling: "diag",
  converging: "scope",
  diverging: "urgent",
};

/** Unified history: one log holds progress notes AND state changes, typed. */
export const HISTORY_CHIP: Record<string, ChipTone> = {
  progress: "scope",
  transition: "warn",
  create: "done",
  update: "muted",
  reassign: "urgent",
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


/** Show the kernel of a long text; full text behind a "more" toggle. */
export function LongText({ text, limit }: { text: string | undefined; limit: number }) {
  const t = (text ?? "").trim();
  if (!t) return null;
  if (t.length <= limit) return <span>{t}</span>;
  return (
    <details className="longtext">
      <summary>{t.slice(0, limit).trimEnd()}… <span className="lt-toggle">more</span></summary>
      <span className="lt-full">{t}</span>
    </details>
  );
}

/** Resume contracts enumerate their conditions "(1) … (2) …" — split them into
 *  discrete items so the panel shows a checklist, not a wall. */
export function splitConditions(s: string | undefined): string[] {
  const t = (s ?? "").trim();
  if (!t) return [];
  const marks = t.match(/\(\d\)/g);
  if (!marks || marks.length < 2) return [t];
  const parts = t.split(/\(\d\)\s*/).map((x) => x.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [t];
}

function trunc(s: string | undefined, n: number): string {
  const t = (s ?? "").trim();
  return t.length > n ? `${t.slice(0, n).trimEnd()}…` : t;
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
export function TaskStateCard({ task, onChanged }: { task: KbArtefact & { meta?: TaskMeta; status_ts?: number; project?: string; created_by?: string }; onChanged?: () => void }) {
  const m = (task.meta ?? {}) as TaskMeta;
  const lp = m.last_progress;
  const [ask, setAsk] = useState<KbAsk | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const id = m.awaiting_ask?.ask_id;
    if (!id) { setAsk(null); return; }
    let on = true;
    kbApi.ask(id).then((a) => { if (on) setAsk(a); }).catch(() => { if (on) setAsk(null); });
    return () => { on = false; };
  }, [m.awaiting_ask?.ask_id]);

  const unblock = async () => {
    setBusy(true);
    try {
      if (ask && m.awaiting_ask?.ask_id) await kbApi.askAnswer(m.awaiting_ask.ask_id, "unblocked by human (panel)");
      else await kbApi.transition(task.id, "in_progress", { note: "unblocked by human — condition satisfied (panel)" });
      await useKb.getState().refresh();
      onChanged?.();
    } catch { /* history shows the failure */ } finally {
      setBusy(false);
    }
  };
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
            <Chip key={k} tone="scope" title={`${k} gauge (last progress)`}>{k} {v}%</Chip>
          ))}
        </div>
      )}
      {m.blocked && (
        <div className="task-blocked-info">
          <div className="progress-note"><b>why blocked:</b> <LongText text={m.blocked.reason} limit={220} /></div>
          {(splitConditions(m.blocked.unblock_condition).length > 0) && (
            <div className="progress-note">
              <b>resumes when:</b>
              <ol className="cond-list">
                {splitConditions(m.blocked.unblock_condition).map((c, i) => (
                  <li key={i}><LongText text={c} limit={160} /></li>
                ))}
              </ol>
            </div>
          )}
          <div className="row" style={{ marginTop: 6 }}>
            <Btn
              size="sm" variant="accept" disabled={busy}
              title={m.blocked.unblock_condition ? `Mark satisfied and resume now: "${trunc(m.blocked.unblock_condition, 110)}"` : "Resume the task now"}
              onClick={() => void unblock()}
            >Unblock now</Btn>
            <span className="muted-note">
              {m.blocked.unblock_condition ? `resume before the gate: "${trunc(m.blocked.unblock_condition, 90)}"` : "resume the task now"}
            </span>
          </div>
        </div>
      )}
      {ask && ask.status === "open" && (
        <div className="task-blocked-info">
          <div className="progress-note">
            <b>{ask.urgency === "urgent" ? "URGENT ask" : "Ask"}</b> {ask.id} · to {ask.to} · asked {rel(ask.created_ts)}
          </div>
          <div className="progress-note"><LongText text={ask.question} limit={260} /></div>
          {ask.options.length > 0 && <div className="ask-chips">{ask.options.map((o) => <Chip key={o} tone="scope">{o}</Chip>)}</div>}
          <div className="row" style={{ marginTop: 6 }}>
            <Btn
              size="sm" variant="accept" disabled={busy}
              title={`Answer ${ask.id} — "${trunc(ask.question, 110)}" — the task auto-resumes in_progress`}
              onClick={() => void unblock()}
            >Unblock now</Btn>
            <span className="muted-note">answers {ask.id}: "{trunc(ask.question, 90)}"</span>
          </div>
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
        <div className="task-tags">{(task.tags as string[]).map((t) => <Chip key={t} tone="scope">{t}</Chip>)}</div>
      )}
    </div>
  );
}

export function TaskDetail({ taskId, openBlocked, onClose, onOpen }: {
  taskId: string; openBlocked?: boolean; onClose: () => void; onOpen?: (id: string) => void;
}) {
  // 1s tick — "time spent" on spawned work counts up live while the panel is open
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
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
  const [reloadKey, setReloadKey] = useState(0);

  const transition = useKb((s) => s.transition);
  const boardTasks = useKb((s) => s.tasks) as any[];
  // children resolve from the LIVE board store first (complete + realtime via
  // WS) — the semantic `related` call misses most children (embedding-ranked,
  // limit ~6), which is why the work tree used to render empty
  const childIndex = useMemo(() => {
    const m = new Map<string, any>();
    for (const t of boardTasks) m.set(t.id, t);
    for (const r of related) if (!m.has(r.id)) m.set(r.id, r);
    return m;
  }, [boardTasks, related]);

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
  }, [taskId, reloadKey]);

  const clampPct = (v: string) => (v === "" ? undefined : Math.max(0, Math.min(100, Math.round(Number(v)))));
  // navigate to another task inside the same panel (task refs / dep graph)
  const nav = (id: string) => {
    if (!onOpen) return;
    onOpen(id);
  };
  const logProgress = async () => {
    if (!note.trim()) return;
    try {
      await kbApi.progressGauges({
        id: taskId, note: note.trim(), sentiment,
        completion_pct: clampPct(completion), confidence_pct: clampPct(confidence), risk_pct: clampPct(risk),
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
            <Chip tone="scope">{task?.type ?? "task"}</Chip>
            <span className={`kind-pill kp-${kindOf((task ?? {}) as any)}`}>{kindOf((task ?? {}) as any)}</span>
            <Chip>{task?.status ?? "…"}</Chip>
          </div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </header>

        <h2 className="detail-question"><RefText text={task?.title ?? taskId} onOpen={nav} /></h2>

        {task && <TaskStateCard task={task as any} onChanged={() => setReloadKey((x) => x + 1)} />}

        {task?.meta?.last_progress?.note && (
          <p className="task-progress-line">
            <Chip tone={SENTIMENT_CHIP[task.meta.last_progress.sentiment ?? ""] ?? "neutral"}>
              {task.meta.last_progress.sentiment ?? "progress"}
            </Chip>
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
                <TextArea rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
                <Btn
                  onClick={async () => { await kbApi.update(taskId, { body_md: body }); setMsg("saved"); setTimeout(() => setMsg(""), 1500); }}
                >
                  Save description
                </Btn>
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
                  <Chip tone={HISTORY_CHIP[v.action] ?? "muted"} title={HISTORY_LABEL[v.action] ?? v.action}>
                    {HISTORY_LABEL[v.action] ?? v.action}
                  </Chip>
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
          <div className="detail-block history-block">
            <label>Work tree — spawned tasks, live</label>
            <div className="worktree-list">
              {relations.filter((r) => r.dir === "in").map((r) => {
                const child = childIndex.get(r.artefact_id);
                if (!child) return null;
                return <WorkTreeRow key={r.artefact_id} child={child} relation={r.relation} nav={nav} now={Date.now()} />;
              })}
            </div>
          </div>
        )}

        <div className="detail-block form-block">
          <label>Log progress</label>
          <div className="row">
            <Select value={sentiment} onChange={(e) => setSentiment(e.target.value)}>
              <option value="going_well">going well</option>
              <option value="converging">converging</option>
              <option value="neutral">neutral</option>
              <option value="diverging">diverging</option>
              <option value="struggling">struggling</option>
            </Select>
          </div>
          <TextArea rows={2} value={note} placeholder="One line — what just happened?" onChange={(e) => setNote(e.target.value)} />
          <div className="pct-inputs">
            <TextInput type="number" min={0} max={100} value={completion} placeholder="% done" onChange={(e) => setCompletion(e.target.value)} />
            <TextInput type="number" min={0} max={100} value={confidence} placeholder="% conf" onChange={(e) => setConfidence(e.target.value)} />
            <TextInput type="number" min={0} max={100} value={risk} placeholder="% risk" onChange={(e) => setRisk(e.target.value)} />
          </div>
          <Btn disabled={!note.trim()} onClick={() => void logProgress()}>Log progress</Btn>
        </div>

        <div className="detail-block form-block">
          <label>Change status</label>
          {blockedIntent ? (
            <>
              <TextArea rows={2} placeholder="Why is it blocked? (required)" value={blockedReason} onChange={(e) => setBlockedReason(e.target.value)} />
              <TextInput placeholder="What unblocks it? (required)" value={unblockCondition} onChange={(e) => setUnblockCondition(e.target.value)} />
              <Btn
                disabled={!blockedReason.trim() || !unblockCondition.trim()}
                onClick={async () => {
                  await transition(taskId, "blocked", { note: blockedReason.trim(), unblock_condition: unblockCondition.trim() });
                  setBlockedReason(""); setUnblockCondition(""); onClose();
                }}
              >
                Mark blocked
              </Btn>
              <Btn quiet onClick={onClose}>Cancel</Btn>
            </>
          ) : (
            <ActionRow>
              {["todo", "in_progress", "blocked", "done"]
                .filter((s) => s !== task?.status)
                .map((s) => (
                  <Btn key={s} onClick={() => s === "blocked" ? setBlockedIntent(true) : void transition(taskId, s)}>{s}</Btn>
                ))}
            </ActionRow>
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

/** One spawned task in the work tree: state, live time-in-state, last signal.
 *  Live = the row re-renders every second (panel has a 1s clock), so "time
 *  spent" counts up in real time for active work. Re-verified rounds show
 *  attempt counts. Click navigates into the child. */
function WorkTreeRow({ child, relation, nav, now }: {
  child: any; relation: string; nav: (id: string) => void; now: number;
}) {
  const m = child.meta ?? {};
  const p = m.last_progress ?? {};
  const status = child.status;
  const state = status === "done" ? "done" : status === "in_review" ? "review" : status === "blocked" ? "blocked" : status === "todo" ? "queued" : "active";
  const stateClass = { done: "wt-done", review: "wt-review", blocked: "wt-error", queued: "wt-queued", active: "wt-active" }[state] ?? "wt-active";
  const statusTs = (child as any).status_ts ?? child.updated_ts;
  const spent = statusTs ? Math.max(0, now - statusTs) : 0;
  const spentTxt = spent > 3600_000
    ? `${Math.floor(spent / 3600_000)}h ${Math.floor((spent % 3600_000) / 60_000)}m`
    : `${Math.floor(spent / 60_000)}m ${Math.floor((spent % 60_000) / 1000)}s`;
  const sinceSignal = p.ts ? now - p.ts : Infinity;
  const stale = state === "active" && sinceSignal > 10 * 60_000;
  const attempts = m.attempt?.attempts ?? 0;
  const kind = (child.tags ?? []).includes("role:review") ? "verify"
    : (child.tags ?? []).includes("role:analysis") ? "analysis"
    : (child.tags ?? []).includes("role:unblock") ? "unblock"
    : (child.tags ?? []).includes("role:impl") ? "impl" : relation;
  const lastNote = (p.note ?? "").slice(0, 90);
  return (
    <div className={`wt-row ${stateClass}`} onClick={() => nav(child.id)} title={lastNote ? `last: ${lastNote}` : child.title}>
      <span className={`wt-dot ${stateClass}${stale ? " wt-stale" : ""}`} title={stale ? "active but no signal >10m" : state} />
      <span className="wt-kind">{kind}</span>
      <span className="wt-title" title={child.title}>{child.title.length > 64 ? child.title.slice(0, 64) + "…" : child.title}</span>
      {attempts > 0 && <Chip tone="urgent" className="wt-att" title={`attempted ${attempts}x`}>×{attempts}</Chip>}
      <span className="wt-state">{state}</span>
      <span className="wt-time top-num" title="time in current state (live)">{spentTxt}</span>
    </div>
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

