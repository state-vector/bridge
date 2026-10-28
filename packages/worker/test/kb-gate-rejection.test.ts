import { Miniflare } from "miniflare";
import { createHmac } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index.js";

/**
 * BR#4390 — machine refusals must never read as infrastructure.
 *
 * Incident: BR#4068's blocked→done (and twin BR#3822's in_progress→done /
 →blocked, and every claim-race rejection) surfaced as
 * `503 {result_class: "infra_storage_fault", message: "kb temporarily
 * unavailable — retry"}`. Two reverse-reconcile duty sessions burned ~25
 * futile retries on a transition the machine REFUSES by law (the task
 * lifecycle has no blocked→done edge; the close is blocked→in_progress→done).
 * The refusal never reached anyone: the DO's op catch-all returned an
 * untyped 400 {error}, and mcp.ts's isInfraFault fallback (the BR#4212
 * hardening) read every non-auth Error as infra and re-wrapped it as a
 * retryable 503.
 *
 * Contract under test, two tiers:
 *  A. MCP classification (worker + stub KB): a CLASSIFIED DO response —
 *     kbError stamped .status on it — is trusted. 4xx refusals (with or
 *     without the new result_class "gate_rejected") surface as MCP tool
 *     errors carrying the refusal message; only typed infra_storage_fault,
 *     5xx, and UNCLASSIFIED throws (DO reset / HTML page class) stay 503.
 *  B. Real-SQLite rig (miniflare, BR#2841): the acceptance's regression —
 *     a card with ≥15 child relations + rich meta closes through the gates
 *     without infra_storage_fault: refusals come back as typed 400
 *     gate_rejected with the rule named, the legal close succeeds.
 */

const HTML_NEVER = /<html|<!doctype/i;
const NO_INFRA = /temporarily unavailable|infra_storage_fault/;

// ---------- tier A: MCP classification, stub KB ----------

const SECRET = "test-gh-secret";
function sessionCookie(login = "ray", ws = "global") {
  const exp = String(Date.now() + 60_000);
  const sig = createHmac("sha256", SECRET).update(`${exp}.${login}.${ws}`).digest("hex");
  return `bridge_session=${exp}.${login}.${ws}.${sig}`;
}

/** KB namespace stub: the registry hash lookup answers 200, then every hub
 *  op goes to `respond(op, body)` — precise control over the DO response
 *  shape the MCP layer must classify. */
function kbStubEnv(respond: (op: string, body: any) => Response): any {
  return {
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: SECRET,
    KB: {
      idFromName: (n: string) => ({ name: n }),
      get: () => ({
        fetch: async (url: string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body ?? "{}"));
          if (init && "hash" in body) return new Response(JSON.stringify({ ws: "global" }), { status: 200 });
          const op = String(url).replace(/^https:\/\/kb\//, "");
          return respond(op, body);
        },
      }),
    },
  };
}

const identify: (op: string, body: any) => Response = (op) =>
  op === "auth.identify"
    ? new Response(JSON.stringify({ token_id: "tok", label: "gate-test", tags: [], principal: null }), { status: 200 })
    : new Response("not an identify response", { status: 599 });

const mcpCall = (env: any, args: Record<string, unknown>) =>
  worker.fetch(new Request("https://hub/mcp", {
    method: "POST",
    headers: { authorization: "Bearer bkw_" + "e".repeat(40), "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 41, method: "tools/call",
      params: { name: "transition", arguments: { id: "BR#4068", to: "done", session: "gate-test-session", ...args } },
    }),
  }), env);

