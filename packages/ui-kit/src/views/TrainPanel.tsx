import { useEffect, useState } from "react";
import { kbApi, type KbTrainLane } from "../server/kb";
import { Chip, type ChipTone } from "./index-kit";

/** Ticking clock — re-renders every second so lock ages stay live. */
function useClock() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
}

function age(ts: number | undefined, now: number): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return `${m}m${r ? ` ${String(r).padStart(2, "0")}s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** CAS-lock liveness: the lease TTL is 5 minutes — a heartbeat younger than
 *  2 ticks (~90s) is a live holder, anything older is lapsing/zombie. */
function lockTone(lane: KbTrainLane, now: number): "ok" | "warn" | "err" | "muted" {
  if (!lane.lease?.heartbeat_ts) return "muted";
  const s = (now - lane.lease.heartbeat_ts) / 1000;
  if (s > 300) return "err";
  if (s > 90) return "warn";
  return "ok";
}

/** Left-edge lock dot (same visual grammar as Top's status dot): green =
 *  a machine is ON the lane — lock held by a live holder, or a merge-capable
 *  gateway actively ticking it unlocked; amber = lock lapsing; red = zombie
 *  holder; grey = nobody is on the lane. Mouseover names the machine and
 *  distinguishes locked from ticking-unlocked — the "which machine is online
 *  and on this lane" answer lives in the tooltip. */
function lockDot(l: KbTrainLane, now: number): { sd: "live" | "lapse" | "dead" | "free"; title: string } {
  if (l.lease?.holder) {
    const base = `CAS lane lease held by ${l.lease.holder} — heartbeat ${age(l.lease.heartbeat_ts, now)} ago, expires in ${age(l.lease.expires_ts, now)}`;
    const t = lockTone(l, now);
    if (t === "ok") return { sd: "live", title: `locked · ${base}` };
    if (t === "warn") return { sd: "lapse", title: `lock lapsing · ${base}` };
    return { sd: "dead", title: `lock zombie (heartbeat past TTL) · ${base}` };
  }
  if (l.capable?.ready)
    return {
      sd: "live",
      title: `ticking, unlocked — merge-capable gateway ${l.capable.holder} ticked this lane ${age(l.capable.at, now)} ago and acquires the lock on its next tick (every ~45s) once work is queued`,
    };
  return { sd: "free", title: "no machine on this lane — no merge-capable gateway has ticked inside the 15-minute window; merges wait until one runs (start a gateway / bridge train)" };
}

/** The STATUS cell — the lane's current activity IN ONE LINE, combining
 *  what + who on (Ray, 2026-10-30: "Status repeats what's in current —
 *  maybe combine: Checking BR#1234 (PR #1234)"). "Checking" = the merge
 *  machine evaluating that PR's review coverage, signatures, CI and
 *  mergeability before merging it; a not-ready PR does NOT hold the queue
 *  (the walk continues to the next ready PR). */
