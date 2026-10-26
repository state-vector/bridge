#!/usr/bin/env node
/**
 * merge-train.mjs — the merge-train EXECUTOR (decision BR#3516, impl BR#3517).
 *
 * Division of labour (the whole point of the design): the HUB holds NO VCS
 * credentials, ever. This script runs on an edge/gateway machine that HAS
 * `gh` + a clone of the target repo, fetches every GitHub fact live, and
 * reports them through the hub's train ops — the HUB decides (lease CAS,
 * classification, events, queue). The executor never self-certifies: green
 * is whatever the hub classifies from the fed check runs.
 *
 * Loop (one tick): preflight → train_status → per lane: CAS-lease →
 * reconcile from live GitHub (never trust a prior holder's picture) →
 * awaiting-CI poll (train_ci; hub lands/stops/pends) → else queue[0] →
 * the card's first UNLANDED leg on this lane (BR#3659: multi-PR parents
 * ride leg by leg; a card closes only when its LAST leg lands) →
 * decideTrainGate (imported from packages/worker/src/kb/core.ts — ONE gate
 * implementation, unit-pinned in test/merge-train.test.ts) → act:
 * merge (gh) → train:merged → next tick polls CI on the merge commit.
 *
 * Carry law (BR#3516 §5): base advanced and the update is machine-clean →
 * `gh pr update-branch` and the accepted verdict CARRIES (the hub appends
 * the carry record on train:merged); conflicts are human-resolved → the
 * verdict is INVALID: trial `git merge-tree` enumerates the conflicting
 * files, train:bounced lists them, the card re-verifies and re-queues at
 * the back.
 *
 * Env: BRIDGE_URL, BRIDGE_TOKEN (required). Optional:
 *   MERGE_TRAIN_HOLDER          lease holder label (default merge-train@<host>)
 *   MERGE_TRAIN_INTERVAL_SECS   tick cadence (default 45)
 *   MERGE_TRAIN_METHOD          gh merge method: merge | squash | rebase (default merge)
 *   MERGE_TRAIN_WORKDIR         clone of the target repo (default cwd)
 * Flags: --lane <repo>@<base>  drive one lane only
 *        --once                a single tick (cron-friendly), then exit
 *        --interval <secs>     override the tick cadence
 *        --method <m>          override the merge method
 *
 * Run `bridge doctor` first — it defends gh auth, git, the hub token, and
 * executor currency; this script re-probes the cheap ones each start.
 */

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  classifyMainCheckRuns,
  decideTrainGate,
  mergeSweepHumanLegTitle,
  normalizeGhMergeable,
  normalizeGhMergeState,
  trainLegs,
  trainLegLanded,
  TRAIN_CI_BOUND_MULTIPLIER,
  TRAIN_CI_TYPICAL_MINUTES,
} from "../packages/worker/src/kb/core.ts";

