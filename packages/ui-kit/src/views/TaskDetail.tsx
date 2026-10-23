import { useEffect, useMemo, useState } from "react";
import { Btn, Chip, type ChipTone, TextArea, TextInput } from "./index-kit";
import { kbApi } from "../server/kb";
import type { KbAsk } from "../server/kb";
import { md, AskOptions, askKernel } from "./decide";
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


/** Markdown rendered for reading, with task refs (BR#12, TASK-007) as links. */
export function MdRef({ text, onOpen }: { text: string | undefined; onOpen?: (id: string) => void }) {
  const html = md(text ?? "");
  if (!html.trim()) return null;
  const parts = html.split(TASK_REF_RE);
  return (
    <>
      {parts.map((p, i) =>
        /^(BR#\d+|TASK-\d+)$/.test(p) ? (
          <span key={i} className="task-ref" title={`open ${p}`} onClick={(e) => { e.stopPropagation(); onOpen?.(p); }}>{p}</span>
        ) : (
          <span key={i} dangerouslySetInnerHTML={{ __html: p }} />
        ),
      )}
    </>
  );
}


/** Long-form markdown that starts collapsed at its kernel. */
function MdLong({ text, limit = 260 }: { text: string | undefined; limit?: number }) {
  const s = (text ?? "").trim();
  if (!s) return null;
  if (s.length <= limit) return <div className="md-body"><MdRef text={s} /></div>;
  return (
    <details className="longtext">
      <summary>{s.slice(0, limit).trimEnd()}… <span className="lt-toggle">more</span></summary>
      <div className="md-body lt-full"><MdRef text={s} /></div>
    </details>
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
export function TaskStateCard({ task, onChanged }: { task: KbArtefact & { meta?: TaskMeta; status_ts?: number; project?: string; created_by?: string }; onChanged?: () => void }) {
  const m = (task.meta ?? {}) as TaskMeta;
  const lp = m.last_progress;
  const [ask, setAsk] = useState<KbAsk | null>(null);
  const [answerText, setAnswerText] = useState("");
  const [busy, setBusy] = useState(false);
  const [cardErr, setCardErr] = useState("");

  useEffect(() => {
    const id = m.awaiting_ask?.ask_id;
    if (!id) { setAsk(null); return; }
    let on = true;
    if (/^BR#\d+$/.test(id)) {
      // question NODE: it is a task — read it from the live board, artefact as fallback
      const fromBoard = useKb.getState().tasks.find((t) => t.id === id);
      if (fromBoard) {
        const am = (fromBoard.meta ?? {}) as any;
        setAsk({
          id, display: id, to: am.ask?.to ?? "any", question: fromBoard.title,
          options: am.ask?.options ?? [], urgency: am.ask?.urgency ?? "normal",
          status: ["done", "superseded"].includes(fromBoard.status) ? "answered" : "open",
          artefact_id: am.ask?.artefact_id, created_ts: fromBoard.created_ts,
        });
        return;
      }
      kbApi.artefact(id).then((a) => {
        if (!on) return;
        const am = (a.meta ?? {}) as any;
        setAsk({
          id, display: id, to: am.ask?.to ?? "any", question: a.title,
          options: am.ask?.options ?? [], urgency: am.ask?.urgency ?? "normal",
          status: ["done", "superseded"].includes(a.status) ? "answered" : "open",
          artefact_id: am.ask?.artefact_id, created_ts: a.created_ts,
        });
      }).catch(() => { if (on) setAsk(null); });
      return;
    }
    kbApi.ask(id).then((a) => { if (on) setAsk(a); }).catch(() => { if (on) setAsk(null); });
    return () => { on = false; };
  }, [m.awaiting_ask?.ask_id]);

  const answerAsk = async (answer: string) => {
    if (!ask || !m.awaiting_ask?.ask_id) return;
    setBusy(true);
    try {
      await kbApi.askAnswer(m.awaiting_ask.ask_id, answer);
      await useKb.getState().refresh();
      onChanged?.();
    } catch (e) { setCardErr((e as Error).message || "failed"); useKb.getState().reportError("ask answer / unblock", e); } finally {
      setBusy(false);
    }
  };
  const unblock = async () => {
    setBusy(true);
    try {
      if (ask && m.awaiting_ask?.ask_id) await answerAsk("unblocked by human");
      else await kbApi.transition(task.id, "in_progress", { note: "unblocked by human — condition satisfied" });
      await useKb.getState().refresh();
      onChanged?.();
    } catch (e) { setCardErr((e as Error).message || "failed"); useKb.getState().reportError("ask answer / unblock", e); } finally {
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
            <b>{ask.urgency === "urgent" ? "URGENT ask" : "Ask"}</b> {ask.display ?? ask.id} · to {ask.to} · asked {rel(ask.created_ts)}
          </div>
          <div className="progress-note"><MdLong text={ask.question} limit={260} /></div>
          {ask.options.length > 0 && (
            <div className="row" style={{ marginTop: 8, flexWrap: "wrap", gap: 4 }}>
              {ask.options.map((o) => (
                <Btn key={o} size="sm" variant="accept" disabled={busy} title={`answer: ${o} — the task auto-resumes`} onClick={() => void answerAsk(o)}>{o}</Btn>
              ))}
            </div>
          )}
          <div className="row" style={{ marginTop: 6 }}>
            <TextInput
              value={answerText} placeholder="or answer in your own words…"
              onChange={(e) => setAnswerText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && answerText.trim()) void answerAsk(answerText.trim()); }}
            />
            <Btn size="sm" disabled={busy || !answerText.trim()} onClick={() => void answerAsk(answerText.trim())}>Answer</Btn>
            <Btn size="sm" quiet disabled={busy} title="answer 'unblocked' — resumes the task" onClick={() => void unblock()}>Unblock</Btn>
            {cardErr && <span className="k-err">{cardErr}</span>}
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


/** The answering surface when the viewed task IS a question node:
 *  question rendered for reading, options as one-click buttons, free-text
 *  refinement, subject context. Common to any task — this is the detail view. */
function AskSelfCard({ task, onChanged }: { task: KbArtefact & { meta?: any }; onChanged?: () => void }) {
  const ask = task.meta?.ask ?? {};
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [text, setText] = useState("");
  const [reframeText, setReframeText] = useState("");
  const answer = async (a: string) => {
    if (!a.trim()) return;
    setBusy(true);
    setErr("");
    try {
      await kbApi.askAnswer(task.id, a.trim());
      await useKb.getState().refresh();
      onChanged?.();
    } catch (e) {
      setErr((e as Error).message || "answer failed");
      useKb.getState().reportError("answer ask", e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="task-blocked-info" style={{ marginBottom: 10 }}>
      <div className="ask-chips">
        <Chip tone="needs">ASK</Chip>
        {ask.urgency === "urgent" && <Chip tone="urgent">URGENT</Chip>}
        <span className="why-line">to {ask.to ?? "any"} · from {ask.from ?? "agent"} · asked {rel(task.created_ts)}</span>
      </div>
      {ask.reason && (
        <div className="progress-note ask-reason"><b>why escalated:</b> {ask.reason}</div>
      )}
      <div className="progress-note md-body"><MdRef text={task.body_md || task.title} onOpen={() => onChanged?.()} /></div>
      {(ask.options ?? []).length > 0 && (
        <AskOptions options={ask.options as string[]} busy={busy} onPick={(o) => void answer(o)} />
      )}
      <div className="steer-box" style={{ marginTop: 8 }}>
        <TextArea rows={2} value={text} placeholder="or answer in your own words…" onChange={(e) => setText(e.target.value)} />
        <Btn disabled={busy || !text.trim()} onClick={() => void answer(text)}>Answer</Btn>
      </div>
      <div className="steer-box">
        {ask.reframe ? (
          <span className="muted-note">reframed by {ask.reframe.by} — awaiting structured re-ask: {ask.reframe.feedback}</span>
        ) : (
          <>
            <TextArea rows={1} value={reframeText} placeholder="Reframe: kick back to the asker to restructure (optional feedback)…" onChange={(e) => setReframeText(e.target.value)} />
            <Btn size="sm" quiet disabled={busy} onClick={() => {
              setBusy(true);
              kbApi.askReframe(task.id, reframeText.trim() || undefined)
                .then(() => { setReframeText(""); useKb.getState().refresh(); onChanged?.(); })
                .catch((e) => { setErr((e as Error).message); useKb.getState().reportError("reframe ask", e); })
                .finally(() => setBusy(false));
            }}>Reframe this</Btn>
          </>
        )}
      </div>
      {err && <p className="k-err">{err}</p>}
    </div>
  );
}

export function TaskDetail({ taskId, onClose, onOpen }: {
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
  const [body, setBody] = useState<string | null>(null);
  const [showBody, setShowBody] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [versions, setVersions] = useState<KbVersion[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

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
      } catch (e) { useKb.getState().reportError("load task", e); }
      try {
        const r = await kbApi.related(taskId);
        if (on) setRelated(r.artefacts ?? []);
      } catch (e) { useKb.getState().reportError("load task relations", e); }
      try {
        const h = await kbApi.history(taskId);
        if (on) setVersions(h.versions ?? []);
      } catch (e) { useKb.getState().reportError("load task relations", e); }
    })();
    return () => { on = false; };
  }, [taskId, reloadKey]);

    // navigate to another task inside the same panel (task refs / dep graph)
  const nav = (id: string) => {
    if (!onOpen) return;
    onOpen(id);
  };
  const comment = async () => {
    if (!note.trim()) return;
    setBusy(true);
    try {
      await kbApi.progress(taskId, note.trim());
      setNote(""); setMsg("comment posted");
      setTimeout(() => setMsg(""), 2000);
      const h = await kbApi.history(taskId);
      setVersions(h.versions ?? []);
    } catch (e) { useKb.getState().reportError("post comment", e); setMsg("comment failed"); } finally {
      setBusy(false);
    }
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

        <h2 className="detail-question">
          {task && (task.meta as any)?.ask
            ? <RefText text={askKernel(task.title)} onOpen={nav} />
            : <RefText text={task?.title ?? taskId} onOpen={nav} />}
        </h2>

        {task && <TaskStateCard task={task as any} onChanged={() => setReloadKey((x) => x + 1)} />}

        {task && !!(task.meta as TaskMeta)?.ask && !["done", "superseded"].includes(task.status) && (
          <AskSelfCard task={{ ...(task as any), meta: (task.meta ?? {}) as any }} onChanged={() => setReloadKey((x) => x + 1)} />
        )}

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
              <div className="md-body know-body"><MdRef text={body || "—"} onOpen={nav} /></div>
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
                  <span className="progress-note md-body"><MdRef text={v.summary} onOpen={nav} /></span>
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
          <label>Comment / steer</label>
          <TextArea rows={2} value={note} placeholder="Add context for the agent — lands on the task's history" onChange={(e) => setNote(e.target.value)} />
          <Btn disabled={!note.trim() || busy} onClick={() => void comment()}>Comment</Btn>
          {msg && <span className="ok" style={{ marginLeft: 8 }}>{msg}</span>}
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

