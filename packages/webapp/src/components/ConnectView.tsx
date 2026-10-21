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

/** Agent setup: bootstrap prompt + per-client MCP config snippet — shown in a modal so it's out of the flow. */
function AgentSetupModal({ label, secret, projectName, onClose }: { label: string | null; secret: string | null; projectName: string; onClose: () => void }) {
  const url = `${getConfig().url}/mcp`;
  const [instructions, setInstructions] = useState("");
  const [client, setClient] = useState<"opencode" | "generic">("opencode");
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

  const mcpJson = client === "opencode"
    ? JSON.stringify(
        { $schema: "https://opencode.ai/config.json", mcp: { bridge: { type: "remote", url, enabled: true, oauth: false, headers: { Authorization: `Bearer ${token}` } } } },
        null, 2,
      )
    : JSON.stringify(
        { mcpServers: { bridge: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } },
        null, 2,
      );
  const mcpTarget = client === "opencode"
    ? "opencode config — ~/.config/opencode/opencode.json"
    : "generic mcpServers JSON — claude code & similar clients";
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
        <div className="connect-row">
          <select value={client} onChange={(e) => setClient(e.target.value as "opencode" | "generic")}>
            <option value="opencode">opencode</option>
            <option value="generic">generic (mcpServers)</option>
          </select>
        </div>
        <Copyable label={mcpTarget} body={mcpJson} />
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
  const gatewayAgents = useKb((s) => s.gatewayAgents);
  const sessions = useKb((s) => s.sessions);
  const settings = useKb((s) => s.settings);
  const mint = useKb((s) => s.mint);
  const revoke = useKb((s) => s.revoke);
  const setTokenTags = useKb((s) => s.setTokenTags);

  const [label, setLabel] = useState("");
  const [transport, setTransport] = useState("mcp");
  // identity class (BR#2455): gateways are infrastructure named gw-*; agents never are
  const [isGateway, setIsGateway] = useState(false);
  const [setupFor, setSetupFor] = useState<{ label: string; secret: string | null } | null>(null);
  const [msg, setMsg] = useState("");
  // inline tags editor: tokenId -> current draft (roles/capabilities, replaces on save)
  const [editTags, setEditTags] = useState<{ id: string; draft: string } | null>(null);

  const saveTags = async () => {
    if (!editTags) return;
    try {
      const tags = editTags.draft.split(",").map((x) => x.trim()).filter(Boolean);
      await setTokenTags(editTags.id, tags);
      setEditTags(null);
      setMsg("");
    } catch (e) {
      setMsg(`tags update failed: ${(e as Error).message}`);
    }
  };


  const projectName = settings.project_name || "Superpositional";


  const isGwToken = (t: { tags?: string[] }) => (t.tags ?? []).some((x) => x.toLowerCase() === "gateway");
  const gateways = tokens.filter(isGwToken);
  const agents = tokens.filter((t) => !isGwToken(t));

  const doMint = async () => {
    const tagList = isGateway ? ["gateway"] : [];
    try {
      const t = await mint(label.trim(), tagList, transport);
      setSetupFor({ label: t.label, secret: t.secret });
      setLabel("");
    } catch (e) {
      setMsg(`mint failed: ${(e as Error).message}`);
    }
  };

  return (
    <div className="connect-wrap">
      <div className="view-head">
        <h2>Connect</h2>
        <span className="muted-note">gateways are infrastructure (gw-*), agents are peers · sessions self-name</span>
      </div>

      {setupFor && <AgentSetupModal label={setupFor.label} secret={setupFor.secret} projectName={projectName} onClose={() => setSetupFor(null)} />}

      <div className="card">
        <h2>Gateways</h2>
        <p className="muted-note">infrastructure identities (gw-*): each lists the agents it dispatched recently — attributed agents are nested here, never peers.</p>
        <table className="log-table">
          <thead><tr><th>gateway</th><th>dispatched agents</th><th>tags</th><th>last seen</th><th>state</th><th></th></tr></thead>
          <tbody>
            {gateways.length === 0 && (
              <tr><td colSpan={6}><span className="muted-note">no gateways — pair a device as a gateway (gw-&lt;hostname&gt;) or mint one below</span></td></tr>
            )}
            {gateways.map((t) => (
              <tr key={t.id}>
                <td>{t.label}</td>
                <td>
                  {(gatewayAgents.filter((e) => e.gateway === t.label).length
                    ? gatewayAgents.filter((e) => e.gateway === t.label).map((e) => (
                        <span key={e.agent} title={`dispatched ${rel(e.last_seen_ts)} ago`}>{e.agent}{" "}</span>
                      ))
                    : <span className="muted-note">none yet</span>)}
                </td>
                <td>
                  {editTags?.id === t.id ? (
                    <span className="row">
                      <input
                        className="login-input"
                        value={editTags.draft}
                        placeholder="gateway"
                        autoFocus
                        onChange={(e) => setEditTags({ id: t.id, draft: e.target.value })}
                        onKeyDown={(e) => { if (e.key === "Enter") void saveTags(); if (e.key === "Escape") setEditTags(null); }}
                      />
                      <button className="opt-btn" onClick={() => void saveTags()}>save</button>
                      <button className="opt-btn opt-ghost" onClick={() => setEditTags(null)}>cancel</button>
                    </span>
                  ) : (
                    <span title="gateway class + capabilities">{(t.tags ?? []).join(", ") || <span className="muted-note">none</span>}</span>
                  )}
                </td>
                <td>{t.last_seen_ts ? rel(t.last_seen_ts) : "never"}</td>
                <td>{t.revoked_ts ? <span className="login-error">revoked</span> : <span className="ok">active</span>}</td>
                <td>
                  {!t.revoked_ts && (
                    <>
                      <button className="opt-btn" onClick={() => setEditTags({ id: t.id, draft: (t.tags ?? []).join(", ") })}>tags</button>{" "}
                      <button className="opt-btn danger" onClick={() => void revoke(t.id)}>revoke</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2>Agents</h2>
        <div className="row">
          <div>
            <label>Identity class</label>
            <div className="role-picker">
              <label className="role-opt">
                <input type="checkbox" checked={isGateway} onChange={(e) => setIsGateway(e.target.checked)} />
                <span className="gateway">gateway (gw-*)</span>
              </label>
            </div>
          </div>
        </div>
        <div className="row">
          <div><label>{isGateway ? "Gateway label (gw-<hostname>)" : "Agent label"}</label><input value={label} placeholder={isGateway ? "gw-macbookpro" : "opencode-ray"} onChange={(e) => setLabel(e.target.value)} /></div>
        </div>
        {isGateway && <p className="muted-note">gateways claim and dispatch on behalf of the agents they run — they never own tasks as themselves. labels must be gw-&lt;name&gt; (lowercase); the class boundary is enforced at mint/rename.</p>}
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
            {agents.map((t) => (
              <tr key={t.id}>
                <td>{t.label}</td>
                <td>
                  {editTags?.id === t.id ? (
                    <span className="row">
                      <input
                        className="login-input"
                        value={editTags.draft}
                        placeholder="role:analysis, role:impl, …"
                        autoFocus
                        onChange={(e) => setEditTags({ id: t.id, draft: e.target.value })}
                        onKeyDown={(e) => { if (e.key === "Enter") void saveTags(); if (e.key === "Escape") setEditTags(null); }}
                      />
                      <button className="opt-btn" onClick={() => void saveTags()}>save</button>
                      <button className="opt-btn opt-ghost" onClick={() => setEditTags(null)}>cancel</button>
                    </span>
                  ) : (
                    <span title="roles + capabilities — used for ask routing (tag:*) and swimlane gates">{(t.tags ?? []).join(", ") || <span className="muted-note">none</span>}</span>
                  )}
                </td>
                <td>{t.transport ?? "mcp"}</td>
                <td>{rel(t.created_ts)}</td>
                <td>{t.last_seen_ts ? rel(t.last_seen_ts) : "never"}</td>
                <td>{t.revoked_ts ? <span className="login-error">revoked</span> : <span className="ok">active</span>}</td>
                <td>
                  {!t.revoked_ts && (
                    <>
                      <button className="opt-btn" onClick={() => setEditTags({ id: t.id, draft: (t.tags ?? []).join(", ") })}>tags</button>{" "}
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
