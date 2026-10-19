import { useEffect, useMemo, useState } from "react";
import snarkdown from "snarkdown";
import { useKb } from "../store/kb";
import { useBridge } from "../lib/store";
import { kbApi, type KbArtefact } from "../lib/kb";
import { rel } from "../lib/views";

/** For Me — the human's inbox. First tab. Surfaces everything awaiting a
 *  human decision or attention:
 *   - proposed KB decisions (BR#621-class) — markdown popover, comment,
 *     accept / reject-with-reason inline; the transition POST route acts
 *     as actor "web" which satisfies the human-authoritative gate
 *   - open agent asks addressed to the human (hub plane)
 *   - open question threads (link into Discussions)
 */

const KIND_CHIP: Record<string, string> = { proposed: "chip-needs", accepted: "chip-done", rejected: "chip-done" };

/** snarkdown → sanitized-enough HTML: strip script/on* attrs (trusted-ish
 *  content — our own KB — but defence in depth costs one line). */
function md(src: string): string {
  const html = snarkdown(src ?? "");
  return html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/ on\w+="[^"]*"/gi, "");
}

interface HistoryEntry {
  seq: number;
  ts: number;
  actor: string;
  action: string;
  summary: string;
  data: Record<string, unknown>;
}

function Comment({ v }: { v: HistoryEntry }) {
  const note = (v.data?.note as string | undefined) ?? v.summary;
  if (!note?.trim()) return null;
  const isComment = v.action === "comment";
  return (
    <div className={`resp ${isComment ? "resp-note" : ""}`}>
      <div className="ask-chips">
        <span className="resp-actor">{v.actor}</span>
        <span className="why-line">{rel(v.ts)}</span>
      </div>
      <div className="resp-body md-body" dangerouslySetInnerHTML={{ __html: md(note) }} />
    </div>
  );
}

function DecisionPopover({ d, onClose, onChanged }: { d: KbArtefact; onClose: () => void; onChanged: () => void }) {
  const [comments, setComments] = useState<HistoryEntry[] | null>(null);
  const [comment, setComment] = useState("");
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let dead = false;
    setComments(null);
    kbApi.history(d.id)
      .then((r) => { if (!dead) setComments((r.versions ?? []) as HistoryEntry[]); })
      .catch(() => { if (!dead) setComments([]); });
    return () => { dead = true; };
  }, [d.id, d.updated_ts]);

  const reloadComments = async () => {
    try {
      const r = await kbApi.history(d.id);
      setComments((r.versions ?? []) as HistoryEntry[]);
    } catch { /* keep stale */ }
  };

  const addComment = async () => {
    if (!comment.trim()) return;
    setBusy(true);
    try {
      await kbApi.progress(d.id, comment.trim());
      setComment("");
      await reloadComments();
    } catch (e) {
      setMsg(`comment failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const act = async (to: "accepted" | "rejected") => {
    if (to === "rejected" && !rejectReason.trim()) return;
    setBusy(true);
    try {
      const note = to === "accepted"
        ? `accepted by human (For Me)${comment.trim() ? ` — ${comment.trim()}` : ""}`
        : `rejected by human (For Me) — ${rejectReason.trim()}`;
      await kbApi.transition(d.id, to, { note });
      setMsg(to === "accepted" ? "accepted" : "rejected");
      onChanged();
      onClose();
    } catch (e) {
      setMsg(`failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      setTimeout(() => setMsg(""), 2500);
    }
  };

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="forme-pop" onClick={(e) => e.stopPropagation()}>
        <div className="ask-chips">
          <span className="chip chip-urgent">DECISION</span>
          <span className={`chip ${KIND_CHIP[d.status] ?? "chip-needs"}`}>{d.status.toUpperCase()}</span>
          <span className="why-line">{d.id} · proposed {rel(d.created_ts)} · by {d.owner ?? "—"}</span>
          <button className="opt-btn opt-ghost forme-close" onClick={onClose}>✕</button>
        </div>
        <h2>{d.title}</h2>
        <div className="md-body forme-body" dangerouslySetInnerHTML={{ __html: md(d.body_md ?? "") }} />

        <h3 className="forme-sub">Comments</h3>
        <div className="forme-comments">
          {(comments ?? []).length === 0 && comments !== null && <p className="empty">no comments yet</p>}
          {(comments ?? []).map((v) => <Comment key={v.seq} v={v} />)}
          {comments === null && <p className="empty">loading…</p>}
        </div>
        <div className="steer-box">
          <input
            value={comment}
            placeholder="Add a comment…"
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) void addComment(); }}
          />
          <button className="opt-btn" disabled={busy || !comment.trim()} onClick={() => void addComment()}>Comment</button>
        </div>

        {rejectOpen && (
          <div className="steer-box forme-reject">
            <input
              autoFocus
              value={rejectReason}
              placeholder="Why reject? (required)"
              onChange={(e) => setRejectReason(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void act("rejected"); }}
            />
            <button className="opt-btn" disabled={busy || !rejectReason.trim()} onClick={() => void act("rejected")}>Confirm reject</button>
            <button className="opt-btn opt-ghost" onClick={() => setRejectOpen(false)}>Cancel</button>
          </div>
        )}

        <div className="ask-actions">
          <button className="opt-btn" disabled={busy} onClick={() => void act("accepted")}>Accept</button>
          <button className="opt-btn opt-ghost" disabled={busy} onClick={() => setRejectOpen(true)}>Reject…</button>
        </div>
        {msg && <p className="ok">{msg}</p>}
      </div>
    </div>
  );
}

