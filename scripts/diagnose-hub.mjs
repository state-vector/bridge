#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/** Wrangler emits pretty-printed consecutive JSON values, not JSON lines. */
export class JsonEvents {
  buffer = "";
  constructor(receive) { this.receive = receive; }
  push(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 2_000_000) throw new Error("Tail event exceeds the bounded parser budget");
    let start = this.buffer.indexOf("{");
    while (start >= 0) {
      let depth = 0, quoted = false, escaped = false, end = -1;
      for (let i = start; i < this.buffer.length; i++) {
        const c = this.buffer[i];
        if (quoted) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; }
        else if (c === '"') quoted = true;
        else if (c === "{") depth++;
        else if (c === "}" && --depth === 0) { end = i + 1; break; }
      }
      if (end < 0) { this.buffer = this.buffer.slice(start); return; }
      this.receive(JSON.parse(this.buffer.slice(start, end)));
      this.buffer = this.buffer.slice(end); start = this.buffer.indexOf("{");
    }
    if (this.buffer.length > 4096) this.buffer = "";
  }
}

const number = value => Number.isFinite(value) ? Math.max(0, value) : 0;
const operation = value => typeof value === "string" && /^[a-z][a-z._]{0,63}$/.test(value) && !value.startsWith("bkw_") ? value : "unknown";
export function observation(event) {
  const request = event.event?.request;
  let path = "internal";
  try { path = new URL(request?.url).pathname.replace(/bkw_[\w-]+/g, "[redacted]"); } catch { /* alarm/RPC */ }
  const stages = [];
  for (const entry of event.logs ?? []) for (const message of entry.message ?? []) {
    let log;
    try { log = typeof message === "string" ? JSON.parse(message) : message; } catch { continue; }
    if (log?.type === "bridge.request") stages.push({ operation: operation(log.operation), elapsed_ms: number(log.elapsed_ms), ingress_ms: number(log.ingress_ms),
      status: number(log.status), stages: (log.stages ?? []).map(s => ({ stage: operation(s.stage), elapsed_ms: number(s.elapsed_ms) })) });
  }
  // Select known fields only. Never emit headers, request bodies, query strings,
  // exception text, arbitrary logs or complete raw tail events.
  return { route: `${request?.method ?? "internal"} ${path}`, status: number(event.event?.response?.status),
    outcome: ["ok", "canceled", "exception", "exceededCpu", "exceededMemory", "unknown"].includes(event.outcome) ? event.outcome : "unknown",
    wall_ms: number(event.wallTime), cpu_ms: number(event.cpuTime), stages };
}
export function summarize(samples, started_at, finished_at) {
  const groups = new Map();
  for (const s of samples) {
    const group = groups.get(s.route) ?? { route: s.route, requests: 0, failed: 0, canceled: 0, wall: [], cpu: 0 };
    group.requests++; group.failed += Number(s.status >= 500 || !["ok", "canceled"].includes(s.outcome)); group.canceled += Number(s.outcome === "canceled");
    group.wall.push(s.wall_ms); group.cpu += s.cpu_ms; groups.set(s.route, group);
  }
  return { started_at, finished_at, requests: samples.length, routes: [...groups.values()].map(g => {
    g.wall.sort((a, b) => a - b);
    return { route: g.route, requests: g.requests, failed: g.failed, canceled: g.canceled,
      p50_ms: g.wall[Math.floor((g.wall.length - 1) * .5)], p95_ms: g.wall[Math.ceil((g.wall.length - 1) * .95)],
      max_ms: g.wall.at(-1), edge_cpu_ms: g.cpu };
  }).sort((a, b) => b.max_ms - a.max_ms), slow_hub_requests: samples.flatMap(s => s.stages).sort((a, b) => b.elapsed_ms - a.elapsed_ms).slice(0, 30) };
}

async function main() {
  const args = process.argv.slice(2), secondsAt = args.indexOf("--seconds");
  const seconds = secondsAt < 0 ? 45 : Number(args[secondsAt + 1]);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 300) throw new Error("--seconds must be between 1 and 300");
  const started_at = Date.now(), samples = [];
  let omitted = 0, parseError;
  const worker = fileURLToPath(new URL("../packages/worker", import.meta.url));
  const tail = spawn("npx", ["--no-install", "wrangler", "tail", "bridge", "--format", "json"], { cwd: worker, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  const parser = new JsonEvents(event => { if (samples.length < 10000) samples.push(observation(event)); else omitted++; });
  tail.stdout.setEncoding("utf8"); tail.stdout.on("data", chunk => { try { parser.push(chunk); } catch (error) { parseError = error; stop(); } });
  let error = "";
  tail.stderr.on("data", chunk => { error = (error + chunk).slice(-4096); });
  const stop = () => { try { if (process.platform === "win32") tail.kill(); else process.kill(-tail.pid, "SIGTERM"); } catch { /* already exited */ } };
  const timer = setTimeout(stop, seconds * 1000);
  process.once("SIGINT", stop);
  const code = await new Promise((accept, reject) => { tail.once("error", reject); tail.once("exit", accept); });
  clearTimeout(timer); process.removeListener("SIGINT", stop);
  if (parseError) throw parseError;
  if (code && !samples.length) throw new Error(`Tail failed (exit ${code}). Check wrangler whoami and workers_tail permission.`);
  if (!samples.length && error) process.stderr.write("No requests captured. Check the Cloudflare tail connection and selected worker.\n");
  const report = summarize(samples, started_at, Date.now());
  report.omitted = omitted;
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Hub traffic: ${report.requests} requests in ${Math.round((report.finished_at - started_at) / 1000)}s`);
    console.table(report.routes);
    if (report.slow_hub_requests.length) console.log("Slow hub stages:", JSON.stringify(report.slow_hub_requests, null, 2));
    console.log("Wall time includes upstream/queue waits; edge CPU alone does not identify the cause. No credentials or payloads are captured.");
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
