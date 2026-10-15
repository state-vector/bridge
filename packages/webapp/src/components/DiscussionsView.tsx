import { useEffect, useState } from "react";
import { kbApi, type KbArtefact } from "../lib/kb";
import { rel } from "../lib/views";

const TEMPLATE = (context: string) => `## Context\n${context}\n\n## Questions\n- \n\n## Contributions\n\n## Conclusions\n\n## Unresolved\n`;

export function DiscussionsView() {
  const [discussions, setDiscussions] = useState<KbArtefact[]>([]);
  const [open, setOpen] = useState<KbArtefact | null>(null);
  const [title, setTitle] = useState("");
  const [context, setContext] = useState("");
  const [contribution, setContribution] = useState("");
  const [msg, setMsg] = useState("");

  const load = async () => {
    try {
      const r = await kbApi.artefacts({ type: "discussion" });
      setDiscussions(r.artefacts ?? []);
    } catch { /* live hub required */ }
  };
  useEffect(() => { void load(); }, []);

  const start = async () => {
    try {
      await kbApi.create({ type: "discussion", title: title.trim(), body_md: TEMPLATE(context.trim()) });
      setTitle(""); setContext(""); setMsg("started"); setTimeout(() => setMsg(""), 1500);
      await load();
    } catch (e) { setMsg(`failed: ${(e as Error).message}`); }
  };

  const contribute = async (d: KbArtefact) => {
    if (!contribution.trim()) return;
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const body = `${d.body_md}\n### Contribution — rayh · ${stamp}\n${contribution.trim()}\n`;
    try {
      await kbApi.update(d.id, { body_md: body });
      setContribution("");
      await load();
      setOpen(d);
    } catch (e) { setMsg(`failed: ${(e as Error).message}`); }
  };

  const conclude = async (d: KbArtefact) => {
    try {
      await kbApi.transition(d.id, "concluded");
      setOpen(null);
      await load();
    } catch (e) { setMsg(`failed: ${(e as Error).message}`); }
  };

  return (
    <div className="disc-wrap">
      <div className="view-head">
        <h2>Discussions</h2>
        <span className="muted-note">agents + humans — exploration becomes artefacts, conclusions become decisions</span>
      </div>

      <div className="card">
        <h2>Start a discussion</h2>
        <input value={title} placeholder="Should ingestion use batching?" onChange={(e) => setTitle(e.target.value)} />
        <textarea rows={2} value={context} placeholder="Context — the problem, the trade-offs…" onChange={(e) => setContext(e.target.value)} />
        <p><button className="opt-btn" disabled={!title.trim()} onClick={() => void start()}>Start</button> {msg && <span className="ok">{msg}</span>}</p>
      </div>

      <div className="disc-list">
        {discussions.map((d) => (
          <div key={d.id} className={`card disc ${d.status === "concluded" ? "disc-done" : ""}`}>
            <div className="ask-chips">
              <span className={`chip ${d.status === "open" ? "chip-needs" : "chip-done"}`}>{d.status.toUpperCase()}</span>
              {d.board && <span className="chip chip-scope">{d.board.toUpperCase()}</span>}
              <span className="why-line">updated {rel(d.updated_ts)} · {d.id}</span>
            </div>
            <h3 className="ask-question">{d.title}</h3>
            {open?.id !== d.id && <p className="ask-reason">{(d.body_md ?? "").split("## Contributions")[0].replace(/#+/g, "").trim().slice(0, 140)}…</p>}
            {open?.id === d.id && (
              <>
                <pre className="know-body">{d.body_md}</pre>
                <textarea rows={2} value={contribution} placeholder="Your contribution — position, evidence, concern…" onChange={(e) => setContribution(e.target.value)} />
                <div className="ask-actions">
                  <button className="opt-btn" disabled={!contribution.trim()} onClick={() => void contribute(d)}>Contribute</button>
                  <button className="opt-btn" onClick={() => void conclude(d)}>Conclude</button>
                  <button className="opt-btn opt-ghost" onClick={() => setOpen(null)}>Close</button>
                </div>
              </>
            )}
            {open?.id !== d.id && (
              <button className="opt-btn opt-ghost" onClick={() => setOpen(d)}>Open discussion →</button>
            )}
          </div>
        ))}
        {discussions.length === 0 && <p className="empty">No discussions yet — questions worth keeping belong here, not in chat.</p>}
      </div>
    </div>
  );
}