// ---------------------------------------------------------------------------
// config + small utilities
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const LANE_FILTER = flag("--lane") ?? null; // "repo@base"
const ONCE = args.includes("--once");
const INTERVAL = Number(flag("--interval") ?? process.env.MERGE_TRAIN_INTERVAL_SECS ?? 45) * 1000;
const METHOD = flag("--method") ?? process.env.MERGE_TRAIN_METHOD ?? "merge";
const HOLDER = process.env.MERGE_TRAIN_HOLDER ?? `merge-train@${os.hostname().split(".")[0]}`;
const HUB = (process.env.BRIDGE_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.BRIDGE_TOKEN ?? "";
const SESSION = "merge-train-executor";
const WORKDIR = process.env.MERGE_TRAIN_WORKDIR ?? process.cwd();

const log = (lane, msg) => console.log(`[${new Date().toISOString()}]${lane ? ` ${lane}` : ""} ${msg}`);

// MCP over the hub's /mcp (same JSON-RPC surface the agents use).
let rpcId = 0;
async function mcp(name, argsBody = {}) {
  if (!HUB || !TOKEN) throw new Error("BRIDGE_URL / BRIDGE_TOKEN not set — run `bridge doctor`, export both, retry");
  const r = await fetch(`${HUB}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: { ...argsBody, session: SESSION } } }),
  });
  const out = await r.json();
  if (out.error) throw new Error(`hub rpc error (${name}): ${out.error.message ?? JSON.stringify(out.error)}`);
  const raw = out.result?.content?.[0]?.text ?? "";
  const parsed = (() => { try { return JSON.parse(raw); } catch { return null; } })();
  if (out.result?.isError) throw new Error(`hub tool error (${name}): ${raw.slice(0, 300)}`);
  return parsed;
}

// gh/git inside the target clone; we read stdout, surface stderr on failure.
function sh(cmd, argsArr, { input } = {}) {
  const p = spawnSync(cmd, argsArr, { cwd: WORKDIR, encoding: "utf8", input, maxBuffer: 32 * 1024 * 1024 });
  if (p.status !== 0) {
    const err = new Error(`${cmd} ${argsArr.join(" ")} failed (${p.status}): ${(p.stderr ?? "").trim().slice(0, 400)}`);
    err.cmd = `${cmd} ${argsArr.join(" ")}`;
    throw err;
  }
  return (p.stdout ?? "").trim();
}
const ghJson = (argsArr) => {
  const out = sh("gh", argsArr);
  try { return JSON.parse(out); } catch (e) { throw new Error(`gh gave non-JSON output: ${out.slice(0, 200)}`); }
};

// ---------------------------------------------------------------------------
// preflight — cheap, every start. `bridge doctor` owns the deep checks
// (gh authed, deploy drift, token validity, executor currency); these four
// make the executor fail loud instead of limping.
// ---------------------------------------------------------------------------

function preflight() {
  const bad = [];
  for (const c of ["gh", "git"]) {
    const p = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (p.status !== 0) bad.push(`${c} not runnable`);
  }
  const auth = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
  if (auth.status !== 0) bad.push(`gh not authed (${(auth.stderr ?? "").trim().slice(0, 120)})`);
  const git = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: WORKDIR, encoding: "utf8" });
  if (git.status !== 0) bad.push(`${WORKDIR} is not a git clone (set MERGE_TRAIN_WORKDIR)`);
  if (!["merge", "squash", "rebase"].includes(METHOD)) bad.push(`unknown merge method '${METHOD}'`);
  if (bad.length) throw new Error(`preflight failed: ${bad.join("; ")}`);
  log(null, `executor up — holder=${HOLDER} method=${METHOD} interval=${INTERVAL / 1000}s workdir=${WORKDIR}`);
}

// ---------------------------------------------------------------------------
// GitHub fact fetchers (executor side — the hub's facts ALL ride these)
// ---------------------------------------------------------------------------

/** PR head facts: head sha, mergeability, merge state, state, merge commit.
 *  BR#3714: gh's JSON here is the GraphQL shape — `mergeable` is the enum
 *  STRING "MERGEABLE"|"CONFLICTING"|"UNKNOWN" (never a boolean) and
 *  `mergeStateStatus` is UPPERCASE. Normalized AT the fact boundary so the
 *  5c gate's boolean/lowercase contract holds for every consumer (gate,
 *  bounce triage, update-branch recheck); the pure normalizers are
 *  unit-pinned in test/merge-train.test.ts. */
function prFacts(repo, n) {
  const raw = ghJson(["pr", "view", String(n), "--repo", repo, "--json",
    "number,headRefOid,mergeable,mergeStateStatus,state,mergeCommit,baseRefName"]);
  return {
    ...raw,
    mergeable: normalizeGhMergeable(raw.mergeable),
    mergeStateStatus: normalizeGhMergeState(raw.mergeStateStatus),
  };
}

/** Check runs on a commit (merge-commit CI poll + head/base checks). */
function checkRuns(repo, sha) {
  const out = ghJson(["api", `repos/${repo}/commits/${sha}/check-runs`,
    "--jq", "[.check_runs[] | {id, name, status, conclusion, html_url}]"]);
  return Array.isArray(out) ? out : [];
}

/** Every commit of the PR with GitHub's signature verification verdict. */
function prCommits(repo, n) {
  const out = ghJson(["api", `repos/${repo}/pulls/${n}/commits`,
    "--jq", "[.[] | {sha: .sha, verified: .commit.verification.verified}]"]);
  return Array.isArray(out) ? out : [];
}

/** Merge method — the gh flag per method. */
const METHOD_FLAG = { merge: "--merge", squash: "--squash", rebase: "--rebase" };

/** Trial merge (plumbing, no worktree): returns {clean, files} for the
 *  bounce brief's conflict list. `git merge-tree --write-tree --name-only`
 *  exits 1 on conflict and names the files; exit 0 = clean. */
function trialMerge(base, headSha) {
  sh("git", ["fetch", "--quiet", "origin", base]);
  const p = spawnSync("git", ["merge-tree", "--write-tree", "--name-only", `origin/${base}`, headSha], { cwd: WORKDIR, encoding: "utf8" });
  if (p.status === 0) return { clean: true, files: [] };
  const lines = (p.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  return { clean: false, files: lines.slice(1) }; // line 0 is the (partial) tree oid
}

// ---------------------------------------------------------------------------
// the lane driver — one lane, one tick
// ---------------------------------------------------------------------------

async function driveLane(lane) {
  const [repo, base] = lane.lane.split("@");
  const key = lane.lane;
  const required = lane.required_workflows ?? [];
  const typical = (lane.ci_typical_minutes ?? TRAIN_CI_TYPICAL_MINUTES) * 60_000;

  // ---- CAS lease (the hub decides; a conflict means ANOTHER live executor).
  // holder is ALWAYS the authenticated actor (the hub stamps it) — a
  // hand-set holder would not match the lease check on the mutating ops. ----
  let lease;
  try {
    lease = await mcp("train_lease", { repo, base, action: "acquire", required_workflows: required });
  } catch (e) {
    if (/lane lease held live/.test(String(e.message))) {
      log(key, "lease held live elsewhere — standing down this tick");
      return;
    }
    throw e;
  }
  log(key, `lease: ${lease.note ?? "acquired"} (holder=${HOLDER})`);
  const renew = () => mcp("train_lease", { repo, base, action: "renew" });

  const releaseIfIdle = async () => {
    // release only when nothing is in flight; an awaiting-CI lane keeps the
    // lease so the next tick polls under the same holder (re-acquire while
    // mine is a granted renew).
    const st = await mcp("train_status", { repo });
    const me = st.lanes?.find((l) => l.lane === key);
    if (me && !me.currently) {
      const r = await mcp("train_lease", { repo, base, action: "release", line_green: !me.stop });
      log(key, `lease released — ${r.note ?? "idle"}`);
    } else {
      log(key, "lease held — merge in flight, next tick renews + polls CI");
    }
  };

  try {
    // ---- stop-the-line arm: main is RED and the lane is stopped ----
    if (lane.stop) {
      log(key, `line stopped — ${lane.stop.reason} @ ${(lane.stop.sha ?? "").slice(0, 9)}`);
      const baseSha = sh("gh", ["api", `repos/${repo}/commits/${base}`, "--jq", ".sha"]);
      const runs = checkRuns(repo, baseSha);
      const v = classifyMainCheckRuns(runs);
      if (v.verdict === "green") {
        await renew();
        await mcp("train_lease", { repo, base, action: "release", line_green: true });
        log(key, "main green again — stop cleared, lane released");
      } else {
        log(key, `main still ${v.verdict}${v.red.length ? ` (red: ${v.red.map((r) => r.name).join(", ")})` : ""} — holding`);
      }
      return;
    }

    // ---- post-stop residue: the stop cleared (main green again) but the
    // in-flight record is the broken merge commit — it must never be polled
    // toward a landing. The culprit card was bounced at stop time; the lane
    // is idle for queue purposes. ----
    if (lane.currently?.phase === "stopped") {
      log(key, "stop cleared — stale in-flight record; lane idle (culprit card re-enters via verify)");
      await releaseIfIdle();
      return;
    }

    // ---- awaiting-CI arm: poll the merge commit, HUB decides ----
    if (lane.currently?.phase === "awaiting-ci") {
      const cur = lane.currently;
      const mergeSha = String(cur.merge_sha ?? "");
      // reconcile first: the recorded merge sha must actually be on base —
      // a lane that says merged for a sha git can't find is a crashed
      // executor's half-truth; bounce the card instead of polling forever.
      sh("git", ["fetch", "--quiet", "origin", base]);
      const onBase = spawnSync("git", ["merge-base", "--is-ancestor", mergeSha, `origin/${base}`], { cwd: WORKDIR, encoding: "utf8" }).status === 0;
      if (!onBase) {
        await renew();
        const facts = await prFacts(repo, cur.pr).catch(() => null);
        if (facts?.state !== "MERGED") {
          await mcp("train_event", { repo, base, kind: "bounced", pr: cur.pr, task_id: cur.task_id ?? undefined, reason: "reconcile: the lane's recorded merge never landed on base (executor crashed mid-merge) — fix-forward and re-queue" });
          log(key, `reconcile: recorded merge ${mergeSha.slice(0, 9)} not on base — PR #${cur.pr} bounced`);
          return;
        }
        // merged on GitHub but the event never fired — recover by stamping now
        await mcp("train_event", { repo, base, kind: "merged", pr: cur.pr, merge_sha: facts.mergeCommit?.oid ?? mergeSha, head_sha: facts.headRefOid ?? undefined, task_id: cur.task_id ?? undefined, signer: HOLDER, reason: "reconcile: merge happened but the train event was lost — stamped from live GitHub" });
        log(key, `reconcile: PR #${cur.pr} merged on GitHub, event recovered`);
      }
      await renew();
      const runs = checkRuns(repo, mergeSha);
      const ci = await mcp("train_ci", { repo, base, sha: mergeSha, checks: runs });
      log(key, `CI poll on ${mergeSha.slice(0, 9)}: ${ci.decided ?? "?"}${ci.pending?.length ? ` (pending: ${ci.pending.join(", ")})` : ""}${ci.missing?.length ? ` (missing: ${ci.missing.join(", ")})` : ""}`);
      if (ci.decided === "pending") {
        const mergedAt = Number(lane.currently.merged_at ?? Date.now());
        const left = TRAIN_CI_BOUND_MULTIPLIER * typical - (Date.now() - mergedAt);
        if (left > 0) log(key, `fail-closed bound in ~${Math.max(1, Math.round(left / 60_000))}m`);
      }
      return;
    }

    // ---- idle arm: pick queue[0] and gate it (STRICT serialization — one
    // candidate per lane per tick; a non-mergeable head blocks the train) ----
    if (!lane.queue?.length) {
      await releaseIfIdle();
      return;
    }
    const head = lane.queue[0];
    const card = await mcp("get_artefact", { id: head.id });
    const cardMeta = card?.meta ?? {};
    // BR#3659: the card is a LIST of legs (meta.prs; meta.pr stays the first
    // for legacy readers). THIS lane drives the first UNLANDED leg whose
    // repo is this lane's — a multi-repo card appears in each of its lanes
    // until that repo's legs are done.
    const legs = trainLegs(cardMeta);
    const laneLegs = legs
      .map((leg, i) => ({ leg, legNumber: i + 1 }))
      .filter(({ leg }) => leg.repo === repo && !trainLegLanded(cardMeta, leg));
    if (!laneLegs.length) {
      // no unlanded leg on this lane. Crash-window reconcile: every leg
      // landed but the card never closed (executor died between the last
      // merge and train:landed) — re-stamp the last leg so the hub's landed
      // flow runs; otherwise just move on (another lane owns the rest).
      const allLanded = legs.length > 0 && legs.every((l) => trainLegLanded(cardMeta, l));
      const lastLanded = [...legs].reverse().find((l) => trainLegLanded(cardMeta, l));
      if (allLanded && lastLanded?.repo === repo && (card.status ?? "") === "blocked") {
        await renew();
        await mcp("train_event", {
          repo, base, kind: "merged", pr: lastLanded.number,
          merge_sha: cardMeta.merge_train?.legs?.[String(lastLanded.number)]?.merge_sha ?? cardMeta.merge_train?.merge_sha ?? undefined,
          task_id: head.id, signer: HOLDER,
          reason: "reconcile: all legs landed but the card never closed (crash between merge and landed) — re-stamped",
        });
        log(key, `reconcile: card ${head.id} all legs landed — re-stamped PR #${lastLanded.number} for the landed close`);
      } else {
        log(key, `card ${head.id} has no unlanded leg on this lane (${legs.length} leg(s) cited) — moving on`);
      }
      await releaseIfIdle();
      return;
    }
    const { leg, legNumber } = laneLegs[0];
    const pr = Number(leg.number ?? 0);
    if (!pr || !leg.repo) {
      log(key, `queue head ${head.id} leg ${legNumber} carries no PR stamp — skipping (verify convention violation; see hub audit)`);
      await releaseIfIdle();
      return;
    }
    const facts = await prFacts(repo, pr);
    if (facts.state === "MERGED" && facts.mergeCommit?.oid) {
      // reconcile: merged on GitHub, no train event (crash between merge and
      // event) — stamp it and let the CI poll take over next tick.
      await renew();
      await mcp("train_event", { repo, base, kind: "merged", pr, merge_sha: facts.mergeCommit.oid, head_sha: facts.headRefOid, task_id: head.id, signer: HOLDER, reason: "reconcile: PR already merged on GitHub — event stamped from live state" });
      log(key, `reconcile: PR #${pr} was already merged — stamped, awaiting CI`);
      return;
    }
    if (facts.state === "CLOSED") {
      log(key, `queue head PR #${pr} is CLOSED on GitHub — dropping from the lane (card stays for the humans)`);
      await releaseIfIdle();
      return;
    }
    const headSha = facts.headRefOid;
    const baseSha = sh("gh", ["api", `repos/${repo}/commits/${base}`, "--jq", ".sha"]);
    const baseVerdict = classifyMainCheckRuns(checkRuns(repo, baseSha)).verdict;
    const gate = decideTrainGate({
      prNumber: pr,
      headSha,
      cardMeta,
      cardStatus: card.status ?? null,
      baseVerdict,
      mergeable: facts.mergeable ?? null,
      mergeStateStatus: facts.mergeStateStatus ?? null,
      commits: prCommits(repo, pr),
      headChecks: checkRuns(repo, headSha),
      legNumber,
    });
    log(key, `queue[0] PR #${pr} (${head.id}): gate → ${gate.kind}${gate.defect ? ` — ${gate.defect}` : gate.reason ? ` — ${gate.reason}` : ""}`);

    if (gate.kind === "skip" || gate.kind === "note") {
      await releaseIfIdle();
      return;
    }
    if (gate.kind === "human_leg") {
      // ONE ask per class (5c): identical-open-ask dedupe keeps this single.
      await renew();
      await mcp("ask_agent", {
        to: "human",
        question: mergeSweepHumanLegTitle(repo, [gate.reason]),
        reason: gate.reason,
        options: ["Will re-sign and re-push", "Needs a decision"],
        artefact_id: head.id,
      });
      log(key, `human leg filed: ${gate.reason}`);
      await releaseIfIdle();
      return;
    }
    if (gate.kind === "close_superseded") {
      await renew();
      sh("gh", ["pr", "close", String(pr), "--repo", repo, "--comment", gate.reason.slice(0, 240)]);
      log(key, `PR #${pr} closed (superseded card)`);
      await releaseIfIdle();
      return;
    }
    if (gate.kind === "bounce") {
      await renew();
      // human-resolved conflicts invalidate the verdict: enumerate the
      // conflicting files for the fix-up brief (plumbing merge-tree — no
      // throwaway worktree needed).
      const conflicting = facts.mergeable === false || /CONFLICTING/i.test(String(facts.mergeStateStatus ?? ""));
      const tm = conflicting ? trialMerge(base, headSha) : { clean: true, files: [] };
      await mcp("train_event", {
        repo, base, kind: "bounced", pr, task_id: head.id, head_sha: headSha,
        conflict_files: tm.files.length ? tm.files : undefined,
        reason: gate.defect,
      });
      log(key, `PR #${pr} bounced — ${tm.files.length ? `conflicts in ${tm.files.length} file(s): ${tm.files.slice(0, 5).join(", ")}${tm.files.length > 5 ? ", …" : ""}` : gate.defect}`);
      await releaseIfIdle();
      return;
    }
    if (gate.kind !== "merge") {
      await releaseIfIdle();
      return;
    }

    // ---- the merge leg: machine-clean update first, then merge ----
    await renew();
    sh("git", ["fetch", "--quiet", "origin", base]);
    const behind = spawnSync("git", ["merge-base", "--is-ancestor", `origin/${base}`, headSha], { cwd: WORKDIR, encoding: "utf8" }).status !== 0;
    // BR#3659: the behind-check reads THIS leg's accepted-at head, not the
    // card-level first-leg stamp — each leg carries its own verdict.
    if (behind && headSha === String(leg.head_sha_at_acceptance ?? "").toLowerCase()) {
      // base advanced past a verdict-covered head: update-branch is the
      // MACHINE-clean rebase — if it lands, the verdict carries (BR#3516 §5);
      // if it conflicts, that's human-resolved — bounce with the file list.
      const tm = trialMerge(base, headSha);
      if (!tm.clean) {
        await mcp("train_event", { repo, base, kind: "bounced", pr, task_id: head.id, head_sha: headSha, conflict_files: tm.files, reason: `base ${base} advanced into the PR's files — rebase conflicts are human-resolved; the verdict does not carry` });
        log(key, `PR #${pr} bounced (rebase conflicts: ${tm.files.slice(0, 5).join(", ")}${tm.files.length > 5 ? ", …" : ""})`);
        await releaseIfIdle();
        return;
      }
      sh("gh", ["pr", "update-branch", String(pr), "--repo", repo]);
      const updated = await prFacts(repo, pr);
      log(key, `machine update-branch clean: ${headSha.slice(0, 9)} → ${updated.headRefOid.slice(0, 9)} (verdict carries)`);
      facts.headRefOid = updated.headRefOid;
      facts.mergeable = updated.mergeable;
      facts.mergeStateStatus = updated.mergeStateStatus;
      if (facts.mergeable !== true) { log(key, "mergeability recomputing after update-branch — next tick"); await releaseIfIdle(); return; }
    }
    sh("gh", ["pr", "merge", String(pr), "--repo", repo, METHOD_FLAG[METHOD]]);
    const merged = await prFacts(repo, pr);
    const mergeSha = merged.mergeCommit?.oid;
    if (merged.state !== "MERGED" || !mergeSha) throw new Error(`gh pr merge reported ok but PR #${pr} is ${merged.state} with no mergeCommit — DO NOT trust this tick; investigate`);
    await mcp("train_event", {
      repo, base, kind: "merged", pr, merge_sha: mergeSha, head_sha: facts.headRefOid,
      task_id: head.id, signer: HOLDER,
    });
    log(key, `PR #${pr} merged as ${mergeSha.slice(0, 9)} — awaiting CI on the merge commit`);
  } catch (e) {
    // fail-closed: the lease lapses (5 min) and the next gateway reconciles
    // from live GitHub. Log the defect; never retry-blind inside the tick.
    log(key, `tick error: ${String(e.message ?? e).slice(0, 300)}`);
    await mcp("train_lease", { repo, base, action: "release" }).catch(() => {});
    if (ONCE) process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// main loop
// ---------------------------------------------------------------------------

async function tick() {
  const st = await mcp("train_status", LANE_FILTER ? { repo: LANE_FILTER.split("@")[0] } : {});
  const lanes = st.lanes ?? [];
  if (!lanes.length) log(null, "no lanes configured — seed one via train_lane or the train_lane setting");
  for (const lane of lanes) {
    if (LANE_FILTER && lane.lane !== LANE_FILTER) continue;
    if (lane.queue?.length) {
      // the hub COMPUTES the queue (CRITICAL/boosted first, FIFO) — the
      // executor consumes it in order, never re-derives it.
      log(lane.lane, `queue: ${lane.queue.map((q) => `${q.id}${q.priority === "critical" ? "!" : ""}`).join(" → ")}`);
    }
    await driveLane(lane);
  }
}

try {
  preflight();
  if (ONCE) {
    await tick();
  } else {
    for (;;) {
      const started = Date.now();
      try { await tick(); } catch (e) { log(null, `tick failed: ${String(e.message ?? e).slice(0, 300)}`); }
      const spent = Date.now() - started;
      await new Promise((r) => setTimeout(r, Math.max(1_000, INTERVAL - spent)));
    }
  }
} catch (e) {
  console.error(`[merge-train] fatal: ${String(e.message ?? e)}`);
  process.exit(1);
}
