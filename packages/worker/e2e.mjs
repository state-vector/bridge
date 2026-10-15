/** Full KB e2e against `wrangler dev` on :8799 (.dev.vars: BRIDGE_UI_PASSWORD, FLOWS_INGEST_TOKEN). Run: node e2e.mjs */
import WebSocket from "ws";
const base = "http://127.0.0.1:8799";
let cookie = "", id = 0;
const checks = {};
const j = async (path, opts = {}) => {
  const r = await fetch(base + path, { ...opts, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
async function rpc(method, params, token) {
  const r = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  return r.json();
}
const tool = async (token, name, args) => {
  const r = await rpc("tools/call", { name, arguments: args }, token);
  const text = r.result?.content?.[0]?.text;
  if (r.error) console.log(`  [rpc error ${name}]`, JSON.stringify(r.error));
  const json = (() => { try { return JSON.parse(text); } catch { return null; } })();
  if (r.result?.isError) console.log(`  [tool error ${name}]`, text);
  return { isError: r.result?.isError === true || !!r.error, text, json };
};
const uid = Math.random().toString(36).slice(2, 6);
const login = await fetch(base + "/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: process.env.BRIDGE_UI_PASSWORD ?? "testpass" }) });
cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
checks["admin login"] = login.ok;
const mintA = await j("/api/kb/admin/tokens", { method: "POST", body: JSON.stringify({ label: `oc-${uid}`, tags: ["datadog-access"], transport: "mcp" }) });
const A = mintA.body.secret;
const mintB = await j("/api/kb/admin/tokens", { method: "POST", body: JSON.stringify({ label: `acp-${uid}`, transport: "acp-proxy" }) });
const B = mintB.body.secret;
checks["mint with transport"] = mintA.status === 200 && mintB.body.transport === "acp-proxy";
console.log("mintA:", mintA.status, JSON.stringify(mintA.body).slice(0,150));
console.log("mintB:", mintB.status);
await j("/api/kb/admin/settings", { method: "POST", body: JSON.stringify({ settings: {
  project_name: "Superpositional", board: { mode: "external", kind: "github-projects", url: "https://x/p/1", prompt: "Move the task to In Progress when you start." }, review_policy: "two-reviewers" } }) });
const settingsGet = await j("/api/kb/admin/settings");
checks["settings list (custom keys)"] = settingsGet.body.settings?.review_policy === "two-reviewers";
const initA = await rpc("initialize", { protocolVersion: "2025-06-18" }, A);
checks["bootstrap: status duty + progress nudge + project"] = initA.result?.instructions?.includes("TASK STATUS IS YOUR RESPONSIBILITY") && initA.result?.instructions?.includes("log_progress") && initA.result?.instructions?.includes("Superpositional");
checks["tools = 14"] = (await rpc("tools/list", {}, A)).result?.tools?.length === 14;
const c = await tool(A, "create_artefact", { type: "task", title: `Batching impl ${uid}`, body_md: "Reduce ingestion latency with bounded batching. Preserve idempotency.", tags: ["ingestion", "performance"], session: "impl-1" });
checks["create w/ tags+session (BR# id)"] = !c.isError && /^BR#\d+$/.test(c.json?.id ?? "");
const p = await tool(A, "log_progress", { id: c.json.id, note: "batch writer drafted", sentiment: "converging" });
checks["log_progress w/ sentiment + instructions"] = !p.isError && !!p.json?.instructions;
await tool(A, "transition", { id: c.json.id, to: "in_progress" });
const s1 = await tool(A, "search_knowledge", { q: "slow ingestion" });
checks["fuzzy search (semantic+fts)"] = (s1.json?.artefacts?.length ?? 0) >= 1;
const rel = await tool(A, "related_artefacts", { id: c.json.id });
checks["related returns artefacts"] = Array.isArray(rel.json?.artefacts);
const board = await j("/api/kb/board");
const bt = board.body.tasks?.find((x) => x.id === c.json.id);
checks["board: progress + session + status_ts"] = !!bt?.meta?.last_progress && !!bt?.meta?.session && typeof bt?.status_ts === "number";
checks["board: progress stream"] = (board.body.progress ?? []).some((x) => x.artefact_id === c.json.id);
// proactive surfacing: B creates an overlapping task; A's get_artefact should see it
const overlap = await tool(B, "create_artefact", { type: "task", title: `Batching impl follow-up ${uid}`, tags: ["ingestion", "performance"] });
const got = await tool(A, "get_artefact", { id: c.json.id });
const sa = got.json?.see_also?.find((x) => x.id === overlap.json.id);
checks["see_also surfaces other agent's open task"] = !!sa && !!sa.coordination;
checks["coordination note present"] = /owned by other agents/.test(got.json?.coordination ?? "");

const q = await tool(B, "ask_agent", { to: "tag:datadog-access", question: `p95? (${uid})` });
checks["ask tag:capability"] = !q.isError;
const inboxA = await tool(A, "asks", {});
checks["A inbox"] = inboxA.json?.inbox?.some((a) => a.question.includes(uid));
checks["A answers"] = !!(await tool(A, "answer_ask", { id: inboxA.json.inbox[0].id, answer: "810ms" })).json?.id;
const sentB = await tool(B, "asks", {});
checks["B sees answered"] = sentB.json?.sent?.[0]?.status === "answered" && /810ms/.test(sentB.json?.sent?.[0]?.answer ?? "");
const created = await j("/api/kb/create", { method: "POST", body: JSON.stringify({ type: "task", title: `REST ${uid}` }) });
checks["REST create"] = created.status === 200;
const board2 = await j("/api/kb/board");
checks["REST board"] = board2.body.tasks?.some((t) => t.id === created.body.id);
const events = await j("/api/kb/events?since=0");
checks["REST events"] = events.body.events?.length >= 3;
// pct gauges + version history
const pct = await tool(A, "log_progress", { id: c.json.id, note: "gauges check", sentiment: "converging", completion_pct: 40, confidence_pct: 75, risk_pct: 20 });
checks["log_progress pct echoed"] = pct.json?.completion_pct === 40 && pct.json?.confidence_pct === 75 && pct.json?.risk_pct === 20;
const hist = await tool(A, "get_history", { id: c.json.id });
checks["get_history has create+progress versions"] = (hist.json?.versions ?? []).some((v) => v.action === "create") && (hist.json?.versions ?? []).some((v) => v.action === "progress" && v.data?.completion_pct === 40);
const boardSeries = await j("/api/kb/board");
checks["board series has pct points"] = (boardSeries.body.series ?? []).some((s) => s.artefact_id === c.json.id && s.completion_pct === 40);

// blocked validation: no reason → 400; with reason+unblock → ok; meta.blocked present
const badBlock = await j("/api/kb/transition", { method: "POST", body: JSON.stringify({ id: created.body.id, to: "blocked" }) });
checks["blocked without reason+unblock rejected"] = badBlock.status === 400 && /unblock/.test(JSON.stringify(badBlock.body));
const okBlock = await j("/api/kb/transition", { method: "POST", body: JSON.stringify({ id: created.body.id, to: "blocked", note: "waiting on creds", unblock_condition: "creds arrive" }) });
checks["blocked with reason+unblock ok"] = okBlock.status === 200;
const boardAfterBlock = await j("/api/kb/board");
const blockedTask = boardAfterBlock.body.tasks?.find((t) => t.id === created.body.id);
checks["blocked meta persisted"] = blockedTask?.meta?.blocked?.reason === "waiting on creds" && !!blockedTask?.meta?.blocked?.unblock_condition;
await j("/api/kb/transition", { method: "POST", body: JSON.stringify({ id: created.body.id, to: "in_progress" }) });
const boardUnblocked = await j("/api/kb/board");
checks["unblock clears blocked meta"] = !boardUnblocked.body.tasks?.find((t) => t.id === created.body.id)?.meta?.blocked;

await new Promise((resolveWs) => {
  const tryWs = (attempt) => {
  const ws = new WebSocket(base.replace("http", "ws") + "/kb-ws?since=0", { headers: { cookie } });
  const frames = [];
  ws.on("error", () => { if (attempt < 3) setTimeout(() => tryWs(attempt + 1), 800); else { checks["WS fanout"] = false; resolveWs(); } });
  ws.on("message", (raw) => frames.push(JSON.parse(raw)));
  ws.on("open", async () => {
    await new Promise((r) => setTimeout(r, 400));
    await j("/api/kb/transition", { method: "POST", body: JSON.stringify({ id: created.body.id, to: "done" }) });
    const deadline = Date.now() + 5000;
    const poll = setInterval(() => {
      const hit = frames.some((f) => f.type === "kb.event" && f.event?.artefact_id === created.body.id);
      if (hit) { checks["WS fanout"] = true; clearInterval(poll); ws.close(); resolveWs(); }
      else if (Date.now() > deadline) { console.log("  [ws frames]", frames.map((f) => f.type).join(",")); checks["WS fanout"] = false; clearInterval(poll); ws.close(); resolveWs(); }
    }, 250);
  });
  };
  tryWs(0);
});
const mintC = await j("/api/kb/admin/tokens", { method: "POST", body: JSON.stringify({ label: `tmp-${uid}` }) });
const tokensNow = await j("/api/kb/admin/tokens");
await j("/api/kb/admin/tokens/revoke", { method: "POST", body: JSON.stringify({ id: tokensNow.body.tokens.find((t) => t.label === `tmp-${uid}`)?.id }) });
checks["revoked token -32001"] = (await rpc("tools/list", {}, mintC.body.secret)).error?.code === -32001;
console.log("---");
let all = true;
for (const [k, v] of Object.entries(checks)) { console.log(v ? "PASS" : "FAIL", k); all &&= v; }
process.exit(all ? 0 : 1);
