import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCardIdRefs } from "../src/kb/core.ts";

/**
 * BR#6432 — apply an ANSWERED batch SUPERSEDE authorization without
 * re-asking the human once per card.
 *
 * The incident: Ray authorized 29 strand-park drops in the answered ask
 * BR#6387 ("SUPERSEDE all 29 — 6 dead + 23 conflicting parks"), but the
 * answer misfired onto the bound disposition task (BR#6383). A replacement
 * executor's 29 direct supersedes hit the supersede-authority gate
 * (BR#2480 — dropping work is human authority); the honest per-card path
 * (BR#6409, which dropped BR#4494) meant 29 repeat human asks.
 *
 * The fix completes the BR#6395 batch-answer design: the resumed executor
 * re-checks each target's CURRENT state and carries
 * `transition {to:"superseded", batch_auth:{ask:"BR#N"}}`; the HUB does the
 * authority work server-side — verify the ask was answered by a human
 * principal, verify the answer is a batch SUPERSEDE authorization, scope
 * the drop to the card ids the ask body names, recheck the target is still
 * an open park, then execute exactly like the per-card answer dispatch
 * (system:question(<answered_by>), human_verdict) and stamp provenance.
 *
 * Pinned here:
 *   A. parseCardIdRefs — the receipt-scope grammar (BR#N, BR-N, slash
 *      chains, legacy TASK- ids; bare #N PR refs never match);
 *   B. the happy path — two parks dropped citing one answered ask, each
 *      stamped meta.batch_auth, the bound disposition task NOT dropped;
 *   C. every refusal typed and audited: out-of-scope target, target not an
 *      open park, unanswered ask, non-human answerer, non-batch answer,
 *      "only"-scoped answers resolve to exactly the ids they name,
 *      lane/infrastructure cards outside batch scope.
 */

// ---------- rig ----------

let mf: Miniflare;
let kbNs: any;

