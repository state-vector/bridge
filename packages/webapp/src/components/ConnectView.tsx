import { useEffect, useMemo, useState } from "react";
import { useKb } from "../store/kb";
import { getConfig } from "../lib/config";
import { rel } from "../lib/views";
import { Btn, Card, Chip, Select, TextInput } from "@bridge/ui-kit";

function Copyable({ label, body }: { label: string; body: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="connect-block">
      <div className="connect-row">
        <span>{label}</span>
        <Btn onClick={async () => { await navigator.clipboard.writeText(body); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
          {copied ? "copied ✓" : "copy"}
        </Btn>
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
          <Select value={client} onChange={(e) => setClient(e.target.value as "opencode" | "generic")}>
            <option value="opencode">opencode</option>
            <option value="generic">generic (mcpServers)</option>
          </Select>
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

type TokenRow = {
  id: string; label: string; tags?: string[]; created_ts: number;
  last_seen_ts?: number; revoked_ts?: number;
};

/** Identity class from label + tags (BR#2455 law + provisioning provenance):
 *  gateway (tags contain "gateway"), worker-agent (provisioned by a gateway),
 *  agent (independently onboarded). */
function classOf(t: TokenRow): "gateway" | "worker" | "agent" {
  const tags = (t.tags ?? []).map((x) => String(x).toLowerCase());
  if (tags.includes("gateway")) return "gateway";
  if (tags.includes("provisioned")) return "worker";
  return "agent";
}

export function ConnectView() {
  const tokens = useKb((s) => s.tokens);
  const sessions = useKb((s) => s.sessions);
  const settings = useKb((s) => s.settings);
  const mint = useKb((s) => s.mint);
  const revoke = useKb((s) => s.revoke);

  const [label, setLabel] = useState("");
  const [setupFor, setSetupFor] = useState<{ label: string; secret: string | null } | null>(null);
  const [msg, setMsg] = useState("");
  const projectName = settings.project_name || "Superpositional";

  const { gateways, workersByGateway, agents } = useMemo(() => {
    const rows = tokens as TokenRow[];
    const gateways = rows.filter((t) => classOf(t) === "gateway");
    const workers = rows.filter((t) => classOf(t) === "worker");
    const byGateway = new Map<string, TokenRow[]>();
    for (const w of workers) {
      const gw = (w.tags ?? []).map(String).find((x) => x.startsWith("by:"))?.slice(3) ?? "unknown";
      (byGateway.get(gw) ?? byGateway.set(gw, []).get(gw)!).push(w);
    }
    const agents = rows.filter((t) => classOf(t) === "agent");
    return { gateways, workersByGateway: byGateway, agents };
  }, [tokens]);

  const sessionsOf = (tokenId: string, gwLabel: string) => {
    const own = sessions.filter((s) => s.token_id === tokenId);
    const workerIds = new Set((workersByGateway.get(gwLabel) ?? []).map((w) => w.id));
    const viaWorkers = sessions.filter((s) => workerIds.has(s.token_id));
    return { own, viaWorkers };
  };

  const addAgent = async () => {
    const name = label.trim().replace(/\/+$/, "");
    if (name.includes("/")) {
      setMsg("agent names cannot contain '/' — the separator is reserved for machine/agent namespacing");
      return;
    }
    try {
      const t = await mint(`_direct/${name}`, [], "mcp");
      setSetupFor({ label: t.label, secret: t.secret });
      setLabel("");
    } catch (e) {
      setMsg(`could not add agent: ${(e as Error).message}`);
    }
  };

  const StateCell = ({ t }: { t: TokenRow }) =>
    t.revoked_ts ? <span className="login-error">revoked</span> : <span className="ok">active</span>;

  const ActionsCell = ({ t }: { t: TokenRow }) => (
    <>
      {!t.revoked_ts && (
        <>
          <Btn onClick={() => setSetupFor({ label: t.label, secret: null })}>setup</Btn>{" "}
          <Btn variant="danger" onClick={() => void revoke(t.id)}>revoke</Btn>
        </>
      )}
    </>
  );

  return (
    <div className="connect-wrap">
      <div className="view-head">
        <h2>Connect</h2>
        <span className="muted-note">one token per identity — gateways (gw-*, infrastructure), worker-agents (provisioned by gateways), agents (independent peers)</span>
      </div>

      {setupFor && <AgentSetupModal label={setupFor.label} secret={setupFor.secret} projectName={projectName} onClose={() => setSetupFor(null)} />}

      <Card>
        <h2>Agents</h2>
        <p className="muted-note">independent peers — mint a token, wire its MCP config, onboard manually. Gateway-spawned workers are NOT minted here; they are provisioned by their gateway and nested under it below.</p>
        <div className="row">
          <TextInput
            value={label}
            placeholder="agent name (e.g. opencode-ray)"
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && label.trim()) void addAgent(); }}
          />
          <Btn className="auth-submit" disabled={!label.trim()} onClick={() => void addAgent()}>Add agent</Btn>
        </div>
        {msg && <p className="login-error">{msg}</p>}
        <table className="log-table">
          <thead><tr><th>agent</th><th>created</th><th>last seen</th><th>state</th><th></th></tr></thead>
          <tbody>
            {agents.length === 0 && (
              <tr><td colSpan={5}><span className="muted-note">no independent agents yet — add one above</span></td></tr>
            )}
            {agents.map((t) => (
              <tr key={t.id}>
                <td>{t.label}</td>
                <td>{rel(t.created_ts)}</td>
                <td>{t.last_seen_ts ? rel(t.last_seen_ts) : "never"}</td>
                <td><StateCell t={t} /></td>
                <td><ActionsCell t={t} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card>
        <h2>Gateways</h2>
        <p className="muted-note">paired devices — infrastructure. Each owns the worker-agents it provisioned and the sessions it dispatched.</p>
        <table className="log-table">
          <thead><tr><th>gateway</th><th>worker-agents</th><th>dispatched sessions</th><th>last seen</th><th>state</th><th></th></tr></thead>
          <tbody>
            {gateways.length === 0 && (
              <tr><td colSpan={6}><span className="muted-note">no gateways — pair a desktop or runner (Pair in the desktop app)</span></td></tr>
            )}
            {gateways.map((t) => {
              const workers = workersByGateway.get(t.label) ?? [];
              const { own, viaWorkers } = sessionsOf(t.id, t.label);
              return (
                <tr key={t.id}>
                  <td>
                    <Chip tone="scope">gateway</Chip> {t.label}
                  </td>
                  <td>
                    {workers.length === 0 && <span className="muted-note">none</span>}
                    {workers.map((w) => (
                      <div key={w.id} title={`provisioned worker — last seen ${w.last_seen_ts ? rel(w.last_seen_ts) : "never"}`}>
                        {w.label}{" "}{w.revoked_ts ? <span className="login-error">(revoked)</span> : <span className="ok">(active)</span>}
                      </div>
                    ))}
                  </td>
                  <td>
                    {own.length === 0 && viaWorkers.length === 0 && <span className="muted-note">none</span>}
                    {own.length > 0 && <div className="muted-note">{own.length} dispatch session{own.length > 1 ? "s" : ""}</div>}
                    {viaWorkers.slice(0, 4).map((s, i) => (
                      <div key={i} className="muted-note" title={s.name}>{s.name}</div>
                    ))}
                  </td>
                  <td>{t.last_seen_ts ? rel(t.last_seen_ts) : "never"}</td>
                  <td><StateCell t={t} /></td>
                  <td>
                    {!t.revoked_ts && (
                      <Btn variant="danger" onClick={() => void revoke(t.id)}>revoke</Btn>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="muted-note">revoking a gateway does not revoke its worker-agents — revoke those individually if they are lost.</p>
      </Card>

      <Card>
        <h2>Sessions</h2>
        <table className="log-table">
          <thead><tr><th>identity</th><th>session</th><th>first seen</th><th>last seen</th></tr></thead>
          <tbody>
            {sessions.map((s, i) => (
              <tr key={i}><td>{s.label ?? s.token_id}</td><td>{s.name}</td><td>{rel(s.first_seen_ts)}</td><td>{rel(s.last_seen_ts)}</td></tr>
            ))}
          </tbody>
        </table>
      </Card>

    </div>
  );
}