function DecisionRow({ d, onDone }: { d: KbArtefact; onDone: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card ask-urgent forme-item">
      <div className="ask-chips">
        <span className="chip chip-urgent">DECISION</span>
        <span className={`chip ${KIND_CHIP[d.status] ?? "chip-needs"}`}>{d.status.toUpperCase()}</span>
        <span className="why-line">{d.id} · proposed {rel(d.created_ts)}</span>
      </div>
      <h3 className="ask-question" onClick={() => setOpen(true)}>{d.title}</h3>
      <div className="ask-actions">
        <button className="opt-btn opt-ghost" onClick={() => setOpen(true)}>Open ↗</button>
      </div>
      {open && <DecisionPopover d={d} onClose={() => setOpen(false)} onChanged={() => onDone(d.id)} />}
    </div>
  );
}

function AskRow({ d, onDone }: { d: any; onDone: (id: string) => void }) {
  const resolve = useBridge((s) => s.resolve);
  const [busy, setBusy] = useState(false);

  const act = async (action: "unblocked" | "completed") => {
    setBusy(true);
    try {
      await resolve(d, action, undefined, undefined);
      onDone(d.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card forme-item">
      <div className="ask-chips">
        <span className="chip chip-needs">ASK</span>
        {d.urgent && <span className="chip chip-urgent">URGENT</span>}
        <span className="why-line">{d.asker ?? d.from_label ?? "agent"} · {rel(d.opened_ts ?? d.created_ts ?? d.ts ?? Date.now())}</span>
      </div>
      <h3 className="ask-question">{d.title ?? d.question}</h3>
      {d.reason && <p className="ask-reason">{d.reason}</p>}
      {d.question && d.question !== d.title && <p className="ask-reason">{d.question}</p>}
      <div className="ask-actions">
        <button className="opt-btn" disabled={busy} onClick={() => void act("unblocked")}>Unblock</button>
        <button className="opt-btn opt-ghost" disabled={busy} onClick={() => void act("completed")}>Done</button>
      </div>
    </div>
  );
}

export function ForMeView({ openThread }: { openThread?: (taskId: string) => void }) {
  const tasks = useKb((s) => s.tasks);
  const decisions = useBridge((s) => s.decisions);
  const refresh = useKb((s) => s.refresh);
  const [proposed, setProposed] = useState<KbArtefact[] | null>(null);
  const [tick, setTick] = useState(0);

  const load = async () => {
    try {
      const r = await kbApi.artefacts({ type: "decision", status: "proposed" });
      setProposed(r.artefacts ?? []);
    } catch {
      setProposed([]);
    }
  };
  useEffect(() => { void load(); }, [tick]);

  const asked = useMemo(
    () => decisions.filter((d: any) => !d.resolved && (d.target === "human" || d.asker === "human" || !d.target)),
    [decisions],
  );

  const questions = useMemo(
    () => tasks.filter((t) => t.meta?.kind === "question" || (t.tags ?? []).includes("question")),
    [tasks],
  );

  const bump = () => { void refresh(); setTick((x) => x + 1); };

  const total = (proposed?.length ?? 0) + asked.length;

  return (
    <div className="disc-wrap">
      <div className="view-head">
        <h2>For Me</h2>
        <span className="muted-note">{total > 0 ? `${total} awaiting you` : "nothing needs you right now"}</span>
      </div>

      {proposed === null && <p className="empty">loading…</p>}
      {proposed !== null && proposed.length === 0 && asked.length === 0 && questions.length === 0 && (
        <p className="empty">Nothing needs you right now. Proposed decisions, agent asks and open questions land here.</p>
      )}

      {asked.map((d: any) => (
        <AskRow key={d.id} d={d} onDone={bump} />
      ))}

      {(proposed ?? []).map((d) => (
        <DecisionRow key={d.id} d={d} onDone={bump} />
      ))}

      {questions.length > 0 && (
        <section className="panel-section">
          <h2>Open question threads · {questions.length}</h2>
          <div className="disc-list">
            {questions.map((t) => (
              <div key={t.id} className="card forme-item forme-link" onClick={() => openThread?.(t.id)}>
                <div className="ask-chips">
                  <span className="chip chip-scope">QUESTION</span>
                  <span className="why-line">{t.owner ?? "—"} · updated {rel(t.updated_ts)}</span>
                </div>
                <h3 className="ask-question">{t.title}</h3>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