const kbJson = async (path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const stub: any = await kbNs.get(kbNs.idFromName("global"));
  const res = await stub.fetch(`https://kb${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

const task = async (title: string): Promise<string> => {
  const r = await kbJson("/create", { type: "task", title });
  expect(r.status, `create failed: ${JSON.stringify(r.body)}`).toBe(200);
  return String(r.body.id);
};

/** Authority-only fixture, with no outstanding delivery. PR-bound terminal
 * dispositions have the additional conservation guard (delivery-integrity). */
const park = async (id: string, repo: string, n: number, actor: string) => {
  expect((await kbJson("/transition", { id, to: "in_progress", actor, note: "impl" })).status).toBe(200);
  const p = await kbJson("/transition", {
    id, to: "blocked", actor,
    note: `Authority drill park ${n} for ${repo}; no outstanding PR binding.`,
    await_event: { event: "time", until_ts: Date.now() + 24 * 3_600_000 },
  });
  expect(p.status, `park failed: ${JSON.stringify(p.body)}`).toBe(200);
};

/** An ask bound to `subject`, whose details name `targets` — the census. */
const authAsk = async (subject: string, targets: string[], options: string[]) => {
  const r = await kbJson("/ask.create", {
    to: "human",
    question: `Supersede these ${targets.length} parked cards on the answered batch authorization?`,
    reason: "Supersede is human-authority — requesting batch drop authorization.",
    details: `Census of stale parks (receipts on each card): ${targets.join(" / ")} — dead + conflicting parks.`,
    options,
    artefact_id: subject,
    actor: "drill-drain-owner",
  });
  expect(r.status, `ask failed: ${JSON.stringify(r.body)}`).toBe(200);
  return String(r.body.id);
};

const apply = async (target: string, askId: string, actor = "drill-agent", session = "bridge-task-BR-6432") =>
  kbJson("/transition", { id: target, to: "superseded", batch_auth: { ask: askId }, actor, session });

beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  if (!existsSync(bundle)) throw new Error("bundle missing — run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle (before vitest)");
  mf = new Miniflare({
    workers: [{
      name: "main",
      modules: true,
      compatibilityDate: "2025-09-25",
      scriptPath: bundle,
      modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")),
      durableObjects: { KB: { className: "KnowledgeHub", useSQLite: true } },
    }],
  });
  kbNs = await mf.getDurableObjectNamespace("KB");
  await kbJson("/orient", { actor: "test" });
});

afterAll(async () => {
  await mf?.dispose();
});

// ---------- A. the receipt-scope grammar ----------

describe("parseCardIdRefs (BR#6432 batch-authorization scope)", () => {
  it("parses the BR#6387 census shape: BR# ids, slash chains, legacy TASK- ids", () => {
    const body = [
      "REMAINING, needs your drop authorization:",
      "(a) 6 DEAD parks: BR#4494 (bridge PR #298), BR#4693 (bridge #326), TASK-001 (sp #2117), BR#3668 (bridge #223), TASK-016 (bridge #99 + #67 — shipped), BR#4238 (sp #2535).",
      "(b) 23 parks on stale OPEN PRs now CONFLICTING: bridge PRs #311, #312 (cards BR#4689/#4834/#4692) and sp PRs #2323, #2343 (cards BR#2921/#2922/#3575/#3783 br#3627).",
    ].join("\n");
    expect(parseCardIdRefs(body)).toEqual([
      "BR#4494", "BR#4693", "TASK-001", "BR#3668", "TASK-016", "BR#4238",
      "BR#4689", "BR#4834", "BR#4692",
      "BR#2921", "BR#2922", "BR#3575", "BR#3783", "BR#3627",
    ]);
  });

  it("never matches bare PR references or PR URLs", () => {
    expect(parseCardIdRefs("bridge PRs #311, #312 and https://github.com/state-vector/bridge/pull/378 stay open")).toEqual([]);
    expect(parseCardIdRefs("repo#2117 and (sp #2535) are PR refs, not cards")).toEqual([]);
  });

  it("BR-N form, case-insensitive, deduplicated in first-appearance order", () => {
    expect(parseCardIdRefs("see br-4494 and BR#4494 again; br#4494 once more")).toEqual(["BR#4494"]);
    expect(parseCardIdRefs("BR-1 then BR#2")).toEqual(["BR#1", "BR#2"]);
  });
});

// ---------- B + C. the hub-applied batch authorization ----------

describe("batch_auth supersede (BR#6432)", () => {
  it("the alarm executes a persisted authorised command after a crash and consumes a rejected command once", async () => {
    const drain = await task("Durable cleanup executor");
    const target = await task("Durable disposition target");
    await park(target, "state-vector/bridge", 311, "durable-owner");
    const askId = await authAsk(drain, [target], ["SUPERSEDE all 1", "KEEP"]);
    await kbJson("/ask.answer", { id: askId, answer: "SUPERSEDE all 1", actor: "web:rayh" });
    await kbJson("/update", { id: target, meta: { disposition_request: { kind: "apply_authorized_supersede", ask: askId } } });
    const outside = await task("Unapproved durable target");
    await park(outside, "state-vector/bridge", 312, "durable-outside");
    await kbJson("/update", { id: outside, meta: { disposition_request: { kind: "apply_authorized_supersede", ask: askId } } });
    await kbJson("/admin.alarm_sweep");
    expect((await kbJson("/get", { id: target })).body.status).toBe("superseded");
    await kbJson("/update", { id: target, meta: { disposition_request: { kind: "apply_authorized_supersede", ask: askId } } });
    await kbJson("/admin.alarm_sweep");
    const replayed = (await kbJson("/get", { id: target })).body;
    expect(replayed.meta.disposition_request).toBeUndefined();
    expect(replayed.meta.disposition_result).toBeUndefined();
    const rejected = (await kbJson("/get", { id: outside })).body;
    expect(rejected.meta.disposition_result.kind).toBe("refused");
    expect(rejected.meta.disposition_request).toBeUndefined();
    await kbJson("/admin.alarm_sweep");
    expect((await kbJson("/get", { id: outside })).body.meta.disposition_result.at).toBe(rejected.meta.disposition_result.at);
  });
  it("a persisted disposition request consumes the same human-authority gate, with no prose parsing or repeated ask", async () => {
    const drain = await task("Receipt-scoped cleanup executor");
    const target = await task("Persisted disposition target");
    await park(target, "state-vector/bridge", 311, "receipt-owner");
    const askId = await authAsk(drain, [target], ["SUPERSEDE all 1", "KEEP"]);
    await kbJson("/ask.answer", { id: askId, answer: "SUPERSEDE all 1", actor: "web:rayh" });
    expect((await kbJson("/update", { id: target, meta: { disposition_request: { kind: "apply_authorized_supersede", ask: askId } } })).status).toBe(200);
    const applied = await kbJson("/transition", { id: target, to: "superseded", actor: "cleanup-executor", session: "cleanup-executor" });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect((await kbJson("/get", { id: target })).body.meta.batch_auth.ask).toBe(askId);
    const outside = await task("Out-of-scope target");
    await park(outside, "state-vector/bridge", 312, "outside-owner");
    await kbJson("/update", { id: outside, meta: { disposition_request: { kind: "apply_authorized_supersede", ask: askId } } });
    expect((await kbJson("/transition", { id: outside, to: "superseded", actor: "cleanup-executor" })).status).toBe(400);
  });
  it("happy path: one answered ask drops both named parks; the bound task survives; provenance stamped", async () => {
    const drain = await task("EXECUTE: drain the strand backlog (drill)");
    const dead = await task("dead park drill (awaited PR closed unmerged)");
    const conflicting = await task("conflicting park drill (stale CONFLICTING PR)");
    await park(dead, "state-vector/bridge", 326, "drill-owner-a");
    await park(conflicting, "state-vector/bridge", 311, "drill-owner-b");
    expect((await kbJson("/transition", { id: drain, to: "in_progress", actor: "drill-drain-owner", note: "working" })).status).toBe(200);

    const askId = await authAsk(drain, [dead, conflicting], [
      "(Recommended) SUPERSEDE all 2 — dead + conflicting parks",
      "SUPERSEDE only the dead park",
      "NO — leave them parked",
    ]);
    const ans = await kbJson("/ask.answer", {
      id: askId,
      answer: "(Recommended) SUPERSEDE all 2 — dead + conflicting parks",
      actor: "web:rayh",
    });
    expect(ans.status, `answer failed: ${JSON.stringify(ans.body)}`).toBe(200);

    // BR#6395 leg still intact: the batch answer RESUMED the bound task
    // (live holder) or released it to the pool (no live session stamp —
    // BR#3819) — either way it was NOT dropped.
    const drainAfter = (await kbJson("/get", { id: drain })).body;
    expect(["in_progress", "todo"]).toContain(drainAfter.status);

    // …and the resumed executor now applies the drops via batch_auth.
    const r1 = await apply(dead, askId);
    expect(r1.status, `apply failed: ${JSON.stringify(r1.body)}`).toBe(200);
    expect(r1.body.status).toBe("superseded");
    expect(r1.body.batch_auth).toMatchObject({ ask: askId, answered_by: "web:rayh" });
    const deadAfter = (await kbJson("/get", { id: dead })).body;
    expect(deadAfter.status).toBe("superseded");
    expect(deadAfter.meta.batch_auth).toMatchObject({
      ask: askId, answered_by: "web:rayh", applied_by: "drill-agent", applied_session: "bridge-task-BR-6432",
    });

    const r2 = await apply(conflicting, askId);
    expect(r2.status, `apply failed: ${JSON.stringify(r2.body)}`).toBe(200);
    expect((await kbJson("/get", { id: conflicting })).body.status).toBe("superseded");

    // the act row carries the human answerer as the pen, not the agent
    const hist = (await kbJson(`/history?id=${encodeURIComponent(dead)}&limit=5`)).body;
    const dropRow = (hist.versions ?? []).find((v: any) => v.action === "transition" && v.data?.to === "superseded");
    expect(dropRow).toBeTruthy();
    expect(String(dropRow.actor)).toBe("system:question(web:rayh)");
  });

  it("refuses a target the ask body does not name — receipt-scoped, never pattern-matched", async () => {
    const drain = await task("EXECUTE: scope drain (drill)");
    const named = await task("park NAMED in the census (drill)");
    const outsider = await task("park NOT named in the census (drill)");
    await park(named, "state-vector/bridge", 337, "drill-owner-c");
    await park(outsider, "state-vector/bridge", 344, "drill-owner-c2");
    const askId = await authAsk(drain, [named], ["(Recommended) SUPERSEDE all 1", "NO — leave parked"]);
    await kbJson("/ask.answer", { id: askId, answer: "SUPERSEDE all 1", actor: "web:rayh" });
    // a well-formed but non-existent ask fails at the ask check
    const missing = await apply(outsider, "BR#999999");
    expect(missing.status).toBe(400);
    expect(String(missing.body.error)).toContain("batch-auth-ask-missing");
    // a real answered ask does not authorize cards its census omits
    const r = await apply(outsider, askId);
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain("batch-auth-target-out-of-scope");
    expect((await kbJson("/get", { id: outsider })).body.status).toBe("blocked");
    // …while the named card still takes the drop
    const ok = await apply(named, askId);
    expect(ok.status, `apply failed: ${JSON.stringify(ok.body)}`).toBe(200);
    expect((await kbJson("/get", { id: named })).body.status).toBe("superseded");
  });

  it("refuses a target that is not an open park — the state recheck", async () => {
    const drain = await task("EXECUTE: scope-recheck drain (drill)");
    const claimed = await task("park claimed before the ruling landed (drill)");
    await park(claimed, "state-vector/bridge", 312, "drill-owner-d");
    const askId = await authAsk(drain, [claimed], ["(Recommended) SUPERSEDE all 1", "NO — leave parked"]);
    await kbJson("/ask.answer", { id: askId, answer: "SUPERSEDE all 1", actor: "web:rayh" });
    // the executor's recheck found the card CLAIMED (a live session took it)
    expect((await kbJson("/transition", { id: claimed, to: "in_progress", actor: "drill-owner-d", note: "rebasing" })).status).toBe(200);
    const r = await apply(claimed, askId);
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain("batch-auth-target-not-parked");
    expect((await kbJson("/get", { id: claimed })).body.status).toBe("in_progress");
  });

  it("refuses an unanswered ask — the answer IS the authorization", async () => {
    const drain = await task("EXECUTE: unanswered drain (drill)");
    const victim = await task("park awaiting its own ruling (drill)");
    await park(victim, "state-vector/superpositional", 2323, "drill-owner-e");
    const askId = await authAsk(drain, [victim], ["(Recommended) SUPERSEDE all 1", "NO"]);
    const r = await apply(victim, askId);
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain("batch-auth-unanswered");
    expect((await kbJson("/get", { id: victim })).body.status).toBe("blocked");
  });

  it("refuses an ask answered by a non-human principal — authority is server-verified", async () => {
    const drain = await task("EXECUTE: agent-answered drain (drill)");
    const victim = await task("park under an agent-answered ask (drill)");
    await park(victim, "state-vector/bridge", 318, "drill-owner-f");
    const askId = await authAsk(drain, [victim], ["(Recommended) SUPERSEDE all 1", "NO"]);
    await kbJson("/ask.answer", { id: askId, answer: "SUPERSEDE all 1", actor: "rogue-agent" });
    const r = await apply(victim, askId);
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain("batch-auth-not-human");
    expect((await kbJson("/get", { id: victim })).body.status).toBe("blocked");
  });

  it("refuses an ask whose answer is not a batch authorization — single-card drops ride their own ask", async () => {
    const drain = await task("EXECUTE: single-card drain (drill)");
    const victim = await task("park under a single-card ask (drill)");
    await park(victim, "state-vector/bridge", 325, "drill-owner-g");
    const askId = await authAsk(drain, [victim], ["SUPERSEDE — drop it", "KEEP — stay parked"]);
    await kbJson("/ask.answer", { id: askId, answer: "SUPERSEDE — drop it", actor: "web:rayh" });
    const r = await apply(victim, askId);
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain("batch-auth-not-batch");
    expect((await kbJson("/get", { id: victim })).body.status).toBe("blocked");
  });

  it("'only'-scoped answers resolve to exactly the ids the answer names", async () => {
    const drain = await task("EXECUTE: only-scoped drain (drill)");
    const deadOne = await task("only-scoped dead park (drill)");
    const otherOne = await task("only-scoped conflicting park NOT named in the answer (drill)");
    await park(deadOne, "state-vector/superpositional", 2117, "drill-owner-h");
    await park(otherOne, "state-vector/superpositional", 2343, "drill-owner-i");
    const askId = await authAsk(drain, [deadOne, otherOne], [
      `(Recommended) SUPERSEDE only BR#${deadOne.slice(3)} — the dead park`,
      "SUPERSEDE all 2",
      "NO — leave parked",
    ]);
    await kbJson("/ask.answer", {
      id: askId,
      answer: `(Recommended) SUPERSEDE only BR#${deadOne.slice(3)} — the dead park`,
      actor: "web:rayh",
    });
    const ok = await apply(deadOne, askId);
    expect(ok.status, `apply failed: ${JSON.stringify(ok.body)}`).toBe(200);
    expect((await kbJson("/get", { id: deadOne })).body.status).toBe("superseded");
    const refused = await apply(otherOne, askId);
    expect(refused.status).toBe(400);
    expect(String(refused.body.error)).toContain("batch-auth-target-out-of-scope");
    expect((await kbJson("/get", { id: otherOne })).body.status).toBe("blocked");
  });

  it("refuses a standing lane card — infrastructure is outside batch scope (BR#5061)", async () => {
    const drain = await task("EXECUTE: lane-card drain (drill)");
    const laneCard = await task("Merge lane: drill repo@main (drill)");
    await park(laneCard, "state-vector/bridge", 333, "drill-owner-j");
    const configured = await kbJson("/update", { id: laneCard, meta: { lane: { repo: "state-vector/batch-auth-protection", base: "main", key: "state-vector/batch-auth-protection@main", now_action: null } } });
    expect(configured.status, JSON.stringify(configured.body)).toBe(200);
    const askId = await authAsk(drain, [laneCard], ["(Recommended) SUPERSEDE all 1", "NO"]);
    await kbJson("/ask.answer", { id: askId, answer: "SUPERSEDE all 1", actor: "web:rayh" });
    const r = await apply(laneCard, askId);
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain("batch-auth-target-protected");
    expect((await kbJson("/get", { id: laneCard })).body.status).toBe("blocked");
  });
});
