/** Workspace registry API (human plane, cookie session).
 *  The hub owns the registry (default KB DO); list/create/switch are
 *  membership-checked server-side — switch re-mints the session cookie. */

export interface WsInfo {
  slug: string;
  owner: string;
  personal: boolean;
  created_ts: number;
  member: boolean;
}

export interface WsList {
  workspaces: WsInfo[];
  current: string;
  home: string;
}

export interface WsMembers {
  ws: string;
  owner: string;
  members: string[];
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: "include", ...init });
  if (!r.ok) throw new Error(`${r.status} ${await r.text().then((t) => t.slice(0, 200))}`);
  return (await r.json()) as T;
}

export const wsApi = {
  list: () => j<WsList>("/api/workspaces"),
  create: (slug: string) =>
    j<{ slug: string }>("/api/workspaces", { method: "POST", body: JSON.stringify({ slug }) }),
  switch: (ws: string) =>
    fetch("/api/workspaces/switch", { method: "POST", credentials: "include", body: JSON.stringify({ ws }) }),
  members: (ws: string) => j<WsMembers>(`/api/workspaces/${encodeURIComponent(ws)}/members`),
  /** invite by GitHub username — verified:false means GitHub couldn't be
   *  asked (rate limit); the invite still stands, the login is the real gate */
  invite: (ws: string, login: string) =>
    j<{ ok: boolean; verified?: boolean }>(`/api/workspaces/${encodeURIComponent(ws)}/members`, {
      method: "POST", body: JSON.stringify({ login }),
    }),
  remove: (ws: string, login: string) =>
    fetch(`/api/workspaces/${encodeURIComponent(ws)}/members/${encodeURIComponent(login)}`, {
      method: "DELETE", credentials: "include",
    }),
};
