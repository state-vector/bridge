import { useEffect, useMemo, useState } from "react";
import { useKb } from "../store/kb";
import { getConfig } from "../lib/config";
import { rel } from "../lib/views";


function BootstrapBlock({ label, secret, projectName }: { label: string; secret: string; projectName: string }) {
  const url = `${getConfig().url}/mcp`;
  const mcpJson = JSON.stringify(
    { "bridge-kb": { url, headers: { Authorization: `Bearer ${secret}` } } },
    null, 2,
  );
  const prompt = [
    `You are connected to Bridge — the knowledge layer for "${projectName}".`,
    `Your auth token identifies you as "${label}". Name your session on orient.`,
    `Start every session with the orient tool: it returns goals, open work, pending asks addressed to you, and project flags.`,
    `Search and read artefacts before assuming; record outcomes as artefacts; answer asks addressed to you.`,
  ].join(" ");
  const download = (name: string, body: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
    a.download = name;
    a.click();
  };
  return (
    <div className="connect-block">
      <div className="connect-row">
        <span>mcpServers JSON</span>
        <button className="opt-btn" onClick={() => void navigator.clipboard.writeText(mcpJson)}>copy</button>
      </div>
      <pre className="connect-pre">{mcpJson}</pre>
      <div className="connect-row">
        <span>Bootstrap prompt</span>
        <button className="opt-btn" onClick={() => void navigator.clipboard.writeText(prompt)}>copy</button>
      </div>
      <pre className="connect-pre">{prompt}</pre>
      <p className="muted-note">
        Also useful: <code className="inline" onClick={() => download(`${label}-auth-token.txt`, secret)} style={{ cursor: "pointer" }}>download auth token</code> (keep it secret).
      </p>
    </div>
  );
}

export function ConnectView() {
  const tokens = useKb((s) => s.tokens);
  const sessions = useKb((s) => s.sessions);
  const settings = useKb((s) => s.settings);
  const mint = useKb((s) => s.mint);
  const revoke = useKb((s) => s.revoke);
  const saveSettings = useKb((s) => s.saveSettings);

  const [label, setLabel] = useState("");
  const [tags, setTags] = useState("");
  const [secret, setSecret] = useState<{ label: string; secret: string } | null>(null);
  const [name, setName] = useState("");
  const [board, setBoard] = useState<any>({ mode: "none", kind: "", url: "", prompt: "" });
  const [bootstrapMd, setBootstrapMd] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    setName(settings.project_name ?? "");
    setBoard(settings.board ?? { mode: "none", kind: "", url: "", prompt: "" });
    setBootstrapMd(settings.bootstrap_md ?? "");
  }, [settings]);

  const doMint = async () => {
    try {
      const t = await mint(label.trim(), tags.split(",").map((s) => s.trim()).filter(Boolean));
      setSecret({ label: t.label, secret: t.secret });
      setLabel("");
      setTags("");
    } catch (e) {
      setMsg(`mint failed: ${(e as Error).message}`);
    }
  };

  const projectName = settings.project_name ?? name ?? "this project";
  const secretBlock = useMemo(
    () => (secret ? <BootstrapBlock label={secret.label} secret={secret.secret} projectName={projectName} /> : null),
    [secret, projectName],
  );

  return (
    <div className="connect-wrap">
      <div className="view-head">
        <h2>Connect agents</h2>
        <span className="muted-note">one auth token per agent client · sessions self-name</span>
      </div>

      <div className="card">
        <h2>Mint auth token</h2>
        <div className="row">
          <div><label>Agent label</label><input value={label} placeholder="opencode-ray" onChange={(e) => setLabel(e.target.value)} /></div>
          <div><label>Capability tags (comma-sep)</label><input value={tags} placeholder="datadog-access, deploy" onChange={(e) => setTags(e.target.value)} /></div>
        </div>
        <p><button className="opt-btn" disabled={!label.trim()} onClick={() => void doMint()}>Mint</button></p>
        {secretBlock}
        {msg && <p className="login-error">{msg}</p>}
        <table className="log-table">
          <thead><tr><th>agent</th><th>tags</th><th>created</th><th>last seen</th><th>state</th><th></th></tr></thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td>{t.label}</td>
                <td>{(t.tags ?? []).join(", ")}</td>
                <td>{rel(t.created_ts)}</td>
                <td>{t.last_seen_ts ? rel(t.last_seen_ts) : "never"}</td>
                <td>{t.revoked_ts ? <span className="login-error">revoked</span> : <span className="ok">active</span>}</td>
                <td>{!t.revoked_ts && <button className="opt-btn" onClick={() => void revoke(t.id)}>revoke</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h2>Sessions</h2>
        <table className="log-table">
          <thead><tr><th>agent</th><th>session</th><th>first seen</th><th>last seen</th></tr></thead>
          <tbody>
            {sessions.map((s, i) => (
              <tr key={i}><td>{s.label ?? s.token_id}</td><td>{s.name}</td><td>{rel(s.first_seen_ts)}</td><td>{rel(s.last_seen_ts)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Project flags</h2>
        <label>Project name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />
        <label>Board mode</label>
        <select value={board.mode} onChange={(e) => setBoard({ ...board, mode: e.target.value })}>
          <option value="none">none</option>
          <option value="builtin">builtin (bridge work orders)</option>
          <option value="external">external — our own board</option>
        </select>
        {board.mode === "external" && (
          <>
            <label>Board kind</label><input value={board.kind ?? ""} placeholder="github-projects" onChange={(e) => setBoard({ ...board, kind: e.target.value })} />
            <label>Board URL</label><input value={board.url ?? ""} onChange={(e) => setBoard({ ...board, url: e.target.value })} />
            <label>Board prompt for agents</label>
            <textarea rows={2} value={board.prompt ?? ""} placeholder="Move the task to In Progress when you start…" onChange={(e) => setBoard({ ...board, prompt: e.target.value })} />
          </>
        )}
        <label>Extra bootstrap markdown</label>
        <textarea rows={3} value={bootstrapMd} onChange={(e) => setBootstrapMd(e.target.value)} />
        <p><button className="opt-btn" onClick={async () => { await saveSettings({ project_name: name, board, bootstrap_md: bootstrapMd }); setMsg("saved"); setTimeout(() => setMsg(""), 2000); }}>Save flags</button> {msg && <span className="ok">{msg}</span>}</p>
        <p className="muted-note">Agents get these via MCP instructions on connect and inside orient. The entry prompt teaches discovery only — docs stay in artefacts.</p>
      </div>
    </div>
  );
}
