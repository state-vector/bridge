import { useEffect, useMemo, useState } from "react";
import { useKb } from "../store/kb";
import { getConfig } from "../lib/config";
import { rel } from "../lib/views";

function Copyable({ label, body }: { label: string; body: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="connect-block">
      <div className="connect-row">
        <span>{label}</span>
        <button className="opt-btn" onClick={async () => { await navigator.clipboard.writeText(body); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
          {copied ? "copied ✓" : "copy"}
        </button>
      </div>
      <pre className="connect-pre">{body}</pre>
    </div>
  );
}

/** Agent setup: bootstrap prompt + mcpServers JSON — always visible, token slotted in after mint. */
function AgentSetup({ label, secret, projectName }: { label: string | null; secret: string | null; projectName: string }) {
  const url = `${getConfig().url}/mcp`;
  const [instructions, setInstructions] = useState("");
  const tokenLabel = label ?? "<agent-label>";
  const token = secret ?? "<auth-token>";

  useEffect(() => {
    let on = true;
    void (async () => {
      try {
        const r = await fetch(`${getConfig().url}/api/kb/bootstrap`, { credentials: "include" });
        if (r.ok && on) setInstructions((await r.json()).instructions ?? "");
      } catch { /* offline */ }
    })();
    return () => { on = false; };
  }, [projectName]);

  const mcpJson = JSON.stringify(
    { "bridge-kb": { url, headers: { Authorization: `Bearer ${token}` } } },
    null, 2,
  );
  const prompt = [
    instructions || `You are connected to Bridge — the work orchestration layer for "${projectName}".`,
    `Your auth token identifies you as "${tokenLabel}". Name your session on orient (session: "<unique-name>").`,
  ].join(" ");

  return (
    <div className="card">
      <h2>Agent setup</h2>
      <p className="muted-note">
        Wire your agent's MCP config, prepend the bootstrap prompt. {secret ? "Auth token below is shown once — store it." : "Mint a token above to get a real one slotted in."}
      </p>
      <Copyable label="Bootstrap prompt" body={prompt} />
      <Copyable label="mcpServers JSON" body={mcpJson} />

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
  const [transport, setTransport] = useState("mcp");
  const [secret, setSecret] = useState<{ label: string; secret: string } | null>(null);
  const [name, setName] = useState("");
  const [board, setBoard] = useState<any>({ mode: "none", kind: "", url: "", prompt: "" });
  const [bootstrapMd, setBootstrapMd] = useState("");
  const [msg, setMsg] = useState("");
  const [extra, setExtra] = useState<Array<[string, string]>>([]);

  useEffect(() => {
    setName(settings.project_name ?? "");
    setBoard(settings.board ?? { mode: "none", kind: "", url: "", prompt: "" });
    setBootstrapMd(settings.bootstrap_md ?? "");
    const known = new Set(["project_name", "board", "bootstrap_md"]);
    setExtra(Object.entries(settings).filter(([k]) => !known.has(k)).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  }, [settings]);
  const addExtra = () => setExtra([...extra, [`setting_${extra.length + 1}`, ""]]);
  const removeExtra = (k: string) => setExtra(extra.filter(([key]) => key !== k));
  const renameExtra = (k: string, nk: string) => setExtra(extra.map(([key, v]) => [key === k ? nk : key, v] as [string, string]));
  const setExtraValue = (k: string, v: string) => setExtra(extra.map(([key, val]) => [key === k ? k : key, key === k ? v : val] as [string, string]));

  const projectName = name || settings.project_name || "Superpositional";
  const agentSetup = useMemo(
    () => <AgentSetup label={secret?.label ?? null} secret={secret?.secret ?? null} projectName={projectName} />,
    [secret, projectName],
  );

  const doMint = async () => {
    try {
      const t = await mint(label.trim(), tags.split(",").map((x) => x.trim()).filter(Boolean), transport);
      setSecret({ label: t.label, secret: t.secret });
      setLabel("");
      setTags("");
    } catch (e) {
      setMsg(`mint failed: ${(e as Error).message}`);
    }
  };

  return (
    <div className="connect-wrap">
      <div className="view-head">
        <h2>Connect agents</h2>
        <span className="muted-note">one auth token per agent client · sessions self-name</span>
      </div>

      {agentSetup}

      <div className="card">
        <h2>Mint auth token</h2>
        <div className="row">
          <div><label>Agent label</label><input value={label} placeholder="opencode-ray" onChange={(e) => setLabel(e.target.value)} /></div>
          <div><label>Capability tags (comma-sep)</label><input value={tags} placeholder="datadog-access, deploy" onChange={(e) => setTags(e.target.value)} /></div>
        </div>
        <label>Transport</label>
        <select value={transport} onChange={(e) => setTransport(e.target.value)}>
          <option value="mcp">mcp</option>
          <option value="a2a">a2a</option>
          <option value="acp-proxy">acp-proxy</option>
          <option value="board">board</option>
        </select>
        <p><button className="opt-btn" disabled={!label.trim()} onClick={() => void doMint()}>Mint</button></p>
        {msg && <p className="login-error">{msg}</p>}
        <table className="log-table">
          <thead><tr><th>agent</th><th>tags</th><th>transport</th><th>created</th><th>last seen</th><th>state</th><th></th></tr></thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td>{t.label}</td>
                <td>{(t.tags ?? []).join(", ")}</td>
                <td>{t.transport ?? "mcp"}</td>
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
        <h2>Settings</h2>
        <label>Project name</label>
        <input value={name} placeholder="Superpositional" onChange={(e) => setName(e.target.value)} />
        <label>Board</label>
        <div className="row">
          <select value={board.mode} onChange={(e) => setBoard({ ...board, mode: e.target.value })}>
            <option value="none">none</option>
            <option value="builtin">builtin</option>
            <option value="external">external</option>
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
                <td style={{ width: "40%" }}><input value={k} onChange={(e) => renameExtra(k, e.target.value)} /></td>
                <td><input value={String(v)} onChange={(e) => setExtraValue(k, e.target.value)} /></td>
                <td style={{ width: 40 }}><button className="opt-btn" onClick={() => removeExtra(k)}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p><button className="opt-btn" onClick={addExtra}>+ add setting</button></p>
        <p><button className="opt-btn" onClick={async () => { await saveSettings({ project_name: name, board, bootstrap_md: bootstrapMd, ...Object.fromEntries(extra) }); setMsg("saved"); setTimeout(() => setMsg(""), 2000); }}>Save settings</button> {msg && <span className="ok">{msg}</span>}</p>
        <p className="muted-note">Everything here reaches agents via MCP instructions on connect and inside orient. The entry prompt teaches discovery only — detail stays in artefacts.</p>
      </div>
    </div>
  );
}
