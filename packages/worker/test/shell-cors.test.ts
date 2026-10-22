import { describe, expect, it } from "vitest";
import { preflightShell, shellOrigins, withShellCors } from "../src/index.js";

// BR#2514 — iOS shell CORS enablers. All additive + opt-in via SHELL_ORIGINS:
// unset means every helper is a pass-through and behaviour is pre-BR#2514.

const env = (origins?: string) => (origins === undefined ? {} : { SHELL_ORIGINS: origins });

const req = (o: { origin?: string; method?: string; acrm?: string; acrh?: string } = {}) =>
  new Request("https://hub.example/api/state", {
    method: o.method ?? "OPTIONS",
    headers: {
      ...(o.origin ? { Origin: o.origin } : {}),
      ...(o.acrm ? { "Access-Control-Request-Method": o.acrm } : {}),
      ...(o.acrh ? { "Access-Control-Request-Headers": o.acrh } : {}),
    },
  });

describe("shellOrigins", () => {
  it("parses the comma allowlist (trims, drops empties); unset = empty", () => {
    expect(shellOrigins({ SHELL_ORIGINS: " tauri://localhost , http://localhost:1421 ,," })).toEqual([
      "tauri://localhost",
      "http://localhost:1421",
    ]);
    expect(shellOrigins({})).toEqual([]);
    expect(shellOrigins({ SHELL_ORIGINS: "" })).toEqual([]);
  });
});

describe("preflightShell", () => {
  it("approves allowlisted preflights: 204 + ACAO echo + credentials + x-bridge-csrf allowed", () => {
    const r = preflightShell(
      req({ origin: "tauri://localhost", acrm: "POST", acrh: "content-type, x-bridge-csrf" }),
      env("tauri://localhost"),
    );
    expect(r).toBeInstanceOf(Response);
    expect(r!.status).toBe(204);
    expect(r!.headers.get("Access-Control-Allow-Origin")).toBe("tauri://localhost");
    expect(r!.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(r!.headers.get("Access-Control-Allow-Headers")).toContain("x-bridge-csrf");
  });

  it("is a pass-through (null) when SHELL_ORIGINS is unset — pre-BR#2514 behaviour", () => {
    expect(preflightShell(req({ origin: "tauri://localhost", acrm: "POST" }), {})).toBeNull();
    expect(preflightShell(req({ origin: "https://evil.example", acrm: "POST" }), {})).toBeNull();
  });

  it("rejects non-allowlisted origins and non-preflight OPTIONS", () => {
    const e = env("tauri://localhost");
    expect(preflightShell(req({ origin: "https://evil.example", acrm: "POST" }), e)).toBeNull();
    expect(preflightShell(req({ origin: "http://tauri.localhost", acrm: "POST" }), e)).toBeNull(); // scheme-bound
    expect(preflightShell(req({ origin: "tauri://localhost" }), e)).toBeNull(); // no ACRM = not a preflight
  });
});

describe("withShellCors", () => {
  it("stamps credentialed ACAO on allowlisted responses and preserves body/status", async () => {
    const upstream = new Response('{"ok":true}', { status: 200, headers: { "Content-Type": "application/json" } });
    const out = await withShellCors(req({ origin: "tauri://localhost", method: "GET" }), env("tauri://localhost"), upstream);
    expect(out.status).toBe(200);
    expect(await out.text()).toBe('{"ok":true}');
    expect(out.headers.get("Access-Control-Allow-Origin")).toBe("tauri://localhost");
    expect(out.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(out.headers.get("Vary")).toContain("Origin");
  });

  it("passes responses through untouched when unset or origin not allowlisted", async () => {
    const upstream = new Response("plain", { status: 200 });
    const unset = await withShellCors(req({ origin: "tauri://localhost", method: "GET" }), {}, upstream);
    expect(unset.headers.get("Access-Control-Allow-Origin")).toBeNull();

    const denied = await withShellCors(req({ origin: "https://evil.example", method: "GET" }), env("tauri://localhost"), upstream);
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await denied.text()).toBe("plain");
  });

  // Routing contract (BR#2514 E2E, run 7): the auth short-circuit fires BEFORE
  // per-route withShellCors wrapping, so the 401 a shell webview sees must be
  // stamped HERE — a bare 401 is unreadable cross-origin, the UI shows a
  // network error ("hub unreachable") and the sign-in leg never arms.
  it("stamps a 401 auth short-circuit too (status + ACAO together)", async () => {
    const unauth = new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
    const out = await withShellCors(req({ origin: "tauri://localhost", method: "GET" }), env("tauri://localhost"), unauth);
    expect(out.status).toBe(401);
    expect(out.headers.get("Access-Control-Allow-Origin")).toBe("tauri://localhost");
    expect(out.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(await out.text()).toContain("unauthorized");
  });
});
