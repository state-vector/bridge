// The DO class must be exported from the entrypoint for wrangler's DO migrations.
export { FlowsHub } from "./do.js";
import { LOGIN_HTML } from "./ui.js";
import { handleMcp, KnowledgeHub } from "./mcp.ts";

export { KnowledgeHub };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/ingest") {
      return handleIngest(request, env);
    }

    // MCP: machine plane (bearer) — agents talk to the knowledge layer here.
    if (url.pathname === "/mcp") {
      return handleMcp(request, env);
    }

    // Knowledge realtime (human plane, cookie): KB event fanout.
    if (url.pathname === "/kb-ws") {
      const auth = await checkAuth(request, env);
      if (auth !== true) return auth;
      const kbId = env.KB.idFromName("global");
      return env.KB.get(kbId).fetch("https://kb/ws", request);
    }

    // Knowledge REST mirror (human plane, cookie).
    if (url.pathname.startsWith("/api/kb/") && !url.pathname.startsWith("/api/kb/admin/")) {
      const auth = await checkAuth(request, env);
      if (auth !== true) return auth;
      const kbId = env.KB.idFromName("global");
      const sub = url.pathname.slice("/api/kb/".length);
      if (request.method === "GET") {
        const kbUrl = sub === "board" ? "https://kb/board"
          : sub === "events" ? "https://kb/events"
          : sub === "artefacts" ? "https://kb/artefacts"
          : sub === "artefact" ? "https://kb/artefact"
          : sub === "search" ? "https://kb/search"
          : sub === "stats" ? "https://kb/stats"
          : sub === "bootstrap" ? "https://kb/bootstrap"
          : null;
        if (!kbUrl) return new Response("not found", { status: 404 });
        return env.KB.get(kbId).fetch(kbUrl + url.search, request);
      }
      if (request.method === "POST") {
        const op = ["create", "update", "transition", "link"].includes(sub) ? sub : null;
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
      if (auth !== true) return auth;
      const op = url.pathname.slice("/api/kb/admin/".length);
      const kbId = env.KB.idFromName("global");
      const kbHub = env.KB.get(kbId);
      const kbUrl =
        op === "tokens" && request.method === "GET" ? "https://kb/admin.list_tokens"
        : op === "tokens" ? "https://kb/admin.mint"
        : op === "tokens/revoke" ? "https://kb/admin.revoke"
        : op === "settings" && request.method === "GET" ? "https://kb/admin.settings_get"
        : op === "debug_auth" ? "https://kb/admin.debug_auth"
        : op === "settings" ? "https://kb/admin.settings_set"
        : null;
      if (!kbUrl) return new Response("not found", { status: 404 });
      return kbHub.fetch(kbUrl, {
        method: request.method === "GET" ? "POST" : "POST",
        headers: { "content-type": "application/json", "x-kb-admin": "1" },
        body: JSON.stringify(await request.json().catch(() => ({}))),
      });
    }

    // Human plane. Auth mode: Cloudflare Access JWT when CF_ACCESS_TEAM+AUD are
    // set, otherwise password login (BRIDGE_UI_PASSWORD) with an HMAC cookie.
    if (url.pathname === "/login") {
      if (request.method === "POST") return handleLogin(request, env);
      return new Response(LOGIN_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    const auth = await checkAuth(request, env);
    if (auth !== true) return auth; // login page / 401 / 403 / 503 Response

    if (url.pathname === "/logout") {
      return new Response(null, {
        status: 302,
        headers: {
          "Set-Cookie": `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
          "Location": "/",
        },
      });
    }

    const id = env.HUB.idFromName("global");
    const hub = env.HUB.get(id);
    if (url.pathname === "/ws") return hub.fetch("https://hub/ws", request);
    if (url.pathname === "/api/state") return hub.fetch("https://hub/state", request);
    if (url.pathname === "/") return hub.fetch("https://hub/ui", request);
    return new Response("not found", { status: 404 });
  },
};

async function handleIngest(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || token !== env.FLOWS_INGEST_TOKEN) return json({ error: "unauthorized" }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }

  const events = Array.isArray(body.events) ? body.events : [body];
  if (events.length > 1000) return json({ error: "batch too large" }, 413);

  const id = env.HUB.idFromName("global");
  const hub = env.HUB.get(id);
  // forward a real request body — spreading a Request loses everything (prototype accessors)
  return hub.fetch("https://hub/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events }),
  });
}

// --- auth: optional Access JWT, else password cookie session ---
const SESSION_COOKIE = "bridge_session";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

async function checkAuth(request, env) {
  if (env.CF_ACCESS_TEAM && env.CF_ACCESS_AUD) return requireAccess(request, env);
  if (!env.BRIDGE_UI_PASSWORD) {
    return json({ error: "auth not configured: set BRIDGE_UI_PASSWORD (or CF_ACCESS_TEAM+AUD)" }, 503);
  }
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;\\s]+)`));
  if (!m || !(await verifySession(m[1], env.BRIDGE_UI_PASSWORD))) {
    return loginResponse(request);
  }
  return true;
}

function loginResponse(request) {
  const wantsHtml = (request.headers.get("Accept") || "").includes("text/html");
  if (wantsHtml) {
    return new Response(LOGIN_HTML, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return json({ error: "unauthorized: POST /login {password}" }, 401);
}

async function handleLogin(request, env) {
  if (!env.BRIDGE_UI_PASSWORD) return json({ error: "auth not configured" }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const pw = String(body.password ?? "");
  const a = new TextEncoder().encode(pw), b = new TextEncoder().encode(env.BRIDGE_UI_PASSWORD);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) diff |= a[i] ^ b[i];
  if (a.length !== b.length || diff !== 0) return json({ error: "wrong password" }, 403);

  const exp = String(Date.now() + SESSION_TTL_MS);
  const cookie = `${SESSION_COOKIE}=${exp}.${await sign(exp, env.BRIDGE_UI_PASSWORD)}; Max-Age=${SESSION_TTL_MS / 1000}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  return json({ ok: true }, 200, { "Set-Cookie": cookie });
}

function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function sign(payload, secret) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
}

async function verifySession(value, secret) {
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return false;
  const exp = value.slice(0, dot), sig = value.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const expected = await sign(exp, secret);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
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
