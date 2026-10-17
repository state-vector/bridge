import { useEffect, useState } from "react";

/**
 * Device pairing approval (GitHub-like device flow, bridge-native).
 * Reached at /pair by a human already signed in via GitHub. The device shows a
 * code; approving mints an agent token in the chosen workspace — the token
 * flows to the DEVICE via its poll loop, never to the approver.
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

const ROLES = ["impl", "analysis", "review"];

export function PairView() {
  const [code, setCode] = useState("");
  const [info, setInfo] = useState<{ device: string; created_ts: number } | null>(null);
  const [label, setLabel] = useState("");
  const [ws, setWs] = useState("");
  const [workspaces, setWorkspaces] = useState<Array<{ slug: string }>>([]);
  const [roles, setRoles] = useState<string[]>(["impl"]);
  const [msg, setMsg] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/workspaces", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { workspaces: [] }))
      .then((d) => setWorkspaces(d.workspaces ?? []))
      .catch(() => setWorkspaces([]));
  }, []);

  const lookup = async () => {
    setMsg("");
    setBusy(true);
    try {
      const d = await api<{ device: string; created_ts: number; status: string }>("/api/pair/get", {
        code: code.trim().toUpperCase(),
      });
      if (d.status !== "pending") {
        setInfo(null);
        setMsg(`code is ${d.status}`);
        return;
      }
      setInfo({ device: d.device, created_ts: d.created_ts });
      setLabel(d.device.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 40) || "device");
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
        tags: roles.map((r) => `role:${r}`),
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
            <label>Token label (agent name)</label>
            <input className="login-input" value={label} onChange={(e) => setLabel(e.target.value)} />
            <label>Workspace</label>
            <select className="login-input" value={ws} onChange={(e) => setWs(e.target.value)}>
              <option value="">choose…</option>
              {workspaces.map((w) => (
                <option key={w.slug} value={w.slug}>{w.slug}</option>
              ))}
            </select>
            <label>Roles</label>
            <div className="ask-chips">
              {ROLES.map((r) => (
                <button
                  key={r}
                  className={`chip ${roles.includes(r) ? "chip-scope" : ""}`}
                  onClick={() => setRoles(roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r])}
                >
                  role:{r}
                </button>
              ))}
            </div>
            <button className="opt-btn auth-submit" disabled={!ws || !label.trim() || busy} onClick={() => void approve()}>
              {busy ? "…" : "Approve & mint token"}
            </button>
          </>
        )}
        {msg && <span className="login-error">{msg}</span>}
      </div>
    </div>
  );
}
