import { useEffect, useState } from "react";
import snarkdown from "snarkdown";
import { kbApi } from "../server/kb";
import type { KbArtefact } from "../server/kb";
import { rel } from "../server/views";
import { useKb } from "../server/kbStore";
import { ActionRow, Btn, Chip, type ChipTone, TextInput } from "./index-kit";

/** Shared decision plane: framing, flood-grouping, the detail popover and
 *  the compact action row — used by For Me and by the ask band in Top. */

export const KIND_CHIP: Record<string, ChipTone> = { proposed: "needs", accepted: "done", rejected: "done" };

/** Verify-verdict decisions carry meta.decision_class + verdict + receipts —
 *  frame them as the choice they are: accept the verdict (closes the task) or
 *  reject it (bounces it back). Generic decisions keep the plain framing. */
export function decisionFrame(d: KbArtefact): { kind: "verify" | "generic"; verdict?: string; target?: string; receipts: [string, string][] } {
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
export function md(src: string): string {
  const html = snarkdown(src ?? "");
  return html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/ on\w+="[^"]*"/gi, "");
}

export interface HistoryEntry {
  seq: number;
  ts: number;
  actor: string;
  action: string;
  summary: string;
  data: Record<string, unknown>;
}


/** Ask options, two shapes (Ray, 2026-10-23):
 *  - binary + short → one line: [ APPROVE ] [ DENY ]
 *  - everything else → vertical list, text VISIBLE next to the key:
 *      [ A ] - Provision x
 *      [ B ] - Reword y
 *  Never letter-keys alone — an option without its text is not an option. */
export function AskOptions({ options, onPick, busy }: {
  options: string[]; onPick: (o: string) => void; busy?: boolean; compact?: boolean;
}) {
  const short = options.every((o) => o.length <= 34);
  if (options.length === 2 && short) {
    return (
      <ActionRow>
        {options.map((o) => (
          <Btn key={o} variant="accept" disabled={busy} onClick={() => onPick(o)}>{o.toUpperCase()}</Btn>
        ))}
      </ActionRow>
    );
  }
  return (
    <div className="ask-opt-list">
      {options.map((o, i) => (
        <div key={o} className={`ask-opt-row ${busy ? "disabled" : ""}`} onClick={() => !busy && onPick(o)}>
          <Btn size="sm" disabled={busy}>{String.fromCharCode(65 + i)}</Btn>
          <span className="ask-opt-text">{o}</span>
        </div>
      ))}
    </div>
  );
}


/** The readable kernel of an ask: first sentence, cut on a word boundary. */
export function askKernel(text: string | undefined, limit = 160): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const cut = t.slice(0, limit);
  const sentence = cut.match(/^[^.?!]*[.?!]/)?.[0];
  if (sentence && sentence.length > 24) return sentence.trim();
  return (cut.length < t.length ? cut.slice(0, cut.lastIndexOf(" ")).trimEnd() + "…" : cut);
}

export function Comment({ v }: { v: HistoryEntry }) {
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

export function useDecisionAct(d: KbArtefact, onDone: (id: string) => void) {
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

export function DecisionPopover({ d, onClose, onChanged }: { d: KbArtefact; onClose: () => void; onChanged: () => void }) {
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
    } catch (e) { console.warn("[bridge] comment reload:", (e as Error).message); }
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
              <Chip tone="urgent">{f.kind === "verify" ? "VERDICT" : "DECISION"}</Chip>
              <Chip tone={KIND_CHIP[d.status] ?? "needs"}>{d.status.toUpperCase()}</Chip>
              {f.verdict && <Chip tone={f.verdict === "bounce" ? "needs" : "done"}>{f.verdict.toUpperCase()}</Chip>}
              <span className="why-line">{d.id} · proposed {rel(d.created_ts)} · by {d.owner ?? "—"}</span>
              <Btn quiet className="forme-close" onClick={onClose}>✕</Btn>
            </div>
          );
        })()}
        {(() => {
          const f = decisionFrame(d);
          if (f.kind !== "verify") {
            const from = (d as any).request_from as string | undefined;
            return (
              <>
                <h2>{d.title}</h2>
                {from && <p className="ask-reason">request from: {from}</p>}
              </>
            );
          }
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
                    <Chip key={k} tone="scope" title={v}>{k}: {v.length > 40 ? `${v.slice(0, 40)}…` : v}</Chip>
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
          <TextInput
            value={comment}
            placeholder="Add a comment…"
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) void addComment(); }}
          />
          <Btn disabled={busy || !comment.trim()} onClick={() => void addComment()}>Comment</Btn>
        </div>

        {rejectOpen && (
          <div className="steer-box forme-reject">
            <TextInput
              autoFocus
              value={rejectReason}
              placeholder="Why reject? (required)"
              onChange={(e) => setRejectReason(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void act("rejected"); }}
            />
            <Btn variant="reject" disabled={busy || !rejectReason.trim()} onClick={() => void actWithNote("rejected")}>Confirm reject</Btn>
            <Btn quiet onClick={() => setRejectOpen(false)}>Cancel</Btn>
          </div>
        )}

        <ActionRow>
          <Btn variant="accept" disabled={busy || actBusy} onClick={() => void actWithNote("accepted")}>Accept</Btn>
          <Btn quiet disabled={busy || actBusy} onClick={() => setRejectOpen(true)}>Reject…</Btn>
        </ActionRow>
        {msg && <p className="ok">{msg}</p>}
      </div>
    </div>
  );
}

/** For Me flood fix (BR#1782): verify-verdict decisions group by TARGET TASK —
 *  one actionable card per task (latest verdict + collapsed identical rounds). */
export function groupDecisions(proposed: KbArtefact[]): { verdictCards: Array<{ latest: KbArtefact; prior: KbArtefact[] }>; generic: KbArtefact[] } {
  const verdicts = proposed.filter((d) => (d.meta as any)?.decision_class === "verify-verdict" && ((d.meta as any)?.task || (d.meta as any)?.verify_target));
  const generic = proposed.filter((d) => !verdicts.includes(d));
  const byTarget = new Map<string, KbArtefact[]>();
  for (const d of verdicts) {
    const key = String((d.meta as any).task ?? (d.meta as any).verify_target);
    const arr = byTarget.get(key) ?? [];
    arr.push(d);
    byTarget.set(key, arr);
  }
  const verdictCards: Array<{ latest: KbArtefact; prior: KbArtefact[] }> = [];
  for (const [, arr] of byTarget) {
    arr.sort((a, b) => b.created_ts - a.created_ts);
    verdictCards.push({ latest: arr[0], prior: arr.slice(1) });
  }
  verdictCards.sort((a, b) => b.latest.created_ts - a.latest.created_ts);
  return { verdictCards, generic };
}
