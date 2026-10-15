import { useEffect, useState } from "react";
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

/** Agent setup: bootstrap prompt + mcpServers JSON — shown in a modal so it's out of the flow. */
function AgentSetupModal({ label, secret, projectName, onClose }: { label: string | null; secret: string | null; projectName: string; onClose: () => void }) {
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
    <div className="panel-backdrop" onClick={onClose}>
      <div className="overlay-card connect-modal" onClick={(e) => e.stopPropagation()}>
        <div className="detail-head">
          <h2>Connect "{tokenLabel}"</h2>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <p className="muted-note">Wire the agent's MCP config, then prepend the bootstrap prompt. {secret ? "The auth token is shown once — store it now." : "Mint a token to slot the real one in."}</p>
        <Copyable label="Bootstrap prompt" body={prompt} />
        <Copyable label="mcpServers JSON" body={mcpJson} />
        {secret && (
          <div className="secret">
            Auth token (shown once):<br />{secret}
          </div>
        )}
      </div>
    </div>
  );
}

export function ConnectView() {
  const tokens = useKb((s) => s.tokens);
  const sessions = useKb((s) => s.sessions);
  const settings = useKb((s) => s.settings);
  const mint = useKb((s) => s.mint);
  const revoke = useKb((s) => s.revoke);
  
  const [label, setLabel] = useState("");
  const [tags, setTags] = useState("");
  const [transport, setTransport] = useState("mcp");
  const [setupFor, setSetupFor] = useState<{ label: string; secret: string | null } | null>(null);
  const [msg, setMsg] = useState("");


  const projectName = settings.project_name || "Superpositional";

  const doMint = async () => {
    try {
      const t = await mint(label.trim(), tags.split(",").map((x) => x.trim()).filter(Boolean), transport);
      setSetupFor({ label: t.label, secret: t.secret });
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

      {setupFor && <AgentSetupModal label={setupFor.label} secret={setupFor.secret} projectName={projectName} onClose={() => setSetupFor(null)} />}

      <div className="card">
        <h2>Auth tokens</h2>
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
                <td>
                  {!t.revoked_ts && (
                    <>
                      <button className="opt-btn" onClick={() => setSetupFor({ label: t.label, secret: null })}>setup</button>{" "}
                      <button className="opt-btn danger" onClick={() => void revoke(t.id)}>revoke</button>
                    </>
                  )}
                </td>
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

    </div>
  );
}