describe("MCP classification: a machine refusal is a tool error, never a retryable infra 503 (BR#4390)", () => {
  it("typed gate_rejected 400 (illegal edge) → MCP tool error carrying the rule, not 503 infra", async () => {
    const env = kbStubEnv((op, body) =>
      op === "auth.identify" ? identify(op, body) : new Response(
        JSON.stringify({
          error: "task: 'blocked' → 'done' not allowed (allowed: in_progress, todo) [rule: lifecycle]",
          result_class: "gate_rejected",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ));
    const res = await mcpCall(env, {});
    expect(res.status).toBe(200); // the MCP call itself succeeded; the TOOL refused
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    const text = body.result.content[0].text;
    expect(text).toContain("[rule: lifecycle]");
    expect(text).toContain("not allowed");
    expect(text).not.toMatch(NO_INFRA);
  });

  it("untyped 400 refusal (the exact deployed shape BR#4068's duty sessions received) → tool error, not 503 infra", async () => {
    const env = kbStubEnv((op, body) =>
      op === "auth.identify" ? identify(op, body) : new Response(
        JSON.stringify({
          error: "parent BR#4068 still has 3 open child task(s) — finish or close them first (decomposition owns its children) [rule: done-open-children]",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ));
    const res = await mcpCall(env, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    const text = body.result.content[0].text;
    expect(text).toContain("[rule: done-open-children]");
    expect(text).toContain("open child");
    expect(text).not.toMatch(NO_INFRA);
  });

  it("typed infra 503 from the DO still classifies infra (BR#4212 law intact)", async () => {
    const env = kbStubEnv((op, body) =>
      op === "auth.identify" ? identify(op, body) : new Response(
        JSON.stringify({ error: "kb storage fault — the operation did not land; retry", result_class: "infra_storage_fault", stage: "dispatch" }),
        { status: 503, headers: { "content-type": "application/json" } },
      ));
    const res = await mcpCall(env, {});
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe(-32000);
    expect(body.error.data.result_class).toBe("infra_storage_fault");
  });

  it("unclassified throw (DO reset) still classifies infra — the HTML-page class keeps its 503", async () => {
    const env = kbStubEnv((op, body) => {
      if (op === "auth.identify") return identify(op, body);
      throw new Error("DO reset: injected storage storm");
    });
    const res = await mcpCall(env, {});
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.data.result_class).toBe("infra_storage_fault");
    expect(JSON.stringify(body)).not.toMatch(/unauthorized/i);
    expect(JSON.stringify(body)).not.toMatch(HTML_NEVER);
  });
});

// ---------- tier B: real-SQLite rig — the acceptance regression ----------

let mf: Miniflare;
let kb: (path: string, init?: RequestInit) => Promise<Response>;

beforeAll(() => {
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
      durableObjects: { KB: { className: "KnowledgeHub", useSQLite: true } },
    }],
  });
  return (async () => {
    const ns = await mf.getDurableObjectNamespace("KB");
    const stub = (await ns.get(ns.idFromName("global"))) as unknown as {
      fetch: (url: string, init?: RequestInit) => Promise<Response>;
    };
    kb = (path, init) => stub.fetch(`https://kb${path}`, init);
    await kb("/orient", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor: "test" }) });
  })();
});

afterAll(async () => {
  await mf?.dispose();
});

const post = async (path: string, body: Record<string, unknown>) =>
  kb(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor: "test", ...body }) });

const getOne = async (id: string) => {
  const r = await post("/get", { id });
  expect(r.status).toBe(200);
  return (await r.json()) as Record<string, any>;
};

