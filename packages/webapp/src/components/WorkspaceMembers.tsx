import { useEffect, useState } from "react";
import { Btn } from "@bridge/ui-kit";
import { wsApi, type WsMembers } from "../lib/workspaces";

/** Workspace membership panel: invite by GitHub username, remove members.
 *  Everyone holds the same rights — any member can invite or remove; the
 *  workspace creator cannot be removed (server-enforced). An invited login
 *  can sign in immediately via the GitHub button. */
export function WorkspaceMembers({ ws, onChanged }: { ws: string; onChanged?: () => void }) {
  const [data, setData] = useState<WsMembers | null>(null);
  const [login, setLogin] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const load = () => {
    wsApi.members(ws).then(setData).catch((e) => setErr((e as Error).message));
  };
  useEffect(load, [ws]);

  if (!data) return err ? <div className="ws-members"><span className="st-err">{err}</span></div> : null;

  const invite = async () => {
    const who = login.trim();
    if (!who) return;
    setErr(""); setMsg("inviting…");
    try {
      const r = await wsApi.invite(ws, who);
      setLogin("");
      setMsg(r.verified === false
        ? `invited ${who} — GitHub lookup unavailable, they can still sign in`
        : `invited ${who} — they can sign in with GitHub now`);
      load(); onChanged?.();
    } catch (e) {
      setErr((e as Error).message); setMsg("");
    }
  };

  const remove = async (who: string) => {
    setErr(""); setMsg("removing…");
    const r = await wsApi.remove(ws, who);
    if (r.ok) { setMsg(""); load(); onChanged?.(); }
    else { setErr(`remove failed (${r.status})`); setMsg(""); }
  };

  return (
    <div className="ws-members" title="invite teammates by GitHub username — they sign in with the GitHub button">
      <div className="ws-members-row">
        <input
          value={login}
          placeholder="github-username"
          onChange={(e) => setLogin(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void invite()}
        />
        <Btn size="sm" disabled={!login.trim()} onClick={() => void invite()}>invite</Btn>
      </div>
      {msg && <span className="muted-note">{msg}</span>}
      {err && <span className="st-err">{err}</span>}
      <ul>
        {data.members.map((m) => (
          <li key={m}>
            <span>{m}{m === data.owner ? " (creator)" : ""}</span>
            {m !== data.owner && (
              <Btn size="sm" quiet onClick={() => void remove(m)}>remove</Btn>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
