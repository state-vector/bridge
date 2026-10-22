import { describe, expect, it } from "vitest";
import { legacySessionOk } from "../src/index.js";

// BR#2514 — legacy password-mode session: the `exp.sig` value is accepted from
// the cookie OR as a Bearer header. The Bearer path is the iOS shell on
// self-hosted http hubs: WebKit drops Secure cookies over plain http, so the
// hub's post-login page hands the shell the session value in a redirect
// fragment and the shell sends it as a Bearer header on every hub fetch.
// The value is byte-identical to what lands in the bridge_session cookie.

const PASSWORD = "test-pass-1234";
const env = { BRIDGE_UI_PASSWORD: PASSWORD };

const mint = async (exp: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(PASSWORD), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(exp));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${exp}.${hex}`;
};

describe("legacySessionOk", () => {
  it("accepts a fresh exp.sig minted with the password", async () => {
    expect(await legacySessionOk(await mint(String(Date.now() + 60_000)), env)).toBe(true);
  });

  it("rejects expired, wrong-signed, malformed and empty values", async () => {
    expect(await legacySessionOk(await mint(String(Date.now() - 60_000)), env)).toBe(false);
    const exp = String(Date.now() + 60_000);
    expect(await legacySessionOk(`${exp}.${await mint(exp).then((v) => v.split(".")[1] + "0")}`, env)).toBe(false);
    expect(await legacySessionOk(`${exp}.${"0".repeat(64)}`, env)).toBe(false);
    expect(await legacySessionOk("garbage", env)).toBe(false);
    expect(await legacySessionOk(`${exp}.a.b`, env)).toBe(false);
    expect(await legacySessionOk("", env)).toBe(false);
    expect(await legacySessionOk(undefined as unknown as string, env)).toBe(false);
  });
});
