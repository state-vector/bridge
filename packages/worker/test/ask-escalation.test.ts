import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Ask TTL escalation (BR#3942) — real DO drill against the bundled worker.
 *
 * The BR#3930 incident: a verdict duty filed an ask addressed to an OFFLINE
 * agent identity (macbook-pro-local-opencode, direct token last_seen=null).
 * Nothing re-routed it — the human (final escalation) saw nothing, the lane
 * starved until Ray released the card by hand. The fix: the sweep stamps
 * meta.ask.escalated ON THE SAME NODE when an agent-addressed ask sits
 * unanswered past the TTL with the addressee offline (one re-route, no
 * duplicate asks); board() projects addressee presence so the human planes
 * can show "asked to X (offline, N min ago)".
 *
 * Clock discipline: ask created_ts is real (Date.now() at create); the drill
 * door takes `now` — inject a future clock instead of sleeping the TTL.
 */

let mf: Miniflare;
let kb: (path: string, init?: RequestInit) => Promise<Response>;
let t0 = Date.now();

async function kbJson(path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await kb(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

beforeAll(async () => {
  t0 = Date.now();
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  if (!existsSync(bundle)) {
    throw new Error("bundle missing — run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle (the npm test script does this before vitest)");
  }
  mf = new Miniflare({
    workers: [{
      name: "main",
      scriptPath: bundle,
      modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")),
      modules: true,
      compatibilityDate: "2025-09-06",
      durableObjects: {
        HUB: { className: "FlowsHub", useSQLite: true },
        KB: { className: "KnowledgeHub", useSQLite: true },
      },
    }],
  });
  const ns = await mf.getDurableObjectNamespace("KB");
  const stub = await ns.get(ns.idFromName("global"));
  kb = (path, init) => stub.fetch(`https://kb${path}`, init);
  await kbJson("/orient", { actor: "test" });
});

afterAll(async () => {
  await mf?.dispose();
});

/** an in_progress task bound to a fresh ask addressed to `to` */
async function askOnInProgressTask(to: string, question: string): Promise<{ askId: string; taskId: string }> {
  const task = await kbJson("/create", {
    type: "task", title: `escalation drill carrier — ${to}`, body_md: "drill", actor: "escal-driller",
  });
  expect(task.status, JSON.stringify(task.body)).toBe(200);
  const taskId = String(task.body.id);
  const tr = await kbJson("/transition", { id: taskId, to: "in_progress", actor: "escal-driller", session: "escal-driller" });
  expect(tr.status, JSON.stringify(tr.body)).toBe(200);
  const ask = await kbJson("/ask.create", {
    to, question, reason: "drill — addressee offline escalation",
    options: ["RELEASE — back to the pool", "KEEP — keep it blocked"], artefact_id: taskId,
  });
  expect(ask.status, JSON.stringify(ask.body)).toBe(200);
  return { askId: String(ask.body.id), taskId };
}

describe("ask TTL escalation (real DO)", () => {
  it("escalates an ask to a never-seen agent identity past the default TTL — same node, options intact, human-visible on the board", async () => {
    const { askId, taskId } = await askOnInProgressTask(
      "escal-ghost-agent", // never connected: no auth token, no gateway edge
      "Will you release the carrier task now that its unblock atom can never fire?",
    );
    // bound task is blocked-on-ask (rule 6) before the escalation
    const before = await kbJson("/get", { id: taskId });
    expect(before.body.status).toBe("blocked");

    const sweep = await kbJson("/admin.ask_escalation_sweep", { now: t0 + 31 * 60_000 });
    expect(sweep.status, JSON.stringify(sweep.body)).toBe(200);
    expect(sweep.body.escalated).toContain(askId);

    // the SAME node carries the escalation — no duplicate ask was minted
    const node = await kbJson("/get", { id: askId });
    expect(node.body.type).toBe("question");
    const esc = node.body.meta?.ask?.escalated;
    expect(esc).toBeTruthy();
    expect(esc.from_target).toBe("escal-ghost-agent");
    expect(esc.ttl_min).toBe(30); // the default TTL
    expect(String(esc.reason)).toMatch(/offline/);
    expect(node.body.meta.ask.options).toEqual(["RELEASE — back to the pool", "KEEP — keep it blocked"]);
    expect(node.body.status).toBe("todo"); // still the one open ask, re-routed not re-asked

    // addressee presence rides the board payload (never-seen → offline/unknown)
    const board = await kb("/board");
    const boardBody = await board.json();
    const row = (boardBody.tasks ?? []).find((x: any) => x.id === askId);
    expect(row?.ask_target).toMatchObject({ online: false, last_seen_ts: null, source: "unknown" });
    expect(row?.meta?.ask?.escalated).toBeTruthy();

    // the escalation is audited + versioned (receipts, not side effects)
    const ev = await kb("/events?since=0&limit=500");
    const evBody = await ev.json();
    const audited = (evBody.events ?? []).some((e: any) => e.op === "ask_escalated" && e.artefact_id === askId);
    expect(audited).toBe(true);
  });

  it("is idempotent — a second sweep never duplicates the escalation", async () => {
    const sweep = await kbJson("/admin.ask_escalation_sweep", { now: t0 + 32 * 60_000 });
    expect(sweep.status).toBe(200);
    expect(sweep.body.escalated).toEqual([]); // already stamped → skipped
  });

  it("below the TTL nothing escalates — even a never-seen identity gets its window", async () => {
    const { askId } = await askOnInProgressTask(
      "escal-ghost-agent",
      "Will you release the TTL-window carrier task before its window closes?",
    );
    // +5 min with the default 30-min TTL: aged, offline, but inside its window
    const sweep = await kbJson("/admin.ask_escalation_sweep", { now: t0 + 5 * 60_000 });
    expect(sweep.body.escalated).not.toContain(askId);
    const node = await kbJson("/get", { id: askId });
    expect(node.body.meta?.ask?.escalated).toBeFalsy();
  });

  it("human-directed, open-floor and session-scoped asks never escalate — only agent-identity targets re-route", async () => {
    const human = await kbJson("/ask.create", {
      to: "ray", question: "Human ruling drill — never re-route this?",
      reason: "drill", options: ["GO", "NO-GO"], artefact_id: null,
      details: "drill brief: fixture ask exercising that ray-directed asks never re-route to agent identities.",
    });
    const any = await kbJson("/ask.create", {
      to: "any", question: "Open-floor drill — never re-route this?", reason: "drill",
      options: ["GO", "NO-GO"], artefact_id: null,
    });
    const scoped = await kbJson("/ask.create", {
      to: "escal-ghost-agent@dispatch-42", question: "Session-scoped drill — never re-route this?", reason: "drill",
      options: ["GO", "NO-GO"], artefact_id: null,
    });
    expect(human.status).toBe(200);
    expect(any.status).toBe(200);
    expect(scoped.status).toBe(200);
    const sweep = await kbJson("/admin.ask_escalation_sweep", { now: t0 + 34 * 60_000 });
    expect(sweep.body.escalated).not.toContain(String(human.body.id));
    expect(sweep.body.escalated).not.toContain(String(any.body.id));
    expect(sweep.body.escalated).not.toContain(String(scoped.body.id));
  });

  it("answering an escalated ask still dispatches — resume AND release-class answers both work (the BR#3822 hand-release, automated)", async () => {
    // the ghost ask from test 1 is bound to its blocked carrier task
    const board = await kb("/board");
    const boardBody = await board.json();
    const askRow = (boardBody.tasks ?? []).find((x: any) => x.id && x.meta?.ask?.escalated);
    expect(askRow).toBeTruthy();

    // generic rule-6 resume: a GO-class answer (no option-word hit) resumes
    const ans = await kbJson("/ask.answer", { id: askRow.id, answer: "GO — approved per the receipts on this ask", actor: "web:rayh" });
    expect(ans.status, JSON.stringify(ans.body)).toBe(200);
    expect(ans.body.task_status).toBe("in_progress");
    const task = await kbJson("/get", { id: askRow.meta.ask.artefact_id });
    expect(task.body.status).toBe("in_progress"); // the answer auto-resumed the bound task
  });

  it("a RELEASE-class answer on an escalated ask releases the subject to the pool — the BR#3822 hand-release, now one click", async () => {
    const { askId, taskId } = await askOnInProgressTask(
      "escal-ghost-agent-3", "Will you release the third carrier task now that its atom can never fire?",
    );
    // age + escalate it first
    const sweep = await kbJson("/admin.ask_escalation_sweep", { now: t0 + 40 * 60_000 });
    expect(sweep.body.escalated).toContain(askId);
    // the human clicks the original RELEASE option on the escalated ask
    const ans = await kbJson("/ask.answer", { id: askId, answer: "RELEASE — back to the pool", actor: "web:rayh" });
    expect(ans.status, JSON.stringify(ans.body)).toBe(200);
    expect(ans.body.task_status).toBe("todo");
    const task = await kbJson("/get", { id: taskId });
    expect(task.body.status).toBe("todo"); // released to the pool, exactly as the option says
  });

  it("the TTL honours ask_escalation_minutes (clamped to ≥5) — the presence differential at one clock", async () => {
    const set = await kbJson("/admin.settings_set", { settings: { ask_escalation_minutes: 1 } });
    expect(set.status, JSON.stringify(set.body)).toBe(200);

    // fresh pair at the tightened TTL: ghost (offline) vs live (online)
    const ghost = await askOnInProgressTask(
      "escal-ghost-agent-2", "Will you release the second carrier task at the tightened TTL?",
    );
    const mint = await kbJson("/admin.mint", { label: "escal-live-agent-2", tags: [] });
    expect(mint.status, JSON.stringify(mint.body)).toBe(200);
    const ident = await kbJson("/auth.identify", { bearer: mint.body.secret });
    expect(ident.status, JSON.stringify(ident.body)).toBe(200);
    const live = await askOnInProgressTask(
      "escal-live-agent-2", "Will you release the second live carrier task at the tightened TTL?",
    );

    // +6 min past the ASK'S OWN created_ts (immune to test-runtime jitter):
    // past the clamped 5-min TTL; the live token was identified at ~created
    // (real clock), inside the 10-min presence window of this mildly-injected
    // clock, while the ghost was never seen — ONLY presence separates them.
    const ghostNode = await kbJson("/get", { id: ghost.askId });
    const created = Number(ghostNode.body.created_ts);
    const sweep = await kbJson("/admin.ask_escalation_sweep", { now: created + 360_000 });
    expect(sweep.body.escalated).toContain(ghost.askId);
    expect(sweep.body.escalated).not.toContain(live.askId);

    // restore the default so later sweeps on this DO stay conventional
    await kbJson("/admin.settings_set", { settings: { ask_escalation_minutes: 30 } });
  });

  it("the alarm sweep carries the escalation step (source-level, so prod can't drift from the drill)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/kb/do.ts", import.meta.url), "utf8");
    expect(src).toContain("await this.escalateStaleAsks(now0)");
  });
});
