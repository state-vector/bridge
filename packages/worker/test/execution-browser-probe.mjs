/** Optional first-hand Chrome probe: imports the real component/CSS, never an
 * approximation of its markup. Run with node from packages/worker. */
import { build } from "esbuild";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const directory = await mkdtemp(join(tmpdir(), "bridge-execution-browser-"));
const fixture = { workspace: "probe", items: [{ id: "BR#1", title: "Local dataset repair with an explicit capability requirement", project: "bridge", status: "blocked", url: "https://hub.fleetbridge.run/card/BR-1",
  handoff: { phase: "waiting", id: "local:probe", version: 1, requested_at: 1, reason: "Needs local data", action: "Repair the dataset", findings: "Remote lookup unavailable", tried: "Remote lookup", next: "Restore the checkpoint", evidence: [], approvals: [], recipient: null,
    quiescence: { kind: "runner", host: "origin", generation: 1 }, checkpoint: { repo: "https://github.com/state-vector/bridge", remote_ref: "refs/heads/bridge-checkpoints/probe/1", commit: "a".repeat(40), tree: "b".repeat(40), base: "c".repeat(40), environment: [], next: "Repair", tests: [] } },
  requirements: { tier: "large", tools: ["git"], environment: ["local dataset"] }, blockers: [{ kind: "local_pickup_required", episode_id: "local:probe", handoff_id: "local:probe", version: 1, text: "Repair the local dataset after exact checkpoint restoration" }],
  continuation_prompt: "Verify the exact published checkpoint. Do not claim or resume without explicit authorised handoff_accept.", can_accept: false, prerequisites: ["human_authorization"], accept_operation: "handoff_accept" }], next_cursor: null, interactive_agents: [{ label: "local-agent" }] };
await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
import {ExecutionAttentionCards} from ${JSON.stringify(resolve("../ui-kit/src/views/ExecutionAttention.tsx"))};
import ${JSON.stringify(resolve("../ui-kit/src/views/views.css"))};
createRoot(document.getElementById('root')).render(React.createElement(ExecutionAttentionCards,{data:${JSON.stringify(fixture)},changed:()=>{throw Error('unexpected mutation')}}));
setTimeout(()=>{ const button=[...document.querySelectorAll('button')].find(b=>b.textContent==='Authorise a local session'); button.click();
setTimeout(()=>{document.querySelectorAll('details').forEach(d=>d.open=true); window.__executionProbe={width:innerWidth,scroll:document.documentElement.scrollWidth,form:!!document.querySelector('form.execution-grant'),guarded:document.querySelector('button[type=submit]').disabled,labels:[...document.querySelectorAll('label')].map(l=>l.textContent)};},100);},100);`, resolveDir: process.cwd(), loader: "jsx" },
  bundle: true, platform: "browser", jsx: "automatic", resolveExtensions: [".mjs", ".js", ".mts", ".ts", ".jsx", ".tsx", ".json"], outfile: join(directory, "bundle.js"), logLevel: "silent" })
  .catch(async error => { await rm(directory, { recursive: true, force: true }); throw error; });
const server = createServer(async (request, response) => {
  const path = request.url === "/bundle.js" ? "bundle.js" : request.url === "/bundle.css" ? "bundle.css" : null;
  response.setHeader("Content-Type", path?.endsWith("js") ? "application/javascript" : path ? "text/css" : "text/html");
  response.end(path ? await readFile(join(directory, path)) : '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script src="/bundle.js"></script>');
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const address = server.address(); if (!address || typeof address === "string") throw Error("probe server unavailable");
const chrome = spawn(process.env.BROWSER || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${join(directory, "profile")}`, "--remote-debugging-port=0", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
let socket;
try {
  const endpoint = await new Promise((done, reject) => { let output = ""; const timeout = setTimeout(() => reject(Error("Chrome startup timed out")), 15_000); chrome.stderr.on("data", bytes => { output += String(bytes); const match = /DevTools listening on (ws:\/\/\S+)/.exec(output); if (match) { clearTimeout(timeout); done(match[1]); } }); chrome.once("error", reject); });
  socket = new WebSocket(endpoint); await new Promise(done => socket.addEventListener("open", () => done(), { once: true }));
  let sequence = 0; const pending = new Map();
  socket.addEventListener("message", event => { const value = JSON.parse(String(event.data)); const waiter = pending.get(value.id); if (!waiter) return; pending.delete(value.id); if (value.error) waiter.reject(Error(JSON.stringify(value.error))); else waiter.resolve(value.result); });
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, sessionId })); });
  for (const width of [1200, 800, 390]) {
    const target = await call("Target.createTarget", { url: "about:blank" }); const attached = await call("Target.attachToTarget", { targetId: target.targetId, flatten: true }); const session = String(attached.sessionId);
    await call("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false }, session);
    await call("Page.navigate", { url: `http://127.0.0.1:${address.port}/` }, session);
    let probe = null;
    for (let n = 0; n < 40 && !probe; n++) { await new Promise(done => setTimeout(done, 100)); const result = await call("Runtime.evaluate", { expression: "JSON.stringify(window.__executionProbe)", returnByValue: true }, session); const value = result.result?.value; if (value) probe = JSON.parse(value); }
    if (!probe || probe.width !== width || probe.scroll > width || !probe.form || !probe.guarded) throw Error(`Execution attention probe failed: ${JSON.stringify(probe)}`);
    console.log(JSON.stringify(probe)); await call("Target.closeTarget", { targetId: target.targetId });
  }
} finally { socket?.close(); chrome.kill(); server.close(); await new Promise(done => setTimeout(done, 100)); await rm(directory, { recursive: true, force: true }); }