function laneStatus(l: KbTrainLane, now: number): { tone: ChipTone; label: string; title: string; card?: string; pr?: number } {
  const reason = l.reason ?? "";
  const attemptPr = l.attempt ? l.queue.find((q) => q.id === l.attempt?.card)?.pr : undefined;
  const curPr = l.currently?.pr ?? attemptPr ?? l.queue[0]?.pr ?? undefined;
  const curCard = l.currently?.task_id ?? l.attempt?.card ?? undefined;
  if (l.stop)
    return {
      tone: "err", card: curCard, pr: curPr,
      label: `⛔ stopped — main is red${l.stop.culprit_task ? ` (${l.stop.culprit_task})` : ""}`,
      title: `merges are halted: ${l.stop.reason ?? ""}${l.stop.culprit_task ? ` — culprit ${l.stop.culprit_task}` : ""}, since ${age(l.stop.at, now)} ago. Merges resume automatically when main is green again.`,
    };
  if (reason.startsWith("merge-train: retired"))
    return { tone: "muted", label: "retired", title: "this lane was retired — nothing runs on it" };
  if (reason.startsWith("merge-train: awaiting bypass merge") || l.bypass_wait) {
    const bpm = l.bypass_wait ?? { pr: 0, task_id: undefined };
    return {
      tone: "warn", card: bpm.task_id, pr: bpm.pr,
      label: `needs a human merge${bpm.pr ? ` — PR #${bpm.pr}` : ""}`,
      title: "this PR is blocked by branch protection (a required review/check a machine cannot satisfy) — a human merge is the unblock; it clears itself once merged",
    };
  }
  // BR#5265 Fix A: base-red is LOUD — a non-green base (scoped to the
  // lane's required workflows) holding queued cars shows BLOCKED with
  // the red names, never a fake-busy "checking" line.
  const bs = l.queue_facts?.base_state;
  if (bs && bs.verdict === "red" && now - (l.queue_facts?.at ?? 0) < 15 * 60_000) {
    const reds = (bs.red ?? []).map((r) => r.name).join(", ");
    return {
      tone: "err", card: curCard, pr: curPr,
      label: `⛔ blocked — base is red${reds ? ` (${reds})` : ""}`,
      title: `main is RED${reds ? `: ${reds}` : ` (${bs.verdict})`} — the standing order (never merge onto a non-green destination) holds all ${l.queue.length} queued car(s) until it clears. Fix forward, re-run a transient check, or bypass-merge a cure — the queue then drains automatically.`,
    };
  }
  if (bs && bs.verdict !== "green" && l.queue.length > 0 && now - (l.queue_facts?.at ?? 0) < 15 * 60_000) {
    const reds = (bs.red ?? []).map((r) => r.name).join(", ");
    if (bs.verdict === "unsettled") {
      return {
        tone: "warn", card: curCard, pr: curPr,
        label: "⏳ awaiting deploy",
        title: `Main's checks (${(bs.unsettled ?? []).join(", ") || "CI"}) are finishing — ${l.queue.length} queued PR(s) merge as soon as main is green.`,
      };
    }
    return {
      tone: "err", card: curCard, pr: curPr,
      label: `⛔ blocked — base is red${reds ? ` (${reds})` : ""}`,
      title: `main is RED${reds ? `: ${reds}` : ` (${bs.verdict})`} — the standing order (never merge onto a non-green destination) holds all ${l.queue.length} queued car(s) until it clears. Fix forward, re-run a transient check, or bypass-merge a cure — the queue then drains automatically.`,
    };
  }
  // BR#5883: GATE-BLOCKED is LOUD — the scoped verdict reads green (no
  // base-red pill above) while the repo's own merge gate judges the tip
  // non-green, so every car's `main-green gate` run fails while the lane
  // looks available. This vocabulary is what the 2026-11-03 3.5h starve
  // hid behind. Freshness-guarded like base-red.
  if (bs && bs.verdict === "green" && bs.gate_blocked === true && l.queue.length > 0 && now - (l.queue_facts?.at ?? 0) < 15 * 60_000) {
    const gateReds = (bs.gate_red ?? []).map((r) => r.name).join(", ");
    const gateUnsettled = (bs.gate_unsettled ?? []).join(", ");
    const blocking = [gateReds ? `red: ${gateReds}` : "", gateUnsettled ? `unsettled: ${gateUnsettled}` : ""].filter(Boolean).join(" · ");
    return {
      tone: "err", card: curCard, pr: curPr,
      label: `⛔ gate-blocked — the repo merge gate judges main${blocking ? ` (${blocking})` : ""}`,
      title: `The lane's required workflows are all green, but the repo's own merge gate check (main-green gate — it judges the WHOLE tip of main) is failing${blocking ? ` on: ${blocking}` : ""}. Every queued PR's gate run re-judges main and fails, so all ${l.queue.length} queued car(s) are held while the lane looks idle-green. Fix or re-run the named checks — a stale gate red on a queued PR re-runs automatically once main's tip judges fully green (BR#5883 self-heal).`,
    };
  }
  // BR#5376: a STALLED batch is LOUD — members were selected, merges were
  // attempted, and NOTHING landed for K consecutive ticks. Never the
  // fake-busy "checking" vocabulary that hid the 2026-10-30 refusal loop
  // (945+ attempts, zero hub events) for days. Freshness-guarded like
  // base-red (<15m); the next stamp after a landing omits the episode.
  const stall = l.queue_facts?.stalled;
  if (stall && l.queue.length > 0 && now - (l.queue_facts?.at ?? 0) < 15 * 60_000) {
    const mins = Math.max(1, Math.round((stall.for_ms ?? 0) / 60_000));
    return {
      tone: "warn", card: curCard, pr: curPr,
      label: `⚠ stalled (${mins}m)`,
      title: `${(stall.batch ?? []).map((p) => "#" + p).join(", ") || "the batch"} was selected to merge and merges were attempted, but nothing landed for ${stall.ticks} consecutive tick(s)${stall.last_error ? ` — last error: ${stall.last_error}` : ""}. Likely executor breakage, not a PR defect — restart the gateway/executor onto the current build.`,
    };
  }
  if (l.currently) {
    const settling = l.currently.phase !== "bursting";
    return {
      tone: l.currently.phase === "stopped" ? "err" : settling ? "warn" : "live",
      card: settling ? undefined : l.currently.task_id,
      pr: settling ? undefined : l.currently.pr,
      label: l.currently.phase === "bursting"
        ? "merging batch"
        : "awaiting deploy",
      title: settling
        ? `Batch merged (last: PR #${l.currently.pr ?? "?"}); the train is awaiting main's build + deploy to finish green before the next batch. Next: ${l.attempt?.card ?? "—"}.`
        : `a batch is landing back-to-back; main settles when the batch finishes`,
    };
  }
  const rdyCount = l.pr_stats?.ready ?? 0;
  const verCount = l.pr_stats?.verifying ?? 0;
  if (l.starved && rdyCount === 0) {
    return {
      tone: "warn", card: curCard, pr: curPr,
      label: `⚠ starved (${age(l.starved.since, now)})`,
      title: `No merges for ${age(l.starved.since, now)} while holding queued PRs — 0 PRs are ready to merge right now (${verCount} verifying).`,
    };
  }
  if (l.attempt) {
    if (l.attempt.hold === "awaiting-review")
      return { tone: "warn", card: l.attempt.card, pr: curPr, label: "waiting on review", title: `${l.attempt.note}. The queue is NOT held — the train works the next ready PR meanwhile.` };
    if (l.attempt.hold === "held-checks" && rdyCount === 0)
      return { tone: "warn", card: l.attempt.card, pr: curPr, label: "⚠ held on checks", title: `${l.attempt.note} — 0 PRs are ready to merge; queued PR has failing head checks or conflicts.` };
    if (l.attempt.hold === "waiting-checks" && rdyCount === 0)
      return { tone: "muted", card: undefined, pr: undefined, label: "verifying", title: `${l.attempt.note} — line is idle because no PRs are ready to merge yet (${verCount} verifying).` };
    return { tone: "live", card: l.attempt.card, pr: curPr, label: `checking ${l.attempt.card}`, title: `${l.attempt.note} — the merge machine is evaluating this PR's review coverage, commit signatures, CI and mergeability. A not-ready PR never holds the queue: the walk continues to the next ready PR in the same pass.` };
  }
  if (rdyCount === 0 && verCount > 0) {
    return {
      tone: "muted",
      label: "verifying",
      title: `Line is idle because no PRs are ready to merge yet (${verCount} verifying). Merges start automatically as soon as verification/checks pass.`,
    };
  }
  if (l.lease?.holder) {
    const t = lockTone(l, now);
    return {
      tone: t === "ok" ? "scope" : t === "warn" || t === "err" ? "warn" : "muted",
      label: "idle",
      title: `a machine (${l.lease.holder}) is on this lane — heartbeat ${age(l.lease.heartbeat_ts, now)} ago; it takes work the moment a PR is ready`,
    };
  }
  if (l.capable?.ready)
    return {
      tone: "ok",
      label: "ready",
      title: `a merge machine (${l.capable.holder}) checked this lane ${age(l.capable.at, now)} ago — it takes the next card the moment one is queued`,
    };
  return {
    tone: "muted",
    label: "no machine",
    title: "no merge-capable machine has checked this lane inside the 15-minute window — merges wait until one runs (start a gateway / bridge train)",
  };
}

