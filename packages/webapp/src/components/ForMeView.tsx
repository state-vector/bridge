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

/** Verify-verdict decisions carry meta.decision_class + verdict + receipts —
 *  frame them as the choice they are: accept the verdict (closes the task) or
 *  reject it (bounces it back). Generic decisions keep the plain framing. */
function decisionFrame(d: KbArtefact): { kind: "verify" | "generic"; verdict?: string; target?: string; receipts: [string, string][] } {
  const m = (d.meta ?? {}) as Record<string, unknown>;
  if (m.decision_class === "verify-verdict") {
    const keys = ["pr", "pr_state", "pr_slice2", "pr_slice2_state", "issue_state", "issue_1976", "issue_1977", "merge_commit", "github", "ci_soak_run", "residue"];
    const receipts: [string, string][] = [];
    for (const k of keys) if (m[k] != null && String(m[k]).trim()) receipts.push([k.replace(/_/g, " "), String(m[k])]);
    return {
      kind: "verify",
      verdict: String(m.verdict ?? "").toLowerCase() === "bounce" ? "bounce" : String(m.verified === "true" ? "verified" : m.verdict ?? "verify"),
      target: String(m.task ?? m.verify_target ?? ""),
      receipts,
    };
  }
  return { kind: "generic", receipts: [] };
}

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
  const tasks = useKb((s) => s.tasks) as any[];
  const { busy: actBusy, act } = useDecisionAct(d, onChanged);
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

  const actWithNote = async (to: "accepted" | "rejected") => {
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
        {(() => {
          const f = decisionFrame(d);
          return (
            <div className="ask-chips">
              <span className="chip chip-urgent">{f.kind === "verify" ? "VERDICT" : "DECISION"}</span>
              <span className={`chip ${KIND_CHIP[d.status] ?? "chip-needs"}`}>{d.status.toUpperCase()}</span>
              {f.verdict && <span className={`chip ${f.verdict === "bounce" ? "chip-needs" : "chip-done"}`}>{f.verdict.toUpperCase()}</span>}
              <span className="why-line">{d.id} · proposed {rel(d.created_ts)} · by {d.owner ?? "—"}</span>
              <button className="opt-btn opt-ghost forme-close" onClick={onClose}>✕</button>
            </div>
          );
        })()}
        {(() => {
          const f = decisionFrame(d);
          if (f.kind !== "verify") return <h2>{d.title}</h2>;
          const st = tasks.find((t) => t.id === f.target)?.status;
          const applied = f.verdict === "bounce" ? st === "in_progress" : st === "done";
          const frame = applied
            ? {
                h: `Ratify the verdict on ${f.target ?? "task"}?`,
                p: `The verifier already applied it — the task is ${st ?? "in its new state"}. Accepting records your confirmation; nothing else changes.`,
              }
            : f.verdict === "bounce"
            ? {
                h: `Bounce ${f.target ?? "task"} back to work?`,
                p: "A fresh-session verifier found the handoff receipts void. Accepting bounces the task to in_progress with the findings; rejecting leaves it as-is.",
              }
            : {
                h: `Accept verification of ${f.target ?? "task"}?`,
                p: "A fresh-session verifier confirmed the receipts (PR merged, issue closed, on main). Accepting closes the task as done. Rejecting leaves it as-is.",
              };
          return (
            <>
              <h2>{frame.h}</h2>
              <p className="ask-reason">{frame.p}</p>
              {f.receipts.length > 0 && (
                <div className="ask-chips">
                  {f.receipts.map(([k, v]) => (
                    <span key={k} className="chip chip-scope" title={v}>{k}: {v.length > 40 ? `${v.slice(0, 40)}…` : v}</span>
                  ))}
                </div>
              )}
              <div className="md-body forme-body" dangerouslySetInnerHTML={{ __html: md(d.body_md ?? "") }} />
              <details className="forme-details"><summary>raw decision record</summary>
                <pre className="know-body">{d.title}</pre>
              </details>
            </>
          );
        })()}

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
            <button className="opt-btn act-reject" disabled={busy || !rejectReason.trim()} onClick={() => void actWithNote("rejected")}>Confirm reject</button>
            <button className="opt-btn opt-ghost" onClick={() => setRejectOpen(false)}>Cancel</button>
          </div>
        )}

        <div className="ask-actions">
          <button className="opt-btn act-accept" disabled={busy || actBusy} onClick={() => void actWithNote("accepted")}>Accept</button>
          <button className="opt-btn opt-ghost" disabled={busy || actBusy} onClick={() => setRejectOpen(true)}>Reject…</button>
        </div>
        {msg && <p className="ok">{msg}</p>}
      </div>
    </div>
  );
}

