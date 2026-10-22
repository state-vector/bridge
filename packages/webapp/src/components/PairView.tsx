import { useEffect, useState } from "react";

/**
 * Device pairing approval (GitHub-like device flow, bridge-native).
 * Reached at /pair by a human already signed in via GitHub — the page gates
 * on the session before anything else. The DEVICE declares its class at
 * pair/start; the approver only names the identity and picks the workspace.
 * Pairing is a gateway act: agents are provisioned by gateways, never
 * self-paired, so there are no roles here.
 */

async function api<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const out = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(out.error ?? `request failed (${r.status})`);
  return out;
}

function prefillLabel(device: string, gateway: boolean): string {
  const slug = (device.replace(/[^a-zA-Z0-9._-]/g, "-").match(/[a-zA-Z0-9._-]+/g) ?? []).join("-").replace(/^-+|-+$/g, "").slice(0, 40) || "device";
  // BR#2455: gateway pairings prefill the gw-* convention (auto gw-<hostname>).
  // A suggestion, not a gate — the tag is the class authority (BR#2482); the
  // approver can still rename, and nothing rejects a non-gw-* label.
  return gateway ? `gw-${slug.toLowerCase()}`.slice(0, 40) : slug;
}

export function PairView() {
  const [authed, setAuthed] = useState<boolean | null>(null); // null = checking
  const [code, setCode] = useState("");
  const [info, setInfo] = useState<{ device: string; type: string; created_ts: number } | null>(null);
  const [label, setLabel] = useState("");
  const [ws, setWs] = useState("");
  const [workspaces, setWorkspaces] = useState<Array<{ slug: string }>>([]);
  const [msg, setMsg] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/session", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { user: null }))
      .then((d) => setAuthed(!!d.user))
      .catch(() => setAuthed(false));
  }, []);

  useEffect(() => {
    if (!authed) return;
    fetch("/api/workspaces", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { workspaces: [] }))
      .then((d) => setWorkspaces(d.workspaces ?? []))
      .catch(() => setWorkspaces([]));
  }, [authed]);

  if (authed === null) {
    return (
      <div className="auth-gate">
        <div className="auth-card">
          <div className="brand auth-brand">Bridge</div>
          <p className="muted-note">…</p>
        </div>
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="auth-gate">
        <div className="auth-card">
          <div className="brand auth-brand">Bridge</div>
          <p className="auth-host">Sign in to approve a pairing</p>
          <p className="muted-note">
            Pairing approval is human-plane — sign in with GitHub first, then come back to this page.
          </p>
          <a className="opt-btn auth-submit" href="/login" style={{ display: "block", textAlign: "center", textDecoration: "none" }}>
            Sign in with GitHub
          </a>
        </div>
      </div>
    );
  }

  const lookup = async () => {
    setMsg("");
    setBusy(true);
    try {
      const d = await api<{ device: string; type: string; created_ts: number; status: string }>("/api/pair/get", {
        code: code.trim().toUpperCase(),
      });
      if (d.status !== "pending") {
        setInfo(null);
        setMsg(`code is ${d.status}`);
        return;
      }
      const gateway = (d.type ?? "gateway") === "gateway";
      setInfo({ device: d.device, type: d.type ?? "gateway", created_ts: d.created_ts });
      setLabel(prefillLabel(d.device, gateway));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    setMsg("");
    setBusy(true);
    try {
      await api("/api/pair/approve", {
        code: code.trim().toUpperCase(),
        ws,
        label: label.trim(),
      });
      setDone(true);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="auth-gate">
        <div className="auth-card">
          <div className="brand auth-brand">Bridge</div>
          <p className="auth-host">Device paired ✓</p>
          <p className="muted-note">
            The token was minted in <b>{ws}</b> and is waiting for the device&apos;s next poll — it
            picks it up automatically. The token is shown only on the device, never here.
          </p>
        </div>
      </div>
    );
  }

  const gateway = info?.type === "gateway";

  return (
    <div className="auth-gate">
      <div className="auth-card">
        <div className="brand auth-brand">Bridge</div>
        {!info ? (
          <>
            <p className="auth-host">Pair a device</p>
            <p className="muted-note">
              Enter the code shown on the device (e.g. <code>K7M3-Q9XZ</code>).
            </p>
            <input
              className="login-input"
              value={code}
              placeholder="XXXX-XXXX"
              autoFocus
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === "Enter" && code.trim().length >= 8) void lookup(); }}
            />
            <button className="opt-btn auth-submit" disabled={code.trim().length < 8 || busy} onClick={() => void lookup()}>
              {busy ? "…" : "Look up device"}
            </button>
          </>
        ) : (
          <>
            <p className="auth-host">
              Pair <b>{info.device}</b>?
            </p>
            <label>Token label ({gateway ? "gateway name — pre-filled gw-<hostname>, editable" : "agent name"})</label>
            <input className="login-input" value={label} onChange={(e) => setLabel(e.target.value)} />
            <label>Workspace</label>
            <select className="login-input" value={ws} onChange={(e) => setWs(e.target.value)}>
              <option value="">choose…</option>
              {workspaces.map((w) => (
                <option key={w.slug} value={w.slug}>{w.slug}</option>
              ))}
            </select>
            <button className="opt-btn auth-submit" disabled={!ws || !label.trim() || busy} onClick={() => void approve()}>
              {busy ? "…" : "Approve"}
            </button>
          </>
        )}
        {msg && <span className="login-error">{msg}</span>}
      </div>
    </div>
  );
}
