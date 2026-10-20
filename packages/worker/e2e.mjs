/** Full KB e2e against `wrangler dev` on :8799 (.dev.vars: GITHUB_CLIENT_SECRET, BRIDGE_INGEST_TOKEN). Run: node e2e.mjs */
import WebSocket from "ws";
const base = "http://127.0.0.1:8801";
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
// GitHub OAuth can't be scripted — mint the same HMAC session cookie the worker
// would set after the callback (secret must match .dev.vars GITHUB_CLIENT_SECRET).
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const ghSecret = process.env.GITHUB_CLIENT_SECRET ?? "testghsecret";
// mint the same HMAC session cookie the worker sets after the OAuth callback
// (value = exp.login.ws.sig; ws must match the signed payload).
const mintCookie = async (login, ws) => {
  const exp = String(Date.now() + 3600_000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(ghSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${exp}.${login}.${ws}`)));
  return `bridge_session=${exp}.${login}.${ws}.${sig}`;
};
cookie = await mintCookie("rayh", "e2e"); // suite runs in its own workspace
checks["session cookie minted"] = cookie.startsWith("bridge_session=");
const wsCreate = await j("/api/workspaces", { method: "POST", body: JSON.stringify({ slug: "e2e" }) }); // idempotent-enough: 'already exists' = provisioned by an earlier run
const mintA = await j("/api/kb/admin/tokens", { method: "POST", body: JSON.stringify({ label: `oc-${uid}`, tags: ["datadog-access"], transport: "mcp" }) });
checks["tokens are opaque (no workspace leak in the secret)"] = /^bkw_[0-9a-f]{48}$/.test(mintA.body?.secret ?? "");
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
checks["bootstrap: status duty + progress nudge + project"] = /Status is your responsibility/.test(initA.result?.instructions ?? "") && /PROTOCOL CARD/.test(initA.result?.instructions ?? "") && /Superpositional/.test(initA.result?.instructions ?? "");
checks["tools = 14"] = (await rpc("tools/list", {}, A)).result?.tools?.length === 14;
const c = await tool(A, "create_artefact", { type: "task", title: `Batching impl ${uid}`, body_md: "Reduce ingestion latency with bounded batching. Preserve idempotency.", tags: ["ingestion", "performance"], session: "impl-1", meta: { qualified: true } });
checks["create w/ tags+session (BR# id)"] = !c.isError && /^BR#\d+$/.test(c.json?.id ?? "");
const p = await tool(A, "log_progress", { id: c.json.id, note: "batch writer drafted", sentiment: "converging" });
checks["log_progress w/ sentiment + instructions"] = !p.isError && !!p.json?.instructions;
checks["progress instructions include behaviour score"] = /behaviour score/.test(p.json?.instructions ?? "");
await tool(A, "transition", { id: c.json.id, to: "in_progress" });
const s1 = await tool(A, "search_knowledge", { q: "slow ingestion" });
checks["fuzzy search (semantic+fts)"] = (s1.json?.artefacts?.length ?? 0) >= 1;
const rel = await tool(A, "related_artefacts", { id: c.json.id });
checks["related returns artefacts"] = Array.isArray(rel.json?.artefacts);
const board = await j("/api/kb/board");
const bt = board.body.tasks?.find((x) => x.id === c.json.id);
checks["board: progress + session + status_ts"] = !!bt?.meta?.last_progress && !!bt?.meta?.session && typeof bt?.status_ts === "number";
checks["board: progress stream"] = (board.body.progress ?? []).some((x) => x.artefact_id === c.json.id);
checks["board lists agent behaviour scores"] = (board.body.agents ?? []).some((a) => a.label === mintA.body.label && a.progress_count >= 1 && typeof a.score === "number");
const or = await tool(A, "orient", { session: `e2e-${uid}` });
checks["orient returns my_score"] = typeof or.json?.my_score?.score === "number" && typeof or.json?.my_score?.grade === "string";
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

// watchdog: stale in_progress → blocked "abandoned" → log_progress re-claims; open ask pauses it
await j("/api/kb/admin/settings", { method: "POST", body: JSON.stringify({ settings: { stale_minutes: 1 } }) });
const staleT = await tool(A, "create_artefact", { type: "task", title: `Watchdog probe ${uid}`, meta: { qualified: true } });
await tool(A, "transition", { id: staleT.json.id, to: "in_progress" });
const wdAsk = await tool(A, "ask_agent", { artefact_id: staleT.json.id, to: "any", question: `decision needed for ${uid}?` });
checks["ask linked → task blocked-on-decision"] = !wdAsk.isError && wdAsk.json?.task_status === "blocked" && /blocked-on-decision/.test(wdAsk.json.note ?? "");
const pollBoard = async (pred, deadlineMs) => {
  const end = Date.now() + deadlineMs;
  let last = null;
  while (Date.now() < end) {
    const b = await j("/api/kb/board");
    last = b.body.tasks?.find((t) => t.id === staleT.json.id);
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return last;
};
console.log("  polling ≤120s: watchdog must NOT abandon while ask is open…");
let wdTask = await pollBoard((t) => Date.now() - (t?.meta?.last_progress?.ts ?? t?.status_ts ?? 0) > 75_000, 120_000);
checks["open ask pauses watchdog (still blocked, not abandoned)"] = wdTask?.status === "blocked" && !/abandoned/.test(wdTask?.meta?.blocked?.reason ?? "");
await tool(A, "answer_ask", { id: wdAsk.json.id, answer: "ship it" });
wdTask = await pollBoard((t) => t?.status === "in_progress", 15_000);
checks["answered ask resumes task to in_progress"] = wdTask?.status === "in_progress";
console.log("  polling ≤130s: silence → watchdog blocks as abandoned…");
wdTask = await pollBoard((t) => t?.status === "blocked" && /abandoned/.test(t?.meta?.blocked?.reason ?? ""), 130_000);
checks["silence >stale_minutes → blocked abandoned"] = wdTask?.status === "blocked" && /abandoned/.test(wdTask?.meta?.blocked?.reason ?? "");
const reclaim = await tool(A, "log_progress", { id: staleT.json.id, note: "back online — re-claiming" });
checks["log_progress re-claims abandoned task"] = !reclaim.isError;
const boardAfterReclaim = await j("/api/kb/board");
checks["re-claimed → in_progress"] = boardAfterReclaim.body.tasks?.find((t) => t.id === staleT.json.id)?.status === "in_progress";
checks["re-claimed task stayed abandoned (server keeps latest status)"] = wdTask?.meta?.blocked?.reason != null && /abandoned/.test(wdTask?.meta?.blocked?.reason ?? "");

// silence cycle 2: re-abandon without an open ask this time → proves resume isn't what masked it
const again = await pollBoard((t) => t.id === staleT.json.id && t?.status === "blocked" && /abandoned/.test(t?.meta?.blocked?.reason ?? ""), 130_000);
checks["silence cycle 2 → abandoned again (no ask masking)"] = !!again;
// cycle 2 re-claim via update_artefact — any mutation is a heartbeat; stale meta.blocked must be stripped
const upd = await tool(A, "update_artefact", { id: staleT.json.id, body_md: "agent touched this via update_artefact" });
checks["update_artefact re-claims abandoned task"] = !upd.isError;
const boardAfterUpd = await j("/api/kb/board");
const updTask = boardAfterUpd.body.tasks?.find((t) => t.id === staleT.json.id);
checks["update re-claim → in_progress, blocked meta stripped"] = updTask?.status === "in_progress" && updTask?.meta?.blocked == null;

// blocked validation: no reason → 400; with reason+unblock → ok; meta.blocked present
const badBlock = await j("/api/kb/transition", { method: "POST", body: JSON.stringify({ id: created.body.id, to: "blocked" }) });
checks["blocked without reason+unblock rejected"] = badBlock.status === 400 && /unblock/.test(JSON.stringify(badBlock.body));
const okBlock = await j("/api/kb/transition", { method: "POST", body: JSON.stringify({ id: created.body.id, to: "blocked", note: "waiting on creds", unblock_condition: "creds arrive" }) });
checks["blocked with reason+unblock ok"] = okBlock.status === 200;
const boardAfterBlock = await j("/api/kb/board");
const blockedTask = boardAfterBlock.body.tasks?.find((t) => t.id === created.body.id);
checks["blocked meta persisted"] = blockedTask?.meta?.blocked?.reason === "waiting on creds" && !!blockedTask?.meta?.blocked?.unblock_condition;
const noRes = await j("/api/kb/transition", { method: "POST", body: JSON.stringify({ id: created.body.id, to: "in_progress" }) });
checks["unblocking requires a resolution"] = noRes.status === 400 && /resolution/.test(JSON.stringify(noRes.body));
await j("/api/kb/transition", { method: "POST", body: JSON.stringify({ id: created.body.id, to: "in_progress", note: "resolution: creds arrived" }) });
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
    await j("/api/kb/transition", { method: "POST", body: JSON.stringify({ id: created.body.id, to: "blocked", note: "ws probe block", unblock_condition: "ws probe" }) });
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
const sess = await j("/api/session");
checks["session endpoint (mode + user + workspace + expiry)"] = sess.body.mode === "github" && sess.body.user === "rayh" && sess.body.workspace === "e2e" && typeof sess.body.expires_ts === "number" && sess.body.expires_ts > Date.now();
{
  const saved = cookie;
  // legacy pre-workspaces cookie (2-part payload) → default workspace
  const exp = String(Date.now() + 3600_000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(ghSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${exp}.rayh`)));
  cookie = `bridge_session=${exp}.rayh.${sig}`;
  const legacy = await j("/api/session");
  checks["legacy cookie maps to default workspace"] = legacy.body.mode === "github" && legacy.body.user === "rayh" && legacy.body.workspace === "state-vector";
  // outsider: own auto-workspace, sees none of the e2e workspace's data
  cookie = await mintCookie("stranger", "gh-stranger");
  const strangerWs = await j("/api/workspaces", { method: "POST", body: JSON.stringify({ slug: "gh-stranger" }) });
  const outsider = await j("/api/kb/board");
  checks["outsider sees empty workspace (no cross-workspace leak)"] = outsider.status === 200 && (outsider.body.tasks ?? []).length === 0 && (outsider.body.events ?? []).length === 0;
  // agent tokens are workspace-ROUTED (bearer-only): a stranger's own token reaches
  // their empty workspace and must not see the e2e workspace's data
  const strToken = await j("/api/kb/admin/tokens", { method: "POST", body: JSON.stringify({ label: `str-${uid}` }) });
  const strInit = await rpc("initialize", { protocolVersion: "2025-06-18" }, strToken.body.secret);
  checks["stranger's own token initializes in their workspace"] = !strInit.error && !!strInit.result?.instructions;
  const strSearch = await rpc("tools/call", { name: "search_knowledge", arguments: { q: "Batching impl", limit: 50 } }, strToken.body.secret);
  checks["agent token is workspace-bound (stranger's token sees no e2e data)"] = (JSON.parse(strSearch.result?.content?.[0]?.text ?? "{}").artefacts ?? []).length === 0;
  const e2eTokenSearch = await rpc("tools/call", { name: "search_knowledge", arguments: { q: "Batching impl", limit: 50 } }, A);
  checks["e2e workspace token still sees its own data"] = (JSON.parse(e2eTokenSearch.result?.content?.[0]?.text ?? "{}").artefacts ?? []).length >= 1;
  cookie = saved;
}
// device pairing: start → membership-checked approve → one-time poll (opaque token)
{
  const pc = (await j("/api/pair/start", { method: "POST", body: JSON.stringify({ device: `e2e-box-${uid}` }) })).body;
  const got = await j("/api/pair/get", { method: "POST", body: JSON.stringify({ code: pc.code }) });
  checks["pair: start + get"] = !!pc.code && got.body.status === "pending" && got.body.device === `e2e-box-${uid}`;
  const denied = await j("/api/pair/approve", { method: "POST", body: JSON.stringify({ code: pc.code, ws: "gh-stranger", label: `p-${uid}`, tags: ["role:impl"] }) });
  checks["pair: approve requires membership"] = !!denied.body.error;
  const ok = await j("/api/pair/approve", { method: "POST", body: JSON.stringify({ code: pc.code, ws: "e2e", label: `p-${uid}`, tags: ["role:impl"] }) });
  checks["pair: approve mints in member ws"] = ok.status === 200 && ok.body.ok === true;
  const poll1 = await j("/api/pair/poll", { method: "POST", body: JSON.stringify({ code: pc.code }) });
  checks["pair: poll returns opaque token once"] = poll1.body.status === "authorized" && /^bkw_[0-9a-f]{48}$/.test(poll1.body.token ?? "");
  const poll2 = await j("/api/pair/poll", { method: "POST", body: JSON.stringify({ code: pc.code }) });
  checks["pair: second poll expired (one-time read)"] = poll2.body.status === "expired";
}
const mintC = await j("/api/kb/admin/tokens", { method: "POST", body: JSON.stringify({ label: `tmp-${uid}` }) });
const tokensNow = await j("/api/kb/admin/tokens");
// tags update in place (roles/capabilities) — secret stays valid, no re-mint
const mintTag = await j("/api/kb/admin/tokens", { method: "POST", body: JSON.stringify({ label: `tag-${uid}` }) });
const tagUp = await j("/api/kb/admin/tokens/tags", { method: "POST", body: JSON.stringify({ id: mintTag.body.id, tags: ["role:analysis", "role:impl"] }) });
checks["token tags update in place"] = tagUp.status === 200 && JSON.stringify(tagUp.body.tags) === JSON.stringify(["role:analysis", "role:impl"]);
await j("/api/kb/admin/tokens/revoke", { method: "POST", body: JSON.stringify({ id: tokensNow.body.tokens.find((t) => t.label === `tmp-${uid}`)?.id }) });
checks["revoked token -32001"] = (await rpc("tools/list", {}, mintC.body.secret)).error?.code === -32001;
// progress-artefact heartbeat: agents post progress logs instead of log_progress;
// creating a progress artefact with meta.task must auto-start the todo task
const hbT = await tool(A, "create_artefact", { type: "task", title: `Heartbeat probe ${uid}`, meta: { qualified: true } });
checks["heartbeat probe starts todo"] = hbT.json?.status === "todo";
const hbP = await tool(A, "create_artefact", { type: "progress", title: `Heartbeat probe log ${uid} — making real progress on the heartbeat path`, meta: { task: hbT.json.id } });
checks["progress artefact created"] = !hbP.isError;
const hbBoard = await j("/api/kb/board");
const hbTask = hbBoard.body.tasks?.find((t) => t.id === hbT.json.id);
checks["progress artefact auto-starts todo → in_progress"] = hbTask?.status === "in_progress";
checks["progress artefact bumps task last_progress"] = !!hbTask?.meta?.last_progress && /Heartbeat probe log/.test(hbTask.meta.last_progress.note ?? "");
checks["progress artefact feeds task series"] = (hbBoard.body.series ?? []).some((s) => s.artefact_id === hbT.json.id);
// blocked-on-decision tasks must NOT be force-started by a progress artefact
const bdT = await tool(A, "create_artefact", { type: "task", title: `Heartbeat decision probe ${uid}`, meta: { qualified: true } });
await tool(A, "transition", { id: bdT.json.id, to: "in_progress" });
await tool(A, "ask_agent", { artefact_id: bdT.json.id, to: "any", question: `hold for decision ${uid}?` });
checks["decision probe is blocked-on-decision"] = (await j("/api/kb/board")).body.tasks?.find((t) => t.id === bdT.json.id)?.status === "blocked";
await tool(A, "create_artefact", { type: "progress", title: `should not start a blocked-on-decision task ${uid}`, meta: { task: bdT.json.id } });
const bdBoard = await j("/api/kb/board");
checks["progress artefact respects blocked-on-decision"] = bdBoard.body.tasks?.find((t) => t.id === bdT.json.id)?.status === "blocked";

