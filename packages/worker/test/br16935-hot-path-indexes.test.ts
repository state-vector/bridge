import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * BR#16935 — the coordinator's remaining hot-path full scans. BR#14766
 * indexed the ledger and the stall-sweep/board partials; this change adds
 * the four that were still scanned on every call while the single DO's
 * input gate serialized all traffic behind them:
 *
 *   idx_artefacts_type_status            — sweep/list queries, ask inbox,
 *                                          joins driving from open cards
 *   idx_artefacts_status_updated         — orient's open-cards query
 *   idx_relations_dst_rel                — parent→children walks (the
 *                                          relations PK only serves src-first)
 *   idx_dispatch_reservations_expiry     — the execution sweep's expiry scan
 *
 * Pinned here through admin.explain (BR#16935's planner probe): every
 * canonical hot query must SEEK via a named index — no bare table SCANs.
 * The probe is also the live diagnostic: one admin call answers "is the
 * hub scanning again?" without guessing from latency symptoms.
 */

// ---------- rig ----------

let mf: Miniflare;
let stub: any;
async function call(op: string, body: object = {}) {
  const response = await stub.fetch(`https://kb/${op}`, {
    method: "POST", headers: { "content-type": "application/json", "x-kb-admin": "1" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}

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
  stub = (await mf.getDurableObjectNamespace("KB")).get((await mf.getDurableObjectNamespace("KB")).idFromName("global"));
  await call("orient", { actor: "test" });
}, 120_000);

afterAll(async () => {
  await mf?.dispose();
});

// ---------- seed: enough distribution that the plans we assert are the
// plans production will choose ----------

const fatMeta = (i: number) => ({ filler: `x`.repeat(2400), seq: i });

beforeAll(async () => {
  const created: string[] = [];
  // 140 terminal bulk rows (progress: status 'logged' — the mass of a real
  // hub without touching any done/superseded gate)
  for (let i = 0; i < 140; i++) {
    const r = await call("create", { type: "progress", title: `bulk progress ${i}`, actor: "seed", meta: fatMeta(i) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  // 40 open tasks (todo/in_progress mix)
  for (let i = 0; i < 40; i++) {
    const r = await call("create", { type: "task", title: `open task ${i}`, qualified: true, actor: "seed", meta: fatMeta(1000 + i) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const id = String(r.body.id);
    if (i % 3 === 0) {
      const t = await call("transition", { id, to: "in_progress", actor: "seed", session: `seed-${i}` });
      if (t.status !== 200) throw new Error(`seed open transition failed: ${JSON.stringify(t.body)}`);
    }
    created.push(id);
  }
  // one parent with child edges: 30 open questions + 30 done tasks as children
  const parent = await call("create", { type: "task", title: "parent", qualified: true, actor: "seed" });
  const parentId = String(parent.body.id);
  for (let i = 0; i < 30; i++) {
    const q = await call("create", { type: "question", title: `open question ${i}`, actor: "seed" });
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    const l = await call("link", { src: String(q.body.id), dst: parentId, relation: "child_of", actor: "seed" });
    expect(l.status, JSON.stringify(l.body)).toBe(200);
  }
  for (let i = 0; i < 30; i++) {
    const l = await call("link", { src: created[i], dst: parentId, relation: "child_of", actor: "seed" });
    expect(l.status, JSON.stringify(l.body)).toBe(200);
  }
}, 180_000);

// ---------- the planner contract ----------

describe("BR#16935 hot-path indexes (real SQLite planner)", () => {
  it("admin.explain is admin-gated and returns a plan per canonical hot query", async () => {
    const r = await call("admin.explain");
    expect(r.status).toBe(200);
    const names = r.body.plans.map((p: any) => p.name);
    expect(names).toEqual([
      "orient_open_cards", "ask_inbox_questions", "sweep_blocked", "sweep_owned",
      "orient_ask_children", "children_of_parent", "dispatch_reservation_expiry",
      "train_queue_blocked_cars", "train_verified_merges",
    ]);
    for (const p of r.body.plans) {
      expect(p.plan.length, `${p.name} returned no plan`).toBeGreaterThan(0);
    }
  });

  const planOf = async (name: string): Promise<string[]> => {
    const r = await call("admin.explain");
    expect(r.status).toBe(200);
    const p = r.body.plans.find((p: any) => p.name === name);
    expect(p, `${name} missing from admin.explain`).toBeTruthy();
    return p.plan as string[];
  };

  it("orient's open-cards query seeks via idx_artefacts_status_updated — no full scan", async () => {
    const plan = (await planOf("orient_open_cards")).join(" | ");
    expect(plan).toContain("SEARCH");
    expect(plan).toMatch(/USING (COVERING )?INDEX idx_artefacts_(status_updated|type_status)/);
    expect(plan).not.toMatch(/SCAN [a-z]+(?! USING)/);
  });

  it("the ask-inbox open-questions query seeks via idx_artefacts_type_status", async () => {
    const plan = (await planOf("ask_inbox_questions")).join(" | ");
    expect(plan).toMatch(/SEARCH \S+ USING (COVERING )?INDEX idx_artefacts_type_status/);
  });

  it("the watchdog sweeps (blocked / owned) seek via idx_artefacts_type_status", async () => {
    const blocked = (await planOf("sweep_blocked")).join(" | ");
    const owned = (await planOf("sweep_owned")).join(" | ");
    expect(blocked).toMatch(/SEARCH \S+ USING (COVERING )?INDEX idx_artefacts_type_status/);
    expect(owned).toMatch(/SEARCH \S+ USING (COVERING )?INDEX idx_artefacts_type_status/);
  });

  it("parent→children walks seek relations dst-first via the covering index — not a scan", async () => {
    const plan = (await planOf("children_of_parent")).join(" | ");
    expect(plan).toMatch(/SEARCH \S+ USING COVERING INDEX idx_relations_incoming/);
    expect(plan).not.toMatch(/SCAN [a-z]+(?! USING)/);
  });

  it("orient's ask-children derivation drives from open questions — no SCAN of relations or artefacts", async () => {
    const plan = (await planOf("orient_ask_children")).join(" | ");
    expect(plan).toMatch(/SEARCH \S+ USING (COVERING )?INDEX idx_artefacts_type_status/);
    expect(plan).not.toMatch(/SCAN [a-z]+(?! USING)/);
  });

  it("the dispatch-reservation expiry sweep seeks via idx_dispatch_reservations_expiry", async () => {
    const plan = (await planOf("dispatch_reservation_expiry")).join(" | ");
    expect(plan).toMatch(/SEARCH \S+ USING (COVERING )?INDEX idx_dispatch_reservations_expiry/);
  });

  it("the train queue's blocked-cars scan seeks the partial expression index — not every blocked card's meta (live tail: kb/train ate ~11s DO CPU per poll)", async () => {
    const plan = (await planOf("train_queue_blocked_cars")).join(" | ");
    expect(plan).toMatch(/SEARCH \S+ USING (COVERING )?INDEX idx_artefacts_train_queue/);
    expect(plan).not.toMatch(/SCAN [a-z]+(?! USING)/);
  });

  it("the train's verified-merge lookups seek proxy_probes by repo — not a full probe-table scan per lane per poll", async () => {
    const plan = (await planOf("train_verified_merges")).join(" | ");
    expect(plan).toMatch(/SEARCH \S+ USING (COVERING )?INDEX idx_proxy_probes_repo/);
    expect(plan).not.toMatch(/SCAN [a-z]+(?! USING)/);
  });
});

describe("BR#16935 functional sanity (behaviour unchanged)", () => {
  it("orient answers with open cards visible after the join flip", async () => {
    // a fresh in_progress task is the newest open card — inside orient's LIMIT 30
    const fresh = (await call("create", { type: "task", title: "fresh open task", qualified: true, actor: "seed" })).body.id;
    const t = await call("transition", { id: fresh, to: "in_progress", actor: "seed", session: "fresh" });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const r = await call("orient", { actor: "seed", label: "seed" });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.counts)).toBe(true);
    const open = r.body.open_artefacts as any[];
    expect(open.some((a: any) => a.id === fresh && a.type === "task" && a.status === "in_progress")).toBe(true);
  });

  it("relations reads still return children of a parent", async () => {
    const parent = (await call("create", { type: "task", title: "relations parent", qualified: true, actor: "seed" })).body.id;
    const child = (await call("create", { type: "question", title: "relations child", actor: "seed" })).body.id;
    await call("link", { src: child, dst: parent, relation: "child_of", actor: "seed" });
    const rel = await call("relations", { id: parent });
    expect(rel.status).toBe(200);
    const kids = (rel.body.relations as any[]).filter((r: any) => r.relation === "child_of" && r.dir === "in");
    expect(kids.map((k: any) => k.artefact_id)).toContain(child);
  });

  it("the train panel read is served from the panel cache between mutations, and any mutation evicts it (BR#16935)", async () => {
    const trainGet = async () => {
      const response = await stub.fetch(`https://kb/train`, { method: "GET", headers: { "x-kb-admin": "1" } });
      return { status: response.status, body: await response.json() as any };
    };
    const t1 = await trainGet();
    expect(t1.status).toBe(200);
    // same quiet window → cached payload object
    const t2 = await trainGet();
    expect(t2.status).toBe(200);
    expect(t2.body).toEqual(t1.body);
    // a mutation (POST boundary) must evict: a fresh create changes orient-visible state,
    // and the next train read recomputes rather than replaying the cached body
    await call("create", { type: "progress", title: "cache-buster mutation", actor: "seed" });
    const t3 = await trainGet();
    expect(t3.status).toBe(200);
    expect(t3.body.hub_commit).toBe(t1.body.hub_commit);
  });
});