/** The NOW column (Ray, 2026-10-30: "I want to know WHAT is being done right
 *  now and progress"): status pill + PR + phase age (the lane-level state)
 *  PLUS the holder's live last action (BR#5114 now_action — the executor's
 *  own tick log via the BR#4104 proof-of-progress seam), which says WHY a
 *  held head is held ("PR #2588: head check RED: Meta-review nightly").
 *  The note is shown only while fresh (lease TTL = 5 min) — a stale one is
 *  history, not now, and rendering it would be the same lie as before. */
function nowAction(l: KbTrainLane, now: number): { text: string; title: string } | null {
  const na = l.now_action;
  if (!na?.note || na.note.startsWith("ticking ")) return null;
  const ageSec = (now - na.at) / 1000;
  if (ageSec > 300) return null; // older than the lease TTL — not "now"
  return {
    text: na.note.length > 90 ? `${na.note.slice(0, 88)}…` : na.note,
    title: `${na.holder} · ${age(na.at, now)} ago — ${na.note}`,
  };
}

/** Plain status words for a board status (BR#5349: no jargon on the banner). */
function plainStatus(s: string | undefined): string {
  return s === "in_progress" ? "in progress"
    : s === "in_review" ? "in review"
    : s === "todo" ? "not started"
    : s === "blocked" ? "parked"
    : s ?? "";
}