function useDecisionAct(d: KbArtefact, onDone: (id: string) => void) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const act = async (to: "accepted" | "rejected") => {
    setBusy(true);
    setErr("");
    try {
      await kbApi.transition(d.id, to, { note: to === "accepted" ? "accepted by human (For Me)" : "rejected by human (For Me)" });
      onDone(d.id);
      return true;
    } catch (e) {
      setErr(`failed: ${(e as Error).message}`);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, err, act };
}

function DecisionRow({ d, onDone }: { d: KbArtefact; onDone: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const { busy, err, act } = useDecisionAct(d, onDone);
  return (
    <div className="card ask-urgent forme-item">
      {(() => {
        const f = decisionFrame(d);
        return (
          <div className="ask-chips">
            <span className="chip chip-urgent">{f.kind === "verify" ? "VERDICT" : "DECISION"}</span>
            {f.verdict && <span className={`chip ${f.verdict === "bounce" ? "chip-needs" : "chip-done"}`}>{f.verdict.toUpperCase()}</span>}
            {f.target && <span className="chip chip-scope">{f.target}</span>}
            <span className="why-line">{d.id} · proposed {rel(d.created_ts)}</span>
          </div>
        );
      })()}
      <h3 className="ask-question">
        {(() => {
          const f = decisionFrame(d);
          return f.kind === "verify"
            ? `${f.verdict === "bounce" ? "Bounce" : "Accept verification of"} ${f.target ?? "task"}`
            : d.title;
        })()}
      </h3>
      <div className="ask-actions">
        {(() => {
          const f = decisionFrame(d);
          const acceptLabel = f.kind === "verify" && f.verdict === "bounce" ? "Bounce it" : "Accept";
          return (
            <>
              <button className="opt-btn act-accept" disabled={busy} onClick={() => void act("accepted")}>{acceptLabel}</button>
              <button className="opt-btn act-reject" disabled={busy} onClick={() => void act("rejected")}>Reject</button>
              <button className="opt-btn opt-ghost" onClick={() => setOpen(true)}>Details / comment…</button>
            </>
          );
        })()}
        {err && <span className="gw-err">{err}</span>}
      </div>
      {open && <DecisionPopover d={d} onClose={() => setOpen(false)} onChanged={() => onDone(d.id)} />}
    </div>
  );
}

/** One card per TARGET TASK: latest verdict is actionable, identical prior
 *  rounds collapse into a muted line (the flood fix — round 9 of "unchanged"
 *  bounce verdicts is loop telemetry, not 9 separate human decisions). */
function VerdictGroupRow({ latest, prior, onDone }: { latest: KbArtefact; prior: KbArtefact[]; onDone: (id: string) => void }) {
  const [showPrior, setShowPrior] = useState(false);
  const m = (latest.meta ?? {}) as Record<string, unknown>;
  const target = String(m.task ?? m.verify_target ?? "");
  const verdict = String(m.verdict ?? "").toLowerCase() === "bounce" ? "bounce" : "verified";
  return (
    <div className="card ask-urgent forme-item">
      <div className="ask-chips">
        <span className="chip chip-urgent">VERDICT</span>
        <span className={`chip ${verdict === "bounce" ? "chip-needs" : "chip-done"}`}>{verdict.toUpperCase()}</span>
        <span className="chip chip-scope">{target}</span>
        <span className="why-line">{latest.id} · proposed {rel(latest.created_ts)}</span>
      </div>
      <h3 className="ask-question" onClick={() => void 0}>
        {(verdict === "bounce" ? `Bounce ${target}` : `Accept verification of ${target}`).slice(0, 110)}
      </h3>
      {prior.length > 0 && (
        <p className="why-line" style={{ margin: "2px 0" }}>
          <button className="opt-btn" style={{ fontSize: "10.5px", padding: "1px 8px" }} onClick={() => setShowPrior(!showPrior)}>
            {showPrior ? "▾" : "▸"} {prior.length} identical prior round{prior.length > 1 ? "s" : ""} collapsed
          </button>
        </p>
      )}
      {showPrior && prior.map((d) => (
        <p key={d.id} className="why-line" style={{ margin: "1px 0 1px 12px" }}>
          {d.id} · {rel(d.created_ts)} · {String((d.meta as any)?.verdict ?? "").toUpperCase()} — {(d.title ?? "").slice(0, 80)}
        </p>
      ))}
      <VerdictActions d={latest} onDone={onDone} />
    </div>
  );
}

function VerdictActions({ d, onDone }: { d: KbArtefact; onDone: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const { busy, err, act } = useDecisionAct(d, onDone);
  const verdict = String((d.meta as any)?.verdict ?? "").toLowerCase() === "bounce";
  return (
    <>
      <div className="ask-actions">
        <button className="opt-btn act-accept" disabled={busy} onClick={() => void act("accepted")}>{verdict ? "Bounce it" : "Accept"}</button>
        <button className="opt-btn act-reject" disabled={busy} onClick={() => void act("rejected")}>Reject</button>
        <button className="opt-btn opt-ghost" onClick={() => setOpen(true)}>Details / comment…</button>
        {err && <span className="gw-err">{err}</span>}
      </div>
      {open && <DecisionPopover d={d} onClose={() => setOpen(false)} onChanged={() => onDone(d.id)} />}
    </>
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

  // For Me flood fix (BR#1782): verify-verdict decisions group by TARGET TASK —
  // one card per task (latest verdict + collapsed identical-round history),
  // not one card per verdict round. Generic decisions stay individual.
  const grouped = useMemo(() => {
    const list = proposed ?? [];
    const verdicts = list.filter((d) => (d.meta as any)?.decision_class === "verify-verdict" && ((d.meta as any)?.task || (d.meta as any)?.verify_target));
    const generic = list.filter((d) => !verdicts.includes(d));
    const byTarget = new Map<string, KbArtefact[]>();
    for (const d of verdicts) {
      const key = String((d.meta as any).task ?? (d.meta as any).verify_target);
      const arr = byTarget.get(key) ?? [];
      arr.push(d);
      byTarget.set(key, arr);
    }
    // newest proposed decision per target = the actionable card; the rest collapse
    const verdictCards: Array<{ latest: KbArtefact; prior: KbArtefact[] }> = [];
    for (const [, arr] of byTarget) {
      arr.sort((a, b) => b.created_ts - a.created_ts);
      verdictCards.push({ latest: arr[0], prior: arr.slice(1) });
    }
    verdictCards.sort((a, b) => b.latest.created_ts - a.latest.created_ts);
    return { verdictCards, generic };
  }, [proposed]);

  const total = grouped.verdictCards.length + grouped.generic.length + asked.length;

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

      {grouped.verdictCards.map(({ latest, prior }) => (
        <VerdictGroupRow key={latest.id} latest={latest} prior={prior} onDone={bump} />
      ))}

      {grouped.generic.map((d) => (
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
