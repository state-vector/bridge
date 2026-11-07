/** MCP OAuth authorization server. Public clients never receive a browser session
 * or the backing agent credential. All one-shot transitions live in one DO. */
import { DEFAULT_WS_SLUG, doWs, hashAuthToken } from "./kb/core.ts";
import { consentPage, consentError, consentFailure } from "./oauth-page.ts";

type Env = { KB: DurableObjectNamespace; MCP_OAUTH: DurableObjectNamespace };
type Client = { client_id: string; client_name: string; redirect_uris: string[] };
type Authorization = { client_id: string; redirect_uri: string; resource: string; code_challenge: string; state: string };
type Grant = Authorization & { login: string; ws: string; session: string } & (
  { phase: "consent" } | { phase: "code" } | { phase: "issuing" } |
  { phase: "active"; bearer: string; token_id: string } | { phase: "revoked" }
);
type Token = { grant: string; client_id: string; resource: string };
type RefreshToken = Token & { phase: "current" | "spent" };
const SCOPE = "bridge:agent";
const ACCESS_MS = 3600_000;
const GRANT_MS = 30 * 86400_000;
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: {
  "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache",
} });
class OAuthError extends Error {
  constructor(public error: string, message: string, public status = 400) { super(message); }
}
const invalid = (message: string): never => { throw new OAuthError("invalid_request", message); };
export function oauthResource(request: Request) { return `${new URL(request.url).origin}/mcp`; }
export function oauthChallenge(request: Request, response: Response): Response {
  if (response.status !== 401) return response;
  const headers = new Headers(response.headers);
  headers.set("WWW-Authenticate", `Bearer resource_metadata="${new URL(request.url).origin}/.well-known/oauth-protected-resource/mcp"`);
  return new Response(response.body, { status: response.status, headers });
}
export async function oauthCall(env: Env, op: string, body: unknown): Promise<Response> {
  return env.MCP_OAUTH.get(env.MCP_OAUTH.idFromName("mcp-oauth")).fetch(`https://oauth/${op}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
export async function resolveOAuthBearer(env: Env, bearer: string, resource: string): Promise<string | Response> {
  if (!bearer.startsWith("boa_")) return bearer;
  const r = await oauthCall(env, "resolve", { token: bearer, resource });
  if (!r.ok) return r;
  return ((await r.json()) as { bearer: string }).bearer;
}
/** Human authentication is supplied only by the worker's cookie-only path. */
export async function handleOAuth(request: Request, env: Env,
  authenticate: () => Promise<Response | { login: string | null; ws: string }>): Promise<Response> {
  const url = new URL(request.url), origin = url.origin;
  const path = url.pathname;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: {
    "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization",
  } });
  if (path.startsWith("/.well-known/")) {
    if (request.method !== "GET") return reply({ error: "invalid_request" }, 405);
    const metadata = path === "/.well-known/oauth-authorization-server" ? {
      issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`, revocation_endpoint: `${origin}/oauth/revoke`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"], scopes_supported: [SCOPE],
    } : { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: [SCOPE], bearer_methods_supported: ["header"] };
    const r = reply(metadata); r.headers.set("Access-Control-Allow-Origin", "*"); return r;
  }
  try {
    if (path === "/oauth/authorize") {
      if (!["GET", "POST"].includes(request.method)) return reply({ error: "invalid_request" }, 405);
      const auth = await authenticate();
      if (auth instanceof Response || !auth.login) {
        if (request.method !== "GET") return consentError("Your sign-in has expired. Sign in to Bridge, then reconnect from your client.", 401);
        return new Response(null, { status: 302, headers: { Location: "/login", "cache-control": "no-store",
          "Set-Cookie": `bridge_mcp_return=${encodeURIComponent(url.pathname + url.search)}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
        } });
      }
      const session = await hashAuthToken(request.headers.get("Cookie") ?? "");
      if (request.method === "GET") {
        const r = await oauthCall(env, "consent", { ...Object.fromEntries(url.searchParams), login: auth.login, ws: auth.ws, session, resource_expected: `${origin}/mcp` });
        if (!r.ok) return consentFailure(r);
        const data = await r.json() as { id: string; client_name: string; redirect_uri: string };
        return consentPage(data, auth.ws);
      }
      if (request.headers.get("Origin") !== origin) return consentError("Bridge could not verify that this approval came from its connection page. Restart the connection from your client.", 403);
      const form = await request.formData();
      const r = await oauthCall(env, "approve", { id: form.get("id"), allow: form.get("decision") === "allow", login: auth.login, ws: auth.ws, session });
      if (!r.ok) return consentFailure(r);
      const { redirect } = await r.json() as { redirect: string };
      return new Response(null, { status: 302, headers: { Location: redirect, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
    }
    if (request.method !== "POST") return reply({ error: "invalid_request" }, 405);
    // Bounded public inputs; client metadata is display data, never fetched.
    const text = await request.text();
    if (text.length > 16_384) return reply({ error: "invalid_request" }, 413);
    let body: Record<string, unknown>;
    try { body = path === "/oauth/register" ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text)); }
    catch { return reply({ error: "invalid_request", error_description: "Malformed request body" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ error: "invalid_request" }, 400);
    const op = path === "/oauth/register" ? "register" : path === "/oauth/token" ? "token" : path === "/oauth/revoke" ? "revoke" : "unknown";
    const r = await oauthCall(env, op, { ...body, resource_expected: `${origin}/mcp`, rate_key: request.headers.get("CF-Connecting-IP") ?? "local" });
    const headers = new Headers(r.headers); headers.set("Access-Control-Allow-Origin", "*");
    return new Response(r.body, { status: r.status, headers });
  } catch {
    return path === "/oauth/authorize" ? consentError("Bridge is temporarily unavailable. Please try again in a moment.", 503)
      : reply({ error: "server_error", error_description: "Authorization service temporarily unavailable" }, 503);
  }
}

export class McpOAuth {
  constructor(private state: DurableObjectState, private env: Env) {
    state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS oauth_records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, expires INTEGER NOT NULL)`);
    state.storage.sql.exec(`CREATE INDEX IF NOT EXISTS oauth_expiry ON oauth_records(expires)`);
  }
  private get<T>(id: string): T | null {
    const row = this.state.storage.sql.exec<{ value: string }>(`SELECT value FROM oauth_records WHERE id = ? AND expires > ?`, id, Date.now()).toArray()[0];
    return row ? JSON.parse(row.value) as T : null;
  }
  private put(id: string, kind: string, value: unknown, ttl: number) {
    this.state.storage.sql.exec(`INSERT OR REPLACE INTO oauth_records VALUES (?, ?, ?, ?)`, id, kind, JSON.stringify(value), Date.now() + ttl);
  }
  private del(id: string) { this.state.storage.sql.exec(`DELETE FROM oauth_records WHERE id = ?`, id); }
  private rate(key: string, limit: number) {
    const id = `rate:${key}:${Math.floor(Date.now() / 3600_000)}`;
    const n = this.get<number>(id) ?? 0;
    if (n >= limit) throw new OAuthError("slow_down", "Too many requests; retry later", 429);
    this.put(id, "rate", n + 1, 3600_000);
  }
  private async kb(ws: string, op: string, body: unknown) {
    const r = await this.env.KB.get(this.env.KB.idFromName(doWs(ws))).fetch(`https://kb/${op}`, {
      method: "POST", headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify(body),
    });
    if (r.status >= 500) throw new Error("workspace temporarily unavailable");
    return r;
  }
  private async member(g: Grant) {
    const r = await this.kb(DEFAULT_WS_SLUG, "ws.list", { login: g.login.toLowerCase() });
    const data = await r.json() as { workspaces?: { slug: string; member: boolean }[] };
    if (!r.ok || !data.workspaces?.some(w => w.slug === g.ws && w.member)) throw new OAuthError("access_denied", "Workspace membership required", 403);
  }
  private async live(g: Grant) {
    if (g.phase !== "active") throw new OAuthError("invalid_grant", "Authorization expired or revoked");
    await this.member(g);
    const r = await this.kb(g.ws, "auth.identify", { bearer: g.bearer });
    if (!r.ok) throw new OAuthError("invalid_grant", "Agent credential revoked");
    return g;
  }
  private async revoke(id: string, g: Extract<Grant, { phase: "active" }>) {
    const { bearer: _bearer, token_id, ...authorization } = g;
    this.put(id, "grant", { ...authorization, phase: "revoked" }, GRANT_MS);
    await this.kb(g.ws, "admin.revoke", { id: token_id });
  }
  async fetch(request: Request): Promise<Response> {
    try {
      // Expired credentials and registrations cannot accumulate forever.
      this.state.storage.sql.exec(`DELETE FROM oauth_records WHERE expires <= ?`, Date.now());
      const b = await request.json() as Record<string, string>;
      const op = new URL(request.url).pathname.slice(1);
      if (op === "register") {
        this.rate(`register:${await hashAuthToken(b.rate_key)}`, 30);
        const uris: unknown = b.redirect_uris;
        if (!Array.isArray(uris) || uris.length < 1 || uris.length > 10) invalid("Supply 1–10 redirect_uris");
        for (const uri of uris as unknown[]) {
          if (typeof uri !== "string" || uri.length > 2048) invalid("Invalid redirect URI");
          let u: URL; try { u = new URL(uri as string); } catch { invalid("Invalid redirect URI"); }
          if (u!.hash || u!.username || u!.password || !(u!.protocol === "https:" || (u!.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u!.hostname)))) invalid("Redirect must use HTTPS or loopback HTTP, without fragment or credentials");
        }
        if (b.token_endpoint_auth_method && b.token_endpoint_auth_method !== "none") invalid("Only public clients (none) supported");
        const client: Client = { client_id: `boc_${random()}`, client_name: String(b.client_name || "MCP client").slice(0, 100), redirect_uris: uris as string[] };
        this.put(client.client_id, "client", client, 365 * 86400_000);
        return reply({ ...client, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }, 201);
      }
      if (op === "consent") {
        const client = this.get<Client>(b.client_id);
        if (!client || !client.redirect_uris.includes(b.redirect_uri)) invalid("Unknown client or unregistered redirect_uri");
        if (b.response_type !== "code" || b.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(b.code_challenge ?? "")) invalid("Authorization code with S256 PKCE required");
        if (b.resource && b.resource !== b.resource_expected) invalid("Invalid resource");
        if (b.scope && b.scope !== SCOPE) throw new OAuthError("invalid_scope", `Only ${SCOPE} is supported`);
        if ((b.state?.length ?? 0) > 2048) invalid("state too long");
        const g: Grant = { phase: "consent", client_id: b.client_id, redirect_uri: b.redirect_uri, resource: b.resource_expected, code_challenge: b.code_challenge, state: b.state ?? "", login: b.login, ws: b.ws, session: b.session };
        await this.member(g);
        this.rate(`consent:${g.login}`, 60);
        const id = `consent_${random()}`;
        this.put(id, "consent", g, 600_000);
        return reply({ id, client_name: client!.client_name, redirect_uri: g.redirect_uri });
      }
      if (op === "approve") {
        const g = this.get<Grant>(b.id);
        if (!g || g.phase !== "consent" || g.login !== b.login || g.ws !== b.ws || g.session !== b.session) invalid("Invalid or expired consent");
        await this.member(g!);
        // No await between consuming consent and publishing its one code.
        if (!this.get(b.id)) invalid("Consent already used");
        this.del(b.id);
        const redirect = new URL(g!.redirect_uri);
        if (g!.state) redirect.searchParams.set("state", g!.state);
        if (b.allow) {
          const code = `code_${random()}`;
          this.put(await hashAuthToken(code), "code", { ...g!, phase: "code" }, 120_000);
          redirect.searchParams.set("code", code);
          redirect.searchParams.set("iss", new URL(g!.resource).origin);
        } else redirect.searchParams.set("error", "access_denied");
        return reply({ redirect: redirect.href });
      }
      if (op === "token") {
        if (b.client_secret) throw new OAuthError("invalid_client", "Public clients must not send a secret");
        if (b.grant_type === "authorization_code") {
          if (!/^[A-Za-z0-9._~-]{43,128}$/.test(b.code_verifier ?? "")) throw new OAuthError("invalid_grant", "Invalid PKCE verifier");
          const hash = await hashAuthToken(b.code ?? "");
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(b.code_verifier));
          const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
          const g = this.get<Grant>(hash);
          if (!g || g.phase !== "code" || g.client_id !== b.client_id || g.redirect_uri !== b.redirect_uri || g.code_challenge !== challenge || g.resource !== b.resource_expected || (b.resource && b.resource !== g.resource)) throw new OAuthError("invalid_grant", "Invalid authorization code or binding");
          this.del(hash); // consume BEFORE external mint: never repeat an unknown mint
          await this.member(g);
          const id = `grant_${random()}`;
          this.put(id, "grant", { ...g, phase: "issuing" }, GRANT_MS);
          const client = this.get<Client>(g.client_id);
          const slug = (client?.client_name ?? "mcp").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 24);
          const label = `_direct/${slug}-${random().slice(0, 16)}`;
          const r = await this.kb(g.ws, "admin.mint", { label, tags: ["interactive", "oauth"] });
          const minted = await r.json() as { id: string; secret: string };
          if (!r.ok || !minted.secret) throw new Error("Agent allocation failed");
          this.put(id, "grant", { ...g, phase: "active", bearer: minted.secret, token_id: minted.id }, GRANT_MS);
          return this.tokens(id, g);
        }
        if (b.grant_type === "refresh_token") {
          if (!b.refresh_token?.startsWith("bor_")) throw new OAuthError("invalid_grant", "Invalid refresh token");
          const hash = await hashAuthToken(b.refresh_token ?? "");
          const t = this.get<RefreshToken>(hash);
          if (!t || t.client_id !== b.client_id || t.resource !== b.resource_expected || (b.resource && b.resource !== t.resource)) throw new OAuthError("invalid_grant", "Invalid refresh token or binding");
          const g = this.get<Grant>(t.grant);
          if (!g) throw new OAuthError("invalid_grant", "Authorization expired");
          if (t.phase === "spent") {
            if (g.phase === "active") await this.revoke(t.grant, g);
            throw new OAuthError("invalid_grant", "Refresh token reuse detected; authorize again");
          }
          await this.live(g);
          const latest = this.get<RefreshToken>(hash);
          if (!latest || latest.phase !== "current") {
            if (g.phase === "active") await this.revoke(t.grant, g);
            throw new OAuthError("invalid_grant", "Refresh token reuse detected; authorize again");
          }
          this.put(hash, "refresh", { ...t, phase: "spent" }, GRANT_MS);
          return this.tokens(t.grant, g);
        }
        throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token");
      }
      if (op === "resolve" || op === "revoke") {
        if (!/^bo[ar]_/.test(b.token ?? "")) return op === "revoke" ? reply({}) : reply({ error: "invalid_token" }, 401);
        const t = this.get<Token>(await hashAuthToken(b.token ?? ""));
        if (!t) return op === "revoke" ? reply({}) : reply({ error: "invalid_token" }, 401);
        if (op === "revoke" && t.client_id !== b.client_id) return reply({});
        const g = this.get<Grant>(t.grant);
        if (!g || g.phase !== "active") return op === "revoke" ? reply({}) : reply({ error: "invalid_token" }, 401);
        if (op === "revoke") {
          await this.revoke(t.grant, g);
          return reply({});
        }
        if (b.resource !== t.resource || !b.token.startsWith("boa_")) return reply({ error: "invalid_token" }, 401);
        try { await this.live(g); } catch (e) { if (e instanceof OAuthError) return reply({ error: "invalid_token" }, 401); throw e; }
        return reply({ bearer: g.bearer });
      }
      return reply({ error: "invalid_request" }, 404);
    } catch (e) {
      if (e instanceof OAuthError) return reply({ error: e.error, error_description: e.message }, e.status);
      return reply({ error: "server_error", error_description: "Authorization service temporarily unavailable" }, 503);
    }
  }
  private async tokens(id: string, g: Grant) {
    const access = `boa_${random()}`, refresh = `bor_${random()}`;
    const t: Token = { grant: id, client_id: g.client_id, resource: g.resource };
    this.put(await hashAuthToken(access), "access", t, ACCESS_MS);
    this.put(await hashAuthToken(refresh), "refresh", { ...t, phase: "current" }, GRANT_MS);
    return reply({ access_token: access, token_type: "Bearer", expires_in: ACCESS_MS / 1000, refresh_token: refresh, scope: SCOPE });
  }
}
