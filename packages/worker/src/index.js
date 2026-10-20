// The DO class must be exported from the entrypoint for wrangler's DO migrations.
export { FlowsHub } from "./do.js";
import { handleMcp, KnowledgeHub } from "./mcp.ts";
import { DEFAULT_WS_SLUG, doWs, isWsSlug } from "./kb/core.ts";

export { KnowledgeHub };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/ingest") {
      return handleIngest(request, env);
    }

    // MCP: machine plane (bearer) — agents talk to the knowledge layer here.
    // machine-plane stats: watchdog liveness for headless observers (token auth).
    // Workspace resolves via the same registry lookup MCP uses, then forwards.
    if (url.pathname === "/api/kb-machine/rename") {
      const body = await request.json().catch(() => ({}));
      const { resolveTokenWs } = await import("./mcp.ts");
      const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!bearer) return new Response("unauthorized", { status: 401 });
      let ws;
      try { ws = await resolveTokenWs(env, bearer); } catch { return new Response("unauthorized", { status: 401 }); }
      return env.KB.get(env.KB.idFromName(doWs(ws))).fetch("https://kb/token.rename", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ bearer, label: body.label }),
      });
    }
    if (url.pathname === "/api/kb-machine/stats") {
      const { resolveTokenWs } = await import("./mcp.ts");
      const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!bearer) return new Response("unauthorized", { status: 401 });
      let ws;
      try { ws = await resolveTokenWs(env, bearer); } catch { return new Response("unauthorized", { status: 401 }); }
      return env.KB.get(env.KB.idFromName(doWs(ws))).fetch("https://kb/stats");
    }

    if (url.pathname === "/mcp") {
      return handleMcp(request, env);
    }

    // Knowledge realtime (human plane, cookie): KB event fanout.
    if (url.pathname === "/kb-ws") {
      const auth = await checkAuth(request, env);
      if (auth instanceof Response) return auth;
      return env.KB.get(env.KB.idFromName(doWs(auth.ws))).fetch("https://kb/ws", request);
    }

    // Knowledge REST mirror (human plane, cookie).
    if (url.pathname.startsWith("/api/kb/") && !url.pathname.startsWith("/api/kb/admin/")) {
      const auth = await checkAuth(request, env);
      if (auth instanceof Response) return auth;
      const kbId = env.KB.idFromName(doWs(auth.ws));
      const sub = url.pathname.slice("/api/kb/".length);
      if (request.method === "GET") {
        const kbUrl = sub === "board" ? "https://kb/board"
          : sub === "events" ? "https://kb/events"
          : sub === "artefacts" ? "https://kb/artefacts"
          : sub === "artefact" ? "https://kb/artefact"
          : sub === "search" ? "https://kb/search"
          : sub === "stats" ? "https://kb/stats"
          : sub === "related" ? "https://kb/related"
          : sub === "history" ? "https://kb/history"
          : sub === "bootstrap" ? "https://kb/bootstrap"
          : null;
        if (!kbUrl) return new Response("not found", { status: 404 });
        return env.KB.get(kbId).fetch(kbUrl + url.search, request);
      }
      if (request.method === "POST") {
        const op = ["create", "update", "transition", "link", "progress", "enrich", "boost"].includes(sub) ? sub : null;
        if (!op) return new Response("not found", { status: 404 });
        const body = await request.json().catch(() => ({}));
        body.actor = "web";
        return env.KB.get(kbId).fetch(`https://kb/${op}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      }
    }

    // Knowledge admin API + page: human plane, forwarded to the KB DO.
    if (url.pathname === "/kb") {
      if (request.headers.get("Accept")?.includes("text/html")) {
        return new Response(ADMIN_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      return new Response("use the /kb page", { status: 404 });
    }
    if (url.pathname.startsWith("/api/kb/admin/")) {
      const auth = await checkAuth(request, env);
      if (auth instanceof Response) return auth;
      const op = url.pathname.slice("/api/kb/admin/".length);
      const kbId = env.KB.idFromName(doWs(auth.ws));
      const kbHub = env.KB.get(kbId);
      const kbUrl =
        op === "tokens" && request.method === "GET" ? "https://kb/admin.list_tokens"
        : op === "tokens" ? "https://kb/admin.mint"
        : op === "tokens/revoke" ? "https://kb/admin.revoke"
        : op === "tokens/tags" ? "https://kb/admin.token_tags"
        : op === "settings" && request.method === "GET" ? "https://kb/admin.settings_get"
        : op === "settings" ? "https://kb/admin.settings_set"
        : null;
      if (!kbUrl) return new Response("not found", { status: 404 });
      const body = await request.json().catch(() => ({}));
      if (op === "tokens") body.ws = auth.ws; // minted tokens scoped to the caller's workspace
      return kbHub.fetch(kbUrl, {
        method: request.method === "GET" ? "POST" : "POST",
        headers: { "content-type": "application/json", "x-kb-admin": "1" },
        body: JSON.stringify(body),
      });
    }

    // Human plane. Auth mode: GitHub OAuth (HMAC session cookie), or Cloudflare
    // Access JWT at the edge when CF_ACCESS_TEAM+AUD are set.
    if (url.pathname === "/login") return handleGithubLogin(request, env);
    if (url.pathname === "/login/callback") return handleGithubCallback(request, env);

    // Device pairing (github-like device flow, bridge-native): start + poll are
    // unauthenticated machine-plane; approve is human-plane (session cookie).
    // The minted token flows to the DEVICE via poll, never to the approver.
    if (url.pathname.startsWith("/api/pair/")) {
      const body = await request.json().catch(() => ({}));
      try {
        if (url.pathname === "/api/pair/start" && request.method === "POST") {
          return json(await wsCall(env, "ws.pair.start", { device: String(body.device ?? "device") }));
        }
        if (url.pathname === "/api/pair/poll" && request.method === "POST") {
          return json(await wsCall(env, "ws.pair.poll", { code: String(body.code ?? "") }));
        }
        if (url.pathname === "/api/pair/get" && request.method === "POST") {
          const auth = await checkAuth(request, env);
          if (auth instanceof Response) return auth;
          return json(await wsCall(env, "ws.pair.get", { code: String(body.code ?? "") }));
        }
        if (url.pathname === "/api/pair/approve" && request.method === "POST") {
          const auth = await checkAuth(request, env);
          if (auth instanceof Response) return auth;
          const out = await wsCall(env, "ws.pair.approve", {
            code: String(body.code ?? ""),
            ws: String(body.ws ?? ""),
            label: String(body.label ?? ""),
            tags: Array.isArray(body.tags) ? body.tags.slice(0, 10).map(String) : [],
            login: auth.login ? auth.login.toLowerCase() : "",
          });
          return json(out);
        }
        return new Response("not found", { status: 404 });
      } catch (e) {
        return json({ error: String((e).message ?? e) }, 400);
      }
    }

    const auth = await checkAuth(request, env);
    if (auth instanceof Response) return auth; // login page / 401 / 403 / 503 Response

    if (url.pathname === "/logout") {
      // Access mode: send the browser to the IdP logout too, or Access re-mints on next nav.
      const loc = env.CF_ACCESS_TEAM && env.CF_ACCESS_AUD
        ? `${env.CF_ACCESS_TEAM}/cdn-cgi/access/logout`
        : "/";
      return new Response(null, {
        status: 302,
        headers: {
          "Set-Cookie": `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
          "Location": loc,
        },
      });
    }

    // Human plane session probe: who is signed in (widget + tests).
    if (url.pathname === "/api/session") return handleSession(request, env);

    // Workspaces (human plane): list / create / switch. The registry lives in
    // the default KB DO; create/switch are membership-checked server-side.
    if (url.pathname === "/api/workspaces" || url.pathname === "/api/workspaces/switch") {
      const l = auth.login.toLowerCase();
      if (request.method === "GET") {
        const home = await wsHome(env, l);
        const { workspaces } = await wsCall(env, "ws.list", { login: l });
        return json({ workspaces, current: auth.ws, home });
      }
      if (request.method !== "POST") return json({ error: "GET or POST only" }, 405);
      const body = await request.json().catch(() => ({}));
      if (url.pathname === "/api/workspaces") {
        // create: caller becomes owner + first member (DO-side checks)
        const out = await wsCall(env, "ws.create", { slug: String(body.slug ?? "").trim().toLowerCase(), login: l });
        return json(out);
      }
      // switch: verify membership, then re-mint the signed cookie for the target ws
      const ws = String(body.ws ?? "").trim().toLowerCase();
      const { workspaces } = await wsCall(env, "ws.list", { login: l });
      if (!workspaces.some((w) => w.slug === ws && w.member)) {
        return json({ error: `not a member of workspace '${ws}'` }, 403);
      }
      const exp = String(Date.now() + SESSION_TTL_MS);
      const sig = await sign(`${exp}.${auth.login}.${ws}`, env.GITHUB_CLIENT_SECRET);
      return new Response(null, {
        status: 204,
        headers: {
          "Set-Cookie": `${SESSION_COOKIE}=${exp}.${auth.login}.${ws}.${sig}; Max-Age=${SESSION_TTL_MS / 1000}; Path=/; HttpOnly; Secure; SameSite=Lax`,
          "Cache-Control": "no-store",
        },
      });
    }

    const hub = env.HUB.get(env.HUB.idFromName(doWs(auth.ws)));
    if (url.pathname === "/ws") return hub.fetch("https://hub/ws", request);
    if (url.pathname === "/api/state") return hub.fetch("https://hub/state", request);
    if (url.pathname === "/") return hub.fetch("https://hub/ui", request);
    return new Response("not found", { status: 404 });
  },
};

