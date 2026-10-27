import { useEffect, useState } from "react";
import { Btn, Select } from "@bridge/ui-kit";
import { wsApi, type WsList } from "../lib/workspaces";
import { WorkspaceMembers } from "./WorkspaceMembers";

/** Workspace selector/creator — the hub scopes every board, token and agent
 *  to a workspace; this is the human's door between them. Switch re-mints
 *  the session cookie, so the page reloads to re-point every store. */
export function WorkspacePicker() {
  const [data, setData] = useState<WsList | null>(null);
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState(false);
  const [slug, setSlug] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const load = () => {
    wsApi.list().then(setData).catch(() => setData(null)); // legacy/password mode → hidden
  };
  useEffect(load, []);

  if (!data || data.workspaces.filter((w) => w.member).length === 0) return null;

  const mine = data.workspaces.filter((w) => w.member);
  const label = (w: { slug: string; personal: boolean }) =>
    w.personal ? `${w.slug} (personal)` : w.slug;

  const switchTo = async (ws: string) => {
    if (ws === data.current) return;
    setErr(""); setMsg("switching…");
    const r = await wsApi.switch(ws);
    if (r.status === 204) {
      window.location.reload(); // cookie now points at the new workspace
    } else {
      setErr(`switch failed (${r.status})`); setMsg("");
    }
  };

  const create = async () => {
    const s = slug.trim().toLowerCase();
    if (!s) return;
    setErr(""); setMsg("creating…");
    try {
      await wsApi.create(s);
      setSlug(""); setCreating(false); setMsg("");
      const r = await wsApi.switch(s);
      if (r.status === 204) window.location.reload();
      else load();
    } catch (e) {
      setErr((e as Error).message); setMsg("");
    }
  };

  return (
    <div className="ws-picker" title="workspace — boards, tokens and agents are scoped per workspace">
      <Select
        value={data.current}
        onChange={(e) => void switchTo((e.target as HTMLSelectElement).value)}
      >
        {mine.map((w) => (
          <option key={w.slug} value={w.slug}>
            {w.slug === data.home ? "⌂ " : ""}{label(w)}
          </option>
        ))}
      </Select>
      {creating ? (
        <span className="ws-create">
          <input
            autoFocus
            value={slug}
            placeholder="workspace-name"
            onChange={(e) => setSlug(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void create()}
          />
          <Btn size="sm" disabled={!slug.trim()} onClick={() => void create()}>create</Btn>
          <Btn size="sm" quiet onClick={() => { setCreating(false); setSlug(""); setErr(""); }}>✕</Btn>
        </span>
      ) : (
        <Btn size="sm" quiet className="ws-new" title="create a workspace — you become its owner and first member" onClick={() => setCreating(true)}>＋</Btn>
      )}
      <Btn
        size="sm"
        quiet
        on={managing}
        className="ws-people"
        title="members — invite by GitHub username or remove them"
        onClick={() => setManaging(!managing)}
      >
        👥
      </Btn>
      {managing && <WorkspaceMembers ws={data.current} onChanged={load} />}
      {msg && <span className="muted-note">{msg}</span>}
      {err && <span className="st-err">{err}</span>}
    </div>
  );
}
