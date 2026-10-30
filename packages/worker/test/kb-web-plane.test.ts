import { Miniflare } from "miniflare";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

function sessionCookie(login = "ray", ws = "global") {
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

  it("shows the CAS lock holder machine with a live heartbeat age per lane", () => {
    expect(trainPanelSrc).toMatch(/l\.lease\?\.holder/);
    expect(trainPanelSrc).toContain("lock ");
    expect(trainPanelSrc).toMatch(/age\(l\.lease\.heartbeat_ts, now\)/);
    // the free case is explicit, never blank — and ready vs gateway-less are
    // DISTINCT states (2026-10-29, Ray): an idle lane names the machine that
    // last ticked it; only a stale-capable lane reads as gateway-less. Copy
    // per the status-pill redesign: labels "train ready" / "no gateway" (the
    // machine + tick age live in the pill's tooltip).
    expect(trainPanelSrc).not.toContain("lock free");
    // BR#5114 round 2: the pills speak human — "ready" / "no machine" —
    // and the machine detail lives in the tooltip
    expect(trainPanelSrc).toMatch(/label: "ready"/);
    expect(trainPanelSrc).toMatch(/l\.capable\?\.ready/);
    expect(trainPanelSrc).toMatch(/label: "no machine"/);
  });

  it("renders Ray's column spec — STATUS / CURRENT (card+PR links) / PROGRESS / MSG / RATE / BACKLOG (BR#5114 round 3)", () => {
    // STATUS carries the current PR inline (Ray: combine — "Checking BR#123 (PR #456)")
    expect(trainPanelSrc).toMatch(/checking \$\{l\.attempt\.card\}/);
    expect(trainPanelSrc).toMatch(/github\.com\/\$\{repo}\/pull\/\$\{st\.pr\}/);
    expect(trainPanelSrc).toContain("waiting on review");
    // PROGRESS: x of y in the current batch
    expect(trainPanelSrc).toMatch(/merged this batch/);
    expect(trainPanelSrc).toMatch(/1 of 1 merged — settling/);
    // BACKLOG: the count + how many need reviews
    expect(trainPanelSrc).toMatch(/queued\{l\.queue_awaiting_review \? ` · \$\{l\.queue_awaiting_review\} need reviews` : ""\}/);
    expect(trainPanelSrc).toContain("stopped — main is red");
    // errors surface in-panel — nothing in the kit may swallow an error
    expect(trainPanelSrc).toMatch(/train status unavailable/);
  });

  it("renders Awaiting parks as age chips, worst (lapsed) tone winning — the force-review queue replaces the ask band (BR#4962 per BR#4960)", () => {
    // the DO sorts awaiting parks oldest-first; the panel renders the tones
    // only — no parked card may sit without a visible age, and a lapsed park
    // (past TTL + grace) must read urgent, aging warn. The ask-era chips are
    // GONE: zero asks ride the lanes (BR#4960), the parks are the visibility.
    expect(trainPanelSrc).toMatch(/\(l\.awaiting \?\? \[\]\)\.map/);
    expect(trainPanelSrc).toMatch(/a\.lapsed \? "urgent" : a\.aging \? "warn" : "scope"/);
    expect(trainPanelSrc).toMatch(/age\(Date\.now\(\) - a\.age_ms, Date\.now\(\)\)/);
    expect(trainPanelSrc).toContain("◉ awaiting");
    expect(trainPanelSrc).toContain("force-review from the backlog");
    // a parked card keeps the lane's signal lit even with an empty queue
    expect(trainPanelSrc).toMatch(/l\.awaiting\?\.length/);
  });

  it("shows activity: what the train is working on, for how long, queue depth + head, and merge throughput (1h/24h) with the last executor event", () => {
    // in-flight phase (STATUS pill maps phases to words)
    expect(trainPanelSrc).toMatch(/l\.currently\.phase/);
    // MSG: the freshest true message — the live machine note (aged out at
    // the lease TTL), else the attempt sentence, else the last ledger action
    expect(trainPanelSrc).toMatch(/l\.now_action/);
    expect(trainPanelSrc).toMatch(/nowAction\(l, now\)/);
    expect(trainPanelSrc).toContain("ageSec > 300");
    // RATE: merges per hour / 24h
    expect(trainPanelSrc).toMatch(/l\.activity\?\.merged_1h/);
    expect(trainPanelSrc).toContain("/24h");
    expect(trainPanelSrc).toMatch(/l\.activity\.last_event\.kind/);
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