async function handleIngest(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || token !== (env.BRIDGE_INGEST_TOKEN ?? env.FLOWS_INGEST_TOKEN)) return json({ error: "unauthorized" }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }

  const events = Array.isArray(body.events) ? body.events : [body];
  if (events.length > 1000) return json({ error: "batch too large" }, 413);

  // shared ingest token is a machine-plane identity in the default workspace
  const id = env.HUB.idFromName(doWs(DEFAULT_WS_SLUG));
  const hub = env.HUB.get(id);
  // forward a real request body — spreading a Request loses everything (prototype accessors)
  return hub.fetch("https://hub/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events }),
  });
}

// --- auth: GitHub OAuth session cookie, optional Access JWT at the edge ---
// Workspace scoping: every human + agent token lives in exactly one workspace.
// Legacy data (pre-workspaces) sits in the "global" DO, which is the default
// workspace's storage — no migration needed.
// --- workspaces: dynamic, registry-backed (registry lives in the default KB DO) ---
// No static member map. On login the registry seeds the legacy membership and
// ensures a personal workspace named after the username exists; users create
// more workspaces at runtime and owners add members. Legacy bare agent tokens
// and legacy cookies map to the default workspace, where all pre-workspaces
// data lives, so no migration is needed.
const LEGACY_WS_MEMBERS = ["rayh"]; // one-time import: pre-workspaces state-vector members

