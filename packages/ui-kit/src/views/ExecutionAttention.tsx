import { useEffect, useState } from "react";
import { ExecutionAttentionSchema, ReasoningTierSchema, isAccountActionCause, providerIncidentText, type ExecutionAttention, type ExecutionAttentionItem } from "@bridge/contracts";
import { kbApi } from "../server/kb";
import { useKb } from "../server/kbStore";
import { getKbHubConfig } from "../server/config";
import { copyText } from "./claimLocally";
import "./execution-attention.css";
import { notifyExecutionAttention } from "../server/executionNotifications";

function LocalActions({ item, agents, changed }: { item: ExecutionAttentionItem; agents: ExecutionAttention["interactive_agents"]; changed: () => void }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(""); const [session, setSession] = useState("");
  const [host, setHost] = useState(""); const [tier, setTier] = useState("");
  const [model, setModel] = useState(""); const [evidence, setEvidence] = useState("");
  const [repo, setRepo] = useState(""); const [remoteRef, setRemoteRef] = useState("");
  const [commit, setCommit] = useState(""); const [tree, setTree] = useState(""); const [baseCommit, setBaseCommit] = useState("");
  const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const h = item.handoff;
  async function copy() {
    try { if (!await copyText(item.continuation_prompt ?? "")) throw new Error("Clipboard unavailable"); setMessage("Continuation prompt copied. Copying does not accept or resume work."); }
    catch (error) { setMessage(`Copy failed: ${String(error)}. Select the prompt below to copy it manually.`); }
  }
  async function act() {
    if (h.phase !== "waiting" && h.phase !== "accepted" && h.phase !== "preparing") return;
    setBusy(true); setMessage("");
    try {
      const base = { id: item.id, handoff_id: h.id, version: h.version };
      const result = await kbApi.handoffControl(h.phase === "preparing"
        ? { ...base, kind: "confirm_preparation", writers: "human_confirmed_quiescent", evidence,
          checkpoint: { repo, remote_ref: remoteRef, commit, tree, base: baseCommit, environment: [], next: h.next, tests: [] } }
        : h.phase === "accepted"
        ? { ...base, kind: "return_autonomous", writers: "human_confirmed_quiescent" }
        : { ...base, kind: "authorize", label, session, host, evidence,
          capabilities: { tier: ReasoningTierSchema.parse(tier), model, backend: "interactive", tools: item.requirements.tools,
            worker: { kind: "unprovisioned" },
            environment: item.requirements.environment, config_revision: `human-session:${session}`, capacity: 1,
            projects: [item.project], alternatives: [], availability: { kind: "usable" } } });
      if (!["authorized", "returned_autonomous", "preparation_confirmed"].includes(result.kind)) throw new Error(`${result.kind}: ${JSON.stringify(result.prerequisites ?? [])}`);
      setMessage(result.kind === "authorized" ? "This credential/session is authorised for 15 minutes. The local agent must explicitly call handoff_accept; work has not resumed." : result.kind === "preparation_confirmed" ? "Preparation attestation recorded. Explicit local authorisation and acceptance are still required." : "Local execution returned to automation. Other capability or human blockers still apply.");
      setOpen(false); setConfirmed(false); changed();
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  }
  return <div className="execution-actions">
    {h.phase === "waiting" && <p>A human-directed interactive agent can claim this task directly with a named session using transition to in_progress. No additional web authorisation is required. The explicit capability-grant flow below remains available.</p>}
    <button type="button" onClick={copy}>Copy continuation prompt</button>
    <details><summary>Continuation details</summary><pre className="execution-prompt">{item.continuation_prompt}</pre></details>
    {(h.phase === "waiting" || h.phase === "accepted" || h.phase === "preparing") && <button type="button" onClick={() => setOpen(!open)}>
      {h.phase === "waiting" ? "Authorise a local session" : h.phase === "preparing" ? "Confirm manual preparation" : "Return to automation"}
    </button>}
    {open && <form className="execution-grant" onSubmit={e => { e.preventDefault(); void act(); }}>
      {h.phase === "preparing" && <>
        <p>For manual-origin work only: record the published checkpoint and your quiescence evidence. A native runner must confirm its own process group; this action cannot override it.</p>
        <label>Published repository <input required value={repo} onChange={e => setRepo(e.target.value)} /></label>
        <label>Published checkpoint ref <input required value={remoteRef} onChange={e => setRemoteRef(e.target.value)} placeholder="refs/heads/bridge-checkpoints/…" /></label>
        <label>Checkpoint commit <input required value={commit} onChange={e => setCommit(e.target.value)} /></label>
        <label>Checkpoint content tree <input required value={tree} onChange={e => setTree(e.target.value)} /></label>
        <label>Checkpoint base commit <input required value={baseCommit} onChange={e => setBaseCommit(e.target.value)} /></label>
        <label>Publication and stopped-writer evidence <input required value={evidence} onChange={e => setEvidence(e.target.value)} /></label>
      </>}
      {h.phase === "waiting" && <>
        <p>Authorisation is bound to the exact credential, local session and checkpoint version. A background worker cannot accept it.</p>
        <label>Interactive agent <select required value={label} onChange={e => setLabel(e.target.value)}><option value="">Choose an agent</option>{agents.map(a => <option key={a.label} value={a.label}>{a.label}</option>)}</select></label>
        <label>Local session name <input required value={session} onChange={e => setSession(e.target.value)} placeholder="local-repair-123" /></label>
        <label>Actual execution host <input required value={host} onChange={e => setHost(e.target.value)} /></label>
        <label>Actual model tier <select required value={tier} onChange={e => setTier(e.target.value)}><option value="">Choose observed tier</option><option>small</option><option>medium</option><option>large</option></select></label>
        <label>Actual model ID <input required value={model} onChange={e => setModel(e.target.value)} /></label>
        <label>Capability / restoration evidence <input required value={evidence} onChange={e => setEvidence(e.target.value)} placeholder="How this session's model, access and restored checkpoint were checked" /></label>
        <p>Required tools: {item.requirements.tools.join(", ") || "none declared"}. Environment/access: {item.requirements.environment.join(", ") || "none declared"}. Required host: {item.requirements.host ?? "any"}.</p>
      </>}
      <label className="execution-confirm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} required />
        {h.phase === "preparing" ? "I checked publication of this exact checkpoint and confirm all original manual writers are stopped. This is a human attestation, not a native process proof."
          : h.phase === "accepted" ? "I confirm all local writers are stopped and the latest checkpoint is published; I explicitly authorise return to automation."
          : "I checked this session's actual model, tools/access and exact checkpoint restoration. I authorise only this local credential/session."}
      </label>
      <button type="submit" disabled={busy || !confirmed}>{busy ? "Saving…" : h.phase === "accepted" ? "Confirm return" : h.phase === "preparing" ? "Record preparation attestation" : "Authorise explicit pickup"}</button>
    </form>}
    {message && <p role="status">{message}</p>}
  </div>;
}

function RequestLocal({ item, changed }: { item: ExecutionAttentionItem; changed: () => void }) {
  const [open, setOpen] = useState(false); const [reason, setReason] = useState(""); const [action, setAction] = useState(""); const [message, setMessage] = useState("");
  async function request() {
    try {
      const result = await kbApi.handoffControl({ kind: "request_local", id: item.id, reason, action });
      if (result.kind !== "requested" && result.kind !== "already_requested") throw new Error(result.kind);
      setOpen(false); changed();
    } catch (error) { setMessage(String(error)); }
  }
  return <div className="execution-actions"><button onClick={() => setOpen(!open)}>Request local pickup</button>
    {open && <form className="execution-grant" onSubmit={event => { event.preventDefault(); void request(); }}>
      <p>This requests a local-only handoff. It does not accept execution or bypass checkpoint, writer or model prerequisites.</p>
      <label>Why local execution is needed <input required value={reason} onChange={e => setReason(e.target.value)} /></label>
      <label>Exact requested local action <input required value={action} onChange={e => setAction(e.target.value)} /></label>
      <button type="submit">Prepare local-only handoff</button>
    </form>}{message && <p role="status">{message}</p>}
  </div>;
}

/** Renders the server's composable facts; no client-side eligibility inference. */
export function ExecutionAttentionCards({ data, changed, openTask }: { data: ExecutionAttention; changed: () => void; openTask?: (id: string) => void }) {
  if (!data.items.length) return null;
  return <section id="execution-attention" className="execution-attention" aria-label="Execution attention"><h2>Execution attention</h2>
    {data.items.map(item => <article className="execution-attention-card" key={item.id}>
      <h3><a href={item.url} onClick={e => { if (openTask) { e.preventDefault(); openTask(item.id); } }}>{item.id} — {item.title}</a></h3>
      <ul>{item.blockers.map(blocker => <li key={blocker.episode_id}>
        <strong>{blocker.kind === "local_pickup_required" ? "Blocked — pick up locally: " : blocker.kind === "human_answer_required" ? "Blocked — needs your decision: " : blocker.kind === "capacity_wait" ? "Waiting — capacity: " : "Blocked — "}</strong>
        {blocker.text}{blocker.kind === "human_answer_required" && <a href={`https://hub.fleetbridge.run/card/${blocker.ask_id.replace("#", "-")}`}> Open decision</a>}
        {blocker.kind === "capability_unavailable" && blocker.causes.length > 0 && <ul className="route-incidents">
          {blocker.causes.map(cause => <li key={`${cause.class}|${cause.backend}|${cause.model ?? ""}`} className={isAccountActionCause(cause) ? "route-incident account-action" : "route-incident"}>
            {isAccountActionCause(cause)
              ? <><strong>Provider account incident — you must act:</strong> {providerIncidentText(cause)} Open the provider console, top up the account quota/credits or renew its credential. Your answer reports the action done; Bridge then verifies with a tool-less exact-model probe on this exact route — only a successful probe reopens admission.</>
              : <><strong>Provider incident:</strong> {providerIncidentText(cause)} — contained on this route; no account action needed.</>}
            {cause.message && <details><summary>Sanitized provider evidence</summary><pre>{cause.message}</pre></details>}
          </li>)}
        </ul>}
        {(blocker.kind === "capability_unavailable" || blocker.kind === "executor_not_ready") && blocker.evidence.length > 0 && <details><summary>Gateway/config evidence</summary><ul>{blocker.evidence.map(e => <li key={e}>{e}</li>)}</ul></details>}
      </li>)}</ul>
      {item.handoff.phase === "accepted" && <p>Local execution accepted by session <strong>{item.handoff.session}</strong>. Automation remains fenced.</p>}
      {item.continuation_prompt && <LocalActions item={item} agents={data.interactive_agents} changed={changed} />}
      {(item.handoff.phase === "none" || item.handoff.phase === "returned") && <RequestLocal item={item} changed={changed} />}
    </article>)}
  </section>;
}

export function ExecutionAttentionPanel({ openTask }: { openTask?: (id: string) => void }) {
  const [data, setData] = useState<ExecutionAttention | null>(null); const [error, setError] = useState("");
  async function load() {
    try { const result = ExecutionAttentionSchema.parse(await kbApi.executionAttention()); notifyExecutionAttention(result); setData(result); setError(""); }
    catch (e) { setError(String(e)); useKb.getState().reportError("execution attention", e); }
  }
  useEffect(() => {
    if (getKbHubConfig().mode === "mock") return;
    void load(); const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, []);
  return <>{error && <p role="alert">Execution attention unavailable: {error}</p>}{data && <ExecutionAttentionCards data={data} changed={() => void load()} openTask={openTask} />}</>;
}
