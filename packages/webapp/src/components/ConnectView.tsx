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

  const [label, setLabel] = useState("");
  const [setupFor, setSetupFor] = useState<{ label: string; secret: string | null } | null>(null);
  const [msg, setMsg] = useState("");
  const projectName = settings.project_name || "Superpositional";

  const isGwToken = (t: { tags?: string[] }) => (t.tags ?? []).some((x) => x.toLowerCase() === "gateway");
  const gateways = tokens.filter(isGwToken);
  const agents = tokens.filter((t) => !isGwToken(t));

  const addAgent = async () => {
    try {
      const t = await mint(label.trim(), [], "mcp");
      setSetupFor({ label: t.label, secret: t.secret });
      setLabel("");
    } catch (e) {
      setMsg(`could not add agent: ${(e as Error).message}`);
    }
  };

  return (
    <div className="connect-wrap">
      <div className="view-head">
        <h2>Connect</h2>
        <span className="muted-note">agents connect over MCP · gateways are paired devices</span>
      </div>

      {setupFor && <AgentSetupModal label={setupFor.label} secret={setupFor.secret} projectName={projectName} onClose={() => setSetupFor(null)} />}

      <div className="card">
        <h2>Add agent</h2>
        <p className="muted-note">Give it a name — a token is generated, shown once. The agent connects over MCP or the API with it.</p>
        <div className="row">
          <input
            value={label}
            placeholder="agent name (e.g. opencode-ray)"
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && label.trim()) void addAgent(); }}
          />
          <button className="opt-btn auth-submit" disabled={!label.trim()} onClick={() => void addAgent()}>Add agent</button>
        </div>
        {msg && <p className="login-error">{msg}</p>}
        <table className="log-table">
          <thead><tr><th>agent</th><th>created</th><th>last seen</th><th>state</th><th></th></tr></thead>
          <tbody>
            {agents.length === 0 && (
              <tr><td colSpan={6}><span className="muted-note">no agents yet — add one above</span></td></tr>
            )}
            {agents.map((t) => (
              <tr key={t.id}>
                <td>{t.label}</td>
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

        <h2>Gateways</h2>
        <p className="muted-note">paired devices — each lists the workers it dispatched recently. Gateways are created by pairing, not here.</p>
        <table className="log-table">
          <thead><tr><th>gateway</th><th>dispatched workers</th><th>last seen</th><th>state</th><th></th></tr></thead>
          <tbody>
            {gateways.length === 0 && (
              <tr><td colSpan={5}><span className="muted-note">no gateways — pair a desktop or runner (Pair in the desktop app)</span></td></tr>
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
                <td>{t.last_seen_ts ? rel(t.last_seen_ts) : "never"}</td>
                <td>{t.revoked_ts ? <span className="login-error">revoked</span> : <span className="ok">active</span>}</td>
                <td>
                  {!t.revoked_ts && (
                    <button className="opt-btn danger" onClick={() => void revoke(t.id)}>revoke</button>
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
