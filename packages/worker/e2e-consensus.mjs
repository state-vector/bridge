// BR#903 focused verification against wrangler dev on :8801.
// Local-DO routing (the footgun): /api/kb/* (mint, For Me, human accept) route
// by the session cookie's workspace segment, while /mcp routes via the central
// registry (hash→ws, written at mint when ws_slug is set) to the workspace DO.
// Both must land in the SAME DO: the cookie ws below is DEFAULT_WS_SLUG, and a
// preflight seeds ws_slug on the fresh DO (prod DOs always have it; a fresh
// local one does not, and without it mint skips registration → "unknown auth token").
// 1. create decision -> auto-spawned Feedback round (question task, child_of)
// 2. two agents contribute agree/disagree via log_progress
// 3. orient carries decisions_awaiting_consensus with the tally
// 4. list(type=decision,status=proposed) carries consensus for For Me
// 5. human accept (web actor via cookie) -> round superseded, orient section empty
const base = "http://127.0.0.1:8801";
let cookie = "";
let A = "";
const j = async (path, opts = {}) => {
  const r = await fetch(base + path, { ...opts, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) } });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
};
const rpc = async (method, params) => {
  const r = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${A}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const b = await r.json();
  if (b.error) throw new Error(JSON.stringify(b.error));
  const t = b.result?.content?.[0]?.text;
  if (b.result?.isError) throw new Error("tool error: " + t);
  return JSON.parse(t);
};
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const ghSecret = "testghsecret";
const WS = "state-vector"; // DEFAULT_WS_SLUG — cookie ws and seeded ws_slug must match it
const exp = String(Date.now() + 3600_000);
const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(ghSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const sig = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${exp}.rayh.${WS}`)));
cookie = `bridge_session=${exp}.rayh.${WS}.${sig}`;

// preflight: seed ws_slug on a fresh local DO so mint registers the token (idempotent)
await j("/api/kb/admin/settings", { method: "POST", body: JSON.stringify({ settings: { ws_slug: WS } }) });

const mint = await j("/api/kb/admin/tokens", { method: "POST", body: JSON.stringify({ label: `oc-br903-${Date.now() % 10000}`, tags: [], transport: "mcp" }) });
if (mint.status !== 200) throw new Error("mint failed: " + JSON.stringify(mint.body));
A = mint.body.secret;
console.log("token minted");

const dec = await rpc("tools/call", { name: "create_artefact", arguments: { type: "decision", title: "ADR-BR903: consensus rounds on proposed decisions", body_md: "Proposed decisions auto-spawn a feedback round; orient surfaces decisions_awaiting_consensus; For Me shows the tally.", session: "br903-verify" } });
console.log("decision created:", dec.id, "feedback_round:", dec.feedback_round);
if (!/^BR#\d+$/.test(dec.id)) throw new Error("no decision id");
if (!dec.feedback_round) throw new Error("FAIL: no feedback_round id returned");

const got = await rpc("tools/call", { name: "get_artefact", arguments: { id: dec.id, session: "br903-verify" } });
const rel = (got.relations ?? []).find((r) => r.dir === "in" && r.relation === "child_of");
console.log("decision relations:", JSON.stringify(got.relations));
if (!rel) throw new Error("FAIL: decision has no child_of round");
const round = await rpc("tools/call", { name: "get_artefact", arguments: { id: rel.artefact_id, session: "br903-verify" } });
console.log("round:", round.id, "|", round.title, "| tags:", JSON.stringify(round.tags), "| kind:", round.meta?.kind);
if (!round.title.startsWith("Feedback:")) throw new Error("FAIL: round title");
if (!(round.tags ?? []).includes("question")) throw new Error("FAIL: round not question-tagged");

await rpc("tools/call", { name: "log_progress", arguments: { id: dec.feedback_round, did: "agree — mirrors the Verify spawn pattern, collection not gate", session: "agent-one" } });
await rpc("tools/call", { name: "log_progress", arguments: { id: dec.feedback_round, did: "disagree — the orient section may add noise; reasons: pool already shows questions", session: "agent-two" } });
await rpc("tools/call", { name: "log_progress", arguments: { id: dec.feedback_round, did: "what happens to the round on acceptance?", session: "agent-three" } });

const artefacts = await fetch(base + "/api/kb/artefacts?type=decision&status=proposed", { headers: { cookie } }).then((r) => r.json());
const mine = (artefacts.artefacts ?? []).find((a) => a.id === dec.id);
console.log("For Me consensus field:", JSON.stringify(mine?.consensus));
if (!mine?.consensus || mine.consensus.agree !== 1 || mine.consensus.disagree !== 1 || mine.consensus.contributions !== 3)
  throw new Error("FAIL: consensus tally on list");

const orient = await rpc("tools/call", { name: "orient", arguments: { session: "br903-verify" } });
const dac = orient.decisions_awaiting_consensus ?? [];
const entry = dac.find((e) => e.decision_id === dec.id);
console.log("orient decisions_awaiting_consensus:", JSON.stringify(dac, null, 1).slice(0, 900));
if (!entry) throw new Error("FAIL: orient section missing");
if (entry.agree !== 1 || entry.disagree !== 1 || entry.contributions !== 3) throw new Error("FAIL: orient tally");
if (!(entry.contributors ?? []).length) throw new Error("FAIL: contributors missing");

const accept = await j("/api/kb/transition", { method: "POST", body: JSON.stringify({ id: dec.id, to: "accepted", note: "accepted by human (For Me) — e2e" }) });
console.log("accept:", accept.status, JSON.stringify(accept.body));
if (accept.status !== 200) throw new Error("FAIL: human accept");
const roundAfter = await rpc("tools/call", { name: "get_artefact", arguments: { id: dec.feedback_round, session: "br903-verify" } });
console.log("round status after accept:", roundAfter.status, "| reason:", roundAfter.meta?.superseded_reason);
if (roundAfter.status !== "superseded") throw new Error("FAIL: round not superseded after accept");
const orient2 = await rpc("tools/call", { name: "orient", arguments: { session: "br903-verify" } });
if ((orient2.decisions_awaiting_consensus ?? []).some((e) => e.decision_id === dec.id))
  throw new Error("FAIL: accepted decision still listed");
console.log("ALL BR-903 CHECKS PASSED");