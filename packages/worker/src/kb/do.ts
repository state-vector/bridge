/**
 * KnowledgeHub Durable Object — the coordination layer's storage + rules.
 *
 * One DO per project ("global" for now). SQLite: artefacts, typed relations,
 * audit events, FTS5 over title+body. Every mutation writes an audit event and
 * bumps updated_ts. Lifecycle transitions and relation rules are enforced HERE,
 * not in clients.
 *
 * Transport: the worker forwards JSON op requests via fetch("https://kb/<op>").
 * Ops: create | get | list | search | update | transition | link | stats
 */
import {
  scaffoldBody,
  EMBED_MODEL,
  TRIGRAM_DIM,
  cosine,
  trigramVec,
  embedText,
  hybridMerge,
  composeBootstrap,
  scoreAgent,
  AgentSignals,
  detectResultTrail,
  describeResultTrail,
  ResultTrail,
  TRANSPORTS,
  ARTEFACT_TYPES,
  ArtefactType,
  DEFAULT_BOARD,
  DEFAULT_CRON_PLAYBOOK,
  DEFAULT_ROLE_PLAYBOOKS,
  DEFAULT_WS_SLUG,
  doWs,
  INITIAL_STATUS,
  verifyVerdictStatement,
  LIMITS,
  SETTINGS_KEYS,
  ASK_ANSWERED,
  ASK_OPEN,
  assertHumanLabel,
  checkLimits,
  ftsQuery,
  formatId,
  FEEDBACK_TITLE_PREFIX,
  tallyConsensus,
  generateAuthToken,
  generatePrincipalId,
  hashAuthToken,
  idSeq,
  isArtefactType,
  isRelation,
  isSentiment,
  isQuestionTask,
  KIND_TYPE,
  KIND_ROLE,
  KIND_TAG,
  parseRolesInput,
  splitSystemTags,
  isWsSlug,
  isValidAskTarget,
  tagsSayGateway,
  parseTags,
  resolveRolePlaybook,
  selfProvisionLabel,
  graceActive,
  sanitizeTags,
  validateRelation,
  // serialized merge train (BR#3516)
  MERGE_TRAIN_QUEUED_REASON,
  MERGE_TRAIN_REASON_PREFIX,
  TRAIN_LEASE_TTL_MS,
  TRAIN_CI_TYPICAL_MINUTES,
  TRAIN_CI_BOUND_MULTIPLIER,
  TRAIN_HEAD_STAMP_RE,
  laneKey,
  laneCardTitle,
  laneCardBody,
  laneOfMeta,
  parseBurstMax,
  type LaneSpec,
  leaseDecide,
  mergeTrainQueue,
  // BR#5190 root-fix fast lane: the board half of the main-breakage law
  ROOT_FIX_TAG,
  MAIN_RED_TAG,
  isRootFixCard,
  rootFixCardTitle,
  rootFixCardBody,
  renewProgressDecide,
  trainLegs,
  trainLegLanded,
  trainLegsRemaining,
  trainCardMatchesLane,
  verdictCoversHeadLeg,
  carryAppendLeg,
  trainQueueRemainingReason,
  trainParseNoteLegs,
  classifyRequiredRuns,
  decideTrainGate,
  trainBounceBrief,
  resolveTrainBounceKind,
  clampAwaitingTtlHours,
  TRAIN_AWAITING_GRACE_MS,
  trainAwaitingReason,
  trainStopAskTitle,
  trainLandedCloseNote,
  trainLandedCloseEdge,
  trainCloseBounceBrief,
  trainCloseFailAskTitle,
  trainCloseFailAskDetails,
  TRAIN_LANDED_CLOSE_MAX_RETRIES,
  releaseHold,
  trainProxyEvent,
  // prose-card disposition ladder (BR#4416)
  decideProseDisposition,
  proseClassAskTitle,
  proseAlarmAskTitle,
  PROSE_CLASS_AMBIGUOUS,
  PROSE_CLASS_QUIET_MS,
  type ProseLeg,
  type ProseLegVerdict,
  trainMergeReceipt,
  PROXY_WAIT_HOLD_RESULT_CLASS,
  BOUNCE_REENTRY_DEMOTE_RESULT_CLASS,
  // question human-claim hold (BR#3911)
  humanClaimLive,
  QUESTION_CLAIM_MINUTES,
  type TrainLease,
  type LeaseAction,
  type MainCheckRun,
  type RequiredRunsVerdict,
} from "./core.ts";
import { aggregateThroughput, parseThroughputParams, type DoneEvent, type FallbackDone } from "./throughput.ts";
import { parseProvenanceSha } from "./provenance.ts";
import {
  accountingLine,
  normalizePr,
  reconcileJoin,
  type ReconcileBinding,
  type ReconcileDuty,
  type ReconcileIgnore,
  type ReconcileJudgement,
  type ReconcilePr,
} from "./reconcile.ts";
import {
  decide,
  invariants as checkInvariants,
  detectBreaches,
  breachClass,
  classOf,
  replayStatus,
  BREACH_WINDOW_MS,
  UNBLOCK_FLOOD_MS,
  isClonableRepoRef,
  prFromNote,
  RECEIPTS_DOC,
  churnRelease,
  blockedParkVerdict,
  UNBLOCK_SPAWN_CAP,
  RuleCtx,
} from "./machine.ts";
import {
  parseProxyCondition,
  parseCloseLegs,
  parseClosureReceipt,
  parseForceClose,
  doneWhenSection,
  legLabel,
  RECEIPT_CONTRACT,
  validateAwaitEvent,
  awaitEventFromAtoms,
  awaitEventToAtom,
  describeAwaitEvent,
  deployedSatisfied,
  AWAIT_GRAMMAR_DOC,
  isSelfAwait,
  type AwaitEvent,
  proxySpawnReceipts,
  sameProxyReceipts,
  type CloseLeg,
  type ProxyAtom,
} from "./closure.ts";

/** The standing ask sink for the merge train's stop-the-line alarms
 *  (BR#3516 §6) — asks bind to it, so askCreate's identical-open-ask guard
 *  can dedupe per red episode (one ask per class, never one per PR). Same
 *  sink the destination-green sweep used (BR#3124, infrastructure). Override
 *  with the `train_alarm_sink_id` setting if the sink card is re-issued. */
const TRAIN_ALARM_SINK_ID = "BR#3124";
/** BR#4489: a queued lane with no merge-capable lease inside this window is STARVED — panel red + alarm. */
const TRAIN_STARVE_MS = 10 * 60_000;
/** Ray 2026-10-29: a merge-capable lease op inside this window means the train is
 *  READY — an idle lane shows which machine last ticked it and when, not a
 *  vague "awaiting an available gateway"; readiness must be visible when
 *  there is no work so the lane is trusted the moment work arrives. */
const TRAIN_READY_MS = 15 * 60_000;

// ---- BR#4658 worker-executor verification probes ----
/** A failed probe re-arms after this backoff (the executor re-polls pending
 *  probes each tick; the sweep re-enqueues failed rows past the backoff). */
const PROBE_RETRY_MS = 10 * 60_000;
/** Transient gh failures before the probe gives up and the park goes back to
 *  a loud unresolvable (never a silent infinite retry loop). */
const PROBE_ATTEMPT_CAP = 12;

/** The dedupe key for a probe — one row per atom across all waiting cards. */
export function proxyProbeKey(atom: Pick<ProxyAtom, "kind" | "repo" | "runId" | "newerThan" | "number">): string | null {
  const repo = String(atom.repo ?? "").trim();
  if (!repo) return null;
  if (atom.kind === "run_success") {
    if (atom.runId) return `run:${repo}:${atom.runId}`;
    if (atom.newerThan) return `newer:${repo}:${atom.newerThan}`;
    return null;
  }
  if (atom.kind === "pr_checks_green") {
    return Number(atom.number ?? 0) > 0 ? `checks:${repo}#${Number(atom.number)}` : null;
  }
  return null;
}

/** The hub-side head law (BR#3409 / BR#4658): the observed head matches the
 *  awaited head — exact, or the awaited value is a prefix of the full 40-hex
 *  observed head (parks may record a short hex prefix). The reverse never
 *  matches: a short observed value cannot confirm a longer expectation. */
export function headMatches(observed: string, expected: string): boolean {
  const o = String(observed ?? "").toLowerCase();
  const e = String(expected ?? "").toLowerCase();
  if (!o || !e) return false;
  return o === e || o.startsWith(e);
}


/** The standard verify-duty body — the ONE 5c-gated template. The normal
 *  in_review spawn (verdict effects) and the reconcile spawn (BR#4170) both
 *  render through here, so the two spawn sites can never drift apart.
 *  `leg` is the PR's typed machine leg (repo + number) — rendered into the
 *  ACCEPT step so the merge-train park carries its single typed await_event
 *  from the first attempt. BR#4425: the template used to describe the proxy
 *  only as a conjunction ("mergeCommit non-null AND main green"); duties
 *  imitated the prose, the text parsed to 2 atoms, the multi-atom gate
 *  refused, and (pre-#288) the refusal rode as a retryable 503 — three
 *  blind retries, three transition_rejected events, a breach card. */
export function verifyDutyBody(parentId: string, rootTitle: string, prLink: string, leg?: { repo: string; n: number }, rootFix?: { repo: string; pr: number }): string {
  // BR#5190: the fast-lane note rides ONLY for a QUALIFIED root-fix parent
  // (the caller derives it from isRootFixCard + a live PR stamp — no stamp,
  // no fast lane to name). The verifier's duty is unchanged; the note exists
  // so the fresh session knows why this parent will jump every queue tier.
  const fastLane = rootFix
    ? `\n\nROOT-FIX FAST LANE (BR#5189): this parent is THE bound main-breakage fix (${rootFix.repo}#${rootFix.pr} — tags root_blocker + main-red, meta.root_fix binding to the failing main-HEAD run). Verify as usual; on accept it queues tier 0 — a stopped lane offers NOTHING else until it merges. If the base red is the circular deploy-health class (the gate red because main itself is red), the train's deterministic one-click human merge ask is the fast lane — you neither merge nor file it; the train owns both.`
    : "";
  return `Verification duty for ${parentId} — "${rootTitle}".\n\nYour duty is the DOUBLE-CHECK, not the delivery — the serialized merge train owns the merge (BR#3516). You never merge, never close the parent done.\n\nVERIFY GATE — mergeability is a precondition, NOT a finding (2026-10-23 unsigned-PR incident):\n1. FIRST, before any substance check: gh pr view <N> --json mergeable,mergeStateStatus,reviewDecision and confirm every commit signature isValid=true. If mergeable=false / CONFLICTING / any unsigned commit: STOP — zero substance checks, NO ask to the human.\n2. Bounce to impl: transition ${parentId} in_progress with the mechanical defect ("PR #N unmergeable — unsigned commits | conflicts | failing check X. Re-sign/rebase/resolve and re-push.").\n3. Broken signing environment (key unavailable / NO_USER): file ONE ask for the whole class, never per PR.\n\nThen double-check, don't reimplement: confirm the receipts (PR: ${prLink}, merge state, findings) and that the work matches the task.${fastLane}\n\nACCEPT (substance AND mergeability both hold):\n1. Record the LIVE head: gh pr view <N> --json headRefOid, then put \`head <full-40-hex>\` in your close note — the hub stamps head_sha_at_acceptance from it (zero hub GitHub calls).\n2. Transition the parent ${parentId} to blocked with note \`merge-train: queued\` AND the ONE typed machine leg on the same call — pass await_event ${leg ? `{event:"pr_merged", repo:"${leg.repo}", n:${leg.n}}` : `{event:"pr_merged", repo:"<owner/name>", n:<PR you verified>}`}. One typed leg per park (BR#3986): conjunction prose ("…merges (mergeCommit non-null) AND main CI green after") parses to 2 machine atoms and is refused loud at the door (breach class gate:multi-atom-condition — specimens BR#4425, BR#4303); carry the conjunction as plain prose in unblock_condition — the typed leg is the gate the train flips. The train gates it, merges it, waits out main CI, and closes it citing the mergeCommit.\n3. Close yourself done citing the receipts. A conflicted PR bounces off the train back here with the conflict file list — resolution invalidates the verdict, re-verify at the new head, re-queue.\n\nProblems found → bounce the parent back to impl with findings (in_review → in_progress, one round, N bounces).`;
}

/** Body for a reconcile-spawned binding card (BR#4170): the card's whole job
 *  is to BE the board projection of one GitHub PR — meta.pr binds it, so the
 *  invariant can see it. Everything after that rides the standard flow: when
 *  the PR turns verify-eligible the hub spawns the standard verify duty as a
 *  child of THIS card (BR#4079 — accept queues it; the train merges it). */
function reconcileTrackingBody(repo: string, pr: number, title: string | null, why: string, url: string): string {
  return `Reconcile binding card (BR#4170) — ${repo}#${pr}${title ? ` "${title}"` : ""}.\n\nGitHub is the source of truth for this PR; this card is its board projection (meta.pr binds them). Why it exists: ${why}\nPR: ${url}\n\nWhat happens next is automatic while the PR stays actionable: once it is approved+mergeable with a clean destination, the hub spawns the standard verify duty as a child of THIS card (5c gate) — its ACCEPT queues this card onto the merge train; the train merges and closes it. You never merge, never queue by hand.\n\nIf this PR should not be carried on the board at all, rule it off the record instead of closing silently: reconcile_ignore with {"repo": "${repo}", "pr": ${pr}, "reason": "<why>"} — the report then accounts it as ignored-with-reason.`;
}

/** BR#3787 layer 2 — repair rate limit: a device may re-vend its own row at
 *  most this many times per rolling hour. A crash loop must not mint
 *  infinitely; past the limit the device parks and retries later. */
export const TOKEN_REPAIR_LIMIT = 6;
export const TOKEN_REPAIR_WINDOW_MS = 60 * 60 * 1000;

/** BR#4262 identity rendering law — the display expression for the owner
 *  column. The owner at REST is the PRINCIPAL (the anchor — claims stamp it,
 *  every WHERE/matching path keys on it); READS resolve it to the owning
 *  token's LABEL via this render-time join. Rows with no matching token row
 *  (legacy `system:*` owners, hand-minted labels, empty owner) render the
 *  stored value verbatim. When several token rows share a principal, the
 *  live, most-recently-seen row's label wins — deterministic, display only.
 *  Requires the outer artefacts table aliased `a`. */
const OWNER_DISPLAY_SQL = `COALESCE(
  (SELECT t.label FROM auth_tokens t WHERE t.principal = a.owner
   ORDER BY (t.revoked_ts IS NULL) DESC, COALESCE(t.last_seen_ts, t.created_ts) DESC LIMIT 1),
  a.owner)`;

import {
  ROOT_BLOCKER_TAG,
  planRootBlockers,
  rootBlockerBody,
  rootBlockerTitle,
} from "./rollup.ts";

export class KnowledgeHub {
  constructor(private state: DurableObjectState, private env: any) {}

  /** ensureSchema runs once per isolate, not per request — its migration
   *  queries are full-table scans, and the free-tier DO row-read quota
   *  dies under per-request schema checks (2026-10-18 outage). */

  // ---------- realtime (hibernating websockets) ----------

  async handleWs(request: Request) {
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    const since = Number(new URL(request.url).searchParams.get("since") ?? 0);
    const recent = await this.eventsSince(since, 100);
    pair[1].send(JSON.stringify({ type: "kb.events", events: recent.events }));
    // BR#4362: hydrate the board OVER THE SOCKET — the stream carries state,
    // clients never poll. Cached snapshot (≤2s stale) is fine for hydration;
    // live updates arrive as coalesced kb.board pushes below.
    try {
      const board = await this.boardPayload();
      pair[1].send(JSON.stringify({ type: "kb.board", board }));
    } catch { /* hydration falls back to the client's one-shot fetch */ }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(_ws: WebSocket, message: string) {
    try {
      const m = JSON.parse(message);
      if (m?.type === "ping") _ws.send(JSON.stringify({ type: "pong" }));
    } catch { /* ignore */ }
  }

  webSocketClose() {}

  // ---------- SSE wake channel (BR#4806) ----------
  // The WS push channel (/ws) is browser-first (hibernating sockets, Durable
  // Objects hibernation API). The GATEWAY daemons (train.rs, vendored verbatim
  // into the CLI) subscribe over SSE — the same audit-event stream in the same
  // frame shape, but a plain streaming HTTP response the Rust standard stack
  // can read with NO new dependency (reqwest blocking is already in both
  // crates). Broadcast-only, no state: a missed event degrades to the 45s
  // poll cadence, which stays as the fallback (BR#4806).
  private sseClients = new Set<WritableStreamDefaultWriter>();

  /** workerd demands BYTE streams for network responses — string chunks
   *  throw "This ReadableStream did not return bytes" the moment the body
   *  crosses an I/O boundary (the stub bridge hid this; the real HTTP
   *  server exposes it). Encode once per frame here. */
  private sseEnc = new TextEncoder();

  /** Fan a frame out to every SSE subscriber. A failed write drops that
   *  client (the reader reconnects; poll cadence covers the gap). */
  private sseWrite(frame: string): void {
    const bytes = this.sseEnc.encode(frame);
    for (const w of [...this.sseClients]) {
      w.write(bytes).catch(() => {
        this.sseClients.delete(w);
        try { w.close(); } catch { /* already gone */ }
      });
    }
  }

  /** GET /sse — the gateway wake channel. Same events as /ws, text/event-
   *  stream encoded. Capped (gateway fleets are small); the cap response is
   *  loud so an operator sees it instead of a silently dead stream. */
  private handleSse(request: Request): Response {
    if (this.sseClients.size >= 64) {
      return new Response("sse subscriber cap reached (64) — a fleet this large should share a wake relay", { status: 503 });
    }
    const ts = new TransformStream<Uint8Array, Uint8Array>();
    const writer = ts.writable.getWriter();
    this.sseClients.add(writer);
    const drop = () => {
      this.sseClients.delete(writer);
      try { writer.close(); } catch { /* already closed */ }
    };
    request.signal.addEventListener("abort", drop);
    writer.write(this.sseEnc.encode("retry: 5000\n\n")).catch(drop);
    writer.write(this.sseEnc.encode(`data: ${JSON.stringify({ type: "kb.hello", ts: Date.now() })}\n\n`)).catch(drop);
    return new Response(ts.readable, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    });
  }

  // BR#4362 push-driven board: the socket is the source of truth, never a
  // doorbell. One coalesced snapshot per second max, no matter the mutation
  // rate or the client count — the 2026-10-29 overload was every client
  // refetching the FULL board per event (11 board GETs/sec on one DO).
  private boardCache: { at: number; body: any } | null = null;
  private boardLastPush = 0;
  private boardDirty = false;
  private boardBuilds = 0;
  private boardPushes = 0;

  // BR#4397 pull-surface rate limits — a brake against pollers, never against
  // push clients. The DO is single-threaded, so in-memory windows are exact.
  // Key: the worker's x-kb-rate-key (web login or client IP); absent header
  // (direct MCP/admin plane) ⇒ unlimited — the agent protocol's cadence is
  // legitimate and orient/progress are not the overload vector.
  private rlBuckets = new Map<string, number[]>();
  private rlLimited = 0;

  /** Sliding-window check. Returns a 429 Response when over the limit, else
   *  null (call through). Over-limit responses name the push channel. */
  private limited(route: string, max: number, windowMs: number, request?: Request): Response | null {
    const key = request?.headers.get("x-kb-rate-key");
    if (!key) return null;
    const k = `${route}|${key}`;
    const now = Date.now();
    const arr = (this.rlBuckets.get(k) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      this.rlBuckets.set(k, arr);
      this.rlLimited++;
      const retryAfter = Math.max(1, Math.ceil((windowMs - (now - arr[0])) / 1000));
      return new Response(
        JSON.stringify({ error: `rate limited: ${route} allows ${max}/min per client — the board is push-driven, use /kb-ws (kb.board snapshots + kb.event frames); pull is hydration-only`, retry_after: retryAfter }),
        { status: 429, headers: { "content-type": "application/json", "retry-after": String(retryAfter), "cache-control": "no-store" } },
      );
    }
    arr.push(now);
    this.rlBuckets.set(k, arr);
    if (this.rlBuckets.size > 5000) this.rlBuckets.clear(); // bounded by clients; crude prune is fine
    return null;
  }

  /** Board payload with a 2s TTL for pull consumers (hydration, stragglers).
   *  Push consumers force a fresh build so a push never carries a snapshot
   *  that predates the mutation that triggered it. */
  private async boardPayload(force = false): Promise<any> {
    if (!force && this.boardCache && Date.now() - this.boardCache.at < 2000) return this.boardCache.body;
    const body = await this.board();
    this.boardBuilds++;
    this.boardCache = { at: Date.now(), body };
    return body;
  }

  /** Build once, send to every socket. Fire-and-forget on the mutation path —
   *  a failing push never fails the write that triggered it. */
  private pushBoardSnapshot(force = true): void {
    this.boardPushes++;
    this.boardPayload(force)
      .then((board) => {
        const frame = JSON.stringify({ type: "kb.board", board });
        for (const ws of this.state.getWebSockets()) {
          try { ws.send(frame); } catch { this.wsSendFail++; }
        }
      })
      .catch(() => { /* counted as no push; the tail flush retries next tick */ });
  }

  private broadcastEvent(ev: unknown) {
    const frame = JSON.stringify({ type: "kb.event", event: ev });
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(frame); } catch { this.wsSendFail++; /* hibernated client gone — counted (BR#4212) */ }
    }
    // BR#4806: the same frame to the SSE wake channel (gateway daemons)
    this.sseWrite(`data: ${frame}\n\n`);
    // BR#4362 follow-up: every mutation drops the HTTP board cache — read-
    // after-write must reflect the write (a 2s-stale board after a claim is
    // a correctness bug, not a performance trade; the storm protection is
    // the invalidation, not the staleness).
    this.boardCache = null;
    // coalesced state push: ≥1s between builds; the burst's tail mutation is
    // flushed by the alarm tail-flush below (≤60s worst case, events already
    // delivered per-event above)
    if (!this.state.getWebSockets().length) return;
    this.boardDirty = true;
    if (Date.now() - this.boardLastPush >= 1000) {
      this.boardLastPush = Date.now();
      this.boardDirty = false;
      this.pushBoardSnapshot();
    }
  }

  // Watchdog: silence on in_progress means the agent is gone — unless the
  // silence was DECLARED (grace window, subprocess block). Block it as
  // abandoned; the same agent re-claims it by logging progress again.
  /** Alarm entry point — fail-soft AND self-healing. Two failure modes here:
   *  (1) a throwing alarm() loses its schedule (the runtime consumes it);
   *  (2) a POISONED schedule: next_alarm_ts stuck in the past — the runtime
   *  keeps "firing" it, but if the handler throws before re-arming (old class
   *  version, quota error, whatever), the alarm never moves forward and the
   *  sweep never runs (the Oct-19 dead-watchdog incident: next_alarm_ts stuck
   *  15h in the past, last_tick zero, 12-24h stale rows). So: re-arm FIRST to
   *  now+60s unconditionally (this jumps past any poisoned timestamp), then
   *  run the sweep inside a catch-all that logs. The alarm can never go
   *  silent, and can never stay stuck in the past. */
  /** BR#4212 alarm-handler failure policy — DEGRADE + RETRY, never take the
   *  entry down. The re-arm setAlarm can itself fault (storage storm): catch,
   *  count, keep going — a throwing alarm() loses its schedule entirely, so
   *  this handler never throws. If the re-arm faulted, the schedule self-heals
   *  via the fetch-entry null-or-stale guard on the next request, and the
   *  sweep below still runs this tick. The sweep rides the DO alarm retry
   *  chain: a faulting tick is logged (alarm_error audit) and retried next
   *  tick at the 60s cadence. */
  async alarm() {
    try {
      await this.state.storage.setAlarm(Date.now() + 60_000);
    } catch (e) {
      this.noteStorageFault("alarm_rearm", e);
    }
    // BR#4806: SSE keepalive — gateway readers carry an idle read-timeout;
    // a silent gap longer than that tears the stream down and reconnects.
    // Pinging on the 60s alarm bounds the silent gap to ≤60s, well inside
    // the reader's timeout, and fires even when the sweep below faults.
    this.sseWrite(`: ping ${Date.now()}\n\n`);
    // BR#4362: flush a burst's tail board push (the ≥1s coalescer in
    // broadcastEvent may have swallowed the last mutation of a burst)
    if (this.boardDirty && Date.now() - this.boardLastPush >= 1000) {
      this.boardDirty = false;
      this.boardLastPush = Date.now();
      this.pushBoardSnapshot();
    }
    try {
      await this.alarmSweep();
    } catch (e) {
      try {
        this.audit("system:watchdog", "alarm_error", "watchdog", { error: String((e as Error).message ?? e).slice(0, 300) });
      } catch { /* even auditing failed — next tick retries */ }
    }
  }

  private async alarmSweep() {
    await this.ensureSchema();
    const now0 = Date.now();
    // (0) expire stale open asks. An open ask pauses the watchdog (rule 6) —
    // but an ask to an agent that never answers would pause its task FOREVER
    // (the 19h+ in_progress rows were this). TTL: 24h. Expiry clears the ask
    // and any awaiting_ask marker, so the sweep below judges the task on its
    // own silence.
    const askTtlMs = 24 * 60 * 60_000;
    for (const a of this.state.storage.sql.exec(
      `SELECT id, artefact_id, to_target, created_ts FROM asks WHERE status = 'open' AND created_ts < ?`,
      now0 - askTtlMs,
    ).toArray() as any[]) {
      this.state.storage.sql.exec(
        `UPDATE asks SET status = 'expired', answered_by = 'system:watchdog', answered_ts = ? WHERE id = ?`,
        now0, a.id,
      );
      if (a.artefact_id) {
        const t = this.one(`SELECT meta FROM artefacts WHERE id = ?`, a.artefact_id);
        if (t) {
          const m = JSON.parse(t.meta ?? "{}");
          if (m.awaiting_ask?.ask_id === a.id) {
            delete m.awaiting_ask;
            this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(m), a.artefact_id);
          }
        }
      }
      this.audit("system:watchdog", "ask_expired", String(a.id), {
        to: a.to_target ?? "", artefact: a.artefact_id ?? "",
        age_h: Math.round((now0 - Number(a.created_ts ?? 0)) / 3_600_000),
      });
    }
    // (A) the in_progress stall sweep — BR#4282 moved the phase into its own
    // method (stallSweep below) so the admin.stall_sweep drill runs it in
    // isolation, mirroring admin.unblock_proxy_sweep.
    await this.stallSweep(now0);
    // BR#4489: judge train-lane starvation on the alarm cadence too — a
    // queued lane with no merge-capable executor alarms even with zero
    // panel readers (the outage's silence failure).
    try {
      await this.sweepLaneStarvation(now0);
    } catch (e) {
      this.audit("system:train", "starve_sweep_error", null, { error: String((e as Error).message ?? e).slice(0, 300) });
    // (0b) BR#3942 — TTL escalation for agent-addressed asks. An ask to an
    // agent identity that sits unanswered past the TTL while the addressee is
    // OFFLINE black-holes: the owner-gated release law (BR#3931) deadlocks
    // ("agents render the verdict + ask the owner") and the human — the final
    // escalation — never hears of it (the BR#3930 incident: ask to
    // macbook-pro-local-opencode, direct identity last_seen=null, Ray saw
    // nothing until he released the card by hand). One re-route on the SAME
    // node: meta.ask.escalated is stamped once, the human planes surface it
    // with the proof, and NO duplicate ask is minted (one-ask-per-class
    // doctrine). An ONLINE addressee + unanswered is still reachable —
    // agents may simply be mid-task — so no escalation.
    await this.escalateStaleAsks(now0);



    }
    // (A3) stale in_review: an impl owner parks in in_review awaiting a verify
    // verdict. If no verifier ever picks the verification round up, the park is
    // permanent — the watchdog used to sweep only in_progress, so in_review
    // rows accumulated indefinitely. Past the review-stale threshold with no
    // verify child actively running, bounce: in_review → in_progress (findings
    // note) → todo (released to the pool). The bounce supersedes the stale
    // verify round automatically.
    const now = Date.now();
    const rs = this.one(`SELECT value FROM settings WHERE key = 'review_stale_minutes'`);
    const reviewStaleMin = rs ? Math.max(30, Math.min(2880, parseInt(rs.value, 10) || 360)) : 360;
    const reviewRows = this.state.storage.sql.exec(
      `SELECT id, owner, meta, status_ts, updated_ts FROM artefacts
       WHERE type = 'task' AND status = 'in_review'`,
    ).toArray();
    for (const r of reviewRows as any[]) {
      try {
        const meta = JSON.parse(r.meta ?? "{}");
        if (meta.awaiting_ask) continue;
        const age = now - Math.max(r.status_ts ?? 0, r.updated_ts ?? 0);
        if (age <= reviewStaleMin * 60_000) continue;
        const openAsk = this.one(`SELECT id FROM asks WHERE status = 'open' AND artefact_id = ?`, r.id);
        if (openAsk) continue;
         const activeVerify = this.one(
           `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
            WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status = 'in_progress'
              AND c.roles LIKE '%"review"%' LIMIT 1`, r.id,
         );
        if (activeVerify) continue; // a verifier is on it — give them time
        const hours = Math.round(age / 3_600_000);
        // BR#4067 — the same typed-proxy law for the review-stall bounce: a
        // card the train owns or that parks on a typed wait is HELD, never
        // released — the bounce destroys the queue slot it sits in.
        const hold = releaseHold(meta);
        if (hold) {
          // BR#4282 — the same satisfied-atom route before this re-park: an
          // in_review card whose pr leg already merged owes a done-close, not
          // a re-armed proxy park.
          if (await this.routeSatisfiedProxy(r, meta, now, `review stalled ${hours}h`)) continue;
          await this.transition(this.holdParkBody(r.id, meta, hold, `review stalled ${hours}h`), "system:watchdog");
          continue;
        }
        const findings = `watchdog: review stalled ${hours}h — no verifier picked up the verification round. No adverse findings; resolve whatever the last gate/review named and hand off again, or let the work re-enter the pool.`;
        await this.transition({ id: r.id, to: "in_progress", note: findings }, "system:watchdog");
        await this.transition({ id: r.id, to: "todo", note: "released to the pool after a stalled review round (watchdog)" }, "system:watchdog");
      } catch (e) {
        // one bad task must not kill the sweep — log and keep going
        this.audit("system:watchdog", "sweep_error", r.id, { error: String((e as Error).message ?? e) });
      }
    }
    // (B) subprocess blocks (legacy shape: blocked + meta.blocked.class) are gone —
    // subprocess silence now lives on in_progress tasks (A2 above). Nothing to sweep here.
    // (B) subprocess blocks: watchdog paused while the declared budget runs;
    // past the budget the declaration is a lie — convert to abandoned.
    // (Legacy shape only — new subprocess silence lives on in_progress tasks.)
    const subRows = this.state.storage.sql.exec(
      `SELECT id, owner, meta FROM artefacts WHERE type = 'task' AND status = 'blocked'`,
    ).toArray();
    for (const r of subRows as any[]) {
      try {
      const meta = JSON.parse(r.meta ?? "{}");
      const b = meta.blocked;
      if (b?.class !== "subprocess" || typeof b.deadline_ts !== "number") continue;
      if (b.deadline_ts > now) continue;
      // BR#4067 — the lapsed window releases the SUBPROCESS declaration, not
      // a machine wait: a card that (also) carries train/typed-wait state
      // stays parked, the wait meta untouched.
      const hold = releaseHold(meta);
      if (hold) {
        meta.blocked = {
          ...(meta.blocked ?? {}),
          reason: `declared subprocess window (${b.budget_minutes ?? "?"}m) lapsed, but the card carries ${hold} — release held (BR#4067)`,
        };
        this.state.storage.sql.exec(
          `UPDATE artefacts SET meta = ?, status_ts = ?, updated_ts = ? WHERE id = ?`,
          JSON.stringify(meta), now, now, r.id,
        );
        this.audit("system:watchdog", "release_held", r.id, { hold, from: "blocked", window: b.budget_minutes ?? null });
        this.version(r.id, "system:watchdog", "note", `subprocess window lapsed but release HELD — ${hold} (BR#4067)`, { hold });
        continue;
      }
      const wasDoing = meta.last_progress?.will ? `; was about to: ${String(meta.last_progress.will).slice(0, 120)}` : "";
      // legacy lapsed window: stalled, not blocked — straight to todo
      delete meta.blocked;
      delete meta.subprocess;
      const tags: string[] = parseTags(r.meta ? JSON.parse(r.meta).tags ?? "[]" : "[]");
      if (!tags.includes("attempted")) tags.push("attempted");
      const attempts = ((meta.attempt?.attempts as number) ?? 0) + 1;
      meta.attempt = { by: r.owner || "unknown", at: now, attempts };
      this.state.storage.sql.exec(
        `UPDATE artefacts SET status = 'todo', owner = '', tags = ?, meta = ?, status_ts = ?, updated_ts = ? WHERE id = ?`,
        JSON.stringify(tags), JSON.stringify(meta), now, now, r.id,
      );
      this.audit("system:watchdog", "transition", r.id, { from: "blocked", to: "todo", note: `stalled — declared subprocess window (${b.budget_minutes ?? "?"}m) lapsed${wasDoing}` });
      this.version(r.id, "system:watchdog", "transition", `stalled — declared subprocess window lapsed, released to the pool`, { from: "blocked", to: "todo" });
      } catch (e) {
        this.audit("system:watchdog", "sweep_error", r.id, { error: String((e as Error).message ?? e) });
      }
    }
    // (D) blocked-staleness sweep — BR#2893. Blocked had no clock: churn-guard
    // parks (a retry instruction stamped as a block) and dead ask-refs sat
    // forever, owned by dead runner labels that only they could release — the
    // broken runner owned the parking lot. On tick, drain parks whose unblock
    // condition is DEAD (churn boilerplate, every referenced ask closed) or
    // that aged past the bar with NO external gate: demote to todo via the
    // normal release path (claim drops, attempt counter, unblock-twin cleanup
    // all apply), reason attached to the card. True external gates (dated
    // checkpoint, GitHub lane, red-main) are exempt — the board renders them
    // under "awaiting external input".
    const bsRow = this.one(`SELECT value FROM settings WHERE key = 'blocked_stale_hours'`);
    const blockedStaleHours = bsRow ? Math.max(1, Math.min(720, parseInt(bsRow.value, 10) || 48)) : 48;
    const blockedStaleMs = blockedStaleHours * 3_600_000;
    const parkCensus = { total: 0, external: 0 };
    let drained = 0;
    const parkRows = this.state.storage.sql.exec(
      `SELECT id, owner, meta, status_ts, updated_ts FROM artefacts WHERE type = 'task' AND status = 'blocked'`,
    ).toArray();
    for (const r of parkRows as any[]) {
      try {
        const meta = JSON.parse(r.meta ?? "{}");
        parkCensus.total++;
        if (meta.awaiting_ask) continue; // ask-gated: the ask TTL + hourly aging annotation govern these (rule 6)
        // BR#4067 — a park on a live machine wait is not drainable age. The
        // release-hold backstop refuses ANY machine release of a card holding
        // a typed await_event / train queue slot / bound ask, so attempting
        // the drain never lands: it stamps blocked_drained and then re-breeds
        // an audited transition_rejected on EVERY tick (specimen BR#4566 /
        // BR#3575: this sweep re-poked a pr_merged park each ~60s cycle,
        // 2026-10-29 02:18–02:20Z, folding unclassified breach cards across
        // the parked fleet — the text-only blockedParkVerdict markers cannot
        // see a typed wait, e.g. "PR repo#123 merges" matches neither the
        // GitHub-lane URL nor the GH# form). Same hold check as the
        // subprocess leg (B) above; such parks count as external input —
        // the proxy watch / the answer / a human owns their exit.
        if (releaseHold(meta)) { parkCensus.external++; continue; }
        const b = meta.blocked ?? {};
        const verdict = blockedParkVerdict({
          reason: String(b.reason ?? ""),
          unblockCondition: String(b.unblock_condition ?? ""),
          now,
          staleMs: blockedStaleMs,
          blockedTs: Number(b.ts ?? 0) || undefined,
          askIsOpen: (id) => !!this.one(`SELECT id FROM asks WHERE id = ? AND status = 'open'`, id),
        });
        if (verdict.klass === "external") { parkCensus.external++; continue; }
        // BR#4562 — the typed-proxy law for the park drain, the same check the
        // review-stall and subprocess sweeps make before releasing: a card
        // parked on a typed wait, a bound ask or a train queue slot is HELD —
        // the proxy watch / the answer owns the exit, not the staleness sweep.
        // Attempting the release the BR#4067 backstop will refuse re-manufactured
        // the refusal every tick (an unbounded transition_rejected storm that
        // folded into the 2026-10-29 "unclassified" breach pile) — check the
        // hold BEFORE the blocked_drained annotation and wait it out.
        if (releaseHold(meta)) continue;
        const dead = verdict.klass === "churn-park" || verdict.klass === "dead-ask";
        const age = now - Math.max(Number(b.ts ?? 0) || 0, r.status_ts ?? 0, r.updated_ts ?? 0);
        if (!dead && age <= blockedStaleMs) continue; // honest fresh park — not the sweep's business yet
        // annotate BEFORE the transition: it clears meta.blocked (the
        // invariant demands it) and this record survives to tell the story
        meta.blocked_drained = { ts: now, klass: verdict.klass, why: verdict.why };
        this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), r.id);
        await this.transition({
          id: r.id, to: "todo",
          note: `watchdog: blocked park drained — ${verdict.why}; owner released to the pool`,
        }, "system:watchdog");
        drained++;
      } catch (e) {
        this.audit("system:watchdog", "sweep_error", r.id, { error: String((e as Error).message ?? e) });
      }
    }
    // (E) owner-death release — BR#2893. A card's only legal releasers are its
    // owner or a human; when the owner is a dead runner label the claim is a
    // dead hand on live work. Past the owner-staleness bar with NO live
    // session for the owner AND no touch on the card itself, ownership
    // lapses: in_progress releases to the pool; blocked/in_review lose the
    // dead claim but keep their status (the blocked sweep and the review
    // sweep own those statuses). Declared silence (grace/subprocess) and
    // ask-gated cards are exempt — their clocks are honored, not ours.
    const osRow = this.one(`SELECT value FROM settings WHERE key = 'owner_stale_hours'`);
    const ownerStaleHours = osRow ? Math.max(1, Math.min(168, parseInt(osRow.value, 10) || 4)) : 4;
    const ownerStaleMs = ownerStaleHours * 3_600_000;
    const ownerSeen = new Map<string, number>();
    for (const s of this.state.storage.sql.exec(
      `SELECT t.label AS label, t.principal AS principal, MAX(s.last_seen_ts) AS seen
       FROM sessions s JOIN auth_tokens t ON t.id = s.token_id GROUP BY t.label, t.principal`,
    ).toArray() as any[]) {
      if (s.label) ownerSeen.set(String(s.label), Math.max(ownerSeen.get(String(s.label)) ?? 0, Number(s.seen ?? 0)));
      if (s.principal) ownerSeen.set(String(s.principal), Math.max(ownerSeen.get(String(s.principal)) ?? 0, Number(s.seen ?? 0)));
    }
    // (0b) BR#3911: human-claim holds on questions auto-revert past their
    // window — the pool sees the question again, the expiry is on the record.
    try { await this.questionClaimSweep(now); } catch (e) {
      this.audit("system:watchdog", "sweep_error", "question_claim_sweep", { error: String((e as Error).message ?? e).slice(0, 300) });
    }
    let ownerReleased = 0;
    const ownedRows = this.state.storage.sql.exec(
      `SELECT id, status, owner, meta, status_ts, updated_ts FROM artefacts
       WHERE type = 'task' AND owner != '' AND status IN ('in_progress','blocked','in_review')`,
    ).toArray();
    for (const r of ownedRows as any[]) {
      try {
        const meta = JSON.parse(r.meta ?? "{}");
        if (meta.awaiting_ask) continue; // an open ask runs its own TTL; the asker auto-resumes
        if (typeof meta.grace_until === "number" && meta.grace_until > now) continue;
        if (meta.subprocess && typeof meta.subprocess.deadline_ts === "number" && meta.subprocess.deadline_ts > now) continue;
        const ownerTs = ownerSeen.get(String(r.owner)) ?? 0;
        if (now - ownerTs <= ownerStaleMs) continue; // the owner has a live session somewhere
        const cardTs = Math.max(
          meta.last_progress?.ts ?? 0, meta.session_alive_ts ?? 0, r.status_ts ?? 0, r.updated_ts ?? 0,
        );
        if (now - cardTs <= ownerStaleMs) continue; // the card itself moved — attribution lag, not death
        const silentH = Math.max(1, Math.round((now - ownerTs) / 3_600_000));
        if (r.status === "in_progress") {
          await this.transition({
            id: r.id, to: "todo",
            note: `watchdog: owner-death release — ${r.owner} has had no live session for ~${silentH}h; claim released to the pool`,
          }, "system:watchdog");
        } else {
          // blocked/in_review: lapse the ownership, keep the status — an
          // unowned park is pool-adjacent state a human or fresh agent can move
          this.state.storage.sql.exec(`UPDATE artefacts SET owner = '', updated_ts = ? WHERE id = ? AND owner = ?`, now, r.id, r.owner);
          this.audit("system:watchdog", "owner_lapsed", r.id, { owner: r.owner, status: r.status, silent_h: silentH });
          this.version(r.id, "system:watchdog", "note", `ownership lapsed — ${r.owner} has had no live session for ~${silentH}h (owner-death release, BR#2893)`);
        }
        ownerReleased++;
      } catch (e) {
        this.audit("system:watchdog", "sweep_error", r.id, { error: String((e as Error).message ?? e) });
      }
    }
    // (C) verification nudge: an unclaimed verify task parks its parent's owner —
    // never reaped (you can't be "abandoned" from work you never picked up). Past
    // the threshold, nudge once per hour: audit line (Log + ws broadcast) for the
    // role:review agents and the waiting owner. The score signal does the rest.
    const nudgeRows = this.state.storage.sql.exec(
      `SELECT r.src_id AS verify_task, r.dst_id AS parent_id, c.updated_ts AS age_ts, p.owner AS parent_owner
       FROM relations r
       JOIN artefacts c ON c.id = r.src_id
       JOIN artefacts p ON p.id = r.dst_id
        WHERE r.relation = 'child_of'
          AND c.type = 'task' AND c.status = 'todo' AND c.owner = ''
          AND c.roles LIKE '%"review"%'
          AND p.type = 'task' AND p.status = 'in_review'`,
    ).toArray() as any[];
    for (const v of nudgeRows) {
      const age = now - (v.age_ts ?? now);
      if (age <= 60 * 60_000) continue;
      const lastNudge = this.one(
        `SELECT ts FROM events WHERE artefact_id = ? AND op = 'nudge' ORDER BY ts DESC LIMIT 1`, v.verify_task,
      );
      if (lastNudge && now - Number(lastNudge.ts) <= 60 * 60_000) continue;
      const mins = Math.round(age / 60_000);
      this.audit("system:pool", "nudge", v.verify_task, {
        note: `verify task unclaimed ${mins}m — this blocks ${v.parent_id}'s owner (${v.parent_owner || "unknown"}). Pick it up: check receipts, close or bounce the parent.`,
        parent: v.parent_id, parent_owner: v.parent_owner ?? "", age_min: mins,
      });
    }
    // (B/C/D/G — the hub's GitHub sweeps — DELETED with the hub's credentials
    // (BR#3516 §1/§8): the merge-queue sweep is re-homed as the opportunistic
    // edge executor (bridge train, worker-local creds, doctor-
    // defended); stop-the-line reads move into the executor's awaiting-CI
    // poll; provenance is stamped ledger-native by train events; the closure
    // audit was GitHub-reading. The hub keeps its credential-free monitoring
    // job below: lane lease staleness.)

    // (E) blocker rollup: blocked cards sharing one machine-detectable root
    // cause (one unmerged PR; red main — BR#551) collapse into ONE boosted
    // ROOT BLOCKER task, and the queued cards point at it. The human sees a
    // single approval surface instead of N identical parked cards (BR#2645).
    let rollup: { created: string[]; stamped: number } | undefined;
    try {
      rollup = await this.rootBlockerRollup(now);
    } catch (e) {
      // the rollup must never take the watchdog down — log and keep going
      this.audit("system:watchdog", "sweep_error", "root_blocker_rollup", { error: String((e as Error).message ?? e).slice(0, 300) });
    }

    // (F) unblock-proxy watch (BR#3361a): blocked cards with machine-checkable
    // unblock conditions re-evaluated periodically; the unblock duty
    // auto-spawns when the proxy flips TRUE. Isolated like its siblings.
    try {
      await this.unblockProxySweep(now);
    } catch (e) {
      this.audit("hub:proxy-watch", "sweep_error", "unblock_proxy_sweep", { error: String((e as Error).message ?? e).slice(0, 300) });
    }

    // (G) train-watch (BR#3516): the hub's credential-free half of the merge
    // train — lane lease staleness. A lease past its expiry with no live
    // heartbeat means the executor died/went to sleep: the lane card shows
    // `blocked: awaiting an available gateway` (honest — merges happen when
    // machines are on) and the lapsed lease is cleared so the next gateway
    // reconciles from live GitHub and acquires. The executor-side gates make
    // the reconcile safe; the hub never talks to GitHub to check this.
    try {
      await this.trainWatchSweep(now);
    } catch (e) {
      this.audit("system:merge-train", "sweep_error", "train_watch", { error: String((e as Error).message ?? e).slice(0, 300) });
    }

    // observability: the board can answer "is the watchdog alive?" via
    // /api/kb/stats — last tick, next alarm ts (poison detection: a
    // next_alarm_ts stuck in the past means the schedule is jammed), stale
    // in-flight count, open asks.
    const nextAlarm = await this.state.storage.getAlarm();
    this.state.storage.sql.exec(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('watchdog.last_tick', ?)`,
      String(now),
    );
    this.state.storage.sql.exec(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('watchdog.next_alarm', ?)`,
      String(nextAlarm ?? 0),
    );
    const staleMs = this.staleMinutes() * 60_000;
    const staleNow = this.one(
      `SELECT COUNT(*) AS n FROM artefacts WHERE type = 'task' AND status = 'in_progress'
       AND COALESCE(json_extract(meta, '$.last_progress.ts'), 0) < ?`,
      now - staleMs,
    )?.n ?? 0;
    const staleReviewNow = this.one(
      `SELECT COUNT(*) AS n FROM artefacts WHERE type = 'task' AND status = 'in_review' AND status_ts < ?`,
      now - reviewStaleMin * 60_000,
    )?.n ?? 0;
    const openAsks = this.one(`SELECT COUNT(*) AS n FROM asks WHERE status = 'open'`)?.n ?? 0;
    this.state.storage.sql.exec(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('watchdog.sweep', ?)`,
      JSON.stringify({
        ts: now, stale_in_progress: staleNow, stale_in_review: staleReviewNow,
        review_stale_minutes: reviewStaleMin, open_asks: openAsks,
        root_blocker_rollup: rollup ?? null,
        blocked_parks: {
          total: parkCensus.total, external: parkCensus.external,
          drained_this_tick: drained, owner_released_this_tick: ownerReleased,
          blocked_stale_hours: blockedStaleHours, owner_stale_hours: ownerStaleHours,
        },
      }),
    );
    // BR#4212: persist the channel counters once per tick so an isolate
    // restart loses at most one minute of channel stats (/stats.channel reads
    // the live in-memory counters, with this as last_flush). Best-effort —
    // a fault here must never kill the sweep.
    try {
      this.state.storage.sql.exec(
        `INSERT OR REPLACE INTO settings (key, value) VALUES ('channel_stats', ?)`,
        JSON.stringify({ ts: now, routes: this.routeStats, entry_faults: this.storageFaults, ws_send_fail: this.wsSendFail }),
      );
    } catch { /* recounted on the next tick */ }
  }

  /** The (A) phase of the watchdog: silent in_progress cards (BR#4067 hold
   *  semantics, BR#4282 route-to-exit). A card carrying a machine wait — a
   *  merge-train slot, a typed proxy, a bound ask — is HELD, never released;
   *  but the hold-park re-park runs ONLY after the satisfied-atom check: a
   *  pr_merged proxy whose merge receipt is already on the board (the train's
   *  own awaiting-ci stamp, or the provenance row) routes to the EXIT — the
   *  owned done-close duty — instead of re-arming a satisfied proxy. A plain
   *  silent card releases to the pool. Runs every alarm tick;
   *  admin.stall_sweep drills it in isolation with a synthetic clock. */
  private staleMinutes(): number {
    const s = this.one(`SELECT value FROM settings WHERE key = 'stale_minutes'`);
    return s ? Math.max(1, Math.min(120, parseInt(s.value, 10) || 10)) : 10;
  }

  private async stallSweep(nowIn: number) {
    const staleMin = this.staleMinutes();
    const staleMs = staleMin * 60_000;
    const now = nowIn;
    const rows = this.state.storage.sql.exec(
      `SELECT id, status, owner, title, meta, status_ts, updated_ts FROM artefacts
       WHERE type = 'task' AND status = 'in_progress'`,
    ).toArray();
    for (const r of rows as any[]) {
      try {
      const meta = JSON.parse(r.meta ?? "{}");
      if (meta.awaiting_ask) {
        // aging escalation: a task parked on a human answer must show its
        // age, or the wait is invisible and unbounded. Annotate hourly;
        // the release stays human-owned (an answered ask un-blocks it).
        try {
          let ask: { to_target?: string; created_ts: number } | undefined;
          const derived = this.one(
            `SELECT c.id AS id, c.created_ts AS created_ts, c.meta AS cmeta FROM relations r
             JOIN artefacts c ON c.id = r.src_id
              WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
                AND c.type = 'question' ORDER BY c.created_ts DESC LIMIT 1`, r.id,
          );
          if (derived) {
            const nm = JSON.parse(derived.cmeta ?? "{}");
            ask = { to_target: nm.ask?.to, created_ts: derived.created_ts };
          } else if (/^BR#\d+$/.test(String(meta.awaiting_ask.ask_id))) {
            const node = this.one(`SELECT meta, created_ts, status FROM artefacts WHERE id = ? AND status IN ('todo','in_progress','blocked')`, meta.awaiting_ask.ask_id);
            if (node) {
              const nm = JSON.parse(node.meta ?? "{}");
              ask = { to_target: nm.ask?.to, created_ts: node.created_ts };
            }
          } else {
            const row = this.one(`SELECT to_target, created_ts FROM asks WHERE id = ? AND status = 'open'`, meta.awaiting_ask.ask_id);
            if (row) ask = { to_target: row.to_target, created_ts: row.created_ts };
          }
          if (ask) {
            const hours = Math.floor((now - ask.created_ts) / 3_600_000);
            if (meta.awaiting_ask.annotated_h !== hours) {
              meta.awaiting_ask.annotated_h = hours;
              const base = String(meta.blocked?.reason ?? "").replace(/^⏳ blocked \d+h — .*? · /, "");
              meta.blocked = { ...(meta.blocked ?? {}), reason: `⏳ blocked ${hours}h — awaiting ${ask.to_target ?? "human"} on ask ${meta.awaiting_ask.ask_id} · ${base}` };
              this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), r.id);
            }
          }
        } catch { /* annotation is best-effort */ }
        continue;
      }
      // (A) declared grace: the agent stated a silence window — honor it until it lapses
      if (typeof meta.grace_until === "number" && meta.grace_until > now) continue;
      // (A2) declared subprocess window: the task is still in_progress, just
      // quiet while a subprocess runs — watchdog paused until the budget lapses
      if (meta.subprocess && typeof meta.subprocess.deadline_ts === "number") {
        if (meta.subprocess.deadline_ts > now) continue;
        // lapsed: the declaration is a lie — fall through to abandoned below
      }
      const lastTs = Math.max(
        meta.last_progress?.ts ?? 0, r.status_ts ?? 0, r.updated_ts ?? 0,
        meta.session_alive_ts ?? 0, // runner vouches the session is alive (stdout/ACP movement) — quiet work is not dead work
        this.sessionPing(meta), // BR#4067: a dispatched run pings the hub (orient/claim) — a fresh session signal means the run is plausibly still in flight
      );
      if (now - lastTs <= staleMs) continue;
      const openAsk = this.one(
        `SELECT id FROM asks WHERE status = 'open' AND artefact_id = ?`, r.id,
      );
      if (openAsk) continue;
      // BR#4067 — typed-proxy preservation: silence must not destroy a machine
      // wait. A card the train owns (queued/awaiting-ci/bounced on a live PR)
      // or one parked on a typed await / bound ask is PARKED blocked — the
      // reason names the silence, the wait meta survives, the proxy owns the
      // exit (the PR #257 class: releases severed queue slots and stranded
      // the cards). result_class exempts the hold from abandonment scoring.
      const hold = releaseHold(meta);
      if (hold) {
        // BR#4282 — atom-check BEFORE the re-park: a hold derived from a
        // pr_merged proxy whose merge receipt is already on the board must
        // route to the exit (the owned done-close duty), never re-block —
        // re-arming a satisfied proxy is the BR#4023/4135/4177/4113 loop
        // (silence → re-park on the satisfied atom → identical unblock round
        // → flood-skip → threshold-1 breach card).
        if (await this.routeSatisfiedProxy(r, meta, now, `no update for >${staleMin}m`)) continue;
        // BR#4494 — bounce re-entry demote: a train bounce re-opens its card
        // in_progress (session:"" on the transition, the PRIOR — usually dead
        // — session left as executor) and in_progress is not claimable (claim
        // = todo → in_progress). For a BOUNCED card the machine wait no longer
        // owns the next leg: the train has handed the leg BACK to the board
        // (re-entry only after a fresh verify accept), so parks-not-releases
        // here mints the silent-unclaimable loop — the BR#4198 specimen (4
        // coverage bounces, one breach card per ~11-min cycle, the demanded
        // re-verify leg never starting by any machine path). Demote to todo:
        // claimable, with the bounce brief + boost riding the card. The
        // queued/awaiting-ci flavors KEEP the hold — those are live queue
        // slots (the PR #257 class this park exists to protect). The machine
        // backstop admits exactly this shape (demote_bounced_reentry).
        const mtState = String(((meta.merge_train ?? {}) as Record<string, unknown>).state ?? "");
        if (mtState === "bounced") {
          await this.transition(
            {
              id: r.id,
              to: "todo",
              note: `bounce re-entry demoted (watchdog, BR#4494): the train bounce re-opened this card in_progress with no live executor and its demanded leg had no machine starter — released claimable with the bounce brief intact; a fresh verify accept re-queues the train`,
              demote_bounced_reentry: true,
              result_class: BOUNCE_REENTRY_DEMOTE_RESULT_CLASS,
            },
            "system:watchdog",
          );
          continue;
        }
        await this.transition(this.holdParkBody(r.id, meta, hold, `no update for >${staleMin}m`), "system:watchdog");
        continue;
      }
      const will = meta.last_progress?.will ? `; was about to: ${String(meta.last_progress.will).slice(0, 120)}` : "";
      const lapsedSub = meta.subprocess ? ` (declared subprocess window of ${meta.subprocess.budget_minutes ?? "?"}m lapsed)` : "";
      // BR#3352: classify the release from the session trail. A silent task
      // whose trail proves landed side effects (GitHub PR/issue/commit
      // receipts, or the runner's own completed_result_lost marker) is NOT an
      // abandonment — the run happened and the report was lost between worker
      // and hub. Recording the outcome class lets the score side exempt it
      // and flags the delivery channel instead of punishing the agent.
      let trail: ResultTrail | null = null;
      try {
        const notes = (this.state.storage.sql.exec(
          `SELECT summary FROM ledger WHERE artefact_id = ? AND kind = 'mutation' AND action = 'progress' ORDER BY seq DESC LIMIT 20`,
          r.id,
        ).toArray() as any[]).map((x) => String(x.summary ?? ""));
        const sess = meta.session
          ? this.one(`SELECT worktree FROM sessions WHERE name = ? AND worktree IS NOT NULL ORDER BY last_seen_ts DESC LIMIT 1`, String(meta.session))
          : null;
        trail = detectResultTrail({
          last_progress_note: meta.last_progress?.note,
          recent_notes: notes,
          worktree: sess?.worktree ?? null,
          session: meta.session ?? null,
        });
      } catch { /* trail read is best-effort — classify as a plain stall on failure */ }
      // STALLED, not blocked: silence means "we haven't heard from the agent"
      // — blocked is reserved for the agent's own explicit "I cannot continue
      // until X". Release straight to todo: the claim drops, the attempted tag
      // records the try, and the next orient reassigns it. No blocked
      // intermediate, no unblock-child spawn for silence.
      await this.transition({
        id: r.id, to: "todo",
        note: trail
          ? `stalled — no update for >${staleMin}m; completed_result_lost — ${describeResultTrail(trail)}; result never reached the hub — released to the pool by watchdog (delivery channel flagged, not agent abandonment)${will}`
          : `stalled — no update for >${staleMin}m${lapsedSub}; released to the pool by watchdog${will}`,
        ...(trail ? { result_class: "completed_result_lost" } : {}),
      }, "system:watchdog");
      } catch (e) {
        // one bad task must not kill the sweep — log and keep going
        this.audit("system:watchdog", "sweep_error", r.id, { error: String((e as Error).message ?? e) });
      }
    }
  }


  private settingValue(key: string, fallback: string): string {
    const row = this.one(`SELECT value FROM settings WHERE key = ?`, key);
    if (!row) return fallback;
    const raw = String(row.value);
    // settingsSet stores JSON-encoded values ("\"BR#123\""); the sweep's own
    // pacing writes store raw — tolerate both shapes.
    try {
      const v = JSON.parse(raw);
      if (typeof v === "string" || typeof v === "number") return String(v);
    } catch { /* raw */ }
    return raw;
  }


  /** sha → PR → task → verify-verdict → agent session (BR#3287). Matches by
   *  merge sha or head sha (7+ hex prefix). Returns null when nothing is
   *  known — an honest "no bridge provenance" (404) rather than a guess. */
  private async provenanceLookup(sp: URLSearchParams) {
    return this.provenanceBySha(parseProvenanceSha(sp));
  }

  private async provenanceBySha(sha: string) {
    const row = this.one(
      `SELECT * FROM provenance WHERE merge_sha = ? OR merge_sha LIKE ? OR head_sha = ? OR head_sha LIKE ? LIMIT 1`,
      sha, `${sha}%`, sha, `${sha}%`,
    ) as any;
    if (!row) return null;
    const task = row.task_id ? this.one(`SELECT id, title, status, owner FROM artefacts WHERE id = ?`, row.task_id) as any : null;
    return {
      sha,
      repo: row.repo, pr: row.pr,
      merge_sha: row.merge_sha, head_sha: row.head_sha,
      task: task ? { id: task.id, title: task.title, status: task.status, owner: task.owner } : null,
      verdict_id: row.verdict_id, session: row.session, signer: row.signer,
      merged_at: row.merged_at, stamped_at: row.stamped_at,
    };
  }

  /** The guilty-chain outcome for an alarm note (BR#3307, residue of
   *  BR#3287 spec item 4): explicitly typed — `rec` carries the resolved
   *  PR → task → verify verdict → agent session → signer chain when the
   *  provenance index has stamped the merge, and `error` is set ONLY when
   *  the lookup itself failed. Never throws — attribution must not break
   *  the filing (the same downgrade philosophy as the bisect walk) — but a
   *  failure is never converted into success: the caller distinguishes it
   *  (the note renders the error, not the honest-absence line) and the
   *  audit trail receipts it (hub:stop-the-line/guilty_chain_error — SP
   *  review round 1, PR #198: silence was the one thing it must not be). */

  // ---------- unblock-proxy watch (BR#3361a) ----------
  // The BR#3129 class: a parked card's machine-checkable unblock_condition
  // flipped TRUE (its PR merged) and NOBODY noticed for ~20h — unblock duties
  // only re-ran when a human-dispatched sweep happened to look. This sweep
  // re-evaluates machine-checkable proxies periodically and auto-spawns the
  // unblock duty on the flip.
  //
  // Conservatism: the sweep is a TRIGGER, not an authority. It flips a card
  // only when parseProxyCondition extracted atoms for the WHOLE condition and
  // every atom evaluated TRUE against live state; anything it cannot fully
  // read is stamped unparseable/unresolvable and never auto-flips. The
  // spawned duty re-verifies first-hand (its contract says so).
  //
  // Settings: `unblock_proxy_sweep_minutes` (default 15, 0 = off),
  // `unblock_proxy_default_repo` (bare-number fallback for live checks).
  //
  // DEGRADED (BR#3516 §8): the hub holds no VCS credentials, ever — the
  // GitHub-reading proxyGhGet and the unauthenticated fetches are gone. Only
  // board-state atoms (br_done) still evaluate; GitHub-state atoms stamp
  // unresolvable (never auto-flip — conservatism law) and the spawned unblock
  // duty verifies them first-hand, where the creds live.
  /** Live verdict for one proxy atom. `receipt` is the evidence line that
   *  rides the spawned duty's body (and the per-card stamp). `probeState`
   *  (BR#4658) carries the worker-executor verification-probe lifecycle for
   *  run_success/pr_checks_green atoms: unprobed (needs enqueue) | pending |
   *  exhausted (cap reached — loud unresolvable again) | negative (conclusive
   *  no — the gate has not fired). */
  private async evalProxyAtom(
    atom: ProxyAtom,
    io: { defaultRepo: string },
  ): Promise<{ ok: boolean; receipt: string; probeState?: "unprobed" | "pending" | "exhausted" | "negative" }> {
    const unresolvable = { ok: false, receipt: "unresolvable (no repo in the condition text)" };
    switch (atom.kind) {
      case "br_done": {
        const row = this.one(`SELECT status FROM artefacts WHERE id = ?`, atom.brId);
        if (!row) return { ok: false, receipt: `${atom.brId} not found on this board` };
        const done = row.status === "done" || row.status === "superseded";
        return { ok: done, receipt: `${atom.brId} status=${row.status}` };
      }
      case "br_answered": {
        // board-state like br_done: the ask/question card left todo —
        // answered, superseded, or any terminal state counts (BR#3620: the
        // BR#3423 class — a human ruling that answered while the card sat).
        const row = this.one(`SELECT status FROM artefacts WHERE id = ?`, atom.brId);
        if (!row) return { ok: false, receipt: `${atom.brId} not found on this board` };
        const answered = row.status === "done" || row.status === "superseded";
        return { ok: answered, receipt: `${atom.brId} status=${row.status}${answered ? " (answered)" : " (still open)"}` };
      }
      case "pr_merged": {
        if (!atom.repo) return unresolvable;
        // ledger-native first (BR#3620): the provenance table is stamped by
        // train events with zero hub GitHub calls — a train-stamped merge is
        // a fact the hub OWNS, unlike a GitHub read it cannot make.
        const pv = this.one(`SELECT merge_sha, signer FROM provenance WHERE repo = ? AND pr = ?`, atom.repo, atom.number);
        if (pv) return { ok: true, receipt: `provenance: ${atom.repo}#${atom.number} merged (sha ${String(pv.merge_sha).slice(0, 9)}, signer ${pv.signer})` };
        return { ok: false, receipt: `unresolvable from the hub — GitHub state ${atom.repo}#${atom.number} needs credentials the hub does not hold (BR#3516) and no train provenance row exists — verify first-hand (gh pr view) or wait for a train event` };
      }
      case "br_pr_merged": {
        // bare form resolves against the default repo (the board's project
        // repo); ledger-native provenance by task_id (BR#3620).
        const repo = atom.repo ?? io.defaultRepo;
        const pv = this.one(
          `SELECT pr, merge_sha, signer FROM provenance WHERE task_id = ? AND repo = ? ORDER BY merged_at DESC LIMIT 1`,
          atom.brId, repo,
        );
        if (pv) return { ok: true, receipt: `provenance: ${atom.brId}'s PR ${repo}#${pv.pr} merged (sha ${String(pv.merge_sha).slice(0, 9)}, signer ${pv.signer})` };
        return { ok: false, receipt: `unresolvable from the hub — GitHub state for ${atom.brId} needs credentials the hub does not hold (BR#3516) and no train provenance row exists — verify first-hand or wait for a train event` };
      }
      case "issue_closed": {
        if (!atom.repo) return unresolvable;
        return { ok: false, receipt: `unresolvable from the hub — issue ${atom.repo}#${atom.number} state needs credentials the hub does not hold (BR#3516); verify first-hand` };
      }
      case "run_success": {
        if (!atom.repo) return unresolvable;
        // BR#4658: ledger-native first — a worker-executor probe verdict is a
        // fact the hub OWNS (stamped through proxy.verify with the gh
        // receipt), same trust shape as the train-stamped provenance above.
        const v = this.one(
          `SELECT ok, receipt, head_sha, conclusion, error, state, attempts FROM proxy_probes WHERE key = ?`,
          proxyProbeKey(atom),
        ) as any;
        if (v?.state === "verified" && v.ok === 1) {
          return { ok: true, receipt: `executor-verified (BR#4658): ${v.receipt}` };
        }
        if (v?.state === "verified" && v.ok === 0) {
          // conclusive negative (head mismatch / run failed) — the gate has
          // NOT fired; the park stays (BR#3409 fail-closed), loudly.
          return { ok: false, receipt: `executor-verified negative (BR#4658): ${v.error || "conclusive negative"} — ${v.receipt}`, probeState: "negative" };
        }
        if (v?.state === "failed") {
          const exhausted = Number(v.attempts ?? 0) >= PROBE_ATTEMPT_CAP;
          return {
            ok: false,
            receipt: exhausted
              ? `worker-executor probe exhausted after ${v.attempts} attempts — ${v.error ?? "gh kept failing"}; verify first-hand (BR#3516)`
              : `worker-executor probe pending (attempt ${v.attempts}/${PROBE_ATTEMPT_CAP} failed: ${v.error ?? "gh failed"} — retrying)`,
            probeState: exhausted ? "exhausted" : "pending",
          };
        }
        if (v) {
          return { ok: false, receipt: `worker-executor probe pending (BR#4658) — a daemon executor will run gh and stamp the verdict`, probeState: "pending" };
        }
        return { ok: false, receipt: `unverified from the hub — run ${atom.runId ?? atom.newerThan} outcome needs credentials the hub does not hold (BR#3516); enqueueing a worker-executor verification probe (BR#4658)`, probeState: "unprobed" };
      }
      case "pr_checks_green": {
        if (!atom.repo) return unresolvable;
        const v = this.one(
          `SELECT ok, receipt, head_sha, conclusion, error, state, attempts FROM proxy_probes WHERE key = ?`,
          proxyProbeKey(atom),
        ) as any;
        if (v?.state === "verified" && v.ok === 1) {
          return { ok: true, receipt: `executor-verified (BR#4658): ${v.receipt}` };
        }
        if (v?.state === "verified" && v.ok === 0) {
          return { ok: false, receipt: `executor-verified negative (BR#4658): ${v.error || "conclusive negative"} — ${v.receipt}`, probeState: "negative" };
        }
        if (v?.state === "failed") {
          const exhausted = Number(v.attempts ?? 0) >= PROBE_ATTEMPT_CAP;
          return {
            ok: false,
            receipt: exhausted
              ? `worker-executor probe exhausted after ${v.attempts} attempts — ${v.error ?? "gh kept failing"}; verify first-hand (BR#3516)`
              : `worker-executor probe pending (attempt ${v.attempts}/${PROBE_ATTEMPT_CAP} failed: ${v.error ?? "gh failed"} — retrying)`,
            probeState: exhausted ? "exhausted" : "pending",
          };
        }
        if (v) {
          return { ok: false, receipt: `worker-executor probe pending (BR#4658) — a daemon executor will run gh and stamp the verdict`, probeState: "pending" };
        }
        return { ok: false, receipt: `unverified from the hub — PR ${atom.repo}#${atom.number} checks need credentials the hub does not hold (BR#3516); enqueueing a worker-executor verification probe (BR#4658)`, probeState: "unprobed" };
      }
      case "deployed": {
        // the one credential-free external atom: the hub IS the deploy. Its
        // [build] hook bakes src/__version.json — same stamp /__version serves.
        if (!atom.commit) return unresolvable;
        try {
          const v = (await import("../__version.json")) as { commit?: string };
          const ok = deployedSatisfied(String(v.commit ?? ""), atom.commit);
          return { ok, receipt: ok ? `hub deployed commit=${v.commit} (wanted ${atom.commit})` : `hub deployed commit=${v.commit ?? "unknown"} — wanted ${atom.commit} (deploy the hub to flip this atom)` };
        } catch {
          return { ok: false, receipt: "hub has no version stamp (pre-[build]-hook deploy) — atom cannot flip" };
        }
      }
      case "ask":
      case "time":
        // BR#4062: board-local typed legs — the sweep evaluates them
        // first-class (evalTypedAskTimeLeg) BEFORE the atom path ever sees
        // them; reaching here means a multi-atom conjunction mixed one in.
        return { ok: false, receipt: `ask/time leg ${atom.askId ?? atom.untilTs} evaluates on its own (typed leg, not a GitHub atom)` };
    }
  }

  /** Stamp meta.proxy_check on a blocked card; audit ONLY when the verdict
   *  changed (a stable false must not churn the Log every cycle). */
  private stampProxyCheck(
    id: string,
    meta: any,
    now: number,
    verdict: string,
    detail: string | null,
    prev: { verdict?: string } | undefined,
    extra?: Record<string, unknown>,
  ): void {
    meta.proxy_check = { at: now, verdict, ...(detail ? { detail } : {}), ...(extra ?? {}) };
    this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), id);
    if (!prev || prev.verdict !== verdict) {
      this.audit("hub:proxy-watch", "proxy_check", id, { verdict, detail: detail?.slice(0, 300) });
    }
  }

  // ---- worker-executor verification probes (BR#4658) ----
  // The hub holds no GitHub credentials (BR#3516); run_success /
  // pr_checks_green parks had NO machine closer (specimen BR#3621: the run
  // concluded SUCCESS and the card sat blocked ~60h past its exit). The
  // sweep enqueues a probe; the daemon executor leg (train.rs, beside the
  // merge train) runs gh first-hand and feeds the verdict through
  // proxy.verify — executor-fed facts, hub-decided (BR#4489). Fail-closed
  // per BR#3409: a head mismatch or an inconclusive gh state never flips.

  /** Enqueue (or retry) the verification probe for one atom. Dedupe by the
   *  atom key — two cards awaiting the same run share ONE probe. Attempt-
   *  capped with backoff pacing so a broken gh never tight-loops. */
  private enqueueProxyProbe(atom: ProxyAtom, cardId: string, now: number): void {
    const key = proxyProbeKey(atom);
    if (!key) return;
    const existing = this.one(`SELECT state, attempts, updated_ts FROM proxy_probes WHERE key = ?`, key) as any;
    if (existing) {
      if (existing.state === "pending" || existing.state === "verified") return; // in flight / done
      // failed: retry on backoff until the cap
      if (Number(existing.attempts ?? 0) >= PROBE_ATTEMPT_CAP) return; // exhausted — loud unresolvable
      if (now - Number(existing.updated_ts ?? 0) < PROBE_RETRY_MS) return; // backoff
      this.state.storage.sql.exec(
        `UPDATE proxy_probes SET state = 'pending', card_id = ?, updated_ts = ? WHERE key = ?`,
        cardId, now, key,
      );
      this.audit("hub:proxy-watch", "proxy_probe_retry", key, { attempts: Number(existing.attempts ?? 0) + 1, card: cardId });
      return;
    }
    this.state.storage.sql.exec(
      `INSERT INTO proxy_probes (key, repo, kind, run_id, newer_than, pr, expected_head, card_id, state, attempts, created_ts, updated_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      key, String(atom.repo ?? ""), atom.kind,
      atom.kind === "run_success" ? (atom.runId ?? null) : null,
      atom.kind === "run_success" ? (atom.newerThan ?? null) : null,
      atom.kind === "pr_checks_green" ? Number(atom.number ?? 0) || null : null,
      atom.kind === "run_success" ? (atom.head ?? null) : null,
      cardId, now, now,
    );
    this.audit("hub:proxy-watch", "proxy_probe_enqueued", key, { card: cardId, kind: atom.kind });
  }

  /** proxy.probes — the executor poll: pending probes, oldest first, capped.
   *  Read-only; the hub decides nothing here (the facts come back through
   *  proxy.verify). */
  private proxyProbes(body: any): any {
    const limit = Math.max(1, Math.min(Number(body?.limit ?? 10) || 10, 25));
    const rows = this.state.storage.sql.exec(
      `SELECT key, repo, kind, run_id, newer_than, pr, expected_head, card_id, attempts FROM proxy_probes
       WHERE state = 'pending' ORDER BY updated_ts ASC LIMIT ?`,
      limit,
    ).toArray();
    return { ok: true, probes: rows };
  }

  /** proxy.verify — the executor feeds one probe's gh verdict; the HUB
   *  decides (executor-fed facts, hub-decided — BR#3516/BR#4489). A
   *  satisfied verdict stamps a `proxy_verified` event on the parked card
   *  with the GitHub-URL receipt and re-enters the standard satisfied-proxy
   *  path on the next sweep pass; head mismatches and conclusive failures
   *  are stamped negative and NEVER flip (BR#3409 fail-closed); transient
   *  gh errors bump attempts (backoff, cap → loud unresolvable again). */
  private proxyVerify(body: any, actor: string): any {
    const key = String(body?.key ?? "").trim();
    const probe = this.one(`SELECT * FROM proxy_probes WHERE key = ?`, key) as any;
    if (!probe) return { ok: false, error: `no such probe: ${key}` };
    if (probe.state === "verified") return { ok: false, error: `probe ${key} already verified — verdict of record stands` };
    const now = Date.now();
    const headSha = typeof body?.head_sha === "string" ? body.head_sha.toLowerCase() : "";
    const receipt = String(body?.receipt ?? "").trim();
    const conclusion = typeof body?.conclusion === "string" ? body.conclusion.toUpperCase() : "";
    const expected = String(probe.expected_head ?? "").toLowerCase();

    // HUB-side head law (BR#3409): the executor reports what it saw; the hub
    // compares against the awaited head — a mismatch is a conclusive NO
    // whatever the executor's ok said.
    const headMismatch = !!(expected && headSha && !headMatches(headSha, expected));

    if (body?.ok === true && !headMismatch) {
      if (!/https:\/\/github\.com\//.test(receipt)) {
        return { ok: false, error: "receipt must carry the GitHub URL(s) of the evidence (BR#4658 contract)" };
      }
      this.state.storage.sql.exec(
        `UPDATE proxy_probes SET state = 'verified', ok = 1, receipt = ?, head_sha = ?, conclusion = ?, error = NULL, attempts = attempts + 1, updated_ts = ? WHERE key = ?`,
        receipt.slice(0, 500), headSha || null, conclusion || null, now, key,
      );
      const note = `proxy_verified: ${probe.kind} SATISFIED — ${receipt}${headSha ? ` (head ${headSha.slice(0, 9)})` : ""} (worker-executor ${actor}, BR#4658)`;
      this.version(probe.card_id, "hub:proxy-watch", "proxy_verified", note, { key, ok: 1, receipt: receipt.slice(0, 300), head_sha: headSha || null });
      this.audit("hub:proxy-watch", "proxy_probe_verified", key, { card: probe.card_id, receipt: receipt.slice(0, 300), head_sha: headSha || null });
      return { ok: true, verdict: "satisfied", note };
    }

    // conclusive negative: the executor saw the gate fail for real (run
    // failed/cancelled, checks red) or the hub's head law failed the verdict.
    const conclusive = headMismatch || body?.conclusive === true;
    if (conclusive) {
      const why = headMismatch
        ? `head mismatch — run concluded at ${headSha.slice(0, 9) || "?"}, the park awaits ${expected.slice(0, 9)} (BR#3409 fail-closed)`
        : String(body?.error ?? body?.reason ?? "conclusive negative from the executor").slice(0, 300);
      const ev = receipt && /https:\/\/github\.com\//.test(receipt) ? receipt : `https://github.com/${probe.repo}/actions`;
      this.state.storage.sql.exec(
        `UPDATE proxy_probes SET state = 'verified', ok = 0, receipt = ?, head_sha = ?, conclusion = ?, error = ?, attempts = attempts + 1, updated_ts = ? WHERE key = ?`,
        ev.slice(0, 500), headSha || null, conclusion || null, why, now, key,
      );
      const note = `proxy_verified: ${probe.kind} NOT satisfied — ${why} (worker-executor ${actor}, BR#4658); the park stands (fail-closed)`;
      this.version(probe.card_id, "hub:proxy-watch", "proxy_verified", note, { key, ok: 0, receipt: ev.slice(0, 300), head_sha: headSha || null });
      this.audit("hub:proxy-watch", "proxy_probe_negative", key, { card: probe.card_id, why });
      return { ok: true, verdict: "negative", note };
    }

    // transient: gh broken / run still in flight — backoff, cap, no event
    // stamp (a pending run re-probing every few minutes must not churn the
    // card's version log).
    const attempts = Number(probe.attempts ?? 0) + 1;
    const err = String(body?.error ?? "gh failed (no detail)").slice(0, 300);
    this.state.storage.sql.exec(
      `UPDATE proxy_probes SET state = 'failed', error = ?, attempts = ?, updated_ts = ? WHERE key = ?`,
      err, attempts, now, key,
    );
    this.audit("hub:proxy-watch", "proxy_probe_transient", key, { attempts, error: err.slice(0, 200) });
    return { ok: true, verdict: attempts >= PROBE_ATTEMPT_CAP ? "exhausted" : "retry", attempts };
  }


  private async unblockProxySweep(now: number): Promise<void> {
    const periodMin = Math.max(0, Math.min(120, parseInt(this.settingValue("unblock_proxy_sweep_minutes", "15"), 10) || 15));
    if (periodMin === 0) return; // explicitly disabled
    const last = Number(this.settingValue("unblock_proxy_last_ts", "0")) || 0;
    if (now - last < periodMin * 60_000) return;
    const setLast = (ts: number) =>
      this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('unblock_proxy_last_ts', ?)`, String(ts));
    setLast(now); // pace BEFORE the fetch: a hung GitHub call must not tight-loop the tick
    const defaultRepo = this.settingValue("unblock_proxy_default_repo", "state-vector/superpositional");
    const rows = this.state.storage.sql.exec(
      `SELECT id, title, meta FROM artefacts WHERE type = 'task' AND status = 'blocked'`,
    ).toArray() as any[];
    // BR#4416 per-pass prose tally + the class-ask / alarm collectors. The
    // class ask is filed AFTER the loop so ONE ask names every card of the
    // class found this pass (never one per card).
    const prose: {
      flip: number; restore: number; release: number; escalate: number; prose: number;
      classCards: { id: string; title: string; fact: string }[];
    } = { flip: 0, restore: 0, release: 0, escalate: 0, prose: 0, classCards: [] };
    for (const r of rows) {
      try {
        const meta = JSON.parse(r.meta ?? "{}");
        const bmeta = meta.blocked ?? {};
        // BR#3578: the typed await (validated at the door) is trusted and
        // evaluated FIRST; the free text is annotation + legacy fallback.
        const aw = validateAwaitEvent(bmeta.await_event) ?? null;
        const cond = String(bmeta.unblock_condition ?? "").trim() || (aw ? describeAwaitEvent(aw) : "");
        if (!cond) continue;
        const prev = meta.proxy_check;
        if (prev?.at && now - Number(prev.at) < periodMin * 60_000) continue; // per-card pacing

        // typed legs: ask/time are first-class — an answered ask or an
        // elapsed timer flips exactly like a machine atom (spawn the duty;
        // the duty re-verifies first-hand).
        if (aw && (aw.event === "ask" || aw.event === "time")) {
          await this.evalTypedAskTimeLeg(r, meta, aw, cond, now, prev);
          continue;
        }

        // machine atoms: classify the TEXT first (BR#3668). A human-gated
        // condition — explicit human-gate markers in the text of record
        // ("Human-only", "no machine atom can flip this", "web/admin",
        // "owner/web-only") — is unparseable BY DESIGN: the only exit is a
        // human click. Never atomized, never flipped, and never migrated to
        // an ask (the marker names the human leg already engaged — the
        // BR#3358 family law is one ask per class). A machine-shaped
        // await_event on such a park (stamped by the pre-BR#3668 text
        // derivation, e.g. BR#3358's {event:"br_done",id:"BR#3361"})
        // contradicts the card's own markers and is ignored for flip
        // purposes. The typed HUMAN legs (ask/time, handled above) still
        // flip: a human-gated card legitimately awaits its human.
        const parsed = parseProxyCondition(cond);
        if (parsed.humanGated) {
          this.stampProxyCheck(r.id, meta, now, "unparseable",
            `human-gated by design ("${parsed.humanGate}") — the only exit is a human action; never atomized, never flipped, never re-fired (BR#3668)`, prev);
          continue;
        }

        // typed machine await wins (trusted); legacy text parses and
        // SELF-MIGRATES to the typed shape (one clean atom → await_event).
        let atoms: ProxyAtom[];
        let unparseable: boolean;
        if (aw) {
          atoms = [awaitEventToAtom(aw)!];
          unparseable = false;
        } else {
          atoms = parsed.atoms;
          unparseable = parsed.unparseable;
          const derived = awaitEventFromAtoms(atoms);
          // BR#3986: never self-migrate a self-referential await onto a card
          // — {br_done, <the card itself>} deadlocks (BR#136). Conjunctions
          // (N atoms) derive null and stay text: the sweep evaluates EVERY
          // atom and flips only when all hold.
          if (derived && !isSelfAwait(r.id, derived)) {
            meta.blocked = { ...(meta.blocked ?? {}), await_event: derived };
            this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), r.id);
            // BR#4062: a prose park that derives an ask/time leg is now typed
            // — evaluate it FIRST-CLASS this tick (board-local legs the
            // GitHub-atom evaluator below cannot read), not a sweep later.
            if (derived.event === "ask" || derived.event === "time") {
              await this.evalTypedAskTimeLeg(r, meta, derived, cond, now, prev);
              continue;
            }
          }
        }
        if (!atoms.length) {
          // BR#4416 prose-card disposition ladder. This branch used to be the
          // ask factory: every prose park became a per-card "awaits nothing
          // the machine can read" ask to the human — moot when the card's own
          // machine state held the exit receipt (BR#4170: PR MERGED, human
          // asked anyway), mechanical when a typed leg was recoverable from
          // meta. The ladder resolves what the machine can prove and asks a
          // human ONLY for genuine ambiguity, ONE ask per class per day.
          // (BR#4364 reconcile: this supersedes the BR#3578/BR#3620 per-card
          // migration-ask factory this branch once carried — the ladder's
          // recoverProseLegs already treats an existing migration ask
          // (blocked.await_migration_ask) as a typed leg and flips the card
          // when it is answered, so BR#3620's answered-ask exit is preserved
          // through the ladder, not the per-card ask.)
          await this.proseLadder(r, meta, cond, now, prev, unparseable, prose);
          continue;
        }
        const results: { atom: ProxyAtom; ok: boolean; receipt: string; probeState?: string }[] = [];
        for (const atom of atoms) results.push({ atom, ...(await this.evalProxyAtom(atom, { defaultRepo })) });
        const unresolvable = results.some((x) => !x.ok && x.receipt.startsWith("unresolvable"));
        if (unparseable || unresolvable) {
          // cannot FULLY read the condition — never auto-flip (conservatism law)
          this.stampProxyCheck(r.id, meta, now, unparseable ? "unparseable" : "unresolvable",
            "condition partially machine-checkable — the sweep never flips a card it cannot fully read", prev,
            { atoms: results.map((x) => ({ raw: x.atom.raw, ok: x.ok, receipt: x.receipt })) });
          continue;
        }
        // BR#4658 — the worker-executor verification leg. run_success /
        // pr_checks_green atoms are now probe-backed: enqueue what has no
        // probe yet (dedup, attempt-capped, paced), retry failed ones on
        // backoff, and keep the card parked (drain-silent — the typed hold
        // already classifies it external) until a verdict lands. A verified
        // verdict re-enters the standard path: every-atom-true flips below
        // (BR#4282 owned done-close / unblock spawn); a conclusive negative
        // or an exhausted probe stamps honestly and never flips.
        const probeStates = results.filter((x) => x.probeState && x.probeState !== "negative");
        if (probeStates.length) {
          for (const x of probeStates) this.enqueueProxyProbe(x.atom, r.id, now);
          const exhausted = probeStates.some((x) => x.probeState === "exhausted");
          if (exhausted) {
            // the probe burned its attempts — back to the loud pre-BR#4658
            // state (unresolvable), receipts intact on the stamp
            this.stampProxyCheck(r.id, meta, now, "unresolvable",
              "worker-executor verification probe exhausted — the sweep cannot read this gate (BR#3516); verify first-hand", prev,
              { atoms: results.map((x) => ({ raw: x.atom.raw, ok: x.ok, receipt: x.receipt })) });
            continue;
          }
          this.stampProxyCheck(r.id, meta, now, "probe_pending", null, prev,
            { atoms: results.map((x) => ({ raw: x.atom.raw, ok: x.ok, receipt: x.receipt })) });
          continue;
        }
        // conjunction law (the parser's own contract): EVERY atom must hold
        // before the flip — a park on "A done AND B done" must not fire on A
        // alone (BR#3986: the pre-fix parser made this moot by truncating to
        // the first atom; with all atoms collected, all must evaluate TRUE).
        if (!results.every((x) => x.ok)) {
          this.stampProxyCheck(r.id, meta, now, "false", null, prev,
            { atoms: results.map((x) => ({ raw: x.atom.raw, ok: x.ok, receipt: x.receipt })) });
          continue;
        }
        // the flip: spawn the unblock duty (the machine's caps still apply)
        await this.spawnProxyDuty(r, meta, now, prev, cond, results.map((x) => `"${x.atom.raw}" → ${x.receipt}`));
      } catch (e) {
        this.audit("hub:proxy-watch", "sweep_error", r.id, { error: String((e as Error).message ?? e).slice(0, 300) });
      }
    }
    // BR#4416 post-pass: file the ONE class ask (if rung 4 fired), emit the
    // prose_blocked_count canary, and arm the population alarm when the
    // count is nonzero after the BR#4248 generator-kill has deployed.
    await this.prosePassEmit(prose, now);
  }

  /** BR#4416 post-pass emission: the class ask, the prose_blocked_count
   *  settings row + audit line (board health, visible in /stats), and the
   *  one-per-episode population alarm at the sink. */
  private async prosePassEmit(
    prose: { flip: number; restore: number; release: number; escalate: number; prose: number; classCards: { id: string; title: string; fact: string }[] },
    now: number,
  ): Promise<void> {
    // ---- the ONE class ask (rung 4), deduped by stamp + identical-open guard
    if (prose.classCards.length > 0) {
      const classKey = `prose_migration_${PROSE_CLASS_AMBIGUOUS}`;
      const last = Number(this.settingValue(classKey, "0")) || 0;
      if (now - last >= PROSE_CLASS_QUIET_MS) {
        try {
          const ask = await this.askCreate(
            {
              to: "ray",
              question: proseClassAskTitle(prose.classCards.map((c) => c.id)),
              reason: `these ${prose.classCards.length} blocked card(s) are parked on pure prose with no machine leg anywhere in their state, and they are runner/human-owned — the sweep may not re-scope them; ONE ask covers the class (BR#4416, never one per card)`,
              details: [
                ...prose.classCards.map((c) => `- ${c.id} "${c.title}" — ${c.fact}`),
                ``,
                `Grammar for a RE-SCOPE (closed set): ${AWAIT_GRAMMAR_DOC}`,
              ].join("\n"),
              options: [
                "RE-SCOPE — I'll rewrite each card's resume condition as a checkable event",
                "RELEASE — send these cards back to the pool unchanged",
                "SUPERSEDE — drop the named cards",
              ],
              artefact_id: prose.classCards[0].id,
            },
            "hub:proxy-watch",
          );
          this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('${classKey}', ?)`, String(now));
          // stamp every class card with the ask as its typed leg — they leave
          // the prose population the moment the ask exists (the answer owns
          // the exit, exactly like a bound ask).
          for (const c of prose.classCards) {
            try {
              const row = this.one(`SELECT meta FROM artefacts WHERE id = ?`, c.id) as any;
              if (!row?.meta) continue;
              const meta = JSON.parse(row.meta);
              meta.blocked = { ...(meta.blocked ?? {}), await_event: { event: "ask", ask_id: ask.id } };
              this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), c.id);
              this.audit("hub:proxy-watch", "prose_class_ask_stamp", c.id, { ask: ask.id });
            } catch { /* the typed path re-reads meta next pass anyway */ }
          }
        } catch (e) {
          // an identical ask is already open for this class — that IS one per class
          this.audit("hub:proxy-watch", "prose_class_ask_deduped", prose.classCards[0].id, { detail: String((e as Error).message ?? e).slice(0, 200) });
        }
      }
    }
    // ---- the canary: every pass emits prose_blocked_count (board health)
    const report = {
      ts: now,
      prose_blocked: prose.prose,
      auto_flipped: prose.flip,
      auto_restored: prose.restore,
      released_todo: prose.release,
      class_escalations: prose.escalate,
    };
    try {
      this.state.storage.sql.exec(
        `INSERT OR REPLACE INTO settings (key, value) VALUES ('prose_blocked_count', ?)`,
        JSON.stringify(report),
      );
    } catch { /* best-effort: the audit line still carries the tally */ }
    this.audit("hub:proxy-watch", "prose_sweep", "watchdog", report);
    // ---- the population alarm: prose parks AFTER the BR#4248 generator-kill
    //      (PR #275) has merged AND deployed = incident, one per episode.
    if (prose.prose > 0) await this.proseAlarmIfArmed(prose, now);
  }

  /** BR#4416 population alarm: prose_blocked_count > 0 after BR#4248 deploys
   *  is an incident — ONE alarm at the sink naming the cards + the writer
   *  each card's state names, deduped per episode. Never per-card asks: the
   *  count is a canary, not an inbox. */
  private async proseAlarmIfArmed(
    prose: { prose: number; classCards: { id: string; title: string; fact: string }[] },
    now: number,
  ): Promise<void> {
    const prov = this.one(`SELECT merge_sha FROM provenance WHERE repo = ? AND pr = ?`, "state-vector/bridge", 275) as any;
    if (!prov?.merge_sha) return; // generator-kill not merged yet — the ladder is draining the pre-deploy backlog
    let deployed = false;
    try {
      const v = (await import("../__version.json")) as { commit?: string };
      deployed = deployedSatisfied(String(v.commit ?? ""), String(prov.merge_sha));
    } catch { deployed = false; }
    if (!deployed) return; // merged but not deployed: the drain continues, no incident yet
    const last = Number(this.settingValue("prose_alarm_ts", "0")) || 0;
    if (now - last < PROSE_CLASS_QUIET_MS) return; // one alarm per episode per day
    const summaries = this.proseAlarmSummaries();
    try {
      await this.askCreate(
        {
          to: "human",
          question: proseAlarmAskTitle(summaries),
          reason: `prose_blocked_count=${prose.prose} after the BR#4248 generator-kill deployed — a writer is still minting prose parks (the population canary, BR#4416); this is the ONE class alarm, not per-card asks`,
          details: summaries.length
            ? `Cards still parked on unparseable prose with no machine leg, and the writer each card's own state names:\n${summaries.map((s) => `- ${s}`).join("\n")}`
            : `prose_blocked_count=${prose.prose} this pass; per-card detail rides the prose_check audit lines.`,
          options: [
            "Investigating — will find and fix the writer",
            "Known backlog — draining manually",
            "False positive — these cards have legs",
          ],
          artefact_id: this.settingValue("train_alarm_sink_id", TRAIN_ALARM_SINK_ID),
          urgency: "time-sensitive",
        },
        "hub:proxy-watch",
      );
      this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('prose_alarm_ts', ?)`, String(now));
    } catch (e) {
      // an identical alarm is already open for this episode — that IS once
      this.audit("hub:proxy-watch", "prose_alarm_deduped", "watchdog", { detail: String((e as Error).message ?? e).slice(0, 200) });
    }
  }

  /** Per-card summaries for the alarm: card id + the writer its own state
   *  names (meta.session) + why it is still prose. Board-local reads only. */
  private proseAlarmSummaries(): string[] {
    const rows = this.state.storage.sql.exec(
      `SELECT id, title, meta FROM artefacts WHERE type = 'task' AND status = 'blocked'`,
    ).toArray() as any[];
    const out: string[] = [];
    for (const r of rows) {
      try {
        const meta = JSON.parse(r.meta ?? "{}");
        const bmeta = meta.blocked ?? {};
        if (validateAwaitEvent(bmeta.await_event)) continue; // typed — not prose
        const cond = String(bmeta.unblock_condition ?? "").trim();
        if (!cond) continue;
        if (!this.recoverProseLegs(String(r.id), meta).length)
          out.push(`${r.id} "${String(r.title ?? "").slice(0, 60)}" (writer: ${String(meta.session ?? "unknown")}; condition: "${cond.slice(0, 80)}")`);
      } catch { /* skip malformed */ }
    }
    return out;
  }

  /** BR#3578 typed ask/time legs, evaluated first-class: an answered ask or
   *  an elapsed timer flips exactly like a machine atom (spawn the duty; the
   *  duty re-verifies first-hand). Shared by the typed-`await_event` path and
   *  BR#4062's prose-derived migration — these board-local legs are exactly
   *  the ones the GitHub-atom evaluator cannot read. */
  private async evalTypedAskTimeLeg(
    r: any, meta: any, aw: AwaitEvent, cond: string, now: number, prev: any,
  ): Promise<void> {
    if (aw.event === "time") {
      if (now < aw.until_ts) {
        this.stampProxyCheck(r.id, meta, now, "waiting", `timer until ${new Date(aw.until_ts).toISOString()}`, prev);
        return;
      }
      await this.spawnProxyDuty(r, meta, now, prev, cond,
        [`timer elapsed (until_ts ${aw.until_ts}, checked ${new Date(now).toISOString()})`]);
      return;
    }
    // narrowed: the ask leg — an OPEN ask waits; answered/superseded/vanished fires
    if (aw.event !== "ask") return; // machine-event legs never route here (guarded by the callers)
    const a = this.one(`SELECT status FROM artefacts WHERE id = ?`, aw.ask_id);
    if (a && a.status !== "done" && a.status !== "superseded") {
      this.stampProxyCheck(r.id, meta, now, "waiting", `awaiting ask ${aw.ask_id}`, prev);
      return;
    }
    await this.spawnProxyDuty(r, meta, now, prev, cond, [`${describeAwaitEvent(aw)} → ask ${aw.ask_id} answered/closed`]);
  }

  // ---------- prose-card disposition ladder (BR#4416) ----------

  /** BR#4416 rung-1/2 leg recovery from the card's OWN machine state — never
   *  from re-parsing the prose (the prose already failed to parse; that is
   *  why this code is running). Precedence: bound ask > PR leg (train stamp,
   *  meta.pr, meta.prs) > open root blocker. A self-referential root is
   *  skipped (the BR#136 deadlock law). Zero GitHub calls. */
  private recoverProseLegs(id: string, meta: any): ProseLeg[] {
    const legs: ProseLeg[] = [];
    const seen = new Set<string>();
    const push = (leg: ProseLeg) => {
      const target =
        leg.kind === "pr_merged" ? `${leg.repo}#${leg.n}`
        : leg.kind === "ask" ? leg.ask_id
        : leg.kind === "br_done" ? leg.id
        : String(leg.until_ts);
      const key = `${leg.kind}|${target}`;
      if (seen.has(key)) return;
      seen.add(key);
      legs.push(leg);
    };
    const askId = String(meta.awaiting_ask?.ask_id ?? meta.blocked?.await_migration_ask ?? "").trim();
    if (askId) push({ kind: "ask", ask_id: askId });
    const mt = (meta.merge_train ?? {}) as Record<string, unknown>;
    if (Number(mt.pr ?? 0) > 0 && typeof mt.repo === "string" && mt.repo)
      push({ kind: "pr_merged", repo: String(mt.repo), n: Number(mt.pr) });
    const mpr = meta.pr as Record<string, unknown> | undefined;
    if (mpr && Number(mpr.number ?? 0) > 0 && typeof mpr.repo === "string" && mpr.repo)
      push({ kind: "pr_merged", repo: String(mpr.repo), n: Number(mpr.number) });
    for (const p of Array.isArray(meta.prs) ? meta.prs : []) {
      const l = p as Record<string, unknown>;
      if (l && typeof l.repo === "string" && l.repo && Number(l.number ?? 0) > 0)
        push({ kind: "pr_merged", repo: String(l.repo), n: Number(l.number) });
    }
    const root = String(meta.root_blocker ?? "").trim();
    if (root && root !== id && /^BR#\d+$/.test(root)) push({ kind: "br_done", id: root });
    return legs;
  }

  /** BR#4416 board-local verdict for one recovered leg — ZERO GitHub calls
   *  (BR#3287: the provenance/train ledger is the merge proof; asks and card
   *  states are SQL reads; a vanished ask fires, same law as
   *  evalTypedAskTimeLeg). */
  private async evalProseLeg(leg: ProseLeg): Promise<ProseLegVerdict> {
    switch (leg.kind) {
      case "ask": {
        const a = this.one(`SELECT status FROM artefacts WHERE id = ?`, leg.ask_id);
        if (!a) return { leg, ok: true, receipt: `ask ${leg.ask_id} no longer on the board — nothing left to wait for` };
        const done = a.status === "done" || a.status === "superseded";
        return { leg, ok: done, receipt: done ? `ask ${leg.ask_id} ${a.status} — the answer is in` : `ask ${leg.ask_id} still ${a.status}` };
      }
      case "pr_merged": {
        const prov = this.one(`SELECT merge_sha FROM provenance WHERE repo = ? AND pr = ?`, leg.repo, leg.n) as any;
        if (prov?.merge_sha)
          return { leg, ok: true, receipt: `provenance ledger: ${leg.repo}#${leg.n} merged as ${String(prov.merge_sha).slice(0, 9)} (BR#3287)` };
        const ev = this.one(`SELECT seq FROM train_events WHERE repo = ? AND pr = ? AND kind = 'merged' LIMIT 1`, leg.repo, leg.n);
        if (ev) return { leg, ok: true, receipt: `train ledger: ${leg.repo}#${leg.n} has a merged event` };
        return { leg, ok: false, receipt: `${leg.repo}#${leg.n} has no provenance/train-ledger merge row — not merged as far as the board knows` };
      }
      case "br_done": {
        const row = this.one(`SELECT status FROM artefacts WHERE id = ?`, leg.id);
        if (!row) return { leg, ok: false, receipt: `${leg.id} not found on this board` };
        const done = row.status === "done" || row.status === "superseded";
        return { leg, ok: done, receipt: `${leg.id} status=${row.status}` };
      }
      case "time":
        return { leg, ok: Date.now() >= leg.until_ts, receipt: `timer until ${new Date(leg.until_ts).toISOString()}` };
    }
  }

  /** BR#4416 rung-3 restriction: the sweep may not release this card to the
   *  pool — runner/human-owned, or a scope a human qualified. Supersede-vs-
   *  continue on such a card is a genuine human ruling (rung 4), not the
   *  churn guard's park (rung 3). Knob: `prose_protected_owners` (CSV). */
  private proseReleaseRestricted(meta: any): boolean {
    const csv = this.settingValue("prose_protected_owners", "opencode-ray,ip-172-31-1-230-opencode");
    const protectedOwners = csv.split(",").map((s) => s.trim()).filter(Boolean);
    const isProtected = (v: unknown) => {
      const s = String(v ?? "").trim();
      if (!s) return false;
      return protectedOwners.some((p) => s === p || s.startsWith(`${p}/`));
    };
    const q = (meta.qualification ?? {}) as Record<string, unknown>;
    return isProtected(meta.owner) || (String(q.state ?? "") === "qualified" && isProtected(q.by));
  }

  /** BR#4416: the ladder itself — decides one no-atom park from the card's
   *  OWN machine state and acts. (1) provably true → the card's own promised
   *  exit fires (spawnProxyDuty; NO ask); (2) a typed leg is recoverable →
   *  restore meta.blocked.await_event (NO ask); (3) no leg → release to todo
   *  for re-scope (NO ask); (4) genuine ambiguity on a protected card → the
   *  ONE per-day class ask (filed post-pass so it names the whole class).
   *  Pure table: decideProseDisposition (pinned in machine.test.ts). */
  private async proseLadder(
    r: any, meta: any, cond: string, now: number, prev: any, unparseable: boolean,
    prose: { flip: number; restore: number; release: number; escalate: number; prose: number; classCards: { id: string; title: string; fact: string }[] },
  ): Promise<void> {
    const id = String(r.id);
    const verdicts: ProseLegVerdict[] = [];
    for (const leg of this.recoverProseLegs(id, meta)) verdicts.push(await this.evalProseLeg(leg));
    const classKey = `prose_migration_${PROSE_CLASS_AMBIGUOUS}`;
    const lastRaw = this.settingValue(classKey, "");
    const d = decideProseDisposition({
      cardId: id,
      title: String(r.title ?? id),
      now,
      legs: verdicts,
      releaseRestricted: this.proseReleaseRestricted(meta),
      lastClassAskTs: lastRaw ? Number(lastRaw) || null : null,
      classAskQuietMs: PROSE_CLASS_QUIET_MS,
    });
    switch (d.kind) {
      case "flip": {
        prose.flip++;
        await this.spawnProxyDuty(r, meta, now, prev, cond, [
          `${d.receipt} — BR#4416 rung 1: the machine-stamped leg already holds; the exit fires per the card's own promise, no ask filed`,
        ]);
        break;
      }
      case "restore": {
        prose.restore++;
        meta.blocked = { ...(meta.blocked ?? {}), await_event: d.await_event };
        this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), id);
        this.stampProxyCheck(id, meta, now, "waiting", `BR#4416 rung 2: typed leg restored (${describeAwaitEvent(d.await_event)}) — ${d.receipt}`, prev);
        this.audit("hub:proxy-watch", "prose_restore", id, { leg: d.leg, receipt: d.receipt });
        break;
      }
      case "release": {
        prose.release++;
        const attempts = Number(meta.attempt?.attempts ?? 0);
        const churn = attempts
          ? ` Churn context: ${attempts} prior release(s), last: ${String(meta.attempt?.last_reason ?? "").slice(0, 160)}.`
          : "";
        try {
          await this.transition({
            id, to: "todo", session: "",
            note: `BR#4416 prose ladder rung 3: parked on pure prose (proxy_check no_atoms) with no machine leg anywhere in card state — released to the pool for re-scope per the BR#3578 no-leg law.${churn} Re-block ONLY with a typed await — the grammar is a closed set: ${AWAIT_GRAMMAR_DOC}`,
          }, "system:proxy-watch"); // system:* = OWNER_RELEASE_EXEMPT (machinery); the release-hold backstop still gated typed-wait holds
          this.audit("hub:proxy-watch", "prose_release", id, { reason: d.reason });
        } catch (e) {
          // release refused at a gate — the park stands; count it so the canary sees it
          prose.prose++;
          this.audit("hub:proxy-watch", "prose_release_refused", id, { error: String((e as Error).message ?? e).slice(0, 200) });
        }
        break;
      }
      case "escalate_class": {
        prose.escalate++;
        prose.classCards.push({
          id,
          title: String(r.title ?? id).slice(0, 120),
          fact: `parked on: "${cond.slice(0, 160)}"; PR state: ${meta.pr && Number((meta.pr as any).number ?? 0) > 0 ? `${String((meta.pr as any).repo)}#${Number((meta.pr as any).number)}` : Array.isArray(meta.prs) && meta.prs.length ? JSON.stringify(meta.prs).slice(0, 80) : "none in card state"}; park line: ${String(meta.blocked?.reason ?? "").slice(0, 120) || "n/a"}; writer: ${String(meta.session ?? "unknown")}`,
        });
        this.stampProxyCheck(id, meta, now, unparseable ? "unparseable" : "no_atoms",
          unparseable ? "condition mentions machine state but no atom parsed — rung-4 class ask collects it (BR#4416)" : "no machine atoms — rung-4 class ask collects it (BR#4416)", prev);
        break;
      }
      case "waiting": {
        // inside the class-ask quiet window (or a concurrent pass holds it):
        // still prose until the ask lands — the canary sees it
        prose.prose++;
        this.stampProxyCheck(id, meta, now, "waiting", `BR#4416: ${d.receipt}`, prev);
        break;
      }
    }
  }

  /** BR#3361a / BR#3578: the flip — the exit condition held TRUE; spawn the
   *  unblock duty with the receipts embedded. Shared by atom flips and
   *  ask/time timer fires. Machine caps still apply: ≤1 open unblock child,
   *  flood guard on identical exit conditions. */
  /** Spawner cap (BR#2893): a blocked parent has spawned at most
   *  UNBLOCK_SPAWN_CAP unblock duties EVER — past that the spawner stops and
   *  escalates ONCE (flag-guarded), so the human ledger carries the recurring
   *  block instead of the pool. Counts both child generations (roles-based
   *  machine spawns and the pre-refactor tags-based ones). Returns true when
   *  the spawn must be skipped (cap reached; escalation stamped first hit). */
  private unblockSpawnCapped(r: { id: string }, meta: any, actor: string, ts: number): boolean {
    const roundsEver = this.one(
      `SELECT COUNT(*) AS n FROM relations rel JOIN artefacts c ON c.id = rel.src_id
       WHERE rel.relation = 'child_of' AND rel.dst_id = ? AND (c.roles LIKE '%"unblock"%' OR c.tags LIKE '%"role:unblock"%')`, r.id,
    )?.n ?? 0;
    if (roundsEver < UNBLOCK_SPAWN_CAP) return false;
    if (!meta.unblock_escalated) {
      meta.unblock_escalated = { at: ts, rounds: roundsEver };
      meta.escalate = {
        at: ts,
        attempts: roundsEver,
        reason: `${roundsEver} unblock rounds spawned for this block and none cleared it — the spawner stopped (cap ${UNBLOCK_SPAWN_CAP}, BR#2893). Human: resolve the recurring block directly (re-scope, supersede, or land the fix), or clear this escalation to re-arm the spawner.`,
      };
      this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), r.id);
      this.audit("system:unblock-spawner", "escalated", r.id, { rounds: roundsEver, cap: UNBLOCK_SPAWN_CAP });
      this.version(r.id, "system:unblock-spawner", "transition", `unblock spawner stopped — ${roundsEver} rounds failed to clear the block; escalated to human once`, { rounds: roundsEver });
    } else {
      // BR#4702: a cap RE-suppression is the guard working — the escalation
      // already carries the recurring block to the human ledger, and the
      // parent is re-evaluated on every sweep/park tick while it stays
      // un-cleared. Audit observably, never fold a breach card: the fold
      // raising spawn-while-open on the guard's own suppression is the same
      // detection-noise class BR#4282 fixed for the flood guard (specimen
      // BR#3633: steady-true atom, breach card per sweep tick on top of a
      // standing escalation).
      this.audit(actor, "spawn_cap_skipped", r.id, { auto: "unblock", reason: `unblock spawner cap (${roundsEver} rounds, cap ${UNBLOCK_SPAWN_CAP}) — escalation already filed` });
    }
    return true;
  }

  private async spawnProxyDuty(
    r: any, meta: any, now: number, prev: any, cond: string, receiptLines: string[],
  ): Promise<void> {
    const openChild = this.one(
      `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
         AND c.roles LIKE '%"unblock"%' ORDER BY c.updated_ts DESC LIMIT 1`, r.id,
    );
    const lastSpawn = meta.last_unblock_spawn;
    // same flood law as the machine's own spawn (machine.ts): only the
    // SAME exit condition within the window floods — a block-time round
    // with this exact condition is already on the case; a later flip
    // past the window spawns a fresh round (the BR#3129 story: the flip
    // came ~20h after the park-time round)
    const flooded =
      lastSpawn && typeof lastSpawn.at === "number" && now - lastSpawn.at < UNBLOCK_FLOOD_MS &&
      String(lastSpawn.exit ?? "") === cond;
    if (openChild || flooded) {
      this.stampProxyCheck(r.id, meta, now, "true", null, prev,
        { spawned: openChild?.id ?? null, spawn_skipped: openChild ? `existing unblock child ${openChild.id}` : "flood guard" });
      if (prev?.verdict !== "true") {
        this.audit("hub:proxy-watch", "proxy_flip_deferred", r.id, { spawned: openChild?.id ?? null, reason: openChild ? "existing unblock child" : "flood guard" });
      }
      return;
    }
    // BR#3668 stale-true dedup: re-fire only on a CHANGED receipt. The last
    // duty this parent spawned carries the receipt set its spawn was fired
    // on (the body's "MACHINE PROXY … receipts:" block); if the fresh
    // evaluation produced the identical set, the atom is steady-true — it
    // never flipped, and a re-spawn is pure churn (the BR#3358 family: one
    // stand-down duty per sweep cycle, each live-verifying the same
    // non-flip). Only sweep-spawned duties carry the block, so a park-time
    // round or close-leg duty as the newest child never dedups; and the
    // guard sits AFTER the flood window, so a genuine flip that arrives
    // after the window spawns exactly once (the BR#3129 story).
    const lastChild = this.one(
      `SELECT c.id AS id, c.body_md AS body FROM relations rel JOIN artefacts c ON c.id = rel.src_id
       WHERE rel.relation = 'child_of' AND rel.dst_id = ? AND c.roles LIKE '%"unblock"%'
       ORDER BY c.created_ts DESC LIMIT 1`, r.id,
    );
    const firedReceipts = lastChild ? proxySpawnReceipts(String(lastChild.body ?? "")) : [];
    if (lastChild && firedReceipts.length && sameProxyReceipts(firedReceipts, receiptLines)) {
      this.stampProxyCheck(r.id, meta, now, "true", null, prev,
        { spawned: lastChild.id, spawn_skipped: `receipt-identical to the ${lastChild.id} spawn — steady-true atom, no changed receipt since last fire (BR#3668 dedup)` });
      if (prev?.verdict !== "true") {
        this.audit("hub:proxy-watch", "proxy_flip_deferred", r.id, { spawned: lastChild.id, reason: "stale-true dedup (BR#3668): identical receipts" });
      }
      return;
    }
    const ts = Date.now();
    // BR#2893 spawner cap: UNBLOCK_SPAWN_CAP rounds ever → stop + escalate once.
    if (this.unblockSpawnCapped(r, meta, "hub:proxy-watch", ts)) {
      this.stampProxyCheck(r.id, meta, now, "true", null, prev, { spawn_skipped: `unblock spawner cap (${UNBLOCK_SPAWN_CAP} rounds)` });
      return;
    }
    const rootTitle = String(r.title ?? r.id).replace(/^(?:Unblock:\s*)+/, "");
    const atomLines = receiptLines.map((l) => `- ${l}`).join("\n");
    const created = await this.create(
      {
        type: "task",
        title: `Unblock: ${rootTitle.slice(0, 190)}`,
        session: "", // session-less spawn: the closer stamps it when they claim
        body_md: `Unblock duty for ${r.id} — "${rootTitle}" (auto-spawned by the hub proxy-watch, BR#3361).\n\nBlocked why: ${String(meta.blocked?.reason ?? "").trim() || "see parent"}.\nExit condition: ${cond}\n\nMACHINE PROXY — the hub evaluated the exit condition TRUE at ${new Date(ts).toISOString()} (receipts):\n${atomLines}\n\nThe predicate the card parked on has flipped. Do the terminal work the card promised: execute the exit condition (live re-verify first — this sweep is a trigger, not an authority), transition ${r.id} → in_progress with the resolution note, then close yourself done citing these receipts (the done note itself must cite receipts — ${RECEIPTS_DOC}).\n\nBR#4282 — if the parent is NOT blocked (it is in_progress or in_review: the exit flipped while it worked or while it awaited verify), do NOT resume it — it owes only the done-close. Order matters: close YOURSELF done citing the receipts first (the done-open-children gate needs the child closed), then transition ${r.id} → done citing the same receipts.\n\nContract: if the live state does NOT hold (the sweep mis-read), record findings via log_progress and close yourself done with the findings — the done note still must cite receipts (the findings count: ${RECEIPTS_DOC}) — do NOT respawn an unblock task, do not leave yourself open.`,
        roles: ["unblock"],
      },
      "hub:proxy-watch",
    );
    this.state.storage.sql.exec(
      `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
      created.id, r.id, ts,
    );
    meta.last_unblock_spawn = { at: ts, exit: cond.slice(0, 500), receipts: receiptLines };
    this.stampProxyCheck(r.id, meta, now, "true", null, prev, { spawned: created.id, receipts: receiptLines });
    this.audit("hub:proxy-watch", "proxy_flip", r.id, { spawned: created.id, receipts: receiptLines });
    this.version(r.id, "hub:proxy-watch", "note", `machine proxy flipped TRUE — unblock duty ${created.id} auto-spawned (BR#3361)`, { spawned: created.id });
  }


  async eventsSince(since: number, limit: number) {
    // since=0 → the most recent window (newest first, returned oldest-first);
    // since>0 → incremental forward from the cursor.
    const rows = since > 0
      ? this.state.storage.sql.exec(
          `SELECT seq, ts, actor, op, artefact_id, detail FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
          since, limit,
        ).toArray()
      : this.state.storage.sql.exec(
          `SELECT seq, ts, actor, op, artefact_id, detail FROM events WHERE seq > 0 ORDER BY seq DESC LIMIT ?`,
          limit,
        ).toArray().reverse();
    const events = rows.map((e: any) => ({ ...e, detail: JSON.parse(e.detail ?? "{}") }));
    return { events, last_seq: events.length ? events[events.length - 1].seq : since };
  }

  async board() {
    // owner renders via the BR#4262 render-time join (principal at rest →
    // label on display); matching below stays on ids/meta, never owner text
    const tasks = this.state.storage.sql.exec(
      `SELECT a.id, a.type, a.title, a.status, ${OWNER_DISPLAY_SQL} AS owner, a.tags, a.roles, a.meta, a.body_md, a.status_ts, a.created_ts, a.updated_ts, a.project
       FROM artefacts a
       WHERE a.type IN ('task','question') ORDER BY a.updated_ts DESC LIMIT 200`,
    ).toArray().map((t: any) => ({ ...t, meta: JSON.parse(t.meta ?? "{}"), tags: parseTags(t.tags), roles: parseTags(t.roles) }));
    // flat structure, relations only: child tasks carry part_of, parents get a rollup
    const links = this.state.storage.sql.exec(
      `SELECT src_id, dst_id FROM relations WHERE relation = 'child_of'`,
    ).toArray();
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const parentOf = new Map(links.map((l: any) => [l.src_id, l.dst_id]));
    for (const t of tasks) {
      const parent = parentOf.get(t.id);
      if (parent) t.part_of = parent;
      t.children_open = 0;
      t.children_done = 0;
    }
    for (const l of links as any[]) {
      const parent = byId.get(l.dst_id);
      const child = byId.get(l.src_id);
      if (!parent || !child) continue;
      if (child.status === "done" || child.status === "superseded") parent.children_done++;
      else parent.children_open++;
    }
    // readiness projection (bulk): declared state + evidence maps + stacked bars
    const { analysisEv, reviewEv } = this.qualificationEvidence();
    for (const t of tasks) {
      const q = t.meta.qualification ?? {};
      const declared = q.state ?? (t.meta.qualified === true ? "qualified" : undefined);
      const bars: string[] = q.bars ?? [];
      const parent = t.part_of ? byId.get(t.part_of) : null;
      const pq = parent ? (parent.meta.qualification ?? {}) : {};
      const analysisOk = declared === "qualified"
        || analysisEv.has(t.id)
        || (parent && (pq.state === "qualified" || parent.meta.qualified === true || analysisEv.has(parent.id))) === true;
      const unmet = this.enforceableBars(bars).filter((b) => !(/review/.test(b) ? reviewEv : analysisEv).has(t.id));
      t.qualification = { state: declared ?? (analysisOk ? "qualified" : "open"), how: q.how, by: q.by, bars, unmet_bars: unmet, ready: analysisOk && unmet.length === 0 };
      // claimability projection — same semantics as orient's pool: question
      // tasks and operator gates are never dispatchable; role-tagged tasks
      // dispatch via their gateway; the rest needs qualification evidence.
      const tagsArr: string[] = t.tags ?? [];
      const roleTagged = (t.roles ?? []).some((x: string) => ["analysis", "review", "impl", "unblock"].includes(x));
      const isQ = t.type === "question";
      const gated = t.meta.operator_gated;
      const roleWorkReady = roleTagged && t.qualification.ready !== false ? true : roleTagged;
      t.is_claimable = t.status === "todo" && !isQ && !gated && (roleWorkReady || t.qualification.ready !== false);
      if (!t.is_claimable && t.status === "todo") {
        t.claim_reason = isQ
          ? "question — answered, not claimed (contribute via log_progress)"
          : gated
            ? `operator gated: ${gated} — a human clears the gate`
            : roleTagged ? "" : "needs qualification — a done analysis child, an accepted decision, or the publisher's declaration";
      }
    }
    const sessions = this.state.storage.sql.exec(
      `SELECT s.token_id, s.name, s.worktree, s.first_seen_ts, s.last_seen_ts, t.label
       FROM sessions s LEFT JOIN auth_tokens t ON t.id = s.token_id ORDER BY s.last_seen_ts DESC LIMIT 100`,
    ).toArray();
    // open question children: the DERIVED source for awaiting_ask (phase 4 —
    // the marker was a second source of truth that could drift)
    const openAskChildren = this.state.storage.sql.exec(
      `SELECT r.dst_id AS parent, c.id AS id, c.created_ts AS created_ts, c.meta AS cmeta
       FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND c.status IN ('todo','in_progress','blocked')
         AND c.type = 'question'
       ORDER BY c.created_ts DESC`,
    ).toArray();
    const askChildOf = new Map<string, any>();
    for (const c of openAskChildren as any[]) {
      if (!askChildOf.has(c.parent)) askChildOf.set(c.parent, c);
    }
    const progress = this.state.storage.sql.exec(
      `SELECT seq, ts, actor, artefact_id, detail FROM events
       WHERE op = 'progress' ORDER BY seq DESC LIMIT 120`,
    ).toArray().map((e: any) => ({ ...e, detail: JSON.parse(e.detail ?? "{}") }));
    const series = this.state.storage.sql.exec(
      `SELECT artefact_id, ts, actor, data FROM artefact_versions
       WHERE action = 'progress' ORDER BY seq DESC LIMIT 400`,
    ).toArray().map((v: any) => {
      const d = JSON.parse(v.data ?? "{}");
      return { artefact_id: v.artefact_id, ts: v.ts, actor: v.actor, ...d };
    });
    // BR#3942 — ask rows carry their addressee's presence so the human
    // planes can show "asked to X (offline, N min ago)" without any new
    // permission: the board payload is the ask band's only data source.
    for (const t of tasks) {
      if (t.type === "question" && t.meta?.ask && ["todo", "in_progress", "blocked"].includes(t.status)) {
        t.ask_target = this.askTargetPresence(String(t.meta.ask.to ?? ""), Date.now());
      }
    }
    return { tasks, sessions, progress, series, agents: this.agentScores() };
  }

  /** Blocker rollup (BR#2645): cluster the blocked cards by machine root key
   *  (rollup.ts) and execute the plan — create ONE boosted ROOT BLOCKER task
   *  per qualifying cluster (≥3 members, no open root for the key), stamp the
   *  queued cards (meta.root_blocker + child_of → board tree + boost cascade).
   *  Idempotent: the plan only stamps cards whose pointer changed, so a re-run
   *  creates no duplicates. Roots close only by agent/human with receipts;
   *  done roots are never reused — a later cluster opens a fresh root. */
  private async rootBlockerRollup(now: number): Promise<{ created: string[]; stamped: number }> {
    const blockedRows = this.state.storage.sql.exec(
      `SELECT id, title, meta FROM artefacts WHERE type = 'task' AND status = 'blocked'`,
    ).toArray() as any[];
    const cards = blockedRows.map((r) => {
      const meta = JSON.parse(r.meta ?? "{}");
      return { id: r.id, title: r.title, blocked: meta.blocked ?? null, root_blocker: meta.root_blocker ?? null };
    });
    const rootRows = this.state.storage.sql.exec(
      `SELECT id, status, meta FROM artefacts WHERE type = 'task' AND tags LIKE ?`,
      `%"${ROOT_BLOCKER_TAG}"%`,
    ).toArray() as any[];
    const roots = rootRows.map((r) => ({ id: r.id, status: r.status, root_key: JSON.parse(r.meta ?? "{}").root_key ?? null }));
    const plan = planRootBlockers(cards, roots);
    const created: string[] = [];
    if (plan.creates.length || plan.stamps.length) {
      const keyToRoot = new Map<string, string>();
      for (const c of plan.creates) {
        try {
          const members = cards.filter((x) => c.members.includes(x.id));
          const res: any = await this.create(
            {
              type: "task",
              title: rootBlockerTitle(c.key, c.members.length),
              body_md: rootBlockerBody(c.key, members),
              tags: [ROOT_BLOCKER_TAG],
              // the sweep HAS analysed the cluster — the root is ready for pickup
              qualified: true,
              meta: { root_key: c.key },
            },
            "system:watchdog",
          );
          if (res?.id) { keyToRoot.set(c.key, res.id); created.push(res.id); }
          this.audit("system:watchdog", "root_blocker_created", res?.id ?? null, { key: c.key, members: c.members });
        } catch (e) {
          this.audit("system:watchdog", "sweep_error", `root_blocker:${c.key}`, { error: String((e as Error).message ?? e).slice(0, 300) });
        }
      }
      let stamped = 0;
      for (const s of plan.stamps) {
        try {
          const rootId = s.root ?? keyToRoot.get(s.root_key);
          if (!rootId) continue;
          const row = this.one(`SELECT meta FROM artefacts WHERE id = ?`, s.id);
          if (!row) continue;
          const meta = JSON.parse(row.meta ?? "{}");
          if (meta.root_blocker === rootId) continue; // stamp only when changed
          meta.root_blocker = rootId;
          this.state.storage.sql.exec(
            `UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`,
            JSON.stringify(meta), now, s.id,
          );
          // child_of → board tree + boost cascade. Best-effort: the nesting
          // cap and relation limits can reject; the stamp alone still counts.
          const linked = this.one(
            `SELECT 1 AS x FROM relations WHERE src_id = ? AND relation = 'child_of' AND dst_id = ?`,
            s.id, rootId,
          );
          if (!linked) {
            try {
              await this.link({ src: s.id, relation: "child_of", dst: rootId }, "system:watchdog");
            } catch (e) {
              this.audit("system:watchdog", "rollup_link_rejected", s.id, { root: rootId, error: String((e as Error).message ?? e).slice(0, 200) });
            }
          }
          stamped++;
        } catch (e) {
          this.audit("system:watchdog", "sweep_error", s.id, { error: String((e as Error).message ?? e).slice(0, 300) });
        }
      }
      // boost the NEW roots — cascades to every linked open card (priority 0)
      for (const rootId of keyToRoot.values()) {
        try {
          await this.boost({ id: rootId, boost: true }, "system:watchdog");
        } catch (e) {
          this.audit("system:watchdog", "sweep_error", `boost:${rootId}`, { error: String((e as Error).message ?? e).slice(0, 300) });
        }
      }
      if (created.length || stamped) {
        this.audit("system:watchdog", "root_blocker_rollup", null, { created, stamped });
      }
      return { created, stamped };
    }
    return { created: [], stamped: 0 };
  }

  /** Behaviour signals per agent over the trailing 7-day window, scored via scoreAgent().
   *  Cached per-isolate (30s TTL) — it fans out to several table scans per call and
   *  runs on every board/orient/log_progress; uncached it eats the DO row-read quota. */
  private scoreCache: { at: number; rows: Array<{ label: string } & AgentSignals & ReturnType<typeof scoreAgent>> } | null = null;
  private agentScores(): Array<{ label: string } & AgentSignals & ReturnType<typeof scoreAgent>> {
    const now = Date.now();
    if (this.scoreCache && now - this.scoreCache.at < 30_000) return this.scoreCache.rows;
    const rows = this.computeAgentScores();
    this.scoreCache = { at: now, rows };
    return rows;
  }

  private computeAgentScores(): Array<{ label: string } & AgentSignals & ReturnType<typeof scoreAgent>> {
    // Scoring windows (BR#3226): positive behavioural signals accrue over a
    // 7-day window; watchdog penalties (abandonment, reassignment) are
    // point-in-time incidents that decay after 48h so a past incident does
    // not poison current behaviour scores (e.g. the 2026-10-22 outage era).
    const weekTs = Date.now() - 7 * 24 * 60 * 60_000;
    const recentTs = Date.now() - 48 * 60 * 60_000;
    const tokens = this.state.storage.sql.exec(
      `SELECT label, tags FROM auth_tokens WHERE revoked_ts IS NULL`,
    ).toArray() as any[];
    const signals = new Map<string, AgentSignals>();
    const sig = (label: string): AgentSignals => {
      let s = signals.get(label);
      if (!s) {
        s = { progress_count: 0, gauge_count: 0, thin_notes: 0, abandoned: 0, result_lost: 0, reassigned: 0, asks_received: 0, asks_answered_on_time: 0, artefacts_created: 0, verify_duty_backlog: 0 };
        signals.set(label, s);
      }
      return s;
    };
    for (const t of tokens) sig(t.label); // agents with no activity still get a row
    for (const p of this.state.storage.sql.exec(
      `SELECT actor, data FROM artefact_versions WHERE action = 'progress' AND ts >= ?`,
      weekTs,
    ).toArray() as any[]) {
      const s = sig(p.actor);
      const d = JSON.parse(p.data ?? "{}");
      s.progress_count++;
      if (d.completion_pct != null || d.confidence_pct != null || d.risk_pct != null) s.gauge_count++;
      if (String(d.note ?? "").trim().length < 10) s.thin_notes++;
    }
    // BR#3352: a watchdog release whose transition detail carries
    // result_class "completed_result_lost" is a delivery-channel incident
    // (the run happened, the report was lost) — it must not count as
    // abandonment. Every other watchdog transition still does.
    for (const r of this.state.storage.sql.exec(
      `SELECT a.owner AS owner, e.detail AS detail FROM events e JOIN artefacts a ON a.id = e.artefact_id
       WHERE e.op = 'transition' AND e.actor = 'system:watchdog' AND e.ts >= ?`,
      recentTs,
    ).toArray() as any[]) {
      const s = sig(r.owner || "unknown");
      let d: any = {};
      try { d = JSON.parse(r.detail ?? "{}"); } catch { d = {}; }
      if (d?.result_class === "completed_result_lost") s.result_lost++;
      else if (d?.result_class === PROXY_WAIT_HOLD_RESULT_CLASS) {
        // BR#4067: a hold-park preserves a machine wait (train queue slot /
        // typed await / bound ask) — it is neither an abandonment nor a lost
        // run, so no counter moves.
      }
      else if (d?.result_class === BOUNCE_REENTRY_DEMOTE_RESULT_CLASS) {
        // BR#4494: the bounce re-entry demote is a machine bounce + machine
        // release of a card whose executor was already gone — nobody
        // abandoned anything, so no counter moves.
      }
      else s.abandoned++;
    }
    for (const r of this.state.storage.sql.exec(
      `SELECT detail FROM events WHERE op = 'reassign' AND ts >= ?`, recentTs,
    ).toArray() as any[]) {
      const d = JSON.parse(r.detail ?? "{}");
      sig(d.prev_owner || "unknown").reassigned++;
    }
    for (const r of this.state.storage.sql.exec(
      `SELECT owner, COUNT(*) AS n FROM artefacts
       WHERE created_ts >= ? AND LENGTH(body_md) >= 200 AND owner != '' GROUP BY owner`,
      weekTs,
    ).toArray() as any[]) sig(r.owner).artefacts_created += r.n;
    for (const t of tokens) {
      const s = sig(t.label);
      const tags: string[] = parseTags(t.tags);
      const targets = ["any", t.label, ...tags.map((x: string) => `tag:${x}`)];
      const marks = targets.map(() => "?").join(",");
      s.asks_received = this.one(
        `SELECT COUNT(*) AS n FROM asks WHERE status IN ('open','answered') AND from_label != ?
         AND created_ts >= ? AND to_target IN (${marks})`, t.label, weekTs, ...targets,
      )?.n ?? 0;
      s.asks_answered_on_time = this.one(
        `SELECT COUNT(*) AS n FROM asks WHERE status = 'answered' AND answered_by = ? AND answered_ts IS NOT NULL
         AND answered_ts - created_ts <= ${30 * 60_000} AND created_ts >= ?`, t.label, weekTs,
      )?.n ?? 0;
      // verification duty backlog: role:review agents carry the pool's stalled
      // verify rounds — each one is an implementer parked in in_review.
      if (tags.includes("role:review")) {
        s.verify_duty_backlog = this.one(
          `SELECT COUNT(*) AS n FROM relations r JOIN artefacts c ON c.id = r.src_id JOIN artefacts p ON p.id = r.dst_id
           WHERE r.relation = 'child_of' AND c.type = 'task' AND c.status = 'todo' AND c.owner = ''
           AND c.roles LIKE '%"review"%' AND p.status = 'in_review'`,
        )?.n ?? 0;
      }
    }
    return [...signals.entries()]
      .filter(([label]) => !/^(system:|web$)/.test(label))
      .map(([label, s]) => ({ label, ...s, ...scoreAgent(s) }))
      .sort((a, b) => b.score - a.score);
  }

  private async getWithRelations(id: string) {
    const a = await this.get(id);
    const rel = await this.relations(id);
    return { ...a, relations: rel.relations };
  }

  async ensureSchema() {
    // NO early-return flag: this DO's isolate is long-lived, and a flag set
    // on first boot meant every migration added later NEVER ran on the warm
    // singleton — today's schema additions silently broke against production
    // while working on fresh local DBs. Everything here is idempotent by
    // construction (IF NOT EXISTS + guarded ALTERs); the per-fetch cost is a
    // few cheap statements.
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS artefacts (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        body_md TEXT NOT NULL DEFAULT '',
        meta TEXT NOT NULL DEFAULT '{}',
        owner TEXT NOT NULL DEFAULT '',
        created_ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relations (
        src_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        dst_id TEXT NOT NULL,
        created_ts INTEGER NOT NULL,
        PRIMARY KEY (src_id, relation, dst_id)
      );
      -- events: now a VIEW over ledger (migration below)
      CREATE VIRTUAL TABLE IF NOT EXISTS artefacts_fts USING fts5(
        title, body_md, content='artefacts', content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS artefacts_ai AFTER INSERT ON artefacts BEGIN
        INSERT INTO artefacts_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
      END;
      CREATE TRIGGER IF NOT EXISTS artefacts_ad AFTER DELETE ON artefacts BEGIN
        INSERT INTO artefacts_fts(artefacts_fts, rowid, title, body_md)
          VALUES ('delete', old.rowid, old.title, old.body_md);
      END;
      CREATE TRIGGER IF NOT EXISTS artefacts_au AFTER UPDATE ON artefacts BEGIN
        INSERT INTO artefacts_fts(artefacts_fts, rowid, title, body_md)
          VALUES ('delete', old.rowid, old.title, old.body_md);
        INSERT INTO artefacts_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
      END;
      CREATE TABLE IF NOT EXISTS auth_tokens (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL UNIQUE,
        hash TEXT NOT NULL UNIQUE,
        tags TEXT NOT NULL DEFAULT '[]',
        principal TEXT,
        transport TEXT NOT NULL DEFAULT 'mcp',
        created_ts INTEGER NOT NULL,
        last_seen_ts INTEGER,
        revoked_ts INTEGER,
        prev_hash TEXT,
        rotated_ts INTEGER,
        epoch INTEGER NOT NULL DEFAULT 1,
        repairs_count INTEGER NOT NULL DEFAULT 0,
        repairs_window_ts INTEGER
      );
      -- gateway → dispatched-agent attribution (BR#2455): stamped whenever a
      -- gateway-tagged token claims/progresses as an agent. Feeds Connect's
      -- "gateways with their agents" grouping; audit stays the full trail.
      CREATE TABLE IF NOT EXISTS gateway_agents (
        gateway TEXT NOT NULL,
        agent TEXT NOT NULL,
        last_seen_ts INTEGER NOT NULL,
        PRIMARY KEY (gateway, agent)
      );
      -- identity aliases (2026-10-29, Ray): a retired display name → the label
      -- it became. Machine/agent names churn with hostnames (macOS rotation,
      -- -2 suffixes, DHCP-IP hosts) — the PRINCIPAL is the identity anchor
      -- (BR#3787), so every rename records the old name here and display
      -- surfaces resolve through it instead of showing a pile of dead labels.
      CREATE TABLE IF NOT EXISTS identity_aliases (
        label TEXT PRIMARY KEY,
        canonical TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_id TEXT NOT NULL,
        name TEXT NOT NULL,
        first_seen_ts INTEGER NOT NULL,
        last_seen_ts INTEGER NOT NULL,
        UNIQUE (token_id, name)
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        slug TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        personal INTEGER NOT NULL DEFAULT 0,
        created_ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_members (
        ws TEXT NOT NULL,
        login TEXT NOT NULL,
        UNIQUE (ws, login)
      );
      CREATE TABLE IF NOT EXISTS ws_tokens (
        hash TEXT PRIMARY KEY,
        ws TEXT NOT NULL,
        created_ts INTEGER NOT NULL,
        principal TEXT
      );
      CREATE TABLE IF NOT EXISTS pairings (
        code TEXT PRIMARY KEY,
        device TEXT NOT NULL,
        type TEXT,
        principal TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        ws TEXT,
        label TEXT,
        tags TEXT,
        secret TEXT,
        created_ts INTEGER NOT NULL,
        approved_ts INTEGER,
        last_poll_ts INTEGER
      );
      CREATE TABLE IF NOT EXISTS embeddings (
        artefact_id TEXT PRIMARY KEY,
        vec BLOB NOT NULL,
        dim INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS provenance (
        -- PR provenance (BR#3287): sha → PR → task → verify-verdict → agent
        -- session. Board-side storage of record (decision BR#3291); this
        -- table is the DO-local index the lookup endpoint reads.
        repo TEXT NOT NULL,
        pr INTEGER NOT NULL,
        merge_sha TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        task_id TEXT,
        verdict_id TEXT,
        session TEXT,
        signer TEXT NOT NULL,
        merged_at INTEGER NOT NULL,
        stamped_at INTEGER NOT NULL,
        PRIMARY KEY (repo, pr)
      );
      CREATE TABLE IF NOT EXISTS train_events (
        -- merge train ledger (BR#3516/BR#3517): every lane op is
        -- executor-fed and hub-decided, so the ledger is the only durable
        -- record of what the train did and why. seq orders the train's
        -- causal chain per lane; provenance links merge_sha back to the
        -- sha→PR→task→verdict→session chain above.
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL, -- merged | bounced | stopped | landed | queued
        repo TEXT NOT NULL,
        base TEXT NOT NULL,
        gateway TEXT,
        pr INTEGER,
        task_id TEXT,
        merge_sha TEXT,
        head_sha TEXT,
        detail TEXT -- JSON: reason, carry record, verdict citations
      );
      CREATE INDEX IF NOT EXISTS idx_train_events_lane ON train_events (repo, base, seq);
      -- BR#4170 reconciliation — the hub's durable state for the board↔GitHub
      -- invariant. Four small tables + the pure join in reconcile.ts:
      -- reports  = one row per run (the accounting history, the alarm's receipt);
      -- duties   = ONE row per repo+pr+kind EVER (the dedupe ledger — a dead
      --   duty must never be silently respawned over, it must ALARM);
      -- ignores  = explicit ignore-with-reason rulings (reconcile.ignore);
      -- seen     = the reverse-reconcile clock per binding (two-consecutive-
      --   missing guard against gh flake before any close).
      CREATE TABLE IF NOT EXISTS reconcile_reports (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        actor TEXT NOT NULL,
        repo TEXT NOT NULL,
        accounting TEXT NOT NULL, -- JSON ReconcileAccounting
        line TEXT NOT NULL,       -- accountingLine(...) — the canary line
        ok INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reconcile_reports_repo ON reconcile_reports (repo, seq);
      CREATE TABLE IF NOT EXISTS reconcile_duties (
        repo TEXT NOT NULL,
        pr INTEGER NOT NULL,
        kind TEXT NOT NULL,       -- verify | disposition | reverse
        duty_id TEXT NOT NULL,    -- the spawned duty card ('' while spawning)
        card_status TEXT,         -- refreshed at read; NULL = card hard-deleted
        created_ts INTEGER NOT NULL,
        PRIMARY KEY (repo, pr, kind)
      );
      CREATE TABLE IF NOT EXISTS reconcile_ignores (
        repo TEXT NOT NULL,
        pr INTEGER NOT NULL,
        reason TEXT NOT NULL,
        by TEXT NOT NULL,
        created_ts INTEGER NOT NULL,
        PRIMARY KEY (repo, pr)
      );
      CREATE TABLE IF NOT EXISTS reconcile_seen (
        repo TEXT NOT NULL,
        pr INTEGER NOT NULL,
        card TEXT NOT NULL,
        missing INTEGER NOT NULL DEFAULT 0,
        missing_ts INTEGER,
        updated_ts INTEGER NOT NULL,
        PRIMARY KEY (repo, pr)
      );
      -- BR#4658 — the worker-executor verification leg for non-train
      -- typed-await parks. The hub holds no VCS credentials (BR#3516): the
      -- proxy sweep cannot VERIFY run_success / pr_checks_green atoms
      -- machine-side, so those parks had NO closer once their gate fired
      -- (specimen BR#3621: exit met 60h, still parked). The sweep enqueues a
      -- probe here; a worker-executor (the daemon leg beside the merge
      -- train) runs gh first-hand and feeds the verdict back through
      -- proxy.verify — executor-fed facts, hub-decided (the BR#4489
      -- division of labour). One row per atom (dedupe across cards).
      CREATE TABLE IF NOT EXISTS proxy_probes (
        key TEXT PRIMARY KEY,     -- run:<repo>:<run_id> | newer:<repo>:<run_id> | checks:<repo>#<n>
        repo TEXT NOT NULL,
        kind TEXT NOT NULL,       -- run_success | pr_checks_green
        run_id TEXT,              -- run_success: the awaited run id
        newer_than TEXT,          -- run_success newer_than form
        pr INTEGER,               -- pr_checks_green: the PR number
        expected_head TEXT,       -- the awaited commit (7-40 hex, optional) — mismatch fails closed (BR#3409)
        card_id TEXT NOT NULL,    -- the parked card the probe serves (first requester)
        state TEXT NOT NULL DEFAULT 'pending', -- pending | verified | failed
        ok INTEGER,               -- last conclusive verdict (1 satisfied / 0 negative)
        receipt TEXT,             -- GitHub URL(s) — the evidence that rode the verdict
        head_sha TEXT,            -- the observed head at verification time
        conclusion TEXT,          -- the observed run conclusion / checks verdict
        error TEXT,               -- last transient gh failure (state=failed)
        attempts INTEGER NOT NULL DEFAULT 0,
        created_ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_proxy_probes_state ON proxy_probes (state, updated_ts);
      -- artefact_versions: now a VIEW over ledger (migration below)
      CREATE TABLE IF NOT EXISTS asks (
        id TEXT PRIMARY KEY,
        from_label TEXT NOT NULL,
        to_target TEXT NOT NULL,
        question TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        answer TEXT,
        answered_by TEXT,
        created_ts INTEGER NOT NULL,
        answered_ts INTEGER
      );
    `);

    // additive columns for DBs created before these existed
    for (const ddl of [
      `ALTER TABLE decisions ADD COLUMN options TEXT`,
      `ALTER TABLE decisions ADD COLUMN urgency TEXT`,
      `ALTER TABLE decisions ADD COLUMN deadline_ts INTEGER`,
      `ALTER TABLE decisions ADD COLUMN asker TEXT`,
      `ALTER TABLE auth_tokens ADD COLUMN transport TEXT`,
      `ALTER TABLE artefacts ADD COLUMN status_ts INTEGER`,
      `ALTER TABLE artefacts ADD COLUMN tags TEXT`,
      `ALTER TABLE artefacts ADD COLUMN roles TEXT`,
      `ALTER TABLE embeddings ADD COLUMN dim INTEGER DEFAULT 0`,
      `ALTER TABLE asks ADD COLUMN artefact_id TEXT`,
      `ALTER TABLE artefacts ADD COLUMN project TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE artefacts ADD COLUMN created_by TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE pairings ADD COLUMN type TEXT`,
      `ALTER TABLE pairings ADD COLUMN principal TEXT`,
      `ALTER TABLE auth_tokens ADD COLUMN principal TEXT`,
      `ALTER TABLE auth_tokens ADD COLUMN prev_hash TEXT`,
      `ALTER TABLE auth_tokens ADD COLUMN rotated_ts INTEGER`,
      `ALTER TABLE auth_tokens ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1`,
      `ALTER TABLE auth_tokens ADD COLUMN repairs_count INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE auth_tokens ADD COLUMN repairs_window_ts INTEGER`,
      `ALTER TABLE ws_tokens ADD COLUMN principal TEXT`, // BR#3787: principal→ws for the agent-plane repair route
      `ALTER TABLE sessions ADD COLUMN kind TEXT`,
      `ALTER TABLE sessions ADD COLUMN worktree TEXT`, // BR#3204: where the session's tree lives — board collision visibility
    ]) {
      try { this.state.storage.sql.exec(ddl); } catch { /* column exists */ }
    }

    // ---------- ledger v1: one append-only record (events + versions merged) ----------
    this.state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ledger (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      actor TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'signal',
      action TEXT NOT NULL,
      artefact_id TEXT,
      summary TEXT NOT NULL DEFAULT '',
      data TEXT NOT NULL DEFAULT '{}'
    )`);
    try {
      const migrated = this.one(`SELECT value FROM settings WHERE key = 'ledger_v1'`);
      if (!migrated) {
        const hasEvents = this.one(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'events'`);
        if (hasEvents) {
          this.state.storage.sql.exec(`ALTER TABLE events RENAME TO events_legacy`);
          this.state.storage.sql.exec(`INSERT INTO ledger (ts, actor, kind, action, artefact_id, summary, data)
            SELECT ts, actor, 'signal', op, artefact_id, '', detail FROM events_legacy`);
        }
        const hasVersions = this.one(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'artefact_versions'`);
        if (hasVersions) {
          this.state.storage.sql.exec(`ALTER TABLE artefact_versions RENAME TO versions_legacy`);
          this.state.storage.sql.exec(`INSERT INTO ledger (ts, actor, kind, action, artefact_id, summary, data)
            SELECT ts, actor, 'mutation', action, artefact_id, summary, data FROM versions_legacy`);
        }
        this.state.storage.sql.exec(`CREATE VIEW IF NOT EXISTS events AS
          SELECT seq, ts, actor, action AS op, artefact_id, data AS detail FROM ledger WHERE kind = 'signal'`);
        this.state.storage.sql.exec(`CREATE VIEW IF NOT EXISTS artefact_versions AS
          SELECT seq, ts, actor, action, artefact_id, summary, data FROM ledger WHERE kind = 'mutation'`);
        this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('ledger_v1', ?)`, String(Date.now()));
        this.audit("system:migration", "ledger_v1", null, { backfilled: !!(hasEvents || hasVersions) });
      } else {
        this.state.storage.sql.exec(`CREATE VIEW IF NOT EXISTS events AS
          SELECT seq, ts, actor, action AS op, artefact_id, data AS detail FROM ledger WHERE kind = 'signal'`);
        this.state.storage.sql.exec(`CREATE VIEW IF NOT EXISTS artefact_versions AS
          SELECT seq, ts, actor, action, artefact_id, summary, data FROM ledger WHERE kind = 'mutation'`);
      }
    } catch (e) {
      console.log("ledger migration:", String(e).slice(0, 200));
    }

    // sessions.kind backfill: gateway identity via the local token registry
    try {
      this.state.storage.sql.exec(
        `UPDATE sessions SET kind = 'gateway' WHERE kind IS NULL AND token_id IN
          (SELECT id FROM auth_tokens WHERE tags LIKE '%gateway%')`,
      );
    } catch { /* fresh db */ }

    // ---------- asks v2: open legacy asks become question nodes ----------
    try {
      if (!this.one(`SELECT value FROM settings WHERE key = 'asks_v2'`)) {
        const legacy = this.state.storage.sql.exec(
          `SELECT id, from_label, to_target, question, created_ts, artefact_id FROM asks WHERE status = 'open'`,
        ).toArray() as any[];
        let n = 0;
        for (const a of legacy) {
          const created = await this.create(
            {
              type: "question",
              title: String(a.question ?? "").slice(0, 200),
              body_md: String(a.question ?? ""),
              owner: "",
              meta: { ask: { to: a.to_target ?? "any", from: a.from_label ?? "agent", urgency: "normal", options: [], artefact_id: a.artefact_id || undefined, legacy_id: a.id } },
            },
            "system:migration",
          );
          if (a.artefact_id) {
            const subj = this.one(`SELECT id, meta FROM artefacts WHERE id = ?`, a.artefact_id);
            if (subj) {
              this.state.storage.sql.exec(
                `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
                created.id, a.artefact_id, Date.now(),
              );
              const sm = JSON.parse(subj.meta ?? "{}");
              if (sm.awaiting_ask?.ask_id === a.id) sm.awaiting_ask = { ...sm.awaiting_ask, ask_id: created.id };
              this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(sm), a.artefact_id);
            }
          }
          this.state.storage.sql.exec(
            `UPDATE artefacts SET created_ts = ? WHERE id = ?`, Number(a.created_ts ?? Date.now()), created.id,
          );
          this.state.storage.sql.exec(`UPDATE asks SET status = 'migrated' WHERE id = ?`, a.id);
          this.audit("system:migration", "ask_migrated", a.artefact_id || null, { legacy: a.id, node: created.id });
          n++;
        }
        this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('asks_v2', ?)`, String(Date.now()));
        if (n) this.audit("system:migration", "asks_v2", null, { migrated: n });
      }
    } catch (e) {
      console.log("asks_v2 migration:", String(e).slice(0, 200));
    }


    // ---------- asks options backfill: no ask ships button-less ----------
    try {
      if (!this.one(`SELECT value FROM settings WHERE key = 'asks_options_v1'`)) {
        const nodes = this.state.storage.sql.exec(
          `SELECT id, title, body_md, meta FROM artefacts
           WHERE status NOT IN ('done','superseded') AND (type = 'question' OR (type = 'task' AND tags LIKE '%question%'))`,
        ).toArray() as any[];
        let n = 0;
        for (const node of nodes) {
          const m = JSON.parse(node.meta ?? "{}");
          // legacy-migrated asks: their content is prose — do NOT fabricate
          // options for them (the human answers free-text or reframes)
          if (m.ask?.legacy_id) continue;
          if (!m.ask || (Array.isArray(m.ask.options) && m.ask.options.length >= 2)) continue;
          const text = `${node.title ?? ""} ${node.body_md ?? ""}`;
          let opts: string[] = [];
          // enumerated questions carry their own answers: "(a) … (b) …"
          const parts = text.split(/\([A-Da-d1-4]\)\s+/).map((x: string) => x.trim());
          if (parts.length >= 3) {
            opts = parts.slice(1, 5).map((x: string) => {
              const cut = x.split(/\s+(?:vs\.?|or|—|--)\s+/i)[0];
              return cut.replace(/\s*\n\s*/g, " ").slice(0, 140).trim();
            }).filter((x: string) => x.length >= 2);
          }
          if (opts.length < 2) {
            opts = /GO\/NO-GO|GO or NO-GO|merge GO/i.test(text)
              ? ["GO — proceed as stated", "NO-GO — hold, reason in comment"]
              : ["Approved — proceed as stated", "Hold — reason in comment"];
          }
          m.ask = { ...(m.ask ?? {}), options: opts.slice(0, 4) };
          this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(m), node.id);
          this.version(node.id, "system:migration", "update", `ask options backfilled (${m.ask.options.length})`, { options: m.ask.options });
          n++;
        }
        this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('asks_options_v1', ?)`, String(Date.now()));
        if (n) this.audit("system:migration", "ask_options_backfilled", null, { nodes: n });
      }
    } catch (e) {
      console.log("asks options backfill:", String(e).slice(0, 200));
    }


    // ---------- tags v1: canonical encoding (defence in depth, SOLID) ----------
    // The tags column historically holds JSON arrays, bare strings and comma
    // lists — parseTags() reads them all, but every SQL tag filter guessed one
    // encoding and silently missed the others. Re-encode EVERYTHING through
    // parseTags (artefacts + auth_tokens); canonical rows write canonical
    // JSON. Reads stay parseTags(); tag SQL filters are now correct forever.
    try {
      if (!this.one(`SELECT value FROM settings WHERE key = 'tags_v1'`)) {
        let fixed = 0;
        for (const r of this.state.storage.sql.exec(`SELECT id, tags FROM artefacts`).toArray() as any[]) {
          const canonical = JSON.stringify(parseTags(r.tags));
          if (canonical !== String(r.tags ?? "")) {
            this.state.storage.sql.exec(`UPDATE artefacts SET tags = ? WHERE id = ?`, canonical, r.id);
            fixed++;
          }
        }
        for (const r of this.state.storage.sql.exec(`SELECT id, tags FROM auth_tokens`).toArray() as any[]) {
          const canonical = JSON.stringify(parseTags(r.tags));
          if (canonical !== String(r.tags ?? "")) {
            this.state.storage.sql.exec(`UPDATE auth_tokens SET tags = ? WHERE id = ?`, canonical, r.id);
            fixed++;
          }
        }
        for (const r of this.state.storage.sql.exec(`SELECT token_id, name, kind FROM sessions WHERE kind IS NULL OR kind = ''`).toArray() as any[]) {
          const tok = this.one(`SELECT tags FROM auth_tokens WHERE id = ?`, r.token_id);
          if (tok && parseTags(tok.tags).includes("gateway")) {
            this.state.storage.sql.exec(`UPDATE sessions SET kind = 'gateway' WHERE token_id = ? AND name = ?`, r.token_id, r.name);
            fixed++;
          }
        }
        this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('tags_v1', ?)`, String(Date.now()));
        this.audit("system:migration", "tags_v1", null, { canonicalized: fixed });
      }
    } catch (e) {
      console.log("tags_v1 migration:", String(e).slice(0, 200));
    }

    // ---------- roles_v1: system semantics leave the tag namespace (BR#2983) ----------
    // Tags become 100% inert user labels. Three system meanings move out:
    //   role:* tags      → the roles column (bare names: ["review"])
    //   "question" tag   → type = 'question' (asks v2 nodes)
    //   "attempted" tag  → meta.attempt only (backfilled where missing)
    // The per-row transform is splitSystemTags() in core.ts — unit-tested
    // against every legacy encoding. Idempotent (settings key).
    try {
      if (!this.one(`SELECT value FROM settings WHERE key = 'roles_v1'`)) {
        let roleRows = 0, questionRows = 0, attemptRows = 0;
        for (const r of this.state.storage.sql.exec(`SELECT id, type, tags, meta, updated_ts FROM artefacts`).toArray() as any[]) {
          const tags: string[] = parseTags(r.tags);
          if (!tags.length) continue;
          const meta = JSON.parse(r.meta ?? "{}");
          const out = splitSystemTags(String(r.type ?? ""), tags, meta, Number(r.updated_ts ?? Date.now()));
          if (!out.changed) continue;
          this.state.storage.sql.exec(
            `UPDATE artefacts SET type = ?, tags = ?, roles = ?, meta = ? WHERE id = ?`,
            out.type, out.tags.length ? JSON.stringify(out.tags) : null,
            out.roles.length ? JSON.stringify(out.roles) : null,
            JSON.stringify(out.meta), r.id,
          );
          if (out.roles.length) roleRows++;
          if (out.type !== r.type) questionRows++;
          if (tags.includes("attempted")) attemptRows++;
        }
        this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('roles_v1', ?)`, String(Date.now()));
        this.audit("system:migration", "roles_v1", null, { role_rows: roleRows, question_rows: questionRows, attempt_rows: attemptRows });
      }
    } catch (e) {
      console.log("roles_v1 migration:", String(e).slice(0, 200));
    }

    // ---------- self_edges_v1: a card is never its own relation (BR#3819) ----------
    // The BR#3423 class: a rollup stamped a card child_of ITSELF; the
    // done-open-children gate then counted the card as its own open child
    // forever — unpassable by construction, with no agent-repairable exit.
    // The write path now rejects self-edges and every gate reader excludes
    // them; this one-time migration deletes the ones that already exist.
    // Loud: every deleted edge is audited and version-logged on its card.
    try {
      if (!this.one(`SELECT value FROM settings WHERE key = 'self_edges_v1'`)) {
        const selfEdges = this.state.storage.sql.exec(
          `SELECT src_id, relation, dst_id FROM relations WHERE src_id = dst_id`,
        ).toArray() as any[];
        if (selfEdges.length) {
          this.state.storage.sql.exec(`DELETE FROM relations WHERE src_id = dst_id`);
          for (const e of selfEdges) {
            this.audit("system:migration", "self_edge_deleted", String(e.src_id), {
              relation: String(e.relation), dst: String(e.dst_id), why: "BR#3819: a card is never its own relation",
            });
            this.version(String(e.src_id), "system:migration", "note", `self-edge '${e.relation}' to itself deleted (BR#3819 migration) — the card counted as its own open child/parent and could never close`, { relation: e.relation });
          }
        }
        this.state.storage.sql.exec(
          `INSERT OR REPLACE INTO settings (key, value) VALUES ('self_edges_v1', ?)`,
          JSON.stringify({ deleted: selfEdges.length, ts: Date.now() }),
        );
        this.audit("system:migration", "self_edges_v1", null, { deleted: selfEdges.length });
      }
    } catch (e) {
      console.log("self_edges_v1 migration:", String(e).slice(0, 200));
    }

    // work enters as UNCLAIMED todo — release currently-todo tasks from their creators
    const projectName = this.settingsMap().project_name || "superpositional";
    this.state.storage.sql.exec(
      `UPDATE artefacts SET project = ? WHERE project = '' AND type = 'task'`, projectName,
    );
    this.state.storage.sql.exec(`UPDATE artefacts SET owner = '' WHERE type = 'task' AND status = 'todo' AND owner != ''`);
  }

  // ---------- BR#4212: the fetch entry NEVER throws ----------
  // Root cause of the 2026-10-28 HTML-500 storm (incident BR#4117): the
  // storage-path calls below ran OUTSIDE every try/catch, so one storage-layer
  // fault took the whole DO entry down uncaught — the worker's /api/kb/* arms
  // had no catch either, and the runtime served CF HTML 500 pages where JSON
  // acks belong (silent write loss, clientDisconnected storms, watchdog
  // phantom-silence churn). Contract since this fix:
  //   - a storage fault that makes the op unserviceable (ensureSchema) returns
  //     TYPED JSON 5xx: { error, result_class: "infra_storage_fault", stage }
  //     (result_class convention from PR #205) — never an uncaught throw;
  //   - an alarm-guard fault DEGRADES: the request proceeds (a faulted re-arm
  //     must not drop the write it raced with); the next successful entry
  //     re-arms via the same null-or-stale guard, and the fault is counted in
  //     /stats.channel.entry_faults;
  //   - anything that still escapes the op-level catch-alls lands in the
  //     last-resort catch → typed JSON 503. HTML never escapes this class.
  async fetch(request: Request): Promise<Response> {
    const route = `${request.method} ${new URL(request.url).pathname}`;
    let status = 503;
    try {
      const res = await this.doFetch(request);
      status = res.status;
      return res;
    } catch (e) {
      this.noteStorageFault("dispatch", e);
      return this.json(
        { error: "kb storage fault — the operation did not land; retry", result_class: "infra_storage_fault", stage: "dispatch" },
        503,
      );
    } finally {
      this.noteRoute(route, status < 500);
    }
  }

  private async doFetch(request: Request): Promise<Response> {
    try {
      await this.ensureSchema();
    } catch (e) {
      return this.storageFaultResponse("ensure_schema", e);
    }
    // alarm health: null = not scheduled; a timestamp far in the PAST = a stale
    // alarm the runtime dropped without invoking (observed live: getAlarm stuck
    // 42h in the past, so this arm-guard never re-armed and the watchdog went
    // silent for a day). Either way, arm a fresh tick.
    try {
      const alarmAt = await this.state.storage.getAlarm();
      if (alarmAt === null || alarmAt < Date.now()) {
        await this.state.storage.setAlarm(Date.now() + 15_000);
      }
    } catch (e) {
      // degrade, don't fail the request — the re-arm self-heals on the next
      // entry; the fault is counted for the watchdog's channel-health probe
      this.noteStorageFault("alarm_rearm", e);
    }
    const url = new URL(request.url);

    // realtime: hibernating WS fanout of audit events
    if (url.pathname === "/ws") return this.handleWs(request);

    // realtime: the same fanout over text/event-stream — the gateway wake
    // channel (train.rs subscribes; no WS dep on the Rust side) (BR#4806)
    if (url.pathname === "/sse") return this.handleSse(request);

    // machine-plane self-rename: the bearer token renames its own label.
    // The runner sends its hostname at pair/start and the pair page pre-fills
    // the label from it — but if the approver overrode the label with a
    // gateway name, the agent can fix its own identity without re-pairing.
    // Same write-law as mint (BR#2455): charset, uniqueness, and the gw-*
    // class boundary — a token can never rename across the class line.
    if (url.pathname === "/token.self_revoke") {
      const body: any = await request.json().catch(() => ({}));
      let identity;
      try {
        identity = await this.identify(String(body.bearer ?? ""));
      } catch {
        // unknown or already-revoked: the requested end-state already holds
        return this.json({ ok: true, revoked: null });
      }
      this.state.storage.sql.exec(`UPDATE auth_tokens SET revoked_ts = ? WHERE id = ?`, Date.now(), identity.token_id);
      this.audit(identity.label, "self_revoke", identity.token_id, {});
      return this.json({ ok: true, revoked: identity.label });
    }
    if (url.pathname === "/token.rename") {
      const body: any = await request.json().catch(() => ({}));
      try {
        const identity = await this.identify(String(body.bearer ?? ""));
        const newLabel = String(body.label ?? "").trim();
        if (!/^[a-zA-Z0-9._\/-]{2,64}$/.test(newLabel)) throw new Error("label must be 2-64 chars [a-zA-Z0-9._/-]");
        assertHumanLabel(newLabel); // BR#4262 — never impersonate the bkw_/dev_ namespaces
        const old = this.one(`SELECT label, tags FROM auth_tokens WHERE id = ?`, identity.token_id);
        if (!old) throw new Error("auth token not found");
        if (newLabel !== old.label) {
          if (this.one(`SELECT id FROM auth_tokens WHERE label = ?`, newLabel)) throw new Error(`label '${newLabel}' already exists`);
        }
        this.state.storage.sql.exec(
          `UPDATE auth_tokens SET label = ? WHERE id = ?`,
          newLabel, identity.token_id,
        );
        // tasks owned by the old label are NOT reassigned — the agent can
        // release-and-re-claim them, which is the normal flow. But audit it.
        this.audit(identity.label, "rename", null, { from: old.label, to: newLabel });
        return this.json({ ok: true, from: old.label, to: newLabel });
      } catch (e) {
        // this door sits BEFORE the POST op-switch (no op-level catch), so a
        // bare throw lands in the BR#4212 dispatch boundary and renders as a
        // generic infra_storage_fault 503 — a validation rejection is not a
        // storage fault (retrying cannot help), and swallowing the message
        // violates the guard's "clear error" law (BR#4262). Same contract as
        // the GET arm below: typed 400 with the message, never a naked 500.
        return this.json({ error: String((e as Error)?.message ?? e) }, 400);
      }
    }

    // human-plane GET mirror — the same error contract as the POST arm: a
    // rejected read returns 400 with the message, never a naked 500 (the GET
    // arm predates the try/catch; metrics.throughput's param validation was
    // the first GET that could throw on user input and exposed the gap)
    if (request.method === "GET") {
      try {
        switch (url.pathname) {
          case "/artefacts": return this.json(await this.list({ type: url.searchParams.get("type") ?? undefined, status: url.searchParams.get("status") ?? undefined, tag: url.searchParams.get("tag") ?? undefined, limit: url.searchParams.get("limit") ?? undefined }));
          case "/artefact": return this.json(await this.getWithRelations(String(url.searchParams.get("id"))));
          case "/search": return this.json(await this.search({ q: url.searchParams.get("q") ?? "", type: url.searchParams.get("type") ?? undefined, limit: url.searchParams.get("limit") ?? undefined }));
          case "/events": return this.limited("events", 120, 60_000, request)
            ?? this.json(await this.eventsSince(Number(url.searchParams.get("since") ?? 0), Math.min(Number(url.searchParams.get("limit") ?? 100), 500)));
          case "/board": return this.limited("board", 30, 60_000, request)
            ?? this.json(await this.boardPayload());
          case "/stats": return this.json(await this.stats());
          case "/metrics.throughput": return this.json(await this.metricsThroughput(url.searchParams));
          case "/metrics.reports": return this.json(await this.metricsReports(url.searchParams));
          case "/provenance": { const b = await this.provenanceLookup(url.searchParams); return b ? this.json(b) : this.json({ error: "no bridge provenance for this sha" }, 404); }
          case "/history": return this.json(await this.getHistory(String(url.searchParams.get("id")), Math.min(Number(url.searchParams.get("limit") ?? 100), 200)));
          case "/ask": { const a = await this.askGet(String(url.searchParams.get("id"))); return a ? this.json(a) : this.json({ error: "no such ask" }, 404); }
          case "/train": return this.json(await this.trainStatus({ repo: url.searchParams.get("repo") ?? "" }));
        }
      } catch (e) {
        return this.json({ error: String((e as Error).message ?? e) }, 400);
      }
    }

    const op = url.pathname.slice(1);
    let body: any = {};
    if (request.method === "POST") {
      // BR#4212: a malformed body is a 400, not an entry-level throw (it used
      // to escape every catch and read as a channel outage)
      try { body = await request.json(); } catch { return this.json({ error: "bad json" }, 400); }
    }
    const isAdmin = request.headers.get("x-kb-admin") === "1";
    const actor = String(body.actor ?? "mcp");

    try {
      switch (op) {
        case "create": return this.json(await this.create(body, actor));
        case "boost": return this.json(await this.boost(body, actor));
        case "get": return this.json(await this.get(String(body.id)));
        case "list": return this.json(await this.list(body));
        case "search": return this.json(await this.search(body));
        case "provenance": { const rec = await this.provenanceBySha(parseProvenanceSha(new URLSearchParams({ sha: String((body as any)?.sha ?? "") }))); return rec ? this.json(rec) : this.json({ error: "no bridge provenance for this sha", sha: String((body as any)?.sha ?? "") }, 404); }
        case "related": return this.json(await this.related(String(body.id), Number(body.limit ?? 10)));
        case "update": return this.json(await this.update(body, actor));
        case "transition": return this.json(await this.transition(body, actor));
        case "supersede.task": return this.json(await this.supersedeTask(body, actor));
        case "card.force_review": return this.json(await this.cardForceReview(body, actor));
        case "link": return this.json(await this.link(body, actor));
        case "relations": return this.json(await this.relations(String(body.id)));
        case "stats": return this.json(await this.stats());
        case "get_history": return this.json(await this.getHistory(String(body.id ?? ""), Number(body.limit ?? 100)));
        // ---- merge train (BR#3516/BR#3517): executor-fed facts, hub decides ----
        case "train.lease": return this.json(await this.trainLease(body, actor));
        case "train.event": return this.json(await this.trainEvent(body, actor));
        case "train.ci": return this.json(await this.trainCi(body, actor));
        case "train.status": return this.json(await this.trainStatus(body));
        case "train.history": return this.json(await this.trainHistory(body));
        case "train.bisect": return this.json(await this.trainBisect(body, actor));
        case "train.carry": return this.json(await this.trainCarry(body, actor));
        case "train.lane": return this.json(await this.laneEnsure(String(body.repo ?? ""), String(body.base ?? "main"), actor, body.spec));
        // ---- reconcile (BR#4170): the gateway feeds observations, the hub
        // decides and mutates — the board↔GitHub invariant ----
        case "reconcile.schedule": return this.json(await this.reconcileSchedule(body, actor));
        case "reconcile.report": return this.json(await this.reconcileReport(body, actor));
        case "reconcile.status": return this.json(await this.reconcileStatus(body));
        case "reconcile.ignore": return this.json(await this.reconcileIgnore(body, actor));
        // ---- proxy verification probes (BR#4658): the executor polls the
        // sweep-enqueued probes, runs gh first-hand, feeds verdicts back —
        // executor-fed facts, hub-decided ----
        case "proxy.probes": return this.json(this.proxyProbes(body));
        case "proxy.verify": return this.json(this.proxyVerify(body, actor));
        // ---- machine-plane identity + sessions + asks ----
        case "auth.identify": return this.json(await this.identify(String(body.bearer ?? "")));
        case "agent.provision": return this.json(await this.agentProvision(body, actor));
        case "self.provision": return this.json(await this.selfProvision(body, actor));
        case "token.repair": return this.json(await this.tokenRepair(body));
        case "agents.list": return this.json(await this.listAgents());
        case "session.touch": return this.json(await this.sessionTouch(body));
        case "ask.create": return this.json(await this.askCreate(body, actor));
        case "ask.inbox": return this.json(await this.askInbox(body));
        case "ask.answer": return this.json(await this.askAnswer(body, actor));
        case "ask.get": return this.json(await this.askGet(String(body.id ?? "")));
        case "question.claim": return this.json(await this.questionClaim(body, actor));
        case "question.release": return this.json(await this.questionRelease(body, actor));
        case "purge_smoke": return this.json(await this.purgeSmoke(body));
        case "ask.reframe": return this.json(await this.askReframe(body, actor));
        case "orient": return this.json(await this.orient(body));
        case "progress.log": return this.json(await this.progressLog(body, actor));
        case "session.alive": {
          const row = this.one(`SELECT id, meta FROM artefacts WHERE id = ? AND type = 'task' AND status = 'in_progress'`, String(body.id ?? ""));
          if (!row) return this.json({ ok: false, error: "task not in progress" });
          const meta = JSON.parse(row.meta ?? "{}");
          meta.session_alive_ts = Date.now();
          this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), row.id);
          return this.json({ ok: true });
        }
        case "settings.public": return this.json({ settings: this.publicSettings() });
        case "bootstrap": {
          const m = this.settingsMap();
          return this.json({
            project_name: m.project_name || "Superpositional",
            instructions: composeBootstrap(m.project_name || "Superpositional", m.board ?? DEFAULT_BOARD),
          });
        }
        // ---- workspace registry (global DO; human plane, owner-checked) ----
        case "ws.seed": return this.json(await this.wsSeed(body.logins ?? []));
        case "ws.list": return this.json(await this.wsList(String(body.login)));
        case "ws.create": return this.json(await this.wsCreate(body, String(body.login)));
        case "ws.join": return this.json(await this.wsJoin(body, String(body.login)));
        case "ws.members": return this.json(await this.wsMembers(body, String(body.login)));
        case "ws.remove": return this.json(await this.wsRemove(body, String(body.login)));
        case "ws.token_register": return this.json(await this.wsTokenRegister(body));
        case "ws.token_lookup_principal": return this.json(await this.wsTokenLookupPrincipal(body));
        case "ws.token_lookup": return this.json(await this.wsTokenLookup(body));
        case "ws.pair.start": return this.json(await this.wsPairStart(body));
        case "ws.pair.get": return this.json(await this.wsPairGet(body));
        case "ws.pair.approve": return this.json(await this.wsPairApprove(body));
        case "ws.pair.poll": return this.json(await this.wsPairPoll(body));
        // ---- admin (human plane only; worker sets x-kb-admin after session auth) ----
        case "admin.mint":
        case "admin.list_tokens":
        case "admin.revoke":
        case "admin.token_tags":
        case "admin.alias":
        case "admin.aliases":
        case "admin.settings_get":
        case "admin.settings_set":
        case "admin.unblock_proxy_sweep":
        case "admin.stall_sweep":
        case "admin.ask_escalation_sweep":
        case "admin.question_claim_sweep":
        case "admin.alarm_sweep":
          if (!isAdmin) return this.json({ error: "admin only" }, 403);
          if (op === "admin.mint") return this.json(await this.tokenMint(body));
          if (op === "admin.alias") return this.json(await this.adminAliasSet(body, actor));
          if (op === "admin.aliases") return this.json({ aliases: this.state.storage.sql.exec(`SELECT label, canonical, ts FROM identity_aliases ORDER BY ts DESC`).toArray() });
          if (op === "admin.list_tokens") return this.json(await this.tokenList());
          if (op === "admin.revoke") return this.json(await this.tokenRevoke(body));
          if (op === "admin.token_tags") return this.json(await this.tokenTags(body));
          if (op === "admin.settings_get") return this.json(await this.settingsGet());
          if (op === "admin.question_claim_sweep") {
            // drill/liveness path for the BR#3911 claim-expiry sweep — the
            // same injected-clock shape as the proxy watch's drill
            return this.json({ expired: await this.questionClaimSweep(Number(body.now) || Date.now()) });
          }
          if (op === "admin.unblock_proxy_sweep") {
            // drill/liveness path for the unblock-proxy watch (BR#3361a):
            // per-card pacing + caps still apply; pass now=<future epoch ms>
            // to bypass the cadence window and run immediately.
            await this.unblockProxySweep(Number(body.now ?? Date.now()));
            const last = this.one(`SELECT value FROM settings WHERE key = 'unblock_proxy_last_ts'`);
            return this.json({ ok: true, last_sweep_ts: Number(last?.value ?? 0) });
          }
          if (op === "admin.stall_sweep") {
            // drill/liveness path for the in_progress stall sweep (BR#4282):
            // runs ONLY the stall/hold/route phase — no ask expiry, no review
            // sweep, no other watchdog phases. pass now=<future epoch ms> to
            // make freshly-touched cards stale (the sweep has no cadence
            // window of its own).
            await this.stallSweep(Number(body.now ?? Date.now()));
            return this.json({ ok: true });
          }
          if (op === "admin.ask_escalation_sweep") {
            // drill/liveness path for the ask TTL escalation (BR#3942): the
            // alarm sweep calls escalateStaleAsks(Date.now()) every minute;
            // pass now=<future epoch ms> to test a back-dated ask against a
            // later clock without waiting the TTL in real time.
            const escalated = await this.escalateStaleAsks(Number(body.now ?? Date.now()));
            return this.json({ ok: true, escalated });
          }
          if (op === "admin.alarm_sweep") {
            // drill/liveness path for the FULL alarm sweep (BR#4562): the
            // blocked-park drain (D) and owner-death lapse (E) phases live
            // only here — admin.stall_sweep never exercises them, which is
            // how the drain's missing release-hold check stayed invisible
            // until it manufactured the unclassified breach pile. Real clock
            // (the alarm cadence's own now0): dead-park verdicts
            // (churn/dead-ask) drain at any age; fresh parks and live owners
            // are untouched.
            await this.alarmSweep();
            return this.json({ ok: true });
          }
          // admin.stop_line_sweep / admin.merge_queue_sweep /
          // admin.provenance_sweep / admin.closure_audit_sweep DELETED with
          // the sweeps themselves (BR#3516 §8): the hub holds no VCS
          // credentials; the executor runs the train, the hub watches leases.
          return this.json(await this.settingsSet(body));
        default: return this.json({ error: `unknown op ${op}` }, 404);
      }
    } catch (e) {
      // BR#4390: pass a typed result_class through when the thrower stamped
      // one (machine gate refusals: "gate_rejected") — an untyped 400 here
      // used to be indistinguishable from noise at the client, and the MCP
      // layer's fallback classified it as infra. A 400-classified op
      // rejection is the hub REFUSING, never the hub being down.
      const rc = (e as any)?.result_class;
      return this.json({ error: String((e as Error).message ?? e), ...(rc ? { result_class: rc } : {}) }, 400);
    }
  }

  // ---------- ops ----------

  private async create(body: any, actor: string) {
    let type = body.type as ArtefactType;
    if (!isArtefactType(type)) throw new Error(`unknown artefact type '${type}' (valid: ${ARTEFACT_TYPES.join(", ")})`);
    const title = String(body.title ?? "");
    let bodyMd = String(body.body_md ?? "");
    const limitErr = checkLimits(title, bodyMd, body.meta);
    if (limitErr) throw new Error(limitErr);

    const seq = (await this.nextSeq(type));
    const id = formatId(seq);
    const ts = Date.now();
    const status = INITIAL_STATUS[type];
    const tags = sanitizeTags(body.tags);
    // roles: the machine's dispatch/gating lanes — structural, NEVER tags
    // (tags are inert user labels; a tag can't change system behaviour)
    const rolesIn = parseRolesInput(body.roles);
    if (rolesIn.ok === false) throw new Error(rolesIn.error);
    const roles = rolesIn.roles;
    const session = await this.resolveSession(body, String(body.token_id ?? ""));
    // project: explicit override or the deployment's project; tasks enter UNCLAIMED (owner = pool)
    const project = String(body.project ?? "").trim() || this.settingsMap().project_name || "superpositional";
    // owner = claimant, on tasks only (phase 4). Other types record their human
    // actor in meta (proposed_by / ask.from) — one field, one meaning.
    let owner = type === "task" ? String(body.owner ?? "").trim() : "";
    if (type !== "task") {
      const pm = (body.meta ?? {}) as any;
      if (type === "decision" && !pm.proposed_by) pm.proposed_by = actor;
    }
    // qualifications stack: a publisher may declare self-analyzed readiness AND request
    // further confirmation bars (await: ["review"]) before the task goes ready
    const createMeta: any = { ...(body.meta ?? {}) };
    // an ask node REQUIRES options (the human answers by clicking) — enforced
    // here, not just in ask.create, so every door is covered
    if (createMeta.ask && (type === "task" || type === "question")) {
      const opts = Array.isArray(createMeta.ask.options) ? createMeta.ask.options.filter(Boolean) : [];
      if (opts.length < 2) throw new Error("asks require 2-8 answer options — give the human one-click answers (meta.ask.options)");
      if (!String(body.title ?? "").trimEnd().endsWith("?")) throw new Error("phrase the ask as an answerable question ending in '?' — e.g. 'Do you want to merge PR #84 into main?'");
    }
    // classification is structural (phase 3): legacy meta.kind maps to
    // type ("question"), roles (analysis/review) or a plain tag (research) —
    // stored meta never carries kind again
    if (createMeta.kind !== undefined) {
      const k = String(createMeta.kind);
      const kindType = (KIND_TYPE as Record<string, string | undefined>)[k];
      if (kindType && type === "task") type = kindType as ArtefactType;
      const kindRole = (KIND_ROLE as Record<string, string | undefined>)[k];
      if (kindRole && !roles.includes(kindRole as any)) roles.push(kindRole as any);
      const kindTag = (KIND_TAG as Record<string, string | undefined>)[k];
      if (kindTag && !tags.includes(kindTag)) tags.push(kindTag);
      delete createMeta.kind;
    }

    if (type === "task" && (body.qualified === true || (Array.isArray(body.await) && body.await.length))) {
      createMeta.qualification = {
        state: body.qualified === true ? "qualified" : "open",
        how: body.qualified === true ? "self-analyzed" : "open",
        by: actor, ts,
        bars: Array.isArray(body.await) ? body.await.map(String) : [],
      };
    }
    // VERIFY-VERDICT DEDUP (For Me flood fix): verify sessions propose a decision
    // per round — identical findings ("unchanged since round N") presented as
    // fresh decisions buried the human inbox (45 bounce-cards in 4h). Rule:
    // a verdict identical to the last PROPOSED verdict for the same target is
    // applied directly, never proposed. Same verdict + round>=3 → the task
    // BLOCKS for human intervention (the loop is stalled, that's a blocker
    // not a decision). Changed verdict or changed receipts still propose.
    if (type === "decision" && createMeta.decision_class === "verify-verdict") {
      const target = String(createMeta.task ?? createMeta.verify_target ?? "").trim();
      const verdict = String(createMeta.verdict ?? "").toLowerCase();
      if (target && verdict) {
        const prev = this.one(
          `SELECT id, meta FROM artefacts WHERE type = 'decision' AND status = 'proposed'
           AND json_extract(meta, '$.decision_class') = 'verify-verdict'
           AND (json_extract(meta, '$.task') = ? OR json_extract(meta, '$.verify_target') = ?)
           ORDER BY created_ts DESC LIMIT 1`,
          target, target,
        );
        // receipts fingerprint: any meta keys other than bookkeeping — identical
        // when the verifier found the same world state
        const fp = (m: any) => JSON.stringify(Object.entries(m ?? {})
          .filter(([k]) => !["decision_class", "task", "verify_target", "verdict", "session", "round"].includes(k))
          .sort(([a], [b]) => a.localeCompare(b)));
        const same = prev && String((JSON.parse(prev.meta ?? "{}") as any).verdict ?? "").toLowerCase() === verdict
          && fp(createMeta) === fp(JSON.parse(prev.meta ?? "{}"));
        if (same) {
          const trow = this.one(`SELECT id, status, meta FROM artefacts WHERE id = ?`, target);
          if (trow) {
            const tm = JSON.parse(trow.meta ?? "{}");
            const round = Number(createMeta.round ?? tm.verify_round ?? 0) + 1;
            tm.verify_round = round;
            const prevGauges = tm.last_progress ?? {};
            tm.last_progress = {
              note: `verify round ${round}: verdict ${verdict} UNCHANGED — auto-applied, no new decision card`, sentiment: "neutral", actor, ts: Date.now(),
              completion_pct: prevGauges.completion_pct, confidence_pct: prevGauges.confidence_pct,
              risk_pct: prevGauges.risk_pct, context_pct: prevGauges.context_pct,
            };
            const alreadyRight = verdict === "bounce" ? trow.status === "in_progress" : trow.status === "done";
            if (!alreadyRight) {
              // 3 identical rounds = the loop is stalled; park it for a human.
              // BR#3578: the human leg is an ACTIVE ask (For Me, one click),
              // not prose buried on the card.
              if (round >= 3) {
                const stallAsk = await this.askCreate({
                  to: "ray",
                  question: `Verify loop stalled on ${trow.id} (${round} identical ${verdict} rounds) — cancel the loop or keep it parked?`,
                  reason: "the verifier keeps proposing the identical verdict; auto-apply made no progress — the loop needs a human ruling",
                  options: ["CANCEL — transition the loop to todo for re-scoping", "KEEP PARKED — I'll clear the blocker myself", "SUPERSEDE — drop the stalled round"],
                  details: `Verify loop stalled: ${round} rounds with identical verdict (${verdict}), each auto-applied with no progress. Read the verify history on ${trow.id} before answering.`,
                  artefact_id: trow.id,
                }, "system:verifier").catch(() => null);
                if (stallAsk?.task_status !== "blocked") {
                  await this.transition({
                    id: trow.id, to: "blocked",
                    note: `verify loop stalled — ${round} rounds with identical verdict (${verdict}); auto-applied each time, no progress. Needs human intervention.`,
                    unblock_condition: "human: read the verify history on this card; either clear the blocker the verifier keeps naming, or cancel the loop (transition todo and address the task differently)",
                    ...(stallAsk ? { await_event: { event: "ask", ask_id: stallAsk.id } } : {}),
                  }, "system:verifier");
                }
              } else {
                await this.transition({
                  id: trow.id, to: verdict === "bounce" ? "in_progress" : "done",
                  note: `verify round ${round}: identical verdict (${verdict}) — auto-applied (For Me flood fix; no decision card)`,
                }, "system:verifier");
              }
            } else {
              this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(tm), Date.now(), trow.id);
            }
            this.audit("system:verifier", "verdict_deduped", id, { target, verdict, round });
            return { id, deduped: true, target, round, note: "identical verdict auto-applied — no decision card created" };
          }
        }
      }
    }
    // verify-verdict cards land in the human inbox (For you) — prepend the
    // plain-English ask (what accepting does, why a human must do it) so the
    // card is self-describing everywhere it renders: popover, notification
    // snippet, MCP reads. After the dedup gate above: only real cards.
    if (type === "decision" && createMeta.decision_class === "verify-verdict") {
      bodyMd = `${verifyVerdictStatement(createMeta)}\n\n${bodyMd.trim()}`.trim();
    }
    this.state.storage.sql.exec(
      `INSERT INTO artefacts (id, type, title, status, body_md, meta, owner, created_ts, updated_ts, tags, roles, status_ts, project, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, type, title, status, bodyMd, JSON.stringify({ ...createMeta, session }), owner, ts, ts,
      tags ? JSON.stringify(tags) : null, roles.length ? JSON.stringify(roles) : null, ts, project, actor,
    );
    if (!bodyMd.trim() && (type === "task" || type === "goal")) {
      bodyMd = scaffoldBody(title, owner || actor);
    }
    this.audit(actor, "create", id, { type, title });
    this.version(id, actor, "create", title, { type, title, body_md: bodyMd, tags: tags ?? [], roles });
    // ONE ACTIONABLE VERDICT PER TARGET (BR#3457): a fresh verify-verdict for
    // a target sweeps still-proposed older rounds of the same verify effort —
    // otherwise accepting the latest resurfaces an older round as the new
    // "latest" and the For Me card regrows (the dedup gate above only covered
    // identical repeats; this covers changed verdicts / changed receipts).
    if (type === "decision" && createMeta.decision_class === "verify-verdict") {
      const target = String(createMeta.task ?? createMeta.verify_target ?? "").trim();
      if (target) await this.supersedeStaleVerdicts(target, id, `superseded by ${id} — newer verdict for same target`);
    }
    await this.embedArtefact(id, title, bodyMd);
    // GitHub auto-enrichment was DELETED with the hub's GH_TOKEN paths
    // (BR#3516 §1: the hub holds no VCS credentials — enrichment is an
    // executor/agent concern, worker-local creds defended by doctor).
    if (type === "progress") await this.progressHeartbeat(body.meta, title, actor);
    // consensus round: a proposed decision invites agent feedback. A question-kind
    // round task is auto-spawned child_of the decision — the same pattern as the
    // Verify spawn on in_review (BR#903). The round is a collection surface, not
    // a gate: acceptance stays human-authoritative (the doTransition gate holds),
    // and the round never blocks the decision's acceptance. Recursion guard: the
    // round is a TASK, so its own create() never re-enters this branch; the
    // meta marker additionally lets internal paths mint decisions without a round.
    let feedbackRoundId: string | undefined;
    if (type === "decision" && createMeta.feedback_round !== true) {
      const round = await this.create(
        {
          type: "task",
          title: `${FEEDBACK_TITLE_PREFIX} ${title}`.slice(0, LIMITS.title),
          body_md: [
            `Feedback round for decision ${id} — "${title}".`,
            "",
            `Proposed decisions collect agent consensus before the human decides. Read the decision (get_artefact ${id}), then contribute on THIS round via log_progress:`,
            `- Begin your note with "agree" or "disagree" and give your reasons. Any number of agents contribute additively; one log per position.`,
            "",
            `The round informs the human — it does not gate them: acceptance stays human-authoritative. The tally (agree · disagree · contributors) surfaces in orient (decisions_awaiting_consensus) and the For Me view.`,
          ].join("\n"),
          tags: ["question"],
          meta: { kind: "question", feedback_for: id, feedback_round: true },
          project,
        },
        actor,
      );
      feedbackRoundId = round.id;
      // child_of across types is a deliberate raw insert: the PUBLIC relation
      // grammar keeps child_of task→task (flat task graph), but the consensus
      // round is system-linked to its decision — the same door the Verify
      // spawn uses (auto-spawns never round-trip the link endpoint).
      this.state.storage.sql.exec(
        `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
        round.id, id, ts,
      );
      this.audit(actor, "create", round.id, { type: "task", auto: "consensus", parent: id });
    }
    return { id, type, status, ...(feedbackRoundId ? { feedback_round: feedbackRoundId } : {}) };
  }

  /** BR#3457 — ONE ACTIONABLE VERDICT PER TARGET, EVER. A verify-verdict
   *  taking over a target supersedes every OTHER still-proposed verify-verdict
   *  for that target: older rounds of the same verify effort, and create-race
   *  stragglers. BR#1782's dedup covered identical repeats at create; this
   *  covers "a newer verdict exists" — without it, accepting the latest
   *  resurfaces an older round as the new "latest" and the For Me card
   *  regrows as if the human's click did nothing. All sweep transitions act
   *  as "system:verdictsweep" so the act-time prong (doTransition) never
   *  cascades onto the takeover verdict itself. */
  private async supersedeStaleVerdicts(target: string, exceptId: string, reason: string): Promise<void> {
    const stale = this.state.storage.sql.exec(
      `SELECT id FROM artefacts WHERE type = 'decision' AND status = 'proposed'
       AND json_extract(meta, '$.decision_class') = 'verify-verdict'
       AND (json_extract(meta, '$.task') = ? OR json_extract(meta, '$.verify_target') = ?)
       AND id != ?`,
      target, target, exceptId,
    ).toArray() as any[];
    for (const s of stale) {
      try {
        await this.transition({ id: s.id, to: "superseded", note: reason, replacement_id: exceptId }, "system:verdictsweep");
        this.audit("system:verdictsweep", "verdict_superseded", s.id, { target, by: exceptId });
      } catch (e) {
        // one refused sweep never blocks the takeover — the gate's refusal is
        // observability (the card simply stays until the next prong fires)
        this.audit("system:verdictsweep", "verdict_sweep_failed", s.id, { target, by: exceptId, error: String((e as Error).message ?? e).slice(0, 300) });
      }
    }
  }

  /** A progress artefact (meta.task → task id) doubles as a heartbeat on that task:
   *  auto-starts todo tasks, re-claims watchdog-abandoned ones, and bumps last_progress.
   *  Agents post updates as progress logs instead of calling log_progress on the task —
   *  without this, the task card never moves. */
  private async progressHeartbeat(metaObj: any, title: string, actor: string) {
    const raw = String(metaObj?.task ?? "").trim();
    if (!raw) return;
    const candidates = [raw, raw.replace(/^#/, "BR#"), `BR#${raw.replace(/^#/, "")}`];
    const t = candidates
      .map((c) => this.one(`SELECT id, type, status, meta, tags, roles FROM artefacts WHERE id = ? AND type IN ('task','question')`, c))
      .find(Boolean);
    if (!t) return;
    const tmeta = JSON.parse(t.meta ?? "{}");
    const tTags: string[] = parseTags(t.tags);
    const tRoles: string[] = parseTags(t.roles);
    const isQualifier = tRoles.includes("analysis") || tRoles.includes("review") || tRoles.includes("unblock");
    if (t.status === "blocked" && (tmeta.blocked?.reason ?? "").startsWith("abandoned")) {
      await this.transition({ id: t.id, to: "in_progress", note: "re-claimed — progress artefact logged" }, actor);
      delete tmeta.blocked;
    } else if (t.status === "todo") {
      // pickup gate applies: only qualified work (or qualifier roles) auto-starts.
      // Questions are never auto-started — contributions don't claim.
      const q = isQualifier ? { ok: true } : this.qualifyCheck(t, "analysis");
      if (q.ok && t.type !== "question") await this.transition({ id: t.id, to: "in_progress", note: "started — progress artefact logged" }, actor);
    }
    const prevGauges = tmeta.last_progress ?? {};
    tmeta.last_progress = {
      note: title.slice(0, 200), sentiment: "neutral", actor, ts: Date.now(), session: tmeta.session,
      completion_pct: prevGauges.completion_pct, confidence_pct: prevGauges.confidence_pct,
      risk_pct: prevGauges.risk_pct, context_pct: prevGauges.context_pct,
    };
    delete tmeta.grace_until; // an artefact heartbeat means the agent is active — grace over
    this.state.storage.sql.exec(
      `UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`,
      JSON.stringify(tmeta), Date.now(), t.id,
    );
    this.version(t.id, actor, "progress", title.slice(0, 500), { note: title.slice(0, 200) });
    this.audit(actor, "progress", t.id, { note: title.slice(0, 200), via: "progress_artefact" });
  }

  /** Human boost: priority 0 in the pickup ranking, above unblock duty.
   *  Cascades to all TRANSITIVE OPEN children (todo/blocked/in_progress) —
   *  a task cannot complete while its children are open, so the dependency
   *  set IS the children. Audited per task; boost ts orders multiple boosts. */
  private async boost(body: any, actor: string) {
    const id = String(body.id ?? "");
    const on = body.boost !== false;
    const row = this.one(`SELECT id, type FROM artefacts WHERE id = ?`, id);
    if (!row) throw new Error(`no such artefact: ${id}`);
    if (row.type !== "task") throw new Error(`boost applies to tasks, not ${row.type}`);
    const boosted: string[] = [];
    const queue = [id];
    const seen = new Set<string>([id]);
    while (queue.length) {
      const tid = queue.shift()!;
      const t = this.one(`SELECT id, status, meta FROM artefacts WHERE id = ?`, tid);
      if (!t || t.status === "done" || t.status === "superseded") continue;
      const meta = JSON.parse(t.meta ?? "{}");
      if (on) meta.boosted = Date.now();
      else delete meta.boosted;
      this.state.storage.sql.exec(
        `UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`,
        JSON.stringify(meta), Date.now(), t.id,
      );
      this.audit(actor, on ? "boost" : "unboost", t.id, { root: id });
      this.version(t.id, actor, "update", on ? `boosted (priority 0, via ${id})` : `boost removed (via ${id})`, {});
      boosted.push(t.id);
      for (const c of this.state.storage.sql.exec(
        `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
         WHERE r.relation = 'child_of' AND r.dst_id = ?`, t.id,
      ).toArray() as any[]) {
        if (!seen.has(c.id)) { seen.add(c.id); queue.push(c.id); }
      }
    }
    return { id, boosted, on };
  }

  private async get(id: string) {
    const row = this.one(`SELECT * FROM artefacts WHERE id = ?`, id);
    if (!row) throw new Error(`no such artefact: ${id}`);
    return this.shape(row);
  }

  private async list(body: any) {
    const conds: string[] = [], params: any[] = [];
    if (body.type) { conds.push("type = ?"); params.push(String(body.type)); }
    if (body.status) { conds.push("status = ?"); params.push(String(body.status)); }
    if (body.tag) { conds.push("tags LIKE ?"); params.push(`%"${String(body.tag).replace(/[^a-z0-9:_-]/g, "")}"%`); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const rows = this.state.storage.sql
      .exec(`SELECT * FROM artefacts ${where} ORDER BY updated_ts DESC LIMIT ?`, ...params, Math.min(Number(body.limit ?? 50), 200))
      .toArray();
    const artefacts = rows.map((r) => this.shape(r));
    // consensus enrichment (BR#903): proposed decisions carry their open
    // feedback round + tally so the human plane (For Me) renders it without
    // N+1 client fetches. Rows without an open round stay unmarked.
    for (const a of artefacts) {
      if (a.type === "decision" && a.status === "proposed") {
        const c = this.consensusFor(a.id);
        if (c) a.consensus = c;
      }
    }
    return { artefacts };
  }

  /** Hybrid: FTS5 keyword + embedding cosine, merged. Falls back to FTS-only when AI is unavailable. */
  private async search(body: any) {
    const rawQ = String(body.q ?? "");
    const limit = Math.min(Number(body.limit ?? 20), 100);
    const q = ftsQuery(rawQ);
    if (!q) return { artefacts: [], note: "empty query" };
    const typeFilter = body.type ? `AND a.type = '${String(body.type).replace(/[^a-z_]/g, "")}'` : "";

    const ftsRows = this.state.storage.sql
      .exec(
        `SELECT a.id FROM artefacts_fts f JOIN artefacts a ON a.rowid = f.rowid
         WHERE artefacts_fts MATCH ? ${typeFilter} ORDER BY rank LIMIT ?`,
        q, limit,
      )
      .toArray()
      .map((r: any, i: number) => ({ id: r.id, score: 1 / (1 + i) }));

    let vecRows: Array<{ id: string; score: number }> = [];
    let qvec: Float32Array | null = null;
    let qdim = 0;
    try {
      if (this.env?.AI) {
        const out: any = await this.env.AI.run(EMBED_MODEL, { text: [embedText(rawQ, "")] });
        if (Array.isArray(out?.data?.[0])) { qvec = Float32Array.from(out.data[0]); qdim = qvec.length; }
      }
    } catch { /* AI unavailable */ }
    if (!qvec) { qvec = Float32Array.from(trigramVec(embedText(rawQ, ""), TRIGRAM_DIM)); qdim = TRIGRAM_DIM; }
    {
      const rows = this.state.storage.sql.exec(`SELECT artefact_id, vec FROM embeddings WHERE dim = ?`, qdim).toArray();
      const scored = rows.map((r: any) => {
        const v = new Float32Array(r.vec.buffer ?? r.vec);
        return { id: r.artefact_id, score: cosine(qvec as Float32Array, v) };
      }).filter((r) => r.score > 0.3);
      scored.sort((a, b) => b.score - a.score);
      vecRows = scored.slice(0, limit);
    }

    const merged = hybridMerge(ftsRows, vecRows, limit);
    if (merged.length === 0) return { artefacts: [], note: "no matches (keyword + semantic)" };
    const ids = merged.map((m) => m.id);
    const marks = ids.map(() => "?").join(",");
    const rows = this.state.storage.sql.exec(
      `SELECT * FROM artefacts WHERE id IN (${marks})`, ...ids,
    ).toArray().map((r: any) => this.shape(r));
    const byId = new Map(rows.map((r: any) => [r.id, r]));
    const scored = merged
      .map((m) => {
        const r: any = byId.get(m.id);
        return r ? { ...r, _score: m.score, _via: m.via } : null;
      })
      .filter((r): r is any => !!r);
    return { artefacts: scored, hybrid: { keyword: ftsRows.length, semantic: vecRows.length } };
  }

  /** "What relates to X?" — nearest artefacts by embedding. */
  private async related(id: string, limit: number) {
    const row = this.one(`SELECT vec, dim FROM embeddings WHERE artefact_id = ?`, id);
    if (!row) return { artefacts: [], note: "no embedding for artefact" };
    const qvec = new Float32Array(row.vec.buffer ?? row.vec);
    const rows = this.state.storage.sql.exec(`SELECT artefact_id, vec FROM embeddings WHERE artefact_id != ? AND dim = ?`, id, row.dim).toArray();
    const scored = rows.map((r: any) => {
      const v = new Float32Array(r.vec.buffer ?? r.vec);
      return { id: r.artefact_id, score: cosine(qvec, v) };
    }).filter((r) => r.score > 0.3);
    scored.sort((a, b) => b.score - a.score);
    const ids = scored.slice(0, limit).map((r) => r.id);
    if (ids.length === 0) return { artefacts: [] };
    const marks = ids.map(() => "?").join(",");
    const arts = this.state.storage.sql.exec(`SELECT * FROM artefacts WHERE id IN (${marks})`, ...ids).toArray().map((r: any) => this.shape(r));
    const byId = new Map(arts.map((a: any) => [a.id, a]));
    return { artefacts: ids.map((i) => byId.get(i)).filter((a): a is any => !!a) };
  }

  /**
   * Embed title-weighted text; store as float32 BLOB with the vector dim.
   * Two spaces: Workers AI (prod, 768d) when bound; local hashed-trigram (256d) fallback.
   * Best-effort — never fails the write.
   */
  private async embedArtefact(id: string, title: string, body: string) {
    let vec: number[] | null = null;
    let dim = 0;
    try {
      if (this.env?.AI) {
        const out: any = await this.env.AI.run(EMBED_MODEL, { text: [embedText(title, body)] });
        if (Array.isArray(out?.data?.[0])) { vec = out.data[0]; dim = vec.length; }
      }
    } catch { /* AI unavailable */ }
    if (!vec) {
      vec = trigramVec(embedText(title, body), TRIGRAM_DIM);
      dim = TRIGRAM_DIM;
    }
    const f32 = Float32Array.from(vec);
    this.state.storage.sql.exec(
      `INSERT INTO embeddings (artefact_id, vec, dim) VALUES (?, ?, ?)
       ON CONFLICT(artefact_id) DO UPDATE SET vec = excluded.vec, dim = excluded.dim`,
      id, new Uint8Array(f32.buffer), dim,
    );
  }

  private async update(body: any, actor: string) {
    const id = String(body.id ?? "");
    const row = this.one(`SELECT * FROM artefacts WHERE id = ?`, id);
    if (!row) throw new Error(`no such artefact: ${id}`);
    // any mutation is a heartbeat: abandoned tasks re-claim on first contact
    const preMeta = JSON.parse(row.meta ?? "{}");
    const reclaimed =
      row.status === "blocked" && (preMeta.blocked?.reason ?? "").startsWith("abandoned");
    if (reclaimed) {
      await this.transition({ id, to: "in_progress", note: "re-claimed — agent resumed (heartbeat)" }, actor);
    }
    const title = body.title !== undefined ? String(body.title) : row.title;
    const bodyMd = body.body_md !== undefined ? String(body.body_md) : row.body_md;
    // row.meta predates the re-claim transition — strip the stale blocked record so we don't resurrect it
    const metaObj = body.meta !== undefined ? JSON.parse(JSON.stringify(body.meta)) : JSON.parse(row.meta ?? "{}");
    if (reclaimed) delete metaObj.blocked;
    const meta = JSON.stringify(metaObj);
    if (row.type === "progress") await this.progressHeartbeat(metaObj, title, actor);
    const tags = body.tags !== undefined ? sanitizeTags(body.tags) : row.tags;
    // roles replacement semantics, same as tags (explicit array = replace)
    let roles: string[] | null = parseTags(row.roles);
    if (body.roles !== undefined) {
      const rolesIn = parseRolesInput(body.roles);
      if (rolesIn.ok === false) throw new Error(rolesIn.error);
      roles = rolesIn.roles;
    }
    const limitErr = checkLimits(title, bodyMd, JSON.parse(meta));
    if (limitErr) throw new Error(limitErr);
    // update does not touch status — transitions are the only status path
    this.state.storage.sql.exec(
      `UPDATE artefacts SET title = ?, body_md = ?, meta = ?, tags = ?, roles = ?, updated_ts = ? WHERE id = ?`,
      title, bodyMd, meta, tags ? JSON.stringify(tags) : null, roles && roles.length ? JSON.stringify(roles) : null, Date.now(), id,
    );
    this.audit(actor, "update", id, {});
    const changed = [
      body.title !== undefined && "title", body.body_md !== undefined && "body",
      body.meta !== undefined && "meta", body.tags !== undefined && "tags",
      body.roles !== undefined && "roles",
    ].filter(Boolean);
    this.version(id, actor, "update", `updated ${changed.join(", ") || "fields"}`, { title, body_md: bodyMd });
    await this.embedArtefact(id, title, bodyMd);
    return { id };
  }

  /** Pure evidence for a qualification kind: a done analysis/review child, or an accepted
   *  decision linked either way. Declarations (meta.qualified / meta.qualification) don't count. */
  private hasEvidence(row: any, kind: "analysis" | "review"): { ok: boolean; via?: string } {
    const roleFilter = kind === "analysis"
      ? `(c.roles LIKE '%"analysis"%' OR c.roles LIKE '%"review"%')`
      : `c.roles LIKE '%"review"%'`;
    const child = this.one(
      `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status = 'done' AND ${roleFilter} LIMIT 1`,
      row.id,
    );
    if (child) return { ok: true, via: child.id };
    const dec = this.one(
      `SELECT d.id AS id FROM relations r JOIN artefacts d ON d.id = r.src_id
       WHERE r.relation = 'supports' AND r.dst_id = ? AND d.type = 'decision' AND d.status = 'accepted' LIMIT 1`,
      row.id,
    );
    if (dec) return { ok: true, via: dec.id };
    return { ok: false };
  }

  /** Swimlane qualification: declared (self-analyzed at intake / preset), pure evidence,
   *  or inherited from the parent's decomposition (the pass that qualified the parent
   *  covered its children). */
  private qualifyCheck(row: any, kind: "analysis" | "review"): { ok: boolean; via?: string } {
    const meta = JSON.parse(row.meta ?? "{}");
    const q = meta.qualification ?? {};
    if (kind === "analysis" && (meta.qualified === true || q.state === "qualified")) return { ok: true, via: "declared" };
    const ev = this.hasEvidence(row, kind);
    if (ev.ok) return ev;
    const parent = this.one(
      `SELECT p.id AS id, p.meta AS meta FROM relations r JOIN artefacts p ON p.id = r.dst_id
       WHERE r.relation = 'child_of' AND r.src_id = ? LIMIT 1`,
      row.id,
    );
    if (parent) {
      const pm = JSON.parse(parent.meta ?? "{}");
      if (kind === "analysis" && (pm.qualified === true || (pm.qualification ?? {}).state === "qualified"))
        return { ok: true, via: `parent:${parent.id}` };
      const sib = this.one(
        `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
         WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status = 'done' AND ${kind === "analysis"
           ? `(c.roles LIKE '%"analysis"%' OR c.roles LIKE '%"review"%')`
           : `c.roles LIKE '%"review"%'`} LIMIT 1`,
        parent.id,
      );
      if (sib) return { ok: true, via: `sibling:${sib.id}` };
    }
    return { ok: false };
  }

  /** Requested-but-unmet qualification bars (qualifications stack: a publisher may
   *  self-qualify AND ask for further confirmation before the task goes ready). */
  /** Bars that can actually gate a CLAIM: things satisfiable before work
   *  starts (human sign-off, an accepted decision...). Qualifier-role bars
   *  (role:analysis/review/impl/unblock) are NOT enforceable pre-claim —
   *  they demand a done role child of the task itself, i.e. a review of
   *  work the gate prevents from existing (the Oct-20 empty-pool incident:
   *  10/10 backlog items unclaimable, runner churning failed claims).
   *  Roles are playbooks, not gates — the done-gate already enforces
   *  review-before-completion where it belongs. */
  private enforceableBars(bars: string[]): string[] {
    return bars.filter((b) => !/^(?:role:)?(analysis|review|impl|unblock)$/.test(String(b)));
  }

  private unmetBars(row: any): string[] {
    const meta = JSON.parse(row.meta ?? "{}");
    const bars: string[] = (meta.qualification ?? {}).bars ?? [];
    return this.enforceableBars(bars).filter((b) => !this.hasEvidence(row, /review/.test(b) ? "review" : "analysis").ok);
  }

  /** Bulk evidence for readiness projections: done role-tagged children per parent +
   *  accepted decisions per task. Review evidence also satisfies the analysis kind. */
  private qualificationEvidence(): { analysisEv: Set<string>; reviewEv: Set<string> } {
    const analysisEv = new Set<string>(), reviewEv = new Set<string>();
    for (const k of this.state.storage.sql.exec(
      `SELECT r.dst_id AS pid, c.roles AS roles FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND c.status = 'done'`,
    ).toArray() as any[]) {
      const roles: string[] = parseTags(k.roles);
      if (roles.includes("review")) { reviewEv.add(k.pid); analysisEv.add(k.pid); }
      else if (roles.includes("analysis")) analysisEv.add(k.pid);
    }
    for (const d of this.state.storage.sql.exec(
      `SELECT r.dst_id AS tid FROM relations r JOIN artefacts d ON d.id = r.src_id
       WHERE r.relation = 'supports' AND d.type = 'decision' AND d.status = 'accepted'`,
    ).toArray() as any[]) { analysisEv.add(d.tid); reviewEv.add(d.tid); }
    return { analysisEv, reviewEv };
  }

  /** Agent roles for an actor label (empty for humans "web" and system actors). */
  private actorTagsFor(label: string): string[] {
    if (!label || /^(web|system:)/.test(label)) return [];
    const row = this.one(`SELECT tags FROM auth_tokens WHERE label = ?`, label);
    try { return parseTags(row?.tags); } catch { return []; }
  }

  /** Every rejected transition is audited (transition_rejected: actor, from, to,
   *  reason) — gaming the gates is visible in the Log and costs behaviour score.
   *  The rejection then goes through the breach door: storms raise ONE card. */
  private async transition(body: any, actor: string) {
    try {
      return await this.doTransition(body, actor);
    } catch (e) {
      const id = String(body?.id ?? "");
      const to = String(body?.to ?? "");
      if (id) {
        const cur = this.one(`SELECT status FROM artefacts WHERE id = ?`, id);
        this.audit(actor, "transition_rejected", id, {
          from: cur?.status, to, reason: String((e as Error)?.message ?? e).slice(0, 300),
        });
        try { await this.foldBreaches(id); } catch { /* the breach door never blocks the gate */ }
        // BR#3361 (b): the auto-derivation half of terminal-leg ownership.
        // A done rejected by done-close-legs derives the close-duty child
        // (flood-guarded: one per legs-shape per hour) so the very next
        // attempt has an owner to point at — no orphan terminal legs.
        if (String((e as Error)?.message ?? "").includes("[rule: done-close-legs]")) {
          try { await this.spawnCloseLegDuty(id, actor, String((e as Error)?.message ?? "")); } catch (se) {
            this.audit(actor, "close_leg_spawn_error", id, { error: String((se as Error).message ?? se).slice(0, 300) });
          }
        }
      }
      throw e;
    }
  }

  /** BR#3361 (b): the close-duty child a rejected done auto-derives. One per
   *  legs-shape per flood window; carries the receipt contract and the
   *  close-then-complete-parent contract so the leg ends owned. The legs
   *  come from the gate's own rejection message — the authoritative list. */
  private async spawnCloseLegDuty(parentId: string, actor: string, rejectionMessage: string): Promise<void> {
    const row = this.one(`SELECT id, title, body_md, meta, status FROM artefacts WHERE id = ?`, parentId);
    if (!row || row.status === "done") return; // leg executed between rejection and spawn
    const ts = Date.now();
    const meta = JSON.parse(row.meta ?? "{}");
    const listed = /not receipted: ([^—]+)—/.exec(rejectionMessage)?.[1] ?? "";
    const legs: CloseLeg[] = [...listed.matchAll(/(?:(?:([A-Za-z0-9-]+)\/([A-Za-z0-9.-]+))?#|#)(\d+)/g)].map((m) => ({
      repo: m[1] && m[2] ? `${m[1]}/${m[2]}` : null,
      number: Number(m[3]),
      raw: m[0],
    }));
    if (!legs.length) return;
    const stamp = meta.last_close_leg_spawn;
    const shape = legs.map(legLabel).join(",");
    if (stamp && typeof stamp.at === "number" && ts - stamp.at < UNBLOCK_FLOOD_MS && String(stamp.legs ?? "") === shape) return;
    // one live close-leg duty per parent at a time — the machine's cap shape
    const live = this.one(
      `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
         AND c.roles LIKE '%"unblock"%' AND (c.title || ' ' || c.body_md) LIKE '%close-leg duty%' LIMIT 1`,
      parentId,
    );
    if (live) {
      meta.last_close_leg_spawn = { at: ts, legs: shape, child: live.id };
      this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), parentId);
      return;
    }
    const rootTitle = String(row.title ?? "").replace(/^(?:Unblock:\s*)+/, "");
    const legLines = legs.map((l) => `- close ${legLabel(l)}${l.repo ? ` (${l.repo})` : " (repo: resolve from the card's context — bare-number legs take the project's default paperwork repo)"}`).join("\n");
    const created = await this.create(
      {
        type: "task",
        title: `Close-leg duty: ${rootTitle.slice(0, 160)}`.slice(0, 200),
        session: "", // session-less spawn: the closer stamps it when they claim (a
        // pre-attributed child would trip review-separation against the real closer)
        body_md: `Terminal close-leg duty for ${parentId} — "${rootTitle}".\n\nThe parent's done was gate-rejected by done-close-legs (BR#3361): its Done-when ends in a terminal GitHub close leg that was not receipted. The hub auto-derived this duty so the leg has an owner — no orphan terminal legs.\n\nLegs:\n${legLines}\n\nEvery receipt must carry: ${RECEIPT_CONTRACT}.\n\nContract: (1) verify live state first (gh issue view <N> --repo <repo> --json state). If the issue is already CLOSED, capture the receipt and close yourself done citing it. If it is OPEN: execute the close per the parent's grammar (bug-corpus scenario id, or scenario: none with justification), capture the receipt, close yourself done with the receipt in the note. (2) Then transition ${parentId} → done citing the receipt — the parent's gate accepts a receipted note or this closed child.`,
        roles: ["unblock"],
      },
      actor,
    );
    this.state.storage.sql.exec(
      `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
      created.id, parentId, ts,
    );
    meta.last_close_leg_spawn = { at: ts, legs: shape, child: created.id };
    this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), parentId);
    this.audit(actor, "create", created.id, { type: "task", auto: "close_leg", parent: parentId, legs: shape });
    this.version(parentId, actor, "note", `close leg(s) ${shape} unowned at done — auto-derived close-duty child ${created.id} (BR#3361)`, { child: created.id, legs: shape });
  }

  /** BR#3910: one-click human supersede from the web plane. BR#2480 law: no
   *  agent may supersede — the route in index.js only admits cookie (human)
   *  sessions, and the task lifecycle deliberately has no →superseded edge,
   *  so MCP/agent transitions stay gate-rejected. This op composes the
   *  documented two-step (BR#1852/BR#1935 precedent) server-side in ONE call:
   *  blocked → (gated release) → todo → superseded, then the machine-readable
   *  lineage (supersedes relation, replacement → superseded — the same shape
   *  doTransition stamps from body.replacement_id). Intermediate states never
   *  leave this function; every validation throws BEFORE the first write, so
   *  a refused supersede leaves the card byte-for-byte unchanged (the silent
   *  no-op class this card kills). */
  private async supersedeTask(body: any, actor: string) {
    const id = String(body.id ?? "").trim();
    if (!id) throw new Error("supersede requires id");
    const row = this.one(`SELECT * FROM artefacts WHERE id = ?`, id);
    if (!row) throw new Error(`no such artefact: ${id}`);
    if (row.type !== "task") throw new Error(`supersede is a task action — ${id} is a ${row.type}`);
    if (row.status !== "blocked" && row.status !== "todo") {
      const hint = row.status === "in_progress"
        ? " (a live claim: release it first — only the owner or a human can release it)"
        : row.status === "in_review"
          ? " (under review — bounce or close it through review, or release it first)"
          : "";
      throw new Error(`supersede applies to blocked|todo cards — ${id} is '${row.status}'${hint}`);
    }
    // replacement: optional, but a supplied one must resolve — the lineage is
    // machine-readable (supersedes relation + superseded_by) and a dangling
    // pointer would strand the successor hunt on the board
    let replacementId = String(body.replacement_id ?? "").trim();
    if (replacementId) {
      const bare = /^(?:BR#?|#)?(\d+)$/i.exec(replacementId);
      if (bare) replacementId = `BR#${bare[1]}`;
      if (replacementId === id) throw new Error("replacement_id names the card itself — a card cannot supersede into itself");
      const rep = this.one(`SELECT id, type FROM artefacts WHERE id = ?`, replacementId);
      if (!rep) throw new Error(`replacement ${replacementId} not found — create it first, then supersede`);
      if (rep.type !== row.type) throw new Error(`replacement must be a ${row.type} — ${replacementId} is a ${rep.type}`);
    }
    const note = String(body.note ?? "").trim()
      || (replacementId ? `superseded via web — replaced by ${replacementId}` : "superseded via web");
    const ts = Date.now();
    // leg 1 — a blocked card releases through the GATE first (the documented
    // two-step). web:* actors are release-exempt (machine.ts), so the human
    // click cannot be locked out by a stale owner. Any gate rejection throws
    // here — before any supersede write.
    if (row.status === "blocked") {
      await this.transition({ id, to: "todo", note: `supersede (step 1/2)${replacementId ? ` — replacement ${replacementId}` : ""}` }, actor);
    }
    // leg 2 — todo → superseded by direct write, exactly how the machine's
    // own supersede_children effect terminates duty children (do.ts): there
    // is no lifecycle edge by design (agents can never supersede), so the
    // server composes it under the verified human actor with full audit.
    const meta = JSON.parse(row.meta ?? "{}");
    meta.superseded_reason = note;
    if (replacementId) meta.superseded_by = replacementId;
    delete meta.blocked; // terminal — the parked-reason box must not resurrect ("Unblock now" on a dead card)
    delete meta.subprocess;
    delete meta.attempt;
    this.state.storage.sql.exec(
      `UPDATE artefacts SET status = 'superseded', meta = ?, status_ts = ?, updated_ts = ?, owner = '' WHERE id = ?`,
      JSON.stringify(meta), ts, ts, id,
    );
    if (replacementId) {
      const rep = this.one(`SELECT id, type FROM artefacts WHERE id = ?`, replacementId);
      if (rep && rep.type === row.type)
        this.state.storage.sql.exec(
          `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'supersedes', ?, ?)`,
          replacementId, id, ts,
        );
    }
    this.audit(actor, "transition", id, { from: row.status, to: "superseded", note, ...(replacementId ? { replacement_id: replacementId } : {}) });
    this.version(id, actor, "transition", `${row.status} → superseded — ${note}`, { from: row.status, to: "superseded", note });
    return { id, status: "superseded", ...(replacementId ? { replacement_id: replacementId } : {}) };
  }

  /** card.force_review — the human's backlog decision on an Awaiting park
   *  (BR#4962, per accepted BR#4960). `approve` re-anchors the accepted
   *  verdict at the parked head — a carry leg per unlanded PR (via
   *  "force-review", the one human-authored move that carries) — and swaps
   *  the parked reason back to the merge-train queued reason IN PLACE
   *  (blocked→blocked is an illegal edge: refresh, never transition), so
   *  the train's own flow lands it. `request_changes` bounces impl exactly
   *  like the train's own bounce: one repair leg, fresh verify on re-entry.
   *  ZERO asks on either path (BR#4960): the parked card in the backlog IS
   *  the human leg. The DO op is actor-agnostic; the WEB ROUTE is the only
   *  writer and it rejects gateway bearers — force-review is web/human-only. */
  private async cardForceReview(body: any, actor: string) {
    const id = String(body.id ?? body.task_id ?? "").trim();
    if (!id) throw new Error("force_review requires id");
    const decision = String(body.decision ?? "").trim().toLowerCase();
    if (!["approve", "request_changes"].includes(decision))
      throw new Error(`force_review decision must be approve | request_changes (got "${decision || "none"}")`);
    const row = this.one(`SELECT * FROM artefacts WHERE id = ?`, id);
    if (!row) throw new Error(`no such artefact: ${id}`);
    if (row.type !== "task") throw new Error(`force_review is a task action — ${id} is a ${row.type}`);
    if (row.status !== "blocked") throw new Error(`force_review applies to a blocked Awaiting park — ${id} is '${row.status}'`);
    const now = Date.now();
    const cm = JSON.parse(row.meta ?? "{}");
    const mt = (cm.merge_train ?? {}) as Record<string, unknown>;
    const aw = (mt.awaiting ?? null) as { at?: number; head_sha?: string; verdict_id?: string } | null;
    if (String(mt.state ?? "") !== "awaiting" || !aw)
      throw new Error(`${id} is not parked Awaiting review (merge_train.state=${String(mt.state ?? "none")}) — nothing to force-review`);
    const parkedHead = String(aw.head_sha ?? "") || null;
    const verdictId = String(aw.verdict_id ?? "") || this.trainChain(id).verdict_id;
    const note = String(body.note ?? "").trim();
    const prNum = Number(mt.pr ?? 0) || 0;

    if (decision === "approve") {
      // Re-anchor coverage: every UNLANDED leg's stamped head moves to the
      // parked head, via "force-review" — the human approval IS the
      // re-anchor. The card then re-queues into the train's own flow (gate
      // checks, merge, CI settle) — the approval never merges anything by
      // itself; a head that moved again past the parked one fails coverage
      // fail-closed and parks Awaiting afresh.
      let next = cm;
      const carried: string[] = [];
      for (const leg of trainLegs(next).filter((l) => !trainLegLanded(next, l))) {
        const stamped = String(leg.head_sha_at_acceptance ?? "").toLowerCase();
        if (stamped && parkedHead && stamped !== parkedHead.toLowerCase()) {
          next = carryAppendLeg(next, leg.number, { from_head: stamped, to_head: parkedHead, prior_verdict_id: verdictId ?? null, carried_ts: now, via: "force-review" as const });
          carried.push(`${leg.repo || "?"}#${leg.number} ${stamped.slice(0, 9)}→${String(parkedHead).slice(0, 9)}`);
        }
      }
      // refresh-in-place: the queued reason (the merge-train queue
      // derivation picks the card back up naturally), the awaiting stamp
      // cleared, the boost DECAYED (BR#4068: decay is the accept hook's job
      // — re-queue deletes it), the typed pr_merged await_event PRESERVED
      // (the queue's exit leg is still live).
      const m2: any = { ...next };
      m2.merge_train = { ...(m2.merge_train ?? {}), state: "queued" };
      delete m2.merge_train.awaiting;
      delete m2.boosted;
      m2.blocked = { ...(m2.blocked ?? {}), reason: MERGE_TRAIN_QUEUED_REASON };
      this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(m2), now, id);
      this.audit(actor, "force_review", id, { decision, verdict: verdictId ?? null, ...(parkedHead ? { head: parkedHead } : {}), legs_carried: carried, ...(prNum ? { pr: prNum } : {}), ...(note ? { note: note.slice(0, 300) } : {}) });
      this.version(id, actor, "force_review", `force-review approved (human)${verdictId ? ` — verdict ${verdictId} re-anchored` : ""}${carried.length ? ` — coverage carried ${carried.join(", ")}` : " — heads already matched"} — re-queued on the merge train (BR#4960 pull model)${note ? ` — “${note.slice(0, 160)}”` : ""}`, { decision });
      return { ok: true, id, decision, verdict: verdictId ?? null, legs_carried: carried, ...(prNum ? { pr: prNum } : {}) };
    }

    // request_changes — bounce impl like the train's own bounce: the parked
    // reason and the awaiting stamp are gone, the BR#4068 boost stamps (one
    // mechanical repair leg from re-landing), and the blocked → in_progress
    // transition carries the fix-up brief. The repair leg re-enters review
    // through the normal handoff; the fresh verify re-anchors whatever
    // survives — the parked verdict is NOT carried across a requested
    // change (human-resolved invalidates, BR#3516 §5).
    const repoName = String(mt.repo ?? cm.pr?.repo ?? "");
    const brief = [
      `Force-review changes requested (BR#4962): PR ${repoName}#${prNum} — the human reviewed the parked head${parkedHead ? ` ${parkedHead.slice(0, 9)}` : ""} and asked for changes.`,
      ``,
      ...(note ? [`**Reviewer note:** ${note}`, ``] : []),
      `**Next owner: impl** — address the note, push, re-enter review; the train re-queues at the BACK once a fresh verify accepts the new head (BR#3516 §5).`,
      ...(prNum ? [``, `PR: https://github.com/${repoName}/pull/${prNum}`] : []),
    ].join("\n");
    const m2: any = { ...cm };
    m2.merge_train = {
      ...(m2.merge_train ?? {}),
      state: "bounced",
      bounce_kind: "coverage",
      defect: `force-review: changes requested${note ? ` — ${note.slice(0, 180)}` : ""}`.slice(0, 300),
      bounced_at: now,
    };
    delete m2.merge_train.awaiting;
    m2.boosted = now;
    this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(m2), now, id);
    this.audit(actor, "force_review", id, { decision, ...(parkedHead ? { head: parkedHead } : {}), ...(prNum ? { pr: prNum } : {}), ...(note ? { note: note.slice(0, 300) } : {}) });
    await this.transition(
      {
        id,
        to: "in_progress",
        // anonymous: the hub acts as the machine on the human's decision —
        // the repair leg must not inherit a session (misattribution +
        // spurious review-separation refusal on re-entry)
        session: "",
        note: `force-review changes requested — impl repair leg${note ? `: ${note.slice(0, 160)}` : ""}`,
        body_md: `${String(row.body_md ?? "").replace(/\n\n---\n\nMerge-train bounce[\s\S]*$/, "")}\n\n---\n\n${brief}`,
      },
      actor,
    );
    return { ok: true, id, decision, ...(prNum ? { pr: prNum } : {}) };
  }

  /** Lazy SQL-backed context for the machine rules — a guard only queries
   *  what it actually reads, so cheap transitions stay cheap. */
  private ruleCtx(row: any, body: any, id: string, tTags: string[]): RuleCtx {
    return {
      qualify: (kind) => {
        // Bar-based claim gate: a claim is legal unless the task DECLARES
        // enforceable bars that are unmet. Task tags declare the KIND of work
        // (analysis/impl/review) for the dispatched session's delivery
        // contract; there are no agent roles and no default qualification
        // requirement — separation of duties lives in the session-history
        // check, not here.
        const unmet = this.unmetBars(row);
        return unmet.length === 0 ? { ok: true, via: "no-bars" } : { ok: false };
      },
      unmetBars: () => this.unmetBars(row),
      session: () => this.resolveSession(body, String(body?.token_id ?? "")),
      evidence: (eid) => this.one(`SELECT type, tags, roles, meta FROM artefacts WHERE id = ?`, eid),
      parent: () =>
        this.one(
          `SELECT p.id AS id, p.status AS status, p.meta AS meta FROM relations r JOIN artefacts p ON p.id = r.dst_id
           WHERE r.relation = 'child_of' AND r.src_id = ? AND r.src_id != r.dst_id LIMIT 1`,
          id,
        ),
      // BR#4068: the bounce's live review-leg ask is a VISIBILITY DEVICE
      // (the human leg re-filed on a head move), not decomposition work — it
      // must never fence the parent's done. The train's landed close runs
      // blocked→in_progress→done while the ask may sit unanswered; counting
      // it as an open child would deadlock every one-click-from-landed card
      // behind its own review ask. The ask is retired by the close itself
      // (doTransition's retirement leg), so the band never shows a dead leg.
      // BR#3819 (B): every child_of reader excludes self-edges — a gate must
      // never read state that cannot exist (the BR#3423 class: the parent
      // counted as its own open child, done forever unpassable).
      openChildren: () =>
        this.one(
          `SELECT COUNT(*) AS n FROM relations r JOIN artefacts c ON c.id = r.src_id
           WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status NOT IN ('done', 'superseded')
             AND r.src_id != r.dst_id AND NOT (c.type = 'question' AND c.meta LIKE '%"review_leg"%')`,
          id,
        )?.n ?? 0,
      openChildIds: () =>
        (this.state.storage.sql.exec(
          `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
           WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status NOT IN ('done', 'superseded')
             AND r.src_id != r.dst_id`,
          id,
        ).toArray() as any[]).map((r) => String(r.id)),
      // verify-of-verify / nesting-cap guard: the spawn-blocker reason or null
      spawnGuard: () => {
        let cursor = id, depth = 0;
        while (depth < 10) {
          const p = this.one(
            `SELECT p.id AS id, p.roles AS roles FROM relations r JOIN artefacts p ON p.id = r.dst_id
             WHERE r.relation = 'child_of' AND r.src_id = ? AND r.src_id != r.dst_id LIMIT 1`, cursor,
          );
          if (!p) return null;
          depth++;
          if (parseTags(p.roles).includes("review")) return `ancestor ${p.id} is a review task — verify-of-verify is blocked`;
          if (depth >= 3) return `nesting depth ${depth} would exceed the child_of cap of 3`;
          cursor = p.id;
        }
        return null;
      },
      // newest OPEN verify round (reuse candidate) — a re-handoff re-enters the
      // same round instead of stacking a fresh card per bounce cycle
      openVerifyChild: () =>
        this.one(
          `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
           WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
             AND c.roles LIKE '%"review"%' AND r.src_id != r.dst_id ORDER BY c.updated_ts DESC LIMIT 1`, id,
        ),
      // at most ONE live unblock child per parent, ever (cap ≤1 open)
      openUnblockChild: () =>
        this.one(
          `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
           WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
             AND c.roles LIKE '%"unblock"%' AND r.src_id != r.dst_id ORDER BY c.updated_ts DESC LIMIT 1`, id,
        ),
      // BR#3361: the task's own body (Done-when section source for the
      // terminal close-leg gate)
      cardBody: () => String(row.body_md ?? ""),
      // BR#3361 terminal-leg ownership: a CLOSED child that owns the leg —
      // its title/body names both the close and the issue number
      closeLegChildClosed: (leg: CloseLeg) => {
        const hit = this.one(
          `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
           WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status = 'done'
             AND (c.title || ' ' || c.body_md) LIKE '%close%'
             AND (c.title || ' ' || c.body_md) LIKE ${"?"}
             AND c.roles LIKE '%"unblock"%' AND r.src_id != r.dst_id LIMIT 1`,
          id, `%#${leg.number}%`,
        );
        return !!hit;
      },
      // recent version-log rows (newest first) for the server-side silent-churn fold
      recentEvents: () =>
        (this.state.storage.sql.exec(
          `SELECT ts, actor, action, summary FROM artefact_versions WHERE artefact_id = ? ORDER BY seq DESC LIMIT 50`,
          id,
        ).toArray() as any[]).map((r) => ({ ts: Number(r.ts), actor: String(r.actor), action: String(r.action), summary: String(r.summary ?? "") })),
    };
  }

  private async doTransition(body: any, actor: string) {
    const id = String(body.id ?? "");
    const to = String(body.to ?? "");
    const row = this.one(`SELECT * FROM artefacts WHERE id = ?`, id);
    if (!row) throw new Error(`no such artefact: ${id}`);
    // ---- the law: one table, one executor (machine.ts). Legality AND every
    // spawn/escalate/supersede decision come back as a typed Verdict
    // (Applied | Rejection); this function persists and executes the effects,
    // it never invents legality or decisions. ----
    const tTags: string[] = parseTags(row.tags);
    const tRoles: string[] = parseTags(row.roles);
    const ts0 = Date.now();
    const verdict = await decide(
      { id, type: row.type, status: row.status, to, roles: tRoles, tags: tTags, meta: JSON.parse(row.meta ?? "{}"), actor, body, owner: row.owner, now: ts0 },
      this.ruleCtx(row, body, id, tTags),
    );
    if (verdict.ok === false) {
      // BR#4390: a machine refusal (illegal edge or guard) rides TYPED —
      // result_class "gate_rejected" survives the op catch-all below into the
      // response body, so clients can machine-tell "the hub refused" from
      // "the hub is down". Before this stamp the refusal was an untyped 400
      // that the MCP layer re-wrapped as a retryable infra 503 — the
      // BR#4068/BR#3822 class: deterministic refusals read as "kb temporarily
      // unavailable — retry" and duty sessions burned dozens of futile
      // retries on a transition that could never succeed.
      const err: any = new Error(`${verdict.message} [rule: ${verdict.rule}]`);
      err.result_class = "gate_rejected";
      throw err;
    }
    // (B) subprocess class: a declared block on a long/handed-off op, with a
    // budget. The watchdog pauses until the budget lapses; past it the
    // subprocess = declared silence while STILL WORKING: the task stays
    // in_progress (it isn't blocked — nothing else must finish first). The
    // watchdog pauses until the declared budget lapses; past it the sweep
    // converts the silence to abandoned. Blocked is reserved for tasks
    // awaiting OTHER tasks/decisions.
    const isSubprocess = body.class === "subprocess";
    const sentiment = isSentiment(body.sentiment) ? body.sentiment : undefined;
    const ts = ts0;
    const meta = JSON.parse(row.meta ?? "{}");
    if (isSubprocess && row.type === "task" && row.status === "in_progress") {
      const bm = Math.max(1, Math.min(1440, Number(body.budget_minutes) || 0));
      if (!bm) throw new Error("class: subprocess requires budget_minutes (1-1440) — a declared window without a deadline never trips, which is worse than abandonment");
      meta.subprocess = { reason: String(body.note ?? body.reason ?? "").trim(), budget_minutes: bm, deadline_ts: ts + bm * 60_000, ts };
      this.state.storage.sql.exec(
        `UPDATE artefacts SET meta = ?, updated_ts = ?, status_ts = ? WHERE id = ?`,
        JSON.stringify(meta), ts, ts, id,
      );
      this.audit(actor, "transition", id, { from: row.status, to: "in_progress (subprocess)", note: String(body.note ?? ""), class: "subprocess", budget_minutes: bm });
      this.version(id, actor, "transition", `subprocess declared — watchdog paused until +${bm}m — ${String(body.note ?? "").slice(0, 120)}`, { from: row.status, to: "in_progress", class: "subprocess" });
      return { id, status: "in_progress", subprocess: true };
    }
    // stamp the executor's meta_patch (value `undefined` deletes the key),
    // then normalize the blocked record to the FINAL status — the churn
    // redirect lands blocked with its own reason + unblock condition.
    for (const [k, v] of Object.entries(verdict.meta_patch)) {
      if (v === undefined) delete meta[k];
      else meta[k] = v;
    }
    if (verdict.status === "blocked") {
      if (!meta.blocked) {
        // BR#3578: store the TYPED await (the guard validated one exists or
        // exempted a machine-managed park). Free text is optional annotation,
        // derived from the structured event when absent. BR#3986: a derived
        // await naming the card itself is a deadlock (BR#136) — store none.
        const aw0 = validateAwaitEvent(body.await_event)
          ?? awaitEventFromAtoms(parseProxyCondition(String(body.unblock_condition ?? "")).atoms);
        const aw = aw0 && isSelfAwait(id, aw0) ? null : aw0;
        meta.blocked = {
          reason: String(body.note ?? body.reason ?? "").trim(),
          unblock_condition: String(body.unblock_condition ?? "").trim() || (aw ? describeAwaitEvent(aw) : ""),
          ts,
          ...(aw ? { await_event: aw } : {}),
        };
      }
      delete meta.subprocess; // a real block supersedes a declared subprocess window
    } else if (meta.blocked) {
      delete meta.blocked; // unblocking clears the dead-end record
    }
    // BR#3911: a question leaving todo (answered done, ADR supersede) cancels
    // any live human-claim hold — the hold was waiting for exactly this.
    if (row.type === "question" && (verdict.status === "done" || verdict.status === "superseded")) {
      delete meta.human_claimed;
    }
    // claim semantics: in_progress on a task claims it for the actor (system actors don't steal claims)
    let owner = row.owner;
    // claim only on fresh pickup or abandoned re-claim — a review bounce returns to the AUTHOR
    const bounceFromReview = row.status === "in_review";
    // GHOST-BOUNCE CONVERSION (2026-10-25, Ray GO): a verify bounce hands the
    // parent back to its impl owner — but if that owning session is DEAD (no
    // heartbeat within the stall window), the bounce lands on a ghost and the
    // PR ages into the conflict pile. Release to the pool IN THE SAME TICK:
    // owner cleared, reason stamped, the card is dispatchable immediately.
    // The reaper stays as backstop for the non-bounce stall cases.
    let ghostBounce = false;
    if (row.type === "task" && bounceFromReview && owner && owner !== actor && !/^(web|system:)/.test(owner)) {
      // dead-by-construction: no auth_token for the owner label → it can never
      // heartbeat again (revoked/never-provisioned). Otherwise liveness = the
      // owner token's freshest session.
      const ownerToken = this.one(
        `SELECT id FROM auth_tokens WHERE label = ? OR principal = ? LIMIT 1`, owner, owner,
      );
      const ownerSession = ownerToken
        ? this.one(
            `SELECT last_seen_ts FROM sessions WHERE token_id = ? ORDER BY last_seen_ts DESC LIMIT 1`,
            ownerToken.id,
          )
        : null;
      const staleMin = (() => {
        const s = this.one(`SELECT value FROM settings WHERE key = 'stale_minutes'`);
        return s ? Math.max(1, Math.min(120, parseInt(s.value, 10) || 10)) : 10;
      })();
      // liveness = EITHER real signal: the owner session's hub ping, or the
      // task's own heartbeat (meta.last_progress.ts — what log_progress writes).
      // A live owner does at least one of these within the stall window.
      const lastProgressTs = Number(JSON.parse(row.meta ?? "{}").last_progress?.ts ?? 0);
      const lastSignal = Math.max(Number(ownerSession?.last_seen_ts ?? 0), lastProgressTs);
      const dead = !ownerToken || !lastSignal || (Date.now() - lastSignal > staleMin * 60_000);
      if (dead) {
        ghostBounce = true;
        owner = "";
        meta.bounce_released = { reason: "owning session dead at bounce — released to pool", at: Date.now() };
      }
    }
    // gateway attribution: a gateway-tagged token is infrastructure — it claims
    // on behalf of the agent it dispatched as (ADR BR#899). body.agent names
    // that agent; mcp.ts only forwards it when the token carries the "gateway"
    // tag, so a plain agent token cannot attribute its work elsewhere.
    const attributedAgent = body.gateway && String(body.agent ?? "").trim()
      ? String(body.agent).trim().slice(0, 60)
      : undefined;
    if (row.type === "task" && verdict.status === "in_progress" && !bounceFromReview && !/^system:/.test(actor) && owner !== actor) {
      owner = attributedAgent ?? actor;
    }
    // identity phase 2: ownership references the stable principal when the
    // acting token carries one (labels are display; principals are the anchor)
    const actingPrincipal = typeof body.token_id === "string" && body.token_id
      ? this.one(`SELECT principal FROM auth_tokens WHERE id = ?`, body.token_id)?.principal
      : null;
    if (row.type === "task" && to === "in_progress" && !bounceFromReview && !/^system:/.test(actor) && actingPrincipal) {
      owner = actingPrincipal;
    }
    // attribution bookkeeping (BR#2455): when a gateway-tagged token acts as
    // another agent, record the gateway→agent edge for Connect grouping. The
    // token row is the authority — a forged body.gateway without the tag no-ops.
    if (attributedAgent && attributedAgent !== actor && this.isGatewayActor(actor)) {
      this.gatewayTouch(actor, attributedAgent);
    }
    // session attribution: stamp which session claimed/acted, first-wins, resolved
    // explicit → the token's most recent session (agents pass session on orient only)
    if (row.type === "task" && !meta.session) {
      const sess = await this.resolveSession(body, String(body.token_id ?? ""));
      if (sess) meta.session = String(sess).slice(0, 120);
    }
    // (release ownership, churn escalate/redirect and the attempt stamp are
    // executor decisions now — machine.ts RULES + effects, BR#2420 F4)
    // separation of duties, mechanical: a session that completed the analysis
    // child cannot carry the parent into implementation. If the parent is
    // claimed by the same session, release it — impl requires a fresh claim
    // (fresh session). The claim gate will then allow it (evidence session ≠ new session).
    if (row.type === "task" && verdict.status === "done" && tRoles.includes("analysis")) {
      const parent = this.one(
        `SELECT p.id AS id, p.status AS status, p.owner AS owner, p.meta AS meta FROM relations r JOIN artefacts p ON p.id = r.dst_id
         WHERE r.relation = 'child_of' AND r.src_id = ? LIMIT 1`, id,
      );
      const implSession = parent ? JSON.parse(parent.meta ?? "{}").session : undefined;
      const analysisSession = JSON.parse(row.meta ?? "{}").session;
      if (parent?.status === "in_progress" && implSession && analysisSession && implSession === analysisSession) {
        await this.transition(
          { id: parent.id, to: "todo", note: `analysis complete (${id}) — released for fresh-claim implementation` },
          "system:separation",
        );
      }
    }
    // (done open-children gate lives in machine.ts RULES — BR#2420)
    // BR#3361 (c): a done card that claims close legs must be auditable —
    // stamp the legs + the parsed receipts from the done note so the
    // closure-receipt audit sweep can live-verify them post-done (the
    // BR#3220 class: a done card reporting a close that never happened).
    if (row.type === "task" && verdict.status === "done") {
      const doneNote = String(body?.note ?? body?.resolution ?? body?.reason ?? "").trim();
      const legs = parseCloseLegs(`${doneWhenSection(String(row.body_md ?? ""))}\n${doneNote}`);
      if (legs.length) {
        meta.close_leg_audit = {
          ts,
          legs: legs.map((l) => ({ repo: l.repo, number: l.number })),
          receipts: legs.map((l) => ({ ...l, ...(parseClosureReceipt(doneNote, l) ?? { closed: false, commentId: null, guardRun: null }) })),
          checked_ts: null,
        };
      }
      // BR#3819 (C): every forced close is LOUD — the gate passed because the
      // done note named every open child with a reason; stamp the defect the
      // close repaired on the card (meta + version log + audit) so the trail
      // shows exactly which children were closed-by-force and why. No silent
      // paths: a force-close without this receipt-of-record is a gate bypass.
      const fc = parseForceClose(doneNote);
      if (fc) {
        meta.force_close = { ts, children: fc.ids, reason: fc.reason, actor, note: fc.raw };
        this.audit("system:gate", "force_close_with_reason", id, { children: fc.ids, reason: fc.reason, actor });
        this.version(id, actor, "note", `force-closed with open child(ren) ${fc.ids.join(", ")} named in the done note — defect repaired loudly (BR#3819): ${fc.reason.slice(0, 160)}`, { force_close: { children: fc.ids, reason: fc.reason } });
      }
    }
    // BR#3361 (d): duplicate-executor fence, visible half. A transition by a
    // session that is NOT the stamped executor while the executor's liveness
    // is fresh is observable (audit duplicate_executor) — the BR#3348 class:
    // two executor sessions doing the same GH paperwork concurrently.
    // Advisory: additive contributions (log_progress) are legitimate and
    // never audited here; this fires on state-changing ops only, and only
    // when the acting session named itself (an unnamed session on a shared
    // token is ambiguous — the token's last-session fallback must not frame
    // the holder's own session).
    try {
      const holder = JSON.parse(row.meta ?? "{}");
      const actingSession = body.session ? await this.resolveSession(body, String(body.token_id ?? "")) : undefined;
      const holderSession = holder.session;
      if (
        row.type === "task" && row.status === "in_progress" &&
        holderSession && actingSession && holderSession !== actingSession
      ) {
        const holderAlive = Math.max(holder.last_progress?.ts ?? 0, holder.session_alive_ts ?? 0, row.updated_ts ?? 0);
        if (Date.now() - holderAlive <= 10 * 60_000) {
          this.audit("system:fence", "duplicate_executor", id, {
            holder: holderSession, actor: actingSession, from: row.status, to,
          });
        }
      }
    } catch { /* the fence is observability — never blocks the gate */ }
    // body_md rides the transition too when the caller supplies it (the train's
    // bounce/stop briefs append to the card body on the same write) — absent a
    // supplied body, the existing body is preserved.
    const nextBodyMd = typeof body.body_md === "string" && body.body_md.trim()
      ? body.body_md
      : String(row.body_md ?? "");
    this.state.storage.sql.exec(
      `UPDATE artefacts SET status = ?, status_ts = ?, meta = ?, updated_ts = ?, owner = ?, tags = ?, body_md = ? WHERE id = ?`,
      verdict.status, ts, JSON.stringify(meta), ts, verdict.owner_clear ? "" : owner, JSON.stringify(tagsForWrite(verdict, tTags)), nextBodyMd, id,
    );
    // post-conditions on the single write path: violations are breaches (a
    // loud audited trail), never silent repairs.
    const violations = checkInvariants({ type: row.type, status: verdict.status, roles: tRoles, tags: tTags, meta });
    if (violations.length) {
      this.audit("system:invariants", "invariant_violation", id, { violations, from: row.status, to: verdict.status });
      this.version(id, "system:invariants", "note", `INVARIANT VIOLATION after ${row.status} → ${verdict.status}: ${violations.join("; ")}`, { violations });
      try { await this.foldBreaches(id); } catch { /* the breach door never blocks the gate */ }
    }
    if (verdict.status === "superseded" && body.replacement_id) {
      const rep = this.one(`SELECT id, type FROM artefacts WHERE id = ?`, String(body.replacement_id));
      // BR#3819 (A): no self-edges from ANY write path — a card superseding
      // itself is the same unrepresentable state the link API refuses.
      if (rep && rep.type === row.type && String(body.replacement_id) !== id)
        this.state.storage.sql.exec(
          `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'supersedes', ?, ?)`,
          String(body.replacement_id), id, ts,
        );
    }
    this.audit(actor, "transition", id, {
      from: row.status, to: verdict.status, note: body.note ?? "", sentiment,
      ...(attributedAgent ? { agent: attributedAgent } : {}),
      ...(body.result_class ? { result_class: String(body.result_class).slice(0, 60) } : {}),
    });
    this.version(id, actor, "transition", `${row.status} → ${verdict.status}${body.note ? ` — ${String(body.note).slice(0, 120)}` : ""}`, { from: row.status, to: verdict.status, note: body.note ?? "" });
    // SERIALIZED MERGE TRAIN (BR#3516): a verify duty closing done on an impl
    // card is the ACCEPT event — stamp the card's PR provenance and queue it
    // onto the train (the train owns delivery; the verifier never merges).
    // The hub parses the PR + head from BOARD data only (no hub GitHub calls).
    if (row.type === "task" && verdict.status === "done" && parseTags(row.roles ?? "").includes("review")) {
      try {
        const parent = this.one(
          `SELECT p.id AS id, p.status AS status, p.meta AS meta FROM relations r JOIN artefacts p ON p.id = r.dst_id WHERE r.relation = 'child_of' AND r.src_id = ? LIMIT 1`,
          id,
        );
        // BR#3659 defect 2 — the close-hook guards live HERE, not inside
        // trainQueueOnAccept: the accept hook is also driven by the
        // verdict-accept path, which legitimately queues an in_progress card
        // (a human accepting the verdict IS the accept event). A verify
        // CLOSE on an in_progress (bounced) parent — or one blocked on a
        // non-train reason — is not an accept: the bounce/park stands until
        // the card re-enters review and a fresh verify duty closes.
        if (parent?.id) {
          const pm = JSON.parse(parent.meta ?? "{}");
          const parkReason = [String(pm.blocked?.reason ?? ""), String(pm.blocked_reason ?? "")].find((r) => r) ?? "";
          if (parent.status === "in_progress") {
            // BR#4067 self-heal: an in_progress parent stands UNLESS the train
            // itself bounced it non-conflict (a coverage/gate-kind bounce left
            // nothing for impl to repair — this fresh verify accept IS the
            // re-acceptance; re-queue instead of stranding the card: the PR
            // #257 class). A CONFLICT bounce is real impl repair (BR#3659
            // defect 2), and a card never bounced by the train is a live
            // claim the hub must not hijack — both stand.
            const bt = (pm.merge_train ?? {}) as Record<string, unknown>;
            const trainBounced = bt.state === "bounced";
            const realConflict = bt.bounce_kind === "conflict"
              || (Array.isArray(bt.conflict_files) && (bt.conflict_files as string[]).length > 0);
            if (!trainBounced || realConflict) {
              this.audit("system:merge-train", "queue_skipped", parent.id, { reason: trainBounced ? "conflict bounce — impl repair stands until a fresh verify accepts the new head (BR#3659 defect 2)" : "parent is in_progress without a train bounce — a live claim the hub must not hijack (BR#3659 defect 2)" });
              this.version(parent.id, "system:merge-train", "queue_skipped", "verify close on an in_progress card did not re-queue it — the bounce/claim stands", {});
            } else {
              await this.trainQueueOnAccept(parent.id, { note: String(body.note ?? "") }, actor);
              this.audit("system:merge-train", "requeued_after_bounce", parent.id, { reason: `bounce was ${String(bt.bounce_kind ?? "gate")}-kind with no conflict files — the fresh verify accept re-queues (BR#4067 self-heal)` });
            }
          } else if (parent.status === "blocked" && !parkReason.startsWith(MERGE_TRAIN_REASON_PREFIX)) {
            this.audit("system:merge-train", "queue_skipped", parent.id, { reason: "parent is blocked on a non-train reason — parked deliberately; the verify close did not queue it" });
          } else {
            await this.trainQueueOnAccept(parent.id, { note: String(body.note ?? "") }, actor);
          }
        }
      } catch (e) {
        this.audit("system:merge-train", "queue_hook_error", id, { error: String((e as Error).message ?? e).slice(0, 200) });
      }
    }
    // verify-verdict decisions are actionable: the human's answer DOES the
    // thing, not just records it. Accepting a VERIFIED verdict closes the
    // verified task (the accepted decision satisfies its done-gate via the
    // supports link). Accepting a BOUNCE verdict bounces the task back to
    // work with the findings. Without this, verdicts pile up as prose and the
    // human's click changes nothing — 35 proposed decisions taught us that.
    if (row.type === "decision" && verdict.status === "accepted") {
      const dm = meta ?? {};
      if (dm.decision_class === "verify-verdict") {
        const target = String(dm.task ?? dm.verify_target ?? "").trim();
        const isBounce = String(dm.verdict ?? "").toLowerCase() === "bounce";
        if (target) {
          // verifiers often apply their own verdict before proposing it — the
          // task is already done/bounced/queued. Ratification must be a clean
          // no-op, not an "apply failed" error the human has to interpret.
          const cur = this.one(`SELECT status, roles, meta FROM artefacts WHERE id = ?`, target);
          const curRoles = parseTags((cur as any)?.roles ?? "");
          const targetIsVerify = curRoles.includes("review");
          const already = cur && (isBounce
            ? cur.status === "in_progress"
            : targetIsVerify
              ? cur.status === "done"
              : String(JSON.parse(cur.meta ?? "{}")?.merge_train?.state ?? "") === "queued");
          if (already) {
            this.audit(actor, "verdict_already_applied", target, { decision: id, status: cur.status });
          } else if (!isBounce && !targetIsVerify && cur?.status === "in_progress") {
            // VERIFIED verdict landing on an IMPL card: under the serialized
            // merge train the card is QUEUED, not closed (BR#3516 — the train
            // owns delivery; the merge event closes it later). Same accept
            // event as the verify-close hook, cited from the decision body.
            await this.trainQueueOnAccept(target, { note: String((meta?.body_md ?? this.one(`SELECT body_md FROM artefacts WHERE id = ?`, id)?.body_md) ?? "") }, actor);
            this.audit(actor, "verdict_applied", target, { decision: id, effect: "queued" });
          } else try {
            await this.transition(
              {
                id: target,
                to: isBounce ? "in_progress" : "done",
                note: isBounce
                  ? `verdict ${id} rejected by human — bounce with the verifier's findings`
                  : `verdict ${id} accepted by human — closed on a verified (non-void) verdict`,
              },
              actor,
            );
            this.audit(actor, "verdict_applied", target, { decision: id, effect: isBounce ? "bounced" : "closed" });
          } catch (e) {
            // gate refused (e.g. open children) — surface it on the decision
            // instead of silently swallowing the human's click
            const msg = String((e as Error).message ?? e).slice(0, 300);
            this.audit("decision:verdict", "apply_failed", target, { decision: id, error: msg });
            this.version(id, "decision:verdict", "note", `verdict apply failed on ${target}: ${msg}`, { target, error: msg });
          }
        }
      }
    }
    // BR#3457 act-time prong: the human acted on THIS verdict — any other
    // still-proposed verdict for the same target must not survive to regrow
    // the For Me card (legacy stacked rounds created before the create-time
    // sweep, or create-race stragglers). The sweeper's own transitions don't
    // cascade — the guard keeps the takeover verdict safe.
    if (row.type === "decision" && (verdict.status === "accepted" || verdict.status === "superseded") && actor !== "system:verdictsweep") {
      const dm = meta ?? {};
      if (dm.decision_class === "verify-verdict") {
        const target = String(dm.task ?? dm.verify_target ?? "").trim();
        if (target) await this.supersedeStaleVerdicts(target, id, `superseded by human action on ${id} — one actionable verdict per target (BR#3457)`);
      }
    }
    // ---- execute the effects the executor decided (do.ts never decides) ----
    let verifyTaskId: string | undefined;
    for (const fx of verdict.effects) {
      switch (fx.kind) {
        case "spawn_verify": {
          // verification duty: entering review spawns the Verify task into the
          // unclaimed pool. A verifier (any agent, fresh session) picks it up,
          // checks receipts, completes it, then closes the parent (done) or
          // bounces it (in_progress with findings).
          const rootTitle = row.title.replace(/^(?:Verify:\s*)+/, "");
          // Receipt URL for the verify body. The authoritative meta.pr stamp
          // (repo+number → canonical URL) wins; a scraped fx.pr must still
          // parse as a clonable reference — a wrapped-prefix fragment
          // ("…/state-vector/super") once dispatched a ghost clone and
          // churned the card (BR#3845). Nothing resolvable → "see note": a
          // repo-less dispatch, never a ghost clone.
          const stamp = (meta?.pr ?? {}) as { repo?: unknown; number?: unknown };
          const prLink: string =
            typeof stamp.repo === "string" && stamp.repo && Number(stamp.number) > 0
              ? `https://github.com/${stamp.repo}/pull/${Number(stamp.number)}`
              : fx.pr && isClonableRepoRef(fx.pr)
                ? fx.pr
                : "see note";
          // BR#5190: the fast-lane note rides the duty only for a QUALIFIED
          // root-fix parent (tags + binding) with a PR stamp — no stamp, no
          // fast lane to name.
          const parentIsRootFix =
            isRootFixCard({ tags: parseTags(row.tags), meta }) &&
            typeof stamp.repo === "string" && stamp.repo && Number(stamp.number) > 0;
          const created = await this.create(
            {
              type: "task",
              title: `Verify: ${rootTitle.slice(0, 200)}`,
              body_md: verifyDutyBody(
                id,
                rootTitle,
                prLink,
                typeof stamp.repo === "string" && stamp.repo && Number(stamp.number) > 0
                  ? { repo: stamp.repo, n: Number(stamp.number) }
                  : undefined,
                parentIsRootFix ? { repo: String(stamp.repo), pr: Number(stamp.number) } : undefined,
              ),
              roles: ["review"],
            },
            actor,
          );
          verifyTaskId = created.id;
          this.state.storage.sql.exec(
            `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
            created.id, id, ts,
          );
          this.audit(actor, "create", created.id, { type: "task", auto: "verification", parent: id });
          break;
        }
        case "reuse_verify": {
          verifyTaskId = fx.verify;
          this.audit("system:separation", "verify_reused", id, { verify: fx.verify });
          break;
        }
        case "skip_verify_spawn": {
          this.audit("system:guard", "spawn_skipped", id, { auto: "verification", reason: fx.reason });
          try { await this.foldBreaches(id); } catch { /* the breach door never blocks the gate */ }
          break;
        }
        case "spawn_unblock": {
          // every blocked task gets an unblock child — the executor already
          // ran the cap (≤1 open per parent) and the flood guard; this is the
          // only spawn site and it only executes.
          // BR#2893 spawner cap: at UNBLOCK_SPAWN_CAP failed rounds ever the
          // spawner stops and escalates once — a dead end must not manufacture
          // work about work forever.
          if (this.unblockSpawnCapped(row, meta, actor, ts)) break;
          const rootTitle = row.title.replace(/^(?:Unblock:\s*)+/, "");
          const created = await this.create(
            {
              type: "task",
              title: `Unblock: ${rootTitle.slice(0, 200)}`,
              session: "", // session-less spawn: the unblock contract is "then a
              // FRESH session" — a pre-attributed child would trip review-separation against the legitimate closer
              body_md: `Unblock duty for ${id} — "${rootTitle}".\n\nBlocked why: ${fx.reason || "see parent"}.\nExit condition: ${fx.exit_condition || "none recorded — read the card and history, then decide: clear the block, re-scope the task, or escalate via ask_agent"}.\n\nContract: check whether the exit condition now holds (live receipts, GitHub state, answered decision). If it holds: transition ${id} to in_progress with the resolution note, then close yourself done citing what unblocked it (the done note must cite receipts — ${RECEIPTS_DOC}). If it does not: record findings via log_progress and close yourself done with the findings — the done note still must cite receipts (the findings count: ${RECEIPTS_DOC}) — do NOT respawn an unblock task, do not leave yourself open.`,
              roles: ["unblock"],
            },
            actor,
          );
          this.state.storage.sql.exec(
            `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
            created.id, id, ts,
          );
          this.audit(actor, "create", created.id, { type: "task", auto: "unblock", parent: id });
          meta.last_unblock_spawn = { at: ts, exit: fx.exit_condition };
          this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), id);
          break;
        }
        case "skip_unblock_spawn": {
          if (fx.flood) {
            // BR#4282: a flood-guard skip is the dedup WORKING — the round
            // for this exact exit is already on the case. Audit observably,
            // never fold a breach card: the breach fold raising
            // spawn-while-open on the guard's own suppression was the
            // BR#4023/4135/4177/4113 loop's detection noise.
            this.audit(actor, "spawn_flood_skipped", id, { auto: "unblock", reason: fx.reason });
            break;
          }
          this.audit(actor, "spawn_skipped", id, { auto: "unblock", reason: fx.reason });
          try { await this.foldBreaches(id); } catch { /* the breach door never blocks the gate */ }
          break;
        }
        case "supersede_children": {
          // children are ephemeral: when the parent moves on, their round
          // closes. keep_newest keeps the newest verify child alive across a
          // bounce — the bounce re-enters the SAME round (the churn that
          // drowned the pool was 3-6 cards per parent).
          const kids = this.state.storage.sql.exec(
            `SELECT c.id AS id, c.status AS status, c.meta AS meta, c.updated_ts AS uts FROM relations r JOIN artefacts c ON c.id = r.src_id
             WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked') AND (c.roles LIKE ? OR c.tags LIKE ?) ORDER BY c.updated_ts DESC`,
            id, `%"${fx.tag}"%`, `%"${fx.tag}"%`,
          ).toArray() as any[];
          kids.forEach((v, i) => {
            if (fx.keep_newest && i === 0) return;
            const vm = JSON.parse(v.meta ?? "{}");
            vm.superseded_reason = fx.cause;
            this.state.storage.sql.exec(
              `UPDATE artefacts SET status = 'superseded', meta = ?, status_ts = ?, updated_ts = ? WHERE id = ?`,
              JSON.stringify(vm), ts, ts, v.id,
            );
            this.audit("system:separation", "transition", v.id, { from: v.status, to: "superseded", note: fx.cause });
            this.version(v.id, "system:separation", "transition", fx.cause, { from: v.status, to: "superseded" });
          });
          break;
        }
        case "escalate": {
          this.audit("system:churn-guard", "escalated", id, { attempts: fx.attempts, silent_cycles: fx.silent_cycles, duty: tRoles[0] ?? "unknown" });
          // a NOTE, not a second transition row: the applied transition above
          // already stamped the real from→to. A duplicate transition stamp
          // with the stale pre-applied from broke the version-log chain and
          // re-fired the replay breach on every later transition (BR#3322).
          this.version(id, "system:churn-guard", "note", `escalated to human — verdict duties cannot block (attempts ${fx.attempts}, silent cycles ${fx.silent_cycles})`, { attempts: fx.attempts, silent_cycles: fx.silent_cycles });
          break;
        }
        case "release_redirect": {
          this.audit("system:churn-guard", "release_redirected", id, { attempts: fx.attempts, silent_cycles: fx.silent_cycles, from: row.status });
          // same: the redirect IS the applied transition — explain it as a note
          this.version(id, "system:churn-guard", "note", `release redirected to blocked — ${fx.attempts} attempts without completion`, { attempts: fx.attempts, silent_cycles: fx.silent_cycles });
          break;
        }
      }
    }
    // BR#4068 starvation law — retire the LIVE-LEG asks of a card that is
    // leaving the board. The bounce re-files the human review ask as a
    // child_of question; open questions are children, and the done gate
    // fences a parent with open children — so the train's landed close
    // (blocked→in_progress→done) would bounce off done-open-children while
    // the ask sat unanswered. When the subject lands or is superseded the
    // leg is moot: auto-retire ONLY the asks this law filed (meta.ask
    // .review_leg), leaving human asks, decisions and every other question
    // child untouched.
    if (row.type === "task" && (to === "done" || to === "superseded")) {
      const openAsks = this.state.storage.sql.exec(
        `SELECT c.id AS id, c.status AS status, c.meta AS meta FROM relations r JOIN artefacts c ON c.id = r.src_id
         WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked') AND c.type = 'question'`,
        id,
      ).toArray() as any[];
      for (const ask of openAsks) {
        const am = JSON.parse(ask.meta ?? "{}");
        if (am.ask?.review_leg !== true || am.ask.answer) continue;
        am.ask = { ...am.ask, answer: to === "superseded" ? "subject superseded — review leg retired (BR#4068)" : "subject landed — review leg retired (BR#4068)", answered_by: "system:starvation-law", answered_ts: ts };
        const ansTs = Date.now();
        this.state.storage.sql.exec(
          `UPDATE artefacts SET meta = ?, status = 'done', status_ts = ?, updated_ts = ? WHERE id = ?`,
          JSON.stringify(am), ansTs, ansTs, ask.id,
        );
        this.version(ask.id, "system:starvation-law", "transition", `answered by system:starvation-law: ${am.ask.answer}`, { from: ask.status, to: "done", answer: am.ask.answer });
        this.audit("system:starvation-law", "ask", id, { review_leg_retired: ask.id, subject: id, to });
      }
    }
    // replay consistency: fold the version log forward and compare with the
    // stored state — fold(events) != stored_state is itself a breach
    // (BR#2419 item 6).
    try { await this.replayCheck(id); } catch { /* fail-soft: the log fold never blocks a legal write */ }
    return { id, status: verdict.status, ...(sentiment ? { sentiment } : {}), verify_task: verifyTaskId };
  }

  private async link(body: any, actor: string) {
    const srcId = String(body.src ?? ""), rel = String(body.relation ?? ""), dstId = String(body.dst ?? "");
    if (!isRelation(rel)) throw new Error(`unknown relation '${rel}'`);
    const src = this.one(`SELECT id, type, tags, roles FROM artefacts WHERE id = ?`, srcId);
    const dst = this.one(`SELECT id, type, tags, roles FROM artefacts WHERE id = ?`, dstId);
    if (!src || !dst) throw new Error("both src and dst must exist");
    // BR#3819 (A): self-edges are unrepresentable — a card is never its own
    // child, parent, supporter, or supersedee, for EVERY relation kind. The
    // BR#3423 class: a rollup stamped a card child_of ITSELF; the
    // done-open-children gate then counted the card as its own open child
    // forever — every →done rejected "still has 1 open child task(s)" with
    // no agent-repairable exit (MCP has no unlink). The wrong state cannot
    // be expressed; the rejection is loud, never silently dropped. Checked
    // BEFORE relation-type semantics so every kind reports the honest reason.
    if (srcId === dstId)
      throw new Error(`link rejected: ${srcId} → '${rel}' → ${dstId} is a self-edge — a card cannot be related to itself (BR#3819)`);
    const verdict = validateRelation(rel, src.type as ArtefactType, dst.type as ArtefactType);
    if (verdict.ok === false) throw new Error(verdict.reason);
    // verify-of-verify is structurally impossible: a verify task can never be
    // a child of a verify task (or of an unblock task — same ephemerality).
    // Enforced here at the relation level, not just the auto-spawn path.
    if (rel === "child_of") {
      const childRoles = parseTags((src as any).roles);
      const parentRoles = parseTags((dst as any).roles);
      if (childRoles.includes("review") && (parentRoles.includes("review") || parentRoles.includes("unblock")))
        throw new Error(`link rejected: ${srcId} is a verify task — verify tasks are terminal-at-birth and cannot nest under ${parentRoles.includes("review") ? "another verify" : "an unblock"} task`);
      if (childRoles.includes("unblock") && (parentRoles.includes("unblock") || parentRoles.includes("review")))
        throw new Error(`link rejected: ${srcId} is an unblock task — unblock tasks are terminal-at-birth and cannot nest under another ephemeral task`);
      // ONE-OPEN-VERIFY-CHILD INVARIANT (2026-10-25, Ray GO): linking a second
      // open verify child under the same parent supersedes the older one
      // (keep-newest) instead of stacking. The spawn path already reuses; this
      // is the structural backstop for every other path that creates+links.
      if (childRoles.includes("review") && !["done", "superseded"].includes(String((src as any).status))) {
        const openSiblings = this.state.storage.sql.exec(
          `SELECT c.id AS id, c.updated_ts AS uts FROM relations r JOIN artefacts c ON c.id = r.src_id
           WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.id != ?
             AND c.roles LIKE '%"review"%' AND c.status IN ('todo','in_progress','blocked')
           ORDER BY c.updated_ts ASC`,
          dstId, srcId,
        ).toArray() as any[];
        for (const sib of openSiblings) {
          const vm = JSON.parse(this.one(`SELECT meta FROM artefacts WHERE id = ?`, sib.id)?.meta ?? "{}");
          vm.superseded_reason = `${srcId} linked as the parent's verify round — older open verify child superseded (one round, N bounces)`;
          this.state.storage.sql.exec(
            `UPDATE artefacts SET status = 'superseded', meta = ?, updated_ts = ? WHERE id = ?`,
            JSON.stringify(vm), Date.now(), sib.id,
          );
          this.audit("system:invariant", "verify_superseded", sib.id, { parent: dstId, newer: srcId, reason: "one-open-verify-child" });
        }
      }
    }
    // nesting depth cap: child_of chains max 3 deep — references give structure,
    // not unbounded trees (verify recursion taught us this the hard way)
    if (rel === "child_of") {
      let cursor = dstId, depth = 0, hit: string | undefined;
      while (depth < 10) {
        const p = this.one(
          `SELECT p.id AS id FROM relations r JOIN artefacts p ON p.id = r.dst_id
           WHERE r.relation = 'child_of' AND r.src_id = ? LIMIT 1`, cursor,
        );
        if (!p) break;
        depth++;
        if (depth >= 3) { hit = `${dstId} is already 3 levels deep in a child_of chain — nesting is capped at 3 to keep the task graph flat`; break; }
        cursor = p.id;
      }
      if (hit) throw new Error(`link rejected: ${hit}`);
    }
    const count = this.one(
      `SELECT COUNT(*) AS n FROM relations WHERE src_id = ?`, srcId,
    ) as any;
    if (Number(count.n) >= LIMITS.relationsPerArtefact)
      throw new Error(`artefact ${srcId} already has ${LIMITS.relationsPerArtefact} relations`);
    this.state.storage.sql.exec(
      `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, ?, ?, ?)`,
      srcId, rel, dstId, Date.now(),
    );
    this.audit(actor, "link", srcId, { relation: rel, dst: dstId });
    return { src: srcId, relation: rel, dst: dstId };
  }

  private async relations(id: string) {
    const out = this.state.storage.sql.exec(
      `SELECT relation, dst_id AS artefact_id, 'out' AS dir FROM relations WHERE src_id = ?
       UNION ALL
       SELECT relation, src_id AS artefact_id, 'in' AS dir FROM relations WHERE dst_id = ?`,
      id, id,
    ).toArray();
    return { id, relations: out };
  }

  /** Done-transition events in range: true transition rows from the ledger
   *  (immune to later status flips) + the status_ts fallback for currently-done
   *  tasks whose history has compacted. Shared by metrics.throughput (BR#2937)
   *  and metrics.reports (BR#5126). */
  private doneEventsInRange(from: number): { events: DoneEvent[]; fallback: FallbackDone[] } {
    // task ids — only tasks count (decisions/goals have their own lifecycles)
    const taskIds = new Set(
      (this.state.storage.sql.exec(`SELECT id FROM artefacts WHERE type = 'task'`).toArray() as any[]).map((r) => String(r.id)),
    );
    // done transition events in range (LIKE prefilter, JSON.parse for truth —
    // data carries {from, to}; ask-answer rows carry {status:'done'} instead)
    const events: DoneEvent[] = [];
    for (const r of this.state.storage.sql.exec(
      `SELECT ts, artefact_id, data FROM ledger
       WHERE kind = 'mutation' AND action = 'transition' AND ts >= ? AND data LIKE '%"to":"done"%'`,
      from,
    ).toArray() as any[]) {
      let to = "";
      try { to = String(JSON.parse(r.data ?? "{}").to ?? ""); } catch { continue; }
      if (to !== "done" || !taskIds.has(String(r.artefact_id))) continue;
      events.push({ ts: Number(r.ts), artefact_id: String(r.artefact_id) });
    }
    // compaction fallback: currently-done tasks with no done-transition row
    const fallback = (this.state.storage.sql.exec(
      `SELECT id, status_ts FROM artefacts WHERE type = 'task' AND status = 'done' AND status_ts >= ?`,
      from,
    ).toArray() as any[]).map((r) => ({ id: String(r.id), status_ts: Number(r.status_ts) }));
    return { events, fallback };
  }

  /** Task-done throughput (BR#2937): done transitions per bucket + cumulative,
   *  aggregated from ledger mutation rows (true transition events — immune to
   *  later status flips) with a status_ts fallback for rows whose history has
   *  compacted. Read-only; no audit (reads don't ledger). */
  private async metricsThroughput(sp: URLSearchParams) {
    const parsed = parseThroughputParams(sp.get("bucket"), sp.get("range"));
    if ("error" in parsed) throw new Error(parsed.error);
    const now = Date.now();
    const from = now - parsed.rangeDays * 86_400_000;
    const { events, fallback } = this.doneEventsInRange(from);
    const buckets = aggregateThroughput(events, fallback, { bucket: parsed.bucket, rangeDays: parsed.rangeDays, now });
    return {
      bucket: parsed.bucket,
      range_days: parsed.rangeDays,
      from_ts: buckets[0]?.t ?? from,
      to_ts: now,
      total: buckets.reduce((n, b) => n + b.n, 0),
      buckets,
    };
  }

  /** Reports view (BR#5126): tasks-done + PR merge throughput on ONE shared
   *  bucket grid. Tasks ride the same ledger aggregation as metrics.throughput;
   *  PRs aggregate the train_events ledger (kind=merged, bounces per bucket for
   *  merge-health context). Read-only; no audit (reads don't ledger). */
  private async metricsReports(sp: URLSearchParams) {
    const parsed = parseThroughputParams(sp.get("bucket") ?? "hour", sp.get("range") ?? "3d");
    if ("error" in parsed) throw new Error(parsed.error);
    const now = Date.now();
    const from = now - parsed.rangeDays * 86_400_000;
    const opts = { bucket: parsed.bucket, rangeDays: parsed.rangeDays, now };
    const { events, fallback } = this.doneEventsInRange(from);
    const taskBuckets = aggregateThroughput(events, fallback, opts);

    const mergeEvents: DoneEvent[] = [];
    const bounceEvents: DoneEvent[] = [];
    for (const r of this.state.storage.sql.exec(
      `SELECT ts, pr, repo, kind FROM train_events WHERE kind IN ('merged','bounced') AND ts >= ?`,
      from,
    ).toArray() as any[]) {
      const ev: DoneEvent = { ts: Number(r.ts), artefact_id: `${String(r.repo)}#${Number(r.pr)}` };
      (r.kind === "merged" ? mergeEvents : bounceEvents).push(ev);
    }
    // identical opts ⇒ identical grid — zip the bounce counts onto the merge buckets
    const prBuckets = aggregateThroughput(mergeEvents, [], opts);
    const bounceBuckets = aggregateThroughput(bounceEvents, [], opts);
    for (let i = 0; i < prBuckets.length; i++) (prBuckets[i] as any).bounced = bounceBuckets[i]?.n ?? 0;
    return {
      bucket: parsed.bucket,
      range_days: parsed.rangeDays,
      from_ts: taskBuckets[0]?.t ?? from,
      to_ts: now,
      tasks: { total: taskBuckets.reduce((n, b) => n + b.n, 0), buckets: taskBuckets },
      prs: {
        total: prBuckets.reduce((n, b) => n + b.n, 0),
        bounced_total: bounceBuckets.reduce((n, b) => n + b.n, 0),
        buckets: prBuckets,
      },
    };
  }

  private async stats() {
    const byType = this.state.storage.sql.exec(
      `SELECT type, status, COUNT(*) AS n FROM artefacts GROUP BY type, status ORDER BY type`,
    ).toArray();
    const tick = this.one(`SELECT value FROM settings WHERE key = 'watchdog.last_tick'`);
    const sweep = this.one(`SELECT value FROM settings WHERE key = 'watchdog.sweep'`);
    const proseRow = this.one(`SELECT value FROM settings WHERE key = 'prose_blocked_count'`);
    let prose_blocked: Record<string, unknown> | undefined;
    try { prose_blocked = proseRow ? JSON.parse(String(proseRow.value)) : undefined; } catch { /* old shape */ }
    const openAsks = this.one(`SELECT COUNT(*) AS n FROM asks WHERE status = 'open'`)?.n ?? 0;
    let watchdog: Record<string, unknown> | undefined;
    try {
      const recent = this.state.storage.sql.exec(
        `SELECT op, ts FROM events WHERE artefact_id = 'watchdog' ORDER BY seq DESC LIMIT 3`,
      ).toArray() as any[];
      watchdog = {
        last_tick: tick ? Number(tick.value) : 0,
        next_alarm_ts: await this.state.storage.getAlarm(),
        recent_events: recent.map((e) => ({ op: e.op, age_min: Math.round((Date.now() - Number(e.ts)) / 60000) })),
        open_asks: openAsks,
        ...(sweep ? JSON.parse(sweep.value) : {}),
        // BR#4416: the prose-park population canary, emitted every proxy sweep
        prose_blocked_count: prose_blocked,
      };
    } catch { /* older sweep shape */ }
    // BR#4212 channel health: per-route ok/err + storage-fault counters, so
    // "channel down" is MACHINE-CHECKABLE by the watchdog (write success rate
    // + fault recency) instead of inferred from silence — phantom stalls
    // distinguishable from real ones (feeds BR#4067's typed-proxy parks).
    // clientDisconnected itself is a CF-analytics metric invisible inside the
    // DO; the in-DO proxies are the route error rate, entry_faults, and
    // ws_send_fail (failed hibernating-WS fanout sends). last_flush is the
    // alarm tick's persisted snapshot — in-memory counters reset at isolate
    // boot (window_started_ts says when).
    let writeOk = 0, writeErr = 0;
    for (const [route, rec] of Object.entries(this.routeStats)) {
      if (!route.startsWith("POST")) continue;
      writeOk += rec.ok; writeErr += rec.err;
    }
    const flushedRow = this.one(`SELECT value FROM settings WHERE key = 'channel_stats'`);
    let lastFlush: any = null;
    try { lastFlush = flushedRow ? JSON.parse(flushedRow.value) : null; } catch { /* old shape */ }
    return {
      counts: byType,
      watchdog,
      channel: {
        window_started_ts: this.routeStatsStarted,
        write_ops: { ok: writeOk, err: writeErr },
        ...(writeOk + writeErr > 0 ? { write_ok_rate: Math.round((writeOk / (writeOk + writeErr)) * 1000) / 1000 } : {}),
        routes: this.routeStats,
        entry_faults: this.storageFaults,
        ws_send_fail: this.wsSendFail,
        board: { builds: this.boardBuilds, pushes: this.boardPushes }, // BR#4362: push health — builds bounded ≤~1/s under storm
        rate_limited: this.rlLimited, // BR#4397: pull-surface 429s served
        last_flush: lastFlush,
      },
    };
  }

  /**
   * Fine-grained progress from a working agent: note + sentiment, shown live on the board.
   * Optional self-reported gauge fields: completion_pct, confidence_pct, risk_pct, context_pct (0–100).
   * completion = how far along; confidence = belief the result is right; risk = chance of
   * failure/drift. Correlated, not the same — charted as separate series.
   */
  private async progressLog(body: any, actor: string) {
    const id = String(body.id ?? "");
    const note = String(body.note ?? body.did ?? "").trim().slice(0, 500);
    const will = String(body.will ?? "").trim().slice(0, 500);
    const sentiment = isSentiment(body.sentiment) ? body.sentiment : "neutral";
    const pct = (v: any) => (Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : undefined);
    const completion_pct = pct(body.completion_pct);
    const confidence_pct = pct(body.confidence_pct);
    const risk_pct = pct(body.risk_pct);
    const context_pct = pct(body.context_pct);
    // contributions to question tasks (consensus rounds, open questions) land
    // additively without claiming the card — flagged so the reply carries the
    // "answered, not claimed" postscript
    let questionContribution = false;
    const row = this.one(`SELECT id, type, status, owner, meta, tags, roles FROM artefacts WHERE id = ?`, id);
    if (!row) throw new Error(`no such artefact: ${id}`);
    const meta = JSON.parse(row.meta ?? "{}");
    const m = this.settingsMap();
    const myScore = this.agentScores().find((a) => a.label === actor);
    const scoreLine = myScore
      ? `\n\nYour behaviour score: ${myScore.score}/100 (${myScore.grade}).` + (myScore.hints.length ? ` ${myScore.hints.join(" ")}` : "")
      : "";
    const instructions = composeBootstrap(m.project_name || "Superpositional", m.board ?? DEFAULT_BOARD) + (m.bootstrap_md ? `\n${m.bootstrap_md}` : "") + scoreLine;
    // Re-claim: logging progress on a watchdog-abandoned task flips it back to
    // in_progress (the unblock condition the watchdog promised). Subprocess
    // blocks re-claim the same way — the agent is back, the subprocess resolved.
    // Legitimately blocked tasks (human reasons) keep their status until explicitly resumed.
    const isSubprocessBlock = meta.blocked?.class === "subprocess";
    // gateway attribution (ADR BR#899): re-claims via gateway tokens attribute
    // to the dispatched agent, same as ordinary claims
    const attributedAgent = body.gateway && String(body.agent ?? "").trim()
      ? String(body.agent).trim().slice(0, 60)
      : undefined;
    if (row.status === "blocked" && ((meta.blocked?.reason ?? "").startsWith("abandoned") || isSubprocessBlock)) {
      await this.transition({ id, to: "in_progress", note: isSubprocessBlock ? "re-claimed — subprocess resolved" : "re-claimed — agent resumed (heartbeat)", gateway: body.gateway, agent: body.agent }, actor);
      delete meta.blocked; // transition cleared it in DB — don't resurrect it here
    } else if (row.status === "todo") {
      // progress on an unclaimed task = intent to work it. Claim if allowed;
      // otherwise say WHY instead of silently logging into a card that never moves.
      const tRoles: string[] = parseTags(row.roles);
      // question-type artefacts and question-kind tasks (consensus rounds,
      // BR#903): contributions never claim — the author closes with an ADR.
      // The contribution still PERSISTS below (version row + last_progress): a
      // question thread that dropped its logs would be a black hole —
      // consensus rounds live on exactly this channel.
      if (row.type === "question" || parseTags(row.tags).includes("question") || meta.kind === "question") {
        questionContribution = true;
      } else {
        const isQualifier = tRoles.includes("analysis") || tRoles.includes("review") || tRoles.includes("unblock");
        const q = isQualifier ? { ok: true } : this.qualifyCheck(row, "analysis");
        if (!q.ok) {
          return {
            id, note, will: will || undefined, sentiment, completion_pct, confidence_pct, risk_pct, context_pct, instructions,
            note_postscript: `PROGRESS LOGGED BUT TASK NOT CLAIMED — ${id} is unclaimed todo and not qualified for you (label ${actor}). transition {to: "in_progress"} will be rejected until it is qualified: complete an analysis child task, link an accepted decision, or pick qualified work. Analysis/review-role agents may claim unqualified work.`,
          };
        }
        await this.transition({ id, to: "in_progress", note: "started — progress logged", gateway: body.gateway, agent: body.agent }, actor);
      }
    }
    // (A) declared grace: a silence window for a long op, made while still
    // running. Requires a will (what the silence is FOR). Cleared by the next
    // ordinary log (the agent is back). Watchdog honors it until it lapses.
    const gm = Math.max(0, Math.min(60, Number(body.grace_minutes) || 0));
    let graceUntil: number | undefined;
    if (gm > 0) {
      if (!will) throw new Error("grace_minutes requires a will — declare what you will be doing during the silence (e.g. 're-index runs, silence ~25m')");
      graceUntil = Date.now() + gm * 60_000;
      meta.grace_until = graceUntil;
    } else {
      delete meta.grace_until; // ordinary log = agent is back
      // an ordinary log on a task with a declared subprocess window = the
      // subprocess resolved (or the agent is back mid-window) — clear it
      delete meta.subprocess;
    }
    const session = await this.resolveSession(body, String(body.token_id ?? ""));
    // gateway attribution: progress made by a gateway token on behalf of a
    // dispatched agent shows the AGENT as the actor on cards (ADR BR#899) —
    // the gateway stays in the audit trail as the actor of record.
    const progressActor = body.gateway && String(body.agent ?? "").trim()
      ? String(body.agent).trim().slice(0, 60)
      : actor;
    if (progressActor !== actor && this.isGatewayActor(actor)) {
      this.gatewayTouch(actor, progressActor); // gateway→agent edge (BR#2455)
    }
    const prev = meta.last_progress ?? {};
    meta.last_progress = {
      note, will: will || undefined, sentiment, actor: progressActor, ts: Date.now(), session: session ?? meta.session,
      completion_pct:  completion_pct  ?? prev.completion_pct,
      confidence_pct:  confidence_pct  ?? prev.confidence_pct,
      risk_pct:        risk_pct        ?? prev.risk_pct,
      context_pct:     context_pct     ?? prev.context_pct,
    };
    if (session && !meta.session) meta.session = session;
    this.state.storage.sql.exec(
      `UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`,
      JSON.stringify(meta), Date.now(), id,
    );
    this.audit(actor, "progress", id, { note, sentiment, will: will || undefined });
    this.version(id, actor, "progress", note, { note, will: will || undefined, sentiment, completion_pct, confidence_pct, risk_pct, context_pct });
    return {
      id, note, will: will || undefined, sentiment, completion_pct, confidence_pct, risk_pct, context_pct,
      grace_until: graceUntil, instructions,
      ...(questionContribution
        ? { note_postscript: (() => { const claim = humanClaimLive(meta, Date.now()); return claim
            ? `contribution logged, but ${claim.by} (human) has this question in hand until ${new Date(claim.expires_ts).toISOString()} — hold new pings; the claim auto-expires if they no-show`
            : "contribution logged on a question task — questions are answered, not claimed. The author weighs contributions and closes it with an ADR (decision artefact, derived_from the task)."; })() }
        : {}),
    };
  }

  // ---------- the breach door: one fold, one open card per (task, class) ----------
  /** The single breach door (BR#2419 item 6): fold recent audit events for a
   *  task into breach cards. One OPEN card per (task, class) key —
   *  reoccurrences coalesce onto the open card, never spawn duplicates.
   *  Call sites: every transition_rejected, invariant_violation,
   *  spawn_skipped and replay_mismatch lands here through the fold.
   *  BR#3443: a CLOSED card's events never re-fold either. Every card
   *  carries a fold high-water in meta.breach_high_water — the newest event
   *  ts its adjudication covered — and a key with any prior card only counts
   *  events strictly above that mark, so closing a card can never re-arm
   *  its key (specimen BR#3439: a duplicate raised from events that all
   *  predated the predecessor card's close). */
  private async foldBreaches(taskId: string) {
    const since = Date.now() - BREACH_WINDOW_MS * 8; // look back several windows
    const rows = this.state.storage.sql.exec(
      `SELECT ts, op, detail FROM events WHERE artefact_id = ? AND ts > ?
        AND op IN ('transition_rejected','invariant_violation','spawn_skipped','replay_mismatch')
        ORDER BY seq ASC LIMIT 200`,
      taskId, since,
    ).toArray() as any[];
    if (!rows.length) return;
    const events = rows.map((r) => {
      let d: any = {};
      try { d = JSON.parse(r.detail ?? "{}"); } catch { /* tolerate junk detail */ }
      const reason = String(d?.reason ?? (Array.isArray(d?.violations) ? d.violations[0] : "") ?? "unknown");
      return { ts: Number(r.ts), task: taskId, op: String(r.op), reason };
    });
    // BR#3443: load EVERY breach card on this task, open AND closed. Open
    // cards suppress their key (reoccurrences coalesce onto them); every
    // card's high-water fences off the events it already folded.
    const openKeys = new Set<string>();
    const highWater = new Map<string, number>(); // key → newest already-folded event ts
    const openCards = new Map<string, { id: string; meta: string; stamped: number }>();
    for (const b of this.state.storage.sql.exec(
      `SELECT id, status, meta, status_ts, created_ts FROM artefacts WHERE type = 'task' AND meta LIKE ?`,
      `%"breach_key":"${taskId}|%`,
    ).toArray() as any[]) {
      let m: any = {};
      try { m = JSON.parse(b.meta ?? "{}"); } catch { /* garbage meta is not a breach */ }
      const key = m?.breach_key;
      if (typeof key !== "string") continue;
      if (b.status === "done" || b.status === "superseded") {
        // A closed card adjudicated everything up to the moment it closed:
        // its raised group, plus every reoccurrence that coalesced while it
        // was open. Stamped cards carry the exact mark; pre-BR#3443 cards
        // fall back to their close time (then creation time). Anything
        // strictly after the mark is genuinely new evidence.
        const hw = Number(m?.breach_high_water ?? 0) || Number(b.status_ts ?? 0) || Number(b.created_ts ?? 0) || 0;
        const prev = highWater.get(key);
        if (prev === undefined || hw > prev) highWater.set(key, hw);
      } else {
        openKeys.add(key);
        // An open card covered the group it was raised from (its creation
        // for unstamped legacy cards); the pass below advances the stamp as
        // reoccurrences coalesce.
        const stamped = Number(m?.breach_high_water ?? 0) || Number(b.created_ts ?? 0) || 0;
        openCards.set(key, { id: String(b.id), meta: String(b.meta ?? "{}"), stamped });
      }
    }
    const breaches = detectBreaches(events, openKeys, { highWater });
    for (const b of breaches) {
      const gapNote =
        b.klass === "unclassified"
          ? `\n- classifier gap: NO breachClass pattern matched this reason. Either a benign flow missing a named class (add the pattern to breachClass, machine.ts — cite the specimen task) or a genuine novel defect (investigate the sample below). The "unclassified" pile is a to-do list for the classifier, never a verdict.\n`
          : "";
      const created = await this.create(
        {
          type: "task",
          title: `Breach: ${b.klass} on ${taskId} — ${b.count} event${b.count === 1 ? "" : "s"}`,
          body_md: `Structural breach detected server-side (fold over the audit stream).\n\n- class: ${b.klass}\n- task: ${taskId}\n- events: ${b.count} in the window (first ${new Date(b.first_ts).toISOString()}, last ${new Date(b.last_ts).toISOString()})\n- sample: ${b.sample}${gapNote}\nOne open card per (task, class) — reoccurrences coalesce here instead of spawning duplicates. Investigate the cause (get_history on ${taskId}, the Log), fix the loop, then close this card with what you found.`,
          tags: ["breach", `breach:${b.klass}`],
        },
        "system:breach",
      );
      this.state.storage.sql.exec(
        `UPDATE artefacts SET meta = ? WHERE id = ?`,
        JSON.stringify({ breach_key: b.key, breach_task: taskId, breach_class: b.klass, breach_count: b.count, breach_high_water: b.last_ts }),
        created.id,
      );
      this.audit("system:breach", "breach_raised", created.id, { key: b.key, task: taskId, klass: b.klass, count: b.count });
      this.version(created.id, "system:breach", "create", `breach card raised — ${b.klass} on ${taskId} (${b.count} events)`, { key: b.key, sample: b.sample });
    }
    // BR#3443: reoccurrences coalescing onto an OPEN card advance its
    // high-water, so when the card later closes, its coalesced evidence
    // stays folded instead of re-raising a duplicate.
    const maxSeen = new Map<string, number>();
    for (const e of events) {
      const key = `${e.task}|${classOf(e)}`;
      const ts = Number(e.ts);
      if (!Number.isFinite(ts)) continue;
      const cur = maxSeen.get(key);
      if (cur === undefined || ts > cur) maxSeen.set(key, ts);
    }
    for (const [key, card] of openCards) {
      const seen = maxSeen.get(key) ?? 0;
      if (seen <= card.stamped) continue;
      let m: any = {};
      try { m = JSON.parse(card.meta); } catch { /* garbage meta — still stamp the high-water */ }
      m.breach_high_water = seen;
      this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(m), card.id);
    }
  }

  /** Replay consistency (BR#2419 item 6): fold the version log's transition
   *  chain forward and compare with the stored status. A mismatch — or a
   *  broken chain (an event's `from` doesn't match the folded state:
   *  forged, deleted, or out-of-order history) — is a replay_mismatch event
   *  through the breach door. */
  private async replayCheck(id: string) {
    const row = this.one(`SELECT status FROM artefacts WHERE id = ?`, id);
    if (!row) return;
    const versions = (
      this.state.storage.sql.exec(
        `SELECT action, data FROM artefact_versions WHERE artefact_id = ? ORDER BY seq DESC LIMIT 200`,
        id,
      ).toArray() as any[]
    ).reverse();
    if (!versions.length) return;
    const events = versions.map((v) => {
      let d: any = {};
      try { d = JSON.parse(v.data ?? "{}"); } catch { /* tolerate junk rows */ }
      return { action: String(v.action), data: d };
    });
    const fold = replayStatus("", events);
    if (fold.status && fold.status !== row.status) {
      // the law: fold(events) != stored_state is itself a breach (BR#2419 item 6)
      this.audit("system:replay", "replay_mismatch", id, { stored: row.status, folded: fold.status, chain_breaks: fold.breaks });
      this.version(id, "system:replay", "note", `REPLAY MISMATCH: version log folds to '${fold.status}' (${fold.breaks} chain break${fold.breaks === 1 ? "" : "s"}) but stored status is '${row.status}'`, { stored: row.status, folded: fold.status, chain_breaks: fold.breaks });
      try { await this.foldBreaches(id); } catch { /* the breach door never blocks the gate */ }
    } else if (fold.tailBreak) {
      // The newest transition row didn't chain (a stale/duplicate stamp or a
      // silent status write just landed). The fold healed past it — but fresh
      // damage is audited the moment it happens, while historical gaps
      // (pre-gate rows, BR#3322) re-anchor silently instead of re-firing the
      // breach on every transition forever.
      this.audit("system:replay", "chain_break", id, { breaks: fold.breaks });
    }
  }

  private async getHistory(artefactId: string, limit = 100) {
    const rows = this.state.storage.sql.exec(
      `SELECT seq, ts, actor, action, summary, data FROM artefact_versions
       WHERE artefact_id = ? ORDER BY seq DESC LIMIT ?`,
      artefactId, Math.min(limit, 200),
    ).toArray().map((r: any) => ({ ...r, data: JSON.parse(r.data ?? "{}") }));
    return { artefact_id: artefactId, versions: rows };
  }

  /**
   * The open feedback round of a decision + its consensus tally (BR#903).
   * The round is the newest open question-kind child_of the decision; the
   * tally comes from its progress contributions (log_progress notes).
   * Returns undefined when the decision has no open round.
   */
  private consensusFor(decisionId: string) {
    const round = this.one(
      `SELECT c.id AS id, c.title AS title, c.status AS status, c.updated_ts AS updated_ts
       FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.type = 'task'
         AND c.status IN ('todo','in_progress','blocked')
         AND (c.tags LIKE '%"question"%' OR json_extract(c.meta, '$.kind') = 'question')
       ORDER BY c.updated_ts DESC LIMIT 1`, decisionId,
    );
    if (!round) return undefined;
    const entries = this.state.storage.sql.exec(
      `SELECT actor, summary FROM artefact_versions WHERE artefact_id = ? AND action = 'progress' ORDER BY seq ASC`,
      round.id,
    ).toArray() as any[];
    const tally = tallyConsensus(entries.map((e) => ({ actor: e.actor, note: e.summary })));
    return {
      round_id: round.id,
      round_title: round.title,
      round_status: round.status,
      round_ts: round.updated_ts,
      contributions: entries.length,
      ...tally,
    };
  }

  // ---------- identity, sessions, asks, settings, orient ----------

  /** Resolve a bearer secret to an agent identity; touches last_seen. */
  private async identify(bearer: string) {
    if (!bearer) throw new Error("missing bearer");
    const hash = await hashAuthToken(bearer);
    let row = this.one(
      `SELECT id, label, tags, principal, revoked_ts, epoch FROM auth_tokens WHERE hash = ?`,
      hash,
    );
    if (!row) {
      // absorb dev-mode write-visibility hiccups right after mint
      await new Promise((r) => setTimeout(r, 250));
      row = this.one(
        `SELECT id, label, tags, principal, revoked_ts, epoch FROM auth_tokens WHERE hash = ?`,
        hash,
      );
    }
    let stale = false;
    if (!row) {
      // BR#3787 layer 1 — grace: the PREVIOUS generation's hash keeps
      // authenticating for TOKEN_GRACE_MS after a rotation, flagged stale so
      // the gateway knows to re-vend. A mid-dispatch rotation must never
      // amputate an in-flight session (the fleet 401-storm, 2026-10-27).
      const prow = this.one(
        `SELECT id, label, tags, principal, revoked_ts, epoch, rotated_ts FROM auth_tokens WHERE prev_hash = ?`,
        hash,
      );
      if (prow && !prow.revoked_ts && graceActive(prow.rotated_ts, Date.now())) {
        row = prow;
        stale = true;
      }
    }
    if (!row) throw new Error("unknown auth token");
    if (row.revoked_ts) throw new Error("auth token revoked");
    this.state.storage.sql.exec(`UPDATE auth_tokens SET last_seen_ts = ? WHERE id = ?`, Date.now(), row.id);
    return {
      token_id: row.id,
      label: row.label,
      tags: parseTags(row.tags),
      principal: row.principal ?? null,
      token_epoch: Number(row.epoch ?? 1),
      token_stale: stale,
    };
  }

  /** BR#3787 — rotation bookkeeping: preserve the outgoing hash as the grace
   *  hash and bump the epoch the negotiated catch-up reads. Call before (or
   *  together with) the hash swap; the register() of the NEW hash is the
   *  caller's job. The OUTGOING hash's registry row persists by design —
   *  grace needs the old hash routable for the window. */
  private rotateTokenRow(id: string) {
    const old = this.one(`SELECT hash FROM auth_tokens WHERE id = ?`, id);
    this.state.storage.sql.exec(
      `UPDATE auth_tokens SET prev_hash = ?, rotated_ts = ?, epoch = COALESCE(epoch, 1) + 1 WHERE id = ?`,
      old?.hash ?? null, Date.now(), id,
    );
    return Number(old?.epoch ?? 1) + 1;
  }

  /** Ask addressees that ARE the final escalation themselves — an ask to one
   *  of these is already human mail; the TTL re-route never applies. Bare
   *  coordinator labels count (dispatch sessions ask under the coordinator's
   *  label — the same law the ask band's human filter uses). */
  private static readonly HUMAN_ASK_TARGETS = new Set(["human", "ray", "rayh", "opencode-ray"]);

  /** Can a non-human ask target still be answered? Direct token OR the
   *  gateway-dispatch edge seen inside the presence window (10 min — the
   *  same clock listAgents uses). A label with no record at all has NEVER
   *  connected: offline by construction (the BR#3930 addressee). */
  private askTargetPresence(to: string, now: number): { online: boolean; last_seen_ts: number | null; source: "token" | "gateway" | "unknown" } {
    const cutoff = now - 10 * 60_000;
    const t = this.one(`SELECT last_seen_ts FROM auth_tokens WHERE label = ? AND revoked_ts IS NULL`, to) as any;
    if (t) return { online: Number(t.last_seen_ts) >= cutoff, last_seen_ts: Number(t.last_seen_ts), source: "token" };
    const g = this.one(`SELECT last_seen_ts FROM gateway_agents WHERE agent = ? ORDER BY last_seen_ts DESC LIMIT 1`, to) as any;
    if (g) return { online: Number(g.last_seen_ts) >= cutoff, last_seen_ts: Number(g.last_seen_ts), source: "gateway" };
    return { online: false, last_seen_ts: null, source: "unknown" };
  }

  /** BR#3942 — stamp meta.ask.escalated on unanswered, offline-addressee
   *  asks (agent-identity targets only). Idempotent: a node already carrying
   *  escalated is skipped, so repeated sweeps never duplicate. `now` is
   *  injectable for the admin drill door and the alarm path passes Date.now(). */
  private async escalateStaleAsks(now: number): Promise<string[]> {
    const sMin = this.one(`SELECT value FROM settings WHERE key = 'ask_escalation_minutes'`) as any;
    const ttlMin = Math.max(5, Math.min(240, parseInt(String(sMin?.value ?? "").replace(/[^0-9]/g, ""), 10) || 30));
    const ttlMs = ttlMin * 60_000;
    const rows = this.state.storage.sql.exec(
      `SELECT id, meta, created_ts FROM artefacts
       WHERE type = 'question' AND status IN ('todo','in_progress','blocked') AND created_ts < ?`,
      now - ttlMs,
    ).toArray() as any[];
    const escalated: string[] = [];
    for (const r of rows) {
      let m: any;
      try { m = JSON.parse(r.meta ?? "{}"); } catch { continue; }
      const ask = m.ask;
      if (!ask || ask.escalated) continue;
      const to = String(ask.to ?? "");
      // human-directed, open-floor, capability-tag and session-scoped asks
      // are NOT agent-identity asks: the first are already human mail, the
      // rest are pool/roster/agent-to-agent routing that the human band
      // deliberately never claimed (AskBand's @-filter law).
      if (!to || to === "any" || to.startsWith("tag:") || to.includes("@")) continue;
      if (KnowledgeHub.HUMAN_ASK_TARGETS.has(to)) continue;
      const presence = this.askTargetPresence(to, now);
      if (presence.online) continue;
      m.ask.escalated = {
        ts: now,
        from_target: to,
        ttl_min: ttlMin,
        addressee_last_seen_ts: presence.last_seen_ts,
        presence_source: presence.source,
        reason: `addressee ${to} offline (${presence.last_seen_ts ? `last seen ${Math.round((now - presence.last_seen_ts) / 60_000)}m ago via ${presence.source}` : "never seen"}) and the ask sat unanswered ${Math.round((now - Number(r.created_ts)) / 60_000)}m > ${ttlMin}m TTL — escalated to the human For Me band with the proof below; original options intact (BR#3942)`,
      };
      this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(m), r.id);
      const summary = `ask escalated to human: ${to} offline, unanswered > ${ttlMin}m (BR#3942)`;
      this.version(r.id, "system:watchdog", "escalate", summary, { to, ttl_min: ttlMin, presence_source: presence.source });
      this.audit("system:watchdog", "ask_escalated", r.id, { to, ttl_min: ttlMin, presence_source: presence.source, artefact_bound: ask.artefact_id ?? null });
      escalated.push(r.id);
    }
    return escalated;
  }

  /**
   * Connected identities, separated by class (BR#2455): `gateways` are the
   * infrastructure tokens (each with the agent labels it dispatched recently),
   * `agents` is everyone else. MCP peers never see gateways inside the agents
   * array — a gateway is not an agent.
   */
  private async listAgents() {
    const cutoff = Date.now() - 10 * 60_000;
    const rows = this.state.storage.sql.exec(
      `SELECT label, tags, transport, last_seen_ts, revoked_ts FROM auth_tokens ORDER BY last_seen_ts DESC`,
    ).toArray().filter((a) => !a.revoked_ts);
    // Identity collapse (2026-10-29): retired display names resolve through
    // identity_aliases onto their live label — the board shows ONE identity
    // per machine/agent with the dead names carried as `aliases`, instead of
    // a pile of stale gateway/agent labels per hostname churn.
    const shape = (a: any, label: string, aliases: string[]) => ({
      label,
      ...(aliases.length ? { aliases } : {}),
      tags: parseTags(a.tags),
      transport: a.transport ?? "mcp",
      online: a.last_seen_ts >= cutoff,
      last_seen_ts: a.last_seen_ts,
    });
    const group = (filter: (a: any) => boolean) => {
      const byCanon = new Map<string, { row: any; aliases: string[] }>();
      for (const a of rows.filter(filter)) {
        const c = this.canonLabel(String(a.label ?? ""));
        const cur = byCanon.get(c);
        if (!cur) { byCanon.set(c, { row: a, aliases: [] }); continue; }
        const keep = (a.last_seen_ts ?? 0) > (cur.row.last_seen_ts ?? 0) ? a : cur.row;
        const aliases = (cur.row === keep ? cur.aliases : [...cur.aliases, cur.row.label]);
        if (a !== keep) aliases.push(a.label);
        byCanon.set(c, { row: keep, aliases });
      }
      // every retired name recorded in identity_aliases for this identity
      // shows as `aliases`, even when only one token row ever existed
      for (const [c, v] of byCanon)
        v.aliases = [...new Set([...v.aliases, ...[...this.aliasSetOf(c)].filter((l) => l !== c)])];
      return byCanon;
    };
    const agents = [...group((a) => !tagsSayGateway(a.tags)).entries()]
      .map(([c, v]) => ({ ...shape(v.row, c, v.aliases), tags: [] }))
      .sort((a, b) => b.last_seen_ts - a.last_seen_ts);
    const gateways = [...group((a) => tagsSayGateway(a.tags)).entries()]
      .map(([c, v]) => {
        // gateway→agent edges are keyed by raw historical labels — resolve
        // every alias variant of this gateway, then collapse agent labels too
        const variants = [...this.aliasSetOf(c)];
        const edges = this.state.storage.sql.exec(
          `SELECT agent, MAX(last_seen_ts) AS last_seen_ts FROM gateway_agents
           WHERE ${variants.map(() => "gateway = ?").join(" OR ")} GROUP BY agent`,
          ...variants,
        ).toArray() as any[];
        const byAgent = new Map<string, number>();
        for (const e of edges) {
          const ca = this.canonLabel(String(e.agent));
          byAgent.set(ca, Math.max(byAgent.get(ca) ?? 0, Number(e.last_seen_ts ?? 0)));
        }
        return {
          ...shape(v.row, c, v.aliases),
          agents: [...byAgent.entries()]
            .map(([label, last_seen_ts]) => ({ label, last_seen_ts }))
            .sort((a, b) => b.last_seen_ts - a.last_seen_ts)
            .slice(0, 20),
        };
      })
      .sort((a, b) => b.last_seen_ts - a.last_seen_ts);
    return { agents, gateways, note: "bridge routes between agents — gateways are listed separately with the agents they dispatched; transport shows how each is reachable today (mcp) or next (a2a, acp-proxy, board)" };
  }

  /** Does this label's token carry the gateway tag? (attribution authority) */
  private isGatewayActor(label: string): boolean {
    const row = this.one(`SELECT tags FROM auth_tokens WHERE label = ?`, label);
    return !!row && tagsSayGateway(row.tags);
  }

  /** Stamp/refresh the gateway→dispatched-agent edge (Connect grouping). */
  private gatewayTouch(gateway: string, agent: string) {
    this.state.storage.sql.exec(
      `INSERT INTO gateway_agents (gateway, agent, last_seen_ts) VALUES (?, ?, ?)
       ON CONFLICT(gateway, agent) DO UPDATE SET last_seen_ts = excluded.last_seen_ts`,
      gateway.slice(0, 80), agent.slice(0, 80), Date.now(),
    );
  }

  /** Record a retired display name → its current label (2026-10-29). */
  private recordAlias(label: string, canonical: string) {
    if (!label || label === canonical) return;
    this.state.storage.sql.exec(
      `INSERT INTO identity_aliases (label, canonical, ts) VALUES (?, ?, ?)
       ON CONFLICT(label) DO UPDATE SET canonical = excluded.canonical, ts = excluded.ts`,
      label.slice(0, 80), canonical.slice(0, 80), Date.now(),
    );
  }

  /** Transitive closure of a canonical label: itself + every retired name
   *  that resolves to it (alias chains — old→new recorded at each rename). */
  private aliasSetOf(canonical: string): Set<string> {
    const rows = this.state.storage.sql.exec(`SELECT label, canonical FROM identity_aliases`).toArray() as any[];
    const byCanonical = new Map<string, string[]>();
    for (const r of rows) {
      const list = byCanonical.get(r.canonical) ?? [];
      list.push(r.label);
      byCanonical.set(r.canonical, list);
    }
    const out = new Set<string>([canonical]);
    let frontier = [canonical];
    while (frontier.length) {
      const next: string[] = [];
      for (const c of frontier)
        for (const l of byCanonical.get(c) ?? [])
          if (!out.has(l)) { out.add(l); next.push(l); }
      frontier = next;
    }
    return out;
  }

  /** Display resolution: a retired name renders as its current label
   *  (chain-followed with a depth guard against cycles). */
  private canonLabel(label: string): string {
    let cur = label;
    for (let i = 0; i < 10; i++) {
      const row = this.one(`SELECT canonical FROM identity_aliases WHERE label = ?`, cur) as any;
      if (!row?.canonical) break;
      cur = String(row.canonical);
    }
    return cur;
  }

  /** Agent labels are namespaced under the GATEWAY's display label — a
   *  gateway rename (re-pair with the same principal, BR#3787) must not
   *  strand its provisioned agents under the dead prefix (the mac-modem →
   *  macbook-pro-local-2 pile). When `<caller>/<suffix>` is provisioned and
   *  `<oldGW>/<suffix>` exists for a name that aliases to caller, the agent
   *  token RENAMES IN PLACE: same id, same hash (the runner's stored secret
   *  keeps authenticating), same tags — only the display label moves. */
  private agentReassociateOnGatewayRename(caller: string, label: string): { id: string } | null {
    const suffix = label.slice(caller.length + 1);
    if (!suffix || suffix.includes("/")) return null;
    const prevs = this.aliasSetOf(caller);
    const olds = [...prevs].filter((p) => p !== caller).map((p) => `${p}/${suffix}`);
    if (!olds.length) return null;
    const rows = this.state.storage.sql.exec(
      `SELECT id, label FROM auth_tokens WHERE label IN (${olds.map(() => "?").join(", ")}) AND revoked_ts IS NULL`,
      ...olds,
    ).toArray() as any[];
    const old = rows[0];
    if (!old) return null;
    this.state.storage.sql.exec(`UPDATE auth_tokens SET label = ? WHERE id = ?`, label, old.id);
    this.recordAlias(old.label, label);
    this.audit(caller, "agent_reassociate", old.id, { from: old.label, to: label });
    return { id: old.id };
  }

  /** The session a write belongs to: explicit, else the token's most recent session. */
  private async resolveSession(body: any, tokenId: string): Promise<string | undefined> {
    if (body.session !== undefined) {
      const named = String(body.session ?? "").trim();
      // an explicitly EMPTY session is anonymous (hub/auto-spawned children
      // start session-less so the token's last-session fallback cannot
      // misattribute them — the first real session to act stamps the card)
      if (!named) return undefined;
      await this.sessionTouch({ token_id: tokenId, session: named, worktree: body.worktree }).catch(() => {});
      return named;
    }
    const row = this.one(
      `SELECT name FROM sessions WHERE token_id = ? ORDER BY last_seen_ts DESC LIMIT 1`, tokenId,
    ) as any;
    return row?.name ?? undefined;
  }

  /** Register/refresh a session. Names are unique per auth token.
   *  `worktree` (BR#3204): where the session's git tree lives — surfaced on
   *  orient so the board can spot two sessions sharing a checkout. */
  private async sessionTouch(body: any) {
    const token_id = String(body.token_id ?? "");
    const name = String(body.session ?? "").trim().slice(0, 80) || `session-${Math.random().toString(36).slice(2, 6)}`;
    const worktree = String(body.worktree ?? "").trim().slice(0, 400) || null;
    const ts = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO sessions (token_id, name, kind, worktree, first_seen_ts, last_seen_ts)
       VALUES (?, ?, (SELECT CASE WHEN tags LIKE '%gateway%' THEN 'gateway' END FROM auth_tokens WHERE id = ?), ?, ?, ?)
       ON CONFLICT(token_id, name) DO UPDATE SET last_seen_ts = excluded.last_seen_ts, kind = COALESCE(kind, excluded.kind),
         worktree = COALESCE(excluded.worktree, sessions.worktree)`,
      token_id, name, token_id, worktree, ts, ts,
    );
    return { session: name, worktree };
  }

  private async askCreate(body: any, actor: string) {
    const to = String(body.to ?? "any");
    const question = String(body.question ?? "").trim();
    if (!question) throw new Error("question is required");
    // the question IS the ask — one answerable sentence ending in '?'.
    // Reports, receipts and narrative belong in details (body_md).
    if (question.length > 240) throw new Error("question must be the ask itself, one sentence ≤240 chars — put reports/receipts in details");
    if (!question.endsWith("?")) throw new Error("phrase the ask as an answerable question ending in '?' — e.g. 'Do you want to merge PR #84 into main?' (you sent a status report, not a question)");
    const details = String(body.details ?? "").trim();
    // WHY IT'S ESCALATED is not optional for human-directed asks: "merge PR
    // #84?" is unanswerable without "review is red but rebuttable per guidance".
    // (Was .slice(0, 400): the cap chopped human asks mid-sentence — BR#3997
    // and BR#3983 both ended mid-clause ("includes Name; " / "sits gate-bl"),
    // which is exactly the unreadable-ask failure Ray bounced back. 1200 with
    // the narrative living in details below.)
    const reason = String(body.reason ?? "").trim().slice(0, 1200);
    if (!reason && (to === "human" || to === "ray")) throw new Error("asks to a human must state why they are escalated instead of automatic (reason: '…')");
    // PLAIN-READING BAR (2026-10-28, Ray directive): a human-directed ask must
    // be answerable on its own — what is this about, current state, why it
    // needs a human. details is that brief (rendered as markdown under the
    // question); without it an ask degrades to BR#-reference soup nobody can
    // act on. Agent-directed asks may stay light.
    if ((to === "human" || to === "ray") && !details) {
      throw new Error("human-directed asks require details: a self-contained brief (what this is about, current state, why it needs a human) — gloss every BR#/PR# reference in one clause instead of bare references");
    }
    if (!isValidAskTarget(to)) throw new Error(`invalid ask target '${to}'`);
    const artefactId = body.artefact_id ? String(body.artefact_id).trim() : "";
    // asks REQUIRE options: the human answers by clicking one of 2-4 buttons
    // (free-text refinement lives in the detail view). No options = rejected
    // at the contract, not a button-less ask the UI can't surface.
    // options are strings the human clicks — objects are flattened to their
    // label-ish field and [object Object] garbage never stores
    const options = [...new Set((Array.isArray(body.options) ? body.options : [])
      .map((o: any) => typeof o === "string" ? o
        : String(o?.label ?? o?.text ?? o?.value ?? o?.title ?? ""))
      .map((x: string) => x.trim())
      .filter((x: string) => x && !/\[object\s*object\]/i.test(x))
      .map((x: string) => x.slice(0, 200)))].slice(0, 8);
    if (options.length < 2) throw new Error("asks require 2-8 answer options — give the human one-click answers (options: ['GO', 'NO-GO'])");
    // urgency is an ASK vocabulary (contract v2 — the same words the FlowsHub
    // ingest accepts and DecisionCard renders; "time-sensitive" = the urgent
    // NOW chip), not a progress sentiment. Validating with isSentiment made
    // every urgent ask collapse to a normal-looking one: the urgent door
    // silently failed (found wiring BR#3008's stop-the-line sweep).
    const urgency = body.urgency === "time-sensitive" ? "time-sensitive" : "normal";

    // the ask IS a question node: BR#-numbered, child_of its subject, answered
    // by transition. The legacy asks row is no longer written.
    if (artefactId) {
      const dup = this.one(
        `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
         WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
           AND c.type = 'question' AND c.title = ? LIMIT 1`,
        artefactId, question.slice(0, 200),
      );
      if (dup) throw new Error(`an identical ask is already open: ${dup.id} — answer or reframe it instead of re-asking`);
    }
    const created = await this.create(
      {
        type: "question",
        title: question.slice(0, 200),
        // the artefact body must read whole even when details were skipped
        // (agent-directed asks): embed the reason so the detail view carries
        // the why, never just the bare question.
        body_md: details || (reason ? `${question}\n\nWHY ESCALATED: ${reason}` : question),
        owner: "",
        meta: { ask: { to, urgency, options, from: actor, reason: reason || undefined, artefact_id: artefactId || undefined, ...(body.review_leg ? { review_leg: true } : {}) } },
      },
      actor,
    );
    const id = created.id;
    let taskStatus: string | undefined;
    if (artefactId) {
      const row = this.one(`SELECT type, status, meta FROM artefacts WHERE id = ?`, artefactId);
      if (!row) throw new Error(`no such artefact: ${artefactId}`);
      this.state.storage.sql.exec(
        `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
        id, artefactId, Date.now(),
      );
      if (row.type === "task" && (row.status === "in_progress" || row.status === "blocked")) {
        if (row.status === "in_progress") {
          // blocked-on-ask (rule 6): the ask pauses the subject and the ANSWER
          // auto-resumes it — the unblock condition IS the ask, so the gate's
          // no-dead-end rule holds and askAnswer's resume leg finds it parked
          // with a live path out (this flip previously hard-failed: the
          // transition went out with a note but no unblock condition).
          // BR#3822: the awaiting_ask marker MUST be on the card BEFORE the
          // fold — doTransition loads the row at fold entry and the machine's
          // unblock-spawn gate reads meta.awaiting_ask from that snapshot to
          // skip the duty ("a spawned child would race the answer"); a stamp
          // after the transition lands too late, so every ask-bound block
          // leaked a racing sweep duty (BR#3798 → 3799+3800, BR#3505 → 3506).
          // Shape matches every reader: askAnswer's cleanup
          // (awaiting_ask?.ask_id === id → delete), the sweep's ask-resolution
          // cleanup and the reaper's annotation + loop-ask stamp.
          const sm = JSON.parse(row.meta ?? "{}");
          sm.awaiting_ask = { ...(sm.awaiting_ask ?? {}), ask_id: id, ts: Date.now() };
          this.state.storage.sql.exec(
            `UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(sm), artefactId,
          );
          try {
            await this.transition({
              id: artefactId, to: "blocked",
              note: `blocked on ${to}: ${question.slice(0, 100)}`,
              unblock_condition: `answer ask ${id}`,
              await_event: { event: "ask", ask_id: id },
            }, actor);
          } catch (e) {
            // the fold rejected the park — roll OUR OWN marker back so a
            // leaked awaiting_ask can't suppress the spawn gate on the card's
            // NEXT real block (or make the reaper annotate a live task as
            // waiting on an ask that isn't). Only our own: a concurrent ask
            // may have re-stamped the key for itself. Rollback is best-effort
            // and audited — the fold's rejection is the error the caller must
            // see, so this leg never converts a failed ask into a success
            // (the failure-handling finding that sank PR #229).
            try {
              const cur = this.one(`SELECT meta FROM artefacts WHERE id = ?`, artefactId);
              const cm = cur ? JSON.parse(cur.meta ?? "{}") : null;
              if (cm?.awaiting_ask?.ask_id === id) {
                delete cm.awaiting_ask;
                this.state.storage.sql.exec(
                  `UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(cm), artefactId,
                );
              }
            } catch (re) {
              this.audit(actor, "ask_marker_rollback_failed", artefactId || null, {
                ask_id: id, error: String((re as Error)?.message ?? re).slice(0, 300),
              });
            }
            throw e;
          }
          taskStatus = "blocked";
        }
      }
    }
    this.audit(actor, "ask", artefactId || null, { to, question, options, urgency, ask_id: id });
    return { id, ask: id, question, artefact_id: artefactId || undefined, options, urgency, task_status: taskStatus };
  }
  // ---------- question human-claim hold (BR#3911) ----------

  /** Human-actor authority, same shape machine.ts uses for decision
   *  acceptance: the web plane stamps `web:<login>`, humans sign `human:*`.
   *  Gateway/agent labels are rejected — a claim is a HUMAN hold. */
  private static HUMAN_ACTOR = /^web(:|$)|^human:/;

  /** BR#3911: Claim on a question = a named human takes it — a transient hold
   *  that dismisses the question from the agent surfaces ("claimed by <human>
   *  — in hand") with a 10-minute timeout that re-opens it on a no-show.
   *  Claim ≠ answer: protocol 6b stands, the question still closes via the
   *  author's ADR. This is a meta stamp, NOT a transition — the claim law
   *  (question-not-claimable) and the runner claim path are untouched, and
   *  agent claims stay forbidden. */
  private async questionClaim(body: any, actor: string) {
    if (!KnowledgeHub.HUMAN_ACTOR.test(actor))
      throw new Error("question claim is a human hold — sign in as the human in the webapp (agents: questions are answered, not claimed; contribute via log_progress)");
    const id = String(body.id ?? "");
    const row = this.one(`SELECT id, type, status, meta FROM artefacts WHERE id = ?`, id);
    if (!row) throw new Error(`no such artefact: ${id}`);
    if (row.type !== "question") throw new Error(`${id} is a ${row.type} — the claim-hold exists only on question cards (work items claim via transition, as today)`);
    if (row.status !== "todo") throw new Error(`${id} is ${row.status} — only an open question can be claimed`);
    const meta = JSON.parse(row.meta ?? "{}");
    if (meta.ask?.answer) throw new Error(`${id} is already answered — nothing to hold`);
    const minutes = Math.max(1, Math.min(60, Number(body.minutes) || this.questionClaimMinutes()));
    const ts = Date.now();
    const prior = meta.human_claimed ?? null;
    meta.human_claimed = { by: actor, ts, expires_ts: ts + minutes * 60_000 };
    this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(meta), ts, id);
    this.audit(actor, "question_claim", id, { by: actor, expires_ts: meta.human_claimed.expires_ts, minutes, prior_by: prior?.by ?? null });
    this.version(
      id, actor, "note",
      prior
        ? `human claim re-stamped by ${actor} — in hand for ${minutes}m (previous hold by ${prior.by ?? "?"} replaced)`
        : `human claim — ${actor} has this in hand for ${minutes}m; agents stand down (auto-reverts to the pool on expiry, honest churn)`,
      { human_claimed: meta.human_claimed, prior: prior ?? undefined },
    );
    return { id, human_claimed: meta.human_claimed };
  }

  /** BR#3911: the human puts the question back before the window lapses —
   *  the symmetric early exit, so a misclick doesn't park a question for the
   *  full window. Recorded like every claim change, never silent. */
  private async questionRelease(body: any, actor: string) {
    if (!KnowledgeHub.HUMAN_ACTOR.test(actor))
      throw new Error("question release is a human action — agents cannot touch a human's claim hold");
    const id = String(body.id ?? "");
    const row = this.one(`SELECT id, type, meta FROM artefacts WHERE id = ?`, id);
    if (!row) throw new Error(`no such artefact: ${id}`);
    if (row.type !== "question") throw new Error(`${id} is a ${row.type} — nothing to release`);
    const meta = JSON.parse(row.meta ?? "{}");
    const claim = humanClaimLive(meta, Date.now());
    if (!claim) throw new Error(`${id} has no live human claim — nothing to release (expired holds are already reverted by the sweep)`);
    delete meta.human_claimed;
    const ts = Date.now();
    this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(meta), ts, id);
    this.audit(actor, "question_release", id, { by: claim.by, released_by: actor });
    this.version(id, actor, "note", `human claim released early by ${actor} — back in the pool now`, { released_claim: claim });
    return { id, released: true };
  }

  /** BR#3911 timeout sweep: a live claim past its window auto-reverts — the
   *  stamp clears and the expiry lands in the version log (honest churn, not
   *  silent). The question was never anything but todo (the hold is meta, not
   *  a status), so "re-open" is exactly: the chip clears, the pool sees it
   *  again. Runs on the watchdog alarm; `admin.question_claim_sweep` drills it
   *  with an injected clock. */
  private async questionClaimSweep(now: number): Promise<number> {
    const rows = this.state.storage.sql.exec(
      `SELECT id, meta FROM artefacts WHERE type = 'question' AND status = 'todo'`,
    ).toArray() as any[];
    let expired = 0;
    for (const r of rows) {
      try {
        const meta = JSON.parse(r.meta ?? "{}");
        const c = meta.human_claimed;
        if (!c || typeof c.expires_ts !== "number" || c.expires_ts > now) continue;
        delete meta.human_claimed;
        const heldMin = Math.max(1, Math.round((c.expires_ts - Number(c.ts ?? c.expires_ts)) / 60_000));
        this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(meta), now, r.id);
        this.version(r.id, "system:watchdog", "note", `human claim expired — ${c.by ?? "a human"} held it ${heldMin}m without an answer or close; back in the pool`, { expired_claim: c });
        this.audit("system:watchdog", "question_claim_expired", r.id, { by: c.by ?? "", held_min: heldMin });
        expired++;
      } catch (e) {
        this.audit("system:watchdog", "sweep_error", r.id, { error: String((e as Error).message ?? e).slice(0, 300) });
      }
    }
    return expired;
  }

  /** Hold window from settings (`question_claim_minutes`, 1-60), defaulting to
   *  the BR#3911 spec value. */
  private questionClaimMinutes(): number {
    return Math.max(1, Math.min(60, parseInt(this.settingValue("question_claim_minutes", String(QUESTION_CLAIM_MINUTES)), 10) || QUESTION_CLAIM_MINUTES));
  }

  private async askInbox(body: any) {
    const label = String(body.label ?? "");
    // nodes are the inbox; open legacy rows are shown until the v2 migration
    // converts them (they then read status 'migrated' and vanish naturally)
    const nodes = this.state.storage.sql.exec(
      `SELECT id, meta, created_ts FROM artefacts
       WHERE type = 'question' AND status IN ('todo','in_progress','blocked')
       ORDER BY created_ts DESC LIMIT 50`,
    ).toArray() as any[];
    // BR#3578 follow-up (the cody inbox dump): the addressee filter used to
    // end in `|| true` (a debug leftover) — EVERY open ask landed in EVERY
    // agent's inbox, so a freshly-minted token inherited all ~57 human-
    // directed migration asks as its own and its score hint mis-fired. An
    // ask is yours iff it targets `any`, your exact label, your
    // label@session, or one of your capability tags (`tag:<t>`). Human-
    // directed asks (`ray`, `human`, a GitHub login) surface on the human
    // planes (For Me / ask band), never in agent inboxes.
    const tags: string[] = Array.isArray(body.tags) ? body.tags.map(String) : [];
    const inbox = nodes
      .map((n) => {
        const m = JSON.parse(n.meta ?? "{}");
        if (!m.ask) return null;
        // BR#3911: a human has this question in hand — it leaves the agent
        // pool ("stop nudging"). The hold auto-expires; the sweep clears the
        // stamp and the question resurfaces here on its own.
        if (humanClaimLive(m, Date.now())) return null;
        const out: any = { id: n.id, from_label: m.ask.from ?? "agent", to_target: m.ask.to ?? "any", question: n.title, created_ts: n.created_ts, node: true };
        if (m.ask.reframe) out.reframe = m.ask.reframe;
        return out;
      })
      .filter((x): x is any => !!x && (
        x.to_target === "any" ||
        x.to_target === label ||
        String(x.to_target).startsWith(`${label}@`) ||
        tags.some((t) => x.to_target === `tag:${t}`)
      ));
    const open = this.state.storage.sql.exec(
      `SELECT id, from_label, to_target, question, created_ts FROM asks
       WHERE status = 'open' AND from_label != ? ORDER BY created_ts DESC LIMIT 50`,
      label,
    ).toArray();
    const sent = this.state.storage.sql.exec(
      `SELECT id, to_target, question, status, answer, answered_by, created_ts FROM asks
       WHERE from_label = ? ORDER BY created_ts DESC LIMIT 50`,
      label,
    ).toArray();
    return { inbox: [...inbox, ...open], sent };
  }


  /** Reframe: the human kicks an ask back to the asker to restructure.
   *  Feedback is recorded on the node and surfaces in the asker's inbox.
   *  Deliberately does NOT answer/resume — the parent stays parked until
   *  a structured re-ask or an explicit answer. */
  private async askReframe(body: any, actor: string) {
    const id = String(body.id ?? "");
    const feedback = String(body.feedback ?? "").trim().slice(0, 1000) ||
      "REFRAME — restructure per the ask contract: one imperative question ≤240 chars, 2-8 one-click options, and why this is escalated instead of automatic.";
    const node = this.one(`SELECT id, meta FROM artefacts WHERE id = ? AND type = 'question'`, id);
    if (!node) throw new Error(`no such ask: ${id}`);
    const m = JSON.parse(node.meta ?? "{}");
    m.ask = { ...(m.ask ?? {}), reframe: { by: actor, feedback, ts: Date.now() } };
    this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(m), id);
    this.version(id, actor, "update", `ask reframed by human — ${feedback.slice(0, 160)}`, { reframe: m.ask.reframe });
    this.audit(actor, "ask_reframe", id, { feedback: feedback.slice(0, 200) });
    return { id, reframe: m.ask.reframe };
  }

  /** Admin cleanup: supersede smoke/test rows created in the last 48h. Audited per row. */
  private async purgeSmoke(body: any) {
    const cutoff = Date.now() - 48 * 60 * 60_000;
    const rows = this.state.storage.sql.exec(
      `SELECT id, status FROM artefacts WHERE type = 'task'
         AND status NOT IN ('done','superseded')
         AND created_ts > ?
         AND (title LIKE 'smoke%' OR title LIKE 'phase-2 smoke%' OR title LIKE 'smoke %')`,
      cutoff,
    ).toArray() as any[];
    const now = Date.now();
    for (const r of rows) {
      this.state.storage.sql.exec(
        `UPDATE artefacts SET status = 'superseded', status_ts = ?, updated_ts = ? WHERE id = ?`,
        now, now, r.id,
      );
      this.version(r.id, "system:cleanup", "transition", `purged smoke-test row (was ${r.status})`, { from: r.status, to: "superseded" });
      this.audit("system:cleanup", "transition", r.id, { from: r.status, to: "superseded", reason: "smoke purge" });
    }
    return { purged: rows.map((r: any) => r.id) };
  }

  /** Human handle for an ask: ASK-<subject>-<ordinal> ("ASK-BR-2466-2" = the
   *  2nd ask on that task). The opaque row key stays internal plumbing. */
  private askDisplay(row: { id: string; artefact_id: string | null; created_ts: number }) {
    if (!row.artefact_id) return row.id;
    const ord = this.one(
      `SELECT COUNT(*) AS n FROM asks WHERE artefact_id = ? AND created_ts <= ?`,
      row.artefact_id, row.created_ts,
    ) as any;
    return `ASK-${String(row.artefact_id).replace(/#/g, "-")}-${Number(ord?.n ?? 1)}`;
  }

  private async askGet(id: string) {
    const row = this.one(
      `SELECT id, from_label, to_target, question, status, artefact_id, answer, answered_by, answered_ts, created_ts
         FROM asks WHERE id = ?`, id,
    );
    if (!row) return null;
    return {
      id: row.id, display: this.askDisplay(row), from: row.from_label, to: row.to_target, question: row.question,
      options: [] as string[], urgency: "normal", status: row.status,
      artefact_id: row.artefact_id ?? undefined,
      answer: row.answer ?? undefined, answered_by: row.answered_by ?? undefined,
      answered_ts: row.answered_ts ?? undefined, created_ts: row.created_ts,
    };
  }

  private async askAnswer(body: any, actor: string) {
    const id = String(body.id ?? "");
    const answer = String(body.answer ?? "").trim();
    if (!answer) throw new Error("answer is required");

    // question-node asks (BR#): answer on the node, resume the subject
    if (/^BR#\d+$/.test(id)) {
      const node = this.one(`SELECT id, status, meta, created_ts FROM artefacts WHERE id = ?`, id);
      if (!node) throw new Error(`no such ask: ${id}`);
      const m = JSON.parse(node.meta ?? "{}");
      if (m.ask?.answer) throw new Error(`ask ${id} already answered`);
      m.ask = { ...(m.ask ?? {}), answer: answer.slice(0, 4000), answered_by: actor, answered_ts: Date.now() };
      // BR#3911: an answer resolves a live human-claim hold — the timer is
      // cancelled by the very act the hold was waiting for.
      const hadClaim = !!m.human_claimed;
      if (hadClaim) delete m.human_claimed;
      // questions complete directly (todo → done) — the claimant status machine
      // is for work items, not for Q&A nodes
      const now = Date.now();
      this.state.storage.sql.exec(
        `UPDATE artefacts SET meta = ?, status = 'done', status_ts = ?, updated_ts = ? WHERE id = ?`,
        JSON.stringify(m), now, now, id,
      );
      // stamp the real from→to — a status change with no from/to is a silent
      // mutation as far as the replay fold is concerned (BR#3322)
      this.version(id, actor, "transition", `answered by ${actor}: ${answer.slice(0, 200)}`, { from: node.status, to: "done", answer: answer.slice(0, 200), claim_resolved: hadClaim || undefined });
      let taskStatus: string | undefined;
      const subject = this.one(
        `SELECT p.id AS id, p.status AS status, p.owner AS owner, p.meta AS meta FROM relations r JOIN artefacts p ON p.id = r.dst_id
         WHERE r.relation = 'child_of' AND r.src_id = ? ORDER BY r.created_ts DESC LIMIT 1`, id,
      );
      if (subject) {
        const sm = JSON.parse(subject.meta ?? "{}");
        let cleared = false;
        if (sm.awaiting_ask?.ask_id === id) {
          delete sm.awaiting_ask;
          cleared = true;
        }
        // BR#4067: the paired typed await points at THIS ask — answered means
        // SATISFIED. Leaving it stamped would make every later machine release
        // path hold the card forever on a wait that already resolved.
        if (sm.blocked?.await_event?.event === "ask" && sm.blocked.await_event.ask_id === id) {
          delete sm.blocked.await_event;
          cleared = true;
        }
        if (cleared) {
          this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(sm), subject.id);
        }
        if (subject.status === "blocked") {
          // BR#3578 answer dispatch: when the ask IS the exit path (a
          // migration ask, or an option that names the action), the ANSWER
          // actions the card — SUPERSEDE drops it, RELEASE/CANCEL releases
          // to the pool, KEEP/RE-SCOPE stays a deliberate human-owned park
          // (the answered ask is the record; the marker prevents re-ask spam).
          // Without dispatch semantics this is the generic rule-6 resume.
          const isMigrationAsk = String(sm.blocked?.await_migration_ask ?? "") === id;
          // typed answers (BR#3912 type-your-own) must dispatch like the
          // button click on the same option: match the option's verb token,
          // not its first 12 chars — "RE-SCOPE: <new scope>" stays a
          // human-owned park exactly like "RE-SCOPE — I'll rewrite…", and a
          // typed "SUPERSEDE: x" drops instead of silently resuming
          const optHit = (Array.isArray(m.ask?.options) ? (m.ask.options as string[]) : [])
            .map((o) => String(o ?? "").trim().split(/\s+/)[0] ?? "")
            .filter((verb) => /^(RELEASE|CANCEL|SUPERSEDE|RE-SCOPE|KEEP)\b/i.test(verb))
            .some((verb) => answer.trim().toLowerCase().startsWith(verb.toLowerCase()));
          const asActor = `system:question(${actor})`;
          if (isMigrationAsk || optHit) {
            if (/\bSUPERSEDE\b/i.test(answer)) {
              // human_verdict: the human's answered-ask decision — the system
              // actor is only the pen. The release-holds guards (BR#4067)
              // exempt it: a human may release what a machine wait holds.
              await this.transition({ id: subject.id, to: "superseded", human_verdict: true, note: `ask ${id} answered — dropped: ${answer.slice(0, 120)}` }, asActor);
              taskStatus = "superseded";
            } else if (/\b(?:RELEASE|CANCEL)\b/i.test(answer)) {
              await this.transition({ id: subject.id, to: "todo", human_verdict: true, note: `ask ${id} answered — released to the pool: ${answer.slice(0, 120)}` }, asActor);
              taskStatus = "todo";
            } else {
              taskStatus = "blocked"; // KEEP PARKED / RE-SCOPE — the human owns the rewrite
            }
          } else if (this.askAgeGuardHold(Number(node.created_ts ?? 0)) || this.holderIsAlive(sm, subject.owner)) {
            await this.transition({
              id: subject.id, to: "in_progress",
              note: `ask ${id} answered — resumed: ${answer.slice(0, 100)}`,
            }, asActor);
            taskStatus = "in_progress";
          } else {
            // BR#3819 (D): the answer resumes work only onto a LIVE executor.
            // The holder's session produced no live signal within the stale
            // window — its runner already finished (the BR#3423/BR#3649
            // misfire: resume flipped the card in_progress and nothing ever
            // executed). Release to the pool instead; the dispatch loop
            // picks it up fresh.
            await this.transition({
              id: subject.id, to: "todo",
              note: `ask ${id} answered (${answer.slice(0, 80)}) — holder session ${String(sm.session ?? "?")} is dead (no live signal within the stale window); released to the pool for fresh dispatch (BR#3819: never resume onto a finished runner)`,
            }, asActor);
            taskStatus = "todo";
          }
        }
      }
      this.audit(actor, "answer", subject?.id ?? null, { ask_id: id, answer: answer.slice(0, 200) });
      return { id, status: "answered", artefact_id: subject?.id, task_status: taskStatus };
    }

    // legacy asks-row asks (ASK-…) — kept until in-flight rows drain
    const row = this.one(`SELECT status, artefact_id, created_ts FROM asks WHERE id = ?`, id);
    if (!row) throw new Error(`no such ask: ${id}`);
    if (row.status !== ASK_OPEN) throw new Error(`ask ${id} already ${row.status}`);
    this.state.storage.sql.exec(
      `UPDATE asks SET status = 'answered', answer = ?, answered_by = ?, answered_ts = ? WHERE id = ?`,
      answer.slice(0, 4000), actor, Date.now(), id,
    );
    let taskStatus: string | undefined;
    if (row.artefact_id) {
      const t = this.one(`SELECT status, owner, meta FROM artefacts WHERE id = ?`, String(row.artefact_id));
      if (t) {
        const meta = JSON.parse(t.meta ?? "{}");
        if (meta.awaiting_ask?.ask_id === id) {
          delete meta.awaiting_ask;
          this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), String(row.artefact_id));
        }
        if (t.status === "blocked") {
          if (this.askAgeGuardHold(Number(row.created_ts ?? 0)) || this.holderIsAlive(meta, t.owner)) {
            await this.transition({
              id: String(row.artefact_id), to: "in_progress",
              note: `decision ${id} answered — resumed: ${answer.slice(0, 100)}`,
            }, `system:decision(${actor})`);
            taskStatus = "in_progress";
          } else {
            // BR#3819 (D): dead holder — release to the pool, never resume
            // onto a runner that already finished.
            await this.transition({
              id: String(row.artefact_id), to: "todo",
              note: `decision ${id} answered (${answer.slice(0, 80)}) — holder session ${String(meta.session ?? "?")} is dead (no live signal within the stale window); released to the pool for fresh dispatch (BR#3819)`,
            }, `system:decision(${actor})`);
            taskStatus = "todo";
          }
        }
      }
    }
    this.audit(actor, "answer", row.artefact_id ?? null, { ask_id: id, answer: answer.slice(0, 200) });
    return { id, status: ASK_ANSWERED, artefact_id: row.artefact_id ?? undefined, task_status: taskStatus };
  }

  /** BR#3819 (D): holder liveness for the ask-resume path — the same real-
   *  signal law the duplicate-executor fence and the ghost-bounce conversion
   *  already use. The holder's freshest live signal is the max of:
   *    - the runner's liveness vouch on the card (meta.session_alive_ts),
   *    - the card's own heartbeat (meta.last_progress.ts — log_progress),
   *    - the stamped session's hub ping (sessions.last_seen_ts by name),
   *    - the owner identity's hub ping (auth_tokens.last_seen_ts — a live
   *      runner waiting on the answer keeps polling the hub, so its token
   *      stays fresh; a finished runner stops polling and goes stale).
   *  updated_ts is deliberately NOT a signal here: the watchdog's hourly
   *  blocked-age annotation touches it on parked cards, and annotated noise
   *  must never read as a live holder. meta.session is read but never
   *  trusted as identity — the stamp is first-wins, so a re-claimed card
   *  still carries its original session name; the heartbeats above are what
   *  track the CURRENT executor.
   *  No signal within the stale window = dead → the answer releases to the
   *  pool instead of resuming onto a runner that already finished. A card
   *  with no stamped session AND no owner has no holder to be dead — the
   *  generic resume stands. */
  private holderIsAlive(holderMeta: any, owner?: string): boolean {
    const sess = String(holderMeta?.session ?? "").trim();
    const ownerLabel = String(owner ?? "").trim();
    if (!sess && !ownerLabel) return true;
    const s = this.one(`SELECT value FROM settings WHERE key = 'stale_minutes'`);
    const staleMin = s ? Math.max(1, Math.min(120, parseInt(s.value, 10) || 10)) : 10;
    const sessRow = sess
      ? this.one(`SELECT last_seen_ts FROM sessions WHERE name = ? ORDER BY last_seen_ts DESC LIMIT 1`, sess)
      : null;
    const ownerToken = ownerLabel
      ? this.one(`SELECT id, last_seen_ts FROM auth_tokens WHERE label = ? OR principal = ? LIMIT 1`, ownerLabel, ownerLabel)
      : null;
    const lastSignal = Math.max(
      Number(holderMeta?.session_alive_ts ?? 0),
      Number(holderMeta?.last_progress?.ts ?? 0),
      Number(sessRow?.last_seen_ts ?? 0),
      Number(ownerToken?.last_seen_ts ?? 0),
    );
    if (!lastSignal) return false;
    return Date.now() - lastSignal <= staleMin * 60_000;
  }

  /** The ask-age presumption (BR#3819 D): a holder that was alive moments
   *  before the ask was filed is presumed alive while the ask is still
   *  younger than the stale window — quick answers always resume as today,
   *  whatever signal hygiene the parked card has. Only an ask old enough for
   *  a live holder to have heartbeated again submits to the signal check. */
  private askAgeGuardHold(askCreatedTs: number): boolean {
    const s = this.one(`SELECT value FROM settings WHERE key = 'stale_minutes'`);
    const staleMin = s ? Math.max(1, Math.min(120, parseInt(s.value, 10) || 10)) : 10;
    return Date.now() - Number(askCreatedTs ?? 0) < staleMin * 60_000;
  }
  private async orient(body: any) {
    // open question children: DERIVED awaiting_ask (phase 4 — no marker cache)
    const askChildOf = new Map<string, any>();
    for (const c of this.state.storage.sql.exec(
      `SELECT r.dst_id AS parent, c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND c.status IN ('todo','in_progress','blocked')
         AND c.type = 'question' ORDER BY c.created_ts DESC`,
    ).toArray() as any[]) {
      if (!askChildOf.has(c.parent)) askChildOf.set(c.parent, c);
    }
    const label = String(body.label ?? "");
    const tags: string[] = Array.isArray(body.tags) ? body.tags.map(String) : [];
    const counts = this.state.storage.sql.exec(
      `SELECT type, status, COUNT(*) AS n FROM artefacts GROUP BY type, status ORDER BY type`,
    ).toArray();
    const openStatuses = ["draft", "proposed", "active", "open", "todo", "in_progress", "blocked"];
    const marks = openStatuses.map(() => "?").join(",");
    const open = this.state.storage.sql.exec(
      `SELECT a.id, a.type, a.title, a.status, ${OWNER_DISPLAY_SQL} AS owner, a.meta, a.updated_ts
       FROM artefacts a
       WHERE a.status IN (${marks}) ORDER BY a.updated_ts DESC LIMIT 30`,
      ...openStatuses,
    ).toArray().map((t: any) => {
      // agents orienting need the blocked context inline — the exit condition
      // is the actionable part of a blocked card
      if (t.type === "task") {
        const m = JSON.parse(t.meta ?? "{}");
        if (m.blocked) { t.blocked_reason = (m.blocked.reason ?? "").slice(0, 200); t.unblock_condition = (m.blocked.unblock_condition ?? "").slice(0, 200); }
        if (m.subprocess) t.subprocess = { reason: (m.subprocess.reason ?? "").slice(0, 120), deadline_ts: m.subprocess.deadline_ts };
        // BR#3361 (d): the executor lease, visible — sessions doing paperwork
        // on a card can see WHO holds it before acting (the advisory half of
        // the duplicate-executor fence; the audit half fires on transitions)
        if (m.session && ["in_progress", "in_review"].includes(t.status)) t.executor_session = m.session;
        delete t.meta;
      }
      // BR#3911: a human-held question stays visible but says "in hand" —
      // agents see the hold instead of answer prompts, and stand down.
      if (t.type === "question") {
        const qm = JSON.parse(t.meta ?? "{}");
        const claim = humanClaimLive(qm, Date.now());
        if (claim) t.human_claimed = { by: claim.by, expires_ts: claim.expires_ts };
        delete t.meta;
      }
      return t;
    });
    // per-role steering: active steering artefacts — universal (no role:* tag)
    // plus any whose role:* tags match the caller's — delivered at orient and
    // at dispatch. The mechanism the merge ladder rides (BR#2799).
    const steeringRows = this.state.storage.sql.exec(
      `SELECT id, title, body_md, tags, roles FROM artefacts
       WHERE type = 'steering' AND status = 'active' ORDER BY updated_ts DESC LIMIT 20`,
    ).toArray();
    const steering = (steeringRows as any[])
      .map((s: any) => ({ id: s.id, title: s.title, body_md: String(s.body_md ?? "").slice(0, 1500), tags: parseTags(s.tags), roles: parseTags(s.roles) }))
      .filter((s: any) => {
        const roles: string[] = s.roles ?? [];
        return roles.length === 0 || roles.some((r: string) => tags.includes(`role:${r}`));
      });
    const askPlaceholders = ["any", label, ...tags.map((t) => `tag:${t}`)];
    const askMarks = askPlaceholders.map(() => "?").join(",");
    const pendingAsks = this.state.storage.sql.exec(
      `SELECT id, from_label, to_target, question, created_ts FROM asks
       WHERE status = 'open' AND from_label != ? AND to_target IN (${askMarks})
       ORDER BY created_ts DESC LIMIT 10`,
      label, ...askPlaceholders,
    ).toArray();
    // decisions_awaiting_consensus (BR#903): proposed decisions with an open
    // feedback round — the actionable "review requested" signal the pool only
    // carried passively before. Ranked by recency, shaped like pending_asks:
    // every agent is invited to read and contribute (agree/disagree + reasons
    // via log_progress on the round); the human still decides.
    const decisionsAwaiting = (this.state.storage.sql.exec(
      `SELECT d.id, d.title, d.owner, d.created_ts, d.updated_ts
       FROM relations r
       JOIN artefacts d ON d.id = r.dst_id AND d.type = 'decision' AND d.status = 'proposed'
       JOIN artefacts c ON c.id = r.src_id AND c.type = 'task' AND c.status IN ('todo','in_progress','blocked')
       WHERE r.relation = 'child_of'
         AND (c.tags LIKE '%"question"%' OR json_extract(c.meta, '$.kind') = 'question')
       GROUP BY d.id ORDER BY d.updated_ts DESC LIMIT 10`,
    ).toArray() as any[]).map((d) => {
      const c = this.consensusFor(d.id);
      return {
        decision_id: d.id,
        title: d.title,
        proposed_by: this.displayOwner(d.owner) || undefined,
        proposed_ts: d.created_ts,
        round_id: c?.round_id,
        round_title: c?.round_title,
        agree: c?.agree ?? 0,
        disagree: c?.disagree ?? 0,
        other: c?.other ?? 0,
        contributions: c?.contributions ?? 0,
        contributors: c?.contributors ?? [],
        how: `read the decision (${d.id}) + its round, contribute via log_progress {id: "${c?.round_id ?? ""}", did: "agree|disagree — reasons"} — informs the human, does not gate them`,
      };
    });
    const settings = this.settingsMap();
    const projectName = settings.project_name || "Superpositional";
    // my_tasks for a gateway includes the work of the agents it dispatched
    // (gateway_agents edges): the gateway is the dispatcher and resumer of its
    // workers — owner labels churn with pairings, the gateway does not. This
    // is what makes "same gateway immediately resumes its work" real.
    // machine/agent naming: dispatched workers are labelled <gateway>/<agent>,
    // so a gateway's my_tasks is a prefix glob — its own label plus everything
    // under it — with the gateway_agents edges kept for legacy unprefixed
    // workers.
    // `tags` rides my_tasks items (BR#2844 contract): the runner reads
    // role:* off them to route resumes — for months it read a key the hub
    // never sent (the silent-zero class); the contract now pins it.
    // Matching keys on the STORED owner (label glob + principal — BR#4262:
    // display never leaks into matching); the owner column in the payload is
    // the render-time join display.
    const myTasks = this.state.storage.sql.exec(
      `SELECT a.id, a.title, a.status, a.tags, ${OWNER_DISPLAY_SQL} AS owner
       FROM artefacts a
       WHERE a.type = 'task' AND a.status IN ('todo','in_progress','in_review','blocked')
       AND (a.owner = ? OR substr(a.owner, 1, length(?) + 1) = ? || '/'
            OR a.owner IN (SELECT agent FROM gateway_agents WHERE gateway = ?)
            OR a.owner = ?)
       ORDER BY a.updated_ts DESC LIMIT 10`,
      label, label, label, label, body.principal ?? null,
    ).toArray().map((t: any) => ({ ...t, tags: parseTags(t.tags) }));
    // dispatch surface: unclaimed todo tasks + BLOCKED tasks awaiting an agent
    // (a blocked card with an unblock condition is actionable — unblocking is
    // priority work). Rank-then-slice: fetch the full open pool FIRST, rank in
    // JS, then cut the top 10. The old 40-newest window was the Oct-20
    // frozen-backlog bug — churn (every claim/progress bumps updated_ts)
    // constantly displaced older-but-ranked items, so they were invisible to
    // the runner and sat in Backlog "blocked" forever.
    const pool = this.state.storage.sql.exec(
      `SELECT id, type, title, tags, roles, meta, project, updated_ts, status FROM artefacts
       WHERE type = 'task' AND status IN ('todo','blocked') AND (owner = '' OR status = 'blocked')
       ORDER BY updated_ts DESC LIMIT 400`,
    ).toArray().map((t: any) => ({ ...t, tags: parseTags(t.tags), roles: parseTags(t.roles) }));
    // gateway callers dispatch sessions and never claim blocked work —
    // resolving an unblock condition is role:unblock duty. Ten blocked cards
    // rank above plain todo and filled the dispatch slice, starving the
    // runner (every claim refused for a missing resolution). Gateways get
    // the claimable surface; agents still see blocked work to reason about.
    const callerIsGateway = tags.some((t) => t.toLowerCase() === "gateway");
    const dispatchPool = callerIsGateway ? pool.filter((t: any) => t.status !== "blocked") : pool;
    const { analysisEv, reviewEv } = this.qualificationEvidence();
    const qualIds = new Set(
      (this.state.storage.sql.exec(
        `SELECT id FROM artefacts WHERE type = 'task'
         AND (json_extract(meta, '$.qualification.state') = 'qualified' OR json_extract(meta, '$.qualified') = 1)`,
      ).toArray() as any[]).map((r) => r.id),
    );
    const parentQualified = new Set<string>();
    const verifyParents = new Map<string, any>();
    for (const l of this.state.storage.sql.exec(
      `SELECT r.src_id, r.dst_id, p.status AS pstatus, p.title AS ptitle, p.owner AS powner
       FROM relations r JOIN artefacts p ON p.id = r.dst_id
       WHERE r.relation = 'child_of'`,
    ).toArray() as any[]) {
      if (qualIds.has(l.dst_id) || analysisEv.has(l.dst_id)) parentQualified.add(l.src_id);
      if (l.pstatus === "in_review") verifyParents.set(l.src_id, l);
    }
    const unclaimedWork = dispatchPool.filter((t: any) => {
      const need: string[] = t.roles ?? [];
      const m = JSON.parse(t.meta ?? "{}");
      const declared = m.qualification?.state ?? (m.qualified === true ? "qualified" : undefined);
      const qualified = declared === "qualified" || analysisEv.has(t.id) || parentQualified.has(t.id);
      const bars: string[] = m.qualification?.bars ?? [];
      const unmet = this.enforceableBars(bars).filter((b) => !(/review/.test(b) ? reviewEv : analysisEv).has(t.id));
      // task tags declare the KIND of work (analysis/impl/review) — a
      // playbook for the dispatched session, never a worker requirement.
      // Qualification is bar-based only: a task is gated when it DECLARES
      // enforceable bars and they are unmet. There are no agent roles — tags
      // on tasks declare the KIND of work (analysis/impl/review), never a
      // requirement about the worker. The old default-gate (untagged =
      // needs_qualification) starved the queue: fresh, claimable tasks sat
      // behind a concept nobody signed up for.
      t.needs_qualification = unmet.length > 0;
      if (need.length) t.target_roles = need;
      // gateways dispatch sessions; qualification-gated work is role:analysis
      // duty (exactly what a qualify-or-close child task is). Leaving it in
      // the gateway's slice let the oldest gated tasks occupy all 10 slots
      // forever — the runner cycled them while claimable work sat behind.
      return callerIsGateway ? !t.needs_qualification : true;
    }).sort((a: any, b: any) => {
      // ranking: release-parked-work levers first (verify duty + unblock
      // duty), then blocked-with-condition, questions, plain todo.
      const rank = (t: any) => {
        const m = JSON.parse(t.meta ?? "{}");
        // human boost: priority 0, above unblock duty — the human's explicit
        // "process this (and its dependencies) first" (BR#911)
        if (m.boosted) return -1;
        // release-parked-work levers FIRST, above everything claimable:
        // verify duty (an in_review task parks its owner until a fresh
        // session rules) and unblock duty share rank 0. Verify starved below
        // blocked-with-condition (2026-10-24, Ray): ranks 0-1 filled the
        // 10-slot slice, verify children never surfaced, impls piled up
        // in_review while new impl todo kept getting claimed.
        if (t.roles?.includes("unblock")) return 0;
        if (verifyParents.has(t.id)) return 0;
        if (t.status === "blocked" && (m.blocked?.unblock_condition ?? "").trim()) return 1;
        if (t.type === "question") return 3;
        return 4;
      };
      return rank(a) - rank(b) || a.updated_ts - b.updated_ts;
    }).slice(0, 10).map((t: any) => {
      // pool traits — the pattern: computed per row, never stored flags. Clients
      // speak domain language (is_question, is_claimable, previously_attempted),
      // and every claimability blocker here is enforced at the claim gate —
      // a trait that lies is worse than no trait. Extend both together.
      const m = JSON.parse(t.meta ?? "{}");
      // blocked rows: surface the exit condition — the whole point is that an
      // agent can read WHY and decide whether it can clear it.
      if (t.status === "blocked") {
        t.blocked_reason = (m.blocked?.reason ?? "").slice(0, 300);
        t.unblock_condition = (m.blocked?.unblock_condition ?? "").slice(0, 300);
        t.awaiting_ask = askChildOf.get(t.id)?.id ?? m.awaiting_ask?.ask_id;
        t.is_claimable = !!t.unblock_condition; // resume via transition in_progress with resolution
        if (!t.unblock_condition) t.claim_reason = "blocked without an unblock condition — open the card, resolve or re-scope it";
      }
      // questions are a TYPE (asks v3 / BR#2983) — the pickup model, never a tag
      t.is_question = t.type === "question" || isQuestionTask(m) || false;
      const gated = m.operator_gated;
      if (t.status !== "blocked") {
        t.is_claimable = !t.is_question && !gated;
        if (!t.is_claimable) {
          t.claim_reason = t.is_question
            ? "question — answered, not claimed (contribute via log_progress {id, did})"
            : `operator gated: ${gated} — a human clears the gate`;
        }
      }
      if (m.attempt) {
        t.previously_attempted = {
          by: m.attempt.by, attempts: m.attempt.attempts,
          last_reason: m.attempt.last_reason ?? undefined,
          last_will: m.last_progress?.will ? String(m.last_progress.will).slice(0, 200) : undefined,
          note: `task was attempted ${m.attempt.attempts}x before (last by ${m.attempt.by}${m.attempt.last_reason ? ` — came back: ${String(m.attempt.last_reason).slice(0, 120)}` : ""}). VERIFY before working: search_knowledge + get_artefact — the work may already be done (then transition → done) or partially done (continue from the last will: ${m.last_progress?.will ? `"${String(m.last_progress.will).slice(0, 120)}"` : "none recorded"}).`,
        };
      }
      return t;
    });
    // role playbooks (settings.roles.{analysis,impl,...}) composed for this agent's tags
    const rolesSettings = typeof settings.roles === "object" && settings.roles ? settings.roles : {};
    const kindSettings = typeof settings.playbooks === "object" && settings.playbooks ? settings.playbooks : {};
    const isCron = tags.includes("cadence:cron");
    const kindPlaybook =
      (isCron ? kindSettings.cron : kindSettings.interactive)
      ?? (isCron ? DEFAULT_CRON_PLAYBOOK : "");
    const playbooks = tags
      .filter((t) => t.startsWith("role:"))
      .map((t) => ({ role: t.slice(5), playbook: resolveRolePlaybook(rolesSettings, t.slice(5)) }))
      .filter((p) => typeof p.playbook === "string" && p.playbook.trim());
    // reaper: sort out my abandoned work at check-in (see reapAbandoned)
    const staleMinS = this.one(`SELECT value FROM settings WHERE key = 'stale_minutes'`);
    const staleMin = staleMinS ? Math.max(1, Math.min(120, parseInt(staleMinS.value, 10) || 10)) : 10;
    const actionRequired = this.reapAbandoned(label, staleMin);
    // verification_stalled: an in_review parent's verify child is unclaimed — the
    // parent's owner is parked waiting on a verdict that only pickup can produce.
    // Tell the waiting owner (this is a pickup problem, not a review problem) and
    // any role:review agent (pickup is their duty). 48h = stalled.
    const stalledVerify = this.state.storage.sql.exec(
      `SELECT r.src_id AS verify_task, r.dst_id AS parent_id, p.title AS parent_title, p.owner AS parent_owner, c.updated_ts AS age_ts
       FROM relations r
       JOIN artefacts c ON c.id = r.src_id
       JOIN artefacts p ON p.id = r.dst_id
        WHERE r.relation = 'child_of'
          AND c.type = 'task' AND c.status = 'todo' AND c.owner = ''
          AND c.roles LIKE '%"review"%'
          AND p.type = 'task' AND p.status = 'in_review'
          AND p.updated_ts < ?`,
      [Date.now() - 48 * 60 * 60 * 1000],
    ).toArray() as any[];

    const reviewPending = stalledVerify.filter(v => v.parent_owner === label).map(v => ({
      task_id: v.verify_task,
      parent_id: v.parent_id,
      parent_title: v.parent_title,
      age_minutes: Math.ceil((Date.now() - v.age_ts) / 60000),
      message: `Verification for '${v.parent_title}' (Task ${v.parent_id}) is stalled — verify task ${v.verify_task} unclaimed for ${Math.ceil((Date.now() - v.age_ts) / 60000)}m.`,
      required_action: "CLAIM_VERIFY_TASK",
    }));

    const reviewDuty = tags.includes('role:review')
      ? stalledVerify.filter(v => v.parent_owner !== label).map(v => ({
        task_id: v.verify_task,
        parent_id: v.parent_id,
        parent_title: v.parent_title,
        age_minutes: Math.ceil((Date.now() - v.age_ts) / 60000),
        message: `Stalled review: '${v.parent_title}' (Task ${v.parent_id}) has unclaimed verify task ${v.verify_task} for ${Math.ceil((Date.now() - v.age_ts) / 60000)}m.`,
        required_action: "PICKUP_REVIEW",
      }))
      : [];

    const verificationNotices = [...reviewPending, ...reviewDuty];
    // gauge debt: owned work in flight whose last log carries no gauges. The
    // board's gauges drive prioritisation and attention scoring — an agent that
    // stops reporting them goes blind on the board. Surface the debt at every
    // orient so the behaviour is corrected while the task is live, not after.
    const gaugeDebt = (this.state.storage.sql.exec(
      `SELECT id, title, meta FROM artefacts
       WHERE type = 'task' AND owner = ? AND status IN ('in_progress','blocked')
       AND (json_extract(meta, '$.last_progress.completion_pct') IS NULL
            AND json_extract(meta, '$.last_progress.confidence_pct') IS NULL
            AND json_extract(meta, '$.last_progress.risk_pct') IS NULL
            AND json_extract(meta, '$.last_progress.context_pct') IS NULL)
       ORDER BY updated_ts DESC LIMIT 10`,
      label,
    ).toArray() as any[]).map((t) => ({ id: t.id, title: t.title }));
    const gaugeDebtNote = gaugeDebt.length
      ? `\n\nGAUGE DEBT — these in-flight tasks have no reported gauges. Your next log_progress on each must include completion_pct, confidence_pct, risk_pct and context_pct (0-100) — the board cannot prioritise or score your work without them: ${gaugeDebt.map((t) => `${t.id} "${t.title.slice(0, 60)}"`).join("; ")}.`
      : "";
    const my_score = this.agentScores().find((a) => a.label === label)
      ?? { label, ...scoreAgent({ progress_count: 0, gauge_count: 0, thin_notes: 0, abandoned: 0, result_lost: 0, reassigned: 0, asks_received: 0, asks_answered_on_time: 0, artefacts_created: 0, verify_duty_backlog: 0 }) };
    // score optimisation is an explicit standing directive: the agent sees its
    // number, its grade, and the concrete actions that raise it — every
    // check-in, not as trivia at the bottom of the payload.
    const scoreDirective = `\n\nYOUR SCORE: ${my_score.score}/100 (${my_score.grade}). Optimise for it — it gates which work you can claim and whether your tasks survive. ${my_score.hints.length ? "Actions that raise it now: " + my_score.hints.join(" ") : "No deductions — keep heartbeats ≤10m, finish with receipts, answer asks fast."}`;
    return {
      project: projectName,
      instructions: composeBootstrap(projectName, settings.board ?? DEFAULT_BOARD)
        + (settings.bootstrap_md ? `\n${settings.bootstrap_md}` : "")
        + (kindPlaybook ? `\n\nYOUR KIND: ${isCron ? "cron" : "interactive"}\n${kindPlaybook}` : "")
        + playbooks.map((p) => `\n\nYOUR ROLE: ${p.role}\n${p.playbook}`).join("")
        + gaugeDebtNote
        + scoreDirective,
      board: settings.board ?? DEFAULT_BOARD,
      counts,
      open_artefacts: open,
      my_tasks: myTasks,
      unclaimed_work: unclaimedWork,
      steering,
      my_roles: tags.filter((t) => t.startsWith("role:")),
      pending_asks: pendingAsks,
      decisions_awaiting_consensus: decisionsAwaiting.length ? decisionsAwaiting : undefined,
      action_required: actionRequired.length || verificationNotices.length
        ? [...actionRequired, ...verificationNotices]
        : undefined,
      // BR#3463: ALWAYS emit — gauge_debt is a REQUIRED orient contract key
      // (BR#2844); the conditional turned the healthy case (zero debt) into a
      // contract violation (undefined drops from JSON.stringify → "missing
      // gauge_debt" aborts every dispatch tick). Empty array = healthy board.
      gauge_debt: gaugeDebt,
      my_score,
    };
  }

  /** BR#4067 — the freshest hub ping from the card's claiming session. A
   *  dispatched runner run pings on orient/claim even while its stdout is
   *  quiet, so a fresh ping means the run is plausibly still in flight and
   *  the silence-release must wait it out (grace extension, #205-consistent:
   *  liveness = ANY real signal, never a shorter window). */
  private sessionPing(meta: any): number {
    const name = meta?.session ? String(meta.session) : "";
    if (!name) return 0;
    try {
      return Number(this.one(`SELECT MAX(last_seen_ts) AS ts FROM sessions WHERE name = ?`, name)?.ts ?? 0) || 0;
    } catch { return 0; }
  }

  /** BR#4067 — the hold-park transition body: blocked (never todo), the
   *  silence named, the typed wait preserved or re-derived. The typed
   *  await_event keeps the blocked-needs-typed-await gate honest; when none
   *  is derivable the merge_train flag marks it a machine-managed park with
   *  its own trip-wires. result_class "proxy_wait_hold" exempts the park
   *  from abandonment scoring — a hold preserves state, nothing was lost. */
  private holdParkBody(id: string, meta: any, hold: string, staleDesc: string) {
    const aw = validateAwaitEvent(meta?.blocked?.await_event)
      ?? trainProxyEvent(meta)
      ?? (meta?.awaiting_ask?.ask_id ? { event: "ask" as const, ask_id: String(meta.awaiting_ask.ask_id) } : null);
    return {
      id,
      to: "blocked",
      note: `silence-release held (watchdog): ${staleDesc}, but the card carries ${hold} — parked on the typed proxy, not released (BR#4067)`,
      unblock_condition: aw ? describeAwaitEvent(aw) : hold,
      ...(aw ? { await_event: aw } : { merge_train: true }),
      result_class: PROXY_WAIT_HOLD_RESULT_CLASS,
    };
  }

  /** BR#4282 — the atom-check before a hold-park. The hub holds no VCS
   *  credentials (BR#3516 §8), so a pr_merged proxy is unresolvable from
   *  GitHub — but the train stamps the merge ON THE BOARD: the card's own
   *  merge_train awaiting-ci stamp (written by every train:merged event) and
   *  the provenance row. When either receipt exists for the proxy's leg, the
   *  atom is ALREADY satisfied: spawn the unblock duty (caps + flood dedup
   *  inside spawnProxyDuty) whose contract delivers the done-close — and
   *  never hold-park the card blocked on the satisfied proxy. Returns true
   *  when the card was routed (or is freshly routed — pacing), false when
   *  the caller should hold-park as before (conservatism law: no receipt,
   *  no route). */
  private async routeSatisfiedProxy(r: any, meta: any, now: number, staleDesc: string): Promise<boolean> {
    const aw = validateAwaitEvent(meta?.blocked?.await_event) ?? trainProxyEvent(meta);
    if (!aw || aw.event !== "pr_merged") return false; // only pr legs carry board merge receipts
    const repo = String((aw as any).repo ?? "");
    const n = Number((aw as any).n ?? 0);
    if (!repo || !n) return false;
    // per-card pacing: a card just routed must not re-evaluate every tick
    const prev = meta.proxy_check;
    if (prev?.verdict === "true" && typeof prev?.at === "number" && now - prev.at < 5 * 60_000) return true;
    const stamp = trainMergeReceipt(meta, repo, n);
    let receipt: string | null = null;
    if (stamp) {
      receipt = `the card's merge-train stamp: PR ${repo}#${n} merged as ${String(stamp.merge_sha).slice(0, 9)} (state awaiting-ci${stamp.merged_at ? `, merged_at ${new Date(stamp.merged_at).toISOString()}` : ""})`;
    } else {
      const prov = this.one(
        `SELECT merge_sha, merged_at FROM provenance WHERE repo = ? AND pr = ?`,
        repo, n,
      ) as any;
      if (prov?.merge_sha) {
        receipt = `provenance: PR ${repo}#${n} merged as ${String(prov.merge_sha).slice(0, 9)}${prov.merged_at ? ` (${new Date(prov.merged_at).toISOString()})` : ""}`;
      }
    }
    if (!receipt) return false;
    // the exit text keys the flood dedup: an OUTSTANDING round for this same
    // condition is already on the case (spawnProxyDuty flood-skips it — no
    // breach, no duplicate); a consumed/absent round issues fresh. A resume
    // clears the stamp (machine.ts), so a post-resume silence spawns the
    // owned done-close round instead of flooding for an hour.
    const cond = String(meta.last_unblock_spawn?.exit ?? "").trim() || describeAwaitEvent(aw);
    if (prev?.verdict !== "true") {
      this.audit("hub:proxy-watch", "proxy_route", r.id, { stale: staleDesc, receipt });
    }
    await this.spawnProxyDuty(r, meta, now, prev, cond, [receipt]);
    return true;
  }

  /**
   * Reaper: runs at orient (check-in). Blocked-abandoned tasks:
   *  - OWN tasks: activity within the stale window → prompt to check in
   *    (log_progress re-claims); no activity → penalty (score counts the
   *    reaper event) and reassignment.
   *  - ANYONE'S stale-abandoned tasks: reassigned after the stale window —
   *    a vanished agent's claim must not park work forever. Runs at ANY
   *    orient, so the next check-in by any agent sweeps the whole board.
   */
  private reapAbandoned(label: string, staleMin: number): string[] {
    const out: string[] = [];
    const now = Date.now();
    const staleMs = staleMin * 60_000;
    for (const t of this.state.storage.sql.exec(
      `SELECT id, title, meta, tags, status_ts, updated_ts, owner FROM artefacts
       WHERE type = 'task' AND status = 'blocked' AND (owner = ? OR owner != '')`, label,
    ).toArray() as any[]) {
      const meta = JSON.parse(t.meta ?? "{}");
      const reason = String(meta.blocked?.reason ?? "");
      const isAbandoned = reason.startsWith("abandoned");
      // Gate-rejection blocks (runner handoff rejected, churn guard) carry an
      // unblock condition and an unblock child — they get a much longer fuse
      // than abandonment. But if NOTHING moved for a full day the block is a
      // dead end too: release the task back to the pool with the error history
      // on the card (the BR#584-class 123-attempt rows were this).
      const isStuckGate = reason.startsWith("runner:") || reason.startsWith("churn guard:");
      if (!isAbandoned && !isStuckGate) continue;
      const idleLimit = isAbandoned ? staleMs : 24 * 60 * 60_000;
      const idleDesc = isAbandoned ? `silent >${staleMin}m after abandonment` : `no movement >24h after a gate-rejection block`;
      const mine = t.owner === label;
      const ownerLabel = t.owner || label;
      const wasDoing = mine && meta.last_progress?.will ? ` Your last will: "${String(meta.last_progress.will).slice(0, 150)}".` : "";
      const lastOwn = this.one(
        `SELECT MAX(ts) AS ts FROM events WHERE artefact_id = ? AND actor = ?`, t.id, ownerLabel,
      )?.ts ?? 0;
      const idleFor = now - Math.max(lastOwn, t.updated_ts ?? 0);
      if (mine && idleFor < idleLimit) {
        if (isAbandoned) {
          out.push(
            `${t.id} "${t.title}" is marked abandoned but you were active on it recently.${wasDoing} log_progress on it NOW to re-claim, then keep the ≤${staleMin}m heartbeat.`,
          );
        }
        continue;
      }
      if (idleFor < idleLimit) continue; // someone else's, still fresh-ish — leave it
      const tags: string[] = parseTags(t.tags);
      if (!tags.includes("attempted")) tags.push("attempted");
      const attempts = ((meta.attempt?.attempts as number) ?? 0) + 1;
      // REWORK-LOOP ESCALATION: past 5 attempts this is not bad luck — it's a
      // loop (claim → stall → watchdog-bounce → blocked → release → claim…).
      // Re-releasing just runs the same cycle again. Park it blocked-for-human:
      // only a human (web/human actor) may release it from here on.
      if (attempts >= 5) {
        // BR#3578: the human leg is an ACTIVE ask (For Me, one click), not
        // prose on a parked card. reapAbandoned stays sync — the ask files as
        // a promise; askCreate auto-blocks the in_progress subject with the
        // typed ask event, and the .then leg stamps awaiting_ask + the typed
        // await onto the card once the ask id exists.
        void this.askCreate({
          to: "ray",
          // Plain-English rewrite (BR#4023): the rework-loop ask states the
          // fact (stuck, N failed attempts), the consequence (re-release
          // repeats the cycle), and what each option concretely does.
          question: `Card ${t.id} is stuck in a rework loop (${attempts} failed attempts) — fix its brief, re-release it, or drop it?`,
          reason: `${attempts} dispatch attempts ended without completion (last: ${reason.slice(0, 120)}) — each re-release repeats the same claim→stall cycle, so this needs a human decision`,
          options: [
            "RE-SCOPE — rewrite the card's brief, then release it normally",
            "RELEASE — back to the pool as-is",
            "SUPERSEDE — drop the card",
          ],
          details: `"${t.title}" (${t.id}) has failed ${attempts} dispatch attempts. Last release reason: "${reason.slice(0, 200)}".

What this means: agents keep picking the card up and stalling the same way — re-releasing it unchanged just repeats the cycle. Check the attempt history on the card before answering.

- RE-SCOPE: fix the card's brief (title, body, exit condition) so the next attempt can actually succeed, then release it.
- RELEASE: back to the pool unchanged — reasonable only if the past failures were environmental and are now fixed.
- SUPERSEDE: drop it — the work is moot, done elsewhere, or not worth the loop.

Or answer in your own words — a typed answer is recorded with the ask exactly like a click.`,
          artefact_id: t.id,
        }, "system:reaper")
          .then((loopAsk) => {
            const fresh = JSON.parse(String(this.one(`SELECT meta FROM artefacts WHERE id = ?`, t.id)?.meta ?? "{}"));
            fresh.blocked = { ...(fresh.blocked ?? {}), await_event: { event: "ask", ask_id: loopAsk.id } };
            fresh.awaiting_ask = { ...(fresh.awaiting_ask ?? {}), ask_id: loopAsk.id, ts: Date.now() };
            this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(fresh), t.id);
            this.audit("system:reaper", "loop_ask_filed", t.id, { ask_id: loopAsk.id, attempts });
          })
          .catch(() => { /* ask filing failed — the escalation record below still parks it for human review */ });
        meta.blocked = {
          reason: `rework loop detected — ${attempts} dispatch attempts without completion (last release reason: ${reason.slice(0, 160)}). Re-running again would repeat the cycle; escalated to a human.`,
          unblock_condition: "human: review the attempt history (get_history) — either fix what keeps failing, re-scope the task, or transition it todo yourself to deliberately continue",
          ts: now,
        };
        meta.attempt = { by: ownerLabel, at: now, attempts, last_reason: reason.slice(0, 200) };
        this.state.storage.sql.exec(
          `UPDATE artefacts SET tags = ?, meta = ?, status_ts = ?, updated_ts = ? WHERE id = ?`,
          JSON.stringify(tags), JSON.stringify(meta), now, now, t.id,
        );
        this.audit("system:reaper", "loop_escalated", t.id, { prev_owner: ownerLabel, attempts, idle_ms: idleFor });
        // a NOTE, not a transition row — the status does not change here; a
        // transition stamp without from/to is invisible to the replay fold
        // and masquerades as a move that never happened (BR#3322)
        this.version(t.id, "system:reaper", "note", `rework loop escalated to human — ${attempts} attempts without completion`, { prev_owner: ownerLabel, attempts });
        out.push(
          `${t.id} "${t.title}" REWORK LOOP (${attempts} attempts) — escalated to a human instead of re-releasing. Blocked-for-human until reviewed.`,
        );
        continue;
      }
      meta.attempt = { by: ownerLabel, at: now, attempts };
      // BR#4067 — the reassignment must not destroy a machine wait: train
      // queue slots / typed awaits / bound asks survive the reaper (the card
      // stays blocked, its proxy intact). The attempt still counts, so a held
      // card that keeps cycling still reaches the rework-loop escalation above.
      const hold = releaseHold(meta);
      if (hold) {
        this.state.storage.sql.exec(
          `UPDATE artefacts SET meta = ?, status_ts = ?, updated_ts = ? WHERE id = ?`,
          JSON.stringify(meta), now, now, t.id,
        );
        this.audit("system:reaper", "release_held", t.id, { prev_owner: ownerLabel, attempts, hold });
        this.version(t.id, "system:reaper", "note", `reassignment HELD — the card carries ${hold} (BR#4067)`, { prev_owner: ownerLabel, attempts, hold });
        out.push(
          `${t.id} "${t.title}" release HELD: ${hold} — parked (attempt ${attempts} recorded, still counting toward the rework loop).`,
        );
        continue;
      }
      delete meta.blocked;
      this.state.storage.sql.exec(
        `UPDATE artefacts SET status = 'todo', owner = '', tags = ?, meta = ?, status_ts = ?, updated_ts = ? WHERE id = ?`,
        JSON.stringify(tags), JSON.stringify(meta), now, now, t.id,
      );
      this.audit("system:reaper", "reassign", t.id, { prev_owner: ownerLabel, attempts, idle_ms: idleFor });
      // the reassign IS a status change (blocked → todo, the loop's WHERE
      // clause pins `status = 'blocked'`) — stamp the real from/to so the
      // replay fold can chain it (the from/to-less stamp was a silent
      // mutation that broke every later fold — BR#3322's Oct-20 shape)
      this.version(t.id, "system:reaper", "transition", `reassigned — ${ownerLabel} ${idleDesc} (attempt ${attempts})`, { from: "blocked", to: "todo", prev_owner: ownerLabel });
      out.push(
        mine
          ? `${t.id} "${t.title}" was REASSIGNED: you ${idleDesc}.${wasDoing} Your score is penalised. It is now unclaimed todo, tagged "attempted" (attempt ${attempts}) — partial work may exist. Do not blindly restart it: search_knowledge + get_artefact first.`
          : `${t.id} "${t.title}" was REASSIGNED: ${ownerLabel} ${idleDesc} (attempt ${attempts}) — back to unclaimed todo for any agent to pick up.`,
      );
    }
    return out;
  }

  /** Project-facing settings only (safe for any authenticated agent). */
  private publicSettings() {
    const m = this.settingsMap();
    return { project_name: m.project_name, board: m.board ?? DEFAULT_BOARD, bootstrap_md: m.bootstrap_md };
  }

  private settingsMap(): Record<string, any> {
    const rows = this.state.storage.sql.exec(`SELECT key, value FROM settings`).toArray();
    const map: Record<string, any> = {};
    for (const r of rows as any[]) map[r.key] = JSON.parse(r.value);
    return map;
  }

  // ---------- admin ops (human plane) ----------

  /** stable DO slug for this instance's workspace (set by the registry at creation) */
  private wsSlug(): string {
    const m = this.settingsMap() as Record<string, any>;
    return typeof m.ws_slug === "string" ? m.ws_slug : "";
  }

  // ---- workspace registry (lives in the "global" KB DO; owner-checked, no admin flag) ----

  /** one-time import of the legacy hard-coded membership list */
  private async wsSeed(logins: string[]) {
    const now = Date.now();
    const slug = DEFAULT_WS_SLUG;
    // this DO *is* the default workspace — stamp it so tokens minted here embed the slug
    this.state.storage.sql.exec(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('ws_slug', ?)`,
      JSON.stringify(slug),
    );
    this.state.storage.sql.exec(
      `INSERT OR IGNORE INTO workspaces (slug, owner, personal, created_ts) VALUES (?, ?, 1, ?)`,
      slug, logins[0] ?? "legacy", now,
    );
    for (const login of logins) {
      this.state.storage.sql.exec(
        `INSERT OR IGNORE INTO workspace_members (ws, login) VALUES (?, ?)`, slug, login,
      );
    }
    return { ok: true, seeded: logins };
  }

  private async wsList(login: string) {
    const rows = this.state.storage.sql.exec(
      `SELECT w.slug, w.owner, w.personal, w.created_ts,
              EXISTS(SELECT 1 FROM workspace_members m WHERE m.ws = w.slug AND m.login = ?) AS member
         FROM workspaces w ORDER BY w.created_ts ASC`,
      login,
    ).toArray();
    return {
      workspaces: rows.map((r) => ({
        slug: r.slug, owner: r.owner, personal: !!r.personal,
        created_ts: r.created_ts, member: !!r.member,
      })),
    };
  }

  /** create: owner = caller; they become the first member; personal workspaces are <login> */
  private async wsCreate(body: any, login: string) {
    const slug = String(body.slug ?? "").trim();
    if (slug === "global" || slug === "legacy") throw new Error("reserved workspace name");
    if (slug !== login && !/^[a-z0-9][a-z0-9-]{1,39}$/.test(slug)) {
      throw new Error("slug must be 2-40 chars [a-z0-9-] (or your username for a personal ws)");
    }
    if (this.one(`SELECT slug FROM workspaces WHERE slug = ?`, slug)) {
      throw new Error(`workspace '${slug}' already exists`);
    }
    const now = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO workspaces (slug, owner, personal, created_ts) VALUES (?, ?, ?, ?)`,
      slug, login, slug === login ? 1 : 0, now,
    );
    this.state.storage.sql.exec(
      `INSERT INTO workspace_members (ws, login) VALUES (?, ?)`, slug, login,
    );
    // provision the KB DO for this workspace immediately: schema init + ws_slug
    // stamp so tokens minted there embed this workspace's slug
    const stub = (this.env as any).KB.get((this.env as any).KB.idFromName(doWs(slug)));
    await stub.fetch("https://kb/bootstrap", { method: "POST", body: "{}" }).catch(() => {});
    await stub.fetch("https://kb/admin.settings_set", {
      method: "POST",
      headers: { "content-type": "application/json", "x-kb-admin": "1" },
      body: JSON.stringify({ settings: { ws_slug: slug } }),
    }).catch(() => {});
    return { ok: true, slug };
  }

  /** invite: any member of an existing workspace can add members — everyone
   *  holds the same rights (no role tiers). The invitee arrives as
   *  body.member; body.login is always the CALLER (dispatch supplies it). */
  private async wsJoin(body: any, login: string) {
    const slug = String(body.ws ?? "").trim();
    const w = this.one(`SELECT slug, owner FROM workspaces WHERE slug = ?`, slug);
    if (!w) throw new Error(`no such workspace: ${slug}`);
    if (!this.one(`SELECT 1 FROM workspace_members WHERE ws = ? AND login = ?`, slug, login))
      throw new Error("only workspace members can add members");
    const who = String(body.member ?? "").trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/.test(who)) throw new Error("bad github login");
    this.state.storage.sql.exec(
      `INSERT OR IGNORE INTO workspace_members (ws, login) VALUES (?, ?)`, slug, who,
    );
    return { ok: true, ws: slug, login: who };
  }

  /** remove: any member can remove any member — except the workspace creator
   *  (owner), who cannot be removed by anyone, not even themselves. */
  private async wsRemove(body: any, login: string) {
    const slug = String(body.ws ?? "").trim();
    const w = this.one(`SELECT slug, owner FROM workspaces WHERE slug = ?`, slug);
    if (!w) throw new Error(`no such workspace: ${slug}`);
    if (!this.one(`SELECT 1 FROM workspace_members WHERE ws = ? AND login = ?`, slug, login))
      throw new Error("only workspace members can remove members");
    const who = String(body.member ?? "").trim().toLowerCase();
    if (!who) throw new Error("member required");
    if (who === String(w.owner).toLowerCase()) throw new Error("the workspace creator cannot be removed");
    this.state.storage.sql.exec(
      `DELETE FROM workspace_members WHERE ws = ? AND login = ?`, slug, who,
    );
    const still = this.one(`SELECT 1 FROM workspace_members WHERE ws = ? AND login = ?`, slug, who);
    return { ok: true, ws: slug, login: who, removed: !still };
  }

  private async wsMembers(body: any, login: string) {
    const slug = String(body.ws ?? "").trim();
    const w = this.one(`SELECT slug, owner FROM workspaces WHERE slug = ?`, slug);
    if (!w) throw new Error(`no such workspace: ${slug}`);
    const member = this.one(`SELECT 1 FROM workspace_members WHERE ws = ? AND login = ?`, slug, login);
    if (w.owner !== login && !member) throw new Error("not a member of this workspace");
    const rows = this.state.storage.sql.exec(
      `SELECT login FROM workspace_members WHERE ws = ? ORDER BY login`, slug,
    ).toArray();
    return { ws: slug, owner: w.owner, members: rows.map((r) => r.login) };
  }

  /** Central registry of opaque token → workspace, written at mint time so /mcp
   *  can route without the workspace slug being embedded in the secret. */
  private async wsTokenRegister(body: any) {
    const hash = String(body.hash ?? ""), ws = String(body.ws ?? "");
    if (!/^[0-9a-f]{64}$/.test(hash) || !isWsSlug(ws)) throw new Error("bad token registration");
    const principal = typeof body.principal === "string" && body.principal.trim() ? body.principal.trim().slice(0, 80) : null;
    this.state.storage.sql.exec(
      `INSERT INTO ws_tokens (hash, ws, created_ts, principal) VALUES (?, ?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET ws = excluded.ws, principal = excluded.principal`,
      hash, ws, Date.now(), principal,
    );
    return { ok: true };
  }

  private async wsTokenLookup(body: any) {
    const row = this.one(`SELECT ws FROM ws_tokens WHERE hash = ?`, String(body.hash ?? ""));
    return { ws: row?.ws ?? null };
  }

  /** BR#3787 layer 2 — resolve the workspace that owns a principal, so the
   *  agent-plane repair route can reach the right DO without the caller
   *  knowing the workspace. */
  private async wsTokenLookupPrincipal(body: any) {
    const principal = String(body.principal ?? "").trim();
    if (!principal) return { ws: null };
    const row = this.one(
      `SELECT ws FROM ws_tokens WHERE principal = ? ORDER BY created_ts DESC LIMIT 1`,
      principal,
    );
    return { ws: row?.ws ?? null };
  }

  // ---- device pairing (lives in the registry DO) ----
  // GitHub-like device flow, but bridge-native: the device shows a code, the
  // human approves it in the web UI (picking workspace + roles), and the device
  // polls its token once. The approver never holds the credential.

  static PAIR_TTL_MS = 15 * 60_000;
  static PAIR_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O/1/I

  private pairCode(): string {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const chars = [...bytes].map((b) => KnowledgeHub.PAIR_ALPHABET[b % KnowledgeHub.PAIR_ALPHABET.length]);
    return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
  }

  private pairPurge() {
    const cutoff = Date.now() - KnowledgeHub.PAIR_TTL_MS;
    this.state.storage.sql.exec(`DELETE FROM pairings WHERE created_ts < ?`, cutoff);
    // hard cap on pending rows so /api/pair/start can't be spammed into bloat
    const n = this.one(`SELECT COUNT(*) AS n FROM pairings WHERE status = 'pending'`)?.n ?? 0;
    if (n > 100) {
      this.state.storage.sql.exec(
        `DELETE FROM pairings WHERE status = 'pending' AND code NOT IN (
           SELECT code FROM pairings WHERE status = 'pending' ORDER BY created_ts DESC LIMIT 100)`,
      );
    }
  }

  private async wsPairStart(body: any) {
    this.pairPurge();
    const code = this.pairCode();
    const now = Date.now();
    // the DEVICE declares its class at start; the approver never chooses —
    // streams cannot cross because the request, not the human, sets the type.
    // Pairing IS a gateway act (agents are provisioned by gateways, never
    // self-paired), so an absent/unrecognized type defaults to gateway —
    // legacy CLIs that predate the field pair as gateways too.
    const type = body.type === "agent" ? "agent" : "gateway";
    const principal = typeof body.principal === "string" && body.principal.trim() ? body.principal.trim().slice(0, 80) : null;
    this.state.storage.sql.exec(
      `INSERT INTO pairings (code, device, type, principal, status, created_ts) VALUES (?, ?, ?, ?, 'pending', ?)`,
      // host is the DISPLAY name (BR#899: labels display, the device
      // credential anchors); body.device fallback covers desktops predating
      // the field rename
      code, String(body.host ?? body.device ?? "device").slice(0, 80), type, principal, now,
    );
    return { code, type, expires_ts: now + KnowledgeHub.PAIR_TTL_MS };
  }

  private async wsPairGet(body: any) {
    const row = this.one(
      `SELECT device, type, status, created_ts, ws, label FROM pairings WHERE code = ?`,
      String(body.code ?? "").trim().toUpperCase(),
    );
    if (!row) return { status: "expired" };
    if (row.status === "pending" && Date.now() - row.created_ts > KnowledgeHub.PAIR_TTL_MS) {
      this.state.storage.sql.exec(`DELETE FROM pairings WHERE code = ?`, row.code);
      return { status: "expired" };
    }
    return { status: row.status, device: row.device, type: row.type ?? "agent", created_ts: row.created_ts, ws: row.ws, label: row.label };
  }

  private async wsPairApprove(body: any) {
    const code = String(body.code ?? "").trim().toUpperCase();
    const ws = String(body.ws ?? "").trim();
    const label = String(body.label ?? "").trim();
    const login = String(body.login ?? "").toLowerCase();
    const row = this.one(`SELECT code, created_ts, status, device, type, principal FROM pairings WHERE code = ?`, code);
    if (!row || row.status !== "pending") throw new Error("pairing code not pending");
    if (Date.now() - row.created_ts > KnowledgeHub.PAIR_TTL_MS) {
      this.state.storage.sql.exec(`DELETE FROM pairings WHERE code = ?`, code);
      throw new Error("pairing code expired");
    }
    // class was declared by the DEVICE at pair/start — the approver cannot
    // change it, only name the identity and pick the workspace
    const gateway = row.type === "gateway";
    const tags = gateway ? ["gateway"] : Array.isArray(body.tags) ? body.tags.map((t: any) => String(t)).slice(0, 10) : [];
    if (!isWsSlug(ws)) throw new Error("bad workspace slug");
    // reserved roots: _-prefixed labels are system namespaces (_direct for
    // directly connected agents) — a gateway may not take one, so
    // _direct/* ownership can never be impersonated by a paired device
    if (/^_/.test(label)) throw new Error(`labels beginning with '_' are reserved system roots (got '${label}')`);
    if (!/^[a-zA-Z0-9._\/-]{2,64}$/.test(label)) throw new Error("label must be 2-64 chars [a-zA-Z0-9._/-]");
    assertHumanLabel(label); // BR#4262 — never impersonate the bkw_/dev_ namespaces
    const member = this.one(`SELECT 1 FROM workspace_members WHERE ws = ? AND login = ?`, ws, login);
    if (!member) throw new Error(`you are not a member of workspace '${ws}'`);
    // mint in the target workspace's DO (registers hash → ws in the central
    // registry); the token flows to the DEVICE via poll, never to the approver
    const stub = (this.env as any).KB.get((this.env as any).KB.idFromName(doWs(ws)));
    const mintRes = await stub.fetch("https://kb/admin.mint", {
      method: "POST",
      headers: { "content-type": "application/json", "x-kb-admin": "1" },
      body: JSON.stringify({ label, tags, principal: row.principal ?? null }),
    });
    const minted = await (mintRes as any).json();
    if (!(mintRes as any).ok || !minted.secret) {
      throw new Error(String(minted?.error ?? "token mint failed"));
    }
    if (minted.reassociated) {
      this.audit(login, "pair.reassociate", code, { device: row.device, ws, label, token: minted.id });
    }
    this.state.storage.sql.exec(
      `UPDATE pairings SET status = 'authorized', ws = ?, label = ?, tags = ?, secret = ?, approved_ts = ? WHERE code = ?`,
      ws, label, JSON.stringify(tags), minted.secret, Date.now(), code,
    );
    this.audit(login, "pair.approve", code, { device: row.device, ws, label });
    return { ok: true, ws, label };
  }

  private async wsPairPoll(body: any) {
    const code = String(body.code ?? "").trim().toUpperCase();
    const row = this.one(`SELECT code, status, secret, ws, label, tags, created_ts, last_poll_ts FROM pairings WHERE code = ?`, code);
    if (!row) return { status: "expired" };
    if (Date.now() - row.created_ts > KnowledgeHub.PAIR_TTL_MS) {
      this.state.storage.sql.exec(`DELETE FROM pairings WHERE code = ?`, code);
      return { status: "expired" };
    }
    // slow-down: devices poll every ~3s; faster than 1.5s gets backed off
    if (row.last_poll_ts && Date.now() - row.last_poll_ts < 1500) {
      return { status: "slow_down" };
    }
    this.state.storage.sql.exec(`UPDATE pairings SET last_poll_ts = ? WHERE code = ?`, Date.now(), code);
    if (row.status === "pending") return { status: "pending" };
    if (row.status === "denied") {
      this.state.storage.sql.exec(`DELETE FROM pairings WHERE code = ?`, code);
      return { status: "denied" };
    }
    // authorized: one-time read — the token leaves the registry exactly once
    this.state.storage.sql.exec(`DELETE FROM pairings WHERE code = ?`, code);
    return {
      status: "authorized",
      token: row.secret,
      ws: row.ws,
      label: row.label,
      tags: row.tags ? JSON.parse(row.tags) : [],
    };
  }

  /** Gateway-provisioned agent tokens (per agent, not per session).
   *  A gw-* caller mints (or rotates) a token FOR a worker it spawns — the
   *  worker's bridge MCP carries this token, so its board actions attribute
   *  to the agent, not the gateway. Secrets are shown once; the gateway
   *  stores them. Exists w/o rotate = { exists: true } (no secret re-exposed). */
  private async agentProvision(body: any, actor: string) {
    const caller = String(body.provisioned_by ?? actor);
    // gateway is a token trait: the caller's TAG provisions, its name is irrelevant
    if (!this.isGatewayActor(caller)) throw new Error(`agent provisioning requires a gateway-class caller ('${caller}' does not carry the gateway tag)`);
    const label = String(body.label ?? "").trim();
    if (!/^[a-zA-Z0-9._\/-]{2,64}$/.test(label)) throw new Error(`agent label '${label}' must be 2-64 chars [a-zA-Z0-9._/-]`);
    assertHumanLabel(label); // BR#4262 — never impersonate the bkw_/dev_ namespaces
    // a namespaced label (<gateway>/<agent>) may only live under the
    // provisioning gateway's own prefix — otherwise an agent label could
    // squat inside another gateway's ownership glob
    if (label.includes("/") && !label.startsWith(`${caller}/`)) {
      throw new Error(`namespaced label '${label}' must live under the provisioning gateway's own namespace ('${caller}/...')`);
    }
    const rotate = body.rotate === true;
    const ts = Date.now();
    // gateway renamed (re-paired on the same principal, BR#3787)? its
    // namespaced agents re-associate onto the new prefix instead of piling
    // up a fresh `<newGW>/<agent>` identity per rename (2026-10-29)
    if (label.includes("/") && !rotate) {
      const renamed = this.agentReassociateOnGatewayRename(caller, label);
      if (renamed) return { exists: true, id: renamed.id, label, reassociated: true };
    }
    const existing = this.one(`SELECT id, revoked_ts FROM auth_tokens WHERE label = ?`, label);
    if (existing && !rotate) {
      if (existing.revoked_ts) throw new Error(`token '${label}' was revoked — provision with rotate to re-mint`);
      return { exists: true, id: existing.id, label };
    }
    if (existing) {
      // label is UNIQUE across ALL rows (schema: `label TEXT NOT NULL UNIQUE`),
      // so the old revoke-then-INSERT could NEVER satisfy it — rotate 400'd
      // with SQLITE_CONSTRAINT_UNIQUE on its first real exercise (2026-10-24;
      // the runner's rotate-retry exposed it). Rotate = replace the row
      // outright: DELETE + INSERT. The audit trail is the history (a revoked
      // row authenticates nothing); sessions.token_id has no FK — an orphaned
      // reference renders label-less in the registry join, harmless.
      this.state.storage.sql.exec(`DELETE FROM auth_tokens WHERE label = ?`, label);
      this.audit(caller, "rotate", label, { old: existing.id, replaced: true });
    }
    const secret = generateAuthToken();
    const hash = await hashAuthToken(secret);
    let id = `at_${crypto.randomUUID().slice(0, 8)}`;
    const tags = JSON.stringify(["provisioned", `by:${caller}`]);
    try {
      this.state.storage.sql.exec(
        `INSERT INTO auth_tokens (id, label, hash, tags, transport, principal, created_ts) VALUES (?, ?, ?, ?, 'mcp', ?, ?)`,
        id, label, hash, tags, body.principal ?? null, ts,
      );
    } catch (e) {
      // Race: two concurrent rotates of the same label (parallel dispatch
      // sessions under one agent label are normal in this fleet) can both
      // pass the lookup, DELETE, then collide on the INSERT — the loser must
      // converge to update-in-place, never 400 (a provisioning 400 strands
      // the runner with a dead token and no repair).
      if (!String(e).includes("UNIQUE")) throw e;
      const racer = this.one(`SELECT id FROM auth_tokens WHERE label = ?`, label) as any;
      if (!racer) throw e;
      this.state.storage.sql.exec(
        `UPDATE auth_tokens SET hash = ?, tags = ?, revoked_ts = NULL WHERE id = ?`,
        hash, tags, racer.id,
      );
      id = racer.id as string;
      this.audit(caller, "rotate", label, { replaced: true, raced: true });
    }
    const ws = this.wsSlug();
    if (ws) {
      const reg = (this.env as any).KB.get((this.env as any).KB.idFromName(doWs(DEFAULT_WS_SLUG)));
      await reg.fetch("https://kb/ws.token_register", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ hash, ws }),
      });
    }
    this.audit(caller, "agent_provision", id, { label, rotate: existing ? true : false });
    return { id, label, secret, provisioned_by: caller };
  }

  /** Gateway self-provision (credential-class ADR, desktop gateway leg):
   *  the human session mints THIS device's gateway-class token — the login
   *  IS the human approval. ONE device credential: hub-vended on first
   *  provision (returned to the desktop, stored, never regenerated),
   *  presented on every later provision — replace-by-PRINCIPAL rotates the
   *  gateway token in place (Ray 2026-10-23: one random generation approach;
   *  no IOPlatformUUID, no client-side p_*). Label = bare hostname slug
   *  (display only, BR#899); class = tags ["gateway"]. Audit op
   *  `self_provision` stamped with the web actor. */
  private async selfProvision(body: any, actor: string) {
    const login = String(body.login ?? "").trim();
    if (!login) throw new Error("self-provision requires the session login (worker-derived)");
    const principal = typeof body.principal === "string" && body.principal.trim() ? body.principal.trim().slice(0, 80) : "";
    let label = selfProvisionLabel(body.host);
    const ws = this.wsSlug() || String(body.ws ?? "");
    const secret = generateAuthToken();
    const hash = await hashAuthToken(secret);
    const mintTags = JSON.stringify(["gateway"]);
    const register = (h: string, p: string | null) =>
      (this.env as any).KB.get((this.env as any).KB.idFromName(doWs(DEFAULT_WS_SLUG))).fetch("https://kb/ws.token_register", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ hash: h, ws, principal: p }),
      });
    let id: string;
    let vended: string | undefined;
    // BR#3787 layer 0 — identity law: the PRINCIPAL is the only identity
    // anchor. A label match whose row carries a DIFFERENT non-null principal
    // is another live device: mint a suffixed row for ours, NEVER rotate
    // theirs (the fleet 401 ping-pong of 2026-10-27 was exactly this theft).
    // A label match with a NULL principal is a legacy pre-principal row:
    // adoptable — the rotation stamps our principal (migration, BR#2840).
    let own = principal
      ? this.one(`SELECT id, label, revoked_ts FROM auth_tokens WHERE principal = ? AND revoked_ts IS NULL`, principal) as any
      : null;
    if (!own) {
      const byLabel = this.one(`SELECT id, label, principal FROM auth_tokens WHERE label = ?`, label) as any;
      if (byLabel && byLabel.principal && byLabel.principal !== principal) {
        let n = 2;
        while (this.one(`SELECT 1 FROM auth_tokens WHERE label = ?`, `${label}-${n}`)) n++;
        label = `${label}-${n}`;
      } else if (byLabel && !byLabel.principal) {
        own = byLabel; // legacy adoption: rotate the row, stamp our principal
      }
    }
    if (own) {
      this.rotateTokenRow(own.id as string);
      // Replace-by-principal rotates THE ROW in place — its label is STABLE.
      // Re-stamping the requested host slug here UNIQUE-fails the moment
      // another row has come to hold it (hostname rename, dev/prod split,
      // fleet suffix history): the desktop startup looped forever on
      // "self-provision failed: UNIQUE constraint failed: auth_tokens.label"
      // (2026-10-27). Label is display-only (BR#899); the row keeps its own.
      this.state.storage.sql.exec(
        `UPDATE auth_tokens SET hash = ?, tags = ?, principal = ?, revoked_ts = NULL WHERE id = ?`,
        hash, mintTags, principal, own.id,
      );
      label = String(own.label ?? label);
      id = own.id as string;
      await register(hash, (vended ?? principal) || null);
    } else {
      // first provision: the hub VENDS the device credential. The principal is
      // an anchor, never a credential — it vends with its own dev_ namespace
      // (generatePrincipalId, BR#4262); generateAuthToken stays secrets-only
      // so a principal can never be mistaken for a bkw_ token. Existing
      // principals are NOT migrated (re-shaping anchors breaks matching).
      vended = principal || generatePrincipalId();
      id = `at_${crypto.randomUUID().slice(0, 8)}`;
      let inserted = false;
      for (let attempt = 0; attempt < 20 && !inserted; attempt++) {
        try {
          this.state.storage.sql.exec(
            `INSERT INTO auth_tokens (id, label, hash, tags, transport, principal, created_ts) VALUES (?, ?, ?, ?, 'mcp', ?, ?)`,
            id, label, hash, mintTags, vended, Date.now(),
          );
          inserted = true;
        } catch (e) {
          if (!String(e).includes("UNIQUE")) throw e;
          // Two collision shapes (BR#3787): the same device racing itself
          // (identical principal — converge to its row, the credential of
          // record) vs another device claiming the label between our lookup
          // and this INSERT (different/absent principal — NEVER touch their
          // row; retry under the next suffixed label).
          const racer = this.one(`SELECT id, principal FROM auth_tokens WHERE label = ?`, label) as any;
          if (racer && principal && racer.principal === principal) {
            this.rotateTokenRow(racer.id as string);
            this.state.storage.sql.exec(
              `UPDATE auth_tokens SET hash = ?, tags = ?, revoked_ts = NULL WHERE id = ?`,
              hash, mintTags, racer.id,
            );
            id = racer.id as string;
            vended = racer.principal as string;
            inserted = true;
          } else {
            let n = 2;
            while (this.one(`SELECT 1 FROM auth_tokens WHERE label = ?`, `${label}-${n}`)) n++;
            label = `${label}-${n}`;
          }
        }
      }
      if (!inserted) throw new Error("self-provision: could not mint a non-colliding label");
      await register(hash, (vended ?? principal) || null); // registry failure fails the mint — never misroute
    }
    this.audit(actor, "self_provision", null, { label, principal: vended ?? principal, login, ws, token_id: id, replaced: !!own });
    const epochRow = this.one(`SELECT epoch FROM auth_tokens WHERE id = ?`, id);
    return { secret, label, ws, id, principal: vended ?? principal, epoch: Number(epochRow?.epoch ?? 1) };
  }

  /** Human alias merge (2026-10-29): dead labels that predate the principal
   *  anchor cannot be auto-clustered — the operator asserts the mapping once
   *  (admin.alias) and every display surface collapses them via canonLabel. */
  private async adminAliasSet(body: any, actor: string) {
    const alias = String(body.alias ?? "").trim();
    const canonical = String(body.canonical ?? "").trim();
    if (!alias || !canonical) throw new Error("alias + canonical required");
    if (alias === canonical) throw new Error("alias and canonical are the same label");
    if (alias.startsWith("_") || canonical.startsWith("_")) throw new Error("system namespaces (_direct/...) are not aliasable");
    if (this.one(`SELECT 1 FROM identity_aliases WHERE label = ?`, canonical))
      throw new Error(`'${canonical}' is itself a retired alias — merge into '${this.canonLabel(canonical)}' instead`);
    const live = this.one(`SELECT id FROM auth_tokens WHERE label = ? AND revoked_ts IS NULL`, canonical);
    if (!live) throw new Error(`canonical label '${canonical}' has no live token`);
    this.recordAlias(alias, canonical);
    this.audit(actor, "identity_alias", null, { alias, canonical });
    return { ok: true, alias, canonical, alias_set_size: this.aliasSetOf(canonical).size };
  }

  private async tokenMint(body: any) {
    const label = String(body.label ?? "").trim();
    if (!/^[a-zA-Z0-9._\/-]{2,64}$/.test(label)) throw new Error("label must be 2-64 chars [a-zA-Z0-9._/-]");
    assertHumanLabel(label); // BR#4262 — never impersonate the bkw_/dev_ namespaces
    // the only '/' allowed in a human-minted label is the reserved
    // _direct/ root — directly connected agents live there
    if (label.includes("/") && !label.startsWith("_direct/")) {
      throw new Error("labels cannot contain '/' — only the reserved _direct/ root (directly connected agents) may");
    }
    // The device credential (principal) is the rotation anchor — BR#2711 §2:
    // labels are display; the hub-vended, generate-once-never-change
    // credential keys replace-on-re-pair (no IOPlatformUUID, no device_id —
    // both withdrawn).
    const principal = typeof body.principal === "string" && body.principal.trim() ? body.principal.trim().slice(0, 80) : null;
    // Replace semantics (pairing is an approval) — BR#3787 identity law: the
    // PRINCIPAL is the only identity anchor. The same machine re-pairing
    // rotates its own token (renamed or not). A label held by a DIFFERENT
    // non-null principal is another live device: REJECT with a named error
    // (the human picks another label) — rotation never steals, never
    // deletes another device's credential. A label held by a NULL-principal
    // legacy row is adoptable (migration, BR#2840): the legacy credential is
    // retired and the fresh principal takes the name.
    const secret = generateAuthToken();
    const hash = await hashAuthToken(secret);
    const own = principal ? this.one(`SELECT id, label, revoked_ts, principal FROM auth_tokens WHERE principal = ? AND revoked_ts IS NULL`, principal) as any : null;
    const byLabel = this.one(`SELECT id, label, principal FROM auth_tokens WHERE label = ?`, label) as any;
    if (byLabel && own?.id !== byLabel.id && byLabel.principal && byLabel.principal !== principal) {
      throw new Error(`label '${label}' already belongs to another device's credential — pick a different label (rotation never steals, BR#3787)`);
    }
    if (own && byLabel && own.id !== byLabel.id) {
      // legacy NULL-principal row under the name we want: retire it (the
      // pre-principal credential migrates to this device's principal)
      this.state.storage.sql.exec(`DELETE FROM auth_tokens WHERE id = ?`, byLabel.id);
      this.audit("pair", "replace", byLabel.id, { label });
    }
    const target = (own && !byLabel) ? own : (byLabel ?? own);
    if (target) {
      const epoch = this.rotateTokenRow(target.id as string);
      const prevLabel = String((target as any).label ?? "");
      // the vended class rides with the replacement: a gateway pairing must
      // not leave the row carrying the replaced token's stale tags
      const mintTags = Array.isArray(body.tags) ? body.tags.map((t: any) => String(t).slice(0, 40)).slice(0, 10) : [];
      this.state.storage.sql.exec(
        `UPDATE auth_tokens SET hash = ?, label = ?, tags = ?, principal = COALESCE(?, principal), revoked_ts = NULL WHERE id = ?`,
        hash, label, JSON.stringify(mintTags), principal, target.id,
      );
      // the machine is the same (principal-anchored) — the old display name
      // becomes an alias so history and the board resolve to the live label
      this.recordAlias(prevLabel, label);
      const ws = this.wsSlug();
      if (ws) {
        const reg = (this.env as any).KB.get((this.env as any).KB.idFromName(doWs(DEFAULT_WS_SLUG)));
        await reg.fetch("https://kb/ws.token_register", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ hash, ws, principal }),
        });
      }
      this.audit("pair", "reassociate", target.id, { label });
      return { id: target.id, label, secret, reassociated: true, epoch };
    }
    const tags = Array.isArray(body.tags) ? body.tags.map((t: any) => String(t).slice(0, 40)).slice(0, 10) : [];
    const transport = (TRANSPORTS as readonly string[]).includes(body.transport) ? body.transport : "mcp";
    let id = `at_${crypto.randomUUID().slice(0, 8)}`;
    const ts = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO auth_tokens (id, label, hash, tags, transport, principal, created_ts) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, label, hash, JSON.stringify(tags), transport, principal, ts,
    );
    // register hash → workspace in the central registry so /mcp routes this
    // token here. Registry failure must fail the mint — a silently unregistered
    // token would misroute to the default workspace.
    const ws = this.wsSlug();
    if (ws) {
      const reg = (this.env as any).KB.get((this.env as any).KB.idFromName(doWs(DEFAULT_WS_SLUG)));
      await reg.fetch("https://kb/ws.token_register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hash, ws, principal }),
      });
    }
    this.audit("admin", "mint", id, { label, transport, tags });
    return { id, label, tags, transport, secret, epoch: 1 }; // secret shown exactly once
  }

  /** BR#3787 layer 2 — agent-plane repair: a device holding its principal
   *  re-vends ITS OWN row's token without the human plane (headless-safe —
   *  the principal IS the durable credential, BR#2711 §2). Matches by
   *  principal ONLY (never by label — the theft class). Rate-limited per row
   *  so a crash loop cannot mint infinitely. Unknown/revoked principal →
   *  named error: the runner's cue for the loud re-pair logout. */
  private async tokenRepair(body: any) {
    const principal = typeof body.principal === "string" && body.principal.trim() ? body.principal.trim().slice(0, 80) : "";
    if (!principal) throw new Error("repair requires the device principal");
    const row = this.one(
      `SELECT id, label, hash, epoch, revoked_ts, repairs_count, repairs_window_ts FROM auth_tokens
       WHERE principal = ? AND revoked_ts IS NULL
       ORDER BY COALESCE(last_seen_ts, created_ts) DESC LIMIT 1`,
      principal,
    ) as any;
    if (!row) throw new Error("no live token for this principal — re-pair required (principal unknown, revoked, or reset)");
    const now = Date.now();
    const inWindow = typeof row.repairs_window_ts === "number" && now - row.repairs_window_ts < TOKEN_REPAIR_WINDOW_MS;
    const count = inWindow ? Number(row.repairs_count ?? 0) : 0;
    if (count >= TOKEN_REPAIR_LIMIT) {
      throw new Error(`repair rate limit reached (${TOKEN_REPAIR_LIMIT}/hour) — park and retry within the hour`);
    }
    const secret = generateAuthToken();
    const hash = await hashAuthToken(secret);
    this.rotateTokenRow(row.id as string);
    this.state.storage.sql.exec(
      `UPDATE auth_tokens SET hash = ?, repairs_count = ?, repairs_window_ts = ? WHERE id = ?`,
      hash, count + 1, now, row.id,
    );
    const ws = this.wsSlug();
    if (ws) {
      const reg = (this.env as any).KB.get((this.env as any).KB.idFromName(doWs(DEFAULT_WS_SLUG)));
      await reg.fetch("https://kb/ws.token_register", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ hash, ws, principal }),
      });
    }
    this.audit("self", "repair", row.id, { label: row.label, epoch: Number(row.epoch ?? 1) + 1 });
    return { secret, label: row.label, ws, id: row.id, epoch: Number(row.epoch ?? 1) + 1, principal };
  }

  private async tokenList() {
    const rows = this.state.storage.sql.exec(
      `SELECT id, label, tags, transport, created_ts, last_seen_ts, revoked_ts FROM auth_tokens ORDER BY created_ts DESC`,
    ).toArray();
    const sessions = this.state.storage.sql.exec(
      `SELECT token_id, name, first_seen_ts, last_seen_ts FROM sessions ORDER BY last_seen_ts DESC`,
    ).toArray();
    // gateway → dispatched-agent edges for Connect's grouping (BR#2455)
    const gateway_agents = this.state.storage.sql.exec(
      `SELECT gateway, agent, last_seen_ts FROM gateway_agents ORDER BY last_seen_ts DESC LIMIT 200`,
    ).toArray();
    return { tokens: rows.map((r) => ({ ...r, tags: parseTags(r.tags) })), sessions, gateway_agents };
  }

  private async tokenRevoke(body: any) {
    const id = String(body.id ?? "");
    const row = this.one(`SELECT id, label FROM auth_tokens WHERE id = ?`, id);
    if (!row) throw new Error(`no such auth token: ${id}`);
    this.state.storage.sql.exec(`UPDATE auth_tokens SET revoked_ts = ? WHERE id = ?`, Date.now(), id);
    this.audit("admin", "revoke", id, { label: row.label });
    return { id, revoked: true };
  }

  /** Update an agent's tags (roles/capabilities) in place — no re-mint, the secret stays valid. */
  private async tokenTags(body: any) {
    const id = String(body.id ?? "");
    const row = this.one(`SELECT id, label, tags FROM auth_tokens WHERE id = ?`, id);
    if (!row) throw new Error(`no such auth token: ${id}`);
    const tags = sanitizeTags(body.tags);
    this.state.storage.sql.exec(
      `UPDATE auth_tokens SET tags = ? WHERE id = ?`,
      tags ? JSON.stringify(tags) : "[]", id,
    );
    this.audit("admin", "tags", id, { label: row.label, tags: tags ?? [] });
    return { id, label: row.label, tags: tags ?? [] };
  }

  private async settingsGet() {
    return { settings: this.settingsMap() };
  }

  private async settingsSet(body: any) {
    const entries = Object.entries(body.settings ?? {}).filter(([k]) => /^[a-z0-9_]{1,40}$/.test(k));
    if (entries.length === 0) throw new Error("no valid settings keys (lowercase [a-z0-9_])");
    for (const [k, v] of entries) {
      this.state.storage.sql.exec(
        `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
        k, JSON.stringify(v),
      );
      this.audit("admin", "settings", k, {});
    }
    return { settings: this.settingsMap() };
  }

  // ---------- serialized merge train (BR#3516) ----------
  // Lane card primitive + lease CAS + train events + the derived queue, on
  // the DO. Division of labour: the EXECUTOR (bridge train on a
  // gateway machine, worker-local gh, doctor-defended) fetches GitHub facts
  // and performs the merge; the HUB decides (this state machine) and holds
  // NO VCS credentials — every fact here was reported by a gateway, the
  // verify duty's close note, or the queue derive. Pinned in
  // test/merge-train.test.ts + test/train-hub.test.ts.

  /** Lane card lookup by meta.lane.key (exact). BR#5061: a lane key can have
   *  MULTIPLE cards after an erroneous close + reseed (the terminal original
   *  + the live successor) — the LIVE card wins, newest first; terminal
   *  (done/superseded ⇒ retired, BR#4977) cards bind nothing ever again.
   *  The 2026-10-29 outage: LIMIT 1 returned the retired original every
   *  tick and the lane could not self-heal onto its reseed. */
  private laneRow(laneKeyValue: string): any {
    return this.one(
      `SELECT id, type, status, title, body_md, meta, tags, roles, status_ts, owner FROM artefacts
       WHERE type = 'task' AND json_extract(meta, '$.lane.key') = ?
       ORDER BY CASE WHEN status IN ('done','superseded') THEN 1 ELSE 0 END ASC, created_ts DESC
       LIMIT 1`,
      laneKeyValue,
    );
  }

  /** BR#5061: the terminal card(s) carrying a lane key — the retired side of
   *  a reseed. Volatile in-flight state (currently/stop/bypass_wait) may
   *  still live there and must migrate to the live card before the lane's
   *  history goes dark. */
  private laneTerminalRows(laneKeyValue: string): any[] {
    return (this.state.storage.sql.exec(
      `SELECT id, status, meta, status_ts FROM artefacts
       WHERE type = 'task' AND json_extract(meta, '$.lane.key') = ? AND status IN ('done','superseded')
       ORDER BY created_ts ASC`,
      laneKeyValue,
    ).toArray() ?? []) as any[];
  }

   /** Find-or-create the standing lane card for (repo, base). Seed config:
    *  settings key `train_lane` (JSON map keyed by "repo@base" →
    *  {required_workflows, ci_typical_minutes}); the card's meta.lane is the
    *  working copy (config, never hardcoded — BR#3516 §1).
    *  BR#5061 skip-terminal + rebind, reconciled with the BR#4977 lane
    *  lifecycle (accepted, PR #331): a terminal (done/superseded) lane card
    *  never binds the train. When a LIVE successor exists — the supersedes
    *  edge (the reseed convention) or any non-terminal card carrying the
    *  same key — the lane rebinds onto it and the volatile in-flight state
    *  (an awaiting-CI merge, a line stop, a bypass wait) migrates once,
    *  loudly (lane_rebound). With NO successor the lane is deliberately
    *  RETIRED (BR#4977): every op refuses ("lane retired"), no meta writes,
    *  no re-arm — re-open the card or register a reseed to re-arm. This
    *  supersedes the BR#5061 spec's create-fresh clause on the no-successor
    *  path (an accepted decision outranks the spec; the rebind path — the
    *  2026-10-29 outage's keystone — is unchanged). */
  private async laneEnsure(repo: string, base: string, actor: string, cfg?: Partial<LaneSpec>): Promise<any> {
    const key = laneKey(repo, base);
    let existing = this.laneRow(key);
    const terminals = this.laneTerminalRows(key);
    if (terminals.length) {
      if (!existing || existing.status === "done" || existing.status === "superseded") {
        // resolve the live successor: supersedes edge first (the reseed
        // convention), then any non-terminal card carrying the key (newest).
        this.audit(actor, "lane_terminal_skipped", existing?.id ?? terminals[0].id, {
          lane: key, retired_status: existing?.status ?? terminals[0].status,
          rebound_to: "resolving",
          note: "BR#5061: terminal lane card must not bind the train — rebinding",
        });
        let live: any = null;
        for (const t of terminals) {
          const viaEdge = this.one(
            `SELECT a.id AS id FROM relations r JOIN artefacts a ON a.id = r.src_id
             WHERE r.relation = 'supersedes' AND r.dst_id = ?
               AND a.type = 'task' AND a.status NOT IN ('done','superseded')
               AND json_extract(a.meta, '$.lane.key') = ?
             ORDER BY a.created_ts DESC LIMIT 1`,
            t.id, key,
          );
          if (viaEdge) { live = viaEdge; break; }
        }
        if (!live) {
          live = this.one(
            `SELECT id FROM artefacts
             WHERE type = 'task' AND json_extract(meta, '$.lane.key') = ? AND status NOT IN ('done','superseded')
             ORDER BY created_ts DESC LIMIT 1`,
            key,
          );
        }
        if (!live) {
          // BR#4977 lane lifecycle: no successor means deliberately retired —
          // the single refusal point (the BR#4772 drill-residue class): no
          // lease/CPO meta writes, no config refresh, no re-arm, and no
          // create-fresh resurrection (BR#5061's spec clause is superseded
          // here by the accepted decision). Re-arm is a deliberate lifecycle
          // act — re-open the lane card or register a reseed.
          throw new Error(`lane retired — ${key}'s lane card ${terminals[0].id} is ${terminals[0].status}; the tick does not touch a retired lane (BR#4772/BR#4977) — re-open the lane card (or register a reseed successor) to re-arm`);
        }
        existing = this.one(
          `SELECT id, type, status, title, body_md, meta, tags, roles, status_ts, owner FROM artefacts WHERE id = ?`,
          live.id,
        );
      }
      // one-time volatile-state migration off every terminal card: an
      // awaiting-ci merge / line stop / bypass wait survives the rebind.
      // Idempotent — a terminal card with no volatile state is a no-op.
      let migrated = false;
      for (const t of terminals) {
        const tm = JSON.parse(t.meta ?? "{}");
        const vol = { currently: tm.currently ?? null, stop: tm.stop ?? null, bypass_wait: tm.bypass_wait ?? null };
        if (!vol.currently && !vol.stop && !vol.bypass_wait) continue;
        const liveRow = this.one(
          `SELECT id, meta FROM artefacts
           WHERE type = 'task' AND json_extract(meta, '$.lane.key') = ? AND status NOT IN ('done','superseded')
           ORDER BY created_ts DESC LIMIT 1`,
          key,
        );
        if (!liveRow) break; // nothing to migrate onto — the retired refusal owns this case
        const lm = JSON.parse(liveRow.meta ?? "{}");
        const patched = { ...lm };
        for (const [k2, v] of Object.entries(vol)) {
          if (v && !patched[k2]) patched[k2] = v;
        }
        this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(patched), liveRow.id);
        for (const [k2, v] of Object.entries(vol)) {
          if (v) tm[k2] = null;
        }
        this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(tm), t.id);
        this.audit(actor, "lane_rebound", liveRow.id, {
          lane: key, from_terminal: t.id,
          migrated: Object.entries(vol).filter(([, v]) => !!v).map(([k2]) => k2),
          note: "BR#5061: volatile lane state migrated off the terminal card — in-flight merges finish their landing close on the live card",
        });
        this.version(liveRow.id, actor, "lane_rebound", `lane rebound off retired ${t.id} onto this card (BR#5061) — in-flight state migrated, the tick drives this card now`, { from_terminal: t.id });
        migrated = true;
      }
      // the caller (trainLease/trainEvent/trainCi) parses THIS return value
      // and writes its own meta updates from it — a stale pre-migration
      // snapshot would STOMP the migrated state one write later. Re-fetch.
      if (migrated) existing = this.laneRow(key);
    }
    if (existing && existing.status !== "done" && existing.status !== "superseded") {
      // config updates ride the op that knows better (operator/executor):
      // required_workflows / ci_typical_minutes / burst_max refresh in place.
      const cur = laneOfMeta(existing.meta);
      if (cfg && cur && (cfg.required_workflows || cfg.ci_typical_minutes != null || cfg.burst_max != null) &&
          (JSON.stringify(cfg.required_workflows ?? cur.required_workflows) !== JSON.stringify(cur.required_workflows) ||
            (cfg.ci_typical_minutes ?? cur.ci_typical_minutes) !== cur.ci_typical_minutes ||
            (cfg.burst_max ?? cur.burst_max) !== cur.burst_max)) {
        const meta = JSON.parse(existing.meta ?? "{}");
        meta.lane = { ...meta.lane, ...(cfg.required_workflows ? { required_workflows: cfg.required_workflows } : {}), ...(cfg.ci_typical_minutes != null ? { ci_typical_minutes: cfg.ci_typical_minutes } : {}), ...(cfg.burst_max != null ? { burst_max: parseBurstMax(cfg.burst_max) } : {}) };
        meta.lane.key = key;
        this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), existing.id);
        this.audit(actor, "train_lane_config", existing.id, { lane: meta.lane });
      }
      return existing;
    }
    if (existing) {
      // unreachable defensive posture: a terminal card with NO terminal rows
      // above (status changed mid-flight) — fall through to create-fresh.
      this.audit(actor, "lane_terminal_still_bound", existing.id, { lane: key, status: existing.status, note: "BR#5061 defensive: creating a fresh standing card" });
    }
    existing = await this.laneCreate(repo, base, actor, key, cfg ?? {});
    return existing;
  }

  /** The create leg of laneEnsure — seeds config from settings unless the
   *  caller supplied an inheritance/cfg bundle. */
  private async laneCreate(repo: string, base: string, actor: string, key: string, cfg?: Partial<LaneSpec>): Promise<any> {
    // seed from settings (admin.settings_set) — the operator's lane config
    let seeded: Partial<LaneSpec> = cfg ?? {};
    try {
      const raw = this.settingValue("train_lane", "");
      if (raw) {
        const map = JSON.parse(raw);
        const s = map?.[key] ?? {};
        seeded = { required_workflows: Array.isArray(s.required_workflows) ? s.required_workflows.map(String) : undefined, ci_typical_minutes: typeof s.ci_typical_minutes === "number" ? s.ci_typical_minutes : undefined, ...seeded, burst_max: parseBurstMax(seeded.burst_max ?? s.burst_max) };
      }
    } catch { /* no/broken setting — defaults hold */ }
    const lane: LaneSpec = { repo, base, required_workflows: seeded.required_workflows ?? [], ci_typical_minutes: seeded.ci_typical_minutes ?? TRAIN_CI_TYPICAL_MINUTES, burst_max: parseBurstMax(seeded.burst_max) };
    const alarmSink = this.settingValue("train_alarm_sink_id", TRAIN_ALARM_SINK_ID);
    const created = await this.create(
      {
        type: "task",
        title: laneCardTitle(repo, base),
        body_md: laneCardBody(lane, { alarm_sink: alarmSink }),
        meta: { lane: { ...lane, key }, lease: null, currently: null, stop: null },
        tags: ["merge-train", "infrastructure"],
      },
      actor,
    );
    // infrastructure card: blocked from birth, never claimed. The merge_train
    // flag suppresses the unblock-duty spawn (the train advances this card).
    // The blocked-needs-path invariant demands the unblock condition — the
    // lane's exit path is the executor, not an agent.
    await this.transition(
      {
        id: created.id,
        to: "blocked",
        note: "merge-train: awaiting an available gateway",
        merge_train: true,
        unblock_condition: "the train advances this card — run bridge train on a gateway (doctor-gated)",
      },
      actor,
    );
    this.audit(actor, "create", created.id, { type: "task", auto: "lane", lane_key: key });
    return this.laneRow(key);
  }

  /** Recompute the lane card's blocked reason from its meta — the ONLY
   *  reason-writer, so the lane always shows the truth. Idempotent.
   *  BR#4981 activity vocabulary (Ray directive: "i dont see it actively
   *  trying to merge anything"): the reason now names WHAT the train is doing,
   *  all hub-derivable, never a bare `ready` while a queue exists —
   *  retired (BR#4977) / bypass-wait (protection-blocked head) / STOPPED
   *  (with the culprit card named) / settling (with the next head named) /
   *  attempting <head> (gate in progress on the queue head) / ready (queue
   *  empty) / no gateway, plus a `; last: <event>` bounce feed suffix when
   *  the ledger moved inside 15 minutes. */
  private laneSyncReason(laneId: string, meta: any, now: number): string {
    const lane = laneOfMeta(meta);
    const lease: TrainLease | null = meta.lease ?? null;
    const currently = meta.currently ?? null;
    const stop = meta.stop ?? null;
    // BR#4977: a retired lane (card done/superseded) never ticks again.
    const laneRow = this.one(`SELECT status FROM artefacts WHERE id = ?`, laneId) as any;
    const retired = !!laneRow && (laneRow.status === "done" || laneRow.status === "superseded");
    // BR#4981: the derived queue head (what the train is attempting) and the
    // lane's last ledger action (the bounce feed) are both hub-derivable.
    const queue = lane ? this.laneQueue(lane.repo, lane.base) : [];
    const head = queue[0]?.id ? String(queue[0].id) : null;
    const lastAct: any = lane ? (this.state.storage.sql.exec(
      `SELECT ts, kind, pr, task_id FROM train_events WHERE repo = ? AND base = ? ORDER BY seq DESC LIMIT 1`,
      lane.repo, lane.base,
    ).toArray()[0] ?? null) : null;
    const actSuffix = lastAct && now - Number(lastAct.ts ?? 0) < 15 * 60_000
      ? `; last: ${lastAct.kind}${lastAct.pr ? ` PR #${lastAct.pr}` : ""}${lastAct.task_id ? ` (${lastAct.task_id})` : ""}`
      : "";
    const bw = meta.bypass_wait ?? null;
    // BR#5114 round 2 (Ray 2026-10-30: "remove jargon — make it clear"):
    // the lane's activity line speaks human. The hub knows the head card's
    // own train state — a 'bounced' head is waiting on a FRESH REVIEW (its
    // PR branch changed after the last review, so that review no longer
    // covers it); anything else is the pre-merge check running. No "gate",
    // no "verdict", no "attempting" — plain sentences.
    const headHold = head
      ? (() => {
          const hm = this.one(`SELECT meta FROM artefacts WHERE id = ?`, head) as any;
          const st = hm ? String(JSON.parse(hm.meta ?? "{}")?.merge_train?.state ?? "") : "";
          return st === "bounced"
            ? { class: "awaiting-review" as const, note: `waiting on ${head} — its PR branch changed after the last review, so a fresh review is needed before it can merge` }
            : { class: "merge-checks" as const, note: `working on ${head} — checking review, signatures and CI before merging` };
        })()
      : null;
    let reason: string;
    if (retired) reason = `merge-train: retired — the lane card is done/superseded (BR#4977); the train no longer ticks it`;
    else if (stop) {
      const culpritNote = stop.culprit_task ? ` — culprit ${stop.culprit_task}` : "";
      reason = `merge-train: STOPPED — ${stop.reason}${culpritNote} (resume when the line is green)`;
    }
    else if (currently) {
      const who = lease ? ` by ${lease.holder}` : "";
      const nextNote = head ? `, then ${head}` : "";
      const bwNote = meta.bypass_wait ? ` — bypass wait: PR #${meta.bypass_wait.pr}${meta.bypass_wait.task_id ? ` (${meta.bypass_wait.task_id})` : ""}` : "";
      // BR#4804 back-pressure: the settling phase is the queue's pressure
      // valve — the reason names what main is doing and that heads are held
      // BR#4753: a failing landed close names itself — the wedge forming is
      // visible on the lane card, not silent behind a settling reason
      const lc = currently.landed_close as any;
      // BR#4934 burst phases: mid-drain the lane says it is merging
      // back-to-back; settling names the pass so the queue knows a settle is
      // pending. Legacy executors (no burst fields) keep the BR#4804 strings
      // byte-identical (with BR#4981's nextNote/bwNote suffixes) — the
      // strings are dedupe/pin surfaces.
      if (currently.phase === "bursting") {
        reason = `merge-train: leased${who} — merging burst (${Number(currently.burst_merged ?? 0)} merged, cap ${currently.burst_cap === 0 ? "unlimited" : Number(currently.burst_cap ?? 0)}) — settle pending`;
      } else if (currently.burst_merged != null && !lc) {
        reason = `merge-train: leased${who} — settling on ${String(currently.merge_sha ?? "").slice(0, 9)} after ${Number(currently.burst_merged)} merges (PR #${currently.pr}): build/deploy in flight${nextNote}, heads held until main settles${bwNote}`;
      } else
        reason = lc
          ? `merge-train: leased${who} — settling on ${String(currently.merge_sha ?? "").slice(0, 9)} (PR #${currently.pr}): landed close FAILED ${lc.failures}× (${lc.breach_class ?? "?"}) — retrying, close-bounce at ≤${TRAIN_LANDED_CLOSE_MAX_RETRIES} or the bound (BR#4753)${nextNote}`
          : `merge-train: leased${who} — settling on ${String(currently.merge_sha ?? "").slice(0, 9)} (PR #${currently.pr}): build/deploy in flight${nextNote}, heads held until main settles${bwNote}`;
    } else if (bw) reason = `merge-train: awaiting bypass merge — PR #${bw.pr} by ${bw.task_id ?? "?"} blocked on branch protection (review/required checks a machine cannot satisfy); a human merge is the unblock, self-clears when it lands${queue.length ? ` — the walk continues on the other ${queue.length} queued head(s)` : ""}`;
    else if (meta.zombie) {
      // BR#4129: the last holder was evicted mid-queue — show WHY the lane is
      // free until the next acquire clears the stamp (board visibility).
      const z = meta.zombie;
      const mins = Math.max(1, Math.round(Number(z.age_ms ?? 0) / 60_000));
      const queued = Number(z.queue_len ?? 0);
      reason = `merge-train: zombie holder evicted — ${z.holder ?? "?"} made no progress for ${mins}m on a non-empty queue (${queued} queued) — awaiting an available gateway`;
    } else if (lease && lease.expires_ts > now) {
      reason = head && headHold
        ? `merge-train: leased by ${lease.holder} — ${headHold.note}${actSuffix}`
        : `merge-train: leased by ${lease.holder} — idle`;
    } else {
      // Ray 2026-10-29: idle no longer reads as a gateway shortage — a recent
      // merge-capable tick means the train is READY (name the machine + age);
      // only past TRAIN_READY_MS is the honest "awaiting" true.
      const capAt = Number(meta.lane?.last_capable_lease_ts ?? 0);
      const capHolder = String(meta.lane?.last_capable_holder ?? "");
      const mins = Math.max(0, Math.round((now - capAt) / 60_000));
      reason = capAt && capHolder && now - capAt < TRAIN_READY_MS
        ? (head && headHold
          ? `merge-train: ready — ${headHold.note}, last ticked by ${capHolder} ${mins}m ago${actSuffix}`
          : `merge-train: ready — last ticked by ${capHolder} ${mins}m ago`)
        : "merge-train: awaiting an available gateway";
    }
    if (meta.blocked?.reason !== reason) {
      meta.blocked = { ...(meta.blocked ?? {}), reason, unblock_condition: meta.blocked?.unblock_condition ?? "the train advances this card — run bridge train on a gateway (doctor-gated)" };
      this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), laneId);
    }
    return reason;
  }

  /** Arm (G) — train-watch: lease staleness (the hub's credential-free
   *  monitoring job). A lapsed lease is cleared and the lane shows the honest
   *  `awaiting an available gateway`; the next gateway reconciles from live
   *  GitHub and acquires. No GitHub calls, no asks (an idle lane is not an
   *  incident — the red line is, and that lives in the stopped flow). */
  private async trainWatchSweep(now: number): Promise<void> {
    const rows = this.state.storage.sql.exec(
      `SELECT id, status, meta FROM artefacts WHERE type = 'task' AND json_extract(meta, '$.lane.key') IS NOT NULL`,
    ).toArray() as any[];
    for (const r of rows) {
      try {
        // BR#4977: a retired lane card is frozen — no lease_lapsed clears,
        // no reason resyncs on a card marked "never tick again".
        if (r.status === "done" || r.status === "superseded") continue;
        const meta = JSON.parse(r.meta ?? "{}");
        const lease: TrainLease | null = meta.lease ?? null;
        const lapsed = !!lease && lease.expires_ts <= now;
        if (lapsed) {
          const holder = lease!.holder;
          meta.lease = null;
          const reason = this.laneSyncReason(r.id, meta, now);
          this.audit("system:merge-train", "lease_lapsed", r.id, { holder, expired_at: new Date(lease!.expires_ts).toISOString(), reason });
          this.version(r.id, "system:merge-train", "lease_lapsed", `lease of ${holder} lapsed — ${reason}`, {});
        } else if (meta.blocked?.reason === "merge-train: leased by ..." || !meta.blocked?.reason?.startsWith("merge-train:")) {
          // reason drifted (older class version) — resync to the truth
          this.laneSyncReason(r.id, meta, now);
        }
      } catch (e) {
        this.audit("system:merge-train", "watch_error", r.id, { error: String((e as Error).message ?? e).slice(0, 200) });
      }
    }
  }

  /** train.lease — the CAS op. The DO is single-threaded, so the
   *  read-check-write is atomic by construction; leaseDecide is the check.
   *  holder defaults to the authenticated actor (the acting gateway). */
  private async trainLease(body: any, actor: string): Promise<any> {
    const repo = String(body.repo ?? "").trim();
    const base = String(body.base ?? "main").trim();
    const action: LeaseAction = ["acquire", "renew", "release"].includes(String(body.action)) ? body.action : null;
    if (!action) throw new Error("action must be acquire | renew | release");
    const holder = String(body.holder ?? actor).trim() || actor;
    const lane = await this.laneEnsure(repo, base, actor);
    const meta = JSON.parse(lane.meta ?? "{}");
    const now = Date.now();
    const decided = leaseDecide(meta.lease ?? null, now, holder, action);
    if (decided.ok === false) throw Object.assign(new Error(decided.reason), { lease_conflict: true });
    // ---- zombie eviction (BR#4129 — the hub half of proof-of-progress,
    // gateway half rode PR #263): a renewal on a NON-EMPTY queue whose action
    // note is frozen past TRAIN_PROGRESS_STALE_MS is denied and the lease
    // expires, so the next gateway's acquire wins within one tick. A missing
    // proof (legacy `{}` renewals) is UNKNOWN — allowed + loud audit while
    // the deprecation window runs (BR#4104 retires those senders). ----
    if (action === "renew") {
      const queue = this.laneQueue(repo, base);
      const progress = renewProgressDecide(body.progress ?? null, holder, queue.length);
      if (progress.ok === false) {
        const proofNote = typeof (body.progress ?? {})?.progress === "string" ? String(body.progress.progress).slice(0, 200) : "";
        meta.lease = null; // expire — takeover within one tick
        meta.zombie = { holder, at: now, age_ms: progress.stale_ms, queue_len: queue.length, last_progress: proofNote };
        this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), lane.id);
        const reason = this.laneSyncReason(lane.id, meta, now);
        this.audit(actor, "train:lease_evicted", lane.id, { lane: laneKey(repo, base), holder, stale_ms: progress.stale_ms, queue_len: queue.length, reason });
        this.version(lane.id, actor, "train:lease_evicted", `renewal denied — ${progress.reason}`, { lease: null, zombie: meta.zombie, reason });
        throw Object.assign(new Error(progress.reason), { lease_conflict: true });
      }
      if (progress.verdict === "unknown" && queue.length > 0) {
        this.audit(actor, "train:lease_renew_no_progress_proof", lane.id, { lane: laneKey(repo, base), holder, queue_len: queue.length, note: "legacy renewal carries no progress payload — allowed (deprecation window, BR#4129)" });
      }
    }
    meta.lease = decided.lease;
    if (action === "acquire") meta.zombie = null; // fresh holder — the eviction stamp did its job
    // BR#4489 capability-aware starvation: every lease op stamps liveness;
    // worker-class (merge-capable) executors also stamp the capable clock.
    // A non-empty queue with no capable lease inside the starve window means
    // the lane cannot advance even though gateways may be ticking (the
    // 2026-10-29 outage: bounces flowed, merges stood down).
    meta.lane = {
      ...(meta.lane ?? {}),
      key: laneKey(repo, base),
      last_lease_ts: now,
      ...(body.merge_capable === true ? { last_capable_lease_ts: now, last_capable_holder: holder } : {}),
    };
    if (body.merge_capable === true && meta.lane.starved_since) {
      meta.lane.starved_since = null; // a capable executor is back — episode over
    }
    // BR#5114: consume the proof-of-progress seam. BR#4104 put the holder's
    // last action + age on every renewal; the hub discarded it ("consuming
    // it is the filed follow-up"). Persist the latest as the lane's NOW
    // line — WHAT the holder is doing this minute (the trains panel renders
    // it; a stale one ages out client-side against the 5-min lease TTL).
    const progNote = typeof (body.progress ?? {})?.progress === "string" ? String(body.progress.progress).slice(0, 200) : "";
    if (action === "renew" && progNote) {
      meta.lane = { ...meta.lane, now_action: { note: progNote, holder, at: now } };
    }
    // acquisition carries the executor's lane config (required workflows —
    // config, never hardcoded); release clears the stop when the line is green again.
    if (action === "acquire" && (body.required_workflows || body.ci_typical_minutes != null || body.burst_max != null)) {
      meta.lane = { ...meta.lane, ...(body.required_workflows ? { required_workflows: (body.required_workflows as unknown[]).map(String).filter(Boolean) } : {}), ...(body.ci_typical_minutes != null ? { ci_typical_minutes: Number(body.ci_typical_minutes) } : {}), ...(body.burst_max != null ? { burst_max: parseBurstMax(body.burst_max) } : {}) };
      meta.lane.key = laneKey(repo, base);
    }
    if (action === "release" && body.line_green) {
      meta.stop = null;
      // the stopped phase's in-flight record is the BROKEN merge commit —
      // never poll it toward a landing; the culprit card was bounced at stop
      // time, so the lane simply goes idle.
      if (meta.currently?.phase === "stopped") meta.currently = null;
    }
    const reason = this.laneSyncReason(lane.id, meta, now);
    // BR#5114: laneSyncReason persists only on a reason CHANGE — the
    // now_action stamp refreshes every renewal without one, so persist it
    // explicitly (idempotent; ~1 write per lane per tick).
    if (action === "renew" && progNote) {
      this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(meta), now, lane.id);
    }
    this.audit(actor, `train:lease_${action}`, lane.id, { lane: laneKey(repo, base), note: decided.note });
    this.version(lane.id, actor, `train:lease_${action}`, decided.note, { lease: meta.lease, reason });
    return { ok: true, lane: laneKey(repo, base), lease: meta.lease, currently: meta.currently ?? null, stop: meta.stop ?? null, reason, note: decided.note };
  }

  /** Resolve the delivery chain for a queued/landed PR — task, verdict
   *  (closed verify child), session — board data only, zero GitHub calls
   *  (BR#3516 §7). */
  private trainChain(taskId: string | null): { task_id: string | null; verdict_id: string | null; session: string | null } {
    if (!taskId) return { task_id: null, verdict_id: null, session: null };
    const v = this.one(
      `SELECT c.id AS id, c.meta AS meta FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status = 'done' AND c.roles LIKE '%"review"%'
       ORDER BY c.updated_ts DESC LIMIT 1`,
      taskId,
    ) as any;
    return {
      task_id: taskId,
      verdict_id: v?.id ?? null,
      session: v ? (JSON.parse(v.meta ?? "{}").session ?? null) : null,
    };
  }

  /** Stamp the provenance index (BR#3287 chain) from a train:merged event —
   *  board-side storage of record; the lookup endpoint serves it with zero
   *  hub GitHub calls. */
  private trainStampProvenance(rec: { repo: string; pr: number; merge_sha: string; head_sha: string | null; task_id: string | null; verdict_id: string | null; session: string | null; signer: string; merged_at: number }) {
    this.state.storage.sql.exec(
      `INSERT INTO provenance (repo, pr, merge_sha, head_sha, task_id, verdict_id, session, signer, merged_at, stamped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo, pr) DO UPDATE SET merge_sha = excluded.merge_sha, head_sha = excluded.head_sha,
         task_id = excluded.task_id, verdict_id = excluded.verdict_id, session = excluded.session,
         signer = excluded.signer, merged_at = excluded.merged_at, stamped_at = excluded.stamped_at`,
      rec.repo, rec.pr, rec.merge_sha, rec.head_sha ?? "", rec.task_id, rec.verdict_id, rec.session, rec.signer, rec.merged_at, Date.now(),
    );
  }

  private async ensureRootFixCard(a: {
    repo: string;
    base: string;
    sha: string;
    failing: { name: string; conclusion?: string | null; url?: string | null }[];
    why: string;
    actor: string;
    now: number;
    laneId: string;
    culpritId: string | null;
    pr: number | null;
  }): Promise<string | null> {
    const bind = (m: any) => {
      m.root_fix = {
        repo: a.repo,
        head_sha: a.sha,
        base: a.base,
        why: a.why,
        failing: a.failing.map((f) => f.name),
        bound_at: a.now,
        lane: laneKey(a.repo, a.base),
        ...(a.pr ? { pr: a.pr } : {}),
      };
      return m;
    };
    // (1) culprit-qualified-in-place
    if (a.culpritId) {
      const c = this.one(`SELECT id, status, meta, tags FROM artefacts WHERE id = ?`, a.culpritId) as any;
      if (c && c.status !== "done" && c.status !== "superseded") {
        const cm = JSON.parse(c.meta ?? "{}");
        if (isRootFixCard({ tags: parseTags(c.tags), meta: cm })) {
          this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(bind(cm)), c.id);
          this.version(c.id, a.actor, "update", `root-fix binding refreshed to the live failing run ${a.sha.slice(0, 9)} — this card IS the line fix (BR#5190)`, {});
          return c.id;
        }
      }
    }
    // (2) re-bind an open root-fix card for this repo
    const open = this.state.storage.sql.exec(
      `SELECT id, meta, tags FROM artefacts
       WHERE type = 'task' AND status NOT IN ('done', 'superseded')
       AND json_extract(meta, '$.root_fix.repo') = ?
       ORDER BY created_ts DESC LIMIT 1`,
      a.repo,
    ).toArray() as any[];
    if (open.length) {
      const o = open[0];
      const om = JSON.parse(o.meta ?? "{}");
      if (isRootFixCard({ tags: parseTags(o.tags), meta: om })) {
        this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(bind(om)), o.id);
        this.version(o.id, a.actor, "update", `root-fix card rebound to the live failing run ${a.sha.slice(0, 9)} (stop-the-line, BR#5190)`, {});
        return o.id;
      }
    }
    // (3) spawn fresh — absolute p0
    const created = await this.create(
      {
        type: "task",
        title: rootFixCardTitle(a.repo, a.sha, a.failing.map((f) => f.name)),
        body_md: rootFixCardBody(a.repo, a.sha, a.failing),
        tags: [ROOT_FIX_TAG, MAIN_RED_TAG, "p0"],
        roles: ["impl"],
        session: "", // machine spawn: a FRESH session must own the fix (separation of duties)
        meta: bind({ child_of_lane: a.laneId }),
      },
      a.actor,
    );
    this.state.storage.sql.exec(
      `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
      created.id, a.laneId, a.now,
    );
    this.audit(a.actor, "root_fix_spawned", created.id, { lane: laneKey(a.repo, a.base), sha: a.sha.slice(0, 9), failing: a.failing.map((f) => f.name), culprit: a.culpritId, pr: a.pr });
    this.version(created.id, a.actor, "create", `root-fix card auto-spawned at absolute p0 — main is red, the train parks every other head until this merges (BR#5190)`, {});
    return created.id;
  }

  /** train.event — kind merged | bounced | stopped | landed. The acting
   *  gateway (actor) must hold the lease; every event is audited with the
   *  gateway for attribution and written to the train_events ledger. */
  private async trainEvent(body: any, actor: string): Promise<any> {
    const repo = String(body.repo ?? "").trim();
    const base = String(body.base ?? "main").trim();
    const kind = String(body.kind ?? "").trim();
    if (!["merged", "bounced", "stopped", "landed"].includes(kind)) throw new Error("kind must be merged | bounced | stopped | landed");
    const lane = await this.laneEnsure(repo, base, actor);
    const meta = JSON.parse(lane.meta ?? "{}");
    const now = Date.now();
    const lease: TrainLease | null = meta.lease ?? null;
    if (!lease || lease.holder !== actor) throw new Error(`train events require the lane lease — held by ${lease?.holder ?? "nobody"}, you are ${actor}`);
    const pr = Number(body.pr ?? 0) || null;
    const headSha = body.head_sha ? String(body.head_sha) : null;
    const mergeSha = body.merge_sha ? String(body.merge_sha) : null;
    const row = (id: string) => this.one(`SELECT id, status, meta, body_md FROM artefacts WHERE id = ?`, id);
    const ev = (detail: Record<string, unknown>, taskId: string | null) => {
      this.state.storage.sql.exec(
        `INSERT INTO train_events (ts, kind, repo, base, gateway, pr, task_id, merge_sha, head_sha, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        now, kind, repo, base, actor, pr, taskId, mergeSha, headSha, JSON.stringify(detail),
      );
      this.audit(actor, `train:${kind}`, lane.id, { lane: laneKey(repo, base), pr, task: taskId, sha: mergeSha ?? headSha, ...detail });
    };

    if (kind === "merged") {
      if (!mergeSha) throw new Error("train:merged needs merge_sha");
      if (!pr) throw new Error("train:merged needs pr");
      // the executor may report its own merge wall-clock (BR#4804 settle
      // clock): clamp to now — a future stamp would fake a settled lane
      const mergedAt = Math.min(Number(body.merged_at) || now, now);
      // BR#4934 burst payload: the drain pass rides the merged event —
      // burst_merged (merges in this pass, including this one), burst_cap,
      // burst_settling (true = the pass's FINAL merge; the lane settles on
      // it now). No payload → legacy single-merge cadence, byte-identical.
      const burstMerged = body.burst_merged != null ? Math.max(0, Math.floor(Number(body.burst_merged) || 0)) : null;
      const burstCap = body.burst_cap != null ? Math.max(0, Math.floor(Number(body.burst_cap) || 0)) : null;
      const burstSettling = body.burst_settling === true;
      const chain = this.trainChain(String(body.task_id ?? "") || null);
      this.trainStampProvenance({ repo, pr, merge_sha: mergeSha, head_sha: headSha, ...chain, signer: String(body.signer ?? "worker-executor"), merged_at: mergedAt });
      // carry-record: a clean machine update moved the verified head X→Y and
      // the verdict CARRIES (BR#3516 §5) — appended on the impl card. ONE
      // meta write: carry + awaiting-ci stamp + provenance + (blocked)
      // reason, so no leg clobbers another.
      if (chain.task_id) {
        const card = row(chain.task_id);
        if (card) {
          const cm = JSON.parse(card.meta ?? "{}");
          // THIS leg's stamp (multi-PR cards ride meta.prs; single-PR cards
          // fall back to the legacy meta.pr stamp — same leg, two shapes)
          const leg = trainLegs(cm).find((l) => l.number === Number(pr));
          const stamped = String(leg?.head_sha_at_acceptance ?? cm.pr?.head_sha_at_acceptance ?? "");
          let next = cm;
          if (stamped && headSha && stamped.toLowerCase() !== headSha.toLowerCase()) {
            next = carryAppendLeg(cm, Number(pr), { from_head: stamped, to_head: headSha, prior_verdict_id: chain.verdict_id, carried_ts: now, via: "update-branch" as const });
            this.version(chain.task_id, actor, "train_carry", `verdict carried across clean update ${stamped.slice(0, 9)}→${headSha.slice(0, 9)} (prior verdict ${chain.verdict_id ?? "unrecorded"} cited)`, {});
          }
          // per-leg awaiting-ci stamp — a multi-PR card is mid-flight leg by
          // leg; the card-level state stays the LAST merged leg's (executor
          // + lane reads are card-level).
          next.merge_train = {
            ...(next.merge_train ?? {}),
            legs: { ...(next.merge_train?.legs ?? {}), [String(pr)]: { state: "awaiting-ci", merge_sha: mergeSha, merged_at: mergedAt } },
            state: "awaiting-ci",
            pr,
            merge_sha: mergeSha,
            merged_at: mergedAt,
          };
          next.provenance = { repo, pr, head_sha: headSha ?? "", merge_sha: mergeSha, task_id: chain.task_id, verdict_id: chain.verdict_id, session: chain.session, signer: String(body.signer ?? "worker-executor"), merged_at: mergedAt };
          // blocked stays blocked (lifecycle forbids blocked→blocked) — the
          // state rides meta.merge_train; the reason says awaiting-CI.
          if (card.status === "blocked") {
            next.blocked = { ...(next.blocked ?? {}), reason: `merge-train: awaiting-ci — PR #${pr} merged as ${mergeSha.slice(0, 9)}, main settling (build/deploy)` };
            this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(next), now, chain.task_id);
          } else {
            this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(next), chain.task_id);
          }
        }
      }
      const burstFields = burstMerged != null ? { burst_merged: burstMerged, burst_cap: burstCap } : {};
      meta.currently = {
        pr,
        merge_sha: mergeSha,
        head_sha: headSha,
        merged_at: mergedAt,
        // BR#4934: a non-settling burst merge keeps the lane in the
        // "bursting" drain phase (no settle wait between merges); the final
        // merge — or any legacy merge — enters the awaiting-ci settle.
        phase: burstMerged != null && !burstSettling ? "bursting" : "awaiting-ci",
        task_id: chain.task_id,
        ...burstFields,
      };
      // BR#4981: a landing clears the lane's bypass-wait for that PR — the
      // typed self-clear, covering the human/admin bypass merge too (the
      // executor's walk stamps the merged event from live state when it next
      // sees the PR MERGED, train.rs:848).
      if (meta.bypass_wait && Number(meta.bypass_wait.pr) === pr) delete meta.bypass_wait;
      const reason = this.laneSyncReason(lane.id, meta, now);
      ev({ task: chain.task_id, verdict: chain.verdict_id, session: chain.session, carry: !!(headSha && String(body.carry_from ?? "")), ...(burstFields), burst_settling: burstSettling || undefined }, chain.task_id);
      const laneNote = burstMerged == null
        ? `PR #${pr} merged as ${mergeSha.slice(0, 9)} — awaiting main CI`
        : burstSettling
          ? `PR #${pr} merged as ${mergeSha.slice(0, 9)} — burst pass settled (${burstMerged} merged), awaiting main CI on the final merge`
          : `PR #${pr} merged as ${mergeSha.slice(0, 9)} — merging burst (${burstMerged} merged, cap ${burstCap === 0 ? "unlimited" : burstCap}), no settle between merges`;
      this.version(lane.id, actor, `train:${kind}`, laneNote, { currently: meta.currently, reason });
      return { ok: true, kind, lane: laneKey(repo, base), pr, merge_sha: mergeSha, task: chain.task_id, reason };
    }

    if (kind === "bounced") {
      if (!pr) throw new Error("train:bounced needs pr");
      const taskId = String(body.task_id ?? "") || (meta.currently?.task_id ?? null);
      const conflictFiles: string[] = Array.isArray(body.conflict_files) ? body.conflict_files.map(String).filter(Boolean) : [];
      const bounceKindRaw = body.bounce_kind != null ? String(body.bounce_kind).trim().toLowerCase() : "";
      if (bounceKindRaw && !["coverage", "conflict", "gate"].includes(bounceKindRaw))
        throw new Error(`train:bounced bounce_kind must be coverage | conflict | gate (got "${bounceKindRaw}")`);
      const defect = body.reason != null ? String(body.reason) : null;
      const mergeStateStatus = body.merge_state_status != null ? String(body.merge_state_status) : null;
      const bounceKind = resolveTrainBounceKind({ bounceKind: bounceKindRaw || null, conflictFiles, defect });
      // FAIL LOUD (BR#4066): a conflict bounce without the enumerated file
      // list is the "(no file list supplied)" dead-end — refuse to render it.
      if (bounceKind === "conflict" && !conflictFiles.length)
        throw new Error("train:bounced (conflict) without conflict_files — the executor must enumerate the trial-merge conflicts; refusing to render a file-less conflict brief (BR#4066)");
      const card = taskId ? row(taskId) : null;
      if (!card) throw new Error(`train:bounced could not resolve the impl card (task_id ${taskId ?? "none"})`);
      const cm = JSON.parse(card.meta ?? "{}");
      // BR#4962 (per accepted BR#4960): a COVERAGE bounce is a lapsed
      // verdict, not a defect — the card parks `blocked` under a typed
      // Awaiting reason and the human force-reviews it from the backlog.
      // ZERO asks: the BR#4068 standing review ask and the BR#4633 L4.2 TTL
      // re-file retire here — ask-as-visibility is retired, the parked card
      // IS the visibility. The park refreshes IN PLACE (blocked→blocked is
      // an illegal edge) and PRESERVES the typed pr_merged await_event leg,
      // so the proxy still owns a legal exit if the PR merges while parked.
      if (bounceKind === "coverage") {
        const verdictId = this.trainChain(taskId).verdict_id;
        const awaitingReason = trainAwaitingReason(verdictId, headSha);
        // BR#4068 starvation law still stamps the boost: a coverage-bounced
        // card is one HUMAN leg from landed — the backlog's Awaiting filter
        // orders it hot within the class. Decay stays the accept hook's job.
        const nextMeta = {
          ...cm,
          boosted: now,
          merge_train: {
            ...(cm.merge_train ?? {}),
            state: "awaiting",
            bounce_kind: "coverage",
            defect: (defect ?? "").slice(0, 300) || undefined,
            awaiting: { at: now, ...(headSha ? { head_sha: headSha } : {}), ...(verdictId ? { verdict_id: verdictId } : {}) },
            pr,
            repo,
          },
          blocked: { ...(cm.blocked ?? {}), reason: awaitingReason },
        };
        this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(nextMeta), now, taskId);
        this.audit(actor, "train:bounce_awaiting_park", taskId, { lane: laneKey(repo, base), pr, ...(headSha ? { head_sha: headSha } : {}), ...(verdictId ? { verdict: verdictId } : {}) });
        this.audit(actor, "boost", taskId, { root: taskId, via: "train:bounce", pr, awaiting: true });
        this.version(taskId, actor, "update", `parked Awaiting review — coverage bounce (head moved past the accepted verdict${headSha ? ` ${String(headSha).slice(0, 9)}` : ""}); no ask filed (BR#4960): force-review from the backlog — approve re-anchors the verdict at the parked head, changes-requested bounces impl`, {});
        // BR#4934: the lane forgets the in-flight merge ONLY when the bounced
        // card IS that merge's card — a bounce of a QUEUED candidate (a
        // mid-drain gate bounce or a settle-window rebase conflict) must not
        // destroy the burst pass / settle record it parked behind.
        const inFlightBounced = !!meta.currently && String(meta.currently.task_id ?? "") === String(taskId);
        meta.currently = inFlightBounced ? null : meta.currently;
        const reason = this.laneSyncReason(lane.id, meta, now);
        ev({ task: taskId, bounce_kind: "coverage", merge_state_status: mergeStateStatus, reason: defect, awaiting_park: true }, taskId);
        this.version(lane.id, actor, `train:${kind}`, `PR #${pr} bounced (coverage) — the card parks Awaiting review (zero asks, BR#4960); force-review from the backlog re-queues or bounces it`, { reason });
        return { ok: true, kind, lane: laneKey(repo, base), pr, task: taskId, bounce_kind: "coverage", awaiting_park: true, reason };
      }
      // gate | conflict — the impl bounce (BR#3516 §5): blocked → in_progress
      // with the fix-up brief; resolution invalidates the verdict — the card
      // re-enters the queue only after a fresh verify. NO ask legs here
      // either (BR#4960): the repair leg re-enters review through the normal
      // in_review handoff, which auto-spawns the fresh verify duty.
      const brief = trainBounceBrief({ prNumber: pr, repo, headSha, conflictFiles, verdictId: this.trainChain(taskId).verdict_id, bounceKind, mergeStateStatus, defect });
      const bounceNote =
        bounceKind === "gate"
          ? `merge-train bounce (gate) — PR #${pr}: ${(defect ?? "named gate defect").slice(0, 160)}`
          : `merge-train bounce (conflict) — PR #${pr} conflicts with base (${conflictFiles.length} file(s))`;
      // BR#4981 state 7: a gate bounce whose mergeStateStatus is `blocked` is
      // branch protection the machine cannot satisfy (review/required checks
      // on the PR head) — surface it as the honest bypass-wait state instead
      // of bare `ready`. Any other bounce for that PR, or its landing (typed
      // self-clear in the merged flow), clears it.
      if (bounceKind === "gate" && mergeStateStatus === "blocked") meta.bypass_wait = { pr, task_id: taskId, at: now };
      else if (meta.bypass_wait?.pr === pr) delete meta.bypass_wait;
      // Stamp the bounce FACTS on meta (kind, defect, files) + BOOST (BR#4068:
      // a bounced merge-ready card is the board's highest-value work — one
      // mechanical/human leg from landing — and must not re-enter at default
      // priority and starve). One meta write, before the transition.
      const now2 = Date.now();
      const nextMeta = {
        ...cm,
        boosted: now2,
        merge_train: {
          ...(cm.merge_train ?? {}),
          state: "bounced",
          bounce_kind: bounceKind,
          defect: (defect ?? "").slice(0, 300) || undefined,
          conflict_files: conflictFiles,
          bounced_at: now2,
          pr,
          repo,
        },
      };
      this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(nextMeta), now2, taskId);
      // blocked→in_progress with the fix-up brief; resolution invalidates the
      // verdict — the card re-enters the queue only after a fresh verify.
      await this.transition(
        {
          id: taskId,
          to: "in_progress",
          // anonymous: the hub acts as the machine, never as the last session
          // on the token — a session-less card must not inherit the closer's
          // session as its implementer (misattribution + a spurious
          // review-separation refusal on a same-session re-verify)
          session: "",
          note: bounceNote,
          body_md: `${String(card.body_md ?? "").replace(/\n\n---\n\nMerge-train bounce[\s\S]*$/, "")}\n\n---\n\n${brief}`,
        },
        actor,
      );
      cm.merge_train = nextMeta.merge_train;
      // BR#4068 starvation law (leg 1): a bounced card is the most valuable
      // work on the board — verified once, one mechanical leg from landed.
      // Stamp the SAME boost the human boost writes; the rank seams already
      // read it (claim ranking do.ts rank(), train rank core.ts, Backlog ▲).
      // Decay is the accept hook's job: re-queue deletes it — never
      // auto-expire mid-repair.
      cm.boosted = now;
      this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(cm), taskId);
      this.audit(actor, "boost", taskId, { root: taskId, via: "train:bounce", pr });
      this.version(taskId, actor, "update", `boosted (priority 0 — train bounce: one mechanical leg from landed; starvation law BR#4068)`, {});
      // BR#4934: the lane forgets the in-flight merge ONLY when the bounced
      // card IS that merge's card — a bounce of a QUEUED candidate (a
      // mid-drain gate bounce or a settle-window rebase conflict) must not
      // destroy the burst pass / settle record it parked behind.
      const inFlightBounced = !!meta.currently && String(meta.currently.task_id ?? "") === String(taskId);
      meta.currently = inFlightBounced ? null : meta.currently;
      const reason = this.laneSyncReason(lane.id, meta, now);
      ev({ task: taskId, conflict_files: conflictFiles, bounce_kind: bounceKind, merge_state_status: mergeStateStatus, reason: defect }, taskId);
      const laneNote =
        bounceKind === "gate"
          ? `PR #${pr} bounced (gate) — named defect; impl fixes it, then re-verify and re-queue at the back`
          : `PR #${pr} bounced (conflict) — ${conflictFiles.length} conflicting file(s); the impl repair leg resolves, then re-verify and re-queue at the back`;
      this.version(lane.id, actor, `train:${kind}`, laneNote, { reason });
      return { ok: true, kind, lane: laneKey(repo, base), pr, task: taskId, bounce_kind: bounceKind, conflict_files: conflictFiles, reason };
    }

    if (kind === "stopped") {
      if (!mergeSha && !headSha) throw new Error("train:stopped needs sha (merge_sha or head_sha)");
      const sha = mergeSha ?? headSha!;
      const failing: { name: string; conclusion?: string | null; url?: string | null }[] = Array.isArray(body.failing) ? body.failing : [];
      const culprit = String(body.culprit_task ?? "") || (meta.currently?.task_id ?? null) || null;
      const why = String(body.reason ?? (failing.length ? `required workflows RED: ${failing.map((f) => f.name).join(", ")}` : "stop-the-line"));
      // BR#5061 storm dedupe: the SAME stop re-reported by an executor tick
      // loop (the stop arm clears on green main, the awaiting-ci arm re-fires
      // it — observed as ~2 stopped events/min for hours on bridge@main)
      // must be ONE episode in the ledger, not one row per tick. Same sha +
      // same reason = same episode: no ledger row, no version, no ask, no
      // culprit re-bounce — the idempotent no-op.
      if (meta.stop && String(meta.stop.sha) === String(sha) && String(meta.stop.reason ?? "") === why) {
        this.audit(actor, "train:stopped_deduped", lane.id, { lane: laneKey(repo, base), sha: sha.slice(0, 9), reason: why.slice(0, 140) });
        return { ok: true, kind: "stopped", lane: laneKey(repo, base), sha, stop: meta.stop, deduped: true, reason: this.laneSyncReason(lane.id, meta, now) };
      }
      // BR#4981 state 6: the stop names the culprit card so the panel reads
      // "STOP THE LINE — base red, fix card BR#X" without a ledger dig.
      // BR#4934: a stop under a burst pass pre-stamps the bisect record —
      // the bisect walk's state lives HERE (hub-side, crash-safe): the
      // pass's merge count + per-sha step verdicts + the named culprit.
      // Legacy stops keep the exact legacy shape (no bisect key beyond the
      // culprit_task the BR#4981 vocabulary names).
      const burstStop = meta.currently?.burst_merged != null ? { merged: Number(meta.currently.burst_merged), cap: meta.currently.burst_cap ?? null } : null;
      meta.stop = { sha, reason: why, at: now, pr, failing, ...(culprit ? { culprit_task: culprit } : {}), ...(burstStop ? { bisect: { pass: burstStop, steps: {}, culprit_task: null as string | null, culprit_sha: null as string | null, inconclusive: false } } : {}) };
      // red AFTER merge ⇒ the culprit (just-merged) card bounces with the
      // failing runs; red at admission ⇒ no merge happened, nothing bounces.
      if (culprit && meta.currently) {
        const card = row(culprit);
        if (card && card.status === "blocked") {
          const lines = [
            `Merge-train STOP THE LINE: your PR #${pr} landed as ${sha.slice(0, 9)} and broke main — required workflows RED.`,
            ...failing.map((f) => `- ${f.name}: ${f.conclusion ?? "failed"}${f.url ? ` (${f.url})` : ""}`),
            ``,
            `Fix forward or revert, then re-enter review. The lane is stopped until main is green again (BR#3516 §6 — v1 stops the line; no auto-revert).`,
          ];
          await this.transition(
            {
              id: culprit,
              to: "in_progress",
              session: "", // anonymous — hub-side machine action (see bounce)
              note: `merge-train stop-the-line — main RED at ${sha.slice(0, 9)}: ${failing.map((f) => f.name).join(", ") || why}`,
              body_md: `${String(card.body_md ?? "")}\n\n---\n\n${lines.join("\n")}`,
            },
            actor,
          );
          const cm2 = JSON.parse(card.meta ?? "{}");
          cm2.merge_train = { ...(cm2.merge_train ?? {}), state: "stopped", pr, sha, at: now };
          this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(cm2), culprit);
        }
      }
      meta.currently = meta.currently ? { ...meta.currently, phase: "stopped" } : null;
      const reason = this.laneSyncReason(lane.id, meta, now);
      // ONE ask per class: the sha+workflows make the title unique per red
      // episode; askCreate's identical-open-ask guard dedupes the rest.
      const askTitle = trainStopAskTitle({ repo, base }, sha, failing.map((f) => f.name).length ? failing.map((f) => f.name) : [why]);
      try {
        await this.askCreate(
          {
            to: "human",
            question: askTitle,
            reason: `the merge train stopped the ${repo}@${base} line — merges halt until green (BR#3516 §6)`,
            details: [
              `Lane ${laneKey(repo, base)} stopped by gateway ${actor} at ${new Date(now).toISOString()}.`,
              `Commit: ${sha}`,
              failing.length ? `Failing required workflows:\n${failing.map((f) => `- ${f.name}${f.url ? ` — ${f.url}` : ""}`).join("\n")}` : `Reason: ${why}`,
              culprit ? `Culprit card: ${culprit} (bounced with the failing runs).` : "No merge had landed — stopped at admission.",
              `Resume: main green again (the executor auto-resumes next tick) or a recorded authority decision.`,
            ].join("\n\n"),
            options: ["Ack — on it", "Revert the culprit", "Waive — resume the lane"],
            artefact_id: this.settingValue("train_alarm_sink_id", TRAIN_ALARM_SINK_ID),
            urgency: "time-sensitive",
          },
          actor,
        );
      } catch (e) {
        // an identical ask is already open for this episode — that IS one per class
        this.audit(actor, "train:stopped", lane.id, { ask_deduped: String((e as Error).message ?? e).slice(0, 160) });
      }
      // BR#5190: auto-spawn (or re-bind) THE root-fix card at absolute p0 —
      // it jumps every queue tier, and the stopped executor's walk fast-tracks
      // its PR (or opens the human fast-lane ask for the circular
      // deploy-health class). Best-effort: a spawn failure must never eat the
      // stop event itself — the ledger entry below still fires.
      try {
        await this.ensureRootFixCard({
          repo,
          base,
          sha,
          failing,
          why,
          actor,
          now,
          laneId: lane.id,
          culpritId: culprit,
          pr,
        });
      } catch (e) {
        this.audit(actor, "root_fix_spawn_error", lane.id, { error: String((e as Error)?.message ?? e).slice(0, 200) });
      }
      ev({ reason: why, failing, culprit }, culprit);
      this.version(lane.id, actor, `train:${kind}`, `line stopped — ${why}`, { stop: meta.stop, reason });
      return { ok: true, kind, lane: laneKey(repo, base), sha, stop: meta.stop, reason };
    }

    // kind === "landed": the hub decides from facts — checks ride the event
    // and MUST classify green (the executor never self-certifies; a stale or
    // lying landed is rejected, not applied).
    if (!meta.currently || meta.currently.phase === "stopped") throw new Error("train:landed with no awaiting-CI merge on the lane");
    if (!mergeSha || Number(meta.currently.pr) !== Number(pr)) throw new Error(`train:landed must cite the lane's in-flight merge (PR #${meta.currently.pr}, ${String(meta.currently.merge_sha).slice(0, 9)})`);
    const checks: MainCheckRun[] = Array.isArray(body.checks) ? body.checks : [];
    const laneSpec = laneOfMeta(meta)!;
    const classified = classifyRequiredRuns(checks, laneSpec.required_workflows, { merged_at: Number(meta.currently.merged_at ?? now), now, typical_ms: (laneSpec.ci_typical_minutes ?? TRAIN_CI_TYPICAL_MINUTES) * 60_000 });
    if (classified.verdict !== "green") throw new Error(`train:landed rejected — required runs classify ${classified.verdict} (failing: ${classified.failing.map((f) => f.name).join(", ") || "none"}; pending: ${classified.pending.join(", ") || "none"}); post train.ci instead and let the hub decide`);
    return this.landedFlowGuarded(lane, meta, actor, { pr: Number(pr), mergeSha: mergeSha!, greenRunUrl: classified.failing.length ? null : (checks.find((c) => laneSpec.required_workflows.includes(c.name ?? ""))?.html_url ?? body.run_url ?? null) });
  }

  /** BR#4934 burst parks: on a GREEN settle of a burst pass, every parked
   *  card whose awaiting-ci leg merge sha is an ANCESTOR of the settled head
   *  closes — its runs were cancelled-by-next-push (GH#2261 law: cancelled
   *  says nothing), the settled green pass is the evidence, and the ancestry
   *  is EXECUTOR-FED (burst_ancestors via train.ci) because the hub holds no
   *  VCS credentials (BR#3516). Stamps the leg landed citing the evidence
   *  sha, then closes cards with no remaining legs via the lifecycle-legal
   *  blocked→in_progress→done. Never throws: an intermediate-close failure
   *  is audited and skipped — it must never bounce the pass's final card
   *  (landedFlow's close-bounce ladder owns that card). */
  private async closeBurstParks(lane: any, meta: any, actor: string, settledSha: string, now: number): Promise<number> {
    const laneSpec = laneOfMeta(meta);
    const cur: any = meta.currently ?? {};
    const ancestors: string[] = Array.isArray(cur.burst_ancestors) ? cur.burst_ancestors.map(String) : [];
    if (!laneSpec || !ancestors.length || cur.burst_merged == null) return 0;
    const settled = settledSha.toLowerCase();
    const evidence = new Set(ancestors.map((s) => s.toLowerCase()));
    const parked = this.state.storage.sql.exec(
      `SELECT id, status, meta FROM artefacts WHERE type = 'task' AND status = 'blocked'
       AND CAST(json_extract(meta, '$.merge_train.pr') AS INTEGER) > 0`,
    ).toArray() as any[];
    let closed = 0;
    for (const row of parked) {
      if (row.id === cur.task_id) continue; // the final card — landedFlow owns it
      try {
        const cm = JSON.parse(row.meta ?? "{}");
        const legs = trainLegs(cm);
        const leg = legs.find((l) => (l.repo === laneSpec.repo || !l.repo) && String(cm.merge_train?.legs?.[String(l.number)]?.state ?? "") === "awaiting-ci");
        if (!leg) continue;
        const legRec = cm.merge_train?.legs?.[String(leg.number)] ?? {};
        const legSha = String(legRec.merge_sha ?? "").toLowerCase();
        if (!legSha || legSha === settled || !evidence.has(legSha)) continue;
        const legsMap = { ...(cm.merge_train?.legs ?? {}), [String(leg.number)]: { ...legRec, state: "landed", landed_at: now, via: "burst-settle", evidence_sha: settledSha } };
        cm.merge_train = { ...(cm.merge_train ?? {}), legs: legsMap };
        const remaining = trainLegsRemaining(cm);
        this.state.storage.sql.exec(
          `INSERT INTO train_events (ts, kind, repo, base, gateway, pr, task_id, merge_sha, head_sha, detail) VALUES (?, 'landed', ?, ?, ?, ?, ?, ?, NULL, ?)`,
          now, laneSpec.repo, laneSpec.base, actor, leg.number, row.id, String(legRec.merge_sha), JSON.stringify({ burst: true, evidence_sha: settledSha, pass_merged: Number(cur.burst_merged) }),
        );
        if (remaining.length) {
          // legs remain on other lanes/repos — stay queued, honestly named
          const next = remaining[0];
          cm.merge_train = { ...cm.merge_train, state: "queued", pr: next.number, repo: next.repo, remaining: remaining.length };
          cm.blocked = { ...(cm.blocked ?? {}), reason: trainQueueRemainingReason(cm) };
          this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(cm), now, row.id);
          this.audit(actor, "train:burst_leg_landed", lane.id, { lane: laneKey(laneSpec.repo, laneSpec.base), pr: leg.number, task: row.id, evidence_sha: settledSha, remaining: remaining.map((l) => l.number) });
          this.version(row.id, actor, "train:landed", `burst-settle: PR #${leg.number} leg stamped landed — its pass settled green at ${settledSha.slice(0, 9)} (ancestor evidence, runs cancelled-by-next-push); ${remaining.length} leg(s) remain`, {});
          continue;
        }
        const note = `Burst-settle close (BR#4934): PR #${leg.number} merged as ${String(legRec.merge_sha).slice(0, 9)} — its runs were cancelled-by-next-push (GH#2261: cancelled says nothing); the pass settled GREEN at ${settledSha.slice(0, 9)} and this sha is a fed git ancestor of it. Closed by the merge train's burst-drain settle, zero hub GitHub calls.`;
        if (row.status === "blocked") await this.transition({ id: row.id, to: "in_progress", session: "", note: `merge-train: landed — closing on the burst pass's green settle (evidence ${settledSha.slice(0, 9)})`, merge_train: true }, actor);
        await this.transition({ id: row.id, to: "done", session: "", note }, actor);
        cm.merge_train = { ...cm.merge_train, state: "landed", pr: leg.number, merge_sha: legRec.merge_sha, landed_at: now, burst_evidence: settledSha };
        this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(cm), now, row.id);
        this.audit(actor, "train:burst_park_closed", lane.id, { lane: laneKey(laneSpec.repo, laneSpec.base), pr: leg.number, task: row.id, merge_sha: legRec.merge_sha, evidence_sha: settledSha });
        this.version(row.id, actor, "train:landed", `burst-settle: card closed — merge sha ${String(legRec.merge_sha).slice(0, 9)} is an ancestor of the green-settled pass head ${settledSha.slice(0, 9)}`, {});
        closed += 1;
      } catch (e) {
        this.audit(actor, "train:burst_park_error", lane.id, { task: row.id, error: String((e as Error)?.message ?? e).slice(0, 200) });
      }
    }
    if (closed) this.version(lane.id, actor, "train:landed", `burst-settle: ${closed} parked card(s) closed on the pass's green settle (ancestor evidence, BR#4934)`, {});
    return closed;
  }

  /** The landed close: impl card blocked→in_progress→done (lifecycle law:
   *  blocked→done is illegal) citing mergeCommit + main green — the machine
   *  proxy — then the lane idles and the derived queue advances. */
  /** The landed close: impl card blocked→in_progress→done (lifecycle law:
   *  blocked→done is illegal) citing mergeCommit + main green — the machine
   *  proxy — then the lane idles and the derived queue advances.
   *  BR#3659 defect 1: a card queued with MULTIPLE PRs (legs) closes only
   *  when its LAST leg lands — after a partial landing it stays queued with
   *  an honest reason naming the legs still out, and the train picks the
   *  next leg on a later tick. */
  private async landedFlow(lane: any, meta: any, actor: string, p: { pr: number; mergeSha: string; greenRunUrl?: string | null }): Promise<any> {
    const now = Date.now();
    const laneSpec = laneOfMeta(meta)!;
    const taskId: string | null = meta.currently?.task_id ?? null;
    if (taskId) {
      const card = this.one(`SELECT id, status, meta FROM artefacts WHERE id = ?`, taskId);
      if (card && card.status !== "done" && card.status !== "superseded") {
        const cm = JSON.parse(card.meta ?? "{}");
        // stamp THIS leg landed — multi-PR map; single-PR cards ride the same
        // shape (the legacy card-level landed state is only set on final close)
        const legsMap = { ...(cm.merge_train?.legs ?? {}), [String(p.pr)]: { state: "landed", merge_sha: p.mergeSha, landed_at: now } };
        cm.merge_train = { ...(cm.merge_train ?? {}), legs: legsMap };
        const remaining = trainLegsRemaining(cm);
        if (remaining.length) {
          // legs remain: NOT done — stay queued, honestly, and let the train
          // pick the next leg (this lane's or another repo's). The lane goes
          // IDLE now — `currently` points at a landed leg; leaving it set
          // would make every later tick re-poll that merge and never reach
          // the idle arm that drives the next leg.
          const next = remaining[0];
          cm.merge_train = { ...cm.merge_train, state: "queued", pr: next.number, repo: next.repo, remaining: remaining.length };
          cm.blocked = { ...(cm.blocked ?? {}), reason: trainQueueRemainingReason(cm) };
          this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(cm), now, taskId);
          await this.closeBurstParks(lane, meta, actor, p.mergeSha, now);
          meta.currently = null;
          const reason = this.laneSyncReason(lane.id, meta, now);
          this.state.storage.sql.exec(
            `INSERT INTO train_events (ts, kind, repo, base, gateway, pr, task_id, merge_sha, head_sha, detail) VALUES (?, 'landed', ?, ?, ?, ?, ?, ?, NULL, ?)`,
            now, laneSpec.repo, laneSpec.base, actor, p.pr, taskId, p.mergeSha, JSON.stringify({ leg: true, run: p.greenRunUrl ?? null, remaining: remaining.map((l) => l.number) }),
          );
          this.audit(actor, "train:leg_landed", lane.id, { lane: laneKey(laneSpec.repo, laneSpec.base), pr: p.pr, task: taskId, merge_sha: p.mergeSha, remaining: remaining.map((l) => l.number) });
          this.version(lane.id, actor, "train:landed", `PR #${p.pr} landed green — card ${taskId} stays queued (${remaining.length} leg(s) remain: ${remaining.map((l) => `${l.repo}#${l.number}`).join(", ")})`, { reason });
          return { ok: true, kind: "landed", pr: p.pr, merge_sha: p.mergeSha, task: taskId, remaining: remaining.map((l) => l.number), reason };
        }
        // final leg (or single-leg card): close on the machine proxy, citing
        // every leg's merge commit
        const allLegs = trainLegs(cm).map((l) => ({
          repo: l.repo || laneSpec.repo,
          number: l.number,
          mergeSha: String(legsMap[String(l.number)]?.merge_sha ?? p.mergeSha),
        }));
        const note = trainLandedCloseNote({ repo: laneSpec.repo, prNumber: p.pr, mergeSha: p.mergeSha, gateway: actor, greenRunUrl: p.greenRunUrl, legs: allLegs });
        if (card.status === "blocked")
          await this.transition({ id: taskId, to: "in_progress", session: "", note: `merge-train: landed — closing on the machine proxy (mergeCommit ${p.mergeSha.slice(0, 9)} non-null + main green)`, merge_train: true }, actor);
        await this.transition({ id: taskId, to: "done", session: "", note }, actor);
        cm.merge_train = { ...cm.merge_train, state: "landed", pr: p.pr, merge_sha: p.mergeSha, landed_at: now };
        this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(cm), taskId);
      }
    }
    // BR#4934: the pass settled green — parked intermediate cards whose fed
    // ancestry proves they ride this pass close here (before currently, and
    // the burst_ancestors it carries, is cleared).
    await this.closeBurstParks(lane, meta, actor, p.mergeSha, now);
    meta.currently = null;
    const reason = this.laneSyncReason(lane.id, meta, now);
    this.state.storage.sql.exec(
      `INSERT INTO train_events (ts, kind, repo, base, gateway, pr, task_id, merge_sha, head_sha, detail) VALUES (?, 'landed', ?, ?, ?, ?, ?, ?, NULL, ?)`,
      now, laneSpec.repo, laneSpec.base, actor, p.pr, taskId, p.mergeSha, JSON.stringify({ run: p.greenRunUrl ?? null }),
    );
    this.audit(actor, "train:landed", lane.id, { lane: laneKey(laneSpec.repo, laneSpec.base), pr: p.pr, task: taskId, merge_sha: p.mergeSha });
    this.version(lane.id, actor, "train:landed", `PR #${p.pr} landed — ${p.mergeSha.slice(0, 9)} green on main; card ${taskId ?? "n/a"} closed`, { reason });
    return { ok: true, kind: "landed", pr: p.pr, merge_sha: p.mergeSha, task: taskId, reason };
  }

  /** BR#4753: the landed close GUARDED. A green-verdict tick whose
   *  landedFlow throws (gate-rejected done, storage fault mid-close) used to
   *  fail raw — and silently, rejections aren't versioned — EVERY tick: the
   *  lane sat in awaiting-ci fail-open, the fail-closed bound was
   *  structurally unreachable (bound_exceeded is only consulted on the
   *  pending branch), and the queue starved (observed on the
   *  state-vector/bridge@main lane: 60+ min past bound, ~65 silent ticks —
   *  BR#4753). Every failure here is counted on the in-flight record,
   *  surfaced (audit + lane reason), and resolved by the pure ladder
   *  trainLandedCloseEdge: a SEMANTIC gate rejection (breachClass names a
   *  rule) bounces the culprit card immediately — the BR#3516 §6
   *  lifecycle-legal edge, citing the gate error; anything else retries ≤
   *  TRAIN_LANDED_CLOSE_MAX_RETRIES ticks, then — or past the fail-closed
   *  bound, whichever first — bounces fail-closed with ONE alarm-sink ask
   *  per episode. awaiting-ci always resolves to
   *  { landed, red-stop, bound-stop, bounce }; never a raw throw. */
  private async landedFlowGuarded(lane: any, meta: any, actor: string, p: { pr: number; mergeSha: string; greenRunUrl?: string | null }): Promise<any> {
    const laneSpec = laneOfMeta(meta)!;
    try {
      const out = await this.landedFlow(lane, meta, actor, p);
      return { ...out, decided: "landed" };
    } catch (e) {
      const error = String((e as Error)?.message ?? e);
      const klass = breachClass(error);
      const now = Date.now();
      const taskId: string | null = meta.currently?.task_id ?? null;
      // A fault AFTER the done transition landed (storage/audit/version) is a
      // COMPLETED close — retrying it succeeds by construction (landedFlow
      // skips a done card and idles the lane). Never bounce a landed card.
      if (taskId) {
        const card = this.one(`SELECT status FROM artefacts WHERE id = ?`, taskId);
        if (card && (card.status === "done" || card.status === "superseded")) {
          // BR#4934: a repaired close still owes the pass its burst parks —
          // the previous tick closed the final card then faulted.
          await this.closeBurstParks(lane, meta, actor, p.mergeSha, now);
          meta.currently = null;
          const reason = this.laneSyncReason(lane.id, meta, now);
          this.audit(actor, "train:landed_close_repaired", lane.id, { lane: laneKey(laneSpec.repo, laneSpec.base), pr: p.pr, task: taskId, error: error.slice(0, 160) });
          this.version(lane.id, actor, "train:landed", `PR #${p.pr} landed — card ${taskId} already closed (a post-close fault retried clean); lane idled`, { reason });
          return { ok: true, decided: "landed", pr: p.pr, merge_sha: p.mergeSha, task: taskId, repaired: true, reason };
        }
      }
      // count the failure on the in-flight record — explicit persist, the
      // failure must survive across ticks (laneSyncReason only writes on a
      // reason change, BR#4801) — then let the ladder decide.
      const prev = (meta.currently?.landed_close ?? {}) as any;
      const failures = Number(prev.failures ?? 0) + 1;
      const boundExceeded = now - Number(meta.currently?.merged_at ?? now) > TRAIN_CI_BOUND_MULTIPLIER * ((laneSpec.ci_typical_minutes ?? TRAIN_CI_TYPICAL_MINUTES) * 60_000);
      const edge = trainLandedCloseEdge({ breach_class: klass, failures, bound_exceeded: boundExceeded });
      meta.currently = { ...meta.currently, landed_close: { failures, breach_class: klass, last_error: error.slice(0, 300), first_failed_at: Number(prev.first_failed_at ?? now), last_failed_at: now } };
      this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), lane.id);
      const reason = this.laneSyncReason(lane.id, meta, now);
      if (edge.edge === "retry") {
        // loud per tick — the audit IS the log; the version fires once so
        // the episode is on the card's timeline without per-tick noise.
        this.audit(actor, "train:landed_close_error", lane.id, { lane: laneKey(laneSpec.repo, laneSpec.base), pr: p.pr, task: taskId, failures, class: klass, error: error.slice(0, 300) });
        if (failures === 1)
          this.version(lane.id, actor, "train:landed", `landed close failed (attempt 1) — ${klass}: ${error.slice(0, 120)}; retrying next tick (≤${TRAIN_LANDED_CLOSE_MAX_RETRIES}, then close-bounce — BR#4753)`, { reason });
        return { ok: true, decided: "landed_retry", pr: p.pr, merge_sha: p.mergeSha, task: taskId, failures, breach_class: klass, reason };
      }
      // The lifecycle-legal edge (BR#3516 §6): close-bounce the culprit card
      // CITING the gate error, idle the lane, ONE alarm ask per episode. The
      // merge itself is fine — the PR is landed and main green — so this is
      // NOT stop-the-line (meta.stop auto-clears on green main) and NOT a
      // re-verify bounce: the brief points impl at exactly the named
      // precondition.
      const boundFired = edge.bound_fired;
      const card = taskId ? this.one(`SELECT id, status, meta, body_md FROM artefacts WHERE id = ?`, taskId) : null;
      if (card) {
        const now2 = Date.now();
        const cm = JSON.parse(card.meta ?? "{}");
        const nextMeta = {
          ...cm,
          // starvation law shape (BR#4068): a merged-green card one gate
          // precondition away from done is the board's highest-value work
          boosted: now2,
          merge_train: {
            ...(cm.merge_train ?? {}),
            state: "bounced",
            bounce_kind: "gate",
            close_bounce: true,
            defect: error.slice(0, 300),
            breach_class: klass,
            landed_merge_sha: p.mergeSha,
            bounced_at: now2,
            pr: p.pr,
            repo: laneSpec.repo,
          },
        };
        const brief = trainCloseBounceBrief({ repo: laneSpec.repo, prNumber: p.pr, mergeSha: p.mergeSha, gateway: actor, error, breachClass: klass, boundFired, failures });
        const body = `${String(card.body_md ?? "").replace(/\n\n---\n\nMerge-train close bounce[\s\S]*$/, "")}\n\n---\n\n${brief}`;
        this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, body_md = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(nextMeta), body, now2, taskId);
        // blocked → in_progress with the brief; a HALF-CLOSED card (a prior
        // tick already cleared blocked→in_progress, then done was refused)
        // is already in impl's hands — the brief + boost stand, no illegal
        // in_progress→in_progress exists.
        if (card.status === "blocked") {
          try {
            await this.transition(
              {
                id: taskId!,
                to: "in_progress",
                // anonymous — the hub acts as the machine, never as the last
                // session on the token (same rule as the conflict bounce)
                session: "",
                note: `merge-train close bounce (BR#4753) — ${klass}: ${error.slice(0, 120)}`,
              },
              actor,
            );
          } catch (te) {
            // the bounce transition itself refused (a race) — the brief, the
            // bounce stamp and the boost already stand; never raw-throw from
            // the green branch (BR#4753)
            this.audit(actor, "train:close_bounce_refused", taskId!, { error: String((te as Error)?.message ?? te).slice(0, 200) });
          }
        }
        this.audit(actor, "boost", taskId!, { root: taskId!, via: "train:close_bounce", pr: p.pr });
        this.version(taskId!, actor, "update", `close-bounced (priority 0 — merged green, board close gate-rejected: ${klass}; repair leg = resolve the named precondition, close citing the merge commit — BR#4753)`, {});
      }
      meta.currently = null;
      const reason2 = this.laneSyncReason(lane.id, meta, Date.now());
      this.state.storage.sql.exec(
        `INSERT INTO train_events (ts, kind, repo, base, gateway, pr, task_id, merge_sha, head_sha, detail) VALUES (?, 'landed', ?, ?, ?, ?, ?, ?, NULL, ?)`,
        Date.now(), laneSpec.repo, laneSpec.base, actor, p.pr, taskId, p.mergeSha, JSON.stringify({ close_bounced: true, breach_class: klass, bound_fired: boundFired, failures, error: error.slice(0, 300) }),
      );
      this.audit(actor, "train:landed_close_bounced", lane.id, { lane: laneKey(laneSpec.repo, laneSpec.base), pr: p.pr, task: taskId, class: klass, bound_fired: boundFired, failures, error: error.slice(0, 300) });
      this.version(lane.id, actor, "train:landed", `PR #${p.pr} merged green but the card close failed ${failures}× (${klass}${boundFired ? ", bound fired" : ""}) — card close-bounced with the repair brief; lane idled, queue advances (BR#4753)`, { reason: reason2 });
      // ONE ask per episode to the alarm sink (BR#3124) — askCreate's
      // identical-open-ask guard dedupes the rest. NEVER artefact_id = the
      // culprit card: an open ask child would fence its next landed close —
      // the exact done-open-children class this fix exists for (BR#4068).
      const askTitle = trainCloseFailAskTitle({ repo: laneSpec.repo, base: laneSpec.base }, p.mergeSha, p.pr, klass, boundFired);
      try {
        await this.askCreate(
          {
            to: "human",
            question: askTitle,
            reason: "the merge train's landed close was gate-rejected repeatedly — previously SILENT per tick, it starved the whole lane past the fail-closed bound (BR#4753); the card is close-bounced, but a session should confirm the named precondition is agent-repairable",
            details: trainCloseFailAskDetails({ repo: laneSpec.repo, base: laneSpec.base, prNumber: p.pr, mergeSha: p.mergeSha, taskId, error, breachClass: klass, boundFired, failures, gateway: actor }),
            options: ["Ack — checking the card", "Fix the gate precondition", "Stop the line — human needed"],
            artefact_id: this.settingValue("train_alarm_sink_id", TRAIN_ALARM_SINK_ID),
            urgency: "time-sensitive",
          },
          actor,
        );
      } catch (ae) {
        const am = String((ae as Error)?.message ?? ae);
        // an identical ask is already open for this episode — that IS one
        // per episode. Any other failure (missing sink card) is loud in the
        // audit, never a raw throw (BR#4753: silence is the defect).
        this.audit(actor, am.startsWith("an identical ask is already open") ? "train:close_ask_deduped" : "train:close_ask_failed", lane.id, { reason: am.slice(0, 160) });
      }
      return { ok: true, decided: boundFired ? "bounce_bound" : "bounce_gate", pr: p.pr, merge_sha: p.mergeSha, task: taskId, breach_class: klass, bound_fired: boundFired, failures, reason: reason2 };
    }
  }

  /** train.ci — executor-fed CI facts on the lane's merge commit; the HUB
   *  decides (BR#3516: executor-fed facts, hub-decided). Green ⇒ landed;
   *  red ⇒ stop-the-line; pending past the bound ⇒ fail-closed stop.
   *  BR#4753: the green arm is GUARDED — a landed close that throws
   *  (gate-rejected done, storage fault) resolves via landedFlowGuarded to
   *  { landed, landed_retry, bounce_gate, bounce_bound }; it used to
   *  raw-throw every tick and wedge the lane fail-open past the bound. */
  private async trainCi(body: any, actor: string): Promise<any> {
    const repo = String(body.repo ?? "").trim();
    const base = String(body.base ?? "main").trim();
    const lane = await this.laneEnsure(repo, base, actor);
    const meta = JSON.parse(lane.meta ?? "{}");
    const now = Date.now();
    const lease: TrainLease | null = meta.lease ?? null;
    if (!lease || lease.holder !== actor) throw new Error(`train.ci requires the lane lease — held by ${lease?.holder ?? "nobody"}`);
    if (!meta.currently) {
      // nothing in flight — the executor is just heartbeating; facts noted.
      this.audit(actor, "train:ci_idle", lane.id, { lane: laneKey(repo, base), sha: String(body.sha ?? "").slice(0, 9) });
      return { ok: true, decided: "idle", lane: laneKey(repo, base) };
    }
    const sha = String(body.sha ?? "");
    if (sha && String(meta.currently.merge_sha).toLowerCase() !== sha.toLowerCase())
      throw new Error(`stale CI report — the lane's in-flight merge is ${String(meta.currently.merge_sha).slice(0, 9)}, not ${sha.slice(0, 9)}`);
    // BR#4934: the FIRST settle feed on a bursting lane flips phase →
    // awaiting-ci — the drain is over, the pass settles on the final merge.
    // Persisted immediately: every decision arm below (and the stopped flow
    // it may call) re-reads the lane.
    // ancestors_of_settled (BR#4934): executor-fed git ancestry — the pass's
    // intermediate merge shas that ARE ancestors of the settled head. The hub
    // holds no VCS creds (BR#3516); on a green verdict these close the pass's
    // parked cards (their runs were cancelled-by-next-push, GH#2261 law:
    // cancelled says nothing). Sha-shaped entries only — junk drops.
    let burstFlipped = false;
    if (meta.currently.phase === "bursting") {
      meta.currently = { ...meta.currently, phase: "awaiting-ci" };
      burstFlipped = true;
    }
    let ancestorsStamped = false;
    if (Array.isArray(body.ancestors_of_settled) && meta.currently.burst_merged != null) {
      const fed = (body.ancestors_of_settled as unknown[]).map((s) => String(s ?? "").toLowerCase()).filter((s) => /^[0-9a-f]{7,40}$/.test(s));
      meta.currently = { ...meta.currently, burst_ancestors: [...new Set(fed)] };
      ancestorsStamped = true;
    }
    if (burstFlipped || ancestorsStamped) {
      this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(meta), now, lane.id);
      this.audit(actor, burstFlipped ? "train:burst_settle_begin" : "train:burst_ancestors", lane.id, {
        lane: laneKey(repo, base),
        merged: Number(meta.currently.burst_merged ?? 0),
        ...(ancestorsStamped ? { ancestors: (meta.currently.burst_ancestors as string[]).length } : {}),
      });
    }
    const checks: MainCheckRun[] = Array.isArray(body.checks) ? body.checks : [];
    const laneSpec = laneOfMeta(meta)!;
    const v: RequiredRunsVerdict = classifyRequiredRuns(checks, laneSpec.required_workflows, { merged_at: Number(meta.currently.merged_at ?? now), now, typical_ms: (laneSpec.ci_typical_minutes ?? TRAIN_CI_TYPICAL_MINUTES) * 60_000 });
    const pr = Number(meta.currently.pr);
    const mergeSha = String(meta.currently.merge_sha);
    if (v.verdict === "green") {
      // BR#4753: never raw-throw from the green branch — the guard resolves
      // { landed, landed_retry, bounce_gate, bounce_bound } and the bound
      // fires here too after repeated close failures (it used to be
      // reachable only from the pending branch).
      return this.landedFlowGuarded(lane, meta, actor, { pr, mergeSha, greenRunUrl: checks.find((c) => laneSpec.required_workflows.includes(c.name ?? ""))?.html_url ?? body.run_url ?? null });
    }
    if (v.verdict === "red") {
      const out = await this.trainEvent({ repo, base, kind: "stopped", pr, merge_sha: mergeSha, failing: v.failing }, actor);
      return { ...out, decided: "stopped" };
    }
    // pending — the bound decides: unknown past ~3× typical ⇒ fail-closed
    // stop. BR#5061 (Ray 2026-10-30: "if it can't merge, bounce it and move
    // onto the next one — the train goes regardless"): when EVERY unsettled
    // required workflow is MISSING (no check run ever existed for it on the
    // merge commit — e.g. a PR-context-only gate like main-green gate that
    // only runs on pull_request), waiting cannot change the verdict: the
    // commit will never grow those runs. Halting the whole line on a
    // provably-unchangeable classification starves the queue for nothing.
    // Instead: land on the workflows that exist, drop the phantom names with
    // a loud audit, and file ONE config-defect ask per episode to the alarm
    // sink (the halt-class escalation — a human fixes required_workflows).
    // Genuinely unsettled OBSERVED runs (a check that exists and hasn't
    // concluded) keep the fail-closed stop, deduped per episode.
    if (v.bound_exceeded) {
      const observedUnsettled = v.pending.filter((n) => checks.some((c) => (c.name ?? "") === n));
      // positive evidence first: at least one required workflow PROVED green
      // on this very commit — the carve-out never fires on an empty/zero
      // evidence poll (an executor that reports nothing gets the stop, the
      // honest fail-closed posture the bound exists for)
      const greenRequired = checks.filter((c) => laneSpec.required_workflows.includes(c.name ?? "") && c.conclusion === "success");
      if (!v.failing.length && v.missing.length && !observedUnsettled.length && greenRequired.length) {
        const phantoms = v.missing.filter((n) => n !== "settle-dwell");
        this.audit(actor, "train:required_phantom_dropped", lane.id, {
          lane: laneKey(repo, base), pr, merge_sha: mergeSha.slice(0, 9),
          missing_required: phantoms,
          settled_green: greenRequired.map((c) => c.name),
          note: "BR#5061: required workflow(s) never ran on the merge commit (PR-context-only?) — landing on the workflows that exist; lane config needs a human",
        });
        try {
          await this.askCreate(
            {
              to: "human",
              question: `Lane config defect ${repo}@${base}: required workflow(s) never run on merge commits — remove ${phantoms.join(", ")} from required_workflows?`,
              reason: "the merge train cannot prove these required workflows on a landed merge commit — every merge past the CI bound lands on the workflows that exist instead of halting (Ray ruling 2026-10-30), but the lane config should be fixed",
              details: [
                `Lane ${laneKey(repo, base)} requires: ${laneSpec.required_workflows.join(", ")}.`,
                `On merge commit ${mergeSha.slice(0, 9)} (PR #${pr}) these required workflows produced NO check run — they look PR-context-only (e.g. a pull_request-triggered gate) and can never appear on a merge commit: ${phantoms.join(", ")}.`,
                `Effect: merges past the ~${TRAIN_CI_BOUND_MULTIPLIER}× typical CI bound LAND judged on the workflows that exist (observed green: ${greenRequired.map((c) => c.name).join(", ")}) instead of stopping the line.`,
                `Fix: remove the PR-context-only names from the lane's required_workflows (admin settings key train_lane, or the lane card's config op) — the admission gate already judges base-main health separately.`,
              ].join("\n\n"),
              options: ["Fix the lane config (remove PR-context-only workflows)", "Ack — landing on existing workflows is fine", "Investigate — these should run on merge commits"],
              artefact_id: this.settingValue("train_alarm_sink_id", TRAIN_ALARM_SINK_ID),
              urgency: "time-sensitive",
            },
            "system:train",
          );
        } catch (e) {
          this.audit(actor, "phantom_ask_suppressed", lane.id, { note: String((e as Error).message ?? e).slice(0, 160) });
        }
        const out = await this.landedFlowGuarded(lane, meta, actor, { pr, mergeSha, greenRunUrl: checks.find((c) => laneSpec.required_workflows.includes(c.name ?? "") && c.conclusion === "success")?.html_url ?? body.run_url ?? null });
        return { ...out, decided: "landed_phantom_required", dropped_required: phantoms };
      }
      const out = await this.trainEvent({ repo, base, kind: "stopped", pr, merge_sha: mergeSha, reason: `CI unknown past the fail-closed bound (~${TRAIN_CI_BOUND_MULTIPLIER}× typical)` }, actor);
      return { ...out, decided: "stopped_bound" };
    }
    const reason = this.laneSyncReason(lane.id, { ...meta, currently: { ...meta.currently } }, now);
    this.audit(actor, "train:ci_pending", lane.id, { lane: laneKey(repo, base), pending: v.pending, missing: v.missing });
    return { ok: true, decided: "pending", lane: laneKey(repo, base), pending: v.pending, missing: v.missing, reason };
  }

  /** train.bisect (BR#4934): the red-settle walk while the line is stopped
   *  on a burst-red settle. The executor probes the pass's intermediate
   *  merge shas OLDEST→NEWEST (one step per tick) and feeds verdicts; the
   *  hub stamps them on stop.bisect — the walk state lives hub-side,
   *  crash-safe, so any executor can pick the walk up mid-flight. A RED
   *  step names the ONE culprit: the hub stamps it, bounces the culprit
   *  card (fix-forward brief, verdict invalidated, BR#4068 boost), and
   *  RE-PARKS the wrongly stop-bounced final card (in_progress→blocked,
   *  awaiting-ci stamp restored) so it closes on the NEXT green settle via
   *  ancestor evidence. inconclusive stamps the walk failed — the executor
   *  then bounces the pass oldest-first, one per tick. Requires the lease. */
  private async trainBisect(body: any, actor: string): Promise<any> {
    const repo = String(body.repo ?? "").trim();
    const base = String(body.base ?? "main").trim();
    const lane = await this.laneEnsure(repo, base, actor);
    const meta = JSON.parse(lane.meta ?? "{}");
    const lease: TrainLease | null = meta.lease ?? null;
    if (!lease || lease.holder !== actor) throw new Error(`train.bisect requires the lane lease — held by ${lease?.holder ?? "nobody"}`);
    const stop: any = meta.stop;
    if (!stop) throw new Error("train.bisect requires a stopped lane — no stop stamped");
    if (!stop.bisect) throw new Error("train.bisect requires a burst-red stop — a legacy stop bisects nothing (BR#4934)");
    const now = Date.now();
    const step = body.step;
    if (step != null) {
      const sha = String(step.sha ?? "").toLowerCase();
      const verdict = String(step.verdict ?? "");
      if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("train.bisect step needs a sha-shaped sha");
      if (!["green", "red", "dispatched", "inconclusive"].includes(verdict))
        throw new Error("train.bisect step.verdict must be green | red | dispatched | inconclusive");
      const prev = stop.bisect.steps[sha];
      stop.bisect.steps[sha] = typeof prev === "object" && prev ? { ...prev, verdict, at: now } : { verdict, at: now };
    }
    if (body.inconclusive === true) stop.bisect.inconclusive = true;
    let bounced: string | null = null;
    let reparked: string | null = null;
    const culpritTask = body.culprit_task != null ? String(body.culprit_task).trim() : "";
    if (culpritTask) {
      const culpritSha = String(body.culprit_sha ?? "").toLowerCase() || null;
      stop.bisect.culprit_task = culpritTask;
      stop.bisect.culprit_sha = culpritSha;
      stop.bisect.named_at = now;
      const finalTask: string | null = meta.currently?.task_id ?? null;
      if (culpritTask !== finalTask) {
        // ---- bounce the true culprit (the stop flow bounced the FINAL
        // card; the walk's oldest-RED intermediate is the real one) ----
        const card = this.one(`SELECT id, status, meta, body_md FROM artefacts WHERE id = ?`, culpritTask);
        if (card) {
          const cm = JSON.parse(card.meta ?? "{}");
          const pr = Number(cm.merge_train?.pr ?? cm.pr?.number ?? 0);
          const defect = `bisect (BR#4934): merge sha ${culpritSha ?? "?"} is the pass's OLDEST RED probe — this merge broke main; fix forward or revert, then re-enter review`;
          const lines = [
            `Merge-train bisect verdict: your PR #${pr} landed as ${String(culpritSha ?? "").slice(0, 9)} and is the pass's oldest RED merge — the burst settle stopped the line on it.`,
            `The burst pass settled red on a later head; the per-sha probes named THIS merge as the culprit (BR#4934 red-settle bisect).`,
            ``,
            `Fix forward or revert, then re-enter review. The lane stays stopped until main is green again (BR#3516 §6).`,
          ];
          try {
            const nextMeta = {
              ...cm,
              boosted: now,
              merge_train: { ...(cm.merge_train ?? {}), state: "bounced", bounce_kind: "gate", bisect_culprit: true, culprit_sha: culpritSha ?? undefined, defect: defect.slice(0, 300), bounced_at: now, pr, repo },
            };
            const bodyMd = `${String(card.body_md ?? "").replace(/\n\n---\n\nMerge-train bisect[\s\S]*$/, "")}\n\n---\n\n${lines.join("\n")}`;
            this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, body_md = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(nextMeta), bodyMd, now, culpritTask);
            if (card.status === "blocked") {
              await this.transition({ id: culpritTask, to: "in_progress", session: "", note: `merge-train bisect — your merge ${String(culpritSha ?? "").slice(0, 9)} broke main (oldest RED probe); fix forward or revert` }, actor);
            }
            this.audit(actor, "boost", culpritTask, { root: culpritTask, via: "train:bisect", pr });
          } catch (e) {
            this.audit(actor, "train:bisect_bounce_refused", lane.id, { task: culpritTask, error: String((e as Error)?.message ?? e).slice(0, 200) });
          }
          bounced = culpritTask;
        }
        // ---- re-park the wrongly stop-bounced final card: blocked again,
        // awaiting-ci stamp restored — the next green settle closes it via
        // ancestor evidence (its merge sha is already on base) ----
        if (finalTask) {
          const fin = this.one(`SELECT id, status, meta FROM artefacts WHERE id = ?`, finalTask);
          if (fin && fin.status === "in_progress") {
            try {
              const fm = JSON.parse(fin.meta ?? "{}");
              fm.merge_train = { ...(fm.merge_train ?? {}), state: "awaiting-ci", reparked_at: now, reparked_by: "bisect" };
              this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(fm), now, finalTask);
              await this.transition(
                {
                  id: finalTask,
                  to: "blocked",
                  session: "",
                  note: `merge-train: re-parked — the bisect named another culprit (${String(culpritSha ?? "?").slice(0, 9)} RED); this card closes on the next green settle via ancestor evidence (BR#4934)`,
                  merge_train: true,
                  unblock_condition: "the merge train advances this card — it closes on the next green settle via ancestor evidence (BR#4934)",
                },
                actor,
              );
              reparked = finalTask;
            } catch (e) {
              this.audit(actor, "train:bisect_repark_refused", lane.id, { task: finalTask, error: String((e as Error)?.message ?? e).slice(0, 200) });
            }
          }
        }
      }
    }
    this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(meta), now, lane.id);
    const stepsShown = Object.entries(stop.bisect.steps ?? {}).map(([s, v]: [string, any]) => `${s.slice(0, 9)}=${typeof v === "object" ? v.verdict : v}`).join(", ") || "none";
    this.audit(actor, "train:bisect", lane.id, {
      lane: laneKey(repo, base),
      step: step != null ? { sha: String(step.sha ?? "").toLowerCase(), verdict: String(step.verdict ?? "") } : null,
      culprit: culpritTask || null,
      inconclusive: stop.bisect.inconclusive === true,
      bounced,
      reparked,
    });
    this.version(lane.id, actor, "train:bisect", `bisect walk: steps [${stepsShown}]${culpritTask ? ` — culprit ${culpritTask}${stop.bisect.culprit_sha ? ` @ ${String(stop.bisect.culprit_sha).slice(0, 9)}` : ""}${bounced ? " (bounced, final re-parked)" : " (the stop-bounced final card — bounce already stands)"}` : ""}${stop.bisect.inconclusive ? " — INCONCLUSIVE (pass bounces oldest-first)" : ""}`, { stop: meta.stop });
    return { ok: true, kind: "bisect", lane: laneKey(repo, base), stop: meta.stop, bounced, reparked };
  }

  /** train.carry (BR#4934 settle-window rebase): the executor ran a
   *  machine-clean `gh pr update-branch` on a verdict-covered queued head
   *  during the settle window; the hub appends the carry record (BR#3516 §5
   *  shape) so the accepted verdict covers the moved head — a mechanical,
   *  content-preserving update carries the verdict, no re-verify. The
   *  executor never writes card meta: the carry law (contiguity at append
   *  time, checked here against the walked chain end) stays hub-side,
   *  executor-fed. NOTE (coordination, BR#4689 / PR #311): this is the
   *  minimal carry primitive the settle window needs; L1.4 remains the
   *  carry law's owner and supersedes this op's edges when it lands. */
  private async trainCarry(body: any, actor: string): Promise<any> {
    const repo = String(body.repo ?? "").trim();
    const base = String(body.base ?? "main").trim();
    const pr = Number(body.pr ?? 0);
    const fromHead = String(body.from_head ?? "").toLowerCase();
    const toHead = String(body.to_head ?? "").toLowerCase();
    const shaLike = (s: string) => /^[0-9a-f]{7,40}$/.test(s);
    if (!pr) throw new Error("train.carry needs pr");
    if (!shaLike(fromHead) || !shaLike(toHead)) throw new Error("train.carry needs sha-shaped from_head/to_head");
    if (fromHead === toHead) throw new Error("train.carry: from_head == to_head — nothing moved, no carry");
    const lane = await this.laneEnsure(repo, base, actor);
    const meta = JSON.parse(lane.meta ?? "{}");
    const lease: TrainLease | null = meta.lease ?? null;
    if (!lease || lease.holder !== actor) throw new Error(`train.carry requires the lane lease — held by ${lease?.holder ?? "nobody"}`);
    const cards = this.state.storage.sql.exec(
      `SELECT id, meta FROM artefacts WHERE type = 'task' AND status = 'blocked'
       AND CAST(json_extract(meta, '$.merge_train.pr') AS INTEGER) > 0`,
    ).toArray() as any[];
    for (const row of cards) {
      const cm = JSON.parse(row.meta ?? "{}");
      const leg = trainLegs(cm).find((l) => l.number === pr && (l.repo === repo || !l.repo));
      if (!leg) continue;
      // contiguity at append time (BR#3516 §5): the carry may only extend
      // the walked chain end — a gap would silently unverify the head.
      const chainEnd = (l: { head_sha_at_acceptance?: string | null; carry?: unknown }): string => {
        let cur = String(l.head_sha_at_acceptance ?? "").toLowerCase();
        for (const c of Array.isArray(l.carry) ? (l.carry as any[]) : []) {
          const f = String(c?.from_head ?? "").toLowerCase();
          const t = String(c?.to_head ?? "").toLowerCase();
          if (!t || cur !== f) return cur; // a broken chain stops the walk
          cur = t;
        }
        return cur;
      };
      const end = chainEnd(leg);
      if (fromHead !== end)
        throw new Error(`train.carry: from_head ${fromHead.slice(0, 9)} is not the verdict chain's end (${end.slice(0, 9)}) — carries append contiguously (BR#3516 §5)`);
      const chain = this.trainChain(row.id);
      const now = Date.now();
      const next = carryAppendLeg(cm, pr, { from_head: fromHead, to_head: toHead, prior_verdict_id: chain.verdict_id, carried_ts: now, via: "update-branch" as const });
      this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(next), now, row.id);
      this.version(row.id, actor, "train_carry", `verdict carried across the settle-window machine update ${fromHead.slice(0, 9)}→${toHead.slice(0, 9)} (prior verdict ${chain.verdict_id ?? "unrecorded"} cited)`, {});
      this.audit(actor, "train:carry", lane.id, { lane: laneKey(repo, base), pr, task: row.id, from_head: fromHead, to_head: toHead });
      return { ok: true, kind: "carry", lane: laneKey(repo, base), task: row.id, pr, from_head: fromHead, to_head: toHead };
    }
    throw new Error(`train.carry: no queued card on ${repo}@${base} rides PR #${pr} — carries feed only the lane's queued heads`);
  }

  /** The ACCEPT hook (verify-side convention, BR#3516 §1): a verify duty
   *  closing done on an impl card stamps the card's PR provenance and queues
   *  it onto the train. Parses the PRs + heads from BOARD data (the close
   *  note) — zero hub GitHub calls. Idempotent: an already-queued card just
   *  re-stamps the (new) heads.
   *  BR#3659: a close may cite MULTIPLE PRs — every cited PR becomes a LEG
   *  (meta.prs; meta.pr stays the first leg), each bound to its own head;
   *  one unbound leg fail-closes the queue. Bounce guards (defect 2): a
   *  verify close on an in_progress (bounced) card or a card blocked on a
   *  non-train reason never re-queues it. */
  private async trainQueueOnAccept(parentId: string, src: { note?: string }, actor: string): Promise<void> {
    const parent = this.one(`SELECT id, type, status, meta, body_md FROM artefacts WHERE id = ?`, parentId);
    if (!parent || parent.type !== "task" || parent.status === "done" || parent.status === "superseded") return;
    const meta = JSON.parse(parent.meta ?? "{}");
    const blockedReason = () => [String(meta.blocked?.reason ?? ""), String(meta.blocked_reason ?? "")].find((r) => r) ?? "";
    const note = String(src.note ?? "");
    // the legs: the note's PR/Head pairs (one head after each PR — the multi-
    // PR convention), folded onto the existing stamp; without a note PR, the
    // existing stamp re-queues as-is; with neither, the card body is the last
    // resort (single-PR legacy path, unchanged)
    const stampLegs = trainLegs(meta);
    const noteLegs = trainParseNoteLegs(note);
    let legs: { repo: string; number: number; head_sha_at_acceptance?: string; base?: string }[];
    if (noteLegs.length && Array.isArray(meta.prs)) {
      legs = stampLegs.map((l) => ({ ...l }));
      for (const nl of noteLegs) {
        const i = legs.findIndex((l) => l.number === nl.number && l.repo === nl.repo);
        if (i >= 0) legs[i] = { ...legs[i], ...nl };
        else legs.push({ ...nl });
      }
    } else if (noteLegs.length) {
      legs = noteLegs;
    } else if (stampLegs.length) {
      // no parseable PR reference in the note — the existing stamp re-queues
      // as-is, EXCEPT (BR#4648): a note that still carries a `head <sha>`
      // token speaks for the card's ONE open leg. A single-unlanded-leg
      // stamp has nothing to cross-pair, so the lone head refreshes it — a
      // verifier citing bare receipts (no URL, no `repo#N`) must not strand
      // the stamp on an old head and spin the coverage bounce. Multi-leg
      // stamps stay fail-closed (no guessing which leg a lone head names).
      legs = stampLegs.map((l) => ({ ...l }));
      const loneHead = TRAIN_HEAD_STAMP_RE.exec(note)?.[1];
      const open = legs.filter((l) => !trainLegLanded(meta, l));
      if (loneHead && open.length === 1 && open[0].head_sha_at_acceptance !== loneHead) {
        open[0].head_sha_at_acceptance = loneHead;
        this.audit(actor, "queue_stamp_refreshed", parentId, { leg: `${open[0].repo}#${open[0].number}`, head: loneHead.slice(0, 9), via: "lone head token — the close note cited no PR reference (BR#4648)" });
      }
    } else {
      legs = trainParseNoteLegs(String(parent.body_md ?? ""));
      const loneHead = TRAIN_HEAD_STAMP_RE.exec(note)?.[1];
      if (legs.length && loneHead) legs = legs.map((l, i) => (i === 0 ? { ...l, head_sha_at_acceptance: loneHead } : l));
    }
    if (!legs.length) {
      // not a PR card (or the verifier forgot the link) — nothing to queue
      this.audit("system:merge-train", "queue_skipped", parentId, { reason: "no PR reference in the close note, stamp, or card body" });
      return;
    }
    // every leg must bind to a head — a single unbound leg is a leg the
    // train's gate could never pass, so the card does NOT queue (fail-closed)
    const withStampHeads = legs.map((l) => ({
      ...l,
      head_sha_at_acceptance: l.head_sha_at_acceptance ?? (l.number === Number(meta.pr?.number) ? String(meta.pr?.head_sha_at_acceptance ?? "") || undefined : undefined),
    }));
    const unbound = withStampHeads.filter((l) => !l.head_sha_at_acceptance);
    if (unbound.length) {
      meta.merge_train = { ...(meta.merge_train ?? {}), state: "unbound", pr: withStampHeads[0].number, at: Date.now(), unbound: unbound.map((l) => l.number) };
      this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), parentId);
      this.audit("system:merge-train", "queue_unbound", parentId, { reason: `close cited PR(s) ${unbound.map((l) => `#${l.number}`).join(", ")} without a paired \`head <sha>\` — every cited PR needs its head before the train can gate it (BR#3659)` });
      return;
    }
    // BR#4648 honesty: did this accept actually move a stamp? The re-queue
    // note must never claim "stamp refreshed" on a no-op re-accept, and a
    // re-accept whose note carried a `head <sha>` token yet moved nothing
    // the stamp doesn't already cover is audited loud — that gap is exactly
    // the silent-stale coverage-bounce spin class.
    const stampBefore = new Map(stampLegs.map((l) => [`${l.repo}#${l.number}`, l.head_sha_at_acceptance]));
    const refreshed = withStampHeads.some((l) => stampBefore.get(`${l.repo}#${l.number}`) !== l.head_sha_at_acceptance);
    // stamp: meta.prs = every leg; meta.pr = the first leg (compat: the gate,
    // the derived-queue filter, and older readers read meta.pr)
    // BR#4806 wake bookkeeping — read the per-lane queue depth BEFORE the
    // stamp: a fresh entry's card is not yet in the derived queue (before=0
    // on an idle lane); an already-queued card's re-stamp (alreadyQueued)
    // never transitions a queue. The empty→non-empty lanes get one
    // `lane.queued` broadcast after the stamp lands.
    const touchedRepos = [...new Set(withStampHeads.map((l) => l.repo))];
    // BR#4977: the before/after wake compare is base-scoped like the queue
    // itself — a second base's lane never counts another base's entries.
    const queueBefore = new Map(touchedRepos.map((r) => [r, this.laneQueue(r, String(withStampHeads.find((l) => l.repo === r)?.base ?? meta.pr?.base ?? "main")).length]));
    meta.prs = withStampHeads;
    meta.pr = { ...(meta.pr ?? {}), repo: withStampHeads[0].repo, number: withStampHeads[0].number, head_sha_at_acceptance: withStampHeads[0].head_sha_at_acceptance, ...(withStampHeads[0].base ? { base: withStampHeads[0].base } : {}) };
    meta.merge_train = { ...(meta.merge_train ?? {}), state: "queued", at: Date.now(), pr: withStampHeads[0].number, repo: withStampHeads[0].repo, legs_total: withStampHeads.length };
    // BR#4068 decay: the bounce boost survives the repair but not the
    // re-entry — the card is back in line, so it re-joins the normal ranks
    // (FIFO by queued-at). It was never auto-expired mid-repair.
    if (meta.boosted) {
      delete meta.boosted;
      this.audit(actor, "unboost", parentId, { root: parentId, via: "train:queued" });
      this.version(parentId, actor, "update", "boost decayed — re-queued on the merge train (BR#4068)", {});
    }
    const alreadyQueued = parent.status === "blocked" && blockedReason().startsWith(MERGE_TRAIN_REASON_PREFIX);
    this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), parentId);
    if (!alreadyQueued) {
      await this.transition(
        {
          id: parentId,
          to: "blocked",
          // anonymous: the queue transition is the hub acting as the machine —
          // it must not stamp the closing verifier's session as the card's
          // implementer (first-wins meta.session would otherwise bind a
          // session-less card to the verifier, and a same-session re-verify
          // would then be refused by review-separation-of-duties)
          session: "",
          note: MERGE_TRAIN_QUEUED_REASON,
          merge_train: true,
          unblock_condition: "the merge train advances this card — no agent action needed until it bounces (then fix per the brief)",
        },
        actor,
      );
    }
    // the lane card exists before anything can lease it — one per repo the
    // legs ride (a multi-PR parent may span repos; each lane takes its own).
    // BR#4977: a RETIRED lane (card done/superseded) refuses to ensure — that
    // refusal must not break the verifier's close (the stamps + blocked
    // transition already landed), so it becomes a loud audit trail instead:
    // the card rides NO live lane (the base filter scopes it out of every
    // other lane's queue) until the PR is re-targeted or the lane re-opened.
    const laneCards = new Map<string, string>();
    for (const repo of [...new Set(withStampHeads.map((l) => l.repo))]) {
      try {
        const laneCard = await this.laneEnsure(repo, String(meta.pr.base ?? "main"), actor);
        laneCards.set(repo, String(laneCard?.id ?? ""));
      } catch (e) {
        if (!String((e as Error).message ?? e).includes("lane retired")) throw e;
        this.audit(actor, "queue_skipped", parentId, { reason: String((e as Error).message ?? e).slice(0, 200), lane: `${repo}@${String(meta.pr.base ?? "main")}` });
        this.version(parentId, actor, "train_queue_skipped", `NOT queued — ${String((e as Error).message ?? e).slice(0, 180)}`, {});
      }
    }
    // BR#4806 event-driven tick — wake the gateways: on a lane's derived
    // queue transitioning empty → non-empty, broadcast `lane.queued {repo,
    // base, depth}` on the push channel (same transport as `lane.starved` —
    // the audit call fans out to WS + SSE AND writes the ledger receipt).
    // Ready gateways run ONE tick on arrival under the exact same CAS lease;
    // the poll cadence stays as the fallback, and a push+poll double-fire
    // is serialized by the lease (the second acquirer stands down).
    for (const repo of touchedRepos) {
      const base = String(withStampHeads.find((l) => l.repo === repo)?.base ?? meta.pr?.base ?? "main");
      const after = this.laneQueue(repo, base);
      if ((queueBefore.get(repo) ?? 0) === 0 && after.length > 0) {
        this.audit("system:train", "lane.queued", laneCards.get(repo) ?? parentId, {
          lane: `${repo}@${base}`,
          repo,
          base,
          depth: after.length,
          head: after[0]?.id ?? null,
          trigger: parentId,
          reason: "queue transitioned empty → non-empty — merge-capable gateways may tick now (BR#4806)",
        });
      }
    }
    this.audit(actor, "train_queued", parentId, { prs: withStampHeads.map((l) => l.number), repos: [...new Set(withStampHeads.map((l) => l.repo))], head: (withStampHeads[0].head_sha_at_acceptance ?? "").slice(0, 9), requeued: alreadyQueued, refreshed });
    const noteHead = TRAIN_HEAD_STAMP_RE.exec(note)?.[1];
    if (alreadyQueued && !refreshed && noteHead && !stampLegs.some((l) => l.head_sha_at_acceptance === noteHead)) {
      this.audit("system:merge-train", "queue_stamp_not_refreshed", parentId, { head: noteHead.slice(0, 9), reason: "the accept note carried a `head <sha>` token but no stamped leg moved — its PR citation did not parse onto a leg (BR#4648 class); the stamp rides at its old head" });
    }
    this.version(parentId, actor, "train_queued", `queued on the merge train — ${withStampHeads.map((l) => `${l.repo}#${l.number}@${String(l.head_sha_at_acceptance).slice(0, 9)}`).join(", ")}${alreadyQueued ? ` (re-queued${refreshed ? ", stamp refreshed" : ""})` : ""}`, { prs: withStampHeads.map((l) => l.number) });
  }

  /** The lane's derived queue — COMPUTED (mergeTrainQueue over blocked,
   *  merge-train-stamped cards), never stored (BR#3516 §7). Shared by the
   *  status snapshot and the renew-arm zombie check (BR#4129). BR#4977: the
   *  queue is scoped to the lane's BASE — a card matches only when one of
   *  its unlanded legs targets this repo AND this base (a leg without a
   *  base stamp defaults to "main"), so a lane never inherits another
   *  base's queue on the same repo. */
  private laneQueue(repo: string, base: string) {
    const cards = this.state.storage.sql.exec(
      `SELECT id, status_ts, meta, tags FROM artefacts WHERE type = 'task' AND status = 'blocked'
       AND CAST(json_extract(meta, '$.merge_train.pr') AS INTEGER) > 0`,
    ).toArray() as any[];
    // BR#5190: a STOPPED lane offers ONLY tier 0 — the lane card's stop facts
    // are the hub-visible proxy for base red (the hub holds no VCS
    // credentials), and every other head stays parked on the base-red law
    // (BR#4365 precedent) until the bound fix merges or the line goes green.
    const laneRow = this.one(`SELECT meta FROM artefacts WHERE id = ?`, laneKey(repo, base)) as any;
    const baseRed = !!JSON.parse(String(laneRow?.meta ?? "{}") || "{}")?.stop?.sha;
    return mergeTrainQueue(
      cards.map((c) => ({ id: c.id, status_ts: c.status_ts, meta: JSON.parse(c.meta ?? "{}"), tags: parseTags(c.tags) })),
      { baseRed },
    ).filter((c) => {
      const cm = cards.find((x) => x.id === c.id);
      // a card rides exactly the lanes that own one of its UNLANDED legs
      // (BR#3659 — and this replaces the old filter that read
      // meta.merge_train.repo, a field nothing ever set, so every queued
      // card matched every lane); BR#4977 adds the base half — repo alone
      // let a second base's lane (e.g. a retired drill base) inherit the
      // whole repo queue
      return cm && trainCardMatchesLane(JSON.parse(cm.meta ?? "{}"), repo, base);
    }).map((c) => {
      // BR#5114: the entry names its PR — the panel's NEXT/QUEUE columns
      // read "card · #pr", not a bare card id (Ray: "wtf does that mean?")
      const cm = JSON.parse(cards.find((x) => x.id === c.id)!.meta ?? "{}");
      const leg = trainLegsRemaining(cm, repo, base)[0];
      const pr = Number(leg?.number ?? 0) || 0;
      return { ...c, ...(pr ? { pr } : {}) };
    });
  }

  /** train.status — the lane + derived-queue snapshot (GET /train mirrors
   *  this). The queue is COMPUTED here (mergeTrainQueue), never stored. Each
   *  lane also carries an activity block (Top-view train panel): merge
   *  throughput over trailing 1h/24h, last merge age, and the lane's last
   *  ledger event — all cheap indexed counts over train_events. */
  /** BR#4489 starvation: a non-empty queue with no merge-capable lease
   *  inside the window cannot advance — the 2026-10-29 outage class
   *  (bounces flowed, merges stood down, the lane LOOKED served). Entering
   *  starvation stamps the episode (meta.lane.starved_since), broadcasts
   *  `lane.starved` on the WS push channel (the audit call), and fires the
   *  red alarm (one ask per episode, bound to the alarm sink). Recovery
   *  (first capable lease, or the queue draining) clears the stamp. The
   *  episode stamp is written BEFORE the await, so concurrent callers
   *  (train.status readers + the alarm sweep) cannot double-alarm. */
  private async laneStarvationTick(l: any, meta: any, lane: { repo: string; base: string }, queue: any[], now0: number): Promise<{ since: number; mins: number } | null> {
    // BR#5061: the starve clock NEVER inits from epoch — a lane that has
    // never recorded a capable lease (a fresh reseed) starts its clock at
    // the card's own last status change, not 1970. The epoch-init produced
    // the bogus "starved 29888714m" alarm class (BR#5063).
    const capRaw = Number(meta.lane?.last_capable_lease_ts ?? 0);
    const capEpoch = capRaw > 0 ? capRaw : Math.max(0, Number(l.status_ts ?? 0));
    if (!capEpoch) return null; // no clock to judge — nothing recorded yet
    const capableAge = now0 - capEpoch;
    const starved = queue.length > 0 && capableAge > TRAIN_STARVE_MS
      ? { since: now0 - capableAge + TRAIN_STARVE_MS, mins: Math.round((capableAge - TRAIN_STARVE_MS) / 60_000) }
      : null;
    if (starved && !meta.lane?.starved_since) {
      meta.lane = { ...(meta.lane ?? {}), starved_since: starved.since };
      this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(meta), now0, l.id);
      this.audit("system:train", "lane.starved", l.id, {
        lane: `${lane.repo}@${lane.base}`, queue_len: queue.length,
        starved_mins: starved.mins, starved_since: starved.since,
        reason: "queue non-empty with no merge-capable executor lease inside the starve window — merges cannot advance (BR#4489)",
      });
      try {
        await this.askCreate(
          {
            to: "human",
            question: `Merge train starved ${Math.max(1, starved.mins)}m: ${lane.repo}@${lane.base} — restart a merge-capable gateway?`,
            reason: "the merge train cannot advance — queued heads wait on a worker-class executor; gateways present are standing down (BR#3181) or dead (the 2026-10-29 outage class, BR#4489)",
            details: [
              `Lane ${lane.repo}@${lane.base} starved since ${new Date(starved.since).toISOString()} (${starved.mins}m starved).`,
              `Queue depth: ${queue.length} — head ${queue[0]?.id ?? "?"}.`,
              `Fix: run a merge-capable gateway (gh authed as a worker identity — bridge doctor checks), or merge the head by hand.`,
              `Recovers automatically: the starved state clears on the first capable lease.`,
            ].join("\n\n"),
            options: ["Ack — restarting a merge-capable gateway", "Merge the head by hand", "Waive — not urgent"],
            artefact_id: this.settingValue("train_alarm_sink_id", TRAIN_ALARM_SINK_ID),
            urgency: "time-sensitive",
          },
          "system:train",
        );
      } catch (e) {
        this.audit("system:train", "starved_ask_suppressed", l.id, { note: String((e as Error).message ?? e).slice(0, 160) });
      }
    } else if (!starved && meta.lane?.starved_since) {
      meta.lane = { ...(meta.lane ?? {}), starved_since: null };
      this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(meta), now0, l.id);
    }
    return starved;
  }

  /** BR#4489: starvation is judged PROACTIVELY on the alarm tick — a dead
   *  train alarms even with zero panel readers (silence about a dead train
   *  was the outage's second failure). Same episode logic as train.status:
   *  once-per-episode via the starved_since stamp. */
  private async sweepLaneStarvation(now0: number): Promise<void> {
    // BR#4977/BR#5061: retired lane cards never tick, never starve — skipped
    // in the loop below (status selected for the guard); a reseeded lane
    // alarms once, on its live card, not per duplicate card.
    const lanes = this.state.storage.sql.exec(
      `SELECT id, status, status_ts, meta FROM artefacts
       WHERE type = 'task' AND json_extract(meta, '$.lane.key') IS NOT NULL`,
    ).toArray() as any[];
    for (const l of lanes) {
      try {
        const meta = JSON.parse(l.meta ?? "{}");
        const lane = laneOfMeta(meta);
        if (!lane) continue;
        // BR#4977: a retired lane card is frozen — no starved stamps, no
        // asks; its queue (post base-filter) is not this lane's problem.
        if (l.status === "done" || l.status === "superseded") continue;
        const queue = this.laneQueue(lane.repo, lane.base);
        await this.laneStarvationTick(l, meta, lane, queue, now0);
      } catch (e) {
        this.audit("system:train", "starve_sweep_error", l.id, { error: String((e as Error).message ?? e).slice(0, 160) });
      }
    }
  }

  private async trainStatus(body: any): Promise<any> {
    const repoFilter = String(body?.repo ?? "").trim();
    const now0 = Date.now();
    const ttlMs = clampAwaitingTtlHours(this.settingValue("train.awaiting_ttl_h", ""), this.settingValue("train.review_ask_ttl_h", "24")) * 3_600_000;
    const lanes = this.state.storage.sql.exec(
      `SELECT id, title, status, meta, status_ts, updated_ts FROM artefacts
       WHERE type = 'task' AND json_extract(meta, '$.lane.key') IS NOT NULL
       ORDER BY title`,
    ).toArray() as any[];
    // BR#5061: ONE row per lane key. A retired card whose lane has a LIVE
    // successor (the reseed shape — the 2026-10-29 outage showed two rows
    // for bridge@main) is superseded history: skipped. A retired card with
    // NO successor stays visibly retired (BR#4977 — the panel names why).
    const liveKeys = new Set(
      (this.state.storage.sql.exec(
        `SELECT DISTINCT json_extract(meta, '$.lane.key') AS k FROM artefacts
         WHERE type = 'task' AND json_extract(meta, '$.lane.key') IS NOT NULL
           AND status NOT IN ('done','superseded')`,
      ).toArray() ?? []).map((r: any) => String(r.k ?? "")),
    );
    const out: any[] = [];
    for (const l of lanes) {
      const meta = JSON.parse(l.meta ?? "{}");
      const lane = laneOfMeta(meta);
      if (!lane) continue;
      if (repoFilter && lane.repo !== repoFilter) continue;
      // BR#4977: a done/superseded lane card is RETIRED — shown as retired
      // (the panel names why), with an empty queue, and never meta-touched:
      // no starvation stamps, no reason rewrites on a "never tick again"
      // card (the BR#4772 phantom-ready class).
      if (l.status === "done" || l.status === "superseded") {
        if (liveKeys.has(laneKey(lane.repo, lane.base))) continue; // reseeded — history
        out.push({
          lane: `${lane.repo}@${lane.base}`,
          card: l.id,
          retired: true,
          lease: null,
          currently: null,
          stop: null,
          required_workflows: lane.required_workflows,
          reason: "lane retired — the lane card is closed (base deleted or lane retired); the tick does not touch it (BR#4772/BR#4977)",
          last_capable_lease_ts: meta.lane?.last_capable_lease_ts ?? null,
          capable: null,
          starved: null,
          queue: [],
          activity: { merged_1h: 0, merged_24h: 0, last_merge_ts: null, last_event: null },
        });
        continue;
      }
      const queue = this.laneQueue(lane.repo, lane.base);
      const tp = this.state.storage.sql.exec(
        `SELECT SUM(CASE WHEN ts > ? THEN 1 ELSE 0 END) AS h1,
                SUM(CASE WHEN ts > ? THEN 1 ELSE 0 END) AS h24,
                MAX(ts) AS last_merge_ts
         FROM train_events WHERE kind = 'merged' AND repo = ? AND base = ?`,
        now0 - 3_600_000, now0 - 86_400_000, lane.repo, lane.base,
      ).toArray()[0] ?? {};
      const lastEvent = this.state.storage.sql.exec(
        `SELECT ts, kind, pr, task_id, gateway FROM train_events
         WHERE repo = ? AND base = ? ORDER BY seq DESC LIMIT 1`,
        lane.repo, lane.base,
      ).toArray()[0] ?? null;
      const starved = await this.laneStarvationTick(l, meta, lane, queue, now0);
      const capableAt = Number(meta.lane?.last_capable_lease_ts ?? 0);
      const capable = capableAt
        ? { holder: String(meta.lane?.last_capable_holder ?? ""), at: capableAt, age_ms: now0 - capableAt, ready: now0 - capableAt < TRAIN_READY_MS }
        : null;
      // BR#5114 round 2: plain-language facts for the panel — the current
      // attempt (card + hold class + a human sentence) and how much of the
      // queue is waiting on a fresh review (the whole-queue-stalled story
      // the raw "0/h" rate never told). BR#4962 (per BR#4960): coverage
      // bounces now PARK `awaiting` instead of stamping `bounced` — same
      // plain-words story, so both classes read as awaiting a fresh review.
      const head = queue[0]?.id ? String(queue[0].id) : null;
      const headHold = head
        ? (() => {
            const hm = this.one(`SELECT meta FROM artefacts WHERE id = ?`, head) as any;
            const st = hm ? String(JSON.parse(hm.meta ?? "{}")?.merge_train?.state ?? "") : "";
            return st === "bounced" || st === "awaiting"
              ? { class: "awaiting-review" as const, note: `waiting on ${head} — its PR branch changed after the last review, so a fresh review is needed before it can merge` }
              : { class: "merge-checks" as const, note: `working on ${head} — checking review, signatures and CI before merging` };
          })()
        : null;
      // cards bounced off this lane and not yet re-accepted — gate/conflict
      // bounces (`bounced`) and BR#4962 coverage parks (`awaiting`) alike —
      // they sit OUTSIDE the derived queue (in_progress/blocked, awaiting a
      // fresh review), which is exactly why a stalled lane reads "0/h" with
      // a full queue: the train bounces each head, the head leaves for a
      // review, the next head bounces… count them so the panel can tell
      // that story.
      const awaitingReview = (this.state.storage.sql.exec(
        `SELECT id, meta FROM artefacts WHERE type = 'task' AND json_extract(meta, '$.merge_train.state') IN ('bounced','awaiting')`,
      ).toArray() as any[]).filter((c) => {
        const m = JSON.parse(c.meta ?? "{}");
        return trainCardMatchesLane(m, lane.repo, lane.base);
      }).length;
      // Awaiting parks (BR#4962, per accepted BR#4960): cards parked blocked
      // under the typed Awaiting stamp on this lane's UNLANDED legs — the
      // human force-review queue. The ask-era review_asks chips are GONE:
      // zero asks ride the lanes (BR#4960), so the panel renders the parked
      // CARDS instead — oldest park first, capped so a pathological lane
      // cannot flood the panel. Aging reads the TTL knob; a lapsed park
      // still lists (visibility without interruption — BR#4960).
      const awaitingRows = (this.state.storage.sql.exec(
        `SELECT id, status_ts, meta FROM artefacts
         WHERE type = 'task' AND status = 'blocked'
           AND json_extract(meta, '$.merge_train.state') = 'awaiting'`,
      ).toArray() as any[])
        .filter((r) => trainCardMatchesLane(JSON.parse(r.meta ?? "{}"), lane.repo))
        .map((r) => {
          const tm = JSON.parse(r.meta ?? "{}");
          const aw = tm.merge_train?.awaiting ?? {};
          const at = Number(aw.at ?? r.status_ts ?? 0);
          const ageMs = at ? Math.max(0, now0 - at) : 0;
          return {
            task: String(r.id),
            pr: Number(tm.merge_train?.pr) || undefined,
            at,
            head_sha: aw.head_sha ?? null,
            verdict: aw.verdict_id ?? null,
            age_ms: ageMs,
            aging: ageMs >= ttlMs,
            lapsed: ageMs >= ttlMs + TRAIN_AWAITING_GRACE_MS,
          };
        })
        .sort((x, y) => y.age_ms - x.age_ms)
        .slice(0, 20);
      out.push({
        lane: `${lane.repo}@${lane.base}`,
        card: l.id,
        lease: meta.lease ?? null,
        currently: meta.currently ?? null,
        stop: meta.stop ?? null,
        bypass_wait: meta.bypass_wait ?? null,
        required_workflows: lane.required_workflows,
        burst_max: lane.burst_max,
        reason: String(meta.blocked?.reason ?? ""),
        // BR#5114: the holder's live last action (BR#4104 seam) — WHAT the
        // executor is doing right now, verbatim from its own tick log; the
        // panel renders it as the NOW line and ages it out at the lease TTL
        now_action: meta.lane?.now_action ?? null,
        attempt: headHold ? { card: head, hold: headHold.class, note: headHold.note } : null,
        queue_awaiting_review: awaitingReview,
        last_capable_lease_ts: meta.lane?.last_capable_lease_ts ?? null,
        capable,
        starved,
        queue,
        awaiting: awaitingRows,
        activity: {
          merged_1h: Number(tp.h1 ?? 0),
          merged_24h: Number(tp.h24 ?? 0),
          last_merge_ts: tp.last_merge_ts ?? null,
          last_event: lastEvent ? { ts: lastEvent.ts, kind: lastEvent.kind, pr: lastEvent.pr, task_id: lastEvent.task_id, gateway: lastEvent.gateway } : null,
        },
      });
    }
    return { lanes: out };
  }

  /** train.history — the train_events ledger (provenance serving). */
  private trainHistory(body: any): any {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (body?.repo) { clauses.push("repo = ?"); args.push(String(body.repo)); }
    if (body?.base) { clauses.push("base = ?"); args.push(String(body.base)); }
    if (body?.kind) { clauses.push("kind = ?"); args.push(String(body.kind)); }
    if (body?.pr) { clauses.push("pr = ?"); args.push(Number(body.pr)); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.state.storage.sql.exec(
      `SELECT seq, ts, kind, repo, base, gateway, pr, task_id, merge_sha, head_sha, detail FROM train_events ${where} ORDER BY seq DESC LIMIT ?`,
      ...args, Math.min(Number(body?.limit ?? 50), 200),
    ).toArray() as any[];
    return { events: rows.map((r) => ({ ...r, detail: JSON.parse(r.detail ?? "{}") })) };
  }

  // ---------- reconcile (BR#4170): the board↔GitHub invariant ----------
  //
  // The gateway daemon (train.rs) runs the read-only `gh pr list` and feeds
  // observations via reconcile.report; this DO owns the join (reconcile.ts),
  // the decisions, and every board mutation. The invariant: every open
  // reviewed PR is bound / ignored-with-reason / in-flight within one cycle
  // — anything else past the actionable age is an ALARM to the sink, never a
  // silence (the #2466 class: 34h invisible).

  /** The reconcile settings block — one reader for schedule/status/report.
   *  Values are clamped where nonsense would break the invariant (a 0s
   *  interval would hammer `gh`; a 0h age would alarm on fresh PRs). */
  private reconcileSettings(): { enabled: boolean; interval_secs: number; repos: string[]; verify_age_h: number; disposition_age_h: number } {
    const num = (key: string, dflt: number, lo: number, hi: number): number => {
      const raw = Number(this.settingValue(key, String(dflt)));
      return Number.isFinite(raw) ? Math.min(hi, Math.max(lo, raw)) : dflt;
    };
    return {
      enabled: this.settingValue("reconcile.enabled", "1").trim() !== "0",
      interval_secs: num("reconcile.interval_secs", 1800, 300, 21600),
      repos: this.settingValue("reconcile.repos", "state-vector/bridge,state-vector/superpositional")
        .split(",").map((s) => s.trim()).filter(Boolean),
      verify_age_h: num("reconcile.verify_age_h", 2, 0, 720),
      disposition_age_h: num("reconcile.disposition_age_h", 24, 0, 2160),
    };
  }

  /** reconcile.schedule — view (no spec) or set (spec) the daemon-visible
   *  schedule + thresholds. The daemon also has env knobs; these settings
   *  are the hub-side record the status view reports. */
  private async reconcileSchedule(body: any, actor: string): Promise<any> {
    const spec = body?.spec;
    if (spec && typeof spec === "object") {
      const sets: [string, string][] = [];
      if (spec.enabled !== undefined) sets.push(["reconcile.enabled", spec.enabled ? "1" : "0"]);
      if (spec.interval_secs !== undefined) sets.push(["reconcile.interval_secs", String(Math.min(21600, Math.max(300, Number(spec.interval_secs) || 1800)))]);
      if (spec.repos !== undefined) sets.push(["reconcile.repos", String(spec.repos)]);
      if (spec.verify_age_h !== undefined) sets.push(["reconcile.verify_age_h", String(Math.min(720, Math.max(0, Number(spec.verify_age_h) || 0)))]);
      if (spec.disposition_age_h !== undefined) sets.push(["reconcile.disposition_age_h", String(Math.min(2160, Math.max(0, Number(spec.disposition_age_h) || 0)))]);
      for (const [k, v] of sets) {
        this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, k, v);
      }
      if (sets.length) this.audit(actor, "reconcile_schedule", null, { keys: sets.map(([k]) => k) });
    }
    return this.reconcileSettings();
  }

  /** reconcile.status — the operator view: settings, latest accounting,
   *  the duty ledger, ignores, and the reverse-reconcile missing clock. */
  private async reconcileStatus(body: any): Promise<any> {
    const repo = String(body?.repo ?? "").trim();
    const repoArgs = repo ? [repo] : [];
    const where = repo ? "WHERE repo = ?" : "";
    const reports = this.state.storage.sql.exec(
      `SELECT seq, ts, actor, repo, accounting, line, ok FROM reconcile_reports ${where} ORDER BY seq DESC LIMIT ?`,
      ...repoArgs, Math.min(Number(body?.limit ?? 10), 100),
    ).toArray() as any[];
    const duties = this.state.storage.sql.exec(
      `SELECT repo, pr, kind, duty_id, card_status, created_ts FROM reconcile_duties ${where} ORDER BY created_ts DESC LIMIT 200`,
      ...repoArgs,
    ).toArray() as any[];
    const ignores = this.state.storage.sql.exec(
      `SELECT repo, pr, reason, by, created_ts FROM reconcile_ignores ${where} ORDER BY created_ts DESC LIMIT 200`,
      ...repoArgs,
    ).toArray() as any[];
    const missing = this.state.storage.sql.exec(
      `SELECT repo, pr, card, missing_ts FROM reconcile_seen ${repo ? "WHERE repo = ? AND missing = 1" : "WHERE missing = 1"} ORDER BY missing_ts DESC LIMIT 200`,
      ...repoArgs,
    ).toArray() as any[];
    return {
      settings: this.reconcileSettings(),
      last_report: reports[0] ? { ...reports[0], accounting: JSON.parse(reports[0].accounting), ok: !!reports[0].ok } : null,
      reports: reports.map((r) => ({ ...r, accounting: JSON.parse(r.accounting), ok: !!r.ok })),
      duties,
      ignores,
      missing,
    };
  }

  /** reconcile.ignore — record an ignore-with-reason for one PR. The
   *  invariant's second disposition: a PR the board will never carry, ruled
   *  so ON THE RECORD instead of by silence. An ignore IS a reason. */
  private async reconcileIgnore(body: any, actor: string): Promise<any> {
    const repo = String(body?.repo ?? "").trim();
    const pr = Number(body?.pr);
    const reason = String(body?.reason ?? "").trim();
    if (!repo || !Number.isInteger(pr) || pr <= 0 || !reason) {
      throw new Error("reconcile.ignore needs repo, pr (>0), and a non-empty reason — an ignore without a reason is just silence");
    }
    const now = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO reconcile_ignores (repo, pr, reason, by, created_ts) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(repo, pr) DO UPDATE SET reason = excluded.reason, by = excluded.by, created_ts = excluded.created_ts`,
      repo, pr, reason.slice(0, 500), actor, now,
    );
    this.audit(actor, "reconcile_ignore", null, { repo, pr, reason: reason.slice(0, 200) });
    return { ok: true, repo, pr, reason: reason.slice(0, 500) };
  }

  /** Create (or reuse) the tracking card that projects one PR onto the board
   *  — meta.pr is the binding the join reads. Reuses an existing OPEN card
   *  for the same (repo, pr) so a re-report can never double-project. */
  private async reconcileTrackingCard(repo: string, pr: number, title: string | null, why: string, actor: string, now: number): Promise<string> {
    const existing = this.one(
      `SELECT id FROM artefacts WHERE type = 'task' AND status IN ('todo','in_progress','in_review','blocked')
       AND json_extract(meta, '$.pr.repo') = ? AND CAST(json_extract(meta, '$.pr.number') AS INTEGER) = ? LIMIT 1`,
      repo, pr,
    ) as any;
    if (existing) return String(existing.id);
    const created = await this.create(
      {
        type: "task",
        title: `${repo}#${pr} — reconcile${title ? `: ${title}` : ""}`.slice(0, 200),
        session: "", // machine-created: anonymous, no session may own a projection
        body_md: reconcileTrackingBody(repo, pr, title, why, `https://github.com/${repo}/pull/${pr}`),
        meta: { pr: { repo, number: pr } },
        roles: ["impl"], // a projection card is impl-shaped (roles are structural lanes)
      },
      actor,
    );
    this.audit(actor, "create", created.id, { type: "task", auto: "reconcile-tracking", pr: `${repo}#${pr}`, why });
    return created.id;
  }

  /** Spawn the STANDARD verify duty (the shared 5c template) as a child of
   *  `parentId`, ledgered FIRST — the reconcile_duties row is the dedupe, so
   *  a second report (or a racing cycle) can never double-spawn one PR's
   *  verify. Returns the duty card id, or null when the ledger already has
   *  this PR's verify (one per PR ever — a dead one alarms, not respawns). */
  private async reconcileSpawnVerify(repo: string, pr: number, parentId: string, actor: string, now: number): Promise<string | null> {
    const held = this.one(`SELECT duty_id FROM reconcile_duties WHERE repo = ? AND pr = ? AND kind = 'verify'`, repo, pr) as any;
    if (held) return null;
    this.state.storage.sql.exec(
      `INSERT INTO reconcile_duties (repo, pr, kind, duty_id, card_status, created_ts) VALUES (?, ?, 'verify', '', NULL, ?)`,
      repo, pr, now,
    );
    const parent = this.one(`SELECT id, title, meta, tags FROM artefacts WHERE id = ?`, parentId) as any;
    if (!parent) return null;
    const pm = JSON.parse(parent.meta ?? "{}");
    const rootTitle = String(parent.title ?? `PR #${pr}`).replace(/^(?:Verify:\s*)+/, "");
    const stamp = (pm.pr ?? {}) as { repo?: unknown; number?: unknown };
    // BR#5190: the fast-lane note rides only for a QUALIFIED root-fix parent
    // (tags + binding) with a PR stamp — no stamp, no fast lane to name.
    const parentIsRootFix =
      isRootFixCard({ tags: parseTags(parent.tags), meta: pm }) &&
      typeof stamp.repo === "string" && stamp.repo && Number(stamp.number) > 0;
    const prLink: string =
      typeof stamp.repo === "string" && stamp.repo && Number(stamp.number) > 0
        ? `https://github.com/${stamp.repo}/pull/${Number(stamp.number)}`
        : `https://github.com/${repo}/pull/${pr}`;
    const created = await this.create(
      {
        type: "task",
        title: `Verify: ${rootTitle.slice(0, 200)}`,
        session: "", // machine spawn: a FRESH session must verify (separation of duties)
        body_md: verifyDutyBody(parentId, rootTitle, prLink, { repo, n: pr }, parentIsRootFix ? { repo, pr } : undefined),
        roles: ["review"],
      },
      actor,
    );
    this.state.storage.sql.exec(
      `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
      created.id, parentId, now,
    );
    this.state.storage.sql.exec(
      `UPDATE reconcile_duties SET duty_id = ?, card_status = 'todo' WHERE repo = ? AND pr = ? AND kind = 'verify'`,
      created.id, repo, pr,
    );
    this.audit(actor, "create", created.id, { type: "task", auto: "reconcile-verify", parent: parentId, pr: `${repo}#${pr}` });
    return created.id;
  }

  /** Ledger a non-verify duty (disposition / reverse) — INSERT OR IGNORE so
   *  the one-per-PR-ever rule holds across reports. */
  private reconcileLedgerDuty(repo: string, pr: number, kind: "disposition" | "reverse", dutyId: string, now: number): void {
    this.state.storage.sql.exec(
      `INSERT OR IGNORE INTO reconcile_duties (repo, pr, kind, duty_id, card_status, created_ts) VALUES (?, ?, ?, ?, 'todo', ?)`,
      repo, pr, kind, dutyId, now,
    );
  }

  /** reconcile.report — one daemon observation cycle for one repo. Runs the
   *  pure join (reconcile.ts), APPLIES every judgement (spawns, clock
   *  updates, provenance closes, alarm), records the accounting line, and
   *  returns the run result. Idempotent per (repo, pr, kind). */
  private async reconcileReport(body: any, actor: string): Promise<any> {
    const repo = String(body?.repo ?? "").trim();
    if (!repo) throw new Error("reconcile.report needs repo");
    const rawPrs = Array.isArray(body?.prs) ? body.prs : [];
    const prs: ReconcilePr[] = rawPrs.map(normalizePr).filter((p): p is ReconcilePr => p !== null);
    const now = Date.now();
    const cfg = this.reconcileSettings();
    const titleByPr = new Map(prs.map((p) => [p.number, p.title]));

    // ---- board projection: open cards bound to this repo via a PR leg ----
    const openCards = this.state.storage.sql.exec(
      `SELECT id, status, meta FROM artefacts WHERE type = 'task' AND status IN ('todo','in_progress','in_review','blocked')`,
    ).toArray() as any[];
    const openPrs = new Set(prs.map((p) => p.number));
    const bindings: ReconcileBinding[] = [];
    for (const row of openCards) {
      const meta = JSON.parse(row.meta ?? "{}");
      const legs = [
        { number: Number((meta.pr ?? {}).number), repo: String((meta.pr ?? {}).repo ?? "") },
        ...(Array.isArray(meta.prs) ? meta.prs : []).map((l: any) => ({ number: Number(l?.number), repo: String(l?.repo ?? "") })),
      ];
      for (const leg of legs) {
        if (leg.repo !== repo || !Number.isInteger(leg.number) || leg.number <= 0) continue;
        const seen = this.one(`SELECT missing FROM reconcile_seen WHERE repo = ? AND pr = ?`, repo, leg.number) as any;
        const prov = this.one(`SELECT merge_sha, signer FROM provenance WHERE repo = ? AND pr = ?`, repo, leg.number) as any;
        bindings.push({
          card: String(row.id),
          status: String(row.status),
          pr: leg.number,
          open_verify_children: this.openVerifyChildren(String(row.id)),
          queued: String(row.status) === "blocked" && Number((meta.merge_train ?? {}).pr ?? 0) > 0,
          missing: !openPrs.has(leg.number),
          missing_set_before_report: !!seen && Number(seen.missing) === 1,
          provenance: prov ? { merge_sha: String(prov.merge_sha), signer: String(prov.signer) } : null,
        });
      }
    }

    // ---- duty ledger, with each duty card's LIVE status ----
    const duties: ReconcileDuty[] = (this.state.storage.sql.exec(
      `SELECT pr, kind, duty_id FROM reconcile_duties WHERE repo = ?`,
      repo,
    ).toArray() as any[]).map((d) => {
      const card = this.one(`SELECT status FROM artefacts WHERE id = ?`, String(d.duty_id)) as any;
      return { pr: Number(d.pr), kind: d.kind, duty_id: String(d.duty_id), card_status: card ? String(card.status) : null };
    });
    const ignores: ReconcileIgnore[] = (this.state.storage.sql.exec(
      `SELECT pr, reason FROM reconcile_ignores WHERE repo = ?`,
      repo,
    ).toArray() as any[]).map((i) => ({ pr: Number(i.pr), reason: String(i.reason) }));

    const { judgements, accounting } = reconcileJoin({
      repo,
      prs,
      bindings,
      ignores,
      duties,
      cfg: {
        now,
        verify_age_ms: cfg.verify_age_h * 3_600_000,
        disposition_age_ms: cfg.disposition_age_h * 3_600_000,
      },
    });

    // ---- apply ----
    const spawned: { pr: number; action: string; card: string; duty?: string | null }[] = [];
    for (const j of judgements as ReconcileJudgement[]) {
      const a = j.decision;
      switch (a.action) {
        case "seen": {
          this.state.storage.sql.exec(
            `INSERT INTO reconcile_seen (repo, pr, card, missing, missing_ts, updated_ts) VALUES (?, ?, ?, 0, NULL, ?)
             ON CONFLICT(repo, pr) DO UPDATE SET missing = 0, missing_ts = NULL, updated_ts = excluded.updated_ts, card = excluded.card`,
            repo, j.pr, a.card, now,
          );
          break;
        }
        case "mark_missing": {
          this.state.storage.sql.exec(
            `INSERT INTO reconcile_seen (repo, pr, card, missing, missing_ts, updated_ts) VALUES (?, ?, ?, 1, ?, ?)
             ON CONFLICT(repo, pr) DO UPDATE SET missing = 1, missing_ts = excluded.missing_ts, updated_ts = excluded.updated_ts, card = excluded.card`,
            repo, j.pr, a.card, now, now,
          );
          break;
        }
        case "spawn_verify": {
          // card given → the standard duty on the EXISTING bound card (never
          // a second card); card null → orphan: project it first, then duty.
          const parent = a.card ?? await this.reconcileTrackingCard(repo, j.pr, titleByPr.get(j.pr) ?? null, "approved+mergeable and unbound — the board projection was missing (the #2466 class)", actor, now);
          const duty = await this.reconcileSpawnVerify(repo, j.pr, parent, actor, now);
          spawned.push({ pr: j.pr, action: "verify", card: parent, duty });
          break;
        }
        case "spawn_tracking": {
          const card = await this.reconcileTrackingCard(repo, j.pr, titleByPr.get(j.pr) ?? null, "approved but destination-blocked — bound so it is visible; the verify duty comes when the base greens", actor, now);
          spawned.push({ pr: j.pr, action: "tracking", card });
          break;
        }
        case "spawn_disposition": {
          const card = await this.reconcileTrackingCard(repo, j.pr, titleByPr.get(j.pr) ?? null, "changes requested / conflicting past the disposition age — fix the PR, or rule it off the board (reconcile.ignore)", actor, now);
          this.reconcileLedgerDuty(repo, j.pr, "disposition", card, now);
          spawned.push({ pr: j.pr, action: "disposition", card });
          break;
        }
        case "spawn_reverse": {
          // The PR left open state with NO provenance row: spawn a ruling
          // duty as a child of the zombie binding card. Never meta.pr on the
          // ruling card itself — it is a duty ABOUT a binding, not a
          // projection (a second binding would double-count the PR).
          const b = bindings.find((x) => x.pr === j.pr);
          const boundCard = b?.card ?? "no-open-binding-card";
          const created = await this.create(
            {
              type: "task",
              title: `Reverse-reconcile: ${repo}#${j.pr} left the open list unrecorded`.slice(0, 200),
              session: "", // machine spawn: a FRESH session must rule
              body_md: `Reverse-reconcile duty (BR#4170) — ${repo}#${j.pr} vanished from \`gh pr list\` with NO provenance row, but board card ${boundCard} still binds it.\n\nRule what happened, on the record:\n1. gh pr view ${j.pr} --repo ${repo} --json state,mergedAt,mergeCommit — was it MERGED (outside the train), CLOSED unmerged, or is the disappearance a gh/API flake?\n2. MERGED outside the train: close ${boundCard} done citing the merge commit sha + URL (the human merge is the receipt; provenance stays unstamped — that is the train-signer's job).\n3. CLOSED unmerged: close ${boundCard} done citing the close receipt. FLAKE (still open): record findings via log_progress on ${boundCard} and close yourself done — next report re-binds normally.\n4. Never close ${boundCard} without a receipt, never delete it — a silent close here is exactly the failure this duty exists to prevent (BR#3287).`,
              roles: ["review"],
            },
            actor,
          );
          this.state.storage.sql.exec(
            `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
            created.id, boundCard, now,
          );
          this.reconcileLedgerDuty(repo, j.pr, "reverse", created.id, now);
          this.audit(actor, "create", created.id, { type: "task", auto: "reconcile-reverse", parent: boundCard, pr: `${repo}#${j.pr}` });
          spawned.push({ pr: j.pr, action: "reverse", card: created.id });
          break;
        }
        case "reverse_close": {
          // Two consecutive misses + a provenance row: the train stamped the
          // merge — close the zombie binding via the machine proxy (the same
          // unblock-then-close the landed flow uses; BR#3287 provenance).
          try {
            const card = this.one(`SELECT id, status FROM artefacts WHERE id = ?`, a.card) as any;
            if (card && card.status !== "done" && card.status !== "superseded") {
              // unpark via the machine-managed transition (trip-wires
              // suppressed for merge_train moves) from ANY open status — a
              // zombie binding can sit todo, in_progress, or blocked
              if (card.status !== "in_progress") {
                await this.transition({ id: a.card, to: "in_progress", session: "", note: "reconcile: provenance close — unpark the card for the machine proxy", merge_train: true }, actor);
              }
              await this.transition(
                { id: a.card, to: "done", session: "", note: `reconcile: ${repo}#${j.pr} left the open list and the provenance row stamps the merge (${a.merge_sha.slice(0, 9)} by ${a.signer}) — closing the zombie binding on the machine proxy (BR#3287/BR#4170)` },
                actor,
              );
            }
          } catch (e) {
            // the machine gate refused (open verify children, closure legs) —
            // record, alarm-below-covers it, and never force a close
            this.audit(actor, "reconcile_reverse_close_failed", a.card, { pr: `${repo}#${j.pr}`, error: String((e as Error).message ?? e).slice(0, 300) });
          }
          break;
        }
        default:
          break; // bound / inflight / ignored / grace / alarm_unaccounted: no mutation here
      }
    }

    // ---- record the run ----
    const line = accountingLine(accounting);
    this.state.storage.sql.exec(
      `INSERT INTO reconcile_reports (ts, actor, repo, accounting, line, ok) VALUES (?, ?, ?, ?, ?, ?)`,
      now, actor, repo, JSON.stringify(accounting), line, accounting.ok ? 1 : 0,
    );

    // ---- alarm when the invariant failed: ONE ask per class (the PR-set
    // title makes identical re-reports dedupe; a changed set re-alarms) ----
    const unaccounted = (judgements as ReconcileJudgement[]).filter((j) => j.decision.action === "alarm_unaccounted");
    if (!accounting.ok && unaccounted.length) {
      try {
        await this.askCreate(
          {
            to: "human",
            question: `reconcile ALARM ${repo}: ${unaccounted.map((j) => `#${j.pr}`).join(", ")} unaccounted — bind, ignore-with-reason, or revive?`,
            reason: "every open reviewed PR must be bound / ignored / in-flight within one cycle (BR#4170) — these are none of the three past the actionable age",
            details: [
              `Accounting: ${line}`,
              ...unaccounted.map((j) => {
                const d = j.decision as { action: "alarm_unaccounted"; why: string };
                return `PR #${j.pr}: ${d.why} — ${j.reason}`;
              }),
              `Fix: bind each PR to its card (or ignore it with reconcile.ignore), or revive the dead duty — then the next report goes green.`,
            ].join("\n\n"),
            options: ["On it — binding now", "Ignore these PRs (with reasons)", "Investigate the dead duties"],
            artefact_id: this.settingValue("reconcile_alarm_sink_id", TRAIN_ALARM_SINK_ID),
            urgency: "time-sensitive",
          },
          actor,
        );
      } catch (e) {
        // an identical ask is already open for this episode — that IS one per class
        this.audit(actor, "reconcile:alarm_deduped", null, { repo, error: String((e as Error).message ?? e).slice(0, 160) });
      }
    }
    this.audit(actor, "reconcile_report", null, { repo, line, ok: accounting.ok, spawned: spawned.length });

    return {
      ok: accounting.ok,
      line,
      accounting,
      spawned,
      unaccounted: unaccounted.map((j) => ({ pr: j.pr, why: (j.decision as { why: string }).why })),
    };
  }

  /** Open review-role children of one card — the "a verify is already in
   *  flight via the normal flow" signal for the join. */
  private openVerifyChildren(cardId: string): number {
    return Number(
      this.one(
        `SELECT COUNT(*) AS n FROM relations r JOIN artefacts c ON c.id = r.src_id
         WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked') AND c.roles LIKE '%"review"%'`,
        cardId,
      )?.n ?? 0,
    );
  }

  // ---------- helpers ----------

  /** THE append-only ledger — every mutation (kind 'mutation') and every
   *  signal (kind 'signal') is one row in one sequence. events/artefact_versions
   *  are views over this. */
  private ledgerWrite(kind: 'signal' | 'mutation', actor: string, action: string, artefactId: string | null, summary: string, data: object): { seq: number; ts: number } {
    const ts = Date.now();
    const r = this.state.storage.sql.exec(
      `INSERT INTO ledger (ts, actor, kind, action, artefact_id, summary, data) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
      ts, actor, kind, action, artefactId, summary.slice(0, 500), JSON.stringify(data),
    ).toArray()[0] as any;
    return { seq: Number(r?.seq ?? 0), ts };
  }

  /** Append-only per-artefact history: every mutation gets one mutation row. */
  private version(artefactId: string, actor: string, action: string, summary: string, data: object = {}) {
    const { seq, ts } = this.ledgerWrite('mutation', actor, action, artefactId, summary, data);
    // remember it so the paired audit() broadcast reuses this row instead of
    // writing a second signal row for the same fact
    this._lastMutation = { key: `${artefactId}:${action}`, seq, ts, actor, action, artefactId, data };
  }

  private audit(actor: string, op: string, artefactId: string | null, detail: object) {
    const key = `${artefactId}:${op}`;
    let seq: number; let ts: number;
    const last = this._lastMutation;
    if (last && last.key === key && Date.now() - last.ts < 5_000) {
      // same fact already recorded as a mutation — broadcast THAT row, no second write
      ({ seq, ts } = last);
      this.broadcastEvent({ seq, ts, actor: last.actor, op: last.action, artefact_id: last.artefactId, detail: last.data });
      this._lastMutation = null;
      this.scoreCache = null;
      return;
    }
    ({ seq, ts } = this.ledgerWrite('signal', actor, op, artefactId, "", detail));
    this.broadcastEvent({ seq, ts, actor, op, artefact_id: artefactId, detail });
    // every mutation can move behaviour signals — drop the 30s score cache so
    // board reads after writes are fresh (the cache exists for DO row-read quota)
    this.scoreCache = null;
  }

  private _lastMutation: { key: string; seq: number; ts: number; actor: string; action: string; artefactId: string | null; data: object } | null = null;

  private async nextSeq(_type: ArtefactType): Promise<number> {
    const rows = this.state.storage.sql.exec(`SELECT id FROM artefacts`).toArray();
    let max = 0;
    for (const r of rows as any[]) {
      const m = /^BR#(\d+)$/.exec(String(r.id));
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return max + 1;
  }

  // :any on purpose — rows come back as Record<string, SqlStorageValue> and every
  // caller immediately narrows to the columns it selected; the per-site casts the
  // strict ratchet will want are deferred until that pass (BR#2505 guard landed
  // non-strict on purpose).
  private one(query: string, ...params: any[]): any {
    return this.state.storage.sql.exec(query, ...params).toArray()[0] ?? null;
  }

  /** BR#4262 render-time join, single-row form (shape()'s payloads: get, list,
   *  search, related, update echoes). Resolves a principal owner to its
   *  token's label; anything else renders verbatim. Display only — every
   *  matching path keeps the stored value. */
  private displayOwner(owner: unknown): string {
    const o = String(owner ?? "");
    if (!o) return o;
    const hit = this.one(
      `SELECT label FROM auth_tokens WHERE principal = ?
       ORDER BY (revoked_ts IS NULL) DESC, COALESCE(last_seen_ts, created_ts) DESC LIMIT 1`,
      o,
    ) as any;
    return String(hit?.label ?? o);
  }

  private shape(row: any): any {
    return { ...row, owner: this.displayOwner(row.owner), meta: JSON.parse(row.meta ?? "{}"), tags: parseTags(row.tags), roles: parseTags(row.roles) };
  }

  private json(obj: unknown, status = 200) {
    return new Response(JSON.stringify(obj), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  // ---------- BR#4212 channel-health counters ----------
  // In-memory per-route + storage-fault counters, surfaced in /stats.channel.
  // A storage fault is counted WHERE it happens (ensure_schema | alarm_rearm |
  // dispatch) and ALWAYS yields typed JSON — the "uncaught throw → CF HTML
  // 500" class is structurally dead.
  private routeStats: Record<string, { ok: number; err: number; last_err_ts: number }> = {};
  private routeStatsStarted = Date.now();
  private storageFaults: Record<string, { n: number; last_ts: number; last_error: string }> = {};
  private wsSendFail = 0;

  private noteRoute(route: string, ok: boolean) {
    const rec = (this.routeStats[route] ??= { ok: 0, err: 0, last_err_ts: 0 });
    if (ok) rec.ok++;
    else { rec.err++; rec.last_err_ts = Date.now(); }
  }

  private noteStorageFault(stage: string, e: unknown) {
    const rec = (this.storageFaults[stage] ??= { n: 0, last_ts: 0, last_error: "" });
    rec.n++; rec.last_ts = Date.now();
    rec.last_error = String((e as Error)?.message ?? e).slice(0, 200);
    console.log(`kb storage fault (${stage}):`, rec.last_error);
  }

  private storageFaultResponse(stage: string, e: unknown): Response {
    this.noteStorageFault(stage, e);
    return this.json(
      { error: `kb storage fault at ${stage} — the operation did not land; retry`, result_class: "infra_storage_fault", stage },
      503,
    );
  }
}

// re-export for the worker entry's type-free JS import
export { idSeq };

/** Final tags to write: the executor's tags_add merged into the row's tags. */
function tagsForWrite(verdict: Extract<Awaited<ReturnType<typeof decide>>, { ok: true }>, base: string[]): string[] {
  if (!verdict.tags_add.length) return base;
  const t = [...base];
  for (const x of verdict.tags_add) if (!t.includes(x)) t.push(x);
  return t;
}