describe("real-SQLite rig: a rich card with ≥15 children closes through the gates without infra_storage_fault (BR#4390)", () => {
  it("refuses typed (400 gate_rejected, rule named) at every illegal step, then closes done on the legal path", async () => {
    // the BR#4068 shape: task, rich meta blobs, parked blocked on a typed merge proxy
    const created = await post("/create", {
      type: "task",
      title: "BR#4390 regression — rich card with a large child set closes cleanly",
      body_md: "Regression parent for the BR#4390 write-path incident. Rich meta, fifteen-plus child relations, parked on a typed merge proxy.",
      meta: {
        pr: { repo: "state-vector/bridge", number: 261, head_sha_at_acceptance: "5cd3314620d6a9ab8fdf14b1c504f3f10b54e3b8" },
        prs: [{ repo: "state-vector/bridge", number: 261, head_sha_at_acceptance: "5cd3314620d6a9ab8fdf14b1c504f3f10b54e3b8" }],
        merge_train: { state: "bounced", pr: 261, legs_total: 1 },
        proxy_check: { verdict: "no_atoms", detail: "no machine atoms" },
        qualification: { state: "qualified", how: "self-analyzed" },
      },
    });
    expect(created.status).toBe(200);
    const parent = ((await created.json()) as any).id as string;

    // 16 children, linked child_of — 15 close over the run, 1 stays open
    const kids: string[] = [];
    for (let i = 0; i < 16; i++) {
      const r = await post("/create", { type: "task", title: `BR#4390 regression child ${i + 1} of 16`, body_md: "child leg" });
      expect(r.status).toBe(200);
      const kid = ((await r.json()) as any).id as string;
      const link = await post("/link", { src: kid, relation: "child_of", dst: parent });
      expect(link.status).toBe(200);
      kids.push(kid);
    }

    // claim, then park blocked on a typed await (the BR#3578 law, satisfied)
    expect((await post("/transition", { id: parent, to: "in_progress" })).status).toBe(200);
    const park = await post("/transition", {
      id: parent, to: "blocked",
      note: "merge-train: queued — parked on the typed merge proxy",
      await_event: { event: "pr_merged", repo: "state-vector/bridge", n: 261 },
    });
    expect(park.status).toBe(200);
    expect((await getOne(parent)).status).toBe("blocked");

    // REFUSAL 1 — the exact call the two duty sessions burned ~25 retries on:
    // blocked→done has NO lifecycle edge. It must come back as a typed 400
    // gate rejection naming the rule — never 503 infra_storage_fault, never
    // "kb temporarily unavailable — retry" — and the card must be unchanged.
    const illegal = await post("/transition", { id: parent, to: "done", note: "close citing the merged PR" });
    expect(illegal.status).toBe(400);
    const illegalBody = (await illegal.json()) as Record<string, any>;
    expect(illegalBody.result_class).toBe("gate_rejected");
    expect(illegalBody.error).toContain("[rule: lifecycle]");
    expect(JSON.stringify(illegalBody)).not.toMatch(HTML_NEVER);
    expect(JSON.stringify(illegalBody)).not.toMatch(NO_INFRA);
    expect((await getOne(parent)).status).toBe("blocked");

    // close 15 of the 16 children (todo → in_progress → done)
    for (const kid of kids.slice(0, 15)) {
      expect((await post("/transition", { id: kid, to: "in_progress" })).status).toBe(200);
      expect((await post("/transition", { id: kid, to: "done", note: "child leg complete" })).status).toBe(200);
    }

    // unblock (needs a resolution note — the BR#3578 law), then attempt done
    // with one child still open
    expect((await post("/transition", { id: parent, to: "in_progress", note: "unblocking — the PR landed, closing out" })).status).toBe(200);

    // REFUSAL 2 — done-open-children: the refusal that was hidden behind the
    // infra 503 costume on the live board.
    const openKid = await post("/transition", { id: parent, to: "done", note: "close" });
    expect(openKid.status).toBe(400);
    const openKidBody = (await openKid.json()) as Record<string, any>;
    expect(openKidBody.result_class).toBe("gate_rejected");
    expect(openKidBody.error).toContain("[rule: done-open-children]");
    expect(openKidBody.error).toContain("1 open child");
    expect(JSON.stringify(openKidBody)).not.toMatch(NO_INFRA);
    expect((await getOne(parent)).status).toBe("in_progress");

    // close the last child, then the legal close lands
    expect((await post("/transition", { id: kids[15], to: "in_progress" })).status).toBe(200);
    expect((await post("/transition", { id: kids[15], to: "done", note: "child leg complete" })).status).toBe(200);

    const close = await post("/transition", {
      id: parent, to: "done",
      note: "closed citing the merged PR receipt (mergeCommit 0e155dd, merged outside the train)",
    });
    expect(close.status).toBe(200);
    const closeBody = (await close.json()) as Record<string, any>;
    expect(closeBody.status).toBe("done");
    expect((await getOne(parent)).status).toBe("done");
  });
});
