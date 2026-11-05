/**
 * BR#6135 — interactive claim takeover. Amended by BR#6436: authenticated
 * FULL-AGENT credentials (live token tags, gateway/cron excluded) may pull
 * rank over dispatched runner claims ACROSS owners.
 *
 * Two tiers:
 *  - PURE: decideTakeover / takeoverAuthority / isFullAgentCredential /
 *    breachClass — the decision law is total and closed; every refusal rule
 *    has a never-breach class.
 *  - REAL DO (miniflare, same rig as do.test.ts): the atomic swap end to
 *    end — owner re-takes a runner-held card via transition {takeover:true},
 *    the ex-holder's finish is gate-rejected with the stand-down order, a
 *    non-owner is refused, and a verdict-duty card refuses takeover.
 */
import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { breachClass } from "../src/kb/machine.ts";
import { decideTakeover, isFullAgentCredential, takeoverAuthority, type TakeoverAuthority, type TakeoverTarget } from "../src/kb/takeover.ts";

// ---------- pure decision law ----------

const target = (over: Partial<TakeoverTarget> = {}): TakeoverTarget => ({
  id: "BR#1",
  type: "task",
  status: "in_progress",
  owner: "opencode-ray",
  roles: ["impl"],
  meta: { session: "bridge-task-BR-1" },
  ...over,
});

const owner = (over: Partial<TakeoverAuthority> = {}): TakeoverAuthority => ({
  actor: "opencode-ray",
  actingPrincipal: null,
  attributedAgent: null,
  session: "ray-local-session",
  ...over,
});

describe("decideTakeover — the happy paths", () => {
  it("an owner agent atomically takes a runner-held claim", () => {
    const v = decideTakeover(target(), owner());
    expect(v).toEqual({ ok: true, already: false, fromSession: "bridge-task-BR-1", toSession: "ray-local-session" });
  });

  it("a human (web actor) may take any non-duty card", () => {
    const v = decideTakeover(target({ owner: "someone-else" }), owner({ actor: "web:ray", session: null }));
    expect(v.ok).toBe(true);
  });

  it("the owner principal anchors authority (labels are display, principals are the anchor)", () => {
    const v = decideTakeover(
      target({ owner: "p_abc123" }),
      owner({ actor: "opencode-ray", actingPrincipal: "p_abc123" }),
    );
    expect(v.ok).toBe(true);
  });

  it("the gateway attribution pair counts (the dispatcher returning work)", () => {
    const v = decideTakeover(
      target({ owner: "opencode-ray" }),
      owner({ actor: "gw-1", attributedAgent: "opencode-ray", session: "dispatch-BR-1" }),
    );
    expect(v.ok).toBe(true);
  });

  it("idempotent: the acting session already holding the claim reports already, not a refusal", () => {
    const v = decideTakeover(
      target({ meta: { session: "ray-local-session" } }),
      owner(),
    );
    expect(v).toMatchObject({ ok: true, already: true });
  });
});

describe("decideTakeover — every refusal is a named, terminal rule", () => {
  it("takeover-target: wrong status/type", () => {
    for (const over of [{ status: "todo" }, { status: "blocked" }, { status: "in_review" }, { type: "decision" }] as const) {
      const v = decideTakeover(target(over as any), owner());
      expect(v.ok).toBe(false);
      if (v.ok === false) expect(v.rule).toBe("takeover-target");
    }
  });

  it("takeover-verdict-duty: SoD is not transferable (review/unblock roles)", () => {
    for (const role of ["review", "unblock"]) {
      const v = decideTakeover(target({ roles: [role] }), owner());
      expect(v.ok).toBe(false);
      if (v.ok === false) expect(v.rule).toBe("takeover-verdict-duty");
    }
  });

  it("takeover-held: a typed wait owns the card, not the executor", () => {
    const held: Record<string, any>[] = [
      { merge_train: { state: "queued" }, pr: { repo: "state-vector/superpositional", number: 1 } },
      { blocked: { await_event: { event: "time", until_ts: 1 } } },
      { awaiting_ask: { ask_id: "ASK-1" } },
    ];
    for (const meta of held) {
      const v = decideTakeover(target({ meta: { session: "bridge-task-BR-1", ...meta } }), owner());
      expect(v.ok).toBe(false);
      if (v.ok === false) expect(v.rule).toBe("takeover-held");
    }
  });

  it("takeover-authority: a non-owner agent session is refused, pointed at ask/web", () => {
    const v = decideTakeover(target(), owner({ actor: "macbook-pro-local-2", session: "other-agent" }));
    expect(v.ok).toBe(false);
    if (v.ok === false) {
      expect(v.rule).toBe("takeover-authority");
      expect(v.message).toMatch(/ask_agent|human/i);
    }
  });

  it("authority is never body-declared: an anonymous non-owner with no anchors is refused", () => {
    expect(takeoverAuthority(target(), { actor: "mcp" })).toBe(false);
  });
});

