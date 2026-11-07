import { Miniflare } from "miniflare";
import { realpathSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let mf: Miniflare;
let kb: (op: string, body: unknown) => Promise<any>;
const origin = "https://hub.test";
const secret = "test-github-secret";
const verifier = "v".repeat(64);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const redirect = "http://localhost:1455/auth/callback";
function cookie(login = "rayh", ws = "state-vector") {
  const payload = `${Date.now() + 3600_000}.${login}.${ws}`;
  return `bridge_session=${payload}.${createHmac("sha256", secret).update(payload).digest("hex")}`;
}
const humanCookie = cookie();
async function fetchPath(path: string, init?: Parameters<Miniflare["dispatchFetch"]>[1]) { return mf.dispatchFetch(origin + path, { redirect: "manual", ...init }); }
async function form(path: string, body: Record<string, string>) {
  return fetchPath(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
}
async function register(name = "Codex") {
  const r = await fetchPath("/oauth/register", { method: "POST", body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: "none" }) });
  expect(r.status).toBe(201);
  return (await r.json() as any).client_id as string;
}
function authorizeUrl(client: string, overrides: Record<string, string> = {}) {
  return "/oauth/authorize?" + new URLSearchParams({ client_id: client, redirect_uri: redirect, response_type: "code", code_challenge_method: "S256", code_challenge: challenge, resource: `${origin}/mcp`, state: "client-state", ...overrides });
}
async function consent(client: string) {
  const r = await fetchPath(authorizeUrl(client), { headers: { Cookie: humanCookie } });
  expect(r.status).toBe(200);
  const html = await r.text();
  return html.match(/name="id" value="([^"]+)"/)![1];
}
async function approve(id: string, allow = true, headers: Record<string, string> = {}) {
  return fetchPath("/oauth/authorize", { method: "POST", headers: { Cookie: humanCookie, Origin: origin, "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams({ id, decision: allow ? "allow" : "deny" }).toString() });
}
async function code(client: string) {
  const r = await approve(await consent(client));
  expect(r.status).toBe(302);
  const u = new URL(r.headers.get("Location")!);
  expect(u.origin + u.pathname).toBe(redirect);
  expect(u.searchParams.get("state")).toBe("client-state");
  expect(u.searchParams.get("iss")).toBe(origin);
  return u.searchParams.get("code")!;
}
function exchange(client: string, code: string, overrides: Record<string, string> = {}) {
  return form("/oauth/token", { grant_type: "authorization_code", client_id: client, code, redirect_uri: redirect, code_verifier: verifier, resource: `${origin}/mcp`, ...overrides });
}
function refresh(client: string, token: string) {
  return form("/oauth/token", { grant_type: "refresh_token", client_id: client, refresh_token: token, resource: `${origin}/mcp` });
}
async function rpc(token: string, method = "ping", params?: unknown) {
  return fetchPath("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
}
beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  mf = new Miniflare({ workers: [{ name: "main", scriptPath: bundle, modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")), modules: true, compatibilityDate: "2025-09-06", durableObjects: {
    HUB: { className: "FlowsHub", useSQLite: true }, KB: { className: "KnowledgeHub", useSQLite: true }, MCP_OAUTH: { className: "McpOAuth", useSQLite: true },
  }, bindings: { GITHUB_CLIENT_ID: "test", GITHUB_CLIENT_SECRET: secret } }] });
  const ns = await mf.getDurableObjectNamespace("KB");
  // Miniflare's Node proxy exposes fetch at runtime; its RPC type maps this
  // worker-types version to a function instead of the Fetcher interface.
  const stub = await ns.get(ns.idFromName("global")) as unknown as Fetcher;
  kb = async (op, body) => {
    const r = await stub.fetch(`https://kb/${op}`, { method: "POST", headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify(body) });
    return r.json();
  };
  await kb("ws.seed", { logins: ["rayh"] });
});
afterAll(async () => { await mf?.dispose(); });

describe("MCP OAuth over the real worker and SQLite", () => {
  it("discovers authorization without a token on GET or POST /mcp", async () => {
    for (const method of ["GET", "POST"]) {
      const r = await fetchPath("/mcp", { method });
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toContain(`${origin}/.well-known/oauth-protected-resource/mcp`);
    }
    const resource = await (await fetchPath("/.well-known/oauth-protected-resource/mcp")).json() as any;
    expect(resource.resource).toBe(`${origin}/mcp`);
    const auth = await (await fetchPath("/.well-known/oauth-authorization-server")).json() as any;
    expect(auth.code_challenge_methods_supported).toEqual(["S256"]);
    expect(auth.registration_endpoint).toBe(`${origin}/oauth/register`);
  });
  it("rejects unsafe redirects and preserves the login return path", async () => {
    for (const uri of ["http://evil.test/cb", "https://example.com/cb#fragment", "https://user:pass@example.com/cb", "file:///tmp/cb"]) {
      const r = await fetchPath("/oauth/register", { method: "POST", body: JSON.stringify({ redirect_uris: [uri] }) });
      expect(r.status).toBe(400);
    }
    const client = await register();
    const r = await fetchPath(authorizeUrl(client));
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/login");
    expect(r.headers.get("set-cookie")).toContain("bridge_mcp_return=");
    for (const changes of [{ redirect_uri: "https://evil.test" }, { code_challenge_method: "plain" }, { resource: "https://other/mcp" }, { scope: "admin" }]) {
      const bad = await fetchPath(authorizeUrl(client, changes), { headers: { Cookie: humanCookie } });
      expect(bad.status).toBe(400);
      expect(bad.headers.get("location")).toBeNull();
    }
  });
  it("requires cookie-bound same-origin consent and handles denial without allocating an agent", async () => {
    const client = await register(), id = await consent(client);
    for (const attacker of ["https://attacker.test", "null", ""]) {
      const rejected = await approve(id, true, { Origin: attacker });
      expect(rejected.status).toBe(403);
      expect(rejected.headers.get("content-type")).toContain("text/html");
      expect(await rejected.text()).toContain("Restart the connection from your client");
    }
    expect((await approve(id, true, { Cookie: cookie("other-user") })).status).toBe(400);
    const denied = await approve(id, false);
    expect(new URL(denied.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
    expect((await approve(id)).status).toBe(400);
  });
  it("serves styled consent without suppressing the browser form Origin and renders readable errors", async () => {
    const client = await register('<script>alert("client")</script>');
    const page = await fetchPath(authorizeUrl(client), { headers: { Cookie: humanCookie } });
    expect(page.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    const html = await page.text();
    const nonce = html.match(/<style nonce="([^"]+)"/)![1];
    expect(page.headers.get("content-security-policy")).toContain(`style-src 'nonce-${nonce}'`);
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self' http://localhost:1455;");
    expect(html).toContain('name="viewport"');
    expect(html).toContain("&lt;script&gt;alert(&quot;client&quot;)&lt;/script&gt;");
    expect(html).not.toContain('<script>alert("client")</script>');
    const expired = await approve("consent_expired");
    expect(expired.status).toBe(400);
    expect(expired.headers.get("content-type")).toContain("text/html");
    expect(await expired.text()).toContain("Connection not completed");
  });
  it("binds codes to client, redirect, PKCE and resource, then consumes once under concurrency", async () => {
    const client = await register(), c = await code(client), other = await register();
    for (const changes of [{ client_id: other }, { redirect_uri: "http://localhost:1555/auth/callback" }, { code_verifier: "x".repeat(64) }, { resource: "https://other/mcp" }]) {
      expect((await exchange(client, c, changes)).status).toBe(400);
    }
    const responses = await Promise.all([exchange(client, c), exchange(client, c)]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 400]);
    const tokens = await responses.find(r => r.status === 200)!.json() as any;
    expect(tokens.access_token).toMatch(/^boa_/);
    expect(tokens.refresh_token).toMatch(/^bor_/);
    expect((await rpc(tokens.access_token)).status).toBe(200);
    expect((await refresh(client, tokens.access_token)).status).toBe(400);
    expect((await rpc(tokens.refresh_token)).status).toBe(401);
    const tool = await rpc(tokens.access_token, "tools/call", { name: "orient", arguments: { session: "oauth-codex-test" } });
    expect(tool.status).toBe(200);
    const roster = await kb("admin.list_tokens", {});
    const agents = roster.tokens ?? roster;
    expect(JSON.stringify(agents)).toContain("_direct/codex-");
    expect(JSON.stringify(agents)).toContain("interactive");
    const task = await kb("create", { actor: "test", type: "task", title: "OAuth interactive claim", project: "bridge", qualified: true, meta: { execution_requirements: { tier: "large" } } });
    const claimed = await (await rpc(tokens.access_token, "tools/call", { name: "transition", arguments: { id: task.id, to: "in_progress", session: "oauth-codex-test", note: "Human-directed interactive client supplies its own configured model and resolves the automation capability wait" } })).json() as any;
    expect(claimed.result?.isError, JSON.stringify(claimed)).toBeFalsy();
    const card = await kb("get", { id: task.id });
    expect(card.execution.current).toMatchObject({ kind: "interactive", session: "oauth-codex-test" });
    const decision = await kb("create", { actor: "test", type: "decision", title: "Human-only approval" });
    const accepted = await (await rpc(tokens.access_token, "tools/call", { name: "transition", arguments: { id: decision.id, to: "accepted", session: "oauth-codex-test" } })).json() as any;
    expect(accepted.result?.isError).toBe(true);
    const rotated = await refresh(client, tokens.refresh_token);
    expect(rotated.status).toBe(200);
    const next = await rotated.json() as any;
    expect((await fetchPath("/api/kb-machine/act", { method: "POST", headers: { Authorization: `Bearer ${next.access_token}` }, body: JSON.stringify({ op: "transition", to: "accepted" }) })).status).toBe(403);
    expect((await form("/oauth/revoke", { client_id: other, token: next.refresh_token })).status).toBe(200);
    expect((await rpc(next.access_token)).status).toBe(200);
    expect((await form("/oauth/revoke", { client_id: client, token: next.refresh_token })).status).toBe(200);
    expect((await rpc(tokens.access_token)).status).toBe(401);
    expect((await rpc(next.access_token)).status).toBe(401);
    expect((await refresh(client, next.refresh_token)).status).toBe(400);
  });
  it("detects refresh replay and revokes the whole grant, including a concurrent winner", async () => {
    const client = await register(), tokens = await (await exchange(client, await code(client))).json() as any;
    const rotated = await Promise.all([refresh(client, tokens.refresh_token), refresh(client, tokens.refresh_token)]);
    expect(rotated.map(r => r.status).sort()).toEqual([200, 400]);
    const next = await rotated.find(r => r.status === 200)!.json() as any;
    expect((await rpc(next.access_token)).status).toBe(401);
    expect((await rpc(tokens.access_token)).status).toBe(401);
    expect((await refresh(client, next.refresh_token)).status).toBe(400);
  });
  it("honours live credential revocation and workspace removal", async () => {
    const client = await register("Revocable");
    const tokens = await (await exchange(client, await code(client))).json() as any;
    const roster = await kb("admin.list_tokens", {});
    const agent = roster.tokens.find((t: any) => t.label.startsWith("_direct/revocable-"));
    await kb("admin.revoke", { id: agent.id });
    expect((await rpc(tokens.access_token)).status).toBe(401);
    expect((await refresh(client, tokens.refresh_token)).status).toBe(400);
    const fresh = await (await exchange(client, await code(client))).json() as any;
    await kb("ws.join", { ws: "state-vector", login: "rayh", member: "alice" });
    const aliceCookie = cookie("alice");
    const auth = await fetchPath(authorizeUrl(client), { headers: { Cookie: aliceCookie } });
    expect(auth.status).toBe(200);
    const id = (await auth.text()).match(/name="id" value="([^"]+)"/)![1];
    const approved = await approve(id, true, { Cookie: aliceCookie });
    const aliceCode = new URL(approved.headers.get("location")!).searchParams.get("code")!;
    const aliceTokens = await (await exchange(client, aliceCode)).json() as any;
    expect((await rpc(aliceTokens.access_token)).status).toBe(200);
    await kb("ws.remove", { ws: "state-vector", login: "rayh", member: "alice" });
    const removed = await fetchPath(authorizeUrl(client), { headers: { Cookie: cookie("alice") } });
    expect(removed.status).toBe(403);
    expect((await rpc(aliceTokens.access_token)).status).toBe(401);
    expect((await refresh(client, aliceTokens.refresh_token)).status).toBe(403);
    expect((await rpc(fresh.access_token)).status).toBe(200);
  });
});
