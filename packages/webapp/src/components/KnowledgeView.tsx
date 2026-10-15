import { useEffect, useState } from "react";
import { kbApi } from "../lib/kb";
import type { KbArtefact, KbVersion } from "../lib/kb";
import { rel } from "../lib/views";

const GROUPS = ["steering", "goal", "rfc", "decision", "research", "discussion", "task", "progress", "agent"];
const GROUP_LABEL: Record<string, string> = {
  steering: "Steering", goal: "Goals", rfc: "RFCs", decision: "Decisions",
  research: "Research", discussion: "Discussions", task: "Tasks", progress: "Progress", agent: "Agents",
};

const STATUS_TONE: Record<string, string> = {
  active: "ok", accepted: "ok", done: "ok", implemented: "ok", published: "ok", achieved: "ok",
  draft: "muted", proposed: "amber", open: "amber", todo: "muted", in_progress: "amber", logged: "muted",
  blocked: "err", rejected: "err", dropped: "err", superseded: "err", concluded: "muted",
};

function StatusChip({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? "muted";
  return <span className={`st-chip st-${tone}`}>{status.replace(/_/g, " ")}</span>;
}

export function KnowledgeView() {
  const [all, setAll] = useState<any[] | null>(null);
  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<any[] | null>(null);
  const [selected, setSelected] = useState<(KbArtefact & { relations?: any[] }) | null>(null);
  const [related, setRelated] = useState<any[]>([]);
  const [versions, setVersions] = useState<KbVersion[]>([]);
  const [createType, setCreateType] = useState("steering");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [msg, setMsg] = useState("");

  const loadAll = async () => {
    try { setAll((await kbApi.artefacts({ limit: 200 })).artefacts ?? []); } catch { setAll([]); }
  };
  useEffect(() => { void loadAll(); }, []);

  const doSearch = async () => {
    if (!q.trim()) { setSearching(false); setResults(null); return; }
    setSearching(true);
    try { setResults((await kbApi.search(q.trim())).artefacts ?? []); } catch { setMsg("search needs a live hub"); }
  };

  const open = async (id: string) => {
    try {
      setSelected(await kbApi.artefact(id));
      setRelated((await kbApi.related(id)).artefacts ?? []);
    } catch { setSelected(null); }
  };

  const create = async () => {
    try {
      await kbApi.create({ type: createType, title: title.trim(), body_md: body });
      setTitle(""); setBody(""); setMsg("created"); setTimeout(() => setMsg(""), 1500);
      await loadAll();
    } catch (e) { setMsg((e as Error).message); }
  };

  const rows = searching ? (results ?? []) : (all ?? []);

  return (
    <div className="know-wrap">
      {selected && (
        <>
          <div className="panel-backdrop" onClick={() => { setSelected(null); setVersions([]); }} />
          <aside className="detail-panel">
            <header className="detail-head">
              <div className="ask-chips">
                <span className="chip chip-scope">{selected.type}</span>
                <span className="chip">{selected.status}</span>
              </div>
              <button className="icon-btn" onClick={() => { setSelected(null); setVersions([]); }}>✕</button>
            </header>
            <h2 className="detail-question">{selected.title}</h2>
            <pre className="know-body">{selected.body_md || "—"}</pre>
            {(selected.tags ?? []).length > 0 && (
              <div className="task-tags">{(selected.tags ?? []).map((t: string) => <span key={t} className="chip chip-scope">{t}</span>)}</div>
            )}
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
            <div className="detail-block">
              <label>History</label>
              <div className="version-history">
                {versions.length === 0 && <span className="muted-note">no versions yet</span>}
                {versions.map((v) => (
                  <div key={v.seq} className="progress-line">
                    <span className={`chip chip-kind ${v.action === "create" ? "kind-agent" : "kind-system"}`}>{v.action}</span>
                    <span className="progress-note">{v.summary}</span>
                    <span className="step-ts">{v.actor} · {rel(v.ts)}</span>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </>
      )}
      <div className="view-head">
        <h2>Knowledge</h2>
        <span className="muted-note">{searching ? `search: "${q}"` : `${(all ?? []).length} artefacts`}</span>
      </div>

      <div className="know-search">
        <input value={q} placeholder="Search — plain words work" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void doSearch()} />
        <button className="opt-btn" onClick={() => void doSearch()}>{searching ? "✕ clear" : "Search"}</button>
      </div>

      {rows.length > 0 && (
        <div className="know-list">
          {(!searching ? GROUPS : ["*"]).map((g) => {
            const items = g === "*" ? rows : rows.filter((a: any) => a.type === g);
            if (items.length === 0) return null;
            return (
              <div key={g} className="know-group">
                {!searching && <div className="know-group-head">{GROUP_LABEL[g]}<span>{items.length}</span></div>}
                {items.map((a: any) => (
                  <button key={a.id} className="know-row" onClick={() => void open(a.id)}>
                    <StatusChip status={a.status} />
                    <span className="know-row-title">{a.title}</span>
                    <span className="know-row-meta">{a.id} · {rel(a.updated_ts)}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
      {rows.length === 0 && <p className="empty">{searching ? "No matches — rephrase or clear." : "Nothing yet."}</p>}

      {selected && (
        <div className="know-detail-card">
          <div className="detail-head">
            <div className="ask-chips">
              <span className="chip chip-scope">{selected.type}</span>
              <StatusChip status={selected.status} />
              <span className="why-line">{selected.id} · updated {rel(selected.updated_ts)}</span>
            </div>
            <button className="icon-btn" onClick={() => { setSelected(null); setRelated([]); }}>✕</button>
          </div>
          <h3 className="detail-question">{selected.title}</h3>
          <pre className="know-body">{selected.body_md || "—"}</pre>
          {(selected.tags ?? []).length > 0 && (
            <div className="task-tags">{(selected.tags ?? []).map((t: string) => <span key={t} className="chip chip-scope">{t}</span>)}</div>
          )}
          {related.length > 0 && (
            <div className="know-related">
              <label>Related</label>
              {related.map((r: any) => (
                <button key={r.id} className="know-row know-rel-row" onClick={() => void open(r.id)}>
                  <span className="chip chip-scope">{r.type}</span>
                  <span className="know-row-title">{r.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="settings-card">
        <h2>New artefact</h2>
        <div className="set-row">
          <select value={createType} onChange={(e) => setCreateType(e.target.value)}>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input value={title} placeholder="Title" onChange={(e) => setTitle(e.target.value)} />
        </div>
        <textarea rows={4} value={body} placeholder="Markdown body…" onChange={(e) => setBody(e.target.value)} />
        <button className="opt-btn" disabled={!title.trim()} onClick={() => void create()}>Create</button>
        {msg && <span className={msg === "created" ? "ok" : "login-error"}> {msg}</span>}
      </div>
    </div>
  );
}

const TYPES = ["steering", "goal", "rfc", "decision", "discussion", "research", "task", "progress", "agent"];
