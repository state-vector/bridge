// The DO class must be exported from the entrypoint for wrangler's DO migrations.
export { FlowsHub } from "./do.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/ingest") {
      return handleIngest(request, env);
    }
    // Everything below is human-facing → require a valid Access JWT.
    const auth = await requireAccess(request, env);
    if (auth !== true) return auth; // it's a 403 Response

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
  return hub.fetch("https://hub/ingest", { ...request, json: { events } });
}

// --- Cloudflare Access JWT validation (Cf-Access-Jwt-Assertion) ---
const KEYS_URL = () => `${ENV.CF_ACCESS_TEAM}/cdn-cgi/access/certs`;
let ENV = {};
let jwksCache = null, jwksAt = 0;

export function setEnvForTests(v) { ENV = v; }

async function requireAccess(request, env) {
  const team = env.CF_ACCESS_TEAM, aud = env.CF_ACCESS_AUD;
  if (!team || !aud) return json({ error: "access not configured" }, 503);
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) return json({ error: "no access jwt" }, 403);
  try {
    const [{ jwtVerify }, { createRemoteJWKSet }] = await Promise.all([
      import("jose"), import("jose"),
    ]);
    if (!jwksCache || Date.now() - jwksAt > 3600_000) {
      jwksCache = createRemoteJWKSet(new URL(KEYS_URL()));
      jwksAt = Date.now();
    }
    await jwtVerify(jwt, jwksCache, { issuer: team, audience: aud });
    return true;
  } catch (e) {
    return json({ error: "invalid access jwt", detail: String(e).slice(0, 120) }, 403);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
