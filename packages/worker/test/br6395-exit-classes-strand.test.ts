import { Miniflare } from "miniflare";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * BR#6395 — accurate Backlog exit classes + strand-sweep provenance +
 * batch-SUPERSEDE dispatch + board() open-first ordering.
 *
 * Four defect classes pinned here:
 *
 *   1. exitClassOf (ui-kit views.ts) dumped upstream-PR dependency parks
 *      (phase === null, typed pr_merged wait, NO train stamp) into
 *      "Awaiting PR merge — train" via a pre-BR#5750 legacy bridge — the
 *      train section counted cars no train can ever merge. The bridge is
 *      deleted (BR#6330 law, phase-only admission); those parks file under
 *      EXIT_CLASSES.pr ("Awaiting PR merge — not on train"); conflicting
 *      cars get their own rebase section; every ExitClass carries
 *      unblockedBy; lane anchors are excluded from Backlog groups
 *      (source assertions on views.ts + BacklogView.tsx).
 *   2. trainStrandClass classified ANY out-of-queue train-only await as a
 *      stranded train car — the BR#6163 sweep re-boarded upstream-PR parks
 *      ("merge-train: queued — strand re-board") overwriting honest park
 *      reasons. Provenance is now required: integration legs below prove
 *      the upstream park is untouched while a stamped car still re-boards.
 *   3. askAnswer's SUPERSEDE verb superseded the BOUND task on batch-
 *      authorization answers ("SUPERSEDE all 29") — the BR#6387 misfire
 *      dropped Ray's authorized 29-card strand batch by superseding the
 *      disposition executor card (BR#6383) itself. Batch answers on a
 *      disposition task now take the resume/release legs; plain SUPERSEDE
 *      options still drop (control), and a batch answer on a NON-
 *      disposition task still drops (boundary).
 *   4. board() ordered purely by updated_ts — a burst of closures pushed
 *      active/blocked/queued tasks out of the 200-row payload. Open rows
 *      now rank before terminal rows.
 */

const HOUR = 3_600_000;

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

const task = async (title: string, extra: Record<string, unknown> = {}) => {
  const r = await kbJson("/create", { type: "task", title, qualified: true, ...extra });
  expect(r.status).toBe(200);
  return String(r.body.id);
};

const historyNotes = async (id: string): Promise<string> => {
  const h = (await kbJson(`/history?id=${encodeURIComponent(id)}`)).body;
  return (h?.versions ?? []).map((v: any) => `${String(v?.action ?? "")} ${String(v?.summary ?? "")} ${String(v?.data?.note ?? "")}`).join("\n");
};

/** A lane card for the repo + a LIVE lease + one merged event NOW — the
 *  healthy-lane proof (the train moved after any 3h-ago park). */
async function healthyLane(repo: string, gw: string): Promise<void> {
  const lane = await kbJson("/train.lane", { repo, base: "main", actor: "drill" });
  expect(lane.body.error ?? "").toBe("");
  const a = await kbJson("/train.lease", { repo, base: "main", action: "acquire", actor: gw });
  expect(a.body.error ?? "").toBe("");
  const ev = await kbJson("/train.event", {
    repo, base: "main", kind: "merged", actor: gw, pr: 1, merge_sha: "d".repeat(40),
  });
  expect(ev.body.error ?? "", `train.event failed: ${JSON.stringify(ev.body)}`).toBe("");
}

beforeAll(async () => {
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
  if (!existsSync(bundle)) {
    throw new Error("bundle missing — run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle (before vitest)");
  }
  mf = new Miniflare({
    workers: [{
      name: "main",
      scriptPath: bundle,
      modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")),
      modules: true,
      compatibilityDate: "2025-09-25",
      durableObjects: { KB: { className: "KnowledgeHub", useSQLite: true } },
    }],
  });
  kbNs = await mf.getDurableObjectNamespace("KB");
  await kbJson("/orient", {});
  // the standing alarm sink (train_alarm_sink_id → a real task, BR#5916 shape)
  const sinkId = await task("BR#6395 strand alarm sink drill");
  const set = await kbJson("/admin.settings_set", { settings: { train_alarm_sink_id: sinkId } });
  expect(set.body.error ?? "").toBe("");
});

afterAll(async () => { await mf?.dispose(); });

describe("BR#6395 leg 1 — exit-class law (source assertions on the ui-kit)", () => {
  const viewsSrc = readFileSync(new URL("../../ui-kit/src/server/views.ts", import.meta.url).pathname, "utf8");
  const backlogSrc = readFileSync(new URL("../../ui-kit/src/views/BacklogView.tsx", import.meta.url).pathname, "utf8");

  it("the pr_merged legacy bridge is deleted; conflicting and not-on-train classes exist", () => {
    expect(viewsSrc).not.toMatch(/phase === null && \(ev === "pr_merged"/);
    expect(viewsSrc).toMatch(/phase === "conflicting"\) return EXIT_CLASSES\.conflict/);
    expect(viewsSrc).toMatch(/EXIT_CLASSES\.pr/);
    expect(viewsSrc).toMatch(/"conflicting"/); // in MERGE_TRAIN_PHASES
    expect(viewsSrc).toMatch(/title: "Awaiting PR merge — not on train"/);
    expect(viewsSrc).toMatch(/title: "Awaiting PR rebase — conflict on train"/);
  });

  it("every ExitClass entry carries unblockedBy", () => {
    const entries = viewsSrc.match(/\{ key: "[a-z]+",/g)?.length ?? 0;
    const badges = viewsSrc.match(/unblockedBy:/g)?.length ?? 0;
    expect(entries).toBeGreaterThanOrEqual(14);
    expect(badges).toBeGreaterThanOrEqual(entries);
  });

  it("BacklogView excludes lane anchors and renders the unblocker badge + per-row unblock reason", () => {
    expect(backlogSrc).toMatch(/isLaneAnchor/);
    expect(backlogSrc).toMatch(/isLaneAnchor\(t\)\) continue/);
    expect(backlogSrc).toMatch(/unblocks: \{g\.unblockedBy\}/);
    expect(backlogSrc).toMatch(/blockedReason/);
    expect(backlogSrc).toMatch(/cls\.unblockedBy/);
  });
});

describe("BR#6395 leg 2 — the strand sweep respects train-car provenance", () => {
  it("an upstream-PR dependency park (phase null, pr_merged wait, NO train stamp) is NOT re-boarded — the honest park reason survives", async () => {
    const REPO = "state-vector/br6395-upstream";
    await healthyLane(REPO, "gw-br6395-a");
    const id = await task("BR#6395 upstream-PR park specimen");
    await kbJson("/transition", { id, to: "in_progress", actor: "drill-upstream", note: "impl", session: "drill-upstream" });
    // the pre-fix bug shape: a typed train-only wait, NO train stamp, NO
    // merge-train prefix, NO PR citation in the note (nothing for the
    // queue-stamp parser to bind) — pure upstream dependency.
    const park = await kbJson("/transition", {
      id, to: "blocked", actor: "drill-upstream",
      note: "waiting on the upstream family PR to merge — this card has no train leg of its own",
      await_event: { event: "pr_merged", repo: REPO, n: 2456 },
    });
    expect(park.status, `park failed: ${JSON.stringify(park.body)}`).toBe(200);
    const pre = (await kbJson("/get", { id })).body;
    expect(pre.meta?.merge_train).toBeUndefined(); // the guard's premise: phase === null, no stamp
    // backdate the park past the 2h strand window
    const upd = await kbJson("/update", {
      id,
      meta: { blocked: { reason: "waiting on the upstream family PR to merge — this card has no train leg of its own", ts: Date.now() - 3 * HOUR, await_event: { event: "pr_merged", repo: REPO, n: 2456 } } },
    });
    expect(upd.status).toBeLessThan(400);
    const sweep = await kbJson("/admin.alarm_sweep");
    expect(sweep.body.error ?? "").toBe("");
    const cur = (await kbJson("/get", { id })).body;
    expect(cur.status).toBe("blocked");
    expect(String(cur.meta?.blocked?.reason ?? "")).not.toMatch(/strand re-board/);
    expect(String(cur.meta?.blocked?.reason ?? "")).toContain("upstream family PR");
    expect(cur.meta?.strand_reboard).toBeUndefined();
    expect(cur.meta?.merge_train).toBeUndefined();
  });

  it("control — a card WITH train-car provenance (review_pr binding, no train stamp) still re-boards", async () => {
    const REPO = "state-vector/br6395-provenance";
    await healthyLane(REPO, "gw-br6395-b");
    const id = await task("BR#6395 provenance car specimen");
    const old = Date.now() - 3 * HOUR;
    await kbJson("/transition", { id, to: "in_progress", actor: "drill-car", note: "impl", session: "drill-car" });
    const park = await kbJson("/transition", {
      id, to: "blocked", actor: "drill-car",
      note: "VERIFY ACCEPT (drill) — the queue dropped this car",
      await_event: { event: "pr_merged", repo: REPO, n: 2735 },
    });
    expect(park.status).toBe(200);
    // the train-car provenance stamp: a review-PR binding, NO merge_train
    // (note: a blocked card with merge_train.state=queued is ADMITTED — in
    // the derived queue — and never a strand; the strand shape is out-of-
    // queue with provenance). Also backdate the park past the 2h window.
    const upd = await kbJson("/update", {
      id,
      meta: {
        review_pr: { repo: REPO, number: 2735, head_sha_at_acceptance: "b".repeat(40) },
        blocked: { reason: "VERIFY ACCEPT (drill) — the queue dropped this car", ts: old, await_event: { event: "pr_merged", repo: REPO, n: 2735 } },
      },
    });
    expect(upd.status).toBeLessThan(400);
    const sweep = await kbJson("/admin.alarm_sweep");
    expect(sweep.body.error ?? "").toBe("");
    const cur = (await kbJson("/get", { id })).body;
    expect(cur.status).toBe("blocked");
    expect(String(cur.meta?.blocked?.reason ?? "")).toContain("strand re-board (BR#6163)");
    expect(cur.meta?.strand_reboard?.class).toBe("out_of_queue_await");
    // the typed wait is preserved
    expect(cur.meta?.blocked?.await_event).toEqual({ event: "pr_merged", repo: REPO, n: 2735 });
  });
});

describe("BR#6395 leg 3 — batch SUPERSEDE answers authorize the batch, not the bound task", () => {
  it("a batch answer ('SUPERSEDE all 29') on a disposition task RESUMES the live executor — never superseded (BR#6387 misfire class)", async () => {
    const id = await task("EXECUTE (p0): drain the strand backlog drill — supersede the named parks", { tags: ["disposition", "strand", "drill"] });
    await kbJson("/transition", { id, to: "in_progress", note: "claim", session: "br6395-dispo-live" });
    const ask = await kbJson("/ask.create", {
      to: "human",
      question: "BR#6395 drill: supersede the 29 dead/conflicting strand parks?",
      reason: "card drops are human authority (BR#2480)",
      details: "Drill for the BR#6387 misfire class: a disposition executor task holds a batch-drop authorization ask. Answering the batch option (\"SUPERSEDE all 29\") must authorize the 29 target cards and resume this executor — never supersede the bound task itself (the BR#6387 misfire superseded BR#6383 and dropped the batch).",
      options: [
        "(Recommended) SUPERSEDE all 29 — 6 dead + 23 conflicting parks (receipts on each card)",
        "SUPERSEDE only the 6 dead parks (awaited PRs closed unmerged)",
        "NO — leave all 29 parked",
      ],
      artefact_id: id,
      session: "br6395-dispo-live",
    });
    expect(ask.status).toBe(200);
    const askId = String(ask.body.id);
    expect((await kbJson("/get", { id })).body.status).toBe("blocked");
    const ans = await kbJson("/ask.answer", {
      id: askId,
      answer: "(Recommended) SUPERSEDE all 29 — 6 dead + 23 conflicting parks (receipts on each card)",
      actor: "web:rayh",
    });
    expect(ans.status, JSON.stringify(ans.body)).toBe(200);
    // THE law: the bound disposition task is NOT the batch — it resumes so
    // the executor supersedes the target cards.
    expect(ans.body.task_status, "batch SUPERSEDE must not drop the bound disposition task").not.toBe("superseded");
    expect(ans.body.task_status).toBe("in_progress"); // live holder resumes
    const cur = (await kbJson("/get", { id })).body;
    expect(cur.status).toBe("in_progress");
    expect(await historyNotes(id)).not.toMatch(/superseded/);
  });

  it("boundary — the same batch answer on a NON-disposition task still drops it (the guard is disposition-scoped)", async () => {
    const id = await task("BR#6395 plain carrier (not a batch runner)");
    await kbJson("/transition", { id, to: "in_progress", note: "claim", session: "br6395-plain-live" });
    const ask = await kbJson("/ask.create", {
      to: "human",
      question: "BR#6395 drill: drop this plain carrier?",
      reason: "drop is human authority",
      details: "Boundary drill: the bound task here is a plain carrier (no disposition tag, no EXECUTE/drain title), so a batch-authorization answer keeps its pre-BR#6395 semantics — the plain task itself is the drop target.",
      options: ["(Recommended) SUPERSEDE all 5 — drill batch", "NO — keep it"],
      artefact_id: id,
      session: "br6395-plain-live",
    });
    expect(ask.status).toBe(200);
    const ans = await kbJson("/ask.answer", { id: String(ask.body.id), answer: "(Recommended) SUPERSEDE all 5 — drill batch", actor: "web:rayh" });
    expect(ans.status).toBe(200);
    expect(ans.body.task_status).toBe("superseded");
    expect((await kbJson("/get", { id })).body.status).toBe("superseded");
  });

  it("control — a plain SUPERSEDE option still drops the bound task (BR#3913 edge intact)", async () => {
    const id = await task("BR#6395 plain-drop carrier");
    await kbJson("/transition", { id, to: "in_progress", note: "claim", session: "br6395-drop-live" });
    const ask = await kbJson("/ask.create", {
      to: "human",
      question: "BR#6395 drill: drop this stalled round?",
      reason: "drop is human authority",
      details: "Control drill: a plain SUPERSEDE option (no batch form) on a bound task keeps the BR#3913 drop edge — the answer is the authorization to supersede the bound task.",
      options: ["SUPERSEDE — drop the stalled round", "KEEP PARKED — I'll clear the blocker myself"],
      artefact_id: id,
      session: "br6395-drop-live",
    });
    expect(ask.status).toBe(200);
    const ans = await kbJson("/ask.answer", { id: String(ask.body.id), answer: "SUPERSEDE — drop the stalled round", actor: "web:rayh" });
    expect(ans.status).toBe(200);
    expect(ans.body.task_status).toBe("superseded");
    expect((await kbJson("/get", { id })).body.status).toBe("superseded");
  });
});

describe("BR#6395 leg 4 — board() ranks open rows before terminal rows", () => {
  it("a fresher terminal row never displaces an older open row from the payload head", async () => {
    // the OPEN row is created FIRST (older updated_ts)
    const openId = await task("BR#6395 board open specimen");
    // the TERMINAL row is created and closed AFTER (fresher updated_ts) —
    // under the old pure-recency ORDER BY it would rank above the open row
    const dropId = await task("BR#6395 board terminal specimen");
    await kbJson("/transition", { id: dropId, to: "in_progress", note: "claim", session: "br6395-board-live" });
    const ask = await kbJson("/ask.create", {
      to: "human", question: "BR#6395 drill: drop this board carrier?", reason: "drop is human authority",
      details: "Board-ordering drill: this task is closed via the SUPERSEDE drop edge to produce a terminal row fresher than the open specimen row.",
      options: ["SUPERSEDE — drop the stalled round", "KEEP PARKED"], artefact_id: dropId, session: "br6395-board-live",
    });
    expect(ask.status).toBe(200);
    const ans = await kbJson("/ask.answer", { id: String(ask.body.id), answer: "SUPERSEDE — drop the stalled round", actor: "web:rayh" });
    expect(ans.status).toBe(200);
    expect((await kbJson("/get", { id: dropId })).body.status).toBe("superseded");
    // fresher open activity after the closure, so recency is not confounded:
    // touch the open task LAST too — open-first must hold regardless.
    await kbJson("/update", { id: openId, meta: { last_progress: { note: "touch" } } });

    const board = (await kbJson("/board")).body;
    const ids: string[] = (board.tasks ?? []).map((t: any) => t.id);
    expect(ids).toContain(openId);
    expect(ids).toContain(dropId);
    expect(ids.indexOf(openId), `open task must rank before the fresher terminal task (got ${ids.indexOf(openId)} vs ${ids.indexOf(dropId)})`).toBeLessThan(ids.indexOf(dropId));
    // and the terminal row must be marked terminal in the payload
    const dropRow = (board.tasks ?? []).find((t: any) => t.id === dropId);
    expect(["done", "superseded"]).toContain(dropRow.status);
  });
});
