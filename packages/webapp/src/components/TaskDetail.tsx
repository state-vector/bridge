import { useEffect, useMemo, useState } from "react";
import { kbApi } from "../lib/kb";
import type { KbArtefact, KbProgress } from "../lib/kb";
import { rel } from "../lib/views";

export const SENTIMENT_CHIP: Record<string, string> = {
  going_well: "chip-done",
  neutral: "",
  struggling: "chip-diag",
  converging: "chip-kind kind-agent",
  diverging: "chip-urgent",
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
  last_progress?: { note?: string; sentiment?: string; actor?: string; ts?: number };
}

export function TaskDetail({ taskId, openBlocked, onClose }: { taskId: string; openBlocked?: boolean; onClose: () => void }) {
  const [task, setTask] = useState<(KbArtefact & { meta?: TaskMeta; status_ts?: number }) | null>(null);
  const [related, setRelated] = useState<KbArtefact[]>([]);
  const [note, setNote] = useState("");
  const [sentiment, setSentiment] = useState("neutral");
  const [body, setBody] = useState<string | null>(null);
  const [showBody, setShowBody] = useState(false);
  const [msg, setMsg] = useState("");
  const [blockedIntent, setBlockedIntent] = useState(!!openBlocked);
  const [blockedReason, setBlockedReason] = useState("");
  const [unblockCondition, setUnblockCondition] = useState("");

  const progress = useKbStateProgress(taskId);
  const transition = useKb((s) => s.transition);

  useEffect(() => {
    let on = true;
    void (async () => {
      try {
        const a = await kbApi.artefact(taskId);
        if (on) {
          setTask(a as KbArtefact & { meta?: TaskMeta });
          setBody(a.body_md ?? "");
        }
      } catch { /* stale */ }
      try {
        const r = await kbApi.related(taskId);
        if (on) setRelated(r.artefacts ?? []);
      } catch { /* offline */ }
    })();
    return () => { on = false; };
  }, [taskId]);

  const logProgress = async () => {
    if (!note.trim()) return;
    try {
      await fetch(`${getConfigUrl()}/api/kb/progress`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: taskId, note: note.trim(), sentiment }),
      });
      setNote("");
    } catch { /* offline */ }
  };

  return (
    <>
      <div className="panel-backdrop" onClick={onClose} />
      <aside className="detail-panel">
        <header className="detail-head">
          <div className="ask-chips">
            <span className="chip chip-scope">{task?.type ?? "task"}</span>
            <span className="chip">{task?.status ?? "…"}</span>
          </div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </header>

        <h2 className="detail-question">{task?.title ?? taskId}</h2>
        {task?.meta?.last_progress && (
          <p className="task-progress-line">
            <span className={`chip ${SENTIMENT_CHIP[task.meta.last_progress.sentiment ?? ""] ?? ""}`}>
              {task.meta.last_progress.sentiment ?? "progress"}
            </span>
            <span>{task.meta.last_progress.note ?? ""}</span>
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

        <div className="detail-block">
          <label>Progress (feeds the live board)</label>
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
          <button className="opt-btn" disabled={!note.trim()} onClick={() => void logProgress()}>Log progress</button>
        </div>

        <div className="detail-block">
          <label>Status</label>
          {task?.meta?.blocked && (
            <div className="task-blocked-info">
              <div className="progress-note"><b>why:</b> {task.meta.blocked.reason ?? ""}</div>
              <div className="progress-note"><b>unblocks when:</b> {task.meta.blocked.unblock_condition ?? ""}</div>
            </div>
          )}
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

        <div className="detail-block">
          <label>Progress history</label>
          <div className="progress-history">
            {progress.length === 0 && <span className="muted-note">no progress logged yet</span>}
            {progress.map((p) => {
              const d = (p.detail ?? {}) as { note?: string; sentiment?: string };
              return (
                <div key={p.seq} className="progress-line">
                  <span className={`chip ${SENTIMENT_CHIP[d.sentiment ?? ""] ?? ""}`}>
                    {d.sentiment ?? "progress"}
                  </span>
                  <span className="progress-note">{d.note}</span>
                  <span className="step-ts">{p.actor} · {rel(p.ts)}</span>
                </div>
              );
            })}
          </div>
        </div>

        {related.length > 0 && (
          <div className="detail-block">
            <label>Related</label>
            {related.map((r) => (
              <div key={r.id} className="progress-line">
                <span className="chip chip-scope">{r.type}</span> {r.title}
              </div>
            ))}
          </div>
        )}

        <dl className="audit" style={{ marginTop: "auto" }}>
          <dt>id</dt><dd>{task?.id ?? taskId}</dd>
          <dt>owner</dt><dd>{task?.owner ?? "—"}</dd>
          <dt>session</dt><dd>{task?.meta?.session ?? "—"}</dd>
          <dt>in lane</dt><dd>{task?.status_ts ? rel(task.status_ts) : "—"}</dd>
          <dt>tags</dt><dd>{((task?.tags ?? []) as string[]).join(", ") || "—"}</dd>
          <dt>updated</dt><dd>{task ? rel(task.updated_ts) : "—"}</dd>
        </dl>
      </aside>
    </>
  );
}

// — small local hooks/imports kept at bottom to keep the panel readable —
import { useKb } from "../store/kb";
import { getConfig } from "../lib/config";

function useKbStateProgress(taskId: string): KbProgress[] {
  const progress = useKb((s) => s.progress);
  return useMemo(() => progress.filter((p) => p.artefact_id === taskId), [progress, taskId]);
}

function getConfigUrl(): string {
  return getConfig().url;
}
