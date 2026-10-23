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
};