// ---- pooled work: project field, claims, flat decomposition, roles ----
const prjT = await tool(A, "create_artefact", { type: "task", title: `Bridge project probe ${uid}`, project: "bridge", meta: { qualified: true } });
const prjBoard = await j("/api/kb/board");
const prjTask = prjBoard.body.tasks?.find((t) => t.id === prjT.json.id);
checks["project field on create + default for omitted"] = prjTask?.project === "bridge" && hbTask?.project === "Superpositional";
checks["tasks enter UNCLAIMED (owner = pool)"] = prjTask?.owner === "";
await tool(A, "transition", { id: prjT.json.id, to: "in_progress" });
const claimedBoard = await j("/api/kb/board");
checks["claim: in_progress sets owner to actor"] = claimedBoard.body.tasks?.find((t) => t.id === prjT.json.id)?.owner === mintA.body.label;
// flat decomposition + swimlane gates: qualify → claim → impl → review → done
const gParent = await tool(A, "create_artefact", { type: "task", title: `Swimlane probe ${uid}` });
const gPickup = await tool(A, "transition", { id: gParent.json.id, to: "in_progress" });
checks["unqualified work cannot be picked up"] = gPickup.isError && /not qualified/.test(gPickup.text ?? "");
const gAnalysis = await tool(A, "create_artefact", { type: "task", title: `Swimlane analysis ${uid}`, tags: ["role:analysis"] });
await tool(A, "link_artefacts", { src: gAnalysis.json.id, relation: "child_of", dst: gParent.json.id });
await tool(A, "transition", { id: gAnalysis.json.id, to: "in_progress", session: `e2e-analysis-${uid}` });
await tool(A, "transition", { id: gAnalysis.json.id, to: "done", session: `e2e-analysis-${uid}` });
// separation of duties: the analysis session cannot claim the parent for impl — fresh session
await tool(A, "transition", { id: gParent.json.id, to: "in_progress", session: `e2e-impl-${uid}` });
checks["analysis child qualifies pickup (claim sets owner)"] = (await j("/api/kb/board")).body.tasks?.find((t) => t.id === gParent.json.id)?.owner === mintA.body.label;
const gUnreviewed = await tool(A, "transition", { id: gParent.json.id, to: "done" });
checks["work cannot be done unreviewed"] = gUnreviewed.isError && /unreviewed/.test(gUnreviewed.text ?? "");
const gImpl = await tool(A, "create_artefact", { type: "task", title: `Swimlane impl child ${uid}` });
await tool(A, "link_artefacts", { src: gImpl.json.id, relation: "child_of", dst: gParent.json.id });
const gBoard1 = await j("/api/kb/board");
checks["child task carries part_of; parent carries rollup"] = gBoard1.body.tasks?.find((t) => t.id === gImpl.json.id)?.part_of === gParent.json.id
  && gBoard1.body.tasks?.find((t) => t.id === gParent.json.id)?.children_open === 1
  && gBoard1.body.tasks?.find((t) => t.id === gParent.json.id)?.children_done === 1;