function wsRegistry(env) {
  return env.KB.get(env.KB.idFromName(doWs(DEFAULT_WS_SLUG)));
}

async function wsCall(env, op, body) {
  const r = await wsRegistry(env).fetch(`https://kb/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error ?? `ws ${op} failed`);
  return out;
}

/**
 * Ensure the registry is seeded and this login's personal workspace (named
 * after their username) exists. Returns the workspace to land in: the default
 * workspace if they're a member of it, else their personal one.
 */
async function wsHome(env, login) {
  const l = login.toLowerCase();
  await wsCall(env, "ws.seed", { logins: LEGACY_WS_MEMBERS }).catch(() => {});
  const { workspaces } = await wsCall(env, "ws.list", { login: l });
  const mine = workspaces.filter((w) => w.member);
  const hasDefault = mine.some((w) => w.slug === DEFAULT_WS_SLUG);
  if (!mine.some((w) => w.slug === l)) {
    await wsCall(env, "ws.create", { slug: l, login: l }).catch(() => {}); // personal ws (idempotent)
  }
  return hasDefault ? DEFAULT_WS_SLUG : l;
}

const SESSION_COOKIE = "bridge_session";
const OAUTH_COOKIE = "bridge_oauth";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

function githubConfigured(env) {
  return !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}

async function checkAuth(request, env) {
  if (env.CF_ACCESS_TEAM && env.CF_ACCESS_AUD) {
    const a = await requireAccess(request, env);
    if (a !== true) return a;
    // TODO: map the Access email to a workspace once Access mode is in use.
    return { login: null, ws: DEFAULT_WS_SLUG };
  }
  // deploy-safety fallback: until the GitHub secrets are set, the legacy shared
  // password cookie (2-part payload) still works so the human plane never 503s
  if (!githubConfigured(env)) {
    if (!env.BRIDGE_UI_PASSWORD) {
      return json({ error: "auth not configured: set GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET (or legacy BRIDGE_UI_PASSWORD)" }, 503);
    }
    const legacy = parseLegacyPasswordCookie(request, env);
    return legacy ? { login: null, ws: DEFAULT_WS_SLUG, legacy: true } : loginResponse(request);
  }
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;\\s]+)`));
  const session = m && (await verifySession(m[1], env.GITHUB_CLIENT_SECRET));
  if (!session) return loginResponse(request);
  return session; // { login, ws }
}

