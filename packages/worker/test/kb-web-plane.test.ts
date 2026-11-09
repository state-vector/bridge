import { Miniflare } from "miniflare";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExecutionAttentionSchema } from "@bridge/contracts";

/**
 * Web comment plane + ask-band/detail UX contracts (BR#3462).
 *
 * Leg 1 (route, behavioral): every human comment from the web UI posts
 * POST /api/kb/progress — the human-plane allowlist must map that sub to the
 * DO op the switch actually knows, `progress.log` (do.ts). Before the fix the
 * unmapped name hit the DO as bare `progress` and 404'd "unknown op progress"
 * (reproduced live against the deployed hub 2026-10-26): TaskDetail comments,
 * decision-popover comments and discussion replies all failed. Red-first: this
 * test 404s until index.js maps the sub.
 * Legs 2+3 (source-assertion): AskBand rows must render their artefact id
 * (you cannot tell WHICH verdict/ask you are acting on otherwise) and
 * TaskDetail must load artefact/related/history in parallel (sequential awaits
 * made the panel cold-load seconds and a mid-chain failure emptied later
 * sections) — asserted on the view sources per the repo's source-assertion
 * convention (needles assembled from parts; no UI test rig exists — this
 * suite is the only one that runs).
 */

const SECRET = "test-gh-secret";

function sessionCookie(login = "ray", ws = "state-vector") {
  const exp = String(Date.now() + 60_000);
  const sig = createHmac("sha256", SECRET).update(`${exp}.${login}.${ws}`).digest("hex");
  return `bridge_session=${exp}.${login}.${ws}.${sig}`;
}

let mf: Miniflare;
let cookie: string;

beforeAll(() => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  if (!existsSync(bundle)) {
    throw new Error("bundle missing — run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle (the npm test script does this before vitest)");
  }
  mf = new Miniflare({
    workers: [{
      name: "main",
      scriptPath: bundle,
      // realpath + modulesRoot: workerd's virtual FS rejects ".." segments
      modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")),
      modules: true,
      compatibilityDate: "2025-09-06",
      durableObjects: { KB: { className: "KnowledgeHub", useSQLite: true } },
      bindings: { GITHUB_CLIENT_ID: "test-client", GITHUB_CLIENT_SECRET: SECRET },
    }],
  });
  cookie = sessionCookie();
});

afterAll(async () => {
  await mf.dispose();
});

const api = (path: string, init?: { method?: string; body?: string }) =>
  mf.dispatchFetch(`https://main${path}`, {
    method: init?.method ?? "GET",
    headers: { cookie, "content-type": "application/json" },
    body: init?.body,
  });

