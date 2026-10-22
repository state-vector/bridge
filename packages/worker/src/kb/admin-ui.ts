/**
 * Admin page for the knowledge layer (human plane, password session):
 * mint/revoke agent auth tokens, see connected agents + sessions, project flags,
 * role playbooks. Server-rendered shell + fetch calls to /api/kb/admin/* — no build step.
 */
import { DEFAULT_ROLE_PLAYBOOKS } from "./core.ts";

/** Hub defaults inlined for display; escaped so they can sit inside the page's script. */
const ROLE_DEFAULTS_JSON = JSON.stringify(DEFAULT_ROLE_PLAYBOOKS)
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$\{/g, "\\${");

export const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bridge — work orchestration</title>
<style>
  :root { color-scheme: dark; }
  body { background: #0e1116; color: #e8edf4; font: 14px -apple-system, system-ui, sans-serif; margin: 0; padding: 24px; }
  h1 { font-size: 18px; } h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: #8a95a6; margin: 28px 0 8px; }
  .card { background: #151a22; border: 1px solid #232b38; border-radius: 10px; padding: 16px; max-width: 860px; margin-bottom: 16px; }
  input, textarea, select { background: #0e1116; color: #e8edf4; border: 1px solid #232b38; border-radius: 6px; padding: 7px 9px; font: inherit; width: 100%; box-sizing: border-box; }
  label { display: block; font-size: 11px; color: #8a95a6; margin: 8px 0 3px; text-transform: uppercase; letter-spacing: .06em; }
  button { background: #1c2330; color: #e8edf4; border: 1px solid #232b38; border-radius: 6px; padding: 7px 14px; cursor: pointer; font: inherit; }
  button:hover { border-color: #5b9dff; } button.danger { color: #ff6b6b; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #232b38; color: #c6cfdb; }
  th { color: #5b6575; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  .secret { background: #10241a; border: 1px solid #3ecf8e; color: #3ecf8e; padding: 10px; border-radius: 6px; font-family: ui-monospace, monospace; word-break: break-all; margin: 8px 0; }
  .muted { color: #5b6575; font-size: 12px; }
  .row { display: flex; gap: 10px; } .row > * { flex: 1; }
  .ok { color: #3ecf8e; } .err { color: #ff6b6b; }
  code.inline { background: #1c2330; padding: 2px 5px; border-radius: 4px; font-size: 12px; }
</style>
</head>
<body>
<h1>Bridge — work orchestration</h1>

<div class="card">
  <h2>Auth tokens</h2>
  <p class="muted">One auth token per agent client. Sessions self-name uniquely. Secret is shown once — store it in the agent's config.</p>
  <div class="row">
    <div><label>Agent label</label><input id="t-label" placeholder="opencode-ray"></div>
    <div><label>Capability tags (comma-sep, e.g. datadog-access)</label><input id="t-tags" placeholder="datadog-access, deploy"></div>
  </div>
  <p><button onclick="mint()">Mint auth token</button></p>
  <div id="secret" class="secret" style="display:none"></div>
  <table id="tokens"><thead><tr><th>agent</th><th>tags</th><th>created</th><th>last seen</th><th>state</th><th></th></tr></thead><tbody></tbody></table>
  <h2>Sessions</h2>
  <table id="sessions"><thead><tr><th>agent</th><th>session</th><th>first seen</th><th>last seen</th></tr></thead><tbody></tbody></table>
</div>

<div class="card">
  <h2>Project flags</h2>
  <label>Project name</label><input id="s-name" placeholder="My project">
  <label>Board mode</label>
  <select id="s-board-mode">
    <option value="none">none — no board surfaced to agents</option>
    <option value="builtin">builtin — use Bridge work orders (future)</option>
    <option value="external">external — we use our own board (prompt below)</option>
  </select>
  <div id="s-board-extra" style="display:none">
    <label>Board kind (e.g. github-projects)</label><input id="s-board-kind" placeholder="github-projects">
    <label>Board URL</label><input id="s-board-url" placeholder="https://github.com/orgs/…/projects/1">
    <label>Board prompt (what agents must know when working with your board)</label>
    <textarea id="s-board-prompt" rows="3" placeholder="Always move the task to In Progress when you start; link the PR in the task comments."></textarea>
  </div>
  <label>Extra bootstrap markdown (appended to agent bootstrap)</label>
  <textarea id="s-bootstrap" rows="4" placeholder="Situation-specific guidance…"></textarea>
  <p><button onclick="saveSettings()">Save flags</button> <span id="s-msg"></span></p>
  <p class="muted">Agents receive this via the MCP <code class="inline">instructions</code> on connect and inside <code class="inline">orient</code> — the entry prompt only teaches discovery; docs stay in artefacts.</p>
</div>

<div class="card">
  <h2>Roles &amp; playbooks</h2>
  <p class="muted">Agent tokens carry <code class="inline">role:*</code> tags; the hub composes the matching playbook into every orient for that agent (under <code class="inline">YOUR ROLE</code>). Hub defaults live in <code class="inline">packages/worker/src/kb/core.ts</code> (<code class="inline">DEFAULT_ROLE_PLAYBOOKS</code>). Override a lane below; clear a playbook and save to reset it to the hub default.</p>
  <label>role:analysis playbook (blank = hub default)</label><textarea id="s-role-analysis" rows="6" placeholder="blank = hub default"></textarea>
  <label>role:impl playbook (blank = hub default)</label><textarea id="s-role-impl" rows="3" placeholder="blank = hub default"></textarea>
  <label>role:review playbook (blank = hub default)</label><textarea id="s-role-review" rows="3" placeholder="blank = hub default"></textarea>
  <details>
    <summary class="muted" style="cursor:pointer; margin-top:8px;">Hub defaults</summary>
    <pre id="s-role-defaults" class="muted" style="white-space:pre-wrap;"></pre>
  </details>
  <p><button onclick="saveRoles()">Save roles</button> <span id="s-roles-msg"></span></p>
</div>

<script>
const ROLES = ["analysis", "impl", "review"];
const ROLE_DEFAULTS = ${ROLE_DEFAULTS_JSON};
const j = async (u, o) => { const r = await fetch(u, { credentials: "include", headers: { "content-type": "application/json" }, ...o }); const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(b.error || r.status); return b; };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ago = (ts) => ts ? Math.round((Date.now() - ts) / 60000) + "m ago" : "never";

async function mint() {
  try {
    const b = await j("/api/kb/admin/tokens", { method: "POST", body: JSON.stringify({ label: document.getElementById("t-label").value, tags: document.getElementById("t-tags").value.split(",").map(s => s.trim()).filter(Boolean) }) });
    const el = document.getElementById("secret");
    el.style.display = "block";
    el.innerHTML = "Auth token for <b>" + esc(b.label) + "</b> (shown once):<br>" + esc(b.secret);
    load();
  } catch (e) { alert(e.message); }
}
async function revoke(id) { if (confirm("Revoke? The agent gets 401 on its next call.")) { await j("/api/kb/admin/tokens/revoke", { method: "POST", body: JSON.stringify({ id }) }); load(); } }
async function load() {
  const b = await j("/api/kb/admin/tokens");
  document.querySelector("#tokens tbody").innerHTML = b.tokens.map(t =>
    "<tr><td>" + esc(t.label) + "</td><td>" + esc((t.tags || []).join(", ")) + "</td><td>" + ago(t.created_ts) + "</td><td>" + ago(t.last_seen_ts) + "</td><td>" + (t.revoked_ts ? '<span class="err">revoked</span>' : '<span class="ok">active</span>') + "</td><td>" + (t.revoked_ts ? "" : '<button class="danger" onclick="revoke(\\'' + t.id + '\\')">revoke</button>') + "</td></tr>"
  ).join("");
  document.querySelector("#sessions tbody").innerHTML = b.sessions.map(s =>
    "<tr><td>" + esc(b.tokens.find(t => t.id === s.token_id)?.label ?? s.token_id) + "</td><td>" + esc(s.name) + "</td><td>" + ago(s.first_seen_ts) + "</td><td>" + ago(s.last_seen_ts) + "</td></tr>"
  ).join("");
}
async function loadSettings() {
  const b = await j("/api/kb/admin/settings");
  const s = b.settings || {};
  document.getElementById("s-name").value = s.project_name ?? "";
  const board = s.board || { mode: "none" };
  document.getElementById("s-board-mode").value = board.mode ?? "none";
  document.getElementById("s-board-kind").value = board.kind ?? "";
  document.getElementById("s-board-url").value = board.url ?? "";
  document.getElementById("s-board-prompt").value = board.prompt ?? "";
  document.getElementById("s-bootstrap").value = s.bootstrap_md ?? "";
  const roles = s.roles || {};
  for (const r of ROLES) document.getElementById("s-role-" + r).value = typeof roles[r] === "string" ? roles[r] : "";
  document.getElementById("s-role-defaults").textContent = ROLES.map(r => "role:" + r + "\n" + (ROLE_DEFAULTS[r] ?? "")).join("\n\n");
  boardExtra();
}
function boardExtra() { document.getElementById("s-board-extra").style.display = document.getElementById("s-board-mode").value === "external" ? "block" : "none"; }
async function saveSettings() {
  try {
    await j("/api/kb/admin/settings", { method: "POST", body: JSON.stringify({ settings: {
      project_name: document.getElementById("s-name").value,
      board: { mode: document.getElementById("s-board-mode").value, kind: document.getElementById("s-board-kind").value, url: document.getElementById("s-board-url").value, prompt: document.getElementById("s-board-prompt").value },
      bootstrap_md: document.getElementById("s-bootstrap").value,
    }})});
    document.getElementById("s-msg").innerHTML = '<span class="ok">saved</span>';
  } catch (e) { document.getElementById("s-msg").innerHTML = '<span class="err">' + esc(e.message) + '</span>'; }
}
async function saveRoles() {
  try {
    await j("/api/kb/admin/settings", { method: "POST", body: JSON.stringify({ settings: {
      roles: Object.fromEntries(ROLES.map(r => [r, document.getElementById("s-role-" + r).value])),
    }})});
    document.getElementById("s-roles-msg").innerHTML = '<span class="ok">saved</span>';
  } catch (e) { document.getElementById("s-roles-msg").innerHTML = '<span class="err">' + esc(e.message) + '</span>'; }
}
document.getElementById("s-board-mode").addEventListener("change", boardExtra);
load(); loadSettings();
</script>
</body>
</html>`;