/** legacy password-mode session cookie: `bridge_session=<exp>.<hmac>` signed with BRIDGE_UI_PASSWORD */
function parseLegacyPasswordCookie(request, env) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`${SESSION_COOKIE}=([^;\\s]+)`));
  if (!m) return false;
  const dot = m[1].indexOf(".");
  if (dot <= 0 || m[1].includes(".", dot + 1)) return false;
  const exp = m[1].slice(0, dot);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  // verifySession's HMAC helper; the legacy secret is the password itself
  return sign(exp, env.BRIDGE_UI_PASSWORD).then((expected) => expected === m[1].slice(dot + 1));
}

async function handleSession(request, env) {
  if (env.CF_ACCESS_TEAM && env.CF_ACCESS_AUD) {
    const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
    try {
      const { jwtVerify, createRemoteJWKSet } = await import("jose");
      const { payload } = await jwtVerify(
        jwt ?? "",
        createRemoteJWKSet(new URL(`${env.CF_ACCESS_TEAM}/cdn-cgi/access/certs`)),
        { issuer: env.CF_ACCESS_TEAM, audience: env.CF_ACCESS_AUD },
      );
      return json({ mode: "access", user: payload.email ?? null });
    } catch {
      return json({ mode: "access", user: null });
    }
  }
  if (!githubConfigured(env)) {
    const legacy = await parseLegacyPasswordCookie(request, env);
    if (!legacy) return json({ mode: "password", user: null, workspace: DEFAULT_WS_SLUG });
    const m = (request.headers.get("Cookie") || "").match(new RegExp(`${SESSION_COOKIE}=([^;\\s]+)`));
    return json({ mode: "password", user: null, workspace: DEFAULT_WS_SLUG, expires_ts: Number(m[1].slice(0, m[1].indexOf("."))) });
  }
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;\\s]+)`));
  const session = m && (await verifySession(m[1], env.GITHUB_CLIENT_SECRET));
  if (!session) return json({ mode: "github", user: null });
  const dot = m[1].indexOf(".");
  return json({ mode: "github", user: session.login, workspace: session.ws, expires_ts: Number(m[1].slice(0, dot)) });
}

function loginResponse(request) {
  const wantsHtml = (request.headers.get("Accept") || "").includes("text/html");
  if (wantsHtml) {
    return new Response(null, {
      status: 302,
      headers: { Location: "/login", "Cache-Control": "no-store" },
    });
  }
  return json({ error: "unauthorized: sign in via GET /login (github oauth)" }, 401);
}

function startGithubLogin(env, state) {
  const redirect = new URL("https://github.com/login/oauth/authorize");
  redirect.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  redirect.searchParams.set("state", state);
  redirect.searchParams.set("scope", "read:user");
  return new Response(null, {
    status: 302,
    headers: {
      Location: String(redirect),
      "Set-Cookie": `${OAUTH_COOKIE}=${state}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`,
      "Cache-Control": "no-store",
    },
  });
}

function handleGithubLogin(request, env) {
  if (!githubConfigured(env)) {
    return json({ error: "auth not configured: set GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET" }, 503);
  }
  const state = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  return startGithubLogin(env, state);
}

function oauthFailure(origin, reason = "unknown") {
  const headers = new Headers({ Location: `${origin}/?login=failed&reason=${reason}`, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", `${OAUTH_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`);
  return new Response(null, { status: 302, headers });
}

async function handleGithubCallback(request, env) {
  if (!githubConfigured(env)) return json({ error: "auth not configured" }, 503);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`${OAUTH_COOKIE}=([^;\\s]+)`));
  if (!code || !state || !m || m[1] !== state) return oauthFailure(url.origin, "state");

  const tokRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }),
  });
  const tok = await tokRes.json().catch(() => ({}));
  if (!tok.access_token) {
    console.error("login: token exchange failed:", tokRes.status, JSON.stringify(tok).slice(0, 200));
    return oauthFailure(url.origin, "exchange");
  }

  const uRes = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${tok.access_token}`,
      accept: "application/vnd.github+json",
      "user-agent": "bridge",
    },
  });
  const u = await uRes.json().catch(() => ({}));
  if (!u.login) return oauthFailure(url.origin, "github_user");

  // GitHub user allowlist — GITHUB_ALLOWED_USERS secret. Default is DENY:
  // unless the secret exists, no GitHub login may sign in at all. Values:
  //   "*"              any GitHub account may sign in (fully open mode)
  //   "rayh,alice"     comma-separated allowlist (case-insensitive)
  // An empty/unset secret = nobody gets in. This is the access gate for the
  // whole hub; workspace scoping (WORKSPACE_MEMBERS) is a second, finer gate.
  const allowed = (env.GITHUB_ALLOWED_USERS ?? "").trim();
  if (!allowed) {
    console.error("login: refused — GITHUB_ALLOWED_USERS is not set (default deny)");
    return oauthFailure(url.origin, "not_allowed");
  }
  if (allowed !== "*") {
    const list = allowed.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!list.includes(u.login.toLowerCase())) {
      console.error(`login: refused — ${u.login} not in GITHUB_ALLOWED_USERS`);
      return oauthFailure(url.origin, "not_allowed");
    }
  }

  // workspace resolution is dynamic: seed the registry, ensure the login's
  // personal workspace exists, land in the default ws if they're a member
  let ws;
  try {
    ws = await wsHome(env, u.login);
  } catch (e) {
    console.error("login: workspace resolution failed:", String(e));
    return oauthFailure(url.origin, "workspace");
  }
  const exp = String(Date.now() + SESSION_TTL_MS);
  const sig = await sign(`${exp}.${u.login}.${ws}`, env.GITHUB_CLIENT_SECRET);
  const headers = new Headers({
    Location: "/",
    "Cache-Control": "no-store",
  });
  headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=${exp}.${u.login}.${ws}.${sig}; Max-Age=${SESSION_TTL_MS / 1000}; Path=/; HttpOnly; Secure; SameSite=Lax`,
  );
  headers.append("Set-Cookie", `${OAUTH_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`);
  return new Response(null, { status: 302, headers });
}

function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function sign(payload, secret) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
}

// cookie value = "<expiry_ms>.<github_login>.<workspace>.<hmac>"; legacy cookies
// (no workspace segment) map to the default workspace. Returns { login, ws } or null.
// GitHub logins are [A-Za-z0-9-] and slugs [a-z0-9-], so neither contains a dot.
async function verifySession(value, secret) {
  const i1 = value.indexOf("."), i2 = value.lastIndexOf(".");
  if (i1 <= 0 || i2 <= i1) return null;
  const exp = value.slice(0, i1), mid = value.slice(i1 + 1, i2), sig = value.slice(i2 + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return null;
  const md = mid.lastIndexOf(".");
  let login, ws, signed;
  if (md > 0) { login = mid.slice(0, md); ws = mid.slice(md + 1); signed = `${exp}.${login}.${ws}`; }
  else { login = mid; ws = DEFAULT_WS_SLUG; signed = `${exp}.${login}`; }
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) return null;
  if (!isWsSlug(ws)) return null;
  const expected = await sign(signed, secret);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? { login, ws } : null;
}

// --- optional: Cloudflare Access JWT validation (kept for when Zero Trust is on) ---
async function requireAccess(request, env) {
  const team = env.CF_ACCESS_TEAM, aud = env.CF_ACCESS_AUD;
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) return json({ error: "no access jwt" }, 403);
  try {
    const { jwtVerify, createRemoteJWKSet } = await import("jose");
    const jwks = createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`));
    await jwtVerify(jwt, jwks, { issuer: team, audience: aud });
    return true;
  } catch (e) {
    return json({ error: "invalid access jwt", detail: String(e).slice(0, 120) }, 403);
  }
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}