describe("POST /api/kb/progress — the human comment plane (BR#3462 leg 1)", () => {
  it("reports stateful deployment provenance separately from the web edge without requiring credentials", async () => {
    const response = await mf.dispatchFetch("https://main/__version?scope=stateful");
    expect(response.status).toBe(200);
    const version = await response.json() as { commit: string; lifecycle_protocol: number };
    expect(version.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(version.lifecycle_protocol).toBe(2);
  });
  it("exposes authenticated bounded request diagnostics without credentials or business mutations", async () => {
    expect((await mf.dispatchFetch("https://main/api/kb/diagnostics")).status).toBe(401);
    const res = await api("/api/kb/diagnostics");
    expect(res.status).toBe(200);
    const body = await res.json() as { instance_id: string; active: object[]; recent: object[] };
    expect(body.instance_id).toBeTruthy();
    expect(body.active.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });
  it("does not confuse workspace routing with authentication for an unknown bearer", async () => {
    const denied = await mf.dispatchFetch("https://main/api/kb/board", { headers: { authorization: "Bearer not-a-vended-credential" } });
    expect(denied.status).toBe(401);
  });

  it.each(["stats", "list", "search?q=authority"])("authenticates the legacy machine read route: %s", async route => {
    const denied = await mf.dispatchFetch(`https://main/api/kb-machine/${route}`, { headers: { authorization: "Bearer not-a-vended-credential" } });
    expect(denied.status).toBe(401);
  });

  it.each(["stats", "list", "search?q=authority"])("preserves authenticated machine reads: %s", async route => {
    const minted = await api("/api/kb/admin/tokens", { method: "POST", body: JSON.stringify({ label: `machine-read-${route.split("?")[0]}`, tags: ["agent"] }) }).then(r => r.json() as Promise<{ secret: string }>);
    const allowed = await mf.dispatchFetch(`https://main/api/kb-machine/${route}`, { headers: { authorization: `Bearer ${minted.secret}` } });
    expect(allowed.status, await allowed.text()).toBe(200);
  });

  it.each(["unknown", "gateway"])("never turns a %s bearer into a human desktop decision", async credential => {
    let secret = "not-a-vended-credential";
    if (credential === "gateway") secret = (await api("/api/kb/admin/tokens", { method: "POST", body: JSON.stringify({ label: "machine-act-gateway", tags: ["gateway"] }) }).then(r => r.json() as Promise<{ secret: string }>)).secret;
    const created = await api("/api/kb/create", { method: "POST", body: JSON.stringify({ type: "decision", title: `Real human choice ${credential}` }) }).then(r => r.json() as Promise<{ id: string }>);
    const denied = await mf.dispatchFetch("https://main/api/kb-machine/act", { method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify({ op: "transition", id: created.id, to: "accepted" }) });
    const text = await denied.text();
    const row = await api(`/api/kb/artefact?id=${encodeURIComponent(created.id)}`).then(r => r.json() as Promise<{ status: string }>);
    expect(denied.status, JSON.stringify({ text, status: row.status })).toBe(401);
    expect(row.status).toBe("proposed");
  });

  it("checks the actual target type on the human desktop decision route", async () => {
    const minted = await api("/api/kb/admin/tokens", { method: "POST", body: JSON.stringify({ label: "machine-act-extra", tags: ["gateway"] }) }).then(r => r.json() as Promise<{ secret: string }>);
    const created = await api("/api/kb/create", { method: "POST", body: JSON.stringify({ type: "task", title: "Decision route cannot retire a task" }) }).then(r => r.json() as Promise<{ id: string }>);
    await api("/api/kb/transition", { method: "POST", body: JSON.stringify({ id: created.id, to: "blocked", note: "Hold for a real disposition", await_event: { event: "time", until_ts: Date.now() + 3_600_000 } }) });
    const denied = await mf.dispatchFetch("https://main/api/kb-machine/act", { method: "POST", headers: { cookie, authorization: `Bearer ${minted.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ op: "transition", id: created.id, to: "superseded" }) });
    const text = await denied.text();
    const row = await api(`/api/kb/artefact?id=${encodeURIComponent(created.id)}`).then(r => r.json() as Promise<{ status: string }>);
    expect(denied.status, JSON.stringify({ text, status: row.status })).toBe(403);
    expect(row.status).toBe("blocked");
  });

  it("keeps the desktop decision action available to the authenticated human", async () => {
    const created = await api("/api/kb/create", { method: "POST", body: JSON.stringify({ type: "decision", title: "Authenticated desktop human choice" }) }).then(r => r.json() as Promise<{ id: string }>);
    const accepted = await api("/api/kb-machine/act", { method: "POST", body: JSON.stringify({ op: "transition", id: created.id, to: "accepted", actor: "web:forged", gateway: true, token_id: "forged-token" }) });
    expect(accepted.status, await accepted.text()).toBe(200);
    const history = await api(`/api/kb/history?id=${encodeURIComponent(created.id)}`).then(r => r.json() as Promise<{ versions: { actor: string; action: string }[] }>);
    expect(history.versions.some(v => v.actor === "web:ray" && v.action === "transition")).toBe(true);
  });

  it.each(["REST", "MCP"])("a reserved display label cannot confer human authority over %s", async transport => {
    const minted = await api("/api/kb/admin/tokens", { method: "POST", body: JSON.stringify({ label: "web", tags: ["agent"] }) }).then(r => r.json() as Promise<{ secret: string }>);
    const created = await api("/api/kb/create", { method: "POST", body: JSON.stringify({ type: "task", title: `Reserved-label authority ${transport}` }) }).then(r => r.json() as Promise<{ id: string }>);
    expect((await api("/api/kb/transition", { method: "POST", body: JSON.stringify({ id: created.id, to: "blocked", note: "Human-only terminal disposition remains pending",
      await_event: { event: "time", until_ts: Date.now() + 3_600_000 } }) })).status).toBe(200);
    const args = { id: created.id, to: "superseded", session: "reserved-label-proof" };
    const denied = await mf.dispatchFetch(`https://main${transport === "REST" ? "/api/kb/transition" : "/mcp"}`, { method: "POST",
      headers: { authorization: `Bearer ${minted.secret}`, "content-type": "application/json" },
      body: JSON.stringify(transport === "REST" ? args : { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "transition", arguments: args } }) });
    const text = await denied.text();
    const row = await api(`/api/kb/artefact?id=${encodeURIComponent(created.id)}`).then(r => r.json() as Promise<{ status: string }>);
    expect(denied.status, JSON.stringify({ text, status: row.status })).toBe(transport === "REST" ? 400 : 200);
    if (transport === "MCP") expect((JSON.parse(text) as { result: { isError: boolean } }).result.isError).toBe(true);
    expect(text).toContain("human-authority");
    expect(row.status).toBe("blocked");
  });

  it("derives gateway completion authority from the authenticated bearer, not forged REST fields", async () => {
    const minted = await api("/api/kb/admin/tokens", { method: "POST", body: JSON.stringify({ label: "rest-completion-gateway", tags: ["gateway"] }) }).then(r => r.json() as Promise<{ secret: string }>);
    const created = await api("/api/kb/create", { method: "POST", body: JSON.stringify({ type: "task", title: "REST gateway cannot author an outcome", roles: ["analysis"] }) }).then(r => r.json() as Promise<{ id: string }>);
    expect((await api("/api/kb/transition", { method: "POST", body: JSON.stringify({ id: created.id, to: "in_progress", session: "rest-gateway-proof" }) })).status).toBe(200);
    const refused = await mf.dispatchFetch("https://main/api/kb/transition", { method: "POST",
      headers: { authorization: `Bearer ${minted.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ id: created.id, to: "done", session: "rest-gateway-proof", actor: "web:forged", gateway: false, token_id: "forged-token",
        execution_result: { outcome: "Process exited zero", receipts: [created.id] } }) });
    expect(refused.status).toBe(400);
    expect((await refused.json() as { error: string }).error).toContain("gateway infrastructure cannot");
    const row = await api(`/api/kb/artefact?id=${encodeURIComponent(created.id)}`).then(r => r.json() as Promise<{ status: string }>);
    expect(row.status).toBe("in_progress");
  });

  it("preserves a real agent's REST identity and strips forged infrastructure attribution", async () => {
    const label = "rest-completion-agent";
    const minted = await api("/api/kb/admin/tokens", { method: "POST", body: JSON.stringify({ label, tags: ["agent"] }) }).then(r => r.json() as Promise<{ secret: string }>);
    const created = await api("/api/kb/create", { method: "POST", body: JSON.stringify({ type: "task", title: "REST agent authors its explicit finding", roles: ["analysis"] }) }).then(r => r.json() as Promise<{ id: string }>);
    const transition = (to: string) => mf.dispatchFetch("https://main/api/kb/transition", { method: "POST",
      headers: { authorization: `Bearer ${minted.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ id: created.id, to, session: "rest-agent-proof", gateway: true, agent: "pretend-other-agent",
        execution_result: { outcome: "Analysis findings recorded", receipts: [created.id] } }) });
    const claimed = await transition("in_progress");
    expect(claimed.status, await claimed.text()).toBe(200);
    const finished = await transition("done");
    expect(finished.status, await finished.text()).toBe(200);
    const row = await api(`/api/kb/artefact?id=${encodeURIComponent(created.id)}`).then(r => r.json() as Promise<{ status: string; owner: string }>);
    expect(row.status).toBe("done");
    expect(row.owner).toBe(label);
  });

  it("posts a web comment through to progress.log (200, logged, visible in history)", async () => {
    // verdict-duty tasks are claimable without qualification (role:review) —
    // same rig the throughput route test uses. The task must be in_progress:
    // unclaimed todo hits progressLog's claim-refusal early return (200 with
    // note_postscript, nothing logged — agent-claim semantics, out of scope
    // here), while the live repro was a comment on an in-progress card.
    const create = await api("/api/kb/create", {
      method: "POST",
      body: JSON.stringify({ type: "task", title: "web comment plane smoke", tags: ["role:review"] }),
    }).then((r) => r.json() as any);
    expect(create.id).toMatch(/^BR#\d+$/);
    const claim = await api("/api/kb/transition", { method: "POST", body: JSON.stringify({ id: create.id, to: "in_progress", note: "claim" }) });
    expect(claim.status).toBe(200);

    const note = "human comment from the web UI — must land on the card history";
    const res = await api("/api/kb/progress", {
      method: "POST",
      body: JSON.stringify({ id: create.id, note }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // content-verified (AGENTS.md rule 1): the note echoes back AND lands in
    // the task history the TaskDetail comment thread reads
    expect(body.error).toBeUndefined();
    expect(body.note).toBe(note);
    expect(body.note_postscript).toBeUndefined(); // full log path, not the claim refusal

    const hist = await api(`/api/kb/history?id=${encodeURIComponent(create.id)}`).then((r) => r.json() as any);
    const logged = (hist.versions ?? []).filter((v: any) => v.action === "progress");
    expect(logged.some((v: any) => (v.summary ?? "").includes("web UI — must land"))).toBe(true);
  });

  it("keeps the allowlist strict: an unknown sub still 404s on the route plane", async () => {
    const res = await api("/api/kb/not-an-op", { method: "POST", body: JSON.stringify({ id: "BR#1" }) });
    expect(res.status).toBe(404);
  });

  it("still maps ask_answer → ask.answer (domain response, never an op-mapping 404)", async () => {
    // a bogus id gets a DO domain error — the point is it is NOT the route's
    // bare "not found" (the op reached the DO switch)
    const res = await api("/api/kb/ask_answer", { method: "POST", body: JSON.stringify({ id: "BR#999999", answer: "x" }) });
    const text = await res.text();
    expect(text).not.toContain("unknown op");
    expect(text === "not found").toBe(false);
  });
});

// ---- legs 2 + 3: source assertions on the ui-kit views (no UI rig exists) ----

const askBandSrc = readFileSync(new URL("../../ui-kit/src/views/AskBand.tsx", import.meta.url).pathname, "utf8");
const taskDetailSrc = readFileSync(new URL("../../ui-kit/src/views/TaskDetail.tsx", import.meta.url).pathname, "utf8");

describe("AskBand rows render their artefact id (BR#3462 leg 2)", () => {
  const rowFns = ["function BandVerdictRow", "function BandDecisionRow", "function BandNodeAskRow"];
  for (const fn of rowFns) {
    it(`${fn.slice(9)} renders the artefact id as a visible mono chip`, () => {
      const start = askBandSrc.indexOf(fn);
      expect(start).toBeGreaterThan(-1);
      const body = askBandSrc.slice(start, askBandSrc.indexOf("\nfunction ", start + 1) === -1 ? askBandSrc.length : askBandSrc.indexOf("\nfunction ", start + 1));
      // the .ab-id mono chip class (the established id-render pattern —
      // TaskDetail:354 / ForMeView:138) with the row's artefact id inside
      expect(body).toContain("ab-id");
      expect(body).toMatch(/ab-id">\{(latest|d|nodeAsk)\.id\}/);
    });
  }
});

describe("TaskDetail loads artefact/related/history in parallel (BR#3462 leg 3)", () => {
  it("issues the three section loads together (allSettled), not as a sequential await chain", () => {
    // the load effect must NOT contain the old sequential chain
    // (artefact → related → history, each awaiting the previous)
    expect(taskDetailSrc).toContain("Promise.allSettled");
    expect(taskDetailSrc).not.toMatch(/await kbApi\.artefact[\s\S]{0,400}await kbApi\.related[\s\S]{0,400}await kbApi\.history/);
    // per-section error handling, correctly labeled (the old catches both said
    // "load task relations" — including the history one)
    expect(taskDetailSrc).toContain("load related tasks");
    expect(taskDetailSrc).toContain("load history");
    expect(taskDetailSrc).not.toContain('reportError("load task relations"');
  });

  it("bounds the non-essential related load with a timeout (renders without it)", () => {
    expect(taskDetailSrc).toMatch(/RELATED_TIMEOUT|related.*timeout/i);
  });

  it("surfaces the server error on a failed comment instead of a bare 'comment failed'", () => {
    expect(taskDetailSrc).toMatch(/comment failed: \$\{\(e as Error\)\.message\}/);
  });
});

describe("BandNodeAskRow offers a typed answer as the last option (BR#3912)", () => {
  // Source assertion on the real component (no UI rig exists — repo
  // convention): an options-only ask row cannot be answered in one place when
  // the option IS a promise to write something ("RE-SCOPE — I'll rewrite the
  // card myself"). The row must carry the type-your-own affordance inline.
  const start = askBandSrc.indexOf("function BandNodeAskRow");
  const body = askBandSrc.slice(start, askBandSrc.indexOf("\nfunction ", start + 1) === -1 ? askBandSrc.length : askBandSrc.indexOf("\nfunction ", start + 1));

  it("renders the type-your-own toggle after the option buttons", () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("type your own answer…");
    // the affordance comes last: options first, free text as the final row
    expect(body.indexOf("AskOptions")).toBeGreaterThan(-1);
    expect(body.indexOf("type your own answer…")).toBeGreaterThan(body.indexOf("AskOptions"));
  });

  it("submits the typed text through the same askAnswer path as a click", () => {
    expect(body).toContain("TextInput");
    expect(body).toMatch(/void answer\(custom\)/);
    // no silent sends: empty text and busy both disable/ignore submission
    expect(body).toMatch(/!custom\.trim\(\) \|\| !busy|custom\.trim\(\) && !busy/);
  });
});

describe("GET /api/kb/train — the merge-train mirror (Top panel leg 1)", () => {
  it("mirrors the DO's train.status snapshot: {lanes: []} on a fresh DO, 200 with the allowlist mapping", async () => {
    // before index.js mapped the sub, this was the route's bare 404 "not found"
    const res = await api("/api/kb/train");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.lanes)).toBe(true);
    expect(body.lanes).toEqual([]);
  });

  it("forwards the repo filter query to the DO (lane filtering stays server-side)", async () => {
    const res = await api("/api/kb/train?repo=state-vector/bridge");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.lanes)).toBe(true);
  });
});

describe("GET /api/kb/execution_attention — reachable human attention route", () => {
  it("returns the typed attention snapshot through the authenticated public GET route", async () => {
    const response = await api("/api/kb/execution_attention?project=bridge");
    expect(response.status).toBe(200);
    const snapshot = ExecutionAttentionSchema.parse(await response.json());
    expect(snapshot.items).toEqual([]);
    expect(snapshot.interactive_agents).toBeDefined();
  });

  it("still requires authentication, and does not accept POST as a read", async () => {
    const response = await mf.dispatchFetch("https://main/api/kb/execution_attention");
    expect(response.status).toBe(401);
    expect((await api("/api/kb/execution_attention", { method: "POST", body: "{}" })).status).toBe(404);
  });
});

describe("Claim-locally takeover prompt carries the worktree registry contract (2026-11-02)", () => {
  // The sweep enumerates REGISTERED trees only — an unregistered tree is
  // never swept. The prompt that directs a local session to create a
  // worktree must therefore also direct it to REGISTER the worktree:
  // without the registration one-liner the directed tree leaks by design.
  const claimSrc = readFileSync(new URL("../../ui-kit/src/views/claimLocally.tsx", import.meta.url).pathname, "utf8");
  it("SHARED-CHECKOUT DISCIPLINE carries the registry append one-liner + the removal duty", () => {
    expect(claimSrc).toMatch(/SHARED-CHECKOUT DISCIPLINE/);
    expect(claimSrc).toContain("worktree-registry.jsonl");
    expect(claimSrc).toMatch(/"path":"<ABS worktree path>"/);
    expect(claimSrc).toContain("REGISTER it");
    expect(claimSrc).toContain("an unregistered tree is never swept");
  });
});

describe("Top view renders the merge-train panel first (train panel legs 2+3)", () => {
  // Source assertions on the real views (no UI rig exists — repo convention):
  // the panel must sit at the very top of Top (before the dashboard strip) and
  // must surface WHICH MACHINE holds each lane's CAS lease + the queued cards.
  const topViewSrc = readFileSync(new URL("../../ui-kit/src/views/TopView.tsx", import.meta.url).pathname, "utf8");
  const trainPanelSrc = readFileSync(new URL("../../ui-kit/src/views/TrainPanel.tsx", import.meta.url).pathname, "utf8");

  it("renders TrainPanel as the first panel in top-wrap (above DashboardSummary)", () => {
    expect(topViewSrc).toContain("<TrainPanel");
    expect(topViewSrc.indexOf("<TrainPanel")).toBeGreaterThan(-1);
    expect(topViewSrc.indexOf("<TrainPanel")).toBeLessThan(topViewSrc.indexOf("<DashboardSummary"));
  });

  it("keeps the stop-line cause, checks and recovery next to its affected lane", () => {
    // the banner keys off the hub-served resolution block and speaks Ray's
    // plain words: what's broken, what fixes it, what we need from you
    expect(trainPanelSrc).toContain("lane.line ?? unavailable");
    expect(trainPanelSrc).toContain("Checks:");
    expect(trainPanelSrc).toContain("{line.reason}");
    expect(trainPanelSrc).toContain("Recovery:");
    // BR#6390: the banner names the human gate, not a bypass suggestion —
    // "merge the fix PR yourself, then click DONE in the ask"
    expect(trainPanelSrc).toContain("Your action:");
    expect(trainPanelSrc).toContain("Open the action request");
    expect(trainPanelSrc).not.toContain("function laneStatus(");
    expect(trainPanelSrc).not.toContain("function StalledBanner(");
    expect(trainPanelSrc.indexOf("<LineStopBanner lane={l}")).toBeGreaterThan(trainPanelSrc.indexOf('className="ktable-row train-row"'));
  });

  it("shows the CAS lock holder machine with a live heartbeat age per lane", () => {
    expect(trainPanelSrc).toMatch(/l\.lease\?\.holder/);
    expect(trainPanelSrc).toContain("lock ");
    expect(trainPanelSrc).toContain("age(l.lease?.heartbeat_ts ?? l.capable?.at, now)");
    // the free case is explicit, never blank — and ready vs gateway-less are
    // DISTINCT states (2026-10-29, Ray): an idle lane names the machine that
    // last ticked it; only a stale-capable lane reads as gateway-less. Copy
    // per the status-pill redesign: labels "train ready" / "no gateway" (the
    // machine + tick age live in the pill's tooltip).
    expect(trainPanelSrc).not.toContain("lock free");
    // BR#5114 round 2: the pills speak human — "ready" / "no machine" —
    // and the machine detail lives in the tooltip
    expect(trainPanelSrc).toContain("No executor reported");
  });

  it("renders Ray's column spec — STATUS / CURRENT (card+PR links) / PROGRESS / MSG / RATE / BACKLOG (BR#5114 round 3)", () => {
    // STATUS carries the current PR inline (Ray: combine — "Checking BR#123 (PR #456)")
    expect(trainPanelSrc).toContain("{line.label}");
    expect(trainPanelSrc).toContain("https://github.com/${repo}/pull/${l.currently.pr}");
    // PROGRESS: x of y in the current batch
    expect(trainPanelSrc).toMatch(/merged this batch/);
    expect(trainPanelSrc).toContain("Merged — checking deployment");
    // BACKLOG (BR#5412, Ray: the queue-block row = THE BATCH): only the
    // cars the machine's walk stamped ready this pass render — the
    // mergeable set, not the audit trail; head ringed; click opens the card
    expect(trainPanelSrc).toMatch(/train-blocks/);
    expect(trainPanelSrc).toContain('q.state === "ready"');
    expect(trainPanelSrc).not.toContain("l.queue_facts?.entries.find");
    expect(trainPanelSrc).toMatch(/openTask\?\.\(q\.id\)/);
    expect(trainPanelSrc).toContain("line.remediation?.text ?? line.reason");
    // errors surface in-panel — nothing in the kit may swallow an error
    expect(trainPanelSrc).toMatch(/train status unavailable/);
  });

  it("renders the PRs column as 3-bucket PR stats (in progress · verifying · ready) + sequential merge batches coloured strictly by verification state (BR#5658 v2, Ray 2026-11-03)", () => {
    // 1. strictly 3-bucket lane PR stats: in progress · verifying · ready (no 4th waiting stat)
    expect(trainPanelSrc).toMatch(/train-stats/);
    expect(trainPanelSrc).toMatch(/ts-ip/);
    expect(trainPanelSrc).toMatch(/ts-verifying/);
    expect(trainPanelSrc).toMatch(/ts-ready/);
    expect(trainPanelSrc).not.toMatch(/ts-waiting/);
    // 2. sequential merge batches (Batch 1 | Batch 2 | …) separated by .train-block-gap
    expect(trainPanelSrc).toMatch(/train-block-group/);
    expect(trainPanelSrc).toMatch(/train-block-gap/);
    expect(trainPanelSrc).toMatch(/Batch \$\{bi \+ 1\}/);
    // 3. verification colour law: green = ready (.tb-ready), orange pulsing =
    // being verified (.tb-verifying), orange solid = waiting to be verified (.tb-wait);
    // no red on awaiting parks (BR#5476)
    expect(trainPanelSrc).toContain('q.state === "ready"');
    expect(trainPanelSrc).toMatch(/tb-ready/);
    expect(trainPanelSrc).toMatch(/tb-verifying/);
    expect(trainPanelSrc).toMatch(/tb-wait/);
    expect(trainPanelSrc).not.toMatch(/tb-awaiting-lapsed/);
    // a parked card or non-zero PR stat keeps the lane's signal lit
    expect(trainPanelSrc).toContain("l.pr_stats ??");
  });

  it("shows activity: what the train is working on, for how long, queue depth + head, and merge throughput (1h/24h) with the last executor event", () => {
    // in-flight phase (STATUS pill maps phases to words)
    expect(trainPanelSrc).toContain("l.currently?.phase");
    // MSG: the freshest true message — the live machine note (aged out at
    // the lease TTL), else the attempt sentence, else the last ledger action
    expect(trainPanelSrc).toContain("line.remediation?.text ?? line.reason");
    // RATE: merges per hour / 24h
    expect(trainPanelSrc).toMatch(/l\.activity\?\.merged_1h/);
    expect(trainPanelSrc).toContain("/24h");
    expect(trainPanelSrc).toContain("line.observed_at");
  });

  it("keeps historical return counts in readable details and active escalation clocks separate", () => {
    const kbServerSrc = readFileSync(new URL("../../ui-kit/src/server/kb.ts", import.meta.url).pathname, "utf8");
    // queue chips carry the ledger bounce count; over budget reads as an error, never a green chip
    expect(trainPanelSrc).toMatch(/q\.over_budget/);
    expect(trainPanelSrc).not.toContain("train-bounce-chip");
    expect(trainPanelSrc).not.toMatch(/×\{q\.bounces\}/);
    expect(trainPanelSrc).toContain("Returned to repair/review");
    expect(trainPanelSrc).toContain("active bounce-budget escalation");
    // de-queued escalations ride their own clock chips: ⏳ pr ×bounce_no, err once expired
    expect(trainPanelSrc).toMatch(/l\.escalations/);
    expect(trainPanelSrc).toContain("⏳");
    expect(trainPanelSrc).toMatch(/e\.expired \? "err" : "warn"/);
    expect(trainPanelSrc).toMatch(/e\.grace_until/);
    // the server type carries both surfaces (the panel consumes the snapshot shape)
    expect(kbServerSrc).toMatch(/over_budget\?: boolean/);
    expect(kbServerSrc).toMatch(/escalations\?:/);
    expect(kbServerSrc).toMatch(/expired: boolean/);
  });
});

describe("POST /api/kb/force_review — the human force-review plane (BR#4962)", () => {
  // The pull model's ONE human writer: web session cookie only (BR#4960 —
  // zero asks, so the route is the answer path). Behavioral leg: a
  // session-cookie POST reaches the DO op — a bogus id comes back as the
  // DO's typed validation error, proving the route forwarded (a route miss
  // would 404 "not found" at the web plane instead). Source legs: the route
  // maps sub force_review → card.force_review and rejects gateway bearers
  // 403 web/human-only.
  const indexSrc = readFileSync(new URL("../src/index.js", import.meta.url).pathname, "utf8");

  it("a session-cookie POST forwards to the DO op (bogus id → the DO's 'no such artefact' error, not a 404 route miss)", async () => {
    const res = await api("/api/kb/force_review", {
      method: "POST",
      body: JSON.stringify({ id: "BR#999999", decision: "approve" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(String(body.error)).toContain("no such artefact");
  });

  it("route maps sub force_review → card.force_review and 403s bearer auth (web/human-only, BR#4960)", () => {
    expect(indexSrc).toContain('if (sub === "force_review" && request.method === "POST")');
    expect(indexSrc).toContain('"https://kb/card.force_review"');
    expect(indexSrc).toContain("force_review is web/human-only (BR#4960)");
  });

  it("views: the awaiting exit class parses the typed park reason BEFORE the ask checks and orders after ask in EXIT_CLASS_ORDER (BR#4962)", () => {
    const viewsSrc = readFileSync(new URL("../../ui-kit/src/server/views.ts", import.meta.url).pathname, "utf8");
    expect(viewsSrc).toContain("const AWAITING_RX = /^Awaiting review \\(verdict /i");
    // ordering: the park reason must classify as awaiting even though a
    // blocked shape the ask check would otherwise eat reaches it first
    expect(viewsSrc.indexOf("AWAITING_RX.test(reason)")).toBeGreaterThan(-1);
    expect(viewsSrc.indexOf("AWAITING_RX.test(reason)")).toBeLessThan(viewsSrc.indexOf('ev === "ask"'));
    expect(viewsSrc).toContain('"ask", "awaiting"');
  });
});

describe("TrainPanel stop-the-line banner — who broke it + who is fixing it (BR#4849)", () => {
  // Source assertions on the real component (no UI rig exists — repo
  // convention, Ray 2026-10-29: "its critical we reflect this and show a) who
  // broke it and b) who is fixing it"): a red main must be the loudest thing
  // on the panel, the two accountability answers must render, and UNOWNED
  // must be impossible to miss.
  const trainPanelSrc = readFileSync(new URL("../../ui-kit/src/views/TrainPanel.tsx", import.meta.url).pathname, "utf8");

  it("renders the banner only for a current typed main-failed stop, above the lane table", () => {
    expect(trainPanelSrc).toContain('l.line?.phase === "base_red"');
    expect(trainPanelSrc).toContain("STOP-THE-LINE");
    // banner markup sits before the column head in source order — it is read first
    expect(trainPanelSrc.indexOf("train-stopline")).toBeGreaterThan(-1);
    expect(trainPanelSrc.indexOf("train-stopline")).toBeLessThan(trainPanelSrc.indexOf("train-head-cols"));
  });

  it("shows the recorded culprit or an unconfirmed landing for the failing commit", () => {
    expect(trainPanelSrc).toMatch(/stopped\s*\?\s*stopped\.culprit_task/);
    expect(trainPanelSrc).toContain("broke it:");
    expect(trainPanelSrc).toMatch(/failingSha\s*&&\s*l\.last_merge\?\.merge_sha\s*===\s*failingSha/);
    expect(trainPanelSrc).toContain("landing at the failing commit, unconfirmed");
  });

  it("answers WHO IS FIXING IT: the episode task with owner/executor — or a loud UNOWNED chip", () => {
    expect(trainPanelSrc).toContain("fixing it:");
    expect(trainPanelSrc).toMatch(/red\.owner \|\| red\.executor_session/);
    expect(trainPanelSrc).toContain("UNOWNED — nobody is fixing it");
    // the fixer line click-opens the episode task
    expect(trainPanelSrc).toMatch(/openTask\?\.\(red\.id\)/);
  });

  it("the lane status pill consumes only the typed line projection", () => {
    expect(trainPanelSrc).toContain('tone={tones[line.phase]} title={line.reason}>{line.label}');
  });
});