describe("decideTakeover — full-agent credentials pull rank across owners (BR#6436)", () => {
  it("isFullAgentCredential: untagged/role-tagged agent tokens qualify; gateway and cron never do; no token row fails closed", () => {
    expect(isFullAgentCredential([])).toBe(true); // untagged = the default full-agent class (BR#2455)
    expect(isFullAgentCredential(["role:impl"])).toBe(true);
    expect(isFullAgentCredential(["role:impl", "local-work"])).toBe(true);
    expect(isFullAgentCredential(["gateway"])).toBe(false);
    expect(isFullAgentCredential(["Gateway"])).toBe(false); // case-insensitive, like tagsSayGateway
    expect(isFullAgentCredential(["role:impl", "gateway"])).toBe(false);
    expect(isFullAgentCredential(["cadence:cron"])).toBe(false);
    expect(isFullAgentCredential(["Cadence:Cron"])).toBe(false);
    expect(isFullAgentCredential(["gateway", "cadence:cron"])).toBe(false);
    expect(isFullAgentCredential(null)).toBe(false); // no live token row — fail closed
    expect(isFullAgentCredential(undefined)).toBe(false);
  });

  it("a non-owner full-agent token takes a dispatched runner claim across owners", () => {
    const v = decideTakeover(
      target({ owner: "opencode-ray", meta: { session: "dispatch-BR-6436" } }),
      owner({ actor: "another-box-agent", actingTags: ["role:impl"], session: "bridge-task-BR-99" }),
    );
    expect(v).toEqual({ ok: true, already: false, fromSession: "dispatch-BR-6436", toSession: "bridge-task-BR-99" });
  });

  it("an untagged agent token is a full agent (the default class)", () => {
    const v = decideTakeover(target({ owner: "opencode-ray" }), owner({ actor: "bare-token-agent", actingTags: [] }));
    expect(v.ok).toBe(true);
  });

  it("gateway credentials never pull rank across owners — the attribution plane stays excluded", () => {
    const v = decideTakeover(
      target({ owner: "opencode-ray" }),
      owner({ actor: "gw-infra", actingTags: ["gateway"], session: "dispatch-X" }),
    );
    expect(v.ok).toBe(false);
    if (v.ok === false) expect(v.rule).toBe("takeover-authority");
  });

  it("cron credentials never pull rank — no agent is behind an unattended schedule", () => {
    const v = decideTakeover(
      target({ owner: "opencode-ray" }),
      owner({ actor: "cron-runner", actingTags: ["cadence:cron", "role:impl"], session: "cron-1" }),
    );
    expect(v.ok).toBe(false);
    if (v.ok === false) expect(v.rule).toBe("takeover-authority");
  });

  it("authority is never body-declared: named session without a resolved token row has no full-agent anchor", () => {
    expect(takeoverAuthority(target(), { actor: "some-agent", session: "claims-to-be-full" })).toBe(false);
  });

  it("full-agent rank does NOT pierce duty separation (SoD is not transferable)", () => {
    const full = owner({ actor: "another-box-agent", actingTags: ["role:impl"], session: "bridge-task-X" });
    for (const role of ["review", "unblock"]) {
      const v = decideTakeover(target({ owner: "opencode-ray", roles: [role] }), full);
      expect(v.ok).toBe(false);
      if (v.ok === false) expect(v.rule).toBe("takeover-verdict-duty");
    }
  });

  it("full-agent rank does NOT pierce typed-wait holds (the wait owns the exit)", () => {
    const full = owner({ actor: "another-box-agent", actingTags: ["role:impl"], session: "bridge-task-X" });
    const v = decideTakeover(
      target({ owner: "opencode-ray", meta: { session: "dispatch-1", merge_train: { state: "queued" }, pr: { repo: "state-vector/bridge", number: 1 } } }),
      full,
    );
    expect(v.ok).toBe(false);
    if (v.ok === false) expect(v.rule).toBe("takeover-held");
  });

  it("the authority refusal still names the owner/web anchor (breachClass matcher stability, machine.ts tag-cut ladder)", () => {
    const v = decideTakeover(target({ owner: "opencode-ray" }), owner({ actor: "gw-2", actingTags: ["gateway"] }));
    if (v.ok === false) expect(v.message).toContain("owner/web/human-anchored");
  });
});