/** BR#5349 (Ray directive 2026-11-01: "THIS IS WHAT FIXES IT, HERE IS WHAT WE
 *  NEED TO DO — loud and clear and direct with no jargon"): the blocked-lane
 *  resolution banner, pinned to the TOP of the trains panel ABOVE the lane
 *  table. Plain words only — no "gate", no "verdict", no "admission class":
 *  what's broken (with the failing-run links), what fixes it (the open fix
 *  card · a re-run of a flaky check · a bypass-merge), and what we need from
 *  the human (answer the episode's alarm ask — one click). Red tone; the hub
 *  serves `base_red_resolution` only while a non-green base holds cars, so
 *  the banner disappears the moment main goes green. */
function BlockedBanner({ lane, openTask }: { lane: KbTrainLane; openTask?: (id: string) => void }) {
  const r = lane.base_red_resolution!;
  const repo = lane.lane.split("@")[0];
  const red = r.verdict === "red";
  const held = ` · ${r.held} PR${r.held === 1 ? "" : "s"} held`;
  return (
    <div className={`train-blocked-banner${red ? "" : " train-blocked-banner-amber"}`} role="alert">
      <span className="train-banner-line">
        {red
          ? <>⛔ Merge train STOPPED — main's checks are failing on {repo}{held}</>
          : r.verdict === "empty"
            ? <>⛔ Merge train HELD — main has none of the checks this lane needs on {repo}{held}</>
            : <>⛔ Merge train HELD — main's checks are still running on {repo}{held}</>}
      </span>
      {r.whats_broken.length > 0 && (
        <span className="train-banner-line">
          {"BROKEN: "}
          {r.whats_broken.map((b, i) => (
            <span key={b.name}>
              {i > 0 ? " · " : ""}
              {b.url
                ? <a href={b.url} target="_blank" rel="noreferrer" title="open the failing run">{b.name}</a>
                : b.name}
            </span>
          ))}
        </span>
      )}
      <span className="train-banner-line">
        {red ? "WHAT FIXES IT: " : "WHAT HAPPENS NEXT: "}
        {r.fix_card ? (
          <a
            className="train-banner-card"
            href={r.fix_card.url}
            title={`${r.fix_card.id} — ${r.fix_card.title}`}
            onClick={(e) => { if (openTask) { e.preventDefault(); openTask(r.fix_card!.id); } }}
          >
            {r.fix_card.id} — {plainStatus(r.fix_card.status)}
          </a>
        ) : (
          <span className="train-banner-dim">no fix card open yet</span>
        )}
        {r.fix_card && "pr" in r.fix_card && r.fix_card.pr ? (
          <>
            {" — fix PR "}
            <a href={(r.fix_card as any).pr_url} target="_blank" rel="noreferrer" title="open the fix PR">#{r.fix_card.pr}</a>
            {": answer the ask to bypass-merge it out of turn"}
          </>
        ) : red
          ? r.ask
            ? " · or re-run a flaky check · or you bypass-merge a fix PR"
            : " — the fix work runs on its own; you'll be asked only if a fix PR needs an out-of-turn merge or manual steps (BR#5631)"
          : " · just wait — they finish on their own"}
      </span>
      {r.ask && (
        <span className="train-banner-line">
          {"WHAT WE NEED FROM YOU: "}
          <a
            className="train-banner-card"
            href={r.ask.url}
            title={r.ask.question}
            onClick={(e) => { if (openTask) { e.preventDefault(); openTask(r.ask!.id); } }}
          >
            answer the ask (→ {r.ask.id}) — one click
          </a>
        </span>
      )}
    </div>
  );
}

/** BR#5376: the stalled-lane banner, pinned at the top of the trains panel
 *  right below the blocked banner (Ray's law: the resolution must not be
 *  buried). Plain words: the batch was selected, merges were attempted, and
 *  NOTHING landed — the receipt says executor breakage, so the unblock is
 *  operational (restart the gateway/executor onto the current build), never
 *  a code change. Amber tone — the train is not stopped, it is pretending
 *  to work ("checking review, signatures and CI" was the lie that hid the
 *  2026-10-30 refusal loop for days). The hub serves `stalled_resolution`
 *  only while a fresh stall episode rides the stamp, so the banner
 *  disappears the moment anything lands. */
function StalledBanner({ lane, openTask }: { lane: KbTrainLane; openTask?: (id: string) => void }) {
  const r = lane.stalled_resolution!;
  const repo = lane.lane.split("@")[0];
  const mins = Math.max(1, Math.round(r.for_ms / 60_000));
  const batch = r.batch.map((p) => `#${p}`).join(", ");
  return (
    <div className="train-blocked-banner train-blocked-banner-amber" role="alert">
      <span className="train-banner-line">
        {`⚠ Merge train STALLED on ${repo} — ${batch || "the batch"} selected to merge, 0 landed in ${mins}m (${r.ticks} tick${r.ticks === 1 ? "" : "s"})`}
      </span>
      <span className="train-banner-line">
        {"WHY: "}
        {r.last_error
          ? <span className="train-banner-mono">{r.last_error}</span>
          : <span className="train-banner-dim">the executor's last merge error was not stamped</span>}
      </span>
      <span className="train-banner-line">
        {"WHAT FIXES IT: "}
        <span className="train-banner-dim">{r.unblock} — any landing clears this by itself</span>
      </span>
      {r.ask && (
        <span className="train-banner-line">
          {"WHAT WE NEED FROM YOU: "}
          <a
            className="train-banner-card"
            href={r.ask.url}
            title={r.ask.question}
            onClick={(e) => { if (openTask) { e.preventDefault(); openTask(r.ask!.id); } }}
          >
            answer the ask (→ {r.ask.id}) — one click
          </a>
        </span>
      )}
    </div>
  );
}

const REFRESH_MS = 30_000;

/** Merge-train table (Ray 2026-10-30 restructure): the lane row is THREE
 *  labeled time-frames — NOW (what is being done right now + progress),
 *  NEXT (the first queued head the train takes after the current work),
 *  QUEUE (everything remaining, depth + clickable cards with their PRs) —
 *  plus the lock dot, the line, and the throughput rate. A held head says
 *  WHY it is held (the now_action note), the last ledger event rides the
 *  rate column with its age, and "head"/"gate"/"bounced" are never the
 *  only words on screen. The QUEUE column also renders the lane's Awaiting
 *  parks (BR#4962, per BR#4960): cards parked blocked under the typed
 *  Awaiting stamp — the human force-review queue, ◉-chip per card (amber at
 *  the TTL, red past TTL+grace), oldest park first. Data: GET
 *  /api/kb/train (the DO's train.status snapshot — lease/now_action are
 *  executor-fed, queue is hub-computed, oldest first). Polls every 30s (the
 *  tick is 45s); errors surface in-panel, never silent. */
export function TrainPanel({ openTask }: { openTask?: (id: string) => void }) {
  useClock();
  const [lanes, setLanes] = useState<KbTrainLane[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const r = await kbApi.train();
        if (!dead) { setLanes(r.lanes ?? []); setError(null); }
      } catch (e) {
        if (!dead) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const t = setInterval(load, REFRESH_MS);
    return () => { dead = true; clearInterval(t); };
  }, []);

  const now = Date.now();
  const hasSignal = (l: KbTrainLane) =>
    Boolean(
      l.lease ||
      l.queue.length > 0 ||
      l.stop ||
      l.currently ||
      (l.awaiting?.length ?? 0) > 0 ||
      (l.batches?.length ?? 0) > 0 ||
      (l.pr_stats?.in_progress ?? 0) > 0 ||
      (l.pr_stats?.verifying ?? 0) > 0 ||
      (l.pr_stats?.ready ?? 0) > 0,
    );

  return (
    <div className="train-panel">
      <div className="train-head">
        <h2>merge trains</h2>
        <span className="muted-note">per-lane CAS lock + derived queue · 45s tick, 30s poll</span>
      </div>
      {/* BR#5349: the blocked-lane resolution banners — pinned at the very top,
          above the lane table (Ray: the resolution must not be buried).
          BR#5376: the STALLED banner rides right below them (amber — the
          lane pretends to work; base-red, when present, owns the story). */}
      {(lanes ?? []).filter((l) => l.base_red_resolution).map((l) => (
        <BlockedBanner key={l.lane} lane={l} openTask={openTask} />
      ))}
      {(lanes ?? []).filter((l) => !l.base_red_resolution && l.stalled_resolution).map((l) => (
        <StalledBanner key={l.lane} lane={l} openTask={openTask} />
      ))}
      {error && <div className="train-lane train-lane-err" title={error}>⚠ train status unavailable — {error.slice(0, 120)}</div>}
      {!error && lanes?.length === 0 && (
        <div className="train-lane train-lane-idle">no merge-train lanes configured — a lane appears when a card enters the train</div>
      )}
      {(lanes ?? []).length > 0 && (
        <div className="ktable-head train-head-cols">
          <span title="machine-on-lane — green a machine is on it · amber busy/lapsing · red stuck · grey nobody; hover names the machine">mach</span>
          <span>line</span>
          <span title="what the train is doing right now and to WHICH PR — e.g. 'checking BR#123 (PR #456)' = the merge machine evaluating that PR's review, signatures, CI and mergeability; the card opens the board, the PR number opens GitHub">status</span>
          <span title="x of y PRs merged in the current batch (a batch lands back-to-back, then main settles before the next batch)">progress</span>
          <span title="the latest status message — what the machine did or hit most recently, and when">msg</span>
          <span title="PRs merged over the last hour / 24 hours">rate</span>
          <span title="PR stats on this lane (in progress · verifying · ready) + the backlog train of verifying/ready PRs grouped into sequential merge batches (Batch 1 | Batch 2 | …). Block colour denotes verification: green = ready, orange pulsing = being verified, orange solid = waiting to be verified">PRs</span>
        </div>
      )}
      {(lanes ?? []).map((l) => {
        const dot = lockDot(l, now);
        const repo = l.lane.split("@")[0];
        const st = laneStatus(l, now);
        const na = nowAction(l, now);
        // PROGRESS: x of y in the current batch (burst passes merge several
        // back-to-back; a single merge is a batch of 1)
        const prog =
          l.currently?.phase === "bursting"
            ? `${Number(l.currently.burst_merged ?? 0)} of ${l.currently.burst_cap === 0 ? "∞" : Number(l.currently.burst_cap ?? 0)} merged this batch`
            : l.currently
              ? Number(l.currently.burst_merged ?? 1) > 1
                ? `${Number(l.currently.burst_merged)} of ${Number(l.currently.burst_merged)} merged — settling`
                : "1 of 1 merged — settling"
              : l.queue.length > 0
                ? "0 of 1 — batch not started"
                : "—";
        // MSG: the freshest true message — the machine's live note first,
        // else the current attempt sentence, else the last ledger action
        const settlingPrPrefix =
          l.currently && l.currently.phase !== "bursting" && l.currently.pr
            ? `merged PR #${l.currently.pr}`
            : null;
        const msg = na
          ? {
              text: settlingPrPrefix && !na.text.includes(`#${l.currently?.pr}`)
                ? `${settlingPrPrefix} · ${na.text}`
                : na.text,
              title: na.title,
            }
          : settlingPrPrefix
            ? { text: `${settlingPrPrefix} — confirming deploy on main`, title: `${settlingPrPrefix} — confirming build and deploy on main` }
            : l.attempt
              ? { text: l.attempt.note, title: l.attempt.note }
              : l.activity?.last_event
                ? { text: `${l.activity.last_event.kind}${l.activity.last_event.pr ? ` PR #${l.activity.last_event.pr}` : ""} ${age(l.activity.last_event.ts, now)} ago`, title: `${l.activity.last_event.kind} by ${l.activity.last_event.gateway ?? "?"} ${age(l.activity.last_event.ts, now)} ago (history — no live machine note yet)` }
                : null;
        return (
          <div key={l.lane} className={`ktable-row train-row ${hasSignal(l) ? "" : "train-row-idle"}`}>
            <span className="trainc-dot">
              <span className={`train-dot td-${dot.sd}`} title={dot.title} />
            </span>
            <span
              className={`trainc-line ${l.card && openTask ? "trainc-open" : ""}`}
              title={`${l.lane} — lane card ${l.card}${l.reason ? ` · ${l.reason}` : ""}${l.card && openTask ? " — click to open" : ""}`}
              onClick={() => l.card && openTask?.(l.card)}
            >
              {l.lane}
            </span>
            <span className="trainc-status">
              <Chip pill tone={st.tone} title={st.title}>{st.label}</Chip>
              {st.card && st.pr ? (
                <a className="train-pr" href={`https://github.com/${repo}/pull/${st.pr}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} title={`open PR #${st.pr} on GitHub`}>#{st.pr}</a>
              ) : null}
            </span>
            <span className="trainc-prog top-num" title={prog}>{prog}</span>
            <span className="trainc-msg">
              {msg ? <span className="train-now-note" title={msg.title}>{msg.text}</span> : <span className="muted-note">—</span>}
            </span>
            <span className="trainc-rate top-num" title={`PRs merged: last hour ${l.activity?.merged_1h ?? 0} · last 24h ${l.activity?.merged_24h ?? 0}`}>{l.activity?.merged_1h ?? 0}/h · {l.activity?.merged_24h ?? 0}/24h</span>
            <span className="trainc-backlog">
              {/* BR#5658 (Ray 2026-11-03, v2):
                  1. Each lane shows PR stats: in progress · verifying · ready
                     (strictly 3 buckets covering ALL open PRs on the lane).
                  2. The backlog train shows ONLY the batches of verifying/ready
                     PRs grouped by how they can be merged in batches (Batch 1 |
                     Batch 2 | … via iterative selectBatch over conflict_pairs +
                     burst_max).
                  3. Block colour denotes verification state:
                     - green solid (.tb-ready): ready (verified, mergeable)
                     - orange pulsing (.tb-verifying): being verified right now
                     - orange solid (.tb-wait): waiting to be verified */}
              {(() => {
                const clsOf = (q: { id: string }) => l.queue_facts?.entries.find((e) => e.id === q.id)?.cls ?? "ready";
                const baseGreen = l.queue_facts?.base_state?.verdict === "green";
                const fallbackBatches = () => {
                  type Car = { id: string; pr?: number; state: "ready" | "verifying" | "waiting"; detail?: string };
                  const cars: Car[] = [];
                  let ip = 0, ver = 0, rdy = 0;
                  for (const q of l.queue) {
                    if ((l.currently?.task_id && q.id === l.currently.task_id) || (q.pr && l.currently?.pr === q.pr)) continue;
                    const cls = clsOf(q);
                    if (cls === "conflict" || cls === "blocked") {
                      ip++;
                    } else if (cls === "needs-review") {
                      ver++;
                      cars.push({ id: q.id, pr: q.pr, state: "waiting", detail: "waiting to be verified — needs a fresh review" });
                    } else if (cls === "waiting" && baseGreen) {
                      ver++;
                      cars.push({ id: q.id, pr: q.pr, state: "verifying", detail: "being verified — checks/mergeability running" });
                    } else if (cls === "ready" || cls === "waiting" || cls !== "") {
                      rdy++;
                      cars.push({
                        id: q.id,
                        pr: q.pr,
                        state: "ready",
                        detail: cls === "waiting" ? "verified — ready to merge (waiting on lane/CI)" : "verified — merges this pass (batch)",
                      });
                    }
                  }
                  for (const a of l.awaiting ?? []) {
                    if (cars.some((c) => c.id === a.task || (a.pr && c.pr === a.pr))) continue;
                    ver++;
                    cars.push({
                      id: a.task,
                      pr: a.pr,
                      state: a.in_flight ? "verifying" : "waiting",
                      detail: a.in_flight
                        ? "being verified — review in progress"
                        : `waiting to be verified, parked ${age(now - a.age_ms, now)} ago — force-review from the backlog: approve re-queues, changes requested bounce impl`,
                    });
                  }
                  const stateRank = (s: Car["state"]) => (s === "ready" ? 0 : s === "verifying" ? 1 : 2);
                  cars.sort((a, b) => stateRank(a.state) - stateRank(b.state));
                  const cap = typeof l.burst_max === "number" && l.burst_max >= 0 ? l.burst_max : 10;
                  const pairs = l.queue_facts?.conflict_pairs ?? [];
                  const rem = cars.map((_, i) => i);
                  const outBatches: Car[][] = [];
                  while (rem.length > 0) {
                    const chosen: number[] = [];
                    for (let i = 0; i < rem.length; i++) {
                      if (cap > 0 && chosen.length >= cap) break;
                      const pa = cars[rem[i]].pr ?? 0;
                      const clashing = chosen.some((s) => {
                        const pb = cars[rem[s]].pr ?? 0;
                        return pa > 0 && pb > 0 && pairs.some(([x, y]) => (x === pa && y === pb) || (x === pb && y === pa));
                      });
                      if (!clashing) chosen.push(i);
                    }
                    const pick = chosen.length ? chosen : [0];
                    outBatches.push(pick.map((si) => cars[rem[si]]));
                    const pickSet = new Set(pick);
                    const next = rem.filter((_, idx) => !pickSet.has(idx));
                    rem.length = 0;
                    rem.push(...next);
                  }
                  return { stats: { in_progress: ip, verifying: ver, ready: rdy }, batches: outBatches };
                };
                const fb = fallbackBatches();
                const ps = l.pr_stats ?? fb.stats;
                const batches = l.batches ?? fb.batches;
                const totalBatchCars = batches.reduce((acc, b) => acc + b.length, 0);
                const stat = (n: number, cls: string, word: string) => (
                  <span className={`train-stat ${cls}`} title={`${n} ${word}`}>{n} {word}</span>
                );
                const wordFor = (q: { state: "ready" | "verifying" | "waiting"; detail?: string }) =>
                  q.detail ?? (
                    q.state === "ready" ? "verified — merges this pass (batch)" :
                    q.state === "verifying" ? "being verified — checks/mergeability running" :
                    "waiting to be verified — needs a fresh review"
                  );
                const toneFor = (state: "ready" | "verifying" | "waiting") =>
                  state === "ready" ? "tb-ready" : state === "verifying" ? "tb-verifying" : "tb-wait";
                return (
                  <>
                    <span className="train-stats" title="PR stats on this lane: in progress (active impl / conflict repair) · verifying (being verified or waiting to be verified) · ready (verified — ready to merge)">
                      {stat(ps.in_progress, "ts-ip", "in progress")}
                      <span className="train-stat-sep">·</span>
                      {stat(ps.verifying, "ts-verifying", "verifying")}
                      <span className="train-stat-sep">·</span>
                      {stat(ps.ready, "ts-ready", "ready")}
                    </span>
                    <span className="train-blocks" title={`${totalBatchCars} verifying/ready PR${totalBatchCars === 1 ? "" : "s"} in ${batches.length} merge batch${batches.length === 1 ? "" : "es"} — green = ready (verified), orange pulsing = being verified, orange solid = waiting to be verified${l.queue_facts ? `\nverdicts from the machine's last walk, ${age(l.queue_facts.at, now)} ago` : ""}`}>
                      {batches.map((batch, bi) => (
                        <span key={bi} className="train-block-group">
                          {bi > 0 && <span className="train-block-gap" title={`Batch ${bi + 1} (${batch.length} PR${batch.length === 1 ? "" : "s"}) — merges after Batch ${bi} settles`} />}
                          {batch.map((q, qi) => (
                            <span
                              key={`${q.id}-${q.pr ?? qi}`}
                              className={`train-block ${toneFor(q.state)}${bi === 0 && qi === 0 ? " tb-head" : ""}`}
                              title={`Batch ${bi + 1} · ${q.id}${q.pr ? ` · PR #${q.pr}` : ""} — ${wordFor(q)}`}
                              onClick={() => openTask?.(q.id)}
                            />
                          ))}
                        </span>
                      ))}
                    </span>
                  </>
                );
              })()}
            </span>
          </div>
        );
      })}
      {!error && lanes && lanes.length > 0 && lanes.every((l) => !hasSignal(l)) && (
        <div className="muted-note train-all-idle">all lanes idle — queues empty; a ready lane names the machine that takes the next head</div>
      )}
    </div>
  );
}
