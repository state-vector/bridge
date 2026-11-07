import { Miniflare } from "miniflare";
import { existsSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * BR#5370 — the reverse-reconcile spawner, the done gate, and machine-duty
 * children (occurrence #7: breach BR#5367 on BR#5349, the 5th same-ms
 * duplicate duty pair BR#5365/5366).
 *
 * Four legs, drilled against the real bundled worker (the br3819 rig):
 *
 *   A. the same-ms duplicate spawn is STRUCTURALLY impossible: a card whose
 *      meta binds one PR twice (meta.pr + a meta.prs row) — the exact shape
 *      of BR#5349 — is judged once per pass, and the duties-ledger claim is
 *      taken in the INSERT path before any card is created;
 *   B. reverse duties are relates-linked, NEVER child_of their close-target
 *      (BR#4894 spec b) — the duty pair can no longer be the open child
 *      that gates its own close-target's done;
 *   C. the done-open-children gate ignores machine-duty children
 *      (meta.machine_duty — BR#4894 spec c) and the refusal names the open
 *      children with ids AND statuses (BR#5370 finding B);
 *   D. vanish-detection consults merge-train state: a queued binding whose
 *      PR leaves the open list is train-owned (queued/mid-rebase is not
 *      vanished — BR#4894 Finding A; the occurrence #7 false positive), and
 *      the migration stamp (duties_v1) is on the record.
 */

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

const report = (repo: string, prs: unknown[]) => kbJson("/reconcile.report", { repo, prs, actor: "system:reconcile" });
const dutiesOf = async (repo: string) => (await kbJson("/reconcile.status", { repo })).body.duties;
const get = async (id: string) => (await kbJson("/get", { id })).body;
const relationsOf = async (id: string): Promise<any[]> => {
  const { body } = await kbJson("/relations", { id });
  return body.relations ?? body.artefacts ?? [];
};

beforeAll(async () => {
  // same rig recipe as br3819-self-edge.test.ts: realpath + modulesRoot + useSQLite
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
  kbNs = await mf.getDurableObjectNamespace("KB");
  await kbJson("/orient", {});
  // drill-local alarm sink: the reconcile ALARM must bind HERE, not the real sink
  const sink = await kbJson("/create", { type: "task", title: "ALARM SINK — br5370 drill", body_md: "test-local ask sink", tags: ["alarm"] });
  expect(sink.status).toBe(200);
  const set = await kbJson("/admin.settings_set", { settings: { reconcile_alarm_sink_id: String(sink.body.id) } });
  expect(set.body.error ?? "").toBe("");
});

afterAll(async () => {
  await mf?.dispose();
});

describe("BR#5370 A — the same-ms duplicate spawn is structurally impossible (real DO)", () => {
  it("a double-bound card (meta.pr + meta.prs) missing twice spawns exactly ONE ruling duty", async () => {
    // the BR#5349 shape: one card, the same PR stamped on both meta.pr and a
    // meta.prs row → two bindings → (pre-fix) two spawn_reverse judgements in
    // ONE pass → BR#5365 + BR#5366, created_ts identical to the ms.
    const repo = "state-vector/br5370-drill-a";
    const binding = await kbJson("/create", {
      type: "task", title: "IMPL: br5370 double-bind drill", session: "",
      meta: { pr: { repo, number: 5501 }, prs: [{ repo, number: 5501 }] },
    });
    expect(binding.status).toBe(200);
    await report(repo, []); // first miss: clock starts (once)
    const m2 = await report(repo, []); // second miss, no provenance
    expect(m2.body.accounting.reverse_dutied).toBe(1);
    const duties = await dutiesOf(repo);
    expect(duties).toHaveLength(1);
    expect(duties.map((d: any) => d.kind)).toEqual(["reverse"]);
    const rulingId = String(duties[0].duty_id);
    // the third miss does not mint a twin (one duty per PR ever)
    const m3 = await report(repo, []);
    expect(m3.body.accounting.reverse_dutied).toBe(0);
    expect((await dutiesOf(repo)).map((d: any) => String(d.duty_id))).toEqual([rulingId]);
  });
});

describe("BR#5370 B — reverse duties are relates-linked, never child_of their close-target", () => {
  it("the ruling duty rides 'relates'; the binding closes first-line with the duty OPEN", async () => {
    const repo = "state-vector/br5370-drill-b";
    const binding = await kbJson("/create", {
      type: "task", title: "IMPL: br5370 relates drill", session: "",
      meta: { pr: { repo, number: 5502 } },
    });
    const bindingId = String(binding.body.id);
    await report(repo, []); // first miss
    const m2 = await report(repo, []); // second miss, no provenance → duty
    expect(m2.body.accounting.reverse_dutied).toBe(1);
    const duties = await dutiesOf(repo);
    const rulingId = String(duties[0].duty_id);

    // BR#4894 spec b: 'relates' to the close-target, NEVER 'child_of'
    const rels = await relationsOf(rulingId);
    expect(rels.some((r: any) => r.relation === "relates" && r.artefact_id === bindingId && r.dir === "out")).toBe(true);
    expect(rels.some((r: any) => r.relation === "child_of")).toBe(false);
    const ruling = await get(rulingId);
    expect(ruling.meta?.machine_duty?.kind).toBe("reverse");
    expect(String(ruling.body_md)).toContain("relates-linked");

    // the landed-close class (occurrence #7): the zombie binding closes
    // FIRST-LINE with the ruling duty still open — no 3-rejection breach burn
    await kbJson("/transition", { id: bindingId, to: "in_progress", note: "drill: unpark for the close" });
    await completeMainReview(kbJson, bindingId, repo, "a".repeat(40));
    expect((await get(bindingId)).status).toBe("done");
  });
});

describe("BR#5370 C — the done gate ignores machine-duty children; the refusal names the rest", () => {
  it("a machine_duty child does not fence done; a plain child does — and the refusal names it with its status", async () => {
    const { body: parent } = await kbJson("/create", { type: "task", title: "Analysis: br5370 relation gate drill", roles: ["analysis"], session: "" });
    const parentId = String(parent.id);
    const { body: duty } = await kbJson("/create", {
      type: "task", title: `Unblock: br5370 gate drill (machine duty)`, session: "",
      meta: { machine_duty: { by: "hub", kind: "unblock", subject: parentId } },
      roles: ["unblock"],
    });
    const dutyId = String(duty.id);
    const { body: plain } = await kbJson("/create", { type: "task", title: "subtask: br5370 gate drill (real child)", roles: ["analysis"], session: "" });
    const plainId = String(plain.id);
    for (const child of [dutyId, plainId]) {
      const l = await kbJson("/link", { src: child, relation: "child_of", dst: parentId });
      expect(l.body.error ?? "").toBe("");
    }
    await kbJson("/transition", { id: parentId, to: "in_progress", note: "drill: claim" });
    const execution_result = { outcome: "Relation graph investigated", receipts: [parentId, plainId] };

    // attempt 1 with BOTH open: the machine duty is invisible to the gate;
    // the plain child is named — id AND status — on the FIRST rejection
    const refused = await kbJson("/transition", { id: parentId, to: "done", execution_result, note: "drill: closing with children open" });
    expect(String(refused.body.error)).toContain("still has 1 open child task(s)");
    expect(String(refused.body.error)).toContain(`Open child: ${plainId} (todo)`);
    expect(String(refused.body.error)).not.toContain(dutyId);

    // close the plain child → the parent closes with the machine duty open
    await kbJson("/transition", { id: plainId, to: "in_progress", note: "drill: claim child" });
    const closedChild = await kbJson("/transition", { id: plainId, to: "done", execution_result: { outcome: "Child analysis complete", receipts: [plainId] }, note: "drill: child closed" });
    expect(closedChild.status, JSON.stringify(closedChild.body)).toBeLessThan(400);
    const done = await kbJson("/transition", { id: parentId, to: "done", execution_result, note: "drill: parent closes with the machine duty open (BR#5370)" });
    expect(done.status, `parent close failed: ${JSON.stringify(done.body)}`).toBeLessThan(400);
    expect((await get(parentId)).status).toBe("done");
    // the close itself proved the exclusion: attempt 1 named only the plain
    // child, attempt 2 succeeded with the machine duty OPEN. Post-close, the
    // parent's done closes its unblock round (supersede_children, tag
    // "unblock" — children are ephemeral, machine.ts) — the pre-existing
    // lifecycle, which the marker never touched.
    expect((await get(dutyId)).status).toBe("superseded");
  });

  it("the in_review flow's own Verify child still fences done (it IS the review acceptance)", async () => {
    // control for the exclusion's boundary: the verdict-spawned verify duty
    // (auto:"verification") carries NO machine_duty marker and keeps gating
    const { body: parent } = await kbJson("/create", { type: "task", title: "IMPL: br5370 verify-fence control", session: "" });
    const parentId = String(parent.id);
    await kbJson("/transition", { id: parentId, to: "in_progress", note: "drill: claim" });
    const review = await kbJson("/transition", { id: parentId, to: "in_review", note: "PR https://github.com/state-vector/bridge/pull/1" });
    const verifyId = review.body.verify_task;
    expect(verifyId, "in_review must auto-spawn its Verify child").toBeTruthy();
    const verifyMeta = (await get(String(verifyId))).meta;
    expect(verifyMeta?.machine_duty).toBeUndefined(); // unmarked by design
    const refused = await kbJson("/transition", { id: parentId, to: "done", note: "drill: closing with the verify child open" });
    expect(String(refused.body.error)).toContain(`Open child: ${verifyId} (todo)`);
  });
});

describe("BR#5370 D — vanish-detection consults the merge train; the migration is on the record", () => {
  it("a queued binding whose PR left the open list never spawns a ruling duty (occurrence #7 drill)", async () => {
    // reproduce the false positive: BR#5349 was blocked + queued on its PR
    // (meta.merge_train) when the reconciler spawned the reverse duty — the
    // PR was still OPEN and merged ~7.1 minutes later.
    const repo = "state-vector/br5370-drill-d";
    const queued = await kbJson("/create", {
      type: "task", title: "IMPL: br5370 queued-vanish drill", session: "",
      meta: { pr: { repo, number: 5503 }, merge_train: { pr: 5503, state: "queued" } },
    });
    const queuedId = String(queued.body.id);
    await kbJson("/transition", { id: queuedId, to: "in_progress", note: "drill: claim" });
    // the machine-managed park: merge_train in the BODY is the blocked
    // gate's machine-managed-park leg (no typed await_event needed —
    // machine.ts blocked-needs-typed-await); meta.merge_train (pr>0) + the
    // blocked status is what the binding reader reads as `queued`
    // (do.ts: status==='blocked' && meta.merge_train.pr>0).
    const parked = await kbJson("/transition", {
      id: queuedId, to: "blocked",
      note: "merge-train: queued on PR 5503 — drill park",
      merge_train: { pr: 5503, state: "queued" },
    });
    expect(parked.body.error ?? "", JSON.stringify(parked.body)).toBe("");
    const m1 = await report(repo, []); // first miss
    expect(m1.body.accounting.reverse_train_exempt).toBe(1);
    expect(m1.body.accounting.reverse_dutied).toBe(0);
    const m2 = await report(repo, []); // second miss — would have spawned pre-fix
    expect(m2.body.accounting.reverse_train_exempt).toBe(1);
    expect(m2.body.accounting.reverse_dutied).toBe(0);
    expect((await dutiesOf(repo)).length).toBe(0);
    expect((await get(queuedId)).status).toBe("blocked"); // untouched — the train owns it
    // control: an UNQUEUED binding on the same shape still rules normally
    const unqueued = await kbJson("/create", {
      type: "task", title: "IMPL: br5370 plain-vanish control", session: "",
      meta: { pr: { repo, number: 5504 } },
    });
    const unqueuedId = String(unqueued.body.id);
    await report(repo, []);
    const mc2 = await report(repo, []);
    expect(mc2.body.accounting.reverse_dutied).toBe(1);
    const duties = await dutiesOf(repo);
    expect(duties.map((d: any) => d.kind)).toEqual(["reverse"]);
    expect(String(duties[0].duty_id)).toBeTruthy();
    expect((await get(unqueuedId)).status).not.toBe("done");
  });

  it("the duties_v1 migration stamped its settings key once and is idempotent across boots", async () => {
    const { body } = await kbJson("/admin.settings_get", {});
    const stamp = body.settings?.duties_v1 ?? body.duties_v1;
    expect(stamp, "the migration must stamp its settings key on boot").toBeTruthy();
    const parsed = typeof stamp === "string" ? JSON.parse(stamp) : stamp;
    expect(Number(parsed.stamped)).toBeGreaterThanOrEqual(0);
    expect(Number(parsed.rewritten)).toBeGreaterThanOrEqual(0);
    await kbJson("/orient", {}); // ensureSchema runs again — one-time, not per-boot
    const { body: again } = await kbJson("/admin.settings_get", {});
    const stamp2 = again.settings?.duties_v1 ?? again.duties_v1;
    const parsed2 = typeof stamp2 === "string" ? JSON.parse(stamp2) : stamp2;
    expect(parsed2.ts).toBe(parsed.ts);
  });
});
import { completeMainReview } from "./completion-fixture";
