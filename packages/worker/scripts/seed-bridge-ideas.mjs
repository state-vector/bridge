// Log rayh's 2026-10-15 ideas into the live knowledge layer.
// Usage: KB_TOKEN=bkw_… KB_URL=https://bridge.ray-013.workers.dev node scripts/seed-bridge-ideas.mjs
const base = process.env.KB_URL ?? "https://bridge.ray-013.workers.dev";
const token = process.env.KB_TOKEN;
if (!token) { console.error("set KB_TOKEN (Connect page → mint, label claude-agent)"); process.exit(1); }
const rpc = async (method, params) => {
  const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const b = await r.json();
  if (b.error) throw new Error(b.error.message);
  return JSON.parse(b.result.content[0].text);
};
const seed = await rpc("tools/call", { name: "create_artefact", arguments: { type: "research", title: "Sentiment signals on the board — dashboarding agent mood/convergence", tags: ["dashboard", "sentiment"], body_md: `## Idea (rayh)\nAgents report sentiment with progress (going_well / struggling / converging / diverging).\nOver time this becomes dashboardable: are tasks converging before they ship? Do struggling tasks correlate with blockers?\n\n## Status\nlog_progress + board rendering shipped; time-series view is the follow-on.` } });
console.log("seeded:", seed.id);