describe("breachClass — every takeover rule folds into a never-breach family (BR#3430)", () => {
  it("rejects classify by their [rule: …] tags", () => {
    expect(breachClass("… [rule: takeover-authority]")).toBe("claim_race");
    expect(breachClass("… [rule: takeover-target]")).toBe("claim_race");
    expect(breachClass("… [rule: takeover-stale-holder]")).toBe("claim_race");
    expect(breachClass("… [rule: takeover-held]")).toBe("release_held");
    expect(breachClass("… [rule: takeover-verdict-duty]")).toBe("gate:separation");
  });
});

// ---------- real DO ----------

let mf: Miniflare;
let kb: (path: string, init?: RequestInit) => Promise<Response>;

beforeAll(async () => {
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
  await kb("/orient", { actor: "test" });
});

afterAll(async () => {
  await mf?.dispose();
});

async function kbJson(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await kb(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-kb-admin": "1" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function freshCard(over: Record<string, unknown> = {}): Promise<string> {
  const { body } = await kbJson("/create", { type: "task", title: "takeover drill card", roles: ["impl"], ...over });
  return body.id as string;
}

describe("claim takeover — real DO", () => {
  it("the owner re-takes a runner-held claim ATOMICALLY via transition {takeover:true}", async () => {
    const id = await freshCard();
    // the runner claims (gateway attribution to owner label opencode-ray)
    const claim = await kbJson("/transition", { id, to: "in_progress", session: "bridge-task-DRILL-1", actor: "opencode-ray" });
    expect(claim.status).toBe(200);
    // the owner's interactive session takes it back
    const take = await kbJson("/transition", {
      id, to: "in_progress", takeover: true, actor: "opencode-ray", session: "ray-local-DRILL-1",
      note: "local session resuming after human pause",
    });
    expect(take.status).toBe(200);
    expect(take.body.taken_over).toBe(true);
    expect(take.body.from_session).toBe("bridge-task-DRILL-1");
    expect(take.body.session).toBe("ray-local-DRILL-1");
    // status never left in_progress and the stamp is machine-readable
    const card = await kbJson("/get", { id });
    expect(card.body.status).toBe("in_progress");
    expect(card.body.meta.session).toBe("ray-local-DRILL-1");
    expect(card.body.meta.taken_over).toMatchObject({ from_session: "bridge-task-DRILL-1", to_session: "ray-local-DRILL-1" });
  });

  it("the ex-holder's next state change is gate-rejected with a stand-down order; log_progress stays open", async () => {
    const id = await freshCard();
    await kbJson("/transition", { id, to: "in_progress", session: "bridge-task-DRILL-2", actor: "opencode-ray" });
    await kbJson("/transition", { id, to: "in_progress", takeover: true, actor: "opencode-ray", session: "ray-local-DRILL-2" });
    // the runner tries to finish — refused, named rule, terminal
    const finish = await kbJson("/transition", { id, to: "in_review", note: "PR https://example.com/1", session: "bridge-task-DRILL-2", actor: "opencode-ray" });
    expect(finish.status).toBe(400);
    expect(finish.body.error).toContain("was taken over by");
    expect(finish.body.error).toContain("STAND DOWN");
    expect(finish.body.result_class).toBe("gate_rejected");
    // its checkpoint still lands (log_progress is additive)
    const prog = await kbJson("/progress.log", { id, did: "stand-down checkpoint: worktree /w, branch b, tests green", session: "bridge-task-DRILL-2", actor: "opencode-ray" });
    expect(prog.status).toBe(200);
    // the NEW holder finishing is unaffected
    const done = await kbJson("/transition", { id, to: "in_review", note: "PR https://example.com/2", session: "ray-local-DRILL-2", actor: "opencode-ray" });
    expect(done.status).toBe(200);
  });

  it("a non-owner agent is refused with the authority rule", async () => {
    const id = await freshCard();
    await kbJson("/transition", { id, to: "in_progress", session: "bridge-task-DRILL-3", actor: "opencode-ray" });
    const ref = await kbJson("/transition", { id, to: "in_progress", takeover: true, actor: "macbook-pro-local-2", session: "other-agent" });
    expect(ref.status).toBe(400);
    expect(ref.body.error).toContain("[rule: takeover-authority]");
    expect(ref.body.result_class).toBe("gate_rejected");
  });

  it("a verify duty card refuses takeover — SoD is not transferable", async () => {
    const { body } = await kbJson("/create", { type: "task", title: "Verify: drill", roles: ["review"] });
    const id = body.id;
    await kbJson("/transition", { id, to: "in_progress", session: "bridge-task-DRILL-4", actor: "opencode-ray" });
    const ref = await kbJson("/claim.takeover", { id, actor: "opencode-ray", session: "ray-local-DRILL-4" });
    expect(ref.status).toBe(400);
    expect(ref.body.error).toContain("[rule: takeover-verdict-duty]");
  });

  it("the direct op claim.takeover works (the MCP tool's backing op)", async () => {
    const id = await freshCard();
    await kbJson("/transition", { id, to: "in_progress", session: "bridge-task-DRILL-5", actor: "opencode-ray" });
    const take = await kbJson("/claim.takeover", { id, actor: "opencode-ray", session: "ray-local-DRILL-5" });
    expect(take.status).toBe(200);
    expect(take.body.taken_over).toBe(true);
    const again = await kbJson("/claim.takeover", { id, actor: "opencode-ray", session: "ray-local-DRILL-5" });
    expect(again.body.taken_over).toBe(false); // idempotent
  });

  it("a held card (train queue slot) refuses takeover — the wait owns the exit", async () => {
    const id = await freshCard();
    await kbJson("/transition", { id, to: "in_progress", session: "bridge-task-DRILL-6", actor: "opencode-ray" });
    await kbJson("/update", { id, meta: { merge_train: { state: "queued", repo: "state-vector/superpositional", pr: 1 }, pr: { repo: "state-vector/superpositional", number: 1 } } });
    const ref = await kbJson("/claim.takeover", { id, actor: "opencode-ray", session: "ray-local-DRILL-6" });
    expect(ref.status).toBe(400);
    expect(ref.body.error).toContain("[rule: takeover-held]");
  });
});

describe("claim takeover — full-agent credentials across owners (BR#6436, real DO)", () => {
  it("a full-agent token from ANOTHER owner takes a dispatched runner claim atomically; the ex-runner stands down", async () => {
    // the dispatched runner: a gateway credential claiming for its agent
    const gw = await kbJson("/admin.mint", { label: "br6436-gw", tags: ["gateway"], principal: "p_br6436_gwbox" });
    // the cross-owner full agent: a DIFFERENT machine's full credential —
    // not the owner label, not the owner principal, not the web plane
    const full = await kbJson("/admin.mint", { label: "br6436-full", tags: ["role:impl", "local-work"] });
    expect(gw.status).toBe(200);
    expect(full.status).toBe(200);
    const { body: card } = await kbJson("/create", { type: "task", title: "takeover cross-owner br6436" });
    // the runner claims (the dispatch shape: gateway attribution + dispatch session)
    const claim = await kbJson("/transition", {
      id: card.id, to: "in_progress", note: "claim",
      actor: "br6436-gw", gateway: true, agent: "br6436-owner", token_id: gw.body.id, session: "dispatch-BR-6436A",
    });
    expect(claim.status).toBe(200);
    const preOwner = await kbJson("/get", { id: card.id });
    expect(preOwner.body.owner).toBe("br6436-gw"); // /get display-joins the stored PRINCIPAL (p_br6436_gwbox) to its token label — the owner is the runner's machine, NOT the taker
    // THE cross-owner takeover: the ONLY anchor is the live full-agent
    // credential tags — body declares nothing
    const take = await kbJson("/transition", {
      id: card.id, to: "in_progress", takeover: true,
      actor: "br6436-full", token_id: full.body.id, session: "bridge-task-BR-6436X",
      note: "full agent pulling rank over a stuck dispatched claim",
    });
    expect(take.status).toBe(200);
    expect(take.body.status).toBe("in_progress");
    expect(take.body.taken_over).toBe(true);
    expect(take.body.from_session).toBe("dispatch-BR-6436A");
    expect(take.body.session).toBe("bridge-task-BR-6436X");
    const held = await kbJson("/get", { id: card.id });
    expect(held.body.status).toBe("in_progress");
    expect(held.body.owner).toBe("br6436-full"); // the owner leg transferred across owners
    expect(held.body.meta.session).toBe("bridge-task-BR-6436X");
    expect(held.body.meta.taken_over).toMatchObject({ from_session: "dispatch-BR-6436A", to_session: "bridge-task-BR-6436X", by: "br6436-full" });
    // the superseded runner stands down — the fence is authority-blind
    const fin = await kbJson("/transition", {
      id: card.id, to: "in_review", note: "PR https://example.com/6436",
      actor: "br6436-gw", gateway: true, agent: "br6436-owner", token_id: gw.body.id, session: "dispatch-BR-6436A",
    });
    expect(fin.status).toBe(400);
    expect(String(fin.body.error)).toContain("STAND DOWN");
    expect(fin.body.result_class).toBe("gate_rejected");
    // its checkpoint still lands (log_progress stays open to the ex-holder)
    const prog = await kbJson("/progress.log", { id: card.id, did: "stand-down checkpoint", session: "dispatch-BR-6436A", actor: "br6436-gw" });
    expect(prog.status).toBe(200);
    // the audit trail carries both the takeover and the ex-holder's refusal
    const hist = await kbJson("/get_history", { id: card.id });
    const rows = hist.body.versions ?? [];
    expect(rows.some((r: any) => String(r.summary).includes("claim taken over"))).toBe(true);
  });

  it("gateway and cron credentials are refused across owners — infrastructure classes never pull rank (server tag resolution)", async () => {
    const ownerTok = await kbJson("/admin.mint", { label: "br6436-owner2", tags: ["role:impl"] });
    const gw = await kbJson("/admin.mint", { label: "br6436-gw2", tags: ["gateway"] });
    const cron = await kbJson("/admin.mint", { label: "br6436-cron", tags: ["cadence:cron", "role:impl"] });
    const { body: card } = await kbJson("/create", { type: "task", title: "takeover infra refusal br6436" });
    const claim = await kbJson("/transition", {
      id: card.id, to: "in_progress", note: "claim",
      actor: "br6436-owner2", token_id: ownerTok.body.id, session: "bridge-task-BR-6436H",
    });
    expect(claim.status).toBe(200);
    for (const [tok, label] of [[gw, "br6436-gw2"], [cron, "br6436-cron"]] as const) {
      const r = await kbJson("/claim.takeover", {
        id: card.id, actor: label, token_id: (tok.body as any).id, session: `sneaky-${label}`,
      });
      expect(r.status).toBe(400);
      expect(String(r.body.error)).toContain("[rule: takeover-authority]");
      expect(r.body.result_class).toBe("gate_rejected");
    }
    // the claim is untouched by both refusals
    const held = await kbJson("/get", { id: card.id });
    expect(held.body.owner).toBe("br6436-owner2");
    expect(held.body.meta.session).toBe("bridge-task-BR-6436H");
  });

  it("an untagged token qualifies (default full-agent class); body-declared classes are worthless — the tags decide", async () => {
    const bare = await kbJson("/admin.mint", { label: "br6436-bare", tags: [] });
    const cron = await kbJson("/admin.mint", { label: "br6436-cron2", tags: ["cadence:cron"] });
    const ownerTok = await kbJson("/admin.mint", { label: "br6436-owner3", tags: [] });
    const { body: card } = await kbJson("/create", { type: "task", title: "takeover tag law br6436" });
    const claim = await kbJson("/transition", {
      id: card.id, to: "in_progress", note: "claim",
      actor: "br6436-owner3", token_id: ownerTok.body.id, session: "bridge-task-BR-6436U",
    });
    expect(claim.status).toBe(200);
    // the bare token takes across owners even while declaring gateway:false/agent:"" —
    // the body fields contribute no anchor; the credential tags do
    const ok = await kbJson("/claim.takeover", {
      id: card.id, actor: "br6436-bare", token_id: bare.body.id, session: "bridge-task-BR-6436U2", gateway: false, agent: "",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.taken_over).toBe(true);
    // a cron credential declaring the same shape is still refused
    const no = await kbJson("/claim.takeover", {
      id: card.id, actor: "br6436-cron2", token_id: cron.body.id, session: "bridge-task-BR-6436U3", gateway: false,
    });
    expect(no.status).toBe(400);
    expect(String(no.body.error)).toContain("[rule: takeover-authority]");
  });
});
