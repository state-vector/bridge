import { useState } from "react";
import { useKb } from "../store/kb";
import { rel } from "../lib/views";
import { kbApi } from "../lib/kb";

const TYPES = ["steering", "goal", "rfc", "decision", "discussion", "research", "task", "progress", "agent"];

export function KnowledgeView() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any[] | null>(null);
  const [selected, setSelected] = useState<any | null>(null);
  const [related, setRelated] = useState<any[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [createType, setCreateType] = useState("steering");
  const [msg, setMsg] = useState("");

  const doSearch = async () => {
    if (!q.trim()) return;
    try {
      const r = await kbApi.search(q.trim());
      setResults(r.artefacts ?? []);
    } catch {
      setMsg("search needs a live hub");
    }
  };
  const open = async (id: string) => {
    try {
      const a = await kbApi.artefact(id);
      setSelected(a as any);
      const r = await kbApi.related(id);
      setRelated(r.artefacts ?? []);
    } catch (e) {
      setSelected({ id, title: "load failed", body_md: String(e) });
    }
  };
  const create = async () => {
    try {
      await kbApi.create({ type: createType, title: title.trim(), body_md: body });
      setTitle(""); setBody(""); setMsg("created");
      setTimeout(() => setMsg(""), 1500);
      await useKb.getState().refresh();
    } catch (e) {
      setMsg(`failed: ${(e as Error).message}`);
    }
  };

  return (
    <div className="know-wrap">
      <div className="view-head">
        <h2>Knowledge</h2>
        <span className="muted-note">hybrid: keyword + semantic</span>
      </div>
      <div className="know-search">
        <input
          value={q}
          placeholder="Ask in plain words — “who owns ingestion latency?”"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void doSearch()}
        />
        <button className="opt-btn" onClick={() => void doSearch()}>Search</button>
      </div>

      {results !== null && (
        <div className="know-results">
          {results.map((a: any) => (
            <button key={a.id} className="know-hit" onClick={() => void open(a.id)}>
              <span className="chip chip-scope">{a.type}</span> <b>{a.title}</b>
              <span className="muted-note"> {a.id} · {a.status}{a._via ? ` · ${a._via.join("+")}` : ""}</span>
            </button>
          ))}
          {results.length === 0 && <p className="empty">No matches — try fewer words or different phrasing.</p>}
        </div>
      )}

      {selected && (
        <div className="card know-detail">
          <div className="detail-head">
            <div className="ask-chips"><span className="chip chip-scope">{selected.type}</span><span className="chip">{selected.status}</span><span className="why-line">{selected.id} · {rel(selected.updated_ts)}</span></div>
            <button className="icon-btn" onClick={() => { setSelected(null); setRelated([]); }}>✕</button>
          </div>
          <h3 className="detail-question">{selected.title}</h3>
          <pre className="know-body">{selected.body_md}</pre>
          {related.length > 0 && (
            <div>
              <label>Related</label>
              {related.map((r: any) => (
                <button key={r.id} className="opt-btn know-rel" onClick={() => void open(r.id)}>{r.type}: {r.title}</button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h2>Create artefact</h2>
        <div className="row">
          <select value={createType} onChange={(e) => setCreateType(e.target.value)}>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input value={title} placeholder="Title" onChange={(e) => setTitle(e.target.value)} />
        </div>
        <textarea rows={4} value={body} placeholder="Markdown body — context, criteria, constraints…" onChange={(e) => setBody(e.target.value)} />
        <p><button className="opt-btn" disabled={!title.trim()} onClick={() => void create()}>Create</button> {msg && <span className="ok">{msg}</span>}</p>
      </div>
    </div>
  );
}
