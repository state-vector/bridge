import { useEffect, useMemo, useState } from "react";
import { useKb } from "../store/kb";
import { useBridge } from "../lib/store";
import { kbApi, type KbArtefact } from "../lib/kb";
import { rel } from "../lib/views";

/** For Me — the human's inbox. First tab. Surfaces everything awaiting a
 *  human decision or attention:
 *   - proposed KB decisions (BR#621-class) — accept/reject inline; the
 *     transition POST route acts as actor "web" which satisfies the
 *     human-authoritative acceptance gate
 *   - open agent asks addressed to the human (hub plane)
 *   - open question threads (link into Discussions)
 */

const KIND_CHIP: Record<string, string> = { proposed: "chip-needs", accepted: "chip-done", rejected: "chip-done" };

function DecisionRow({ d, onDone }: { d: KbArtefact; onDone: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const act = async (to: "accepted" | "rejected") => {
    setBusy(true);
    try {
      await kbApi.transition(d.id, to, { note: to === "accepted" ? "accepted by human (For Me)" : "rejected by human (For Me)" });
      setMsg(to === "accepted" ? "accepted" : "rejected");
      onDone(d.id);
    } catch (e) {
      setMsg(`failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      setTimeout(() => setMsg(""), 2500);
    }
  };

  return (
    <div className="card ask-urgent forme-item">
      <div className="ask-chips">
        <span className="chip chip-urgent">DECISION</span>
        <span className={`chip ${KIND_CHIP[d.status] ?? "chip-needs"}`}>{d.status.toUpperCase()}</span>
        <span className="why-line">{d.id} · proposed {rel(d.created_ts)}</span>
      </div>
      <h3 className="ask-question" onClick={() => setOpen((o) => !o)}>{d.title}</h3>
      {open && <pre className="know-body">{d.body_md}</pre>}
      <div className="ask-actions">
        <button className="opt-btn" disabled={busy} onClick={() => void act("accepted")}>Accept</button>
        <button className="opt-btn opt-ghost" disabled={busy} onClick={() => void act("rejected")}>Reject</button>
        <button className="opt-btn opt-ghost" onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Read"}</button>
      </div>
      {msg && <p className="ok">{msg}</p>}
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
        <span className="why-line">{d.asker ?? d.from_label ?? "agent"} · {rel(d.created_ts ?? d.ts ?? Date.now())}</span>
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
