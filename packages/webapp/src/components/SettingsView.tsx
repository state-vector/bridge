import { useEffect, useState } from "react";
import { useKb } from "../store/kb";

export function SettingsView() {
  const settings = useKb((s) => s.settings);
  const saveSettings = useKb((s) => s.saveSettings);

  const [name, setName] = useState("");
  const [board, setBoard] = useState<any>({ mode: "none", kind: "", url: "", prompt: "" });
  const [bootstrapMd, setBootstrapMd] = useState("");
  const [extra, setExtra] = useState<Array<[string, string]>>([]);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    setName(settings.project_name ?? "");
    setBoard(settings.board ?? { mode: "none", kind: "", url: "", prompt: "" });
    setBootstrapMd(settings.bootstrap_md ?? "");
    const known = new Set(["project_name", "board", "bootstrap_md"]);
    setExtra(Object.entries(settings).filter(([k]) => !known.has(k)).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  }, [settings]);

  const addExtra = () => setExtra([...extra, [`setting_${extra.length + 1}`, ""]]);
  const removeExtra = (k: string) => setExtra(extra.filter(([key]) => key !== k));
  const setExtraValue = (k: string, v: string) => setExtra(extra.map(([key, val]) => [key, key === k ? v : val] as [string, string]));

  const save = async () => {
    const typed: Record<string, unknown> = { project_name: name, board, bootstrap_md: bootstrapMd };
    for (const [k, v] of extra) {
      try { typed[k] = JSON.parse(v); } catch { typed[k] = v; }
    }
    await saveSettings(typed);
    setMsg("saved");
    setTimeout(() => setMsg(""), 2000);
  };

  return (
    <div className="settings-wrap">
      <div className="view-head">
        <h2>Settings</h2>
        <span className="muted-note">compiled into agent briefings — entry prompt teaches discovery, detail stays in artefacts</span>
      </div>
      <div className="card">
        <label>Project name</label>
        <input value={name} placeholder="Superpositional" onChange={(e) => setName(e.target.value)} />
        <label>Board</label>
        <div className="row">
          <select value={board.mode} onChange={(e) => setBoard({ ...board, mode: e.target.value })}>
            <option value="none">none</option>
            <option value="builtin">builtin</option>
            <option value="external">external — our own board</option>
          </select>
          {board.mode === "external" && <input value={board.kind ?? ""} placeholder="kind (github-projects)" onChange={(e) => setBoard({ ...board, kind: e.target.value })} />}
        </div>
        {board.mode === "external" && (
          <>
            <label>Board URL</label><input value={board.url ?? ""} onChange={(e) => setBoard({ ...board, url: e.target.value })} />
            <label>Board prompt for agents</label>
            <textarea rows={2} value={board.prompt ?? ""} placeholder="Move the task to In Progress when you start…" onChange={(e) => setBoard({ ...board, prompt: e.target.value })} />
          </>
        )}
        <label>Extra bootstrap markdown</label>
        <textarea rows={3} value={bootstrapMd} onChange={(e) => setBootstrapMd(e.target.value)} />

        <label>More settings (list — key / value)</label>
        <table className="log-table">
          <tbody>
            {extra.map(([k, v]) => (
              <tr key={k}>
                <td style={{ width: "40%" }}><input value={k} onChange={(e) => setExtra(extra.map(([key, val]) => [key === k ? e.target.value : key, val] as [string, string]))} /></td>
                <td><input value={String(v)} onChange={(e) => setExtraValue(k, e.target.value)} /></td>
                <td style={{ width: 40 }}><button className="opt-btn" onClick={() => removeExtra(k)}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p><button className="opt-btn" onClick={addExtra}>+ add setting</button></p>
        <p><button className="opt-btn" onClick={() => void save()}>Save settings</button> {msg && <span className="ok">{msg}</span>}</p>
      </div>
    </div>
  );
}
