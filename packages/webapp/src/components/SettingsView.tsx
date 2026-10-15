import { useEffect, useState } from "react";
import { useKb } from "../store/kb";

const BOARD_MODES = [
  { key: "none", label: "None" },
  { key: "builtin", label: "Bridge work orders" },
  { key: "external", label: "External board" },
];

export function SettingsView() {
  const settings = useKb((s) => s.settings);
  const saveSettings = useKb((s) => s.saveSettings);

  const [draft, setDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");

  useEffect(() => {
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(settings)) {
      if (k === "board") {
        flat["board.mode"] = v?.mode ?? "none";
        if (v?.mode === "external") {
          flat["board.kind"] = v.kind ?? "";
          flat["board.url"] = v.url ?? "";
          flat["board.prompt"] = v.prompt ?? "";
        }
      } else {
        flat[k] = typeof v === "string" ? v : JSON.stringify(v);
      }
    }
    setDraft(flat);
  }, [settings]);

  const set = (k: string, v: string) => setDraft({ ...draft, [k]: v });

  const save = async () => {
    const out: Record<string, unknown> = {};
    const board: any = { mode: draft["board.mode"] ?? "none" };
    if (board.mode === "external") {
      board.kind = draft["board.kind"];
      board.url = draft["board.url"];
      board.prompt = draft["board.prompt"];
    }
    for (const [k, v] of Object.entries(draft)) {
      if (k.startsWith("board.")) continue;
      if (k === "project_name") out[k] = v;
      else if (k === "bootstrap_md") out[k] = v;
      else { try { out[k] = JSON.parse(v); } catch { out[k] = v; } }
    }
    out.board = board;
    await saveSettings(out);
    setMsg("saved");
    setTimeout(() => setMsg(""), 2000);
  };

  const boardMode = draft["board.mode"] ?? "none";
  const knownOrder = ["project_name", "board.mode", "board.kind", "board.url", "board.prompt", "bootstrap_md"];
  const extras = Object.entries(draft).filter(([k]) => !knownOrder.includes(k));

  return (
    <div className="settings-wrap">
      <div className="view-head">
        <h2>Settings</h2>
        <span className="muted-note">these reach agents in every briefing</span>
      </div>

      <div className="set-card">
        <div className="set-field">
          <label>Project name</label>
          <input value={draft.project_name ?? ""} placeholder="Superpositional" onChange={(e) => set("project_name", e.target.value)} />
        </div>

        <div className="set-field">
          <label>Board</label>
          <select value={boardMode} onChange={(e) => set("board.mode", e.target.value)}>
            {BOARD_MODES.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
          {boardMode === "external" && (
            <>
              <input value={draft["board.kind"] ?? ""} placeholder="kind — github-projects" onChange={(e) => set("board.kind", e.target.value)} />
              <input value={draft["board.url"] ?? ""} placeholder="Board URL" onChange={(e) => set("board.url", e.target.value)} />
              <textarea rows={2} value={draft["board.prompt"] ?? ""} placeholder="Prompt for agents working with this board…" onChange={(e) => set("board.prompt", e.target.value)} />
            </>
          )}
        </div>

        <div className="set-field">
          <label>Bootstrap markdown</label>
          <textarea rows={4} value={draft.bootstrap_md ?? ""} placeholder="Extra guidance appended to every agent briefing…" onChange={(e) => set("bootstrap_md", e.target.value)} />
        </div>

        {extras.length > 0 && (
          <div className="set-field">
            <label>Custom settings</label>
            {extras.map(([k, v]) => (
              <div key={k} className="set-row">
                <input className="set-key" value={k} readOnly />
                <input value={v} onChange={(e) => set(k, e.target.value)} />
                <button className="opt-btn set-del" onClick={() => { const d = { ...draft }; delete d[k]; setDraft(d); }}>×</button>
              </div>
            ))}
          </div>
        )}

        <button className="opt-btn" onClick={() => void save()}>Save</button>
        {msg && <span className="ok"> {msg}</span>}
      </div>

      <p className="muted-note set-footnote">
        These settings are compiled into every agent's MCP instructions and orient brief.
        The bootstrap prompt teaches discovery — the detail lives in artefacts.
      </p>
    </div>
  );
}