await tool(A, "transition", { id: gImpl.json.id, to: "in_progress", session: `e2e-impl-${uid}` });
const gImplDone = await tool(A, "transition", { id: gImpl.json.id, to: "done" });
checks["impl child also gated on review"] = gImplDone.isError && /unreviewed/.test(gImplDone.text ?? "");
const gReview = await tool(A, "create_artefact", { type: "task", title: `Swimlane review ${uid}`, tags: ["role:review"], session: `e2e-review-${uid}` });
await tool(A, "link_artefacts", { src: gReview.json.id, relation: "child_of", dst: gParent.json.id });
// review receipts + separation of duties: the review completes from a different
// session than the implementation, citing what was verified
await tool(A, "transition", { id: gReview.json.id, to: "in_progress", session: `e2e-review-${uid}` });
await tool(A, "transition", { id: gReview.json.id, to: "done", session: `e2e-review-${uid}`, note: "verified: PR https://github.com/state-vector/bridge/pull/1 merged, checks green" });
const gOpenKid = await tool(A, "transition", { id: gParent.json.id, to: "done" });
checks["parent not completable with open children"] = gOpenKid.isError && /open child/.test(gOpenKid.text ?? "");
const gVerdict = await tool(A, "create_artefact", { type: "decision", title: `Verdict: pass ${uid}` });
await tool(A, "link_artefacts", { src: gVerdict.json.id, relation: "supports", dst: gImpl.json.id });
await tool(A, "transition", { id: gVerdict.json.id, to: "accepted" });
await tool(A, "transition", { id: gImpl.json.id, to: "done" });
checks["accepted decision qualifies done"] = (await tool(A, "get_artefact", { id: gImpl.json.id })).json?.status === "done";
await tool(A, "transition", { id: gParent.json.id, to: "done" });
checks["parent completes after review child closes"] = (await tool(A, "get_artefact", { id: gParent.json.id })).json?.status === "done";
// roles + playbooks + unclaimed pool
const mintAn = await j("/api/kb/admin/tokens", { method: "POST", body: JSON.stringify({ label: `an-${uid}`, tags: ["role:analysis"] }) });
const AN = mintAn.body.secret;
await j("/api/kb/admin/settings", { method: "POST", body: JSON.stringify({ settings: { roles: { analysis: "DECOMPOSE, DON'T BUILD: claim the high-level task, write child tasks with acceptance criteria and child_of relations, tag children with their role, then return to todo/in_progress — do not implement the children yourself." } } }) });
const poolT = await tool(A, "create_artefact", { type: "task", title: `Analysis pool probe ${uid}`, tags: ["role:analysis"] });
const orAn = await tool(AN, "orient", { session: `e2e-an-${uid}` });
checks["role playbook composed into orient instructions"] = /YOUR ROLE: analysis/.test(orAn.json?.instructions ?? "") && /DECOMPOSE, DON'T BUILD/.test(orAn.json?.instructions ?? "");
checks["unclaimed_work surfaces pool by role"] = (orAn.json?.unclaimed_work ?? []).some((t) => t.id === poolT.json.id);
const orA = await tool(A, "orient", { session: `e2e-a2-${uid}` });
checks["role-gated task hidden from non-matching agents"] = !(orA.json?.unclaimed_work ?? []).some((t) => t.id === poolT.json.id);
await tool(AN, "transition", { id: poolT.json.id, to: "in_progress" });
checks["role agent claims via transition"] = (await j("/api/kb/board")).body.tasks?.find((t) => t.id === poolT.json.id)?.owner === mintAn.body.label;
// qualifier intake: unqualified work tagged for OTHER roles must be visible AND
// claimable by analysis agents (their job is to qualify it) — otherwise impl-tagged
// unqualified tasks deadlock the pool: invisible to impl agents (unqualified) and
// to analysis agents (role-gated)
const implT = await tool(A, "create_artefact", { type: "task", title: `Impl-tagged unqualified ${uid}`, tags: ["role:impl"] });
const orAnQ = await tool(AN, "orient", { session: `e2e-an2-${uid}` });
const surfaced = orAnQ.json?.unclaimed_work?.find((t) => t.id === implT.json.id);
checks["qualifier sees unqualified impl-tagged work (needs_qualification)"] = !!surfaced && surfaced.needs_qualification === true;
checks["qualifier claims impl-tagged unqualified work"] = !(await tool(AN, "transition", { id: implT.json.id, to: "in_progress" })).isError;
const orAq = await tool(A, "orient", { session: `e2e-a2b-${uid}` });
checks["unqualified impl work still hidden from impl agents"] = !(orAq.json?.unclaimed_work ?? []).some((t) => t.id === implT.json.id);
// visibility: agents must not SEE work they cannot claim
const uqT = await tool(A, "create_artefact", { type: "task", title: `Unqualified pool probe ${uid}` });
const orA2 = await tool(A, "orient", { session: `e2e-a3-${uid}` });
checks["unqualified work invisible to non-qualifier agents"] = !(orA2.json?.unclaimed_work ?? []).some((t) => t.id === uqT.json.id);
const orAn2 = await tool(AN, "orient", { session: `e2e-an2-${uid}` });
checks["unqualified work visible to qualifier agents"] = (orAn2.json?.unclaimed_work ?? []).some((t) => t.id === uqT.json.id);
const gRoleT = await tool(A, "create_artefact", { type: "task", title: `Role-gate probe ${uid}`, tags: ["role:impl"], meta: { qualified: true } });
const orAn3 = await tool(AN, "orient", { session: `e2e-an3-${uid}` });
checks["role-mismatched work invisible even when ready"] = !(orAn3.json?.unclaimed_work ?? []).some((t) => t.id === gRoleT.json.id);
const gRoleClaim = await tool(AN, "transition", { id: gRoleT.json.id, to: "in_progress" });
checks["role-mismatched claim rejected at the gate"] = gRoleClaim.isError && /gated to/.test(gRoleClaim.text ?? "");
// stacked qualifications: publisher self-qualifies AND requests review confirmation before ready
const sqT = await tool(A, "create_artefact", { type: "task", title: `Stacked quals probe ${uid}`, qualified: true, await: ["role:review"] });
const sqBoard1 = await j("/api/kb/board");
const sqTask1 = sqBoard1.body.tasks?.find((t) => t.id === sqT.json.id);
checks["stacked quals: declared + unmet bar projected on board"] = sqTask1?.qualification?.state === "qualified" && sqTask1?.qualification?.ready === false && (sqTask1?.qualification?.unmet_bars ?? []).includes("role:review");
const sqBlocked = await tool(A, "transition", { id: sqT.json.id, to: "in_progress" });
checks["qualified-but-awaiting work cannot be picked up"] = sqBlocked.isError && /awaiting|unmet bars/.test(sqBlocked.text ?? "");
const sqReview = await tool(A, "create_artefact", { type: "task", title: `Stacked quals confirm ${uid}`, tags: ["role:review"], session: `e2e-review-${uid}` });
await tool(A, "link_artefacts", { src: sqReview.json.id, relation: "child_of", dst: sqT.json.id });
await tool(A, "transition", { id: sqReview.json.id, to: "in_progress", session: `e2e-review-${uid}` });
await tool(A, "transition", { id: sqReview.json.id, to: "done", session: `e2e-review-${uid}`, note: "verified: PR https://github.com/state-vector/bridge/pull/2 merged, checks green" });
const sqBoard2 = await j("/api/kb/board");
checks["stacked quals: bar met → ready"] = sqBoard2.body.tasks?.find((t) => t.id === sqT.json.id)?.qualification?.ready === true;
await tool(A, "transition", { id: sqT.json.id, to: "in_progress" });
checks["stacked quals: ready task claimable"] = (await j("/api/kb/board")).body.tasks?.find((t) => t.id === sqT.json.id)?.owner === mintA.body.label;

// logout round-trip — last, so the shared cookie survives the rest of the suite
const out = await fetch(base + "/logout", { headers: { cookie }, redirect: "manual" });
checks["logout clears cookie"] = out.status === 302 && /Max-Age=0/.test(out.headers.get("set-cookie") ?? "");
// note: the HMAC session cookie stays valid if manually replayed (stateless) —
// logout works by making the BROWSER drop it; no server-side session store.
console.log("---");
let all = true;
for (const [k, v] of Object.entries(checks)) { console.log(v ? "PASS" : "FAIL", k); all &&= v; }
process.exit(all ? 0 : 1);
